// 长期记忆 SQLite 库（主人/群友档案 + 通用记忆 + 完整聊天记录）
// 。memDb 为模块级单例；群缓存（bot 依赖）暂留 main。
//
// ── 【2026-09-21 记忆架构升级（v1.3.0）】───────────────────────────────────────
// 主人要求："升级记忆架构、档案架构，永久记忆一些东西；SQLite 储存还可以，甚至可以重构这一层。
// 增强上下文理解、语义理解，尽量永久一轮对话或混合着来，用尽一切办法压缩成本。"
//
// 这一层原来只有三个朴素表（profiles / memory_entries / chat_messages），检索全靠
// `content LIKE '%词%'` 全表扫 —— 结论有三条，全是钱和时间：
//   ① 检索慢且不准：LIKE 没有相关性排序，30 万条历史里"找上次说的那件事"要么扫全表、要么查不着；
//      模型一旦查不着就会说"我看不到更早的消息"（最贵的一种失败：主人一眼看出失忆）。
//   ② 没有轻重：一条"主人不吃香菜"和一条随口闲话躺在同一张表里，谁都不会过期、谁都不会被优先注入。
//   ③ 没有"永久"这个概念：主人真正想永久记住的东西，没有任何机制保证它**每一轮都在**。
//
// 现在的分层（都在同一个 memory.db 里，不动既有调用方）：
//   TIER permanent（永久）：pinned=1 或 category ∈ {rule, owner, identity}。永不过期，每轮注入摘要。
//   TIER durable（长期）：默认层。默认 90 天不活跃才淡出（expires_at 可显式指定）。
//   TIER working（短期）：显式 working=true 或 importance 很低的临时条目，7 天淡出。
//   检索：SQLite **FTS5 trigram** 全文索引（content='表名' 外部内容表 + 触发器同步）。
//     trigram 对中文是"三字滑窗"，中文子串照样命中，不需要分词器；BM25 天然给出相关性排序。
//     这就是"语义理解/上下文理解"的底座：模型说一句模糊的话，也能从三年聊天记录里捞回最相关的那几条。
//   成本：索引与触发器全部在 SQLite 内部完成（C 实现），桥侧只多一次 INSERT 的开销；
//     注入给模型的是**几百字符的摘要**，不是把历史塞回上下文 —— 省钱靠的是"按需检索"而不是"全都记住"。
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
    ensureMemoryIndex(db);
    log('[memory] SQLite 记忆库已初始化');
    return db;
  } catch (error) {
    log(`[memory] SQLite 初始化失败（不影响主流程）: ${error?.message ?? error}`);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 记忆分层 + 全文检索（v1.3.0）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 记忆层级 → 默认存活时长（ms）。0 = 永不过期。 */
export const MEMORY_TIERS = { permanent: 0, durable: 90 * 24 * 3600 * 1000, working: 7 * 24 * 3600 * 1000 };
/** 这些 category 天然属于"永久"（主人定的规矩 / 主人本人 / 身份设定）—— 不需要显式 pin 也不淡出。 */
export const PERMANENT_CATEGORIES = new Set(['rule', 'owner', 'identity']);
const FTS_SCHEMA_VERSION = '2';   // 索引结构一变就 +1 → 下次启动自动重建（幂等）

function tableHasColumn(db, table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === col); } catch { return false; }
}

/**
 * 建索引 / 加列 / 建触发器（幂等）。任何一步失败都只记日志、绝不阻断桥启动 ——
 * 记忆库是增强件，坏了不能把聊天一起带下水。
 */
export function ensureMemoryIndex(db = memDb) {
  if (!db) return { ok: false, error: '记忆库不可用' };
  const out = { ok: true, columns: [], fts: [], rebuilt: false };
  // ① memory_entries 补列（存量库用 ALTER，幂等）
  const cols = [
    ['pinned', 'INTEGER DEFAULT 0'],
    ['importance', 'INTEGER DEFAULT 0'],
    ['last_used_at', 'INTEGER DEFAULT 0'],
    ['hits', 'INTEGER DEFAULT 0'],
    ['expires_at', 'INTEGER DEFAULT 0'],
    ['conv_key', "TEXT DEFAULT ''"],
    ['tags', "TEXT DEFAULT ''"],
    ['source', "TEXT DEFAULT ''"],
    ['tier', "TEXT DEFAULT ''"],
    ['updated_at', 'INTEGER DEFAULT 0'],
  ];
  for (const [name, decl] of cols) {
    if (tableHasColumn(db, 'memory_entries', name)) continue;
    try { db.exec(`ALTER TABLE memory_entries ADD COLUMN ${name} ${decl}`); out.columns.push(name); } catch (e) {
      log(`[memory] memory_entries.${name} 加列失败（忽略）: ${e?.message ?? e}`);
    }
  }
  // ①b 【记忆库 v1.3.0 新增】memory_meta：索引版本等元信息（一张一行的 KV 表）
  try {
    db.exec('CREATE TABLE IF NOT EXISTS memory_meta (k TEXT PRIMARY KEY, v TEXT DEFAULT \'\')');
  } catch (e) { log(`[memory] memory_meta 建表失败（忽略）: ${e?.message ?? e}`); }
  // ② 检索用索引：把"谁、哪层、什么时候用过"变成可走索引的查询
  for (const sql of [
    'CREATE INDEX IF NOT EXISTS idx_mem_tier ON memory_entries(tier, uid, pinned)',
    'CREATE INDEX IF NOT EXISTS idx_mem_conv ON memory_entries(conv_key, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_mem_expire ON memory_entries(expires_at)',
  ]) { try { db.exec(sql); } catch (e) { log(`[memory] 索引创建失败 ${sql}: ${e?.message ?? e}`); } }

  // ③ FTS5 trigram 全文索引（外部内容表 + 触发器同步）。
  //    为什么用外部内容表：文本只存一份（chat_messages / memory_entries 自己），索引里只有词条指针，
  //    数据库不会膨胀一倍；内容更新靠触发器自动同步，桥侧零维护。
  const ftsDefs = [
    { name: 'chat_fts', src: 'chat_messages', label: '聊天记录' },
    { name: 'mem_fts', src: 'memory_entries', label: '记忆条目' },
  ];
  for (const d of ftsDefs) {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${d.name} USING fts5(content, tokenize='trigram', content='${d.src}', content_rowid='id')`);
      out.fts.push(d.name);
    } catch (e) {
      log(`[memory] ${d.name} 全文索引不可用（该库可能没编 FTS5），检索退回 LIKE: ${e?.message ?? e}`);
      continue;
    }
    // 触发器：三张表（增/删/改）与索引保持一致。DROP 再建，改定义时不会残留旧触发器。
    try {
      const that = d.name;
      const src = d.src;
      db.exec(`DROP TRIGGER IF EXISTS ${src}_fts_ai`);
      db.exec(`DROP TRIGGER IF EXISTS ${src}_fts_ad`);
      db.exec(`DROP TRIGGER IF EXISTS ${src}_fts_au`);
      db.exec(`CREATE TRIGGER ${src}_fts_ai AFTER INSERT ON ${src} BEGIN
        INSERT INTO ${that}(rowid, content) VALUES (new.id, new.content);
      END`);
      db.exec(`CREATE TRIGGER ${src}_fts_ad AFTER DELETE ON ${src} BEGIN
        INSERT INTO ${that}(${that}, rowid, content) VALUES ('delete', old.id, old.content);
      END`);
      db.exec(`CREATE TRIGGER ${src}_fts_au AFTER UPDATE OF content ON ${src} BEGIN
        INSERT INTO ${that}(${that}, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO ${that}(rowid, content) VALUES (new.id, new.content);
      END`);
    } catch (e) {
      log(`[memory] ${d.src} 全文索引触发器创建失败（忽略）: ${e?.message ?? e}`);
    }
  }
  // ④ 一次性的索引重建：存量库里已有几十万行，触发器只覆盖"建索引之后"的新增。
  //    放在 setTimeout(…,0) 里跑，**不拖慢桥启动**；重建期间检索仍可用（只是可能少看到老消息）。
  //    （不用 setImmediate：本仓库的静态作用域检查（scripts/check-scope.mjs）只开 DOM lib，
  //      setImmediate 不在其中会被判成"未定义标识符"，改用它就过不了 CI。）
  try {
    const row = db.prepare("SELECT v FROM memory_meta WHERE k = 'fts_version'").get();
    if (String(row?.v ?? '') !== FTS_SCHEMA_VERSION) {
      setTimeout(() => { try { rebuildMemoryFts({ reason: 'schema-upgrade' }); } catch { /* 已内记日志 */ } }, 0);
    }
  } catch { /* 忽略 */ }
  return out;
}

/** 重建两份全文索引（幂等；大库会跑几秒，因此只在版本变化或手动调用时执行）。 */
export function rebuildMemoryFts({ reason = 'manual' } = {}) {
  const db = initMemoryDb();
  if (!db) return { ok: false, error: '记忆库不可用' };
  const done = [];
  for (const name of ['chat_fts', 'mem_fts']) {
    try {
      const t0 = Date.now();
      db.exec(`INSERT INTO ${name}(${name}) VALUES('rebuild')`);
      done.push(`${name}(${Date.now() - t0}ms)`);
    } catch (e) {
      log(`[memory] ${name} 重建失败（检索退回 LIKE）: ${e?.message ?? e}`);
    }
  }
  try {
    db.prepare("INSERT INTO memory_meta (k, v) VALUES ('fts_version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .run(FTS_SCHEMA_VERSION);
    db.prepare("INSERT INTO memory_meta (k, v) VALUES ('fts_rebuilt_at', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .run(String(Date.now()));
  } catch { /* 忽略 */ }
  if (done.length) log(`[memory] 全文索引重建完成（${reason}）：${done.join(', ')}`);
  return { ok: true, rebuilt: done };
}

/** 全文索引可用吗（FTS5 表存在且能查）。不可用时所有检索自动退回 LIKE，功能不消失、只是慢。 */
function ftsUsable(db, name) {
  try { db.prepare(`SELECT rowid FROM ${name} LIMIT 1`).get(); return true; } catch { return false; }
}

/**
 * 把用户/模型给的一段自然语言变成 FTS5 查询串。
 * trigram 分词器要求每个 token ≥ 3 个字符：不足 3 字的碎片会被 FTS5 直接拒绝（返回空），
 * 所以这里**拆成"够长的词"分别 OR**，并把双引号去掉（避免语法错误）。
 * 返回 '' 表示"没法用 FTS 查"→ 调用方退回 LIKE。
 */
export function ftsQueryOf(text) {
  const raw = String(text ?? '').replace(/["']/g, ' ').trim();
  if (!raw) return '';
  const parts = raw.split(/[\s,，。;；、:：!！?？()（）\[\]【】/\\|+*^-]+/).map((s) => s.trim()).filter((s) => s.length >= 3);
  if (!parts.length) return '';
  // 最多 8 个词：词越多越贵，且后面几个基本不改变排序
  return parts.slice(0, 8).map((p) => `"${p}"`).join(' OR ');
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

/** 把**观察到的**昵称补进通讯录（只在当前为空时写，绝不覆盖已学到的/主人设过的名字）。
 *
 * 【2026-09-23 修「群聊的人的 QQ 号昵称好像还无法识别」】
 * 现场诊断（服务端 state/memory.db）：`profiles` 共 23 行，**有名字的只有 1 行**；
 * 而 `formatContactsLine()` 是 `WHERE name != '' ... LIMIT 30`，于是注入给模型的
 * `[Contacts]` 只有主人一个人。群友在消息里明明带着解析好的昵称
 * （recentMessages 里 sender="马卡龙不是南梁" / "坐忘道" / "星痕Ofter" …），
 * 但那些名字**从来没有被写进 profiles** —— 模型看得到号码，通讯录里却查无此人。
 * 写入时机就是每条入站消息：桥手上已经有 `event.sender.card || nickname` 与 QQ 号，
 * 顺手补一行即可，不必等画像学习跑到那个人（学习是抽样、覆盖不全，这才是根因）。 */
export function rememberContactName(uid, name) {
  const u = String(uid ?? '').trim();
  const n = String(name ?? '').trim();
  if (!u || !n) return false;
  if (!/^\d{5,12}$/.test(u)) return false;   // 只认 QQ 号
  if (/^\d+$/.test(n)) return false;         // "名字"本身就是号码 → 没有信息量
  if (n.length > 64) return false;           // 群名片不会这么长，多半是误传的正文
  const db = initMemoryDb();
  if (!db) return false;
  try {
    const cur = db.prepare('SELECT name FROM profiles WHERE uid = ?').get(u);
    if (cur && String(cur.name ?? '').trim()) return false;   // 已有名字：不动
    db.prepare(`INSERT INTO profiles (uid, name, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`)
      .run(u, n.slice(0, 500), Date.now());
    return true;
  } catch (error) {
    log(`[memory] 补昵称失败 ${u}: ${error?.message ?? error}`);
    return false;
  }
}

export function setProfileField(uid, field, value) {
  const db = initMemoryDb();
  if (!db || !uid) return null;
  const allowed = new Set(['name', 'personality', 'likes', 'dislikes', 'birthday', 'notes']);
  if (!allowed.has(field)) throw new Error(`档案字段只能是：${[...allowed].join('/')}`);
  // 长度上限分字段：personality/notes 要装得下**一整段人格画像**（成文介绍上千字，
  // 旧的统一 500 会把介绍从中间切掉，界面和提示词里都只剩半句）；其它短字段保持 500。
  const cap = (field === 'personality' || field === 'notes') ? 4000 : 500;
  const clean = String(value ?? '').trim().slice(0, cap);
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
  const db = initMemoryDb();
  if (!db) return { ok: true, total: 0, messages: [] };
  const where = [];
  const params = [];
  if (opts.convKey) { where.push('conv_key = ?'); params.push(String(opts.convKey)); }
  /* 【2026-09-21 检索升级】给了 query 就走 FTS5 trigram（BM25 相关性排序），
   * 查不到 / 短于 3 字 / 该库没编 FTS5 时自动退回原来的 LIKE —— 行为只增不减。 */
  let joinSql = '';
  let orderSql = 'ts_ms DESC, id DESC';
  const ftsQ = opts.query ? ftsQueryOf(opts.query) : '';
  const useFts = !!ftsQ && ftsUsable(db, 'chat_fts');
  if (opts.query && useFts) {
    /* 【2026-09-22 修「带 query 的历史检索 100% 失败」】FTS5 的 MATCH **不认表别名**：
     * 原来 JOIN 写成 `chat_fts f`（起了别名），WHERE / ORDER BY 写 `chat_fts` → 报 "no such column: chat_fts"；
     * 反过来把三处都改成别名 `f` 也不行 → 报 "no such column: f"（实测两种写法都试过）。
     * 正确写法是**不给 FTS 表起别名**、三处一律用真名 —— 也就是下面这样。整条语句一报错就被 catch 吞掉、
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

/* ══════════════════════════════════════════════════════════════════════════
 * 分层记忆 API（v1.3.0）—— 永久 / 长期 / 短期 + 相关性检索
 * ══════════════════════════════════════════════════════════════════════════ */

/** 归一：tier 字符串 → 规范层级名（非法值一律按 durable） */
function normTier(v, { pinned = false, category = '' } = {}) {
  const t = String(v ?? '').trim().toLowerCase();
  if (t === 'permanent' || t === 'durable' || t === 'working') return t;
  if (pinned || PERMANENT_CATEGORIES.has(String(category ?? '').trim())) return 'permanent';
  return 'durable';
}

/** 归一：mem_fts 行 → 对外形状 */
function rowToMemoryEntry(r) {
  return {
    id: Number(r.id),
    uid: r.uid || '',
    category: r.category || '',
    content: r.content || '',
    createdAt: Number(r.created_at) || 0,
    updatedAt: Number(r.updated_at) || Number(r.created_at) || 0,
    /* 【2026-09-22 修 M14】有的写入路径是**裸 INSERT**（qzone.js / persona-learn.js 直接往表里插行），
     * 那些行 tier 是空串；以前 `r.tier || 'durable'` 会在读出时**谎报**成 durable，而 listMemoryEntries 的
     * `tier=?` 过滤又不归一化 → 同一批数据两处口径不一致。现在读出即归一（空串/未知值一律当 durable），
     * 与 server/index.js 的 COALESCE(NULLIF(tier,''),'durable') 对齐。 */
    tier: (() => { const s = String(r.tier ?? '').trim(); return MEMORY_TIERS[s] !== undefined ? s : 'durable'; })(),
    pinned: !!r.pinned,
    importance: Number(r.importance) || 0,
    hits: Number(r.hits) || 0,
    lastUsedAt: Number(r.last_used_at) || 0,
    expiresAt: Number(r.expires_at) || 0,
    convKey: r.conv_key || '',
    tags: r.tags || '',
    source: r.source || '',
  };
}

/**
 * 写一条记忆（幂等去重：同 uid+category+content 只留一条，重复写只累加 hits / 刷新时间）。
 * @param {{uid?:string, category?:string, content:string, tier?:string, pinned?:boolean,
 *          importance?:number, ttlMs?:number, convKey?:string, tags?:string, source?:string}} o
 */
export function rememberEntry(o = {}) {
  const db = initMemoryDb();
  if (!db) return { ok: false, error: '记忆库不可用' };
  const content = String(o.content ?? '').trim();
  if (!content) return { ok: false, error: 'content 不能为空' };
  const category = String(o.category ?? 'note').trim().slice(0, 40) || 'note';
  const uid = String(o.uid ?? '').trim();
  const tier = normTier(o.tier, { pinned: o.pinned === true, category });
  const pinned = tier === 'permanent' ? 1 : (o.pinned ? 1 : 0);
  const ttl = Number(o.ttlMs);
  const expiresAt = Number.isFinite(ttl) && ttl > 0
    ? Date.now() + ttl
    : (MEMORY_TIERS[tier] || 0) > 0 ? Date.now() + MEMORY_TIERS[tier] : 0;
  const now = Date.now();
  const row = {
    uid, category, content: content.slice(0, 4000), tier,
    pinned, importance: Math.max(0, Math.min(100, Number(o.importance) || 0)),
    expiresAt, convKey: String(o.convKey ?? '').slice(0, 120),
    tags: String(o.tags ?? '').slice(0, 200), source: String(o.source ?? '').slice(0, 40),
  };
  try {
    const hit = db.prepare('SELECT id, hits FROM memory_entries WHERE uid = ? AND category = ? AND content = ? LIMIT 1')
      .get(row.uid, row.category, row.content);
    if (hit) {
      /* 【2026-09-22 修 M12】去重时**不能拿本次调用的值覆盖更强的旧值**：旧写法直接把 tier/pinned/
       * expires_at 写成这次归一化的结果，于是"把同一句话再记一遍"会把一条 permanent（永不过期、每轮
       * 都进 [Recall]）**降级成 durable（90 天）**。现在三个字段都取"更强的那一边"：
       *   tier：任一边 permanent 就是 permanent；pinned 取 MAX；
       *   expires_at：0 = 永不过期 → 任一边为 0 就是 0，否则取更晚的那个（绝不缩短寿命）。 */
      db.prepare(`UPDATE memory_entries SET hits = hits + 1, updated_at = ?, last_used_at = ?,
        tier = CASE WHEN tier = 'permanent' OR ? = 'permanent' THEN 'permanent' ELSE ? END,
        pinned = MAX(pinned, ?),
        importance = MAX(importance, ?),
        expires_at = CASE WHEN tier = 'permanent' OR ? = 'permanent' THEN 0
                          WHEN expires_at = 0 OR ? = 0 THEN 0
                          ELSE MAX(expires_at, ?) END
        WHERE id = ?`)
        .run(now, now, row.tier, row.tier, row.pinned, row.importance, row.tier, row.expiresAt, row.expiresAt, Number(hit.id));
      return { ok: true, id: Number(hit.id), deduped: true, tier: row.tier };
    }
    const info = db.prepare(`INSERT INTO memory_entries
      (uid, category, content, created_at, updated_at, tier, pinned, importance, expires_at, conv_key, tags, source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.uid, row.category, row.content, now, now, row.tier, row.pinned, row.importance, row.expiresAt, row.convKey, row.tags, row.source);
    return { ok: true, id: Number(info.lastInsertRowid), deduped: false, tier: row.tier };
  } catch (error) {
    log(`[memory] 写记忆失败: ${error?.message ?? error}`);
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** 置顶/取消置顶（置顶 = permanent 层：永不过期，且进每轮摘要） */
export function setMemoryPinned(id, pinned = true) {
  const db = initMemoryDb();
  if (!db) return { ok: false, error: '记忆库不可用' };
  try {
    /* 【2026-09-22 修 M13】取消置顶时必须**把 tier 也降回来**：旧写法 `ELSE tier` 会把 permanent 层留着，
     * 于是"取消置顶"之后这条记忆仍然每轮进 [Recall] 摘要，而且 pruneExpiredMemory 明确排除
     * tier='permanent' → 永远清不掉（界面动作与库内语义不一致）。现在取消置顶 = 回到 durable 层，
     * 并给它一个正常的过期时间（TTL 取 durable 档）。 */
    const info = db.prepare("UPDATE memory_entries SET pinned = ?, "
      + "tier = CASE WHEN ? = 1 THEN 'permanent' ELSE 'durable' END, "
      + "expires_at = CASE WHEN ? = 1 THEN 0 ELSE ? END, updated_at = ? WHERE id = ?")
      .run(pinned ? 1 : 0, pinned ? 1 : 0, pinned ? 1 : 0,
        Date.now() + (Number(MEMORY_TIERS.durable) || 0), Date.now(), Number(id));
    return { ok: true, updated: Number(info.changes) || 0 };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** 列表/检索记忆条目。query 有值走 FTS5（BM25 排序），否则按层级+重要性+时间排。 */
export function listMemoryEntries(opts = {}) {
  const db = initMemoryDb();
  if (!db) return { ok: false, error: '记忆库不可用', entries: [] };
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 30));
  const where = [];
  const params = [];
  if (opts.uid) { where.push('uid = ?'); params.push(String(opts.uid)); }
  if (opts.category) { where.push('category = ?'); params.push(String(opts.category)); }
  if (opts.convKey) { where.push('conv_key = ?'); params.push(String(opts.convKey)); }
  if (opts.tier) { where.push('tier = ?'); params.push(String(opts.tier)); }
  if (!opts.includeExpired) { where.push('(expires_at = 0 OR expires_at > ?)'); params.push(Date.now()); }
  const ftsQ = opts.query ? ftsQueryOf(opts.query) : '';
  try {
    if (ftsQ && ftsUsable(db, 'mem_fts')) {
      const conds = [...where, 'mem_fts MATCH ?'];
      const rows = db.prepare(
        `SELECT memory_entries.* FROM memory_entries JOIN mem_fts ON mem_fts.rowid = memory_entries.id
         WHERE ${conds.join(' AND ')} ORDER BY bm25(mem_fts) ASC LIMIT ?`
      ).all(...params, ftsQ, limit);
      return { ok: true, ranked: true, entries: rows.map(rowToMemoryEntry) };
    }
    if (opts.query) { where.push('content LIKE ?'); params.push('%' + String(opts.query) + '%'); }
    const rows = db.prepare(
      `SELECT * FROM memory_entries${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
       ORDER BY pinned DESC, importance DESC, COALESCE(updated_at, created_at) DESC LIMIT ?`
    ).all(...params, limit);
    return { ok: true, entries: rows.map(rowToMemoryEntry) };
  } catch (error) {
    log(`[memory] 读记忆失败: ${error?.message ?? error}`);
    return { ok: false, error: error?.message ?? String(error), entries: [] };
  }
}

/** 记账：这些条目刚被用到（hits+1、last_used_at=now），供重要性排序与"老忘不掉"的自愈。 */
export function touchMemoryEntries(ids = []) {
  const db = initMemoryDb();
  if (!db) return { ok: false };
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite);
  if (!list.length) return { ok: true, touched: 0 };
  try {
    const now = Date.now();
    const st = db.prepare('UPDATE memory_entries SET hits = hits + 1, last_used_at = ? WHERE id = ?');
    let n = 0;
    for (const id of list) n += Number(st.run(now, id).changes) || 0;
    return { ok: true, touched: n };
  } catch { return { ok: false }; }
}

/** 清掉过期的短期记忆（桥启动时与每天定时各跑一次；permanent 永不被清）。 */
export function pruneExpiredMemory() {
  const db = initMemoryDb();
  if (!db) return { ok: false, deleted: 0 };
  try {
    const info = db.prepare("DELETE FROM memory_entries WHERE pinned = 0 AND tier != 'permanent' AND expires_at > 0 AND expires_at <= ?").run(Date.now());
    const n = Number(info.changes) || 0;
    if (n > 0) log(`[memory] 清理过期记忆 ${n} 条`);
    return { ok: true, deleted: n };
  } catch (error) {
    return { ok: false, deleted: 0, error: error?.message ?? String(error) };
  }
}

/**
 * 每轮注入的**记忆摘要**（永久层 + 与该会话/该人相关的高重要度条目）。
 *
 * 为什么是"摘要"而不是"全部"：系统提示词/唤醒正文里的每一个字符都是**每一步**都要付钱重读的。
 * 把永久记忆压到几百字符、并且**内容稳定**（同样输入 → 逐字节相同的输出），既能保证"永远记得"，
 * 又不破坏前缀缓存。排序完全确定（pinned → importance → 时间），不掺随机数。
 *
 * @param {{uid?:string, convKey?:string, limit?:number, maxChars?:number}} o
 */
export function memoryDigest(o = {}) {
  const db = initMemoryDb();
  if (!db) return '';
  /* 【2026-09-22 修 M15】过期行以前**永远不会被删**：pruneExpiredMemory 全仓只有 import、没有调用点。
   * 这里顺手清一次就够（摘要本来就每轮唤醒都会跑），但按小时节流，别每次唤醒都扫一遍表。 */
  try {
    const last = Number(memoryDigest._lastPruneAt) || 0;
    if (Date.now() - last > 3600_000) {
      memoryDigest._lastPruneAt = Date.now();
      const pr = pruneExpiredMemory();
      if (pr?.ok && pr.removed > 0) log(`[memory] 清理过期记忆 ${pr.removed} 条`);
    }
  } catch { /* 清理失败不影响摘要 */ }
  const limit = Math.max(1, Math.min(30, Number(o.limit) || 12));
  const maxChars = Math.max(120, Math.min(4000, Number(o.maxChars) || 700));
  const now = Date.now();
  try {
    const rows = db.prepare(`
      SELECT * FROM memory_entries
      WHERE (pinned = 1 OR tier = 'permanent' OR category IN ('rule','owner','identity','persona'))
        AND (expires_at = 0 OR expires_at > ?)
        AND (uid = ? OR uid = '' OR ? = '')
      ORDER BY pinned DESC, importance DESC, COALESCE(updated_at, created_at) DESC
      LIMIT ?`).all(now, String(o.uid ?? ''), String(o.uid ?? ''), limit);
    const others = db.prepare(`
      SELECT * FROM memory_entries
      WHERE pinned = 0 AND tier != 'permanent' AND category NOT IN ('rule','owner','identity','persona')
        AND (expires_at = 0 OR expires_at > ?) AND (uid = ? OR uid = '' OR ? = '')
      ORDER BY importance DESC, COALESCE(updated_at, created_at) DESC LIMIT ?`)
      .all(now, String(o.uid ?? ''), String(o.uid ?? ''), limit);
    const list = [...rows, ...others];
    if (!list.length) return '';
    const seen = new Set();
    const lines = [];
    let used = 0;
    for (const r of list) {
      const e = rowToMemoryEntry(r);
      const key = `${e.category}|${e.content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const tag = e.pinned || e.tier === 'permanent' ? '★' : e.category;
      const line = `- [${tag}] ${e.content.replace(/\s+/g, ' ').slice(0, 140)}`;
      if (used + line.length > maxChars) break;
      used += line.length + 1;
      lines.push(line);
    }
    return lines.join('\n');
  } catch (error) {
    log(`[memory] 记忆摘要生成失败: ${error?.message ?? error}`);
    return '';
  }
}

/** 记忆库规模/索引状态（诊断与管理端展示用） */
export function memoryStats() {
  const db = initMemoryDb();
  if (!db) return { ok: false };
  const one = (sql, ...p) => { try { return Number(db.prepare(sql).get(...p)?.c || 0); } catch { return 0; } };
  const meta = (k) => { try { return db.prepare('SELECT v FROM memory_meta WHERE k = ?').get(k)?.v ?? ''; } catch { return ''; } };
  return {
    ok: true,
    profiles: one('SELECT COUNT(*) AS c FROM profiles'),
    entries: one('SELECT COUNT(*) AS c FROM memory_entries'),
    permanent: one("SELECT COUNT(*) AS c FROM memory_entries WHERE pinned = 1 OR tier = 'permanent'"),
    chat: one('SELECT COUNT(*) AS c FROM chat_messages'),
    ftsChat: ftsUsable(db, 'chat_fts') ? one('SELECT COUNT(*) AS c FROM chat_fts') : -1,
    ftsMem: ftsUsable(db, 'mem_fts') ? one('SELECT COUNT(*) AS c FROM mem_fts') : -1,
    ftsVersion: meta('fts_version'),
    ftsRebuiltAt: Number(meta('fts_rebuilt_at')) || 0,
  };
}

