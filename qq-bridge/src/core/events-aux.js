// M11 事件辅助：挂起提问/审批应答、拍一拍与输入状态事件
import { withTimeout } from '../lib/async.js';
import { log, appendActivity } from '../lib/log.js';
import { convKey } from '../lib/keys.js';
import { APPROVE_WORDS, REJECT_WORDS } from '../lib/markers.js';
import { currentMode, modeAllowed } from './mode.js';
import { pending } from './session-state.js';
import { getSocialState, saveSocialState, social, scheduleWake, PEER_TYPING_HOLD_MAX_MS } from './social-state.js';
import { sendWakePrompt } from './wake-send.js';
import { sendToQQ } from './qq-send.js';
import { resolveGroupMemberName } from './message-cache.js';
import { appendSocialPoke } from './social-flow.js';

export const PEER_TYPING_EXPIRE_MS = 3000; // 没有新的输入状态事件时的过期时间（原 8000：一次输入事件就能把等待顶到 8 秒后）

let cfgRef = null;
let apiRef = null;
export function initEventsAuxCore(cfg) { cfgRef = cfg; }
export function setEventsAuxApi(api) { apiRef = api; }

export async function cancelPendingEntry(entry) {
  if (!entry) return;
  try {
    if (entry.kind === 'approval') {
      await withTimeout(apiRef.respond({
        type: 'client-response',
        rpcId: entry.rpcId,
        result: { ok: true, value: { sessionId: entry.sessionId, approvalId: entry.approvalId, outcome: 'rejected' } }
      }), 5000, '取消挂起回执');
      log(`已取消挂起审批（拒绝回执）: ${entry.rpcId}`);
    } else if (entry.kind === 'question') {
      await withTimeout(apiRef.respond({
        type: 'client-response',
        rpcId: entry.rpcId,
        result: { ok: true, value: { sessionId: entry.sessionId, answer: { answers: [] } } }
      }), 5000, '取消挂起回执');
      log(`已取消挂起提问（空答案回执）: ${entry.rpcId}`);
    }
  } catch (error) {
    log('取消挂起请求回执失败:', error?.message ?? error);
  }
}

export async function handlePendingAnswer(p, answerText, key, isOwner = false) {
  if (p.kind === 'question') {
    const answers = [];
    for (const q of p.questions) {
      const opts = q.options ?? [];
      const hit = opts.find((o) => o.label.trim().toLowerCase() === answerText.trim().toLowerCase());
      if (hit) answers.push({ id: q.id, selected: [hit.label] });
      else answers.push({ id: q.id, selected: [], custom: answerText });
    }
    try {
      const receipt = await apiRef.respond({
        type: 'client-response',
        rpcId: p.rpcId,
        result: { ok: true, value: { sessionId: p.sessionId, answer: { answers } } }
      });
      log(`已回答提问 (${key}):`, receipt);
      // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
      if (pending.get(key) === p) pending.delete(key);
    } catch (error) {
      log('回答问题失败（保留挂起以便重试）:', error.message);
      await sendToQQ(key, '⚠️ 回答提交失败，请再回复一次。');
    }
    return;
  }
  if (p.kind === 'approval') {
    if (!isOwner) {
      await sendToQQ(key, '审批仅管理员可操作');
      return;
    }
    const t = answerText.trim().toLowerCase();
    let outcome = null;
    for (const w of APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
    for (const w of REJECT_WORDS) if (t === w) outcome = 'rejected';
    if (!outcome) {
      await sendToQQ(key, '请回复「通过」或「拒绝」来决定这个审批');
      return;
    }
    try {
      const receipt = await apiRef.respond({
        type: 'client-response',
        rpcId: p.rpcId,
        result: { ok: true, value: { sessionId: p.sessionId, approvalId: p.approvalId, outcome } }
      });
      log(`已处理审批 (${key}): ${outcome}`, receipt);
      await sendToQQ(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
      // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
      if (pending.get(key) === p) pending.delete(key);
    } catch (error) {
      log('处理审批失败（保留挂起以便重试）:', error.message);
      await sendToQQ(key, '⚠️ 审批回执提交失败，请再回复一次「通过」或「拒绝」。');
    }
    return;
  }
}

export async function handlePokeNotice(event) {
  if (!event || event.sub_type !== 'poke') return;
  const selfId = event.self_id;
  const groupId = event.group_id ?? event.groupId ?? null;
  const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
  const targetIdRaw = event.target_id ?? event.targetId ?? null;
  const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
  const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
  // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
  if (senderId && selfId != null && String(senderId) === String(selfId)) return;
  let key;
  let kind;
  let id;
  if (groupId != null) {
    kind = 'group';
    id = String(groupId);
    key = convKey('group', id);
  } else {
    kind = 'private';
    const peer = event.user_id ?? senderId;
    if (!peer) return;
    id = String(peer);
    key = convKey('private', id);
  }
  if (!modeAllowed(key, kind, id, cfgRef, currentMode)) return;
  // 【2026-09-12 堵漏 · 仍然只针对**群聊**（deepsleep 的语义是"静默群聊，私聊照常"）】
  // 拍一拍原来**绕过** `handleIncoming` 里那道 deepsleep 守卫（`handlePokeNotice` 自己
  // appendSocialPoke + scheduleWake），于是 deepsleep 期间群里被拍一下照样会被唤醒并回复
  // —— 实测证据：活动日志 16:20~16:47 全是"群消息已静默跳过"，而 16:00:54 有一条
  // `[default] 计划唤醒 group:***（poke）`。这不是"私聊要不要静默"的问题，是群静默漏了。
  if (kind === 'group' && cfgRef.social?.deepsleep) {
    appendActivity(key + ' [deepsleep] 群聊拍一拍已静默跳过（不唤醒、不回复）');
    return;
  }
  let sender = senderId;
  if (kind === 'group' && senderId) {
    try {
      sender = await resolveGroupMemberName(Number(id), senderId) || senderId;
    } catch {}
  }
  const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
  const isOwner = String(senderId) === String(cfgRef.ownerQQ ?? '');
  const msg = appendSocialPoke(key, {
    sender,
    userId: senderId || null,
    targetId: targetId || null,
    targetIsSelf,
    isOwner,
    groupId: groupId != null ? String(groupId) : null,
    action: event.action,
    suffix: event.suffix
  });
  appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
  if (social.paused) return;
  const st = getSocialState(key);
  if (!st.bootstrapSent) {
    st.bootstrapSent = true;
    saveSocialState();
    scheduleWake(key, 'bootstrap');
  } else if (st.wakeConfig?.triggers?.poke) {
    scheduleWake(key, 'poke');
  }
}

export async function handleInputStatusNotice(event) {
  if (!event || event.sub_type !== 'input_status') return;
  const peerIdRaw = event.user_id ?? event.sender_id ?? null;
  if (peerIdRaw == null) return;
  const selfId = event.self_id;
  if (selfId != null && String(peerIdRaw) === String(selfId)) return;
  const key = convKey('private', String(peerIdRaw));
  const st = getSocialState(key);
  if (!st || !modeAllowed(key, 'private', Number(peerIdRaw), cfgRef, currentMode)) return;
  if (cfgRef.social?.enabled === false) return;
  const now = Date.now();
  const eventType = Number(event.event_type);
  const statusText = String(event.status_text ?? '');
  const isStop = eventType === 2 || /停止|结束|stop/i.test(statusText);
  if (isStop) {
    st.peerTypingUntil = 0;
    st.peerTypingSince = 0;
    saveSocialState();
    log(`[typing] ${key} 对方停止输入（event_type=${eventType} "${statusText}"）`);
    // 对方已发完：不再“立即投递”，而是保留一小段合并窗口（2s），
    // 把对方紧接着补发的下一条（QQ 输入状态事件并不可靠，stop 后仍可能续发）并进同一轮，
    // 避免“连发两条被拆成两轮完整回复”的重复观感。
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
      st.pendingWakeTimerStartedAt = 0;
      const finalReason = st.pendingWakeReason || 'private';
      st.pendingWakeReason = null;
      const graceMs = 800;
      st.pendingWakeTimerStartedAt = Date.now();
      st.pendingWakeTimer = setTimeout(() => {
        st.pendingWakeTimer = null;
        st.pendingWakeTimerStartedAt = 0;
        log(`[typing] ${key} 停止输入合并窗口结束，投递待发唤醒（${finalReason}）`);
        void sendWakePrompt(key, finalReason).catch((error) => log(`[default] 计划唤醒异常 ${key}:`, error?.message ?? error));
      }, graceMs);
      log(`[typing] ${key} 对方已停止输入，${graceMs / 1000}s 合并窗口后投递（${finalReason}）`);
    }
    return;
  }
  // 对方正在输入：记录状态，若已有待发唤醒则顺延窗口（有总上限，超限就中途唤醒）
  st.peerTypingSince = st.peerTypingSince || now;
  st.peerTypingUntil = now + PEER_TYPING_EXPIRE_MS;
  saveSocialState();
  log(`[typing] ${key} 对方正在输入（event_type=${eventType} "${statusText}"）`);
  if (st.pendingWakeTimer) {
    // 上限取配置里的 social.typing.holdMaxMs（默认 12s）：早先写死 2.5s，遇到"打一长段话"的人会半路插话。
    const holdMaxMs = Math.max(1000, Number(cfgRef?.social?.typing?.holdMaxMs) || PEER_TYPING_HOLD_MAX_MS);
    const started = st.pendingWakeTimerStartedAt || now;
    const elapsed = now - started;
    if (elapsed < holdMaxMs) {
      clearTimeout(st.pendingWakeTimer);
      const extendMs = Math.max(500, Math.min(holdMaxMs - elapsed, 800));
      st.pendingWakeTimer = setTimeout(() => {
        st.pendingWakeTimer = null;
        st.pendingWakeTimerStartedAt = 0;
        const finalReason = st.pendingWakeReason || 'private';
        st.pendingWakeReason = null;
        void sendWakePrompt(key, finalReason).catch((error) => log(`[default] 计划唤醒异常 ${key}:`, error?.message ?? error));
      }, extendMs);
      log(`[typing] ${key} 对方仍在输入，唤醒窗口顺延 ${extendMs}ms（已等 ${(elapsed / 1000).toFixed(1)}s / 上限 ${(holdMaxMs / 1000).toFixed(0)}s）`);
    }
  }
}

export async function registerPending(key, entry) {
  const existing = pending.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    pending.delete(key);
    log(`新挂起请求覆盖旧请求 (${key})`);
    cancelPendingEntry(existing).catch(() => {});
  }
  const timer = setTimeout(() => {
    if (pending.get(key) === entry) {
      pending.delete(key);
      log(`挂起请求超时 (${key})`);
      cancelPendingEntry(entry).catch(() => {});
      sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
    }
  }, cfgRef.questionTimeoutMs);
  entry.timer = timer;
  pending.set(key, entry);
}
