// 回归测试：【在途回合里的图片必须真的附给模型，不许只剩 "[图片] [image]" 一行占位文本】
//（2026-09-22 主人报"附图片好像有问题，修复"；只覆盖 qq-bridge/**，不动 src/**、server/**）
//
// 现场（线上 state/social-state.json + DSH 会话日志一起对出来的）：
//   · 主人在模型正跑着那一步时发了一张图：`seq=279 … media=[image]`（消息本身把图记下来了）；
//   · 可投出去的那条 [Mid-turn] 正文只有 `owner(id:…): [图片] [image]` 一行纯文本，
//     会话日志里 `mediaType` 出现 **0 次**（这个会话从来没收到过任何图像块）；
//   · 模型回「那张真没传过来 只有个[图片]占位」，主人再发一次还是看不见 → 主人判定"附图片坏了"。
// 根因：图片附件原来只挂在**唤醒**那条路（sendWakePrompt → deliverRef(..., {media})），
//   而在途注入（steerIntoRunningTurn）是自己直接调 apiRef.sessions.prompt 的，content 里**只有一个 text 块**；
//   偏偏"忙时把消息塞进在途回合"是主路径（steer 默认开、turn-hold 又把回合吊得很长），
//   于是主人平时聊天时发的图**从来进不了模型的眼睛**。
//
// 本测试用 mock 的 DSH api 驱动真实的 src/core 模块（绝不动真配置/真状态），断言六件事：
//   ⓪ 挑选规则（pickAttachableMedia）只认 image/face、跳过自己发的与已附图水位以下的、有上限；
//   ① 带图的那批消息注入时，content 里**必须有 image 块**（不只文本），并推进"已附图水位"；
//   ② 同一张图绝不重复附（下一批、甚至把同一条重新塞回未读，都不再附）；
//   ③ 取图解不出来时**照旧投文本**（消息绝不被图拖死），且占位文本如实告诉模型"图没到你手上"；
//   ④ 带图被 DSH 拒（attachment-error）→ **自动回退纯文本重投**，且水位**不推进**（下一轮还能再试）；
//   ⑤ 没有图时 content 结构与改造前**一字不差**（只有一个 text 块）。
//
// 用法：node tests/steer-media.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-steermedia-'));
fs.cpSync(path.join(here, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-steermedia-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({
  ownerQQ: '123456789',
  allowAllWhenEmpty: true,
  allow: { private: [], groups: [] },
  dsh: { baseUrl: 'http://127.0.0.1:10721' },
  social: {
    steerEnabled: true,
    // 本测试只考"图片附件"，所以把打字窗/turn-hold 全部压掉：每一投都立刻注入当前轮，不被推迟干扰
    turnHold: { enabled: false, keys: [], privateOnly: true },
    typing: { enabled: false, holdMaxMs: 100, refreshOnMessageMs: 1, breakProbability: 0 },
  },
}, null, 2));

const url = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const cfgMod = await import(url('core/config.js'));
const stateMod = await import(url('core/session-state.js'));
const socialMod = await import(url('core/social-state.js'));
const modeMod = await import(url('core/mode.js'));
const wakeMod = await import(url('core/wake-send.js'));
const deliverMod = await import(url('core/prompt-deliver.js'));

const cfg = cfgMod.loadConfig();
modeMod.initModeCore(cfg);
wakeMod.initWakeCore(cfg);
socialMod.initSocialCore(cfg);
deliverMod.initPromptDeliverCore(cfg);

// ── 抓日志（lib/log.js 走 console.log）────────────────────────────────────────────
const logs = [];
const origLog = console.log;
console.log = (...a) => { const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); logs.push(line); };
const hasLog = (re) => logs.some((l) => re.test(l));

let fails = 0;
const check = (name, ok, extra = '') => {
  if (!ok) fails += 1;
  origLog(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

// ── mock DSH：记录每一次 prompt 的**完整 content**（这才看得出图有没有附上），可按需拒绝 ──
const sent = [];
let refuseWithImage = false;      // true → 带图的注入被拒（DSH attachment-error）
wakeMod.setWakeApi({
  sessions: {
    prompt: async (args) => {
      const hasImage = (args.content || []).some((c) => c && c.type === 'image');
      sent.push({ mode: args.mode, content: args.content || [], text: String(args.content?.[0]?.text ?? ''), hasImage });
      if (refuseWithImage && hasImage) {
        return { result: { ok: false, error: { code: 'attachment-error', message: 'mock：附件层拒收（尺寸/格式）' } } };
      }
      return { result: { ok: true } };
    },
  },
});

// ── mock 媒体解析器（生产上由 bridge.js 注入 resolveMediaList；这里替换成可观测的桩）────
let resolverCalls = [];
let resolverMode = 'ok';          // ok | placeholder | throw
deliverMod.setPromptMediaResolver(async (list) => {
  resolverCalls.push(list);
  if (resolverMode === 'throw') throw new Error('mock：取图失败（NapCat 拉不到那张图）');
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (resolverMode === 'placeholder') {
      out.push({ type: 'text', text: `[图片${i + 1}（获取失败）—— 这张图没能投递给你，看不到就如实说"图没加载出来"，不要猜内容]` });
      continue;
    }
    out.push({ type: 'text', text: `[图片${i + 1}]` });
    out.push({ type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: `qq-image-${i + 1}.png` });
  }
  return out;
});

const KEY = `private:${cfg.ownerQQ}`;
const SID = 'session-steer-media-test';
const st = socialMod.getSocialState(KEY);
st.agentToken = 'tok-steer-media';
st.unread = [];
st.recentMessages = [];
st.turnSeenUnread = [];
st.turnSteeredSeqs = [];
st.lastUnreadSeq = 0;
st.lastDeliveredSeq = 0;
st._mediaAttachedSeq = 0;
st._steerDeferredSeqs = [];
delete st.pendingWakeTimer;
cfgMod.state.sessions[KEY] = SID;
stateMod.reverse.set(SID, KEY);

let seqNo = 0;
/** 造一条"主人发来的消息"；withImage=true 时带上 media（与 social-flow.appendSocialMessage 同形） */
const push = (text, withImage = false, images = 1) => {
  seqNo += 1;
  const media = withImage
    ? Array.from({ length: images }, (_, i) => ({ kind: 'image', url: `https://example.invalid/${seqNo}-${i}.png` }))
    : [];
  const row = {
    seq: seqNo, messageId: `m${seqNo}`, sender: '主人', userId: cfg.ownerQQ, isOwner: true,
    plain: text, text, tail: text, isSelf: false, time: Date.now(), atSelf: false,
    media, hasMedia: media.length > 0,
  };
  st.unread.push(row);
  st.recentMessages.push(row);
  st.lastUnreadSeq = Math.max(Number(st.lastUnreadSeq) || 0, seqNo);
  st.peerTypingUntil = 0;            // 不打字 → 注入当前轮，不推迟（本测试只考附件）
  st.peerTypingSince = 0;
  return row;
};
const startTurn = () => {
  stateMod.TurnStartAt.set(SID, Date.now());
  stateMod.agentRunningSessions.add(SID);
  stateMod.holdActiveKeys.add(KEY);
};
const clearPending = () => {
  st.unread = [];
  st._steerDeferredSeqs = [];
  wakeMod.markSteerCycleStart(KEY, 'test-step-boundary');
};

console.log('=== ⓪ 纯函数：挑选规则（social-state.js: pickAttachableMedia）===');
const img = (n) => ({ kind: 'image', url: `u${n}` });
const rowOf = (seq, media, extra = {}) => ({ seq, media, isSelf: false, ...extra });
const p0 = socialMod.pickAttachableMedia([rowOf(3, [img(3), { kind: 'face', faceId: '21' }])], 0);
check('⓪ 认 image 与 face，两种都收', p0.media.length === 2 && p0.floor === 3, JSON.stringify(p0));
const p1 = socialMod.pickAttachableMedia([rowOf(3, [img(3)])], 3);
check('⓪ 水位以下（seq<=已附图水位）一律不再附', p1.media.length === 0 && p1.floor === 3, JSON.stringify(p1));
const p2 = socialMod.pickAttachableMedia([rowOf(5, [img(5)], { isSelf: true })], 0);
check('⓪ 自己发的消息永不附', p2.media.length === 0, JSON.stringify(p2));
const p3 = socialMod.pickAttachableMedia([rowOf(7, Array.from({ length: 6 }, (_, i) => img(i)))], 0, 5);
check('⓪ 单次上限生效（最多 5 张）', p3.media.length === 5, String(p3.media.length));
const p4 = socialMod.pickAttachableMedia([rowOf(9, [img(9)]), rowOf(11, [])], 0);
check('⓪ 没有图的消息不推进水位（只有真的采纳了图的最大 seq 才算数）', p4.floor === 9, String(p4.floor));

console.log('=== ① 在途回合里收到的图 → 必须附进 prompt（不能只剩 [图片] 占位）===');
startTurn();
const withPic = push('你看这个', true);
const before1 = sent.length;
const r1 = await wakeMod.steerIntoRunningTurn(KEY, 'private');
check('① 注入成功（返回 true）', r1 === true, String(r1));
check('① 只投了一次', sent.length === before1 + 1, `注入次数=${sent.length - before1}`);
const m1 = sent[before1];
check('① content 里有 **image 块**（这就是本次修的 bug：以前只有 text）', m1.hasImage === true, JSON.stringify(m1.content.map((c) => c.type)));
check('① image 块带着真实字节与 mime（模型据此才看得见图）', m1.content.some((c) => c.type === 'image' && c.mediaType === 'image/png' && String(c.data).length > 0));
check('① 文本块仍在最前面（正文语义没变）', m1.content[0].type === 'text' && /\[Mid-turn\] 1 new message/.test(m1.content[0].text));
check('① 正文里仍是那条消息', m1.content[0].text.includes(withPic.text));
check('① 取图走的是**注入的那一份解析器**（不是另写一份）', resolverCalls.length === 1 && resolverCalls[0].length === 1, JSON.stringify(resolverCalls.map((c) => c.length)));
check('① 已附图水位推进到这条 seq（下次不重复附）', Number(st._mediaAttachedSeq) === withPic.seq, `watermark=${st._mediaAttachedSeq} seq=${withPic.seq}`);
check('① 日志写明"顺带把 N 张图一起给了它"（附图这件事必须看得见）', hasLog(/顺带把 1 张图一起给了它（涵盖 seq≤\d+ 的图/));

console.log('=== ② 同一张图绝不重复附（连发 / 重投 / 下一批）===');
clearPending();
resolverCalls = [];
const plainMsg = push('再来一条纯文字');           // 这一批没有图
const before2 = sent.length;
const r2 = await wakeMod.steerIntoRunningTurn(KEY, 'private');
check('② 纯文字那批正常注入', r2 === true && sent.length === before2 + 1, String(r2));
check('② 这一批没有图 → content 里一个 image 块都没有', sent[before2].hasImage === false);
check('② 没有图就不该打扰解析器（省一次网络取图）', resolverCalls.length === 0, JSON.stringify(resolverCalls.length));
// 极端：把那张已经附过的图重新塞回未读（伪造"又被当新消息交付"）→ 仍不许再附
clearPending();
resolverCalls = [];
const repushRow = push('（重投那条旧图）');
repushRow.seq = withPic.seq;                      // 同一个 seq = 同一张图
repushRow.media = [{ kind: 'image', url: 'https://example.invalid/old.png' }];
repushRow.hasMedia = true;
const before3 = sent.length;
const r3 = await wakeMod.steerIntoRunningTurn(KEY, 'private');
const newly = sent.slice(before3);
check('② 已附图水位以下的图，重投也不附（要么整条被去重不投，要么投了但**没有** image 块）',
  r3 === true && resolverCalls.length === 0 && !newly.some((x) => x.hasImage),
  `r=${r3} 新投=${newly.length} 解析器调用=${resolverCalls.length}`);
check('② 水位没被这次"重投"改写', Number(st._mediaAttachedSeq) === withPic.seq, `watermark=${st._mediaAttachedSeq}`);
clearPending();

console.log('=== ③ 取图解不出来 → 照旧投文本 + 如实告诉模型"图没到你手上" ===');
resolverMode = 'placeholder';
const picA = push('这张取不到', true);
const before4 = sent.length;
const r4 = await wakeMod.steerIntoRunningTurn(KEY, 'private');
check('③ 取图失败也把这条消息投出去（绝不因为一张图把消息吞掉）', r4 === true && sent.length === before4 + 1, String(r4));
check('③ content 里是**占位文本**，不是图', sent[before4].hasImage === false && sent[before4].content.some((c) => c.type === 'text' && /没能投递给你/.test(c.text)));
check('③ 占位一并投出去（模型看得到"图没到"，就不会瞎猜内容）', /没能投递给你/.test(sent[before4].content.map((c) => c.text || '').join(' ')));
resolverMode = 'throw';
clearPending();
const picB = push('这张解析直接抛错', true);
logs.length = 0;
const before5 = sent.length;
const r5 = await wakeMod.steerIntoRunningTurn(KEY, 'private');
check('③ 解析抛错也不影响投递（消息照样进在途回合）', r5 === true && sent.length === before5 + 1, String(r5));
check('③ 抛错留了一行日志（附图失败必须看得见）', hasLog(/附图解不出来（mock：取图失败/), logs.filter((l) => /\[steer\]/.test(l)).slice(0, 2).join(' | '));
check('③ 抛错时这条**不推进**水位（图还能在下一轮再试）', Number(st._mediaAttachedSeq) < picB.seq, `watermark=${st._mediaAttachedSeq} seq=${picB.seq}`);
resolverMode = 'ok';
clearPending();

console.log('=== ④ 带图被 DSH 拒（attachment-error）→ 回退纯文本重投，图留到下一轮 ===');
refuseWithImage = true;
const picC = push('这张会被附件层拒', true);
const before6 = sent.length;
const r6 = await wakeMod.steerIntoRunningTurn(KEY, 'private');
const burst = sent.slice(before6);
check('④ 消息没被吞：先带图试一次、被拒后自动纯文本重投（共两次）', r6 === true && burst.length === 2, `次数=${burst.length} r=${r6}`);
check('④ 第一次确实带了图（不是一开始就没附）', burst[0]?.hasImage === true);
check('④ 第二次是纯文本（回退成功，消息仍在同一轮里）', burst[1]?.hasImage === false && /\[Mid-turn\]/.test(burst[1]?.text || ''));
check('④ 日志写明"带图注入被拒 → 回退纯文本重投"', hasLog(/带图注入被拒（mock：附件层拒收/));
check('④ 图**没**投出去 → 水位不推进（下一轮还能再试这张图）', Number(st._mediaAttachedSeq) < picC.seq, `watermark=${st._mediaAttachedSeq} seq=${picC.seq}`);
refuseWithImage = false;
clearPending();

console.log('=== ⑤ 没有图时行为一字不变（content 只有一个 text 块）===');
const plain2 = push('纯文字，别动');
const before7 = sent.length;
const r7 = await wakeMod.steerIntoRunningTurn(KEY, 'private');
check('⑤ 仍然是"一个 text 块 + steer"（与改造前完全一致）', r7 === true && sent.length === before7 + 1 && sent[before7].content.length === 1 && sent[before7].content[0].type === 'text' && sent[before7].mode === 'steer');
check('⑤ 正文包含这条消息本身', sent[before7].text.includes(plain2.text));

console.log = origLog;
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 占用忽略 */ }
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
