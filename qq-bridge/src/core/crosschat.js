// 跨会话互知 / 留言信箱
// 各 QQ 会话仍各自保有独立上下文（这是省 token 的关键），通过"他处消息 + 留言信箱"实现会话间感知与转达：
//   · 他处动态：直接从 SQLite 查（memory.js 的 recentMessagesAcrossSessions），不再维护摘要文件；
//   · 留言信箱：某会话可给另一会话留言（qq_crosschat_send），目标会话下次唤醒自动收到并标记已读
//     （信箱仍落在 state/crosschat.json：留言是"主动转达"，与"查消息"是两件事，行为不变）；
//   · 唤醒注入策略：本会话有未读留言 → 先注入留言；再注入最多 2 行"他处刚发生的事"（1 小时内、
//     单行正文 ≤80 字、整行不超过旧实现的同标签长度）。没有新鲜内容就完全不注入。
// 2026-09-30 需求「跨会话架构改为直接从 sqlite 查消息」：
// 旧实现（文件摘要）：turn-guard 回合收尾把本会话做过的事写成一行 ≤70 字存进 crosschat.json，
// 唤醒时读该文件、按"最近一小时"粗筛后注入。毛病是：每回合都要额外写盘；摘要是二次加工的文本，
// 谁说的、对谁说的全丢了；只能按时间粗筛，没法按人/按会话过滤；且摘要数组要自己维护上限。
// 现在改为直接查 chat_messages（已有 idx_chat_ts 索引）：不写盘、拿到的是原文与发送者，
// 需要时还能按会话/发送者过滤。老的 state/crosschat.json 里可能还留着历史 digests ——
// 不做迁移，查库路径根本不读它，那些老数据就此被忽略（文件里仍原样躺着，只是没人再看）。
import crypto from 'node:crypto';
import { CROSSCHAT_FILE } from '../lib/paths.js';
import { readJsonSafe, atomicWriteJson } from '../lib/json-fs.js';
import { log } from '../lib/log.js';
import { profileDisplayName, recentMessagesAcrossSessions } from './memory.js';
import { getGroupDisplayName } from './group-cache.js';

let crossChatCache = null;
let cfgRef = null;
/** main 启动时调用：注入 cfg（此后不再变） */
export function initCrossChatCore(cfg) {
  cfgRef = cfg;
}

function loadCrossChat() {
  /* 默认形状里只有 mail：digests 已随摘要写入路径一起作废。老文件里可能还留着 digests，
   * 读进来的对象会原样带着它（saveCrossChat 写回时也原样带着），但没有任何代码再去看它 ——
   * 这就是"不做迁移、老数据直接被忽略"的实现方式。 */
  if (!crossChatCache) crossChatCache = readJsonSafe(CROSSCHAT_FILE, { mail: {} });
  return crossChatCache;
}
function saveCrossChat(cc) { crossChatCache = cc; atomicWriteJson(CROSSCHAT_FILE, cc); }

/** 会话 key -> 可读来源标签（privately: 账号所有者特判 / 联系人档案名；群：群名）。导出供控制台端点复用，
 *  避免各调用方各写一份同样的标签规则。内部只用到本模块作用域的 cfgRef 与已导入的档案/群名工具。 */
export function describeCrossKey(key) {
  try {
    if (key.startsWith('private:')) {
      const uid = key.split(':')[1];
      if (String(uid) === String(cfgRef.ownerQQ)) return `owner private(${uid})`;
      const pn = profileDisplayName(uid);
      return pn ? `private(${pn})` : `private:${uid}`;
    }
    if (key.startsWith('group:')) {
      const gid = key.split(':')[1];
      const gn = getGroupDisplayName(gid);
      return gn ? `group(${gn})` : `group:${gid}`;
    }
  } catch {}
  return key;
}

export function addCrossMail(toKey, fromKey, content) {
  if (!toKey || !fromKey || !content || !String(content).trim()) return false;
  const cc = loadCrossChat();
  const arr = cc.mail[toKey] ?? [];
  arr.push({ id: crypto.randomBytes(6).toString('hex'), from: fromKey, content: String(content).slice(0, 400), ts: Date.now(), read: false });
  cc.mail[toKey] = arr.slice(-10);
  saveCrossChat(cc);
  log(`[crosschat] 留言 ${describeCrossKey(fromKey)} -> ${describeCrossKey(toKey)}: ${String(content).slice(0, 40)}`);
  return true;
}

export function unreadCrossMails(key, max = 2) {
  try { return ((loadCrossChat().mail[key] ?? []).filter((m) => m && !m.read)).slice(0, max); } catch { return []; }
}

/** 标记留言已读。ids 省略/null 时标记该会话全部未读留言；传入 id 列表时只标记这些条
 *  （唤醒每轮只注入 2 条，绝不能把没注入过的第 3 条及以后一起标掉）。 */
export function markCrossMailsRead(key, ids = null) {
  try {
    const cc = loadCrossChat();
    const arr = cc.mail[key] ?? [];
    const only = Array.isArray(ids) && ids.length ? new Set(ids.map((x) => String(x))) : null;
    let changed = false;
    for (const m of arr) {
      if (!m || m.read) continue;
      if (only && !only.has(String(m.id))) continue;
      m.read = true;
      changed = true;
    }
    if (changed) saveCrossChat(cc);
  } catch {}
}

// 唤醒时按需组装"他处动态"块：仅当有未读留言，或库里有别处的 1 小时内消息时才注入（省 token）。
// 每行长度硬约束 = 旧实现同一标签下的行长（前缀 + 标签 + ': ' + 80 字正文 + 后缀），因此每行
// 都不长于改动前、整块自然也不更长；正文本身仍 ≤80 字。
const CROSS_HEAD = '[Other sessions] ';
const CROSS_SUFFIX = ' - already handled; do not re-act unless asked or new.';
const CROSS_BODY_MAX = 80;      // 单行正文上限（与旧实现一致）
const CROSS_LABEL_MAX = 40;     // 来源标签上限：群名可以很长，不设限会把正文挤没
const CROSS_WHO_MAX = 16;       // 发送者名上限（同理由）
const CROSS_HOUR_MS = 60 * 60 * 1000;
/** 旧实现在同一标签下的行长上限（用作本实现的硬天花板）。 */
const legacyLineMax = (label) => CROSS_HEAD.length + label.length + 2 + CROSS_BODY_MAX + CROSS_SUFFIX.length;

export function buildCrossChatBlock(key) {
  try {
    const parts = [];
    const mails = unreadCrossMails(key, 2);
    for (const m of mails) {
      parts.push(`[Mail] ${describeCrossKey(m.from)}: ${String(m.content).slice(0, 160)}`);
    }
    // 只标记真正注入过的这几条：原实现是无条件把该会话全部未读留言标已读，队列里第 3 条及以后
    // （addCrossMail 每会话最多留 10 条）永远不会被注入却已被标记已读 → 静默丢留言。
    if (mails.length) markCrossMailsRead(key, mails.map((m) => m.id));
    /* 2026-09-30 需求「跨会话架构改为直接从 sqlite 查消息」：
     * 这一段原来是读 state/crosschat.json 的 digests（每会话最多 12 行、只取 1 小时内、每行 ≤70 字），
     * 现在换成 memory.js 的 recentMessagesAcrossSessions(key, …) —— 直接按时间窗从 chat_messages 里
     * 取"别的会话最近的消息"。省 token 的口径不变：最多 2 条、单行不得长于旧实现的同标签行长、
     * 没有新鲜内容就完全不注入、绝不注入别的会话全文。
     * 明确不做的事：不改回复台账（台账仍严格按会话区分，否则会把 A 里回过的话在 B 里当成"已回过"而漏回）；
     * 不引入迁移逻辑（老的 digests 被忽略，见文件头）。 */
    for (const r of recentMessagesAcrossSessions(key, { windowMs: CROSS_HOUR_MS, limit: 2 })) {
      const label = describeCrossKey(r.key).slice(0, CROSS_LABEL_MAX);
      const who = (r.isSelf ? 'you' : String(r.sender || '').trim().slice(0, CROSS_WHO_MAX)) || r.key;
      const head = `${CROSS_HEAD}${label}: ${who}: `;
      const body = String(r.text ?? '').replace(/\s+/g, ' ').slice(0, CROSS_BODY_MAX);
      const cap = Math.min(legacyLineMax(label), 170);
      let line = head + body + CROSS_SUFFIX;
      if (line.length > cap) {
        // 标签/发送者名偏长时只压缩正文，正文永远不超过 80 字（cap 只可能更小）。
        line = head + body.slice(0, Math.max(0, cap - head.length - CROSS_SUFFIX.length)) + CROSS_SUFFIX;
        if (line.length > cap) line = line.slice(0, cap);   // 极端长标签才走这里
      }
      parts.push(line);
    }
    return parts.length ? '\n' + parts.join('\n') : '';
  } catch (error) {
    log('[crosschat] 组装失败:', error?.message ?? error);
    return '';
  }
}
