// M5 本地控制台：
// 独立 Web 面板；cfg/api/bot/media 运行期注入；writeLastMode 写回 main 的 lastMode。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { qqTextSeg } from '../lib/onebot-ws.js';
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
  slangKey,
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
import { KNOWN_AGENT_TOKENS, redactSensitiveText, SENSITIVE_ARG_KEYS, redactSensitive, sanitizeToolArgs, escapeCqText, unquoteJsonString, splitSerializedBubbles, looksLikeSerializedBubbleArray } from '../lib/text-safe.js';
import { normalizeOwnerQQ, normalizeIdList, allowed } from '../lib/config.js';
import { readRoleState, writeRoleState, sanitizeRoleName, listRoles } from '../lib/role-access.js';
import { sleep, withTimeout } from '../lib/async.js';
import { convKey, canonicalKey } from '../lib/keys.js';
import { EXPLICIT_END_RE, hasExplicitEnd, isSleepingConfig, normalizeSpeakerIds } from '../lib/sleep-guard.js';
import { isEmojiLikeCp, stripImeEmoji } from '../lib/emoji.js';
import { singleLineForQQ, splitLongSegment } from '../lib/segment.js';
import { mimeFromBuffer, mimeFromUrl, base64FromMaybe } from '../lib/media-meta.js';
import { log, appendActivity, readActivityTail } from '../lib/log.js';
import { SILENT_MARKER, isSilentMarker, SEND_TOOL_RE, isSendToolName, SPACE_SPLIT_HINT, DIRECTION_HINT } from '../lib/markers.js';
import { state, loadConfig, loadState, saveState, configFilePath } from './config.js';
// 表情包抽签的登记口（内置表情库直发 + 收藏表情两条路都记一笔，供 [Meme] 冷却使用）
import { noteMemeSent } from './send-dice.js';
import { acquireLock, releaseLock } from './runtime.js';
import { enqueueSend, currentSendChain, cancelKeyedSends, cancelAllKeyedSends } from './send-chain.js';
import { sendToQQ, sendBurstToQQ, sendMessages, initQqSendCore, setQqSendBot } from './qq-send.js';
// 音乐分享的"卡片 → 原生卡片 → 链接"降级梯子（纯编排逻辑，media 域导出，可离线单测）
import { sendMusicCardWithFallback } from './media.js';
// 【2026-09-17】视频平台（bilibili / 抖音…）：链接识别 + 多路降级取信息 + 拼卡片 + 关键词搜视频。
// 这个模块是纯函数、不依赖 cfg，所以直接 import，不走 setConsoleMedia 那套注入
// （注入点被 bridge.js / dsh-watch.js / mux.js 三处调用，动签名容易漏改）。
import { resolveVideo, buildVideoCard, videoSearch, parseVideoUrl, extractVideoUrls, fetchMiniAppArk } from './video.js';
import { redactKnownTokensOnly, sweepMessageArtifacts, stripMessageArtifacts, cleanOutboundText } from '../lib/outbound-text.js';
import { planSocialTimeline, isDirectedAtAi, withTimeText, findCjkSpaceWarning, findSplitBoundaryWarning } from '../lib/social-timeline.js';
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
import { postRandomQzone, initQzoneCore } from './qzone.js';
import {
  cancelPendingEntry, handlePendingAnswer, handlePokeNotice, handleInputStatusNotice,
  registerPending, initEventsAuxCore, setEventsAuxApi,
} from './events-aux.js';
import {
  memDb, initMemoryDb, getProfile, setProfileField, formatProfileText,
  profileDisplayName, formatContactsLine, resolveNameToUid,
  persistChatMessage, searchChatMessages, deleteChatMessages, clearChatHistory,
  recentChatMessages, fetchUnreadChatMessages, markMessagesRead, markChatRecalled,
  formatMemory, appendMemory, initMemoryCore,
  // 【2026-09-21 记忆架构升级】分层记忆的写入/检索/置顶/统计（/api/social/memory-remember 等）
  rememberEntry, listMemoryEntries, setMemoryPinned, memoryDigest, memoryStats, pruneExpiredMemory,
} from './memory.js';
import {
  evaluateWakeTrigger, buildWakePrompt, sendWakePrompt,
  initWakeCore, setWakeApi, setWakeDeliver, rotateThresholdOf,
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
  touchTurnTotalTimer, touchTurnGuardsByKey,
  setTurnGuardApi, TURN_TIMEOUT_MS, TURN_TOTAL_TIMEOUT_MS,
} from './turn-guard.js';
import {
  collectors, TurnStartAt, pendingWakeKeys, sessionPromises, promptQueues,
  sendToolSucceededSessions, turnTimeoutTimers, turnTotalTimers, loopRepeatState,
  loopRecoverTimes, activeAiTurns, pendingTurnOutbound, toolCallNames, pendingSendToolCalls,
  activeWaits, pendingWakeLeaseTimers, lastWakeRebroadcast, wakeConfigUpdatedKeys,
  markReadCalledKeys, wakeConfigMissCount, reverse,
  queued, queuedHintAt, queueRetries, pending, visionModelAppliedSessions,
  messageMediaStore, activityWakeCooldown, MAX_MEDIA_COUNT, silentTurnQueue,
} from './session-state.js';
import { handleTurnHold } from './turn-hold.js';
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
  lastSendDedup, sendCallTimes, slangLearnerSessionId,
  setSlangEntries, setSlangLearnerSessionId, initSlangCore, setSlangApi,
} from './slang.js';
import {
  enqueueForRetry, flushQueue, deliverPrompt, drainPromptQueue, drainAllPromptQueues,
  QUEUE_MAX, initPromptDeliverCore, setPromptApi, setPromptMediaResolver,
} from './prompt-deliver.js';
import {
  currentRoleHint2,
} from './role-hint.js';
import {
  appendSocialMessage, appendSocialPoke, resolveReplyTarget, isQuoteTargetSelf,
  findMessageMedia, recordSentMessages, initSocialFlowCore, replyTargetHint,
} from './social-flow.js';
import {
  archiveIdleSessions, sessionArchiveStatus,
} from './session-archive.js';
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
// 出站回复幂等账本（2026-09-16 修「reset 之后同一条回复发了两遍」，事故经过见模块顶部注释）
import {
  filterAlreadySentBubbles, noteBatchOutcome, logIdempotencyBlock,
} from './send-idempotency.js';
// atUserId 入参体检：模型把 messageId 当 QQ 号传进来时降级为"不带 @"，别让整批失败（双发的触发源）
import {
  collectAtUserIdEvidence, judgeAtUserId, logAtUserIdDowngrade, atUserIdDowngradeNote,
} from '../lib/at-target.js';
import {
  loadScheduledTasks, parseScheduledAt, createScheduledTask, cancelScheduledTask, setScheduledRecorder, scheduledTasks,
} from './scheduler.js';
import {
  pushCrossDigest, addCrossMail, unreadCrossMails, markCrossMailsRead,
  buildCrossChatBlock, initCrossChatCore, describeCrossKey,
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
import { handleIncoming, pumpMux, initMuxCore, setMuxApi, setMuxBot } from './mux.js';

// 运行期注入
let cfgRef = null;
let apiRef = null;
let botRef = null;
let sendRich = null;
let musicSearch = null;
let buildMusicCard = null;   // media 域提供：音乐卡片字段由桥解析拼好（含封面归一化 + 降级梯子）
let writeLastMode = null;
export function initConsoleCore(cfg) { cfgRef = cfg; }
export function setConsoleApi(api) { apiRef = api; }
export function setConsoleBot(bot) { botRef = bot; }
export function setConsoleMedia(rich, music, card) { sendRich = rich; musicSearch = music; if (typeof card === 'function') buildMusicCard = card; }
export function setConsoleLastModeSink(fn) { writeLastMode = fn; }
let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护（原 main 局部）

/* 内置表情包（meme packs）总开关：与 sticker 一样，关掉就不把这两个工具算进"当前可用工具"，
 * 桥侧 mcp-napcat-safe.js 更是直接不注册它们（social.meme.enabled=false → 工具从列表里消失）。 */
const memeEnabled = () => cfgRef?.social?.meme?.enabled !== false;

/* ── 【2026-09-23 主人要求】管理端点不再"仅限主人私聊" ──────────────────────────
 * 原话："所有指令只要是主人或者管理员发出的都生效，不要单独限制在主人私聊里"。
 * 以前 /api/social/tunables、/api/social/admin-set、/api/social/whitelist 都硬判
 * `key === private:<ownerQQ>`，于是**主人在群里**说"把某群加白名单""把模型换成 X"一律被拒
 * （回一句"只有主人私聊能…"）。管理员更是完全做不到。
 *
 * 现在判据改成"身份 + 时效"，任一命中即放行：
 *   ① 主人自己的私聊会话（key 是 private:<ownerQQ> 且 token 对得上）—— 原行为，保留；
 *   ② 这个会话里**最近一条人话**是主人或管理员发的，且在 TRUST_SPOKE_WINDOW_MS 内。
 *      「主人或管理员」不需要另外判：social-flow 存的 m.isOwner 本身就是
 *      `uid === ownerQQ || adminQQ.includes(uid)`（见 mux.js 的同名变量）。
 *      只认"最近一条"而不是翻历史找：负责指挥的应该是**当下**说话的人；
 *      否则几分钟前主人说过一句、之后群友再怎么发也都会被当成主人授权。
 * 放行时返回命中的档位（写进日志/回包，便于事后追责）。 */
const TRUST_SPOKE_WINDOW_MS = 10 * 60 * 1000;
function trustLevelFor(key, token) {
  const k = String(key ?? '').trim();
  if (!k) return null;
  const ownerKey = 'private:' + String(cfgRef?.ownerQQ ?? '');
  const ownerTok = social.conversations.get(ownerKey)?.agentToken;
  if (k === ownerKey && token && ownerTok && String(token) === String(ownerTok)) return 'owner-private';
  try {
    const list = social.conversations.get(k)?.recentMessages;
    if (!Array.isArray(list)) return null;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (!m || m.isSelf) continue;                     // 只看别人发来的
      const fresh = Date.now() - Number(m.time || 0) < TRUST_SPOKE_WINDOW_MS;
      return m.isOwner && fresh ? 'trusted-spoke-here' : null;
    }
  } catch { /* 读不到 = 不可信 */ }
  return null;
}
/** tunables 那条路只有 token（没有 key），按 token 反查会话再走同一套判据。 */
function trustLevelForToken(token) {
  const t = String(token ?? '').trim();
  if (!t) return null;
  for (const [ck, cst] of social.conversations.entries()) {
    if (cst && cst.agentToken && String(cst.agentToken) === t) return trustLevelFor(ck, t);
  }
  return null;
}
const NOT_TRUSTED_MSG = '这个只有主人或管理员能改：私聊里直接说，或在群里等主人/管理员亲口说那句（10 分钟内有效）。';

// ══════════════════════════════════════════════════════════════════════════════
// 学习管理 / 用量统计（学习系统重构：console 侧 REST + 配置落盘，纯追加模块级代码，
// 不改动任何既有路由语义。按共享规格 v1「管理端 GUI」一节：3100 为纯 JSON API，
// 不再内嵌 HTML 页面；GUI(桌面 Tauri, nc_pink) 经 manager 隧道调这些 REST。）
// ══════════════════════════════════════════════════════════════════════════════
const LEARNING_CONFIG_FILE = path.join(STATE_DIR, 'learning-config.json');
const DEFAULT_LEARNING_CONFIG = {
  // slang/persona 各增 autoIntervalEnabled + autoIntervalHours（1~720 取整）；persona 增 lastRunAtMs（模块自写）。
  slang: {
    enabled: true, timeHHMM: '00:00', autoResearch: true, liveWindowExtract: false,
    lastLearnAtMs: 0,
    autoIntervalEnabled: false, autoIntervalHours: 24
  },
  persona: {
    enabled: true, targetQQ: [],
    autoIntervalEnabled: false, autoIntervalHours: 24,
    timeHHMM: '',                 // 每日定时（北京时 HH:MM）；空 = 不定时（与 portrait 同语义）
    lastRunAtMs: 0
  },
  portrait: {
    enabled: true, minMessages: 10, maxTargets: 20, windowHours: 720,
    autoIntervalEnabled: false, autoIntervalHours: 24, timeHHMM: '',
    lastRunAtMs: 0
  }
};
const LEARNING_TOP_KEYS = new Set(['slang', 'persona', 'portrait']);
const LEARNING_SLANG_KEYS = new Set(['enabled', 'timeHHMM', 'autoResearch', 'liveWindowExtract', 'autoIntervalEnabled', 'autoIntervalHours']);
const LEARNING_PERSONA_KEYS = new Set(['enabled', 'targetQQ', 'autoIntervalEnabled', 'autoIntervalHours', 'timeHHMM']);
const LEARNING_PORTRAIT_KEYS = new Set(['enabled', 'minMessages', 'maxTargets', 'windowHours', 'autoIntervalEnabled', 'autoIntervalHours', 'timeHHMM']);

function cloneLearningDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_LEARNING_CONFIG));
}

/** autoIntervalHours 规范化：取整并夹在 1~720；非法/缺省 → 24。 */
function clampAutoIntervalHours(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.min(720, Math.max(1, Math.round(n)));
}

/** 读 state/learning-config.json（缺文件/损坏 → 默认结构 + 类型兜底） */
function loadLearningConfig() {
  const file = readJsonSafe(LEARNING_CONFIG_FILE, null, false);
  const out = cloneLearningDefault();
  if (file && typeof file === 'object' && !Array.isArray(file)) {
    if (file.slang && typeof file.slang === 'object' && !Array.isArray(file.slang)) {
      out.slang = { ...out.slang, ...file.slang };
      if (typeof out.slang.enabled !== 'boolean') out.slang.enabled = DEFAULT_LEARNING_CONFIG.slang.enabled;
      if (typeof out.slang.timeHHMM !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(out.slang.timeHHMM)) out.slang.timeHHMM = DEFAULT_LEARNING_CONFIG.slang.timeHHMM;
      if (typeof out.slang.autoResearch !== 'boolean') out.slang.autoResearch = DEFAULT_LEARNING_CONFIG.slang.autoResearch;
      if (typeof out.slang.liveWindowExtract !== 'boolean') out.slang.liveWindowExtract = DEFAULT_LEARNING_CONFIG.slang.liveWindowExtract;
      if (typeof out.slang.autoIntervalEnabled !== 'boolean') out.slang.autoIntervalEnabled = DEFAULT_LEARNING_CONFIG.slang.autoIntervalEnabled;
      out.slang.autoIntervalHours = clampAutoIntervalHours(out.slang.autoIntervalHours);
      if (!Number.isFinite(Number(out.slang.lastLearnAtMs))) out.slang.lastLearnAtMs = 0;
      else out.slang.lastLearnAtMs = Math.max(0, Math.round(Number(out.slang.lastLearnAtMs)));
    }
    if (file.persona && typeof file.persona === 'object' && !Array.isArray(file.persona)) {
      out.persona = { ...out.persona, ...file.persona };
      if (typeof out.persona.enabled !== 'boolean') out.persona.enabled = DEFAULT_LEARNING_CONFIG.persona.enabled;
      out.persona.targetQQ = normalizeQQList(out.persona.targetQQ);
      if (typeof out.persona.autoIntervalEnabled !== 'boolean') out.persona.autoIntervalEnabled = DEFAULT_LEARNING_CONFIG.persona.autoIntervalEnabled;
      out.persona.autoIntervalHours = clampAutoIntervalHours(out.persona.autoIntervalHours);
      // 每日定时时刻：空串 = 不定时；非空必须是合法 HH:MM（与 portrait 同口径）
      if (typeof out.persona.timeHHMM !== 'string') out.persona.timeHHMM = DEFAULT_LEARNING_CONFIG.persona.timeHHMM;
      else {
        const tp = out.persona.timeHHMM.trim();
        out.persona.timeHHMM = tp === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(tp) ? tp : DEFAULT_LEARNING_CONFIG.persona.timeHHMM;
      }
      if (!Number.isFinite(Number(out.persona.lastRunAtMs))) out.persona.lastRunAtMs = 0;
      else out.persona.lastRunAtMs = Math.max(0, Math.round(Number(out.persona.lastRunAtMs)));
    }
    if (file.portrait && typeof file.portrait === 'object' && !Array.isArray(file.portrait)) {
      out.portrait = { ...out.portrait, ...file.portrait };
      const D = DEFAULT_LEARNING_CONFIG.portrait;
      if (typeof out.portrait.enabled !== 'boolean') out.portrait.enabled = D.enabled;
      const ci = (v, d, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
      out.portrait.minMessages = ci(out.portrait.minMessages, D.minMessages, 1, 5000);
      out.portrait.maxTargets = ci(out.portrait.maxTargets, D.maxTargets, 1, 200);
      out.portrait.windowHours = ci(out.portrait.windowHours, D.windowHours, 1, 8760);
      if (typeof out.portrait.autoIntervalEnabled !== 'boolean') out.portrait.autoIntervalEnabled = D.autoIntervalEnabled;
      out.portrait.autoIntervalHours = clampAutoIntervalHours(out.portrait.autoIntervalHours);
      // 定时时刻：空串 = 不定时；非空必须是合法 HH:MM
      if (typeof out.portrait.timeHHMM !== 'string') out.portrait.timeHHMM = D.timeHHMM;
      else {
        const t = out.portrait.timeHHMM.trim();
        out.portrait.timeHHMM = t === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : D.timeHHMM;
      }
      if (!Number.isFinite(Number(out.portrait.lastRunAtMs))) out.portrait.lastRunAtMs = 0;
      else out.portrait.lastRunAtMs = Math.max(0, Math.round(Number(out.portrait.lastRunAtMs)));
    }
  }
  return out;
}

function saveLearningConfig(cfg) {
  atomicWriteJson(LEARNING_CONFIG_FILE, cfg);
}

/** QQ 号规范化（与 persona-learn.js normalizeTargetUids 同口径：纯数字 1-11 位、去重、上限 100） */
export function normalizeQQList(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const s = String(raw ?? '').trim();
    if (!/^\d{1,11}$/.test(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= 100) break;
  }
  return out;
}

/** '8:5'/'08:05'/'24:00 越界' → 'HH:MM'(00:00-23:59)；非法返回 null */
export function normalizeTimeHHMM(text) {
  const m = String(text ?? '').trim().replace(/[：:]/g, ':').match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/**
 * PUT 白名单校验 + 合并（不直接覆盖文件）：
 *  - 顶层只接受 slang / persona；slang 只接受 enabled/timeHHMM/autoResearch/liveWindowExtract/
 *    autoIntervalEnabled/autoIntervalHours；persona 只接受 enabled/targetQQ/autoIntervalEnabled/
 *    autoIntervalHours；未知键一律 400。
 *  - slang.lastLearnAtMs 与 persona.lastRunAtMs 不在白名单 → PUT 永远无法覆盖
 *    （分别由黑话/人格模块自行写回），返回值从 cur 原样保留合并。
 *  - autoIntervalHours 取整并夹在 1~720（与 一致）。
 */
export function sanitizeLearningConfigBody(body, cur) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象');
  for (const k of Object.keys(body)) {
    if (!LEARNING_TOP_KEYS.has(k)) throw new Error(`不支持的字段：${k}（仅允许 slang / persona / portrait）`);
  }
  const next = {
    slang: { ...cur.slang },
    persona: { ...cur.persona, targetQQ: [...(cur.persona.targetQQ || [])] },
    portrait: { ...(cur.portrait || cloneLearningDefault().portrait) }
  };
  if (body.slang !== undefined) {
    if (!body.slang || typeof body.slang !== 'object' || Array.isArray(body.slang)) throw new Error('slang 必须是对象');
    for (const k of Object.keys(body.slang)) {
      if (!LEARNING_SLANG_KEYS.has(k)) throw new Error(`slang 不支持字段：${k}（lastLearnAtMs 由黑话模块自行维护，禁止覆盖）`);
    }
    const s = body.slang;
    if (s.enabled !== undefined) {
      if (typeof s.enabled !== 'boolean') throw new Error('slang.enabled 必须是布尔值');
      next.slang.enabled = s.enabled;
    }
    if (s.timeHHMM !== undefined) {
      const t = normalizeTimeHHMM(s.timeHHMM);
      if (!t) throw new Error('slang.timeHHMM 必须是 24 小时制 HH:MM（00:00–23:59）');
      next.slang.timeHHMM = t;
    }
    if (s.autoResearch !== undefined) {
      if (typeof s.autoResearch !== 'boolean') throw new Error('slang.autoResearch 必须是布尔值');
      next.slang.autoResearch = s.autoResearch;
    }
    if (s.liveWindowExtract !== undefined) {
      if (typeof s.liveWindowExtract !== 'boolean') throw new Error('slang.liveWindowExtract 必须是布尔值');
      next.slang.liveWindowExtract = s.liveWindowExtract;
    }
    if (s.autoIntervalEnabled !== undefined) {
      if (typeof s.autoIntervalEnabled !== 'boolean') throw new Error('slang.autoIntervalEnabled 必须是布尔值');
      next.slang.autoIntervalEnabled = s.autoIntervalEnabled;
    }
    if (s.autoIntervalHours !== undefined) {
      if (!Number.isFinite(Number(s.autoIntervalHours)) || Number(s.autoIntervalHours) <= 0) throw new Error('slang.autoIntervalHours 必须是数字（1~720 小时）');
      next.slang.autoIntervalHours = clampAutoIntervalHours(s.autoIntervalHours);
    }
  }
  if (body.persona !== undefined) {
    if (!body.persona || typeof body.persona !== 'object' || Array.isArray(body.persona)) throw new Error('persona 必须是对象');
    for (const k of Object.keys(body.persona)) {
      if (!LEARNING_PERSONA_KEYS.has(k)) throw new Error(k === 'lastRunAtMs' ? `persona 不支持字段：lastRunAtMs（由人格模块自动维护，禁止覆盖）` : `persona 不支持字段：${k}`);
    }
    const p = body.persona;
    if (p.enabled !== undefined) {
      if (typeof p.enabled !== 'boolean') throw new Error('persona.enabled 必须是布尔值');
      next.persona.enabled = p.enabled;
    }
    if (p.targetQQ !== undefined) {
      if (!Array.isArray(p.targetQQ)) throw new Error('persona.targetQQ 必须是字符串数组');
      for (const raw of p.targetQQ) {
        const s = String(raw ?? '').trim();
        if (!/^\d{1,11}$/.test(s)) throw new Error(`persona.targetQQ 包含无效 QQ：${s}`);
      }
      next.persona.targetQQ = normalizeQQList(p.targetQQ);
    }
    if (p.autoIntervalEnabled !== undefined) {
      if (typeof p.autoIntervalEnabled !== 'boolean') throw new Error('persona.autoIntervalEnabled 必须是布尔值');
      next.persona.autoIntervalEnabled = p.autoIntervalEnabled;
    }
    if (p.autoIntervalHours !== undefined) {
      if (!Number.isFinite(Number(p.autoIntervalHours)) || Number(p.autoIntervalHours) <= 0) throw new Error('persona.autoIntervalHours 必须是数字（1~720 小时）');
      next.persona.autoIntervalHours = clampAutoIntervalHours(p.autoIntervalHours);
    }
    if (p.timeHHMM !== undefined) {
      const raw = String(p.timeHHMM ?? '').trim();
      if (raw === '') next.persona.timeHHMM = '';
      else {
        const norm = normalizeTimeHHMM(raw);
        if (!norm) throw new Error('persona.timeHHMM 必须是 HH:MM（00:00~23:59）或留空表示不定时');
        next.persona.timeHHMM = norm;
      }
    }
  }
  if (body.portrait !== undefined) {
    if (!body.portrait || typeof body.portrait !== 'object' || Array.isArray(body.portrait)) throw new Error('portrait 必须是对象');
    for (const k of Object.keys(body.portrait)) {
      if (!LEARNING_PORTRAIT_KEYS.has(k)) throw new Error(k === 'lastRunAtMs' ? 'portrait 不支持字段：lastRunAtMs（由画像模块自动维护，禁止覆盖）' : `portrait 不支持字段：${k}`);
    }
    const q = body.portrait;
    const ci = (v, lo, hi, name) => {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`portrait.${name} 必须是数字`);
      return Math.min(hi, Math.max(lo, Math.round(n)));
    };
    if (q.enabled !== undefined) {
      if (typeof q.enabled !== 'boolean') throw new Error('portrait.enabled 必须是布尔值');
      next.portrait.enabled = q.enabled;
    }
    if (q.minMessages !== undefined) next.portrait.minMessages = ci(q.minMessages, 1, 5000, 'minMessages');
    if (q.maxTargets !== undefined) next.portrait.maxTargets = ci(q.maxTargets, 1, 200, 'maxTargets');
    if (q.windowHours !== undefined) next.portrait.windowHours = ci(q.windowHours, 1, 8760, 'windowHours');
    if (q.autoIntervalEnabled !== undefined) {
      if (typeof q.autoIntervalEnabled !== 'boolean') throw new Error('portrait.autoIntervalEnabled 必须是布尔值');
      next.portrait.autoIntervalEnabled = q.autoIntervalEnabled;
    }
    if (q.autoIntervalHours !== undefined) {
      if (!Number.isFinite(Number(q.autoIntervalHours)) || Number(q.autoIntervalHours) <= 0) throw new Error('portrait.autoIntervalHours 必须是数字（1~720 小时）');
      next.portrait.autoIntervalHours = clampAutoIntervalHours(q.autoIntervalHours);
    }
    if (q.timeHHMM !== undefined) {
      // 空串 = 不定时（与黑话不同：画像的定时是可选的）
      const t = String(q.timeHHMM ?? '').trim();
      if (t !== '' && !normalizeTimeHHMM(t)) throw new Error('portrait.timeHHMM 必须是 24 小时制 HH:MM，或留空表示不定时');
      next.portrait.timeHHMM = t === '' ? '' : normalizeTimeHHMM(t);
    }
  }
  return next;
}

export function startConsoleServer() {
  const port = cfgRef.consolePort ?? 3100;
  // 控制台鉴权：默认本机可信（不再自动生成令牌/写 state/console-token）；
  // 仅当 config.consoleToken 显式配置且合法时开启令牌校验（便于需要时对回环外部加一道锁）。
  const configuredToken = String(cfgRef.consoleToken ?? '').trim();
  const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
  let consoleToken = tokenValid ? configuredToken : null;
  if (configuredToken && !tokenValid) log('控制台 config.consoleToken 长度/字符不合法，已忽略（保持本机可信）');
  if (!configuredToken) log('控制台未启用令牌鉴权（默认绑定 127.0.0.1 本机可信；配置 consoleToken 可开启）');
  // default会话级隔离：MCP 工具调用时若带 x-agent-token，则必须匹配该会话的 agentToken。
  // 控制台/管理端请求不带此头，仍走 consoleToken 管理通道。
  // 跨会话判定：规则允许同一 AI 在任意会话里查/操作其他已授权会话（key 白名单 + 模式准入另行校验）。
  // 模型在多会话上下文间切换时可能带任一"本 AI 合法会话"的令牌，因此只要 token 命中
  // conversations 里任何一个已存在会话的 agentToken（即该令牌由本桥接签发、未被吊销）即视为有效；
  // 目标会话本身的访问权由 SessionAllowed / 工具开关 / 白名单独立把关，不在此处收紧。
  const agentTokenOk = (key, token) => {
    if (!token) return false;
    const canonical = canonicalKey(key);
    const st = social.conversations.get(canonical ?? key);
    if (st && st.agentToken && token === st.agentToken) return true;
    // 受信任的跨会话代发：主人 + social.trustedCrossSessionUids 里配置的好友（如常用好友），
    // 其私聊会话 token 可跨会话操作白名单内的其他会话——主人让 AI 去群里/给好友带话，
    // 或好友让 AI 给主人/群里带话转述。目标会话仍受 SessionAllowed/modeAllowed 白名单约束。
    const trustedUids = [String(cfgRef.ownerQQ), ...(Array.isArray(cfgRef.social?.trustedCrossSessionUids) ? cfgRef.social.trustedCrossSessionUids.map(String) : [])];
    for (const uid of trustedUids) {
      if (!uid) continue;
      const tSt = social.conversations.get('private:' + uid);
      if (tSt && tSt.agentToken && token === tSt.agentToken) return true;
    }
    // 任一已存在会话签发的令牌（本桥接在同一 AI 实体下管理全部 QQ 会话，令牌只在桥接内部流转，
    // 且出站文本经 redactKnownTokensOnly 清洗；命中即证明请求来自本桥接某合法会话上下文）
    for (const other of social.conversations.values()) {
      if (other && other.agentToken && token === other.agentToken) return true;
    }
    return false;
  };
  // default会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。
  const SessionAllowed = isSessionAllowedInCurrentMode;
  const ToolEnabled = (flag) => cfgRef.social?.tools?.[flag] !== false;

  /* ── 【2026-09-20 防「发错群」：跨会话发送必须显式声明】────────────────────────────────
   * 背景（主人 09-20 转述的用户反馈）：pixiv 发图发到别的群去了。查下来的根因有两处，
   * 一处已在工具层修掉（缺 key 时桥会去猜"当前在途会话"，多会话在途会挑最近活跃的那个），
   * 另一处就是这里：agentTokenOk() 只要求"token 是本桥签发的合法令牌"，**不要求它属于目标会话**
   * （跨会话代发是**有意支持**的功能：主人在私聊让 AI 去群里带话，或受信任好友让 AI 转述），
   * 于是"模型把另一个会话的 key 抄进参数"与"有意跨会话发送"在服务端长得一模一样，桥只能照发。
   *
   * 现在把两者拆开：token 自己属于哪个会话 = 调用方会话（callerKeyOfToken）；
   *   · 目标 == 调用方  → 正常发送（绝大多数调用走这条，零变化）；
   *   · 目标 != 调用方  → 只有参数里显式写 `crossSession: true` 才放行，否则 403 并**把两个会话都报出来**
   *     （含群名），让模型自己看清是不是抄错了；确实要跨会话转达的，加上这个字段重发一次即可。
   * 这样"抄错 key"从"静默发错群"变成"一次明确的 403 + 精确提示"。
   *
   * 注意：`trustedCrossSessionUids` 的语义不受影响（受信任好友/主人仍可跨会话发送），只是改成
   * 需要把 `crossSession: true` 一起传——工具的 schema 里已经声明了这个参数。 */
  const callerKeyOfToken = (token) => {
    const t = String(token ?? '').trim();
    if (!t) return '';
    for (const [k, st] of social.conversations) if (st && st.agentToken && st.agentToken === t) return k;
    return '';
  };
  const keyLabel = (k) => {
    try {
      if (String(k).startsWith('group:')) {
        const name = getGroupDisplayName(String(k).slice(6));
        if (name) return `${k}（${name}）`;
      }
    } catch { /* 拿不到群名不影响判定 */ }
    return String(k);
  };
  const crossSessionRefusal = (token, targetKey, crossFlag) => {
    if (crossFlag === true) return '';                       // 模型显式声明"我就是要发到别的会话"
    const callerKey = callerKeyOfToken(token);
    if (!callerKey) return '';                               // 认不出调用方（如管理端请求）→ 不拦
    const target = canonicalKey(targetKey) ?? String(targetKey ?? '');
    if (!target || target === callerKey) return '';
    log(`[cross-session] 拒绝：调用方 ${callerKey} 想发到 ${target}（未声明 crossSession:true）`);
    return `这条调用带的是 ${keyLabel(callerKey)} 的令牌，却要发到 ${keyLabel(target)} —— 桥不替你猜目标会话。`
      + `如果你就是在回答 ${keyLabel(callerKey)}，把 key 改成 "${callerKey}"（唤醒正文里 [Session] 行就是它）；`
      + `如果确实要发到 ${keyLabel(target)}（跨会话转达/转发），把参数 crossSession 设为 true 再发一次。`;
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const SECURITY_HEADERS = {
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    };
    const sendJson = (obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
      res.end(JSON.stringify(obj, null, 2));
    };
    const readBody = () => new Promise((resolve, reject) => {
      const MAX_BODY_BYTES = 1_000_000;
      const chunks = [];
      let total = 0;
      let settled = false;
      let bodyTimer = null;
      const fail = (status, message) => {
        if (settled) return;
        settled = true;
        if (bodyTimer) clearTimeout(bodyTimer);
        const err = new Error(message);
        err.statusCode = status;
        reject(err);
      };
      const done = (val) => {
        if (settled) return;
        settled = true;
        if (bodyTimer) clearTimeout(bodyTimer);
        resolve(val);
      };
      // 提前按 Content-Length 拒绝超限请求体
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        fail(413, '请求体过大（超过 1MB）');
        return;
      }
      bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
      req.on('data', (c) => {
        if (settled) return;
        const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
        total += buf.length;
        if (total > MAX_BODY_BYTES) {
          req.pause();
          fail(413, '请求体过大（超过 1MB）');
          return;
        }
        chunks.push(buf);
      });
      req.on('end', () => {
        if (settled) return;
        const data = Buffer.concat(chunks).toString('utf8');
        if (!data.trim()) { done({}); return; }
        let parsed;
        try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          fail(400, '请求体必须是 JSON 对象');
          return;
        }
        done(parsed);
      });
      // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
      req.on('error', () => fail(400, '请求体读取失败'));
      req.on('aborted', () => fail(400, '请求体读取中断'));
    });
    // 控制台鉴权：所有 API 请求需带 x-console-token 或 ?token=（首页探活 GET / 免鉴权）
    const suppliedToken = url.searchParams.get('token') ?? req.headers['x-console-token'];
    const isRootProbe = req.method === 'GET' && url.pathname === '/';
    if (consoleToken && suppliedToken !== consoleToken && !isRootProbe) {
      sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
      return;
    }
    // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
    // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
    // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
    if (req.method !== 'GET') {
      const ctype = String(req.headers['content-type'] ?? '');
      if (!ctype.toLowerCase().includes('application/json')) {
        sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
        return;
      }
      const origin = req.headers['origin'];
      if (origin) {
        let originHost = '';
        try { originHost = new URL(String(origin)).host; } catch {}
        if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(originHost)) {
          sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
          return;
        }
      }
    }
    try {
      // 空 agent token 一律拒绝，防止 MCP 传入空字符串时被当作“管理端/无 token”绕过校验
      if (req.headers['x-agent-token'] === '') {
        sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
        return;
      }
      // default AI is paused，所有agent-token session tools are rejected
      if (social.paused && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/social/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
        sendJson({ ok: false, error: 'AI is paused - tools are disabled.' }, 403);
        return;
      }
      // Social engine master switch：关闭后 agent-token session tools are rejected（控制台仍可管理）
      if (cfgRef.social?.enabled === false && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/social/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
        sendJson({ ok: false, error: 'Social engine is off - tools are disabled.' }, 403);
        return;
      }
      // 管理端专用接口：带 agent token 的请求一律拒绝，防止 MCP 工具越权访问控制台功能
      const adminOnlyPaths = ['/api/social/config', '/api/social/activity', '/api/social/reset', '/api/social/states', '/api/social/wake'];
      if (req.headers['x-agent-token'] && (adminOnlyPaths.includes(url.pathname) || (url.pathname === '/api/social/feedback' && req.method === 'GET') || (url.pathname === '/api/social/tool-log' && req.method === 'GET'))) {
        sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
        return;
      }
      // 表情库管理接口只允许控制台（agent-token session tools rejected to prevent cross-privilege library edits）
      if (req.headers['x-agent-token'] && (url.pathname === '/api/stickers' || url.pathname.startsWith('/api/stickers/'))) {
        sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
        return;
      }
      // ── 敏感端点强制会话令牌（2026-09-11）────────────────────────────────
      // 这三个端点原先**零鉴权**（`deepsleep` 只把 header 用于打日志、`blacklist`/`profile` 连读都不读），
      // 意味着任何能访问 127.0.0.1:3100 的本机进程都能：全局静默所有群、拉黑任意 QQ、
      // 读写任意人的长期档案 —— 且这些操作会**直接写进 config.json**。
      // 实测管理器 GUI 与前端都不调用这三条路径，MCP 侧 4 个工具我已同步补上 x-agent-token，
      // 所以收紧不会打断任何现存调用方。
      // 注：这挡的是"无凭据的本机调用"，不是"被提示注入的 AI"——后者本来就持有合法会话令牌。
      // 2026-09-11 第二批：schedule / schedule-list / schedule-cancel / forward-send 原先是
      // `if (token && !agentTokenOk(...))` 形式的 fail-open（不带 token 反而不校验）。
      // 已核实这四个端点的 MCP 调用方（qq_schedule_message / qq_schedule_list /
      // qq_schedule_cancel / qq_send_forward）**本来就发 x-agent-token**，管理器 GUI 与前端不调用，
      // 因此收紧不会打断任何现存调用方。
      const AGENT_TOKEN_REQUIRED = [
        '/api/social/deepsleep', '/api/blacklist', '/api/profile',
        '/api/social/schedule', '/api/social/schedule-list', '/api/social/schedule-cancel',
        '/api/social/forward-send'
      ];
      if (AGENT_TOKEN_REQUIRED.includes(url.pathname)) {
        const tk = String(req.headers['x-agent-token'] ?? '').trim();
        if (!tk || !KNOWN_AGENT_TOKENS.has(tk)) {
          sendJson({ ok: false, error: 'This endpoint needs a valid agent token = the [Token] value at the top of the latest wake prompt, copied verbatim' }, 403);
          return;
        }
      }
      if (isRootProbe) {
        // 自带 Web 管理端已移除（配置并入 QQ-Bridge Manager 主界面）；仅保留 JSON 探活/API。
        sendJson({ ok: true, name: 'qq-bridge', ui: 'embedded-in-manager' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const rs = readRoleState();
        sendJson({
          role: rs.role ?? null,
          roleMode: rs.mode ?? 'active',
          dshReady,
          ownerQQ: cfgRef.ownerQQ ?? null,
          allowGroups: cfgRef.allow?.groups ?? [],
          allowPrivate: cfgRef.allow?.private ?? [],
          socialPaused: social.paused,
          activity: readActivityTail(100)
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/role') {
        const body = await readBody();
        const rs = readRoleState();
        if (body.role && typeof body.role === 'string') {
          const name = sanitizeRoleName(body.role);
          if (!fs.existsSync(path.join(ROOT, 'roles', name + '.md'))) {
            sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
            return;
          }
          writeRoleState(name, rs.mode);
          log(`控制台：角色已设置为 ${name}`);
          sendJson({ ok: true, role: name });
        } else {
          writeRoleState(null, rs.mode);
          log('控制台：角色已清除');
          sendJson({ ok: true, role: null });
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/role-mode') {
        const body = await readBody();
        const rs = readRoleState();
        const mode = body.mode === 'silent' ? 'silent' : 'active';
        writeRoleState(rs.role, mode);
        log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
        sendJson({ ok: true, roleMode: mode });
        return;
      }
      // ── 人格管理 ──────────────────────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/roles') {
        const rs = readRoleState();
        sendJson({ roles: listRoles(), current: rs.role ?? null });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/roles/create') {
        const body = await readBody();
        const name = sanitizeRoleName(body.name);
        const content = String(body.content ?? '').trim();
        if (!name) { sendJson({ ok: false, error: '角色名不能为空（仅限中文/字母/数字/横线）' }, 400); return; }
        if (!content) { sendJson({ ok: false, error: '角色内容不能为空' }, 400); return; }
        if (name === 'README') { sendJson({ ok: false, error: '该名称被保留' }, 400); return; }
        const roleFile = path.join(ROOT, 'roles', name + '.md');
        if (fs.existsSync(roleFile)) { sendJson({ ok: false, error: `角色「${name}」已存在` }, 400); return; }
        fs.mkdirSync(path.join(ROOT, 'roles'), { recursive: true });
        atomicWriteText(roleFile, content + (content.endsWith('\n') ? '' : '\n'));
        log(`控制台：创建人格「${name}」`);
        sendJson({ ok: true, role: name });
        return;
      }
      // ── 黑话库管理 ──────────────────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/slang') {
        const status = url.searchParams.get('status') || '';
        const list = status ? slangEntries.filter((e) => e.status === status) : slangEntries;
        // 【2026-09-16】附带"学习状态机"快照（phase/inFlight/queuedOps/researching/lastLearnAtMs/counts），
        // 供管理端把"现在到哪一步了"显示清楚；老桥没有这个导出时字段为 null，前端按"拿不到"处理即可。
        let learning = null;
        try {
          const slangMod = await import('../core/slang.js');
          if (typeof slangMod.slangLearningState === 'function') learning = slangMod.slangLearningState();
        } catch { learning = null; }
        sendJson({ entries: list, config: cfgRef.slang, learning });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/slang') {
        const body = await readBody();
        const content = String(body.content ?? '').trim();
        if (!content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
        // 归一化键判重（同一个词换个写法不该能再加一条，见 slangKey 的说明）
        if (slangEntries.some((e) => slangKey(e.content) === slangKey(content))) { sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return; }
        const entry = createSlangEntry({
          content,
          meaning: String(body.meaning ?? '').trim(),
          usage: String(body.usage ?? '').trim(),
          example: String(body.example ?? '').trim(),
          risk: String(body.risk ?? '').trim(),
          sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
          status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
          source: 'manual',
          evidence: Array.isArray(body.evidence) ? body.evidence : []
        });
        slangEntries.push(entry);
        saveSlangStore();
        log(`控制台：新增黑话「${content}」`);
        sendJson({ ok: true, entry });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/slang/clear') {
        const body = await readBody();
        const status = String(body.status ?? '').trim();
        if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
          sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
          return;
        }
        let removedCount = 0;
        if (status) {
          removedCount = slangEntries.filter((e) => e.status === status).length;
          setSlangEntries(slangEntries.filter((e) => e.status !== status));
        } else {
          removedCount = slangEntries.length;
          setSlangEntries([]);
          // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
          slangWindows.clear();
          slangExtractionCooldowns.clear();
          slangSubmitTimes.clear();
          slangResearchingIds.clear();
        }
        saveSlangStore();
        log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
        sendJson({ ok: true, removedCount });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/slang/batch-delete') {
        const body = await readBody();
        const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
        const status = String(body.status ?? '').trim();
        if (ids.length) {
          const idSet = new Set(ids);
          const before = slangEntries.length;
          setSlangEntries(slangEntries.filter((e) => !idSet.has(e.id)));
          const removedCount = before - slangEntries.length;
          if (!removedCount) { sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return; }
          saveSlangStore();
          log(`控制台：批量删除黑话 ${removedCount} 条`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
          sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
          return;
        }
        if (!status) { sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return; }
        const removedCount = slangEntries.filter((e) => e.status === status).length;
        setSlangEntries(slangEntries.filter((e) => e.status !== status));
        saveSlangStore();
        log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
        sendJson({ ok: true, removedCount });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/slang/batch-confirm') {
        const body = await readBody();
        const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
        if (!ids.length) { sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return; }
        let confirmedCount = 0;
        let skippedCount = 0;
        const skipped = [];
        for (const id of ids) {
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
          const entry = slangEntries[idx];
          if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
          if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
          entry.status = SLANG_STATUS.CONFIRMED;
          entry.updatedAt = new Date().toISOString();
          confirmedCount++;
        }
        if (confirmedCount) saveSlangStore();
        log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
        sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/slang/batch-reject') {
        const body = await readBody();
        const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
        if (!ids.length) { sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return; }
        let rejectedCount = 0;
        for (const id of ids) {
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) continue;
          const entry = slangEntries[idx];
          if (entry.status === SLANG_STATUS.REJECTED) continue;
          entry.status = SLANG_STATUS.REJECTED;
          entry.updatedAt = new Date().toISOString();
          rejectedCount++;
        }
        if (rejectedCount) saveSlangStore();
        log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
        sendJson({ ok: true, rejectedCount });
        return;
      }
      const slangMatch = url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
      if (req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
        const id = slangMatch[1];
        const idx = slangEntries.findIndex((e) => e.id === id);
        if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
        const body = await readBody();
        const entry = { ...slangEntries[idx] };
        if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
        if (body.content !== undefined && slangEntries.some((e) => e.id !== id && slangKey(e.content) === slangKey(entry.content))) {
          sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
          return;
        }
        if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
        if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
        if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
        if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
        if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
        if (body.status !== undefined && [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
        if (!entry.content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
        entry.updatedAt = new Date().toISOString();
        slangEntries[idx] = entry;
        saveSlangStore();
        log(`控制台：更新黑话「${entry.content}」`);
        sendJson({ ok: true, entry });
        return;
      }
      if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
        const id = slangMatch[1];
        const idx = slangEntries.findIndex((e) => e.id === id);
        if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
        const body = await readBody();
        const entry = slangEntries[idx];
        if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
        if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
        if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
        if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
        if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
        if (!entry.meaning) {
          sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
          return;
        }
        entry.status = SLANG_STATUS.CONFIRMED;
        entry.updatedAt = new Date().toISOString();
        saveSlangStore();
        log(`控制台：确认黑话「${entry.content}」`);
        sendJson({ ok: true, entry });
        return;
      }
      if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
        const id = slangMatch[1];
        const idx = slangEntries.findIndex((e) => e.id === id);
        if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
        const entry = slangEntries[idx];
        entry.status = SLANG_STATUS.REJECTED;
        entry.updatedAt = new Date().toISOString();
        saveSlangStore();
        log(`控制台：拒绝黑话「${entry.content}」`);
        sendJson({ ok: true, entry });
        return;
      }
      if (req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
        const id = slangMatch[1];
        const idx = slangEntries.findIndex((e) => e.id === id);
        if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
        const [removed] = slangEntries.splice(idx, 1);
        saveSlangStore();
        log(`控制台：删除黑话「${removed.content}」`);
        sendJson({ ok: true, removed });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/slang/extract') {
        if (cfgRef.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        if (key && slangWindows.has(key)) {
          queueSlangTask(() => runSlangExtraction(key));
          sendJson({ ok: true, key });
        } else {
          const firstKey = slangWindows.keys().next().value;
          if (!firstKey) { sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return; }
          queueSlangTask(() => runSlangExtraction(firstKey));
          sendJson({ ok: true, key: firstKey });
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/slang/research') {
        if (cfgRef.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
        const body = await readBody();
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        const candidates = ids.length
          ? slangEntries.filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
          : slangEntries.filter((e) => e.status === SLANG_STATUS.CANDIDATE);
        if (!candidates.length) { sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return; }
        queueSlangTask(() => runSlangResearch(candidates));
        sendJson({ ok: true, count: candidates.length });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/slang/config') {
        const body = await readBody();
        const oldPreset = cfgRef.slang?.learnerPreset;
        const oldWorkspaceTitle = cfgRef.slang?.workspaceTitle;
        const configFile = path.join(ROOT, 'config.json');
        const file = readJsonSafe(configFile, null, true);
        const merged = { ...(file.slang ?? {}), ...body };
        if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
        else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
        if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
        if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
        if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
        if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
        if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
        if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
        if (body.inferenceThresholds !== undefined) {
          const raw = Array.isArray(body.inferenceThresholds)
            ? body.inferenceThresholds
            : String(body.inferenceThresholds).split(/[,，\s]+/);
          merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
          if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
        }
        file.slang = merged;
        atomicWriteJson(configFile, file);
        cfgRef.slang = { ...cfgRef.slang, ...merged };
        if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
          invalidateSlangLearnerSession();
          log('黑话学习 preset 已变更，已重置学习会话');
        } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
          invalidateSlangLearnerSession();
          log('黑话学习工作区名已变更，已重置学习会话');
        }
        log('控制台：黑话系统配置已更新');
        sendJson({ ok: true, config: cfgRef.slang });
        return;
      }
      // ── 会话查看 ──────────────────────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        const list = [];
        for (const [key, sessionId] of Object.entries(state.sessions)) {
          list.push({ key, sessionId, owner: key === `private:${String(cfgRef.ownerQQ ?? '')}` });
        }
        sendJson({ sessions: list });
        return;
      }
      // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/pending') {
        const list = [];
        for (const [key, p] of pending.entries()) {
          list.push({
            key,
            kind: p.kind,
            sessionId: p.sessionId,
            ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
            ...(p.kind === 'question' ? { questions: p.questions } : {})
          });
        }
        sendJson({ pending: list });
        return;
      }
      // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
      if (req.method === 'GET' && url.pathname === '/api/whitelist') {
        sendJson({ allow: cfgRef.allow ?? { private: [], groups: [] }, deny: cfgRef.deny ?? { private: [], groups: [] }, ownerQQ: cfgRef.ownerQQ ?? null });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/whitelist') {
        const body = await readBody();
        const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
        const configFile = path.join(ROOT, 'config.json');
        // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
        const file = readJsonSafe(configFile, null, true);
        const allow = {
          private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
          groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
        };
        const deny = {
          private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
          groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
        };
        // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
        let ownerQQ = cfgRef.ownerQQ ?? null;
        if (body.ownerQQ !== undefined) {
          try {
            ownerQQ = normalizeOwnerQQ(body.ownerQQ);
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
            return;
          }
        }
        file.allow = allow;
        file.deny = deny;
        file.ownerQQ = ownerQQ;
        atomicWriteJson(configFile, file);
        cfgRef.allow = { private: allow.private, groups: allow.groups };
        cfgRef.deny = { private: deny.private, groups: deny.groups };
        cfgRef.ownerQQ = ownerQQ;
        log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
        sendJson({ ok: true, allow, deny, ownerQQ });
        return;
      }

      // ── 安全拦截通知设置 ─────────────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/security') {
        sendJson({ security: cfgRef.security ?? { interceptNotify: true } });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/security') {
        const body = await readBody();
        const configFile = path.join(ROOT, 'config.json');
        const file = readJsonSafe(configFile, null, true);
        const next = { ...(file.security ?? {}), ...body };
        if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
        else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
        file.security = next;
        atomicWriteJson(configFile, file);
        cfgRef.security = { ...(cfgRef.security ?? {}), ...next };
        log(`控制台：安全拦截通知已更新（interceptNotify=${cfgRef.security.interceptNotify}）`);
        sendJson({ ok: true, security: cfgRef.security });
        return;
      }
      // ── 控制台访问令牌（已停用：默认本机可信，不再自动生成/手动修改） ─────────
      if (req.method === 'POST' && url.pathname === '/api/console/token') {
        sendJson({ ok: false, error: '令牌鉴权已停用：控制台默认绑定 127.0.0.1 本机可信；如需开启请在 config.json 配置 consoleToken 后重启' }, 400);
        return;
      }
      // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/test-send') {
        const body = await readBody();
        const kind = body.kind === 'private' ? 'private' : 'group';
        const id = Number(body.id);
        const message = String(body.message ?? '').trim();
        if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
        if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
        if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
        if (!allowed(kind, id, cfgRef)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return; }
        if (!modeAllowed(`${kind}:${id}`, kind, id, cfgRef, currentMode)) { sendJson({ ok: false, error: `当前模式（${currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return; }
        try {
          const safeMessage = escapeCqText(redactKnownTokensOnly(message));
          const result = kind === 'private'
            ? await botRef.sendPrivateMessage(id, qqTextSeg(safeMessage))
            : await botRef.sendGroupMessage(id, qqTextSeg(safeMessage));
          log(`控制台：测试发送 ${kind}:${id} 成功`);
          sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
        } catch (error) {
          sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
        }
        return;
      }
      // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
      if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const message = String(body.message ?? '').trim();
        if (!key || !message) {
          sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
          return;
        }
        const keyMatch = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatch) {
          sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
          return;
        }
        const kind = keyMatch[1];
        const id = Number(keyMatch[2]);
        if (!Number.isFinite(id) || id <= 0) {
          sendJson({ ok: false, error: 'id 无效' }, 400);
          return;
        }
        if (!modeAllowed(key, kind, id, cfgRef, currentMode)) {
          sendJson({ ok: false, error: `该会话不在当前模式（${currentMode}）允许范围内` }, 403);
          return;
        }
        if (!state.sessions[key] && !allowed(kind, id, cfgRef)) {
          sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
          return;
        }
        if (!dshReady) {
          sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
          return;
        }
        const is = true; // single default mode (protocol)
        const roleState = readRoleState();
        const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
        // default必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
        let tokenLine = '';
        if (is) {
          const st2 = getSocialState(key);
          tokenLine = `[Session token] ${st2.agentToken} (pass it in key-carrying state/send tool calls)\n\n`;
        }
        const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${is ? '当前是default模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
        let sessionId = null;
        let popSilent = null;
        try {
          sessionId = await ensureSession(key);
          const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
          const arr = silentTurnQueue.get(sessionId) ?? [];
          silentTurnQueue.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
          popSilent = () => {
            const list = silentTurnQueue.get(sessionId) ?? [];
            const next = list.filter((x) => x.id !== silentId);
            if (next.length > 0) silentTurnQueue.set(sessionId, next);
            else silentTurnQueue.delete(sessionId);
          };
          const result = await deliverPrompt(key, promptText, { silent: true });
          if (result.ok) {
            log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
            appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
            sendJson({ ok: true, key, sessionId });
          } else {
            popSilent();
            sendJson({ ok: false, error: result.error || '投递失败' }, 500);
          }
        } catch (error) {
          if (popSilent) popSilent();
          sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
        }
        return;
      }
      // ── default模式（default）内部 Agent API ─────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/social/config') {
        sendJson({ ok: true, config: cfgRef.social ?? {} });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/config') {
        const body = await readBody();
        const configFile = path.join(ROOT, 'config.json');
        const file = readJsonSafe(configFile, null, true);
        const current = file.social ?? {};
        const merged = { ...current, ...body };
        // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
        for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'meme', 'feedback', 'context']) {
          if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
            merged[sub] = current[sub] ?? {};
          }
        }
        if (merged.autoReplyCheckMs !== undefined) {
          const n = Number(merged.autoReplyCheckMs);
          merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
        }
        // tools：只接受布尔开关
        const toolFlags = ['getPrompt', 'getUnread', 'getRecent', 'socialState', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers', 'setWakeConfig', 'markRead', 'memory', 'slangQuery', 'slangSubmit', 'getImages', 'getForwardMsg', 'sendPoke', 'like', 'proactiveSend', 'listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'getSelfImage'];
        if (body.tools && typeof body.tools === 'object') {
          merged.tools = { ...(current.tools ?? {}), ...body.tools };
          for (const k of toolFlags) {
            if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
          }
        }
        // meme（内置表情包多包）：enabled 宽松解析；packs = 包 id 数组；personaPacks = "角色 slug -> 包 id 数组"
        if (body.meme && typeof body.meme === 'object' && !Array.isArray(body.meme)) {
          merged.meme = { ...(current.meme ?? {}), ...body.meme };
          const asTrue = (v) => (v === true || v === 1 || /^(true|on|1|yes|开|打开)$/i.test(String(v ?? '').trim()));
          if (merged.meme.enabled !== undefined) merged.meme.enabled = asTrue(merged.meme.enabled);
          merged.meme.packs = Array.isArray(merged.meme.packs) ? merged.meme.packs.map(String).filter(Boolean) : (current.meme?.packs ?? []);
          const pp = merged.meme.personaPacks;
          merged.meme.personaPacks = (pp && typeof pp === 'object' && !Array.isArray(pp))
            ? Object.fromEntries(Object.entries(pp).map(([k, v]) => [String(k), (Array.isArray(v) ? v : [v]).map(String).filter(Boolean)]))
            : (current.meme?.personaPacks ?? {});
          merged.meme.activePersona = String(merged.meme.activePersona ?? '');
        }
        // wake：数值与字符串数组归一化
        if (body.wake && typeof body.wake === 'object') {
          merged.wake = { ...(current.wake ?? {}), ...body.wake };
          for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {
            if (merged.wake[k] !== undefined) {
              const n = Number(merged.wake[k]);
              merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
              // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
              if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
            }
          }
          if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
          if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
          if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
          if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
          if (merged.wake.recommendedKeywords !== undefined) {
            merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
          }
          if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
          if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
        }
        // send：数值归一化
        if (body.send && typeof body.send === 'object') {
          merged.send = { ...(current.send ?? {}), ...body.send };
          // burstIntervalMinMs/MaxMs 已废弃；打字节拍只有"按字数"一组（linear*），见 send-chain.js。
          for (const k of ['burstMaxMessages', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'linearPerCharMs', 'linearMinMs', 'linearCapMs', 'linearJitterRatio', 'linearResetMs']) {
            if (merged.send[k] !== undefined) {
              const n = Number(merged.send[k]);
              merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
              // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
              if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
            }
          }
          if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
          // 【2026-09-15 修「按字数节拍被静默关掉」】原来是 `=== true`：管理器/前端的布尔值一旦是
          // 字符串 "true"（表单/JSON 往返很常见），就会**被当成 false 写回去** —— 实测服务端配置就这样
          // 变成 linearEnabled:false，打字节拍整个失效，而界面上看起来只是"保存了一下配置"。
          // 现在按真值字符串宽松解析（true/on/1/开 = 开）。
          const asBool = (v) => (v === true || v === 1 || /^(true|on|1|yes|开|打开)$/i.test(String(v ?? '').trim()));
          if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = asBool(merged.send.burstEnabled);
          if (merged.send.linearEnabled !== undefined) merged.send.linearEnabled = asBool(merged.send.linearEnabled);
          if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
        }
        // wait：数值归一化
        if (body.wait && typeof body.wait === 'object') {
          merged.wait = { ...(current.wait ?? {}), ...body.wait };
          for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
            if (merged.wait[k] !== undefined) {
              const n = Number(merged.wait[k]);
              merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
            }
          }
        }
        // proactive：主动机会参数
        if (body.proactive && typeof body.proactive === 'object') {
          merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
          for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
            if (merged.proactive[k] !== undefined) {
              const n = Number(merged.proactive[k]);
              merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
              // 毫秒类字段统一非负取整；概率字段单独 clamp。
              if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
            }
          }
          if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
          if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
        }
        // sticker：表情包体系参数归一化
        if (body.sticker && typeof body.sticker === 'object') {
          merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
          if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
          for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
            if (merged.sticker[k] !== undefined) {
              const n = Number(merged.sticker[k]);
              merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
            }
          }
          if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
          if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
          if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
          if (body.sticker.collect && typeof body.sticker.collect === 'object') {
            merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
            if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
            for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
              if (merged.sticker.collect[k] !== undefined) {
                const n = Number(merged.sticker.collect[k]);
                merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
              }
            }
          }
        }
        // feedback：数值/布尔归一化
        if (body.feedback && typeof body.feedback === 'object') {
          merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
          if (merged.feedback.maxLength !== undefined) {
            const n = Number(merged.feedback.maxLength);
            merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
          }
          if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
        }
        // context：数值归一化
        // 【2026-09-16】加入 resetWindow（轮换后首轮的注入窗口，见 wake-send.js 的 resetBase）：
        // 它和其它三个键一样是正整数，漏在名单外会让这条接口写进来的值不被归一化
        //（例如字符串 "24" 也能落盘，前端再读回来就按文本渲染）。
        // 同时把"非数值时的兜底"从统一写死的 20 改成**与读取处一致的每键缺省**
        //（recentLimit 100 / unreadLimit 30 / contextWindow 20 / resetWindow 24）——
        // 以前 recentLimit 传个非数值会被兜成 20，比桥读取处的 100 小一个量级。
        if (body.context && typeof body.context === 'object') {
          const CONTEXT_DEFAULT = { recentLimit: 100, unreadLimit: 30, contextWindow: 20, resetWindow: 24 };
          merged.context = { ...(current.context ?? {}), ...body.context };
          for (const k of Object.keys(CONTEXT_DEFAULT)) {
            if (merged.context[k] !== undefined) {
              const n = Number(merged.context[k]);
              merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? CONTEXT_DEFAULT[k];
            }
          }
        }
        if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
        if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
        if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
        file.social = merged;
        atomicWriteJson(configFile, file);
        cfgRef.social = { ...(cfgRef.social ?? {}), ...merged };
        // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
        // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
        const WAKE_DEFAULT_KEYS = [
          'defaultMode', 'recommendedDefaultInfinite',
          'recommendedSleepMinMs', 'recommendedSleepMaxMs',
          'recommendedProbability', 'recommendedKeywords',
          'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
          'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
        ];
        const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
          WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
        if (wakeDefaultChanged) refreshAllDefaultWakeConfigs();
        log('控制台：default配置已更新');
        sendJson({ ok: true, config: cfgRef.social });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/social/activity') {
        sendJson({ ok: true, paused: social.paused });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/activity') {
        const body = await readBody();
        const paused = body.paused === true;
        social.paused = paused;
        if (paused) {
          clearAllSocialTimers();
          log('控制台：default AI 已暂停（唤醒/等待任务已停止）');
        } else {
          log('控制台：default AI 已恢复');
          for (const key of social.conversations.keys()) {
          setupSleepTimer(key);
          scheduleProactiveCheck(key);
        }
        }
        saveSocialState();
        sendJson({ ok: true, paused: social.paused });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/deepsleep') {
        const body = await readBody();
        const enabled = body.enabled === true;
        if (!cfgRef.social) cfgRef.social = {};
        cfgRef.social.deepsleep = enabled;
        fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(cfgRef, null, 2));
        log('[deepsleep] ' + (enabled ? '开启' : '关闭') + '全程静默所有群聊（' + (req.headers['x-agent-token'] ? 'AI触发' : '控制台触发') + '）');
        sendJson({ ok: true, deepsleep: enabled });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/reset') {
        bumpSessionEpoch();
        sessionPromises.clear();
        clearAllSocialTimers();
        drainAllPromptQueues('default状态已重置');
        const keysWithCarriedLedger = [];
        for (const key of [...social.conversations.keys()]) {
          const sid = state.sessions[key];
          if (sid) {
            delete state.sessions[key];
            reverse.delete(sid);
            collectors.delete(sid);
            TurnStartAt.delete(sid);
            toolCallNames.delete(sid);
            pendingSendToolCalls.delete(sid);
            sendToolSucceededSessions.delete(sid);
          }
          const removed = social.conversations.get(key);
          if (removed?.agentToken) KNOWN_AGENT_TOKENS.delete(removed.agentToken);
          // 【2026-09-16】不再 `social.conversations.delete(key)` 一刀切：那样会把「已回复账本」
          // （answeredMessageIds / lastDeliveredSeq / _wakeIntendedSeq / lastUnreadSeq）一起抹掉，
          // 重置后同一个会话就成了白纸 → 刚回过的内容可能被再回一遍（真机事故「reset 之后重复回复」）。
          // 这里改成"清会话、留账本"，见 social-state.resetConversationKeepingLedger。
          const carriedReset = resetConversationKeepingLedger(key);
          if (!carriedReset) log(`[reset] ${key} 无账本需要保留（该会话此前没有已回复记录）`);
          seenForwardIds.delete(key);
          keysWithCarriedLedger.push(key);
        }
        // 重建账本时会顺带重新装配该会话的主动/睡眠定时器；这里再清一次，保住本端点"定时器已清空"的语义。
        clearAllSocialTimers();
        pendingWakeKeys.clear();
        clearAllPendingWakeLeases();
        wakeConfigUpdatedKeys.clear();
        markReadCalledKeys.clear();
        wakeConfigMissCount.clear();
        social.paused = false;
        /* 【2026-09-16】原来这里写 `{ conversations: {} }` 把状态文件清空——那等于把刚保下来的
         * 「已回复账本」又在磁盘上抹掉一次（桥一重启，"已回过哪些 id / 交付水位"就全没了，
         * 重复回复 bug 换个姿势复发）。改成落盘当前内存状态：会话上下文同样清空，
         * 但账本字段跟着写下去；`social.paused=false` 也一并落盘。 */
        try { saveSocialState(); } catch (error) { log('重置default状态：写状态文件失败:', error?.message ?? error); }
        log(`控制台：default AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留；${keysWithCarriedLedger.length} 个会话的已回复账本已保留）`);
        sendJson({ ok: true, keptLedgerKeys: keysWithCarriedLedger.length });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/social/state') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('socialState')) { sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return; }
        const st = getSocialState(key);
        sendJson({
          ok: true,
          key,
          wakeConfig: st.wakeConfig,
          wakeSafety: computeWakeSafety(st.wakeConfig),
          unreadCount: st.unread.length,
          recentCount: st.recentMessages.length,
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/social/global-overview') {
        // 全局互通：列出所有会话的动态一览（只读）。控制台 token 或受信任发起者（主人/好友）的 agent token 可用。
        const agentTokenG = String(req.headers['x-agent-token'] ?? '').trim();
        if (agentTokenG && !ToolEnabled('globalOverview')) { sendJson({ ok: false, error: '工具未启用：qq_global_overview' }, 403); return; }
        if (agentTokenG) {
          let trustedG = false;
          for (const [ck, cst] of social.conversations.entries()) {
            if (cst && cst.agentToken && agentTokenG === cst.agentToken) {
              const m = /^private:(\d+)$/.exec(ck);
              if (m && (m[1] === String(cfgRef.ownerQQ) || (Array.isArray(cfgRef.social?.trustedCrossSessionUids) && cfgRef.social.trustedCrossSessionUids.map(String).includes(m[1])))) trustedG = true;
              break;
            }
          }
          if (!trustedG) { sendJson({ ok: false, error: 'agent token 无全局查看权限' }, 403); return; }
        }
        const overview = [];
        for (const [k, cst] of social.conversations.entries()) {
          if (!cst) continue;
          const last = Array.isArray(cst.recentMessages) && cst.recentMessages.length ? cst.recentMessages[cst.recentMessages.length - 1] : null;
          const gid = k.startsWith('group:') ? k.split(':')[1] : '';
          overview.push({
            key: k,
            groupName: gid ? (getGroupDisplayName(gid) || undefined) : undefined,
            unread: Array.isArray(cst.unread) ? cst.unread.length : 0,
            lastSender: last ? (last.isSelf ? '我' : (last.isOwner ? '管理员' : (last.sender || '?'))) : null,
            lastText: last ? String(last.text || last.plain || '').slice(0, 60) : null,
            lastTime: last ? (Number(last.time) || 0) : 0,
            lastAiReplyAt: cst.lastAiReplyAt || 0,
            wakeMode: cst.wakeConfig?.mode ?? 'unknown'
          });
        }
        overview.sort((a, b) => b.lastTime - a.lastTime);
        sendJson({ ok: true, overview });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/social/prompt') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return; }
        const st = getSocialState(key);
        // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
        if (cfgRef.social?.sticker?.enabled !== false) {
          try { await syncStickerLibrary(false); } catch {}
        }
        const roleState = readRoleState();
        const toolMap = {
          getPrompt: 'qq_get_prompt',
          getUnread: 'qq_get_unread_messages',
          getRecent: 'qq_get_recent_messages',
          socialState: 'qq_social_state',
          sendGroup: 'qq_send_group_message',
          sendPrivate: 'qq_send_private_message',
          reply: 'qq_reply',
          sendBurst: 'qq_send_burst',
          sendMessage: 'qq_send_message',
          waitMessages: 'qq_wait_for_messages',
          feedback: 'qq_report_feedback',
          getMyRecent: 'qq_get_my_recent_messages',
          getMessageDetail: 'qq_get_message_detail',
          getActiveMembers: 'qq_get_active_members',
          setWakeConfig: 'qq_set_wake_config',
          markRead: 'qq_mark_read',
          memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
          slangQuery: 'qq_slang_query',
          slangSubmit: 'qq_slang_submit',
          getImages: 'qq_get_message_images',
          getForwardMsg: 'qq_get_forward_msg',
          sendPoke: 'qq_send_poke',
          like: 'qq_like',
          proactiveSend: 'qq_proactive_send',
          listStickers: 'qq_list_stickers',
          getStickerImage: 'qq_get_sticker_image',
          sendSticker: 'qq_send_sticker',
          setStickerRemark: 'qq_set_sticker_remark',
          stickerNote: 'qq_sticker_note',
          collectSticker: 'qq_collect_sticker',
          getSelfImage: 'qq_get_self_image',
          memeSearch: 'qq_meme_search',
          sendMeme: 'qq_send_meme'
        };
        const tools = cfgRef.social?.tools ?? {};
        const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
        const memeToolFlags = new Set(['memeSearch', 'sendMeme']);
        const enabledTools = [];
        for (const [flag, name] of Object.entries(toolMap)) {
          if (tools[flag] === false) continue;
          if (stickerToolFlags.has(flag) && !stickerEnabled()) continue;
          if (memeToolFlags.has(flag) && !memeEnabled()) continue;
          enabledTools.push(name);
        }
        sendJson({
          ok: true,
          key,
          time: new Date().toISOString(),
          role: { name: roleState.role ?? null, hint: currentRoleHint2() }, // 单默认模式：角色提示（过滤一代指令行）
          recommended: cfgRef.social?.provideRecommendations === false ? null : {
            wake: cfgRef.social?.wake ?? {},
            send: cfgRef.social?.send ?? {},
            wait: cfgRef.social?.wait ?? {},
            proactive: cfgRef.social?.proactive ?? {}
          },
          enabledTools,
          unreadCount: st.unread.length,
          recentCount: st.recentMessages.length,
          currentWakeConfig: st.wakeConfig,
          wakeSafety: computeWakeSafety(st.wakeConfig),
          memory: formatMemory(st),
          participation: formatParticipation(st),
          slang: {
            enabled: cfgRef.slang?.enabled !== false,
            entries: confirmedSlangList(),
            block: buildSlangContext(slangEntries, cfgRef.slang?.injectMax ?? 8)
          },
          stickers: {
            enabled: cfgRef.social?.sticker?.enabled !== false,
            total: stickerEntries.length,
            context: cfgRef.social?.sticker?.includeInPrompt !== false ? buildStickerContext(stickerEntries, cfgRef.social?.sticker?.promptMaxStickers ?? 8) : '',
            strategy: cfgRef.social?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint(cfgRef.social?.sticker?.sendProbability) : ''
          }
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/social/unread') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('getUnread')) { sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return; }
        const st = getSocialState(key);
        let unreadMsgs = Array.isArray(st.unread) ? st.unread.slice(-limit) : [];
        if (!unreadMsgs.length) {
          // 内存未读为空（重启/会话重建）：回退 SQLite read_at=0 的未读记录（仅晚于最近已读水位）
          unreadMsgs = fetchUnreadChatMessages(key, limit, Number(st.lastAiSeenAt) || 0);
        }
        sendJson({ ok: true, key, unreadCount: unreadMsgs.length, messages: unreadMsgs.map(withTimeText) });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/social/recent') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('getRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return; }
        const st = getSocialState(key);
        const start = Math.max(0, st.recentMessages.length - offset - limit);
        const end = Math.max(0, st.recentMessages.length - offset);
        let msgs = end > 0 ? st.recentMessages.slice(start, end) : [];
        if (!msgs.length && st.recentMessages.length === 0) {
          // 内存滚动窗口为空（重启/超出窗口）：回退 SQLite chat_messages 完整历史（新→旧）
          const dbRes = searchChatMessages({ convKey: key, limit, offset });
          msgs = (dbRes.ok ? dbRes.messages : []).reverse().map((m) => ({
            seq: m.seq, messageId: m.messageId, isSelf: m.isSelf,
            sender: m.senderName || m.senderUid || '',
            userId: (m.senderUid && m.senderUid !== 'self') ? m.senderUid : null,
            time: m.tsMs || 0, text: m.content, kind: m.kind || 'text', media: [],
            quoteTarget: m.quoteTarget || '',
            recalled: !!m.recalled   // 撤回标记透传：与内存 recentMessages / recentChatMessages 形状对齐
          }));
        }
        sendJson({ ok: true, key, messages: msgs.map(withTimeText) });
        return;
      }
      // ── turn-hold（回合保持）───────────────────────────────────────────────
      // 由隔离 DSH 里的 dsh-qq-hold 插件在 agent/turn-stopping 钩子内部调用：
      // 桥在这里决定"继续吊住这个回合"还是"放行关闭"；要继续时由**桥自己**走 mode:steer
      // 把新消息塞进 next-step（复用既有的、已实跑验证过的 steerIntoRunningTurn），插件只等这个响应。
      // 本机 127.0.0.1 专用，不需要 agent token（插件手里没有令牌）。
      // 未启用（social.turnHold.enabled !== true）时立刻返回 close=true，零副作用。
      if (req.method === 'POST' && url.pathname === '/api/qq/turn-hold') {
        const body = await readBody();
        const sessionId = String(body.sessionId ?? '').trim();
        const turn = Number(body.turn) || 0;
        if (!sessionId) { sendJson({ ok: false, error: 'sessionId 不能为空' }, 400); return; }
        let clientGone = false;
        req.on('close', () => { clientGone = true; });
        try {
          const out = await handleTurnHold({ sessionId, turn, cfg: cfgRef, shouldAbort: () => clientGone });
          // 一次性证据：只要这行出现，就说明「DSH 回合走到 turn-stopping → 插件 → 桥」整条链路是通的。
          // 之后再出现非 disabled 的原因（真参与保持）也各记一行。
          if (!globalThis.__holdRouteLogged) {
            globalThis.__holdRouteLogged = true;
            log(`[hold] turn-hold 路由收到第一次调用（reason=${out.reason}）—— 插件→桥链路已通`);
          } else if (out.reason !== 'disabled') {
            log(`[hold] turn-hold 路由：close=${out.close} reason=${out.reason} exchanges=${out.exchanges ?? 0}`);
          }
          /* 【2026-09-22 修 M6】turn-hold 的 holdLoop 返回里带 `again`（"这一段预算用完了、但回合该继续持有"），
           * 插件（plugins/dsh-qq-hold）读的就是 out.again —— 这里以前没把它透出去，插件拿到 undefined 就 break，
           * 于是 idleCloseMs=1800s / maxWaitMs=1h 形同虚设：回合每段最多 requestBudgetMs（默认 55s）就结束，
           * 后续消息只能退回下一次唤醒，插件日志还谎报 steered。现在原样透传。 */
          sendJson({ ok: true, close: out.close === true, again: out.again === true, reason: out.reason, exchanges: out.exchanges ?? 0 });
        } catch (error) {
          log(`[hold] turn-hold 处理异常：${error?.message ?? error}`);
          try { sendJson({ ok: false, close: true, error: String(error?.message ?? error) }, 500); } catch (_) {}
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/mark-read') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('markRead')) { sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return; }
        const st = getSocialState(key);
        // mark_read 是“本轮已看过、收尾”的常规动作，不设置任何潜水配置（只清已读 + 保留可唤醒条件），
        // 因此不受“沉睡前观察”闸门约束——否则无新内容可回、想安静收尾时会被拒，
        // 模型无法关回合 → 反复“标记已读失败”、无谓重复唤醒。
        // 想真正进入潜水沉睡请用 qq_set_wake_config（该路径保留 5 分钟睡前观察闸）。
        // 只清掉“本轮唤醒已展示给 AI”的未读：AI 回合进行中才新到达、从未展示过的消息
        // （seq 晚于本轮 turnSeenUnread 快照）保留在 unread，供回合结束时的补发逻辑再次唤醒，
        // 避免“对方连发多条、AI 只回最新一条，其余被静默吞掉”。无快照（控制台直接标记等）仍全清。
        const isAgentMarkRead = !!String(req.headers['x-agent-token'] ?? '').trim();
        const snapSeqs = (Array.isArray(st.turnSeenUnread) ? st.turnSeenUnread : []).map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);
        const snapMax = isAgentMarkRead && snapSeqs.length ? Math.max(...snapSeqs) : 0;
        let markedCount = st.unread.length;
        if (snapMax > 0 && Array.isArray(st.unread)) {
          const keptUnread = st.unread.filter((m) => m && Number(m.seq) > snapMax);
          markedCount = st.unread.length - keptUnread.length;
          st.unread = keptUnread;
          if (keptUnread.length > 0) log(`[default] mark_read 保留回合中新到未读 ${key}：${keptUnread.length} 条（等待补发唤醒，避免吞消息）`);
        } else {
          // 【2026-09-12 防吞兜底】没有任何"本轮已展示"水位时以前是**无脑全清** —— 那正是吞消息的窗口
          // （§2026-09-11 20:03:46 那次吞「笨蛋」就是这一类：回合不是由唤醒正文开起来的，
          //  turnSeenUnread 为空 → mark_read 把回合中途到的消息一起清掉）。
          // 现在至少保住"被注入周期闸明确推迟过"的那几条（wake-send.js 的周期闸写 _steerDeferredSeqs）：
          // 它们已被判定为"该由下一个周期交付"，绝不能被一次 mark_read 吞掉。
          const deferred = new Set((Array.isArray(st._steerDeferredSeqs) ? st._steerDeferredSeqs : []).map(Number));
          const kept = deferred.size
            ? (Array.isArray(st.unread) ? st.unread : []).filter((m) => m && deferred.has(Number(m.seq)))
            : [];
          markedCount = (Array.isArray(st.unread) ? st.unread.length : 0) - kept.length;
          st.unread = kept;
          if (kept.length) log(`[default] mark_read 无展示水位但保留了 ${kept.length} 条"被推迟交付"的未读 ${key}（防吞）`);
        }
        st.lastActionAt = Date.now();
        st.lastAiSeenAt = Date.now(); // AI 明确看过（本轮展示的）消息并收尾：之后这些消息不再算“被吞”
        st.wakeConfig.noActionCount = 0;
        // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
        if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
          st.wakeConfig.infinite = true;
        }
        ensureWakeable(st, { key });
        st.wakeConfig.confirmedAt = Date.now();
        st.wakeConfig.confirmedBy = 'mark_read';
        markReadCalledKeys.add(key);
        // 已读同步落库：SQLite chat_messages.read_at（重启后可据此恢复未读队列，避免重复补发/丢未读）
        try {
          const dbMark = markMessagesRead(key, isAgentMarkRead && snapMax > 0 ? snapMax : 0);
          if (dbMark.ok && dbMark.updated > 0) log(`[chat-history] mark_read 落库 ${key}: ${dbMark.updated} 条`);
        } catch (eDb) {
          log(`[chat-history] mark_read 落库失败: ${eDb?.message ?? eDb}`);
        }
        cancelReplyCheck(key); // 已收尾：取消回复检查兜底，避免 45s 后又唤醒导致重复回复
        saveSocialState();
        log(`[default] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
        // 【2026-09-12 省额度】这条响应会**永久留在模型上下文里**（每次 mark_read 都读一遍，之后每一步都重发）。
        // 实测：单次 1376 字符 × 20 次 = 27.5k 字符，其中 `wakeSafety` 明细与整个 `wakeConfig` 对象纯属噪音
        // （模型只需要知道"唤醒是否可靠"这一个布尔）。现在只回必要字段，不安全时才补一句该怎么办。
        const ws = computeWakeSafety(st.wakeConfig);
        sendJson(ws.guaranteed
          ? { ok: true, key, markedCount, wakeGuaranteed: true }
          : { ok: true, key, markedCount, wakeGuaranteed: false, note: '唤醒不可靠（可能收不到新消息）→ 用 qq_set_wake_config 重设唤醒条件' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/wake-config') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return; }
        const st = getSocialState(key);
        const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
        const current = st.wakeConfig;
        const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
        const normalizeTriggerBool = (name, fallback) => {
          if (name in inputTriggers) return inputTriggers[name] === true;
          return fallback;
        };
        const rawKeywords = inputTriggers.keywords;
        const nextKeywords = rawKeywords !== undefined
          ? (Array.isArray(rawKeywords)
              ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
              : [])
          : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
        const next = {
          ...current,
          mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
          infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
          sleepUntil: current.sleepUntil,
          triggers: {
            ...current.triggers,
            ...inputTriggers,
            atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
            nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
            question: normalizeTriggerBool('question', current.triggers.question === true),
            anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
            poke: normalizeTriggerBool('poke', current.triggers.poke === true),
            keywords: nextKeywords
          },
          batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
            ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
            : current.batchWindowMs
        };
        // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
        if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
          next.triggers.anyMessage = false;
        }
        if (next.mode === 'active') {
          next.infinite = true;
          next.sleepUntil = null;
          next.triggers.anyMessage = true;
          /* 【2026-09-15 修「活跃 = 潜水」】以前只强制 anyMessage，概率还是潜水那套 0.05，
           * 于是"转活跃"之后实际是"每 20 条消息才随机醒一次"，主人一眼看出它和潜水没区别。
           * 现在：没显式给 probability 时用专用的活跃概率（social.wake.activeProbability，默认 0.3）。 */
          if (!('probability' in inputTriggers)) {
            const activeProb = Number(cfgRef.social?.wake?.activeProbability);
            next.triggers.probability = Number.isFinite(activeProb) && activeProb > 0
              ? Math.min(1, activeProb)
              : Math.max(Number(current.triggers?.probability) || 0, 0.3);
          }
        }
        if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
        if (next.infinite) {
          next.sleepUntil = null;
        } else if (input.sleepUntil) {
          const d = new Date(String(input.sleepUntil));
          if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
        } else if (Number.isFinite(Number(input.sleepMs))) {
          let ms = Math.max(0, Math.round(Number(input.sleepMs)));
          const minMs = Math.max(0, Number(cfgRef.social?.wake?.sleepMinMs) || 0);
          const maxMs = Number(cfgRef.social?.wake?.sleepMaxMs) || 0;
          if (ms < minMs) ms = minMs;
          if (maxMs > 0 && ms > maxMs) ms = maxMs;
          next.sleepUntil = new Date(Date.now() + ms).toISOString();
        } else if (!next.sleepUntil && !next.infinite) {
          // 既没有无限也没有时间：使用推荐默认有限时长
          const recMin = Number(cfgRef.social?.wake?.recommendedSleepMinMs) || 300000;
          const recMax = Number(cfgRef.social?.wake?.recommendedSleepMaxMs) || 7200000;
          const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
          next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
        }
        // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
        if (!next.infinite && next.sleepUntil) {
          const maxMs = Number(cfgRef.social?.wake?.sleepMaxMs) || 0;
          const minMs = Math.max(0, Number(cfgRef.social?.wake?.sleepMinMs) || 0);
          let until = Date.parse(next.sleepUntil);
          if (Number.isFinite(until)) {
            if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
            if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
            next.sleepUntil = new Date(until).toISOString();
          }
        }
        // 归一化概率
        if (next.triggers.probability !== undefined) {
          next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
        }
        /* 【2026-09-19 修「主人在界面上改插话概率没用」】记下这个值是谁定的：
         *   · 模型显式传了 triggers.probability → source=model（它看着语境定的，保留）；
         *   · 没传、由桥按主人配置填的 → source=owner（主人改配置时**立刻**跟着变，见 core/social-state.js 的
         *     applyOwnerWakeProbabilityToSessions）。
         * 以前没有这个来源标记，session 一律照抄旧值，于是"改了概率永远不生效"。 */
        const explicitProb = !!(input.triggers && typeof input.triggers === 'object' && 'probability' in input.triggers);
        next.triggers.probabilitySource = explicitProb
          ? 'model'
          : (current.triggers?.probabilitySource === 'model' ? 'model' : 'owner');
        // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
        if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
          next.triggers.poke = input.triggers.poke === true;
        }
        // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
        // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
        next.triggers.speakerIds = normalizeSpeakerIds(next.triggers.speakerIds);
        // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
        if (key.startsWith('private:')) {
          next.triggers.speakerIds = [];
        }
        // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
        if (next.infinite) {
          const tr = next.triggers ?? {};
          const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
          if (!hasTrigger) {
            sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
            return;
          }
        }
        // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
        if (isSleepingConfig(next) && preSleepWaitBlocked(st)) {
          const preSleepMs = Math.max(0, Number(cfgRef.social?.wake?.preSleepWaitMs) || 300000);
          const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
          const remainMin = Math.ceil(remaining / 60000);
          sendJson({
            ok: false,
            error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
            preSleepWaitMs: preSleepMs,
            preSleepWaitRemainingMs: remaining
          }, 400);
          return;
        }
        st.wakeConfig = next;
        st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
        st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
        st.wakeConfig.noActionCount = 0;
        st.wakeConfig.confirmedAt = Date.now();
        st.wakeConfig.confirmedBy = 'set_wake_config';
        // 单一语义源: 会话一旦进入“全活跃”(mode=active / anyMessage=on), 旧活跃时段约束即失效。
        // 自然语言“转活跃/全天在线”由模型调本工具(或 /set mode active 由桥侧同样置 active), 都走这里清时段,
        // 避免出现“明明转活跃了, 提示词里却还写着窗外要潜水睡到下一时段”的两套机制打架。
        if (next.mode === 'active' || next.triggers?.anyMessage === true) {
          if (activityWindows[key]) {
            delete activityWindows[key];
            saveActivityWindows();
            log(`[default] ${key} 进入全活跃, 已清除其活跃时段约束`);
          }
        }
        st.lastActionAt = Date.now();
        st.lastAiSeenAt = Date.now(); // AI 设置潜水/收尾 = 看过当前所有消息，不再算“被吞”
        // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
        st.preSleepWaitSatisfiedAt = 0;
        st.preSleepWaitObservedAt = 0;
        st.preSleepWaitAccumMs = 0;
        saveSocialState();
        wakeConfigUpdatedKeys.add(key);
        cancelReplyCheck(key); // 已设置下一次唤醒条件（收尾完成）：取消回复检查兜底，避免重复唤醒
        wakeConfigMissCount.delete(key);
        if (st.pendingWakeTimer) {
          clearTimeout(st.pendingWakeTimer);
          st.pendingWakeTimer = null;
        }
        st.pendingWakeTimerStartedAt = 0;
        cancelReplyCheck(key); // AI 已主动设置新的唤醒配置，取消回复检查
        setupSleepTimer(key);
        log(`[default] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
        sendJson({ ok: true, key, wakeConfig: next, wakeSafety: computeWakeSafety(next) });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/social/states') {
        const list = [];
        for (const [key, st] of social.conversations) {
          list.push({
            key,
            wakeConfig: st.wakeConfig,
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt,
            noActionCount: st.wakeConfig.noActionCount || 0
          });
        }
        sendJson({ ok: true, conversations: list });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/wake') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const reason = String(body.reason ?? 'admin').trim() || 'admin';
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        const keyMatch = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        const kind = keyMatch[1];
        const id = Number(keyMatch[2]);
        if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfgRef, currentMode)) {
          sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
          return;
        }
        const st = getSocialState(key);
        if (st.pendingWakeTimer) {
          clearTimeout(st.pendingWakeTimer);
          st.pendingWakeTimer = null;
        }
        st.pendingWakeTimerStartedAt = 0;
        if (!st.bootstrapSent) st.bootstrapSent = true;
        saveSocialState();
        sendWakePrompt(key, reason);
        log(`控制台：手动唤醒 ${key}（${reason}）`);
        sendJson({ ok: true, key, reason });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/send-burst') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        let rawMessages = body.messages;
        // 兼容模型误用单数 message / msg / text 字段（见 send-message 同款注释），避免换参重试撞重复拦截。
        if (rawMessages === undefined || rawMessages === null || (Array.isArray(rawMessages) && rawMessages.length === 0)) {
          if (typeof body.message === 'string' && body.message.trim()) rawMessages = body.message;
          else if (typeof body.msg === 'string' && body.msg.trim()) rawMessages = body.msg;
          else if (typeof body.text === 'string' && body.text.trim()) rawMessages = body.text;
          else if (Array.isArray(body.message) && body.message.length) rawMessages = body.message;
        }
        if (typeof rawMessages === 'string') {
          const trimmed = rawMessages.trim();
          if (trimmed.startsWith('[')) {
            try {
              const parsed = JSON.parse(trimmed);
              if (Array.isArray(parsed)) rawMessages = parsed.map(String);
            } catch {}
          } else if (trimmed.startsWith('"')) {
            // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
            try {
              const parsed = JSON.parse(trimmed);
              if (typeof parsed === 'string') rawMessages = parsed;
              else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
            } catch {}
          }
        }
        const messages = Array.isArray(rawMessages)
          ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
          : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
        const replyToMessageId = body.replyToMessageId;
        if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
          sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
          return;
        }
        // 本端点只发文本（sendMessages 只传 key/messages/delays），没有 images 入参；
        // 原写法引用未声明的 images → 一旦 messages 为空就抛 ReferenceError（500 images is not defined）。
        if (!key || !messages.length) {
          sendJson({ ok: false, error: 'key、messages 不能为空' }, 400);
          return;
        }
        const sendCfgBurst = cfgRef.social?.send ?? {};
        if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
          sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
          return;
        }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('sendBurst')) { sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return; }
        if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'default 模式发送必须携带 agent token' }, 403); return; }
        const keyMatch = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatch) {
          sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
          return;
        }
        const kind = keyMatch[1];
        const id = Number(keyMatch[2]);
        if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfgRef, currentMode)) {
          sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
          return;
        }
        if (shouldBlockSilentReply(key)) {
          sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
          return;
        }
        const sendCfg = cfgRef.social?.send ?? {};
        const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
        const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
        if (messages.length > maxMsgs) {
          sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
          return;
        }
        for (const msg of messages) {
          if (msg.length > maxChars) {
            sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
            return;
          }
          if (SENSITIVE_RE.test(msg)) {
            sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
            return;
          }
        }
        // st/now 必须声明在 try 之外：catch 里的发送额度回滚块要用到它们，
        // 若声明在 try 内，失败分支会先抛 ReferenceError，预占的额度永远不会回滚（假 429）。
        const st = getSocialState(key);
        const now = Date.now();
        try {
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          // 先预占发送额度，避免并发绕过限频
          for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          const delays = computeGaps(messages, 'byLength', undefined, undefined, sendCfg);
          const sentMessages = await sendMessages(key, messages, delays);
          recordSentMessages(key, sentMessages);
          st.lastAiReplyAt = now;
          st.lastActionAt = now;
          st.wakeConfig.noActionCount = 0;
          saveSocialState();
          log(`[default] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
          appendActivity(`${key} [default] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
          if (sentMessages.length > 0) scheduleReplyCheck(key);
          const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
          // 软提醒（lint）必须与发送结果隔离：消息已成功发出，lint 任何异常都不能把 ok 改写成失败，
          // 否则模型看到"发送失败"会换参数重发 → 撞重复拦截 → 主人其实已收到一条。
          let spaceWarn;
          let splitWarn;
          try {
            spaceWarn = findCjkSpaceWarning(messages);
            splitWarn = findSplitBoundaryWarning(messages);
          } catch (eLint) {
            log(`[send] 发送后质量软提醒异常（不影响发送结果）: ${eLint?.message ?? eLint}`);
          }
          sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
        } catch (error) {
          if (error?.sent?.length) {
            recordSentMessages(key, error.sent);
            log(`[default] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
          }
          log('[send] 统一发送失败栈:', error?.stack ? error.stack.split(String.fromCharCode(10)).slice(0, 8).join(' | ') : (error?.message || String(error)));
          // 失败/未发出的消息回滚预占的发送额度，避免假 429。
          const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
          const failedCount = Math.max(0, messages.length - sentCount);
          for (let i = 0; i < failedCount; i++) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
          }
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          saveSocialState();
          sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/send-message') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        let rawMessages = body.messages;
        // 兼容模型误用单数 message / msg / text 字段（schema 名叫 messages，模型偶发记错参数名，
        // 若直接报"至少一个不能为空"会让模型陷入"换参数名反复重试"的循环，撞上重复拦截）。
        if (rawMessages === undefined || rawMessages === null || (Array.isArray(rawMessages) && rawMessages.length === 0)) {
          if (typeof body.message === 'string' && body.message.trim()) rawMessages = body.message;
          else if (typeof body.msg === 'string' && body.msg.trim()) rawMessages = body.msg;
          else if (typeof body.text === 'string' && body.text.trim()) rawMessages = body.text;
          else if (Array.isArray(body.message) && body.message.length) rawMessages = body.message;
        }
        if (typeof rawMessages === 'string') {
          const trimmed = rawMessages.trim();
          /* 【2026-09-20 主人实测：整串数组被当成一条消息发了出去】
           * 现场：messages 被模型整体序列化成一个字符串，且内部引号嵌套
           *   ["直接跟我说就行", "比如"谬友圈活跃19点到23点"", "我帮你设 ᗜ ‸ ᗜ"]
           * → JSON.parse 失败 → 旧代码把整串当"一条消息"原样发进 QQ。
           * 现在：能还原就还原成多条气泡（strict JSON 或容错切分，见 lib/text-safe.js）；
           * 形状对但内容真的切不出来（≥2 段引号都找不到）→ 直接 400 硬失败，
           * 让模型用真正的 JSON 数组重传，绝不把数组语法发进 QQ。 */
          if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            const splitBubbles = splitSerializedBubbles(trimmed);
            if (splitBubbles && splitBubbles.length) {
              rawMessages = splitBubbles;
              log(`[send] 正文是被序列化的气泡数组 → 已还原成 ${splitBubbles.length} 条气泡（${key}）`);
              appendActivity(`${key} [send] 正文是序列化数组，已还原 ${splitBubbles.length} 条气泡`);
            } else if (looksLikeSerializedBubbleArray(trimmed) || (trimmed.startsWith('[') && trimmed.endsWith(']') && trimmed.length > 2 && /["'\u201c\u201d]\s*,\s*["'\u201c\u201d]/.test(trimmed))) {
              log(`[send] 正文是"被序列化的气泡数组"形状但切不出气泡，已拒发（硬失败）: ${trimmed.slice(0, 80)}`);
              sendJson({ ok: false, error: '这条正文整体是一个被序列化的气泡数组（形如 ["a","b"]），它是工具参数的容器、不是消息内容，已拒发。多条气泡请把真正的 JSON 数组传给 messages（如 messages=["第一句","第二句"]），不要把数组写进字符串；确实要发 JSON/代码本身就用 ``` 代码块包起来。' }, 400);
              return;
            }
          } else if (trimmed.startsWith('"')) {
            // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
            try {
              const parsed = JSON.parse(trimmed);
              if (typeof parsed === 'string') rawMessages = parsed;
              else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
            } catch {}
          }
        }
        const isRawString = typeof rawMessages === 'string';
        const messages = Array.isArray(rawMessages)
          ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
          : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
        const replyToMessageId = body.replyToMessageId;
        const atUserId = body.atUserId ?? null;
        const images = Array.isArray(body.images) ? body.images.map(String).filter(Boolean) : [];
        // default不再按空格自动分条：字符串就是一条消息；数组模式原样使用调用方间隔。
        const gapMode = (isRawString && messages.length > 1) ? 'byLength' : (body.gapMode === 'fixed' || body.gapMode === 'byLength' ? body.gapMode : 'byLength');
        const gapMs = Number(body.gapMs);
        const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
        if (!key || (!messages.length && !images.length)) {
          /* 【2026-09-20 线上实测：模型漏引号 → 整条消息发不出去】
           * 现场（state/tool-calls.jsonl）：
           *   12:42:32  args = {"key":"private:1","messages": 主人这么直接啊 我脸都热了, "token":"1"}  → ok:false
           *   12:42:34  同上再试一次                                                              → ok:false
           *   12:42:35  {"key":"private:1","token":"1","messages":"主人这么直接啊 我脸都热了"}      → ok:true
           * 字符串值忘了包引号 → 根本不是合法 JSON → DSH 的宽松解析把这一项丢掉 → 到这里 messages 为空，
           * 模型只看到"至少一个不能为空"，只能原样重试（白烧两步 ≈ 1.4 分）。所以这里把**最可能的原因
           * 和确切写法**回执给它，一次就能改对（工具层会把这段原文返回给模型）。
           * 注意：JSON 只认双引号 —— 单引号不是 JSON，换单引号只会更早失败。 */
          const hint = key
            ? '（多半是参数不是合法 JSON：字符串值必须用**双引号**包起来，例如 {"key":"private:1","messages":"你好","token":"…"}；裸文本或单引号都不算 JSON，那一段会被丢弃）'
            : '';
          sendJson({ ok: false, error: `key、messages、images 至少一个不能为空${hint}` }, 400);
          return;
        }
        const sendCfgBurst = cfgRef.social?.send ?? {};
        if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
          sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
          return;
        }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        /* 【2026-09-20 防「发错群」】令牌属于哪个会话 = 调用方会话；目标 key 却是另一个会话时，
         * 这要么是**有意跨会话转达**，要么是**模型抄错了 key**——桥分不出来，所以要求显式声明。 */
        { const refuse = crossSessionRefusal(req.headers['x-agent-token'], key, body.crossSession); if (refuse) { sendJson({ ok: false, error: refuse }, 403); return; } }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return; }
        if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'default 模式发送必须携带 agent token' }, 403); return; }
        const keyMatch = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        const kind = keyMatch[1];
        const id = Number(keyMatch[2]);
        if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfgRef, currentMode)) {
          sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
          return;
        }
        if (kind === 'private' && atUserId) {
          sendJson({ ok: false, error: '私聊不需要 @' }, 400);
          return;
        }
        if (shouldBlockSilentReply(key)) {
          sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
          return;
        }
        if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
          sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
          return;
        }
        const sendCfg = cfgRef.social?.send ?? {};
        const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
        const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
        if (messages.length > maxMsgs) {
          sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
          return;
        }
        for (const msg of messages) {
          if (msg.length > maxChars) {
            sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
            return;
          }
          if (SENSITIVE_RE.test(msg)) {
            sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
            return;
          }
        }
        /* 【2026-09-16 幂等闸门 · 修「reset 之后同一条回复发了两遍」】
         * 现场：14:12:34 整批 ["喵什么喵","又不是猫娘"] 因为 atUserId 传错只成功 1 条
         * （「又不是猫娘」14:12:36 真的进群了，messageId 1275818397），工具返回 ok:false；
         * 模型于是把整批重发 → 14:12:49/50「又不是猫娘」第二次进群。
         * 这里在**发送之前**把"上一批已经真的投递成功"的气泡摘掉：只补发失败的那几条，
         * 正常新回复（上一批是成功的）不经过这条路，不会被误杀。见 send-idempotency.js。 */
        // ⚠️ 这里**不能**用本段稍后才声明的 `now`（`const now = Date.now()` 在 computeGaps 之后）：
        // 写成 `..., now)` 会在发送端点里直接 TDZ `ReferenceError`。判重窗口是分钟级，两处时钟差几毫秒无所谓。
        const idem = filterAlreadySentBubbles(key, messages, Date.now());
        if (idem.skipped.length) {
          logIdempotencyBlock(key, idem, '上一批发送部分失败，这是模型重发整批');
          appendActivity(`${key} [send] 幂等挡下重复气泡 ${idem.skipped.length} 条：${idem.skipped.map((s) => String(s.text).slice(0, 20)).join('、')}`);
          if (!idem.kept.length) {
            sendJson({
              ok: true, key, sent: 0, failed: 0, skipped: idem.skipped.length,
              note: '这些气泡上一批已经真的发出去了（那一批里失败的是别的条），本次不再重复发送；请直接收尾，不要重发。'
            });
            return;
          }
        }
        const sendList = idem.kept.map((x) => x.text);
        const delays = computeGaps(sendList, gapMode, gapMs, gaps, sendCfg);
        // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
        const st = getSocialState(key);
        const now = Date.now();
        // 防循环回复：① 90 秒内重复发送相同/高度相似文本 → 拦截；② 60 秒内发送调用 ≥3 次 → 拦截（疑似单回合循环连发）
        const firstSendText = Array.isArray(sendList) ? String(sendList[0] ?? '') : String(sendList ?? '');
        const prevSend = lastSendDedup.get(key);
        if (prevSend && now - prevSend.at < 90000 && firstSendText && isDuplicateSendText(prevSend.text, firstSendText)) {
          cancelReplyCheck(key);
          st.lastAiReplyAt = now;
          saveSocialState();
          sendJson({ ok: false, error: '检测到你在短时间内重复发送相同内容（疑似循环回复），已阻止本次发送并结束当前回合。请停止回复，直接调用 qq_set_wake_config 或 qq_mark_read 收尾。' }, 409);
          return;
        }
        const recentSendCalls = (sendCallTimes.get(key) || []).filter((t) => now - t < 60000);
        if (recentSendCalls.length >= 12) {
          cancelReplyCheck(key);
          st.lastAiReplyAt = now;
          saveSocialState();
          sendJson({ ok: false, error: '60 秒内发送调用过于频繁（疑似循环回复），已阻止本次发送并结束当前回合。请停止重复回复，直接调用 qq_set_wake_config 或 qq_mark_read 收尾。' }, 429);
          return;
        }
        const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
        const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
        const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
        const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
        if ((maxPerMinute > 0 && recentMinute + sendList.length > maxPerMinute) || (maxPerHour > 0 && recentHour + sendList.length > maxPerHour)) {
          sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
          return;
        }
        // 先预占发送额度，避免并发绕过限频
        for (let i = 0; i < sendList.length; i++) st.sendTimes.push(now);
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        let quotedInfo = null;
        let actualReplyToMessageId = replyToMessageId;
        if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
          const resolved = await resolveReplyTarget(st, kind, id, String(replyToMessageId).trim());
          if (!resolved) {
            // 引用解析失败：回滚已预占的发送额度
            for (let i = 0; i < sendList.length; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            saveSocialState();
            sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' + replyTargetHint(key) }, 400);
            return;
          }
          quotedInfo = resolved.info;
          actualReplyToMessageId = resolved.messageId;
        }
        /* 【2026-09-16 触发源拦截】atUserId 被传成 messageId 时**不要报错**（报错=整批部分失败=模型重发整批=双发），
         * 而是降级为"不带 @"照常发，并打一行明确日志 + 把这件事回执给模型，让它下一轮别再这么传。
         * 判据只有一条：这个值是否等于本会话近期真实出现过的 messageId（位数/量级在本机完全重叠，不能当判据，
         * 见 lib/at-target.js 顶部实测数据）。真 QQ 号（含短号）一律照常 @。 */
        const atJudge = judgeAtUserId(atUserId, collectAtUserIdEvidence(st));
        let atUserIdEffective = atUserId;
        let atNote = '';
        let atDropped = null;
        if (!atJudge.ok) {
          atUserIdEffective = null;
          logAtUserIdDowngrade(key, atJudge);
          atNote = atUserIdDowngradeNote(atJudge);
          atDropped = { atUserId: atJudge.id, reason: atJudge.reason };
          appendActivity(`${key} [send] atUserId=${atJudge.id} 降级为不带 @ 发送（${atJudge.reason}）`);
        }
        try {
          const sentMessages = await sendMessages(key, sendList, delays, actualReplyToMessageId, atUserIdEffective, images);
          recordSentMessages(key, sentMessages);
          // 整批成功 → 了结上一批的部分失败状态（此后不再做任何重发过滤，正常新回复畅通）。
          noteBatchOutcome(key, { attempted: sendList, delivered: sentMessages, failed: [] }, now);
          st.lastAiReplyAt = now;
          st.lastActionAt = now;
          st.wakeConfig.noActionCount = 0;
          saveSocialState();
          if (firstSendText) lastSendDedup.set(key, { text: firstSendText, at: now });
          const callNow = sendCallTimes.get(key) || [];
          callNow.push(now);
          sendCallTimes.set(key, callNow.filter((t) => now - t < 60000));
          log(`[default] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${sendList.length} 条`);
          appendActivity(`${key} [default] 工具统一发送：成功 ${sentMessages.length}/${sendList.length} 条`);
          if (sentMessages.length > 0) scheduleReplyCheck(key);
          const burstHint = sendList.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
          // 软提醒（lint）必须与发送结果隔离：消息已成功发出，lint 任何异常都不能把 ok 改写成失败，
          // 否则模型看到"发送失败"会换参数重发 → 撞重复拦截 → 主人其实已收到一条。
          let spaceWarn;
          let splitWarn;
          try {
            spaceWarn = findCjkSpaceWarning(sendList);
            splitWarn = findSplitBoundaryWarning(sendList);
          } catch (eLint) {
            log(`[send] 发送后质量软提醒异常（不影响发送结果）: ${eLint?.message ?? eLint}`);
          }
          /* 【2026-09-20 去掉自动引用后，这里不再需要 autoQuoted】以前桥会自己猜着加引用框，
           * 所以要把"我替你引用了哪条"报回模型；现在引用只可能来自模型显式传的 replyToMessageId，
           * 上方 `quoted` 就是那条（模型自己传的，它当然知道），再回一个 autoQuoted 只会白占字符。 */
          sendJson({
            ok: true, key, sent: sentMessages.length, failed: sendList.length - sentMessages.length, delays, quoted: quotedInfo,
            ...(idem.skipped.length ? { dedupSkipped: idem.skipped.length } : {}),
            ...(atDropped ? { atUserIdDropped: atDropped } : {}),
            // atNote 与 burstHint 共用 hint 字段：两个都有时合并，别让后者把 atUserId 的回执吞掉
            ...((atNote || burstHint) ? { hint: [atNote, burstHint].filter(Boolean).join(' ') } : {}),
            ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {})
          });
        } catch (error) {
          if (error?.sent?.length) {
            recordSentMessages(key, error.sent);
            log(`[default] 工具统一发送部分成功 ${error.sent.length}/${sendList.length} 条，已记录已发消息`);
          }
          /* 【2026-09-16】把"这一批里真的发出去了哪几条"记进幂等账本：模型看到 ok:false 后重发整批时，
           * 这些气泡会被挡下（只补发失败的那几条）。以前这里不记账，是「同一条回复进群两遍」的直接缺口：
           * 现场 14:12:36 部分成功 1/2 之后，14:12:47 整批重发把已经送到的那条又发了一次。 */
          const idemNote = noteBatchOutcome(key, {
            attempted: sendList,
            delivered: Array.isArray(error?.sent) ? error.sent : [],
            failed: [1]
          }, now);
          if (idemNote.delivered > 0) {
            log(`[send-idempotency] ${key} 部分失败：已把 ${idemNote.delivered} 条真的送到的气泡记进幂等账本`
              + `（本次失败 ${Math.max(0, sendList.length - idemNote.delivered)} 条）——模型重发整批时只补发没送到的，不再重复已送到的`);
          }
          log('[send] 统一发送失败栈:', error?.stack ? error.stack.split(String.fromCharCode(10)).slice(0, 8).join(' | ') : (error?.message || String(error)));
          // 失败/未发出的消息回滚预占的发送额度，避免假 429。
          const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
          const failedCount = Math.max(0, sendList.length - sentCount);
          for (let i = 0; i < failedCount; i++) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
          }
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          saveSocialState();
          sendJson({
            ok: false,
            error: (error?.message ?? String(error)) + (idemNote.delivered > 0 ? '（本次已送达的气泡已登记，重发时只会补发没送出去的那几条，请勿整批重发）' : ''),
            sent: sentCount
          }, 500);
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/send-poke') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'default 模式发送拍一拍必须携带 agent token' }, 403); return; }
        if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (!SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (!ToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return; }
  
    if (social.paused) { sendJson({ ok: false, error: 'default AI 已暂停，不能发送拍一拍' }, 403); return; }
        const keyMatch = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        const kind = keyMatch[1];
        const id = Number(keyMatch[2]);
        if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfgRef, currentMode)) {
          sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
          return;
        }
        if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return; }
        if (kind === 'group' && !targetUserId) {
          sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
          return;
        }
        if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
          sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
          return;
        }
        const st = getSocialState(key);
        const sendCfg = cfgRef.social?.send ?? {};
        const now = Date.now();
        const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
        const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
        const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
        const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
        if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
          sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
          return;
        }
        st.sendTimes.push(now);
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        try {
          if (kind === 'group') {
            await botRef.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
          } else {
            // 私聊拍一拍：send_poke 自动路由到当前私聊对象
            await botRef.raw('send_poke', { user_id: id });
          }
          st.lastActionAt = now;
          st.lastAiReplyAt = now;
          st.wakeConfig.noActionCount = 0;
          const pokeText = kind === 'group'
            ? `[拍一拍] 我拍了拍 ${targetUserId}`
            : '[拍一拍] 我拍了拍你';
          st.recentMessages.push({
            messageId: null,
            sender: '我',
            text: pokeText,
            plain: pokeText,
            tail: pokeText,
            kind: 'poke',
            quoteTargetIsSelf: false,
            isOwner: true,
            ownerLabel: '我',
            isSelf: true,
            media: [],
            hasMedia: false,
            forwardIds: [],
            hasForward: false,
            poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
            time: Date.now()
          });
          const recentLimit = Number(cfgRef.social?.context?.recentLimit) || 100;
          if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSocialState();
          log(`[default] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
          appendActivity(`${key} [default] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
          sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
        } catch (error) {
          const idx = st.sendTimes.indexOf(now);
          if (idx >= 0) st.sendTimes.splice(idx, 1);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          log(`[default] 工具拍一拍失败 ${key}:`, error?.message ?? error);
          sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      // ── 表情包体系（default） ──────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/social/sticker-image') {
        if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
        const key = String(url.searchParams.get('key') ?? '').trim();
        const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
        if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return; }
        try {
          const entry = await getStickerImageData(stickerId);
          const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
          const dims = getImageDimensions(fetched.buffer);
          if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
            sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
            return;
          }
          const fim = await finalizeImageBuffer(fetched.buffer, mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url));
          sendJson({
            ok: true,
            key,
            sticker: {
              id: entry.id,
              desc: entry.desc || '',
              localNote: entry.localNote || '',
              tags: entry.tags || [],
              url: entry.url,
              md5: entry.md5
            },
            image: { mimeType: fim.mimeType, data: fim.buffer.toString('base64') }
          });
        } catch (error) {
          sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/social/self-image') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('getSelfImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return; }
        const selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
        try {
          if (!fs.existsSync(selfPath)) { sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return; }
          const buf = fs.readFileSync(selfPath);
          const fim = await finalizeImageBuffer(buf, mimeFromBuffer(buf) || 'image/png');
          sendJson({ ok: true, key, image: { mimeType: fim.mimeType, data: fim.buffer.toString('base64') } });
        } catch (error) {
          sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      // ========== qq_like: 点赞工具 ==========
      if (req.method === 'POST' && url.pathname === '/api/social/like') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
        const times = Math.min(10, Math.max(1, Number(body.times) || 1));
        // default 模式工具必须携带有效会话令牌：原写法 `if (headers['x-agent-token'] && ...)`
        // 等于完全不校验令牌（不带头即放行），任意本机进程都能让机器人给任意 QQ 号点赞。
        const agentTokenL = String(req.headers['x-agent-token'] ?? '').trim();
        if (!agentTokenL) { sendJson({ ok: false, error: 'default 模式调用必须携带 agent token' }, 403); return; }
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (!agentTokenOk(key, agentTokenL)) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (!SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (!ToolEnabled('like')) { sendJson({ ok: false, error: '工具未启用：qq_like' }, 403); return; }
        if (!targetUserId || !/^[1-9]\d*$/.test(targetUserId)) { sendJson({ ok: false, error: 'targetUserId 不能为空且必须是正整数' }, 400); return; }
        try {
          const result = await botRef.raw('send_like', { user_id: Number(targetUserId), times });
          log(`[like] 点赞 ${targetUserId} x${times}`);
          sendJson({ ok: true, targetUserId, times, result: result?.status || 'ok' });
        } catch (error) {
          sendJson({ ok: false, error: `点赞失败：${error?.message ?? String(error)}` }, 500);
        }
        return;
      }
      // ========== qq_proactive_send: 主动发消息 ==========
      if (req.method === 'POST' && url.pathname === '/api/social/proactive-send') {
        const body = await readBody();
        const targetKey = String(body.key ?? '').trim();
        const message = String(body.message ?? '').trim();
        if (!targetKey || !message) { sendJson({ ok: false, error: '需要 key 和 message' }, 400); return; }
        const agentTokenP = String(req.headers['x-agent-token'] ?? '').trim();
        // default 模式发送必须携带有效会话令牌（与其余 7 个发送端点同口径）。
        // 原写法 `if (agentTokenP && ...)` 在不带头时把三项检查全跳过 → fail-open：
        // 任意本机进程可代 AI 向任意 group:/private: 会话发任意文本。
        if (!agentTokenP) { sendJson({ ok: false, error: 'default 模式发送必须携带 agent token' }, 403); return; }
        if (!agentTokenOk(targetKey, agentTokenP)) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (!ToolEnabled('proactiveSend')) { sendJson({ ok: false, error: '工具未启用：qq_proactive_send' }, 403); return; }
        const keyMatch = /^(group|private):(\d+)$/.exec(targetKey);
        if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        if (!SessionAllowed(targetKey)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (shouldBlockSilentReply(targetKey)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
        const sendCfgP = cfgRef.social?.send ?? {};
        const maxCharsP = Math.max(1, Number(sendCfgP.maxMessageChars) || 500);
        if (message.length > maxCharsP) { sendJson({ ok: false, error: `单条消息不能超过 ${maxCharsP} 字` }, 400); return; }
        if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
        // 发起者反查：用会话令牌定位发起会话，用于日志标注来源
        let senderLabel = '你的朋友';
        if (agentTokenP) {
          for (const [ck, cst] of social.conversations.entries()) {
            if (cst && cst.agentToken && agentTokenP === cst.agentToken) {
              const m = /^private:(\d+)$/.exec(ck);
              if (m) {
                const uid = m[1];
                if (uid === String(cfgRef.ownerQQ)) {
                  senderLabel = '主人';
                } else {
                  const nick = profileDisplayName(uid);
                  senderLabel = nick ? `${nick}（QQ:${uid}）` : `QQ:${uid}`;
                }
              }
              break;
            }
          }
        }
        // st/now 声明在 try 之外：catch 里的额度回滚要用到（勿重蹈本文件其他发送端点的覆辙）
        const stP = getSocialState(targetKey);
        const nowP = Date.now();
        const maxPerMinuteP = Number(sendCfgP.maxSendPerMinute) || 0;
        const maxPerHourP = Number(sendCfgP.maxSendPerHour) || 0;
        const recentMinuteP = (stP.sendTimes || []).filter((t) => nowP - t < 60000).length;
        const recentHourP = (stP.sendTimes || []).filter((t) => nowP - t < 3600000).length;
        if ((maxPerMinuteP > 0 && recentMinuteP + 1 > maxPerMinuteP) || (maxPerHourP > 0 && recentHourP + 1 > maxPerHourP)) {
          sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
          return;
        }
        // 先预占发送额度，避免并发绕过限频
        stP.sendTimes.push(nowP);
        if (stP.sendTimes.length > 500) stP.sendTimes = stP.sendTimes.slice(-500);
        try {
          // 直接发送到目标会话（不投递提示让目标会话的 AI 再发一次，避免两边双发）。
          // 转述/带话/主动冒泡都是固定内容，直接发出去即可；来源与上下文靠跨会话查询工具互通。
          const sent = await sendMessages(targetKey, [message], [], null, null);
          recordSentMessages(targetKey, sent);
          saveSocialState();
          log(`[proactive] ${senderLabel} -> ${targetKey}: ${message.slice(0, 30)}`);
          sendJson({ ok: true, key: targetKey, sent: true });
        } catch (error) {
          // 发送失败：回滚预占的发送额度，避免假 429
          const idxP = stP.sendTimes.indexOf(nowP);
          if (idxP >= 0) stP.sendTimes.splice(idxP, 1);
          if (stP.sendTimes.length > 500) stP.sendTimes = stP.sendTimes.slice(-500);
          saveSocialState();
          log(`[proactive] 发送失败 ${senderLabel} -> ${targetKey}: ${error?.message ?? String(error)}`);
          sendJson({ ok: false, error: `发送失败：${error?.message ?? String(error)}` }, 500);
        }
        return;
      }
      // ========== qq_schedule_message: 定时发消息 ==========
      if (req.method === 'POST' && url.pathname === '/api/social/schedule') {
        const body = await readBody();
        const targetKey = String(body.targetKey ?? body.key ?? '').trim();
        const message = String(body.message ?? '').trim();
        const sourceKey = String(body.sourceKey ?? '').trim();
        if (!targetKey || !message) { sendJson({ ok: false, error: '需要 targetKey 和 message' }, 400); return; }
        const agentTokenS = String(req.headers['x-agent-token'] ?? '').trim();
        if (agentTokenS && !agentTokenOk(targetKey, agentTokenS)) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (agentTokenS && !SessionAllowed(targetKey)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (agentTokenS && !ToolEnabled('scheduleMessage')) { sendJson({ ok: false, error: '工具未启用：qq_schedule_message' }, 403); return; }
        const keyMatchS = /^(group|private):(\d+)$/.exec(targetKey);
        if (!keyMatchS) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        // 时间解析：优先 at（ISO 字符串或毫秒时间戳），其次 delayMs（相对毫秒）。
        // 服务器时区为 UTC：无时区后缀的日期时间（如 "2026-09-04 07:30:00"）一律按北京时间解释，
        // 否则 Date.parse 会把 07:30 当地化（当成 UTC 07:30=北京 15:30），定时就烧错时点。
        let at = parseScheduledAt(body.at);
        if (at === null && Number(body.delayMs) > 0) at = Date.now() + Number(body.delayMs);
        if (at === null || at <= Date.now()) { sendJson({ ok: false, error: '时间无效或已过期（需未来时间，at 用 ISO 如 2026-09-02T08:00:00+08:00 或 delayMs 毫秒）' }, 400); return; }
        const repeatMs = Math.max(0, Number(body.repeatMs) || 0);
        // 发起者反查（日志/失败通知用）
        let sourceUid = '';
        if (agentTokenS) {
          for (const [ck, cst] of social.conversations.entries()) {
            if (cst && cst.agentToken && agentTokenS === cst.agentToken) {
              const m = /^private:(\d+)$/.exec(ck);
              if (m) sourceUid = m[1];
              break;
            }
          }
        }
        const task = createScheduledTask({ targetKey, message, at, repeatMs, sourceKey: sourceKey || (sourceUid ? `private:${sourceUid}` : ''), sourceUid });
        sendJson({ ok: true, task: { id: task.id, targetKey, message, at: task.at, repeatMs: task.repeatMs } });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/social/schedule-list') {
        const agentTokenL = String(req.headers['x-agent-token'] ?? '').trim();
        if (agentTokenL && !ToolEnabled('scheduleMessage')) { sendJson({ ok: false, error: '工具未启用：qq_schedule_message' }, 403); return; }
        sendJson({ ok: true, tasks: scheduledTasks.map((t) => ({ id: t.id, targetKey: t.targetKey, message: String(t.message ?? '').slice(0, 80), at: t.at, repeatMs: t.repeatMs || 0 })) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/schedule-cancel') {
        const body = await readBody();
        const id = String(body.id ?? '').trim();
        if (!id) { sendJson({ ok: false, error: '需要 id' }, 400); return; }
        const agentTokenC = String(req.headers['x-agent-token'] ?? '').trim();
        if (agentTokenC && !ToolEnabled('scheduleMessage')) { sendJson({ ok: false, error: '工具未启用：qq_schedule_message' }, 403); return; }
        const removed = cancelScheduledTask(id);
        sendJson({ ok: true, removed });
        return;
      }
      // ========== qq_crosschat_send / qq_crosschat_inbox: 跨会话留言信箱 ==========
      if (req.method === 'POST' && url.pathname === '/api/social/crosschat-send') {
        const body = await readBody();
        const toKey = String(body.toKey ?? '').trim();
        const content = String(body.content ?? '').trim();
        const agentTokenX = String(req.headers['x-agent-token'] ?? '').trim();
        if (!agentTokenX || !agentTokenOk(toKey, agentTokenX)) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (!ToolEnabled('crosschat')) { sendJson({ ok: false, error: '工具未启用：qq_crosschat_*' }, 403); return; }
        if (!toKey || !/^(group|private):\d+$/.test(toKey)) { sendJson({ ok: false, error: 'toKey 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        if (!SessionAllowed(toKey)) { sendJson({ ok: false, error: '目标会话不在当前模式允许范围内' }, 403); return; }
        if (!content || content.length < 1) { sendJson({ ok: false, error: '留言内容不能为空' }, 400); return; }
        // 从 agentToken 反查留言来自哪个会话
        let fromKey = '';
        for (const [ck, cst] of social.conversations.entries()) {
          if (cst && cst.agentToken && agentTokenX === cst.agentToken) { fromKey = ck; break; }
        }
        if (!fromKey) { sendJson({ ok: false, error: '无法识别留言来源会话' }, 403); return; }
        const ok = addCrossMail(toKey, fromKey, content);
        sendJson({ ok, toKey });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/social/crosschat-inbox') {
        const keyX = String(url.searchParams.get('key') ?? '').trim();
        const agentTokenR = String(req.headers['x-agent-token'] ?? '').trim();
        if (!keyX || !agentTokenR || !agentTokenOk(keyX, agentTokenR)) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (!ToolEnabled('crosschat')) { sendJson({ ok: false, error: '工具未启用：qq_crosschat_*' }, 403); return; }
        // 来源标签统一走 crosschat.js 导出的 describeCrossKey（单一事实源）：
        // 与 buildCrossChatBlock 注入给模型的文案必然一致，不会两处漂移。
        // 注意：ESM 具名导入一个**未导出**的绑定是链接期 SyntaxError（整个桥起不来），
        // 所以 crosschat.js 的 export 与这里的 import 必须同时存在——删任一边都要同时删另一边。
        const items = unreadCrossMails(keyX, 5).map((m) => ({ from: describeCrossKey(m.from), fromKey: m.from, content: String(m.content).slice(0, 300), ts: m.ts }));
        sendJson({ ok: true, items });
        return;
      }
      // ========== qq_withdraw_message: 撤回自己发的消息 ==========
      if (req.method === 'POST' && url.pathname === '/api/social/withdraw') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const messageId = String(body.messageId ?? '').trim();
        if (!key || !messageId) { sendJson({ ok: false, error: '需要 key 和 messageId' }, 400); return; }
        const agentTokenW = String(req.headers['x-agent-token'] ?? '').trim();
        if (agentTokenW && !agentTokenOk(key, agentTokenW)) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (agentTokenW && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (agentTokenW && !ToolEnabled('withdrawMessage')) { sendJson({ ok: false, error: '工具未启用：qq_withdraw_message' }, 403); return; }
        // 只允许撤回本会话里自己（我:）发的消息，防止乱撤别人的话
        const stW = getSocialState(key);
        const ownMsg = Array.isArray(stW.recentMessages) ? stW.recentMessages.find((m) => m && m.isSelf && (String(m.messageId || '') === messageId || String(m.seq || '') === messageId)) : null;
        if (!ownMsg) { sendJson({ ok: false, error: '只能撤回本会话中自己发的消息（找不到匹配的自己发送记录）' }, 403); return; }
        try {
          await botRef.deleteMessage(messageId);
          // 撤回成功：从上下文里移除这条（避免 AI 再引用/重复）
          const idxW = stW.recentMessages.findIndex((m) => m && String(m.messageId || '') === messageId);
          if (idxW >= 0) stW.recentMessages.splice(idxW, 1);
          saveSocialState();
          // 撤回落库：把该会话对应自发消息（direction='out'）行标记 recalled_at，
          // 重启后 /recent 回退读取与引用解析不再把它当有效内容（失败仅 log，不阻断撤回结果）。
          try {
            const dbMark = markChatRecalled(key, messageId);
            if (dbMark.ok && dbMark.updated > 0) {
              log(`[withdraw] DB 已标记撤回 ${key} 自己发的消息 ${messageId}`);
            } else if (!dbMark.ok) {
              log(`[withdraw] DB 标记撤回失败 ${key} ${messageId}: ${dbMark.error ?? '未知'}`);
            }
          } catch (error) {
            log(`[withdraw] DB 标记撤回异常 ${key} ${messageId}: ${error?.message ?? error}`);
          }
          log(`[withdraw] 已撤回 ${key} 自己发的消息 ${messageId}`);
          sendJson({ ok: true, key, messageId });
        } catch (error) {
          log(`[withdraw] 撤回失败 ${key} ${messageId}: ${error?.message ?? error}`);
          sendJson({ ok: false, error: `撤回失败：${error?.message ?? String(error)}` }, 500);
        }
        return;
      }
      // ========== 登记自己刚发出的消息（内置表情包等直发通道，撤回要用 messageId） ==========
      if (req.method === 'POST' && url.pathname === '/api/social/record-own-sent') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const messageId = String(body.messageId ?? body.msgId ?? '').trim();
        const text = String(body.text ?? body.file ?? '[图]').trim().slice(0, 120);
        if (!key || !messageId) { sendJson({ ok: false, error: '需要 key 和 messageId' }, 400); return; }
        const agentTokenR = String(req.headers['x-agent-token'] ?? '').trim();
        if (!agentTokenR || !agentTokenOk(key, agentTokenR)) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (!SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        const stR = getSocialState(key);
        // 幂等：同一 messageId 已登记过就不再重复入列
        const dupR = Array.isArray(stR.recentMessages) && stR.recentMessages.some((m) => m && m.isSelf && String(m.messageId || '') === messageId);
        if (!dupR) {
          const sentEntry = {
            messageId,
            sender: '我',
            text,
            plain: text,
            quoteTargetIsSelf: false,
            isOwner: true,
            ownerLabel: '我',
            isSelf: true,
            time: Date.now()
          };
          stR.recentMessages.push(sentEntry);
          persistChatMessage(key, sentEntry);
          const recentLimitR = Number(cfgRef.social?.context?.recentLimit) || 100;
          if (stR.recentMessages.length > recentLimitR) stR.recentMessages.splice(0, stR.recentMessages.length - recentLimitR);
          stR.lastAiReplyAt = Date.now();
          stR.lastActionAt = Date.now();
          stR.wakeConfig.noActionCount = 0;
        }
        saveSocialState();
        log(`[record-sent] 登记自己发出的消息 ${key} messageId=${messageId} text=${text.slice(0, 40)}`);
        // 【2026-09-15】内置表情库走的是"直发 + 回登记"这条路（qq_send_meme 不经桥的发送端点），
        // 所以表情包冷却要在这里认：登记文本是 [表情:xxx] / [收藏表情:xxx] 就当作发过表情包。
        if (/^\[(表情|收藏表情|大肥鱼表情|鲸鱼表情)/.test(text)) {
          try { noteMemeSent(key); } catch { /* 忽略 */ }
        }
        sendJson({ ok: true, key, messageId, recorded: !dupR });
        return;
      }
      // ========== DSH 空闲会话自动归档：状态查询 / 手动巡检 ==========
      if (url.pathname === '/api/social/session-archive') {
        if (req.method === 'GET') {
          sendJson({ ok: true, ...sessionArchiveStatus() });
          return;
        }
        if (req.method === 'POST') {
          const body = await readBody();
          try {
            const report = await archiveIdleSessions({
              force: body?.force !== false,
              dryRun: body?.dryRun === true,
              allWorkspaces: body?.allWorkspaces === true,
              idleMinutes: body?.idleMinutes,
              batchMax: body?.batchMax
            });
            sendJson(report);
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
      }

      // ========== qq_send_forward: 智能合并转发 ==========
      if (req.method === 'POST' && url.pathname === '/api/social/forward-send') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const nodes = Array.isArray(body.nodes) ? body.nodes : [];
        const replyToMessageId = body.replyToMessageId;
        if (!key || !nodes.length) { sendJson({ ok: false, error: '需要 key 和 nodes' }, 400); return; }
        const agentTokenF = String(req.headers['x-agent-token'] ?? '').trim();
        if (agentTokenF && !agentTokenOk(key, agentTokenF)) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (agentTokenF && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (agentTokenF && !ToolEnabled('sendForward')) { sendJson({ ok: false, error: '工具未启用：qq_send_forward' }, 403); return; }
        const keyMatchF = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatchF) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        const kindF = keyMatchF[1];
        const idF = Number(keyMatchF[2]);
        if (!Number.isFinite(idF) || idF <= 0 || !modeAllowed(key, kindF, idF, cfgRef, currentMode)) {
          sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
          return;
        }
        // 构造合并转发节点（最多 50 条，单条内容 3000 字上限，防滥用）
        const cleaned = [];
        for (const n of nodes.slice(0, 50)) {
          const content = String(n?.content ?? '').trim();
          if (!content) continue;
          cleaned.push({
            type: 'node',
            data: {
              user_id: Number(n?.uin) || 0,
              nickname: String(n?.name ?? '').slice(0, 30) || '群友',
              content: [{ type: 'text', data: { text: content.slice(0, 3000) } }]
            }
          });
        }
        if (!cleaned.length) { sendJson({ ok: false, error: 'nodes 里没有有效内容' }, 400); return; }
        try {
          let forwardId = null;
          if (kindF === 'group') {
            const res = await botRef.sendGroupForwardMessage(Number(idF), cleaned);
            forwardId = res?.message_id ?? res?.id ?? null;
          } else {
            const res = await botRef.sendPrivateForwardMessage(Number(idF), cleaned);
            forwardId = res?.message_id ?? res?.id ?? null;
          }
          // 记录到目标会话上下文（一条"合并转发"标记）
          const stF = getSocialState(key);
          stF.recentMessages.push({
            messageId: forwardId ? String(forwardId) : null,
            sender: '我',
            text: `[合并转发：${cleaned.length} 条]`,
            plain: `[合并转发：${cleaned.length} 条]`,
            quoteTargetIsSelf: false,
            isOwner: true,
            ownerLabel: '我',
            isSelf: true,
            media: [],
            hasMedia: false,
            forwardIds: [],
            hasForward: true,
            time: Date.now()
          });
          const recentLimitF = Number(cfgRef.social?.context?.recentLimit) || 100;
          if (stF.recentMessages.length > recentLimitF) stF.recentMessages.splice(0, stF.recentMessages.length - recentLimitF);
          saveSocialState();
          log(`[forward] 合并转发 ${key}: ${cleaned.length} 条`);
          sendJson({ ok: true, key, sent: cleaned.length, forwardId });
        } catch (error) {
          log(`[forward] 合并转发失败 ${key}: ${error?.message ?? error}`);
          sendJson({ ok: false, error: `合并转发失败：${error?.message ?? String(error)}` }, 500);
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/sticker-note') {
        if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const stickerId = String(body.stickerId ?? '').trim();
        if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return; }
        const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
        const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
        const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
        const entry = applyStickerNote2(stickerId, note, tags, usage);
        if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
        log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
        sendJson({ ok: true, key, sticker: entry });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/sticker-remark') {
        if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const stickerId = String(body.stickerId ?? '').trim();
        if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return; }
        try {
          const entry = await setStickerRemark2(stickerId, String(body.remark ?? ''));
          log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
          sendJson({ ok: true, key, sticker: entry });
        } catch (error) {
          sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/send-sticker') {
        if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const stickerId = String(body.stickerId ?? '').trim();
        const caption = String(body.message ?? body.caption ?? '').trim();
        const replyToMessageId = body.replyToMessageId;
        const atUserId = body.atUserId ?? null;
        if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
        // 常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
        if (caption) {
          sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
          return;
        }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        /* 跨会话闸门只装在 `/api/social/send-message`（内容发送的主干线，pixiv/表情包/正文都走它）。
         * 表情/语音这些独立端点没装：它们的工具 schema 里也没有 crossSession 可传，装了就等于
         * "拒绝且无出口"（模型会照着提示重试到死）。要覆盖它们，先在工具层加上这个参数。 */
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return; }
        if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'default 模式发送必须携带 agent token' }, 403); return; }
        const keyMatch = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        const kind = keyMatch[1];
        const id = Number(keyMatch[2]);
        if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfgRef, currentMode)) {
          sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
          return;
        }
        if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
        if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
        if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
          sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
          return;
        }
        let quotedInfo = null;
        let actualReplyToMessageId = replyToMessageId;
        if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
          const stForReply = getSocialState(key);
          const resolved = await resolveReplyTarget(stForReply, kind, id, String(replyToMessageId).trim());
          if (!resolved) {
            sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' + replyTargetHint(key) }, 400);
            return;
          }
          quotedInfo = resolved.info;
          actualReplyToMessageId = resolved.messageId;
        }
        const sendCfg = cfgRef.social?.send ?? {};
        const now = Date.now();
        try {
          const st = getSocialState(key);
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          const sent = await sendSticker2(key, stickerId, {
            replyToMessageId: actualReplyToMessageId,
            atUserId
          });
          // 记录到default会话的 recentMessages，让 AI 知道自己发过这个表情
          const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
          const text = `[表情包:${label}]`;
          const stickerRecord = {
            messageId: sent.messageId ? String(sent.messageId) : null,
            sender: '我',
            text: text.slice(0, 200),
            plain: text.slice(0, 200),
            quoteTargetIsSelf: false,
            isOwner: true,
            ownerLabel: '我',
            isSelf: true,
            media: [],
            hasMedia: false,
            forwardIds: [],
            hasForward: false,
            sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
            time: Date.now()
          };
          st.recentMessages.push(stickerRecord);
          persistChatMessage(key, stickerRecord);
          const recentLimit = Number(cfgRef.social?.context?.recentLimit) || 100;
          if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
          st.lastAiReplyAt = now;
          st.lastActionAt = now;
          st.wakeConfig.noActionCount = 0;
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSocialState();
          scheduleReplyCheck(key);
          log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
          appendActivity(`${key} [sticker] 工具发送表情：${label}`);
          // 【2026-09-15】登记「这个会话刚发过表情包」：唤醒正文里的 [Meme] 抽签靠它做冷却
          try { noteMemeSent(key); } catch { /* 忽略 */ }
          sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
        } catch (error) {
          const st = getSocialState(key);
          const idx = st.sendTimes.indexOf(now);
          if (idx >= 0) st.sendTimes.splice(idx, 1);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          saveSocialState();
          log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
          sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      // QQ 自带表情（face）对照表：MCP qq_face_list
      if (req.method === 'GET' && url.pathname === '/api/social/qq-face-list') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('faceList')) { sendJson({ ok: false, error: '工具未启用：qq_face_list' }, 403); return; }
        const table = formatFaceList();
        sendJson({ ok: true, total: table ? table.split('\n').length : 0, table, note: 'name=id，发 QQ 原生表情用 qq_send_qq_face 传 name 或 id' });
        return;
      }
      // 发送 QQ 自带表情（face，含动态大表情）：MCP qq_send_qq_face
      if (req.method === 'POST' && url.pathname === '/api/social/send-qq-face') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const faceRef = String(body.faceId ?? body.name ?? body.face ?? '').trim();
        const replyToMessageId = body.replyToMessageId;
        const atUserId = body.atUserId ?? null;
        if (!key || !faceRef) { sendJson({ ok: false, error: 'key 和 faceId/name 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('sendQqFace')) { sendJson({ ok: false, error: '工具未启用：qq_send_qq_face' }, 403); return; }
        if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'default 模式发送必须携带 agent token' }, 403); return; }
        const keyMatch = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        const kind = keyMatch[1];
        const id = Number(keyMatch[2]);
        if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfgRef, currentMode)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
        if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
        if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
          sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
          return;
        }
        const face = resolveFaceRef(faceRef);
        if (!face) { sendJson({ ok: false, error: `找不到 QQ 表情「${faceRef}」，可先用 qq_face_list 查看名字→id 表` }, 400); return; }
        let quotedInfo = null;
        let actualReplyToMessageId = replyToMessageId;
        if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
          const stForReply = getSocialState(key);
          const resolved = await resolveReplyTarget(stForReply, kind, id, String(replyToMessageId).trim());
          if (!resolved) { sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' + replyTargetHint(key) }, 400); return; }
          quotedInfo = resolved.info;
          actualReplyToMessageId = resolved.messageId;
        }
        const sendCfg = cfgRef.social?.send ?? {};
        const now = Date.now();
        try {
          const st = getSocialState(key);
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          const sent = await sendQqFace2(key, face.id, face.name, { replyToMessageId: actualReplyToMessageId, atUserId });
          const label = face.name ? `[QQ表情:${face.name}(${face.id})]` : `[QQ表情:${face.id}]`;
          st.recentMessages.push({
            messageId: sent.messageId ? String(sent.messageId) : null,
            sender: '我',
            text: label,
            plain: label,
            quoteTargetIsSelf: false,
            isOwner: true,
            ownerLabel: '我',
            isSelf: true,
            media: [],
            hasMedia: false,
            forwardIds: [],
            hasForward: false,
            qqFace: { id: face.id, name: face.name || '' },
            time: Date.now()
          });
          const recentLimit = Number(cfgRef.social?.context?.recentLimit) || 100;
          if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
          const qqFaceRecord = st.recentMessages[st.recentMessages.length - 1];
          persistChatMessage(key, qqFaceRecord);
          st.lastAiReplyAt = now;
          st.lastActionAt = now;
          st.wakeConfig.noActionCount = 0;
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSocialState();
          scheduleReplyCheck(key);
          log(`[qqface] 工具发送 QQ 表情 ${key}: ${label}`);
          sendJson({ ok: true, key, face: { id: face.id, name: face.name || '' }, sent: 1, failed: 0, quoted: quotedInfo });
        } catch (error) {
          const st = getSocialState(key);
          const idx = st.sendTimes.indexOf(now);
          if (idx >= 0) st.sendTimes.splice(idx, 1);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          saveSocialState();
          log(`[qqface] 工具发送 QQ 表情失败 ${key}: ${error?.message ?? error}`);
          sendJson({ ok: false, error: `发送 QQ 表情失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      // 发送富文本/卡片（music/contact/location/json/xml/dice/rps）：MCP qq_send_rich
      if (req.method === 'POST' && url.pathname === '/api/social/send-rich') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const type = String(body.type ?? '').trim();
        const replyToMessageId = body.replyToMessageId;
        const atUserId = body.atUserId ?? null;
        if (!key || !type) { sendJson({ ok: false, error: 'key 和 type 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('sendRich')) { sendJson({ ok: false, error: '工具未启用：qq_send_rich' }, 403); return; }
        if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'default 模式发送必须携带 agent token' }, 403); return; }
        const keyMatch = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        const kind = keyMatch[1];
        const id = Number(keyMatch[2]);
        if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfgRef, currentMode)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
        if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
        // 按类型校验并构建消息段
        let seg = null;
        let musicPlan = null;   // buildMusicCard 的产物：primary / native / link 三段降级梯子
        let videoPlan = null;   // buildVideoCard 的产物：同构的降级梯子（视频卡片）
        let locTextAfter = '';  // 位置卡片：图片/卡片发完后再补一条"地点文字 + 地图链接"
        let locMode = '';       // 位置卡片实际用的模式（tuwen/map/native），回执里如实告诉模型
        const require = (v, msg) => { if (v === undefined || v === null || String(v).trim() === '') throw new Error(msg); };
        try {
          if (type === 'music') {
            // NapCat 4.18 原生支持音乐卡片：music 段由 NapCat 调 musicSignUrl 生成 Ark。
            // 【2026-09-16 修「手机端封面空白」】网易云不再把 id 直接丢给签名服务：带 id 时签名服务自己解析封面，
            // 给的是**未缩尺寸的原图**（现场实测一张 4.4MB），手机端加载不出来就是白框（电脑端正常）。
            // 现在由 media 域的 buildMusicCard 先解析歌名/歌手/封面/音频，封面统一 https + 300×300 再拼卡片；
            // 模型只给 musicType + musicId，不许手写卡片字段（手写封面 URL 是白框的老坑）。
            // QQ 音乐平台 ss.xingzhige 已关闭 id 解析（返回"关闭id解析功能"），继续走官方分享链接文本。
            const mt = String(body.musicType ?? body.mt ?? 'qq').trim();
            const mid = body.musicId !== undefined && body.musicId !== null ? String(body.musicId) : '';
            const title = String(body.title ?? '').trim();
            const artist = String(body.content ?? body.singer ?? body.artist ?? '').trim();
            if (mt === 'qq' && mid) {
              // QQ 音乐：无可靠外部签名服务（ss.xingzhige 已关闭 qq id 解析；自造 Ark 会收端"版本过低/超时"），
              // 【2026-09-18 改】先试**桥拼卡片**：secapi.top 能直接给到可播放直链（不需要 key），
              // 拿得到就发真音乐卡（media.js 的 buildMusicCard 会校验 songmid 对得上，配错歌宁可不发）；
              // 拿不到（没有直链/封面，或歌名对不上）才退回下面的 QQ 官方分享链接文本 —— 与真人"分享歌曲到QQ"一致：
              // 新版客户端自动渲染卡片，旧版显示为可点开的分享链接。降级梯子不变。
              if (!title) throw new Error('QQ 音乐分享需要 title（歌名，qq_music_search 返回）');
              if (typeof buildMusicCard === 'function') {
                try {
                  const qqPlan = await buildMusicCard('qq', mid, {
                    title,
                    artist,
                    image: String(body.image ?? '').trim(),
                    musicUrl: String(body.musicUrl ?? body.url ?? '').trim(),
                    // 允许按次指定签名服务要的"平台身份"（qq / custom）—— 实测两者在手机端的封面表现不同
                    cardType: String(body.cardType ?? '').trim()
                  });
                  if (qqPlan?.primary) { musicPlan = qqPlan; seg = qqPlan.primary; }
                  else log(`[rich] QQ 音乐未能生成卡片 ${key}: ${qqPlan?.note ?? '无卡片形态'} —— 改发官方分享链接文本`);
                } catch (qqErr) {
                  log(`[rich] QQ 音乐卡片构建失败 ${key}: ${qqErr?.message ?? qqErr} —— 改发官方分享链接文本`);
                }
              }
              if (!seg) {
                const shareUrl = `https://i.y.qq.com/v8/playsong.html?platform=11&appshare=android_qq&appversion=20080008&hosteuin=null&songmid=${mid}&type=0&appsongtype=1&_wv=1&source=qq&ADTAG=qfshare`;
                const shareText = `${title}${artist ? ' ' + artist : ''} ${shareUrl}`;
                // 复用 send-message 文本通道发送（走记录/审计），记录为卡片语义
                const sentMsg = await sendMessages(key, [shareText]);
                recordSentMessages(key, sentMsg);
                const stMc = getSocialState(key);
                stMc.lastAiReplyAt = Date.now();
                stMc.lastActionAt = Date.now();
                stMc.wakeConfig.noActionCount = 0;
                saveSocialState();
                seg = { type: '_shareText', data: { title, url: shareUrl } };
                // 直接走文本发送，不走下方 rich 通道
                sendJson({ ok: true, key, type: 'music', sent: sentMsg.length, failed: 0, platform: 'qq', share: true, title });
                return;
              }
            } else if (mid && typeof buildMusicCard === 'function') {
              // 网易云等平台：卡片字段全部由桥解析拼好，模型只给 id
              try {
                musicPlan = await buildMusicCard(mt, mid, {
                  title,
                  artist,
                  musicUrl: String(body.musicUrl ?? body.url ?? '').trim(),
                  image: String(body.image ?? '').trim(),
                  audio: String(body.audio ?? '').trim()
                });
                seg = musicPlan.primary;
              } catch (cardBuildError) {
                // 构建/解析失败也不能让"分享"整体失败：
                //  · NapCat 认 id 的平台（163/qq/kugou/kuwo/migu）→ 退回原生 id 卡片（老行为）；
                //  · 其它（custom 等）→ 没有可用卡片形态，直接走链接兜底（若调用方给了 musicUrl）。
                const murl2 = String(body.musicUrl ?? body.url ?? '').trim();
                log(`[rich] 音乐卡片构建失败(platform=${mt}) ${key}: ${cardBuildError?.message ?? cardBuildError}`);
                if (/^(163|qq|kugou|kuwo|migu)$/.test(mt)) {
                  musicPlan = null;
                  seg = { type: 'music', data: { type: mt, id: mid } };
                } else if (murl2) {
                  musicPlan = { title, primary: null, native: null, link: `${title ? title + ' ' : ''}${murl2}`, note: '卡片构建失败，已直接发链接' };
                  seg = null;
                } else {
                  throw cardBuildError;
                }
              }
            } else {
              // 未注入卡片构建器（旧装配/测试）或没给 id：保持原行为，字段原样透传
              const murl = String(body.musicUrl ?? body.url ?? '').trim();
              const data = { type: mt };
              if (mid) { data.id = mid; }
              else { data.url = murl; }
              if (body.image) data.image = String(body.image);
              if (body.title) data.title = String(body.title);
              if (body.content) data.content = String(body.content); // custom: 歌手
              if (body.audio) data.audio = String(body.audio);
              seg = { type: 'music', data };
            }
          } else if (type === 'video') {
            /* 【2026-09-17】视频卡片（bilibili / 抖音 / 快手 / 小红书 / 微博 / YouTube）。
             * 与音乐卡片同一原则：**模型只给链接**，标题/UP主/封面/时长/播放量全部由桥解析拼好，
             * 不许模型手写卡片字段（手写封面 URL 就是手机端白框的老坑）。
             * 解析失败也绝不让"分享"整体失败：退化成"标题（若有）+ 纯链接"，至少能点开。 */
            const vurl = String(body.videoUrl ?? body.url ?? '').trim();
            require(vurl, '视频卡片需要 videoUrl（bilibili / 抖音 的链接或 BV 号）');
            try {
              const info = await resolveVideo(vurl);
              videoPlan = buildVideoCard(info, { title: String(body.title ?? '').trim(), url: String(info.url || vurl) });
              /* 【2026-09-18 第八批 · 纠正上一轮的结论】B 站原生小程序卡片**做得到**。
               * 桥直接问 NapCat 的 `get_mini_app_ark` 要一张**QQ 服务端现场签发**的 Ark
               * （`app=com.tencent.miniapp_01`、`view=view_8C8E89…`、`url=m.q.qq.com/a/s/<hash>`、
               *  `config.token=<签名>`），跟主人从 B 站分享进来的真卡**逐字段同款** —— 见 video.js 的
               * `fetchMiniAppArk` 注释（那里有线上复测的完整返回）。
               * 所以第一优先改成小程序卡；拿不到才退回原来的「封面图 + 分享文案」。 */
              const ark = await fetchMiniAppArk(info, { httpUrl: cfgRef?.napcat?.httpUrl, token: cfgRef?.napcat?.accessToken });
              if (ark) {
                videoPlan.primary = ark;
                videoPlan.style = 'miniapp';
                videoPlan.note = `B 站原生小程序卡片（NapCat get_mini_app_ark，Ark 与 token 由 QQ 服务端签发）`;
                seg = ark;
              } else if (videoPlan.style === 'share' && info?.cover) {
                /* 兜底形态（原来的最终形态）：封面图负责"像个卡片"，文案里的链接负责能点开。 */
                seg = { type: 'image', data: { file: info.cover } };
                videoPlan.coverSent = true;
              } else {
                seg = videoPlan.primary;
              }
            } catch (e) {
              const title = String(body.title ?? '').trim();
              log(`[rich] 视频卡片解析失败 ${key}: ${e?.message ?? e}`);
              videoPlan = {
                title,
                primary: null,
                native: null,
                link: `${title ? title + ' ' : ''}${vurl}`,
                note: `解析失败（${e?.message ?? e}），已退化为纯链接`
              };
              seg = null;
            }
          } else if (type === 'location') {
            /* 【2026-09-19 修「位置卡片根本发不出去」】
             * 上一轮以为"位置卡片实测通过"，其实**从来没真的发出去过**。读 NapCat 源码（4.18.28）：
             *   packages/napcat-onebot/api/msg.ts:924
             *     [OB11MessageDataType.location]: async () => ({
             *       elementType: ElementType.SHARELOCATION, elementId: '',
             *       shareLocationElement: { text: '测试', ext: '' },      // ← text/ext 全是写死的
             *     }),
             * 也就是说 **lat/lon/title/content 全部被丢弃**，发出去的是一个 text='测试'、ext='' 的哑元素。
             * 线上复核也印证了：同一条 location 段用 get_friend_msg_history 回读，段列表是**空的**（`[]`），
             * NapCat 连自己发出去的位置都解析不回来。
             *
             * 所以默认改成 `map` 模式：**静态地图图片 + 地点文字 + 地图链接** ——
             * 图由 NapCat 下载后当普通图片发给 QQ（对方不用自己联网取图），文字和链接都能点，
             * 这是"确定能看到东西"的形态。想要 QQ 原生位置气泡，得先给 NapCat 打补丁把 text/ext
             * 透传过去（我们有构建链，但那要重启 NapCat），把 locationMode 设成 `native` 即可切回。
             * 配置：social.send.locationMode = 'map'（默认）| 'native'，或环境变量 QQBRIDGE_LOCATION_MODE。 */
            require(body.lat, '位置卡片需要 lat（纬度）');
            require(body.lon, '位置卡片需要 lon（经度）');
            const lat = Number(body.lat);
            const lon = Number(body.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
              throw new Error('lat/lon 不是合法经纬度（lat -90~90，lon -180~180）');
            }
            const locTitle = String(body.locTitle ?? body.title ?? '').trim();
            const locContent = String(body.locContent ?? body.content ?? '').trim();
            locMode = String(process.env.QQBRIDGE_LOCATION_MODE ?? cfgRef?.social?.send?.locationMode ?? 'tuwen').trim().toLowerCase();
            /* 地图图片：有高德 key 就用高德官方静态图，没有就用实测可用的一张（见下）。 */
            const amapKey = String(process.env.AMAP_KEY ?? cfgRef?.social?.send?.amapKey ?? '').trim();
            const mapImg = amapKey
              ? `https://restapi.amap.com/v3/staticmap?location=${lon},${lat}&zoom=16&size=600*400&scale=2&markers=mid,,A:${lon},${lat}&key=${encodeURIComponent(amapKey)}`
              : `https://static-maps.yandex.ru/1.x/?ll=${lon},${lat}&z=16&size=600,400&l=map&pt=${lon},${lat},pm2rdm`;
            /* 【2026-09-19 第十一批】主人要求"位置卡默认改成发腾讯地图小程序"。
             *
             * 先说清楚做不到的那部分：主人从 QQ 分享进来的那张腾讯地图卡（`incoming-cards.jsonl` 里有）是
             *   {"app":"com.tencent.miniapp.lua","view":"miniapp","bizsrc":"miniapp.nativeshare",
             *    "prompt":"[微信小程序]腾讯地图",
             *    "meta":{"miniapp":{"tag":"微信小程序","title":"腾讯地图","source":"腾讯地图",
             *      "sourcelogo":"https://miniapp.gtimg.cn/generated-icon/wx7643d5f831302ab0.png",
             *      "jumpUrl":"https://m.q.qq.com/a/s/101a907383cf58f545e2f406fca8f5fb", …}},
             *    "config":{"token":"3d36f6c85f64e828e45bf79784c5d5a5",…}}
             * —— 它是**微信小程序转发进来的卡**，`m.q.qq.com/a/s/<hash>` 和 `config.token` 都是分享那一刻
             * 服务端签发、**指向那个具体地点**的，换坐标没法复用。`get_mini_app_ark` 也救不了：
             * 它走 `LightAppSvc.mini_app_share.AdaptShareInfo`，只认 **QQ 小程序**的 appId+versionId
             * （实测拿高德的 appId 100571486 去调直接回 `jsonContent` undefined）。
             *
             * 所以做的是"**看起来就是腾讯地图那张卡**"的图文卡：来源角标(腾讯地图)+官方图标+
             * 腾讯地图跳转链接+地图缩略图。`social.send.locationApp='amap'` 可切回高德身份。 */
            const locApp = String(process.env.QQBRIDGE_LOCATION_APP ?? cfgRef?.social?.send?.locationApp ?? 'tencent').trim().toLowerCase();
            const tencentLink = `https://apis.map.qq.com/uri/v1/marker?marker=coord:${lat},${lon};title:${encodeURIComponent(locTitle || '位置')}&referer=moonbot`;
            const amapLink = `https://uri.amap.com/marker?position=${lon},${lat}&coordinate=gaode&callnative=1${locTitle ? `&name=${encodeURIComponent(locTitle)}` : ''}`;
            const mapLink = locApp === 'amap' ? amapLink : tencentLink;
            const locLine = `地点：${locTitle || `${lat},${lon}`}${locContent ? `\n${locContent}` : ''}\n${mapLink}`;
            if (locMode === 'native') {
              seg = {
                type: 'location',
                data: { lat: String(lat), lon: String(lon), title: locTitle, content: locContent }
              };
            } else if (locMode === 'map') {
              /* 静态地图图片 + 地点文字 + 地图链接 —— 一定看得见的形态。
               * 实测这台 VPS 上无 key 能用的是 yandex static（200 image/png）；
               * staticmap.openstreetmap.de 超时、maps.wikimedia.org 403、高德 restapi 无 key 返回 INVALID_USER_KEY。
               * 图是**服务器侧**抓取后由 NapCat 上传给 QQ 的，所以对方网络环境不影响。 */
              seg = { type: 'image', data: { file: mapImg } };
              locTextAfter = locLine;
            } else {
              /* 【2026-09-19 第十批】默认 `tuwen`：发**高德地图那条"图文/富文本"卡片**。
               * 形态不是我猜的 —— 是主人 16:33 从高德分享进 QQ 时，桥在
               * `state/incoming-cards.jsonl` 里抓到的**原始卡片**（逐字段照抄）：
               *
               *   {"app":"com.tencent.tuwen.lua","bizsrc":"qqconnect.sdkshare",
               *    "config":{"ctime":1789662714,"forward":1,"token":"<32位签名>","type":"normal"},
               *    "extra":{"app_type":1,"appid":100571486,"msg_seq":…,"uin":1736784911},
               *    "meta":{"news":{"app_type":1,"appid":100571486,"ctime":…,"desc":"高德地图",
               *            "jumpUrl":"https://surl.amap.com/fnlA5Augeq","preview":"<QQ图床>",
               *            "tag":"高德","tagIcon":"https://p.qpic.cn/qqconnect/0/app_100571486_…",
               *            "title":"天安门广场","uin":1736784911}},
               *    "prompt":"[分享]天安门广场","ver":"0.0.0.1","view":"news"}
               *
               * 关键收获：**app 是 `com.tencent.tuwen.lua`（图文），不是上一轮手写失败的那个
               * `com.tencent.structmsg`** —— 同一个 `view=news`，app 名换了才是新版 QQ 认的那套。
               * appid=100571486 就是高德地图在 QQ 里的应用号；tagIcon 用它官方的图标
               * （p.qpic.cn/qqconnect/0/app_100571486_…，QQ 自己的 CDN）。
               *
               * `token` 那张卡里是分享方签的，我们签不出来 → 用同格式的随机 32 位十六进制顶上；
               * 万一 QQ 校验它，卡片会被拒 —— 所以下面同时补一条「地点 + 高德链接」的文字，
               * **保证信息一定到得了**（卡片能渲染的话这条只是重复一次，主人确认后可以去掉）。 */
              const ctime = Math.floor(Date.now() / 1000);
              const hex = () => Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
              const news = {
                app_type: 1,
                appid: 100571486,
                ctime,
                desc: locContent || (locApp === 'amap' ? '高德地图' : '腾讯地图'),
                jumpUrl: mapLink,
                /* 【2026-09-19 定稿】preview **原样**给静态地图，不过任何图片代理。
                 * 上一版包了一层"输出 JPEG"的代理，结果和音乐封面同一个坑：签名服务会把代理 URL 的图
                 * **转存成 qq.ugcimg.cn 长链接**，而那种链接手机端不渲染（真消息记录实测：
                 * 原始外部 URL 会原样透传、手机正常；qq.ugcimg.cn 转存链接手机没图）。 */
                preview: mapImg,
                tag: locApp === 'amap' ? '高德' : '腾讯地图',
                // 腾讯地图那个图标就是它自家分享卡里的 sourcelogo（miniapp.gtimg.cn/generated-icon/wx7643…）
                tagIcon: locApp === 'amap'
                  ? 'https://p.qpic.cn/qqconnect/0/app_100571486_1599210280/100?max-age=2592000&t=0'
                  : 'https://miniapp.gtimg.cn/generated-icon/wx7643d5f831302ab0.png',
                title: locTitle || `${lat},${lon}`
              };
              const card = {
                app: 'com.tencent.tuwen.lua',
                bizsrc: 'qqconnect.sdkshare',
                config: { ctime, forward: 1, token: hex(), type: 'normal' },
                extra: { app_type: 1, appid: 100571486 },
                meta: { news },
                prompt: `[分享]${locTitle || '位置'}`.slice(0, 60),
                ver: '0.0.0.1',
                view: 'news'
              };
              seg = { type: 'json', data: { data: JSON.stringify(card) } };
              locTextAfter = locLine;
            }
          } else if (type === 'contact') {
            const ct = String(body.contactType ?? body.contact_type ?? '').trim();
            if (!['qq', 'group'].includes(ct)) throw new Error('contactType 仅支持 qq/group');
            require(body.contactId, '联系人卡片需要 contactId');
            seg = { type: 'contact', data: { type: ct, id: String(body.contactId) } };
          } else if (type === 'dice' || type === 'rps') {
            seg = { type, data: body.result !== undefined && body.result !== null ? { result: Number(body.result) } : {} };
          } else if (type === 'json' || type === 'xml') {
            // 高级卡片：data 为 JSON 对象/字符串或 xml 字符串，原样透传（NapCat 支持 json/xml 段）
            require(body.data, `${type} 卡片需要 data（json 对象/字符串 或 xml 字符串）`);
            seg = { type, data: typeof body.data === 'string' ? { data: body.data } : body.data };
          } else {
            throw new Error('不支持的卡片类型（仅 music/video/contact/location/dice/rps/json/xml）');
          }
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          return;
        }
        if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
          sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
          return;
        }
        let quotedInfo = null;
        let actualReplyToMessageId = replyToMessageId;
        if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
          const stForReply = getSocialState(key);
          const resolved = await resolveReplyTarget(stForReply, kind, id, String(replyToMessageId).trim());
          if (!resolved) { sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话' + replyTargetHint(key) }, 400); return; }
          quotedInfo = resolved.info;
          actualReplyToMessageId = resolved.messageId;
        }
        const sendCfg = cfgRef.social?.send ?? {};
        const now = Date.now();
        try {
          const st = getSocialState(key);
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          // 【降级梯子】卡片发不出去时**必须**还能退回链接：音乐分享不能因为签名服务/NapCat 出问题就整体失败。
          // 顺序：primary（桥拼卡片）→ native（NapCat 原生 id 卡片，老行为）→ link（官方分享链接纯文本，走文本通道）。
          const ladder = await sendMusicCardWithFallback({
            key,
            plan: musicPlan ?? videoPlan,
            seg,
            options: { replyToMessageId: actualReplyToMessageId, atUserId },
            sendRichFn: sendRich,
            sendText: async (text) => {
              // 兜底走 send-message 文本通道（与 QQ 音乐分享同一条路，同样进会话历史/审计）
              const sentMsg = await sendMessages(key, [text]);
              recordSentMessages(key, sentMsg);
              return { messageId: sentMsg?.[0]?.messageId ?? null };
            }
          });
          const sent = { messageId: ladder.messageId };
          const sentSeg = ladder.seg;
          const sentCard = ladder.card;
          /* 【2026-09-18】视频走"封面图 + 分享文案"两条：图已经发出去了，再把链接补一条，
           * 否则对方只看到一张图、点不开。这一步失败不影响整体成功（图已经送到了）。 */
          if (videoPlan?.coverSent && sentCard === 'primary') {
            try {
              const linkMsg = await sendMessages(key, [videoPlan.link]);
              recordSentMessages(key, linkMsg);
              log(`[rich] 视频卡片已补发分享链接（封面图已送达）${key}`);
            } catch (e) {
              log(`[rich] 视频分享链接补发失败（封面图已送达，不影响）${key}: ${e?.message ?? e}`);
            }
          }
          /* 位置卡片（map 模式）：地图图片已送达，再补一条"📍 地点 + 地图链接"。
           * 补发失败不影响整体成功（图已经在对方那了）。 */
          if (locTextAfter && sentCard === 'primary') {
            try {
              const locMsg = await sendMessages(key, [locTextAfter]);
              recordSentMessages(key, locMsg);
              log(`[rich] 位置卡片已补发地点文字+地图链接 ${key}`);
            } catch (e) {
              log(`[rich] 位置文字补发失败（地图图片已送达，不影响）${key}: ${e?.message ?? e}`);
            }
          }
          // 视频默认走"官方分享链接"（见 video.js 顶部注释：手写 json 卡会被新版 QQ 判"版本太低"），
          // 所以对视频来说 link 形态是**预期**而不是降级；只有音乐/其它真正"卡片发失败退到链接"才算降级。
          const intendedShare = sentCard === 'link' && videoPlan?.style === 'share';
          if (sentCard !== 'primary' && !intendedShare) {
            log(`[rich] ${type} 卡片降级 card=${sentCard} ${key}（${ladder.degradedFrom?.message ?? '无卡片段'}）`);
          }
          const cardTitle = (type === 'json' || type === 'music' || type === 'video')
            ? String(body.title || body.musicTitle || musicPlan?.title || videoPlan?.title || seg?.data?.title || '').trim()
            : (sentSeg?.data?.title ? String(sentSeg.data.title) : '');
          const degraded = sentCard === 'link'
            ? (intendedShare ? '（官方分享链接）' : '（已降级为链接）')
            : sentCard === 'native' ? '（原生卡片）' : '';
          const label = `[卡片:${type === 'json' ? 'music' : type}${cardTitle ? ' ' + cardTitle.slice(0, 20) : ''}${degraded}]`;
          st.recentMessages.push({
            messageId: sent.messageId ? String(sent.messageId) : null,
            sender: '我',
            text: label.slice(0, 200),
            plain: label.slice(0, 200),
            quoteTargetIsSelf: false,
            isOwner: true,
            ownerLabel: '我',
            isSelf: true,
            media: [],
            hasMedia: false,
            forwardIds: [],
            hasForward: false,
            rich: { type, ...(sentSeg?.data ? { data: JSON.stringify(sentSeg.data).slice(0, 300) } : {}) },
            time: Date.now()
          });
          const recentLimit = Number(cfgRef.social?.context?.recentLimit) || 100;
          if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
          const richRecord = st.recentMessages[st.recentMessages.length - 1];
          persistChatMessage(key, richRecord);
          st.lastAiReplyAt = now;
          st.lastActionAt = now;
          st.wakeConfig.noActionCount = 0;
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSocialState();
          scheduleReplyCheck(key);
          log(`[rich] 工具发送卡片 ${key}: ${label}`);
          sendJson({
            ok: true,
            key,
            type,
            sent: 1,
            failed: 0,
            quoted: quotedInfo,
            // 音乐卡片：告诉模型实际发出去的是哪种形态（card=link 表示已自动退回纯链接，别再补发链接）
            ...(musicPlan ? { music: { card: sentCard, title: musicPlan.title, note: musicPlan.note, link: musicPlan.link } } : {}),
            // 视频卡片：同上（card=link 就是已经替你发了链接，别再补一条）
            ...(videoPlan ? { video: { card: sentCard, title: videoPlan.title, platform: videoPlan.platform, note: videoPlan.note, link: videoPlan.link } } : {}),
            // 位置卡片：告诉模型实际发出去的形态（tuwen = 高德图文卡；map = 地图图片 + 地点文字/链接；native = QQ 原生位置气泡）
            ...(locTextAfter ? { location: { mode: locMode, text: locTextAfter } } : {})
          });
        } catch (error) {
          const st = getSocialState(key);
          const idx = st.sendTimes.indexOf(now);
          if (idx >= 0) st.sendTimes.splice(idx, 1);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          saveSocialState();
          log(`[rich] 工具发送卡片失败 ${key}: ${error?.message ?? error}`);
          sendJson({ ok: false, error: `发送卡片失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      // 音乐搜索（网易云/QQ音乐网页链接，海外可访问）：MCP qq_music_search
      if (req.method === 'GET' && url.pathname === '/api/social/music-search') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const q = String(url.searchParams.get('q') ?? '').trim();
        const platform = String(url.searchParams.get('platform') ?? 'all').trim();
        const limit = Math.min(10, Math.max(1, Number(url.searchParams.get('limit')) || 5));
        if (!key || !q) { sendJson({ ok: false, error: 'key 和 q 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('musicSearch')) { sendJson({ ok: false, error: '工具未启用：qq_music_search' }, 403); return; }
        if (!['all', 'netease', 'qqmusic'].includes(platform)) { sendJson({ ok: false, error: 'platform 仅支持 all/netease/qqmusic' }, 400); return; }
        try {
          const data = await musicSearch(q, platform, limit);
          sendJson({ ok: true, ...data });
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
        }
        return;
      }
      /* 【2026-09-17】视频链接解析（MCP qq_video_parse）：
       * "主人甩了个 B 站/抖音链接过来" 时先看内容再说话 —— 标题/UP主/时长/播放量/封面。
       * 只读、不发送；解析失败也不要当场编内容，把 error 原样给模型，让它说"我看不到这条"。 */
      if (req.method === 'GET' && url.pathname === '/api/social/video-parse') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const target = String(url.searchParams.get('url') ?? '').trim();
        if (!key || !target) { sendJson({ ok: false, error: 'key 和 url 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('videoSearch')) { sendJson({ ok: false, error: '工具未启用：qq_video_parse' }, 403); return; }
        try {
          const info = await resolveVideo(target);
          sendJson({ ok: true, video: info });
        } catch (error) {
          sendJson({ ok: false, error: `视频解析失败：${error?.message ?? String(error)}`, degraded: error?.degraded === true, url: target }, 200);
        }
        return;
      }
      /* 【2026-09-17】按关键词搜视频（MCP qq_video_search）：找片子/找资料用；只读。 */
      if (req.method === 'GET' && url.pathname === '/api/social/video-search') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const q = String(url.searchParams.get('q') ?? '').trim();
        const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 8));
        if (!key || !q) { sendJson({ ok: false, error: 'key 和 q 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('videoSearch')) { sendJson({ ok: false, error: '工具未启用：qq_video_search' }, 403); return; }
        try {
          const data = await videoSearch(q, { limit });
          sendJson({ ok: true, ...data });
        } catch (error) {
          sendJson({ ok: false, error: `视频搜索失败：${error?.message ?? String(error)}` }, 200);
        }
        return;
      }
      // 发送 docx 文档（写小说/长文用）：MCP qq_send_docx
      if (req.method === 'POST' && url.pathname === '/api/social/send-docx') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const title = String(body.title ?? '').trim();
        const content = String(body.content ?? '').trim();
        const replyToMessageId = body.replyToMessageId;
        if (!key || !title || !content) { sendJson({ ok: false, error: 'key、title、content 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('sendDocx')) { sendJson({ ok: false, error: '工具未启用：qq_send_docx' }, 403); return; }
        if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'default 模式发送必须携带 agent token' }, 403); return; }
        const keyMatch = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        const kind = keyMatch[1];
        const id = Number(keyMatch[2]);
        if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfgRef, currentMode)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
        if (content.length > MAX_DOCX_CHARS) { sendJson({ ok: false, error: `正文过长，最多 ${MAX_DOCX_CHARS} 字` }, 400); return; }
        let quotedInfo = null;
        let actualReplyToMessageId = replyToMessageId;
        if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
          if (!/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) { sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400); return; }
          const stForReply = getSocialState(key);
          const resolved = await resolveReplyTarget(stForReply, kind, id, String(replyToMessageId).trim());
          if (!resolved) { sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话' + replyTargetHint(key) }, 400); return; }
          quotedInfo = resolved.info;
          actualReplyToMessageId = resolved.messageId;
        }
        // 每日额度（替代审批）：按发起会话统计，每个会话每天最多 DOCX_DAILY_QUOTA 字，北京时间 0 点重置。
        const agentTokenD = String(req.headers['x-agent-token'] ?? '').trim();
        let requesterUid = '';
        if (agentTokenD) {
          for (const [ck, cst] of social.conversations.entries()) {
            if (cst && cst.agentToken && agentTokenD === cst.agentToken) {
              const m = /^private:(\d+)$/.exec(ck);
              if (m) requesterUid = m[1];
              break;
            }
          }
        }
        const quotaKey = requesterUid ? `private:${requesterUid}` : key;
        const quotaRes = docxQuotaReserve(quotaKey, content.length);
        if (!quotaRes.ok) {
          log(`[docx] 每日额度超限 ${key}：已用 ${quotaRes.used} / ${quotaRes.quota} 字（本次 ${content.length} 字）`);
          sendJson({
            ok: false,
            error: `今日长文额度已用完：该会话今天已生成 ${quotaRes.used} 字，每日上限 ${quotaRes.quota} 字，北京时间 0 点重置。可以明天再继续，或把内容拆成更短的几段。`,
            used: quotaRes.used,
            quota: quotaRes.quota
          }, 429);
          return;
        }
        const sendCfg = cfgRef.social?.send ?? {};
        const now = Date.now();
        try {
          const st = getSocialState(key);
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          const sent = await sendDocx(key, title, content, { replyToMessageId: actualReplyToMessageId });
          // 发送成功才计入每日额度
          docxQuotaCommit(quotaKey, content.length);
          log(`[docx] 已生成并发送《${String(title).slice(0, 20)}》${content.length} 字 -> ${key}（${quotaKey} 今日累计 ${docxQuota[beijingDateKey()]?.[quotaKey] ?? 0} 字）`);
          const label = `[文档:${sent.fileName}]`;
          st.recentMessages.push({
            messageId: sent.fileId ? String(sent.fileId) : null,
            sender: '我',
            text: label.slice(0, 200),
            plain: label.slice(0, 200),
            quoteTargetIsSelf: false,
            isOwner: true,
            ownerLabel: '我',
            isSelf: true,
            media: [],
            hasMedia: false,
            forwardIds: [],
            hasForward: false,
            docFile: { fileName: sent.fileName, fileId: sent.fileId, size: sent.size },
            time: Date.now()
          });
          const recentLimit = Number(cfgRef.social?.context?.recentLimit) || 100;
          if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
          const docRecord = st.recentMessages[st.recentMessages.length - 1];
          persistChatMessage(key, docRecord);
          st.lastAiReplyAt = now;
          st.lastActionAt = now;
          st.wakeConfig.noActionCount = 0;
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSocialState();
          scheduleReplyCheck(key);
          log(`[docx] 工具发送文档 ${key}: ${sent.fileName}（${sent.size} 字节）`);
          sendJson({ ok: true, key, fileName: sent.fileName, fileId: sent.fileId, size: sent.size, sent: 1, failed: 0, quoted: quotedInfo });
        } catch (error) {
          const st = getSocialState(key);
          const idx = st.sendTimes.indexOf(now);
          if (idx >= 0) st.sendTimes.splice(idx, 1);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          saveSocialState();
          log(`[docx] 工具发送文档失败 ${key}: ${error?.message ?? error}`);
          sendJson({ ok: false, error: `发送文档失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      // 完整聊天记录检索/管理：MCP qq_memory_search / qq_history_delete / qq_history_clear
      /* ── 【2026-09-21 记忆架构升级】分层长期记忆的读写入口 ──────────────────────────
       *   GET  /api/social/memory-remember  写入一条（tier/pin/category/tags/ttl）
       *   GET  /api/social/memory-notes     检索/列出（query 走 FTS5，无 query 按层级+重要度排）
       *   GET  /api/social/memory-stats     库规模 + 全文索引状态（诊断/管理端）
       * 对应 MCP 工具 qq_memory_remember / qq_memory_notes。写接口只认本会话令牌。 */
      if (req.method === 'GET' && url.pathname === '/api/social/memory-remember') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const token = req.headers['x-agent-token'];
        if (key && token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim' }, 403); return; }
        if (key && token && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (token && !ToolEnabled('memoryRemember')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remember' }, 403); return; }
        const content = String(url.searchParams.get('content') ?? '').trim();
        if (!content) { sendJson({ ok: false, error: 'content 不能为空（一句话说清要永久记住的事）' }, 400); return; }
        const uidParam = String(url.searchParams.get('uid') ?? '').trim();
        // 归属：显式 uid 优先；否则私聊记到对方头上，群聊记到主人头上（群里的规矩是主人的规矩）
        const uid = uidParam || (key.startsWith('private:') ? key.split(':')[1] : String(cfgRef?.ownerQQ ?? ''));
        const r = rememberEntry({
          uid,
          category: String(url.searchParams.get('category') ?? 'note'),
          content,
          tier: String(url.searchParams.get('tier') ?? ''),
          pinned: url.searchParams.get('pin') === '1' || url.searchParams.get('pin') === 'true',
          importance: Number(url.searchParams.get('importance')) || 0,
          ttlMs: Number(url.searchParams.get('ttlMs')) || 0,
          convKey: key,
          tags: String(url.searchParams.get('tags') ?? ''),
          source: 'model',
        });
        sendJson(r, r.ok ? 200 : 500);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/social/memory-notes') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const token = req.headers['x-agent-token'];
        if (key && token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim' }, 403); return; }
        if (key && token && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (token && !ToolEnabled('memorySearch')) { sendJson({ ok: false, error: '工具未启用：qq_memory_search' }, 403); return; }
        const uidParam = String(url.searchParams.get('uid') ?? '').trim();
        const uid = uidParam || (key.startsWith('private:') ? key.split(':')[1] : '');
        const r = listMemoryEntries({
          uid: uid || undefined,
          query: String(url.searchParams.get('query') ?? '').trim() || undefined,
          category: String(url.searchParams.get('category') ?? '').trim() || undefined,
          tier: String(url.searchParams.get('tier') ?? '').trim() || undefined,
          limit: Number(url.searchParams.get('limit')) || 20,
        });
        // 与 qq_memory_search 同一套省额度纪律：逐条截断 + 总量封顶，绝不把几万字塞回上下文
        const MAX_CHARS = 6000;
        const entries = (r.entries || []).map((e) => ({ id: e.id, tier: e.tier, category: e.category, content: String(e.content).slice(0, 200), pinned: e.pinned || undefined }));
        const out = { ok: r.ok !== false, ranked: !!r.ranked, count: entries.length, entries };
        while (out.entries.length > 1 && JSON.stringify(out).length > MAX_CHARS) { out.entries.pop(); out.truncated = true; }
        sendJson(out);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/social/memory-stats') {
        sendJson({ ok: true, ...memoryStats(), digestChars: memoryDigest({ limit: 14, maxChars: 700 }).length });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/social/history-search') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const query = String(url.searchParams.get('query') ?? '').trim();
        const sender = String(url.searchParams.get('sender') ?? '').trim();
        const date = String(url.searchParams.get('date') ?? '').trim();
        const direction = String(url.searchParams.get('direction') ?? '').trim();
        const limit = Math.min(60, Math.max(1, Number(url.searchParams.get('limit')) || 30));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        if (key && req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (key && req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('memorySearch')) { sendJson({ ok: false, error: '工具未启用：qq_memory_search' }, 403); return; }
        if (!key && !query && !sender && !date && !direction) { sendJson({ ok: false, error: '至少提供一个检索条件（key/query/sender/date/direction）' }, 400); return; }
        const result = searchChatMessages({ convKey: key || undefined, query: query || undefined, sender: sender || undefined, date: date || undefined, direction: direction || undefined, limit, offset });
        if (!result.ok) { sendJson({ ok: false, error: result.error || '检索失败' }, 500); return; }
        // 【2026-09-12 省额度：历史检索是最容易把上下文撑爆的工具】
        // 实测主人会话里两次检索（limit=200）返回 47998 + 21228 字符，而且它们**永久留在上下文里**、
        // 之后每一步都重发一遍（那个会话 46 步、每步 8.6 万 token）。三件事一起做：
        //   ① 每条正文截断（160 字够判断"说的是什么"，要细节用 qq_get_message_detail / 加 query 收窄）；
        //   ② 丢掉空字段与只给内部用的字段（media/quoteTarget/recalledAt/seq/direction…）；
        //   ③ 总量封顶，超了就明说"被截断了，收窄条件再来"——绝不让一次检索吃掉几万 token。
        const TRIM_CONTENT = 160, MAX_RESULT_CHARS = 12000;
        const msgs = (Array.isArray(result.messages) ? result.messages : []).map((m) => {
          const text = String(m.content ?? '');
          const row = {
            convKey: m.convKey,
            sender: m.isSelf ? 'me' : (m.senderName || m.senderUid || '?'),
            ts: m.ts,
            content: text.length > TRIM_CONTENT ? text.slice(0, TRIM_CONTENT) + '…' : text,
          };
          if (m.messageId) row.messageId = m.messageId;
          if (m.recalled) row.recalled = true;
          return row;
        });
        let out = { ok: true, total: result.total, count: msgs.length, messages: msgs };
        while (out.messages.length > 1 && JSON.stringify(out).length > MAX_RESULT_CHARS) { out.messages.pop(); out.truncated = true; }
        if ((result.offset || 0) + out.messages.length < result.total) out.more = true;
        if (out.truncated) out.hint = '结果过大已截断：用 query/date/sender 收窄，或用 offset 翻页';
        sendJson(out);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/history-delete') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const ids = body.ids;
        const query = String(body.query ?? '').trim();
        const sender = String(body.sender ?? '').trim();
        const date = String(body.date ?? '').trim();
        if (body.confirm !== true) { sendJson({ ok: false, error: '删除操作需 confirm:true' }, 400); return; }
        if (key && req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (key && req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('historyDelete')) { sendJson({ ok: false, error: '工具未启用：qq_history_delete' }, 403); return; }
        const result = deleteChatMessages({ convKey: key || undefined, ids, query: query || undefined, sender: sender || undefined, date: date || undefined });
        if (!result.ok) { sendJson({ ok: false, error: result.error || '删除失败' }, 400); return; }
        sendJson({ ok: true, ...result });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/history-clear') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        if (body.confirm !== true) { sendJson({ ok: false, error: '清空操作需 confirm:true' }, 400); return; }
        if (key && req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (key && req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('historyClear')) { sendJson({ ok: false, error: '工具未启用：qq_history_clear' }, 403); return; }
        const result = clearChatHistory(key);
        if (!result.ok) { sendJson({ ok: false, error: result.error || '清空失败' }, 400); return; }
        sendJson({ ok: true, ...result });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/collect-sticker') {
        if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const messageRef = String(body.messageId ?? body.seq ?? '').trim();
        const remark = String(body.remark ?? '').trim();
        if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return; }
        const keyMatch = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        const st = getSocialState(key);
        const collectCfg = cfgRef.social?.sticker?.collect ?? {};
        if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
        const now = Date.now();
        const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
        const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
        const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
        const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
        if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
          sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
          return;
        }
        // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
        st.stickerCollectTimes = st.stickerCollectTimes || [];
        st.stickerCollectTimes.push(now);
        if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
        try {
          const result = await collectSticker2(key, messageRef, remark);
          saveSocialState();
          log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
          appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
          sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
        } catch (error) {
          const idx = st.stickerCollectTimes.indexOf(now);
          if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          saveSocialState();
          log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
          sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/social/sticker-list') {
        if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
        const key = String(url.searchParams.get('key') ?? '').trim();
        const query = String(url.searchParams.get('query') ?? '').trim();
        const maxCount = Math.max(1, Number(cfgRef.social?.sticker?.maxListCount) || 100);
        const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
        let force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
        // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
        if (req.headers['x-agent-token'] && force) {
          const now = Date.now();
          if (now - lastForcedAgentStickerSync < 10000) force = false;
          else lastForcedAgentStickerSync = now;
        }
        try {
          const synced = await syncStickerLibrary(force);
          const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
          sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
        } catch (error) {
          sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      // 管理端表情库接口（控制台）
      if (req.method === 'GET' && url.pathname === '/api/stickers') {
        const query = String(url.searchParams.get('query') ?? '').trim();
        const maxCount = Math.max(1, Number(cfgRef.social?.sticker?.maxListCount) || 100);
        const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
        const force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
        try {
          const synced = await syncStickerLibrary(force);
          const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
          sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
        } catch (error) {
          sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
        try {
          const synced = await syncStickerLibrary(true);
          sendJson({ ok: true, total: synced?.entries?.length ?? stickerEntries.length, syncedAt: synced?.syncedAt ?? stickerSyncedAt });
        } catch (error) {
          sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      // 长期档案读写（SQLite）：MCP 工具 qq_profile_get/set 通过这里访问
      if (req.method === 'GET' && url.pathname === '/api/profile') {
        const uid = String(url.searchParams.get('uid') ?? '').trim();
        if (!uid) { sendJson({ ok: false, error: 'uid 不能为空' }, 400); return; }
        const p = getProfile(uid);
        sendJson({ ok: true, uid, profile: p });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/profile') {
        const body = await readBody();
        const uid = String(body.uid ?? '').trim();
        const field = String(body.field ?? '').trim();
        const value = String(body.value ?? '').trim();
        if (!uid || !field) { sendJson({ ok: false, error: 'uid 和 field 不能为空' }, 400); return; }
        try {
          const updated = setProfileField(uid, field, value);
          if (!updated) { sendJson({ ok: false, error: '写入失败（检查字段名）' }, 400); return; }
          sendJson({ ok: true, uid, field, profile: updated });
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? '写入失败' }, 400);
        }
        return;
      }
      // QZone Cookie 中转：MCP 工具 qq_qzone_view 需要 QZone 登录态（g_tk 鉴权）
      if (req.method === 'GET' && url.pathname === '/api/qzone-cookie') {
        try {
          const napcatBase = String(cfgRef.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
          const ck = await fetch(`${napcatBase}/get_cookies`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(cfgRef.napcat?.accessToken ? { authorization: `Bearer ${cfgRef.napcat.accessToken}` } : {}) },
            body: JSON.stringify({ domain: 'qzone.qq.com' }),
            signal: AbortSignal.timeout(10000)
          }).then((r) => r.json()).catch(() => null);
          if (ck?.data?.cookies) sendJson({ ok: true, cookies: ck.data.cookies });
          else sendJson({ ok: false, error: 'NapCat 未返回 QZone cookie' }, 502);
        } catch (error) {
          sendJson({ ok: false, error: `获取 QZone cookie 失败: ${error?.message ?? error}` }, 500);
        }
        return;
      }
      // 拉黑/解除拉黑（AI 印象不好时主动拉黑；owner 不能被拉黑）
      if (req.method === 'POST' && url.pathname === '/api/blacklist') {
        const body = await readBody();
        const uid = String(body.uid ?? '').trim();
        const action = String(body.action ?? '').trim(); // 'black' 或 'unblack'
        if (!uid || !/^\d{5,11}$/.test(uid)) { sendJson({ ok: false, error: 'uid 必须是 QQ 号' }, 400); return; }
        if (uid === String(cfgRef.ownerQQ ?? '')) { sendJson({ ok: false, error: '主人不能被拉黑' }, 403); return; }
        const cur = Array.isArray(cfgRef.deny?.private) ? cfgRef.deny.private.map(String) : [];
        if (action === 'black') {
          if (cur.includes(uid)) { sendJson({ ok: true, uid, blacklisted: true, already: true }); return; }
          cur.push(uid);
          cfgRef.deny.private = cur.map(Number);
          fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(cfgRef, null, 2));
          sendJson({ ok: true, uid, blacklisted: true });
        } else if (action === 'unblack') {
          cfgRef.deny.private = cur.filter((x) => x !== uid).map(Number);
          fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(cfgRef, null, 2));
          sendJson({ ok: true, uid, blacklisted: false });
        } else {
          sendJson({ ok: false, error: 'action 必须是 black 或 unblack' }, 400);
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
        const body = await readBody();
        const stickerId = String(body.stickerId ?? '').trim();
        const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
        const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
        const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
        if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
        const entry = applyStickerNote2(stickerId, note, tags, usage);
        if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
        sendJson({ ok: true, sticker: entry });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
        const body = await readBody();
        const stickerId = String(body.stickerId ?? '').trim();
        if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
        try {
          const entry = await setStickerRemark2(stickerId, String(body.remark ?? ''));
          sendJson({ ok: true, sticker: entry });
        } catch (error) {
          sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/wait') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return; }
  
    // deepsleep：静默所有群聊（总开关）或「单群静默名单」里的群——群消息不交给模型，节省 token。
    // 【2026-09-12 堵漏】原来这段整个包在 `if (kind === 'group')` 里 —— 这是对的（私聊照常），
    // 但漏了"模型正挂着 qq_wait_for_messages 时，群里来的消息会随工具结果交回模型"这条路径，
    // 那次群静默就被绕过了。现在群聊一律按静默处理；私聊仍未受影响。
    const kind = key.startsWith('group:') ? 'group' : 'private';
    if (kind === 'group') {
      const gpId = String((key || '').split(':')[1] || '');
      const silentGroups = Array.isArray(cfgRef.social?.deepsleepGroups) ? cfgRef.social.deepsleepGroups.map(String) : [];
      if (cfgRef.social?.deepsleep || silentGroups.includes(gpId)) {
        appendActivity(key + ' [' + (cfgRef.social?.deepsleep ? 'deepsleep' : '群静默') + '] 等待观察期间群聊消息已静默跳过');
        // 静默期间不等待，但必须回包：原写法直接 return 不写响应，HTTP 请求悬挂到 MCP 侧超时，
        // AI 只会拿到网络错误而不是“无新消息”。形状与下方 social.paused 分支保持一致。
        const stSilent = getSocialState(key);
        sendJson({ ok: true, key, silent: true, deepsleep: !!cfgRef.social?.deepsleep, arrived: false, timeout: false, waitedMs: 0, newMessages: [], unreadCount: stSilent.unread.length });
        return;
      }
    }
    if (social.paused) {
          const st = getSocialState(key);
          sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], unreadCount: st.unread.length });
          return;
        }
        const waitCfg = cfgRef.social?.wait ?? {};
        const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
        const defaultMs = Number(waitCfg.defaultMs) || 30000;
        const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
        const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
        const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
        const st = getSocialState(key);
        // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
        if (activeWaits.has(key)) {
          sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
          return;
        }
        activeWaits.add(key);
        const finishWait = () => activeWaits.delete(key);
        req.on('close', finishWait);
        // 长轮询期间不会有回合事件：续期看门狗，避免等待被误判为“卡死”而隔离会话
        touchTurnGuardsByKey(key);
        const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
        const suggestedQuietMs = Math.max(suggestQuietMs(st), minQuietAfterNewMs);
        const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
        // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
        // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
        // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
        const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
        const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
        if (st.pendingWakeTimer) {
          clearTimeout(st.pendingWakeTimer);
          st.pendingWakeTimer = null;
        }
        st.pendingWakeTimerStartedAt = 0;
        cancelReplyCheck(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
        // 【2026-09-11 23:05 修「等待期间吞消息」—— 主人抓到的】
        // 基线**不能**用"调用时刻的 lastUnreadSeq"：那样一来，**在调用之前就到达、但还没交给模型的消息，
        // 会被整批跳过**。实测 15:01:09/10 的 seq8/seq9 就是这么丢的：
        // 它们到达时模型正在跑一步（不在等待里）→ 被暂存 → 而新架构下回合**一直不结束**
        // → "回合结束才补发"永远不触发 → 永久丢失（主人当场说"你少读一条，笨蛋"）。
        // 改成用"已经交给模型的最高 seq"当基线：**凡是没给过它的，这次一并返回**。
        const deliveredSeq = Number(st.lastDeliveredSeq) || 0;
        // 兜底：水位线缺失时（首次运行 / 旧状态文件 / 刚重启），用 **unread 里最小 seq − 1**，
        // 保证"凡是还没标读的（= 还没交给模型处理过的）"全都会被返回。
        // ⚠️ 绝对不能用 lastUnreadSeq 兜底：那等于"只给调用之后的新消息"，
        //    会把重启前被暂存的消息永久跳过（实测 15:04 被暂存的 seq12/seq13 就是这么丢的）。
        const unreadSeqs = (Array.isArray(st.unread) ? st.unread : [])
          .map((m) => Number(m && m.seq)).filter((n) => Number.isFinite(n) && n > 0);
        const baseline = deliveredSeq > 0
          ? deliveredSeq
          : (unreadSeqs.length ? Math.min(...unreadSeqs) - 1 : (st.lastUnreadSeq || 0));
        const start = Date.now();
        let arrived = false;
        let lastNewAt = 0;
        let aborted = false;
        let lastWaitRenew = 0;
        req.on('close', () => { aborted = true; });
        // 【2026-09-11 23:15 24 小时长轮询】等待期间**没有任何桥/DSH 事件**，
        // turn-guard 的"静默 180s 判卡死 / 总时长 360s"计时器会一直往前走 →
        // 必须**周期性续期**，否则一个长轮询会被当成卡死而隔离会话（老实现只在开始/结束各续一次，
        // 所以等待超过约 3 分钟就有风险）。这里每 5 秒续一次。
        const renewGuard = () => {
          if (Date.now() - lastWaitRenew < 5000) return;
          lastWaitRenew = Date.now();
          try { touchTurnGuardsByKey(key); } catch (_) {}
        };
        while (Date.now() - start < timeoutMs && !aborted) {
          renewGuard();
          let nowSeq = st.lastUnreadSeq || 0;
          if (nowSeq - baseline >= minNew) {
            arrived = true;
            lastNewAt = Date.now();
            // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
            // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
            while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
              renewGuard();
              if ((st.lastUnreadSeq || 0) > nowSeq) {
                nowSeq = st.lastUnreadSeq || 0;
                lastNewAt = Date.now();
              }
              await sleep(200);
            }
            break;
          }
          await sleep(300);
        }
        const waitedMs = Date.now() - start;
        const preSleepWaitMs = Math.max(0, Number(cfgRef.social?.wake?.preSleepWaitMs) || 300000);
        const preSleepRemainingMs = preSleepWaitBlocked(st)
          ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
          : 0;
        const quiet = arrived && quietMs > 0 && (Date.now() - lastNewAt >= quietMs);
        // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
        // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
        const preSleepAttempt = timeoutMs >= preSleepWaitMs;
        // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
        // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
        const preSleepSatisfiedNow = !arrived
          ? waitedMs >= preSleepWaitMs
          : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs);
        if (preSleepSatisfiedNow) {
          st.preSleepWaitSatisfiedAt = Date.now();
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
        } else if (!arrived) {
          // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlocked 放行）
          st.preSleepWaitAccumMs = 0;
        } else {
          // 等待期间有新消息：
          // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
          // - 否则只清空累计，不算完成沉睡前观察。
          if (preSleepAttempt) {
            st.preSleepWaitObservedAt = Date.now();
          }
          st.preSleepWaitAccumMs = 0;
        }
        saveSocialState();
        const newMessages = arrived ? (Array.isArray(st.recentMessages) ? st.recentMessages : []).filter((m) => m && !m.isSelf && (m.seq || 0) > baseline) : [];
        // 交回给模型后推进水位线，避免同一条下次又被返回一遍（重复投喂）
        for (const m of newMessages) {
          const sq = Number(m && m.seq);
          if (Number.isFinite(sq) && sq > 0) st.lastDeliveredSeq = Math.max(Number(st.lastDeliveredSeq) || 0, sq);
        }
        const lastNew = newMessages.length ? newMessages[newMessages.length - 1] : null;
        const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
        touchTurnGuardsByKey(key); // 等待结束同样续期一次，覆盖最后一段静默与结果回传的间隙
        finishWait();
        // 【2026-09-11 主人要求：到对话阈值就换会话 —— 把闭环补上】
        // 新架构（§4.12）下"一个回合一直跑、消息由本工具取回"，于是轮换计数器 `rotateTurns`
        // 只在**唤醒**时增长 —— 而这条路不再产生唤醒 → 阈值永远到不了 → 上下文只涨不换
        // （而 compaction 还是关着的）。所以这里补上：**每等回一批新消息就算一次来回**，
        // 到阈值就明确让模型收尾。真正的切换由既有的轮换逻辑在**下一次唤醒**时执行
        // （wake-send.js 里那段 standby 切换，条件同样是 `rotateTurns >= threshold`）。
        let rotateNow = false;
        let rotateTurnsNow = Number(st.rotateTurns) || 0;
        const rotateThreshold = rotateThresholdOf(cfgRef);
        if (arrived) {
          rotateTurnsNow += 1;
          st.rotateTurns = rotateTurnsNow;
          if (rotateTurnsNow >= rotateThreshold) rotateNow = true;
        }
        // 【2026-09-11 22:58 修「已经随工具结果给过了，却又被暂存去补发」】
        // 把这次交回的 seq 记进 `turnSeenUnread`（语义 = "本回合已经给过模型"），
        // 这样 scheduleWake 的 busy 分支在**轮询刚结束那一刻**再被调用时，
        // 会看到"这条已经给过"而**不再暂存** → 不会再补发一整轮（白烧额度）。
        // 实测 22:57:28：等待工具已经把 seq3 交给模型、模型也回了，
        // 但同一时刻的另一次 scheduleWake 仍把它暂存了。
        if (arrived && newMessages.length) {
          const seen = new Set((Array.isArray(st.turnSeenUnread) ? st.turnSeenUnread : []).map(Number));
          for (const m of newMessages) {
            const sq = Number(m && m.seq);
            if (Number.isFinite(sq) && sq > 0) seen.add(sq);
          }
          st.turnSeenUnread = [...seen];
        }
        saveSocialState();
        sendJson({
          ok: true,
          key,
          arrived,
          quiet,
          quietMs,
          suggestedQuietMs,
          speakerLikelyDone: quiet,
          lastMessageUnfinished,
          timeout: !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
          waitedMs,
          preSleepWaitSatisfied: preSleepSatisfiedNow,
          preSleepWaitObserved: !!st.preSleepWaitObservedAt,
          preSleepWaitMs,
          preSleepWaitRemainingMs: preSleepRemainingMs,
          rotateNow,
          rotateTurns: rotateTurnsNow,
          // 永久会话（social.autoReset.permanent）时阈值是 Infinity，而 JSON.stringify(Infinity) = null，
          // 直接塞进去会让工具结果看起来"阈值是 null"。这里显式回 null（= 不轮换），语义清楚。
          rotateThreshold: Number.isFinite(rotateThreshold) ? rotateThreshold : null,
          rotateHint: rotateNow
            ? `[Rotate] This conversation has run for ${rotateTurnsNow} exchanges (limit ${rotateThreshold}). Wrap up NOW: send your closing reply, then close with qq_set_wake_config / qq_mark_read, and do NOT call qq_wait_for_messages again this round. A fresh session will start on the next incoming message, carrying the recent history over - so do not announce or explain any of this, just close naturally.`
            : undefined,
          newMessages,
          unreadCount: st.unread.length
        });
        return;
      }
      /* 【2026-09-15 修「qq_send_message: Invalid input: expected string, received undefined at key/token」】
       * 模型偶尔漏传 key/token（正文 [Token] 行离得太远、或它把参数名写错），而 MCP 工具的 zod schema
       * 把两者声明成必填 → 请求在**进处理器之前**就被 SDK 以 -32602 打回，模型拿不到任何有用的提示，
       * 白烧一整个模型步（线上实测该会话 ≈34k tokens/步）还答不上人。
       * 这个端点让工具侧能把缺的参数补回来（MCP 侧用 x-console-token 鉴权，等价于本机可信）：
       *   · 传了 key → 回该会话的 agent token（模型只忘了 token 的情况）；
       *   · 没传 key → 回"当前唯一在途回合"的会话（模型只忘了 key 的情况）；
       *   · 在途回合不止一个/一个都没有 → 明确回 ambiguous / no-active-turn，工具侧给可执行的提示。 */
      if (req.method === 'POST' && url.pathname === '/api/social/current-turn') {
        const body = await readBody();
        const wantKey = String(body.key ?? '').trim();
        if (wantKey) {
          const st = social.conversations.get(wantKey);
          if (!st) { sendJson({ ok: false, reason: 'unknown-key', error: `没有这个会话：${wantKey}` }, 404); return; }
          sendJson({ ok: true, key: wantKey, token: String(st.agentToken ?? ''), source: 'key' });
          return;
        }
        const active = [...activeAiTurns];
        if (active.length === 1) {
          const k = active[0];
          const st = social.conversations.get(k);
          sendJson({ ok: true, key: k, token: String(st?.agentToken ?? ''), source: 'active-turn' });
          return;
        }
        /* 【2026-09-20 主人报「pixiv 发图发错群」→ 这里就是那个"猜"的地方，已删掉】
         * 09-18 为了修"缺 key/token 报错"加的规则是：多个会话在途时按"最近活动"挑一个当目标。
         * 后果：群 A 的人要图、模型漏传 key → 图发进了当时更活跃的群 B / 主人私聊（发错群）。
         * 现在改成**绝不代替调用方选会话**：多个在途就回 ambiguous（连同在途会话列表），
         * 由调用方（MCP 工具层）明确告知模型"照抄唤醒正文的 [Session] 行"，而不是替他猜。
         * 只传了 key 的那条分支照旧（调用方已经知道自己要哪个会话，只是来拿 token）。 */
        if (active.length > 1) {
          log(`[current-turn] ${active.length} 个会话同时在途 → 回 ambiguous，不替调用方挑（避免发错群）：${active.join(', ')}`);
          sendJson({ ok: false, reason: 'ambiguous-active-turn', error: '多个会话同时在途，不能替你挑目标会话', active }, 409);
          return;
        }
        sendJson({ ok: false, reason: 'no-active-turn', active }, 409);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/check-send') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const tool = String(body.tool ?? '').trim();
        const token = String(body.token ?? '').trim();
        if (!key || !tool || !token) {
          sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
          return;
        }
        if (!agentTokenOk(key, token)) {
          sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403);
          return;
        }
        /* 直连 OneBot 的发送路径（如 qq_send_meme 不带引用时）不过 /api/social/send-message，
         * 但发之前一定会来问一次 check-send —— 跨会话闸门装在这里，那条路才关得上（见 crossSessionRefusal）。 */
        { const refuse = crossSessionRefusal(token, key, body.crossSession); if (refuse) { sendJson({ ok: false, error: refuse }, 403); return; } }
        if (!SessionAllowed(key)) {
          sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
          return;
        }
        const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
        const flag = flagMap[tool];
        if (!flag) {
          sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
          return;
        }
        if (!ToolEnabled(flag)) {
          sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
          return;
        }
        sendJson({ ok: true, key, tool });
        return;
      }
      // ── 工具调用日志 ─────────────────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/social/tool-log') {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        sendJson({ ok: true, entries: readToolLog(limit) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/tool-log/clear') {
        if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
        try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch {}
        log('控制台：工具调用日志已清空');
        sendJson({ ok: true });
        return;
      }
      // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/social/feedback') {
        sendJson({ ok: true, entries: readFeedbackEntries() });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/feedback-clear') {
        if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
        atomicWriteJson(FEEDBACK_FILE, []);
        log('控制台：清空 AI 反馈');
        sendJson({ ok: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/feedback') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
        const rawMessage = String(body.message ?? '').trim();
        if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return; }
        // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
        const fNow = Date.now();
        const fTimes = feedbackTimes.get(key) || [];
        const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
        const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
        if (fRecentMinute >= 5 || fRecentHour >= 20) {
          sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
          return;
        }
        fTimes.push(fNow);
        feedbackTimes.set(key, fTimes.slice(-100));
        const maxLength = Math.max(1, Number(cfgRef.social?.feedback?.maxLength) || 500);
        const message = rawMessage.slice(0, maxLength);
        appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
        log(`[default] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
        appendActivity(`${key} [default] AI 反馈 [${level}]：${message.slice(0, 80)}`);
        if (cfgRef.social?.feedback?.notifyOwnerOnError && level === 'error' && cfgRef.ownerQQ) {
          log(`[default] 错误级反馈，可通知 owner ${cfgRef.ownerQQ}（当前仅记录日志）`);
        }
        sendJson({ ok: true, key, level, message });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/social/my-recent') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return; }
        const st = getSocialState(key);
        const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
        sendJson({ ok: true, key, messages: mine.map(withTimeText) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/record-sent') {
        // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
        sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/social/message-detail') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const messageId = String(url.searchParams.get('messageId') ?? '').trim();
        if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return; }
        const keyMatch = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        const kind = keyMatch[1];
        const id = Number(keyMatch[2]);
        try {
          const st = getSocialState(key);
          const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
          const forwardFields = found ? {
            forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
            hasForward: !!found.hasForward
          } : {};
          let info = null;
          // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
          if (found && found.messageId && String(found.messageId) !== messageId) {
            info = {
              sender: String(found.sender || ''),
              text: String(found.text || found.plain || '').slice(0, 200),
              userId: found.userId ? String(found.userId) : null,
              messageId: String(found.messageId),
              seq: found.seq,
              timeText: fmtBeijing(Number(found.time) || 0)
            };
          } else {
            info = await resolveReplyInfo(kind, id, messageId);
            if (!info && found) {
              info = {
                sender: String(found.sender || ''),
                text: String(found.text || found.plain || '').slice(0, 200),
                userId: found.userId ? String(found.userId) : null,
                messageId: found.messageId ? String(found.messageId) : null,
                seq: found.seq,
                timeText: fmtBeijing(Number(found.time) || 0)
              };
            }
          }
          // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
          if (info && found) Object.assign(info, forwardFields);
          sendJson({ ok: true, key, messageId, info });
        } catch (error) {
          sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      // ── 读取文件内容端点（MCP qq_get_file_content 走这里） ──────────────
      // 支持 md/txt/word（docx）等文本类文件：取 OneBot 文件段 → 直链或 get_file → 解析文本返回。
      if (req.method === 'POST' && url.pathname === '/api/social/file-content') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const messageId = String(body.messageId ?? '').trim();
        const fileIndex = Math.max(0, Number(body.fileIndex) || 0);
        if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('getFileContent')) { sendJson({ ok: false, error: '工具未启用：qq_get_file_content' }, 403); return; }
        const stFile = getSocialState(key);
        const foundFileMsg = (stFile.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
        if (!foundFileMsg) { sendJson({ ok: false, error: '消息不存在（可能是较早的消息，超出了最近记录范围）' }, 404); return; }
        const msgFiles = Array.isArray(foundFileMsg.files) ? foundFileMsg.files : [];
        const file = msgFiles[fileIndex] ?? msgFiles[0];
        if (!file || (!file.fileId && !file.url)) { sendJson({ ok: false, error: '该消息没有可读取的文件' }, 404); return; }
        try {
          const result = await readFileContent(file, cfgRef.napcat);
          sendJson({ ok: true, name: String(file.name || ''), size: result.size, ext: result.ext, text: result.text, truncated: !!result.truncated, note: result.note || null });
        } catch (error) {
          sendJson({ ok: false, error: `读取文件失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
      if (req.method === 'GET' && url.pathname === '/api/social/forward-message') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const id = String(url.searchParams.get('id') ?? '').trim();
        const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
        const keyMatch = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
        if (!agentToken) {
          sendJson({ ok: false, error: 'default 模式读取合并转发必须携带 agent token' }, 403);
          return;
        }
        if (!agentTokenOk(key, agentToken)) {
          sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403);
          return;
        }
        const kind = keyMatch[1];
        const num = Number(keyMatch[2]);
        if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfgRef, currentMode)) {
          sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
          return;
        }
        if (!ToolEnabled('getForwardMsg')) {
          sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
          return;
        }
        // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
        const st = getSocialState(key);
        const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
        const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
        const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
        if (!seenInRecent && !seenInUnread && !seenInMemory) {
          sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
          return;
        }
        try {
          const data = await botRef.raw('get_forward_msg', { id });
          const formatted = formatForwardResponse(data);
          const remember = (fid) => {
            if (!fid) return;
            let set = seenForwardIds.get(key);
            if (!set) {
              set = new Set();
              seenForwardIds.set(key, set);
            }
            set.add(fid);
            if (set.size > 1000) {
              for (const old of set) {
                set.delete(old);
                if (set.size <= 1000) break;
              }
            }
          };
          // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
          for (const m of formatted.messages || []) {
            for (const fid of m.nestedForwardIds || []) remember(fid);
          }
          // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
          const nestedPreviews = [];
          const nestedIds = [];
          const seenNested = new Set();
          for (const m of formatted.messages || []) {
            for (const fid of m.nestedForwardIds || []) {
              if (!seenNested.has(fid) && nestedIds.length < 5) {
                seenNested.add(fid);
                nestedIds.push(fid);
              }
            }
          }
          for (const fid of nestedIds) {
            try {
              const ndata = await botRef.raw('get_forward_msg', { id: fid });
              const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
              for (const nm of nfmt.messages || []) {
                for (const nfid of nm.nestedForwardIds || []) remember(nfid);
              }
              nestedPreviews.push({ id: fid, ...nfmt });
            } catch (error) {
              log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
              nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
            }
          }
          sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
        } catch (error) {
          log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
          sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/forward-media') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const media = Array.isArray(body.media) ? body.media : [];
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('getForwardMsg')) { sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return; }
        if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return; }
        try {
          const images = await fetchMediaData(media);
          sendJson({ ok: true, key, media, images });
        } catch (error) {
          log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
          sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      // ── 活跃时段「目标清单」（管理端群聊活跃时段卡用：群号不写死在管理端，从桥运行态枚举）──
      // 三个来源取并集：允许名单 / 已经建过会话 / 已经设过时段的键。
      // 群名走 group-cache（有缓存直接用），缺名的最多预热 6 个、整体最多等 2.5s —— 超时先返回，
      // 预热在后台继续，管理端下次点刷新自然就带上名字（get_group_info 在 NapCat 慢时会超时）。
      if (req.method === 'GET' && url.pathname === '/api/social/targets') {
        const found = new Map(); // key -> 条目
        const add = (rawKey, name) => {
          const key = String(rawKey ?? '').trim();
          if (!/^(group|private):\d+$/.test(key)) return;
          const prev = found.get(key) || {
            key,
            kind: key.startsWith('group:') ? 'group' : 'private',
            id: key.slice(key.indexOf(':') + 1),
            name: '',
            inAllowList: false,
          };
          if (name && !prev.name) prev.name = String(name);
          found.set(key, prev);
        };
        const allowGroups = Array.isArray(cfgRef?.allow?.groups) ? cfgRef.allow.groups.map(String) : [];
        const allowPrivate = Array.isArray(cfgRef?.allow?.private) ? cfgRef.allow.private.map(String) : [];
        const markAllow = (key) => { const e = found.get(key); if (e) e.inAllowList = true; };
        for (const g of allowGroups) { add('group:' + g, getGroupDisplayName(g)); markAllow('group:' + g); }
        for (const p of allowPrivate) { add('private:' + p); markAllow('private:' + p); }
        for (const key of Object.keys(activityWindows || {})) add(key, key.startsWith('group:') ? getGroupDisplayName(key.slice(6)) : '');
        for (const key of social.conversations.keys()) add(key, key.startsWith('group:') ? getGroupDisplayName(key.slice(6)) : '');
        const missing = [...found.values()].filter((t) => t.kind === 'group' && !t.name).slice(0, 6);
        if (missing.length) {
          await Promise.race([
            Promise.all(missing.map((t) => warmGroupName(t.id).catch(() => null))),
            new Promise((r) => setTimeout(r, 2500)),
          ]);
          for (const t of missing) { const nm = getGroupDisplayName(t.id); if (nm) t.name = nm; }
        }
        const targets = [...found.values()].map((t) => {
          const st = social.conversations.get(t.key);
          const w = st?.wake || {};
          let allowed = true;
          try { allowed = isSessionAllowedInCurrentMode(t.key) !== false; } catch { allowed = true; }
          return {
            ...t,
            windows: getActivityWindows(t.key),
            inWindow: inActivityWindow(t.key) === true,
            nextWindowStart: nextActivityWindowStart(t.key) ?? null,
            unread: Array.isArray(st?.unread) ? st.unread.length : 0,
            wakeMode: String(w.mode || ''),
            allowed,
          };
        }).sort((a, b) => (a.kind === b.kind
          ? String(a.id).localeCompare(String(b.id))
          : (a.kind === 'group' ? -1 : 1)));
        sendJson({
          ok: true,
          now: Date.now(),
          deepsleep: !!cfgRef?.social?.deepsleep,
          deepsleepGroups: Array.isArray(cfgRef?.social?.deepsleepGroups) ? cfgRef.social.deepsleepGroups.map(String) : [],
          allowGroups,
          targets,
        });
        return;
      }
      // ── 活跃时段表（主人自然语言设定 → qq_set_activity_hours / qq_get_activity_hours） ──
      if (req.method === 'GET' && url.pathname === '/api/social/activity-hours') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('activityHours')) { sendJson({ ok: false, error: '工具未启用：qq_get_activity_hours' }, 403); return; }
        sendJson({ ok: true, key, windows: getActivityWindows(key), inWindow: inActivityWindow(key), nextWindowStart: nextActivityWindowStart(key) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/activity-hours') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        if (!key || !/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('activityHours')) { sendJson({ ok: false, error: '工具未启用：qq_set_activity_hours' }, 403); return; }
        const windows = Array.isArray(body.windows) ? body.windows : [];
        const parsed = [];
        for (const w of windows) {
          const wobj = w && typeof w === 'object' ? w : {};
          let s = parseClockMin(wobj.start ?? wobj[0]);
          let e = parseClockMin(wobj.end ?? wobj[1]);
          if (s === null || e === null) { sendJson({ ok: false, error: `时段格式错误（期望 start/end 为 "18:00" 这类时间）` }, 400); return; }
          // "18:00"-"01:00" 这类 end 小于 start 的按跨午夜处理（end + 24h）
          if (e <= s) e += 1440;
          if (e - s > 1440) { sendJson({ ok: false, error: '单个活跃时段不能超过 24 小时' }, 400); return; }
          parsed.push({ start: s, end: e });
        }
        if (parsed.length === 0) {
          if (activityWindows[key]) { delete activityWindows[key]; saveActivityWindows(); }
          log(`[activity] 已清除 ${key} 的活跃时段（恢复无时段约束）`);
          sendJson({ ok: true, key, windows: [], cleared: true });
          return;
        }
        activityWindows[key] = parsed;
        saveActivityWindows();
        log(`[activity] 更新 ${key} 活跃时段: ${parsed.map((w) => `${bjMinToText(w.start)}-${bjMinToText(w.end)}`).join('、')}`);
        sendJson({ ok: true, key, windows: getActivityWindows(key) });
        return;
      }
      // ── 运行时口头可调配置（主人自然语言修改 → qq_set_system_config / qq_get_system_config） ──
      if (req.method === 'GET' && url.pathname === '/api/social/tunables') {
        if (req.headers['x-agent-token'] && !agentTokenOk('private:' + String(cfgRef.ownerQQ), req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        sendJson({ ok: true, items: tunableListItems() });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/tunables') {
        const body = await readBody();
        const tunKey = String(body.key ?? '').trim();
        // 主人私聊 / 或本会话最近一条人话是主人或管理员 → 放行（见 trustLevelFor 注释）
        if (!trustLevelForToken(String(req.headers['x-agent-token'] ?? ''))) {
          sendJson({ ok: false, error: NOT_TRUSTED_MSG }, 403);
          return;
        }
        const spec = findTunable(tunKey);
        if (!spec) {
          sendJson({ ok: false, error: `未知配置项 "${tunKey}"；可用项：${TUNABLE_SPECS.map((s) => s.key).join('、')}` }, 400);
          return;
        }
        try {
          const v = applyTunable(spec, body.value);
          if (tunKey.startsWith('proactive') || tunKey === 'idleThresholdMs') rearmProactiveTimersAfterChange();
          log(`[tunable] 主人口头修改 ${tunKey}（${spec.label}）= ${JSON.stringify(v)}`);
          sendJson({ ok: true, key: tunKey, label: spec.label, value: v, items: tunableListItems() });
        } catch (e) {
          sendJson({ ok: false, error: `设置「${spec.label}」失败：${e?.message ?? e}` }, 400);
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/social/active-members') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('getActiveMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return; }
        const st = getSocialState(key);
        const map = new Map();
        for (const m of st.recentMessages) {
          if (!m || m.isSelf) continue;
          const uid = m.userId ? String(m.userId) : '';
          const key2 = uid || String(m.sender || '未知');
          const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
          if (!cur.userId && uid) cur.userId = uid;
          cur.count += 1;
          if (m.time > cur.lastTime) cur.lastTime = m.time;
          if (m.isOwner) cur.isOwner = true;
          map.set(key2, cur);
        }
        const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
        sendJson({ ok: true, key, members });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/social/group-members') {
        // 群成员/群主查询（带会话令牌）：返回全部成员（含 role=owner/admin/member）+ 群主 + 管理员摘要。
        const key = String(url.searchParams.get('key') ?? '').trim();
        const groupId = String(url.searchParams.get('groupId') ?? '').trim();
        if (!key || !key.startsWith('group:')) { sendJson({ ok: false, error: 'key 必须是 group:群号' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('getGroupInfo')) { sendJson({ ok: false, error: '工具未启用：qq_get_group_owner / qq_get_group_members' }, 403); return; }
        const g = groupId || key.split(':')[1];
        try {
          const list = await botRef.getGroupMemberList(Number(g));
          const raw = Array.isArray(list) ? list : (list?.data ?? []);
          const members = raw.slice(0, 500).map((m) => ({
            user_id: m.user_id,
            nickname: m.nickname ?? '',
            card: m.card ?? '',
            role: String(m.role ?? 'member')
          }));
          const owner = members.find((m) => m.role === 'owner') ?? null;
          const admins = members.filter((m) => m.role === 'admin');
          sendJson({ ok: true, group_id: Number(g), member_count: raw.length, owner, admins, members });
        } catch (error) {
          sendJson({ ok: false, error: `获取群成员失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/admin-set') {
        // 管理员授权/取消（模型按自然语言调用；仅主人私聊会话可用）
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const token = String(body.token ?? '').trim();
        const uid = String(body.uid ?? '').trim();
        const action = String(body.action ?? '').trim();
        if (!key || !/^\d{5,11}$/.test(uid) || !['grant', 'revoke'].includes(action)) { sendJson({ ok: false, error: '参数：key/uid(QQ号)/action(grant|revoke)' }, 400); return; }
        if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (!SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (!ToolEnabled('adminSet')) { sendJson({ ok: false, error: '工具未启用：qq_admin_set' }, 403); return; }
        if (!trustLevelFor(key, token)) { sendJson({ ok: false, error: NOT_TRUSTED_MSG }, 403); return; }
        const cur = Array.isArray(cfgRef.adminQQ) ? cfgRef.adminQQ.map(String) : [];
        let changed = false;
        if (action === 'grant') {
          if (!cur.includes(uid)) { cur.push(uid); cfgRef.adminQQ = cur.map(Number); changed = true; }
        } else if (cur.includes(uid)) {
          cfgRef.adminQQ = cur.filter((x) => x !== uid).map(Number);
          changed = true;
        }
        if (changed) fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(cfgRef, null, 2));
        sendJson({ ok: true, action, uid, adminQQ: (Array.isArray(cfgRef.adminQQ) ? cfgRef.adminQQ.map(Number) : []), changed });
        log(`[command] admin-set ${action} ${uid} by ${key}（changed=${changed}）`);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/whitelist') {
        // 群白名单加/移（模型按自然语言调用；仅主人私聊会话可用）
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const token = String(body.token ?? '').trim();
        const groupId = String(body.groupId ?? '').trim();
        const action = String(body.action ?? '').trim();
        if (!key || !/^\d{5,12}$/.test(groupId) || !['add', 'remove'].includes(action)) { sendJson({ ok: false, error: '参数：key/groupId(群号)/action(add|remove)' }, 400); return; }
        if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (!SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (!ToolEnabled('whitelist')) { sendJson({ ok: false, error: '工具未启用：qq_whitelist' }, 403); return; }
        if (!trustLevelFor(key, token)) { sendJson({ ok: false, error: NOT_TRUSTED_MSG }, 403); return; }
        const cur = Array.isArray(cfgRef.allow?.groups) ? cfgRef.allow.groups.map(String) : [];
        let changed = false;
        if (action === 'add') {
          if (!cur.includes(groupId)) { cur.push(groupId); cfgRef.allow.groups = cur.map(Number); changed = true; }
        } else if (cur.includes(groupId)) {
          cfgRef.allow.groups = cur.filter((x) => x !== groupId).map(Number);
          changed = true;
        }
        if (changed) fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(cfgRef, null, 2));
        sendJson({ ok: true, action, groupId, groups: (Array.isArray(cfgRef.allow?.groups) ? cfgRef.allow.groups.map(Number) : []), changed });
        log(`[command] whitelist ${action} ${groupId} by ${key}（changed=${changed}）`);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/memory-append') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const category = String(body.category ?? '').trim();
        const content = String(body.content ?? '').trim();
        const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
        if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
        if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
        if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return; }
        const st = getSocialState(key);
        appendMemory(st, category, content, extra);
        sendJson({ ok: true, key, category, content, memory: formatMemory(st) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/memory-update') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const category = String(body.category ?? '').trim();
        const oldContent = String(body.oldContent ?? '').trim();
        const target = redactKnownTokensOnly(String(body.target ?? '').trim());
        const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
        const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
        const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
        const cleanNewExtra = {
          ...newExtra,
          pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
          participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
          motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
          target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
        };
        if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
        if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
        if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }
        if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }
        const st = getSocialState(key);
        if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
          const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
          if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return; }
          if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
          if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
          if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
        } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
          const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
          if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return; }
          if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
          if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
          if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
        } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
          const oldTarget = target;
          if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
          const im = st.memberImpressions[oldTarget] || {};
          const newTarget = String(cleanNewExtra.target || oldTarget).trim();
          if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
          if (newContent !== undefined) {
            im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
          }
          if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
          if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
          st.memberImpressions[newTarget] = im;
        }
        saveSocialState();
        sendJson({ ok: true, key, category, memory: formatMemory(st) });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/social/memory') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const category = String(url.searchParams.get('category') ?? '').trim();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return; }
        const st = getSocialState(key);
        const raw = {
          activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
          pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
          memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
        };
        if (category === 'activeTopic') {
          raw.pendingThoughts = [];
          raw.memberImpressions = {};
        } else if (category === 'pendingThought') {
          raw.activeTopics = [];
          raw.memberImpressions = {};
        } else if (category === 'memberImpression') {
          raw.activeTopics = [];
          raw.pendingThoughts = [];
        }
        sendJson({ ok: true, key, category, formatted: formatMemory({ ...st, ...raw }), raw });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/memory-remove') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const category = String(body.category ?? '').trim();
        const content = String(body.content ?? '').trim();
        const target = String(body.target ?? '').trim();
        if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
        if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
        if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return; }
        if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
        if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return; }
        const st = getSocialState(key);
        if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
          st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
        } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
          st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
        } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
          delete st.memberImpressions[target];
        }
        saveSocialState();
        sendJson({ ok: true, key, category, memory: formatMemory(st) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/memory-clear') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const category = String(body.category ?? '').trim();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return; }
        const st = getSocialState(key);
        if (!category || category === 'activeTopic') st.activeTopics = [];
        if (!category || category === 'pendingThought') st.pendingThoughts = [];
        if (!category || category === 'memberImpression') st.memberImpressions = {};
        saveSocialState();
        sendJson({ ok: true, key, category: category || 'all', memory: formatMemory(st) });
        return;
      }
      // ── default黑话学习（default）：AI 查询/提交黑话候选 ─────────────────
      if (req.method === 'GET' && url.pathname === '/api/social/slang/query') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('slangQuery')) { sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return; }
        const list = confirmedSlangList().filter((e) => {
          if (!q) return true;
          return e.content.toLowerCase().includes(q)
            || e.meaning.toLowerCase().includes(q)
            || e.usage.toLowerCase().includes(q)
            || e.example.toLowerCase().includes(q);
        });
        sendJson({
          ok: true,
          key,
          total: list.length,
          entries: list,
          block: buildSlangContext(slangEntries, cfgRef.slang?.injectMax ?? 8)
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/social/slang/submit') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const token = String(body.token ?? '').trim();
        const content = redactKnownTokensOnly(String(body.content ?? '')).trim();
        const context = redactKnownTokensOnly(String(body.context ?? '')).trim();
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403); return; }
        if (req.headers['x-agent-token'] && !SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
        if (req.headers['x-agent-token'] && !ToolEnabled('slangSubmit')) { sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return; }
        if (cfgRef.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return; }
        if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return; }
        if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return; }
        if (!allowSlangSubmit(key)) { sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return; }
        /* 【2026-09-19 修「学过的黑话又变成候选」】这里以前用 `e.content === content` 完全相等匹配，
         * 所以模型把已确认的词换个写法提交（多空格、多标点、大小写不同）就会被判成"新词"，
         * 走到下面去新建一条 candidate —— 主人看到的"学过了还在候选里"就有这一份。
         * 改用与 upsertSlangEntry 同一套归一化键（slangKey）。 */
        const submitKey = slangKey(content);
        const existing = submitKey
          ? slangEntries.find((e) => slangKey(e.content) === submitKey)
          : slangEntries.find((e) => e.content === content);
        if (existing) {
          if (existing.status === SLANG_STATUS.CONFIRMED) {
            sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: publicSlangEntry(existing) });
            return;
          }
          if (existing.status === SLANG_STATUS.REJECTED) {
            sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
            return;
          }
          // candidate：累计出现次数并追加语境证据
          existing.count = (Number(existing.count) || 0) + 1;
          if (context) {
            existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
          }
          existing.updatedAt = new Date().toISOString();
          saveSlangStore();
          if (cfgRef.slang?.autoResearch !== false) {
            const thresholds = Array.isArray(cfgRef.slang?.inferenceThresholds) ? cfgRef.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
            if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
              queueSlangTask(() => runSlangResearch([existing]));
            }
          }
          log(`[default] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
          sendJson({ ok: true, duplicate: true, status: 'candidate', entry: publicSlangEntry(existing) });
          return;
        }
        const entry = createSlangEntry({
          content,
          source: 'ai',
          status: SLANG_STATUS.CANDIDATE,
          evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
        });
        slangEntries.push(entry);
        saveSlangStore();
        if (cfgRef.slang?.autoResearch !== false) {
          queueSlangTask(() => runSlangResearch([entry]));
        }
        log(`[default] AI 提交黑话候选「${content}」(${key})`);
        appendActivity(`${key} [default] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
        sendJson({ ok: true, entry: publicSlangEntry(entry) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
        const body = await readBody();
        const key = String(body.key ?? '').trim();
        const token = String(body.token ?? '').trim();
        const keyMatch = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        if (!agentTokenOk(key, token)) {
          sendJson({ ok: false, error: 'Legacy read-only tools are unavailable in default mode; use the session-token tools instead.' }, 403);
          return;
        }
        const kind = keyMatch[1];
        const id = Number(keyMatch[2]);
        if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfgRef, currentMode)) {
          sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
          return;
        }
        sendJson({ ok: true, key });
        return;
      }
      // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
      if (req.method === 'GET' && url.pathname === '/api/images/message') {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const messageId = String(url.searchParams.get('messageId') ?? '').trim();
        const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
        const keyMatch = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
        if (!agentToken) {
          sendJson({ ok: false, error: 'default 模式读取图片必须携带 agent token' }, 403);
          return;
        }
        if (agentToken && !agentTokenOk(key, agentToken)) {
          sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim; the same value also authorizes cross-session view/actions' }, 403);
          return;
        }
        const kind = keyMatch[1];
        const id = Number(keyMatch[2]);
        if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfgRef, currentMode)) {
          sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
          return;
        }
        if (agentToken && !ToolEnabled('getImages')) {
          sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
          return;
        }
        const found = findMessageMedia(key, messageId, { info: true });
        const media = Array.isArray(found?.media) ? found.media : [];
        if (!media.length) {
          sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据（也没有引用到带图的消息）' });
          return;
        }
        try {
          /* raw=1：**转发用**，要原图字节（不做压缩/降采样）。默认（喂给视觉模型那条路）照旧压缩，
           * 因为那条路受 DSH 附件层的单边上限约束、也直接吃 token。 */
          const raw = url.searchParams.get('raw') === '1';
          const images = await fetchMediaData(media, { raw });
          /* viaQuote：这张图其实是**被引用的那条消息**里的（主人引用着自己的图让你转发就是这种）。
           * foundIn：跨会话时图往往在**发起会话**里而 key 是目的地，如实报出到底在哪个会话找到的。 */
          sendJson({ ok: true, messageId, media, images, raw, viaQuote: !!found?.viaQuote, quoteMessageId: found?.quoteMessageId || '', foundIn: found?.foundIn || key });
        } catch (error) {
          log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
          sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
        }
        return;
      }

      // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
      if (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) {
        const body = await readBody();
        const token = String(body.token ?? '').trim();
        const isPrivate = url.pathname === '/api/send/private';
        const isReply = url.pathname === '/api/send/reply';
        const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
        const message = unquoteJsonString(String(body.message ?? '').trim());
        const replyToMessageId = isReply ? body.replyToMessageId : body.replyToMessageId;
        const atUserId = body.atUserId ?? null;
        const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
        // 安全边界：default（default AI）发送必须携带有效会话令牌；聊天自动转发时代已删除，此路径不再有“无令牌管理员直发”分支。
        if (social.paused && token) {
          sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
          return;
        }
        if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return; }
        if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
        if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
          sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
          return;
        }
        if (!token || !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'default 模式发送必须携带有效 agent token' }, 403); return; }
        const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
        if (token && !ToolEnabled(flag)) { sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return; }
        if (shouldBlockSilentReply(key)) {
          sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
          return;
        }
        const keyMatch = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
        const kind = keyMatch[1];
        const id = Number(keyMatch[2]);
        if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfgRef, currentMode)) {
          sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
          return;
        }
        if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
          sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
          return;
        }
        let quotedInfo = null;
        let actualReplyToMessageId = replyToMessageId;
        if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
          const stForReply = getSocialState(key);
          const resolved = await resolveReplyTarget(stForReply, kind, id, String(replyToMessageId).trim());
          if (!resolved) {
            sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' + replyTargetHint(key) }, 400);
            return;
          }
          quotedInfo = resolved.info;
          actualReplyToMessageId = resolved.messageId;
        }
        const sendCfg = cfgRef.social?.send ?? {};
        const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
        if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return; }
        if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
        // st/now 必须声明在 try 之外：catch 里的发送额度回滚块要用到它们，
        // 若声明在 try 内，失败分支会先抛 ReferenceError，预占的额度永远不会回滚（假 429）。
        const st = getSocialState(key);
        const now = Date.now();
        // 【2026-09-16 幂等闸门】与批量端点同一套账：上一批部分失败后模型拿这条旧正文再发一次 → 挡下（见 send-idempotency.js）。
        const idemOne = filterAlreadySentBubbles(key, [message], now);
        if (idemOne.skipped.length) {
          logIdempotencyBlock(key, idemOne, '上一批发送部分失败，这是模型把已送出的那条再发一次');
          appendActivity(`${key} [send] 幂等挡下重复的已发消息：${String(message).slice(0, 40)}`);
          sendJson({
            ok: true, key, sent: 0, failed: 0, skipped: idemOne.skipped.length,
            note: '这条上一批已经真的发出去了，本次不再重复发送；请直接收尾，不要重发。'
          });
          return;
        }
        /* 【2026-09-22 撤掉收尾回执闸门】上一轮在这里加过一道"本回合已发过内容就不再发 `OK/好了/已发送`"的桥侧
         * 闸门（`lib/ack-text.js` + turnHasBubble）。主人看到后的意见是：**不用强迫，无伤大雅** —— 收尾那句
         * 交给提示词说清楚就够了（preset `[RULES] 13 CLOSING_OK`：说完用工具之后，正文以单独一个 `OK` 收尾），
         * 桥不再替模型决定该不该说这一句。删掉闸门同时也删掉了它对发送链的一次隐式改写：
         * 发送端点回到"模型让发什么就发什么"的单一语义（幂等闸门仍然照旧拦重复）。 */
        // 【2026-09-16 触发源拦截】同批量端点：atUserId 像是 messageId → 降级为不带 @ 发送（不报错、不整批失败）
        const atJudgeOne = judgeAtUserId(atUserId, collectAtUserIdEvidence(st));
        let atUserOne = atUserId;
        let atNoteOne = '';
        let atDroppedOne = null;
        if (!atJudgeOne.ok) {
          atUserOne = null;
          logAtUserIdDowngrade(key, atJudgeOne);
          atNoteOne = atUserIdDowngradeNote(atJudgeOne);
          atDroppedOne = { atUserId: atJudgeOne.id, reason: atJudgeOne.reason };
          appendActivity(`${key} [send] atUserId=${atJudgeOne.id} 降级为不带 @ 发送（${atJudgeOne.reason}）`);
        }
        try {
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          // 防重复：90 秒内重复发送相同/高度相似文本 → 拦截（与发送同一套去重，堵住新旧两条发送路径）
          const dupText = String(message ?? '').trim();
          const prevDup = lastSendDedup.get(key);
          if (prevDup && now - prevDup.at < 90000 && dupText && isDuplicateSendText(prevDup.text, dupText)) {
            st.lastAiReplyAt = now;
            saveSocialState();
            sendJson({ ok: false, error: '检测到短时间内重复发送相同内容（疑似重复回复），已阻止本次发送并结束当前回合。请停止重复回复，直接收尾。' }, 409);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          const sentMessages = await sendMessages(key, [message], [], actualReplyToMessageId, atUserOne);
          recordSentMessages(key, sentMessages);
          noteBatchOutcome(key, { attempted: [message], delivered: sentMessages, failed: [] }, now);
          if (dupText) lastSendDedup.set(key, { text: dupText, at: now });
          st.lastAiReplyAt = now;
          st.lastActionAt = now;
          st.wakeConfig.noActionCount = 0;
          saveSocialState();
          log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
          appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
          if (sentMessages.length > 0) scheduleReplyCheck(key);
          sendJson({
            ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo,
            ...(atDroppedOne ? { atUserIdDropped: atDroppedOne, hint: atNoteOne } : {})
          });
        } catch (error) {
          if (error?.sent?.length) {
            recordSentMessages(key, error.sent);
            log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
          }
          // 单条端点同样登记（异常里若带着已发条目，模型重发同一条时会被幂等闸门挡下）
          noteBatchOutcome(key, { attempted: [message], delivered: Array.isArray(error?.sent) ? error.sent : [], failed: [1] }, now);
          log('[send] 统一发送失败栈:', error?.stack ? error.stack.split(String.fromCharCode(10)).slice(0, 8).join(' | ') : (error?.message || String(error)));
          // 失败/未发出的消息回滚预占的发送额度，避免假 429。
          const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
          const failedCount = Math.max(0, 1 - sentCount);
          for (let i = 0; i < failedCount; i++) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
          }
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          saveSocialState();
          sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
        }
        return;
      }
      // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/session/reset') {
        const body = await readBody();
        const key = String(body.key ?? '');
        if (!key || !state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
        bumpSessionEpoch();
        cancelKeyedSends(key); // 取消该会话已入链的旧发送任务
        const oldSessionId = state.sessions[key];
        delete state.sessions[key];
        reverse.delete(oldSessionId);
        collectors.delete(oldSessionId);
        sendToolSucceededSessions.delete(oldSessionId);
        pendingSendToolCalls.delete(oldSessionId);
        TurnStartAt.delete(oldSessionId);
        toolCallNames.delete(oldSessionId);
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
        silentTurnQueue.delete(oldSessionId);
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
        // 【2026-09-16】清上下文但保留「已回复账本」：重置后同一批消息不再被当成没回过而重复回复。
        const carriedSingle = resetConversationKeepingLedger(key);
        if (!carriedSingle) log(`[reset] ${key} 无账本需要保留（该会话此前没有已回复记录）`);
        // 重建账本会重新装配该会话的定时器；本端点的语义是"清完等下次唤醒重建"，所以再清一次。
        clearSocialTimers(key);
        seenForwardIds.delete(key);
        saveSocialState();
        saveState();
        try { await apiRef.workspace.archiveSession({ sessionId: oldSessionId }); } catch {}
        log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已归档）`);
        sendJson({ ok: true, key, archived: oldSessionId });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
        bumpSessionEpoch();
        cancelAllKeyedSends(); // 取消全部已入链的旧发送任务
        let archivedCount = 0;
        // rc.1 无 workspace/list：改为枚举本桥活跃会话集（正式映射 + 学习者），逐一归档；
        // workspace/delete 在 rc.1 无等价物，跳过（本地 state 清理见下）。
        try {
          const seenSids = new Set();
          for (const sid of reverse.keys()) if (sid && !seenSids.has(sid)) seenSids.add(sid);
          for (const sid of learnerSessions ?? []) if (sid && !seenSids.has(sid)) seenSids.add(sid);
          for (const sid of state?.sessions ? Object.values(state.sessions) : []) if (sid && !seenSids.has(sid)) seenSids.add(sid);
          for (const sid of seenSids) {
            try { await apiRef.workspace.archiveSession({ sessionId: sid }); archivedCount += 1; } catch {}
          }
        } catch {}
        for (const entry of pending.values()) {
          clearTimeout(entry.timer);
          cancelPendingEntry(entry).catch(() => {});
        }
        pending.clear();
        queued.clear();
        queuedHintAt.clear();
        sessionPromises.clear();
        drainAllPromptQueues('工作区已清空');
        messageMediaStore.clear();
        seenForwardIds.clear();
        silentTurnQueue.clear();
        slangWindows.clear();
        slangExtractionCooldowns.clear();
        slangSubmitTimes.clear();
        clearAllSocialTimers();
        for (const st of social.conversations.values()) {
          if (st?.agentToken) KNOWN_AGENT_TOKENS.delete(st.agentToken);
        }
        /* 【2026-09-16】"清空工作区"同样是 reset 家族的一员，一样会把「已回复账本」抹掉。
         * 这里逐个会话走"清状态、留账本"，避免清空工作区之后同一批历史消息被重新回一遍。 */
        let keptLedger = 0;
        for (const key of [...social.conversations.keys()]) {
          if (resetConversationKeepingLedger(key)) keptLedger += 1;
        }
        clearAllSocialTimers(); // 重建账本会重新装配定时器；本端点语义是"全清"，再清一次
        saveSocialState();
        state.sessions = {};
        reverse.clear();
        collectors.clear();
        sendToolSucceededSessions.clear();
        pendingSendToolCalls.clear();
        TurnStartAt.clear();
        toolCallNames.clear();
        saveState();
        try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch {}
        log(`控制台：已清空 QQ 聊天工作区（归档 ${archivedCount} 个会话，映射与活动日志已清空；${keptLedger} 个会话的已回复账本已保留）`);
        sendJson({ ok: true, archivedCount, keptLedgerKeys: keptLedger });
        return;
      }
      // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/restart') {
        sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
        setTimeout(() => {
          log('控制台：重启桥接');
          releaseLock();
          process.exit(0);
        }, 500);
        return;
      }
      // ── 语音（MiMo-V2.5-TTS / VoiceDesign / VoiceClone / ASR）────────────────────
      // 配置与试听走管理端（consoleToken 统一校验，见上方）；发送/识别走 agent token + 白名单，与其它发送工具同规矩。
      // 模块动态 import：开发期文件缺失时不影响其它路由。
      if (url.pathname.startsWith('/api/voice/')) {
        let voiceMod;
        try {
          voiceMod = await import('../core/voice.js');
        } catch (error) {
          log(`控制台：语音模块加载失败：${error?.message ?? error}`);
          sendJson({ ok: false, error: 'voice module unavailable' }, 503);
          return;
        }
        const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody();

        // 配置读取（密钥只回掩码）
        if (req.method === 'GET' && url.pathname === '/api/voice/config') {
          sendJson(voiceMod.voiceConfigPublic());
          return;
        }
        // 配置保存
        if (req.method === 'PUT' && url.pathname === '/api/voice/config') {
          try {
            sendJson(voiceMod.saveVoiceConfig(body));
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          }
          return;
        }
        // 音色库
        if (req.method === 'GET' && url.pathname === '/api/voice/voices') {
          sendJson(voiceMod.listVoices());
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/voice/voices') {
          try {
            sendJson(voiceMod.saveCustomVoice({ name: body.name, kind: body.kind, description: body.description, sampleBase64: body.sampleBase64 }));
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          }
          return;
        }
        if (req.method === 'DELETE' && url.pathname === '/api/voice/voices') {
          try {
            sendJson(voiceMod.deleteCustomVoice(url.searchParams.get('id')));
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          }
          return;
        }
        // 试听（管理端）：合成完把音频 base64 回给界面直接播
        if (req.method === 'POST' && url.pathname === '/api/voice/preview') {
          try {
            const text = String(body.text ?? '').trim() || '你好呀，这是音色试听。';
            // 【2026-09-15 补】音色库里**已保存**的音色用 voiceId 试听：管理端手里没有复刻样本的
            // base64（样本存在桥侧 state 里），只靠 mode/sampleBase64 是没法试听"复刻型音色"的
            // ——早先那样点试听会报「音色复刻需要音频样本」。这里按 id/名字查库后再合成。
            const voiceId = String(body.voiceId ?? '').trim();
            const hit = voiceId
              ? (voiceMod.listVoices().custom.find((v) => v.id === voiceId || v.name === voiceId) || null)
              : null;
            if (voiceId && !hit) {
              sendJson({ ok: false, error: `音色库里没有「${voiceId}」这个音色（可能是刚被删除，刷新一下再看）` }, 400);
              return;
            }
            const r = hit
              ? await voiceMod.synthesizeWithSavedVoice(text, hit.id, { style: body.style, format: body.format })
              : await voiceMod.synthesize({
                text,
                mode: body.mode,
                voice: body.voice,
                style: body.style,
                description: body.description,
                sampleBase64: body.sampleBase64,
                format: body.format
              });
            const buf = fs.readFileSync(r.filePath);
            sendJson({
              ok: true, mime: r.mime, audioBase64: buf.toString('base64'), bytes: r.bytes,
              cached: r.cached, ms: r.ms, finalTextPreview: r.finalTextPreview, mode: r.mode,
              voiceName: hit ? hit.name : ''
            });
            log(`控制台：语音试听（${r.mode}${hit ? `，音色=${hit.name}` : ''}）${text.slice(0, 18)}… → ${r.bytes} 字节${r.cached ? '（缓存）' : ''}`);
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          }
          return;
        }
        // 连通性自检
        if (req.method === 'POST' && url.pathname === '/api/voice/test') {
          try {
            sendJson(await voiceMod.testRole(String(body.role ?? 'tts')));
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          }
          return;
        }
        // 发送语音（模型工具 qq_send_voice）：与文字发送同一套令牌/白名单/限频规矩
        if (req.method === 'POST' && url.pathname === '/api/voice/send') {
          const key = String(body.key ?? '').trim();
          const token = String(req.headers['x-agent-token'] ?? '').trim();
          if (!token) { sendJson({ ok: false, error: '语音发送必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim' }, 403); return; }
          if (!SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          const km = /^(group|private):(\d+)$/.exec(key);
          if (!km) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = km[1];
          const id = Number(km[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfgRef, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          const st = getSocialState(key);
          const now = Date.now();
          const sendCfgV = cfgRef.social?.send ?? {};
          const maxPerMinuteV = Number(sendCfgV.maxSendPerMinute) || 0;
          const recentMinuteV = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          if (maxPerMinuteV > 0 && recentMinuteV + 1 > maxPerMinuteV) { sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429); return; }
          let sent = null;
          try {
            // 自定义音色（音色库里的 id/名字）→ 走它的描述或样本；否则按内置音色
            const lib = voiceMod.listVoices();
            const want = String(body.voice ?? '').trim();
            const hit = want ? lib.custom.find((v) => v.id === want || v.name === want) : null;
            // 【2026-09-16 主人报「我设了自定义音色却一直用内置冰糖」】根因是模型自己显式传了内置音色。
            // 这里把"显式指定覆盖了主人默认音色"这件事**如实记一条日志**，以后一眼能看出来；
            // 真正的修正靠提示词（唤醒正文每轮都带 default voice=<主人设的那个>）+ preset/工具描述。
            try {
              const cfgNow = voiceMod.voiceConfig?.() ?? {};
              const curDefault = String(cfgNow.defaultVoice ?? '').trim();
              if (want && curDefault && want !== curDefault) {
                const hitDef = (lib.custom || []).find((v) => v.id === curDefault || v.name === curDefault);
                const builtin = (lib.builtin || []).some((v) => v.id === want || v.name === want);
                if (builtin && hitDef) {
                  log(`[voice] 注意：模型显式指定了内置音色「${want}」，覆盖了主人配置的默认音色「${hitDef.name || curDefault}」（提示词里已写明默认音色，若仍反复出现说明模型没照办）`);
                }
              }
            } catch { /* 仅日志，不影响发送 */ }
            const text = String(body.text ?? '').trim();
            const r = hit
              ? await voiceMod.synthesizeWithSavedVoice(text, hit.id, { style: body.style, format: body.format })
              : await voiceMod.synthesize({
                text,
                mode: body.mode,
                voice: want,
                style: body.style,
                description: body.description,
                format: body.format
              });
            const out = await voiceMod.sendVoiceToOneBot(key, r.filePath, { replyToMessageId: body.replyToMessageId });
            sent = { messageId: out.messageId, bytes: out.bytes, format: out.format };
            // 登记「这个会话刚发过语音」：唤醒提示词的抽签靠它做冷却，避免概率虽小却连发两条
            try { if (typeof voiceMod.noteVoiceSent === 'function') voiceMod.noteVoiceSent(key); } catch { /* 忽略 */ }
            // 登记自己发过这条语音（不登记模型会忘记，还会重复发）
            try {
              recordSentMessages(key, [{ messageId: out.messageId, text: `[语音] ${text.slice(0, 60)}` }]);
            } catch (eReg) { log(`[voice] 语音回执登记失败（不影响发送）: ${eReg?.message ?? eReg}`); }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            if (st.wakeConfig) st.wakeConfig.noActionCount = 0;
            saveSocialState();
            if (typeof scheduleReplyCheck === 'function') scheduleReplyCheck(key);
            appendActivity(`${key} [voice] 语音已发送：${text.slice(0, 30)}（${r.bytes} 字节${r.cached ? '，缓存' : ''}）`);
            sendJson({
              ok: true, sent, voice: hit ? { id: hit.id, name: hit.name } : { id: want || 'default' },
              chars: text.length, cached: r.cached, ms: r.ms, finalTextPreview: r.finalTextPreview
            });
          } catch (error) {
            // 语音失败绝不影响对话：明确告诉模型「改用文字回复」，不要重试到烧钱
            log(`[voice] 发送语音失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `${error?.message ?? error}（语音没发出去；这条内容请改用文字发送，不要反复重试）` }, 502);
          }
          return;
        }
        // 语音识别（模型工具 qq_transcribe_voice）
        if (req.method === 'POST' && url.pathname === '/api/voice/transcribe') {
          const key = String(body.key ?? '').trim();
          const token = String(req.headers['x-agent-token'] ?? '').trim();
          if (!token) { sendJson({ ok: false, error: '语音识别必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'Invalid agent token - use the [Token] value at the top of the latest wake prompt, copied verbatim' }, 403); return; }
          if (!SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!ToolEnabled('transcribeVoice')) { sendJson({ ok: false, error: '工具未启用：qq_transcribe_voice' }, 403); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          try {
            const { buf } = await voiceMod.fetchVoiceFromMessage(body.messageId);
            const r = await voiceMod.transcribeBuffer(buf, { language: body.language });
            log(`控制台：语音识别 ${key} messageId=${body.messageId} → ${r.text.slice(0, 40)}`);
            sendJson({ ok: true, messageId: String(body.messageId ?? ''), text: r.text, ms: r.ms, format: r.format });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 502);
          }
          return;
        }
        sendJson({ ok: false, error: `未知语音接口：${url.pathname}` }, 404);
        return;
      }

      // ── NapCat 鉴权令牌（WebUI / HTTP / WS）真正落地 ─────────────────────────────
      // 【2026-09-15 主人反馈】管理端改「NapCat 令牌」只改了桥 config.json 里"期望用哪个"，
      // 从没写进 NapCat 自己的配置 → NapCat 还收默认 truefriend、旧令牌照样能进。
      // 这里把三个令牌写进 NapCat 的 webui.json / onebot11*.json，并重启容器（docker restart -t 60，
      // 宽限 60s：NapCat 的 PID1 不转发 SIGTERM，来不及就是 SIGKILL —— 参见 napcat-tokens.js 的说明）；
      // 写完同时把桥 config.json 的 napcat.accessToken / wsAccessToken 对齐（否则桥用新令牌连不上旧配置）。
      if (url.pathname === '/api/napcat/tokens') {
        let tokMod;
        try {
          tokMod = await import('../core/napcat-tokens.js');
        } catch (error) {
          log(`控制台：NapCat 令牌模块加载失败：${error?.message ?? error}`);
          sendJson({ ok: false, error: 'napcat-tokens module unavailable' }, 503);
          return;
        }
        if (req.method === 'GET') {
          // 【2026-09-16】napcatTokenStatus 现在是 async（顺带查 NapCat 的 QQ 登录态）
          sendJson(await tokMod.napcatTokenStatus());
          return;
        }
        if (req.method === 'POST') {
          const body = await readBody();
          try {
            // 【2026-09-15 主人反馈"这个界面重复了"】合并成一处之后，管理端不需要再手抄令牌：
            // useBridgeTokens=true 就用**桥配置里现在这两个令牌**去写 NapCat（HTTP/WS），
            // WebUI 令牌没单独填时也用它 —— 语义就是"让三处一致成桥里那个令牌"。
            const useBridge = body?.useBridgeTokens === true;
            const bridgeHttp = String(cfgRef?.napcat?.accessToken ?? '').trim();
            const bridgeWs = String(cfgRef?.napcat?.wsAccessToken ?? '').trim() || bridgeHttp;
            const payload = {
              webuiToken: String(body?.webuiToken ?? '').trim() || (useBridge ? bridgeHttp : ''),
              httpToken: String(body?.httpToken ?? '').trim() || (useBridge ? bridgeHttp : ''),
              wsToken: String(body?.wsToken ?? '').trim() || (useBridge ? bridgeWs : ''),
              restart: body?.restart !== false
            };
            const result = await tokMod.applyNapcatTokens(payload);
            // 写盘成功 → 把桥这边的期望值也对齐（**同时改内存**：config.json 是原子替换写盘，
            // 文件监听偶尔收不到这次变更，只写文件会出现"磁盘已改、桥还拿旧令牌去连"的假不一致）
            if (result?.ok && (payload.httpToken || payload.wsToken) && !useBridge) {
              try {
                if (payload.httpToken) cfgRef.napcat.accessToken = payload.httpToken;
                if (payload.wsToken) cfgRef.napcat.wsAccessToken = payload.wsToken;
                const file = readJsonSafe(configFilePath(), null, true);
                if (file && typeof file === 'object') {
                  file.napcat = file.napcat ?? {};
                  if (payload.httpToken) file.napcat.accessToken = payload.httpToken;
                  if (payload.wsToken) file.napcat.wsAccessToken = payload.wsToken;
                  const bak = configFilePath() + '.bak-tokens';
                  try { fs.copyFileSync(configFilePath(), bak); } catch { /* 忽略 */ }
                  atomicWriteJson(configFilePath(), file);
                }
                log('[napcat-tokens] 桥 config.json（内存 + 文件）的 napcat.accessToken / wsAccessToken 已对齐');
              } catch (eCfg) {
                log(`[napcat-tokens] 写桥 config.json 失败（NapCat 侧已改）: ${eCfg?.message ?? eCfg}`);
              }
            }
            log(`控制台：NapCat 令牌写入 → ${JSON.stringify({ changed: result?.changed, restart: result?.restart?.ok, verify: result?.verify })}`);
            sendJson(result);
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        sendJson({ ok: false, error: '仅支持 GET / POST' }, 405);
        return;
      }

      // ── 学习管理 / 用量统计 REST（学习系统重构新增；鉴权沿用上方统一 consoleToken 校验） ──
      // GET/PUT state/learning-config.json（PUT 白名单+先读后合并；slang.lastLearnAtMs 永远不被覆盖）
      if (req.method === 'GET' && url.pathname === '/api/learning-config') {
        sendJson({ ok: true, config: loadLearningConfig() });
        return;
      }
      if (req.method === 'PUT' && url.pathname === '/api/learning-config') {
        const body = await readBody();
        try {
          const next = sanitizeLearningConfigBody(body, loadLearningConfig());
          saveLearningConfig(next);
          log(`控制台：学习管理配置已保存（slang.enabled=${next.slang.enabled}, time=${next.slang.timeHHMM}, liveWindowExtract=${next.slang.liveWindowExtract}, autoResearch=${next.slang.autoResearch}; persona.enabled=${next.persona.enabled}, targetQQ=${next.persona.targetQQ.length}个）`);
          sendJson({ ok: true, config: next });
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
        }
        return;
      }
      // POST /api/learning/slang {action:'learn'|'stop'}：动态 import slang.js，防开发期文件未就绪崩路由
      if (req.method === 'POST' && url.pathname === '/api/learning/slang') {
        const body = await readBody();
        const action = body.action;
        if (action !== 'learn' && action !== 'stop') {
          sendJson({ ok: false, error: "action 仅支持 'learn' / 'stop'" }, 400);
          return;
        }
        try {
          const slangMod = await import('../core/slang.js');
          const fn = action === 'learn' ? slangMod.slangLearnNow : slangMod.slangStopNow;
          if (typeof fn !== 'function') {
            sendJson({ ok: false, error: `黑话${action === 'learn' ? '立即学习' : '停止'}接口尚未就绪（slang 模块缺少对应导出）` }, 503);
            return;
          }
          const result = await fn();
          log(`控制台：黑话${action === 'learn' ? '立即学习' : '停止'}已触发 → ${JSON.stringify(result)}`);
          sendJson({ ok: true, result });
        } catch (error) {
          sendJson({ ok: false, error: `黑话${action === 'learn' ? '立即学习' : '停止'}调用失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      // POST /api/learning/persona {action:'start'|'stop'|'status', qq?: string[]}
      // mcp 侧经 HTTP 回环调用；persona-learn.js 缺失/未就绪时返回 {ok:false,error:'persona module unavailable'}
      if (req.method === 'POST' && url.pathname === '/api/learning/persona') {
        const body = await readBody();
        const action = body.action;
        if (action !== 'start' && action !== 'stop' && action !== 'status') {
          sendJson({ ok: false, error: "action 仅支持 'start' / 'stop' / 'status'" }, 400);
          return;
        }
        let qq = null;
        if (body.qq !== undefined) {
          if (!Array.isArray(body.qq)) { sendJson({ ok: false, error: 'qq 必须是字符串数组' }, 400); return; }
          const cleaned = [];
          const seen = new Set();
          for (const raw of body.qq) {
            const s = String(raw ?? '').trim();
            if (!/^\d{1,11}$/.test(s)) { sendJson({ ok: false, error: `qq 包含无效值：${s}` }, 400); return; }
            if (!seen.has(s)) { seen.add(s); cleaned.push(s); }
          }
          if (cleaned.length > 50) { sendJson({ ok: false, error: 'qq 数量过多（最多 50 个）' }, 400); return; }
          qq = cleaned;
        }
        let personaMod;
        try {
          personaMod = await import('../core/persona-learn.js');
        } catch (error) {
          log(`控制台：人格学习模块加载失败（persona module unavailable）：${error?.message ?? error}`);
          sendJson({ ok: false, error: 'persona module unavailable' }, 503);
          return;
        }
        const fnMap = { start: 'personaLearnTargets', stop: 'personaLearnStop', status: 'personaLearnStatus' };
        const fn = personaMod[fnMap[action]];
        if (typeof fn !== 'function') {
          sendJson({ ok: false, error: 'persona module unavailable' }, 503);
          return;
        }
        try {
          // start 未带 qq → 用配置里的 persona.targetQQ（与模块文本指令缺省语义一致）
          if (action === 'start' && (!qq || !qq.length)) {
            qq = normalizeQQList(loadLearningConfig().persona?.targetQQ);
          }
          const result = await fn(qq);
          log(`控制台：人格学习 ${action} → ${JSON.stringify(result)}`);
          sendJson({ ok: true, result });
        } catch (error) {
          sendJson({ ok: false, error: `人格学习 ${action} 调用失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      // POST /api/learning/persona-apply { uid, mode:'save'|'apply'|'fuse', text? }
      //   人格学习的**审批 / 修正**口（管理端「人格学习」栏展开后的几个按钮）：
      //     mode='save'  → text 当作修正后的英文人设正文写回该 uid 的库记录（键 personaEn）
      //     mode='apply' → text（没传则用库里的 personaEn）**整篇覆盖**写入 qq-bridge/persona.md；
      //                    桥每轮唤醒按 mtime 读它注入 [PERSONA]，文件一改下一条消息就是新人设、
      //                    不用重启桥；覆盖前桥侧自动备份旧人设（persona.md.bak-…，最多 5 份）。
      //     mode='fuse'  → 【2026-09-15 主人要求】**不替换、而是结合**：把学到的特点融进**当前 persona.md**
      //                    重新增删改写出一份草稿返回（不写盘，主人看过再决定是否覆盖）。
      //   校验（uid 格式 / 正文非空 / apply 禁中文）统一在 persona-learn.js 里做，
      //   端点只做转发与类型兜底，保证桥内其它调用方拿到同一套规则；
      //   鉴权沿用本段上方的统一 consoleToken 校验（管理端经 /api/learning/persona-apply 代理过来）。
      /* 【2026-09-22 修「不能切换人设」】把角色库里的一张卡写成 persona.md（模型侧工具 qq_character_switch 走这里）。
       * 为什么需要端点：模型侧原来**没有任何**写人设的路径 —— 四个 qq_character_* 是纯只读，
       * 旧的 /role 命令读的是 roles/ 老机制而那个目录根本不存在，于是"换成 XX 角色"只能即兴演，
       * 轮换或压缩之后立刻掉回默认人格。写盘实现只有一份：lib/persona-switch.js（斜杠命令也用它）。
       * 权限（必须是他本人）：① 主人的私聊令牌；或 ② 该会话**最近一条别人发来的消息**是主人（10 分钟内）
       * —— 群里换人设正是这个场景，群友插一句话就会把这条授权挡掉。 */
      if (req.method === 'POST' && url.pathname === '/api/persona/switch') {
        const body = await readBody();
        const key = String(body?.key ?? '').trim();
        const token = String(body?.token ?? '').trim();
        const character = String(body?.character ?? '').trim();
        const clear = body?.clear === true || /^(clear|off|none|default|默认|清除|关闭)$/i.test(character);
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        if (!token || !agentTokenOk(key, token)) { sendJson({ ok: false, error: '需要有效的会话令牌' }, 403); return; }
        const ownerKey = 'private:' + String(cfgRef.ownerQQ ?? '');
        const ownerPrivate = key === ownerKey && social.conversations.get(ownerKey)?.agentToken === token;
        let ownerHere = false;
        if (!ownerPrivate) {
          const st = social.conversations.get(key);
          const list = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
          for (let i = list.length - 1; i >= 0; i--) {
            const m = list[i];
            if (!m || m.isSelf) continue;                                  // 只看别人发来的
            ownerHere = !!(m.isOwner && (Date.now() - Number(m.time || 0) < 10 * 60e3));
            break;                                                          // 最近一条人话是谁，就以谁为准
          }
        }
        if (!ownerPrivate && !ownerHere) {
          sendJson({ ok: false, error: '这个只有主人能换（私聊里直接说，或在群里等他亲口说那句）' }, 403);
          return;
        }
        try {
          const mod = await import('../lib/persona-switch.js');
          const r = mod.switchPersona({ cfg: cfgRef, character, clear });
          log(`控制台：人设切换 ${key} → ${JSON.stringify({ ok: r.ok, action: r.action, pack: r.pack, bytes: r.bytes, error: r.error })}`);
          sendJson(r.ok
            ? {
              ok: true, action: r.action, pack: r.pack ?? null, files: r.files ?? [], bytes: r.bytes,
              truncated: !!r.truncated, backup: r.backup || null,
              via: ownerPrivate ? 'owner-private' : 'owner-in-this-session',
            }
            : { ok: false, error: r.error ?? '切换失败' }, r.ok ? 200 : 400);
        } catch (error) {
          sendJson({ ok: false, error: `人设切换失败：${error?.message ?? error}` }, 500);
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/learning/persona-apply') {        const body = await readBody();
        const uid = String(body?.uid ?? '').trim();
        const mode = String(body?.mode ?? '').trim();
        if (!/^\d{1,11}$/.test(uid)) { sendJson({ ok: false, error: 'uid 必须是 1~11 位数字 QQ 号' }, 400); return; }
        if (mode !== 'save' && mode !== 'apply' && mode !== 'fuse') {
          sendJson({ ok: false, error: "mode 仅支持 'save'（保存修正）/ 'apply'（整篇覆盖人设）/ 'fuse'（结合原人设完善）" }, 400);
          return;
        }
        if (body?.text !== undefined && body?.text !== null && typeof body.text !== 'string') {
          sendJson({ ok: false, error: 'text 必须是字符串（人设正文）' }, 400);
          return;
        }
        let applyMod;
        try {
          applyMod = await import('../core/persona-learn.js');
        } catch (error) {
          log(`控制台：人格学习模块加载失败（persona module unavailable）：${error?.message ?? error}`);
          sendJson({ ok: false, error: 'persona module unavailable' }, 503);
          return;
        }
        if (typeof applyMod.personaApply !== 'function') { sendJson({ ok: false, error: 'persona module unavailable' }, 503); return; }
        const modeLabel = mode === 'save' ? '保存修正' : (mode === 'fuse' ? '结合原人设完善' : '覆盖机器人人设');
        try {
          // fuse 要跑一轮模型（读当前人设 + 学到的特点 → 重写），是异步且慢的，必须 await
          const result = mode === 'fuse'
            ? await (typeof applyMod.personaFuseDraft === 'function'
              ? applyMod.personaFuseDraft(uid)
              : { ok: false, error: 'persona module unavailable（桥版本过旧，没有完善模式）' })
            : applyMod.personaApply(uid, mode, body?.text);
          if (!result?.ok) {
            sendJson({ ok: false, error: result?.error ?? `${modeLabel}失败` }, 400);
            return;
          }
          log(`控制台：人格学习${modeLabel} ${uid} → ${mode === 'fuse' ? `${result.chars} 字草稿（未写盘）` : JSON.stringify(result)}`);
          sendJson(result);
        } catch (error) {
          log(`控制台：人格学习 ${mode} 调用失败 ${uid}：${error?.message ?? error}`);
          sendJson({ ok: false, error: `人格学习${modeLabel}调用失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      // POST /api/learning/portrait {action:'start'|'stop'|'status', qq?: string[]}
      // 群友画像学习：start 不带 qq → 按配置自动筛活跃群成员（见 portrait-learn.js）
      if (req.method === 'POST' && url.pathname === '/api/learning/portrait') {
        const body = await readBody();
        const action = body.action;
        if (action !== 'start' && action !== 'stop' && action !== 'status') {
          sendJson({ ok: false, error: "action 仅支持 'start' / 'stop' / 'status'" }, 400);
          return;
        }
        let portraitMod;
        try {
          portraitMod = await import('../core/portrait-learn.js');
        } catch (error) {
          log(`控制台：画像学习模块加载失败：${error?.message ?? error}`);
          sendJson({ ok: false, error: 'portrait module unavailable' }, 503);
          return;
        }
        const fnMap = { start: 'portraitLearnStart', stop: 'portraitLearnStop', status: 'portraitLearnStatus' };
        const fn = portraitMod[fnMap[action]];
        if (typeof fn !== 'function') { sendJson({ ok: false, error: 'portrait module unavailable' }, 503); return; }
        try {
          let qq = null;
          if (Array.isArray(body.qq) && body.qq.length) qq = body.qq.map((v) => String(v ?? '').trim()).filter((v) => /^\d{1,11}$/.test(v));
          const result = action === 'start' ? fn(qq && qq.length ? qq : undefined) : fn();
          log(`控制台：画像学习 ${action} → ${JSON.stringify(result)}`);
          sendJson({ ok: true, result });
        } catch (error) {
          sendJson({ ok: false, error: `画像学习 ${action} 调用失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      // POST /api/learning/submit-persona：学习会话把人格分析结果**经工具**交回来落库
      //   body: { uid, payload:{...}, samples?:number }；header: x-agent-token = 学习令牌
      //   鉴权走**独立的学习令牌**（core/learning-token.js），不是会话令牌：
      //   学习会话没有唤醒提示词、拿不到会话令牌；而会话令牌能通行 /api/blacklist、
      //   /api/social/deepsleep 等管理端点，发给学习会话等于扩权。
      //   只有这个端点认学习令牌，别的什么都不解锁。
      if (req.method === 'POST' && url.pathname === '/api/learning/submit-persona') {
        const { isValidLearningToken } = await import('../core/learning-token.js');
        if (!isValidLearningToken(req.headers['x-agent-token'])) {
          sendJson({ ok: false, error: '该接口需要有效的学习令牌（见 state/learning-token，或本轮学习提醒里给的那串）' }, 403);
          return;
        }
        const body = await readBody();
        const uid = String(body?.uid ?? '').trim();
        if (!/^\d{1,11}$/.test(uid)) { sendJson({ ok: false, error: 'uid 必须是 1~11 位数字 QQ 号' }, 400); return; }
        let personaMod;
        try {
          personaMod = await import('../core/persona-learn.js');
        } catch (error) {
          log(`控制台：人格学习模块加载失败（persona module unavailable）：${error?.message ?? error}`);
          sendJson({ ok: false, error: 'persona module unavailable' }, 503);
          return;
        }
        if (typeof personaMod.recordPersonaSubmit !== 'function') { sendJson({ ok: false, error: 'persona module unavailable' }, 503); return; }
        try {
          const result = personaMod.recordPersonaSubmit(uid, body?.payload, body?.samples);
          if (!result?.ok) { sendJson({ ok: false, error: result?.error ?? '落库失败' }, 400); return; }
          // 回执里的 summary 是中文摘要，只进状态接口；不回给模型（模型只要 ok:true）
          sendJson({ ok: true, uid: result.uid, samples: result.samples });
        } catch (error) {
          log(`控制台：人格学习结果落库失败 ${uid}：${error?.message ?? error}`);
          sendJson({ ok: false, error: `落库失败：${error?.message ?? error}` }, 500);
        }
        return;
      }
      // GET /api/token-report：token-meter.getTokenReport(7)（动态 import，模块异常不崩路由）
      if (req.method === 'GET' && url.pathname === '/api/token-report') {
        try {
          const meterMod = await import('../core/token-meter.js');
          if (typeof meterMod.getTokenReport !== 'function') {
            sendJson({ ok: false, error: 'token meter unavailable' }, 503);
            return;
          }
          const report = await meterMod.getTokenReport(7);
          /* 【2026-09-19】把「上下文剪枝省下多少」一起回给面板：**实测**值，直接读 DSH 自己落的会话日志
           * （compaction/prune 的 shadowedTokenCount × 后续还发生过多少次请求），不是拿字符数估的。
           * 扫描是增量的（只重读变过的日志），单独 try：拿不到不该让整份用量报告 503。 */
          let contextSavings = null;
          try {
            const saveMod = await import('../core/context-savings.js');
            if (typeof saveMod.getContextSavings === 'function') {
              try { await saveMod.reconcileContextSavings({ log: (m) => log('[savings] ' + m) }); } catch (e) { log(`控制台：剪枝计量扫描失败（忽略）：${e?.message ?? e}`); }
              contextSavings = saveMod.getContextSavings(7);
            }
          } catch (e) { log(`控制台：context-savings 读取失败（忽略）：${e?.message ?? e}`); }
          sendJson({ ok: true, report, contextSavings });
        } catch (error) {
          log(`控制台：token-report 读取失败：${error?.message ?? error}`);
          sendJson({ ok: false, error: 'token meter unavailable' }, 503);
        }
        return;
      }
      // POST /api/token-reconcile：立刻与 DSH 的会话级权威计数对账（补上被漏记的 usage 帧）。
      // 幂等：水位在 state/token-reconcile.json，重复点不会重复补。
      if (req.method === 'POST' && url.pathname === '/api/token-reconcile') {
        try {
          const meterMod = await import('../core/token-meter.js');
          if (typeof meterMod.reconcileWithDsh !== 'function') {
            sendJson({ ok: false, error: 'token meter 不支持对账（桥版本较旧）' }, 503);
            return;
          }
          const r = meterMod.reconcileWithDsh();
          log(`控制台：用量对账 → added=${r.added} tokens=${r.addedTokens}${r.ok ? '' : ' 失败:' + r.reason}`);
          sendJson({ ok: r.ok, result: r, status: typeof meterMod.tokenReconcileStatus === 'function' ? meterMod.tokenReconcileStatus() : null });
        } catch (error) {
          log(`控制台：用量对账失败：${error?.message ?? error}`);
          sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
        }
        return;
      }
      // GET /api/token-stream：SSE 实时推送用量（token-meter 落一条推一次，最短间隔 400ms + 20s 心跳）
      if (req.method === 'GET' && url.pathname === '/api/token-stream') {
        await handleTokenStream(req, res);
        return;
      }
      // ── NapCat 会话守护（探针 + 假死自愈）───────────────────────────────────────
      // 【2026-09-16 亲历】QQ 服务端把登录态作废时，客户端可能**一条错都不报**：WebUI 上
      // isLogin/online 还是 true，但发消息被 QQ 内核拒绝（网络连接异常 1006514），收消息也停。
      // 当天就这么静默了 50 分钟没人知道。这里把"会话健康"做成可查、可手动自愈、可开关自动自愈。
      // 鉴权沿用本段上方的统一 consoleToken 校验（管理端走这条）。
      if (url.pathname === '/api/napcat/guard' || url.pathname === '/api/napcat/guard/heal' || url.pathname === '/api/napcat/quick-password' || url.pathname === '/api/napcat/qr') {
        let gMod;
        try {
          gMod = await import('../core/napcat-guard.js');
        } catch (error) {
          log(`控制台：NapCat 守护模块加载失败：${error?.message ?? error}`);
          sendJson({ ok: false, error: 'napcat-guard module unavailable（桥版本较旧）' }, 503);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/napcat/guard') {
          sendJson({ ok: true, guard: gMod.guardStatus() });
          return;
        }
        // 二维码现抓一份回给管理端（base64 dataUrl，管理端直接 <img> 就能显示/保存）
        if (req.method === 'GET' && url.pathname === '/api/napcat/qr') {
          sendJson(await gMod.qrSnapshot());
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/napcat/guard') {
          const body = await readBody();
          const patch = {};
          if (typeof body?.autoHeal === 'boolean' || body?.autoHeal === null) patch.autoHeal = body.autoHeal;
          if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
          const guard = gMod.setGuardConfig(patch);
          log(`控制台：会话守护设置更新 → autoHeal=${guard.autoHeal} enabled=${guard.enabled}`);
          sendJson({ ok: true, guard });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/napcat/guard/heal') {
          // 手动自愈：忽略冷却与开关（人明确点了就执行），仍然走同一条"重启 + 等登录"路径
          const r = await gMod.guardTick(true);
          log(`控制台：手动自愈 → ${r?.verdict ?? '?'}（${r?.lastProbeDetail ?? ''}）`);
          sendJson({ ok: true, guard: r, healed: r?.verdict === 'ok', detail: r?.lastProbeDetail ?? '' });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/napcat/quick-password') {
          const body = await readBody();
          const password = String(body?.password ?? '');
          if (!password.trim()) { sendJson({ ok: false, error: '密码不能为空' }, 400); return; }
          log('控制台：开始配置免扫码回退登录（重建容器；密码只算 md5，明文不落盘、不进日志）');
          try {
            const r = await gMod.applyQuickPassword(password);
            sendJson(r.ok ? { ok: true, detail: r.detail, loginState: r.loginState } : { ok: false, error: r.error, loginState: r.loginState, qrPath: r.qrPath }, r.ok ? 200 : 500);
          } catch (error) {
            log(`控制台：配置免扫码回退登录异常：${error?.message ?? error}`);
            sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
          }
          return;
        }
      }
      sendJson({ ok: false, error: 'not found' }, 404);
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      log(`[console] ${req.method} ${url.pathname} 未处理异常: ${error?.stack ? error.stack.split(String.fromCharCode(10)).slice(0, 6).join(' | ') : (error?.message ?? String(error))}`);
      sendJson({ ok: false, error: error?.message ?? String(error) }, status);
    }
  });
  // 本机可信：默认只绑定 127.0.0.1（远端访问走 SSH 隧道/manager 代理，不直暴露端口）
  // 【2026-09-11 23:15 24 小时长轮询的必要条件】Node 的 http.Server 默认 `requestTimeout = 300 秒`，
  // 会把进行中的长轮询请求在 5 分钟时**直接掐断**（症状：等待工具总是"失败"、消息读不到）。
  // 这里设为 0 = 不超时。`headersTimeout` 只管收请求头，`keepAliveTimeout` 只管空闲连接，
  // 都不影响进行中的长请求，但一并设 0 以免其它版本默认值变化。
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  server.listen(port, '127.0.0.1', () => {
    log(`本地控制台已启动：http://127.0.0.1:${port}`);
  });
  // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
  server.on('error', (error) => {
    log(`控制台服务错误: ${error?.message ?? error}`);
    if (error?.code === 'EADDRINUSE') {
      console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
      process.exit(2);
    }
    process.exit(1);
  });
  return server;
}

// ── 用量实时推流（SSE）：token-meter 一落行就推快照，前端不必再轮询 ──────────────
const tokenStreamClients = new Set();
let tokenStreamPushTimer = null;
let tokenStreamHookBound = false;

/** 生成一份当前用量快照（getTokenReport(7) 就是 REST 端点同一份数据） */
async function buildTokenSnapshot() {
  const meterMod = await import('../core/token-meter.js');
  if (typeof meterMod.getTokenReport !== 'function') throw new Error('token meter unavailable');
  return meterMod.getTokenReport(7);
}

function sseWrite(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 客户端已断开 */ }
}

async function broadcastTokenSnapshot() {
  if (!tokenStreamClients.size) return;
  let report;
  try { report = await buildTokenSnapshot(); } catch { return; }
  const payload = { ok: true, report, at: Date.now() };
  for (const client of tokenStreamClients) {
    if (client.writableEnded) { tokenStreamClients.delete(client); continue; }
    sseWrite(client, 'token', payload);
  }
}

/** 首次有客户端时挂上 token-meter 的落行订阅（400ms 合批，避免一帧多行时连推） */
async function bindTokenStreamHook() {
  if (tokenStreamHookBound) return;
  tokenStreamHookBound = true;
  try {
    const meterMod = await import('../core/token-meter.js');
    if (typeof meterMod.onTokenRecord !== 'function') { tokenStreamHookBound = false; return; }
    meterMod.onTokenRecord(() => {
      if (!tokenStreamClients.size || tokenStreamPushTimer) return;
      tokenStreamPushTimer = setTimeout(() => {
        tokenStreamPushTimer = null;
        broadcastTokenSnapshot().catch(() => {});
      }, 400);
      if (typeof tokenStreamPushTimer.unref === 'function') tokenStreamPushTimer.unref();
    });
    log('控制台：用量 SSE 推流已就绪（/api/token-stream）');
  } catch (error) {
    tokenStreamHookBound = false;
    log(`控制台：用量 SSE 订阅失败：${error?.message ?? error}`);
  }
}

async function handleTokenStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(': connected\n\n');
  tokenStreamClients.add(res);
  bindTokenStreamHook();

  // 连接即推一份当前快照，前端不用先等变化
  try { sseWrite(res, 'token', { ok: true, report: await buildTokenSnapshot(), at: Date.now() }); } catch { /* 忽略 */ }

  // 心跳：防中间代理/浏览器把空闲连接掐掉
  const hb = setInterval(() => {
    if (res.writableEnded) return;
    try { res.write(': ping\n\n'); } catch { /* 忽略 */ }
  }, 20000);
  if (typeof hb.unref === 'function') hb.unref();

  const cleanup = () => {
    clearInterval(hb);
    tokenStreamClients.delete(res);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}
