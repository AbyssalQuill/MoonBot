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
//      **【2026-09-19 补】**上面这句是原来的设计假设，线上证明它不成立：轮换判定只存在于
//      wake-send 的"会话不忙"那条路，而保持循环让会话一直是忙的 → 计数涨过阈值却没人检查，
//      轮换永远等不到。现在保持循环自己也会看阈值（`rotationDue()`），到点主动放行关回合。
//   5. 同一会话单飞（activeHolds），防止两处同时 steer → 重复注入。
//   6. 每个提前返回都留日志 —— 这个功能吃过四次"静默失败"的亏。
import { log } from '../lib/log.js';
import { getSocialState, saveSocialState } from './social-state.js';
import { reverse, TurnStartAt, collectors, holdActiveKeys } from './session-state.js';
import { steerIntoRunningTurn, markSteerCycleStart, collectMidTurnBatch, rotationDue, markRotatePending } from './wake-send.js';
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

/** 「这个会话是否由回合保持托管」= turn-hold 的灰度判据（wake-send.js 里那道 steer 闸门用的是同一套）。
 *  提出来是因为它现在有**两个**调用点：回合钩子（handleTurnHold）与步边界发车（flushStepBatch）。
 *  ⚠️ wake-send.js 里还有一份等价的内联判据（holdEligible）；改这里时记得同步，别让两处漂移。 */
function isHoldManaged(key, t) {
  const k = String(key || '');
  if (!k || t?.enabled !== true) return false;
  const allow = Array.isArray(t.keys) ? t.keys.map(String).filter(Boolean) : [];
  if (allow.length && !allow.includes(k)) return false;
  if (t.privateOnly !== false && !k.startsWith('private:')) return false;
  return true;
}

/** 本回合"来回次数"记账（保持循环与步边界发车共用一份，避免两处计数漂移让 maxExchanges 失效）。
 *  turn 号变了 = 新回合 → 计数从头开始（与 handleTurnHold/holdLoop 开头那次重置同义）。 */
function noteExchange(key, st, turn) {
  const turnNo = Number(turn) || 0;
  if (turnNo && Number(st._holdTurn) !== turnNo) {
    st._holdTurn = turnNo;
    st._holdExchanges = 0;
    st._holdStartedAt = Date.now();
  }
  st._holdStartedAt = Number(st._holdStartedAt) || Date.now();
  const exchanges = (Number(st._holdExchanges) || 0) + 1;
  st._holdExchanges = exchanges;
  st.rotateTurns = (Number(st.rotateTurns) || 0) + 1;
  saveSocialState();
  return exchanges;
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

  if (!isHoldManaged(key, t)) {
    const allow = Array.isArray(t.keys) ? t.keys.map(String).filter(Boolean) : [];
    if (allow.length && !allow.includes(key)) return { close: true, reason: 'not-allowlisted' };
    if (t.privateOnly !== false && !key.startsWith('private:')) return { close: true, reason: 'not-private' };
    return { close: true, reason: 'not-eligible' };
  }

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
  // 【2026-09-15 合并注入】顺带把"步边界时刻"记进 wake-send（合并注入的防饥饿兜底要用它）。
  markSteerCycleStart(key, 'turn-stopping 钩子');
  try {
    return await holdLoop({ key, sid, st, turn, t, cfg, shouldAbort });
  } finally {
    activeHolds.delete(key);
    holdActiveKeys.delete(key);
  }
}

async function holdLoop({ key, sid, st, turn, t, cfg, shouldAbort }) {
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
  let notLandedLogged = false;   // "报已交付但没落地"只喊一次，避免 200ms 轮询刷屏
  let typingDeferLogged = false; // 【2026-09-16 打字窗合并】"对方还在打字所以继续攒"也只喊一次
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
    /* 【2026-09-19 修「会话轮换永远不触发」】
     * `noteExchange()` 每记一次来回就给 `rotateTurns` +1（**上下文真正膨胀的就是这里**），
     * 但轮换判定过去只存在于 wake-send 的"会话不忙"那条路上 —— 而保持循环恰恰让会话一直是"忙"的，
     * 于是计数涨过阈值却从来没人在看（线上实测 rotateTurns=20 / 阈值 15，`[rotate]` 一条日志都没有）。
     * 现在：阈值一到就**不再保持**，主动放行关回合；回合关掉之后，
     * 下一条消息落地时 isConversationBusy=false → wake-send 的轮换块正常执行。
     * 消息不会丢：没被 steer 的都还在 unread 里，投递看门狗 / 下一次唤醒会取。 */
    const rd = rotationDue(key, st, cfg);
    if (rd.due) {
      markRotatePending(st, true);
      log(`[hold] ${key} rotateTurns=${rd.count}/${rd.threshold} 已到轮换阈值 → 不再保持，放行关回合（下一条消息落地时执行会话轮换）`);
      return finish('rotate-threshold');
    }
    if (1 + exchanges >= maxExchanges) return finish('max-exchanges');
    if (now() - lastActivity >= idleCloseMs) return finish('idle');
    if (now() - totalStartedAt >= maxWaitMs) return finish('max-wait');
    // 这一段预算用完了但还想继续持有 → 让插件立刻再问一次（保持回合不关，同时不撞 HTTP 超时）
    if (now() >= budgetEnd) {
      saveSocialState();
      log(`[hold] ${key} 本段持有到期（${Math.round(requestBudgetMs / 1000)}s 无新消息），回合继续持有、等插件续问`);
      return { close: false, reason: 'keep-holding', again: true, exchanges };
    }

    // 【2026-09-15 合并注入】触发判据从"钩子开始之后又来新消息"（`lastUnreadSeq > baseline`）改成
    // **"还有没交给模型的消息"**（`collectMidTurnBatch`）。为什么必须改：
    // 合并注入把消息**攒在 unread 里**、不即时投（wake-send.js 的"turn-hold 托管"分支），而它们
    // **在钩子开始之前就到了** —— 用旧判据（baseline 是钩子开始时刻的 lastUnreadSeq）一条都看不见，
    // 保持循环只会干等到预算用完，消息反而被卡住（正是主人抱怨的"等下一次"）。
    // 判据共用 wake-send.js 的 collectMidTurnBatch，和即时注入那条路**同一份规则**，不会漂移。
    const batch = collectMidTurnBatch(st);
    if (batch.length) {
      const topSeq = batch.reduce((mx, m) => Math.max(mx, Number(m?.seq) || 0), 0);
      log(`[hold] ${key} 检测到 ${batch.length} 条待交付消息（baselineSeq=${baseline} → 待交付最新 seq=${topSeq}），尝试 steer…`);
      let ok = false;
      let errText = '';
      try {
        ok = await steerIntoRunningTurn(key, 'turnHold', { force: true });
      } catch (error) {
        errText = String(error?.message ?? error);
      }
      log(`[hold] ${key} steer 结果：${ok === true ? '成功' : (ok === 'typing-defer' ? '推迟（对方还在打字）' : '未成功')}（返回 ${JSON.stringify(ok)}）${errText ? ' 异常=' + errText : ''}`);
      if (ok === 'typing-defer') {
        // 【2026-09-16 打字窗合并】对方还在打字 → 这一批**继续攒**：不投、不改水位、**不关回合**。
        // 为什么不能走下面的 finish()：那会让 DSH 收尾这一轮、消息退回下一轮唤醒 —— 主人要的是
        // "打字期间全部入队，最后合并成一次注入"，而不是"再开一轮"。到 holdMaxMs 上限或骰子命中
        // （判据都在 typing-hold.js）下一次循环就会正常投出去，所以这里不会把消息卡死。
        if (!typingDeferLogged) {
          typingDeferLogged = true;
          log(`[hold] ${key} 对方还在打字 → 这 ${batch.length} 条继续入队（回合不关、水位不动），等 ta 打完一次注入`);
        }
        await sleep(POLL_MS);
        continue;
      }
      if (ok !== true) {
        // "没塞成"≠"消息没进去"：busy 分支与保持循环会同时看到同一条消息，谁先到谁塞；
        // 而且有些消息在**本轮唤醒正文里就已经展示过**（turnSeenUnread），不必再注入。
        // 实测 21:50:23 就是这样：保持循环报 steer-failed，但消息其实已经进了本回合。
        // ⚠️【2026-09-15 合并注入】触发判据换成 collectMidTurnBatch 之后，`batch` 里的行**按定义**
        // 都还没进过 turnSteeredSeqs/turnSeenUnread，所以这个分支实际上已经很难命中 —— 保留它是
        // 防御性的：万一出现别的竞态（例如两处并发交付），也绝不能把"已经给过"误判成 steer-failed
        // 而去关回合（那会把回合连同消息一起丢掉，退回补发轮）。
        const givenSeqs = new Set([
          ...(Array.isArray(st.turnSteeredSeqs) ? st.turnSteeredSeqs : []),
          ...(Array.isArray(st.turnSeenUnread) ? st.turnSeenUnread : []),
        ].map(Number));
        const handled = batch.some((m) => givenSeqs.has(Number(m?.seq)));
        if (handled) {
          exchanges = noteExchange(key, st, turnNo);
          log(`[hold] ${key} 保持循环这次没塞成，但那批已在本回合给过它（唤醒展示或即时注入，记为本回合第 ${1 + exchanges} 次来回，回合继续）`);
          return { close: false, reason: 'already-steered', exchanges };
        }
        return finish(errText ? 'steer-threw' : 'steer-failed');
      }
      // 【2026-09-15 合并注入·硬化】`ok === true` 有三种含义（真塞进去了 / 本回合已经给过它 / 被周期闸攒住），
      // 其中"被周期闸攒住"**什么都没投出去**。此时若照旧返回 close:false，DSH 会看到 next-step 为空而
      // **直接把回合关掉**（dsh-agent-loop:571），表现成"保持悄悄结束了"，消息改走 25s 看门狗 ——
      // 正是这个项目吃过四次的那类"静默失败"。所以记这一笔之前**必须验证真的投出去了**：
      // 判据就是"这批 seq 现在已不在待交付批里"（进了 turnSteeredSeqs/turnSeenUnread 或被别的路径交付）。
      // 没落地就继续持有 + 重试（循环本身受 budget/idle/max 约束，不会空转），绝不谎报成功。
      const notLanded = collectMidTurnBatch(st);
      if (notLanded.length) {
        if (!notLandedLogged) {
          notLandedLogged = true;
          log(`[hold] ${key} steer 报"已交付"但仍有 ${notLanded.length} 条没落地（多半是被周期闸攒住/并发交付）→ 继续持有并重试，不谎报成功`);
        }
        await sleep(POLL_MS);
        continue;
      }
      exchanges = noteExchange(key, st, turnNo);
      baseline = Number(st.lastUnreadSeq) || 0;
      lastActivity = now();
      log(`[hold] ${key} 回合保持：这 ${batch.length} 条已合成一个 [Mid-turn] 注入本回合（本回合来回 ${1 + exchanges}/${maxExchanges}，rotateTurns=${st.rotateTurns}）`);
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

/**
 * 【2026-09-15 合并注入】"步边界发车"的第二个入口（第一个是上面的保持循环）。
 * mux.js 每收到一条会话事件 `step/end`（dsh-agent-loop/lib/index.js:558 在**每个模型步末尾** append）
 * 就调一次这个函数 —— 把这一步里攒下的消息**合成一个** [Mid-turn] 块注入。
 *
 * 为什么光有保持循环不够：保持循环活在 `agent/turn-stopping` 钩子里，而那个钩子**只在"这一步可能就是
 * 最后一步"时才会被 await**（dsh-agent-loop/lib/index.js:564：`if (turnEnds && this.inbox.nextStep.length === 0)`）。
 * 模型连调几个工具的那种步（turnEnds 为空）根本走不到钩子 —— 只靠保持循环的话，这类步里到达的消息
 * 要等到整个回复跑完（回合收尾）才被投出去。而 `step/end` **每一步都有**，在这里发车：
 *   · 送达时刻与"消息一到就即时注入"完全一样（claim 发生在下一个 step 的开端，step/end 正好在它之前）；
 *   · 却仍然只产生**一个** [Mid-turn] 块（这一步里攒下的消息全在这一个块里）。
 * 不满足条件时**静默返回 false**：这个函数每一步都会被调一次，没攒下消息是绝大多数情况，不能打日志刷屏。
 *
 * @returns {Promise<boolean>} 是否真的把一批消息投了出去
 */
export async function flushStepBatch({ key, sid, turn, cfg } = {}) {
  const k = String(key || '');
  const sidText = String(sid || '');
  if (!k || !sidText) return false;
  const t = cfg?.social?.turnHold ?? {};
  // 只对"保持托管"的会话起作用：非保持会话压根不会攒（wake-send.js 的托管分支只对 holdEligible 生效），
  // 这里再挡一道，避免别处误调把消息投成两个块。
  if (!isHoldManaged(k, t)) return false;
  const st = getSocialState(k);
  if (!st) return false;
  const batch = collectMidTurnBatch(st);
  if (!batch.length) return false;                       // 这一步没攒下消息 → 什么都不做（每步都调，不能刷日志）
  if (!TurnStartAt.has(sidText) && !collectors.has(sidText)) {
    log(`[hold] ${k} 步边界发车跳过：回合已经不在跑（TurnStartAt/collectors 都没了），这 ${batch.length} 条留给投递看门狗/下一轮唤醒`);
    return false;
  }
  log(`[hold] ${k} 步边界发车（step/end）：把这 ${batch.length} 条合成一个 [Mid-turn] 注入（不是半路一条一条塞）…`);
  // 【2026-09-19】轮换阈值到了就别再往这一步里塞：否则回合继续跑，轮换下一轮还是轮不到。
  const rdStep = rotationDue(k, st, cfg);
  if (rdStep.due) {
    markRotatePending(st, true);
    log(`[hold] ${k} 步边界发车跳过：rotateTurns=${rdStep.count}/${rdStep.threshold} 已到轮换阈值 → 这一步不注入，先让回合收尾（这 ${batch.length} 条留在未读，轮换后由下一轮唤醒取）`);
    return false;
  }
  let ok = false;
  let errText = '';
  try {
    // noCollect=true：步边界已经是最优的合并点，再等"对方停止输入"只会把这一批拖到下一个步边界。
    ok = await steerIntoRunningTurn(k, 'stepEnd', { force: true, noCollect: true });
  } catch (error) {
    errText = String(error?.message ?? error);
  }
  log(`[hold] ${k} 步边界 steer 结果：${ok === true ? '成功' : (ok === 'typing-defer' ? '推迟（对方还在打字）' : '未成功')}（返回 ${JSON.stringify(ok)}）${errText ? ' 异常=' + errText : ''}`);
  if (ok === 'typing-defer') {
    // 【2026-09-16 打字窗合并】对方还在打字：这一步**不发车**。消息仍在 unread 里（没标"已给"），
    // 下一步的 step/end 会再试一次；一旦对方停手（或到 holdMaxMs 上限/骰子命中）就一次性投出去。
    log(`[hold] ${k} 步边界发车推迟：对方还在打字，这 ${batch.length} 条继续入队等一次注入（不是半路一条一条塞）`);
    return false;
  }
  if (ok !== true) {
    // 没塞成不是灾难：消息仍在 unread 里（没标"已给"），wake-send.js 的兜底判据下次会放行即时注入，
    // 投递看门狗 25s 也会兜。这里只保证**绝不静默**。
    log(`[hold] ${k} 步边界发车未成功：这 ${batch.length} 条留在未读（未标已给），等下一次注入/看门狗兜底`);
    return false;
  }
  // 同 holdLoop 的硬化：`true` 也可能是"被周期闸攒住"，那就什么都没投出去 —— 不能记成一次来回。
  const notLanded = collectMidTurnBatch(st);
  if (notLanded.length) {
    log(`[hold] ${k} 步边界发车报"已交付"但仍有 ${notLanded.length} 条没落地（多半是被周期闸攒住）→ 不记这一次来回，留给下一次步边界/看门狗（不谎报成功）`);
    return false;
  }
  const exchanges = noteExchange(k, st, turn);
  log(`[hold] ${k} 步边界合并注入完成：本回合第 ${1 + exchanges}/${Math.max(1, Math.round(Number(t.maxExchanges) || 24))} 次来回，rotateTurns=${st.rotateTurns}`);
  return true;
}
