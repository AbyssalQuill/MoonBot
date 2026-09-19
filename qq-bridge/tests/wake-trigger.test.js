// 回归测试：唤醒理由的判定优先级 + /set active|diving 指令解析。
//
// 【为什么有这个测试】2026-09-19 主人报："群里 @ 我，我没回。"
// 根因是 evaluateWakeTrigger 把 `triggers.anyMessage` 的判断**排在 @ 前面** —— 群里一旦转成
// "全活跃"（anyMessage=true），"@ 机器人"也被标成 anyMessage；而 scheduleWake 的免打扰时段只放行
// 真实触发（@/提问/点名/拍一拍/私聊），anyMessage 在拦截名单里 → 被 @ 也被跳过。
// 现在 @ 永远优先标成 atMention。
//
// 用法：cd qq-bridge && node tests/wake-trigger.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const mod = (rel) => pathToFileURL(path.join(SRC, rel)).href;

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL  ${name}\n      ${e?.message ?? e}`); }
};

const { evaluateWakeTrigger } = await import(mod('core/wake-send.js'));
const muxMod = await import(mod('core/mux.js'));
const { parseSetModeCommand, parseClockRange, complementWindows } = muxMod;

// ── 构造一个"群里 @ 了机器人"的事件 ──
const SELF = '10000';
const atEvent = (extra = []) => ({
  self_id: SELF,
  user_id: '20000',
  sender: { nickname: '路人' },
  message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' 换成天' } }, ...extra],
});
const plainEvent = () => ({
  self_id: SELF,
  user_id: '20000',
  sender: { nickname: '路人' },
  message: [{ type: 'text', data: { text: '随便说句话' } }],
});
const stWith = (triggers) => ({ wakeConfig: { triggers, mode: triggers.anyMessage ? 'active' : 'diving' } });
const evalIt = (st, event, quote = false) => evaluateWakeTrigger('group:999', st, event, 'group', '换成天', '随便说句话', quote);

console.log('=== 唤醒理由：@ 必须优先于 anyMessage ===');
check('@ + anyMessage → atMention（本次事故的回归）', () => {
  assert.equal(evalIt(stWith({ anyMessage: true, atMention: true }), atEvent()), 'atMention');
});
check('@ + 只开 anyMessage（@ 开关关着）→ 仍是 atMention', () => {
  assert.equal(evalIt(stWith({ anyMessage: true, atMention: false }), atEvent()), 'atMention');
});
check('没 @ + anyMessage → anyMessage（原来这条是对的）', () => {
  assert.equal(evalIt(stWith({ anyMessage: true, atMention: true }), plainEvent()), 'anyMessage');
});
check('引用并回复机器人（quoteTargetIsSelf）+ anyMessage → atMention', () => {
  assert.equal(evalIt(stWith({ anyMessage: true, atMention: true }), plainEvent(), true), 'atMention');
});
check('@ + 只开 atMention → atMention', () => {
  assert.equal(evalIt(stWith({ anyMessage: false, atMention: true }), atEvent()), 'atMention');
});
check('@ 但 @/anyMessage 都关着 → 不再是 atMention（尊重主人的开关）', () => {
  assert.notEqual(evalIt(stWith({ anyMessage: false, atMention: false }), atEvent()), 'atMention');
});
check('私聊一律 private（不受上面影响）', () => {
  assert.equal(evaluateWakeTrigger('private:20000', stWith({ anyMessage: true, atMention: true }), atEvent(), 'private', 'x', 'x', false), 'private');
});

console.log('\n=== 免打扰时段的拦截名单里不能出现"真实触发" ===');
check('social-state.js 的免打扰拦截正则不含 atMention/private/nameMention/question/poke', () => {
  const src = fs.readFileSync(path.join(SRC, 'core', 'social-state.js'), 'utf8');
  const m = src.match(/inDndWindow\(\)\s*&&\s*\/([^/]+)\//);
  assert.ok(m, '没找到免打扰拦截正则');
  const list = m[1];
  for (const real of ['atMention', 'private', 'nameMention', 'question', 'poke', 'speaker']) {
    assert.ok(!new RegExp(`\\b${real}\\b`).test(list), `免打扰拦截名单里不该有 ${real}：${list}`);
  }
  assert.ok(/anyMessage/.test(list), 'anyMessage（普通消息）仍应被免打扰拦掉');
});

console.log('\n=== /set active|diving 指令解析 ===');
check('/set active 09:00-01:00 → 活跃时段 540..1500（跨午夜）', () => {
  assert.deepEqual(parseSetModeCommand('/set active 09:00-01:00'), { mode: 'active', range: { start: 540, end: 1500 } });
});
check('/set diving 00:00-21:00 → mode=diving，补集 = 21:00-24:00', () => {
  const r = parseSetModeCommand('/set diving 00:00-21:00');
  assert.equal(r.mode, 'diving');
  assert.deepEqual(complementWindows(r.range), [{ start: 1260, end: 1440 }]);
});
check('/set active（不带时段）= 全天活跃', () => {
  assert.deepEqual(parseSetModeCommand('/set active'), { mode: 'active', range: null });
});
check('/set diving（不带时段）= 全天潜水', () => {
  assert.deepEqual(parseSetModeCommand('/set diving'), { mode: 'diving', range: null });
});
check('/set mode active / /set mode diving 仍然认（等价老写法）', () => {
  assert.deepEqual(parseSetModeCommand('/set mode active'), { mode: 'active', range: null });
  assert.deepEqual(parseSetModeCommand('/set mode diving'), { mode: 'diving', range: null });
});
check('中英混写的老写法已被移除（/set mode 活跃 / 潜水 不认）', () => {
  assert.equal(parseSetModeCommand('/set mode 活跃'), null);
  assert.equal(parseSetModeCommand('/set mode 潜水'), null);
});
check('~ 分隔符也认：/set diving 00:00~21:00', () => {
  const r = parseSetModeCommand('/set diving 00:00~21:00');
  assert.deepEqual(r.range, { start: 0, end: 1260 });
});
check('时段格式非法 → invalid（不是静默按全天）', () => {
  assert.equal(parseSetModeCommand('/set diving 25:00-26:00').invalid, true);
  assert.equal(parseSetModeCommand('/set diving 00:00-21:00:00').invalid, true);
  assert.equal(parseSetModeCommand('/set active 9点-21点').invalid, true);
});
check('diving 跨午夜 23:00-08:00 → 补集是 08:00-23:00', () => {
  const r = parseSetModeCommand('/set diving 23:00-08:00');
  assert.deepEqual(complementWindows(r.range), [{ start: 480, end: 1380 }]);
});
check('起止相同（00:00-00:00）= 整天 → 补集为空', () => {
  assert.deepEqual(parseClockRange('00:00-00:00'), { start: 0, end: 1440 });
  assert.deepEqual(complementWindows({ start: 0, end: 1440 }), []);
});
check('不相关文本不误判', () => {
  for (const t of ['/set sleep 01:00-06:00', '/status', 'set active', '/setactive']) {
    assert.equal(parseSetModeCommand(t), null, `不该匹配：${t}`);
  }
});

console.log(`\n${failures.length ? `${failures.length} FAILED` : 'ALL PASS'}  (${pass} passed, ${failures.length} failed)`);
process.exit(failures.length ? 1 : 0);
