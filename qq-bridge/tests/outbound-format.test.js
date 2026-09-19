// 出站正文形态：换行折叠 + "被序列化的气泡数组"识别与还原
// 【2026-09-20 主人实测要求】正文不许显式带换行（代码/诗歌除外）、不许把工具参数数组当正文发出去。
// 跑法：node tests/outbound-format.test.js
import assert from 'node:assert/strict';
import {
  collapseExplicitNewlines,
  looksLikeCodeBlock,
  looksLikeVerse,
  splitSerializedBubbles,
  looksLikeSerializedBubbleArray,
} from '../src/lib/text-safe.js';

let passed = 0;
const cases = [];
const t = (name, fn) => cases.push([name, fn]);

/* ── A. "被序列化的气泡数组"：现场原文必须能被还原，且绝不当一条消息发出去 ───────────── */

// 现场原文（主人 2026-09-20 贴的那一条）：引号嵌套 → JSON.parse 必然失败
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

/* ── B. 显式换行折叠：普通正文压成一行，代码/诗歌原样保留 ─────────────────────────── */

t('B1 中文相邻：换行直接连起来（不留空格）', () => {
  assert.equal(collapseExplicitNewlines('今天天气真好\n要不要出去玩'), '今天天气真好要不要出去玩');
  assert.equal(collapseExplicitNewlines('第一行\n\n第二行'), '第一行第二行');
  assert.equal(collapseExplicitNewlines('我帮你设 ᗜ ‸ ᗜ\n晚安'), '我帮你设 ᗜ ‸ ᗜ晚安');
});

t('B2 英文/数字相邻：换行换成一个空格', () => {
  assert.equal(collapseExplicitNewlines('hello\nworld'), 'hello world');
  assert.equal(collapseExplicitNewlines('version 1.2.0\n   build ok'), 'version 1.2.0 build ok');
});

t('B3 没有换行的正文原样返回', () => {
  assert.equal(collapseExplicitNewlines('就一句话'), '就一句话');
  assert.equal(collapseExplicitNewlines(''), '');
});

t('B4 代码原样保留（围栏 / 缩进 / 代码标点）', () => {
  const fenced = '```js\nconst a = 1;\nconsole.log(a);\n```';
  assert.equal(collapseExplicitNewlines(fenced), fenced);
  const indented = 'function f() {\n  return 1;\n}';
  assert.equal(collapseExplicitNewlines(indented), indented);
  assert.equal(looksLikeCodeBlock(indented), true);
});

t('B5 诗歌/诗词原样保留（等长行、诗标点收尾）', () => {
  const wuyan = '床前明月光\n疑是地上霜';
  assert.equal(collapseExplicitNewlines(wuyan), wuyan);
  const lvshi = '春眠不觉晓，\n处处闻啼鸟。';
  assert.equal(collapseExplicitNewlines(lvshi), lvshi);
  assert.equal(looksLikeVerse(wuyan), true);
  assert.equal(looksLikeVerse(lvshi), true);
});

t('B6 被模型拆行的普通闲聊 → 折叠（不是诗）', () => {
  assert.equal(looksLikeVerse('今天天气真好\n要不要出去玩'), false);
  assert.equal(collapseExplicitNewlines('好的\n我知道\n马上来'), '好的我知道马上来');
  assert.equal(collapseExplicitNewlines('这个是长句子的说明文字\n下一行也是普通说明文字'), '这个是长句子的说明文字下一行也是普通说明文字');
});

t('B7 代码类/长技术文本 >50 字不分段（换行折叠不改字数上限）', () => {
  const long = '这个函数的第一个参数是 key，第二个参数是 token，两个都必须传，缺一个就会 403，返回体里会告诉我们到底缺了哪一个。';
  assert.equal(long.length > 50, true);
  assert.equal(collapseExplicitNewlines(long), long);
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
