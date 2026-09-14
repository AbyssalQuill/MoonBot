// 回归测试：自动智能引用（2026-09-15 修「引用错误 / 看着像重复回复」）
//
// 主人反馈（原话，略去账号）："私聊有严重问题，重复回复，引用错误，无法回表情包"
//
// 线上真实故障（服务器 NapCat 日志，北京时间 2026-09-14）：
//   22:52:00 [回复消息 等我以后给你接入MC一起玩吧~] 说好了啊
//   22:52:23 [回复消息 等我以后给你接入MC一起玩吧~] 那就说定了     ← 明明在答"有机会的话~"
//   22:52:30 [回复消息 等我以后给你接入MC一起玩吧~] 笑啥           ← 明明在答"嘿嘿"
//   22:53:35 [回复消息 等我以后给你接入MC一起玩吧~] 私聊发不了表情包呜呜 ← 明明在答"多发几个鲸鱼表情包嘛"
// 四条回复全引用了同一条 90 秒前的老消息 → 主人看到的就是「引用错误 + 重复回复」。
// 旧打分给它固定 +3（因为它 quoteTargetIsSelf=true）且**没有任何时效约束/同分取更早的一条**，
// 于是它永远压过所有新消息。
//
// 用法：node tests/smart-quote.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-quote-'));
fs.cpSync(path.join(here, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-quote-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({ ownerQQ: '100001', dsh: { baseUrl: 'http://127.0.0.1:10721' } }, null, 2));

const url = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const { pickSmartQuote, smartQuoteGrams } = await import(url('core/qq-send.js'));

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

// ── 线上那条私聊的真实时间线（相对时间，B = 22:52:00）────────────────────────
const B = Date.parse('2026-09-14T22:52:00+08:00');
const at = (s) => B + s * 1000;
const MC = '1494857675';       // seq59 「等我以后给你接入MC一起玩吧~」（引用了 bot 的那条）
const CHANCE = '681931430';    // seq60 「有机会的话~」
const HEHE = '833632023';      // seq61 「嘿嘿」
const MEME = '1576139927';     // seq62 「多发几个鲸鱼表情包嘛」
const SWIM = '1292771769';     // seq58 「和我玩mc」

const baseMessages = () => ([
  { seq: 58, time: at(-352), isSelf: false, messageId: SWIM, plain: '和我玩mc' },
  { time: at(-268), isSelf: true, messageId: '1209130826', plain: 'mc还玩不' },
  { seq: 59, time: at(-10), isSelf: false, messageId: MC, plain: '等我以后给你接入MC一起玩吧~', quoteTargetIsSelf: true },
  { seq: 60, time: at(-4), isSelf: false, messageId: CHANCE, plain: '有机会的话~' },
  { time: at(0), isSelf: true, messageId: '726122820', plain: '说好了啊' },
  { time: at(1), isSelf: true, messageId: '588698186', plain: '到时候别忘了 ᗜ - ᗜ' },
  { seq: 61, time: at(5), isSelf: false, messageId: HEHE, plain: '嘿嘿' },
  { seq: 62, time: at(30), isSelf: false, messageId: MEME, plain: '多发几个鲸鱼表情包嘛' },
]);

console.log('== 智能引用 ==');

t('唤醒展示了 seq59 时，"说好了啊" 引用 seq59（正确的引用要保留）', () => {
  const st = { recentMessages: baseMessages(), turnSeenUnread: [59], turnSteeredSeqs: [] };
  assert.equal(pickSmartQuote(st, '说好了啊', { now: at(0), record: false }), MC);
});

t('【回归】step 边界注入 seq60 后，"那就说定了" 不再引用老消息 seq59，而是引用 seq60', () => {
  const st = { recentMessages: baseMessages(), turnSeenUnread: [59], turnSteeredSeqs: [60] };
  const got = pickSmartQuote(st, '那就说定了 ᗜ ᴗ ᗜ', { now: at(23), record: false });
  assert.notEqual(got, MC, '不得再引用那条老消息（旧 bug）');
  assert.equal(got, CHANCE);
});

t('注入 seq61 后，"笑啥" 引用 seq61（同分取更新的一条）', () => {
  const st = { recentMessages: baseMessages(), turnSeenUnread: [59], turnSteeredSeqs: [60, 61] };
  assert.equal(pickSmartQuote(st, '笑啥 ᗜ - ᗜ', { now: at(30), record: false }), HEHE);
});

t('注入 seq62 后，"私聊发不了表情包呜呜 群里给你发" 按共同词（表情包）引用 seq62', () => {
  const st = { recentMessages: baseMessages(), turnSeenUnread: [59], turnSteeredSeqs: [60, 61, 62] };
  assert.equal(pickSmartQuote(st, '私聊发不了表情包呜呜 群里给你发 ᗜ ‸ ᗜ', { now: at(95), record: false }), MEME);
});

t('共同词优先于"更新"：同一批里明确在答更早那条时，引用更早那条', () => {
  const st = {
    recentMessages: [
      { seq: 1, time: at(0), isSelf: false, messageId: '111', plain: '晚上一起打三角洲吗' },
      { seq: 2, time: at(20), isSelf: false, messageId: '222', plain: '随便聊聊天气' },
    ],
    turnSeenUnread: [1, 2], turnSteeredSeqs: [],
  };
  assert.equal(pickSmartQuote(st, '三角洲我玩得菜', { now: at(25), record: false }), '111');
});

t('写回 recentQuoteIds：同一条不会被反复自动引用', () => {
  const st = { recentMessages: baseMessages(), turnSeenUnread: [59], turnSteeredSeqs: [], recentQuoteIds: [] };
  assert.equal(pickSmartQuote(st, '说好了啊', { now: at(0) }), MC);
  assert.equal(pickSmartQuote(st, '说好了啊', { now: at(1) }), null);
  assert.equal(Array.isArray(st.recentQuoteIds) && st.recentQuoteIds.length, 1);
});

t('超过 10 分钟的候选不参与', () => {
  const st = { recentMessages: baseMessages(), turnSeenUnread: [58, 59], turnSteeredSeqs: [] };
  assert.equal(pickSmartQuote(st, '和我玩mc', { now: at(601), record: false }), null);
});

t('没有投递记录（主动发起/控制台）→ 刚到的（2 分钟内）最新一条', () => {
  const st = { recentMessages: baseMessages(), turnSeenUnread: [], turnSteeredSeqs: [] };
  assert.equal(pickSmartQuote(st, '在干嘛呢', { now: at(35), record: false }), MEME);
  assert.equal(pickSmartQuote(st, '在干嘛呢', { now: at(200), record: false }), null);
});

t('群聊 @我 的老消息不再压过刚刚的新消息', () => {
  const st = {
    recentMessages: [
      { seq: 10, time: at(-300), isSelf: false, messageId: '900', plain: '@我 这个怎么配', atSelf: true },
      { seq: 11, time: at(-2), isSelf: false, messageId: '901', plain: '话说午饭吃啥' },
    ],
    turnSeenUnread: [10, 11], turnSteeredSeqs: [],
  };
  assert.equal(pickSmartQuote(st, '午饭吃啥都行', { now: at(0), record: false }), '901');
});

t('没有对端消息 → 不引用', () => {
  const st = { recentMessages: [{ time: at(0), isSelf: true, messageId: '1', plain: '我' }], turnSeenUnread: [], turnSteeredSeqs: [] };
  assert.equal(pickSmartQuote(st, '你好', { now: at(1), record: false }), null);
});

t('分词：中文 2-gram + 英文/数字词', () => {
  const g = smartQuoteGrams('三角洲 MC 好玩吗');
  assert.ok(g.has('三角') && g.has('洲m') === false);
  assert.ok(g.has('mc') === false, '两字符英文词不入库');
  assert.ok(g.has('好玩') && g.has('玩吗'));
});

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
