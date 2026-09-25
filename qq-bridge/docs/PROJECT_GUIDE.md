# DSH QQ 桥接（qq-bridge）项目说明书

本文界定 `qq-bridge` 项目的定位、体系结构、模块拓扑、数据流、配置面与安全边界。

## 目录

```text
0. 术语表与阅读约定
1. 项目定位与构成
2. 体系结构总览
3. 目录结构
4. 核心数据流
5. 内核详解
6. 配置参考
7. 安全机制
8. 启动与运行
9. 常用调试与测试脚本
10. 开发与验证
11. 未核验声明
12. 已知现象与判据
```

**证据等级**：`【已核验】` 表示读过源码或跑过命令并给出 `path:line`；`【据仓库记载】` 表示引自其它文档并给出处；
`【未核验】` 表示推断或未复现。

---

## 0. 术语表与阅读约定

本章界定全文使用的固定术语与编号约定。

表 1：术语表（口径：首次出现的概念给出“中文（English / 代码标识符）”三件套，其后固定使用该词）

| 术语 | 代码标识符 | 界定 |
| --- | --- | --- |
| 桥接层 | `src/bridge.js` | 独立 Node.js 进程，承担 QQ 消息接入、社交状态机、DSH 投递与发送链 |
| 网关 | NapCat | 提供 OneBot v11 WebSocket 与 HTTP API 的 QQ 接入程序 |
| 内核 | `src/*.js` | 桥接层仓库根 `src/` 下的模块集合 |
| 外核 | `public/`、`config.json`、`roles/`、`state/`、`*.bat`、`scripts/` | 非 `src/` 的运行配置、静态资源与脚本 |
| 仿真模式 | `reserved` / `reserved2` | 由状态机决定发言时机的运行模式；`reserved2` 为当前模式 |
| 学习会话 | learner preset 会话 | 与 QQ 会话隔离、仅用于黑话与人格学习的 DSH 会话 |
| 所有者 | `ownerQQ` | 拥有管理命令与审批权限的账号标识 |

---

## 1. 项目定位与构成

本章界定项目的功能边界。

`qq-bridge` 是独立的 Node.js 进程，承担三件事。

表 2：项目构成与通道（口径：三件事为并列关系，互为前提）

| 能力 | 通道 | 说明 |
| --- | --- | --- |
| 连接 QQ | NapCat（OneBot v11 WebSocket） | 收发 QQ 群聊与私聊消息 |
| 连接 DSH | DSH Web API（默认 `127.0.0.1:3080`） | 创建会话、投递 prompt、接收事件流 |
| 构成群友行为 | 仿真状态机 | 在仿真模式下以“观望 / 活跃 / 试探 / 退场”状态机决定发言时机、沉默时机与分条方式，并注入人格角色 |

项目的功能边界不是消息转发器：桥接层包含社交策略层，发言时机由状态机与概率参数决定，而非“收到即转发”。

---

## 2. 体系结构总览

本章界定进程与协议拓扑。

```text
┌─────────────┐   OneBot WS   ┌──────────────────────┐   HTTP/WS   ┌──────────────────┐
│  NapCat     │◄─────────────►│      qq-bridge       │◄───────────►│   DSH Harness    │
│  (QQ 网关)   │               │   src/bridge.js      │             │  (agent 会话)    │
└─────────────┘               │   src/dsh-client.js  │             └──────────────────┘
                              │   src/mcp-*.js       │
                              └──────────────────────┘
                                      │ 控制台
                                      ▼
                              public/console.html (127.0.0.1:3100)
```

表 3：分层与模块职责（口径：内核指 `src/` 下模块，外核指非 `src/` 的运行面）

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 内核 | `src/bridge.js` | 主程序：QQ 消息接入、社交状态机、DSH 投递、发送链、控制台 API、安全审计 |
| 内核 | `src/dsh-client.js` | DSH 协议客户端：RPC、WebSocket 事件流、turn 收集 |
| 内核 | `src/mcp-napcat-safe.js` | 面向 DSH agent 的 QQ 工具（只读加白名单发送） |
| 内核 | `src/mcp-host-server.js` | 面向 DSH agent 的 NapCat 进程管理（默认禁用启停） |
| 内核 | `src/slang-learner.js` | 群聊黑话与网络用语学习：存储、候选提取、研究调度、注入 |
| 内核 | `src/mcp-web-search-safe.js` | 面向 DSH agent 的只读 Web Search MCP |
| 外核 | `public/console.html` | 本地控制台：状态、参数、手动切换、重置 |
| 外核 | `config.json` | 运行配置（白名单、QQ 与 DSH 地址、社交参数）；不进入版本库 |
| 外核 | `roles/*.md` | 人格卡 |
| 外核 | `state/*` | 运行时状态（会话映射、模式、日志）；不进入版本库 |
| 外核 | `start.bat` / `restart.bat` | 守护启动与重启 |
| 外核 | `scripts/*` | 测试与辅助脚本 |

---

## 3. 目录结构

本章界定公开仓库的目录布局。

```text
qq-bridge/
├── src/
│   ├── bridge.js               # 主程序（核心）
│   ├── dsh-client.js           # DSH API 客户端
│   ├── mcp-napcat-safe.js      # 安全 MCP（QQ 读/发工具）
│   ├── mcp-host-server.js      # MCP（NapCat 进程管理，默认禁用启停）
│   ├── mcp-web-search-safe.js  # 安全 MCP（只读 Web Search/Fetch）
│   ├── slang-learner.js        # 黑话/网络用语学习模块
│   ├── md-to-plain.js          # Markdown 转纯文本
│   ├── safe-fetch.js           # 带 SSRF 防护的 HTTP(S) 抓取
│   └── self-test.js            # DSH 侧自检
├── public/
│   └── console.html            # 控制台单页（含黑话/记忆/表情管理）
├── roles/
│   ├── 傲娇助手.md             # 人格卡
│   └── _archived/              # 已停用的人格卡
├── docs/
│   ├── PROJECT_GUIDE.md        # 本文档（公开版）
│   └── DSH_SETUP.md            # DSH 端安装说明（另一台设备）
├── dsh/
│   └── agent-presets/          # qq-chat 的 DSH preset 模板
├── plugins/
│   └── qq-mode-console/        # DSH 设置页 qq-mode 卡片插件
├── assets/
│   ├── deepseek娘.png          # AI 自我形象图（qq_get_self_image）
│   └── project-intro.mp4       # 项目介绍视频
├── scripts/                    # 通用测试/辅助脚本（含 setup-dsh.mjs）
├── config.example.json         # 配置模板（占位符，不含真实凭据）
└── package.json
```

表 4：目录结构的排除项（口径：下列路径不进入公开仓库）

| 路径 | 说明 |
| --- | --- |
| `config.json` | 含真实账号与令牌的运行配置 |
| `state/` | 运行时状态与日志 |
| `node_modules/` | 依赖安装目录 |
| 本地开发、计划与调研文档 | 一次性本地记录 |
| 一次性本地脚本 | 不构成公开接口的脚本 |

桥接层的对外说明（安装、启动流程、自测、目录结构、合规提醒）自 2026-09-25 起统一并入仓库根目录的
`README.md`；`roles/` 与 `plugins/*/` 下的说明同样并入该文档，本目录不再单独维护各自的说明文件。

---

## 4. 核心数据流

本章界定消息、事件与学习三条数据流。

### 4.1 群消息与私聊消息的处理流程

```text
QQ 消息
  │
  ▼
bot.onGroupMessage / onPrivateMessage (bridge.js)
  │
  ▼
handleIncoming(kind, id, event)
  ├─ 白名单/模式检查（modeAllowed / allowed）
  ├─ 管理命令拦截（/reset /role /silent 等，仅 owner）
  ├─ 挂起审批/提问优先处理（pending）
  ├─ 社交模式分支（仿真模式）：
  │     ├─ 观望期：按触发条件决定是否进活跃
  │     ├─ 活跃期：私聊即时投递；群聊等轮询批量检测
  │     └─ 冷场/试探
  └─ 非社交模式：直接投递给 DSH
  │
  ▼
ensureSession(key)  →  DSH session（工作区“QQ 聊天”）
  │
  ▼
api.sessions.prompt({ mode: 'queue' })
  │
  ▼
DSH 事件流（api.events.mux）→ pumpMux()
  ├─ turn collector 收集模型输出
  ├─ 安全审计（SENSITIVE_RE）
  ├─ 社交模式：planSocialTimeline 分条 → sendBurstToQQ
  └─ 非社交模式：sendToQQ 直接发
```

表 5：消息段处理规则（口径：各条为独立规则，适用条件互不覆盖）

| 编号 | 输入 | 处理 |
| --- | --- | --- |
| P1 | 群聊中的 `@` 段 | 解析为群名片或昵称（带缓存）；解析失败时回退为 QQ 号 |
| P2 | 引用与回复段 | 解析为被引用人的群名片或昵称加原文，注入 prompt |
| P3 | `[SILENT]` 输出（一代仿真模式 `reserved`） | 表示不接话，桥接层静默不发送 |
| P4 | 分条方式（一代仿真模式 `reserved`） | 按空格分句：模型以空格表示下一条消息，桥接层按空格拆条。`reserved2` 不适用该规则，分条使用 `qq_send_message` 的数组参数 |

### 4.2 DSH 事件流与 turn 收集

表 6：事件流与 turn 收集机制（口径：实现位置见 `src/dsh-client.js`）

| 项 | 机制 |
| --- | --- |
| 长连接 | `readWebSocket` 保持 `events.mux` 的长连接 |
| 收集 | `createTurnCollector` 按 `assistant/message` 累加文本，在 `turn/end` 时产出完整结果 |
| 静默 turn | 摘要投喂产生的 turn 结果不发送到 QQ，只作为记忆 |

### 4.3 黑话学习与网络用语迭代

```text
群聊消息 → bridge 滚动窗口（slangWindows）
  → 攒够 extractMinMessages 条 → DSH 学习会话提取候选
  → 写入 state/slang.json（candidate，count+1，保留证据）
  → 达到 inferenceThresholds 时 → DSH 学习会话联网搜索确认
  → 生成 meaning/usage/example → 仍为 candidate
  → 控制台「黑话管理」人工确认/拒绝
  → confirmed 词条 → 注入 QQ agent 的【群聊黑话表】
```

表 7：学习流的两条约束（口径：两条约束互为补充）

| 约束 | 内容 |
| --- | --- |
| 会话隔离 | 学习会话与 QQ 会话隔离，学习输出不发送到 QQ |
| 注入条件 | 只有经人工确认的词条进入聊天上下文 |

---

## 5. 内核详解

本章界定 `bridge.js` 的模块划分、社交状态机、分条发送与 MCP 工具面。

### 5.1 `bridge.js` 模块

表 8：`bridge.js` 模块职责（口径：函数名为 `src/bridge.js` 中的顶层定义）

| 模块 | 说明 |
| --- | --- |
| `loadConfig` | 读取 `config.json`，fail-fast；提供社交参数默认值 |
| `allowed` / `modeAllowed` | 白名单与模式准入（`closed-agent` 仅所有者私聊） |
| `acquireLock` / `releaseLock` | 单实例锁（原子 `fs.openSync('wx')` 加 stale 检测） |
| `ensureSession` | 创建或复用 DSH 会话，带 `sessionEpoch` 防止 reset 竞态 |
| `social` | 社交引擎状态（states / recentMessages / pendingSummaries / silentContext / silentTurns / pendingTimers） |
| `socialLoopTick` | 每 5 秒扫描状态机：主动开话题、活跃检测、冷场、试探 |
| `buildBatchPrompt` | 活跃期投递文本（只含新消息与之前沉默的消息） |
| `planSocialTimeline` | 按空格分句拆条（模型以空格控制；单条 500 字安全上限） |
| `sendBurstToQQ` | 分条发送：随机间隔与长间隔，最后一条不 sleep |
| `pumpMux` | DSH 事件流消费：收集、审计、发送 |
| `startConsoleServer` | 本地控制台 HTTP 服务与 API |
| `flushSummaries` | 观望期未参与消息转摘要投喂（静默 turn） |

### 5.2 社交状态机

```text
        观望 idle
        │   ▲
  触发进活跃 │   │ 冷场/试探无回应 / 退场完成
        ▼   │
       active ──冷场──► probing
        │                │
        └──新消息────────┘
        │
        └──活跃超时──► exiting ──退场发言完成──► idle
```

表 9：状态定义与迁移条件（口径：参数名为 `config.json` 中的社交参数）

| 状态 | 行为 | 迁移条件 |
| --- | --- | --- |
| 观望（`idle`） | 只把消息记入 `recentMessages` 与 `pendingSummaries` | 触发条件包括被 @、命中关键词、被提问、普通消息的小概率、群长期静默后小概率主动开话题 |
| 活跃（`active`） | 每 `activeCheckMinMs~MaxMs` 检测一次新消息；私聊即时投递，群聊按批量检测 | 冷场时进入试探；活跃超时后进入退场 |
| 退场（`exiting`） | 活跃超时后的过渡状态，等待收尾发言发出 | 退场发言完成后回到观望 |
| 冷场 | `idleWindowMs` 内无新消息 | 大概率回到观望，小概率进入试探 |
| 试探（`probing`） | 主动发送一句 | `idleRetryWaitMs` 内无回应则回到观望 |

### 5.3 分条发送

`planSocialTimeline(text, cfg)` 返回 `{ main: string[], followUp: null }`。

表 10：分条发送规则（口径：分句权在模型侧，桥接层只做安全拆条）

| 编号 | 规则 |
| --- | --- |
| S1 | 分句权交由模型：模型以空格表示“此处分为下一条消息” |
| S2 | 不分条时不使用空格 |
| S3 | 空格两侧任一侧为中文即视为分条信号 |
| S4 | 单条消息只做 `maxReplyChars`（默认 500 字）安全硬拆 |
| S5 | `sendBurstToQQ` 按随机间隔发送，存在使用长间隔的概率；最后一条之后不 sleep |

### 5.4 MCP 工具面

`mcp-napcat-safe.js` 向 DSH agent 暴露的工具：

表 11：QQ 工具与白名单（口径：白名单列为该工具的账号级准入规则）

| 工具 | 说明 | 白名单 |
| --- | --- | --- |
| `qq_status` | 登录状态 | 无 |
| `qq_list_groups` | 群列表 | 只返回白名单群 |
| `qq_get_group_members` | 群成员 | 群号必须属于白名单 |
| `qq_get_group_history` | 群历史 | 群号必须属于白名单 |
| `qq_send_group_message` | 发群消息；可选 `replyToMessageId` | allow 加 deny 加 allowAllWhenEmpty；纯文本段防 CQ 码 |
| `qq_reply` | 引用与回复工具 | 同上 |
| `qq_send_private_message` | 发私聊；可选 `replyToMessageId` | 同上 |

聊天角色模式（`reserved2`）追加的工具按功能分组：

表 12：`reserved2` 追加工具（口径：按功能分组，组内工具无依赖顺序）

| 分组 | 工具 |
| --- | --- |
| 状态与消息 | `qq_get_prompt`、`qq_get_unread_messages`、`qq_get_recent_messages`、`qq_get_message_detail`、`qq_get_active_members`、`qq_social_state` |
| 发送与互动 | `qq_send_message`、`qq_send_poke`、`qq_send_sticker` |
| 等待与收尾 | `qq_wait_for_messages`、`qq_mark_read`、`qq_set_wake_config` |
| 记忆、黑话与表情 | `qq_memory_*`、`qq_slang_query`、`qq_slang_submit`、`qq_list_stickers`、`qq_get_sticker_image`、`qq_sticker_note`、`qq_collect_sticker` |
| 形象 | `qq_get_self_image` |

`mcp-host-server.js`：

表 13：宿主服务工具（口径：`start_napcat` / `stop_napcat` 的启用条件为两项同时成立）

| 工具 | 说明 | 启用条件 |
| --- | --- | --- |
| `napcat_status` | 只读探活 | 无附加条件 |
| `start_napcat` / `stop_napcat` | 启停 NapCat | 默认禁用；需 `config.json` 设置 `napcat.allowProcessControl: true`，且仅在 `closed-agent` 模式下可用 |

`mcp-web-search-safe.js`：

表 14：只读联网工具（口径：两者均为只读）

| 工具 | 说明 |
| --- | --- |
| `web_search(query)` | 只读搜索 |
| `web_fetch(url)` | 只读抓取 HTTP(S) 网页正文，带内网与本机地址的 SSRF 拦截 |

---

## 6. 配置参考

本章界定 `config.json` 的字段语义。仓库不包含真实 `config.json`，配置以 `config.example.json` 为模板创建；
下表以占位符与默认值说明。

表 15：配置字段语义（口径：默认值为实现中的默认取值）

| 字段 | 说明 |
| --- | --- |
| `dsh.baseUrl` | DSH Web API，默认 `http://127.0.0.1:3080` |
| `napcat.wsUrl` / `httpUrl` | OneBot WebSocket 与 HTTP API 地址；`httpUrl` 不得填 WebSocket 端口，否则报 HTTP 426 |
| `napcat.accessToken` | OneBot 鉴权令牌，未配置时留空 |
| `napcat.launcherPath` / `homeDir` | NapCat 启动脚本与安装目录（进程管理用，默认禁用） |
| `ownerQQ` | 所有者账号（最高权限，可在控制台“白名单 / 管理员”设置） |
| `agentPreset` | 聊天模式使用的 DSH agent preset |
| `workspaceTitle` | DSH 工作区名 |
| `allow.private` / `allow.groups` | 白名单（账号与群号数组） |
| `deny.private` / `deny.groups` | 黑名单 |
| `allowAllWhenEmpty` | 白名单为空时是否放行（fail-closed，默认 false） |
| `sendDelayMs` | 非社交模式每条消息的间隔 |
| `consolePort` | 控制台端口，默认 3100 |
| `consoleToken` | 控制台鉴权令牌；留空时在启动时自动生成并保存到 `state/console-token` |
| `security.interceptNotify` | 回复被安全拦截时是否在群里发送提示 |

参数组按其所属子系统分列。

表 16：参数组划分（口径：各组参数在控制台可调或按组配置）

| 组 | 参数 |
| --- | --- |
| 社交参数 | 触发概率、活跃检测间隔、回复延迟、活跃时长、冷场窗口、试探概率、沉默概率、上下文窗口、单条长度上限、分条间隔、主动开话题参数 |
| 黑话学习 | `slang.enabled`、`extractMinMessages`、`extractCooldownMs`、`inferenceThresholds`、`injectMax`、`learnerPreset`、`workspaceTitle`、`autoResearch` |
| 聊天角色 | `socialV2.enabled`、`tools.*`、`wake.*`、`send.*`、`wait.*`、`sticker.*`、`proactive.*`、`feedback.*`、`context.*` |

---

## 7. 安全机制

本章界定安全边界与对应的实现点。

表 17：安全机制与实现要点（口径：机制列为实现要点，判据列为该机制生效的可观测条件）

| 编号 | 机制 | 实现要点 |
| --- | --- | --- |
| G1 | 白名单 | `allowed()` 统一处理 allow、deny 与 allowAllWhenEmpty；MCP 工具使用同一语义 |
| G2 | 纯文本发送 | MCP 发送使用纯文本消息段，禁止 CQ 码注入 |
| G3 | 敏感审计 | `SENSITIVE_RE` 拦截路径与凭据；agent 回复、错误文本、审批与提问理由、MCP 发送均经过该审计 |
| G4 | 管理命令 | `/` 命令仅所有者可用（`ownerQQ` 可在控制台设置） |
| G5 | 审批 | 非所有者不能通过审批；超时与覆盖会给 DSH 回执 |
| G6 | 进程控制 | `start_napcat` / `stop_napcat` 默认禁用；启用后也仅在 `closed-agent` 模式下可调用 |
| G7 | 配置 fail-closed | `config.json` 损坏时直接退出；白名单默不放行 |
| G8 | 控制台鉴权 | 可配 `consoleToken`；未配置时自动生成强令牌 |
| G9 | 只读联网 | `mcp-web-search-safe.js` 只暴露 `web_search` 与 `web_fetch`，带 SSRF 防护 |
| G10 | 黑话人工确认 | 自动提取与联网研究的黑话默认为 candidate，仅控制台确认后注入聊天上下文 |
| G11 | 日志脱敏 | 日志统一经过 `redactSensitiveText`，不记录路径与凭据等敏感原文 |
| G12 | 会话隔离 | 每个聊天会话生成独立 agent token；MCP 状态与发送工具必须携带该 token |

---

## 8. 启动与运行

本章界定启动入口、控制台与运行模式。

表 18：运行入口（口径：脚本位于仓库 `qq-bridge/` 根）

| 入口 | 说明 |
| --- | --- |
| `start.bat` | 守护启动（自动拉起、异常退出后重启） |
| `restart.bat` | 停止既有 bridge 进程并重新拉起 |
| 控制台 | `http://127.0.0.1:3100`，含模式、人格、社交参数、白名单与管理员、黑话管理、控制台访问令牌、会话与挂起与日志 |
| 模式 | `state/mode.json` 或 DSH settings 的 `qq-mode`；执行 `scripts/setup-dsh.mjs` 的全新环境默认为 `reserved2` |

---

## 9. 常用调试与测试脚本

本章界定脚本入口与用途。

表 19：脚本清单（口径：路径相对 `qq-bridge/`）

| 脚本 | 用途 |
| --- | --- |
| `scripts/test-console.mjs` | 控制台 API 自检 |
| `scripts/test-mcp-safe.mjs` | MCP 安全工具自检 |
| `scripts/test-mcp-host.mjs` | MCP 进程管理自检 |
| `scripts/test-mcp-web-search.mjs` | Web Search 与 Fetch MCP 自检（含内网拦截） |
| `scripts/test-onebot-connection.mjs` | OneBot 连接自检 |
| `scripts/send-test-group.mjs` | 向指定名称的群发送测试消息 |
| `scripts/check-onebot-status.mjs` | 网关状态 |
| `npm run self-test` | DSH 侧链路自检（不依赖 QQ） |

---

## 10. 开发与验证

本章界定改动后的验证顺序。

### 10.1 语法校验

```bash
node --check src/bridge.js
node --check src/dsh-client.js
node --check src/mcp-napcat-safe.js
node --check src/mcp-web-search-safe.js
node --check src/slang-learner.js
```

控制台 HTML 内联脚本的语法校验：

```bash
node -e "const fs=require('fs');const vm=require('vm');const h=fs.readFileSync('public/console.html','utf8');const m=h.match(/<script>([\s\S]*?)<\/script>/);new vm.Script(m[1]);console.log('OK')"
```

### 10.2 重启

```bash
restart.bat
```

---

## 11. 未核验声明

表 20：未核验项清单（口径：等级按本文证据分级）

| 项 | 声明 | 等级 |
| --- | --- | --- |
| 目录结构 | §3 的目录树为本文写作时的仓库状态，未逐条复核每一项的存在性 | 【据仓库记载】 |
| 默认值 | §6 的默认值取自实现记录，未在运行环境中逐一验证 | 【据仓库记载】 |
| 脚本清单 | §9 的脚本用途取自文件名与既有说明，未逐个执行 | 【未核验】 |
| 控制台入口文件 | §3 目录树中的 `public/console.html` 在当前仓库树中不存在（已检索仓库内全部 `.html`）；控制台服务的实现位于 `src/bridge.js` 的 `startConsoleServer`。原目录树条目按“不删改技术信息”的要求保留，未改写 | 【未核验】 |

---

## 12. 已知现象与判据

本章按现象、机制与判据给出运行期间的可观测现象。

表 21：已知现象、机制与判据（口径：判据列为可改动的参数或可观测的输出）

| 编号 | 现象 | 机制 | 判据与调整方向 |
| --- | --- | --- | --- |
| A1 | 活跃期回复不及时 | 群聊走轮询：`activeCheck` 为 10~30 秒，`activeReplyDelay` 为 2~8 秒 | 两个参数可调小；私聊已改为即时投递 |
| A2 | 部分消息没有回复 | 普通闲聊可能被 `skipProbability` 判为沉默，但内容会进入 `silentContext`，下次投递时模型可见 | 直接提问、被 @ 与私聊不参与沉默判定 |
| A3 | 拆条有时不拆 | 分句权在模型侧：模型未使用空格分隔时不拆条 | 单条超过 `maxReplyChars`（默认 500）时安全硬拆 |
| A4 | MCP 工具修改后不生效 | MCP 由 DSH 拉起，工具实现由 DSH 进程加载 | 修改 `src/mcp-*.js` 后须重启 DSH 进程本身（而非仅重启 `qq-bridge`），或使 DSH 重连 MCP；修改 DSH preset 或 `cordis.patch.yml` 后同样须重启 DSH |
| A5 | 黑话提取与联网研究未生效 | 提取以滚动窗口内的消息条数为触发条件；联网研究需要学习会话可用 `web_search` | 判定条件为 `slang.enabled` 为 true、DSH 在线、某会话消息已达到 `extractMinMessages` 条；黑话候选不自动转正，须在控制台「黑话管理」人工确认 |
