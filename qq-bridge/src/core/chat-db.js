// 聊天记录独立库（state/chat.db）——「聊天记录」与「记忆」从 2026-09-24 起分家。
//
// ── 为什么要分家 ────────────────────────────────────────────────────────────────
// 原来 profiles / memory_entries / chat_messages 三张表挤在同一个 memory.db 里。三者的
// 生命周期完全不同：聊天记录是"只增不改、按会话可整段删"的流水，记忆条目是"少量、长期、
// 被反复注入上下文"的结论。混在一个文件里带来三个真实问题：
//   ① 删历史（清空某个群/某段时间）变成"动记忆库"：写放大、锁竞争都落在同一个文件上，
//      而桥、隔离 DSH 的记忆插件、管理端三方都在碰它；
//   ② 备份/迁移粒度太粗：想单独搬走"全部聊天记录"或单独搬走"记忆"，都得整库复制；
//   ③ 聊天记录是全库最大的那张表，它一膨胀，记忆那一侧的 VACUUM/检查也被拖着走。
// 所以：**聊天记录 → state/chat.db**（本模块独占），**记忆档案 → state/memory.db**（memory.js）。
// 调用方零改动：memory.js 把本模块的聊天函数原样 re-export，历史 import 路径全部照旧。
//
// ── 本模块负责的三件事 ──────────────────────────────────────────────────────────
//  1. 建表 + 全量可搜：chat_messages（永久全文库）+ **chat_fts**（FTS5 trigram 外部内容表，
//     配三个触发器自动同步）+ 索引。FTS 建不起来（库没编 FTS5）时检索自动退回 LIKE，
//     功能不消失；fts 状态在 chatDbStats() 里回给管理端，能被看见、能被验。
//  2. 消息总量计数：chat_stats（一行，全库总量 / 私聊 / 群聊 / 发出 / 收到 / 今日）+ chat_convs
//     （一会话一行：条数、发出、收到、最后一条时间与摘要）。写入走增量 +1，删除后整体重算，
//     于是"一查便知"不需要 COUNT(*) 扫全表。
//  3. 存量迁移：老库里已有 chat_messages 的会一次性搬到 chat.db（核对条数一致后才删旧表）。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from '../lib/paths.js';
import { beijingTs, beijingDateKey } from '../lib/time.js';
import { log } from '../lib/log.js';
import { ftsUsable, ftsQueryOf } from '../lib/fts.js';

/** 聊天记录库句柄（模块级单例；写成 export let 是为了让测试能在沙箱里重置） */
export let chatDb = null;

const CHAT_DB_FILE = 'chat.db';
const LEGACY_DB_FILE = 'memory.db';
const FTS_SCHEMA_VERSION = '1';        // 索引结构一变就 +1 → 下次启动自动重建（幂等）
const MIGRATE_MARK = 'migrated_from_memory_db';

/** 聊天记录库的绝对路径（管理端/诊断展示用） */
export function chatDbFile() {
  return path.join(ROOT, 'state', CHAT_DB_FILE);
}
/** 记忆档案库的绝对路径（只用于迁移与诊断展示） */
export function legacyMemoryDbFile() {
  return path.join(ROOT, 'state', LEGACY_DB_FILE);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 建库
 * ══════════════════════════════════════════════════════════════════════════ */

export function initChatDb() {
  if (chatDb) return chatDb;
  try {
    const dir = path.join(ROOT, 'state');
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(chatDbFile());
    // 完整聊天记录（永久存储，桥接自动写入，不经过大模型）：ts 用「YYYY-MM-DD HH:MM:SS」北京时前缀，
    // 便于按日期/发送人前缀查找（如 ts LIKE '2026-08-31%'），也与管理端的日期筛选对齐。
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
    // 2026-09-24 新增：按方向+时间统计（"今日发出多少条"这类查询走它，不扫全表）
    db.exec('CREATE INDEX IF NOT EXISTS idx_chat_dir_ts ON chat_messages(direction, ts_ms)');
    // 迁移自老库时这些列可能缺（老库是 ALTER 补的），新库直接建齐；幂等补齐仍保留，兼容手工回的旧文件。
    const cols = db.prepare('PRAGMA table_info(chat_messages)').all().map((r) => r.name);
    if (!cols.includes('qq_seq')) db.exec('ALTER TABLE chat_messages ADD COLUMN qq_seq INTEGER DEFAULT 0');
    if (!cols.includes('read_at')) db.exec('ALTER TABLE chat_messages ADD COLUMN read_at INTEGER DEFAULT 0');
    if (!cols.includes('recalled_at')) db.exec('ALTER TABLE chat_messages ADD COLUMN recalled_at INTEGER DEFAULT 0');
    // 幂等收尾：清理 (conv_key, message_id) 重复行并建部分唯一索引，防 WS 重投/双路径并发双写。
    // 部分唯一索引要求 message_id 非空且唯一 —— 存量重复会导致建索引失败，故先删重复（每组保留 id 最小一行）再建。
    try {
      const delInfo = db.prepare(
        `DELETE FROM chat_messages WHERE message_id != '' AND id NOT IN (
           SELECT MIN(id) FROM chat_messages WHERE message_id != '' GROUP BY conv_key, message_id
         )`
      ).run();
      if ((Number(delInfo.changes) || 0) > 0) log(`[chat-db] chat_messages 清理重复行 ${delInfo.changes} 条（防唯一索引冲突）`);
    } catch (error) {
      log(`[chat-db] chat_messages 重复行清理失败（忽略，继续启动）: ${error?.message ?? error}`);
    }
    try {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_msgid ON chat_messages(conv_key, message_id) WHERE message_id != ''`);
    } catch (error) {
      log(`[chat-db] chat_messages 消息 id 唯一索引创建失败（忽略，继续启动）: ${error?.message ?? error}`);
    }
    // 会话汇总表：一个会话一行（条数/发出/收到/最后一条时间与摘要）。管理端「聊天记录」页的
    // 会话列表直接读它，不用对 chat_messages 做 GROUP BY；聊天总量计数也靠它数私聊/群聊个数。
    db.exec(`CREATE TABLE IF NOT EXISTS chat_convs (
      conv_key TEXT PRIMARY KEY,
      kind TEXT DEFAULT '',
      name TEXT DEFAULT '',
      count INTEGER DEFAULT 0,
      sent INTEGER DEFAULT 0,
      received INTEGER DEFAULT 0,
      last_ts INTEGER DEFAULT 0,
      last_text TEXT DEFAULT ''
    )`);
    // 全库消息总量（恒定一行 id=1）：私聊 / 群聊 / 发出 / 收到 / 今日。为什么不用 COUNT(*)：
    // 这张表会被"一查便知"的接口反复读，而 COUNT(*) 在百万级流水上要扫索引；增量维护才是常数开销。
    db.exec(`CREATE TABLE IF NOT EXISTS chat_stats (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      total INTEGER DEFAULT 0,
      private_total INTEGER DEFAULT 0,
      group_total INTEGER DEFAULT 0,
      sent_total INTEGER DEFAULT 0,
      received_total INTEGER DEFAULT 0,
      conv_total INTEGER DEFAULT 0,
      conv_group INTEGER DEFAULT 0,
      conv_private INTEGER DEFAULT 0,
      first_ts INTEGER DEFAULT 0,
      last_ts INTEGER DEFAULT 0,
      day TEXT DEFAULT '',
      day_total INTEGER DEFAULT 0,
      day_sent INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    )`);
    db.exec("CREATE TABLE IF NOT EXISTS chat_meta (k TEXT PRIMARY KEY, v TEXT DEFAULT '')");
    chatDb = db;
    ensureChatFts(db);
    migrateChatHistoryFromMemoryDb(db);
    ensureChatCounters(db);
    log(`[chat-db] 聊天记录库已初始化：${chatDbFile()}`);
    return db;
  } catch (error) {
    log(`[chat-db] 初始化失败（聊天记录将不可用，但不影响其它功能）: ${error?.message ?? error}`);
    return null;
  }
}

/** 建 FTS5 trigram 外部内容表 + 三个同步触发器（幂等；建不起来只记日志，检索退回 LIKE）。 */
export function ensureChatFts(db) {
  if (!db) return { ok: false };
  const out = { ok: false, fts: 'chat_fts' };
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(content, tokenize='trigram', content='chat_messages', content_rowid='id')`);
    out.ok = true;
  } catch (e) {
    log(`[chat-db] chat_fts 全文索引不可用（该库可能没编 FTS5），检索退回 LIKE: ${e?.message ?? e}`);
    return out;
  }
  // 触发器：增/删/改与索引保持一致。DROP 再建，改定义时不会残留旧触发器。
  try {
    db.exec('DROP TRIGGER IF EXISTS chat_messages_fts_ai');
    db.exec('DROP TRIGGER IF EXISTS chat_messages_fts_ad');
    db.exec('DROP TRIGGER IF EXISTS chat_messages_fts_au');
    db.exec(`CREATE TRIGGER chat_messages_fts_ai AFTER INSERT ON chat_messages BEGIN
      INSERT INTO chat_fts(rowid, content) VALUES (new.id, new.content);
    END`);
    db.exec(`CREATE TRIGGER chat_messages_fts_ad AFTER DELETE ON chat_messages BEGIN
      INSERT INTO chat_fts(chat_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END`);
    db.exec(`CREATE TRIGGER chat_messages_fts_au AFTER UPDATE OF content ON chat_messages BEGIN
      INSERT INTO chat_fts(chat_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO chat_fts(rowid, content) VALUES (new.id, new.content);
    END`);
  } catch (e) {
    log(`[chat-db] chat_fts 触发器创建失败（忽略）: ${e?.message ?? e}`);
  }
  return out;
}

/** 重建全文索引（幂等；大库会跑几秒，因此只在版本变化、迁移后或手动调用时执行）。 */
export function rebuildChatFts({ reason = 'manual', db = null } = {}) {
  const d = db || initChatDb();
  if (!d) return { ok: false, error: '聊天记录库不可用' };
  try {
    const t0 = Date.now();
    d.exec(`INSERT INTO chat_fts(chat_fts) VALUES('rebuild')`);
    const ms = Date.now() - t0;
    chatMetaSet(d, 'fts_version', FTS_SCHEMA_VERSION);
    chatMetaSet(d, 'fts_rebuilt_at', String(Date.now()));
    log(`[chat-db] 全文索引重建完成（${reason}，${ms}ms）`);
    return { ok: true, ms };
  } catch (e) {
    log(`[chat-db] 全文索引重建失败（检索退回 LIKE）: ${e?.message ?? e}`);
    return { ok: false, error: e?.message ?? String(e) };
  }
}

function chatMetaSet(db, k, v) {
  try {
    db.prepare('INSERT INTO chat_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(String(k), String(v));
  } catch { /* 元信息写不进去不影响检索 */ }
}
function chatMetaGet(db, k) {
  try { return String(db.prepare('SELECT v FROM chat_meta WHERE k = ?').get(String(k))?.v ?? ''); } catch { return ''; }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 存量迁移：memory.db 里的 chat_messages → chat.db
 *
 * 只在「chat.db 还没有任何聊天行」且「老库里确实有聊天行」时执行一次。
 * 搬完必须核对条数一致，一致才删老库里的聊天表（否则保留原样、下次启动再试）。
 * 删是为了"真分家"：留着的话 memory.db 仍然背着最大那张表，等于没分。
 * ══════════════════════════════════════════════════════════════════════════ */
/** 迁移时老库缺列要填的默认值（键顺序 = chat_messages 的列顺序，取值时按这份清单拼 SQL） */
const LEGACY_COL_DEFAULTS = {
  conv_key: "''", msg_seq: '0', qq_seq: '0', message_id: "''", sender_uid: "''", sender_name: "''",
  is_self: '0', direction: "'in'", kind: "'text'", content: "''", quote_target: "''", media: "''",
  read_at: '0', recalled_at: '0', ts: "''", ts_ms: '0',
};

export function migrateChatHistoryFromMemoryDb(db) {
  if (!db) return { ok: false, error: '聊天记录库不可用' };
  if (chatMetaGet(db, MIGRATE_MARK)) return { ok: true, skipped: 'already-migrated' };
  const legacyFile = legacyMemoryDbFile();
  if (!fs.existsSync(legacyFile)) { chatMetaSet(db, MIGRATE_MARK, String(Date.now())); return { ok: true, skipped: 'no-legacy-db' }; }
  let attached = false;
  try {
    db.exec(`ATTACH DATABASE '${legacyFile.replace(/'/g, "''")}' AS legacy`);
    attached = true;
    const has = db.prepare("SELECT 1 AS x FROM legacy.sqlite_master WHERE type = 'table' AND name = 'chat_messages'").get();
    const legacyCount = has ? Number(db.prepare('SELECT COUNT(*) AS c FROM legacy.chat_messages').get()?.c || 0) : 0;
    const mine = Number(db.prepare('SELECT COUNT(*) AS c FROM chat_messages').get()?.c || 0);
    if (legacyCount > 0 && mine > 0) {
      // 两边都有数据：不冒险合并（会造成 id 冲突与重复），只记录并停手，交给人工判断。
      log(`[chat-db] 老库与 chat.db 都有聊天记录（${legacyCount} / ${mine}），跳过自动迁移；请在管理端确认后再处理`);
      chatMetaSet(db, MIGRATE_MARK, String(Date.now()));
      return { ok: false, error: 'both-non-empty', legacyCount, mine };
    }
    let moved = 0;
    if (legacyCount > 0) {
      const t0 = Date.now();
      // 老库的 chat_messages 未必长齐 16 列：qq_seq / read_at / recalled_at 是后来 ALTER 补的，
      // 从更早版本一路升上来的库里可能只有最初那 13 列 —— 直接 SELECT qq_seq 会报
      // "no such column: qq_seq"，整次迁移就白等一轮（数据不丢，但永远搬不过去）。
      // 所以按老库**实际有的列**列表取值，缺的列填类型中性的默认值。
      let legacyCols = null;
      try {
        legacyCols = new Set(db.prepare('PRAGMA legacy.table_info(chat_messages)').all().map((r) => String(r.name)));
      } catch { legacyCols = null; }
      const cols = Object.keys(LEGACY_COL_DEFAULTS);
      const missing = legacyCols ? cols.filter((c) => !legacyCols.has(c)) : [];
      const selectList = cols.map((c) => (missing.includes(c) ? `${LEGACY_COL_DEFAULTS[c]} AS ${c}` : c)).join(', ');
      if (missing.length) log(`[chat-db] 老库缺少 ${missing.join('/')} 列（版本较早），迁移时按默认值补齐`);
      db.exec(`INSERT INTO chat_messages
        (${cols.join(', ')})
        SELECT ${selectList}
        FROM legacy.chat_messages`);
      moved = Number(db.prepare('SELECT COUNT(*) AS c FROM chat_messages').get()?.c || 0);
      if (moved < legacyCount) {
        // 条数对不上：宁可留着老表，也不能让用户的历史丢一半。
        log(`[chat-db] 迁移条数不一致（老库 ${legacyCount} / 新库 ${moved}），已保留 memory.db 原表，下次启动重试`);
        return { ok: false, error: 'count-mismatch', legacyCount, moved };
      }
      log(`[chat-db] 已迁移聊天记录 ${moved} 条：memory.db → ${CHAT_DB_FILE}（${Date.now() - t0}ms）`);
    }
    // 老库里的聊天对象（含 FTS 影子表与触发器）一并清掉：迁移已被条数校验兜住。
    for (const sql of [
      'DROP TRIGGER IF EXISTS legacy.chat_messages_fts_ai',
      'DROP TRIGGER IF EXISTS legacy.chat_messages_fts_ad',
      'DROP TRIGGER IF EXISTS legacy.chat_messages_fts_au',
      'DROP TABLE IF EXISTS legacy.chat_fts',
      'DROP TABLE IF EXISTS legacy.chat_messages',
    ]) {
      try { db.exec(sql); } catch (e) { log(`[chat-db] 清理老库对象失败（忽略）${sql}: ${e?.message ?? e}`); }
    }
    if (legacyCount > 0) {
      // 释放老库里的空闲页（VACUUM 要独占锁，失败就跳过 —— 数据已经不在里面了）
      try { db.exec('VACUUM legacy'); } catch (e) { log(`[chat-db] memory.db VACUUM 跳过（不影响正确性）: ${e?.message ?? e}`); }
    }
    chatMetaSet(db, MIGRATE_MARK, String(Date.now()));
    // 迁移进来的行没有走过触发器 → 索引一次，保证"全量可搜"。
    if (moved > 0) rebuildChatFts({ reason: 'post-migration', db });
    return { ok: true, moved, legacyDropped: true };
  } catch (e) {
    log(`[chat-db] 迁移失败（保留老库，下次启动重试）: ${e?.message ?? e}`);
    return { ok: false, error: e?.message ?? String(e) };
  } finally {
    if (attached) { try { db.exec('DETACH DATABASE legacy'); } catch { /* 已经断开 */ } }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 消息总量计数（chat_stats / chat_convs）
 * ══════════════════════════════════════════════════════════════════════════ */

const convKindOf = (convKey) => (String(convKey).startsWith('group:') ? 'group' : 'private');

/** 启动自检：计数缺失、或与真实条数不符时整体重算（重算只做一次，放 setTimeout 里不拖慢启动）。 */
function ensureChatCounters(db) {
  try {
    const row = db.prepare('SELECT * FROM chat_stats WHERE id = 1').get();
    const actual = Number(db.prepare('SELECT COUNT(*) AS c FROM chat_messages').get()?.c || 0);
    const convRows = Number(db.prepare('SELECT COUNT(*) AS c FROM chat_convs').get()?.c || 0);
    if (row && Number(row.total) === actual && (actual === 0 || convRows > 0)) return { ok: true, consistent: true };
    setTimeout(() => {
      try {
        const r = recountChatCounters(db);
        if (r.ok) log(`[chat-db] 会话与总量计数已重算（${r.total} 条 / ${r.conv_total} 个会话）`);
      } catch { /* 已内记日志 */ }
    }, 0);
  } catch (e) {
    log(`[chat-db] 计数自检失败（忽略）: ${e?.message ?? e}`);
  }
  return { ok: true, consistent: false };
}

/**
 * 全量重算计数（删除历史之后必须调一次：DELETE 是批量操作，逐行扣减不划算，重算一条 SQL 更快也更准）。
 * 返回重算后的总量快照。
 */
export function recountChatCounters(db = null) {
  const d = db || initChatDb();
  if (!d) return { ok: false, error: '聊天记录库不可用' };
  try {
    d.exec('DELETE FROM chat_convs');
    d.exec(`INSERT INTO chat_convs (conv_key, kind, count, sent, received, last_ts)
      SELECT conv_key,
             CASE WHEN conv_key LIKE 'group:%' THEN 'group' ELSE 'private' END,
             COUNT(*),
             SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END),
             SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END),
             MAX(ts_ms)
      FROM chat_messages GROUP BY conv_key`);
    // 会话名与最后一条摘要：每个会话各取一次（走 idx_chat_conv_ts，会话数是几百量级，不是全表扫）
    try {
      d.exec(`UPDATE chat_convs SET name = COALESCE((
        SELECT m.sender_name FROM chat_messages m
        WHERE m.conv_key = chat_convs.conv_key AND m.sender_name <> ''
        ORDER BY m.ts_ms DESC, m.id DESC LIMIT 1), '')`);
      d.exec(`UPDATE chat_convs SET last_text = COALESCE((
        SELECT substr(m.content, 1, 120) FROM chat_messages m
        WHERE m.conv_key = chat_convs.conv_key
        ORDER BY m.ts_ms DESC, m.id DESC LIMIT 1), '')`);
    } catch (e) { log(`[chat-db] 会话摘要回填失败（忽略）: ${e?.message ?? e}`); }
    const agg = d.prepare(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN conv_key LIKE 'group:%' THEN 1 ELSE 0 END) AS g,
        SUM(CASE WHEN conv_key LIKE 'private:%' THEN 1 ELSE 0 END) AS p,
        SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS recv,
        MIN(ts_ms) AS first_ts,
        MAX(ts_ms) AS last_ts
      FROM chat_messages`).get() || {};
    const conv = d.prepare(`SELECT
        COUNT(*) AS c,
        SUM(CASE WHEN kind = 'group' THEN 1 ELSE 0 END) AS g,
        SUM(CASE WHEN kind = 'private' THEN 1 ELSE 0 END) AS p
      FROM chat_convs`).get() || {};
    const day = beijingDateKey(new Date());
    const dayAgg = d.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS sent
      FROM chat_messages WHERE ts LIKE ?`).get(`${day}%`) || {};
    const snap = {
      total: Number(agg.total) || 0,
      private_total: Number(agg.p) || 0,
      group_total: Number(agg.g) || 0,
      sent_total: Number(agg.sent) || 0,
      received_total: Number(agg.recv) || 0,
      conv_total: Number(conv.c) || 0,
      conv_group: Number(conv.g) || 0,
      conv_private: Number(conv.p) || 0,
      first_ts: Number(agg.first_ts) || 0,
      last_ts: Number(agg.last_ts) || 0,
      day,
      day_total: Number(dayAgg.total) || 0,
      day_sent: Number(dayAgg.sent) || 0,
    };
    d.prepare(`INSERT INTO chat_stats (id, total, private_total, group_total, sent_total, received_total,
        conv_total, conv_group, conv_private, first_ts, last_ts, day, day_total, day_sent, updated_at)
      VALUES (1, ?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET total = excluded.total, private_total = excluded.private_total,
        group_total = excluded.group_total, sent_total = excluded.sent_total, received_total = excluded.received_total,
        conv_total = excluded.conv_total, conv_group = excluded.conv_group, conv_private = excluded.conv_private,
        first_ts = excluded.first_ts, last_ts = excluded.last_ts, day = excluded.day,
        day_total = excluded.day_total, day_sent = excluded.day_sent, updated_at = excluded.updated_at`)
      .run(snap.total, snap.private_total, snap.group_total, snap.sent_total, snap.received_total,
        snap.conv_total, snap.conv_group, snap.conv_private, snap.first_ts, snap.last_ts,
        snap.day, snap.day_total, snap.day_sent, Date.now());
    return { ok: true, ...snap };
  } catch (e) {
    log(`[chat-db] 重算计数失败: ${e?.message ?? e}`);
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * 写入一条消息后的增量计数（热路径：三条小 UPDATE，不扫表）。
 * 日切在读取侧处理（chatCounters 里比日期），这里只维护 day_* 列 —— 这样跨零点不用定时任务。
 */
function bumpCountersOnInsert(db, { convKey, isSelf, tsMs, text, senderName }) {
  try {
    const isGroup = convKindOf(convKey) === 'group';
    const dir = isSelf ? 'out' : 'in';
    const day = beijingDateKey(new Date(Number(tsMs) || Date.now()));
    const st = db.prepare('SELECT day, day_total, day_sent FROM chat_stats WHERE id = 1').get();
    if (!st) { recountChatCounters(db); return; }
    const sameDay = String(st.day) === day;
    const dayTotal = sameDay ? Number(st.day_total) || 0 : 0;
    const daySent = sameDay ? Number(st.day_sent) || 0 : 0;
    db.prepare(`UPDATE chat_stats SET
        total = total + 1,
        private_total = private_total + ?,
        group_total = group_total + ?,
        sent_total = sent_total + ?,
        received_total = received_total + ?,
        first_ts = CASE WHEN first_ts = 0 OR ? < first_ts THEN ? ELSE first_ts END,
        last_ts = CASE WHEN ? > last_ts THEN ? ELSE last_ts END,
        day = ?, day_total = ?, day_sent = ?, updated_at = ?
      WHERE id = 1`)
      .run(isGroup ? 0 : 1, isGroup ? 1 : 0, isSelf ? 1 : 0, isSelf ? 0 : 1,
        Number(tsMs) || 0, Number(tsMs) || 0, Number(tsMs) || 0, Number(tsMs) || 0,
        day, dayTotal + 1, daySent + (isSelf ? 1 : 0), Date.now());
    db.prepare(`INSERT INTO chat_convs (conv_key, kind, name, count, sent, received, last_ts, last_text)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(conv_key) DO UPDATE SET
        count = count + 1,
        sent = sent + excluded.sent,
        received = received + excluded.received,
        last_ts = CASE WHEN excluded.last_ts >= last_ts THEN excluded.last_ts ELSE last_ts END,
        last_text = CASE WHEN excluded.last_ts >= last_ts THEN excluded.last_text ELSE last_text END,
        name = CASE WHEN excluded.name <> '' AND excluded.last_ts >= last_ts THEN excluded.name ELSE name END`)
      .run(String(convKey), convKindOf(convKey), String(senderName || '').slice(0, 80),
        isSelf ? 1 : 0, isSelf ? 0 : 1, Number(tsMs) || 0, String(text || '').slice(0, 120));
    // 会话个数只在"新会话"时变，这里按需同步（COUNT 走 chat_convs 主键，代价极小）
    db.prepare(`UPDATE chat_stats SET
        conv_total = (SELECT COUNT(*) FROM chat_convs),
        conv_group = (SELECT COUNT(*) FROM chat_convs WHERE kind = 'group'),
        conv_private = (SELECT COUNT(*) FROM chat_convs WHERE kind = 'private')
      WHERE id = 1`).run();
  } catch (e) {
    log(`[chat-db] 增量计数失败（下次读取会自检重算）: ${e?.message ?? e}`);
  }
}

/** 消息总量快照（"一查便知"的那个接口）：私聊/群聊/发出/收到/今日 + 会话个数。 */
export function chatCounters() {
  const d = initChatDb();
  if (!d) return { ok: false, error: '聊天记录库不可用' };
  try {
    let st = d.prepare('SELECT * FROM chat_stats WHERE id = 1').get();
    if (!st) {
      recountChatCounters(d);
      st = d.prepare('SELECT * FROM chat_stats WHERE id = 1').get() || {};
    }
    const today = beijingDateKey(new Date());
    const sameDay = String(st.day) === today;
    const num = (v) => Number(v) || 0;
    return {
      ok: true,
      total: num(st.total),
      privateTotal: num(st.private_total),
      groupTotal: num(st.group_total),
      sentTotal: num(st.sent_total),
      receivedTotal: num(st.received_total),
      convTotal: num(st.conv_total),
      groupConvs: num(st.conv_group),
      privateConvs: num(st.conv_private),
      firstTs: num(st.first_ts),
      lastTs: num(st.last_ts),
      day: today,
      todayTotal: sameDay ? num(st.day_total) : 0,
      todaySent: sameDay ? num(st.day_sent) : 0,
      updatedAt: num(st.updated_at),
    };
  } catch (e) {
    log(`[chat-db] 读取计数失败: ${e?.message ?? e}`);
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** 会话列表（管理端「聊天记录」页左栏）：条数/发出/收到/最后一条时间与摘要。 */
export function chatConvList({ kind = 'all', limit = 300, offset = 0 } = {}) {
  const d = initChatDb();
  if (!d) return { ok: false, error: '聊天记录库不可用', convs: [] };
  const where = kind === 'group' || kind === 'private' ? ' WHERE kind = ?' : '';
  const params = where ? [String(kind)] : [];
  const lim = Math.min(2000, Math.max(1, Number(limit) || 300));
  const off = Math.max(0, Number(offset) || 0);
  try {
    const total = Number(d.prepare(`SELECT COUNT(*) AS c FROM chat_convs${where}`).get(...params)?.c || 0);
    const rows = d.prepare(`SELECT conv_key, kind, name, count, sent, received, last_ts, last_text
      FROM chat_convs${where} ORDER BY last_ts DESC, count DESC LIMIT ? OFFSET ?`).all(...params, lim, off);
    return {
      ok: true, total, count: rows.length,
      convs: rows.map((r) => ({
        key: String(r.conv_key ?? ''),
        kind: String(r.kind ?? convKindOf(r.conv_key)),
        name: String(r.name ?? ''),
        count: Number(r.count) || 0,
        sent: Number(r.sent) || 0,
        received: Number(r.received) || 0,
        lastTs: Number(r.last_ts) || 0,
        lastText: String(r.last_text ?? ''),
      })),
    };
  } catch (e) {
    log(`[chat-db] 读会话列表失败: ${e?.message ?? e}`);
    return { ok: false, error: e?.message ?? String(e), convs: [] };
  }
}

/**
 * token 账本口径的"平均每条消息消耗"。
 * 账本 state/token-usage.jsonl 每行一条回合记录（tsMs + total + convKey）；分母取同一窗口内
 * **机器人发出**的消息条数 —— 用户真正关心的是"我说一句话要花多少 token"，把所有历史消息
 * （含对方发的）当分母会把数字稀释成没有意义的值。窗口默认 7 天（账本只留最近 5 万行，跨度
 * 本身也有限）。
 *
 * 2026-09-24 修正分子口径：账本里还有**与会话无关**的回合（黑话学习、群友画像等内部任务，
 * 没有 convKey），它们一条消息都没发，却被算进分母的同一堆 token 里 —— 实测近 7 天这类
 * 178 行、3031 万 token，会让"每条消息"虚高约 11%。现在只累计带 convKey 的会话轮次，
 * 其余单独报出（excludedLines / excludedTokens），既不静默丢数，也不混进平均。
 */
export function tokenUsageSummary({ days = 7 } = {}) {
  const d = initChatDb();
  const winDays = Math.min(365, Math.max(1, Number(days) || 7));
  const since = Date.now() - winDays * 86400000;
  const ledger = path.join(ROOT, 'state', 'token-usage.jsonl');
  let totalTokens = 0; let lines = 0; let firstTs = 0; let lastTs = 0; let readErr = '';
  let excludedTokens = 0; let excludedLines = 0;
  try {
    const raw = fs.readFileSync(ledger, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let o = null;
      try { o = JSON.parse(line); } catch { continue; }
      const t = Number(o?.tsMs) || 0;
      if (!t || t < since) continue;
      const tk = Number(o?.total) || 0;
      if (!String(o?.convKey || '')) { excludedTokens += tk; excludedLines += 1; continue; }
      totalTokens += tk;
      lines += 1;
      if (!firstTs || t < firstTs) firstTs = t;
      if (t > lastTs) lastTs = t;
    }
  } catch (e) {
    readErr = e?.message ?? String(e);
  }
  let messages = 0;
  try {
    messages = Number(d.prepare("SELECT COUNT(*) AS c FROM chat_messages WHERE direction = 'out' AND ts_ms >= ?").get(since)?.c || 0);
  } catch { /* 库不可用时按 0 处理，下面会说明 */ }
  const avg = messages > 0 ? Math.round(totalTokens / messages) : 0;
  return {
    totalTokens,
    messages,
    avgTokensPerMessage: avg,
    sinceDays: winDays,
    ledgerPath: ledger,
    ledgerLines: lines,
    excludedLines,
    excludedTokens,
    ledgerFirstTs: firstTs,
    ledgerLastTs: lastTs,
    note: readErr
      ? `token 账本读取失败（${readErr}）：平均消耗暂不可用`
      : (messages > 0
        ? `近 ${winDays} 天会话轮次 ${totalTokens} token ÷ 同期发出 ${messages} 条消息（含每次唤醒的上下文与缓存命中，不只是回复本身）`
          + (excludedLines > 0 ? `；另有 ${excludedLines} 次与会话无关的内部任务（${excludedTokens} token，如黑话学习/群友画像）未计入平均` : '')
        : `近 ${winDays} 天账本累计 ${totalTokens} token，但同期没有发出过消息，无法算平均`),
  };
}

/** 库自身规模与索引状态（管理端展示 / 诊断用：这里能直接看见"能不能全量搜"）。 */
export function chatDbStats() {
  const d = initChatDb();
  if (!d) return { ok: false, error: '聊天记录库不可用' };
  const counters = chatCounters();
  const ftsOk = ftsUsable(d, 'chat_fts');
  let indexed = -1;
  if (ftsOk) { try { indexed = Number(d.prepare('SELECT COUNT(*) AS c FROM chat_fts').get()?.c || 0); } catch { indexed = -1; } }
  let bytes = 0;
  try { bytes = fs.statSync(chatDbFile()).size; } catch { /* 文件刚建好还没落盘 */ }
  let legacyBytes = 0;
  let legacyRows = -1;
  try {
    const lp = legacyMemoryDbFile();
    if (fs.existsSync(lp)) {
      legacyBytes = fs.statSync(lp).size;
      const ldb = new DatabaseSync(lp, { readOnly: true, timeout: 500 });
      try {
        const has = ldb.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'chat_messages'").get();
        legacyRows = has ? Number(ldb.prepare('SELECT COUNT(*) AS c FROM chat_messages').get()?.c || 0) : 0;
      } finally { try { ldb.close(); } catch { /* 已关 */ } }
    }
  } catch { /* 老库打不开就只报路径 */ }
  return {
    ok: true,
    ...counters,
    dbPath: chatDbFile(),
    dbBytes: bytes,
    memoryDbPath: legacyMemoryDbFile(),
    memoryDbBytes: legacyBytes,
    legacyRows,
    fts: {
      ok: ftsOk,
      indexed,
      complete: ftsOk && indexed === Number(counters.total || 0),
      version: chatMetaGet(d, 'fts_version'),
      rebuiltAt: Number(chatMetaGet(d, 'fts_rebuilt_at')) || 0,
      migratedAt: Number(chatMetaGet(d, MIGRATE_MARK)) || 0,
    },
    tokenUsage: tokenUsageSummary({ days: 7 }),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 聊天记录读写（原 memory.js 的聊天半边，行为保持不变，只换了库文件）
 * ══════════════════════════════════════════════════════════════════════════ */

export function persistChatMessage(convKey, entry) {
  try {
    const db = initChatDb();
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
    // 计数跟着写入走（失败只在日志里留痕：读取侧每次启动会自检重算，数字不会长期错下去）
    bumpCountersOnInsert(db, { convKey, isSelf, tsMs, text, senderName: entry.sender });
  } catch (error) {
    log(`[chat-history] 写入失败: ${error?.message ?? error}`);
  }
}

/** 把某会话截至本地 seq（msg_seq）的入向消息标记为已读（read_at），返回更新行数。 */
export function markMessagesRead(convKey, upToSeq = 0, at = Date.now()) {
  const db = initChatDb();
  if (!db || !convKey) return { ok: false, error: '聊天记录库不可用' };
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
  const db = initChatDb();
  const mid = messageId != null ? String(messageId) : '';
  if (!convKey) return { ok: false, error: 'convKey 空' };
  if (!mid) return { ok: false, error: 'messageId 空' };
  if (!db) return { ok: false, error: '聊天记录库不可用' };
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
  const db = initChatDb();
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
      try { media = r.media ? JSON.parse(r.media) : []; } catch { /* 空/坏 JSON 当没有附件 */ }
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
  const db = initChatDb();
  if (!db || !convKey) return [];
  try {
    const rows = db.prepare(
      `SELECT * FROM (SELECT * FROM chat_messages WHERE conv_key = ? ORDER BY ts_ms DESC, id DESC LIMIT ?) ORDER BY ts_ms ASC, id ASC`
    ).all(String(convKey), Math.min(200, Math.max(1, Number(limit) || 25)));
    return rows.map((r) => {
      let media = [];
      try { media = r.media ? JSON.parse(r.media) : []; } catch { /* 空/坏 JSON 当没有附件 */ }
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

/* ══════════════════════════════════════════════════════════════════════════
 * 跨会话「他处最近发生了什么」—— 只读查询
 *
 * 为什么不靠 state/crosschat.json 的每回合摘要：那条路要额外写盘、摘要是二次加工文本
 * （跟谁说的、对谁说的都丢了）、只能按"最近一小时"粗筛。chat_messages 本来就是永久全文库，
 * 直接按时间窗查"别的会话"就够用：不写盘、不加工、天然带发送者与原文。
 *
 * 本函数只读：参数化 SQL（值一律 bind）、LIMIT 兜底（SQL 与返回条数都封顶）、
 * 失败/库不可用（表未建、桥从未运行过）一律返回空数组，绝不抛错。
 * ══════════════════════════════════════════════════════════════════════════ */
export function recentMessagesAcrossSessions(excludeKey, opts = {}) {
  const db = initChatDb();
  if (!db) return [];
  const now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const windowMs = Math.min(7 * 24 * 3600 * 1000, Math.max(60 * 1000, Number(opts.windowMs) || 60 * 60 * 1000));
  const limit = Math.min(10, Math.max(1, Number(opts.limit) || 2));
  const where = ["ts_ms >= ?", "content != ''"];
  const params = [now - windowMs];
  const exclude = String(excludeKey ?? '').trim();
  if (exclude) { where.push('conv_key != ?'); params.push(exclude); }
  const onlyKey = String(opts.convKey ?? '').trim();
  if (onlyKey) { where.push('conv_key = ?'); params.push(onlyKey); }
  const sender = String(opts.sender ?? '').trim();
  if (sender) { where.push('(sender_name LIKE ? OR sender_uid = ?)'); params.push(`%${sender}%`, sender); }
  /* 多扫几行再在内存里按会话去重：一次 LIMIT 16 的索引倒序扫描（走 idx_chat_ts）比在 SQL 里写
   * 窗口函数便宜，也避免"两个名额都落在同一个会话上"。去重只在没有指定 convKey 时生效 ——
   * 指定了会话就是要这个会话的连续几条。 */
  const scan = Math.min(200, Math.max(limit * 8, 16));
  try {
    const rows = db.prepare(
      `SELECT conv_key, sender_uid, sender_name, is_self, content, ts, ts_ms
       FROM chat_messages WHERE ${where.join(' AND ')}
       ORDER BY ts_ms DESC, id DESC LIMIT ?`
    ).all(...params, scan);
    const out = [];
    const seen = new Set();
    for (const r of rows) {
      const k = String(r.conv_key ?? '');
      if (!onlyKey && seen.has(k)) continue;
      seen.add(k);
      out.push({
        key: k,
        sender: String(r.sender_name ?? ''),
        senderUid: String(r.sender_uid ?? ''),
        isSelf: !!r.is_self,
        tsMs: Number(r.ts_ms) || 0,
        ts: String(r.ts ?? ''),
        text: String(r.content ?? '').slice(0, 200),
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch (error) {
    log(`[chat-db] 跨会话最近消息查询失败（忽略）: ${error?.message ?? error}`);
    return [];
  }
}

/** chat_messages 行 → 检索结果的统一形状（搜索分支与 FTS 分支共用，避免两处漂移）。 */
function rowToSearchMessage(r) {
  return {
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
  };
}

export function searchChatMessages(opts = {}) {
  const db = initChatDb();
  if (!db) return { ok: true, total: 0, messages: [] };
  const where = [];
  const params = [];
  if (opts.convKey) { where.push('conv_key = ?'); params.push(String(opts.convKey)); }
  /* 给了 query 就走 FTS5 trigram（BM25 相关性排序），查不到 / 短于 3 字 / 该库没编 FTS5 时
   * 自动退回 LIKE —— 行为只增不减。 */
  let joinSql = '';
  let orderSql = 'ts_ms DESC, id DESC';
  const ftsQ = opts.query ? ftsQueryOf(opts.query) : '';
  const useFts = !!ftsQ && ftsUsable(db, 'chat_fts');
  if (opts.query && useFts) {
    /* 2026-09-22 修「带 query 的历史检索 100% 失败」：FTS5 的 MATCH 不认表别名：
     * 原来 JOIN 写成 `chat_fts f`（起了别名），WHERE / ORDER BY 写 `chat_fts` → 报 "no such column: chat_fts"；
     * 反过来把三处都改成别名 `f` 也不行 → 报 "no such column: f"（实测两种写法都试过）。
     * 正确写法是不给 FTS 表起别名、三处一律用真名 —— 也就是下面这样。整条语句一报错就被 catch 吞掉、
     * 静默退回 LIKE，所以症状是"搜历史搜不到/不按相关度排"，而且没有任何报错。
     * 回归测试：tests/memory-fts.test.js（六项，含单字退 LIKE 与 convKey 过滤）。 */
    joinSql = ' JOIN chat_fts ON chat_fts.rowid = chat_messages.id';
    where.push('chat_fts MATCH ?');
    params.push(ftsQ);
    orderSql = 'bm25(chat_fts) ASC';
  } else if (opts.query) {
    where.push('content LIKE ?'); params.push('%' + String(opts.query) + '%');
  }
  if (opts.sender) { where.push('(sender_name LIKE ? OR sender_uid = ?)'); params.push('%' + String(opts.sender) + '%', String(opts.sender)); }
  if (opts.date) { where.push('ts LIKE ?'); params.push(String(opts.date) + '%'); }
  if (opts.fromTs) { where.push('ts_ms >= ?'); params.push(Number(opts.fromTs)); }
  if (opts.toTs) { where.push('ts_ms <= ?'); params.push(Number(opts.toTs)); }
  if (opts.maxTs) { where.push('ts_ms < ?'); params.push(Number(opts.maxTs)); }
  if (opts.direction) { where.push('direction = ?'); params.push(opts.direction === 'out' ? 'out' : 'in'); }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
  const offset = Math.max(0, Number(opts.offset) || 0);
  try {
    if (useFts) {
      // FTS 分支：不数总数（MATCH 下 COUNT 要再扫一遍索引，模型侧也不需要这个数）
      const rows = db.prepare(`SELECT chat_messages.* FROM chat_messages${joinSql}${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`).all(...params, limit, offset);
      return { ok: true, total: rows.length, limit, offset, ranked: true, messages: rows.map(rowToSearchMessage) };
    }
    const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM chat_messages${whereSql}`).get(...params)?.c || 0);
    const rows = db.prepare(`SELECT * FROM chat_messages${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const messages = rows.map(rowToSearchMessage);
    return { ok: true, total, limit, offset, messages };
  } catch (error) {
    log(`[chat-history] 搜索失败: ${error?.message ?? error}`);
    return { ok: false, error: error?.message ?? String(error), total: 0, messages: [] };
  }
}

/** 删除历史（按 id 列表 / 会话 / 关键词 / 发送人 / 日期 / 时间上界）。
 *  删除后整体重算计数与会话汇总 —— 批量 DELETE 逐行扣减不划算，重算一条 SQL 更快也更准。 */
export function deleteChatMessages(opts = {}) {
  const db = initChatDb();
  if (!db) return { ok: false, error: '聊天记录库不可用' };
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
  if (Number(opts.beforeMs) > 0) { where.push('ts_ms < ?'); params.push(Number(opts.beforeMs)); }
  if (!where.length) return { ok: false, error: '必须指定删除范围（ids/会话/关键词/发送人/日期/时间上界）' };
  const whereSql = ` WHERE ${where.join(' AND ')}`;
  try {
    const info = db.prepare(`DELETE FROM chat_messages${whereSql}`).run(...params);
    const deleted = Number(info.changes) || 0;
    if (deleted > 0) recountChatCounters(db);
    return { ok: true, deleted };
  } catch (error) {
    log(`[chat-history] 删除失败: ${error?.message ?? error}`);
    return { ok: false, error: error?.message ?? String(error) };
  }
}

export function clearChatHistory(convKey = '') {
  const db = initChatDb();
  if (!db) return { ok: false, error: '聊天记录库不可用' };
  try {
    const info = convKey
      ? db.prepare('DELETE FROM chat_messages WHERE conv_key = ?').run(String(convKey))
      : db.prepare('DELETE FROM chat_messages').run();
    const deleted = Number(info.changes) || 0;
    if (deleted > 0) recountChatCounters(db);
    return { ok: true, deleted };
  } catch (error) {
    log(`[chat-history] 清空失败: ${error?.message ?? error}`);
    return { ok: false, error: error?.message ?? String(error) };
  }
}

const LEARN_ROLEPLAY_SWITCH_RE = /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/;
const LEARN_CQ_TOKEN_RE = /\[CQ:[^\]]*\]/g;

/**
 * 批量读取多群增量入向消息供黑话学习。
 * opts: { convKeys?, fromTsMs, toTsMs, maxTotalMsgs=2400, perGroupCapMax=800 }
 * 返回 { ok, messages:[{convKey,senderUid,senderName,content,tsMs}], groups, sampledGroups }；
 * messages 已按 ts_ms 升序；content 截断至 200 字符且已过滤。
 */
export function loadGroupChatMessagesForLearning(opts = {}) {
  const db = initChatDb();
  if (!db) return { ok: false, error: '聊天记录库不可用', messages: [], groups: 0, sampledGroups: 0 };
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
