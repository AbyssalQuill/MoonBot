# MoonBot Pro 技术文档

全文分三部分：体系结构与运行期装配、能力构成与实现约束、上下文压缩的数学建模与标定；文末附录为 MCP 工具全表、管理端路由全表、核验清单与术语对照。

术语、证据等级、判定标记与行号约定见「范围、术语与证据等级」章。

## 目录

- [1. 范围、术语与证据等级](#1-范围术语与证据等级)
- [2. 安装布局与路径解析](#2-安装布局与路径解析)
- [3. 进程与模块拓扑](#3-进程与模块拓扑)
- [4. 通信面](#4-通信面)
- [5. 首次启动状态机与鉴权](#5-首次启动状态机与鉴权)
- [6. NapCat 守护与自修复](#6-napcat-守护与自修复)
- [7. 远程克隆部署](#7-远程克隆部署)
- [8. DSH 集成与上下文压缩接口](#8-dsh-集成与上下文压缩接口)
- [9. 打包与分发](#9-打包与分发)
- [10. 可靠性与可观测性](#10-可靠性与可观测性)
- [11. 关键不变量](#11-关键不变量)
- [12. 未核验项与开放问题](#12-未核验项与开放问题)
- [13. 形式模型与闸门序列](#13-形式模型与闸门序列)
- [14. 消息接收与唤醒](#14-消息接收与唤醒)
- [15. 生成、闸门与投递](#15-生成闸门与投递)
- [16. 记忆、检索与学习](#16-记忆检索与学习)
- [17. 人设、角色与表达](#17-人设角色与表达)
- [18. 媒体处理](#18-媒体处理)
- [19. 时间驱动与主动行为](#19-时间驱动与主动行为)
- [20. 社交拓展面](#20-社交拓展面)
- [21. 上下文压缩与令牌预算](#21-上下文压缩与令牌预算)
- [22. 管理端功能面](#22-管理端功能面)
- [23. 部署、开机自动连接与运行维护](#23-部署开机自动连接与运行维护)
- [24. 安全模型与信任边界](#24-安全模型与信任边界)
- [25. 上下文压缩数学建模](#25-上下文压缩数学建模)
- [26. 符号系统、建模假设与事实来源](#26-符号系统建模假设与事实来源)
- [27. 上下文的分块模型与摘要的递归结构](#27-上下文的分块模型与摘要的递归结构)
- [28. 成本模型与压缩触发判据](#28-成本模型与压缩触发判据)
- [29. 出厂值 0.16 的推导与桌面端扫描](#29-出厂值-016-的推导与桌面端扫描)
- [30. 生产样本复算记录（2026-09-25）](#30-生产样本复算记录2026-09-25)
- [31. 增益模型、保真度与阈值的最优性](#31-增益模型保真度与阈值的最优性)
- [32. 多级压缩与递归摘要的累积误差](#32-多级压缩与递归摘要的累积误差)
- [33. 记忆窗口与聊天记录的分离](#33-记忆窗口与聊天记录的分离)
- [34. 复杂度分析](#34-复杂度分析)
- [35. 验证方法与实验口径](#35-验证方法与实验口径)
- [36. 标定边界、适用条件与未核验项](#36-标定边界适用条件与未核验项)
- [37. 速查与复现命令](#37-速查与复现命令)
- [附录 A MCP 工具全表（napcat，91 条）](#附录-A-mcp-工具全表napcat91-条)
- [附录 B MCP 宿主服务与联网检索工具表（7 条）](#附录-B-mcp-宿主服务与联网检索工具表7-条)
- [附录 C 管理端路由表（93 条）](#附录-C-管理端路由表93-条)
- [附录 D 核验范围、缺陷与未核验清单](#附录-D-核验范围缺陷与未核验清单)
- [附录 E 术语与代码符号对照](#附录-E-术语与代码符号对照)

## 1. 范围、术语与证据等级

术语与代码标识符对照：

| 术语 | 代码标识符 / 界定 |
| --- | --- |
| 管理端 | 后端 `server/index.js`，前端 `src/`；编排者进程：进程生命周期、配置读写、探活、日志、SSH 部署、前端静态托管 |
| 桥 | `qq-bridge/src/bridge.js` 及其 `core/`、`lib/`；QQ 平台与 agent 运行时之间的适配层 |
| 隔离 DSH | 独立 `DSH_HOME` 下的 DSH 实例；agent 运行时，不感知 QQ |
| 随包 OneKey 版 NapCat | `napcat-onekey/`；QQ NT 协议转换层，对外提供 OneBot v11 |
| 实例 | `napcat-local` / `dsh-isolated` / `bridge-local`；管理端托管的三个被编排进程 |
| 会话键 | `convKey(kind, id)`，形如 `private:<QQ>`、`group:<群号>` |
| 回合 / 步 | turn（DSH 侧 `turn/start` 至 `turn/end`）/ step（`step/end` 分隔） |
| 唤醒 / 投递 | `scheduleWake(key, reason)` 为一次投递意图；`deliverPromptNow()` 把提示词正文写入 DSH 会话 |
| 在途注入 | `steerIntoRunningTurn()`；回合进行中向 `next-step` 队列追加提示词 |
| 回合保持 | `core/turn-hold.js`；借助 `agent/turn-stopping` 钩子延迟回合关闭 |
| 闸门 / 水位 | 闸门为阻断某条路径的显式判定点（单点登录闸门、幂等闸门）；水位为已处理进度记录（`dsh-seq.json`、`state/token-reconcile.json`），用于幂等与去重 |
| 所有者 | `social.ownerQq`；提示词标记 `[OWNER]` / `[NOT-OWNER]`；权限判据见「安全模型与信任边界」章的信任等级判定 |

术语按下列固定用法：会话（`key`，形如 `group:<群号>` / `private:<QQ号>`）、回合（turn）、步（step）、唤醒（wake）、投递（delivery）、闸门（gate）、水位（watermark）、桥（`qq-bridge` 进程）、管理端（`server/index.js` 与 `src/` 页面）、隔离 DSH（桥自安装的 DSH 实例）、令牌（会话令牌 `x-agent-token`、学习令牌、NapCat accessToken）。

证据等级按下列三级判定，未标注的论断一律视为【未核验】。

| 等级 | 含义 | 必须附带 |
| --- | --- | --- |
| `【已核验】` | 本轮读取源码或执行只读命令后确认 | `path:line` 或命令与输出 |
| `【据仓库记载】` | 引用仓库内其它文档或状态的既有结论 | 文档名或状态文件路径 |
| `【未核验】` | 推断、未复现或仅有间接证据 | 显式声明推断性质 |

判定标记：`恒为 false` 指该判定的输入在现行实现下不可能满足；`fail-closed` 指判定不确定时取拒绝分支；`白名单语义` 指不在名单内的对象不被注册或被拒绝；`后备路径` 指主路径失败后的降级路径。

路径相对仓库根，统一使用正斜杠；代码位置写作 `path/to/file.js:123`，区块写作 `path:lineA-lineB`；行号对应本轮工作树、为取证时刻的读取器行号，重构后可能平移，函数名与文件名是稳定锚点；常量、SQL、JSON 与协议字段均自源文件逐字转录。

范围限于仓库当前提交状态下的桥、隔离 DSH、随包 NapCat、管理器与页面；不覆盖安装副本（`D:\MoonBot\resources\runtime\*`）与仓库源的差异，不做效果评价。压缩算法的数学表述见「上下文压缩数学建模」章。

## 2. 安装布局与路径解析

`RUNTIME_ROOT` 由 `server/index.js` 顶部计算：`dirname(dirname(fileURLToPath(import.meta.url)))`，计算失败时回退 `process.cwd()`（`server/index.js:25-37`）；管理端配置目录由 `join(homedir(), '.qq-bridge-manager')` 给出（`server/index.js:43-47`）。资源路径不得由 `process.cwd()` 推导，这是「安装到任意盘、任意目录名」成立的前提。

```text
<RUNTIME_ROOT>/                       ← 安装根（可位于任意盘、任意目录名）
├─ MoonBot.exe                        ← Electron 壳（由仓库外打包工程产出）
├─ resources/runtime/                 ← 运行时可写树（源码树中即仓库根）
│   ├─ server/                        ← 管理端后端（index.js / deploy.js / *.mjs / *.js）
│   ├─ qq-bridge/                     ← 桥（src/ plugins/ characters/ roles/ state/ config.json）
│   ├─ napcat-onekey/                 ← 随包 NapCat 与 QQ
│   ├─ dsh-runtime/                   ← 随包 DSH CLI（私有 package.json，依赖 @deepseek-ai/dsh）
│   ├─ dist/                          ← 管理端前端构建产物
│   └─ .runtime/dsh-isolated-home/    ← 桥的项目内隔离 home（候选之一）
├─ resources/app/                     ← 壳自身资产（具体文件名未核验）
└─ …
```

资源路径解析（环境变量优先于配置文件）：

- 运行时可写树：`RUNTIME_ROOT`（`server/index.js:25-37`）【已核验】；前端产物 `join(RUNTIME_ROOT, 'dist')` 由静态托管实现
- 管理端配置：`join(homedir(), '.qq-bridge-manager', 'config.json')`（`server/index.js:43-47`）【已核验】；日志在同目录 `logs/`，含 `manager.log`、`napcat-guardian.log` 与各实例日志
- 隔离 home（管理端默认）：`DEFAULT_ISOLATED_HOME = <RUNTIME_ROOT>/.runtime/dsh-isolated-home`，实际取值来自 `instances.dshIsolated.isolatedHome`（`server/index.js:81`）【已核验】；隔离实例端口取 `cfg.instances.dshIsolated.port`，缺省 10721（`server/index.js:585`、`2618`）【已核验】
- 随包 DSH CLI：`instances.dshIsolated.dshCli`，否则 `findDshCli()`，`--port` 取自 `instances.dshIsolated.port`（`startIsolatedDsh()`）
- 桥目录：`findBridgeDir()` 优先 `RUNTIME_ROOT/qq-bridge`；`startBridgeLocal()` 只信自动探测结果，忽略配置中残留的 `workDir`
- 随包 NapCat：`findNapcatOneKeyAll()` 的候选根列表为项目内 → `%LOCALAPPDATA%\Programs\*\resources\runtime` → 用户下载 / 桌面 / 文档（`server/index.js:947-984`）

配置读入时执行一次「路径仍在树内」校验（`inTree()`，位于 `loadConfig()`），指向树外的路径被拒绝。【据仓库记载】

边界情形：

- 更换磁盘或安装目录：`RUNTIME_ROOT` 随程序位置推导；配置中残留的 `launchCommand` / `workDir` 被自动探测结果覆盖（`startBridgeLocal()` 注释）
- 路径含中文或空格：PowerShell 调用使用单引号字面量转义（`q(onekey.dir)`）；`spawn` 传递参数数组；守卫命令行对含空格或引号的参数加引号（`startNapcatHidden()`、`spawnGuardianDetached()`）
- 由资源管理器双击或计划任务启动：工作目录可能为 `C:\Windows\System32`，全部资源路径不依赖工作目录。变更前由 `process.cwd()` 推导资源路径的调用点为 9 处（涉及随包 DSH、`qq-bridge`、`dist`、隔离 home），变更后为 0 处。【据仓库记载】该计数本轮未逐点复现
- 安装目录只读（如 `Program Files`）：守卫硬链接退至 `RUNTIME_ROOT/.guard/`，建链接失败仅记日志，WMI 脱离进程树仍然有效（`spawnGuardianDetached()`，`server/index.js:9884`）【已核验】
- 临时目录不可写：窗口隐藏器无法启动，退回一次性 `hideBundledQqWindows()` 轮询
- 非 Windows 平台：隔离 home 解析中「拒绝桌面端 DSH」分支仅在 `win32` 生效，Linux 上 `/root/.dsh` 为合法目标，NapCat 走官方安装脚本（`qq-bridge/src/lib/dsh-side.js`、`server/index.js` 的 `process.platform !== 'win32'` 分支）
- 多份安装共存：停止与进程清理按全部候选托管目录前缀匹配，不限于首个命中项（`findNapcatOneKeyAll()` 注释、`napcatManagedDirs()`，`server/index.js:2561`）【已核验】

## 3. 进程与模块拓扑

```text
QQ 群 / 私聊 ──QQ 协议──▶ NapCat  WebUI :6099  OneBot HTTP :3000  反向 WS :3001
                          （把 QQ NT 转成 OneBot v11 服务端）
        ──OneBot v11（WebSocket）──▶ qq-bridge  入口 qq-bridge/src/bridge.js  控制台 :3100
              唤醒判定 → 提示词组装 → 会话映射 → DSH 投递 → 事件泵 → 工具调用 → 发送链 → QQ
              三组 MCP server（stdio）：mcp-napcat / mcp-napcat-host / mcp-web-search-safe
        ──DSH HTTP API（session.prompt mode:'steer'）──▶ 隔离 DSH  独立 DSH_HOME  profile=web
              agent preset（qq-chat / default）：[WAKE TYPES] / [RULES] / [TOOLS] / [TOOLS 2b~2e] 等行为规则
              本地插件：dsh-qq-hold（回合保持钩子）、qq-mode-console、dsh-memory（长期记忆 remember/recall）
        ──LLM API──▶ 模型服务商
```

管理端（Electron + React + Express）不位于该数据链上，其角色为编排者：拉起进程、写配置、读日志、执行 SSH 部署。

各层入口、职责与边界（「明确不做」列出越界即构成缺陷的行为）：

| 层 | 入口 | 职责 | 明确不做 |
| --- | --- | --- | --- |
| 管理端前端 | `src/App.tsx`、`src/api.ts`（页面 `src/pages/`，组件 `src/components/`，类型 `src/stores/types.ts`） | 页面切换与后端接口封装 | 不做状态判定（phase 由后端给出） |
| 管理端后端（编排者） | `server/index.js` | HTTP API、实例编排与探活、前端静态托管、安装位置体检（`RUNTIME_ROOT`，`server/index.js:25-31`） | 不位于数据链上，不参与消息处理 |
| 远程部署 | `server/deploy.js` | SSH 克隆部署：打包 → 流式转发 → 目标机解包 → systemd / NapCat 容器 → 启动自检 | 不覆盖目标机已有的用户配置与能力 |
| 关窗守卫 | `server/napcat-guardian.mjs` | 独立进程；壳退出后按托管目录 / 绝对路径 / 端口停止 NapCat / 桥 / 隔离 DSH | 不处理非托管目录下的任何进程 |
| 连接状态机 | `server/connect-machine.js` | 阶段机 `connecting → tunnels → server-starting → warming → ready / failed`；把远端 DSH / NapCat / 桥逐个判定为 ready / starting / down；纯逻辑，界面读 `/api/connect` 或 `/api/state.connect`（零网络） | — |
| 隔离凭据与 NapCat 自修 | `server/iso-credential.js`、`server/napcat-repair.js` | 前者读写隔离 DSH 的 `.credentials.yaml`（本地直写与服务端 HTTP 写盘共用，可单测）；后者检查并补齐 NapCat Shell 目录内缺失的模块文件 | — |
| 桥接层 | `qq-bridge/src/bridge.js` 及 `core/`、`lib/`（工具层为 `qq-bridge/src/mcp-*.js`，三组 MCP server） | 唤醒判定、提示词组装、会话映射、DSH 投递、事件泵、工具调用、发送链、审计、计量、学习 | 不直接访问 QQ 协议；不写 DSH 的会话日志 |
| agent 运行时 | 隔离 DSH（独立 `DSH_HOME`），preset 位于 `qq-bridge/dsh/agent-presets/qq-chat/` | 维护模型回合、工具体、上下文压缩、会话持久化；`preset.yml` / `agent.cordis.yml` 提供行为规则，`qq-tool-restrict.mjs` 限制可用工具 | 不感知 QQ；只接收桥投递的提示词与 MCP 工具 |
| DSH 插件 | `qq-bridge/plugins/dsh-qq-hold/`、`qq-bridge/plugins/qq-mode-console/`、`qq-bridge/plugins/dsh-memory/` | 回合保持、模式控制台、长期记忆 | — |
| 接入层 | `napcat-onekey/`（便携版 NapCat 与 QQ：`NapCat.Shell.zip`、`NapCatInstaller.exe`、`QQ.exe`、`NapCat.44498.Shell/`、`bootmain/`） | 把 QQ NT 转成 OneBot v11 服务端（WebUI 6099 / HTTP 3000 / WS 3001） | 不做唤醒判定、不组装提示词 |

原稿记载的 `server/napcat-webui-auth.js`（「唯一允许调用 `POST /api/auth/login` 的位置」）在工作树中不存在；`server/` 现为 `connect-machine.js`、`deploy.js`、`index.js`、`iso-credential.js`、`napcat-guardian.mjs`、`napcat-repair.js`，该职能由「不使用 NapCat 登录接口作探测手段」策略取代。【已核验】以工作树文件列表核对。

系统边界与交互方式：

| 边界 | 外部对端 | 交互方式 |
| --- | --- | --- |
| 本机安装树（管理端后端、前端产物、`qq-bridge/`、`napcat-onekey/`、`dsh-runtime/`） | — | 全部路径由 `RUNTIME_ROOT` 派生 |
| 用户数据 `%USERPROFILE%\.qq-bridge-manager\`（配置、日志、守卫文件、方案库、隔离 home） | — | 与安装树分离；卸载或换盘不影响 |
| 桥 ↔ QQ 平台 | NapCat（OneBot v11） | WebSocket（反向 WS 3001）+ HTTP 3000 |
| 桥 ↔ agent 运行时 | 隔离 DSH | HTTP `/api/<ns>/<method>` + WebSocket `/api/remote.mux` |
| agent ↔ 模型服务商 | DeepSeek 官方 / 小米 MiMo / 任意 OpenAI 兼容端点 | 由 DSH provider 配置决定，凭据来自 `.credentials.yaml` |
| 管理端 ↔ 目标机 | 远端 Linux 主机（`/root/qq-bridge`、`/root/.dsh`、`/opt/napcat`） | ssh2（命令 + 隧道 + 流式转发） |
| 管理端 ↔ 浏览器前端 | 本机浏览器或内嵌窗口 | HTTP `127.0.0.1:1921`；开发模式经 Vite 5173 代理 |
| 仓库 ↔ 打包工程 | `C:\Users\17367\Desktop\QQ-Bridge-packaging`（不在本仓库） | 打包工程单向消费本仓库产物 |

两侧配置分离，不互相回落：管理端配置为 `%USERPROFILE%\.qq-bridge-manager\config.json`，日志在 `…\.qq-bridge-manager\logs\`（`server/index.js:37-47`）【已核验】；桥配置为 `<运行时>/qq-bridge/config.json`，模板 `qq-bridge/config.example.json`，顶层键（依模板）为 `dsh`、`dshCompaction`、`napcat`、`pixiv`、`ownerQQ`、`guard`、`sessionCwd`、`agentPreset`、`workspaceTitle`、`allow`、`deny`、`allowAllWhenEmpty`、`allowAllPrivate`、`allowAllGroups`、`ackMessage`、`sendDelayMs`、`questionTimeoutMs`、`consolePort`、`consoleToken`、`prompt`、`tokenCost`、`security`、`slang`、`social`。前端缓存按读取目标分键（本机桥配置与服务端桥配置各一份，`src/config-cache.ts`）；将本机条目渲染为服务端条目的后果为配置误判，严重性高于渲染出厂默认值。【据仓库记载】

端口分配（绑定地址与默认值取自实现）：

| 端口 | 服务 | 绑定 | 用途与默认值 | 依据 |
| --- | --- | --- | --- | --- |
| 1921 | 管理端后端 | `127.0.0.1` | HTTP API + 前端静态托管；`QBM_API_PORT` 可覆盖，`QBM_NO_LISTEN=1` 时只导出 app 不监听 | `server/index.js` 的 `app.listen` |
| 5173 | Vite 开发服务器 | `127.0.0.1`（`strictPort`） | 仅开发模式；`/api` 代理到 `http://127.0.0.1:1921` | `vite.config.ts` |
| 6099 | NapCat | 本机 | 官方 WebUI：扫码登录、OneBot 配置（`DEFAULT_LOCAL.napcatWebui`） | `server/index.js:64`【已核验】 |
| 3000 | NapCat | `0.0.0.0` | OneBot HTTP 动作接口（`send_qzone_msg` 等），令牌 `truefriend` | `server/index.js:1223` 附近 |
| 3001 | NapCat | `127.0.0.1` | OneBot 反向 WS 事件推送，令牌 `truefriend`；桥侧默认 `ws://127.0.0.1:3001` | `qq-bridge/src/core/config.js:70`【已核验】 |
| 10721 | 隔离 DSH | 本机 | agent 运行时 API；`dsh.baseUrl` 默认值，亦为 `instances.dshIsolated.port` 缺省值 | `qq-bridge/src/core/config.js:20`、`server/index.js:585`【已核验】 |
| 3100 | 桥 | `127.0.0.1` | 本地控制台（`consolePort`） | `qq-bridge/src/core/config.js:94`、`server/index.js:539`【已核验】 |
| 3210 | 隔离 DSH（`DEFAULT_LOCAL.dshWeb`） | 本机 | 「本机 DSH」默认端口，用于内嵌界面；与 `instances.dshIsolated.port`（10721）为两套取值 | `server/index.js:64`【已核验】 |
| 3080 | 隔离 DSH（目标机） | 目标机 | 远端 `dsh-web.service` 的 `--port 3080`；桥配置改写为 `http://127.0.0.1:3080` | `server/deploy.js:1384-1394`、`1428` |
| 13000 / 13001 / 13080 / 13100 | SSH 本地隧道 | 本机 | 远端 6099 / 3000 / 3080 / 3100 映射到本机回环 | `server/index.js:189-196` 的 `tunnelMapFor()`【已核验】 |

【据仓库记载】测量批次 2026-09-25（对象为 `lib/dsh-side.js` 顶部注释、桥侧两份已并入根 `README.md` 的文档、`server/index.js` 的 `DEFAULT_LOCAL`）：`13210` 为无实现的原记端口，已统一改为 `10721`，实际取值来自 `instances.dshIsolated.port`；远端 DSH Web 端口在 `tunnelMapFor()` 中为 `m.dshWeb ?? 3080`（`server/index.js:194`）【已核验】，`DEFAULT_LOCAL.dshWeb` 模板值为 3210（`server/index.js:64`）【已核验】，前端 `RP_DEFAULTS.dshWeb = 3080` 与部署脚本硬写的 3080 一致，默认值不一致项见「未核验项」；本机 DSH 条目端口取 `instances.dshIsolated.port`（`server/index.js:2859`），与 `DEFAULT_LOCAL.dshWeb` 无关。部署形态差异：`server/deploy.js` 以一段 node 内联脚本把目标机 `/root/qq-bridge/config.json` 的 `dsh.baseUrl` 改写为 `http://127.0.0.1:3080`；目标机隔离 DSH 端口与本机默认端口不同，日志排查时不得混用。

进程清单（Windows 形态）：

| 进程 | 可执行文件 | 启动方 / 父进程 | 关键启动参数 / 环境 | 日志 |
| --- | --- | --- | --- | --- |
| 应用壳 | `MoonBot.exe` | 用户 / `explorer.exe` | Electron 壳；源码不在本仓库 | 无 |
| 管理端后端 | `qbm-node.exe`（随包 Node 运行时） | 应用壳 / `MoonBot.exe` | `server\index.js`；`windowsHide` | `%USERPROFILE%\.qq-bridge-manager\logs\manager.log`（`mlog()`） |
| 隔离 DSH | `qbm-node.exe` | 管理端后端 | `<dshBin> --profile web --port 10721 --no-open --trusted-host 127.0.0.1:10721 --trusted-host localhost:10721`；`DSH_HOME=<isolatedHome>`；另注入 `.credentials.yaml` 派生的环境变量；直接运行 `bin.js` 时附加 `--expose-internals` | `instanceLogPath('dsh-isolated')` |
| 桥 | `qbm-node.exe` | 管理端后端 | `node src/bridge.js`；`cwd =` 桥目录；`DSH_ISOLATED_LOG_FILE=<隔离 DSH 实例日志>` | 实例日志 + `qq-bridge/state/bridge.log` |
| NapCat 启动器 → NapCat / QQ | `WindowsPowerShell\v1.0\powershell.exe` → `NapCatWinBootMain.exe` → `QQ.exe` | 管理端后端；启动器通常毫秒级退出，QQ 被重新挂到系统进程下 | `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -FilePath NapCatWinBootMain.exe -WorkingDirectory <onekey.dir> [-ArgumentList <QQ号>] -WindowStyle Hidden"`；仅托管目录内的实例 | 实例日志 |
| 窗口隐藏器 | `powershell.exe -File <temp>.ps1` | 管理端后端 | 常驻；200 ms 轮询；12 小时预算；父进程存活守卫 | 实例日志 |
| 关窗守卫 | `guard-node.exe`（`qbm-node.exe` 的硬链接） | 管理端后端；父进程 `WmiPrvSE.exe`（由 WMI 创建） | `napcat-guardian.mjs --parent <appPid> --guard-file <...> --dirs <JSON> --dsh-port <n> --bridge-script <abs> --kill-napcat <0\|1> --log <file>` | `%USERPROFILE%\.qq-bridge-manager\logs\napcat-guardian.log` |

【据仓库记载】进程名与进程树脱离的测量（批次 2026-09，样本为发布包运行现场 `qbm-node.exe` 与开发机 `node.exe`）：按命令行关键字清理时按进程名筛选取交集，仅匹配 `node.exe` 时命中数为 0，管理器重启后「停止桥」返回成功而原桥仍占用 3100 与 `state/bridge.lock`，实现改为同时覆盖两种进程名（`killByCmdline()`，`server/index.js:2552`）【已核验】；壳的退出清理按 `$_.Path -eq '<runtime>\qbm-node.exe'` 精确匹配，使用同盘硬链接 `guard-node.exe` 改变可执行文件路径后匹配失败，守卫未被壳清理；壳使用 `taskkill /T` 按父链枚举子进程，而 WMI 创建的守卫父进程为 `WmiPrvSE.exe`、不在子进程链内（`spawnGuardianDetached()`，`server/index.js:9884`）【已核验】；创建无窗口进程时 `Win32_ProcessStartup.ShowWindow = 0` 可用，`CreateFlags = CREATE_NO_WINDOW` 使 `Win32_Process.Create` 返回 21（InvalidParameter），退回普通 `Create` 会额外产生控制台窗口，实现采用前者。

NapCat 的隐藏启动路径为单一实现：PowerShell `Start-Process -WindowStyle Hidden`（`startNapcatHidden()`，`server/index.js:1291-1310`）。被跟踪的 powershell 子进程本身毫秒级退出，因此 NapCat 的存活判据不读取 `exitCode`，而取「托管目录下是否仍存在 NapCat / QQ 进程」（`countNapcatProcs(napcatManagedDirs(rt))`）。【据仓库记载】

启动顺序与就绪判据：实例共三个（`napcat-local`、`dsh-isolated`、`bridge-local`），`keyOf()` 把 id 映射到 `instances.napcatLocal / dshIsolated / bridgeLocal`（`server/index.js:3208`）【已核验】；依赖顺序为 NapCat（QQ 网关）→ 隔离 DSH（agent 运行时）→ 桥。三条启动入口：单实例卡片 `POST /api/instance/:id/:action`（`start` / `stop` / `restart`）立即返回 `starting`、后台轮询推进；`POST /api/instance/start-all` 按依赖顺序逐个 `waitInstanceReady`、每步就绪后才进入下一步；`scheduleAutoStart()` 只恢复 `instances.<key>.enabled === true` 且未被 `instances.<key>.autoStartOnBoot === false` 排除的实例，逐个间隔 1200 ms，不等待就绪。状态机（phase）为 `idle → starting → running`，异常进入 `failed`；`stopping` 是 `stop` / `restart` 的过渡态。

就绪判据取自端口或 HTTP 应答，不采用「已发起 spawn」作为就绪证据（`instanceReadiness()`，`server/index.js:2729`）【已核验】：

| 实例 | ready 判据 | 附加 note |
| --- | --- | --- |
| `dsh-isolated` | `GET http://127.0.0.1:<port>/` 可达（401 与 200 均计入存活） | 端口已监听但尚未解析到 token → 「已监听，等待就绪」 |
| `napcat-local` | WebUI 端口处于监听 | 3000 / 3001 任一处于监听才计入「已登录」，否则提示「WebUI 已起，等待 QQ 扫码登录」 |
| `bridge-local` | `GET http://127.0.0.1:<port>/` 可达 | 等待桥监听端口 |

启动预算为「从拉起到可对外服务」的耗时上限，超出即判失败（`startupBudgetMs()`，`server/index.js:2676`）【已核验】：`dsh-isolated` 90 000 ms（`server/index.js:2677`）、`napcat-local` 120 000 ms（`server/index.js:2678`）、`bridge-local` 45 000 ms（`server/index.js:2679`）。

失败信息取自实例日志尾部：`readFailureReason()` 用 `FAIL_PAT` 正则筛出最接近原因的两行，写入 `phase.error`；进程中途消失（NapCat 除外）或超时同样归入该字段。已在运行的实例被认回而非重复拉起：`startInstanceTracked()` 先探活，命中则置 `running` 并标记 `adopted`；NapCat 必须走该路径，重复启动会挤出已扫码登录的实例。【据仓库记载】

退出与清理分四级，前一级失败由后一级承担：

| 级 | 执行方 | 行为 | 关键判据 |
| --- | --- | --- | --- |
| 1 | 应用侧 | 壳在关窗前调用 `POST /api/shutdown`；默认只收 NapCat，带 `{all:true}` 时一并收桥与隔离 DSH | `killOnExit` 关闭时 NapCat 完全不被处理，响应以 `napcatSkipped` 告知本次为有意跳过（`killOnExitEnabled()` 默认 `true`，对应 `instances.napcatLocal.killOnExit`） |
| 2 | 壳进程树 | `taskkill /pid <后端> /T /F`，再按可执行文件路径清理残留 `qbm-node.exe` | 可执行文件路径精确匹配 |
| 3 | 管理端后端退出钩子 | 按 `napcatSpawnedPids` / `napcatLaunchedThisProcess` 判断本次运行是否由本进程拉起，仅当为真才终止 | 标记为假时不处理任何 NapCat 进程（`server/index.js:2301-2441`）【已核验】 |
| 4 | 关窗守卫 | 独立进程（不在应用进程树内）：轮询间隔 2000 ms；父进程消失后等待 `graceMs`（默认 30 000 ms，命令行 `--grace` 可改，早期值为 6 000 ms），随后重新读取 guard 文件确认归属，再依次清理 NapCat → 桥 → 隔离 DSH | `--dirs` 为空时不终止任何进程；`server/napcat-guardian.mjs:52` 给出 `graceMs` 缺省值 30000【已核验】 |

第 4 级的清理判据为精确匹配：托管目录前缀（`--dirs`）、桥的绝对路径（`--bridge-script`）、DSH 端口（`--dsh-port`），并排除自身（`NOT_SELF`）；缺少参数时跳过对应清理，取舍为宁可漏收不可误杀。【据仓库记载】

关窗守卫的武装条件（复查由启动时一次与每 60 秒一次的 `setInterval` 共同驱动）：`QBM_NAPCAT_GUARDIAN=0` 时整体关闭（`ensureGuardianArmed()`）；guard 文件记载的守卫进程存活时不执行任何操作；本后端父进程名为 `MoonBot` 时以该进程为监护目标（`parentProcessName()`）；否则存在运行中的 `MoonBot.exe` 时以该进程为监护目标（`findMoonBotPid()`），应用复用已在运行的后端时该条件在 60 秒内补齐守卫；应用未运行则静默等待、不武装，不使用来源不明的 PID 作为应用标识；`POST /api/guardian/arm` 手工武装时取 `body.parentPid`，或自动选取首个 `MoonBot` 进程，进程名非 `MoonBot` 一律拒绝（`server/index.js:2999`）【已核验】。

单点登录互斥：同一 QQ 号不能同时在本机与服务端两个端点登录，平台判定为「已在另一台终端登录」并互相下线，表现为该号不再产生回复；管理端后端因此在 `startDispatcher()` 内设置与该前端无关的硬闸门，探测复用既有 `remoteStatusCache`，缓存未命中时增加一次 SSH 往返。服务端 NapCat 在线时启动本机 NapCat 会被拒绝并返回可读原因（`DUAL_LOGIN_HINT`，`server/index.js:3189`）【已核验】；启动或重启服务端 NapCat 前先停止本机 NapCat（服务端为生产端点，`stopLocalNapcatBeforeRemote()`，`server/index.js:3177`）【已核验】；状态不可获取时按 `known:false` 处理，不阻断操作。

桥控制台鉴权只在 `config.consoleToken` 合法时启用（`qq-bridge/src/core/console-server.js:540-546`）【据仓库记载】；现场 `qq-bridge/config.json` 的 `consoleToken` 为空，即本机 `3100` 不启用令牌鉴权，访问控制仅依赖 `127.0.0.1` 绑定【已核验】。

### 依赖方向与模块层

数据流为单向三段：OneBot 事件 → 桥 → 隔离 DSH → 模型；模型产出经工具调用回到桥，再由桥经 OneBot 出站。桥同时是 OneBot 客户端与 DSH 客户端，两个方向均不依赖管理端；管理端只作为桥控制台与桥配置的代理方，不参与消息链路【已核验】（`server/index.js:7382` `proxyToBridgeConsole`）。模块层依赖：入口 `qq-bridge/src/bridge.js`、`qq-bridge/src/mcp-*.js` 依赖 `core/` 与 `lib/`；`qq-bridge/src/core/` 依赖 `lib/` 与 `src/` 顶层模块；`qq-bridge/src/lib/` 仅依赖 Node 内置模块与第三方包；`src/` 依赖 `server/` 的 HTTP 接口。

### 进程间协议

- OneBot v11 反向/正向 WS：事件回调与 API 调用，鉴权用 query `access_token=` 与握手头 `Authorization: Bearer` 双携带（`qq-bridge/src/lib/onebot-ws.js:136/144`）；`OUTBOX_MAX = 200`（`:28`）、WS 发送超时 `20000`（`:27`）、连接超时 `15000`（`:26`）、`RECONNECT_BASE_MS`/上限 `1500`/`10000`（`:10/15`）、`HEARTBEAT_WATCHDOG_MS = 45000`（`:22`）。
- OneBot HTTP：`POST <httpUrl>/<action>`，头 `authorization: Bearer <accessToken>`（`qq-bridge/src/core/qq-send.js`、`qq-bridge/src/core/console-server.js:3986` 等）。
- DSH RPC：`POST /api/<ns>/<m>`，体 `{type:'client-request', rpcId, method, payload:{args}}`（`qq-bridge/src/dsh-client.js:225-245`）。
- DSH 事件：WebSocket（`remote.mux`），逐会话 `session/follow`，`maxMessages: 200`（`qq-bridge/src/dsh-client.js:399`）。
- MCP：stdio，三个 server `mcp-napcat`、`mcp-napcat-host`、`mcp-web-search-safe`（`qq-bridge/src/lib/dsh-side.js:252-299`）。
- 桥控制台 REST：`/api/social/*`、`/api/send/*`、`/api/images/*` 等分组（`qq-bridge/src/core/console-server.js`）；SSE `GET /api/napcat/login-stream`，事件名 `napcat-login`（`:5594-5605`、`:6108-6189`）【据仓库记载】。
- 进程内状态文件：JSON / JSONL / SQLite，写入使用临时文件加原子重命名（`qq-bridge/src/core/config.js:448-452`）。

以上未标注者均【已核验】。

### MCP 服务器规模

`mcp-napcat`（`qq-bridge/src/mcp-napcat-safe.js`）注册 91 个工具，`^\s*registerTool\(` 调用点共 91 处、名字互不重复，含 1 个 `get_time`；`mcp-napcat-host`（`qq-bridge/src/mcp-host-server.js`）5 个（`server.tool(` 位于 `:142/198/247/264/314`）；`mcp-web-search-safe`（`qq-bridge/src/mcp-web-search-safe.js`）2 个，`web_search` 注册于 `:943`（名字 `:944`）、`web_fetch` 注册于 `:979`（名字 `:980`）【已核验】。运行时实际注册数还受档位闸门 `toolAllowedByTier`（`qq-bridge/src/mcp-napcat-safe.js:741`）与各工具的 `cfg.social.*` 开关分支影响【已核验】。

## 4. 通信面

管理端后端 `server/index.js` 含 93 条 `app.get/post/put/delete` 路由（含 `:param` 形式）【已核验】：

```bash
node -e "const s=require('fs').readFileSync('server/index.js','utf8');console.log((s.match(/app\.(get|post|put|delete)\(\s*'/g)||[]).length)"
```

- 配置、状态与生命周期：`GET/POST /api/config`（读配置 / 深合并 + 原子写）、`GET /api/state`（总状态：实例 phase、探活、连接模式、远端三件套、配置摘要；前端 1.2~4 秒轮询）、`GET /api/connect`（连接状态机快照，零网络）、`GET /api/open`（解析「打开官方界面」目标 URL，`scope=local|remote`，服务端在线时把本机 NapCat 请求落到远端隧道）、`POST /api/shutdown`、`POST /api/guardian/arm`
- 实例编排：`POST /api/instance/:id/:action`（`id ∈ {dsh-isolated, napcat-local, bridge-local}`）、`POST /api/instance/start-all`、`GET /api/instance/:id/logs`（读日志尾部，UTF-8 解码失败时退 GBK）
- SSH 与服务端：`/api/ssh/test`、`/connect`（建立连接与四条隧道）、`/disconnect`、`/status`（连接与服务端 DSH / NapCat / 桥状态）、`/sync`、`/stack`（整套启停，含 NapCat 容器起停顺序）、`/service`、`/remove-stack`、`GET/POST /api/ssh/bridge-config`（读写服务端 `/root/qq-bridge/config.json`）、`/deploy/start`、`/deploy/status`（步骤、当前步、日志行）、`/deploy/tasks`（任务台账）
- 桥能力代理 `/api/bridge/*`（转发到桥控制台，鉴权头由代理注入）：`config`（POST 摘出 `dsh.apiKey` 写入隔离 DSH 凭据文件并按需重启隔离 DSH）、`owner-qq`（首次运行引导项）、`speech-reset`、`characters` 与 `characters/import`、`chat-convs` / `chat-messages` / `chat-stats` / `chat-delete`、`memory-stats`、`tool-schema-stats` / `context-overhead`、`activity-hours`、`activity-targets`、`upload` / `stickers/upload`、`meme-packs` 与 `meme-packs/upload|delete|bind`
- 其余分组：学习与画像 `/api/learning/*`（含 SSE 的 `token-stream`）、NapCat `/api/napcat/*`（`launchers`、`install-qq`、`tokens`、`webui-ready`、`qr`、`login-stream`、`guard`、`guard/heal`、`quick-password`）、语音 `/api/voice/*`、黑话批量 `/api/slang/*`（`batch-confirm` / `batch-delete` / `batch-reject` / `research`）、配置方案 `/api/profiles`（GET 列表，POST 保存时参数完全相同则复用，POST `/api/profiles/:id/delete`）

SSE 事件流：三个端点均为 `text/event-stream`，由管理端后端以 `x-console-token` 头代理到桥控制台，`index.html` 单独携带 `Cache-Control: no-store`；`GET /api/bridge/chat-stream`（聊天与回合实时流）、`GET /api/learning/token-stream`（token 用量实时流）、`GET /api/napcat/login-stream`（QQ 登录状态流）。【已核验】检索 `server/index.js` 全文：SSE 端点 3 个，另有 2 处为向上游发起 SSE 请求时设置的 `Accept` 头；`WebSocketServer` / `app.ws` / `upgrade` 计数为 0，「websocketServers」的 5 次出现全部位于 NapCat OneBot 配置注入片段；实时面走 SSE，状态面走轮询。

桥控制台面：`qq-bridge/src/core/console-server.js` 监听 `consolePort`（默认 3100，绑定 `127.0.0.1`）。以 `url.pathname === '/api/...'` 形式的字面量比较统计，工作树中为 159 处比较、去重后 136 个路径；另有以 `startsWith` 匹配的前缀族（如 `/api/stickers/`），故可路由端点总数不少于 136。【已核验】

```bash
node -e "const s=require('fs').readFileSync('qq-bridge/src/core/console-server.js','utf8');const m=[...s.matchAll(/url\.pathname\s*===\s*'(\/api\/[^']*)'/g)].map(x=>x[1]);console.log('比较',m.length,'唯一',new Set(m).size)"
```

端点分组（代表端点，非完整枚举）：状态与鉴权族（`/api/status`、`/api/console/token`、`/api/security`、`/api/profile`、`/api/authorize/read`）；发送与回合族（`/api/send/*`、`/api/test-send`、`/api/qq/turn-hold`、`/api/social/current-turn`、`/api/social/wait`、`/api/session/reset`、`/api/workspace/reset`、`/api/restart`）；社交与唤醒族（`/api/social/config`、`/wake`、`/wake-config`、`/state`、`/states`、`/targets`、`/deepsleep`、`/schedule*`、`/proactive-send`、`/activity*`）；记忆、聊天记录与媒体族（`/api/social/memory*`、`/memory-stats`、`/chat-convs`、`/chat-messages`、`/chat-stats`、`/chat-delete`、`/chat-reindex`、`/history-*`、`/recent`、`/unread`、`/mark-read`、`/send-*`、`/sticker-*`、`/collect-sticker`、`/api/stickers*`、`/api/images/*`）；语音、学习与用量族（`/api/voice/config|voices|preview|test|send|transcribe`、`/api/learning-config`、`/api/learning/*`、`/api/slang*`、`/api/token-report`、`/api/token-stream`、`/api/token-reconcile`）；角色与权限族（`/api/role`、`/api/roles`、`/api/roles/create`、`/api/role-mode`、`/api/persona/switch`、`/api/whitelist`、`/api/blacklist`）；NapCat 与监控族（`/api/napcat/guard|guard/heal|qr|login-stream|tokens|quick-password`、`/api/social/tool-log`、`/api/social/tool-log/clear`、`/api/social/global-overview`、`/api/social/tunables`、`/api/pending`、`/api/social/feedback`）。

鉴权：控制台端点要求 `x-console-token` 头或 `?token=` 查询参数，首页探活 `GET /` 免鉴权；默认按本机可信处理，不自动生成令牌，不写 `state/console-token`；MCP 工具侧回调控制台时同样携带该头。【据仓库记载】

桥与 NapCat 通道（OneBot v11，桥侧 URL 与令牌来自 `config.json` 的 `napcat.wsUrl` / `accessToken`）：

| 方向 | 通道 | 说明 |
| --- | --- | --- |
| NapCat → 桥 | 反向 WebSocket `ws://127.0.0.1:3001` | 事件推送（消息、通知、撤回） |
| 桥 → NapCat | HTTP 动作接口 `http://127.0.0.1:3000` | 发送消息、群管理、QQ 空间、点赞 |
| 管理端 → NapCat | WebUI `http://127.0.0.1:6099` | 扫码登录与 OneBot 网络配置的界面入口（`/api/open` 给出 URL） |

出厂 OneBot 网络配置由 `ensureNapcatOnebotConfig()` 在 NapCat 启动后注入：HTTP 3000 绑定 `0.0.0.0`、WS 3001 绑定 `127.0.0.1`，令牌 `truefriend`。写入不改变 NapCat 的内存状态，因此可随时补写；令牌变更需重启 NapCat 才生效，文件已存在时以文件内容为准。【据仓库记载】

桥与隔离 DSH 通道（协议为官方 0.1.2 起，写于 `qq-bridge/src/dsh-client.js` 文件头）：一元 RPC 为 `POST /api/<namespace>/<method>`，body 为方法参数，旧式点号端点 `/api/session.list` 已移除；流式事件经 WebSocket `/api/remote.mux`，上行 `{type:'open', streamId, endpoint, payload:{args}}`；审批与提问应答为 `POST /api/$events/result`，`{args:{clientId, eventId, outcome:{kind:'result', value}}}`；鉴权使用启动时打印的 `?token=`，客户端先 `GET /?token=xxx` 换取 `dsh-auth-*` cookie（303 + `Set-Cookie`），此后 `/api` 与 WebSocket 均携带 cookie，无 token 的环境免鉴权。

桥侧使用的 DSH 调用：`sessions.prompt({sessionId, mode, content})` 用于提示词投递（`qq-bridge/src/core/prompt-deliver.js`）；`session/selectModel`、`session/modelCatalog` 用于模型选择与目录读取；`workspace/archiveSession` 用于空闲会话归档；`events.mux` + `session/follow` 为事件泵与回合订阅（`qq-bridge/src/core/mux.js:766`）【已核验】。

管理端与浏览器前端：生产模式下前端产物由 `127.0.0.1:1921` 静态托管、`/api/*` 同源直取，开发模式下 Vite 运行于 5173 并把 `/api` 代理到 1921（`vite.config.ts`）；`src/App.tsx` 对 `/api/state` 轮询，过渡期 1 200 ms、稳态 4 000 ms，预热窗 20 秒，ESC 返回首页；`src/config-cache.ts` 为两级缓存（模块内存 + `localStorage`，键 `moonbot.cfgcache.v1.<scope>::<key>`），页面挂载先用真实缓存渲染，无缓存时不使用出厂默认值替代（渲染空值并禁用，等待回包）；`src/pages/WebView.tsx` 以内嵌窗口打开 NapCat WebUI、DSH Web、桥控制台，`iframeBlocked` / `iframeBlockReason` 由后端在 `/api/open` 给出。

管理端与目标机（隧道映射由 `tunnelMapFor()` 生成）：`ssh2` 命令执行用于探测、安装、systemd 操作与自检；本地监听隧道为 13000 → NapCat WebUI、13001 → OneBot HTTP、13080 → DSH Web、13100 → 桥控制台；流式转发使打包产物不落目标机中间文件，直接写入解包命令的标准输入（`streamPipe`）；`ensureTunnels()` 每次检查四条隧道是否处于监听，缺失即重建。【据仓库记载】原稿记录时点曾出现「SSH 连接返回 `connected=true` 而四条隧道均未监听」的状态，对端转发不可用，实现因而改为每次检查后重建缺失隧道；本轮未复现该状态。

## 5. 首次启动状态机与鉴权

管理端首次启动（进入条件为布尔判据，出口为该状态的唯一清除方式）：

| 状态 | 进入条件 | 系统行为 | 出口 |
| --- | --- | --- | --- |
| 配置缺失 | `~/.qq-bridge-manager/config.json` 不存在 | `loadConfig()` 落 `DEFAULT_CONFIG`：`instances.dshIsolated{port:10721, profile:'web'}`、`instances.napcatLocal{webuiPort:6099, webuiToken:'truefriend', killOnExit:true}`、`instances.bridgeLocal{webuiPort:3100}`、`autoStartOnBoot:true`、`local` 端口表、默认 provider `deepseek-official`、默认 model `deepseek-v4-flash-vision-exp` | 首次保存后进入「已配置」 |
| 所有者标识未设置 | `ownerQQ` 为空 | 前端弹出首次运行引导（`getOwnerQQ` / `setOwnerQQ` → `/api/bridge/owner-qq`） | 写入所有者 QQ |
| NapCat 未就位 | `findNapcatOneKeyAll()` 未命中托管目录 | `/api/napcat/launchers` 列出候选；`/api/napcat/install-qq` 触发安装或解压 | 命中后 `napcat-local` 卡片可启动 |
| 实例未启动 | `instances.<key>.enabled !== true` | 首页三张卡片显示「未启动」；`scheduleAutoStart()` 不恢复该实例 | 用户触发启动或启动整套 |
| 就绪 | 端口或 HTTP 探活通过 | phase = `running`，卡片出现「打开」 | — |

隔离 DSH 首次启动按序执行四步：（1）`startIsolatedDsh()` 先执行 profile 自愈（`healProfile()`），建立 `profiles/<profile>/`（`cordis.yml` + `package.json`），必要时以 junction 从随包 dsh 发行面补齐 `node_modules`，把 `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` 写入 bundles 与 dependencies——缺少该步骤时 `qq-mode-console`（inject settings）与三组 `mcp-client`（inject tools）永久处于 pending，隔离 DSH 无法启动；（2）以 `--profile web --port <port> --no-open --trusted-host …` 拉起，最多等待 60 秒探测端口；（3）端口可用后判断引导标记 `<DSH_HOME>/qqbridge-setup.done`，标记不存在则执行 `qq-bridge/scripts/setup-dsh.mjs --home <home> --profile <profile> --force`（注入 agent-presets 与 MCP 配置），成功后写入标记，并终止当前 DSH 后自动重启一次；（4）标记已存在时仅进入在线状态，不重启。

NapCat 首次启动按序执行四步：（1）启动前预置 `webui.json`，文件不存在且读不到实际令牌时写入 `{ token: <配置值>, loginRate: 10 }`，文件已存在时以文件为准、不回写配置值；（2）注入出厂 OneBot 网络配置（HTTP 3000 / WS 3001，令牌 `truefriend`）；（3）以 `Start-Process -WindowStyle Hidden` 拉起 `NapCatWinBootMain.exe`，带快速登录参数时附加 QQ 号；（4）就绪判据为 WebUI 端口处于监听 = 已启动、3000 或 3001 任一处于监听 = 已登录，未登录时卡片提示等待扫码，二维码经 `/api/napcat/qr` 与 `/api/napcat/login-stream`（SSE）呈现。

桥首次启动：`acquireLock()` 抢占 `state/bridge.lock`（以 `wx` 原子写入 PID，`qq-bridge/src/core/runtime.js:8`）【已核验】，已有实例存活则 `exit 2`；随后连接 OneBot WS、装载 `initXxxCore(cfg)`、异步执行 DSH 端自安装、按 `dsh-seq.json` 水位恢复事件流。【据仓库记载】

凭据面、存放与校验方：

| 面 | 凭据与存放 | 校验方 | 生命周期与约束 |
| --- | --- | --- | --- |
| QQ 登录 | 登录票据（扫码或快速登录取得），落盘为 `napcat_<QQ>.json` 等；容器形态位于卷 `napcat-qq:/app/.config/QQ` | 平台 | 桥每次启动备份到 `<配置目录>/login-backup/<时间>`，只保留最近若干份；容器 `restart` 必须使用 `-t 30`，`stop` 默认 10 秒会强制终止票据持有进程，恢复后需重新扫码 |
| NapCat WebUI | `webui.json` 的 `token` | NapCat 进程内存 | 单向：仅在文件不存在时预置一次，文件存在即以其为准。运行期只使用启动时读入内存的值，改文件而不重启会导致 `token is invalid`，页面全部接口返回 `Unauthorized` |
| OneBot HTTP / WS | `onebot11*.json` 的 `network.httpServers[].token` / `websocketServers[].token` | NapCat | 出厂注入值为 `truefriend`；改配置后必须重启 NapCat 才生效 |
| 隔离 DSH Web / API | 每次启动打印的 `?token=`，位于 DSH 实例日志 | DSH | 先 `GET /?token=` 换取 `dsh-auth-*` cookie（303 + `Set-Cookie`），此后 `/api` 与 WebSocket 均携带 cookie；token 轮换或换取失败导致的 401 会强制更换 cookie 后只重试一次 |
| 隔离 DSH 模型密钥 | `KEY: value`（`refs:` 块），位于 `<DSH_HOME>/.credentials.yaml`（mode 600，另有 `.bak-<ts>` 备份） | DSH provider 的 `apiKeyEnv` | 由管理端从 `config.json` 摘出 `dsh.apiKey` 后写入 |
| 桥控制台 | `x-console-token` 头或 `?token=`，来自配置项 `consoleToken` | 桥 | 不自动生成，不写 `state/console-token`；默认本机可信；`GET /` 探活免鉴权 |
| 会话令牌（agent token） | 等于群号或 QQ 号，位于唤醒正文 `[Token]` 行 | 桥 | 可预测，仅解锁会话级端点；不得作为密钥使用 |
| 学习会话令牌 | 32 位十六进制，位于 `state/learning-token` | 桥 | 不可预测、跨重启稳定，仅解锁 `/api/learning/submit-persona`；不并入 `KNOWN_AGENT_TOKENS`，以避免权限扩张 |
| 管理端 HTTP API 与 SSH | 管理端 API 无应用层鉴权，仅绑定 `127.0.0.1`，任何可访问本机回环的进程均可调用；SSH 使用私钥（`authType: 'key'`）或密码（`authType: 'password'`），位于管理端 `config.json` 的 `servers[]` | 目标机 sshd | 密码以明文存储并明文返回；PAM 仅支持 `keyboard-interactive` 时走交互式应答分支 |

隔离 DSH 模型密钥的写入链（步骤 5 为失败关闭判定点）：（1）`POST /api/bridge/config` 先把 `body.config.dsh.apiKey` 与 `clearApiKey` 从待落盘对象中移除，明文密钥不进入 `qq-bridge/config.json`（该文件参与同步与打包）；（2）目标环境变量名按三级解析（`providerApiKeyEnv()`）：隔离 DSH `settings.yaml` 的 `providers.<id>.apiKeyEnv` → 已知服务商别名表（`deepseek-official` / `deepseek` → `DEEPSEEK_API_KEY`；`xiaomi-token-plan-cn` → `XIAOMI_TOKEN_PLAN_CN_API_KEY`；`mimo` → `MIMO_API_KEY`）→ 按 id 推导 `<ID>_API_KEY`；（3）改写逻辑位于 `server/iso-credential.js`（本地直写与服务端写盘共用，可单测），定位 `refs:` 块（缩进感知）、按 YAML 标量规则加引号（`YAML_NON_STRING_WORDS` / `YAML_NUMBERISH` / `YAML_RADIX`），写前备份、写后 `chmod 600`；（4）格式自检（`validateCredentialDocument()`，`server/iso-credential.js:140`）【已核验】要求必须含 `version`、顶层键只能是 `{version, refs, records}`、`refs` 值不得为空，DSH 对扁平布局与未知顶层键直接拒绝；（5）仅当 `.credentials.yaml` 已存在（隔离 DSH 至少成功启动过一次）才允许写入，文件缺失时失败关闭并提示先启动一次隔离 DSH；（6）同一路由执行模型漂移自愈：每次保存以期望的 `provider` / `model` / `reasoningEffort` 核对隔离 DSH 的 `settings.yaml`，不一致则改写并后台重启隔离 DSH，仅当 `body.config` 存在时触发，避免无关保存触发重启。

脱敏策略：凭据状态查询只返回 `{env, from, set, len}`，不返回值（`isoCredentialStatus()`）；保存响应返回脱敏后的 config（`dsh.apiKey` 置空）与 `apiKeyWrite` 的 `{ok, env, action, backup}`；NapCat 令牌展示走 `maskNapcatToken()`（空值 → `''`；长度 ≤ 4 → `****`；否则首 2 位 + `****` + 末 2 位，`server/index.js:7670`）；令牌与密钥不落 `manager.log`，只记录写入的环境变量名与备份路径；目标机 `buildTargetDshHealScript()` 把 `.credentials.yaml` 权限从 666 修正为 600（DSH 拒绝加载对属主以外可读的凭据文件，报 `readable beyond its owner (mode 666)`）；本地打包路径排除 `state/bridge.lock`、`state/*.log`、`*.bak*` 等运行痕迹，`packLocalBridge` 的排除表由 `tools/test-bridge-pack-excludes-config.mjs` 守住「代码包不覆盖远端 `config.json`」。

现存明文与未生效保护项：`GET /api/config` 原样返回整份配置，其中含 `servers[].password` 与 `servers[].passphrase` 的明文，前端输入框为 `type="password"` 但存储与传输仍为明文，收敛手段仅为后端绑定 `127.0.0.1`；Windows 上管理端写入 `.credentials.yaml` 后调用 `chmod 600`，该调用不改变 ACL，实际保护依赖 NTFS 默认 ACL。【未核验】未在目标环境实测该文件的 ACL。

## 6. NapCat 守护与自修复

管理端进程内监护：启动登记以 `napcatLaunchedThisProcess` / `napcatSpawnedPids` 记录本次运行中由本进程拉起的 NapCat，是全部退出清理的前置判据；启动前以 `listNapcatProcsInDirs()` 的 `beforePids` 做差集，避免把尚未退出的上一份进程计入本次启动（`collectNapcatPidsAfterLaunch()`）；`killNapcatOnExitSync()` 等退出路径的首个判断即 `napcatLaunchedThisProcess`，为假时不处理任何 NapCat 进程；开关为 `killOnExitEnabled()`（`instances.napcatLocal.killOnExit`，默认 `true`），关闭后 `/api/shutdown` 不收 NapCat、响应返回 `napcatSkipped: true`，该开关同时以 `--kill-napcat 0/1` 传给守卫——打包版关窗走壳的 `taskkill /F`，本进程不执行任何代码，守卫是该路径上唯一可执行「收或不收」的组件；`stopInstance()` 在停止后校验端口是否真的不再监听，早期实现无条件返回 `success:true`，与进程名过滤缺口叠加后表现为「重启了但无响应」；后备终止由 `killByCmdline(marker)`（`server/index.js:2552`）【已核验】按命令行关键字覆盖两种进程名。

关窗守卫为独立进程，不在应用进程树内（脱离手段见进程拓扑节），参数 `--parent`、`--guard-file`、`--dirs`、`--dsh-port`、`--bridge-script`、`--kill-napcat`、`--grace`、`--log` 由 `armNapcatGuardian()` 组装。轮询每 2 000 ms 检查父进程存活，存活时不执行任何操作；父进程消失后等待 `graceMs`（默认 30 000 ms，早期 6 000 ms，`server/napcat-guardian.mjs:52`）【已核验】；执行操作前重新读取 guard 文件确认归属，防止在管理端重启、新后端已接管时收掉新一套进程；清理顺序为 NapCat → 桥 → 隔离 DSH，三段各自独立判定、前一段失败不影响后一段，清理不重试、不重启；匹配方式为托管目录前缀、桥的绝对路径与 DSH 端口，精确匹配并排除自身（`NOT_SELF`），`--dirs` 为空时不终止任何进程；失败升级无重试循环，每段失败仅记日志后继续——守卫是一次性收尾，不是常驻健康检查，【未核验】日志轮转策略未在实现中体现；武装时机为启动时一次并每 60 秒 `setInterval` 复查；可观测面为 `%USERPROFILE%\.qq-bridge-manager\logs\napcat-guardian.log` 与管理端 `mlog()` 同步记录的一行武装信息。守卫不重启任何组件，运行期重启由桥侧通告与管理端的启动 / 重启按钮承担。【据仓库记载】

文件级自修：NapCat Shell 目录在更新包解压不完整、安全软件删除、跨盘复制中断三种条件下会缺少文件，典型异常为 `ERR_MODULE_NOT_FOUND: conout-*.js`。【据仓库记载】`server/napcat-repair.js` 以 `findNapcatApps({root})` 枚举应用目录（深度上限 8 层），以 `checkNapcatApp()` 判断是否缺件（`relativeSpecifiers()` 识别 `from`、副作用 `import`、动态 `import()`、`require()` 四种写法，逐项确认文件存在），以 `findShellZip()` 从当前目录向上最多 10 层查找 `NapCat.Shell.zip` 与 `7z.exe`，以 `repairNapcatApp()` 从该 zip 抽取缺失文件，批量入口为 `ensureNapcatApps({root, fix, log})`，CLI 形式 `[--check|--fix] [--root <dir>]` 在缺件时退出码为 1（可被脚本与测试断言）。管理端在拉起 NapCat 前先执行检查，结果经 `napcatRepairNote` 进入启动结果消息。【据仓库记载】

桥侧 NapCat 守护的状态文件为 `state/napcat-guard.json`、二维码 `state/napcat-qr.png`、容器规格 `state/napcat-container-spec/`；默认参数取自 `core/napcat-guard.js` 的 `DEFAULTS`：`{ enabled: true, probeIntervalMs: 60000, failThreshold: 2, cooldownMs: 600000, maxHealsPerHour: 3, restartGraceSec: 60, recoverWaitMs: 150000, autoHeal: null }`（`qq-bridge/src/core/napcat-guard.js:34`）【已核验】。NapCat 对登录接口的限流约为每 IP 10 次 / 60 秒且与 WebUI 页面共用同一份额度，以该接口作周期性健康检查会消耗扫码所需额度，实现据此删除了该模块的主动探测与自动重启执行体（文件内 95-120 行给出说明），并删除管理端「每分钟验证一次 WebUI 令牌」的轮询。【据仓库记载，未复现】当前桥侧只保留两项职能：读取落盘的二维码、以 OneBot HTTP 查询登录状态；`failThreshold` / `cooldownMs` / `maxHealsPerHour` / `restartGraceSec` / `recoverWaitMs` 保留为配置面但当前没有执行者，属于历史契约残留。【已核验】以 `qq-bridge/src/core/napcat-guard.js:34` 的 `DEFAULTS` 与文件内的删除说明比对。

恢复手段三者的触发面与等待上限不同，不构成自动重试链：管理端界面的启动 / 重启卡片走实例编排状态机；`POST /api/napcat/guard/heal`（桥控制台或管理端代理）重启容器并等待登录恢复；`POST /api/napcat/quick-password`（同上）重建容器，最长 3 分钟。

随包 QQ 的窗口隐藏：需求为随包 QQ 的窗口不出现、不进入任务栏，实现为启动前武装的常驻 PowerShell 观察者（`qqWindowHiderScript()` + `armQqWindowHider()`，`server/index.js:1910`）【已核验】。常量取自 `QQ_HIDER_DEFAULTS`（`server/index.js:1336`）【已核验】，即 `{ budgetMs: 43200000, pollMs: 200, burstMs: 50, burstWindowMs: 5000, readyTimeoutMs: 2500 }`。隐藏手法为 `ShowWindow(h, 0)` + `SetWindowPos(…, SWP_HIDEWINDOW|SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE)` 双重调用、窗口类样式在 `WS_EX_APPWINDOW` 与 `WS_EX_TOOLWINDOW` 之间互换、`ITaskbarList::DeleteTab` 移除任务栏按钮。路径守卫只处理可执行文件路径位于本 Shell 目录之下的 QQ 进程，取不到 `Path` 的进程一律跳过，前缀比较大小写不敏感并按目录边界对齐（补分隔符，使 `…\Shell` 不匹配 `…\ShellOther`）。`seedQqWindowHiderPids()` 先把本进程 spawn 的 pid 落盘，因为启动器常在数百毫秒内退出，其带出的窗口否则无法识别。控制台类窗口的额外扫描窗口为 `consoleScanMs = 60000`。退出条件为预算 12 小时，父进程连续 150 次探测不到（约 30 秒）时 `exit 0`，观察者就绪标记最多等待 `readyTimeoutMs`。后备路径为观察者无法启动（PowerShell 缺失、`Add-Type` 编译失败、临时目录不可写）时退回 `hideBundledQqWindows()` 的一次性轮询。

【据仓库记载】测量批次 2026-09-25：`server/index.js` 中 `qqWindowHiderScript` 附近注释原记「观察 120 秒」，与实际默认预算 `QQ_HIDER_DEFAULTS.budgetMs = 43200000`（12 小时）不符，退出条件由父进程存活守卫承担；两处注释已于 2026-09-25 更正，以常量为准。

## 7. 远程克隆部署

部署语义为：目标机（新机）获得源机（模板机）的完整能力。`deploy.js` 顶部注释给出 0~6 的阶段划分，实现中每步写日志，图形界面轮询 `/api/ssh/deploy/status`。

| 阶段 | 内容 | 关键实现 |
| --- | --- | --- |
| 0 校验 | 源机与目标机均在服务器列表内；连接两端；探测端口（连不上时自动改用上次成功的端口） | `step()` / `safely()` |
| 1 目标机基础环境 | nodejs / npm / docker / python3 的探测与安装（apt → nodesource → 官方 tarball → 发行版包，多路后备）；全局 dsh CLI；`mcp-compressor`（pip 安装，失败不影响主流程） | `ensureNode()`、`ensureDocker()`、`localDshVersion()` |
| 2 源机短暂停机并打包 | 停止 dsh-web / napcat / bridge，随后生成 7 个 stage 包 | `buildStagePlan()`（远端源）或 `buildLocalStagePlan()`（本机源） |
| 3 源机恢复 | 立即恢复阶段 2 停止的三个服务（总停机时长约等于打包耗时，与传输带宽无关） | 与阶段 2 成对出现 |
| 4 流式转发与解包 | 逐包经管理端中转，直接写入目标机解包命令的标准输入，不在目标机留中间文件 | `streamPipe`；传输或解包失败重试一次 |
| 5 目标机落地 | 写 systemd 单元；建立或沿用 NapCat 形态（原生优先、容器为后备）；灌入 QQ 登录态；调整桥配置指向目标机 DSH 端口；能力核对；启动自检 | `installNapcatNative()`、`NAPCAT_MODE_CMD` 探针、`buildTargetDshHealScript()` |
| 6 清理 | 删除源机 stage 目录，断开连接 | — |

阶段 5 内的自检点：隔离 DSH 启动须先执行 `daemon-reload` 与 `restart`，随后确认 `is-active` 且 3080 端口有应答（401 计入存活——无 token 的 DSH 一律返回 401，`down` 与 `000` 计为失败），不通过则记为部署失败；桥配置改写强制写入 `dsh.baseUrl = http://127.0.0.1:3080`（本机为 10721）；能力核对由目标机脚本输出 pixiv / 语音 / 白名单 / 记忆 / 表情库 / 画像的到位情况，退出码非 0 时只记警告；源机缺少 `dsh-web.service` 时现场生成。【据仓库记载】原稿记录时点曾出现「服务进程处于运行状态而管理端始终无法连接」的状态，实现因而改为显式 `daemon-reload` 与 `restart` 并当场确认 `is-active` 与端口应答；本轮未复现该状态。

远端源机路径的包构成（`buildStagePlan()`，落点为服务端绝对路径）：

| 包 | 内容 | 落点 | 排除 |
| --- | --- | --- | --- |
| `qq-bridge.tar.gz` | 桥整棵树（代码、`config.json`、`state/` 记忆与画像数据） | `/root/qq-bridge` | `.git`、`node_modules`、`state/bridge.lock`、`state/bridge*.log`；原生模块（如 sharp）在目标机重新 `npm install` |
| `dsh-home.tar.gz` | 隔离 DSH 的整个 `DSH_HOME`（settings / credentials / agent-presets / profiles / sessions / storages / meme-packs） | `/root/.dsh` | 无 |
| `napcat-config.tar.gz` | NapCat 配置目录（含登录令牌文件） | 原生 → `/opt/napcat/config`；容器 → `/root/napcat/config` | 无 |
| `napcat-app.tar.gz` | `/opt/napcat` 应用本体（含自编译的 `napcat.mjs` 与防掉线补丁） | `/opt/napcat` | `cache`、`config`、`*.db*`；目标机已有 `napcat.mjs` 时跳过 |
| `qqdata.tar.gz` | QQ 登录态（免扫码快速登录） | 原生 → `/home/qq/.config/QQ`（`chown qq:qq`）；容器 → 卷 `napcat-qq` | 由 `opts.qqData === false` 关闭 |
| `dsh-polyfill.tar.gz` | 反向代理脚本目录 | `/root/dsh-polyfill` | 无 |
| `dsh-meme.tar.gz` | 表情库插件目录 | `/root/dsh-meme` | 可选（不存在则不打包） |

本机源路径的排除项（`buildLocalStagePlan()` + `packLocalStage()`，粒度高于远端源路径）：`node_modules`、`.git`（体积，原生模块需在目标机重装）；`state/bridge.lock`、`state/*.log`（运行期状态）；`state/agents/*/node_modules`（DSH 工作区内的依赖树）；`tests/`（开发用）；`*.bak`、`*.bak-*`、`state.bak-*`、`state.old-*`、`state.merge-stage-*`。【据仓库记载】原稿记录时点统计：上述备份文件累计体积 41.4 MB，其中 `config.json.bak-*` 有 30 余份，每份均含所有者 QQ、NapCat 令牌与服务器地址，而目标机不需要这些内容。`packLocalStage()` 同时报告「跳过的悬空链接」（指向本机已不存在路径的符号链接）；本机打包路径的解包脚本在覆盖前把目标机原有 `config.json` 与 `state/voice-config.json` 备份到 `/root/qqbridge-prev-<TS>/` 并打印备份目录名。两侧路径的语义差异：本机打包路径为「整套复刻」（本机配置覆盖目标机），远端源机路径为「换代码不换身份」（目标机配置优先）。【据仓库记载】

目标机目录：`/root/qq-bridge`（桥整棵树，含源码、`state/`、`config.json`、`plugins/`、`tools/`）；`/root/.dsh`（隔离 DSH home：`sessions/`、`storages/`、`profiles/web/`、`cordis.patch.yml`、`.credentials.yaml`、`dsh-web.log`）；`/opt/napcat`（NapCat 应用，原生部署）与其配置目录 `/opt/napcat/config` 或 `/root/napcat/config`；`/root/dsh-meme`（`dsh-meme.tar.gz` 的落点）；`/root/.qqbridge-clone`（克隆部署的 stage 目录，含打包产物与 `napcat-mode` 标记，收尾时删除）；`/root/qqbridge-keep-<TS>`（部署前对目标机原有 `config.json` / `persona.md` / `state/` 的能力保护备份）；`/root/qqbridge-prev-<TS>`（本机打包路径下的旧配置备份落点）。

systemd 单元：`dsh-web.service` 为隔离 DSH，`Environment=DSH_HOME=/root/.dsh`、`EnvironmentFile=-/etc/qq-bridge.env`、`ExecStart=<dshBin> --profile web --port 3080 --no-open --trusted-host 127.0.0.1:3080`，标准输出与错误落 `/root/.dsh/dsh-web.log`；`napcat.service` 为 NapCat 原生部署，源机没有该单元时由部署脚本现场生成；`dsh-polyfill.service` 可选，不存在时不计为失败。

NapCat 两种部署形态由探针判定、不作为配置项：原生形态为官方 Linux QQ deb + `/opt/napcat` + systemd 单元 + Xvfb + 非 root 用户 `qq`（`installNapcatNative()`），探针判据为 `systemctl cat napcat.service` 成功；容器形态为 `mlikiowa/napcat-docker:latest`，卷 `napcat-qq:/app/.config/QQ`，端口 `3000/3001/6099`，探针判据为 `docker ps -a --filter name=^napcat$` 命中。

```bash
if systemctl cat napcat.service >/dev/null 2>&1; then echo native;
elif docker ps -a --filter name=^napcat$ --format "{{.Names}}" | grep -q napcat; then echo docker;
else echo none; fi
```

启停统一经 `napcatCtlCmd()`（systemd 优先），与 `server/index.js` 的控制路径同形状；形态由 `<stageDir>/napcat-mode` 标记驱动（`native` / `docker`），解包脚本据此选择配置落点与登录态落点。【据仓库记载】容器形态的路径映射配置取自 `config.json` 的 `napcat` 键、由 `qq-bridge/src/lib/napcat-file.js` 消费：

```json
"napcat": {
  "imageFileMode": "auto",
  "tmpDir": "/root/napcat/config/moonbot-tmp",
  "dockerPathMap": [{ "host": "/root/napcat/config", "container": "/app/napcat/config" }]
}
```

【据仓库记载】原稿记录时点，NapCat 运行于容器内而配置未提供 `dockerPathMap` 时，由模型侧请求发送本地图片会报 `文件处理失败: 识别URL失败, uri= /root/...`；本机裸机部署时同机可读，故该缺陷只在容器形态出现，克隆脚本会自动改写该键。

回滚、备份与能力保护：能力保护目录为 `/root/qqbridge-keep-<TS>/`，解包前保存目标机原有 `config.json`、`persona.md`、`state/`；恢复策略为解包后由 `buildDeployKeepScript()` 执行逐键合并（目标机取值优先），再把 `state/` 覆盖回来，语义为「部署更换代码，不更换身份与记忆」；目标机上设置 `QQB_DEPLOY_WHOLE_CLONE=1` 时回到整套复刻行为；旧配置备份落在本机打包路径的 `/root/qqbridge-prev-<TS>/`（只存 `config.json` 与 `state/voice-config.json`）；旧 keep 脚本通过 `/tmp/qbm-deploy-keep.js` 在目标机执行后立即删除。【据仓库记载】原稿记录时点，早期部署实现仅把 `config.json` 与 `voice-config.json` 备份到 `/root/qqbridge-prev-<TS>/` 且备份未回写，导致目标机的 pixiv cookie、语音密钥、白名单、工具档位以及 `state/` 中的记忆与画像被覆盖；当前实现改为逐键合并并回写 `state/`。

失败恢复：传输或解包失败自动重试一次（部署日志打印对应行）；npm 全局安装 dsh 失败时尝试建立 `/usr/bin` 软链，仍失败则只记警告并继续；原生 NapCat 安装失败回退容器路径（容器已创建，待灌数据）；`mcp-compressor` 安装失败记警告并继续（仓库内无代码依赖它，工具描述压缩走 `social.slimTools`）；`dsh-polyfill` 单元不存在不计为失败；源机停机阶段出错时记录输出后继续打包，阶段 3 无论如何都尝试恢复源机服务；部署中断时源机 stage 目录残留（可手工清理），目标机处于新旧混合状态，`/root/qqbridge-keep-<TS>/` 仍在，可人工恢复，再次部署会执行同样的保护流程。

部署完成后的自愈脚本 `buildTargetDshHealScript()` 在目标机首次启动前后执行三项：插件 bundle 符号链接在 `<home>/plugins/<name>` 与 `<home>/profiles/node_modules/<name>` 被拷贝损坏或断开时重建；凭据文件权限由 666 修正为 600（DSH 拒绝加载并报 `readable beyond its owner (mode 666)`）；从 Windows 迁移的 MCP 命令路径（形如 `D:\...\qbm-node.exe`）在 Linux 上无效，改写为可执行路径。

## 8. DSH 集成与上下文压缩接口

隔离 home 的目录形态：

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

两条并行的 home 解析链（环境变量优先于配置文件）：管理端链由 `core/tunables.js` 的 `resolveIsolatedDshHome()` 实现（`qq-bridge/src/core/tunables.js:136`）【已核验】，顺序为环境变量 `QQB_DSH_HOME` → `DSH_ISOLATED_HOME` → 管理器配置中的隔离 home（`~/.qq-bridge-manager/dsh-isolated-home-official`，其次 `dsh-isolated-home`）；桥链由 `lib/dsh-side.js` 的 `resolveDshTarget()` 实现，顺序为 `QQB_DSH_HOME` → 项目内 `.runtime/dsh-isolated-home` → 管理器配置 `instances.dshIsolated.isolatedHome` → 项目默认，并在 `win32` 上拒绝以桌面端 `%APPDATA%\DeepSeek Harness\dsh-home` 为目标（`isDesktopDshHome()`）。【据仓库记载】测量批次 2026-09-25：桥侧曾写死 `~/.qq-bridge-manager/dsh-isolated-home` 而管理器启用 `…-official`，导致管理端修改的模型配置未到达隔离 DSH；写死常量已移除，改走上述解析链。桥的项目内默认（`<repo>/../.runtime/dsh-isolated-home`）与管理端配置的 `…-official` 是两份候选，实际生效取决于 `QQB_DSH_HOME` 与管理器配置，两份候选不会自动对齐。【未核验】

装配流程：`qq-bridge/src/bridge.js` 启动时以异步、幂等、非阻塞方式执行三项装配，三项均每次启动执行、不依赖安装标记：（1）`installPresets(target)` 每次启动刷新 preset——preset 是桥自带的代码资产（persona、`[WAKE TYPES]`、`[RULES]`），不属所有者数据，早期实现「装过一次即由标记全跳过」导致修改 `agent.cordis.yml` 后重启桥不会装入新 preset；（2）`watchOverrideFiles()` 监视 `persona.md` 与 `speech-rules.md`，变更后重新合成进已安装的 preset（`qq-bridge/src/lib/preset-compose.js:123`）【已核验】；（3）`ensureBuiltinPlugins(target)` 每次启动幂等装配（link + profile 注册 + settings 的 memory 段），该步骤不能只放在被安装标记拦截的 `installToIsolatedDsh()` 内，否则既有安装无法升级。

两份 `cordis.patch.yml`（配置层顺序为 bundles → profile 级 → home 级 → `--patch`）：`<home>/profiles/<profile>/cordis.patch.yml` 承载 agent-presets overlay 与三组 MCP server（含压缩代理参数），由 `lib/dsh-side.js` 的 `patchProfileCordis()` 维护（`qq-bridge/src/lib/dsh-side.js:302`）【已核验】；`<home>/cordis.patch.yml`（home 级）承载上下文压缩与工具结果剪枝策略，由 `lib/dsh-compaction.js` 的 `syncDshCompactionPatch()` 维护（`qq-bridge/src/lib/dsh-compaction.js:198`）【已核验】。写入 home 级文件不影响承载 MCP 挂载的 profile 级文件；profile 的 `patchReload: live` 同时监视 home 级 patch 文件，因此写入后不必重启 DSH。home 级内容以 `# === qq-bridge compaction BEGIN/END ===` 标记包裹，只替换标记之间的段落，用户自有 overlay 原样保留；profile 级以 `# === qq-bridge MCP BEGIN/END ===` 包裹，三组 MCP server 的 `env` / `command` / `args` 全部位于其中，`toolCallTimeoutMs: 725000` 只加在 `mcp-napcat` 上。【据仓库记载】

会话日志的写入边界：桥不直接改写 DSH 的会话日志，依据写于 `lib/dsh-compaction.js:4-9`，来自对 DSH 0.1.2-rc.1 源码的阅读——`dsh-session` 的模型历史由内存日志经 `deriveMessages()` 派生、文件仅在冷恢复时读取，改文件对运行中会话无影响；`dsh-session-persistence-jsonl` 的日志为 seq 连续的仅追加记录，删行触发 `corrupt session log: seq gap`，默认 zstd 帧带校验和、正文改动导致校验失败；实现注明「每个会话一个活动写入方」，外部同时写入会相互冲突；受支持的裁剪路径仅一条，即由 DSH 自身通过 surface `replace` 改写历史（`dsh-compaction-tool-result-pruner` 剪枝与 `dsh-compaction-basic` 摘要）。

压缩插件的硬约束（不满足时插件拒绝加载，隔离 DSH 无法启动）：`compaction-basic` 要求 `retainRatio` 必须小于 `thresholdRatio` 解析出的阈值；`tool-result-pruner` 要求 `headChars + 标记 + tailChars ≤ thresholdChars`，标记为 `"\n\n[... tool result middle pruned ...]\n\n"`，与 DSH 内的 `PRUNE_MARKER` 逐字一致。`normalizeCompaction()` 保证上述两条恒成立，被夹紧时写日志说明。【据仓库记载】原稿记录时点，web profile 下 `compaction-basic` 与 `tool-result-pruner` 默认 `disabled: true`（归 host plane 所有），检索本机隔离 home 的 86 个会话日志中 `compaction/*` 事件数为 0，即配置正确的自动压缩未执行；实现改为在 `buildCompactionRows()` 中显式写入 `disabled: false`（`qq-bridge/src/lib/dsh-compaction.js:112-123`）【已核验】。

内置插件三组均经符号链接接入 DSH：`dsh-qq-hold` 提供 `agent/turn-stopping` 钩子的时序闸门并暴露 `POST /api/qq/turn-hold`（由 `core/console-server.js` 接收）；`qq-mode-console` 为模式控制台；`dsh-memory` 提供长期记忆插件的 `remember` / `recall` 工具，随包 vendored。链接落点为 `<home>/plugins/<name>` 与 `<home>/profiles/node_modules/<name>`，均指向 `qq-bridge/plugins/<name>`；`server/deploy.js` 的克隆脚本处理同样的两处链接，服务端另有 `buildTargetDshHealScript()` 修复被拷贝损坏或断开的链接。【据仓库记载】

### 投递路径与回合保持

入站归一入口位于 `qq-bridge/src/bridge.js`：私聊消息 `handleIncoming('private', user_id, event, cfg)`（`bridge.js:575-578`）；群消息 `handleIncoming('group', group_id, event, cfg)`（`bridge.js:579-582`）；`notify` 通知用于拍一拍与输入状态（`bridge.js:583-586`）；撤回标记 `[已撤回]` 并落库 `chat_messages.recalled_at`（`bridge.js:589-614`）。

`handleIncoming` 的处理步骤（`qq-bridge/src/core/mux.js:299`）【已核验】，顺序本身构成设计约束：（1）`convKey(kind, id)` 生成会话键 `private:<QQ>` / `group:<群号>`，模式不允许时直接忽略（`mux.js:296-300`）；（2）生成两套正文——`textContent`（含 `[引用 X：…]`，用于判定指代对象）与 `plainContent`（仅本条文本，用于命令与指向性判定）（`mux.js:309-310`）；（3）私聊违法或诈骗内容自动删除好友并拉黑（`social.autoFriendGuard`，`mux.js:312-322`）；（4）抽取媒体段与文件段，按 `message_id` / `message_seq` 存入 `messageMediaStore`，超过 `MAX_MEDIA_STORE_PER_KEY` 时丢弃最旧条目（`mux.js:323-341`）；（5）判定引用对象是否为机器人自身（`isQuoteTargetSelf`），该判定必须早于空文本过滤，否则「仅引用不附文」的消息被丢弃（`mux.js:344`）；（6）入站幂等去重 `isDuplicateInbound(key, messageId)`（`mux.js:281`）【已核验】，避免重复入库、重复唤醒、重复回复（`mux.js:347-350`）；（7）存在挂起提问时先作为回答消费，静默模式只记录不投递，角色切换、人格学习、画像学习、斜杠命令在此分流（`mux.js:356-540`）。

唤醒判定：`evaluateWakeTrigger()`（`qq-bridge/src/core/wake-send.js:182`）【已核验】返回原因字符串，该字符串成为注入正文中的 `[Wake …]`。判定次序构成设计约束，修改前须阅读实现注释：（1）`private` 私聊消息一律触发；（2）群聊处于睡眠窗口时只放行 @ 或引用机器人，其余不投递；（3）@ / 引用优先于 `anyMessage`——`anyMessage` 前置时 @ 被标记为 `anyMessage`，而免打扰时段只放行真实触发类型，导致群内 @ 无响应，该次序于 2026-09-19 修正；（4）其余触发类型包括 `nameMention`（点名）、`keyword:<词>`（短英文或数字关键词按词边界匹配，避免 `ADS` / `BDSM` 误触发）、`question`（`isDirectedAtAi`）、`topic`（AI 或技术话题接话，正则 `TOPIC_WAKE_RE`）、`speaker:<昵称>`、`probability`。

投递执行：唤醒调度的统一入口为 `core/social-state.js` 的 `scheduleWake(key, reason)`（`social-state.js:854`）【已核验】，合并窗、免打扰、忙碌分流、轮换判定均在此路径上；投递看门狗为 `startDeliveryWatchdog()`（`social-state.js:1052`）【已核验】，每 20 秒扫描一次，`WATCHDOG_DEFAULT_OVERDUE_MS = 25000`、`WATCHDOG_DEFAULT_MIN_RETRY_MS = 60000`（`social-state.js:1001-1002`）【已核验】，判据为 `_wakeIntendedSeq`（桥计划交付的最高 seq）而不采用「是否已被回复」——模型查看后选择不回复属正常，未被查看必须被检出；提示词组装为 `core/wake-send.js` 的 `buildWakePrompt(key, reason)`（`wake-send.js:433`）【已核验】；投递执行为 `core/prompt-deliver.js` 的 `deliverPromptNow()`（`prompt-deliver.js:114`）【已核验】，经 `ensureSession()` 获取 sessionId、超时 30 秒，超时或失败时 `quarantineSession()` 隔离该会话；DSH 调用位于 `prompt-deliver.js:158`，即 `api.sessions.prompt({ sessionId, mode: 'steer', content })`；事件泵为 `core/mux.js` 的 `pumpMux()`（`mux.js:766`）【已核验】，以 `api.events.mux()` 逐帧处理 `session/event`。

投递模式的选择依据（`prompt-deliver.js:137-157`）来自 DSH 的 inbox 队列结构：`queue` 走 `agent.followup()` → inbox 的 `next-turn` 队列，仅在回合循环的下一次迭代被 claim，当前回合不结束时（模型处于长轮询，或进程重启后停留在 running）该消息永久停留于 `next-turn`，模型不可见且桥不接收任何事件；`steer` 走 `agent.steer()` → inbox 的 `next-step` 队列，`inbox.claim()` 总是先取走全部 `next-step`，回合进行中则在下一个 step 边界交付、agent 空闲则立即开回合并取走，该模式为全定义，不存在搁浅状态。投递队列（`prompt-deliver.js:17` 起）【已核验】为 `QUEUE_MAX = 50`、同 key 去重、退避 `min(3000·2^(n-1), 60000)`（`prompt-deliver.js:97`）【已核验】，连续失败 5 次后降为每 60 秒一次；DSH 未就绪时消息入队不丢弃，就绪后按序补投（`flushQueue`）。【据仓库记载】

注入正文构成：唤醒正文只携带数据行，行为规则全部位于预设的系统提示词（`[WAKE TYPES]`），正文骨架由 `buildWakePrompt()` 组装（`wake-send.js:400-550`）。行为：`[Token] <令牌>`（本会话当前有效令牌，发送类工具需要，`wake-send.js:415`）；`[Session] <key>`（确切的会话键，工具层不推断 key，缺失时以该行为准，`wake-send.js:344`、`415`）；`[Style] …`（每轮一句语感提示，文本取自 `config.json` 的 `prompt.styleLine`，默认 `[Style] 说人话：短、有态度，别讲课别列举`，`wake-send.js:360-374`）；`[OWNER]` / `[NOT-OWNER]`（所有者私聊带前者，非所有者私聊显式写后者，修正所有者识别错误，`wake-send.js:404-411`）；`[Status]`（`N unread; waiting on …; last from …; said Nmin ago`；不包含时间行——原 `[Now]` 表示组装时刻、模型执行时已过期，时刻查询改由 MCP 工具 `get_time` 现取，`wake-send.js:484-485`，工具见 `qq-bridge/src/mcp-napcat-safe.js`）；`[Wake]` / `[WakeRef]`（当前模式、时长、触发器，以及配置的插话概率、当前生效值与来源，`wake-send.js:326-336`、`496`）；`[Recall]` / `[Profile]` / 联系人行（长期记忆摘要，永久层上限约 700 字符、14 条，与会话对象档案，`wake-send.js:436-454`）；`[Unread n]` / `[Mid-turn]` / `[Note]`（未读与在途注入块）；`[PERSONA]` / `[SPEECH RULES]`（按需注入）。

人设与发言规则由 `lib/preset-compose.js` 合成进系统提示词，唤醒正文默认不重复注入；判据为 `shouldInjectPersonaBlock()`（`wake-send.js:306`）【已核验】——preset 内的版本为当前版本（`getComposedPersonaStamp() === runtimeOverrideStamp()`）且该会话无「需要补注入」标记时不注入，否则注入一次。注入上限以字符计（`wake-send.js:248-250`）【已核验】：`persona.md` 16 000 字符、`speech-rules.md` 12 000 字符，策略均为保留头部与尾部、尾部 2 500 字符必定保留，截断范围写入日志（`wake-send.js:260-271`）。早期实现仅保留头部并整体丢弃尾部，导致「在文件末尾追加规则」不产生效果；文件变更后由 `watchOverrideFiles()`（`lib/preset-compose.js`，由 `bridge.js:288` 装配）重新合成进预设，运行中的既有会话由 `markStalePersonaReinjects()` 在启动时标记一次补注入。【据仓库记载】

回合保持的依据来自 DSH 源码（`dsh-agent-loop/lib/index.js:564-572`【未核验】——该文件不在本仓库内，结论转载于 `qq-bridge/src/core/turn-hold.js:4-14`）：一个模型步结束、无存活工具调用且 `next-step` 为空时，回合将关闭；关闭前会 `await` 一次 `agent/turn-stopping` 插件钩子，并在钩子返回后重新检查 `next-step`。由此可得两条结论：钩子内等待期间，桥可将新消息 steer 进 `next-step`，回合不关闭而直接进入下一步；对照 `mode:'queue'`，其投递目标为 `next-turn`，必然额外增加一个完整回合（含整包提示词重发）。分工为：插件只提供时序闸门（`dsh-qq-hold` 提供 `POST /api/qq/turn-hold`，由 `core/console-server.js` 接收），桥负责 steer（`steerIntoRunningTurn()`，`wake-send.js:836`）【已核验】。单个 HTTP 请求的 `headersTimeout` 默认为 300 秒（undici / fetch），长持有会被截断，因此单次持有预算 `requestBudgetMs` 默认 55 000 ms、夹在 `[3000, 120000]`（`turn-hold.js:158`）【已核验】；本段未等到消息时返回 `{ close: false, again: true }`，插件收到后立即再次发起请求——对 DSH 而言钩子持续等待、回合不关闭，对 HTTP 而言每个请求均短于超时。

保持循环参数（`holdLoop`，`turn-hold.js:132`）【已核验】：

| 参数 | 默认（括号内为取值范围） | 位置 |
| --- | --- | --- |
| `maxExchanges` | 24（下界 1） | `turn-hold.js:134` |
| `idleCloseMs` | 1 800 000 ms（30 分钟，下界 1 000 ms） | `turn-hold.js:135` |
| `maxWaitMs` | 3 600 000 ms（60 分钟，不短于 `idleCloseMs`） | `turn-hold.js:156` |
| `requestBudgetMs` | 55 000 ms，夹在 `[3000, 120000]` | `turn-hold.js:158` |
| 轮询 `POLL_MS` | 200 ms | `turn-hold.js:45` |
| 看门狗续期 `RENEW_MS` | 5 000 ms | `turn-hold.js:48` |
| 打字阻塞时的退避 | `min(1500, 200·2^(n-1))` | `turn-hold.js:226` |

回合保持的不变量：（1）默认关闭，`cfg.social.turnHold.enabled !== true` 时立即放行，行为与未启用该功能时一致；（2）灰度生效，`keys` 非空时仅对白名单生效，`privateOnly`（默认 `true`）仅作用于私聊；（3）保持路径不标记已读——steer 不改动 `unread`，仅在模型实际发出回复后由回合结束的 `mux` 钩子清除，DSH 的 `cancel()` 会执行 `inbox.clear()`、未被领取的消息在中断时消失，因此以 `unread` 作为后备路径；（4）同一会话单飞，`activeHolds` 保证单处持有，防止双重 steer 造成重复注入；（5）达到轮换阈值即放行，`holdLoop` 每轮调用 `rotationDue()`，到点以 `finish('rotate-threshold')` 主动放行关闭回合（`turn-hold.js:181-186`）；（6）每个提前返回均写日志——该功能历史上出现四次静默失败，日志为唯一观测面。【据仓库记载】测量批次 2026-09-19：`noteExchange()` 每次来回使 `rotateTurns` 加一，而轮换判定原先只存在于会话非忙碌的路径上，保持循环使会话长期处于忙碌状态；检索 `rotateTurns` 与轮换日志得 `rotateTurns = 20`、阈值为 15、`[rotate]` 日志条目数为 0；修正方式为在保持循环内每轮调用 `rotationDue()`。

合并注入：每次 steer 在 inbox 中是独立的一条 `next-step` 消息（`dsh-agent-loop/lib/index.js:399-401`【未核验】，该文件不在本仓库内），`inbox.claim()` 在下一个 step 的开端一次取走全部 `next-step`（`dsh-agent/lib/index.js:56-61`【未核验】，该文件不在本仓库内）。推论：同一步内注入 N 次时，模型在一次思考中看到 N 个独立的 `[Mid-turn]` 块，只能逐块处理；由于同一 step 边界本只能带走一批，「在步边界一次性注入」与「到达即注入」的送达时刻相同，而模型只看到一个块并只产生一条回复。闸门与发车点（常量取自 `wake-send.js:641-699`）【已核验】：收集窗 `STEER_COLLECT_MS = 1000`、`STEER_COLLECT_MAX_MS = 3000`（注入前等待输入停止，对方持续输入时最多等待 `STEER_COLLECT_MAX_MS`）；周期闸 `STEER_CYCLE_MS = 5000`（保持托管会话）、`STEER_CYCLE_SHORT_MS = 1500`（非保持会话），同一模型步周期内只注入一次；特例「模型仍在生成且本回合未发出任何回复」走 `midTurnSteerGate({ noReplyYet })`（`typing-hold.js:94`）【已核验】，不攒批、直接即时注入，该情形下攒批无合并收益却把送达时刻押在步边界的到达上；防饥饿 `STEER_PENDING_MAX_MS = 20000`（攒批超过该时长仍未等到步边界时立即注入，不允许静默阻塞）；发车点一为 `turn-hold.js` 的 `holdLoop`（在 `agent/turn-stopping` 钩子内），发车点二为 `turn-hold.js` 的 `flushStepBatch()`（`turn-hold.js:358`）【已核验】，由 `mux.js:896-899` 在收到 `step/end` 时调用——保持循环仅在 `turnEnds && nextStep.length === 0` 时被 await，连续调用多个工具的步不进入钩子，而 `step/end` 在每一步均产生。【据仓库记载】原稿记录时点，模型处于生成中、本回合未发出回复而采用攒批路径时，步边界在 28 秒内未到达，投递由 20 秒的防饥饿上限触发；该结果构成 `noReplyYet` 分支不攒批的依据。

在途注入的准入判据（`steerIntoRunningTurn()`，`wake-send.js:836`）【已核验】，三者任一成立即允许：`forced`（回合保持循环的调用，调用点位于 `turn-stopping` 钩子内，回合必然在运行）；`social.steerEnabled === true`（全局开关，默认开启，仅显式写 `false` 时关闭）；位于回合保持灰度内且存在回合运行证据。

```js
runningTurn = agentRunningSessions.has(sessionId)   // DSH 权威状态
           || TurnStartAt.has(sessionId)            // 桥观测：turn/start 置位、turn/end 清除
           || collectors.has(sessionId)             // 桥观测
```

`host/session-status` 权威帧不进入桥的事件流（计数为 0，该批 `host/*` 帧走 Web UI 的 host 流），因此以桥自身观测的回合边界作为后备（`wake-send.js:830-835`）；无 `runningTurn` 时只记账不投递，写一行「只能留到下一轮（原因：…）」的日志，消息保留在 `unread` 中。【据仓库记载】返回值语义中，同一返回值在不同分支下承载不同含义、调用方必须区分：`true` 表示已写入，或本回合已交付过（唤醒正文展示过或刚 steer 过），或被周期闸攒住（实际未投递任何内容）；`'typing-defer'` 表示对方仍在输入、该批继续攒（明确信号，不得返回 `false`）；`false` 表示投递失败或回合未运行。【据仓库记载】语义失误的历史后果：把「已交付」错返回 `false` 时，调用方读作投递失败并回落到完整唤醒流程，向同一回合再次投递完整唤醒，模型重复看到同一批未读并产生一条重复回复，修正为返回 `true`；把「被周期闸攒住」按已投递处理并返回 `close: false` 时，实际未投递，DSH 观察到 `next-step` 为空而关闭回合，表现为回合保持静默结束，修正为 `holdLoop` 与 `flushStepBatch` 在记账前以 `collectMidTurnBatch(st)` 返回空（该批 seq 已不在待交付集合内）验证落地，未落地则继续持有并重试。

打字状态等待：`core/typing-hold.js` 的 `midTurnSteerGate` 与 `midTurnSteerText`（`typing-hold.js:94`、`122`）【已核验】，配置位于 `social.typing`，默认值取自 `TYPING_DEFAULTS`（`typing-hold.js:18-22`）【已核验】——`enabled` 默认 true（总开关）；`holdMaxMs` 默认 12 000 ms、夹在 `[1000, 60000]`（最长等待时长，到点即注入，避免对持续输入者无限等待）；`refreshOnMessageMs` 默认 5 000 ms、夹在 `[0, 30000]`（输入事件不可靠，收到一条消息即把「对方在输入」续期该时长）；`breakProbability` 默认 0.15、夹在 `[0, 1]`（每次唤醒的插话概率，0 表示只等待对方停止，1 表示从不等待）。打字等待后的三条路径（`wake-send.js:943-947`）：模型仍在生成且本回合未发出任何回复时注入当前回合、不等待；本回合已发出回复且对方持续连发时短暂延迟后注入（不超过 `STEER_IN_TURN_DEFER_MAX_MS`）并排入一次 `scheduleInTurnRedeliver`（最多 3 次，`wake-send.js:727`），输入窗口结束即投递；无运行中的回合或注入通道失败时留至下一轮（由 `runningTurn` 守卫与补投失败分支各写一行日志）。【据仓库记载】原稿记录时点，`midTurnSteerGate` 读取 `cfg.social.typing` 而调用点传入 `cfgRef?.social?.typing`，该参数为 `undefined` 并回落至 `TYPING_DEFAULTS`，管理端配置的 `social.typing.*` 在在途注入路径上未生效（`wake-send.js:955-958`）。

回合看门狗常量（`core/turn-guard.js`）：`TURN_TIMEOUT_MS = 180000`（`turn-guard.js:16`）【已核验】——完全静默 180 秒（无 turn、tool、流式事件）判定为阻塞；`TURN_TOTAL_TIMEOUT_MS = 360000`（`turn-guard.js:17`）【已核验】——6 分钟未结束（疑似模型重复输出）时强制隔离；`LONG_WAIT_TURN_TIMEOUT_MS = 660000`（11 分钟，`turn-guard.js:21`）【已核验】——由 `touchTurnGuardsByKey()` 用于 `qq_wait_for_messages` 与回合保持等合法长等待；`quarantineSession(key, sessionId)` 在投递超时或判定阻塞时调用；启动时的唤醒租约由 `armPendingWakeLease` / `disarmPendingWakeLease` 管理。回合保持每 5 000 ms 续期看门狗（`turn-hold.js:48` 的 `RENEW_MS`）【已核验】，缺少续期时保持期间无事件产生、计时器持续推进并触发误判；另有两条恢复路径位于 `wake-send.js` 与 `social-state.js`：`loopRecovery`（存在未读但长时间无动作时拉回）与 `timeoutRecovery`（回合判定阻塞时收尾）。【据仓库记载】

回合级共享状态集中于 `core/session-state.js`，全部以 `Map` / `Set` 按内容增删并经 export 活绑定共享（无整体重赋值），因此各子系统持有同一份视图：`collectors` / `TurnStartAt`（会话 → 回合采集器、回合开始时间，回合边界观测）；`promptQueues`（每会话串行投递 DSH prompt，保证回合顺序）；`pendingWakeKeys` / `pendingWakeLeaseTimers`（唤醒待办，以及「已接受但未收到 `turn/end`」的租约后备）；`sendToolSucceededSessions` / `pendingSendToolCalls`（本回合发送类工具是否成功过、等待 `tool/result` 的调用）；`turnTimeoutTimers` / `turnTotalTimers`（活动感知看门狗与回合总时长后备）；`loopRepeatState` / `loopRecoverTimes` / `activeAiTurns` / `pendingTurnOutbound`（复读判定与自动重启台账）；`activeWaits` / `lastWakeRebroadcast` / `wakeConfigUpdatedKeys` / `markReadCalledKeys`（长轮询互斥、补发冷却、唤醒配置与已读台账）。

出站：事件泵中 `collector.push(frame.event)` 返回 `ended` 时回合收尾（`mux.js:909-1084`）。已回复账本的本回合负责消息集合为唤醒时展示的 `turnSeenUnread` 与中途 steer 进入的 `turnSteeredSeqs`，只计入前半部分会使 steer 进入的 seq 永远不进入 `answeredMessageIds`、下一轮被当作新消息并产生重复回复；账本来源为从 `recentMessages` 查找而不遍历 `unread`——模型在回合内调用 `mark_read` 时已移除展示过的未读条目；回合结束清理清空 `turnSeenUnread` / `turnSteeredSeqs` / `_steerDeferredSeqs`；无动作后备为连续 `social.wake.noActionLimit`（默认 3）次唤醒既未发消息也未调用 `mark_read` / `set_wake_config` 时执行 `softResetWakeConfig()`；防遗忘提醒在 `pendingWakeKeys` 中的会话未更新唤醒配置时发出，最多 `maxWakeConfigReminders`（默认 2）次，之后软重置；暂存唤醒合并把忙碌期间暂存的唤醒原因合并为一次最高权重唤醒投递，避免补发与忙碌形成积压循环。发送链由 `core/send-chain.js`（`enqueueSend` / `currentSendChain`）、`core/qq-send.js`（`onebotSend`，`qq-bridge/src/core/qq-send.js:166`【已核验】——所有模型正文的唯一出口）、`core/send-idempotency.js`（幂等闸门，防止 `/reset` 后重复回复）、`lib/onebot-delivery.js`（分段与节奏）、`lib/send-gaps.js`（`computeGaps` / `clampGap`）构成。【据仓库记载】

### 上下文压缩接口与检索面

桥只写配置文件，实际裁剪由 DSH 的 surface 插件执行。接入面为 home 级 patch 文件 `<DSH_HOME>/cordis.patch.yml`，由 `syncDshCompactionPatch()` 写入标记块内的压缩与剪枝行（`qq-bridge/src/lib/dsh-compaction.js:198`）【已核验】；配置热加载在 `dshCompaction.*` 变化时重写 `cordis.patch.yml`；成本模型见「成本模型与压缩触发判据」章。召回内容以摘要形式注入唤醒正文（`[Recall]` 行，`limit: 14`、`maxChars: 700`，`wake-send.js:479`）【已核验】，不将历史消息回填上下文；摘要置于唤醒正文而非系统提示词，因为系统提示词的变更会使整段前缀缓存失效。【据仓库记载】

检索面由两个 SQLite 库构成，库文件位于 `qq-bridge/state/`，划分依据是两张主要表的生命周期差异：`memory.db` 由 `core/memory.js` 维护（`memDb` 为模块级单例），含 `profiles`、`memory_entries`、`memory_meta`、`mem_fts`；`chat.db` 由 `core/chat-db.js` 维护，含 `chat_messages`、`chat_fts`、`chat_convs`、`chat_stats`、`chat_meta`。划分为 2026-09-24 批次、调用方接口不变：`chat_messages` 为全库最大表，只增不改、可按会话整段删除、每条消息写一行，而 `profiles` 与 `memory_entries` 条目少、生命周期长、每轮注入上下文；合并在同一文件中时，删除聊天历史会同时锁定记忆库并放大写放大与备份粒度。`memory.js` 原样 re-export 聊天函数，历史 import 路径（`mux`、`social-flow`、`wake-send`、`crosschat`、`message-cache`、`console-server`）不变；共享工具 `ftsUsable` / `ftsQueryOf` 抽入 `lib/fts.js` 供两个库共用（两份实现会漂移，故障表现为检索无结果且不报错）；首次启动迁移把旧 `memory.db` 的 `chat_messages` 一次性搬入 `chat.db`，以 `ATTACH` + `INSERT … SELECT` 执行，核对条数一致后删除旧表并 `VACUUM`，两侧均非空时跳过并记日志、条数不一致时保留旧表待下次重试，水位记于 `chat_meta.migrated_from_memory_db`、不重复搬迁。

检索索引与分层：索引为 FTS5 外部内容表，`tokenize='trigram'`、`content='<源表>'`、`content_rowid='id'`，建表语句见 `qq-bridge/src/core/memory.js:143`【已核验】；trigram 对中文按三字滑窗切分，中文子串可直接命中，不需要分词器；相关性排序由 SQLite 内部的 BM25 提供；索引同步由触发器维护，索引与触发器均在 SQLite 内部执行，桥侧只增加一次 INSERT 的开销；结构版本为 `FTS_SCHEMA_VERSION = '2'`（`memory.js:90`）【已核验】，版本变化时下次启动自动重建、操作幂等；记忆分层为 `MEMORY_TIERS = { permanent: 0, durable: 90 天, working: 7 天 }`（`memory.js:87`）【已核验】与 `PERMANENT_CATEGORIES = Set(['rule','owner','identity'])`（`memory.js:89`）【已核验】，归属判据为 `pinned = 1` 或 `category ∈ PERMANENT_CATEGORIES` → `permanent`、显式 `working=true` 或低 `importance` → `working`、其余为 `durable`；索引清单为 `memory.db` 的 `idx_mem_uid`、`idx_mem_tier`、`idx_mem_conv`、`idx_mem_expire` 与 `chat.db` 的 `idx_chat_conv_ts`、`idx_chat_ts`、`idx_chat_sender`、`idx_chat_conv_content`、`idx_chat_dir_ts`，以及部分唯一索引 `idx_chat_msgid`（`WHERE message_id != ''`，用于防止重复投递与双路径并发写入），建该索引前必须清除存量重复行（每组保留 `id` 最小的一行），不满足时建索引失败。

### 工具面

三组 MCP server 由 `lib/dsh-side.js` 的 `mcpBlock()`（`qq-bridge/src/lib/dsh-side.js:252`）【已核验】写入 profile 的 `cordis.patch.yml`：`mcp-napcat`（serverName `napcat`，脚本 `qq-bridge/src/mcp-napcat-safe.js`）承载 QQ 与 NapCat 能力主体；`mcp-napcat-host`（`napcat-host`，`qq-bridge/src/mcp-host-server.js`）承载 `qq_learning_corpus`、`qq_learning_submit`、`napcat_status`，进程控制在显式开启前不注册；`mcp-web-search-safe`（`web-search-safe`，`qq-bridge/src/mcp-web-search-safe.js`）承载 `web_search`、`web_fetch`。

工具注册数按源码文本计数（`registerTool(` 为本地包装函数，其中一次出现为函数定义，`mcp-napcat-safe.js:734`）【已核验】：`mcp-napcat-safe.js` 中 `registerTool(` 出现 92 次（含 1 处函数定义，调用 91 次）、`server.tool(` 1 次（由包装函数内部调用），注册 91 个工具，含 `qq_send_message`、`qq_reply`、`qq_get_unread_messages`、`qq_mark_read`、`qq_wait_for_messages`、`qq_memory_*`、`qq_slang_*`、`qq_character_*`、`qq_qzone_*`、`qq_pixiv_search`、`qq_send_voice`、`qq_transcribe_voice`、`qq_video_parse`、`qq_meme_search`、`qq_schedule_*`、`qq_crosschat_*` 等，若干工具受 `cfg.social.tools.*` 开关包裹、运行时不注册；`mcp-host-server.js` 中 `server.tool(` 5 次，注册 5 个（`qq_learning_corpus`、`qq_learning_submit`、`napcat_status`、`start_napcat`、`stop_napcat`，后两项仅在 `napcat.allowProcessControl === true` 时注册）；`mcp-web-search-safe.js` 中 `server.tool(` 2 次，注册 `web_search`、`web_fetch`。`mcp-host-server.js` 与 MCP 客户端的约定写于该文件头注释——由 DSH 的 MCP 客户端 spawn；`qq_learning_submit` 不放入 napcat 组，因为学习会话只加载 `mcp__napcat-host__` 组，写作 `mcp__napcat__qq_learning_submit` 会成为未知工具。【据仓库记载】

工具 schema 体积实测快照（测量批次 2026-09-24，工具表不含 `qq_send_burst`，数据源 `qq-bridge/state/tool-schema-stats.json`）：`totalChars` 95 595 字符；`registered` / `available` 均为 91；`approxTokensPerStep` 31 675；`tier off` 91 个 / 95 595 字符（份额 1.0000）、`tier low` 68 个 / 79 162 字符（0.8281）、`tier medium` 42 个 / 40 047 字符（0.4189）、`tier high` 33 个 / 33 344 字符（0.3488）、`tier extreme` 9 个 / 6 497 字符（0.0680）。

工具档位为白名单语义——不在保留集合内的工具不注册，其描述不进入请求体：`off`（默认）为全部工具注册；`low` 为移除零调用且体积最大的集合、其余保留；`medium` 为协议必需 + 被调用过的工具 + 提示词点名的工具 + 低体积工具；`high` 为协议必需 + 被调用过的工具 + 提示词点名的工具 + 群成员识别相关工具；`extreme` 为九项最小集合（发送、引用、收尾、读未读、时间查询等）；`custom` 使用手写 `allow` / `deny` 两张表（旧行为）。保留集合的构成为（`qq-bridge/src/lib/tool-tiers.js`）：`ESSENTIAL`（协议必需、任何档位均保留）含 `qq_send_message`、`qq_reply`、`qq_mark_read`、`qq_set_wake_config`、`qq_get_prompt`、`qq_social_state`、`qq_get_unread_messages`、`qq_wait_for_messages`、`qq_list_groups`、`qq_status`、`get_time`（2026-09-24 加入，`extreme` 档白名单亦显式列出）；`OBSERVED_USED` 取自服务器真实调用日志（`state/tool-calls.jsonl`，1 108 次调用）中确有调用记录的工具，由统计脚本生成；`PROMPT_NAMED`（2026-09-24 新增）为提示词点名要求模型调用的工具，含 `qq_memory_remember`（`[Recall]` 段要求使用）与 `qq_get_file_content`（媒体标签行要求使用），其判据强于调用记录类。`qq_status` 在所有档位均保留（198 字符，`tool-tiers.js:45`）【已核验】；选择具体档位时 `allow` / `deny` 两张手写表一律忽略，因为线上 `deny` 旧名单与档位白名单可能自相矛盾，被移除的正是模型在用的工具且难以发现（`tool-tiers.js:144-148`）。【据仓库记载】

描述压缩档（`lib/tool-schema-compress.js`）：`SCHEMA_LEVELS = ['off','medium','high']`（`tool-schema-compress.js:33`）【已核验】，配置键 `social.slimTools.schemaLevel`，压缩对象为描述文本、工具与参数数量不变；`off` 为描述原样下发，`medium` 为工具与参数的描述均只保留第一句，`high` 为不发送描述、只保留工具名、参数名、类型、枚举与必填。该模块不提供 mcp-compressor 的 `low` 档，因为重建 union 容器会把描述复制进每个分支而导致体积增加；重建容器后必须回填容器自身的描述（`withOwnDesc`，`tool-schema-compress.js:76`）【已核验】，否则 `z.union([...]).optional().describe('Group id')` 一类参数描述丢失。`social.slimTools` 在注册期排除工具、可减少请求体积，`social.tools.*` 只在调用期拒绝、不减少体积。【据仓库记载】

MCP 压缩代理的配置位于 `config.json` 的 `social.toolCompressor`，装配位于 `lib/dsh-side.js:171-296`；默认恒定开启（`tc.enabled !== false`），仅显式 `enabled: false` 时回到直连。进程形态为代理进程：DSH 不直连 `mcp-napcat` 而连接代理，代理将工具压缩为两个包装工具（`<server>_invoke_tool` / `<server>_get_tool_schema`），工具清单嵌入包装工具的描述；档位语义为 `low` 去冗余、`medium` 每条描述只留第一句、`high` 不发送描述、`max` 不发送工具清单并改用包装工具；适用范围仅 `mcp-napcat` 一路（工具最多、体积最大），另两组保持直连；后备路径要求压缩机未安装或无法启动时不得使工具表消失，先执行廉价探测，探测失败则直连并把原因写入日志（`dsh-side.js:179-181`、`221-247`）。桥侧配套为 `core/mux.js` 的 `unwrapCompressedToolName(name, rawArgs)`（`mux.js:129`）【已核验】，把包装工具还原为后端真实工具名；代理模式下真实目标位于 `args.tool_name`，而桥下游逻辑（发送类判定、引号补全、幂等账本、抽签登记、回合收尾，共 49 处）均按真实工具名判定，未解包时该批逻辑全部失效（`mux.js:802-811`）。【据仓库记载】

体积测量（测量批次为原稿记录时点，样本 90 个工具）：MCP 压缩代理相对完整工具表（`dsh-side.js:174-176`）的体积为 `low` 38.8%、`medium` 14.0%、`high` 6.2%、`max` 3.6%，同一窗口内 `napcat_get_tool_schema` 调用次数为 0；描述压缩档以 wire 格式（真实传输格式）测得 `off` 89 603 字符（基准 1.0）、`medium` 61 587 字符（68.7%）、`high` 27 109 字符（30.2%）。工具名归一化由 `bareToolName()`（`mcp-napcat-safe.js` 的 `registerTool` 附近、`tool-tiers.js:130`）去除 `mcp__server__` 前缀，名单中的工具名允许带或不带该前缀（写 `mcp__napcat__qq_x` 与写 `qq_x` 等价），缺少该归一化时精简名单整体不命中。

### 会话、预设、热加载与计量

会话绑定发生在会话创建时：桥按 QQ 会话键建立 DSH 会话，映射存 `state/sessions.json`，创建时绑定 `agentPreset`（默认 `qq-chat`）与工作区标题（默认 `Agents`）。预设装配位于 `qq-bridge/dsh/agent-presets/qq-chat/`（`preset.yml`、`agent.cordis.yml`、`qq-tool-restrict.mjs`），仓库一份、隔离 home 一份，桥每次启动刷新；profile overlay 由 `patchProfileCordis()` 写入 agent-presets overlay（`default: standard`、`includeUserRoot: true`），使 `qq-chat` 成为该 profile 的默认 preset。模型同步由 `syncDshAgentDefaultModel()` 与 `POST /api/bridge/config` 的漂移自愈共同保证 `settings.yaml` 的 `agent-default-model` 与管理端配置一致，改写后后台重启隔离 DSH；模型目录由管理端从 DSH 自身配置读取各服务商可用模型（`session/modelCatalog`、`settings.yaml` 的 `llm-pi-ai.providers.<id>.models`）。预设生效时点：`agentPreset` 仅在创建会话时绑定，更换 preset 后既有会话仍使用旧提示词，需等待轮换或空闲归档重建（`lib/dsh-compaction.js:293-295`）。

会话归档：桥每隔约 12 轮用户触发对话轮换一次 DSH 会话，阻塞、隔离与复读恢复同样会重建会话，因此「QQ 聊天」工作区内的 `session-*` 目录持续累积；`core/session-archive.js` 定时巡检该工作区，把已闲置的旧会话经 DSH 的 `workspace/archiveSession` 归档。安全边界为硬性约束、不提供配置项：不归档 `state.sessions` 中当前映射的会话、预热待用的 standby 会话（`st._standbySessionId`）、当前有回合运行（`TurnStartAt` / `collectors`）或正在执行发送工具链的会话；处理范围仅「QQ 聊天」工作区目录（`cfg.sessionCwd`，缺省 `state/agents`）下的 `session-*` 目录；未达到闲置时长（默认 30 分钟）不处理。默认参数取自 `session-archive.js` 的 `DEFAULTS`（`session-archive.js:29-32`）【已核验】：`intervalMs` 600 000 ms、`idleMinutes` 30、`batchMax` 20（单轮最多归档数，避免集中冲击 DSH）、`pruneDays` 0（只归档不删除数据，大于 0 时连同磁盘目录一并清理）；归档水位记于 `state/session-archive.json`。

配置热加载不更换对象引用：桥启动时 `const cfg = loadConfig()` 只读一次，该对象经 `initXxxCore(cfg)` 注入十余个模块，保存配置即时生效依赖 `watchConfigFile()` 的原地合并（`applyConfigInPlace`，`qq-bridge/src/core/config.js:467`）【已核验】；`loadConfig` 补齐全部默认键，因此目标对象中多余的键表示用户已从文件删除，同步删除以避免沿用旧值；监听方式为目录监听（`fs.watch(dir)`，按文件名过滤，mv 覆盖产生 rename 事件）与 2 000 ms 轮询（`fs.watchFile`，可跨 inode 与文件系统）双路并用（`watchConfigFile()`，`config.js:507`）【已核验】；桥内共 10 处把内存中的配置写回 `config.json`（`console-server.js` 5 处、`mux.js` 4 处、`tunables.js` 1 处），未做热加载时管理端的修改不仅不生效还会被回滚；管理端写入 `POST /api/bridge/config` 走深合并（表单只携带其编辑的片段，不整体覆盖）+ 临时文件 → 备份 → rename 原子替换；回调动作为 `dsh*` 变化 → `resetVisionModelApplications()`、`social.wake.*` 变化 → `applyOwnerWakeProbabilityToSessions()`、`dshCompaction.*` 变化 → 重写 DSH 的 `cordis.patch.yml`。【据仓库记载】测量批次 2026-09：`fs.watch(file)` 在 Linux 上监听该文件的 inode，而管理端保存走临时文件 → 备份 → mv 原子替换；07:34 装配监视器、07:39:54 由管理端执行 mv 覆盖后检索桥日志中的「已热加载」条目，条目数为 0——监视器仍指向已被 unlink 的旧 inode，此后任何改动均不产生事件直到桥重启；修正为目录监听加 2 000 ms 轮询的双路方案。

会话轮换：计数落在 `social-state.json` 的 `rotateTurns`、重启不重置；阈值为 `social.autoReset.wakeThreshold`，默认 10、下限 5，`rotateThresholdOf()` 每轮读取配置（`wake-send.js:97`）【已核验】；判定函数为 `rotationDue(key, st, cfg)`（`wake-send.js:111`）【已核验】，三个调用点共用（`wake-send` 的忙碌分支、轮换块、`turn-hold` 的保持循环）；防阻塞为推迟注入最多 `ROTATE_DEFER_MAX_MS = 120000`（`wake-send.js:75`）【已核验】，超时后 `rotationDue()` 自动改判为 `false`，即推迟轮换而不阻塞用户消息；`social.autoReset.permanent === true` 时阈值返回 `Infinity`，各处判定写作 `count >= threshold` 而恒为假，轮换块、忙碌分支、保持循环与控制台的 `[Rotate]` 收尾指令无需修改即自动停用；预热由 `createStandbySession()`（`qq-bridge/src/core/dsh-session.js:169`）【已核验】提前创建下一代会话（同工作区、同 preset、同视觉模型），不写入映射、不触发投递，首轮提示词由提供方前缀缓存命中。永久会话的成本论证见「记忆窗口与聊天记录的分离」章的命题 8.2。

凭据注入：隔离 DSH 的 provider 从环境变量读取密钥（`apiKeyEnv`）；管理端在 `startIsolatedDsh()` 时以 `loadCredentialEnv(home)` 解析 `<home>/.credentials.yaml` 的 `KEY: value` 行并合入子进程环境（去除引号、丢弃空值），因此密钥既不进入 DSH 配置文件也不进入命令行。【据仓库记载】

token 计量与对账：逐帧计量由 `core/token-meter.js` 的 `meterTokenFrame()`（`qq-bridge/src/core/token-meter.js:550`）【已核验】在事件环每帧调用一次，深度扫描（不超过 6 层，数组元素超过 200 跳过）整帧 usage 键（snake / camel 命名与 usage 对象内的键），命中且 sessionId 存在时写入 `est:false` 行；无法获取真实 usage 时按帧 transcript 字符估算，写入 `est:true` 行并附字符数；存储为 `state/token-usage.jsonl`，每行 `{tsMs, sessionId, convKey, prompt, completion, total, est, …}`；权威对账每 5 分钟及桥启动时读取 `<dshHome>/storages/session_projcache/sessions/session-*.json` 的 `record.rows.tokenUsage.val.totals`（`uncachedInputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`），与桥侧同会话累计逐桶比对、只补桥侧缺少的部分（`reconciled:true` 行）；水位为 `state/token-reconcile.json`，保证可反复执行而不重复补记，也不会因文件截断（`MAX_LINES` 裁剪）而重加历史；帧内无法获取 sessionId 时整帧丢弃；管理端「学习 / 用量」页与 `/token` 指令共用一套口径，只统计确实带缓存命中字段的请求（`cacheSamples > 0` 的小时桶），不反推不外推。金额计算由 `core/token-report.js` 与 `config.json` 的 `tokenCost` 段承担：

$$\text{cost} = \frac{\text{命中} \times p_{\text{Hit}} + \text{未命中} \times p_{\text{Miss}} + \text{输出} \times p_{\text{Out}}}{10^{6}} \times \text{peakMult}$$

高峰时段为北京时间 09:00-12:00 与 14:00-18:00，倍率为 `peakMult`。【据仓库记载】原稿记录时点的单帧漏记测量：帧内无法获取 sessionId 而丢弃该帧时，同一会话 DSH 侧累计 961 349、桥侧累计 889 248，差值 72 101（等于一个模型步的量），对账机制用于补齐该类缺口。

### 隔离实例的解析与安装

`qq-bridge/src/lib/dsh-side.js`（613 行）负责定位并安装隔离 DSH：目标解析 `resolveDshTarget`（`:57-74`）；管理器隔离目录 `readManagerIsolatedHome`（`:77-87`）；预设安装 `installPresets`（`:150`，只安装 `qq-chat` 一个预设）；预设覆盖同步 `syncPresetOverrides`（`:157-166`，调用点 `:162`）；内置插件 `ensureBuiltinPlugins`；安装版本 `INSTALL_VERSION = 1`（`:25`）；MCP 挂载块 `mcpBlock()`（`:252-299`，三个 server 与压缩代理）；覆盖层 `:311-316` 为 `{default: 'standard', includeUserRoot: true}`。安装流程在桥启动时以异步非阻塞方式执行（`void (async () => { … })()`，`qq-bridge/src/bridge.js:274-309`），顺序为 `resolveDshTarget()` → `installPresets(target)` → `watchOverrideFiles(...)` → `ensureBuiltinPlugins(target)` → `isInstalled(target)` → `installToIsolatedDsh()`【已核验】。预设覆盖文件变更时监听后重新同步（`qq-bridge/src/lib/dsh-side.js:157-166`）。

### 会话创建与视觉模型

`ensureSession`（`qq-bridge/src/core/dsh-session.js:79`，文件 205 行）保证每个会话键对应一个 DSH 会话 id：视觉模型准备 `ensureVisionModel`（`:38-77`，provider 默认 `deepseek-official` `:41`、model 默认 `deepseek-v4-flash-vision-exp` `:42`，按档位计划依次尝试，失败重试 2 次 `:51-76`）；会话世代 `sessionEpoch`（`:13`）与 `bumpSessionEpoch`（`:15`，会话更换时递增，用于丢弃过期回调）；并发去重 `:113`、`:154-159`（同一会话键的并发创建合并为一次）；备用会话 `createStandbySession`（`:169-205`，减少首次唤醒延迟）；丢弃文案 `:142-146`（会话已更换时丢弃本轮结果）。预设档位的选择依据为 `modePreset`（`qq-bridge/src/core/mode.js:35-37`），当前模式集合只有 `default`【已核验】。

会话映射与自愈：映射表 `state/sessions.json`（现场 20 字节）；落盘走临时文件加原子重命名（`qq-bridge/src/core/config.js:440`、`:448-452`）；启动自愈剔除磁盘上不存在的 `sessionId` 并回写（`qq-bridge/src/bridge.js:490-512`）；`quarantineSession` 删除映射并置 `_quarantineRebuilt`（`qq-bridge/src/core/turn-guard.js:56-106`）；会话更换路径为 `/reset`、`/new` 与轮换阈值。

### 桥启动装配顺序

`main()`（`qq-bridge/src/bridge.js:270`）的顺序为【已核验】：

1. `loadConfig()` `:271`；隔离 DSH 自安装（异步非阻塞）`:274-309`。
2. `initMuxCore` → `initConsoleCore` → `mkdirSync(STATE_DIR)` → `acquireLock()` → `loadState()` `:310-314`。
3. 核心模块初始化 `initStickerCore`、`initDocxCore`、`initQqSendCore`、`setTunableCfg`、`initQzoneCore`、`initEventsAuxCore`、`initMemoryCore`、`initWakeCore`、`setWakeDeliver(deliverPrompt)`、`initGroupCacheCore`、`initSocialCore` `:315-325`；`startDeliveryWatchdog()` `:329`。
4. `initModeCore`、`initDshWatchCore`、`initCrossChatCore`、`initAuditCore`、`initDshSessionCore`、`initSlangCore`、`initPersonaLearnCore`、`initVoiceCore`、`initNapcatTokens`（内含 `backupLoginTickets()`）、`initNapcatGuard`、`initSendDice`、`initTokenMeter`、`initTokenReportCore` `:330-348`。
5. `setDshSideConfig(cfg)` → `patchProfileCordis(resolveDshTarget())` `:351-352`；用量对账 `setTokenReconcileHome(...)` + `startTokenReconcile()` `:359-360`；剪枝计量 `initContextSavings(...)` + 首次 `reconcileContextSavings(...)` `:380-394`。
6. 会话与投递 `initSessionArchiveCore` → `setConvKeyResolver` → `initPromptDeliverCore` → `initSocialFlowCore` → `initMediaPipeCore` → `initVisionCore` `:395-400`；`syncDshCompactionPatch({...})` `:409`；领域接线 `setScheduledRecorder(recordSentMessages)`、`setWakeSender(sendWakePrompt)`、`setSteerSender(steerIntoRunningTurn)`、`createMediaDomain(cfg)`、`setConsoleMedia(...)` `:422-429`。
7. Pixiv `startPixivCookieWatch({...})` `:434`、`startPixivTokenRefresh({ logger })` `:446`；`new NodeApiClient(cfg.dsh.baseUrl, undefined, { dshLogFile, seqFile: state/dsh-seq.json })` → 各 `setXxxApi` → `initPersonaAutoLearn` → `initPortraitLearn()` → `ensureLearningToken()` `:463-476`。
8. 会话映射自愈 → `loadSocialState()` → 同步插话概率 → 标记人设补注入 `:490-512`、`:544`、`:552`、`:560`；`new OneBotWsClient({ url, accessToken, reconnect: true })` 与各 `setXxxBot` `:565-580`；事件订阅见「消息接收与唤醒」章的「入站主链」节。
9. WS 事件 `on('open')` 置 `napcatUp` 并强制重探登录，`on('close')` 清理并重探，`on('error')` 记录 `message`、`code`、`cause.code`、`cause.message`；登录态巡检已删除（`const loginWatch = null; void loginWatch;` `:666-667`，说明注释 `:659-665`）。
10. `connectNapcat(budgetMs)` `:676-691`、`:696-709`：`error.code === 'NAPCAT_CONN'` 时退避 `min(15000, 1500 * attempt)`，预算默认 `120000`（`cfg.social?.napcatStartupBudgetMs`，字面值位于调用点 `:692`）；连接失败不退出，后台每 15 秒重连。
11. 日志 `桥接已启动。按 Ctrl+C 退出。` 后恢复持久任务 `loadScheduledTasks()`、`loadDocxQuota()`、`loadActivityWindows()`、`startActivityTick()`、`loadArchivedCache()`、`startSessionArchiveTicker()`、`syncStickerLibrary(true)`、`startDshWatch()`、`startNapcatGuard()`、`startConsoleServer()` `:727`、`:729-742`。
12. `watchConfigFile(cfg, { onChange })` `:747`：`dsh*` 变更清模型缓存，`social.wake*` 同步概率，`dshCompaction*` 重写补丁，`social.autoReset.permanent` 只记日志。
13. `initSlangNightly(cfg)` `:784` → `await pumpMux();` `:786`（事件泵主循环，不返回）。
14. 退出钩子：`SIGINT`（`saveState()`、`releaseLock()`、`process.exit(0)`）`:789`、`SIGTERM` `:795`、`unhandledRejection` `:800`、`process.on('exit')` `:801`、`main().catch` `:813`。

### DSH 客户端协议

`qq-bridge/src/dsh-client.js`（600 行）：结果解包 `unwrap`（`:96-100`，`response.result.ok` 为假时抛错）；令牌缓存 `:200`（鉴权结果缓存 55 秒）；令牌扫描步长 `TOKEN_SCAN_STEPS`（`:63`，256K、1M、4M、16M）；请求体构造 `:225-245`；各方法超时为 `sessions.create` `:253` 30000、`prompt` `:263` 30000、`cancel` `:276` 10000、`sessions.rename` `:282-284` 10000、`attachment` `:286` 60000、`workspace.create` `:294` 30000、`workspace.archiveSession` `:300` 15000、`workspace/list` `:305-309`（无对应端点时本地构造返回值）、`host.describe` `:317` 15000；事件订阅 `:399`（`session/follow`）；快照重建 `:488-521`（断线后按序号补齐）；序号重置 `:30`、`:38-40`（`SEQ_RESET_GAP = 100`、`shouldResetSeqWatermark`）；序号水位 `qq-bridge/state/dsh-seq.json` 由桥启动装配注入（`qq-bridge/src/bridge.js:463-466`）。`sessions.rename` 在桥内未见调用点，会话标题当前依赖工作区分组【未核验】。

### 预设与工具白名单

预设目录为 `qq-bridge/dsh/agent-presets/qq-chat/`：`agent.cordis.yml` 43,952 字节 / 215 行（预设主体，工具结果剪枝子插件参数 `thresholdChars: 25000`、`headChars: 22800`、`tailChars: 2000` 位于 `:212-215`）；`preset.yml` 235 字节 / 3 行（`name: QQ 聊天角色`、`order: 10`）；`qq-tool-restrict.mjs` 4,905 字节 / 94 行（工具白名单插件）。

`qq-tool-restrict.mjs` 的白名单常量 `SAFE_PREFIXES` 位于 `:39-43`，`SAFE_EXACT` 位于 `:56-59`；`apply(ctx)` 分两步（`:66-84`、`:87-93`），其中日志截断为 `slice(0, 160)`（`:82`）；被显式排除的开发类工具名共 23 个（`:12-34`）【已核验】。该预设未挂载 `dsh-tool-ask-user` 与 `dsh-tool-todo`，相关说明以注释形式存在（`:187-195`）【已核验】。工具注册受三道限制：档位裁剪 `toolAllowedByTier`（`qq-bridge/src/mcp-napcat-safe.js:741`）、配置开关（35 处 `if (cfg.social.tools.* / sticker / meme)` 分支）、预设白名单（`SAFE_PREFIXES` 与 `SAFE_EXACT` 之外的工具被拒绝）。

### 宿主服务工具

`qq-bridge/src/mcp-host-server.js`（344 行）注册 5 个工具供隔离 DSH 侧调用：`qq_learning_corpus` `:142`（见「记忆、检索与学习」章的「语料入口」节）、`qq_learning_submit` `:198`（学习结果提交）、`napcat_status` `:247`（NapCat 进程状态查询）、`start_napcat` `:264`、`stop_napcat` `:314`；注册条件为 `allowProcessControl === true`。令牌读取点位于 `:65`，读取文件 `qq-bridge/state/console-token`【已核验】。

`napcat_status` 的附加字段（启动器路径、home 目录、进程号）受 `bridgeModeAllowsProcessControl()`（`:73-86`）约束：该函数读取 `GET http://127.0.0.1:<consolePort>/api/status` 并要求 `body?.mode === 'default'`【已核验】，而桥控制台 `/api/status` 的响应体字段为 `role`、`roleMode`、`dshReady`、`ownerQQ`、`allowGroups`、`allowPrivate`、`socialPaused`、`activity`（`qq-bridge/src/core/console-server.js:768-780`），不含顶层 `mode` 字段【已核验】。因此该闸门的判定输入恒不满足，结论为恒 false：即使 `napcat.allowProcessControl` 为真，`napcat_status` 也不会附带进程控制字段，`start_napcat` 与 `stop_napcat` 会进入拒绝分支【已核验】。现场 `qq-bridge/config.json` 的 `napcat.allowProcessControl` 为 `false`【已核验】。

### 会话归档

`qq-bridge/src/core/session-archive.js`（432 行）归档空闲会话，默认参数位于 `:27-33`（`enabled`、`intervalMs`、`idleMinutes`、`batchMax`、`pruneDays`，取值见本章「会话、预设、热加载与计量」节）；工作区判定 `:71-83`（只归档桥自建工作区内的会话）；sessions 根候选 `:106-140`（顺序为 `QB_DSH_HOME`、`DSH_ISOLATED_HOME`、`.runtime`、管理器配置、`DSH_HOME`、管理器目录扫描）；磁盘存活判定 `liveSessionIdsOnDisk` `:207-220`；保护名单 `protectedSessionIds` `:239-267`（含学习会话）；归档执行 `archiveIdleSessions` `:279-391`；定时器 `startSessionArchiveTicker` `:394-410`（`setInterval` 位于 `:406-409`，首次扫描延迟 90 秒 `:404`；停止函数 `:412-414`）。

### 失败与降级

- 会话创建失败：`unwrap` 抛错，本轮唤醒失败并记日志（`qq-bridge/src/dsh-client.js:96-100`）。
- 会话已更换：丢弃本轮回调结果（`qq-bridge/src/core/dsh-session.js:142-146`）。
- 事件流断线：按序号水位重建快照（`qq-bridge/src/dsh-client.js:488-521`）。
- 学习会话被回收：登记为持久学习者以避免回收（`qq-bridge/src/core/persona-learn.js`）。

未核验：`workspace/list` 的本地构造返回值与真实端点的字段差异未核实；运行期隔离 home 下存在与 `qq-chat` 同哈希的其它预设目录，生成该目录的代码在仓库内未找到；仓库与安装副本之间预设文件的差异未做剥离合成段后的比对；`qq-bridge/state/session-archive.json` 在现场不存在，归档缓存的实际落盘位置未核验【未核验】。

## 9. 打包与分发

安装包与 Electron 壳由仓库外的打包工程产出；本机安装链路与 SSH 克隆部署链路互不依赖。`C:\Users\17367\Desktop\QQ-Bridge-packaging` 为打包工程根（NSIS 脚本、壳源码、装配产物），不在本仓库，其中 `build-installer-full.nsi` 为 NSIS 安装包脚本（输出 `MoonBot Pro Setup.exe`）、`moonbot-app\main.js` 为 Electron 壳主进程、`full\app\` 为被装配的运行树（`server/`、`dist/`、`qq-bridge/`、`dsh/`、`napcat-onekey/`、`qbm-node.exe`）；`C:\Users\17367\Desktop\MoonBot Public` 为源码仓库（运行时代码来源），在本仓库；`D:\MoonBot\resources\runtime` 为本机已安装副本（一份运行树拷贝，内容可能与源码树不同），不在本仓库。

打包侧已核对的事实（依据 `build-installer-full.nsi` 与 `moonbot-app/main.js`）：安装包由 NSIS 3 构建，输出 `MoonBot Pro Setup.exe`，默认安装到 `%LOCALAPPDATA%\Programs\MoonBot`，`RequestExecutionLevel user`；安装包分为三个 Section——核心管理端（必需）、运行时层（桥 + DSH + NapCat，整块可选）、桌面快捷方式（可选）；核心管理端安装 `server/`、`dist/`、`node_modules/`、`qbm-node.exe`、`start-manager.vbs`、`start-debug.cmd`、`app.ico`；运行时层安装到 `$INSTDIR\qq-bridge`、`$INSTDIR\dsh`、`$INSTDIR\napcat-onekey`；卸载脚本只终止路径位于本安装目录下的 `qbm-node` / `NapCatWinBootMain` / `QQ` 进程（`$_.Path -like '$INSTDIR*'`）；壳主进程以随包 `qbm-node.exe` 隐藏启动后端（`server/index.js`，`127.0.0.1:1921`），轮询后端就绪后以独立 `BrowserWindow` 加载本地界面（`main.js` 头部注释与 `loadURL(urlFor(backendPort))`）；端口可退避——`QBM_API_PORT` 环境变量传入，1921 被无关程序占用时改用备用端口，不抢占其它进程的端口，只复用可确认属于自身的后端；关窗顺序为先 `POST /api/shutdown`（8~12 秒超时）请求收尾、再 `taskkill /pid <后端> /T /F`、最后由后端自带的守卫进程承担后备清理（`main.js` 的 `requestGracefulShutdown()` / `shutdownEverything()`）；壳文件名必须为 `MoonBot`（`win.executableName`），因为 `server/index.js` 的守卫按进程名 `/^MoonBot$/i` 识别应用本体；应用单实例由 `app.requestSingleInstanceLock()` 保证。

运行时侧对应实现：`qbm-node.exe`（随包 Node 运行时）对应「全部子进程以 `process.execPath` 启动」（DSH、桥、守卫、隐藏器），`process.execPath` 自身为 node 时 `--expose-internals` 一类命令行标志才可用；`$INSTDIR\server` 对应 `RUNTIME_ROOT` 为 `server/index.js` 的上两级目录（NSIS 布局下即 `$INSTDIR`，electron-builder 布局下为 `resources\runtime`，本机 `D:\MoonBot\resources\runtime` 即该形态）；`$INSTDIR\dsh` 对应随包 DSH CLI，管理端配置项 `instances.dshIsolated.dshCli` 指向它（本机实测值形如 `D:\MoonBot\resources\runtime\dsh\node_modules\.bin\dsh.cmd`）；`$INSTDIR\napcat-onekey` 对应 `findNapcatOneKeyAll()` 的首个候选根；`start-manager.vbs` 隐藏启动壳与后端以避免产生控制台窗口（仓库内另有 `tools/start-manager-hidden.vbs`、`tools/restart-manager.ps1` 供开发使用）；「卸载时按路径终止进程」与「不处理用户本机已安装的 QQ」同源，只匹配安装目录前缀。目录命名差异：仓库内 `dsh-runtime/` 在安装树内为 `dsh/`。【未核验】映射规则位于打包工程内部，本文不做推断。

分发链：源码仓库 → 打包工程装配 `full\app\`（`server/` + `dist/` + `qq-bridge/` + `dsh/` + `napcat-onekey/` + `qbm-node.exe`）→ 打包工程产出 `MoonBot Pro Setup.exe` → 安装到 `%LOCALAPPDATA%\Programs\MoonBot` 或自定义目录 → 首次启动（壳启动后端 → 前端引导）；另有独立的 SSH 克隆部署链，把已运行的主机复制到另一台 Linux 主机。

## 10. 可靠性与可观测性

日志面：管理端主日志 `%USERPROFILE%\.qq-bridge-manager\logs\manager.log` 由 `mlog()` 写入启停、探活、单点登录闸门、守卫武装、模型同步、凭据写入与 SSH 部署摘要；实例日志位于同目录（`instanceLogPath(id)`），由子进程标准输出与错误直写，内容为 DSH、桥、NapCat 各自的全部输出；关窗守卫日志为同目录 `napcat-guardian.log`，由守卫进程写入武装信息、父进程消失与三段清理结果；桥主日志为 `qq-bridge/state/bridge.log`，由 `lib/log.js` 的 `log()` 写入；会话活动流水为 `qq-bridge/state/qq-activity.log`，由 `lib/log.js` 的 `appendActivity()`（`qq-bridge/src/lib/log.js:20`）【已核验】写入每个会话的活动记录；工具调用流水为 `qq-bridge/state/tool-calls.jsonl`，由 `core/audit.js` 的 `appendToolLog()`（`qq-bridge/src/core/audit.js:76`）【已核验】写入工具名、参数摘要与结果，供档位统计与排障；运维输出为目标机 `/root/.dsh/dsh-web.log` 与 systemd journal，由部署侧服务写入。【据仓库记载】原稿记录时点，早期实现以管道转发子进程输出，重启管理器或对其执行 `taskkill` 后管道读端消失，子进程下一次写标准输出产生 EPIPE，Node 对标准输出的未处理错误会终止进程，表现为重启管理器后桥消失且日志无错误行；实现改为实例日志直写文件，桥侧另装 EPIPE 守卫。

审计：`core/audit.js` 承担出站审计与静默拦截，模型待发出的正文先经敏感内容检测（`sensitiveHitKind` / `SENSITIVE_RE`）与令牌泄露检测（`tokenDisclosureIn`），需要拦截时按角色状态与静默模式决定「拦下」或「只记录」；`shouldAuditKey()` 当前对所有会话返回 `true`（早期「所有者私聊跳过」的特判已删除）。发送类工具的判定链为 MCP 工具 → 桥控制台或 OneBot → `qq-send.js` 的 `onebotSend`（`qq-bridge/src/core/qq-send.js:166`）【已核验】，后者是所有模型正文的唯一出口，幂等闸门（`send-idempotency.js`）与节奏控制（`lib/onebot-delivery.js`、`lib/send-gaps.js`）均挂载在其之前。【据仓库记载】

崩溃自愈场景与手段：

| 场景 | 自愈手段 |
| --- | --- |
| 管理器进程内未捕获异常 | 顶层 `unhandledRejection` / `uncaughtException` 守卫记录日志，保持后端存活 |
| 管理器被重启 | 子进程日志改为直写文件；`startInstanceTracked()` 经探活把仍在运行的实例认回，不重复拉起 |
| 桥重启 / 桥进程重复 | `dsh-seq.json` 水位防止事件重放；`sessions.json` 启动时剔除磁盘上已不存在的会话映射，避免每秒重开失效会话；`state/bridge.lock` 单实例锁（PID 校验，进程崩溃后锁自动失效） |
| 会话阻塞 | `turn-guard.js` 的静默与总时长看门狗，配合 `quarantineSession()` 隔离重建 |
| DSH settings 漂移 / DSH 会话堆积 | 保存配置时自愈改写并重启隔离 DSH；空闲会话自动归档 |
| NapCat 文件缺失 / 应用退出但 NapCat 残留 | `napcat-repair.js` 从 `NapCat.Shell.zip` 补齐；关窗守卫清理 |
| SSH 隧道静默失效 / 配置热加载失效 / token 计量缺口 | `ensureTunnels()` 每次重建缺失隧道；目录监听与 2 000 ms 轮询双路并用；DSH 权威计数对账补记 |
| 配置被半截写入 / 标准输出断裂 | 全部配置写入走临时文件 + 备份 + rename，状态 JSON 走 `atomicWriteJson`（`qq-bridge/src/lib/json-fs.js:21`）【已核验】；实例日志直写与桥侧 EPIPE 守卫 |

一致做法的三类来源（成因来自仓库注释中记录的同型问题）：开关型配置只在部分路径生效（如 `killOnExit` 必须同时传给守卫，否则打包版中的开关不产生效果），对应做法为开关要么全链路生效、要么明确标注不生效；轮换计数持续增长而无执行者（回合保持与 `rotationDone` 的接线断开），对应做法为每个提前返回均写日志；探测型逻辑占用配额（NapCat 登录接口限流，与 WebUI 页面共用额度），对应做法为探测类行为默认不做、状态未知时不阻断操作、宁可跳过不误伤。

## 11. 关键不变量

判据列给出保证该不变量的实现位置或判定函数；违反后果列用于判定一次变更是否属于缺陷。

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

架构侧的未核验项与开放问题见附录 D 的统一清单（编号 U-29 至 U-37），此处不再重复。

已结案的不一致（更正以工作树状态为准）：

- 2026-09-25：`lib/dsh-side.js` 注释与桥侧两份已并入根 `README.md` 的文档中的隔离实例端口原记 `13210`，工作树无对应实现，已统一改为 `10721`，实际取值来自 `instances.dshIsolated.port`（目标机为 3080）
- 2026-09-25：窗口隐藏器注释原记「观察 120 秒」，与 `QQ_HIDER_DEFAULTS.budgetMs = 43200000` 不符，`server/index.js` 两处注释改为「12 小时」，退出条件归属父进程守卫
- 2026-09-25：`server/napcat-webui-auth.js` 原稿记载为「唯一允许调用 `POST /api/auth/login` 的位置」，工作树中该文件不存在，职能由「不使用登录接口作探测手段」策略取代
- 2026-09-24：`qq_send_burst` 曾计入工具表，该工具已移除；工具表以 `state/tool-schema-stats.json` 的 `registered` 与 `available` 为准

## 13. 形式模型与闸门序列

### 13.1 会话、回合与水位

会话键取值集合为 `{group:<QQ群号>} ∪ {private:<QQ号>}`，由 `qq-bridge/src/core/mode.js:40-44` 的 `^(group|private):(\d+)$` 解析【已核验】。会话分两级状态：内存态为 `Map`/`Set` 集合共 31 项（`qq-bridge/src/core/session-state.js`【已核验】），其中内存媒体表 `:80`、投递队列 `:38-40`、并发去重表 `sessionPromises` `:10`、长轮询守卫 `activeWaits` `:24`、反向索引 `reverse` `:30`；持久态为 `state/social-state.json` 的 `conversations[key]`（36 键，载入时另构造 4 个仅内存字段，`qq-bridge/src/core/social-state.js:342-400`、`:604-661`【已核验】）。会话映射 `state/sessions.json` 形如 `{"sessions": {"<key>": "<sessionId>"}}`（`qq-bridge/src/lib/paths.js:9`、`qq-bridge/src/core/config.js:440`【已核验】）。

回合与步的守卫量（毫秒）：长轮询回合上限 `11 * 60 * 1000`（`qq-bridge/src/core/turn-guard.js:21`）；投递超时 `30000`（`qq-bridge/src/core/prompt-deliver.js:165`）；会话隔离 `quarantineSession` 拒绝未投递项、清回合状态、删除会话映射（`qq-bridge/src/core/turn-guard.js:56-106`）；轮换阈值 `max(5, social.autoReset.wakeThreshold || 10)`，`permanent` 为真时取 `Infinity`（`qq-bridge/src/core/wake-send.js:95-97`）；轮换推迟上限 `120000`（`:75`）【已核验】。

水位均为单调量：未读水位 `lastAiSeenAt`（`qq-bridge/src/core/wake-send.js:1316-1334`）；展示水位 `turnSeenUnread` 快照 `snapMax`（`qq-bridge/src/core/console-server.js:1759-1766`）与推迟交付集 `_steerDeferredSeqs`（`:1767-1779`）；令牌对账水位 `state/token-reconcile.json`，每会话四桶累计 `prompt`/`completion`/`cacheRead`/`cacheWrite`（`qq-bridge/src/core/token-meter.js:841-863`）；序号水位 `state/dsh-seq.json`，重置间隔 `SEQ_RESET_GAP = 100`（`qq-bridge/src/dsh-client.js:30/38-40`）；学习水位 `state/learning-config.json` 的 `slang.lastLearnAtMs` 与 `persona.lastRunAtMs`（`qq-bridge/src/core/console-server.js:285-303`）；已回复账本由 `/reset` 经 `resetConversationKeepingLedger` 保留【据仓库记载】。以上水位除标注外均【已核验】。

### 13.2 唤醒与投递

投递的传输形式为 DSH 的 `session/prompt` 调用，`mode` 恒为 `'steer'`【已核验】（`qq-bridge/src/core/prompt-deliver.js:165`）。依据记录于同文件 `:144-164`：`queue` 对应 `next-turn` 队列，当前回合未结束时不会取出；`steer` 对应 `next-step` 队列，`inbox.claim()` 优先取 `next-step`，故会话忙闲均可取出【据仓库记载】。学习链路使用 `mode: 'queue'`，与聊天不同【已核验】。

模型正挂起 `qq_wait_for_messages` 长轮询时存在不经队列的快路径：入站消息作为工具结果直接返回，由 `activeWaits` 守卫拦截投递【已核验】（`qq-bridge/src/core/session-state.js:24`）。

### 13.3 入站闸门序列

入站消息在到达模型前依次通过下列闸门，任一拒绝即终止该条消息：

1. 白名单 `allowed(kind, id, cfg)`
2. 正文抽取 `textContent` / `plainContent`：无正文则不参与唤醒判定
3. 好友守卫 `ALARM_RE`（`qq-bridge/src/core/mux.js:273/319`）
4. 媒体落库 `messageMediaStore`：媒体不进入本轮唤醒
5. 去重 `INBOUND_DEDUP_TTL_MS` / `INBOUND_DEDUP_MAX`
6. 挂起应答 `handlePendingAnswer`
7. 静默 `deepsleep` 状态
8. 命令分支（正文以 `/` 开头）
9. 会话准入 `isSessionAllowedInCurrentMode(key)`（`qq-bridge/src/core/wake-send.js:1281-1284`）

出站方向另有互不合并的两道闸门：发送端点的敏感内容判定（`qq-bridge/src/core/console-server.js:1191/2137/2488/5180`）与发送出口的令牌泄露判定（`qq-bridge/src/core/qq-send.js:197-201`）【已核验】。

### 13.4 状态机取值

运行模式仅 `default`（`VALID_MODES = ['default']`，`setCurrentMode()` 为空函数，`qq-bridge/src/core/mode.js:7/21`）；客户端连接 `connecting` → `open` → `close` → 后台重连（`qq-bridge/src/lib/onebot-ws.js`）；黑话词条状态 `candidate` / `confirmed` / `rejected`，只允许向上迁移（`qq-bridge/src/slang-learner.js:15-19`）；黑话学习相位 `idle` → `disabled` → `extracting` → `stopping` → `queued` → `researching` → `ready`（`qq-bridge/src/core/slang.js:637-642`）；远端连接相位 `idle` / `connecting` / `tunnels` / `server-starting` / `warming` / `ready` / `failed`（`server/connect-machine.js:19`）；远端组件状态 `ready` / `starting` / `down`（`server/connect-machine.js:35-73`）；卡片投递档位 `primary` / `native` / `link`（`qq-bridge/src/core/media.js:276-308`）；图片档位 `original` / `master` / `thumb` / `unknown`（`qq-bridge/src/lib/pixiv.js:207`）；发送确认 已送达 / 未确认（`unconfirmed: true`，`qq-bridge/src/lib/onebot-delivery.js:52`）；会话守护判定 `removed`（守护已停用，`enabled: false`、`autoHeal: false`，`qq-bridge/src/core/napcat-guard.js`）。以上均【已核验】。

## 14. 消息接收与唤醒

### 14.1 入站主链

入口为 `handleIncoming`（`qq-bridge/src/core/mux.js:299`），由 `OneBotWsClient` 事件回调驱动，订阅点位于 `qq-bridge/src/bridge.js:581`（私聊）、`:585`（群）、`:589`（通知）、`:595`（撤回）、`:622`（好友请求）【已核验】。各阶段行为与常量：

- 白名单 `allowed(kind, id, cfg)`（`qq-bridge/src/lib/config.js`）：`deny` 优先于 `allow`；两侧名单为空且 `allowAllWhenEmpty` 为真时放行并产生告警日志。
- 正文抽取 `textContent` / `plainContent`：抽取纯文本用于唤醒判定与去重；含 `[CQ:` 的段与转发段不进入语料。
- 好友守卫 `ALARM_RE`（`qq-bridge/src/core/mux.js:273`，判定点 `:319`）：非受信任者的违法或营销内容触发删除好友与拉黑，开关 `social.autoFriendGuard`。
- 媒体落库 `messageMediaStore`（`qq-bridge/src/core/session-state.js:80`）：图片、文件、语音进入内存媒体表，供本轮唤醒附图。
- 去重 `INBOUND_DEDUP_TTL_MS`、`INBOUND_DEDUP_MAX`（`qq-bridge/src/core/mux.js:278-279`），取值 `10 * 60 * 1000` 与 `800`；窗口内同一条消息只处理一次。
- 挂起应答 `handlePendingAnswer`（`qq-bridge/src/core/events-aux.js:44`）：上一轮登记 `pending` 时本条视为回答；超时按 `cfgRef.questionTimeoutMs` 回复取消提示。
- 静默闸门 `deepsleep`：命中后只向 `state/qq-activity.log` 写一行并结束。
- 斜杠命令：见「消息接收与唤醒」章的「读取接口鉴权与桥侧命令」节。
- 唤醒调度 `evaluateWakeTrigger`（`:753`）→ `scheduleWake`（`:755`）：`!st.bootstrapSent` 时走 `bootstrap` 分支，否则使用判定出的 reason。

### 14.2 会话状态写入

`appendSocialMessage`（`qq-bridge/src/core/social-flow.js:14`）在单次调用中完成两项写入：更新内存窗口 `st.recentMessages`，并调用 `persistChatMessage`（`qq-bridge/src/core/chat-db.js:619`）落入 `state/chat.db`【据仓库记载】。内存窗口容量为 `social.context.recentLimit`（默认 100，`qq-bridge/src/core/config.js:280`），持久化时保留末 200 条（`qq-bridge/src/core/social-state.js:348`）【已核验】。两套存储的数据域、检索算法与写入接口不同，混用会导致窗口与历史不一致。

### 14.3 读取类工具

`qq-bridge/src/mcp-napcat-safe.js:1025-1549` 区间注册的读取类工具共 10 条（判据为该区间的 `registerTool` 调用点）【已核验】。

| 工具 | 注册行 | 数据源与约束 |
| --- | --- | --- |
| `qq_get_prompt` | `:1025` | `state/social-state.json` 与角色库；返回值受 `dshCompaction.toolResultMaxChars` 约束，现值 `8192`（`qq-bridge/src/core/config.js:65`） |
| `qq_get_unread_messages` | `:1039` | `st.unread`；唤醒正文未携带未读时的补充读取 |
| `qq_get_recent_messages` | `:1053` | `st.recentMessages`；`limit` 默认 20、上限 100（`qq-bridge/src/core/console-server.js:1693`），`offset` 仅在窗口内移动（`:1703-1705`） |
| `qq_social_state` | `:1073` | `wakeConfig` 与 `state/social-state.json` |
| `qq_global_overview` | `:1087` | 汇总全部会话活动与唤醒模式 |
| `qq_mark_read` | `:1249` | `POST /api/social/mark-read`；保留 `seq > snapMax` 的未读，无展示水位时按 `_steerDeferredSeqs` 保留推迟交付项（`qq-bridge/src/core/console-server.js:1759-1779`），收尾置 `wakeConfig.infinite`（`:1785-1790`） |
| `qq_get_my_recent_messages` | `:1489` | `direction='out'`；撤回操作的消息 id 来源之一 |
| `qq_get_message_detail` | `:1507` | 窗口与 `state/chat.db`；撤回、拍一拍、收藏表情均需先取得该 id |
| `qq_get_file_content` | `:1525` | 本地与 NapCat 文件；读取字节数由 `clampReadBytes` 限制【据仓库记载】 |
| `qq_get_active_members` | `:1549` | `st` 活跃统计；精简工具档位下进入 `deny` 名单 |

### 14.4 读取接口鉴权与桥侧命令

全部读取端点经同一组三道判定：会话令牌 `x-agent-token`、`SessionAllowed(key)`、`ToolEnabled(name)`【已核验】。授权等级 `trustLevelForToken`（`qq-bridge/src/core/console-server.js:269`）返回 `owner-private` 或 `trusted-spoke-here`；信任窗口 `TRUST_SPOKE_WINDOW_MS`（`:249`）为 `600000`；空令牌 `:714-717` 返 HTTP 403、非 JSON 请求体 `:698-700` 返 415、跨 Origin `:702-710` 返 403；工具开关 `ToolEnabled`（`:576`）判定式 `cfgRef.social?.tools?.[flag] !== false`；全局暂停（`social.paused` 或 `cfgRef.social.enabled === false`）封禁 `/api/social`、`/api/send`、`/api/images` 三组端点，仅对 agent 令牌生效。

斜杠命令由 `qq-bridge/src/core/mux.js` 的命令分支直接执行，不进入模型，日志前缀 `[command]`【已核验】：

- `/reset`、`/new`：更换 DSH 会话，清理该会话的内存状态与定时器，保留已回复账本（`resetConversationKeepingLedger`）。
- `/status`：输出当前 `sessionId`、白名单判定结果、角色与模式。
- `/token [天数]`：输出用量与费用。
- `/op [del] <QQ号或昵称>`：设置或取消管理员，仅所有者私聊可用，昵称经 `resolveNameToUid` 解析。
- `/role …`、`/slang …`：角色与黑话学习入口，内部再次判定管理员。
- `/set active`、`/set diving`：直接改写本会话 `wakeConfig.mode`。
- `/sleep`、`/wake`、`/deepsleep`、`/start`、`/like`：睡眠、唤醒、深层静默、启动、点赞。

非管理员发送任何以 `/` 开头的命令时，桥回复管理员限定提示并终止处理【据仓库记载】。`/help` 已删除，当前按其它 `/xxx` 的通用规则交给模型回应【据仓库记载】。

### 14.5 失败与降级

- 聊天记录库不可用：读接口返回 `{ok:false,error:'聊天记录库不可用'}`，写路径静默返回（`qq-bridge/src/core/chat-db.js:142`）。
- FTS5 不可用：`ftsUsable()` 为假时退回 `content LIKE ?`，响应体不再带 `ranked` 字段（`qq-bridge/src/core/chat-db.js:155`）。
- 会话映射与磁盘不一致：启动时剔除磁盘上不存在的 `sessionId` 并回写（`qq-bridge/src/bridge.js:490-512`）。
- 双实例启动：锁冲突时输出提示并 `process.exit(2)`（`qq-bridge/src/core/runtime.js:13/38/53`）；单实例锁读取失败 `process.exit(1)`（`:45`）。
- 白名单两侧为空：放行全部并产生告警日志（`qq-bridge/src/lib/config.js` 的 `allowAllWhenEmpty`）。

## 15. 生成、闸门与投递

### 15.1 出站唯一出口

全部消息发送均经 `onebotSend`（`qq-bridge/src/core/qq-send.js`），按 `message_type` 构造 OneBot 动作与参数并在超时前保持等待：单次发送超时 `SEND_TIMEOUT_MS = 15000`（`:24`）；连接类失败与特定错误码的重试前等待均为 2500 毫秒（`:315`、`:331`）；重试触发的错误模式 `/1006514|网络连接异常/`（`:329`）与 `/Get Uid Error|uid.*(not found|invalid)/`（`:368`）；未确认送达返回 `{message_id:null, messageId:null, unconfirmed:true}`（`:389`，结构定义于 `qq-bridge/src/lib/onebot-delivery.js:52`）；令牌泄露判定 `tokenDisclosureIn(message)` 抛 `发送内容疑似泄露会话令牌，已阻止发送`（`:197-201`）。未确认送达既不计成功也不计失败，语义为已投出、回执未到【已核验】。

### 15.2 串行链、幂等与节拍

`enqueueSend`（`qq-bridge/src/core/send-chain.js:61`）按会话键串行化发送任务；重放窗口 `REPLAY_WINDOW_MS = 180000`（`qq-bridge/src/core/send-idempotency.js:40`），已送达保留条数 `DELIVERED_KEEP = 50`（`:42`）。

节拍由两条独立规则叠加：下限来自 `clampGap`，字数控延迟来自线性节拍。

| 参数 | 默认值 | 现场值 |
| --- | --- | --- |
| `linearEnabled` / `enabled` | `true` | `true` |
| `linearPerCharMs` / `perCharMs` | `150` | `150` |
| `linearMinMs` / `minMs` | `250` | `250` |
| `linearCapMs` / `capMs` | `4000` | `1500` |
| `linearJitterRatio` / `jitterRatio` | `0.25` | `0.25` |
| `linearResetMs` / `resetMs` | `60000` | `20000` |
| 最小间隔 `MIN_GAP_MS` | `100` | — |
| 间隔上限 `maxGapMs` | `10000` | `15000` |

默认值定义于 `qq-bridge/src/core/send-chain.js:108-115`；最小间隔定义于 `qq-bridge/src/lib/send-gaps.js:12`；`clampGap` 区间为 `[MIN_GAP_MS, max(MIN_GAP_MS, cfg.maxGapMs || 10000)]`（`qq-bridge/src/lib/send-gaps.js:23-26`）；非数字入参按 `MIN_GAP_MS` 处理；现场值取自 `qq-bridge/config.json` 的 `social.send`【已核验】。字段名兼容：可调项写入 `social.send.linearEnabled`，实现早期读取 `cfg.enabled`，现两者同时被识别且显式 `enabled` 优先（`qq-bridge/src/core/send-chain.js:127-129`）【已核验】。现场 `social.send` 另有 `maxMessageChars 1000`、`burstMaxMessages 10`、`maxSendPerMinute 15`、`maxSendPerHour 600`、`longGapProbability 0.25`、`longGapMinMs` / `longGapMaxMs` 为 `8000` / `20000`【已核验】。

### 15.3 正文切分与出站格式治理

- `splitForQQ(text, max = 4000)`（`qq-bridge/src/md-to-plain.js:33`，调用点 `qq-bridge/src/core/qq-send.js:48`）：优先段落与换行边界；切不出多条时按 400 硬失败。
- `splitSerializedBubbles`（`qq-bridge/src/lib/text-safe.js:221`）：还原被序列化成单参数的数组，避免整段当一条发送。
- `sweepMessageArtifacts`（`qq-bridge/src/lib/outbound-text.js:24`）清除模型回显的调用残留；`cleanOutboundText`（`:46`）为正文出口入口函数；`ARTIFACT_TOKEN_RE`（`:21`）为残留匹配式。
- `stripImeEmoji`（`qq-bridge/src/lib/emoji.js:14`）：清除输入法附带的不可见变体选择符（模型看不见但输入框提示"含特殊字符"的根因）。
- `SILENT_MARKER = '[SILENT]'`（`qq-bridge/src/lib/markers.js:5`）命中即不发送任何气泡；`SEND_TOOL_RE`（`:18`）判定正文是否为发送工具调用残留；`SPACE_SPLIT_HINT` / `DIRECTION_HINT`（`:25/27`）为空格切分与方向标记的相对顺序。

模型发送多气泡的正确方式是多次调用 `qq_send_message`，而非在单条正文中插入换行【据仓库记载】（预设 `qq-chat` 的 `[TOOLS]` 段）。

### 15.4 出站闸门

三道判定互不合并，任一命中即阻止发送：敏感内容 `SENSITIVE_RE`（HTTP 403 或抛错，`qq-bridge/src/core/console-server.js:1191/2137/2488/5180`、`qq-bridge/src/core/qq-send.js:197-201`）；令牌泄露 `tokenDisclosureIn(text)`（`qq-bridge/src/lib/text-safe.js:108`）；审计拦截 `sensitiveHitKind` 与 `tokenDisclosureIn` 调用 `handleSensitiveIntercept`（`qq-bridge/src/core/audit.js:24/32-41`），该函数只记日志与活动记录，不向 QQ 发送任何通知。`handleSensitiveIntercept` 的调用点位于同文件 `:36`（`auditAndSend` 内），`auditAndSend` 的调用点在 `qq-bridge/src/core/prompt-deliver.js:13` 的导入项中【已核验】。

### 15.5 投递队列与投递模式

`qq-bridge/src/core/prompt-deliver.js` 把一段提示词写入目标 DSH 会话：队列上限 `QUEUE_MAX = 50`（`:17`）；DSH 未就绪或投递失败时入队（`:33-45`）；`flushQueue` 每会话串行出队（`:47-112`、`:182-213`）；失败后按固定步长退避（`:90-99`），队列非空时重新排程（`:108-110`）；投递调用 `mode: 'steer'`、超时 30000（`:165`）；队列非空时提示模型存在排队消息（`:165-179`）。

### 15.6 回合守卫与长轮询

长轮询回合上限 `11 * 60 * 1000`，超时按 `quarantineSession` 处理（`qq-bridge/src/core/turn-guard.js:21`）；会话隔离拒绝未投递项、清回合状态、删除会话映射并置 `_quarantineRebuilt`（`:56-106`）；跨会话摘要推送的写入路径已删除，仅存注释（`:128-132`）【已核验】；模型挂起时入站消息经 `activeWaits` 直接作为工具结果返回（`qq-bridge/src/core/session-state.js:24`）；DSH 就绪巡检 `setInterval(checkDsh, 5000)`，群信息预热间隔 `15 * 60 * 1000`，就绪后 `await flushQueue()`（`qq-bridge/src/core/dsh-watch.js:314/243/248`）。

### 15.7 失败与降级

卡片主档失败依次降到 `native`、`link`，回执写明当前档位（`qq-bridge/src/core/media.js:276-308`）；`style === 'share'` 落到链接视为预期形态，不计降级（`qq-bridge/src/core/console-server.js:3428`）；切不出多条正文时 400 硬失败，一条都不发（`qq-bridge/src/lib/text-safe.js:221`）；发送超时未确认返回 `unconfirmed: true`（`qq-bridge/src/core/qq-send.js:389`）；DSH 未就绪入队、就绪后按序冲洗，投递失败退避后重试、队列满则丢弃最旧项（`qq-bridge/src/core/prompt-deliver.js:33-45`、`:90-99`）。

未核验项：`qq-bridge/src/core/audit.js` 的 `shouldAuditKey()` 恒返回 `true`，注释声明"closed-agent 时代跳过所有者会话的特判已删除"，该跳过逻辑是否曾存在未核验【据仓库记载】；`splitForQQ` 在 4000 字符上限下的切分点分布未统计；`qq-bridge/src/core/send-chain.js` 的 `linearCounts` 表在会话数极大时的内存占用未测量【未核验】。

## 16. 记忆、检索与学习

### 16.1 两个数据库的分工

| 库 | 文件 | 表 | 数据域 |
| --- | --- | --- | --- |
| 聊天记录库 | `qq-bridge/state/chat.db` | `chat_convs`、`chat_messages`、`chat_fts`、`chat_stats`、`chat_meta` | 全部群聊与私聊消息，保留 7 天 |
| 记忆条目库 | `qq-bridge/state/memory.db` | `profiles`、`memory_entries`、`mem_fts`、`memory_meta` | 显式记忆条目与档案字段 |

`memory.db` 不含 `chat_messages` 表【已核验】（现场只读查询 `sqlite_master`）。两库全文索引版本号不同：`chat_meta.fts_version = '1'`、`memory_meta.fts_version = '2'`【已核验】。现场实测：`chat.db` 9,572,352 字节、`memory.db` 61,440 字节；`chat_messages` 与 `chat_fts` 均 18,104 行，`chat_convs` 9 个会话，`memory_entries` 2 条（类别 `qzone_post`）【已核验】。

### 16.2 聊天记录库

`qq-bridge/src/core/chat-db.js`（1,032 行）：建表 `:51-145`（含上述五表与索引）；加列迁移 `:83`、`:84`、`:85`；消息 id 索引 `:99` `idx_chat_msgid`（撤回与详情查询用）；版本与迁移标记 `:35` `FTS_SCHEMA_VERSION = '1'`、`:36` `MIGRATE_MARK='migrated_from_memory_db'`，现场值 `1790261226594`；写入 `:619` `persistChatMessage`，幂等去重 `:628-632`，正文截断 `slice(0, 2000)` `:653`；计数维护 `:398` `bumpCountersOnInsert`（调用点 `:661`）；全量重算 `:320` `recountChatCounters`（自检 `:304-309`，启动自检不一致时以 `setTimeout(…, 0)` 触发）；标记已读 `:668` `markMessagesRead`；标记撤回 `:691` `markChatRecalled`；检索 `:859` `searchChatMessages`（条件顺序 `:864-890`，FTS JOIN `:878`，排序 `ORDER BY bm25(chat_fts) ASC` `:881`，分页 `:897`）；跨会话检索 `:789` `recentMessagesAcrossSessions`；学习语料 `:966` `loadGroupChatMessagesForLearning`（只读）。

### 16.3 记忆条目库

`qq-bridge/src/core/memory.js`（763 行）：建表 `:46-80`（`profiles` `:52`、`memory_entries` `:62`、索引 `:69`）；加列迁移 `:104-115`（补 10 列，ALTER `:118`）；元表与索引 `:124-131`；全文索引 `:143-165`（`mem_fts` 与三个同步触发器 `:156/159/162`）；版本号 `:90` `FTS_SCHEMA_VERSION = '2'`；分层 `:87` `MEMORY_TIERS` 为 `permanent 0` / `durable 90 天` / `working 7 天`，永久类别 `:89` `PERMANENT_CATEGORIES` 内条目不受清理；写入 `:547` `rememberEntry`（幂等键 `:576-584`，落盘截断 `:552-565`），裸 `INSERT` 路径同样过归一化 `:530`；联系人记忆 `:245-259` `rememberContactName`；清理 `:668` `pruneExpiredMemory`（调用点 `:696-701`）；主题与印象 `:442-498`（`activeTopics`、`pendingThoughts`、`memberImpressions`）；注入函数 `:433` `appendMemory`（分支含 `memberImpression`）；列表读取 `:619` `listMemoryEntries`；格式化 `:386` `formatMemory`（含 `Impressions` 段 `:420-429`）；摘要 `:690` `memoryDigest`；档案字段 `:267-285` `setProfileField`（字段白名单 `:267-274`）与 `:287` `formatProfileText`。

### 16.4 群信息缓存与全文检索

`qq-bridge/src/core/group-cache.js`（126 行）维护三个内存缓存（`:6`、`:9`、`:14`），共用 TTL `GROUP_INFO_TTL_MS`（`:7`）与 `GROUP_LIST_TTL_MS = 10 * 60 * 1000`（`:15`）【已核验】。`warmGroupName` 定义于 `:49-70`（`:22-35` 为 `nameFromGroupList`）；`warmGroupInfo` 定义于 `:89-112`，角色判定 `:100-102` 只接受 `owner` 与 `admin`【已核验】。预热挂载于 `qq-bridge/src/core/dsh-watch.js:232-245`，间隔 `15 * 60 * 1000`（`:243`）【已核验】。

`ftsQueryOf`（`qq-bridge/src/lib/fts.js:22`）的切词正则位于 `:25`，只保留长度 `>= 3` 的词，最多保留 8 个（`:28`）；查询短于 3 个字符时返回空串，调用方退回 `content LIKE ?`；`ftsUsable`（`:12`）在初次使用失败后返回假【已核验】。

### 16.5 记忆注入位置

记忆摘要的调用点为 `memoryDigest({ uid, limit: 14, maxChars: 700 })`（`qq-bridge/src/core/wake-send.js:479`），输出行标记 `[Recall]` 位于 `:485`【已核验】。`memoryDigest`（`qq-bridge/src/core/memory.js:690`）的内层钳制：`limit` 夹在 `1..30`（默认 12），`maxChars` 夹在 `120..4000`（默认 700），单行 `slice(0, 140)`（`:703-731`）【已核验】。该位置选择的依据记录于源码注释【据仓库记载】：系统提示词一旦变化即导致前缀缓存整段失效，而唤醒正文每轮本来就新，摘要放在唤醒正文中的代价仅为自身字符数。

### 16.6 学习基础设施

三条学习线共用同一套基础设施：独立学习会话、独立学习令牌、共享语料入口、共享配置与状态文件。

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

学习会话的创建流程（`qq-bridge/src/core/persona-learn.js:116-149`）：以 `state/persona-agent` 为 workspace 路径调用 `workspace.create`，必要时 `workspace.rename` 为 `cfg.persona.workspaceTitle`（默认 `PersonaAgent`，黑话侧 `slang.workspaceTitle` 默认 `SlangAgent`），随后调用 `sessions.create` 并附 `agentPreset`；会话 id 落盘 `state/persona-agent.json` 与 `state/slang-session.json`，复用顺序为内存、文件、新建【据仓库记载】。`unwrap`（`qq-bridge/src/dsh-client.js:96-100`）在 `response.result.ok` 为假时抛出 `Error(\`${label} failed: ${code}: ${message}\`)`【已核验】。学习会话登记进 `learnerSessions` 并调用 `markPersistentLearner(sessionId)`，以免被会话归档器回收【据仓库记载】。

首轮任务说明由 `ensurePersonaBrief`（`:154`）以 `mode: 'queue'` 注入一次，版本常量 `PERSONA_BRIEF_VERSION = 5` 位于 `:318`，标记 `[PERSONA RUN]`；等待回合用 `PERSONA_TURN_TIMEOUT_MS = 300000`（`:42`），超时不阻塞，只记一行日志并继续发送本轮提醒【已核验】。黑话侧对应 `SLANG_BRIEF_VERSION = 3` 与标记 `[SLANG RUN]`【已核验】。学习令牌由 `ensureLearningToken`（`qq-bridge/src/core/learning-token.js:30-52`）生成并落盘 `state/learning-token`（现场 33 字节），校验函数 `isValidLearningToken`（`:55-63`）【已核验】。

### 16.7 语料入口

`qq_learning_corpus`（`qq-bridge/src/mcp-host-server.js:142`，工具名在 `:143`）向学习会话提供只读语料。参数：`sinceMs` 起（含，默认最近 24 小时）、`untilMs` 止（含，默认当前时刻）、`limit` 返回条数（默认 400，上限 800）、`convKeys` 限定会话（最多 50 个，省略时只查 `conv_key LIKE 'group:%'`）、`targetUid` 只看指定发送方（人格学习使用）。

查询基础段（逐字，`qq-bridge/src/core/chat-db.js` 侧实现）：

```sql
direction = 'in' AND is_self = 0 AND kind IN ('text','qqface') AND content <> '' AND ts_ms >= ? AND ts_ms <= ?
  AND content NOT LIKE '/%' AND content NOT LIKE '[CQ:%' AND content NOT LIKE '[转发%'
SELECT conv_key, sender_uid, sender_name, content, ts_ms FROM chat_messages WHERE … ORDER BY ts_ms ASC, id ASC LIMIT ?
```

该工具以 `readOnly: true` 打开数据库（`qq-bridge/src/mcp-host-server.js:167`），语料库不可用时不整体失败，退回默认查询路径（`:158-161`）【已核验】。

### 16.8 黑话学习

`qq-bridge/src/core/slang.js`（829 行）的相位取值位于 `:637-642`；注入函数 `withSlangContext` 位于 `:400-409`；已确认词表 `confirmedSlangList` 位于 `:387`（默认 `max = 8`，`:388`）；窗口大小 80 位于 `:355`；手动回看窗口 `SLANG_MANUAL_LOOKBACK_MS` 位于 `:597`【已核验】。

| 常量 | 取值 |
| --- | --- |
| `NIGHTLY_TICK_MS` | `60 * 1000` |
| `MAX_LEARN_BLOCKS` | `3` |
| `MAX_LEARN_MSGS` | `2400` |
| `MAX_BLOCK_MSGS` | `800` |
| `LEARN_TURN_TIMEOUT_MS` | `5 * 60 * 1000` |
| `NIGHTLY_RETRY_MS` | `5 * 60 * 1000` |
| `SLANG_MANUAL_LOOKBACK_MS` | `24 * 3600 * 1000` |

提前返回分支位于 `:600`、`:672`、`:678`，分别对应 `disabled`、`dsh-unready`、`busy` 三种原因【已核验】；`isLearnerSessionGone` 位于 `:58-63`【已核验】。词条结构由 `normalizeSlangEntry`（`qq-bridge/src/slang-learner.js:36-57`）定义，状态集合 `SLANG_STATUS` 位于 `:15-19`，去重键 `slangKey` 位于 `:110-117`【已核验】；对外投影 `publicSlangEntry` 位于 `qq-bridge/src/core/slang.js:371`【已核验】。

### 16.9 人格学习

`qq-bridge/src/core/persona-learn.js`（1136 行）的产出归一化由 `normalizePersona`（`:404-452`）完成，其中人格段上限 `PERSONALITY_MAX = 1200`（`:43`）、英文人设上限 `PERSONA_EN_MAX = 6000`（`:47`）【已核验】。提示词任务书由 `buildPersonaTaskBrief`（`:329-370`）构造，JSON 解析由 `parsePersonaJson`（`:454-474`）完成【已核验】。写入档案字段调用 `memory.js` 的 `setProfileField`，调用点位于 `:520`【已核验】。

| 参数 | 取值 | 位置 |
| --- | --- | --- |
| 学习会话等待上限 `PERSONA_TURN_TIMEOUT_MS` | `300000` | `:42` |
| 备份保留份数 `PERSONA_BACKUP_KEEP` | `5` | `:48` |
| 采样总量上限 `SAMPLE_TOTAL_CAP` | `300` | `:37` |
| 防退化阈值 `KEEP_OLD_MIN` | `60` | `:498` |
| 英文人设上限 `PERSONA_EN_MAX` | `6000` | `:47` |
| 人格段上限 `PERSONALITY_MAX` | `1200` | `:43` |

防退化合并 `mergePersonaProfileText`（`:493-503`）的语义为：新文本短于旧文本 60 个字符以上时保留旧文本【已核验】。审批与生效由 `personaApply`（`:682-749`）执行，`mode` 取 `save` / `apply` / `fuse` 三者之一，`apply` 分支在 `:710` 拒绝含中文的输入【已核验】；草稿融合由 `personaFuseDraft`（`:765-835`）执行。人设库对象字面量位于 `:526-548`，其持久化函数 `savePersonaLibrary` 的声明位于 `:109`【已核验】。

### 16.10 群友画像

`qq-bridge/src/core/portrait-learn.js`（257 行）的默认参数 `PORTRAIT_DEFAULTS` 位于 `:18-27`：`minMessages` 为 10、`maxTargets` 为 20、`windowHours` 为 720【据仓库记载】。定时器 `PORTRAIT_TICK_MS` 位于 `:29`；目标筛选 `eligiblePortraitTargets` 位于 `:83-108`（SQL 位于 `:88-100`）；失败分支位于 `:123` 与 `:186-191`，分别为忙碌提前返回与自动巡检退避【已核验】。

### 16.11 已确认缺陷

| 缺陷 | 位置 | 观测结果 | 后果 |
| --- | --- | --- | --- |
| 人格学习取样查错库 | `qq-bridge/src/core/persona-learn.js:223` 取 `initMemoryDb()`，`:238`、`:243` 查 `chat_messages` | `no such table: chat_messages` | `collectTargetSamples` 恒返回 0 样本，收尾文案为"近 N 天没有找到该账号的发言记录"（`:602-605`） |
| 群友画像筛选查错库 | `qq-bridge/src/core/portrait-learn.js:84` 取 `initMemoryDb()`，`:88-100` 查 `chat_messages` | `no such table: chat_messages` | `eligiblePortraitTargets` 恒返回 `ok:false`，`portraitLearnStart` 与自动巡检进入 30 分钟退避 |

两处异常均被 `catch` 吞为日志（`qq-bridge/src/core/persona-learn.js:240/245`、`qq-bridge/src/core/portrait-learn.js:106`）【已核验】。正确连接应为 `initChatDb()`（`qq-bridge/src/core/chat-db.js:51`）；旁证为同仓的 `loadGroupChatMessagesForLearning`（`qq-bridge/src/core/chat-db.js:966`）与 `qq_learning_corpus`（`qq-bridge/src/mcp-host-server.js:142`）均使用 `chat.db`【已核验】。画像 SQL 还引用了 `chat.db` 独有的 `recalled_at` 列，可进一步确认目标库为 `chat.db`【已核验】。缺陷编号见附录 D。

### 16.12 失败与降级

- 记忆库不可用：`initMemoryDb` 返回 null，各函数早退 `{ok:false,error:'记忆库不可用'}`（`qq-bridge/src/core/memory.js:77`）。
- 聊天库不可用与全文索引不可用：见「消息接收与唤醒」章的「失败与降级」节。
- 查询短于 3 字：`ftsQueryOf` 返回空串，响应体无 `ranked` 字段（`qq-bridge/src/lib/fts.js:22`）。
- 加列或索引失败：逐步 try/catch，只记日志（`qq-bridge/src/core/memory.js`、`qq-bridge/src/core/chat-db.js` 的"加列失败（忽略）"类日志）。
- 迁移条数不一致：保留旧表，下次启动重试（`qq-bridge/src/core/chat-db.js:260`）；计数漂移：启动自检不一致时全量重算（`:307`）。
- 索引落后：版本水位不符时启动重建（`chat_meta.fts_version='1'`、`memory_meta.fts_version='2'`）。

### 16.13 未核验

- `qq-bridge/state/memory.db.pre-v13-backup`（7,553,024 字节）在全仓检索无任何引用，其产出者未核验。
- 现场 `chat_messages.ts` 存在两种文本格式（早期 `2026-08-31 19:22:23`，较新 `2026-09-08 周二 08:42:59`），`date` 过滤在两种格式下均成立，格式不一致的成因未核验。
- `qq-bridge/state/persona-library.json`、`state/persona-agent.json`、`state/session-archive.json` 三个路径在仓库中不存在，人设库与学习会话 id 的实际落盘文件未核验。
- 6.11 两处缺陷的修复方案与影响面未评估。

以上均【未核验】。

## 17. 人设、角色与表达

### 17.1 人设文本组装与落库

`qq-bridge/src/core/persona-text.js`（153 行）把结构化画像组装为中文人设文本，处理步骤为去重、排序、截断：`splitSentences` `:21`（按句切分，去重单位）；`keyOf` `:30`（归一化比较键，去除空白与标点；标点字符类中的全角波浪号在源码中写作 `\uFF5E` 转义形式）；`cleanNickname` `:37`（昵称清洗）；组装顺序 `:85-127`（固定段序输出）；`PROFILE_MAX` `:18`（总值上限 4000 字符）。人设落库由 `qq-bridge/src/core/persona-learn.js:520` 调用 `qq-bridge/src/core/memory.js:267-285` 的 `setProfileField` 完成，字段上限 4000。

### 17.2 人设生效路径

人设有两条互相独立的生效路径，写入对象不同，互不覆盖：

- 文件型：`qq-bridge/src/lib/preset-compose.js` 把合成段写入 `.agent-presets/qq-chat/agent.cordis.yml`，审批通过并写入预设后于新会话加载时生效。段标记常量 `COMPOSE_BEGIN` / `COMPOSE_END` 声明于 `:19-20`，合成函数位于 `:33-59`，反向剥离函数为 `stripOverrideBlock`（`:63`）【已核验】。
- 运行时型：`qq-bridge/src/core/wake-send.js:311-326` 写入唤醒正文的 `[PERSONA]` 段，每轮唤醒即时生效。容量约束 `RUNTIME_OVERRIDE_MAX['persona.md'] = 16000`（`:248`），超限按保尾策略截断，保尾长度 2500（`:250`）【已核验】。

### 17.3 唤醒正文的注入段

`qq-bridge/src/core/wake-send.js`（1,940 行）：`[WakeRef]` 唤醒引用 `:334-340`；`[Recall]` 记忆摘要 `:485`（见「记忆、检索与学习」章的「记忆注入位置」节）；`[Profile]` 画像 `:486`；`[PERSONA]` 运行时人设 `:311-326`（入队位于 `:322`）；最近窗口由 `formatRecentWindow` `:593` 输出，轮换后首轮走 `:1820-1822` 分支；语音与表情提示位于 `:538`、`:1766`，由 `tokenLine`、`statusLine`、`wakeLine`、`voiceTurnHint`、`memeTurnHint` 拼接。未读水位补回位于 `:1316-1334`，会话准入复查位于 `:1281-1284`，窗口轮换阈值计算位于 `:95-97`，轮换推迟上限 `ROTATE_DEFER_MAX_MS = 120000` 位于 `:75`【已核验】。

### 17.4 角色库

角色库以文件目录形式承载，扫描根由 `social.charactersDir` 指定。

| 工具 | 注册行 | 行为 |
| --- | --- | --- |
| `qq_character_list` | `:4601` | 列出角色包 |
| `qq_character_read` | `:4617` | 读取指定角色文本 |
| `qq_character_pack` | `:4634` | 读取角色包内容 |
| `qq_character_search` | `:4650` | 按关键词检索角色 |
| `qq_character_switch` | `:4665` | 切换当前角色 |

注册行取自 `qq-bridge/src/mcp-napcat-safe.js`。当前角色标识落盘 `qq-bridge/state/current-role.json`（现场 46 字节）【已核验】；发送前由 `qq-bridge/src/core/audit.js:19` 读取该状态参与判定【已核验】。角色切换的人设替换逻辑位于 `qq-bridge/src/lib/persona-switch.js`（224 行）【据仓库记载】。

### 17.5 表达约束与辅助模块

表达约束以预设文本形式下发，不参与代码判定，桥侧不校验其遵守情况：出站正文不含换行符，多气泡通过多次调用 `qq_send_message` 实现；单条正文上限由 `social.send.maxMessageChars` 决定，现场值 `1000`；颜文字仅允许出现在正文末尾且计入字数上限；不在一段回复中使用代码块分段；模型判定无需回复时输出 `[SILENT]`。

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

`buildStickerContext`（`qq-bridge/src/sticker-lib.js:165`）每轮注入表情候选，上限由 `promptMaxStickers` 决定，现场为 8。

### 17.6 失败与降级

- 人设文本为空：不注入 `[PERSONA]` 段，其余段落照常（`qq-bridge/src/core/wake-send.js:311-326`）。
- 运行时人设超限：按保尾 2500 字符截断（`qq-bridge/src/core/wake-send.js:248/250`）。
- 角色包缺失：工具返回明确错误，不切换（`qq-bridge/src/mcp-napcat-safe.js:4601-4665`）。
- 表情库为空：不注入表情候选段（`qq-bridge/src/sticker-lib.js:165`）。
- 正文含换行：由 `splitForQQ` 切分为多条（`qq-bridge/src/md-to-plain.js:33`）。

未核验：`qq-bridge/characters/` 目录下含 21 个子目录与 2 个散装文件（`角色库说明.md`、`ATRI_MAIN_PROMPT.md`），21 个出厂角色包的各自设定内容与完整性未核验【已核验，内容未核验】；表达约束的实际遵守率未做统计【未核验】。

## 18. 媒体处理

### 18.1 媒体接收

接收入口为 `fetchOneBotImage`（`qq-bridge/src/core/media-pipe.js:72`，文件 348 行）：单件字节上限 `MAX_MEDIA_BYTES = 25 * 1024 * 1024`（`:15`）与像素上限 `MAX_MEDIA_PIXELS = 64_000_000`（`:16`）为双闸；会话级条数上限 `MAX_MEDIA_STORE_PER_KEY = 500`（`:17`）；直通模式 `asIs`（`:78`，关闭降采样时原样传递）；按 URL 形式、本地路径、`base64`、`file` 段分别取字节的分支点位于 `:80-86`、`:91`、`:93`、`:95-96`、`:106`、`:108`、`:114`、`:116`、`:121`、`:123-127`、`:142`；表情取图 `fetchFaceMedia`（`:156`，实体查询超时 `12000` `:165`）；降采样闸门 `gateImage`（`:197`）；占位文案 `:207`、`:217`、`:227`、`:229`；列表解析 `resolveMediaList`（`:232`、`:260`、`:272-280`）；数据读取 `fetchMediaData`（`:287`、`:321-323`）。

### 18.2 下载与安全抓取

`qq-bridge/src/safe-fetch.js`（456 行）是被媒体层复用的纯工具库，不注册任何 MCP 工具【已核验】。私有网段判定 `isPrivateIp`（`:66`）覆盖 IPv4 `10/8`、`127/8`、`0/8`、`169.254/16`、`172.16-31`、`192.168/16`、`100.64-127`、`198.18-19`、`192.0.0`、`>= 224`，IPv6 `::`、`::1`、`fc|fd`、`fe8x-febx`、`fecx-fefx`、`2001:db8`、`2001:2/10/20`、`2002::/16`、`ff`，并解嵌 IPv4-mapped 与 NAT64 形式。解析与校验 `resolveSafeHost`（`:107`）、`:124-128`、`validateFetchUrl`（`:132`）在连接前执行；`verifyImageComplete`（`:286`）；下载字节上限 `MAX_IMAGE_FETCH_BYTES = 15 * 1024 * 1024`（`:348`）；`safeFetchBuffer`（`:362`，单请求实现 `requestOnceBuffer` `:394`，未导出）；`MAX_REDIRECTS = 5`（`:363`，另一处 `:215`）；每次跳转后重新校验目标（`:376-378`、`:382-385`）。

### 18.3 图片压缩与转码

`qq-bridge/src/lib/image-compress.js`（316 行）提供解码、缩放、编码三段：`IMAGE_MAX_SIDE = 1280`（`:30`）、`IMAGE_HARD_MAX_SIDE = 4096`（`:32`）、`IMAGE_HARD_MAX_BYTES = 15MB`（`:47`）、`IMAGE_PUREJS_MAX_PIXELS = 40_000_000`（`:49`）、`IMAGE_JPEG_QUALITY = 82`（`:50`）、`IMAGE_MIN_COMPRESS_BYTES = 40 * 1024`（`:51`）、`IMAGE_ANIM_KEEP_MAX = 4MB`（`:52`）。函数入口 `compressImageBuffer`（`:242`，动图超过上限时原样返回 `:253`）、`finalizeImageBuffer`（`:272`）、`ensureDeliverableImage`（`:292`）。JPEG 解码参数位于 `:194`（`maxResolutionInMP: 200`、`maxMemoryUsageInMB: 1024`）【已核验】。

### 18.4 外发图统一入口

全部发图工具经 `napcatImageFileArg`（`qq-bridge/src/lib/napcat-file.js:60`，文件 97 行）构造 OneBot 的 `file` 参数：模式解析 `resolveImageFileMode`（`:31`）取值 `path` / `base64` / `auto`，默认 `path`；容器路径改写 `rewriteToContainerPath`（`:39`，Docker 部署下的路径映射）；按模式返回 `file://` 路径或 `base64://`（`:60`）；`base64` 字节上限 `DEFAULT_BASE64_MAX_BYTES = 10 * 1024 * 1024`（`:27`）；表情临时目录 `resolveStickerTmpDir`（`:92`）。

### 18.5 收藏表情

收藏表情以本地认知层形式存在，QQ 侧为源。存储文件 `qq-bridge/state/stickers.json`（现场 10,292 字节）【已核验】；写盘走原子写并设置权限 `0o600`（`qq-bridge/src/sticker-lib.js:60-63`）【已核验】。

| 函数 | 位置 | 行为 |
| --- | --- | --- |
| `normalizeStickerEntry` | `qq-bridge/src/sticker-lib.js:22-45` | 条目 17 个字段：`id`、`resId`、`url`、`md5`（大写）、`desc`、`localNote`、`tags`（上限 20）、`usage`、`source`、`useCount`、`lastUsedAt`、`lastContext`（上限 200）、`createdAt`、`updatedAt` 等 |
| `mergeStickerLibrary` | `qq-bridge/src/sticker-lib.js:69` | 只覆盖 QQ 侧字段，保留本地字段 |
| `findSticker` | `qq-bridge/src/sticker-lib.js:115` | 两轮匹配：先精确（`id` / `resId` / 大写 `md5`），后模糊（去协议与尾斜杠后互相包含） |
| `formatStickerList` | `qq-bridge/src/sticker-lib.js:133` | 返回 `{total, matched, truncated, stickers[]}`；`max = max(1, min(500, limit \|\| 48))` |
| `buildStickerContext` | `qq-bridge/src/sticker-lib.js:165` | 按 `useCount` 降序取 `min(30, max \|\| 8)` 条 |
| `syncStickerLibrary` | `qq-bridge/src/core/sticker.js:117` | TTL 默认 `60000`（`:120`），上限 `min(500, max(1, maxListCount \|\| 100))`（`:126`） |
| 优先接口 | `qq-bridge/src/core/sticker.js:131-139` | 先 `fetch_custom_face_detail`，失败退回 `fetch_custom_face` |
| 载荷兼容 | `qq-bridge/src/core/sticker.js:141-146` | 接受 `payload` / `payload.data` / `payload.list` / `payload.faces` / `payload.customFaceList` |
| `md5` 提取 | `qq-bridge/src/core/sticker.js:151` | `/([0-9A-F]{32})(?:_0_0\|\/0\|\/\|$)/i` |
| 强制重同步冷却 | `qq-bridge/src/core/sticker.js:43` | `FORCE_LOOKUP_COOLDOWN_MS = 30000` |

发送链路 `sendSticker2`（`qq-bridge/src/core/sticker.js:220`）：缓存未命中时先 `forceResyncForLookup()`（`:235-236`，受 `:43` 冷却约束）；一次调用只发一张表情（`:239`）；构造参数（`:244`）；归一化（`:251-255`）；`add_custom_face` 不被支持时降级为本地图库引用 `local://`（`:546-554`）；发送失败且错误含 `识别URL失败` 或 `ENOENT` 时以 `base64` 重发一次（`:313-320`）。收藏链路 `collectSticker2`（`:489`）：`:498` 取 id、`:509-521` 收集候选、`:526` 去重、`:527` 落库、`:531-561` 生成描述；`collectFaceSupported` 的探测与降级位于 `:53-89`【已核验】；备注写入为 `applyStickerNote2`（`:457`）、`setStickerRemark2`（`:469`）、`set_custom_face_desc`（`:582-590`）。

### 18.6 内置表情包

`qq-bridge/src/mcp-napcat-safe.js`（4,745 行）：扫描间隔 `MEME_RESCAN_MS = 5000`（`:73`）；旧包标识 `MEME_LEGACY_PACK_ID`（`:71`）；目录布局说明 `:51-58`（包目录与 `index.db` 的层级约定）；启动告警 `:249-256`（缺包时向 stderr 输出候选路径）；缺包提示 `memeMissingHint`（`:271`）；包排序 `orderedMemePacks`（`:287-296`）；路径查询 `queryMemePath`（`:303`）；概率查询 `firstMemeByQuery`（`:321`）；工具注册 `qq_meme_search` `:2066`、`qq_send_meme` `:2116`。

`index.db` 的 `memes` 表结构为 8 列：`path`（主键）、`tag`、`file_name`、`file_hash`、`caption`（默认空串）、`keywords`（默认空串）、`mtime`、`captioned_at`（扫描根定义于 `:111-115`）【已核验】。现场状态：仓库内 `qq-bridge/` 下不存在任何 `meme*` 目录，仓库根 `meme/` 为空；磁盘上存在三份 `whale-fanart-001/index.db` 副本（`.runtime/meme-full/`、`.runtime/idx-extract/`、`.runtime/tarcheck/`，各 61,440 字节，`memes` 表均为 162 行），三者均不在 `:111-115` 的扫描根之内，即该包未安装在生效位置【已核验】。

### 18.7 QQ 内置表情与联网找图

`qq_face_list`（注册行 `:2772`）提供 face id 与名称对照，`qq_send_qq_face`（`:2792`）发送，发送实现为 `sendQqFace2`（`qq-bridge/src/core/sticker.js:359`）【已核验】；未知 face 由 NapCat 侧返回错误，桥侧不做本地校验【据仓库记载】。

`qq-bridge/src/lib/image-search.js`（182 行）实现两个来源的检索：`bingImageSearch`（`:48`）与 `baiduImageSearch`（`:81`），入口 `searchImages`（`:122`），超时 `TIMEOUT_MS = 9000`（`:14`）【已核验】。失败计数位于 `:132-143`（单来源连续失败后短暂停用），来源轮转 `:151`，结果打分 `:170-177`（按尺寸与来源加权），条数上限 `limit <= 20`（调用方）。

### 18.8 Pixiv

`qq-bridge/src/lib/pixiv.js`（1,684 行）提供搜索、作品详情、原图获取、用户作品与用户搜索五类能力：默认反代基址 `https://x.pixigraph.xyz`（`:122`）、请求超时 `TIMEOUT_MS = 15000`（`:124`）、基址选择 `pickPixivBase`（`:147`）、图片档位 `:207`、发送计划 `planPixivSend`（`:232`）、尺寸判定 `pixivTierSizeVerdict`（`:269`）、成人内容判定 `isAdult` / `isAdultWork`（`:324-328`、`:1464`）、翻页默认 3 与上限 10（`:332-333`）、过滤键 `NEW_KEYS` `:343` 与 `normalizePixivFilters` `:351`、`filterPixivItems` `:479`、搜索来源 `PIXIV_SEARCH_SOURCES`（`:913-917`）、Cookie 与登录态 `pixivCookie` `:998` 与 `pixivLoginState` `:1104`、艺术家缓存上限 `ARTIST_CACHE_MAX = 500`（`:1017`）、请求头 `pixivRequestHeaders`（`:1071-1084`）、详情与原图 `pixivIllustDetail` `:1261` 与 `pixivIllustOriginals` `:1333`、用户作品 `pixivUserWorkIds` `:1410` 与 `:1422`（翻页上限常量名为 `PIXIV_USER_WORKS_MAX_PAGES = 10`）、用户检索 `pixivSearchUsersByName`（`:1593`）【已核验】。

Cookie 巡检与令牌轮换：`qq-bridge/src/core/pixiv-watch.js`（122 行）的状态文件位于 `:23`，`CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000`（`:24`）、`FIRST_DELAY_MS = 90 * 1000`（`:25`）、`NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000`（`:26`）【已核验】；令牌刷新间隔 `PIXIV_REFRESH_INTERVAL_MS = 50 * 60 * 1000` 定义于 `qq-bridge/src/lib/pixiv-auth.js:49`，装配于 `:346`，定时器于 `:367`【已核验】。

### 18.9 语音

`qq-bridge/src/core/voice.js`（1,158 行）同时承载语音合成与语音识别：角色模型名 `VOICE_ROLES`（`:52-57`）；默认端点 `https://token-plan-cn.xiaomimimo.com/v1`（`:59`）、备用端点 `ALT_BASE_URL`（`:60`）；合成字符上限 `MAX_TTS_CHARS = 2000`（`:63`）；落盘文件 `:32-34`（配置、额度、缓存三文件）；缓存目录 `cacheDir()`（`:258-267`）；缓存键 `:274-278`（模型、文本、音色、语速的组合）；淘汰 `:280-288`、`:548`（按容量与时间）；鉴权头 `:318-322`（双头携带）；内置音色 `:39-49`（`mimo_default`、冰糖、茉莉、苏打、白桦、`Mia`、`Chloe`、`Milo`、`Dean`）；主动语音额度 `:73-104`（`maxChars 120` `:90`、`dailyChars 20000` `:91`、`send.probability 0.2` `:97`、`send.cooldownMs 600000` `:98`）；计划与执行 `allVoicePlan` / `tryAllVoiceReply`（`:903-923`、`:931-960`）；提示行 `:1000`（全语音模式）、`:1006`（掷骰命中）、`:1009`（未命中或冷却）。

独立识图：`qq-bridge/src/core/vision.js`（158 行）在分流开关开启时以独立视觉模型处理图片，超时 `VISION_TIMEOUT_MS = 45000`（`:22`）、响应字节上限 `VISION_MAX_RESPONSE_BYTES = 64 * 1024`（`:24`），失败分支位于 `:145-157`【已核验】；默认视觉模型在会话创建时按档位计划选择，见「DSH 集成与上下文压缩接口」章的「会话创建与视觉模型」节。

### 18.10 文档发送

`qq-bridge/src/core/docx.js`（140 行）生成并上传 `.docx`：临时目录 `path.join(STATE_DIR, 'doc-tmp')`（`:19`）；正文上限 `MAX_DOCX_CHARS = 1000000`（`:24`）；额度文件 `path.join(STATE_DIR, 'docx-quota.json')`（`:27`）；日额度默认 `100000`（`:38-39`）；额度裁剪 `saveDocxQuota`（`:46`，裁剪行 `:51`，只保留最近 7 天）；额度预占 `docxQuotaReserve`（`:57`，超额直接拒绝且不占用额度）；写入 `writeDocxToMount`（`:74`，文件名 `${safeTitle}${extraName ? '-' + extraName : ''}-${Date.now()}.docx`）；标题净化 `:84`（`replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 40)`）；上传 `uploadFileToQQ`（`:92`，动作 `:94` 取 `upload_private_file` / `upload_group_file`）；上传超时 `AbortSignal.timeout(30000)`（`:116`）；额度提交 `docxQuotaCommit`（`:67`，上传成功后提交）；旧链路 `:139-140`（原 `/help` 发送能力清单文档的链路已删除）。

### 18.11 链接卡片与视频

`qq-bridge/src/core/media.js`（1,249 行）：封面真图判定 `isRealCoverBytes`（`:34`）只接受 JPEG、PNG、WebP 三种魔数，GIF 不放行；真实字节实测 `:60-63`（无参 `89 50 4E 47` / 4,410,875 字节；`300y300` 同魔数 / 210,146 字节；`imageView` 同魔数 / 210,146 字节；`type=jpg` `FF D8 FF` / 20,913 字节）；封面 URL 归一化 `normalizeCoverUrl` `:53` 与 `normalizeMediaUrl` `:92`；封面来源判定 `QQ_COVER_HOST_RE` `:231` 与 `neteaseRealCover` `:260`；探活 `probeImage`（`:562`，上限 `COVER_PROBE_MAX_BYTES = 64 * 1024` 位于 `:29`，超时 6 秒）；候选选择 `pickImage`（`:575`，主体 `:603-621`，两轮探活，全失败返回空串）；卡片发送与降级 `sendMusicCardWithFallback`（`:276`，降级段 `:286-308`，`primary` → `native` → `link`）；富文本发送 `sendRichOnce`（`:357`，去重窗口 `RICH_DEDUPE_MS = 60000` `:334`，超时 `AbortSignal.timeout(45000)` `:399`，间隔 `sleep(randInt(500, 1500))` `:386`）；音乐卡片构造 `buildMusicCard`（`:930`，主体 `:957-1040`、`netEase` 段 `:1049-1147`、收尾 `:1149-1167`）；音频直链 `neteaseAudioUrl`（`:763`）；音乐检索 `musicSearch`（`:1171`）；签名服务 `:441`、`:921` 注释；封面转存默认关闭 `:681`、`:705`、`:710`、`:715`；媒体域装配 `createMediaDomain`（`:311`、`:1248`）。

视频链路（`qq-bridge/src/core/video.js`，1,259 行）：探活超时 `PROBE_TIMEOUT_MS = 9000`（`:25`）；代理开关 `:37`（`QQBRIDGE_VIDEO_PROXIES` 非空时才走代理）；URL 抽取 `extractVideoUrls`（`:49`，BV 号 `:59`、av 号 `:62`、通用 URL `:64`）；平台判定 `classifyVideoHost` `:73` 与 `parseVideoUrl` `:94`；视图接口候选 `:327`（`/x/web-interface/wbi/view` 优先，随后 `/x/web-interface/view`）；次要接口 `SECAPI_BILI_DEFAULT` `:408` 与 `SECAPI_BILI_TIMEOUT_MS = 8000` `:413`；短码缓存 `SHARE_CODE_TTL_MS = 10 * 60 * 1000`（`:507`）；bilibili 解析 `resolveBilibili`（`:592`，四路顺序：视图接口补空字段、`pagelist` 反查、网页 `og: meta`、最终抛 `bilibili 解析失败` `:711`）；抖音解析 `resolveDouyin`（`:774`，降级标记 `:821-823`，全失败时 `err.degraded = true`）；通用平台 `resolveVideo`（`:858`，降级标记 `:873-877`，只抓 `og: meta`）；小程序卡片 `fetchMiniAppArk`（`:1033`，请求体 `:1127`，缺 `title` 或 `jumpUrl` 返回 null 并退分享链接，缺封面不阻止构造）；卡片构造 `buildVideoCard`（`:1158`，`style` 默认 `:1163`，`QQBRIDGE_VIDEO_CARD` 默认 `share`，`json` 档已停用 `:1183-1201`）。

小程序卡片的请求体逐字为：

```js
JSON.stringify({ type, title: title.slice(0,100), desc: desc.slice(0,100), picUrl, jumpUrl, webUrl, rawArkData: 'true' })
```

其中 `type = platform === 'bilibili' ? 'bili' : (platform === 'weibo' ? 'weibo' : '')`，即模板只有 `bili` 与 `weibo` 两种【已核验】。发送形态为 `{ ver, prompt, config, app, view, meta, miniappShareOrigin: 3, miniappOpenRefer: '10002' }`，最终段为 `{ type:'json', data:{ data: JSON.stringify(send) } }`（`qq-bridge/src/core/video.js:1140-1149`）【已核验】。

`degraded` 判定：`err.degraded = true`（`qq-bridge/src/core/video.js:822`，抖音只剩链接可用）；`err.degraded = true`（`:875`，通用平台抓页失败）；`sentCard === 'link' && videoPlan.style === 'share'`（`qq-bridge/src/core/console-server.js:3428`，预期形态，不计降级）；`sentCard !== 'primary' && !intendedShare`（`:3429-3431`，记降级日志）；端点返回 `{ok:false, error, degraded, url}`（`:3526`）。

### 18.12 空间配图

`qq-bridge/src/lib/qzone-image.js`（297 行）为 `qq_send_qzone` 构造配图参数：参数差异说明 `:16-17`（`file` 为单图参数，`images` 为多图参数）；数量上限 `QZONE_IMAGE_MAX = 3`（`:45`）；临时文件寿命 `QZONE_IMAGE_TMP_MAX_AGE_MS`（`:48`）；文件名匹配 `QZONE_TMP_NAME_RE`（`:52`）；数量钳制 `clampQzoneImageCount`（`:55`）；临时目录 `qzoneImageTmpDir`（`:62`）；校验 `verifyQzoneImage`（`:84`）；参数构造 `prepareQzoneImageArg`（`:106`，分支 `:113-115`、`:124-129`）；清理 `sweepQzoneImageTmp`（`:142`）；收集 `collectQzoneImages`（`:170`，分支 `:167`、`:188`、`:191-201`、`:222-237`、`:243-258`、`:275-277`、`:286`、`:295-296`）。

### 18.13 失败与降级

- 媒体未投递成功：给模型显式占位文案，提示不推断图片内容（`qq-bridge/src/core/media-pipe.js:207`）；尺寸过大 `[图片（尺寸过大已跳过：…）…]`（`:227`）；获取失败 `[图片（获取失败）…]`（`:229`）。
- 封面非真图：丢弃该封面，不采用首个候选 URL（`qq-bridge/src/core/media.js:575/603-621`）。
- 卡片发送失败：逐档降级并回执当前档位与来源（`qq-bridge/src/core/media.js:276-308`）。
- 表情发送失败（`识别URL失败` / `ENOENT`）：以 `base64` 重发一次（`qq-bridge/src/core/sticker.js:313-320`）；`add_custom_face` 不支持时降级为 `local://` 本地图库引用（`:546-554`）。
- 文档超额：直接拒绝且不占用额度（`qq-bridge/src/core/docx.js:57`）。
- 视频解析全败：抛错并携带 `degraded` 标记（`qq-bridge/src/core/video.js:821-823`、`:873-877`）。

未核验：内置表情包在生效位置的安装状态未修复，其工具在缺包时的完整返回文案未复现；`qq-bridge/src/core/media.js` 中封面转存图床功能默认关闭，开启后的行为未复现；视频卡片在微信小程序侧的渲染结果未验证【未核验】。

## 19. 时间驱动与主动行为

### 19.1 定时消息与等待挂起

`qq-bridge/src/core/scheduler.js`（152 行）承载 `qq_schedule_message` / `qq_schedule_list` / `qq_schedule_cancel` 三个工具（注册行分别为 `qq-bridge/src/mcp-napcat-safe.js:1101`、`:1128`、`:1142`），持久化文件 `qq-bridge/state/scheduled-tasks.json`（现场 3 字节，即空数组）【已核验】。发送失败按 `60000` 毫秒退避重试，单任务上限 3 次；启动时 `loadScheduledTasks()` 恢复（`qq-bridge/src/bridge.js:729-731`）。

`qq_wait_for_messages`（`qq-bridge/src/mcp-napcat-safe.js:1439`）在长轮询模式下挂起模型，等待入站消息直接作为工具结果返回。挂起登记于 `activeWaits` 集合（`qq-bridge/src/core/session-state.js:24`）；回合上限 `11 * 60 * 1000`（`qq-bridge/src/core/turn-guard.js:21`）；无限唤醒由 `wakeConfig.infinite` 控制（`qq-bridge/src/core/console-server.js:1785-1787`）；等待期间入站不经投递队列（见「形式模型与闸门序列」章的「唤醒与投递」节）。

### 19.2 活跃时段与静默状态

`qq-bridge/src/core/activity.js`（124 行）承载 `qq_get_activity_hours`（注册行 `:1167`）与 `qq_set_activity_hours`（`:1181`），并由管理端 `POST /api/bridge/activity-hours`（`server/index.js:5408`）读写；落盘文件 `qq-bridge/state/activity-windows.json`（现场 262 字节）【已核验】。巡检间隔 `60000` 毫秒；窗口命中后于窗口起点后 2 分钟触发一次主动检查；目标会话取自 `GET /api/bridge/activity-targets`（`qq-bridge/src/core/console-server.js:4924`）；启动时经 `loadActivityWindows()` 与 `startActivityTick()` 恢复（`qq-bridge/src/bridge.js:729-731`）。活跃时段窗口跨日时按窗口起点计算，不做跨日合并（`qq-bridge/src/core/activity.js`）。

静默与唤醒控制（`wakeConfig` 为会话持久字段）：`/sleep` 使本会话不再唤醒直至 `/wake`；`/wake` 立即触发一次唤醒；`wakeConfig.infinite` 由 `qq_mark_read` 收尾置位（`qq-bridge/src/core/console-server.js:1785-1790`）；`/deepsleep` 使所有会话静默，只向 `qq-bridge/state/qq-activity.log` 写记录；`POST /api/social/paused` 封禁 `/api/social`、`/api/send`、`/api/images` 三组端点（仅对 agent 令牌生效）；`qq_set_wake_config`（注册行 `:1280`）允许模型设置自身的唤醒档位。

### 19.3 主动搭话与掷骰

`qq-bridge/src/core/send-dice.js`（89 行）实现桥侧主动行为的概率与冷却判定，函数签名为 `dice(kind, key, probability, cooldownMs)`【已核验】；配套记账函数 `noteSent(kind, key)` 位于 `:19`【已核验】。`MEME_DEFAULT_PROBABILITY = 0.3`（`:40`）、`MEME_DEFAULT_COOLDOWN_MS = 3 * 60 * 1000`（`:41`）。`kind` 的取值集合为 `meme` 与 `voice` 两者，全仓无第三种取值【已核验】。

主动语音在唤醒前掷骰决定，参数与额度段位于 `qq-bridge/src/core/voice.js:73-104`，现场配置 `send.probability` 为 `0.2`、`send.cooldownMs` 为 `600000`【已核验】；语音提示行拼接于 `qq-bridge/src/core/wake-send.js:538` 与 `:1766`，文本行位于 `qq-bridge/src/core/voice.js:1000`、`:1006`、`:1009`。主动搭话的素材概率与冷却由桥侧决定，模型不直接取值。

### 19.4 主动发说说

`qq-bridge/src/core/qzone.js`（44 行）的 `postRandomQzone`（`:8`）由桥侧主动路径调用：素材池为内置 10 条（`:12-23`）；请求超时 15000 毫秒（`:30`）；成功后写入记忆条目（`:39-40`，类别 `qzone_post`），记录日志于 `:43`【已核验】。现场 `memory_entries` 中 `qzone_post` 类别的 2 条记录即来自该路径【已核验】。

### 19.5 失败与降级

- 定时任务发送失败：按 60000 毫秒退避重试，超过 3 次后放弃（`qq-bridge/src/core/scheduler.js`）。
- 活跃时段窗口跨日：按窗口起点计算，不做跨日合并（`qq-bridge/src/core/activity.js`）。
- 主动语音额度耗尽：当天不再主动发语音（`qq-bridge/src/core/voice.js:73-104`）。
- 掷骰未命中：记一行未命中日志，不发送（`qq-bridge/src/core/voice.js:1009`）。
- 说说发布失败：记录日志，不重试（`qq-bridge/src/core/qzone.js:30-43`）。

未核验：定时任务的时刻精度未做测量；活跃时段与主动搭话的联合触发频次未做统计【未核验】。

## 20. 社交拓展面

### 20.1 QQ 空间与社交动作

注册行取自 `qq-bridge/src/mcp-napcat-safe.js`。

| 工具 | 注册行 | 行为 |
| --- | --- | --- |
| `qq_qzone_view` | `:2536` | 读取指定账号的说说列表 |
| `qq_qzone_comment` | `:2578` | 发表评论 |
| `qq_qzone_reply_comment` | `:2617` | 回复评论 |
| `qq_qzone_like` | `:2662` | 点赞 |
| `qq_send_qzone` | `:2702` | 发表说说，配图经 `qq-bridge/src/lib/qzone-image.js` 构造（见「媒体处理」章的「空间配图」节） |
| `qq_like` | `:2013` | 给指定账号的资料卡点赞 |
| `qq_send_poke` | `:1370` | 发送拍一拍 |
| `qq_profile_get` | `:2298` | 读取资料卡字段 |
| `qq_profile_set` | `:2316` | 写入资料卡字段 |
| `qq_get_group_owner` | `:902` | 读取群主账号 |
| `qq_get_group_members` | `:882` | 读取群成员列表 |
| `qq_list_groups` | `:854` | 读取加入的群列表 |

说说配图数量上限为 3（`qq-bridge/src/lib/qzone-image.js:45`）【已核验】。非所有者调用管理类工具时返回权限提示并终止（`qq-bridge/src/mcp-napcat-safe.js:2342-2399`）。收到拍一拍与输入状态的通知经 `onNotice('notify')` 订阅（`qq-bridge/src/bridge.js:589`）【已核验】。

### 20.2 跨会话留言

`qq-bridge/src/core/crosschat.js`（138 行）实现会话之间的留言投递：写入工具 `qq_crosschat_send`（注册行 `qq-bridge/src/mcp-napcat-safe.js:1395`）、读取工具 `qq_crosschat_inbox`（注册行 `:1417`）；每会话保留 10 条；正文截断 `slice(0, 400)`；持久化 `qq-bridge/state/crosschat.json`（现场 5,828 字节）；唤醒注入位于 `qq-bridge/src/core/crosschat.js:102`，每轮最多 2 条、整行上限 170 字符；两个工具在精简工具档位下均进入 `deny` 名单。现场 `qq-bridge/config.json` 的 `social.slimTools.deny` 共 16 项，包含 `qq_crosschat_inbox` 与 `qq_crosschat_send`【已核验】。目标不可达时留言保留在本机会话表中（`qq-bridge/src/core/crosschat.js`）。

### 20.3 群与好友管理

| 工具 | 注册行 | 权限 |
| --- | --- | --- |
| `qq_admin_set` | `:2361` | 所有者私聊 |
| `qq_blacklist` | `:2342` | 所有者私聊 |
| `qq_whitelist` | `:2380` | 所有者私聊 |
| `qq_remove_friend` | `:2399` | 所有者私聊；精简工具档位下进入 `deny` 名单 |
| `qq_send_forward` | `:2985` | 一般工具 |
| `qq_get_forward_msg` | `:1942` | 一般工具 |

注册行取自 `qq-bridge/src/mcp-napcat-safe.js`；权限指工具内部的受信任判定。好友请求由 `onRequest('friend')` 订阅处理（`qq-bridge/src/bridge.js:622`），`cfg.social.autoFriendApproval === false` 时关闭自动通过【已核验】。

白名单语义：`deny` 名单优先于 `allow` 名单；两侧名单均为空且 `allowAllWhenEmpty` 为真时放行全部并产生告警日志。现场 `qq-bridge/config.json` 的 `allowAllWhenEmpty` 为 `true`，`allow.groups` 为 3 项【已核验】。

撤回操作需先取得目标消息 id：出站消息 id 由 `qq_get_my_recent_messages`（注册行 `:1489`）提供，窗口消息 id 由 `qq_get_message_detail`（`:1507`）提供；撤回动作由 `qq_withdraw_message`（`:1231`）执行；目标 id 不可得时不执行撤回。收到撤回通知后桥侧调用 `markChatRecalled`（`qq-bridge/src/core/chat-db.js:691`）标记库内记录【已核验】。

未核验：QQ 空间接口返回字段全集、资料卡写入的可写字段集合均未逐一核实【未核验】。

## 21. 上下文压缩与令牌预算

### 21.1 用量记账

`qq-bridge/src/core/token-meter.js`（1,034 行）从 DSH 事件流采集用量帧并落盘：帧入口 `meterTokenFrame`（`:550`）；事件处理 `:602-629`（回合与步的起止事件）；落盘文件 `TOKEN_USAGE_FILE`（`:58`，现场 `state/token-usage.jsonl` 60,524 字节）；记录写入 `:413-426`，行格式说明位于文件头注释 `:3-8`；行数上限 `MAX_LINES = 50000`、`PRUNE_TO_LINES = 45000`（`:60-61`）；用量字段采集 `collectUsageFields`（`:429`，深度上限 `MAX_DEPTH = 6` `:62`、数组上限 `MAX_ARRAY_ITEMS = 200` `:63`、字段名映射 `:84-98`）；帧签名 `usageSig`（`:210`，`REAL_SIG_KEEP_MS = 86400000` `:68`、`REAL_SIG_MAX_PER_SESSION = 64` `:69`）；估算补记 `flushEstimate`（`:518`，无 usage 帧时按字符估算：`EST_PROMPT_CHARS_PER_TOKEN = 1.8`、`EST_COMPLETION_CHARS_PER_TOKEN = 2.2`，`:64-65`）；累积上限 `ACC_CHARS_CAP = 5000000`、`ACC_IDLE_FLUSH_MS = 90000`（`:66-67`）；队列帧依赖 `:636`（依赖 `session/queue` 帧判定会话忙碌）；会话归属 `isBridgeOwnedSession`（`:873-888`）。

### 21.2 用量对账与剪枝计量

`startTokenReconcile`（`qq-bridge/src/core/token-meter.js:1026`）周期性以磁盘会话日志校正面板数字：执行间隔 `5 * 60 * 1000`；单次配额 `quotaPerRun = 200`（`:916`）；最长回溯 `DEFAULT_RECONCILE_MAX_AGE_MS = 6` 小时（`:70`）；基线求和 `baseSum`（`:950`）与差额 `deficit`（`:952`）写入补记行 `:986-991`；水位文件 `qq-bridge/state/token-reconcile.json`（`:59`、`:841-863`）；失败分支保留原值并记日志（`:905-915`、`:997`）。启动接线为 `setTokenReconcileHome(...)` 与 `startTokenReconcile()`（`qq-bridge/src/bridge.js:359-360`），日志为 `[token] 用量对账已启用：<home>/storages/session_projcache/sessions`；找不到 DSH home 时输出 `[token] 未找到可用的 DSH home，跳过用量对账（面板数字只按 usage 帧累计）`（`:363`）【据仓库记载】。

`qq-bridge/src/core/context-savings.js`（334 行）统计 DSH 侧剪枝的节省量：状态版本 `STATE_VERSION = 3`（`:37`）；会话日志解码 `decodeSessionLog`（`:86`，zstd 魔数 `0xfd2fb528` `:38`）；统计算法 `:124-137`（按剪枝标记行求和）；扫描节奏 `scanTtlMs = 30000`（`:49`）；失败分支 `:256-261`（沿用旧结果）；时区偏移 `:31-32`。启动接线为 `initContextSavings(...)` 与首次 `reconcileContextSavings(...)`（`qq-bridge/src/bridge.js:380-394`），日志为 `[savings] 剪枝计量就绪：扫描 N 份会话日志（复用 M 份），今日已剪掉 X token / 少读 Y token`；无 home 时输出 `[savings] 未找到 DSH home，跳过剪枝计量（面板不显示该项）`【据仓库记载】。

### 21.3 费用口径与报表

单价取自 `qq-bridge/src/core/token-report.js:19-25` 的 `DEFAULT_TOKEN_COST`，单位人民币元每百万 token，现场配置与默认值一致：`pHit 0.02`（缓存命中输入）、`pMiss 1`（缓存未命中输入）、`pOut 4`（输出）、`peakMult 2`（高峰时段倍率）；高峰时段集合为 `[9,10,11,14,15,16,17]`。

报表文本由 `buildTokenReportText`（`qq-bridge/src/core/token-report.js:117`）生成，失败文案位于 `:123-124`【已核验】。日界偏移 `dayOffsetMin = 480` 定义于 `qq-bridge/src/core/token-meter.js:74-75`，`context-savings.js` 使用同一偏移（`qq-bridge/src/core/context-savings.js:31-32`），环境变量为 `QQ_TOKEN_DAY_OFFSET_MIN`【已核验】；同一性判定 `naturalSame` 位于 `qq-bridge/src/core/token-report.js:134`【已核验】。

### 21.4 工具裁剪与描述压缩

`qq-bridge/src/lib/tool-tiers.js`（226 行）按档位决定注册哪些工具：`ESSENTIAL`（`:35-50`，11 条，无论档位均注册，含 `get_time`）；`OBSERVED_USED`（`:53-71`，17 条，实测被调用过）；`CHEAP_EXTRA`（`:74-78`）；`GROUP_AWARENESS`（`:84-88`）；`PROMPT_NAMED`（`:98-101`，2 条，提示词中点名的两条，并入 `medium` `:131` 与 `high` `:136`）；测量函数 `measureSchemaShare`（`:206`）。档位取值集合为 `off`、`low`、`medium`、`high`、`extreme`、`custom` 六者（`qq-bridge/state/tool-schema-stats.json` 的 `tiers` 键）【已核验】；档位取值非法时按 `off` 处理（`qq-bridge/src/lib/tool-tiers.js`）。

`qq-bridge/src/lib/tool-schema-compress.js`（164 行）按档位压缩工具描述，取值集合 `SCHEMA_LEVELS = ['off','medium','high']`（`:33`），不提供 `low` 档【已核验】；各档语义与不提供 `low` 档的原因见「DSH 集成与上下文压缩接口」章的「工具面」节。

### 21.5 压缩代理与 DSH 补丁

`qq-bridge/src/lib/dsh-side.js`（613 行）在 MCP 挂载配置中把 `mcp-napcat` 指向压缩代理（`mcpBlock()` 位于 `:252-299`，压缩代理参数位于 `:280-288`），参数形态为 `-c <level> -n napcat [--exclude-tools a,b] [--toonify] -- node <script>`；工具调用超时 `toolCallTimeoutMs: 725000`（`:295`）【已核验】；安装版本 `INSTALL_VERSION = 1` 位于 `:25`。压缩代理不可用时回退直连 `mcp-napcat`（`:280-299`）。

`qq-bridge/src/lib/dsh-compaction.js`（223 行）生成写入 DSH home 的 `cordis.patch.yml`：剪枝标记 `PRUNE_MARKER`（`:28`）、摘要输出上限 `SUMMARY_MAX_TOKENS = 4096`（`:31`）、最小工具结果长度 `MIN_TOOL_RESULT_CHARS = 300`（`:33`）、阈值下限 `MIN_THRESHOLD_RATIO = 0.08`（`:51`）、默认阈值 `DEFAULT_THRESHOLD_RATIO = 0.16`（`:54`），钳制段位于 `:65-90`【已核验】。桥侧配置为 `dshCompaction.thresholdRatio = 0.16`、`retainRatio = 0.02`、`toolResultMaxChars = 8192`、`enabled = true`【已核验】。

### 21.6 现场测量数据

`qq-bridge/state/tool-schema-stats.json` 记录一次工具描述体积测量，其 `at` 为 `1790324164428`，`level` 与 `schemaLevel` 均为 `off`，`enabled` 为 `false`，`source` 为 `env-off`，即该次测量在裁剪与描述压缩均关闭的条件下完成【已核验】。样本为 `mcp-napcat` 的 91 个工具，单位字符：注册工具数 / 可用工具数 91 / 91；描述总量 `totalChars` 95595；保留量 `keptChars` 101360；占比 `share` 1.0603；差值 `savedChars` -5765；每步约 token `approxTokensPerStep` 31675。`keptChars` 大于 `totalChars` 的原因为该次测量的 `schemaLevel` 计入了压缩代理附加的说明文本；差值为负表示该次运行未产生节省【已核验】。

各档位保留量（占比为相对 `totalChars` 的比值）：

| 档位 | 占比 | 保留字符 | 保留条数 | 裁剪条数 |
| --- | --- | --- | --- | --- |
| `off` | 1 | 95595 | 91 | 0 |
| `low` | 0.8281 | 79162 | 68 | 23 |
| `medium` | 0.4189 | 40047 | 42 | 49 |
| `high` | 0.3488 | 33344 | 33 | 58 |
| `extreme` | 0.068 | 6497 | 9 | 82 |
| `custom` | 1 | 95595 | 91 | 0 |

单条描述体积前 12 名（同一次测量，单位字符）：`qq_send_pixiv` 6148、`qq_send_rich` 5721、`qq_pixiv_search` 4155、`qq_set_wake_config` 3087、`qq_send_message` 2925、`qq_send_image` 2726、`qq_send_qzone` 2578、`qq_send_voice` 2478、`qq_set_system_config` 2437、`qq_send_forward` 2007、`qq_memory_remember` 1798、`qq_send_meme` 1677。

现场 `qq-bridge/config.json` 的 `social.slimTools` 为 `{ enabled: true, level: 'low', deny: [...] }`，`deny` 列表含 16 项【已核验】。现场 `social` 段不含 `toolCompressor` 键，也不含 `slimTools.schemaLevel` 键，二者仅在 `qq-bridge/config.example.json` 中给出【已核验】。

未核验：现场 `social.slimTools.level` 为 `low` 时实际注册的工具条数未实测；用量对账在跨日边界与 DSH 会话日志被清理后的行为未复现；剪枝计量对 `zstd` 帧之外的会话日志格式的兼容性未核实【未核验】。

## 22. 管理端功能面

### 22.1 职责与进程模型

`server/index.js`（10,122 行 / 633,446 字节）为单进程 Express 服务，监听 `127.0.0.1:1921`（`PORT = process.env.QBM_API_PORT || 1921`，`:9605-9607`）【已核验】。管理端不参与 QQ 消息链路，只承担三类职责：托管页面静态资源、代理桥控制台接口、执行本机与远端的进程与文件操作。关键行为：`QBM_NO_LISTEN=1` 时仅注册路由不监听（`:9600` 附近）；未匹配路径返回单页入口（`:9590`）；`unhandledRejection` 与 `uncaughtException` 只记 `[fatal-guard]` 日志、不退出进程（`:9598-9603`）；`app.listen` 回调内执行 `scheduleAutoStart()`（`:9609`）与 `ensureGuardianArmed()`（`:9610`）（`:9606-9656`）；自动连接延迟 1500 毫秒后执行、60 秒后复查（`:9621-9648`、`:9651-9652`）；桥控制台代理 `proxyToBridgeConsole`（`:7382`），默认超时 30000 定义于 `callBridgeConsole`（`:7315`）。

### 22.2 页面清单

页面为 React 单页应用的十个路由组件，构建产物由管理端进程托管。

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

共用模块：`src/api.ts`（1,025 行 / 56,685 字节）提供接口封装；`src/config-cache.ts`（605 行 / 38,165 字节）提供配置缓存；`src/tool-schema-chars.ts`（125 行）为工具描述字符数的前端副本【已核验】。`src/pages/NetCanvas.tsx` 不含 `/api` 字面量也不调用 `api()`，不直接访问管理与桥接口【已核验】。页面目录下另有一个残留备份文件 `src/pages/InstanceConfig.tsx.bak-deadcard-20260923`（15,227 字节），不被构建引入【已核验】。

### 22.3 路由分组

管理端共注册 93 条带引号路径的路由（判据：排除整行注释后的 `app.(get|post|put|delete|patch)('<path>'`）；另有 1 条正则末位匹配路由 `app.get(/^\/(?!api\/).*/, …)`（`:9590`）与 3 条中间件注册 `app.use(`（`:40`、`:41`、`:9585`）不计入该计数【已核验】。

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

路由全集见附录 C。

### 22.4 配置字段与凭据通道

桥配置的字段全集以 `qq-bridge/config.example.json` 为准，现场值为 `qq-bridge/config.json`。接口密钥不写入 `config.json`：`config.dsh.apiKey` 与 `clearApiKey` 在落盘前被摘除（本机 `server/index.js:5555-5560`，远端 `:7142-7144`），改写入隔离 DSH 的 `.credentials.yaml`【已核验】。

凭据通道构件：`mergeCredentialText`（`server/iso-credential.js:87`）合并凭据文档；`credentialRefsBlock`（`:21`）生成 `refs:` 段；`yamlScalar`（`:59`）标量转义；`credentialStatusFromText`（`:125`）状态解析；`validateCredentialDocument`（`:140`）校验文档结构（顶层只允许 `version`、`refs`、`records`，密钥缩进 2 格写在 `refs:` 下）；`writeIsoCredential`（`server/index.js:5521`）写盘并以 `0600` 权限加 `.bak-<时间戳>` 备份；`isoCredentialStatus`（`:5540`）只返回 `set` 与 `len`，不返回值本身；`providerApiKeyEnv`（`:5495`）生成环境变量名；`isoHomeDir`（`:5461`）解析隔离 home。

远端 `config.json` 的写入顺序为临时文件、`.bak-<时间戳>`、原子 `mv`、回读比对（`:7146-7171`），结果以 `verified` 或 `mismatched` 回传前端【已核验】。桥侧 `POST /api/bridge/config` 同样执行深合并、备份与原子重命名，注册行位于 `:5546`，深合并与写入段位于 `:5571-5594`【已核验】。

桥配置顶层键（取自 `qq-bridge/config.example.json` 的键全集）：`dsh`（`baseUrl`、`provider`、`model`、`reasoningEffort`、`apiKey`、`visionModel`、`visionBaseUrl`、`visionApiKey`）；`dshCompaction`（`enabled`、`thresholdRatio`、`retainRatio`、`toolResultMaxChars`）；`napcat`（`wsUrl`、`httpUrl`、`accessToken`、`launcherPath`、`homeDir`、`allowProcessControl`、`wsAccessToken`、`imageFileMode`、`tmpDir`、`dockerPathMap`）；`pixiv`（`base`、`cookie`、`refreshToken`）；`guard`（`enabled`、`probeIntervalMs`、`failThreshold`、`cooldownMs`、`maxHealsPerHour`、`restartGraceSec`、`recoverWaitMs`、`autoHeal`）；标量键 `ownerQQ`、`sessionCwd`、`agentPreset`、`workspaceTitle`、`allowAllWhenEmpty`、`allowAllPrivate`、`allowAllGroups`、`ackMessage`、`sendDelayMs`、`questionTimeoutMs`、`consolePort`、`consoleToken`；名单键 `allow.private`、`allow.groups`、`deny.private`、`deny.groups`；其它对象键 `prompt.styleLine`、`tokenCost`、`security.interceptNotify`、`slang`、`social`。`social` 下含 `enabled`、`autoReplyCheckMs`、`agentPreset`、`provideRecommendations`、`tools`（30 键）、`wake`、`send`、`wait`、`sticker`、`meme`、`proactive`、`feedback`、`context`、`autoReset`、`sessionArchive`、`steerEnabled`、`charactersDir`、`slimTools`、`turnHold`、`typing`、`toolCompressor`【已核验】。

现场 `qq-bridge/config.json` 与示例文件的键集差异：`napcat` 段实际只有 7 键（`wsUrl`、`httpUrl`、`accessToken`、`wsAccessToken`、`launcherPath`、`homeDir`、`allowProcessControl`），不含 `imageFileMode` 与 `tmpDir`；`social` 段不含 `slimTools.schemaLevel`，也不含 `toolCompressor` 键；示例文件另含若干以下划线开头的说明键（如 `_allowAllNote`、`dshCompaction._note`、`social.send._linearNote`），现场文件不含这些键【已核验】。

### 22.5 随包 QQ 窗口隐藏器

`startNapcatHidden(onekey, quickLogin)`（`server/index.js:1291`）在拉起 NapCat 之前隐藏随包 QQ 的窗口，实现方式为向宿主机投放常驻 C# 脚本（`qqWindowHiderScript(cfg)` `:1348`；类名 `MoonBotQqWinHideResident`；脚本首行注释标明由 `server/index.js` 生成）【已核验】。`QQ_HIDER_DEFAULTS`（`:1336`）：`budgetMs` `43200000`（12 小时，观察者自身存活上限，到点退出，实际退出条件由父进程守卫决定）；`pollMs` `200`（常态轮询间隔）；`burstMs` `50`（目标出现后的快扫间隔）；`burstWindowMs` `5000`（快扫持续时长）；`readyTimeoutMs` `2500`（等待条件就绪的上限）。配套机制：存活的隐藏器登记于集合 `qqHiders`（`:1338`），重启 NapCat 时新实例收掉旧实例，不并行运行；目标进程号由 seed 文件传递（`:1353` 注释）【已核验】。路径守卫为硬条件：只处理可执行文件路径位于本 Shell 目录之下的进程（`:1325-1330` 注释）【已核验】。启动器与命令行的具体拼装未逐行核实【未核验】。

### 22.6 失败与降级

- 桥控制台不可达：返回 `bridge-offline`，区分桥未运行、隧道缺失与超时三类（`server/index.js:7340-7377`）。
- 桥版本过旧（404 或非 JSON）：返回 `bridge-stale` 并提示更新桥代码后重启（`:7328-7338`）。
- 学习配置端点桥不可达：仅在确实连不上时降级——本机直读写文件，远端走 SSH 读写并做备份、原子重命名与回读比对（`:7421-7435`、`:7567-7572`）。
- 本机桥不可用但需查看聊天记录：管理端直读 SQLite（`:5028-5029` 注释）。
- 管理端自身异常：只记 `[fatal-guard]` 日志，不退出（`:9598-9603`）。

未核验：`/api/bridge/chat-stream` 与 `/api/bridge/context-overhead` 的响应字段未取到，其结构未核验；管理端路由的请求与响应字段来自正则抽取，个别端点的字段完整性未核验【未核验】。

## 23. 部署、开机自动连接与运行维护

### 23.1 本机进程编排与退出守卫

进程编排的进程形态、启动方与日志见「进程与模块拓扑」章的进程清单表；单实例锁为 `qq-bridge/state/bridge.lock`（`qq-bridge/src/lib/paths.js:20`）；隔离 DSH 的 home 由 `isoHomeDir` 解析（`server/index.js:5461`）；NapCat 启动器经 `startNapcatHidden` 拉起（`:1291`），窗口由隐藏器处理；退出守卫由管理端拉起。

`server/napcat-guardian.mjs`（146 行）为独立进程，在管理端退出后回收 NapCat 与随包 QQ：父进程存活探测 `alive(parentPid)` `:69-72`，轮询 `setInterval(…, 2000)` `:131`、`:146`；宽限时间默认 `30000` 毫秒（`:52`）；当前守卫进程号 `currentGuardPid()` `:75-77`；清理对象为三条命令（NapCat `:93`、桥 `:103`、DSH `:110`），均带自身排除判定 `NOT_SELF`（`:87`）；命令行参数 `--parent`、`--guard-file`、`--dsh-port`、`--bridge-script`、`--grace`、`--kill-napcat`、`--dirs`、`--log`；状态文件与目录 `GUARDIAN_FILE`、`CONFIG_DIR`、`LOG_DIR`（`server/index.js:43`、`:45`、`:9863`）；装配 `armNapcatGuardian`（`:9942`）与 `spawnGuardianDetached`（`:9884`，以 `guard-node.exe` 硬链接 `:9887-9896` 配合 WMI `Win32_Process.Create` 与 `ShowWindow=0` 启动 `:9907-9913`）；启动后自动装配 `ensureGuardianArmed()`（`:9989`），环境变量 `QBM_NAPCAT_GUARDIAN`（`:9991-9997`）与父进程名正则 `/^MoonBot$/i`（`:9998`）参与判定，复查间隔 60000 毫秒（`:9651`）；手动装配端点 `POST /api/guardian/arm`（`:10016`）；退出端点 `POST /api/shutdown`，请求体 `{all}`（`:10040`）。

### 23.2 完整性自修

`server/napcat-repair.js`（154 行）修复 NapCat 应用被安全软件删除部分文件后的相对导入断裂：扫描深度上限 `if (depth > 8) return;`（`:53`）；检查函数 `checkNapcatApp` 检查四类相对导入是否可解析，四类形态集中在 `relativeSpecifiers`（`:42-45`，具名 `from`、副作用 `import`、动态 `import()`、`require()`）；修复函数 `repairNapcatApp`（`:95`）经 `findShellZip`（`:78-89`）向上查找 10 层内的 `NapCat.Shell.zip` 与同目录 `7z.exe`（`:82`），以 `spawnSync`（`:105`）解压所需文件；入口函数 `ensureNapcatApps` 的返回值定义于 `:135-141`，字段为 `{ok, checked, broken, repaired, detail, error}`；调用点 `server/index.js:2344`；附带修复包括 JSON 首字节序标记清理 `healNapcatJsonBom`（`server/index.js:2355`，调用段 `:2352-2361`）与 VC++ 运行库检查 `healNapcatVcruntime`（`:2365`，调用段 `:2362-2371`）；记录的根因见 `server/napcat-repair.js:4-14` 注释，目标文件随版本变化（`conout-D9oph_Le.js` 与 `conout-wiJ7YKRd.js` 列于 `:10-11`）。

### 23.3 远端部署

`server/deploy.js`（1,652 行）实现 SSH 远端克隆部署：任务表 `deployTasks`（`:25`）；任务号格式 `:1632`；日志上限 800 行（`:46`）；步骤辅助 `step()` 与 `safely()`（`:1059-1073`）；主体 `runDeploy`（`:1046`），执行段 `:1075-1601`，异常与收尾段 `:1602-1625`；流式转发超时 `streamPipe` 1800000（`:99`）；保留脚本生成 `buildDeployKeepScript`（`:366-423`）、`buildStagePlan`（`:424`）；systemd 单元模板 `napcat.service`（`:568-601`，`ExecStart=/opt/napcat/run-napcat.sh` 位于 `:586`）与 `dsh-web.service`（`:1419-1436`，`ExecStart` 位于 `:1428`）；卸载栈端点 `POST /api/ssh/remove-stack`（注册行 `server/index.js:4209`，其内的目录移动命令位于 `:4226`）；栈管理说明注释 `:4257-4259`（路由注册行 `:4260`）；服务名校验 `:4376-4378`（路由注册行 `:4327`）；同步端点 `:3876-3892`（路由注册行 `:3843`）；部署脚本安装 `mcp-compressor==0.31.9`（`server/index.js:1167`）。

### 23.4 开机自动连接

自动连接编排 `scheduleAutoStart()`（`server/index.js:10077-10118`），顺序为 napcat-local、dsh-isolated、bridge-local，间隔 1200 毫秒；单条连接 `connectOne`（`:447-474`）；隧道映射 `tunnelMapFor`（`:189-197`，映射关系见「进程与模块拓扑」章的端口分配表）；隧道建立 `ensureTunnels`（`:240-261`），建隧道超时 8 秒（`:232`）；端口占用 `EADDRINUSE` 时退避重试（`:217-221`）；重连退避 `RECONNECT_BACKOFF_MS`（`:289`）；手动断开标记 `manualDisconnects`（`:283`、`:333`）；连接替换 `replacingConnections`（`:287`、`:308-313`、`:336`）；服务就绪等待 `waitServerReady`（`:402-441`，`waitServerMs = 150000`、`pollMs = 4000`）。

### 23.5 日志与状态文件

| 载体 | 路径 | 现场规模 | 写入方 |
| --- | --- | --- | --- |
| 桥日志 | `qq-bridge/state/bridge.log` | 311,160 字节 | `qq-bridge/src/lib/log.js`，保留最近 2000 行（`:15`） |
| 工具调用日志 | `qq-bridge/state/tool-calls.jsonl` | 487,098 字节 | `qq-bridge/src/core/audit.js:76`，上限 2000 行（`:104`） |
| 反馈日志 | `qq-bridge/state/feedback.json` | 1,394 字节 | `qq-bridge/src/core/audit.js:51`，上限 500 条（`:58`） |
| 用量日志 | `qq-bridge/state/token-usage.jsonl` | 60,524 字节 | `qq-bridge/src/core/token-meter.js:413-426` |
| 活动记录 | `qq-bridge/state/qq-activity.log` | 56,072 字节 | 桥各模块的 `appendActivity` |
| 桥 stdout / stderr | `qq-bridge/state/bridge-stdout.log`、`bridge-stderr.log` | 1,047 / 169 字节 | 进程重定向 |
| 其它 | `state/` 下另有 22 个文件 | — | 见各章 |

### 23.6 失败、降级与未核验

失败路径：退出守卫回收受管进程与 NapCat 缺失文件的补齐见「可靠性与可观测性」章的崩溃自愈场景与手段；隧道端口被占用时退避后重试建立（`server/index.js:217-221`）；远端服务未就绪时按 4000 毫秒轮询、最长等待 150 秒（`:402-441`）；桥锁冲突时目标进程输出提示并以退出码 2 结束（`qq-bridge/src/core/runtime.js:38/53`）。

未核验：仓库内不存在开机自启动项的实现——`schtasks`、注册表 `Run` 键、启动目录 `.lnk` 快捷方式在排除依赖与产物目录后命中数为 0【已核验】，`tools/start-manager-hidden.vbs` 为隐藏启动器、其中不含自启注册逻辑【已核验】，自启动的实际来源在仓库之外【未核验】；仓库根 `scripts/` 目录为空，部署相关脚本实际分布在 `server/deploy.js`、`server/index.js`、`qq-bridge/scripts/` 与 `tools/`，该分布的成因未核验；`qq-bridge/music-sign-proxy.py`（241 行，`127.0.0.1:4567`）在仓库的 JavaScript 与配置文件中无引用，仅见于 `docs/release-1.0.0.md:23`【已核验】，随包 NapCat 的 `onebot11_3199924964.json:52` 配置了 `musicSignUrl` 指向 `http://127.0.0.1:4567/music_card/card`【已核验】，桥侧未配置该值，该代理在当前部署下是否随桥启动未核验【未核验】。

## 24. 安全模型与信任边界

### 24.1 敏感内容判定与脱敏

`qq-bridge/src/sensitive.js`（37 行）提供三组正则与两个判定函数：`PATH_RE`（`:13`，本机文件路径）、`SECRET_PATH_RE`（`:15`，凭据类文件路径）、`CRED_RE`（`:16`，凭据字面量）、`SENSITIVE_RE`（`:18`，三者的合成式）；`sensitiveHitKind(text)`（`:21`）返回 `'path'`、`'secret-path'` 或 `'credential'`；`sensitiveHitSample(text, max = 48)`（`:30`）截取样本，遍历范围为 `PATH_RE` 与 `CRED_RE`，不含 `SECRET_PATH_RE`；设计边界说明见 `:1-11`（该模块只判定形态，不判定语义）。调用点共四处，全部为 HTTP 403：`qq-bridge/src/core/console-server.js:1191`、`:2137`、`:2488`、`:5180`【已核验】。

`qq-bridge/src/lib/text-safe.js`（247 行）提供脱敏与泄露判定：`KNOWN_AGENT_TOKENS`（`:6`）、`LEARNER_AGENT_TOKENS`（`:12`）、`redactSensitiveText`（`:16`，日志与落盘前的统一脱敏入口）、`SENSITIVE_ARG_KEYS`（`:33`，发送参数中需判定的键共 21 键）、`TOKEN_LABEL_SRC`（`:106`）、`tokenDisclosureIn(text)`（`:108`）、`splitSerializedBubbles`（`:221`）。日志脱敏在 `qq-bridge/src/lib/log.js:8` 与 `:24` 两处执行【已核验】。

### 24.2 网络请求目标限制

出站抓取统一经 `qq-bridge/src/safe-fetch.js`（456 行），判定顺序为解析主机、校验网段、连接、复检重定向目标（见「媒体处理」章的「下载与安全抓取」节）；私有网段清单覆盖 IPv4 与 IPv6 两类并解嵌 IPv4-mapped 与 NAT64 形式（`qq-bridge/src/safe-fetch.js:66`）【已核验】。该模块不注册 MCP 工具，仅作为库被引用【已核验】。媒体层的字节与像素双闸（`qq-bridge/src/core/media-pipe.js:15-17`）在下载之后执行，用于限制进入模型上下文的体积【已核验】。

### 24.3 信任等级判定

| 等级 | 判定条件 | 授权范围 |
| --- | --- | --- |
| `owner-private` | 令牌对应所有者账号且为私聊 | 全部接口 |
| `trusted-spoke-here` | 在信任窗口内于本会话发言的账号 | 会话范围内的接口 |
| 无等级 | 令牌缺失或失效 | 读取端点 403 |

行号取自 `qq-bridge/src/core/console-server.js`；信任窗口 `TRUST_SPOKE_WINDOW_MS = 600000`（`:249`），判定函数 `trustLevelForToken`（`:269`）【已核验】。非受信任者调用受限端点时返回固定文案，该文案位于 `:277`，其中含权限角色称谓，本文以 `[owner]` 替代该称谓，原文见该行【已核验】。

### 24.4 静默与审计边界

| 机制 | 行为 | 证据 |
| --- | --- | --- |
| 审计范围 | `shouldAuditKey()` 恒返回真，全部会话均需审计 | `qq-bridge/src/core/audit.js:15-17` |
| 静默态下的静默回复 | 非所有者私聊禁止静默回复 | `qq-bridge/src/core/audit.js:19-22` |
| 拦截通知 | 拦截后不向 QQ 发送任何通知，只记日志与活动记录 | `qq-bridge/src/core/audit.js:24-30` |
| 反馈落盘 | 写入前对 `message` 字段执行脱敏 | `qq-bridge/src/core/audit.js:51-59` |
| 凭据通道 | 密钥不写入 `config.json`，见「管理端功能面」章的「配置字段与凭据通道」节 | `server/index.js:5555-5560` |
| 状态文件权限 | 单实例锁与令牌文件以 `0o600` 写入 | `qq-bridge/src/core/runtime.js:13`、`qq-bridge/src/core/learning-token.js` |

### 24.5 失败与降级

- 敏感内容命中：403 或抛错，不静默放行（`qq-bridge/src/core/console-server.js:1191/2137/2488/5180`、`qq-bridge/src/core/qq-send.js:197-201`）。
- 抓取目标为私有网段：拒绝连接（`qq-bridge/src/safe-fetch.js:66/132`）；重定向指向私有网段：复检后拒绝（`:376-378/382-385`）。
- 令牌缺失：403；非 JSON 请求体：415；跨 Origin 请求：403（`qq-bridge/src/core/console-server.js:714-717`、`:698-700`、`:702-710`）。

未核验：敏感判定的误报与漏报比例未做测量；私有网段判定的运行期拦截行为未逐段复现，结论来自静态阅读【未核验】；`qq-bridge/src/core/console-server.js:277` 文案的完整内容含权限角色称谓，未逐字转录。

## 25. 上下文压缩数学建模

本节对上下文治理链路作形式化：会话历史的符号定义、分块与摘要的递归结构、触发判据、收益与代价函数的一阶条件、多级压缩的误差传播、记忆窗口与压缩的分离、复杂度，以及验证方法与标定边界。范围限于仓库内可读到的实现与可执行脚本的产物；模型自身的行为建模与仓库中未出现的部署配置不在范围内。阈值的出厂取值 $0.16$（窗口占比）不是经验值：它是本模型的解析解与数值扫描在**历史样本**上的结果，同时落在**最新样本**的实测稳健区间内；服务端与桌面端各自用不同样本标定，落在同一量级。常量与函数名均标注仓库内相对路径与行号，写法为 `path/to/file.js:123`，区块写作 `path:lineA-lineB`；凡标注 **【未核验】** 的条目均表示无法从代码或可执行脚本确证，不得当作结论使用。
**口径声明（2026-09-25 复算后）**：$0.16$ 是**出厂值**，在最新生产样本上位于稳健区间 $[0.12,0.16]$ 的**上端**，与最新样本的最优点 $0.14$ 相差约 $1.2\%$ 的日成本，即 $\frac{2.082-2.057}{2.057}=1.2\%\ <\ 2\%$。因此不使用"$0.16$ 最省"这一绝对表述；该取值的确切含义是"落在实测稳健区间内、且相对最优点劣化不超过 $2\%$"。

| 证据等级 | 判据 | 呈现方式 |
| --- | --- | --- |
| 【已核验】 | 本轮读过目标文件，或本轮执行过命令并留有输出 | 给出 `path:line` 或命令与输出数值 |
| 【据仓库记载】 | 引自代码注释、提交信息或既有文档，本轮未复现 | 给出被引位置，并声明未复现 |
| 【未核验】 | 推断、估计，或无法从仓库确证 | 显式标注，不作为结论 |

## 26. 符号系统、建模假设与事实来源

**定义 1.1（会话历史）.** 会话历史是事件的有限序列 $\mathcal{E}=(e_1,e_2,\dots,e_N)$，$e_i\in \mathcal{T}$，其中 $e_i$ 携带单调递增的序号 $seq(e_i)=i$ 与时间 $time(e_i)$；压缩相关的事件为 `compaction/start`、`compaction/summary`、`compaction/prune`、`compaction/end`（`dsh/packages/session/session-format-v0-to-v1/src/dispositions.ts:53-56`）【已核验】。
**定义 1.2（表层序列与派生消息）.** 会话另有**表层序列**（surface）$S=(u_1,\dots,u_M)$，$u_j$ 为模型可见位置上的节点，每个节点由某个事件经 `deriveEventMessage()` 派生；事件类型分为"追加"与"替换"两类，替换事件携带 `surfaceOp: { op:'replace', start, end }`，把当前表层的一段区间整体换成新节点（`dsh/packages/llm/token-meter/src/surface-fold.ts:114-149`）【已核验】。
**定义 1.3（token 计数函数）.** 记 $\theta(\cdot)$ 为消息的启发式 token 价格（量纲：token），具体地（`dsh/packages/llm/token-meter/src/estimate.ts`）【已核验】：

$$
\theta_{\text{text}}(t)=\left\lceil \frac{|t|}{4}\right\rceil+4,\qquad
\theta_{\text{msg}}(m)=\sum_{b\in m.\text{content}}\theta(b)+4,
$$

其中 $|t|$ 为字符串长度，$4$ 为 `CHARS_PER_TOKEN`（同文件第 13 行），每块结构开销 `BLOCK_OVERHEAD = 4`（第 16 行），每条消息角色 framing 开销 `ROLE_OVERHEAD = 4`（第 19 行）；工具调用块按名称与参数字符串分别取 $\lceil\cdot/4\rceil$ 再加块开销，工具结果块对其嵌套内容递归求价再加块开销。系统的提示词与工具 schema 部分为

$$
H(\text{header})=\underbrace{\left\lceil \frac{|\text{system}|}{4}\right\rceil+4}_{\text{系统提示词}}+\underbrace{\left\lceil \frac{|\mathrm{JSON}(\text{tools})|}{4}\right\rceil+4}_{\text{工具 schema}},
$$

对应 `estimateHeader()`（`estimate.ts:97-99`）【已核验】。
**定义 1.4（压力）.** 会话当前的请求压力为 $P=\max\!\bigl(0,\;P_{\text{base}}+\Delta_{\text{surface}}\bigr)$，$P_{\text{base}}$ 为锚点基线，$P_{\text{base}}\cdot 10^{-6}$ 即"最近一次成功调用在模型侧留下的可见 token 总数"，$\Delta_{\text{surface}}$ 为当前表层相对锚点的签名差（`dsh/packages/llm/token-meter/src/index.ts:154-188`，字段定义见 `types.ts:22-35`）【已核验】；`measure()` 的复杂度为 $O(|S|)$（同文件第 138 行注释：`measurement is O(surface)`）【已核验】。
**定义 1.5（上下文窗口与预算）.** 记 $W$ 为被路由模型的上下文容量（量纲：token）。桌面端 DeepSeek 适配器的出厂值为 $W_{\text{default}} = 1{,}000{,}000$（`dsh/packages/llm/llm-deepseek/src/adapter.ts:140`，`DEFAULT_CONTEXT_WINDOW = 1_000_000`）【已核验】；若换用 pi-ai 适配器则为 $262{,}144$（`dsh/packages/llm/llm-pi-ai/src/config.ts:61`）【已核验】。窗口缺失时压缩器直接报错，不取默认值（`dsh/packages/compaction/compaction-basic/src/index.ts:297-303`）【已核验】。
**定义 1.6（阈值与保留量）.** 令 $\tau\in(0,1]$ 为阈值比例、$\rho\in(0,1)$ 为逐字保留比例，则

$$
T=\lfloor \tau W\rfloor,\qquad R = \begin{cases}\rho W \text{ 取整} & \text{若未显式指定 retainTokens}\\ \text{retainTokens} & \text{否则}\end{cases}
$$

（`dsh/packages/compaction/compaction-basic/src/config.ts:133-167`）【已核验】。**加载期硬约束**：$R<T$，否则策略解析抛 `TargetPressureConfigError`（同文件第 148-154 行）【已核验】。
**定义 1.7（单价）.** 全部单价量纲为 ¥/M token（元每百万 token）。

| 符号 | 名称 | 值 | 出处 |
| --- | --- | --- | --- |
| $\mathrm{pHit}$ | 缓存读 | $0.02$ | `qq-bridge/config.json` → `tokenCost`；`qq-bridge/src/core/token-report.js:19-25` |
| $\mathrm{pMiss}$ | 缓存未命中输入 | $1$ | 同上 |
| $\mathrm{pOut}$ | 输出 | $4$ | 同上 |
| $\mathrm{mult}$ | 高峰倍率 | $2$ | 同上 |
| $\mathcal{H}$ | 高峰小时（北京时） | $\{9,10,11,14,15,16,17\}$ | 同上 |
| $h_{\text{hit}}$ | 默认命中率（管理端展示用） | $0.98$ | `src/pages/Learning.tsx` → `COST_DEFAULT` |

单次请求计价（量纲：¥）为

$$
\text{cost}(req)=\frac{\mathrm{cacheRead}\cdot \mathrm{pHit}+\mathrm{prompt}\cdot \mathrm{pMiss}+\mathrm{completion}\cdot \mathrm{pOut}}{10^{6}}\cdot \mathrm{mult}\bigl(h(time(req))\bigr),
$$

其中 $h(\cdot)$ 取北京时间小时、$\mathrm{mult}(h)=\mathrm{mult}$ 当 $h\in\mathcal{H}$ 否则 $1$；**逐请求**按小时判定倍率的实现见 `qq-bridge/tools/compaction-threshold.mjs:26-29`（`costOf`）与 `qq-bridge/src/core/token-report.js:67-94`（`summarizeMeasuredCost`）【已核验】。上下文本体的边际成本按缓存读价计、前缀失效后的整段重读按未命中价计，二者相差 $50$ 倍，因此上下文长度 $C$ 本身不是成本主项，**前缀重建的次数与重建时的上下文长度**才是。
**量纲提示.** 后文 $b$ 的量纲为 ¥/token/步，而 $\mathrm{pHit}$ 的量纲为 ¥/M token，折算关系为 $b=\mathrm{pHit}\times10^{-6}$；桌面端标定脚本中该折算写作 `T = (v) => v * 1e-6`（`docs/dsh-compaction-math.mjs:16`）【已核验】，$\mathrm{pHit}=0.02$ 对应 $b=2\times10^{-8}$。
**建模假设清单（可证伪）.**

| 编号 | 假设 | 依据 | 违反后果 |
| --- | --- | --- | --- |
| A1 | 常规步的前缀命中缓存，边际按 $\mathrm{pHit}$ 计 | 服务端实测回归斜率 $0.022$ ¥/M ≈ $\mathrm{pHit}$（数据来自 `qq-bridge/state/token-usage.jsonl`）；桌面端累计 cacheRead $24.8\times10^{8}$ 对未命中 $3.03\times10^{7}$（commit `fdadc11` 说明与 `~/.dsh/profiles/web/cordis.patch.yml:165`） | 若 $\mathrm{pHit}\to\mathrm{pMiss}$，最优阈值趋于 $R$，即最小保留量 |
| A2 | 一次压缩或轮换之后，下一次请求整段重读 | 重建事件判据：同会话上下文回落到前次 $60\%$ 以下（`qq-bridge/tools/compaction-threshold.mjs:76`） | 若重读被局部命中，重建成本被高估 |
| A3 | 上下文在一个压缩周期内线性增长 | 周期步数 $N=(T-R)/g$ 的定义（`tools/compaction-threshold.mjs:96`；`docs/dsh-compaction-math.mjs:40`） | 真实步长有抖动，闭式解与扫描解出现系统性小偏差（$15.3\%$ 对 $16.0\%$） |
| A4 | 每步增量 $g$ 在周期内为常数、与 $C$ 无关 | 用于把 $\bar C$ 取为 $(R+T)/2$ | 若 $g\propto C$（例如检索量随历史增长），$\bar C$ 需改为几何平均 |
| A5 | 摘要是保内容的，其体量 $s$ 与 $R$ 无强相关 | 桌面端脚本固定 $s=3000$（`docs/dsh-compaction-math.mjs:22`） | 若 $s$ 随 $R$ 增长，重建成本上升，$T^{*}$ 上移 |
| A6 | 固定开销 $F$ 与阈值无关 | 压缩器不能修改系统提示词与工具 schema（`dsh/packages/compaction/compaction-basic/README.zh.md`：*"只压缩派生历史——无法缩减系统提示词、工具与会话前缀"*） | 假设成立性由代码结构保证，非近似 |

**固定开销 $F$ 的实测口径.** 仓库中把 $F$ 取为 $F_{0}=27{,}500\ \text{token}$，并在该处标注其口径为"system + 工具表，实测（旧值；压缩后实际更小，用它当保守下限）"（`qq-bridge/tools/test-dsh-compaction.mjs:74`）【据仓库记载】；该值被用于**门禁**（gate）而不是用于拟合：测试断言 $\tau W \ge 1.5F_0$（同文件第 79 行）【已核验】。固定开销的两组量级测量（同一现象的不同截面）：工具 JSON schema 合计约 $8.0\times10^{4}$ 字符 $\approx 2.4\times10^{4}$ token/步、单次请求 system 约 $5.4\times10^{4}$ 字符（均见 `qq-bridge/src/lib/tool-tiers.js:4-5`）；单次请求（较早观测）约 $26$k token，其中约 $87\%$ 为工具 JSON schema（`qq-bridge/dsh/agent-presets/qq-chat/agent.cordis.yml:188-190`）。

## 27. 上下文的分块模型与摘要的递归结构

**定义 2.1（定价表层）.** 定价表层是一个有序节点数组 $\mathcal{N}=(n_1,\dots,n_M)$，$n_j$ 携带字段

$$
n_j=\bigl(seq_j,\; heuristicTokens_j,\; imageStructuralTokens_j,\; fileStructuralTokens_j,\; images_j,\; files_j\bigr)
$$

（`dsh/packages/llm/token-meter/src/surface-fold.ts:28-41`）【已核验】。
**定义 2.2（折叠算子）.** 对每个表层事件，`planSurfaceTokens` 生成一个计划；计划要么是追加、要么是一个区间替换：

$$
\text{plan}(n,e)=
\begin{cases}
\bigl(\theta(e),\;+\theta(e),\;\texttt{append}\bigr), & \text{op}=\texttt{append},\\[2pt]
\Bigl(\theta(e),\;\theta(e)-\sum_{j=a}^{b}\theta(n_j),\;\{a,b\}\Bigr), & \text{op}=\texttt{replace}(a,b),
\end{cases}
$$

其中 $b$ 为区间末索引、$a\le b$ 必须存在，否则抛 `invalid current range`（`surface-fold.ts:114-135`）【已核验】；`commitSurfaceTokens` 以 `splice` 落地，实现幂等且不可失败（同文件第 143-149 行）【已核验】。**这条 plan/commit 分离是压缩机制可重放性的基础**：任意抛出都发生在只读阶段，因此同一个畸形事件在每次重试时失败方式完全一致。
**引理 2.1（表层压力的可加性）.** 表层压力等于各节点价格之和，与压缩历史无关：$\mathrm{surfaceTokens}=\sum_{j=1}^{M}\theta_j$，因为替换是"删区间、插单点"，价格变化恰为 $\theta(e)-\sum_{j=a}^{b}\theta_j$。证毕。
**推论 2.1.** 工具结果剪枝与摘要压缩的**区别仅在于替换算子**：剪枝的替换区间长度为 $1$（单节点就地替换），摘要的替换区间长度为 $L\ge2$（多节点塌缩为 $1$ 个）；两者共用同一套定价协议，因此对压力的贡献可线性相加。
**定义 2.3（工具配对平衡的切点）.** 对表层 $\mathcal{N}$ 的第 $i$ 个位置，定义其**前置切**的平衡量 $\beta_i=\#\{\text{tool-call}\in u_1..u_{i-1}\}-\#\{\text{tool-result}\in u_1..u_{i-1}\}$，并把第 $i$ 个位置之前的切点称为**平衡切**当且仅当 $\beta_i=0$；此外定义末尾切点（$i=M+1$）的平衡量为 $\beta_{M+1}$（`dsh/packages/compaction/compaction/src/tool-pairing.ts:11-38, 93-101`）【已核验】。平衡状态以增量方式维护，缓存键为表层**改写代数** `replaceGeneration`，代数变化或缓存陈旧即重建（`tool-pairing.ts:71-91`）【已核验】；遇"工具结果没有前置调用"时该折叠抛错，即**日志损坏必须显式失败**而不是跳过（同文件第 58-60 行）【已核验】。与固定长度滑窗切块的方案不同，该实现**不做块内重叠，也不使用固定长度分块**，切点由下述**结构性**规则确定。
**定义 2.4（保留尾部的选择算子）.** 给定定价表层 $\mathcal{N}$ 与保留预算 $R$，从尾部向前累加 $\text{keepFrom}=\min\bigl\{i\;\bigm|\;\sum_{j=i}^{M}\theta_j\ \ge R\bigr\}$，若不存在则取 $0$；随后向后回退直到落在平衡切上：$\text{keepFrom}\leftarrow \text{keepFrom}\ \text{逐步减 }1\ \text{直至 } \beta_{\text{keepFrom}}=0$。可压缩区间为 $[\,seq_1,\;seq_{\text{keepFrom}-1}\,]$（闭区间，位置制）；若 $\text{keepFrom}=0$ 则返回 `null`，即**无可压缩区间**（`dsh/packages/compaction/compaction-basic/src/region.ts:100-136`）【已核验】。
**性质 2.1（切点的三条边界条件）.**

| 条件 | 内容 | 后果 |
| --- | --- | --- |
| 工具配对完整性 | 区间端点永不落在未配对的 `tool-call` 与 `tool-result` 之间 | 越界即回退；硬约束，无法通过配置放宽 |
| 头部锚定 | 区间起点恒为表层首节点 $seq_1$ | 压缩只从最老一段塌缩，不产生中间空洞 |
| 保留预算的离散化误差 | 由于回退只做减法，实际保留量受 $R \le \sum_{j=\text{keepFrom}}^{M}\theta_j \le R+\max_j\theta_j$ 约束 | 超出量的上界是单个节点的价格 |

当历史含超大工具结果时，该上界可远大于 $R$——这也是剪枝器必须独立存在的原因：先把超大单节点压下来，才能让上界收紧。
**推论 2.2（实际保留量的期望）.** 若节点价格近似独立同分布、均值 $\bar\theta$，则回退步数近似几何分布，$\mathbb{E}[\,\text{keepFrom 回退步数}\,]\lesssim (1-p_0)^{-1}$，其中 $p_0$ 为随机切点即平衡切的概率。该式仅作量级参考，**【未核验】**：仓库中没有对 $p_0$ 的实测。
**定义 2.5（检查点节点）.** 摘要的落地形态是**一条合成的 user message**，内容为

$$
\text{ckpt} = \bigl[\;\text{PREAMBLE}\;\bigr]\;\Vert\;\texttt{<compacted-summary>}\;\Vert\;\text{summary}\;\Vert\;\texttt{</compacted-summary>},
$$

（`dsh/packages/compaction/compaction-basic/src/summarizer.ts:20-22, 69-70, 189-195`）【已核验】。它携带可识别的来源标记 `{ kind:'plugin', plugin:'compact' }`，供持久化检查点识别（`dsh/packages/compaction/compaction/src/checkpoint.ts:19-50`）【已核验】。
**定义 2.6（摘要指令的结构模板）.** 摘要输出被约束为**固定 8 段 Markdown 结构**：Primary Request and Intent、Key Technical Concepts、Files and Code、Errors and Fixes、Pending Jobs、Current Work、Next Step、Critical Context；空段必须写 `"(none)"` 而不得省略；并显式要求保留精确文件路径、命令、错误串、标识符、数值、函数签名与语法片段（`summarizer.ts:31-66`）【已核验】。
**性质 2.2（指令对递归的处理方式）.** 模板中含一条针对既有检查点的规则：

> *"If the conversation already contains a `<compacted-summary>` block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure."*（`summarizer.ts:65`）

即递归摘要不是逐层嵌套，而是**扁化（flattening）**：第 $k$ 次压缩的输入是"上一次的单一检查点 + 新历史"，输出仍是单一检查点。形式化地，若记 $\sigma_k$ 为第 $k$ 代摘要、$C_k$ 为第 $k$ 代新增内容，则 $\sigma_{k+1}=\Pi\bigl(\sigma_k \oplus C_{k+1}\bigr)$ 且 $|\sigma_{k+1}| \ll |\sigma_k|+|C_{k+1}|$，$\Pi$ 为摘要算子。**这一点直接决定误差模型是"加性累积"而不是"几何衰减"**，见定理 7.1 及其后的讨论。
**定义 2.7（剪枝算子）.** 剪枝按**字符（Unicode 码点）**而非 token 预算，是一个确定性的、不发模型请求的算子。设工具结果文本块的总码点长度 $L$，预算三元组 $(\Theta, \alpha, \omega)$ =（`thresholdChars`, `headChars`, `tailChars`）：当 $L\le\Theta$ 时算子为恒等（返回 `null`）；当 $L>\Theta$ 时，删除区间 $[\alpha,\;L-\omega)$ 并以固定标记 $\mu$ = `"\n\n[... tool result middle pruned ...]\n\n"` 替换，保留头部 $[0,\alpha)$ 与尾部 $[L-\omega,L)$（`dsh/packages/compaction/compaction-tool-result-pruner/src/index.ts:83-122`，标记定义在同包 `src/config.ts:7`）【已核验】。
**定义 2.8（预算的可行性约束）.** 加载期强制 $\alpha+\left|\mu\right|+\omega \le \Theta$，$\Theta\in\mathbb{Z}_{>0},\ \alpha,\omega\in\mathbb{Z}_{\ge0}$，违反即抛 `ToolResultPruneConfig` 错误（同包 `src/config.ts:51-63`）【已核验】；出厂默认 $(\Theta,\alpha,\omega)=(8192,4096,1024)$（同文件第 10-14 行）【已核验】。
**性质 2.3（剪枝算子的三条不变量）.** ① 幂等性：剪枝后内容长度 $\alpha+|\mu|+\omega\le\Theta$，故二次调用返回恒等，实现由显式断言保证（"replacement must be smaller and within threshold"，`index.ts:116-121`）；② 富块序保持：非文本块原样透传，只改写文本块（同文件第 93-97 行）；③ 回放可恢复：替换事件与一条 `compaction/prune` 事件**同步相邻**，后者携带 `shadowedRange`、`shadowedSeqs`、`shadowedTokenCount`，使纯消费者无需保存逐节点状态即可从压力中减去被遮蔽量（`index.ts:159-173`；事件 schema 见 `dsh/packages/compaction/compaction/src/types.ts:83-88`）。
**性质 2.4（切分按码点而非 UTF-16 单元）.** 文本切片用 `Array.from(text)` 得到的码点数组，故保留边界不会劈开代理对；但**字素簇仍可能被劈开**（`index.ts:99-110`，函数文档 `76-82` 明确写出该已知限制）【已核验】。这是保真度分析中一类可量化的边界损失。
剪枝预算的落地取值在两个部署间不同：DSH 插件出厂与桌面端 `web` profile 补丁均为 $8192/4096/1024$（`compaction-tool-result-pruner/src/config.ts:10-14`；`~/.dsh/profiles/web/cordis.patch.yml:200-205`），QQ 桥 preset 为 `thresholdChars 25000`、`headChars 22800`、`tailChars 2000`（`qq-bridge/dsh/agent-presets/qq-chat/agent.cordis.yml:210-215`）。桥侧的推导规则是**按比例分配**：$(\alpha,\omega)=(\lfloor0.6\,\Theta\rfloor,\lfloor0.2\,\Theta\rfloor)$，余下 $20\%$ 留给标记；若标记超预算则把 $\Theta$ 抬到 $\alpha+|\mu|+\omega+32$ 并重算（`qq-bridge/src/lib/dsh-compaction.js:76-90`）【已核验】。
**实测项：QQ 桥 preset 的阈值项取值.** QQ 桥 preset 只配置了剪枝预算，**没有配置** `thresholdRatio` / `retainRatio`（`agent.cordis.yml:206-215`）【已核验】，因此该 preset 下这两项取 DSH 出厂缺省 $\tau_0=0.8$、$\rho_0=0.16$（`compaction-basic/src/config.ts:20-23`）【已核验】。该 preset 的 `<DSH_HOME>` 级 `cordis.patch.yml` 覆盖是否生效 **【未核验】**：本机既没有 `<DSH_HOME>/cordis.patch.yml`（已确认不存在），桥侧写入的 home 也取决于 `QQB_DSH_HOME` 的解析结果，而该环境变量在本会话中为空。

## 28. 成本模型与压缩触发判据

**定义 3.1（单步成本）.** 记第 $t$ 步的上下文（送入模型的输入规模，量纲：token）为 $C_t$，则该步的成本（量纲：¥）为 $\kappa(C_t)=a_0+b\,C_t$，其中 $a_0$ 为每步固定开销（输出、框架开销等吸收在截距内，量纲：¥），$b=\mathrm{pHit}\times10^{-6}$ 为每 token 每步的边际成本（量纲：¥/token/步）。**该形式的依据**：对"上下文 $\ge 50$k 的常规步"做线性回归得到 $\text{每次}\approx \text{¥}0.0020+0.022\ \text{¥/M}\times C$（`qq-bridge/src/lib/dsh-compaction.js:44-45`；原始口径与分桶表见 `qq-bridge/src/core/config.js:41-56`）【据仓库记载】；斜率 $0.022$ ¥/M 与 $\mathrm{pHit}=0.02$ ¥/M 仅差 $10\%$，与该模型"边际即缓存读价"的假设一致，截距 $a_0\approx\text{¥}0.0020$ 在桌面端脚本中被直接沿用为常量（`docs/dsh-compaction-math.mjs:25`）【已核验】。**口径提醒**：上述回归的 $x$ 变量是 `cacheRead`（缓存读 token），而不是 `totalTokens`；把回归结论迁移到 $P$（定义 1.4，含 header 估计）需要额外的等价性论证，**【未核验】**——在缓存全命中的稳态下二者近似一致，在重建步上不一致，这也正是重建步需要单独建模的原因。
**定义 3.2（压缩周期）.** 一次"压缩—增长—再压缩"构成一个周期。在假设 A3、A4 下：$N=\frac{T-R}{g}$（周期步数）、$\bar C=\frac{R+T}{2}$（周期内平均上下文）、$\frac{n_{\text{step}}}{N}=$ 每天重建次数，其中 $n_{\text{step}}$ 为每日步数（`docs/dsh-compaction-math.mjs:37-47` 的 `model()`）【已核验】。
**定义 3.3（日成本泛函）.** 令 $\kappa_{rb}$ 为单次重建成本（量纲：¥），$n$ 为每日步数，则

$$
\boxed{\ \Phi(T)=n\Bigl(a_0+b\,\frac{R+T}{2}\Bigr)+\frac{n\,g}{T-R}\,\kappa_{rb}\ }
\tag{3.1}
$$

（与 `docs/dsh-compaction-math.mjs:42-46` 的 `carry / rebuild / fixed` 三项逐一对应；服务端脚本同式为 `qq-bridge/tools/compaction-threshold.mjs:96-101`，其中 $n$ 记作 `stepsPerDay`。）【已核验】
**定义 3.4（重建成本）.** 一次重建由"按未命中价重读保留段"与"写出摘要"两部分构成：

$$
\kappa_{rb}=\mathrm{pMiss}\cdot 10^{-6}\cdot R+\mathrm{pOut}\cdot 10^{-6}\cdot s.
\tag{3.2}
$$

$s$ 为摘要体量的 token 数；桌面端脚本取 $s=3000$，代入 $R=20{,}000$ 得 $\kappa_{rb}=0.032$ 元（`docs/dsh-compaction-math.mjs:22, 26`）【已核验】。**口径说明（重要）**：$\kappa_{rb}$ 是**模型内部量**，与服务端实测的"单次重建 ≈ ¥0.036"（`qq-bridge/src/lib/dsh-compaction.js:45`；`qq-bridge/src/core/config.js:51-52`）不是同一个观测量——后者由"同会话上下文回落到前次 $60\%$ 以下的那一次请求的实测成本"定义（`qq-bridge/tools/compaction-threshold.mjs:66-84`），其中还包含该步自身的输出与框架开销。
**定义 3.5（压力型触发）.** 在步边界处，若 $P \ge T = \lfloor \tau W\rfloor$，则进入压缩流程（`dsh/packages/compaction/compaction-basic/src/index.ts:305`，比较式为 `measurement.totalTokens < spec.thresholdTokens → return null`）【已核验】。
**定义 3.6（溢出型触发）.** 当提供方以明确的上下文溢出错误拒绝请求时，触发 `context-overflow` 路径；该路径**绕过阈值与保留尾策略**，$R:=0$（即以保留预算 $0$ 选取可压缩区间），先做一次剪枝、再重测量、再选区间（`index.ts:284-292`，其中 `selectCompactableRange(..., 0)`）【已核验】。其语义是"必须至少释放一些空间"，因此不设收益门槛。
**定义 3.7（两段式释放）.** 压力型触发的实际控制流是

$$
\underbrace{P\ge T}_{\text{①}} \Rightarrow \underbrace{\text{pruneSession}(S)}_{\text{无模型调用}} \Rightarrow P'\ \Rightarrow
\begin{cases}
P'<T: & \text{结束（本次压缩不产生摘要）}\\
P'\ge T: & \text{进入摘要循环}
\end{cases}
$$

（`index.ts:305-313`）【已核验】。摘要循环最多执行 $\text{compactionRetries}+1$ 次；每轮结束后重测量，若已低于阈值则返回，否则继续；用尽轮次仍越界则**抛错**：

$$
\text{error}: \text{"compaction still above threshold after } r+1 \text{ compaction attempts"}
\tag{3.3}
$$

（`index.ts:315-332`）【已核验】。`compactionRetries` 的出厂缺省为 $1$（`compaction-basic/src/config.ts:92`）【已核验】，因此默认最多两次摘要尝试。
**性质 3.1（剪枝优先级的成本解释）.** 剪枝是确定性的、$O(|\text{内容}|)$ 的、**零模型调用**的算子；摘要是一次完整的模型调用（输入为待压缩区间，输出上限 `maxTokens`）。因此在控制流上把剪枝前置是**严格占优**的：它可以在不产生任何 API 成本的前提下消除越界，进而使摘要被完全跳过。这条性质由包文档明确陈述："*修剪不发起模型调用，并可能自行清除 token 压力，因此压缩可能完全跳过摘要*"（`dsh/packages/compaction/compaction-tool-result-pruner/README.zh.md`）【据仓库记载】。
**命题 3.2（每步压缩退化条件）.** 若 $T\le F$，则首个请求即满足 $P\ge T$，从而每个步边界都触发压缩流程。**证明.** 无历史时 $P\approx H(\text{header})=F$（定义 1.3、1.4；系统提示词与工具 schema 无法被压缩消除，见假设 A6），于是 $F=P\ge T$ 恒成立。$\square$
**推论 3.1（下限的工程形式）.** 需要 $T\ge cF$，$c$ 为安全系数；仓库中取 $c=1.5$，即 $\tau W\ \ge\ 1.5\,F_0$、$F_0=27{,}500$ $\Longrightarrow$ $\tau\ \ge\ \frac{41{,}250}{W}$，加之硬编码下限 `MIN_THRESHOLD_RATIO = 0.08`（`qq-bridge/src/lib/dsh-compaction.js:51`，测试断言见 `qq-bridge/tools/test-dsh-compaction.mjs:76-80`）【已核验】。
**推论 3.3（压缩后立即再次越界的条件）.** 压缩后的压力约为 $R+F$；若 $R+F \ge T \iff \rho W+F \ge \tau W$，则压缩后仍即越界，进入退化循环。仓库把该约束写成余量断言：

$$
\tau W-(\rho W+F_0)\ \ge\ 25{,}000\ \text{token}.
\tag{3.4}
$$

（`tools/test-dsh-compaction.mjs:89-93`）【已核验】。代入 $\tau=0.16$、$\rho=0.02$、$W=1{,}048{,}576$、$F_0=27{,}500$ 得 $0.16\times1{,}048{,}576=167{,}772$、$0.02\times1{,}048{,}576+27{,}500=48{,}472$、余量 $=119{,}300\gg25{,}000$。**这是"为什么不能再小"的完整判据**：它给出的是**可行域下界**，与成本最优点无关，两者共同把 $\tau$ 夹在区间内。
**历史失败配置（仓库记载，非本次复现）.** 方法为读取 `qq-bridge/src/lib/dsh-compaction.js` 的注释记录。

| 测量批次 | $\tau_{\text{obs}}$ | 观测现象与量 | 出处 |
| --- | --- | --- | --- |
| 2026-09-19 | $0.005$ | 上下文刚到约 $5$k token 即压缩，等于每轮都压 | `dsh-compaction.js:35` |
| 2026-09-20 上午 | $0.06$ | $F\approx2.75\times10^{4}$，阈值 $62.9$k 被顶穿：$114$ 个模型步触发 $46$ 次摘要，步间多耗 $15\sim20$ 秒 | `dsh-compaction.js:36-37` |
| 2026-09-20 晚 | $0.12$ | 不再每步压缩，但上下文长期停在约 $11.7\times10^{4}$ token，被记为每次请求成本偏高 | `dsh-compaction.js:38-39` |

## 29. 出厂值 0.16 的推导与桌面端扫描

**定理 4.1（最优阈值）.** 在假设 A1–A6 下，式 (3.1) 关于 $T$ 在 $T>R$ 上严格凸，唯一极小点满足

$$
(T-R)^{2}=\frac{2\,g\,\kappa_{rb}}{b},
\qquad\text{即}\qquad
\boxed{\ T^{*}=R+\sqrt{\frac{2\,g\,\kappa_{rb}}{b}}\ }.
\tag{4.1}
$$

**证明.** 记 $D=T-R>0$。重写 (3.1)：

$$
\Phi(T)=n a_0+\frac{n b}{2}\bigl(R+T\bigr)+\frac{n g\,\kappa_{rb}}{T-R}
= n a_0+n b R+\frac{n b D}{2}+\frac{n g\,\kappa_{rb}}{D}.
$$

前三项中只有 $\frac{n b D}{2}$ 依赖 $D$，故

$$
\frac{\mathrm{d}\Phi}{\mathrm{d}D}=n\Bigl(\frac{b}{2}-\frac{g\,\kappa_{rb}}{D^{2}}\Bigr),
\qquad
\frac{\mathrm{d}^{2}\Phi}{\mathrm{d}D^{2}}=\frac{2 n g\,\kappa_{rb}}{D^{3}}>0\ \ (D>0).
$$

令一阶导为零得 $D^{2}=2g\kappa_{rb}/b$，代回 $T=R+D$ 即得 (4.1)。由于 $\Phi$ 在 $D>0$ 上严格凸且在两端发散（$D\to0^{+}$ 时 $\frac{1}{D}$ 项发散；$D\to\infty$ 时线性项发散），该驻点即全局极小点。$\square$ **代入 (3.2)：**

$$
T^{*}=R+\sqrt{\frac{2\,g\,(\mathrm{pMiss}\cdot 10^{-6}R+\mathrm{pOut}\cdot10^{-6}s)}{\mathrm{pHit}\cdot10^{-6}}}
=R+\sqrt{\frac{2\,g\,(\mathrm{pMiss}\,R+\mathrm{pOut}\,s)}{\mathrm{pHit}}}.
\tag{4.2}
$$

（与 `docs/dsh-compaction-math.mjs:55` 的 `closed = R + Math.sqrt(2 * g * rebuildCost / b)` 逐字对应；与 `~/.dsh/profiles/web/cordis.patch.yml:167` 注释中的写法一致。）【已核验】
**性质 4.1（单调性与定性行为）.** 保留段长度：$\partial T^{*}/\partial R>0$——保留得越多，单次重建越贵，阈值必须更高以摊薄重建频次。每步增量：$\partial T^{*}/\partial g>0$——每步增长越快，周期越短、重建越频繁，阈值必须更高。重建与承载单价：$\partial T^{*}/\partial \mathrm{pMiss}>0$、$\partial T^{*}/\partial \mathrm{pHit}<0$——命中折扣越大，压低压缩频次越划算。落点差：$T^{*}-R\propto \sqrt{g\kappa_{rb}/b}$——阈值与落点之差按平方根缩放，参数的整体量级变化只引起阈值的次线性移动。
**桌面端参数取值**（`docs/dsh-compaction-math.mjs:15-26`）：$W=1{,}000{,}000$（`:18`）、$g=5{,}500$（`:19`）、$n=400$ 步/天（`:20`）、$R=20{,}000$（`:21`）、$s=3{,}000$（`:22`）、$b=2\times10^{-8}$ ¥/token/步（`:24`）、$a_0=0.002$ 元（`:25`）、$\kappa_{rb}=0.032$ 元（`:26`）。**闭式解**为

$$
T^{*}=20{,}000+\sqrt{\frac{2\times5{,}500\times0.032}{2\times10^{-8}}}
=20{,}000+\sqrt{1.76\times10^{10}}
=20{,}000+132{,}665
=152{,}665,
$$

即 $\tau^{*}=152{,}665/10^{6}=15.3\%$。测量条件：脚本默认出厂参数；方法：命令 `node docs/dsh-compaction-math.mjs`，本机 Node v24.13.0，扫描步长 $2\%$（`docs/dsh-compaction-math.mjs:50-52`）；$\Phi$ 为式 (3.1) 的日成本（量纲：¥/天）。

| 阈值 $\tau$ | $T$ | 周期步数 $N$ | 重建/天 | 平均上下文 $\bar C$ | 日成本 $\Phi$ |
| --- | --- | --- | --- | --- | --- |
| $8\%$ | $80{,}000$ | $11$ | $36.7$ | $50{,}000$ | ¥$2.3733$ |
| $\mathbf{16\%}$ | $\mathbf{160{,}000}$ | $\mathbf{25}$ | $\mathbf{15.7}$ | $\mathbf{90{,}000}$ | **¥$2.0229$ ★** |
| $32\%$ | $320{,}000$ | $55$ | $7.3$ | $170{,}000$ | ¥$2.3947$ |
| $40\%$ | $400{,}000$ | $69$ | $5.8$ | $210{,}000$ | ¥$2.6653$ |
| $48\%$ | $480{,}000$ | $84$ | $4.8$ | $250{,}000$ | ¥$2.9530$ |
| $80\%$ | $800{,}000$ | $142$ | $2.8$ | $410{,}000$ | ¥$4.1703$ |

**同一脚本打印的数值结论**：闭式解 $15.3\%$、扫描最优 $16.0\%$、稳健区间 $14\%\sim18\%$、缺省 $80\%$ 对比 $16\%$ 每天省 $51\%$（¥$4.1703\to$¥$2.0229$，差 ¥$2.1474$）。**闭式解与扫描解的系统性偏差 $\delta=16.0\%-15.3\%=0.7$ 个百分点**，来源可辨识：扫描把 $T$ 离散化为 $\tau W$ 并只取到 $2\%$ 的格点（`list` 生成式 `for (let r = 0.02; r <= 1.0; r += 0.02)`），另外扫描施加了可行性过滤 $T>R+2g$（`:39`），该过滤在低阈值区截去了若干格点；**这两条都不改变最优点的位置量级**。
**对保留量 $R$ 的敏感性**（脚本第 79-90 行，方法为闭式解 (4.1)）：$R=10{,}000\to12.0\%$；$R=20{,}000\to15.3\%$（标定取值）；$R=50{,}000\to23.5\%$；$R=100{,}000\to34.8\%$；$R=160{,}000\to46.8\%$（桌面端 `retainRatio` 出厂缺省 $0.16$ 对应的落点）。**对每步增量 $g$ 的敏感性**（同段）：$g=1{,}000\to7.7\%$；$g=2{,}000\to10.0\%$；$g=3{,}500\to12.6\%$；$g=5{,}500\to15.3\%$；$g=10{,}000\to19.9\%$。
**性质 4.2（$a_0$ 不进入一阶条件）.** $T^{*}$ 与 $a_0$ 无关（证明中 $n a_0$ 是 $D$ 的常数项）。因此 $a_0$ 的标定误差只平移日成本曲线、不移动最优点；这一点在只有截距存在争议时保护了结论。
**历史样本的标定口径（服务端）.** 服务端路径与桌面端共用同一模型，但参数来源不同：参数不是人为指定值，而是从用量库现场量取（`qq-bridge/tools/compaction-threshold.mjs`）【已核验】。本口径的数据集为 $4{,}659$ 次 / $11.2$ 天，是"出厂值 $0.16$"的**依据样本**；它现已被 $5{,}957$ 次 / $13.8$ 天样本**部分取代**，冲突处以新样本为准。**样本筛选（`:41-42`）**：

$$
\mathcal{S}=\Bigl\{r \in \text{token-usage.jsonl}\ \Bigm|\
\underbrace{\texttt{/^(private|group):/.test}(r.convKey)}_{\text{主聊天}}\ \wedge\
r.est\neq\texttt{true}\ \wedge\ r.cacheRead>0\Bigr\},
$$

并要求 $|\mathcal{S}|\ge200$，否则脚本以退出码 $2$ 中止（`:43-46`）；**旁路会话（摘要器、学习、记忆抽取）必须排除**，理由是它们的请求频率与阈值无关（`:41` 注释）【已核验】。
**量取项一：边际 $b$ 与截距 $a_0$（`:56-64`）.** 对 $\{r: r.cacheRead\ge50{,}000\}$ 做最小二乘：

$$
b=\frac{\sum_{r}(x_r-\bar x)(y_r-\bar y)}{\sum_r (x_r-\bar x)^{2}},\qquad a_0=\bar y-b\bar x,
\quad x_r=r.cacheRead,\ y_r=\text{cost}(r).
$$

该子集的选取理由是"避开刚重建完的冷启动桶"（`:56`）；**这是把两类请求分开量取的核心操作**：若不分桶，冷启动步的大额未命中会与常规步混在同一个回归里，使 $b$ 被高估、进而把结论推向"上下文越贵"的错误方向。
**量取项二：重建成本与周期长度（`:66-90`）.** 按 `convKey || sessionId` 分组，组内按时间排序，判定 $\text{重建发生于第 }i\text{ 步} \iff r_i.cacheRead < 0.6\cdot r_{i-1}.cacheRead .$；记下该步的实测成本（$\kappa_{rb}$ 的样本）、该步的上下文（落点样本 `floors`）、以及自上次重建以来的步数（周样本 `cycleSteps`，要求 $\ge5$），取中位数：

$$
\kappa_{rb}\leftarrow \mathrm{median}(\text{rebuildCosts}),\qquad
N_0\leftarrow\mathrm{median}(\text{cycleSteps}),\qquad
R_{\text{floor}}\leftarrow\mathrm{median}(\text{floors})\ \text{（缺省 }28{,}672\text{）},
$$

并取 $g\leftarrow \max\Bigl(500,\ \frac{\mathrm{median}(r.cacheRead)-R_{\text{floor}}}{N_0}\Bigr)$。**量取项三：扫描与标定（`:104-124`）.** 扫描 $\tau\in[0.04,0.6]$ 步长 $0.02$，用同一泛函 (3.1) 求最小；同时读取 `config.json` 的 `dshCompaction.thresholdRatio` 作为**观察到的工作点** $\tau_{\text{obs}}$，并把模型在该点的值与**实测日成本**比较，偏差为 $\text{偏差}=\frac{\Phi(\tau_{\text{obs}})-\text{measuredPerDay}}{\text{measuredPerDay}}$；脚本注释明确写出这条口径约束：*"拿模型在 0.16 的值去比 0.08 时期测出来的真值，是两个不同配置，比不出误差"*（`:106-107`）。
**历史样本的实测数值**（`qq-bridge/src/core/config.js:41-56`、`qq-bridge/src/lib/dsh-compaction.js:41-47`、`qq-bridge/tools/test-dsh-compaction.mjs:64-71`）【据仓库记载】：样本规模为主聊天 $4{,}659$ 次请求 / $11.2$ 天 $\Rightarrow n\approx416$ 步/天；分桶变量为 `cacheRead`，"每次成本"为该桶内请求的实测均成本（量纲：¥/次）。

| 上下文区间（`cacheRead`） | 占请求比例 | 每次成本 | 其中"大未命中（$\ge20$k）"占比 |
| --- | --- | --- | --- |
| $0\sim30$k | $5.8\%$ | ¥$0.0382$ | $49.8\%$ |
| $30\sim50$k | $36.8\%$ | ¥$0.0105$ | $10.6\%$ |
| $50\sim70$k | $22.2\%$ | ¥$0.0033$ | $0.9\%$ |
| $70\sim90$k | $15.6\%$ | ¥$0.0043$ | — |
| $90\sim120$k | $13.2\%$ | ¥$0.0040$ | — |
| $120\sim160$k | $5.5\%$ | ¥$0.0051$ | — |

历史样本的其余标定量（口径见表内）：边际与截距为 $\text{每次}\approx\text{¥}0.0020+0.022\ \text{¥/M}\times C$（对 $\ge50$k 的最小二乘）；单次重建成本 $\approx$ ¥$0.036$（重建步的实测成本中位数）；重建频率 $\propto 1/\tau$（由重建事件计数得出）；压缩后落点 $R\approx28.7$k token（重建后上下文的中位数）；缓存 TTL 行为为间隔 $<30$ 分钟时 `miss/context` 中位数 $\approx0.005$、间隔 $>2$ 小时时 $0.84$ 且其中 $60\%$ 为完整整段重读（按请求间隔分组的 `miss/context` 中位数）。
历史样本的模型输出与标定：$\tau=0.08$ 时模型日成本 ¥$3.34$、相对最优 $+32\%$；$\tau=0.12$ 时 ¥$2.67$、$+5.5\%$；$\mathbf{\tau=0.16}$ 时 **¥$2.53$**、最优；$\tau=0.18$ 时 ¥$2.53$、最优（平顶）；$\tau=0.25$ 时 ¥$2.66$、$+5.1\%$。**标定偏差**：模型在 $\tau_{\text{obs}}=0.08$ 处算得 ¥$3.34$/天，实测 ¥$3.49$/天，偏差 $-4\%$。**稳健区间**（相对最优劣化 $\le2\%$）为 $0.14\sim0.20$。**结论**：出厂值由 $0.08$ 改为 $0.16$ 后，模型给出的压缩次数由 $28.7$/天降到 $11.2$/天。
**证据等级说明.** 上述"$4{,}659$ 次 / $11.2$ 天""¥$3.34$ 对 ¥$3.49$（$-4\%$）""$28.7$/$11.2$ 次每天"等数字**以代码注释形式存在于仓库**（`config.js:41-57`、`dsh-compaction.js:41-50`、`test-dsh-compaction.mjs:64-72`），属**【据仓库记载】**。本次未在本机重跑 `compaction-threshold.mjs`：本机 `qq-bridge/state/token-usage.jsonl` 只有 $304$ 行、且工作区配置并非产出该数据集的配置（本机 `config.json` 的 `thresholdRatio` 已是 $0.16$），不满足"样本 $\ge200$ 条主聊天行"的脚本前置条件；复现方式为在产出该数据集的部署上执行 `cd /root/qq-bridge && node tools/compaction-threshold.mjs`（脚本第 33 行的自述用法）。**该组数字已被后续生产复算取代**（新样本 $5{,}957$ 次 / $13.8$ 天；$-4\%$ 亦被 $-27\%$ 取代，后者口径更完整）。
**两条标定路径的一致性与强度界限.** 桌面端与 MoonBot 的出厂值同为 $0.16$，但**不能**把它当作两次独立观测：两条路径共用单价（DeepSeek 空闲时段定价）、承载边际假设 $b=\mathrm{pHit}$ 与截距 $a_0$（服务端的 $a_0$ 被桌面端直接沿用，未在桌面端独立回归），仅桌面端的 $g=5{,}500$ 独立——它由聚合量 `(未命中+输出) ÷ 步数` 反推，属**量级估计**而非逐步回归（`docs/DSH-COMPACTION.md` 原 §8 自述）。因此这属于**同一模型在两组参数下的稳健性检查**：参数在 $R\in[10k,160k]$、$g\in[10^3,10^4]$ 的大范围内变动，最优点始终落在 $8\%\sim47\%$ 之间，且与两条路径独立选取的参数点都接近 $0.16$；这支持"$0.16$ 是量级正确的内点最优"，但**不构成**对 $\tau=0.16$ 的精度认证。**该样本之上的后续复算把最优点定位到 $0.14$，同时仍把 $0.16$ 留在稳健区间内**——即"$0.16$ 附近"的结论被更强的样本以"区间下移一档、出厂值不越界"的方式部分修正。

## 30. 生产样本复算记录（2026-09-25）

本章记录在历史样本之后、用生产数据重跑同一脚本得到的复算结果。两次复算共用同一脚本与同一套计价，差异全部来自样本区间与观察到的运行点。本章结论优先于历史样本。

| 项 | 历史样本 | 最新样本 |
| --- | --- | --- |
| 数据来源 | 生产 `state/token-usage.jsonl`（$202.61.72.79$） | 同上（$202.61.72.79$） |
| 文件规模 | 仓库记载 | $1{,}619{,}401$ 字节 / $6{,}952$ 行；最后写入 2026-09-24 17:49 |
| 主聊天请求数 | $4{,}659$ | $5{,}957$ |
| 时间跨度 | $11.2$ 天 | $13.8$ 天 |
| 步数/天 $n$ | $\approx416$ | $430$ |
| 实测日成本 | 仓库记载 ¥$3.49$/天（$\tau=0.08$ 时期） | ¥$3.161$/天 |
| 观察到的运行点 $\tau_{\text{obs}}$ | $0.08$ | $0.08$ |
| 复算日期 | 2026-09-22（记为第四次重算） | **2026-09-25** |

复算命令（逐字）：

```sh
node qq-bridge/tools/compaction-threshold.mjs <stateDir> 1000000
```

即把生产用量库下载到临时目录、以第一个位置参数 `stateDir` 指向它，窗口参数取 $W=10^{6}$（`qq-bridge/tools/compaction-threshold.mjs:19-20`）【已核验】。
**脚本原始输出（2026-09-25 在生产机用量库上的逐字输出，未作修改或重排）：**

```text
样本：主聊天 5957 次请求 / 13.8 天 → 430 步每天，实测 ¥3.161/天
① 边际（3466 次 ≥50k）：每次 = ¥0.00189 + 0.0217 ¥/M × 上下文（缓存价 20000.00 ¥/M）
② 重建：331 次 / 13.8 天 = 23.9 次每天，每次 ¥0.06749
   实测：压缩后落点 28,672 tok · 每周期 16 步 · ⇒ 每步增长 g=1,748 tok

=== 扫描（比例 → 模型每天成本）===
    4%  T=   40,000  周期   6 步  重建 66.4/天  平均上下文    34,336  ¥5.613/天
    8%  T=   80,000  周期  29 步  重建 14.6/天  平均上下文    54,336  ¥2.310/天
   12%  T=  120,000  周期  52 步  重建  8.2/天  平均上下文    74,336  ¥2.064/天
   14%  T=  140,000  周期  64 步  重建  6.8/天  平均上下文    84,336  ¥2.057/天  ★
   16%  T=  160,000  周期  75 步  重建  5.7/天  平均上下文    94,336  ¥2.082/天
   20%  T=  200,000  周期  98 步  重建  4.4/天  平均上下文   114,336  ¥2.178/天
   32%  T=  320,000  周期 167 步  重建  2.6/天  平均上下文   174,336  ¥2.617/天
   36%  T=  360,000  周期 190 步  重建  2.3/天  平均上下文   194,336  ¥2.783/天
   40%  T=  400,000  周期 212 步  重建  2.0/天  平均上下文   214,336  ¥2.954/天
   44%  T=  440,000  周期 235 步  重建  1.8/天  平均上下文   234,336  ¥3.128/天
   48%  T=  480,000  周期 258 步  重建  1.7/天  平均上下文   254,336  ¥3.304/天
   52%  T=  520,000  周期 281 步  重建  1.5/天  平均上下文   274,336  ¥3.482/天
   56%  T=  560,000  周期 304 步  重建  1.4/天  平均上下文   294,336  ¥3.661/天
   60%  T=  600,000  周期 327 步  重建  1.3/天  平均上下文   314,336  ¥3.841/天

★ 最省：14.0%（T=140,000 tok）→ ¥2.057/天
  稳健区间（差 ≤2%）：12% ~ 16%
  标定：这份用量数据是在阈值 8% 下跑出来的 → 模型在同一点 ¥2.310/天 · 实测 ¥3.161/天（偏差 -27%；越接近 0 越可信）
```

**引用条件与口径说明.** 输出中"缓存价 20000.00 ¥/M"是脚本把配置的每 token 缓存价换算成"每百万 token"后的归一化值，对应 `qq-bridge/tools/compaction-threshold.mjs:22-27` 中的 `PRICE.pHit = 0.02`【已核验】；**该字段的数值不可按字面理解为 $20{,}000$ ¥/M**。与该字段同属一处的斜率印为 $0.0217$ ¥/M，二者相差 $8.5\%$；说明"归一化缓存价"与"回归斜率"是两个独立的量，前者来自配置、后者来自数据，不把二者互相当作对方的验证。
**与该样本对应的参数（与历史样本旧值冲突处一律以最新样本实测为准）：**

| 量 | 历史样本值 | 最新样本值 | 相对变化 |
| --- | --- | --- | --- |
| 边际截距 $a_0$ | ¥$0.0020$ | **¥$0.00189$** | $-5.5\%$ |
| 边际斜率（$b$ 的实测值） | $0.022$ ¥/M | **$0.0217$ ¥/M** | $-1.4\%$ |
| 单次重建成本 | ¥$0.036$ | **¥$0.06749$** | $+87\%$ |
| 重建频率 | $28.7$ 次/天（在 $\tau=0.08$） | **$23.9$ 次/天**（$331$ 次 / $13.8$ 天） | $-17\%$ |
| 压缩后落点 $R$ | $\approx28.7$k tok | **$28{,}672$ tok**（不变） | $0$ |
| 周期步数 $N_0$ | 仓库未逐字给出 | **$16$ 步** | — |
| 每步增长 $g$ | $\approx990\sim3{,}550$（两估计器区间） | **$1{,}748$ tok/步** | 落在旧区间内 |
| 主聊天样本量 | $4{,}659$ 次 / $11.2$ 天 | **$5{,}957$ 次 / $13.8$ 天** | $+28\%$ / $+23\%$ |
| 步数/天 $n$ | $\approx416$ | **$430$** | $+3.4\%$ |

与旧值冲突的**唯一来源是样本区间不同**，具体有两处结构性差异。**重建单价**上升 $87\%$（¥$0.036\to$ ¥$0.06749$）：重建成本的口径是"重建那一次请求的实测成本"（`qq-bridge/tools/compaction-threshold.mjs:78` 的 `costOf(list[i])`），它随重建发生时该次请求的规模变化，最新样本的样本量更大、覆盖更长的时间跨度，包含更多"上下文回落幅度大 / 单次请求更重"的重建事件，因此样本均值上移；该量是重尾分布的均值（`rebuild = mean(rebuildCosts)`，`:84`），不是稳定常量。**$g$ 的估计器**版本不同：$g=\max\bigl(500,(\mathrm{median}(cacheRead)-R_{\text{floor}})/N_0\bigr)$（`:88`），本次印出 $N_0=16$、$R_{\text{floor}}=28{,}672$、$g=1{,}748$，反解出 $\mathrm{median}(cacheRead)\approx28{,}672+16\times1{,}748=56{,}640$；旧值 $990\sim3{,}550$ 出自两个不同估计器（逐周期 $(\bar C-R)/N$ 与整体 `median/N`），本次只给出一个（周期中位数口径）。
**输出与当前检出脚本的一致性核验（2026-09-25 闭环）.** 逐列核对上述输出与仓库中该脚本的模型定义（`qq-bridge/tools/compaction-threshold.mjs:93-104`），可以确认该输出正是当前检出修订产出，三项回代如下：① $\bar C=(R_{\text{floor}}+T)/2$（`:97`）：$4\%$ 行 $(28{,}672+40{,}000)/2=34{,}336$ 相符、$14\%$ 行 $(28{,}672+140{,}000)/2=84{,}336$ 相符、$60\%$ 行 $(28{,}672+600{,}000)/2=314{,}336$ 相符（三行皆与印值逐位相符）；② $N=(T-R_{\text{floor}})/g$（`:96`）：$T=140{,}000\to63.7$ 印 $64$ 相符、$T=200{,}000\to98.0$ 印 $98$ 相符、$T=600{,}000\to326.8$ 印 $327$ 相符（四舍五入后全对）；③ 重建频率 $=430/N$（`:99-100`）：$430/64=6.7$ 印 $6.8$ 相符、$430/75=5.7$ 印 $5.7$ 相符、$430/98=4.4$ 印 $4.4$ 相符；可行性守卫 $T\le R+2g\Rightarrow$ `null`（`:95`）下 $R+2g=32{,}168$，故 $4\%$（$T=40{,}000$）**保留**、$2\%$（$T=20{,}000$）会被滤掉——印出的最小比例恰为 $4\%$。**因此曾被记为"对不上的三处"的怀疑全部撤回**：那三处均为核验时把 $\bar C$ 当成 $T/2+R$、把 $N$ 当成 $(\bar C-R)/g$ 造成的公式误用，不是版本差异；该输出可用于全部中间量的引用与复算。该口径差异顺带解释了 $N_0=16$ 与 $T=140{,}000$ 之间表面上的一致性缺口：$T=140{,}000$、$R=28{,}672$ 时 $(T-R)/g=111{,}328/1{,}748=63.7$ 步，与扫描表列出的 $64$ 步一致；两次复算的扫描表都由其各自的 $(g,R)$ 决定，**不可混用**。
**$-27\%$ 偏差的口径解释（结案）.** **事实**：模型在其工作点（$\tau=0.08$）给出 ¥$2.310$/天，同一份数据的实测日成本为 ¥$3.161$/天，偏差 $-27\%$，即模型**系统性低估**；这与稳健区间判据（推论 6.2）无关，区间判据只用相对比较，故低估不改变 $\arg\min$ 的位置，只改变纵轴刻度。成因按量纲与口径逐项分解为四类。

| 编号 | 成因 | 机制 | 依据 |
| --- | --- | --- | --- |
| ① | 模型只有两项，实测有三项以上 | 式 (3.1) 的模型日成本为 $\text{承载}+\text{摊薄重建}$；而实测日成本 $=$ 所有请求的 `costOf` 之和 $/\,\text{spanDays}$，其中每一项已含输出、工具调用往返、重试、冷启动未命中 | `qq-bridge/tools/compaction-threshold.mjs:52` |
| ② | 平均上下文的线性近似低估了非线性的未命中项 | 模型的承载项用 $\bar C=(R+T)/2$ 乘以缓存价 $b$；但实测中单次请求的成本对上下文不是线性的：上下文越接近该次请求的重读规模，未命中的份额越重。用线性回归的截距 $a_0$ 吸收这一项，等于把重尾部分压成常数，因而系统性偏低。分桶表本身即证据：$0\sim30$k 桶的每次成本 ¥$0.0382$ 是 $50\sim70$k 桶 ¥$0.0033$ 的 $11.6$ 倍，而两桶的 $\bar C$ 之比不足 $2$ | 本样本的历史样本分桶表 |
| ③ | 重建成本的摊薄口径不同 | 模型的摊薄项为 $\dfrac{ng}{T-R}\kappa_{rb}$（用模型自身的 $g$ 算周期长度），实测的重建频率直接由"同会话上下文回落 $<60\%$"计数。二者在 $g$ 估计偏大时会把重建次数算少：本次 $g=1{,}748$ 对模型自洽（周期 $16$ 步），但若真实周期短于 $16$ 步，则摊薄项被低估 | `compaction-threshold.mjs:76` |
| ④ | 观察窗口内的运行点漂移 | 该份数据是在 $\tau=0.08$ 下跑出来的，而扫描把同一个 $g$ 用于所有阈值。若观察期内 $\tau$ 或提示词/工具表发生过变化，则 $g$ 不是常数，用单点 $g$ 外推到整个区间会带来单向偏差 | — |

①的差额表达式为

$$
\underbrace{\text{实测}-\text{模型}}_{\text{被省略的项}}=\text{输出}+\text{重试}+\text{未命中尾部}
+(\text{冷启动份额}).
$$

**结论（正式口径表述）.** 该模型的输出应被读作**同一配置空间内的相对优劣序**（即 $\arg\min_\tau\Phi$ 及其邻域），而**不是绝对日成本的预测量**，因此

$$
\Phi_{\text{模型}}(\tau)\ \approx\ 0.73\times\text{cost}_{\text{实测}}(\tau)\quad(\text{本样本，}\ \tau=0.08),
$$

即存在一个**乘性口径系数**约 $0.73$（$=2.310/3.161$）。在需要绝对金额的场合（预算、对外报价），应使用实测值；在选择参数（阈值、保留比、剪枝预算）的场合，使用 $\Phi$ 的相对比较。**该系数 $0.73$ 的跨样本稳定性【未核验】**（历史样本的对应偏差口径不同：仓库记载 $-4\%$，但那是在 $0.08$ 工作点上比较、且样本与本次不同），故不得把 $0.73$ 当作可移植常量。
**旧文档中"¥$0.43$/天 差额未解释"一项的结案.** 早期版本在"已知未覆盖部分"中记有一条约 ¥$0.43$/天的绝对金额差额，并注明"模型与实测没有完全对上，结论用相对比较，不受影响"。**该条现已结案**，三条理由为：① 该差额与本次测到的 $-27\%$ **同源**，都是"模型的稳态两成分近似 vs 实测的三成分以上总和"的差，不是计算错误，也不是数据错误；② 该差额的**量级可预测**——以本次为例，实测 ¥$3.161$ 与模型 ¥$2.310$ 的差为 ¥$0.851$/天，其中包含输出与重试两块，而重试一块**在 DSH 侧没有 usage**，因此这部分差额**在现有计量手段下不可能被完全消除**（`qq-bridge/src/core/context-savings.js:111-114` 记载：控制台 $48{,}063{,}224$ 对面板 $47{,}919{,}388$，差 $143{,}836$，同日恰好 $2$ 条 `llm/retry`）；③ 后续一律采用**相对成本口径**（$\Phi(\tau)/\Phi(\tau^{*})$）陈述结论，并在需要绝对金额时改用实测值，不再把该差额列为"未定位的异常"。
**与历史样本的结论对照.**

| 结论 | 历史样本 | 最新样本 | 是否改变 |
| --- | --- | --- | --- |
| 最优阈值 | $0.16$（与 $0.18$ 并列） | **$0.14$** | 数值移动一档，量级不变 |
| 稳健区间（劣化 $\le2\%$） | $0.14\sim0.20$ | **$0.12\sim0.16$** | 移动一档，与上一行自洽 |
| $0.16$ 的地位 | 最优点 | 区间内、上端，劣化 $1.2\%$ | **不改变出厂值的可用性** |
| $0.08$ 的相对劣化 | $+32\%$（相对于 $0.16$） | $+12.3\%$（$2.310$ 对 $2.057$） | 方向不变，幅度收窄 |
| 阈值随 $g$ 单调上移 | 是 | 是（$g$ 更小 $\Rightarrow$ 最优点更低） | 不变（与性质 4.1 一致） |
| 模型对绝对金额 | 仓库记载偏差 $-4\%$ | **$-27\%$** | **改变**：绝对口径不可用 |

**稳健区间的下界不在扫描矩阵内（引用时必须标注）.** 扫描表从 $\tau=4\%$ 起印，但 $[0.12,0.16]$ 这一区间的下界是靠 $12\%$ 行的 ¥$2.064$（$2.057\times1.02=2.098$，故仍在 $\le2\%$ 带内）与 $8\%$ 行的 ¥$2.310$（带外）夹出来的，**不是**由 $10\%$ 行直接读出；由于 $12\%$ 恰好落在带内、$8\%$ 明确在带外，下界只能定位到区间 $(0.08,0.12]$，$0.12$ 是**上确界意义上的下界**（即在扫描格点上"最靠近带内的第一个格点"）。
**一致性检验.** 最新样本的 $g=1{,}748$ 小于历史样本的 $g\approx3{,}550$（按上端估计器），由性质 4.1（$\partial T^{*}/\partial g>0$）预言最优点应**下移**，实测正好从 $0.16$ 下移到 $0.14$。这构成一次**模型定性预测被数据证实**的检验，也是本章唯一不依赖绝对口径的验证。
**定量核对（同一价格结构下）.** 用闭式解 (4.1) 验算最新样本的参数点（取输出那一组 $g=1{,}748$、$\kappa_{rb}=0.06749$、$R=28{,}672$）：$(T^{*}-R)=\sqrt{2\times1{,}748\times0.06749/(2\times10^{-8})}=108{,}628$，故 $T^{*}=28{,}672+108{,}628=137{,}300$，即 $\tau^{*}=13.7\%$；扫描给出 $14.0\%$（$T=140{,}000$），两者相差 $0.3$ 个百分点。**闭式解与扫描的最优都落在 $13.7\%\sim14.0\%$，均位于扫描的 $[0.12,0.16]$ 稳健区间内**，即"出厂值 $0.16$ 位于区间上端、相对最优点劣化约 $1.2\%$"这一结论不依赖任何单点取值；偏差来源与前节同（扫描的 $2\%$ 格点离散化与可行性过滤）。

## 31. 增益模型、保真度与阈值的最优性

**定义 6.1（剪枝收益）.** 对第 $i$ 次剪枝事件，被遮蔽 token 量（量纲：token）为 $\Delta_i=\texttt{shadowedTokenCount}_i=\theta(\text{原工具结果})-\theta(\text{剪枝后内容})$，对应 `compaction/prune` 事件的同名字段（`dsh/packages/compaction/compaction/src/types.ts:87-88`；产生点在 `compaction-tool-result-pruner/src/index.ts:162-166`）【已核验】。
**定义 6.2（重读节省）.** 由于该内容此后不再出现在每次请求里，其后同会话发生的每次请求各少读 $\Delta_i$；以步为单位记 $\Gamma_i=\Delta_i\cdot\#\{\text{该剪枝之后的同会话请求数}\}$。这正是桥侧面板的口径（`qq-bridge/src/core/context-savings.js:14-15` 与其 `note` 字段第 319-322 行）【已核验】，即 $\texttt{prunedTokens}=\sum_i \Delta_i$ 与 $\texttt{rereadSaved}=\sum_i \Gamma_i$。**实现细节（影响该量的可复现性）**：`summarizeSessionLog()` 遍历 `step/start` 事件（= 一次模型请求），对每个 $\text{seq}>\text{seq}(\text{prune})$ 的步计入一次 $\Gamma$（`context-savings.js:124-137`）【已核验】；结果**从日志重算而非累加**，因此幂等、可回填（同文件第 20 行）【已核验】。
**定义 6.3（摘要收益）.** 摘要路径单独统计：`summarizedTokens`$=\sum \texttt{shadowedTokenCount}$ 与 `summaryEvents`（`context-savings.js:138-144`）【已核验】。该口径**不扣除摘要自身的成本**，即它度量的是"被移除的上下文规模"，不是净节省；净节省需按 (3.2) 减去 $\kappa_{rb}$——该扣减在面板口径中**未实现**（**【未核验】**：希望看到"净收益"的读者必须自行做这一步减法）。
**定义 6.4（剩余信息率与损耗率）.** 设原区间内容为 $X$（token 量 $|X|=\theta(X)$），其替代物为 $X'$，则 $\eta=\frac{|X'|}{|X|}$（剩余信息率）、$\ell=1-\eta$（损耗率）。两条压缩路径的保真度口径为：剪枝的替代物规模 $\lvert X'\rvert=\alpha+|\mu|+\omega$（码点）、原规模 $\lvert X\rvert=L$，故 $\eta_{\text{prune}}=\frac{\alpha+|\mu|+\omega}{L}$（码点口径，与 token 口径不成严格比例）；摘要的替代物规模为检查点节点价格、原规模为被遮蔽区间价格（恰为 `shadowedTokenCount`），故 $\eta_{\text{sum}}$ 可直接由日志算出。
**命题 6.1（剪枝的语义损耗是位置性的）.** 剪枝删除的是区间的**中段** $[\alpha,L-\omega)$，保留**首尾**：头部 $\alpha$ 码点内（工具名、参数回显、状态头）与尾部 $\omega$ 码点内（结论、错误串、退出码）逐字保留；中段 $[\alpha,L-\omega)$（数组体、日志体、base64 体）整体丢失，由固定标记 $\mu$ 替代。这正是配置注释所述的取舍："*整段唤醒协议 / 状态快照都能完整留下，真正超大的（图片 base64、超长历史）照旧被剪*"（`qq-bridge/src/core/config.js:63-65`）【据仓库记载】。
**引理 6.2（边界码点损耗的期望上界）.** 由性质 2.4，字素簇可能被劈开；若字素簇长度有界 $G$，则两个切点各造成至多 $G-1$ 个码点的形变，故 $\mathbb{E}\,[\text{边界形变码点}]\le 2(G-1)$。对 CJK 与拉丁文本 $G=1$（无形变）；对含 ZWJ 序列的 emoji 文本 $G$ 可达 $2\sim7$。这是一个**有界但非零**的保真度损失，且只在切点附近发生。**【未核验】**：仓库中没有对该量的实测统计。
**定义 6.5（重读保真度）.** 定义"压缩后模型能直接看到的信息占压缩前能被看到的信息的比例" $\phi=\frac{|\text{保留段}|+|\text{摘要}|+|\text{可检索归档}|}{|\text{压缩前上下文}|}$；在 MoonBot 架构中 $\phi$ 有一个非平凡的结构性提升：**被压缩掉的内容并未消失，而是进入可检索的持久层**。因此对"是否还能被取知"这一语义问题，有效保真度高于 $\eta$；对"是否出现在前缀里（即是否计入承载成本）"这一成本问题，保真度就是 $\eta$。**这两种保真度必须分开使用**：混用会导致两类相反的错误——一类是把上下文压得过小、使模型检索不到所需信息；另一类是为了保留而不敢压缩。
**定理 6.1（内点最优的充分条件）.** 若 $\kappa_{rb}>0$、$g>0$、$b>0$ 且可行域为 $T\in(R, W]$ 且 $W-R>\sqrt{2g\kappa_{rb}/b}$，则 (4.1) 给出的 $T^{*}$ 落在可行域内部，且是唯一极小点；若 $W-R\le\sqrt{2g\kappa_{rb}/b}$，则最优点退化为**边界点** $T=W$，即"不压缩"。**证明.** 关于 $T$ 的凸性与唯一驻点由定理 4.1 给出；可行域为闭区间，凸函数在闭区间上的极小点或为内点驻点或为端点。由单调性 $\Phi'(D)<0$ 当 $D<\sqrt{2g\kappa_{rb}/b}$、$\Phi'(D)>0$ 当 $D>\sqrt{2g\kappa_{rb}/b}$，故若 $\sqrt{2g\kappa_{rb}/b}<W-R$ 则驻点在内，否则 $\Phi$ 在 $(R,W]$ 上递减，最小值在 $T=W$。$\square$
**推论 6.1（"不压缩"作为合理配置的判据）.** 桌面端缺省 $\tau=0.8$（$T=800{,}000$、$D=780{,}000$）远大于 $\sqrt{2g\kappa_{rb}/b}=132{,}665$，故它落在 $\Phi$ 的**递增段**，被模型判为劣（¥$4.1703$/天 对 ¥$2.0229$/天）；反之，若某部署的 $g$ 极小（如纯问答、几乎无工具调用）或 $\kappa_{rb}$ 极大（如窗口很小、保留量很大），则 $T=W$ 可能确实是模型给出的最优解。
**推论 6.2（稳健区间的解析形式）.** 稳健区间 $[\tau_1,\tau_2]$ 由相对劣化阈值 $\varepsilon$ 隐式定义：$\frac{\Phi(T)}{\Phi(T^{*})}\le 1+\varepsilon$。代入 $D=T-R$、$D^{*}=\sqrt{2g\kappa_{rb}/b}$、$m=g\kappa_{rb}$，有

$$
\Phi(T)-\Phi(T^{*})=\frac{nD^{*}}{2}\Bigl(\frac{D^{*}}{D}+\frac{D}{D^{*}}-2\Bigr)
=\frac{nD^{*}}{2}\cdot\frac{(D-D^{*})^{2}}{D\,D^{*}}
=\frac{n\,(D-D^{*})^{2}}{2D}.
$$

故

$$
\frac{(D-D^{*})^{2}}{D}\ \le\ \frac{2\varepsilon\,\Phi(T^{*})}{n}.
\tag{6.1}
$$

式 (6.1) 说明**稳健区间关于 $D^{*}$ 近似对称、宽度按 $\sqrt{\varepsilon}$ 缩放**：$\varepsilon=0.02$ 时约 $\pm O(\sqrt{0.02}D^{*})\approx\pm0.14 D^{*}$ 量级，与脚本扫描出的 $14\%\sim18\%$（围绕 $16\%$ 约 $\pm12\%$）量级吻合。**这条对应关系为本文推断**【未核验】：仓库脚本用直接比较（`c.perDay <= best.perDay * 1.02`，`docs/dsh-compaction-math.mjs:52`）确定区间，并未使用解析式 (6.1)。
**定义 6.6（收益门槛的另一条路径：边际收益 = 边际成本）.** 把压缩视为"用一次重建成本换取后续若干步的上下文降低"。设压缩前的稳态上下文为 $C$，压缩把它降到 $R$，则

$$
\underbrace{\kappa_{rb}}_{\text{一次性支出}}\ \ \text{vs}\ \ \underbrace{\frac{b\,(C-R)}{g}\cdot\frac{C-R}{2}}_{\text{后续 $(C-R)/g$ 步的累计节省}}.
$$

令二者相等得 $\kappa_{rb}=\frac{b\,(C-R)^{2}}{2g}$ $\iff$ $(C-R)^{2}=\frac{2g\kappa_{rb}}{b}$，**与定理 4.1 的 (4.1) 完全一致**。这说明"周期成本最小化"与"边际收益等于边际成本"在该模型下等价，$T^{*}$ 的两种解释互相印证。

## 32. 多级压缩与递归摘要的累积误差

**误差来源的分类.** 一次压缩的信息损失可分解为四个可分别建模的分量：

| 符号 | 名称 | 机制 | 是否有界 |
| --- | --- | --- | --- |
| $\epsilon_{\text{enc}}$ | 编码损耗 | 摘要是有损编码，$\lvert X'\rvert<\lvert X\rvert$ | 有界，$\le \lvert X\rvert$ |
| $\epsilon_{\text{model}}$ | 模型损耗 | 摘要模型自身遗漏、幻觉、概括失当 | **无界**（可能新增错误信息） |
| $\epsilon_{\text{cut}}$ | 切点损耗 | 字素簇劈裂（引理 6.2） | 有界，$\le 2(G-1)$ 码点 |
| $\epsilon_{\text{stale}}$ | 陈旧损耗 | 摘要保留了后期已失效的事实 | 有界，由后续压缩清除 |

**定义 7.1（事实集合与摘要算子）.** 设会话在第 $k$ 代时蕴含的事实集合为 $F_k$；压缩算子 $\Pi$ 作用于 $(\sigma_{k-1}, C_k)$ 产出 $\sigma_k$，其**承载的事实集合**为 $\hat F_k = \Pi_F\bigl(\hat F_{k-1}\cup F(C_k)\bigr)\cup E_k$，其中 $E_k$ 为本轮新引入的错误事实集合（$\epsilon_{\text{model}}$ 的具体化），$\Pi_F$ 为"选取仍为真的事实"这一不可靠算子。
**定理 7.1（误差的加性累积）.** 在假设"$\Pi_F$ 不会凭空恢复此前已丢失的事实"（即 $\hat F_k$ 中此前丢失的事实不复现，除 $E_k$ 外）下，

$$
\bigl|F_k\setminus \hat F_k\bigr|\ \le\ \sum_{j=1}^{k}\bigl|L_j\bigr|+\sum_{j=1}^{k}\bigl|E_j\bigr|,
\tag{7.1}
$$

$L_j=F_j\setminus F_{j-1}$ 为第 $j$ 代新增事实。**即丢失量关于压缩代数 $k$ 至多线性增长，不衰减。**
**证明.** 归纳。$k=1$ 时 $\hat F_1=\Pi_F(F_1)\cup E_1$，故 $|F_1\setminus\hat F_1|\le |F_1\setminus \Pi_F(F_1)|$，界成立。设 $k$ 成立，则

$$
F_{k+1}\setminus \hat F_{k+1}
\subseteq \bigl(F_k\setminus \hat F_k\bigr)\cup L_{k+1}\cup E_{k+1},
$$

其中第一项继承（因为被丢弃的事实不会因 $\Pi_F$ 而回来），其余两项为本代新增。取基数即得 (7.1)。$\square$
**推论 7.1（扁化取代嵌套的必要性）.** 模板规则（性质 2.2）要求模型**把先前的检查点合并进来而不是原样前传**；若改为嵌套（$\sigma_{k+1}$ 包含 $\sigma_k$ 的全文），则由 (7.1) 的机制，$\epsilon_{\text{stale}}$ 不会被清除，且 $|\sigma_k|$ 单调不减，最终使 $|\sigma|>\tau W$ —— 递归发散。模板规则是对这一发散的**工程性阻断**。
**推论 7.2（摘要有界性给出稳定性条件）.** 第 $k$ 代摘要的体量满足 $|\sigma_k|\le s_{\max}$，$s_{\max}$ 由摘要调用的输出上限决定：DSH 出厂 `maxTokens = 8192`（`compaction-basic/src/config.ts:91`），桥侧写死为 $4096$，该处的注释理由是摘要本身不应占用过多输出 token（`qq-bridge/src/lib/dsh-compaction.js:30-31`）【已核验】。因此稳定性条件是

$$
\boxed{\ s_{\max}\le \tau W - F\ },
\tag{7.2}
$$

否则检查点本身就会把压力维持在阈值以上，循环无法收敛——这正是"压缩后立即再次越界"条件在摘要体量上的重述。
**注（稳定性条件的第二重含义）.** (7.2) 在桥侧配置下余量极大（$4096$ 对约 $1.4\times10^5$），但这并不意味着稳定：**真正的收敛判据是 (3.3) 的摘要循环终止条件**，即每轮摘要必须把压力降到 $\tau W$ 以下。当单次可压缩区间的规模不足（例如保留量 $R$ 过大、或历史本身的"新内容"增长速度超过压掉的量）时，重试穷尽后抛错；此时系统**不做静默降级**，而是显式失败——这是一个可观测、可告警的行为。
**若误差为随机量：从线性到平方根.** 定理 7.1 假设丢失是**系统性**的（每代都有不可逆丢失）；若模型损耗 $E_j$ 是零均值独立随机量，则事实数量的净偏差为随机游走：

$$
\left|\sum_{j=1}^{k} E_j\right|\ \sim\ \sigma\sqrt{k}\quad(\text{标准差口径}),
$$

即**误差按代数平方根增长**，比最坏情形 (7.1) 的线性增长温和。但 $\epsilon_{\text{enc}}$（编码损耗）在真实摘要器下**不是零均值**的——摘要倾向于系统性丢弃细节、保留结论，故不应期待平方根行为。**这是本文的推断，【未核验】**：没有任何脚本或测试度量过摘要保真度随代数 $k$ 的衰减曲线。
**命题 7.2（一个会话的期望压缩次数）.** 设会话总步数 $N_{\text{sess}}$，则期望压缩次数

$$
\mathbb{E}[k]=\frac{N_{\text{sess}}\,g}{T-R}=\frac{N_{\text{sess}}\,g}{\sqrt{2g\kappa_{rb}/b}}\Big|_{\tau=\tau^{*}}=\frac{N_{\text{sess}}\sqrt{g\,b}}{\sqrt{2\kappa_{rb}}}.
$$

**证明.** 周期步数 $N=D/g$，故 $k\approx N_{\text{sess}}/N=N_{\text{sess}}g/D$；在 $\tau^{*}$ 处 $D=D^{*}=\sqrt{2g\kappa_{rb}/b}$，代入即得。$\square$ 取 $N_{\text{sess}}=5{,}000$、$g=5{,}500$、$b=2\times10^{-8}$、$\kappa_{rb}=0.032$：

$$
\mathbb{E}[k]=\frac{5{,}000\times\sqrt{5{,}500\times2\times10^{-8}}}{\sqrt{2\times0.032}}
=\frac{5{,}000\times\sqrt{1.1\times10^{-4}}}{0.253}
=\frac{5{,}000\times0.01049}{0.253}\approx207.
$$

该量级说明**在 $R=20{,}000$ 的配置下，长会话经历的压缩代数可达数百次**，因此加性累积不是理论忧虑而是工程现实。**这一数值是模型计算，不是实测**【未核验】；它与"压缩 $11.2$ 次/天"给出的 $\sim416$ 步/天相符（$416\times0.01049/0.253\approx17$ 次/天，与记载的 $11.2$ 次/天同量级，偏差来自记载数据自身的 $R\approx28.7$k 与 $g$ 取上端）。
**缓解递归损耗的机制清单（均可在代码中找到）.**

| 机制 | 作用 | 出处 |
| --- | --- | --- |
| 结构化 8 段模板 + 强制保留精确标识符 | 降低 $\epsilon_{\text{enc}}$ | `compaction-basic/src/summarizer.ts:31-66` |
| "不要前传旧检查点，合并为单一摘要" | 阻断 $\epsilon_{\text{stale}}$ 与体量发散 | 同文件第 65 行 |
| 摘要输出上限 `maxTokens` | 保证稳定性条件 (7.2) | `compaction-basic/src/config.ts:91`；`qq-bridge/src/lib/dsh-compaction.js:30-31` |
| 保留段 $R$ 逐字不动 | 近期信息零损耗 | `region.ts:100-136` |
| 剪枝优先于摘要 | 把大部分压力用无损（就语义而言"位置性"）手段解决 | `compaction-basic/src/index.ts:305-313` |
| 归档 + 全文检索独立于上下文 | 丢失的内容仍可被按需取回 | 见记忆窗口与归档部分 |

## 33. 记忆窗口与聊天记录的分离

"内存里的聊天窗口"与"被压缩的会话历史"不是同一个对象，二者的淘汰策略、容量与代价结构都不同。
**定义 8.1（内存窗口）.** 每个会话在桥侧维护一个内存消息数组 `st.recentMessages`，按到达顺序追加，超出容量时从**头部**批量删除：

$$
W_{\text{mem}} : \text{append 到尾部};\qquad
\text{若}\ |W_{\text{mem}}| > \Lambda \Rightarrow W_{\text{mem}} \leftarrow W_{\text{mem}}[\,|W_{\text{mem}}|-\Lambda\,:\ ],
\tag{8.1}
$$

即 **FIFO 淘汰，无 LRU、无权重、无频率计数**（`qq-bridge/src/core/social-flow.js:22, 90, 139, 286, 389`；`wake-send.js:1331-1332`）【已核验】。
**定义 8.2（窗口容量）.** $\Lambda=\max\Bigl(10,\ \texttt{cfg.social.context.recentLimit}\Bigr)$，缺省 `recentLimit` $=100$，口径见 `qq-bridge/src/core/social-flow.js:22` 与 `wake-send.js:1331`【已核验】；出厂配置见 `qq-bridge/config.json` 的 `social.context.recentLimit = 100`。**内存窗口有两个语义不同的上界，不可混淆**：运行期内存窗 $\Lambda=100$（可配，`social-flow.js:22` 等）为每会话活跃窗口；落盘/读取窗为 $200$（`social-state.js:348` 的 `st.recentMessages.slice(-200)`），即状态文件里保留的上限。因此**运行期窗口可以比落盘上限更严**（缺省 $100<200$），落盘多出的部分是为"窗口被裁掉后仍能读取刚见过的转发 id"预留的余量（`social-state.js:338` 的注释即说明该用途）【据仓库记载】。
**性质 8.1（内存窗口与 token 窗口无关）.** $\Lambda$ 的计数单位是**消息条数**，与 token 无关，因此窗口占用的 token 量 $C_{\text{win}}=\sum_{m\in W_{\text{mem}}}\theta(m)$ 是**随机的**：$100$ 条短消息可能只有几 k token，$100$ 条长消息或含图消息可能远超 $\Lambda$ 条所暗示的规模。**这是窗口裁剪与记录压缩的第一个结构性差别**：前者控制条数，后者控制 token。窗口之外的按需读取路径（旁路持久层）为：`recentChatMessages(convKey, limit=25)` 上限 $\le200$、`fetchUnreadChatMessages(convKey, limit=30)` 上限 $\le100$、`recentMessagesAcrossSessions` 上限 $\le10$ 且时间窗 $\le7$ 天、跨会话/关键词检索结果上限 $200$（默认 $50$）（均见 `qq-bridge/src/core/chat-db.js:749-755, 713-717, 789-794, 892`）；模型侧工具 `qq_get_recent_messages` 上限 $100$（`qq-bridge/dsh/agent-presets/qq-chat/agent.cordis.yml` 的 `[TOOLS]` 段）。
**定义 8.3（记忆层级）.** 记忆条目 $m$ 携带层级 $\text{tier}(m)\in\{\texttt{permanent},\texttt{durable},\texttt{working}\}$ 与过期时刻 $\text{exp}(m)$：

$$
\text{TTL}(\texttt{permanent})=0\ (\text{永不过期}),\quad
\text{TTL}(\texttt{durable})=90\ \text{天},\quad
\text{TTL}(\texttt{working})=7\ \text{天},
$$

（`qq-bridge/src/core/memory.js:86-87` 的 `MEMORY_TIERS`）【已核验】。另有按类别自动归入永久层的集合 $\mathcal{P}=\{\texttt{rule},\ \texttt{owner},\ \texttt{identity}\}$（同文件第 88-89 行 `PERMANENT_CATEGORIES`）【已核验】。
**定义 8.4（淘汰算子）.** 清扫过程为 $\text{delete}\ m \iff \text{pinned}(m)=0\ \wedge\ \text{tier}(m)\neq\texttt{permanent}\ \wedge\ 0<\text{exp}(m)\le \text{now}$（同文件第 667-672 行 `pruneExpiredMemory`）【已核验】。**永久层与置顶项被结构性地排除在淘汰集合之外**，所以"每轮都注入"这件事对永久层是有保证的，不依赖重要性排序。
**注入侧的上限（区别于存储侧）.** 记忆摘要的注入量有独立的三重截断（`memory.js:690-720` 的 `memoryDigest`）【已核验】：$\text{\#entries}\le\min(30,\ \max(1,\texttt{opts.limit}\ \text{或}\ 12))$ 且 $\text{每条字符数}\le\texttt{maxChars}$。旁路状态的容量（同为 FIFO，但各自有上限）：`activeTopics` 上限 $20$（`memory.js:462`）、`pendingThoughts` 上限 $20$（`memory.js:478`）、`memberImpressions` 上限 $50$ 且按 `lastSeenAt` 淘汰最旧（`memory.js:492-497`）、注入时各取最近 $10$（`memory.js:407, 416, 424`）。
**定义 8.5（三层存储的联合模型）.** 按"可达性 × 代价"把会话信息分为三层：

| 层 | 对象 | 容量约束 | 每步代价 | 淘汰策略 |
| --- | --- | --- | --- | --- |
| $\mathcal{L}_1$ 内存窗口 | $W_{\text{mem}}$ | $\Lambda$ 条（定义 8.2） | 逐字进前缀，$b\,C_{\text{win}}$ | FIFO |
| $\mathcal{L}_2$ 上下文表层 | $S$（DSH） | $T$ token（定义 1.6） | $b\,P$ | 剪枝 + 摘要 |
| $\mathcal{L}_3$ 持久归档 | `chat.db` / `memory.db` | 磁盘 | 仅检索时 | TTL（定义 8.4），永久层免疫 |

**命题 8.1（三层是互补而非替代）.** 若把 $\mathcal{L}_3$ 去掉（不落库），则 $\mathcal{L}_2$ 的压缩必须是**无损**的，否则信息不可恢复，$T^{*}$ 的收益将伴随不可逆的信息损失；反之若把 $\mathcal{L}_1$、$\mathcal{L}_2$ 的预算压到极小并完全依赖 $\mathcal{L}_3$，则每轮都需要检索，模型调用次数上升，成本结构从"承载"转向"检索 + 输出"。
**推论 8.1（检索给出的等价代价条件）.** 设单次检索的代价为 $q$（含工具 schema、调用往返与结果 token），命中所需信息需要的平均检索次数为 $\nu$，则把内容从 $\mathcal{L}_2$ 移到 $\mathcal{L}_3$ 的**盈亏平衡点**是 $b\,|X|\cdot\mathbb{E}[\text{剩余步数}]\ \lesssim\ \nu\,q$。左端是"把它留在前缀里"的累计承载成本，右端是"按需检索"的成本；在 $b=2\times10^{-8}$ ¥/token/步、$|X|=10^4$ token、剩余 $100$ 步的参数下左端 $\approx2\times10^{-2}$ 元，与一次中等规模工具调用的量级相当。**该式是本文推导，仓库中没有对应的标定**【未核验】；它说明"何时应检索而不是保留"是一个可计算问题，但目前尚无实测参数。
**定义 8.6（会话轮换阈值）.** 桥侧另有一条**与之竞争的**治理路径：按轮数轮换 DSH 会话。

$$
\Lambda_{\text{rot}}(\texttt{cfg})=
\begin{cases}
\infty, & \texttt{cfg.social.autoReset.permanent}=\texttt{true},\\
\max\bigl(5,\ \texttt{cfg.social.autoReset.wakeThreshold}\ \text{或}\ 10\bigr), & \text{否则}
\end{cases}
$$

（`qq-bridge/src/core/wake-send.js:95-98`）【已核验】。当 $\texttt{permanent}=\texttt{true}$ 时，所有形如 $\text{count}\ge\Lambda_{\text{rot}}$ 的判定恒为假，因此轮换块、busy 分支的"等待收尾后再注入"、turn-hold 的"到点放行并关闭回合"、控制台 `[Rotate]` 收尾指令**一处不改即全部停用**（同文件第 88-94 行）【已核验】；当前工作区配置为 `permanent: true`、`wakeThreshold: 18`、`prewarmAhead: 3`（`qq-bridge/config.json` → `social.autoReset`）。
**命题 8.2（轮换与压缩的成本对比）.** 轮换把上下文重置为 $\approx F$，代价是**下一次请求整段重读**（无前缀可命中），即单次成本 $\approx\mathrm{pMiss}\cdot10^{-6}\,C_{\text{prev}}$；压缩把上下文降到 $R+F$，代价是 $\mathrm{pMiss}\cdot10^{-6}R+\mathrm{pOut}\cdot10^{-6}s$。因为 $R\ \ll\ C_{\text{prev}}\ \Longrightarrow\ \kappa_{rb}\ \ll\ \kappa_{\text{rot}}$，**压缩严格优于轮换**（就单次重建成本而言）。这是"永久会话 + DSH 侧压缩"取代"按轮数换新会话"的定量理由：轮换每次都要从零重建整个前缀，而压缩只需要重读保留段。
**转换的工程含义（代码可证）.** 上下文治理的**判定归属**从桥侧移到了 DSH 侧：桥侧的新职责是不再按轮数换会话，改为把压缩策略写入 DSH home 的 `cordis.patch.yml`（`qq-bridge/src/lib/dsh-compaction.js:1-21`）；桥不能删改 DSH 历史，三条硬约束是模型历史由内存日志 `deriveMessages()` 派生（改文件对运行中会话零影响）、日志是 seq 连续的仅追加记录（删行会撞 `corrupt session log: seq gap`）、zstd 帧带校验和（正文一改即校验失败）（同文件第 4-9 行）；唯一受支持的裁剪路径是 DSH 自己通过 surface `replace` 改写历史，即 `compaction-basic`（摘要）与 `tool-result-pruner`（剪枝）（同文件第 10-12 行）。
**定义 8.7（空闲归档）.** 会话归档不删除数据，只打隐藏标记（DSH 侧）；其默认参数为巡检间隔 $10$ 分钟、闲置判定 $30$ 分钟、单轮上限 $20$、磁盘清理阈 $0$（不清理）（`qq-bridge/src/core/session-archive.js:27-33` 的 `DEFAULTS`）【已核验】。**归档的硬安全边界**（不可配置）：当前被映射的会话、standby 会话、有回合在跑的会话一律不归档；只处理本桥工作区 slug 下的 `session-*` 目录（同文件第 8-13、58-94 行）【已核验】。归档**不改变上下文**，它只把不再被引用的会话从活跃集合中移出；因此在治理链路上，归档与压缩是正交的两条路径：压缩控制"活着的会话多大"，归档控制"活着的会话有多少"。

## 34. 复杂度分析

本章记号：$N$ 为表层节点数（$=$ 会话事件中派生消息的数量）；$L$ 为待压缩区间的 token 量；$\mathcal{C}$ 为单节点/单块的内容规模（字符或 token）；$E$ 为会话日志事件总数；$k$ 为压缩代数。
**引理 9.1（定价折叠）.** `planSurfaceTokens` 对单个事件做 $O(1)$ 次 `findIndex`，退化情形 $O(N)$；`commitSurfaceTokens` 为单次 `splice`，$O(N)$（数组搬移）；节点按 `estimateContent` 递归定价，代价与内容规模成正比，即 $T_{\text{fold}}(e)=O(\mathcal{C}(e))+O(N)\ \text{（退化情形）}$（`surface-fold.ts:114-149`）【已核验】。
**引理 9.2（测量）.** `measure()` 为 $O(N)$（复制位置化节点数组）并伴随一次 `structuredClone`，故 $T_{\text{measure}}=O(N)$（`token-meter/src/index.ts:138, 181-188`）【已核验】。
**定理 9.1（单次压缩的代价）.**

$$
T_{\text{compact}}= \underbrace{O(N)}_{\text{测量}} + \underbrace{O(N)}_{\text{选择区间}} + \underbrace{O(L)+O(s)}_{\text{摘要模型调用}} + \underbrace{O(N)}_{\text{重测量}} + \underbrace{O(N)}_{\text{提交}}
= O(N+L+s).
\tag{9.1}
$$

其中摘要调用的模型侧代价与输入长度 $L$ 近似线性、输出受 $s_{\max}$ 封顶。**证明.** 区间选择从尾部向前累加，最坏要扫完整个表层（$O(N)$），随后回退至平衡切，回退步数 $\le N$（`region.ts:114-128`）；提交为两次 `surfaceOp: replace` 级别的日志追加（摘要路径还额外追加 `compaction/start`、`compaction/summary`、`compaction/end`）。$\square$
**定理 9.2（剪枝的代价）.**

$$
T_{\text{prune}}=\underbrace{O(N)}_{\text{遍历表层}} + \sum_{i\in\text{超预算项}} \bigl(O(\text{码点计数})+O(\text{切片})\bigr)=O(N+\Sigma),
$$

$\Sigma$ 为所有超预算工具结果的原始字符总量；当无超预算项时 $T_{\text{prune}}=O(N)$ 且**不产生任何模型调用**。**证明.** 遍历只对 `tool/result` 类型节点调用 `pruneContent`；`measureContent` 与 `Array.from(text)` 各为 $O(\text{内容})$。$\square$
**推论 9.1（剪枝的性价比）.** 由于剪枝的成本是纯 CPU 的 $O(N+\Sigma)$ 而收益是 $O(\Delta)$ token 的前缀缩减（且此后每步都受益），在 $\Delta/\Sigma$ 接近 $1$ 的典型情形下（大工具结果被压到预算 $\Theta$）它**优于**摘要（后者含一次完整模型调用）。这就是控制流把剪枝前置的原因（性质 3.1）。
**定理 9.3（$k$ 次压缩的摊销代价）.** 在理想几何缩减下（每次压缩把以 $T$ 为载体的区间折为大小 $s$ 的检查点），第 $j$ 代摘要调用的输入规模为

$$
L_j = \min\bigl(\underbrace{T}_{\text{自上次以来累积}},\ \underbrace{s}_{j-1}+\Delta_j\bigr),
$$

故 $\sum_{j=1}^{k}L_j\ \le\ k\,T$。**在"扁化"结构下（性质 2.2）不存在"每层都重读全部历史"的指数放大**：第 $j$ 次的输入是上一代检查点 $s$（常数）加上新内容 $\Delta_j$，而非全部历史，因此

$$
\sum_{j=1}^{k}L_j=O\Bigl(k\,s+\sum_j \Delta_j\Bigr)=O(k\,s + N_{\text{sess}}\,g).
\tag{9.2}
$$

**这是"扁化"相对于"嵌套"的决定性工程优势**：嵌套摘要的第 $j$ 次输入为 $\Theta(2^{j})$ 量级（每层都重放前层的全部内容），累积代价指数增长；扁化保证线性。
**各结构的空间占用**：token 表层节点数组为 $O(N)$，每节点 $O(1)$ 个标量 + 附件引用列表（`surface-fold.ts:28-41`）；工具配对平衡缓存为 $O(N)$ 布尔 + $O(N)$ 映射（`tool-pairing.ts:11-24`）；桥侧会话日志扫描缓存为 $O(\#\text{files})$，每文件 $O(1)$ 聚合（按天桶）（`context-savings.js:46, 166-183`）；内存消息窗为 $O(\Lambda)=O(100)$ 条（定义 8.2）；记忆注入为 $O(\min(30,\text{limit}))$ 条。
**引理 9.3（日志扫描的增量性）.** 会话日志扫描以 $(\texttt{mtime},\texttt{size})$ 为键做增量复用：未变的文件沿用上次结果，仅变过的重读；同时在 30 秒 TTL 内不重复扫描，并把状态持久化。**因此面板轮询的均摊代价是 $O(\text{变过的日志})$ 而不是 $O(\text{全部日志})$**（`context-savings.js:46-49, 223-271`）【已核验】。
**一次扫描的代价量级.** `decodeSessionLog` 必须自行解析多帧 zstd（Node 的 `zstdDecompressSync` 只解第一帧），逐帧做 `zstdDecompressSync` + `Buffer.concat`，即 $T_{\text{decode}}=O(\#\text{frames})+O(\text{解压后字节数})$，且必须在首次全量扫描时完成，随后靠 $(\texttt{mtime},\texttt{size})$ 增量回避（`context-savings.js:65-96`）【已核验】。**状态文件格式版本 $=3$，注释说明其必要性**：缓存按 $(\texttt{mtime},\texttt{size})$ 判"文件没变就复用"，不改版本号时新增字段对已缓存的老日志永远读作 $0$（同文件第 34-37 行）【据仓库记载】；该处同时记载了一项工程判据：任何按文件指纹做缓存的统计，其字段集合变化必须同时提升格式版本。

## 35. 验证方法与实验口径

**标定脚本 `docs/dsh-compaction-math.mjs`（纯计算、无外部数据）.** 该脚本**不读取任何实测数据文件**：它只把参数作为常量或命令行参数，直接计算式 (3.1) 并扫描。可选参数：

```text
node docs/dsh-compaction-math.mjs [W] [g] [stepsPerDay] [R]
                                  [1000000] [5500] [400] [20000]
```

（`docs/dsh-compaction-math.mjs:8, 18-21`）【已核验】。**因此本脚本的输出在任何机器上逐字可复现**（除 `toLocaleString` 的千分位格式化依赖 locale 外，脚本已显式指定 `'en-US'`）。其计算清单为：① 常量折算 $b=\mathrm{pHit}\times10^{-6}$、$\kappa_{rb}=\mathrm{pMiss}\cdot10^{-6}R+\mathrm{pOut}\cdot10^{-6}s$（`:24-26`）；② 泛函求值 `model(τ)` 返回 $\{N,\bar C,\text{cycles},\text{carry},\text{rebuild},\text{fixed},\text{perDay}\}$（`:37-47`）；③ 扫描 $\tau\in[0.02,1.0]$ 步长 $0.02$，过滤 $T\le R+2g$ 的不可行点（`:49-51`）；④ 最优与稳健区间：`best` = 最小 `perDay`、`flat` = 劣化 $\le2\%$ 的集合（`:51-52`）；⑤ 闭式解 $T^{*}=R+\sqrt{2g\kappa_{rb}/b}$（`:55`）；⑥ 现况对比：缺省 $\tau=0.8$ 与最优的日成本差与百分比（`:71-76`）；⑦ 敏感性：对 $R\in\{10k,20k,50k,100k,160k\}$、$g\in\{1000,\dots,10000\}$ 各求 $T^{*}$（`:79-90`）。
**数值结论**（本次执行；Node v24.13.0）：

$$
T^{*}=152{,}665\ \Rightarrow\ \tau^{*}=15.3\%,\qquad
\text{扫描最优}\ 16.0\%\ (\text{¥}2.0229/\text{天}),\qquad
\text{稳健区间}\ 14\%\sim18\%,
$$

$$
\Phi(0.8)=\text{¥}4.1703/\text{天},\qquad
\Delta\Phi=\text{¥}2.1474/\text{天}\ (51\%).
$$

**复现命令**：

```sh
node docs/dsh-compaction-math.mjs                     # 出厂参数
node docs/dsh-compaction-math.mjs 1000000 10000 400 20000   # g=10,000 时应得 19.9%
```

**标定脚本 `qq-bridge/tools/compaction-threshold.mjs`.** 与服务端脚本的关键区别：**它读取实测用量库**，参数全部现场量取。

| 项 | 口径 | 行 |
| --- | --- | --- |
| 输入 | `<stateDir>/token-usage.jsonl`，缺省 `qq-bridge/state` | `:19, 31` |
| 筛选 | `^(private\|group):` 且 `est !== true` 且 `cacheRead > 0` | `:42` |
| 样本下限 | $200$ 条主聊天行，否则退出码 $2$ | `:43-46` |
| 步/天 | $n=\lvert\mathcal{S}\rvert/\,\text{spanDays}$，其中 span 取首末时间戳跨度、下限 $0.5$ 天 | `:50-51` |
| 边际 | 对 `cacheRead ≥ 50000` 的最小二乘 | `:57-63` |
| 重建判据 | $r_i < 0.6\,r_{i-1}$（同会话按时间排序） | `:76` |
| 周期步数 | 重建间隔的中位数，仅取 $\ge5$ 的间隔 | `:77, 86` |
| 落点 | 重建后上下文的中位数，缺省 $28672$ | `:87` |
| 每步增长 | $g=\max(500,(\mathrm{median}(cacheRead)-R_{\text{floor}})/N_0)$ | `:88` |
| 扫描 | $\tau\in[0.04,0.6]$ 步长 $0.02$ | `:104` |
| 标定点 | 读 `config.json` 的 `dshCompaction.thresholdRatio` | `:108-113` |
| 标定偏差 | $(\Phi(\tau_{\text{obs}})-\text{measuredPerDay})/\text{measuredPerDay}$ | `:124` |

两次生产复算的实测结果对照（同一脚本、不同样本）：样本分别为 $4{,}659$ 次 / $11.2$ 天与 $5{,}957$ 次 / $13.8$ 天；步/天 $n$ 分别为 $\approx416$ 与 $430$；边际式分别为 ¥$0.0020+0.022$ ¥/M 与 ¥$0.00189+0.0217$ ¥/M；重建单价/频率分别为 ¥$0.036$ / $28.7$ 次每天与 ¥$0.06749$ / $23.9$ 次每天；落点/周期/$g$ 分别为 $\approx28.7$k / — / $990\sim3{,}550$ 与 $28{,}672$ / $16$ 步 / $1{,}748$；最优点/稳健区间分别为 $0.16$ / $[0.14,0.20]$ 与 $0.14$ / $[0.12,0.16]$；模型对实测（同点）分别为 ¥$3.34$ 对 ¥$3.49$（$-4\%$）与 ¥$2.310$ 对 ¥$3.161$（$-27\%$）；证据等级分别为【据仓库记载】与【已核验】（生产复算输出，逐字引用）。
**验收（可执行的门禁）**：`qq-bridge/tools/test-dsh-compaction.mjs` 对该模型的产物做断言：① $\tau W\ge1.5F_0$ 且 $\tau\in[0.12,0.20]$（`:76-81`）；② 缺省值严格大于 $0.08$，$0.06/0.02/0.005$ 均被夹至 $\ge78{,}000$ token（`:82-88`）；③ 余量 $\tau W-(\rho W+F_0)\ge25{,}000$（`:89-94`）；④ `config.example.json` 的 `dshCompaction` 三项与代码缺省一致（`:95-101`）；⑤ 生成的 YAML 含 `compaction-basic` / `tool-result-pruner` 且都带 `disabled: false`（`:108-115`）；⑥ 剪枝预算满足 $\alpha+\lvert\mu\rvert+\omega\le\Theta$（`:49-50`）。
**注意**：断言 ① 的窗口常量取 $W_{\text{test}}=1{,}048{,}576$（$2^{20}$，即 MiB 口径），而桌面端标定脚本取 $W=1{,}000{,}000$（十进制兆），最新生产复算的命令行也显式传 $1{,}000{,}000$；二者相差 $4.86\%$，足以解释"$0.16\times W$"在两个脚本中为 $167{,}772$ 与 $160{,}000$ 的差别。**这是口径不一致而非矛盾**，但在同一段落里混用两者会得到不一致的 token 绝对值。
**运行期计量（`context-savings.js`）.** **性质 10.2（估算的替代方案：直接读权威日志）.** 该模块的第一版走桥的 `mux` 事件流（订阅 `compaction/prune` 与 `step/start` 帧），实测不可行：官方 rc.1 没有全局广播，桥逐会话 `open session`/`follow`，且"仅日志事件能否经 follow 投递"没有保证（`context-savings.js:6-9`）【据仓库记载】；因此改为**读 DSH 自己落的会话日志**：`<dshHome>/sessions/<slug>/<sessionId>/session.jsonl.zstd`。**该数据来源的必要性**：每条 `compaction/prune` / `compaction/summary` 都带 `shadowedSeqs` 与 `shadowedTokenCount`，而日志中完整保留每个 `step/start` 的 `seq` 与时间——于是剪枝收益与重读节省两个量都能**精确**算出，而不是靠字符数估算（同文件第 10-16 行）【据仓库记载】。**`dshHome` 的解析顺序（测量条件）**：管理器里配置的隔离 home 必须排在 `DSH_HOME` 前面；该处注释在本文写作时读取到的内容不完整（同文件第 99-103 行，原文在此处截断）【未核验】；另外本机既不存在 `<DSH_HOME>/cordis.patch.yml` 也未设置 `QQB_DSH_HOME`（本会话已确认），说明该环境变量下的写入路径在本机为空跑【已核验】。
**其余验证手段与其验证对象**：桥与管理端口径逐字复刻（金额口径 `/token` vs `.cost-custom`，`qq-bridge/src/core/token-report.js:6-14, 63-66`）；与 DSH 对账（水位制，记账覆盖度，`token-meter.js` 的 `reconcileWithDsh` / `tokenReconcileStatus`，`:900, 1014`）；重试事件计数（提供方计费但 DSH 不给 usage 的缺口，`context-savings.js:111-114, 145-147`）；工具 schema 体积实测（固定开销 $F$ 的量级，`qq-bridge/tools/tool-schema-meter.mjs`，引用处 `tool-tiers.js:4`；`qq-bridge/tools/calc-slim-tools.mjs`）；会话日志重算幂等性（面板数值可回填，`context-savings.js:20` 与 `STATE_VERSION` 机制 `:34-37`）。
**已知的计量缺口（仓库自述）**：`llm/retry` 事件对应的失败尝试由提供方计费但 DSH 不返回 usage，因此面板会低估这一块；测量批次记录为控制台 $48{,}063{,}224$ / 面板 $47{,}919{,}388$、差 $143{,}836$、同一天恰好 $2$ 条 `llm/retry`（`context-savings.js:111-114`）【据仓库记载】。因此该模块单独统计 `retryEvents`，使缺口可解释而非静默。

## 36. 标定边界、适用条件与未核验项

**必须重新标定的触发条件.**

| 触发条件 | 影响的量 | 依据 |
| --- | --- | --- |
| 改单价（`config.json` → `tokenCost`） | $\mathrm{pHit},\mathrm{pMiss},\mathrm{pOut},\mathrm{mult}$ 直接进 $\kappa$ 与 $b$ | `qq-bridge/config.json`、`token-report.js:19-25` |
| 换模型 / 换服务商 | 缓存 TTL 与命中行为变化；$W$ 变化；$g$ 变化 | $W_{\text{default}}$ 在适配器内（`llm-deepseek/src/adapter.ts:140`，$10^{6}$）与 pi-ai（`llm-pi-ai/src/config.ts:61`，$262{,}144$）不同 |
| 工具表大改 | $F$ 变化 $\Rightarrow$ 下限 (3.4) 变化 | `tool-tiers.js:4-5`；preset 卸载插件的手段（`agent.cordis.yml:187-195`） |
| 提示词大改（人设、`prompt.styleLine`、preset） | $F$ 与 $g$ 同时变化 | `qq-bridge/src/core/config.js:96-99` |
| 观察到"每步都压缩" | 说明 $\tau W$ 已被 $F$ 顶穿 | 推论 3.1、3.3 |

**适用边界：模型失效的区域.**
**边界 B1（前缀不再命中）.** 假设 A1 的前提是"同一前缀被复用"。当请求间隔 $>2$ 小时，实测 `miss/context` 中位数升到 $0.84$，其中 $60\%$ 为完整整段重读；此时 $b\to\mathrm{pMiss}\times10^{-6}$，$T^{*}$ 的表达式退化为

$$
T^{*}\big|_{b=\mathrm{pMiss}}=R+\sqrt{2g\bigl(R+\tfrac{\mathrm{pOut}}{\mathrm{pMiss}}s\bigr)},
$$

代入 $g=5{,}500$、$R=20{,}000$、$s=3{,}000$、$\mathrm{pOut}/\mathrm{pMiss}=4$ 得 $T^{*}=20{,}000+\sqrt{2\times5{,}500\times32{,}000}=20{,}000+18{,}762=38{,}762\ \Rightarrow\ 3.9\%$。**结论：在完全不命中缓存的极端下，最优阈值下移一个数量级**，并直接撞上硬件下限 $\text{MIN\_THRESHOLD\_RATIO}=0.08$ 与余量约束 (3.4)；因此在该区域内模型不再适用——**实际可行的策略是恢复"按轮数轮换"，而不是继续下压阈值**。
**边界 B2（上下文非单调增长）.** 假设 A3 要求线性增长。若会话存在大规模单次注入（例如一次性读入巨型文件、批量导入历史），则 $g$ 不是常数而是重尾分布，$\bar C$ 的线性假设失效，此时应改用以"事件驱动的到达过程"为模型的更新过程（renewal）分析。**本文未给出该推广**【未核验】。
**边界 B3（$s$ 随 $R$ 增长）.** 假设 A5 在长会话下可能失效（摘要需要承载更多历史）。此时 $\kappa_{rb}$ 不再是 $R$ 的线性函数，一阶条件 (4.1) 变为隐式方程

$$
(T-R)^{2}=\frac{2g}{\mathrm{pHit}}\Bigl(\mathrm{pMiss}\,R+\mathrm{pOut}\,s(R)\Bigr),
$$

需数值求解。桥侧把 `maxTokens` 硬编为 $4096$（`dsh-compaction.js:30-31`），因此 $s(R)$ 被**工程性地钉成常数**——这是让 (4.1) 保持闭式可解的关键设计选择。
**边界 B4（固定开销占比过高）.** 当 $F/T$ 不可忽略时（小窗口模型、大工具表），式 (3.1) 需显式包含 $F$：

$$
\Phi(T)=n\bigl(a_0+b(F+\tfrac{R+T}{2})\bigr)+\frac{ng}{T-R}\kappa_{rb},
$$

由于 $bF$ 与 $T$ 无关，**一阶条件不变**，$T^{*}$ 仍由 (4.1) 给出；$F$ 只通过可行性约束（推论 3.1、3.3）限制可行域。
**未核验与推断项清单（不得作为结论使用）已并入附录 D 的统一清单（沿用原编号 U1–U19），此处不再重复。**

**已确证的关键事实（供交叉核对）.** token 启发式密度 `CHARS_PER_TOKEN = 4`（`dsh/packages/llm/token-meter/src/estimate.ts:13`）；块 / 角色结构开销 $4$ / $4$（同文件 `:16, :19`）；默认窗口（DeepSeek）$1{,}000{,}000$（`dsh/packages/llm/llm-deepseek/src/adapter.ts:140`）；compaction-basic 出厂 $\tau_0=0.8$、$\rho_0=0.16$、`maxTokens=8192`、`compactionRetries=1`、`maxOverflowRetries=1`、`auto=true`（`dsh/packages/compaction/compaction-basic/src/config.ts:20-23, 91-95`）；阈值 token 化 $T=\lfloor\tau W\rfloor$、$R=\lfloor\rho W\rfloor$ 或显式 `retainTokens`，且强制 $R<T$（同文件 `:144-154`）；触发比较 `totalTokens < thresholdTokens → 不压缩`（`dsh/packages/compaction/compaction-basic/src/index.ts:305, 313`）；溢出路径绕过阈值与保留尾、保留预算置 $0$（同文件 `:284-292`）；失败模式为重试穷尽仍越界即抛错、不静默降级（同文件 `:329-332`）；剪枝出厂预算 $\Theta=8192,\alpha=4096,\omega=1024$（`dsh/packages/compaction/compaction-tool-result-pruner/src/config.ts:10-14`）；剪枝标记 `"\n\n[... tool result middle pruned ...]\n\n"`（$40$ 码点，同文件 `:7`）；剪枝预算约束 $\alpha+\lvert\mu\rvert+\omega\le\Theta$（同文件 `:55-63`）；摘要检查点标签 `<compacted-summary>` / `</compacted-summary>`（`dsh/packages/compaction/compaction-basic/src/summarizer.ts:21-22`）；摘要结构为固定 8 段、空段写 `"(none)"`（同文件 `:31-66`）；摘要体量上限（桥侧）$4096$（`qq-bridge/src/lib/dsh-compaction.js:30-31`）；安全下限 `MIN_THRESHOLD_RATIO = 0.08`（同文件 `:51`）；出厂阈值 `DEFAULT_THRESHOLD_RATIO = 0.16`（同文件 `:53-54`）；余量约束（测试）$\tau W-(\rho W+F_0)\ge25{,}000$、$F_0=27{,}500$（`qq-bridge/tools/test-dsh-compaction.mjs:74, 89-93`）；剪枝预算推导 $\alpha=\lfloor0.6\Theta\rfloor$、$\omega=\lfloor0.2\Theta\rfloor$（`qq-bridge/src/lib/dsh-compaction.js:81-82`）；重建判据（实测口径）$r_i<0.6\,r_{i-1}$ 同会话上下文回落（`qq-bridge/tools/compaction-threshold.mjs:76`）；落点缺省 $28{,}672$ token（同文件 `:87`）；轮换阈值 `permanent=true → Infinity`，否则 $\max(5,\texttt{wakeThreshold})$（`qq-bridge/src/core/wake-send.js:95-98`）；内存窗口 FIFO、$\Lambda=\max(10,\texttt{recentLimit})$ 缺省 $100$、落盘上限 $200$（`social-flow.js:22,90`；`social-state.js:348`）；记忆层级 TTL permanent $=0$、durable $=90$ 天、working $=7$ 天（`qq-bridge/src/core/memory.js:86-87`）；永久类别 `rule` / `owner` / `identity`（同文件 `:88-89`）；归档默认间隔 $10$ min、闲置 $30$ min、批量 $20$、`pruneDays=0`（`qq-bridge/src/core/session-archive.js:27-33`）；计费日偏移 $480$ 分钟（北京 $08{:}00$ 换日）（`token-meter.js:74-76`；`context-savings.js:31-32`）；用量库字段上限 $50{,}000$ 行、截旧保留 $45{,}000$ 行（`token-meter.js:60-61`）；面板节省口径 `prunedTokens = Σ shadowedTokenCount`、`rereadSaved = Σ(剪掉量 × 其后同会话请求数)`（`context-savings.js:14-15, 319-322`）；保存状态版本 `STATE_VERSION = 3`（同文件 `:37`）。

## 37. 速查与复现命令

**可行性（与最优性无关的硬约束）：**

$$
\tau W\ \ge\ \max\bigl(0.08\,W,\ 1.5F_0\bigr),
\qquad
\tau W-(\rho W+F_0)\ \ge\ 25{,}000,
\qquad
\rho<\tau,
\qquad
\alpha+|\mu|+\omega\le\Theta.
$$

**核心泛函** $\Phi(T)=n\Bigl(a_0+b\,\frac{R+T}{2}\Bigr)+\frac{n\,g}{T-R}\,\kappa_{rb}$、$\kappa_{rb}=\mathrm{pMiss}\!\cdot\!10^{-6}R+\mathrm{pOut}\!\cdot\!10^{-6}s$、$b=\mathrm{pHit}\!\cdot\!10^{-6}$；**一阶条件与最优阈值**为 $(T-R)^{2}=\frac{2g\kappa_{rb}}{b}$ 与 $T^{*}=R+\sqrt{\frac{2g(\mathrm{pMiss}R+\mathrm{pOut}s)}{\mathrm{pHit}}}$（见式 (3.1)、(3.2)、(4.1)、(4.2)）。
**当前工作区的出厂参数**：`qq-bridge/config.json` → `dshCompaction` 为 `thresholdRatio 0.16`、`retainRatio 0.02`、`toolResultMaxChars 8192`、`enabled true`；`~/.dsh/profiles/web/cordis.patch.yml` 为 `compaction-basic`: `thresholdRatio 0.16`、`retainRatio 0.02`、`maxTokens 8192`、`disabled false`，`tool-result-pruner`: `8192/4096/1024`、`disabled false`；`qq-bridge/dsh/agent-presets/qq-chat/agent.cordis.yml` 为 `tool-result-pruner`: `thresholdChars 25000`、`headChars 22800`、`tailChars 2000`（未配置 $\tau$/$\rho$）。
**最新生产样本（2026-09-25 复算）速查**：样本 $5{,}957$ 次主聊天请求 / $13.8$ 天 / $430$ 步每天，实测 ¥$3.161$/天；边际式为每次 $=$ ¥$0.00189+0.0217$ ¥/M $\times$ 上下文；重建 $331$ 次 / $13.8$ 天 $=23.9$ 次每天，每次 ¥$0.06749$；落点 / 周期 / 增长为 $R=28{,}672$ tok、$N_0=16$ 步、$g=1{,}748$ tok/步；最优点 $\tau^{*}=0.14$、稳健区间 $[0.12,0.16]$；出厂值 $0.16$ 位于区间上端，¥$2.082$/天 对最优点 ¥$2.057$/天，劣化 $1.2\%$；模型对实测为 ¥$2.310$ 对 ¥$3.161$，偏差 $-27\%$（乘性系数 $\approx0.73$）；输出与当前检出修订逐列自洽，全部中间量可用。
**复现命令：**

```sh
node docs/dsh-compaction-math.mjs                              # 桌面端标定（纯计算）
node qq-bridge/tools/compaction-threshold.mjs                  # 服务端标定（读用量库，需 ≥200 条主聊天行）
node qq-bridge/tools/compaction-threshold.mjs <stateDir> 1000000
                                                               # 生产复算（2026-09-25 用法）：stateDir 指向下载下来的 token-usage.jsonl 所在目录
node qq-bridge/tools/test-dsh-compaction.mjs                   # 门禁：下限 / 余量 / YAML 形状
```

## 附录 A MCP 工具全表（napcat，91 条）

数据取自 MCP 协议 `tools/list` 的实取结果：以 stdio 传输启动 `qq-bridge/src/mcp-napcat-safe.js`，完成 `initialize` 握手后发送 `tools/list`，取每项工具的 `name` 与 `inputSchema`，`inputSchema.required` 记为必填参数、其余属性记为可选参数，导出结果字段为 `name`、`description`、`required[]`、`optional[]`、`minTier`【已核验】。该启动过程须注入环境变量 `QQB_SLIM_TOOLS_OFF=1`（语义为本次启动忽略压缩档、全部注册，`qq-bridge/src/mcp-napcat-safe.js:687-693`）；不注入时 `tools/list` 返回本机 `config.json` 中 `social.slimTools` 所选档位的子集，得不到完整的九十一项注册表。参考实现见 `qq-bridge/tests/character-tools-mcp.test.js:31-70` 的 `startServer` 与 `:83-89` 的调用处。

列口径：`工具名` 为 MCP 服务注册的裸名，不含 `mcp__napcat__` 前缀；`必填参数`与`可选参数`取自工具输入 schema，无参数记 `—`；`最低保留档位`为该工具仍被注册的最低档位，按裁剪强度由强到弱为 `extreme`、`high`、`medium`、`low`、`off`，由 `toolAllowedByTier`（`qq-bridge/src/lib/tool-tiers.js:192-200`）逐档试算取首个判定为真的档位，`qq_status` 在该函数首行恒真（`:193`）故恒为 `extreme`，各档位名单定义见 `TOOL_TIERS`（`:103-151`），档位中文标签为极限、高、中、低、不裁剪【已核验】。共 91 行，按功能分为 16 组。

### A.G1 状态、时间与运行时信息（5 条）

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能 |
| --- | --- | --- | --- | --- |
| `qq_status` | — | — | `extreme` | 读取机器人登录状态与账号信息，用于自检与故障判定。 |
| `get_time` | — | — | `extreme` | 读取北京时间当前日期与时刻，精确到分钟。 |
| `qq_get_prompt` | — | `key`，`token` | `extreme` | 读取当前默认模式提示词，含角色、推荐取值与可用工具清单。 |
| `qq_social_state` | — | `key`，`token` | `extreme` | 读取会话模拟状态：唤醒配置、未读计数、最近唤醒原因与消息时刻。 |
| `qq_global_overview` | — | `token` | `high` | 汇总全部会话活动概况：未读数、最新消息、最近发言时刻与唤醒模式。 |

### A.G2 群组与会话（4 条）

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能 |
| --- | --- | --- | --- | --- |
| `qq_list_groups` | — | — | `extreme` | 列出机器人已加入的全部 QQ 群，返回群号与群名。 |
| `qq_get_group_members` | — | `key`，`token`，`groupId` | `medium` | 列出指定群的全部成员，返回 QQ 号、昵称、群名片与群内角色。 |
| `qq_get_group_owner` | — | `key`，`token`，`groupId` | `medium` | 返回指定群的群主与管理员，含 QQ 号与昵称或群名片。 |
| `qq_get_active_members` | — | `key`，`token`，`limit` | `high` | 列出当前会话的近期活跃成员，用于判断会话参与者身份。 |

### A.G3 消息发送（7 条）

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能 |
| --- | --- | --- | --- | --- |
| `qq_send_message` | — | `key`，`token`，`messages`，`message`，`images`，`replyToMessageId`，`atUserId`，`gapMode`，`gapMs`，`gaps`，`crossSession` | `extreme` | 向目标会话发送单条或多条文本消息，可附带图片与引用。 |
| `qq_reply` | `replyToMessageId`，`message` | `key`，`groupId`，`token`，`crossSession` | `extreme` | 引用指定历史消息进行回复，用于针对具体消息作答。 |
| `qq_send_group_message` | `groupId`，`message` | `replyToMessageId`，`token` | `low` | 向指定群发送一条纯文本消息，可按消息编号附加引用。 |
| `qq_send_private_message` | `userId`，`message` | `replyToMessageId`，`token` | `low` | 向指定好友发送私聊文本消息，可按消息编号附加引用。 |
| `qq_proactive_send` | `targetKey`，`message` | `key`，`token` | `medium` | 在无人发言时主动向目标会话发送消息，或跨会话转达内容。 |
| `qq_withdraw_message` | `messageId` | `key`，`token` | `medium` | 撤回机器人自身已发送的消息，仅限本人消息。 |
| `qq_send_poke` | — | `key`，`token`，`targetUserId` | `high` | 发送 QQ 拍一拍，用于提醒对方或回应他人的拍一拍。 |

### A.G4 消息读取与历史（8 条）

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能 |
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

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能 |
| --- | --- | --- | --- | --- |
| `qq_set_wake_config` | `config` | `key`，`token` | `high` | 配置当前会话的唤醒模式与触发条件，含提及、关键词与指定发言人。 |
| `qq_mark_read` | — | `key`，`token` | `extreme` | 将会话内未读消息标记为已读，用于结束本轮而不回复。 |
| `qq_wait_for_messages` | — | `key`，`token`，`timeoutMs`，`minNewMessages`，`quietMs` | `high` | 在当前回合内等待新消息到达，可设置超时与静默窗口。 |

### A.G6 记忆与群内用语（8 条）

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能 |
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

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能 |
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

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能 |
| --- | --- | --- | --- | --- |
| `qq_profile_get` | `uid` | `token` | `high` | 按 QQ 号读取长期档案，含昵称、性格、偏好与备注。 |
| `qq_profile_set` | `uid`，`field`，`value` | `token` | `high` | 写入或更新指定 QQ 号长期档案中的单个字段。 |
| `qq_like` | `targetUserId` | `key`，`token`，`times` | `low` | 为指定 QQ 号的名片页点赞，次数可设且上限为十次。 |
| `qq_blacklist` | `uid`，`action` | `key`，`token` | `low` | 将指定 QQ 号加入或移出黑名单，加入后不再接收其私聊。 |
| `qq_remove_friend` | `userId` | `key`，`token` | `off` | 删除指定好友，使其离开好友列表并失去私聊权限。 |
| `qq_admin_set` | `uid`，`action` | `key`，`token` | `low` | 授予或撤销指定 QQ 号的管理员权限，仅所有者与管理员可执行。 |
| `qq_whitelist` | `groupId`，`action` | `key`，`token` | `low` | 将指定群加入或移出会话白名单，影响消息处理范围。 |

### A.G9 图片、表情与表情包（13 条）

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能 |
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

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能 |
| --- | --- | --- | --- | --- |
| `qq_send_voice` | `text` | `key`，`token`，`voice`，`style`，`mode`，`description`，`replyToMessageId` | `high` | 将文本合成为语音并以语音消息形式发送到会话。 |
| `qq_transcribe_voice` | `messageId` | `key`，`token` | `medium` | 将他人发送的语音消息转写为文本。 |
| `qq_get_file_content` | `messageId` | `key`，`token`，`fileIndex` | `high` | 读取指定消息所附文件的内容，支持文本类与 Word 文档格式。 |
| `qq_send_docx` | `title`，`content` | `key`，`token`，`replyToMessageId` | `low` | 将长文本生成为 Word 文档并作为文件发送，避免正文过长。 |

### A.G11 卡片、转发与视频（4 条）

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能 |
| --- | --- | --- | --- | --- |
| `qq_send_rich` | `type` | `key`，`token`，`musicType`，`musicId`，`musicUrl`，`musicStyle`，`audio`，`title`，`image`，`content`，`videoUrl`，`contactType`，`contactId`，`result`，`replyToMessageId`，`atUserId` | `low` | 发送音乐、视频或联系人等原生富媒体卡片。 |
| `qq_send_forward` | `nodes` | `key`，`token`，`replyToMessageId` | `low` | 将多条消息合并为一张转发卡片发送到会话。 |
| `qq_video_parse` | `url` | `key`，`token` | `off` | 解析单个视频链接，返回平台、标题、作者与播放量等元数据。 |
| `qq_video_search` | `query` | `key`，`token`，`limit` | `off` | 按关键词检索视频，返回编号、标题、作者与时长等信息。 |

### A.G12 网络素材检索（4 条）

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能 |
| --- | --- | --- | --- | --- |
| `qq_image_search` | `query` | `key`，`token`，`limit`，`source` | `low` | 按关键词在网络上检索图片，返回候选条目与来源。 |
| `qq_pixiv_search` | `query` | `key`，`token`，`page`，`limit`，`r18`，`tags`，`author`，`orientation`，`minWidth`，`minHeight`，`multiPage`，`excludeAi`，`illustType`，`sort`，`scanPages` | `low` | 按关键词检索插画作品，返回作品编号、作者、标签与尺寸。 |
| `qq_send_pixiv` | — | `key`，`token`，`query`，`illustId`，`authorId`，`index`，`size`，`page`，`replyToMessageId`，`tags`，`author`，`orientation`，`minWidth`，`minHeight`，`multiPage`，`excludeAi`，`illustType`，`sort`，`scanPages`，`crossSession` | `low` | 获取并发送一张插画作品，可按作品编号、作者或关键词定位。 |
| `qq_music_search` | `query` | `key`，`token`，`platform`，`limit` | `low` | 检索歌曲，返回平台、曲名、歌手、专辑与封面链接。 |

### A.G13 QQ 空间（5 条）

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能 |
| --- | --- | --- | --- | --- |
| `qq_qzone_view` | `uid` | `key`，`token`，`num` | `low` | 读取指定 QQ 号的近期空间动态，含评论标识。 |
| `qq_qzone_comment` | `hostUid`，`tid`，`content` | `key`，`token` | `low` | 对指定 QQ 号的空间动态发表一条评论，需提供动态标识。 |
| `qq_qzone_reply_comment` | `hostUid`，`tid`，`commentId`，`content` | `key`，`token`，`replyUid` | `low` | 在指定空间动态下回复某条评论，形成楼中楼对话。 |
| `qq_qzone_like` | `hostUid`，`tid` | `key`，`token`，`curKey` | `low` | 为指定空间动态点赞，点赞属于公开互动行为。 |
| `qq_send_qzone` | `content` | `key`，`token`，`file`，`imageUrl`，`imageQuery`，`pixivIllustId`，`pixivQuery`，`pixivSize`，`imageIndex`，`imageCount` | `low` | 发表一条空间动态，正文之外可选择附带一张图片。 |

### A.G14 计划与定时（3 条）

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能 |
| --- | --- | --- | --- | --- |
| `qq_schedule_message` | `message` | `token`，`key`，`targetKey`，`at`，`delayMs`，`repeatMs`，`sourceKey` | `low` | 登记定时消息任务，可按绝对时刻或延时发送，支持周期重复。 |
| `qq_schedule_list` | — | `token` | `low` | 列出已登记的定时消息任务及其触发时刻。 |
| `qq_schedule_cancel` | `id` | `token` | `low` | 按任务标识取消一条定时消息任务。 |

### A.G15 跨会话通信（2 条）

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能 |
| --- | --- | --- | --- | --- |
| `qq_crosschat_send` | `toKey`，`content` | `token` | `off` | 向其它会话留下一条备注，目标在其下次唤醒时读取。 |
| `qq_crosschat_inbox` | — | `key`，`token` | `off` | 查看其它会话留给当前会话的备注。 |

### A.G16 配置与管理（6 条）

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能 |
| --- | --- | --- | --- | --- |
| `qq_get_system_config` | — | `token` | `high` | 读取可调整的系统配置项，含键名、当前值、允许范围与含义。 |
| `qq_set_system_config` | `value` | `key`，`token` | `high` | 修改系统运行配置项，仅所有者与管理员在其发言会话内可执行。 |
| `qq_get_activity_hours` | — | `key`，`token` | `medium` | 读取会话活跃时段配置，并判断当前时刻是否落在其中。 |
| `qq_set_activity_hours` | `windows` | `key`，`token` | `medium` | 设置、修改或清除会话活跃时段，采用二十四小时制。 |
| `qq_deepsleep` | `enabled` | `token` | `off` | 群的全局静默总开关：开启后全部群消息仅入库而不唤醒。 |
| `qq_report_feedback` | `message` | `key`，`token`，`level` | `off` | 向控制台或管理员上报问题与需人工介入的情况。 |

## 附录 B MCP 宿主服务与联网检索工具表（7 条）

宿主服务由 `qq-bridge/src/mcp-host-server.js` 注册，进程名 `napcat-host`；联网检索服务由 `qq-bridge/src/mcp-web-search-safe.js` 注册，进程名 web-search 安全版。两者与 napcat 的 91 条分属不同服务组，且都不参与工具裁剪档，故`最低保留档位`一列一律记 `—`【已核验】。宿主侧注册顺序与行号：`qq_learning_corpus`（`:142-147`）、`qq_learning_submit`（`:198-210`）、`napcat_status`（`:247-250`）、`start_napcat`（`:264-267`）、`stop_napcat`（`:314-317`），服务名与版本在 `:140` 给出；必填参数取 zod 参数表中不带 `.optional()` 的字段，可选参数取其余字段。联网检索侧注册于 `qq-bridge/src/mcp-web-search-safe.js:943-947` 与 `:980-983`，必填参数为 `query` 与 `url`，取值域取自 zod 链式声明（`:951-957`、`:985-988`）。

| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 功能 |
| --- | --- | --- | --- | --- |
| `qq_learning_corpus` | — | `sinceMs`，`untilMs`，`limit`，`convKeys`，`targetUid` | — | 在学习任务中读取本地聊天库的文本语料，用于用语提取与人设分析。 |
| `qq_learning_submit` | `uid`，`payload`，`token` | `samples` | — | 将学习结果对象回交桥进程落库，避免大段 JSON 留在会话中。 |
| `napcat_status` | — | — | — | 探测 NapCat 网关是否可达并返回 QQ 在线状态与账号信息。 |
| `start_napcat` | — | — | — | 启动 NapCat 并等待网关就绪，最长等待九十秒。 |
| `stop_napcat` | — | — | — | 停止 NapCat 进程，会断开当前 QQ 连接。 |
| `web_search` | `query` | `maxResults`（3–30，默认 12），`platforms`（18 个平台标识，缺省为全部可用平台） | — | 多平台并行聚合检索并按 URL 去重，结果按平台轮转交错返回；同查询五分钟内命中缓存。 |
| `web_fetch` | `url` | `raw`（返回原始标记而非正文），`maxChars`（500–50000，默认 12000） | — | 读取单个 http(s) 页面并抽取可读正文（标题、描述、图片、正文、链接、截断标记）；拒绝内网与环回地址，逐跳校验重定向。 |

其中 `start_napcat` 与 `stop_napcat` 仅当 `napcat.allowProcessControl` 开启时注册【已核验】；`web_search` 的 `platforms` 枚举含 18 个平台标识，`web_fetch` 为只读工具，无本地文件与命令能力【已核验】。

## 附录 C 管理端路由表（93 条）

本附录列出 `server/index.js` 中全部 `app.<method>('<path>')` 注册。口径：排除整行注释后以正则 `app\.(get|post|put|delete|patch)\(\s*'` 抽取，行号为本轮读取值；`GET /api/connect` 在工作区中注册两次（`:2959` 与 `:8025`），两条均计入。

### C.1 本机实例与配置（20 条）

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

## 附录 D 核验范围、缺陷与未核验清单

核验以只读方式执行：`qq-bridge/src/**` 全部模块逐条比对函数名、常量取值与行号；`server/**`、`src/**` 做路由抽取与字节行数统计；`qq-bridge/config.json` 只读解析全部键值；`qq-bridge/state/*.db` 以只读连接查询表结构、行数与元表；`qq-bridge/state/tool-schema-stats.json` 只读解析；`qq-bridge/state/` 文件清单与字节数经目录枚举。本轮核对源码后对既有表述的更正项已直接反映在正文取值中，不再单列。

已确认缺陷（复现方式为只读执行同一条 SQL）：

| 编号 | 缺陷 | 位置 | 复现结果 |
| --- | --- | --- | --- |
| D-1 | 人格学习取样使用记忆库连接查询聊天记录表 | `qq-bridge/src/core/persona-learn.js:223/238/243` | `no such table: chat_messages`，样本恒为 0 |
| D-2 | 群友画像筛选使用记忆库连接查询聊天记录表 | `qq-bridge/src/core/portrait-learn.js:84/88-100` | `no such table: chat_messages`，筛选恒失败并进入 30 分钟退避 |
| D-3 | 进程控制闸门判定输入缺失 | `qq-bridge/src/mcp-host-server.js:73-86` 依赖的 `mode` 字段不存在于 `qq-bridge/src/core/console-server.js:768-780` | 闸门恒为 false，进程控制工具不可用 |

未核验项（均为推断或未复现，不得作为事实引用）：

- U-1 `qq-bridge/state/memory.db.pre-v13-backup` 的产出者（见「记忆、检索与学习」章的未核验段）。
- U-2 `chat_messages.ts` 两种文本格式的成因（同上）。
- U-3 人设库与学习会话 id 的实际落盘位置，`state/persona-library.json`、`state/persona-agent.json` 不存在（同上）。
- U-4 会话归档缓存的落盘位置，`state/session-archive.json` 不存在（见「DSH 集成与上下文压缩接口」章的「失败与降级」节）。
- U-5 `sessions.rename` 的调用点（见「DSH 集成与上下文压缩接口」章的「DSH 客户端协议」节）。
- U-6 `workspace/list` 本地构造返回值与真实端点的差异（见「DSH 集成与上下文压缩接口」章的「失败与降级」节）。
- U-7 隔离 home 下同哈希预设目录的生成代码（同上）。
- U-8 仓库与安装副本预设文件在剥离合成段后的差异（见「DSH 集成与上下文压缩接口」章的「失败与降级」节与「部署、开机自动连接与运行维护」章的「失败、降级与未核验」节）。
- U-9 自启动项在仓库之外的实现位置，仓库内命中数为 0（见「部署、开机自动连接与运行维护」章的「失败、降级与未核验」节）。
- U-10 仓库根 `scripts/` 为空的原因（同上）。
- U-11 `qq-bridge/music-sign-proxy.py` 在当前部署下是否随桥启动（同上）。
- U-12 内置表情包缺包时的完整返回文案（见「媒体处理」章的「失败与降级」节）。
- U-13 封面转存图床功能开启后的行为（同上）。
- U-14 视频卡片在小程序侧的渲染结果（同上）。
- U-15 管理端部分端点的请求与响应字段完整性（见「管理端功能面」章的「失败与降级」节）。
- U-16 敏感判定的误报与漏报比例（见「安全模型与信任边界」章的「失败与降级」节）。
- U-17 私有网段判定的运行期拦截行为（同上）。
- U-18 运行时实际注册的工具条数，受档位门与配置开关影响（见「上下文压缩与令牌预算」章的「现场测量数据」节）。
- U-19 用量对账在跨日与日志清理后的行为（同上）。
- U-20 剪枝计量对非 zstd 会话日志的兼容性（同上）。
- U-21 定时任务时刻精度与主动行为联合触发频次（见「时间驱动与主动行为」章的「失败与降级」节）。
- U-22 QQ 空间接口返回字段全集与资料卡可写字段集合（见「社交拓展面」章）。
- U-23 `splitForQQ` 在 4000 字符上限下的切分点分布（见「生成、闸门与投递」章）。
- U-24 `linearCounts` 在会话数极大时的内存占用（同上）。
- U-25 21 个出厂角色包各自的角色设定内容与完整性（见「人设、角色与表达」章）。
- U-26 表达约束的实际遵守率（同上）。
- U-27 随包 QQ 窗口隐藏器的启动器与命令行拼装（见「管理端功能面」章的「随包 QQ 窗口隐藏器」节）。
- U-28 `qq-bridge/src/core/audit.js` 中 `shouldAuditKey()` 恒真之前是否存在跳过逻辑（见「生成、闸门与投递」章）。

体系结构侧的未核验项与开放问题：

- U-29 隔离 DSH 凭据文件在 Windows 的 ACL：`chmod 600` 在 Windows 上不改变 ACL，实际保护依赖 NTFS 默认 ACL；未在目标环境实测该文件的 ACL。
- U-30 桥的隔离 home 候选：`<repo>/../.runtime/dsh-isolated-home`（桥侧默认）与管理器配置的 `dsh-isolated-home-official` 并存；实际生效值取决于 `QB_DSH_HOME` 与管理器配置，两份候选不自动对齐。
- U-31 `DEFAULT_LOCAL.dshWeb = 3210`：该字段语义为远端 DSH Web 端口（`tunnelMapFor()` 使用 `m.dshWeb ?? 3080`，`server/index.js:194`）【已核验】，但模板默认值为 3210（`server/index.js:64`）【已核验】，而前端 `RP_DEFAULTS.dshWeb = 3080`（`src/pages/SSHConfig.tsx:11`）与部署脚本硬写的 3080（`server/deploy.js:1384`）一致；远端未显式配置时隧道映射到 3210 这一默认值是否统一为 3080 未决，属默认值变更，本轮未修改。
- U-32 `core/napcat-guard.js` 的 `failThreshold` / `cooldownMs` / `maxHealsPerHour` / `restartGraceSec` / `recoverWaitMs`：参数保留于 `DEFAULTS`（`qq-bridge/src/core/napcat-guard.js:34`）【已核验】，探测与重启执行体已删除；属残留契约还是待重新接线的能力未定。
- U-33 打包工程内部装配规则：本文只核对 `build-installer-full.nsi` 与 `moonbot-app/main.js` 的接口事实；`dsh-runtime/` → `dsh/` 的改名、`full\app\` 的生成顺序、electron-builder 变体的目录布局均未逐条核对。
- U-34 `GET /api/config` 的 SSH 密码明文：现状为明文返回，仅依靠 `127.0.0.1` 绑定收敛暴露面；是否纳入脱敏范围需产品决策。
- U-35 MCP 压缩代理的 `--exclude-tools` / `--toonify` 参数组合：由配置与默认值决定；未逐一验证每种组合的最终命令行，需要时以隔离 home 的 `cordis.patch.yml` 实际内容为准。
- U-36 关窗守卫日志轮转：实现中未体现轮转策略；长周期运行时的日志体积上界未确定。
- U-37 `resources/app/` 的具体文件名：安装树内该目录存在；未逐条核对其中文件名，状态为未核验。

标定与数学建模侧的未核验与推断项（沿用原编号 U1–U19）：

| 编号 | 条目 | 说明 |
| --- | --- | --- |
| U1 | 服务端"$4{,}659$ 次 / $11.2$ 天""¥$3.34$ 对 ¥$3.49$（$-4\%$）""$28.7\to11.2$ 次/天" | **【据仓库记载】**：本机 `token-usage.jsonl` 仅 $304$ 行、不满足脚本 $\ge200$ 条主聊天行的前置条件，无法在本机复现该组数字。**该组已被生产复算取代**（复现方式：把生产机 `/root/qq-bridge/state/token-usage.jsonl` 取回本地，以 `node qq-bridge/tools/compaction-threshold.mjs <dir> 1000000` 跑当前检出修订即得逐字输出）：新样本 $5{,}957$ 次 / $13.8$ 天、$\kappa_{rb}=$ ¥$0.06749$、$g=1{,}748$、最优点 $0.14$ |
| U17 | 生产输出中"平均上下文"列与顶部标签 $R_{\text{floor}}=28{,}672$ 的关系 | **已结案（2026-09-25）**：该列就是 $(R_{\text{floor}}+T)/2$（`compaction-threshold.mjs:97`），逐行回代与印值相符，不存在两个口径 |
| U18 | 乘性口径系数 $0.73$（$=\Phi_{\text{模型}}/\text{cost}_{\text{实测}}$）的跨样本稳定性 | **未验证**：只在最新样本的一个点（$\tau=0.08$）上算出；历史样本的对应记载是 $-4\%$（口径不同），二者不可比，故不得把 $0.73$ 视为可移植常量 |
| U19 | ~~扫描表中 $\tau=4\%$ 行的存在性~~ | **已撤回（2026-09-25）**：$4\%$ 行是可行点（$T=40{,}000>R+2g=32{,}168$，周期 6 步），守卫只在 $T\le R+2g$ 时判 `null`（`:95`），故该行本应出现，其数值可正常引用 |
| U2 | 桌面端 $g\approx5{,}500$ tok/步 | 由聚合量 `(未命中+输出) ÷ 步数` 反推的**量级估计**，非逐步回归（`docs/DSH-COMPACTION.md` 原 §8 自述） |
| U3 | 桌面端 $a_0=¥0.002$ | 沿用服务端回归截距，**未在桌面端独立回归**（同上） |
| U4 | "累计 cacheRead $24.8$ 亿 / 未命中 $3030$ 万 / $98.8\%$" | 来源为 commit `fdadc11` 提交信息与 profile 注释，本次**未从 `~/.dsh/storages/session_projcache` 重算** |
| U5 | "本机观测到的最小首请求约 $8.4$k token" | 见于 `~/.dsh/profiles/web/cordis.patch.yml:181` 注释，**未复现** |
| U6 | 峰谷倍率在扫描公式中的处理 | `costOf`（`tools/compaction-threshold.mjs:26-29`）是**逐请求**按北京时间小时判倍率的；但扫描用的 `stepsCost` 与 `rebuildCost` 是否已吸收倍率的平均效应，**本文未逐行追证** |
| U7 | 字素簇劈裂的期望码点损失（引理 6.2 的 $\mathbb{E}$） | **纯推断**，仓库无实测 |
| U8 | 平衡切概率 $p_0$ 与保留量回退步数的分布（推论 2.2） | **纯推断** |
| U9 | 稳健区间的解析形式 (6.1) | **本文推导**；脚本用直接比较确定区间（`docs/dsh-compaction-math.mjs:52`），未使用该解析式 |
| U10 | 净节省 = 收益 $-$ $\kappa_{rb}$ 的扣减 | 面板口径**只统计被移除的规模**（`summarizedTokens` / `prunedTokens`），**未扣除**摘要成本（`context-savings.js:138-144`）；本文推断"净收益需自行做减法" |
| U11 | 检索盈亏平衡式（推论 8.1） | **本文推导**，仓库无对应标定 |
| U12 | 期望压缩次数 $\mathbb{E}[k]=N_{\text{sess}}\sqrt{gb}/\sqrt{2\kappa_{rb}}$（命题 7.2） | **本文推导**；仅与记载的"$11.2$ 次/天"做量级对照 |
| U13 | 摘要保真度随代数 $k$ 的衰减曲线 | **无任何测量**；仓库没有度量摘要保真度的脚本或测试 |
| U14 | QQ 桥 preset 下 `thresholdRatio` / `retainRatio` 的实际生效值 | preset 未配置这两项（`agent.cordis.yml:206-215`），故取 DSH 出厂 $0.8/0.16$；但桥写入的 home 级 `cordis.patch.yml` 是否覆盖**未验证**——本机不存在 `<DSH_HOME>/cordis.patch.yml`，且 `QQB_DSH_HOME` 为空 |
| U15 | 工具 schema 压缩档位的体积收益（该文件举例：`medium` 为 $61{,}587$ 字符 $\approx19{,}246$ token/步、`high` 为 $27{,}109$ 字符 $\approx8{,}472$ token/步） | 见 `qq-bridge/src/lib/tool-schema-compress.js:16-25` 的注释，系**作者在真实 wire 格式上的实测**，本次**未重跑** `tools/tool-schema-meter.mjs` |
| U16 | `context-savings.js` 第 99-103 行注释的完整表述 | 该处注释在本文写作时读取到的内容不完整，**未引用其技术结论** |

## 附录 E 术语与代码符号对照

| 本文符号 | 代码符号 | 位置 |
| --- | --- | --- |
| $\theta(\cdot)$ | `estimateMessage` / `estimateContent` | `dsh/packages/llm/token-meter/src/estimate.ts` |
| $H$ | `estimateHeader` / `estimateSystemTokens` / `estimateToolsTokens` | 同上 |
| $P$ | `TokenMeasurement.totalTokens` | `dsh/packages/llm/token-meter/src/types.ts:30` |
| $\mathcal{N}$ | `MeterSurfaceNode[]` / `TokenSurfaceNode[]` | `surface-fold.ts:28`；`types.ts:38` |
| $\beta_i$ | `cutBalanced[i]` | `dsh/packages/compaction/compaction/src/tool-pairing.ts:19` |
| $T,\ R$ | `spec.thresholdTokens` / `spec.retainTokens` | `compaction-basic/src/config.ts:144-147` |
| $\Theta,\alpha,\omega$ | `thresholdChars` / `headChars` / `tailChars` | `compaction-tool-result-pruner/src/config.ts:10-14` |
| $\mu$ | `PRUNE_MARKER` | 同上 `:7`；桥侧同名常量 `qq-bridge/src/lib/dsh-compaction.js:28` |
| $\Delta_i$ | `shadowedTokenCount` | `dsh/packages/compaction/compaction/src/types.ts:87` |
| $\Gamma_i$ | `rereadSaved` | `qq-bridge/src/core/context-savings.js:14-15` |
| $F_0$ | `FIXED_OVERHEAD` | `qq-bridge/tools/test-dsh-compaction.mjs:74` |
| $F$ | `estimateHeader(header)` | `token-meter/src/estimate.ts:97` |
| $\tau,\rho$ | `thresholdRatio` / `retainRatio` | `compaction-basic/src/config.ts` |
| $\Lambda$ | `social.context.recentLimit` | `qq-bridge/src/core/social-flow.js:22` |
| $\Lambda_{\text{rot}}$ | `rotateThresholdOf(cfg)` | `qq-bridge/src/core/wake-send.js:95` |

