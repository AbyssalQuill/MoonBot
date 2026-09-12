// 群成员名片缓存 + QQ 引用/回复解析缓存
// bot（NapCat client）经 setMessageCacheBot 注入。
import { log } from '../lib/log.js';
import { segmentsToText } from '../lib/message-parse.js';
import { extractForwardIds, formatForwardResponse } from '../forward.js';
import { SENSITIVE_RE } from '../sensitive.js';
import { redactSensitiveText } from '../lib/text-safe.js';
import { fmtBeijing } from '../lib/time.js';
import { recentChatMessages } from './memory.js';

let botRef = null;
/** NapCat 网关就绪后注入 bot */
export function setMessageCacheBot(bot) {
  botRef = bot;
}

const groupMemberNameCache = new Map(); // `groupId:userId` -> { name, ts }
const GROUP_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败

export function pruneGroupMemberNameCache() {
  const now = Date.now();
  for (const [k, v] of groupMemberNameCache) {
    if (now - v.ts > GROUP_MEMBER_NAME_TTL_MS) groupMemberNameCache.delete(k);
  }
  if (groupMemberNameCache.size > 2000) {
    const keys = [...groupMemberNameCache.keys()].slice(0, groupMemberNameCache.size - 2000);
    for (const k of keys) groupMemberNameCache.delete(k);
  }
}

export async function resolveGroupMemberName(groupId, userId) {
  const key = `${String(groupId)}:${String(userId)}`;
  const hit = groupMemberNameCache.get(key);
  if (hit && Date.now() - hit.ts < GROUP_MEMBER_NAME_TTL_MS) return hit.name;
  try {
    // 优先精确查询单个成员（快，适合单条 @）
    let name = null;
    try {
      const info = await botRef.getGroupMemberInfo(Number(groupId), Number(userId));
      name = info?.card || info?.nickname || null;
    } catch {}
    if (name) {
      groupMemberNameCache.set(key, { name, ts: Date.now() });
      pruneGroupMemberNameCache();
      return name;
    }
    // 回退：拉一次整群成员列表并建立整组缓存（兼容未实现 get_group_member_info 的网关）
    const list = await botRef.getGroupMemberList(Number(groupId));
    const members = Array.isArray(list) ? list : (list?.data ?? []);
    const now = Date.now();
    for (const m of members) {
      const n = m?.card || m?.nickname || null;
      if (n) groupMemberNameCache.set(`${String(groupId)}:${String(m.user_id)}`, { name: n, ts: now });
    }
    pruneGroupMemberNameCache();
    name = groupMemberNameCache.get(key)?.name ?? null;
    return name;
  } catch {
    return null;
  }
}

export function pruneReplyInfoCache() {
  if (replyInfoCache.size <= 1000) return;
  const now = Date.now();
  for (const [k, v] of replyInfoCache) {
    if (now - v.ts > REPLY_INFO_TTL_MS) replyInfoCache.delete(k);
  }
  if (replyInfoCache.size > 1000) {
    const oldestKey = replyInfoCache.keys().next().value;
    if (oldestKey !== undefined) replyInfoCache.delete(oldestKey);
  }
}

export async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
  pruneReplyInfoCache();
  const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
  const hit = replyInfoCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < (hit.info ? REPLY_INFO_TTL_MS : REPLY_NEGATIVE_TTL_MS)) return hit.info;
  const numericId = Number(messageId);
  let info = null;
  if (Number.isSafeInteger(numericId)) {
    // OneBot 数值接口拉取真实消息，并做归属校验（防止跨会话读取其他群/私聊消息）
    try {
      const raw = await botRef.getMessage(numericId);
      if (raw) {
        let convOk = false;
        if (kind === 'group') {
          const rawGroup = raw.group_id ?? raw.groupId;
          // 网关返回连归属字段都缺失时视为无法确认归属：不信任、交给 DB 兜底
          convOk = rawGroup != null && String(rawGroup) === String(convId);
        } else {
          const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
          const rawGroup = raw.group_id ?? raw.groupId;
          // 私聊必须同时满足：没有群归属，且发送者匹配（selfId 视为“引用我自己发的消息”）
          convOk = rawGroup == null && rawUser != null
            && (String(rawUser) === String(convId) || (selfId != null && String(rawUser) === String(selfId)));
        }
        if (convOk) {
          const sender = raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? '未知');
          const text = await segmentsToText(raw.message ?? [], {
            resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
            includeReply: false
          });
          const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
          info = {
            sender: String(sender ?? ''),
            text: String(text ?? '').slice(0, 200),
            userId: senderUserId != null ? String(senderUserId) : null
          };
        }
      }
    } catch (error) {
      log('解析引用消息失败:', error?.message ?? error);
    }
  } else {
    // 超出安全整数范围的 QQ 消息 id 无法走 OneBot 数值接口；chat_messages.message_id 以文本存储，可走 DB 兜底
    log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
  }
  if (!info) info = resolveReplyInfoFromDb(kind, convId, messageId, selfId);
  replyInfoCache.set(cacheKey, { info, ts: Date.now() });
  return info;
}

/** SQLite chat_messages 兜底：OneBot 查不到/归属校验失败/数值 id 越界时，
 *  按本会话 (conv_key) 内的 message_id / 本地 seq 精确命中，返回与 OneBot 解析同形状的引用信息；
 *  已撤回（recalled_at>0）的记录不参与解析——撤回的消息不应再被引用。 */
function resolveReplyInfoFromDb(kind, convId, messageId, selfId) {
  try {
    const refStr = String(messageId ?? '').trim();
    if (!refStr) return null;
    const convKey = kind === 'group' ? `group:${String(convId)}` : `private:${String(convId)}`;
    const rows = recentChatMessages(convKey, 80);
    if (!rows.length) return null;
    const row = rows.find((m) => m && !m.recalled && (String(m.messageId || '') === refStr || (Number(m.seq) > 0 && String(m.seq) === refStr)));
    if (!row) return null;
    const rowMessageId = String(row.messageId || '');
    return {
      sender: String(row.sender || row.userId || '未知'),
      text: String(row.text || '').slice(0, 200),
      // 自发消息（is_self）在 DB 里 sender_uid='self'：能对上 selfId 就按“引用我自己”返回，否则不给 userId
      userId: row.isSelf ? (selfId != null ? String(selfId) : null) : (row.userId || null),
      // 该行真实 QQ message id（拍一拍等没有 id 的行为空串）；matchedBySeq=true 表示本次是「按本地 seq」
      // 命中而非「按真实 id」命中 —— 调用方必须据此换成真实 id（或拒绝），否则会把本地 seq 当 message id 发给 QQ。
      messageId: rowMessageId,
      matchedBySeq: rowMessageId !== refStr
    };
  } catch (error) {
    log('[chat-history] 引用解析 DB 兜底失败:', error?.message ?? error);
    return null;
  }
}


// P5-11 追加：入站合并转发自动展开

export async function expandIncomingForwardPreview(key, segments, originalText) {
  const ids = extractForwardIds(segments);
  // 守卫笔误曾写 !bot(不存在)→ 带转发消息一进来就 ReferenceError 中断整条入站处理。
  if (!ids.length || typeof botRef?.raw !== 'function') return originalText;
  let out = String(originalText ?? '');
  let appendedAny = false;
  const parts = [];
  for (const fid of ids) {
    try {
      const data = await botRef.raw('get_forward_msg', { id: fid });
      const formatted = formatForwardResponse(data, { maxMessages: 12, maxCharsPerMessage: 120 });
      if (!formatted || !Array.isArray(formatted.messages) || !formatted.messages.length) continue;
      const lines = [];
      for (const m of formatted.messages) {
        const who = (m.sender && String(m.sender)) || (m.userId ? String(m.userId) : '?');
        // OneBot 转发节点的 time 是「秒」，fmtBeijing 收「毫秒」：直接塞进去会渲染成 1970-01-22
        // （真实聊天记录里已出现）。按量级归一化，同时兼容网关给毫秒的情况。
        const tRaw = Number(m.time);
        const time = Number.isFinite(tRaw) && tRaw > 0 ? fmtBeijing(tRaw < 1e12 ? tRaw * 1000 : tRaw) : '';
        const rawText = String(m.text || '').trim();
        if (!rawText && !(Array.isArray(m.media) && m.media.length)) continue;
        let mediaMark = Array.isArray(m.media) && m.media.length ? (m.media.every((x) => x?.kind === 'face') ? '[表情]' : '[图]') : '';
        let body = rawText || mediaMark;
        // 转发内容同样过敏感审计，防止凭据/路径/令牌通过转发文本进入上下文后外泄
        if (SENSITIVE_RE.test(body)) body = redactSensitiveText(body);
        const segText = `[${time ? time + ' ' : ''}${who}]: ${body}`.trim();
        if (segText) lines.push(segText);
      }
      if (lines.length) {
        const truncated = formatted.total > 12;
        parts.push(`[转发聊天记录${truncated ? `（共${formatted.total}条，仅预览前12条）` : ''}]\n${lines.join('\n')}`);
        appendedAny = true;
      }
    } catch (error) {
      log(`[forward] 自动展开转发失败 ${key} ${fid}: ${error?.message ?? error}`);
    }
  }
  if (!appendedAny) return out;
  const expanded = `【对方转发了一段聊天记录】\n${parts.join('\n\n')}`;
  // 把原文本里的占位符替换成展开内容；没有占位符（如纯转发无文字）则直接作为消息文本
  let replaced = false;
  for (const fid of ids) {
    const marker = `[转发消息 id=${fid}]`;
    if (out.includes(marker)) {
      out = out.replace(marker, '');
      replaced = true;
    }
  }
  const cleaned = out.trim();
  if (cleaned && !replaced) return `${cleaned}\n\n${expanded}`;
  return replaced ? (cleaned ? `${cleaned}\n\n${expanded}` : expanded) : `${out.trim()}\n\n${expanded}`.trim();
}
