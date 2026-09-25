// 回归测试：发送打字节拍「按单个字的速度」（2026-09-15 需求 + 定稿）
//
// 原话1："修正线性延迟为按照单个字的速度来改并支持自然语言调用"
// 原话2："只保留按照字数延迟的模式，也就是现在这种，其他多余的去掉"
// 唯一规则：同一条回复里第 1 条气泡立即发（秒回），第 2 条起等 本条字数 × linearPerCharMs 毫秒
// （±linearJitterRatio 抖动，夹在 [linearMinMs, linearCapMs]）。
// 删掉的：按"连发第几条 × 步长"递增（linearBaseMs/linearStepMs/linearMode=count）、
//          以及线性关闭时那套 gapBaseMs/gapPerCharMs 兜底 —— 两套参数只会互相打架。
//
// 用法：node tests/send-pace.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sandbox = path.join(HERE, '.tmp-pace');
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(sandbox, { recursive: true });
fs.cpSync(path.join(HERE, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-pace-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({ ownerQQ: '100001' }, null, 2));

const url = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const chain = await import(url('core/send-chain.js'));
const gaps = await import(url('lib/send-gaps.js'));

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

const KEY = 'private:100001';
const setup = (cfg) => {
  chain.resetSendPace(KEY);
  chain.setSendLinearCfgReader(() => cfg);
};
// 不抖动的确定性配置
const cfgBase = { linearPerCharMs: 150, linearMinMs: 250, linearCapMs: 4000, linearJitterRatio: 0, linearEnabled: true };

console.log('== 按字速度（唯一模式）==');

t('批内第一条：0ms（秒回）', () => {
  setup(cfgBase);
  assert.equal(chain.nextSendPaceMs(KEY, 30), 0);
});

t('第二条起：间隔 = 这条气泡字数 × 每字毫秒', () => {
  setup(cfgBase);
  chain.nextSendPaceMs(KEY, 5);
  chain.markSendDelivered(KEY, 5);
  assert.equal(chain.nextSendPaceMs(KEY, 10), 1500);
  chain.markSendDelivered(KEY, 10);
  assert.equal(chain.nextSendPaceMs(KEY, 3), 450);
});

t('下限：极短气泡也不贴脸连发（默认 250ms）', () => {
  setup(cfgBase);
  chain.nextSendPaceMs(KEY, 0);
  chain.markSendDelivered(KEY, 4);
  assert.equal(chain.nextSendPaceMs(KEY, 1), 250);
});

t('上限：超长气泡被 cap 夹住', () => {
  setup(cfgBase);
  chain.nextSendPaceMs(KEY, 0);
  chain.markSendDelivered(KEY, 0);
  assert.equal(chain.nextSendPaceMs(KEY, 100), 4000);
});

t('长句等得久、短句快（旧"按第几条"模式做不到）', () => {
  setup(cfgBase);
  chain.nextSendPaceMs(KEY, 0);
  chain.markSendDelivered(KEY, 0);
  const short = chain.nextSendPaceMs(KEY, 4);
  const long = chain.nextSendPaceMs(KEY, 20);
  assert.ok(long > short, `长句应等更久：short=${short} long=${long}`);
});

t('抖动生效：落在 ±25% 内且多次取值不全相同', () => {
  setup({ ...cfgBase, linearJitterRatio: 0.25 });
  const vals = new Set();
  for (let i = 0; i < 12; i++) {
    chain.resetSendPace(KEY);
    chain.nextSendPaceMs(KEY, 0);
    chain.markSendDelivered(KEY, 0);
    vals.add(chain.nextSendPaceMs(KEY, 20));
  }
  assert.ok(vals.size > 1, '抖动没生效');
  for (const v of vals) assert.ok(v >= 2250 && v <= 3750, `抖动越界：${v}`);
});

t('静默超过 resetMs → 计数归零，重新秒回', () => {
  setup({ ...cfgBase, linearResetMs: 1 });
  chain.nextSendPaceMs(KEY, 0);
  chain.markSendDelivered(KEY, 10);
  const wait = Date.now() + 5;
  while (Date.now() < wait) { /* 跨过 reset 窗 */ }
  assert.equal(chain.nextSendPaceMs(KEY, 10), 0);
});

t('关掉节拍（linearEnabled=false）→ null，调用方不延迟', () => {
  setup({ ...cfgBase, linearEnabled: false });
  assert.equal(chain.nextSendPaceMs(KEY, 10), null);
});

t('别名映射：配置里写 linear* 一律生效', () => {
  setup({ linearEnabled: true, linearPerCharMs: 100, linearMinMs: 0, linearCapMs: 9999, linearJitterRatio: 0 });
  assert.equal(chain.sendLinearEnabled(), true);
  chain.nextSendPaceMs(KEY, 0);
  chain.markSendDelivered(KEY, 0);
  assert.equal(chain.nextSendPaceMs(KEY, 7), 700);
});

t('【已删除的功能不再生效】linearBaseMs/linearStepMs 写了也不影响按字数', () => {
  setup({ ...cfgBase, linearBaseMs: 999, linearStepMs: 999, linearMode: 'count' });
  chain.nextSendPaceMs(KEY, 0);
  chain.markSendDelivered(KEY, 0);
  assert.equal(chain.nextSendPaceMs(KEY, 10), 1500);   // 仍是 10×150，而不是 count 模式的值
});

t('send-gaps 的 byLength 也用同一组参数（不再有 gapPerCharMs）', () => {
  const cfg = { linearPerCharMs: 100, linearMinMs: 200, linearCapMs: 5000, linearJitterRatio: 0, maxGapMs: 10000 };
  const d = gaps.computeGaps(['你好啊', '这是一条比较长的消息'], 'byLength', undefined, undefined, cfg);
  assert.equal(d.length, 1);
  // 上一条 3 个字 × 100ms = 300ms（夹在 [200, 5000] 内）
  assert.equal(d[0], 300);
});

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
