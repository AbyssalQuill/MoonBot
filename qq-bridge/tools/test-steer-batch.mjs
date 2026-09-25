// 回归测试：一次连发只注入一次（2026-09-12 报的两个问题）
//   ① 连发两条 → 桥注入两次（第 10、11 次），模型跑两步、发两条气泡，还把第二条留到下一次唤醒；
//   ② 注入正文太肥（约 1.6KB），而它会长期留在上下文里、步步重发。
//
// 测试方式：把 src/ 复制到临时沙箱（绝不碰真配置/真状态），注入假的 DSH api，直接驱动
// `steerIntoRunningTurn`，断言"提示词被发了几次、每次都带了哪些消息、正文多大"。
//
// 用法：node tools/test-steer-batch.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-steer-'));
fs.cpSync(path.join(here, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-steer-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({
  ownerQQ: '123456789',
  dsh: { baseUrl: 'http://127.0.0.1:10721' },
  social: { steerEnabled: true },
}, null, 2));

const url = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const cfgMod = await import(url('core/config.js'));
const stateMod = await import(url('core/session-state.js'));
const socialMod = await import(url('core/social-state.js'));
const modeMod = await import(url('core/mode.js'));
const wakeMod = await import(url('core/wake-send.js'));

const cfg = cfgMod.loadConfig();
modeMod.initModeCore(cfg);     // getSocialState 会顺带排主动检查，需要 mode 侧的 cfg
wakeMod.initWakeCore(cfg);
socialMod.initSocialCore(cfg);

const KEY = `private:${cfg.ownerQQ}`;
const SID = 'session-batch-test';

const sent = [];   // 每次注入：{ text, chars }
wakeMod.setWakeApi({
  sessions: {
    prompt: async (args) => { sent.push({ text: String(args.content?.[0]?.text ?? ''), chars: String(args.content?.[0]?.text ?? '').length, mode: args.mode }); return { result: { ok: true } }; },
  },
});

let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 造一个"回合正在跑"的会话 ——
cfgMod.state.sessions[KEY] = SID;
stateMod.TurnStartAt.set(SID, Date.now());
stateMod.agentRunningSessions.add(SID);
const st = socialMod.getSocialState(KEY);
st.agentToken = 'tok-test';
st.unread = [];
st.turnSeenUnread = [];
st.turnSteeredSeqs = [];
st.lastUnreadSeq = 0;

const push = (seq, text, agoMs = 0) => {
  st.unread.push({ seq, messageId: `m${seq}`, sender: '主人', userId: cfg.ownerQQ, isOwner: true, plain: text, text, isSelf: false, time: Date.now() - agoMs, atSelf: false, hasMedia: false });
  st.lastUnreadSeq = Math.max(Number(st.lastUnreadSeq) || 0, seq);
};

// ── ① 连发两条（第一条发完对方继续打字，1.2s 后发第二条）：只注入一次，且两条都在同一次注入里 ──
push(1, '第一条：在吗');
st.peerTypingUntil = Date.now() + 1800;          // 模拟"对方还在输入"（typing 事件维护的字段）
const p1 = wakeMod.steerIntoRunningTurn(KEY, 'private', { force: true });
await sleep(1200);
push(2, '第二条：哈哈，在笑我');                  // 第一条的注入还在"收集窗"里等 → 必须被合并
await sleep(700);
st.peerTypingUntil = 0;                          // 对方停止输入 → 收集窗结束
const r1 = await p1;
await sleep(200);
check('① 只注入了一次（两条消息合并）', sent.length === 1, `注入次数=${sent.length}`);
check('① 返回值 true（已交付语义）', r1 === true, String(r1));
check('① 注入正文带上了第一条', /第一条/.test(sent[0]?.text ?? ''));
check('① 注入正文带上了第二条（不再留到下一次唤醒）', /第二条/.test(sent[0]?.text ?? ''));
check('① 注入条数写的是 2', /\[Mid-turn\] 2 /.test(sent[0]?.text ?? ''), (sent[0]?.text ?? '').split('\n')[1] ?? '');
check('① 这两条同时进了 turnSteeredSeqs', [1, 2].every((s) => (st.turnSteeredSeqs || []).map(Number).includes(s)), JSON.stringify(st.turnSteeredSeqs));

// ── ② 同一周期内又来第三条：绝不第二次注入 ──
push(3, '第三条：同一口气里又发了一句');
const r2 = await wakeMod.steerIntoRunningTurn(KEY, 'private', { force: true });
check('② 同周期内不再注入（只保留第一次）', sent.length === 1, `注入次数=${sent.length}`);
check('② 第三条被记入"推迟交付"名单（防 mark_read 吞掉）', (st._steerDeferredSeqs || []).map(Number).includes(3), JSON.stringify(st._steerDeferredSeqs || []));
check('② 第三条没有被标成"已给过"（仍留在未读里）', !(st.turnSteeredSeqs || []).map(Number).includes(3), JSON.stringify(st.turnSteeredSeqs || []));
check('② 返回 true（告诉调用方"别再另起一轮/别再投"）', r2 === true, String(r2));
check('② 第三条确实还在 unread 里', (st.unread || []).some((m) => Number(m.seq) === 3));

// ── ③ 下一个模型步结束（turn-hold 钩子再次被调用）→ 允许注入，并带走第三条 ──
wakeMod.markSteerCycleStart(KEY);
const r3 = await wakeMod.steerIntoRunningTurn(KEY, 'private', { force: true });
check('③ 新周期可以再次注入', sent.length === 2, `注入次数=${sent.length}`);
check('③ 第二次注入只带第三条', /第三条/.test(sent[1]?.text ?? '') && !/第一条/.test(sent[1]?.text ?? ''), (sent[1]?.text ?? '').slice(0, 80));
check('③ 返回值 true', r3 === true, String(r3));

// ── ④ 注入正文体积（省额度）：精简优先 ──
// 2026-09-12 二次精简：规则散文（ONE-AND-DONE / 不复读 / 第一次看到当普通唤醒 / 真没内容才不发 /
// owner 私聊收尾方式）已整段搬进系统提示词 agent.cordis.yml 的 [WAKE TYPES] 第 1 条；
// 注入正文只剩「[Token] + [Mid-turn] 数据头 + 消息行」。所以这里同时断言：
//   · 体积再降一档（< 400 字符；原版 1,600、上一轮 690）
//   · 形态就是约定的那种（[Token] 行 + [Mid-turn] N new message(s)...）
//   · 规则确实不再出现在正文里（搬走了，不是删了——搬去哪由 test-wake-protocol.mjs 断言）
const sizes = sent.map((s) => s.chars);
check('④ 单次注入正文 < 400 字符（原版约 1600 / 上一轮约 690）', sizes.every((n) => n < 400), `实测 ${sizes.join(' / ')}`);
const body = sent[0].text;
for (const [label, re, want] of [
  ['首行是 [Token] 令牌行（英文标签 + 英文方括号）', /^\[Token\] tok-test$/m, true],
  ['是数据形态：[Mid-turn] N new message(s) after your last bubble - not answered yet.', /\[Mid-turn\] 2 new message\(s\) after your last bubble - not answered yet\./, true],
  ['两条消息都带上了', /第一条/, true],
  ['规则散文已搬走：正文里没有 ONE-AND-DONE', /ONE-AND-DONE/, false],
  ['正文里没有 ➤ 哨兵符号', /➤/, false],
  ['正文里没有【令牌】旧标签', /【令牌】/, false],
  ['正文里没有 "Do not re-fetch" 这类规则句', /Do not re-fetch/, false],
]) check('④ ' + label, re.test(body) === want);

// ── ⑤ 非保持会话：周期闸窗口更短（1.5s），窗口过后必须能再投（不能把答复一直拖住） ──
stateMod.holdActiveKeys.delete(KEY);
await sleep(1600);                                  // 等过非保持会话的短窗口
push(4, '第四条：非保持会话的第二批');
const r4 = await wakeMod.steerIntoRunningTurn(KEY, 'private', { force: true });
check('⑤ 非保持会话里，这一批不会因为周期闸被永久挡住', sent.length === 3, `注入次数=${sent.length}`);
check('⑤ 第四次注入带上了第四条', /第四条/.test(sent[2]?.text ?? ''), (sent[2]?.text ?? '').slice(0, 60));
check('⑤ 返回 true', r4 === true, String(r4));

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 占用忽略 */ }
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
