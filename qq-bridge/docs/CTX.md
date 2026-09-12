# CTX 化设计（P4 · 域抽取起点）
> 背景：bridge.js 11,036 行，main() 从 L455 到文件尾，265+ 嵌套函数闭包共享约 60 个局部状态变量。
> 纯函数层（A/B 组）与模块级工具已全部外提（lib/ 18 模块，见 ANALYSIS.md）。
> 本阶段目标：把"闭包共享状态"收进显式容器，让域函数能以 `(ctx, …)` 或工厂注入方式迁出 main。
> 硬约束：行为不变、每域备份 + `node --check` + `npm run check` 门禁、主干（sendToQQ/handleIncoming/
> pumpMux/socialLoopTick/console server）留在 main 直到最后（ANALYSIS C 组）。

## 状态清单（2026-09-05 实测盘点，行号已随迁移漂移，勿作锚点）

### A. 启动期底座（main L455-459）
`cfg`（loadConfig 产物，只读）、`state`（模块级单例，loadState/saveState 读写）、
acquireLock/releaseLock、`fs.mkdirSync(STATE_DIR)`。

### B. M3 黑话学习（~L462-474）— 10 变量
slangEntries(可变数组)、slangWindows、slangExtractionCooldowns、slangSubmitTimes、
feedbackTimes、slangResearchingIds、learnerSessions、learnerCollectors、learnerWaiters、
lastSendDedup、sendCallTimes、slangLearnerSessionId、slangTaskChain。

### C. M1/M2 表情/贴纸/富媒体（~L477-）— 4 变量 + DOC 常量
stickerEntries(可变)、stickerSyncedAt、lastForcedAgentStickerSync、docxQuota、
DOC_TMP_HOST_DIR/DOC_TMP_CONTAINER_DIR。

### D. M4 会话/回合/队列/看门狗（~L1399-1730）— 约 30 变量
collectors、sendToolSucceededSessions、v2TurnStartAt、turnTimeoutTimers、turnTotalTimers、
loopRepeatState、loopRecoverTimes、activeAiTurns、pendingTurnOutbound、toolCallNames、
pendingSendToolCalls、pendingWakeKeys、activeWaits、pendingWakeLeaseTimers、lastWakeRebroadcast、
wakeConfigUpdatedKeys、markReadCalledKeys、wakeConfigMissCount、reverse、sessionPromises、
promptQueues、crossChatCache、currentMode、closedAgentPreset、queued、queuedHintAt、queueRetries、
sessionEpoch、pending(RPC)、sendChain。

### E. M8/M9 社交（~L6649-6920）— 约 15 变量
visionModelAppliedSessions、selfNickname、social(states/recentMessages/…整个对象)、
socialV2(conversations/paused/…)、messageMediaStore、seenForwardIds、activityWindows、
activityWakeCooldown、activityTickTimer。

### F. M10 记忆/画像/SQLite/缓存（~L7934-8373）— 约 7 变量
roleHintCache、groupMemberNameCache、replyInfoCache、memDb、groupInfoCache、groupNameCache。

### G. M12 定时任务（~L9260）— 2 变量 + WAKE_PRIORITY 常量
scheduledTimers、scheduledRetries。

## 容器设计

```text
src/core/
  ctx.js      —— createCtx()：按上表分组构建显式状态容器 + 访问器
  config.js   —— loadConfig/loadState/saveState + state 单例迁入（自 lib/config.js 纯函数 + 此有状态壳）
  runtime.js  —— acquireLock/releaseLock/入口清理
```

### createCtx() 形态（工厂，保持 main 编排）

```js
export function createCtx() {
  return {
    cfg,                    // main 传入（loadConfig 一次）
    slang: { …B 组 Map/Set/let…, setEntries() },
    sticker: { …C 组… },
    conv: { …D 组… },       // 会话/回合/看门狗
    send: { chain: Promise.resolve(), … },
    social: { …E 组… },
    mem: { …F 组… },
    timers: { …G 组… },
    api: null, bot: null,   // 连接就绪后注入（run 阶段）
    state,                  // config.js 单例引用
  };
}
```

### 迁移顺序与手法（每域独立成文件 src/core/<domain>.js）

1. **域函数出口统一签名**：`function foo(key, …)` → `function foo(ctx, key, …)`；
   为控制改动面，优先"工厂注入依赖"：`export function createSlangDomain(deps)`，deps 只含该域
   用到的容器分片与跨域调用点（如 sendChain、log、bot/api）。
2. **跨域调用登记**：main 目前函数互调极密（如 sticker → sendChain；conv → social）。
   每域抽出前先在 ANALYSIS.md 域矩阵登记"本域调用了哪些外部函数"，缺依赖的函数暂缓外提
   （按 ANALYSIS C 组，主干互调链留 main）。
3. **试点选型**：M3 黑话学习域（slang 变量高度内聚，跨域调用少：log/appendActivity/saveSlang/
   黑话工具 API）或 M1 表情域（sticker 内聚 + sendChain 只经 sendStickerV2 出口）。
4. 每域：备份 → 新建 core/<domain>.js（函数原样 + deps 注入）→ main 内改调用点传 ctx →
   删除 main 内函数 → 门禁 → 冒烟。

### 收尾目标（跨阶段）

- main 只保留：启动编排（建 ctx、连 bot/api）、M5 控制台 HTTP、M11 入站/泵、sendToQQ 主干骨架、
  handleIncoming/pumpMux/socialLoopTick 组装层。
- bridge.js 目标 < 4000 行（check-size 门槛），然后按 REFACTOR.md 拆 index/main 入口与自我冒烟。

## 迁移进度（2026-09-05）

- ✅ **P4-1 配置/状态收编**：`loadConfig` + `state` 单例 + `loadState`/`saveState`（bridge.js 原
  107-383 行，277 行）整体迁入 `src/core/config.js`（自引 lib/paths、lib/json-fs、lib/config 纯函数）。
  bridge.js 经 import 活绑定共享同一 `state` 实例（loadState 内部重赋值，bridge 侧只做字段变更，
  无 `state =` 重赋值——已核查）。bridge.js 10760 行，npm run check 全绿，备份 .bak-p4cfg。
  脚本 scripts/p4-cfg-migrate.mjs（范围校验 + 备份）。
- ⏭ P4-2：迁移锁与入口（acquireLock/releaseLock → src/core/runtime.js）；随后试点域抽取
  （候选 M3 黑话学习或 M1 表情域，见上"迁移顺序与手法"）。
- ✅ **P4-2 锁与入口收编**：acquireLock/releaseLock（bridge.js 原 109-167 行，59 行）→ `src/core/runtime.js`
  （含原子建锁 wx/PID 校验/ESRCH 过期判定全套逻辑原样）。bridge.js 10702 行，check 全绿，
  备份 .bak-p4rt。
- ⏭ **P4-3 试点域（M1 表情/贴纸）**：已盘点依赖——stickerEnabled/saveStickerStoreSafe/
  syncStickerLibrary/listStickersForV2/getStickerImageData/sendStickerV2/sendQqFaceV2 约 147-380 行，
  依赖 cfg/bot/日志/sendChain；sendChain 在 bridge main 共 8 处重赋值（3 处随本域、5 处留在主干）。
  方案：新建 core/send-chain.js（export let chain + enqueue(task) 统一入队），8 处机械改为 enqueue，
  再把本域函数迁入 src/core/sticker.js（cfg/bot 走 deps 注入或单例）。门禁后删 main 内函数。
- ✅ **P4-3 试点域（M1 表情/贴纸）完成**（2026-09-05）：
  1) sendChain 中央化：新建 src/core/send-chain.js（enqueueSend/currentSendChain），8 处直接重赋值
     全部改为队列 API（sendToQQ/sendBurstToQQ/sendMessagesV2 改写为任务内 try/catch+await sleep，
     语义 1:1：入队序、失败日志、sent/failed 聚合、末位检查不变）；bridge 删局部 decl。脚本
     p4-chain-unify.mjs（首跑发现 sendMessagesV2 return 块跨行超出区间→还原修正 6249-6274 后成功）。
  2) 域抽取：新建 src/core/sticker.js——共享状态 export let（stickerEntries/stickerSyncedAt）+ cfg
     注入 initStickerCore(cfg)+ bot 注入 setStickerBot(bot)+ 变更出口 updateStickerEntries(next)；
     7 函数原样迁入（cfg→stickerCfg、bot→botRef 仅两处机械替换）；main 启动 init、bot 构造后
     setStickerBot、3 处整体重赋值改 updateStickerEntries；删除 main 内 195 行。
  bridge.js 10510 行，npm run check 全绿；import 冒烟无 ReferenceError（止于 NapCat WS 离线）。
  备份 .bak-p4chain/-p4stk。
- ⏭ P4-4：同法抽取相邻富媒体段（sendRichV2/musicSearchV2/docx 上传，M2 域）与 M3 黑话学习域
  （slang 状态高度内聚），或按 ANALYSIS 顺序进入 M6 发送链路主干拆分试点。
- 🔍 P4-4 侦察（2026-09-05）：M2 富媒体域实测——sendRichV2(153-203)/musicSearchV2(206-256) 仅依赖
  cfg/日志/发送链，可独立迁出；docx 簇（uploadFileToQQ/writeDocxToMount/sendDocxV2 + 额度三函数 +
  DOC_TMP/DOCX 常量）依赖 cfg 派生常量（DOCX_DAILY_QUOTA/DOCX_QUOTA_FILE 在 main 执行期求值），
  需 initDocxCore(cfg) 懒加载或工厂注入；但 recordDocxSentV2/sendHelpDocV2/postRandomQzone 横跨
  socialV2 状态/persistChatMessageV2/initMemoryDb/sendToQQ —— 按 C 组规则登记为"随 M6/M8/M10
  主干拆分"，不单独硬拆。建议 P4-4 优先 M3 黑话学习域（状态在 main 头 128-141 高度内聚）。
- ✅ P4-4 完成（2026-09-05）：M3 黑话状态经实测横跨 console(M5)/事件泵(M11) 共 122 处引用、含 10+
  非域增删点 → 按 C 组不硬拆；改为迁出可独立小域——
  1) sendRichV2/musicSearchV2 → src/core/media.js（createMediaDomain(cfg) 工厂，无跨域状态）
  2) docx 簇 → src/core/docx.js（模块级：DOC_TMP_*/MAX_DOCX_CHARS 常量 + initDocxCore(cfg) +
     docxQuota 额度三函数 + writeDocxToMount/uploadFileToQQ/sendDocxV2；DOCX_DAILY_QUOTA 由 main
     执行期常量改为内部 lazy dailyDocxQuota()）
  bridge.js 10319 行（累计 -1327），npm run check 全绿，import 冒烟无 ReferenceError。备份
  .bak-p4media/-p4docx。recordDocxSentV2/sendHelpDocV2 留在 main 走 import 引用常量与 uploadFileToQQ。
- ⏭ P4-5：剩余可独立小域只剩零星函数；下一大块需按域矩阵推进——候选顺序：M6 发送链路主干试点
  （onebotSend/sendMessagesV2 周边，M5 依赖其间隙）→ M3 引擎（需先把 console CRUD 与事件泵引用
  收敛到访问器）→ P5 M8/M9。
- ✅ P4-5（M6 前置清理，2026-09-05）：出站文本清洗簇迁出 → src/lib/outbound-text.js
  （ARTIFACT_TOKEN_RE + sweepMessageArtifacts/stripMessageArtifacts/cleanOutboundText +
  redactKnownTokensOnly，46 行；自引 lib/text-safe 的 KNOWN_AGENT_TOKENS 活绑定与 lib/emoji）。
  sendToQQ/sendBurstToQQ 现已零 main 依赖待迁（仅 cfg/bot/发送链/超时常量），下一批可整簇迁入
  core/qq-send.js。bridge.js 10274 行，check 全绿，备份 .bak-p4text。
- ✅ P4-6（M6 试点第一批）：sendToQQ/sendBurstToQQ → src/core/qq-send.js（SEND_TIMEOUT_MS 随迁，
  cfg 静态注入 initQqSendCore + bot 注入 setQqSendBot，bot.sendXxx 包 text() 保持 @snowluma 语义）。
  main 头部 init、bot 构造后 setter。bridge.js 10210 行，check 全绿，import 冒烟仅止 NapCat WS 离线。
  备份 .bak-p4qqsend。剩余发送链路：planSocialTimeline（纯，可随迁）/onebotSend/sendMessagesV2
  （依赖 getSocialV2State/initMemoryDb 等 C 组访问器，登记待 M8/M10 收敛后迁移）。
- ✅ P4-7（M10 记忆/聊天 SQLite，2026-09-05）：档案簇(7379-7539)+聊天记录簇(7612-7726) 共 276 行
  → src/core/memory.js（memDb 模块级单例 + initMemoryDb 建库建表/索引；getProfile/setProfileField/
  formatProfileText/profileDisplayName/formatContactsLine/resolveNameToUid；persistChatMessageV2/
  searchChatMessagesV2/deleteChatMessagesV2/clearChatHistoryV2）。中间群缓存簇（bot 依赖）留 main。
  SQLite 端到端冒烟（建表/写入/搜索/删除）通过。bridge.js 9939 行——**跌破 1 万行**，累计 -1707。
  备份 .bak-p4mem。
- ✅ P4-8（群缓存域，2026-09-05）：bridge.js 原 7385-7454（banner+groupInfoCache/groupNameCache/
  GROUP_INFO_TTL_MS + warmGroupName/getGroupDisplayName/formatGroupListLine/warmGroupInfo/
  getCachedGroupInfo/formatGroupInfoLine，70 行）→ src/core/group-cache.js（initGroupCacheCore(cfg)
  + setGroupCacheBot(bot) 注入）。bridge.js 9875 行，check 全绿，import 冒烟无 ReferenceError。
  备份 .bak-p4gc。
- ✅ P4-9（活跃时段域，2026-09-05）：bridge.js 原 6026-6098（banner+activityWindows+load/save/
  getActivityWindows/inActivityWindow/nextActivityWindowStart/activityStatusLine，73 行）→
  src/core/activity.js（无 cfg 依赖，模块级 export let activityWindows + JSON 持久化）。
  定时器 startActivityTick/activityWakeCooldown/activityTickTimer（依赖 sendWakePromptV2）保留 main。
  bridge.js 9806 行，check 全绿，冒烟无 ReferenceError。备份 .bak-p4act。
- ✅ P4-10（社交状态容器，2026-09-05）：bridge.js 删除 social(5933-5942)/socialV2(5944-5949) 容器 +
  defaultWakeConfigV2(5958-5990) + softResetWakeConfigV2(5992-6028)（86 行）→ src/core/social-state.js
  （initSocialCore(cfg)；首次删除 softReset 段 splice 起点写错 off-by-37 行吃掉后续代码，备份还原+修正
  5991 后成功）。bridge.js 9724 行，check 全绿，冒烟无 ReferenceError。备份 .bak-p4soc。
  后续访问器（getSocialV2State/loadSocialV2State/saveSocialV2State 6142-6309）依赖 M8 调度簇
  （scheduleProactiveCheckV2/setupSleepTimerV2/ensureWakeableV2/refreshDefaultWakeConfigV2）与
  main 局部 seenForwardIds —— 登记为 M8 整族收敛任务，需跨多批推进。
- ✅ P4-11（M8 叶子批，2026-09-05）：bridge.js 删除 preSleepWaitBlockedV2/computeWakeSafetyV2/
  cancelSocialTimers/cancelAllSocialTimers/isInSleepWindow/WAKE_PRIORITY+wakePriorityV2（74 行）
  → 并入 src/core/social-state.js。bridge.js 9652 行，check 全绿，冒烟无 ReferenceError。
  备份 .bak-p4m8leaf。累计 -1994。剩余 M8 访问器与调度族（getSocialV2State/ensureWakeableV2/
  scheduleWakeV2/scheduleReplyCheckV2/scheduleProactiveCheckV2/setupSleepTimerV2/sendWakePromptV2…）
  依赖链更长，逐批推进。
- ✅ P4-12（2026-09-05）：planSocialTimeline（分句权交给 AI，纯函数）→ src/lib/social-timeline.js
  （27 行，自引 lib/segment 与 lib/cjk-split）。bridge.js 9626 行，check 全绿，冒烟无 ReferenceError。
  备份 .bak-p4timeline。累计 -2020。
- ✅ P4-13（2026-09-05）：seenForwardIds（二代会话 forward 缓存）声明迁入 social-state.js 模块共享
  （main 86 处引用走 import 活绑定）；saveSocialV2State（持久化）随迁（32 行，名称锚定删除脚本）。
  bridge.js 9593 行，check 全绿，冒烟无 ReferenceError。备份 .bak-p4save。累计 -2053。
  剩 loadSocialV2State/getSocialV2State 依赖 M8 调度函数（ensureWakeableV2/scheduleProactiveCheckV2/
  setupSleepTimerV2/refreshDefaultWakeConfigV2）——下批把该 SCC 内层（refresh 族+ensureWakeableV2 前置段）
  迁入后再迁两个访问器。
- ✅ P4-14（2026-09-05）：refreshDefaultWakeConfigV2/refreshAllDefaultWakeConfigsV2（27 行，依赖已全在
  模块：defaultWakeConfigV2/saveSocialV2State/socialV2）→ 并入 src/core/social-state.js（p4-refresh-del.mjs
  名称锚定）。bridge.js 9567 行，check 全绿。备份 .bak-p4refresh。累计 -2079。
  剩 ensureWakeableV2/setupSleepTimerV2/scheduleProactiveCheckV2/cancelProactiveCheckV2 依赖
  isSessionAllowedInCurrentMode/isConversationBusyV2/currentMode/sendWakePromptV2(main)——SCC 外层
  需继续剥。
- ✅ P4-15（2026-09-05）：运行模式共享化 → src/core/mode.js（currentMode/closedAgentPreset 导出
  let + setCurrentMode/setClosedAgentPreset + VALID_MODES + modeAllowed/modePreset/
  isSessionAllowedInCurrentMode + initModeCore(cfg)）；main 5 处重赋值改 setter（refreshMode 3 处 +
  控制台 2 处），冒烟确认无 "Assignment to constant"（即无漏改点）。bridge.js 9545 行，check 全绿。
  备份 .bak-p4mode。累计 -2101。剩余 SCC 阻点：isConversationBusyV2 + sendWakePromptV2。
- ✅ P4-16（2026-09-05）：① 会话/回合/队列共享状态 → src/core/session-state.js（collectors/
  v2TurnStartAt/pendingWakeKeys/sessionPromises/promptQueues 五 Map/Set，纯内容增删无重赋值）；②
  isConversationBusyV2 → 并入 src/core/social-state.js（自引 session-state 与 core/config 的 state）。
  bridge.js 9534 行，check 全绿，冒烟无 ReferenceError。备份 .bak-p4sess/-p4busy。累计 -2112。
  剩余 SCC 阻点仅 sendWakePromptV2（及其 scheduleReplyCheckV2/cancelReplyCheckV2/prompt 构建簇，
  ~800 行，需读后整簇迁移或 setWakeSender 注入解耦）。
- 🔍 wake 家族实测（2026-09-05）：sendWakePromptV2(7292-7572, 280 行) 内部还依赖 deliverPrompt/
  armPendingWakeLease/disarmPendingWakeLease/buildCrossChatBlock/formatMemoryV2/formatParticipationV2/
  fmtBeijing/isDirectedAtAi + main 局部 reverse/wakeConfigMissCount/selfNickname/TOPIC_WAKE_RE；
  buildWakePromptV2(7212-7281) 依赖同一批格式化助手。结论：wake 引擎的迁移前置是 M4 投递核心
  （deliverPrompt + lease 三件 + crosschat + memory 格式化簇），故按 ANALYSIS 顺序把下一批目标
  调整为 M4 投递/会话核心（P6 提前），而非硬迁 sendWakePromptV2。
- ✅ P4-17（2026-09-05）：M8 内层 SCC 闭环——getSocialV2State/loadSocialV2State/ensureWakeableV2/
  cancelReplyCheckV2/cancelProactiveCheckV2/setupSleepTimerV2/scheduleProactiveCheckV2（241 行）整簇
  迁入 src/core/social-state.js，sendWakePromptV2 经 setWakeSender/dispatchWake 注入解耦
  （p4-scc-del.mjs：修复默认参 `opts = {}` 干扰括号配平的问题——改为只在参数括号层外计数花括号）。
  bridge.js 9296 行，check 全绿，冒烟无 ReferenceError。备份 .bak-p4scc。累计 -2350。
- ✅ P4-18/18b（2026-09-05，加量轮）：fmtBeijing → lib/time.js；isDirectedAtAi/withTimeText →
  lib/social-timeline.js；formatParticipationV2/suggestQuietMsV2 → src/core/social-state.js；
  selfNickname → src/core/mode.js（setSelfNickname，login 重赋值改 setter）。共 6 块 ~76 行迁出，
  bridge.js 9222 行，check 全绿，冒烟无 ReferenceError。备份 .bak-p4batch/-p4b2。累计 -2424。
- ✅ P4-19（2026-09-05）：16 个回合/循环/工具监控 Map/Set（sendToolSucceededSessions/turnTimeoutTimers/
  turnTotalTimers/loopRepeatState/loopRecoverTimes/activeAiTurns/pendingTurnOutbound/toolCallNames/
  pendingSendToolCalls/activeWaits/pendingWakeLeaseTimers/lastWakeRebroadcast/wakeConfigUpdatedKeys/
  markReadCalledKeys/wakeConfigMissCount/reverse）→ 并入 src/core/session-state.js。bridge.js 9210 行
  check 全绿。备份 .bak-p4sess2。
- ✅ P4-20（2026-09-05）：跨会话互知/留言信箱簇（banner+crossChatCache+load/save/push/describe/
  addMail/unread/markRead/buildCrossChatBlock，91 行）→ src/core/crosschat.js（自引 memory/group-cache/
  social-state，无循环依赖）。bridge.js 9124 行，check 全绿，冒烟无 ReferenceError。备份 .bak-p4cc。
  累计 -2522。
- ✅ P4-21/22（2026-09-05，加量轮）：① queued/queuedHintAt/queueRetries/pending/
  visionModelAppliedSessions/messageMediaStore/activityWakeCooldown 7 状态 → session-state.js；
  ② scheduleWakeV2（58 行）→ social-state.js（sendWakePromptV2 改走 dispatchWake），
  PEER_TYPING_HOLD_MAX_MS 常量随迁共享。bridge.js 9060 行，check 全绿。备份 .bak-p4q/-p4sw。
  累计 -2586。
- ✅ P4-23（2026-09-05，大收割轮）：formatMemoryV2/appendMemoryV2 → src/core/memory.js
  （initMemoryCore(cfg)；自引 outbound-text 的 redactKnownTokensOnly 与 social-state 的
  saveSocialV2State，无循环依赖）；collectFreshWakeMedia/scheduleReplyCheckV2（sendWakePromptV2 走
  dispatchWake）/buildWakeReminderPromptV2 → social-state.js；MAX_MEDIA_COUNT → session-state.js。
  5 函数 + 常量共 160 行迁出。bridge.js 8903 行——跌破 9000，check 全绿，冒烟无 ReferenceError。
  备份 .bak-p4big。累计 -2743。
- ✅ P4-24~27（2026-09-05，自动加量轮，自动抽取脚本模式）：
  · P4-24 回合守卫：10 函数 + 7 常量 → src/core/turn-guard.js（arm/disarm/clearAllPendingWakeLeases、
    quarantineSession、recordAiTurnOutbound、finishTurnLoopGuard、armTurnWatchdog、armTurnTotalTimer、
    clearTurnTotalTimer/All；api 经 setTurnGuardApi 注入）(-167)
  · P4-25 M8 wake 引擎：evaluateWakeTriggerV2/buildWakePromptV2/sendWakePromptV2 + TOPIC_WAKE_RE →
    src/core/wake-send.js（cfg→cfgRef、api→apiRef、deliverPrompt→deliverRef（setWakeDeliver 注入））(-389)
  · P4-26 消息缓存：prune*/resolveGroupMemberName/resolveReplyInfo + 5 常量 → src/core/message-cache.js
    （setMessageCacheBot）(-120)
  · P4-27 M9 叶子：isSocialEnabled/socialState/isDirectAddress/isMustReplyText → social-state.js (-29)
  bridge.js 8198 行，check 全绿，冒烟无 ReferenceError。备份 .bak-p4guard/-p4wake/-p4mc/-p4v1。
  累计 -3448。

- ? P5-1���Զ��֣���audit �ĺ�����shouldAuditKey/shouldBlockSilentReply/handleSensitiveIntercept/
  auditAndSend���� src/core/audit.js��initAuditCore + mode/qq-send/sensitive ��������startActivityTick
  + activityTickTimer �� src/core/activity.js��socialV2/wake-send/session-state ע�룩��bridge.js 8150 �С�
  ���� .bak-p5audit��
- ? P5-2���Զ��֣���ensureVisionModel/ensureSession �� src/core/dsh-session.js��sessionEpoch ģ�鹲����
  4 �� ++ �� bumpSessionEpoch��initDshSessionCore/setDshSessionApi����bridge.js 8063 �У�check ȫ�̣�
  ð���� ReferenceError������ .bak-p5sess���ۼ� -3583��
- ? ��һ����ѡ��M3 slang ���棨state ���� + ENGINE �أ��� M4 deliverPromptNow/processPromptQueue/
  deliverPrompt Ͷ���������� withSlangContext/resolveMediaList ǰ�û�ص�ע�룩��
- ? P5-3���Զ��֣���M3 �ڻ����� 13 ���� + ȫ״̬ �� src/core/slang.js��slangEntries �� 10 Map/Set +
  learner �� + 13 ���溯����cfg/api ע�롢dshReady ��ȡ dsh-session ������slangEntries �ظ�ֵ 4 ����
  setSlangEntries��Ƕ��������ֵҲͳһ������main �Զ�ɾ����������ⲹ import����bridge.js 7808 �У�
  check ȫ�̣�ð���� ReferenceError������ .bak-p5slang/-p5slangfix���ۼ� -3838��
- ? ������M4 Ͷ�ݴأ�deliverPromptNow/processPromptQueue/deliverPrompt/flushQueue/enqueueForRetry +
  drainPromptQueue��ǰ�� resolveMediaList ý���Ǩ�ơ�
- ? P5-4���Զ��֣���M4 Ͷ�ݶ��д� �� src/core/prompt-deliver.js��enqueueForRetry/flushQueue/
  deliverPromptNow/deliverPrompt/processPromptQueue/drainPromptQueue/drainAllPromptQueues +
  QUEUE_MAX/flushingQueue��resolveMediaList ע�� setPromptMediaResolver��api ע�� setPromptApi����
  main �������Զ��� import��bridge.js 7643 �У�check ȫ�̣�ð���� ReferenceError������
  .bak-p5deliver���ۼ� -4003��
- ? ������M9 һ���罻״̬����scheduleSocialReply/socialLoopTick �ȣ�~1500 �У���������ȡ�������
  �� M4 ʣ�� ensureSessions?��Ȼ�� M11 pumpMux/handleIncoming����� M5 ����̨��
- ? P5-5���Զ��֣���M9 һ���罻״̬�� 17 ������mediaHintFor/appendRecentMessage/appendSummary/
  buildContextBlock/enterActive/leaveActive/cleanupSocialForModeChange/buildBatchPrompt/buildProbePrompt/
  buildActiveExitPrompt/triggerActiveDurationExit/buildProactivePrompt/scheduleSocialReply/socialLoopTick/
  startSocialLoop/flushSummaries/currentRoleHint��+ roleHintCache �� src/core/social-v1.js��
  SPACE_SPLIT_HINT/DIRECTION_HINT �� lib/markers.js��bridge.js 7326 �У�check ȫ�̣�ð���� ReferenceError��
  ���� .bak-p5v1���ۼ� -4320��
- ? ������M11 ��վ/�ã�handleIncoming/pumpMux ������ M9 ���� v2 ʣ����Ϣ��������
- ? P5-6���Զ��֣���������Ϣ�� 4 ������appendSocialV2Message/appendSocialV2Poke/resolveReplyTargetV2/
  isQuoteTargetSelf���� src/core/social-v2-flow.js��memory/social-state/message-cache ��������ѭ������
  bridge.js 7176 �У�check ȫ�̣�ð���� ReferenceError������ .bak-p5v2flow���ۼ� -4470��
- ? ������������β����sendMessagesV2/onebotSend �ԣ��� M11 handleIncoming/pumpMux����� M5 ����̨��
- ? P5-7���Զ��֣���onebotSend/sendMessagesV2����վ����װ+�������ͺ���������/����ͼӳ�䣩�� ����
  src/core/qq-send.js��cfg��cfgRef���Զ��� fs/outbound-text/qq-face-parse �� import����bridge.js 7024 �У�
  check ȫ�̣�ð���� ReferenceError������ .bak-p5send���ۼ� -4622��
- ? ������ý��ܵ��أ�fetchOneBotImage/resolveMediaList/getImageDimensions/MAX ���������� core/media-pipe.js��
  Ȼ�� M11 handleIncoming/pumpMux����� M5 ����̨��
- ? P5-8���Զ��֣���ý��ܵ��� 6 ������getImageDimensions/fetchOneBotImage/fetchFaceMedia/
  resolveOneMedia/resolveMediaList/fetchMediaData��+ MAX_MEDIA_BYTES/PIXELS/STORE ���� �� src/core/
  media-pipe.js��cfg/bot ע�룩��bridge.js 6778 �С������� 7000��check ȫ�̣�ð���� ReferenceError��
  ���� .bak-p5media���ۼ� -4868��
- ? ������M11 handleIncoming/pumpMux ���� M5 ����̨��ʣ���飩��
- ? P5-9���Զ��֣����� clearSocialV2Timers/clearAllSocialV2Timers �� social-state.js���� M12 ��ʱ�����
  7 ����+״̬ �� src/core/scheduler.js��recordSentMessagesV2 �� setScheduledRecorder ע�룩��
  bridge.js 6629 �У�check ȫ�̣�ð���� ReferenceError������ .bak-p5sched���ۼ� -5017��
- ? ������M11 handleIncoming/pumpMux ����⣻��� M5 ����̨Ϊ���׶Ρ�
- ? P5-10���Զ��֣���Ŀ��С�أ���findCjkSpaceWarning/findSplitBoundaryWarning �� lib/social-timeline.js��
  currentRoleHintV2 �� core/social-v1.js��recordSentMessagesV2 �� core/social-v2-flow.js���� scheduler
  ע���ã���readFeedbackEntries/appendFeedbackEntry/readToolLog/appendToolLog �� core/audit.js��
  bridge.js 6470 �У�check ȫ�̣�ð���� ReferenceError������ .bak-p5small���ۼ� -5176��
- ? ������M11 handleIncoming/pumpMux �¼��㣨~1200 �У������ M5 ����̨Ϊ�����β�׶Ρ�
- ? P5-11���Զ��֣���expandIncomingForwardPreview���ϲ�ת���Զ�չ������ core/message-cache.js��
  findMessageMedia��v1/v2 ý����ݣ��� core/social-v2-flow.js��bridge.js 6397 �У�check ȫ�̣�
  ð���� ReferenceError������ .bak-p5fwd���ۼ� -5249��
- ? ������M11 handleIncoming �¼������� M5 ����̨��β��
- ? P6-1/P6-2�������ڼ���������ͷ�ɵ����ôأ�9 ��� src/core/tunables.js��setTunableCfg ע��ɱ�
  cfg����postRandomQzone �� src/core/qzone.js��initQzoneCore����writeStickerTmpFile �� sticker.js��
  bridge.js 6284 �У�check ȫ�̣�ð���� ReferenceError������ .bak-p6tun/-p6qz���ۼ� -5362��
- ? P6-3��ͬ�֣���recordDocxSentV2��social-v2-flow��sendHelpDocV2+HELP ������core/docx.js��
  bridge.js 6228 �У�check ȫ�̡����� .bak-p6help���ۼ� -5418��
- ? P6-4���¼������� 5 ������core/events-aux.js��APPROVE/REJECT_WORDS��lib/markers.js��
  bridge.js 6015 �У����� 6.1k����check ȫ�̡����� .bak-p6aux���ۼ� -5631��

## P6-5（2026-09-05 会话内）
- applyStickerNoteV2 / setStickerRemarkV2 / collectStickerV2 迁入 src/core/sticker.js（新增 crypto、fetchOneBotImage/fetchFaceMedia/getSocialV2State 导入，applyStickerNote 加进 sticker-lib 导入清单），bridge.js 删除同三函数 → 6228→5893 行。
- 修复：core/tunables.js TUNABLE_SPECS 曾被去 export 但 main 仍 import → 恢复 export const。
- 门禁：node --check ✓ npm run check ✓ import smoke ✓（NapCat/SnowLuma 离线属预期）。
- 备份 src/bridge.js.bak-p6stk2-20260905。
- 剩余体型：startConsoleServer(506–~4730) 与 handleIncoming(4732)+pumpMux 两个巨型互锁块，bridge.js 内仅剩 5 个本地函数；需按 helper 分层迁移，不可整块搬运。

## P7（2026-09-05 会话内，11,646 → 703 行收敛）
- P7-1：M11 事件层 handleIncoming(4732-5242)+pumpMux(5256-5782) → src/core/mux.js。闭包面=api/bot/cfg + QUEUE_HINT_COOLDOWN_MS/SILENT_TURN_TIMEOUT_MS（值复制进模块）。cfg 整词→cfgRef、api./bot.→apiRef./botRef.，initMuxCore(cfg)/setMuxApi/setMuxBot 注入；bridge 5893→4860。
- P7-2：M5 本地控制台 startConsoleServer(510-4519) + 顶层 loadOrCreateConsoleToken → src/core/console-server.js。闭包面=cfg/api/bot + sendRichV2/musicSearchV2(setConsoleMedia 注入，避免 createMediaDomain 二次实例化) + lastMode(经 writeLastMode sink 写回 main) + lastForcedAgentStickerSync(模块内聚)。bridge 4860→845。
- P7-3：refreshMode+checkDsh+startDshWatch → src/core/dsh-watch.js（dshCheckStarted/lastMode 模块内聚，initDshWatchCore 在 initModeCore 之后调用以取 currentMode 初值；sink 改为 setConsoleLastModeSink(writeLastMode)）。清理废弃局部 QUEUE_HINT_COOLDOWN_MS/SILENT_TURN_TIMEOUT_MS 声明。bridge 845→703，check-size 判定“已收敛到可维护规模”。
- 教训：复制顶层 import 块到 src/core/*.js 必须整条语句搬运（多行 import 续行不以 'import ' 开头会被过滤丢名）并按新目录重映射相对路径（./core/X→./X、./X→../X；曾误把 ./lib/X 写成 ../lib/lib/X）。
- 门禁：每批 node --check + npm run check + import smoke ✓；备份 .bak-p7mux/-p7con/-p7watch-20260905。
- 剩余：main() 内遗留大量迁移空注释壳（可选清理）；scripts/p6-*/p7-* 与 .bak-* 待最终确认后清理。

## P9 收尾（2026-09-05）
- 清理 main() 内迁移遗留空注释墙（模板字符串行受保护）：bridge.js 703→402 行，主流程为纯编排骨架（init 级联 → api 注入 → bot 接线 → 启动任务）。
- 最终清理：删除全部迁移脚本（p3-p9、mod-cleanup、migrate-message-parse、_fix-safefetch、scan-main、recon 等 58 个）与 src/bridge.js.bak-*（55 份）；git 仓库在位，历史可回溯。保留 check/test/patch 等仍被 package.json 引用的脚本。
- 终态：bridge.js 402 行；src/core 31 模块、src/lib 27 模块；npm run check ✓、import smoke ✓（NapCat 离线属预期）、check-size 判定收敛。
- 遗留：import 头含少量迁出后不再使用的具名绑定（无副作用影响）；真机冒烟（NapCat+DSH 在线）待用户自测。
