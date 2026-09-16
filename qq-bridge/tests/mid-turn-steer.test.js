// 回归测试：【模型正在思考时收到的消息必须注入当前这一轮，不许被塞进下一个唤醒】
//（2026-09-16 真机 bug；只覆盖 qq-bridge/**，不动 src/**、server/**）
//
// 现场（bridge.log / 管理端 bridge-local.log，UTC）：
//   14:05:39 消息在模型还在跑这一步时到达 → 打字闸门判"等" → 在途注入被推迟 →
//   14:05:40 投递时要么"没有正在跑的模型回合"、要么调用方把"推迟"读成"塞不进去" →
//            `[default] 会话繁忙且即时注入未成功 → 走正常唤醒流程` + `唤醒 private:***（private）`
//            + `首次唤醒，注入完整 prompt` —— 一条在途消息被当成**下一个唤醒**投出去。
//
// 本测试用 mock 的 DSH api 驱动真实的 src/core 模块（绝不动真配置/真状态），覆盖三条路径：
//   ① 模型还在生成、这一轮一条都还没发出去 → **注入当前轮**（不是 defer、更不是下一轮）；
//   ② 本回合已发过气泡 + 对方在连发 → 允许**短暂**推迟，但打字窗一结束必须**在同一轮内补投**；
//   ③ 极端情况（注入通道失败 / 补投时回合已经跑完）→ 消息**不被吞**、明确落到下一轮、日志写明原因。
// 三条路径各自必须各留一行日志（`注入当前轮` / `短暂延迟后注入` / `只能留到下一轮`），测试里逐条断言。
//
// 用法：node tests/mid-turn-steer.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-midturn-'));
fs.cpSync(path.join(here, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-midturn-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({
  ownerQQ: '123456789',
  allowAllWhenEmpty: true,
  allow: { private: [], groups: [] },
  dsh: { baseUrl: 'http://127.0.0.1:10721' },
  social: {
    steerEnabled: true,
    // 主人私聊的线上配置：turn-hold 打开、全部私聊
    turnHold: { enabled: true, keys: [], privateOnly: true, maxExchanges: 24, idleCloseMs: 1800000, maxWaitMs: 3600000, requestBudgetMs: 55000 },
    // 打字等待：骰子写 0（绝不插话）→ "该不该推迟"完全由本测试的输入决定，不受随机影响；
    // holdMaxMs 压到 1000 让"短暂延迟"的补投在 1s 内发生（省测试时间，语义不变）。
    typing: { enabled: true, holdMaxMs: 1000, refreshOnMessageMs: 5000, breakProbability: 0 },
  },
}, null, 2));

const url = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const cfgMod = await import(url('core/config.js'));
const stateMod = await import(url('core/session-state.js'));
const socialMod = await import(url('core/social-state.js'));
const modeMod = await import(url('core/mode.js'));
const wakeMod = await import(url('core/wake-send.js'));
const typingMod = await import(url('core/typing-hold.js'));

const cfg = cfgMod.loadConfig();
modeMod.initModeCore(cfg);
wakeMod.initWakeCore(cfg);
socialMod.initSocialCore(cfg);

// ── 抓日志（lib/log.js 走 console.log），用来断言"三条路径各打一行" ──────────────────
const logs = [];
const origLog = console.log;
console.log = (...a) => { const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); logs.push(line); };
const hasLog = (re) => logs.some((l) => re.test(l));

let fails = 0;
const check = (name, ok, extra = '') => {
  if (!ok) fails += 1;
  origLog(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 4000) {
  const until = Date.now() + ms;
  for (;;) {
    if (cond()) return true;
    if (Date.now() > until) return false;
    await sleep(50);
  }
}

// ── mock DSH：记录每一次 prompt（注入次数 / 方式 / 正文），可按需失败 ─────────────────
const sent = [];
let channelFails = false;
wakeMod.setWakeApi({
  sessions: {
    prompt: async (args) => {
      if (channelFails) throw new Error('mock：注入通道失败（DSH 拒绝/超时）');
      const text = String(args.content?.[0]?.text ?? '');
      sent.push({ text, mode: args.mode });
      return { result: { ok: true } };
    },
  },
});
// 唤醒派发间谍：任何"下一个唤醒/新回合"都会经过它（wake-sender 由 main 注入，沙箱里我们自己接管）
const wakes = [];
socialMod.setWakeSender(async (key, reason) => { wakes.push({ key, reason }); });

const KEY = `private:${cfg.ownerQQ}`;
const SID = 'session-midturn-test';
const st = socialMod.getSocialState(KEY);
st.agentToken = 'tok-midturn';
st.unread = [];
st.recentMessages = [];
st.turnSeenUnread = [];
st.turnSteeredSeqs = [];
st.lastUnreadSeq = 0;
st.lastDeliveredSeq = 0;
st._steerDeferredSeqs = [];
cfgMod.state.sessions[KEY] = SID;
stateMod.reverse.set(SID, KEY);

/** 造一条"在途回合正在跑"的消息（与 social-flow.appendSocialMessage 一致：消息本身续上打字窗） */
let seqNo = 0;
const push = (text, typingMs = 1200) => {
  seqNo += 1;
  const row = {
    seq: seqNo, messageId: `m${seqNo}`, sender: '主人', userId: cfg.ownerQQ, isOwner: true,
    plain: text, text, isSelf: false, time: Date.now(), atSelf: false, hasMedia: false,
  };
  st.unread.push(row);
  st.recentMessages.push(row);
  st.lastUnreadSeq = Math.max(Number(st.lastUnreadSeq) || 0, seqNo);
  // 【关键】QQ 的 input_status 不可靠，social-flow 会**用消息本身**续上"对方在打字"的窗口
  //（refreshOnMessageMs 默认 5s）—— 所以任何一条消息到达时，"打字闸门"看着都像"正在输入"。
  st.peerTypingUntil = Date.now() + typingMs;
  st.peerTypingSince = Date.now();
  return { seq: seqNo, text };
};
const startTurn = () => {
  stateMod.TurnStartAt.set(SID, Date.now());
  stateMod.agentRunningSessions.add(SID);
  stateMod.holdActiveKeys.add(KEY);
};
const endTurn = () => {
  stateMod.TurnStartAt.delete(SID);
  stateMod.agentRunningSessions.delete(SID);
  stateMod.collectors.delete(SID);
  stateMod.holdActiveKeys.delete(KEY);
};
const bubbleSent = () => stateMod.sendToolSucceededSessions.add(SID);   // mux 在"本回合发成功过一条"时记的账
/** 每段用例开头的干净起点：清掉上一段残留的待交付消息，并复位注入闸门（等价于模型步边界） */
const clearPending = () => {
  st.unread = [];
  st._steerDeferredSeqs = [];
  wakeMod.markSteerCycleStart(KEY, 'test-step-boundary');
};

console.log('=== ⓪ 纯函数：三条路径的判据（typing-hold.js: midTurnSteerGate）===');
const now0 = Date.now();
const g0a = typingMod.midTurnSteerGate({ typingUntil: now0 + 5000, since: now0, now: now0, cfg, noReplyYet: true, rand: () => 0.99 });
check('⓪ 本回合一条都还没发出去 → 注入当前轮（no-reply-yet，即使对方在打字）', g0a.action === 'inject' && g0a.reason === 'no-reply-yet', JSON.stringify(g0a));
const g0b = typingMod.midTurnSteerGate({ typingUntil: now0 + 5000, since: now0, now: now0, cfg, noReplyYet: false, rand: () => 0.99 });
check('⓪ 已发过气泡 + 对方在连发 → 允许短期推迟，并给出补投时刻', g0b.action === 'defer' && g0b.retryAtMs > now0 && g0b.retryAtMs <= now0 + typingMod.STEER_IN_TURN_DEFER_MAX_MS, JSON.stringify(g0b));
const g0c = typingMod.midTurnSteerGate({ typingUntil: now0 + 60000, since: now0 - 99999, now: now0, cfg, noReplyYet: false, rand: () => 0.99 });
check('⓪ 推迟有硬上限：等过头就立刻注入（defer-cap/cap-reached，绝不一等到底）', g0c.action === 'inject' && /cap/.test(g0c.reason), JSON.stringify(g0c));
const g0d = typingMod.midTurnSteerGate({ typingUntil: now0 - 1, since: now0, now: now0, cfg, noReplyYet: false, rand: () => 0.99 });
check('⓪ 对方没在打字 → 注入当前轮', g0d.action === 'inject' && g0d.reason === 'not-typing', JSON.stringify(g0d));
const g0e = typingMod.midTurnSteerGate({ typingUntil: now0 + 5000, since: now0, now: now0, cfg: { social: { typing: { breakProbability: 1 } } }, noReplyYet: false, rand: () => 0 });
check('⓪ 骰子命中插话 → 注入当前轮', g0e.action === 'inject' && g0e.reason === 'dice-hit', JSON.stringify(g0e));
check('⓪ 三种日志用语互不混淆', /注入当前轮（模型还在生成/.test(typingMod.midTurnSteerText(g0a)) && /短暂延迟后注入（原因：对方正在连发/.test(typingMod.midTurnSteerText(g0b)) && /注入当前轮（短暂延迟已到上限|注入当前轮（对方打字已连续/.test(typingMod.midTurnSteerText(g0c)));

console.log('=== ① 模型还在生成、这一轮一条都还没发出去 → 注入当前轮（不是下一个唤醒）===');
startTurn();
check('① 前提：本回合确实还没发过任何气泡', stateMod.turnHasBubble(KEY, SID, st) === false);
const m1 = push('第一条：你在忙吗');
const before1 = sent.length;
// 线上调用：sendWakePrompt 的 busy 分支就是不带 force 调它（合并窗到点那一刻）
const r1 = await wakeMod.steerIntoRunningTurn(KEY, 'private');
check('① 直接注入当前轮（返回 true，不是 "typing-defer"、更不是 false）', r1 === true, String(r1));
check('① 就是这一条消息、就是这一次注入', sent.length === before1 + 1 && sent[before1].text.includes(m1.text), `注入次数=${sent.length - before1}`);
check('① 投递方式仍是 steer（唯一投递原语，不另起一轮）', sent[before1].mode === 'steer', String(sent[before1].mode));
check('① 正文是 [Mid-turn]（在线回合里注入，不是 [Wake] 唤醒）', /\[Mid-turn\] 1 new message/.test(sent[before1].text) && !/\[Wake/.test(sent[before1].text));
check('① 日志写明"注入当前轮"及原因', hasLog(/注入当前轮（模型还在生成、这一轮一条都还没发出去/));
check('① 没有起任何新唤醒（没被塞进"下一个唤醒"）', wakes.length === 0, JSON.stringify(wakes));
check('① 这条消息被记成"本回合已注入"，不会被重复投喂', (st.turnSteeredSeqs || []).map(Number).includes(m1.seq));

console.log('=== ①-b 唤醒调度侧：会话正忙 + 本回合还没发过 → 唤醒窗口一秒都不许被拉长 ===');
logs.length = 0;
const m1b = push('第一条（b）：他那句话我还在生成');
socialMod.scheduleWake(KEY, 'private');
const wakeWindowGrew = hasLog(/唤醒窗口 [1-9]\.\d s|唤醒窗口 [2-9]/);
check('①-b 有回合在跑且本回合没发过气泡 → 不顺延唤醒窗口（否则就拖过了这一轮）', hasLog(/本回合一条都还没发出去，一秒不等/) && !wakeWindowGrew, logs.filter((l) => /\[typing\]/.test(l)).join(' | '));
check('①-b 合并窗仍是私聊的 1s（不落回"唤醒窗口 5.4s"那种 12s 级顺延）', hasLog(/计划唤醒 .*1s 后发送/), logs.filter((l) => /计划唤醒/.test(l)).join(' | '));
if (st.pendingWakeTimer) { clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null; st.pendingWakeReason = null; }

console.log('=== ② 本回合已发过气泡 + 对方在连发 → 短暂推迟，打字窗一结束在同一轮内补投 ===');
// 这里把 turn-hold 关掉，专门考"非保持托管"这条最坏的路：它的回合里**没有**保持循环/步边界注入器，
// 推迟之后以前根本没有任何同一轮内的补投路径（只能等下一次唤醒）—— 现场那几次"被塞进下一个唤醒"就是它。
cfg.social.turnHold.enabled = false;
stateMod.holdActiveKeys.delete(KEY);
// 清掉 ①-b 那条没投出去的残留（它不是本条用例的对象），并复位注入闸门（等价于模型步边界）——
// 否则"最早待交付消息"会是上一条、周期闸也还在封口中，本条用例就不是它想测的那条路。
st.unread = st.unread.filter((m) => Number(m.seq) !== m1b.seq);
wakeMod.markSteerCycleStart(KEY, 'test-step-boundary');
logs.length = 0;
bubbleSent();                                    // mux 的记账：本回合已经成功发出过气泡
check('② 前提：本回合已发过气泡（"打字保持中"成立）', stateMod.turnHasBubble(KEY, SID, st) === true);
const m2 = push('第二条：我再说一句', 5000);      // 对方刚发完还在"打字"（窗口 5s）
const before2 = sent.length;
const r2 = await wakeMod.steerIntoRunningTurn(KEY, 'private');
check('② 拿到**明确的推迟信号**（typing-defer；不是 false —— false 会被调用方读成"塞不进去→走完整唤醒"）', r2 === 'typing-defer', String(r2));
check('② 推迟期间一条都没投', sent.length === before2, `注入次数=${sent.length - before2}`);
check('② 日志写明"短暂延迟后注入"+原因', hasLog(/短暂延迟后注入（原因：对方正在连发、本回合已发过气泡/));
check('② 推迟≠落回唤醒：没有起新唤醒', wakes.length === 0, JSON.stringify(wakes));
check('② 还没标"已给过"（消息仍在未读，补投要能带走它）', !(st.turnSteeredSeqs || []).map(Number).includes(m2.seq));
// 对方停止输入（QQ 的 input_status=2；events-aux.js 就是这么把窗口清掉的）→ 同一轮内的补投应该立刻到
st.peerTypingUntil = 0;
st.peerTypingSince = 0;
const landed2 = await waitFor(() => sent.length === before2 + 1, 3000);
check('② 打字窗一结束就补投（不拖到下一次唤醒）', landed2 && sent[before2].text.includes(m2.text), `注入次数=${sent.length - before2}`);
check('② 补投仍是同一轮内的 steer 注入（没有新唤醒、没有新回合）', sent[before2]?.mode === 'steer' && wakes.length === 0 && cfgMod.state.sessions[KEY] === SID && stateMod.TurnStartAt.has(SID));
check('② 补投只产生一个 [Mid-turn] 块（不是两条两个块）', (sent[before2].text.match(/\[Mid-turn\]/g) || []).length === 1 && /\[Mid-turn\] 1 new message/.test(sent[before2].text));
check('② 日志写明"短暂延迟后注入完成……仍在同一轮内"', hasLog(/短暂延迟后注入完成：打字窗结束，这批仍在\*\*同一轮内\*\*注入/));
check('② 补投后这条进了 turnSteeredSeqs（算本回合的账）', (st.turnSteeredSeqs || []).map(Number).includes(m2.seq));

console.log('=== ③ 极端情况 A：注入通道失败 → 消息不被吞 + 明确落到下一轮 + 日志写明原因 ===');
logs.length = 0;
channelFails = true;                              // DSH 拒了 / 超时 → 注入通道不可用
clearPending();
const m3 = push('第三条：注入会失败的那条', 5000);
const before3 = sent.length;
const r3 = await wakeMod.steerIntoRunningTurn(KEY, 'private');
check('③ 通道不可用时也是明确的"推迟"信号（不谎报成功）', r3 === 'typing-defer', String(r3));
st.peerTypingUntil = 0;                           // 打字窗结束 → 补投时刻到
const fell = await waitFor(() => hasLog(/只能留到下一轮（原因：延后补投未成功/), 8000);
check('③ 日志写明"只能留到下一轮（原因：…）"', fell, logs.filter((l) => /只能留到下一轮/.test(l)).join(' | '));
check('③ 原因写清了是注入通道失败（这一轮还在跑）', hasLog(/只能留到下一轮（原因：延后补投未成功、注入通道返回失败）/));check('③ 消息**没被吞**：仍在未读、没被标"已给过"、交付水位没动', st.unread.some((m) => Number(m.seq) === m3.seq) && !(st.turnSteeredSeqs || []).map(Number).includes(m3.seq) && Number(st.lastDeliveredSeq) < m3.seq, `注入次数=${sent.length - before3}`);
const requeued = await waitFor(() => wakes.some((w) => String(w.reason).startsWith('typingDeferFallback')), 5000);
check('③ 明确落到下一轮：重排了一次唤醒兜底（而不是静默卡住）', requeued, JSON.stringify(wakes));
channelFails = false;
if (st.pendingWakeTimer) { clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null; st.pendingWakeReason = null; }

console.log('=== ③-b 极端情况 B：补投时那一轮已经跑完（回合被隔离/标记过期清理）===');
logs.length = 0;
// ③ 那条仍未交付的消息先移出未读（它的"没被吞"已在上一段断言过），让这一段只考 m4 一条
clearPending();
const m4 = push('第四条：补投时回合已经没了', 5000);
const before4 = sent.length;
const r4 = await wakeMod.steerIntoRunningTurn(KEY, 'private');
check('③-b 先拿到"推迟"信号', r4 === 'typing-defer', String(r4));
// turn-guard.js 的隔离/标记过期清理就是**只删回合标记**（不调 clearSteerPending），线上真的会发生
endTurn();
st.peerTypingUntil = 0;
const fell4 = await waitFor(() => hasLog(/只能留到下一轮（原因：延后补投未成功、这一轮已经跑完）/), 4000);
check('③-b 日志写明"只能留到下一轮（原因：这一轮已经跑完）"', fell4, logs.filter((l) => /只能留到下一轮/.test(l)).join(' | '));
check('③-b 一条都没投（那一轮确实没了，不能假装塞进去了）', sent.length === before4, `注入次数=${sent.length - before4}`);
check('③-b 消息**没被吞**：仍在未读、没被标"已给过"', st.unread.some((m) => Number(m.seq) === m4.seq) && !(st.turnSteeredSeqs || []).map(Number).includes(m4.seq));
const requeued4 = await waitFor(() => wakes.some((w) => String(w.reason).startsWith('typingDeferFallback')), 5000);
check('③-b 重排唤醒兜底（消息会由下一个唤醒带走，不会永远留在未读里）', requeued4);
if (st.pendingWakeTimer) { clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null; st.pendingWakeReason = null; }

console.log('=== ④ 回合边界：待办的同一轮补投必须被收掉（不留空转定时器）===');
logs.length = 0;
startTurn();
clearPending();                                          // 等价于模型步边界：闸门复位，本投才会走到"推迟"
const m5 = push('第五条：回合边界收尾', 5000);
const r5 = await wakeMod.steerIntoRunningTurn(KEY, 'private');
check('④ 前提：本投确实拿到了"推迟"信号（否则谈不上"取消待办补投"）', r5 === 'typing-defer', String(r5));
wakeMod.clearSteerPending(KEY, 'turn/end');
check('④ 回合结束时取消待办的"同一轮内补投"并留一行日志', hasLog(/取消待办的"同一轮内补投"（回合边界（turn\/end））/), logs.join(' | '));
check('④ 消息仍在未读（回合边界的记账只清定时器，不吞消息）', st.unread.some((m) => Number(m.seq) === m5.seq) && !(st.turnSteeredSeqs || []).map(Number).includes(m5.seq));

console.log = origLog;
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 占用忽略 */ }
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
