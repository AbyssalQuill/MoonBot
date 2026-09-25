// 回归测试：reset 之后同一条回复不能发两遍（2026-09-16 真机事故）
//
// 现场（logs/bridge-local.log，UTC；桥跑在 D:\MoonBot\resources\runtime\qq-bridge）：
//   14:11:54 [send-chain] 已取消 group:*** 的待发任务（会话重置/隔离）          ← reset
//   14:12:12 新会话 group:*** -> session-0e99aedd-…
//   14:12:34 qq_send_message messages=["喵什么喵","又不是猫娘"]（atUserId 传成了 messageId）
//   14:12:35 QQ 发送失败: OneBot send_group_msg 失败: Get Uid Error
//   14:12:36 工具统一发送部分成功 1/2 条，已记录已发消息   ←「又不是猫娘」真的进群了(messageId 1275818397)
//   14:12:47 模型把整批重发一遍（这次不带 @）
//   14:12:49 工具统一发送: 成功 2/2 条                    ←「又不是猫娘」第二次进群(messageId 1430508901)
//   14:13:10 群里报障“好像在reset之后会重复回复一次”
//
// 根因：重复判定只有「整批第一条文本」且只在整批成功后才记账 → 部分失败后重发整批时，
//       已经送出去的那条没有账可挡，于是又发一遍。修法见 src/core/send-idempotency.js。
//
// 用法：node tests/reset-reply-idempotency.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sandbox = path.join(HERE, '.tmp-reset-idem');
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.cpSync(path.join(HERE, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-reset-idem-sandbox', private: true, type: 'module' }));
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({ ownerQQ: '100001' }, null, 2));

const url = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const idem = await import(url('core/send-idempotency.js'));
const chain = await import(url('core/send-chain.js'));

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};
const tAsync = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

const GROUP = 'group:868756515';
const PRIV = 'private:1736784911';
const T0 = 1789567954000; // 现场 14:12:34 附近（毫秒），测试里当成"现在"

console.log('== 现场回归：部分失败后重发整批，已送出的那条不能再发一遍 ==');

t('把 14:12 的现场原样跑一遍：只补发没送出去的那条', () => {
  idem.__resetIdempotencyForTest();
  const batch = ['喵什么喵', '又不是猫娘'];
  // 第一次尝试：只有第 2 条真的送到（对应 QQ 发送失败 Get Uid Error / 部分成功 1/2）
  const first = idem.noteBatchOutcome(GROUP, {
    attempted: batch,
    delivered: [{ text: '又不是猫娘', messageId: '1275818397' }],
    failed: [new Error('OneBot send_group_msg 失败: Get Uid Error')],
  }, T0);
  assert.equal(first.pending, true);
  assert.equal(first.delivered, 1);
  // 模型重发整批（14:12:47）→ 幂等闸门只留没送出去的那条
  const second = idem.filterAlreadySentBubbles(GROUP, batch, T0 + 13000);
  assert.deepEqual(second.kept.map((x) => x.text), ['喵什么喵'], '已送出的「又不是猫娘」必须被摘掉');
  assert.deepEqual(second.skipped.map((x) => x.text), ['又不是猫娘']);
  assert.equal(second.skipped[0].index, 1, '要能指出挡的是第 2 条气泡');
  // 重发成功后账本了结
  idem.noteBatchOutcome(GROUP, { attempted: ['喵什么喵'], delivered: ['喵什么喵'], failed: [] }, T0 + 14000);
  assert.equal(idem.idempotencyLedger(GROUP).pendingPartial, null, '整批成功后就该了结，不再过滤');
});

t('挡下时能给出"哪条、为什么"（日志判据）', () => {
  idem.__resetIdempotencyForTest();
  idem.noteBatchOutcome(GROUP, { attempted: ['甲', '乙'], delivered: ['乙'], failed: [1] }, T0);
  const skipped = idem.filterAlreadySentBubbles(GROUP, ['甲', '乙'], T0 + 1000).skipped;
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].text, '乙');
  assert.equal(skipped[0].index, 1);
});

t('归一化：多一个空格/换行也算同一条，不能溜过去', () => {
  idem.__resetIdempotencyForTest();
  idem.noteBatchOutcome(GROUP, { attempted: ['又不是猫娘'], delivered: ['又不是猫娘'], failed: [1] }, T0);
  const r = idem.filterAlreadySentBubbles(GROUP, ['  又不是猫娘 \n'], T0 + 1000);
  assert.equal(r.kept.length, 0);
  assert.equal(r.skipped.length, 1);
});

console.log('\n== reset 之后重复唤醒同一批消息 → 只发一次 ==');

t('reset 不能把「已回复账本」带走（answeredMessageIds / 水位 / seq 计数器）', () => {
  const prev = {
    answeredMessageIds: ['444195792', '1574980149'],
    lastDeliveredSeq: 63,
    _wakeIntendedSeq: 64,
    lastUnreadSeq: 65,
  };
  const carried = idem.carryReplyLedger(prev);
  assert.deepEqual(carried.patch.answeredMessageIds, ['444195792', '1574980149']);
  assert.equal(carried.patch.lastDeliveredSeq, 63);
  assert.equal(carried.patch._wakeIntendedSeq, 64);
  // 关键坑：seq 计数器必须跟水位一起搬，否则 reset 后新消息 seq 从 1 重新数，
  // 会被 lastDeliveredSeq=63 判成"早就交付过" → 机器人装死不回（比双发更严重）。
  assert.equal(carried.patch.lastUnreadSeq, 65);
  assert.equal(carried.patch._justAutoReset, true, '新会话首轮要带"刚换上下文、别重答旧话题"的提示');
  assert.ok(carried.carried.includes('lastUnreadSeq=65'));
});

t('reset 前后同一批消息：账本在模块级，reset 不清它 → 同一个文本只发一次', () => {
  idem.__resetIdempotencyForTest();
  const batch = ['贴贴~ ᗜ - ᗜ'];
  // 会话重置前这批发了一半失败（典型：第一条成功、第二条失败）
  idem.noteBatchOutcome(PRIV, { attempted: [...batch, '那你呢'], delivered: batch, failed: [1] }, T0);
  // reset（social.conversations.delete(key) 那一刀）：本模块是模块级状态，刻意不随会话状态清空，
  // 所以重置后同一句不会再发一遍。
  const after = idem.filterAlreadySentBubbles(PRIV, batch, T0 + 30000);
  assert.equal(after.kept.length, 0, '重置后重发同一句必须被挡');
  assert.equal(after.skipped.length, 1);
});

console.log('\n== reset 之后的新消息 → 照常回复（不许误杀）==');

t('上一批是成功的：新回复一律畅通', () => {
  idem.__resetIdempotencyForTest();
  idem.noteBatchOutcome(PRIV, { attempted: ['嗯嗯'], delivered: ['嗯嗯'], failed: [] }, T0);
  const r = idem.filterAlreadySentBubbles(PRIV, ['主人今天累不累呀', '嗯嗯'], T0 + 5000);
  assert.equal(r.skipped.length, 0, '整批成功后不存在重发窗口，一条都不许挡');
  assert.equal(r.kept.length, 2);
});

t('部分失败窗口内：没送出去的那条 + 新写的正文照样发', () => {
  idem.__resetIdempotencyForTest();
  idem.noteBatchOutcome(PRIV, { attempted: ['甲', '乙'], delivered: ['甲'], failed: [1] }, T0);
  const r = idem.filterAlreadySentBubbles(PRIV, ['乙', '丙（新写的）'], T0 + 8000);
  assert.deepEqual(r.kept.map((x) => x.text), ['乙', '丙（新写的）']);
  assert.equal(r.skipped.length, 0);
});

t('只挡该会话：另一个会话的相同文本不受影响', () => {
  idem.__resetIdempotencyForTest();
  idem.noteBatchOutcome(GROUP, { attempted: ['嗯嗯'], delivered: ['嗯嗯'], failed: [1] }, T0);
  const r = idem.filterAlreadySentBubbles(PRIV, ['嗯嗯'], T0 + 1000);
  assert.equal(r.kept.length, 1);
  assert.equal(r.skipped.length, 0);
});

t('重发窗口过期（>3min）→ 不再过滤，避免永久误杀', () => {
  idem.__resetIdempotencyForTest();
  idem.noteBatchOutcome(GROUP, { attempted: ['在吗'], delivered: ['在吗'], failed: [1] }, T0);
  const r = idem.filterAlreadySentBubbles(GROUP, ['在吗'], T0 + 181000);
  assert.equal(r.kept.length, 1, '窗口外的相同文本是真人的新回复，必须放行');
  assert.equal(r.skipped.length, 0);
});

t('边界：空 key / 空文本 / 非数组入参都不炸', () => {
  idem.__resetIdempotencyForTest();
  assert.equal(idem.filterAlreadySentBubbles('', ['x'], T0).kept.length, 1);
  assert.equal(idem.filterAlreadySentBubbles(GROUP, null, T0).kept.length, 0);
  idem.noteBatchOutcome('', { attempted: [], delivered: [], failed: [] });
  idem.noteBatchOutcome(GROUP, { attempted: ['  ', '乙'], delivered: ['  '], failed: [1] }, T0);
  const r = idem.filterAlreadySentBubbles(GROUP, ['  ', '乙'], T0 + 1);
  assert.equal(r.skipped.length, 0, '空白正文不参与判重');
  assert.equal(r.kept.length, 2);
});

console.log('\n== 发送任务被取消（reset）→ 不产生双发 ==');

await tAsync('reset 取消"已入链未开始"的任务：旧任务不发，重排后只发一次', async () => {
  const KEY = 'group:100001';
  let sent = 0;
  // 入链但还没开始执行（真实场景：reset 与任务启动之间只隔一个微任务）
  const pending = chain.enqueueSend(async () => { sent += 1; }, KEY);
  chain.cancelKeyedSends(KEY);           // ← reset
  await pending;
  assert.equal(sent, 0, '已取消的待发任务不能在 reset 之后再发出去');
  // reset 后模型重新发一遍：只应发生一次
  await chain.enqueueSend(async () => { sent += 1; }, KEY);
  assert.equal(sent, 1, '重排只允许发一次（双发就在这里发生）');
});

await tAsync('reset 与入链交错：取消代际必须把旧世代的全部任务挡住', async () => {
  const KEY = 'private:100001';
  let sent = 0;
  const a = chain.enqueueSend(async () => { sent += 1; }, KEY);
  const b = chain.enqueueSend(async () => { sent += 1; }, KEY);
  chain.cancelKeyedSends(KEY);
  await Promise.allSettled([a, b]);
  assert.equal(sent, 0, '同世代的两条都必须被跳过');
  await chain.enqueueSend(async () => { sent += 1; }, KEY);
  assert.equal(sent, 1);
});

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
