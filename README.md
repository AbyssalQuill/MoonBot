# MoonBot · 一键配置本地与服务器的拟人 QQ Bot

> 一套把「QQ 机器人」从零到跑起来所需的全部东西**打包在一个 Windows 桌面应用里**：Electron 壳 + 管理端（React + Express）+ 内置 NapCat（QQ NT 协议端）+ 内置 QQ 桥接层 + 内置隔离 DSH agent + 表情包库 + 打包/部署脚本。
>
> 你不需要懂 Node、不需要懂 OneBot、不需要记一堆命令：装上、点几下、扫码登录 QQ，机器人就能在群里/私聊里和模型对话。

<p>
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4">
  <img alt="electron" src="https://img.shields.io/badge/Electron-28-47848F">
  <img alt="node" src="https://img.shields.io/badge/Node-%E2%89%A5%2022.13-339933">
  <img alt="react" src="https://img.shields.io/badge/React-18-61DAFB">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
</p>

---

## 目录

- [一、这是什么](#一这是什么)
- [二、架构图（本文用文字画的，逐层拆开）](#二架构图本文用文字画的逐层拆开)
- [三、本地完整目录结构（逐目录说明）](#三本地完整目录结构逐目录说明)
- [四、技术栈与依赖](#四技术栈与依赖)
- [五、端口与进程一览](#五端口与进程一览)
- [六、快速开始](#六快速开始)
- [七、管理端界面逐页说明](#七管理端界面逐页说明)
- [八、管理端 HTTP API](#八管理端-http-api)
- [九、QQ 桥接层（能力详解）](#九qq-桥接层能力详解)
- [十、MCP 工具清单](#十mcp-工具清单)
- [十一、命令速查](#十一命令速查)
- [十二、配置参考](#十二配置参考)
- [十三、数据与日志](#十三数据与日志)
- [十四、日常运维](#十四日常运维)
- [十五、开发与打包](#十五开发与打包)
- [十六、常见问题与坑](#十六常见问题与坑)
- [十七、隐私与安全](#十七隐私与安全)
- [十八、致谢与许可](#十八致谢与许可)

---

## 一、这是什么

MoonBot 是一个 **Windows 桌面应用**（`MoonBot.exe`），它把一套完整的 QQ 机器人系统装进一个文件夹里，并把所有配置搬到图形界面上。整套系统由五个可独立演进的部件组成，MoonBot 负责把它们**装好、配好、拉起、探活、记日志、收摊**：

| # | 部件 | 作用 | 前端界面 |
|---|---|---|---|
| ① | **QQ 账号** | 机器人的身份（扫码登录一次） | QQ 客户端 / NapCat WebUI |
| ② | **NapCat OneKey**（内置便携版） | 把 QQ NT 客户端变成 OneBot v11 服务端（HTTP 3000 / WS 3001） | `http://127.0.0.1:6099` |
| ③ | **qq-bridge 桥接层**（本仓库自带源码） | QQ 消息 ↔ 模型：唤醒判定、提示词注入、人设、工具调用、发送链、学习、社交 | `http://127.0.0.1:3100` |
| ④ | **隔离 DSH**（DeepSeek Harness，内置） | 真正的 agent 运行时：会话、工具、preset（系统提示词）、上下文管理 | `http://127.0.0.1:10721` |
| ⑤ | **模型服务商** | LLM 推理（DeepSeek 官方 / 小米 MiMo / 任意 OpenAI 兼容端点） | 管理端「模型」卡片 |

**做给谁用**：想让 QQ 机器人拥有人设、记忆、群聊社交能力，又不想自己拼装 OneBot + agent + 提示词工程的人；以及想把整条链路一次性部署到远程 Linux 服务器的人。

**核心能力一句话版**：群聊/私聊对话 · 多种唤醒策略（@、戳一戳、关键词、概率主动）· 人设与规则分层可热更新 · 群友画像与人设自动学习 · 黑话学习 · 表情包/贴纸 · 主动闲聊与潜水模式 · 活动时段 · 回合保持（连发消息不丢）· 定时/预约消息 · 跨会话记忆 · QQ 空间说说 · Token 用量计量与成本面板 · 一键复制整套到服务器。

---

## 二、架构图（本文用文字画的，逐层拆开）

### 2.1 分层架构：一条消息从 QQ 到模型再回到 QQ

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ ① 用户                                                                   QQ 群 / 私聊 │
└───────────────────────────────────────────┬───────────────────────────────────────────┘
                                            │ QQ 协议（QQ NT 客户端）
┌───────────────────────────────────────────▼───────────────────────────────────────────┐
│ ② NapCat（内置 OneKey 便携版，独立 QQ 实例，不碰你日常用的 QQ）                        │
│     WebUI :6099        OneBot HTTP :3000        OneBot 反向 WS :3001                  │
└───────────────────────────────────────────┬───────────────────────────────────────────┘
                                            │ OneBot v11（事件 / 动作）
┌───────────────────────────────────────────▼───────────────────────────────────────────┐
│ ③ qq-bridge（桥接层；入口 qq-bridge/src/bridge.js，本地控制台 :3100）                  │
│     ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌───────────┐  ┌──────────────┐       │
│     │ OneBot   │→ │ 唤醒判定 │→ │ 提示词组装 │→ │ DSH 会话  │→ │ 发送链/媒体  │→ QQ   │
│     │ WS 客户端│  │ mux      │  │ wake-send  │  │ dsh-client│  │ qq-send      │       │
│     └──────────┘  └──────────┘  └────────────┘  └───────────┘  └──────────────┘       │
│     社交 social-flow · 状态 social-state · 回合保持 turn-hold · 调度 scheduler        │
│     学习 portrait-learn / persona-learn / slang · 表情 sticker · 空间 qzone           │
│     state/：SQLite(memory.db) · social-state.json · token-usage.jsonl · …             │
└───────────────────────────────────────────┬───────────────────────────────────────────┘
                                            │ DSH HTTP API（会话 / prompt / steer）
┌───────────────────────────────────────────▼───────────────────────────────────────────┐
│ ④ 隔离 DSH（@deepseek-ai/dsh；独立 DSH_HOME + 端口 :10721，profile=web）               │
│     agent-presets/default ← 系统提示词（规则层：安全/工具/唤醒协议/行为规范）          │
│     [PERSONA] / [SPEECH RULES] ← 桥在每轮注入（人设层，可热更新）                      │
│     plugins：dsh-qq-hold（回合保持）· qq-mode-console（模式控制台）                     │
└───────────────────────────────────────────┬───────────────────────────────────────────┘
                                            │ LLM API（provider / model / reasoningEffort）
┌───────────────────────────────────────────▼───────────────────────────────────────────┐
│ ⑤ 模型服务商（DeepSeek 官方 · 小米 MiMo · 任意 OpenAI 兼容端点）                       │
└───────────────────────────────────────────────────────────────────────────────────────┘

旁路（同机进程，不属于消息链路）：
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ 管理端：MoonBot.exe（Electron 壳）→ qbm-node.exe server/index.js（Express :1921）      │
│         → 托管 dist/（React 界面）+ 编排上面 ②③④ 三个实例（启动/停止/探活/日志/配置）  │
│ 守卫：server/napcat-guardian.mjs —— 盯着 MoonBot.exe，应用一关就把 ②③④ 一起收掉       │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 一次群消息的完整旅程（时序）

```
群友发消息
   │
   ├─(1) NapCat 收到 → 通过反向 WS 推给桥（OneBot v11 事件）
   │
   ├─(2) 桥判断"要不要醒"：mux.js / social-flow.js
   │        · 被 @ 了？点名了？被戳一戳了？命中关键词了？
   │        · 在潜水模式？活动时段内吗？概率主动要不要开口？
   │        · 同一个群刚处理过、还在冷却？命中去重规则？
   │
   ├─(3) 组装这一轮的提示词：wake-send.js
   │        [Token] <回合令牌>  [Wake <类型>]  [Unread N]  最近消息窗口
   │        ＋（首轮或人设变了才带）完整 preset ＋ [PERSONA] 人设 ＋ [SPEECH RULES]
   │        ＋ 活动时段/模式/未读等"数据形态"的上下文
   │
   ├─(4) 投给隔离 DSH：dsh-client.js（每个 QQ 会话 ↔ 一个 DSH session）
   │        模型开始思考 → 可能调用 MCP 工具（查记忆、查群成员、发图、发言…）
   │
   ├─(5) 工具执行：mcp-napcat-safe.js（77 个 NapCat 类工具）+ mcp-host-server.js
   │        · 只读工具直接返回；写工具校验会话令牌 / 是否主人私聊
   │
   ├─(6) 回复/动作回到桥 → 发送链 qq-send.js
   │        切分长文本、@、引用回复、markdown→纯文本、表情/图片/语音处理
   │
   ├─(7) 交给 NapCat 的 OneBot 动作接口 → QQ 里出现消息
   │
   └─(8) 落数据：memory.db（聊天记录/画像）· social-state.json（会话状态/未读/令牌）
            token-usage.jsonl（用量）· tool-calls.jsonl（工具调用轨迹）· bridge.log
```

### 2.3 桥接层内部模块图

```
qq-bridge/src/
├─ bridge.js            ← 进程入口：装配所有模块、连 OneBot、连 DSH、单实例锁
├─ dsh-client.js        ← 与隔离 DSH 的 HTTP 客户端（建会话、发 prompt、steer 注入）
├─ forward.js           ← 消息转发（合并转发 / 单条转发）
├─ mcp-napcat-safe.js   ← MCP server：把 NapCat 能力暴露成工具给模型（最大的一块）
├─ mcp-host-server.js   ← MCP server：宿主/进程类工具（启停 NapCat 等，默认关闭）
├─ mcp-web-search-safe.js ← MCP server：联网搜索安全封装
├─ sensitive.js         ← 敏感内容闸门
├─ slang-learner.js     ← 黑话学习（从群聊里抽词、归纳释义）
├─ sticker-lib.js       ← 表情包库（本地图库检索 + 收藏）
├─ core/                ← 业务内核（消息处理、状态、社交、学习、调度、媒体）
└─ lib/                 ← 基础库（路径、配置、文本安全、时间、发送节奏、护栏…）
```

### 2.4 关窗清理链（为什么"关掉应用 NapCat 也会关"）

```
用户点窗口右上角 ×
   │
   ├─ Electron 壳 main.js: window-all-closed → shutdownEverything()（只跑一次）
   │     ① POST http://127.0.0.1:1921/api/shutdown {all:true}   ← 体面收摊：停桥 / 停 DSH / 停 NapCat
   │     ② 等最多 8 秒（等不到也继续）
   │     ③ taskkill /pid <后端> /T /F                          ← 强杀后端（含它的子进程）
   │     ④ 兜底：按 exe 路径精确匹配再清一次 qbm-node
   │
   └─ 守卫进程 napcat-guardian.mjs（在①~④ 之前就被"送出去"了，**不在**你应用的进程树里）
          · 每 2 秒看一眼 MoonBot.exe 还在不在
          · 不在了 → 等宽限期（默认 6 秒）→ 重新读 guard 文件
                 ├─ 文件里的 pid 已不是自己 → 说明是"管理器正常重启"，静默退出，什么都不杀
                 └─ 还是自己 → 判定"应用被关了/崩了"，依次收掉：NapCat → 桥 → 隔离 DSH
          · 全程只按"托管目录前缀 / 本安装的 bridge.js 绝对路径 / --port <隔离DSH端口>"匹配，
            没给参数的那一段直接跳过 —— **宁可不动，绝不误杀**
```

### 2.5 装机后各部件落在哪里（把"应用"和"数据"分清楚）

```
MoonBot.exe（安装包安装的目录，例如 D:\MoonBot）
├─ MoonBot.exe                   Electron 壳
├─ resources\app.asar            壳的代码（main.js + package.json）
└─ resources\runtime\            ← 整个运行时（后端 + 桥 + DSH + NapCat + Node）
    ├─ qbm-node.exe              内置 Node（后端/桥/DSH 都用它跑）
    ├─ server\                   管理端后端
    ├─ dist\                     管理端前端（React 构建产物）
    ├─ qq-bridge\                桥接层（src / tools / dsh / plugins / scripts / state）
    ├─ dsh\ + dsh-runtime\       隔离 DSH 的源码与依赖
    ├─ napcat-onekey\            NapCat 便携版（含 QQ.exe）
    └─ meme\                     表情包库

用户数据（**在安装目录之外**）
├─ %USERPROFILE%\.qq-bridge-manager\
│   ├─ config.json               管理端配置（服务器列表 / 本机端点 / 三个实例参数）
│   ├─ profiles.json             「方案」页签保存的命名配置
│   ├─ napcat-guardian.json      守卫进程登记表
│   ├─ logs\                     各实例日志（manager / dsh-isolated / bridge-local / napcat-*）
│   └─ dsh-isolated-home-<profile>\   隔离 DSH 的独立 DSH_HOME（sessions / profiles / presets / 凭据）
└─ <安装目录>\resources\runtime\qq-bridge\state\   ← 桥的运行时数据（聊天记录库、社交状态…）
```

> ⚠️ **注意**：桥的 `state/`（记忆库、聊天记录、人设学习结果）落在**安装目录内**。所以别把 MoonBot 装到
> `C:\Program Files`（按用户安装、写不进去）或 OneDrive 这类同步盘（SQLite 会被同步搞坏），
> 也别装完随手挪目录 —— 管理端首页会在检测到风险位置时给出警告。

---

## 三、本地完整目录结构（逐目录说明）

这一节描述**本地开发/源码仓库**（本仓库根目录）的完整结构。带 ✅ 的进 git，带 ⛔ 的被 `.gitignore` 排除
（体积大、或含运行数据/私有信息，只在本机存在）。

```
MoonBot Public/                        ← 仓库根（本机路径示例：C:\Users\<你>\Desktop\MoonBot Public）
│
├─ 📦 管理端（应用本体）
│   ├─ src/                    ✅ 管理端前端源码（React + TypeScript + Vite）
│   │   ├─ App.tsx             页面壳与跳转（首页/SSH/实例/桥配置…）
│   │   ├─ api.ts              后端接口封装（统一 fetch + 状态）
│   │   ├─ main.tsx            Vite 入口
│   │   ├─ pages/              8 个页面：Home / InstanceConfig / BridgeConfig / Learning /
│   │   │                      GroupPortrait / SSHConfig / WebView / NetCanvas
│   │   ├─ components/         通用组件（NumInput 等）
│   │   ├─ stores/             zustand 全局状态与类型
│   │   ├─ styles/             主题 token（nc_pink 亮色粉）与全局样式
│   │   └─ tool-schema-chars.ts 工具 schema 体积表（由脚本生成，供用量/成本页估算）
│   ├─ server/                 ✅ 管理端后端（Express）
│   │   ├─ index.js            全部 HTTP API + 实例编排 + 探活 + 静态托管（约 210 KB，最核心的一块）
│   │   ├─ deploy.js           SSH 远程部署：环境自愈 + 打包上传 + 远端执行 + 状态合并
│   │   └─ napcat-guardian.mjs 守卫进程（应用关闭时连带收掉 NapCat/桥/DSH）
│   ├─ dist/                   ⛔ 前端构建产物（npm run build 生成，打包时进安装包）
│   ├─ public/                 ⛔ 静态资源（字体、收款码图片）
│   ├─ node_modules/           ⛔ 管理端依赖
│   ├─ index.html               ✅ Vite HTML 模板
│   ├─ package.json             ✅ 管理端脚本与依赖
│   ├─ package-lock.json       ✅ 依赖锁定
│   ├─ vite.config.ts           ✅ Vite 配置（dev 端口、代理、构建输出）
│   ├─ tsconfig.json            ✅ TypeScript 配置
│   ├─ tauri.conf.json          ✅ 早期 Tauri 方案的遗留配置（当前桌面壳是 Electron，保留不影响使用）
│   └─ 启动管理端.bat            ✅ 双击即开发模式启动（自动装依赖 → 起 vite + 后端）
│
├─ 🌉 QQ 桥接层（机器人本体）
│   └─ qq-bridge/
│       ├─ src/                 ✅ 桥接层源码（113 个文件，见 2.3 模块图）
│       ├─ dsh/                 ✅ agent preset（系统提示词）：agent-presets/default、agent-presets/qq-chat
│       ├─ plugins/             ✅ 两个 DSH 插件：dsh-qq-hold（回合保持）、qq-mode-console（模式控制台）
│       ├─ scripts/             ✅ 运维脚本（setup-dsh、merge-state、各种自检与一次性工具）
│       ├─ tools/               ✅ 开发/回归工具（测试套件、会话转录分析、工具文案体积统计…）
│       ├─ tests/               ✅ 单元测试（lib / paths）
│       ├─ docs/                ✅ 桥接层自己的文档（DSH 接入、项目指南、重构说明…）
│       ├─ characters/          ✅ 角色卡模板（`_template/`：personality/relations/speech/memory…）
│       ├─ config.example.json  ✅ 出厂配置模板（脱敏版：ownerQQ=0、名单清空、token 占位）
│       ├─ README.md / RULES.md / speech-rules.md   ✅ 桥接层说明与规则文本
│       ├─ package.json         ✅ 桥接层依赖（MCP SDK / zod / schemastery；SQLite 用 Node 内置 node:sqlite）
│       ├─ restart.bat / start.bat  ✅ 手动启动/重启桥
│       ├─ music-sign-proxy.py  ✅ 音乐签名代理（点歌能力的辅助服务）
│       ├─ state/               ⛔ 运行数据：memory.db(SQLite 聊天记录/画像) · social-state.json ·
│       │                          sessions.json · token-usage.jsonl · activity-windows.json · 各种 .log
│       ├─ config.json          ⛔ 你的实际配置（含主人 QQ、群号、NapCat token）
│       ├─ persona.md / roles/  ⛔ 你的人设文件（私有角色卡）
│       ├─ node_modules/        ⛔ 桥接层依赖
│       └─ .dsh/ · .tscheck/    ⛔ 桥接层局部工具缓存
│
├─ 🧠 隔离 DSH（DeepSeek Harness）
│   ├─ dsh/                     ⛔ DSH 官方源码检出（含它自己的 .git，约 240 MB）
│   ├─ dsh-runtime/             ⛔ DSH 的依赖安装树（pnpm workspace：node_modules + lock）
│   └─ .runtime/                ⛔ 桥/DSH 的调试工作目录（实例日志、临时实验、旧版本备份）
│
├─ 🐧 NapCat 与表情包
│   ├─ napcat-onekey/           ⛔ NapCat 便携版（NapCat.Shell + bootmain + QQ.exe，约 1.4 GB）
│   └─ meme/                    ⛔ 表情包库（whale-fanart-001：index.db + manifest.json + 185 张图）
│
├─ 📚 文档与工具（仓库根）
│   ├─ docs/                    ⛔ 内部交接文档（NEXT-SESSION / SESSION-HANDOFF…；含本机路径与服务器信息，
│   │                              所以不进公开仓库，但**开发时最有价值**的资料在这里）
│   ├─ tools/                   ✅ 开发/运维脚本（见下表）
│   ├─ scripts/                 ✅ 预留脚本目录
│   ├─ 手动同步与SSH说明.md        ⛔ 手动同步与 SSH 备忘
│   ├─ 本地运行指引.md            ⛔ 本机运行指引
│   ├─ bridge-sync.tar.gz       ⛔ 手动同步用的打包产物
│   └─ logs/                    ⛔ manager / music-proxy 的日志
│
├─ 📦 发布与打包产物
│   └─ release/                 ⛔ 安装包与图标（MoonBot-Full-Setup.exe 约 822 MB、MoonBot-Setup.exe、发行说明）
│
└─ 根文件
    ├─ README.md                ✅ 本文
    ├─ LICENSE                  ✅ MIT
    ├─ .gitignore               ✅ 忽略规则（哪些不进 git，见本节说明）
    ├─ package.json / package-lock.json  ✅ 管理端依赖与脚本
    └─ 启动管理端.bat             ✅ 双击启动（开发模式）
```

**`tools/` 里都是什么**（✅ 进 git）：

| 文件 | 作用 |
|---|---|
| `sync-to-live.ps1` | **最常用**：把源码同步到「活体运行时 + 4 个打包 payload」，并核对桥源码/预设哈希是否一致（一定要看到 `DONE`） |
| `restart-manager.ps1` | 只重启管理端后端（只杀 `server/index.js`，不带 `/T`，实例会被探活认回） |
| `start-manager-hidden.vbs` | 无窗口拉起管理端（给计划任务/快捷方式用） |
| `diag-napcat-guard.ps1` | 只读体检：端口、NapCat 进程、守卫状态、硬链接 |
| `probe-ssh-banner.mjs` | 零认证 SSH 探测（只看 banner，不会触发 fail2ban） |
| `diag-ssh-auth.mjs` / `diag-ssh-keys.mjs` | SSH 认证方式诊断 / 本机私钥可用性诊断 |
| `test-*.mjs` | 管理端回归套件（见 [十五、开发与打包](#十五开发与打包)） |

> 本仓库**不进 git** 的东西统一在 `.gitignore` 里说明，原则只有三条：
> ① 体积大且能重新生成的（`node_modules`、`dist`、`dsh-runtime`、NapCat、安装包）；
> ② 属于运行数据的（`state/`、`logs/`、`config.json`、人设）；
> ③ 只对本机有意义的（内部交接文档、手动同步备忘）。
> 所以 **clone 下来就能读代码、能改代码，但要真正跑起来需要按「十五」补依赖与运行时**。

---

## 四、技术栈与依赖

| 层 | 技术 | 说明 |
|---|---|---|
| 桌面壳 | **Electron 28** | `main.js`：单实例锁、隐藏拉起后端、关窗先体面收摊、任何外链走系统浏览器 |
| 管理端后端 | **Node.js ≥ 22.13** + **Express 4** | `server/index.js`，默认 `127.0.0.1:1921`；`ssh2` 负责 SSH 隧道与远程部署 |
| 管理端前端 | **React 18** + **TypeScript 5** + **Vite 6** + **zustand 5** + **lucide-react** | 8 个页面，主题 token 取自 NapCat 官方 WebUI 的 `nc_pink` 亮色主题 |
| 桥接层 | **Node.js ESM** | 纯 JS（无 TS 构建步骤），SQLite 用 **Node 内置 `node:sqlite`**（无原生编译依赖） |
| 工具协议 | **MCP（@modelcontextprotocol/sdk）** + **zod** | 桥把 QQ 能力做成 MCP 工具给 agent 调用；工具描述体积做了压缩（schema 占一次请求的大头） |
| Agent 运行时 | **DeepSeek Harness（DSH）** | 隔离实例：独立 `DSH_HOME`、独立端口、独立 preset；桥通过 DSH HTTP API 建会话/发提示词/注入 |
| QQ 协议端 | **NapCat（OneKey 便携版）** + **OneBot v11** | 反向 WS 3001（事件）、HTTP 3000（动作）、WebUI 6099（登录/配置） |
| 远程部署 | **SSH（ssh2）** + **tar** | 连接（支持密码/密钥/keyboard-interactive）→ 隧道 → 目标机环境自愈（node/npm/docker）→ 上传 → 远端执行 → 状态合并 |
| 打包 | **electron-builder 24** + **NSIS** | 两个变体：`full`（整套）与 `core`（仅管理端）；构建前自动脱敏 payload |
| 内置 Node | **qbm-node.exe** | 随包分发的 Node，后端/桥/DSH 都用它跑，目标机无需装 Node |

---

## 五、端口与进程一览

| 端口 | 属于谁 | 用途 | 谁在看它 |
|---|---|---|---|
| `1921` | 管理端后端 | 全部 HTTP API + 托管前端 `dist/` | 应用窗口 / 浏览器（可用 `QBM_API_PORT` 改） |
| `5173` | Vite 开发服务器 | 仅开发模式（`npm run dev`） | 浏览器 |
| `6099` | NapCat | 官方 WebUI（扫码登录、OneBot 配置） | 你 / 管理端「打开官方界面」 |
| `3000` | NapCat | OneBot v11 HTTP（动作接口） | 桥（发消息） |
| `3001` | NapCat | OneBot v11 反向 WS（事件推送） | 桥（收消息） |
| `10721` | 隔离 DSH | agent 运行时 HTTP API | 桥 / 管理端「打开官方界面」 |
| `3100` | 桥接层 | 桥自带的本地控制台（状态/调试） | 你 |
| `3210` | 你自己的 DSH | **与本应用无关**（应用用的是隔离实例 10721） | — |

**进程清单**（同机跑起来后你会看到）：

| 进程 | 由谁拉起 | 说明 |
|---|---|---|
| `MoonBot.exe` | 你双击 | Electron 壳 |
| `qbm-node.exe server/index.js` | 壳（隐藏） | 管理端后端 |
| `qbm-node.exe …dsh…bin.js --port 10721` | 后端 | 隔离 DSH |
| `qbm-node.exe src/bridge.js` | 后端 | 桥接层 |
| `NapCatWinBootMain.exe` + `QQ.exe` | 后端（经隐藏 VBS） | NapCat / QQ |
| `guard-node.exe napcat-guardian.mjs` | 后端（WMI 送出，不在应用进程树里） | 关窗守卫 |

---

## 六、快速开始

### 6.1 方式 A：用安装包（推荐给普通用户）

1. 运行 `release\MoonBot-Full-Setup.exe`（完整版，约 822 MB，含全部运行时）。
2. 安装到一个**普通目录**（例如 `D:\MoonBot`）。⚠️ 别装 `C:\Program Files`，别装同步盘。
3. 打开 MoonBot → 首页按顺序启动三个实例：**DSH → NapCat → 桥**（也可以直接「一键启动」）。
4. 点「打开 NapCat 官方界面」→ 扫码登录机器人的 QQ。
5. 在管理端「模型」卡片里填模型服务商与 API Key，选模型（推理档位也在这里）。
6. 私聊机器人或把它拉进群，@ 它说句话，收到回复就通了。

### 6.2 方式 B：源码运行（开发/二次开发）

```powershell
# 1) 管理端依赖（首次）
npm install

# 2) 启动（开发模式：vite :5173 + 后端 :1921）
npm run dev
#    或者双击 启动管理端.bat

# 3) 生产模式（单端口）
npm run build
node server/index.js        # → http://127.0.0.1:1921
```

**源码运行还需要三份运行时**（仓库里没有，体积太大）：NapCat 便携版、DSH 源码与依赖、以及内置 Node。
把 `D:\MoonBot\resources\runtime\` 里对应的 `napcat-onekey\`、`dsh\`、`dsh-runtime\` 复制到仓库根目录即可 ——
后端的探测顺序是「项目内 → 常见位置 → PATH」，目录位置换了也能自动找到。

### 6.3 首次配置清单

| 步骤 | 在哪做 | 说明 |
|---|---|---|
| 填模型服务商 / API Key | 管理端 → 模型卡片 | 支持 DeepSeek 官方、小米 MiMo、任意 OpenAI 兼容端点；模型列表从 DSH 自己的配置里读，切服务商列表自动跟着换 |
| 登录机器人 QQ | NapCat WebUI（:6099） | 扫码即可；管理端支持「快速登录」（复用上次登录态） |
| 填你的 QQ（主人） | 桥接层配置 → 主人 QQ | 决定「主人私聊」特权会话（更高权限、专属人设注册） |
| 白名单/黑名单 | 桥接层配置 → 允许/拒绝 | 哪些群、哪些私聊可以用 |
| 人设 | 桥接层配置 → 人设与发言规则 | 上传 `persona.md` 即可；**空着就用内置默认人设**（一个通用助手） |
| 微信/通知（可选） | 首页 | 需要时再配 |

---

## 七、管理端界面逐页说明

界面是单页应用但**没有 URL 路由**：`src/App.tsx` 用一个内存 view 状态切换页面（`launch / ssh / cfg / web / bridge / learning / portrait`），任意子页按 **ESC 回首页**。状态轮询：有实例处于 `starting/stopping` 时 **1.2 秒**一次，其余 **4 秒**一次。

### 7.1 首页 Home（启动器）

| 元素 | 说明 |
|---|---|
| 标题 | 打字机循环 slogan + 副标题「MoonBot · 一键配置本地和服务器的拟人 QQ Bot」 |
| **一键启动整套** | 主按钮：按 **NapCat → DSH → 桥** 顺序启动，**每一步等到真正就绪**才走下一步，右侧实时显示每一步的耗时与结果 |
| 新手教程 | 弹窗 5 节：启动前准备 / 启动顺序 / SSH 远程怎么配 / 常用设置入口 / 忘了在哪 |
| 2×2 服务卡 | **NapCat（QQ 网关）** · **DeepSeek Harness（内置大脑·独立端口）** · **Core（内置核心层：桥）** · **SSH 配置（远程服务器·隧道）** |
| 卡片按钮 | 随状态变：`starting/stopping` 转圈禁用、`running` 显示「打开」+ 重启 + 停止、`idle` 显示「启动」、`failed` 显示「重试启动」；右下齿轮进该实例的配置页 |
| 「打开」行为 | 桥 → 直接进「功能配置」页；NapCat / DSH → 应用内嵌 WebView 打开**官方界面** |
| 卡脚小字 | 告诉你「现在在等什么」：启动中带秒数、NapCat 未登录显示「已启动 · 等待 QQ 扫码登录」、失败显示错误摘要 |
| 顶部警告条 | 安装位置体检（装在 `Program Files` / 同步盘时警告：记忆库写不进去、SQLite 可能被同步损坏） |

### 7.2 实例配置 InstanceConfig

- 标题随实例切换（DeepSeek Harness / NapCat / Bridge），副标题显示运行状态。
- **隔离 DSH**：端口（默认 10721）· profile（锁定 `web`）· DSH CLI 路径 · 隔离 home（`DSH_HOME`）。
- **NapCat**：启动命令/启动器路径（留空 = 自动定位内置 OneKey；Linux 走官方安装脚本）· OneKey 安装目录 · 快速登录 QQ · WebUI 登录 token；另有「VBS 隐藏启动器」信息卡（显示两份 VBS 的绝对路径与当前快速登录账号）。
- **Bridge**：启动命令（默认 `node src/bridge.js`）· 工作目录 · WebUI 端口（默认 3100）。
- 通用操作：启动 / 停止、看日志（最多 200 行）、保存配置；「实例信息」显示 URL / PID / 端口。

### 7.3 SSH 配置 SSHConfig

- 服务器**先列表后添加**；表单：名称 / 主机 / 端口 / 用户名 / 认证方式（密码或密钥+口令）/ 远程端口（默认 6099、3000、3080、3100）。
- 每行操作：`测试` / `配置` / `部署`（一键克隆整套）/ `同步` / `清整套` / `连接`（建隧道）/ `断开` / 删除。
- 测试失败时会：把 ssh2 的认证证据翻译成人话 + 给出「上次成功用的是 X 端口」的纠偏提示 + fail2ban 提醒（**别连着点测试**）。
- **一键克隆整套**面板：选复刻源（**默认本机**，或另一台装好的服务器）+ 是否「连同 QQ 登录令牌一起克隆（免重新扫码）」→ 开始复刻；下方浅底黑字日志框，刷新页面可恢复进行中任务的日志。
- **同步面板**：方向三选（本地→服务器 / 服务器→本地 / 双向 merge）+ 勾选（桥代码 / 记忆·会话数据 / 表情包文件夹），下方逐步显示每一步结果。

### 7.4 功能配置 BridgeConfig（核心页，五个页签）

顶部：GitHub 徽标（本仓库）·「请作者喝奶茶」·「群友画像」·「学习与用量」·「保存」；页签行右侧两个弹窗：「**指令速查**」「**说明文档**」。

**① 常用设置**（一功能一卡片，3 列栅格）：

| 卡片 | 关键项 |
|---|---|
| 模型与推理 | 服务商 · 主模型 · 识图模型 · 推理档位（**见下方"联动"**） |
| NapCat 连接 | OneBot HTTP/WS 地址、access token、启动器路径、是否允许进程控制 |
| 基础与会话 | agent preset、工作区标题、**主人 QQ**、管理员名单、收到消息后的应答语、发送延迟、提问超时 |
| 允许 / 拒绝名单 | 私聊与群聊白名单、黑名单 |
| 唤醒 · 潜水/活跃 | 默认模式、触发条件、遗忘/恢复策略 |
| 发送节奏与间隔 | 消息间隔、打字感、刷屏保护 |
| 上下文与轮换 | 上下文窗口、空闲轮换、自动归档 |
| 主动闲聊 | 开关、私聊/群聊概率、检查间隔上下限 |
| 等待：回复前的停顿 | 让机器人别秒回 |
| 表情包 | 收藏策略 + **上传表情包图库**（多选图片 → 存 `stickers-upload/` → 自动重启桥载入） |
| 静默群聊 | `/deepsleep` 的总开关与静默群列表 |
| 智能体开关与自动回复 | 总开关、自动回复检查间隔、是否提供建议 |
| 投递与回合 | 在途回合注入（steer）、回合保持 |
| 好友申请与信任 | 自动同意好友、信任的跨会话代发 uid |
| Word 文档额度 | `qq_send_docx` 的额度控制 |

**模型与推理的联动**（这一块的细节很容易被忽略，但很关键）：
- `服务商` 下拉 = 自动探测 / DeepSeek 官方 / 小米 MiMo / **DSH 里已配好的其它服务商**；
- **主模型 / 识图模型的下拉只列"当前服务商真实可用"的模型** —— 数据来自后端读取 DSH 自己的配置（隔离 home 的 `settings.yaml` 里 `llm-pi-ai.providers.<id>.models` + DSH 内置 provider 的默认模型表 + 出厂兜底）；
- **切换服务商时模型列表与主模型一起换**：新列表里没有当前模型就自动换成该服务商的默认值并给提示；清单外的模型可以点「自定义…」手输 id；
- **推理档位用的是真实英文档位 id**（`off / none / minimal / low / medium / high / xhigh / max`，也可自定义），旁边小字回显「DSH 当前生效：xxx」，空值 = 自动探测；
- 保存后若模型段有变化，会如实显示「已同步到隔离 DSH，约 15 秒后生效」或「未写入 DSH：<原因>」——不会无条件说「已保存」。

**② 工具与规则**：
- 上卡「QQ 工具开关」= 调用时是否被拒（**不省 token**）；
- 下卡「**工具 schema 精简**」= 改 `social.slimTools.enabled/deny`，被勾掉的工具**根本不注册给模型**，schema 从每次请求里消失 → **这是真省额度的一刀**；界面给出出厂默认名单（21 个）、按名字筛选、当前生效工具数/字符数/≈tokens（按 3.2 字符/token 估算），核心工具标红；卡片明确写了「**改完必须重启隔离 DSH**」，并提供「保存并重启（DSH / 桥 / 两者）」按钮。

**③ 人设与发言规则**：两张卡并排 —— `persona.md`（人设，出厂为空；可「上传载入」或「角色库导入」整包载入）与 `speech-rules.md`（发言规则，出厂带英文模板，「恢复默认」写回内置模板）。**人设优先于内置默认人设**；两者分开保存，头部「保存」会一并写。

**④ JSON 进阶**：直接编辑整份 `config.json`（保存时校验 JSON，格式错会提示）。

**⑤ 方案**：把整套 `config.json` 存成命名方案（名字 ≤40 字），每条显示摘要（模型·推理档位 / 智能体开关 / 静默 / 主动概率 / 名单数量）与时间，可「套用」「删除」（出厂方案不可删）；**参数完全相同的方案会自动复用、不重复新增**。方案存 `~/.qq-bridge-manager/profiles.json`，换浏览器/清缓存都不丢。

### 7.5 学习与用量 Learning

- 左卡「黑话 / 人格学习」：黑话定时学习（启用、定时时间、实时窗口提取、自动深入研究、自动间隔）、人格学习（启用、间隔、目标 QQ 列表）、群友画像学习块（启用、最少消息数、最多目标数、时间窗、自动刷新间隔与时刻）；动作按钮：保存配置 / 立即黑话学习 / 停止 / 人格立即学习 / 人格停止。
- 右卡「人格学习状态」：**只读**，每 60 秒轮询，逐人显示进度、样本数、最近学习时间与摘要。
- **用量面板**（数据源 `/api/learning/token-report`，优先 **SSE 实时推流**，连续失败 2 次自动退回 60 秒轮询）：
  - 三张数字卡：今日已用 token（= 计费日口径的 `billedTotal`）· 今日预计（按当前速率外推）· 近 N 日日均；
  - **口径写在卡片上**：一次请求的真实用量 = 未命中输入 + 缓存命中 + 输出，**不要用提供方返回的 `total_tokens`**（那是会话累计快照，逐条累加会虚高几倍）；日界按**计费日**（默认北京 08:00 换日，可用环境变量改，设 0 回退自然日），并**并列显示自然日合计**（两者在 00:00~08:00 段必然不同）；
  - 图表：近 7 日曲线（内联 SVG）+ 今日按北京小时的迷你柱；
  - **实测计量块**：缓存命中率（只用带缓存字段的请求算）、今日/本月费用、谷时与高峰对比；
  - **费用预算块**：按"假设口径"独立计算（假设缓存命中率、各档单价、高峰倍数），参数存浏览器本地。

### 7.6 群友画像 GroupPortrait

- 头部：只显核心 / 显示全部人、隐藏/显示弱关系、重新布局、刷新；工具条：选择群聊、快速定位（昵称或 QQ）、「自动刷新画像」开关与间隔天数。
- **主人画像卡**：姓名、生日、人格样本数、爱好、性格、标签、档案摘要。
- **群友关系图**：零依赖的**球面力导向网络**（`NetCanvas.tsx`）—— 默认全员平等贴在球壳上，给了中心人物就把主人公固定在球心、其余环绕；拖拽转球、点击一个人聚焦；**强弱关系用弹簧目标距离区分**（强关系拉近、弱关系停在"中性距离"），所以「显示弱关系」不会挤成一团；缩放固定（滚轮不再缩放）。
- **聚焦弹层**：左栏档案（标签、生日、性格、爱好、摘要、近 30 天发言数、最近活跃时间、可展开「Ta 发过的消息」）；点边显示互动强度百分比（并翻译成一句人话）+ 可给关系打 5 类标签（群友 / 闺蜜 / 家人 / 情侣 / 仇人）；右栏是该人的个人关系网（Ego 图）。

### 7.7 内嵌官方界面 WebView

顶部条：返回 · 标题 · 当前 URL · 「令牌自动跟随」状态 · 「重新鉴权」· 「新窗口」。因为 DSH 重启会换 token，这里挂载时对齐一次、之后**每 3 秒**按端口找回"最新入口地址"，**只有令牌变了才重新挂载**，所以不会打断你正在看的界面。

---

## 八、管理端 HTTP API

后端 `server/index.js`（只监听 `127.0.0.1`，默认 `1921`）。生产模式下同一端口还托管前端 `dist/`（含 SPA 回退：除 `/api/*` 外全部交给前端路由）。

### 8.1 配置 / 状态 / 打开界面

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/config` | 读管理器配置（含 `connected`、`activeServer`） |
| POST | `/api/config` | **局部合并**写配置（servers / activeServerId / local / 三个 instances） |
| GET | `/api/state` | 实时状态：模式、服务可达性、活动隧道、三个实例的 `phase/proc/note/error/loggedIn/adopted`，以及安装位置体检 `warnings` |
| GET | `/api/open?target=…` | 跳转前探活，返回官方界面 URL（`target` = `napcat-webui` / `napcat-http` / `dsh-web` / `bridge`） |
| GET | `/api/napcat/launchers` | 定位 NapCat OneKey 目录并**生成/刷新两份隐藏启动 VBS**，回传路径与快速登录账号 |
| GET | `/api/instance/:id/logs?tail=N` | 实例日志尾部（≤2000 行；逐行先按 UTF-8 再退 GBK 解码——NapCat 输出常是 GBK） |

### 8.2 实例生命周期

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/instance/:id/:action` | `start`（立刻回 `starting`，后台推进）/ `stop` / `restart`（先停干净再启） |
| POST | `/api/instance/start-all` | 一键整套：NapCat → DSH → 桥，**每步等真正就绪**；逐步返回 `steps[{id,success,phase,elapsedMs,message,note,error}]` |

### 8.3 SSH 连接 / 隧道 / 同步 / 清理

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/ssh/test` | 测试连接；端口填错时用 `lastGoodPort` 自动纠偏；失败时把 ssh2 的 `USERAUTH_FAILURE` 证据翻译成可执行建议 |
| POST | `/api/ssh/connect` | 建立 SSH 连接 + 4 条隧道，写 `activeServerId` |
| POST | `/api/ssh/disconnect` | 断开连接、关隧道、清缓存 |
| POST | `/api/ssh/sync` | 桥代码/数据同步：`to-server` / `to-local` / `merge`，按 `flags{code,state,stickers}` 勾选，返回逐步 `steps[]` |
| POST | `/api/ssh/remove-stack` | 「清整套」：停桥、停用 dsh 服务、删 napcat 容器，把远端目录**移动到回收目录**（需 `confirm:'remove-stack'`） |

### 8.4 远程一键克隆部署

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/ssh/deploy/start` | 发起克隆：源 = 另一台已装好的服务器，或 `{sourceKind:'local'}`（**从本机复刻**）；返回 `taskId` |
| GET | `/api/ssh/deploy/status?taskId=` | 查任务状态与日志行（任务保留 1 小时） |
| GET | `/api/ssh/deploy/tasks` | 列出最近 20 个仍可查询的任务 |

### 8.5 桥配置 / 人设 / 角色库 / 表情包 / 方案

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/bridge/config` | 读桥 `config.json` + `persona.md` + `speech-rules.md` + `roles/` 列表 + `dshEffective`（DSH 实际生效的 provider/model/effort）+ `dshModels`（各服务商真实可用模型） |
| POST | `/api/bridge/config` | **深合并**写 `config.json`；人设/发言规则传空 = 删文件；`dsh` 段变化时写隔离 DSH 的 `settings.yaml` 并后台重启 DSH |
| POST | `/api/bridge/speech-reset` | 写回内置默认发言规则模板并返回全文 |
| GET | `/api/bridge/characters` | 扫描角色库（`<root>/<slug>/manifest.json` + 维度 md） |
| POST | `/api/bridge/characters/import` | 把角色包组装成 persona；`apply=true` 时写 `persona.md`（并留备份） |
| POST | `/api/bridge/upload` | 上传人设 md / SKILL zip 到 `roles/` |
| POST | `/api/bridge/stickers/upload` | 上传表情图库（图片落 `stickers-upload/`、写 `state/stickers.json`），随后**重启桥**载入 |
| GET / POST | `/api/profiles` | 列 / 存配置方案（参数完全相同则**复用**且返回 `existed`；上限 50 条） |
| POST | `/api/profiles/:id/delete` | 删方案（出厂方案不可删） |

### 8.6 学习 / 用量 / 画像（代理到"当前活动桥"）

这些接口会把请求转发给**当前活动的桥控制台**（远端优先：已连服务器且隧道在 → `127.0.0.1:13100`；否则本机 `127.0.0.1:3100`），鉴权用桥的 `consoleToken`。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET / POST | `/api/learning/config` | 读写学习配置 |
| POST | `/api/learning/slang` | 黑话学习 `learn` / `stop` |
| POST | `/api/learning/persona` | 人格学习 `start` / `stop` / `status` |
| POST | `/api/learning/portrait` | 群友画像学习 `start` / `stop` / `status` |
| GET | `/api/learning/token-report` | 用量报表 |
| GET | `/api/learning/token-stream` | **SSE** 实时用量（原样透传桥的推流） |
| GET | `/api/learning/graph` | **直读本机桥的 `memory.db`（只读）**：节点 = 档案全量 + 近 30 天出现过的发言人；边 = 近 14 天群聊同现 + 近 30 天私聊互动，强度做对数压缩 |
| GET | `/api/learning/owner-profile` | 直读 `memory.db` 拼主人档案（字段、标签、近 30 天记忆词频、人设摘要） |
| GET | `/api/learning/messages` | 某人最近发过的消息 |
| GET | `/api/learning/groups` | 群列表 + 群成员（近 90 天，按发言数排序） |
| GET / PUT | `/api/learning/portrait-config` | 画像自动刷新设置（启用 + 间隔天数） |
| GET / PUT | `/api/learning/relations` | 关系标注（5 类颜色标签，存 `relations.json`） |

### 8.7 守卫 / 关停

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/guardian/arm` | 手工（重新）武装守卫；会**校验 PID 的进程名必须是 MoonBot**，否则拒绝（绝不把来路不明的进程当成"应用"） |
| POST | `/api/shutdown` | 体面收摊：默认只收 NapCat；`{all:true}`（Electron 关窗用的就是这个）连桥与隔离 DSH 一起收 |

**稳定性护栏**：`unhandledRejection` / `uncaughtException` 全部被拦下写 `manager.log`，**不让管理器死** —— 否则界面打不开、状态机停摆（历史上真发生过：一次部署异常把管理器带崩）。

---

## 九、QQ 桥接层（能力详解）

桥接层（`qq-bridge/`）是整台机器人的"躯干"：它把 QQ 消息变成 agent 的一次唤醒，把 agent 的回复与工具调用变回 QQ 里的动作。

### 9.1 唤醒协议：什么情况下机器人"醒"

每条消息进来都要先过一次唤醒判定（`core/mux.js` + `core/social-flow.js`），只有判定为"该醒"才会真正调用模型（不醒的消息仍然入库，作为上下文与学习素材）。**判断规则写在系统提示词的 `[WAKE TYPES]` 段落里**（改行为改那里），代码只负责给出 reason。

| 唤醒原因（`[Wake <reason>]`） | 触发条件（简述） |
|---|---|
| `bootstrap` | **新会话首次连接**：注入完整提示词（preset + 人设）与最近消息窗口（首轮还会带 `[Guide]`） |
| `private` | **私聊消息**（主人私聊还会带 `[OWNER]` 标记） |
| `atMention` | 群里被 **@** 或消息引用了机器人 |
| `question` | 消息在**直接提问** |
| `nameMention` | 消息里**点了名字**（昵称/别名命中） |
| `keyword` | 命中配置的**触发关键词** |
| `speaker` | 正常发言（"够像在跟你说话"的一类） |
| `poke` | 被**戳一戳** |
| `probability` | **概率唤醒**：按配置概率主动开口 |
| `proactiveCheck` | **系统给的开场**：没人先说话，给它一次主动闲聊的机会 |
| `replyCheck` | **回复后的兜底复查**：对方又补了一句、或要不要再说一句 |
| `timeout` | **潜水到期**：睡够了，回来看消息 |

> `[Wake x]` 里的 `x` 就是上表的 reason（内部 `reason.split(':')[0]`）；无工具兜底版会把 `atMention` 显示成 `@`、
> `proactiveCheck` 显示成 `proactive`。

**注入只带数据，规则写在 preset**（这是这一版刻意做的分层）：
- 唤醒时注入的正文是**数据形态**的短行，例如 `[Token] <会话令牌> [Wake <类型>] [Unread N] <发送者>: <内容>`；
- "收到这种注入该怎么表现"写在 preset 的 `[WAKE TYPES]` 段落里 —— 所以改行为改 preset，而不是让每一轮注入都背一遍规则文本（**注入体因此从数 KB 降到几百字符**，省的是每一步都要重发的额度）；
- `[Mid-turn]` = 你正在"说话"的回合里又来了新消息（桥会把它插进在途回合，见 9.4 的"回合保持/在途注入"）；
- `[OWNER]` = 这条消息来自主人私聊（行为式标记，取代了早期"写死主人 QQ"的判定）；
- 状态/未读/活动时段等都以"数据 + 一行说明"的形式跟随，不重复规则文案。

保护机制：同一个群/人会去重与冷却（避免连环唤醒）、消息批处理（连发多条只注入一次）、单实例锁（不会出现两个桥同时连 NapCat）、失败退避（模型/DSH 不可用时不会疯狂重试）。

### 9.2 人设与规则的**分层**（这一层最容易用错）

| 层 | 存放位置 | 谁改 | 什么时候生效 |
|---|---|---|---|
| **规则层**（安全、工具用法、唤醒协议、行为规范、回复格式） | preset：`qq-bridge/dsh/agent-presets/default/agent.cordis.yml` | 改文件 | **重启桥**（桥启动时把 preset 刷进隔离 DSH home） |
| **人设层**（角色卡：身份、性格、说话风格、对主人的相处方式） | 上传的 `persona.md`，以 `[PERSONA]` 段注入 | 管理端「人设与发言规则」上传/粘贴 | **下一条消息即生效**（桥比对文件版本号，自动重新注入完整 prompt） |
| **发言风格层**（口癖、语气、禁止项） | `speech-rules.md`，以 `[SPEECH RULES]` 段注入 | 管理端同上 | 同上 |

- **人设优先于内置默认人设**：没上传人设时用 preset 里的默认人设（出厂是一句通用助手设定，不带任何角色名）；
- 人设可以**自己写规矩**（"不要用颜文字""回复必须短"之类），它们会随 `[PERSONA]` 一起进上下文；`[SPEECH RULES]` 在"说话风格"上优先级最高；
- 注入有长度上限（人设 16000 字符、发言规则 6000 字符），超了会截断并提醒；
- 角色库（`qq-bridge/characters/`）里可以放现成的角色包，管理端「角色库导入」会把整包组装成 persona。

### 9.3 学习能力

| 能力 | 做什么 | 怎么触发 | 数据落在 |
|---|---|---|---|
| **黑话学习**（`slang.js` / `slang-learner.js`） | 从群聊里提取高频陌生词、归纳释义，之后模型能用 `qq_slang_query` 查到 | 定时（管理端可配时刻/间隔）、`/slang 学习`、或桥在对话中自动提取候选 | `state/slang.json` |
| **人格学习**（`persona-learn.js`） | 按目标 QQ 读历史聊天，整理成一份**给模型看的人格档案** | 管理端「人格学习」或 `qq_persona_learn_*` | `state/persona-library.json`、`memory.db` |
| **群友画像学习**（`portrait-learn.js`） | 批量刷新群友档案（昵称/别名/性格/爱好/生日…） | 管理端「群友画像 → 自动刷新」、`/portrait learn` | `memory.db`（profiles 表） |

三者都有"失败不推进水位 + 退避"的保护：整批失败会退避一段时间再试，不会把额度烧干净（历史上有一次学习任务超时，现在 300 秒即超时并保留已有结果）。

### 9.4 社交行为

- **潜水 / 活跃**：默认潜水（只在被 @、被点名、被提问、被戳时出来），可对单个会话切"全天活跃"；活动时段（`state/activity-windows.json`）决定"这个群现在该不该活跃"，每一次唤醒都会跟随一行活动时段数据。
- **主动闲聊**：按概率在没有触发条件时主动开口（私聊/群聊分开配置概率与检查间隔）——**"老是空唤醒"就是这个概率**，把概率调小或设 0 即可。
- **回合保持（turn-hold）**：你连发几条消息时，桥会判断"这一回合还没结束"，把新消息**塞进在途回合**而不是重新开一轮；插件 `dsh-qq-hold` 负责让在途回合不被打断。
- **在途注入（steer）**：新消息可以即时注入到正在思考的回合里（`[Mid-turn]`），避免"每来一条就重开一轮"的浪费。
- **跨会话**：机器人知道自己有多个会话（不同群/私聊是不同上下文），可以读别的会话、也可以受信任代发（白名单限制在 `social.trustedCrossSessionUids`）。
- **发送节奏**：出站消息有间隔与"打字感"控制、失败重试、长文本切分，避免刷屏与被风控。
- **调度器**：定时/预约消息（`qq_schedule_*`）、活动时段切换、休眠恢复都由它统一管。
- **会话归档**：空闲会话会自动归档（默认每 10 分钟巡检、闲置超 30 分钟归档），下次唤醒再按需恢复上下文。

### 9.5 消息与媒体

- 出站：长文本切分、`@`、引用回复、markdown → 纯文本降级、CQ 码与纯文本两种形态自动选择；
- 图片：单边超过 4096px 或超过 5MB 会**自动缩放重压**（内置纯 JS 编解码，不依赖 sharp 之类原生模块）；
- 语音/视频/文件：走 NapCat 的能力读取与转发，转发（含合并转发）在入站时会**就地展开**，模型不用额外调工具就能看到"转发里到底说了什么"；
- 表情：`state/stickers.json` 管理收藏、贴纸备注；随包表情库（`meme/`）可用 `qq_whale_meme_search` 搜索后发送。

### 9.6 桥的运行时数据

见 [十三、数据与日志](#十三数据与日志)。要点：**SQLite 用 Node 内置 `node:sqlite`，没有任何原生编译依赖**；所有数据都在本地 `state/` 下，管理端只以**只读**方式打开 `memory.db` 做画像/用量展示。

---

## 十、MCP 工具清单

桥通过 MCP 把 QQ 能力暴露给 agent，**共注册 84 个工具**，分三个文件：
`mcp-napcat-safe.js` **77 个**（QQ / NapCat 能力，就是"省额度"里说的那批）、
`mcp-host-server.js` **5 个**（`qq_learning_corpus` / `qq_learning_submit` + `napcat_status` / `start_napcat` / `stop_napcat`，
后三个需要显式开启进程控制，**默认关闭**）、`mcp-web-search-safe.js` **2 个**（`web_search` / `web_fetch`）。

> 想省额度：这些工具的 JSON schema 会**每一步请求都重发一遍**，占单次请求体积的大头。用「工具与规则 → 工具 schema 精简」把不用的工具**不注册**即可（比"开关"有效——开关只是调用时拒绝，schema 照发）。

### 10.1 消息读取与会话（13）

| 工具 | 作用 |
|---|---|
| `qq_get_recent_messages` | 读某会话最近的消息 |
| `qq_get_unread_messages` | 读未读消息 |
| `qq_mark_read` | 标记已读（把这条消息从"未读"里消掉） |
| `qq_get_message_detail` | 取某条消息的详情 |
| `qq_get_message_images` | 取某条消息里的图片 |
| `qq_get_my_recent_messages` | 读"我"最近发过的消息 |
| `qq_get_forward_msg` | 展开合并转发（聊天记录）的内容 |
| `qq_get_file_content` | 读收到的文件内容 |
| `qq_get_group_history` | 群历史消息 |
| `qq_history_clear` / `qq_history_delete` | 清理/删除历史记录 |
| `qq_wait_for_messages` | **长轮询等待新消息**（潜水前的"睡一会儿"，有人说话就醒） |
| `qq_get_prompt` | 取当前会话的提示词（调试用） |

### 10.2 发送与互动（13）

| 工具 | 作用 |
|---|---|
| `qq_send_message` | 通用发送（按会话 key 自动判断群/私聊） |
| `qq_send_group_message` / `qq_send_private_message` | 明确指定群 / 私聊发送 |
| `qq_reply` | 引用回复某条消息 |
| `qq_send_burst` | 连发多条（模拟"想到什么说什么"） |
| `qq_send_poke` | 戳一戳 |
| `qq_send_rich` | 富文本（图文组合等） |
| `qq_send_forward` | 发合并转发 |
| `qq_send_docx` | 发 Word 文档（有额度控制） |
| `qq_send_qq_face` | 发 QQ 自带表情（小黄脸） |
| `qq_send_sticker` | 发收藏的表情图 |
| `qq_withdraw_message` | 撤回自己发的消息 |
| `qq_proactive_send` | 主动开口（不等被 @） |

### 10.3 表情 / 图片 / 音乐（10）

| 工具 | 作用 |
|---|---|
| `qq_list_stickers` | 列出收藏的表情 |
| `qq_collect_sticker` | 收藏一张表情 |
| `qq_get_sticker_image` | 取表情图片文件 |
| `qq_sticker_note` / `qq_set_sticker_remark` | 给表情写备注/标签 |
| `qq_face_list` | QQ 表情对照表 |
| `qq_get_self_image` | 取自己的头像 |
| `qq_whale_meme_search` / `qq_send_whale_meme` | 搜索/发送随包表情库（`meme/` 下的图库） |
| `qq_music_search` | 点歌检索（配合随包的签名代理） |

### 10.4 群与成员（5）

| 工具 | 作用 |
|---|---|
| `qq_list_groups` | 我所在的群列表 |
| `qq_get_group_members` | 群成员列表（含角色、昵称） |
| `qq_get_group_owner` | 查群主/管理员 |
| `qq_get_active_members` | 近期活跃成员 |
| `qq_remove_friend` | 删好友 |

### 10.5 记忆与画像（7）

| 工具 | 作用 |
|---|---|
| `qq_memory_append` | 追加一条记忆 |
| `qq_memory_search` | 语义/关键词检索记忆 |
| `qq_memory_query` | 查询记忆条目 |
| `qq_memory_remove` / `qq_memory_clear` | 删除/清空记忆 |
| `qq_profile_get` / `qq_profile_set` | 读/写群友档案（昵称、别名、性格、爱好、生日…） |

### 10.6 社交状态与行为（12）

| 工具 | 作用 |
|---|---|
| `qq_social_state` | 读会话社交状态（模式、未读、令牌…） |
| `qq_global_overview` | 全局概览（有哪些会话、各自状态） |
| `qq_get_system_config` / `qq_set_system_config` | 读/改运行参数（如主动概率、间隔） |
| `qq_set_wake_config` | 改唤醒策略 |
| `qq_get_activity_hours` / `qq_set_activity_hours` | 读/改**活动时段**（按群） |
| `qq_admin_set` | 设置/取消管理员 |
| `qq_whitelist` / `qq_blacklist` | 白名单/黑名单维护 |
| `qq_like` | 给某人点赞 |
| `qq_report_feedback` | 记录用户反馈（用于后续学习） |

### 10.7 学习（7）

| 工具 | 作用 |
|---|---|
| `qq_learning_submit` / `qq_learning_corpus` | 提交学习样本 / 取语料 |
| `qq_slang_query` / `qq_slang_submit` | 查黑话 / 提交新黑话 |
| `qq_persona_learn_start` / `qq_persona_learn_status` / `qq_persona_learn_stop` | 人格学习：开始 / 查状态 / 停止 |

### 10.8 跨会话 / QQ 空间 / 定时 / 其它（12）

| 工具 | 作用 |
|---|---|
| `qq_crosschat_inbox` / `qq_crosschat_send` | 跨会话收件箱 / 跨会话代发（受信任名单限制） |
| `qq_qzone_view` / `qq_qzone_like` / `qq_qzone_comment` / `qq_qzone_reply_comment` / `qq_send_qzone` | QQ 空间：看/点赞/评论/回复评论/发说说 |
| `qq_schedule_message` / `qq_schedule_list` / `qq_schedule_cancel` | 定时/预约消息：定、列、取消 |
| `qq_deepsleep` | 全体静默（只静默群聊，私聊照常） |
| `qq_status` | 桥与 QQ 的当前状态（在线、昵称、QQ 号） |

### 10.9 联网与宿主（5）

| 工具 | 作用 |
|---|---|
| `web_search` / `web_fetch` | 联网搜索 / 抓网页正文（安全封装） |
| `napcat_status` | NapCat 与 OneBot 网关状态 |
| `start_napcat` / `stop_napcat` | 启动/停止 NapCat（**需要显式开启进程控制**，默认关闭；启动走隐藏方式，不弹窗口） |

**权限边界**：管理类工具（改配置、静默、清记忆、加管理员…）在**主人私聊**会话才放行；其它会话的写操作会被拒。桥还会校验会话令牌，工具结果里的密钥形态会被遮挡后才交给模型。

---

## 十一、命令速查

在**私聊或群里直接发一条以 `/` 开头的消息**即可（管理类命令只有**主人 QQ** 生效，非主人发 `/` 会收到「管理命令仅管理员可用」）。
管理端「功能配置 → 指令速查」弹窗里有同一份清单。

### 会话管理

| 命令 | 作用 |
|---|---|
| `/reset` 或 `/new` | 重置当前会话上下文（顺手取消该会话还没发出去的排队任务），下一条消息开新上下文 |
| `/status` | 看当前会话状态：会话 id、白名单是否通过、当前角色、当前模式 |

### 睡眠 / 静默 / 唤醒

| 命令 | 作用 |
|---|---|
| `/sleep` | **全程静默**：不调用模型、不回复，但进程不结束（私聊也不回） |
| `/wake` | 从 `/sleep` 恢复 |
| `/deepsleep`（也可直接发 `deepsleep`） | **静默所有群聊**（只静默群：不醒、不回、不收集；**私聊照常**） |
| `/start`（或 `start`） | 解除 `/deepsleep`，群聊恢复正常（桥**直接执行**，不经过模型） |
| `/silent` 或 `/quiet` | 本会话转静默：群聊只悄悄看、不再回应（被 @ 也不回） |
| `/active` 或 `/speak` | 恢复开麦 |

### 模式与作息

| 命令 | 作用 |
|---|---|
| `/set mode active`（或 `/set mode 活跃`） | 本会话转**全天活跃**（同时清掉该会话的活跃时段约束） |
| `/set mode diving`（或 `/set mode 潜水`） | 转**潜水**：平时不打扰，被 @ / 被点名 / 被提问才出来；私聊随叫随到 |
| `/set sleep 01:00-06:00` | 设置**作息时段**（北京时间）：窗口内群聊只回 @，其余不读省额度；私聊不受限 |
| `/set sleep 30m` / `/set sleep 2h` | **定时休息**：这么久之后自动醒 |
| `/set wake` 或 `/set cancel` | 取消休息/作息，立刻恢复 |

### 角色与权限

| 命令 | 作用 |
|---|---|
| `/role <角色名>` | 切换到 `qq-bridge/roles/<角色名>.md` 里的角色卡 |
| `/role off` 或 `/role clear` | 清除角色，恢复默认人格 |
| `/op <QQ号或昵称>` | 把某人设为**管理员**（可用通讯录昵称） |
| `/op del <QQ号或昵称>` | 取消管理员 |

### 学习

| 命令 | 作用 |
|---|---|
| `/slang 学习`（旧写法 `/slanglearn`） | 立刻跑一次**黑话学习** |
| `/slang 停止`（旧写法 `/slangstop`） | 停止正在跑的黑话学习 |
| `/portrait learn` / `/portrait stop` / `/portrait status` （别名：`/群友画像学习`、`/画像学习`） | **群友画像学习**：开始 / 停止 / 查状态（仅主人可用） |

### 其它

| 命令 | 作用 |
|---|---|
| `/like <QQ号> [次数]` | 手动点赞（默认 1 次，最多 10 次） |
| 其它 `/xxx` | **原样交给 agent 执行**（例如 DSH 自己的命令），桥不拦截 |
| 不说斜杠 | 直接说人话也行 —— 这些命令只是"快捷方式"，日常聊天不需要记 |

> 说明：`/help`（曾经发一份能力概览文档）已经删除；现在发 `/help` 会按"其它 `/xxx`"交给模型正常回应。

---

## 十二、配置参考

管理端配置在 `%USERPROFILE%\.qq-bridge-manager\config.json`：

```jsonc
{
  "servers": [                    // SSH 远程服务器列表（远程部署用）
    {
      "id": "…", "name": "…", "host": "…", "port": 22, "username": "root",
      "authType": "password|key", "password": "", "privateKey": "", "passphrase": "",
      "remotePorts": { "napcatWebui": 6099, "napcatHttp": 3000, "dshWeb": 3080, "bridge": 3100 },
      "lastGoodPort": 0, "lastGoodAt": ""     // 记住最后一次连通的端口（SSH 端口经常不是 22）
    }
  ],
  "activeServerId": "",           // 当前选中的服务器；空 = 本机模式
  "local": {                      // 本机各服务的端口约定
    "napcatWebui": 6099, "napcatHttp": 3000, "dshWeb": 3210, "bridge": 3100
  },
  "instances": {                  // 三个受管实例
    "dshIsolated": {
      "enabled": true,            // 是否纳入自动启动
      "port": 10721,              // 隔离 DSH 端口
      "isolatedHome": "",         // 隔离 DSH_HOME（独立会话/凭据/预设，默认在 ~/.qq-bridge-manager 下）
      "profile": "web",           // DSH profile
      "dshCli": ""                // 自定义 dsh 入口（留空=自动探测）
    },
    "napcatLocal": {
      "enabled": true,
      "launchCommand": "",        // 自定义启动命令（留空=用内置 OneKey 隐藏启动器）
      "workDir": "", "installDir": "",   // NapCat 所在目录（留空=自动探测）
      "webuiPort": 6099, "webuiToken": "…",  // WebUI 端口与登录 token
      "quickLogin": ""            // 快速登录的 QQ 号
    },
    "bridgeLocal": {
      "enabled": true,
      "launchCommand": "node src/bridge.js",   // 桥的启动命令（相对 workstation 目录）
      "workDir": "", "webuiPort": 3100
    }
  }
}
```

桥接层自己的配置在 `<运行时>\qq-bridge\config.json`（**不进公开仓库**：里面有主人 QQ、群号、NapCat token）。
出厂模板见 `qq-bridge/config.example.json`，主要分区：

| 分区 | 内容 |
|---|---|
| `dsh` | 模型服务商 / 模型 id / 推理档位 / 桥与 DSH 的连接地址 |
| `napcat` | OneBot 的 HTTP/WS 地址、access token、NapCat 启动器路径、是否允许进程控制 |
| `ownerQQ` | 主人 QQ（特权私聊会话的判定依据；出厂模板为 `0`） |
| `allow` / `deny` | 私聊与群聊白名单、黑名单 |
| `social` | 社交行为：潜水/活跃、主动闲聊概率与检查间隔、活动时段、回合保持、跨会话、发送节奏、表情包收藏 |
| `slimTools` | 工具精简名单（只注册需要的 MCP 工具，省 token —— 工具 schema 是单次请求体积的大头） |

---

## 十三、数据与日志

### 13.1 桥接层的 `state/`（机器人"记忆"都在这）

| 文件 | 内容 | 敏感 |
|---|---|---|
| `memory.db` | SQLite：群友画像、记忆条目、聊天记录（含撤回/已读标记） | ⚠️ 含聊天记录与 QQ 号 |
| `social-state.json` | 每个会话的状态：模式、未读、已答消息 id、会话令牌、跨会话设置 | ⚠️ |
| `sessions.json` | QQ 会话 ↔ DSH 会话 的映射 | ⚠️ |
| `token-usage.jsonl` | 每次调用的 token 用量（用量面板与成本估算的数据源） | 低 |
| `tool-calls.jsonl` | 工具调用轨迹（哪个会话调了什么工具、参数摘要） | 中 |
| `activity-windows.json` | 每个群的活跃时段（分钟数窗口） | 低 |
| `stickers.json` / `slang.json` / `crosschat.json` | 贴纸收藏、黑话词条、跨会话记忆 | 中 |
| `persona-library.json` / `persona-agent.json` | 人设学习结果 / 当前生效人设版本 | 中 |
| `learning-config.json` / `session-archive.json` / `dsh-seq.json` | 学习开关、会话归档、DSH 序号 | 低 |
| `bridge.log` / `qq-activity.log` / `dsh-qq-hold.log` / `qq-mode-plugin.log` | 桥与插件日志（UTF-8） | 中 |

### 13.2 管理端日志

`%USERPROFILE%\.qq-bridge-manager\logs\`：`manager.log`（后端）、`dsh-isolated.log`、`bridge-local.log`、
`napcat-local.log`、`napcat-guardian.log`（守卫启动/收摊记录）。

### 13.3 隔离 DSH 的数据

`%USERPROFILE%\.qq-bridge-manager\dsh-isolated-home-<profile>\`：`sessions/`（每个 QQ 会话的转录）、
`profiles/`、`.agent-presets/`（桥启动时刷入的 preset）、`.credentials.yaml`（模型密钥）、`plugins/`。

---

## 十四、日常运维

```powershell
# ① 改完源码 → 同步到"活体运行时 + 各打包 payload"，并核对哈希（必须看到 DONE）
powershell -File tools\sync-to-live.ps1

# ② 只重启管理端（只杀 server/index.js，不带 /T；三个实例会被探活认回）
powershell -File tools\restart-manager.ps1

# ③ 重启桥 / 隔离 DSH（改了桥代码或 preset 后必须重启桥）
Invoke-WebRequest -Uri 'http://127.0.0.1:1921/api/instance/bridge-local/restart' -Method POST
Invoke-WebRequest -Uri 'http://127.0.0.1:1921/api/instance/dsh-isolated/restart'  -Method POST

# ④ 只读体检（端口 / NapCat 进程 / 守卫状态 / 硬链接）
powershell -File tools\diag-napcat-guard.ps1
```

**什么时候要重启什么**（这张表很省事）：

| 改了什么 | 要重启什么 |
|---|---|
| 桥接层代码（`qq-bridge/src/**`） | 重启桥 |
| agent preset（`qq-bridge/dsh/agent-presets/**`） | 重启桥（桥启动时会把 preset 刷进隔离 DSH home） |
| 人设 / 发言规则文件 | **无需重启**（桥比对文件版本号，下一条消息自动重新注入） |
| 管理端后端（`server/*.js`） | 重启管理端 |
| 管理端前端（`src/**`） | `npm run build` → `sync-to-live.ps1` → 刷新页面（要出包则再加一步重打包） |
| 打包壳（`main.js`） | 重打包 |

---

## 十五、开发与打包

### 15.1 回归套件（都在仓库里，直接跑）

```powershell
# 管理端（在仓库根）
node tools\test-napcat-guardian.mjs        # 守卫行为（含"活过 taskkill /T"）
node tools\test-guardian-arming.mjs        # 守卫武装（隔离假安装树）
node tools\test-guardian-hidden-window.mjs # 拉起守卫不许弹可见控制台窗口
node tools\test-provider-models.mjs        # 服务商 → 模型清单解析
node tools\test-any-drive-startup.mjs      # 装到任意盘/错误 cwd 也能启动
node tools\test-target-env.mjs             # 目标机环境自愈
node tools\test-local-clone-pack.mjs       # 本机复刻打包

# 桥接层（在 qq-bridge 目录，需要它的 node_modules）
node tools\test-wake-protocol.mjs          # 唤醒协议 + 人设注入
node tools\test-slash-commands.mjs         # 斜杠命令
node tools\test-steer-batch.mjs            # 连发消息批处理注入
node tools\test-steer-gate.mjs             # 注入闸门
node tools\test-config-hotreload.mjs       # 配置热加载
node tools\test-napcat-startup-retry.mjs   # NapCat 首连重试
node tools\test-qq-hold.mjs                # 回合保持插件
```

### 15.2 打包

打包工程在**同级目录** `..\QQ-Bridge-packaging\`（不进本仓库）：

```powershell
cd ..\QQ-Bridge-packaging\moonbot-app

# 完整版（管理端 + 桥 + DSH + NapCat），产物发布到 ..\MoonBot Public\release\
node ..\tools\build-moonbot-app.mjs full      # 约 6~10 分钟，822 MB

# 仅管理端（轻量）
node ..\tools\build-moonbot-app.mjs core

# 出包后逐项验真（含"安装包里的 UI bundle == 源码 dist"这条断言）
node ..\tools\verify-installer-content.ps1
```

**出包流水线（顺序不能乱）**：

```
改代码 → npm run build（UI） → tools\sync-to-live.ps1（看到 DONE）
      → build-moonbot-app.mjs full（构建前自动脱敏 payload：清主人 QQ/群号/state、token 置占位）
      → verify-installer-content.ps1（14 项断言，含脱敏复核与 UI bundle 一致性）
```

> ⚠️ UI 改完**必须**先 `sync-to-live` 再出包 —— 校验脚本会断言「安装包里的 bundle == 源码 `dist`」，
> 顺序颠倒就会 FAIL。

---

## 十六、常见问题与坑

**Q：装哪个盘都行吗？**
可以。后端所有内部路径都由**自身文件位置**推导（不再依赖"当前工作目录"），所以从资源管理器双击、
旧快捷方式、计划任务拉起都不会错位。但**数据落在安装目录内**，所以别装 `C:\Program Files`、别装同步盘。

**Q：为什么以前开机时会弹一个黑色 cmd 窗口？**
那是"守卫进程"被 WMI 拉起时，Windows 给它新分配了一个**可见**的控制台窗口。现在已修：
守卫改用 `Win32_ProcessStartup.ShowWindow=0` 隐藏启动；另外所有"父进程没有控制台"的 `spawn` 一律带
`windowsHide`。回归 `test-guardian-hidden-window.mjs` 会盯着这条不被打回去。

**Q：改了代码但界面/机器人没变化？**
按「14 章的重启表」处理。最常见的两个原因：① 只改了源码没跑 `sync-to-live.ps1`（活体运行时读的是它的副本）；
② 改了 preset 没重启桥（preset 是桥启动时刷进去的）。

**Q：`sync-to-live.ps1` 看起来跑了但前端还是旧的？**
这个脚本必须看到 **`DONE`** 才算成功：删旧 `assets` 时如果旧 bundle 正被管理端占用会抛错中止，
前半段却已经拷完 —— 这种"看起来同步过了"最坑人。

**Q：机器人不回消息？**
依次看：桥日志（`state\bridge.log`，UTF-8）、管理端实例状态是否 `running`、DSH 是否就绪、
NapCat 是否在线（WebUI 能看到登录态）。管理端首页的实例卡片会给出每个实例的真实探活结果与失败原因。

**Q：远程服务器部署失败？**
先用 `tools\probe-ssh-banner.mjs <host> <port>` 零成本确认端口是否真的开着（只读 banner，不会触发封禁）；
SSH 端口经常不是 22，管理端会记住"最后一次连通的端口"。目标机不需要预装 Node —— 部署阶段会自动检测并安装
node/npm（必要时还会补 docker）。

**Q：想换个模型 / 换服务商？**
管理端模型卡片里切服务商即可，**模型列表会自动跟着换**（列表是从 DSH 自己的配置里读的，不是写死的）；
推理档位用真实档位 id（off/minimal/low/medium/high/xhigh/max），旁边会显示"DSH 当前生效"的值。

---

## 十七、隐私与安全

- **本仓库是公开仓库**：示例配置里不含任何真实 QQ 号、群号、服务器地址或 token；工具示例统一用 `<QQ号>`/`<群号>` 占位。
- **不要把你自己的 `config.json`、`persona.md`、`roles/`、`state/` 提交上来** —— 它们包含聊天记录与个人信息，
  本仓库的 `.gitignore` 已经默认排除。
- **运行时数据默认留在本机**：桥的记忆库/聊天记录/用量都在本机 `state/`，隔离 DSH 的会话转录也在本机 `DSH_HOME`；
  只有"发给模型服务商的那部分上下文"会离开本机（这与直接用任何 LLM API 的隐私边界一致）。
- **凭据存储**：模型 API Key 存在隔离 DSH 的 `.credentials.yaml`；NapCat 的 WebUI/OneBot token 存在桥的 `config.json`。
  请不要把这些文件的截图或内容贴到 issue 里。
- **敏感内容闸门**：桥内置一层敏感内容过滤与"已知 token 泄露遮挡"（工具结果/日志里的密钥形态会被遮蔽）。

---

## 十八、致谢与许可

- **NapCat** — QQ NT 协议端（OneKey 便携版随包分发）：[NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ)
- **DeepSeek Harness (DSH)** — agent 运行时与官方 Web GUI：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- **MCP** — 模型上下文协议工具层：[@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- 界面主题 token 取自 NapCat 官方 WebUI 的 `nc_pink` 亮色主题（HeroUI Pink），标题字体 AaCute
- 表情包库 `meme/whale-fanart-001` 为同人作品集合，版权归原作者，仅供个人使用

本项目以 **MIT** 许可发布，见 [LICENSE](LICENSE)。
