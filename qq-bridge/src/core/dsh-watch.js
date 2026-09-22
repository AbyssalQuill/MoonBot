// DSH 可用性探活 + 桥接模式同步：
// cfg/api/bot 运行期注入；lastMode 模块内聚（writeLastMode 供控制台 sink 写回）。
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
import { EXPLICIT_END_RE, hasExplicitEnd, isSleepingConfig, normalizeSpeakerIds } from '../lib/sleep-guard.js';
import { isEmojiLikeCp, stripImeEmoji } from '../lib/emoji.js';
import { singleLineForQQ, splitLongSegment } from '../lib/segment.js';
import { mimeFromBuffer, mimeFromUrl, base64FromMaybe } from '../lib/media-meta.js';
import { log, appendActivity, readActivityTail } from '../lib/log.js';
import { SILENT_MARKER, isSilentMarker, SEND_TOOL_RE, isSendToolName, SPACE_SPLIT_HINT, DIRECTION_HINT } from '../lib/markers.js';
import { state, loadConfig, loadState, saveState } from './config.js';
import { acquireLock, releaseLock } from './runtime.js';
import { enqueueSend, currentSendChain } from './send-chain.js';
import { sendToQQ, sendBurstToQQ, sendMessages, initQqSendCore, setQqSendBot } from './qq-send.js';
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
  formatMemory, appendMemory, initMemoryCore,
} from './memory.js';
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
  setTurnGuardApi, TURN_TIMEOUT_MS, TURN_TOTAL_TIMEOUT_MS,
} from './turn-guard.js';
import {
  collectors, TurnStartAt, pendingWakeKeys, sessionPromises, promptQueues,
  sendToolSucceededSessions, turnTimeoutTimers, turnTotalTimers, loopRepeatState,
  loopRecoverTimes, activeAiTurns, pendingTurnOutbound, toolCallNames, pendingSendToolCalls,
  activeWaits, pendingWakeLeaseTimers, lastWakeRebroadcast, wakeConfigUpdatedKeys,
  markReadCalledKeys, wakeConfigMissCount, reverse,
  queued, queuedHintAt, queueRetries, pending, visionModelAppliedSessions,
  messageMediaStore, activityWakeCooldown, MAX_MEDIA_COUNT,
} from './session-state.js';
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
  clearSocialTimers, clearAllSocialTimers,
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
import { handleIncoming, pumpMux, initMuxCore, setMuxApi, setMuxBot } from './mux.js';
import { startConsoleServer, initConsoleCore, setConsoleApi, setConsoleBot, setConsoleMedia, setConsoleLastModeSink } from './console-server.js';

let cfgRef = null;
export function initDshWatchCore(cfg) { cfgRef = cfg; lastMode = currentMode; }
let apiRef = null;
export function setDshWatchApi(api) { apiRef = api; }
let botRef = null;
export function setDshWatchBot(bot) { botRef = bot; }
let dshCheckStarted = false;
let lastMode = null;
export function writeLastMode(v) { lastMode = v; }

// 单默认模式（default=default）：不再从 DSH 设置/本地文件同步运行模式；
// refreshMode 仅保留「DSH 设置页可覆盖管理员 QQ（ownerQQ）」这一能力。
async function refreshMode() {
  try {
    const s = unwrap(await apiRef.settings.describe({}), 'settings.describe');
    const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
    if (ns?.value && ns.value.ownerQQ !== undefined) {
      try {
        cfgRef.ownerQQ = normalizeOwnerQQ(ns.value.ownerQQ);
      } catch (error) {
        log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
      }
    }
  } catch {}
}

const checkDsh = async () => {
  let ok = false;
  try {
    await apiRef.host.describe({});
    ok = true;
  } catch {}
  if (ok) {
    await refreshMode();
    if (!dshReady) {
      setDshReady(true);
      lastMode = currentMode;
      log(`DSH 已就绪（模式: ${currentMode}）`);
      if (currentMode === 'default') {
        // 首次确定模式为 default 后再恢复持久化的有限睡眠定时器，
        // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
        for (const key of social.conversations.keys()) {
          setupSleepTimer(key);
          scheduleProactiveCheck(key);
        }
        // 预热群主/管理员信息缓存（供唤醒提示注入【本群】行），并每 15 分钟刷新
        const warmGroups = () => {
          const gids = new Set();
          for (const key of social.conversations.keys()) if (key.startsWith('group:')) gids.add(key.split(':')[1]);
          for (const g of (Array.isArray(cfgRef.allow?.groups) ? cfgRef.allow.groups.map(String) : [])) gids.add(g);
          for (const g of gids) {
            warmGroupInfo(g).catch(() => {});
            warmGroupName(g).catch(() => {});
          }
        };
        warmGroups();
        if (!globalThis._groupInfoTimer) {
          globalThis._groupInfoTimer = setInterval(warmGroups, 15 * 60 * 1000);
          globalThis._groupInfoTimer.unref?.();
        }
        log('桥接模式已确定为 default，恢复有限睡眠定时器');
      }
      try { await flushQueue(); } catch (error) { log('补投队列异常:', error?.message ?? error); }
      // 自动点赞定时器
      if (cfgRef.social?.autoLike?.enabled && cfgRef.social.autoLike.targetUserId) {
        const al = cfgRef.social.autoLike;
        const alInterval = Math.max(60000, Number(al.intervalMs) || 3600000);
        const alTimes = Math.min(10, Math.max(1, Number(al.times) || 1));
        const alTarget = Number(al.targetUserId);
        if (!globalThis._autoLikeTimer) {
          globalThis._autoLikeTimer = setInterval(async () => {
            try {
              await botRef.raw('send_like', { user_id: alTarget, times: alTimes });
              log(`[autoLike] 定时点赞 ${alTarget} x${alTimes}`);
            } catch (error) {
              log(`[autoLike] 点赞失败: ${error?.message ?? String(error)}`);
            }
          }, alInterval);
          log(`[autoLike] 已启动定时点赞：每 ${alInterval / 60000} 分钟给 ${alTarget} 点赞 ${alTimes} 次`);
        }
      }
      // 低频主动发 QQ 空间说说（全 bot 一个调度：6~12 小时一次，概率触发，配大肥鱼图）
      if (!globalThis._qzonePostTimer) {
        const qp = cfgRef.social?.qzone ?? {};
        const qMin = Math.max(2 * 60 * 60 * 1000, Number(qp.postIntervalMinMs) || 6 * 60 * 60 * 1000);
        const qMax = Math.max(qMin, Number(qp.postIntervalMaxMs) || 12 * 60 * 60 * 1000);
        /* 【2026-09-22 修 M5】`Number(undefined)` 是 NaN，而 `??` 拦不住 NaN（它判的是 null/undefined，
         * 这里是 Number() 的结果）→ 后面 `Math.random() < NaN` 恒 false：**主动发说说永远不触发**，
         * 日志却照打"已安排主动发说说"。同类坑 wake-send.js 已踩过一次，统一用 Number.isFinite 判。 */
        const qProb = (() => { const v = Number(qp.postProbability); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.6; })();
        const qEnabled = qp.enabled !== false;
        const scheduleQzone = () => {
          const delay = Math.floor(qMin + Math.random() * (qMax - qMin));
          globalThis._qzonePostTimer = setTimeout(async () => {
            try {
              if (qEnabled && social && !social.paused) {
                const hour = new Date().getHours();
                // 深夜（北京时间 1-6 点）不主动发
                const bjHour = new Date(Date.now() + 8 * 3600 * 1000).getHours();
                if (bjHour >= 1 && bjHour < 6) {
                  log('[qzone] 深夜跳过主动发说说');
                } else if (Math.random() < qProb) {
                  await postRandomQzone();
                }
              }
            } catch (error) {
              log(`[qzone] 主动发说说失败: ${error?.message ?? error}`);
            }
            scheduleQzone();
          }, delay);
          globalThis._qzonePostTimer.unref?.();
          log(`[qzone] 已安排主动发说说：约 ${Math.round(delay / 3600000)} 小时后`);
        };
        scheduleQzone();
      }
      // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
      for (const key of [...slangWindows.keys()]) maybeQueueSlangExtraction(key);
    }
  } else if (dshReady) {
    setDshReady(false);
    log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
  }
};

export function startDshWatch() {
  if (dshCheckStarted) return;
  dshCheckStarted = true;
  checkDsh();
  setInterval(checkDsh, 5000);
}
