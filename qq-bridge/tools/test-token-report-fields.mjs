// token 用量报告的两处新口径自检（2026-09-19 反馈"token 虚高"）：
//   ① today.reconciledTotal —— 对账补记单独报数（那些行可能属于更早的用量，却落在今天的桶里）
//   ② 今日预计改成「按最近 7 天同一时段的平均用量」估剩余时段，而不是线性外推
//      （机器人夜里几乎不烧 token，线性外推在傍晚就能把一天推成两三倍 —— 实测就是这么"虚高"的）
// 全部用沙箱 state 目录 + 手写 token-usage.jsonl + 固定 nowMs，不碰真实数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-meter-'));
fs.cpSync(path.join(REPO, 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'meter-sandbox', private: true, type: 'module' }));

const stateDir = path.join(sandbox, 'state');
fs.mkdirSync(stateDir, { recursive: true });

/** 北京时间 → epoch ms（北京 = UTC+8） */
const bj = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);
const nowMs = bj(2026, 9, 19, 12, 0);          // 计费日 2026-09-19 的北京 12:00（= 时段槽 4）

const rows = [];
const push = (tsMs, prompt, cacheRead, extra = {}) => rows.push({
  tsMs, sessionId: extra.sessionId || 'session-x', convKey: 'private:1',
  prompt, completion: 10, total: prompt + cacheRead + 10, cacheRead, cacheWrite: 0, est: false, ...extra,
});
// 今天：北京 08:00（槽 0）与 10:00（槽 2）各 100 万
push(bj(2026, 9, 19, 8), 1_000_000, 0);
push(bj(2026, 9, 19, 10), 1_000_000, 0);
// 今天还有一条"对账补记"行（reconciled）
push(bj(2026, 9, 19, 11), 300_000, 0, { reconciled: true });
// 历史三个计费日：每天只在「北京 13:00 / 14:00 / 15:00」（槽 5/6/7）各有 10 万
for (const day of [16, 17, 18]) {
  push(bj(2026, 9, day, 13), 100_000, 0);
  push(bj(2026, 9, day, 14), 100_000, 0);
  push(bj(2026, 9, day, 15), 100_000, 0);
}
fs.writeFileSync(path.join(stateDir, 'token-usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

const url = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const meter = await import(url('core/token-meter.js'));
meter.initTokenMeter({ stateDir, dayOffsetMinutes: 480 });
const rep = meter.getTokenReport(7, { nowMs });

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`); failed += 1; }
}

const base = 1_000_000 + 1_000_000 + 300_000 + 30;      // 三条今天的行（prompt + completion）

console.log('== ① 对账补记单独报数 ==');
check('今日 billedTotal 含三条行', () => assert.equal(rep.today.billedTotal, base));
check('reconciledTotal 只算补记那条', () => {
  assert.equal(rep.today.reconciledTotal, 300_000 + 10);
  assert.equal(rep.today.reconciledSamples, 1);
});
check('历史日里没有补记', () => {
  const d18 = rep.dates.find((d) => d.date === '2026-09-18');
  assert.equal(d18.reconciledTotal, 0);
});

console.log('\n== ② 今日预计：时段法而不是线性外推 ==');
check('用了时段法（projectedBy=shape）', () => assert.equal(rep.projectedBy, 'shape'));
check('预计 = 已用 + 剩余时段（13/14/15 点各 10 万 + 那三行的输出 10/条）', () => {
  // 现在槽 4（北京 12:00），剩余槽 5..23；历史里只有槽 5/6/7 有量（每条含 completion 10）
  assert.equal(rep.todayEstimatedTotal, base + 3 * (100_000 + 10));
});
check('线性外推仍在（口径对照），且明显更高', () => {
  assert.ok(rep.todayLinearEstimatedTotal > rep.todayEstimatedTotal * 4,
    `linear=${rep.todayLinearEstimatedTotal} shape=${rep.todayEstimatedTotal}`);
});
check('note 说明了用的是哪种口径', () => assert.match(rep.note, /同一时段的平均用量/));

console.log('\n== ③ 没有历史时退回线性外推 ==');
{
  const dir2 = path.join(sandbox, 'state2');
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'token-usage.jsonl'),
    JSON.stringify({ tsMs: bj(2026, 9, 19, 9), sessionId: 's', prompt: 500_000, completion: 0, total: 500_000, cacheRead: 0, cacheWrite: 0, est: false }) + '\n', 'utf8');
  meter.initTokenMeter({ stateDir: dir2, dayOffsetMinutes: 480 });
  const r2 = meter.getTokenReport(7, { nowMs });
  check('projectedBy=linear 且等于线性外推值', () => {
    assert.equal(r2.projectedBy, 'linear');
    assert.equal(r2.todayEstimatedTotal, r2.todayLinearEstimatedTotal);
  });
  check('note 明确提示"偏高的可能性大"', () => assert.match(r2.note, /线性外推/));
}

console.log('\n== ④ 重试（llm/retry）：提供方计费、DSH 不给 usage —— 单独记账 ==');
{
  const dir4 = path.join(sandbox, 'state4');
  fs.mkdirSync(dir4, { recursive: true });
  fs.writeFileSync(path.join(dir4, 'token-usage.jsonl'),
    JSON.stringify({ tsMs: bj(2026, 9, 19, 9), sessionId: 's1', prompt: 70_000, completion: 0, total: 70_000, cacheRead: 0, cacheWrite: 0, est: false }) + '\n', 'utf8');
  meter.initTokenMeter({ stateDir: dir4, dayOffsetMinutes: 480 });
  const r4 = meter.getTokenReport(7, { nowMs });
  check('平时重试计数为 0', () => assert.equal(r4.today.retryCount, 0));
  // 投一帧 llm/retry（真实形状：session/event 包着 event）
  meter.meterTokenFrame({ type: 'session/event', sessionId: 's1', event: { type: 'llm/retry', time: bj(2026, 9, 19, 9, 30), data: { retryId: 'x', turn: 3, step: 4 } } });
  const r5 = meter.getTokenReport(7, { nowMs: bj(2026, 9, 19, 9, 31) });
  check('重试被记 1 次', () => assert.equal(r5.today.retryCount, 1));
  check('估算按该会话上一步的规模（70000）', () => assert.equal(r5.today.retryEstimated, 70_000));
  check('估算**不进** billedTotal（精确值绝不掺估算）', () => assert.equal(r5.today.billedTotal, 70_000));
}

console.log('\n== ⑤ 时段映射（换日 08:00 时，北京 0-7 点属于同一个计费日） ==');
{
  // 北京 2026-09-20 03:00（= UTC 09-19 19:00）仍属于计费日 2026-09-19
  const tsLate = bj(2026, 9, 20, 3);
  const dir3 = path.join(sandbox, 'state3');
  fs.mkdirSync(dir3, { recursive: true });
  fs.writeFileSync(path.join(dir3, 'token-usage.jsonl'),
    JSON.stringify({ tsMs: tsLate, sessionId: 's', prompt: 1000, completion: 0, total: 1000, cacheRead: 0, cacheWrite: 0, est: false }) + '\n', 'utf8');
  meter.initTokenMeter({ stateDir: dir3, dayOffsetMinutes: 480 });
  const r3 = meter.getTokenReport(7, { nowMs: tsLate + 60_000 });
  check('凌晨 3 点记在"昨天"那个计费日里（与平台口径一致）', () => {
    const todayKey = r3.dayWindow.key;
    assert.equal(todayKey, '2026-09-19', `计费日键=${todayKey}`);
    assert.equal(r3.today.billedTotal, 1000);
  });
}

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 占用忽略 */ }
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}（通过 ${passed}，失败 ${failed}）`);
process.exit(failed === 0 ? 0 : 1);
