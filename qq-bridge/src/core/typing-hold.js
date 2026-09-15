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
