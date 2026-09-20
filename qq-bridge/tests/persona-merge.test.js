// 回归：人格学习"越学越短"不能覆盖旧的长档案
// 【2026-09-20 现场】主人画像本来是几百字成文，一轮只交了 nickname 的学习把它写成了
// `昵称「群魅魔/AbyssalQuill」。`（两个词）—— 旧文被整条覆盖，主人报"我以前是有的是不是被清除了"。
// 跑法：node tests/persona-merge.test.js
import assert from 'node:assert/strict';
import { mergePersonaProfileText } from '../src/core/persona-learn.js';

let passed = 0;
const cases = [];
const t = (name, fn) => cases.push([name, fn]);

const RICH = '昵称「群魅魔」；被叫群魅魔，别人也这样称呼ta；对朋友用@+昵称发起互动。技术能力强，能独立解决设备GUID、'
  + 'NapCat掉登录等底层技术问题，且会与落木等人协作测试；直接坦率，说话不绕弯子；有游戏爱好（三角洲行动），会向群友发起挑战。';
const STUB = '昵称「群魅魔/AbyssalQuill」。';

t('① 只学到两个词 → 保留旧的长档案（不能被写成 stub）', () => {
  const out = mergePersonaProfileText(RICH, STUB);
  assert.ok(out.includes('技术能力强'), '旧内容必须还在');
  assert.ok(out.includes('AbyssalQuill'), '新学到的昵称要补进去，不能丢');
  assert.ok(out.length >= RICH.length, `长度不该缩水：${out.length} < ${RICH.length}`);
});

t('② 真的学到更多 → 以新的为准（越学越全不受影响）', () => {
  const bigger = `${RICH}另外还会写 cpp，喜欢树形DP，半夜也在调设备。`;
  assert.equal(mergePersonaProfileText(RICH, bigger), bigger);
});

t('③ 旧档案本来就短 → 照常覆盖（没内容可保时别拦）', () => {
  assert.equal(mergePersonaProfileText('昵称「甲」。', '昵称「甲/乙」。会写代码，爱打游戏，说话直接。'), '昵称「甲/乙」。会写代码，爱打游戏，说话直接。');
});

t('④ 本轮什么都没产出 → 原样保留旧的', () => {
  assert.equal(mergePersonaProfileText(RICH, ''), RICH);
  assert.equal(mergePersonaProfileText(RICH, '   '), RICH);
});

t('⑤ 旧档案为空 → 用新的', () => {
  assert.equal(mergePersonaProfileText('', STUB), STUB);
});

t('⑥ 新 stub 已经包含在旧文里时不重复追加', () => {
  const prev = `昵称「群魅魔」。${RICH}`;
  const out = mergePersonaProfileText(prev, '昵称「群魅魔」。');
  assert.equal(out, prev, '重复内容不该被追加第二遍');
});

for (const [name, fn] of cases) {
  try { fn(); passed += 1; console.log(`  PASS ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e?.message ?? e}`); process.exitCode = 1; }
}
console.log(`persona-merge: ${passed}/${cases.length} 通过`);
if (process.exitCode) process.exit(process.exitCode);
