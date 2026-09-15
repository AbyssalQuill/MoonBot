// 私聊「不抢话」决策的单测（core/typing-hold.js）。
// 纯函数、无副作用：喂进"对方打字到什么时候 / 从什么时候开始打 / 配置"，检查该等还是该插话。
import assert from 'node:assert/strict';
import { typingCfg, typingHoldDecision, typingHoldText, TYPING_DEFAULTS } from '../src/core/typing-hold.js';

let pass = 0, fail = 0;
const cases = [];
const t = (name, fn) => cases.push([name, fn]);

const CFG = (over = {}) => ({ social: { typing: over } });

t('默认配置可用，且做范围收敛', () => {
  const c = typingCfg(CFG({}));
  assert.equal(c.enabled, true);
  assert.equal(c.holdMaxMs, TYPING_DEFAULTS.holdMaxMs);
  assert.equal(c.breakProbability, TYPING_DEFAULTS.breakProbability);
  // 越界值被夹住
  const wild = typingCfg(CFG({ holdMaxMs: 10 ** 9, breakProbability: 3, refreshOnMessageMs: -5 }));
  assert.equal(wild.holdMaxMs, 60000);
  assert.equal(wild.breakProbability, 1);
  assert.equal(wild.refreshOnMessageMs, 0);
});

t('总开关关掉：永远不等待', () => {
  const d = typingHoldDecision({ typingUntil: Date.now() + 5000, cfg: CFG({ enabled: false }), rand: () => 0 });
  assert.equal(d.wait, false);
  assert.equal(d.breakIn, false);
  assert.equal(d.reason, 'disabled');
});

t('对方没在打字：不等待也不叫插话', () => {
  const d = typingHoldDecision({ typingUntil: Date.now() - 1, cfg: CFG({}), rand: () => 0 });
  assert.equal(d.wait, false);
  assert.equal(d.breakIn, false);
  assert.equal(d.reason, 'not-typing');
});

t('对方在打字 + 骰子没命中 → 等（这是"不抢话"的默认行为）', () => {
  const now = Date.now();
  const d = typingHoldDecision({ typingUntil: now + 4000, since: now - 1000, now, cfg: CFG({ breakProbability: 0.2 }), rand: () => 0.9 });
  assert.equal(d.wait, true);
  assert.equal(d.breakIn, false);
  assert.equal(d.reason, 'typing-hold');
  assert.equal(d.remainMs, 4000);
  assert.match(typingHoldText(d, 'private:1'), /等 ta 打完/);
});

t('对方在打字 + 骰子命中 → 插话（"智能接话"）', () => {
  const now = Date.now();
  const d = typingHoldDecision({ typingUntil: now + 4000, since: now - 1000, now, cfg: CFG({ breakProbability: 0.3 }), rand: () => 0.1 });
  assert.equal(d.wait, false);
  assert.equal(d.breakIn, true);
  assert.equal(d.reason, 'dice-hit');
  assert.equal(d.roll, 0.1);
  assert.match(typingHoldText(d), /骰子命中插话/);
});

t('等太久到上限 → 不再等（避免遇到"打字没完"的人永不回复）', () => {
  const now = Date.now();
  const d = typingHoldDecision({ typingUntil: now + 30000, since: now - 12000, now, cfg: CFG({ holdMaxMs: 12000 }), rand: () => 0.99 });
  assert.equal(d.wait, false);
  assert.equal(d.breakIn, true);
  assert.equal(d.reason, 'cap-reached');
  assert.match(typingHoldText(d), /上限 12s/);
});

t('插话概率 0 = 从不插话（只等对方停）；概率 1 = 从不等待', () => {
  const now = Date.now();
  const wait = typingHoldDecision({ typingUntil: now + 2000, since: now, now, cfg: CFG({ breakProbability: 0 }), rand: () => 0 });
  assert.equal(wait.wait, true, '概率 0 时即使 rand=0 也该等');
  const never = typingHoldDecision({ typingUntil: now + 2000, since: now, now, cfg: CFG({ breakProbability: 1 }), rand: () => 0.999 });
  assert.equal(never.breakIn, true, '概率 1 时永远插话');
});

t('没给 since：按"刚开始打"处理，仍会等', () => {
  const now = Date.now();
  const d = typingHoldDecision({ typingUntil: now + 3000, now, cfg: CFG({}), rand: () => 0.9 });
  assert.equal(d.wait, true);
  assert.equal(d.heldForMs, 0);
});

for (const [name, fn] of cases) {
  try { await fn(); pass += 1; }
  catch (e) { fail += 1; console.error(`FAIL: ${name}\n      ${e?.message ?? e}`); }
}
if (fail === 0) console.log(`typing-hold 私聊不抢话决策测试全部通过 ✓  pass=${pass} fail=0`);
else { console.error(`typing-hold 测试失败：pass=${pass} fail=${fail}`); process.exitCode = 1; }
