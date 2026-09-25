# 能力清单

本文按能力分组列出机器人**能做什么**，每一项给出六个固定视角：

**能力名 → 触发条件 / 入口 → 实现模块与关键函数（相对路径 + 函数名）→ 数据结构与关键常量（数值原样抄录）→ 算法 / 流程要点 → 失败与降级路径 → 可观测证据（日志行 / 落盘文件 / 接口 / 字段）。**

## 取证口径

- 基准仓库：`MoonBot Public`，模块路径相对仓库根。桥接代码在 `qq-bridge/src/`，管理端在 `server/` 与 `src/`。
- **一切以当前工作区代码为准**。本文中所有函数签名、常量数值、SQL DDL、JSON 字段均从源文件逐字抄录；行号为取证时刻的读取器行号，重构后会平移，**相对路径与函数名是稳定锚点**。
- 代码与既有文档冲突时保留代码结论，并在正文中列出冲突点（见 §19）。
- 标 **未验证** / **推断** 的条目是没有读到实现或只有间接证据的部分，不对其内部行为下断言。
- 本文只描述本仓库现状，不含安装包（`D:\MoonBot\resources\runtime\*`）的差异比对。

---
## 0. 总表

下表是全文的索引。**模块**列给出相对路径与关键函数，**关键常量 / 落盘**列只抄数值与文件名，**失败与降级**列写"坏了会怎样"。展开见对应章节。

| 能力 | 触发条件 / 入口 | 模块与关键函数 | 关键常量 / 落盘 | 失败与降级 |
| --- | --- | --- | --- | --- |
| 会话读取与协议 | 收到 OneBot 事件 | `qq-bridge/src/core/mux.js` `handleIncoming`；`core/session-state.js`；`core/social-state.js` | 键 `group:<群号>` / `private:<QQ号>`；`state/social-state.json` | 白名单 / 静默 / 去重任一命中即结束，不唤醒 |
| 入站去重 | 每条入站消息 | `core/mux.js` | `INBOUND_DEDUP_TTL_MS = 10 * 60 * 1000`、`INBOUND_DEDUP_MAX = 800` | 窗口内重复直接丢弃 |
| 聊天记录落库与检索 | 每条消息 / `qq_memory_search` | `core/chat-db.js` `persistChatMessage`、`searchChatMessages`；`core/social-flow.js` `appendSocialMessage` | `state/chat.db`（现场 18,104 行，FTS5 trigram） | 库不可用 → 读回 `{ok:false}`、写路径静默；FTS 不可用退 `content LIKE ?` |
| 读取类工具（9 个） | 模型调用 | `qq-bridge/src/mcp-napcat-safe.js:1025-1549` | `qq_get_prompt` 返回值受 `dshCompaction.toolResultMaxChars = 8192` 约束 | 未读故意不恢复，靠 `lastAiSeenAt` 水位补回 |
| 读取接口权限三件套 | 每个读取端点 | `core/console-server.js` `trustLevelForToken` | `TRUST_SPOKE_WINDOW_MS = 600000` | 空令牌 403、非 JSON 415、跨 Origin 403 |
| 发送主链 | `onebotSend` | `core/qq-send.js`；`core/send-chain.js` `enqueueSend`；`core/send-idempotency.js` | `SEND_TIMEOUT_MS = 15000`；重试前 `sleep(2500)`；`REPLAY_WINDOW_MS = 180000`、`DELIVERED_KEEP = 50` | 连接类 / `1006514` / 路径不存在（自愈 base64）/ `Get Uid Error`（弃 @ 重发）；未确认送达既不当成功也不当失败 |
| 发送节拍 | `social.send` | `qq-bridge/src/lib/send-gaps.js` `LINEAR_DEFAULTS`；`core/config.js` `clampSendPace` | `linearPerCharMs 150`、`linearCapMs 4000`、`linearResetMs 60000`、`MIN_GAP_MS 100` | 超区间自动钳制并打 `[config] 打字节拍钳制：…` |
| 正文切分与出站格式治理 | 文本超长 / 参数是数组 | `core/qq-send.js` `splitForQQ`；`lib/text-safe.js` `splitSerializedBubbles` | `splitForQQ(text, max = 4000)` | 切不出多条 → 400 硬失败，一条都不发 |
| 敏感内容拦截 | 出站正文与参数 | `core/console-server.js:1191/2137/2488/5180`、`core/qq-send.js:197-201`、`core/mux.js:1248` | `src/sensitive.js` `SENSITIVE_RE`、`SECRET_PATH_RE`、`CRED_RE`；`SENSITIVE_ARG_KEYS` 21 个键 | 403 / throw / 文本替换三种，**不静默放行** |
| 富文本卡片 | `qq_send_rich` | `core/console-server.js:3157-3353`；`core/media.js` `buildMusicCard`；`core/video.js` `buildVideoCard` | 类型枚举 `music/video/contact/location/dice/rps` + `json`/`xml`；`RICH_DEDUPE_MS = 60000` | `primary → native → link` 三档；`style==='share'` 落链接不算降级 |
| 文档发送 | `qq_send_docx` | `core/docx.js` `sendDocx`、`docxQuotaReserve` | `MAX_DOCX_CHARS = 1000000`；日额度 `100000`；`state/docx-quota.json` | 超额直接拒且不占用额度 |
| 视频链接解析 | `qq_video_parse`、`qq_video_search` | `core/video.js` `resolveVideo`、`fetchMiniAppArk` | bilibili 四路降级；`PROBE_TIMEOUT_MS = 9000`、`SHARE_CODE_TTL_MS = 10 * 60 * 1000` | 抖音 / 通用平台 → `err.degraded = true`；Ark 缺 title 或 jumpUrl → 分享链接 |
| 收藏表情 | `qq_send_sticker`、`qq_collect_sticker` | `core/sticker.js` `sendSticker2`、`collectSticker2`；`src/sticker-lib.js` | `state/stickers.json`；同步 TTL `60000`、列表上限 `500` | 发送失败含 `识别URL失败/ENOENT` → base64 重发一次；`add_custom_face` 不支持 → 本地图库 `local://` |
| 内置表情包 | `qq_meme_search`、`qq_send_meme` | `mcp-napcat-safe.js:2067/2117`、`orderedMemePacks` | `index.db` 的 `memes(path,tag,file_name,caption,keywords,…)`；`MEME_RESCAN_MS = 5000` | 没装包 → 工具打明确提示 + 启动 stderr 列路径 |
| QQ 内置表情 | `qq_face_list`、`qq_send_qq_face` | `core/sticker.js` `sendQqFace2` | face id/名称由 `qq_face_list` 提供 | 未知 face 由 NapCat 侧报错回传 |
| 表情发布掷骰 | 桥主动行为 | `core/send-dice.js` `dice(kind)` | `MEME_DEFAULT_PROBABILITY = 0.3`、`MEME_DEFAULT_COOLDOWN_MS = 3 * 60 * 1000` | 配置缺失用默认值 |
| 收图进模型 | 消息带图 / 表情 | `core/media-pipe.js` `fetchOneBotImage`、`resolveMediaList` | `MAX_MEDIA_BYTES = 25 * 1024 * 1024`、`MAX_MEDIA_PIXELS = 64_000_000`、`MAX_MEDIA_STORE_PER_KEY = 500` | 超限 → 文字占位 `MEDIA_PLACEHOLDER_HINT`，不发附件 |
| 下载与 SSRF 防护 | 所有外部 URL | `qq-bridge/src/safe-fetch.js` `validateFetchUrl`、`safeFetchBuffer` | `MAX_IMAGE_FETCH_BYTES = 15 * 1024 * 1024`、`MAX_REDIRECTS = 5`、DNS 超时 5000 | 内网/非图/字节不完整一律抛错，调用方换下一个候选 |
| 图片压缩与转码 | 外发 / 转发 | `qq-bridge/src/lib/image-compress.js` `compressImageBuffer`、`finalizeImageBuffer` | `IMAGE_MAX_SIDE = 1280`、`IMAGE_HARD_MAX_SIDE = 4096`、`IMAGE_JPEG_QUALITY = 82` | 硬上限不可达 → 判"不可投递"，走占位文案 |
| 外发图统一入口 | 所有发图工具 | `qq-bridge/src/lib/napcat-file.js` `napcatImageFileArg` | 模式 `path/base64/auto`（默认 `path`）；`DEFAULT_BASE64_MAX_BYTES = 10 * 1024 * 1024` | 超 base64 上限回落宿主路径并记日志 |
| 联网找图 | `qq_image_search` | `lib/image-search.js` `searchImages` | 必应 + 百度；超时 `9000`；limit ≤ 20 | 两源失败各自写 `failures` 字段如实回报 |
| Pixiv | `qq_pixiv_search`、`qq_send_pixiv` | `qq-bridge/src/lib/pixiv.js` | 三源优先 app-api → web-ajax → mirror；`PIXIV_SCAN_PAGES_DEFAULT = 3`、`PIXIV_SCAN_PAGES_MAX = 10` | R-18 **fail-closed**（`xRestrict !== 0` 即成人）；档位降级必须显式记 `tierFallback` |
| 语音合成 | `qq_send_voice` | `core/voice.js` | 模型 `mimo-v2.5-tts` 系列；`MAX_TTS_CHARS = 2000`；默认音色「冰糖」 | 额度/开关/模型任一不可用 → 降级为文字（见 §6.5） |
| 语音识别 | `qq_transcribe_voice` | `core/voice.js` | `mimo-v2.5-asr`；`MAX_ASR_BYTES = 7 * 1024 * 1024` | 超限或失败 → 回话术，不吞消息 |
| 独立识图 | 自动分流 | `core/vision.js` `describeImageWithVisionModel` | `VISION_TIMEOUT_MS = 45000`、`VISION_MAX_RESPONSE_BYTES = 64 * 1024` | 超时/非 2xx/无文字 → 退回附件 |
| 记忆：内存窗口 | 每轮唤醒 | `core/social-state.js` | `social.context.recentLimit = 100`，持久化 `slice(-200)` | 重启后窗口只恢复 200 条，未读不恢复 |
| 记忆：条目库 | `qq_memory_remember` 等 | `core/memory.js` | `state/memory.db`：`profiles` / `memory_entries` / `mem_fts*` | 库不可用 → 记忆功能整体降级 |
| 群画像 / 群缓存 | 入站累积 | `core/group-cache.js` | TTL 见模块常量 | 缓存过期重新拉取 |
| 黑话学习 | `/slang`、`POST /api/learning/slang` | `core/slang.js`、`src/slang-learner.js` | `state/slang.json`；`NIGHTLY_TICK_MS = 60000`、`MAX_LEARN_MSGS = 2400`、`MAX_BLOCK_MSGS = 800` | 失败清 `lastFiredNightlyDate` 允许当天补跑，5 分钟节流重试 |
| 人格学习 | `/persona`、`POST /api/learning/persona` | `core/persona-learn.js`、`core/persona-text.js` | `state/persona-library.json`、`persona.md`；`PROFILE_MAX = 4000`、`PERSONA_TURN_TIMEOUT_MS = 300000` | 会话真失效才重建（超时不算）；整批失败不推进水位改 30 分钟退避 |
| 群友画像 | `/portrait`、定时 | `core/portrait-learn.js` | `minMessages 10`、`maxTargets 20`、`windowHours 720` | 自动路径 30 分钟退避；**当前取人 SQL 失效，见 §19.2** |
| 学习令牌 | 学习会话调 `qq_learning_submit` | `core/learning-token.js` | `state/learning-token`（32 hex，`0o600`） | 落盘失败仍返回；无效令牌 403 |
| QQ 空间 | `qq_send_qzone`、`qq_qzone_*` | `lib/qzone-image.js` `collectQzoneImages` | `QZONE_IMAGE_MAX = 3`；≤10 MB 走 `base64://` 零落盘 | 配图全失败 → 纯文字说说 + `notes`/`tried` |
| 主动发说说 | 主动路径 | `core/qzone.js` `postRandomQzone` | 内置 10 条池；写 `memory_entries(category='qzone_post')` | 失败只记日志，不影响主链 |
| 群 / 好友 / 权限 | `qq_blacklist`、`qq_whitelist`、`qq_admin_set`、`qq_remove_friend` | `mcp-napcat-safe.js:2342-2399` | — | 非主人调用被工具层拒 |
| 角色库 | `qq_character_*` | `mcp-napcat-safe.js:4601-4665` | `state/current-role.json` | 角色包缺失 → 工具报错不切换 |
| 定时任务 | `qq_schedule_message` | `core/scheduler.js` | `state/scheduled-tasks.json` | 到点发送失败按重试矩阵处理 |
| 跨会话留言 | `qq_crosschat_send` | `core/crosschat.js` | `state/crosschat.json`；`social.trustedCrossSessionUids` | 未受信任会话拒收 |
| 活跃时段 / 深层静默 | `qq_set_activity_hours`、`qq_deepsleep` | `core/activity.js`、`core/social-flow.js` | `state/activity-windows.json` | 命中静默只写 `state/qq-activity.log` |
| 宿主机工具 | `napcat_status` / `start_napcat` / `stop_napcat` | `qq-bridge/src/mcp-host-server.js` | 注册条件 `allowProcessControl === true` | `bridgeModeAllowsProcessControl()` **恒为 false**，进程控制实际不可用（见 §19.4） |
| 桥启动装配 | 进程启动 | `qq-bridge/src/bridge.js:270-816` | 锁 `state/bridge.lock`；`connectNapcat` 预算默认 `120000` | 双实例 `process.exit(2)` |
| 投递与入队缓存 | DSH 未就绪 / 投递失败 | `core/prompt-deliver.js` `enqueueForRetry`、`flushQueue` | `QUEUE_MAX = 50`；重试退避 `min(3000 * 2^(n-1), 60000)` | 丢最旧并记日志；超时隔离会话并自动恢复 |
| DSH 侧会话 | 每个 QQ 会话 | `core/dsh-session.js` `ensureSession`、`core/session-archive.js` `archiveIdleSessions` | `state/sessions.json` 形如 `{"sessions":{"<key>":"<sessionId>"}}`；归档默认 `intervalMs 600000` / `idleMinutes 30` / `batchMax 20` | 会话卡死 → 30 s 超时隔离重建；归档只打隐藏标记不删数据（§13.5–13.7） |
| agent preset 与工具限制 | 安装隔离 DSH 时 | `qq-bridge/dsh/agent-presets/qq-chat/qq-tool-restrict.mjs`、`lib/dsh-side.js` | 白名单 `mcp__napcat__` / `mcp__napcat-host__` / `mcp__web-search-safe__` 三个前缀 + `ask_user_question` / `todo_write` | 非白名单工具一律拒；`dsh-tool-ask-user` 与 `dsh-tool-todo` 从源头卸载（§13.8） |
| 联网搜索 | `mcp__web-search-safe__*` | `qq-bridge/src/mcp-web-search-safe.js` | — | 未逐行核实（见 §19.3） |
| 用量与成本 | 每轮 | `core/token-meter.js`、`core/token-report.js` | `state/token-usage.jsonl`；`MAX_LINES 50000`、`PRUNE_TO_LINES 45000` | 对账文件 `state/token-reconcile.json`，两个口径分开报 |
| 审计与工具流水 | 每次工具调用 | `core/audit.js` | `state/tool-calls.jsonl`；`state/context-savings.json` | 写盘失败只记日志 |
| 工具裁剪与描述压缩 | `social.slimTools` / `schemaLevel` | `qq-bridge/src/lib/tool-tiers.js`、`tool-schema-compress.js` | `state/tool-schema-stats.json`（实测 `share 0.9214`、`available 91`） | 档位无法匹配时回退全量描述 |
| 管理端功能面 | Web GUI / `server/index.js` REST | `server/index.js`（10,122 行）、`src/pages/*.tsx`、`src/api.ts` | 配置与日志在 `~/.qq-bridge-manager/` | 桥离线时部分端点直读本机文件（§17） |
| 部署与开机自动连接 | 安装包 / 启动 | `server/deploy.js`、`server/connect-machine.js` | 见 §18.4 | 未逐行核实（见 §19.3） |
| 退出守卫 | 后端退出 / 应用关闭 | `server/napcat-guardian.mjs` | `~/.qq-bridge-manager/napcat-guardian.json`；宽限 `30000`、复查每 `2000 ms` | 二次核对 guard 文件；已归新后端则静默退出 |
| NapCat 完整性自修 | 拉起 NapCat 之前 | `server/napcat-repair.js` `ensureNapcatApps` | `NapCat.Shell.zip` + 同目录 `7z.exe` | 补不回来则 `{ok:false}` 并在界面报"仍有问题" |

---

## 1. 会话读取与协议

会话在桥内是一等对象，键名为 `group:<群号>` 或 `private:<QQ号>`，由 `^(group|private):(\d+)$` 解析（`qq-bridge/src/core/mode.js:41-43`、`qq-bridge/src/core/console-server.js:4657`）。所有会话级状态都在同一个内存 + 落盘结构里：内存态见 `qq-bridge/src/core/session-state.js`（`collectors` / `TurnStartAt` / `pendingWakeKeys` / `promptQueues` / `reverse` 等 24 个 Map/Set，纯内存），持久态见 `qq-bridge/src/core/social-state.js` 的 `social-state.json`（`conversations[key]`，字段全集见 `qq-bridge/src/core/social-state.js:342-400`）。

### 1.1 入站主链

入口是 `handleIncoming`（`qq-bridge/src/core/mux.js:299`），由 `OneBotWsClient` 的事件回调驱动（订阅点 `qq-bridge/src/bridge.js:581/585/589/595/622`）。

| 序 | 阶段 | 关键函数 / 常量 | 行为 |
| --- | --- | --- | --- |
| 1 | 白名单 | `allowed(kind, id, cfg)`（`qq-bridge/src/lib/config.js`） | `deny` 优先于 `allow`；两边名单都空且 `allowAllWhenEmpty` 为真时放行并打警告 |
| 2 | 正文抽取 | `textContent` / `plainContent` | 抽取纯文本用于唤醒判定与去重；`[CQ:` 段与转发段不进入语料 |
| 3 | 好友守卫 | `ALARM_RE`（`qq-bridge/src/lib/markers.js`） | 非主人/非受信任者的违法或营销内容 → 删好友 + 拉黑 + 私聊告知主人，开关 `social.autoFriendGuard` |
| 4 | 媒体落库 | `messageMediaStore`（`qq-bridge/src/core/session-state.js:80`） | 图片/文件/语音进内存媒体表，供本轮唤醒附图 |
| 5 | 去重 | `INBOUND_DEDUP_TTL_MS = 10 * 60 * 1000`、`INBOUND_DEDUP_MAX = 800`（`qq-bridge/src/core/mux.js`） | 同一条 QQ 消息在此窗口内只处理一次 |
| 6 | 挂起应答 | `handlePendingAnswer`（`qq-bridge/src/core/events-aux.js:44`） | 上一轮问过问题且登记了 `pending` 时，本条视为回答；超时按 `cfgRef.questionTimeoutMs` 回 `⏰ 等待回答超时，已取消该请求` |
| 7 | 静默闸门 | `deepsleep` 状态 | 命中则只写 `state/qq-activity.log` 一行 `[deepsleep] 群聊消息已静默跳过：…` 并结束 |
| 8 | 斜杠命令 | `mux.js` 命令分支 | 见 §12「斜杠命令」 |
| 9 | 唤醒调度 | `evaluateWakeTrigger` → `scheduleWake`（`qq-bridge/src/core/mux.js:720-760`） | `!st.bootstrapSent` 走 `bootstrap`，否则用判定出的 reason；见 §4 |

写入路径：`appendSocialMessage`（`qq-bridge/src/core/social-flow.js:14`）同时做两件事——更新内存窗口 `st.recentMessages`（`social.context.recentLimit` 默认 100，持久化时 `slice(-200)`）与落库 `persistChatMessage`（`qq-bridge/src/core/chat-db.js:619`）。**内存窗口与聊天记录库是两套存储，不要混用**（§7 有对照表）。

### 1.2 读取类工具

| 工具 | 注册行 | 做什么 | 数据源 | 生产上的坑 |
| --- | --- | --- | --- | --- |
| `qq_get_prompt` | `mcp-napcat-safe.js:1025` | 读整段唤醒协议、会话状态、角色卡、贴纸清单 | `social-state.json` + 角色库 | 返回动辄好几 KB。`dshCompaction.toolResultMaxChars` 曾经是 1500，把它剪成"开头 900 + 标记 + 结尾 300"，模型只看到零头，越用越像"不知道工具怎么叫、不知道规矩"。现值 8192（`qq-bridge/src/core/config.js:58-65`） |
| `qq_get_unread_messages` | `mcp-napcat-safe.js:1039` | 取未读 | `st.unread` | 唤醒正文没带未读时的兜底 |
| `qq_get_recent_messages` | `mcp-napcat-safe.js:1053` | 取最近消息 | `st.recentMessages` | 引用/回复要用的 `messageId` / `seq` 从这里拿。`limit` 默认 20、上限 100（`console-server.js:1693`）；`offset` **只在窗口内**挪（`memStart = mem.length - offset - limit`，`console-server.js:1703-1705`），越界得空。重启后窗口靠 `recentMessages.slice(-200)` 恢复，**未读故意不恢复**（`social-state.js:613`），改由 `fetchUnreadChatMessages` 按 `lastAiSeenAt` 水位补回 |
| `qq_social_state` | `mcp-napcat-safe.js:1073` | 看自己 / 对方的状态 | `wakeConfig` + `social-state.json` | |
| `qq_global_overview` | `mcp-napcat-safe.js:1087` | 全局总览 | 汇总 | |
| `qq_get_message_detail` | `mcp-napcat-safe.js:1507` | 单条消息详情（含 `userId`） | 窗口 + `chat.db` | 撤回、拍一拍、收藏表情都要先拿它的 id |
| `qq_get_my_recent_messages` | `mcp-napcat-safe.js:1489` | 自己发过什么 | `direction='out'` | `qq_withdraw_message` 的 id 来源之一 |
| `qq_mark_read` | `mcp-napcat-safe.js:1249` | 标读（读了不回时用，避免重复未读提示） | `POST /api/social/mark-read` | 防吞兜底：有展示水位（`turnSeenUnread` 快照 `snapMax`）时保留 `seq > snapMax` 的未读；**无水位时按 `_steerDeferredSeqs` 保留"被推迟交付"的未读**（`qq-bridge/src/core/console-server.js:1759-1779`），日志 `[default] mark_read 保留回合中新到未读 …（等待补发唤醒，避免吞消息）`。收尾强制 `infinite = true`（`console-server.js:1785-1790`）。响应体只回 `{ ok, key, markedCount, wakeGuaranteed }` |

### 1.3 读取类接口的权限三件套

所有读取端点都过同样的三道闸：会话令牌（`x-agent-token`）、`SessionAllowed(key)`、`ToolEnabled(name)`。

- 授权判定 `trustLevelForToken`（`qq-bridge/src/core/console-server.js:269`），窗口 `TRUST_SPOKE_WINDOW_MS = 600000`（10 分钟）。
- 空 `x-agent-token` 直接 403；非 JSON 体 415；跨 Origin 403（`console-server.js:690-762`）。
- `social.paused` 与 `cfgRef.social.enabled === false` 会整体封掉 `/api/social|send|images` 三组端点（仅对 agent 令牌）。

### 1.4 失败与降级

| 失败点 | 降级 | 证据 |
| --- | --- | --- |
| 聊天记录库不可用 | 读接口回 `{ok:false,error:'聊天记录库不可用'}`，写路径静默 return | `[chat-db] 初始化失败（聊天记录将不可用，但不影响其它功能）: …`（`chat-db.js:142`） |
| FTS5 不可用 | `ftsUsable()` 为假时退回 `content LIKE ?` | `[chat-db] chat_fts 全文索引不可用…`（`chat-db.js:155`）；响应体不再带 `ranked` 字段 |
| 会话映射与磁盘不一致 | 启动时剔除磁盘上不存在的 sessionId 并自愈 | `bridge.js:490-512` |
| 双实例启动 | 锁冲突直接退出 | `[bridge] 已有实例在运行（PID …，锁文件 …）。若确认其已死，删除该文件后重试。` + `process.exit(2)`（`qq-bridge/src/core/runtime.js:37-53`） |

---

## 2. 发送与收尾

**唯一出口**是 `onebotSend`（`qq-bridge/src/core/qq-send.js`）。发送链在 `enqueueSend`（`qq-bridge/src/core/send-chain.js`），幂等在 `qq-bridge/src/core/send-idempotency.js`，节拍在 `qq-bridge/src/lib/send-gaps.js`。

### 2.1 发送类工具

| 工具 | 注册行 | 做什么 | 生产上的坑 |
| --- | --- | --- | --- |
| `qq_send_message` | `mcp-napcat-safe.js:1314` | 发文本气泡（可带本地静态图路径） | 参数数组**不能当正文**：`["甲","乙"]` 是工具调用的容器，不是消息内容。发送端点把它还原成多条气泡；实在切不出来就 **400 硬失败、一条都不发**（`qq-bridge/src/lib/text-safe.js` 的 `splitSerializedBubbles` + 发送端点 + `onebotSend`） |
| `qq_reply` | `mcp-napcat-safe.js:969` | 带引用回复 | 引用回复**不会自动生效**：别给 `qq_send_message` 传 `replyToMessageId` 就期待它引用，要用 `qq_reply` |
| `qq_send_group_message` / `qq_send_private_message` | `946` / `1001` | 显式指定目标会话发 | 只在需要发到**非当前会话**时才用；目标必须在 `allow.groups` / `allow.private` 里，且工具参数 `crossSession` 必须为 `true`，否则拒绝（`crossSessionRefusal`） |
| `qq_send_poke` | `mcp-napcat-safe.js:1370` | 戳一戳 | 群里必须给 `targetUserId`；私聊可省（默认戳当前对话方） |
| `qq_proactive_send` | `mcp-napcat-safe.js:2039` | 主动搭话 | 受 `social.proactive.*` 间隔与概率约束 |
| `qq_withdraw_message` | `mcp-napcat-safe.js:1231` | 撤回**自己**发的消息 | 只能撤自己的；`id` 来自唤醒正文的 `(id:xxx)` 或 `qq_get_my_recent_messages`。成功后按 `(conv_key, message_id)` 幂等写入 `recalled_at`（`markChatRecalled`，`chat-db.js:691`） |
| `qq_send_forward` | `mcp-napcat-safe.js:2985` | 合并转发 | 超过单条上限（`social.send.maxMessageChars`）时用它或 `qq_send_docx`，**不是**拆气泡 |
| `qq_send_docx` | `mcp-napcat-safe.js:2955`、`core/docx.js`、`src/make-docx.js` | 发 Word 文档 | 有每日额度（`state/docx-quota.json`，`core/docx.js` 启动扫旧文件）。NapCat 在容器里时**宿主路径读不到**——这正是 `lib/napcat-file.js` 存在的原因 |
| `qq_deepsleep` | `mcp-napcat-safe.js:1263` | 立即进入深层静默 | |
| `qq_set_wake_config` | `mcp-napcat-safe.js:1280` | 设置唤醒条件（模式 / 时长 / 触发器 / `speakerIds`） | 每轮都得重设。模型拿不到"主人配的概率"时会一直沿用自己上一轮拍的值——所以唤醒正文每轮都带 `[WakeRef]`（`wake-send.js:334-340`），且配置热加载时 `applyOwnerWakeProbabilityToSessions` 会把模型自定的值覆盖回 `source='owner'`（`social-state.js:99-121`） |
| `qq_wait_for_messages` | `mcp-napcat-safe.js:1439` | 等待新消息（长轮询） | 挂着它时消息作为**工具结果**回到模型手里，不走投递路径（`core/social-state.js` 的 `activeWaits` 守卫）。它会让回合长时间无事件，所以有 `LONG_WAIT_TURN_TIMEOUT_MS = 11 * 60 * 1000`（`core/turn-guard.js:21`） |
| `qq_report_feedback` | `mcp-napcat-safe.js:1466` | 上报问题给主人 | 落 `state/feedback.json` |

### 2.2 发送链常量与重试矩阵

| 常量 / 行为 | 数值（原样） | 位置 |
| --- | --- | --- |
| 单次发送超时 | `SEND_TIMEOUT_MS = 15000`，`AbortSignal.timeout(15000)` | `qq-send.js` |
| 重试前等待 | `sleep(2500)` | `qq-send.js` |
| 触发重试的错误 | 连接类异常、`1006514` / `网络连接异常`、文件路径读不到（自愈为 base64 重发）、`Get Uid Error`（丢弃 @ 重发） | `qq-send.js` |
| 未确认送达 | 命中 `EventChecker Failed|Timeout: NTEvent…sendMsg` → 返回 `{message_id:null, messageId:null, unconfirmed:true}`，**不当成功也不当失败** | `qq-send.js` |
| 正文切分 | `splitForQQ(text, max = 4000)` | `qq-send.js` |
| 幂等窗口 | `REPLAY_WINDOW_MS = 180000`，`DELIVERED_KEEP = 50` | `send-idempotency.js` |
| WS 出站队列 | `OUTBOX_MAX = 200`、`SEND_TIMEOUT_MS = 20000`、`CONNECT_TIMEOUT_MS = 15000` | `qq-bridge/src/lib/onebot-ws.js:10-28` |
| 重连退避 | `RECONNECT_BASE_MS = 1500`、`RECONNECT_MAX_MS = 10000`、看门狗 `HEARTBEAT_WATCHDOG_MS = 45000` | `lib/onebot-ws.js:10-28` |

日志上限：`log()` 保持 `state/bridge.log` 最近 **2000** 行（`qq-bridge/src/lib/log.js:15`），`appendActivity` 保持 `state/qq-activity.log` 最近 **500** 行（`lib/log.js:28`）。

### 发字节拍与 `clampSendPace`

发送节奏只保留"按字数"一种（`social.send`）：批内首条秒回，第 2 条起 = `本条字数 × linearPerCharMs`，±`linearJitterRatio` 抖动，夹在 `[linearMinMs, linearCapMs]`。

默认值与硬钳制（`qq-bridge/src/lib/send-gaps.js` 的 `LINEAR_DEFAULTS` 与 `qq-bridge/src/core/config.js` 的 `clampSendPace`）：

| 键 | 默认值 | 钳制区间 | 说明 |
| --- | --- | --- | --- |
| `linearEnabled` | `true` | — | `false` = 完全不延迟；**不受钳制影响**，原样生效 |
| `linearPerCharMs` | `150` | `[60, 1000]` | 真人打字约 4~5 字/秒（200~250 ms/字）。超区间会打日志 `[config] 打字节拍钳制：linearPerCharMs 旧 → 新（超出 60~1000 的合理区间；总量另由 linearCapMs 封顶）`（`config.js:420-422`） |
| `linearMinMs` | `250` | `[0, 2000]` | 且不能高过 `linearCapMs`（超了就直接被设成 cap）。**这一项被钳制时不打日志**（`config.js:430`） |
| `linearCapMs` | `4000` | `[800, 6000]` | 超区间打日志 `[config] 打字节拍钳制：linearCapMs 旧 → 新（上限太大同样会让长句像卡住）`（`config.js:425-427`） |
| `linearJitterRatio` | `0.25` | — | |
| `linearResetMs` | `60000` | — | 距上次发送超过该值即重新视为"批内首条" |
| `MIN_GAP_MS` | `100` | — | 两条之间绝对最小间隔 |

`clampSendPace(send)`（`qq-bridge/src/core/config.js:413-437`）在 `loadConfig()` 末尾调用（`:386`），内部 `clamp` 对非有限值返回 `null`（即保留原值）。剩下的 `social.send` 非节拍键保持原样默认：`burstEnabled: true`、`burstMaxMessages: 8`、`longGapProbability: 0.25`、`longGapMinMs: 8000`、`longGapMaxMs: 18000`、`maxSendPerMinute: 8`、`maxSendPerHour: 60`、`maxMessageChars: 500`、`maxGapMs: 15000`。

现场（线上数据，不是推测）：服务器那份 `config.json` 的 `social.send` 被调成 `linearPerCharMs: 650` / `linearCapMs: 15000`，于是 17 个字 = 11.0 秒。DSH 会话日志里每条 `qq_send_message` 的结果都带着这个数：`delays 5237 / 8050 / 9388 / 10989 / 11753 ms`，**118 次发送总计执行 990 秒**。主人感觉到的"唤醒后要响应一段时间"就是它。

为什么不只改配置值：这些键**模型自己在私聊里就能改**（`core/tunables.js` 的可调项名单里有它们），只改文件的话下一次自调又会回来。

回归测试：`qq-bridge/tests/send-pace-clamp.test.js`。

### 出站正文格式治理

模型写的正文在**出站那一刻**过一遍格式治理：

| 规则 | 谁负责 | 行为 |
| --- | --- | --- |
| 不许显式换行 | **提示词**（preset `[TOOLS] 2b`） | 一条气泡就是一行。桥**不做正则清洗**（主人 2026-09-20 定稿"换行不必正则"），所以这条只靠规则本身 |
| 颜文字要有出处 | **提示词**（`[TOOLS] 2c`） | 人设没要求就不发；要求了的话正文（含标点）≤10 字跟在同一气泡，超过 10 字单独一条 |
| 代码类不分段 | **提示词**（`[TOOLS] 2e`） | 代码始终一条气泡，>50 字也不拆 |
| 工具参数数组不能当正文 | **桥侧真的拦** | `splitSerializedBubbles` 还原多条气泡；切不出来就 400（`lib/text-safe.js`） |
| 产物 token 清洗 | **桥侧真的做** | `ARTIFACT_TOKEN_RE` / `sweepMessageArtifacts` / `cleanOutboundText`（`qq-bridge/src/lib/outbound-text.js`） |
| 气泡分隔提示 | `SPACE_SPLIT_HINT`、`DIRECTION_HINT`、`SEND_TOOL_RE`、`SILENT_MARKER = '[SILENT]'` | `qq-bridge/src/lib/markers.js` |

回归测试：`qq-bridge/tests/outbound-format.test.js`、`tests/outbound-send-integration.test.js`，preset 内容由 `qq-bridge/tools/test-wake-protocol.mjs` 的 D 组兜住。

### 敏感内容拦截

**执行者不是 `core/audit.js`**（见 §19 冲突项）。真实拦截点：

| 位置 | 判据 | 行为 |
| --- | --- | --- |
| `console-server.js:1191 / 2137 / 2488 / 5180` | `SENSITIVE_RE.test(message)` | HTTP 403 `消息含敏感信息，已阻止发送` |
| `qq-send.js:197-201` | `tokenDisclosureIn(message)` | 抛错 `发送内容疑似泄露会话令牌` |
| `mux.js:1248 / 1343-1370` | 报错、提问、审批文本命中 | 文本替换为 `（含敏感信息，已隐藏）` |

判据本体在 `qq-bridge/src/sensitive.js`：`PATH_RE`（盘符/UNC/`/home|/Users|/etc|/var|/tmp|/opt` 绝对路径）、`SECRET_PATH_RE`（`.ssh/ .aws/ .gnupg/ id_rsa *.pem credentials .netrc`）、`CRED_RE`（`token|密码|密钥|口令|password|secret|api_key|authorization|bearer|credential|私钥` + `:`/`=`/`：` + ≥6 位 ASCII 值），合成 `SENSITIVE_RE`；`sensitiveHitKind()` 返回 `'path' | 'secret-path' | 'credential'`，`sensitiveHitSample(text, max = 48)` 给日志用。

脱敏侧在 `qq-bridge/src/lib/text-safe.js`：`TOKEN_LABEL_SRC`、`tokenDisclosureIn`、`redactSensitiveText`、`KNOWN_AGENT_TOKENS`、`LEARNER_AGENT_TOKENS`、`SENSITIVE_ARG_KEYS`（21 个参数键）。`log()` 与 `appendActivity()` 写盘前都过 `redactSensitiveText`（`lib/log.js:8/24`），所以 `state/bridge.log` 里的 `token` 一律显示为 `***`。

设计边界（`sensitive.js:1-11` 逐字）：只拦"明显像凭据/本机敏感路径"的形态，**不再因聊天里提到 token/密码/密钥等词就误伤**；`/app/`、`/root/` 这类项目自身部署形态的路径不算敏感。

---
## 3. 富文本卡片与文档

### 3.1 卡片类型枚举

工具层 schema（`qq-bridge/src/mcp-napcat-safe.js:3024`）：

```js
z.enum(['music', 'video', 'contact', 'location', 'dice', 'rps'])
```

服务端分支顺序（`qq-bridge/src/core/console-server.js`）：`music` → `video`（L3180）→ `location`（L3221）→ `contact`（L3341）→ `dice`/`rps`（L3346）→ `json`/`xml`（L3348）。兜底文案逐字：`'不支持的卡片类型（仅 music/video/contact/location/dice/rps/json/xml）'`（L3353）。

| 类型 | 段结构 | 校验 |
| --- | --- | --- |
| `contact` | `{ type:'contact', data:{ type: ct, id: String(body.contactId) } }`（L3342-3345） | `ct` 必须 ∈ `['qq','group']`，否则 throw `contactType 仅支持 qq/group`；`contactId` 必填 |
| `dice` / `rps` | `{ type, data: body.result != null ? { result: Number(body.result) } : {} }`（L3347） | 无则空 data |
| `json` / `xml` | `{ type, data: typeof body.data === 'string' ? { data: body.data } : body.data }`（L3351） | 直通 |
| `music` | 由 `buildMusicCard` 构建；构建器缺失时兜底 `/^(163\|qq\|kugou\|kuwo\|migu)$/` → `{ type:'music', data:{ type: mt, id: mid } }`（L3158-3160） | — |
| `location` | `type:'location'` 段 + `view:'news'` 的 tuwen 卡（L3336-3338），另有 `locMode` / `locTextAfter` 补发（L3415-3424） | — |

解析侧展示文案（`qq-bridge/src/lib/message-parse.js:119-120`）：`case 'dice'` → `[骰子]`、`case 'rps'` → `[猜拳]`；`contact` 在 L95、`location` 在 L102。

### 3.2 音乐卡片（`qq-bridge/src/core/media.js`，1249 行）

导出：`isRealCoverBytes`(:34)、`normalizeCoverUrl`(:53)、`normalizeMediaUrl`(:92)、`qqMobilePlayUrl`(:135)、`neteaseMobileSongUrl`(:143)、`neteaseShareUrl`(:164)、`neteaseShareLink`(:188)、`neteaseRealCover`(:260)、`sendMusicCardWithFallback`(:276)、`createMediaDomain`(:311，返回 `{ sendRich, musicSearch, musicResolve, buildMusicCard, qqMusicResolve }`，:1248)。

**搜索** `musicSearch(query, platform = 'all', limit = 5)`（:1171，`max = Math.min(10, Math.max(1, limit || 5))`）：

- 网易云：`https://music.163.com/api/search/get?s=<q>&type=1&offset=0&limit=<max>`（超时 8000），再 `neteaseSongDetails` 补封面；返回 `{platform:'netease',title,artist,album,id,url:'https://music.163.com/#/song?id=<id>',cover,duration}`。
- QQ 音乐：先 `search_for_qq_cp`、老 `client_search_cp` 作第二顺位，取 `body?.data?.song?.list`；返回 `{platform:'qqmusic',title,artist,album,id:songmid||media_mid,url:'https://y.qq.com/n/ryqq/songDetail/<mid>',cover,duration:interval}`。

**封面归一化** `normalizeCoverUrl(raw, size = 300)`（:53）：① 非空裁剪；② `http://` → `https://`；③ **仅对 `music.126.net/` 补参**——已有 `type=jpg` 不动，有 `imageView=` 则补 `&type=jpg` 或 `&thumbnail=<size>x<size>&type=jpg`，都没有则补 `?imageView=1&thumbnail=<size>x<size>&type=jpg`；④ 路径段里的 `=` 百分号编码成 `%3D`（查询串不动）。注释里保留了四组实测字节数（:60-63）：无参数 `89504e` 4,410,875 B；`?param=300y300` `89504e` 210,146 B；`?imageView=1&thumbnail=300x300` `89504e` 210,146 B；`?imageView=1&thumbnail=300x300&type=jpg` `ffd8ff` 20,913 B。

`isRealCoverBytes`（:34）只认 JPEG `ff d8 ff` / PNG `89 50 4e 47` / WebP `RIFF`+`WEBP`，**不放行 GIF**。`ensureJpegCover`（:495）非真图时记 `[cover] 封面不是真图片…**丢掉这张封面、走兜底**` 并返回空串。`neteaseRealCover(id)`（:260）从 `state/incoming-cards.jsonl` 里照抄真卡 preview（要求 raw data 含 `100495085`、封面域名匹配 `QQ_COVER_HOST_RE = /^https?:\/\/([a-z0-9-]+\.)*(ugcimg\.cn|qq\.com)\//i`（:231）、jumpUrl 里有 `[?&]id=(\d+)`）。

**封面探活** `probeImage(u)`（:562）：`fetch(u, { headers: COVER_HEADERS, redirect:'follow', signal: AbortSignal.timeout(6000) })`，只读 `COVER_PROBE_MAX_BYTES = 64 * 1024`（:29），magic 取前 3 字节 hex，判定 `res.ok && isRealCoverBytes(buf)`。`pickImage` 两轮 + `sleep(800)`（:603-607），第二轮补 `rescue()` 候选（:609-614）；全失败返回 `{url:'', ct:'', magic:''}`（:621）——注释明写**绝不"兜底用第一个"**。

**降级梯子** `sendMusicCardWithFallback({ key, plan, seg, options, sendRichFn, sendText })`（:276）：

```
primary（有 seg，sendRichFn 成功）→ native（plan.native 存在，带 degradedFrom）→ link（sendText(plan.link)）
```

返回值 `card` 取值 `primary | native | link`；都没有时抛 `没有可发送的卡片段或兜底链接`（:308）。

**卡片构建** `buildMusicCard(platform, id, opts)`（:930）：

- `style` 解析（:952-955）：`opts.style` ∈ `['share','music','native']` 优先 → `MUSIC_CARD_STYLE`（来自 `QQBRIDGE_MUSIC_CARD_STYLE` 或 `cfg.social.send.musicCardStyle`，:317-319）→ 默认 `'share'`。
- 网易云（:957-1040）：`cardStyle==='native'` → `{type:'music', data:{type:'163', id}}`（注释实测约 50 s 超时后落链接）；缺封面或缺 audio → 退 native；否则 `data = { type:'163', url: shareLink, title, image: await ensureQqHostedImage(cover) }`，`cardStyle==='music'` 时才加 `data.audio`。`shareLink` 由 `cfg.social.send.neteaseShareUrl === 'bare'` 决定裸链还是 `neteaseShareLink(pid, opts?.uct2)`（:986-988）。
- QQ 音乐（:1049-1147）：`cardType` 由 `opts.cardType || QQBRIDGE_QQMUSIC_CARD || cfg.social.send.qqMusicCard` 决定 `'qq'` 还是 `'custom'`；候选封面剔除「songmid 当 albummid」，`pickImage(qqCoverCandidates, rescue → qqAlbumCoverBySongMid)`；**连封面都没有才退纯链接**；`data.url` 在 `music` 模式下用 `qqMobilePlayUrl(pid)`。
- 其它平台（`kugou/kuwo/migu/custom`，:1149-1167）：`url` 必填、`image` 必填（否则抛），`audio` 走 `normalizeMediaUrl`。
- 音频直链 `neteaseAudioUrl(id)`（:763）：候选顺序 `[meting, official]`（`official = https://music.163.com/song/media/outer/url?id=<id>.mp3`，`meting = https://api.injahow.cn/meting/?server=netease&type=url&id=<id>`），`usable()` 要求 http(s) 且不含 `/404`；全失败返回 meting 端点本身。

**发送链超时与去重**：`sendRichOnce` 外层总超时 `AbortSignal.timeout(45000)`（:399，注释说明 15 s 会把网易云拖成 `card=link`），发送前抖动 `await sleep(randInt(500, 1500))`（:386），同段去重 `RICH_DEDUPE_MS = Number(process.env.QQBRIDGE_RICH_DEDUPE_MS ?? 60000)`（:334）。

**签名服务**：`NapCat` 默认签名地址（`media.js:921` 注释记默认 `ss.xingzhige.com`，`:441` 另记 `musicSignUrl` 默认 `http://106.55.0.102:10087/`）。仓库里另有 `qq-bridge/music-sign-proxy.py`（241 行，`127.0.0.1:4567`，`SIGN_PATHS = {"/", "/music_card/card", "/api/music/sign", "/sign"}`，`HEALTH_PATHS = {"/health","/healthz"}`，上游 `https://api.czcn.xyz/api/qqyykp`，超时 15 s），**但全仓 JS/配置对它零引用，桥侧未配置 `musicSignUrl`**——它是未接线的外部中间层（详见 §19）。

### 3.3 视频卡片（`qq-bridge/src/core/video.js`，1259 行）

**链接识别** `extractVideoUrls(text)`（:49）：裸 `BV[0-9A-Za-z]{10}`（:59）与 `av(\d{1,12})`（:62）直接补成 URL；URL 正则 `/https?:\/\/[^\s<>"'()（）【】]+/g`（:64）去尾标点后交给 `classifyVideoHost`（:73）——支持 bilibili / douyin / kuaishou / xiaohongshu / weibo / youtube / x / telegram / pixiv / lofter。`parseVideoUrl`（:94）：bilibili 支持 BV、av、`?bvid=`，**b23.tv 路径位原样保留**（长短码 `shortCode`）；抖音 `/video|note|share/video/(\d{6,})`；YouTube `youtu.be`、`?v=`、`embed|shorts|live`；X `/status(es)?/(\d{6,})`。

**bilibili 四路降级** `resolveBilibili(rawUrl)`（:592）：

0. 短链先跟随 302 再 parse（认不出抛 `无法从短链里认出视频号`）。
1. `biliViaSecapi`（`SECAPI_BILI_DEFAULT = 'http://secapi.top/API/jiexi/bilibili.php'`，超时 `SECAPI_BILI_TIMEOUT_MS = 8000`，:408/:413）——只对 BV 生效。
2. 官方 view 接口 `VIEW_API_PATHS = ['/x/web-interface/wbi/view', '/x/web-interface/view']`（:327，wbi 优先，注释记老 `view` 在机房 IP 稳定 412），只补空字段。
3. 分 P `pagelist` → 缺封面/UP 时按标题反查。
4. 网页 `og: meta`（代理仅当 `QQBRIDGE_VIDEO_PROXIES` 非空，:37）。

全败抛 `bilibili 解析失败`（:711）。返回字段：`{platform,id,kind,url,shareUrl,cardUrl,title,author,cover,description,durationSec,durationText,stat,playText,pubdate,pubdateText,source}`。短码缓存 `SHARE_CODE_TTL_MS = 10 * 60 * 1000`（:507）；探活超时 `PROBE_TIMEOUT_MS = 9000`（:25）。

**其它平台**：`resolveDouyin`（:774）短链 302 → `iesdouyin` 分享页 → `window._ROUTER_DATA` → og；全失败抛带 `err.degraded = true` 的错（:821-823）。`resolveVideo`（:858）对其余平台只抓 og（referer 按平台），抓取异常也标 `err.degraded = true`（:873-877）。

**小程序 Ark 卡片** `fetchMiniAppArk(info, { httpUrl, token, timeoutMs = 12000 })`（:1033）：请求体逐字（:1127）

```js
JSON.stringify({ type, title: title.slice(0,100), desc: desc.slice(0,100), picUrl, jumpUrl, webUrl, rawArkData: 'true' })
```

`type = platform === 'bilibili' ? 'bili' : (platform === 'weibo' ? 'weibo' : '')`——**模板只有 bili / weibo 两种**；缺 title 或 jumpUrl 直接 `return null`（退分享链接），缺封面**不**阻止 Ark（picUrl 传空串）。发送形态（:1140-1149）：`{ ver, prompt, config, app, view, meta, miniappShareOrigin: 3, miniappOpenRefer: '10002' }`，最终段 `{ type:'json', data:{ data: JSON.stringify(send) } }`。`buildVideoCard`（:1158）style 默认 `'share'`（`QQBRIDGE_VIDEO_CARD ?? 'share'`，:1163）；`QQBRIDGE_VIDEO_CARD=json` 已停用、不再产出 Ark（:1183-1201）。

**`degraded` 判定**（逐条）：

| 判据 | 位置 | 语义 |
| --- | --- | --- |
| `err.degraded = true` | `video.js:822` | 抖音只剩链接可用 |
| `err.degraded = true` | `video.js:875` | 通用平台抓页失败 |
| `sentCard === 'link' && videoPlan.style === 'share'` → `intendedShare` | `console-server.js:3428` | **预期形态，不算降级** |
| `sentCard !== 'primary' && !intendedShare` | `console-server.js:3429-3431` | 记 `[rich] ${type} 卡片降级 card=${sentCard} …` |
| 端点失败返回 `{ok:false, error, degraded, url}` | `console-server.js:3526` | — |

### 3.4 文档（`qq-bridge/src/core/docx.js`，140 行）

| 常量 / 函数 | 值 / 签名 |
| --- | --- |
| `DOC_TMP_DIR` | `path.join(STATE_DIR, 'doc-tmp')`（:19） |
| `MAX_DOCX_CHARS` | `1000000`（单文档正文上限，:24） |
| `DOCX_QUOTA_FILE` | `path.join(STATE_DIR, 'docx-quota.json')`（:27） |
| `dailyDocxQuota()` | 默认 `100000`（:38-39） |
| 临时文件清理阈值 | `60 * 60 * 1000`（1 小时，:81） |
| 上传超时 | `AbortSignal.timeout(30000)`（:116） |
| action | `upload_private_file` / `upload_group_file`（:94） |
| 标题净化 | `replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 40)`（:84） |

流程：`docxQuotaReserve`（:57，超额直接拒且不占用）→ `writeDocxToMount(title, content, extraName)`（:74，文件名 `${safeTitle}${extraName ? '-' + extraName : ''}-${Date.now()}.docx`）→ `uploadFileToQQ`（:92）→ `docxQuotaCommit`（:67）。落盘保留最近 7 天（`saveDocxQuota`，:51）。

**已删除链路**：原 `/help`（发《小鲸鱼能力概览》docx）已删除（`docx.js:139-140` 注释）。

### 卡片与封面的三条硬规矩

1. **封面必须是真图字节**：`isRealCoverBytes` 只认 JPEG / PNG / WebP 三种魔数，GIF 不放行；探活只取前 `64 KB`、超时 6 s，两轮都拿不到就**丢弃这张封面走兜底**，绝不"兜底用第一个候选 URL"（`media.js:34/562/603-621`）。
2. **卡片发不出去必须能退到链接**：`primary → native → link` 三档，任何一档失败都要落到下一档，且回执里必须写清当前档位（`card` 字段）与来源（`degradedFrom`）（`media.js:276-308`）；`style === 'share'` 时落到链接是**预期**，不算降级（`console-server.js:3428`）。
3. **卡片占位不能靠猜**：媒体没投递成功时给模型的是显式占位文案 `—— 这张图没能投递给你，看不到就如实说"图没加载出来"，不要猜内容`（`media-pipe.js:207`），以及 `[图片（尺寸过大已跳过：…）…]`（:227）、`[图片（获取失败）…]`（:229）。

---

## 4. 表情包与贴纸

### 4.1 收藏表情（QQ 侧是源，本地是认知层）

存储 `state/stickers.json`（`lib/paths.js:14`）；**没有 index.db**。写盘 `saveStickerStore` 走原子写 + 权限 `0o600`（`sticker-lib.js:60-63`）。

条目 17 个字段（`normalizeStickerEntry`，`src/sticker-lib.js:22-45`）：`id`、`resId`、`url`、`md5`（大写）、`desc`、`localNote`、`tags`（≤20）、`usage`、`source`（`manual`/`ai`/`qq`）、`useCount`、`lastUsedAt`、`lastContext`（≤200）、`createdAt`、`updatedAt` 等。

**同步** `syncStickerLibrary(force = false)`（`core/sticker.js:117`）：TTL 默认 `60000`（:120）；条数 `Math.min(500, Math.max(1, maxListCount || 100))`（:126）；优先 `fetch_custom_face_detail`，回退 `fetch_custom_face`（:131-139）；接受 `payload | payload.data | payload.list | payload.faces | payload.customFaceList`（:141-146）；md5 从 URL 尾段提取 `/([0-9A-F]{32})(?:_0_0|\/0|\/|$)/i`（:151）；合并只覆盖 QQ 侧字段、保留本地 AI 字段（`mergeStickerLibrary`，`sticker-lib.js:69`）。

**查找** `findSticker(entries, ref)`（`sticker-lib.js:115`）：两轮——先精确（`id` / `resId` / 大写 `md5` 相等），再模糊（url 去尾斜杠、去协议后互相 `includes`）。

**列表** `formatStickerList(entries, query = '', limit = 48)`（:133）：查询匹配 `[desc, localNote, usage, id, resId, md5, ...tags].join(' ').toLowerCase()` 子串；`max = Math.max(1, Math.min(500, limit || 48))`；返回 `{ total, matched, truncated, stickers[] }`。**注入提示词** `buildStickerContext(entries, max = 8)`（:165）按 `useCount` 降序取 `Math.min(30, max || 8)` 条。

**发送** `sendSticker2(key, stickerRef, options)`（`sticker.js:220`）：

1. 缓存查不到 → `forceResyncForLookup()`（冷却 `FORCE_LOOKUP_COOLDOWN_MS = 30000`，:43）。
2. `replyToMessageId` 必须匹配 `/^-?[1-9]\d*$/`（:239）；`atUserId` 必须 `/^\d+$/` 且不能是 all（:244），后补一个空格文本段（:247）。
3. **一条消息只能一张表情**（:235-236）。
4. `local://` 前缀直接走本地路径（:254-255）；否则 `validateFetchUrl` 校验拒内网（:258）→ 下载（超时 20000，:268）→ `writeStickerTmpFile` 落 `state/sticker-tmp`（可被 `napcat.tmpDir` 覆盖，:278/:437）→ `image` 段恒带 `sub_type: 1`（QQ 表情通道，:251-253/:279）。
5. 发送链 `enqueueSend` + `sleep(randInt(300, 700))`（:298），超时 `15000`（:307）；失败且错误含 `文件处理失败|识别URL失败|ENOENT|no such file` → 改 `base64://` 重发一次（:313-320）；成功回写 `markStickerUsed`（:352-354）。

**收藏** `collectSticker2(key, messageRef, remark)`（:489）：只能收藏别人发的（`if (found.isSelf) throw`，:498）；image 走 `fetchOneBotImage`、face 走 `fetchFaceMedia`（:509-521）；**严禁把原始 `media.url` / `media.file` 交给 OneBot**（:507 注释）；`add_custom_face` 只收本地路径（base64 会 `ENAMETOOLONG`），故 `file = rewriteToContainerPath(tmpFile, cfg) || tmpFile`（:526）；备注上限 `Math.max(1, collect.maxRemarkChars || 20)`（:527）；新增/失败判定靠 md5 或"同步前后差集"（:531-561）。`add_custom_face` 报"不支持" → `collectFaceSupported = false` 并降级写入本地图库 `<state>/../stickers-upload/<id>.img`（`url = local://<abs>`，`source = 'manual'`）（:53-89/:546-554）。QQ 侧备注用 `set_custom_face_desc`（注释明确 `modify_custom_face` 不存在，:582-590）。

**配置**（`social.sticker`）：`{enabled:true, syncTtlMs:60000, maxListCount:100, includeInPrompt:true, promptMaxStickers:8, collect:{enabled:true, maxPerMinute:2, maxPerHour:10, maxRemarkChars:20}}`。

**工具映射**：`qq_list_stickers`（`mcp-napcat-safe.js:1749`）、`qq_get_sticker_image`（:1775）、`qq_send_sticker`（:1803）、`qq_collect_sticker`（:1830）、`qq_get_self_image`（:1857）、`qq_sticker_note`（:1885，`applyStickerNote2` :457）、`qq_set_sticker_remark`（:1916，`setStickerRemark2` :469，remark `slice(0, 50)`）。

### 4.2 内置表情包（meme-packs）

**目录布局**（`mcp-napcat-safe.js:51-58`）：`<包目录>/{manifest.json, index.db, memes/<tag>/<文件名>.<ext>}`；三类位置（顺序即优先级）：① `<runtimeRoot>/meme/<packId>/` ② `<runtimeRoot>/meme-packs/<packId>/` ③ `<角色库根>/<角色slug>/meme-packs/<packId>/`。目录名 ≠ id，**id 以 manifest 为准**。`index.db` 必须是存在且非空的文件，`manifest.json` 读不到/坏掉当没有。缓存 `MEME_RESCAN_MS = 5000`（:73）、`MEME_LEGACY_PACK_ID = 'whale-fanart-001'`（:71）。

**`index.db` 表结构**（现场实测，`node:sqlite` 只读查 `meme-full/whale-fanart-001/index.db`，`COUNT = 162`）：

```sql
CREATE TABLE memes (path TEXT PRIMARY KEY, tag TEXT NOT NULL, file_name TEXT NOT NULL,
  file_hash TEXT, caption TEXT NOT NULL DEFAULT "", keywords TEXT NOT NULL DEFAULT "",
  mtime REAL, captioned_at REAL)
```

样例行：`{"path":"memes/angry/女老师教小鲸鱼学习元.webp","tag":"happy","file_name":"女老师教小鲸鱼学习元.webp","file_hash":null,"caption":"女老师教小鲸鱼学习，元气满满","keywords":"女老师教小鲸鱼学习 元气满满", …}`。tag 分布：`happy 48 / daily 27 / shy 24 / angry 15 / sad 13 / sigh 11 / surprised 9 / confused 6 / love 4 / sleep 4 / work 1`。

**搜索** `qq_meme_search`（:2067-2112）：SQL `SELECT file_name, tag, caption, keywords FROM memes WHERE 1=1` + `AND tag = ?` + `AND (caption LIKE ? OR keywords LIKE ?)`（两侧 `%q%`）+ `LIMIT ?`；`n = Math.min(20, Math.max(1, limit || 8))`；按 `orderedMemePacks` 顺序跨包累加。无结果提示逐字：`没找到匹配的表情，试试：生气/哭/睡觉/开心/疑惑/害羞/干活/日常`；结果行格式 `` `${i+1}. ${r.file_name} [${r.tag}] [${r.packId}] ${r.caption}` ``；坏包计数提示 `（另有 N 份表情包读不出来，已跳过）`；tag 建议值 `happy/angry/sad/shy/confused/surprised/sigh/sleep/daily/love/work`。

**包优先级** `orderedMemePacks(cfg)`（:287-296）：绑定角色包 0 → 同角色目录包 1 → `social.meme.packs` 指定 2 → 出厂包 3 → 其余 4，同档按 id 字典序；`social.meme.packs` 非空时只搜「指定包 + 角色绑定包」。单张挑选 `firstMemeByQuery(packs, query, tag, onlyPack)`（:321）同 SQL 但 `LIMIT 1`；老包无 `path` 列时按 `memes/<tag>/<file_name>` 推（`queryMemePath`，:303）。

**发送** `qq_send_meme`（:2117 起）：`file` 可选——只给 `query`/`tag` 时用 `firstMemeByQuery` 自选（:316-318 注释记录此前报 `-32602: missing required tool_input_fields: file`）；拷贝到 `cfg.napcat.tmpDir || <ROOT>/state/sticker-tmp`，名字 `${Date.now()}-meme-<basename>`，经 `napcatImageFileArg` 后按 `images: [tmpPath]` 走桥端点。

**找不到包时**提示逐字：`本机没装内置表情包（meme-packs），这个工具不可用。想发图可以试试 qq_send_message 带本地图片路径，或直接发文字。`（:271），并在启动自检时打一行 stderr 列出尝试过的路径（:249-256）。配置：`social.meme = {enabled:true, packs:[], personaPacks:{}, activePersona:""}`，工具注册受 `cfg.social?.meme?.enabled !== false` 门控（:2065/:2115）。

### 4.3 QQ 内置表情（face）

`qq_face_list`（`mcp-napcat-safe.js:2772`）列出可用 QQ 表情 id/名称；`qq_send_qq_face`（:2792）→ `sendQqFace2(key, faceId, faceName, options)`（`core/sticker.js:359`）；解析侧把 face 段渲染成 `[表情:…]`。收到表情（face/`mface`）时由 `fetchFaceMedia`（`media-pipe.js:156`，`botRef.fetchFaceEntity(faceId, { timeoutMs: 12000 })`）取图，供模型看图（§5.1）。

### 「什么时候发布表情」由桥掷骰决定

- 概率与冷却不走模型：桥在 `qq-bridge/src/core/send-dice.js` 里用 `dice(kind)` 掷骰，只区分 `meme` 与 `voice` 两个 kind；常量 `MEME_DEFAULT_PROBABILITY = 0.3`、`MEME_DEFAULT_COOLDOWN_MS = 3 * 60 * 1000`（同一文件；该文件本次未逐行复核，取值来自常量声明）。
- 配置入口是 `social.*` 下的概率/冷却字段（如 `social.sticker.enabled`、`social.meme.enabled`），**模型无法自己决定"现在发个表情"**——它只能调 `qq_send_meme` / `qq_send_sticker` 主动发，掷骰只用于桥的主动行为（如主动搭话、语音）。
- 收藏表情的"注入"与"发送"是两条独立开关：`includeInPrompt` 控制是否把清单注入提示词（`promptMaxStickers = 8` 条），`enabled` 控制工具是否可用。

---

## 5. 图片：联网找图 / Pixiv / 空间配图

### 5.1 收到的图如何进模型（`qq-bridge/src/core/media-pipe.js`，348 行）

常量：`MAX_MEDIA_BYTES = 25 * 1024 * 1024`（:15，单条消息图片总字节）、`MAX_MEDIA_PIXELS = 64_000_000`（:16，防"图片炸弹"解码拖垮 DSH）、`MAX_MEDIA_STORE_PER_KEY = 500`（:17，每会话媒体元数据条数）。

`fetchOneBotImage(media, opts)`（:72）的四条分支，顺序固定：

1. `media.kind === 'image'` 且 `isProbablySafeImageFileRef(media.file)` → `botRef.getImage({ file }, { timeoutMs: 6000 })`（:80-86；注释记录 NapCat 内核下载常超时，原来等 12 s，现在 6 s 就落 URL 直连）。
2. base64 分支：`base64.length * 3 / 4 <= 25MB`（:91）→ 魔术字 `looksLikeImageBuffer`（:93）→ 像素闸 6400 万（:95-96）→ `asIs()`。
3. `obj.url` 分支：`safeFetchBuffer(url, MAX_MEDIA_BYTES)`（:106）→ 像素闸（:108）。
4. 本地文件分支：`fs.existsSync && isSafeLocalMediaPath(obj.file, cfgRef.napcat?.homeDir)`（:114）→ `stat.size` 闸（:116）→ 像素闸（:121）→ 魔术字校验（:123-127，防 BMP/AVIF/TIFF 触发 `INVALID_IMAGE`）。
5. 兜底再试 `media.url`（:142）。

`asIs = raw ? { buffer, mimeType, compressed:false } : finalizeImageBuffer(buf, mime)`（:78）——**`raw = true`（转发用）不做任何重编码**，默认路径压缩。投递闸门 `gateImage`（:197）→ `ensureDeliverableImage`，不过就换成文字占位（含 `MEDIA_PLACEHOLDER_HINT`，:207/:227）。组装 `resolveMediaList`（:232）：超过会话上限的条数跳过、累计字节超 25 MB 跳过（:260）；识图分流开启时走 `describeImageWithVisionModel` 换成文字（:272-280），否则给 `type:'image'` + base64 附件（:282）。`fetchMediaData`（:287）同构，`raw` 时额外附 `out.raw = true` 与 `out.sha256`（:321-323）。

### 5.2 SSRF 防护与统一下载（`qq-bridge/src/safe-fetch.js`）

`validateFetchUrl(raw)`（:132）：仅 `http/https`、URL 不得含凭据，返回 `{ url, ip }`。`resolveSafeHost(hostname)`（:107）：`localhost`/`.localhost`/`.local` 直接拒；字面 IP 走 `isPrivateIp`；域名 DNS 查询 `withTimeout(dnsLookup(h, { all:true, verbatim:true }), 5000, …)`，**任一解析结果为内网即拒**（:124-128）。

`isPrivateIp(ip)`（:66）覆盖：`10/8`、`127/8`、`0/8`、`169.254/16`、`172.16-31`、`192.168/16`、`100.64-127`、`198.18-19`、`192.0.0/24`、`>=224`；IPv6 含 `::`/`::1`、`fc`/`fd`、`fe80-`、`fec0-`、`2001:db8`、`2001:2:`、`2001:10:`、`2001:20:`、`ff`，并对 `2002::/16` 内嵌 IPv4 递归判定。

`safeFetchBuffer(urlString, maxBytes = MAX_IMAGE_FETCH_BYTES, extraHeaders = null)`（:362）：`MAX_IMAGE_FETCH_BYTES = 15 * 1024 * 1024`（:348）；`MAX_REDIRECTS = 5`（:363），**每一跳都重新 `validateFetchUrl`**；非 2xx 抛错；`looksLikeImageBuffer` 不过抛错（:376-378）；`verifyImageComplete` 不过抛「图片字节不完整」（:382-385）。返回 `{ url, statusCode, buffer, contentLength, contentEncoding, complete }`。`requestOnceBuffer`（:394）强制按 URL 设置 `host` 头（丢调用方传的），固定 `user-agent: Mozilla/5.0`、`accept: image/*,*/*;q=0.8`、`accept-language: zh-CN,zh;q=0.9`。

### 5.3 压缩与转码（`qq-bridge/src/lib/image-compress.js`，316 行）

三级后端：`sharp` → 纯 JS（`./vendor/pngjs`、`./vendor/jpeg-js`）→ 判不可投递。

| 常量 | 值 |
| --- | --- |
| `IMAGE_MAX_SIDE` | `1280` |
| `IMAGE_HARD_MAX_SIDE` | `4096` |
| `IMAGE_HARD_MAX_BYTES` | `15 * 1024 * 1024` |
| `IMAGE_PUREJS_MAX_PIXELS` | `40_000_000` |
| `IMAGE_JPEG_QUALITY` | `82` |
| `IMAGE_MIN_COMPRESS_BYTES` | `40 * 1024` |
| `IMAGE_ANIM_KEEP_MAX` | `4 * 1024 * 1024` |

`compressImageBuffer`（:242）决策：`exceedsHard = 最长边 > 4096`、`needShrink = 最长边 > 1280`、`needByteTrim = 字节 >= 40KB`、`bytesOverHard = 字节 > 15MB`；动图在「不超硬上限且 ≤ 4 MB」时**完全原样**（:253）；`target = needShrink || exceedsHard ? 1280 : 最长边`。`finalizeImageBuffer`（:272）按**输出字节的真实格式**重定 mime（注释说明否则 DSH 报 `IMAGE_TYPE_MISMATCH`）。`ensureDeliverableImage`（:292）硬判：字节 > 15 MB → `图片字节超过 15MB`；单边 > 4096；像素 > 6400 万。jpeg 解码参数 `{ useTArray:true, formatAsRGBA:true, maxResolutionInMP:200, maxMemoryUsageInMB:1024 }`（:194）。

### 5.4 外发图统一入口（`qq-bridge/src/lib/napcat-file.js`）

`resolveImageFileMode(cfg)`（:31）：模式 ∈ `path | base64 | auto`，**默认 `path`**。`rewriteToContainerPath(filePath, cfg)`（:39）：最长前缀匹配，把宿主路径改写成容器内路径。`napcatImageFileArg(filePath, cfg, opts)`（:60）：已是 `base64://` / `file://` / `http(s)://` 的原样返回；`base64` 模式上限 `DEFAULT_BASE64_MAX_BYTES = 10 * 1024 * 1024`（:27），超限回落宿主路径并记日志（用 `(stat.size / 1048576).toFixed(1)MB` 格式化）。`resolveStickerTmpDir(cfg, fallbackDir)`（:92）。

落盘位置总览：`state/sticker-tmp`（表情，可被 `napcat.tmpDir` 覆盖）、`state/doc-tmp`（文档）、`state/qzone-img-tmp`（说说配图）、`state/image-tmp`（封面搬运，仅 `qqHostedCover=true` 时）。

### 5.5 联网找图（`qq-bridge/src/lib/image-search.js`，182 行）

`searchImages(query, opts)`（:122）同时问必应与百度：`bingImageSearch(query, limit = 8)`（:48）、`baiduImageSearch(query, limit = 8)`（:81），两源各自请求 `count/rn = Math.max(10, limit * 3)`。`limit = Math.min(20, Math.max(1, opts.limit || 8))`。超时 `TIMEOUT_MS = 9000`。打分是字面量：命中 token `+2`、中文查询配纯英文标题 `-2`、国内图床白名单 `+1`（:170-177）；交错轮转上限 `for (let guard = 0; guard < 200; guard += 1)`（:151）。两源各自的失败会在 `failures` 字段里如实回报（:132-143）。工具入口 `qq_image_search`（`mcp-napcat-safe.js:3152`）；直接发图 `qq_send_image`（:3188）。

### 5.6 Pixiv（`qq-bridge/src/lib/pixiv.js`，1684 行）

**来源优先级**（2026-09-20 定「官方优先」，`PIXIV_SEARCH_SOURCES` :913-917）：

```js
[['app-api', appApiSearchPage, 0], ['web-ajax', webAjaxSearchPage, 0], ['mirror', mirrorSearchPage, 1200]]
```

（第三项 = 重试前等待毫秒，只有镜像站等 1200。）每个来源最多试 2 次，只有"第二次也失败"才记入 `sourcesTried`；三源全灭抛 `pixiv 搜索失败：三个来源都没给出结果 —— …`。详情 `pixivIllustDetail`（:1261）、逐页原图 `pixivIllustOriginals`（:1333）、画师作品 `pixivUserWorkIds`（:1410，翻页上限 `PIXIV_USER_WORK_PAGES = 10`）、按名字搜画师 `pixivSearchUsersByName`（:1593）走同一优先序。镜像站默认 `DEFAULT_BASE = 'https://x.pixigraph.xyz'`（:122），可用 `pixiv.base` 或 `QQBRIDGE_PIXIV_BASE` 覆盖（`pickPixivBase` :147）；超时 `TIMEOUT_MS = 15000`。

**鉴权头** `pixivRequestHeaders(url, extra)`（:1071-1084）：固定 `user-agent` / `accept` / `referer: https://www.pixiv.net/`；**只有 pixiv 主机才带 `cookie`，非 pixiv 主机时把调用方塞进来的 `cookie` / `authorization` 一并删掉**（:1081-1083）。图床取字节必须带 `referer: https://www.pixiv.net/`（不带 403）。`pixivCookie()`（:998）：`QQBRIDGE_PIXIV_COOKIE_OFF=1` 强制无登录态；`cleanPixivCookie` 只保留键集合 `PHPSESSID|device_token|p_ab_id|p_ab_id_2|p_ab_d_id|p_ab_id_3|yuid_b|cookies_banner`，总长 ≤ 2000，仅 ASCII 0x20-0x7E。登录态试纸 `pixivLoginState(probeId = '80643572')`（:1104）判 `ajax/illust/<id>` 的 `body.urls.original` 是否为空。

**筛选参数归一化** `normalizePixivFilters(opts)`（:351），`NEW_KEYS = ['r18','tags','author','orientation','minWidth','minHeight','multiPage','excludeAi','illustType','sort','scanPages']`（:343）；**一个都没传 = 完全走旧路径**。

| 参数 | 合法值 | 非法回落 |
| --- | --- | --- |
| `r18` | `exclude` / `only` / `include` | 一律回落 `exclude` + warning |
| `sort` | `date_desc` / `date_asc` / `random` | 识别 `pop\|hot\|bookmark\|fav\|rank\|收藏\|人气\|热度` → `date_desc` 并说明"没有收藏数"；其它回落 `date_desc` |
| `tags` | 数组，或字符串按 `[,，、\s]+` 拆 | 忽略该项 |
| `author` | 非空字符串 | 忽略 |
| `orientation` | `portrait` / `landscape` / `square` | 忽略 |
| `minWidth` / `minHeight` | ≥1 的数字 | 忽略 |
| `multiPage` / `excludeAi` | 布尔 | 忽略 |
| `illustType` | `illust`(=0) / `manga`(=1) | 忽略（`2` 是动图 ugoira，不属这两类） |
| `scanPages` | ≥1 整数，上限 10 | 超限按 10；非数字按默认 3 |

默认 `scanPages = PIXIV_SCAN_PAGES_DEFAULT = 3`（:332，注释：3 页 = 最多 180 条原始数据），上限 `PIXIV_SCAN_PAGES_MAX = 10`（:333）；页码 `Math.max(1, Math.min(200, page))`，`limit = Math.min(20, Math.max(1, limit || 8))`。排序在**已扫到的页内**做（`random` 用 Fisher–Yates）。逐条过滤顺序 `filterPixivItems`（:479）：① id ② R-18 ③ 标签全命中 ④ 作者 ⑤ 构图 ⑥⑦ 最小尺寸 ⑧ 多图 ⑨ AI ⑩ illustType，另有跨页去重 `seenIds`；丢弃计数键 `noId/adult/notR18/tag/author/orientation/minWidth/minHeight/multiPage/ai/illustType/duplicate`。

**R-18 策略（fail-closed）**：`isAdult(item)`（:324-328）`if (Number(item?.xRestrict) !== 0) return true;`，再加标签兜底 `/r-?18|r18|エロ|グロ|成人|18禁/i`；工具层出口 `isAdultWork`（:1464）用同一函数避免规则漂移；按号取图不走搜索筛选，所以 `pixivIllustDetail` 里再判一次；app-api 行缺 `x_restrict` **不补 0**（补 0 会放行 R-18）。

**档位纪律**：`pixivImageTier`（:207）判 `original|master|thumb|unknown`——`/c/(\d{3,4})x(\d{3,4})` 边长 ≤600 一律 thumb，`_pN_(square1200|custom1200)` 也是 thumb，`_master1200|_square1200|_custom1200|_720|_1080` 是 master。`planPixivSend(sources, opts)`（:232）分 `primary` / `fallback` / `skipped`（thumb 直接 skipped；`wantOriginal && master` → fallback 且必须显式降级）。`pixivTierSizeVerdict(tier, info)`（:269）用详情宽高做像素对账（master 容差 5%）。`qq_send_pixiv` 的 `size` 默认 **original**。

**缓存与自检**：画师名缓存 `state/pixiv-artists.json`（`ARTIST_CACHE_MAX = 500`，原子写 + rename，按 `at` 最旧淘汰）；登录态自检状态 `state/pixiv-cookie-state.json`（`core/pixiv-watch.js:23`，字段 `refreshInvalid / refreshNotifyAt / recoveredAt / lastEvidence / invalid / lastNotifyAt`），巡检间隔 `CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000`、首次延迟 `FIRST_DELAY_MS = 90 * 1000`、通知冷却 `NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000`，修复命令 `node tools/pixiv-login.mjs --cookie "PHPSESSID=..."`。长期令牌存 `state/pixiv-token.json`（由 `qq-bridge/src/lib/pixiv-auth.js` 实现，**本文件未逐行核实**）。

工具映射：`qq_pixiv_search`（`mcp-napcat-safe.js:3411`）、`qq_send_pixiv`（:3446）。

### 5.7 失败与降级

| 环节 | 失败时 | 证据 |
| --- | --- | --- |
| 音乐卡 | `primary → native → link` | `media.js:286-308` |
| 音乐卡封面 | 拿不到 → native（163）/ 纯链接（QQ 音乐） | `media.js:996-997` / `:1118-1126` |
| 音频直链 | official `/404` → meting 端点本身 | `media.js:766/784` |
| 网易云分享链 | 页面取不到 → 静态 `neteaseShareUrl` | `media.js:212` |
| 封面搬 QQ 图床 | **默认关闭**；开启时任何失败原样返回外部 URL | `media.js:681/705/710/715` |
| 视频卡 | miniapp Ark → 封面图 + 分享文案 → 纯链接 | `console-server.js:3196-3218` |
| 视频 Ark 缺封面 | 仍要卡（`picUrl` 传空串） | `video.js:1109-1112` |
| 抖音 | `degraded:true` + 链接 | `video.js:821-823` |
| 识图 | 超时 / 非 2xx / 无文字 → 退回附件 | `vision.js:145-157`、`media-pipe.js:272-280` |
| 图片投递 | 超限 → 文字占位，不发 | `media-pipe.js:197-201` |
| 表情包目录缺失 | 工具返回明确提示 + 启动 stderr 列路径 | `mcp-napcat-safe.js:254/271` |
| 收藏表情不支持 | `add_custom_face` 不可用 → 本地图库 `local://` | `sticker.js:546-554` |
| 表情发送 | `识别URL失败/ENOENT` → base64 重发一次 | `sticker.js:313-320` |
| 说说配图 | 失败 → 纯文字说说 + `notes`/`tried` | `qzone-image.js:166/295-296` |
| 长文 | 超额 → `docxQuotaReserve` 拒（不占用额度） | `docx.js:57-65` |
| 搜图 | 两源各自 `failures` 如实回报 | `image-search.js:132-143/181` |
| 任意下载 | `safeFetchBuffer` 任何一步不合规即抛错，调用方换候选 | `safe-fetch.js:373-385` |

---

## 6. 语音（TTS / ASR）

**没有本地模型，也没有随包音频**：合成与识别都走小米 MiMo 的 OpenAI 兼容端点，实现集中在 `qq-bridge/src/core/voice.js`（1158 行）。

### 6.1 端点与模型

| 项 | 值（原样） | 位置 |
| --- | --- | --- |
| 端点 | `POST {baseUrl}/chat/completions` | `core/voice.js:304-308` |
| 默认 baseUrl | `https://token-plan-cn.xiaomimimo.com/v1` | `core/voice.js:59` |
| 备用 baseUrl | `https://api.xiaomimimo.com/v1` | `core/voice.js:60` |
| 鉴权 | 同时发 `api-key: <key>` 与 `authorization: Bearer <key>` 两个头 | `core/voice.js:318-322` |
| 合成模型 | `mimo-v2.5-tts` / `mimo-v2.5-tts-voicedesign` / `mimo-v2.5-tts-voiceclone` | `core/voice.js:52-57` |
| 识别模型 | `mimo-v2.5-asr` | `core/voice.js:52-57` |

请求形状：**要念的文本放 `assistant` 消息、风格描述放 `user` 消息、音色放 `audio.voice`**；返回取 `choices[0].message.audio.data` 的 base64，落盘成 mp3 再交给 NapCat 发 `record` 段。

### 6.2 工具

| 工具 | 注册行 | 做什么 | 生产上的坑 |
| --- | --- | --- | --- |
| `qq_send_voice` | `mcp-napcat-safe.js:2247` | 把文字合成语音发出 | **引用会被桥丢掉**：QQ 把"回复 + 语音"渲染成只有引用框的空气泡，要引用请用 `qq_reply` 发文字 |
| `qq_transcribe_voice` | `mcp-napcat-safe.js:2275` | 把别人发的语音转文字 | 收到的 `record` 段经 `get_record{out_format:'mp3'}` 转 mp3、`docker cp` 取回宿主再送 ASR；原始音频 ≤7MB（base64 后约 10MB）。**绝不猜语音说了什么** |

### 6.3 三种音色来源

| 模式 | 模型 | 要点 |
| --- | --- | --- |
| `tts` | `mimo-v2.5-tts` | `audio.voice` 传官方音色 id |
| `design` | `mimo-v2.5-tts-voicedesign` | 音色描述放在 **user 消息**里，**不传 `voice`** |
| `clone` | `mimo-v2.5-tts-voiceclone` | `audio.voice` 必须是样本的 **DataURL**；裸 base64 会被 400 拒（`core/voice.js:577-584`） |

官方音色只是一张 id 名单：`BUILTIN_VOICES`（`mimo_default`、冰糖、茉莉、苏打、白桦、Mia、Chloe、Milo、Dean），仓库里 **0 个音频文件**。

### 6.4 缓存、额度与落盘

| 项 | 值（原样） | 位置 |
| --- | --- | --- |
| 缓存键 | `sha1([mode, model, format, voice, style, description, text].join('\u0000'))` | `core/voice.js:274-278` |
| clone 模式的键 | `voice` 位替换为 `sample:sha1(dataurl).slice(0, 12)` | `core/voice.js:489` |
| 不缓存 | `pcm16` 格式 | `core/voice.js` |
| 淘汰 | 按 mtime 保留 `max(20, maxCacheFiles || 300)` 个文件 | `core/voice.js:280-288, 548` |
| 硬上限 | `MAX_TTS_CHARS = 2000` | `core/voice.js:63` |
| 默认额度 | `maxChars: 120`、`dailyChars: 20000` | `core/voice.js:73-104` |
| 主动发语音 | `send.probability: 0.2`、`send.cooldownMs: 600000`、`send.allVoice: false` | `core/voice.js:73-104` |
| 落盘 | `state/voice-config.json`、`state/voice-voices.json`、`state/voice-usage.json` | `core/voice.js:32-34` |
| 素材/缓存目录 | `cacheDir()` 下的 `samples/`、`voice-recv/` | `core/voice.js:258-267` |

### 6.5 全语音模式与降级

- 全语音模式（`send.allVoice = true`）下回复**一律**以语音发出，规划函数 `allVoicePlan()`（`core/voice.js:903-923`），执行 `tryAllVoiceReply()`（`core/voice.js:931-960`），调用点 `qq-send.js:480-494`。
- **任何一条不成立都自动退回文字**，并在日志留一行原因，**绝不吞消息**。
- 语音文件必须落在 **NapCat 读得到的目录**；读不回来时自动退 base64 重发。
- 密钥存 `state/voice-config.json`；管理端只回掩码与 `apiKeySet` 布尔值。不配 key 不影响文字发送。
- 唤醒正文里的 `[Voice]` 行由 `core/voice.js:985` 生成、在 `wake-send.js:538` 拼接；全语音时 `hardCap = min(MAX_TTS_CHARS, maxChars || 120)`，骰子命中时 `cap = min(60, maxChars || 60)`。
- **什么时候发语音由模型决定，但对齐桥侧的骰子**：每次唤醒桥先掷骰（`core/send-dice.js`），命中才往唤醒正文插一行「本轮可以额外加一条短语音气泡」。概率设 0 = 永不主动发。

### 6.6 未验证

- 本机 `state/` 目录下**没有** `voice-*` 文件（语音功能未在本机实机跑过），落盘结构结论来自代码而非现场文件。
- `core/voice.js` 的缓存淘汰与额度重试细节未逐行通读。

---
## 7. 记忆与画像

数据分两个 SQLite 库（2026-09-24 分家）：记忆档案 `state/memory.db`、聊天记录 `state/chat.db`。这是本层最重要的边界——**两库的表结构、检索算法、写入接口完全不同，`qq_memory_search` 只读后者**。架构细节见 [ARCHITECTURE.md §6](ARCHITECTURE.md#6-记忆层)。

### 7.1 库与表

`state/memory.db`（`qq-bridge/src/core/memory.js:46-80`）：

```sql
CREATE TABLE IF NOT EXISTS profiles (
  uid TEXT PRIMARY KEY, name TEXT DEFAULT '', personality TEXT DEFAULT '',
  likes TEXT DEFAULT '', dislikes TEXT DEFAULT '', birthday TEXT DEFAULT '',
  notes TEXT DEFAULT '', updated_at INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL, category TEXT NOT NULL,
  content TEXT NOT NULL, created_at INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mem_uid ON memory_entries(uid, category);
```

`ensureMemoryIndex` 再 ALTER 补 10 列（`memory.js:104-115`）：`pinned`、`importance`、`last_used_at`、`hits`、`expires_at`、`conv_key`、`tags`、`source`、`tier`、`updated_at`；建 `memory_meta (k,v)` 与索引 `idx_mem_tier(tier, uid, pinned)`、`idx_mem_conv(conv_key, created_at)`、`idx_mem_expire(expires_at)`（`memory.js:124-131`）；全文索引 `mem_fts` 为 `fts5(content, tokenize='trigram', content='memory_entries', content_rowid='id')` + 三触发器 `memory_entries_fts_ai/_ad/_au`（`memory.js:143-165`）；`FTS_SCHEMA_VERSION = '2'`（`memory.js:90`）。

`state/chat.db`（`qq-bridge/src/core/chat-db.js:51-145`）：

```sql
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conv_key TEXT NOT NULL, msg_seq INTEGER DEFAULT 0,
  message_id TEXT DEFAULT '', sender_uid TEXT DEFAULT '', sender_name TEXT DEFAULT '',
  is_self INTEGER DEFAULT 0, direction TEXT DEFAULT 'in', kind TEXT DEFAULT 'text',
  content TEXT DEFAULT '', quote_target TEXT DEFAULT '', media TEXT DEFAULT '',
  ts TEXT DEFAULT '', ts_ms INTEGER DEFAULT 0
);
ALTER TABLE chat_messages ADD COLUMN qq_seq INTEGER DEFAULT 0;      -- :83
ALTER TABLE chat_messages ADD COLUMN read_at INTEGER DEFAULT 0;     -- :84
ALTER TABLE chat_messages ADD COLUMN recalled_at INTEGER DEFAULT 0; -- :85
CREATE UNIQUE INDEX idx_chat_msgid ON chat_messages(conv_key, message_id) WHERE message_id != '';
```

另有 `chat_convs`（`conv_key, kind, name, count, sent, received, last_ts, last_text`）、`chat_stats`（单行计数器：`total / private_total / group_total / sent_total / received_total / conv_total / conv_group / conv_private / first_ts / last_ts / day / day_total / day_sent / updated_at`）、`chat_meta (k,v)`；`chat_fts` 同样 trigram + 三触发器；`FTS_SCHEMA_VERSION = '1'`、`MIGRATE_MARK = 'migrated_from_memory_db'`（`chat-db.js:33-36`）。

实测现场（只读打开 `qq-bridge/state/`）：`chat.db` 9,572,352 B，`chat_messages` **18,104 行**、`chat_convs` 9 行、`chat_fts` 索引 18,104 行，`chat_meta` 有 `migrated_from_memory_db=1790261226594`、`fts_version=1`；`memory.db` 61,440 B，只有 `profiles` / `memory_entries`（2 行，均 `category='qzone_post'`）/ `memory_meta`（`fts_version=2`），**没有 `chat_messages` 表**——分家迁移在本机已执行完成。

### 7.2 内存窗口与聊天记录库的分工

| 维度 | 内存窗口 `qq_get_recent_messages` | 记录检索 `qq_memory_search` |
| --- | --- | --- |
| 数据源 | `st.recentMessages`（内存 + `state/social-state.json`） | `state/chat.db` 的 `chat_messages` + `chat_fts` |
| 容量 | `social.context.recentLimit` 默认 **100**（`config.js:280`），持久化 `slice(-200)`（`social-state.js:348`） | 无窗口，全库 |
| 重启后 | 窗口恢复（`social-state.js:610`）；`unread` 故意不恢复（`:613`），由 `fetchUnreadChatMessages` 按 `lastAiSeenAt` 水位补回并塞进窗口（`wake-send.js:1316-1334`） | 永久，不受重启影响 |
| 开局注入 | `formatRecentWindow` 普通首轮 `min(24, max(6, contextWindow \|\| 12))`、轮换首轮 `min(60, max(24, resetWindow \|\| 24))`（`wake-send.js:593, 1820-1822`）。**只有窗口完全为空才用 DB 兜底** `recentChatMessages(key, maxCount)`（`:601`） | 不自动注入；preset 限定每回合最多 2 次检索（`qq-bridge/dsh/agent-presets/qq-chat/agent.cordis.yml`） |
| 分页 | `offset` 只在窗口内挪（`console-server.js:1703-1705`） | `LIMIT ? OFFSET ?`（`chat-db.js:897`） |
| 单条上限 | 20（默认）/ 100（最大） | 30（默认）/ 60（最大）（`console-server.js:3801`） |

**易混点**：记忆条目检索是另一个工具 `qq_memory_notes` → `GET /api/social/memory-notes` → `listMemoryEntries`（`console-server.js:3700-3721`），读的是 `memory.db` 的 `memory_entries` + `mem_fts`。`qq_memory_search` 与它无关。

### 7.3 检索算法

公共归一化 `ftsQueryOf(text)`（`qq-bridge/src/lib/fts.js:22`）：去引号 → 按 `[\s,，。;；、:：!！?？()（）\[\]【】/\\|+*^-]+` 切词 → **只留 `length >= 3`**（trigram 硬约束，单/双字放弃、退回 LIKE）→ 为空返回 `''` → **最多 8 个词** `slice(0, 8)`，逐个加引号后用 ` OR ` 连接。可用性判据 `ftsUsable(db, name)` 执行 `SELECT rowid FROM ${name} LIMIT 1`（`lib/fts.js:12`）。

`searchChatMessages(opts)`（`chat-db.js:859`）：

1. 条件顺序：`conv_key` → `chat_fts MATCH ?` → `content LIKE ?` → `sender`（`sender_name LIKE ? OR sender_uid = ?`）→ `date`（`ts LIKE 'YYYY-MM-DD%'`）→ `fromTs` / `toTs` / `maxTs` → `direction`。
2. `useFts = !!ftsQ && ftsUsable(db,'chat_fts')`；FTS 分支 `JOIN chat_fts ON chat_fts.rowid = chat_messages.id`（**不给 FTS 表起别名**，`:872-877` 记录了别名导致 `no such column` 并静默退 LIKE 的旧 bug），`ORDER BY bm25(chat_fts) ASC`。
3. FTS 分支**不数总数**，回 `total: rows.length, ranked: true`；LIKE 分支才 `COUNT(*)`。
4. 分页 `limit = min(200, max(1, … || 50))`、`offset = max(0, …)`。
5. **排序只有 BM25 或 `ts_ms DESC, id DESC`，没有任何时间衰减**；时间只作过滤条件。BM25 未传列权重（FTS 表只有一列 `content`，权重恒为默认 1.0）——**旧文档写的"加权 BM25"不成立，应删**。
6. 模型侧二次裁剪（`console-server.js:3815-3832`）：单条 `TRIM_CONTENT = 160` 字符、总量 `MAX_RESULT_CHARS = 12000`，丢 `media / quoteTarget / recalledAt / seq / direction`，超限给 `truncated = true` + 提示，并按 `offset + 本页 < total` 给 `more`。

`listMemoryEntries(opts)`（`memory.js:619`）：`limit = min(200, max(1, … || 30))`；未过期过滤 `(expires_at = 0 OR expires_at > ?)`；无 query 时排序 `pinned DESC, importance DESC, COALESCE(updated_at, created_at) DESC`；有 query 且 FTS 可用时 `JOIN mem_fts … ORDER BY bm25(mem_fts) ASC`，否则 `content LIKE '%q%'`。

`recentMessagesAcrossSessions(excludeKey, opts)`（`chat-db.js:789`）：`ts_ms >= now - windowMs AND content != ''`，`windowMs` 夹在 `[60000, 7*24*3600*1000]`（默认 `3600000`）、`limit` 夹在 `[1, 10]`（默认 2）、先扫 `scan = min(200, max(limit*8, 16))` 行再在内存里按会话去重，正文截 200。消费方是 `buildCrossChatBlock`（`crosschat.js:119`）。

学习语料 `loadGroupChatMessagesForLearning(opts)`（`chat-db.js:966`）：基础条件 `direction='in' AND is_self=0 AND kind IN ('text','qqface') AND content <> '' AND ts_ms BETWEEN ? AND ? AND content NOT LIKE '/%' AND content NOT LIKE '[CQ:%' AND content NOT LIKE '[转发%'`；`maxTotalMsgs` 夹 `[1, 20000]`（默认 2400）、单群上限夹 `[1, 2000]`（默认 800），按活跃群均分预算 `perCap = max(1, min(perGroupCapMax, floor(maxTotalMsgs / active.length)))`，超量单群用 `ROW_NUMBER() … WHERE rn % step = 1` 抽样，`step = max(2, ceil(total / cap))`。

### 7.4 记忆分层与写入

| 常量 / 规则 | 值（原样） | 位置 |
| --- | --- | --- |
| 分层 | `MEMORY_TIERS = { permanent: 0, durable: 90 * 24 * 3600 * 1000, working: 7 * 24 * 3600 * 1000 }` | `memory.js:87` |
| 永久类目 | `PERMANENT_CATEGORIES = new Set(['rule', 'owner', 'identity'])` | `memory.js:89` |
| 写入口 | `rememberEntry(o)`（`memory.js:547`）——幂等：`uid + category + content` 命中只 `hits + 1` 并取更强的 tier/pinned/expires_at | `memory.js:576-584` |
| 落盘截断 | `category.slice(0,40)`、`content.slice(0,4000)`、importance 夹 `0..100`、`convKey.slice(0,120)`、`tags.slice(0,200)`、`source.slice(0,40)` | `memory.js:552-565` |
| 档案字段白名单 | `personality / likes / dislikes / birthday / notes / name`；`personality`、`notes` 上限 4000，其余 500 | `memory.js:267-274` |
| 昵称补写 | `rememberContactName(uid, name)`：仅当现有 name 为空时写；只认 5–12 位 QQ 号、名字非纯数字、`n.length > 64` 拒绝、`name.slice(0,500)` | `memory.js:245-259` |
| 清理 | `pruneExpiredMemory()` 删 `pinned=0` 且非 permanent 且已过期的行；实际由 `memoryDigest` 按小时节流触发（`memory.js:696-701`），节流窗口 `> 3600_000` | `memory.js:668` |
| 会话级轻量记忆 | `activeTopics` ≤ 20、`pendingThoughts` ≤ 20（TTL `2 * 60 * 60 * 1000`）、`memberImpressions` ≤ 50（`traits` ≤ 10） | `memory.js:442-498` |

写入路径与调用点：

| 写入函数 | 位置 | 调用点 |
| --- | --- | --- |
| `persistChatMessage(convKey, entry)` | `chat-db.js:619` | `social-flow.js:100 / 142 / 284 / 390`（入站消息 / 拍一拍 / 自己发出的 / 文档）；`console-server.js:2692 / 2925 / 3032 / 3458 / 3638`（发送回登记 / 收藏表情 / QQ 表情 / 富卡片转发 / 文档发送）。幂等去重 `messageId`（`:628-632`），`text.slice(0,2000)` |
| `bumpCountersOnInsert` | `chat-db.js:398` | 由 `persistChatMessage:661` 调用，三条小 UPDATE，热路径不扫表 |
| `recountChatCounters` | `chat-db.js:320` | 批量删后与启动自检（`:304-309`） |
| `markMessagesRead` | `chat-db.js:668` | `console-server.js:1794`、`mux.js:1293`、`wake-send.js:1349`；只改 `direction='in' AND read_at=0` |
| `rememberEntry` | `memory.js:547` | `GET /api/social/memory-remember`（`console-server.js:3685`） |
| 裸 INSERT `memory_entries` | `persona-learn.js:555`、`qzone.js:39` | 绕过 API，`tier` 为空串，靠读出归一化兜住（`memory.js:530`） |

### 7.5 群缓存与群画像

`qq-bridge/src/core/group-cache.js`（126 行）维护三份内存结构：`groupInfoCache: Map<gid,{ownerId,ownerName,adminIds,adminNames,ts}>`、`groupNameCache: Map<gid,{name,ts}>`、`groupListCache = { ts, map }`。TTL 常量 `GROUP_INFO_TTL_MS = 10 * 60 * 1000`、`GROUP_LIST_TTL_MS = 10 * 60 * 1000`。

- **失效策略 = 纯 TTL + 惰性**：读时判断 `Date.now() - ts < TTL`，过期视为 miss 且不主动删除；**没有 invalidate / clear 导出**，刷新只靠 `warm*` 覆盖 `set`。
- 预热：`dsh-watch.js:232-245` 在模式定为 default 后对会话群 + `cfg.allow.groups` 调 `warmGroupInfo` / `warmGroupName`，并 `setInterval(warmGroups, 15 * 60 * 1000)`（`:243`）。
- `warmGroupName` 走 `botRef.getGroupInfo`，失败退 `get_group_list` 全量（`group-cache.js:22-35`）；`warmGroupInfo` 走 `botRef.getMemberList` 且**只认 `role === 'owner' | 'admin'`**（`:100-102`）——**这不是群成员全量缓存，只缓存群主与管理员**。
- 群成员画像在另一层：`appendMemory(st, 'memberImpression', …)`（`memory.js:479-498`），落 `social-state.json`，注入见 `formatMemory`（`memory.js:420-429`）。
- 日志：`[memory] 群列表拉取失败…`、`[memory] 群名主接口失败(…)，已用群列表回退拿到「…」`、`[memory] 群信息拉取失败`。

### 7.6 `[Recall]` 注入的位置是有讲究的

永久层 / 高重要度记忆的短摘要在**唤醒正文**里（`[Recall]` 行，`memoryDigest({ uid, limit: 14, maxChars: 700 })`，`wake-send.js:479`），**不放在系统提示词里**：

> 系统提示词一旦变化就会**整段前缀缓存失效**（那一步全价重读几万 token）。摘要放在唤醒正文这个"每轮本来就新"的位置，代价只是它自己那几百字符。

`memoryDigest` 内层 clamp：`limit` 夹 `1..30`（默认 12）、`maxChars` 夹 `120..4000`（默认 700），单行 `slice(0, 140)`（`memory.js:703-731`）。

这直接对应 [COMPACTION-MATH.md](COMPACTION-MATH.md) 的核心结论。

### 7.7 失败与降级

| 场景 | 行为 | 证据 |
| --- | --- | --- |
| 记忆库不可用 | `initMemoryDb` 返回 null，各函数早退 `{ok:false,error:'记忆库不可用'}` | `[memory] SQLite 初始化失败（不影响主流程）: …`（`memory.js:77`） |
| 聊天库不可用 | 读接口 `{ok:false,error:'聊天记录库不可用'}`，写静默 return | `[chat-db] 初始化失败…`（`:142`）、`[chat-history] 写入失败: …`（`:663`） |
| FTS5 不可用 | 退回 LIKE | `[memory] mem_fts 全文索引不可用…退回 LIKE`（`:146`）；`chatDbStats().fts.ok = false`、`memoryStats().ftsMem = -1` |
| 查询短于 3 字 | `ftsQueryOf` 返回 `''` → LIKE | 返回体无 `ranked` 字段 |
| 加列/索引/触发器失败 | 逐步 try/catch 只记日志 | `[memory]` / `[chat-db]` 前缀的「加列失败（忽略）」「索引创建失败」「触发器创建失败（忽略）」 |
| 迁移条数不一致 | 保留老表下次重试 | `[chat-db] 迁移条数不一致（老库 X / 新库 Y）…下次启动重试`（`:260`） |
| 计数漂移 | 启动自检不一致 → `setTimeout(…, 0)` 全量重算 | `[chat-db] 会话与总量计数已重算（N 条 / M 个会话）`（`:307`） |
| 索引落后 | 版本水位不符时启动重建 | `chat_meta.fts_version='1'` / `memory_meta.fts_version='2'`；`fts.complete = indexed === counters.total` |

### 7.8 未验证

- `state/memory.db.pre-v13-backup`（7.5 MB）在全仓 grep 无任何引用，**产出者未验证**。
- 实测 `chat_messages.ts` 存在两种格式（早期 `2026-08-31 19:22:23`，较新 `2026-09-08 周二 08:42:59`），`date` 过滤仍成立，但**格式不一致的成因未验证**。

---

## 8. 学习（黑话 / 人格 / 画像）

三条学习线共用一套基础设施：**独立的学习会话**（DSH 侧另开 workspace + session，不复用聊天会话）、**独立的学习令牌**、**共享的语料入口**（`qq_learning_corpus` 工具，或桥侧旧采样通道）、**共享的配置与状态文件**。相关模块：

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `qq-bridge/src/core/persona-learn.js` | 1136 | 人格学习：取样 → 学习会话 → 产出 JSON → 落库 → 人设草稿与审批 |
| `qq-bridge/src/core/persona-text.js` | 153 | 把结构化画像组装成一段中文人设文本（去重、排序、截断） |
| `qq-bridge/src/core/slang.js` | 829 | 黑话学习：窗口、抽取、研究、夜间定时、水位 |
| `qq-bridge/src/slang-learner.js` | 360 | 黑话词条的数据结构、去重键、状态机、提示词构造与解析 |
| `qq-bridge/src/core/portrait-learn.js` | 257 | 群友画像：按活跃度选人 → 复用 persona 通道 |
| `qq-bridge/src/core/learning-token.js` | 63 | 学习令牌的生成与校验 |
| `qq-bridge/src/lib/preset-compose.js` | 143 | 把人设/发言规则合成进 preset（`.agent-presets/qq-chat/agent.cordis.yml`） |
| `qq-bridge/src/mcp-host-server.js` | 344 | 学习会话可见的两个工具：`qq_learning_corpus`、`qq_learning_submit` |

### 8.1 学习会话如何被创建

`ensurePersonaLearnerSession()`（`persona-learn.js:116-149`）：

```js
const dir = path.join(STATE_DIR, 'persona-agent');                        // workspace 目录
const wsValue = unwrap(await apiRef.workspace.create({ path: dir }), 'persona workspace.create');
if (wsValue.created && workspaceTitle) await apiRef.workspace.rename({ workspaceId, title: workspaceTitle });
const params = { workspaceId: wsValue.workspace.workspaceId };
const preset = cfgRef?.persona?.learnerPreset || cfgRef?.agentPreset || undefined;
if (preset) params.agentPreset = preset;
const value = unwrap(await apiRef.sessions.create(params), 'persona session.create');
```

- workspace 标题取 `cfgRef.persona.workspaceTitle`（默认 `PersonaAgent`）；黑话侧对应 `slang.workspaceTitle`（默认 `SlangAgent`）。
- 会话 id 落盘 `state/persona-agent.json` / `state/slang-session.json`；复用顺序是「内存 → 文件 → 新建」。
- `unwrap` 判定：`response.result.ok` 为真返回 `result.value`，否则抛 `Error(\`${label} failed: ${code}: ${message}\`)`（`dsh-client.js:96-100`）。
- 会话创建后登记进 `learnerSessions` 并 `markPersistentLearner(sessionId)`，避免被会话归档器回收。
- 首轮任务说明 `ensurePersonaBrief(sessionId)`（`:154`）用 `mode: 'queue'` 注入一次（`PERSONA_BRIEF_VERSION = 5`、标记 `[PERSONA RUN]`），等待 turn 用 `PERSONA_TURN_TIMEOUT_MS = 300000`；**首轮说明等待超时不阻塞**，只记一行日志继续发本轮提醒。黑话侧对应 `SLANG_BRIEF_VERSION = 3`、标记 `[SLANG RUN]`。
- **投递模式与聊天不同**：学习链路仍用 `mode: 'queue'`（`persona-learn.js:158, 623`、`slang.js:134`），而聊天投递已定调只用 `mode: 'steer'`（`prompt-deliver.js:144-162` 详述原因：`queue → agent.followup → next-turn` 在当前回合永不结束时会永久搁浅）。

### 8.2 语料来源

**模型侧入口** `qq_learning_corpus`（`mcp-host-server.js:142-196`）：

| 参数 | 语义 |
| --- | --- |
| `sinceMs` | 起（含），默认最近 24 小时 |
| `untilMs` | 止（含），默认 now |
| `limit` | 默认 400，上限 800 |
| `convKeys` | 限定会话，≤50 个；省略时只查 `conv_key LIKE 'group:%'` |
| `targetUid` | 只看某人发的（人格学习用） |

```sql
-- 基础段（逐字）
direction = 'in' AND is_self = 0 AND kind IN ('text','qqface') AND content <> '' AND ts_ms >= ? AND ts_ms <= ?
  AND content NOT LIKE '/%' AND content NOT LIKE '[CQ:%' AND content NOT LIKE '[转发%'
SELECT conv_key, sender_uid, sender_name, content, ts_ms FROM chat_messages WHERE … ORDER BY ts_ms ASC, id ASC LIMIT ?
```

库选择：`state/chat.db` 优先，缺失回退 `state/memory.db`，都没有才报错；以 `readOnly: true` 打开。返回 `{ok,count,sinceMs,untilMs,nextSinceMs,hint,messages:[{t,who,uid,conv,text}]}`，`text` 去换行并截 200；取满 `limit` 时给 `nextSinceMs = last + 1`。

**桥侧旧采样通道**（当前**已损坏**，见 §19.2）：`collectTargetSamples(uid, opts)`（`persona-learn.js:222`）在 `initMemoryDb()` 的连接上查 `chat_messages`（`:238` / `:243`），两条 SQL 分别是 `ORDER BY ts_ms DESC, id DESC LIMIT 160` 与 `ORDER BY random() LIMIT 200`。样本上限 `SAMPLE_TOTAL_CAP = 300`、`SAMPLE_RECENT_CAP = 160`、`SAMPLE_RANDOM_CAP = 200`、每会话 `SAMPLE_PER_CONV_CAP = 60`、单条 `SAMPLE_TEXT_CAP = 120`；去重键 `${ts}|${text}`；跳过规则 `isSampleSkip`（空、`/` 开头、纯 CQ 码、`[转发/聊天记录/合并转发` 开头、角色扮演开关句）。

### 8.3 人格学习：产出格式与归一化

任务说明 `buildPersonaTaskBrief()`（`:329-370`）要求模型返回的 JSON 键：`nickname`、`addressTerms`、`catchphrases[{phrase,context}]`、`emojiHabits`、`style{sentenceLength,rhetoricalQuestions,toneWords,examples[]}`、`personality[]`、`chatHabits`、`topics[]`、`taboos[]`、`relationshipAdvice`、`personaEn`（唯一英文段，150-400 词，禁中文）。

`normalizePersona(raw)`（`:404-452`）逐字段截断：`nickname 40` / `addressTerms 200` / `emojiHabits 200` / `chatHabits 400` / `relationshipAdvice 600` / `topics` 与 `taboos` 各最多 10 项 / `catchphrases` 最多 20 条（`phrase 60`、`context 120`）/ `style.sentenceLength` 与 `rhetoricalQuestions` 各 60 / `toneWords 100` / `examples` 5 条 × 80 / `personality` 最多 6 项、`；` 连接后 `slice(0, PERSONALITY_MAX = 1200)` / `personaEn` 走 `cutPersonaEn(…, PERSONA_EN_MAX = 6000)`（在 `.!?\n` 处截，且截点 `>= floor(max/2)` 才截）。

`parsePersonaJson(text)`（`:454-474`）：剥 ```json 围栏 → 取首个 `{` 到末个 `}` → 尾逗号容错 `c.replace(/,\s*([}\]])/g, '$1')`。

### 8.4 人格文本的组装（`persona-text.js`）

- 句切分 `splitSentences`：先按 `/\n+/` 拆行，再按 `(?<=[。！？!?；;])` 断言切分（**保留标点**）。
- 去重键 `keyOf`：剔除 `[\s，,。、；;：:！!？?～~""''（）()【】\[\]—\-]` 后比较。收录规则：归一化键长度 `< 4` 丢弃；与任何已收录项**双向子串包含**即整句丢弃。
- 组装顺序（`:85-127`）：① 昵称与称呼 ② `personality` ③ style 合成句（`说话[偏]<sentenceLength>，语气上<toneWords>`，反问 `^y` →「爱反问」、`^n` →「很少反问」，样例句最多 4 条）④ `chatHabits` ⑤ `emojiHabits` ⑥ 口头禅最多 6 条 ⑦ `topics` 最多 6 项 ⑧ `taboos` 最多 4 项 ⑨ `relationshipAdvice`。
- 截断：`PROFILE_MAX = 4000`；`slice(0, 4000)` 后回退到最后一个 `。`/`！`/`？`，仅当回退点 `> PROFILE_MAX * 0.5` 时才在句末收尾，否则返回空串——**宁可少一句也不留半句**。
- `cleanNickname`：剪掉吊尾「被…称为/叫做/简称」、句末标点后内容、未闭合括号，最后 `slice(0, 40)`。

### 8.5 人格学习的落盘与生效路径

| 落点 | 代码位置 | 生效方式 |
| --- | --- | --- |
| `profiles.personality`（`memory.db`） | `setProfileField(uid, 'personality', profileText)`（`persona-learn.js:520` → `memory.js:267-285`，cap 4000） | 唤醒正文 `formatProfileText` 的 `Personality:` 行（`memory.js:292`）拼进 `[Profile]`（`wake-send.js:486`） |
| `state/persona-library.json` | `personaLibrary[uid] = {...}` + `savePersonaLibrary()`（`:526-548`） | 管理端档案页（`server/index.js:8670`）、`/api/learning/persona` status |
| `memory_entries`（`category='persona'`） | 先 `DELETE … category='persona'` 再 INSERT 一条摘要（`:554-556`） | 管理端 `personaSummary`（`server/index.js:8779`） |
| `persona.md` | 只在审批动作 `personaApply(mode='apply')` 里写（`:737` `atomicWriteText`） | 两条路：① preset 合成段（`preset-compose.js` → `.agent-presets/qq-chat/agent.cordis.yml`）；② 唤醒正文 `[PERSONA]` 运行时注入（`wake-send.js:311-326`，上限 `RUNTIME_OVERRIDE_MAX['persona.md'] = 16000`、保尾 2500） |
| 备份 | `persona.md.bak-<yyyyMMdd-HHmmss>`（北京时间，`:851-855`），最多 5 份（`PERSONA_BACKUP_KEEP = 5`，匹配 `PERSONA_BACKUP_RE`） | 仅供回滚 |

防退化：`mergePersonaProfileText(prevText, nextText)`（`:493-503`）——旧文长度 ≥ `KEEP_OLD_MIN = 60` 且新文 `< max(60, prev * 0.5)` 时保留旧文（旧文不含新文则拼接后 `slice(0, 4000)`）。

审批接口 `personaApply(uid, mode, text)`（`:682-749`）：

- `mode='save'` 只写 `personaEn` 与 `personaEditedAtMs`；
- `mode='apply'` 覆盖 `persona.md`，**拒绝含中文**（`/[\u4e00-\u9fa5]/` 直接拒，`:710`），保持文件权限位，回写 `personaAppliedAtMs`；`uid` 不在 `personaLibrary` 中直接拒；
- `mode='fuse'` 走 `personaFuseDraft`（`:765-835`），只出草稿不写盘，且只用**已注入的** persona 学习会话。

### 8.6 黑话学习

**词条结构**（`normalizeSlangEntry`，`slang-learner.js:36-57`）：`id`（`Date.now().toString(36) + '-' + random`）、`content`、`meaning`、`usage`、`example`、`risk`、`sources`（**保留最后 10 条**）、`status`、`source`（`manual` / `ai`）、`count`、`evidence`（保留最后 20 条）、`lastInferenceCount`、`createdAt`、`updatedAt`。对外 `publicSlangEntry` 只暴露 `id,content,meaning,usage,example,risk,status,source,count,evidence(最后 5 条),updatedAt`。

**状态机取值**（`SLANG_STATUS`，`slang-learner.js:15-19`）：`candidate` / `confirmed` / `rejected`。状态**只能往上走**：`upsertSlangEntry` 在已有条目 `status !== 'candidate'` 而 patch 想写回 `candidate` 时删掉 patch 里的 status。

**学习引擎状态**（`slangLearningState().phase`，`slang.js:637-642`）：`'idle'` → `'disabled'` → `'extracting'` → `'stopping'` → `'queued'` → `'researching'` → `'ready'`（按此顺序判定）。返回还含 `enabled, inFlight, queuedOps, stopRequested, researching, learnerSessionActive, lastLearnAtMs, counts{candidate,confirmed,rejected,total}`。

**去重键** `slangKey`（`:110-117`）：trim → 去所有空白 → 去尾部 `[！!。.、，,~～?？…]+` → 全角转半角 → `toLowerCase()`。

**查询与提交**（agent 侧）：`qq_slang_query`（`mcp-napcat-safe.js:1663`）→ `GET /api/social/slang/query`，返回 `{ok,key,total,entries,block}`；`qq_slang_submit`（`:1682`）→ `POST /api/social/slang/submit`，`content` 上限 50 字由桥侧拦；`confirmed` 重复 → `{ok:true,duplicate:true}`；命中 `rejected` → 403「该词已被管理员拒绝」；`candidate` → `count + 1` 并按 `inferenceThresholds`（默认 `[2, 4, 8]`）命中且 `count > lastInferenceCount` 时排队研究。

**注入提示词**：`withSlangContext(promptText)`（`slang.js:400-409`）受 `slang.injectIntoPrompt` 控制，**默认 `false`（不注入）**，改为模型按需调 `qq_slang_query`。注入时筛选 `status === 'confirmed' && content && meaning`，按 `count` 降序，文案头 `[群聊黑话表]群里已确认/常用的网络用语和梗（按出现次数排序，知道即可，不要刻意堆砌）：`；`injectMax` 现场值 8，但 `confirmedSlangList` 默认 8、`withSlangContext` 默认 5，**三处默认不一致**。

**窗口与定时**：`slangWindows` 每会话窗口上限 80 条（`slang.js:355`）；`NIGHTLY_TICK_MS = 60 * 1000`、`MAX_LEARN_BLOCKS = 3`、`MAX_LEARN_MSGS = 2400`、`MAX_BLOCK_MSGS = 800`、`LEARN_TURN_TIMEOUT_MS = 5 * 60 * 1000`、`NIGHTLY_RETRY_MS = 5 * 60 * 1000`、`SLANG_MANUAL_LOOKBACK_MS = 24 * 3600 * 1000`。手动触发窗口 `sinceTsMs = marker > 0 ? Math.min(marker + 1, Date.now() - 24h) : Date.now() - 24h`；群范围 = `cfg.allow.groups` 减 `deny.groups` 映射成 `group:<gid>`。失败会清 `lastFiredNightlyDate` 允许当天补跑，水位不前进时受 5 分钟节流重试。

**落盘**：`state/slang.json`（原子写：临时文件 `${file}.${pid}.${6 hex}.tmp` → rename，`mode 0o600`）、`state/slang-session.json`、`state/learning-config.json`（水位 `slang.lastLearnAtMs`）。

**会话失效判定** `isLearnerSessionGone(message)`（`slang.js:58-63`）：**超时/`timeout` 一律返回 false**；只有 `not found|no such session|unknown session|invalid session|404|会话(不存在|已失效|无效)` 才算会话真没了——这是 2026-09-11 事故的修法（超时被误判为会话失效会导致反复重建会话）。

### 8.7 群友画像（portrait）

三条触发入口：

1. 定时：`initPortraitLearn()` 注册 `PORTRAIT_TICK_MS = 60 * 1000`；`checkPortraitAutoTick()` 判定 `dueNightly`（`timeHHMM` 北京时）或 `dueInterval`（`autoIntervalEnabled && (lastRunAtMs === 0 || now - lastRunAtMs >= autoIntervalHours * 3600000)`）；定时失败节流 5 分钟，未受理则 30 分钟退避。
2. HTTP：`POST /api/learning/portrait {action:'start'|'stop'|'status', qq?}`（`console-server.js:5859-5887`）。
3. 文本指令 `/portrait learn|stop|status`（`handlePortraitLearnCommand`），非主人回「画像学习只有主人能指挥。」。

参数（`PORTRAIT_DEFAULTS`，`portrait-learn.js:18-27`）：`enabled: true`、`minMessages: 10`、`maxTargets: 20`、`windowHours: 720`（30 天）、`autoIntervalEnabled: false`、`autoIntervalHours: 24`、`timeHHMM: ''`、`lastRunAtMs: 0`；夹紧区间 `minMessages 1~5000`、`maxTargets 1~200`、`windowHours 1~8760`、`autoIntervalHours 1~720`。

按活跃度取人 `eligiblePortraitTargets`（`:83-108`）：

```sql
SELECT sender_uid AS uid, COUNT(*) AS n, MAX(ts_ms) AS last
  FROM chat_messages
 WHERE is_self = 0 AND sender_uid <> '' AND (recalled_at IS NULL OR recalled_at = 0)
   AND ts_ms >= ? AND TRIM(COALESCE(content, '')) <> ''
 GROUP BY sender_uid HAVING n >= ? ORDER BY n DESC LIMIT ?
```

**这条 SQL 同样查错了库（见 §19.2），当前必然失败。** 画像写入的目标与 persona 完全复用同一通道（`profiles.personality`、`persona-library.json`、`memory_entries(category='persona')`）；`chat_messages` 只读不写。

### 8.8 学习令牌

- 生成 `ensureLearningToken()`（`learning-token.js:30-52`）：`crypto.randomBytes(16).toString('hex')`（32 hex），落 `state/learning-token`，`mode: 0o600`，内容带尾换行（实测 33 B）；写盘失败仍返回令牌（重启即轮换）并记 `学习令牌落盘失败（重启后会轮换）: …`。
- 校验 `isValidLearningToken(token)`：正则 `/^[a-f0-9]{32}$/i` + 长度相等 + `crypto.timingSafeEqual`。
- 唯一消费端点：`POST /api/learning/submit-persona`（`console-server.js:5894-5899`），403 文案「该接口需要有效的学习令牌（见 state/learning-token，或本轮学习提醒里给的那串）」。
- 令牌在每轮学习提醒里重带：`buildPersonaRunCue` 写 `call mcp__napcat-host__qq_learning_submit with token="…", uid="…", samples=<n>, payload=<the JSON object>`。`qq_learning_corpus` **不需要令牌**。
- 脱敏隔离：令牌进 `LEARNER_AGENT_TOKENS`，**故意**不进 `KNOWN_AGENT_TOKENS`——否则发给学习会话的令牌会顺带通行 `/api/profile`、`/api/blacklist`、`/api/social/deepsleep`、`/api/social/schedule*`。
- 生命周期：跨重启稳定（以文件为准），**无轮换周期、无过期、无撤销接口**；`LEARNER_AGENT_TOKENS` 是累加集合，旧令牌只留在脱敏集合、不再被校验接受。

### 8.9 学习配置与接口

`DEFAULT_LEARNING_CONFIG`（`console-server.js:285-303`，逐字）：

```js
slang:    { enabled: true, timeHHMM: '00:00', autoResearch: true, liveWindowExtract: false, lastLearnAtMs: 0, autoIntervalEnabled: false, autoIntervalHours: 24 }
persona:  { enabled: true, targetQQ: [], autoIntervalEnabled: false, autoIntervalHours: 24, timeHHMM: '', lastRunAtMs: 0 }
portrait: { enabled: true, minMessages: 10, maxTargets: 20, windowHours: 720, autoIntervalEnabled: false, autoIntervalHours: 24, timeHHMM: '', lastRunAtMs: 0 }
```

| 端点 | 位置 | 行为 |
| --- | --- | --- |
| `GET|PUT /api/learning-config` | `console-server.js:5669` / `5673` | PUT 只认 `slang/persona/portrait` 三段的白名单键；水位键 `slang.lastLearnAtMs`、`persona.lastRunAtMs` **不在白名单**，PUT 无法覆盖 |
| `POST /api/learning/slang` | `:5686` | `action:'learn'|'stop'` |
| `POST /api/learning/persona` | `:5710` | `action:'start'|'stop'|'status'`；`qq` 必须 `^\d{1,11}$`、去重、≤50 |
| `POST /api/learning/persona-apply` | `:5816` | `mode:'save'|'apply'|'fuse'` |
| `POST /api/learning/portrait` | `:5859` | `action:'start'|'stop'|'status'` |
| `POST /api/learning/submit-persona` | `:5894` | 学习令牌校验 → `recordPersonaSubmit` |
| `GET /api/slang` 及 `/api/slang/*` 管理端点 | `:832` 起 | 词条增删改、批量确认/拒绝/研究 |

管理端（`server/index.js`）是这些端点的代理：`/api/learning/config`（`7598-7599`）、`/api/learning/slang`（`7600`）、`/api/learning/persona`（`7601`）、`/api/learning/portrait`（`7602`）、`/api/learning/persona-apply`（`7650`，timeout 180000，因为 fuse 要跑模型）、`/api/learning/profile`（`8769`，直读 `memory.db`）、`/api/learning/graph`（`8933`）、`/api/learning/owner-profile`（`9052`）、`/api/learning/messages`（`9101`）、`/api/learning/groups`（`9147`）、`/api/learning/relations`（`9184`）。

**两套画像配置互不相通**：管理端 `GET|PUT /api/learning/portrait-config`（`server/index.js:9136-9144`）用的是 `CONFIG_DIR/portrait-config.json`，字段只有 `{enabled, intervalDays(1~90, 默认 7), lastAt}`；桥侧 `learning-config.portrait` 是另一份（`minMessages/maxTargets/windowHours/…`）。改一处不影响另一处。

### 8.10 失败与降级

| 场景 | 行为 / 返回 | 证据 |
| --- | --- | --- |
| DSH 未就绪 | persona `{started:[], disabled:false, error:'DSH_NOT_READY'}`；slang `reason:'dsh-unready'`；投递入队 `{ok:true, queued:true}` | `persona-learn.js:883`、`slang.js:672`、`prompt-deliver.js:115` |
| 学习开关关闭 | persona `{started:[], disabled:true}`；slang `reason:'disabled'` | `persona-learn.js:885`、`slang.js:600` |
| 已有任务在跑 | slang `reason:'busy'`；portrait `{busy:true}` | `slang.js:678`、`portrait-learn.js:117` |
| 无样本 | `{ok:false, error:'近 N 天没有找到 <uid> 的发言记录（direction=in 且 text/qqface）'}` | `persona-learn.js:602-605` |
| 学习会话创建失败 | `{ok:false, error:'学习会话创建失败：…'}` | `:610-613` |
| 首轮说明 turn 不闭合 | **不阻塞**，只记 `…首轮任务说明等待超时（继续发本轮提醒）：…` | `:160-164`、`slang.js:136-139` |
| turn 超时（300 s） | 先查迟到回执：命中 → `via:'tool'` + `warning`；否则失败 | `:184-198`、`:657-663` |
| 模型既没调工具、文本也不是 JSON | `{ok:false, error:'模型既未调用 qq_learning_submit，输出也无法解析为 JSON 档案'}`，日志带输出前 200 字 | `:645-647` |
| 会话真失效 | 才 `invalidatePersonaLearnerSession()`（删 `state/persona-agent.json`）；**超时不算** | `slang.js:58-63`、`persona-learn.js:654-656` |
| 整批全失败（自动间隔） | **不推进** `lastRunAtMs`，设 30 分钟退避，日志 `[persona] 自动间隔学习本轮 N 个目标全部失败，不推进 lastRunAtMs（30 分钟后重试）` | `:907-913` |
| 画像自动选人失败 | 30 分钟退避，日志 `[portrait] 自动学习未受理（…），30 分钟后重试` | `portrait-learn.js:186-191` |
| 覆盖人设失败 | `{ok:false, error:'覆盖机器人人设失败（…）：persona.md 保持原样，可稍后重试'}` | `persona-learn.js:740-743` |

可观测证据：`state/bridge.log` 中的 `人格学习` / `[persona]` / `[portrait]` / `[slang]` / `[preset]` / `[dsh-side]` 前缀；落盘 `state/learning-config.json`、`state/learning-token`、`state/slang.json`、`state/slang-session.json`、`state/persona-library.json`、`state/persona-agent.json`、`persona.md` 与 `persona.md.bak-*`。本机实测：`slang.json` 73,746 B、`learning-token` 32 hex、`learning-config.json` **只有 `slang` 与 `persona` 两段**（无 `portrait` 段，故 portrait 全走默认值）、`persona-library.json` 与 `persona-agent.json` **不存在**。

---

## 9. QQ 空间

QQ 空间侧五个工具（`qq-bridge/src/mcp-napcat-safe.js`）：`qq_qzone_view`（:2536）、`qq_qzone_comment`（:2578）、`qq_qzone_reply_comment`（:2617）、`qq_qzone_like`（:2662）、`qq_send_qzone`（:2702）。配图管线在 `qq-bridge/src/lib/qzone-image.js`（297 行），主动发说说在 `qq-bridge/src/core/qzone.js`（44 行）。

### 9.1 发说说：`file` 与 `images` 的参数名坑（已修）

旧代码给 NapCat 传的是 `file`，而 **NapCat 的 `SendQzoneMsg._handle` 只读 `e.images ?? []`** —— 该参数一直被静默忽略：配了图也发不出来，**而且不报错**（`lib/qzone-image.js:16-17`、`mcp-napcat-safe.js:2742-2743`）。

现行写法（`mcp-napcat-safe.js:2744-2746`）：

```js
const body = { content: text };
if (prepared.length) body.images = prepared.map((p) => p.arg);
onebot('send_qzone_msg', body);
```

同时修了 tid 取值：`data?.tid ?? data?.data?.tid ?? null`（:2749，旧写法多套一层导致 tid 恒为 null）。`core/qzone.js:25-26` 的 `postRandomQzone` 仍然只发 `{ content }`（不带图，不是坑）。

### 9.2 配图管线

| 常量 | 值 | 位置 |
| --- | --- | --- |
| `QZONE_IMAGE_MAX` | `3` | `qzone-image.js:45` |
| `QZONE_IMAGE_TMP_MAX_AGE_MS` | `3 * 60 * 60 * 1000` | `:48` |
| `QZONE_TMP_NAME_RE` | `/^qzone-\d{10,}-[0-9a-z]{4,}\.(?:jpe?g\|png\|gif\|webp)$/i` | `:52` |

`clampQzoneImageCount(n)`（:55）：非法或小于 1 → 1，封顶 3。`qzoneImageTmpDir(cfg, root)`（:62）：优先 `cfg.napcat.tmpDir`，否则 `<root>/state/qzone-img-tmp`。

`prepareQzoneImageArg(buf, cfg, opts)`（:106）：字节 ≤ 10 MB（`DEFAULT_BASE64_MAX_BYTES`）→ 走 `base64://`、`mode:'base64'`、**零落盘**（:113-115）；否则落 `qzone-<Date.now()>-<6hex>.<ext>`、`mode:'file'`，返回 `cleanup()`（:124-129），调用方在 `finally` 里必删（`mcp-napcat-safe.js:2760-2762`）。`sweepQzoneImageTmp(dir, maxAgeMs = 3h, now)`（:142）**只删自己命名的形状**（不按目录清空，因为该目录可能是与表情/文档共用的容器挂载目录，:137-140）；启动清扫调用点 `mcp-napcat-safe.js:2448-2455`。

**体检** `verifyQzoneImage(buf, info)`（:84）：先 `verifyImageComplete(buf, info.contentLength ?? null, info.contentEncoding ?? null)`（FFD9 / IEND / 0x3B / RIFF 长度 + content-length 对账，见 `safe-fetch.js:286`），再 `sniffQzoneImageExt`（PNG/JPEG/GIF/WebP 魔数）；不完整 → `{ok:false, reason: complete.reason || '图片字节不完整'}`；认不出格式 → `'认不出图片格式（魔数不是 PNG/JPEG/GIF/WebP）'`；宽高拿不到不拦。

**来源优先级** `collectQzoneImages(opts)`（:170）：**`file` > `imageUrl` > `pixivIllustId`/`pixivQuery` > `imageQuery`**（:167，工具描述 `mcp-napcat-safe.js:2707`）。本地 `file` 直接 `fs.readFileSync` 后过同一道体检（:243-258，注释说明这条字节没经过 `safeFetchBuffer`）；安全下载统一走 `safeFetchBuffer(url, MAX_IMAGE_FETCH_BYTES, referer ? { referer } : null)`（:188），并对 pixiv 做档位像素对账（:191-201）；pixiv 走 `planPixivSend` 分桶，跳过的档打 stderr，原图档全失败才降级并记 `tierFallback = { to, reason, originalTried }`（:222-237）；**R-18 作品明确排除**（:275-277，note「是 R-18，不配进公开说说」）；联网搜图用 `searchImages(imageQuery, { limit: Math.max(8, index + want + 2) })`（:286）；返回 `{ requested, want, items, notes, tried: tried.slice(0,5) }`。

**工具输出**（`mcp-napcat-safe.js:2749-2758`）：`{ ok, tid, content }` + `images[]`（每项含 `from/url/title/bytes/pixels/tier/fetchedVia/handedToNapCatAs/tierFallback`）+ `imageNotes` + `imageFailures`。`handedToNapCatAs` 取 `base64` 或 `file`，即"这一张最终以什么形态交给了 NapCat"。

### 9.3 主动发说说（`qq-bridge/src/core/qzone.js`）

`initQzoneCore(cfg)`（:6）与 `postRandomQzone()`（:8）：从内置的 10 条说说池（:12-23）里随机取一条，`POST ${napcatBase}/send_qzone_msg`（`AbortSignal.timeout(15000)`，:30）；成功后写一条记忆 `memory_entries`，`category = 'qzone_post'`（:39-40），日志 `[qzone] 主动发说说成功`（:43）。**该路径不带图**。

### 9.4 失败与可观测

- 配图全失败 → 退化成纯文字说说，并把 `notes` / `tried` 原样回报（`qzone-image.js:166/295-296`）。
- 日志 tag：`[qzone]`（`qzone.js:43`）、`[qzone-image]`（`qzone-image.js:128/131`）。
- 落盘：临时图目录 `state/qzone-img-tmp`（或 `napcat.tmpDir`），记忆条目落在 `state/memory.db` 的 `memory_entries`（`category='qzone_post'`）。


---

## 10. 群 / 好友 / 权限

| 工具 | 注册行 | 做什么 | 权限约束 |
| --- | --- | --- | --- |
| `qq_list_groups` | `mcp-napcat-safe.js:854` | 群号 → 群名 | |
| `qq_get_group_members` | `mcp-napcat-safe.js:882` | 群成员 | |
| `qq_get_group_owner` | `mcp-napcat-safe.js:902` | 群主 | |
| `qq_get_group_history` | `mcp-napcat-safe.js:922` | 取群历史消息 | |
| `qq_whitelist` | `mcp-napcat-safe.js:2380` | 增删群/好友白名单 | 仅管理员私聊 |
| `qq_blacklist` | `mcp-napcat-safe.js:2342` | 拉黑 | **不能拉黑管理员** |
| `qq_admin_set` | `mcp-napcat-safe.js:2361` | 增删管理员 | 仅管理员私聊 |
| `qq_set_system_config` | `mcp-napcat-safe.js:1213` | 改系统配置键 | 仅管理员私聊 |
| `qq_get_system_config` | `mcp-napcat-safe.js:1199` | 读系统配置 | |
| `qq_remove_friend` | `mcp-napcat-safe.js:2399` | 删好友 | **不能删除管理员**；主人不可删 |
| `qq_like` | `mcp-napcat-safe.js:2013` | 给别人的资料卡 / 说说点赞 | |
| `qq_profile_get` / `qq_profile_set` | `2298` / `2316` | 读写某人结构化档案 | |

白名单语义（`qq-bridge/src/lib/config.js` 的 `allowed()`）：

- `allow.private` / `allow.groups`（兼容旧键 `privates` / `group`）
- `deny.private` / `deny.groups`，**deny 优先于 allow**
- `allowAllWhenEmpty`（两边空名单时放行所有，**启动会打警告**）
- **分侧放行**：`allowAllPrivate` / `allowAllGroups`（某类名单为空时单独放开那一类，常见于"群严、私聊松"）。这两个键恒为布尔——界面按"配置里存在的键"渲染，不给默认值的话勾选框不会出现

现场 `qq-bridge/config.json`：`ownerQQ: 1736784911`、`allow.groups` 3 个群、`allowAllWhenEmpty: true`。

好友请求自动审批：`bridge.js:616-629`，`deny.private` 名单里的拒绝，其余同意；开关 `social.autoFriendApproval: false` 可关。

**自动好友守卫**：私聊里非主人/非受信任者发来违法或诈骗营销内容时，自动删除好友并拉黑，并私聊告知主人（`mux.js` 的 `ALARM_RE` 分支，开关 `social.autoFriendGuard`）。

**会话准入在唤醒侧还有第二道闸**：`sendWakePrompt` 第 3 步 `!isSessionAllowedInCurrentMode(key)` 直接 return，日志 `[default] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`（`wake-send.js:1281-1284`）。

---

## 11. 角色库

四个工具都是**只读**的，不会改动人设文件。

| 工具 | 注册行 | 做什么 |
| --- | --- | --- |
| `qq_character_list` | `mcp-napcat-safe.js:4601` | 列角色包（一个包 = 一个目录）；也给单个包列文件 |
| `qq_character_read` | `mcp-napcat-safe.js:4617` | 读包里的**一个**文件（默认 `SKILL.md`，回落顺序 `manifest.json` → `ULTIMATE_ROLEPLAY_PROMPT.md` → `personality.md`） |
| `qq_character_pack` | `mcp-napcat-safe.js:4634` | 一次返回**整个**角色包（核心文档按序拼接） |
| `qq_character_search` | `mcp-napcat-safe.js:4650` | 全库关键词检索（只给片段，不给全文） |
| `qq_character_switch` | `mcp-napcat-safe.js:4665` | 切换当前角色 |

要点：

- **从 `SKILL.md` 开始读**：每个包的可扮演定义都在那里（人设语气、口头禅、关系图、能做/不能做）。
- 字节上限：`qq_character_read` 默认 32KB（硬上限 131,072）、`qq_character_pack` 默认 24KB（可放宽到 128KB）。截断会**如实说明**砍了哪个文件的哪部分。
- 角色库根目录 = `social.charactersDir`；未设时是 `~/Downloads/characters/characters`（存在的话），否则随包目录 `<install>/resources/runtime/qq-bridge/characters`。
- **只有导入 `persona.md` 的那一张卡会自动进提示词**，其余包不会。角色卡内容属本地参考，**不要整包贴进 QQ 聊天**。
- 出厂角色包 21 个 + 1 张散装卡（`qq-bridge/characters/`），说明见 `qq-bridge/characters/角色库说明.md`。
- 当前角色落盘 `state/current-role.json`。

管理端侧：`src/pages/GroupPortrait.tsx`、`src/pages/Learning.tsx`、`src/pages/NetCanvas.tsx`（关系图），接口 `/api/learning/profile`、`/api/learning/graph`、`/api/learning/relations`。

---

## 12. 定时、跨会话与静默

| 工具 | 注册行 | 做什么 | 生产上的坑 |
| --- | --- | --- | --- |
| `qq_schedule_message` | `mcp-napcat-safe.js:1101` | 定时/循环发消息（`at` ISO 时间或 `delayMs`，`repeatMs` 循环） | 落 `state/scheduled-tasks.json`，桥重启后 `loadScheduledTasks()` 恢复（`bridge.js:729`）。**报错说缺 key/token 时要看**：`qq_schedule_message` / `qq_schedule_list` / `qq_schedule_cancel` 是"只声明 token、不声明 key"的工具（`mcp-napcat-safe.js:552-634` 的包装层） |
| `qq_schedule_list` / `qq_schedule_cancel` | `1128` / `1142` | 查 / 取消定时任务 | 取消不存在的 id 会返回可用 id 列表 |
| `qq_crosschat_send` | `mcp-napcat-safe.js:1395` | 给另一个会话留言 | 落 `state/crosschat.json`；每 key 最多留 **10** 条，正文字段 `content.slice(0, 400)`；受 `social.trustedCrossSessionUids` 约束 |
| `qq_crosschat_inbox` | `mcp-napcat-safe.js:1417` | 读跨会话留言 | 接口最多回 5 条、正文 `slice(0, 300)`；注入每轮最多 **2** 条 |
| `qq_get_activity_hours` / `qq_set_activity_hours` | `1167` / `1181` | 活跃时段 | 落 `state/activity-windows.json`；`startActivityTick()` 定时推进（`bridge.js:732`） |
| `qq_deepsleep` | `mcp-napcat-safe.js:1263` | 深层静默 | 命中后群聊消息只写活动日志 |

### 12.1 定时任务的数据结构与重试

```js
const task = {
  id: crypto.randomBytes(8).toString('hex'),
  targetKey, message,
  at: Math.max(Date.now(), Number(at) || Date.now()),
  repeatMs: Math.max(0, Number(repeatMs) || 0),
  sourceKey, sourceUid,
  createdAt: Date.now()
};                                    // qq-bridge/src/core/scheduler.js:123-133
```

- 内存侧：`scheduledTimers: Map<taskId, timer>`、`scheduledRetries: Map<taskId, number>`（`scheduler.js:13-14`）。
- 持久化：`state/scheduled-tasks.json`（`SCHEDULED_FILE`，`scheduler.js:11`），`atomicWriteJson` 写入。
- 恢复 `loadScheduledTasks()`（`:86`）：先剔除无效项（`!t.targetKey || typeof t.message !== 'string'`）与已过期一次性任务并回写，日志 `[scheduled] 已清理无效/过期定时任务 N 个`；再逐条重排，日志 `[scheduled] 已恢复定时任务 N 个`。
- 触发 `fireScheduledTask(task)`（`:23`）→ `sendMessages(targetKey, [message], [], null, null)`；**回执落库失败不影响成功判定**（`:31-33`，注释指明否则会误触发 60s 重试导致连发 4 次）。成功且 `repeatMs > 0` → `task.at = Date.now() + task.repeatMs` 重排；否则移出数组。失败 → `task.at = Date.now() + 60000` 重试，`tries <= 3`；超限删除并 `sendToQQ(task.sourceKey, '定时消息发送失败（已放弃重试）：…')`。
- `parseScheduledAt(raw)`（`:104`）：纯数字 `< 1e12` 视为秒 → ×1000；带时区后缀走 `Date.parse`；`YYYY-MM-DD HH:MM[:SS]` 按 `Date.UTC(..., hh - 8, ...)` 当北京时间。

### 12.2 跨会话留言

- 结构：`{ id: crypto.randomBytes(6).toString('hex'), from, content (≤400), ts, read: false }`，每 key `slice(-10)`（`crosschat.js:61-62`）。
- 注入块 `buildCrossChatBlock(key)`（`crosschat.js:102`）产出两类行：
  - `[Mail] <describeCrossKey(from)>: <content.slice(0,160)>`
  - `[Other sessions] <label>: <who>: <body> - already handled; do not re-act unless asked or new.`（数据源 `recentMessagesAcrossSessions(key, { windowMs: 3600000, limit: 2 })`）
- 硬上限：`CROSS_BODY_MAX = 80`、`CROSS_LABEL_MAX = 40`、`CROSS_WHO_MAX = 16`，整行 `min(legacyLineMax(label), 170)`（`crosschat.js:95-124`）。
- 未读只标真正注入过的那几条（`markCrossMailsRead(key, ids)`，`:109-111`）——注释记录了"无条件全标已读会静默丢第 3 条及以后"的旧缺陷。
- 遗留：回合收尾写 ≤70 字摘要的 `pushCrossDigest` 写入路径**已删除**（`turn-guard.js:128-132`），老的 `digests` 字段读进来但不使用。
- 精简工具模式下这两个工具被显式拒绝：`social.slimTools.deny` 含 `mcp__napcat__qq_crosschat_inbox`、`mcp__napcat__qq_crosschat_send`（`qq-bridge/config.json:260-261`）。

### 12.3 活跃时段

- 结构：`{ key: [{ start: 分钟数(0-1439), end: 分钟数(可 > 1440 = 次日) }] }`（`activity.js:2`）。
- 落盘 `state/activity-windows.json`；**seed 语义**：文件缺失（首次运行）才写空表，文件存在但为空**绝不再 seed**，日志 `[activity] 首次运行：活跃时段表为空（不 seed 任何群，默认不限制）`；解析失败则 `[activity] 时段表文件损坏，重新 seed:`（`:19-29`）。
- `inActivityWindow` 用 `bjMinutes(now)`；跨午夜时 `e > 1440` → `(bj >= s && bj < e) || bj < e - 1440`；无时段返回 `null`。
- tick：`startActivityTick()` → `setInterval(..., 60000)` + `unref`（`:122-123`）。命中条件 `bj >= s && bj < s + 2`（窗口起点后 2 分钟内）且冷却 `activityWakeCooldown` 距今 `< 55 * 60 * 1000` 时不重复；已全活跃（`mode === 'active' || triggers.anyMessage === true || probability >= 0.3`）则跳过；否则 `sendWakePrompt(key, 'activityStart')`。
- 注入 `activityStatusLine(key, fullActive)`（`:82`）只在群、非 fullActive、且有窗口时返回。
- 校验（`console-server.js:4645-4684`）：`key` 必须 `^(group|private):\d+$`；`end <= start` → `e += 1440`；单段 `> 1440` 分钟报 `单个活跃时段不能超过 24 小时`；空数组 → `delete activityWindows[key]`。

### 斜杠命令（桥直接执行，不经过模型）

`qq-bridge/src/core/mux.js` 命令分支（`handleIncoming` 内，日志前缀 `[cmd]`）：

| 命令 | 行为 |
| --- | --- |
| `/reset`、`/new` | 换新 DSH 会话；清理该会话的内存状态与定时器；**保留"已回复账本"**（`resetConversationKeepingLedger`）——原来直接 `delete` 会把账本一起抹掉，导致"reset 之后重复回复" |
| `/status` | 当前 DSH sessionId、白名单是否通过、角色、模式 |
| `/token [天数]` | 用量与花费（口径见 §15 与 [COMPACTION-MATH.md](COMPACTION-MATH.md)） |
| `/op [del] <QQ号或昵称>` | 设/取消管理员（仅主人）；昵称走 `resolveNameToUid` |
| `/role …`、`/slang …` | 角色与黑话学习（内部再判一次管理员） |
| `/set active` / `/set diving` | 直接改本会话 `wakeConfig.mode` |
| `/sleep`、`/wake`、`/deepsleep`、`/start`、`/like` | 睡眠 / 唤醒 / 深层静默 / 开始 / 点赞 |

**非管理员发任何 `/` 开头的命令** → 回一句"管理命令仅管理员可用"并结束。`/help` 已被删除：它不再被拦截，会按"其它 `/xxx`"的通用规则交给模型回应。

---
## 13. 自检与宿主（`mcp-host-server.js`）

第三个 MCP server（`qq-bridge/src/mcp-host-server.js`，344 行，stdio，无 export，末行 `await server.connect(new StdioServerTransport())`）。它由 `qq-bridge/src/lib/dsh-side.js` 的 `mcpBlock()` 注册进隔离 DSH home 的 `<home>/profiles/<profile>/cordis.patch.yml`，`serverName: napcat-host`、`command: <process.execPath>`、`args: [<REPO_ROOT>/src/mcp-host-server.js]`（`dsh-side.js:252-299`）。同批注册的还有 `mcp-napcat`（唯一挂压缩代理，`toolCallTimeoutMs: 725000`）与 `mcp-web-search-safe`。

本章 13.1–13.4 讲**宿主侧**（`mcp-host-server.js` 与 NapCat 会话守护）；13.5–13.9 讲**桥对 DSH 的另一半**：会话的创建与查找、提示词投递与卡死自愈、会话归档、agent preset 与工具限制、DSH 客户端协议与鉴权——这几节不含 MCP 工具，而是桥作为 DSH 客户端的能力面。

### 13.1 工具清单与注册条件

| 工具 | 行 | 注册条件 | 实现要点 |
| --- | --- | --- | --- |
| `qq_learning_corpus` | `mcp-host-server.js:142` | 无条件 | 只读打开 SQLite：`state/chat.db` 不存在则退 `state/memory.db`（`:158-161`，`readOnly: true`）；`sinceMs` 默认 `now - 24h`、`untilMs` 默认 now、`limit` 默认 400 上限 800、`convKeys` ≤ 50；SQL 过滤 `direction='in' AND is_self=0 AND kind IN ('text','qqface') AND content<>'' AND ts_ms>=? AND ts_ms<=? AND content NOT LIKE '/%' AND content NOT LIKE '[CQ:%' AND content NOT LIKE '[转发%'`，无 `convKeys` 时限定 `conv_key LIKE 'group:%'`；返回 `{t,who,uid,conv,text}`（正文截 200）；取满 `limit` 时给 `nextSinceMs = last + 1` |
| `qq_learning_submit` | `:198` | 无条件 | `uid` 取 `String(uid).split(':').pop()` 且必须 `/^\d{1,11}$/`；`POST http://127.0.0.1:<consolePort>/api/learning/submit-persona`，头 `x-agent-token` + 可选 `x-console-token`，体 `{uid, payload, samples}`，超时 30000 |
| `napcat_status` | `:247` | 无条件 | `gatewayInfo()` → `POST <httpUrl>/get_login_info`（Bearer `napcat.accessToken`，5s）；`status === 426` 时给提示 `napcat.httpUrl 可能指向了 WebSocket 端口`；成功回 `{reachable:true, online:true, user_id, nickname}`；附加 `{launcher, homeDir, processPids}` **仅当** `allowProcessControl && await bridgeModeAllowsProcessControl()` |
| `start_napcat` | `:264` | **模块加载时** `if (getHostConfig().allowProcessControl)` | 三重拒绝（无 `launcherPath` / `allowProcessControl !== true` / 模式闸门不过）；已在线回 `{started:false, alreadyOnline:true}`；隐藏启动 `cmd.exe /c start /b "" "<launcher>"`（detached + `windowsHide` + `stdio:'ignore'` + unref），20 秒未就绪换可见窗口 `cmd.exe /c start "" "<launcher>"` 重试；等待循环 `for (let i = 0; i < 45; i += 1)` × `sleep(2000)` = **90 秒** |
| `stop_napcat` | `:314` | 同上 | `findNapCatPids()`：`Get-NetTCPConnection -State Listen` 按 `napcat.httpUrl` 端口取 `OwningProcess`，再要求 `Get-CimInstance Win32_Process` 的 `CommandLine` 含 `napcat.homeDir`（归一化小写与 `/`；**取不到命令行就不杀**）；有则 `taskkill.exe /PID <pid> /T /F`（timeout 10000） |
| `qq_status` | `mcp-napcat-safe.js:809` | 无条件 | 唯一用裸 `server.tool` 注册的工具，**本来就是 198 字符、任何档位都保留**，不参与裁剪 |

**模式闸门与当前实现的矛盾**（静态结论，未运行实测）：`bridgeModeAllowsProcessControl()`（`mcp-host-server.js:73-86`）读 `GET http://127.0.0.1:<consolePort>/api/status` 并要求 `body?.mode === 'default'`；但桥控制台 `/api/status` 的响应体实际是 `{ role, roleMode, dshReady, ownerQQ, allowGroups, allowPrivate, socialPaused, activity }`（`qq-bridge/src/core/console-server.js:768-780`），**没有 `mode` 字段**。因此该闸门恒为 false：即便把 `napcat.allowProcessControl` 打开，`napcat_status` 也不会附带 launcher / homeDir / PIDs，`start_napcat` / `stop_napcat` 会走到「拒绝：进程控制仅允许在 default（管理员私聊）模式下使用」。当前 `qq-bridge/config.json` 中 `napcat.allowProcessControl` 为 `false`。

### 13.2 桥的启动装配顺序

`main()`（`qq-bridge/src/bridge.js:270`）的可观测顺序：

1. `loadConfig()`（`:271`）。
2. 内置隔离 DSH 自安装（**异步非阻塞** `void (async () => {…})()`，`:274-309`）：`resolveDshTarget()` → `installPresets(target)` → `watchOverrideFiles(...)` → `ensureBuiltinPlugins(target)` → `isInstalled(target)` → `installToIsolatedDsh()`。
3. `initMuxCore` → `initConsoleCore` → `mkdirSync(STATE_DIR)` → **`acquireLock()`** → `loadState()`（`:310-314`）。
4. 核心模块初始化：`initStickerCore` / `initDocxCore` / `initQqSendCore` / `setTunableCfg` / `initQzoneCore` / `initEventsAuxCore` / `initMemoryCore` / `initWakeCore` / `setWakeDeliver(deliverPrompt)` / `initGroupCacheCore` / `initSocialCore`（`:315-325`）。
5. `startDeliveryWatchdog()`（`:329`）——兜"收下但没交给模型"的消息。
6. `initModeCore` / `initDshWatchCore` / `initCrossChatCore` / `initAuditCore` / `initDshSessionCore` / `initSlangCore` / `initPersonaLearnCore` / `initVoiceCore` / `initNapcatTokens`（内含 `backupLoginTickets()`）/ `initNapcatGuard` / `initSendDice` / `initTokenMeter` / `initTokenReportCore`（`:330-348`）。
7. `setDshSideConfig(cfg)` → `patchProfileCordis(resolveDshTarget())`（`:351-352`）。
8. 用量对账：`setTokenReconcileHome(...)` + `startTokenReconcile()`（`:359-360`），日志 `[token] 用量对账已启用：<home>/storages/session_projcache/sessions`；找不到 DSH home 时 `[token] 未找到可用的 DSH home，跳过用量对账（面板数字只按 usage 帧累计）`（`:363`）。
9. 剪枝计量：`initContextSavings(...)` + 首次 `reconcileContextSavings(...)`（`:380-394`），日志 `[savings] 剪枝计量就绪：扫描 N 份会话日志（复用 M 份），今日已剪掉 X token / 少读 Y token`；无 home 时 `[savings] 未找到 DSH home，跳过剪枝计量（面板不显示该项）`。
10. 会话与投递：`initSessionArchiveCore` → `setConvKeyResolver` → `initPromptDeliverCore` → `initSocialFlowCore` → `initMediaPipeCore` → `initVisionCore`（`:395-400`）。
11. `syncDshCompactionPatch({...})`（`:409`）写 DSH home 的 `cordis.patch.yml`。
12. 领域接线：`setScheduledRecorder(recordSentMessages)` + `setWakeSender(sendWakePrompt)`（`:422`）、`setSteerSender(steerIntoRunningTurn)`（`:424`）、`createMediaDomain(cfg)` + `setConsoleMedia(...)`（`:428-429`）。
13. Pixiv：`startPixivCookieWatch({...})`（`:434`，登录态失效私聊提醒）+ `startPixivTokenRefresh({ logger })`（`:446`，每 50 分钟轮换）。
14. `new NodeApiClient(cfg.dsh.baseUrl, undefined, { dshLogFile, seqFile: state/dsh-seq.json })`（`:463-466`）→ 各 `setXxxApi` 注入 → `initPersonaAutoLearn` → `initPortraitLearn()` → `ensureLearningToken()`（`:476`）。
15. 会话映射自愈（剔除磁盘上不存在的会话，`:490-512`）→ `loadSocialState()`（`:544`）→ 启动同步插话概率（`:552`）→ 标记人设补注入（`:560`）。
16. `const bot = new OneBotWsClient({ url: cfg.napcat.wsUrl, accessToken: cfg.napcat.wsAccessToken || cfg.napcat.accessToken || undefined, reconnect: true })`（`:565-569`）；各 `setXxxBot`（`:572-580`）。
17. 事件订阅：私聊（`:581`）、群（`:585`）、`onNotice('notify')`（`:589`，拍一拍/输入状态）、撤回 `onNotice`（`:595`）、好友请求 `onRequest('friend')`（`:622`，`cfg.social.autoFriendApproval === false` 可关）。
18. WS 事件：`on('open')` → `napcatUp = true` + `probeNapcatLogin({ force: true })`；`on('close')` → `napcatUp = false` + 强制重探；`on('error')` → 打 `message / code / cause.code / cause.message`。
19. **登录态巡检已删除**：`const loginWatch = null; void loginWatch;`（`:666-667`，注释 `:659-665` 明写"桥现在不主动查 NapCat 任何状态"）。
20. `connectNapcat(budgetMs)`（`:676-691`）：`error.code === 'NAPCAT_CONN'` 时退避 `Math.min(15000, 1500 * attempt)`；预算 `cfg.social?.napcatStartupBudgetMs` 默认 **120000 ms**。**连不上也不退出**，后台每 15 秒重连一次（`:696-709`）。
21. 日志 `桥接已启动。按 Ctrl+C 退出。`（`:727`）后恢复持久任务：`loadScheduledTasks()` → `loadDocxQuota()` → `loadActivityWindows()` → `startActivityTick()` → `loadArchivedCache(); startSessionArchiveTicker()` → `syncStickerLibrary(true)` → `startDshWatch()` → `startNapcatGuard()` → `startConsoleServer()`（`:729-742`）。
22. `watchConfigFile(cfg, { onChange })`（`:747`）：`dsh*` 变更清模型缓存；`social.wake*` 变更同步概率；`dshCompaction*` 重写 patch；`social.autoReset.permanent` 只记日志。
23. `initSlangNightly(cfg)`（`:784`）→ **`await pumpMux();`（`:786`，事件泵主循环，永不返回）**。
24. 退出钩子：SIGINT（`saveState(); releaseLock(); process.exit(0)`）、SIGTERM、`unhandledRejection`、`process.on('exit', () => releaseLock())`；stdout/stderr 挂空 error 处理器防 EPIPE；`main().catch(...)` 打 `[bridge] 启动失败:` 并 `exit(1)`（`:789-816`）。

单实例锁：`state/bridge.lock`（`qq-bridge/src/lib/paths.js:20`），`acquireLock()` 用 `writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 })` 原子创建（`runtime.js:13`）；已存在时校验 PID 存活，空/非法视为过期锁并删除重试一次，PID 存活则打印错误并 `process.exit(2)`，读不到锁文件 `exit(1)`；`releaseLock()` 只在文件内容等于自身 PID 时 `unlinkSync`。

### 13.3 DSH 不可用时的消息入队缓存

| 项 | 值 / 行为 | 位置 |
| --- | --- | --- |
| 每会话容量 | `QUEUE_MAX = 50` | `qq-bridge/src/core/prompt-deliver.js:17` |
| 载体 | `queued: Map<key, {promptText, farewell, silent, media}[]>`、`queuedHintAt`、`queueRetries` | `session-state.js:38-40` |
| 入队 | `!dshReady` 时 push；满 50 则 `items.shift()` **丢最旧**并记 `队列满（50），丢弃最旧消息 (<key>)` | `prompt-deliver.js:114-124` |
| 失败重投 | `enqueueForRetry(key, promptText, opts)`：同 `promptText` 去重；`queueRetries.delete(key)`（新消息视为新机会）；`setTimeout(flushQueue, 3000)` | `:33-45` |
| 补投 | `flushQueue()` 单飞（`flushingQueue` 守卫）；失败时剩余项整体放回且旧消息优先 | `:47-112` |
| 退避 | `retries > 5` → `补投持续失败，暂停快速重试，队列保留 (<key>)，60 秒后恢复一次`；否则 `Math.min(3000 * 2^(retries-1), 60000)` | `:90-98` |
| 触发 | DSH 恢复时 `dsh-watch.js:248` `await flushQueue()`；`checkDsh()` 每 5 秒一次（`dsh-watch.js:310-315`） | |
| 单条投递 | `apiRef.sessions.prompt({ sessionId, mode: 'steer', content })` + `withTimeout(..., 30000)`；失败 → `quarantineSession` + `[default] DSH 投递超时/失败 <key>，会话已隔离（<err>）`；未被接受则回 QQ `⚠️ 消息未被接受：<err>` | `:165-177` |
| 控制台降级 | `{ ok:false, error:'DSH 当前不可用，请稍后再试' }`（HTTP 503） | `console-server.js:1234-1237` |
| 就绪探测 | `apiRef.host.describe({})` 成功 → `DSH 已就绪（模式: <mode>）`；失败且原为 ready → `⚠️ DSH 不可用（重启中？），QQ 消息将入队等待` | `dsh-watch.js:212-308` |

### NapCat 会话守护

这一组能力在 2026-09 之后**被大幅收缩**，读文档时必须按现状理解。

| 组件 | 文件 | 现状 |
| --- | --- | --- |
| 会话守护（探针自愈） | `qq-bridge/src/core/napcat-guard.js`（276 行） | **已停用/空转**：`guardTick()` 空实现，`startNapcatGuard()` 不起定时器并打日志，`guardStatus()` 返回 `{ removed:true, enabled:false, autoHeal:false, verdict:'removed', probeMode:'none', … }`；`restartContainer` / `healNapcatSession` / `waitRecover` / `healsLastHour` **整段删除**。`POST /api/napcat/guard/heal` 固定返回 **410**，文案：`「会话守护 / 探针自愈」已去除：桥不再探活、也不再自动或手动重启 NapCat。要看状态请直接开 NapCat 界面。` |
| 仅存的真实动作 | `qrSnapshot()` / `exportQrFresh()` | `docker cp <container>:/app/napcat/cache/qrcode.png <STATE_DIR>/napcat-qr.png`（timeout 20000），**只读现成那张码，绝不换码** |
| 快速密码（重建容器） | `applyQuickPassword(password)`（`napcat-guard.js:207`） | `docker inspect` → 规格落盘 `state/napcat-container-spec/<stamp>.json` → `docker stop -t 30` → `docker rename <name> <name>-old` → `docker run -d --name … --restart <原策略\|unless-stopped> -v… -p… -e… -e NAPCAT_QUICK_PASSWORD_MD5=<md5> <原镜像\|mlikiowa/napcat-docker:latest>`；失败回滚 `docker rm -f` → `rename -old` 回去 → `docker start`；成功后 `docker rm -f <name>-old`。**明文密码不落盘，只存 md5** |
| 历史设计值（仍在 `DEFAULTS`） | `napcat-guard.js:34-43` | `enabled: true`、`probeIntervalMs: 60000`、`failThreshold: 2`、`cooldownMs: 600000`、`maxHealsPerHour: 3`、`restartGraceSec: 60`、`recoverWaitMs: 150000`、`autoHeal: null` |
| 退出守卫 | `server/napcat-guardian.mjs`（146 行） | 见 §18 |

为什么要这一层（`napcat-guard.js:5-14` 逐字记录）：2026-09-16 亲历静默死 50 分钟——**QQ 服务端把登录态作废，客户端一条错都不报**；症状是客户端 `isLogin/online` 仍为 true，但发消息被拒 `EventChecker Failed: NodeIKernelMsgService/sendMsg / {"result":1006514,"errMsg":"网络连接异常!"}`。历史探活接口 `get_rkey`（每次都真请求 QQ 服务器、对别人不可见）与兜底 `get_status` 现已全部删除。

### 登录态呈现（替代已删除的巡检）

- **不存在独立的周期巡检**：`bridge.js:659-667` 明确删除，`startNapcatGuard()` 也不起定时器。因此旧文档写的「WS 没连上时每分钟问一次、状态变了才打一行 `[napcat-login]`」**已失效**；`[napcat-login]` 这个 tag 在源码中**没有任何输出点**（仅 `napcat-tokens.js:213` 的提示文本提到它）。
- 现在的实时路径：`probeNapcatLogin({ force })` 带 TTL 缓存 `LOGIN_TTL_MS = 3000` + 并发合并 `loginInFlight`，只在结论变化时 `publishLogin()`；订阅接口 `subscribeNapcatLogin` 供 SSE 用。
- SSE 端点 `GET /api/napcat/login-stream`（`console-server.js:5594-5605` → `handleNapcatLoginStream:6108-6189`）：建连先 `: connected` + 推缓存快照（`cached: true`）→ `await push(true)` 强制首帧 → 订阅推送 → **30 秒兜底重探** → **20 秒注释心跳** `: ping`；事件名 `napcat-login`，字段 `{ ok, login, connection, at }`。
- 桥侧强制重探点：`bot.on('open')`、`bot.on('close')`。
- WS 连接日志：`NapCat 已连接：<wsUrl>`、`NapCat 连接断开（code=… reason=…），重连中…`、`NapCat 错误: <detail>（wsUrl=…）`、`[napcat] 第 N 次连接未成功（NapCat 可能在启动/等待扫码）：<s>s 后重试`、`[napcat] 启动预算内仍未连上：桥继续运行（控制台可用），后台每 15s 再试一次，NapCat 就绪后自动接上`、`[napcat] 已接上 NapCat（后台重连成功）`。

### 13.4 NapCat token 与鉴权

令牌落盘位置（`qq-bridge/src/core/napcat-tokens.js:8-13, 65-81`）——配置目录推导顺序：`napcat.dockerPathMap[].host` → `path.dirname(napcat.tmpDir)` → `/root/napcat/config` → `<cwd>/napcat/config`：

| 文件 | 字段 |
| --- | --- |
| `<config>/webui.json` | `token`（WebUI 6099 登录令牌）：读 `:170-176`、写 `:474-485` |
| `<config>/onebot11*.json`（`/^onebot11.*\.json$/i`） | `network.httpServers[].token`、`network.websocketServers[].token` |
| `<config>/napcat_protocol*.json` | 同上（存在才改） |
| `<config>/napcat_\d+\.json` | 登录票据；备份到 `<config>/login-backup/<YYYYMMDD-HHMMSS>`，保留 `BACKUP_KEEP = 5` 份；写前另存 `_bak-<stamp>` |

桥侧键名（`qq-bridge/config.json` 实测）：`napcat.wsUrl = "ws://127.0.0.1:3001"`、`napcat.httpUrl = "http://127.0.0.1:3000"`、`napcat.accessToken = "truefriend"`、`napcat.wsAccessToken = "truefriend"`、`napcat.launcherPath = ""`、`napcat.homeDir = ""`、`napcat.allowProcessControl = false`。

- OneBot HTTP 调用统一发 `authorization: Bearer <napcat.accessToken>`（实例：`napcat-tokens.js:292`、`console-server.js:3986`、`docx.js:113`、`qq-send.js:299`、`qzone.js:28`、`media.js:391/451`、`sticker.js:304/394`、`voice.js:1017`、`mcp-napcat-safe.js:377`）。
- OneBot WS 同时用两种携带方式：URL 追加 `access_token=<encoded>` **且**握手头 `Authorization: Bearer <token>`（`lib/onebot-ws.js:135-144`）。
- **桥不使用 WebUI 令牌做任何事**（`napcatTokenStatus` 里 `out.mismatch.webui = false`）。
- 登录态探测不用 WebUI 登录接口，只用 `POST <httpUrl>/get_login_info`（Bearer，6s 超时）：401/403 → "令牌不对"；`retcode !== 0` → "查不到登录信息"；成功回 `{ok:true, isLogin:true, online:true, uin, nick, source:'onebot'}`。**WebUI 登录接口的调用已整体删除**，原因写在注释里：NapCat 登录接口按 IP 限流（每 60 秒 `loginRate` 次），额度要留给 WebUI 页面自己。
- 写入令牌：控制台 `POST /api/napcat/tokens`（`console-server.js:5620-5663`）→ `applyNapcatTokens(payload)`：校验 `TOKEN_RE = /^[A-Za-z0-9._~!@#$%^&*()\-+=]{4,64}$/`（非法直接拒）→ 备份 → 写三类文件 → **只在值真变了才重启**（`changed.dirty` 判定）→ `docker restart -t 60 <name>`（`restartContainer()` 注释说明：**不能用 `docker stop`**，默认 10 秒会 SIGKILL 掉登录态，NapCat 的 PID1 只 trap SIGPIPE、不转发 SIGTERM）→ 复验（`waitWebuiUp(120000)`、`waitHttpUp(12000)`）。
- `useBridgeTokens !== true` 时，控制台把桥 `config.json` 的 `napcat.accessToken` / `napcat.wsAccessToken` 同步到内存与文件，文件先备份为 `config.json.bak-tokens`。
- 未落地键：`napcat.httpToken` 仅被读（`:287`），全库无写入点、当前 `config.json` 也没有该键——**来源未验证**。
- 历史遗留文件：`state/napcat-alert.json` 在当前源码中**已无写入点**（探针删除后遗留）；`state/napcat-guard.json` 仍由 `readState`/`writeState`/`setGuardConfig` 维护。

### 13.5 DSH 侧：会话的创建与查找

**映射表**：`state/sessions.json`（`qq-bridge/src/lib/paths.js:8-9`），结构逐字为 `{"sessions": {"<key>": "<sessionId>"}}`，`key ∈ /^(group|private):(\d+)$/`（`core/mode.js:41`）。内存态 `export let state = { sessions: {} }`（`core/config.js:440`）；`loadState()` 只在 `loaded.sessions` 是对象时采用；`saveState()` 写 `STATE_FILE + '.tmp'` 再 `renameSync` 原子替换（`config.js:448-452`）。反向索引 `reverse: Map<sessionId, key>`（`core/session-state.js:30`）。**当前工作区实盘内容为 `{"sessions": {}}`（空映射）**。

`ensureSession(key)`（`qq-bridge/src/core/dsh-session.js:79`）的顺序：

| 步 | 动作 | 细节 |
| --- | --- | --- |
| 0 | 映射命中即复用 | 先 `ensureVisionModel(existing)`；`await` 之后**复核代际**（`sessionEpoch`） |
| 1 | `workspace.create({ path: dir })` | `dir = cfg.sessionCwd \|\| <qq-bridge>/state/agents`（递归 `mkdirSync`） |
| 2 | `workspace.rename({ workspaceId, title })` | 仅当 `wsValue.created && cfg.workspaceTitle`（现场 `workspaceTitle = "Agents"`） |
| 3 | `sessions.create({ workspaceId, agentPreset })` | `agentPreset = modePreset(key, currentMode, cfg)` = `cfg.social.agentPreset \|\| cfg.agentPreset`（`mode.js:35-37`） |
| 4 | 降级 | 归组/preset 失败 → 无参 `sessions.create({})` 再试一次 |
| 5 | 落盘 | `state.sessions[key] = sessionId`、`reverse.set(...)`、`saveState()` |
| 6 | 模型 | `ensureVisionModel(sessionId)` |

并发去重靠 `sessionPromises`（`core/session-state.js:10`，`dsh-session.js:113/154-159`）。代际守卫：`sessionEpoch` / `bumpSessionEpoch()`（`dsh-session.js:13/15`），创建完成时代际已变 → 归档并抛 `会话创建期间已重置，丢弃新会话`（`:142-146`）。

`ensureVisionModel(sessionId)`（`:38-77`）：`provider = cfg.dsh.provider || 'deepseek-official'`、`model = cfg.dsh.visionModel || cfg.dsh.model || 'deepseek-v4-flash-vision-exp'`、`reasoningEffort` 为空时**连参数都不带**；档位计划 `configured ? [configured,''] : ['']`，每档最多 2 次、间隔 1000 ms；被明确拒绝（`UNSUPPORTED_REASONING_EFFORT|does not support reasoning effort`）就换默认档；`session.not.found` 直接抛。热加载时 `resetVisionModelApplications()` 清 `visionModelAppliedSessions`，否则"改了模型老会话不生效"。

预热会话 `createStandbySession(key)`（`:169-205`）：同样的工作区 + preset + 模型选择，但**不写** `state.sessions` / `reverse`，失败返回 `null`。轮换阈值 `rotateThresholdOf(cfg)` = `social.autoReset.permanent === true ? Infinity : max(5, social.autoReset.wakeThreshold || 10)`（`core/wake-send.js:95-97`），推迟注入上限 `ROTATE_DEFER_MAX_MS = 120000`（`wake-send.js:75`）。

死引用清理：`liveSessionIdsOnDisk()`（`core/session-archive.js:207-220`）扫工作区目录下 `session-*`，避免"重启后每秒重开死会话 follow"。

### 13.6 提示词投递与卡死自愈

投递终点是 DSH `POST /api/session/prompt`，body 形如 `{type:'client-request', rpcId, method:'session/prompt', payload:{args:{request:{requestId, sessionId, mode, content, clientTimeZone?}}}}`（`qq-bridge/src/dsh-client.js:225-245`）。桥内构造（`core/prompt-deliver.js:135-165`）：`content = [{type:'text', text: withSlangContext(promptText)}]`，带媒体时追加 `mediaResolver` 产出的图片段。

**`mode` 恒为 `'steer'`**（`:165`）。文件内 `:144-164` 给了逐层依据：`queue` → `agent.followup()` → `next-turn` 队列，当前回合永不结束时会**永久搁浅**；`steer` → `agent.steer()` → `next-step`，`inbox.claim()` 总是先取 next-step，所以"会话忙不忙都必被取走"。真"零注入"的快路径是模型正挂着 `qq_wait_for_messages` 长轮询时——消息作为**工具结果**回到模型手里，不走投递（`core/social-state.js` 的 `activeWaits` 守卫，定义在 `core/session-state.js:24`）。

| 常量 / 行为 | 值 | 位置 |
| --- | --- | --- |
| 单次 prompt 超时 | `30000` ms（`withTimeout(…, 30000, 'DSH prompt <sid>')`） | `prompt-deliver.js:165` |
| 队列上限 | `QUEUE_MAX = 50`，满则丢最旧 | `:17/36-39` |
| 入队后补投延迟 | `3000` ms | `:44` |
| 补投失败退避 | `min(3000 * 2^(retries-1), 60000)` | `:97` |
| 连续失败 > 5 次 | 暂停快速重试，`60000` ms 后再试一次，队列保留 | `:88-95` |
| flush 收尾重排 | 队列非空 → `500` ms 后再 flush | `:108-110` |
| 每会话串行 | `promptQueues: key -> {queue, running}` | `:182-213` |

失败链：DSH 未就绪 → 入队返回 `{ok:true, queued:true}`（DSH 恢复时由 `core/dsh-watch.js:248` 的 `flushQueue()` 补投）→ 会话创建期被重置 → 入队重试 `{ok:true, retried:true}` → prompt 超时/异常 → `quarantineSession(key, sessionId)`（`core/turn-guard.js:56-96`：拒绝队列中未投递项并标记 `会话已隔离，投递取消`、清 `TurnStartAt`/`collectors`/`toolCallNames`、`delete state.sessions[key]` 后 `saveState()`）→ 返回 `{ok:false, error:'投递失败（会话已重置，将自动恢复）：…'}`。业务拒绝（`accepted.result.ok === false`）向 QQ 回 `⚠️ 消息未被接受：…`，**含敏感信息时显示「（含敏感信息，已隐藏）」**（`:172-177`）。

DSH 探活 `checkDsh()`（`core/dsh-watch.js:212-308`）：`apiRef.host.describe({})` 成功即就绪；转为就绪时 `setDshReady(true)`、恢复睡眠定时器、预热群信息、`flushQueue()`；掉线时记 `⚠️ DSH 不可用（重启中？），QQ 消息将入队等待`。`startDshWatch()` 立即跑一次 + `setInterval(checkDsh, 5000)`。

### 13.7 会话归档

`qq-bridge/src/core/session-archive.js`（432 行）。状态文件 `<state>/session-archive.json`，结构 `{archived:[sid...], updatedAt}`（`:222-232`）。默认参数（`:27-33`）：`enabled:true`、`intervalMs:600000`（10 分钟）、`idleMinutes:30`、`batchMax:20`、`pruneDays:0`；合并时钳制 `intervalMs ≥ 60000`、`idleMinutes ≥ 0`、`batchMax ≥ 1`、`pruneDays ≥ 0`。

- 工作区判定：`sessionWorkspaceDir()` = `cfg.sessionCwd || <state>/agents`；slug 归一化只留 `[a-z0-9]`；本桥判定 = 精确等于工作区 slug **或**以其父目录 slug 为前缀（`:71-83`）——因此 `--C-Users-*--`、`--D-MoonBot-*--` 这类别机残留**永不匹配**。
- sessions 根候选顺序（`:106-140`）：`$QQB_DSH_HOME/sessions` → `$DSH_ISOLATED_HOME/sessions` → `<qq-bridge>/.runtime/dsh-isolated-home/sessions` → 管理器 `~/.qq-bridge-manager/config.json` 的 `instances.dshIsolated.isolatedHome/sessions` → `$DSH_HOME/sessions`（**排在管理器之后**，因为桌面版会把 `DSH_HOME` 指到桌面 home）→ 管理器目录下 `^dsh-isolated-home` 目录。
- 保护集 `protectedSessionIds()`（`:239-267`）：`state.sessions` 全部值、`social.conversations[]._standbySessionId`、`reverse.keys()`、`collectors.keys()`、`TurnStartAt.keys()`、`learnerSessions`，兜底读 `state/slang-session.json`、`state/persona-session.json` 的 `sessionId`。
- 巡检 `archiveIdleSessions(opts)`（`:279` 起）：`opts = {force, dryRun, allWorkspaces, idleMinutes, batchMax}`；`running` 互斥防重入；按 `statSync().mtimeMs` 计时；已归档者仅在 `pruneDays > 0` 且超期时才 `fs.rmSync`；候选按 `idleMs` 降序（最旧的先归档）；报告 `{ok, sessionsRoot, workspaceDirs, scanned, candidates, archived, failed, pruned, skippedProtected, dryRun, idleMinutes, allWorkspaces}`。
- 归档动作 = DSH 侧 `workspace/archiveSession`，**只打隐藏标记、不删数据**（文件头 `:1-14`）。
- 定时器 `startSessionArchiveTicker()` / `stopSessionArchiveTicker()`（`:405-414`），桥启动处 `loadArchivedCache(); startSessionArchiveTicker();`（`qq-bridge/src/bridge.js:734`）。
- 手动/状态接口：`GET|POST /api/social/session-archive`（`core/console-server.js:2710-2731`）。

### 13.8 preset 与工具限制

`qq-bridge/dsh/agent-presets/` 下**只有 `qq-chat` 一份**（安装名单硬编码 `for (const name of ['qq-chat'])`，`qq-bridge/src/lib/dsh-side.js:150`）：

| 文件 | 字节 | 说明 |
| --- | --- | --- |
| `qq-chat/agent.cordis.yml` | 43,952（215 行） | 提示词骨架 + 插件挂载 |
| `qq-chat/preset.yml` | 235 | `name: QQ 聊天角色`、`order: 10` |
| `qq-chat/qq-tool-restrict.mjs` | 4,905（94 行） | 工具白名单硬边界 |

挂载的插件只有 4 条：`persona`（`@deepseek-ai/dsh-persona`）、`tool-web`（`config: {search:false, fetch:false}`——联网能力收口到安全 MCP）、`qq-tool-restrict`（`./qq-tool-restrict.mjs`）、`compaction`（隔离组，子插件 `dsh-compaction-basic`、`dsh-command-compact`、`dsh-compaction-tool-result-pruner`，其中 pruner 参数 `thresholdChars:25000, headChars:22800, tailChars:2000`）。**`dsh-tool-ask-user` 与 `dsh-tool-todo` 未挂载**——从源头卸载而非 deny，理由是 `ctx.tools.restrict({deny})` 对 preset 自挂的 scoped 工具会报 `unknown global tool`（静默无效）。

工具白名单（执行期真正生效的闸门，`qq-tool-restrict.mjs:37-59`）：

```js
SAFE_PREFIXES = ['mcp__napcat__', 'mcp__napcat-host__', 'mcp__web-search-safe__']
SAFE_EXACT    = new Set(['ask_user_question', 'todo_write'])
```

`apply(ctx)`：① 逐个 `ctx.tools.restrict({deny:[name]})` 遍历 23 个 `dev_*` 名字（异常吞掉），**日志截断到 160 字符**——原话里嵌着完整工具表（平均 2341 字符/行）曾把 `dsh-web.log` 灌到 4,260,469 B、占 98.6%，把 `?token=` 挤出读取窗口导致全链路 401；② `ctx.tools.guard(...)`：`SAFE_EXACT` 或三个前缀命中才放行，否则返回 `工具 "<name>" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`。文件自述：那 23 个 `dev_*` 名单**从未生效过**（名字在当前 DSH 全局工具表里不存在），真正兜底的是 guard。

MCP 挂载由桥写入 DSH 隔离 home 的 profile 补丁（`lib/dsh-side.js:252-299` 的 `mcpBlock()` → `<home>/profiles/<profile>/cordis.patch.yml`）：三个 server `mcp-napcat → src/mcp-napcat-safe.js`、`mcp-napcat-host → src/mcp-host-server.js`、`mcp-web-search-safe → src/mcp-web-search-safe.js`，均为 `transport: stdio`；`mcp-napcat` 额外 `toolCallTimeoutMs: 725000`。压缩代理（`social.toolCompressor`）只包 napcat 一路，参数 `-c <level> -n napcat [--exclude-tools a,b] [--toonify] -- node <script>`，**探测不到就回退直连**。另有 `agent-presets` overlay：`{default: standard, includeUserRoot: true}`。

安装目标判定 `resolveDshTarget()`（`:57-88`）：`QQB_DSH_HOME` → 项目 `.runtime/dsh-isolated-home` → 管理器配置里的 `instances.dshIsolated.isolatedHome` → 项目路径（仅提示）；**Windows 上拒绝写桌面 home**。安装标记 `<home>/.qq-bridge-dsh-installed.json`（`INSTALL_VERSION = 1`），命中即跳过。手工入口 `qq-bridge/scripts/setup-dsh.mjs`（43 行）：`--home / --profile / --desktop / --force`，未初始化时 WARN 并 `exit 0`，目标被拒 `exit 1`，安装失败 `exit 2`。

**漂移（实测哈希，2026-09-25）**：仓库源 `agent.cordis.yml` = `63723C8F…F38EF`；活体隔离 home 的 `qq-chat` 与 `default` 两份都是 `EE497B35…60D1F`（逐字节相同）。字节差**至少部分**来自 `syncPresetOverrides` 写入的人设/发言规则合成段（标记 `# === qq-bridge persona/rules BEGIN/END ===`，`lib/preset-compose.js:33-59`）；未做 `stripOverrideBlock` 后再比对，所以"安装副本落后于仓库源"是**未验证判断**。

### 13.9 DSH 客户端协议与鉴权

`qq-bridge/src/dsh-client.js`（600 行）。传输：`POST /api/<ns>/<m>`，body `{type:'client-request', rpcId, method:'<ns>/<m>', payload:{args}}`，响应 `{type:'server-response', result:{ok,value}|{ok,error}}`。

- 鉴权 `_ensureSession()`：从 DSH 日志尾读 `?token=` → `GET /?token=xxx` 取 `dsh-auth-*` cookie，**缓存 55 秒**；无 token 环境自动免鉴权；401/403 强制换 cookie **只重试一次**（避免被误判成卡死而重建会话）。
- token 读取窗口逐级放大 `TOKEN_SCAN_STEPS = [256KB, 1MB, 4MB, 16MB]`，到顶返回 null（静默降级为不带 cookie）。文档记录过一次 4,260,469 B 日志把 token 挤出 256 KB 窗口导致全链路 401 的事故。
- 方法表与超时（毫秒）：`sessions.{create 30000, prompt 30000, list 30000, page 30000, cancel 10000, rename 10000, selectModel 30000, modelCatalog 15000, attachment 60000}`、`workspace.{create 30000, rename, archiveSession 15000, delete 15000, list}`、`events.{mux,host}`、`host.describe 15000`、`settings.describe 15000`、`respond`。
- 事件面：无全局 mux，改为**逐会话** `session/follow`（`remote.mux` WebSocket，`{request:{address:{kind:'session',sessionId}, maxMessages:200}}`）；`$events` 流收 approval/question，应答走 `POST /api/$events/result`。审批/提问缺上下文时**如实抛错**（不再伪报成功）。
- seq 水位：`SEQ_RESET_GAP = 100`、`shouldResetSeqWatermark(known, maxRec)`，水位落盘 `state/dsh-seq.json`。
- 客户端构造：`new NodeApiClient(cfg.dsh.baseUrl, undefined, { dshLogFile: process.env.DSH_ISOLATED_LOG_FILE, seqFile: <state>/dsh-seq.json })`（`bridge.js:463-465`）；`baseUrl` 默认 `http://127.0.0.1:10721`。
- 兼容面：`workspace/list` 在 rc.1 无对应端点，桥本地伪造（`dsh-client.js:305-309`）；`sessions.rename` 存在但**桥内未见调用点**（未验证）。

---

## 14. 联网搜索


| 工具 | 做什么 | 代码位置 |
| --- | --- | --- |
| `web_search` | 联网搜索 | `qq-bridge/src/mcp-web-search-safe.js:944` |
| `web_fetch` | 抓网页正文 | `qq-bridge/src/mcp-web-search-safe.js:980` |

两者都在 `mcp-web-search-safe.js` 里做了 SSRF 防护（`qq-bridge/src/safe-fetch.js` 的 `validateFetchUrl` / `safeFetchBuffer`）。这个文件的名字带 `safe` 不是装饰。

联网找图走的是 `qq-bridge/src/lib/image-search.js`（Bing / 百度），与这两个工具分开。

> 本节的行号来自既有文档，本轮**未逐行核实** `mcp-web-search-safe.js` 与 `safe-fetch.js` 的实现（§19 已登记）。

---

## 15. 用量与成本

三个模块各管一段：`qq-bridge/src/core/token-meter.js`（记账与对账，1034 行）、`qq-bridge/src/core/token-report.js`（口径与文案，193 行）、`qq-bridge/src/core/context-savings.js`（剪枝计量，334 行）。

### 15.1 记账

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 每次请求记账 | `token-meter.js:550` `meterTokenFrame(frame)` | 真实 `usage` 帧优先；没有就累计帧内文本作估算素材 |
| 取真实 usage | `collectUsageFields(frame)`（`:429`） | 深扫 `MAX_DEPTH = 6` 层、单数组最多 `MAX_ARRAY_ITEMS = 200`；字段名映射 `prompt ← prompt_tokens\|promptTokens\|input_tokens\|inputTokens`、`completion ← completion_tokens\|completionTokens\|output_tokens\|outputTokens`、`total`、`cacheRead ← cacheReadTokens\|prompt_cache_hit_tokens\|cached_tokens`、`cacheWrite` |
| 去重 | `usageSig = "${prompt}\|${completion}\|${total}"` + `realSigSeen` | 窗口 `REAL_SIG_KEEP_MS = 86400000`，每会话最多 `REAL_SIG_MAX_PER_SESSION = 64` 条 |
| 估算 | `flushEstimate`（`:518`） | `prompt = round(chars / EST_PROMPT_CHARS_PER_TOKEN)`、`completion = round(chars / EST_COMPLETION_CHARS_PER_TOKEN)`，常量 `1.8` / `2.2`；行内另存原始 `promptChars` / `completionChars`；**该回合出现过真实 usage 就直接丢弃**，防双计 |
| 累计上限 | `ACC_CHARS_CAP = 5000000`、空闲刷新 `ACC_IDLE_FLUSH_MS = 90000` | `token-meter.js:66-67` |
| 文件上限 | `MAX_LINES = 50000`、`PRUNE_TO_LINES = 45000` | `token-meter.js:60-61`；裁剪后必须按裁剪过的文件重建累计，否则对账会重复补 |
| 回合/重试事件 | `llm/retry` 只记账不落行（`agg.retryCount += 1`、`agg.retryEstimated += last`）；`turn/start` 清累计；`turn/end` 刷新估算 | `:602-629` |
| 落盘 | `state/token-usage.jsonl`；行格式 `{"tsMs","sessionId","convKey","prompt","completion","total","est","promptChars","completionChars"}`（真实行另有 `cacheRead`/`cacheWrite`，补记行另有 `reconciled:true`） | `token-meter.js:58, 413-426` |

### 15.2 与 DSH 对账

- 启动：`startTokenReconcile(intervalMs = 5 * 60 * 1000)`（`:1026`）：`every = Math.max(30000, intervalMs)`，先 `setTimeout(tick, 20000)` 再 `setInterval(tick, every)`，幂等。
- 数据源：`<dshHome>/storages/session_projcache/sessions/*.json` → `record.rows.tokenUsage.val.totals`，四桶 `uncachedInputTokens / outputTokens / cacheReadTokens / cacheWriteTokens`。
- 缺口算法：`baseSum = max(桥侧累计, 水位)`；`dshSum <= baseSum` 直接跳过（总量无缺口绝不补，修对账棘轮）；`deficit = dshSum - baseSum`，逐桶 `gaps` 按 `deficit / gapSum` 等比缩放后 `Math.floor`。
- 归属判定：`recent = nowTs - mtime <= maxAgeMs`（默认 `DEFAULT_RECONCILE_MAX_AGE_MS = 6h`）、`owned = 桥侧该会话有累计 || (recent && isBridgeOwnedSession(sid))`；不满足则计入 `skippedNoBaseline` / `skippedStale` 并把水位抬到 DSH 当前值。单次最多处理 `quotaPerRun = 200` 个。
- 补记行：`{ tsMs: mtime, sessionId, convKey, prompt, completion, total, cacheRead, cacheWrite, est: false, reconciled: true, promptChars: 0, completionChars: 0 }`，落盘失败回滚水位。
- 水位文件 `state/token-reconcile.json`（`{version:1, updatedAt, sessions:{sid:{prompt,completion,cacheRead,cacheWrite,at}}}`）；补记日志 `state/token-reconcile.log`，行格式 `${ISO} added=N tokens=M sessions=…`。
- 实机取证：本机 `C:\Users\17367\.dsh\storages\session_projcache\sessions\*.json` 抽样 3 份，`record.sessionId` **全部为 `undefined`** → 实际走文件名兜底（`sid = 文件名去 .json`）；totals 样例 `{"uncachedInputTokens":30363,"outputTokens":21745,"cacheReadTokens":1274112,"cacheWriteTokens":0}`（键名与代码一致）。

### 15.3 剪枝省下多少

- 数据源：`<dshHome>/sessions/<slug>/<sessionId>/session.jsonl.zstd`（多帧 zstd，自实现 `decodeSessionLog`，magic `0xfd2fb528`）。**不读事件流**：官方 rc.1 没有全局广播，桥只能逐会话 follow，只覆盖自己映射的会话。
- 识别的事件：`step/start`（后续重读计数）、`compaction/prune`、`compaction/summary`、`llm/retry`。
- 算法（`context-savings.js:124-137`）：`prunedTotal += data.shadowedTokenCount`，并对**每次剪枝之后**的同会话 `step/start` 各累加一次同样数值，即 `rereadSaved = Σ(被剪掉的量 × 其后同会话请求次数)`。**没有字符估算**，全部数字来自日志重算（幂等、可回填）。
- 实机验证（只读扫 200 份日志）：`compaction/prune` **214** 条、`compaction/summary` **16** 条、`llm/retry` **9** 条；prune 样例逐字：

```json
{"seq":2851,"time":1790320580866,"data":{"shadowedRange":{"start":852,"end":852},"shadowedSeqs":[852],"shadowedTokenCount":5955}}
```

- 状态文件 `state/context-savings.json`（`STATE_VERSION = 3`）；增量按 `(mtimeMs, size)` 复用，解析失败沿用上次结果并记 `会话日志解析失败（沿用上次结果）：…`；TTL `scanTtlMs = 30000`。
- 对外：`GET /api/token-report`（`console-server.js:5924-5948`）→ `{ ok, report, contextSavings }`，`contextSavings = getContextSavings(7)`。

### 15.4 两个口径别混

`/token` 指令入口在 `mux.js` 内联分支：匹配 `plainContent === '/token' || /^\/token\s+\d{1,2}$/`，`daysArg = Number(...) || 1`，调 `buildTokenReportText({ days })` 后 `sendToQQ`。

| 口径 | 换日点 | 用途行 |
| --- | --- | --- |
| **计费日** | 北京 **08:00**（`dayOffsetMin = 480`，等价 UTC 自然日；环境变量 `QQ_TOKEN_DAY_OFFSET_MIN` 可覆盖） | 第 1 行「今日 N tok —— 平台计费日（北京 08:00 换日，与提供方控制台对得上）」、近 N 天合计 |
| **北京自然日** | 北京 **00:00** | 「自然日 00:00 起 N tok（含 00:00–08:00 那段，平台算在昨天）」与费用行 |

`naturalSame = naturalTotal > 0 && Math.abs(naturalTotal - todayBilled) < Math.max(1, todayBilled * 0.005)` 时省略自然日那一行——两口径近似一致就不重复印。线上实测同一天两者分别是 **592,685** 与 **12,182,789** token。旧版 `/token` 把两个口径挨着印（第一行取计费日、第二行的分量与金额却来自自然日分时桶），读起来像算错了。现在**逐行标注口径**。

金额只在 `cacheSamples > 0` 的小时桶上算：`c = ((hit*pHit + miss*pMiss + out*pOut)/1e6) * mult`，`mult = peakHours.has(hour) ? peakMult : 1`。

计价参数在 `config.json` 的 `tokenCost`（`qq-bridge/src/core/config.js:108-115`，与 `token-report.js:19-25` 的 `DEFAULT_TOKEN_COST` 同源）：

```json
{ "pHit": 0.02, "pMiss": 1, "pOut": 4, "peakMult": 2,
  "peakHours": [9, 10, 11, 14, 15, 16, 17] }
```

单位是 ¥ / 百万 token，`peakHours` 是北京时间高峰小时。**改这里会同时改变 `/token` 的口径**；管理端面板仍读它自己的 `localStorage`，需各自设置。

### 15.5 审计与工具流水

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 反馈落盘 | `audit.js:51` `appendFeedbackEntry` | `state/feedback.json`；`entry.message` 先 `redactSensitiveText`；超过 500 条则 `splice(0, len - 500)` |
| 工具调用流水 | `audit.js:76` `appendToolLog` | `state/tool-calls.jsonl`；`error` 脱敏、`args` 逐层 JSON.parse（最多 4 层）后 `redactSensitive`；超 2000 行只保留最后 2000 行 |
| 读流水 | `audit.js:62` `readToolLog(limit = 200)` | 取尾部 `min(1000, max(1, limit))` 行，坏行跳过 |
| 静默模式拒发 | `shouldBlockSilentReply(key)`（`audit.js:19`） | 读 `state/current-role.json` 的 `{role, mode}`；`mode === 'silent'` 且非主人私聊 → 返回 true；调用点在 `console-server.js` 的 9 处发送端点，统一回 403 `静默模式已开启，当前不允许发送` |
| 敏感拦截的日志 | `audit.js:24` `handleSensitiveIntercept` | **只写日志与活动记录，不执行拦截**（见 §2「敏感内容拦截」与 §19） |

工具调用流水样例（`state/tool-calls.jsonl` 尾部实测）：

```json
{"type":"call","time":"2026-09-07T13:42:57.929Z","key":"group:868756515","sessionId":"session-bbc94ded-…","tool":"mcp__napcat__qq_mark_read","args":"{\"key\":\"group:868756515\",\"token\":\"***\"}"}
{"type":"result","time":"2026-09-07T13:42:58.022Z","key":"group:868756515","sessionId":"session-bbc94ded-…","tool":"mcp__napcat__qq_mark_read","ok":true,"error":null}
```

用量行样例（`state/token-usage.jsonl` 尾部实测）：

```json
{"tsMs":1788799344167,"sessionId":"session-2528df79-…","convKey":null,"prompt":9649,"completion":20,"total":9669,"est":false,"promptChars":0,"completionChars":0}
```

### 15.6 失败与降级

| 场景 | 降级 | 证据 |
| --- | --- | --- |
| 计量落行 IO 失败 | 置 `meter.lastErr`，返回 `{recorded:false, reason:'io-error'}` | `token-meter.js:416-420` |
| 对账目录/文件缺失 | `{ok:false, reason:…}`，不影响主流程 | `token-meter.js:905-915` |
| 对账落盘失败 | 回滚水位，下次重来 | `token-meter.js:997` |
| 会话日志解析失败 | 沿用上次结果 + 一行日志 | `context-savings.js:256-261` |
| 无 DSH home | `[savings] 未找到 DSH home，跳过剪枝计量（面板不显示该项）` | `bridge.js:390` |
| `/token` 读取异常 | `{ok:false, text:'用量库读不出来：…'}`，QQ 侧收到同类文本 | `token-report.js:123-124`、`mux.js:493-496` |

管理端面板：`src/pages/Learning.tsx`，`COST_DEFAULT` 与 `qq-bridge/src/core/config.js` 的 `tokenCost` 同源。

---

## 16. 工具裁剪与描述压缩（省钱的开关）

### 16.1 四个开关

| 开关 | 位置 | 语义 |
| --- | --- | --- |
| `social.slimTools.level` | `qq-bridge/src/lib/tool-tiers.js` | `off` / `low` / `medium` / `high` / `extreme` / `custom`。**白名单语义**：不在名单里的工具根本不注册 |
| `social.slimTools.schemaLevel` | `qq-bridge/src/lib/tool-schema-compress.js` | `off` / `medium` / `high`。压的是**描述文字**，工具与参数一个不少 |
| `social.toolCompressor` | `qq-bridge/src/lib/dsh-side.js` | MCP 压缩代理：`enabled`（默认恒开）、`level`（`low`/`medium`/`high`/`max`）、`excludeTools`、`toonify` |
| `social.tools.*` | `qq-bridge/src/core/config.js:320-353`（深合并后的最终名单，共 **31** 个键） | **调用期**开关：只在调用时返回 403，**不减少请求体积**。判定式 `const ToolEnabled = (flag) => cfgRef.social?.tools?.[flag] !== false;`（`console-server.js:576`），**除 `setStickerRemark` 默认 `false` 外全为 `true`** |

`tool-tiers.js`（226 行）里的名单来源：`ESSENTIAL`（11 个，含 `get_time`）、`OBSERVED_USED`（17 个，调用次数来自 1108 条工具调用日志）、`CHEAP_EXTRA`、`GROUP_AWARENESS`；度量函数 `measureSchemaShare(tools, keptNames, droppedNames)`。

档位在注册期生效（`registerTool`，`mcp-napcat-safe.js:734`）：每个工具注册时把 schema 开销记进 `schemaMeter`，档位不允许则提前 return，进程退出时把统计写进 `state/tool-schema-stats.json`。环境变量：`QQB_SCHEMA_STATS_ONLY=1`、`QQB_SCHEMA_LEVEL`、`QQB_SLIM_TOOLS_OFF`。

### 16.2 实测体积

`state/tool-schema-stats.json` 实测（`2026-09-24T14:12:34.805Z`，当前生效档位 `level: "custom"`、`schemaLevel: "off"`）：

| 字段 | 值 |
| --- | --- |
| `registered` | 73 |
| `available` | 91 |
| `totalChars` | 92879 |
| `keptChars` | 85583 |
| `share` | 0.9214 |
| `approxTokensPerStep` | 26745 |
| 档位 `off` | share 1.0，保留 91 |
| 档位 `low` | share 0.8231，保留 68 |
| 档位 `medium` | share 0.4101，保留 42 |
| 档位 `high` | share 0.338，保留 33 |
| 档位 `extreme` | share 0.07，保留 9 |
| 档位 `custom` | share 1.0，保留 91 |

单工具最贵的几个（同文件）：`qq_send_pixiv` **6148** 字符、`qq_send_rich` **5118**、`qq_pixiv_search` **4155**、`qq_set_wake_config` **3087**、`qq_send_message` **2925**、`qq_send_image` **2726**、`qq_send_qzone` **2578**、`qq_send_voice` **2478**、`qq_send_forward` **2007**、`qq_set_system_config` **1916**、`qq_memory_remember` **1798**、`qq_send_meme` **1677**。

既有文档另有一组"91 个 napcat 工具 97,908 字符"为基准的百分比（`off` 100% / `low` 81.2% / `medium` 39.7% / `high` 33.0% / `extreme` 7.1%）。两组数据的绝对字符数不同（97,908 vs 92,879），**差异成因未验证**（可能是生成文件口径与运行期实测口径不同，或工具描述在两次测量之间改过）；百分比形状一致。

> 关键认知（`tool-tiers.js:3-6`）：工具 JSON schema 合计约 9.8 万字符 ≈ 3.1 万 token/**步**，而一次请求的 system 只有约 5.4 万字符 —— **工具描述本身就是请求体里最大的一块，而且每一步都重发一遍**。结论：**少注册一个用不到的工具，比把提示词写短几个字重要两个数量级。**

改动 `social.slimTools` 后**需要重启隔离 DSH**（注册期生效）；`social.tools.*` 不需要。

### 16.3 模型能自改哪些键

`qq-bridge/src/core/tunables.js:13-57` 的 `TUNABLE_SPECS` 是**源码内字面量数组**（不是从配置推导），共 **32** 项，即允许模型自改的配置键全集：`proactive` 8 项、`replyCheckMs`、`wake` 2 项、`dndWindows`、`proactiveFreshOnly`、打字节拍 5 项、`typing` 4 项、模型 6 项（`dsh.provider` / `dsh.model` / `dsh.visionModel` / `dsh.visionBaseUrl` / `dsh.visionApiKey` / `dsh.reasoningEffort`）、上下文治理 3 项（`social.autoReset.permanent`、`dshCompaction.enabled`、`dshCompaction.thresholdRatio`、`dshCompaction.toolResultMaxChars`）。

链路：MCP `qq_get_system_config` / `qq_set_system_config` → `GET|POST /api/social/tunables`（`console-server.js:4686-4730`）→ `applyTunable(spec, raw)`（写内存 + 落盘 `config.json`）→ `modelGroup` 项额外 `syncDshAgentDefaultModel()`，`proactive*`/`idleThresholdMs` 额外 `rearmProactiveTimersAfterChange()`。

鉴权 `trustLevelForToken(token)`：`owner-private`（主人私聊且 token 相符）或 `trusted-spoke-here`（本会话最近一条**别人**发来的消息是主人且 10 分钟内）；失败 403，文案 `这个只有主人或管理员能改：私聊里直接说，或在群里等主人/管理员亲口说那句（10 分钟内有效）。`

被夹时回包显式标注 `requested` / `clamped: true` / `note`：

```
要的是 ${reqNum}，实际只能到 ${v}（「${spec.label}」允许范围：${lim.join(' / ')}）。请把实际生效值如实告诉主人，别只说"改好了"。
```

---
## 17. 管理端功能面（`server/index.js` 与 `src/pages`）

### 17.1 载体、端口与代理模型

管理端 = `server/index.js`（10,122 行 / 633,446 B）提供的 REST 服务 + `src/` 下的 React 页面（`src/App.tsx`、`src/api.ts` 56,685 B、`src/config-cache.ts` 38,165 B）。服务只监听 `127.0.0.1`：`PORT = process.env.QBM_API_PORT || 1921`（`server/index.js:9605-9607`）；`QBM_NO_LISTEN=1` 时只导出 `app`（测试用）。全局护栏：`unhandledRejection` / `uncaughtException` **只记日志不退出**（`:9598-9603`）。SPA 兜底 `app.get(/^\/(?!api\/).*/, …)`（`:9590`，`no-store` + `dist/index.html`）。

桥侧数据一律优先走**代理** `proxyToBridgeConsole`（`:7382`，默认超时 `30000`），失败时给出结构化错误码：

| 错误码 | 含义 | 判定 |
| --- | --- | --- |
| `bridge-offline` | 桥没跑 / 桥隧道不在 / 超时或令牌不对 | `:7340-7377`（含"服务器已连接但 Bridge 隧道不在"的专门提示） |
| `bridge-stale` | 桥在跑但 404 或非 JSON | `:7328-7338`，文案"把桥更新到最新并重启" |

页面共 10 个（`src/pages/`，实测字节）：`BridgeConfig.tsx` 293 KB、`Learning.tsx` 172 KB、`GroupPortrait.tsx` 90 KB、`VoiceConfig.tsx` 55.5 KB、`SSHConfig.tsx` 50 KB、`Home.tsx` 35 KB、`NetCanvas.tsx` 31.8 KB、`ChatHistory.tsx` 27.7 KB、`InstanceConfig.tsx` 23.4 KB、`WebView.tsx` 10.5 KB。组件 `src/components/NapcatTokensCard.tsx`、`Dropdown.tsx`、`NumInput.tsx`、`NoticeBar.tsx`。

### 17.2 页面 → 接口 → 配置字段

| 页面 | 主要调用 | 落到的端点 / 配置字段 |
| --- | --- | --- |
| `Home.tsx` | `getState`、`remoteStackById`、`sshServiceAction`、`startAllInstances`、`instanceAction` | `GET /api/state`、`POST /api/ssh/stack`、`POST /api/ssh/service`；只读状态 + 动作 |
| `InstanceConfig.tsx` | `postConfig`、`instanceAction`、`instanceLogs` | `POST /api/config`；字段 `instances.dshIsolated.{port,profile,dshCli,isolatedHome,enabled}`、`instances.napcatLocal.{quickLogin,webuiPort,killOnExit,launchCommand,workDir,installDir}`、`instances.bridgeLocal.{workDir,webuiPort}`，写回形状 `{instances:{[key]:value}}` |
| `SSHConfig.tsx` | `postConfig`、`deployStart/deployStatus/deployTasks`、`syncBridge`、`removeServerStack`、`remoteStack*` | `servers[]`：`{id?, name, host, port(默认 22), username(默认 root), authType:'password'\|'key', password, privateKey, passphrase, remotePorts{…}}`；`activeServerId`、`autoConnectServer`、`servers[].autoConnect`（默认自动，`server/index.js:9629`） |
| `BridgeConfig.tsx` | `getBridgeConfig`/`saveBridgeConfig`、`getRemoteBridgeConfig`/`saveRemoteBridgeConfig`、`resetSpeechRules`、`getToolSchemaStats`、`getContextOverhead`、`getMemoryStats`、活动时段、方案（profiles）、表情包、角色库、`ownerQQ` | `GET\|POST /api/bridge/config`；`target === 'remote'` 时改走 `GET\|POST /api/ssh/bridge-config`；页签 `common / tools / persona / json / profiles`；写回 `writeBridge({config: next})` |
| `Learning.tsx` | `getLearningConfig`/`saveLearningConfig`、`slangAction`、`personaAction`、`personaApply`、`portraitAction`、`getSlangLibrary`、批量确认/拒绝/删除、`research`、`getTokenReport`、`reconcileTokens`、`GET /api/learning/token-stream`（SSE） | `learning-config.json`（桥侧权威，管理端只代理或降级直读） |
| `GroupPortrait.tsx` | `getLearningGraph`、`getLearningGroups`、`getOwnerProfile`、`getPersonMessages`、`getPersonProfile`、`getPortraitCfg`/`savePortraitCfg`、`getRelations`/`saveRelation` | `~/.qq-bridge-manager/portrait-config.json`、`relations.json`、画像与图谱 SQLite |
| `VoiceConfig.tsx` | 直接 `api()`：`GET/PUT /api/voice/config`、`GET/POST/DELETE /api/voice/voices`、`POST /api/voice/test`、`POST /api/voice/preview` | 桥侧 `state/voice-config.json`（注释 `server/index.js:7391`）；支持 `?scope=local\|remote` 与 `clearKeys[]` |
| `ChatHistory.tsx` | `getChatStats`、`getChatConvs`、`getChatMessages`、`deleteChatHistory` | `/api/bridge/chat-*`；本机桥不可达时管理端**直读 SQLite**（`server/index.js:5028-5029` 注释） |
| `WebView.tsx` | `getNapcatWebuiReady`、`getState` | 只读 |
| `NetCanvas.tsx` | 未发现 `/api` 或 `api()` 调用（grep 为空） | **数据来源未验证** |

### 17.3 `/api/*` 路由分组

实测 `server/index.js` 共 **93 条** `app.<method>('<path>')` 注册（判据：排除整行注释后，正则 `app\.(get|post|put|delete|patch)\(\s*'` 命中 93 处，其中 `/api/` 前缀者同为 93；若把 `app.use(...)` 一并计入则为 94）。按功能分组（行号为注册行）：

| 组 | 端点（节选） |
| --- | --- |
| 配置与状态 | `GET /api/config` 2951、`POST /api/config` 2965、`GET /api/state` 3004、`GET /api/connect` 2959（**8025 处重复注册，后者不可达，未运行验证**）、`GET /api/open` 3102 |
| 本机实例 | `POST /api/instance/:id/:action` 3210（`id ∈ {napcat-local, dsh-isolated, bridge-local}`，`action ∈ {start,stop,restart}`）、`POST /api/instance/start-all` 3244、`GET /api/instance/:id/logs` 3283 |
| NapCat | `GET /api/napcat/launchers` 2909、`POST /api/napcat/install-qq` 2936、`GET\|POST /api/napcat/tokens` 7948/7957、`GET /api/napcat/webui-ready` 8046、`GET\|POST /api/napcat/guard` 8123/8124、`POST /api/napcat/guard/heal` 8125、`POST /api/napcat/quick-password` 8126、`GET /api/napcat/qr` 8131、`GET /api/napcat/login-stream` 8495（SSE） |
| SSH 与隧道 | `POST /api/ssh/test` 3434、`/connect` 3487、`/disconnect` 3523、`/sync` 3843、`/remove-stack` 4209、`/stack` 4260、`/service` 4327、`GET /api/ssh/status` 7262、`GET\|POST /api/ssh/bridge-config` 7110/7130、`POST /api/ssh/deploy/start` 9532、`GET /api/ssh/deploy/status` 9564、`GET /api/ssh/deploy/tasks` 9571 |
| 桥配置与数据 | `/api/bridge/tool-schema-stats` 4673、`/api/bridge/context-overhead` 4771、`/api/bridge/memory-stats` 4780、`GET\|POST /api/bridge/config` 4821/5546、`/api/bridge/activity-hours` 4889/5408、`/api/bridge/activity-targets` 4924、`/api/bridge/chat-stats` 5191、`/api/bridge/chat-stream` 5216、`/api/bridge/chat-convs` 5300、`/api/bridge/chat-messages` 5333、`POST /api/bridge/chat-delete` 5373、`POST /api/bridge/speech-reset` 5780、`GET /api/bridge/characters` 5881、`POST /api/bridge/characters/import` 5901、`POST /api/bridge/upload` 5935、`POST /api/bridge/stickers/upload` 5958、`/api/bridge/meme-packs*` 6264/6299/6435/6475、`GET\|POST /api/bridge/owner-qq` 7978/7999 |
| 方案 | `GET /api/profiles` 5735、`POST /api/profiles` 5740、`POST /api/profiles/:id/delete` 5767 |
| 学习 / 黑话 / 画像 | `/api/learning/config` 7598/7599、`/api/learning/slang` 7600、`/persona` 7601、`/portrait` 7602、`/persona-apply` 7650（`timeoutMs 180000`）、`/api/slang/batch-confirm\|batch-delete\|batch-reject` 7644/7646/7647、`/api/slang/research` 7648、`/api/learning/token-report` 8315、`/token-reconcile` 8397、`/slang-library` 8437、`/token-stream` 8441、`/profile` 8769、`/graph` 8933、`/owner-profile` 9052、`/messages` 9101、`/portrait-config` 9136/9137、`/groups` 9147、`/relations` 9184/9185、`/relations/auto` 9431 |
| 语音（代理，`?scope=local\|remote`） | `GET\|PUT /api/voice/config` 7629/7630、`GET\|POST /api/voice/voices` 7631/7632、`DELETE /api/voice/voices` 7633、`POST /api/voice/preview` 7639、`POST /api/voice/test` 7640 |
| 守卫与退出 | `POST /api/guardian/arm` 10016、`POST /api/shutdown` 10040（体 `{all}`） |

### 17.4 配置字段与凭据通道

桥 `config.json` 的字段全集（`qq-bridge/config.example.json` 逐键）：`dsh{baseUrl,provider,model,reasoningEffort,apiKey,visionModel,visionBaseUrl,visionApiKey}`、`dshCompaction{enabled,thresholdRatio,retainRatio,toolResultMaxChars}`、`napcat{wsUrl,httpUrl,accessToken,launcherPath,homeDir,allowProcessControl,wsAccessToken,imageFileMode,tmpDir,dockerPathMap}`、`pixiv{base,cookie,refreshToken}`、`ownerQQ`、`guard{enabled,probeIntervalMs,failThreshold,cooldownMs,maxHealsPerHour,restartGraceSec,recoverWaitMs,autoHeal}`、`sessionCwd`、`agentPreset`、`workspaceTitle`、`allow{private,groups}`、`deny{private,groups}`、`allowAllWhenEmpty`、`allowAllPrivate`、`allowAllGroups`、`ackMessage`、`sendDelayMs`、`questionTimeoutMs`、`consolePort`、`consoleToken`、`prompt{styleLine}`、`tokenCost{pHit,pMiss,pOut,peakMult,peakHours}`、`security{interceptNotify}`、`slang{…}`、`social{enabled,autoReplyCheckMs,agentPreset,provideRecommendations,tools{…25 键},wake,send,wait,sticker,meme,proactive,feedback,context,autoReset,sessionArchive,steerEnabled,charactersDir,slimTools{level,schemaLevel,deny},turnHold{…},typing{…},toolCompressor{enabled,level,excludeTools,toonify}}`。

**接口密钥不进 `config.json`**：`config.dsh.apiKey` 与 `clearApiKey` 在落盘前被摘除（本机 `server/index.js:5555-5560`，远端 `:7142-7144`），改写入隔离 DSH 的 `.credentials.yaml`。纯逻辑在 `server/iso-credential.js`：`mergeCredentialText`（:87）、`credentialRefsBlock`（:21）、`yamlScalar`（:59）、`credentialStatusFromText`（:125）、`validateCredentialDocument`（:140）；要求顶层只有 `version/refs/records`，密钥缩进 2 格写在 `refs:` 下。管理端写入辅助 `writeIsoCredential`（:5521，`0600` + `.bak-<时间戳>` 备份）、`isoCredentialStatus`（:5540，**只回 `set`/`len`，绝不回值**）、`providerApiKeyEnv`（:5495）、`isoHomeDir`（:5461）。

远端 `config.json` 的写入是"临时文件 → `.bak-<时间戳>` → 原子 `mv` → **回读比对**"（`:7146-7171`），`verified` / `mismatched` 如实回前端；桥侧 `POST /api/bridge/config` 同样是深合并 + 备份 + 原子 rename（`:5571-5594`）。

### 17.5 降级路径

| 场景 | 行为 | 证据 |
| --- | --- | --- |
| 桥控制台不可达 | 返回 `bridge-offline`（区分"桥没跑"与"隧道不在"/"超时或令牌不对"） | `server/index.js:7340-7377` |
| 桥版本旧（404 / 非 JSON） | 返回 `bridge-stale` + "更新桥代码并重启" | `:7328-7338` |
| 学习配置端点桥不可达 | 仅在**确实连不上**时降级：本机直读/写文件，远端走 SSH 读写（备份 + 原子 mv + 回读比对） | `:7421-7435`、`:7567-7572` |
| 本机桥不可用但要看聊天记录 | 管理端直读 SQLite | `:5028-5029` 注释 |
| 管理端自身异常 | `unhandledRejection` / `uncaughtException` 只记 `[fatal-guard]` 不退出 | `:9598-9603` |

### 17.6 随包 QQ 的黑框隐藏器

`startNapcatHidden(onekey, quickLogin)`（`server/index.js:1291`）在拉起 NapCat 之前先把**随包 QQ 的窗口**藏掉。实现是往宿主机投放一段常驻 C# 脚本（`qqWindowHiderScript(cfg)`，`:1348`，类名 `MoonBotQqWinHideResident`，脚本首行 `# MoonBot QQ window hider (resident) - generated by server/index.js`），常驻实参 `QQ_HIDER_DEFAULTS = { budgetMs: 43200000, pollMs: 200, burstMs: 50, burstWindowMs: 5000, readyTimeoutMs: 2500 }`（`:1336`）：

| 参数 | 值 | 含义 |
| --- | --- | --- |
| `budgetMs` | `43200000`（12 小时） | 观察者自己的存活上限，到点 `exit 0`——需求是"NapCat 在跑的全程都不许冒黑框"，真正的退出条件交给父进程守卫 |
| `pollMs` | `200` | 常态轮询间隔 |
| `burstMs` / `burstWindowMs` | `50` / `5000` | 随包 QQ 一露面就切 50 ms 快扫，持续 5 秒 |
| `readyTimeoutMs` | `2500` | 等待条件就绪的上限 |

配套机制：活儿着的隐藏器登记在 `qqHiders`（`Set`，`:1338`，注释"重启 NapCat 时新的会把旧的收掉，绝不叠着跑"）；目标 pid 由"seed 文件"传递——管理端拉起启动器后把 pid 写进去（`:1353` 注释）。**路径守卫是硬条件**：只处理"可执行文件路径在本 Shell 目录之下"的进程（`:1325-1330` 注释）。`startNapcatHidden` 的启动器/命令行拼装未逐行核实。

---

## 18. 部署、开机自动连接与退出守卫

### 18.1 端口与进程

| 服务 | 默认端口 / 位置 | 定义处 |
| --- | --- | --- |
| OneBot HTTP | `3000`（`napcat.httpUrl`，默认 `http://127.0.0.1:3000`） | `qq-bridge/src/core/napcat-tokens.js:282/383/398` |
| OneBot WebSocket | `3001`（`napcat.wsUrl`，默认 `ws://127.0.0.1:3001`） | `qq-bridge/src/core/config.js:70` |
| NapCat WebUI | `6099`（`instances.napcatLocal.webuiPort`） | `server/index.js:64`、`napcat-tokens.js:415` |
| 桥控制台 | `3100`（`consolePort`，只监听 `127.0.0.1`） | `qq-bridge/src/core/console-server.js:6044` |
| 隔离 DSH | `10721`（`dsh.baseUrl`） | `qq-bridge/src/core/config.js:20-24` |
| 远程隧道 | NapCat WebUI `13000`、DSH `13080`、桥 `13100` | `server/index.js:192`、`6697` |

桥控制台鉴权只在 `config.consoleToken` 合法时才开（`console-server.js:540-546`）——当前 `config.json` 中该键为空，即**本机 3100 不鉴权**，仅靠 `127.0.0.1` 绑定。`state/console-token` 文件现在只有 `mcp-host-server.js:65` 在读，控制台已不再生成。

### 18.2 退出守卫（`server/napcat-guardian.mjs`）

**目的**：后端（或应用本体）消失后，把 NapCat、桥、隔离 DSH 一并收掉——**关窗即杀子进程**。

触发链：每 `setInterval(…, 2000)` 调 `alive(parentPid)`；父进程消失后等 `graceMs`（默认 `30000`，`--grace` 可改）二次核对 guard 文件；若 `currentGuardPid() !== process.pid`（说明是"管理器重启"、已归新后端所有）则静默 `exit(0)`；否则 `shutdownAll()`。

三条清理命令（都走 `powershell.exe -NoProfile -Command`，`stdio: ignore`，timeout 20000）：

- 停 NapCat：`Get-Process NapCatWinBootMain,QQ -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne <self> -and ($_.Path -like '<dir1>*' -or …) } | Stop-Process -Force`（`--dirs` 为空则整段跳过）
- 停桥：`Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='qbm-node.exe'" | Where-Object { $_.ProcessId -ne <self> -and $_.CommandLine -like '*<bridge.js 绝对路径>*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
- 停隔离 DSH：同上，匹配 `'*--port <dshPort>*'`

收尾删除 guard 文件。参数：`--parent`（默认 `'0'`）、`--guard-file`、`--dsh-port`、`--bridge-script`、`--grace`、`--kill-napcat`（默认 `'1'`）、`--dirs`（默认 `'[]'`）、`--log`。安全边界：缺 `--parent` 直接退出；`--kill-napcat 0` 只跳过 NapCat；`dirs` / `bridgeScript` / `dshPort` 无默认值。

武装方是管理端：`GUARDIAN_FILE = join(CONFIG_DIR, 'napcat-guardian.json')`，`CONFIG_DIR = join(homedir(), '.qq-bridge-manager')`、`LOG_DIR = join(CONFIG_DIR, 'logs')`（`server/index.js:43/45/9863`）。`armNapcatGuardian(watchPid, opts)` 传 `--dsh-port 10721`、`--bridge-script <RUNTIME_ROOT>\qq-bridge\src\bridge.js`、`--log <LOG_DIR>\napcat-guardian.log`；脱身手段 `spawnGuardianDetached` 用 `guard-node.exe` 硬链接 + WMI `Win32_Process.Create`（`Win32_ProcessStartup.ShowWindow = 0`）；自动武装策略 `ensureGuardianArmed()` 认 `QBM_NAPCAT_GUARDIAN=0`（关）/`=1`（强制），父进程名匹配 `/^MoonBot$/i`，否则找 `MoonBot.exe`，复查定时器每 `60000 ms`；另有手工 `POST /api/guardian/arm` 与体面收摊 `POST /api/shutdown`（`killOnExit=false` 时跳过 NapCat）。

实测日志（`~/.qq-bridge-manager/logs/napcat-guardian.log`，171,290 B，2026-09-24 完整一轮）：

```
[napcat-guardian] 守卫启动：父进程=58100 托管目录=3 个 宽限=30000ms 收NapCat=true guardFile=C:\Users\17367\.qq-bridge-manager\napcat-guardian.json
[napcat-guardian] 父进程 58100 不在了，30000ms 后复核 guard 文件再决定是否动手
[napcat-guardian] 已按目录前缀停 NapCat：…
[napcat-guardian] 已停桥接进程（只匹配 …\bridge.js）
[napcat-guardian] 已停隔离 DSH（--port 10721）
[napcat-guardian] 收拾完毕，守卫进程退出
```

`manager.log` 侧对应 `[guardian] 已武装：pid=52592（C:\Program Files\nodejs\node.exe）盯应用进程=43284 托管目录=3 个（应用关闭时会一并收掉 NapCat/桥/DSH；killOnExit=true）`，以及硬链接降级告警 `[guardian] 硬链接失败（…）：EPERM…`（此时仍靠 WMI 脱身）。

### 18.3 NapCat 运行时完整性自检与自修（`server/napcat-repair.js`）

**用途**：随包 NapCat 的 `napcat.mjs` 引用同目录一个文件，而该文件缺失——启动即崩：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...\conout-D9oph_Le.js' imported from '...\napcat.mjs'
```

打包仓库 `moonbot-app\runtime-full` 的 `napcat.mjs` 引用 `conout-D9oph_Le.js`，而同目录只有 `conout-wiJ7YKRd.js`（`napcat-repair.js:4-14` 逐字记录根因）。

逐条修复项：

1. `findNapcatApps(root = RUNTIME_ROOT)`：递归收集所有 `napcat.mjs`，深度上限 `if (depth > 8) return;`。
2. `checkNapcatApp(mjsPath)`：读 `napcat.mjs` → `relativeSpecifiers(text)` 抠出四类相对导入（`from "x"`（含 re-export）、副作用 `import "x"`、动态 `import("x")`、`require("x")`），只收 `./` `../` 且扩展名 `js|mjs|cjs|json` → `missing = refs` 里磁盘上不存在的。
3. `repairNapcatApp(mjsPath)`：先 `check`，完好即返回 → `findShellZip(dir)` 向上最多 10 层找 `NapCat.Shell.zip` 并要求同目录有 `7z.exe` → 逐个缺失成员执行

   `spawnSync(<dir>\7z.exe, ['e', <dir>\NapCat.Shell.zip, <member>, '-o<dir>', '-y'], { encoding:'utf8', windowsHide:true })`

   判据 `status === 0 && 文件已存在` → 复检。
4. `ensureNapcatApps({ root, fix, log })`：逐个分类 `ok` / `repaired` / `broken`，返回 `{ ok, checked, broken, repaired, detail, error }`。
5. CLI：`node server/napcat-repair.js [--check|--fix] [--root <dir>]`，打印 `[napcat-repair] root=… 检查 N 个，坏 M 个，补回 K 个 → OK/仍有问题：…`，退出码 `process.exit(r.ok ? 0 : 1)`。

调用点：`server/index.js:2344` 在拉起 NapCat 之前调 `ensureNapcatApps({ root: RUNTIME_ROOT, fix: true, log })`，结果文案 `[napcat] 完整性自检：检查 N 个 / 坏 M 个 / 补回 K 个 → 已修复`。相邻的自愈还有 BOM 剥除 `healNapcatJsonBom`（`index.js:2354-2361`）与 VC++ 运行库摆放（`:2362-2364` 起，**未逐行核实**）。

### 18.4 部署与开机自动连接

### 18.4.1 SSH 连接与隧道

涉及文件：`server/deploy.js`（1,652 行，克隆部署主体）、`server/index.js`（连接/隧道/启停/同步/部署入口）、`server/connect-machine.js`（149 行，连接阶段状态机，纯逻辑）、`server/iso-credential.js`（162 行，凭据 YAML 纯逻辑）、`qq-bridge/start-bridge.sh`（服务端起桥脚本）。

`connectOne`（`server/index.js:447-474`，`deploy.js:51-65` 同款）：`{host, port: server.port || 22, username, password?（authType==='password'）, privateKey?（authType==='key'，读文件失败给人话提示）, passphrase?, tryKeyboard: true, readyTimeout: 15000, keepaliveInterval: 30000}`；本地 15 s 超时，`deploy.js` 侧 20 s。

隧道表 `tunnelMapFor`（`:189-197`）：

| 服务 | 远端 → 本地 |
| --- | --- |
| NapCat WebUI | `6099 → 13000` |
| NapCat HTTP | `3000 → 13001` |
| DSH Web | `3080 → 13080` |
| 桥控制台 | `3100 → 13100` |

远端端口可由 `server.remotePorts.{napcatWebui,napcatHttp,dshWeb,bridge}` 覆盖。`openTunnels` 整体 8 秒超时（`:232`），`EADDRINUSE` 退避重试最多 4 次 × 400 ms（`:217-221`）；`ensureTunnels` 每次取状态自愈补建缺失项（`:240-261`）。

重连退避 `RECONNECT_BACKOFF_MS = [5000, 10000, 20000, 30000, 60000]`（`:289`）；冷却期不硬试，改为冷却结束补一次（`:352-359`）；用户主动"断开"的机器不自动重连（`manualDisconnects`，`:283/333`）；主动替换旧连接时用 `replacingConnections` 标记，避免"换连接 → close → 重连"空转（`:287/308-313/336`）。

### 18.4.2 开机自动连接

`app.listen` 回调（`server/index.js:9606-9656`）依次：`scheduleAutoStart()`（:9609）→ `ensureGuardianArmed()`（:9610）→ **1500 ms 后**启动自动连接（:9621-9648）→ 每 60 秒复查守卫（:9651-9652）。

自动连接判据（:9624-9647）：`cfg.autoConnectServer === false` → `connectMachine.idle('已配置为不自动连接服务器（SSH 配置页可改）')` 并返回；无 `activeServerId` 或无对应 server → idle；`srv.autoConnect === false` → idle；已在 `sshConnections` → 直接 ready；**冷却中** → `connectMachine.fail(...)` + `scheduleReconnect(srv.id, 'startup')`；否则清掉 `manualDisconnects` 后 `connectStep(srv, 'startup')`，成功则后台 `waitServerReady(srv, 'startup')`，失败则排重连。

阶段状态机 `PHASES = ['idle','connecting','tunnels','server-starting','warming','ready','failed']`（`connect-machine.js:19`）；`describeRemoteStatus` 把 DSH / NapCat / 桥翻译成 `ready|starting|down`（`:35-73`，NapCat 端口取 `remote.remotePorts.napcat || napcatWebuiPort || 6099`）；`createConnectMachine().view()` 字段 `{phase,note,serverId,serverName,components,attempts,lastError,since,updatedAt,elapsedMs,warm}`。

`waitServerReady`（`:402-441`）= 轮询 `getRemoteServerStatus(force: true)`，`waitServerMs = 150000`、`pollMs = 4000`；就绪即 ready（**预鉴权已删除**）；整套没跑（`d.down`）立即 break；超时 fail 并排 `scheduleReconnect(server.id, 'server-not-ready')`。

本机实例自启 `scheduleAutoStart()`（`:10077-10118`）：`cfg.autoStartOnBoot === false` 直接跳过；顺序 `['napcat-local', 'dsh-isolated', 'bridge-local']`；条件 `instances[key].enabled === true` 且 `instances[key].autoStartOnBoot !== false`；逐个 `startInstanceTracked(id, loadConfig(), { wait:false })`，间隔 1200 ms。

### 18.4.3 SSH 部署流程（`server/deploy.js`）

任务注册表 `deployTasks: Map<taskId, {lines, status, updatedAt}>`（`:25`），`taskId = deploy-<base36 时间>-<2B hex>`（`:1632`），日志上限 800 行（`:46`），完成后保留 1 小时（`server/index.js:9566`）。步骤函数 `step()` 失败即抛，`safely()` 失败仅记 `(跳过)`（`:1059-1073`）。

主流程 `runDeploy(taskId, source, target, opts)`（`:1046`，主体 `:1075-1613`）：

0. 连接两端（本机源只连目标）→ 0b 模板机 `/root` 磁盘预检（`qqData=false` 需 500 MB，否则 1000 MB，不够直接抛）。
1. `ensureTargetEnv` 无条件自愈（node/npm 失败即抛并说明已试三种装法）。
2. 装 `@deepseek-ai/dsh`：目标机已有版本则**跟随**，否则用 `opts.dshVersion || localDshVersion()`；装完等 bin 最多 5 × 2 s，仍没有就写 `/usr/bin/dsh` 包装脚本，最后 `dsh --version` 复核出 `DSH_OK`。
3. 装 `mcp-compressor==0.31.9`——**失败只警告**（注释明说仓库内无调用）。
4. 源机停机打包，随后**立即恢复**（`systemctl start dsh-web`、`napcatCtlCmd('start')`、`pgrep -f 'node src/bridge.js' || (cd /root/qq-bridge && rm -f state/bridge.lock && nohup bash start-bridge.sh …)`）。
5. `streamPipe` 流式转发直接解包（超时 `1800000`，`:99`）。
6. 目标机装配：systemd 单元（本机源**现场生成** `/etc/systemd/system/dsh-web.service`）

   ```
   [Service]
   Environment=DSH_HOME=/root/.dsh
   EnvironmentFile=-/etc/qq-bridge.env
   ExecStart=<dsh bin> --profile web --port 3080 --no-open --trusted-host 127.0.0.1:3080
   Restart=always / RestartSec=3
   StandardOutput=append:/root/.dsh/dsh-web.log
   StandardError=append:/root/.dsh/dsh-web.log
   ```

   日志落文件是**硬要求**：桥靠其中的 `?token=` 换 cookie。环境变量从源机 `.bashrc` grep `^export (MIMO_API_KEY|OPENCODE_ZEN_API_KEY|DEEPSEEK_[A-Z_]*|LLM_[A-Z_]*|.*API_KEY)=` 追加过去，并写 `/etc/qq-bridge.env`（`chmod 600`）+ drop-in `dsh-web.service.d/env.conf`；本机源**不导出**（凭据随 `.credentials.yaml` 过去）。启动用 `systemctl enable` + **`restart`**（旧代码用 `enable --now`，对 running unit 是 no-op，导致新配置/插件不生效），`sleep 5` 后 `curl -m 5 127.0.0.1:3080`——**401 也算活**。

保留与清理：`buildDeployKeepScript()`（`:366-423`）保目标机 `config.json / persona.md / state`，先把可保留项拷到 `/root/qqbridge-keep-<ts>`；`buildStagePlan`（`:424`）逐包打包（qq-bridge / dsh-home / napcat-config / napcat-app / qqdata / meme），`napcat-app` 与 `napcat-config` 落地按 `napcat-mode`（native → `/opt/napcat`，否则 `/root/napcat`）；登录态 native 在 `/home/qq/.config/QQ`，docker 在卷 `napcat-qq`。`/api/ssh/remove-stack` 先把目录 **mv 到** `/root/qq-bridge-removed-<ts>` 而非删除（`:4226`）。

### 18.4.4 幂等与失败路径

- 幂等：`/api/ssh/stack` 文件头明确"已经启动/已经停止都算成功"（`:4257-4259`）；`/api/ssh/service` 按**动作方向**判成败（`upRe = /dsh-web=active|::Up |bridge-started/`、`downRe = /dsh-web=inactive|::Exited|^stopped$/`，`:4376-4378`）；`installToIsolatedDsh` 靠 marker 跳过；`ensureTunnels` 只补缺失；`/api/ssh/sync` 用 `tar` 覆盖后**还原远端 config.json**（`:3876-3892`，防"桥每次连上 NapCat 就被踢"的事故）。
- 失败：SSH 冷却（`sshCooldownInfo` `:3343`，冷却期内 `/api/ssh/test`、`/connect` 直接回结构化冷却体）；私钥读不到给人话；部署磁盘不足 / node 装不上 / dsh 装不上 / unit 写失败 / dsh-web 不起，全部抛带人话的 `Error` 并写进 `task.lines`；部署失败**不清空目标机**。

### 18.4.5 Windows 侧的开机自启

仓库内**没有** `schtasks` / `HKCU\...\Run` / Startup 快捷方式的实现（全仓 grep 命中的都是 autostart 逻辑与文档）。`tools/start-manager-hidden.vbs` 只负责隐藏窗口启动 `server\index.js`。也就是说：前端"开机自动连接服务器"是**管理端进程启动之后**的行为（§18.4.2），而"管理端进程自己在开机时被拉起来"取决于宿主 Electron 壳 / 安装器 / 快捷方式——**本仓库未验证**。

### 18.5 日志与现场文件

| 位置 | 内容 |
| --- | --- |
| `qq-bridge/state/bridge.log` | 桥日志（尾部 2000 行） |
| `qq-bridge/state/qq-activity.log` | QQ 收发活动（尾部 500 行），样例 `[15:40:42] group:1073589775 拍一拍事件：[拍一拍] …`、`[15:38:42] group:868756515 [deepsleep] 群聊消息已静默跳过：…` |
| `~/.qq-bridge-manager/logs/manager.log` | 管理端日志（实测 732,114 B） |
| `~/.qq-bridge-manager/logs/napcat-local.log` / `bridge-local.log` / `dsh-isolated.log` | 各子进程日志 |
| `~/.qq-bridge-manager/logs/napcat-guardian.log` | 守卫日志（实测 171,290 B） |
| `qq-bridge/state/` | `bridge.lock`、`sessions.json`、`social-state.json`、`chat.db`、`memory.db`、`tool-calls.jsonl`、`token-usage.jsonl`、`token-reconcile.json`、`context-savings.json`、`tool-schema-stats.json`、`scheduled-tasks.json`、`activity-windows.json`、`crosschat.json`、`current-role.json`、`stickers.json`、`feedback.json`、`slang.json`、`slang-session.json`、`learning-token`、`learning-config.json`、`docx-quota.json`、`napcat-guard.json`、`napcat-qr.png`、`napcat-container-spec/`、`dsh-seq.json`、`dsh-qq-hold.log`、`qq-mode-plugin.log`、`token-reconcile.log` |

---

## 19. 未核实项

本节列出的内容**没有逐行读实现或没有现场验证**，正文里只描述其声称的行为，不对内部细节下断言。

### 19.1 代码与既有文档的冲突（以代码为准）

| 既有说法 | 现状 | 证据 |
| --- | --- | --- |
| 有 4 种运行模式（default / 历史会话 / 关闭 agent / 预留） | **只剩 `default` 一种**：`VALID_MODES = ['default']`、`currentMode = 'default'`、`setCurrentMode()` 与 `setClosedAgentPreset()` 是**空函数**，任何切换请求都不生效 | `qq-bridge/src/core/mode.js:7-23`；`qq-bridge/RULES.md` 描述的 4 模式已**过期** |
| 工具 "96 个 / napcat 组 89 个"、`available: 90` | `mcp-napcat-safe.js` 实际注册 **91** 个工具，与 `state/tool-schema-stats.json` 的 `available: 91` 一致 | 工具注册点扫描 + `state/tool-schema-stats.json` |
| 「桥登录探测：向 NapCat 发 `/get_login_info` 验证 token，成功后打印 `[bridge] 登录态 ok: 昵称(QQ)`」写在 §13 自检 | 该探测 **2026-09-23 已删除**：`const loginWatch = null; void loginWatch;` 并在注释里明写桥不再主动查 NapCat 任何状态 | `qq-bridge/src/bridge.js:659-667` |
| 「WS 没连上时每分钟问一次、状态变了才打 `[napcat-login]`」 | **不存在该巡检**；`[napcat-login]` 这个 tag 在源码中没有任何输出点（只有 `napcat-tokens.js:213` 的提示文本提到它） | qq-bridge 全目录 grep |
| 「`core/audit.js` 的 `handleSensitiveIntercept` 硬性拦截不发送」 | 该函数**只写日志与活动记录**（`audit.js:26-29` 注释明写"不在 QQ 上发送任何拦截/报错通知"），全仓**没有任何调用点**（只有定义与 import）。真正拦截的是 `console-server.js:1191/2137/2488/5180` 的 `SENSITIVE_RE.test()` → 403、`qq-send.js:197-201` 的 `tokenDisclosureIn()` → throw、`mux.js:1248/1343-1370` 的文本替换 | `qq-bridge/src/core/audit.js`、`qq-bridge/src/core/console-server.js`、`qq-bridge/src/core/qq-send.js` |
| `qq_memory_search` "全文检索历史消息与记忆、实现指 `core/memory.js`" | 它**只读 `state/chat.db`**（`searchChatMessages`）；记忆条目检索是另一个工具 `qq_memory_notes` → `listMemoryEntries`（`state/memory.db`） | `qq-bridge/src/core/chat-db.js:859`、`qq-bridge/src/core/memory.js:619` |
| 检索是"加权 BM25" | FTS 表只有一列 `content`，`ORDER BY bm25(...) ASC` **未传任何列权重**；也**没有时间衰减** | `chat-db.js:881`、`memory.js:636` |
| `README.md` 引用的 `memory.js:172` / `memory.js:2833` | 行号已随 2026-09-24 分家过期；`memory.js` 现在只有 763 行，聊天记录函数已迁至 `chat-db.js` | `qq-bridge/src/core/memory.js` 文件头注释 `:3-7` |
| 控制台自带 Web UI | 已移除；`GET /` 返回 `{ok:true, name:'qq-bridge', ui:'embedded-in-manager'}` | `qq-bridge/src/core/console-server.js` |
| `qq-mode-console` 插件可切模式 | 现在只注册一个 settings 命名空间 `qq-mode`，**只有一个字段 `ownerQQ`**，`applies: 'live'`，诊断日志 `state/qq-mode-plugin.log` | `qq-bridge/plugins/qq-mode-console/lib/index.js`（53 行） |
| presets 里有 `default` 与 `qq-chat` 两份 | `installPresets` **只安装 `qq-chat` 一份**（注释：原 `default` 已合并进它） | `qq-bridge/src/lib/dsh-side.js:150` |
| 假设「已安装 preset 与仓库源一致」 | 实测哈希不同：仓库源 `agent.cordis.yml` = `63723C8F…F38EF`，活体隔离 home 的 `qq-chat` 与 `default` **两份都是 `EE497B35…60D1F`**（内容逐字节相同）。差异至少部分来自 `syncPresetOverrides` 写入的人设/发言规则合成段（标记 `# === qq-bridge persona/rules BEGIN/END ===`） | `Get-FileHash` 实测；`qq-bridge/src/lib/preset-compose.js:33-59`、`dsh-side.js:157-166` |

### 19.2 已确认的功能缺陷（代码 + 现场文件双证）

**人物学习的两条入口查错了库**（2026-09-25 提交 `9be5c59` 把 `chat_messages` 迁到 `state/chat.db` 后漏改）：

- `qq-bridge/src/core/persona-learn.js:223` 的 `collectTargetSamples()` 在 `initMemoryDb()` 打开的连接上查 `chat_messages`（`:238` / `:243`）；
- `qq-bridge/src/core/portrait-learn.js:84` 的 `eligiblePortraitTargets()` 同样（`:88-100`）。

实测：本机 `memory.db` 的表是 `profiles, memory_entries, memory_meta, mem_fts*`，**没有 `chat_messages`**；`chat.db` 才有（18,104 行）。后果：

- `persona-learn` 的两条 SQL 抛错被 catch（`:239-246`）→ `samples = []` → `runPersonaLearnOne` 在 `:602-605` 提前返回"近 N 天没有找到 <uid> 的发言记录"，**人格学习根本不会发起**；
- `portrait-learn` 返回 `{ok:false, error:'no such table: chat_messages'}`，`portraitLearnStart` 在 `:123` 直接返回未受理。

旁证：本工作区 `state/` 下**不存在** `persona-library.json` / `persona-agent.json`（人格学习从未成功跑过），而 `slang-session.json`、`learning-config.json`、`learning-token` 都在。对照组：`mcp-host-server.js:158-161` 的 `qq_learning_corpus` 已正确按 `chat.db → memory.db` 回退，说明只是这两处漏改。

> 本文档只记录能力现状，不改代码。修复需另开改动。

### 19.3 未逐行核实的模块

- `qq-bridge/src/mcp-web-search-safe.js` 与 `qq-bridge/src/safe-fetch.js`（§14 的 SSRF 防护细节、行号）——只核到工具注册与既有文档记录。
- `server/index.js`（10,122 行 / 633 KB）的多数 `/api/*` 端点——只按需读了 NapCat / guardian / repair / 入口附近区段；「BOM 自愈」「VC++ 自愈」「OneBot 配置注入」仅见注释。
- `qq-bridge/src/core/console-server.js` 的部分端点内部逻辑（已抽出 143 条 `/api/*` 路径与鉴权模型，其余未逐行）。
- `qq-bridge/src/lib/dsh-compaction.js` 只读了常量与 `normalizeCompaction` 的钳制段，YAML 生成 / 合并 / 同步未逐行。
- `qq-bridge/src/lib/send-gaps.js` 的 `clampGap`、`qq-bridge/src/lib/qzone-image.js` 的 `clampQzoneImageCount`、`mcp-napcat-safe.js:4033/4039/4125` 的 `clampReadBytes` / `clampLimit` / `clampPackBytes` 数值区间。
- `qq-bridge/src/core/turn-hold.js` 的 200 ms 轮询循环主体（80-357）——进入/退出条件、`again` 语义、`maxExchanges` / `idleCloseMs` 判定已由文件头注释 + `config.json` + 端点合约 + `flushStepBatch` 尾段确认，但循环内部逐行细节未验证。
- `qq-bridge/src/core/session-archive.js:350-404`（`pruneDays` 分支之后的归档循环尾部）约 55 行未逐行读；`:199-206` 附近 ticker 启动注释区段同理。
- `qq-bridge/src/core/video.js:158-596`（抖音/B 站解析主体）、`qq-bridge/src/core/media.js:1215-1247`（音乐搜索主体，基于 `music-search.js`）、`qq-bridge/src/core/sticker.js` 的 `:225-380/420-500/520-590`、`qq-bridge/src/lib/pixiv-auth.js` 全文、`qq-bridge/src/lib/music-search.js` 全文、`qq-bridge/src/lib/napcat-login.js` 全文——只核到导出符号（含 `musicSearch`/`loginQr`/`refreshCookie`），未读内部实现与常量。
- `server/deploy.js`（1,652 行）的 `probeTargetEnv` / `buildDeployKeepScript` / `buildTargetDshHealScript` / `buildTargetCapabilityCheckScript` / `connectWithFallback` 内部实现——流程与常量已核，脚本内容逐行未核。
- `server/index.js` 的 `resolveBridgeTarget`（:6654）、`getRemoteBridgeStatus`（:6837）、`remoteWriteTextVerified`（:6951）——作为证据被引用，但未逐行展开。
- `server/index.js` 的 93 条 `/api/*` 路由，其请求/响应字段由正则抽取（`req.body` 解构 + `res.json` 首键），**非逐行人工核对**；多行拼接的 `res.json` 与经 helper 读取的字段可能遗漏。`/api/bridge/chat-stream`（:5216）与 `/api/bridge/context-overhead`（:4771）的响应键未取到。

### 19.4 其它未验证项

- `state/memory.db.pre-v13-backup`（7.5 MB）在全仓 grep 无任何引用，**产出者未验证**。
- `chat_messages.ts` 实测存在两种格式（`2026-08-31 19:22:23` 与 `2026-09-08 周二 08:42:59`），`date` 过滤仍成立，**格式不一致的成因未验证**。
- `bridgeModeAllowsProcessControl()` 恒为 false 是**静态结论**（比较 `/api/status` 响应体与 `mode` 字段），未运行实测；同理 `start_napcat` / `stop_napcat` 的实际拒绝路径未运行验证。
- `napcat.httpToken` 仅被读、无写入点，**历史来源未验证**。
- 语音相关：本机 `state/` 下没有 `voice-*.json` / `voice-cache`（未实机跑过），`cacheDir()` 把 `CACHE_SUBDIR` 拼两次（`state/voice-cache/voice-cache`）的运行时目录形态**未实测**。
- token 对账：本机 3 份 projcache JSON 的 `record.sessionId` 全为 `undefined`（走文件名兜底）；若桥侧会话 id 是 `session-<uuid>` 而文件名是裸 `<uuid>`，归属判定可能失效——**未复现，仅提示风险**。
- `session/queue` 帧的实存性未验证（`token-meter.js:636` 依赖它做字符估算，但本机 DSH 会话日志里没有该事件名）。
- `isBridgeOwnedSession`（`token-meter.js:873-888`）的 slug 正则与真实机器人 DSH home 的匹配情况未验证。
- `state/session-archive.json` 在本机**不存在**（从未归档过会话）；DSH 侧的"取消归档"接口在本仓库**没有实现**，恢复途径未验证。
- `config.json` 的 `agentPreset` 现场值是 `"default"`，而 `installPresets` 只安装 `qq-chat`、`config.js:73` 的默认值也是 `'qq-chat'` —— 现场值与可用 preset 名不一致，**成因未验证**。
- 旧的 `state/turn-hold.js.bak-turnhold-20260923-092621`（27,090 B）是历史备份，**非生效文件**。
- 安装态副本 `D:\MoonBot\resources\runtime\*` 只用于读历史 state 证据，**未与 checkout 逐文件比对**。
- `/api/connect` 在 `server/index.js:2959` 与 `:8025` **重复注册**；按 Express 语义先注册者生效、后者为死代码，但**未起服务实测确认**。
- `src/pages/NetCanvas.tsx`（31,827 B）内**未见任何 `/api` 字面量或 `api()` 调用**（grep 为空），其数据来源与渲染对象**未验证**。
- Windows 侧"开机自启"在仓库内**无实现**（无 `schtasks` / `HKCU\...\Run` / Startup 快捷方式）；`tools/start-manager-hidden.vbs` 只负责隐藏窗口启动 `server\index.js`。是否由 Electron 壳或安装器注册自启，**未验证**。
- 仓库根 `scripts/` 目录**为空**（`Get-ChildItem -Recurse -File` 计数为 0）：部署相关脚本实际在 `server/deploy.js`、`server/index.js`、`qq-bridge/scripts/`、`tools/`。
- 安装副本是否"落后于仓库源"是**未验证判断**：两份 `agent.cordis.yml` 的哈希差至少部分来自 `preset-compose` 的合成段，未做 `stripOverrideBlock()` 后再比对（见 §19.1 末行）。
- 运行期 `~/.qq-bridge-manager/dsh-isolated-home/.agent-presets/default/` 存在（与 `qq-chat` 同哈希），但生成它的代码在仓库内**未找到**，其来源**未验证**。
- `sessions.rename`（`qq-bridge/src/dsh-client.js:282-284`）在桥内**未见调用点**：会话标题当前完全依赖工作区分组，改名能力闲置未验证。
- `workspace/list` 在 rc.1 无对应端点，桥**本地伪造**返回（`dsh-client.js:305-309`），其形状与真实端点是否一致**未验证**。
- `qq-bridge/music-sign-proxy.py`（241 行，`127.0.0.1:4567`）在**全仓 JS 与配置里零引用**，桥侧 `musicSignUrl` 也未配置——它是未接线件（§5 的音乐卡片签名段落所述默认签名地址来自 `media.js` 注释，与本文件无关）。
- 旧文档若引用 `qq-bridge/src/lib/media-download.js`：该文件**当前不存在**（`lib/` 下实际是 `napcat-file.js` 与 `onebot-delivery.js` 承担下载/投递）。
- 管理端 `/api/*` 路由的请求/响应字段来自正则抽取（见 §19.3 末条），个别端点（如 `/api/bridge/chat-stream`、`/api/bridge/context-overhead`）的响应键未取到。

