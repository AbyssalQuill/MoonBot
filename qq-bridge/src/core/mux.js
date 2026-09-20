// M11 事件层：
// handleIncoming：QQ 消息 → DSH prompt；pumpMux：DSH 事件流 → QQ。
// cfg/api/bot 运行期注入（initMuxCore/setMuxApi/setMuxBot），其余依赖同 bridge 顶层 import。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap, createTurnCollector } from '../dsh-client.js';
import { mdToPlain, splitForQQ } from '../md-to-plain.js';
import { SENSITIVE_RE, sensitiveHitKind, sensitiveHitSample } from '../sensitive.js';
import { looksLikeUnfinished } from '../wait.js';
import { safeFetchBuffer, validateFetchUrl, looksLikeImageBuffer } from '../safe-fetch.js';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from '../forward.js';
import {
  loadSlang,
  saveSlang,
  upsertSlangEntry,
  buildSlangContext,
  buildExtractionPrompt,
  buildResearchPrompt,
  parseExtractionJson,
  parseResearchJson,
  createSlangEntry,
  mergeEvidence,
  SLANG_STATUS
} from '../slang-learner.js';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed
} from '../sticker-lib.js';
import { resolveFaceRef, formatFaceList } from '../qq-faces.js';
import { makeDocx } from '../make-docx.js';
import { segmentsToText, parseJsonCardText, extractMediaFromSegments, extractFilesFromSegments,
  execFileBuffer, decodeTextBuffer, extractDocxText, parseFileBuffer, fetchFileBytes, readFileContent } from '../lib/message-parse.js';
import {
  ROOT, STATE_DIR, STATE_FILE, ROLE_STATE_FILE, SLANG_FILE, SLANG_SESSION_FILE,
  SOCIAL_STATE_FILE, STICKER_FILE, FEEDBACK_FILE, TOOL_LOG_FILE, ACTIVITY_LOG, BRIDGE_LOG,
  CROSSCHAT_FILE, LOCK_FILE,
} from '../lib/paths.js';
import { readJsonSafe, atomicWriteJson, atomicWriteText } from '../lib/json-fs.js';
import { randInt } from '../lib/rand.js';
import { BJ_WEEK, bjMinutes, bjMinToText, beijingTs, beijingDateKey, parseClockMin, fmtBeijing } from '../lib/time.js';
import { isCjkChar, splitByCjkSpaces, isCjkLikeChar, convertExampleSpacesToComma } from '../lib/cjk-split.js';
import { clampGap, computeGaps } from '../lib/send-gaps.js';
import { normalizeLoopSignature, isDuplicateSendText } from '../lib/loop-guard.js';
import { faceIdFromArtifactContent, resolveArtifactFaceId } from '../lib/qq-face-parse.js';
import { compressImageBuffer, finalizeImageBuffer } from '../lib/image-compress.js';
import { isSafeLocalMediaPath, isProbablySafeImageFileRef } from '../lib/media-guard.js';
import { KNOWN_AGENT_TOKENS, redactSensitiveText, SENSITIVE_ARG_KEYS, redactSensitive, sanitizeToolArgs, escapeCqText, unquoteJsonString } from '../lib/text-safe.js';
import { normalizeOwnerQQ, normalizeIdList, allowed } from '../lib/config.js';
import { readRoleState, writeRoleState, sanitizeRoleName, listRoles } from '../lib/role-access.js';
import { sleep, withTimeout } from '../lib/async.js';
import { convKey, canonicalKey } from '../lib/keys.js';
import { log, appendActivity, readActivityTail } from '../lib/log.js';
import { SILENT_MARKER, isSilentMarker, isSendToolName } from '../lib/markers.js';
import { looksLikeUnquotedArgs } from '../lib/args-repair.js';
import { recoverUnquotedSend } from './args-recover.js';
import { state, loadConfig, loadState, saveState } from './config.js';
import { sendToQQ, initQqSendCore, setQqSendBot } from './qq-send.js';
import { cancelKeyedSends } from './send-chain.js';
import { createMediaDomain } from './media.js';
import {
  DOC_TMP_HOST_DIR, DOC_TMP_CONTAINER_DIR, MAX_DOCX_CHARS, docxQuota,
  loadDocxQuota, docxQuotaReserve, docxQuotaCommit, writeDocxToMount,
  uploadFileToQQ, sendDocx, initDocxCore,
} from './docx.js';
import {
  stickerEnabled, saveStickerStoreSafe, syncStickerLibrary, listStickersFor,
  getStickerImageData, sendSticker2, sendQqFace2,
  stickerEntries, stickerSyncedAt, updateStickerEntries, initStickerCore, setStickerBot,
  writeStickerTmpFile, applyStickerNote2, setStickerRemark2, collectSticker2,
} from './sticker.js';
import { resolveNameToUid } from './memory.js';
import { markMessagesRead } from './memory.js';
import {
  cancelPendingEntry, handlePendingAnswer, handlePokeNotice, handleInputStatusNotice,
  registerPending, initEventsAuxCore, setEventsAuxApi,
} from './events-aux.js';
import {
  evaluateWakeTrigger, buildWakePrompt, sendWakePrompt,
  initWakeCore, setWakeApi, setWakeDeliver,
} from './wake-send.js';
import { resolveGroupMemberName, resolveReplyInfo, expandIncomingForwardPreview, setMessageCacheBot } from './message-cache.js';
import {
  shouldAuditKey, shouldBlockSilentReply, handleSensitiveIntercept, auditAndSend, initAuditCore,
  readFeedbackEntries, appendFeedbackEntry, readToolLog, appendToolLog,
} from './audit.js';
import {
  armPendingWakeLease, disarmPendingWakeLease, clearAllPendingWakeLeases,
  quarantineSession, recordAiTurnOutbound, finishTurnLoopGuard,
  armTurnWatchdog, armTurnTotalTimer, clearTurnTotalTimer, clearAllTurnTotalTimers,
  touchTurnTotalTimer,
  setTurnGuardApi, TURN_TIMEOUT_MS, TURN_TOTAL_TIMEOUT_MS,
} from './turn-guard.js';
import {
  collectors, TurnStartAt, pendingWakeKeys, sessionPromises, promptQueues,
  agentRunningSessions,
  sendToolSucceededSessions, turnTimeoutTimers, turnTotalTimers, loopRepeatState,
  loopRecoverTimes, activeAiTurns, pendingTurnOutbound, toolCallNames, pendingSendToolCalls,
  activeWaits, pendingWakeLeaseTimers, lastWakeRebroadcast, wakeConfigUpdatedKeys,
  markReadCalledKeys, wakeConfigMissCount, reverse,
  queued, queuedHintAt, queueRetries, pending, visionModelAppliedSessions,
  messageMediaStore, activityWakeCooldown, MAX_MEDIA_COUNT, silentTurnQueue,
} from './session-state.js';
/* 【2026-09-20】"漏引号"的工具调用：原始参数串按 callId 暂存，等它真失败后由桥兜底发送。 */
const unquotedArgsByCall = new Map();
import {
  activityWindows, loadActivityWindows, saveActivityWindows, getActivityWindows,
  inActivityWindow, nextActivityWindowStart, activityStatusLine,
  startActivityTick, activityTickTimer,
} from './activity.js';
import {
  ensureSession, ensureVisionModel, bumpSessionEpoch,
  initDshSessionCore, setDshSessionApi, dshReady, setDshReady,
} from './dsh-session.js';
import {
  saveSlangStore, queueSlangTask, invalidateSlangLearnerSession, runSlangExtraction,
  runSlangResearch, maybeQueueSlangExtraction, feedSlangWindow, allowSlangSubmit,
  publicSlangEntry, confirmedSlangList, withSlangContext,
  slangEntries, slangWindows, slangExtractionCooldowns, slangSubmitTimes, feedbackTimes,
  slangResearchingIds, learnerSessions, learnerCollectors, learnerWaiters,
  lastSendDedup, sendCallTimes, slangLearnerSessionId, isPersistentLearner,
  setSlangEntries, setSlangLearnerSessionId, initSlangCore, setSlangApi,
} from './slang.js';
import { handlePersonaLearnCommand } from './persona-learn.js';
import { handlePortraitLearnCommand } from './portrait-learn.js';
import { handleSlangSlashCommand } from './slang.js';
import { meterTokenFrame } from './token-meter.js';
import {
  enqueueForRetry, flushQueue, deliverPrompt, drainPromptQueue, drainAllPromptQueues,
  QUEUE_MAX, initPromptDeliverCore, setPromptApi, setPromptMediaResolver,
} from './prompt-deliver.js';
import {
  appendSocialMessage, appendSocialPoke, resolveReplyTarget, isQuoteTargetSelf,
  findMessageMedia, recordSentMessages, initSocialFlowCore,
} from './social-flow.js';
import {
  getImageDimensions, fetchOneBotImage, fetchFaceMedia, resolveMediaList, fetchMediaData,
  MAX_MEDIA_BYTES, MAX_MEDIA_PIXELS, MAX_MEDIA_STORE_PER_KEY,
  initMediaPipeCore, setMediaPipeBot,
} from './media-pipe.js';
import {
  tunableListItems, findTunable, applyTunable, rearmProactiveTimersAfterChange,
  tokenBelongsToOwner, TUNABLE_SPECS, setTunableCfg,
} from './tunables.js';
import {
  social, defaultWakeConfig, softResetWakeConfig, initSocialCore,
  preSleepWaitBlocked, computeWakeSafety,
  wakePriority, seenForwardIds, saveSocialState,
  refreshDefaultWakeConfig, refreshAllDefaultWakeConfigs, isConversationBusy,
  getSocialState, loadSocialState, ensureWakeable, cancelReplyCheck,
  cancelProactiveCheck, setupSleepTimer, scheduleProactiveCheck, setWakeSender,
  formatParticipation, suggestQuietMs, PEER_TYPING_HOLD_MAX_MS, scheduleWake,
  scheduleReplyCheck, buildWakeReminderPrompt,
  clearSocialTimers, clearAllSocialTimers, resetConversationKeepingLedger,
} from './social-state.js';
import {
  loadScheduledTasks, parseScheduledAt, createScheduledTask, cancelScheduledTask, setScheduledRecorder,
} from './scheduler.js';
import {
  pushCrossDigest, addCrossMail, unreadCrossMails, markCrossMailsRead,
  buildCrossChatBlock, initCrossChatCore,
} from './crosschat.js';
import {
  VALID_MODES, currentMode, closedAgentPreset, selfNickname,
  setCurrentMode, setClosedAgentPreset, setSelfNickname,
  modeAllowed, modePreset, isSessionAllowedInCurrentMode, initModeCore,
} from './mode.js';
import {
  warmGroupName, getGroupDisplayName, formatGroupListLine, warmGroupInfo,
  getCachedGroupInfo, formatGroupInfoLine, initGroupCacheCore, setGroupCacheBot,
} from './group-cache.js';

/* ── /set active|diving [HH:MM-HH:MM] 的解析（2026-09-19 主人要求：英文指令 + 可选时段）──
 * 时段表（activity-windows.json）存的本来就是"什么时候活跃"，所以：
 *   /set active 09:00-01:00 → 活跃 09:00-01:00，其余时间只回 @ / 点名
 *   /set diving 00:00-21:00 → 潜水 00:00-21:00（只回 @ / 点名），其余时间活跃（写的是区间**补集**）
 * 不带时段 = 全天（改的是会话自己的模式）。跨午夜（end <= start）按 +1440 归一。 */
const fmtClockMin = (m) => {
  const v = ((Number(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
};
function parseClockRange(rest) {
  const m = String(rest ?? '').trim().match(/^(\d{1,2})[:：](\d{2})\s*[~-]\s*(\d{1,2})[:：](\d{2})$/);
  if (!m) return null;
  const sH = Number(m[1]), sM = Number(m[2]), eH = Number(m[3]), eM = Number(m[4]);
  if (sH > 23 || eH > 23 || sM > 59 || eM > 59) return null;
  const start = sH * 60 + sM;
  let end = eH * 60 + eM;
  if (end <= start) end += 1440;               // 跨午夜；起止相同 = 整天 → 0..1440
  return { start, end };
}
function complementWindows(range) {
  const { start: s, end: e } = range;
  const out = [];
  if (e > 1440) { const cs = e - 1440; if (cs < s) out.push({ start: cs, end: s }); }
  else { if (s > 0) out.push({ start: 0, end: s }); if (e < 1440) out.push({ start: e, end: 1440 }); }
  return out;
}
/** 解析 /set active|diving|mode；不匹配返回 null，时段格式非法返回 { invalid:true } */
function parseSetModeCommand(text) {
  const s = String(text ?? '').trim();
  const legacy = s.match(/^\/set\s+mode\s+(active|diving)$/i);
  if (legacy) return { mode: legacy[1].toLowerCase(), range: null };
  const m = s.match(/^\/set\s+(active|diving)(?:\s+(.+))?$/i);
  if (!m) return null;
  const mode = m[1].toLowerCase();
  const rest = String(m[2] ?? '').trim();
  if (!rest) return { mode, range: null };
  const range = parseClockRange(rest);
  if (!range) return { mode, range: null, invalid: true };
  return { mode, range };
}
// 供 tests/wake-trigger.test.js 直接 import（纯函数，不依赖任何运行期状态）
export { parseSetModeCommand, parseClockRange, complementWindows, fmtClockMin };

// 【2026-09-15 合并注入】步边界 = 模型每一步的末尾（`step/end`）：
//   · markSteerCycleStart / clearSteerPending：复位"本周期已注入"闸门、收掉跨回合的攒批记账；
//   · flushStepBatch：把这一步里攒下的消息**合成一个** [Mid-turn] 块注入（理由见 turn-hold.js 的注释）。
// mux → turn-hold → wake-send 是单向的（这两个模块都不 import mux），不会形成循环依赖。
import { markSteerCycleStart, clearSteerPending } from './wake-send.js';
import { flushStepBatch } from './turn-hold.js';

// 运行期注入：main 持有同一 cfg/api/bot 实例
let cfgRef = null;
export function initMuxCore(cfg) { cfgRef = cfg; }
let apiRef = null;
export function setMuxApi(api) { apiRef = api; }
let botRef = null;
export function setMuxBot(bot) { botRef = bot; }
// 原 main 局部常量（值语义复制）
const QUEUE_HINT_COOLDOWN_MS = 30_000;
const SILENT_TURN_TIMEOUT_MS = 300000;
// 好友守卫关键词（私聊自动删除并拉黑触发词）。拆分前挂在 main/bridge.js 顶层，
// mux 引用但从未导入 → 私聊消息一进好友守卫就抛 ALARM_RE is not defined 而中断
// （表现：私聊完全不回复、群聊正常）。这里按模块就地定义，保持单点唯一。
const ALARM_RE = /(裸聊|约炮|博彩|赌博|刷单|贷款|网贷|借呗|套现|卖号|收号|外挂|代练|脚本代挂|兼职刷|打字员|博彩平台|开奖|六合彩|网络兼职|加我.*(?:微信|QQ).*领取|点击链接|扫码.*(?:返现|领奖)|加群.*(?:免费|红包|福利))/i;

// 入站消息幂等（2026-09-11）：同一条 QQ 消息被重复投递（WS 断线重放、网关重发、
// 桥/管理器重启窗口内新旧实例短暂并存）会让同一批未读被处理两次 —— 用户看到的就是
// “重复回复”。这里按 conv+message_id 做 10 分钟短期去重，命中直接丢弃。
const INBOUND_DEDUP_TTL_MS = 10 * 60 * 1000;
const INBOUND_DEDUP_MAX = 800;
const inboundSeen = new Map(); // `${key}:${messageId}` -> ts
function isDuplicateInbound(key, messageId) {
  const mid = String(messageId ?? '').trim();
  if (!mid || mid === 'undefined' || mid === 'null') return false;
  const now = Date.now();
  if (inboundSeen.size > INBOUND_DEDUP_MAX) {
    for (const [k, t] of inboundSeen) if (now - t > INBOUND_DEDUP_TTL_MS) inboundSeen.delete(k);
    if (inboundSeen.size > INBOUND_DEDUP_MAX) {
      let drop = inboundSeen.size - INBOUND_DEDUP_MAX;
      for (const k of inboundSeen.keys()) { inboundSeen.delete(k); if (--drop <= 0) break; }
    }
  }
  const k = `${key}:${mid}`;
  const prev = inboundSeen.get(k);
  if (prev && now - prev < INBOUND_DEDUP_TTL_MS) return true;
  inboundSeen.set(k, now);
  return false;
}

export async function handleIncoming(kind, id, event, cfgRef) {
  const key = convKey(kind, id);
  if (!modeAllowed(key, kind, id, cfgRef, currentMode)) {
    log(`忽略未授权会话 ${key}（当前模式 ${currentMode}，来自 ${event.user_id}）`);
    return;
  }
  const resolveAtName = async (qq) => {
    // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
    if (kind !== 'group') return null;
    return resolveGroupMemberName(event.group_id, qq);
  };
  const resolveReply = (messageId) => resolveReplyInfo(kind, id, messageId, event.self_id);
  // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
  // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
  const textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply });
  const plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false });
  // 自动好友守卫：私聊里非主人/非受信任者发来违法/诈骗营销内容时，自动删除好友并拉黑
  if (kind === 'private' && cfgRef.social?.autoFriendGuard !== false) {
    const uidS = String(event.user_id ?? '');
    const isTrusted = uidS === String(cfgRef.ownerQQ) || (Array.isArray(cfgRef.social?.trustedCrossSessionUids) && cfgRef.social.trustedCrossSessionUids.map(String).includes(uidS));
    if (!isTrusted && ALARM_RE.test(textContent)) {
      log(`[friend-guard] 私聊 ${uidS} 命中违法/诈骗内容，自动删除好友并拉黑：${textContent.slice(0, 60)}`);
      try { await botRef.deleteFriend(Number(uidS), { block: true }); } catch (e) { log(`[friend-guard] 删除好友失败 ${uidS}: ${e?.message ?? e}`); }
      appendActivity(`${key} [friend-guard] 已删除并拉黑 ${uidS}（违法/诈骗内容）`);
      try { await sendToQQ('private:' + String(cfgRef.ownerQQ), `⚠️ 已自动删除并拉黑可疑用户 ${uidS}（私聊发送违法/诈骗内容）。`); } catch {}
      return;
    }
  }
  const mediaList = extractMediaFromSegments(event.message ?? []);
  const fileList = extractFilesFromSegments(event.message ?? []);
  const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
  const seqRef = event.message_seq != null ? String(event.message_seq) : '';
  const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
  if (refsToStore.length > 0 && mediaList.length > 0) {
    let mediaByRef = messageMediaStore.get(key);
    if (!mediaByRef) {
      mediaByRef = new Map();
      messageMediaStore.set(key, mediaByRef);
    }
    for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
    // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
    while (mediaByRef.size > MAX_MEDIA_STORE_PER_KEY) {
      const oldestKey = mediaByRef.keys().next().value;
      if (oldestKey === undefined) break;
      mediaByRef.delete(oldestKey);
    }
  }
  // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
  // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
  const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
  if (!plainContent && !quoteTargetIsSelf) return;
  // 幂等：重复投递的同一条消息直接丢弃（防重复入库 → 重复唤醒 → 重复回复）
  if (isDuplicateInbound(key, event.message_id ?? event.msg_id)) {
    log(`[dedup] 忽略重复投递的入站消息 ${key} id=${event.message_id ?? event.msg_id}`);
    return;
  }
  const isOwner = String(event.user_id) === String(cfgRef.ownerQQ ?? '') || (Array.isArray(cfgRef.adminQQ) && cfgRef.adminQQ.map(String).includes(String(event.user_id)));
  const roleState = readRoleState();

  // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
  // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
  const p = pending.get(key);
  if (p && (p.kind === 'question' || isOwner)) {
    await handlePendingAnswer(p, plainContent, key, isOwner);
    return;
  }

  // 静默模式：群友消息不投递给 agent（只记录）；管理员消息照常
  if (roleState.mode === 'silent' && !isOwner) {
    appendActivity(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
    log(`静默模式，忽略群友消息 ${key}`);
    return;
  }

  // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
  if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
    await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
    return;
  }

  // 人格学习等自然语言管理指令（内部自行判定管理员；deepsleep/暂停下也即时响应，不唤醒会话）
  try {
    const pr = await handlePersonaLearnCommand(plainContent, { key, kind, isOwner, senderUid: String(event.user_id ?? '') });
    if (pr?.handled) {
      const replyText = Array.isArray(pr.reply) ? pr.reply.join('\n') : '';
      if (replyText.trim()) await sendToQQ(key, replyText);
      return;
    }
  } catch (error) {
    log('人格学习指令处理出错:', error?.message ?? error);
  }

  // 群友画像学习指令（/portrait learn|stop|status、画像学习…）：同样只认管理员，即时响应
  try {
    const pc = await handlePortraitLearnCommand(plainContent, { key, kind, isOwner, senderUid: String(event.user_id ?? '') });
    if (pc?.handled) {
      const replyText = Array.isArray(pc.reply) ? pc.reply.join('\n') : '';
      if (replyText.trim()) await sendToQQ(key, replyText);
      return;
    }
  } catch (error) {
    log('画像学习指令处理出错:', error?.message ?? error);
  }

  // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）。
  // 只识别 / 斜杠(含英文)指令(如 /active /silent /wake /start /deepsleep /set mode active)。
  // 自然语言说法(转活跃/潜水吧/别理群了…)一律放给模型自然调用——由 AI 自己决定并走
  // qq_set_wake_config / qq_set_activity_hours 等工具完成, 桥不硬性截胡、不回模板话。
  if (plainContent.startsWith('/')) {
    if (/^\/slang(\s|$)/.test(plainContent)) {
      // /slang learn / /slang stop：立即学习黑话并打标记 / 停止在跑学习任务（handler 内部判定管理员并拦截非 owner）
      try {
        const sr = await handleSlangSlashCommand(plainContent, { key, kind, isOwner, senderUid: String(event.user_id ?? '') });
        if (sr?.handled) {
          const slangReply = Array.isArray(sr.reply) ? sr.reply.join('\n') : '';
          if (slangReply.trim()) await sendToQQ(key, slangReply);
          return;
        }
      } catch (error) {
        log('黑话指令处理出错:', error?.message ?? error);
      }
    }
    if (!isOwner) {
      await sendToQQ(key, '管理命令仅管理员可用。');
      return;
    }
    // 【2026-09-13 主人要求】删掉 /help（原来是发《小鲸鱼能力概览》docx）：
    // 该指令不再拦截，会按"其它 /xxx"的通用规则交给模型，由它正常回应。
    if (plainContent === '/reset' || plainContent === '/new') {
      const old = state.sessions[key];
      if (old) {
        bumpSessionEpoch();
        cancelKeyedSends(key); // 取消该会话已入链的旧发送任务，避免重置后旧内容仍发出
        delete state.sessions[key];
        reverse.delete(old);
        collectors.delete(old);
        sendToolSucceededSessions.delete(old);
        pendingSendToolCalls.delete(old);
        TurnStartAt.delete(old);
        toolCallNames.delete(old);
        silentTurnQueue.delete(old);
        const pe = pending.get(key);
        if (pe) {
          clearTimeout(pe.timer);
          cancelPendingEntry(pe).catch(() => {});
        }
        pending.delete(key);
        queued.delete(key);
        queuedHintAt.delete(key);
        sessionPromises.delete(key);
        drainPromptQueue(key, '会话已重置');
        messageMediaStore.delete(key);
        slangWindows.delete(key);
        slangExtractionCooldowns.delete(key);
        slangSubmitTimes.delete(key);
        clearSocialTimers(key);
        pendingWakeKeys.delete(key);
        wakeConfigUpdatedKeys.delete(key);
        markReadCalledKeys.delete(key);
        wakeConfigMissCount.delete(key);
        const removed = social.conversations.get(key);
        if (removed?.agentToken) KNOWN_AGENT_TOKENS.delete(removed.agentToken);
        // 【2026-09-16 /reset · /new 也是 reset 家族】原来直接 delete 会把「已回复账本」
        // （answeredMessageIds / lastDeliveredSeq / _wakeIntendedSeq / lastUnreadSeq）一起抹掉，
        // 重置后刚回过的内容可能又被回一遍（真机事故「reset 之后重复回复」）。
        // 改成"清会话、留账本"，见 social-state.resetConversationKeepingLedger。
        const carriedCmd = resetConversationKeepingLedger(key);
        if (!carriedCmd) log(`[reset] ${key} 无账本需要保留（该会话此前没有已回复记录）`);
        clearSocialTimers(key); // 重建账本会重新装配定时器；本命令语义是"清完等下次唤醒重建"
        seenForwardIds.delete(key);
        saveSocialState();
        saveState();
        await sendToQQ(key, '已重置会话，下次消息将开新上下文');
      }
      return;
    }
    if (plainContent === '/status') {
      const rs = readRoleState();
      await sendToQQ(key, `会话 ${state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfgRef) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
      return;
    }
    // ── /op [del] <QQ号|昵称>：设置/取消管理员（仅主人）──────────────────
    if (plainContent === '/op' || plainContent.startsWith('/op ')) {
      const rest = plainContent.slice(3).trim();
      if (!rest) {
        const curL = Array.isArray(cfgRef.adminQQ) && cfgRef.adminQQ.length ? cfgRef.adminQQ.map(String).join('、') : '（无）';
        await sendToQQ(key, `当前管理员：${curL}。用法：/op <QQ号或昵称> 设为管理员；/op del <QQ号或昵称> 取消管理员`);
        return;
      }
      const m = rest.match(/^(del|remove)\s+([^\s]+)$/i) || rest.match(/^([^\s]+)$/);
      if (!m) { await sendToQQ(key, '用法：/op <QQ号或昵称>；/op del <QQ号或昵称>'); return; }
      const isDel = /^(del|remove)$/i.test(m[1]);
      const targetTok = isDel ? m[2] : m[1];
      const target = /^\d{5,11}$/.test(targetTok) ? targetTok : resolveNameToUid(targetTok);
      if (!target) { await sendToQQ(key, `通讯录里没找到「${targetTok}」，直接给我 QQ 号吧~`); return; }
      if (target === String(cfgRef.ownerQQ)) { await sendToQQ(key, '主人就是最高权限，不用设置~'); return; }
      const cur = Array.isArray(cfgRef.adminQQ) ? cfgRef.adminQQ.map(String) : [];
      if (isDel) {
        if (!cur.includes(target)) { await sendToQQ(key, `${target} 本来就不是管理员~`); return; }
        cfgRef.adminQQ = cur.filter((x) => x !== target).map(Number);
        fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(cfgRef, null, 2));
        await sendToQQ(key, `已取消 ${target} 的管理员权限~`);
        log(`[command] ${key} /op del ${target}`);
      } else {
        if (cur.includes(target)) { await sendToQQ(key, `${target} 已经是管理员了~`); return; }
        cur.push(target);
        cfgRef.adminQQ = cur.map(Number);
        fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(cfgRef, null, 2));
        await sendToQQ(key, `✅ 已把 ${target} 设为管理员~`);
        log(`[command] ${key} /op ${target}`);
      }
      return;
    }
    if (plainContent === '/role' || plainContent.startsWith('/role ')) {
      const name = sanitizeRoleName(plainContent.slice(5).trim());
      if (!name || name === 'off' || name === 'clear') {
        writeRoleState(null, roleState.mode);
        await sendToQQ(key, '已清除角色，恢复正常人格。');
      } else {
        const roleFile = path.join(ROOT, 'roles', name + '.md');
        if (!fs.existsSync(roleFile)) {
          await sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
        } else {
          writeRoleState(name, roleState.mode);
          await sendToQQ(key, `已切换角色：${name}。`);
        }
      }
      return;
    }
    if (plainContent === '/silent' || plainContent === '/quiet') {
      writeRoleState(roleState.role, 'silent');
      await sendToQQ(key, '好，我先安静待一阵：群聊我只悄悄看、不再回应（被 @ 也不回啦）。想让我恢复开麦，发 /active 就行。');
      return;
    }
    if (plainContent === '/active' || plainContent === '/speak') {
      writeRoleState(roleState.role, 'active');
      await sendToQQ(key, '好啦，恢复开麦：群聊正常回应，有事随时喊我。');
      return;
    }
    if (plainContent === '/sleep') {
      // 全程静默：不调用 DSH API，不回复，但不终结进程
      social.paused = true;
      saveSocialState();
      await sendToQQ(key, '💤 好的，我先睡了，有事叫我~');
      log(`[command] ${key} 执行 /sleep，AI 已暂停`);
      return;
    }
    if (plainContent === '/wake') {
      social.paused = false;
      social.pausedUntil = null;
      saveSocialState();
      // 清除可能存在的定时恢复（原写法 st._sleepTimer 里的 st 只存在于 /set sleep 分支，
      // 本分支取不到 → ReferenceError: st is not defined，整条 /wake 抛错、既不回话也不清定时器）
      const stWk = getSocialState(key);
      if (stWk._sleepTimer) { clearTimeout(stWk._sleepTimer); stWk._sleepTimer = null; }
      await sendToQQ(key, '醒了~ 有什么事找我？');
      log(`[command] ${key} 执行 /wake，AI 已恢复`);
      return;
    }

    // ── /deepsleep：静默所有群聊（私聊照常）────────────────────────────────
    if (plainContent === '/deepsleep' || /^deepsleep$/i.test(plainContent)) {
      if (!cfgRef.social) cfgRef.social = {};
      cfgRef.social.deepsleep = true;
      fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(cfgRef, null, 2));
      await sendToQQ(key, '好，我先全体休眠：所有群的聊天我先不醒、不回、不收集，省点力气；私聊随叫随到。要整体唤醒，发 /start 就行。');
      log('[command] ' + key + ' 执行 /deepsleep（静默所有群聊）');
      return;
    }
    // ── /start：恢复（deepsleep 反命令）
    if (plainContent === '/start' || /^start$/i.test(plainContent)) {
      if (!cfgRef.social) cfgRef.social = {};
      cfgRef.social.deepsleep = false;
      fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(cfgRef, null, 2));
      await sendToQQ(key, '醒啦，群聊恢复正常：消息我会看也会回，有事随时喊我。');
      log('[command] ' + key + ' 执行 /start（解除群静默）');
      return;
    }
    /* ── /set active [HH:MM-HH:MM] / /set diving [HH:MM-HH:MM] ─────────────
     * 【2026-09-19 主人要求】用英文指令设"特定时段活跃 / 潜水"，不带时段 = 全天；
     * `/set mode active|diving` 保留为等价老写法（不带时段）。中英混写的旧写法
     * （/set mode 活跃、/set mode 潜水）按"去除中英混杂指令"的要求一并删掉。 */
    const setMode = parseSetModeCommand(plainContent);
    if (setMode) {
      if (setMode.invalid) {
        await sendToQQ(key, `时间格式：HH:MM-HH:MM，如 /set ${setMode.mode} 00:00-21:00；不带时段就是全天。`);
        return;
      }
      const stm = getSocialState(key);
      const win = setMode.range;
      /* 带时段时模式一律设成 active：时段**内**活跃，时段**外**由睡眠窗口收紧成"只回 @"；
       * 不带时段才改模式本身（active = 全天活跃；diving = 全天潜水）。 */
      const wantMode = win ? 'active' : setMode.mode;
      if (stm.wakeConfig) {
        stm.wakeConfig.mode = wantMode;
        if (stm.wakeConfig.triggers) stm.wakeConfig.triggers.anyMessage = wantMode === 'active';
        stm.wakeConfig.infinite = true;
        stm.wakeConfig.sleepUntil = null;      // 取消"睡到下一时段"的定时
        stm.wakeConfig.confirmedAt = Date.now();
        stm.wakeConfig.confirmedBy = 'user';   // 管理员显式设定：防遗忘/默认刷新等兜底不得覆盖
      }
      if (stm._sleepTimer) { clearTimeout(stm._sleepTimer); stm._sleepTimer = null; }
      if (win) {
        activityWindows[key] = setMode.mode === 'active' ? [win] : complementWindows(win);
        saveActivityWindows();
      } else if (activityWindows[key]) {
        delete activityWindows[key];           // 全天模式：时段约束一并去掉，免得时段提示让它窗外潜水
        saveActivityWindows();
      }
      saveSocialState();
      const rng = win ? `${fmtClockMin(win.start)}-${fmtClockMin(win.end)}` : '';
      if (setMode.mode === 'active') {
        await sendToQQ(key, win
          ? `好呀，${rng} 我全程在线：这段时间群里说啥我都接；其它时间潜水，只回 @ 和点名。`
          : '好呀，我转成全天在线啦：群里说啥我都接，随时都在。');
      } else {
        await sendToQQ(key, win
          ? `好，${rng} 我先潜水：这段时间只回 @、被点名和私聊，其余时间照常活跃。`
          : '好，我先潜水啦：平时群里不打扰大家，被 @、被点名或有人问我时会出来；私聊随叫随到。要我全程在线，发 /set active 就行。');
      }
      log(`[command] ${key} /set ${setMode.mode}${win ? ' ' + rng : ''}（会话模式=${wantMode}，活跃时段=${(activityWindows[key] ?? []).map((w) => `${fmtClockMin(w.start)}-${fmtClockMin(w.end)}`).join(',') || '无'}）`);
      return;
    }

    if (plainContent.startsWith('/set sleep')) {
      // 时间段作息：/set sleep 01:00-06:00（北京时间，每天在这个窗口内群聊只响应 @，其余不读、省 token；私聊不限制）
      const windowMatch = plainContent.match(/^\/set sleep (\d{1,2})[:：](\d{2})\s*[~-]\s*(\d{1,2})[:：](\d{2})$/);
      if (windowMatch) {
        const sH = parseInt(windowMatch[1], 10), sM = parseInt(windowMatch[2], 10);
        const eH = parseInt(windowMatch[3], 10), eM = parseInt(windowMatch[4], 10);
        if (sH > 23 || eH > 23 || sM > 59 || eM > 59) {
          await sendToQQ(key, '时间格式：HH:MM-HH:MM，如 /set sleep 01:00-06:00'); return;
        }
        social.sleepWindow = { start: `${String(sH).padStart(2, '0')}:${String(sM).padStart(2, '0')}`, end: `${String(eH).padStart(2, '0')}:${String(eM).padStart(2, '0')}` };
        saveSocialState();
        await sendToQQ(key, `💤 好的，我每天 ${social.sleepWindow.start}~${social.sleepWindow.end} 睡觉（群里只回 @，其余不读省电；私聊随叫随到）。晚安~`);
        log(`[command] ${key} 执行 /set sleep 时间段 ${social.sleepWindow.start}-${social.sleepWindow.end}`);
        return;
      }
      // 相对定时休息：/set sleep 30m 或 /set sleep 2h
      const match = plainContent.match(/^\/set sleep (\d+)([mh])$/);
      if (!match) { await sendToQQ(key, '格式：/set sleep 01:00-06:00（时间段） 或 /set sleep 30m / 2h（定时）'); return; }
      const val = parseInt(match[1]);
      const unit = match[2] === 'h' ? 3600000 : 60000;
      const duration = val * unit;
      social.paused = true;
      social.pausedUntil = Date.now() + duration;
      saveSocialState();
      const st2 = getSocialState(key);
      if (st2._sleepTimer) clearTimeout(st2._sleepTimer);
      st2._sleepTimer = setTimeout(() => {
        social.paused = false;
        social.pausedUntil = null;
        saveSocialState();
        log(`[sleep] ${key} 定时休息 ${val}${match[2]} 结束`);
      }, duration);
      const timeStr = match[2] === 'h' ? `${val}小时` : `${val}分钟`;
      await sendToQQ(key, `💤 好的，${timeStr}后叫我~ 先睡咯，晚安~`);
      log(`[command] ${key} 执行 /set sleep ${val}${match[2]}`);
      return;
    }
    if (plainContent === '/set wake' || plainContent === '/set cancel') {
      social.paused = false;
      social.pausedUntil = null;
      social.sleepWindow = null;
      const st2 = getSocialState(key);
      if (st2._sleepTimer) { clearTimeout(st2._sleepTimer); st2._sleepTimer = null; }
      saveSocialState();
      await sendToQQ(key, '好了，已经醒来，不休息了~');
      return;
    }
    if (plainContent.startsWith('/like')) {
      // 手动点赞：/like 123456 或 /like 123456 5
      const match = plainContent.match(/^\/like (\d+)(?:\s+(\d+))?$/);
      if (!match) { await sendToQQ(key, '格式：/like QQ号 或 /like QQ号 次数'); return; }
      const target = Number(match[1]);
      const times = Math.min(10, Math.max(1, Number(match[2]) || 1));
      try {
        await botRef.raw('send_like', { user_id: target, times });
        await sendToQQ(key, `已给 ${target} 点赞 ${times} 次`);
      } catch (error) {
        await sendToQQ(key, `点赞失败：${error?.message ?? String(error)}`);
      }
      return;
    }
    // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
  }

  // default模式（default）：唤醒调度
  if (currentMode === 'default') {
    // 【2026-09-12 定稿：deepsleep **只静默群聊**，私聊照常（主人确认）】
    // 中途曾按"不读取任何消息"改成全会话静默，主人随后纠回"只静默群聊"，所以这里恢复原来的**群聊范围**。
    // 保留的只是两处"堵漏"（都只对群生效，见 events-aux.js 的拍一拍 与 console-server.js 的等待路由）：
    // 改之前拍一拍能绕过本函数的守卫直接 scheduleWake，deepsleep 期间群里被拍一下照样会醒 —— 那是漏洞，不是设计。
    const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
    // 转发（合并聊天记录）自动展开：把收到的 forward 段内容就地展开成可读文本，
    // 让 AI 无需额外调用 qq_get_forward_msg 就能看到“对方转发里到底说了什么”，
    // 避免消息里只有 [转发消息 id=…] 占位符时 AI 因为读不到内容而整条忽略。
    const storeText = await expandIncomingForwardPreview(key, event.message ?? [], textContent);
    appendSocialMessage(key, sender, storeText, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []), Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? '')), fileList);
    // default同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
    if (kind === 'group') {
      feedSlangWindow(key, sender, plainContent);
      const gpId = String((key || '').split(':')[1] || '');
      const silentGroups = Array.isArray(cfgRef.social?.deepsleepGroups) ? cfgRef.social.deepsleepGroups.map(String) : [];
      // deepsleep（群总开关）或「单群静默名单」：群消息入库但**不唤醒、不回复**（私聊不受影响）
      if (cfgRef.social?.deepsleep || silentGroups.includes(gpId)) {
        appendActivity(key + ' [' + (cfgRef.social?.deepsleep ? 'deepsleep' : '群静默') + '] 群聊消息已静默跳过：' + textContent.slice(0, 60));
        return;
      }
    }
    if (social.paused) {
      appendActivity(`${key} [default] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
      return;
    }
    const st = getSocialState(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      saveSocialState();
      scheduleWake(key, 'bootstrap');
    } else {
      const reason = evaluateWakeTrigger(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
      if (reason) {
        scheduleWake(key, reason);
      }
    }
    appendActivity(`${key} [default] 消息已入未读：${textContent.slice(0, 80)}`);
    return;
  }

  // 单默认模式（default=default）下：本函数在 default 分支已 return，以下历史 chat 自动转发 /
  // 一代（reserved 观望状态机）代码不可达，已删除（2026-09-06 单模式化）。
}

export async function pumpMux() {
  for (;;) {
    try {
      log('连接 DSH 事件流…');
      for await (const envelope of apiRef.events.mux({})) {
        const frame = envelope.payload;
        // token 计量：真实 usage 优先，无则累计帧内文本作估算素材（自包含单钩子）
        try { meterTokenFrame(frame); } catch (_) {}
        if (frame.type === 'session/event') {
          const key = reverse.get(frame.sessionId);
          if (!key) {
            // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
            if (learnerSessions.has(frame.sessionId)) {
              const learnerCollector = learnerCollectors.get(frame.sessionId) ?? createTurnCollector();
              learnerCollectors.set(frame.sessionId, learnerCollector);
              const learnerEnded = learnerCollector.push(frame.event);
              if (learnerEnded) {
                learnerCollectors.delete(frame.sessionId);
                const waiters = learnerWaiters.get(frame.sessionId) ?? [];
                const waiter = waiters.shift();
                if (waiters.length === 0) learnerWaiters.delete(frame.sessionId);
                if (waiter) {
                  clearTimeout(waiter.timer);
                  if (learnerEnded.reason.kind === 'completed' && learnerEnded.text.trim()) {
                    waiter.resolve(learnerEnded.text);
                  } else {
                    waiter.reject(new Error(`学习会话 turn 未正常完成：${learnerEnded.reason.kind}`));
                  }
                }
                // 旧学习会话 turn 结束后从集合移除，避免残留（常驻学习会话：黑话 / 人格，保留）
                if (!isPersistentLearner(frame.sessionId)) learnerSessions.delete(frame.sessionId);
              }
            }
            continue;
          }
          // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
          // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
          if (frame.event.type === 'turn/start') {
            sendToolSucceededSessions.delete(frame.sessionId);
            pendingSendToolCalls.delete(frame.sessionId);
            TurnStartAt.set(frame.sessionId, Date.now());
            // 【2026-09-15 合并注入】回合边界同样是注入周期边界：新回合的第一步就是一个全新的周期。
            markSteerCycleStart(key, 'turn/start');
            armTurnTotalTimer(frame.sessionId); // 回合总时长兜底：防模型无限重复输出卡死
            activeAiTurns.add(key);          // 循环复读监测：标记本会话处于 AI 回合
            pendingTurnOutbound.delete(key); // 清空上一回合残留的发送文本
            // 工具调用计数（轮换阈值用）：按"回合"计——每个 turn/start +1。
            // 曾误在每次 tool/call +1，一个回复回合调 3-5 次工具 → 2-3 个回合就把
            // 12 轮阈值顶满，导致上下文频繁轮换/预热永远跟不上（聊天记录乱、AI 忘事重复回）。
            if (key && currentMode === 'default') {
              try {
                const stTool = getSocialState(key);
                stTool.sessionToolCalls = (Number(stTool.sessionToolCalls) || 0) + 1;
                if (stTool.sessionToolCalls % 25 === 0) saveSocialState(); // 节流持久化
              } catch (_) {}
            }
          }
          if (frame.event.type === 'tool/call') {
            const toolName = String(frame.event.data?.name ?? '');
            const callId = frame.event.data?.callId;
            const rawArgs = frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data;
            const args = sanitizeToolArgs(rawArgs);
            appendToolLog({ type: 'call', time: new Date().toISOString(), key, sessionId: frame.sessionId, tool: toolName, args });
            /* 【2026-09-20 根治「模型漏引号 → 消息发不出去」】
             * 现场：`{"key":"…","messages": 主人这么直接啊 我脸都热了,"token":"…"}` 不是合法 JSON，
             * DSH 的宽松解析把这个字段整个丢掉 → 发送端点只看到 messages 为空 → 模型看到报错、原样重试。
             * 参数解析在 DSH 里，桥改不了它，但**桥在事件流里拿得到原始参数串** —— 所以这里先把可疑的
             * 原始串按 callId 存下来；等这次调用真的因为"messages 为空"失败时（tool/result 分支），
             * 再把裸文本捞回来由桥自己发出去（走同一条发送端点，额度/幂等/脱敏都不绕过），
             * 并把这一批记进幂等账本 —— 模型随后的"重发"会被判成"已经发过了"。
             * 用户看到的是消息照常到达，而不是一条红色报错。 */
            if (callId != null && typeof rawArgs === 'string' && isSendToolName(toolName) && looksLikeUnquotedArgs(rawArgs)) {
              unquotedArgsByCall.set(String(callId), { raw: rawArgs, key, tool: toolName, at: Date.now() });
              if (unquotedArgsByCall.size > 50) {
                const oldest = [...unquotedArgsByCall.entries()].sort((a, b) => a[1].at - b[1].at)[0];
                if (oldest) unquotedArgsByCall.delete(oldest[0]);
              }
            }
            if (callId != null) {
              if (isSendToolName(toolName)) {
                let pending = pendingSendToolCalls.get(frame.sessionId);
                if (!pending) {
                  pending = new Set();
                  pendingSendToolCalls.set(frame.sessionId, pending);
                }
                pending.add(callId);
              }
              let nameMap = toolCallNames.get(frame.sessionId);
              if (!nameMap) {
                nameMap = new Map();
                toolCallNames.set(frame.sessionId, nameMap);
              }
              nameMap.set(String(callId), toolName);
            }
            touchTurnTotalTimer(frame.sessionId); // 工具开始执行：续期回合总时长，防长工具/长等待误判卡死
          }
          if (frame.event.type === 'tool/result') {
            const callId = frame.event.data?.message?.source?.callId;
            const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
            const resultBlock = frame.event.data?.message?.content?.[0];
            const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
            const errorText = resultError ? String(resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error ?? '') : '';
            appendToolLog({
              type: 'result',
              time: new Date().toISOString(),
              key,
              sessionId: frame.sessionId,
              tool: toolName,
              ok: !resultError,
              error: errorText ? sanitizeToolArgs(errorText) : null
            });
            if (callId != null) {
              toolCallNames.get(frame.sessionId)?.delete(String(callId));
              /* 【2026-09-20 根治】这次调用是不是"漏引号导致 messages 被丢掉"？
               * 是 → 桥把那段裸文本捞回来自己发（见 tool/call 分支的说明）。 */
              const stashed = unquotedArgsByCall.get(String(callId));
              if (stashed) {
                unquotedArgsByCall.delete(String(callId));
                if (resultError && /至少一个不能为空/.test(errorText)) {
                  void recoverUnquotedSend({ key, sid: frame.sessionId, callId: String(callId), stash: stashed, cfg: cfgRef })
                    .catch((error) => log(`[args-repair] 兜底发送异常：${error?.message ?? error}`));
                }
              }
              const pending = pendingSendToolCalls.get(frame.sessionId);
              if (pending?.has(callId)) {
                pending.delete(callId);
                if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
                if (!resultError) {
                  sendToolSucceededSessions.add(frame.sessionId);
                }
              }
            }
            touchTurnTotalTimer(frame.sessionId); // 工具结果到达：回合仍活跃
          }
          // 【2026-09-15 合并注入】模型**步边界**（dsh-agent-loop/lib/index.js:558 每个模型步末尾 append）：
          //   ① 复位"本周期已注入"闸门 —— 注入闸门从此以**真实步边界**为准，而不是一个拍脑袋的计时窗口
          //      （旧实现只在 turn-stopping 钩子里复位，而那个钩子在"模型正在调工具"的步里有条件不执行）；
          //   ② 把这一步里攒下的消息**合成一个** [Mid-turn] 块注入（turn-hold.js:flushStepBatch）。
          // 为什么必须在这里发车：保持循环只活在 agent/turn-stopping 钩子里，而那个钩子只在
          // `turnEnds && nextStep.length === 0` 时才被 await（dsh-agent-loop:564）—— 模型连调几个工具的
          // 那种步走不到钩子，只靠保持循环就会把消息拖到整个回复跑完。`step/end` 每一步都有，且正好在
          // **下一个 step 的 claim 之前**，所以在这里注入与"消息一到就投"送达时刻完全一致。
          // 必须 void + catch：这里不能阻塞事件流处理，更不能静默失败（本功能吃过四次静默失败的亏）。
          if (frame.event.type === 'step/end') {
            markSteerCycleStart(key, 'step/end');
            void flushStepBatch({ key, sid: frame.sessionId, turn: frame.event.data?.turn, cfg: cfgRef })
              .catch((error) => log(`[hold] ${key} 步边界合并注入异常：${error?.message ?? error}`));
          }
          // 回合结束：攒批记账收尾（消息留在 unread 里，由补发/看门狗接管，绝不在这里吞掉）。
          if (frame.event.type === 'turn/end') {
            clearSteerPending(key, 'turn/end');
          }
          // 任何会话事件都视为“回合还活着”：重置活动感知看门狗（turn/end 会随后清理计时器）
          armTurnWatchdog(frame.sessionId);
          const collector = collectors.get(frame.sessionId) ?? createTurnCollector();
          collectors.set(frame.sessionId, collector);
          const ended = collector.push(frame.event);
          if (ended) {
            // default 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
            // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
            const silentQueueNow = silentTurnQueue.get(frame.sessionId) ?? [];
            const isSilentTurn = silentQueueNow.length > 0;
            if (currentMode === 'default' && key && !isSilentTurn) {
              const st = getSocialState(key);
              const turnStart = TurnStartAt.get(frame.sessionId) ?? 0;
              const actionTaken = sendToolSucceededSessions.has(frame.sessionId) || (turnStart > 0 && st.lastActionAt >= turnStart);
              if (actionTaken) {
                st.wakeConfig.noActionCount = 0;
              } else {
                st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                const limit = Number(cfgRef.social?.wake?.noActionLimit) || 3;
                if (st.wakeConfig.noActionCount >= limit) {
                  log(`[default] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，软重置唤醒配置（保留模式）`);
                  softResetWakeConfig(st);
                  st.bootstrapSent = true;
                  st.wakeConfig.noActionCount = 0;
                }
              }
              saveSocialState();
            }
            TurnStartAt.delete(frame.sessionId);
            clearTurnTotalTimer(frame.sessionId);
            if (turnTimeoutTimers.has(frame.sessionId)) { clearTimeout(turnTimeoutTimers.get(frame.sessionId)); turnTimeoutTimers.delete(frame.sessionId); }
            collectors.delete(frame.sessionId);
            if (key) {
              // 循环复读监测：回合结束时汇总本回合 AI 文本与实际发送内容做判定（2026-09-03）
              try { finishTurnLoopGuard(key, frame.sessionId, ended); } catch (eLoop) { log(`[loopGuard] ${key} 判定异常:`, eLoop?.message ?? eLoop); }
            }
            const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
            sendToolSucceededSessions.delete(frame.sessionId);
            if (sendToolSucceeded && key) {
              // 本轮展示给 AI 的未读消息视为已处理：AI 成功回复后清掉，避免补发/重复回复同一批旧消息
              try {
                const stSent = getSocialState(key);
                // 【2026-09-11 turn-hold 地基①】本回合"负责"的消息 = 唤醒时展示的 + 回合中途 steer 进来的。
                // 少算后半截会出现这个致命循环：steer 进来的消息 seq 不在 turnSeenUnread 里 →
                // ①永远进不了 answeredMessageIds（下一轮又被当成新消息 → 重复回复）
                // ②永远不会从 unread 里清掉（永久未读 → 下一轮又展示一遍 → 再重复回复一遍）。
                // 注意：这里只影响"回合结束时怎么算账"，**不影响 mark_read 的判定**——
                // mark_read 仍按 turnSeenUnread 快照（seq > snapMax 一律保留），
                // 所以 steer 进来的消息在回合结束前一直留在 unread 里，回合中途被 abort 也不会丢。
                const seenSeqs = new Set(Array.isArray(stSent.turnSeenUnread) ? stSent.turnSeenUnread : []);
                for (const s of (Array.isArray(stSent.turnSteeredSeqs) ? stSent.turnSteeredSeqs : [])) {
                  const n = Number(s);
                  if (Number.isFinite(n) && n > 0) seenSeqs.add(n);
                }
                let dirty = false;
                if (seenSeqs.size > 0) {
                  // ① 记下"这一轮确实被回复过"的消息 id（按 QQ messageId，跨会话轮换稳定）。
                  //    回合结束时判断被暂存的唤醒是否被吞就查这个集合，不再比时间戳——
                  //    时间戳判不出"看过但没回"（吞消息），也分不清"回过但又被重播"（重复回复，今天两次翻车都在这）。
                  //    ⚠️ 必须从 `recentMessages` 里找，**不能遍历 `stSent.unread`**：AI 在回合内调 mark_read 时
                  //    就已经把"本轮展示过的"未读从 unread 里摘掉了（console-server.js 的 mark_read 快照逻辑），
                  //    等到回合结束再读 unread 是空的 → 集合永远攒不起来（第一版就是这么写的，实测 0 条）。
                  try {
                    const answered = new Set(Array.isArray(stSent.answeredMessageIds) ? stSent.answeredMessageIds : []);
                    const sizeBefore = answered.size;
                    for (const m of (Array.isArray(stSent.recentMessages) ? stSent.recentMessages : [])) {
                      if (m && m.messageId && seenSeqs.has(Number(m.seq))) answered.add(String(m.messageId));
                    }
                    if (answered.size !== sizeBefore) {
                      stSent.answeredMessageIds = [...answered].slice(-300);
                      dirty = true;
                    }
                  } catch (_) {}
                }
                if (Array.isArray(stSent.unread)) {
                  // ② 清掉已展示的未读（保持原行为）
                  const before = stSent.unread.length;
                  stSent.unread = stSent.unread.filter((m) => m && !seenSeqs.has(Number(m.seq)));
                  if (stSent.unread.length !== before) dirty = true;
                }
                // 【2026-09-11 撤回 lazy-park（主人抓到"一条消息注入两次"）】
                // 这里曾经加过一段"lazy-park"：把本回合 steer 进来、但到回合结束**仍不在
                // answeredMessageIds 里**的消息重新塞回 pendingWakeReasons，走一次补发兜底。
                // 实测它是**有害的**：
                //   14:28:39 steer「贴贴」→ 14:28:48 steer「小笨蛋」→ 14:28:55 它把 seq61
                //   判定成"没被处理"重新入队 → 补发轮又唤醒一次 → **同一条消息被注入两遍**。
                // 为什么它本来就是多余的：
                //   · 若消息**成功 steer 过**，模型就确实看到了它；此后它不说话是**有意识的决定**
                //     （主人已选 B：短消息允许不回）—— 不该因此再喂一遍。
                //   · 若模型**真没看到**（回合被 abort / 注入失败），那条消息根本没被 mark_read，
                //     仍然留在 `unread` 里，下一次唤醒正文的 `[Unread n]` 自然会带上它。
                //     所以不需要也不该在这里补存。
                // 保留的只有 scheduleWake 那条真正的兜底：**steer 失败**时才暂存（那时消息确实没送达）。
                stSent.turnSeenUnread = [];
                stSent.turnSteeredSeqs = [];
                // 被"注入周期闸"推迟过的那批（wake-send.js 写、mark_read 用来防吞）也随回合结束清掉：
                // 回合都结束了，它们该走正常唤醒流程，而不是继续享有"谁都别动我"的豁免。
                stSent._steerDeferredSeqs = [];
                if (dirty) saveSocialState();
              } catch (_) {}
            }
            pendingSendToolCalls.delete(frame.sessionId);
            toolCallNames.delete(frame.sessionId);
            // （一代 farewell/退场机制已随单模式化删除：default 下不存在"退场发言"概念）
            // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
            // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
            const silentQueue = silentTurnQueue.get(frame.sessionId) ?? [];
            const silentNow = Date.now();
            while (silentQueue.length && silentNow - silentQueue[0].ts > SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
            if (silentQueue.length > 0) {
              silentQueue.shift();
              if (silentQueue.length > 0) silentTurnQueue.set(frame.sessionId, silentQueue);
              else silentTurnQueue.delete(frame.sessionId);
              log(`摘要投喂 turn 结束，静默 (${key})`);
              continue;
            }
            // default 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
            // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
            if (pendingWakeKeys.has(key)) {
              pendingWakeKeys.delete(key);
              disarmPendingWakeLease(key);
              if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                ensureWakeable(getSocialState(key), { key });
                wakeConfigUpdatedKeys.delete(key);
                markReadCalledKeys.delete(key);
                wakeConfigMissCount.delete(key);
              } else {
                // 活跃模式（anyMessage）每次消息都会唤醒，无需“防遗忘”提醒/兜底重置，
                // 否则 AI 收尾没调 set_wake_config 就会被连坐重置成默认潜水（用户刚设的活跃模式又没了）。
                const missSt = getSocialState(key);
                const missWc = missSt.wakeConfig || {};
                const missTr = missWc.triggers || {};
                if (missWc.mode === 'active' || missTr.anyMessage === true) {
                  wakeConfigMissCount.delete(key);
                  ensureWakeable(missSt, { key });
                } else {
                  const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(cfgRef.social?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    wakeConfigMissCount.set(key, currentMiss);
                    pendingWakeKeys.add(key);
                    armPendingWakeLease(key);
                    deliverPrompt(key, buildWakeReminderPrompt(key)).then((result) => {
                      if (result && result.ok === false) {
                        pendingWakeKeys.delete(key);
                        disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      pendingWakeKeys.delete(key);
                      disarmPendingWakeLease(key);
                      log(`[default] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
                    });
                    log(`[default] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
                  } else {
                    softResetWakeConfig(getSocialState(key));
                    saveSocialState();
                    log(`[default] ${key} 连续未设置唤醒条件，已软重置唤醒配置（保留模式）`);
                  }
                }
              }
            }
            // 繁忙期间被暂存的唤醒原因：当前 turn 结束后合并补发一次，避免关键 @/提问被漏掉。
            // 之前逐个 shift 补发：群聊活跃时会形成“补发→AI 又忙→再积压→再补发”的连环唤醒，
            // 导致会话长时间 busy。现在合并为一次最高优先级的唤醒，AI 醒来后自行看未读即可覆盖全部触发。
            {
              const stEnd = getSocialState(key);
              if (Array.isArray(stEnd.pendingWakeReasons) && stEnd.pendingWakeReasons.length) {
                const pending = stEnd.pendingWakeReasons;
                stEnd.pendingWakeReasons = [];
                saveSocialState();
                let best = null;
                for (const r of pending) {
                  if (!r || typeof r !== 'object' || !r.reason || !Number.isFinite(Number(r.seq))) continue;
                  // 触发它的消息已被 AI 在当前回合处理（unread 中已不存在该 seq）则不再补发。
                  // 但根治“消息撞上在途回合被吞”：用户触发的唤醒（私聊/@/提问/拍一拍/关键词等）若其消息
                  // 比最近一次成功回复还新（即被当前回合标读但并未真正回复），仍要补发一次，避免静默吞消息。
                  const stillRelevant = Array.isArray(stEnd.unread) && stEnd.unread.some((m) => m && Number(m.seq) >= Number(r.seq));
                  let swallowed = false;
                  if (!stillRelevant && /^(private|atMention|question|speaker|nameMention|poke|keyword)/.test(String(r.reason))) {
                    const parkedMsg = [...(Array.isArray(stEnd.recentMessages) ? stEnd.recentMessages : [])].reverse().find((m) => m && Number(m.seq) === Number(r.seq));
                    const mid = parkedMsg?.messageId ? String(parkedMsg.messageId) : '';
                    // 判定口径：**按 messageId 查「确实被回复过」集合**。
                    //   - 集合里没有它 → 从没被任何一次"成功发送"的回合覆盖过 → 判被吞 → 补发一次（解决吞消息）；
                    //   - 集合里有它   → 已经回过 → 跳过补发，绝不再把已回内容摆给模型（解决重复回复）。
                    // 这比原来的 `max(lastReplyAt, lastSeenAt)` 时间戳比较准：时间戳既判不出"看过但没回"（吞），
                    // 也分不清"回过但又被重播"（重复）。按 id 查集合两件事同时成立。
                    const answeredSet = new Set(Array.isArray(stEnd.answeredMessageIds) ? stEnd.answeredMessageIds.map(String) : []);
                    const wasAnswered = !!mid && answeredSet.has(mid);
                    if (!wasAnswered) {
                      // 【2026-09-11 修「补发轮也吞」】光标记 swallowed 不够：这条消息**已经被标读**、
                      // 早从 `unread` 里摘掉了，于是补发轮的唤醒正文是 `[Unread 0]` —— 模型根本看不到
                      // 要回什么，只能写一句"没什么可回的 / OK"又不调发送工具（实测 22:03:52、22:04:32 连续两次）。
                      // 所以补发前把它**塞回 unread**，让唤醒正文带上原文，模型才有东西可回。
                      // 有次数上限（3 次）：避免模型铁了心不回时无限补发烧 token。
                      stEnd._swallowRetry = (stEnd._swallowRetry && typeof stEnd._swallowRetry === 'object') ? stEnd._swallowRetry : {};
                      const retryKey = String(r.seq);
                      const retryTimes = Number(stEnd._swallowRetry[retryKey]) || 0;
                      if (retryTimes >= 3) {
                        log(`[default] ${key} seq${r.seq} 已补发 ${retryTimes} 次仍未得到回复，停止补发（避免无限重试烧 token）`);
                      } else {
                        stEnd._swallowRetry[retryKey] = retryTimes + 1;
                        swallowed = true;
                        if (parkedMsg && Array.isArray(stEnd.unread)) {
                          const seqNum = Number(r.seq);
                          if (!stEnd.unread.some((m) => m && Number(m.seq) === seqNum)) {
                            stEnd.unread.push({ ...parkedMsg });
                            stEnd.lastUnreadSeq = Math.max(Number(stEnd.lastUnreadSeq) || 0, seqNum);
                            log(`[default] ${key} 已把 seq${seqNum} 放回 unread（第 ${retryTimes + 1}/3 次补发），让唤醒正文带上原文`);
                          }
                        }
                      }
                      log(`[default] ${key} 消息 ${r.reason}@seq${r.seq}${mid ? `(id:${mid})` : ''}（${parkedMsg ? fmtBeijing(Number(parkedMsg.time) || 0) : '?'}）不在已回复集合里却被标读，判定被吞，补发唤醒`);
                    } else if (mid) {
                      log(`[default] ${key} 消息 ${r.reason}@seq${r.seq}(id:${mid}) 已在已回复集合里，跳过补发（防重复回复）`);
                    }
                  }
                  if (!stillRelevant && !swallowed) {
                    log(`[default] ${key} 繁忙期间唤醒 ${r.reason}@seq${r.seq} 已被当前回合处理，跳过补发`);
                    continue;
                  }
                  const rp = wakePriority(r.reason);
                  const bp = best ? wakePriority(best.reason) : -1;
                  if (!best || rp > bp || (rp === bp && Number(r.seq) > Number(best.seq))) best = r;
                }
                if (best) {
                  // 补发冷却：同一 (key, reason, seq) 60s 内只补发一次，防止 AI 看过选择潜水后又连环补发同一批消息
                  // （随上面那条一起回滚：per-seq 一次性去重会让补发机会变少，但真正的问题是"补发本身会重播已回内容"，
                  //   不是补发频率；频率闸门的改动解决不了重复回复，所以一并回到原样。）
                  const rbKey = `${key}:${best.reason}:${best.seq}`;
                  const rbLast = lastWakeRebroadcast.get(rbKey) || 0;
                  if (Date.now() - rbLast < 60000) {
                    log(`[default] ${key} 补发冷却：${best.reason}@seq${best.seq} 60s 内已补发过，跳过`);
                  } else {
                    lastWakeRebroadcast.set(rbKey, Date.now());
                    if (lastWakeRebroadcast.size > 200) {
                      for (const k of lastWakeRebroadcast.keys()) {
                        if (Date.now() - lastWakeRebroadcast.get(k) > 600000) lastWakeRebroadcast.delete(k);
                      }
                    }
                    log(`[default] ${key} 合并补发繁忙期间积压唤醒（${pending.length} 条 → 1 条）：${best.reason}@seq${best.seq}`);
                    // 标记“这是 busy 补发轮”：唤醒 prompt 注入勿复读提示，避免把刚才已回过的旧消息又整轮回一遍
                    stEnd._rebroadcastWake = Date.now();
                    saveSocialState();
                    scheduleWake(key, best.reason);
                  }
                }
              }
            }
            if (ended.reason.kind === 'completed' && ended.text.trim()) {
              const plain = mdToPlain(ended.text);
              // 纯 Markdown/空白输出按“无文本”处理
              if (!plain.trim()) {
                log(`agent 回复为空（仅格式/空白）(${key})`);
                continue;
              }
              // AI 主动选择“潜水/不接话”标记：不发送到 QQ
              if (isSilentMarker(plain)) {
                log(`AI 选择静默（${SILENT_MARKER}）(${key})`);
                continue;
              }
              // —— 发送主通道：回复只走发送工具（persona 硬纪律）——
              // 引擎顺序保证：模型若在本回合调用了发送工具并成功（tool/result 先于 turn/end 到达），
              // sendToolSucceeded=true → 正文按思考忽略，绝不重复发 → 同回合不会双发。
              // 模型没调任何发送工具（sendToolSucceeded=false）但正文非空时：**不再兜底自动转发**——
              // 2026-09-06 起彻底移除兜底：正文只是思考草稿，绝不代表"要发给对方的话"。
              // 若该正文确是想回复的话，模型应在上文用发送工具发出；这里只暂存提示，让模型下一轮
              // 自己用工具补发（根治"模型不调工具只写正文→桥接乱发思考文本"的循环）。
              if (sendToolSucceeded) {
                log(`工具已发送消息，正文按思考忽略 (${key})`);
                continue;
              }
              if (globalThis._rateLimitMuted && globalThis._rateLimitMuted[key]) {
                delete globalThis._rateLimitMuted[key];
                log(`[rateLimit] ${key} 限流已恢复，取消静默`);
              }
              const undelivered = plain.slice(0, 500);
              /* 【2026-09-20】裸 `OK` 是**控制令牌**，不是草稿：系统提示词里明确允许"这一轮不需要说话"时
               * 只输出一个 `OK`（[Preheat] 轮、或已经用工具把话都发完之后收尾）。以前这里不认它，
               * 于是每一轮裸 OK 都会被记成"写了正文没调发送工具"的未交付草稿，下一轮还往正文里塞一句
               * `[Undelivered draft] Last round ended with drafted text ("OK…")` —— 又蠢又费 token。 */
              if (/^ok[.。!！]?$/i.test(String(plain).trim())) {
                log(`[default] 模型以裸 OK 收尾（本轮无发送工具调用）—— 按"本轮不说话"处理，不记草稿 (${key})`);
                continue;
              }
              log(`[default] 模型正文未通过发送工具发出（不再自动转发）(${key}): ${undelivered.slice(0, 60)}`);
              appendActivity(`${key} [undelivered] 模型正文未走发送工具（未转发）：${undelivered.slice(0, 80)}`);
              // 只暂存"用户真实触发"回合的正文：模型可能本想回话却漏调工具 → 下轮给补发提示。
              // 内部唤醒（回复检查/主动冒泡/概率/睡醒）里模型的正文多为自言自语（如"空唤醒，无新内容"），
              // 暂存只会污染下轮补发提示，直接丢弃即可（正文本来就不该外发）。
              try {
                const lw = String(getSocialState(key)?.lastWakeReason ?? '').split(':')[0];
                const userTriggered = /^(private|atMention|question|speaker|nameMention|poke|keyword|bootstrap)$/.test(lw);
                if (userTriggered) {
                  const stUd = getSocialState(key);
                  if (!stUd.pendingUndeliveredText || Date.now() - (Number(stUd._undeliveredAt) || 0) > 180000) {
                    stUd.pendingUndeliveredText = undelivered;
                    stUd._undeliveredAt = Date.now();
                    saveSocialState();
                  }
                }
              } catch (eUd) { log(`[default] 暂存未发出正文失败 (${key}): ${eUd?.message ?? eUd}`); }
            } else if (ended.reason.kind === 'error') {
              const msg = ended.reason.error?.message ?? '未知错误';
              // === 429/限流拦截：不发原始报错到 QQ，发一句中性的提示并结束桥进程 ===
              const isRateLimit = /429|rate.?limit|FreeUsageLimit|quota.?exceed|Too.?Many.?Requests|过载|流控/i.test(msg);
              if (isRateLimit) {
                // 限流去重：每个 key 只发一次提示，恢复前不再重复
                if (!globalThis._rateLimitMuted) globalThis._rateLimitMuted = {};
                if (!globalThis._rateLimitMuted[key]) {
                  globalThis._rateLimitMuted[key] = true;
                  log(`[rateLimit] 模型限流 (${key}): ${msg.slice(0, 200)}`);
                  appendActivity(`[rateLimit] ${key} 模型限流，静默等待恢复`);
                  // 【2026-09-15 去人设化】原来发的是"🐟 小鲸鱼饿了，需要主人喂饭～"——
                  // 那是开发初版鲸鱼人设的口吻，且不说清发生了什么。现在只讲事实给主人看。
                  void sendToQQ(key, '⚠️ 模型通道被限流（429），我这边先停一下；额度恢复后重启桥就能继续。').catch(() => {}); // 泵内不阻塞: 发送走链异步完成
                } else {
                  log(`[rateLimit] ${key} 限流中，静默跳过`);
                }
              } else {
                const safeMsg = shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                log(`[error] agent 处理出错 (${key}): ${msg.slice(0, 500)}`);
                appendActivity(`${key} [error] agent 处理出错: ${msg.slice(0, 120)}`);
                // 报错文本一律只进日志/活动记录，不再广播到 QQ 聊天：
                // - content_filter（模型侧安全过滤，如命中内容审查）发到群里既暴露内部机制又吓人；
                // - 其他 agent 报错（网络抖动/上游异常等）同理，原始错误文本对群友没有意义。
                // 完整错误始终可在 state/bridge.log 与活动记录里查看。
                const isContentFiltered = /content_filter|finish_reason.{0,24}content|内容过滤|安全策略拦截|拒绝生成/i.test(msg);
                if (!isContentFiltered) {
                  // 非内容过滤类错误：给一句简短自然的话，避免群友以为机器人死机，但不透出原始报错。
                  // 防连环刷屏：同一会话 5 分钟内已提示过就不再重复补发（如 QQ 风控期每条都失败，
                  // 反复"重说一遍"只会再触发更多失败发送）。
                  if (!globalThis._agentErrMuted) globalThis._agentErrMuted = {};
                  const lastHint = globalThis._agentErrMuted[key] || 0;
                  if (Date.now() - lastHint > 5 * 60 * 1000) {
                    globalThis._agentErrMuted[key] = Date.now();
                    void sendToQQ(key, '刚走神了一下，你重说一遍？').catch(() => {}); // 泵内不阻塞
                  } else {
                    log(`[agent-err] ${key} 距上次失败提示不足 5 分钟，静默跳过（QQ 侧持续失败?）`);
                  }
                }
              }
            } else if (ended.reason.kind === 'aborted') {
              // 回合被取消/终止：只在日志记录，不再向聊天框广播「已停止」等确认话
              log(`[aborted] ${key} 回合被终止（不向聊天框广播）`);
            } else if (!ended.text.trim()) {
              // completed 但没文本（纯工具调用回合 / 看过选择潜水不回复）
              log(`回合完成但无文本 (${key})`);
              // 根治消息挤压：无正文收尾 = 模型已看过本轮消息并决定不回复。立即把已读水位推进到
              // 本轮展示过的最新 seq（DB + 内存同步），否则同一批消息在下一次内部唤醒/重启后会原样
              // 回来 → 几十条旧未读反复重放、模型每次都"看一遍不回复"的死循环。
              try {
                const stNm = getSocialState(key);
                if (stNm && !stNm._silentAdvanceGuard) {
                  stNm._silentAdvanceGuard = true;
                  const snapSeq = (Array.isArray(stNm.turnSeenUnread) ? stNm.turnSeenUnread : []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
                  const maxSeen = snapSeq.length ? Math.max(...snapSeq) : 0;
                  const hasAny = (Array.isArray(stNm.unread) && stNm.unread.length > 0) || maxSeen > 0;
                  if (hasAny) {
                    if (maxSeen > 0 && Array.isArray(stNm.unread)) {
                      stNm.unread = stNm.unread.filter((m) => m && Number(m.seq) > maxSeen);
                    } else {
                      stNm.unread = [];
                    }
                    stNm.lastAiSeenAt = Date.now();
                    try { markMessagesRead(key, maxSeen); } catch (eM) { log(`[memory] 无正文收尾推进已读失败 ${key}: ${eM?.message ?? eM}`); }
                    saveSocialState();
                    log(`[default] ${key} 无正文收尾：已自动推进已读水位(maxSeen=${maxSeen})，旧消息不再重放`);
                  }
                  stNm._silentAdvanceGuard = false;
                }
              } catch (eNm) { log(`[default] 无正文水位推进异常 ${key}: ${eNm?.message ?? eNm}`); }
            }
          }
        } else if (frame.type === 'host/session-status') {
          // 【turn-hold 补完】DSH 的**权威**运行状态帧（dsh-host-apiproxy/lib/index.js:3699：
          // ctx.on('agent/status') → frame({ type:'host/session-status', sessionId, running })）。
          // 桥以前只能靠 turn/start、turn/end 推断"回合在不在跑"，这正是当初 steer 吞消息的根因；
          // 这个帧直接给 running:true/false，是"能不能即时 steer"的唯一可信依据。
          const sidStatus = String(frame.sessionId || '');
          if (sidStatus) {
            if (frame.running === true) {
              if (!agentRunningSessions.has(sidStatus)) {
                agentRunningSessions.add(sidStatus);
                log(`[status] session=${sidStatus.slice(0, 20)}… DSH 权威状态 = 运行中`);
              }
            } else if (agentRunningSessions.delete(sidStatus)) {
              log(`[status] session=${sidStatus.slice(0, 20)}… DSH 权威状态 = 已空闲`);
            }
          }
        } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && learnerSessions.has(frame.sessionId)) {
          // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
          try {
            if (frame.type === 'question/requested') {
              await apiRef.respond({
                type: 'client-response',
                rpcId: envelope.rpcId,
                result: { ok: true, value: { sessionId: frame.sessionId, answer: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } } }
              });
            } else {
              await apiRef.respond({
                type: 'client-response',
                rpcId: envelope.rpcId,
                result: { ok: true, value: { sessionId: frame.sessionId, approvalId: frame.approvalId, outcome: 'rejected' } }
              });
            }
            log('黑话学习会话自动跳过提问/审批');
          } catch (error) {
            log('自动响应学习会话提问/审批失败:', error?.message ?? error);
          }
        } else if (frame.type === 'question/requested') {
          const key = reverse.get(frame.sessionId);
          if (!key) continue;
          const lines = frame.questions.map((q, i) => {
            const qText = String(q.question ?? '');
            const sensitive = shouldAuditKey(key) && SENSITIVE_RE.test(qText);
            if (sensitive) log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
            const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
            let s = `${i + 1}. ${safeQuestion}`;
            if (q.options?.length) {
              const opts = q.options.map((o) => {
                const label = String(o.label ?? '');
                const optSensitive = shouldAuditKey(key) && SENSITIVE_RE.test(label);
                if (optSensitive) log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
                return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
              });
              s += '\n   ' + opts.join(' ');
            }
            return s;
          });
          void sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）').catch(() => {}); // 泵内不阻塞
          await registerPending(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, questions: frame.questions });
        } else if (frame.type === 'approval/requested') {
          const key = reverse.get(frame.sessionId);
          if (!key) continue;
          const rawReason = frame.reason ?? '';
          const sensitiveReason = shouldAuditKey(key) && SENSITIVE_RE.test(rawReason);
          if (sensitiveReason) log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
          const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
          const reason = safeReason ? `\n理由：${safeReason}` : '';
          const rawToolName = frame.toolName ?? '';
          const sensitiveTool = shouldAuditKey(key) && SENSITIVE_RE.test(rawToolName);
          if (sensitiveTool) log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
          const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
          void sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`).catch(() => {}); // 泵内不阻塞
          await registerPending(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, approvalId: frame.approvalId, toolName: frame.toolName });
        } else if (frame.type === 'stream/error') {
          log('事件流错误:', frame.error);
        }
      }
    } catch (error) {
      log('事件流中断:', error?.message ?? error);
      collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
      silentTurnQueue.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
      sendToolSucceededSessions.clear();
      pendingSendToolCalls.clear();
      TurnStartAt.clear();
      toolCallNames.clear();
      pendingWakeKeys.clear();
      clearAllPendingWakeLeases();
      wakeConfigUpdatedKeys.clear();
      markReadCalledKeys.clear();
      wakeConfigMissCount.clear();
    }
    await sleep(3000);
  }
}
