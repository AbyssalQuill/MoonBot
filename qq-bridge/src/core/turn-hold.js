// 回合保持（turn-hold）：**让"唤醒"不再另起一轮** —— 首轮唤醒把回合开起来之后，
// 后续所有消息都用 mode:steer 塞进同一个回合，直到交换阈值/出错才关闭。
//
// ── 原理（已在 DSH 源码逐行核实）────────────────────────────────────────────
// dsh-agent-loop/lib/index.js:564-572：
//   if (turnEnds && this.inbox.nextStep.length === 0) {
//     await this.dispatch.serial("agent/turn-stopping", { turn, signal });   // ← 唯一的 await 点
//   }
//   if (turnEnds && this.inbox.nextStep.length === 0) break;                 // ← 关回合
//   target = "next-step";
// 这一步跑完、没有活着的工具调用、next-step 为空时回合**会**关；但关闭前会 await 一次
// `agent/turn-stopping` 插件钩子，并在钩子返回后**重新检查** next-step。
// 所以只要钩子里肯等，桥就能趁这段时间把新消息 steer 进 next-step —— 回合不关，直接跑下一步。
// 相比之下 `mode:'queue'` 投的是 next-turn，那**必然多出一整轮**（含整包 prompt 重发）。
//
// ── 分工（插件只当时序闸门，桥负责 steer）────────────────────────────────────
//   插件：POST /api/qq/turn-hold 干等桥的回答；桥要它继续持有就立刻再问一次（见下"分段持有"）。
//   桥：决定"继续持有 / 放行关闭"，需要继续时用**既有已验证的** steerIntoRunningTurn() 把消息塞进去。
//
// ── 分段持有（2026-09-11 关键改动）──────────────────────────────────────────
// 单个 HTTP 请求挂不了太久：undici/fetch 的 headersTimeout 默认 300 秒，超了会自己断，
// 于是"长期持有"会被 HTTP 层截断（表现：明明配了长保持，回合还是几十秒就关了）。
// 所以改成：**桥每次只持有 requestBudgetMs（默认 55 秒），需要继续就回 `again:true`，
// 插件收到后立刻再发一次请求**。对 DSH 而言钩子一直在等待，回合一直不关；
// 对 HTTP 而言每个请求都很短，不碰任何超时。
//
// ── 安全 ────────────────────────────────────────────────────────────────────
//   1. 默认关闭：cfg.social.turnHold.enabled !== true → 立刻放行，行为与加这个功能之前完全一致。
//   2. 灰度：keys 非空时只对白名单生效；privateOnly 默认只做私聊。
//   3. **绝不在这里标读**：steer 不碰 unread，只有模型真的发出回复后回合结束的 mux 钩子才清。
//      DSH 的 cancel() 会 inbox.clear()，塞进去没被领会的会在中断时消失 —— 靠 unread 兜底。
//   4. 回合内来回计数写进 rotateTurns，到 maxExchanges 放行关回合，下一轮唤醒由既有轮换切会话。
//   5. 同一会话单飞（activeHolds），防止两处同时 steer → 重复注入。
//   6. 每个提前返回都留日志 —— 这个功能吃过四次"静默失败"的亏。
import { log } from '../lib/log.js';
import { getSocialState, saveSocialState } from './social-state.js';
import { reverse, TurnStartAt, collectors, holdActiveKeys } from './session-state.js';
import { steerIntoRunningTurn, markSteerCycleStart } from './wake-send.js';
import { touchTurnGuardsByKey } from './turn-guard.js';

const POLL_MS = 200;
// 吊住回合期间**没有任何桥 / DSH 事件**，turn-guard 的"静默 180s 判卡死 / 总时长 360s"计时器
// 会一直往前走 → 不续期会被当成卡死而隔离会话（和 qq_wait_for_messages 长轮询同一套做法）。
const RENEW_MS = 5000;

/** key -> 开始时间：同一会话同时只允许一个保持循环。 */
const activeHolds = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 在 DSH 的 agent/turn-stopping 钩子里被调用：决定这个回合是"继续持有"还是"放行关闭"。
 *
 * @returns {Promise<{close: boolean, reason: string, again?: boolean, exchanges?: number}>}
 *   close:true        → 放行关闭（不启用时的默认行为）
 *   close:false,again:false → 已经把新消息 steer 进 next-step，回合会继续跑下一步
 *   close:false,again:true  → 这一段没等来消息，但还要继续持有；插件应立刻再发一次请求
 */
export async function handleTurnHold({ sessionId, turn, cfg, shouldAbort }) {
  const t = cfg?.social?.turnHold ?? {};
  if (t.enabled !== true) return { close: true, reason: 'disabled' };

  const sid = String(sessionId || '');
  const key = reverse.get(sid) || null;
  if (!key) return { close: true, reason: 'no-key' };

  const allow = Array.isArray(t.keys) ? t.keys.map(String).filter(Boolean) : [];
  if (allow.length && !allow.includes(key)) return { close: true, reason: 'not-allowlisted' };
  if (t.privateOnly !== false && !key.startsWith('private:')) return { close: true, reason: 'not-private' };

  const st = getSocialState(key);
  if (!st) return { close: true, reason: 'no-state' };

  const prev = activeHolds.get(key);
  if (prev) {
    log(`[hold] ${key} 已有一个保持在进行中（${Date.now() - prev}ms），本次直接放行（避免双重 steer → 重复回复）`);
    return { close: true, reason: 'already-holding' };
  }
  activeHolds.set(key, Date.now());
  holdActiveKeys.add(key);
  // 【2026-09-12 一次连发只注入一次】这个钩子被调用 = **上一个模型步刚刚结束**（回合正准备关），
  // 也就是"模型步周期"的边界。在这里开一个新的注入周期：本周期内直到下一次钩子回来，
  // 只允许注入一次 [Mid-turn]（详见 wake-send.js 的 STEER_CYCLE_* 注释）。
  markSteerCycleStart(key);
  try {
    return await holdLoop({ key, sid, st, turn, t, shouldAbort });
  } finally {
    activeHolds.delete(key);
    holdActiveKeys.delete(key);
  }
}

async function holdLoop({ key, sid, st, turn, t, shouldAbort }) {
  const now = () => Date.now();
  const maxExchanges = Math.max(1, Math.round(Number(t.maxExchanges) || 24));
  const idleCloseMs = Math.max(1000, Math.round(Number(t.idleCloseMs) || 1800000));
  const maxWaitMs = Math.max(idleCloseMs, Math.round(Number(t.maxWaitMs) || 3600000));
  // 单次 HTTP 请求最多持有多久（必须 < 插件侧 timeoutMs，也必须 < undici 的 300s）。
  const requestBudgetMs = Math.min(120000, Math.max(3000, Math.round(Number(t.requestBudgetMs) || 55000)));

  const turnNo = Number(turn) || 0;
  if (Number(st._holdTurn) !== turnNo) {
    st._holdTurn = turnNo;
    st._holdExchanges = 0;
    st._holdStartedAt = now();   // 跨"分段持有"累计总时长用
  }
  let exchanges = Math.max(0, Number(st._holdExchanges) || 0);
  const totalStartedAt = Number(st._holdStartedAt) || now();

  let baseline = Number(st.lastUnreadSeq) || 0;
  let lastActivity = now();
  let lastRenew = 0;
  const budgetEnd = now() + requestBudgetMs;

  const finish = (reason) => {
    st._holdExchanges = 0;
    st._holdTurn = 0;
    st._holdStartedAt = 0;
    saveSocialState();
    log(`[hold] ${key} 回合保持结束（${reason}，本回合共 ${1 + exchanges} 次来回）`);
    return { close: true, reason, exchanges };
  };

  log(`[hold] ${key} 回合保持开始（turn=${turnNo}，已来回 ${1 + exchanges}/${maxExchanges}，baselineSeq=${baseline}，本段预算 ${Math.round(requestBudgetMs / 1000)}s，空闲 ${Math.round(idleCloseMs / 1000)}s 后放行）`);

  while (true) {
    if (shouldAbort && shouldAbort()) return finish('client-gone');
    if (!TurnStartAt.has(sid) && !collectors.has(sid)) return finish('turn-gone');
    if (1 + exchanges >= maxExchanges) return finish('max-exchanges');
    if (now() - lastActivity >= idleCloseMs) return finish('idle');
    if (now() - totalStartedAt >= maxWaitMs) return finish('max-wait');
    // 这一段预算用完了但还想继续持有 → 让插件立刻再问一次（保持回合不关，同时不撞 HTTP 超时）
    if (now() >= budgetEnd) {
      saveSocialState();
      log(`[hold] ${key} 本段持有到期（${Math.round(requestBudgetMs / 1000)}s 无新消息），回合继续持有、等插件续问`);
      return { close: false, reason: 'keep-holding', again: true, exchanges };
    }

    const seq = Number(st.lastUnreadSeq) || 0;
    if (seq > baseline) {
      log(`[hold] ${key} 检测到新消息（baselineSeq=${baseline} → seq=${seq}），尝试 steer…`);
      let ok = false;
      let errText = '';
      try {
        ok = await steerIntoRunningTurn(key, 'turnHold', { force: true });
      } catch (error) {
        errText = String(error?.message ?? error);
      }
      log(`[hold] ${key} steer 结果：${ok === true ? '成功' : '未成功'}（返回 ${JSON.stringify(ok)}）${errText ? ' 异常=' + errText : ''}`);
      if (ok !== true) {
        // "没塞成"≠"消息没进去"：busy 分支与保持循环会同时看到同一条消息，谁先到谁塞；
        // 而且有些消息在**本轮唤醒正文里就已经展示过**（turnSeenUnread），不必再注入。
        // 实测 21:50:23 就是这样：保持循环报 steer-failed，但消息其实已经进了本回合。
        const givenSeqs = new Set([
          ...(Array.isArray(st.turnSteeredSeqs) ? st.turnSteeredSeqs : []),
          ...(Array.isArray(st.turnSeenUnread) ? st.turnSeenUnread : []),
        ].map(Number));
        const handled = (Array.isArray(st.unread) ? st.unread : []).some(
          (m) => Number(m.seq) > baseline && givenSeqs.has(Number(m.seq))
        );
        if (handled) {
          exchanges += 1;
          st._holdExchanges = exchanges;
          st.rotateTurns = (Number(st.rotateTurns) || 0) + 1;
          saveSocialState();
          log(`[hold] ${key} 保持循环这次没塞成，但那批已在本回合给过它（唤醒展示或即时注入，记为本回合第 ${1 + exchanges} 次来回，回合继续）`);
          return { close: false, reason: 'already-steered', exchanges };
        }
        return finish(errText ? 'steer-threw' : 'steer-failed');
      }
      exchanges += 1;
      st._holdExchanges = exchanges;
      st.rotateTurns = (Number(st.rotateTurns) || 0) + 1;
      saveSocialState();
      baseline = Number(st.lastUnreadSeq) || 0;
      lastActivity = now();
      log(`[hold] ${key} 回合保持：新消息已在本回合内（刚注入 / 本回合已展示，本回合来回 ${1 + exchanges}/${maxExchanges}，rotateTurns=${st.rotateTurns}）`);
      // 一次钩子只塞一批：立刻返回，插件随即返回，DSH 重新检查 next-step 发现非空 → 继续跑下一步。
      return { close: false, reason: 'steered', exchanges };
    }

    if (now() - lastRenew >= RENEW_MS) {
      lastRenew = now();
      try { touchTurnGuardsByKey(key); } catch (_) {}
    }
    await sleep(POLL_MS);
  }
}
