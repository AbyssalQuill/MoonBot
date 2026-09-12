// 回合监控/看门狗/循环复读守卫
// api（DSH client）经 setTurnGuardApi 注入（quarantineSession 归档用）。
import { log, appendActivity } from '../lib/log.js';
import { normalizeLoopSignature } from '../lib/loop-guard.js';
import { mdToPlain } from '../md-to-plain.js';
import { state, saveState } from './config.js';
import { cancelKeyedSends } from './send-chain.js';
import { getSocialState, saveSocialState, scheduleWake } from './social-state.js';
import { pushCrossDigest } from './crosschat.js';
import {
  pendingWakeKeys, pendingWakeLeaseTimers, turnTimeoutTimers, turnTotalTimers,
  loopRepeatState, loopRecoverTimes, activeAiTurns, pendingTurnOutbound,
  toolCallNames, pendingSendToolCalls, sendToolSucceededSessions,
  TurnStartAt, collectors, promptQueues, reverse,
} from './session-state.js';

export const TURN_TIMEOUT_MS = 180000; // 完全静默 180s 判定卡死
export const TURN_TOTAL_TIMEOUT_MS = 360000; // 6 分钟总时长上限
// 长等待/长工具调用期间（qq_wait_for_messages 的 timeoutMs 上限是 social.wait.maxMs，默认 600s）不会有任何
// DSH 会话事件：touchTurnGuardsByKey 只在等待开始/结束各续期一次，180s 阈值必然早于等待结束，会把正常等待误判卡死。
// 给这一段单独一个覆盖整个允许等待窗口的预算（> 600s 上限 + 余量）。
export const LONG_WAIT_TURN_TIMEOUT_MS = 11 * 60 * 1000;
export const LOOP_REPEAT_MAX = 3;
export const LOOP_REPEAT_MIN_CHARS = 10;
export const LOOP_REPEAT_WINDOW_MS = 45 * 60 * 1000;
export const LOOP_RECOVER_COOLDOWN_MS = 10 * 60 * 1000;
export const LOOP_RECOVER_HOURLY_MAX = 2;

let apiRef = null;
/** main 侧 DSH client 就绪后注入（NodeApiClient） */
export function setTurnGuardApi(api) {
  apiRef = api;
}

export function armPendingWakeLease(key) {
  const old = pendingWakeLeaseTimers.get(key);
  if (old) clearTimeout(old);
  const timer = setTimeout(() => {
    pendingWakeKeys.delete(key);
    pendingWakeLeaseTimers.delete(key);
  }, 30 * 60 * 1000);
  timer.unref?.();
  pendingWakeLeaseTimers.set(key, timer);
}

export function disarmPendingWakeLease(key) {
  const old = pendingWakeLeaseTimers.get(key);
  if (old) clearTimeout(old);
  pendingWakeLeaseTimers.delete(key);
}

export function clearAllPendingWakeLeases() {
  for (const t of pendingWakeLeaseTimers.values()) clearTimeout(t);
  pendingWakeLeaseTimers.clear();
}

export function quarantineSession(key, sessionId) {
  const q = promptQueues.get(key);
  if (q) {
    // 丢弃"已入队未投递"的项时必须拒绝它们：原实现只清空数组，等待方（sendWakePrompt 的
    // `await deliverRef(...)`、mux 的提醒投递）的 Promise 永不落定 → 该唤醒永久挂起、
    // wakeTimes 回滚与 sleepUntil 还原永不执行。与 drainPromptQueue 的语义保持一致。
    for (const item of q.queue) {
      try { item.reject(new Error('会话已隔离，投递取消')); } catch {}
    }
    q.queue = [];
    // 注意：这里不再强制 `q.running = false`。正在途中的那次投递会在 30s 超时内自行结束；
    // 一旦强清 running，新的唤醒可以在旧投递还挂着时并发投递同一个会话，旧投递收尾时又会
    // 删掉 promptQueues 条目 → isConversationBusy 看不到在途投递 → 同一批消息可能被重复投喂。
  }
  cancelKeyedSends(key); // 隔离重建：取消该会话已入链但未开始的旧发送任务
  pendingWakeKeys.delete(key);
  disarmPendingWakeLease(key);
  try { apiRef.workspace.archiveSession({ sessionId }).catch(() => {}); } catch {}
  // 清理该会话的残留状态，避免旧 turn 的痕迹污染新会话
  TurnStartAt.delete(sessionId);
  collectors.delete(sessionId);
  clearTurnTotalTimer(sessionId);
  toolCallNames.delete(sessionId);
  pendingSendToolCalls.delete(sessionId);
  sendToolSucceededSessions.delete(sessionId);
  if (sessionId && reverse.get(sessionId) === key) reverse.delete(sessionId);
  if (sessionId && state.sessions[key] === sessionId) {
    delete state.sessions[key];
    state.sessions[key] = null;
  }
  // 落盘：state.sessions 只在 boot/SIGINT/SIGTERM/ensureSession/rotate 等处保存，隔离这条路径原来只改内存；
  // 之后任何一次重启都会从 sessions.json 把这个已被隔离（甚至已被归档）的旧会话读回来 →
  // 唤醒继续投递给它 → 又是 180s 无事件 → 再被隔离一次（bridge.log 17:12:17 隔离 session-8801c049、
  // 17:16:52 该会话被归档、17:25:26 重启后 17:28:27 又对同一个 session-8801c049 判卡死）。
  saveState();
  // 重建新会话后首轮会注入完整历史：标记“刚重置”，让 AI 知道旧话题多数已回应过，
  // 只针对真正的最新消息回复，避免把几分钟前已答过的内容（如玩笑/情绪话题）又翻出来重复长篇回应。
  try {
    const stQ = getSocialState(key);
    stQ._justAutoReset = true;
    stQ._quarantineRebuilt = true;
    stQ._quarantineRebuiltAt = Date.now();
    stQ.sessionToolCalls = 0; // 隔离重建后工具轮数清零，避免新会话刚起步就被轮换
    saveSocialState();
  } catch {}
  // 清理循环复读监测的会话残留（2026-09-03）
  loopRepeatState.delete(key);
  activeAiTurns.delete(key);
  pendingTurnOutbound.delete(key);
  log(`[default] 卡死会话已隔离：${sessionId} -> ${key}（下次唤醒重建新会话）`);
}

export function recordAiTurnOutbound(key, texts) {
  if (!activeAiTurns.has(key)) return;
  const arr = pendingTurnOutbound.get(key) ?? [];
  for (const raw of Array.isArray(texts) ? texts : [texts]) {
    const item = (raw && typeof raw === 'object') ? String(raw.text ?? raw.message ?? '') : String(raw ?? '');
    if (item && item.trim()) arr.push(item.trim());
  }
  if (arr.length) pendingTurnOutbound.set(key, arr);
}

export function finishTurnLoopGuard(key, sessionId, ended) {
  const outbound = pendingTurnOutbound.get(key) ?? [];
  pendingTurnOutbound.delete(key);
  activeAiTurns.delete(key);
  let aiText = '';
  if (ended && ended.reason && ended.reason.kind === 'completed' && ended.text && String(ended.text).trim()) {
    aiText = mdToPlain(String(ended.text));
  }
  const joined = [aiText, ...outbound].filter((t) => t && String(t).trim()).join('\n').trim();
  if (!joined) { loopRepeatState.delete(key); return; }
  try { pushCrossDigest(key, joined.slice(0, 70)); } catch {}
  const sig = normalizeLoopSignature(joined);
  if (sig.length < LOOP_REPEAT_MIN_CHARS) { loopRepeatState.delete(key); return; }
  const now = Date.now();
  const prev = loopRepeatState.get(key);
  if (prev && prev.sig === sig && now - prev.firstAt <= LOOP_REPEAT_WINDOW_MS) {
    prev.count += 1;
    prev.lastAt = now;
  } else {
    loopRepeatState.set(key, { sig, count: 1, firstAt: now, lastAt: now });
    return;
  }
  if (prev.count < LOOP_REPEAT_MAX) return;
  loopRepeatState.delete(key);
  // —— 命中：自动恢复。先做频控：同一会话有冷却期 + 每小时上限，防止连环重启。 ——
  const times = (loopRecoverTimes.get(key) ?? []).filter((t) => now - t < 3600 * 1000);
  loopRecoverTimes.set(key, times);
  const stCap = getSocialState(key);
  const holdOn = (stCap && Number(stCap._loopHoldUntil || 0) > now - 5000) || false;
  if (holdOn) return; // 已在 30 分钟冷却期内，不再重复重启
  const sinceLast = times.length ? now - Math.max(...times) : Infinity;
  if (times.length >= LOOP_RECOVER_HOURLY_MAX || sinceLast < LOOP_RECOVER_COOLDOWN_MS) {
    const holdUntil = now + 30 * 60 * 1000;
    if (stCap) {
      stCap._loopHoldUntil = holdUntil;
      try { saveSocialState(); } catch {}
    }
    log(`[default] ${key} 复读未根治（自动重启达上限），进入 30 分钟冷却，抑制内部唤醒避免继续烧 token`);
    appendActivity(`${key} 复读循环冷却：30 分钟内抑制内部唤醒`);
    return;
  }
  times.push(now);
  loopRecoverTimes.set(key, times);
  log(`[default] ${key} 检测到连续 ${LOOP_REPEAT_MAX} 次相同回复（疑似上下文过长复读卡死），自动归档会话并重开`);
  appendActivity(`${key} 复读循环自动恢复：归档会话、重开新上下文`);
  quarantineSession(key, sessionId);
  const stL = getSocialState(key);
  if (stL) {
    stL._loopRestarted = true;
    stL._loopRestartedAt = now;
    stL._loopHoldUntil = 0;
    try { saveSocialState(); } catch {}
    const hasUnread = Array.isArray(stL.unread) && stL.unread.length > 0;
    if (hasUnread) { try { scheduleWake(key, 'loopRecovery'); } catch {} }
  }
}

/**
 * 桥自己是否还在等这个回合（=有资格判定"卡死"的唯一证据）。
 * DSH 事件流重连/重启会把会话历史重放一遍：重放片段里的 turn/start（或任一没走到 turn/end 的事件）
 * 会重新武装看门狗并留下 TurnStartAt / collectors，但那个回合其实早已结束。只有桥自己投递过唤醒
 * （pendingWakeKeys：sendWakePrompt 投递前 add、turn/end 时 delete）或该会话还有投递在途，才说明
 * 确实有一个桥在等的回合没回来。
 */
function bridgeWaitingForTurn(key) {
  if (!key) return false;
  if (pendingWakeKeys.has(key)) return true;
  const q = promptQueues.get(key);
  return !!(q && q.running);
}

/** 幽灵回合（桥没在等）的收尾：只清本地回合标记，让会话重新可唤醒；不动 DSH 会话、不落盘会话映射。 */
function clearStaleTurnState(sessionId, key) {
  TurnStartAt.delete(sessionId);
  collectors.delete(sessionId);
  clearTurnTotalTimer(sessionId);
  toolCallNames.delete(sessionId);
  pendingSendToolCalls.delete(sessionId);
  sendToolSucceededSessions.delete(sessionId);
  if (key) {
    activeAiTurns.delete(key);
    pendingTurnOutbound.delete(key);
  }
}

export function armTurnWatchdog(sessionId, timeoutMs = TURN_TIMEOUT_MS) {
  const old = turnTimeoutTimers.get(sessionId);
  if (old) clearTimeout(old);
  turnTimeoutTimers.set(sessionId, setTimeout(() => {
    turnTimeoutTimers.delete(sessionId);
    if (TurnStartAt.has(sessionId) || collectors.has(sessionId)) {
      const silentSec = Math.round(timeoutMs / 1000);
      const wedgedKey = reverse.get(sessionId);
      // 幽灵回合不隔离：日志 16:15:01（三会话同一秒）、16:31:54、17:12:17、17:28:27 四处连续隔离，
      // 都恰好发生在桥重启/DSH 重连的 180s 之后，而被隔离会话的真实最后活动时间早了 15 分钟~36 小时，
      // 根本没有在跑的回合 —— 直接隔离归档会白白丢掉会话上下文。
      if (!bridgeWaitingForTurn(wedgedKey)) {
        log(`[default] 回合标记过期清理：${sessionId} 静默超过 ${silentSec}s 但桥未在等该回合（多为 DSH 重连重放的陈旧 turn），仅清理本地状态、不隔离会话`);
        clearStaleTurnState(sessionId, wedgedKey);
        return;
      }
      TurnStartAt.delete(sessionId);
      collectors.delete(sessionId);
      log(`[default] 回合卡死判定：${sessionId} 完全静默超过 ${silentSec}s（无任何事件），强制隔离`);
      quarantineSession(wedgedKey, sessionId);
      const stW = getSocialState(wedgedKey);
      if (stW && Array.isArray(stW.unread) && stW.unread.length > 0) {
        log(`[default] ${wedgedKey} 有 ${stW.unread.length} 条未读，投递到新会话`);
        scheduleWake(wedgedKey, 'timeoutRecovery');
      }
    }
  }, timeoutMs));
}

export function armTurnTotalTimer(sessionId) {
  const old = turnTotalTimers.get(sessionId);
  if (old) clearTimeout(old);
  turnTotalTimers.set(sessionId, setTimeout(() => {
    turnTotalTimers.delete(sessionId);
    if (TurnStartAt.has(sessionId) || collectors.has(sessionId)) {
      const wedgedKey = reverse.get(sessionId);
      if (!bridgeWaitingForTurn(wedgedKey)) {
        log(`[default] 回合标记过期清理：${sessionId} 超过 ${TURN_TOTAL_TIMEOUT_MS / 1000}s 但桥未在等该回合（多为 DSH 重连重放的陈旧 turn），仅清理本地状态、不隔离会话`);
        clearStaleTurnState(sessionId, wedgedKey);
        return;
      }
      TurnStartAt.delete(sessionId);
      collectors.delete(sessionId);
      log(`[default] 回合总时长超限：${sessionId} 超过 ${TURN_TOTAL_TIMEOUT_MS / 1000}s 仍未结束（疑似模型无限重复输出），强制隔离`);
      quarantineSession(wedgedKey, sessionId);
      const stT = getSocialState(wedgedKey);
      if (stT && Array.isArray(stT.unread) && stT.unread.length > 0) {
        scheduleWake(wedgedKey, 'timeoutRecovery');
      }
    }
  }, TURN_TOTAL_TIMEOUT_MS));
  turnTotalTimers.get(sessionId)?.unref?.();
}

export function clearTurnTotalTimer(sessionId) {
  const t = turnTotalTimers.get(sessionId);
  if (t) { clearTimeout(t); turnTotalTimers.delete(sessionId); }
}

/** 活动续期：工具调用/结果等事件到达时重算总时长起点，避免把“长工具执行（含 qq_wait_for_messages 等）”误判为卡死。 */
export function touchTurnTotalTimer(sessionId) {
  if (!TurnStartAt.has(sessionId) && !collectors.has(sessionId)) return;
  const t = turnTotalTimers.get(sessionId);
  if (t) { clearTimeout(t); turnTotalTimers.delete(sessionId); }
  armTurnTotalTimer(sessionId);
}

/** 按会话 key 续期两个看门狗（长等待/长工具调用起止时调用），防止中途误隔离。
 *  这里的"长等待"是指 qq_wait_for_messages（最长 = social.wait.maxMs，默认 600s）——整段等待期间不会
 *  有任何会话事件，所以静默看门狗必须换成覆盖整个等待窗口的预算，否则 180s 一到就把等待中的会话隔离掉。 */
export function touchTurnGuardsByKey(key) {
  const sid = state && state.sessions ? state.sessions[key] : null;
  if (!sid) return;
  armTurnWatchdog(sid, LONG_WAIT_TURN_TIMEOUT_MS);
  touchTurnTotalTimer(sid);
}

export function clearAllTurnTotalTimers() {
  for (const t of turnTotalTimers.values()) clearTimeout(t);
  turnTotalTimers.clear();
}
