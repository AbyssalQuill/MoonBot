// recentMessagesAcrossSessions（跨会话"他处最近发生了什么"）的离线回归锁 —— 2026-09-30 新增
//
// 这是跨会话架构从"文件摘要"改为"直接查 SQLite chat_messages"后新增的只读查询函数。
// 它每轮唤醒都可能被调用一次，所以这里把五条硬性质钉死：
//   ① 空库 / 表还没建（桥从未运行过）→ 返回空数组，**不抛错**；
//   ② 时间窗过滤正确（窗口内的拿到、窗口外的拿不到）；
//   ③ 排除自身会话正确（excludeKey 的那条永远不出现）；
//   ④ 条数上限正确（limit 封顶）+ 同一会话只占一个名额（去重）；
//   ⑤ 参数化查询：注入串只被当成普通字符串，改不了 SQL 结构、也不删表。
// 另外覆盖②的可选过滤（convKey / sender）与返回结构（正文截到 200 字）与"只读"（跑完库文件字节不变）。
//
// 完全离线：只把 src 拷进临时沙箱再 import，state（chat.db 等）落在沙箱里；
// 跑完删掉，并用指纹自证仓库真实 state 没被动过。
//
// 2026-09-24 聊天记录拆分库后：这个函数查的是 **state/chat.db**（不再是 memory.db），
// 所以下面"沙箱里生成了那个库""只读不动库文件"的口径一律跟着看 chat.db；
// 仓库真实 state 的指纹则同时覆盖 memory.db 与 chat.db（两边都不能被碰）。
//
// 跑法：node tests/memory-cross-recent.test.js

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const REAL_STATE = path.join(REPO, 'state');

const sandbox = path.join(os.tmpdir(), `.tmp-crossrecent-${process.pid}`);
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.cpSync(path.join(REPO, 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-crossrecent-sandbox', private: true, type: 'module' }));

const SANDBOX_CHAT_DB = path.join(sandbox, 'state', 'chat.db');   // 聊天记录库：本文件读的就是它
const SANDBOX_MEM_DB = path.join(sandbox, 'state', 'memory.db');  // 记忆档案库：本文件不碰，只做隔离自证
const fingerprint = (f) => {
  try {
    const st = fs.statSync(f);
    return `${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}|${st.size}`;
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

const mem = await import(pathToFileURL(path.join(sandbox, 'src', 'core', 'memory.js')).href);
/* 聊天记录库句柄（state/chat.db）：本文件要断言"查的是哪个库文件"以及"表被删掉时函数不抛错"。
 * memory.js 并未导出 chat-db 的句柄，所以直接 import 同一个模块（同 URL = 同一个实例/单例）。 */
const chatDbMod = await import(pathToFileURL(path.join(sandbox, 'src', 'core', 'chat-db.js')).href);

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

const MIN = 60 * 1000;
const now = Date.now();
const SELF = 'group:100002';
const A = 'group:868756515';
const B = 'group:200001';
const C = 'group:200002';

let seq = 0;
const put = (convKey, tMs, name, text, opts = {}) => {
  seq += 1;
  mem.persistChatMessage(convKey, {
    time: tMs, text, plain: text, isSelf: !!opts.isSelf,
    userId: opts.isSelf ? 'self' : String(opts.uid ?? '900000001'),
    sender: opts.isSelf ? '' : name,
    messageId: `r-${seq}`,
  });
};

// ── ① 空库 / 库不可用 ───────────────────────────────────────────────────────
t('① 空库（会话表刚建、一条消息都没有）→ 空数组，不抛错', () => {
  const rows = mem.recentMessagesAcrossSessions(SELF, { now });
  assert.ok(Array.isArray(rows), `应返回数组，实际 ${JSON.stringify(rows)}`);
  assert.equal(rows.length, 0, `空库应为空，实际 ${JSON.stringify(rows)}`);
});

t('①b 缺省参数也不炸（excludeKey 给空串 / 不传 opts）', () => {
  assert.deepEqual(mem.recentMessagesAcrossSessions('', {}), []);
  assert.deepEqual(mem.recentMessagesAcrossSessions(), []);
});

// 造数据：A 会话 3 条（-30min / -20min / -5min），B 会话 1 条（-10min），C 会话 1 条（-3h，窗口外）
put(A, now - 30 * MIN, '马卡龙', 'A-半小时前');
put(A, now - 20 * MIN, '马卡龙', 'A-二十分钟前');
put(A, now - 5 * MIN, '坐忘道', 'A-五分钟前');
put(B, now - 10 * MIN, '星痕', 'B-十分钟前');
put(C, now - 180 * MIN, '老消息', 'C-三小时前');
put(SELF, now - MIN, '我自己', 'SELF-一分钟前');   // 自身会话：永远要被排除

// ── ② 时间窗 ────────────────────────────────────────────────────────────────
t('② 时间窗：默认 1 小时窗内拿得到、窗口外（3 小时前）拿不到', () => {
  const keys = new Set(mem.recentMessagesAcrossSessions(SELF, { now, limit: 10 }).map((r) => r.text));
  assert.ok(keys.has('A-五分钟前'), '窗口内的应拿到：' + JSON.stringify([...keys]));
  assert.ok(!keys.has('C-三小时前'), '3 小时前的必须被窗口挡掉：' + JSON.stringify([...keys]));
});

t('②b 时间窗可传：windowMs = 15 分钟就只剩 5 / 10 分钟那两条', () => {
  const texts = mem.recentMessagesAcrossSessions(SELF, { now, windowMs: 15 * MIN, limit: 10 }).map((r) => r.text).sort();
  assert.deepEqual(texts, ['A-五分钟前', 'B-十分钟前'], JSON.stringify(texts));
});

// ── ③ 排除自身会话 ──────────────────────────────────────────────────────────
t('③ excludeKey 的会话一条都不出现（自身会话不算"他处"）', () => {
  const rows = mem.recentMessagesAcrossSessions(SELF, { now, limit: 10 });
  assert.ok(!rows.some((r) => r.key === SELF), '自身会话不该出现：' + JSON.stringify(rows));
  assert.ok(!rows.some((r) => r.text === 'SELF-一分钟前'), '自身正文也不该出现');
  const all = mem.recentMessagesAcrossSessions('', { now, limit: 10 });
  assert.ok(all.some((r) => r.key === SELF), '不排除时自身会话应当查得到（证明排除真的在起作用）');
});

// ── ④ 条数上限 + 按会话去重 ─────────────────────────────────────────────────
t('④ limit 封顶：limit=2 只给 2 条，且来自 2 个不同会话（A 的 3 条只占 1 个名额）', () => {
  const rows = mem.recentMessagesAcrossSessions(SELF, { now, limit: 2 });
  assert.equal(rows.length, 2, `应恰好 2 条，实际 ${JSON.stringify(rows)}`);
  assert.deepEqual(rows.map((r) => r.text), ['A-五分钟前', 'B-十分钟前'], JSON.stringify(rows));
  assert.equal(new Set(rows.map((r) => r.key)).size, 2, '两个名额应落在两个不同会话上');
});

t('④b limit 越界一律夹紧（0/NaN → 默认 2；-1 → 1；999 → 最多 10）', () => {
  assert.equal(mem.recentMessagesAcrossSessions(SELF, { now, limit: 0 }).length, 2, 'limit=0 走默认 2（与仓库其它函数同一 `x || 默认` 口径）');
  assert.equal(mem.recentMessagesAcrossSessions(SELF, { now, limit: -1 }).length, 1, 'limit=-1 应夹到 1');
  const big = mem.recentMessagesAcrossSessions('', { now, limit: 999 });
  assert.ok(big.length <= 10, `limit 上限 10，实际 ${big.length}`);
});

t('④c 指定 convKey 时不按会话去重（要的就是这个会话的连续几条）', () => {
  const rows = mem.recentMessagesAcrossSessions(SELF, { now, convKey: A, limit: 3 });
  assert.equal(rows.length, 3, `应拿到 A 的 3 条，实际 ${JSON.stringify(rows)}`);
  assert.deepEqual(rows.map((r) => r.text), ['A-五分钟前', 'A-二十分钟前', 'A-半小时前'], JSON.stringify(rows));
});

// ── ⑤ 参数化查询（注入）────────────────────────────────────────────────────
t('⑤ 注入串只被当成普通字符串：sender 传 "\' OR 1=1 --" 拿不到任何行', () => {
  const rows = mem.recentMessagesAcrossSessions(SELF, { now, limit: 10, sender: "' OR 1=1 --" });
  assert.deepEqual(rows, [], `注入串不该命中任何消息，实际 ${JSON.stringify(rows)}`);
  // 对照：正常 sender 是能命中的，说明上面的空不是"整个查询坏了"
  const ok = mem.recentMessagesAcrossSessions(SELF, { now, limit: 10, sender: '马卡龙' });
  assert.ok(ok.length > 0, '正常 sender 应能命中：' + JSON.stringify(ok));
});

t('⑤b 注入串放进 convKey / 正文里也改不了结构与数据', () => {
  const evilConv = `group:1' OR '1'='1`;
  assert.deepEqual(mem.recentMessagesAcrossSessions(SELF, { now, limit: 10, convKey: evilConv }), [], 'convKey 注入不该命中');
  const evilText = `'; DROP TABLE chat_messages; --`;
  put(A, now - 2 * MIN, '恶意', evilText);
  const rows = mem.recentMessagesAcrossSessions(SELF, { now, limit: 10, sender: '恶意' });
  assert.equal(rows.length, 1, `含注入片段的消息应能正常读回，实际 ${JSON.stringify(rows)}`);
  assert.equal(rows[0].text, evilText, '读回的就是原字符串，没有被执行');
  // 表还在（真被执行的话下面这次查询会报错/空库）
  assert.ok(mem.recentMessagesAcrossSessions('', { now, limit: 5 }).length > 0, 'chat_messages 必须还在');
});

// ── ⑥ 可选过滤 + 返回结构 ───────────────────────────────────────────────────
t('⑥ sender 过滤：昵称片段或 QQ 号都能收窄', () => {
  const byName = mem.recentMessagesAcrossSessions(SELF, { now, limit: 10, sender: '马卡龙' });
  assert.ok(byName.length > 0 && byName.every((r) => r.sender === '马卡龙'), JSON.stringify(byName));
  const byUid = mem.recentMessagesAcrossSessions(SELF, { now, limit: 10, sender: '900000001' });
  assert.ok(byUid.length > 0, '按 QQ 号也该能查到：' + JSON.stringify(byUid));
});

t('⑥b 返回结构紧凑：字段齐全、正文截到 200 字、按时间倒序', () => {
  const long = '字'.repeat(500);
  put(B, now - 90 * 1000, '长文', long);
  const rows = mem.recentMessagesAcrossSessions(SELF, { now, limit: 10 });
  const top = rows[0];
  assert.equal(top.text.length, 200, `正文应截到 200 字，实际 ${top.text.length}`);
  assert.deepEqual(Object.keys(top).sort(), ['isSelf', 'key', 'sender', 'senderUid', 'text', 'ts', 'tsMs'].sort(), Object.keys(top).join(','));
  assert.equal(top.key, B, '最新的一条应排第一');
  assert.equal(top.sender, '长文');
  assert.equal(top.isSelf, false);
  const times = rows.map((r) => r.tsMs);
  assert.deepEqual(times, [...times].sort((a, b) => b - a), '必须按时间倒序：' + JSON.stringify(times));
});

t('⑥c 自己发的消息标记 isSelf=true、sender 为空（由调用方决定怎么显示）', () => {
  put(C, now - 30 * 1000, '', '我发的', { isSelf: true });
  const rows = mem.recentMessagesAcrossSessions(SELF, { now, limit: 10 });
  assert.equal(rows[0].isSelf, true, JSON.stringify(rows[0]));
  assert.equal(rows[0].sender, '', '自己发的没有昵称');
});

// ── ⑦ 只读 + 表不存在 ───────────────────────────────────────────────────────
t('⑦ 全程只读：一连串查询跑完，chat.db 字节不变', () => {
  const before = fingerprint(SANDBOX_CHAT_DB);
  mem.recentMessagesAcrossSessions(SELF, { now, limit: 10 });
  mem.recentMessagesAcrossSessions('', { now, convKey: A, sender: '马卡龙', limit: 5 });
  mem.recentMessagesAcrossSessions(SELF, { now, windowMs: 60 * 1000, limit: 1 });
  assert.notEqual(before, 'MISSING', '前置条件：聊天记录库文件应已存在（消息都写在它里面）');
  assert.equal(fingerprint(SANDBOX_CHAT_DB), before, '只读函数不该改动数据库文件');
});

t('⑦b 表未建（桥从未运行过 / 库被清空）→ 返回空数组而不是抛错', () => {
  chatDbMod.initChatDb();
  chatDbMod.chatDb.exec('DROP TABLE IF EXISTS chat_messages');   // 聊天表在 chat.db 里（不再在 memory.db）
  const rows = mem.recentMessagesAcrossSessions(SELF, { now, limit: 5 });
  assert.deepEqual(rows, [], `表不存在时应返回空数组，实际 ${JSON.stringify(rows)}`);
});

// ── ⑧ 隔离自证 ──────────────────────────────────────────────────────────────
t('⑧ 沙箱 state 与仓库 state 分离；仓库真实 state 指纹不变', () => {
  assert.ok(fs.existsSync(SANDBOX_CHAT_DB), '沙箱里应生成了 chat.db（聊天记录查库路径）');
  assert.equal(chatDbMod.chatDbFile(), SANDBOX_CHAT_DB, `聊天记录库应落在沙箱：${chatDbMod.chatDbFile()}`);
  assert.equal(chatDbMod.legacyMemoryDbFile(), SANDBOX_MEM_DB, `记忆库路径应是沙箱里的 memory.db：${chatDbMod.legacyMemoryDbFile()}`);
  assert.notEqual(chatDbMod.legacyMemoryDbFile(), SANDBOX_CHAT_DB, '聊天记录库与记忆库必须是两个文件');
  assert.equal(fingerprint(path.join(REAL_STATE, 'memory.db')), realBefore.memory, '仓库 state/memory.db 被动过了');
  assert.equal(fingerprint(path.join(REAL_STATE, 'chat.db')), realBefore.chat, '仓库 state/chat.db 被动过了');
  assert.equal(fingerprint(path.join(REAL_STATE, 'crosschat.json')), realBefore.crosschat, '仓库 state/crosschat.json 被动过了');
  const listingAfter = stateListing(REAL_STATE);
  assert.equal(listingAfter, realListingBefore, '仓库 state 目录清单被动过了');
});

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 占用忽略 */ }
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
