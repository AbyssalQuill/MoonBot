// 回归测试：一个模型步 = 一个 [Mid-turn] 块（合并注入，2026-09-15）
//
// 反馈（原话）："我相隔极端时间的消息好像 dsh 的思考里不会同时获取到，然后两条不是两个注入吗
// 它会等第一个注入处理完到第二个注入再处理下一条，我倒是希望它能省去第二次注入然后思考过程中还能获取到消息"。
//
// 本测试用 mock 的 DSH api 驱动真实的 src/core 模块（绝不动真配置/真状态）：
//   ① 同一个模型步里、相隔一段时间到达的两条消息 → 只产生一个 [Mid-turn] 块，两条都在里面；
//   ② 两个步边界注入器都能把这批带走：`step/end`（flushStepBatch）与回合钩子（handleTurnHold）；
//   ③ 步边界机制失效时必须有兜底（错过步边界 → 放行即时注入），消息绝不被静默卡住；
//   ④ 非保持会话（群聊 / turn-hold 关）行为保持原样（立刻注入，不攒）。
//
// 用法：node tests/steer-merge.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-merge-'));
fs.cpSync(path.join(here, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-merge-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({
  ownerQQ: '123456789',
  dsh: { baseUrl: 'http://127.0.0.1:10721' },
  social: {
    steerEnabled: true,
    // 线上私聊配置：turn-hold 打开、全部私聊、长保持
    turnHold: { enabled: true, keys: [], privateOnly: true, maxExchanges: 24, idleCloseMs: 1800000, maxWaitMs: 3600000, requestBudgetMs: 55000 },
  },
}, null, 2));

const url = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const cfgMod = await import(url('core/config.js'));
const stateMod = await import(url('core/session-state.js'));
const socialMod = await import(url('core/social-state.js'));
const modeMod = await import(url('core/mode.js'));
const wakeMod = await import(url('core/wake-send.js'));
const holdMod = await import(url('core/turn-hold.js'));

const cfg = cfgMod.loadConfig();
modeMod.initModeCore(cfg);
wakeMod.initWakeCore(cfg);
socialMod.initSocialCore(cfg);

const KEY = `private:${cfg.ownerQQ}`;
const SID = 'session-merge-test';

// —— mock DSH：只记录"注入了几个块、每个块带了几条" ——
const sent = [];   // { text, mode, lines }
wakeMod.setWakeApi({
  sessions: {
    prompt: async (args) => {
      const text = String(args.content?.[0]?.text ?? '');
      sent.push({ text, mode: args.mode, lines: text.split('\n').filter((l) => /^(owner|uid:|[^\s(]+\(id:)/.test(l)).length });
      return { result: { ok: true } };
    },
  },
});

let fails = 0;
const check = (name, ok, extra = '') => {
  if (!ok) fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what} 超时 ${ms}ms`); })]);

// —— 造一个"回合正在跑、且由回合保持托管"的会话 ——
cfgMod.state.sessions[KEY] = SID;
stateMod.reverse.set(SID, KEY);
stateMod.TurnStartAt.set(SID, Date.now());
stateMod.agentRunningSessions.add(SID);
const st = socialMod.getSocialState(KEY);
st.agentToken = 'tok-merge';
st.unread = [];
st.recentMessages = [];
st.turnSeenUnread = [];
st.turnSteeredSeqs = [];
st.lastUnreadSeq = 0;
st.lastDeliveredSeq = 0;
st._steerDeferredSeqs = [];

let seqNo = 0;
const push = (text) => {
  seqNo += 1;
  const row = {
    seq: seqNo, messageId: `m${seqNo}`, sender: '主人', userId: cfg.ownerQQ, isOwner: true,
    plain: text, text, isSelf: false, time: Date.now(), atSelf: false, hasMedia: false,
  };
  st.unread.push(row);
  st.recentMessages.push(row);
  st.lastUnreadSeq = Math.max(Number(st.lastUnreadSeq) || 0, seqNo);
  return seqNo;
};
const midTurnBlocks = () => sent.filter((s) => /\[Mid-turn\]/.test(s.text));

console.log('=== ① 同一个模型步里，相隔一会儿到达的两条消息 ===');
const s1 = push('第一条：在忙吗');
// 消息到达 → scheduleWake 的合并窗 → 送到 busy 分支（非 force 调用，与线上完全一致）
const r1 = await wakeMod.steerIntoRunningTurn(KEY, 'private');
check('① 第一条到的时候**不半路注入**（攒进本步批次）', sent.length === 0, `已注入 ${sent.length} 次`);
check('① 返回 true（调用方语义：不用你另起一轮/别再投）', r1 === true, String(r1));
check('① 第一条记进"推迟交付"名单（mark_read 不能吞它）', (st._steerDeferredSeqs || []).map(Number).includes(s1), JSON.stringify(st._steerDeferredSeqs));
check('① 第一条**没有**被标成"已给过"（仍在未读里）', !(st.turnSteeredSeqs || []).map(Number).includes(s1), JSON.stringify(st.turnSteeredSeqs));

await sleep(1200);   // ← 上面说的"相隔极端时间"：不是同一瞬间连发
const s2 = push('第二条：算了你忙你的');
const r2 = await wakeMod.steerIntoRunningTurn(KEY, 'private');
check('① 第二条到的时候**也还是攒着**（没有第二次注入）', sent.length === 0, `已注入 ${sent.length} 次`);
check('① 两条都在"推迟交付"名单里', [s1, s2].every((n) => (st._steerDeferredSeqs || []).map(Number).includes(n)), JSON.stringify(st._steerDeferredSeqs));
check('① 两次调用都返回 true', r1 === true && r2 === true);

console.log('=== ② 步边界发车（mux 收到 step/end 时调用的 flushStepBatch）===');
const flushed = await holdMod.flushStepBatch({ key: KEY, sid: SID, turn: 7, cfg });
check('② 步边界发车成功', flushed === true, String(flushed));
check('② **只注入了一次**（两条合成一个块，而不是两个注入）', sent.length === 1, `注入次数=${sent.length}`);
const block1 = sent[0]?.text ?? '';
check('② 投递方式仍是 steer（唯一投递原语）', sent[0]?.mode === 'steer', String(sent[0]?.mode));
check('② 块头写的是 2 条', /\[Mid-turn\] 2 new message\(s\) after your last bubble - not answered yet\./.test(block1), JSON.stringify(block1.split('\n')[1] ?? ''));
check('② 第一条正文在块里', /第一条：在忙吗/.test(block1));
check('② 第二条正文也在同一个块里', /第二条：算了你忙你的/.test(block1));
check('② 块里只有 1 个 [Mid-turn] 头', (block1.match(/\[Mid-turn\]/g) || []).length === 1);
check('② 注入后两条都进了 turnSteeredSeqs', [s1, s2].every((n) => (st.turnSteeredSeqs || []).map(Number).includes(n)), JSON.stringify(st.turnSteeredSeqs));
check('② 交付水位推到第二条', Number(st.lastDeliveredSeq) === s2, String(st.lastDeliveredSeq));
check('② 已投出去的 seq 从"推迟交付"名单里收掉（否则永远清不掉未读）', ![s1, s2].some((n) => (st._steerDeferredSeqs || []).map(Number).includes(n)), JSON.stringify(st._steerDeferredSeqs));

console.log('=== ③ 下一个模型步：又来两条（消息 3、4）→ 仍然只有一个块 ===');
push('第三条：我到家了');
await wakeMod.steerIntoRunningTurn(KEY, 'private');
push('第四条：你吃饭没');
// 步边界：先复位闸门（mux 在 step/end 里做的第一件事），再发车
wakeMod.markSteerCycleStart(KEY, 'step/end');
await holdMod.flushStepBatch({ key: KEY, sid: SID, turn: 8, cfg });
check('③ 第二个步边界同样只产生一个块', sent.length === 2, `注入次数=${sent.length}`);
const block2 = sent[1]?.text ?? '';
check('③ 这个块里是第三、第四条（两条一起）', /第三条：我到家了/.test(block2) && /第四条：你吃饭没/.test(block2) && /\[Mid-turn\] 2 /.test(block2));
check('③ 块里没有上一批的旧消息（不重复投喂）', !/第一条/.test(block2));
check('③ 四条消息总共只注入了 2 次（= 2 个模型步，而不是 4 次）', midTurnBlocks().length === 2, `[Mid-turn] 块数=${midTurnBlocks().length}`);

console.log('=== ④ 兜底：步边界机制失效（跨过步边界仍未投出）→ 放行即时注入，绝不静默卡住 ===');
push('第五条：怎么不说话了');
await wakeMod.steerIntoRunningTurn(KEY, 'private');
check('④ 第五条先被攒住', sent.length === 2, `注入次数=${sent.length}`);
// 模拟"步边界来了、但发车失败"（例如 flushStepBatch 那次 steer 被 DSH 拒了）：
wakeMod.markSteerCycleStart(KEY, 'step/end');
await sleep(1100);
push('第六条：喂');
const r6 = await wakeMod.steerIntoRunningTurn(KEY, 'private');
check('④ 错过步边界后**立刻投**（不再等）', sent.length === 3, `注入次数=${sent.length}`);
const block3 = sent[2]?.text ?? '';
check('④ 兜底这一投也把两条合成一个块', /第五条/.test(block3) && /第六条/.test(block3) && /\[Mid-turn\] 2 /.test(block3), JSON.stringify(block3.split('\n')[1] ?? ''));
check('④ 兜底调用返回 true', r6 === true, String(r6));

console.log('=== ⑤ 保持循环（agent/turn-stopping 钩子）也能带走"钩子开始前就到达"的消息 ===');
// 这一步是关键：合并注入把消息攒在 unread 里，它们比钩子开始得更早 ——
// 保持循环若还按旧的 `lastUnreadSeq > baseline` 判据，就一条都看不见，只会干等到预算用完。
push('第七条：在吗');
push('第八条：同时发的两条');
const held = await withTimeout(holdMod.handleTurnHold({ sessionId: SID, turn: 11, cfg, shouldAbort: () => false }), 15000, 'handleTurnHold');
check('⑤ 钩子把这一批带走了（close=false → 回合不关，继续跑下一步）', held?.close === false, JSON.stringify(held));
check('⑤ 钩子这一批只产生一个块', sent.length === 4, `注入次数=${sent.length}`);
const block4 = sent[3]?.text ?? '';
check('⑤ 块里是第七、第八条', /第七条：在吗/.test(block4) && /第八条：同时发的两条/.test(block4) && /\[Mid-turn\] 2 /.test(block4));
check('⑤ 钩子明确了是"注入了一批"而不是放行关回合', held?.reason === 'steered', String(held?.reason));

console.log('=== ⑥ 非保持会话（turn-hold 关，例如群聊）行为保持原样：立刻注入、不攒 ===');
cfg.social.turnHold.enabled = false;
stateMod.holdActiveKeys.delete(KEY);
// 线上每一步 mux 都会在 step/end 复位注入闸门；这里照做一次，等价于"非保持会话在新的一步里收到消息"。
wakeMod.markSteerCycleStart(KEY, 'step/end');
const before = sent.length;
push('第九条：群聊里的消息');
const r9 = await wakeMod.steerIntoRunningTurn(KEY, 'group');
check('⑥ 非保持会话立刻注入（不是攒着）', sent.length === before + 1, `注入次数=${sent.length - before}`);
check('⑥ 立刻注入的返回 true', r9 === true, String(r9));
check('⑥ 非保持会话这一投把第九条带上了', /第九条：群聊里的消息/.test(sent[sent.length - 1]?.text ?? ''));
check('⑥ 非保持会话不写"推迟交付"名单（那条路只在保持托管里用）', !(st._steerDeferredSeqs || []).map(Number).includes(seqNo), JSON.stringify(st._steerDeferredSeqs));

// 对照实验（这就是改动前的行为，非保持会话刻意保持原样）：同一模型步里相隔一会儿的两条消息
// → 两个注入、两个块。保持托管那条路现在是 1 个块（见 ①~③），对比一眼可见。
await sleep(1700);   // 越过非保持会话的短周期闸（1500ms）
wakeMod.markSteerCycleStart(KEY, 'step/end');
push('第十条：群聊里隔了一会儿的第二条');
await wakeMod.steerIntoRunningTurn(KEY, 'group');
check('⑥ 对照：非保持会话里两条相隔的消息 = 两个注入（保持托管会话是同一步合并成一个）', sent.length === before + 2, `注入次数=${sent.length - before}`);
check('⑥ 对照：第二个块只带第十条（不是把两条又合起来投一遍）', /第十条/.test(sent[sent.length - 1]?.text ?? '') && !/第九条/.test(sent[sent.length - 1]?.text ?? ''));

console.log('=== ⑦ 对方还在打字 → 一条都不投，等 ta 打完合成一次注入（2026-09-16 主人要求）===');
// 原话："这两句应该检测我的输入状态然后合并成 [Mid-turn] 2 new message(s)"。
// 线上实测（09-15 15:54~15:58）：他连着发了 5 条，桥在每个模型步边界各注入一次 ——
// 对话窗口里就是 5 个独立的 `[Mid-turn] 1 new message(s)`。原因：打字判定只管"要不要新起一轮"，
// 在途回合的注入完全不看输入状态。现在这条路上也接上同一个判据（typing-hold.js）。
cfg.social.turnHold.enabled = true;
stateMod.holdActiveKeys.add(KEY);
// 骰子写成 0（绝不插话），这样"等"这一支是确定的，不受随机影响
cfg.social.typing = { enabled: true, holdMaxMs: 12000, refreshOnMessageMs: 5000, breakProbability: 0 };
// 2026-09-16 晚 语义收紧（修「思考期间到的消息被塞进下一个唤醒」）："允许短暂延迟"多了一条前提：
// 本回合已经发出去过气泡（= 真的在连发/打字保持中）。模型还在生成、这一轮一条都还没发时，
// 一律改成"注入当前轮"（对话窗口里都还没有气泡，"不抢话"无从谈起）—— 那一条覆盖在新测试
// tests/mid-turn-steer.test.js 里。这里按 mux 线上记法补上"本回合已发过气泡"这个前提。
stateMod.sendToolSucceededSessions.add(SID);
wakeMod.markSteerCycleStart(KEY, 'step/end');
const ty1 = push('打字那条：第一条');
const ty2 = push('打字那条：第二条');
st.peerTypingUntil = Date.now() + 8000;   // QQ 的 input_status 刚报过"正在输入"
st.peerTypingSince = Date.now();
const before7 = sent.length;
const deferRes = await wakeMod.steerIntoRunningTurn(KEY, 'turnHold', { force: true });
check('⑦ 保持循环拿到明确的"推迟"信号（typing-defer，而不是"失败"）', deferRes === 'typing-defer', String(deferRes));
const f7a = await holdMod.flushStepBatch({ key: KEY, sid: SID, turn: 12, cfg });
check('⑦ 打字期间步边界**不发车**（一条都不投）', f7a === false && sent.length === before7, `注入次数=${sent.length - before7}`);
check('⑦ 两条都还没被标"已给过"（下一次还能带走）', ![ty1, ty2].some((n) => (st.turnSteeredSeqs || []).map(Number).includes(n)), JSON.stringify(st.turnSteeredSeqs));

// 对方停止输入（QQ 的 stop 事件把 peerTypingUntil 清零，events-aux.js 就是这么干的）
st.peerTypingUntil = 0;
st.peerTypingSince = 0;
wakeMod.markSteerCycleStart(KEY, 'step/end');
const f7b = await holdMod.flushStepBatch({ key: KEY, sid: SID, turn: 12, cfg });
const block7 = sent[sent.length - 1]?.text ?? '';
check('⑦ 打完字后**一次**注入，两条在同一个块里', f7b === true && block7.includes('[Mid-turn] 2 new message(s)') && block7.includes('打字那条：第一条') && block7.includes('打字那条：第二条'), JSON.stringify(block7.split('\n')[1] ?? ''));
check('⑦ 这一投还是只产生一个块（不是两条两个块）', (block7.match(/\[Mid-turn\]/g) || []).length === 1);

// 兜底：对方"打个没完" → 到 holdMaxMs 上限必须插话，绝不永远不回复
cfg.social.typing.breakProbability = 0;
wakeMod.markSteerCycleStart(KEY, 'step/end');
const ty3 = push('打字那条：第三条');
const row3 = st.unread.find((m) => Number(m.seq) === ty3);
if (row3) row3.time = Date.now() - 20000;   // 这条已经等了 20s > holdMaxMs(12s)
st.peerTypingUntil = Date.now() + 60000;    // 对方还在打（而且看着要一直打下去）
st.peerTypingSince = Date.now();
const f7c = await holdMod.flushStepBatch({ key: KEY, sid: SID, turn: 13, cfg });
check('⑦ 打字打不完也有兜底：到"最多等多久"上限就投（绝不永远等）', f7c === true && (sent[sent.length - 1]?.text ?? '').includes('打字那条：第三条'), `注入次数=${sent.length - before7}`);

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 占用忽略 */ }
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
