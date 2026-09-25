// 出站正文形态："被序列化的气泡数组"识别与还原
// 2026-09-20 实测要求：不许把工具参数数组当正文发出去（可还原就还原，还原不了就硬失败）。
// 注：正文的显式换行只写在系统提示词里（preset [TOOLS] 2b），桥侧不做正则清洗 —— 2026-09-20 约定。
// 跑法：node tests/outbound-format.test.js
import assert from 'node:assert/strict';
import {
  splitSerializedBubbles,
  looksLikeSerializedBubbleArray,
} from '../src/lib/text-safe.js';

let passed = 0;
const cases = [];
const t = (name, fn) => cases.push([name, fn]);

/* ── A. "被序列化的气泡数组"：现场原文必须能被还原，且绝不当一条消息发出去 ───────────── */

// 现场原文（2026-09-20 线上抓到的那一条）：引号嵌套 → JSON.parse 必然失败
const SITE_RAW = '["直接跟我说就行", "比如"谬友圈活跃19点到23点"", "或者"所有群免打扰 0点到10点"", "我帮你设 ᗜ ‸ ᗜ"]';

t('A1 现场原文 → 还原成 4 条气泡（嵌套引号不再当一条消息）', () => {
  assert.deepEqual(splitSerializedBubbles(SITE_RAW), [
    '直接跟我说就行',
    '比如"谬友圈活跃19点到23点"',
    '或者"所有群免打扰 0点到10点"',
    '我帮你设 ᗜ ‸ ᗜ',
  ]);
});

t('A2 标准 JSON 数组字符串 → 还原（老兼容路径不能丢）', () => {
  assert.deepEqual(splitSerializedBubbles('["第一句","第二句"]'), ['第一句', '第二句']);
  assert.deepEqual(splitSerializedBubbles('[ "甲" , "乙" ]'), ['甲', '乙']);
});

t('A3 对象包装 {"messages":[...]} → 取出数组', () => {
  assert.deepEqual(splitSerializedBubbles('{"key":"group:1","messages":["甲","乙"]}'), ['甲', '乙']);
});

t('A4 全角/弯引号也能切', () => {
  assert.deepEqual(splitSerializedBubbles('[“甲”, “乙”]'), ['甲', '乙']);
});

t('A5 只有一条的数组（模型把单条也序列化了）→ 认成数组形状', () => {
  assert.equal(splitSerializedBubbles('["只有一句"]') !== null, true);
  assert.equal(looksLikeSerializedBubbleArray('["只有一句"]'), true);
});

t('A6 正常聊天内容一律不是数组形状（防误杀）', () => {
  for (const s of ['你好', '[图片]', '【重要】记得吃饭', '1、第一 2、第二', '[CQ:at,qq=12345] 在吗', '数组长这样 ["a","b"] 但前面还有话']) {
    assert.equal(looksLikeSerializedBubbleArray(s), false, `误杀: ${s}`);
    assert.equal(splitSerializedBubbles(s), null, `误杀: ${s}`);
  }
});

t('A7 代码块里的数组 = 内容，不是参数（``` 包起来就放过）', () => {
  assert.equal(looksLikeSerializedBubbleArray('```\n["a","b"]\n```'), false);
  assert.equal(looksLikeSerializedBubbleArray('[\n  "a",\n  "b"\n]'), false);
});

t('A8 形状对但切不出气泡 → 仍是数组形状（端点据此 400 硬失败）', () => {
  assert.equal(looksLikeSerializedBubbleArray('["", ""]'), false);   // 切完为空 → 不算可还原
  assert.equal(splitSerializedBubbles('["", ""]'), null);
});

/* ── B. 换行不归桥管（2026-09-20 约定）：正文的 \n 原样透传，规则只在提示词里 ────── */

t('B1 正文里的换行原样发出去（桥不做正则清洗）', () => {
  const src = '今天天气真好\n要不要出去玩';
  assert.equal(looksLikeSerializedBubbleArray(src), false);
  assert.equal(splitSerializedBubbles(src), null);
});

t('B2 多行代码/诗歌也不会被桥改写（它只管"是不是数组"）', () => {
  const code = '```js\nconst a = 1;\nconsole.log(a);\n```';
  assert.equal(looksLikeSerializedBubbleArray(code), false);
  assert.equal(splitSerializedBubbles(code), null);
  const poem = '床前明月光\n疑是地上霜';
  assert.equal(looksLikeSerializedBubbleArray(poem), false);
});

t('B3 多行数组（排版过的 JSON）不算"被序列化的一条正文"', () => {
  assert.equal(looksLikeSerializedBubbleArray('[\n  "a",\n  "b"\n]'), false);
});

for (const [name, fn] of cases) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.error(`✗ ${name}\n  ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
console.log(`outbound-format: ${passed}/${cases.length} 通过`);
if (process.exitCode) process.exit(process.exitCode);
