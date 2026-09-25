# 架构

本文描述 MoonBot Pro 的完整结构：系统边界与进程拓扑、安装布局与路径解析、通信面全表、首次启动状态机与鉴权、NapCat 守护与自修、SSH 克隆部署、DSH 集成、打包与分发、可靠性与可观测性，以及一条 QQ 消息的完整生命周期。

行号引用的是写作时的仓库状态，重构后可能平移；**函数名与文件名是稳定锚点**。凡本文无法从工作树代码直接核实的条目，一律写成"未验证 / 待确认"，不做推测性叙述。

阅读约定：

| 标记 | 含义 |
| --- | --- |
| `路径:函数名` | 稳定锚点（行号只作定位参考） |
| 「待确认」 | 撰写时无法在仓库内核实的事实（多为仓库外流水线或运行期外部状态） |
| 「历史坑」 | 已经修掉的错误实现及其后果，用于防止回归 |

---

## 1. 分层

```
用户（QQ 群 / 私聊）
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
│   三组 MCP server（stdio）：mcp-napcat-safe / mcp-napcat-host / │
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

管理端（Electron + React + Express）不在这条数据链上，它是**编排者**：拉起上面的进程、写配置、看日志、SSH 部署。

各层入口与职责：

| 层 | 入口 | 职责 |
| --- | --- | --- |
| 管理端前端 | `src/App.tsx`、`src/api.ts` | 页面切换与后端接口封装；页面在 `src/pages/`，共享组件在 `src/components/`，类型在 `src/stores/types.ts` |
| 管理端后端 | `server/index.js` | HTTP API、实例编排与探活、前端静态托管、安装位置体检（`RUNTIME_ROOT`，`server/index.js:25-31`） |
| 远程部署 | `server/deploy.js` | SSH 克隆部署：打包 → 流式转发 → 目标机解包 → systemd / NapCat 容器 → 启动自检 |
| 关窗守卫 | `server/napcat-guardian.mjs` | 独立进程，壳退出后兜底停 NapCat / 桥 / 隔离 DSH |
| 连接状态机 | `server/connect-machine.js` | 连接服务端的阶段机：`connecting → tunnels → server-starting → warming → ready / failed`，并把远程三件套（DSH / NapCat / 桥）逐个判定成 ready/starting/down；纯逻辑，界面读 `/api/connect` 或 `/api/state.connect`（零网络） |
| 隔离凭据 | `server/iso-credential.js` | 隔离 DSH 的 `.credentials.yaml` 读写（本地直写与服务端 HTTP 写盘共用，可单测） |
| NapCat 自修 | `server/napcat-repair.js` | 检查并补齐 NapCat Shell 目录内缺失的模块文件（见 §14.3） |
| QQ 桥入口 | `qq-bridge/src/bridge.js` | 载入配置、连接 OneBot 反向 WS、装载事件泵与各子系统 |
| 桥业务层 | `qq-bridge/src/core/*.js` | 唤醒投递、提示词组装、会话映射、社交状态、发送链、媒体与卡片、语音、学习、用量 |
| 桥基础库 | `qq-bridge/src/lib/*.js` | OneBot 客户端、消息解析、图片体检、Pixiv、路径、文本处理等 |
| 桥工具层 | `qq-bridge/src/mcp-*.js` | 三组 MCP server |
| 隔离 DSH | `qq-bridge/dsh/agent-presets/qq-chat/` | `preset.yml` / `agent.cordis.yml` 提供行为规则，`qq-tool-restrict.mjs` 限制可用工具 |
| DSH 插件 | `qq-bridge/plugins/dsh-qq-hold/`、`qq-bridge/plugins/qq-mode-console/`、`qq-bridge/plugins/dsh-memory/` | 回合保持、模式控制台、长期记忆 |
| NapCat | `napcat-onekey/` | 便携版 NapCat 与 QQ（`NapCat.Shell.zip`、`NapCatInstaller.exe`、`QQ.exe`、`NapCat.44498.Shell/`、`bootmain/`） |

> 历史条目更正：本文早先版本列出的 `server/napcat-webui-auth.js`（"唯一允许调用 `POST /api/auth/login` 的地方"）**在工作树中已不存在**（`server/` 当前只有 `connect-machine.js`、`deploy.js`、`index.js`、`iso-credential.js`、`napcat-guardian.mjs`、`napcat-repair.js`）。其职能已被"**根本不拿 NapCat 登录接口当探测手段**"这条更彻底的策略取代，判据与原因见 §14.4。

### 1.1 系统边界

| 边界 | 内部 | 外部 | 交互方式 |
| --- | --- | --- | --- |
| 本机安装树 | 管理端后端、前端产物、`qq-bridge/`、`napcat-onekey/`、`dsh-runtime/` | — | 全部路径由 `RUNTIME_ROOT` 派生（§11.2） |
| 用户数据 | `%USERPROFILE%\.qq-bridge-manager\`（配置、日志、守卫文件、方案库、隔离 home） | — | 与安装树分离，卸载/换盘不影响 |
| 桥 ↔ QQ 平台 | qq-bridge | NapCat（OneBot v11） | WebSocket（反向 WS 3001）+ HTTP 3000 |
| 桥 ↔ agent 运行时 | qq-bridge | 隔离 DSH | HTTP `/api/<ns>/<method>` + WebSocket `/api/remote.mux` |
| agent ↔ 模型服务商 | 隔离 DSH | DeepSeek 官方 / 小米 MiMo / 任意 OpenAI 兼容端点 | 由 DSH provider 配置决定，凭据来自 `.credentials.yaml`（§16.5） |
| 管理端 ↔ 目标机 | 管理端后端 | 远端 Linux 主机（`/root/qq-bridge`、`/root/.dsh`、`/opt/napcat`） | ssh2（命令 + 隧道 + 流式转发） |
| 管理端 ↔ 浏览器前端 | 管理端后端 | 本机浏览器 / 内嵌窗口 | HTTP `127.0.0.1:1921`（开发模式走 Vite 5173 代理） |
| 仓库 ↔ 打包工程 | 本仓库 | `C:\Users\17367\Desktop\QQ-Bridge-packaging`（**不在本仓库**） | 打包工程单向消费本仓库产物（§17） |

### 1.2 角色划分

| 角色 | 承担者 | 一句话职责 | 明确不做 |
| --- | --- | --- | --- |
| 接入层 | NapCat（随包 OneKey 版） | 把 QQ NT 转成 OneBot v11 服务端（WebUI 6099 / HTTP 3000 / WS 3001） | 不做唤醒判定、不组装提示词 |
| 桥接层 | `qq-bridge/src/bridge.js` 及其 `core/`、`lib/` | 唤醒判定、提示词组装、会话映射、DSH 投递、事件泵、工具调用、发送链、审计、计量、学习 | 不直接访问 QQ 协议、不自己改 DSH 的历史日志（§8.3） |
| agent 运行时 | 隔离 DSH（独立 `DSH_HOME`） | 维护模型回合、工具体、上下文压缩、会话持久化 | 不知道 QQ 的存在，只看到桥投进来的提示词与 MCP 工具 |
| 编排者 | 管理端后端 `server/index.js` | 进程生命周期、配置读写、探活、日志、SSH 部署、前端托管 | 不在数据链上，不参与消息处理 |
| 客户端 | 管理端前端 `src/` | 界面与用户操作，代理调用后端与桥控制台 | 不做状态判定（phase 由后端给） |
| 兜底清理 | `server/napcat-guardian.mjs` | 应用退出后按托管目录/绝对路径/端口收尾 | 不碰非托管目录下的任何进程 |
| 部署器 | `server/deploy.js` | 把整套能力迁到目标机并自检 | 不覆盖目标机已有的用户配置与能力（§15.4） |

### 1.3 两侧配置严格分开

- 管理端配置：`%USERPROFILE%\.qq-bridge-manager\config.json`，日志 `…\.qq-bridge-manager\logs\`（`server/index.js:37-47`）
- 桥配置：`<运行时>/qq-bridge/config.json`，模板 `qq-bridge/config.example.json`

桥配置的顶层键（`qq-bridge/config.example.json`）：`dsh`、`dshCompaction`、`napcat`、`pixiv`、`ownerQQ`、`guard`、`sessionCwd`、`agentPreset`、`workspaceTitle`、`allow`、`deny`、`allowAllWhenEmpty`、`allowAllPrivate`、`allowAllGroups`、`ackMessage`、`sendDelayMs`、`questionTimeoutMs`、`consolePort`、`consoleToken`、`prompt`、`tokenCost`、`security`、`slang`、`social`。

两者**永不互相回落**：前端缓存按"读取目标"分键（本机桥配置 / 服务端桥配置各一份，`src/config-cache.ts`），把本机那份显示成服务端那份比闪一下默认值更危险。

---

## 2. 端口与进程

### 2.1 端口全表

| 端口 | 服务 | 绑定 | 用途 | 依据 |
| --- | --- | --- | --- | --- |
| 1921 | 管理端后端 | `127.0.0.1` | HTTP API + 前端静态托管，`QBM_API_PORT` 可覆盖，`QBM_NO_LISTEN=1` 时只导出 app 不监听 | `server/index.js` `app.listen` |
| 5173 | Vite dev server | `127.0.0.1`（`strictPort`） | 仅开发模式；`/api` 代理到 `http://127.0.0.1:1921` | `vite.config.ts` |
| 6099 | NapCat | 本机 | 官方 WebUI：扫码登录、OneBot 配置 | `DEFAULT_LOCAL.napcatWebui` |
| 3000 | NapCat | `0.0.0.0` | OneBot HTTP 动作接口（`send_qzone_msg` 等走这里），token `truefriend` | `server/index.js:1223` 附近 |
| 3001 | NapCat | `127.0.0.1` | OneBot 反向 WS 事件推送（桥连的就是它），token `truefriend` | 同上；桥侧默认 `ws://127.0.0.1:3001`（`core/config.js`） |
| 10721 | 隔离 DSH | 本机 | agent 运行时 API（`core/config.js` 默认 `dsh.baseUrl`；管理端默认 `instances.dshIsolated.port`） | `core/config.js`、`server/index.js:81` |
| 3100 | 桥 | `127.0.0.1` | 本地控制台（`core/config.js` 的 `consolePort`） | `server/index.js:539`、`core/console-server.js` |
| 3210 | 隔离 DSH（`DEFAULT_LOCAL.dshWeb`） | 本机 | `resolveServices()` 在内嵌界面里用的"本机 DSH"默认端口，与实际 `instances.dshIsolated.port`（10721）是两套取值 | `server/index.js` `DEFAULT_LOCAL` |
| 3080 | 隔离 DSH（目标机） | 目标机 | 远端 `dsh-web.service` 的 `--port 3080`；桥配置会被改写为 `http://127.0.0.1:3080` | `server/deploy.js:1384-1394`、`1428` |
| 13000 / 13001 / 13080 / 13100 | SSH 本地隧道 | 本机 | 远端 6099（NapCat WebUI）/ 3000（OneBot HTTP）/ 3080（DSH Web）/ 3100（桥控制台）映射到本机回环 | `server/index.js:189-196` `tunnelMapFor()` |

> 线上克隆部署时，`server/deploy.js` 有一段 node 内联脚本把目标机 `/root/qq-bridge/config.json` 的 `dsh.baseUrl` 改写成 `http://127.0.0.1:3080`。也就是说**服务器上隔离 DSH 与本地默认端口不同**，对着日志排查时不要混用。
>
> 远端端口可用配置覆盖：`tunnelMapFor()` 读 `cfg.local`（`DEFAULT_LOCAL = { napcatWebui: 6099, napcatHttp: 3000, dshWeb: 3210, bridge: 3100 }`）。`dshWeb: 3210` 是**桌面端** DSH Web，与隔离实例（默认 `instances.dshIsolated.port = 10721`）是两个不同对象，不要混用。
>
> 历史残留已清（2026-09-25）：`qq-bridge/src/lib/dsh-side.js` 顶部注释与 `qq-bridge/README{,.en}.md` 原先把隔离实例端口写成 `13210`，工作树里没有对应实现，现已统一改为 `10721`（端口实际取自 `instances.dshIsolated.port`；目标机为 `3080`）。

### 2.2 进程拓扑

| 进程（Windows） | 可执行文件 | 由谁启动 | 父进程 | 关键启动参数 / 环境 | 日志 |
| --- | --- | --- | --- | --- | --- |
| 应用壳 | `MoonBot.exe` | 用户 | `explorer.exe` | Electron 壳；源码**不在本仓库**（§17） | 无 |
| 管理端后端 | `qbm-node.exe`（随包 Node 运行时） | 应用壳 | `MoonBot.exe` | `server\index.js`；`windowsHide` | `%USERPROFILE%\.qq-bridge-manager\logs\manager.log`（`mlog()`） |
| 隔离 DSH | `qbm-node.exe` | 管理端后端 | 管理端后端 | `<dshBin> --profile web --port 10721 --no-open --trusted-host 127.0.0.1:10721 --trusted-host localhost:10721`；`DSH_HOME=<isolatedHome>`；另注入 `.credentials.yaml` 的环境变量；直接跑 `bin.js` 时附加 `--expose-internals` | `instanceLogPath('dsh-isolated')` |
| 桥接层 | `qbm-node.exe` | 管理端后端 | 管理端后端 | `node src/bridge.js`；`cwd =` 桥目录；`DSH_ISOLATED_LOG_FILE=<隔离 DSH 实例日志>` | 实例日志 + `qq-bridge/state/bridge.log` |
| NapCat 启动器 | `WindowsPowerShell\v1.0\powershell.exe` | 管理端后端 | 管理端后端 | `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -FilePath NapCatWinBootMain.exe -WorkingDirectory <onekey.dir> [-ArgumentList <QQ号>] -WindowStyle Hidden"` | 实例日志 |
| NapCat / QQ | `NapCatWinBootMain.exe` → `QQ.exe` | 上述启动器 | powershell（启动器通常毫秒级退出，QQ 被重新挂到系统进程下） | 仅托管目录内的那份 | 实例日志 |
| 窗口隐藏器 | `powershell.exe -File <temp>.ps1` | 管理端后端 | 管理端后端 | 常驻，200 ms 轮询、12 小时预算、父进程存活守卫 | 实例日志 |
| 关窗守卫 | `guard-node.exe`（`qbm-node.exe` 的硬链接） | 管理端后端 | `WmiPrvSE.exe`（由 WMI 创建） | `napcat-guardian.mjs --parent <appPid> --guard-file <...> --dirs <JSON> --dsh-port <n> --bridge-script <abs> --kill-napcat <0\|1> --log <file>` | `%USERPROFILE%\.qq-bridge-manager\logs\napcat-guardian.log` |

关于"进程名"的几个事实：

- 发布包用的是随包 Node 运行时 `qbm-node.exe`，**不是** `node.exe`。所有按进程名过滤的兜底清理必须同时覆盖两者，否则在真机上永远匹配不到（`killByCmdline()` 的注释记录了这次事故：管理器重启过之后「停止/重启桥接」返回成功，老桥却还占着 3100 与 `state/bridge.lock`）。
- 守卫被刻意"送出"应用进程树，两招缺一不可（`spawnGuardianDetached()`）：
  1. **换可执行文件路径**——壳的兜底清理是按 `$_.Path -eq '<runtime>\qbm-node.exe'` 精确匹配的，所以给守卫做一个同盘硬链接 `guard-node.exe`；
  2. **用 WMI 创建进程**——父进程变成 `WmiPrvSE.exe`，壳的 `taskkill /T`（顺父链枚举）够不着。守卫"该盯谁"由 `--parent` 显式传入，不依赖真实父进程。
  - WMI 建进程必须带 `Win32_ProcessStartup.ShowWindow = 0`；实测 `CreateFlags = CREATE_NO_WINDOW` 会让 `Win32_Process.Create` 直接返回 21（InvalidParameter），退回普通 `Create` 会额外弹一个 Windows Terminal 黑窗。
- NapCat 的"隐藏启动"只有一条路径：PowerShell `Start-Process -WindowStyle Hidden`（`startNapcatHidden()`，`server/index.js:1291-1310`）。被跟踪的那个 powershell 子进程本就秒退，因此 NapCat 的存活判据**不看 `exitCode`**，而看"托管目录下还有没有 NapCat/QQ 进程"（`countNapcatProcs(napcatManagedDirs(rt))`）。

### 2.3 启动顺序与就绪判据

实例只有三个：`napcat-local`、`dsh-isolated`、`bridge-local`（`keyOf()` 把 id 映射到 `instances.napcatLocal / dshIsolated / bridgeLocal`）。

启动顺序（依赖关系）：**NapCat（QQ 网关）→ 隔离 DSH（agent 运行时）→ 桥**。三条入口共用同一套状态机：

| 入口 | 路由 | 行为 |
| --- | --- | --- |
| 单实例卡片 | `POST /api/instance/:id/:action`（`start` / `stop` / `restart`） | 立即返回 `starting`，后台轮询推进 |
| 启动整套 | `POST /api/instance/start-all` | 按依赖顺序逐个 `waitInstanceReady`，每步真正就绪才走下一步 |
| 开机/开窗自动恢复 | `scheduleAutoStart()` | 只恢复 `instances.<key>.enabled === true` 且未被 `instances.<key>.autoStartOnBoot === false` 排除的实例；逐个之间间隔 1200 ms；**不等就绪** |

状态机（phase）：`idle → starting → running`，异常进 `failed`（`stopping` 是 `stop`/`restart` 的过渡态）。

就绪判据是"端口/HTTP 真的在应答"，不是"我们 spawn 过"（`instanceReadiness()`）：

| 实例 | ready 判据 | 附加 note |
| --- | --- | --- |
| `dsh-isolated` | `GET http://127.0.0.1:<port>/` 可达（401/200 都算活） | 端口已监听但还没解析到 token → "已监听，等待就绪" |
| `napcat-local` | WebUI 端口在监听 | 3000/3001 任一在听才算"已登录"，否则提示"WebUI 已起，等待 QQ 扫码登录" |
| `bridge-local` | `GET http://127.0.0.1:<port>/` 可达 | 等待桥接监听端口 |

- 启动预算：`startupBudgetMs(id)`，`napcat-local` 120 000 ms、`bridge-local` 45 000 ms（其余走默认）。
- 失败信息来自实例日志尾部：`readFailureReason()` 用 `FAIL_PAT` 正则挑出最像原因的两行，写进 `phase.error`；进程中途消失（非 NapCat）或超时同样落到这里。
- 已在运行的实例会被**认回**而非重复拉起：`startInstanceTracked()` 先探活，命中则置 `running` 并标 `adopted`。NapCat 必须走这条路——重复启动会挤出已经扫码登录的那份。

### 2.4 退出与清理语义

四级收尾，前一级失败由后一级兜：

1. **应用侧主动收摊**：壳在关窗前调用 `POST /api/shutdown`。默认只收 NapCat；带 `{all:true}` 时连桥与隔离 DSH 一起收。`killOnExit` 开关为关时 NapCat 完全不被触碰，响应里用 `napcatSkipped` 如实告知调用方"这次是故意没收"（`killOnExitEnabled()` 默认 `true`，对应配置 `instances.napcatLocal.killOnExit`）。
2. **壳的进程树清理**：`taskkill /pid <后端> /T /F`，再按可执行文件路径清理残留 `qbm-node.exe`。
3. **本进程的退出钩子**：`server/index.js` 的退出路径按 `napcatSpawnedPids` / `napcatLaunchedThisProcess` 判断"本次是否由我拉起"，只有为真才杀；`killNapcatOnExitSync` 的第一个判断就是该标记，没有它绝不碰任何 NapCat 进程。
4. **关窗守卫**：`server/napcat-guardian.mjs`，独立进程（不在应用进程树内）。轮询间隔 2000 ms；父进程消失后等待 `graceMs`（默认 30 000 ms，命令行 `--grace` 可改，早期值为 6 秒），再**重新读一次 guard 文件确认归属**，避免"管理端重启、新后端已接管"时把新一套收掉；然后依次清理 NapCat → 桥 → 隔离 DSH。`--dirs` 为空则什么都不杀。

守卫的清理判据都是"精确匹配"而非模糊匹配：托管目录前缀（`--dirs`）、桥的绝对路径（`--bridge-script`）、DSH 端口（`--dsh-port`），且排除自身（`NOT_SELF`）。缺参数时跳过对应清理，宁可漏收不可误杀。

守卫的武装条件与复查：

| 条件 | 行为 | 依据 |
| --- | --- | --- |
| `QBM_NAPCAT_GUARDIAN=0` | 整体关闭 | `ensureGuardianArmed()` |
| guard 文件里的守卫还活着 | 什么都不做 | 同上 |
| 本后端父进程名为 `MoonBot` | 盯它 | `parentProcessName()` |
| 否则找一台在跑的 `MoonBot.exe` | 盯它（应用复用已在跑的后端时，靠这条在 60 秒内补上守卫生效） | `findMoonBotPid()` |
| 应用没开 | 静默等待，不武装（**绝不拿一个来路不明的 PID 当"应用"**） | 同上 |
| `POST /api/guardian/arm` | 手工武装：`body.parentPid` 或自动找第一个 `MoonBot` 进程；进程名不是 `MoonBot` 一律拒绝 | 路由实现 |

### 2.5 单点登录互斥（跨实例硬闸门）

同一个 QQ 号不能同时挂在本机与服务端两个端点——腾讯会判定"已在另一台终端登录"并互相踢下线，现场表现就是"又不回复了"。因此后端有一条与前端无关的硬闸门（`startDispatcher()` 内）：

- 服务端 NapCat 在线时，**拒绝启动本机 NapCat**，返回可读原因（`DUAL_LOGIN_HINT`）；
- 反过来要启/重启服务端 NapCat 时，先把本机那份停掉（`stopLocalNapcatBeforeRemote()`，服务端是生产端点）。

探测读的是已有的 `remoteStatusCache`（状态轮询一直在刷），缓存冷了才多花一次 SSH 往返；拿不到状态时按 `known:false` 处理，**未知就不拦人**，避免误伤。

---

## 3. 一条入站 QQ 消息的完整事件流

入口在 `qq-bridge/src/bridge.js`：

- `bot.onPrivateMessage` → `handleIncoming('private', user_id, event, cfg)`（`bridge.js:575-578`）
- `bot.onGroupMessage` → `handleIncoming('group', group_id, event, cfg)`（`bridge.js:579-582`）
- `bot.onNotice('notify')` → 拍一拍 / 输入状态（`bridge.js:583-586`）
- 撤回事件 → 标 `[已撤回]` + 落库 `chat_messages.recalled_at`（`bridge.js:589-614`）

### 3.1 入站归一（`core/mux.js` 的 `handleIncoming`，`mux.js:295`）

| 步骤 | 做什么 | 位置 |
| --- | --- | --- |
| 1 | `convKey(kind, id)` → 会话键 `private:<QQ>` / `group:<群号>`；模式不允许直接忽略 | `mux.js:296-300` |
| 2 | 两套正文：`textContent`（带 `[引用 X：…]`，供判断"这句话在对谁说"）与 `plainContent`（只有本条文字，供命令与指向性判定） | `mux.js:309-310` |
| 3 | 私聊违法/诈骗内容自动删好友并拉黑（`social.autoFriendGuard`） | `mux.js:312-322` |
| 4 | 抽媒体段与文件段，按 `message_id` / `message_seq` 存进 `messageMediaStore`（超过 `MAX_MEDIA_STORE_PER_KEY` 丢最旧） | `mux.js:323-341` |
| 5 | 判断"引用的对象是不是机器人自己"（`isQuoteTargetSelf`）——**必须在空文本过滤之前**，否则"只引用不附文"会被漏掉 | `mux.js:344` |
| 6 | 入站幂等去重 `isDuplicateInbound(key, messageId)`，防重复入库 → 重复唤醒 → 重复回复 | `mux.js:347-350` |
| 7 | 有挂起提问时先当回答消费；静默模式只记不投；角色切换/人格学习/画像学习/斜杠命令分流 | `mux.js:356-540` |

### 3.2 唤醒判定（`core/wake-send.js` 的 `evaluateWakeTrigger`，`wake-send.js:174`）

返回一个"原因字符串"，它会变成注入正文里的 `[Wake …]`。判定顺序（顺序本身就是设计，改之前先读注释）：

1. 私聊 → `private`
2. 群聊且处于睡眠窗口 → 只放行 @ 或引用机器人，其余一律不投（省 token）
3. **@ / 引用优先于 `anyMessage`** —— 这条是 2026-09-19 的修复：`anyMessage` 排在前面时，"@" 会被标成 `anyMessage`，而免打扰时段只放行"真实触发"，于是群里 @ 它却没反应
4. `nameMention`（点名）、`keyword:<词>`（短英文/数字关键词用词边界匹配，避免 `ADS`/`BDSM` 误触发）、`question`（`isDirectedAtAi`）、`topic`（AI/技术话题接话，正则 `TOPIC_WAKE_RE`）、`speaker:<昵称>`、`probability`

### 3.3 唤醒调度与投递

| 环节 | 文件 | 说明 |
| --- | --- | --- |
| 唤醒调度统一入口 | `core/social-state.js` 的 `scheduleWake(key, reason)`，`social-state.js:854` | 合并窗、免打扰、忙碌分流、轮换判定都在这条路上 |
| 投递看门狗 | `social-state.js` 的 `startDeliveryWatchdog()`，`social-state.js:1052` | 间隔 20 秒扫一次；`WATCHDOG_DEFAULT_OVERDUE_MS = 25000`，重试下限 `WATCHDOG_DEFAULT_MIN_RETRY_MS = 60000`（`social-state.js:1000-1002`）。判据是 `_wakeIntendedSeq`（**桥打算交付**的最高 seq）而不是"有没有被回复"——模型看到后选择不回是它的自由，但**没看到**必须被兜住 |
| 提示词组装 | `wake-send.js` 的 `buildWakePrompt(key, reason)`，`wake-send.js:400` | 见 3.4 |
| 投递执行 | `core/prompt-deliver.js` 的 `deliverPrompt` → `deliverPromptNow`，`prompt-deliver.js:107` | 过 `ensureSession()` 拿 sessionId，30 秒超时；超时/失败 → `quarantineSession()` 隔离该会话 |
| DSH 调用 | `prompt-deliver.js:158` | `api.sessions.prompt({ sessionId, mode: 'steer', content })` |
| 事件泵 | `core/mux.js` 的 `pumpMux()`，`mux.js:745` | `api.events.mux()` 逐帧处理 `session/event` |

**为什么投递只用 `mode:'steer'`、永远不用 `queue`**（`prompt-deliver.js:137-157` 的完整论证）：

- `queue` → `agent.followup()` → 进 inbox 的 **next-turn** 队列；`next-turn` 只在回合循环的**下一次迭代**被 claim。只要当前回合永不结束（模型挂着长轮询、或被重启打断后僵在 running），这条消息就**永久停在 next-turn 里**——模型看不到，桥也收不到任何事件。
- `steer` → `agent.steer()` → 进 **next-step** 队列；`inbox.claim()` 总是先把 `next-step` 全部取走。回合在跑 → 本回合的下一个 step 边界就交给模型；agent 空闲 → 第一时刻开回合并领走。
- 结论：**steer 是全定义的**，无论忙闲都必定被取走，不可能被搁浅。定调是"**不静默 > 不注入**"。

投递队列（`prompt-deliver.js:17` 起）：`QUEUE_MAX = 50`，同 key 去重，退避 `min(3000·2^(n-1), 60000)`，连续失败 5 次后降到 60 秒一次。DSH 未就绪时消息**入队不丢**，就绪后按序补投（`flushQueue`）。

### 3.4 注入正文长什么样

唤醒正文只携带**数据行**，"该怎么做"全部在预设的系统提示词里（`[WAKE TYPES]`）。正文骨架由 `buildWakePrompt` 拼（`wake-send.js:400-550`）：

| 行 | 含义 | 位置 |
| --- | --- | --- |
| `[Token] <令牌>` | 本会话当前有效令牌（发送类工具要它） | `wake-send.js:415` |
| `[Session] <key>` | **确切的会话键**，工具层"永不猜 key"，缺 key 就指回这一行 | `wake-send.js:344`、`415` |
| `[Style] …` | 每轮一句语感提醒，文案走 `config.json` 的 `prompt.styleLine`（默认 `[Style] 说人话：短、有态度，别讲课别列举`） | `wake-send.js:360-374` |
| `[OWNER]` / `[NOT-OWNER]` | 主人私聊带前者；**非主人的私聊**显式写后者（修"认主认错人"） | `wake-send.js:404-411` |
| `[Status]` | `N unread; waiting on …; last from …; said Nmin ago`（**已不再有时间行**：原来的 `[Now]` 是"拼装那一刻"，模型动手时已过期，会答错时刻；"现在几点"改由 MCP 工具 `get_time` 现取，北京时间到分钟） | `wake-send.js:484-485`；工具见 `src/mcp-napcat-safe.js` |
| `[Wake]` / `[WakeRef]` | 当前模式、时长、触发器，以及**主人配置的插话概率 / 当前生效值 / 来源** | `wake-send.js:326-336`、`496` |
| `[Recall]` / `[Profile]` / 联系人行 | 长期记忆摘要（永久层，约 700 字符上限、14 条）、会话对象档案 | `wake-send.js:436-454` |
| `[Unread n]` / `[Mid-turn]` / `[Note]` | 未读与在途块 | 见第 4 节 |
| `[PERSONA]` / `[SPEECH RULES]` | **只在需要时**注入 | 见下 |

人设与发言规则已经由 `lib/preset-compose.js` 合成进**系统提示词**，所以唤醒正文默认不再重复塞一份。判据（`shouldInjectPersonaBlock`，`wake-send.js:298`）：preset 里那份**是当前版本**（`getComposedPersonaStamp() === runtimeOverrideStamp()`）且这个会话没有"需要补注入"标记 → 不注入；否则注入一次。

- 文件上限：`persona.md` 16000 字符、`speech-rules.md` 12000 字符（`wake-send.js:240`）
- 超限时**保头 + 保尾**（尾部 2500 字符必留），并把"砍掉了第几到第几个字符"写进日志（`wake-send.js:260-271`）。旧实现只保头、整段丢尾——这是"往文件末尾追加规则等于白写"的机制原因
- 改文件 → `watchOverrideFiles()`（`lib/preset-compose.js`，由 `bridge.js:288` 装上）立刻重新合成进预设；正在跑的老会话靠 `markStalePersonaReinjects()` 在启动时打一次补注入标记

### 3.5 出站：回合结束 → QQ

事件泵里 `collector.push(frame.event)` 返回 `ended` 时回合收尾（`mux.js:909-1084`），要点：

- **已回复账本**：本回合"负责"的消息 = 唤醒时展示的（`turnSeenUnread`）+ 中途 steer 进来的（`turnSteeredSeqs`）。只算前半截会造成致命循环——steer 进来的 seq 永远进不了 `answeredMessageIds` → 下一轮又被当新消息 → 重复回复。
- 账本要从 `recentMessages` 里找，**不能遍历 `unread`**：模型在回合内调 `mark_read` 时就已经把"展示过的"未读摘掉了。
- 回合结束清空 `turnSeenUnread` / `turnSteeredSeqs` / `_steerDeferredSeqs`。
- **无行动兜底**：连续 `social.wake.noActionLimit`（默认 3）次唤醒既没发消息也没 `mark_read` / `set_wake_config` → `softResetWakeConfig()`。
- **防遗忘提醒**：`pendingWakeKeys` 里的会话若没更新唤醒配置，发提醒，最多 `maxWakeConfigReminders`（默认 2）次，之后软重置。
- **暂存唤醒合并补发**：忙的时候暂存的唤醒原因**合并成一次**最高优先级唤醒投出去，避免"补发 → 又忙 → 再积压"的连环唤醒。

发送链本身在 `core/send-chain.js`（`enqueueSend` / `currentSendChain`）、`core/qq-send.js`（`onebotSend`，所有模型正文的唯一出口）、`core/send-idempotency.js`（幂等闸门，防 `/reset` 之后重复回一次）、`lib/onebot-delivery.js`（分段与节奏）、`lib/send-gaps.js`（`computeGaps` / `clampGap`）。

---

## 4. 唤醒 / 在途注入 / 回合保持

这三套机器是同一个问题的三个层次：**消息到了，怎么让它尽快、尽量少花钱地进到模型手里。** 主实现在 `core/wake-send.js`、`core/turn-hold.js`、`plugins/dsh-qq-hold/`。

### 4.1 回合保持的原理（为什么能"不另起一轮"）

依据 DSH 源码（`dsh-agent-loop/lib/index.js:564-572`，写进 `turn-hold.js:4-14`）：一个模型步跑完、没有活着的工具调用、`next-step` 为空时回合**会**关；但关之前会 `await` 一次 `agent/turn-stopping` 插件钩子，并在钩子返回后**重新检查** `next-step`。

所以：

- 只要钩子里肯等，桥就能趁这段时间把新消息 steer 进 `next-step` → 回合不关，直接跑下一步。
- 对照 `mode:'queue'`：投的是 `next-turn`，**必然多出一整轮**（含整包 prompt 重发）。

分工：**插件只当时序闸门**（`dsh-qq-hold` 提供 `POST /api/qq/turn-hold`，由 `core/console-server.js` 接），**桥负责 steer**（`steerIntoRunningTurn`）。

### 4.2 分段持有

单个 HTTP 请求挂不了太久（undici/fetch 的 `headersTimeout` 默认 300 秒），长持有会被 HTTP 层截断。所以：

- 桥每次只持有 `requestBudgetMs`（默认 55 秒，硬上限 120 秒，`turn-hold.js:137`）
- 这一段没等来消息就返回 `{ close: false, again: true }`，**插件收到后立刻再发一次请求**

对 DSH 而言钩子一直在等待，回合一直不关；对 HTTP 而言每个请求都很短，不碰任何超时。

### 4.3 保持循环的几个旋钮与不变量（`turn-hold.js` 的 `holdLoop`）

| 参数 | 默认 | 位置 |
| --- | --- | --- |
| `maxExchanges` | 24 | `turn-hold.js:133` |
| `idleCloseMs` | 30 分钟 | `turn-hold.js:134` |
| `maxWaitMs` | 60 分钟（不短于 `idleCloseMs`） | `turn-hold.js:135` |
| `requestBudgetMs` | 55 秒，夹在 `[3000, 120000]` | `turn-hold.js:137` |
| 轮询 `POLL_MS` | 200 ms | `turn-hold.js:44` |
| 看门狗续期 `RENEW_MS` | 5000 ms | `turn-hold.js:47` |
| 打字挡住时的退避 | `min(1500, 200·2^(n-1))` | `turn-hold.js:226` |

团队守住的不变量：

1. **默认关闭**：`cfg.social.turnHold.enabled !== true` → 立刻放行，行为与加这个功能之前完全一致
2. **灰度**：`keys` 非空时只对白名单生效；`privateOnly`（默认 true）只做私聊
3. **绝不在这里标读**：steer 不碰 `unread`，只有模型真发出回复后回合结束的 mux 钩子才清。DSH 的 `cancel()` 会 `inbox.clear()`，塞进去没被领会的会在中断时消失——靠 `unread` 兜底
4. **同一会话单飞**：`activeHolds` 保证一处持有，防双重 steer → 重复注入
5. **轮换阈值到了就不再保持**：`holdLoop` 每轮调 `rotationDue()`，到点 `finish('rotate-threshold')` 主动放行关回合（`turn-hold.js:181-186`）。
   - 这条是 2026-09-19 的修复：`noteExchange()` 每记一次来回就给 `rotateTurns` +1，但轮换判定过去只存在于"**会话不忙**"那条路上——而保持循环恰恰让会话一直是忙的，于是计数涨过阈值却没人在看（线上实测 `rotateTurns=20` / 阈值 15，一条 `[rotate]` 日志都没有）
6. **每个提前返回都留日志**——这个功能吃过四次"静默失败"的亏

### 4.4 "一个模型步 = 一个 `[Mid-turn]` 块"（合并注入）

机理（`wake-send.js:631-658` 有一段完整推导）：

- 每次 steer 都是 inbox 里**独立的一条** `next-step` 消息（`dsh-agent-loop/lib/index.js:399-401`）
- `inbox.claim()` 在**下一个 step 的开端**把 `next-step` **一次全取走**（`dsh-agent/lib/index.js:56-61`）
- ⇒ 同一个 step 里注入 N 次，模型在同一次思考里看到 **N 个独立的 `[Mid-turn]` 块**，只能一块一块顺序处理
- 关键推论：**同一个 step 边界本来就只能带走一批**。所以"把这一步里到达的消息攒起来、在步边界一次性注入"的**送达时刻与"消息一到就立刻注入"完全相同**，但模型只看到一个块、只发一条气泡——白拿的合并

实现上有两道闸门 + 两个发车点：

| 机制 | 常量 / 函数 | 说明 |
| --- | --- | --- |
| 收集窗 | `STEER_COLLECT_MS = 1000`、`STEER_COLLECT_MAX_MS = 3000` | 真要注入时先等"这口气说完" |
| 周期闸 | `STEER_CYCLE_MS = 5000`（保持托管）、`STEER_CYCLE_SHORT_MS = 1500`（非保持） | 同一个模型步周期内只注入一次 |
| 特例：模型还在生成、本回合一条气泡都没发出去 | `midTurnSteerGate({ noReplyYet })` | **不攒批**，直接即时注入。攒批在这里没有合并价值，却把送达时刻押在"步边界一定会来"上（线上撞过一次 28 秒没来步边界、靠 20 秒兜底才投出去） |
| 防饥饿兜底 | `STEER_PENDING_MAX_MS = 20000` | 攒这么久还没等到任何步边界 → 兜底即时注入，绝不静默卡住 |
| 发车点 1 | `turn-hold.js` 的 `holdLoop`（在 `agent/turn-stopping` 钩子里） | |
| 发车点 2 | `turn-hold.js` 的 `flushStepBatch()`（`mux.js:896-899` 收到 `step/end` 调） | 保持循环只在 `turnEnds && nextStep.length === 0` 时才被 await，**模型连调几个工具的那种步走不到钩子**；`step/end` 每一步都有 |

### 4.5 `steerIntoRunningTurn` 的判据与"三种语义"教训（`wake-send.js:795`）

允许 steer 的三种情形：

1. `forced`：turn-hold 的保持循环（调用点就在 `turn-stopping` 钩子里，确定有回合在跑）
2. `social.steerEnabled === true`：全局开关（**默认开**，只有显式写 `false` 才关）
3. **turn-hold 灰度内的会话 + 有"回合真的在跑"的证据**

核心硬守卫是第 3 条的证据来源：

```
runningTurn = agentRunningSessions.has(sessionId)   // DSH 权威状态
           || TurnStartAt.has(sessionId)            // 桥观测：turn/start 置位、turn/end 清除
           || collectors.has(sessionId)             // 桥观测
```

- `host/session-status` 那个权威帧**没有进桥的事件流**（计数 0，那批 `host/*` 帧走的是 Web UI 的 host 流），所以只能回退到桥自己观测的回合边界（`wake-send.js:830-835`）
- 没有 `runningTurn` 就**只记账、不投**，留一行"只能留到下一轮（原因：…）"的日志，消息**留在 unread 里**

**一个 boolean 承担不了三种语义**——这是本项目反复踩到的坑：

| 返回值 | 真实含义 |
| --- | --- |
| `true` | 真塞进去了 · 本回合**已经给过它**（唤醒正文展示过 / 刚 steer 过）· **被周期闸攒住了**（其实什么都没投） |
| `'typing-defer'` | 对方还在打字，这批继续攒（明确信号，不能返回 `false`） |
| `false` | 真失败 / 回合没在跑 |

- "已经给过"必须返回 `true`：曾经返回 `false`，调用方读成"没送成"→ 落回完整唤醒流程 → 又投一条完整唤醒进同一个回合 → 模型看到同一批未读两遍 → **QQ 上真的重复回了一次**
- "被周期闸攒住"这个 `true` **什么都没投**，如果照旧返回 `close: false`，DSH 会看到 `next-step` 为空而直接把回合关掉，表现成"保持悄悄结束了"。所以 `holdLoop` 与 `flushStepBatch` 记这一笔之前**必须验证真的落地了**——判据是 `collectMidTurnBatch(st)` 返回空（这批 seq 已不在待交付批里）。没落地就继续持有 + 重试，**绝不谎报成功**

### 4.6 打字状态等待（不抢话）

`core/typing-hold.js` 的 `midTurnSteerGate` / `midTurnSteerText`，配置在 `social.typing`：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | true | 总开关 |
| `holdMaxMs` | 12000 | 最多等这么久（到点就插话，避免遇到"打字没完"的人一直不回复） |
| `refreshOnMessageMs` | 5000 | QQ 输入事件不可靠，收到一条消息就把"对方在打字"再续这么多毫秒 |
| `breakProbability` | 0.15 | 每次唤醒的插话概率（0 = 只等他停，1 = 从不等待） |

三条路径（`wake-send.js:943-947` 有明确取舍）：

1. 模型还在生成、本回合一条都没发出去 → **注入当前轮，不等**
2. 本回合已经发过气泡 + 对方确实在连发 → **短暂延迟后注入**（≤ `STEER_IN_TURN_DEFER_MAX_MS`），并排一次 `scheduleInTurnRedeliver`（最多 3 次，`wake-send.js:727`），打字窗一结束就投
3. 没有正在跑的回合 / 注入通道失败 → **只能留到下一轮**（由 `runningTurn` 守卫与补投失败分支各打一行日志）

> 一个已修复的接线错误值得记住：`midTurnSteerGate` 读的是 `cfg.social.typing`，而调用点曾经传的是 `cfgRef?.social?.typing` —— 于是 `typingCfg` 拿到 `undefined`，一路回落到 `TYPING_DEFAULTS`，**管理端配的 `social.typing.*` 在在途注入这条路线上从来没生效过**（`wake-send.js:955-958`）。

### 4.7 看门狗、卡死与恢复（`core/turn-guard.js`）

| 机制 | 常量 | 说明 |
| --- | --- | --- |
| 静默判卡死 | `TURN_TIMEOUT_MS = 180000` | **完全静默** 180 秒（无任何 turn/tool/流式事件）才判定卡死 |
| 回合总时长 | `TURN_TOTAL_TIMEOUT_MS = 360000` | 6 分钟仍未结束（疑似模型无限重复输出）→ 强制隔离 |
| 长等待 | `LONG_WAIT_TURN_TIMEOUT_MS = 11 分钟` | `touchTurnGuardsByKey()` 用于 `qq_wait_for_messages` / 回合保持这类"合法的长时间无事件" |
| 隔离 | `quarantineSession(key, sessionId)` | 投递超时/卡死时用 |
| 启动时的唤醒租约 | `armPendingWakeLease` / `disarmPendingWakeLease` | |

回合保持会**每 5 秒续期看门狗**（`turn-hold.js:47` `RENEW_MS`），否则吊住回合期间没有任何事件，计时器会一直往前走而被误判卡死。

另外两条恢复路径在 `wake-send.js` / `social-state.js`：

- `loopRecovery`：有未读却长时间无动作时拉回
- `timeoutRecovery`：回合卡死时收尾

### 4.8 回合级共享状态（`core/session-state.js`）

会话/回合/队列的共享状态集中在一个模块，全部用 `Map` / `Set` 按内容增删、经 export 活绑定共享（无整体重赋值），因此各子系统拿到的是同一份视图：

| 状态 | 含义 |
| --- | --- |
| `collectors` / `TurnStartAt` | 会话 → 回合采集器 / 回合开始时间（回合边界观测） |
| `promptQueues` | 每会话串行投递 DSH prompt，保证 turn 顺序 |
| `pendingWakeKeys` / `pendingWakeLeaseTimers` | 唤醒待办与"已接受但未收到 turn/end"的租约兜底 |
| `sendToolSucceededSessions` / `pendingSendToolCalls` | 本回合发送类工具是否成功过；等待 `tool/result` 的调用 |
| `turnTimeoutTimers` / `turnTotalTimers` | 活动感知看门狗与回合总时长兜底 |
| `loopRepeatState` / `loopRecoverTimes` / `activeAiTurns` / `pendingTurnOutbound` | 复读判定与自动重启台账 |
| `activeWaits` / `lastWakeRebroadcast` / `wakeConfigUpdatedKeys` / `markReadCalledKeys` | 长轮询互斥、补发冷却、唤醒配置与已读台账 |

---

## 5. 工具面

### 5.1 三组 MCP server

由 `lib/dsh-side.js` 的 `mcpBlock()`（`dsh-side.js:249`）写进隔离 DSH profile 的 `cordis.patch.yml`：

| MCP server id | serverName | 脚本 | 内容 |
| --- | --- | --- | --- |
| `mcp-napcat` | `napcat` | `qq-bridge/src/mcp-napcat-safe.js` | QQ 与 NapCat 能力（主体） |
| `mcp-napcat-host` | `napcat-host` | `qq-bridge/src/mcp-host-server.js` | `qq_learning_corpus`、`qq_learning_submit`、`napcat_status`，进程控制在显式开启前不注册 |
| `mcp-web-search-safe` | `web-search-safe` | `qq-bridge/src/mcp-web-search-safe.js` | `web_search`、`web_fetch` |

静态统计（按源码数）：

| 文件 | `registerTool(` / `server.tool(` 出现次数 | 工具名 |
| --- | --- | --- |
| `mcp-napcat-safe.js` | 91 + 1（`registerTool` 91 次、`server.tool` 1 次；其中若干受 `cfg.social.tools.*` 开关包裹，运行时可能不注册） | `qq_send_message`、`qq_reply`、`qq_get_unread_messages`、`qq_mark_read`、`qq_wait_for_messages`、`qq_memory_*`、`qq_slang_*`、`qq_character_*`、`qq_qzone_*`、`qq_pixiv_search`、`qq_send_voice`、`qq_transcribe_voice`、`qq_video_parse`、`qq_meme_search`、`qq_schedule_*`、`qq_crosschat_*` 等 |
| `mcp-host-server.js` | 5 | `qq_learning_corpus`、`qq_learning_submit`、`napcat_status`、`start_napcat`、`stop_napcat`（后两个只在 `napcat.allowProcessControl === true` 时才注册） |
| `mcp-web-search-safe.js` | 2 | `web_search`、`web_fetch` |

`mcp-napcat-safe.js` 的注册函数把每个工具的 JSON 尺寸记进账本，注册完写 `state/tool-schema-stats.json` 并打到 stderr。实测快照（2026-09-24 砍掉 `qq_send_burst` 后）：`totalChars = 92879`、`available = 91`、`approxTokensPerStep = 30646`。

> README 已不再逐条列工具数量；工具数与体积一律以源码注册计数与 `state/tool-schema-stats.json` 为准（2026-09-24 实测 91 个）。

`mcp-host-server.js` 与 MCP 客户端的约定写在文件头注释里：它由 DSH 的 MCP 客户端 spawn。`qq_learning_submit` **故意不放在 napcat 组**：学习会话只加载 `mcp__napcat-host__` 那一组，写成 `mcp__napcat__qq_learning_submit` 会直接 unknown tool。

### 5.2 MCP 压缩代理（开源 mcp-compressor）

配置在 `config.json` 的 `social.toolCompressor`，装配在 `lib/dsh-side.js:171-296`：

- 默认**恒开**（`tc.enabled !== false`），只有显式 `enabled: false` 才回到直连
- 它是个**代理进程**：DSH 不再直连 `mcp-napcat`，而是连它；它把工具压成两个包装工具（`<server>_invoke_tool` / `<server>_get_tool_schema`），工具清单塞进包装工具的描述里
- 档位语义：`low`（去冗余）/ `medium`（每条描述只留第一句）/ `high`（完全不发描述）/ `max`（连工具清单都不发，改用包装工具）
- **只挂在 `mcp-napcat` 这一路**（工具最多、体积最大），另两组保持直连
- 必须有 fallback：压缩机没装 / 起不来时**绝不能把工具表搞没**（那等于机器人失能），所以先做一次廉价探测，探不到就直连并把原因写进日志（`dsh-side.js:179-181`、`221-247`）

桥侧的配套：`core/mux.js` 的 `unwrapCompressedToolName(name, rawArgs)`（`mux.js:127`）把包装工具还原成**后端真实工具名**。代理模式下，`invoke_tool` 的真实目标藏在 `args.tool_name` 里，而桥下面一整段逻辑（发送类判定、漏引号兜底、幂等账本、抽签登记、回合收尾，49 处）全是按真实工具名判断的——不解包就等于全部失灵（`mux.js:802-811`）。

实测（`dsh-side.js:174-176`，挂真实的 90 个工具跑）：`low 38.8% · medium 14.0% · high 6.2% · max 3.6%`（相对完整工具表）。**代理在实际窗口里没有带来额外往返**——同一段窗口里 `napcat_get_tool_schema` 的调用次数为 0。

细节与成本 → [COMPACTION-MATH.md](COMPACTION-MATH.md#72-mcp-压缩代理开源-mcp-compressor)。

### 5.3 工具裁剪档位与描述压缩档

- **裁剪档位**：`lib/tool-tiers.js` 的 `TOOL_TIERS`，配置键 `social.slimTools`。语义是**白名单**——不在名单里的工具**根本不注册**（描述才不会进请求体）。
  - 档位：`off`（默认）/ `low`（drop 名单，其余保留）/ `medium` / `high` / `extreme` / `custom`
  - `ESSENTIAL`（协议必需，任何档位都留）：`qq_send_message`、`qq_reply`、`qq_mark_read`、`qq_set_wake_config`、`qq_get_prompt`、`qq_social_state`、`qq_get_unread_messages`、`qq_wait_for_messages`、`qq_list_groups`、`qq_status`、`get_time`（2026-09-24 加入：提示词里"问时间就调 `get_time`"，`extreme` 档的白名单也显式列了它）
  - `OBSERVED_USED`：按**服务器真实调用日志**（`state/tool-calls.jsonl`，1108 次调用）挑出的"实测被调用过"的工具，切档绝不能砍掉
  - `PROMPT_NAMED`（2026-09-24 新增）：提示词**点名要求模型调用**的两条 —— `qq_memory_remember`（`[Recall]` 段写着"要改就用它"）、`qq_get_file_content`（媒体标签行写着 `[文件:…]` 要用它读）。判据比"实测调用过"更硬：缺了它，提示词就在指挥一件做不到的事
  - `qq_status` 永远保留（198 字符）
  - 选了具体档位时 **`allow` / `deny` 两张手写表一律忽略**：线上的 `deny` 老名单与档位白名单会自相矛盾，失手砍掉的正是模型在用的工具，且极难发现（`tool-tiers.js:144-148`）
  - 2026-09-24 砍掉 `qq_send_burst` 后复测（91 个 napcat 工具、97,908 字符为基准）：`low` 68 个 / 81.2%、`medium` 42 个 / 39.7%、`high` 33 个 / 33.0%、`extreme` 9 个 / 7.1%。复算：`src/tool-schema-chars.ts` 与 `tools/mcp-tool-chars.mjs`
- **描述压缩档**：`lib/tool-schema-compress.js` 的 `SCHEMA_LEVELS = ['off','medium','high']`，配置键 `social.slimTools.schemaLevel`。它照搬 mcp-compressor 的档位语义，但**压的是描述文字**，工具一个不少、参数名/类型/枚举/必填全都照旧。
  - 特意**不提供** mcp-compressor 的 `low`：实测压完反而比不压还大 2.6%（重建 union 容器会把描述搬进每个分支）
  - 实测（90 个工具，真实 wire 格式）：`off 89,603 字符` / `medium 61,587 字符 ≈ 68.7%` / `high 27,109 字符 ≈ 30.2%`
  - 重建容器后**必须把容器自己那条描述补回去**（`withOwnDesc`）：否则 `z.union([...]).optional().describe('Group id')` 这类参数描述会凭空消失（`tool-schema-compress.js:72-81`）
  - `social.slimTools` 在**注册期**排除工具，能真正减少请求体积；`social.tools.*` 只在**调用期**拒绝，不减少体积

### 5.4 工具名归一化

`bareToolName()`（`mcp-napcat-safe.js` 的 `registerTool` 附近、`tool-tiers.js:130`）去掉 `mcp__server__` 前缀。名单里写 `mcp__napcat__qq_x` 与写 `qq_x` 等价——少了这一步，精简名单会整体不命中。

---

## 6. 记忆层

**两个 SQLite 库**（2026-09-24 分家）：

| 库 | 模块 | 装什么 |
| --- | --- | --- |
| `qq-bridge/state/memory.db` | `core/memory.js`（`memDb` 为模块级单例） | 记忆档案：`profiles` / `memory_entries` |
| `qq-bridge/state/chat.db` | `core/chat-db.js` | 聊天记录：`chat_messages` + FTS + 会话汇总 + 总量计数 |

为什么要拆：`chat_messages` 是全库最大的表，生命周期与档案完全不同——只增不改、可按会话整段删、每条消息都写一行；而 `profiles` / `memory_entries` 少量、长期、每轮都要注入上下文。挤在一个文件里，"删聊天历史"就等于"动记忆库"（锁竞争、写放大、备份粒度全都跟着变粗）。拆开后**调用方零改动**：`memory.js` 把聊天函数原样 re-export，历史 import 路径（`mux` / `social-flow` / `wake-send` / `crosschat` / `message-cache` / `console-server`）全部照旧；`ftsUsable` / `ftsQueryOf` 抽到 `lib/fts.js` 给两个库共用（两份实现必然漂移，症状只是"搜不到"且不报错）。

首次启动新版桥会自动迁移：老 `memory.db` 里的 `chat_messages` 一次性搬到 `chat.db`（`ATTACH` + `INSERT … SELECT`，**核对条数一致后**才 `DROP` 老表并 `VACUUM`；两边都非空则跳过并记日志、条数对不上就保留老表下次再试），水位记在 `chat_meta.migrated_from_memory_db`，不会重复搬。

### 6.1 表

**`state/memory.db`（记忆档案）**

| 表 | 内容 |
| --- | --- |
| `profiles` | 每个 QQ 一份结构化档案：`uid / name / personality / likes / dislikes / birthday / notes / updated_at` |
| `memory_entries` | 通用记忆条目：`uid / category / content / created_at`，v1.3.0 起补列 `pinned / importance / last_used_at / hits / expires_at / conv_key / tags / source / tier / updated_at` |
| `memory_meta` | 一行 KV，存索引结构版本（`fts_version` / `fts_rebuilt_at`） |
| `mem_fts` | `memory_entries` 的 FTS5 外部内容表（见下） |

**`state/chat.db`（聊天记录）**

| 表 | 内容 |
| --- | --- |
| `chat_messages` | 完整聊天记录（桥自动写入、不经过大模型）：`conv_key / msg_seq / message_id / sender_uid / sender_name / is_self / direction / kind / content / quote_target / media / ts / ts_ms`，后续补列 `qq_seq / read_at / recalled_at` |
| `chat_fts` | `chat_messages` 的 FTS5 trigram 外部内容表 + 三个同步触发器（`chat_messages_fts_ai/ad/au`） |
| `chat_convs` | 每个会话一行汇总：`conv_key / kind / name / count / sent / received / last_ts / last_text`（管理端会话列表直接读它） |
| `chat_stats` | 单行（`id = 1`）总量计数：`total / private_total / group_total / sent_total / received_total / conv_total / conv_group / conv_private / first_ts / last_ts / day / day_total / day_sent`——"一查便知总量与今日量" |
| `chat_meta` | 一行 KV：迁移水位、`chat_fts` 索引版本与重建时间 |

索引：`idx_mem_uid`、`idx_mem_tier`、`idx_mem_conv`、`idx_mem_expire`（`memory.db`）；`idx_chat_conv_ts`、`idx_chat_ts`、`idx_chat_sender`、`idx_chat_conv_content`、`idx_chat_dir_ts`、`idx_chat_msgid`（**部分唯一索引**，`WHERE message_id != ''`，防 WS 重投/双路径并发双写）（`chat.db`）。

> 建部分唯一索引前必须**先清掉存量重复行**（每组保留 `id` 最小一行），否则建索引会失败。

### 6.2 三层记忆（v1.3.0）

| tier | 默认存活 | 归属判据 |
| --- | --- | --- |
| `permanent` | 0（永不过期） | `pinned = 1` 或 `category ∈ {rule, owner, identity}` |
| `durable` | 90 天不活跃淡出 | 默认层（`expires_at` 可显式指定） |
| `working` | 7 天淡出 | 显式 `working=true` 或 `importance` 很低的临时条目 |

常量：`MEMORY_TIERS = { permanent: 0, durable: 90d, working: 7d }`、`PERMANENT_CATEGORIES = Set(['rule','owner','identity'])`（`memory.js:117-119`）。

### 6.3 检索：FTS5 trigram

```
CREATE VIRTUAL TABLE IF NOT EXISTS <name> USING fts5(
  content, tokenize='trigram', content='<源表>', content_rowid='id'
)
```

（`memory.js:172`）

- **trigram** 对中文是"三字滑窗"，中文子串照样命中，**不需要分词器**
- BM25 天然给出相关性排序
- `content='表名'` 是外部内容表，靠触发器同步；索引与触发器全部在 SQLite 内部完成（C 实现），桥侧只多一次 INSERT 的开销
- 结构一变就把 `FTS_SCHEMA_VERSION` +1 → 下次启动自动重建（幂等），当前版本 `'2'`（`memory.js:120`）

改动动机（`memory.js:4-23` 的三条结论）：原来只有 `content LIKE '%词%'` 全表扫 —— 检索慢且不准（查不着时模型会说"我看不到更早的消息"，是最贵的一种失败）、没有轻重、没有"永久"这个概念。

**成本纪律**：注入给模型的是**几百字符的摘要**（`[Recall]` 行，`limit: 14, maxChars: 700`，`wake-send.js:446`），不是把历史塞回上下文。省钱靠"按需检索"，不是"全都记住"。摘要放在唤醒正文这个"每轮本来就新"的位置，而不是系统提示词里——系统提示词一变就会让**整段前缀缓存失效**（那一步全价重读几万 token）。

### 6.4 会话归档（`core/session-archive.js`）

桥每约 12 轮用户触发对话轮换一次 DSH 会话，卡死/隔离/复读恢复也会重建会话，于是「QQ 聊天」工作区里的 `session-*` 目录会持续堆积（DSH Web 侧也会列出一长串旧会话）。`core/session-archive.js` 定时巡检该工作区，把**已闲置**的旧会话调 DSH 的 `workspace/archiveSession` 归档。

安全边界（硬性、不可配）：

- 绝不归档 `state.sessions` 里任何当前映射中的会话；
- 绝不归档预热待用的 standby 会话（`st._standbySessionId`）；
- 绝不归档当前有回合在跑（`TurnStartAt` / `collectors`）或正在执行发送工具链的会话；
- 只处理「QQ 聊天」工作区目录（`cfg.sessionCwd`，缺省 `state/agents`）下的 `session-*` 目录；
- 闲置时间不达标（默认 30 分钟）不动。

默认参数：`intervalMs = 10 分钟`、`idleMinutes = 30`、`batchMax = 20`、`pruneDays = 0`（只归档不删数据；`>0` 才连同磁盘目录一起清理）。归档水位记在 `state/session-archive.json`。

---

## 7. 状态文件

桥的数据都在 `qq-bridge/state/`（路径常量集中在 `src/lib/paths.js`）。关键文件：

| 文件 | 谁写 | 内容 |
| --- | --- | --- |
| `sessions.json` | `core/config.js`（`saveState`） | QQ 会话键 ↔ DSH sessionId 映射。启动时会**剔掉指向磁盘上已不存在会话的映射**（`bridge.js:486-503` 的 `liveSessionIdsOnDisk()` + 空集守卫），否则事件泵每秒重开一次死会话的 `session/follow` |
| `bridge.lock` | `core/runtime.js`（`acquireLock` / `releaseLock`） | 单实例锁：以 `wx` 原子写入 PID；启动时若该 PID 仍存活则 `exit 2`，否则接管 |
| `social-state.json` | `core/social-state.js`（`saveSocialState`） | 每个会话的社交状态：未读、最近消息、唤醒配置、账本（`answeredMessageIds` / `lastDeliveredSeq` / `_wakeIntendedSeq` / `lastUnreadSeq`）、`rotateTurns`、回合保持计数 |
| `current-role.json` | `lib/role-access.js` | 当前角色与模式（`role` / `mode`） |
| `slang.json`、`slang-session.json` | `core/slang.js` | 黑话词条与学习会话 |
| `stickers.json` | `core/sticker.js` | 收藏表情库、备注与使用计数 |
| `memory.db` | `core/memory.js` | 记忆档案库（`profiles` / `memory_entries` / `mem_fts`） |
| `chat.db` | `core/chat-db.js` | 聊天记录库（`chat_messages` / `chat_fts` / `chat_convs` / `chat_stats`）；老安装首次启动新版桥时从 `memory.db` 自动迁移过来 |
| `token-usage.jsonl` | `core/token-meter.js` | 每次请求的用量行（计价与统计分析的数据源），含 `est` 标记与 `reconciled` 补记行 |
| `token-reconcile.json` | `core/token-meter.js` | 与 DSH 权威计数的对账水位（防重复补记） |
| `tool-calls.jsonl` | `core/audit.js`（`appendToolLog`） | 工具调用/结果流水，`tool-tiers.js` 的档位名单就是从它统计出来的 |
| `tool-schema-stats.json` | `mcp-napcat-safe.js` | 工具 schema 体积实测快照 |
| `feedback.json` | `core/audit.js` | `qq_report_feedback` 的反馈条目 |
| `qq-activity.log` | `lib/log.js`（`appendActivity`） | 会话活动流水 |
| `bridge.log` | `lib/log.js`（`log`） | 桥主日志 |
| `crosschat.json` | `core/crosschat.js` | 跨会话留言信箱 |
| `scheduled-tasks.json` | `core/scheduler.js` | 定时消息任务 |
| `activity-windows.json` | `core/activity.js` | 活跃时段 |
| `docx-quota.json` | `core/docx.js` | Word 文档每日额度 |
| `session-archive.json` | `core/session-archive.js` | 会话归档水位 |
| `napcat-guard.json`、`napcat-qr.png`、`napcat-container-spec/` | `core/napcat-guard.js` | NapCat 守护状态、二维码图片、容器规格（§14.4） |
| `learning-config.json`、`learning-token` | 学习子系统 | 学习计划与学习会话令牌（`core/learning-token.js` 的 `ensureLearningToken()` 在启动时就建，避免"模型拿着令牌来提交"和"桥还没建过令牌"的时序打架）。令牌是 32 位 hex 且**不可猜**（会话令牌=群号，可预测；学习令牌只解锁 `/api/learning/submit-persona` 一个端点，不并入 `KNOWN_AGENT_TOKENS`，避免扩权） |
| `dsh-seq.json` | `lib/dsh-side` / `dsh-client`（`bridge.js` 构造 `NodeApiClient` 时传入） | 每会话已处理的最高事件 `seq`。**不可省**：桥一重启就丢水位，`follow` 快照会把整段历史重放一遍，而重放帧与实时帧同形、`pumpMux` 分不出来（实测重复率 63.7%） |
| `sticker-tmp/`、`doc-tmp/`、`qzone-img-tmp/`、`image-tmp/` | 各媒体模块 | 临时媒体目录，启动时各自扫一次旧文件 |
| `voice-config.json`、`voice-voices.json`、`voice-cache/` | `core/voice.js` | 语音配置、自定义音色、合成缓存 |

隔离 DSH 侧（不是桥的）：`<DSH_HOME>/sessions/`（会话日志）、`<DSH_HOME>/storages/session_projcache/sessions`（用量对账读它）、`<DSH_HOME>/cordis.patch.yml`、`<DSH_HOME>/profiles/<profile>/cordis.patch.yml`、`<DSH_HOME>/.credentials.yaml`、`<DSH_HOME>/settings.yaml`、`<DSH_HOME>/qqbridge-setup.done`（首次注入 preset 的引导标记）。

管理端侧：`%USERPROFILE%\.qq-bridge-manager\config.json`（配置）、`logs\manager.log`、`logs\napcat-guardian.log`、实例日志、`profiles.json`（配置方案库）、`napcat-guardian.json`（守卫记录）、隔离 home 目录。

写盘纪律：状态 JSON 一律走 `lib/json-fs.js` 的 `atomicWriteJson`（临时文件 + rename），避免读到半截 JSON；`saveState` 同样用 tmp + rename（`core/config.js:442-453`）。

---

## 8. 隔离 DSH 的装配

### 8.1 端自安装

`bridge.js` 启动时异步（幂等、非阻塞）做三件事：

1. `installPresets(target)` —— **每次启动都刷新**。preset 是桥自带的代码资产（persona / `[WAKE TYPES]` / `[RULES]`），不是主人数据；旧逻辑"装过一次就靠 marker 全跳过"，导致改了 `agent.cordis.yml` 后重启桥根本不会把新 preset 装进去
2. `watchOverrideFiles()` —— 盯 `persona.md` / `speech-rules.md`，一改就重新合成进已安装的 preset
3. `ensureBuiltinPlugins(target)` —— **每次启动都幂等装配一遍**（link + profile 注册 + settings 的 memory 段）。不能只在被 marker 挡住的 `installToIsolatedDsh()` 里做，否则老安装永远升不上来

DSH home 的解析顺序（`core/tunables.js` 的 `resolveIsolatedDshHome`）：环境变量 `QQB_DSH_HOME` → `DSH_ISOLATED_HOME` → 管理器配置里的隔离 home（`~/.qq-bridge-manager/dsh-isolated-home-official`，其次 `dsh-isolated-home`）。

`lib/dsh-side.js` 另有一条更细的解析链（`resolveDshTarget()`）：环境变量 `QQB_DSH_HOME` → 项目内 `.runtime/dsh-isolated-home` → 管理器配置 `instances.dshIsolated.isolatedHome` → 项目默认；并在 **Windows** 上拒绝把桌面端 `%APPDATA%\DeepSeek Harness\dsh-home` 当作目标（`isDesktopDshHome()`）。

> 历史坑：这里原来**写死** `~/.qq-bridge-manager/dsh-isolated-home`，而管理器实际启用的是 `…-official`，于是"管理端改的模型配置到不了 DSH 里"。
>
> 待确认：桥的项目内默认（`<repo>/../.runtime/dsh-isolated-home`）与管理端配置的 `…-official` 是两份候选，实际生效取决于 `QQB_DSH_HOME` 与管理器配置（同注：`lib/dsh-side.js` 顶部注释里的 `13210` 已于 2026-09-25 改为 `10721`，见 §2.1）。

### 8.2 两份 cordis.patch.yml

| 文件 | 内容 | 谁维护 |
| --- | --- | --- |
| `<home>/profiles/<profile>/cordis.patch.yml` | agent-presets overlay + 三组 MCP server（含压缩代理参数） | `lib/dsh-side.js` 的 `patchProfileCordis()`（`dsh-side.js:299`） |
| `<home>/cordis.patch.yml`（home 级） | 上下文压缩 / 工具结果剪枝策略 | `lib/dsh-compaction.js` 的 `syncDshCompactionPatch()`（`dsh-compaction.js:198`） |

配置层顺序是 bundles → profile 的 `cordis.patch.yml` → **home 级 `cordis.patch.yml`** → `--patch`；写 home 级不会碰到装着 MCP 挂载的 profile 那份。profile 的 `patchReload: live` 会同时监视 home 级 patch 文件 → **改完不必重启 DSH**。

home 级那份用 `# === qq-bridge compaction BEGIN/END ===` 标记包起来，只替换标记之间那段，用户自己的 overlay 原样保留。profile 那份用 `# === qq-bridge MCP BEGIN/END ===`，三组 MCP server 的 `env`/`command`/`args` 全在里面，`toolCallTimeoutMs: 725000` 只加在 `mcp-napcat` 上。

### 8.3 桥不能自己改 DSH 的历史（四条依据）

写进 `lib/dsh-compaction.js:4-9`，读过 DSH 0.1.2-rc.1 源码得出：

1. `dsh-session`：模型历史由内存日志 `deriveMessages()` 派生，文件只在冷恢复时读 —— 改文件对运行中的会话零影响
2. `dsh-session-persistence-jsonl`：日志是 seq 连续的仅追加记录，删行会撞 `corrupt session log: seq gap`；默认 zstd 帧带校验和，正文一改就校验失败
3. 它自己也写明"每个会话一个活动写入方"，外部同时写会互相踩
4. 受支持的裁剪路径只有一条：**由 DSH 自己**通过 surface `replace` 改写历史 —— 也就是 `dsh-compaction-tool-result-pruner`（剪枝）与 `dsh-compaction-basic`（摘要）

两个必须守住的硬约束（否则插件拒绝加载、DSH 起不来）：

- `compaction-basic`：`retainRatio` 必须**小于** `thresholdRatio` 解析出的阈值
- `tool-result-pruner`：`headChars + 标记 + tailChars ≤ thresholdChars`（标记是 `"\n\n[... tool result middle pruned ...]\n\n"`，与 DSH 里的 `PRUNE_MARKER` 逐字一致）

`normalizeCompaction()` 保证这两条永远成立，被夹紧时写日志说明。

**第三个坑（真机复现）**：web profile 下这两行默认是 `disabled: true`（归 host plane 所有），所以即使配置写得再对，自动压缩也一次都不跑 —— 本机隔离 home 的 86 个会话日志里 `compaction/*` 事件 0 条。`buildCompactionRows()` 因此必须显式写 `disabled: false`（`dsh-compaction.js:112-123`）。

### 8.4 三个内置插件

| 插件 | 作用 |
| --- | --- |
| `dsh-qq-hold` | 提供 `agent/turn-stopping` 钩子的时序闸门，暴露 `POST /api/qq/turn-hold`（`core/console-server.js` 接它） |
| `qq-mode-console` | 模式控制台 |
| `dsh-memory` | 长期记忆插件的 `remember` / `recall` 工具。随包 vendored |

`plugins/*` 通过**符号链接**接进 DSH：`<home>/plugins/<name>` 与 `<home>/profiles/node_modules/<name>` 都指向 `qq-bridge/plugins/<name>`（`server/deploy.js` 的克隆脚本同样处理这两处链接；服务端另有 `buildTargetDshHealScript()` 修被拷坏/断掉的链接）。

---

## 9. 部署路径

### 9.1 本地（Windows）

- 运行时根目录 = `server/index.js` 的**上两级目录**（`RUNTIME_ROOT`），与 `cwd` 无关。原来有 9 处用 `process.cwd()`，用户从资源管理器双击或走计划任务时 cwd 会变成 `C:\Windows\System32`，于是 dsh / qq-bridge / dist / 隔离 home 全部解析错
- 管理端数据：`%USERPROFILE%\.qq-bridge-manager\`
- 隔离 DSH home：`%USERPROFILE%\.qq-bridge-manager\dsh-isolated-home-official`
- 桥：`<运行时>\qq-bridge\`，`config.json` 与 `state/` 都在这一层
- 随包 NapCat：`<运行时>\napcat-onekey\`（`findNapcatOneKeyAll()` 还会扫描 `%LOCALAPPDATA%\Programs\*\resources\runtime\napcat-onekey`、`Downloads` / `Desktop` / `Documents` 下的 `NapCat.Shell.Windows.OneKey`）

### 9.2 线上（Linux）

| 路径 | 内容 |
| --- | --- |
| `/root/qq-bridge` | 桥整棵树（源码、`state/`、`config.json`、`plugins/`、`tools/`） |
| `/root/.dsh` | 隔离 DSH home：`sessions/`、`storages/`、`profiles/web/`、`cordis.patch.yml`、`.credentials.yaml`、`dsh-web.log` |
| `/opt/napcat` | NapCat 应用（原生跑法） |
| `/opt/napcat/config` 或 `/root/napcat/config` | NapCat 配置目录（原生 / 容器两种跑法） |
| `/root/dsh-meme` | 表情库（`dsh-meme.tar.gz` 的落点） |
| `/root/.qqbridge-clone` | 克隆部署的 stage 目录（打包产物 + `napcat-mode` 标记），收尾时删掉 |
| `/root/qqbridge-keep-<TS>` | 部署前对目标机原有 `config.json` / `persona.md` / `state/` 的能力保护备份（§15.4） |
| `/root/qqbridge-prev-<TS>` | 本地打包路径下的旧配置备份落点（`buildLocalStagePlan()`） |

systemd 单元：

| 单元 | 说明 |
| --- | --- |
| `dsh-web.service` | 隔离 DSH，`Environment=DSH_HOME=/root/.dsh`、`EnvironmentFile=-/etc/qq-bridge.env`、`ExecStart=<dshBin> --profile web --port 3080 --no-open --trusted-host 127.0.0.1:3080`，stdout/stderr 落 `/root/.dsh/dsh-web.log` |
| `napcat.service` | NapCat 原生跑法（源机没有该单元时，部署脚本现场生成） |
| `dsh-polyfill.service` | 可选；不存在时部署脚本不把它当失败 |

NapCat 有**两种跑法**，探针是唯一判据（`NAPCAT_MODE_CMD`）：

```bash
if systemctl cat napcat.service >/dev/null 2>&1; then echo native;
elif docker ps -a --filter name=^napcat$ --format "{{.Names}}" | grep -q napcat; then echo docker;
else echo none; fi
```

原生跑法 = 官方 Linux QQ deb + `/opt/napcat` + systemd unit + Xvfb + 非 root 用户 `qq`（`installNapcatNative()`）；容器跑法 = `mlikiowa/napcat-docker:latest`，卷 `napcat-qq:/app/.config/QQ`，端口 `3000/3001/6099`。启停统一走 `napcatCtlCmd()`（systemd 优先），与 `server/index.js` 的控制路径同形状。

**容器联动的一个必配项**：服务器上 NapCat 跑在容器里，看不到宿主路径。`config.json` 要写

```json
"napcat": {
  "imageFileMode": "auto",
  "tmpDir": "/root/napcat/config/moonbot-tmp",
  "dockerPathMap": [{ "host": "/root/napcat/config", "container": "/app/napcat/config" }]
}
```

（`lib/napcat-file.js`）。不配对时 NapCat 报 `文件处理失败: 识别URL失败, uri= /root/...`，表现是"表情包一张都发不出去"——本机裸机部署时同机能读，所以本地一直正常、一到服务器全灭。克隆脚本会把这几个键自动改对。

### 9.3 管理端的 SSH 克隆部署（`server/deploy.js`）

流程（每步写日志，GUI 轮询 `/api/ssh/deploy/status`，任务台账 `/api/ssh/deploy/tasks`）：

| 步骤 | 做什么 |
| --- | --- |
| 0 | 校验源/目标都在服务器列表，连两端 |
| 1 | 目标机基础环境探测与安装：nodejs / npm / docker / python3 + 全局 dsh + `mcp-compressor`（pip 装） |
| 2 | 源机**短暂停机**（停 dsh-web / napcat / bridge）→ 本地打包成 `tar.gz` |
| 3 | 源机**立即恢复运行**（总停机 ≈ 打包耗时，与传输带宽无关） |
| 4 | 逐包经 manager **流式转发**到目标机并原地解包（`streamPipe`，不落目标机中间文件） |
| 5 | 目标机：写 systemd 服务 / 建 napcat 容器与卷 / 灌 QQ 登录态 / 启动自检 |
| 6 | 清理源机 stage，断开连接 |

迁了哪些包：`qq-bridge.tar.gz`、`dsh-home.tar.gz`（`/root/.dsh`）、`napcat-config.tar.gz`、`napcat-app.tar.gz`（`/opt/napcat`）、`qqdata.tar.gz`（QQ 登录态）、`dsh-polyfill.tar.gz`、`dsh-meme.tar.gz`。详见 §15.2。

安全说明：全程只在 manager → 各机之间走 ssh2；目标机不持有源机凭据；密钥/令牌原样随 `.dsh` 与配置目录迁移（与整盘克隆语义一致）。

**能力保护**：解包前把目标机原有的 `config.json` / `persona.md` / `state/` 存到 `/root/qqbridge-keep-<TS>/`，解包后再恢复并核对（`buildDeployKeepScript()`，`QQB_DEPLOY_WHOLE_CLONE=1` 可整体克隆不走保护）。旧行为只把 `config.json` / `voice-config.json` 备份到 `/root/qqbridge-prev-<TS>/` 就删库重解包——**从来没有放回去**过。

### 9.4 管理端本身

| 部分 | 位置 |
| --- | --- |
| 前端 | `src/`（React + TS + Vite），构建产物 `dist/`，由后端静态托管（`distDir = join(RUNTIME_ROOT, 'dist')`，`index.html` 带 `no-store`，SPA 兜底正则 `/^\/(?!api\/).*/`） |
| 后端 | `server/index.js`，监听 `127.0.0.1:1921`（`QBM_API_PORT` 可覆盖），`QBM_NO_LISTEN=1` 时只导出 app 不监听 |
| 桥控制台 API | `qq-bridge/src/core/console-server.js`（端口 `consolePort`，默认 3100） |
| 开发模式 | `npm run dev` = `concurrently` 同时起 Vite 与后端；`dev:web` / `dev:api` 分开起 |
| 构建 | `npm run build` = `tsc -b && vite build`；`QBM_DIST_NO_MAP=1` 关闭 sourcemap |

管理端到桥是**代理**关系：`server/index.js` 把 `/api/bridge/*`、`/api/learning/*`、`/api/slang/*` 等转给桥控制台（`callBridgeConsole` / `proxyToBridgeConsole`），并带上桥控制台的鉴权头。桥控制台自己暴露约 150 个端点（§12.3）。

### 9.5 与仓库外打包工程的关系

安装包（`MoonBot Pro Setup.exe`）与 Electron 壳（`MoonBot.exe`）由**仓库外**的打包工程产出：`C:\Users\17367\Desktop\QQ-Bridge-packaging`。本仓库只提供运行时要装进去的内容（管理端 `dist/` + `server/`、`qq-bridge/`、`napcat-onekey/`、`dsh-runtime/`）。边界、打包内容与未验证项见 §17。

---

## 10. 两张"改之前先读"的地图

### 10.1 配置热加载

桥启动时 `const cfg = loadConfig()` 只读一次，而这个对象被 `initXxxCore(cfg)` 注入到十几个模块里。所以：

- **保存配置立即生效**靠 `watchConfigFile()` 的**原地合并**（`applyConfigInPlace`，`core/config.js:467`）：不换对象引用，旧引用继续有效
- `loadConfig` 会补齐全部默认键，因此 `target` 里多出来的键说明用户已从文件删除 → 同步删掉，避免用旧值
- **为什么不能只监听文件**：`fs.watch(file)` 在 Linux 上盯的是**那个 inode**，而管理端保存走的是"临时文件 → 备份 → mv 原子替换"，rename 一覆盖 inode 就换了，监视器从此盯在一个已被 unlink 的旧 inode 上——**之后任何改动都不再触发事件**，直到桥重启。线上实测：07:34 装好监视，07:39:54 管理端 mv 覆盖，此后桥日志里一条 `已热加载` 都没有。
- 现在的双保险：**目录监听**（`fs.watch(dir)`，按文件名过滤，mv 覆盖会给 rename 事件）+ **2 秒轮询兜底**（`fs.watchFile`，跨 inode / 跨文件系统都能发现），见 `watchConfigFile()`（`core/config.js:507`）
- 桥自己还有 **10 处**会把内存里的旧 cfg 写回 `config.json`（`console-server.js` 5 处 + `mux.js` 4 处 + `tunables.js` 1 处），没做热加载时管理端的改动不但不生效，还会被**回滚**掉
- 管理端侧写入也做了对齐：`POST /api/bridge/config` 走深合并（GUI 表单只带它编辑的片段，绝不整体覆盖丢字段）+ 临时文件 → 备份 → rename 原子替换

热加载回调里做三件事（`bridge.js` 的 `watchConfigFile` 回调）：`dsh*` 变化 → `resetVisionModelApplications()`；`social.wake.*` 变化 → `applyOwnerWakeProbabilityToSessions()`；`dshCompaction.*` 变化 → 重写 DSH 的 `cordis.patch.yml`。

### 10.2 会话轮换与永久会话

- 计数落在 `social-state.json` 的 `rotateTurns`（重启不重置）
- 阈值 `social.autoReset.wakeThreshold` 默认 10、下限 5，`rotateThresholdOf()` **每轮现读** cfg（`wake-send.js:92`）
- 判定统一到 `rotationDue(key, st, cfg)`（`wake-send.js:108`），**三个调用点共用**：`wake-send` 的 busy 分支、轮换块、`turn-hold` 的保持循环
- 防卡死：推迟注入最多 `ROTATE_DEFER_MAX_MS = 120000`，超时后 `rotationDue()` 自动改判 `false` —— **宁可晚一点轮换，也绝不把用户的消息扣死**
- `social.autoReset.permanent === true` → 阈值返回 `Infinity`，所有判定写成 `count >= threshold` 天然恒为 false，于是轮换块、busy 分支、保持循环、控制台的 `[Rotate]` 收尾指令**一处不改就自动停用**
- 轮换还有个"预热"：`createStandbySession()`（`core/dsh-session.js:159`）提前建好下一代会话（同工作区 + 同 preset + 视觉模型），不写入映射、不触发投递，首轮提示词已被提供方前缀缓存命中
- `agentPreset` 只在**建会话时**绑定：换 preset 后老会话仍用旧提示词，要等轮换或空闲归档重建（`lib/dsh-compaction.js:293-295` 记录了这条注意事项）

永久会话的完整成本论证见 [COMPACTION-MATH.md](COMPACTION-MATH.md#6-轮换新会话的最优点)。

---

## 11. 安装布局与路径解析规则

### 11.1 安装树（运行时根目录）

```
<RUNTIME_ROOT>/                       ← 安装根（可装到任意盘、任意目录名）
├─ MoonBot.exe                        ← Electron 壳（由仓库外打包工程产出）
├─ resources/runtime/                 ← 运行时可写树（源码树里就是仓库根）
│   ├─ server/                        ← 管理端后端（index.js / deploy.js / *.mjs / *.js）
│   ├─ qq-bridge/                     ← 桥（src/ plugins/ characters/ roles/ state/ config.json）
│   ├─ napcat-onekey/                 ← 随包 NapCat 与 QQ
│   ├─ dsh-runtime/                   ← 随包 DSH CLI（package.json 私有，依赖 @deepseek-ai/dsh）
│   ├─ dist/                          ← 管理端前端构建产物
│   └─ .runtime/dsh-isolated-home/    ← 桥的项目内隔离 home（候选之一，见 §8.1）
├─ resources/app/                     ← 壳自身资产（未验证具体文件名）
└─ …
```

`RUNTIME_ROOT` 由 `server/index.js` 顶部计算：`dirname(dirname(fileURLToPath(import.meta.url)))`，失败时回退 `process.cwd()`。这是"安装到任意盘"能成立的前提——代码里不得再用 `process.cwd()` 推导资源路径。

### 11.2 路径解析规则

| 目标 | 规则 | 依据 |
| --- | --- | --- |
| 运行时可写树 | `RUNTIME_ROOT`（= `server/index.js` 的上两级） | `server/index.js:25-37` |
| 管理端配置 | `join(homedir(), '.qq-bridge-manager', 'config.json')` | `server/index.js:43-47` |
| 管理端日志 | `<CONFIG_DIR>/logs/`（`manager.log`、`napcat-guardian.log`、实例日志） | 同上 |
| 隔离 DSH home（管理端默认） | `<RUNTIME_ROOT>/.runtime/dsh-isolated-home` 作为 `DEFAULT_ISOLATED_HOME`，实际取值来自 `instances.dshIsolated.isolatedHome` | `server/index.js:81` |
| 桥目录 | `findBridgeDir()`：优先 `RUNTIME_ROOT/qq-bridge`，其余候选见实现；`startBridgeLocal()` 只信自动探测结果，忽略配置里残留的 `workDir` | `startBridgeLocal()` |
| 随包 DSH CLI | `instances.dshIsolated.dshCli`，否则 `findDshCli()`；`--port` 取自 `instances.dshIsolated.port` | `startIsolatedDsh()` |
| 随包 NapCat | `findNapcatOneKeyAll()` 的候选根列表（项目内 → `%LOCALAPPDATA%\Programs\*\resources\runtime` → 用户下载/桌面/文档） | `server/index.js:947-984` |
| 前端产物 | `join(RUNTIME_ROOT, 'dist')` | 静态托管实现 |

配置读入时还会做一次"路径仍在树内"的校验（`inTree()`，`loadConfig()`）：配置里指向树外的路径会被拒绝，避免历史配置把资源指到别处。

### 11.3 边界情形

| 情形 | 处理 | 依据 |
| --- | --- | --- |
| 换盘 / 换安装目录 | `RUNTIME_ROOT` 随程序位置推导；配置里残留的 `launchCommand` / `workDir` 被自动探测覆盖 | `startBridgeLocal()` 注释 |
| 中文路径 / 空格路径 | PowerShell 调用一律用单引号字面量转义（`q(onekey.dir)`），`spawn` 传参数组而非拼命令行；守卫命令行拼接时对含空格或引号的参数加引号 | `startNapcatHidden()`、`spawnGuardianDetached()` |
| 从资源管理器双击 / 计划任务启动 | cwd 可能是 `C:\Windows\System32`，因此全部路径不依赖 cwd | `RUNTIME_ROOT` 的设计目的 |
| 只读安装目录（如 `Program Files`） | 守卫硬链接退到 `RUNTIME_ROOT/.guard/`；建链接失败只记日志，WMI 脱身仍然有效 | `spawnGuardianDetached()` |
| 临时目录不可写 | NapCat 窗口隐藏器起不来 → 退回一次性 `hideBundledQqWindows()` 轮询 | §14.2 |
| 非 Windows | 隔离 home 解析中的"拒绝桌面端 DSH"分支只在 `win32` 生效；Linux 上 `/root/.dsh` 是**合法目标**；NapCat 走官方安装脚本 | `lib/dsh-side.js`、`server/index.js` 的 `process.platform !== 'win32'` 分支 |
| 多份安装共存 | 停止/杀进程按**全部**候选托管目录前缀匹配（不只第一个命中的），避免漏掉真正在跑的另一套 | `findNapcatOneKeyAll()` 注释、`napcatManagedDirs()` |

---

## 12. 通信面

### 12.1 管理端 HTTP 面（`server/index.js`）

工作树实测 **93 条** `app.get/post/put/delete` 路由（含 `:param` 形式）。按功能分组：

**配置、状态与生命周期**

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/config` | 读管理端配置（含服务器列表、实例配置） |
| POST | `/api/config` | 保存管理端配置（深合并 + 原子写） |
| GET | `/api/state` | 总状态：实例 phase/探活、连接模式、远程三件套、配置摘要（前端 1.2~4 秒轮询） |
| GET | `/api/connect` | 连接状态机快照（零网络，读 `connect-machine`） |
| GET | `/api/open` | 解析"打开官方界面"的目标 URL（`scope=local\|remote`，服务端在线时把本机 NapCat 请求落到远端隧道） |
| POST | `/api/shutdown` | 关窗前收摊（默认只收 NapCat，`{all:true}` 连桥与隔离 DSH） |
| POST | `/api/guardian/arm` | 手工武装关窗守卫（校验目标进程名必须是 `MoonBot`） |

**实例编排**

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/instance/:id/:action` | `start` / `stop` / `restart`（`id ∈ {dsh-isolated, napcat-local, bridge-local}`） |
| POST | `/api/instance/start-all` | 按依赖顺序启动整套并逐步等到就绪 |
| GET | `/api/instance/:id/logs` | 读实例日志尾部（UTF-8 失败退 GBK） |

**SSH 与服务端**

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/ssh/test` | 测试连通性 |
| POST | `/api/ssh/connect` | 建立连接 + 四条隧道（13000/13001/13080/13100） |
| POST | `/api/ssh/disconnect` | 断开并关隧道 |
| GET | `/api/ssh/status` | 连接与服务端组件状态（DSH / NapCat / 桥） |
| POST | `/api/ssh/sync` | 同步本机代码/资源到目标机 |
| POST | `/api/ssh/stack` | 服务端整套服务的启停（含 NapCat 容器的起停顺序） |
| POST | `/api/ssh/service` | 单个 systemd 服务 / 容器的启停 |
| POST | `/api/ssh/remove-stack` | 卸载目标机上的整套服务 |
| GET/POST | `/api/ssh/bridge-config` | 读写服务端 `/root/qq-bridge/config.json` |
| POST | `/api/ssh/deploy/start` | 启动 SSH 克隆部署 |
| GET | `/api/ssh/deploy/status` | 部署进度（步骤、当前步、日志行） |
| GET | `/api/ssh/deploy/tasks` | 部署任务台账 |

**桥能力代理**（`/api/bridge/*`，转发到桥控制台）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/bridge/config` | 读桥配置（本机或服务端） |
| POST | `/api/bridge/config` | 保存桥配置；摘出 `dsh.apiKey` 写进隔离 DSH 凭据文件，并按需重启隔离 DSH（§13.3） |
| GET/POST | `/api/bridge/owner-qq` | 主人 QQ 读写（首次运行的引导项） |
| POST | `/api/bridge/speech-reset` | 恢复内置发言规则模板 |
| GET | `/api/bridge/characters`、POST `/api/bridge/characters/import` | 角色库列表 / 导入角色包 |
| GET | `/api/bridge/chat-convs`、`/api/bridge/chat-messages`、`/api/bridge/chat-stats`、POST `/api/bridge/chat-delete` | 聊天记录：会话列表、消息、总量、按会话删除 |
| GET | `/api/bridge/memory-stats` | 记忆库统计 |
| GET | `/api/bridge/tool-schema-stats`、`/api/bridge/context-overhead` | 工具 schema 体积 / 上下文开销快照 |
| GET/POST | `/api/bridge/activity-hours`、GET `/api/bridge/activity-targets` | 活跃时段配置与目标 |
| POST | `/api/bridge/upload`、`/api/bridge/stickers/upload` | 上传角色资产 / 表情包 |
| GET | `/api/bridge/meme-packs`，POST `/api/bridge/meme-packs/upload\|delete\|bind` | 表情包仓库管理 |

**学习与画像**（`/api/learning/*`）：`config`（GET/POST）、`slang`（POST）、`persona`（POST）、`persona-apply`（POST）、`portrait`（POST）、`portrait-config`（GET/PUT）、`profile`、`graph`、`groups`、`messages`、`owner-profile`、`relations`（GET/PUT）、`relations/auto`（POST）、`slang-library`、`token-report`、`token-reconcile`（POST）、`token-stream`（GET，SSE）。

**NapCat**（`/api/napcat/*`）：`launchers`（GET，候选启动器与安装位置）、`install-qq`（POST）、`tokens`（GET/POST，WebUI/HTTP/WS 三处令牌）、`webui-ready`（GET）、`qr`（GET）、`login-stream`（GET，SSE）、`guard`（GET/POST）、`guard/heal`（POST）、`quick-password`（POST）。

**语音**（`/api/voice/*`）：`config`（GET/PUT）、`voices`（GET/POST/DELETE）、`preview`（POST）、`test`（POST）。

**黑话批量**（`/api/slang/*`）：`batch-confirm`、`batch-delete`、`batch-reject`、`research`（均 POST）。

**配置方案**（`/api/profiles`）：GET 列表、POST 保存（参数完全相同则复用，不重复新增）、POST `/api/profiles/:id/delete`。

### 12.2 事件流（SSE）

| 端点 | 上游 | 内容 |
| --- | --- | --- |
| GET `/api/bridge/chat-stream` | 桥控制台 | 聊天/回合实时流 |
| GET `/api/learning/token-stream` | 桥控制台 | token 用量实时流 |
| GET `/api/napcat/login-stream` | 桥控制台 | QQ 登录状态流（扫码结果） |

三者都是 `text/event-stream`，由管理端后端以 `x-console-token` 头代理到桥控制台；`index.html` 单独带 `Cache-Control: no-store`，避免刷新后拿到旧壳。

管理端自身**不提供 WebSocket 端点**（`server/index.js` 里没有 `WebSocketServer` / `app.ws` / `upgrade` 处理，`websocketServers` 一词只出现在 NapCat 的 OneBot 配置里）：实时面全部走 SSE，状态面走轮询。

### 12.3 桥控制台面（`qq-bridge/src/core/console-server.js`）

监听 `consolePort`（默认 3100，绑定 `127.0.0.1`）。端点计数须给出判据，否则不同口径差很大：以 `url.pathname === '/api/...'` 形式的**字面量比较**统计，工作树实测 **159 处比较、去重后 136 个路径**；另有若干以 `startsWith` 匹配的前缀族（如 `/api/stickers/`），故**可路由到的端点总数 ≥ 136**。复现命令：

```bash
node -e "const s=require('fs').readFileSync('qq-bridge/src/core/console-server.js','utf8');const m=[...s.matchAll(/(?:pathname|p|path|url)\s*===\s*'(\/api\/[^']*)'/g)].map(x=>x[1]);console.log('比较',m.length,'唯一',new Set(m).size)"
```

分组概览：

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

鉴权：控制台端点要求 `x-console-token` 头或 `?token=`（首页探活 `GET /` 免鉴权）；**默认本机可信**，不再自动生成令牌、也不再写 `state/console-token`。MCP 工具侧回调控制台时同样带这个头，等价于"本机可信"。

### 12.4 桥 ↔ NapCat（OneBot v11）

| 方向 | 通道 | 说明 |
| --- | --- | --- |
| NapCat → 桥 | 反向 WebSocket `ws://127.0.0.1:3001` | 事件推送（消息、通知、撤回）；桥侧 URL 与令牌来自 `config.json` 的 `napcat.wsUrl` / `accessToken`（`core/config.js`） |
| 桥 → NapCat | HTTP 动作接口 `http://127.0.0.1:3000` | 发送消息、群管理、QQ 空间、点赞等；令牌同样用 `napcat.accessToken` |
| 管理端 → NapCat | WebUI `http://127.0.0.1:6099` | 扫码登录与 OneBot 网络配置的界面入口（`/api/open` 给出 URL） |

出厂 OneBot 网络配置由 `ensureNapcatOnebotConfig()` 在 NapCat 启动后注入（HTTP 3000 绑 `0.0.0.0`、WS 3001 绑 `127.0.0.1`，令牌 `truefriend`）；写入不影响 NapCat 内存状态，因此可以随时补写。

令牌方向性是硬约束：**文件已存在就承认它才是真相**（§13.3）。写 NapCat 配置文件不会立即生效——NapCat 只在启动时读配置，改令牌必须重启 NapCat。

### 12.5 桥 ↔ 隔离 DSH

协议（官方 0.1.2 起，写进 `qq-bridge/src/dsh-client.js` 文件头）：

- **一元 RPC**：`POST /api/<namespace>/<method>`，body 为参数（旧式的点号端点 `/api/session.list` 已移除）
- **流式事件**：统一经 WebSocket `/api/remote.mux`，上行 `{type:'open', streamId, endpoint, payload:{args}}`
- **审批/提问应答**：`POST /api/$events/result {args:{clientId, eventId, outcome:{kind:'result', value}}}`
- **鉴权**：官方 web 启动时打印 `?token=`；客户端先 `GET /?token=xxx` 换 `dsh-auth-*` cookie（303 + `Set-Cookie`），之后 `/api` 与 WebSocket 都带 cookie；无 token 的环境自动免鉴权

桥侧用到的具体调用：`sessions.prompt({sessionId, mode, content})`（模式语义见 §3.3）、`session/selectModel`、`session/modelCatalog`、`workspace/archiveSession`（§6.4）、`events.mux` + `session/follow`（事件泵）。

提示词投递与回传的完整路径：

1. 桥 `buildWakePrompt()` 组装正文（§3.4）；
2. `deliverPromptNow()` → `ensureSession()` 拿 sessionId → `api.sessions.prompt({mode:'steer'})`；
3. DSH 在下一个 step 边界把提示词交给模型；
4. DSH 把回合事件写进 WebSocket 流，桥 `pumpMux()` 逐帧处理 `session/event`（`turn/start`、`step/end`、`tool/result`、`turn/end`）；
5. 模型调 MCP 工具 → 工具（`mcp-napcat-safe.js` 等）执行并直接调用桥控制台或 OneBot 发消息；
6. 回合结束由 `mux.js` 收尾（§3.5）。

`dsh-seq.json` 保存每会话已处理的最大 `seq`：桥重启后 `follow` 快照会把整段历史重放一遍，而重放帧与实时帧同形，没有水位就只能靠 `seq` 去重（§7）。

### 12.6 管理端 ↔ 浏览器前端

- 同源：生产模式下前端产物由 `127.0.0.1:1921` 静态托管，`/api/*` 同源直取；开发模式下 Vite 跑在 5173，`/api` 代理到 `1921`（`vite.config.ts`）。
- 轮询：`src/App.tsx` 对 `/api/state` 做 1200 ms（过渡期）/ 4000 ms（稳态）轮询，并设 20 秒预热窗；ESC 返回首页。
- 缓存：`src/config-cache.ts` 两级缓存（模块内存 + `localStorage`，键 `moonbot.cfgcache.v1.<scope>::<key>`），页面挂载先用真实缓存渲染，**没有缓存时不允许用出厂默认值冒充**（渲染空值 + 禁用，等回包）。
- 内嵌界面：`src/pages/WebView.tsx` 用内嵌窗口打开 NapCat WebUI / DSH Web / 桥控制台；`iframeBlocked` / `iframeBlockReason` 由后端在 `/api/open` 里给出。

### 12.7 管理端 ↔ 目标机（SSH）

| 通道 | 用途 |
| --- | --- |
| `ssh2` 命令执行 | 探测、安装、systemd 操作、自检 |
| 本地监听隧道 | 13000 → NapCat WebUI、13001 → OneBot HTTP、13080 → DSH Web、13100 → 桥控制台（`tunnelMapFor()`） |
| 流式转发 | 打包产物不落目标机中间文件，直接喂给解包命令（`streamPipe`） |
| 断线自愈 | `ensureTunnels()` 每次检查四条隧道是否真在监听，缺了就重建（"connected=true 但一个隧道都没在听"是历史事故） |

---

## 13. 首次启动、鉴权与凭据

### 13.1 首次启动状态机

首次启动指的是"这个安装从未成功跑通过一次"。管理端与桥各自有自己的引导判据。

**管理端侧**

| 状态 | 进入条件 | 系统行为 | 出口 |
| --- | --- | --- | --- |
| 配置缺失 | `~/.qq-bridge-manager/config.json` 不存在 | `loadConfig()` 落 `DEFAULT_CONFIG`：`instances.dshIsolated{port:10721, profile:'web'}`、`instances.napcatLocal{webuiPort:6099, webuiToken:'truefriend', killOnExit:true}`、`instances.bridgeLocal{webuiPort:3100}`、`autoStartOnBoot:true`、`local` 端口表、默认 provider `deepseek-official` / model `deepseek-v4-flash-vision-exp` | 首次保存后进入"已配置" |
| 主人未设置 | `ownerQQ` 为空 | 前端弹出首次运行引导（`getOwnerQQ` / `setOwnerQQ` → `/api/bridge/owner-qq`） | 写入主人 QQ |
| NapCat 未就位 | `findNapcatOneKeyAll()` 未命中托管目录 | `/api/napcat/launchers` 列出候选；`/api/napcat/install-qq` 可触发安装/解压 | 命中后 `napcat-local` 卡片可启动 |
| 实例未启动 | `instances.<key>.enabled !== true` | 首页三张卡片显示"未启动"；`scheduleAutoStart()` 不恢复 | 用户点「启动」或「启动整套」 |
| 就绪 | 端口/HTTP 探活通过 | phase = `running`，卡片出现「打开」 | — |

**隔离 DSH 首次启动**

1. `startIsolatedDsh()` 先做 profile 自愈（`healProfile()`）：建 `profiles/<profile>/`（`cordis.yml` + `package.json`），必要时用 junction 从随包 dsh 发行面补齐 `node_modules`，并把 `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` 写进 bundles/dependencies。缺这一步时 `qq-mode-console`（inject settings）与三组 `mcp-client`（inject tools）会永久 pending，隔离 DSH 起不来。
2. 以 `--profile web --port <port> --no-open --trusted-host …` 拉起，最多等 60 秒探测端口。
3. 端口通了之后判断引导标记 `<DSH_HOME>/qqbridge-setup.done`：不存在 → 跑 `qq-bridge/scripts/setup-dsh.mjs --home <home> --profile <profile> --force`（注入 agent-presets 与 MCP 配置），成功后写标记，**杀掉当前 DSH 并自动重启一次**（preset 需要重启加载）。
4. 已存在标记 → 只在线，不重启。

**NapCat 首次启动**

1. 启动前预置：若 `<config>/webui.json` **不存在**且读不到实际令牌，写入 `{ token: <配置值>, loginRate: 10 }`；若文件已存在，则**以文件为准，绝不反写配置值**（§13.2 的"单向"约束）。
2. 注入出厂 OneBot 网络配置（HTTP 3000 / WS 3001，令牌 `truefriend`）。
3. 以 `Start-Process -WindowStyle Hidden` 拉起 `NapCatWinBootMain.exe`；带快速登录参数时附 QQ 号。
4. 就绪判据：WebUI 端口在听 = 已起；3000/3001 任一在听 = 已登录。未登录时卡片提示"等待 QQ 扫码登录"，二维码经 `/api/napcat/qr` 与 `/api/napcat/login-stream`（SSE）呈现。

**桥首次启动**：`acquireLock()` 抢 `state/bridge.lock`（`wx` 写 PID）；已有实例存活则 `exit 2`。随后连接 OneBot WS、装载 `initXxxCore(cfg)`、异步做 DSH 端自安装（§8.1）、按 `dsh-seq.json` 水位恢复事件流。

### 13.2 鉴权面清单

| 面 | 凭据 | 存放 | 校验方 | 生命周期与约束 |
| --- | --- | --- | --- | --- |
| QQ 登录 | 登录票据（扫码或快速登录取得） | NapCat 自己落盘的 `napcat_<QQ>.json` 等（容器跑法在卷 `napcat-qq:/app/.config/QQ`） | 腾讯 | 桥每次启动顺手备份到 `<config>/login-backup/<时间>`，只保留最近若干份；容器 `restart` 必须用 `-t 30`，`stop` 的默认 10 秒会把票据硬杀掉、回来还得重新扫码 |
| NapCat WebUI | `webui.json` 的 `token` | `<NapCat config>/webui.json` | NapCat 进程内存 | **单向**：只在文件不存在时预置一次；文件已存在就承认它是真相。运行期只认启动时读进内存的值——改文件而不重启必然 `token is invalid` → 页面所有接口 `Unauthorized` |
| OneBot HTTP/WS | `onebot11*.json` 的 `network.httpServers[].token` / `websocketServers[].token` | 同上报文配置目录 | NapCat | 出厂注入为 `truefriend`；改配置后必须重启 NapCat 才生效 |
| 隔离 DSH Web / API | 每次启动打印的 `?token=` | DSH 实例日志 | DSH | 先 `GET /?token=` 换 `dsh-auth-*` cookie（303 + `Set-Cookie`），之后 `/api` 与 WebSocket 都带 cookie；token 轮换/换取失败导致的 401 会强制换新 cookie 后只重试一次 |
| 隔离 DSH 模型密钥 | `KEY: value`（`refs:` 块） | `<DSH_HOME>/.credentials.yaml`（mode 600 + `.bak-<ts>` 备份） | DSH provider 的 `apiKeyEnv` | 由管理端摘出 `config.json` 的 `dsh.apiKey` 后写入；解析顺序见 §13.3 |
| 桥控制台 | `x-console-token` 头或 `?token=` | 配置项 `consoleToken`；**不再自动生成、不再写 `state/console-token`** | 桥 | 默认"本机可信"；`GET /` 探活免鉴权 |
| 会话令牌（agent token） | = 群号 / QQ 号 | 唤醒正文 `[Token]` 行 | 桥 | 可预测，因此**只**解锁会话级端点；不要拿它当密钥 |
| 学习会话令牌 | 32 位 hex | `state/learning-token` | 桥 | 不可猜、跨重启稳定，**只**解锁 `/api/learning/submit-persona`；刻意不并入 `KNOWN_AGENT_TOKENS`（避免扩权） |
| 管理端 HTTP API | 无应用层鉴权 | — | — | 仅绑定 `127.0.0.1`；任何能访问本机回环的进程都可调用（见 §13.3 的现状说明） |
| SSH | 私钥（`authType: 'key'`）或密码（`authType: 'password'`） | 管理端 `config.json` 的 `servers[]` | 目标机 sshd | 密码为**明文**存储与明文返回；PAM 只支持 `keyboard-interactive` 时走交互式应答分支 |

### 13.3 凭据写入与脱敏策略

**写入路径（隔离 DSH 模型密钥）**

1. `POST /api/bridge/config` 先把 `body.config.dsh.apiKey` / `clearApiKey` **从要落盘的对象里删掉**——明文密钥不许进 `qq-bridge/config.json`（那个文件还会被同步/打包）。
2. 目标环境变量名按三级解析（`providerApiKeyEnv()`）：隔离 DSH 的 `settings.yaml` 里 `providers.<id>.apiKeyEnv` → 已知服务商别名表（`deepseek-official`/`deepseek` → `DEEPSEEK_API_KEY`；`xiaomi-token-plan-cn` → `XIAOMI_TOKEN_PLAN_CN_API_KEY`；`mimo` → `MIMO_API_KEY`）→ 按 id 推导 `<ID>_API_KEY`。
3. 实际改写逻辑全部在 `server/iso-credential.js`（本地直写与服务端写盘共用，可单测）：定位 `refs:` 块（缩进感知）、按 YAML 标量规则加引号（`YAML_NON_STRING_WORDS` / `YAML_NUMBERISH` / `YAML_RADIX`），写前备份、写后 `chmod 600`。
4. 格式自检（`validateCredentialDocument()`）：必须有 `version`，顶层键只能是 `{version, refs, records}`，`refs` 值不得为空。DSH 对扁平布局与未知顶层键都会直接拒绝。
5. 只有 `.credentials.yaml` 已存在（隔离 DSH 至少成功启动过一次）才允许写；找不到文件时 fail-closed 并给出"先启动一次隔离 DSH"的提示。
6. 同一路由还做模型漂移自愈：每次保存都拿期望的 `provider/model/reasoningEffort` 核对隔离 DSH 的 `settings.yaml`，不一致就改写并后台重启隔离 DSH；只有"确实在存配置"（`body.config` 存在）时才触发，避免存个签就把 DSH 重启。

**脱敏**

| 位置 | 策略 | 依据 |
| --- | --- | --- |
| 凭据状态查询 | 只回 `{env, from, set, len}`，**绝不回值** | `isoCredentialStatus()` |
| 保存响应 | 回一份"脱敏后的 config"（`dsh.apiKey` 置空）+ `apiKeyWrite` 的 `{ok, env, action, backup}` | `POST /api/bridge/config` 响应 |
| NapCat 令牌展示 | `maskNapcatToken()`：空 → `''`；长度 ≤ 4 → `****`；否则首 2 位 + `****` + 末 2 位 | `server/index.js:7670` |
| 日志 | 令牌/密钥不落 `manager.log`；只记"写入了哪个环境变量、备份到哪" | 各 `mlog()` 调用点 |
| 部署 | 目标机 `buildTargetDshHealScript()` 会把 `.credentials.yaml` 的权限从 666 修回 600——DSH 拒绝加载"权限对属主以外可读"的凭据文件（报 `readable beyond its owner (mode 666)`） | `server/deploy.js` |
| 打包排除 | 本地打包路径排除 `state/bridge.lock`、`state/*.log`、`*.bak*` 等运行痕迹；`packLocalBridge` 的排除表由 `tools/test-bridge-pack-excludes-config.mjs` 守住"代码包不覆盖远端 `config.json`"这条线 | `server/deploy.js`、`tools/` |

**现状说明（不做美化）**：

- `GET /api/config` 原样返回整份配置，其中包含 `servers[].password` 与 `servers[].passphrase` 的**明文**；前端输入框虽为 `type="password"`，存储与传输都是明文。收敛暴露面的唯一手段是后端只监听 `127.0.0.1`。
- 隔离 DSH 的 `.credentials.yaml` 由管理端写入并 `chmod 600`；Windows 上 `chmod` 不生效，实际保护依赖 NTFS 默认 ACL（**待确认**：未在目标环境实测该文件的 ACL）。

---

## 14. NapCat 守护与自修

NapCat 是本系统里最容易"死得不明不白"的部件（QQ 侧踢下线、更新中断、被杀软删文件、进程被任务管理器结束）。因此守护分四层：进程内监护、关窗守卫、文件级自修、桥侧状态读取。

### 14.1 进程内监护（管理端）

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| 启动登记 | `napcatLaunchedThisProcess` / `napcatSpawnedPids` | 记录"本次运行由我拉起的 NapCat"，是所有退出清理的前置判据 |
| 启动前快照 | `listNapcatProcsInDirs()` 的 `beforePids` | 与启动后做差集，避免把"上一份还没退干净"的进程当成这次启动的（`collectNapcatPidsAfterLaunch()`） |
| 退出清理 | `killNapcatOnExitSync()` 等退出路径 | 第一个判断就是 `napcatLaunchedThisProcess`；为假则**一个 NapCat 进程都不碰** |
| 开关 | `killOnExitEnabled()`（`instances.napcatLocal.killOnExit`，默认 `true`） | 关掉后 `/api/shutdown` 不收 NapCat，响应回 `napcatSkipped: true`；该开关同时以 `--kill-napcat 0/1` 传给守卫——打包版关窗走壳的 `taskkill /F`，本进程跑不到任何代码，守卫是那条路上唯一能执行"收不收"的地方 |
| 停止校验 | `stopInstance()` | 停止后**校验端口是否真的不再监听**；以前无条件返回 `success:true`，配合 `node.exe`/`qbm-node.exe` 的过滤缺口，用户看到"重启了但没反应" |
| 兜底杀进程 | `killByCmdline(marker)` | 按命令行关键字杀**两种进程名**（`node.exe` 与 `qbm-node.exe`）的历史/游离进程 |

### 14.2 关窗守卫（`server/napcat-guardian.mjs`）

独立进程，不在应用进程树内（脱身办法见 §2.2）。判据、策略与失败语义：

| 项 | 值 / 行为 | 说明 |
| --- | --- | --- |
| 参数 | `--parent`、`--guard-file`、`--dirs`、`--dsh-port`、`--bridge-script`、`--kill-napcat`、`--grace`、`--log` | 由 `armNapcatGuardian()` 组装 |
| 轮询间隔 | 2000 ms 检查父进程是否存活 | 父进程活着就什么都不做 |
| 宽限期 | `graceMs`，默认 30 000 ms（早期为 6 秒） | 父进程消失后先等宽限，再动手 |
| 接管保护 | 行动前**重新读 guard 文件确认归属** | 防"管理端重启、新后端已接管"时把新一套收掉 |
| 清理顺序 | NapCat → 桥 → 隔离 DSH | 三段各自独立判定，前一失败不影响后一段（清理本身不重试、不重启） |
| 匹配方式 | 托管目录前缀 / 桥的绝对路径 / DSH 端口 | 精确匹配，且排除自身（`NOT_SELF`）；`--dirs` 为空则什么都不杀 |
| 失败升级 | 无重试循环；每段失败只写日志后继续 | 守卫是**一次性收尾**，不是常驻健康检查。**待确认**：日志轮转策略未在实现中体现 |
| 武装时机 | 启动时一次 + 每 60 秒 `setInterval` 复查 | 条件见 §2.4 |
| 可观测 | `%USERPROFILE%\.qq-bridge-manager\logs\napcat-guardian.log`；管理端 `mlog()` 同步记一行"已武装" | |

**重启策略**：守卫不重启任何东西，只负责"应用没了以后把该收的收掉"。运行期的重启由桥侧的 keepalive/自修与用户的「启动/重启」按钮承担。

### 14.3 文件级自修（`server/napcat-repair.js`）

NapCat Shell 目录在三种情况下会**缺文件**：更新包解压不全、杀软删除、跨盘复制中断。典型症状是 `ERR_MODULE_NOT_FOUND: conout-*.js`。自修模块：

| 能力 | 实现 |
| --- | --- |
| 找出所有 NapCat 应用目录 | `findNapcatApps({root})`，深度上限 8 层 |
| 判断是否缺件 | `checkNapcatApp()`：解析源码里的**相对说明符**（`relativeSpecifiers()` 识别 `from`、副作用 `import`、动态 `import()`、`require()` 四种写法），逐个确认文件存在 |
| 找到修复来源 | `findShellZip()`：从当前目录向上最多 10 层找 `NapCat.Shell.zip` 与 `7z.exe` |
| 补齐缺失成员 | `repairNapcatApp()`：从 `NapCat.Shell.zip` 中抽出缺失的文件 |
| 批量入口 | `ensureNapcatApps({root, fix, log})`；CLI 形式 `[--check\|--fix] [--root <dir>]`，缺件时退出码 1（可被脚本/测试断言） |

管理端在拉起 NapCat 前会先跑检查（`napcatRepairNote` 会进启动结果消息）。

### 14.4 桥侧 NapCat 守护（`core/napcat-guard.js`）

状态文件与默认参数：

| 项 | 值 |
| --- | --- |
| 状态文件 | `state/napcat-guard.json` |
| 二维码 | `state/napcat-qr.png` |
| 容器规格 | `state/napcat-container-spec/` |
| 默认参数 | `{ enabled: true, probeIntervalMs: 60000, failThreshold: 2, cooldownMs: 600000, maxHealsPerHour: 3, restartGraceSec: 60, recoverWaitMs: 150000, autoHeal: null }` |

**重要事实**：该模块**主动探测与自动重启的那段代码已被有意删除**（文件内 95-120 行有完整说明）。桥现在只做两件事：读取落盘的二维码、用 OneBot HTTP 询问登录状态。原因是那条探测路径把 NapCat 的登录接口当健康检查用——NapCat 对登录接口有每 IP 约 10 次/60 秒的限流，且与 WebUI 页面共用同一份额度，探测会把用户自己扫码要用的额度吃掉。上表里的 `failThreshold` / `cooldownMs` / `maxHealsPerHour` / `restartGraceSec` / `recoverWaitMs` 保留为配置面，但**当前没有执行者**——它们是历史契约的残留。相应地，管理端也删掉了"每分钟验证一次 WebUI 令牌"的轮询（那条日志以前会整夜刷屏）。

真正的 NapCat 恢复手段是：管理端的「启动/重启 NapCat」按钮、`POST /api/napcat/guard/heal`（重启容器并等它登回来）、`POST /api/napcat/quick-password`（重建容器，最长 3 分钟）。

### 14.5 随包 QQ 的窗口隐藏

需求是"完全静默、瞬时隐藏"：随包 QQ 的窗口不得闪出、不得出现在任务栏。实现是**启动前武装**的常驻 PowerShell 观察者（`qqWindowHiderScript()` + `armQqWindowHider()`）：

| 项 | 值 / 行为 |
| --- | --- |
| 参数 | `QQ_HIDER_DEFAULTS = { budgetMs: 43200000, pollMs: 200, burstMs: 50, burstWindowMs: 5000, readyTimeoutMs: 2500 }` |
| 隐藏手法 | `ShowWindow(h, 0)` + `SetWindowPos(…, SWP_HIDEWINDOW\|SWP_NOMOVE\|SWP_NOSIZE\|SWP_NOZORDER\|SWP_NOACTIVATE)` 双保险；窗口类样式在 `WS_EX_APPWINDOW` / `WS_EX_TOOLWINDOW` 之间互换；`ITaskbarList::DeleteTab` 摘掉任务栏按钮 |
| 路径守卫 | 只处理"可执行文件路径在本 Shell 目录之下"的 QQ 进程；取不到 `Path` 的一律跳过；前缀比较大小写不敏感且**按目录边界对齐**（补分隔符，免得 `…\Shell` 匹配到 `…\ShellOther`） |
| 启动器 pid 登记 | `seedQqWindowHiderPids()`：启动器常在几百毫秒内退出，先把"我们自己 spawn 的 pid"落盘再可能死，避免它带出来的窗口认不回来 |
| 控制台窗口扫描 | `consoleScanMs = 60000`（对控制台类窗口的额外扫描窗口） |
| 退出条件 | 预算 12 小时；父进程（管理器）连续 150 次探测不到（约 30 秒）→ `exit 0`；观察者就绪标记最多等 `readyTimeoutMs` |
| 兜底 | 观察者起不来（PowerShell 缺失 / `Add-Type` 编译失败 / 临时目录不可写）→ 退回 `hideBundledQqWindows()` 的一次性轮询 |

> 文档一致性提醒：`qqWindowHiderScript` 附近的注释仍写着"观察 120 秒"，而实际默认 `budgetMs` 已是 12 小时（真正的退出条件是父进程存活守卫）。以常量为准。

---

## 15. SSH 克隆部署（`server/deploy.js`）深挖

### 15.1 阶段划分

部署是**两端口令式**：目标机（新机）拿到源机（模板机）的完整能力。`deploy.js` 顶部的头部注释给出 0~6 的阶段划分，实现里每一步都写日志（GUI 轮询 `/api/ssh/deploy/status`）。

| 阶段 | 内容 | 关键实现 |
| --- | --- | --- |
| 0 校验 | 源/目标都在服务器列表里；连两端；探测端口（连不上时自动改用上次成功的端口） | `step()` / `safely()` |
| 1 目标机基础环境 | nodejs / npm / docker / python3 探测与安装（apt → nodesource → 官方 tarball → 发行版包，多路兜底）；全局 dsh CLI；`mcp-compressor`（pip，装不上不影响主流程） | `ensureNode()`、`ensureDocker()`、`localDshVersion()` |
| 2 源机短暂停机 + 打包 | 停 dsh-web / napcat / bridge，然后打 7 个 stage 包 | `buildStagePlan()`（远端源）或 `buildLocalStagePlan()`（本机源） |
| 3 源机恢复 | 立即把刚才停的三个服务恢复运行（总停机 ≈ 打包耗时，与传输带宽无关） | 与阶段 2 成对出现 |
| 4 流式转发与解包 | 逐包经 manager 中转，直接喂给目标机的解包命令，不在目标机留中间文件 | `streamPipe`；传输/解包失败**重试一次** |
| 5 目标机落地 | 写 systemd 服务 / 建或沿用 NapCat 形态（原生优先、docker 兜底）/ 灌 QQ 登录态 / 调整桥配置指向目标机 DSH 端口 / 能力核对 / 启动自检 | `installNapcatNative()`、`NAPcatMODE` 探针、`buildTargetDshHealScript()` |
| 6 清理 | 删源机 stage 目录，断开连接 | |

阶段 5 里几个容易被忽略的自检点：

- 启动 DSH 前显式 `daemon-reload` + `restart`，并当场确认 `is-active` 且 **3080 真有应答**（401 也算活着——DSH 无 token 一律 401；`down`/`000` 才算失败）。这条来自"3080 明明活着却永远连不上"的现场。
- 桥的 `config.json` 被改写为 `dsh.baseUrl = http://127.0.0.1:3080`（本机是 10721）。
- 核对能力是否到齐（pixiv / 语音 / 白名单 / 记忆 / 表情库 / 画像）由一段目标机脚本输出，退出码非 0 只记警告。
- systemd 服务定义同步：源机没有 `dsh-web.service` 时现场生成。

### 15.2 打包内容与排除项

**远端源机路径（`buildStagePlan()`）**

| 包 | 内容 | 落点 | 排除 |
| --- | --- | --- | --- |
| `qq-bridge.tar.gz` | 桥整棵树（代码 + `config.json` + `state/` 记忆与画像数据） | `/root/qq-bridge` | `.git`、`node_modules`、`state/bridge.lock`、`state/bridge*.log`（原生模块如 sharp 要在目标机重新 `npm install`） |
| `dsh-home.tar.gz` | 隔离 DSH 的整个 `DSH_HOME`（settings / credentials / agent-presets / profiles / sessions / storages / meme-packs） | `/root/.dsh` | 无 |
| `napcat-config.tar.gz` | NapCat 配置目录（含登录令牌文件） | 原生 → `/opt/napcat/config`；容器 → `/root/napcat/config` | 无 |
| `napcat-app.tar.gz` | `/opt/napcat` 应用本体（含自编译的 `napcat.mjs` 与防掉线补丁） | `/opt/napcat` | `cache`、`config`、`*.db*`；目标机已有 `napcat.mjs` 时跳过 |
| `qqdata.tar.gz` | QQ 登录态（免扫码快速登录） | 原生 → `/home/qq/.config/QQ`（`chown qq:qq`）；容器 → 卷 `napcat-qq` | 由 `opts.qqData === false` 关闭 |
| `dsh-polyfill.tar.gz` | 反向代理脚本目录 | `/root/dsh-polyfill` | 无 |
| `dsh-meme.tar.gz` | 表情库插件目录 | `/root/dsh-meme` | 可选（不存在则不带） |

**本机源路径（`buildLocalStagePlan()` + `packLocalStage()`）**

本机打包用 bsdtar，排除项更细，因为本机是开发工作区：

| 排除项 | 原因 |
| --- | --- |
| `node_modules`、`.git` | 体积；原生模块需目标机重装 |
| `state/bridge.lock`、`state/*.log` | 运行期状态 |
| `state/agents/*/node_modules` | DSH 工作区里的依赖树 |
| `tests/` | 开发用 |
| `*.bak`、`*.bak-*`、`state.bak-*`、`state.old-*`、`state.merge-stage-*` | 实测本机累计 41.4 MB 历史备份，其中 30 多个 `config.json.bak-*` **每个都带着机主 QQ、NapCat 令牌与服务器地址**；新机不需要，白白多复制一份隐私 |

`packLocalStage()` 还会报告"跳过的悬空链接"（指向本机已不存在路径的符号链接，目标机用不到）。本机打包路径下的解包脚本在覆盖前把目标机原 `config.json` / `state/voice-config.json` 备份到 `/root/qqbridge-prev-<TS>/`，并打印备份目录名。

**必须知道的取舍**：本机打包路径是"**整套复刻**"语义（本机配置覆盖目标机）；远端源机路径是"**换代码不换身份**"语义（目标机配置胜出，见 §15.4）。

### 15.3 目标端目录与 systemd

目标端目录表见 §9.2。systemd 侧的关键点：

- `dsh-web.service`：`Environment=DSH_HOME=/root/.dsh`、`EnvironmentFile=-/etc/qq-bridge.env`（可缺省）、`ExecStart=<dshBin> --profile web --port 3080 --no-open --trusted-host 127.0.0.1:3080`，日志落 `/root/.dsh/dsh-web.log`。
- `napcat.service`：原生跑法（官方 Linux QQ deb + `/opt/napcat` + Xvfb + 非 root 用户 `qq`）；源机没有该单元时现场生成。
- `dsh-polyfill.service`：可选。
- 形态由 `<stageDir>/napcat-mode` 标记驱动：`native` / `docker`，解包脚本据它选择配置落点与登录态落点。

**`buildTargetDshHealScript()` 修的三件事**（目标机首次启动前后的自愈）：

1. 插件 bundle 的符号链接（`<home>/plugins/<name>`、`<home>/profiles/node_modules/<name>`）被拷坏或断掉时重建；
2. `.credentials.yaml` 权限：666 → DSH 会拒绝加载并报 `readable beyond its owner (mode 666)`；
3. 从 Windows 带过去的 MCP 命令路径（形如 `D:\...\qbm-node.exe`）在 Linux 上无效，改写为可执行路径。

### 15.4 回滚、备份与能力保护

| 机制 | 行为 |
| --- | --- |
| 能力保护目录 | `/root/qqbridge-keep-<TS>/`：解包前保存目标机原有 `config.json`、`persona.md`、`state/` |
| 恢复策略 | 解包后由 `buildDeployKeepScript()` 做**逐键合并（目标机胜出）**，再把 `state/` 覆盖回来；语义是"部署 = 换代码，不换身份与记忆" |
| 整体克隆开关 | 目标机上设 `QQB_DEPLOY_WHOLE_CLONE=1` → 回到旧的"整套复刻"行为 |
| 旧配置备份 | 本机打包路径的 `/root/qqbridge-prev-<TS>/`（只存 `config.json` 与 `state/voice-config.json`） |
| 兜底 | 旧的 keep 脚本通过 `/tmp/qbm-deploy-keep.js` 在目标机执行后立即删除 |

> 历史坑：老行为只把目标机的 `config.json` / `voice-config.json` 备份到 `/root/qqbridge-prev-<TS>/` 就删库重解包，**从来没有放回去**过——"更新一次代码"会把目标机配好的 pixiv cookie、语音 key、白名单、工具档位与 `state/` 里的记忆与画像整片覆盖掉。

### 15.5 失败恢复

| 失败点 | 处理 |
| --- | --- |
| 传输或解包失败 | 自动重试一次（部署日志里会打印一行"传输/解包失败…重试一次"） |
| npm 全局装 dsh 失败 | 尝试 `/usr/bin` 软链；仍失败只警告并继续（让后续日志暴露真实原因） |
| 原生 NapCat 安装失败 | **回退 docker 路径**（容器已创建，待灌数据） |
| `mcp-compressor` 装不上 | 警告并继续（仓库里没有代码依赖它；工具描述压缩走 `social.slimTools`） |
| `dsh-polyfill` 单元不存在 | 不算失败 |
| 源机停机阶段出错 | 记录输出后继续打包；阶段 3 无论如何都尝试恢复源机服务 |
| 部署中断 | 源机 stage 目录残留（可手动清）；目标机处于"半新半旧"状态，`/root/qqbridge-keep-<TS>/` 仍在，可人工恢复；再次部署会走一遍同样的保护流程 |

---

## 16. DSH 集成

### 16.1 隔离 home

隔离 DSH 的一切都在一个独立 `DSH_HOME` 里，与桌面端那份物理隔离。解析顺序、拒绝规则与两份候选的说明见 §8.1。

隔离 home 的目录形态：

```
<DSH_HOME>/
├─ settings.yaml                 ← agent-default-model（provider / model / reasoningEffort）
├─ .credentials.yaml             ← 模型密钥（refs 块，mode 600）
├─ cordis.patch.yml              ← home 级：压缩与剪枝策略
├─ profiles/<profile>/           ← cordis.patch.yml（MCP 挂载 + preset overlay）、package.json、cordis.yml、node_modules
├─ plugins/                      ← 内置插件符号链接（qq-mode-console / dsh-memory）
├─ sessions/                     ← 会话日志（DSH 自己的格式，桥不写）
├─ storages/session_projcache/   ← 会话投影缓存（token 对账读它）
├─ meme-packs/                   ← 表情包数据
├─ .qq-bridge-dsh-installed.json ← 桥的安装标记（INSTALL_VERSION）
└─ qqbridge-setup.done           ← 首次 preset 注入的引导标记
```

### 16.2 一次性 token 与 cookie

| 环节 | 行为 |
| --- | --- |
| token 来源 | DSH 每次启动在日志里打印 `…/?token=<token>`；官方 web 不带 token 访问一律 401 |
| 管理端解析 | `readLatestDshToken(logFile)`：只读日志尾部最多 512 KB，**只认最后一次 `===== start` 之后**出现的 token，避免读到上一次运行（重启后已失效）的旧值；UTF-8 解码失败退 GBK |
| 桥解析 | `readLatestToken(logFile)` 用**逐级放大**的尾部扫描（256 KB → 1 MB → 4 MB → 16 MB），并且"最后一条 token 距 EOF 超过阈值就返回 null"——否则会读到几 MB 之前的旧 token，触发一次无谓的 401 与重试 |
| 换取 cookie | `GET /?token=xxx`（`redirect: 'manual'`，10 秒超时）→ 303/200 且 `Set-Cookie` 以 `dsh-auth-` 开头才认；获取 token 请求必须有超时，否则 TCP 半开会让共享的 session promise 永久挂起、全链路冻死 |
| 401 处理 | token 轮换或单次换取失败导致的 401：强制换新 cookie 后**只重试一次**（避免风暴），仍失败才抛错 |

### 16.3 会话与预设

| 项 | 说明 |
| --- | --- |
| 会话创建 | 桥按 QQ 会话键建立 DSH 会话，映射存 `state/sessions.json`；建会话时绑定 `agentPreset`（默认 `qq-chat`）与工作区标题（默认 `Agents`） |
| 预设装配 | `qq-bridge/dsh/agent-presets/qq-chat/`（`preset.yml` + `agent.cordis.yml` + `qq-tool-restrict.mjs`）；仓库一份、隔离 home 一份，桥每次启动刷新 |
| profile overlay | `patchProfileCordis()` 写 agent-presets overlay（`default: standard`、`includeUserRoot: true`），使 qq-chat 成为该 profile 的默认 preset |
| 轮换 | 见 §10.2 |
| 归档 | 见 §6.4 |
| 模型同步 | `syncDshAgentDefaultModel()` 与 `POST /api/bridge/config` 的漂移自愈共同保证 `settings.yaml` 的 `agent-default-model` 与管理端配置一致；改完后台重启隔离 DSH |
| 视觉/模型目录 | 管理端从 DSH 自己的配置里读每个服务商可用模型（`session/modelCatalog`、`settings.yaml` 的 `llm-pi-ai.providers.<id>.models`） |

### 16.4 MCP 工具面

三组 stdio MCP server 由 `mcpBlock()` 写进 profile 的 `cordis.patch.yml`（`# === qq-bridge MCP BEGIN/END ===` 标记块）。要点：

- `mcp-napcat` 的 `toolCallTimeoutMs: 725000`（长轮询与媒体任务需要）；
- 可选 Python 压缩代理包裹 `mcp-napcat`（默认开），参数形如 `-c <level> -n napcat [--exclude-tools] [--toonify] --`；
- 探不到压缩代理就直连，并把原因写进日志（绝不让工具表消失）；
- 学习会话只加载 `mcp__napcat-host__` 组（`qq_learning_*` 在那里）；
- 工具清单与体积的静态/实测数据见 §5.1～§5.3。

### 16.5 凭据注入

隔离 DSH 的 provider 从**环境变量**取 key（`apiKeyEnv`）。管理端在 `startIsolatedDsh()` 时用 `loadCredentialEnv(home)` 解析 `<home>/.credentials.yaml` 的 `KEY: value` 行并合进子进程环境（去引号、空值丢弃），因此密钥既不进 DSH 配置文件也不进命令行。写入链路见 §13.3。

---

## 17. 打包与分发

### 17.1 边界声明

安装包与 Electron 壳由**仓库外**的打包工程产出：

| 路径 | 角色 | 是否在本仓库 |
| --- | --- | --- |
| `C:\Users\17367\Desktop\QQ-Bridge-packaging` | 打包工程根（NSIS 脚本、壳源码、装配产物） | **不在本仓库** |
| `…\QQ-Bridge-packaging\build-installer-full.nsi` | NSIS 安装包脚本（输出 `MoonBot Pro Setup.exe`） | **不在本仓库** |
| `…\QQ-Bridge-packaging\moonbot-app\main.js` | Electron 壳主进程 | **不在本仓库** |
| `…\QQ-Bridge-packaging\full\app\` | 被装配的运行树（`server/`、`dist/`、`qq-bridge/`、`dsh/`、`napcat-onekey/`、`qbm-node.exe`） | **不在本仓库** |
| `C:\Users\17367\Desktop\MoonBot Public` | 源码仓库（运行时代码的真实来源） | 是 |
| `D:\MoonBot\resources\runtime` | 本机已安装副本（一份运行树拷贝，内容可能与源码树不同） | **不在本仓库** |

本文只描述打包侧与运行时的**接口**，不复述打包工程内部实现；凡未逐行核对的部分标「待确认」。

### 17.2 打包侧已核对的事实（文件系统层面）

以下条目来自对上述仓库外文件的直接读取，属于"已核对"而非推测：

| 事实 | 依据 |
| --- | --- |
| 安装包由 NSIS 3 构建，输出 `MoonBot Pro Setup.exe`，默认装到 `%LOCALAPPDATA%\Programs\MoonBot`，`RequestExecutionLevel user` | `build-installer-full.nsi` |
| 安装包分三个 Section：核心管理端（必需）、运行时层（桥 + DSH + NapCat，整块可选）、桌面快捷方式（可选） | 同上 |
| 核心管理端装 `server/`、`dist/`、`node_modules/`、`qbm-node.exe`、`start-manager.vbs`、`start-debug.cmd`、`app.ico` | 同上 |
| 运行时层装到 `$INSTDIR\qq-bridge`、`$INSTDIR\dsh`、`$INSTDIR\napcat-onekey` | 同上 |
| 卸载脚本只杀"路径在本安装目录下"的 `qbm-node` / `NapCatWinBootMain` / `QQ` 进程 | 同上（`$_.Path -like '$INSTDIR*'`） |
| 壳主进程：用内置 `qbm-node.exe` 隐藏启动后端（`server/index.js`，`127.0.0.1:1921`），轮询后端就绪后用独立 `BrowserWindow` 加载本地界面 | `moonbot-app/main.js` 头部注释与 `loadURL(urlFor(backendPort))` |
| 端口可退避：`QBM_API_PORT` 环境变量传入；1921 被无关程序占用时改用备用端口（**不抢占**别人的端口，只复用"确认是自己那份"的后端） | `main.js` |
| 关窗顺序：先 `POST /api/shutdown`（8~12 秒超时）求体面收摊，再 `taskkill /pid <后端> /T /F`；最后靠后端自带的守卫进程兜底 | `main.js` 的 `requestGracefulShutdown()` / `shutdownEverything()` |
| 壳文件名必须叫 `MoonBot`（`win.executableName`），因为 `server/index.js` 的守卫按进程名 `/^MoonBot$/i` 认应用本体 | `main.js` 注释 + `ensureGuardianArmed()` |
| 应用单实例：`app.requestSingleInstanceLock()` | `main.js` |

### 17.3 运行时侧的对应实现

| 打包侧概念 | 运行时对应 |
| --- | --- |
| `qbm-node.exe`（随包 Node 运行时） | 一切子进程都用 `process.execPath` 启动（DSH、桥、守卫、隐藏器）；`process.execPath` 本身就是 node 时 `--expose-internals` 之类的命令行 flag 才可用 |
| `$INSTDIR\server` | `RUNTIME_ROOT` = `server/index.js` 的上两级（NSIS 布局下即 `$INSTDIR`；electron-builder 布局下是 `resources\runtime`，本机 `D:\MoonBot\resources\runtime` 即此形态） |
| `$INSTDIR\dsh` | 随包 DSH CLI；管理端配置项 `instances.dshIsolated.dshCli` 指向它（本机实测值形如 `D:\MoonBot\resources\runtime\dsh\node_modules\.bin\dsh.cmd`） |
| `$INSTDIR\napcat-onekey` | `findNapcatOneKeyAll()` 的第一个候选根 |
| `start-manager.vbs` | 隐藏启动壳/后端，避免黑窗（仓库内另有 `tools/start-manager-hidden.vbs`、`tools/restart-manager.ps1` 供开发使用） |
| 卸载时按路径杀进程 | 与"绝不动用户本机正版 QQ"同源：只匹配安装目录前缀（§19） |

> 待确认：`dsh-runtime/` 与安装树的 `dsh/` 命名不一致（仓库内目录叫 `dsh-runtime`，NSIS 脚本装成 `dsh`），映射规则在打包工程内部；本文不推断其实现。

### 17.4 分发链

1. 源码仓库（本仓库）→ 打包工程装配 `full\app\`（`server/` + `dist/` + `qq-bridge/` + `dsh/` + `napcat-onekey/` + `qbm-node.exe`）；
2. 打包工程产出 `MoonBot Pro Setup.exe`；
3. 用户安装 → `%LOCALAPPDATA%\Programs\MoonBot`（或自定义目录）；
4. 首启 → 壳起后端 → 前端引导（§13.1）；
5. 另有独立的 SSH 克隆部署链（§9.3 / §15），把一台已跑通的机器整套复制到另一台 Linux 主机——这两条链互不依赖。

---

## 18. 可靠性与可观测性

### 18.1 日志

| 日志 | 位置 | 写入方 | 内容 |
| --- | --- | --- | --- |
| 管理端主日志 | `%USERPROFILE%\.qq-bridge-manager\logs\manager.log` | `mlog()` | 启停、探活、单点登录闸门、守卫武装、模型同步、凭据写入、SSH 部署摘要 |
| 实例日志 | 同目录（`instanceLogPath(id)`） | 子进程 stdout/stderr 直写 | DSH / 桥 / NapCat 各自的全部输出 |
| 关窗守卫日志 | 同目录 `napcat-guardian.log` | 守卫进程 | 武装信息、父进程消失、三段清理结果 |
| 桥主日志 | `qq-bridge/state/bridge.log` | `lib/log.js` 的 `log()` | 桥业务日志 |
| 会话活动流水 | `qq-bridge/state/qq-activity.log` | `lib/log.js` 的 `appendActivity()` | 每个会话的活动记录 |
| 工具调用流水 | `qq-bridge/state/tool-calls.jsonl` | `core/audit.js` | 工具名、参数摘要、结果，供档位统计与排障 |
| 运维输出 | 目标机 `/root/.dsh/dsh-web.log`、systemd journal | 部署侧服务 | 线上 DSH 与桥的日志 |

实例日志直写文件而不是管道转发：管理器一旦被重启或被 `taskkill`，管道读端消失，子进程下一次写 stdout 就是 EPIPE，Node 对 stdout 未处理 error 会直接打死进程（表现是"重启了一下管理器，桥就悄悄没了，日志里连一句错误都没有"）。桥自己也在 stdout/stderr 上装了 EPIPE 守卫。

### 18.2 审计

`core/audit.js` 负责**出站审计与静默拦截**：所有模型要发出的正文先过敏感内容检测（`sensitiveHitKind` / `SENSITIVE_RE`）与令牌泄露检测（`tokenDisclosureIn`），需要拦截时按角色状态与静默模式决定"拦下"还是"只记录"；`shouldAuditKey()` 当前对所有会话返回 `true`（早期"主人私聊跳过"的特判已删除）。

发送类工具的判定链：MCP 工具 → 桥控制台/OneBot → `qq-send.js` 的 `onebotSend` 是**所有模型正文的唯一出口**，幂等闸门（`send-idempotency.js`）与节奏控制（`lib/onebot-delivery.js`、`lib/send-gaps.js`）都挂在它前面。

### 18.3 token 计量与对账

| 环节 | 实现 |
| --- | --- |
| 逐帧计量 | `core/token-meter.js` 的 `meterTokenFrame(frame)` 在事件环每帧只调一次；深度扫描（≤6 层、数组元素 >200 跳过）整帧 usage 键（snake/camel 命名 + usage 对象内含键），命中且 sessionId 存在 → 写 `est:false` 行 |
| 估算兜底 | 拿不到真实 usage 时按帧 transcript 字符估算，写 `est:true` 行并附字符数 |
| 存储 | `state/token-usage.jsonl`，每行 `{tsMs, sessionId, convKey, prompt, completion, total, est, …}` |
| 权威对账 | 每 5 分钟 + 桥启动时读 `<dshHome>/storages/session_projcache/sessions/session-*.json` 的 `record.rows.tokenUsage.val.totals`（`uncachedInputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`），与桥侧同会话累计**逐桶**比对，只补桥侧少掉的部分（`reconciled:true` 行） |
| 水位 | `state/token-reconcile.json`，保证可反复执行不重复补记，也不会因文件截断（`MAX_LINES` 裁剪）把历史重加一遍 |
| 单帧漏记 | 帧里拿不到 sessionId 时整帧被丢弃（真实存在）：实测某会话 DSH 侧 961,349 / 桥侧 889,248，差 72,101（正好一步的量）——对账就是为这类缺口加的 |
| 呈现 | 管理端「学习/用量」页与 `/token` 指令**同一套口径**：只统计确实带缓存命中字段的请求（`cacheSamples > 0` 的小时桶），不反推不外推；金额 = `(命中×pHit + 未命中×pMiss + 输出×pOut)/1e6 × 高峰倍率`，时段（北京时）09:00-12:00 与 14:00-18:00，倍率 `peakMult`（`core/token-report.js`、`config.json` 的 `tokenCost` 段） |

### 18.4 崩溃自愈

| 场景 | 自愈手段 |
| --- | --- |
| 管理器进程内未捕获异常 | 顶层 `unhandledRejection` / `uncaughtException` 守卫记录日志（保持后端存活，让界面还能用） |
| 管理器被重启 | 子进程日志改为直写文件（§18.1）；`startInstanceTracked()` 靠探活把仍在跑的实例"认回"而不重复拉起 |
| 桥重启 | `dsh-seq.json` 水位防事件重放；`sessions.json` 启动时剔除磁盘上已不存在的会话映射，避免每秒重开死会话 |
| 会话卡死 | `turn-guard.js` 的静默/总时长看门狗 + `quarantineSession()` 隔离重建 |
| 桥进程重复 | `state/bridge.lock` 单实例锁（PID 校验，崩溃后锁自动失效） |
| DSH settings 漂移 | 保存配置时自愈改写并重启隔离 DSH |
| DSH 会话堆积 | 空闲会话自动归档（§6.4） |
| NapCat 文件缺失 | `napcat-repair.js` 从 `NapCat.Shell.zip` 补齐（§14.3） |
| 应用退出但 NapCat 残留 | 关窗守卫兜底清理（§14.2） |
| SSH 隧道静默失效 | `ensureTunnels()` 每次重建缺失隧道 |
| 配置被半截写入 | 所有配置写入走临时文件 + 备份 + rename；状态 JSON 走 `atomicWriteJson` |
| 桥热加载失效 | 目录监听 + 2 秒轮询双保险（§10.1） |
| token 计量缺口 | DSH 权威计数对账补记（§18.3） |
| 桥与 DSH 的 stdout 断裂 | 实例日志直写 + 桥侧 EPIPE 守卫 |

### 18.5 为什么"看不见的失败"被反复强调

本仓库多处注释记录了同一类事故：**功能静默失效、日志无痕**。典型三例：

1. `toggle` 型开关只在部分路径生效（如 `killOnExit` 必须同时传给守卫，否则打包版里是假开关）；
2. 轮换计数一直在涨却没有执行者（`turn-hold` 与 `rotationDone` 的接线断裂）；
3. 探测型逻辑把额度吃掉（NapCat 登录接口限流）。

因此本项目的一致做法是：**每个提前返回都留日志**、**开关要么全链路生效要么明确标注不生效**、**探测类行为默认不做**（未知就不拦人、宁可跳过不误伤）。

---

## 19. 关键不变量与约束

| # | 不变量 | 保证它的具体代码位置 | 违反后的后果 |
| --- | --- | --- | --- |
| 1 | **绝不动用户本机已安装的正版 QQ** | `napcatManagedDirs()`（只管托管目录 + 运行记录 + 配置手工目录）；`listNapcatProcsInDirs()` / `countNapcatProcs()` 用 `$_.Path -like '<dir>*'` 前缀匹配；`stopInstance()` 同判据；窗口隐藏器的 `shellLower` 前缀比较**额外补目录边界分隔符**（`…\Shell` 不得匹配 `…\ShellOther`），取不到 `Path` 的进程一律跳过；`napcat-guardian.mjs` 的 `--dirs` 为空则什么都不杀；`killNapcatOnExitSync` 首判 `napcatLaunchedThisProcess`；卸载脚本同样只杀安装目录下的进程 | 用户自己的 QQ 被强杀/被隐藏窗口，属不可接受事故 |
| 2 | **桥绝不写桌面端 DSH home** | `lib/dsh-side.js` 的 `isDesktopDshHome()` 与 `resolveDshTarget()` 的 `refusedDesktop` 分支（`win32` 上拒绝 `%APPDATA%\DeepSeek Harness\dsh-home`） | 污染用户日常使用的 DSH 会话与设置 |
| 3 | **绝不用 NapCat 登录接口做健康探测** | 管理端删除了 watchdog/warm/verify 三条轮询路径（相关注释保留）；`core/napcat-guard.js` 删除了探测与自动重启执行体；`localNapcatOffReason()` 闸门让"本机 NapCat 未启用"时连令牌验证都不做 | 把每 IP ~10 次/60 秒的登录额度（与 WebUI 页面共用）吃掉，用户自己扫不了码 |
| 4 | **同一 QQ 号不在两端同时登录** | `startDispatcher()` 内的 `remoteNapcatRunning()` 闸门 + `stopLocalNapcatBeforeRemote()` | 腾讯判"已在另一台终端登录"，两边互踢，表现为"机器人不回复" |
| 5 | **投递只用 `mode:'steer'`** | `prompt-deliver.js` 的投递实现与论证注释 | 用 `queue` 会让消息永久停在 next-turn（回合不结束时模型永远看不到） |
| 6 | **密码/密钥不进 `qq-bridge/config.json`** | `POST /api/bridge/config` 先摘掉 `dsh.apiKey` / `clearApiKey` 再落盘，改由 `iso-credential.js` 写入隔离 home 的凭据文件；本地打包排除表另有 `test-bridge-pack-excludes-config.mjs` 守住 | 明文密钥随配置被同步/打包/复制到目标机 |
| 7 | **DSH 的会话日志只由 DSH 自己写** | `lib/dsh-compaction.js:4-9` 的四条依据；所有压缩都通过 DSH 自己的 surface 插件做 | 撞 `corrupt session log: seq gap` 或校验和失败，会话损坏 |
| 8 | **`next-step` 的事实必须如实回报** | `holdLoop` / `flushStepBatch` 在记"已注入"之前用 `collectMidTurnBatch(st)` 为空来验证 | 谎报成功会让回合静默关闭，用户消息被吞 |
| 9 | **实例就绪以真实探活为准** | `instanceReadiness()`；`startInstanceTracked()` 先探活再决定是否拉起 | 假成功（"已拉起"但端口没起）导致用户点了启动却没有任何反应 |
| 10 | **停止必须校验真的停了** | `stopInstance()` 停止后校验端口不再监听 | "重启了但没反应"（老进程仍占着端口与 `bridge.lock`） |
| 11 | **枚举进程名必须覆盖 `qbm-node.exe`** | `killByCmdline()` 的过滤条件同时含 `node.exe` 与 `qbm-node.exe` | 发布包里兜底清理永不命中，游离老桥占着端口与锁 |
| 12 | **桥不猜会话键** | 唤醒正文的 `[Session]` 行 + 工具层校验（缺 key 直接指回该行） | 工具写错对象（往别的群/人发消息） |
| 13 | **出站正文经唯一出口** | `core/qq-send.js` 的 `onebotSend` + 审计链 + 幂等闸门 | 绕过审计或重复发送 |
| 14 | **部署不覆盖目标机能力** | `buildDeployKeepScript()` 的逐键合并（目标机胜出）+ `state/` 覆盖回来 | 一次代码更新清掉线上 pixiv cookie / 语音 key / 白名单 / 记忆与画像 |
| 15 | **宿主字段与文件路径都能带空格/中文** | PowerShell 参数用单引号字面量转义；`spawn` 传参数组；守卫命令行按需加引号；`RUNTIME_ROOT` 不依赖 cwd | 装到 `D:\我的 程序\MoonBot` 之类路径时启动失败 |
| 16 | **配置热加载不换对象引用** | `applyConfigInPlace()` + 目录监听 + 轮询兜底 | 十几个已注入 cfg 的模块看不到新配置，或被旧 cfg 回写覆盖 |

---

## 20. 待确认与已知不一致

撰写本文时无法在仓库内核实、或代码与注释/文档互相矛盾之处，集中列出：

| 项 | 现状 | 需要澄清的点 |
| --- | --- | --- |
| `server/napcat-webui-auth.js` | 文件已不存在（其"登录接口预算"策略已被"根本不拿登录接口当探测手段"取代） | **已结案（2026-09-25）**：本文按工作树更正（§1）；README 的仓库地图与测试命令清单同日一并更正，并把该模块的历史结论标注为"后续更正"（`README.md` 第 306–307 行） |
| 桥的隔离 home 候选 | `<repo>/../.runtime/dsh-isolated-home`（桥侧默认）与管理器配置的 `dsh-isolated-home-official` 并存 | 实际生效值取决于 `QQB_DSH_HOME` 与管理器配置；两份候选不会自动对齐 |
| `lib/dsh-side.js` 注释里的 `13210` | **已修正（2026-09-25）**：该注释与 `qq-bridge/README{,.en}.md` 均改为 `10721`；实际端口取自 `instances.dshIsolated.port`（目标机 `3080`） | 已结案，见 §2.1 |
| `DEFAULT_LOCAL.dshWeb = 3210` | 该字段语义是**远端** DSH Web 端口（`m.dshWeb ?? 3080`，`server/index.js:194`、`6723`），但模板默认 `3210`（`server/index.js:64`）与前端的 `RP_DEFAULTS.dshWeb = 3080`（`src/pages/SSHConfig.tsx:11`）、部署脚本硬写的 `3080`（`server/deploy.js:1384`）不一致 | **本机** DSH 条目的端口与它无关：`dsh-web` 实例用 `instances.dshIsolated.port`（`server/index.js:2859`），故"本机 DSH 端口不符"的疑虑不成立；真正待定的是"远端未显式配置时隧道会去映射 3210"这一默认值是否要统一为 3080（默认值变更，未擅自改） |
| 窗口隐藏器注释"观察 120 秒" | **已修正（2026-09-25）**：`server/index.js` 两处注释改为"12 小时"（`budgetMs = 43200000`，退出条件交给父进程守卫） | 已结案，见 §14.5 |
| `core/napcat-guard.js` 的 `failThreshold` / `cooldownMs` / `maxHealsPerHour` 等 | 参数保留，但探测与重启执行体已删除 | 是残留契约，还是待重新接线的能力 |
| `core/turn-hold.js` 的 `requestBudgetMs` | 旧文档/注释见过 `maxWaitMs: 120000` 一类取值，实现里是 `maxWaitMs` 默认 60 分钟、`requestBudgetMs` 默认 55 秒 | 以文件当前值为准（§4.3） |
| 打包工程内部装配规则 | 本文只核对了 `build-installer-full.nsi` 与 `moonbot-app/main.js` 的接口事实；`dsh-runtime/` → `dsh/` 的改名、`full\app\` 的生成顺序、electron-builder 变体的目录布局均未逐条核对 | 部署/打包类问题需回打包工程查 |
| 隔离 DSH 凭据文件在 Windows 的 ACL | `chmod 600` 在 Windows 上不生效，实际保护依赖 NTFS 默认 ACL | 未在目标环境实测 |
| `GET /api/config` 的 SSH 密码明文 | 现状如此（仅靠 `127.0.0.1` 绑定收敛暴露面） | 是否纳入脱敏范围需产品决策 |
| MCP 压缩代理的 `--exclude-tools` / `--toonify` 具体参数组合 | 由配置与默认值决定，未逐一验证每种组合的最终命令行 | 需要时以隔离 home 的 `cordis.patch.yml` 实际内容为准 |

