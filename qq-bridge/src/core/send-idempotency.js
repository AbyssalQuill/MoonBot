// 出站回复幂等账本（2026-09-16 真机事故「reset 之后同一条回复发了两遍」）
//
// ── 现场（logs/bridge-local.log，UTC）────────────────────────────────────────────
//   14:11:54 [send-chain] 已取消 group:*** 的待发任务（会话重置/隔离）      ← 会话重置
//   14:12:12 新会话 group:*** -> session-0e99aedd-…
//   14:12:34 模型调 qq_send_message：messages=["喵什么喵","又不是猫娘"] @了一个不存在的 uid
//   14:12:35 QQ 发送失败: OneBot send_group_msg 失败: Get Uid Error
//   14:12:36 工具统一发送部分成功 1/2 条，已记录已发消息                    ← 「又不是猫娘」已经真的发出去了
//   14:12:47 模型把**整批**重发一遍（这次不带 @）
//   14:12:49 工具统一发送 group:***: 成功 2/2 条                           ← 「又不是猫娘」第二次进群
//   14:13:10 主人在群里报障：“好像在reset之后会重复回复一次”
//   state/social-state.json 的 recentMessages 也留着两条 self:true 的「又不是猫娘」
//   （messageId 1275818397 @14:12:36 与 1430508901 @14:12:50），是双发最硬的证据。
//
// ── 根因 ────────────────────────────────────────────────────────────────────
//   console-server.js 的发送端点只有「整批第一条文本 + 上一次**成功**后才记账」这一条重复判定：
//     · 成功路径才写 `lastSendDedup`（sendMessages 返回之后），
//     · 走到 catch（部分失败）时只 `recordSentMessages(error.sent)` 记下已发的那几条，
//       既没写 lastSendDedup，也没有任何「这一条已经出去了」的逐条记录。
//   于是模型看到 ok:false 后重发整批时：
//     · 90s 同文本闸门（lastSendDedup）里没有这批的账 → 不拦；
//     · 也没有逐条账可以告诉它「哪几条已经发过了」 → 连已经送达的那条一起再发一次。
//   本模块补的就是这两件事，并刻意**做成模块级状态**：reset 会把
//   `social.conversations[key]` 整个删掉（answeredMessageIds / lastDeliveredSeq /
//   _wakeIntendedSeq / lastUnreadSeq 一起没了），账本挂在会话状态里就等于每次 reset 都失忆。
//
// ── 判据为什么是「逐条文本 + 未了结的重发窗口」而不是「一律少发」──────────────
//   只有**上一批存在失败**时才进入 pendingPartial；一旦整批成功，账本立刻清空。
//   所以正常的新回复（前一批是成功的）永远不经过过滤，不存在「一律少发」误杀。
//   反过来，部分失败后的重发是模型唯一会重发旧文本的场景，也正是双发的唯一来源。
//
// 用法（console-server.js 两处发送端点）：
//   const idem = filterAlreadySentBubbles(key, messages);   // 发送前
//   … 只发 idem.kept；idem.skipped 打一行日志说明挡了哪条、为什么
//   noteBatchOutcome(key, { attempted, delivered, failed }); // 发送后（成功/部分失败都要调）
import { log } from '../lib/log.js';

/** 部分失败后模型"重发整批"的认账窗口。实测重发间隔 13s（14:12:34 → 14:12:47），
 *  给到 3 分钟足够覆盖模型先回一句别的话再补发的长尾巴；超过窗口就当作全新的回复，不再过滤。 */
const REPLAY_WINDOW_MS = 180000;
/** 单会话最多记多少条已投递气泡（诊断/日志用，不参与判定）。 */
const DELIVERED_KEEP = 50;

const pendingPartial = new Map(); // key -> { at, delivered: Set<normText>, failedCount }
const deliveredLog = new Map();   // key -> [{ text, at }] 最近确实投递成功的正文

/** 文本归一化：只比"内容"，忽略首尾空白与空白数量差异（模型重发时常常多带一个空格）。 */
export function normBubble(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 会话重置时**必须跨重置活下来**的「已回复账本」字段（见 social-state.resetConversationKeepingLedger）。
 *  ⚠️ 这四项是一组，必须同生同死：只保水位不保 seq 计数器 → 重置后新消息的 seq 从 1 重新数，
 *  会被 lastDeliveredSeq（例如 63）判成"早就交付过" → 机器人直接装死不回（这是比双发更严重的误杀）。 */
export const REPLY_LEDGER_FIELDS = ['answeredMessageIds', 'lastDeliveredSeq', '_wakeIntendedSeq', 'lastUnreadSeq'];

/** 记一次发送结果。failed 非空 → 进入"重发窗口"，把已投递的那几条登记成不可重发。
 *  delivered 传 `sendMessages` 返回的条目（{text} 或字符串都认）。 */
export function noteBatchOutcome(key, { attempted = [], delivered = [], failed = [] } = {}, nowMs) {
  if (key == null || String(key) === '') return { pending: false };
  const k = String(key);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const norm = (list) => (Array.isArray(list) ? list : [])
    .map((x) => normBubble(x && typeof x === 'object' ? (x.text ?? x.message ?? '') : x))
    .filter(Boolean);
  const deliveredNorms = norm(delivered);
  if (deliveredNorms.length) {
    const list = deliveredLog.get(k) || [];
    for (const t of deliveredNorms) list.push({ text: t, at: now });
    deliveredLog.set(k, list.slice(-DELIVERED_KEEP));
  }
  const failedCount = Array.isArray(failed) ? failed.length : Number(failed) || 0;
  if (failedCount > 0) {
    /* 只登记"真的发出去了"的那几条：重发时它们要被挡下，没发出去的照发。
     * 【2026-09-22 修 M17·"账本被整批覆盖"】旧写法是**直接 set 一个全新的 Set**：第一批发了 A、失败 B
     * （账本 {A}）；模型重发时发出 B、又失败 C → 账本被覆盖成 {B}，**A 的记录丢了**；
     * 第三次它把 [A,B] 又发一遍时只挡得住 B → A 被**真的重复发出去**。
     * 现在改成在重发窗口内**并集合并**：窗口内的历史已发条目一律保留。 */
    const prev = pendingPartial.get(k);
    const merged = new Set((prev && (now - Number(prev.at || 0)) <= REPLAY_WINDOW_MS) ? prev.delivered : []);
    for (const t of deliveredNorms) merged.add(t);
    pendingPartial.set(k, { at: now, delivered: merged, failedCount });
    return { pending: true, delivered: deliveredNorms.length, failed: failedCount, attempted: norm(attempted).length };
  }
  pendingPartial.delete(k);
  return { pending: false, delivered: deliveredNorms.length, failed: 0, attempted: norm(attempted).length };
}

/** 发送前过滤：返回 { kept, skipped }（kept/skipped 里都是 { index, text }，index 是原始下标）。
 *  只有「上一批有失败且还在重发窗口内」时才可能挡东西；否则 kept === messages。 */
export function filterAlreadySentBubbles(key, messages, nowMs) {
  const list = Array.isArray(messages) ? messages : [];
  const out = { kept: list.map((m, i) => ({ index: i, text: m })), skipped: [] };
  if (key == null || String(key) === '') return out;
  const p = pendingPartial.get(String(key));
  if (!p) return out;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (now - p.at > REPLAY_WINDOW_MS) { pendingPartial.delete(String(key)); return out; }
  const kept = [];
  for (let i = 0; i < list.length; i++) {
    const t = normBubble(list[i]);
    if (t && p.delivered.has(t)) { out.skipped.push({ index: i, text: t }); continue; }
    kept.push({ index: i, text: list[i] });
  }
  out.kept = kept;
  return out;
}

/** 诊断/日志用：该会话当前的账本快照。 */
export function idempotencyLedger(key) {
  const k = String(key ?? '');
  const p = pendingPartial.get(k);
  return {
    pendingPartial: p ? { at: p.at, delivered: [...p.delivered], failedCount: p.failedCount } : null,
    delivered: (deliveredLog.get(k) || []).slice(-10).map((x) => x.text),
  };
}

/** 一次性把某会话的账本清掉（测试与人工排障用；正常运行不调）。 */
export function clearIdempotencyLedger(key) {
  if (key == null || String(key) === '') return false;
  const had = pendingPartial.delete(String(key)) || deliveredLog.delete(String(key));
  return !!had;
}

/** 只给测试用：清空全部模块级账本。 */
export function __resetIdempotencyForTest() {
  pendingPartial.clear();
  deliveredLog.clear();
}

/** 把上一份会话状态里的「已回复账本」抠出来（会话重置时用）。
 *  返回 { patch, carried } —— patch 直接 Object.assign 回新建的状态；
 *  carried 是实际保住了哪几项（0 项时不打日志、不建状态）。 */
export function carryReplyLedger(prev) {
  if (!prev || typeof prev !== 'object') return null;
  const patch = { _justAutoReset: true }; // 让新会话首轮说清"刚换了上下文，别重答旧话题"
  const carried = [];
  const ids = Array.isArray(prev.answeredMessageIds)
    ? prev.answeredMessageIds.map((x) => String(x ?? '')).filter(Boolean).slice(-300)
    : [];
  patch.answeredMessageIds = ids;
  if (ids.length) carried.push(`answeredMessageIds=${ids.length}`);
  for (const f of ['lastUnreadSeq', 'lastDeliveredSeq', '_wakeIntendedSeq']) {
    const n = Math.max(0, Number(prev[f]) || 0);
    patch[f] = n;
    if (n > 0) carried.push(`${f}=${n}`);
  }
  return { patch, carried };
}

/** 一行明确的日志：挡掉了哪条、为什么。 */
export function logIdempotencyBlock(key, idem, reason) {
  if (!idem || !idem.skipped || !idem.skipped.length) return;
  const detail = idem.skipped.map((s) => `#${s.index + 1}"${String(s.text).slice(0, 24)}"`).join('、');
  log(`[send-idempotency] ${key} 挡下 ${idem.skipped.length} 条已投递的重复气泡：${detail}（${reason}）——只补发没发出去的部分，避免同一条回复进群两遍`);
}
