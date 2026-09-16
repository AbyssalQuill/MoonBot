// 回归测试：atUserId 被传成 messageId 时降级为"不带 @"（2026-09-16 堵住双发的触发源）
//
// 两次真机双发的起点都是同一件事（见 src/lib/at-target.js 顶部）：
//   14:12:34 group:868756515 atUserId=444195792 ← 当时最新一条消息 "@DeepSeek 喵喵喵" 的 messageId
//   14:28:15 group:868756515 atUserId=874987121 ← 同样命中当时 recentMessages 里的 messageId
// 两者都 → NapCat `Get Uid Error` → 工具统一发送**部分成功 1/2 条** → 模型重发整批 → 已送到的那条双发。
//
// 本测试用的 id / QQ 号**全部取自 D:\MoonBot\resources\runtime\qq-bridge\state\social-state.json 的真实现场数据**，
// 其中包括同一个 9 位数值既可能是 messageId（874987121）也可能是真 QQ 号（878281653）——
// 这条正是"为什么不能用长度/位数当判据"的硬证据。
//
// 用法：node tests/at-userid-guard.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sandbox = path.join(HERE, '.tmp-at-guard');
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.cpSync(path.join(HERE, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-at-guard-sandbox', private: true, type: 'module' }));
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({ ownerQQ: '1736784911' }, null, 2));

const url = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const at = await import(url('lib/at-target.js'));
const idem = await import(url('core/send-idempotency.js'));

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

// ── 真机现场数据（social-state.json 的 group:868756515 近窗，原样抄下来当 fixture）──
const LIVE_MESSAGE_IDS = [
  '1574980149', '444195792', '1275818397', '1876144000', '519164613', '315895842', '1430508901',
  '945786507', '926363481', '141835155', '726632647', '1164653649', '619542456', '1595662450',
  '1008901327', '1262070489', '828451864', '44160592', '1997148904', '1161865965', '888907846',
  '1568354737', '606574759', '1792592561', '234019825', '137902571', '874987121', '1677417421',
  '340102602', '68886069', '505027262', '1245827280', '238492435', '232144549', '2044350457', '982106202',
];
const LIVE_ANSWERED_IDS = [
  '1574980149', '444195792', '1262070489', '828451864', '44160592', '1997148904', '1161865965',
  '888907846', '1568354737', '606574759', '1792592561', '234019825', '137902571', '874987121',
];
const LIVE_REAL_QQS = ['1736784911', '1565525244', '3627645831', '2709998617', '878281653', '2462410354', '1322472937'];
const KEY = 'group:868756515';

console.log('== 误传 messageId → 降级为不带 @（不失败）==');

t('现场①：atUserId=444195792（就是当时最新消息的 messageId）→ 判定误传', () => {
  const ev = { messageIds: new Set(LIVE_MESSAGE_IDS) };
  const j = at.judgeAtUserId('444195792', ev);
  assert.equal(j.ok, false);
  assert.equal(j.reason, 'message-id');
});
t('现场②：atUserId=874987121（9 位数字，同样是 messageId）→ 判定误传', () => {
  const j = at.judgeAtUserId('874987121', { messageIds: new Set(LIVE_MESSAGE_IDS) });
  assert.equal(j.ok, false);
  assert.equal(j.reason, 'message-id');
});
t('只出现在 answeredMessageIds 里的 id 也认（两个来源都算账）', () => {
  const j = at.judgeAtUserId('828451864', { messageIds: new Set(LIVE_ANSWERED_IDS) });
  assert.equal(j.ok, false);
  assert.equal(j.reason, 'message-id');
});
t('日志与回执措辞：说清挡了什么、为什么、怎么处理', () => {
  const j = at.judgeAtUserId('1275818397', { messageIds: new Set(LIVE_MESSAGE_IDS) });
  const line = at.logAtUserIdDowngrade(KEY, j);
  assert.match(line, /atUserId=1275818397/);
  assert.match(line, /messageId/);
  assert.match(line, /降级为不带 @ 发送/);
  assert.match(line, /避免整批失败后模型重发造成双发/);
  const note = at.atUserIdDowngradeNote(j);
  assert.match(note, /不带 @/);
  assert.match(note, /QQ 号/);
  assert.match(note, /replyToMessageId/);
});
t('数字型入参（模型传 number 而不是 string）同样能认出来', () => {
  const j = at.judgeAtUserId(874987121, { messageIds: new Set(LIVE_MESSAGE_IDS) });
  assert.equal(j.ok, false);
  assert.equal(j.reason, 'message-id');
});
t('@all / 非数字 → 降级为不带 @，而不是抛错（抛错同样会造成整批失败）', () => {
  const jAll = at.judgeAtUserId('all', { messageIds: new Set(LIVE_MESSAGE_IDS) });
  assert.equal(jAll.ok, false);
  assert.equal(jAll.reason, 'at-all');
  const jBad = at.judgeAtUserId('12abc', { messageIds: new Set() });
  assert.equal(jBad.ok, false);
  assert.equal(jBad.reason, 'not-numeric');
});

console.log('\n== 真 QQ 号必须照常 @（不能误伤，短号也算）==');

t('现场全部 7 个真实 QQ 号（含 9 位短号 878281653）一律放行', () => {
  const ev = { messageIds: new Set([...LIVE_MESSAGE_IDS, ...LIVE_ANSWERED_IDS]) };
  for (const qq of LIVE_REAL_QQS) {
    const j = at.judgeAtUserId(qq, ev);
    assert.equal(j.ok, true, `真 QQ 号被误判：${qq}`);
    assert.equal(j.id, qq);
  }
});
t('✅ 关键反例：9 位的真 QQ 号 878281653 放行，9 位的 messageId 874987121 拦下', () => {
  const ev = { messageIds: new Set(LIVE_MESSAGE_IDS) };
  assert.equal(at.judgeAtUserId('878281653', ev).ok, true, '9 位真 QQ 号不能被当 messageId 拦掉');
  assert.equal(at.judgeAtUserId('874987121', ev).ok, false, '9 位 messageId 必须拦下');
  // 两个都是 9 位、都在同一量级 → 长度/位数**不是**判据（这就是本模块不按位数判断的硬证据）
  assert.equal(String('878281653').length, String('874987121').length);
});
t('5~7 位老短号照常 @（不许拿"位数太少"当理由拦）', () => {
  const ev = { messageIds: new Set(LIVE_MESSAGE_IDS) };
  for (const qq of ['12345', '10001', '1234567']) {
    assert.equal(at.judgeAtUserId(qq, ev).ok, true, `${qq} 被误判`);
  }
});
t('没见过的长号码照常 @（不在 id 集合里就不拦，宁可交 NapCat 判）', () => {
  const ev = { messageIds: new Set(LIVE_MESSAGE_IDS) };
  const j = at.judgeAtUserId('3900000001', ev);
  assert.equal(j.ok, true);
});
t('空 / null / undefined → 本来就没打算 @，不报错也不拦', () => {
  for (const v of ['', '   ', null, undefined]) {
    const j = at.judgeAtUserId(v, { messageIds: new Set(LIVE_MESSAGE_IDS) });
    assert.equal(j.ok, true);
    assert.equal(j.id, '');
  }
});

console.log('\n== 证据收集（判据来源）==');

t('collectAtUserIdEvidence：recentMessages + answeredMessageIds 合并去重', () => {
  const st = {
    recentMessages: [{ messageId: '444195792' }, { messageId: null }, {}, { messageId: 874987121 }],
    answeredMessageIds: ['828451864', '444195792'],
  };
  const ev = at.collectAtUserIdEvidence(st);
  assert.deepEqual([...ev.messageIds].sort(), ['444195792', '828451864', '874987121'].sort());
});
t('collectAtUserIdEvidence：空状态/坏数据不炸', () => {
  assert.equal(at.collectAtUserIdEvidence(null).messageIds.size, 0);
  assert.equal(at.collectAtUserIdEvidence({}).messageIds.size, 0);
  assert.equal(at.collectAtUserIdEvidence({ recentMessages: 'x', answeredMessageIds: 5 }).messageIds.size, 0);
});
t('判据可接受数组形态的 evidence（便于从 JSON 现场复盘）', () => {
  const j = at.judgeAtUserId('444195792', { messageIds: LIVE_MESSAGE_IDS });
  assert.equal(j.ok, false);
});

console.log('\n== 与幂等闸门联动：降级后整批成功 → 不再有"部分失败→重发"这条路 ==');

t('降级后这一批整体成功 → 幂等账本无未了结记录（重发链从源头不存在）', () => {
  idem.__resetIdempotencyForTest();
  const batch = ['行 那以后找你当素材', '不过你确定不怕我画出来'];
  const j = at.judgeAtUserId('874987121', { messageIds: new Set(LIVE_MESSAGE_IDS) });
  assert.equal(j.ok, false);
  const atUserIdEffective = j.ok ? j.id : null;      // ← console-server 的实际接线语义
  assert.equal(atUserIdEffective, null, '降级后传下去的 atUserId 必须是 null（不带 @）');
  // 去掉 @ 的整批成功（不再有 Get Uid Error → 不再有部分失败）
  idem.noteBatchOutcome(KEY, { attempted: batch, delivered: batch.map((x) => ({ text: x })), failed: [] }, 1);
  assert.equal(idem.idempotencyLedger(KEY).pendingPartial, null);
  const r = idem.filterAlreadySentBubbles(KEY, batch, 2);
  assert.equal(r.skipped.length, 0, '整批成功就不该有任何过滤');
  assert.equal(r.kept.length, 2);
});
t('对照（修之前的世界）：带 @ 部分失败 → 账本出现未了结记录 → 重发只能补发一半', () => {
  idem.__resetIdempotencyForTest();
  const batch = ['行 那以后找你当素材', '不过你确定不怕我画出来'];
  idem.noteBatchOutcome(KEY, {
    attempted: batch,
    delivered: [{ text: '不过你确定不怕我画出来', messageId: '68886069' }],
    failed: [new Error('OneBot send_group_msg 失败: Get Uid Error')],
  }, 1);
  assert.notEqual(idem.idempotencyLedger(KEY).pendingPartial, null);
  const r = idem.filterAlreadySentBubbles(KEY, batch, 2);
  assert.deepEqual(r.kept.map((x) => x.text), ['行 那以后找你当素材']);
  assert.deepEqual(r.skipped.map((x) => x.text), ['不过你确定不怕我画出来']);
});

await tAsync('onebotSend 自愈分支存在且只在"uid 解析失败 + 带 @ 段"时去掉 @（静态确认接线）', async () => {
  const src = fs.readFileSync(path.join(sandbox, 'src', 'core', 'qq-send.js'), 'utf8');
  assert.match(src, /Get Uid Error/);
  assert.match(src, /if \(atSegment && uidErrRe\.test\(errText\)\)/);
  // 去掉 @ 段时必须连占位空格一起摘（否则消息会以空格开头）
  assert.match(src, /idxSpacer/);
  // 判据里不允许出现"按位数/长度判断 messageId"的写法（长度在本机完全重叠，不能当判据）
  const atSrc = fs.readFileSync(path.join(sandbox, 'src', 'lib', 'at-target.js'), 'utf8');
  assert.doesNotMatch(atSrc, /length\s*[<>=]=?\s*(1[0-9]|18|19)/, 'at-target.js 不允许按位数判 messageId');
});

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
