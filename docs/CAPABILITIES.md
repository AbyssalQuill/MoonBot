# MoonBot 能力构成说明

本文界定 MoonBot QQ 桥接系统（`qq-bridge`）与其管理端（`server/`、`src/`）在当前工作区中的能力构成：每个能力域由哪些机制组成、边界条件是什么、常量取值是多少、证据位于哪一行。本文只做构成性描述，不评估优劣，不描述发展过程，不含安装包（`D:\MoonBot\resources\runtime\*`）与工作区仓库的差异比对。

## 目录

| 块 | 标题 | 内容范围 |
| --- | --- | --- |
| §0 | 编写体例与阅读约定 | 取证口径、引用格式、证据等级、术语表、判定标记 |
| §1 | 能力概览 | 按子系统分块的总表：能力域 / 实现位置 / 触发条件 / 关键常量 |
| §2 | 形式模型与术语 | 会话、回合、步、唤醒、投递、闸门、水位的形式化定义与状态机 |
| §3 | 系统分块与模块拓扑 | 进程边界、文件边界、依赖方向、IPC 与协议 |
| §4 | 消息接收与唤醒子系统 | 入站主链、白名单、去重、静默、唤醒判定、斜杠命令 |
| §5 | 生成、闸门与投递子系统 | 发送唯一出口、节拍、幂等、出站格式治理、富文本卡片、文档、语音投递 |
| §6 | 记忆、检索与学习子系统 | 两库分工、全文检索、记忆分层、群缓存、黑话/人格/画像学习 |
| §7 | 人设、角色与表达子系统 | 人设产物与生效路径、角色库、表达约束、表情注入 |
| §8 | 媒体处理子系统 | 图片、表情包、语音、文件、视频的接收与发送 |
| §9 | 时间驱动与主动行为子系统 | 定时任务、活跃时段、主动搭话、掷骰、深层静默 |
| §10 | 社交拓展面 | QQ 空间、社交动作、跨会话留言、群与好友管理 |
| §11 | 上下文压缩与令牌预算接入 | 记账、对账、剪枝计量、工具裁剪与描述压缩 |
| §12 | DSH 集成面 | 隔离实例、会话、提示词投递、宿主服务、客户端协议 |
| §13 | 管理端功能面 | 管理器 REST 服务、页面、代理模型、凭据通道 |
| §14 | 部署、开机自动连接与运行维护 | 端口、退出守卫、完整性自修、SSH 部署、日志 |
| §15 | 安全模型与信任边界 | 敏感内容拦截、脱敏、SSRF 防护、信任等级、工具白名单 |
| §16 | 常量与阈值总表 | 全文常量、区间、上限的汇总表 |
| 附录 A | MCP 工具全表（napcat，91 条） | 工具名、必填与可选参数、最低保留档位、功能表述；16 张分组表（表 A-1 至表 A-16） |
| 附录 B | MCP 宿主服务工具表（5 条） | 宿主侧（`mcp-host-server.js`）注册的 5 个工具；宿主工具不参与裁剪 |
| 附录 C | 管理端路由表（93 条） | `server/index.js` 全部 `app.<method>('<path>')` 注册 |
| 附录 D | 证据等级与未核验清单 | 未逐行核实项、未复现项、已确认缺陷 |

---

## 0. 编写体例与阅读约定

本章界定全文的取证口径、引用格式、证据等级判定规则与术语，后续各章不再重复说明这些约定。

### 0.1 取证口径与引用约定

本文的基准仓库为 `MoonBot Public`，所有模块路径相对仓库根，使用正斜杠。桥接实现位于 `qq-bridge/src/`，管理端实现位于 `server/` 与 `src/`，桥接辅助脚本位于 `qq-bridge/tools/`。

代码位置引用统一写作 `path/to/file.js:123`；区块引用写作 `path/to/file.js:123-145`。行号为取证时刻的读取器行号，重构后会平移，**相对路径、函数名与常量名是稳定锚点**。常量取值、SQL 语句、JSON 字段、协议字段均自源文件逐字转录；核对过程中发现的文档与源码不一致处，以源码为准并在该处标注 `【已核验】`。

### 0.2 证据等级

表 1：证据等级定义与使用条件（口径：本文全部非显然论断必须标注其中之一）。

| 等级 | 含义 | 必须附带 |
| --- | --- | --- |
| `【已核验】` | 本轮读取源码或执行只读命令后确认 | `path:line` 或命令与输出 |
| `【据仓库记载】` | 引用仓库内其它文档或状态的既有结论 | 文档名或状态文件路径 |
| `【未核验】` | 推断、未复现、或仅有间接证据 | 显式声明推断性质，不得表述为事实 |

### 0.3 术语表

表 2：全文固定术语（口径：同一概念全文只使用一处用语；首次出现给出中文、English 或代码标识符三件套）。

| 术语 | 代码标识符 / 英文 | 定义 |
| --- | --- | --- |
| 会话 | `key`，形如 `group:<群号>` / `private:<QQ号>` | 桥内的一等对象，由 `^(group\|private):(\d+)$` 解析 |
| 回合 | turn | 一次唤醒触发的模型执行区间，以 `turn/start` 与 `turn/end` 为端 |
| 步 | step | 回合内的一次模型推理与工具调用循环，以 `step/start` 为端 |
| 唤醒 | wake | 由入站消息或主动计时器触发、向 DSH 会话投递提示词的动作 |
| 投递 | delivery / prompt | 桥向隔离 DSH 写入一段提示词并使其进入模型上下文的过程 |
| 闸门 | gate | 在某一阶段决定是否继续的判定点（白名单闸、静默闸、投递闸、工具白名单闸） |
| 水位 | watermark | 记录"已处理到哪里"的单调量，如未读水位、令牌对账水位、序号水位 |
| 桥 | bridge | `qq-bridge` 进程，OneBot 客户端兼 DSH 客户端 |
| 管理端 | manager | `server/index.js` 提供的 REST 服务与 `src/` 下的页面 |
| 隔离 DSH | isolated DSH | 桥自安装的 DSH 实例，home 目录独立于桌面版 |
| 令牌 | token | 会话令牌 `x-agent-token`、学习令牌、NapCat accessToken 三类，各章按限定词区分 |

### 0.4 判定标记

表 3：正文中出现的判定标记（口径：标记只用于区分"读到的实现"与"未读到的部分"）。

| 标记 | 语义 |
| --- | --- |
| `恒为 false` | 该判定的输入在现行实现下不可能满足，结论来自静态比较 |
| `fail-closed` | 判定不确定时取"拒绝/排除"分支 |
| `白名单语义` | 不在名单内的对象不被注册或被拒绝 |
| `后备路径` | 主路径失败后接续执行的降级路径（fallback） |

### 0.5 实现细节的展开约定

每项实现细节由四要素构成，缺一即视为证据不足：其一为机制，即参与判定的符号、函数与数据载体；其二为边界条件，即该机制生效与不生效的判据；其三为常量取值，取源码字面值或现场配置值并保留原值；其四为证据行，即相对路径与行号，行号取自本轮读取。

---

## 1. 能力概览

本章按子系统给出能力总表。每行包含四项：能力域、实现位置（相对路径与关键符号）、触发条件或入口、关键常量。各行的展开说明见对应章节；本章不对行为下断言，只给出索引。

### 1.1 消息接收与唤醒

表 4：接收与唤醒能力域（口径：触发条件列写明进入该能力的可观测入口）。

| 能力域 | 实现位置 | 触发条件 / 入口 | 关键常量 |
| --- | --- | --- | --- |
| 会话键解析 | `qq-bridge/src/core/mode.js:40-44` | 任意会话键字符串 | 正则 `^(group\|private):(\d+)$` |
| 入站主链 | `qq-bridge/src/core/mux.js:299` `handleIncoming` | OneBot WS 事件回调 | — |
| 白名单闸门 | `qq-bridge/src/lib/config.js` `allowed()` | 每条入站消息 | `allow.*` / `deny.*` / `allowAllWhenEmpty` |
| 入站去重 | `qq-bridge/src/core/mux.js:278-279` | 每条入站消息 | `INBOUND_DEDUP_TTL_MS = 10 * 60 * 1000`、`INBOUND_DEDUP_MAX = 800` |
| 好友守卫 | `qq-bridge/src/core/mux.js:273/319` `ALARM_RE` | 私聊命中告警正则且发送方非受信任者 | 开关 `social.autoFriendGuard` |
| 挂起应答 | `qq-bridge/src/core/events-aux.js:44` `handlePendingAnswer` | 上轮登记了 `pending` 提问 | `cfgRef.questionTimeoutMs` |
| 静默闸门 | `qq-bridge/src/core/mux.js` 深层静默分支 | `deepsleep` 状态为真 | 落盘 `state/qq-activity.log` |
| 斜杠命令 | `qq-bridge/src/core/mux.js` 命令分支 | 正文以 `/` 开头 | 日志前缀 `[command]` |
| 唤醒判定 | `qq-bridge/src/core/mux.js:720-760` | 通过前序闸门 | `evaluateWakeTrigger` → `scheduleWake` |
| 会话准入复查 | `qq-bridge/src/core/wake-send.js:1281-1284` | 投递前 | `isSessionAllowedInCurrentMode` |
| 唤醒正文装配 | `qq-bridge/src/core/wake-send.js` | 唤醒投递 | `[WakeRef]` :334-340、`[Recall]` :485、`[Profile]` :486、`[PERSONA]` :311-326 |
| 未读水位补回 | `qq-bridge/src/core/wake-send.js:1316-1334` | 重启后窗口重建 | 依据 `lastAiSeenAt` |

### 1.2 生成、闸门与投递

表 5：出站与投递能力域（口径：`onebotSend` 是全部出站消息的唯一出口）。

| 能力域 | 实现位置 | 触发条件 / 入口 | 关键常量 |
| --- | --- | --- | --- |
| 出站唯一出口 | `qq-bridge/src/core/qq-send.js` `onebotSend` | 任意发送工具 | `SEND_TIMEOUT_MS = 15000` |
| 发送串行链 | `qq-bridge/src/core/send-chain.js:61` `enqueueSend` | 任意发送工具 | 节拍见 1.2 末两行 |
| 发送幂等 | `qq-bridge/src/core/send-idempotency.js:40/42` | 重放相同消息 | `REPLAY_WINDOW_MS = 180000`、`DELIVERED_KEEP = 50` |
| 打字节拍 | `qq-bridge/src/core/send-chain.js:108-115` `LINEAR_DEFAULTS` | 同一会话连续气泡 | `perCharMs 150`、`minMs 250`、`capMs 4000`、`jitterRatio 0.25`、`resetMs 60000` |
| 最小间隔 | `qq-bridge/src/lib/send-gaps.js:12/23-26` | 两次发送之间 | `MIN_GAP_MS = 100`，上限 `maxGapMs` 默认 10000 |
| 正文切分 | `qq-bridge/src/md-to-plain.js:33` `splitForQQ` | 正文超过单条上限 | `max = 4000` |
| 参数数组还原 | `qq-bridge/src/lib/text-safe.js:221` `splitSerializedBubbles` | 发送参数为数组 | 失败即 400 硬失败 |
| 产物令牌清洗 | `qq-bridge/src/lib/outbound-text.js:21/24/46` | 每次出站正文 | `ARTIFACT_TOKEN_RE` |
| 敏感内容拦截 | `qq-bridge/src/core/console-server.js:1191/2137/2488/5180`、`qq-bridge/src/core/qq-send.js:197-201` | 出站正文与参数 | `SENSITIVE_RE`、`tokenDisclosureIn` |
| 富文本卡片 | `qq-bridge/src/core/console-server.js:3018` 起 | `qq_send_rich` | `RICH_DEDUPE_MS = 60000` |
| 文档发送 | `qq-bridge/src/core/docx.js` | `qq_send_docx` | `MAX_DOCX_CHARS = 1000000`、日额度 `100000` |
| 语音投递 | `qq-bridge/src/core/voice.js` | `qq_send_voice` | `MAX_TTS_CHARS = 2000` |
| 投递入队 | `qq-bridge/src/core/prompt-deliver.js:17` | DSH 未就绪或投递失败 | `QUEUE_MAX = 50` |
| 投递模式 | `qq-bridge/src/core/prompt-deliver.js:165` | 每次投递 | `mode = 'steer'`，超时 30000 |

### 1.3 记忆、检索与学习

表 6：记忆与学习能力域（口径：两个 SQLite 库分属不同数据域，检索接口不混用）。

| 能力域 | 实现位置 | 触发条件 / 入口 | 关键常量 |
| --- | --- | --- | --- |
| 聊天记录落库 | `qq-bridge/src/core/chat-db.js` `persistChatMessage` | 每条入站与出站消息 | `state/chat.db` |
| 聊天记录检索 | `qq-bridge/src/core/chat-db.js:859` `searchChatMessages` | `qq_memory_search` | `FTS_SCHEMA_VERSION = '1'` |
| 全文查询构造 | `qq-bridge/src/lib/fts.js:22` `ftsQueryOf` | 检索请求 | 词长 `>= 3`、最多 8 词 |
| 记忆条目库 | `qq-bridge/src/core/memory.js:46-80` | `qq_memory_remember` 等 | `state/memory.db`、`FTS_SCHEMA_VERSION = '2'` |
| 记忆分层 | `qq-bridge/src/core/memory.js:87/89` | 写入时 | `permanent 0` / `durable 90 天` / `working 7 天` |
| 记忆摘要注入 | `qq-bridge/src/core/memory.js:703-731` | 每轮唤醒 | `limit 1..30` 默认 12、`maxChars 120..4000` 默认 700 |
| 群缓存 | `qq-bridge/src/core/group-cache.js` | 群信息读取 | TTL `10 * 60 * 1000` |
| 黑话学习 | `qq-bridge/src/core/slang.js`、`qq-bridge/src/slang-learner.js` | 夜间定时、`/slang`、`POST /api/learning/slang` | `MAX_LEARN_MSGS = 2400`、`MAX_BLOCK_MSGS = 800` |
| 人格学习 | `qq-bridge/src/core/persona-learn.js` | `/persona`、`POST /api/learning/persona` | `PERSONA_TURN_TIMEOUT_MS = 300000`、`PROFILE_MAX = 4000` |
| 群友画像 | `qq-bridge/src/core/portrait-learn.js` | `/portrait`、`POST /api/learning/portrait` | `minMessages 10`、`maxTargets 20`、`windowHours 720` |
| 学习令牌 | `qq-bridge/src/core/learning-token.js` | 学习会话调用 `qq_learning_submit` | 32 位十六进制、权限位 `0o600` |
| 学习语料 | `qq-bridge/src/mcp-host-server.js:142` `qq_learning_corpus` | 学习会话调用 | `limit` 默认 400、上限 800 |

### 1.4 人设、角色与表达

表 7：人设与表达能力域（口径：人设产物有落盘文件与运行时注入两条生效路径）。

| 能力域 | 实现位置 | 触发条件 / 入口 | 关键常量 |
| --- | --- | --- | --- |
| 人设文本组装 | `qq-bridge/src/core/persona-text.js` | 学习产出归一化后 | `PROFILE_MAX = 4000` |
| 人设落库 | `qq-bridge/src/core/persona-learn.js:520` → `qq-bridge/src/core/memory.js:267-285` | 学习完成后 | 字段上限 4000 |
| 人设生效（文件） | `qq-bridge/src/lib/preset-compose.js:33-59` | 审批 `mode='apply'` 后 | 合成段标记 `# === qq-bridge persona/rules BEGIN/END ===` |
| 人设生效（运行时） | `qq-bridge/src/core/wake-send.js:311-326` | 每轮唤醒 | `RUNTIME_OVERRIDE_MAX['persona.md'] = 16000`、保尾 2500 |
| 防退化合并 | `qq-bridge/src/core/persona-learn.js:493-503` | 新文本显著变短时 | `KEEP_OLD_MIN = 60` |
| 角色库 | `qq-bridge/src/mcp-napcat-safe.js:4601-4665` | `qq_character_*` | `social.charactersDir` |
| 当前角色 | `qq-bridge/src/core/audit.js:19` 读取 | 发送前判定 | `state/current-role.json` |
| 表达约束 | 预设 `qq-chat` 的 `[TOOLS]` 段 | 出站正文 | 无换行、颜文字字数、代码不分段 |
| 表情注入 | `qq-bridge/src/sticker-lib.js:165` `buildStickerContext` | 每轮唤醒 | `promptMaxStickers = 8` |

### 1.5 媒体处理

表 8：媒体能力域（口径：接收侧有字节与像素双闸，发送侧有统一入口）。

| 能力域 | 实现位置 | 触发条件 / 入口 | 关键常量 |
| --- | --- | --- | --- |
| 收图入模型 | `qq-bridge/src/core/media-pipe.js:72` `fetchOneBotImage` | 消息带图或表情 | `MAX_MEDIA_BYTES = 25 * 1024 * 1024`、`MAX_MEDIA_PIXELS = 64_000_000` |
| 媒体元数据上限 | `qq-bridge/src/core/media-pipe.js:17` | 会话级累积 | `MAX_MEDIA_STORE_PER_KEY = 500` |
| 下载与 SSRF 防护 | `qq-bridge/src/safe-fetch.js:362` `safeFetchBuffer` | 所有外部 URL | `MAX_IMAGE_FETCH_BYTES = 15 * 1024 * 1024`、`MAX_REDIRECTS = 5` |
| 图片压缩与转码 | `qq-bridge/src/lib/image-compress.js:242` | 外发或转发 | `IMAGE_MAX_SIDE = 1280`、`IMAGE_JPEG_QUALITY = 82` |
| 外发图统一入口 | `qq-bridge/src/lib/napcat-file.js:60` `napcatImageFileArg` | 所有发图工具 | 模式 `path` / `base64` / `auto`，默认 `path` |
| 收藏表情 | `qq-bridge/src/core/sticker.js`、`qq-bridge/src/sticker-lib.js` | `qq_send_sticker`、`qq_collect_sticker` | 同步 TTL 60000、列表上限 500 |
| 内置表情包 | `qq-bridge/src/mcp-napcat-safe.js:2066/2116` | `qq_meme_search`、`qq_send_meme` | `MEME_RESCAN_MS = 5000` |
| QQ 内置表情 | `qq-bridge/src/core/sticker.js:359` `sendQqFace2` | `qq_send_qq_face` | face id 由 `qq_face_list` 提供 |
| 语音合成 | `qq-bridge/src/core/voice.js` | `qq_send_voice` | 默认端点 `https://token-plan-cn.xiaomimimo.com/v1` |
| 语音识别 | `qq-bridge/src/core/voice.js` | `qq_transcribe_voice` | `MAX_ASR_BYTES = 7 * 1024 * 1024` |
| 独立识图 | `qq-bridge/src/core/vision.js` | 分流开关开启 | `VISION_TIMEOUT_MS = 45000` |
| 联网找图 | `qq-bridge/src/lib/image-search.js:122` | `qq_image_search` | 超时 `9000`、`limit <= 20` |
| Pixiv | `qq-bridge/src/lib/pixiv.js` | `qq_pixiv_search`、`qq_send_pixiv` | `PIXIV_SCAN_PAGES_DEFAULT = 3`、上限 10 |
| 音乐卡片 | `qq-bridge/src/core/media.js:930` `buildMusicCard` | `qq_send_rich` 类型 `music` | 超时 `AbortSignal.timeout(45000)` |
| 视频卡片 | `qq-bridge/src/core/video.js:1158` `buildVideoCard` | `qq_video_parse`、`qq_send_rich` 类型 `video` | `PROBE_TIMEOUT_MS = 9000` |
| 空间配图 | `qq-bridge/src/lib/qzone-image.js:170` | `qq_send_qzone` | `QZONE_IMAGE_MAX = 3` |

### 1.6 时间驱动、主动行为与社交拓展

表 9：时间与社交能力域（口径：主动行为的概率与冷却由桥侧决定，模型不直接取值）。

| 能力域 | 实现位置 | 触发条件 / 入口 | 关键常量 |
| --- | --- | --- | --- |
| 定时任务 | `qq-bridge/src/core/scheduler.js` | `qq_schedule_message` | 失败重试间隔 60000、上限 3 次 |
| 活跃时段 | `qq-bridge/src/core/activity.js` | `qq_set_activity_hours` | tick `60000`、命中窗口起点后 2 分钟 |
| 深层静默 | `qq-bridge/src/core/mux.js` | `qq_deepsleep` | 只写 `state/qq-activity.log` |
| 主动搭话 | `qq-bridge/src/core/send-dice.js`、`social.proactive.*` | 空闲计时器 | `MEME_DEFAULT_PROBABILITY = 0.3` |
| 表情发布掷骰 | `qq-bridge/src/core/send-dice.js` `dice(kind)` | 桥侧主动路径 | `MEME_DEFAULT_COOLDOWN_MS = 3 * 60 * 1000` |
| 主动语音 | `qq-bridge/src/core/voice.js:73-104` | 唤醒前掷骰 | `send.probability 0.2`、`send.cooldownMs 600000` |
| 主动发说说 | `qq-bridge/src/core/qzone.js:8` `postRandomQzone` | 主动路径 | 内置 10 条池、超时 15000 |
| 跨会话留言 | `qq-bridge/src/core/crosschat.js` | `qq_crosschat_send` | 每会话保留 10 条、正文 `slice(0,400)` |
| 跨会话注入 | `qq-bridge/src/core/crosschat.js:102` | 每轮唤醒 | 每轮最多 2 条、整行上限 170 |
| QQ 空间 | `qq-bridge/src/mcp-napcat-safe.js:2536-2702` | `qq_qzone_*` | 见附录 A |
| 社交动作 | `qq-bridge/src/mcp-napcat-safe.js:2013` 等 | `qq_like`、`qq_send_poke` | — |
| 群与好友管理 | `qq-bridge/src/mcp-napcat-safe.js:2342-2399` | `qq_blacklist` 等 | 所有者私聊限定 |
| 好友请求审批 | `qq-bridge/src/bridge.js:622` | OneBot 请求事件 | `social.autoFriendApproval` 默认 false |

### 1.7 上下文、DSH 集成、管理端与部署

表 10：集成与运维能力域（口径：行号以本轮读取为准）。

| 能力域 | 实现位置 | 触发条件 / 入口 | 关键常量 |
| --- | --- | --- | --- |
| 用量记账 | `qq-bridge/src/core/token-meter.js` | 每帧 usage | `MAX_LINES = 50000`、`PRUNE_TO_LINES = 45000` |
| 用量对账 | `qq-bridge/src/core/token-meter.js:1026` | 启动后周期执行 | 间隔 `5 * 60 * 1000`、`quotaPerRun = 200` |
| 剪枝计量 | `qq-bridge/src/core/context-savings.js` | 启动、面板请求 | `STATE_VERSION = 3`、`scanTtlMs = 30000` |
| 工具裁剪 | `qq-bridge/src/lib/tool-tiers.js` | 注册期 | 档位 `off/low/medium/high/extreme/custom` |
| 描述压缩 | `qq-bridge/src/lib/tool-schema-compress.js` | 注册期 | 档位 `off/medium/high` |
| 压缩代理 | `qq-bridge/src/lib/dsh-side.js` | MCP 挂载 | `-c <level> -n napcat`，探测失败回退直连 |
| DSH 会话映射 | `qq-bridge/src/core/dsh-session.js:79` | 首次唤醒 | `state/sessions.json` |
| 会话归档 | `qq-bridge/src/core/session-archive.js` | 定时器 | `intervalMs 600000`、`idleMinutes 30`、`batchMax 20` |
| DSH 客户端 | `qq-bridge/src/dsh-client.js` | 全部 DSH 调用 | 默认 `http://127.0.0.1:10721` |
| 宿主服务工具 | `qq-bridge/src/mcp-host-server.js` | 隔离 DSH 侧调用 | 注册条件 `allowProcessControl === true` |
| 管理端 REST | `server/index.js` | 页面调用 | `PORT = process.env.QBM_API_PORT \|\| 1921` |
| 桥控制台 | `qq-bridge/src/core/console-server.js` | 桥内 HTTP | `consolePort = 3100` |
| 退出守卫 | `server/napcat-guardian.mjs` | 管理器启动后 | 宽限 `30000`、复查间隔 `2000` |
| NapCat 完整性自修 | `server/napcat-repair.js` | 拉起 NapCat 之前 | 依赖 `NapCat.Shell.zip` 与同目录 `7z.exe` |
| SSH 部署 | `server/deploy.js` | 管理端触发 | 流式转发超时 `1800000` |
| 开机自动连接 | `server/index.js:9606-9656` | 管理端启动 | 延迟 `1500`、复查 `60000` |

### 1.8 适用范围与使用约束

本节的适用范围为：本仓库当前提交状态下的桥、隔离 DSH、随包 NapCat、管理器与页面。使用约束如下。其一，不覆盖安装目录副本与仓库源之间的差异。其二，内容口径只描述机制、边界条件、常量取值与证据位置，不做效果评价与使用建议。其三，行号一律以本轮读取的仓库源为准，仅随文件长度变化。其四，常量一律转录源码字面值或现场配置值，不做取整与近似替换。其五，现场值取自 `qq-bridge/config.json` 与 `qq-bridge/state/` 下的实际文件。其六，证据不足项标注 `【未核验】` 并进入附录 D.4 清单，不作为事实引用。其七，已知缺陷保留在正文并汇总于附录 D.3，不做规避性改写。其八，源码日志中出现的权限角色称谓以 `[owner]` 替代后引用位置，不逐字转录。其九，压缩算法的数学表述见 `docs/COMPACTION-MATH.md`，体系结构见 `docs/ARCHITECTURE.md`。

---

## 2. 形式模型与术语

本章界定全文使用的七个形式对象（会话、回合、步、唤醒、投递、闸门、水位）及其取值集合，后续各章按此模型描述行为。

### 2.1 会话与键空间

会话键 `key` 的取值集合为 `{group:<QQ群号>} ∪ {private:<QQ号>}`，由 `qq-bridge/src/core/mode.js:40-44` 的 `^(group|private):(\d+)$` 解析【已核验】。会话在桥内有两级状态：

表 11：会话状态的两级载体（口径：内存态不落盘，持久态跨重启）。

| 层级 | 载体 | 内容 | 位置 |
| --- | --- | --- | --- |
| 内存态 | `Map` / `Set` 集合 | 采集器、回合起点、待唤醒键、投递队列、反向索引、媒体表等共 31 项 | `qq-bridge/src/core/session-state.js`【已核验】 |
| 持久态 | `state/social-state.json` 的 `conversations[key]` | 落盘字段集（36 键），另在载入时构造 4 个仅内存字段 | `qq-bridge/src/core/social-state.js:342-400`、`qq-bridge/src/core/social-state.js:604-661`【已核验】 |
| 会话映射 | `state/sessions.json` | `{"sessions": {"<key>": "<sessionId>"}}` | `qq-bridge/src/lib/paths.js:9`、`qq-bridge/src/core/config.js:440`【已核验】 |

内存媒体表位于 `qq-bridge/src/core/session-state.js:80`，投递队列位于 `:38-40`，并发去重表 `sessionPromises` 位于 `:10`，长轮询守卫 `activeWaits` 位于 `:24`，反向索引 `reverse` 位于 `:30`【已核验】。

### 2.2 回合与步

回合（turn）是一次唤醒触发的模型执行区间，步（step）是回合内的一次推理与工具调用循环。桥侧对两者均有独立计时与守卫：

表 12：回合与步的守卫量（口径：全部为毫秒）。

| 量 | 取值 | 语义 | 位置 |
| --- | --- | --- | --- |
| 长轮询回合上限 | `11 * 60 * 1000` | 模型挂起 `qq_wait_for_messages` 时的回合上限 | `qq-bridge/src/core/turn-guard.js:21`【已核验】 |
| 投递超时 | `30000` | 单次 `session/prompt` 上限 | `qq-bridge/src/core/prompt-deliver.js:165`【已核验】 |
| 会话隔离 | `quarantineSession` | 拒绝未投递项、清回合状态、删除会话映射 | `qq-bridge/src/core/turn-guard.js:56-106`【已核验】 |
| 轮换阈值 | `max(5, social.autoReset.wakeThreshold \|\| 10)`，`permanent` 为真时取 `Infinity` | 达到阈值即更换 DSH 会话 | `qq-bridge/src/core/wake-send.js:95-97`【已核验】 |
| 轮换推迟上限 | `120000` | 轮换最多推迟时长 | `qq-bridge/src/core/wake-send.js:75`【已核验】 |

### 2.3 唤醒与投递

唤醒（wake）由入站消息或桥侧计时器发起，经判定后进入投递（delivery）。投递的传输形式为 DSH 的 `session/prompt` 调用，其 `mode` 取值恒为 `'steer'`【已核验】（`qq-bridge/src/core/prompt-deliver.js:165`）。该取值的依据记录于同文件 `:144-164`：`queue` 模式对应 `next-turn` 队列，当前回合未结束时不会取出；`steer` 模式对应 `next-step` 队列，`inbox.claim()` 优先取 `next-step`，因此会话忙闲均可取出【据仓库记载】。

投递存在一条不经过队列的快路径：模型正挂起 `qq_wait_for_messages` 长轮询时，入站消息作为工具结果直接返回模型，由 `activeWaits` 守卫拦截投递【已核验】（`qq-bridge/src/core/session-state.js:24`）。

### 2.4 闸门序列

入站消息在到达模型之前依次通过下列闸门，任一闸门拒绝即终止该条消息的处理：

表 13：入站闸门序列（口径：序号即执行顺序，行号为本轮读取值）。

| 序 | 闸门 | 判定 | 拒绝后的行为 |
| --- | --- | --- | --- |
| 1 | 白名单 | `allowed(kind, id, cfg)` | 结束，不唤醒 |
| 2 | 正文抽取 | `textContent` / `plainContent` | 无正文则不参与唤醒判定 |
| 3 | 好友守卫 | `ALARM_RE`（`qq-bridge/src/core/mux.js:273/319`） | 删除好友并拉黑，开关 `social.autoFriendGuard` |
| 4 | 媒体落库 | `messageMediaStore` | 媒体不进入本轮唤醒 |
| 5 | 去重 | `INBOUND_DEDUP_TTL_MS` / `INBOUND_DEDUP_MAX` | 窗口内重复直接丢弃 |
| 6 | 挂起应答 | `handlePendingAnswer` | 视为回答或按超时取消 |
| 7 | 静默 | `deepsleep` 状态 | 只写 `state/qq-activity.log` |
| 8 | 命令分支 | 正文以 `/` 开头 | 由桥直接执行，不进入模型 |
| 9 | 会话准入 | `isSessionAllowedInCurrentMode(key)`（`qq-bridge/src/core/wake-send.js:1281-1284`） | 跳过唤醒并记日志 |

出站方向存在两道独立闸门：发送端点的敏感内容判定（`qq-bridge/src/core/console-server.js:1191/2137/2488/5180`）与发送出口的令牌泄露判定（`qq-bridge/src/core/qq-send.js:197-201`）【已核验】。

### 2.5 水位与账本

表 14：桥内水位与账本的取值与语义（口径：水位均为单调量，只增不减或按明示条件重置）。

| 水位 | 载体 | 语义 | 位置 |
| --- | --- | --- | --- |
| 未读水位 | `lastAiSeenAt` | 已交付给模型的入站消息上界 | `qq-bridge/src/core/wake-send.js:1316-1334`【已核验】 |
| 展示水位 | `turnSeenUnread` 快照 `snapMax` | 回合开始时已展示的未读上界 | `qq-bridge/src/core/console-server.js:1759-1766`【已核验】 |
| 推迟交付集 | `_steerDeferredSeqs` | 无展示水位时保留的未读序号集 | `qq-bridge/src/core/console-server.js:1767-1779`【已核验】 |
| 令牌对账水位 | `state/token-reconcile.json` | 每会话四桶累计（`prompt` / `completion` / `cacheRead` / `cacheWrite`） | `qq-bridge/src/core/token-meter.js:841-863`【已核验】 |
| 序号水位 | `state/dsh-seq.json` | DSH 事件序号，重置间隔 `SEQ_RESET_GAP = 100` | `qq-bridge/src/core/dsh-client.js:30/38-40`【已核验】 |
| 学习水位 | `state/learning-config.json` 的 `slang.lastLearnAtMs` / `persona.lastRunAtMs` | 学习批次上界 | `qq-bridge/src/core/console-server.js:285-303`【已核验】 |
| 已回复账本 | 会话级账本结构 | `/reset` 保留该账本 | `qq-bridge/src/core/mux.js` 的 `resetConversationKeepingLedger`【据仓库记载】 |

### 2.6 状态机取值集合

表 15：全文涉及的状态机及其取值（口径：取值顺序为判定优先级顺序）。

| 状态机 | 取值 | 位置 |
| --- | --- | --- |
| 运行模式 | 仅 `default`（`VALID_MODES = ['default']`，`setCurrentMode()` 为空函数） | `qq-bridge/src/core/mode.js:7/21`【已核验】 |
| 客户端连接 | `connecting` → `open` → `close` → 后台重连 | `qq-bridge/src/lib/onebot-ws.js`【已核验】 |
| 黑话词条状态 | `candidate` / `confirmed` / `rejected`，只允许向上迁移 | `qq-bridge/src/slang-learner.js:15-19`【已核验】 |
| 黑话学习相位 | `idle` → `disabled` → `extracting` → `stopping` → `queued` → `researching` → `ready` | `qq-bridge/src/core/slang.js:637-642`【已核验】 |
| 远端连接相位 | `idle` / `connecting` / `tunnels` / `server-starting` / `warming` / `ready` / `failed` | `server/connect-machine.js:19`【已核验】 |
| 远端组件状态 | `ready` / `starting` / `down` | `server/connect-machine.js:35-73`【已核验】 |
| 卡片投递档位 | `primary` / `native` / `link` | `qq-bridge/src/core/media.js:276-308`【已核验】 |
| 图片档位 | `original` / `master` / `thumb` / `unknown` | `qq-bridge/src/lib/pixiv.js:207`【已核验】 |
| 发送确认 | 已送达 / 未确认（`unconfirmed: true`） | `qq-bridge/src/lib/onebot-delivery.js:52`【已核验】 |
| 会话守护判定 | `removed`（守护已停用，`enabled: false`、`autoHeal: false`） | `qq-bridge/src/core/napcat-guard.js`【已核验】 |

---

## 3. 系统分块与模块拓扑

本章界定进程边界、文件边界、依赖方向与进程间协议；各子系统的内部结构见 §4 至 §15。

### 3.1 进程与端口

表 16：进程与监听端口（口径：默认端口取自配置默认值与源码常量）。

| 进程 | 默认监听 | 定义处 |
| --- | --- | --- |
| OneBot HTTP 服务端（NapCat 侧） | `3000` | `qq-bridge/config.json` 的 `napcat.httpUrl`【已核验】 |
| OneBot WebSocket 服务端（NapCat 侧） | `3001` | `qq-bridge/config.json` 的 `napcat.wsUrl`【已核验】 |
| NapCat WebUI | `6099` | `server/index.js:64`、`qq-bridge/src/core/napcat-tokens.js:415`【已核验】 |
| 桥控制台 | `3100`，仅绑定 `127.0.0.1` | `qq-bridge/config.json` 的 `consolePort`【已核验】 |
| 隔离 DSH | `10721` | `qq-bridge/config.json` 的 `dsh.baseUrl`【已核验】 |
| 管理端 REST | `1921`，仅绑定 `127.0.0.1` | `server/index.js:9605-9607`【已核验】 |
| 远端隧道（NapCat WebUI / HTTP / DSH / 桥） | `13000` / `13001` / `13080` / `13100` | `server/index.js:189-197`【已核验】 |

桥控制台的鉴权只在 `config.consoleToken` 合法时启用（`qq-bridge/src/core/console-server.js:540-546`）【据仓库记载】；当前 `qq-bridge/config.json` 的 `consoleToken` 为空，即本机 `3100` 不启用令牌鉴权，访问控制仅依赖 `127.0.0.1` 绑定【已核验】。

### 3.2 依赖方向

数据流方向为单向三段：OneBot 事件 → 桥 → 隔离 DSH → 模型；模型产出经工具调用回到桥，再由桥经 OneBot 出站。桥同时是 OneBot 客户端与 DSH 客户端，两个方向均不依赖管理端；管理端只作为桥控制台与桥配置的代理方，不参与消息链路【已核验】（`server/index.js:7382` `proxyToBridgeConsole`）。

表 17：模块层与依赖对象（口径：路径相对仓库根）。

| 层 | 目录 | 依赖方向 |
| --- | --- | --- |
| 入口 | `qq-bridge/src/bridge.js`、`qq-bridge/src/mcp-*.js` | 依赖 `core/` 与 `lib/` |
| 核心 | `qq-bridge/src/core/` | 依赖 `lib/` 与 `src/` 顶层模块 |
| 工具库 | `qq-bridge/src/lib/` | 仅依赖 Node 内置模块与第三方包 |
| 页面与 API | `src/`、`server/` | `src/` 依赖 `server/` 的 HTTP 接口 |

### 3.3 进程间协议

表 18：协议面（口径：按承载方式分类，括号内为协议字段或调用形态）。

| 协议 | 承载 | 形态 | 定义处 |
| --- | --- | --- | --- |
| OneBot v11 反向/正向 WS | WebSocket | 事件回调与 API 调用，鉴权用 query `access_token=` 与握手头 `Authorization: Bearer` 双携带 | `qq-bridge/src/lib/onebot-ws.js:136/144`【已核验】 |
| OneBot HTTP | HTTP | `POST <httpUrl>/<action>`，头 `authorization: Bearer <accessToken>` | `qq-bridge/src/core/qq-send.js`、`qq-bridge/src/core/console-server.js:3986` 等【已核验】 |
| DSH RPC | HTTP | `POST /api/<ns>/<m>`，体 `{type:'client-request', rpcId, method, payload:{args}}` | `qq-bridge/src/dsh-client.js:225-245`【已核验】 |
| DSH 事件 | WebSocket（`remote.mux`） | 逐会话 `session/follow`，`maxMessages: 200` | `qq-bridge/src/dsh-client.js:399`【已核验】 |
| MCP | stdio | 三个 server：`mcp-napcat`、`mcp-napcat-host`、`mcp-web-search-safe` | `qq-bridge/src/lib/dsh-side.js:252-299`【已核验】 |
| 桥控制台 REST | HTTP | `/api/social/*`、`/api/send/*`、`/api/images/*` 等分组 | `qq-bridge/src/core/console-server.js`【已核验】 |
| 桥控制台 SSE | HTTP | `GET /api/napcat/login-stream`（事件名 `napcat-login`） | `qq-bridge/src/core/console-server.js:5594-5605`、`:6108-6189`【据仓库记载】 |
| 进程内状态文件 | 文件 | JSON / JSONL / SQLite，写入使用临时文件加原子重命名 | `qq-bridge/src/core/config.js:448-452`【已核验】 |

### 3.4 MCP 服务器与工具规模

表 19：MCP 服务器规模（口径：注册点计数，本轮以源码文本判定）。

| 服务器 | 注册文件 | 工具数 | 判据 |
| --- | --- | --- | --- |
| `mcp-napcat` | `qq-bridge/src/mcp-napcat-safe.js` | 91 | `^\s*registerTool\(` 调用点共 91 处，名字互不重复；含 1 个 `get_time`【已核验】 |
| `mcp-napcat-host` | `qq-bridge/src/mcp-host-server.js` | 5 | `server.tool(` 共 5 处（`:142/198/247/264/314`）【已核验】 |
| `mcp-web-search-safe` | `qq-bridge/src/mcp-web-search-safe.js` | 2 | `web_search` 注册于 `:943`（名字 `:944`）、`web_fetch` 注册于 `:979`（名字 `:980`）【已核验】 |

`qq-bridge/src/safe-fetch.js` 不注册任何 MCP 工具，它是被上述模块引用的纯工具库【已核验】。运行时实际注册数还受档位闸门 `toolAllowedByTier`（`qq-bridge/src/mcp-napcat-safe.js:741`）与各工具的 `cfg.social.*` 开关分支影响【已核验】。

---

## 4. 消息接收与唤醒子系统

本章界定从 OneBot 事件到达至唤醒投递发起的完整链路，包括闸门判定、状态写入、读取类工具与桥侧直接执行的命令；生成与出站见 §5。

### 4.1 入站主链

入口为 `handleIncoming`（`qq-bridge/src/core/mux.js:299`），由 `OneBotWsClient` 的事件回调驱动，订阅点位于 `qq-bridge/src/bridge.js:581`（私聊）、`:585`（群）、`:589`（通知）、`:595`（撤回）、`:622`（好友请求）【已核验】。

表 20：入站主链阶段（口径：序即执行顺序；常量取源码字面值）。

| 序 | 阶段 | 关键符号 | 行为与常量 |
| --- | --- | --- | --- |
| 1 | 白名单 | `allowed(kind, id, cfg)`（`qq-bridge/src/lib/config.js`） | `deny` 优先于 `allow`；两侧名单为空且 `allowAllWhenEmpty` 为真时放行并产生告警日志 |
| 2 | 正文抽取 | `textContent` / `plainContent` | 抽取纯文本用于唤醒判定与去重；含 `[CQ:` 的段与转发段不进入语料 |
| 3 | 好友守卫 | `ALARM_RE`（`qq-bridge/src/core/mux.js:273`，判定点 `:319`） | 非受信任者的违法或营销内容触发删除好友与拉黑，开关 `social.autoFriendGuard` |
| 4 | 媒体落库 | `messageMediaStore`（`qq-bridge/src/core/session-state.js:80`） | 图片、文件、语音进入内存媒体表，供本轮唤醒附图 |
| 5 | 去重 | `INBOUND_DEDUP_TTL_MS`、`INBOUND_DEDUP_MAX`（`qq-bridge/src/core/mux.js:278-279`） | 取值 `10 * 60 * 1000` 与 `800`；窗口内同一条消息只处理一次 |
| 6 | 挂起应答 | `handlePendingAnswer`（`qq-bridge/src/core/events-aux.js:44`） | 上一轮登记 `pending` 时本条视为回答；超时按 `cfgRef.questionTimeoutMs` 回复取消提示 |
| 7 | 静默闸门 | `deepsleep` 状态 | 命中后只向 `state/qq-activity.log` 写一行并结束 |
| 8 | 斜杠命令 | `qq-bridge/src/core/mux.js` 命令分支 | 见 4.5 |
| 9 | 唤醒调度 | `evaluateWakeTrigger`（`:753`）→ `scheduleWake`（`:755`） | `!st.bootstrapSent` 时走 `bootstrap` 分支，否则使用判定出的 reason |

### 4.2 会话状态写入

`appendSocialMessage`（`qq-bridge/src/core/social-flow.js:14`）在单次调用中完成两项写入：更新内存窗口 `st.recentMessages`，并调用 `persistChatMessage`（`qq-bridge/src/core/chat-db.js:619`）落入 `state/chat.db`【据仓库记载】。内存窗口容量为 `social.context.recentLimit`（默认 100，`qq-bridge/src/core/config.js:280`），持久化时保留末 200 条（`qq-bridge/src/core/social-state.js:348`）【已核验】。两套存储的数据域、检索算法与写入接口不同，混用会导致窗口与历史不一致（对照表见 §6.1）。

### 4.3 读取类工具

以 `qq-bridge/src/mcp-napcat-safe.js:1025-1549` 区间注册的读取类工具共 10 条（判据：该区间的 `registerTool` 调用点）【已核验】。

表 21：读取类工具（口径：注册行为本轮读取值；约束列为生效中的边界）。

| 工具 | 注册行 | 数据源 | 边界与约束 |
| --- | --- | --- | --- |
| `qq_get_prompt` | `:1025` | `state/social-state.json` 与角色库 | 返回值受 `dshCompaction.toolResultMaxChars` 约束，现值为 `8192`（`qq-bridge/src/core/config.js:65`） |
| `qq_get_unread_messages` | `:1039` | `st.unread` | 唤醒正文未携带未读时的补充读取 |
| `qq_get_recent_messages` | `:1053` | `st.recentMessages` | `limit` 默认 20、上限 100（`qq-bridge/src/core/console-server.js:1693`）；`offset` 仅在窗口内移动（`:1703-1705`） |
| `qq_social_state` | `:1073` | `wakeConfig` 与 `state/social-state.json` | — |
| `qq_global_overview` | `:1087` | 汇总 | — |
| `qq_mark_read` | `:1249` | `POST /api/social/mark-read` | 保留 `seq > snapMax` 的未读；无展示水位时按 `_steerDeferredSeqs` 保留推迟交付项（`qq-bridge/src/core/console-server.js:1759-1779`）；收尾置 `wakeConfig.infinite`（`:1785-1790`） |
| `qq_get_my_recent_messages` | `:1489` | `direction='out'` | 撤回操作的消息 id 来源之一 |
| `qq_get_message_detail` | `:1507` | 窗口与 `state/chat.db` | 撤回、拍一拍、收藏表情均需先取得该 id |
| `qq_get_file_content` | `:1525` | 本地与 NapCat 文件 | 读取字节数由 `clampReadBytes` 限制【据仓库记载】 |
| `qq_get_active_members` | `:1549` | `st` 活跃统计 | 精简工具档位下进入 `deny` 名单 |

### 4.4 读取接口的权限三件套

全部读取端点经同一组三道判定：会话令牌 `x-agent-token`、`SessionAllowed(key)`、`ToolEnabled(name)`【已核验】。

表 22：读取接口鉴权判定（口径：行号取自 `qq-bridge/src/core/console-server.js`）。

| 判定 | 实现 | 取值 |
| --- | --- | --- |
| 授权等级 | `trustLevelForToken`（`:269`） | 返回 `owner-private` 或 `trusted-spoke-here` |
| 信任窗口 | `TRUST_SPOKE_WINDOW_MS`（`:249`） | `600000`（10 分钟） |
| 空令牌 | `:714-717` | HTTP 403 |
| 非 JSON 请求体 | `:698-700` | HTTP 415 |
| 跨 Origin | `:702-710` | HTTP 403 |
| 工具开关 | `ToolEnabled`（`:576`） | `cfgRef.social?.tools?.[flag] !== false` |
| 全局暂停 | `social.paused` 与 `cfgRef.social.enabled === false` | 封禁 `/api/social`、`/api/send`、`/api/images` 三组端点（仅对 agent 令牌） |

### 4.5 桥侧命令与唤醒装配

斜杠命令由 `qq-bridge/src/core/mux.js` 的命令分支直接执行，不进入模型；该分支的日志前缀为 `[command]`【已核验】。

表 23：斜杠命令（口径：行文为命令与其生效对象）。

| 命令 | 行为 |
| --- | --- |
| `/reset`、`/new` | 更换 DSH 会话；清理该会话的内存状态与定时器；保留已回复账本（`resetConversationKeepingLedger`） |
| `/status` | 输出当前 `sessionId`、白名单判定结果、角色与模式 |
| `/token [天数]` | 输出用量与费用（口径见 §11.4） |
| `/op [del] <QQ号或昵称>` | 设置或取消管理员，仅所有者私聊可用；昵称经 `resolveNameToUid` 解析 |
| `/role …`、`/slang …` | 角色与黑话学习入口，内部再次判定管理员 |
| `/set active`、`/set diving` | 直接改写本会话 `wakeConfig.mode` |
| `/sleep`、`/wake`、`/deepsleep`、`/start`、`/like` | 睡眠、唤醒、深层静默、启动、点赞 |

非管理员发送任何以 `/` 开头的命令时，桥回复管理员限定提示并终止处理【据仓库记载】。`/help` 已删除，当前按其它 `/xxx` 的通用规则交给模型回应【据仓库记载】。

唤醒正文由 `qq-bridge/src/core/wake-send.js` 装配，各注入段的位置见 §6.6 与 §7.3。

### 4.6 失败与降级

表 24：接收侧失败路径（口径：证据列为源码位置或日志前缀）。

| 失败点 | 后备路径 | 证据 |
| --- | --- | --- |
| 聊天记录库不可用 | 读接口返回 `{ok:false,error:'聊天记录库不可用'}`，写路径静默返回 | `qq-bridge/src/core/chat-db.js:142` |
| FTS5 不可用 | `ftsUsable()` 为假时退回 `content LIKE ?`，响应体不再带 `ranked` 字段 | `qq-bridge/src/core/chat-db.js:155` |
| 会话映射与磁盘不一致 | 启动时剔除磁盘上不存在的 `sessionId` 并回写 | `qq-bridge/src/bridge.js:490-512` |
| 双实例启动 | 锁冲突时输出提示并 `process.exit(2)` | `qq-bridge/src/core/runtime.js:13/38/53` |
| 单实例锁读取失败 | `process.exit(1)` | `qq-bridge/src/core/runtime.js:45` |
| 白名单两侧为空 | 放行全部并产生告警日志 | `qq-bridge/src/lib/config.js` 的 `allowAllWhenEmpty` |

---

## 5. 生成、闸门与投递子系统

本章界定模型产出到 QQ 出站的完整路径，以及桥向 DSH 会话投递提示词的路径；媒体类出站见 §8，对话内容本身不属本文范围。

### 5.1 出站唯一出口

全部消息发送均经 `onebotSend`（`qq-bridge/src/core/qq-send.js`）。该函数按 `message_type` 构造 OneBot 动作与参数，并在超时前保持等待。

表 25：出站出口的关键量（口径：行号取自 `qq-bridge/src/core/qq-send.js`）。

| 项 | 取值 / 行为 | 位置 |
| --- | --- | --- |
| 单次发送超时 | `SEND_TIMEOUT_MS = 15000` | `:24` |
| 连接类失败重试前等待 | 2500 毫秒 | `:315` |
| 特定错误码重试前等待 | 2500 毫秒 | `:331` |
| 重试触发的错误模式 | `/1006514\|网络连接异常/` | `:329` |
| 第二类重试模式 | `/Get Uid Error\|uid.*(not found\|invalid)/` | `:368` |
| 未确认送达返回值 | `{message_id:null, messageId:null, unconfirmed:true}` | `:389`，结构定义于 `qq-bridge/src/lib/onebot-delivery.js:52` |
| 令牌泄露判定 | `tokenDisclosureIn(message)` 抛 `发送内容疑似泄露会话令牌，已阻止发送` | `:197-201` |

未确认送达的结果既不计入成功也不计入失败，其语义为"已投出，回执未到"【已核验】。

### 5.2 发送串行链与幂等

`enqueueSend`（`qq-bridge/src/core/send-chain.js:61`）按会话键串行化发送任务；`qq-bridge/src/core/send-idempotency.js` 提供重放窗口与已送达保留量。

表 26：串行链与幂等参数（口径：均为源码字面值）。

| 参数 | 取值 | 位置 |
| --- | --- | --- |
| 重放窗口 | `REPLAY_WINDOW_MS = 180000` | `qq-bridge/src/core/send-idempotency.js:40` |
| 已送达保留条数 | `DELIVERED_KEEP = 50` | `qq-bridge/src/core/send-idempotency.js:42` |

### 5.3 打字节拍与最小间隔

节拍由两条独立规则叠加：下限来自 `clampGap`，字数控延迟来自线性节拍。

表 27：节拍参数（口径：`LINEAR_DEFAULTS` 为默认值，现场配置可覆盖）。

| 参数 | 默认值 | 现场值 | 语义 |
| --- | --- | --- | --- |
| `linearEnabled` / `enabled` | `true` | `true` | 关闭后完全不延迟 |
| `linearPerCharMs` / `perCharMs` | `150` | `150` | 每个字符的间隔毫秒 |
| `linearMinMs` / `minMs` | `250` | `250` | 延迟下限 |
| `linearCapMs` / `capMs` | `4000` | `1500` | 延迟上限 |
| `linearJitterRatio` / `jitterRatio` | `0.25` | `0.25` | 每条随机抖动比例 |
| `linearResetMs` / `resetMs` | `60000` | `20000` | 静默归零时长 |
| 最小间隔 `MIN_GAP_MS` | `100` | — | 两次发送的最小间隔 |
| 间隔上限 | `maxGapMs` 默认 `10000` | `15000` | `clampGap` 的上界 |

默认值定义于 `qq-bridge/src/core/send-chain.js:108-115`，最小间隔定义于 `qq-bridge/src/lib/send-gaps.js:12`，`clampGap` 区间为 `[MIN_GAP_MS, max(MIN_GAP_MS, cfg.maxGapMs || 10000)]`（`qq-bridge/src/lib/send-gaps.js:23-26`）【已核验】。非数字入参按 `MIN_GAP_MS` 处理【已核验】。现场值取自 `qq-bridge/config.json` 的 `social.send`【已核验】。

字段名兼容：可调项写入 `social.send.linearEnabled`，而实现早期读取 `cfg.enabled`，现两者同时被识别且显式 `enabled` 优先（`qq-bridge/src/core/send-chain.js:127-129`）【已核验】。

### 5.4 正文切分与出站格式治理

表 28：切分与格式治理（口径：命名函数与常量均为源码字面）。

| 组件 | 位置 | 行为 |
| --- | --- | --- |
| `splitForQQ(text, max = 4000)` | `qq-bridge/src/md-to-plain.js:33`，调用点 `qq-bridge/src/core/qq-send.js:48` | 优先段落与换行边界；切不出多条时按 400 硬失败 |
| `splitSerializedBubbles` | `qq-bridge/src/lib/text-safe.js:221` | 还原被序列化成单参数的数组，避免整段当一条发送 |
| `sweepMessageArtifacts` | `qq-bridge/src/lib/outbound-text.js:24` | 清除模型回显的调用残留 |
| `cleanOutboundText` | `qq-bridge/src/lib/outbound-text.js:46` | 正文出口的入口函数 |
| `ARTIFACT_TOKEN_RE` | `qq-bridge/src/lib/outbound-text.js:21` | 判定残留的匹配式 |
| `stripImeEmoji` | `qq-bridge/src/lib/emoji.js:14` | 清除输入法附带的不可见变体选择符（模型看不见但输入框提示"含特殊字符"的根因） |
| `SILENT_MARKER = '[SILENT]'` | `qq-bridge/src/lib/markers.js:5` | 静默标记，命中即不发送任何气泡 |
| `SEND_TOOL_RE` | `qq-bridge/src/lib/markers.js:18` | 判定正文是否为发送工具调用残留 |
| `SPACE_SPLIT_HINT` / `DIRECTION_HINT` | `qq-bridge/src/lib/markers.js:25/27` | 空格切分与方向标记的相对顺序 |

模型发送多气泡的正确方式是多次调用 `qq_send_message`，而非在单条正文中插入换行【据仓库记载】（预设 `qq-chat` 的 `[TOOLS]` 段）。

### 5.5 出站闸门

表 29：出站闸门（口径：三道判定互不合并，任一命中即阻止发送）。

| 闸门 | 判定 | 命中后行为 | 位置 |
| --- | --- | --- | --- |
| 敏感内容 | `SENSITIVE_RE` | HTTP 403（控制台端点）/ 抛错（发送出口） | `qq-bridge/src/core/console-server.js:1191/2137/2488/5180`、`qq-bridge/src/core/qq-send.js:197-201` |
| 令牌泄露 | `tokenDisclosureIn(text)` | 阻止发送 | `qq-bridge/src/lib/text-safe.js:108` |
| 审计拦截 | `sensitiveHitKind` + `tokenDisclosureIn` | 调用 `handleSensitiveIntercept`（只记日志与活动记录，不向 QQ 发送任何通知） | `qq-bridge/src/core/audit.js:24/32-41` |

`handleSensitiveIntercept` 的调用点位于同文件 `:36`（`auditAndSend` 内）【已核验】，而 `auditAndSend` 的调用点在 `qq-bridge/src/core/prompt-deliver.js:13` 的导入项中【已核验】。详见 §15.1。

### 5.6 投递队列与投递模式

`qq-bridge/src/core/prompt-deliver.js` 负责把一段提示词写入目标 DSH 会话。

表 30：投递参数（口径：行号取自 `qq-bridge/src/core/prompt-deliver.js`）。

| 项 | 取值 / 行为 | 位置 |
| --- | --- | --- |
| 队列上限 | `QUEUE_MAX = 50` | `:17` |
| 入队条件 | DSH 未就绪或投递失败 | `:33-45` |
| 出队执行 | `flushQueue` 每会话串行 | `:47-112`、`:182-213` |
| 退避 | 失败后按固定步长退避 | `:90-99` |
| 尾部自排 | 队列非空时重新排程 | `:108-110` |
| 投递调用 | `mode: 'steer'`，超时 30000 | `:165` |
| 队列状态查询 | 非空时提示模型存在排队消息 | `:165-179` |

### 5.7 回合守卫与长轮询

表 31：回合级守卫（口径：均为毫秒）。

| 项 | 取值 | 行为 | 位置 |
| --- | --- | --- | --- |
| 长轮询回合上限 | `11 * 60 * 1000` | 超时按 `quarantineSession` 处理 | `qq-bridge/src/core/turn-guard.js:21` |
| 会话隔离 | 函数体 `:56-106` | 拒绝未投递项、清回合状态、删除会话映射并置 `_quarantineRebuilt` | `qq-bridge/src/core/turn-guard.js:56-106` |
| 跨会话摘要推送 | 写入路径已删除 | 仅存注释 | `qq-bridge/src/core/turn-guard.js:128-132`【已核验】 |
| 等待即应答 | `activeWaits` | 模型挂起时入站消息直接作为工具结果返回 | `qq-bridge/src/core/session-state.js:24` |
| DSH 就绪巡检 | `setInterval(checkDsh, 5000)` | 群信息预热间隔 `15 * 60 * 1000`；就绪后 `await flushQueue()` | `qq-bridge/src/core/dsh-watch.js:314/243/248` |

### 5.8 失败与降级

表 32：出站与投递失败路径（口径：证据列为源码位置）。

| 失败点 | 后备路径 | 证据 |
| --- | --- | --- |
| 卡片主档失败 | 依次降到 `native`、`link`，回执写明当前档位 | `qq-bridge/src/core/media.js:276-308` |
| `style === 'share'` 落到链接 | 视为预期形态，不计降级 | `qq-bridge/src/core/console-server.js:3428` |
| 切不出多条正文 | 400 硬失败，一条都不发 | `qq-bridge/src/lib/text-safe.js:221` |
| 发送超时未确认 | 返回 `unconfirmed: true` | `qq-bridge/src/core/qq-send.js:389` |
| DSH 未就绪 | 入队，就绪后按序冲洗 | `qq-bridge/src/core/prompt-deliver.js:33-45` |
| 投递失败 | 退避后重试，队列满则丢弃最旧项 | `qq-bridge/src/core/prompt-deliver.js:90-99` |

### 5.9 未核验

- `qq-bridge/src/core/audit.js` 的 `shouldAuditKey()` 恒返回 `true`，注释声明"closed-agent 时代跳过所有者会话的特判已删除"；该函数在现行实现下对所有会话一致，跳过逻辑是否曾存在未核验【据仓库记载】。
- `splitForQQ` 在 4000 字符上限下的具体切分点分布未做统计【未核验】。
- `qq-bridge/src/core/send-chain.js` 的 `linearCounts` 表在会话数极大时的内存占用未做测量【未核验】。

---

## 6. 记忆、检索与学习子系统

本章界定两个 SQLite 库的分工、记忆分层与检索算法、群信息缓存，以及黑话、人格、画像三条学习线的构成；人设产物的生效路径见 §7。

### 6.1 两个数据库的分工

表 33：数据库分工（口径：现场文件字节数取自 `qq-bridge/state/`，本轮实测）。

| 库 | 文件 | 现场字节 | 表 | 数据域 |
| --- | --- | --- | --- | --- |
| 聊天记录库 | `qq-bridge/state/chat.db` | 9,572,352 | `chat_convs`、`chat_messages`、`chat_fts`、`chat_stats`、`chat_meta` | 全部群聊与私聊消息，保留 7 天 |
| 记忆条目库 | `qq-bridge/state/memory.db` | 61,440 | `profiles`、`memory_entries`、`mem_fts`、`memory_meta` | 显式记忆条目与档案字段 |

`memory.db` 中**不含** `chat_messages` 表【已核验】（现场只读查询 `sqlite_master`）。两库的全文索引版本号不同：`chat_meta.fts_version = '1'`、`memory_meta.fts_version = '2'`【已核验】。现场 `chat_messages` 行数为 18,104，`chat_fts` 行数同为 18,104，`chat_convs` 为 9 个会话；`memory_entries` 为 2 条（类别 `qzone_post`）【已核验】。

### 6.2 聊天记录库

表 34：聊天记录库构成（口径：行号取自 `qq-bridge/src/core/chat-db.js`，文件 1,032 行）。

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 建表 | `:51-145` | 含 `chat_convs`、`chat_messages`、`chat_fts`、`chat_stats`、`chat_meta` 与索引 |
| 加列迁移 | `:83`、`:84`、`:85` | 三条 ALTER |
| 消息 id 索引 | `:99` `idx_chat_msgid` | 撤回与详情查询用 |
| 迁移标记 | `:35` `FTS_SCHEMA_VERSION = '1'`、`:36` `MIGRATE_MARK='migrated_from_memory_db'` | 现场值为 `1790261226594` |
| 写入 | `:619` `persistChatMessage` | 幂等去重在 `:628-632`，正文截断 `slice(0, 2000)` 在 `:653` |
| 计数维护 | `:398` `bumpCountersOnInsert`，调用点 `:661` | 与总量表同步 |
| 全量重算 | `:320` `recountChatCounters`，自检 `:304-309` | 启动自检不一致时以 `setTimeout(…, 0)` 触发 |
| 标记已读 | `:668` `markMessagesRead` | — |
| 标记撤回 | `:691` `markChatRecalled` | — |
| 检索 | `:859` `searchChatMessages` | 条件顺序 `:864-890`，FTS JOIN `:878`，排序 `ORDER BY bm25(chat_fts) ASC` `:881`，分页 `:897` |
| 跨会话检索 | `:789` `recentMessagesAcrossSessions` | — |
| 学习语料 | `:966` `loadGroupChatMessagesForLearning` | 只读 |

### 6.3 记忆条目库

表 35：记忆条目库构成（口径：行号取自 `qq-bridge/src/core/memory.js`，文件 763 行）。

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 建表 | `:46-80` | `profiles` `:52`、`memory_entries` `:62`、索引 `:69` |
| 加列迁移 | `:104-115` | 补 10 列，ALTER 在 `:118` |
| 元表与索引 | `:124-131` | — |
| 全文索引 | `:143-165` | `mem_fts` 与三个同步触发器 `:156/159/162` |
| 版本号 | `:90` `FTS_SCHEMA_VERSION = '2'` | 现场 `memory_meta.fts_version = '2'` |
| 分层 | `:87` `MEMORY_TIERS` | `permanent 0` / `durable 90 天` / `working 7 天` |
| 永久类别 | `:89` `PERMANENT_CATEGORIES` | 该集合内条目不受清理 |
| 写入 | `:547` `rememberEntry` | 幂等键 `:576-584`；落盘截断 `:552-565` |
| 写入归一化 | `:530` | 裸 `INSERT` 路径同样过归一化 |
| 联系人记忆 | `:245-259` `rememberContactName` | — |
| 清理 | `:668` `pruneExpiredMemory`，调用点 `:696-701` | — |
| 主题与印象 | `:442-498` | `activeTopics`、`pendingThoughts`、`memberImpressions` |
| 注入函数 | `:433` `appendMemory` | 分支含 `memberImpression` |
| 列表读取 | `:619` `listMemoryEntries` | — |
| 格式化 | `:386` `formatMemory` | 含 `Impressions` 段 `:420-429` |
| 摘要 | `:690` `memoryDigest` | 内层钳制见 6.6 |
| 档案字段 | `:267-285` `setProfileField`、`:287` `formatProfileText` | 字段白名单 `:267-274` |

### 6.4 群信息缓存

`qq-bridge/src/core/group-cache.js`（126 行）维护三个内存缓存（`:6`、`:9`、`:14`），共用 TTL `GROUP_INFO_TTL_MS`（`:7`）与 `GROUP_LIST_TTL_MS = 10 * 60 * 1000`（`:15`）【已核验】。名称回填 `warmGroupName` 定义于 `:49-70`（`:22-35` 为 `nameFromGroupList`）；群信息回填 `warmGroupInfo` 定义于 `:89-112`，其角色判定位于 `:100-102`，只接受 `owner` 与 `admin`【已核验】。预热挂载于 `qq-bridge/src/core/dsh-watch.js:232-245`，间隔 `15 * 60 * 1000`（`:243`）【已核验】。

### 6.5 全文检索

`ftsQueryOf`（`qq-bridge/src/lib/fts.js:22`）把自然语言查询切成检索词：切词正则位于 `:25`，只保留长度 `>= 3` 的词，最多保留 8 个（`:28`）【已核验】。查询短于 3 个字符时返回空串，调用方退回 `content LIKE ?`。`ftsUsable`（`:12`）在初次使用失败后返回假【已核验】。

### 6.6 记忆注入位置

唤醒正文中的记忆摘要在 `memoryDigest({ uid, limit: 14, maxChars: 700 })` 调用点（`qq-bridge/src/core/wake-send.js:479`），其输出行标记为 `[Recall]`，位于 `qq-bridge/src/core/wake-send.js:485`【已核验】。

`memoryDigest`（`qq-bridge/src/core/memory.js:690`）的内层钳制为：`limit` 夹在 `1..30`（默认 12），`maxChars` 夹在 `120..4000`（默认 700），单行 `slice(0, 140)`（`:703-731`）【已核验】。

该位置选择的依据记录于源码注释【据仓库记载】：系统提示词一旦变化即导致前缀缓存整段失效，而唤醒正文每轮本来就新，因此摘要放在唤醒正文中的代价仅为自身字符数。该结论与 `docs/COMPACTION-MATH.md` 的核心结论对应。

### 6.7 学习基础设施

三条学习线共用同一套基础设施：独立学习会话、独立学习令牌、共享语料入口、共享配置与状态文件。

表 36：学习线模块与规模（口径：行数为本轮实测）。

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `qq-bridge/src/core/persona-learn.js` | 1136 | 人格学习：取样、学习会话、产出 JSON、落库、人设草稿与审批 |
| `qq-bridge/src/core/persona-text.js` | 153 | 结构化画像组装为中文人设文本（去重、排序、截断） |
| `qq-bridge/src/core/slang.js` | 829 | 黑话学习：窗口、抽取、研究、夜间定时、水位 |
| `qq-bridge/src/slang-learner.js` | 360 | 黑话词条结构、去重键、状态机、提示词构造与解析 |
| `qq-bridge/src/core/portrait-learn.js` | 257 | 群友画像：按活跃度选人，复用人格通道 |
| `qq-bridge/src/core/learning-token.js` | 63 | 学习令牌生成与校验 |
| `qq-bridge/src/lib/preset-compose.js` | 143 | 人设与发言规则合成进预设 |
| `qq-bridge/src/mcp-host-server.js` | 344 | 学习会话可见的两个工具 |

学习会话的创建流程（`qq-bridge/src/core/persona-learn.js:116-149`）：以 `state/persona-agent` 为 workspace 路径调用 `workspace.create`，必要时 `workspace.rename` 为 `cfg.persona.workspaceTitle`（默认 `PersonaAgent`；黑话侧 `slang.workspaceTitle` 默认 `SlangAgent`），随后调用 `sessions.create` 并附 `agentPreset`。会话 id 落盘 `state/persona-agent.json` 与 `state/slang-session.json`，复用顺序为内存、文件、新建【据仓库记载】。`unwrap`（`qq-bridge/src/dsh-client.js:96-100`）在 `response.result.ok` 为假时抛出 `Error(\`${label} failed: ${code}: ${message}\`)`【已核验】。学习会话登记进 `learnerSessions` 并调用 `markPersistentLearner(sessionId)`，以免被会话归档器回收【据仓库记载】。

首轮任务说明由 `ensurePersonaBrief`（`:154`）以 `mode: 'queue'` 注入一次，版本常量 `PERSONA_BRIEF_VERSION = 5` 位于 `:318`，标记 `[PERSONA RUN]`；等待回合用 `PERSONA_TURN_TIMEOUT_MS = 300000`（`:42`）。首轮说明等待超时不阻塞，只记一行日志并继续发送本轮提醒【已核验】。黑话侧对应 `SLANG_BRIEF_VERSION = 3` 与标记 `[SLANG RUN]`【已核验】。

学习链路使用 `mode: 'queue'`，与聊天的 `mode: 'steer'` 不同（对照 §2.3）【已核验】。

学习令牌由 `ensureLearningToken`（`qq-bridge/src/core/learning-token.js:30-52`）生成并落盘 `state/learning-token`（现场 33 字节），校验函数为 `isValidLearningToken`（`:55-63`）【已核验】。

### 6.8 语料入口

`qq_learning_corpus`（`qq-bridge/src/mcp-host-server.js:142`，工具名在 `:143`）向学习会话提供只读语料。

表 37：`qq_learning_corpus` 参数（口径：默认值与上限取自源码）。

| 参数 | 语义 | 默认与上限 |
| --- | --- | --- |
| `sinceMs` | 起（含） | 默认最近 24 小时 |
| `untilMs` | 止（含） | 默认当前时刻 |
| `limit` | 返回条数 | 默认 400，上限 800 |
| `convKeys` | 限定会话 | 最多 50 个；省略时只查 `conv_key LIKE 'group:%'` |
| `targetUid` | 只看指定发送方 | 人格学习使用 |

查询基础段（逐字，`qq-bridge/src/core/chat-db.js` 侧实现）：

```sql
direction = 'in' AND is_self = 0 AND kind IN ('text','qqface') AND content <> '' AND ts_ms >= ? AND ts_ms <= ?
  AND content NOT LIKE '/%' AND content NOT LIKE '[CQ:%' AND content NOT LIKE '[转发%'
SELECT conv_key, sender_uid, sender_name, content, ts_ms FROM chat_messages WHERE … ORDER BY ts_ms ASC, id ASC LIMIT ?
```

该工具以 `readOnly: true` 打开数据库（`qq-bridge/src/mcp-host-server.js:167`），且在语料库不可用时不整体失败，而是退回默认查询路径（`:158-161`）【已核验】。

### 6.9 黑话学习

`qq-bridge/src/core/slang.js`（829 行）的相位取值位于 `:637-642`，注入函数 `withSlangContext` 位于 `:400-409`，已确认词表 `confirmedSlangList` 位于 `:387`（默认 `max = 8`，`:388`），窗口大小 80 位于 `:355`，手动回看窗口 `SLANG_MANUAL_LOOKBACK_MS` 位于 `:597`【已核验】。

表 38：黑话学习常量（口径：源码字面值）。

| 常量 | 取值 |
| --- | --- |
| `NIGHTLY_TICK_MS` | `60 * 1000` |
| `MAX_LEARN_BLOCKS` | `3` |
| `MAX_LEARN_MSGS` | `2400` |
| `MAX_BLOCK_MSGS` | `800` |
| `LEARN_TURN_TIMEOUT_MS` | `5 * 60 * 1000` |
| `NIGHTLY_RETRY_MS` | `5 * 60 * 1000` |
| `SLANG_MANUAL_LOOKBACK_MS` | `24 * 3600 * 1000` |

提前返回分支位于 `:600`、`:672`、`:678`，分别对应 `disabled`、`dsh-unready`、`busy` 三种原因【已核验】；`isLearnerSessionGone` 位于 `:58-63`【已核验】。词条结构由 `normalizeSlangEntry`（`qq-bridge/src/slang-learner.js:36-57`）定义，状态集合 `SLANG_STATUS` 位于 `:15-19`（`candidate` / `confirmed` / `rejected`），去重键 `slangKey` 位于 `:110-117`【已核验】；对外投影 `publicSlangEntry` 位于 `qq-bridge/src/core/slang.js:371`【已核验】。

### 6.10 人格学习

`qq-bridge/src/core/persona-learn.js`（1136 行）的产出归一化由 `normalizePersona`（`:404-452`）完成，其中人格段上限 `PERSONALITY_MAX = 1200`（`:43`）、英文人设上限 `PERSONA_EN_MAX = 6000`（`:47`）【已核验】。提示词任务书由 `buildPersonaTaskBrief`（`:329-370`）构造，JSON 解析由 `parsePersonaJson`（`:454-474`）完成【已核验】。写入档案字段调用 `memory.js` 的 `setProfileField`，调用点位于 `:520`【已核验】。

表 39：人格学习的边界参数（口径：源码字面值）。

| 参数 | 取值 | 位置 |
| --- | --- | --- |
| 学习会话等待上限 | `300000` | `:42` |
| 备份保留份数 | `PERSONA_BACKUP_KEEP = 5` | `:48` |
| 采样总量上限 | `SAMPLE_TOTAL_CAP = 300` | `:37` |
| 防退化阈值 | `KEEP_OLD_MIN = 60` | `:498` |
| 英文人设上限 | `PERSONA_EN_MAX = 6000` | `:47` |
| 人格段上限 | `PERSONALITY_MAX = 1200` | `:43` |

防退化合并 `mergePersonaProfileText`（`:493-503`）的语义为：新文本短于旧文本的 60 个字符以上时保留旧文本【已核验】。审批与生效由 `personaApply`（`:682-749`）执行，`mode` 取 `save` / `apply` / `fuse` 三者之一；`apply` 分支在 `:710` 拒绝含中文的输入【已核验】。草稿融合由 `personaFuseDraft`（`:765-835`）执行。人设库对象字面量位于 `:526-548`，其持久化函数 `savePersonaLibrary` 的声明位于 `:109`【已核验】。

### 6.11 群友画像

`qq-bridge/src/core/portrait-learn.js`（257 行）的默认参数 `PORTRAIT_DEFAULTS` 位于 `:18-27`：`minMessages` 为 10、`maxTargets` 为 20、`windowHours` 为 720【据仓库记载】。定时器 `PORTRAIT_TICK_MS` 位于 `:29`，目标筛选 `eligiblePortraitTargets` 位于 `:83-108`（SQL 位于 `:88-100`），失败分支位于 `:123` 与 `:186-191`（分别为忙碌提前返回与自动巡检退避）【已核验】。

### 6.12 已知缺陷

表 40：已复现的两处数据源错用（口径：本轮以只读方式在 `qq-bridge/state/memory.db` 上执行同一条 SQL 复现）。

| 缺陷 | 位置 | 观测结果 | 后果 |
| --- | --- | --- | --- |
| 人格学习取样查错库 | `qq-bridge/src/core/persona-learn.js:223` 取 `initMemoryDb()`，`:238`、`:243` 查 `chat_messages` | `no such table: chat_messages` | `collectTargetSamples` 恒返回 0 样本，收尾文案为"近 N 天没有找到该账号的发言记录"（`:602-605`） |
| 群友画像筛选查错库 | `qq-bridge/src/core/portrait-learn.js:84` 取 `initMemoryDb()`，`:88-100` 查 `chat_messages` | `no such table: chat_messages` | `eligiblePortraitTargets` 恒返回 `ok:false`，`portraitLearnStart` 与自动巡检进入 30 分钟退避 |

两处异常均被 `catch` 吞为日志（`qq-bridge/src/core/persona-learn.js:240/245`、`qq-bridge/src/core/portrait-learn.js:106`）【已核验】。正确连接应为 `initChatDb()`（`qq-bridge/src/core/chat-db.js:51`）；旁证为同仓的 `loadGroupChatMessagesForLearning`（`qq-bridge/src/core/chat-db.js:966`）与 `qq_learning_corpus`（`qq-bridge/src/mcp-host-server.js:142`）均使用 `chat.db`【已核验】。画像 SQL 还引用了 `chat.db` 独有的 `recalled_at` 列，可进一步确认目标库为 `chat.db`【已核验】。

### 6.13 失败与降级

表 41：记忆与检索的失败路径（口径：证据列为日志前缀或源码位置）。

| 场景 | 行为 | 证据 |
| --- | --- | --- |
| 记忆库不可用 | `initMemoryDb` 返回 null，各函数早退 `{ok:false,error:'记忆库不可用'}` | `qq-bridge/src/core/memory.js:77` |
| 聊天库不可用 | 读接口返回 `{ok:false,error:'聊天记录库不可用'}`，写路径静默返回 | `qq-bridge/src/core/chat-db.js:142` |
| 全文索引不可用 | 退回 `content LIKE ?` | `qq-bridge/src/core/chat-db.js:155` |
| 查询短于 3 字 | `ftsQueryOf` 返回空串，响应体无 `ranked` 字段 | `qq-bridge/src/lib/fts.js:22` |
| 加列或索引失败 | 逐步 try/catch，只记日志 | `qq-bridge/src/core/memory.js`、`qq-bridge/src/core/chat-db.js` 的"加列失败（忽略）"类日志 |
| 迁移条数不一致 | 保留旧表，下次启动重试 | `qq-bridge/src/core/chat-db.js:260` |
| 计数漂移 | 启动自检不一致时全量重算 | `qq-bridge/src/core/chat-db.js:307` |
| 索引落后 | 版本水位不符时启动重建 | `chat_meta.fts_version='1'`、`memory_meta.fts_version='2'` |

### 6.14 未核验

- `qq-bridge/state/memory.db.pre-v13-backup`（7,553,024 字节）在全仓检索无任何引用，其产出者未核验【未核验】。
- 现场 `chat_messages.ts` 存在两种文本格式（早期 `2026-08-31 19:22:23`，较新 `2026-09-08 周二 08:42:59`），`date` 过滤在两种格式下均成立，格式不一致的成因未核验【未核验】。
- `qq-bridge/state/persona-library.json`、`state/persona-agent.json`、`state/session-archive.json` 三个路径在仓库中不存在：人设库与学习会话 id 的实际落盘文件未核验【未核验】。
- §6.12 两处缺陷的修复方案与影响面未评估【未核验】。

---

## 7. 人设、角色与表达子系统

本章界定人设产物的组装、落库、注入与切换机制，以及出站正文的表达约束；人设的学习过程见 §6.10。

### 7.1 人设文本组装

`qq-bridge/src/core/persona-text.js`（153 行）把结构化画像组装为一段中文人设文本，处理步骤为去重、排序、截断。

表 42：人设文本组装（口径：行号取自 `qq-bridge/src/core/persona-text.js`）。

| 符号 | 位置 | 行为 |
| --- | --- | --- |
| `splitSentences` | `:21` | 按句切分，用于去重单位 |
| `keyOf` | `:30` | 归一化比较键，去除空白与标点；标点字符类中的全角波浪号在源码中写作 `\uFF5E` 转义形式 |
| `cleanNickname` | `:37` | 昵称清洗 |
| 组装顺序 | `:85-127` | 固定段序输出 |
| `PROFILE_MAX` | `:18` | 总值上限 4000 字符 |

### 7.2 人设生效路径

人设有两条互相独立的生效路径，文件路径负责持久化，运行时覆盖负责即时生效。

表 43：人设生效路径（口径：两条路径的写入对象不同，互不覆盖对方）。

| 路径 | 实现 | 写入对象 | 生效时机 |
| --- | --- | --- | --- |
| 文件型 | `qq-bridge/src/lib/preset-compose.js` | `.agent-presets/qq-chat/agent.cordis.yml` 中的合成段 | 审批通过并写入预设后，新会话加载时生效 |
| 运行时型 | `qq-bridge/src/core/wake-send.js:311-326` | 唤醒正文的 `[PERSONA]` 段 | 每轮唤醒即时生效 |

文件型路径使用的段标记常量 `COMPOSE_BEGIN` / `COMPOSE_END` 声明于 `qq-bridge/src/lib/preset-compose.js:19-20`，合成函数位于 `:33-59`，反向剥离函数为 `stripOverrideBlock`（`:63`）【已核验】。

运行时路径的容量约束为 `RUNTIME_OVERRIDE_MAX['persona.md'] = 16000`（`qq-bridge/src/core/wake-send.js:248`），超限时按保尾策略截断，保尾长度 2500（`:250`）【已核验】。

### 7.3 唤醒正文的注入段

表 44：唤醒正文注入段（口径：行号取自 `qq-bridge/src/core/wake-send.js`，文件 1,940 行）。

| 段 | 标记 | 位置 | 内容 |
| --- | --- | --- | --- |
| 唤醒引用 | `[WakeRef]` | `:334-340` | 触发本次唤醒的消息引用 |
| 记忆摘要 | `[Recall]` | `:485` | `memoryDigest` 输出，见 §6.6 |
| 画像 | `[Profile]` | `:486` | 结构化档案文本 |
| 运行时人设 | `[PERSONA]` | `:311-326`（入队位于 `:322`） | 覆盖型人设文本 |
| 最近窗口 | — | `formatRecentWindow` `:593` | 近期对话窗口，轮换后首轮走 `:1820-1822` 分支 |
| 语音与表情提示 | — | `:538`、`:1766` | 由 `tokenLine`、`statusLine`、`wakeLine`、`voiceTurnHint`、`memeTurnHint` 拼接 |

未读水位补回位于 `:1316-1334`，会话准入复查位于 `:1281-1284`，窗口轮换阈值计算位于 `:95-97`，轮换推迟上限 `ROTATE_DEFER_MAX_MS = 120000` 位于 `:75`【已核验】。

### 7.4 角色库

角色库以文件目录形式承载，扫描根由 `social.charactersDir` 指定。

表 45：角色相关工具（口径：注册行取自 `qq-bridge/src/mcp-napcat-safe.js`）。

| 工具 | 注册行 | 行为 |
| --- | --- | --- |
| `qq_character_list` | `:4601` | 列出角色包 |
| `qq_character_read` | `:4617` | 读取指定角色文本 |
| `qq_character_pack` | `:4634` | 读取角色包内容 |
| `qq_character_search` | `:4650` | 按关键词检索角色 |
| `qq_character_switch` | `:4665` | 切换当前角色 |

当前角色标识落盘 `qq-bridge/state/current-role.json`（现场 46 字节）【已核验】；发送前由 `qq-bridge/src/core/audit.js:19` 读取该状态参与判定【已核验】。角色切换的人设替换逻辑位于 `qq-bridge/src/lib/persona-switch.js`（224 行）【据仓库记载】。

### 7.5 表达约束

表达约束以预设文本形式下发，不参与代码判定。

表 46：表达约束（口径：约束均为预设文本中的规则条目，桥侧不校验其遵守情况）。

| 约束 | 内容 |
| --- | --- |
| 换行 | 出站正文不包含换行符；多气泡通过多次调用 `qq_send_message` 实现 |
| 长度 | 单条正文上限由 `social.send.maxMessageChars` 决定，现场值为 `1000` |
| 颜文字 | 仅允许出现在正文末尾，且计入字数上限 |
| 代码块 | 不在一段回复中使用代码块分段 |
| 静默 | 模型判定无需回复时输出 `[SILENT]` |

### 7.6 表达辅助模块

表 47：表达辅助模块（口径：行数为本轮实测）。

| 模块 | 行数 | 作用 |
| --- | --- | --- |
| `qq-bridge/src/lib/at-target.js` | 88 | 判定是否需要 `@` 目标及构造 `at` 段 |
| `qq-bridge/src/lib/cjk-split.js` | 73 | 中日韩文本按宽度切分 |
| `qq-bridge/src/lib/cjk.js` | 33 | 字符宽度判定 |
| `qq-bridge/src/lib/emoji.js` | 36 | 变体选择符清除 `stripImeEmoji` |
| `qq-bridge/src/lib/qq-face-parse.js` | 34 | QQ 内置表情文本与 face id 互转 |
| `qq-bridge/src/core/role-hint.js` | 62 | 角色提示行生成 |
| `qq-bridge/src/lib/segment.js` | 51 | 消息段结构与拼接 |
| `qq-bridge/src/lib/message-parse.js` | 531 | 消息正文与段解析；`[骰子]`（`:119`）与 `[猜拳]`（`:120`）文案 |
| `qq-bridge/src/lib/html-text.js` | 236 | HTML 转纯文本 |
| `qq-bridge/src/sticker-lib.js:165` `buildStickerContext` | — | 每轮注入表情候选，上限由 `promptMaxStickers` 决定，现场为 8 |

### 7.7 失败与降级

表 48：人设与表达的失败路径（口径：证据列为源码位置）。

| 场景 | 行为 | 证据 |
| --- | --- | --- |
| 人设文本为空 | 不注入 `[PERSONA]` 段，其余段落照常 | `qq-bridge/src/core/wake-send.js:311-326` |
| 运行时人设超限 | 按保尾 2500 字符截断 | `qq-bridge/src/core/wake-send.js:248/250` |
| 角色包缺失 | 工具返回明确错误，不切换 | `qq-bridge/src/mcp-napcat-safe.js:4601-4665` |
| 表情库为空 | 不注入表情候选段 | `qq-bridge/src/sticker-lib.js:165` |
| 正文含换行 | 由 `splitForQQ` 切分为多条 | `qq-bridge/src/md-to-plain.js:33` |

### 7.8 未核验

- `qq-bridge/characters/` 目录下含 21 个子目录与 2 个散装文件（`角色库说明.md`、`ATRI_MAIN_PROMPT.md`）【已核验】。
- 表达约束的实际遵守率未做统计【未核验】。

---

## 8. 媒体处理子系统

本章界定图片、表情、语音、文件、视频五类媒体的接收与发送机制，包括字节与像素闸门、安全抓取、转码、卡片构造与降级档位。

### 8.1 媒体接收

接收入口为 `fetchOneBotImage`（`qq-bridge/src/core/media-pipe.js:72`）。

表 49：媒体接收闸门与分支（口径：行号取自 `qq-bridge/src/core/media-pipe.js`，文件 348 行）。

| 项 | 位置 | 取值 / 行为 |
| --- | --- | --- |
| 单件字节上限 | `:15` | `MAX_MEDIA_BYTES = 25 * 1024 * 1024` |
| 单件像素上限 | `:16` | `MAX_MEDIA_PIXELS = 64_000_000` |
| 会话级条数上限 | `:17` | `MAX_MEDIA_STORE_PER_KEY = 500` |
| 直通模式 | `:78` `asIs` | 关闭降采样时原样传递 |
| 分支点 | `:80-86`、`:91`、`:93`、`:95-96`、`:106`、`:108`、`:114`、`:116`、`:121`、`:123-127`、`:142` | 按 URL 形式、本地路径、`base64`、`file` 段分别取字节 |
| 表情取图 | `:156` `fetchFaceMedia` | 实体查询超时 `12000`（`:165`） |
| 降采样闸门 | `:197` `gateImage` | 超限时降采样或跳过 |
| 占位文案 | `:207`、`:217`、`:227`、`:229` | 见 8.15 |
| 列表解析 | `:232`、`:260`、`:272-280` | `resolveMediaList` |
| 数据读取 | `:287`、`:321-323` | `fetchMediaData` |

### 8.2 下载与安全抓取

`qq-bridge/src/safe-fetch.js`（456 行）是被媒体层复用的纯工具库，不注册任何 MCP 工具【已核验】。

表 50：安全抓取（口径：行号取自 `qq-bridge/src/safe-fetch.js`）。

| 项 | 位置 | 取值 / 行为 |
| --- | --- | --- |
| 私有网段判定 | `:66` `isPrivateIp` | IPv4 覆盖 `10/8`、`127/8`、`0/8`、`169.254/16`、`172.16-31`、`192.168/16`、`100.64-127`、`198.18-19`、`192.0.0`、`>= 224`；IPv6 覆盖 `::`、`::1`、`fc\|fd`、`fe8x-febx`、`fecx-fefx`、`2001:db8`、`2001:2/10/20`、`2002::/16`、`ff`；同时解嵌 IPv4-mapped 与 NAT64 形式 |
| 解析与校验 | `:107` `resolveSafeHost`、`:124-128`、`:132` `validateFetchUrl` | 校验在连接前执行 |
| 完整性校验 | `:286` `verifyImageComplete` | — |
| 下载字节上限 | `:348` | `MAX_IMAGE_FETCH_BYTES = 15 * 1024 * 1024` |
| 缓冲抓取 | `:362` `safeFetchBuffer` | 单请求实现 `requestOnceBuffer`（`:394`，未导出） |
| 重定向上限 | `:363`（另一处 `:215`） | `MAX_REDIRECTS = 5` |
| 重定向后复检 | `:376-378`、`:382-385` | 每次跳转后重新校验目标 |

### 8.3 图片压缩与转码

`qq-bridge/src/lib/image-compress.js`（316 行）提供解码、缩放、编码三段。

表 51：图片压缩常量（口径：源码字面值）。

| 常量 | 取值 | 位置 |
| --- | --- | --- |
| `IMAGE_MAX_SIDE` | `1280` | `:30` |
| `IMAGE_HARD_MAX_SIDE` | `4096` | `:32` |
| `IMAGE_HARD_MAX_BYTES` | `15MB` | `:47` |
| `IMAGE_PUREJS_MAX_PIXELS` | `40_000_000` | `:49` |
| `IMAGE_JPEG_QUALITY` | `82` | `:50` |
| `IMAGE_MIN_COMPRESS_BYTES` | `40 * 1024` | `:51` |
| `IMAGE_ANIM_KEEP_MAX` | `4MB` | `:52` |

函数入口：`compressImageBuffer`（`:242`），动图超过上限时原样返回（`:253`）；`finalizeImageBuffer`（`:272`）；`ensureDeliverableImage`（`:292`）。JPEG 解码参数位于 `:194`（`maxResolutionInMP: 200`、`maxMemoryUsageInMB: 1024`）【已核验】。

### 8.4 外发图统一入口

全部发图工具经 `napcatImageFileArg`（`qq-bridge/src/lib/napcat-file.js:60`）构造 OneBot 的 `file` 参数。

表 52：外发图路径治理（口径：行号取自 `qq-bridge/src/lib/napcat-file.js`，文件 97 行）。

| 项 | 位置 | 行为 |
| --- | --- | --- |
| 模式解析 | `:31` `resolveImageFileMode` | 取值 `path` / `base64` / `auto`，默认 `path` |
| 容器路径改写 | `:39` `rewriteToContainerPath` | Docker 部署下的路径映射 |
| 参数构造 | `:60` `napcatImageFileArg` | 按模式返回 `file://` 路径或 `base64://` |
| `base64` 字节上限 | `:27` | `DEFAULT_BASE64_MAX_BYTES = 10 * 1024 * 1024` |
| 表情临时目录 | `:92` `resolveStickerTmpDir` | — |

### 8.5 收藏表情

收藏表情以本地认知层形式存在，QQ 侧为源。存储文件为 `qq-bridge/state/stickers.json`（现场 10,292 字节）【已核验】；写盘走原子写并设置权限 `0o600`（`qq-bridge/src/sticker-lib.js:60-63`）【已核验】。

表 53：表情库函数（口径：`src/sticker-lib.js` 指 `qq-bridge/src/sticker-lib.js`，241 行）。

| 函数 | 位置 | 行为 |
| --- | --- | --- |
| `normalizeStickerEntry` | `src/sticker-lib.js:22-45` | 条目 17 个字段：`id`、`resId`、`url`、`md5`（大写）、`desc`、`localNote`、`tags`（上限 20）、`usage`、`source`、`useCount`、`lastUsedAt`、`lastContext`（上限 200）、`createdAt`、`updatedAt` 等 |
| `mergeStickerLibrary` | `src/sticker-lib.js:69` | 只覆盖 QQ 侧字段，保留本地字段 |
| `findSticker` | `src/sticker-lib.js:115` | 两轮匹配：先精确（`id` / `resId` / 大写 `md5`），后模糊（去协议与尾斜杠后互相包含） |
| `formatStickerList` | `src/sticker-lib.js:133` | 返回 `{total, matched, truncated, stickers[]}`；`max = max(1, min(500, limit \|\| 48))` |
| `buildStickerContext` | `src/sticker-lib.js:165` | 按 `useCount` 降序取 `min(30, max \|\| 8)` 条 |
| `syncStickerLibrary` | `qq-bridge/src/core/sticker.js:117` | TTL 默认 `60000`（`:120`），上限 `min(500, max(1, maxListCount \|\| 100))`（`:126`） |
| 优先接口 | `qq-bridge/src/core/sticker.js:131-139` | 先 `fetch_custom_face_detail`，失败退回 `fetch_custom_face` |
| 载荷兼容 | `qq-bridge/src/core/sticker.js:141-146` | 接受 `payload` / `payload.data` / `payload.list` / `payload.faces` / `payload.customFaceList` |
| `md5` 提取 | `qq-bridge/src/core/sticker.js:151` | `/([0-9A-F]{32})(?:_0_0\|\/0\|\/\|$)/i` |
| 强制重同步冷却 | `qq-bridge/src/core/sticker.js:43` | `FORCE_LOOKUP_COOLDOWN_MS = 30000` |

发送链路 `sendSticker2`（`qq-bridge/src/core/sticker.js:220`）：缓存未命中时先 `forceResyncForLookup()`（`:235-236`，受 `:43` 冷却约束）；一次调用只发一张表情（`:239`）；构造参数（`:244`）；归一化（`:251-255`）；`add_custom_face` 不被支持时降级为本地图库引用 `local://`（`:546-554`）；发送失败且错误含 `识别URL失败` 或 `ENOENT` 时以 `base64` 重发一次（`:313-320`）。

收藏链路为 `collectSticker2`（`qq-bridge/src/core/sticker.js:489`）：`:498` 取 id、`:509-521` 收集候选、`:526` 去重、`:527` 落库、`:531-561` 生成描述。`collectFaceSupported` 的探测与降级位于 `:53-89`【已核验】。备注写入为 `applyStickerNote2`（`:457`）、`setStickerRemark2`（`:469`）、`set_custom_face_desc`（`:582-590`）。

### 8.6 内置表情包

表 54：内置表情包机制（口径：行号取自 `qq-bridge/src/mcp-napcat-safe.js`，文件 4,745 行）。

| 项 | 位置 | 取值 / 行为 |
| --- | --- | --- |
| 扫描间隔 | `:73` | `MEME_RESCAN_MS = 5000` |
| 旧包标识 | `:71` | `MEME_LEGACY_PACK_ID` |
| 目录布局说明 | `:51-58` | 包目录与 `index.db` 的层级约定 |
| 启动告警 | `:249-256` | 缺包时向 stderr 输出候选路径 |
| 缺包提示 | `:271` | `memeMissingHint` |
| 包排序 | `:287-296` | `orderedMemePacks` |
| 路径查询 | `:303` | `queryMemePath` |
| 概率查询 | `:321` | `firstMemeByQuery` |
| 工具注册 | `:2066` `qq_meme_search`、`:2116` `qq_send_meme` | — |

`index.db` 的 `memes` 表结构为 8 列：`path`（主键）、`tag`、`file_name`、`file_hash`、`caption`（默认空串）、`keywords`（默认空串）、`mtime`、`captioned_at`（`qq-bridge/src/mcp-napcat-safe.js:111-115` 为扫描根定义）【已核验】。

现场状态：仓库内 `qq-bridge/` 下不存在任何 `meme*` 目录，仓库根 `meme/` 为空；磁盘上存在三份 `whale-fanart-001/index.db` 副本（`.runtime/meme-full/`、`.runtime/idx-extract/`、`.runtime/tarcheck/`，各 61,440 字节，`memes` 表均为 162 行），三者均不在 `:111-115` 的扫描根之内，即该包未安装在生效位置【已核验】。

### 8.7 QQ 内置表情

`qq_face_list`（注册行 `:2772`）提供 face id 与名称对照，`qq_send_qq_face`（`:2792`）发送。发送实现为 `sendQqFace2`（`qq-bridge/src/core/sticker.js:359`）【已核验】。未知 face 由 NapCat 侧返回错误，桥侧不做本地校验【据仓库记载】。

### 8.8 联网找图

`qq-bridge/src/lib/image-search.js`（182 行）实现两个来源的检索：`bingImageSearch`（`:48`）与 `baiduImageSearch`（`:81`），入口为 `searchImages`（`:122`），超时 `TIMEOUT_MS = 9000`（`:14`）【已核验】。

表 55：联网找图边界（口径：行号取自 `qq-bridge/src/lib/image-search.js`）。

| 项 | 位置 | 行为 |
| --- | --- | --- |
| 失败计数 | `:132-143` | 单来源连续失败后短暂停用 |
| 来源轮转 | `:151` | 按失败状态轮转 |
| 结果打分 | `:170-177` | 按尺寸与来源加权 |
| 条数上限 | 调用方 | `limit <= 20` |

### 8.9 Pixiv

`qq-bridge/src/lib/pixiv.js`（1,684 行）提供搜索、作品详情、原图获取、用户作品与用户搜索五类能力。

表 56：Pixiv 参数（口径：行号取自 `qq-bridge/src/lib/pixiv.js`）。

| 项 | 位置 | 取值 |
| --- | --- | --- |
| 默认反代基址 | `:122` | `https://x.pixigraph.xyz` |
| 请求超时 | `:124` | `TIMEOUT_MS = 15000` |
| 基址选择 | `:147` | `pickPixivBase` |
| 图片档位 | `:207` | `original` / `master` / `thumb` / `unknown` |
| 发送计划 | `:232` | `planPixivSend` |
| 尺寸判定 | `:269` | `pixivTierSizeVerdict` |
| 成人内容判定 | `:324-328`、`:1464` | `isAdult`、`isAdultWork` |
| 翻页默认与上限 | `:332-333` | 默认 3，上限 10 |
| 过滤键 | `:343` `NEW_KEYS`、`:351` `normalizePixivFilters`、`:479` `filterPixivItems` | — |
| 搜索来源 | `:913-917` | `PIXIV_SEARCH_SOURCES` |
| Cookie 与登录态 | `:998` `pixivCookie`、`:1104` `pixivLoginState` | — |
| 艺术家缓存上限 | `:1017` | `ARTIST_CACHE_MAX = 500` |
| 请求头 | `:1071-1084` | `pixivRequestHeaders` |
| 详情与原图 | `:1261`、`:1333` | `pixivIllustDetail`、`pixivIllustOriginals` |
| 用户作品 | `:1410`、`:1422` | `pixivUserWorkIds`，翻页上限常量名为 `PIXIV_USER_WORKS_MAX_PAGES = 10` |
| 用户检索 | `:1593` | `pixivSearchUsersByName` |

Cookie 巡检与令牌轮换：`qq-bridge/src/core/pixiv-watch.js`（122 行）的状态文件位于 `:23`，`CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000`（`:24`）、`FIRST_DELAY_MS = 90 * 1000`（`:25`）、`NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000`（`:26`）【已核验】。令牌刷新间隔 `PIXIV_REFRESH_INTERVAL_MS = 50 * 60 * 1000` 定义于 `qq-bridge/src/lib/pixiv-auth.js:49`，装配于 `:346`，定时器于 `:367`【已核验】。

### 8.10 语音

`qq-bridge/src/core/voice.js`（1,158 行）同时承载语音合成与语音识别。

表 57：语音参数（口径：行号取自 `qq-bridge/src/core/voice.js`）。

| 项 | 位置 | 取值 |
| --- | --- | --- |
| 角色模型名 | `:52-57` | `VOICE_ROLES` |
| 默认端点 | `:59` | `https://token-plan-cn.xiaomimimo.com/v1` |
| 备用端点 | `:60` | `ALT_BASE_URL` |
| 合成字符上限 | `:63` | `MAX_TTS_CHARS = 2000` |
| 落盘文件 | `:32-34` | 配置、额度、缓存三文件 |
| 缓存目录 | `:258-267` | `cacheDir()` |
| 缓存键 | `:274-278` | 模型、文本、音色、语速的组合 |
| 淘汰 | `:280-288`、`:548` | 按容量与时间淘汰 |
| 鉴权头 | `:318-322` | 双头携带 |
| 内置音色 | `:39-49` | `mimo_default`、冰糖、茉莉、苏打、白桦、`Mia`、`Chloe`、`Milo`、`Dean` |
| 主动语音额度 | `:73-104` | `maxChars 120`（`:90`）、`dailyChars 20000`（`:91`）、`send.probability 0.2`（`:97`）、`send.cooldownMs 600000`（`:98`） |
| 计划与执行 | `:903-923`、`:931-960` | `allVoicePlan`、`tryAllVoiceReply` |
| 提示行 | `:1000`、`:1006`、`:1009` | 全语音模式、掷骰命中、掷骰未命中或冷却 |

### 8.11 独立识图

`qq-bridge/src/core/vision.js`（158 行）在分流开关开启时以独立视觉模型处理图片：超时 `VISION_TIMEOUT_MS = 45000`（`:22`）、响应字节上限 `VISION_MAX_RESPONSE_BYTES = 64 * 1024`（`:24`），失败分支位于 `:145-157`【已核验】。默认视觉模型在会话创建时按档位计划选择，见 §12.2。

### 8.12 文档发送

`qq-bridge/src/core/docx.js`（140 行）生成并上传 `.docx`。

表 58：文档发送（口径：行号取自 `qq-bridge/src/core/docx.js`）。

| 项 | 位置 | 取值 / 行为 |
| --- | --- | --- |
| 临时目录 | `:19` | `path.join(STATE_DIR, 'doc-tmp')` |
| 正文上限 | `:24` | `MAX_DOCX_CHARS = 1000000` |
| 额度文件 | `:27` | `path.join(STATE_DIR, 'docx-quota.json')` |
| 日额度 | `:38-39` | 默认 `100000` |
| 额度裁剪 | `:46` `saveDocxQuota`，裁剪行 `:51` | 只保留最近 7 天 |
| 额度预占 | `:57` `docxQuotaReserve` | 超额直接拒绝且不占用额度 |
| 写入 | `:74` `writeDocxToMount` | 文件名 `${safeTitle}${extraName ? '-' + extraName : ''}-${Date.now()}.docx` |
| 标题净化 | `:84` | `replace(/[\\/:*?"<>\|\r\n]/g, '_').slice(0, 40)` |
| 上传 | `:92` `uploadFileToQQ` | 动作 `:94` 取 `upload_private_file` / `upload_group_file` |
| 上传超时 | `:116` | `AbortSignal.timeout(30000)` |
| 额度提交 | `:67` `docxQuotaCommit` | 上传成功后提交 |
| 旧链路 | `:139-140` | 原 `/help` 发送能力概览文档的链路已删除 |

### 8.13 链接卡片

表 59：卡片构造与降级（口径：行号取自 `qq-bridge/src/core/media.js`，文件 1,249 行）。

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 封面真图判定 | `:34` `isRealCoverBytes` | 只接受 JPEG、PNG、WebP 三种魔数，GIF 不放行 |
| 真实字节实测 | `:60-63` | 四组：无参 `89 50 4E 47` / 4,410,875 字节；`300y300` 同魔数 / 210,146 字节；`imageView` 同魔数 / 210,146 字节；`type=jpg` `FF D8 FF` / 20,913 字节 |
| 封面 URL 归一化 | `:53` `normalizeCoverUrl`、`:92` `normalizeMediaUrl` | — |
| 封面来源判定 | `:231` `QQ_COVER_HOST_RE`、`:260` `neteaseRealCover` | — |
| 探活 | `:562` `probeImage`，上限 `:29` | `COVER_PROBE_MAX_BYTES = 64 * 1024`，超时 6 秒 |
| 候选选择 | `:575` `pickImage`，主体 `:603-621` | 两轮探活，全失败返回空串 |
| 卡片发送与降级 | `:276` `sendMusicCardWithFallback`，降级段 `:286-308` | `primary` → `native` → `link` |
| 富文本发送 | `:357` `sendRichOnce` | 去重窗口 `RICH_DEDUPE_MS = 60000`（`:334`），超时 `AbortSignal.timeout(45000)`（`:399`），间隔 `sleep(randInt(500, 1500))`（`:386`） |
| 音乐卡片构造 | `:930` `buildMusicCard` | 主体 `:957-1040`、`netEase` 段 `:1049-1147`、收尾 `:1149-1167` |
| 音频直链 | `:763` `neteaseAudioUrl` | — |
| 音乐检索 | `:1171` `musicSearch` | — |
| 签名服务 | `:441`、`:921` 注释 | — |
| 封面转存默认关闭 | `:681`、`:705`、`:710`、`:715` | — |
| 媒体域装配 | `:311`、`:1248` | `createMediaDomain` |

视频链路（`qq-bridge/src/core/video.js`，1,259 行）：

表 60：视频链接解析（口径：行号取自 `qq-bridge/src/core/video.js`）。

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 探活超时 | `:25` | `PROBE_TIMEOUT_MS = 9000` |
| 代理开关 | `:37` | `QQBRIDGE_VIDEO_PROXIES` 非空时才走代理 |
| URL 抽取 | `:49`（BV 号 `:59`、av 号 `:62`、通用 URL `:64`） | `extractVideoUrls` |
| 平台判定 | `:73` `classifyVideoHost`、`:94` `parseVideoUrl` | — |
| 视图接口候选 | `:327` | `/x/web-interface/wbi/view` 优先，随后 `/x/web-interface/view` |
| 次要接口 | `:408`、`:413` | `SECAPI_BILI_DEFAULT`、`SECAPI_BILI_TIMEOUT_MS = 8000` |
| 短码缓存 | `:507` | `SHARE_CODE_TTL_MS = 10 * 60 * 1000` |
| bilibili 解析 | `:592` `resolveBilibili` | 四路顺序：视图接口补空字段、`pagelist` 反查、网页 `og: meta`、最终抛 `bilibili 解析失败`（`:711`） |
| 抖音解析 | `:774` `resolveDouyin`，降级标记 `:821-823` | 全失败时 `err.degraded = true` |
| 通用平台 | `:858` `resolveVideo`，降级标记 `:873-877` | 只抓 `og: meta` |
| 小程序卡片 | `:1033` `fetchMiniAppArk`，请求体 `:1127` | 缺 `title` 或 `jumpUrl` 返回 null，退分享链接；缺封面不阻止构造 |
| 卡片构造 | `:1158` `buildVideoCard`，`style` 默认 `:1163` | `QQBRIDGE_VIDEO_CARD` 默认 `share`；`json` 档已停用（`:1183-1201`） |

小程序卡片的请求体逐字为：

```js
JSON.stringify({ type, title: title.slice(0,100), desc: desc.slice(0,100), picUrl, jumpUrl, webUrl, rawArkData: 'true' })
```

其中 `type = platform === 'bilibili' ? 'bili' : (platform === 'weibo' ? 'weibo' : '')`，即模板只有 `bili` 与 `weibo` 两种【已核验】。发送形态为 `{ ver, prompt, config, app, view, meta, miniappShareOrigin: 3, miniappOpenRefer: '10002' }`，最终段为 `{ type:'json', data:{ data: JSON.stringify(send) } }`（`qq-bridge/src/core/video.js:1140-1149`）【已核验】。

表 61：`degraded` 判定（口径：逐条判据与其位置）。

| 判据 | 位置 | 语义 |
| --- | --- | --- |
| `err.degraded = true` | `qq-bridge/src/core/video.js:822` | 抖音只剩链接可用 |
| `err.degraded = true` | `qq-bridge/src/core/video.js:875` | 通用平台抓页失败 |
| `sentCard === 'link' && videoPlan.style === 'share'` | `qq-bridge/src/core/console-server.js:3428` | 预期形态，不计降级 |
| `sentCard !== 'primary' && !intendedShare` | `qq-bridge/src/core/console-server.js:3429-3431` | 记降级日志 |
| 端点返回 `{ok:false, error, degraded, url}` | `qq-bridge/src/core/console-server.js:3526` | — |

### 8.14 空间配图

`qq-bridge/src/lib/qzone-image.js`（297 行）为 `qq_send_qzone` 构造配图参数。

表 62：空间配图（口径：行号取自 `qq-bridge/src/lib/qzone-image.js`）。

| 项 | 位置 | 取值 / 行为 |
| --- | --- | --- |
| 参数差异说明 | `:16-17` | `file` 为单图参数，`images` 为多图参数 |
| 数量上限 | `:45` | `QZONE_IMAGE_MAX = 3` |
| 临时文件寿命 | `:48` | `QZONE_IMAGE_TMP_MAX_AGE_MS` |
| 文件名匹配 | `:52` | `QZONE_TMP_NAME_RE` |
| 数量钳制 | `:55` | `clampQzoneImageCount` |
| 临时目录 | `:62` | `qzoneImageTmpDir` |
| 校验 | `:84` | `verifyQzoneImage` |
| 参数构造 | `:106`，分支 `:113-115`、`:124-129` | `prepareQzoneImageArg` |
| 清理 | `:142` | `sweepQzoneImageTmp` |
| 收集 | `:170`，分支 `:167`、`:188`、`:191-201`、`:222-237`、`:243-258`、`:275-277`、`:286`、`:295-296` | `collectQzoneImages` |

### 8.15 失败与降级

表 63：媒体失败路径（口径：证据列为源码位置）。

| 场景 | 行为 | 证据 |
| --- | --- | --- |
| 媒体未投递成功 | 给模型显式占位文案，提示不推断图片内容 | `qq-bridge/src/core/media-pipe.js:207` |
| 尺寸过大 | `[图片（尺寸过大已跳过：…）…]` | `qq-bridge/src/core/media-pipe.js:227` |
| 获取失败 | `[图片（获取失败）…]` | `qq-bridge/src/core/media-pipe.js:229` |
| 封面非真图 | 丢弃该封面，不采用首个候选 URL | `qq-bridge/src/core/media.js:575/603-621` |
| 卡片发送失败 | 逐档降级并回执当前档位与来源 | `qq-bridge/src/core/media.js:276-308` |
| 表情发送失败（`识别URL失败` / `ENOENT`） | 以 `base64` 重发一次 | `qq-bridge/src/core/sticker.js:313-320` |
| `add_custom_face` 不支持 | 降级为 `local://` 本地图库引用 | `qq-bridge/src/core/sticker.js:546-554` |
| 文档超额 | 直接拒绝且不占用额度 | `qq-bridge/src/core/docx.js:57` |
| 视频解析全败 | 抛错并携带 `degraded` 标记 | `qq-bridge/src/core/video.js:821-823`、`:873-877` |

### 8.16 未核验

- 内置表情包在生效位置的安装状态未修复，其工具在缺包时的完整返回文案未复现【未核验】。
- `qq-bridge/src/core/media.js` 中封面转存图床功能默认关闭，其开启后的行为未复现【未核验】。
- 视频卡片在微信小程序侧的渲染结果未验证【未核验】。

---

## 9. 时间驱动与主动行为子系统

本章界定由计时器而非入站消息驱动的行为，包括定时消息、等待挂起、活跃时段、静默状态与三类主动投递；QQ 空间与社交动作的能力面见 §10。

### 9.1 定时消息

`qq-bridge/src/core/scheduler.js`（152 行）承载 `qq_schedule_message` / `qq_schedule_list` / `qq_schedule_cancel` 三个工具，持久化文件为 `qq-bridge/state/scheduled-tasks.json`（现场 3 字节，即空数组）【已核验】。

表 64：定时任务参数（口径：源码与工具注册行）。

| 项 | 取值 / 行为 |
| --- | --- |
| 工具注册 | `qq_schedule_message` `qq-bridge/src/mcp-napcat-safe.js:1101`、`qq_schedule_list` `:1128`、`qq_schedule_cancel` `:1142` |
| 失败重试间隔 | `60000` 毫秒 |
| 单任务重试上限 | 3 次 |
| 持久化 | 启动时 `loadScheduledTasks()` 恢复（`qq-bridge/src/bridge.js:729-731`） |

### 9.2 等待挂起

`qq_wait_for_messages`（`qq-bridge/src/mcp-napcat-safe.js:1439`）在长轮询模式下挂起模型，等待入站消息直接作为工具结果返回。

表 65：等待模式（口径：题设值与守卫位置）。

| 项 | 取值 / 行为 | 位置 |
| --- | --- | --- |
| 挂起登记 | `activeWaits` 集合 | `qq-bridge/src/core/session-state.js:24` |
| 回合上限 | `11 * 60 * 1000` | `qq-bridge/src/core/turn-guard.js:21` |
| 无限唤醒 | `wakeConfig.infinite` | `qq-bridge/src/core/console-server.js:1785-1787` |
| 等待期间入站 | 作为工具结果返回，不经投递队列 | 见 §2.3 |

### 9.3 活跃时段

`qq-bridge/src/core/activity.js`（124 行）承载 `qq_get_activity_hours`（注册行 `:1167`）与 `qq_set_activity_hours`（`:1181`），并由管理端 `POST /api/bridge/activity-hours`（`server/index.js:5408`）读写。落盘文件为 `qq-bridge/state/activity-windows.json`（现场 262 字节）【已核验】。

表 66：活跃时段参数（口径：源码字面值）。

| 项 | 取值 / 行为 |
| --- | --- |
| 巡检间隔 | `60000` 毫秒 |
| 窗口命中后的行为 | 窗口起点后 2 分钟触发一次主动检查 |
| 目标会话 | `qq-bridge/src/core/console-server.js:4924`（`GET /api/bridge/activity-targets`） |
| 恢复时机 | 启动时 `loadActivityWindows()` 与 `startActivityTick()`（`qq-bridge/src/bridge.js:729-731`） |

### 9.4 静默状态

表 67：静默与唤醒控制（口径：`wakeConfig` 为会话持久字段）。

| 状态 | 入口 | 行为 |
| --- | --- | --- |
| 睡眠 | `/sleep` | 本会话不再唤醒，直到 `/wake` |
| 唤醒 | `/wake` | 立即触发一次唤醒 |
| 无限唤醒 | `wakeConfig.infinite` | 由 `qq_mark_read` 收尾置位（`qq-bridge/src/core/console-server.js:1785-1790`） |
| 深层静默 | `/deepsleep` | 所有会话静默，只向 `qq-bridge/state/qq-activity.log` 写记录 |
| 全局暂停 | `POST /api/social/paused` | 封禁 `/api/social`、`/api/send`、`/api/images` 三组端点（仅对 agent 令牌生效） |
| 有界静默 | `qq_set_wake_config`（注册行 `:1280`） | 模型可设置自身的唤醒档位 |

### 9.5 主动搭话与掷骰

`qq-bridge/src/core/send-dice.js`（89 行）实现桥侧主动行为的概率与冷却判定，函数签名为 `dice(kind, key, probability, cooldownMs)`【已核验】；配套记账函数 `noteSent(kind, key)` 位于 `:19`【已核验】。

表 68：掷骰参数（口径：源码字面值，现场配置可覆盖）。

| 参数 | 取值 | 位置 |
| --- | --- | --- |
| `MEME_DEFAULT_PROBABILITY` | `0.3` | `qq-bridge/src/core/send-dice.js:40` |
| `MEME_DEFAULT_COOLDOWN_MS` | `3 * 60 * 1000` | `qq-bridge/src/core/send-dice.js:41` |
| 已使用的 `kind` | `meme`、`voice` | `qq-bridge/src/core/send-dice.js`、`qq-bridge/src/core/voice.js` |

`kind` 的取值集合为 `meme` 与 `voice` 两者，全仓无第三种取值【已核验】。

### 9.6 主动语音

主动语音在唤醒前掷骰决定，参数与额度段位于 `qq-bridge/src/core/voice.js:73-104`，现场配置中 `send.probability` 为 `0.2`、`send.cooldownMs` 为 `600000`【已核验】。语音提示行拼接于 `qq-bridge/src/core/wake-send.js:538` 与 `:1766`，文本行位于 `qq-bridge/src/core/voice.js:1000`（全语音模式）、`:1006`（命中）、`:1009`（未命中或冷却中）【已核验】。

### 9.7 主动发说说

`qq-bridge/src/core/qzone.js`（44 行）的 `postRandomQzone`（`:8`）由桥侧主动路径调用：素材池为内置 10 条（`:12-23`），请求超时 15000 毫秒（`:30`），成功后写入记忆条目（`:39-40`，类别 `qzone_post`），记录日志于 `:43`【已核验】。现场 `memory_entries` 中 `qzone_post` 类别的 2 条记录即来自该路径【已核验】。

### 9.8 失败与降级

表 69：时间驱动的失败路径（口径：证据列为源码位置）。

| 场景 | 行为 | 证据 |
| --- | --- | --- |
| 定时任务发送失败 | 按 60000 毫秒退避重试，超过 3 次后放弃 | `qq-bridge/src/core/scheduler.js` |
| 活跃时段窗口跨日 | 按窗口起点计算，不做跨日合并 | `qq-bridge/src/core/activity.js` |
| 主动语音额度耗尽 | 当天不再主动发语音 | `qq-bridge/src/core/voice.js:73-104` |
| 掷骰未命中 | 记一行未命中日志，不发送 | `qq-bridge/src/core/voice.js:1009` |
| 说说发布失败 | 记录日志，不重试 | `qq-bridge/src/core/qzone.js:30-43` |

### 9.9 未核验

- 定时任务的时刻精度未做测量【未核验】。
- 活跃时段与主动搭话的联合触发频次未做统计【未核验】。

---

## 10. 社交拓展面

本章界定 QQ 空间、社交动作、跨会话留言与群/好友管理四类扩展能力；时间驱动的主动行为见 §9。

### 10.1 QQ 空间

表 70：QQ 空间工具（口径：注册行取自 `qq-bridge/src/mcp-napcat-safe.js`）。

| 工具 | 注册行 | 行为 |
| --- | --- | --- |
| `qq_qzone_view` | `:2536` | 读取指定账号的说说列表 |
| `qq_qzone_comment` | `:2578` | 发表评论 |
| `qq_qzone_reply_comment` | `:2617` | 回复评论 |
| `qq_qzone_like` | `:2662` | 点赞 |
| `qq_send_qzone` | `:2702` | 发表说说，配图经 `qq-bridge/src/lib/qzone-image.js` 构造（见 §8.14） |

说说正文与配图的发送形态由上述工具的参数决定；配图数量上限为 3（`qq-bridge/src/lib/qzone-image.js:45`）【已核验】。

### 10.2 社交动作

表 71：社交动作工具（口径：注册行取自 `qq-bridge/src/mcp-napcat-safe.js`）。

| 工具 | 注册行 | 行为 |
| --- | --- | --- |
| `qq_like` | `:2013` | 给指定账号的资料卡点赞 |
| `qq_send_poke` | `:1370` | 发送拍一拍 |
| `qq_profile_get` | `:2298` | 读取资料卡字段 |
| `qq_profile_set` | `:2316` | 写入资料卡字段 |
| `qq_get_group_owner` | `:902` | 读取群主账号 |
| `qq_get_group_members` | `:882` | 读取群成员列表 |
| `qq_list_groups` | `:854` | 读取加入的群列表 |

收到拍一拍与输入状态的通知经 `onNotice('notify')` 订阅（`qq-bridge/src/bridge.js:589`）【已核验】。

### 10.3 跨会话留言

`qq-bridge/src/core/crosschat.js`（138 行）实现会话之间的留言投递。

表 72：跨会话参数（口径：源码字面值）。

| 项 | 取值 / 行为 |
| --- | --- |
| 写入工具 | `qq_crosschat_send`（注册行 `qq-bridge/src/mcp-napcat-safe.js:1395`） |
| 读取工具 | `qq_crosschat_inbox`（注册行 `:1417`） |
| 每会话保留 | 10 条 |
| 正文截断 | `slice(0, 400)` |
| 持久化 | `qq-bridge/state/crosschat.json`（现场 5,828 字节） |
| 唤醒注入 | `qq-bridge/src/core/crosschat.js:102`，每轮最多 2 条、整行上限 170 字符 |
| 精简工具档位 | 两个工具均进入 `deny` 名单 |

现场 `qq-bridge/config.json` 的 `social.slimTools.deny` 共 16 项，其中包含 `qq_crosschat_inbox` 与 `qq_crosschat_send`【已核验】。

### 10.4 群与好友管理

表 73：群与好友管理工具（口径：注册行取自 `qq-bridge/src/mcp-napcat-safe.js`；权限列指工具内部的受信任判定）。

| 工具 | 注册行 | 权限 |
| --- | --- | --- |
| `qq_admin_set` | `:2361` | 所有者私聊 |
| `qq_blacklist` | `:2342` | 所有者私聊 |
| `qq_whitelist` | `:2380` | 所有者私聊 |
| `qq_remove_friend` | `:2399` | 所有者私聊；精简工具档位下进入 `deny` 名单 |
| `qq_send_forward` | `:2985` | 一般工具 |
| `qq_get_forward_msg` | `:1942` | 一般工具 |

好友请求由 `onRequest('friend')` 订阅处理（`qq-bridge/src/bridge.js:622`），`cfg.social.autoFriendApproval === false` 时关闭自动通过【已核验】。

白名单语义：`deny` 名单优先于 `allow` 名单；两侧名单均为空且 `allowAllWhenEmpty` 为真时放行全部并产生告警日志。现场 `qq-bridge/config.json` 的 `allowAllWhenEmpty` 为 `true`，`allow.groups` 为 3 项【已核验】。

### 10.5 撤回

撤回操作需要先取得目标消息 id：出站消息 id 由 `qq_get_my_recent_messages`（注册行 `:1489`）提供，窗口消息 id 由 `qq_get_message_detail`（`:1507`）提供；撤回动作由 `qq_withdraw_message`（`:1231`）执行。收到撤回通知后桥侧调用 `markChatRecalled`（`qq-bridge/src/core/chat-db.js:691`）标记库内记录【已核验】。

### 10.6 失败与降级

表 74：社交拓展面的失败路径（口径：证据列为源码位置）。

| 场景 | 行为 | 证据 |
| --- | --- | --- |
| 空间接口失败 | 返回错误对象，不重试 | `qq-bridge/src/mcp-napcat-safe.js:2536-2702` |
| 非所有者调用管理类工具 | 返回权限提示并终止 | `qq-bridge/src/mcp-napcat-safe.js:2342-2399` |
| 跨会话留言目标不可达 | 留言保留在本机会话表中 | `qq-bridge/src/core/crosschat.js` |
| 撤回目标消息 id 不可得 | 不执行撤回 | `qq-bridge/src/mcp-napcat-safe.js:1231` |

### 10.7 未核验

- QQ 空间接口的返回字段全集未逐一核实【未核验】。
- 资料卡写入的可写字段集合未逐一核实【未核验】。

---

## 11. 上下文压缩与令牌预算接入

本章界定四个计量与裁剪机制：用量记账、用量对账、剪枝计量、工具裁剪；上下文压缩算法本身的数学表述见 `docs/COMPACTION-MATH.md`。

### 11.1 用量记账

`qq-bridge/src/core/token-meter.js`（1,034 行）从 DSH 事件流采集用量帧并落盘。

表 75：用量记账构成（口径：行号取自 `qq-bridge/src/core/token-meter.js`）。

| 项 | 位置 | 取值 / 行为 |
| --- | --- | --- |
| 帧入口 | `:550` `meterTokenFrame` | 处理 usage 帧 |
| 事件处理 | `:602-629` | 回合与步的起止事件 |
| 落盘文件 | `:58` | `TOKEN_USAGE_FILE`（现场 `state/token-usage.jsonl` 60,524 字节） |
| 记录写入 | `:413-426` | 行格式说明位于文件头注释 `:3-8` |
| 行数上限 | `:60-61` | `MAX_LINES = 50000`、`PRUNE_TO_LINES = 45000` |
| 用量字段采集 | `:429` `collectUsageFields` | 深度上限 `MAX_DEPTH = 6`（`:62`）、数组上限 `MAX_ARRAY_ITEMS = 200`（`:63`）、字段名映射 `:84-98` |
| 帧签名 | `:210` `usageSig` | 去重用；`REAL_SIG_KEEP_MS = 86400000`（`:68`）、`REAL_SIG_MAX_PER_SESSION = 64`（`:69`） |
| 估算补记 | `:518` `flushEstimate` | 无 usage 帧时按字符估算：`EST_PROMPT_CHARS_PER_TOKEN = 1.8`、`EST_COMPLETION_CHARS_PER_TOKEN = 2.2`（`:64-65`） |
| 累积上限 | `:66-67` | `ACC_CHARS_CAP = 5000000`、`ACC_IDLE_FLUSH_MS = 90000` |
| 队列帧依赖 | `:636` | 依赖 `session/queue` 帧判定会话忙碌 |
| 会话归属 | `:873-888` `isBridgeOwnedSession` | 判定该会话是否由桥创建 |

### 11.2 用量对账

`startTokenReconcile`（`qq-bridge/src/core/token-meter.js:1026`）周期性以磁盘会话日志校正面板数字。

表 76：对账参数（口径：行号取自 `qq-bridge/src/core/token-meter.js`）。

| 项 | 取值 | 位置 |
| --- | --- | --- |
| 执行间隔 | `5 * 60 * 1000` | `:1026` 起 |
| 单次配额 | `quotaPerRun = 200` | `:916` |
| 最长回溯 | `DEFAULT_RECONCILE_MAX_AGE_MS = 6` 小时 | `:70` |
| 基线求和 | `baseSum` | `:950` |
| 差额 | `deficit` | `:952` |
| 补记行 | `:986-991` | 差额写入 |
| 水位文件 | `qq-bridge/state/token-reconcile.json` | `:59`、`:841-863` |
| 失败分支 | 保留原值并记日志 | `:905-915`、`:997` |

启动时的接线为 `setTokenReconcileHome(...)` 与 `startTokenReconcile()`（`qq-bridge/src/bridge.js:359-360`），日志为 `[token] 用量对账已启用：<home>/storages/session_projcache/sessions`；找不到 DSH home 时输出 `[token] 未找到可用的 DSH home，跳过用量对账（面板数字只按 usage 帧累计）`（`:363`）【据仓库记载】。

### 11.3 剪枝计量

`qq-bridge/src/core/context-savings.js`（334 行）统计 DSH 侧剪枝的节省量。

表 77：剪枝计量（口径：行号取自 `qq-bridge/src/core/context-savings.js`）。

| 项 | 位置 | 取值 / 行为 |
| --- | --- | --- |
| 状态版本 | `:37` | `STATE_VERSION = 3` |
| 会话日志解码 | `:86` `decodeSessionLog` | zstd 魔数 `0xfd2fb528`（`:38`） |
| 统计算法 | `:124-137` | 按剪枝标记行求和 |
| 扫描节奏 | `:49` | `scanTtlMs = 30000` |
| 失败分支 | `:256-261` | 沿用旧结果 |
| 时区偏移 | `:31-32` | 与 11.4 共用同一偏移常量 |

启动接线为 `initContextSavings(...)` 与首次 `reconcileContextSavings(...)`（`qq-bridge/src/bridge.js:380-394`），日志为 `[savings] 剪枝计量就绪：扫描 N 份会话日志（复用 M 份），今日已剪掉 X token / 少读 Y token`；无 home 时输出 `[savings] 未找到 DSH home，跳过剪枝计量（面板不显示该项）`【据仓库记载】。

### 11.4 费用口径与报表

表 78：费用单价（口径：取自 `qq-bridge/src/core/token-report.js:19-25` 的 `DEFAULT_TOKEN_COST`，单位人民币元每百万 token；现场配置与默认值一致）。

| 项 | 默认值 | 现场值 | 含义 |
| --- | --- | --- | --- |
| `pHit` | `0.02` | `0.02` | 缓存命中输入单价 |
| `pMiss` | `1` | `1` | 缓存未命中输入单价 |
| `pOut` | `4` | `4` | 输出单价 |
| `peakMult` | `2` | `2` | 高峰时段倍率 |
| `peakHours` | — | `[9,10,11,14,15,16,17]` | 高峰时段集合 |

报表文本由 `buildTokenReportText`（`qq-bridge/src/core/token-report.js:117`）生成，失败文案位于 `:123-124`【已核验】。日界偏移 `dayOffsetMin = 480` 定义于 `qq-bridge/src/core/token-meter.js:74-75`，`context-savings.js` 使用同一偏移（`qq-bridge/src/core/context-savings.js:31-32`），环境变量为 `QQ_TOKEN_DAY_OFFSET_MIN`【已核验】。同一性判定 `naturalSame` 位于 `qq-bridge/src/core/token-report.js:134`【已核验】。

### 11.5 工具裁剪档位

`qq-bridge/src/lib/tool-tiers.js`（226 行）按档位决定注册哪些工具。

表 79：工具名单集合（口径：行号取自 `qq-bridge/src/lib/tool-tiers.js`）。

| 集合 | 位置 | 条数 | 语义 |
| --- | --- | --- | --- |
| `ESSENTIAL` | `:35-50` | 11 | 无论档位均注册，含 `get_time` |
| `OBSERVED_USED` | `:53-71` | 17 | 实测被调用过 |
| `CHEAP_EXTRA` | `:74-78` | — | 体积小、可附带注册 |
| `GROUP_AWARENESS` | `:84-88` | — | 群认知相关 |
| `PROMPT_NAMED` | `:98-101` | 2 | 提示词中点名的两条，并入 `medium`（`:131`）与 `high`（`:136`） |
| 测量函数 | `:206` | — | `measureSchemaShare` |

档位取值集合为 `off`、`low`、`medium`、`high`、`extreme`、`custom` 六者（`qq-bridge/state/tool-schema-stats.json` 的 `tiers` 键）【已核验】。

### 11.6 描述压缩

`qq-bridge/src/lib/tool-schema-compress.js`（164 行）按档位压缩工具描述，取值集合 `SCHEMA_LEVELS = ['off','medium','high']`（`:33`），不提供 `low` 档【已核验】。

表 80：描述压缩档位（口径：取自 `qq-bridge/state/tool-schema-stats.json` 的 `schemaLevelInfo`）。

| 档位 | 行为 |
| --- | --- |
| `off` | 每条描述原样下发（默认） |
| `medium` | 工具与参数的描述只保留第一句 |
| `high` | 只保留工具名、参数名、类型、枚举与必填项，不下发描述 |

### 11.7 压缩代理与 DSH 补丁

`qq-bridge/src/lib/dsh-side.js`（613 行）在 MCP 挂载配置中把 `mcp-napcat` 指向压缩代理（`mcpBlock()` 位于 `:252-299`，压缩代理参数位于 `:280-288`），参数形态为 `-c <level> -n napcat [--exclude-tools a,b] [--toonify] -- node <script>`；工具调用超时为 `toolCallTimeoutMs: 725000`（`:295`）【已核验】。安装版本 `INSTALL_VERSION = 1` 位于 `:25`。

`qq-bridge/src/lib/dsh-compaction.js`（223 行）生成写入 DSH home 的 `cordis.patch.yml`：剪枝标记 `PRUNE_MARKER`（`:28`）、摘要输出上限 `SUMMARY_MAX_TOKENS = 4096`（`:31`）、最小工具结果长度 `MIN_TOOL_RESULT_CHARS = 300`（`:33`）、阈值下限 `MIN_THRESHOLD_RATIO = 0.08`（`:51`）、默认阈值 `DEFAULT_THRESHOLD_RATIO = 0.16`（`:54`），钳制段位于 `:65-90`【已核验】。桥侧配置为 `dshCompaction.thresholdRatio = 0.16`、`retainRatio = 0.02`、`toolResultMaxChars = 8192`、`enabled = true`【已核验】。

### 11.8 现场测量数据

`qq-bridge/state/tool-schema-stats.json` 记录一次工具描述体积测量。该文件的 `at` 为 `1790324164428`，`level` 与 `schemaLevel` 均为 `off`，`enabled` 为 `false`，`source` 为 `env-off`，即该次测量在裁剪与描述压缩均关闭的条件下完成【已核验】。

表 81：工具描述体积测量（口径：样本为 `mcp-napcat` 的 91 个工具；单位字符；数据取自 `qq-bridge/state/tool-schema-stats.json`）。

| 项 | 取值 |
| --- | --- |
| 注册工具数 / 可用工具数 | 91 / 91 |
| 描述总量 `totalChars` | 95595 |
| 保留量 `keptChars` | 101360 |
| 占比 `share` | 1.0603 |
| 差值 `savedChars` | -5765 |
| 每步约 token `approxTokensPerStep` | 31675 |

`keptChars` 大于 `totalChars` 的原因为该次测量的 `schemaLevel` 计入了压缩代理附加的说明文本；差值为负表示该次运行未产生节省【已核验】。

表 82：各档位的保留量（口径：同上数据源；占比为相对 `totalChars` 的比值）。

| 档位 | 占比 | 保留字符 | 保留条数 | 裁剪条数 |
| --- | --- | --- | --- | --- |
| `off` | 1 | 95595 | 91 | 0 |
| `low` | 0.8281 | 79162 | 68 | 23 |
| `medium` | 0.4189 | 40047 | 42 | 49 |
| `high` | 0.3488 | 33344 | 33 | 58 |
| `extreme` | 0.068 | 6497 | 9 | 82 |
| `custom` | 1 | 95595 | 91 | 0 |

表 83：单条描述体积前 13 名（口径：同一次测量，单位字符）。

| 工具 | 字符数 |
| --- | --- |
| `qq_send_pixiv` | 6148 |
| `qq_send_rich` | 5721 |
| `qq_pixiv_search` | 4155 |
| `qq_set_wake_config` | 3087 |
| `qq_send_message` | 2925 |
| `qq_send_image` | 2726 |
| `qq_send_qzone` | 2578 |
| `qq_send_voice` | 2478 |
| `qq_set_system_config` | 2437 |
| `qq_send_forward` | 2007 |
| `qq_memory_remember` | 1798 |
| `qq_send_meme` | 1677 |

现场 `qq-bridge/config.json` 的 `social.slimTools` 为 `{ enabled: true, level: 'low', deny: [...] }`，`deny` 列表含 16 项【已核验】。现场 `qq-bridge/config.json` 的 `social` 段不含 `toolCompressor` 键，也不含 `slimTools.schemaLevel` 键，二者仅在 `qq-bridge/config.example.json` 中给出【已核验】。

### 11.9 失败与降级

表 84：计量与裁剪的失败路径（口径：证据列为源码位置或日志前缀）。

| 场景 | 行为 | 证据 |
| --- | --- | --- |
| 无 DSH home | 跳过对账与剪枝计量，面板只按 usage 帧累计 | `qq-bridge/src/bridge.js:363`、`:380-394` |
| 无 usage 帧 | 按字符估算补记 | `qq-bridge/src/core/token-meter.js:518` |
| 会话日志不可解码 | 沿用上一次结果 | `qq-bridge/src/core/context-savings.js:256-261` |
| 压缩代理不可用 | 回退直连 `mcp-napcat` | `qq-bridge/src/lib/dsh-side.js:280-299` |
| 档位取值非法 | 按 `off` 处理 | `qq-bridge/src/lib/tool-tiers.js` |

### 11.10 未核验

- 用量对账在跨日边界与 DSH 会话日志被清理后的行为未复现【未核验】。
- 剪枝计量对 `zstd` 帧之外的会话日志格式的兼容性未核实【未核验】。
- 现场 `social.slimTools.level` 为 `low` 时实际注册的工具条数未实测【未核验】。

---

## 12. DSH 集成面

本章界定桥与隔离 DSH 实例之间的全部接合点：实例自安装、会话生命周期、提示词投递、宿主服务、预设与工具白名单；投递队列与模式见 §5.6。

### 12.1 隔离实例的解析与安装

`qq-bridge/src/lib/dsh-side.js`（613 行）负责定位并安装隔离 DSH。

表 85：实例解析与安装（口径：行号取自 `qq-bridge/src/lib/dsh-side.js`）。

| 项 | 位置 | 行为 |
| --- | --- | --- |
| 目标解析 | `:57-74` `resolveDshTarget` | 依次尝试环境变量、管理器配置与默认路径 |
| 管理器隔离目录 | `:77-87` `readManagerIsolatedHome` | 读取管理器写入的隔离 home 路径 |
| 预设安装 | `:150` `installPresets` | 只安装 `qq-chat` 一个预设 |
| 预设覆盖同步 | `:157-166` `syncPresetOverrides`（调用点 `:162`） | 同步覆盖段 |
| 内置插件 | `ensureBuiltinPlugins` | 安装桥自带插件 |
| 安装版本 | `:25` | `INSTALL_VERSION = 1` |
| MCP 挂载块 | `:252-299` `mcpBlock()` | 三个 server 与压缩代理 |
| 覆盖层 | `:311-316` | `{default: 'standard', includeUserRoot: true}` |

安装流程在桥启动时以异步非阻塞方式执行：`void (async () => { … })()`（`qq-bridge/src/bridge.js:274-309`），顺序为 `resolveDshTarget()` → `installPresets(target)` → `watchOverrideFiles(...)` → `ensureBuiltinPlugins(target)` → `isInstalled(target)` → `installToIsolatedDsh()`【已核验】。

### 12.2 会话创建与视觉模型

`ensureSession`（`qq-bridge/src/core/dsh-session.js:79`）保证每个会话键对应一个 DSH 会话 id。

表 86：会话创建（口径：行号取自 `qq-bridge/src/core/dsh-session.js`，文件 205 行）。

| 项 | 位置 | 行为 |
| --- | --- | --- |
| 视觉模型准备 | `:38-77` `ensureVisionModel` | provider 默认 `deepseek-official`（`:41`）、model 默认 `deepseek-v4-flash-vision-exp`（`:42`）；按档位计划依次尝试，失败重试 2 次（`:51-76`） |
| 会话世代 | `:13` `sessionEpoch`、`:15` `bumpSessionEpoch` | 会话更换时递增，用于丢弃过期回调 |
| 并发去重 | `:113`、`:154-159` | 同一会话键的并发创建合并为一次 |
| 备用会话 | `:169-205` `createStandbySession` | 预留会话，减少首次唤醒延迟 |
| 丢弃文案 | `:142-146` | 会话已更换时丢弃本轮结果 |

预设档位的选择依据为 `modePreset`（`qq-bridge/src/core/mode.js:35-37`），当前模式集合只有 `default`（`:7`），`setCurrentMode` 为空函数（`:21`）【已核验】。

### 12.3 启动装配顺序

`main()`（`qq-bridge/src/bridge.js:270`）的执行顺序如下【已核验】。

表 87：桥启动装配顺序（口径：括号内为本轮读取的行号）。

| 序 | 动作 | 行号 |
| --- | --- | --- |
| 1 | `loadConfig()` | `:271` |
| 2 | 隔离 DSH 自安装（异步非阻塞） | `:274-309` |
| 3 | `initMuxCore` → `initConsoleCore` → `mkdirSync(STATE_DIR)` → `acquireLock()` → `loadState()` | `:310-314` |
| 4 | 核心模块初始化：`initStickerCore`、`initDocxCore`、`initQqSendCore`、`setTunableCfg`、`initQzoneCore`、`initEventsAuxCore`、`initMemoryCore`、`initWakeCore`、`setWakeDeliver(deliverPrompt)`、`initGroupCacheCore`、`initSocialCore` | `:315-325` |
| 5 | `startDeliveryWatchdog()` | `:329` |
| 6 | `initModeCore`、`initDshWatchCore`、`initCrossChatCore`、`initAuditCore`、`initDshSessionCore`、`initSlangCore`、`initPersonaLearnCore`、`initVoiceCore`、`initNapcatTokens`（内含 `backupLoginTickets()`）、`initNapcatGuard`、`initSendDice`、`initTokenMeter`、`initTokenReportCore` | `:330-348` |
| 7 | `setDshSideConfig(cfg)` → `patchProfileCordis(resolveDshTarget())` | `:351-352` |
| 8 | 用量对账：`setTokenReconcileHome(...)` + `startTokenReconcile()` | `:359-360` |
| 9 | 剪枝计量：`initContextSavings(...)` + 首次 `reconcileContextSavings(...)` | `:380-394` |
| 10 | 会话与投递：`initSessionArchiveCore` → `setConvKeyResolver` → `initPromptDeliverCore` → `initSocialFlowCore` → `initMediaPipeCore` → `initVisionCore` | `:395-400` |
| 11 | `syncDshCompactionPatch({...})` | `:409` |
| 12 | 领域接线：`setScheduledRecorder(recordSentMessages)`、`setWakeSender(sendWakePrompt)`、`setSteerSender(steerIntoRunningTurn)`、`createMediaDomain(cfg)`、`setConsoleMedia(...)` | `:422-429` |
| 13 | Pixiv：`startPixivCookieWatch({...})`、`startPixivTokenRefresh({ logger })` | `:434`、`:446` |
| 14 | `new NodeApiClient(cfg.dsh.baseUrl, undefined, { dshLogFile, seqFile: state/dsh-seq.json })` → 各 `setXxxApi` → `initPersonaAutoLearn` → `initPortraitLearn()` → `ensureLearningToken()` | `:463-476` |
| 15 | 会话映射自愈（剔除磁盘上不存在的会话）→ `loadSocialState()` → 同步插话概率 → 标记人设补注入 | `:490-512`、`:544`、`:552`、`:560` |
| 16 | `new OneBotWsClient({ url, accessToken, reconnect: true })` 与各 `setXxxBot` | `:565-580` |
| 17 | 事件订阅：私聊 `:581`、群 `:585`、通知 `:589`、撤回 `:595`、好友请求 `:622` | — |
| 18 | WS 事件：`on('open')` 置 `napcatUp` 并强制重探登录；`on('close')` 清理并重探；`on('error')` 记录 `message`、`code`、`cause.code`、`cause.message` | — |
| 19 | 登录态巡检已删除：`const loginWatch = null; void loginWatch;` | `:666-667`（说明注释 `:659-665`） |
| 20 | `connectNapcat(budgetMs)`；`error.code === 'NAPCAT_CONN'` 时退避 `min(15000, 1500 * attempt)`；预算默认 `120000`（`cfg.social?.napcatStartupBudgetMs`，字面值位于调用点 `:692`）；连接失败不退出，后台每 15 秒重连 | `:676-691`、`:696-709` |
| 21 | 日志 `桥接已启动。按 Ctrl+C 退出。` 后恢复持久任务：`loadScheduledTasks()`、`loadDocxQuota()`、`loadActivityWindows()`、`startActivityTick()`、`loadArchivedCache()`、`startSessionArchiveTicker()`、`syncStickerLibrary(true)`、`startDshWatch()`、`startNapcatGuard()`、`startConsoleServer()` | `:727`、`:729-742` |
| 22 | `watchConfigFile(cfg, { onChange })`：`dsh*` 变更清模型缓存；`social.wake*` 同步概率；`dshCompaction*` 重写补丁；`social.autoReset.permanent` 只记日志 | `:747` |
| 23 | `initSlangNightly(cfg)` → `await pumpMux();`（事件泵主循环，不返回） | `:784`、`:786` |
| 24 | 退出钩子：`SIGINT`（`saveState()`、`releaseLock()`、`process.exit(0)`）`:789`、`SIGTERM` `:795`、`unhandledRejection` `:800`、`process.on('exit')` `:801`、`main().catch` `:813` | `:789-816` |

### 12.4 DSH 客户端协议

`qq-bridge/src/dsh-client.js`（600 行）实现 RPC 调用与事件订阅。

表 88：DSH 客户端构成（口径：行号取自 `qq-bridge/src/dsh-client.js`）。

| 项 | 位置 | 行为 |
| --- | --- | --- |
| 结果解包 | `:96-100` `unwrap` | `response.result.ok` 为假时抛错 |
| 令牌缓存 | `:200` | 鉴权结果缓存 55 秒 |
| 令牌扫描步长 | `:63` | `TOKEN_SCAN_STEPS`（256K、1M、4M、16M） |
| 请求体构造 | `:225-245` | `{type:'client-request', rpcId, method, payload:{args}}` |
| `sessions.create` | `:253` | 超时 30000 |
| `prompt` | `:263` | 超时 30000 |
| `cancel` | `:276` | 超时 10000 |
| `sessions.rename` | `:282-284` | 超时 10000；桥内未发现调用点，会话标题依赖工作区分组 |
| `attachment` | `:286` | 超时 60000 |
| `workspace.create` | `:294` | 超时 30000 |
| `workspace.archiveSession` | `:300` | 超时 15000 |
| `workspace/list` | `:305-309` | 无对应端点时本地构造返回值 |
| `host.describe` | `:317` | 超时 15000 |
| 事件订阅 | `:399` | `session/follow` |
| 快照重建 | `:488-521` | 断线后按序号补齐 |
| 序号重置 | `:30`、`:38-40` | `SEQ_RESET_GAP = 100`、`shouldResetSeqWatermark` |
| 序号水位 | `qq-bridge/state/dsh-seq.json` | 由桥启动装配注入（`qq-bridge/src/bridge.js:463-466`） |

### 12.5 会话映射与自愈

表 89：会话映射（口径：载体与常量）。

| 项 | 载体 | 行为 |
| --- | --- | --- |
| 映射表 | `state/sessions.json`（现场 20 字节） | `key` 到 `sessionId` |
| 落盘 | `qq-bridge/src/core/config.js:440`、`:448-452` | 临时文件加原子重命名 |
| 启动自愈 | `qq-bridge/src/bridge.js:490-512` | 剔除磁盘上不存在的 `sessionId` 并回写 |
| 清理 | `quarantineSession` | 删除映射并置 `_quarantineRebuilt`（`qq-bridge/src/core/turn-guard.js:56-106`） |
| 更换 | `/reset`、`/new`、轮换阈值 | 见 §2.2、§4.5 |

### 12.6 预设与工具白名单

预设目录为 `qq-bridge/dsh/agent-presets/qq-chat/`。

表 90：`qq-chat` 预设构成（口径：字节数与行数为本轮实测）。

| 文件 | 规模 | 内容 |
| --- | --- | --- |
| `agent.cordis.yml` | 43,952 字节 / 215 行 | 预设主体；工具结果剪枝子插件参数 `thresholdChars: 25000`、`headChars: 22800`、`tailChars: 2000`（`:212-215`） |
| `preset.yml` | 235 字节 / 3 行 | `name: QQ 聊天角色`、`order: 10` |
| `qq-tool-restrict.mjs` | 4,905 字节 / 94 行 | 工具白名单插件 |

`qq-tool-restrict.mjs` 的白名单常量 `SAFE_PREFIXES` 位于 `:39-43`，`SAFE_EXACT` 位于 `:56-59`；`apply(ctx)` 分两步（`:66-84`、`:87-93`），其中日志截断为 `slice(0, 160)`（`:82`）；被显式排除的开发类工具名共 23 个（`:12-34`）【已核验】。该预设未挂载 `dsh-tool-ask-user` 与 `dsh-tool-todo`，相关说明以注释形式存在（`:187-195`）【已核验】。

### 12.7 宿主服务工具

`qq-bridge/src/mcp-host-server.js`（344 行）注册 5 个工具，供隔离 DSH 侧调用。

表 91：宿主服务工具（口径：注册行取自 `qq-bridge/src/mcp-host-server.js`）。

| 工具 | 注册行 | 功能 |
| --- | --- | --- |
| `qq_learning_corpus` | `:142` | 学习语料读取（见 §6.8） |
| `qq_learning_submit` | `:198` | 学习结果提交 |
| `napcat_status` | `:247` | NapCat 进程状态查询 |
| `start_napcat` | `:264` | 启动 NapCat |
| `stop_napcat` | `:314` | 停止 NapCat |

`napcat_status` 的附加字段（启动器路径、home 目录、进程号）受 `bridgeModeAllowsProcessControl()`（`:73-86`）判定约束。该函数读取 `GET http://127.0.0.1:<consolePort>/api/status` 并要求 `body?.mode === 'default'`【已核验】，而桥控制台 `/api/status` 的响应体字段为 `role`、`roleMode`、`dshReady`、`ownerQQ`、`allowGroups`、`allowPrivate`、`socialPaused`、`activity`（`qq-bridge/src/core/console-server.js:768-780`），**不含顶层 `mode` 字段**【已核验】。因此该闸门的判定输入恒不满足，结论为恒 false：即使 `napcat.allowProcessControl` 为真，`napcat_status` 也不会附带进程控制字段，`start_napcat` 与 `stop_napcat` 会进入拒绝分支【已核验】。现场 `qq-bridge/config.json` 的 `napcat.allowProcessControl` 为 `false`【已核验】。

令牌读取点位于 `:65`，读取文件为 `qq-bridge/state/console-token`【已核验】。

### 12.8 会话归档

`qq-bridge/src/core/session-archive.js`（432 行）归档空闲会话。

表 92：会话归档（口径：行号取自 `qq-bridge/src/core/session-archive.js`）。

| 项 | 位置 | 取值 / 行为 |
| --- | --- | --- |
| 默认参数 | `:27-33` | `enabled` 为真、`intervalMs = 600000`、`idleMinutes = 30`、`batchMax = 20`、`pruneDays = 0` |
| 工作区判定 | `:71-83` | 只归档桥自建工作区内的会话 |
| sessions 根候选 | `:106-140` | 顺序：`QB_DSH_HOME`、`DSH_ISOLATED_HOME`、`.runtime`、管理器配置、`DSH_HOME`、管理器目录扫描 |
| 磁盘存活判定 | `:207-220` | `liveSessionIdsOnDisk` |
| 保护名单 | `:239-267` | `protectedSessionIds`，含学习会话 |
| 归档执行 | `:279-391` | `archiveIdleSessions` |
| 定时器 | `:394-410` | `startSessionArchiveTicker`，`setInterval` 位于 `:406-409`，首次扫描延迟 90 秒（`:404`）；停止函数 `:412-414` |

现场不存在 `qq-bridge/state/session-archive.json`，归档缓存的实际落盘位置未核验【未核验】。

### 12.9 失败与降级

表 93：DSH 集成的失败路径（口径：证据列为源码位置）。

| 场景 | 行为 | 证据 |
| --- | --- | --- |
| 会话创建失败 | `unwrap` 抛错，本轮唤醒失败并记日志 | `qq-bridge/src/dsh-client.js:96-100` |
| 会话已更换 | 丢弃本轮回调结果 | `qq-bridge/src/core/dsh-session.js:142-146` |
| 事件流断线 | 按序号水位重建快照 | `qq-bridge/src/dsh-client.js:488-521` |
| 会话 id 已失效 | 启动时剔除映射并回写 | `qq-bridge/src/bridge.js:490-512` |
| 学习会话被回收 | 登记为持久学习者以避免回收 | `qq-bridge/src/core/persona-learn.js` |
| 预设覆盖文件变更 | 监听后重新同步 | `qq-bridge/src/lib/dsh-side.js:157-166` |

### 12.10 未核验

- `sessions.rename` 在桥内未见调用点，会话标题当前完全依赖工作区分组，改名能力未使用【未核验】。
- `workspace/list` 的本地构造返回值与真实端点的字段差异未核实【未核验】。
- 运行期隔离 home 下存在与 `qq-chat` 同哈希的其它预设目录，生成该目录的代码在仓库内未找到【未核验】。
- 仓库与安装副本之间预设文件的差异未做剥离合成段后的比对【未核验】。

---

## 13. 管理端功能面

本章界定 `server/index.js` 提供的 HTTP 服务、`src/` 下的页面，以及管理端与桥之间的代理关系；路由全集见附录 C。

### 13.1 职责与进程模型

`server/index.js` 为单进程 Express 服务，监听 `127.0.0.1:1921`（`PORT = process.env.QBM_API_PORT || 1921`，`:9605-9607`）【已核验】。管理端不参与 QQ 消息链路，只承担三类职责：托管页面静态资源、代理桥控制台接口、执行本机与远端的进程与文件操作。

表 94：管理端进程参数（口径：行号取自 `server/index.js`，文件 10,122 行 / 633,446 字节）。

| 项 | 取值 / 行为 | 位置 |
| --- | --- | --- |
| 监听地址与端口 | `127.0.0.1` / `1921` | `:9605-9607` |
| 仅注册路由不监听 | `QBM_NO_LISTEN=1` | `:9600` 附近 |
| 前端末位匹配 | 未匹配路径返回单页入口 | `:9590` |
| 致命异常 | `unhandledRejection` 与 `uncaughtException` 只记 `[fatal-guard]` 日志，不退出进程 | `:9598-9603` |
| 启动后动作 | `app.listen` 回调内执行 `scheduleAutoStart()`（`:9609`）与 `ensureGuardianArmed()`（`:9610`） | `:9606-9656` |
| 自动连接延迟 | 1500 毫秒后执行，60 秒后复查 | `:9621-9648`、`:9651-9652` |
| 桥控制台代理 | `proxyToBridgeConsole`（`:7382`），默认超时 30000 定义于 `callBridgeConsole`（`:7315`） | `:7315`、`:7382` |

### 13.2 页面清单

页面为 React 单页应用的十个路由组件，构建产物由管理端进程托管。

表 95：页面规模（口径：本轮实测字节数与行数）。

| 页面 | 文件 | 行数 | 字节 |
| --- | --- | --- | --- |
| 桥配置 | `src/pages/BridgeConfig.tsx` | 3575 | 293,141 |
| 学习 | `src/pages/Learning.tsx` | 2615 | 172,574 |
| 群画像 | `src/pages/GroupPortrait.tsx` | 1349 | 90,053 |
| 语音配置 | `src/pages/VoiceConfig.tsx` | 838 | 55,571 |
| SSH 配置 | `src/pages/SSHConfig.tsx` | 773 | 50,369 |
| 首页 | `src/pages/Home.tsx` | 509 | 35,119 |
| 关系画布 | `src/pages/NetCanvas.tsx` | 561 | 31,827 |
| 聊天记录 | `src/pages/ChatHistory.tsx` | 485 | 27,698 |
| 实例配置 | `src/pages/InstanceConfig.tsx` | 367 | 23,365 |
| 网页视图 | `src/pages/WebView.tsx` | 195 | 10,519 |

共用模块：`src/api.ts`（1,025 行 / 56,685 字节）提供接口封装；`src/config-cache.ts`（605 行 / 38,165 字节）提供配置缓存；`src/tool-schema-chars.ts`（125 行）为工具描述字符数的前端副本【已核验】。页面目录下另有一个残留备份文件 `src/pages/InstanceConfig.tsx.bak-deadcard-20260923`（15,227 字节），不被构建引入【已核验】。

### 13.3 路由分组

管理端共注册 93 条带引号路径的路由（判据：排除整行注释后的 `app.(get|post|put|delete|patch)('<path>'`）；另有 1 条正则末位匹配路由 `app.get(/^\/(?!api\/).*/, …)`（`:9590`）与 3 条中间件注册 `app.use(`（`:40`、`:41`、`:9585`）不计入该计数【已核验】。分组构成见附录 C。

表 96：路由分组与条数（口径：本轮正则抽取，工作区无重复注册之外的过滤）。

| 分组 | 前缀 | 条数 |
| --- | --- | --- |
| 本机实例与配置 | `/api/config`、`/api/state`、`/api/connect`、`/api/open`、`/api/instance/*`、`/api/napcat/*` | 20 |
| 桥数据代理 | `/api/bridge/*` | 24 |
| 远端 SSH | `/api/ssh/*` | 13 |
| 学习与画像 | `/api/learning/*` | 20 |
| 黑话 | `/api/slang/*` | 4 |
| 语音 | `/api/voice/*` | 7 |
| 方案档案 | `/api/profiles*` | 3 |
| 守卫与退出 | `/api/guardian/arm`、`/api/shutdown` | 2 |
| 合计 | — | 93 |

### 13.4 配置字段与凭据通道

桥配置的字段全集以 `qq-bridge/config.example.json` 为准，现场值为 `qq-bridge/config.json`。接口密钥不写入 `config.json`：`config.dsh.apiKey` 与 `clearApiKey` 在落盘前被摘除（本机 `server/index.js:5555-5560`，远端 `:7142-7144`），改写入隔离 DSH 的 `.credentials.yaml`【已核验】。

表 97：凭据通道（口径：行号取自 `server/iso-credential.js` 与 `server/index.js`）。

| 符号 | 位置 | 作用 |
| --- | --- | --- |
| `mergeCredentialText` | `server/iso-credential.js:87` | 合并凭据文档 |
| `credentialRefsBlock` | `server/iso-credential.js:21` | 生成 `refs:` 段 |
| `yamlScalar` | `server/iso-credential.js:59` | 标量转义 |
| `credentialStatusFromText` | `server/iso-credential.js:125` | 状态解析 |
| `validateCredentialDocument` | `server/iso-credential.js:140` | 文档结构校验：顶层只允许 `version`、`refs`、`records`，密钥缩进 2 格写在 `refs:` 下 |
| `writeIsoCredential` | `server/index.js:5521` | 写盘并以 `0600` 权限加 `.bak-<时间戳>` 备份 |
| `isoCredentialStatus` | `server/index.js:5540` | 只返回 `set` 与 `len`，不返回值本身 |
| `providerApiKeyEnv` | `server/index.js:5495` | 生成环境变量名 |
| `isoHomeDir` | `server/index.js:5461` | 解析隔离 home |

远端 `config.json` 的写入顺序为：临时文件、`.bak-<时间戳>`、原子 `mv`、回读比对（`:7146-7171`），结果以 `verified` 或 `mismatched` 回传前端【已核验】。桥侧 `POST /api/bridge/config` 同样执行深合并、备份与原子重命名，注册行位于 `:5546`，深合并与写入段位于 `:5571-5594`【已核验】。

### 13.5 配置字段集合

表 98：桥配置顶层键（口径：`qq-bridge/config.example.json` 的键全集）。

| 键 | 子键 |
| --- | --- |
| `dsh` | `baseUrl`、`provider`、`model`、`reasoningEffort`、`apiKey`、`visionModel`、`visionBaseUrl`、`visionApiKey` |
| `dshCompaction` | `enabled`、`thresholdRatio`、`retainRatio`、`toolResultMaxChars` |
| `napcat` | `wsUrl`、`httpUrl`、`accessToken`、`launcherPath`、`homeDir`、`allowProcessControl`、`wsAccessToken`、`imageFileMode`、`tmpDir`、`dockerPathMap` |
| `pixiv` | `base`、`cookie`、`refreshToken` |
| `guard` | `enabled`、`probeIntervalMs`、`failThreshold`、`cooldownMs`、`maxHealsPerHour`、`restartGraceSec`、`recoverWaitMs`、`autoHeal` |
| 标量键 | `ownerQQ`、`sessionCwd`、`agentPreset`、`workspaceTitle`、`allowAllWhenEmpty`、`allowAllPrivate`、`allowAllGroups`、`ackMessage`、`sendDelayMs`、`questionTimeoutMs`、`consolePort`、`consoleToken` |
| 名单键 | `allow.private`、`allow.groups`、`deny.private`、`deny.groups` |
| 其它对象键 | `prompt.styleLine`、`tokenCost`、`security.interceptNotify`、`slang`、`social` |

`social` 下含 `enabled`、`autoReplyCheckMs`、`agentPreset`、`provideRecommendations`、`tools`（30 键）、`wake`、`send`、`wait`、`sticker`、`meme`、`proactive`、`feedback`、`context`、`autoReset`、`sessionArchive`、`steerEnabled`、`charactersDir`、`slimTools`、`turnHold`、`typing`、`toolCompressor`【已核验】。

现场 `qq-bridge/config.json` 与示例文件的键集差异为：`napcat` 段实际只有 7 键（`wsUrl`、`httpUrl`、`accessToken`、`wsAccessToken`、`launcherPath`、`homeDir`、`allowProcessControl`），不含 `imageFileMode` 与 `tmpDir`；`social` 段不含 `slimTools.schemaLevel`，也不含 `toolCompressor` 键【已核验】。示例文件另含若干以下划线开头的说明键（如 `_allowAllNote`、`dshCompaction._note`、`social.send._linearNote`），现场文件不含这些键【已核验】。

### 13.6 随包 QQ 窗口隐藏器

`startNapcatHidden(onekey, quickLogin)`（`server/index.js:1291`）在拉起 NapCat 之前隐藏随包 QQ 的窗口。实现方式为向宿主机投放常驻 C# 脚本（`qqWindowHiderScript(cfg)`，`:1348`；类名 `MoonBotQqWinHideResident`；脚本首行注释标明由 `server/index.js` 生成）【已核验】。

表 99：窗口隐藏器参数（口径：`QQ_HIDER_DEFAULTS`，`server/index.js:1336`）。

| 参数 | 取值 | 含义 |
| --- | --- | --- |
| `budgetMs` | `43200000`（12 小时） | 观察者自身存活上限，到点退出；实际退出条件由父进程守卫决定 |
| `pollMs` | `200` | 常态轮询间隔 |
| `burstMs` | `50` | 目标出现后的快扫间隔 |
| `burstWindowMs` | `5000` | 快扫持续时长 |
| `readyTimeoutMs` | `2500` | 等待条件就绪的上限 |

配套机制：存活的隐藏器登记于集合 `qqHiders`（`:1338`），重启 NapCat 时新实例收掉旧实例，不并行运行；目标进程号由 seed 文件传递（`:1353` 注释）【已核验】。路径守卫为硬条件：只处理可执行文件路径位于本 Shell 目录之下的进程（`:1325-1330` 注释）【已核验】。启动器与命令行的具体拼装未逐行核实【未核验】。

### 13.7 失败与降级

表 100：管理端降级路径（口径：行号取自 `server/index.js`）。

| 场景 | 行为 | 位置 |
| --- | --- | --- |
| 桥控制台不可达 | 返回 `bridge-offline`，区分桥未运行、隧道缺失与超时三类 | `:7340-7377` |
| 桥版本过旧（404 或非 JSON） | 返回 `bridge-stale` 并提示更新桥代码后重启 | `:7328-7338` |
| 学习配置端点桥不可达 | 仅在确实连不上时降级：本机直读写文件，远端走 SSH 读写并做备份、原子重命名与回读比对 | `:7421-7435`、`:7567-7572` |
| 本机桥不可用但需查看聊天记录 | 管理端直读 SQLite | `:5028-5029` 注释 |
| 管理端自身异常 | 只记 `[fatal-guard]` 日志，不退出 | `:9598-9603` |

### 13.8 未核验

- `/api/bridge/chat-stream` 与 `/api/bridge/context-overhead` 的响应字段未取到，其结构未核验【未核验】。
- `src/pages/NetCanvas.tsx` 内不含 `/api` 字面量，也不调用 `api()`，该页面不直接访问管理与桥接口【已核验】。
- 管理端路由的请求与响应字段来自正则抽取，个别端点的字段完整性未核验【未核验】。

---

## 14. 部署、开机自动连接与运行维护

本章界定本机部署的进程编排、退出守卫、完整性自修、远端克隆部署与日志落盘；端口定义见 §3.1。

### 14.1 本机进程编排

表 101：本机进程（口径：行号取自 `server/index.js` 与各模块定义处）。

| 进程 | 启动者 | 关键行为 |
| --- | --- | --- |
| 管理端 | 由用户或自启动项启动 | 监听 `127.0.0.1:1921`，见 §13.1 |
| 桥 | 管理端起 | 单实例锁 `qq-bridge/state/bridge.lock`（`qq-bridge/src/lib/paths.js:20`） |
| 隔离 DSH | 管理端起 | home 由 `isoHomeDir` 解析（`server/index.js:5461`） |
| NapCat 启动器 | 管理端起 | 经 `startNapcatHidden` 拉起（`server/index.js:1291`） |
| QQ | NapCat 拉起 | 随包 QQ，窗口由隐藏器处理，见 §13.6 |
| 退出守卫 | 管理端起 | 见 14.2 |

### 14.2 退出守卫

`server/napcat-guardian.mjs`（146 行）为独立进程，负责在管理端退出后回收 NapCat 与随包 QQ。

表 102：退出守卫参数（口径：行号取自 `server/napcat-guardian.mjs` 与 `server/index.js`）。

| 项 | 取值 / 行为 | 位置 |
| --- | --- | --- |
| 父进程存活探测 | `alive(parentPid)` `:69-72`，轮询 `setInterval(…, 2000)` `:131`、`:146` | `server/napcat-guardian.mjs` |
| 宽限时间 | 默认 `30000` 毫秒（`:52`） | 同上 |
| 当前守卫进程号 | `currentGuardPid()` `:75-77` | 同上 |
| 清理对象 | 三条命令：NapCat `:93`、桥 `:103`、DSH `:110`，均带自身排除判定 `NOT_SELF`（`:87`） | 同上 |
| 命令行参数 | `--parent`、`--guard-file`、`--dsh-port`、`--bridge-script`、`--grace`、`--kill-napcat`、`--dirs`、`--log` | 同上 |
| 状态文件与目录 | `GUARDIAN_FILE`、`CONFIG_DIR`、`LOG_DIR` | `server/index.js:43`、`:45`、`:9863` |
| 装配 | `armNapcatGuardian`（`:9942`）与 `spawnGuardianDetached`（`:9884`，以 `guard-node.exe` 硬链接 `:9887-9896` 配合 WMI `Win32_Process.Create` 与 `ShowWindow=0` 启动 `:9907-9913`） | `server/index.js` |
| 启动后自动装配 | `ensureGuardianArmed()`（`:9989`）；环境变量 `QBM_NAPCAT_GUARDIAN`（`:9991-9997`）与父进程名正则 `/^MoonBot$/i`（`:9998`）参与判定；复查间隔 60000 毫秒（`:9651`） | `server/index.js:9610` |
| 手动装配端点 | `POST /api/guardian/arm` | `server/index.js:10016` |
| 退出端点 | `POST /api/shutdown`，请求体 `{all}` | `server/index.js:10040` |

### 14.3 完整性自修

`server/napcat-repair.js`（154 行）修复 NapCat 应用被安全软件删除部分文件后的相对导入断裂。

表 103：完整性自修（口径：行号取自 `server/napcat-repair.js` 与 `server/index.js`）。

| 项 | 取值 / 行为 |
| --- | --- |
| 扫描深度上限 | `if (depth > 8) return;`（`:53`） |
| 检查函数 | `checkNapcatApp`，检查四类相对导入是否可解析；四类形态集中在 `relativeSpecifiers`（`:42-45`）：具名 `from`、副作用 `import`、动态 `import()`、`require()` |
| 修复函数 | `repairNapcatApp`（`:95`），经 `findShellZip`（`:78-89`）向上查找 10 层内的 `NapCat.Shell.zip` 与同目录 `7z.exe`（`:82`），以 `spawnSync`（`:105`）解压所需文件 |
| 入口函数 | `ensureNapcatApps`，返回值定义于 `:135-141`，字段为 `{ok, checked, broken, repaired, detail, error}` |
| 调用点 | `server/index.js:2344` |
| 附带修复 | JSON 首字节序标记清理 `healNapcatJsonBom`（`server/index.js:2355`，调用段 `:2352-2361`）、VC++ 运行库检查 `healNapcatVcruntime`（`:2365`，调用段 `:2362-2371`） |
| 记录的根因 | `server/napcat-repair.js:4-14` 注释说明目标文件随版本变化（`conout-D9oph_Le.js` 与 `conout-wiJ7YKRd.js` 列于 `:10-11`） |

### 14.4 远端部署

`server/deploy.js`（1,652 行）实现 SSH 远端克隆部署。

表 104：远端部署（口径：行号取自 `server/deploy.js`）。

| 项 | 取值 / 行为 |
| --- | --- |
| 任务表 | `deployTasks`（`:25`） |
| 任务号格式 | `:1632` |
| 日志上限 | 800 行（`:46`） |
| 步骤辅助 | `step()` 与 `safely()`（`:1059-1073`） |
| 主体 | `runDeploy`（`:1046`），执行段 `:1075-1601`，异常与收尾段 `:1602-1625` |
| 流式转发超时 | `streamPipe` 超时 1800000（`:99`） |
| 保留脚本生成 | `buildDeployKeepScript`（`:366-423`）、`buildStagePlan`（`:424`） |
| systemd 单元模板 | `napcat.service`（`:568-601`，`ExecStart=/opt/napcat/run-napcat.sh` 位于 `:586`）、`dsh-web.service`（`:1419-1436`，`ExecStart` 位于 `:1428`） |
| 卸载栈端点 | `POST /api/ssh/remove-stack`，注册行 `server/index.js:4209`，其内的目录移动命令位于 `:4226` |
| 栈管理说明 | `server/index.js:4257-4259` 注释（路由注册行 `:4260`） |
| 服务名校验 | `server/index.js:4376-4378`（路由注册行 `:4327`） |
| 同步端点 | `server/index.js:3876-3892`（路由注册行 `:3843`） |
| 压缩依赖 | 部署脚本安装 `mcp-compressor==0.31.9`（`server/index.js:1167`） |

### 14.5 开机自动连接

表 105：自动连接链路（口径：行号取自 `server/index.js`）。

| 项 | 取值 / 行为 | 位置 |
| --- | --- | --- |
| 自动连接编排 | `scheduleAutoStart()`，顺序为 napcat-local、dsh-isolated、bridge-local，间隔 1200 毫秒 | `:10077-10118` |
| 单条连接 | `connectOne` | `:447-474` |
| 隧道映射 | `tunnelMapFor`：`6099→13000`、`3000→13001`、`3080→13080`、`3100→13100` | `:189-197` |
| 隧道建立 | `ensureTunnels` | `:240-261` |
| 建隧道超时 | 8 秒 | `:232` |
| 端口占用处理 | `EADDRINUSE` 时退避重试 | `:217-221` |
| 重连退避 | `RECONNECT_BACKOFF_MS` | `:289` |
| 手动断开标记 | `manualDisconnects` | `:283`、`:333` |
| 连接替换 | `replacingConnections` | `:287`、`:308-313`、`:336` |
| 服务就绪等待 | `waitServerReady`，`waitServerMs = 150000`、`pollMs = 4000` | `:402-441` |

### 14.6 日志与状态文件

表 106：日志与状态载体（口径：现场字节数为本轮实测）。

| 载体 | 路径 | 现场规模 | 写入方 |
| --- | --- | --- | --- |
| 桥日志 | `qq-bridge/state/bridge.log` | 311,160 字节 | `qq-bridge/src/lib/log.js`，保留最近 2000 行（`:15`） |
| 工具调用日志 | `qq-bridge/state/tool-calls.jsonl` | 487,098 字节 | `qq-bridge/src/core/audit.js:76`，上限 2000 行（`:104`） |
| 反馈日志 | `qq-bridge/state/feedback.json` | 1,394 字节 | `qq-bridge/src/core/audit.js:51`，上限 500 条（`:58`） |
| 用量日志 | `qq-bridge/state/token-usage.jsonl` | 60,524 字节 | `qq-bridge/src/core/token-meter.js:413-426` |
| 活动记录 | `qq-bridge/state/qq-activity.log` | 56,072 字节 | 桥各模块的 `appendActivity` |
| 桥 stdout / stderr | `qq-bridge/state/bridge-stdout.log`、`bridge-stderr.log` | 1,047 / 169 字节 | 进程重定向 |
| 其它 | `state/` 下另有 22 个文件 | — | 见各章 |

### 14.7 失败与降级

表 107：部署与运维的失败路径（口径：证据列为源码位置）。

| 场景 | 行为 | 证据 |
| --- | --- | --- |
| 父进程消失 | 退出守卫在宽限 30 秒后回收受管进程 | `server/napcat-guardian.mjs` |
| NapCat 相对导入断裂 | 从 `NapCat.Shell.zip` 解压缺失文件 | `server/napcat-repair.js` |
| 隧道端口被占用 | 退避后重试建立 | `server/index.js:217-221` |
| 远端服务未就绪 | 按 4000 毫秒轮询，最长等待 150 秒 | `server/index.js:402-441` |
| 桥锁冲突 | 目标进程输出提示并以退出码 2 结束 | `qq-bridge/src/core/runtime.js:38/53` |

### 14.8 未核验

- 仓库内不存在开机自启动项的实现：`schtasks`、注册表 `Run` 键、启动目录 `.lnk` 快捷方式在排除依赖与产物目录后命中数为 0【已核验】。`tools/start-manager-hidden.vbs` 为隐藏启动器，其中不含自启注册逻辑【已核验】。自启动的实际来源在仓库之外【未核验】。
- 仓库根 `scripts/` 目录为空，部署相关脚本实际分布在 `server/deploy.js`、`server/index.js`、`qq-bridge/scripts/` 与 `tools/`，该分布的成因未核验【未核验】。
- `qq-bridge/music-sign-proxy.py`（241 行，`127.0.0.1:4567`）在仓库的 JavaScript 与配置文件中无引用，仅见于 `docs/release-1.0.0.md:23` 的文档说明【已核验】；随包 NapCat 的 `onebot11_3199924964.json:52` 配置了 `musicSignUrl` 指向 `http://127.0.0.1:4567/music_card/card`【已核验】。桥侧 `musicSignUrl` 未配置，该代理在当前部署下是否随桥启动未核验【未核验】。
- 安装副本与仓库源之间预设文件的哈希差异至少部分来自合成段，未在剥离合成段后比对【未核验】。

---

## 15. 安全模型与信任边界

本章界定三组边界：出站内容的敏感判定与脱敏、入站与出站网络请求的目标限制、接口与工具的信任等级判定。

### 15.1 敏感内容判定

`qq-bridge/src/sensitive.js`（37 行）提供三组正则与两个判定函数。

表 108：敏感判定构件（口径：行号取自 `qq-bridge/src/sensitive.js`）。

| 符号 | 位置 | 作用 |
| --- | --- | --- |
| `PATH_RE` | `:13` | 本机文件路径 |
| `SECRET_PATH_RE` | `:15` | 凭据类文件路径 |
| `CRED_RE` | `:16` | 凭据字面量 |
| `SENSITIVE_RE` | `:18` | 三者的合成式，供快速判定使用 |
| `sensitiveHitKind(text)` | `:21` | 返回 `'path'`、`'secret-path'` 或 `'credential'` |
| `sensitiveHitSample(text, max = 48)` | `:30` | 截取样本，遍历范围为 `PATH_RE` 与 `CRED_RE`，不含 `SECRET_PATH_RE` |
| 设计边界说明 | `:1-11` | 注释说明该模块只判定形态，不判定语义 |

调用点共四处，全部为 HTTP 403：`qq-bridge/src/core/console-server.js:1191`、`:2137`、`:2488`、`:5180`【已核验】。

### 15.2 脱敏与令牌防泄露

`qq-bridge/src/lib/text-safe.js`（247 行）提供脱敏与泄露判定。

表 109：脱敏构件（口径：行号取自 `qq-bridge/src/lib/text-safe.js`）。

| 符号 | 位置 | 作用 |
| --- | --- | --- |
| `KNOWN_AGENT_TOKENS` | `:6` | 已知 agent 令牌集合 |
| `LEARNER_AGENT_TOKENS` | `:12` | 学习令牌集合 |
| `redactSensitiveText` | `:16` | 日志与落盘前的统一脱敏入口 |
| `SENSITIVE_ARG_KEYS` | `:33` | 发送参数中需判定的键，共 21 键 |
| `TOKEN_LABEL_SRC` | `:106` | 令牌标签匹配式 |
| `tokenDisclosureIn(text)` | `:108` | 判定正文是否含令牌 |
| `splitSerializedBubbles` | `:221` | 参数数组还原 |

日志脱敏在 `qq-bridge/src/lib/log.js:8` 与 `:24` 两处执行【已核验】。发送出口的判定见 §5.1。

### 15.3 网络请求目标限制

出站抓取统一经 `qq-bridge/src/safe-fetch.js`（456 行），判定顺序为解析主机、校验网段、连接、复检重定向目标（见 §8.2）。私有网段清单覆盖 IPv4 与 IPv6 两类，并解嵌 IPv4-mapped 与 NAT64 形式（`qq-bridge/src/safe-fetch.js:66`）【已核验】。该模块不注册 MCP 工具，仅作为库被引用【已核验】。

媒体层的字节与像素双闸（`qq-bridge/src/core/media-pipe.js:15-17`）在下载之后执行，用于限制进入模型上下文的体积【已核验】。

### 15.4 信任等级判定

表 110：信任等级（口径：行号取自 `qq-bridge/src/core/console-server.js`）。

| 等级 | 判定条件 | 授权范围 |
| --- | --- | --- |
| `owner-private` | 令牌对应所有者账号且为私聊 | 全部接口 |
| `trusted-spoke-here` | 在信任窗口内于本会话发言的账号 | 会话范围内的接口 |
| 无等级 | 令牌缺失或失效 | 读取端点 403 |

信任窗口 `TRUST_SPOKE_WINDOW_MS = 600000`（`:249`），判定函数 `trustLevelForToken`（`:269`）【已核验】。非受信任者调用受限端点时返回固定文案，该文案位于 `qq-bridge/src/core/console-server.js:277`，其中含权限角色称谓，本文以 `[owner]` 替代该称谓，原文见该行【已核验】。

### 15.5 静默与审计

表 111：静默与审计边界（口径：证据列为源码位置）。

| 机制 | 行为 | 证据 |
| --- | --- | --- |
| 审计范围 | `shouldAuditKey()` 恒返回真，全部会话均需审计 | `qq-bridge/src/core/audit.js:15-17` |
| 静默态下的静默回复 | 非所有者私聊禁止静默回复 | `qq-bridge/src/core/audit.js:19-22` |
| 拦截通知 | 拦截后不向 QQ 发送任何通知，只记日志与活动记录 | `qq-bridge/src/core/audit.js:24-30` |
| 反馈落盘 | 写入前对 `message` 字段执行脱敏 | `qq-bridge/src/core/audit.js:51-59` |
| 凭据通道 | 密钥不写入 `config.json`，见 §13.4 | `server/index.js:5555-5560` |
| 状态文件权限 | 单实例锁与令牌文件以 `0o600` 写入 | `qq-bridge/src/core/runtime.js:13`、`qq-bridge/src/core/learning-token.js` |

### 15.6 工具白名单

表 112：工具注册的三道限制（口径：证据列为源码位置）。

| 限制 | 判据 | 证据 |
| --- | --- | --- |
| 档位裁剪 | `toolAllowedByTier` | `qq-bridge/src/mcp-napcat-safe.js:741` |
| 配置开关 | 35 处 `if (cfg.social.tools.* / sticker / meme)` 分支 | `qq-bridge/src/mcp-napcat-safe.js` |
| 预设白名单 | `SAFE_PREFIXES` 与 `SAFE_EXACT` 之外的工具被拒绝 | `qq-bridge/dsh/agent-presets/qq-chat/qq-tool-restrict.mjs:39-43`、`:56-59` |

### 15.7 失败与降级

表 113：安全边界的失败路径（口径：证据列为源码位置）。

| 场景 | 行为 | 证据 |
| --- | --- | --- |
| 敏感内容命中 | 403 或抛错，不静默放行 | `qq-bridge/src/core/console-server.js:1191/2137/2488/5180`、`qq-bridge/src/core/qq-send.js:197-201` |
| 抓取目标为私有网段 | 拒绝连接 | `qq-bridge/src/safe-fetch.js:66/132` |
| 重定向指向私有网段 | 复检后拒绝 | `qq-bridge/src/safe-fetch.js:376-378/382-385` |
| 令牌缺失 | 403 | `qq-bridge/src/core/console-server.js:714-717` |
| 非 JSON 请求体 | 415 | `qq-bridge/src/core/console-server.js:698-700` |
| 跨 Origin 请求 | 403 | `qq-bridge/src/core/console-server.js:702-710` |

### 15.8 未核验

- 敏感判定的误报与漏报比例未做测量【未核验】。
- 私有网段判定的运行期拦截行为未逐段复现，结论来自静态阅读【未核验】。
- `qq-bridge/src/core/console-server.js:277` 文案的完整内容含权限角色称谓，本文未逐字转录【已核验，内容未转录】。

---

## 16. 常量与阈值总表

本章汇总全文出现的常量、阈值与上限，取值与正文一致，均为源码字面值或现场配置值。单位未标注者为毫秒或字符，按列语义判断。

### 16.1 接收与唤醒

表 114：接收与唤醒常量（口径：取值为源码字面值；现场值取自 `qq-bridge/config.json`）。

| 常量 | 取值 | 位置 |
| --- | --- | --- |
| `INBOUND_DEDUP_TTL_MS` | `10 * 60 * 1000` | `qq-bridge/src/core/mux.js:278` |
| `INBOUND_DEDUP_MAX` | `800` | `qq-bridge/src/core/mux.js:279` |
| 会话键正则 | `^(group\|private):(\d+)$` | `qq-bridge/src/core/mode.js:41` |
| `social.context.recentLimit` | 默认 `100` | `qq-bridge/src/core/config.js:280` |
| 持久化窗口保留 | `slice(-200)` | `qq-bridge/src/core/social-state.js:348` |
| `TRUST_SPOKE_WINDOW_MS` | `600000` | `qq-bridge/src/core/console-server.js:249` |
| 会话内集合数 | 31 个 `Map` / `Set` | `qq-bridge/src/core/session-state.js` |
| 入站闸门数 | 9 道 | §2.4 |

### 16.2 出站与投递

表 115：出站与投递常量（口径：现场值取自 `qq-bridge/config.json` 的 `social.send`）。

| 常量 | 默认值 | 现场值 | 位置 |
| --- | --- | --- | --- |
| `SEND_TIMEOUT_MS` | `15000` | — | `qq-bridge/src/core/qq-send.js:24` |
| 发送重试等待 | `2500` | — | `qq-bridge/src/core/qq-send.js:315/331` |
| `REPLAY_WINDOW_MS` | `180000` | — | `qq-bridge/src/core/send-idempotency.js:40` |
| `DELIVERED_KEEP` | `50` | — | `qq-bridge/src/core/send-idempotency.js:42` |
| `linearPerCharMs` | `150` | `150` | `qq-bridge/src/core/send-chain.js:110` |
| `linearMinMs` | `250` | `250` | `qq-bridge/src/core/send-chain.js:111` |
| `linearCapMs` | `4000` | `1500` | `qq-bridge/src/core/send-chain.js:112` |
| `linearJitterRatio` | `0.25` | `0.25` | `qq-bridge/src/core/send-chain.js:113` |
| `linearResetMs` | `60000` | `20000` | `qq-bridge/src/core/send-chain.js:114` |
| `MIN_GAP_MS` | `100` | — | `qq-bridge/src/lib/send-gaps.js:12` |
| `maxGapMs` 默认上限 | `10000` | `15000` | `qq-bridge/src/lib/send-gaps.js:23-26` |
| `splitForQQ` 单条上限 | `4000` | — | `qq-bridge/src/md-to-plain.js:33` |
| `QUEUE_MAX` | `50` | — | `qq-bridge/src/core/prompt-deliver.js:17` |
| 投递超时 | `30000` | — | `qq-bridge/src/core/prompt-deliver.js:165` |
| `LONG_WAIT_TURN_TIMEOUT_MS` | `11 * 60 * 1000` | — | `qq-bridge/src/core/turn-guard.js:21` |
| `ROTATE_DEFER_MAX_MS` | `120000` | — | `qq-bridge/src/core/wake-send.js:75` |
| `social.send.maxMessageChars` | — | `1000` | `qq-bridge/config.json` |
| `social.send.burstMaxMessages` | — | `10` | `qq-bridge/config.json` |
| `social.send.maxSendPerMinute` | — | `15` | `qq-bridge/config.json` |
| `social.send.maxSendPerHour` | — | `600` | `qq-bridge/config.json` |
| `social.send.longGapProbability` | — | `0.25` | `qq-bridge/config.json` |
| `social.send.longGapMinMs` / `MaxMs` | — | `8000` / `20000` | `qq-bridge/config.json` |
| `OUTBOX_MAX` | `200` | — | `qq-bridge/src/lib/onebot-ws.js:28` |
| WS 发送超时 | `20000` | — | `qq-bridge/src/lib/onebot-ws.js:27` |
| WS 连接超时 | `15000` | — | `qq-bridge/src/lib/onebot-ws.js:26` |
| `RECONNECT_BASE_MS` / `MAX` | `1500` / `10000` | — | `qq-bridge/src/lib/onebot-ws.js:10/15` |
| `HEARTBEAT_WATCHDOG_MS` | `45000` | — | `qq-bridge/src/lib/onebot-ws.js:22` |

### 16.3 记忆与学习

表 116：记忆与学习常量（口径：取值为源码字面值）。

| 常量 | 取值 | 位置 |
| --- | --- | --- |
| `FTS_SCHEMA_VERSION`（聊天库） | `'1'` | `qq-bridge/src/core/chat-db.js:35` |
| `FTS_SCHEMA_VERSION`（记忆库） | `'2'` | `qq-bridge/src/core/memory.js:90` |
| 消息正文入库上限 | `2000` 字符 | `qq-bridge/src/core/chat-db.js:653` |
| FTS 词长下限 | `3` | `qq-bridge/src/lib/fts.js:25` |
| FTS 词数上限 | `8` | `qq-bridge/src/lib/fts.js:28` |
| 记忆分层 | `permanent 0` / `durable 90 天` / `working 7 天` | `qq-bridge/src/core/memory.js:87` |
| `memoryDigest` `limit` 区间 | `1..30`，默认 `12` | `qq-bridge/src/core/memory.js:703-731` |
| `memoryDigest` `maxChars` 区间 | `120..4000`，默认 `700` | 同上 |
| 摘要单行截断 | `140` | 同上 |
| 群缓存 TTL | `10 * 60 * 1000` | `qq-bridge/src/core/group-cache.js:7/15` |
| `PERSONA_TURN_TIMEOUT_MS` | `300000` | `qq-bridge/src/core/persona-learn.js:42` |
| `PERSONALITY_MAX` | `1200` | `qq-bridge/src/core/persona-learn.js:43` |
| `PERSONA_EN_MAX` | `6000` | `qq-bridge/src/core/persona-learn.js:47` |
| `PERSONA_BACKUP_KEEP` | `5` | `qq-bridge/src/core/persona-learn.js:48` |
| `SAMPLE_TOTAL_CAP` | `300` | `qq-bridge/src/core/persona-learn.js:37` |
| `KEEP_OLD_MIN` | `60` | `qq-bridge/src/core/persona-learn.js:498` |
| `PERSONA_BRIEF_VERSION` | `5` | `qq-bridge/src/core/persona-learn.js:318` |
| `PROFILE_MAX` | `4000` | `qq-bridge/src/core/persona-text.js:18` |
| `SLANG_BRIEF_VERSION` | `3` | `qq-bridge/src/core/slang.js` |
| 黑话窗口大小 | `80` | `qq-bridge/src/core/slang.js:355` |
| `MAX_LEARN_MSGS` | `2400` | `qq-bridge/src/core/slang.js:419-424` |
| `MAX_BLOCK_MSGS` | `800` | 同上 |
| `MAX_LEARN_BLOCKS` | `3` | 同上 |
| `LEARN_TURN_TIMEOUT_MS` | `5 * 60 * 1000` | 同上 |
| `NIGHTLY_TICK_MS` | `60 * 1000` | 同上 |
| `NIGHTLY_RETRY_MS` | `5 * 60 * 1000` | 同上 |
| `SLANG_MANUAL_LOOKBACK_MS` | `24 * 3600 * 1000` | `qq-bridge/src/core/slang.js:597` |
| 黑话词表注入上限 | `8` | `qq-bridge/src/core/slang.js:388` |
| 画像默认参数 | `minMessages 10`、`maxTargets 20`、`windowHours 720` | `qq-bridge/src/core/portrait-learn.js:18-27` |
| `PORTRAIT_TICK_MS` | `60000` | `qq-bridge/src/core/portrait-learn.js:29` |
| 学习语料 `limit` | 默认 `400`，上限 `800` | `qq-bridge/src/mcp-host-server.js:142` |
| 学习语料会话数上限 | `50` | 同上 |

### 16.4 媒体

表 117：媒体常量（口径：取值为源码字面值）。

| 常量 | 取值 | 位置 |
| --- | --- | --- |
| `MAX_MEDIA_BYTES` | `25 * 1024 * 1024` | `qq-bridge/src/core/media-pipe.js:15` |
| `MAX_MEDIA_PIXELS` | `64_000_000` | `qq-bridge/src/core/media-pipe.js:16` |
| `MAX_MEDIA_STORE_PER_KEY` | `500` | `qq-bridge/src/core/media-pipe.js:17` |
| 表情实体查询超时 | `12000` | `qq-bridge/src/core/media-pipe.js:165` |
| `MAX_IMAGE_FETCH_BYTES` | `15 * 1024 * 1024` | `qq-bridge/src/safe-fetch.js:348` |
| `MAX_REDIRECTS` | `5` | `qq-bridge/src/safe-fetch.js:363` |
| `IMAGE_MAX_SIDE` | `1280` | `qq-bridge/src/lib/image-compress.js:30` |
| `IMAGE_HARD_MAX_SIDE` | `4096` | `qq-bridge/src/lib/image-compress.js:32` |
| `IMAGE_HARD_MAX_BYTES` | `15MB` | `qq-bridge/src/lib/image-compress.js:47` |
| `IMAGE_PUREJS_MAX_PIXELS` | `40_000_000` | `qq-bridge/src/lib/image-compress.js:49` |
| `IMAGE_JPEG_QUALITY` | `82` | `qq-bridge/src/lib/image-compress.js:50` |
| `IMAGE_MIN_COMPRESS_BYTES` | `40 * 1024` | `qq-bridge/src/lib/image-compress.js:51` |
| `IMAGE_ANIM_KEEP_MAX` | `4MB` | `qq-bridge/src/lib/image-compress.js:52` |
| `DEFAULT_BASE64_MAX_BYTES` | `10 * 1024 * 1024` | `qq-bridge/src/lib/napcat-file.js:27` |
| 表情同步 TTL | `60000` | `qq-bridge/src/core/sticker.js:120` |
| 表情列表上限 | `500` | `qq-bridge/src/core/sticker.js:126` |
| `FORCE_LOOKUP_COOLDOWN_MS` | `30000` | `qq-bridge/src/core/sticker.js:43` |
| 表情注入上限 | `promptMaxStickers`，现场 `8` | `qq-bridge/config.json` |
| `MEME_RESCAN_MS` | `5000` | `qq-bridge/src/mcp-napcat-safe.js:73` |
| 联网找图超时 | `9000` | `qq-bridge/src/lib/image-search.js:14` |
| Pixiv 超时 | `15000` | `qq-bridge/src/lib/pixiv.js:124` |
| Pixiv 翻页 | 默认 `3`，上限 `10` | `qq-bridge/src/lib/pixiv.js:332-333` |
| Pixiv 用户作品翻页上限 | `10` | `qq-bridge/src/lib/pixiv.js:1422` |
| `ARTIST_CACHE_MAX` | `500` | `qq-bridge/src/lib/pixiv.js:1017` |
| Pixiv 巡检间隔 | `6 * 60 * 60 * 1000` | `qq-bridge/src/core/pixiv-watch.js:24` |
| Pixiv 令牌轮换 | `50 * 60 * 1000` | `qq-bridge/src/lib/pixiv-auth.js:49` |
| `MAX_TTS_CHARS` | `2000` | `qq-bridge/src/core/voice.js:63` |
| 语音主动额度 | `maxChars 120`、`dailyChars 20000` | `qq-bridge/src/core/voice.js:90-91` |
| 语音主动概率与冷却 | `0.2` / `600000` | `qq-bridge/src/core/voice.js:97-98` |
| `VISION_TIMEOUT_MS` | `45000` | `qq-bridge/src/core/vision.js:22` |
| `VISION_MAX_RESPONSE_BYTES` | `64 * 1024` | `qq-bridge/src/core/vision.js:24` |
| `MAX_DOCX_CHARS` | `1000000` | `qq-bridge/src/core/docx.js:24` |
| 文档日额度 | `100000` | `qq-bridge/src/core/docx.js:38-39` |
| 文档上传超时 | `30000` | `qq-bridge/src/core/docx.js:116` |
| `COVER_PROBE_MAX_BYTES` | `64 * 1024` | `qq-bridge/src/core/media.js:29` |
| `RICH_DEDUPE_MS` | `60000` | `qq-bridge/src/core/media.js:334` |
| 卡片发送超时 | `45000` | `qq-bridge/src/core/media.js:399` |
| `PROBE_TIMEOUT_MS` | `9000` | `qq-bridge/src/core/video.js:25` |
| `SHARE_CODE_TTL_MS` | `10 * 60 * 1000` | `qq-bridge/src/core/video.js:507` |
| `SECAPI_BILI_TIMEOUT_MS` | `8000` | `qq-bridge/src/core/video.js:413` |
| 小程序卡片请求超时 | `12000` | `qq-bridge/src/core/video.js:1033` |
| `QZONE_IMAGE_MAX` | `3` | `qq-bridge/src/lib/qzone-image.js:45` |

### 16.5 时间、社交与集成

表 118：时间、社交与集成常量（口径：取值为源码字面值或现场配置值）。

| 常量 | 取值 | 位置 |
| --- | --- | --- |
| 定时任务重试间隔 | `60000` | `qq-bridge/src/core/scheduler.js` |
| 定时任务重试上限 | `3` | 同上 |
| 活跃时段巡检 | `60000` | `qq-bridge/src/core/activity.js` |
| 活跃时段触发延迟 | 窗口起点后 2 分钟 | 同上 |
| `MEME_DEFAULT_PROBABILITY` | `0.3` | `qq-bridge/src/core/send-dice.js:40` |
| `MEME_DEFAULT_COOLDOWN_MS` | `3 * 60 * 1000` | `qq-bridge/src/core/send-dice.js:41` |
| 跨会话留言保留 | 10 条 | `qq-bridge/src/core/crosschat.js` |
| 跨会话正文截断 | `400` | 同上 |
| 跨会话唤醒注入 | 2 条 / 每行 `170` | `qq-bridge/src/core/crosschat.js:102` |
| `SEQ_RESET_GAP` | `100` | `qq-bridge/src/dsh-client.js:30` |
| 令牌缓存 | 55 秒 | `qq-bridge/src/dsh-client.js:200` |
| 会话归档参数 | `intervalMs 600000`、`idleMinutes 30`、`batchMax 20` | `qq-bridge/src/core/session-archive.js:27-33` |
| DSH 调用超时 | `create 30000`、`prompt 30000`、`cancel 10000`、`attachment 60000`、`archiveSession 15000`、`host.describe 15000` | `qq-bridge/src/dsh-client.js:253-317` |
| MCP 工具调用超时 | `725000` | `qq-bridge/src/lib/dsh-side.js:295` |
| 工具结果剪枝阈值 | `thresholdChars 25000`、`headChars 22800`、`tailChars 2000` | `qq-bridge/dsh/agent-presets/qq-chat/agent.cordis.yml:212-215` |
| `MIN_TOOL_RESULT_CHARS` | `300` | `qq-bridge/src/lib/dsh-compaction.js:33` |
| `SUMMARY_MAX_TOKENS` | `4096` | `qq-bridge/src/lib/dsh-compaction.js:31` |
| `MIN_THRESHOLD_RATIO` | `0.08` | `qq-bridge/src/lib/dsh-compaction.js:51` |
| `DEFAULT_THRESHOLD_RATIO` | `0.16` | `qq-bridge/src/lib/dsh-compaction.js:54` |
| `dshCompaction.toolResultMaxChars` | 现场 `8192` | `qq-bridge/config.json` |
| 管理端端口 | `1921` | `server/index.js:9605-9607` |
| 桥控制台端口 | 现场 `3100` | `qq-bridge/config.json` |
| 隔离 DSH 地址 | 现场 `http://127.0.0.1:10721` | `qq-bridge/config.json` |
| 隧道映射 | `6099→13000`、`3000→13001`、`3080→13080`、`3100→13100` | `server/index.js:189-197` |
| 自动连接延迟 | `1500` 毫秒 | `server/index.js:9621` |
| 守卫复查间隔 | `60000` | `server/index.js:9651` |
| 退出守卫轮询与宽限 | `2000` / `30000` | `server/napcat-guardian.mjs` |
| 窗口隐藏器参数 | `budgetMs 43200000`、`pollMs 200`、`burstMs 50`、`burstWindowMs 5000`、`readyTimeoutMs 2500` | `server/index.js:1336` |
| 部署流式超时 | `1800000` | `server/deploy.js:99` |
| 服务就绪等待 | `waitServerMs 150000`、`pollMs 4000` | `server/index.js:402-441` |

### 16.6 计量与裁剪

表 119：计量与裁剪常量（口径：取值为源码字面值或状态文件实测值）。

| 常量 | 取值 | 位置 |
| --- | --- | --- |
| 用量日志行数上限 | `MAX_LINES = 50000`、`PRUNE_TO_LINES = 45000` | `qq-bridge/src/core/token-meter.js:60-61` |
| 用量字段采集深度 | `MAX_DEPTH = 6`、`MAX_ARRAY_ITEMS = 200` | `qq-bridge/src/core/token-meter.js:62-63` |
| 估算比例 | `1.8` / `2.2` | `qq-bridge/src/core/token-meter.js:64-65` |
| 帧签名保留 | `REAL_SIG_KEEP_MS = 86400000`、`REAL_SIG_MAX_PER_SESSION = 64` | `qq-bridge/src/core/token-meter.js:68-69` |
| 累积上限与空闲刷新 | `ACC_CHARS_CAP = 5000000`、`ACC_IDLE_FLUSH_MS = 90000` | `qq-bridge/src/core/token-meter.js:66-67` |
| 对账配额与回溯 | `quotaPerRun = 200`、最长 6 小时 | `qq-bridge/src/core/token-meter.js:916/70` |
| 日界偏移 | `480` 分钟 | `qq-bridge/src/core/token-meter.js:74-75` |
| 费用单价 | `pHit 0.02`、`pMiss 1`、`pOut 4`、`peakMult 2` | `qq-bridge/src/core/token-report.js:19-25` |
| 高峰时段 | `[9,10,11,14,15,16,17]` | `qq-bridge/config.json` |
| 剪枝计量版本与节奏 | `STATE_VERSION = 3`、`scanTtlMs = 30000` | `qq-bridge/src/core/context-savings.js:37/49` |
| 工具描述总量 | `95595` 字符 / 91 条 | `qq-bridge/state/tool-schema-stats.json` |
| 每步约 token | `31675` | 同上 |
| 工具日志上限 | `2000` 行（`qq-bridge/src/core/audit.js:104`） | — |
| 反馈日志上限 | `500` 条（`qq-bridge/src/core/audit.js:58`） | — |
| 桥日志保留 | `2000` 行 | `qq-bridge/src/lib/log.js:15` |

---

## 附录 A MCP 工具全表（napcat，91 条）

本附录界定 QQ 侧 napcat MCP 服务注册的全部工具：工具名、必填与可选参数、最低保留档位，以及由工具描述语义转写的功能表述。数据取自 MCP 协议 `tools/list` 的实取结果，导出与复现方法见本附录末节 A.1【已核验】。

表 A-1 至表 A-16 的列口径一致，说明如下。

1. `工具名`：MCP 服务注册的裸名，不含 `mcp__napcat__` 前缀。
2. `必填参数`与`可选参数`：取自工具输入 schema；参数名以反引号包裹，多项之间以逗号分隔；无参数记 `—`。
3. `最低保留档位`：该工具仍被注册的最低档位。档位按裁剪强度由强到弱为 `extreme`（极限）、`high`（高）、`medium`（中）、`low`（低）、`off`（不裁剪）。取值 `high` 表示该工具在 `high`、`medium`、`low`、`off` 四档下均注册；取值 `off` 表示仅在不裁剪档下注册；`qq_status` 为自检通道，在任何档位下恒注册【已核验】。
4. `功能（正式表述）`：由工具描述语义转写的书面语，括注与示例从略。

本附录共九十一行数据，按功能分为十六组，分组顺序与下表顺序一致。

### A.G1 状态、时间与运行时信息（5 条）

表 A-1：状态、时间与运行时信息（5 条；`get_time` 为不带 `qq_` 前缀的裸名）。

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能（正式表述） |
| --- | --- | --- | --- | --- |
| `qq_status` | — | — | `extreme` | 读取机器人登录状态与账号信息，用于自检与故障判定。 |
| `get_time` | — | — | `extreme` | 读取北京时间当前日期与时刻，精确到分钟。 |
| `qq_get_prompt` | — | `key`，`token` | `extreme` | 读取当前默认模式提示词，含角色、推荐取值与可用工具清单。 |
| `qq_social_state` | — | `key`，`token` | `extreme` | 读取会话模拟状态：唤醒配置、未读计数、最近唤醒原因与消息时刻。 |
| `qq_global_overview` | — | `token` | `high` | 汇总全部会话活动概况：未读数、最新消息、最近发言时刻与唤醒模式。 |

### A.G2 群组与会话（4 条）

表 A-2：群组与会话（4 条）。

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能（正式表述） |
| --- | --- | --- | --- | --- |
| `qq_list_groups` | — | — | `extreme` | 列出机器人已加入的全部 QQ 群，返回群号与群名。 |
| `qq_get_group_members` | — | `key`，`token`，`groupId` | `medium` | 列出指定群的全部成员，返回 QQ 号、昵称、群名片与群内角色。 |
| `qq_get_group_owner` | — | `key`，`token`，`groupId` | `medium` | 返回指定群的群主与管理员，含 QQ 号与昵称或群名片。 |
| `qq_get_active_members` | — | `key`，`token`，`limit` | `high` | 列出当前会话的近期活跃成员，用于判断会话参与者身份。 |

### A.G3 消息发送（7 条）

表 A-3：消息发送（7 条）。

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能（正式表述） |
| --- | --- | --- | --- | --- |
| `qq_send_message` | — | `key`，`token`，`messages`，`message`，`images`，`replyToMessageId`，`atUserId`，`gapMode`，`gapMs`，`gaps`，`crossSession` | `extreme` | 向目标会话发送单条或多条文本消息，可附带图片与引用。 |
| `qq_reply` | `replyToMessageId`，`message` | `key`，`groupId`，`token`，`crossSession` | `extreme` | 引用指定历史消息进行回复，用于针对具体消息作答。 |
| `qq_send_group_message` | `groupId`，`message` | `replyToMessageId`，`token` | `low` | 向指定群发送一条纯文本消息，可按消息编号附加引用。 |
| `qq_send_private_message` | `userId`，`message` | `replyToMessageId`，`token` | `low` | 向指定好友发送私聊文本消息，可按消息编号附加引用。 |
| `qq_proactive_send` | `targetKey`，`message` | `key`，`token` | `medium` | 在无人发言时主动向目标会话发送消息，或跨会话转达内容。 |
| `qq_withdraw_message` | `messageId` | `key`，`token` | `medium` | 撤回机器人自身已发送的消息，仅限本人消息。 |
| `qq_send_poke` | — | `key`，`token`，`targetUserId` | `high` | 发送 QQ 拍一拍，用于提醒对方或回应他人的拍一拍。 |

### A.G4 消息读取与历史（8 条）

表 A-4：消息读取与历史（8 条）。

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能（正式表述） |
| --- | --- | --- | --- | --- |
| `qq_get_unread_messages` | — | `key`，`token`，`limit` | `extreme` | 读取指定会话的未读消息，不改变其未读标记。 |
| `qq_get_recent_messages` | — | `key`，`token`，`limit`，`offset` | `high` | 读取指定会话的内存近期消息窗口，含撤回与媒体标记。 |
| `qq_get_my_recent_messages` | — | `key`，`token`，`limit` | `low` | 读取机器人自身近期发言，用于避免重复与维持表达一致。 |
| `qq_get_message_detail` | `messageId` | `key`，`token` | `high` | 按消息标识读取单条消息的完整内容、发送者与引用关系。 |
| `qq_get_group_history` | `groupId` | `messageSeq` | `high` | 读取指定群的近期消息历史，可按消息序号向前翻页。 |
| `qq_get_forward_msg` | `id` | `key`，`token` | `low` | 读取合并转发消息记录，返回各条正文与媒体元数据。 |
| `qq_history_delete` | `confirm` | `key`，`token`，`ids`，`query`，`sender`，`date` | `off` | 按标识列表或会话条件删除聊天记录，操作不可撤销。 |
| `qq_history_clear` | `confirm` | `key`，`token` | `off` | 清空全部或指定会话的聊天记录，操作不可撤销。 |

### A.G5 唤醒、收尾与等待（3 条）

表 A-5：唤醒、收尾与等待（3 条）。

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能（正式表述） |
| --- | --- | --- | --- | --- |
| `qq_set_wake_config` | `config` | `key`，`token` | `high` | 配置当前会话的唤醒模式与触发条件，含提及、关键词与指定发言人。 |
| `qq_mark_read` | — | `key`，`token` | `extreme` | 将会话内未读消息标记为已读，用于结束本轮而不回复。 |
| `qq_wait_for_messages` | — | `key`，`token`，`timeoutMs`，`minNewMessages`，`quietMs` | `high` | 在当前回合内等待新消息到达，可设置超时与静默窗口。 |

### A.G6 记忆与群内用语（8 条）

表 A-6：记忆与群内用语（8 条）。

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能（正式表述） |
| --- | --- | --- | --- | --- |
| `qq_memory_search` | — | `key`，`token`，`query`，`sender`，`date`，`direction`，`limit`，`offset` | `high` | 在持久化聊天记录中检索消息，可按会话、关键词、发送者与日期过滤。 |
| `qq_memory_remember` | `content` | `token`，`key`，`tier`，`category`，`pin`，`tags`，`scope` | `high` | 写入一条长期记忆条目，使其在上下文轮换后仍然保留。 |
| `qq_memory_query` | — | `key`，`token`，`category` | `high` | 读取当前会话的轻量记忆：进行中话题、待说内容与成员印象。 |
| `qq_memory_append` | `category`，`content` | `key`，`token`，`extra` | `off` | 写入轻量记忆，涵盖进行中话题、待说内容与群成员印象三类。 |
| `qq_memory_remove` | `category` | `key`，`token`，`content`，`target` | `off` | 删除单条轻量记忆，按原文或成员标识定位目标条目。 |
| `qq_memory_clear` | — | `key`，`token`，`category` | `off` | 清空轻量记忆，可指定单个类别或全部类别。 |
| `qq_slang_query` | — | `key`，`token`，`q` | `medium` | 查询已确认的群内用语与网络表达，返回条目与格式化词表。 |
| `qq_slang_submit` | `content` | `key`，`token`，`context` | `low` | 提交未收录的群内用语，进入候选池等待管理员确认。 |

### A.G7 人设与角色（8 条）

表 A-7：人设与角色（8 条）。

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能（正式表述） |
| --- | --- | --- | --- | --- |
| `qq_persona_learn_start` | — | `targetQQ`，`days` | `off` | 按目标 QQ 号的历史聊天记录启动人设学习，每个目标一个会话。 |
| `qq_persona_learn_stop` | — | `targetQQ` | `off` | 终止目标账号正在进行的人设学习任务。 |
| `qq_persona_learn_status` | — | — | `off` | 读取人设学习任务的运行状态与已生成档案。 |
| `qq_character_list` | — | `limit`，`character` | `off` | 列出本地角色库中的角色包，含文件数、体积与修改时间。 |
| `qq_character_read` | `character` | `file`，`maxBytes` | `off` | 读取角色包内的单个文件，未指定时返回该包的核心提示词。 |
| `qq_character_pack` | `character` | `maxBytes` | `off` | 一次性返回整个角色包的核心文档拼接结果。 |
| `qq_character_search` | `query` | `limit` | `off` | 在本地角色库中检索关键词，返回命中文件与行片段。 |
| `qq_character_switch` | `character` | `key`，`token` | `low` | 将当前人设切换为角色库中的指定角色，仅所有者可调用。 |

### A.G8 档案、关系与权限（7 条）

表 A-8：档案、关系与权限（7 条）。

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能（正式表述） |
| --- | --- | --- | --- | --- |
| `qq_profile_get` | `uid` | `token` | `high` | 按 QQ 号读取长期档案，含昵称、性格、偏好与备注。 |
| `qq_profile_set` | `uid`，`field`，`value` | `token` | `high` | 写入或更新指定 QQ 号长期档案中的单个字段。 |
| `qq_like` | `targetUserId` | `key`，`token`，`times` | `low` | 为指定 QQ 号的名片页点赞，次数可设且上限为十次。 |
| `qq_blacklist` | `uid`，`action` | `key`，`token` | `low` | 将指定 QQ 号加入或移出黑名单，加入后不再接收其私聊。 |
| `qq_remove_friend` | `userId` | `key`，`token` | `off` | 删除指定好友，使其离开好友列表并失去私聊权限。 |
| `qq_admin_set` | `uid`，`action` | `key`，`token` | `low` | 授予或撤销指定 QQ 号的管理员权限，仅所有者与管理员可执行。 |
| `qq_whitelist` | `groupId`，`action` | `key`，`token` | `low` | 将指定群加入或移出会话白名单，影响消息处理范围。 |

### A.G9 图片、表情与表情包（13 条）

表 A-9：图片、表情与表情包（13 条）。

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能（正式表述） |
| --- | --- | --- | --- | --- |
| `qq_get_message_images` | `messageId` | `key`，`token` | `high` | 读取指定消息内的图片与表情，作为视觉模型可用的图像内容。 |
| `qq_send_image` | — | `key`，`token`，`file`，`messageId`，`imageIndex`，`query`，`imageUrl`，`index`，`replyToMessageId`，`crossSession` | `low` | 向会话发送真实图片，来源可为本地文件、历史消息或网络检索。 |
| `qq_get_self_image` | — | `key`，`token` | `off` | 读取机器人账号自身的默认头像图像，供视觉上下文使用。 |
| `qq_list_stickers` | — | `key`，`token`，`query`，`count`，`refresh` | `high` | 列出账号已收藏的自定义表情，含标识、官方描述、备注与使用次数。 |
| `qq_get_sticker_image` | `stickerId` | `key`，`token` | `off` | 读取已收藏表情的图像内容，供视觉模型查看。 |
| `qq_send_sticker` | `stickerId` | `key`，`token`，`replyToMessageId`，`atUserId` | `high` | 在会话中发送一枚已收藏的自定义表情。 |
| `qq_collect_sticker` | `messageId` | `key`，`token`，`remark` | `high` | 将他人发送的表情收纳进账号收藏，可附加简短备注。 |
| `qq_sticker_note` | `stickerId` | `key`，`token`，`note`，`tags`，`usage` | `off` | 记录收藏表情的本地备注、标签与用途，不改变官方描述。 |
| `qq_set_sticker_remark` | `stickerId`，`remark` | `key`，`token` | `off` | 设置收藏表情的官方备注，需管理员开启对应开关。 |
| `qq_meme_search` | `query` | `tag`，`pack`，`limit` | `high` | 在随附表情包图库中按情绪或内容描述检索可用素材。 |
| `qq_send_meme` | — | `key`，`token`，`file`，`fileName`，`query`，`tag`，`pack`，`replyToMessageId`，`crossSession` | `high` | 从表情包图库中发送一枚表情包，可按文件名或描述选取。 |
| `qq_face_list` | — | `key`，`token` | `high` | 查询 QQ 内置表情的名称与编号对照表，含动态大表情。 |
| `qq_send_qq_face` | — | `key`，`token`，`faceId`，`name`，`replyToMessageId`，`atUserId` | `medium` | 发送一枚 QQ 内置表情，可指定编号或名称。 |

### A.G10 语音、文件与文档（4 条）

表 A-10：语音、文件与文档（4 条）。

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能（正式表述） |
| --- | --- | --- | --- | --- |
| `qq_send_voice` | `text` | `key`，`token`，`voice`，`style`，`mode`，`description`，`replyToMessageId` | `high` | 将文本合成为语音并以语音消息形式发送到会话。 |
| `qq_transcribe_voice` | `messageId` | `key`，`token` | `medium` | 将他人发送的语音消息转写为文本。 |
| `qq_get_file_content` | `messageId` | `key`，`token`，`fileIndex` | `high` | 读取指定消息所附文件的内容，支持文本类与 Word 文档格式。 |
| `qq_send_docx` | `title`，`content` | `key`，`token`，`replyToMessageId` | `low` | 将长文本生成为 Word 文档并作为文件发送，避免正文过长。 |

### A.G11 卡片、转发与视频（4 条）

表 A-11：卡片、转发与视频（4 条）。

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能（正式表述） |
| --- | --- | --- | --- | --- |
| `qq_send_rich` | `type` | `key`，`token`，`musicType`，`musicId`，`musicUrl`，`musicStyle`，`audio`，`title`，`image`，`content`，`videoUrl`，`contactType`，`contactId`，`result`，`replyToMessageId`，`atUserId` | `low` | 发送音乐、视频或联系人等原生富媒体卡片。 |
| `qq_send_forward` | `nodes` | `key`，`token`，`replyToMessageId` | `low` | 将多条消息合并为一张转发卡片发送到会话。 |
| `qq_video_parse` | `url` | `key`，`token` | `off` | 解析单个视频链接，返回平台、标题、作者与播放量等元数据。 |
| `qq_video_search` | `query` | `key`，`token`，`limit` | `off` | 按关键词检索视频，返回编号、标题、作者与时长等信息。 |

### A.G12 网络素材检索（4 条）

表 A-12：网络素材检索（4 条）。

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能（正式表述） |
| --- | --- | --- | --- | --- |
| `qq_image_search` | `query` | `key`，`token`，`limit`，`source` | `low` | 按关键词在网络上检索图片，返回候选条目与来源。 |
| `qq_pixiv_search` | `query` | `key`，`token`，`page`，`limit`，`r18`，`tags`，`author`，`orientation`，`minWidth`，`minHeight`，`multiPage`，`excludeAi`，`illustType`，`sort`，`scanPages` | `low` | 按关键词检索插画作品，返回作品编号、作者、标签与尺寸。 |
| `qq_send_pixiv` | — | `key`，`token`，`query`，`illustId`，`authorId`，`index`，`size`，`page`，`replyToMessageId`，`tags`，`author`，`orientation`，`minWidth`，`minHeight`，`multiPage`，`excludeAi`，`illustType`，`sort`，`scanPages`，`crossSession` | `low` | 获取并发送一张插画作品，可按作品编号、作者或关键词定位。 |
| `qq_music_search` | `query` | `key`，`token`，`platform`，`limit` | `low` | 检索歌曲，返回平台、曲名、歌手、专辑与封面链接。 |

### A.G13 QQ 空间（5 条）

表 A-13：QQ 空间（5 条）。

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能（正式表述） |
| --- | --- | --- | --- | --- |
| `qq_qzone_view` | `uid` | `key`，`token`，`num` | `low` | 读取指定 QQ 号的近期空间动态，含评论标识。 |
| `qq_qzone_comment` | `hostUid`，`tid`，`content` | `key`，`token` | `low` | 对指定 QQ 号的空间动态发表一条评论，需提供动态标识。 |
| `qq_qzone_reply_comment` | `hostUid`，`tid`，`commentId`，`content` | `key`，`token`，`replyUid` | `low` | 在指定空间动态下回复某条评论，形成楼中楼对话。 |
| `qq_qzone_like` | `hostUid`，`tid` | `key`，`token`，`curKey` | `low` | 为指定空间动态点赞，点赞属于公开互动行为。 |
| `qq_send_qzone` | `content` | `key`，`token`，`file`，`imageUrl`，`imageQuery`，`pixivIllustId`，`pixivQuery`，`pixivSize`，`imageIndex`，`imageCount` | `low` | 发表一条空间动态，正文之外可选择附带一张图片。 |

### A.G14 计划与定时（3 条）

表 A-14：计划与定时（3 条）。

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能（正式表述） |
| --- | --- | --- | --- | --- |
| `qq_schedule_message` | `message` | `token`，`key`，`targetKey`，`at`，`delayMs`，`repeatMs`，`sourceKey` | `low` | 登记定时消息任务，可按绝对时刻或延时发送，支持周期重复。 |
| `qq_schedule_list` | — | `token` | `low` | 列出已登记的定时消息任务及其触发时刻。 |
| `qq_schedule_cancel` | `id` | `token` | `low` | 按任务标识取消一条定时消息任务。 |

### A.G15 跨会话通信（2 条）

表 A-15：跨会话通信（2 条）。

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能（正式表述） |
| --- | --- | --- | --- | --- |
| `qq_crosschat_send` | `toKey`，`content` | `token` | `off` | 向其它会话留下一条备注，目标在其下次唤醒时读取。 |
| `qq_crosschat_inbox` | — | `key`，`token` | `off` | 查看其它会话留给当前会话的备注。 |

### A.G16 配置与管理（6 条）

表 A-16：配置与管理（6 条）。

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能（正式表述） |
| --- | --- | --- | --- | --- |
| `qq_get_system_config` | — | `token` | `high` | 读取可调整的系统配置项，含键名、当前值、允许范围与含义。 |
| `qq_set_system_config` | `value` | `key`，`token` | `high` | 修改系统运行配置项，仅所有者与管理员在其发言会话内可执行。 |
| `qq_get_activity_hours` | — | `key`，`token` | `medium` | 读取会话活跃时段配置，并判断当前时刻是否落在其中。 |
| `qq_set_activity_hours` | `windows` | `key`，`token` | `medium` | 设置、修改或清除会话活跃时段，采用二十四小时制。 |
| `qq_deepsleep` | `enabled` | `token` | `off` | 群的全局静默总开关：开启后全部群消息仅入库而不唤醒。 |
| `qq_report_feedback` | `message` | `key`，`token`，`level` | `off` | 向控制台或管理员上报问题与需人工介入的情况。 |

### A.1 数据来源与复现方法

本节界定附录 A 与附录 B 的数据来源、导出步骤与档位判定口径，全部条目在本轮已核验【已核验】。

导出方式一，napcat 侧工具表：以 stdio 传输启动 `qq-bridge/src/mcp-napcat-safe.js`，完成 MCP `initialize` 握手后发送 `tools/list`，取每项工具的 `name` 与 `inputSchema`；`inputSchema.required` 记为必填参数，其余属性记为可选参数。结果落为 `enrich-tools.json`，字段为 `name`、`description`、`required[]`、`optional[]`、`minTier`【已核验】。该启动过程注入环境变量 `QQB_SLIM_TOOLS_OFF=1`，其语义为本次启动忽略压缩档、全部注册（`qq-bridge/src/mcp-napcat-safe.js:687-693`）；不注入该变量时，`tools/list` 返回的是本机 `config.json` 中 `social.slimTools` 所选档位的子集，得不到完整的九十一项注册表，故取全量必须关闭裁剪【已核验】。参考实现见 `qq-bridge/tests/character-tools-mcp.test.js:31-70` 的 `startServer` 与 `qq-bridge/tests/character-tools-mcp.test.js:83-89` 的调用处。

导出方式二，宿主侧工具表：在 `qq-bridge/src/mcp-host-server.js` 中定位 `server.tool(` 注册处，共五处，依次为 `qq_learning_corpus`（`qq-bridge/src/mcp-host-server.js:142-147`）、`qq_learning_submit`（`qq-bridge/src/mcp-host-server.js:198-210`）、`napcat_status`（`qq-bridge/src/mcp-host-server.js:247-250`）、`start_napcat`（`qq-bridge/src/mcp-host-server.js:264-267`）、`stop_napcat`（`qq-bridge/src/mcp-host-server.js:314-317`）；宿主服务的 MCP 服务名与版本在 `qq-bridge/src/mcp-host-server.js:140` 给出【已核验】。必填参数取 zod 参数表中不带 `.optional()` 的字段，可选参数取其余字段。

档位判定：`minTier` 由 `qq-bridge/src/lib/tool-tiers.js` 的 `toolAllowedByTier`（`qq-bridge/src/lib/tool-tiers.js:192-200`）逐档试算得到。判定顺序取裁剪强度由强到弱，即 `extreme`、`high`、`medium`、`low`、`off`，首个判定为真的档位即该工具的 `minTier`；`qq_status` 在该函数首行恒真（`qq-bridge/src/lib/tool-tiers.js:193`），故其 `minTier` 恒为 `extreme`。各档位名单与语义定义见 `TOOL_TIERS`（`qq-bridge/src/lib/tool-tiers.js:103-151`）；档位名到中文标签的对应为 `extreme` 极限、`high` 高、`medium` 中、`low` 低、`off` 不裁剪【已核验】。

复现步骤以三条命令等价描述。

```bash
cd "C:\Users\17367\Desktop\MoonBot Public\qq-bridge"
node tests/character-tools-mcp.test.js
```

```js
const srv = startServer('src/mcp-napcat-safe.js', 20000, { QQB_SLIM_TOOLS_OFF: '1' });
await srv.init();
const list = await srv.rpc('tools/list', {});
```

```bash
Select-String -Path 'qq-bridge\src\mcp-host-server.js' -Pattern 'server\.tool\(' -Encoding UTF8
```

第一条命令验证 napcat 侧全量注册表可取；第二条给出取表的最小调用序列（`startServer` 定义见上引测试文件）；第三条列出宿主侧五处注册位置。三段均在本轮实际执行或与实测结果一致【已核验】。

---

## 附录 B MCP 宿主服务工具表（5 条）

本附录界定宿主服务 MCP 工具：由 `qq-bridge/src/mcp-host-server.js` 注册，进程名为 `napcat-host`，与 napcat 工具分属两个 MCP 服务组。宿主工具不参与工具裁剪档，故`最低保留档位`一列一律记 `—`【已核验】。

表 B-1：MCP 宿主服务工具（5 条；按源码注册顺序排列；`最低保留档位`不适用，记 `—`；`start_napcat` 与 `stop_napcat` 仅当 `napcat.allowProcessControl` 开启时注册【已核验】）。

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能（正式表述） |
| --- | --- | --- | --- | --- |
| `qq_learning_corpus` | — | `sinceMs`，`untilMs`，`limit`，`convKeys`，`targetUid` | — | 在学习任务中读取本地聊天库的文本语料，用于用语提取与人设分析。 |
| `qq_learning_submit` | `uid`，`payload`，`token` | `samples` | — | 将学习结果对象回交桥进程落库，避免大段 JSON 留在会话中。 |
| `napcat_status` | — | — | — | 探测 NapCat 网关是否可达并返回 QQ 在线状态与账号信息。 |
| `start_napcat` | — | — | — | 启动 NapCat 并等待网关就绪，最长等待九十秒。 |
| `stop_napcat` | — | — | — | 停止 NapCat 进程，会断开当前 QQ 连接。 |
---

## 附录 C 管理端路由表（93 条）

本附录列出 `server/index.js` 中全部 `app.<method>('<path>')` 注册。口径：排除整行注释后以正则 `app\.(get|post|put|delete|patch)\(\s*'` 抽取，行号为本轮读取值；`GET /api/connect` 在工作区中注册两次（`:2959` 与 `:8025`），两条均计入。

### C.1 本机实例与配置（20 条）

表 120：本机实例与配置路由。

| 行号 | 方法 | 路径 |
| --- | --- | --- |
| 2909 | GET | `/api/napcat/launchers` |
| 2936 | POST | `/api/napcat/install-qq` |
| 2951 | GET | `/api/config` |
| 2959 | GET | `/api/connect` |
| 2965 | POST | `/api/config` |
| 3004 | GET | `/api/state` |
| 3102 | GET | `/api/open` |
| 3210 | POST | `/api/instance/:id/:action` |
| 3244 | POST | `/api/instance/start-all` |
| 3283 | GET | `/api/instance/:id/logs` |
| 7948 | GET | `/api/napcat/tokens` |
| 7957 | POST | `/api/napcat/tokens` |
| 8025 | GET | `/api/connect` |
| 8046 | GET | `/api/napcat/webui-ready` |
| 8123 | GET | `/api/napcat/guard` |
| 8124 | POST | `/api/napcat/guard` |
| 8125 | POST | `/api/napcat/guard/heal` |
| 8126 | POST | `/api/napcat/quick-password` |
| 8131 | GET | `/api/napcat/qr` |
| 8495 | GET | `/api/napcat/login-stream` |

### C.2 桥数据代理（24 条）

表 121：桥数据代理路由。

| 行号 | 方法 | 路径 |
| --- | --- | --- |
| 4673 | GET | `/api/bridge/tool-schema-stats` |
| 4771 | GET | `/api/bridge/context-overhead` |
| 4780 | GET | `/api/bridge/memory-stats` |
| 4821 | GET | `/api/bridge/config` |
| 4889 | GET | `/api/bridge/activity-hours` |
| 4924 | GET | `/api/bridge/activity-targets` |
| 5191 | GET | `/api/bridge/chat-stats` |
| 5216 | GET | `/api/bridge/chat-stream` |
| 5300 | GET | `/api/bridge/chat-convs` |
| 5333 | GET | `/api/bridge/chat-messages` |
| 5373 | POST | `/api/bridge/chat-delete` |
| 5408 | POST | `/api/bridge/activity-hours` |
| 5546 | POST | `/api/bridge/config` |
| 5780 | POST | `/api/bridge/speech-reset` |
| 5881 | GET | `/api/bridge/characters` |
| 5901 | POST | `/api/bridge/characters/import` |
| 5935 | POST | `/api/bridge/upload` |
| 5958 | POST | `/api/bridge/stickers/upload` |
| 6264 | GET | `/api/bridge/meme-packs` |
| 6299 | POST | `/api/bridge/meme-packs/upload` |
| 6435 | POST | `/api/bridge/meme-packs/delete` |
| 6475 | POST | `/api/bridge/meme-packs/bind` |
| 7978 | GET | `/api/bridge/owner-qq` |
| 7999 | POST | `/api/bridge/owner-qq` |

### C.3 远端 SSH（13 条）

表 122：远端 SSH 路由。

| 行号 | 方法 | 路径 |
| --- | --- | --- |
| 3434 | POST | `/api/ssh/test` |
| 3487 | POST | `/api/ssh/connect` |
| 3523 | POST | `/api/ssh/disconnect` |
| 3843 | POST | `/api/ssh/sync` |
| 4209 | POST | `/api/ssh/remove-stack` |
| 4260 | POST | `/api/ssh/stack` |
| 4327 | POST | `/api/ssh/service` |
| 7110 | GET | `/api/ssh/bridge-config` |
| 7130 | POST | `/api/ssh/bridge-config` |
| 7262 | GET | `/api/ssh/status` |
| 9532 | POST | `/api/ssh/deploy/start` |
| 9564 | GET | `/api/ssh/deploy/status` |
| 9571 | GET | `/api/ssh/deploy/tasks` |

### C.4 学习与画像（20 条）

表 123：学习与画像路由。

| 行号 | 方法 | 路径 |
| --- | --- | --- |
| 7598 | GET | `/api/learning/config` |
| 7599 | POST | `/api/learning/config` |
| 7600 | POST | `/api/learning/slang` |
| 7601 | POST | `/api/learning/persona` |
| 7602 | POST | `/api/learning/portrait` |
| 7650 | POST | `/api/learning/persona-apply` |
| 8315 | GET | `/api/learning/token-report` |
| 8397 | POST | `/api/learning/token-reconcile` |
| 8437 | GET | `/api/learning/slang-library` |
| 8441 | GET | `/api/learning/token-stream` |
| 8769 | GET | `/api/learning/profile` |
| 8933 | GET | `/api/learning/graph` |
| 9052 | GET | `/api/learning/owner-profile` |
| 9101 | GET | `/api/learning/messages` |
| 9136 | GET | `/api/learning/portrait-config` |
| 9137 | PUT | `/api/learning/portrait-config` |
| 9147 | GET | `/api/learning/groups` |
| 9184 | GET | `/api/learning/relations` |
| 9185 | PUT | `/api/learning/relations` |
| 9431 | POST | `/api/learning/relations/auto` |

### C.5 黑话、语音、方案档案、守卫与退出（16 条）

表 124：其余路由。

| 行号 | 方法 | 路径 | 分组 |
| --- | --- | --- | --- |
| 7644 | POST | `/api/slang/batch-confirm` | 黑话 |
| 7646 | POST | `/api/slang/batch-delete` | 黑话 |
| 7647 | POST | `/api/slang/batch-reject` | 黑话 |
| 7648 | POST | `/api/slang/research` | 黑话 |
| 7629 | GET | `/api/voice/config` | 语音 |
| 7630 | PUT | `/api/voice/config` | 语音 |
| 7631 | GET | `/api/voice/voices` | 语音 |
| 7632 | POST | `/api/voice/voices` | 语音 |
| 7633 | DELETE | `/api/voice/voices` | 语音 |
| 7639 | POST | `/api/voice/preview` | 语音 |
| 7640 | POST | `/api/voice/test` | 语音 |
| 5735 | GET | `/api/profiles` | 方案档案 |
| 5740 | POST | `/api/profiles` | 方案档案 |
| 5767 | POST | `/api/profiles/:id/delete` | 方案档案 |
| 10016 | POST | `/api/guardian/arm` | 守卫与退出 |
| 10040 | POST | `/api/shutdown` | 守卫与退出 |

---

## 附录 D 证据等级与未核验清单

### D.1 核验范围

本轮核验以只读方式执行，覆盖范围如下。

表 125：本轮核验范围（口径：核验方式为读取源码文本与只读查询本机状态文件）。

| 范围 | 核验方式 | 结果 |
| --- | --- | --- |
| `qq-bridge/src/**` 全部模块 | 逐条比对函数名、常量取值与行号 | 详见各章 `【已核验】` 标注 |
| `server/**`、`src/**` | 路由抽取、字节与行数统计 | 附录 C 与 §13.2 |
| `qq-bridge/config.json` | 只读解析全部键值 | §5.3、§13.5、§16 |
| `qq-bridge/state/*.db` | 以只读连接查询表结构、行数与元表 | §6.1 |
| `qq-bridge/state/tool-schema-stats.json` | 只读解析 | §11.8 |
| `qq-bridge/state/` 文件清单与字节数 | 目录枚举 | §14.6 |

### D.2 本轮更正项

表 126：本轮核对源码后更正的具体条目（口径：以源码为准，行号为本轮读取值）。

| 原表述 | 更正后 | 依据 |
| --- | --- | --- |
| `LINEAR_DEFAULTS` 位于 `lib/send-gaps.js` | 位于 `core/send-chain.js:108-115`；`send-gaps.js` 只有 `MIN_GAP_MS:12` 与 `clampGap:23-26` | `【已核验】` |
| 命令分支日志前缀为 `[cmd]` | 前缀为 `[command]` | `【已核验】` |
| `ALARM_RE` 位于 `lib/markers.js` | 位于 `core/mux.js:273`，判定点 `:319` | `【已核验】` |
| `handleSensitiveIntercept` 无调用点 | 调用点在 `core/audit.js:36` | `【已核验】` |
| `session-state.js` 集合数为 24 | 为 31 | `【已核验】` |
| `social.tools` 为 31 键 | 为 30 键 | `【已核验】` |
| `quarantineSession` 区间 `:56-96` | 函数体 `:56-106` | `【已核验】` |
| `[Recall]` 位于 `wake-send.js:479` | 位于 `:485`（`:479` 为 `memoryDigest` 调用） | `【已核验】` |
| `loginWatch` 位于 `bridge.js:659-667` | 位于 `:666-667` | `【已核验】` |
| `/api/status` 含 `mode` 字段 | 无该字段，只有 `roleMode` | `【已核验】` |
| 工具描述总量 `92879`、占比 `0.9214` | 现测 `totalChars 95595`、`keptChars 101360`、`share 1.0603` | `【已核验】` |
| `qq_set_system_config` 描述 `1916` 字符 | 现测 `2437` 字符 | `【已核验】` |
| `qq_send_rich` 描述 `5118` 字符 | 现测 `5721` 字符 | `【已核验】` |
| `dice(kind)` 单参签名 | `dice(kind, key, probability, cooldownMs)` | `【已核验】` |
| `saveDocxQuota` 位于 `docx.js:51` | 声明于 `:46` | `【已核验】` |
| `sendRichOnce` 位于 `media.js:399` | 声明于 `:357` | `【已核验】` |
| `pickImage` 位于 `media.js:603-621` | 声明于 `:575` | `【已核验】` |
| `PIXIV_USER_WORK_PAGES` | 常量名为 `PIXIV_USER_WORKS_MAX_PAGES`，值 10 | `【已核验】` |
| 语音提示行位于 `voice.js:985` | 位于 `:1000`、`:1006`、`:1009` | `【已核验】` |
| `memoryDigest` 位于 `memory.js:703-731` | 声明于 `:690`，`:703-731` 为函数体 | `【已核验】` |
| `appendMemory` 位于 `:479-498` | 声明于 `:433` | `【已核验】` |
| `formatMemory` 位于 `:420-429` | 声明于 `:386` | `【已核验】` |
| `formatProfileText` 位于 `:292` | 声明于 `:287` | `【已核验】` |
| `savePersonaLibrary` 位于 `persona-learn.js:526-548` | 声明于 `:109` | `【已核验】` |
| `PERSONA_BACKUP_KEEP` 位于 `:851-855` | 声明于 `:48` | `【已核验】` |
| `warmGroupName` 位于 `group-cache.js:22-35` | 声明于 `:49-70` | `【已核验】` |
| 合成段标记位于 `preset-compose.js:33-59` | 常量声明于 `:19-20` | `【已核验】` |
| `publicSlangEntry` 位于 `slang-learner.js` | 位于 `core/slang.js:371` | `【已核验】` |
| `qq_send_rich` 注册于 `mcp-napcat-safe.js:3024` | `registerTool(` 于 `:3018`，名字于 `:3019` | `【已核验】` |
| `session-archive` 定时器区间 `:405-414` | `startSessionArchiveTicker` 为 `:394-410` | `【已核验】` |
| `resolveDshTarget` 区间 `:57-88` | 函数体 `:57-74`，`:77-87` 为 `readManagerIsolatedHome` | `【已核验】` |
| 工具行格式说明位于 `token-meter.js:58` | `:58` 为 `TOKEN_USAGE_FILE`；行格式说明在文件头 `:3-8`，写入实现 `:413-426` | `【已核验】` |
| 日界偏移位于 `token-report.js` | 位于 `token-meter.js:74-75` 与 `context-savings.js:31-32` | `【已核验】` |
| 内建表情包目录位于 `qq-bridge/meme-full/` | 该目录不存在；三份副本均位于 `.runtime/` 下，未安装在扫描根内 | `【已核验】` |
| `workspaceTitle` 现场值 | 现场值为 `QQ 聊天` | `【已核验】` |
| `social.send` 现场值 | `maxMessageChars 1000`、`burstMaxMessages 10`、`maxSendPerMinute 15`、`maxSendPerHour 600`、`longGapMaxMs 20000`、`linearCapMs 1500`、`linearResetMs 20000` | `【已核验】` |
| 桥控制台代理默认超时归 `proxyToBridgeConsole` | 函数定义于 `server/index.js:7382`；默认值 30000 位于 `:7315` 的 `callBridgeConsole` | `【已核验】` |
| 桥侧配置写入段以路由行标注 | 路由注册行为 `server/index.js:5546`；`:5571-5594` 为该处理函数内的深合并与原子写段 | `【已核验】` |
| 卸载栈端点标注为 `:4226` | 路由注册行为 `:4209`，`:4226` 为该处理函数内的一条目录移动命令 | `【已核验】` |
| `runDeploy` 执行段至 `:1613` | 执行段为 `:1075-1601`，异常与收尾段为 `:1602-1625` | `【已核验】` |
| 现场配置含 `napcat.imageFileMode`、`napcat.tmpDir`、`slimTools.schemaLevel`、`toolCompressor` | 现场 `qq-bridge/config.json` 的 `napcat` 段只有 7 键，不含前两项；`social` 段不含 `slimTools.schemaLevel`，也不含 `toolCompressor` 键；四者均只出现在 `qq-bridge/config.example.json` | `【已核验】` |
| 管理端路由计数的补充口径 | 带引号路径的路由为 93 条；`app.get` 正则末位匹配路由 1 条、`app.use` 3 条不计入 | `【已核验】` |

### D.3 已确认缺陷

表 127：已复现的缺陷（口径：复现方式为只读执行同一条 SQL）。

| 编号 | 缺陷 | 位置 | 复现结果 |
| --- | --- | --- | --- |
| D-1 | 人格学习取样使用记忆库连接查询聊天记录表 | `qq-bridge/src/core/persona-learn.js:223/238/243` | `no such table: chat_messages`，样本恒为 0 |
| D-2 | 群友画像筛选使用记忆库连接查询聊天记录表 | `qq-bridge/src/core/portrait-learn.js:84/88-100` | `no such table: chat_messages`，筛选恒失败并进入 30 分钟退避 |
| D-3 | 进程控制闸门判定输入缺失 | `qq-bridge/src/mcp-host-server.js:73-86` 依赖的 `mode` 字段不存在于 `qq-bridge/src/core/console-server.js:768-780` | 闸门恒为 false，进程控制工具不可用 |

### D.4 未核验清单

表 128：未核验项汇总（口径：均为推断或未复现，不得作为事实引用）。

| 编号 | 未核验项 | 所属章 |
| --- | --- | --- |
| U-1 | `state/memory.db.pre-v13-backup` 的产出者 | §6.14 |
| U-2 | `chat_messages.ts` 两种文本格式的成因 | §6.14 |
| U-3 | 人设库与学习会话 id 的实际落盘位置（`state/persona-library.json`、`persona-agent.json` 不存在） | §6.14 |
| U-4 | 会话归档缓存的落盘位置（`state/session-archive.json` 不存在） | §12.8 |
| U-5 | `sessions.rename` 的调用点 | §12.10 |
| U-6 | `workspace/list` 本地构造返回值与真实端点的差异 | §12.10 |
| U-7 | 隔离 home 下同哈希预设目录的生成代码 | §12.10 |
| U-8 | 仓库与安装副本预设文件在剥离合成段后的差异 | §12.10、§14.8 |
| U-9 | 自启动项在仓库之外的实现位置（仓库内命中数为 0） | §14.8 |
| U-10 | 仓库根 `scripts/` 为空的原因 | §14.8 |
| U-11 | `qq-bridge/music-sign-proxy.py` 在当前部署下是否随桥启动 | §14.8 |
| U-12 | 内置表情包缺包时的完整返回文案 | §8.16 |
| U-13 | 封面转存图床功能开启后的行为 | §8.16 |
| U-14 | 视频卡片在小程序侧的渲染结果 | §8.16 |
| U-15 | 管理端部分端点的请求与响应字段完整性 | §13.8 |
| U-16 | 敏感判定的误报与漏报比例 | §15.8 |
| U-17 | 私有网段判定的运行期拦截行为 | §15.8 |
| U-18 | 运行时实际注册的工具条数（受档位门与配置开关影响） | §11.10 |
| U-19 | 用量对账在跨日与日志清理后的行为 | §11.10 |
| U-20 | 剪枝计量对非 zstd 会话日志的兼容性 | §11.10 |
| U-21 | 定时任务时刻精度与主动行为联合触发频次 | §9.9 |
| U-22 | QQ 空间接口返回字段全集与资料卡可写字段集合 | §10.7 |
| U-23 | `splitForQQ` 在 4000 字符上限下的切分点分布 | §5.9 |
| U-24 | `linearCounts` 在会话数极大时的内存占用 | §5.9 |
| U-25 | 21 个出厂角色包各自的角色设定内容与完整性 | §7.8 |
| U-26 | 表达约束的实际遵守率 | §7.8 |
| U-27 | 随包 QQ 窗口隐藏器的启动器与命令行拼装 | §13.6 |
| U-28 | `audit.js` 中 `shouldAuditKey()` 恒真之前是否存在跳过逻辑 | §5.9 |
