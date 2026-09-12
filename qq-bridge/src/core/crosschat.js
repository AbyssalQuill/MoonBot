// 跨会话互知 / 留言信箱
// 各 QQ 会话仍各自保有独立上下文（这是省 token 的关键），通过"活动摘要 + 留言信箱"实现会话间感知与转达：
//   · 回合收尾时把本会话刚做的事记一行简短摘要（state/crosschat.json，每会话最多 12 行）；
//   · 留言信箱：某会话可给另一会话留言（qq_crosschat_send），目标会话下次唤醒自动收到并标记已读；
//   · 唤醒注入策略（省 token）：平时不注入；只有【本会话有未读留言】或【最近对话明确提到别的会话/熟人】时，
//     才注入最多 2 行他处动态摘要。绝不给每个唤醒回合增加固定开销。
import crypto from 'node:crypto';
import { CROSSCHAT_FILE } from '../lib/paths.js';
import { readJsonSafe, atomicWriteJson } from '../lib/json-fs.js';
import { log } from '../lib/log.js';
import { profileDisplayName } from './memory.js';
import { getGroupDisplayName } from './group-cache.js';
import { getSocialState } from './social-state.js';

let crossChatCache = null;
let cfgRef = null;
/** main 启动时调用：注入 cfg（此后不再变） */
export function initCrossChatCore(cfg) {
  cfgRef = cfg;
}

function loadCrossChat() {
  if (!crossChatCache) crossChatCache = readJsonSafe(CROSSCHAT_FILE, { digests: {}, mail: {} });
  return crossChatCache;
}
function saveCrossChat(cc) { crossChatCache = cc; atomicWriteJson(CROSSCHAT_FILE, cc); }

export function pushCrossDigest(key, line) {
  if (!key || !line || !String(line).trim()) return;
  try {
    const cc = loadCrossChat();
    const arr = cc.digests[key] ?? [];
    arr.push({ t: Date.now(), line: String(line).slice(0, 70) });
    cc.digests[key] = arr.slice(-12);
    cc.digests = Object.fromEntries(Object.entries(cc.digests || {}).filter(([, v]) => Array.isArray(v) && v.length > 0));
    saveCrossChat(cc);
  } catch {}
}

/** 会话 key -> 可读来源标签（privately: 主人特判 / 联系人档案名；群：群名）。导出供控制台端点复用，
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

// 唤醒时按需组装"他处动态"块：仅当有未读留言，或最近对话提及别的会话/熟人时才注入（省 token）
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
    const stX = getSocialState(key);
    const recentX = Array.isArray(stX?.recentMessages) ? stX.recentMessages.slice(-3) : [];
    const mentionsOthers = recentX.some((m) => m && !m.isSelf && /(别的会话|另一个会话|其他会话|别处|那边|另一个群|别的群|其他群|在群里|去群里|AbyssalQuill)/.test(String(m.text || m.plain || '')));
    if (mentionsOthers && parts.length < 3) {
      const cc = loadCrossChat();
      const cutoff = Date.now() - 60 * 60 * 1000;
      const rows = [];
      for (const [k, arr] of Object.entries(cc.digests || {})) {
        if (k === key || !Array.isArray(arr)) continue;
        for (const d of arr) if (d && Number(d.t) >= cutoff) rows.push({ k, line: d.line, t: Number(d.t) || 0 });
      }
      rows.sort((a, b) => b.t - a.t);
      for (const r of rows.slice(0, 2)) {
        parts.push(`[Other sessions] ${describeCrossKey(r.k)}: ${String(r.line).slice(0, 80)} - already handled; do not re-act unless asked or new.`);
      }
    }
    return parts.length ? '\n' + parts.join('\n') : '';
  } catch (error) {
    log('[crosschat] 组装失败:', error?.message ?? error);
    return '';
  }
}
