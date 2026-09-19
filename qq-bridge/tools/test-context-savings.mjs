// 剪枝计量（src/core/context-savings.js）自检。
//
// 这一版是**读会话日志重算**（第一版走事件流，真机证明不可行：官方 rc.1 没有全局广播，
// 桥只 follow 自己映射的会话）。所以测试必须造出真实的会话日志形状：
//   多帧 zstd（一帧一次 append）的 session.jsonl.zstd + 里面的 compaction/prune / step/start 事件。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  initContextSavings, reconcileContextSavings, getContextSavings, decodeSessionLog, summarizeSessionLog,
  __resetContextSavingsForTest,
} from '../src/core/context-savings.js';

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`); failed += 1; }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-savings-'));
const home = path.join(root, 'dsh-home');
const stateDir = path.join(root, 'state');
/** 造一份多帧 zstd 会话日志（每行一帧 = 模拟 DSH 的 append 方式） */
function writeLog(slug, sid, events) {
  const dir = path.join(home, 'sessions', slug, sid);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl.zstd');
  const frames = events.map((e) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8')));
  fs.writeFileSync(file, Buffer.concat(frames));
  return file;
}
const step = (seq, time) => ({ type: 'step/start', seq, time, data: {} });
const prune = (seq, time, tokens) => ({ type: 'compaction/prune', seq, time, data: { shadowedSeqs: [seq - 1], shadowedTokenCount: tokens } });
const hourMs = 3600 * 1000;
const now = Date.now();

try {
  console.log('== ① 多帧 zstd 解码（DSH 的写盘方式） ==');
  const sidA = 'session-aaaa';
  const logA = writeLog('--proj-a--', sidA, [
    { type: 'session', version: 0, id: sidA, createdAt: now },
    step(10, now - 5 * hourMs),
    { type: 'tool/result', seq: 11, time: now - 5 * hourMs, data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'x'.repeat(5000) }] }] } } },
    prune(12, now - 4 * hourMs, 1000),
    step(20, now - 3 * hourMs),
    step(30, now - 2 * hourMs),
    prune(40, now - 1 * hourMs, 500),
    // 摘要压缩（把最老一段聊天换成 <compacted-summary>）：与剪枝是两条路径，要分开统计
    { type: 'compaction/summary', seq: 41, time: now - 0.9 * hourMs, data: { compactionId: 'c1', summary: [{ type: 'text', text: '摘要' }], shadowedRange: { start: 10, end: 30 }, shadowedSeqs: [10, 20, 30], shadowedTokenCount: 4000 } },
    step(50, now - 0.5 * hourMs),
  ]);
  await check('decodeSessionLog 能把多帧拼回来', () => {
    const text = decodeSessionLog(logA);
    const lines = text.split('\n').filter(Boolean);
    assert.equal(lines.length, 9, `应当解出 9 行，实际 ${lines.length}`);
    assert.equal(JSON.parse(lines[2]).type, 'tool/result');
  });
  await check('summarizeSessionLog：剪枝量 + 后续请求重读 + 摘要另算', () => {
    const s = summarizeSessionLog(decodeSessionLog(logA));
    assert.equal(s.pruneEvents, 2);
    assert.equal(s.prunedTotal, 1500);
    const b = [...s.buckets.values()][0];      // buckets 是 Map
    assert.ok(b, '应当有至少一个计费日桶');
    assert.equal(b.prunedTokens, 1500);
    assert.equal(b.pruneEvents, 2);
    // 第一次剪枝(seq12)之后有 step 20/30/50（3 次）+ 第二次剪枝(seq40)之后有 step 50（1 次）
    assert.equal(b.rereadSaved, 1000 * 3 + 500 * 1);
    // 摘要压缩（把最老一段聊天换成 <compacted-summary>）是另一条路径，单独统计
    assert.equal(b.summaryEvents, 1);
    assert.equal(b.summarizedTokens, 4000);
  });

  console.log('\n== ② 扫描 → 汇总 ==');
  initContextSavings({ stateDir, dshHome: home });
  __resetContextSavingsForTest();
  const r1 = await reconcileContextSavings({ force: true });
  await check('扫描到 1 份日志', () => { assert.equal(r1.ok, true); assert.equal(r1.scanned, 1); });
  await check('今日桶数字正确', () => {
    const s = getContextSavings(7);
    assert.equal(s.today.prunedTokens, 1500);
    assert.equal(s.today.pruneEvents, 2);
    assert.equal(s.today.rereadSaved, 3500);
    assert.equal(s.lifetime.prunedTokens, 1500);
    assert.equal(s.sessions, 1);
  });
  await check('幂等：再扫一遍不翻倍', async () => {
    await reconcileContextSavings({ force: true });
    const s = getContextSavings(7);
    assert.equal(s.today.prunedTokens, 1500);
    assert.equal(s.today.rereadSaved, 3500);
  });
  await check('增量：没变过的日志走复用、不重读', async () => {
    const r = await reconcileContextSavings({ force: true });
    assert.equal(r.scanned, 0);
    assert.equal(r.reused, 1);
  });

  console.log('\n== ③ 新增一份日志会自动带上 ==');
  writeLog('--proj-b--', 'session-bbbb', [
    { type: 'session', version: 0, id: 'session-bbbb', createdAt: now },
    prune(5, now - hourMs, 700),
    step(6, now - 0.9 * hourMs),
  ]);
  await check('第二份日志被扫到', async () => {
    const r = await reconcileContextSavings({ force: true });
    assert.equal(r.scanned, 1, `只该重读新那份（实际 ${r.scanned}）`);
    assert.equal(r.reused, 1);
    const s = getContextSavings(7);
    assert.equal(s.today.prunedTokens, 2200);
    assert.equal(s.today.rereadSaved, 3500 + 700);
    assert.equal(s.sessions, 2);
  });

  console.log('\n== ④ 状态文件 + 重启读回 ==');
  await check('状态文件写出来了', () => assert.ok(fs.existsSync(path.join(stateDir, 'context-savings.json'))));
  await check('重新 init 后（不扫描也能显示）数字还在', () => {
    initContextSavings({ stateDir, dshHome: home });
    const s = getContextSavings(7);
    assert.equal(s.today.prunedTokens, 2200);
    assert.equal(s.today.rereadSaved, 4200);
  });
  await check('没扫描时的 TTL 短路', async () => {
    const r = await reconcileContextSavings({});   // 不带 force：刚 init 完 lastScanMs=0 → 会真扫
    assert.equal(r.ok, true);
    const r2 = await reconcileContextSavings({});  // 紧接着再来一次 → TTL 内跳过
    assert.equal(r2.skipped, 'ttl');
  });

  console.log('\n== ⑤ 脏数据 / 边界 ==');
  await check('坏日志不会让整次扫描失败', async () => {
    const bad = path.join(home, 'sessions', '--proj-bad--', 'session-bad');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'session.jsonl.zstd'), Buffer.from('not a zstd file at all'));
    const r = await reconcileContextSavings({ force: true });
    assert.equal(r.ok, true);
    assert.ok(getContextSavings(7).today.prunedTokens >= 2200, '已有数字不该被坏文件冲掉');
  });
  await check('窗口外的老日志不算（mtime 8 天前）', async () => {
    const old = writeLog('--proj-old--', 'session-old', [prune(1, now - 9 * 24 * hourMs, 99999), step(2, now - 9 * 24 * hourMs)]);
    const past = new Date(now - 9 * 24 * hourMs);
    fs.utimesSync(old, past, past);
    await reconcileContextSavings({ force: true });
    assert.equal(getContextSavings(7).today.prunedTokens, 2200, '老日志不该计入');
  });
  await check('被删掉的日志会从缓存里清掉', async () => {
    fs.rmSync(path.join(home, 'sessions', '--proj-b--'), { recursive: true, force: true });
    await reconcileContextSavings({ force: true });
    const s = getContextSavings(7);
    assert.equal(s.today.prunedTokens, 1500);
    assert.equal(s.sessions, 1);
  });
  await check('没有 DSH home 时明确跳过而不是报错', async () => {
    initContextSavings({ stateDir, dshHome: '' });
    const r = await reconcileContextSavings({ force: true });
    assert.equal(r.ok, false);
    assert.equal(r.skipped, 'no-dsh-home');
  });
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 占用忽略 */ }
}

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}（通过 ${passed}，失败 ${failed}）`);
process.exit(failed === 0 ? 0 : 1);
