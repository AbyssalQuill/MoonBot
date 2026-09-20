// 工具参数漏引号修复（现场：模型把 messages 写成裸文本 → DSH 丢掉该字段 → 发送失败）
// 跑法：node tests/args-repair.test.js
import assert from 'node:assert/strict';
import { repairToolArgs, looksLikeUnquotedArgs } from '../src/lib/args-repair.js';

let passed = 0;
const cases = [];
const t = (name, fn) => cases.push([name, fn]);

// 现场原文（state/tool-calls.jsonl 12:42:32 / 13:2x）
const SITE_1 = '{"key": "private:1736784911", "messages": 主人这么直接啊 我脸都热了, "token": "1736784911"}';
const SITE_2 = '{"key": "private:1736784911", "messages": 就知道会这样，那主人打算怎么办呀, "token": "1736784911"}';
// 现场原文（VPS 会话日志 session-e5ee0b9f… 13:10 的 tool/call 帧，逐字照抄，含全角逗号）
// 这一条是"工具调用报错"的最后一次现场：修好后模型自己重写了一遍才发出去，桥侧兜底应免掉这一步。
const SITE_3 = '{"key": "private:1736784911", "messages": 往上就往上吧，主人想怎么样我又拦不住，就是别嫌我腿抖, "token": "1736784911"}';

t('① 现场原文：裸文本的 messages 能被捞回来（后面还跟着别的键）', () => {
  const a = repairToolArgs(SITE_1);
  assert.deepEqual(a, { key: 'private:1736784911', messages: '主人这么直接啊 我脸都热了', token: '1736784911' });
  const b = repairToolArgs(SITE_2);
  assert.equal(b?.messages, '就知道会这样，那主人打算怎么办呀');
  assert.equal(b?.key, 'private:1736784911');
});

t('② 裸值在最后一个键（后面直接是 }）', () => {
  assert.deepEqual(repairToolArgs('{"key":"private:1","token":"1","messages": 你好呀}'), { key: 'private:1', token: '1', messages: '你好呀' });
});

t('③ 单引号值也一样救（它不是 JSON，但意图明确）', () => {
  assert.deepEqual(repairToolArgs("{'key':'private:1','messages':'你好','token':'1'}"), { key: 'private:1', messages: '你好', token: '1' });
});

t('④ 全角引号 / 末尾多余逗号也修', () => {
  assert.deepEqual(repairToolArgs('{"key":"private:1","messages":"你好",}'), { key: 'private:1', messages: '你好' });
  assert.deepEqual(repairToolArgs('{"key":"private:1","messages":“你好”}'), { key: 'private:1', messages: '你好' });
});

t('⑤ 合法 JSON 原样返回（不当修复器用）', () => {
  assert.deepEqual(repairToolArgs('{"key":"private:1","messages":["甲","乙"]}'), { key: 'private:1', messages: ['甲', '乙'] });
  assert.deepEqual(repairToolArgs('{"key":"private:1","messages":"你好","atUserId":123}'), { key: 'private:1', messages: '你好', atUserId: 123 });
});

t('⑥ 裸值里带逗号/引号也不截断（按下一个键名判断边界）', () => {
  const a = repairToolArgs('{"key":"private:1","messages": 他说"算了, 别问了", 我记着呢, "token":"1"}');
  assert.equal(a?.messages, '他说"算了, 别问了", 我记着呢');
  assert.equal(a?.token, '1');
});

t('⑦ 修不出来就返回 null（绝不猜内容）', () => {
  assert.equal(repairToolArgs('{"key":"private:1",,,'), null);
  assert.equal(repairToolArgs('not json at all'), null);
  assert.equal(repairToolArgs(''), null);
  assert.equal(repairToolArgs('[]'), null);
});

t('⑧ looksLikeUnquotedArgs 只对"漏引号形状"为真', () => {
  assert.equal(looksLikeUnquotedArgs(SITE_1), true);
  assert.equal(looksLikeUnquotedArgs('{"key":"private:1","messages":"你好"}'), false);
  assert.equal(looksLikeUnquotedArgs('随便一句话'), false);
});

t('⑨ 生产现场原文（VPS 会话日志逐字照抄）也认', () => {
  assert.equal(looksLikeUnquotedArgs(SITE_3), true);
  const a = repairToolArgs(SITE_3);
  assert.equal(a?.messages, '往上就往上吧，主人想怎么样我又拦不住，就是别嫌我腿抖');
  assert.equal(a?.key, 'private:1736784911');
  assert.equal(a?.token, '1736784911');
});

t('⑩ 已经在框里的合法参数不会被误改（不该走向兜底）', () => {
  assert.equal(looksLikeUnquotedArgs('{"key":"private:1736784911","messages":["主人~"],"token":"1736784911"}'), false);
  assert.equal(looksLikeUnquotedArgs('{"key":"private:1736784911","messages":"被夸可爱还让乖","token":"1736784911"}'), false);
});

for (const [name, fn] of cases) {
  try { fn(); passed += 1; console.log(`  PASS ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e?.message ?? e}`); process.exitCode = 1; }
}
console.log(`args-repair: ${passed}/${cases.length} 通过`);
if (process.exitCode) process.exit(process.exitCode);
