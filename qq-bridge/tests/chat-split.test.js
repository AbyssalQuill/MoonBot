// 聊天记录从 memory.db 拆到独立库 chat.db 的回归锁 —— 2026-09-24 架构改动
//
// 改动前：profiles / memory_entries / chat_messages（+ chat_fts / chat_convs / chat_stats）全都挤在
//   state/memory.db 里，memory.js 一个模块既管记忆又管聊天记录。
// 改动后：聊天记录（chat_messages + chat_fts 索引 + chat_convs 会话汇总 + chat_stats 总量计数 +
//   chat_meta 元信息）搬进 **state/chat.db**，由 core/chat-db.js 独占；memory.js 只管记忆档案
//   （state/memory.db：profiles / memory_entries / memory_meta / mem_fts），并把聊天函数**原样 re-export**
//   （调用方零改动的既定口径），rebuildMemoryFts() 名字与调用方式不变：内部重建 mem_fts + 委托 rebuildChatFts()。
// 首次启动把老 memory.db 里的 chat_messages 一次性搬进 chat.db（条数核对一致后才 DROP 老表）。
//
// 本文件把拆库后的六条硬性质钉死：
//   ① 计数：群/私聊、入向/自发写入后 chatCounters() 的 total / privateTotal / groupTotal /
//      sentTotal / receivedTotal / todaySent / convTotal 与真实条数一致；
//   ② 会话列表：chatConvList() 的会话条数、sent / received、lastText（管理端「聊天记录」页左栏）；
//   ③ 全量可搜：rebuildMemoryFts() 之后 searchChatMessages({query}) 真的走 FTS（ranked=true）且能命中，
//      chatDbStats().fts.complete === true（indexed 与 total 相等）；
//   ④ 删除后计数被重算：clearChatHistory(key) / deleteChatMessages({ids}) 之后计数不虚高（对真实 COUNT 核对），
//      被删的行也不再能搜到（FTS 同步）；
//   ⑤ 存量迁移：老 memory.db 里的 chat_messages 被搬进 chat.db、老库不再有 chat_messages 表、profiles 完好；
//   ⑥ 文件边界：聊天记录落在**沙箱** state/chat.db（不是仓库那份），跑完仓库真实 state 指纹与目录清单不变。
//
// 完全离线：不起服务、不发网络请求、不连 NapCat、不起桥进程。只 import 沙箱里的一份 src 副本，
// state 落在系统临时目录，跑完删掉（真实 qq-bridge/state/ 全程只读，末尾用 hash 自证没被动过）。
//
// 跑法：node tests/chat-split.test.js

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');                       // qq-bridge/
const REAL_STATE = path.join(REPO, 'state');

/* ── 真实 state 指纹（末尾自证"没污染真数据"：拆库后要同时看 memory.db 与 chat.db）── */
const fingerprint = (f) => {
  try {
    const st = fs.statSync(f);
    return `${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}|${st.size}|${st.mtimeMs}`;
  } catch { return 'MISSING'; }
};
const realBefore = {
  memory: fingerprint(path.join(REAL_STATE, 'memory.db')),
  chat: fingerprint(path.join(REAL_STATE, 'chat.db')),
  crosschat: fingerprint(path.join(REAL_STATE, 'crosschat.json')),
};
/* 目录清单比对（只读自证）：并行跑 `node --test` 时，兄弟测试文件会在 state/ 下建自己的临时沙箱目录
 * （例如 tests/pixiv-source-order.test.js 的 state/.tmp-pixiv-order-test），它与本改动无关、且会自行清理。
 * 比对时把这些 `.tmp-*` 项剔除，剩下的"真实 state 数据"一项都不许增删。 */
const stateListing = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith('.tmp-')).sort().join(',') : 'MISSING');
const realListingBefore = stateListing(REAL_STATE);

/* ── 沙箱 ──────────────────────────────────────────────────────────────────
 * chat-db.js / memory.js 都通过 lib/paths.js 的 ROOT（= src/lib 往上两级）推导 state 目录，
 * 所以把 src 复制一份进沙箱，沙箱里的 paths.js 就会把 STATE_DIR 指到 <沙箱>/state。
 * 与 tests/memory-fts.test.js / tests/crosschat.test.js 的做法一致。 */
function makeSandbox(tag) {
  const dir = path.join(os.tmpdir(), `.tmp-${tag}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.cpSync(path.join(REPO, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `qbh-${tag}-sandbox`, private: true, type: 'module' }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ownerQQ: '123456789', allowAllWhenEmpty: true, social: {} }));
  return dir;
}

const sandbox = makeSandbox('chatsplit');                    // 沙箱 ①：常规读写
const SANDBOX_STATE = path.join(sandbox, 'state');
const SANDBOX_CHAT_DB = path.join(SANDBOX_STATE, 'chat.db');
const SANDBOX_MEM_DB = path.join(SANDBOX_STATE, 'memory.db');

const legacySandbox = makeSandbox('chatsplit-legacy');       // 沙箱 ②：老库迁移
const LEGACY_STATE = path.join(legacySandbox, 'state');
const LEGACY_MEM_DB = path.join(LEGACY_STATE, 'memory.db');
const LEGACY_CHAT_DB = path.join(LEGACY_STATE, 'chat.db');

/* 老式 memory.db：迁移发生在这个库第一次被 chat-db 打开时（initChatDb → migrateChatHistoryFromMemoryDb），
 * 所以必须**在 import 模块之前**把老库摆好。
 *
 * 列口径：老表的 CREATE TABLE 只到 ts_ms，qq_seq / read_at / recalled_at 三列是旧版 memory.js 用
 * `ALTER TABLE chat_messages ADD COLUMN …` 补出来的（见改动前的 initMemoryDb），而迁移的
 * `INSERT … SELECT` 会把这 16 列一起读走 —— 所以"老库真实形态"含这三列，这里照真实形态建。 */
const LEGACY_ROWS = [
  // conv_key, msg_seq, message_id, sender_uid, sender_name, is_self, direction, content
  ['group:888001', 1, 'lg-1', '20001', '老群友', 0, 'in', '老群里聊到电影票有点贵'],
  ['group:888001', 2, 'lg-2', '20002', '老群友乙', 0, 'in', '老群里第二句'],
  ['private:777001', 3, 'lg-3', '30001', '老私聊对象', 0, 'in', '老私聊里的一句话'],
];
{
  const db = new DatabaseSync(LEGACY_MEM_DB);
  try {
    db.exec(`CREATE TABLE chat_messages (
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
    db.exec('ALTER TABLE chat_messages ADD COLUMN qq_seq INTEGER DEFAULT 0');
    db.exec('ALTER TABLE chat_messages ADD COLUMN read_at INTEGER DEFAULT 0');
    db.exec('ALTER TABLE chat_messages ADD COLUMN recalled_at INTEGER DEFAULT 0');
    // 老库里的记忆档案：迁移只该动 chat_messages，profiles 必须原样留着
    db.exec("CREATE TABLE profiles (uid TEXT PRIMARY KEY, name TEXT DEFAULT '', notes TEXT DEFAULT '', updated_at INTEGER DEFAULT 0)");
    db.exec("INSERT INTO profiles (uid, name, notes) VALUES ('10001', '马卡龙', '老库里就有的档案')");
    db.exec("INSERT INTO profiles (uid, name, notes) VALUES ('10002', '坐忘道', '')");
    const ins = db.prepare(`INSERT INTO chat_messages
      (conv_key, msg_seq, message_id, sender_uid, sender_name, is_self, direction, kind, content, ts, ts_ms)
      VALUES (?,?,?,?,?,?,?, 'text', ?, '2026-09-23 10:00:00', ?)`);
    let n = 0;
    for (const [ck, seq, mid, uid, nm, self, dir, content] of LEGACY_ROWS) {
      n += 1;
      ins.run(ck, seq, mid, uid, nm, self, dir, content, Date.parse('2026-09-23T10:00:00+08:00') + n * 1000);
    }
  } finally { try { db.close(); } catch { /* 已关 */ } }
}

/* ── 模块加载 ─────────────────────────────────────────────────────────────── */
const mem = await import(pathToFileURL(path.join(sandbox, 'src', 'core', 'memory.js')).href);
const chatDbMod = await import(pathToFileURL(path.join(sandbox, 'src', 'core', 'chat-db.js')).href);

let fails = 0;
const check = (name, fn) => {
  try { fn(); console.log('PASS  ' + name); }
  catch (e) { fails += 1; console.log('FAIL  ' + name + '  ' + (e?.message ?? e)); }
};

const GROUP = 'group:600100';
const PRIVATE = 'private:700200';
const T0 = Date.now();                       // 所有行同一天（todayTotal/todaySent 才是确定的）

let seq = 0;
/** 落一条消息（= 桥运行时写库的那条路径，走 memory.js 的 re-export）。 */
const put = (convKey, text, opts = {}) => {
  seq += 1;
  mem.persistChatMessage(convKey, {
    time: T0,
    text,
    plain: text,
    isSelf: !!opts.isSelf,
    userId: opts.isSelf ? 'self' : String(opts.uid ?? '900000001'),
    sender: opts.isSelf ? '' : (opts.sender ?? '群友甲'),
    messageId: `cs-${seq}`,
  });
};
/** 库里真实条数（绕过计数表，用来核对计数不是虚高的）。 */
const realCount = (where = '', ...args) =>
  Number(chatDbMod.chatDb.prepare(`SELECT COUNT(*) AS c FROM chat_messages${where ? ' WHERE ' + where : ''}`).get(...args)?.c || 0);

// ── ① 计数：群 + 私聊、入向 + 自发 ───────────────────────────────────────────
check('① 写入 5 条（群 3 + 私聊 2，入向 3 + 自发 2）后 chatCounters() 全对', () => {
  put(GROUP, '群里第一条：电影票真贵');
  put(GROUP, '群里第二条', { sender: '群友乙' });
  put(GROUP, '群里第三条（我发的）', { isSelf: true });
  put(PRIVATE, '私聊第一条');
  put(PRIVATE, '私聊第二条（我发的）', { isSelf: true });
  const c = mem.chatCounters();
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(c.total, 5, `total 应为 5：${JSON.stringify(c)}`);
  assert.equal(c.groupTotal, 3, `群聊 3 条：${JSON.stringify(c)}`);
  assert.equal(c.privateTotal, 2, `私聊 2 条：${JSON.stringify(c)}`);
  assert.equal(c.sentTotal, 2, `自发 2 条：${JSON.stringify(c)}`);
  assert.equal(c.receivedTotal, 3, `入向 3 条：${JSON.stringify(c)}`);
  assert.equal(c.todayTotal, 5, `今日 5 条：${JSON.stringify(c)}`);
  assert.equal(c.todaySent, 2, `今日自发 2 条：${JSON.stringify(c)}`);
  assert.equal(c.convTotal, 2, `2 个会话：${JSON.stringify(c)}`);
  assert.equal(c.groupConvs, 1, `1 个群会话：${JSON.stringify(c)}`);
  assert.equal(c.privateConvs, 1, `1 个私聊会话：${JSON.stringify(c)}`);
  // 增量维护的口径必须与真实条数一致（计数是"一查便知"的快路径，错了就是管理端看到的数字错）
  assert.equal(c.total, realCount(), '计数表的 total 与真实条数不一致');
  assert.equal(c.sentTotal, realCount("direction = 'out'"), 'sentTotal 与真实自发条数不一致');
});

// ── ② 会话列表（管理端左栏）─────────────────────────────────────────────────
check('② chatConvList()：2 个会话，sent/received 与 lastText 正确', () => {
  const list = mem.chatConvList({ kind: 'all', limit: 50 });
  assert.equal(list.ok, true, JSON.stringify(list).slice(0, 200));
  assert.equal(list.total, 2, `应有 2 个会话：${JSON.stringify(list).slice(0, 200)}`);
  assert.equal(list.convs.length, 2, JSON.stringify(list.convs));
  const g = list.convs.find((c) => c.key === GROUP);
  const p = list.convs.find((c) => c.key === PRIVATE);
  assert.ok(g && p, `两个会话都要在：${JSON.stringify(list.convs)}`);
  assert.equal(g.kind, 'group', JSON.stringify(g));
  assert.equal(g.count, 3, JSON.stringify(g));
  assert.equal(g.sent, 1, `群会话自发 1 条：${JSON.stringify(g)}`);
  assert.equal(g.received, 2, `群会话入向 2 条：${JSON.stringify(g)}`);
  assert.equal(g.lastText, '群里第三条（我发的）', `最后一条摘要：${JSON.stringify(g)}`);
  assert.equal(g.name, '群友乙', `会话名取最后一条"有昵称"的发送者：${JSON.stringify(g)}`);
  assert.equal(p.kind, 'private', JSON.stringify(p));
  assert.equal(p.count, 2, JSON.stringify(p));
  assert.equal(p.sent, 1, JSON.stringify(p));
  assert.equal(p.received, 1, JSON.stringify(p));
  assert.equal(p.lastText, '私聊第二条（我发的）', JSON.stringify(p));
  // 分类型过滤也要成立（管理端左栏的群/私聊页签）
  assert.equal(mem.chatConvList({ kind: 'group' }).convs.length, 1, 'kind=group 只该剩群会话');
  assert.equal(mem.chatConvList({ kind: 'private' }).convs.length, 1, 'kind=private 只该剩私聊会话');
});

// ── ③ 全量可搜（FTS）────────────────────────────────────────────────────────
check('③ rebuildMemoryFts() 后 searchChatMessages 走 FTS（ranked=true）且能命中', () => {
  const r = mem.rebuildMemoryFts({ reason: 'chat-split-test' });
  assert.ok(r, 'rebuildMemoryFts 无返回');
  assert.ok(r.rebuilt.includes('chat_fts'), `聊天记录索引也要一起重建：${JSON.stringify(r)}`);
  const q = mem.searchChatMessages({ query: '电影票', limit: 10 });
  assert.equal(q.ranked, true, '仍没走 FTS 分支（静默退回 LIKE）：' + JSON.stringify(q).slice(0, 200));
  assert.ok(q.messages.length >= 1, `应命中：${JSON.stringify(q).slice(0, 200)}`);
  assert.equal(q.messages[0].convKey, GROUP, '命中的应是群里那条');
  assert.ok(q.messages[0].content.includes('电影票'), `命中内容：${JSON.stringify(q.messages[0])}`);
  // 同一会话过滤 + query 一起用（FTS 分支里 convKey 也要成立）
  assert.ok(mem.searchChatMessages({ query: '电影票', convKey: GROUP }).messages.length >= 1, 'convKey 过滤后仍该命中');
  assert.equal(mem.searchChatMessages({ query: '电影票', convKey: 'group:999' }).messages.length, 0, '别的会话不该命中');
});

check('③b chatDbStats().fts.complete === true（indexed 与 total 相等 = 全量可搜）', () => {
  const st = mem.chatDbStats();
  assert.equal(st.ok, true, JSON.stringify(st).slice(0, 200));
  assert.equal(st.fts.ok, true, `FTS 索引可用：${JSON.stringify(st.fts)}`);
  assert.equal(st.fts.indexed, st.total, `索引条数应等于消息总数：${JSON.stringify(st.fts)} vs total=${st.total}`);
  assert.equal(st.fts.complete, true, `应报"全量可搜"：${JSON.stringify(st.fts)}`);
  // 库文件与老库路径都要指向沙箱
  assert.equal(st.dbPath, SANDBOX_CHAT_DB, `聊天记录库应在沙箱：${st.dbPath}`);
  assert.equal(st.memoryDbPath, SANDBOX_MEM_DB, `记忆库路径应是沙箱里的 memory.db：${st.memoryDbPath}`);
  assert.ok(fs.existsSync(SANDBOX_CHAT_DB), '沙箱里应已生成 chat.db');
});

// ── ④ 删除后计数被重算（不是虚高）───────────────────────────────────────────
check('④a clearChatHistory(群会话)：删掉 3 条后计数整体重算', () => {
  const clr = mem.clearChatHistory(GROUP);
  assert.equal(clr.ok, true, JSON.stringify(clr));
  assert.equal(clr.deleted, 3, `应删掉 3 条：${JSON.stringify(clr)}`);
  const c = mem.chatCounters();
  assert.equal(c.total, 2, `total 应回到 2：${JSON.stringify(c)}`);
  assert.equal(c.groupTotal, 0, `群聊应清零：${JSON.stringify(c)}`);
  assert.equal(c.privateTotal, 2, JSON.stringify(c));
  assert.equal(c.sentTotal, 1, `只剩私聊那条自发：${JSON.stringify(c)}`);
  assert.equal(c.receivedTotal, 1, JSON.stringify(c));
  assert.equal(c.todayTotal, 2, JSON.stringify(c));
  assert.equal(c.todaySent, 1, JSON.stringify(c));
  assert.equal(c.convTotal, 1, `会话应只剩 1 个：${JSON.stringify(c)}`);
  assert.equal(c.total, realCount(), '重算后的 total 与真实条数不一致');
  assert.equal(c.convTotal, Number(chatDbMod.chatDb.prepare('SELECT COUNT(*) AS c FROM chat_convs').get()?.c || 0), '会话汇总表条数不一致');
  // 删掉的行不该还能搜到（chat_fts 靠触发器同步）
  const q = mem.searchChatMessages({ query: '电影票', limit: 10 });
  assert.equal(q.messages.length, 0, `已删除的消息不该还能搜到：${JSON.stringify(q).slice(0, 200)}`);
});

check('④b deleteChatMessages({ids})：按 id 删 1 条后计数同样被重算', () => {
  const rows = mem.searchChatMessages({ convKey: PRIVATE, limit: 10 }).messages;
  const outRow = rows.find((m) => m.isSelf);
  assert.ok(outRow, `前置条件：应能读到私聊里那条自发消息：${JSON.stringify(rows.map((m) => [m.id, m.content]))}`);
  const del = mem.deleteChatMessages({ ids: [outRow.id] });
  assert.equal(del.ok, true, JSON.stringify(del));
  assert.equal(del.deleted, 1, JSON.stringify(del));
  const c = mem.chatCounters();
  assert.equal(c.total, 1, `total 应剩 1：${JSON.stringify(c)}`);
  assert.equal(c.privateTotal, 1, JSON.stringify(c));
  assert.equal(c.sentTotal, 0, `自发那条已删：${JSON.stringify(c)}`);
  assert.equal(c.receivedTotal, 1, JSON.stringify(c));
  assert.equal(c.todaySent, 0, JSON.stringify(c));
  assert.equal(c.convTotal, 1, JSON.stringify(c));
  assert.equal(c.total, realCount(), '删除后 total 与真实条数不一致');
});

check('④c clearChatHistory() 全清：计数与会话汇总一起归零，不残留虚高数字', () => {
  const clr = mem.clearChatHistory();
  assert.equal(clr.ok, true, JSON.stringify(clr));
  assert.equal(clr.deleted, 1, JSON.stringify(clr));
  const c = mem.chatCounters();
  for (const k of ['total', 'privateTotal', 'groupTotal', 'sentTotal', 'receivedTotal', 'todayTotal', 'todaySent', 'convTotal']) {
    assert.equal(c[k], 0, `全清后 ${k} 应为 0：${JSON.stringify(c)}`);
  }
  assert.equal(realCount(), 0, '库里的消息行应已清空');
  assert.equal(Number(chatDbMod.chatDb.prepare('SELECT COUNT(*) AS c FROM chat_convs').get()?.c || 0), 0, 'chat_convs 也应清空');
});

// ── ⑤ 存量迁移：老 memory.db → chat.db ──────────────────────────────────────
{
  const memLegacy = await import(pathToFileURL(path.join(legacySandbox, 'src', 'core', 'memory.js')).href);
  const chatDbLegacy = await import(pathToFileURL(path.join(legacySandbox, 'src', 'core', 'chat-db.js')).href);

  check('⑤ 迁移：老 memory.db 的 3 条聊天记录搬进 chat.db', () => {
    const c = memLegacy.chatCounters();          // 第一次读 → initChatDb → 触发一次性迁移
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.equal(c.total, LEGACY_ROWS.length, `老库里的 ${LEGACY_ROWS.length} 条应全部搬过来：${JSON.stringify(c)}`);
    assert.equal(c.groupTotal, 2, JSON.stringify(c));
    assert.equal(c.privateTotal, 1, JSON.stringify(c));
    assert.equal(c.convTotal, 2, `2 个老会话：${JSON.stringify(c)}`);
    assert.equal(Number(chatDbLegacy.chatDb.prepare('SELECT COUNT(*) AS c FROM chat_messages').get()?.c || 0), LEGACY_ROWS.length,
      'chat.db 里的行数应等于老库原条数');
    assert.ok(fs.existsSync(LEGACY_CHAT_DB), '沙箱里应已生成 chat.db');
  });

  check('⑤b 老库不再有 chat_messages 表（真分家：memory.db 不再背那张大表）', () => {
    const st = memLegacy.chatDbStats();
    assert.equal(st.legacyRows, 0, `老库里的聊天表应已被 DROP：legacyRows=${st.legacyRows}`);
    const ldb = new DatabaseSync(LEGACY_MEM_DB, { readOnly: true, timeout: 500 });
    try {
      const has = ldb.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'chat_messages'").get();
      assert.ok(!has, '迁移之后 memory.db 里不该还有 chat_messages 表');
      const fts = ldb.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'chat_fts'").get();
      assert.ok(!fts, 'FTS 影子表/索引对象也该一起清掉');
    } finally { try { ldb.close(); } catch { /* 已关 */ } }
  });

  check('⑤c 迁移过来的行真的可搜（迁移后自动重建索引）+ profiles 数据完好', () => {
    const st = memLegacy.chatDbStats();
    assert.equal(st.fts.complete, true, `迁移后应全量可搜：${JSON.stringify(st.fts)}`);
    const q = memLegacy.searchChatMessages({ query: '电影票', limit: 10 });
    assert.equal(q.ranked, true, JSON.stringify(q).slice(0, 200));
    assert.ok(q.messages.length >= 1, `迁移过来的老消息应能搜到：${JSON.stringify(q).slice(0, 200)}`);
    assert.equal(q.messages[0].convKey, 'group:888001', JSON.stringify(q.messages[0]));
    // 记忆档案必须没被动过（迁移只该动聊天表）
    assert.equal(memLegacy.getProfile('10001')?.name, '马卡龙', '老库 profiles 里的档案应完好');
    assert.equal(memLegacy.getProfile('10001')?.notes, '老库里就有的档案', 'profiles 其它字段也要在');
    assert.equal(memLegacy.getProfile('10002')?.name, '坐忘道', '另一行档案也要在');
    const ldb = new DatabaseSync(LEGACY_MEM_DB, { readOnly: true, timeout: 500 });
    try {
      assert.equal(Number(ldb.prepare('SELECT COUNT(*) AS c FROM profiles').get()?.c || 0), 2, 'profiles 行数应仍是 2');
    } finally { try { ldb.close(); } catch { /* 已关 */ } }
  });
}

// ── ⑥ 文件边界 / 隔离自证 ───────────────────────────────────────────────────
check('⑥ 聊天记录库落在沙箱 state/chat.db，不是仓库那份', () => {
  assert.equal(chatDbMod.chatDbFile(), SANDBOX_CHAT_DB, 'chatDbFile() 应指向沙箱');
  assert.notEqual(chatDbMod.chatDbFile(), path.join(REAL_STATE, 'chat.db'), '绝不能是仓库真实 state/chat.db');
  assert.equal(chatDbMod.legacyMemoryDbFile(), SANDBOX_MEM_DB, '老库路径也应是沙箱里的');
  assert.ok(fs.existsSync(SANDBOX_CHAT_DB), '沙箱里应已生成 chat.db');
});

check('⑥b 反证：沙箱 memory.db 里没有 chat_messages（聊天记录确实搬走了）', () => {
  mem.initMemoryDb();                     // 显式把记忆库建出来，好断言它里面没有聊天表
  assert.ok(fs.existsSync(SANDBOX_MEM_DB), '记忆库应能在沙箱里建出来');
  const db = new DatabaseSync(SANDBOX_MEM_DB, { readOnly: true, timeout: 500 });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name));
    assert.ok(!tables.includes('chat_messages'), `memory.db 里不该再有 chat_messages：${tables.join(',')}`);
    assert.ok(!tables.includes('chat_fts'), `memory.db 里不该再有 chat_fts：${tables.join(',')}`);
    assert.ok(tables.includes('profiles'), `记忆档案表应还在：${tables.join(',')}`);
  } finally { try { db.close(); } catch { /* 已关 */ } }
});

check('⑥c 跑完仓库真实 state（memory.db + chat.db + crosschat.json）与目录清单都没变', () => {
  const after = {
    memory: fingerprint(path.join(REAL_STATE, 'memory.db')),
    chat: fingerprint(path.join(REAL_STATE, 'chat.db')),
    crosschat: fingerprint(path.join(REAL_STATE, 'crosschat.json')),
  };
  assert.equal(after.memory, realBefore.memory, `真实 state/memory.db 被动过了！before=${realBefore.memory} after=${after.memory}`);
  assert.equal(after.chat, realBefore.chat, `真实 state/chat.db 被动过了！before=${realBefore.chat} after=${after.chat}`);
  assert.equal(after.crosschat, realBefore.crosschat, `真实 state/crosschat.json 被动过了！before=${realBefore.crosschat} after=${after.crosschat}`);
  const listingAfter = stateListing(REAL_STATE);
  assert.equal(listingAfter, realListingBefore, '真实 state 目录的文件清单被动过了');
});

// ── 收尾 ────────────────────────────────────────────────────────────────────
for (const dir of [sandbox, legacySandbox]) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上偶尔删不掉，在临时目录里无所谓 */ }
}
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
