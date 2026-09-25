// 「模型漏引号导致 messages 被丢掉」的兜底发送：把裸文本捞回来，交给同一条发送端点发出去。
//
// 为什么这么做（2026-09-20 需求："一开始根治，而不是等失败了再修正"）：
//   模型偶尔把工具参数写成 `{"key":"…","messages": 今天挺热的啊,"token":"…"}` ——
//   不是合法 JSON。参数解析在 DSH 里（宽松解析，非法成员整个丢掉），桥改不了；但桥在事件流
//   里拿得到原始参数串（core/mux.js 的 tool/call 帧）。于是：这次调用一旦失败在
//   "messages 至少一个不能为空"，桥就用 lib/args-repair.js 把那段裸文本捞回来，走
//   POST /api/social/send-message 自己发出去 —— 同一条端点意味着额度/幂等/脱敏/去重/引用解析
//   全部照旧生效，并且这一批会被端点记进幂等账本，模型随后的"重发"会被判成"已经发过了"。
//   结果：用户看到消息照常到达，而不是（现状）两次报错、第三次才成功。
//
// 只在"确实因为 messages 为空而失败"时触发；修不出来就什么都不做（绝不猜内容）。
import { log } from '../lib/log.js';
import { repairToolArgs } from '../lib/args-repair.js';
import { getSocialState } from './social-state.js';

/** 这些工具的 key/messages 语义与 qq_send_message 一致，可以直接复用同一个端点。 */
const RECOVERABLE = new Set([
  'qq_send_message', 'qq_send_group_message', 'qq_send_private_message', 'qq_reply',
]);

export function isRecoverableSendTool(toolName) {
  return RECOVERABLE.has(String(toolName ?? '').split('__').pop());
}

/**
 * 一次兜底发送。返回 { ok, sent?, error? }，只用于日志与测试，不向模型回执（它已经收到报错了）。
 */
export async function recoverUnquotedSend({ key, sid = '', callId = '', stash = {}, cfg = {}, post = null } = {}) {
  const tool = String(stash.tool ?? '');
  if (!isRecoverableSendTool(tool)) return { ok: false, error: `不支持兜底的工具：${tool}` };
  const args = repairToolArgs(stash.raw);
  if (!args) return { ok: false, error: '参数修不出来（不猜内容）' };
  const messages = Array.isArray(args.messages) ? args.messages.map((m) => String(m ?? '')).filter(Boolean)
    : (args.messages == null ? [] : [String(args.messages)]);
  if (!messages.length) return { ok: false, error: '修复后仍然没有 messages' };
  const targetKey = String(args.key ?? key ?? '');
  if (!/^(group|private):\d+$/.test(targetKey)) return { ok: false, error: `修复后的 key 不合法：${targetKey}` };
  const token = String(args.token ?? getSocialState(targetKey)?.agentToken ?? '');
  const body = {
    key: targetKey,
    messages,
    token,
    ...(args.replyToMessageId != null ? { replyToMessageId: args.replyToMessageId } : {}),
    ...(args.atUserId != null ? { atUserId: args.atUserId } : {}),
    ...(Array.isArray(args.images) ? { images: args.images } : {}),
  };
  const url = post?.url ?? `http://127.0.0.1:${Number(cfg?.consolePort) || 3100}/api/social/send-message`;
  const fetchImpl = post?.fetch ?? fetch;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-token': token },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (json?.ok) {
      log(`[args-repair] 模型漏引号 → 已由桥兜底发出 ${targetKey} 的 ${json.sent ?? messages.length} 条（callId=${callId}，工具=${tool}）：${messages.join(' / ').slice(0, 60)}`);
      return { ok: true, sent: json.sent ?? messages.length, key: targetKey };
    }
    log(`[args-repair] 兜底发送未成功 ${targetKey}（callId=${callId}）：${json?.error ?? res.status}`);
    return { ok: false, error: json?.error ?? `HTTP ${res.status}` };
  } catch (error) {
    log(`[args-repair] 兜底发送异常 ${targetKey}（callId=${callId}）：${error?.message ?? error}`);
    return { ok: false, error: String(error?.message ?? error) };
  }
}
