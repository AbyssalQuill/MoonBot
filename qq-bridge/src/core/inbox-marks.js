/**
 * 「这批消息交给 next-step 之后，模型到底跑没跑那一步」的记账。
 *
 * 【2026-09-22 修「私聊 4 分半不回复」，线上现场】
 *   11:21:39 模型跑完 step 2（会话日志 step/end），回合没关，保持循环进入 `agent/turn-stopping` 钩子；
 *   11:21:57 主人第一条新消息由 wake-send 的 steer **塞进 next-step**（会话日志 agent/inbox/spliced）；
 *   11:23:5x 第二条到达，保持循环自己那几次 steer 全被"对方还在打字"挡住（typing-defer 退避）；
 *   11:24:17 第二条也被 steer 塞进 next-step（同一个 next-step 里两条都在）；
 *   11:24:24 保持循环 55s 预算到期：它看 `collectMidTurnBatch` 已经空了（批次被**别的路径**投出去了），
 *            于是走"继续持有"分支，回 `{close:false, again:true}`；插件照做再问一次、再等 55s……
 *   之后每 55s 重复一次（11:25:19、11:26:14…），而 DSH 的 `agent/turn-stopping` 钩子一直被这个循环占着
 *   —— 钩子不返回，DSH 就走不到 `next-step 非空 → target = "next-step"`（见 turn-hold.js 顶部引的
 *   dsh-agent-loop 源码），那两条消息静静躺在会话里没人回答，直到 30 分钟空闲放行（`idleCloseMs`）。
 *
 *   本质：**把批次"交进 next-step"被当成了"已经给模型了"**（wake-send 的 turnSteeredSeqs/lastDeliveredSeq
 *   都记上了），但真正被模型读到要等下一步跑起来；保持循环不返回，那一步就永远跑不起来。
 *
 * 判据：交付时的"步结束计数" == 当前的"步结束计数" → 交了但还没跑过新的模型步 → 立刻放行。
 *   用**计数**而不是时间戳：`flushStepBatch` 就是在 step/end 那一刻发车的，两个时间戳常常同一毫秒，
 *   用 `delivered > stepEnd` 判会漏掉这一整类（正是需要放行的那一类）。模型跑完下一步会再加一次计数，
 *   关系自动恢复正常，保持循环照常工作；turn/end 清账，避免影响下一回合。
 */
const stepSeq = new Map();        // sid -> 步结束计数
const deliveredSeq = new Map();   // sid -> 交付时的步结束计数
const deliveredAt = new Map();    // sid -> 交付时间（时间窗兜底 + 诊断）

const norm = (sid) => String(sid ?? '').trim();

/** 收到一个模型步的 step/end（mux 每步都调 flushStepBatch，那里会先记一笔） */
export function noteStepEnd(sid) {
  const s = norm(sid);
  if (!s) return;
  stepSeq.set(s, (stepSeq.get(s) || 0) + 1);
}

/** 把一批消息真正塞进 next-step 之后调用（wake-send 的 steer 成功、turn-hold 的步边界发车） */
export function noteInboxDelivery(sid) {
  const s = norm(sid);
  if (!s) return;
  deliveredSeq.set(s, stepSeq.get(s) || 0);
  deliveredAt.set(s, Date.now());
}

/** 回合结束：计数与时间戳一起清掉（新回合重新记账，不受上一回合影响） */
export function clearInboxMarks(sid) {
  const s = norm(sid);
  if (!s) return;
  stepSeq.delete(s);
  deliveredSeq.delete(s);
  deliveredAt.delete(s);
}

/** 交给了 next-step、但模型还没跑过那一步 → true（保持循环据此立刻放行） */
export function inboxDeliveryPending(sid) {
  const s = norm(sid);
  if (!s) return false;
  const at = deliveredAt.get(s) || 0;
  if (!at) return false;
  // 时间窗兜底：正常情况下一秒内就会有 step/end 或 turn/end 把关系抹平；留 10 分钟是防
  // "回合被杀、step/end 与 turn/end 都没等到"的极端情况，避免陈旧记账影响很久之后的保持。
  if (Date.now() - at > 10 * 60e3) return false;
  return (stepSeq.get(s) || 0) <= (deliveredSeq.get(s) || 0);
}

/** 诊断/测试用：当前记账快照（只读拷贝） */
export function inboxMarksSnapshot() {
  const out = {};
  for (const [s, at] of deliveredAt) {
    out[s] = { deliveredAt: at, stepEnds: stepSeq.get(s) || 0, deliveredAtStep: deliveredSeq.get(s) || 0, pending: inboxDeliveryPending(s) };
  }
  return out;
}
