// 用量对账（token-meter.reconcileWithDsh）测试：桥侧漏记 usage 帧时，用 DSH 会话级权威计数补差额。
// 关键性质：① 只补"桥侧少掉的那部分"；② 幂等（水位落盘，重复跑不重复补）；
//          ③ 没有桥侧基准（很久以前的会话）不补，只抬水位；④ 会话早就停了不补（差额会落错日期）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-reconcile-'));
const stateDir = path.join(tmp, 'state');
const cacheDir = path.join(tmp, 'projcache');
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });

const meter = await import('../src/core/token-meter.js');

const SID_A = 'session-aaaa-1111';
const SID_B = 'session-bbbb-2222';
const nowMs = Date.now();

function row(sid, prompt, completion, cacheRead, tsMs) {
  return JSON.stringify({ tsMs, sessionId: sid, convKey: null, prompt, completion, total: prompt + completion + cacheRead, cacheRead, cacheWrite: 0, est: false }) + '\n';
}
// 桥侧已记：A 会话 100,000（漏掉了一步）；B 会话一笔没有
fs.writeFileSync(path.join(stateDir, 'token-usage.jsonl'), row(SID_A, 20000, 8000, 72000, nowMs - 60000));

function cacheFile(sid, uncached, output, cacheRead, mtimeMs) {
  const p = path.join(cacheDir, sid + '.json');
  fs.writeFileSync(p, JSON.stringify({ version: 1, record: { sessionId: sid, rows: { tokenUsage: { val: { totals: { uncachedInputTokens: uncached, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0 } } } } } }));
  const t = mtimeMs / 1000;
  fs.utimesSync(p, t, t);
}
// A：DSH 侧 172,101（比桥侧多 72,101）；B：老会话，DSH 侧 5,000,000，桥侧一条都没有
cacheFile(SID_A, 30000, 9000, 133101, nowMs - 30000);
cacheFile(SID_B, 1000000, 200000, 3800000, nowMs - 3 * 86400000);

meter.initTokenMeter({ stateDir });
meter.setTokenReconcileHome(tmp); // cacheDir 直接由 opts.dir 指定，这里只保证已初始化

const r1 = meter.reconcileWithDsh({ dir: cacheDir, nowMs });
assert.equal(r1.ok, true, '对账应当成功');
assert.equal(r1.added, 1, '只应补 A 会话一条');
assert.equal(r1.addedTokens, 72101, '差额应为 30000+9000+133101 - 100000');
assert.equal(r1.skippedNoBaseline, 1, 'B 会话没有桥侧基准 → 跳过');

const billed1 = meter.getTokenReport(7, { nowMs }).today.billedTotal;
assert.equal(billed1, 172101, '对账后今日合计应等于 DSH 侧权威值');

// 幂等：再跑一次不应再补
const r2 = meter.reconcileWithDsh({ dir: cacheDir, nowMs });
assert.equal(r2.addedTokens, 0, '第二次对账不应重复补');
assert.equal(meter.getTokenReport(7, { nowMs }).today.billedTotal, 172101, '合计不应变化');

// A 会话继续跑：桥侧只多记了 1,500（prompt 1000 / output 500），DSH 侧涨到 253,500 → 应补 79,899
fs.appendFileSync(path.join(stateDir, 'token-usage.jsonl'), row(SID_A, 1000, 500, 0, nowMs + 1000));
meter.initTokenMeter({ stateDir });   // 重读文件（模拟桥重启）
cacheFile(SID_A, 41000, 12500, 200000, nowMs + 2000);
const r3 = meter.reconcileWithDsh({ dir: cacheDir, nowMs: nowMs + 3000 });
assert.equal(r3.addedTokens, 79899, '应补 253500 - 173601（逐桶差额）');
assert.equal(meter.getTokenReport(7, { nowMs: nowMs + 3000 }).today.billedTotal, 253500, '合计应等于 DSH 侧最新值');

// 会话早已停止（projcache 3 天没动）→ 不补，避免差额落到错误日期
cacheFile(SID_A, 40000, 12000, 300000, nowMs - 3 * 86400000);
fs.appendFileSync(path.join(stateDir, 'token-usage.jsonl'), row(SID_A, 100, 100, 100, nowMs + 4000));
meter.initTokenMeter({ stateDir });
const r4 = meter.reconcileWithDsh({ dir: cacheDir, nowMs: nowMs + 5000 });
assert.equal(r4.addedTokens, 0, '停用会话不应补差额');
assert.equal(r4.skippedStale, 1, '应记为 skippedStale');

console.log('token-reconcile: 全部通过 ✓');
fs.rmSync(tmp, { recursive: true, force: true });
