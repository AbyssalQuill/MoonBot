// 私聊「不抢话」的等待 / 插话决策（2026-09-15 主人要求）
//
// 目标（主人原话）：私聊里模型回复要**先看对方打字状态**，等 ta 打完再回；对方**不停发消息**时，
// 打字状态应当是**连续**的；再用**概率投骰子**决定要不要打断这个状态 —— 既能不抢话，又能"智能接话"；
// 等待期间到的消息全部排队，最后**合并成一次注入**（省注入轮数）。
//
// 这里只放**纯决策**（不碰状态、不发网络），便于单测；状态维护在：
//   · core/events-aux.js   —— QQ 的 input_status 事件 → st.peerTypingUntil / peerTypingSince
//   · core/social-flow.js  —— 私聊来消息时**续上**打字窗口（QQ 的输入事件不可靠，不停发消息=一直在打字）
//   · core/social-state.js —— scheduleWake 按本文件的结果决定"等"还是"插话"
//
// 配置（管理端桥配置页「私聊打字等待」卡；也能用自然语言调，见 tunables）：
//   social.typing.enabled            总开关
//   social.typing.holdMaxMs          最多等多久（兜底：对方一直打就一直等不下去 → 到点插话）
//   social.typing.refreshOnMessageMs 收到一条消息后，把"对方在打字"再续这么多毫秒
//   social.typing.breakProbability   每次唤醒的插话概率（0=绝不插话，只等他停；1=从不等待）

export const TYPING_DEFAULTS = {
  enabled: true,
  holdMaxMs: 12000,
  refreshOnMessageMs: 5000,
  breakProbability: 0.15
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function typingCfg(cfg) {
  const t = (cfg && cfg.social && cfg.social.typing) || {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled: t.enabled !== false,
    holdMaxMs: clamp(num(t.holdMaxMs, TYPING_DEFAULTS.holdMaxMs), 1000, 60000),
    refreshOnMessageMs: clamp(num(t.refreshOnMessageMs, TYPING_DEFAULTS.refreshOnMessageMs), 0, 30000),
    breakProbability: clamp(num(t.breakProbability, TYPING_DEFAULTS.breakProbability), 0, 1)
  };
}

/**
 * 该等还是该插话。
 * @returns {{ wait:boolean, breakIn:boolean, reason:string, roll:number, capped:boolean,
 *             heldForMs:number, remainMs:number, cfg:object }}
 */
export function typingHoldDecision({ typingUntil = 0, since = 0, now = Date.now(), cfg = null, rand = Math.random } = {}) {
  const c = typingCfg(cfg);
  const base = { wait: false, breakIn: false, reason: '', roll: NaN, capped: false, heldForMs: 0, remainMs: 0, cfg: c };
  if (!c.enabled) return { ...base, reason: 'disabled' };
  const until = Number(typingUntil) || 0;
  if (until <= now) return { ...base, reason: 'not-typing' };
  const sinceMs = Number(since) || 0;
  const heldForMs = sinceMs > 0 ? Math.max(0, now - sinceMs) : 0;
  const remainMs = Math.max(0, until - now);
  // 到上限 → 不等了（否则遇到"打字打个没完"的人会永远不回复）
  if (heldForMs >= c.holdMaxMs) {
    return { ...base, breakIn: true, reason: 'cap-reached', heldForMs, remainMs };
  }
  const roll = typeof rand === 'function' ? Number(rand()) : Math.random();
  if (roll < c.breakProbability) {
    return { ...base, breakIn: true, reason: 'dice-hit', roll, heldForMs, remainMs };
  }
  return {
    wait: true, breakIn: false, reason: 'typing-hold', roll,
    capped: false, heldForMs, remainMs,
    // 等多久：对方"停止输入"后还有一小段合并窗，所以按剩余打字时间 + 500ms 估算
    cfg: c
  };
}

// ── 【2026-09-16 修「思考期间到的消息被塞进下一个唤醒」】在途回合（steer）的注入闸门 ──────────
//
// 现场（bridge.log 14:05:39 / 管理端 13:39:59）：消息在模型**还在跑这一步**时到达 →
// 上面那个 typingHoldDecision 判"等"→ 在途注入被推迟 → 等待期间那一轮跑完了 →
// 投递时"没有正在跑的模型回合"→ 落回**完整唤醒**（日志原文 `唤醒 private:***（private）`），
// 也就是"被塞进了下一个唤醒"，而不是注入当前这一轮。
//
// 机理上有三处分寸不对，这里用**一个纯函数**把它们定死（判据集中一处，便于单测）：
//   ① 模型还在生成、**这一轮一条都还没发出去** → 根本没有"抢话/碎裂"的问题（对话窗口里还没有气泡），
//      等下去只会把这条消息拖过这一轮 ⇒ 立刻注入当前轮（noReplyYet）。
//   ② "打字保持中"（对方在连发 + 本回合已经发过气泡）才允许等，而且只允许**短暂**等
//      （STEER_IN_TURN_DEFER_MAX_MS 硬上限；到点必投，绝不把消息拖过这一轮）。
//   ③ 允许等的时候必须给出**补投时刻**（retryAtMs = 打字窗口结束或延迟上限，取先到者），
//      调用方据此在同一轮内补投 —— 以前没有这条路径，是设计缺口。
export const STEER_IN_TURN_DEFER_MAX_MS = 3000;   // 在途回合里最多"短暂延迟"多久（不是 holdMaxMs）
const IN_TURN_DEFER_MIN_MS = 150;                 // 补投最小间隔（防抖，别打成热循环）

/**
 * 在途回合（steer）该不该因为"对方在打字"推迟。**三条路径各自可辨识**：
 *   action:'inject' → 注入当前轮（reason 说明为什么不等）
 *   action:'defer'  → 短暂延迟后注入（retryAtMs = 同一轮内的补投时刻）
 * 第三类"只能留到下一轮"不在本函数里判 —— 那是"没有正在跑的回合 / 注入通道失败"，属于调用方的
 * 环境事实（wake-send.js 的 runningTurn 守卫与补投失败分支各打一行日志），纯函数不该假装知道。
 * @returns {{action:'inject'|'defer', reason:string, retryAtMs:number, roll:number,
 *             heldForMs:number, remainMs:number, noReplyYet:boolean, cfg:object}}
 */
export function midTurnSteerGate({
  typingUntil = 0, since = 0, now = Date.now(), cfg = null,
  noReplyYet = false, rand = Math.random, maxDeferMs = STEER_IN_TURN_DEFER_MAX_MS
} = {}) {
  const c = typingCfg(cfg);
  const base = { action: 'inject', reason: '', retryAtMs: 0, roll: NaN, heldForMs: 0, remainMs: 0, noReplyYet: !!noReplyYet, cfg: c };
  if (!c.enabled) return { ...base, reason: 'disabled' };
  const until = Number(typingUntil) || 0;
  if (until <= now) return { ...base, reason: 'not-typing' };
  const sinceMs = Number(since) || 0;
  const heldForMs = sinceMs > 0 ? Math.max(0, now - sinceMs) : 0;
  const remainMs = Math.max(0, until - now);
  // ① 本回合一条都还没发出去（模型还在生成第一口气）→ 不等。这就是本次要修的那条优先级。
  if (noReplyYet) return { ...base, reason: 'no-reply-yet', heldForMs, remainMs };
  // ② 短暂延迟的硬上限：允许等，但只允许"短暂"（min(配置上限, 本函数的延迟上限)）
  const capMs = Math.max(IN_TURN_DEFER_MIN_MS, Math.min(c.holdMaxMs, Number(maxDeferMs) > 0 ? Number(maxDeferMs) : STEER_IN_TURN_DEFER_MAX_MS));
  if (heldForMs >= capMs) {
    return { ...base, reason: heldForMs >= c.holdMaxMs ? 'cap-reached' : 'defer-cap', heldForMs, remainMs };
  }
  const roll = typeof rand === 'function' ? Number(rand()) : Math.random();
  if (roll < c.breakProbability) return { ...base, reason: 'dice-hit', roll, heldForMs, remainMs };
  // ③ 对方确实还在连发（已发过气泡）→ 允许短暂延迟：到"打字窗口结束"或"延迟上限"就补投
  const budgetLeft = Math.max(0, capMs - heldForMs);
  const retryAtMs = now + Math.max(IN_TURN_DEFER_MIN_MS, Math.min(remainMs, budgetLeft));
  return { action: 'defer', reason: 'typing-burst', retryAtMs, roll, heldForMs, remainMs, noReplyYet: false, cfg: c };
}

/** 在途注入三条路径的日志用语（要求：一眼能分清 注入当前轮 / 短暂延迟后注入 / 只能留到下一轮） */
export function midTurnSteerText(d, key = '') {
  const head = key ? `${key} ` : '';
  const c = d.cfg || TYPING_DEFAULTS;
  if (d.action === 'defer') {
    const ms = Math.max(0, Number(d.retryAtMs) - Date.now());
    return `${head}短暂延迟后注入（原因：对方正在连发、本回合已发过气泡，等 ${(Number(d.remainMs) / 1000).toFixed(1)}s 的打字窗结束）→ ${ms}ms 后在同一轮内补投`;
  }
  switch (d.reason) {
    case 'disabled': return `${head}注入当前轮（打字等待已关闭）`;
    case 'not-typing': return `${head}注入当前轮（对方没在打字）`;
    case 'no-reply-yet': return `${head}注入当前轮（模型还在生成、这一轮一条都还没发出去 → 不等）`;
    case 'defer-cap': return `${head}注入当前轮（短暂延迟已到上限 ${(STEER_IN_TURN_DEFER_MAX_MS / 1000).toFixed(0)}s，不再等）`;
    case 'cap-reached': return `${head}注入当前轮（对方打字已连续 ${(Number(d.heldForMs) / 1000).toFixed(1)}s，到上限 ${(c.holdMaxMs / 1000).toFixed(0)}s）`;
    case 'dice-hit': return `${head}注入当前轮（骰子命中插话 ${Number(d.roll).toFixed(2)} < ${c.breakProbability}）`;
    default: return `${head}注入当前轮`;
  }
}

/** 给日志/提示用的一句话 */
export function typingHoldText(d, key = '') {
  const c = d.cfg || TYPING_DEFAULTS;
  const head = key ? `${key} ` : '';
  if (d.reason === 'disabled') return `${head}打字等待已关闭`;
  if (d.reason === 'not-typing') return `${head}对方没在打字，按正常节奏回`;
  if (d.reason === 'cap-reached') return `${head}对方打字已连续 ${(d.heldForMs / 1000).toFixed(1)}s（上限 ${(c.holdMaxMs / 1000).toFixed(0)}s）→ 不等了，插话`;
  if (d.reason === 'dice-hit') return `${head}骰子命中插话（${d.roll.toFixed(2)} < ${c.breakProbability}）→ 不等了，正常节奏回`;
  return `${head}对方正在输入 → 等 ta 打完再回（已等 ${(d.heldForMs / 1000).toFixed(1)}s，上限 ${(c.holdMaxMs / 1000).toFixed(0)}s）`;
}
