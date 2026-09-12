// 长期记忆 SQLite 库（主人/群友档案 + 通用记忆 + 完整聊天记录）
// 。memDb 为模块级单例；群缓存（bot 依赖）暂留 main。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from '../lib/paths.js';
import { beijingTs } from '../lib/time.js';
import { log } from '../lib/log.js';

export let memDb = null;

// ── 长期记忆 SQLite 库（主人/群友档案 + 通用记忆） ─────────────────────────
export function initMemoryDb() {
  if (memDb) return memDb;
  try {
    const dir = path.join(ROOT, 'state');
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, 'memory.db'));
    db.exec(`CREATE TABLE IF NOT EXISTS profiles (
      uid TEXT PRIMARY KEY,
      name TEXT DEFAULT '',
      personality TEXT DEFAULT '',
      likes TEXT DEFAULT '',
      dislikes TEXT DEFAULT '',
      birthday TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      updated_at INTEGER DEFAULT 0
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER DEFAULT 0
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_mem_uid ON memory_entries(uid, category)');
    // 完整聊天记录（永久存储，桥接自动写入，不经过大模型）：ts 用「YYYY-MM-DD HH:MM:SS」北京时前缀，
    // 便于按日期/发送人前缀查找（如 ts LIKE '2026-08-31%'）。
    db.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_key TEXT NOT NULL,
      msg_seq INTEGER DEFAULT 0,
      message_id TEXT DEFAULT '',
      sender_uid TEXT DEFAULT '',
      sender_name TEXT DEFAULT '',
      is_self INTEGER DEFAULT 0,
      direction TEXT DEFAULT 'in',
      kind TEXT DEFAULT 'text',
      content TEXT DEFAULT '',
      quote_target TEXT DEFAULT '',
      media TEXT DEFAULT '',
      ts TEXT DEFAULT '',
      ts_ms INTEGER DEFAULT 0
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_chat_conv_ts ON chat_messages(conv_key, ts_ms)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_chat_ts ON chat_messages(ts_ms)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_chat_sender ON chat_messages(sender_uid)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_chat_conv_content ON chat_messages(conv_key, content)');
    // 2026-09-06 迁移：补齐 QQ 原生 seq / 已读 / 撤回标记列（幂等，兼容存量库）
    const chatCols = db.prepare('PRAGMA table_info(chat_messages)').all().map((r) => r.name);
    if (!chatCols.includes('qq_seq')) db.exec('ALTER TABLE chat_messages ADD COLUMN qq_seq INTEGER DEFAULT 0');
    if (!chatCols.includes('read_at')) db.exec('ALTER TABLE chat_messages ADD COLUMN read_at INTEGER DEFAULT 0');
    if (!chatCols.includes('recalled_at')) db.exec('ALTER TABLE chat_messages ADD COLUMN recalled_at INTEGER DEFAULT 0');
    // 幂等收尾：清理 (conv_key, message_id) 存量重复行并建部分唯一索引，防 WS 重投/双路径并发双写。
    // 部分唯一索引要求 message_id 非空且唯一——存量重复会导致建索引失败，故先删重复（每组保留 id 最小一行）再建。
    try {
      const delInfo = db.prepare(
        `DELETE FROM chat_messages WHERE message_id != '' AND id NOT IN (
           SELECT MIN(id) FROM chat_messages WHERE message_id != '' GROUP BY conv_key, message_id
         )`
      ).run();
      if ((Number(delInfo.changes) || 0) > 0) log(`[memory] chat_messages 清理重复行 ${delInfo.changes} 条（防唯一索引冲突）`);
    } catch (error) {
      log(`[memory] chat_messages 重复行清理失败（忽略，继续启动）: ${error?.message ?? error}`);
    }
    try {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_msgid ON chat_messages(conv_key, message_id) WHERE message_id != ''`);
    } catch (error) {
      log(`[memory] chat_messages 消息 id 唯一索引创建失败（忽略，继续启动）: ${error?.message ?? error}`);
    }
    memDb = db;
    log('[memory] SQLite 记忆库已初始化');
    return db;
  } catch (error) {
    log(`[memory] SQLite 初始化失败（不影响主流程）: ${error?.message ?? error}`);
    return null;
  }
}

export function getProfile(uid) {
  const db = initMemoryDb();
  if (!db || !uid) return null;
  try {
    const row = db.prepare('SELECT * FROM profiles WHERE uid = ?').get(String(uid));
    return row || null;
  } catch (error) {
    log(`[memory] 读取档案失败 ${uid}: ${error?.message ?? error}`);
    return null;
  }
}

export function setProfileField(uid, field, value) {
  const db = initMemoryDb();
  if (!db || !uid) return null;
  const allowed = new Set(['name', 'personality', 'likes', 'dislikes', 'birthday', 'notes']);
  if (!allowed.has(field)) throw new Error(`档案字段只能是：${[...allowed].join('/')}`);
  const clean = String(value ?? '').trim().slice(0, 500);
  try {
    db.prepare(`INSERT INTO profiles (uid, ${field}, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET ${field} = excluded.${field}, updated_at = excluded.updated_at`)
      .run(String(uid), clean, Date.now());
    return getProfile(uid);
  } catch (error) {
    log(`[memory] 写档案失败 ${uid}/${field}: ${error?.message ?? error}`);
    return null;
  }
}

export function formatProfileText(uid) {
  const p = getProfile(uid);
  if (!p) return '';
  const parts = [];
  if (p.name) parts.push(`Name:${p.name}`);
  if (p.personality) parts.push(`Personality:${p.personality}`);
  if (p.likes) parts.push(`Likes:${p.likes}`);
  if (p.dislikes) parts.push(`Dislikes:${p.dislikes}`);
  if (p.birthday) parts.push(`Birthday:${p.birthday}`);
  if (p.notes) parts.push(`Notes:${p.notes}`);
  return parts.length ? parts.join('; ') : '';
}

// 按 QQ 号查通讯录昵称（规范化括号别名：把 "主名（别名）" 规整成 "主名/别名"），查不到返回 null。
export function profileDisplayName(uid) {
  if (!uid) return null;
  const db = initMemoryDb();
  if (!db) return null;
  try {
    const row = db.prepare("SELECT name FROM profiles WHERE uid = ? AND name != '' ORDER BY updated_at DESC LIMIT 1").get(String(uid));
    if (!row || !row.name) return null;
    const name = String(row.name).replace(/[（(]/g, '/').replace(/[）)]/g, '').trim();
    return name || null;
  } catch (error) {
    return null;
  }
}

export function formatContactsLine() {
  const db = initMemoryDb();
  if (!db) return '';
  try {
    const rows = db.prepare("SELECT uid, name FROM profiles WHERE name != '' ORDER BY updated_at DESC LIMIT 30").all();
    const list = [];
    for (const r of rows) {
      if (!r || !r.name) continue;
      // "主名（别名）" → 显示成 主名/别名，方便模型一眼认出别名
      const name = String(r.name).replace(/[（(]/g, '/').replace(/[）)]/g, '').trim();
      if (!name) continue;
      list.push(`${name}(QQ:${r.uid})`);
      if (list.length >= 20) break;
    }
    return list.length ? `[Contacts] ${list.join(', ')}` : '';
  } catch (error) {
    log(`[memory] 通讯录读取失败: ${error?.message ?? error}`);
    return '';
  }
}

// 按昵称反查 QQ 号（精确/包含匹配通讯录里的名字、括号别名、斜杠别名），找不到返回 null。
export function resolveNameToUid(name) {
  if (!name) return null;
  const db = initMemoryDb();
  if (!db) return null;
  const n = String(name).trim();
  if (!n) return null;
  try {
    const rows = db.prepare("SELECT uid, name FROM profiles WHERE name != ''").all();
    for (const r of rows) {
      if (!r || !r.name) continue;
      const full = String(r.name);
      const pm = full.match(/^([^（(]+)[（(]([^）)]+)[）)]$/);
      const base = pm ? pm[1] : full;
      const paren = pm ? pm[2] : '';
      const aliases = [full, base, ...base.split(/[\/\s、,，;；]+/), ...paren.split(/[\/\s、,，;；]+/)]
        .map((x) => String(x ?? '').trim()).filter(Boolean);
      if (aliases.some((a) => a && (a === n || a.includes(n) || n.includes(a)))) return String(r.uid);
    }
  } catch (error) {
    log(`[memory] 名字解析失败 ${name}: ${error?.message ?? error}`);
  }
  return null;
}

// ── 完整聊天记录持久化（SQLite chat_messages，桥接自动写入，不经过大模型） ──

export function persistChatMessage(convKey, entry) {
  try {
    const db = initMemoryDb();
    if (!db || !convKey || !entry) return;
    const tsMs = Number(entry.time || Date.now());
    const text = String(entry.text ?? entry.plain ?? '');
    const isSelf = !!entry.isSelf;
    const messageId = entry.messageId != null ? String(entry.messageId) : '';
    // 幂等：同一会话同一条真实 QQ message_id 只落库一次（WS 重投/双路径发送不重复写）
    if (messageId) {
      const hit = db.prepare("SELECT 1 AS x FROM chat_messages WHERE conv_key = ? AND message_id = ? AND message_id != '' LIMIT 1")
        .get(String(convKey), messageId);
      if (hit) return;
    }
    let kind = 'text';
    if (entry.kind === 'poke') kind = 'poke';
    else if (entry.sticker) kind = 'sticker';
    else if (isSelf && text.startsWith('[QQ表情')) kind = 'qqface';
    const mediaJson = (() => {
      try { return Array.isArray(entry.media) && entry.media.length ? JSON.stringify(entry.media) : ''; }
      catch { return ''; }
    })();
    db.prepare(`INSERT INTO chat_messages (conv_key, msg_seq, qq_seq, message_id, sender_uid, sender_name, is_self, direction, kind, content, quote_target, media, read_at, ts, ts_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        String(convKey),
        Number(entry.seq) || 0,
        Number(entry.qqSeq ?? entry.messageSeq) || 0,
        messageId,
        entry.userId != null ? String(entry.userId) : (isSelf ? 'self' : ''),
        String(entry.sender || '').slice(0, 80),
        isSelf ? 1 : 0,
        isSelf ? 'out' : 'in',
        kind,
        text.slice(0, 2000),
        String(entry.quoteTarget || '').slice(0, 300),
        mediaJson.slice(0, 20000), // 完整合法 JSON；多图不截断成非法串
        Number(entry.readAt) || 0,
        beijingTs(tsMs),
        tsMs
      );
  } catch (error) {
    log(`[chat-history] 写入失败: ${error?.message ?? error}`);
  }
}

/** 把某会话截至本地 seq（msg_seq）的入向消息标记为已读（read_at），返回更新行数。 */
export function markMessagesRead(convKey, upToSeq = 0, at = Date.now()) {
  const db = initMemoryDb();
  if (!db || !convKey) return { ok: false, error: '记忆库不可用' };
  try {
    const params = [Number(at) || Date.now(), String(convKey)];
    // 只管入向：read_at 是「入向未读水位」，落库时 out 行 read_at 恒为 0，若不带 direction 条件
    // 会把自发消息也一并置为已读，使 updated 计数虚高、水位语义与 fetchUnreadChatMessages 不一致。
    let sql = "UPDATE chat_messages SET read_at = ? WHERE conv_key = ? AND direction = 'in' AND read_at = 0";
    if (Number(upToSeq) > 0) {
      sql += ' AND msg_seq <= ?';
      params.push(Number(upToSeq));
    }
    const info = db.prepare(sql).run(...params);
    return { ok: true, updated: Number(info.changes) || 0 };
  } catch (error) {
    log(`[chat-history] 标记已读失败: ${error?.message ?? error}`);
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** 把某条已落库消息标记为撤回（recalled_at=now，幂等可重复调用）。
 *  同一函数覆盖两个方向：bot 自查撤回命中 direction='out' 的自发消息行，对方撤回命中 'in' 行；
 *  方向由调用方保证 messageId 属于该会话即可，函数本身只按 (conv_key, message_id) 定位。 */
export function markChatRecalled(convKey, messageId, at = Date.now()) {
  const db = initMemoryDb();
  const mid = messageId != null ? String(messageId) : '';
  if (!convKey) return { ok: false, error: 'convKey 空' };
  if (!mid) return { ok: false, error: 'messageId 空' };
  if (!db) return { ok: false, error: '记忆库不可用' };
  try {
    const info = db.prepare(
      "UPDATE chat_messages SET recalled_at = ? WHERE conv_key = ? AND message_id = ? AND message_id != ''"
    ).run(Number(at) || Date.now(), String(convKey), mid);
    return { ok: true, updated: Number(info.changes) || 0 };
  } catch (error) {
    log(`[chat-history] 标记撤回失败 ${convKey} ${mid}: ${error?.message ?? error}`);
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** 语义别名：bot 自查撤回（自发消息 direction='out'）专用入口，实现与 markChatRecalled 完全相同。 */
export const markOutboundRecalled = markChatRecalled;

/** 拉取某会话未读消息（read_at=0 的入向消息，按时间升序），供重启后恢复未读队列。
 *  minTsMs>0 时只取晚于该时间戳的消息（结合会话 lastAiSeenAt 水位，避免把迁移前旧历史误当未读）。 */
export function fetchUnreadChatMessages(convKey, limit = 30, minTsMs = 0) {
  const db = initMemoryDb();
  if (!db || !convKey) return [];
  try {
    const n = Math.min(100, Math.max(1, Number(limit) || 30));
    const params = [String(convKey)];
    let extraSql = '';
    if (Number(minTsMs) > 0) { extraSql = ' AND ts_ms > ?'; params.push(Number(minTsMs)); }
    params.push(n);
    const rows = db.prepare(
      `SELECT * FROM (SELECT * FROM chat_messages WHERE conv_key = ? AND direction = 'in' AND read_at = 0${extraSql} ORDER BY ts_ms DESC, id DESC LIMIT ?) ORDER BY ts_ms ASC, id ASC`
    ).all(...params);
    return rows.map((r) => {
      let media = [];
      try { media = r.media ? JSON.parse(r.media) : []; } catch {}
      return {
        seq: Number(r.msg_seq) || 0,
        messageId: r.message_id || '',
        isSelf: false,
        sender: r.sender_name || '',
        userId: (r.sender_uid && r.sender_uid !== 'self') ? r.sender_uid : null,
        time: Number(r.ts_ms) || 0,
        text: r.content || '',
        kind: r.kind || 'text',
        media,
        recalled: !!r.recalled_at   // 撤回标记：与内存 recentMessages 的 recalled 对齐（渲染 [已撤回]）
      };
    });
  } catch (error) {
    log(`[chat-history] 拉取未读失败: ${error?.message ?? error}`);
    return [];
  }
}

/** 拉取某会话最近 N 条聊天记录（升序，来自 SQLite chat_messages —— 冷启动/新会话开局上下文用）。
 *  返回与 st.recentMessages 同形状的条目（media 反序列化为数组），查不到返回空数组。 */
export function recentChatMessages(convKey, limit = 25) {
  const db = initMemoryDb();
  if (!db || !convKey) return [];
  try {
    const rows = db.prepare(
      `SELECT * FROM (SELECT * FROM chat_messages WHERE conv_key = ? ORDER BY ts_ms DESC, id DESC LIMIT ?) ORDER BY ts_ms ASC, id ASC`
    ).all(String(convKey), Math.min(200, Math.max(1, Number(limit) || 25)));
    return rows.map((r) => {
      let media = [];
      try { media = r.media ? JSON.parse(r.media) : []; } catch {}
      return {
        seq: Number(r.msg_seq) || 0,
        messageId: r.message_id || '',
        isSelf: !!r.is_self,
        sender: r.sender_name || '',
        userId: (r.sender_uid && r.sender_uid !== 'self') ? r.sender_uid : null,
        time: Number(r.ts_ms) || 0,
        text: r.content || '',
        kind: r.kind || 'text',
        media,
        quoteTarget: r.quote_target || '',
        recalled: !!r.recalled_at   // 撤回标记：与内存 recentMessages 的 recalled 对齐（渲染 [已撤回]）
      };
    });
  } catch (error) {
    log(`[chat-history] 拉取最近消息失败: ${error?.message ?? error}`);
    return [];
  }
}

export function searchChatMessages(opts = {}) {
  const db = initMemoryDb();
  if (!db) return { ok: true, total: 0, messages: [] };
  const where = [];
  const params = [];
  if (opts.convKey) { where.push('conv_key = ?'); params.push(String(opts.convKey)); }
  if (opts.query) { where.push('content LIKE ?'); params.push('%' + String(opts.query) + '%'); }
  if (opts.sender) { where.push('(sender_name LIKE ? OR sender_uid = ?)'); params.push('%' + String(opts.sender) + '%', String(opts.sender)); }
  if (opts.date) { where.push('ts LIKE ?'); params.push(String(opts.date) + '%'); }
  if (opts.fromTs) { where.push('ts_ms >= ?'); params.push(Number(opts.fromTs)); }
  if (opts.toTs) { where.push('ts_ms <= ?'); params.push(Number(opts.toTs)); }
  if (opts.direction) { where.push('direction = ?'); params.push(opts.direction === 'out' ? 'out' : 'in'); }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
  const offset = Math.max(0, Number(opts.offset) || 0);
  try {
    const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM chat_messages${whereSql}`).get(...params)?.c || 0);
    const rows = db.prepare(`SELECT * FROM chat_messages${whereSql} ORDER BY ts_ms DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const messages = rows.map((r) => ({
      id: Number(r.id),
      convKey: r.conv_key,
      seq: Number(r.msg_seq) || 0,
      messageId: r.message_id || '',
      senderUid: r.sender_uid || '',
      senderName: r.sender_name || '',
      isSelf: !!r.is_self,
      direction: r.direction || 'in',
      kind: r.kind || 'text',
      content: r.content || '',
      quoteTarget: r.quote_target || '',
      media: r.media || '',
      ts: r.ts || '',
      tsMs: Number(r.ts_ms) || 0,
      recalledAt: Number(r.recalled_at) || 0,   // 撤回时间戳（0=未撤回）
      recalled: !!r.recalled_at                  // 撤回标记（控制台最近消息回退读取等映射用）
    }));
    return { ok: true, total, limit, offset, messages };
  } catch (error) {
    log(`[chat-history] 搜索失败: ${error?.message ?? error}`);
    return { ok: false, error: error?.message ?? String(error), total: 0, messages: [] };
  }
}

export function deleteChatMessages(opts = {}) {
  const db = initMemoryDb();
  if (!db) return { ok: false, error: '记忆库不可用' };
  const where = [];
  const params = [];
  if (Array.isArray(opts.ids) && opts.ids.length) {
    const list = opts.ids.map(Number).filter(Number.isFinite);
    if (!list.length) return { ok: false, error: 'ids 无效' };
    where.push(`id IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (opts.convKey) { where.push('conv_key = ?'); params.push(String(opts.convKey)); }
  if (opts.query) { where.push('content LIKE ?'); params.push('%' + String(opts.query) + '%'); }
  if (opts.sender) { where.push('(sender_name LIKE ? OR sender_uid = ?)'); params.push('%' + String(opts.sender) + '%', String(opts.sender)); }
  if (opts.date) { where.push('ts LIKE ?'); params.push(String(opts.date) + '%'); }
  if (!where.length) return { ok: false, error: '必须指定删除范围（ids/会话/关键词/发送人/日期）' };
  const whereSql = ` WHERE ${where.join(' AND ')}`;
  try {
    const info = db.prepare(`DELETE FROM chat_messages${whereSql}`).run(...params);
    return { ok: true, deleted: Number(info.changes) || 0 };
  } catch (error) {
    log(`[chat-history] 删除失败: ${error?.message ?? error}`);
    return { ok: false, error: error?.message ?? String(error) };
  }
}

export function clearChatHistory(convKey = '') {
  const db = initMemoryDb();
  if (!db) return { ok: false, error: '记忆库不可用' };
  try {
    const info = convKey
      ? db.prepare('DELETE FROM chat_messages WHERE conv_key = ?').run(String(convKey))
      : db.prepare('DELETE FROM chat_messages').run();
    return { ok: true, deleted: Number(info.changes) || 0 };
  } catch (error) {
    log(`[chat-history] 清空失败: ${error?.message ?? error}`);
    return { ok: false, error: error?.message ?? String(error) };
  }
}

// ── 会话记忆格式化/写入 ─────────
import { redactKnownTokensOnly } from '../lib/outbound-text.js';
import { saveSocialState } from './social-state.js';

let cfgRef = null;
/** main 启动时调用：注入 cfg（此后不再变） */
export function initMemoryCore(cfg) {
  cfgRef = cfg;
}

export function formatMemory(st) {
  if (!st) return '';
  const lines = [];
  // 最近我主动发的空间说说（来自 SQLite memory_entries.qzone_post），让 AI 知道自己发过什么
  try {
    const db = initMemoryDb();
    if (db && st && (st._qzoneShown !== true)) {
      const uid = String(st.key ? String(st.key).split(':')[1] : '');
      const uid2 = String(cfgRef?.ownerQQ ?? '');
      const recentPosts = db.prepare(`SELECT content FROM memory_entries WHERE category = 'qzone_post' AND uid = ? ORDER BY created_at DESC LIMIT 3`).all(uid2);
      if (recentPosts.length) {
        lines.push('[My recent Qzone posts]');
        for (const rp of recentPosts) lines.push(`- ${String(rp.content).slice(0, 80)}`);
      }
    }
  } catch (error) {
    log(`[memory] 说说记录读取失败: ${error?.message ?? error}`);
  }
  const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
  if (topics.length) {
    lines.push('[Active topics]');
    for (const t of topics.slice(-10)) {
      const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
      const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? ' (stale)' : '';
      lines.push(`- ${t.text}${stale} (${ago > 0 ? ago + ' min ago' : 'just now'})${t.pendingQuestion ? `; pending Q: ${t.pendingQuestion}` : ''}`);
    }
  }
  const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)) : [];
  if (thoughts.length) {
    lines.push('[Things you wanted to say]');
    for (const t of thoughts.slice(-10)) {
      lines.push(`- ${t.text}${t.motivation ? ` (${t.motivation})` : ''}`);
    }
  }
  const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
  const names = Object.keys(impressions);
  if (names.length) {
    lines.push('[Impressions of members]');
    for (const name of names.slice(-10)) {
      const im = impressions[name] || {};
      const traits = Array.isArray(im.traits) ? im.traits : [];
      lines.push(`- ${name}: ${traits.length ? traits.join(', ') : 'none yet'} (interacted ${Number(im.interactionCount) || 0} times)`);
    }
  }
  return lines.join('\n');
}

export function appendMemory(st, category, content, extra = {}) {
  if (!st) return;
  const text = redactKnownTokensOnly(String(content ?? '')).trim();
  const cat = String(category || '').trim();
  // 轻量清理：过期想法移除；超过 24h 未提起的话题移除（避免无限膨胀）。
  if (Array.isArray(st.pendingThoughts)) {
    st.pendingThoughts = st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
  }
  if (Array.isArray(st.activeTopics)) {
    st.activeTopics = st.activeTopics.filter((t) => t && (!t.lastMentionAt || Date.now() - Number(t.lastMentionAt) < 24 * 60 * 60 * 1000));
  }
  if (cat === 'activeTopic' && text) {
    if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
    const existing = st.activeTopics.find((t) => t && String(t.text || '') === text);
    if (existing) {
      existing.lastMentionAt = Date.now();
      if (Array.isArray(extra.participants)) {
        const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => redactKnownTokensOnly(String(p)))]);
        existing.participants = [...set].slice(0, 10);
      }
      if (extra.pendingQuestion) existing.pendingQuestion = redactKnownTokensOnly(String(extra.pendingQuestion)).slice(0, 200);
    } else {
      st.activeTopics.push({
        text: text.slice(0, 200),
        lastMentionAt: Date.now(),
        participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redactKnownTokensOnly(String(p))).slice(0, 10) : [],
        pendingQuestion: redactKnownTokensOnly(String(extra.pendingQuestion || '')).slice(0, 200)
      });
    }
    if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
  } else if (cat === 'pendingThought' && text) {
    if (!Array.isArray(st.pendingThoughts)) st.pendingThoughts = [];
    const existing = st.pendingThoughts.find((t) => t && String(t.text || '') === text);
    if (existing) {
      existing.createdAt = Date.now();
      existing.expiresAt = Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000);
      if (extra.motivation) existing.motivation = redactKnownTokensOnly(String(extra.motivation)).slice(0, 50);
    } else {
      st.pendingThoughts.push({
        text: text.slice(0, 200),
        createdAt: Date.now(),
        expiresAt: Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
        motivation: redactKnownTokensOnly(String(extra.motivation || 'curiosity')).slice(0, 50)
      });
    }
    if (st.pendingThoughts.length > 20) st.pendingThoughts.splice(0, st.pendingThoughts.length - 20);
  } else if (cat === 'memberImpression') {
    const target = String(extra.target || '').trim();
    if (!target || ['__proto__', 'constructor', 'prototype'].includes(target)) return;
    if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
    const old = st.memberImpressions[target] || {};
    const traits = Array.isArray(old.traits) ? old.traits.slice(0, 10) : [];
    if (text && !traits.includes(text.slice(0, 50))) traits.push(text.slice(0, 50));
    st.memberImpressions[target] = {
      traits,
      interactionCount: (Number(old.interactionCount) || 0) + 1,
      lastSeenAt: Date.now()
    };
    const impressionEntries = Object.entries(st.memberImpressions);
    if (impressionEntries.length > 50) {
      impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
      for (let i = 0; i < impressionEntries.length - 50; i++) {
        delete st.memberImpressions[impressionEntries[i][0]];
      }
    }
  }
  saveSocialState();
}

// ── 群消息黑话学习批量读取（夜间定时 / /slang learn 共用；仅追加导出，未改动既有函数） ──
// 只学“别人的话”：direction='in' AND is_self=0 AND kind IN('text','qqface') AND content 非空；
// 过滤：以 / 开头、纯 CQ 码、[转发 前缀、角色扮演开关句（与 slang.js feedSlangWindow 过滤一致）。
// 一次可传多个群 conv_key（群格式 group:群号，来自 cfg.allow.groups）；不传则自动发现区间内活跃群。
// 单群超量按时间均匀抽样（ROW_NUMBER 等差取号），保证全天覆盖而非只取头部。

const LEARN_ROLEPLAY_SWITCH_RE = /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/;
const LEARN_CQ_TOKEN_RE = /\[CQ:[^\]]*\]/g;

/**
 * 批量读取多群增量入向消息供黑话学习。
 * opts: { convKeys?, fromTsMs, toTsMs, maxTotalMsgs=2400, perGroupCapMax=800 }
 * 返回 { ok, messages:[{convKey,senderUid,senderName,content,tsMs}], groups, sampledGroups }；
 * messages 已按 ts_ms 升序；content 截断至 200 字符且已过滤。
 */
export function loadGroupChatMessagesForLearning(opts = {}) {
  const db = initMemoryDb();
  if (!db) return { ok: false, error: '记忆库不可用', messages: [], groups: 0, sampledGroups: 0 };
  try {
    const convKeys = Array.isArray(opts.convKeys) ? opts.convKeys.map((k) => String(k).trim()).filter(Boolean) : [];
    const fromTsMs = Math.max(0, Number(opts.fromTsMs) || 0);
    const toTsMs = Math.max(fromTsMs, Number(opts.toTsMs) || Date.now());
    const maxTotalMsgs = Math.max(1, Math.min(20000, Number(opts.maxTotalMsgs) || 2400));
    const perGroupCapMax = Math.max(1, Math.min(2000, Number(opts.perGroupCapMax) || 800));
    const baseConds = "direction = 'in' AND is_self = 0 AND kind IN ('text','qqface') AND content <> '' AND ts_ms >= ? AND ts_ms <= ? AND content NOT LIKE '/%' AND content NOT LIKE '[CQ:%' AND content NOT LIKE '[转发%'";
    const condParams = [fromTsMs, toTsMs];
    let groupSql = "conv_key LIKE 'group:%'";
    const groupParams = condParams.slice();
    if (convKeys.length) {
      groupSql += ` AND conv_key IN (${convKeys.map(() => '?').join(',')})`;
      groupParams.push(...convKeys);
    }
    const active = db.prepare(`SELECT conv_key AS ck, COUNT(*) AS c FROM chat_messages WHERE ${baseConds} AND ${groupSql} GROUP BY conv_key ORDER BY conv_key`).all(...groupParams);
    if (!active.length) return { ok: true, messages: [], groups: 0, sampledGroups: 0 };
    // 多群均分预算：每个群一个均等 cap（再叠加 perGroupCapMax 上限）
    const perCap = Math.max(1, Math.min(perGroupCapMax, Math.floor(maxTotalMsgs / active.length)));
    const messages = [];
    let sampledGroups = 0;
    const pickSql = `SELECT conv_key AS ck, sender_uid AS su, sender_name AS sn, content AS ct, ts_ms AS t FROM chat_messages WHERE ${baseConds} AND conv_key = ?`;
    for (const row of active) {
      const ck = String(row.ck ?? '');
      const total = Number(row.c) || 0;
      const cap = Math.min(perCap, total);
      const args = [...condParams, ck];
      let rows;
      if (total <= perCap) {
        rows = db.prepare(`${pickSql} ORDER BY ts_ms ASC, id ASC`).all(...args);
      } else {
        // 单群超量：按时间均匀抽样（rn % step = 1 等差取号）
        sampledGroups += 1;
        const step = Math.max(2, Math.ceil(total / cap));
        rows = db.prepare(
          `SELECT ck, su, sn, ct, t FROM (
             SELECT conv_key AS ck, sender_uid AS su, sender_name AS sn, content AS ct, ts_ms AS t,
                    ROW_NUMBER() OVER (ORDER BY ts_ms ASC, id ASC) AS rn
             FROM chat_messages WHERE ${baseConds} AND conv_key = ?
           ) WHERE rn % ? = 1 ORDER BY rn ASC`
        ).all(...args, step);
      }
      for (const r of rows) {
        const original = String(r.ct ?? '');
        if (!original) continue;
        const cleaned = original.replace(LEARN_CQ_TOKEN_RE, ' ').trim();
        if (!cleaned) continue;                      // 纯 CQ 码（去码后无内容）
        if (cleaned.startsWith('/')) continue;       // 斜杠指令（SQL 前缀已兜底）
        if (LEARN_ROLEPLAY_SWITCH_RE.test(cleaned)) continue; // 角色扮演开关句（与 feedSlangWindow 一致）
        messages.push({
          convKey: ck,
          senderUid: String(r.su ?? ''),
          senderName: String(r.sn ?? ''),
          content: cleaned.slice(0, 200),           // 与 feedSlangWindow 相同截断
          tsMs: Number(r.t) || 0
        });
      }
    }
    messages.sort((a, b) => (a.tsMs || 0) - (b.tsMs || 0) || String(a.convKey).localeCompare(String(b.convKey)));
    return { ok: true, messages, groups: active.length, sampledGroups };
  } catch (error) {
    log(`[chat-history] 批量读取学习消息失败: ${error?.message ?? error}`);
    return { ok: false, error: error?.message ?? String(error), messages: [], groups: 0, sampledGroups: 0 };
  }
}
