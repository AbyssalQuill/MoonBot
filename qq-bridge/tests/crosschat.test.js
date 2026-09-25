// 跨会话互知（crosschat）：他处动态改为直接查 SQLite —— 2026-09-30 架构改动的回归锁
//
// 改动前：turn-guard 回合收尾写一行 ≤70 字摘要进 state/crosschat.json（每会话最多 12 行），
//   buildCrossChatBlock 读该文件、按"最近一小时"粗筛后注入最多 2 条。
// 改动后：buildCrossChatBlock 调 memory.js 的 recentMessagesAcrossSessions(key, …)，
//   直接查 chat_messages（1 小时内、别的会话、最多 2 条、按会话去重），不再读 digests。
//   留言信箱（addCrossMail / unreadCrossMails / markCrossMailsRead）行为完全不变。
//
// 本文件覆盖：
//   ① 空库（桥从未运行过）→ 返回空串，不抛错
//   ② 只有本会话的消息 → 不算"他处"，返回空串
//   ③ 他处有 1 小时内的消息 → 注入 1 行，含来源标签、发送者、原文
//   ④ 上限 2 条、取最新、且按会话去重（同一会话的连续两条只占一个名额）
//   ⑤ 时间窗：2 小时前的不注入，59 分钟前的注入
//   ⑥ 留言优先级高于他处动态（[Mail] 在前）+ 只把注入过的留言标已读（含 5 条只标 2 条）
//   ⑦ 源码静态检查：不再读 digests、没把 mentionsOthers 闸门加回来、走的是查库函数
//   ⑧ 长度硬约束：正文 ≤80 字、整行 ≤ 旧实现同标签行长、整块 ≤ 旧实现上限（省 token 指标）
//   ⑨ 文件边界：沙箱 state 与仓库 state 分离，跑完仓库真实 state（memory.db + chat.db + 目录清单）指纹不变
//
// 完全离线：不起服务、不发网络请求、不连 NapCat、不起桥进程。只 import 沙箱里的一份 src 副本，
// state 落在系统临时目录，跑完删掉（真实 qq-bridge/state/ 全程只读，末尾用 hash 自证没被动过）。
//
// 跑法：node tests/crosschat.test.js

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');                       // qq-bridge/
const REAL_STATE = path.join(REPO, 'state');

/* ── 沙箱 ──────────────────────────────────────────────────────────────────
 * crosschat.js / memory.js 都通过 lib/paths.js 的 ROOT（= src/lib 往上两级）推导 state 目录，
 * 所以只要把 src 复制一份到沙箱，沙箱里的 paths.js 就会把 STATE_DIR 指到 <沙箱>/state。
 * 这跟 tests/quote-context.test.js / tests/memory-fts.test.js 的做法一致。 */
const sandbox = path.join(os.tmpdir(), `.tmp-crosschat-${process.pid}`);
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.cpSync(path.join(REPO, 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-crosschat-sandbox', private: true, type: 'module' }));

const SANDBOX_STATE = path.join(sandbox, 'state');
const SANDBOX_CROSSCHAT = path.join(SANDBOX_STATE, 'crosschat.json');

const cfg = {
  ownerQQ: '100001',
  consolePort: 3999,
  napcat: { httpUrl: 'http://127.0.0.1:1', accessToken: '' },
  dsh: { baseUrl: 'http://127.0.0.1:1' },
  allow: {}, deny: {}, allowAllWhenEmpty: true,
  social: { tools: {}, send: { linearEnabled: false }, wake: {} },
};

/* 会话 key 统一用 group: 形式：describeCrossKey 对 group 走 group-cache（缓存空 → 原样回 key），
 * 对 private 会走 memory.js 的 profileDisplayName（会开 sqlite）。用 group 键可让标签完全确定。 */
const SELF = 'group:100002';        // 当前会话：别的会话的消息才叫"他处"
const OTHER_A = 'group:868756515';
const OTHER_KEYS = ['group:200001', 'group:200002', 'group:200003', 'group:200004', 'group:200005'];

const CORE_URL = pathToFileURL(path.join(sandbox, 'src', 'core', 'crosschat.js')).href;

/** 读仓库里那一份真实源码（静态断言用；不是沙箱副本）。 */
const repoCrossChatSrc = fs.readFileSync(path.join(REPO, 'src', 'core', 'crosschat.js'), 'utf8');

/** 真实 state 的指纹，用来在末尾自证"没污染真数据"（crosschat.json + memory.db + chat.db 都要看）。
 *  聊天记录自 2026-09-24 起落在独立库 state/chat.db，所以指纹也要把它算上。 */
const fingerprint = (f) => {
  try {
    const st = fs.statSync(f);
    return `${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}|${st.size}|${st.mtimeMs}`;
  } catch { return 'MISSING'; }
};
const realBefore = {
  crosschat: fingerprint(path.join(REAL_STATE, 'crosschat.json')),
  memory: fingerprint(path.join(REAL_STATE, 'memory.db')),
  chat: fingerprint(path.join(REAL_STATE, 'chat.db')),
};
/* 目录清单比对（只读自证）：并行跑 `node --test` 时，兄弟测试文件会在 state/ 下建自己的临时沙箱目录
 * （例如 tests/pixiv-source-order.test.js 的 state/.tmp-pixiv-order-test），它与本改动无关、且会自行清理。
 * 比对时把这些 `.tmp-*` 项剔除，剩下的"真实 state 数据"一项都不许增删。 */
const stateListing = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith('.tmp-')).sort().join(',') : 'MISSING');
const realStateListingBefore = stateListing(REAL_STATE);

/* ── 模块加载 ──────────────────────────────────────────────────────────────
 * crosschat.js 有一个模块级缓存 crossChatCache（留言信箱），一旦 loadCrossChat() 跑过就再也不重读文件。
 * 需要重来一遍时就写一个新的 crosschat.json 并用 `?v=N` 查询串拿一个全新的模块实例
 * （Node ESM 按完整 URL 缓存）。注意：不要删沙箱 state 目录 —— 沙箱里的 chat.db 在里面。 */
let instanceSeq = 0;
async function loadCrossChat(mailState) {
  if (mailState !== undefined) fs.writeFileSync(SANDBOX_CROSSCHAT, JSON.stringify(mailState, null, 2));
  const mod = await import(`${CORE_URL}?v=${++instanceSeq}`);
  mod.initCrossChatCore(cfg);
  return mod;
}

const mem = await import(pathToFileURL(path.join(sandbox, 'src', 'core', 'memory.js')).href);
/* 聊天记录独立库（state/chat.db）：用来断言"查库路径落在沙箱"、以及随后要核对的那个库文件是谁。
 * 与 memory.js 里的 chat-db 是同一个模块实例（同 URL），所以 chatDb 是同一个句柄。 */
const chatDbMod = await import(pathToFileURL(path.join(sandbox, 'src', 'core', 'chat-db.js')).href);
const cc0 = await loadCrossChat({ mail: {} });

/** 往沙箱 SQLite 里塞一条消息（= 桥运行时落库的那张表）。字段名按 persistChatMessage 的口径来。 */
let seq = 0;
function put(convKey, tMs, name, text, opts = {}) {
  seq += 1;
  mem.persistChatMessage(convKey, {
    time: tMs,
    text,
    plain: text,
    isSelf: !!opts.isSelf,
    userId: opts.isSelf ? 'self' : String(opts.uid ?? '900000001'),
    sender: opts.isSelf ? '' : name,
    messageId: `x-${seq}`,
  });
}

const numOtherSessions = (block) => (block.match(/\[Other sessions\]/g) || []).length;
const numMail = (block) => (block.match(/\[Mail\]/g) || []).length;
const otherLines = (block) => block.split('\n').filter((l) => l.startsWith('[Other sessions] '));
/** 从 `[Other sessions] <label>: <who>: <body> - already handled; …` 里抠出三段。 */
const parseOther = (line) => {
  const m = line.match(/^\[Other sessions\] (.+?): (.+?): (.*) - already handled; do not re-act unless asked or new\.$/);
  assert.ok(m, `没解析出 [Other sessions] 行：${JSON.stringify(line)}`);
  return { label: m[1], who: m[2], body: m[3] };
};

/** 旧实现（文件摘要）在同一标签下的行长上限：前缀 + 标签 + ': ' + 80 字正文 + 后缀。 */
const LEGACY_SUFFIX = ' - already handled; do not re-act unless asked or new.';
const legacyLineMax = (label) => '[Other sessions] '.length + label.length + 2 + 80 + LEGACY_SUFFIX.length;

let pass = 0, fail = 0;
let skipped = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};
const skip = (name, why) => { skipped += 1; console.log(`  SKIP ${name}\n       原因：${why}`); };

const MIN = 60 * 1000;
const now0 = Date.now();

// ── ① 空库（桥从未运行过 / 表还没建）────────────────────────────────────────
await t('① 空库：一条他处消息都没有 → 返回空串，不抛错', async () => {
  const block = cc0.buildCrossChatBlock(SELF);
  assert.equal(block, '', `空库时不该注入任何东西，实际：${JSON.stringify(block)}`);
});

// ── ② 只有本会话的消息不算"他处" ────────────────────────────────────────────
await t('② 只有本会话自己的消息 → 不出现 [Other sessions]，返回空串', async () => {
  put(SELF, now0 - 50 * MIN, '我', '我自己刚做的事');
  const block = cc0.buildCrossChatBlock(SELF);
  assert.equal(numOtherSessions(block), 0, '本会话的消息不能被当成他处：' + JSON.stringify(block));
  assert.ok(!block.includes('我自己刚做的事'), '本会话的正文也不该出现：' + JSON.stringify(block));
  assert.equal(block, '', '空块（无留言无他处内容）实际：' + JSON.stringify(block));
});

// ── ③ 他处有 1 小时内的消息 → 注入 ──────────────────────────────────────────
await t('③ 别的会话 20 分钟前有人说话 → 注入 1 行，含来源、发送者、原文', async () => {
  put(OTHER_A, now0 - 20 * MIN, '马卡龙', '帮主人在群里查了 pixiv 图并发出去了');
  const block = cc0.buildCrossChatBlock(SELF);
  assert.equal(numOtherSessions(block), 1, '应恰好 1 行：' + JSON.stringify(block));
  const { label, who, body } = parseOther(otherLines(block)[0]);
  assert.equal(label, OTHER_A, '应点名来源会话：' + JSON.stringify(block));
  assert.equal(who, '马卡龙', '应点名是谁说的话（旧实现只有摘要正文）：' + JSON.stringify(block));
  assert.equal(body, '帮主人在群里查了 pixiv 图并发出去了', '应带原文：' + JSON.stringify(block));
});

// ── ④ 上限与去重 ────────────────────────────────────────────────────────────
await t('④ 5 个会话各有新消息 + 最新会话连发 2 条 → 只注入 2 行，来自 2 个不同会话', async () => {
  /* 时间带必须是"越靠后的用例越新"，否则会被前一个用例的消息挤掉名额（本文件的约定）。 */
  OTHER_KEYS.forEach((k, i) => put(k, now0 - (12 - i) * MIN, `群友${i + 1}`, `摘要-${i + 1}`)); // i=4 最新
  // 在"最新的那个会话"里再补一条更新的：两条都落在 top-2 的原始行里，但去重后只占一个名额
  put(OTHER_KEYS[4], now0 - 7 * MIN, '群友5', '摘要-5b');
  const block = cc0.buildCrossChatBlock(SELF);
  assert.equal(numOtherSessions(block), 2, `最多 2 行，实际 ${numOtherSessions(block)}：${JSON.stringify(block)}`);
  const lines = otherLines(block).map(parseOther);
  assert.deepEqual(lines.map((l) => l.label), [OTHER_KEYS[4], OTHER_KEYS[3]], '应取最新的两个**不同**会话：' + JSON.stringify(block));
  assert.equal(lines[0].body, '摘要-5b', '同一会话内取最新那条：' + JSON.stringify(block));
  assert.equal(lines[1].body, '摘要-4', '第二个名额应落到下一个会话上：' + JSON.stringify(block));
  for (const stale of ['摘要-1', '摘要-2', '摘要-3']) {
    assert.ok(!block.includes(stale), `${stale} 在最新的两个会话之外，不该注入：` + JSON.stringify(block));
  }
});

await t('④b 已经注入了 2 条时也不重复同一句（去重后不出现重复正文）', async () => {
  const block = cc0.buildCrossChatBlock(SELF);
  const bodies = otherLines(block).map((l) => parseOther(l).body);
  assert.equal(new Set(bodies).size, bodies.length, '不能同一句出现两次：' + JSON.stringify(block));
});

// ── ⑤ 时间窗 ────────────────────────────────────────────────────────────────
await t('⑤ 2 小时前的消息不注入；6 分钟前的注入（窗口 = 60 分钟）', async () => {
  put('group:300001', now0 - 120 * MIN, '甲', '两小时前的老消息');
  put('group:300002', now0 - 6 * MIN, '乙', '六分钟前的新消息');
  const block = cc0.buildCrossChatBlock(SELF);
  assert.ok(!block.includes('两小时前的老消息'), '过期消息不该注入：' + JSON.stringify(block));
  assert.ok(block.includes('六分钟前的新消息'), '1 小时内的消息应注入：' + JSON.stringify(block));
});

await t('⑤b 查库函数本身：比窗口更老的消息一条都拿不到（空数组，不抛）', () => {
  // 窗口下限 60s（代码里的 clamp）；现有最新消息也是 1 分钟以前的，所以必然为空
  const rows = mem.recentMessagesAcrossSessions(SELF, { windowMs: 60 * 1000, limit: 5 });
  assert.ok(Array.isArray(rows) && rows.length === 0, `1 分钟窗内不该有消息，实际：${JSON.stringify(rows)}`);
});

await t('⑤c isSelf 消息也会被当成"他处动态"（旧摘要记的正是自己做过什么），标成 you', async () => {
  put('group:300003', now0 - 3 * MIN, '', '我在别的群刚发了一句', { isSelf: true });
  const block = cc0.buildCrossChatBlock(SELF);
  const hit = otherLines(block).map(parseOther).find((l) => l.body === '我在别的群刚发了一句');
  assert.ok(hit, '自己在他处说的话也应有知情权：' + JSON.stringify(block));
  assert.equal(hit.who, 'you', '自己发的应标成 you：' + JSON.stringify(block));
});

// ── ⑥ 留言优先级 + 只标注入过的 ─────────────────────────────────────────────
await t('⑥ [Mail] 出现在 [Other sessions] 之前，且注入后该留言未读变空', async () => {
  const cc = await loadCrossChat({ mail: {} });
  cc.addCrossMail(SELF, OTHER_A, '给 B 的一条留言');
  const block = cc.buildCrossChatBlock(SELF);
  const iMail = block.indexOf('[Mail]');
  const iOther = block.indexOf('[Other sessions]');
  assert.ok(iMail >= 0, '应注入留言：' + JSON.stringify(block));
  assert.ok(iOther >= 0, '应同时注入他处动态：' + JSON.stringify(block));
  assert.ok(iMail < iOther, `[Mail] 必须在 [Other sessions] 之前，实际 mail@${iMail} other@${iOther}：${JSON.stringify(block)}`);
  assert.ok(block.includes('给 B 的一条留言'), '留言正文应在块里');
  assert.deepEqual(cc.unreadCrossMails(SELF, 10), [], '注入过的留言应已被标记已读');
});

await t('⑥b 5 条未读留言 → 只注入 2 条，第 3 条及以后**不许**被静默标已读', async () => {
  /* 缺陷回归：原实现无条件把该会话全部未读标已读，队列里第 3 条及以后（addCrossMail 每会话最多留 10 条）
   * 永远不会被注入却已被标记 → 静默丢留言。markCrossMailsRead(key, ids) 只标真正注入过的。 */
  const cc = await loadCrossChat({ mail: {} });
  const contents = ['留言1', '留言2', '留言3', '留言4', '留言5'];
  for (const c of contents) cc.addCrossMail(SELF, OTHER_A, c);
  assert.equal(cc.unreadCrossMails(SELF, 10).length, 5, '前置条件：5 条都未读');

  const block = cc.buildCrossChatBlock(SELF);
  assert.equal(numMail(block), 2, '注入只取 2 条：' + JSON.stringify(block));
  assert.ok(block.includes('留言1') && block.includes('留言2'), '注入的是最早的 2 条：' + JSON.stringify(block));

  const left = cc.unreadCrossMails(SELF, 10);
  assert.equal(left.length, 3, `应还剩 3 条未读（第 3、4、5 条），实际 ${left.length}：${JSON.stringify(left.map((m) => m.content))}`);
  assert.deepEqual(left.map((m) => m.content), ['留言3', '留言4', '留言5'], '被标已读的必须正好是注入过的两条（留言1、留言2）');

  const block2 = cc.buildCrossChatBlock(SELF);
  assert.equal(numMail(block2), 2, '第二轮仍只注入 2 条');
  assert.ok(block2.includes('留言3') && block2.includes('留言4'), '上一轮没注入的留言这一轮要能补上：' + JSON.stringify(block2));
  assert.deepEqual(cc.unreadCrossMails(SELF, 10).map((m) => m.content), ['留言5'], '只剩最后一条未读');
});

// ── ⑦ 源码静态检查（防止退回文件摘要 / 触发词闸门）───────────────────────────
await t('⑦ crosschat.js 有效代码里不再读 digests，改走查库函数', () => {
  /* 只看有效代码：注释里仍保留"旧实现读 digests"的说明，直接对整个文件做 doesNotMatch 会被注释误伤，
   * 所以先剥掉块注释与整行注释。 */
  const code = repoCrossChatSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, /digests/, 'digests 读取路径不该还在 crosschat.js 的有效代码里');
  assert.doesNotMatch(code, /mentionsOthers/, '旧的「提到别的会话才注入」闸门不该被加回来');
  assert.match(code, /recentMessagesAcrossSessions/, '他处动态应来自 SQLite 查询函数');
  assert.match(code, /\[Other sessions\]/, '他处动态的注入行不见了');
});

await t('⑦b turn-guard.js 不再写摘要（pushCrossDigest 调用已删）', () => {
  const tg = fs.readFileSync(path.join(REPO, 'src', 'core', 'turn-guard.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(tg, /pushCrossDigest/, '回合收尾不该再写摘要');
  assert.doesNotMatch(tg, /from '\.\/crosschat\.js'/, 'turn-guard 不该再 import crosschat');
});

await t('⑦c memory.js 提供了只读的跨会话查询函数', () => {
  assert.equal(typeof mem.recentMessagesAcrossSessions, 'function', '缺少 recentMessagesAcrossSessions 导出');
});

// ── ⑧ 长度硬约束（省 token 是硬指标）────────────────────────────────────────
await t('⑧ 300 字的长消息：正文截到 ≤80 字，整行 ≤ 旧实现同标签行长', async () => {
  const long = 'あ'.repeat(300);
  put('group:400001', now0 - 2 * MIN, '丙', long);
  const block = cc0.buildCrossChatBlock(SELF);
  const line = otherLines(block).find((l) => l.includes('あ'));
  assert.ok(line, '长消息应被注入（截断后）：' + JSON.stringify(block.slice(0, 200)));
  const { label, body } = parseOther(line);
  assert.ok(body.length <= 80, `正文必须 ≤80 字，实际 ${body.length}`);
  assert.equal(body, long.slice(0, body.length), '截断必须是原正文的前缀（不能从中间挖）');
  assert.ok(body.length >= 60, `标签较短时应尽量把 80 字额度用满，实际只剩 ${body.length} 字`);
  assert.ok(!block.includes(long), '不该整条原样注入');
  assert.ok(line.length <= legacyLineMax(label), `整行 ${line.length} 超过旧实现同标签上限 ${legacyLineMax(label)}：${JSON.stringify(line)}`);
});

await t('⑧b 整块字符数不超过旧实现的上限（2 行 × 旧同标签行长）', () => {
  const block = cc0.buildCrossChatBlock(SELF);
  const lines = otherLines(block);
  assert.equal(lines.length, 2, '前置条件：满额 2 行');
  const legacyTotal = lines.reduce((n, l) => n + legacyLineMax(parseOther(l).label), 0);
  assert.ok(block.length <= legacyTotal, `整块 ${block.length} 字符 > 旧实现上限 ${legacyTotal}`);
});

await t('⑧c 超长标签/超长发送者名也压不爆这一行（标签 ≤40、发送者 ≤16）', async () => {
  const hugeLabel = 'group:500001';
  put(hugeLabel, now0 - MIN, '很长的昵称'.repeat(20), 'x'.repeat(300));
  const block = cc0.buildCrossChatBlock(SELF);
  for (const line of otherLines(block)) {
    assert.ok(line.length <= 170, `任何一行都 ≤170 字符，实际 ${line.length}：${JSON.stringify(line)}`);
    assert.ok(parseOther(line).body.length <= 80, '正文永远 ≤80 字');
  }
});

// ── ⑨ 文件边界 / 隔离 ───────────────────────────────────────────────────────
await t('⑨ 沙箱 state 与仓库 state 是两处；本测试全程只写沙箱', async () => {
  const pathsInSandbox = await import(pathToFileURL(path.join(sandbox, 'src', 'lib', 'paths.js')).href);
  assert.equal(pathsInSandbox.STATE_DIR, SANDBOX_STATE, 'paths.js 的 STATE_DIR 应指向沙箱');
  assert.notEqual(pathsInSandbox.STATE_DIR, REAL_STATE, '绝不能是仓库真实 state 目录');
  assert.equal(pathsInSandbox.CROSSCHAT_FILE, SANDBOX_CROSSCHAT, 'crosschat.json 应落在沙箱');
  assert.ok(fs.existsSync(SANDBOX_CROSSCHAT), '沙箱里应已生成 crosschat.json（留言信箱）');
  /* 2026-09-24 聊天记录拆分库：跨会话查库（recentMessagesAcrossSessions）读的是 state/chat.db，
   * 不再是 memory.db —— 所以"沙箱里生成了查库用的那个库"这条断言改看 chat.db。
   * 本测试只调聊天/留言函数、不碰记忆档案，因此这里不要求沙箱里出现 memory.db。 */
  assert.ok(fs.existsSync(path.join(SANDBOX_STATE, 'chat.db')), '沙箱里应已生成 chat.db（聊天记录查库路径）');
  assert.equal(chatDbMod.chatDbFile(), path.join(SANDBOX_STATE, 'chat.db'), `聊天记录库必须落在沙箱：${chatDbMod.chatDbFile()}`);
  assert.notEqual(chatDbMod.chatDbFile(), path.join(REAL_STATE, 'chat.db'), '绝不能是仓库真实 state/chat.db');
  assert.equal(fs.existsSync(path.join(REAL_STATE, 'crosschat.json')), true, '仓库里那份应原样还在（只读）');
});

await t('⑨b 跑完仓库真实 state（crosschat.json + memory.db + chat.db）内容与 mtime 都没变', () => {
  const after = {
    crosschat: fingerprint(path.join(REAL_STATE, 'crosschat.json')),
    memory: fingerprint(path.join(REAL_STATE, 'memory.db')),
    chat: fingerprint(path.join(REAL_STATE, 'chat.db')),
  };
  assert.equal(after.crosschat, realBefore.crosschat, `真实 state/crosschat.json 被动过了！before=${realBefore.crosschat} after=${after.crosschat}`);
  assert.equal(after.memory, realBefore.memory, `真实 state/memory.db 被动过了！before=${realBefore.memory} after=${after.memory}`);
  assert.equal(after.chat, realBefore.chat, `真实 state/chat.db 被动过了！before=${realBefore.chat} after=${after.chat}`);
  const listingAfter = stateListing(REAL_STATE);
  assert.equal(listingAfter, realStateListingBefore, '真实 state 目录的文件清单被动过了');
});

await t('⑨c 老的 digests 字段被无视：文件里留着它也不影响注入', async () => {
  const cc = await loadCrossChat({
    digests: { [OTHER_A]: [{ t: Date.now(), line: '这条老摘要来自旧架构，绝不该出现在唤醒正文里' }] },
    mail: {},
  });
  const block = cc.buildCrossChatBlock(SELF);
  assert.ok(!block.includes('这条老摘要来自旧架构'), '老 digests 必须被完全忽略：' + JSON.stringify(block));
});

// ── 未覆盖项（明确标注，不伪造通过）─────────────────────────────────────────
skip('console-server.js 的 /api/social/history-search 端点（qq_memory_search 的真正落点）',
  '该逻辑内联在 console-server 的 HTTP 路由处理器里、没有导出纯函数；要测它必须 startConsoleServer() 起服务并发 HTTP 请求，'
  + '与本任务"完全离线、不起服务"的硬性要求冲突。函数层（searchChatMessages / recentMessagesAcrossSessions）已由 tests/memory-fts.test.js '
  + '与 tests/memory-cross-recent.test.js 覆盖。');

// ── 收尾 ────────────────────────────────────────────────────────────────────
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 上偶尔删不掉，在临时目录里无所谓 */ }
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}${skipped ? ` skip=${skipped}` : ''}`);
process.exit(fail === 0 ? 0 : 1);
