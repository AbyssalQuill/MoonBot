// 回归测试：发送线性延迟「按单个字的速度」（2026-09-15 主人要求）
//
// 主人原话："修正线性延迟为按照单个字的速度来改并支持自然语言调用"
// 旧行为（count 模式）：间隔只跟"连发第几条"有关，跟字数完全无关 —— 2 字的气泡和 40 字的长句
// 都等同样的 base+n*step，实测私聊里就是 600/1200/1500ms 一条条贴上来，长句反而秒出。
// 新行为（perChar 模式，默认）：批内第 2 条起，间隔 = 这条气泡自己打完要多久 = 字数 × 每字毫秒。
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
// 不抖动的确定性配置（jit=0）
const cfgPerChar = { linearMode: 'perChar', linearPerCharMs: 150, linearMinMs: 250, linearCapMs: 4000, linearJitterRatio: 0, linearEnabled: true };

console.log('== 按字速度（perChar，默认模式）==');

t('批内第一条：0ms（秒回，保持原有行为）', () => {
  setup(cfgPerChar);
  assert.equal(chain.nextSendPaceMs(KEY, 30), 0);
});

t('第二条起：间隔 = 这条气泡字数 × 每字毫秒', () => {
  setup(cfgPerChar);
  chain.nextSendPaceMs(KEY, 5);           // 批内第一条
  chain.markSendDelivered(KEY, 5);
  assert.equal(chain.nextSendPaceMs(KEY, 10), 1500);   // 10 字 × 150ms
  chain.markSendDelivered(KEY, 10);
  assert.equal(chain.nextSendPaceMs(KEY, 3), 450);     // 3 字 × 150ms
});

t('下限：极短气泡也不贴脸连发（默认 250ms）', () => {
  setup(cfgPerChar);
  chain.nextSendPaceMs(KEY, 0);
  chain.markSendDelivered(KEY, 4);
  assert.equal(chain.nextSendPaceMs(KEY, 1), 250);
});

t('上限：超长气泡被 cap 夹住', () => {
  setup(cfgPerChar);
  chain.nextSendPaceMs(KEY, 0);
  chain.markSendDelivered(KEY, 0);
  assert.equal(chain.nextSendPaceMs(KEY, 100), 4000);  // 100×150=15000 → cap 4000
});

t('长句等得久、短句快（旧 count 模式做不到这个）', () => {
  setup(cfgPerChar);
  chain.nextSendPaceMs(KEY, 0);
  chain.markSendDelivered(KEY, 0);
  const short = chain.nextSendPaceMs(KEY, 4);
  const long = chain.nextSendPaceMs(KEY, 20);
  assert.ok(long > short, `长句应等更久：short=${short} long=${long}`);
});

t('抖动生效：±25% 内波动（同参数多次取值不完全相同）', () => {
  setup({ ...cfgPerChar, linearJitterRatio: 0.25 });
  const vals = new Set();
  for (let i = 0; i < 12; i++) {
    chain.resetSendPace(KEY);
    chain.nextSendPaceMs(KEY, 0);
    chain.markSendDelivered(KEY, 0);
    vals.add(chain.nextSendPaceMs(KEY, 20));
  }
  assert.ok(vals.size > 1, '抖动没生效（12 次取值全相同）');
  for (const v of vals) assert.ok(v >= 2250 && v <= 3750, `抖动越界：${v}（应落在 20×150×[0.75,1.25]）`);
});

t('静默超过 resetMs → 计数归零，重新即时', () => {
  setup({ ...cfgPerChar, linearResetMs: 1 });
  chain.nextSendPaceMs(KEY, 0);
  chain.markSendDelivered(KEY, 10);
  const wait = Date.now() + 5;
  while (Date.now() < wait) { /* 空转 5ms 跨过 reset 窗 */ }
  assert.equal(chain.nextSendPaceMs(KEY, 10), 0);
});

t('关掉线性（linearEnabled=false）→ 返回 null，调用方保持旧节奏', () => {
  setup({ ...cfgPerChar, linearEnabled: false });
  assert.equal(chain.nextSendPaceMs(KEY, 10), null);
});

t('count 模式（旧行为）仍可切回：min(cap, base+n*step)', () => {
  setup({ linearMode: 'count', linearBaseMs: 600, linearStepMs: 600, linearCapMs: 1500, linearEnabled: true });
  assert.equal(chain.nextSendPaceMs(KEY, 3), 600);   // 批内第一条
  chain.markSendDelivered(KEY, 3);
  assert.equal(chain.nextSendPaceMs(KEY, 3), 1200);
  chain.markSendDelivered(KEY, 3);
  assert.equal(chain.nextSendPaceMs(KEY, 3), 1500);  // 封顶
});

t('别名映射：social.send 里写 linear* 一律生效（含新三个键）', () => {
  setup({ linearEnabled: true, linearMode: 'perChar', linearPerCharMs: 100, linearMinMs: 0, linearCapMs: 9999, linearJitterRatio: 0 });
  assert.equal(chain.sendLinearEnabled(), true);
  chain.nextSendPaceMs(KEY, 0);
  chain.markSendDelivered(KEY, 0);
  assert.equal(chain.nextSendPaceMs(KEY, 7), 700);
});

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
