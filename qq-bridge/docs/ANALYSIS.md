# bridge.js 结构分析（2026-09-05 · 只读，子代理产出）

口径：全文件 12014 行。模块级 = 1–975；`async function main()` = 976–11995；尾钩 11997–12014。
main 内具名 function 237 个（2 空格缩进，扁平直属 main 作用域）+ 4 个 main 级 const 箭头
（enqueueForRetry@2264 / flushQueue@2330 / checkDsh@2389 / randInt@7583）。
函数声明在 main 内整体提升，文本位置 ≠ 调用时序 —— 外迁必须先声明后调用。

## 共享底座（闭包引用）
cfg@977、api@1920（DSH client）、bot@11913（SnowLuma 网关）、state@519、KNOWN_AGENT_TOKENS@156、sharp@26。

## 12 个候选域
- M1 表情/贴纸（1002–1195,1459–1644）11 函数
- M2 富媒体/音乐/文件/docx/Qzone（1196–1530）13
- M3 黑话学习引擎（1645–1964）13
- M4 DSH 会话/回合/看门狗/跨会话/模式/队列（1965–2502,7488–7632）29
- M5 控制台 HTTP server + tunable（2511–~6522,7828–7890）8 具名+大量匿名路由
- M6 出站发送链路与媒体解析（6523–7450）35
- M7 审计/敏感/回执/工具日志（7450–7488,9642–9725）10
- M8 唤醒/睡眠/回复检查（7633–8006,9764–10594）38
- M9 社交状态机与主动时间线（8006–8937）38
- M10 记忆/画像/聊天 SQLite + 群名片缓存（8965–9609）27
- M11 入站路由 + DSH 事件泵（10594–11910）8（handleIncoming@10644、pumpMux@11384）
- M12 定时任务（10237–10368）7

## 可外提纯函数
A 组（自含零闭包）：beijingDateKey@1350、isCjkChar@6711、splitByCjkSpaces@6724、isCjkLikeChar@8853、
convertExampleSpacesToComma@8867、isEmojiLikeCp@6545、stripImeEmoji@6553、singleLineForQQ@6661、
splitLongSegment@6670、mimeFromBuffer@6918、mimeFromUrl@6927、base64FromMaybe@6988、
isDuplicateSendText@7064、normalizeSpeakerIdsV2@7617、parseClockMin@7735、bjMinutes@7744、
bjMinToText@7748、isSleepingConfigV2@7942、normalizeLoopSignature@2024、randInt@7583、
clampGapV2@7348、computeGapsV2@7354。
B 组（连带常量外提）：beijingTs@9376(+BJ_WEEK@9375)、hasExplicitEndV2@7935(+EXPLICIT_END_RE@7933)、
redactSensitive@9709 / sanitizeToolArgs@9725(+SENSITIVE_ARG_KEYS@9708)、faceIdFromArtifactContent@6607 /
resolveArtifactFaceId@6617(+ARTIFACT_TOKEN_RE@6582,需复核)、isSafeLocalMediaPath@7079、
isProbablySafeImageFileRef@7093、normalizeTriggerBool@3780(先拆 M5)、
compressImageBuffer@7013 / finalizeImageBuffer@7054(+sharp,需注入)。
C 组（勿外提）：readCfgPath/writeCfgPath、currentRoleHint、docxQuotaReserve/Commit、socialState/getSocialV2State、
recordAiTurnOutbound/finishTurnLoopGuard 及全部主干（sendToQQ/handleIncoming/pumpMux/socialLoopTick/...）。

## 模块级 lib 划分（1–975）
1. src/lib/paths.js：56–69,536 路径常量 —— 近零风险
2. src/lib/json-fs.js：73–100 readJsonSafe/atomicWriteJson/atomicWriteText —— 近零
3. src/lib/message-parse.js：616–951 段解析/文件读取 —— 近零~低（852–853 import 需人工复核）
4. src/lib/text-safe.js：137–214 常量+脱敏/转义 —— 中风险：KNOWN_AGENT_TOKENS 可变集被 main 6 处增删
5. src/lib/config.js：233–520 normalize*/loadConfig/loadState/saveState —— 中风险：state 单例
6. src/lib/role-access.js：101–138,214–255 token/tail/roles/role-state —— 低风险
补充：log@594 依赖 text-safe（redactSensitiveText@160），需先搬 text-safe 或注入脱敏器。
APPROVE_WORDS/REJECT_WORDS@972–973 建议随 M11 或独立常量搬。ALARM_RE@21 属配置消费侧。

## 外提统一风险点
1) 同闭包兄弟函数调用链必须整组外提（randInt/clampGapV2/computeGapsV2、isCjkChar/splitByCjkSpaces）
2) main 常量读取（BJ_WEEK/EXPLICIT_END_RE/SENSITIVE_ARG_KEYS/ARTIFACT_TOKEN_RE/MAX_MEDIA_*@7002–7012）
3) 调用点位于 M5 单函数体内（4047/4162/3780）→ 先拆控制台
4) KNOWN_AGENT_TOKENS 增删点：3538/6428/6474/8043/8110/10768

## 执行顺序建议
P1 text-safe + paths + json-fs（低风险、可单测）→ P2 message-parse → P3 A 组纯函数并入 lib
→ P4 M6 发送链路（M5 依赖其间隙）→ P5 M8/M9 → P6 M4/M11 → P7 M5 控制台最后拆。

## 迁移进度（2026-09-05 更新）
- ✅ P1：text-safe（脱敏器注入方案）、paths、json-fs 已外提至 src/lib/，tests/lib|paths.test.js 通过。
- ✅ P2：message-parse 迁移完成 → `src/lib/message-parse.js`（segmentsToText/parseJsonCardText/
  extractMediaFromSegments/extractFilesFromSegments/execFileBuffer/decodeTextBuffer/extractDocxText/
  parseFileBuffer/fetchFileBytes/readFileContent，10 导出）。bridge.js 已改引 lib 并删除残留的
  `safeFetchFileBuffer`/`md-to-plain` 假导入；`node --check`、`npm run check` 全绿，bridge 模块级导入冒烟通过。
  备份：`src/bridge.js.bak-p2-20260905`。
- ⏭ P3（下一轮）：A 组纯函数并入 lib（randInt/clampGapV2/computeGapsV2、isCjkChar/splitByCjkSpaces、
  beijingTs/BJ_WEEK、hasExplicitEndV2 等，见上文分组），每批备份 + node --check 门禁。
- ✅ P3 第一批~第三批（2026-09-05 晚）：randInt → lib/rand.js；bjMinutes/bjMinToText/beijingTs/BJ_WEEK
  → lib/time.js（替换旧"数值版 beijingTs"，其运行时无消费方；负数 min 不归一化为迁移源行为）；
  isCjkChar/splitByCjkSpaces → lib/cjk-split.js（新文件，勿与 lib/cjk.js 的宽语义 isCjkChar 混用）；
  clampGapV2/computeGapsV2 → lib/send-gaps.js（computeGapsV2 内部引 randInt）；normalizeLoopSignature
  → lib/loop-guard.js。bridge.js 内 9 个嵌套定义全部删除、改顶层 import（已 grep 确认零残留定义），
  bridge.js 降至 11,548 行；tests/lib.test.js 补齐对应断言，npm run check 全绿。备份沿用
  src/bridge.js.bak-p3-20260905。
- ⏭ P3 剩余：hasExplicitEndV2(+EXPLICIT_END_RE)、isSleepingConfigV2、faceIdFromArtifactContent/
  resolveArtifactFaceId(+ARTIFACT_TOKEN_RE)、isSafeLocalMediaPath/isProbablySafeImageFileRef、
  redactSensitive/sanitizeToolArgs(+SENSITIVE_ARG_KEYS)、compressImageBuffer/finalizeImageBuffer(sharp 注入待定)。
- ✅ P3 第五批（2026-09-05）：faceIdFromArtifactContent/resolveArtifactFaceId → lib/qq-face-parse.js
  （resolveArtifactFaceId 依赖 qq-faces.resolveFaceRef，lib 自行 import ../qq-faces.js）；
  compressImageBuffer/finalizeImageBuffer + IMAGE_* 四常量 → lib/image-compress.js（sharp 加载器随迁，
  bridge.js 顶层 sharp loader 与 createRequire import 已删除）；isProbablySafeImageFileRef →
  lib/media-guard.js；isSafeLocalMediaPath 因依赖运行态 cfg.napcat.homeDir，改为参数注入版
  (filePath, homeDir) 迁入 media-guard.js，唯一调用点已改传 cfg.napcat?.homeDir。
  bridge.js 降至 11,440 行；tests 补齐（face 数字路径/空、image 小图降级原样返回、media-guard 拒绝清单、
  isSafeLocalMediaPath 真/假例），npm run check 全绿。备份沿用 src/bridge.js.bak-p3-20260905。
- ⏭ P3 剩余（更新后）：hasExplicitEndV2(+EXPLICIT_END_RE)、isSleepingConfigV2、redactSensitive/
  sanitizeToolArgs(+SENSITIVE_ARG_KEYS)，以及按需复核的 ARTIFACT 域（sweepMessageArtifacts 等属 M 域留待
  域抽取阶段）。
- ✅ P3 第六批（收尾，2026-09-05）：KNOWN_AGENT_TOKENS/redactSensitiveText(模块级)+SENSITIVE_ARG_KEYS/
  redactSensitive/sanitizeToolArgs → lib/text-safe.js（KNOWN_AGENT_TOKENS 为跨模块共享可变集，靠 ESM
  活绑定与 main 内 add/delete 保持同一实例）；EXPLICIT_END_RE/hasExplicitEndV2/isSleepingConfigV2 →
  lib/sleep-guard.js。bridge.js 降至 11,372 行；grep 确认 A/B 组全部目标零残留定义（仅 ARTIFACT_TOKEN_RE
  归 sweepMessageArtifacts 正确留在 main）。npm run check 全绿。备份沿用 src/bridge.js.bak-p3-20260905。
- ✅ P3 完结：A/B 组纯函数并入 lib 全部完成（randInt、bjMinutes/bjMinToText/beijingTs/BJ_WEEK、
  isCjkChar/splitByCjkSpaces、clampGapV2/computeGapsV2、normalizeLoopSignature、faceIdFromArtifactContent/
  resolveArtifactFaceId、compressImageBuffer/finalizeImageBuffer、isSafeLocalMediaPath(参数注入)/
  isProbablySafeImageFileRef、redact 簇、sleep-guard 簇；normalizeTriggerBool 属 M5 依 ANALYSIS 跳过）。
- ⏭ P4（下一阶段，域抽取起点）：M6 发送链路外提（M5 依赖其间隙），先做 main 闭包共享状态收进
  core/ctx.js 的设计（REFACTOR.md P2 ctx 化）再逐域搬 napcat/engine/memory/tools；模块级剩余
  （escapeCqText/unquoteJsonString/log/config/role-access 等）按 ANALYSIS"模块级 lib 划分"继续。
- ✅ P3 补第七批（2026-09-05，修正上文"完结"为涵盖 A 组清单全部项）：isEmojiLikeCp/stripImeEmoji →
  lib/emoji.js；mimeFromBuffer/mimeFromUrl/base64FromMaybe → lib/media-meta.js；singleLineForQQ →
  lib/segment.js（splitLongSegment 待下一批）；parseClockMin/beijingDateKey → lib/time.js；
  isDuplicateSendText → lib/loop-guard.js。用 scripts/p3-batch7.mjs（函数锚定+括号配平+上方注释
  连带删除，先备份）行级删除 8 目标（98 行），bridge.js 11277 行，npm run check 全绿。
  备份 src/bridge.js.bak-p3b7-20260905。
- ⏭ P3 补第八批（待办）：splitLongSegment、isCjkLikeChar/convertExampleSpacesToComma、
  normalizeSpeakerIdsV2（体需先读后移，均纯函数）。
- ✅ P3 补第八批（完结，2026-09-05）：splitLongSegment → lib/segment.js；isCjkLikeChar/
  convertExampleSpacesToComma（相邻区间自动合并删除）→ lib/cjk-split.js；normalizeSpeakerIdsV2 →
  lib/sleep-guard.js。scripts/p3-batch8.mjs（修掉校验双重递减 bug）删除 98 行，bridge.js 11179 行，
  npm run check 全绿；备份 src/bridge.js.bak-p3b8-20260905。
- ✅ P3 全部完结：ANALYSIS A/B 组清单逐项核对——34 个纯函数 + 8 常量全部外提 lib（grep 零残留定义）；
  唯一保留 ARTIFACT_TOKEN_RE 归 sweepMessageArtifacts（M 域代码），normalizeTriggerBool 依
  "先拆 M5" 原则留待 P7。迁移期间备份：.bak-p2/-p3/-p3b7/-p3b8。
- ⏭ 剩余阶段（估计）：① 模块级 lib 剩余（escapeCqText/unquoteJsonString/log/config/role-access 等，
  ANALYSIS"模块级 lib 划分" items 5-6）→ ② P4 ctx 化 + M6 发送链路 → ③ P5 M8/M9 → ④ P6 M4/M11 →
  ⑤ P7 M5 控制台 + normalizeTriggerBool → ⑥ 收尾（真实冒烟/备份清理/README/门槛达标）。
- ✅ 阶段①（模块级 lib 清理）进行中（2026-09-05）：①a escapeCqText/unquoteJsonString →
  lib/text-safe.js；①b normalizeOwnerQQ/normalizeIdList → lib/config.js（新），readRoleState/
  writeRoleState/sanitizeRoleName → lib/role-access.js（新）；①c log/appendActivity/readActivityTail
  → lib/log.js（新），SILENT_MARKER/isSilentMarker + SEND_TOOL_RE/isSendToolName → lib/markers.js（新）。
  脚本 mod-cleanup-1/2.mjs（函数锚定 + const+fn 显式区间），bridge.js 11071 行，npm run check 全绿；
  备份 .bak-mod1/-mod2。
- ⏭ 阶段① 剩余：loadConfig/loadState/saveState + state 单例（中风险，建议并入 P4 ctx 化收编）、
  allowed/canonicalV2Key/withTimeout/sleep/convKey 等通用小工具（拟 lib/runtime.js 或并入 ctx）、
  listRoles/loadOrCreateConsoleToken（M5 控制台域，随 P7）、ALARM_RE/APPROVE_WORDS/REJECT_WORDS/
  SPACE_SPLIT_HINT/DIRECTION_HINT（提示与审批词，随 M11/M5 或独立常量搬）。
- ✅ 阶段①（模块级 lib 清理）完结（2026-09-05）：①d sleep/withTimeout → lib/async.js（新），
  convKey/canonicalV2Key → lib/keys.js（新），allowed → lib/config.js（访问控制，cfg 注入），
  listRoles → lib/role-access.js。bridge.js 11036 行（自 11646 累计 -610），npm run check 全绿，
  备份 .bak-mod3。剩余模块级项已映射到后阶段：loadConfig/state 单例/acquireLock/releaseLock →
  P4 ctx 化与入口收编；loadOrCreateConsoleToken + SEND_TIMEOUT_MS + ALARM_RE + 审批词 + 提示常量 →
  P7 M5/M11 抽取。
- ⏭ 下一阶段（P4，域抽取起点）：设计 core/ctx.js 收拢 main 闭包共享状态（cfg/state/api/bot/各 Map/
  定时器），先从低耦合域试点（M1 表情/贴纸或 M6 发送链路的纯发送骨架），逐域搬移，每域备份 + 门禁。
