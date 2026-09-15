// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → NapCat (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { OneBotWsClient } from './lib/onebot-ws.js';
import { NodeApiClient, unwrap, createTurnCollector } from './dsh-client.js';
import { mdToPlain, splitForQQ } from './md-to-plain.js';
import { SENSITIVE_RE, sensitiveHitKind, sensitiveHitSample } from './sensitive.js';
import { looksLikeUnfinished } from './wait.js';
import { safeFetchBuffer, validateFetchUrl, looksLikeImageBuffer } from './safe-fetch.js';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from './forward.js';
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
} from './slang-learner.js';
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
} from './sticker-lib.js';
import { resolveFaceRef, formatFaceList } from './qq-faces.js';
import { makeDocx } from './make-docx.js';
import { segmentsToText, parseJsonCardText, extractMediaFromSegments, extractFilesFromSegments,
  execFileBuffer, decodeTextBuffer, extractDocxText, parseFileBuffer, fetchFileBytes, readFileContent } from './lib/message-parse.js';
import {
  ROOT, STATE_DIR, STATE_FILE, ROLE_STATE_FILE, SLANG_FILE, SLANG_SESSION_FILE,
  SOCIAL_STATE_FILE, STICKER_FILE, FEEDBACK_FILE, TOOL_LOG_FILE, ACTIVITY_LOG, BRIDGE_LOG,
  CROSSCHAT_FILE, LOCK_FILE,
} from './lib/paths.js';
import { readJsonSafe, atomicWriteJson, atomicWriteText } from './lib/json-fs.js';
import { randInt } from './lib/rand.js';
import { BJ_WEEK, bjMinutes, bjMinToText, beijingTs, beijingDateKey, parseClockMin, fmtBeijing } from './lib/time.js';
import { isCjkChar, splitByCjkSpaces, isCjkLikeChar, convertExampleSpacesToComma } from './lib/cjk-split.js';
import { clampGap, computeGaps } from './lib/send-gaps.js';
import { normalizeLoopSignature, isDuplicateSendText } from './lib/loop-guard.js';
import { faceIdFromArtifactContent, resolveArtifactFaceId } from './lib/qq-face-parse.js';
import { compressImageBuffer, finalizeImageBuffer } from './lib/image-compress.js';
import { isSafeLocalMediaPath, isProbablySafeImageFileRef } from './lib/media-guard.js';
import { KNOWN_AGENT_TOKENS, redactSensitiveText, SENSITIVE_ARG_KEYS, redactSensitive, sanitizeToolArgs, escapeCqText, unquoteJsonString } from './lib/text-safe.js';
import { normalizeOwnerQQ, normalizeIdList, allowed } from './lib/config.js';
import { readRoleState, writeRoleState, sanitizeRoleName, listRoles } from './lib/role-access.js';
import { sleep, withTimeout } from './lib/async.js';
import { convKey, canonicalKey } from './lib/keys.js';
import { EXPLICIT_END_RE, hasExplicitEnd, isSleepingConfig, normalizeSpeakerIds } from './lib/sleep-guard.js';
import { isEmojiLikeCp, stripImeEmoji } from './lib/emoji.js';
import { singleLineForQQ, splitLongSegment } from './lib/segment.js';
import { mimeFromBuffer, mimeFromUrl, base64FromMaybe } from './lib/media-meta.js';
import { log, appendActivity, readActivityTail } from './lib/log.js';
import { SILENT_MARKER, isSilentMarker, SEND_TOOL_RE, isSendToolName, SPACE_SPLIT_HINT, DIRECTION_HINT } from './lib/markers.js';
import { state, loadConfig, loadState, saveState, watchConfigFile } from './core/config.js';
import { acquireLock, releaseLock } from './core/runtime.js';
import { enqueueSend, currentSendChain } from './core/send-chain.js';
import { sendToQQ, sendBurstToQQ, sendMessages, initQqSendCore, setQqSendBot } from './core/qq-send.js';
import { redactKnownTokensOnly, sweepMessageArtifacts, stripMessageArtifacts, cleanOutboundText } from './lib/outbound-text.js';
import { planSocialTimeline, isDirectedAtAi, withTimeText, findCjkSpaceWarning, findSplitBoundaryWarning } from './lib/social-timeline.js';
import { createMediaDomain } from './core/media.js';
import {
  DOC_TMP_HOST_DIR, DOC_TMP_CONTAINER_DIR, MAX_DOCX_CHARS, docxQuota,
  loadDocxQuota, docxQuotaReserve, docxQuotaCommit, writeDocxToMount,
  uploadFileToQQ, sendDocx, initDocxCore,
} from './core/docx.js';
import {
  stickerEnabled, saveStickerStoreSafe, syncStickerLibrary, listStickersFor,
  getStickerImageData, sendSticker2, sendQqFace2,
  stickerEntries, stickerSyncedAt, updateStickerEntries, initStickerCore, setStickerBot,
  writeStickerTmpFile, applyStickerNote2, setStickerRemark2, collectSticker2,
} from './core/sticker.js';
import { postRandomQzone, initQzoneCore } from './core/qzone.js';
import {
  cancelPendingEntry, handlePendingAnswer, handlePokeNotice, handleInputStatusNotice,
  registerPending, initEventsAuxCore, setEventsAuxApi,
} from './core/events-aux.js';
import {
  memDb, initMemoryDb, getProfile, setProfileField, formatProfileText,
  profileDisplayName, formatContactsLine, resolveNameToUid,
  persistChatMessage, searchChatMessages, deleteChatMessages, clearChatHistory,
  markChatRecalled,
  formatMemory, appendMemory, initMemoryCore,
} from './core/memory.js';
import {
  evaluateWakeTrigger, buildWakePrompt, sendWakePrompt, steerIntoRunningTurn,
  initWakeCore, setWakeApi, setWakeDeliver,
} from './core/wake-send.js';
import { resolveGroupMemberName, resolveReplyInfo, expandIncomingForwardPreview, setMessageCacheBot } from './core/message-cache.js';
import {
  shouldAuditKey, shouldBlockSilentReply, handleSensitiveIntercept, auditAndSend, initAuditCore,
  readFeedbackEntries, appendFeedbackEntry, readToolLog, appendToolLog,
} from './core/audit.js';
import {
  armPendingWakeLease, disarmPendingWakeLease, clearAllPendingWakeLeases,
  quarantineSession, recordAiTurnOutbound, finishTurnLoopGuard,
  armTurnWatchdog, armTurnTotalTimer, clearTurnTotalTimer, clearAllTurnTotalTimers,
  setTurnGuardApi, TURN_TIMEOUT_MS, TURN_TOTAL_TIMEOUT_MS,
} from './core/turn-guard.js';
import {
  collectors, TurnStartAt, pendingWakeKeys, sessionPromises, promptQueues,
  sendToolSucceededSessions, turnTimeoutTimers, turnTotalTimers, loopRepeatState,
  loopRecoverTimes, activeAiTurns, pendingTurnOutbound, toolCallNames, pendingSendToolCalls,
  activeWaits, pendingWakeLeaseTimers, lastWakeRebroadcast, wakeConfigUpdatedKeys,
  markReadCalledKeys, wakeConfigMissCount, reverse,
  queued, queuedHintAt, queueRetries, pending, visionModelAppliedSessions,
  resetVisionModelApplications,
  messageMediaStore, activityWakeCooldown, MAX_MEDIA_COUNT,
} from './core/session-state.js';
import {
  activityWindows, loadActivityWindows, saveActivityWindows, getActivityWindows,
  inActivityWindow, nextActivityWindowStart, activityStatusLine,
  startActivityTick, activityTickTimer,
} from './core/activity.js';
import {
  ensureSession, ensureVisionModel, bumpSessionEpoch,
  initDshSessionCore, setDshSessionApi, dshReady, setDshReady,
} from './core/dsh-session.js';
import {
  saveSlangStore, queueSlangTask, invalidateSlangLearnerSession, runSlangExtraction,
  runSlangResearch, maybeQueueSlangExtraction, feedSlangWindow, allowSlangSubmit,
  publicSlangEntry, confirmedSlangList, withSlangContext,
  slangEntries, slangWindows, slangExtractionCooldowns, slangSubmitTimes, feedbackTimes,
  slangResearchingIds, learnerSessions, learnerCollectors, learnerWaiters,
  lastSendDedup, sendCallTimes, slangLearnerSessionId,
  setSlangEntries, setSlangLearnerSessionId, initSlangCore, setSlangApi,
} from './core/slang.js';
import {
  initPersonaLearnCore, setPersonaLearnApi, initPersonaAutoLearn,
} from './core/persona-learn.js';
import { initPortraitLearn } from './core/portrait-learn.js';
import { initVoiceCore } from './core/voice.js';
import { initNapcatTokens } from './core/napcat-tokens.js';
import { initSendDice } from './core/send-dice.js';
import { ensureLearningToken } from './core/learning-token.js';
import {
  initSessionArchiveCore, setSessionArchiveApi, startSessionArchiveTicker,
  loadArchivedCache,
} from './core/session-archive.js';
import {
  initSlangNightly,
} from './core/slang.js';
import {
  initTokenMeter, setConvKeyResolver, setTokenReconcileHome, startTokenReconcile,
} from './core/token-meter.js';
import {
  enqueueForRetry, flushQueue, deliverPrompt, drainPromptQueue, drainAllPromptQueues,
  QUEUE_MAX, initPromptDeliverCore, setPromptApi, setPromptMediaResolver,
} from './core/prompt-deliver.js';
import {
  appendSocialMessage, appendSocialPoke, resolveReplyTarget, isQuoteTargetSelf,
  findMessageMedia, recordSentMessages, initSocialFlowCore,
} from './core/social-flow.js';
import {
  getImageDimensions, fetchOneBotImage, fetchFaceMedia, resolveMediaList, fetchMediaData,
  MAX_MEDIA_BYTES, MAX_MEDIA_PIXELS, MAX_MEDIA_STORE_PER_KEY,
  initMediaPipeCore, setMediaPipeBot,
} from './core/media-pipe.js';
import {
  tunableListItems, findTunable, applyTunable, rearmProactiveTimersAfterChange,
  tokenBelongsToOwner, TUNABLE_SPECS, setTunableCfg,
} from './core/tunables.js';
import {
  social, defaultWakeConfig, softResetWakeConfig, initSocialCore,
  preSleepWaitBlocked, computeWakeSafety,
  wakePriority, seenForwardIds, saveSocialState,
  refreshDefaultWakeConfig, refreshAllDefaultWakeConfigs, isConversationBusy,
  getSocialState, loadSocialState, ensureWakeable, cancelReplyCheck,
  cancelProactiveCheck, setupSleepTimer, scheduleProactiveCheck, setWakeSender, setSteerSender,
  formatParticipation, suggestQuietMs, PEER_TYPING_HOLD_MAX_MS, scheduleWake,
  scheduleReplyCheck, buildWakeReminderPrompt,
  startDeliveryWatchdog,
  clearSocialTimers, clearAllSocialTimers,
} from './core/social-state.js';
import {
  loadScheduledTasks, parseScheduledAt, createScheduledTask, cancelScheduledTask, setScheduledRecorder,
} from './core/scheduler.js';
import {
  pushCrossDigest, addCrossMail, unreadCrossMails, markCrossMailsRead,
  buildCrossChatBlock, initCrossChatCore,
} from './core/crosschat.js';
import {
  VALID_MODES, currentMode, closedAgentPreset, selfNickname,
  setCurrentMode, setClosedAgentPreset, setSelfNickname,
  modeAllowed, modePreset, isSessionAllowedInCurrentMode, initModeCore,
} from './core/mode.js';
import {
  warmGroupName, getGroupDisplayName, formatGroupListLine, warmGroupInfo,
  getCachedGroupInfo, formatGroupInfoLine, initGroupCacheCore, setGroupCacheBot,
} from './core/group-cache.js';

import { handleIncoming, pumpMux, initMuxCore, setMuxApi, setMuxBot } from './core/mux.js';
import { startDshWatch, writeLastMode, initDshWatchCore, setDshWatchApi, setDshWatchBot } from './core/dsh-watch.js';
import { startConsoleServer, initConsoleCore, setConsoleApi, setConsoleBot, setConsoleMedia, setConsoleLastModeSink } from './core/console-server.js';
import { resolveDshTarget, isInstalled, installToIsolatedDsh, installPresets } from './lib/dsh-side.js';

// 路径与 JSON 读写已外置：lib/paths.js、lib/json-fs.js（见上方 import）

// 控制台鉴权 token：未配置时自动生成并持久化到 state/console-token，避免默认无鉴权。



// 回复审计：agent 回复若命中以下特征（本机路径/凭据），硬性拦截不发送。
// 宁可误拦，不可泄露。


// 分句规则提示：真人聊天不会主动用空格，因此空格被桥接当作“分条信号”。
// 中英文/数字之间的空格同样会分条，所以不想分条就不要加空格。
// 群聊指向性提示：引用/回复段表示“这句话是在对被引用的人说”，避免 AI 把群友之间的对话误当成指向自己。






// ── 工具 ────────────────────────────────────────────────────────────────────





// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  // 内置隔离 DSH 端自安装（幂等、异步、非阻塞）：把 qq-bridge 的 preset/MCP/插件装到
  // 隔离 DSH home（项目 .runtime 或 manager 隔离 home，自动探测），默认绝不碰桌面端 DSH。
  void (async () => {
    try {
      const target = resolveDshTarget();
      if (target.refusedDesktop || !target.booted) return;
      // 【2026-09-12】preset 每次启动都刷新：它是**桥自带的代码资产**（persona / [WAKE TYPES] / [RULES]），
      // 不是主人数据；而原来的逻辑是"装过一次就靠 marker 全跳过"，导致改了 agent.cordis.yml
      // 之后重启桥**根本不会把新 preset 装进去**（实测活体 preset 一直停在旧哈希）。
      // MCP/插件那些开销大的部分仍由 marker 把关，不受影响。
      try {
        installPresets(target);
        log(`[dsh-side] preset 已刷新到 ${path.join(target.home, '.agent-presets')}`);
      } catch (ePre) {
        log(`[dsh-side] preset 刷新失败（继续用现有 preset）: ${ePre?.message ?? ePre}`);
      }
      if (isInstalled(target)) return;
      log(`[dsh-side] 内置隔离 DSH 未安装 qq-bridge 端（${target.home}），自动安装…`);
      await installToIsolatedDsh();
    } catch (error) {
      log(`[dsh-side] 自动安装失败（可稍后执行 node scripts/setup-dsh.mjs）：${error?.message ?? error}`);
    }
  })();
  initMuxCore(cfg);
  initConsoleCore(cfg);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  acquireLock();
  loadState();
  initStickerCore(cfg);
  initDocxCore(cfg);
  initQqSendCore(cfg);
  setTunableCfg(cfg);
  initQzoneCore(cfg);
  initEventsAuxCore(cfg);
  initMemoryCore(cfg);
  initWakeCore(cfg);
  setWakeDeliver(deliverPrompt);
  initGroupCacheCore(cfg);
  initSocialCore(cfg);
  // 投递看门狗：兜"桥已经收下、却因为某条链路静默失败而一直没交给模型"的消息。
  // 判据是 lastDeliveredSeq（未交付）而不是"有没有被回复"——模型看到后选择不回是它的自由，
  // 但**没看到**必须被兜住。正常路径下它一次都不会触发（投递 1~3 秒内完成）。
  try { startDeliveryWatchdog(); } catch (error) { log('[watchdog] 启动失败:', error?.message ?? error); }
  initModeCore(cfg);
  initDshWatchCore(cfg);
  initCrossChatCore(cfg);
  initAuditCore(cfg);
  initDshSessionCore(cfg);
  initSlangCore(cfg);
  initPersonaLearnCore(cfg);
  // 语音能力（MiMo TTS/ASR）：配置存在 state/voice-config.json，管理端保存即生效，无需重启桥
  initVoiceCore(cfg);
  // NapCat 鉴权令牌：写进 NapCat 自己的配置 + 重启容器（管理端「NapCat 令牌」卡走这里）
  initNapcatTokens(cfg);
  // 发送抽签（语音 / 表情包的概率与冷却）：桥侧掷骰后写进唤醒正文，不让模型自己猜概率
  initSendDice(cfg);
  initTokenMeter(cfg);
  // 用量对账：DSH 自己的 projcache 里有按会话累计的权威 token 数（tokenUsage.totals）。
  // 单帧漏记（帧里没有 sessionId / 会话刚好结束）会让面板偏低，这里定期把差额补成
  // reconciled:true 的行，使面板 == DSH 侧真实值。找不到 DSH home 时静默跳过（不影响主流程）。
  try {
    const dshTarget = resolveDshTarget();
    if (dshTarget && !dshTarget.refusedDesktop && dshTarget.home) {
      setTokenReconcileHome(dshTarget.home);
      startTokenReconcile();
      log(`[token] 用量对账已启用：${path.join(dshTarget.home, 'storages', 'session_projcache', 'sessions')}`);
    } else {
      log('[token] 未找到可用的 DSH home，跳过用量对账（面板数字只按 usage 帧累计）');
    }
  } catch (error) {
    log(`[token] 用量对账初始化失败（忽略）: ${error?.message ?? error}`);
  }
  initSessionArchiveCore(cfg);
  try { setConvKeyResolver((sessionId) => reverse.get(String(sessionId)) ?? null); } catch (_) {}
  initPromptDeliverCore(cfg);
  initSocialFlowCore(cfg);
  initMediaPipeCore(cfg);
  setScheduledRecorder(recordSentMessages);
  setWakeSender(sendWakePrompt);
  // 会话忙时把新消息塞进在途回合（DSH mode:'steer'），省掉"结束后再唤醒一轮"的整轮往返
  setSteerSender(steerIntoRunningTurn);
  if (typeof steerIntoRunningTurn === 'function') log('[steer] 已注册「在途回合注入」(session/prompt mode:steer)');
  else log('[steer] 注册失败：steerIntoRunningTurn 不是函数（导入异常）');
  const { sendRich, musicSearch } = createMediaDomain(cfg);
  setConsoleMedia(sendRich, musicSearch);

  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  }

  // DSH 侧：官方 dsh（0.1.2+）web/API 都要 cookie —— manager 会把隔离 DSH 日志路径经
  // DSH_ISOLATED_LOG_FILE 注入本进程，NodeApiClient 从日志解析最新 web token 换 dsh-auth cookie；
  // 无该 env（手动直跑/旧版无 token 实例）自动退化为免鉴权直连。
  // seqFile：把"每会话已处理的最高事件 seq"落盘。否则桥一重启就丢水位，follow 快照会把
  // 整段历史重放一遍，而重放帧与实时帧同形、pumpMux 分不出来 → 历史回合副作用被重跑
  // （重复计 token、重放"无正文收尾"误标新未读、旧回复被写回 pendingUndeliveredText 触发重复回复、
  // 重放帧重新武装看门狗造成重启后 180s 批量误杀会话）。
  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    dshLogFile: process.env.DSH_ISOLATED_LOG_FILE || '',
    seqFile: path.join(STATE_DIR, 'dsh-seq.json'),
  });
  setTurnGuardApi(api);
  setWakeApi(api);
  setDshSessionApi(api);
  setSlangApi(api);
  setPersonaLearnApi(api);
  initPersonaAutoLearn(cfg); // 人格自动间隔学习（learning-config persona.autoIntervalEnabled）
  initPortraitLearn();       // 群友画像学习（立即 / 间隔 / 每日定时，learning-config portrait.*）
  // 学习会话专用令牌：启动就生成/登记，别等第一次学习提醒才建文件 ——
  // 否则「模型拿着令牌来提交」和「桥这边还没建过令牌」的时序会打架。
  try { ensureLearningToken(); } catch (error) { log('学习令牌初始化失败:', error?.message ?? error); }
  setPromptApi(api);
  setPromptMediaResolver(resolveMediaList);
  setEventsAuxApi(api);
  setMuxApi(api);
  setConsoleApi(api);
  setDshWatchApi(api);
  setSessionArchiveApi(api);
  // 活动感知回合看门狗：只在“完全静默”超过该时长（无任何 turn/tool/流式事件）才判定卡死。
  // default 防“忘记设置唤醒条件”：key -> 当前是否等待 AI 处理唤醒回合 / 本回合已更新唤醒配置 / 连续未设置次数
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, key);
  // rc.1 无全局 mux：事件泵按活跃会话逐个 open session/follow。把会话集合(正式映射 +
  // 黑话/人格学习者 + 预热备用会话)注册给客户端，pumpMux 每轮拉取并自动订阅/退订。
  {
    const activeSids = () => {
      const out = [];
      const seen = new Set();
      for (const sid of reverse.keys()) if (sid && !seen.has(sid)) { seen.add(sid); out.push(sid); }
      for (const sid of state?.sessions ? Object.values(state.sessions) : []) if (sid && !seen.has(sid)) { seen.add(sid); out.push(sid); }
      try { for (const sid of learnerSessions ?? []) if (sid && !seen.has(sid)) { seen.add(sid); out.push(sid); } } catch {}
      try { for (const st of social?.conversations?.values() ?? []) { const bs = st?._standbySessionId; if (bs && !seen.has(bs)) { seen.add(bs); out.push(bs); } } } catch {}
      return out;
    };
    api.setSessionIdSource(activeSids);
  }

  // DSH 重启期间收到的 QQ 消息先入队（不丢），DSH 恢复后按序补投。
  setConsoleLastModeSink(writeLastMode);

  loadSocialState();

  // QQ 侧（NapCat OneBot WebSocket 客户端）
  const bot = new OneBotWsClient({
    url: cfg.napcat.wsUrl,
    accessToken: cfg.napcat.wsAccessToken || cfg.napcat.accessToken || undefined,
    reconnect: true
  });
  // 【2026-09-16 保登录态】连接是否活着（下面 open/close 里维护）+ "不回复"排查用的登录态巡检
  let napcatUp = false;
  setStickerBot(bot);
  setQqSendBot(bot);
  setGroupCacheBot(bot);
  setMessageCacheBot(bot);
  setMediaPipeBot(bot);

  setMuxBot(bot);
  setConsoleBot(bot);
  setDshWatchBot(bot);
  bot.onPrivateMessage(async (event) => {
    if (event.user_id === event.self_id) return;
    try { await handleIncoming('private', event.user_id, event, cfg); } catch (error) { log('处理私聊消息出错:', error?.message ?? error); }
  });
  bot.onGroupMessage(async (event) => {
    if (event.sender?.user_id === event.self_id || event.user_id === event.self_id) return;
    try { await handleIncoming('group', event.group_id, event, cfg); } catch (error) { log('处理群消息出错:', error?.stack ?? error?.message ?? error); }
  });
  bot.onNotice('notify', async (event) => {
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
    try { await handleInputStatusNotice(event); } catch (error) { log('处理输入状态事件出错:', error?.message ?? error); }
  });
  // 撤回事件（对方撤回）：在上下文里标记 [已撤回]，AI 不再引用；并同步落库 chat_messages.recalled_at，
  // 让 SQLite 成为撤回状态的可靠事实源（重启后 /recent、未读恢复、引用解析回退都读得到）。
  bot.onNotice(async (event) => {
    const nt = String(event?.notice_type ?? '');
    if (nt !== 'group_recall' && nt !== 'friend_recall') return;
    try {
      const msgId = String(event.message_id ?? '');
      const key = nt === 'group_recall' ? `group:${event.group_id}` : `private:${event.user_id}`;
      if (!msgId) return;
      // DB 落库放在内存会话守卫之前：即使该会话尚未加载（重启后极早期/新会话），撤回也要覆盖 chat_messages。
      try {
        const dbMark = await markChatRecalled(key, msgId);
        log(`[recall] DB 已标记撤回 ${key} ${msgId}（updated=${dbMark.updated ?? 0}）`);
      } catch (error) { log(`[recall] DB 标记撤回失败: ${error?.message ?? error}`); }
      if (!social.conversations.has(key)) return;
      const stR = getSocialState(key);
      let marked = 0;
      if (Array.isArray(stR.recentMessages)) {
        for (const m of stR.recentMessages) {
          if (m && String(m.messageId || '') === msgId && !m.recalled) { m.recalled = true; marked += 1; }
        }
      }
      if (marked > 0) {
        saveSocialState();
        log(`[recall] 对方撤回消息已标记 ${key} ${msgId}（${marked} 条）`);
      }
    } catch (error) { log('处理撤回事件出错:', error?.message ?? error); }
  });
  // 好友请求：自动审批（deny 黑名单拒绝，其余同意）；开关 autoFriendApproval 可关
  bot.onRequest('friend', async (event) => {
    if (cfg.social?.autoFriendApproval === false) return;
    try {
      const flag = String(event.flag ?? '');
      const uid = String(event.user_id ?? '');
      if (!flag) return;
      const denied = (Array.isArray(cfg.deny?.private) ? cfg.deny.private : Array.isArray(cfg.deny?.privates) ? cfg.deny.privates : []).map(String).includes(uid);
      await bot.setFriendAddRequest(flag, !denied);
      log(`[friend] 自动${denied ? '拒绝' : '同意'}好友请求 ${uid}`);
      if (denied) {
        try { await sendToQQ('private:' + String(cfg.ownerQQ), `已自动拒绝黑名单用户 ${uid} 的好友请求。`); } catch {}
      }
    } catch (error) { log('自动审批好友请求出错:', error?.message ?? error); }
  });

  bot.on('open', () => { napcatUp = true; log(`NapCat 已连接：${cfg.napcat.wsUrl}`); });
  bot.on('close', (info) => { napcatUp = false; log(`NapCat 连接断开（code=${info?.code ?? '?'} reason=${String(info?.reason ?? '').slice(0, 80)}），重连中…`); });
  // 【2026-09-15】以前这里直接把 error 对象丢给 log，而 Error 经 JSON.stringify 是 `{}` ——
  // 日志里只看到 `NapCat 错误: {}`，**一点线索都没有**（排查"不回复"时被这个坑了一次）。
  // 现在把 message/code/cause 都打出来，并带上 WS 状态与 URL，一眼能看出是握手被拒还是断线。
  bot.on('error', (error) => {
    const detail = [error?.message, error?.code, error?.cause?.code, error?.cause?.message]
      .filter(Boolean).join(' | ') || String(error);
    log(`NapCat 错误: ${detail}（wsUrl=${cfg.napcat.wsUrl}）`);
  });

  /* 【2026-09-16 保登录态：把"不回复"的分叉判据写进日志】
   * 主人反复遇到的"又不回复了"其实只有两种：
   *   ① **QQ 掉登录态**（NapCat 里没登录）→ 只能扫码，扫码后**会话/快速登录信息**会重新落进数据卷；
   *   ② **桥的连接断了**（QQ 那边一切正常）→ 3.1.3 起桥会判死即重建（退避封顶 10s），自己接回。
   * 以前这两种在日志里长得一模一样（都只是连不上），只能靠翻 NapCat 容器日志去猜。
   * 现在：只要 WS 没连上，就每分钟去问一次 NapCat 的 WebUI「QQ 到底登录没有」，状态变了才打一行，
   * 说明白是哪一种、下一步该干什么。连上时完全不查、不打日志。
   */
  const LOGIN_WATCH_MS = 60000;
  let loginNote = '';
  let loginNoteAt = 0;
  const loginWatch = setInterval(() => {
    void (async () => {
      if (napcatUp) return;
      let st = null;
      try {
        const mod = await import('./core/napcat-tokens.js');
        st = await mod.probeQqLoginState();
      } catch (error) {
        st = { ok: false, error: String(error?.message ?? error) };
      }
      const note = !st?.ok
        ? `登录态查不到（${st?.error ?? '未知'}）—— 多半是 NapCat 还没起来/WebUI 不可达，桥会继续重连`
        : (st.isLogin
          ? `QQ **仍是登录态**（${st.nick || '已登录'}${st.online ? '、在线' : ''}）⇒ 只是桥的连接断了，桥会自动重连（退避封顶 10s）；一分钟还没接上就看上面的重连错误`
          : '⚠️ **QQ 已掉登录态**：需要去管理端首页 → NapCat WebUI 扫码。登录态存在数据卷 napcat-qq + 配置目录里的 napcat_<qq>.json，正常情况下重启桥/重启容器/掉电都**不会**掉登录（容器起来后按 ACCOUNT 自动快速登录）');
      const now = Date.now();
      if (note !== loginNote || now - loginNoteAt > 300000) {
        loginNote = note;
        loginNoteAt = now;
        log(`[napcat-login] ${note}`);
      }
    })();
  }, LOGIN_WATCH_MS);
  loginWatch.unref?.();

  // 【2026-09-12 修「启动不顺畅 / 桥自己死掉」】
  // onebot-ws 的老语义是：**首次 open 之前就 close** → reject(NAPCAT_CONN) → 这里 await 抛出去 →
  // main() 崩 → process.exit(1)。可 NapCat 启动要十几秒、首次还要扫码，于是：
  //   · 「一键启动整套」按顺序拉起时，桥几乎必然在 NapCat 就绪前先连一次 → 直接退出（今天 13:29/13:30 连死两次）；
  //   · 用户看到的是"整套启动成功"但机器人根本不收消息，还得再手动点一次桥的启动。
  // 现在改成：首次连接失败就带退避重试（NapCat 还没起/还没扫码都是正常情况），
  // 预算内连上就继续；预算用完也**不退出** —— 桥保留控制台与后台重连循环，等 NapCat 起来自己接上。
  const connectNapcat = async (budgetMs) => {
    const t0 = Date.now();
    for (let attempt = 1; ; attempt += 1) {
      try {
        await bot.connect();
        return true;
      } catch (error) {
        if (error?.code !== 'NAPCAT_CONN') throw error;
        const waited = Date.now() - t0;
        if (waited >= budgetMs) return false;
        const delay = Math.min(15000, 1500 * attempt);
        log(`[napcat] 第 ${attempt} 次连接未成功（NapCat 可能在启动/等待扫码）：${delay / 1000}s 后重试`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  };
  const napcatConnected = await connectNapcat(Math.max(0, Number(cfg.social?.napcatStartupBudgetMs) || 120000));
  if (!napcatConnected) {
    log('[napcat] 启动预算内仍未连上：桥继续运行（控制台可用），后台每 15s 再试一次，NapCat 就绪后自动接上');
    // 后台常驻重连：连上即停。绝不能因为"暂时连不上 NapCat"把整条桥弄死。
    void (async () => {
      for (;;) {
        await new Promise((r) => setTimeout(r, 15000));
        try {
          if (await connectNapcat(1)) {
            log('[napcat] 已接上 NapCat（后台重连成功）');
            void fetchNickname();
            return;
          }
        } catch (error) {
          log('[napcat] 后台重连异常：', error?.message ?? error);
        }
      }
    })();
  }
  // 读取机器人昵称（用于社交模式"被提到"识别）
  // ⚠️ 未连上时**不要**在这里等：getLoginInfo 会一直等回包（实测把后续 startConsoleServer 拖了 30 秒，
  // 用户看到的正是"桥起来半天、点开是白屏"）。没连上就交给后台重连成功后那次 fetchNickname。
  const fetchNickname = async () => {
    try {
      const login = await Promise.race([
        bot.getLoginInfo(),
        new Promise((r) => setTimeout(() => r(null), 8000)),
      ]);
      if (login?.nickname) {
        setSelfNickname(String(login.nickname).toLowerCase());
        log(`机器人昵称: ${login.nickname}`);
      }
    } catch { /* 拿不到昵称不影响主流程 */ }
  };
  if (napcatConnected) await fetchNickname();
  log('桥接已启动。按 Ctrl+C 退出。');
  // 恢复定时发消息任务（需在所有 const 定义之后调用）
  try { loadScheduledTasks(); } catch (error) { log(`[scheduled] 恢复定时任务失败: ${error?.message ?? error}`); }
  try { loadDocxQuota(); } catch (error) { log(`[docx] 恢复每日额度失败: ${error?.message ?? error}`); }
  try { loadActivityWindows(); } catch (error) { log(`[activity] 恢复活跃时段失败: ${error?.message ?? error}`); }
  startActivityTick();
  // DSH 空闲会话自动归档：定时把「QQ 聊天」工作区里不再被引用的旧会话归档，防止 session 目录堆积。
  try { loadArchivedCache(); startSessionArchiveTicker(); } catch (error) { log('[archive] 自动归档启动失败:', error?.message ?? error); }
  // 预热表情库：启动时同步一次 QQ 收藏表情，失败不阻塞（AI 首次调用工具时还会再试）。
  if (cfg.social?.sticker?.enabled !== false) {
    syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', error?.message ?? error));
  }
  startDshWatch();
  startConsoleServer();
  // 配置热加载：管理器保存 config.json 后**原地**更新 cfg（不换对象引用——它已被 initXxxCore 注入到
  // 十几个模块），免重启即生效。模型相关字段变化时清掉"已 selectModel"缓存，让已存在的会话下一轮就换新模型。
  // 以前这里没有监听，管理器改完桥接还拿着启动时的旧值，甚至把旧值写回 config.json 把改动抹掉。
  try {
    watchConfigFile(cfg, {
      onChange: (changed) => {
        if (changed.some((k) => k.startsWith('dsh'))) {
          resetVisionModelApplications();
          log('[config] 模型配置已变化，已清空会话模型缓存（下一轮起用新模型）');
        }
      },
    });
  } catch (error) { log('[config] 热加载监听启动失败:', error?.message ?? error); }
  // 黑话每晚定时学习（北京时，管理端 learning-config 可改时间；从学习标记处增量拉取 sqlite）
  try { initSlangNightly(cfg); } catch (error) { log('黑话定时学习初始化失败:', error?.message ?? error); }

  await pumpMux();
}

process.on('SIGINT', () => {
  log('退出中…');
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => log('未处理异常:', error?.message ?? error));
process.on('exit', () => releaseLock());

// 【2026-09-12 保命护栏】stdout/stderr 的管道断了（管理器被重启/被 Electron 壳 taskkill 之后就是这种情况）
// 会让下一次 console.log 抛 EPIPE —— Node 对 stdout 的未处理 error 直接**打死进程**，
// 而且死得毫无痕迹：崩栈也写不进那个已经断掉的 stderr。实测表现就是"重启一下管理器，桥悄悄没了，
// 机器人不再回消息，日志里连一句错误都没有"（桥侧日志停在最后一条正常业务行）。
// 管理端已经改成把子进程 stdout 直写日志文件（spawnWithLogFile），这里是双保险：
// 任何情况下丢日志都可以接受，丢机器人不行。
for (const s of [process.stdout, process.stderr]) {
  try { s.on('error', () => {}); } catch { /* 忽略 */ }
}

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});

