# 体系结构

本文档界定 MoonBot 的静态结构与运行期装配方式，覆盖范围限定为：系统边界与进程拓扑、安装布局与路径解析、通信面（HTTP / SSE / MCP / 文件）、首次启动状态机与鉴权、NapCat 进程守护与文件级自修、远程克隆部署、DSH 集成与上下文压缩接口、打包与分发、可靠性与可观测性、关键不变量。行为策略、能力清单与成本模型分别由 `docs/CAPABILITIES.md` 与 `docs/COMPACTION-MATH.md` 界定，本文档不重复。

本文档的定位是**结构与接口说明**。凡涉及经验性内容（历史故障、运行期观测、非显然约束），一律改写为「测量条件 → 方法 → 结果」形式的表格，测量批次以日期标识，不叙述过程。

## 目录

| 章 | 标题 | 内容边界 |
| --- | --- | --- |
| 1 | 范围与术语 | 文档范围、术语表、证据等级定义 |
| 2 | 安装布局与路径解析 | 运行时根目录、安装树、路径解析规则与边界情形 |
| 3 | 进程与模块拓扑 | 分层、端口、进程、启动顺序、就绪判据、退出清理 |
| 4 | 通信面 | 管理端 HTTP 面、SSE 事件流、桥控制台面、OneBot、DSH 协议、SSH 隧道 |
| 5 | 首次启动状态机与鉴权 | 管理端 / 隔离 DSH / NapCat / 桥的首次启动、鉴权面清单、凭据写入与脱敏 |
| 6 | NapCat 守护与自修复 | 进程内监护、关窗守卫、文件级自修、桥侧守护、随包 QQ 窗口隐藏 |
| 7 | 远程克隆部署 | 阶段划分、打包内容与排除项、目标端 systemd、回滚与失败恢复 |
| 8 | DSH 集成与上下文压缩接口 | 隔离 home、装配、会话与预设、投递与回合保持、压缩接口、计量与对账 |
| 9 | 打包与分发 | 仓库边界、打包侧事实、运行时侧对应实现、分发链 |
| 10 | 可靠性与可观测性 | 日志、审计、崩溃自愈、一致做法的来源 |
| 11 | 关键不变量 | 十六条不可违反的约束及其判据 |
| 12 | 未核验项与开放问题 | 未复现条目、已知不一致、证据索引 |

## 1. 范围与术语

本章界定全文适用的术语、命名约定与证据标注规则；后续各章不再重复定义这些约定。

### 1.1 术语表

表 1-1：术语与代码标识符对照。口径：术语首次出现处使用「中文（English / 代码标识符）」三件套，其后固定使用中文术语。

| 术语 | 代码标识符 / 文件 | 界定 |
| --- | --- | --- |
| 管理端 | 后端 `server/index.js`，前端 `src/` | 编排者进程：进程生命周期、配置读写、探活、日志、SSH 部署、前端静态托管 |
| 桥 | `qq-bridge/src/bridge.js` 及其 `core/`、`lib/` | QQ 平台与 agent 运行时之间的适配层 |
| 隔离 DSH | 独立 `DSH_HOME` 下的 DSH 实例 | agent 运行时，不感知 QQ |
| 随包 OneKey 版 NapCat | `napcat-onekey/` | QQ NT 协议转换层，对外提供 OneBot v11 |
| 实例 | `napcat-local` / `dsh-isolated` / `bridge-local` | 管理端托管的三个被编排进程 |
| 会话键 | `convKey(kind, id)`，形如 `private:<QQ>`、`group:<群号>` | 桥侧的会话唯一标识 |
| 回合 | turn，DSH 侧 `turn/start` 至 `turn/end` | 一次完整的模型响应周期 |
| 步 | step，DSH 侧 `step/end` 分隔 | 回合内的单次模型推理与工具调用段 |
| 唤醒 | 唤醒（wake），`scheduleWake(key, reason)` | 由入站消息或定时器触发的一次投递意图 |
| 投递 | 投递（delivery），`deliverPromptNow()` | 把提示词正文写入 DSH 会话的过程 |
| 在途注入 | 在途注入（mid-turn steer），`steerIntoRunningTurn()` | 回合进行中向 `next-step` 队列追加提示词 |
| 回合保持 | 回合保持（turn hold），`core/turn-hold.js` | 借助 `agent/turn-stopping` 钩子延迟回合关闭 |
| 闸门 | 闸门（gate），如单点登录闸门、幂等闸门 | 阻断某条路径的显式判定点 |
| 水位 | 水位（watermark），如 `dsh-seq.json`、`state/token-reconcile.json` | 已处理进度记录，用于幂等与去重 |
| 所有者 | `social.ownerQq`；提示词标记 `[OWNER]` / `[NOT-OWNER]` | 配置中登记的账号标识；权限判据见 `docs/CAPABILITIES.md` |

### 1.2 证据等级

表 1-2：证据等级标注规则。口径：每个非显然论断标注其中一级；未标注的论断视为【未核验】。

| 标记 | 含义 | 必须携带的信息 |
| --- | --- | --- |
| 【已核验】 | 本轮读取工作树源码或执行命令得到 | `path:line`（相对仓库根，正斜杠）或可复现命令 |
| 【据仓库记载】 | 引自仓库内其它文档或源码注释 | 出处文件与行号 |
| 【未核验】 | 推断、外部状态或未复现 | 显式声明未复现的原因 |

代码位置引用统一写作 `path/to/file.js:123`；区块引用写作 `path:lineA-lineB`。行号对应本轮工作树状态，重构后可能平移，函数名与文件名是稳定锚点。

## 2. 安装布局与路径解析

本章界定运行时根目录的推导方式、安装树的目录形态、各类资源的解析规则，以及路径相关的边界情形。

### 2.1 运行时根目录

`RUNTIME_ROOT` 由 `server/index.js` 顶部计算：`dirname(dirname(fileURLToPath(import.meta.url)))`，计算失败时回退 `process.cwd()`（`server/index.js:25-37`）；管理端配置目录由 `join(homedir(), '.qq-bridge-manager')` 给出（`server/index.js:43-47`）。该定义是「安装到任意盘、任意目录名」成立的前提：资源路径不得由 `process.cwd()` 推导。

表 2-1：工作目录无关性。口径：源码树内 `process.cwd()` 用于资源路径推导的调用点在变更前后计数，以仓库快照对比得出。

| 项 | 变更前 | 变更后 | 触发方式 |
| --- | --- | --- | --- |
| 使用 `process.cwd()` 推导资源路径的调用点 | 9 处 | 0 处 | 工作目录为 `C:\Windows\System32` 时启动（资源管理器双击、计划任务） |
| 受影响资源 | 随包 DSH、`qq-bridge`、`dist`、隔离 home | 无 | 同上 |

【据仓库记载】上表由 `docs/ARCHITECTURE.md` 原稿记录，本轮未逐点复现调用点计数。

### 2.2 安装树

```text
<RUNTIME_ROOT>/                       ← 安装根（可位于任意盘、任意目录名）
├─ MoonBot.exe                        ← Electron 壳（由仓库外打包工程产出）
├─ resources/runtime/                 ← 运行时可写树（源码树中即仓库根）
│   ├─ server/                        ← 管理端后端（index.js / deploy.js / *.mjs / *.js）
│   ├─ qq-bridge/                     ← 桥（src/ plugins/ characters/ roles/ state/ config.json）
│   ├─ napcat-onekey/                 ← 随包 NapCat 与 QQ
│   ├─ dsh-runtime/                   ← 随包 DSH CLI（私有 package.json，依赖 @deepseek-ai/dsh）
│   ├─ dist/                          ← 管理端前端构建产物
│   └─ .runtime/dsh-isolated-home/    ← 桥的项目内隔离 home（候选之一，见 §8.2）
├─ resources/app/                     ← 壳自身资产（具体文件名未核验）
└─ …
```

### 2.3 路径解析规则

表 2-2：资源路径解析规则。口径：规则的权威实现位置直接给出；环境变量优先于配置文件。

| 目标 | 规则 | 依据 |
| --- | --- | --- |
| 运行时可写树 | `RUNTIME_ROOT`，即 `server/index.js` 的上两级目录 | `server/index.js:25-37`【已核验】 |
| 管理端配置 | `join(homedir(), '.qq-bridge-manager', 'config.json')` | `server/index.js:43-47`【已核验】 |
| 管理端日志 | `<配置目录>/logs/`，含 `manager.log`、`napcat-guardian.log`、各实例日志 | 同上 |
| 隔离 home（管理端默认） | `DEFAULT_ISOLATED_HOME = <RUNTIME_ROOT>/.runtime/dsh-isolated-home`；实际取值来自 `instances.dshIsolated.isolatedHome` | `server/index.js:81`【已核验】 |
| 隔离实例端口 | `cfg.instances.dshIsolated.port`，缺省 10721 | `server/index.js:585`、`2618`【已核验】 |
| 桥目录 | `findBridgeDir()`：优先 `RUNTIME_ROOT/qq-bridge`；`startBridgeLocal()` 只信自动探测结果，忽略配置中残留的 `workDir` | `startBridgeLocal()` |
| 随包 DSH CLI | `instances.dshIsolated.dshCli`，否则 `findDshCli()`；`--port` 取自 `instances.dshIsolated.port` | `startIsolatedDsh()` |
| 随包 NapCat | `findNapcatOneKeyAll()` 的候选根列表：项目内 → `%LOCALAPPDATA%\Programs\*\resources\runtime` → 用户下载 / 桌面 / 文档 | `server/index.js:947-984` |
| 前端产物 | `join(RUNTIME_ROOT, 'dist')` | 静态托管实现 |

配置读入时执行一次「路径仍在树内」校验（`inTree()`，位于 `loadConfig()`）：指向树外的路径被拒绝，避免历史配置把资源指向其它位置。【据仓库记载】

### 2.4 边界情形

表 2-3：路径与进程管理相关的边界情形处理。口径：每行给出一条可触发的条件与对应的实现位置。

| 情形 | 处理 | 依据 |
| --- | --- | --- |
| 更换磁盘或安装目录 | `RUNTIME_ROOT` 随程序位置推导；配置中残留的 `launchCommand` / `workDir` 被自动探测结果覆盖 | `startBridgeLocal()` 注释 |
| 路径含中文或空格 | PowerShell 调用使用单引号字面量转义（`q(onekey.dir)`）；`spawn` 传递参数数组；守卫命令行对含空格或引号的参数加引号 | `startNapcatHidden()`、`spawnGuardianDetached()` |
| 由资源管理器双击或计划任务启动 | 工作目录可能为 `C:\Windows\System32`；全部资源路径不依赖工作目录 | §2.1 |
| 安装目录只读（如 `Program Files`） | 守卫硬链接退至 `RUNTIME_ROOT/.guard/`；建链接失败仅记日志，WMI 脱离进程树仍然有效 | `spawnGuardianDetached()`（`server/index.js:9884`）【已核验】 |
| 临时目录不可写 | 窗口隐藏器无法启动，退回一次性 `hideBundledQqWindows()` 轮询 | §6.5 |
| 非 Windows 平台 | 隔离 home 解析中的「拒绝桌面端 DSH」分支仅在 `win32` 生效；Linux 上 `/root/.dsh` 为合法目标；NapCat 走官方安装脚本 | `qq-bridge/src/lib/dsh-side.js`、`server/index.js` 的 `process.platform !== 'win32'` 分支 |
| 多份安装共存 | 停止与进程清理按**全部**候选托管目录前缀匹配，不限于首个命中项 | `findNapcatOneKeyAll()` 注释、`napcatManagedDirs()`（`server/index.js:2561`）【已核验】 |

## 3. 进程与模块拓扑

本章界定分层结构、端口分配、进程清单、启动顺序与就绪判据、退出清理语义，以及跨实例的互斥约束。消息级事件流（入站归一、唤醒判定、投递执行、出站）属于投递路径，统一在 §8.5 界定。

### 3.1 分层

```text
QQ 群 / 私聊
        │ QQ 协议
┌───────────────────────────────────────────────────────────────┐
│ NapCat  WebUI :6099   OneBot HTTP :3000   反向 WS :3001        │
│        把 QQ NT 转成 OneBot v11 服务端                          │
└───────────────────────────┬───────────────────────────────────┘
                            │ OneBot v11（WebSocket）
┌───────────────────────────▼───────────────────────────────────┐
│ qq-bridge   入口 qq-bridge/src/bridge.js   控制台 :3100         │
│   唤醒判定 → 提示词组装 → 会话映射 → DSH 投递 → 事件泵 →         │
│   工具调用 → 发送链 → QQ                                        │
│   三组 MCP server（stdio）：mcp-napcat / mcp-napcat-host /      │
│   mcp-web-search-safe                                           │
└───────────────────────────┬───────────────────────────────────┘
                            │ DSH HTTP API（session.prompt mode:'steer'）
┌───────────────────────────▼───────────────────────────────────┐
│ 隔离 DSH   独立 DSH_HOME   profile=web                         │
│   agent preset（qq-chat / default）：[WAKE TYPES] / [RULES] /   │
│   [TOOLS] / [TOOLS 2b~2e] 等行为规则                            │
│   本地插件：dsh-qq-hold（回合保持钩子）、qq-mode-console、      │
│             dsh-memory（长期记忆 remember/recall）              │
└───────────────────────────┬───────────────────────────────────┘
                            │ LLM API
                        模型服务商
```

管理端（Electron + React + Express）不位于上述数据链上，其角色为编排者：拉起进程、写配置、读日志、执行 SSH 部署。

表 3-1：各层入口与职责。口径：入口列给出可执行入口文件；职责列只描述该层的构成性职能。

| 层 | 入口 | 职责 |
| --- | --- | --- |
| 管理端前端 | `src/App.tsx`、`src/api.ts` | 页面切换与后端接口封装；页面在 `src/pages/`，共享组件在 `src/components/`，类型在 `src/stores/types.ts` |
| 管理端后端 | `server/index.js` | HTTP API、实例编排与探活、前端静态托管、安装位置体检（`RUNTIME_ROOT`，`server/index.js:25-31`） |
| 远程部署 | `server/deploy.js` | SSH 克隆部署：打包 → 流式转发 → 目标机解包 → systemd / NapCat 容器 → 启动自检 |
| 关窗守卫 | `server/napcat-guardian.mjs` | 独立进程；壳退出后停止 NapCat / 桥 / 隔离 DSH |
| 连接状态机 | `server/connect-machine.js` | 阶段机 `connecting → tunnels → server-starting → warming → ready / failed`；把远端 DSH / NapCat / 桥逐个判定为 ready / starting / down；纯逻辑，界面读 `/api/connect` 或 `/api/state.connect`（零网络） |
| 隔离凭据 | `server/iso-credential.js` | 隔离 DSH 的 `.credentials.yaml` 读写；本地直写与服务端 HTTP 写盘共用，可单测 |
| NapCat 自修 | `server/napcat-repair.js` | 检查并补齐 NapCat Shell 目录内缺失的模块文件（§6.3） |
| 桥入口 | `qq-bridge/src/bridge.js` | 载入配置、连接 OneBot 反向 WS、装载事件泵与各子系统 |
| 桥业务层 | `qq-bridge/src/core/*.js` | 唤醒投递、提示词组装、会话映射、社交状态、发送链、媒体与卡片、语音、学习、用量 |
| 桥基础库 | `qq-bridge/src/lib/*.js` | OneBot 客户端、消息解析、图片体检、Pixiv、路径、文本处理 |
| 桥工具层 | `qq-bridge/src/mcp-*.js` | 三组 MCP server |
| 隔离 DSH | `qq-bridge/dsh/agent-presets/qq-chat/` | `preset.yml` / `agent.cordis.yml` 提供行为规则，`qq-tool-restrict.mjs` 限制可用工具 |
| DSH 插件 | `qq-bridge/plugins/dsh-qq-hold/`、`qq-bridge/plugins/qq-mode-console/`、`qq-bridge/plugins/dsh-memory/` | 回合保持、模式控制台、长期记忆 |
| NapCat | `napcat-onekey/` | 便携版 NapCat 与 QQ（`NapCat.Shell.zip`、`NapCatInstaller.exe`、`QQ.exe`、`NapCat.44498.Shell/`、`bootmain/`） |

表 3-2：已移除模块的更正记录。口径：以工作树内 `server/` 的实际文件列表为准。

| 模块 | 原稿记载 | 工作树状态 | 职能承接 |
| --- | --- | --- | --- |
| `server/napcat-webui-auth.js` | 「唯一允许调用 `POST /api/auth/login` 的位置」 | 文件不存在；`server/` 当前为 `connect-machine.js`、`deploy.js`、`index.js`、`iso-credential.js`、`napcat-guardian.mjs`、`napcat-repair.js` | 由「不使用 NapCat 登录接口作探测手段」策略取代（§6.4） |

【已核验】表 3-2 的后两列以工作树文件列表核对。

### 3.2 系统边界

表 3-3：系统边界与交互方式。口径：内部列给出属于本系统的组件，外部列给出交互对端。

| 边界 | 内部 | 外部 | 交互方式 |
| --- | --- | --- | --- |
| 本机安装树 | 管理端后端、前端产物、`qq-bridge/`、`napcat-onekey/`、`dsh-runtime/` | — | 全部路径由 `RUNTIME_ROOT` 派生（§2.3） |
| 用户数据 | `%USERPROFILE%\.qq-bridge-manager\`（配置、日志、守卫文件、方案库、隔离 home） | — | 与安装树分离；卸载或换盘不影响 |
| 桥 ↔ QQ 平台 | 桥 | NapCat（OneBot v11） | WebSocket（反向 WS 3001）+ HTTP 3000 |
| 桥 ↔ agent 运行时 | 桥 | 隔离 DSH | HTTP `/api/<ns>/<method>` + WebSocket `/api/remote.mux` |
| agent ↔ 模型服务商 | 隔离 DSH | DeepSeek 官方 / 小米 MiMo / 任意 OpenAI 兼容端点 | 由 DSH provider 配置决定，凭据来自 `.credentials.yaml`（§8.7） |
| 管理端 ↔ 目标机 | 管理端后端 | 远端 Linux 主机（`/root/qq-bridge`、`/root/.dsh`、`/opt/napcat`） | ssh2（命令 + 隧道 + 流式转发） |
| 管理端 ↔ 浏览器前端 | 管理端后端 | 本机浏览器或内嵌窗口 | HTTP `127.0.0.1:1921`；开发模式经 Vite 5173 代理 |
| 仓库 ↔ 打包工程 | 本仓库 | `C:\Users\17367\Desktop\QQ-Bridge-packaging`（不在本仓库） | 打包工程单向消费本仓库产物（§9） |

### 3.3 角色划分

表 3-4：角色、承担者与明确边界。口径：「明确不做」列列出该角色越界即构成缺陷的行为。

| 角色 | 承担者 | 职能 | 明确不做 |
| --- | --- | --- | --- |
| 接入层 | NapCat（随包 OneKey 版） | 把 QQ NT 转成 OneBot v11 服务端（WebUI 6099 / HTTP 3000 / WS 3001） | 不做唤醒判定、不组装提示词 |
| 桥接层 | `qq-bridge/src/bridge.js` 及其 `core/`、`lib/` | 唤醒判定、提示词组装、会话映射、DSH 投递、事件泵、工具调用、发送链、审计、计量、学习 | 不直接访问 QQ 协议；不写 DSH 的会话日志（§8.4） |
| agent 运行时 | 隔离 DSH（独立 `DSH_HOME`） | 维护模型回合、工具体、上下文压缩、会话持久化 | 不感知 QQ；只接收桥投递的提示词与 MCP 工具 |
| 编排者 | 管理端后端 `server/index.js` | 进程生命周期、配置读写、探活、日志、SSH 部署、前端托管 | 不位于数据链上，不参与消息处理 |
| 客户端 | 管理端前端 `src/` | 界面与操作，代理调用后端与桥控制台 | 不做状态判定（phase 由后端给出） |
| 退出清理 | `server/napcat-guardian.mjs` | 应用退出后按托管目录 / 绝对路径 / 端口收尾 | 不处理非托管目录下的任何进程 |
| 部署器 | `server/deploy.js` | 把整套能力迁移到目标机并自检 | 不覆盖目标机已有的用户配置与能力（§7.4） |

### 3.4 两侧配置分离

- 管理端配置：`%USERPROFILE%\.qq-bridge-manager\config.json`；日志 `…\.qq-bridge-manager\logs\`（`server/index.js:37-47`）【已核验】
- 桥配置：`<运行时>/qq-bridge/config.json`；模板 `qq-bridge/config.example.json`

桥配置的顶层键（依 `qq-bridge/config.example.json`）：`dsh`、`dshCompaction`、`napcat`、`pixiv`、`ownerQQ`、`guard`、`sessionCwd`、`agentPreset`、`workspaceTitle`、`allow`、`deny`、`allowAllWhenEmpty`、`allowAllPrivate`、`allowAllGroups`、`ackMessage`、`sendDelayMs`、`questionTimeoutMs`、`consolePort`、`consoleToken`、`prompt`、`tokenCost`、`security`、`slang`、`social`。

两侧配置不互相回落：前端缓存按读取目标分键（本机桥配置与服务端桥配置各一份，`src/config-cache.ts`）。将本机条目渲染为服务端条目，其后果为配置误判，严重性高于渲染出厂默认值。【据仓库记载】

### 3.5 端口全表

表 3-5：端口分配。口径：绑定地址与默认值取自实现；同一端口在不同部署形态下取值不同者分列。

| 端口 | 服务 | 绑定 | 用途 | 依据 |
| --- | --- | --- | --- | --- |
| 1921 | 管理端后端 | `127.0.0.1` | HTTP API + 前端静态托管；`QBM_API_PORT` 可覆盖，`QBM_NO_LISTEN=1` 时只导出 app 不监听 | `server/index.js` 的 `app.listen` |
| 5173 | Vite 开发服务器 | `127.0.0.1`（`strictPort`） | 仅开发模式；`/api` 代理到 `http://127.0.0.1:1921` | `vite.config.ts` |
| 6099 | NapCat | 本机 | 官方 WebUI：扫码登录、OneBot 配置 | `DEFAULT_LOCAL.napcatWebui`（`server/index.js:64`）【已核验】 |
| 3000 | NapCat | `0.0.0.0` | OneBot HTTP 动作接口（`send_qzone_msg` 等），令牌 `truefriend` | `server/index.js:1223` 附近 |
| 3001 | NapCat | `127.0.0.1` | OneBot 反向 WS 事件推送（桥连接的端点），令牌 `truefriend` | 同上；桥侧默认 `ws://127.0.0.1:3001`（`qq-bridge/src/core/config.js:70`）【已核验】 |
| 10721 | 隔离 DSH | 本机 | agent 运行时 API；`qq-bridge/src/core/config.js:20` 的 `dsh.baseUrl` 默认值，亦为 `instances.dshIsolated.port` 缺省值 | `qq-bridge/src/core/config.js:20`、`server/index.js:585`【已核验】 |
| 3100 | 桥 | `127.0.0.1` | 本地控制台（`consolePort`） | `qq-bridge/src/core/config.js:94`、`server/index.js:539`【已核验】 |
| 3210 | 隔离 DSH（`DEFAULT_LOCAL.dshWeb`） | 本机 | 「本机 DSH」默认端口，用于内嵌界面；与 `instances.dshIsolated.port`（10721）为两套取值 | `server/index.js:64`【已核验】 |
| 3080 | 隔离 DSH（目标机） | 目标机 | 远端 `dsh-web.service` 的 `--port 3080`；桥配置改写为 `http://127.0.0.1:3080` | `server/deploy.js:1384-1394`、`1428` |
| 13000 / 13001 / 13080 / 13100 | SSH 本地隧道 | 本机 | 远端 6099（NapCat WebUI）/ 3000（OneBot HTTP）/ 3080（DSH Web）/ 3100（桥控制台）映射到本机回环 | `server/index.js:189-196` 的 `tunnelMapFor()`【已核验】 |

端口取值差异的规范化记录如下。

表 3-6：端口口径的测量与结论。口径：测量批次 2026-09-25；对象为 `lib/dsh-side.js` 顶部注释、`qq-bridge/README{,.en}.md`（该两份文件已于 2026-09-25 并入根 `README.md`）、`server/index.js` 的 `DEFAULT_LOCAL`。

| 批次 | 对象 | 方法 | 结果 |
| --- | --- | --- | --- |
| 2026-09-25 | 隔离实例端口记载 | 逐文件检索 `13210` | 注释与两份 README 原记 `13210`，工作树无对应实现；已统一改为 `10721`，实际取值来自 `instances.dshIsolated.port` |
| 2026-09-25 | 远端 DSH Web 端口 | 比对 `tunnelMapFor()`、`DEFAULT_LOCAL`、`src/pages/SSHConfig.tsx`、`server/deploy.js` | `tunnelMapFor()` 使用 `m.dshWeb ?? 3080`（`server/index.js:194`【已核验】）；`DEFAULT_LOCAL.dshWeb` 模板值为 3210（`server/index.js:64`【已核验】）；前端 `RP_DEFAULTS.dshWeb = 3080`；部署脚本硬写 3080。默认值不一致项见 §12 |
| 2026-09-25 | 本机 DSH 条目端口 | 检索 `dsh-web` 实例的端口来源 | 取 `instances.dshIsolated.port`（`server/index.js:2859`），与 `DEFAULT_LOCAL.dshWeb` 无关 |

部署形态差异：`server/deploy.js` 以一段 node 内联脚本把目标机 `/root/qq-bridge/config.json` 的 `dsh.baseUrl` 改写为 `http://127.0.0.1:3080`。目标机隔离 DSH 端口与本机默认端口不同，日志排查时不得混用。【据仓库记载】

### 3.6 进程拓扑

表 3-7：进程清单（Windows 形态）。口径：父进程列给出实际父进程；「由谁启动」给出直接调用方。

| 进程 | 可执行文件 | 由谁启动 | 父进程 | 关键启动参数 / 环境 | 日志 |
| --- | --- | --- | --- | --- | --- |
| 应用壳 | `MoonBot.exe` | 用户 | `explorer.exe` | Electron 壳；源码不在本仓库（§9） | 无 |
| 管理端后端 | `qbm-node.exe`（随包 Node 运行时） | 应用壳 | `MoonBot.exe` | `server\index.js`；`windowsHide` | `%USERPROFILE%\.qq-bridge-manager\logs\manager.log`（`mlog()`） |
| 隔离 DSH | `qbm-node.exe` | 管理端后端 | 管理端后端 | `<dshBin> --profile web --port 10721 --no-open --trusted-host 127.0.0.1:10721 --trusted-host localhost:10721`；`DSH_HOME=<isolatedHome>`；另注入 `.credentials.yaml` 派生的环境变量；直接运行 `bin.js` 时附加 `--expose-internals` | `instanceLogPath('dsh-isolated')` |
| 桥 | `qbm-node.exe` | 管理端后端 | 管理端后端 | `node src/bridge.js`；`cwd =` 桥目录；`DSH_ISOLATED_LOG_FILE=<隔离 DSH 实例日志>` | 实例日志 + `qq-bridge/state/bridge.log` |
| NapCat 启动器 | `WindowsPowerShell\v1.0\powershell.exe` | 管理端后端 | 管理端后端 | `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -FilePath NapCatWinBootMain.exe -WorkingDirectory <onekey.dir> [-ArgumentList <QQ号>] -WindowStyle Hidden"` | 实例日志 |
| NapCat / QQ | `NapCatWinBootMain.exe` → `QQ.exe` | 上述启动器 | powershell（启动器通常毫秒级退出，QQ 被重新挂到系统进程下） | 仅托管目录内的实例 | 实例日志 |
| 窗口隐藏器 | `powershell.exe -File <temp>.ps1` | 管理端后端 | 管理端后端 | 常驻；200 ms 轮询；12 小时预算；父进程存活守卫 | 实例日志 |
| 关窗守卫 | `guard-node.exe`（`qbm-node.exe` 的硬链接） | 管理端后端 | `WmiPrvSE.exe`（由 WMI 创建） | `napcat-guardian.mjs --parent <appPid> --guard-file <...> --dirs <JSON> --dsh-port <n> --bridge-script <abs> --kill-napcat <0\|1> --log <file>` | `%USERPROFILE%\.qq-bridge-manager\logs\napcat-guardian.log` |

进程名相关的规范化记录如下。

表 3-8：进程名与进程树脱离的测量。口径：测量批次 2026-09；样本为发布包运行现场（`qbm-node.exe`）与开发机（`node.exe`）。

| 项 | 测量条件 | 方法 | 结果 |
| --- | --- | --- | --- |
| 进程名过滤缺口 | 发布包使用随包运行时 `qbm-node.exe` | 按命令行关键字清理时按进程名筛选取交集 | 仅匹配 `node.exe` 时命中数为 0；管理器重启后「停止桥」返回成功，原桥仍占用 3100 与 `state/bridge.lock`。实现改为同时覆盖两种进程名（`killByCmdline()`，`server/index.js:2552`【已核验】） |
| 进程树脱离方式 | 壳的退出清理按 `$_.Path -eq '<runtime>\qbm-node.exe'` 精确匹配 | 使用同盘硬链接 `guard-node.exe` 改变可执行文件路径 | 匹配失败，守卫未被壳清理 |
| 父进程链脱离 | 壳使用 `taskkill /T`，按父链枚举子进程 | 以 WMI 创建进程 | 守卫父进程为 `WmiPrvSE.exe`，不在壳的子进程链内（`spawnGuardianDetached()`，`server/index.js:9884`【已核验】） |
| WMI 建进程参数 | 需要无窗口创建 | 对比 `Win32_ProcessStartup.ShowWindow = 0` 与 `CreateFlags = CREATE_NO_WINDOW` | 后者使 `Win32_Process.Create` 返回 21（InvalidParameter）；退回普通 `Create` 会额外产生一个控制台窗口。实现采用前者 |

NapCat 的隐藏启动路径为单一实现：PowerShell `Start-Process -WindowStyle Hidden`（`startNapcatHidden()`，`server/index.js:1291-1310`）。被跟踪的 powershell 子进程本身毫秒级退出，因此 NapCat 的存活判据不读取 `exitCode`，而取「托管目录下是否仍存在 NapCat / QQ 进程」（`countNapcatProcs(napcatManagedDirs(rt))`）。【据仓库记载】

### 3.7 启动顺序与就绪判据

实例共三个：`napcat-local`、`dsh-isolated`、`bridge-local`。`keyOf()` 把 id 映射到 `instances.napcatLocal / dshIsolated / bridgeLocal`（`server/index.js:3208`）【已核验】。

依赖顺序为：NapCat（QQ 网关）→ 隔离 DSH（agent 运行时）→ 桥。

表 3-9：三条启动入口。口径：行为列只描述该入口的调度语义，不含被编排进程的内部行为。

| 入口 | 路由 | 行为 |
| --- | --- | --- |
| 单实例卡片 | `POST /api/instance/:id/:action`（`start` / `stop` / `restart`） | 立即返回 `starting`，后台轮询推进 |
| 启动整套 | `POST /api/instance/start-all` | 按依赖顺序逐个 `waitInstanceReady`，每步就绪后才进入下一步 |
| 开机或开窗自动恢复 | `scheduleAutoStart()` | 只恢复 `instances.<key>.enabled === true` 且未被 `instances.<key>.autoStartOnBoot === false` 排除的实例；逐个间隔 1200 ms；不等待就绪 |

状态机（phase）为 `idle → starting → running`，异常进入 `failed`；`stopping` 是 `stop` / `restart` 的过渡态。

表 3-10：就绪判据。口径：判据为端口或 HTTP 应答，不采用「已发起 spawn」作为就绪证据（`instanceReadiness()`，`server/index.js:2729`【已核验】）。

| 实例 | ready 判据 | 附加 note |
| --- | --- | --- |
| `dsh-isolated` | `GET http://127.0.0.1:<port>/` 可达（401 与 200 均计入存活） | 端口已监听但尚未解析到 token → 「已监听，等待就绪」 |
| `napcat-local` | WebUI 端口处于监听 | 3000 / 3001 任一处于监听才计入「已登录」，否则提示「WebUI 已起，等待 QQ 扫码登录」 |
| `bridge-local` | `GET http://127.0.0.1:<port>/` 可达 | 等待桥监听端口 |

表 3-11：启动预算与失败信息。口径：预算为「从拉起到可对外服务」的耗时上限，超出即判失败（`startupBudgetMs()`，`server/index.js:2676`【已核验】）。

| 实例 | 启动预算 | 依据 |
| --- | --- | --- |
| `dsh-isolated` | 90 000 ms | `server/index.js:2677`【已核验】 |
| `napcat-local` | 120 000 ms | `server/index.js:2678`【已核验】 |
| `bridge-local` | 45 000 ms | `server/index.js:2679`【已核验】 |

失败信息取自实例日志尾部：`readFailureReason()` 用 `FAIL_PAT` 正则筛出最接近原因的两行，写入 `phase.error`；进程中途消失（NapCat 除外）或超时同样归入该字段。已在运行的实例被认回而非重复拉起：`startInstanceTracked()` 先探活，命中则置 `running` 并标记 `adopted`；NapCat 必须走该路径，重复启动会挤出已扫码登录的实例。【据仓库记载】

### 3.8 退出与清理语义

清理分为四级，前一级失败由后一级承担。

表 3-12：退出清理的四个层级。口径：层级按执行方划分，不按时间顺序。

| 级 | 执行方 | 行为 | 关键判据 |
| --- | --- | --- | --- |
| 1 | 应用侧 | 壳在关窗前调用 `POST /api/shutdown`；默认只收 NapCat，带 `{all:true}` 时一并收桥与隔离 DSH | `killOnExit` 关闭时 NapCat 完全不被处理，响应以 `napcatSkipped` 告知调用方本次为有意跳过（`killOnExitEnabled()` 默认 `true`，对应 `instances.napcatLocal.killOnExit`） |
| 2 | 壳进程树 | `taskkill /pid <后端> /T /F`，再按可执行文件路径清理残留 `qbm-node.exe` | 可执行文件路径精确匹配 |
| 3 | 管理端后端退出钩子 | 按 `napcatSpawnedPids` / `napcatLaunchedThisProcess` 判断本次运行是否由本进程拉起，仅当为真才终止 | `killNapcatOnExitSync` 的首个判断即该标记；标记为假时不处理任何 NapCat 进程（`server/index.js:2301-2441`）【已核验】 |
| 4 | 关窗守卫 | 独立进程（不在应用进程树内）：轮询间隔 2000 ms；父进程消失后等待 `graceMs`（默认 30 000 ms，命令行 `--grace` 可改，早期值为 6 000 ms），随后重新读取 guard 文件确认归属，再依次清理 NapCat → 桥 → 隔离 DSH | `--dirs` 为空时不终止任何进程；`server/napcat-guardian.mjs:52` 给出 `graceMs` 缺省值 30000【已核验】 |

第 4 级的清理判据为精确匹配：托管目录前缀（`--dirs`）、桥的绝对路径（`--bridge-script`）、DSH 端口（`--dsh-port`），并排除自身（`NOT_SELF`）。缺少参数时跳过对应清理，取舍为宁可漏收不可误杀。【据仓库记载】

表 3-13：关窗守卫的武装条件与复查。口径：复查由启动时一次与每 60 秒一次的 `setInterval` 共同驱动。

| 条件 | 行为 | 依据 |
| --- | --- | --- |
| `QBM_NAPCAT_GUARDIAN=0` | 整体关闭 | `ensureGuardianArmed()` |
| guard 文件记载的守卫进程存活 | 不执行任何操作 | 同上 |
| 本后端父进程名为 `MoonBot` | 以该进程为监护目标 | `parentProcessName()` |
| 否则存在运行中的 `MoonBot.exe` | 以该进程为监护目标（应用复用已在运行的后端时，该条件在 60 秒内补齐守卫） | `findMoonBotPid()` |
| 应用未运行 | 静默等待，不武装；不使用来源不明的 PID 作为应用标识 | 同上 |
| `POST /api/guardian/arm` | 手工武装：取 `body.parentPid`，或自动选取首个 `MoonBot` 进程；进程名非 `MoonBot` 一律拒绝 | 路由实现（`server/index.js:2999`）【已核验】 |

### 3.9 单点登录互斥

同一 QQ 号不能同时在本机与服务端两个端点登录：平台判定为「已在另一台终端登录」并互相下线，表现为该号不再产生回复。管理端后端因此在 `startDispatcher()` 内设置与该前端无关的硬闸门。【据仓库记载】

表 3-14：单点登录闸门。口径：探测复用既有 `remoteStatusCache`，缓存未命中时增加一次 SSH 往返。

| 方向 | 行为 | 实现 |
| --- | --- | --- |
| 服务端 NapCat 在线时启动本机 NapCat | 拒绝启动并返回可读原因 | `DUAL_LOGIN_HINT`（`server/index.js:3189`）【已核验】 |
| 启动或重启服务端 NapCat 前 | 先停止本机 NapCat（服务端为生产端点） | `stopLocalNapcatBeforeRemote()`（`server/index.js:3177`）【已核验】 |
| 状态不可获取 | 按 `known:false` 处理，不阻断操作 | 同上 |

## 4. 通信面

本章界定系统全部对外与对内通信通道：管理端 HTTP 面、SSE 事件流、桥控制台面、桥与 NapCat 的 OneBot 通道、桥与隔离 DSH 的协议、管理端与前端、管理端与目标机的 SSH 通道，以及文件通道。消息处理路径内部的数据流在 §8.5 界定。

### 4.1 管理端 HTTP 面

工作树中 `server/index.js` 含 93 条 `app.get/post/put/delete` 路由（含 `:param` 形式），命令如下。【已核验】

```bash
node -e "const s=require('fs').readFileSync('server/index.js','utf8');console.log((s.match(/app\.(get|post|put|delete)\(\s*'/g)||[]).length)"
```

表 4-1：配置、状态与生命周期路由。口径：路径列出登记形式，`:param` 表示路径参数。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/config` | 读管理端配置（含服务器列表、实例配置） |
| POST | `/api/config` | 保存管理端配置（深合并 + 原子写） |
| GET | `/api/state` | 总状态：实例 phase / 探活、连接模式、远端三件套、配置摘要（前端 1.2~4 秒轮询） |
| GET | `/api/connect` | 连接状态机快照（零网络，读 `connect-machine`） |
| GET | `/api/open` | 解析「打开官方界面」的目标 URL（`scope=local\|remote`；服务端在线时把本机 NapCat 请求落到远端隧道） |
| POST | `/api/shutdown` | 关窗前收尾（默认只收 NapCat，`{all:true}` 连桥与隔离 DSH） |
| POST | `/api/guardian/arm` | 手工武装关窗守卫（校验目标进程名必须为 `MoonBot`） |

表 4-2：实例编排路由。口径：`id` 取值域为三个实例标识。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/instance/:id/:action` | `start` / `stop` / `restart`（`id ∈ {dsh-isolated, napcat-local, bridge-local}`） |
| POST | `/api/instance/start-all` | 按依赖顺序启动整套并逐步等到就绪 |
| GET | `/api/instance/:id/logs` | 读实例日志尾部（UTF-8 解码失败时退 GBK） |

表 4-3：SSH 与服务端路由。口径：涉及目标机路径的路由以服务端绝对路径给出。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/ssh/test` | 测试连通性 |
| POST | `/api/ssh/connect` | 建立连接与四条隧道（13000 / 13001 / 13080 / 13100） |
| POST | `/api/ssh/disconnect` | 断开并关闭隧道 |
| GET | `/api/ssh/status` | 连接与服务端组件状态（DSH / NapCat / 桥） |
| POST | `/api/ssh/sync` | 同步本机代码与资源到目标机 |
| POST | `/api/ssh/stack` | 服务端整套服务的启停（含 NapCat 容器的起停顺序） |
| POST | `/api/ssh/service` | 单个 systemd 服务或容器的启停 |
| POST | `/api/ssh/remove-stack` | 卸载目标机上的整套服务 |
| GET/POST | `/api/ssh/bridge-config` | 读写服务端 `/root/qq-bridge/config.json` |
| POST | `/api/ssh/deploy/start` | 启动 SSH 克隆部署 |
| GET | `/api/ssh/deploy/status` | 部署进度（步骤、当前步、日志行） |
| GET | `/api/ssh/deploy/tasks` | 部署任务台账 |

表 4-4：桥能力代理路由（`/api/bridge/*`，转发到桥控制台）。口径：这些路由为代理层，鉴权头由代理注入。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/bridge/config` | 读桥配置（本机或服务端） |
| POST | `/api/bridge/config` | 保存桥配置；摘出 `dsh.apiKey` 写入隔离 DSH 凭据文件，并按需重启隔离 DSH（§5.4） |
| GET/POST | `/api/bridge/owner-qq` | 所有者 QQ 读写（首次运行引导项） |
| POST | `/api/bridge/speech-reset` | 恢复内置发言规则模板 |
| GET | `/api/bridge/characters`、POST `/api/bridge/characters/import` | 角色库列表、导入角色包 |
| GET | `/api/bridge/chat-convs`、`/api/bridge/chat-messages`、`/api/bridge/chat-stats`、POST `/api/bridge/chat-delete` | 聊天记录：会话列表、消息、总量、按会话删除 |
| GET | `/api/bridge/memory-stats` | 记忆库统计 |
| GET | `/api/bridge/tool-schema-stats`、`/api/bridge/context-overhead` | 工具 schema 体积、上下文开销快照 |
| GET/POST | `/api/bridge/activity-hours`、GET `/api/bridge/activity-targets` | 活跃时段配置与目标 |
| POST | `/api/bridge/upload`、`/api/bridge/stickers/upload` | 上传角色资产、表情包 |
| GET | `/api/bridge/meme-packs`、POST `/api/bridge/meme-packs/upload\|delete\|bind` | 表情包仓库管理 |

表 4-5：其余路由分组。口径：以组为单位给出方法集合与路径族，逐条端点见桥控制台面（§4.3）或分组内的括号说明。

| 分组 | 前缀 | 端点 |
| --- | --- | --- |
| 学习与画像 | `/api/learning/*` | `config`（GET/POST）、`slang`（POST）、`persona`（POST）、`persona-apply`（POST）、`portrait`（POST）、`portrait-config`（GET/PUT）、`profile`、`graph`、`groups`、`messages`、`owner-profile`、`relations`（GET/PUT）、`relations/auto`（POST）、`slang-library`、`token-report`、`token-reconcile`（POST）、`token-stream`（GET，SSE） |
| NapCat | `/api/napcat/*` | `launchers`（GET，候选启动器与安装位置）、`install-qq`（POST）、`tokens`（GET/POST，WebUI / HTTP / WS 三处令牌）、`webui-ready`（GET）、`qr`（GET）、`login-stream`（GET，SSE）、`guard`（GET/POST）、`guard/heal`（POST）、`quick-password`（POST） |
| 语音 | `/api/voice/*` | `config`（GET/PUT）、`voices`（GET/POST/DELETE）、`preview`（POST）、`test`（POST） |
| 黑话批量 | `/api/slang/*` | `batch-confirm`、`batch-delete`、`batch-reject`、`research`（均 POST） |
| 配置方案 | `/api/profiles` | GET 列表；POST 保存（参数完全相同则复用，不新增）；POST `/api/profiles/:id/delete` |

### 4.2 SSE 事件流

表 4-6：事件流端点。口径：三者均为 `text/event-stream`，由管理端后端以 `x-console-token` 头代理到桥控制台；`index.html` 单独携带 `Cache-Control: no-store`。

| 端点 | 上游 | 内容 |
| --- | --- | --- |
| GET `/api/bridge/chat-stream` | 桥控制台 | 聊天与回合实时流 |
| GET `/api/learning/token-stream` | 桥控制台 | token 用量实时流 |
| GET `/api/napcat/login-stream` | 桥控制台 | QQ 登录状态流（扫码结果） |

表 4-7：实时通道构成的测量。口径：检索 `server/index.js` 全文；「WebSocketServer」计数为 0，「websocketServers」的 5 次出现全部位于 NapCat OneBot 配置注入片段。

| 项 | 方法 | 结果 |
| --- | --- | --- |
| SSE 端点 | 检索 `/text\/event-stream/` 与路由绑定 | 3 个端点；另有 2 处为向上游发起 SSE 请求时设置的 `Accept` 头 |
| WebSocket 服务端 | 检索 `WebSocketServer`、`app.ws`、`upgrade` | 0 处；管理端不提供 WebSocket 端点 |
| 实时面通道 | 由上两项推导 | 实时面走 SSE，状态面走轮询 |

【已核验】上表三项以 `server/index.js` 全文检索得到。

### 4.3 桥控制台面

`qq-bridge/src/core/console-server.js` 监听 `consolePort`（默认 3100，绑定 `127.0.0.1`）。端点计数依赖口径，故给出判据：以 `url.pathname === '/api/...'` 形式的字面量比较统计，工作树中为 159 处比较、去重后 136 个路径；另有若干以 `startsWith` 匹配的前缀族（如 `/api/stickers/`），故可路由到的端点总数不少于 136。【已核验】

```bash
node -e "const s=require('fs').readFileSync('qq-bridge/src/core/console-server.js','utf8');const m=[...s.matchAll(/url\.pathname\s*===\s*'(\/api\/[^']*)'/g)].map(x=>x[1]);console.log('比较',m.length,'唯一',new Set(m).size)"
```

表 4-8：桥控制台端点分组。口径：每行给出该组的前缀族与代表端点，不代表该组端点的完整枚举。

| 分组 | 代表端点 |
| --- | --- |
| 状态与鉴权 | `/api/status`、`/api/console/token`、`/api/security`、`/api/profile`、`/api/authorize/read` |
| 发送与回合 | `/api/send/group`、`/api/send/private`、`/api/send/reply`、`/api/test-send`、`/api/qq/turn-hold`、`/api/social/current-turn`、`/api/social/wait`、`/api/session/reset`、`/api/workspace/reset`、`/api/restart` |
| 社交与唤醒 | `/api/social/config`、`/api/social/wake`、`/api/social/wake-config`、`/api/social/state`、`/api/social/states`、`/api/social/targets`、`/api/social/deepsleep`、`/api/social/schedule*`、`/api/social/proactive-send`、`/api/social/activity*` |
| 记忆与档案 | `/api/social/memory*`、`/api/social/state`、`/api/social/memory-stats`、`/api/profile` |
| 聊天记录 | `/api/social/chat-convs`、`/api/social/chat-messages`、`/api/social/chat-stats`、`/api/social/chat-delete`、`/api/social/chat-reindex`、`/api/social/history-*`、`/api/social/recent`、`/api/social/unread`、`/api/social/mark-read` |
| 媒体与表情 | `/api/social/send-*`、`/api/social/sticker-*`、`/api/stickers*`、`/api/social/collect-sticker`、`/api/images/*`、`/api/send/*` |
| 语音 | `/api/voice/config`、`/api/voice/voices`、`/api/voice/preview`、`/api/voice/test`、`/api/voice/send`、`/api/voice/transcribe` |
| 学习 | `/api/learning-config`、`/api/learning/slang`、`/api/learning/persona`、`/api/learning/persona-apply`、`/api/learning/portrait`、`/api/learning/submit-persona`、`/api/slang*` |
| 用量 | `/api/token-report`、`/api/token-stream`、`/api/token-reconcile` |
| 角色与权限 | `/api/role`、`/api/roles`、`/api/roles/create`、`/api/role-mode`、`/api/persona/switch`、`/api/whitelist`、`/api/blacklist` |
| NapCat | `/api/napcat/guard`、`/api/napcat/guard/heal`、`/api/napcat/qr`、`/api/napcat/login-stream`、`/api/napcat/tokens`、`/api/napcat/quick-password` |
| 监控 | `/api/social/tool-log`、`/api/social/tool-log/clear`、`/api/social/global-overview`、`/api/social/tunables`、`/api/pending`、`/api/social/feedback` |

鉴权：控制台端点要求 `x-console-token` 头或 `?token=` 查询参数；首页探活 `GET /` 免鉴权。默认按本机可信处理，不自动生成令牌，不写 `state/console-token`。MCP 工具侧回调控制台时同样携带该头。【据仓库记载】

### 4.4 桥与 NapCat 通道（OneBot v11）

表 4-9：OneBot 通道。口径：桥侧 URL 与令牌来自 `config.json` 的 `napcat.wsUrl` / `accessToken`。

| 方向 | 通道 | 说明 |
| --- | --- | --- |
| NapCat → 桥 | 反向 WebSocket `ws://127.0.0.1:3001` | 事件推送（消息、通知、撤回） |
| 桥 → NapCat | HTTP 动作接口 `http://127.0.0.1:3000` | 发送消息、群管理、QQ 空间、点赞 |
| 管理端 → NapCat | WebUI `http://127.0.0.1:6099` | 扫码登录与 OneBot 网络配置的界面入口（`/api/open` 给出 URL） |

出厂 OneBot 网络配置由 `ensureNapcatOnebotConfig()` 在 NapCat 启动后注入：HTTP 3000 绑定 `0.0.0.0`、WS 3001 绑定 `127.0.0.1`，令牌 `truefriend`。写入不改变 NapCat 的内存状态，因此可随时补写；令牌变更需重启 NapCat 才生效，文件已存在时以文件内容为准（§5.3）。【据仓库记载】

### 4.5 桥与隔离 DSH 通道

协议（官方 0.1.2 起，写于 `qq-bridge/src/dsh-client.js` 文件头）。

表 4-10：桥与 DSH 的协议面。口径：一元 RPC 的 body 为方法参数；流式事件统一经 WebSocket。

| 类别 | 形式 | 说明 |
| --- | --- | --- |
| 一元 RPC | `POST /api/<namespace>/<method>` | body 为参数；旧式点号端点 `/api/session.list` 已移除 |
| 流式事件 | WebSocket `/api/remote.mux` | 上行 `{type:'open', streamId, endpoint, payload:{args}}` |
| 审批与提问应答 | `POST /api/$events/result` | `{args:{clientId, eventId, outcome:{kind:'result', value}}}` |
| 鉴权 | 启动时打印的 `?token=` | 客户端先 `GET /?token=xxx` 换取 `dsh-auth-*` cookie（303 + `Set-Cookie`），此后 `/api` 与 WebSocket 均携带 cookie；无 token 的环境免鉴权 |

表 4-11：桥侧使用的 DSH 调用。口径：调用点按用途归类，参数只列关键字段。

| 调用 | 用途 | 依据 |
| --- | --- | --- |
| `sessions.prompt({sessionId, mode, content})` | 提示词投递；`mode` 语义见 §8.6 | `qq-bridge/src/core/prompt-deliver.js` |
| `session/selectModel`、`session/modelCatalog` | 模型选择与目录读取 | §8.8 |
| `workspace/archiveSession` | 空闲会话归档 | §8.9 |
| `events.mux` + `session/follow` | 事件泵与回合订阅 | `qq-bridge/src/core/mux.js:766`【已核验】 |

### 4.6 管理端与浏览器前端

表 4-12：前端通信与缓存。口径：轮询间隔为稳态与过渡期的两个取值。

| 项 | 取值或实现 |
| --- | --- |
| 同源 | 生产模式下前端产物由 `127.0.0.1:1921` 静态托管，`/api/*` 同源直取；开发模式下 Vite 运行于 5173，`/api` 代理到 1921（`vite.config.ts`） |
| 轮询 | `src/App.tsx` 对 `/api/state` 轮询：过渡期 1 200 ms、稳态 4 000 ms；预热窗 20 秒；ESC 返回首页 |
| 缓存 | `src/config-cache.ts` 两级缓存（模块内存 + `localStorage`，键 `moonbot.cfgcache.v1.<scope>::<key>`）；页面挂载先用真实缓存渲染，无缓存时不使用出厂默认值替代（渲染空值并禁用，等待回包） |
| 内嵌界面 | `src/pages/WebView.tsx` 以内嵌窗口打开 NapCat WebUI、DSH Web、桥控制台；`iframeBlocked` / `iframeBlockReason` 由后端在 `/api/open` 给出 |

### 4.7 管理端与目标机

表 4-13：SSH 通道构成。口径：隧道映射由 `tunnelMapFor()` 生成。

| 通道 | 用途 |
| --- | --- |
| `ssh2` 命令执行 | 探测、安装、systemd 操作、自检 |
| 本地监听隧道 | 13000 → NapCat WebUI、13001 → OneBot HTTP、13080 → DSH Web、13100 → 桥控制台 |
| 流式转发 | 打包产物不落目标机中间文件，直接写入解包命令的标准输入（`streamPipe`） |
| 断线自愈 | `ensureTunnels()` 每次检查四条隧道是否处于监听，缺失即重建 |

表 4-14：隧道状态的观测。口径：测量批次为原稿记录时点；对象为「连接已建立」标记与隧道实际监听状态。

| 批次 | 测量条件 | 方法 | 结果 |
| --- | --- | --- | --- |
| 原稿记录 | SSH 连接返回 `connected=true` | 检查四条本地端口是否处于监听 | 出现「连接为真而四条隧道均未监听」的状态，对端转发不可用；实现改为每次检查后重建缺失隧道 |

【据仓库记载】上表来源为 `docs/ARCHITECTURE.md` 原稿；本轮未复现该状态。

## 5. 首次启动状态机与鉴权

本章界定「该安装从未成功运行过一次」时的引导路径、全部凭据面及其存放与校验方、凭据写入与脱敏策略，以及凭据相关的现存约束。日常运行期的编排行为在 §3.7 界定。

### 5.1 管理端首次启动

表 5-1：管理端首次启动状态机。口径：进入条件为布尔判据，出口为该状态的唯一清除方式。

| 状态 | 进入条件 | 系统行为 | 出口 |
| --- | --- | --- | --- |
| 配置缺失 | `~/.qq-bridge-manager/config.json` 不存在 | `loadConfig()` 落 `DEFAULT_CONFIG`：`instances.dshIsolated{port:10721, profile:'web'}`、`instances.napcatLocal{webuiPort:6099, webuiToken:'truefriend', killOnExit:true}`、`instances.bridgeLocal{webuiPort:3100}`、`autoStartOnBoot:true`、`local` 端口表、默认 provider `deepseek-official`、默认 model `deepseek-v4-flash-vision-exp` | 首次保存后进入「已配置」 |
| 所有者标识未设置 | `ownerQQ` 为空 | 前端弹出首次运行引导（`getOwnerQQ` / `setOwnerQQ` → `/api/bridge/owner-qq`） | 写入所有者 QQ |
| NapCat 未就位 | `findNapcatOneKeyAll()` 未命中托管目录 | `/api/napcat/launchers` 列出候选；`/api/napcat/install-qq` 触发安装或解压 | 命中后 `napcat-local` 卡片可启动 |
| 实例未启动 | `instances.<key>.enabled !== true` | 首页三张卡片显示「未启动」；`scheduleAutoStart()` 不恢复该实例 | 用户触发启动或启动整套 |
| 就绪 | 端口或 HTTP 探活通过 | phase = `running`，卡片出现「打开」 | — |

### 5.2 隔离 DSH 首次启动

表 5-2：隔离 DSH 首次启动步骤。口径：步骤按执行顺序编号；步骤 3 的重启由 preset 加载需求决定。

| 步 | 行为 | 关键点 |
| --- | --- | --- |
| 1 | `startIsolatedDsh()` 先执行 profile 自愈（`healProfile()`） | 建立 `profiles/<profile>/`（`cordis.yml` + `package.json`）；必要时以 junction 从随包 dsh 发行面补齐 `node_modules`；把 `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` 写入 bundles 与 dependencies。缺少该步骤时 `qq-mode-console`（inject settings）与三组 `mcp-client`（inject tools）永久处于 pending，隔离 DSH 无法启动 |
| 2 | 以 `--profile web --port <port> --no-open --trusted-host …` 拉起 | 最多等待 60 秒探测端口 |
| 3 | 端口可用后判断引导标记 `<DSH_HOME>/qqbridge-setup.done` | 标记不存在 → 执行 `qq-bridge/scripts/setup-dsh.mjs --home <home> --profile <profile> --force`（注入 agent-presets 与 MCP 配置），成功后写入标记，并终止当前 DSH 后自动重启一次 |
| 4 | 标记已存在 | 仅进入在线状态，不重启 |

### 5.3 NapCat 首次启动

表 5-3：NapCat 首次启动步骤。口径：步骤 1 的单向性约束在 §5.4 的鉴权面清单中复述。

| 步 | 行为 | 关键点 |
| --- | --- | --- |
| 1 | 启动前预置 `webui.json` | 文件不存在且读不到实际令牌时写入 `{ token: <配置值>, loginRate: 10 }`；文件已存在时以文件为准，不回写配置值 |
| 2 | 注入出厂 OneBot 网络配置 | HTTP 3000 / WS 3001，令牌 `truefriend` |
| 3 | 以 `Start-Process -WindowStyle Hidden` 拉起 `NapCatWinBootMain.exe` | 带快速登录参数时附加 QQ 号 |
| 4 | 就绪判据 | WebUI 端口处于监听 = 已启动；3000 或 3001 任一处于监听 = 已登录。未登录时卡片提示等待扫码，二维码经 `/api/napcat/qr` 与 `/api/napcat/login-stream`（SSE）呈现 |

### 5.4 桥首次启动

`acquireLock()` 抢占 `state/bridge.lock`（以 `wx` 原子写入 PID，`qq-bridge/src/core/runtime.js:8`【已核验】）；已有实例存活则 `exit 2`。随后连接 OneBot WS、装载 `initXxxCore(cfg)`、异步执行 DSH 端自安装（§8.3）、按 `dsh-seq.json` 水位恢复事件流。【据仓库记载】

### 5.5 鉴权面清单

表 5-4：凭据面、存放与校验方。口径：生命周期列只描述与凭据有效性直接相关的约束。

| 面 | 凭据 | 存放 | 校验方 | 生命周期与约束 |
| --- | --- | --- | --- | --- |
| QQ 登录 | 登录票据（扫码或快速登录取得） | NapCat 落盘的 `napcat_<QQ>.json` 等；容器形态位于卷 `napcat-qq:/app/.config/QQ` | 平台 | 桥每次启动备份到 `<配置目录>/login-backup/<时间>`，只保留最近若干份；容器 `restart` 必须使用 `-t 30`，`stop` 的默认 10 秒会强制终止票据持有进程，恢复后需重新扫码 |
| NapCat WebUI | `webui.json` 的 `token` | `<NapCat 配置目录>/webui.json` | NapCat 进程内存 | 单向：仅在文件不存在时预置一次；文件存在即以其为准。运行期只使用启动时读入内存的值，改文件而不重启会导致 `token is invalid`，页面全部接口返回 `Unauthorized` |
| OneBot HTTP / WS | `onebot11*.json` 的 `network.httpServers[].token` / `websocketServers[].token` | 同一配置目录 | NapCat | 出厂注入值为 `truefriend`；改配置后必须重启 NapCat 才生效 |
| 隔离 DSH Web / API | 每次启动打印的 `?token=` | DSH 实例日志 | DSH | 先 `GET /?token=` 换取 `dsh-auth-*` cookie（303 + `Set-Cookie`），此后 `/api` 与 WebSocket 均携带 cookie；token 轮换或换取失败导致的 401 会强制更换 cookie 后只重试一次 |
| 隔离 DSH 模型密钥 | `KEY: value`（`refs:` 块） | `<DSH_HOME>/.credentials.yaml`（mode 600，另有 `.bak-<ts>` 备份） | DSH provider 的 `apiKeyEnv` | 由管理端从 `config.json` 摘出 `dsh.apiKey` 后写入；解析顺序见 §5.6 |
| 桥控制台 | `x-console-token` 头或 `?token=` | 配置项 `consoleToken`；不自动生成，不写 `state/console-token` | 桥 | 默认本机可信；`GET /` 探活免鉴权 |
| 会话令牌（agent token） | 等于群号或 QQ 号 | 唤醒正文 `[Token]` 行 | 桥 | 可预测，仅解锁会话级端点；不得作为密钥使用 |
| 学习会话令牌 | 32 位十六进制 | `state/learning-token` | 桥 | 不可预测、跨重启稳定，仅解锁 `/api/learning/submit-persona`；不并入 `KNOWN_AGENT_TOKENS`，以避免权限扩张 |
| 管理端 HTTP API | 无应用层鉴权 | — | — | 仅绑定 `127.0.0.1`；任何可访问本机回环的进程均可调用（§5.7） |
| SSH | 私钥（`authType: 'key'`）或密码（`authType: 'password'`） | 管理端 `config.json` 的 `servers[]` | 目标机 sshd | 密码以明文存储并明文返回；PAM 仅支持 `keyboard-interactive` 时走交互式应答分支 |

### 5.6 凭据写入链路

表 5-5：隔离 DSH 模型密钥的写入步骤。口径：步骤按执行顺序编号；步骤 5 为失败关闭（fail-closed）判定点。

| 步 | 行为 | 依据 |
| --- | --- | --- |
| 1 | `POST /api/bridge/config` 先把 `body.config.dsh.apiKey` 与 `clearApiKey` 从待落盘对象中移除 | 明文密钥不进入 `qq-bridge/config.json`（该文件参与同步与打包） |
| 2 | 目标环境变量名按三级解析（`providerApiKeyEnv()`）：隔离 DSH `settings.yaml` 的 `providers.<id>.apiKeyEnv` → 已知服务商别名表（`deepseek-official` / `deepseek` → `DEEPSEEK_API_KEY`；`xiaomi-token-plan-cn` → `XIAOMI_TOKEN_PLAN_CN_API_KEY`；`mimo` → `MIMO_API_KEY`）→ 按 id 推导 `<ID>_API_KEY` | 同上 |
| 3 | 改写逻辑位于 `server/iso-credential.js`（本地直写与服务端写盘共用，可单测）：定位 `refs:` 块（缩进感知）、按 YAML 标量规则加引号（`YAML_NON_STRING_WORDS` / `YAML_NUMBERISH` / `YAML_RADIX`），写前备份、写后 `chmod 600` | `server/iso-credential.js` |
| 4 | 格式自检（`validateCredentialDocument()`，`server/iso-credential.js:140`【已核验】）：必须含 `version`，顶层键只能是 `{version, refs, records}`，`refs` 值不得为空 | DSH 对扁平布局与未知顶层键直接拒绝 |
| 5 | 仅当 `.credentials.yaml` 已存在（隔离 DSH 至少成功启动过一次）才允许写入 | 文件缺失时失败关闭，并提示先启动一次隔离 DSH |
| 6 | 同一路由执行模型漂移自愈：每次保存以期望的 `provider` / `model` / `reasoningEffort` 核对隔离 DSH 的 `settings.yaml`，不一致则改写并后台重启隔离 DSH；仅当 `body.config` 存在时触发 | 避免无关保存触发重启 |

### 5.7 脱敏策略

表 5-6：脱敏策略与现存明文项。口径：策略列给出返回或记录的内容构成；现状列不做修饰性描述。

| 位置 | 策略 | 依据 |
| --- | --- | --- |
| 凭据状态查询 | 只返回 `{env, from, set, len}`，不返回值 | `isoCredentialStatus()` |
| 保存响应 | 返回脱敏后的 config（`dsh.apiKey` 置空）与 `apiKeyWrite` 的 `{ok, env, action, backup}` | `POST /api/bridge/config` 响应 |
| NapCat 令牌展示 | `maskNapcatToken()`：空值 → `''`；长度 ≤ 4 → `****`；否则首 2 位 + `****` + 末 2 位 | `server/index.js:7670` |
| 日志 | 令牌与密钥不落 `manager.log`；只记录写入的环境变量名与备份路径 | 各 `mlog()` 调用点 |
| 部署 | 目标机 `buildTargetDshHealScript()` 把 `.credentials.yaml` 权限从 666 修正为 600；DSH 拒绝加载对属主以外可读的凭据文件（报 `readable beyond its owner (mode 666)`） | `server/deploy.js` |
| 打包排除 | 本地打包路径排除 `state/bridge.lock`、`state/*.log`、`*.bak*` 等运行痕迹；`packLocalBridge` 的排除表由 `tools/test-bridge-pack-excludes-config.mjs` 守住「代码包不覆盖远端 `config.json`」 | `server/deploy.js`、`tools/` |

表 5-7：现存明文与未生效保护项。口径：条目为当前实现状态，未做收敛。

| 项 | 现状 | 收敛手段 |
| --- | --- | --- |
| `GET /api/config` 的 SSH 凭据 | 原样返回整份配置，其中含 `servers[].password` 与 `servers[].passphrase` 的明文；前端输入框为 `type="password"`，存储与传输仍为明文 | 后端只绑定 `127.0.0.1` |
| Windows 上的 `.credentials.yaml` 权限 | 管理端写入后调用 `chmod 600`；Windows 上该调用不改变 ACL，实际保护依赖 NTFS 默认 ACL | 【未核验】未在目标环境实测该文件的 ACL |

## 6. NapCat 守护与自修复

本章界定 NapCat 的四层守护：管理端进程内监护、关窗守卫、文件级自修、桥侧状态读取，以及随包 QQ 的窗口隐藏机制。部署阶段对 NapCat 的安装与容器处理在 §7.3 界定。

### 6.1 进程内监护

表 6-1：管理端进程内监护机制。口径：每行给出触发时机与判定所需的标记或函数。

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| 启动登记 | `napcatLaunchedThisProcess` / `napcatSpawnedPids` | 记录本次运行中由本进程拉起的 NapCat；是全部退出清理的前置判据 |
| 启动前快照 | `listNapcatProcsInDirs()` 的 `beforePids` | 与启动后做差集，避免把尚未退出的上一份进程计入本次启动（`collectNapcatPidsAfterLaunch()`） |
| 退出清理 | `killNapcatOnExitSync()` 等退出路径 | 首个判断为 `napcatLaunchedThisProcess`；为假时不处理任何 NapCat 进程 |
| 开关 | `killOnExitEnabled()`（`instances.napcatLocal.killOnExit`，默认 `true`） | 关闭后 `/api/shutdown` 不收 NapCat，响应返回 `napcatSkipped: true`；该开关同时以 `--kill-napcat 0/1` 传给守卫——打包版关窗走壳的 `taskkill /F`，本进程不执行任何代码，守卫是该路径上唯一可执行「收或不收」的组件 |
| 停止校验 | `stopInstance()` | 停止后校验端口是否真的不再监听；早期实现无条件返回 `success:true`，与进程名过滤缺口叠加后表现为「重启了但无响应」 |
| 后备终止 | `killByCmdline(marker)`（`server/index.js:2552`）【已核验】 | 按命令行关键字终止两种进程名（`node.exe` 与 `qbm-node.exe`）下的历史或游离进程 |

### 6.2 关窗守卫

关窗守卫为独立进程，不在应用进程树内；脱离手段见 §3.6。

表 6-2：关窗守卫的判据、策略与失败语义。口径：失败升级列给出失败后的动作，不包含重启行为。

| 项 | 值或行为 | 说明 |
| --- | --- | --- |
| 参数 | `--parent`、`--guard-file`、`--dirs`、`--dsh-port`、`--bridge-script`、`--kill-napcat`、`--grace`、`--log` | 由 `armNapcatGuardian()` 组装 |
| 轮询间隔 | 2 000 ms 检查父进程存活 | 父进程存活时不执行任何操作 |
| 宽限期 | `graceMs`，默认 30 000 ms（早期 6 000 ms） | 父进程消失后先等待宽限，再执行操作（`server/napcat-guardian.mjs:52`）【已核验】 |
| 接管保护 | 执行操作前重新读取 guard 文件确认归属 | 防止在管理端重启、新后端已接管时收掉新一套进程 |
| 清理顺序 | NapCat → 桥 → 隔离 DSH | 三段各自独立判定，前一段失败不影响后一段；清理不重试、不重启 |
| 匹配方式 | 托管目录前缀、桥的绝对路径、DSH 端口 | 精确匹配并排除自身（`NOT_SELF`）；`--dirs` 为空时不终止任何进程 |
| 失败升级 | 无重试循环；每段失败仅记日志后继续 | 守卫是一次性收尾，不是常驻健康检查。【未核验】日志轮转策略未在实现中体现 |
| 武装时机 | 启动时一次，并每 60 秒执行一次 `setInterval` 复查 | 条件见 §3.8 |
| 可观测 | `%USERPROFILE%\.qq-bridge-manager\logs\napcat-guardian.log`；管理端 `mlog()` 同步记录一行武装信息 | — |

守卫不重启任何组件。运行期重启由桥侧通告与管理端的启动 / 重启按钮承担。【据仓库记载】

### 6.3 文件级自修

NapCat Shell 目录在三种条件下会缺少文件：更新包解压不完整、安全软件删除、跨盘复制中断。缺失时的典型异常为 `ERR_MODULE_NOT_FOUND: conout-*.js`。【据仓库记载】

表 6-3：`server/napcat-repair.js` 的能力构成。口径：每行给出函数与判据，不含调用时序。

| 能力 | 实现 |
| --- | --- |
| 枚举 NapCat 应用目录 | `findNapcatApps({root})`，深度上限 8 层 |
| 判断是否缺件 | `checkNapcatApp()`：解析源码中的相对说明符（`relativeSpecifiers()` 识别 `from`、副作用 `import`、动态 `import()`、`require()` 四种写法），逐项确认文件存在 |
| 定位修复来源 | `findShellZip()`：从当前目录向上最多 10 层查找 `NapCat.Shell.zip` 与 `7z.exe` |
| 补齐缺失成员 | `repairNapcatApp()`：从 `NapCat.Shell.zip` 中抽取缺失文件 |
| 批量入口 | `ensureNapcatApps({root, fix, log})`；CLI 形式 `[--check\|--fix] [--root <dir>]`，缺件时退出码为 1（可被脚本与测试断言） |

管理端在拉起 NapCat 前先执行检查，结果经 `napcatRepairNote` 进入启动结果消息。【据仓库记载】

### 6.4 桥侧 NapCat 守护

表 6-4：桥侧守护的状态文件与默认参数。口径：参数取自 `core/napcat-guard.js` 的 `DEFAULTS`。

| 项 | 值 |
| --- | --- |
| 状态文件 | `state/napcat-guard.json` |
| 二维码 | `state/napcat-qr.png` |
| 容器规格 | `state/napcat-container-spec/` |
| 默认参数 | `{ enabled: true, probeIntervalMs: 60000, failThreshold: 2, cooldownMs: 600000, maxHealsPerHour: 3, restartGraceSec: 60, recoverWaitMs: 150000, autoHeal: null }`（`qq-bridge/src/core/napcat-guard.js:34`）【已核验】 |

表 6-5：桥侧守护的测量与结论。口径：测量批次为原稿记录时点；对象为 NapCat 登录接口的限流额度与探测路径的占用。

| 批次 | 测量条件 | 方法 | 结果 |
| --- | --- | --- | --- |
| 原稿记录 | NapCat 对登录接口的限流约为每 IP 10 次 / 60 秒，且与 WebUI 页面共用同一份额度 | 以登录接口作为健康检查周期性调用 | 探测消耗扫码所需额度。实现删除了该模块的主动探测与自动重启执行体（文件内 95-120 行给出说明），并删除管理端「每分钟验证一次 WebUI 令牌」的轮询 |

当前桥侧只保留两项职能：读取落盘的二维码、以 OneBot HTTP 查询登录状态。表 6-4 中的 `failThreshold` / `cooldownMs` / `maxHealsPerHour` / `restartGraceSec` / `recoverWaitMs` 保留为配置面，但当前没有执行者，属于历史契约残留（§12）。【已核验】以 `qq-bridge/src/core/napcat-guard.js:34` 的 `DEFAULTS` 与文件内的删除说明比对。

表 6-6：NapCat 恢复手段。口径：三者的触发面与等待上限不同，不构成自动重试链。

| 手段 | 触发面 | 行为 |
| --- | --- | --- |
| 启动 / 重启卡片 | 管理端界面 | 走实例编排状态机（§3.7） |
| `POST /api/napcat/guard/heal` | 桥控制台 / 管理端代理 | 重启容器并等待登录恢复 |
| `POST /api/napcat/quick-password` | 桥控制台 / 管理端代理 | 重建容器，最长 3 分钟 |

### 6.5 随包 QQ 的窗口隐藏

需求为：随包 QQ 的窗口不出现、不进入任务栏。实现为启动前武装的常驻 PowerShell 观察者（`qqWindowHiderScript()` + `armQqWindowHider()`，`server/index.js:1910`【已核验】）。

表 6-7：窗口隐藏器参数与机制。口径：常量取自 `QQ_HIDER_DEFAULTS`（`server/index.js:1336`）【已核验】。

| 项 | 值或行为 |
| --- | --- |
| 参数 | `QQ_HIDER_DEFAULTS = { budgetMs: 43200000, pollMs: 200, burstMs: 50, burstWindowMs: 5000, readyTimeoutMs: 2500 }` |
| 隐藏手法 | `ShowWindow(h, 0)` + `SetWindowPos(…, SWP_HIDEWINDOW\|SWP_NOMOVE\|SWP_NOSIZE\|SWP_NOZORDER\|SWP_NOACTIVATE)` 双重调用；窗口类样式在 `WS_EX_APPWINDOW` 与 `WS_EX_TOOLWINDOW` 之间互换；`ITaskbarList::DeleteTab` 移除任务栏按钮 |
| 路径守卫 | 只处理可执行文件路径位于本 Shell 目录之下的 QQ 进程；取不到 `Path` 的进程一律跳过；前缀比较大小写不敏感并按目录边界对齐（补分隔符，使 `…\Shell` 不匹配 `…\ShellOther`） |
| 启动器 pid 登记 | `seedQqWindowHiderPids()`：启动器常在数百毫秒内退出，先将本进程 spawn 的 pid 落盘，避免其带出的窗口无法识别 |
| 控制台窗口扫描 | `consoleScanMs = 60000`（对控制台类窗口的额外扫描窗口） |
| 退出条件 | 预算 12 小时；父进程连续 150 次探测不到（约 30 秒）时 `exit 0`；观察者就绪标记最多等待 `readyTimeoutMs` |
| 后备路径 | 观察者无法启动（PowerShell 缺失、`Add-Type` 编译失败、临时目录不可写）时，退回 `hideBundledQqWindows()` 的一次性轮询 |

表 6-8：窗口隐藏器文档一致性。口径：测量批次 2026-09-25；对象为 `server/index.js` 中 `qqWindowHiderScript` 附近的注释与 `QQ_HIDER_DEFAULTS.budgetMs`。

| 项 | 方法 | 结果 |
| --- | --- | --- |
| 注释与常量的一致性 | 比对注释文本与 `QQ_HIDER_DEFAULTS.budgetMs` | 注释原记「观察 120 秒」，实际默认预算为 43 200 000 ms（12 小时），退出条件由父进程存活守卫承担；两处注释已于 2026-09-25 更正。以常量为准 |

## 7. 远程克隆部署

本章界定 `server/deploy.js` 的 SSH 克隆部署：阶段划分、打包内容与排除项、目标端目录与 systemd 单元、回滚与能力保护、失败恢复。管理端本机侧的 SSH 路由与隧道在 §4.7 界定。

### 7.1 阶段划分

部署语义为：目标机（新机）获得源机（模板机）的完整能力。`deploy.js` 顶部注释给出 0~6 的阶段划分，实现中每步写日志，图形界面轮询 `/api/ssh/deploy/status`。

表 7-1：部署阶段。口径：阶段编号沿用实现注释；「关键实现」列给出该阶段的函数或判据。

| 阶段 | 内容 | 关键实现 |
| --- | --- | --- |
| 0 校验 | 源机与目标机均在服务器列表内；连接两端；探测端口（连不上时自动改用上次成功的端口） | `step()` / `safely()` |
| 1 目标机基础环境 | nodejs / npm / docker / python3 的探测与安装（apt → nodesource → 官方 tarball → 发行版包，多路后备）；全局 dsh CLI；`mcp-compressor`（pip 安装，失败不影响主流程） | `ensureNode()`、`ensureDocker()`、`localDshVersion()` |
| 2 源机短暂停机并打包 | 停止 dsh-web / napcat / bridge，随后生成 7 个 stage 包 | `buildStagePlan()`（远端源）或 `buildLocalStagePlan()`（本机源） |
| 3 源机恢复 | 立即恢复阶段 2 停止的三个服务（总停机时长约等于打包耗时，与传输带宽无关） | 与阶段 2 成对出现 |
| 4 流式转发与解包 | 逐包经管理端中转，直接写入目标机解包命令的标准输入，不在目标机留中间文件 | `streamPipe`；传输或解包失败重试一次 |
| 5 目标机落地 | 写 systemd 单元；建立或沿用 NapCat 形态（原生优先、容器为后备）；灌入 QQ 登录态；调整桥配置指向目标机 DSH 端口；能力核对；启动自检 | `installNapcatNative()`、`NAPCAT_MODE_CMD` 探针、`buildTargetDshHealScript()` |
| 6 清理 | 删除源机 stage 目录，断开连接 | — |

表 7-2：阶段 5 内的自检点。口径：每行给出该项的判据与不通过时的处理。

| 自检点 | 判据 | 不通过时的处理 |
| --- | --- | --- |
| 隔离 DSH 启动 | 先执行 `daemon-reload` 与 `restart`，随后确认 `is-active` 且 3080 端口有应答（401 计入存活——无 token 的 DSH 一律返回 401；`down` 与 `000` 计为失败） | 记为部署失败 |
| 桥配置改写 | `dsh.baseUrl = http://127.0.0.1:3080`（本机为 10721） | 强制写入 |
| 能力核对 | 目标机脚本输出 pixiv / 语音 / 白名单 / 记忆 / 表情库 / 画像的到位情况 | 退出码非 0 时只记警告 |
| systemd 单元同步 | 源机缺少 `dsh-web.service` 时现场生成 | 按需生成 |

表 7-3：阶段 5 启动判据的观测。口径：测量批次为原稿记录时点；对象为 3080 端口的可达性与服务状态判定的差异。

| 批次 | 测量条件 | 方法 | 结果 |
| --- | --- | --- | --- |
| 原稿记录 | 服务进程处于运行状态 | 从管理端请求 DSH Web 端口 | 出现「进程存活但管理端始终无法连接」的状态；实现改为显式 `daemon-reload` 与 `restart`，并当场确认 `is-active` 与端口应答 |

【据仓库记载】上表来源为 `docs/ARCHITECTURE.md` 原稿；本轮未复现该状态。

### 7.2 打包内容与排除项

表 7-4：远端源机路径的包构成（`buildStagePlan()`）。口径：落点为服务端绝对路径；排除列给出该包内被剔除的内容。

| 包 | 内容 | 落点 | 排除 |
| --- | --- | --- | --- |
| `qq-bridge.tar.gz` | 桥整棵树（代码、`config.json`、`state/` 记忆与画像数据） | `/root/qq-bridge` | `.git`、`node_modules`、`state/bridge.lock`、`state/bridge*.log`；原生模块（如 sharp）在目标机重新 `npm install` |
| `dsh-home.tar.gz` | 隔离 DSH 的整个 `DSH_HOME`（settings / credentials / agent-presets / profiles / sessions / storages / meme-packs） | `/root/.dsh` | 无 |
| `napcat-config.tar.gz` | NapCat 配置目录（含登录令牌文件） | 原生 → `/opt/napcat/config`；容器 → `/root/napcat/config` | 无 |
| `napcat-app.tar.gz` | `/opt/napcat` 应用本体（含自编译的 `napcat.mjs` 与防掉线补丁） | `/opt/napcat` | `cache`、`config`、`*.db*`；目标机已有 `napcat.mjs` 时跳过 |
| `qqdata.tar.gz` | QQ 登录态（免扫码快速登录） | 原生 → `/home/qq/.config/QQ`（`chown qq:qq`）；容器 → 卷 `napcat-qq` | 由 `opts.qqData === false` 关闭 |
| `dsh-polyfill.tar.gz` | 反向代理脚本目录 | `/root/dsh-polyfill` | 无 |
| `dsh-meme.tar.gz` | 表情库插件目录 | `/root/dsh-meme` | 可选（不存在则不打包） |

表 7-5：本机源路径的排除项（`buildLocalStagePlan()` + `packLocalStage()`）。口径：本机为开发工作区，排除项粒度高于远端源路径。

| 排除项 | 原因 |
| --- | --- |
| `node_modules`、`.git` | 体积；原生模块需在目标机重装 |
| `state/bridge.lock`、`state/*.log` | 运行期状态 |
| `state/agents/*/node_modules` | DSH 工作区内的依赖树 |
| `tests/` | 开发用 |
| `*.bak`、`*.bak-*`、`state.bak-*`、`state.old-*`、`state.merge-stage-*` | 见下表 |

表 7-6：历史备份文件的测量。口径：测量批次为原稿记录时点；对象为本机工作区的备份文件集合。

| 项 | 方法 | 结果 |
| --- | --- | --- |
| 备份文件累计体积 | 统计匹配上述模式的文件大小 | 41.4 MB |
| 备份文件的内容属性 | 抽样检查 `config.json.bak-*` | 30 余份，每份均含所有者 QQ、NapCat 令牌与服务器地址；目标机不需要这些内容 |

`packLocalStage()` 同时报告「跳过的悬空链接」（指向本机已不存在路径的符号链接）。本机打包路径的解包脚本在覆盖前把目标机原有 `config.json` 与 `state/voice-config.json` 备份到 `/root/qqbridge-prev-<TS>/`，并打印备份目录名。【据仓库记载】

两侧路径的语义差异：本机打包路径为「整套复刻」（本机配置覆盖目标机）；远端源机路径为「换代码不换身份」（目标机配置优先，见 §7.4）。【据仓库记载】

### 7.3 目标端目录与 systemd

表 7-7：目标机目录。口径：路径为服务端绝对路径；内容列只列与部署直接相关的条目。

| 路径 | 内容 |
| --- | --- |
| `/root/qq-bridge` | 桥整棵树（源码、`state/`、`config.json`、`plugins/`、`tools/`） |
| `/root/.dsh` | 隔离 DSH home：`sessions/`、`storages/`、`profiles/web/`、`cordis.patch.yml`、`.credentials.yaml`、`dsh-web.log` |
| `/opt/napcat` | NapCat 应用（原生部署） |
| `/opt/napcat/config` 或 `/root/napcat/config` | NapCat 配置目录（原生与容器两种形态） |
| `/root/dsh-meme` | 表情库（`dsh-meme.tar.gz` 的落点） |
| `/root/.qqbridge-clone` | 克隆部署的 stage 目录（打包产物与 `napcat-mode` 标记），收尾时删除 |
| `/root/qqbridge-keep-<TS>` | 部署前对目标机原有 `config.json` / `persona.md` / `state/` 的能力保护备份（§7.4） |
| `/root/qqbridge-prev-<TS>` | 本机打包路径下的旧配置备份落点（`buildLocalStagePlan()`） |

表 7-8：systemd 单元。口径：单元不存在时部署脚本的容错行为在「说明」列给出。

| 单元 | 说明 |
| --- | --- |
| `dsh-web.service` | 隔离 DSH；`Environment=DSH_HOME=/root/.dsh`、`EnvironmentFile=-/etc/qq-bridge.env`、`ExecStart=<dshBin> --profile web --port 3080 --no-open --trusted-host 127.0.0.1:3080`；标准输出与错误落 `/root/.dsh/dsh-web.log` |
| `napcat.service` | NapCat 原生部署；源机没有该单元时由部署脚本现场生成 |
| `dsh-polyfill.service` | 可选；不存在时不计为失败 |

表 7-9：NapCat 两种部署形态。口径：形态由探针判定，不作为配置项。

| 形态 | 构成 | 探针判定 |
| --- | --- | --- |
| 原生 | 官方 Linux QQ deb + `/opt/napcat` + systemd 单元 + Xvfb + 非 root 用户 `qq`（`installNapcatNative()`） | `systemctl cat napcat.service` 成功 |
| 容器 | `mlikiowa/napcat-docker:latest`，卷 `napcat-qq:/app/.config/QQ`，端口 `3000/3001/6099` | `docker ps -a --filter name=^napcat$` 命中 |

探针实现（`NAPCAT_MODE_CMD`）。

```bash
if systemctl cat napcat.service >/dev/null 2>&1; then echo native;
elif docker ps -a --filter name=^napcat$ --format "{{.Names}}" | grep -q napcat; then echo docker;
else echo none; fi
```

启停统一经 `napcatCtlCmd()`（systemd 优先），与 `server/index.js` 的控制路径同形状。形态由 `<stageDir>/napcat-mode` 标记驱动（`native` / `docker`），解包脚本据此选择配置落点与登录态落点。【据仓库记载】

表 7-10：容器形态的路径映射配置。口径：配置段取自 `config.json` 的 `napcat` 键，由 `qq-bridge/src/lib/napcat-file.js` 消费。

```json
"napcat": {
  "imageFileMode": "auto",
  "tmpDir": "/root/napcat/config/moonbot-tmp",
  "dockerPathMap": [{ "host": "/root/napcat/config", "container": "/app/napcat/config" }]
}
```

表 7-11：路径映射缺失的观测。口径：测量批次为原稿记录时点；对象为容器形态下 NapCat 读取宿主路径的能力。

| 批次 | 测量条件 | 方法 | 结果 |
| --- | --- | --- | --- |
| 原稿记录 | NapCat 运行于容器内，配置未提供 `dockerPathMap` | 由模型侧请求发送本地图片 | NapCat 报 `文件处理失败: 识别URL失败, uri= /root/...`；本机裸机部署时同机可读，故该缺陷只在容器形态出现。克隆脚本会自动改写该键 |

### 7.4 回滚、备份与能力保护

表 7-12：能力保护与回滚机制。口径：语义列为该机制对目标机既有数据的处置方式。

| 机制 | 行为 |
| --- | --- |
| 能力保护目录 | `/root/qqbridge-keep-<TS>/`：解包前保存目标机原有 `config.json`、`persona.md`、`state/` |
| 恢复策略 | 解包后由 `buildDeployKeepScript()` 执行逐键合并（目标机取值优先），再把 `state/` 覆盖回来；语义为「部署更换代码，不更换身份与记忆」 |
| 整体克隆开关 | 目标机上设置 `QQB_DEPLOY_WHOLE_CLONE=1` 时回到整套复刻行为 |
| 旧配置备份 | 本机打包路径的 `/root/qqbridge-prev-<TS>/`（只存 `config.json` 与 `state/voice-config.json`） |
| 后备路径 | 旧 keep 脚本通过 `/tmp/qbm-deploy-keep.js` 在目标机执行后立即删除 |

表 7-13：能力保护的历史行为差异。口径：测量批次为原稿记录时点；对象为目标机既有配置与 `state/` 在部署前后的内容。

| 批次 | 测量条件 | 方法 | 结果 |
| --- | --- | --- | --- |
| 原稿记录 | 使用早期部署实现（仅备份 `config.json` 与 `voice-config.json` 到 `/root/qqbridge-prev-<TS>/`） | 部署后比对目标机配置与 `state/` | 备份未回写，目标机的 pixiv cookie、语音密钥、白名单、工具档位以及 `state/` 中的记忆与画像被覆盖。当前实现改为逐键合并并回写 `state/` |

### 7.5 失败恢复

表 7-14：失败点与处理。口径：处理列给出该失败点终止流程或继续执行。

| 失败点 | 处理 |
| --- | --- |
| 传输或解包失败 | 自动重试一次（部署日志打印对应行） |
| npm 全局安装 dsh 失败 | 尝试建立 `/usr/bin` 软链；仍失败则只记警告并继续（由后续日志暴露真实原因） |
| 原生 NapCat 安装失败 | 回退容器路径（容器已创建，待灌数据） |
| `mcp-compressor` 安装失败 | 记警告并继续（仓库内无代码依赖它；工具描述压缩走 `social.slimTools`） |
| `dsh-polyfill` 单元不存在 | 不计为失败 |
| 源机停机阶段出错 | 记录输出后继续打包；阶段 3 无论如何都尝试恢复源机服务 |
| 部署中断 | 源机 stage 目录残留（可手工清理）；目标机处于新旧混合状态，`/root/qqbridge-keep-<TS>/` 仍在，可人工恢复；再次部署会执行同样的保护流程 |

表 7-15：部署完成后的自愈脚本（`buildTargetDshHealScript()`）。口径：三项在目标机首次启动前后执行。

| 项 | 修复内容 |
| --- | --- |
| 插件 bundle 符号链接 | `<home>/plugins/<name>` 与 `<home>/profiles/node_modules/<name>` 被拷贝损坏或断开时重建 |
| 凭据文件权限 | `.credentials.yaml` 由 666 修正为 600；DSH 拒绝加载并报 `readable beyond its owner (mode 666)` |
| MCP 命令路径 | 从 Windows 迁移的路径（形如 `D:\...\qbm-node.exe`）在 Linux 上无效，改写为可执行路径 |

## 8. DSH 集成与上下文压缩接口

本章界定桥与隔离 DSH 的集成面：隔离 home 的解析与目录形态、装配流程、会话与预设绑定、提示词投递与回合保持机制、投递路径的完整事件流、上下文压缩接口、工具面构成、凭据注入、会话归档，以及 token 计量与对账。DSH 的协议细节在 §4.5 界定。

### 8.1 隔离 home 的目录形态

```text
<DSH_HOME>/
├─ settings.yaml                 ← agent-default-model（provider / model / reasoningEffort）
├─ .credentials.yaml             ← 模型密钥（refs 块，mode 600）
├─ cordis.patch.yml              ← home 级：压缩与剪枝策略
├─ profiles/<profile>/           ← cordis.patch.yml（MCP 挂载 + preset overlay）、package.json、cordis.yml、node_modules
├─ plugins/                      ← 内置插件符号链接（qq-mode-console / dsh-memory）
├─ sessions/                     ← 会话日志（DSH 自有格式，桥不写）
├─ storages/session_projcache/   ← 会话投影缓存（token 对账读取）
├─ meme-packs/                   ← 表情包数据
├─ .qq-bridge-dsh-installed.json ← 桥的安装标记（INSTALL_VERSION）
└─ qqbridge-setup.done           ← 首次 preset 注入的引导标记
```

### 8.2 隔离 home 的解析顺序

表 8-1：两条并行的 home 解析链。口径：环境变量优先于配置文件；两条链的服务对象不同。

| 解析链 | 实现 | 顺序 |
| --- | --- | --- |
| 管理端 | `core/tunables.js` 的 `resolveIsolatedDshHome()`（`qq-bridge/src/core/tunables.js:136`）【已核验】 | 环境变量 `QQB_DSH_HOME` → `DSH_ISOLATED_HOME` → 管理器配置中的隔离 home（`~/.qq-bridge-manager/dsh-isolated-home-official`，其次 `dsh-isolated-home`） |
| 桥 | `lib/dsh-side.js` 的 `resolveDshTarget()` | 环境变量 `QQB_DSH_HOME` → 项目内 `.runtime/dsh-isolated-home` → 管理器配置 `instances.dshIsolated.isolatedHome` → 项目默认；在 `win32` 上拒绝以桌面端 `%APPDATA%\DeepSeek Harness\dsh-home` 为目标（`isDesktopDshHome()`） |

表 8-2：home 解析的测量与结论。口径：测量批次 2026-09-25；对象为写死的路径常量与管理器实际启用的目录。

| 批次 | 测量条件 | 方法 | 结果 |
| --- | --- | --- | --- |
| 2026-09-25 | 桥侧曾写死 `~/.qq-bridge-manager/dsh-isolated-home`，而管理器启用 `…-official` | 比对写死常量与 `instances.dshIsolated.isolatedHome` 的实际取值 | 管理端修改的模型配置未到达隔离 DSH；写死常量已移除，改走上述解析链 |

桥的项目内默认（`<repo>/../.runtime/dsh-isolated-home`）与管理端配置的 `…-official` 是两份候选，实际生效取决于 `QQB_DSH_HOME` 与管理器配置；两份候选不会自动对齐（§12）。【未核验】

### 8.3 装配流程

`qq-bridge/src/bridge.js` 启动时以异步、幂等、非阻塞方式执行三项装配。

表 8-3：DSH 端自安装步骤。口径：三项均每次启动执行，不依赖安装标记。

| 步 | 行为 | 设计依据 |
| --- | --- | --- |
| 1 | `installPresets(target)`：每次启动刷新 preset | preset 是桥自带的代码资产（persona、`[WAKE TYPES]`、`[RULES]`），不属所有者数据。早期实现「装过一次即由标记全跳过」，导致修改 `agent.cordis.yml` 后重启桥不会装入新 preset |
| 2 | `watchOverrideFiles()`：监视 `persona.md` 与 `speech-rules.md`，变更后重新合成进已安装的 preset | `qq-bridge/src/lib/preset-compose.js:123`【已核验】 |
| 3 | `ensureBuiltinPlugins(target)`：每次启动幂等装配（link + profile 注册 + settings 的 memory 段） | 该步骤不能只放在被安装标记拦截的 `installToIsolatedDsh()` 内，否则既有安装无法升级 |

表 8-4：两份 `cordis.patch.yml`。口径：配置层顺序为 bundles → profile 级 → home 级 → `--patch`。

| 文件 | 内容 | 维护方 |
| --- | --- | --- |
| `<home>/profiles/<profile>/cordis.patch.yml` | agent-presets overlay 与三组 MCP server（含压缩代理参数） | `lib/dsh-side.js` 的 `patchProfileCordis()`（`qq-bridge/src/lib/dsh-side.js:302`）【已核验】 |
| `<home>/cordis.patch.yml`（home 级） | 上下文压缩与工具结果剪枝策略 | `lib/dsh-compaction.js` 的 `syncDshCompactionPatch()`（`qq-bridge/src/lib/dsh-compaction.js:198`）【已核验】 |

写入 home 级文件不影响承载 MCP 挂载的 profile 级文件。profile 的 `patchReload: live` 同时监视 home 级 patch 文件，因此写入后不必重启 DSH。home 级内容以 `# === qq-bridge compaction BEGIN/END ===` 标记包裹，只替换标记之间的段落，用户自有 overlay 原样保留；profile 级以 `# === qq-bridge MCP BEGIN/END ===` 包裹，三组 MCP server 的 `env` / `command` / `args` 全部位于其中，`toolCallTimeoutMs: 725000` 只加在 `mcp-napcat` 上。【据仓库记载】

### 8.4 会话日志的写入边界

桥不直接改写 DSH 的会话日志。依据写于 `lib/dsh-compaction.js:4-9`，来自对 DSH 0.1.2-rc.1 源码的阅读。

表 8-5：会话日志不可外部写入的四条依据。口径：每行给出该依据的对象与结论。

| 项 | 依据 |
| --- | --- |
| 历史来源 | `dsh-session`：模型历史由内存日志经 `deriveMessages()` 派生，文件仅在冷恢复时读取；改文件对运行中会话无影响 |
| 文件格式 | `dsh-session-persistence-jsonl`：日志为 seq 连续的仅追加记录，删行触发 `corrupt session log: seq gap`；默认 zstd 帧带校验和，正文改动导致校验失败 |
| 写入方约束 | 实现注明「每个会话一个活动写入方」，外部同时写入会相互冲突 |
| 受支持的裁剪路径 | 仅一条：由 DSH 自身通过 surface `replace` 改写历史，即 `dsh-compaction-tool-result-pruner`（剪枝）与 `dsh-compaction-basic`（摘要） |

表 8-6：压缩插件的硬约束。口径：约束不满足时插件拒绝加载，隔离 DSH 无法启动。

| 插件 | 约束 |
| --- | --- |
| `compaction-basic` | `retainRatio` 必须小于 `thresholdRatio` 解析出的阈值 |
| `tool-result-pruner` | `headChars + 标记 + tailChars ≤ thresholdChars`；标记为 `"\n\n[... tool result middle pruned ...]\n\n"`，与 DSH 内的 `PRUNE_MARKER` 逐字一致 |

`normalizeCompaction()` 保证上述两条恒成立，被夹紧时写日志说明。【据仓库记载】

表 8-7：压缩插件启用状态的测量。口径：测量批次为原稿记录时点；对象为本机隔离 home 的会话日志与 `buildCompactionRows()` 的输出行。

| 批次 | 测量条件 | 方法 | 结果 |
| --- | --- | --- | --- |
| 原稿记录 | web profile 下 `compaction-basic` 与 `tool-result-pruner` 默认 `disabled: true`（归 host plane 所有） | 检索本机隔离 home 的 86 个会话日志中 `compaction/*` 事件 | 事件数为 0，配置正确的自动压缩未执行。实现改为在 `buildCompactionRows()` 中显式写入 `disabled: false`（`qq-bridge/src/lib/dsh-compaction.js:112-123`）【已核验】 |

### 8.5 内置插件

表 8-8：三组内置插件。口径：插件经符号链接接入 DSH。

| 插件 | 作用 |
| --- | --- |
| `dsh-qq-hold` | 提供 `agent/turn-stopping` 钩子的时序闸门，暴露 `POST /api/qq/turn-hold`（由 `core/console-server.js` 接收） |
| `qq-mode-console` | 模式控制台 |
| `dsh-memory` | 长期记忆插件的 `remember` / `recall` 工具；随包 vendored |

`plugins/*` 经符号链接接入 DSH：`<home>/plugins/<name>` 与 `<home>/profiles/node_modules/<name>` 均指向 `qq-bridge/plugins/<name>`。`server/deploy.js` 的克隆脚本处理同样的两处链接；服务端另有 `buildTargetDshHealScript()` 修复被拷贝损坏或断开的链接（§7.5）。【据仓库记载】

### 8.6 投递路径与回合保持

本节界定一条入站 QQ 消息从归一化到出站的完整路径，以及回合保持与在途注入机制。该机制服务于同一目标：使消息以最小延迟与最小令牌消耗进入模型。

#### 8.6.1 入站归一

入口位于 `qq-bridge/src/bridge.js`。

表 8-9：入站事件绑定。口径：行号为工作树状态，函数名是稳定锚点。

| 事件 | 处理入口 | 位置 |
| --- | --- | --- |
| 私聊消息 | `handleIncoming('private', user_id, event, cfg)` | `bridge.js:575-578` |
| 群消息 | `handleIncoming('group', group_id, event, cfg)` | `bridge.js:579-582` |
| `notify` 通知 | 拍一拍与输入状态 | `bridge.js:583-586` |
| 撤回 | 标记 `[已撤回]` 并落库 `chat_messages.recalled_at` | `bridge.js:589-614` |

表 8-10：`handleIncoming` 的处理步骤（`qq-bridge/src/core/mux.js:299`）【已核验】。口径：步骤按实现顺序编号，顺序本身构成设计约束。

| 步 | 行为 | 位置 |
| --- | --- | --- |
| 1 | `convKey(kind, id)` 生成会话键 `private:<QQ>` / `group:<群号>`；模式不允许时直接忽略 | `mux.js:296-300` |
| 2 | 生成两套正文：`textContent`（含 `[引用 X：…]`，用于判定指代对象）与 `plainContent`（仅本条文本，用于命令与指向性判定） | `mux.js:309-310` |
| 3 | 私聊违法或诈骗内容自动删除好友并拉黑（`social.autoFriendGuard`） | `mux.js:312-322` |
| 4 | 抽取媒体段与文件段，按 `message_id` / `message_seq` 存入 `messageMediaStore`（超过 `MAX_MEDIA_STORE_PER_KEY` 时丢弃最旧条目） | `mux.js:323-341` |
| 5 | 判定引用对象是否为机器人自身（`isQuoteTargetSelf`）；该判定必须早于空文本过滤，否则「仅引用不附文」的消息被丢弃 | `mux.js:344` |
| 6 | 入站幂等去重 `isDuplicateInbound(key, messageId)`（`mux.js:281`）【已核验】，避免重复入库、重复唤醒、重复回复 | `mux.js:347-350` |
| 7 | 存在挂起提问时先作为回答消费；静默模式只记录不投递；角色切换、人格学习、画像学习、斜杠命令在此分流 | `mux.js:356-540` |

#### 8.6.2 唤醒判定

`evaluateWakeTrigger()`（`qq-bridge/src/core/wake-send.js:182`）【已核验】返回原因字符串，该字符串成为注入正文中的 `[Wake …]`。

表 8-11：唤醒判定的次序。口径：判定顺序构成设计约束，修改前须阅读实现注释。

| 序 | 触发类型 | 说明 |
| --- | --- | --- |
| 1 | `private` | 私聊消息一律触发 |
| 2 | 睡眠窗口 | 群聊处于睡眠窗口时只放行 @ 或引用机器人，其余不投递 |
| 3 | @ / 引用优先于 `anyMessage` | 次序要求：`anyMessage` 前置时 @ 被标记为 `anyMessage`，而免打扰时段只放行真实触发类型，导致群内 @ 无响应。该次序于 2026-09-19 修正 |
| 4 | 其余触发类型 | `nameMention`（点名）、`keyword:<词>`（短英文或数字关键词按词边界匹配，避免 `ADS` / `BDSM` 误触发）、`question`（`isDirectedAtAi`）、`topic`（AI 或技术话题接话，正则 `TOPIC_WAKE_RE`）、`speaker:<昵称>`、`probability` |

#### 8.6.3 投递执行

表 8-12：唤醒调度与投递环节。口径：每行给出该环节的入口函数与关键常量。

| 环节 | 文件与入口 | 说明 |
| --- | --- | --- |
| 唤醒调度统一入口 | `core/social-state.js` 的 `scheduleWake(key, reason)`（`social-state.js:854`）【已核验】 | 合并窗、免打扰、忙碌分流、轮换判定均在此路径上 |
| 投递看门狗 | `core/social-state.js` 的 `startDeliveryWatchdog()`（`social-state.js:1052`）【已核验】 | 每 20 秒扫描一次；`WATCHDOG_DEFAULT_OVERDUE_MS = 25000`、`WATCHDOG_DEFAULT_MIN_RETRY_MS = 60000`（`social-state.js:1001-1002`）【已核验】。判据为 `_wakeIntendedSeq`（桥计划交付的最高 seq），不采用「是否已被回复」：模型查看后选择不回复属正常，未被查看必须被检出 |
| 提示词组装 | `core/wake-send.js` 的 `buildWakePrompt(key, reason)`（`wake-send.js:433`）【已核验】 | 见 §8.6.4 |
| 投递执行 | `core/prompt-deliver.js` 的 `deliverPromptNow()`（`prompt-deliver.js:114`）【已核验】 | 经 `ensureSession()` 获取 sessionId，超时 30 秒；超时或失败时 `quarantineSession()` 隔离该会话 |
| DSH 调用 | `prompt-deliver.js:158` | `api.sessions.prompt({ sessionId, mode: 'steer', content })` |
| 事件泵 | `core/mux.js` 的 `pumpMux()`（`mux.js:766`）【已核验】 | 以 `api.events.mux()` 逐帧处理 `session/event` |

表 8-13：投递模式的选择依据（`prompt-deliver.js:137-157`）。口径：两种模式的语义差异来自 DSH 的 inbox 队列结构。

| 模式 | DSH 侧路径 | 取用时机 | 结论 |
| --- | --- | --- | --- |
| `queue` | `agent.followup()` → inbox 的 `next-turn` 队列 | 仅在回合循环的下一次迭代被 claim | 当前回合不结束时（模型处于长轮询，或进程重启后停留在 running），该消息永久停留于 `next-turn`，模型不可见且桥不接收任何事件 |
| `steer` | `agent.steer()` → inbox 的 `next-step` 队列 | `inbox.claim()` 总是先取走全部 `next-step` | 回合进行中则在下一个 step 边界交付；agent 空闲则立即开回合并取走。该模式为全定义，不存在搁浅状态 |

投递队列（`prompt-deliver.js:17` 起）【已核验】：`QUEUE_MAX = 50`，同 key 去重，退避为 `min(3000·2^(n-1), 60000)`（`prompt-deliver.js:97`）【已核验】，连续失败 5 次后降为每 60 秒一次。DSH 未就绪时消息入队不丢弃，就绪后按序补投（`flushQueue`）。【据仓库记载】

#### 8.6.4 注入正文构成

本节界定注入正文的构成与按需注入判据。唤醒正文只携带数据行；行为规则全部位于预设的系统提示词（`[WAKE TYPES]`）。正文骨架由 `buildWakePrompt()` 组装（`wake-send.js:400-550`）。

表 8-14：注入正文的行构成。口径：位置列给出组装点行号。

| 行 | 含义 | 位置 |
| --- | --- | --- |
| `[Token] <令牌>` | 本会话当前有效令牌（发送类工具需要） | `wake-send.js:415` |
| `[Session] <key>` | 确切的会话键；工具层不推断 key，缺失时以该行为准 | `wake-send.js:344`、`415` |
| `[Style] …` | 每轮一句语感提示，文本取自 `config.json` 的 `prompt.styleLine`（默认 `[Style] 说人话：短、有态度，别讲课别列举`） | `wake-send.js:360-374` |
| `[OWNER]` / `[NOT-OWNER]` | 所有者私聊带前者；非所有者私聊显式写后者（修正所有者识别错误） | `wake-send.js:404-411` |
| `[Status]` | `N unread; waiting on …; last from …; said Nmin ago`。不包含时间行：原 `[Now]` 表示组装时刻，模型执行时已过期；时刻查询改由 MCP 工具 `get_time` 现取 | `wake-send.js:484-485`；工具见 `qq-bridge/src/mcp-napcat-safe.js` |
| `[Wake]` / `[WakeRef]` | 当前模式、时长、触发器，以及配置的插话概率、当前生效值与来源 | `wake-send.js:326-336`、`496` |
| `[Recall]` / `[Profile]` / 联系人行 | 长期记忆摘要（永久层，上限约 700 字符、14 条）与会话对象档案 | `wake-send.js:436-454` |
| `[Unread n]` / `[Mid-turn]` / `[Note]` | 未读与在途注入块 | §8.6.5 |
| `[PERSONA]` / `[SPEECH RULES]` | 按需注入 | 见下 |

人设与发言规则由 `lib/preset-compose.js` 合成进系统提示词，唤醒正文默认不重复注入。判据为 `shouldInjectPersonaBlock()`（`wake-send.js:306`）【已核验】：当 preset 内的版本为当前版本（`getComposedPersonaStamp() === runtimeOverrideStamp()`）且该会话无「需要补注入」标记时不注入，否则注入一次。

表 8-15：人设文件的注入上限与截断策略。口径：上限以字符计（`wake-send.js:248-250`）【已核验】。

| 文件 | 上限 | 截断策略 |
| --- | --- | --- |
| `persona.md` | 16 000 字符 | 保留头部与尾部，尾部 2 500 字符必定保留；截断范围写入日志（`wake-send.js:260-271`） |
| `speech-rules.md` | 12 000 字符 | 同上 |

早期实现仅保留头部并整体丢弃尾部，导致「在文件末尾追加规则」不产生效果。【据仓库记载】文件变更后由 `watchOverrideFiles()`（`lib/preset-compose.js`，由 `bridge.js:288` 装配）重新合成进预设；运行中的既有会话由 `markStalePersonaReinjects()` 在启动时标记一次补注入。【据仓库记载】

#### 8.6.5 回合保持

本节界定回合保持的机制依据、分段持有的实现与保持循环的参数。回合保持的依据来自 DSH 源码（`dsh-agent-loop/lib/index.js:564-572`【未核验】——该文件不在本仓库内，结论转载于 `qq-bridge/src/core/turn-hold.js:4-14`）：一个模型步结束、无存活工具调用且 `next-step` 为空时，回合将关闭；关闭前会 `await` 一次 `agent/turn-stopping` 插件钩子，并在钩子返回后重新检查 `next-step`。

由该机制可得两条结论：钩子内等待期间，桥可将新消息 steer 进 `next-step`，回合不关闭而直接进入下一步；对照 `mode:'queue'`，其投递目标为 `next-turn`，必然额外增加一个完整回合（含整包提示词重发）。分工为：插件只提供时序闸门（`dsh-qq-hold` 提供 `POST /api/qq/turn-hold`，由 `core/console-server.js` 接收），桥负责 steer（`steerIntoRunningTurn()`，`wake-send.js:836`）【已核验】。

表 8-16：分段持有的原因与实现。口径：HTTP 层超时上限决定单次持有预算。

| 项 | 值或行为 |
| --- | --- |
| HTTP 层约束 | 单个 HTTP 请求的 `headersTimeout` 默认为 300 秒（undici / fetch），长持有会被截断 |
| 单次持有预算 | `requestBudgetMs` 默认 55 000 ms，夹在 `[3000, 120000]`（`turn-hold.js:158`）【已核验】 |
| 续期方式 | 本段未等到消息时返回 `{ close: false, again: true }`，插件收到后立即再次发起请求 |
| 效果 | 对 DSH 而言钩子持续等待、回合不关闭；对 HTTP 而言每个请求均短于超时 |

表 8-17：保持循环的参数（`holdLoop`，`turn-hold.js:132`）【已核验】。口径：默认值取自实现；括号内为取值范围。

| 参数 | 默认 | 位置 |
| --- | --- | --- |
| `maxExchanges` | 24（下界 1） | `turn-hold.js:134` |
| `idleCloseMs` | 1 800 000 ms（30 分钟，下界 1 000 ms） | `turn-hold.js:135` |
| `maxWaitMs` | 3 600 000 ms（60 分钟，不短于 `idleCloseMs`） | `turn-hold.js:156` |
| `requestBudgetMs` | 55 000 ms，夹在 `[3000, 120000]` | `turn-hold.js:158` |
| 轮询 `POLL_MS` | 200 ms | `turn-hold.js:45` |
| 看门狗续期 `RENEW_MS` | 5 000 ms | `turn-hold.js:48` |
| 打字阻塞时的退避 | `min(1500, 200·2^(n-1))` | `turn-hold.js:226` |

表 8-18：回合保持的不变量。口径：每行给出约束与其判据或后果。

| 序 | 不变量 | 判据或后果 |
| --- | --- | --- |
| 1 | 默认关闭 | `cfg.social.turnHold.enabled !== true` 时立即放行，行为与未启用该功能时一致 |
| 2 | 灰度生效 | `keys` 非空时仅对白名单生效；`privateOnly`（默认 `true`）仅作用于私聊 |
| 3 | 保持路径不标记已读 | steer 不改动 `unread`，仅在模型实际发出回复后由回合结束的 `mux` 钩子清除。DSH 的 `cancel()` 会执行 `inbox.clear()`，未被领取的消息在中断时消失，因此以 `unread` 作为后备路径 |
| 4 | 同一会话单飞 | `activeHolds` 保证单处持有，防止双重 steer 造成重复注入 |
| 5 | 达到轮换阈值即放行 | `holdLoop` 每轮调用 `rotationDue()`，到点以 `finish('rotate-threshold')` 主动放行关闭回合（`turn-hold.js:181-186`） |
| 6 | 每个提前返回均写日志 | 该功能历史上出现四次静默失败，日志为唯一观测面 |

不变量 5 的测量记录如下。

表 8-19：轮换阈值在保持路径上生效性的测量。口径：测量批次 2026-09-19；对象为 `noteExchange()` 的计数与轮换判定的调用点。

| 批次 | 测量条件 | 方法 | 结果 |
| --- | --- | --- | --- |
| 2026-09-19 | `noteExchange()` 每次来回使 `rotateTurns` 加一；轮换判定原先只存在于会话非忙碌的路径上，而保持循环使会话长期处于忙碌状态 | 检索 `rotateTurns` 与轮换日志 | `rotateTurns = 20`、阈值为 15，`[rotate]` 日志条目数为 0。修正方式为在保持循环内每轮调用 `rotationDue()` |

#### 8.6.6 合并注入

表 8-20：合并注入的机理。口径：三条依据来自 DSH 的 inbox 与 agent-loop 实现。

| 项 | 内容 |
| --- | --- |
| 每次 steer 的形态 | inbox 中独立的一条 `next-step` 消息（`dsh-agent-loop/lib/index.js:399-401`【未核验】，该文件不在本仓库内） |
| 取用时机 | `inbox.claim()` 在下一个 step 的开端一次取走全部 `next-step`（`dsh-agent/lib/index.js:56-61`【未核验】，该文件不在本仓库内） |
| 推论 | 同一步内注入 N 次时，模型在一次思考中看到 N 个独立的 `[Mid-turn]` 块，只能逐块处理；由于同一 step 边界本只能带走一批，「在步边界一次性注入」与「到达即注入」的送达时刻相同，而模型只看到一个块并只产生一条回复 |

表 8-21：合并注入的闸门与发车点。口径：常量取自 `wake-send.js:641-699`【已核验】。

| 机制 | 常量或函数 | 说明 |
| --- | --- | --- |
| 收集窗 | `STEER_COLLECT_MS = 1000`、`STEER_COLLECT_MAX_MS = 3000` | 注入前等待输入停止；对方持续输入时最多等待 `STEER_COLLECT_MAX_MS` |
| 周期闸 | `STEER_CYCLE_MS = 5000`（保持托管会话）、`STEER_CYCLE_SHORT_MS = 1500`（非保持会话） | 同一模型步周期内只注入一次 |
| 特例：模型仍在生成且本回合未发出任何回复 | `midTurnSteerGate({ noReplyYet })`（`typing-hold.js:94`）【已核验】 | 不攒批，直接即时注入；该情形下攒批无合并收益，却把送达时刻押在步边界的到达上 |
| 防饥饿 | `STEER_PENDING_MAX_MS = 20000` | 攒批超过该时长仍未等到步边界时立即注入，不允许静默阻塞 |
| 发车点 1 | `turn-hold.js` 的 `holdLoop`（在 `agent/turn-stopping` 钩子内） | — |
| 发车点 2 | `turn-hold.js` 的 `flushStepBatch()`（`turn-hold.js:358`）【已核验】，由 `mux.js:896-899` 在收到 `step/end` 时调用 | 保持循环仅在 `turnEnds && nextStep.length === 0` 时被 await，连续调用多个工具的步不进入钩子；`step/end` 在每一步均产生 |

表 8-22：步边界延迟的测量。口径：测量批次为原稿记录时点；对象为「模型仍在生成且未发回复」情形下的步边界到达间隔。

| 批次 | 测量条件 | 方法 | 结果 |
| --- | --- | --- | --- |
| 原稿记录 | 模型处于生成中，本回合未发出回复，采用攒批路径 | 记录注入时刻与步边界到达时刻 | 步边界在 28 秒内未到达，投递由 20 秒的防饥饿上限触发。该结果构成 `noReplyYet` 分支不攒批的依据 |

#### 8.6.7 在途注入的准入判据

`steerIntoRunningTurn()`（`wake-send.js:836`）【已核验】允许在途注入的三种情形如下。

表 8-23：在途注入的准入条件。口径：三者任一成立即允许，第 3 条需要回合运行证据。

| 序 | 条件 | 说明 |
| --- | --- | --- |
| 1 | `forced` | 回合保持循环的调用，调用点位于 `turn-stopping` 钩子内，回合必然在运行 |
| 2 | `social.steerEnabled === true` | 全局开关，默认开启；仅显式写 `false` 时关闭 |
| 3 | 位于回合保持灰度内且存在回合运行证据 | 证据来源见下 |

```js
runningTurn = agentRunningSessions.has(sessionId)   // DSH 权威状态
           || TurnStartAt.has(sessionId)            // 桥观测：turn/start 置位、turn/end 清除
           || collectors.has(sessionId)             // 桥观测
```

`host/session-status` 权威帧不进入桥的事件流（计数为 0，该批 `host/*` 帧走 Web UI 的 host 流），因此以桥自身观测的回合边界作为后备（`wake-send.js:830-835`）。无 `runningTurn` 时只记账不投递，写一行「只能留到下一轮（原因：…）」的日志，消息保留在 `unread` 中。【据仓库记载】

表 8-24：返回值语义。口径：同一返回值在不同分支下承载不同含义，这是调用方必须区分的约束。

| 返回值 | 真实含义 |
| --- | --- |
| `true` | 已写入；或本回合已交付过（唤醒正文展示过或刚 steer 过）；或被周期闸攒住（实际未投递任何内容） |
| `'typing-defer'` | 对方仍在输入，该批继续攒（明确信号，不得返回 `false`） |
| `false` | 投递失败或回合未运行 |

表 8-25：返回值语义失误的后果。口径：两项均以原稿记录的状态为准。

| 分支 | 错误返回 | 后果与修正 |
| --- | --- | --- |
| 已交付 | 返回 `false` | 调用方读作投递失败，回落到完整唤醒流程，向同一回合再次投递完整唤醒；模型重复看到同一批未读并产生一条重复回复。修正为返回 `true` |
| 被周期闸攒住 | 按已投递处理并返回 `close: false` | 实际未投递，DSH 观察到 `next-step` 为空而关闭回合，表现为回合保持静默结束。修正为：`holdLoop` 与 `flushStepBatch` 在记账前以 `collectMidTurnBatch(st)` 返回空（该批 seq 已不在待交付集合内）验证落地；未落地则继续持有并重试 |

#### 8.6.8 打字状态等待

`core/typing-hold.js` 的 `midTurnSteerGate` 与 `midTurnSteerText`（`typing-hold.js:94`、`122`）【已核验】，配置位于 `social.typing`。

表 8-26：打字状态等待参数（`TYPING_DEFAULTS`，`typing-hold.js:18-22`）【已核验】。口径：取值范围见括号。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | true | 总开关 |
| `holdMaxMs` | 12 000 ms（夹在 `[1000, 60000]`） | 最长等待时长；到点即注入，避免对持续输入者无限等待 |
| `refreshOnMessageMs` | 5 000 ms（夹在 `[0, 30000]`） | 输入事件不可靠，收到一条消息即把「对方在输入」续期该时长 |
| `breakProbability` | 0.15（夹在 `[0, 1]`） | 每次唤醒的插话概率；0 表示只等待对方停止，1 表示从不等待 |

表 8-27：打字等待后的三条路径（`wake-send.js:943-947`）。口径：路径按回合状态与注入通道可用性分流。

| 序 | 条件 | 行为 |
| --- | --- | --- |
| 1 | 模型仍在生成且本回合未发出任何回复 | 注入当前回合，不等待 |
| 2 | 本回合已发出回复且对方持续连发 | 短暂延迟后注入（不超过 `STEER_IN_TURN_DEFER_MAX_MS`），并排入一次 `scheduleInTurnRedeliver`（最多 3 次，`wake-send.js:727`）；输入窗口结束即投递 |
| 3 | 无运行中的回合或注入通道失败 | 留至下一轮（由 `runningTurn` 守卫与补投失败分支各写一行日志） |

表 8-28：打字配置生效性的测量。口径：测量批次为原稿记录时点；对象为 `midTurnSteerGate` 读取的配置对象与调用点传入的配置对象。

| 批次 | 测量条件 | 方法 | 结果 |
| --- | --- | --- | --- |
| 原稿记录 | `midTurnSteerGate` 读取 `cfg.social.typing`，调用点传入 `cfgRef?.social?.typing` | 追踪该参数的取值 | 参数为 `undefined`，回落至 `TYPING_DEFAULTS`，管理端配置的 `social.typing.*` 在在途注入路径上未生效（`wake-send.js:955-958`） |

#### 8.6.9 回合看门狗与恢复

表 8-29：回合看门狗常量（`core/turn-guard.js`）。口径：三者的判定对象不同：沉默、总时长、合法长等待。

| 机制 | 常量 | 说明 |
| --- | --- | --- |
| 静默判据 | `TURN_TIMEOUT_MS = 180000`（`turn-guard.js:16`）【已核验】 | 完全静默 180 秒（无 turn、tool、流式事件）判定为阻塞 |
| 回合总时长 | `TURN_TOTAL_TIMEOUT_MS = 360000`（`turn-guard.js:17`）【已核验】 | 6 分钟未结束（疑似模型重复输出）时强制隔离 |
| 长等待 | `LONG_WAIT_TURN_TIMEOUT_MS = 660000`（11 分钟，`turn-guard.js:21`）【已核验】 | 由 `touchTurnGuardsByKey()` 用于 `qq_wait_for_messages` 与回合保持等合法长等待 |
| 隔离 | `quarantineSession(key, sessionId)` | 投递超时或判定阻塞时调用 |
| 启动时的唤醒租约 | `armPendingWakeLease` / `disarmPendingWakeLease` | — |

回合保持每 5 000 ms 续期看门狗（`turn-hold.js:48` 的 `RENEW_MS`）【已核验】；缺少续期时，保持期间无事件产生，计时器持续推进并触发误判。另有两条恢复路径位于 `wake-send.js` 与 `social-state.js`：`loopRecovery`（存在未读但长时间无动作时拉回）与 `timeoutRecovery`（回合判定阻塞时收尾）。【据仓库记载】

#### 8.6.10 回合级共享状态

会话、回合与队列的共享状态集中于 `core/session-state.js`，全部以 `Map` / `Set` 按内容增删并经 export 活绑定共享（无整体重赋值），因此各子系统持有同一份视图。

表 8-30：回合级共享状态。口径：每行给出状态集合及其语义。

| 状态 | 含义 |
| --- | --- |
| `collectors` / `TurnStartAt` | 会话 → 回合采集器、回合开始时间（回合边界观测） |
| `promptQueues` | 每会话串行投递 DSH prompt，保证回合顺序 |
| `pendingWakeKeys` / `pendingWakeLeaseTimers` | 唤醒待办，以及「已接受但未收到 `turn/end`」的租约后备 |
| `sendToolSucceededSessions` / `pendingSendToolCalls` | 本回合发送类工具是否成功过；等待 `tool/result` 的调用 |
| `turnTimeoutTimers` / `turnTotalTimers` | 活动感知看门狗与回合总时长后备 |
| `loopRepeatState` / `loopRecoverTimes` / `activeAiTurns` / `pendingTurnOutbound` | 复读判定与自动重启台账 |
| `activeWaits` / `lastWakeRebroadcast` / `wakeConfigUpdatedKeys` / `markReadCalledKeys` | 长轮询互斥、补发冷却、唤醒配置与已读台账 |

#### 8.6.11 出站

事件泵中 `collector.push(frame.event)` 返回 `ended` 时回合收尾（`mux.js:909-1084`）。

表 8-31：回合收尾要点。口径：每行给出该机制的判据集合。

| 机制 | 内容 |
| --- | --- |
| 已回复账本 | 本回合负责的消息集合为唤醒时展示的 `turnSeenUnread` 与中途 steer 进入的 `turnSteeredSeqs`；只计入前半部分会使 steer 进入的 seq 永远不进入 `answeredMessageIds`，下一轮被当作新消息并产生重复回复 |
| 账本来源 | 从 `recentMessages` 查找，不遍历 `unread`：模型在回合内调用 `mark_read` 时已移除展示过的未读条目 |
| 回合结束清理 | 清空 `turnSeenUnread` / `turnSteeredSeqs` / `_steerDeferredSeqs` |
| 无动作后备 | 连续 `social.wake.noActionLimit`（默认 3）次唤醒既未发消息也未调用 `mark_read` / `set_wake_config` 时执行 `softResetWakeConfig()` |
| 防遗忘提醒 | `pendingWakeKeys` 中的会话未更新唤醒配置时发出提醒，最多 `maxWakeConfigReminders`（默认 2）次，之后软重置 |
| 暂存唤醒合并 | 忙碌期间暂存的唤醒原因合并为一次最高权重唤醒投递，避免补发与忙碌形成积压循环 |

发送链由以下模块构成：`core/send-chain.js`（`enqueueSend` / `currentSendChain`）、`core/qq-send.js`（`onebotSend`，`qq-bridge/src/core/qq-send.js:166`【已核验】——所有模型正文的唯一出口）、`core/send-idempotency.js`（幂等闸门，防止 `/reset` 后重复回复）、`lib/onebot-delivery.js`（分段与节奏）、`lib/send-gaps.js`（`computeGaps` / `clampGap`）。【据仓库记载】

### 8.7 上下文压缩接口

表 8-32：压缩与剪枝的接入面。口径：桥只写配置文件，实际裁剪由 DSH 的 surface 插件执行（§8.4）。

| 项 | 接入点 | 说明 |
| --- | --- | --- |
| home 级 patch | `<DSH_HOME>/cordis.patch.yml` | `syncDshCompactionPatch()` 写入，标记块内为压缩与剪枝行（`qq-bridge/src/lib/dsh-compaction.js:198`）【已核验】 |
| 启用开关 | `disabled: false` | web profile 下两行默认禁用，必须显式开启（§8.4） |
| 约束归一 | `normalizeCompaction()` | 保证 `retainRatio < thresholdRatio` 与 `headChars + 标记 + tailChars ≤ thresholdChars`（§8.4） |
| 配置热加载 | 回调分支 | `dshCompaction.*` 变化时重写 `cordis.patch.yml`（§8.10） |
| 成本模型 | `docs/COMPACTION-MATH.md` | 分块、递归摘要、成本泛函、触发判据与复杂度 |

召回内容以摘要形式注入唤醒正文（`[Recall]` 行，`limit: 14`、`maxChars: 700`，`wake-send.js:479`）【已核验】，不将历史消息回填上下文。摘要置于唤醒正文而非系统提示词：系统提示词的变更会使整段前缀缓存失效。【据仓库记载】

#### 8.7.1 检索侧的数据结构

上下文压缩的上游是记忆与聊天记录的检索面。该面由两个 SQLite 库构成，划分依据是两张主要表的生命周期差异。

表 8-50：记忆与聊天记录的库划分。口径：库文件位于 `qq-bridge/state/`。

| 库 | 模块 | 内容 |
| --- | --- | --- |
| `memory.db` | `core/memory.js`（`memDb` 为模块级单例） | 记忆档案：`profiles`、`memory_entries`、`memory_meta`、`mem_fts` |
| `chat.db` | `core/chat-db.js` | 聊天记录：`chat_messages`、`chat_fts`、`chat_convs`、`chat_stats`、`chat_meta` |

表 8-51：库划分的原因与迁移。口径：划分为 2026-09-24 批次；调用方接口不变。

| 项 | 内容 |
| --- | --- |
| 划分原因 | `chat_messages` 为全库最大表，只增不改、可按会话整段删除、每条消息写一行；`profiles` 与 `memory_entries` 条目少、生命周期长、每轮注入上下文。合并在同一文件中时，删除聊天历史会同时锁定记忆库，并放大写放大与备份粒度 |
| 调用方兼容 | `memory.js` 原样 re-export 聊天函数，历史 import 路径（`mux`、`social-flow`、`wake-send`、`crosschat`、`message-cache`、`console-server`）不变 |
| 共享工具 | `ftsUsable` / `ftsQueryOf` 抽入 `lib/fts.js` 供两个库共用；两份实现会漂移，故障表现为检索无结果且不报错 |
| 首次启动迁移 | 旧 `memory.db` 的 `chat_messages` 一次性搬入 `chat.db`：以 `ATTACH` + `INSERT … SELECT` 执行，核对条数一致后删除旧表并 `VACUUM`；两侧均非空时跳过并记日志，条数不一致时保留旧表待下次重试；水位记于 `chat_meta.migrated_from_memory_db`，不重复搬迁 |

表 8-52：检索索引与分层。口径：`MEMORY_TIERS`、`PERMANENT_CATEGORIES` 与 `FTS_SCHEMA_VERSION` 取自 `core/memory.js`。

| 项 | 实现或取值 |
| --- | --- |
| 检索索引 | FTS5 外部内容表，`tokenize='trigram'`、`content='<源表>'`、`content_rowid='id'`；建表语句见 `qq-bridge/src/core/memory.js:143`【已核验】 |
| 中文子串检索 | trigram 对中文按三字滑窗切分，中文子串可直接命中，不需要分词器 |
| 相关性排序 | BM25 由 SQLite 内部提供 |
| 索引同步 | 由触发器维护，索引与触发器均在 SQLite 内部执行；桥侧只增加一次 INSERT 的开销 |
| 结构版本 | `FTS_SCHEMA_VERSION = '2'`（`memory.js:90`）【已核验】；版本变化时下次启动自动重建，操作幂等 |
| 记忆分层 | `MEMORY_TIERS = { permanent: 0, durable: 90 天, working: 7 天 }`（`memory.js:87`）【已核验】；`PERMANENT_CATEGORIES = Set(['rule','owner','identity'])`（`memory.js:89`）【已核验】；归属判据为 `pinned = 1` 或 `category ∈ PERMANENT_CATEGORIES` → `permanent`，显式 `working=true` 或低 `importance` → `working`，其余为 `durable` |
| 索引清单 | `memory.db`：`idx_mem_uid`、`idx_mem_tier`、`idx_mem_conv`、`idx_mem_expire`；`chat.db`：`idx_chat_conv_ts`、`idx_chat_ts`、`idx_chat_sender`、`idx_chat_conv_content`、`idx_chat_dir_ts`，以及部分唯一索引 `idx_chat_msgid`（`WHERE message_id != ''`，用于防止重复投递与双路径并发写入） |

表 8-53：建部分唯一索引的前置条件。口径：约束来自实现注释。

| 项 | 内容 |
| --- | --- |
| 前置条件 | 建 `idx_chat_msgid` 前必须清除存量重复行（每组保留 `id` 最小的一行） |
| 不满足时 | 建索引失败 |


### 8.8 工具面

表 8-33：三组 MCP server。口径：由 `lib/dsh-side.js` 的 `mcpBlock()`（`qq-bridge/src/lib/dsh-side.js:252`）【已核验】写入 profile 的 `cordis.patch.yml`。

| server id | serverName | 脚本 | 内容 |
| --- | --- | --- | --- |
| `mcp-napcat` | `napcat` | `qq-bridge/src/mcp-napcat-safe.js` | QQ 与 NapCat 能力（主体） |
| `mcp-napcat-host` | `napcat-host` | `qq-bridge/src/mcp-host-server.js` | `qq_learning_corpus`、`qq_learning_submit`、`napcat_status`；进程控制在显式开启前不注册 |
| `mcp-web-search-safe` | `web-search-safe` | `qq-bridge/src/mcp-web-search-safe.js` | `web_search`、`web_fetch` |

表 8-34：工具注册数的静态统计。口径：按源码文本计数；`registerTool(` 为本地包装函数，其中一次出现为函数定义（`mcp-napcat-safe.js:734`）【已核验】。

| 文件 | `registerTool(` 出现次数 | `server.tool(` 出现次数 | 注册工具数 | 工具名 |
| --- | --- | --- | --- | --- |
| `qq-bridge/src/mcp-napcat-safe.js` | 92（含 1 处函数定义，调用 91 次） | 1（由包装函数内部调用） | 91 | `qq_send_message`、`qq_reply`、`qq_get_unread_messages`、`qq_mark_read`、`qq_wait_for_messages`、`qq_memory_*`、`qq_slang_*`、`qq_character_*`、`qq_qzone_*`、`qq_pixiv_search`、`qq_send_voice`、`qq_transcribe_voice`、`qq_video_parse`、`qq_meme_search`、`qq_schedule_*`、`qq_crosschat_*` 等；若干工具受 `cfg.social.tools.*` 开关包裹，运行时不注册 |
| `qq-bridge/src/mcp-host-server.js` | 0 | 5 | 5 | `qq_learning_corpus`、`qq_learning_submit`、`napcat_status`、`start_napcat`、`stop_napcat`（后两项仅在 `napcat.allowProcessControl === true` 时注册） |
| `qq-bridge/src/mcp-web-search-safe.js` | 0 | 2 | 2 | `web_search`、`web_fetch` |

【已核验】表中三项计数以源码文本检索得到。

`mcp-host-server.js` 与 MCP 客户端的约定写于该文件头注释：由 DSH 的 MCP 客户端 spawn。`qq_learning_submit` 不放入 napcat 组：学习会话只加载 `mcp__napcat-host__` 组，写作 `mcp__napcat__qq_learning_submit` 会成为未知工具。【据仓库记载】

表 8-35：工具 schema 体积的实测快照。口径：测量批次 2026-09-24（工具表不含 `qq_send_burst`）；数据源 `qq-bridge/state/tool-schema-stats.json`。

| 项 | 值 |
| --- | --- |
| `totalChars` | 95 595 字符 |
| `registered` / `available` | 91 / 91 |
| `approxTokensPerStep` | 31 675 |
| `tier off` | 91 个 / 95 595 字符（份额 1.0000） |
| `tier low` | 68 个 / 79 162 字符（份额 0.8281） |
| `tier medium` | 42 个 / 40 047 字符（份额 0.4189） |
| `tier high` | 33 个 / 33 344 字符（份额 0.3488） |
| `tier extreme` | 9 个 / 6 497 字符（份额 0.0680） |

表 8-36：工具档位语义。口径：档位为白名单语义——不在保留集合内的工具不注册，其描述不进入请求体。

| 档位 | 语义 |
| --- | --- |
| `off`（默认） | 全部工具注册 |
| `low` | 移除零调用且体积最大的集合，其余保留 |
| `medium` | 协议必需 + 被调用过的工具 + 提示词点名的工具 + 低体积工具 |
| `high` | 协议必需 + 被调用过的工具 + 提示词点名的工具 + 群成员识别相关工具 |
| `extreme` | 九项最小集合：发送、引用、收尾、读未读、时间查询等 |
| `custom` | 使用手写 `allow` / `deny` 两张表（旧行为） |

表 8-37：档位保留集合的构成（`qq-bridge/src/lib/tool-tiers.js`）。口径：三类的纳入判据不同，其中提示词点名类的判据强于调用记录类。

| 集合 | 判据 | 内容 |
| --- | --- | --- |
| `ESSENTIAL` | 协议必需，任何档位均保留 | `qq_send_message`、`qq_reply`、`qq_mark_read`、`qq_set_wake_config`、`qq_get_prompt`、`qq_social_state`、`qq_get_unread_messages`、`qq_wait_for_messages`、`qq_list_groups`、`qq_status`、`get_time`（2026-09-24 加入，`extreme` 档白名单亦显式列出） |
| `OBSERVED_USED` | 服务器真实调用日志（`state/tool-calls.jsonl`，1 108 次调用）中确有调用记录 | 由统计脚本生成 |
| `PROMPT_NAMED` | 提示词点名要求模型调用（2026-09-24 新增） | `qq_memory_remember`（`[Recall]` 段要求使用）、`qq_get_file_content`（媒体标签行要求使用） |

`qq_status` 在所有档位均保留（198 字符，`tool-tiers.js:45`）【已核验】。选择具体档位时 `allow` / `deny` 两张手写表一律忽略：线上 `deny` 旧名单与档位白名单可能自相矛盾，被移除的正是模型在用的工具，且难以发现（`tool-tiers.js:144-148`）。【据仓库记载】

表 8-38：描述压缩档（`lib/tool-schema-compress.js`）。口径：`SCHEMA_LEVELS = ['off','medium','high']`（`tool-schema-compress.js:33`）【已核验】，配置键 `social.slimTools.schemaLevel`；压缩对象为描述文本，工具与参数数量不变。

| 档位 | 语义 |
| --- | --- |
| `off` | 描述原样下发 |
| `medium` | 工具与参数的描述均只保留第一句 |
| `high` | 不发送描述，只保留工具名、参数名、类型、枚举与必填 |

该模块不提供 mcp-compressor 的 `low` 档：重建 union 容器会把描述复制进每个分支而导致体积增加。【据仓库记载】重建容器后必须回填容器自身的描述（`withOwnDesc`，`tool-schema-compress.js:76`）【已核验】，否则 `z.union([...]).optional().describe('Group id')` 一类参数描述丢失。`social.slimTools` 在注册期排除工具，可减少请求体积；`social.tools.*` 只在调用期拒绝，不减少体积。【据仓库记载】

表 8-39：MCP 压缩代理。口径：配置位于 `config.json` 的 `social.toolCompressor`，装配位于 `lib/dsh-side.js:171-296`。

| 项 | 内容 |
| --- | --- |
| 默认状态 | 恒定开启（`tc.enabled !== false`）；仅显式 `enabled: false` 时回到直连 |
| 进程形态 | 代理进程：DSH 不直连 `mcp-napcat`，而连接代理；代理将工具压缩为两个包装工具（`<server>_invoke_tool` / `<server>_get_tool_schema`），工具清单嵌入包装工具的描述 |
| 档位语义 | `low` 去冗余；`medium` 每条描述只留第一句；`high` 不发送描述；`max` 不发送工具清单，改用包装工具 |
| 适用范围 | 仅 `mcp-napcat` 一路（工具最多、体积最大）；另两组保持直连 |
| 后备路径 | 压缩机未安装或无法启动时不得使工具表消失：先执行廉价探测，探测失败则直连并把原因写入日志（`dsh-side.js:179-181`、`221-247`） |

桥侧配套：`core/mux.js` 的 `unwrapCompressedToolName(name, rawArgs)`（`mux.js:129`）【已核验】将包装工具还原为后端真实工具名。代理模式下真实目标位于 `args.tool_name`，而桥下游逻辑（发送类判定、引号补全、幂等账本、抽签登记、回合收尾，共 49 处）均按真实工具名判定；未解包时该批逻辑全部失效（`mux.js:802-811`）。【据仓库记载】

表 8-40：MCP 压缩代理体积的测量。口径：测量批次为原稿记录时点；样本为 90 个工具，基准为完整工具表（`dsh-side.js:174-176`）；同一窗口内 `napcat_get_tool_schema` 调用次数为 0。

| 档位 | 相对完整工具表的体积 |
| --- | --- |
| `low` | 38.8% |
| `medium` | 14.0% |
| `high` | 6.2% |
| `max` | 3.6% |

表 8-41：描述压缩档体积的测量。口径：测量批次为原稿记录时点；样本为 90 个工具，wire 格式为真实传输格式。

| 档位 | 体积 | 相对基准 |
| --- | --- | --- |
| `off` | 89 603 字符 | 1.0 |
| `medium` | 61 587 字符 | 68.7% |
| `high` | 27 109 字符 | 30.2% |

表 8-42：工具名归一化。口径：名单中的工具名允许带或不带 `mcp__server__` 前缀。

| 项 | 内容 |
| --- | --- |
| 实现 | `bareToolName()`（`mcp-napcat-safe.js` 的 `registerTool` 附近、`tool-tiers.js:130`）去除 `mcp__server__` 前缀 |
| 等价性 | 名单写 `mcp__napcat__qq_x` 与写 `qq_x` 等价；缺少该归一化时精简名单整体不命中 |

### 8.9 会话、预设与归档

表 8-43：会话与预设绑定。口径：绑定发生在会话创建时。

| 项 | 说明 |
| --- | --- |
| 会话创建 | 桥按 QQ 会话键建立 DSH 会话，映射存 `state/sessions.json`；创建时绑定 `agentPreset`（默认 `qq-chat`）与工作区标题（默认 `Agents`） |
| 预设装配 | `qq-bridge/dsh/agent-presets/qq-chat/`（`preset.yml`、`agent.cordis.yml`、`qq-tool-restrict.mjs`）；仓库一份、隔离 home 一份，桥每次启动刷新 |
| profile overlay | `patchProfileCordis()` 写入 agent-presets overlay（`default: standard`、`includeUserRoot: true`），使 `qq-chat` 成为该 profile 的默认 preset |
| 轮换 | §8.10 |
| 归档 | §8.9.1 |
| 模型同步 | `syncDshAgentDefaultModel()` 与 `POST /api/bridge/config` 的漂移自愈共同保证 `settings.yaml` 的 `agent-default-model` 与管理端配置一致；改写后后台重启隔离 DSH |
| 模型目录 | 管理端从 DSH 自身配置读取各服务商可用模型（`session/modelCatalog`、`settings.yaml` 的 `llm-pi-ai.providers.<id>.models`） |
| 预设生效时点 | `agentPreset` 仅在创建会话时绑定：更换 preset 后既有会话仍使用旧提示词，需等待轮换或空闲归档重建（`lib/dsh-compaction.js:293-295`） |

#### 8.9.1 会话归档

桥每隔约 12 轮用户触发对话轮换一次 DSH 会话，阻塞、隔离与复读恢复同样会重建会话，因此「QQ 聊天」工作区内的 `session-*` 目录持续累积。`core/session-archive.js` 定时巡检该工作区，把已闲置的旧会话经 DSH 的 `workspace/archiveSession` 归档。

表 8-44：归档的安全边界与默认参数。口径：安全边界为硬性约束，不提供配置项；参数默认值取自 `session-archive.js` 的 `DEFAULTS`（`session-archive.js:29-32`）【已核验】。

| 项 | 值或约束 |
| --- | --- |
| 不归档的对象 | `state.sessions` 中当前映射的会话；预热待用的 standby 会话（`st._standbySessionId`）；当前有回合运行（`TurnStartAt` / `collectors`）或正在执行发送工具链的会话 |
| 处理范围 | 仅「QQ 聊天」工作区目录（`cfg.sessionCwd`，缺省 `state/agents`）下的 `session-*` 目录 |
| 闲置门槛 | 未达到闲置时长（默认 30 分钟）不处理 |
| `intervalMs` | 600 000 ms（10 分钟） |
| `idleMinutes` | 30 |
| `batchMax` | 20（单轮最多归档数，避免集中冲击 DSH） |
| `pruneDays` | 0（只归档不删除数据；大于 0 时连同磁盘目录一并清理） |
| 归档水位 | `state/session-archive.json` |

### 8.10 配置热加载与会话轮换

表 8-45：配置热加载机制。口径：热加载不更换对象引用。

| 项 | 内容 |
| --- | --- |
| 生效方式 | 桥启动时 `const cfg = loadConfig()` 只读一次，该对象经 `initXxxCore(cfg)` 注入十余个模块；保存配置即时生效依赖 `watchConfigFile()` 的原地合并（`applyConfigInPlace`，`qq-bridge/src/core/config.js:467`）【已核验】，不更换引用 |
| 默认键补齐 | `loadConfig` 补齐全部默认键，因此目标对象中多余的键表示用户已从文件删除，同步删除以避免沿用旧值 |
| 监听方式 | 目录监听（`fs.watch(dir)`，按文件名过滤，mv 覆盖产生 rename 事件）与 2 000 ms 轮询（`fs.watchFile`，可跨 inode 与文件系统）双路并用（`watchConfigFile()`，`config.js:507`）【已核验】 |
| 写回点 | 桥内共 10 处把内存中的配置写回 `config.json`（`console-server.js` 5 处、`mux.js` 4 处、`tunables.js` 1 处）；未做热加载时管理端的修改不仅不生效，还会被回滚 |
| 管理端写入 | `POST /api/bridge/config` 走深合并（表单只携带其编辑的片段，不整体覆盖）+ 临时文件 → 备份 → rename 原子替换 |
| 回调动作 | `dsh*` 变化 → `resetVisionModelApplications()`；`social.wake.*` 变化 → `applyOwnerWakeProbabilityToSessions()`；`dshCompaction.*` 变化 → 重写 DSH 的 `cordis.patch.yml` |

表 8-46：原地监听失效的测量。口径：测量批次 2026-09；对象为 Linux 上 `fs.watch(file)` 的监听对象与配置文件的替换方式。

| 批次 | 测量条件 | 方法 | 结果 |
| --- | --- | --- | --- |
| 2026-09 | `fs.watch(file)` 在 Linux 上监听该文件的 inode；管理端保存走临时文件 → 备份 → mv 原子替换 | 07:34 装配监视器，07:39:54 由管理端执行 mv 覆盖；此后检索桥日志中的「已热加载」条目 | 条目数为 0。原因为监视器仍指向已被 unlink 的旧 inode，此后任何改动均不产生事件，直到桥重启。修正为目录监听加 2 000 ms 轮询的双路方案 |

表 8-47：会话轮换机制。口径：判定函数为三个调用点共用（`wake-send` 的忙碌分支、轮换块、`turn-hold` 的保持循环）。

| 项 | 内容 |
| --- | --- |
| 计数 | 落在 `social-state.json` 的 `rotateTurns`，重启不重置 |
| 阈值 | `social.autoReset.wakeThreshold` 默认 10、下限 5；`rotateThresholdOf()` 每轮读取配置（`wake-send.js:97`）【已核验】 |
| 判定 | `rotationDue(key, st, cfg)`（`wake-send.js:111`）【已核验】 |
| 防阻塞 | 推迟注入最多 `ROTATE_DEFER_MAX_MS = 120000`（`wake-send.js:75`）【已核验】；超时后 `rotationDue()` 自动改判为 `false`，即推迟轮换而不阻塞用户消息 |
| 永久会话 | `social.autoReset.permanent === true` 时阈值返回 `Infinity`，各处判定写作 `count >= threshold` 而恒为假，轮换块、忙碌分支、保持循环与控制台的 `[Rotate]` 收尾指令无需修改即自动停用 |
| 预热 | `createStandbySession()`（`qq-bridge/src/core/dsh-session.js:169`）【已核验】提前创建下一代会话（同工作区、同 preset、同视觉模型），不写入映射、不触发投递，首轮提示词由提供方前缀缓存命中 |

永久会话的成本论证见 `docs/COMPACTION-MATH.md`。

### 8.11 凭据注入

隔离 DSH 的 provider 从环境变量读取密钥（`apiKeyEnv`）。管理端在 `startIsolatedDsh()` 时以 `loadCredentialEnv(home)` 解析 `<home>/.credentials.yaml` 的 `KEY: value` 行并合入子进程环境（去除引号、丢弃空值），因此密钥既不进入 DSH 配置文件也不进入命令行。写入链路见 §5.6。【据仓库记载】

### 8.12 token 计量与对账

表 8-48：token 计量与对账环节。口径：计量为逐帧，对账为周期性与启动时执行。

| 环节 | 实现 |
| --- | --- |
| 逐帧计量 | `core/token-meter.js` 的 `meterTokenFrame()`（`qq-bridge/src/core/token-meter.js:550`）【已核验】在事件环每帧调用一次；深度扫描（不超过 6 层，数组元素超过 200 跳过）整帧 usage 键（snake / camel 命名与 usage 对象内的键）；命中且 sessionId 存在时写入 `est:false` 行 |
| 估算后备 | 无法获取真实 usage 时按帧 transcript 字符估算，写入 `est:true` 行并附字符数 |
| 存储 | `state/token-usage.jsonl`，每行 `{tsMs, sessionId, convKey, prompt, completion, total, est, …}` |
| 权威对账 | 每 5 分钟及桥启动时读取 `<dshHome>/storages/session_projcache/sessions/session-*.json` 的 `record.rows.tokenUsage.val.totals`（`uncachedInputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`），与桥侧同会话累计逐桶比对，只补桥侧缺少的部分（`reconciled:true` 行） |
| 水位 | `state/token-reconcile.json`，保证可反复执行而不重复补记，也不会因文件截断（`MAX_LINES` 裁剪）而重加历史 |
| 单帧漏记 | 帧内无法获取 sessionId 时整帧丢弃，见下表 |
| 呈现 | 管理端「学习 / 用量」页与 `/token` 指令共用一套口径：只统计确实带缓存命中字段的请求（`cacheSamples > 0` 的小时桶），不反推不外推；金额计算公式见下 |

金额计算（`core/token-report.js`、`config.json` 的 `tokenCost` 段）：

$$\text{cost} = \frac{\text{命中} \times p_{\text{Hit}} + \text{未命中} \times p_{\text{Miss}} + \text{输出} \times p_{\text{Out}}}{10^{6}} \times \text{peakMult}$$

高峰时段为北京时间 09:00-12:00 与 14:00-18:00，倍率为 `peakMult`。

表 8-49：单帧漏记的测量。口径：测量批次为原稿记录时点；样本为单一会话；两侧口径分别为 DSH 权威计数与桥侧累计。

| 批次 | 测量条件 | 方法 | 结果 |
| --- | --- | --- | --- |
| 原稿记录 | 帧内无法获取 sessionId，该帧被丢弃 | 比对同一会话的 DSH 侧与桥侧累计 | DSH 侧 961 349，桥侧 889 248，差值 72 101（等于一个模型步的量）。对账机制用于补齐该类缺口 |

## 9. 打包与分发

本章界定本仓库与仓库外打包工程的边界、打包侧已核对的事实、运行时侧的对应实现与分发链。部署链（SSH 克隆）在 §7 界定，两条链互不依赖。

### 9.1 边界声明

安装包与 Electron 壳由仓库外的打包工程产出。

表 9-1：仓库边界。口径：第三列给出该路径是否位于本仓库。

| 路径 | 角色 | 是否在本仓库 |
| --- | --- | --- |
| `C:\Users\17367\Desktop\QQ-Bridge-packaging` | 打包工程根（NSIS 脚本、壳源码、装配产物） | 否 |
| `…\QQ-Bridge-packaging\build-installer-full.nsi` | NSIS 安装包脚本（输出 `MoonBot Pro Setup.exe`） | 否 |
| `…\QQ-Bridge-packaging\moonbot-app\main.js` | Electron 壳主进程 | 否 |
| `…\QQ-Bridge-packaging\full\app\` | 被装配的运行树（`server/`、`dist/`、`qq-bridge/`、`dsh/`、`napcat-onekey/`、`qbm-node.exe`） | 否 |
| `C:\Users\17367\Desktop\MoonBot Public` | 源码仓库（运行时代码来源） | 是 |
| `D:\MoonBot\resources\runtime` | 本机已安装副本（一份运行树拷贝，内容可能与源码树不同） | 否 |

本节只描述打包侧与运行时的接口，不复述打包工程内部实现。

### 9.2 打包侧事实

表 9-2：对仓库外文件的直接读取结果。口径：以下条目为文件系统层面的核对结果。

| 事实 | 依据 |
| --- | --- |
| 安装包由 NSIS 3 构建，输出 `MoonBot Pro Setup.exe`，默认安装到 `%LOCALAPPDATA%\Programs\MoonBot`，`RequestExecutionLevel user` | `build-installer-full.nsi` |
| 安装包分为三个 Section：核心管理端（必需）、运行时层（桥 + DSH + NapCat，整块可选）、桌面快捷方式（可选） | 同上 |
| 核心管理端安装 `server/`、`dist/`、`node_modules/`、`qbm-node.exe`、`start-manager.vbs`、`start-debug.cmd`、`app.ico` | 同上 |
| 运行时层安装到 `$INSTDIR\qq-bridge`、`$INSTDIR\dsh`、`$INSTDIR\napcat-onekey` | 同上 |
| 卸载脚本只终止路径位于本安装目录下的 `qbm-node` / `NapCatWinBootMain` / `QQ` 进程 | 同上（`$_.Path -like '$INSTDIR*'`） |
| 壳主进程以随包 `qbm-node.exe` 隐藏启动后端（`server/index.js`，`127.0.0.1:1921`），轮询后端就绪后以独立 `BrowserWindow` 加载本地界面 | `moonbot-app/main.js` 头部注释与 `loadURL(urlFor(backendPort))` |
| 端口可退避：`QBM_API_PORT` 环境变量传入；1921 被无关程序占用时改用备用端口，不抢占其它进程的端口，只复用可确认属于自身的后端 | `main.js` |
| 关窗顺序：先 `POST /api/shutdown`（8~12 秒超时）请求收尾，再 `taskkill /pid <后端> /T /F`，最后由后端自带的守卫进程承担后备清理 | `main.js` 的 `requestGracefulShutdown()` / `shutdownEverything()` |
| 壳文件名必须为 `MoonBot`（`win.executableName`），因为 `server/index.js` 的守卫按进程名 `/^MoonBot$/i` 识别应用本体 | `main.js` 注释与 `ensureGuardianArmed()` |
| 应用单实例：`app.requestSingleInstanceLock()` | `main.js` |

### 9.3 运行时侧对应实现

表 9-3：打包侧概念与运行时实现的对应。口径：左侧为打包侧命名，右侧为运行时的实际取值来源。

| 打包侧概念 | 运行时对应 |
| --- | --- |
| `qbm-node.exe`（随包 Node 运行时） | 全部子进程以 `process.execPath` 启动（DSH、桥、守卫、隐藏器）；`process.execPath` 自身为 node 时 `--expose-internals` 一类命令行标志才可用 |
| `$INSTDIR\server` | `RUNTIME_ROOT` 为 `server/index.js` 的上两级目录（NSIS 布局下即 `$INSTDIR`；electron-builder 布局下为 `resources\runtime`，本机 `D:\MoonBot\resources\runtime` 即该形态） |
| `$INSTDIR\dsh` | 随包 DSH CLI；管理端配置项 `instances.dshIsolated.dshCli` 指向它（本机实测值形如 `D:\MoonBot\resources\runtime\dsh\node_modules\.bin\dsh.cmd`） |
| `$INSTDIR\napcat-onekey` | `findNapcatOneKeyAll()` 的首个候选根 |
| `start-manager.vbs` | 隐藏启动壳与后端，避免产生控制台窗口（仓库内另有 `tools/start-manager-hidden.vbs`、`tools/restart-manager.ps1` 供开发使用） |
| 卸载时按路径终止进程 | 与「不处理用户本机已安装的 QQ」同源：只匹配安装目录前缀（§11） |

表 9-4：目录命名差异。口径：仓库内目录名与安装树目录名不同，映射规则位于打包工程内部。

| 仓库内 | 安装树内 | 状态 |
| --- | --- | --- |
| `dsh-runtime/` | `dsh/` | 【未核验】映射规则位于打包工程内部，本文不做推断 |

### 9.4 分发链

表 9-5：分发链环节。口径：两条链互不依赖。

| 序 | 环节 | 说明 |
| --- | --- | --- |
| 1 | 源码仓库 → 打包工程装配 `full\app\` | 装配内容为 `server/` + `dist/` + `qq-bridge/` + `dsh/` + `napcat-onekey/` + `qbm-node.exe` |
| 2 | 打包工程产出安装包 | `MoonBot Pro Setup.exe` |
| 3 | 安装 | 默认落到 `%LOCALAPPDATA%\Programs\MoonBot`，或自定义目录 |
| 4 | 首次启动 | 壳启动后端 → 前端引导（§5.1） |
| 5 | SSH 克隆部署链 | 独立链路，把已运行的主机复制到另一台 Linux 主机（§4.7、§7） |

## 10. 可靠性与可观测性

本章界定日志面、审计链、崩溃自愈手段，以及各项一致做法的来源与判定标记。凭据脱敏在 §5.7 界定。

### 10.1 日志

表 10-1：日志面。口径：写入方列给出直接写入者，不列代理层。

| 日志 | 位置 | 写入方 | 内容 |
| --- | --- | --- | --- |
| 管理端主日志 | `%USERPROFILE%\.qq-bridge-manager\logs\manager.log` | `mlog()` | 启停、探活、单点登录闸门、守卫武装、模型同步、凭据写入、SSH 部署摘要 |
| 实例日志 | 同目录（`instanceLogPath(id)`） | 子进程标准输出与错误直写 | DSH、桥、NapCat 各自的全部输出 |
| 关窗守卫日志 | 同目录 `napcat-guardian.log` | 守卫进程 | 武装信息、父进程消失、三段清理结果 |
| 桥主日志 | `qq-bridge/state/bridge.log` | `lib/log.js` 的 `log()` | 桥业务日志 |
| 会话活动流水 | `qq-bridge/state/qq-activity.log` | `lib/log.js` 的 `appendActivity()`（`qq-bridge/src/lib/log.js:20`）【已核验】 | 每个会话的活动记录 |
| 工具调用流水 | `qq-bridge/state/tool-calls.jsonl` | `core/audit.js` 的 `appendToolLog()`（`qq-bridge/src/core/audit.js:76`）【已核验】 | 工具名、参数摘要、结果；供档位统计与排障 |
| 运维输出 | 目标机 `/root/.dsh/dsh-web.log`、systemd journal | 部署侧服务 | 目标机 DSH 与桥的日志 |

表 10-2：日志写入方式的成因。口径：测量批次为原稿记录时点；对象为子进程标准输出的去向与管道读端的存在性。

| 批次 | 测量条件 | 方法 | 结果 |
| --- | --- | --- | --- |
| 原稿记录 | 早期实现以管道转发子进程输出 | 重启管理器或对其执行 `taskkill` 后检查子进程状态 | 管道读端消失，子进程下一次写标准输出产生 EPIPE；Node 对标准输出的未处理错误会终止进程，表现为重启管理器后桥消失且日志无错误行。实现改为实例日志直写文件，桥侧另装 EPIPE 守卫 |

### 10.2 审计

`core/audit.js` 承担出站审计与静默拦截：模型待发出的正文先经敏感内容检测（`sensitiveHitKind` / `SENSITIVE_RE`）与令牌泄露检测（`tokenDisclosureIn`）；需要拦截时按角色状态与静默模式决定「拦下」或「只记录」。`shouldAuditKey()` 当前对所有会话返回 `true`（早期「所有者私聊跳过」的特判已删除）。【据仓库记载】

发送类工具的判定链为：MCP 工具 → 桥控制台或 OneBot → `qq-send.js` 的 `onebotSend`（`qq-bridge/src/core/qq-send.js:166`）【已核验】，后者是所有模型正文的唯一出口，幂等闸门（`send-idempotency.js`）与节奏控制（`lib/onebot-delivery.js`、`lib/send-gaps.js`）均挂载在其之前。【据仓库记载】

### 10.3 崩溃自愈

表 10-3：场景与自愈手段。口径：每行给出触发场景与该场景下的恢复机制。

| 场景 | 自愈手段 |
| --- | --- |
| 管理器进程内未捕获异常 | 顶层 `unhandledRejection` / `uncaughtException` 守卫记录日志，保持后端存活 |
| 管理器被重启 | 子进程日志改为直写文件（§10.1）；`startInstanceTracked()` 经探活把仍在运行的实例认回，不重复拉起 |
| 桥重启 | `dsh-seq.json` 水位防止事件重放；`sessions.json` 启动时剔除磁盘上已不存在的会话映射，避免每秒重开失效会话 |
| 会话阻塞 | `turn-guard.js` 的静默与总时长看门狗，配合 `quarantineSession()` 隔离重建 |
| 桥进程重复 | `state/bridge.lock` 单实例锁（PID 校验，进程崩溃后锁自动失效） |
| DSH settings 漂移 | 保存配置时自愈改写并重启隔离 DSH |
| DSH 会话堆积 | 空闲会话自动归档（§8.9.1） |
| NapCat 文件缺失 | `napcat-repair.js` 从 `NapCat.Shell.zip` 补齐（§6.3） |
| 应用退出但 NapCat 残留 | 关窗守卫清理（§6.2） |
| SSH 隧道静默失效 | `ensureTunnels()` 每次重建缺失隧道（§4.7） |
| 配置被半截写入 | 全部配置写入走临时文件 + 备份 + rename；状态 JSON 走 `atomicWriteJson`（`qq-bridge/src/lib/json-fs.js:21`）【已核验】 |
| 配置热加载失效 | 目录监听与 2 000 ms 轮询双路并用（§8.10） |
| token 计量缺口 | DSH 权威计数对账补记（§8.12） |
| 桥与 DSH 的标准输出断裂 | 实例日志直写与桥侧 EPIPE 守卫 |

### 10.4 一致做法的来源

表 10-4：静默失效的三类成因与对应做法。口径：三类成因来自仓库注释中记录的同型问题。

| 序 | 成因 | 对应做法 |
| --- | --- | --- |
| 1 | 开关型配置只在部分路径生效（如 `killOnExit` 必须同时传给守卫，否则打包版中的开关不产生效果） | 开关要么全链路生效，要么明确标注不生效 |
| 2 | 轮换计数持续增长而无执行者（回合保持与 `rotationDone` 的接线断开） | 每个提前返回均写日志 |
| 3 | 探测型逻辑占用配额（NapCat 登录接口限流，与 WebUI 页面共用额度） | 探测类行为默认不做；状态未知时不阻断操作，宁可跳过不误伤 |

## 11. 关键不变量

本章界定不可违反的约束及其判据。每条不变量给出保证它的代码位置与违反后果；违反后果列用于判定一次变更是否属于缺陷，而非风险评估。

表 11-1：关键不变量与判据。口径：判据列给出保证该不变量的实现位置或判定函数。

| 序 | 不变量 | 保证它的具体代码位置 | 违反后的后果 |
| --- | --- | --- | --- |
| 1 | 不处理用户本机已安装的 QQ | `napcatManagedDirs()`（`server/index.js:2561`）仅覆盖托管目录、运行记录与配置中手工指定的目录；`listNapcatProcsInDirs()` / `countNapcatProcs()` 以 `$_.Path -like '<dir>*'` 前缀匹配；`stopInstance()` 同判据；窗口隐藏器的 `shellLower` 前缀比较额外补目录边界分隔符（`…\Shell` 不匹配 `…\ShellOther`），取不到 `Path` 的进程一律跳过；`napcat-guardian.mjs` 的 `--dirs` 为空时不终止任何进程；退出清理首判 `napcatLaunchedThisProcess`；卸载脚本只终止安装目录下的进程 | 用户自有 QQ 被强制终止或窗口被隐藏 |
| 2 | 桥不写桌面端 DSH home | `lib/dsh-side.js` 的 `isDesktopDshHome()` 与 `resolveDshTarget()` 的 `refusedDesktop` 分支（`win32` 上拒绝 `%APPDATA%\DeepSeek Harness\dsh-home`） | 污染用户日常使用的 DSH 会话与设置 |
| 3 | 不以 NapCat 登录接口作健康探测 | 管理端删除 watchdog / warm / verify 三条轮询路径（注释保留）；`core/napcat-guard.js` 删除探测与自动重启执行体；`localNapcatOffReason()` 闸门使本机 NapCat 未启用时连令牌验证也不执行 | 占用每 IP 约 10 次 / 60 秒的登录额度（与 WebUI 页面共用），影响扫码 |
| 4 | 同一 QQ 号不在两端同时登录 | `startDispatcher()` 内的 `remoteNapcatRunning()` 闸门与 `stopLocalNapcatBeforeRemote()`（`server/index.js:3177`）【已核验】 | 平台判定为「已在另一台终端登录」并互相下线，表现为该号不产生回复 |
| 5 | 投递只使用 `mode:'steer'` | `prompt-deliver.js` 的投递实现与论证注释 | 使用 `queue` 会使消息永久停留于 `next-turn`（回合不结束时模型不可见） |
| 6 | 密码与密钥不进入 `qq-bridge/config.json` | `POST /api/bridge/config` 先摘除 `dsh.apiKey` 与 `clearApiKey` 再落盘，改由 `iso-credential.js` 写入隔离 home 的凭据文件；本地打包排除表另有 `test-bridge-pack-excludes-config.mjs` 守住 | 明文密钥随配置被同步、打包或复制到目标机 |
| 7 | DSH 的会话日志只由 DSH 自身写入 | `lib/dsh-compaction.js:4-9` 的四条依据；全部压缩经 DSH 自身的 surface 插件执行 | 触发 `corrupt session log: seq gap` 或校验和失败，会话损坏 |
| 8 | `next-step` 的落地事实必须如实回报 | `holdLoop` / `flushStepBatch` 在记账前以 `collectMidTurnBatch(st)` 返回空验证落地 | 谎报成功会使回合静默关闭，消息不被处理 |
| 9 | 实例就绪以真实探活为准 | `instanceReadiness()`（`server/index.js:2729`）【已核验】；`startInstanceTracked()` 先探活再决定是否拉起 | 启动操作返回成功而端口未监听 |
| 10 | 停止操作必须校验真实停止 | `stopInstance()` 在停止后校验端口不再监听 | 旧进程仍占用端口与 `bridge.lock`，表现为重启无效果 |
| 11 | 进程名枚举必须覆盖 `qbm-node.exe` | `killByCmdline()`（`server/index.js:2552`）的过滤条件同时含 `node.exe` 与 `qbm-node.exe` | 发布包中的后备清理永不命中，游离旧桥占用端口与锁 |
| 12 | 桥不推断会话键 | 唤醒正文的 `[Session]` 行与工具层校验（缺 key 时以该行为准） | 工具作用于错误对象（向其它群或账号发送消息） |
| 13 | 出站正文经唯一出口 | `core/qq-send.js` 的 `onebotSend` 加审计链与幂等闸门 | 绕过审计或产生重复发送 |
| 14 | 部署不覆盖目标机能力 | `buildDeployKeepScript()` 的逐键合并（目标机取值优先）加 `state/` 回写 | 一次代码更新清除目标机的 pixiv cookie、语音密钥、白名单、记忆与画像 |
| 15 | 宿主字段与文件路径可含空格或中文 | PowerShell 参数使用单引号字面量转义；`spawn` 传递参数数组；守卫命令行按需加引号；`RUNTIME_ROOT` 不依赖工作目录 | 安装到 `D:\我的 程序\MoonBot` 一类路径时启动失败 |
| 16 | 配置热加载不更换对象引用 | `applyConfigInPlace()`（`qq-bridge/src/core/config.js:467`）【已核验】加目录监听与轮询双路并用 | 已注入配置的十余个模块读取不到新配置，或被旧配置回写覆盖 |

## 12. 未核验项与开放问题

本章汇总两轮之间无法在仓库内核实的条目、代码与注释或文档互相矛盾之处，以及本轮证据索引。凡在正文中未标注【已核验】或【据仓库记载】的论断，均视为【未核验】。

### 12.1 未核验清单

表 12-1：未核验项。口径：需澄清的点给出可解除该未核验状态的具体动作。

| 序 | 项 | 现状 | 需澄清的点 |
| --- | --- | --- | --- |
| 1 | 隔离 DSH 凭据文件在 Windows 的 ACL | `chmod 600` 在 Windows 上不改变 ACL，实际保护依赖 NTFS 默认 ACL | 未在目标环境实测该文件的 ACL |
| 2 | 桥的隔离 home 候选 | `<repo>/../.runtime/dsh-isolated-home`（桥侧默认）与管理器配置的 `dsh-isolated-home-official` 并存 | 实际生效值取决于 `QQB_DSH_HOME` 与管理器配置；两份候选不自动对齐 |
| 3 | `DEFAULT_LOCAL.dshWeb = 3210` | 该字段语义为远端 DSH Web 端口（`tunnelMapFor()` 使用 `m.dshWeb ?? 3080`，`server/index.js:194`）【已核验】，但模板默认值为 3210（`server/index.js:64`）【已核验】，而前端 `RP_DEFAULTS.dshWeb = 3080`（`src/pages/SSHConfig.tsx:11`）与部署脚本硬写的 3080（`server/deploy.js:1384`）一致 | 远端未显式配置时隧道映射到 3210 这一默认值是否统一为 3080；属默认值变更，本轮未修改 |
| 4 | `core/napcat-guard.js` 的 `failThreshold` / `cooldownMs` / `maxHealsPerHour` / `restartGraceSec` / `recoverWaitMs` | 参数保留于 `DEFAULTS`（`qq-bridge/src/core/napcat-guard.js:34`）【已核验】，探测与重启执行体已删除 | 属残留契约还是待重新接线的能力 |
| 5 | 打包工程内部装配规则 | 本文只核对 `build-installer-full.nsi` 与 `moonbot-app/main.js` 的接口事实 | `dsh-runtime/` → `dsh/` 的改名、`full\app\` 的生成顺序、electron-builder 变体的目录布局均未逐条核对 |
| 6 | `GET /api/config` 的 SSH 密码明文 | 现状为明文返回，仅依靠 `127.0.0.1` 绑定收敛暴露面 | 是否纳入脱敏范围需产品决策 |
| 7 | MCP 压缩代理的 `--exclude-tools` / `--toonify` 参数组合 | 由配置与默认值决定 | 未逐一验证每种组合的最终命令行；需要时以隔离 home 的 `cordis.patch.yml` 实际内容为准 |
| 8 | 关窗守卫日志轮转 | 实现中未体现轮转策略 | 长周期运行时的日志体积上界未确定 |
| 9 | `resources/app/` 的具体文件名 | 安装树内该目录存在（§2.2） | 未逐条核对其中文件名；状态为未核验 |

### 12.2 已结案的不一致

表 12-2：已更正项。口径：更正以工作树状态为准，日期为更正批次标识。

| 批次 | 项 | 原状态 | 更正结果 |
| --- | --- | --- | --- |
| 2026-09-25 | `lib/dsh-side.js` 注释与 `qq-bridge/README{,.en}.md` 中的隔离实例端口 `13210` | 工作树无对应实现 | 统一改为 `10721`；实际取值来自 `instances.dshIsolated.port`（目标机为 3080）。该两份 README 已于同日并入根 `README.md`。见 §3.5 |
| 2026-09-25 | 窗口隐藏器注释「观察 120 秒」 | 与 `QQ_HIDER_DEFAULTS.budgetMs = 43200000` 不符 | `server/index.js` 两处注释改为「12 小时」，退出条件归属父进程守卫。见 §6.5 |
| 2026-09-25 | `server/napcat-webui-auth.js` | 原稿记载为「唯一允许调用 `POST /api/auth/login` 的位置」 | 工作树中该文件不存在；职能由「不使用登录接口作探测手段」策略取代。见 §3.1 |
| 2026-09-24 | `qq_send_burst` | 曾计入工具表 | 该工具已移除；工具表以 `state/tool-schema-stats.json` 的 `registered` 与 `available` 为准（§8.8） |

### 12.3 证据索引

表 12-3：本轮新增的【已核验】引用。口径：路径相对仓库根，正斜杠分隔；行号对应本轮工作树状态。

| 引用 | 对象 |
| --- | --- |
| `server/index.js` 全文检索 | 93 条 `app.<method>('<path>')` 路由；SSE 端点 3 个；`WebSocketServer` 出现 0 次 |
| `server/index.js:25-37`、`43-47` | `RUNTIME_ROOT` 与管理端配置目录的定义 |
| `server/index.js:64` | `DEFAULT_LOCAL = { napcatWebui: 6099, napcatHttp: 3000, dshWeb: 3210, bridge: 3100 }` |
| `server/index.js:81`、`585`、`2618` | 隔离 home 默认值、隔离实例端口解析 |
| `server/index.js:189-196` | `tunnelMapFor()` 的四条隧道映射 |
| `server/index.js:1336` | `QQ_HIDER_DEFAULTS`（含 `budgetMs: 43200000`） |
| `server/index.js:1910` | `armQqWindowHider()` |
| `server/index.js:2301-2441` | `napcatLaunchedThisProcess` 的置位点与其在退出清理中的前置判定 |
| `server/index.js:2552`、`2561` | `killByCmdline()`、`napcatManagedDirs()` |
| `server/index.js:2676-2679` | `startupBudgetMs()`（90 000 / 120 000 / 45 000 ms） |
| `server/index.js:2729`、`3208` | `instanceReadiness()`、`keyOf()` |
| `server/index.js:2999`、`3177`、`3189` | 守卫武装、远端 NapCat 前置停止、`DUAL_LOGIN_HINT` |
| `server/index.js:9884` | `spawnGuardianDetached()` |
| `server/napcat-guardian.mjs:52` | `graceMs` 缺省值 30000 |
| `server/iso-credential.js:140` | `validateCredentialDocument()` |
| `qq-bridge/src/core/mux.js:129`、`281`、`299`、`766` | `unwrapCompressedToolName()`、`isDuplicateInbound()`、`handleIncoming()`、`pumpMux()` |
| `qq-bridge/src/core/wake-send.js:75`、`97`、`111`、`182`、`248-250`、`306`、`433`、`479`、`641-699`、`836` | 轮换推迟上限、阈值解析、`rotationDue()`、`evaluateWakeTrigger()`、人设文件上限、`shouldInjectPersonaBlock()`、`buildWakePrompt()`、召回摘要参数、合并注入常量、`steerIntoRunningTurn()` |
| `qq-bridge/src/core/social-state.js:854`、`1001-1002`、`1052` | `scheduleWake()`、看门狗常量、`startDeliveryWatchdog()` |
| `qq-bridge/src/core/prompt-deliver.js:17`、`97`、`114` | `QUEUE_MAX`、退避公式、`deliverPromptNow()` |
| `qq-bridge/src/core/turn-hold.js:45`、`48`、`132-158`、`226`、`358` | 轮询与续期间隔、`holdLoop()` 参数、打字退避、`flushStepBatch()` |
| `qq-bridge/src/core/turn-guard.js:16`、`17`、`21` | 三个回合超时常量 |
| `qq-bridge/src/core/typing-hold.js:18-22`、`94`、`122` | `TYPING_DEFAULTS`、`midTurnSteerGate()`、`midTurnSteerText()` |
| `qq-bridge/src/core/napcat-guard.js:34` | `DEFAULTS`（探测与重启执行体已删除） |
| `qq-bridge/src/core/session-archive.js:29-32` | 归档默认参数 |
| `qq-bridge/src/core/memory.js:87`、`89`、`90`、`143` | `MEMORY_TIERS`、`PERMANENT_CATEGORIES`、`FTS_SCHEMA_VERSION`、FTS5 trigram 建表 |
| `qq-bridge/src/core/config.js:467`、`507` | `applyConfigInPlace()`、`watchConfigFile()` |
| `qq-bridge/src/core/dsh-session.js:169` | `createStandbySession()` |
| `qq-bridge/src/core/qq-send.js:166` | `onebotSend()` |
| `qq-bridge/src/core/runtime.js:8` | `acquireLock()` |
| `qq-bridge/src/core/token-meter.js:550` | `meterTokenFrame()` |
| `qq-bridge/src/core/audit.js:76` | `appendToolLog()` |
| `qq-bridge/src/core/tunables.js:136` | `resolveIsolatedDshHome()` |
| `qq-bridge/src/core/config.js:20`、`70`、`94` | 桥侧 `dsh.baseUrl`、`napcat.wsUrl`、`consolePort` 默认值 |
| `qq-bridge/src/lib/dsh-side.js:252`、`302` | `mcpBlock()`、`patchProfileCordis()` |
| `qq-bridge/src/lib/dsh-compaction.js:112-123`、`198` | `disabled: false` 写入点、`syncDshCompactionPatch()` |
| `qq-bridge/src/lib/preset-compose.js:123` | `watchOverrideFiles()` |
| `qq-bridge/src/lib/tool-tiers.js:45`、`144-148` | `qq_status` 保留、档位与手写表互斥 |
| `qq-bridge/src/lib/tool-schema-compress.js:33`、`76` | `SCHEMA_LEVELS`、`withOwnDesc()` |
| `qq-bridge/src/lib/json-fs.js:21` | `atomicWriteJson()` |
| `qq-bridge/src/lib/log.js:20` | `appendActivity()` |
| `qq-bridge/src/mcp-napcat-safe.js:734` | `registerTool()` 定义（调用 91 次） |
| `qq-bridge/state/tool-schema-stats.json` | 工具 schema 体积与各档位份额快照 |

