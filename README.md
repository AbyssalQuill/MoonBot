# MoonBot

Windows 桌面应用，用于部署和管理 QQ 机器人。把 NapCat、QQ 桥接层、DeepSeek Harness 与模型服务商整合为一个可安装程序，提供图形化配置、进程编排、日志查看与远程部署。

<p>
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4">
  <img alt="electron" src="https://img.shields.io/badge/Electron-28-47848F">
  <img alt="node" src="https://img.shields.io/badge/Node-%E2%89%A5%2022.13-339933">
  <img alt="react" src="https://img.shields.io/badge/React-18-61DAFB">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
</p>

## 目录

- [简介](#简介)
- [功能](#功能)
- [架构](#架构)
- [目录结构](#目录结构)
- [安装](#安装)
- [使用](#使用)
- [聊天命令](#聊天命令)
- [配置](#配置)
- [数据与日志](#数据与日志)
- [HTTP API](#http-api)
- [MCP 工具](#mcp-工具)
- [唤醒机制](#唤醒机制)
- [运维](#运维)
- [开发与打包](#开发与打包)
- [常见问题](#常见问题)
- [隐私](#隐私)
- [许可](#许可)

## 简介

MoonBot 管理五个部件，负责安装、配置、拉起、探活、记录日志与停止。

| 部件 | 作用 | 界面 |
| --- | --- | --- |
| QQ 账号 | 机器人身份，扫码登录一次 | QQ 客户端 |
| NapCat | 内置便携版，把 QQ NT 转为 OneBot v11 服务端 | `http://127.0.0.1:6099` |
| qq-bridge | 桥接层，负责唤醒判定、提示词注入、人设、工具调用、发送链与学习 | `http://127.0.0.1:3100` |
| 隔离 DSH | DeepSeek Harness 实例，agent 运行时 | `http://127.0.0.1:10721` |
| 模型服务商 | 推理服务，支持 DeepSeek 官方、小米 MiMo 与任意 OpenAI 兼容端点 | 管理端模型卡片 |

## 功能

- 群聊与私聊对话，支持被 @、被点名、被提问、关键词、戳一戳、概率接话与主动闲聊等唤醒方式
- 人设与规则分层，规则固定在 preset，人设来自上传的角色卡，修改后下一条消息生效
- 群友画像、人格、黑话三类自动学习，黑话库可在管理端检索
- 表情包、贴纸、QQ 空间说说、定时消息、跨会话留言
- 潜水与活跃模式、活动时段、回合保持、连发合并
- Token 用量统计与费用估算，工具 schema 可按需精简
- SSH 远程部署，支持代码、数据、表情包与 config.json 分别同步
- 应用关闭时自动停止 NapCat、桥与隔离 DSH

## 架构

### 分层

```
用户（QQ 群 / 私聊）
        │ QQ 协议
NapCat  WebUI :6099  OneBot HTTP :3000  反向 WS :3001
        │ OneBot v11
qq-bridge  入口 src/bridge.js  控制台 :3100
        唤醒判定 → 提示词组装 → DSH 会话 → 工具调用 → 发送链 → QQ
        │ DSH HTTP API
隔离 DSH  独立 DSH_HOME  端口 :10721  profile=web
        preset 提供规则，桥注入 [PERSONA] 与 [SPEECH RULES]
        插件 dsh-qq-hold 与 qq-mode-console
        │ LLM API
模型服务商
```

管理端由 Electron 壳启动后端，后端监听 `127.0.0.1:1921`，托管前端静态文件并编排上述实例。

### 端口

| 端口 | 服务 | 用途 |
| --- | --- | --- |
| 1921 | 管理端后端 | HTTP API 与前端静态托管，可用 `QBM_API_PORT` 覆盖 |
| 5173 | Vite 开发服务器 | 仅开发模式 |
| 6099 | NapCat | 官方 WebUI，扫码登录与 OneBot 配置 |
| 3000 | NapCat | OneBot HTTP 动作接口 |
| 3001 | NapCat | OneBot 反向 WS 事件推送 |
| 10721 | 隔离 DSH | agent 运行时 API |
| 3100 | 桥接层 | 本地控制台 |

### 进程

| 进程 | 启动方 | 说明 |
| --- | --- | --- |
| `MoonBot.exe` | 用户 | Electron 壳 |
| `qbm-node.exe server/index.js` | 壳 | 管理端后端，隐藏启动 |
| `qbm-node.exe <dsh>/lib/bin.js --port 10721` | 后端 | 隔离 DSH |
| `qbm-node.exe src/bridge.js` | 后端 | 桥接层 |
| `NapCatWinBootMain.exe`、`QQ.exe` | 后端 | NapCat 与 QQ |
| `guard-node.exe napcat-guardian.mjs` | 后端 | 关窗守卫，不在应用进程树内 |

### 关窗流程

1. 壳向 `/api/shutdown` 发送 `{all:true}`，后端停止桥、隔离 DSH 与 NapCat
2. 壳执行 `taskkill /pid <后端> /T /F`
3. 壳按可执行文件路径清理残留的 `qbm-node.exe`
4. 守卫进程每 2 秒检查 `MoonBot.exe`，进程消失后等待 6 秒再核对 guard 文件，确认无新后端接管后依次停止 NapCat、桥与隔离 DSH

守卫只按托管目录、桥的绝对路径与 DSH 端口匹配进程，缺少参数时跳过对应清理。

## 目录结构

标记 ✅ 的文件纳入版本管理，标记 ⛔ 的文件在本地存在但不纳入版本管理。

```
MoonBot Public/
├─ src/                      ✅ 管理端前端，React + TypeScript + Vite
│   ├─ App.tsx               页面切换
│   ├─ api.ts                后端接口封装
│   ├─ pages/                8 个页面
│   ├─ components/           通用组件
│   ├─ stores/               状态与类型
│   ├─ styles/               主题与全局样式
│   └─ tool-schema-chars.ts  工具 schema 体积表
├─ server/                   ✅ 管理端后端
│   ├─ index.js              HTTP API、实例编排、探活、静态托管
│   ├─ deploy.js             SSH 远程部署
│   └─ napcat-guardian.mjs   关窗守卫
├─ qq-bridge/                ✅ 桥接层
│   ├─ src/                  业务源码
│   ├─ dsh/                  agent preset
│   ├─ plugins/              DSH 插件
│   ├─ scripts/              运维脚本
│   ├─ tools/                开发与回归工具
│   ├─ tests/                单元测试
│   ├─ docs/                 桥接层文档
│   ├─ characters/           角色卡模板
│   ├─ config.example.json   出厂配置模板
│   ├─ state/                ⛔ 运行数据：记忆库、社交状态、用量日志
│   ├─ config.json           ⛔ 实际配置
│   ├─ persona.md  roles/    ⛔ 人设文件
│   └─ node_modules/         ⛔ 依赖
├─ dist/                     ⛔ 前端构建产物
├─ public/                   ⛔ 静态资源
├─ node_modules/             ⛔ 依赖
├─ dsh/  dsh-runtime/        ⛔ DSH 源码与依赖
├─ napcat-onekey/            ⛔ NapCat 便携版
├─ meme/                     ⛔ 表情包库
├─ release/                  ⛔ 安装包
├─ docs/                     ⛔ 内部交接文档
├─ tools/                    ✅ 开发与运维脚本
├─ README.md                 ✅ 本文档
├─ LICENSE                   ✅ MIT
└─ 启动管理端.bat             ✅ 开发模式启动
```

`tools/` 目录：

| 文件 | 用途 |
| --- | --- |
| `sync-to-live.ps1` | 同步源码到运行目录与打包 payload，并校验哈希 |
| `restart-manager.ps1` | 重启管理端后端，不终止子进程 |
| `start-manager-hidden.vbs` | 无窗口启动管理端 |
| `diag-napcat-guard.ps1` | 端口、NapCat 进程、守卫状态体检 |
| `probe-ssh-banner.mjs` | SSH 端口探测，不进行认证 |
| `diag-ssh-auth.mjs`、`diag-ssh-keys.mjs` | SSH 认证诊断 |
| `probe-mcp-tools.mjs` | 读取 MCP 工具表，校验工具精简是否生效 |
| `test-*.mjs` | 回归测试 |

## 安装

### 安装包

1. 运行 `release\MoonBot-Full-Setup.exe`
2. 安装到普通目录，例如 `D:\MoonBot`
3. 启动后按 DSH、NapCat、桥的顺序启动实例，或使用一键启动

安装目录需要可写，不要安装到 `C:\Program Files`；不要安装到同步盘，SQLite 数据库会被同步破坏。

### 源码

```powershell
npm install
npm run dev
```

开发模式前端地址为 `http://127.0.0.1:5173`，后端为 `http://127.0.0.1:1921`。

源码运行需要运行时目录，从已安装的 MoonBot 复制 `resources\runtime\napcat-onekey`、`dsh`、`dsh-runtime` 到仓库根目录。后端按项目内、常见位置、PATH 的顺序探测。

## 使用

首次配置：

| 步骤 | 位置 |
| --- | --- |
| 填写模型服务商与 API Key | 管理端模型卡片 |
| 登录机器人 QQ | NapCat WebUI |
| 填写主人 QQ | 桥接配置，基础与会话 |
| 配置白名单与黑名单 | 桥接配置，允许与拒绝名单 |
| 上传人设 | 桥接配置，人设与发言规则 |

### 管理端页面

| 页面 | 内容 |
| --- | --- |
| 首页 | 一键启动、新手教程、四个服务卡片、安装位置警告 |
| 实例配置 | 隔离 DSH、NapCat、Bridge 的启动参数与日志 |
| SSH 配置 | 服务器列表、连接测试、隧道、代码与数据同步、一键克隆整套、清理远端 |
| 功能配置 | 常用设置、工具与规则、人设与发言规则、JSON 进阶、方案五个页签 |
| 学习与用量 | 黑话、人格、画像三类学习的配置与状态，Token 用量面板 |
| 群友画像 | 关系图、画像卡片、互动强度、关系标注 |
| 内嵌界面 | NapCat 与 DSH 官方界面，令牌自动跟随 |

功能配置页关键行为：

- 模型列表按服务商从 DSH 配置读取，切换服务商时模型列表与主模型同步切换
- 推理档位使用 DSH 的真实档位标识，并显示当前生效值
- 工具 schema 精简使被排除的工具不注册给模型，减少每次请求的体积
- 方案页签保存整套配置，参数相同的方案自动复用
- 人格学习状态支持展开查看单人完整资料，资料直读记忆库，不做截断

## 聊天命令

在私聊或群聊中发送，管理类命令仅主人生效。

| 命令 | 作用 |
| --- | --- |
| `/reset`、`/new` | 重置当前会话上下文 |
| `/status` | 查看会话状态、白名单、角色与模式 |
| `/sleep` | 全程静默，不调用模型 |
| `/wake` | 解除静默 |
| `/deepsleep` | 静默所有群聊，私聊不受影响 |
| `/start` | 解除群聊静默 |
| `/silent`、`/quiet` | 本会话静默 |
| `/active`、`/speak` | 本会话恢复回应 |
| `/set mode active` | 本会话全天活跃 |
| `/set mode diving` | 本会话转潜水 |
| `/set sleep 01:00-06:00` | 设置作息时段，时段内群聊只回应 @ |
| `/set sleep 30m` | 定时休息，到点恢复 |
| `/set wake`、`/set cancel` | 取消休息与作息 |
| `/role <名称>` | 切换角色卡 |
| `/role off` | 清除角色 |
| `/op <QQ 号或昵称>` | 设置管理员 |
| `/op del <QQ 号或昵称>` | 取消管理员 |
| `/slang 学习` | 立即执行黑话学习 |
| `/slang 停止` | 停止黑话学习 |
| `/portrait learn`、`/portrait stop`、`/portrait status` | 群友画像学习 |
| `/like <QQ 号> [次数]` | 点赞 |

其他以 `/` 开头的内容交给模型处理。

## 配置

管理端配置位于 `%USERPROFILE%\.qq-bridge-manager\config.json`。

| 键 | 说明 |
| --- | --- |
| `servers` | SSH 服务器列表，含认证方式、远程端口与上次可用端口 |
| `activeServerId` | 当前服务器，为空表示本机模式 |
| `local` | 本机服务端口：NapCat WebUI、NapCat HTTP、DSH、Bridge |
| `instances.dshIsolated` | 隔离 DSH：启用、端口、home、profile、CLI 路径 |
| `instances.napcatLocal` | NapCat：启用、启动命令、目录、WebUI 端口与令牌、快速登录账号 |
| `instances.bridgeLocal` | Bridge：启用、启动命令、工作目录与端口 |

桥接层配置位于 `<运行时>\qq-bridge\config.json`，模板见 `qq-bridge/config.example.json`。

| 分区 | 说明 |
| --- | --- |
| `dsh` | 模型服务商、模型、推理档位与 DSH 地址 |
| `napcat` | OneBot 地址与令牌、启动器路径、是否允许进程控制 |
| `ownerQQ` | 主人 QQ，出厂模板为 0 |
| `allow`、`deny` | 私聊与群聊名单，`allowAllWhenEmpty` 为 true 时空白名单表示允许全部 |
| `social` | 社交行为、唤醒、发送节奏、主动闲聊、表情包、静默与跨会话 |
| `slang` | 黑话学习的定时、间隔、研究阈值与是否注入提示词 |
| `slimTools` | 工具精简名单，使用不带 MCP 前缀的工具名 |

## 数据与日志

### 桥接层 `state/`

| 文件 | 内容 |
| --- | --- |
| `memory.db` | SQLite，含 `profiles`、`memory_entries`、`chat_messages` 三张表 |
| `social-state.json` | 各会话社交状态、未读与会话令牌 |
| `sessions.json` | QQ 会话与 DSH 会话的映射 |
| `slang.json` | 黑话词条与证据 |
| `stickers.json` | 收藏表情元数据 |
| `activity-windows.json` | 各群活跃时段 |
| `token-usage.jsonl` | Token 用量明细 |
| `tool-calls.jsonl` | 工具调用轨迹 |
| `scheduled-tasks.json` | 定时消息任务 |
| `crosschat.json` | 跨会话摘要与留言 |
| `persona-library.json` | 人格档案 |
| `learning-config.json` | 学习配置 |
| `bridge.log` | 桥接日志 |

`state/` 包含聊天记录与个人信息，不要对外分享。

### 管理端日志

`%USERPROFILE%\.qq-bridge-manager\logs\` 下包含 `manager.log`、`dsh-isolated.log`、`bridge-local.log`、`napcat-local.log` 与 `napcat-guardian.log`。

### 隔离 DSH 数据

`%USERPROFILE%\.qq-bridge-manager\dsh-isolated-home-<profile>\` 下包含 `sessions`、`profiles`、`.agent-presets`、`.credentials.yaml` 与 `plugins`。

## HTTP API

后端监听 `127.0.0.1`，生产模式下同时托管前端。

### 配置与状态

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 读取管理器配置 |
| POST | `/api/config` | 合并写入配置 |
| GET | `/api/state` | 运行状态、实例阶段与安装位置警告 |
| GET | `/api/open` | 返回官方界面地址 |
| GET | `/api/napcat/launchers` | 定位 NapCat 并刷新隐藏启动脚本 |
| GET | `/api/instance/:id/logs` | 实例日志 |

### 实例

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/instance/:id/:action` | 启动、停止与重启 |
| POST | `/api/instance/start-all` | 依次启动并等待就绪 |

### SSH

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/ssh/test` | 连接测试，支持端口纠偏 |
| POST | `/api/ssh/connect` | 建立连接与隧道 |
| POST | `/api/ssh/disconnect` | 断开连接 |
| POST | `/api/ssh/sync` | 同步代码、数据、表情包与 config.json |
| POST | `/api/ssh/remove-stack` | 停止并移走远端整套文件 |
| POST | `/api/ssh/deploy/start` | 发起远程部署 |
| GET | `/api/ssh/deploy/status` | 部署状态 |
| GET | `/api/ssh/deploy/tasks` | 部署任务列表 |

### 桥配置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET、POST | `/api/bridge/config` | 读写桥配置、人设与发言规则 |
| POST | `/api/bridge/speech-reset` | 恢复默认发言规则 |
| GET | `/api/bridge/characters` | 角色库列表 |
| POST | `/api/bridge/characters/import` | 导入角色为 persona |
| POST | `/api/bridge/upload` | 上传人设或角色包 |
| POST | `/api/bridge/stickers/upload` | 上传表情图库 |
| GET、POST | `/api/profiles` | 配置方案列表与保存 |
| POST | `/api/profiles/:id/delete` | 删除方案 |

### 学习与用量

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET、POST | `/api/learning/config` | 学习配置 |
| POST | `/api/learning/slang` | 黑话学习 |
| POST | `/api/learning/persona` | 人格学习 |
| POST | `/api/learning/portrait` | 画像学习 |
| GET | `/api/learning/token-report` | 用量报表 |
| GET | `/api/learning/token-stream` | 用量实时推流 |
| GET | `/api/learning/graph` | 关系图数据 |
| GET | `/api/learning/profile` | 单人完整画像资料 |
| GET | `/api/learning/slang-library` | 黑话库 |
| GET、PUT | `/api/learning/portrait-config` | 画像自动刷新设置 |
| GET、PUT | `/api/learning/relations` | 关系标注 |

### 守卫

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/guardian/arm` | 武装关窗守卫，校验进程名 |
| POST | `/api/shutdown` | 停止实例，`{all:true}` 同时停止桥与隔离 DSH |

## MCP 工具

桥接层向 agent 注册 84 个工具。

| 来源文件 | 数量 | 范围 |
| --- | --- | --- |
| `mcp-napcat-safe.js` | 77 | QQ 与 NapCat 能力 |
| `mcp-host-server.js` | 5 | 学习语料与 NapCat 进程控制，进程控制默认不注册 |
| `mcp-web-search-safe.js` | 2 | 联网搜索与网页抓取 |

| 分组 | 工具 |
| --- | --- |
| 消息读取 | `qq_get_recent_messages`、`qq_get_unread_messages`、`qq_mark_read`、`qq_get_message_detail`、`qq_get_message_images`、`qq_get_my_recent_messages`、`qq_get_forward_msg`、`qq_get_file_content`、`qq_get_group_history`、`qq_history_clear`、`qq_history_delete`、`qq_wait_for_messages`、`qq_get_prompt` |
| 发送 | `qq_send_message`、`qq_send_group_message`、`qq_send_private_message`、`qq_reply`、`qq_send_burst`、`qq_send_poke`、`qq_send_rich`、`qq_send_forward`、`qq_send_docx`、`qq_send_qq_face`、`qq_send_sticker`、`qq_withdraw_message`、`qq_proactive_send` |
| 表情与媒体 | `qq_list_stickers`、`qq_collect_sticker`、`qq_get_sticker_image`、`qq_sticker_note`、`qq_set_sticker_remark`、`qq_face_list`、`qq_get_self_image`、`qq_whale_meme_search`、`qq_send_whale_meme`、`qq_music_search` |
| 群与成员 | `qq_list_groups`、`qq_get_group_members`、`qq_get_group_owner`、`qq_get_active_members`、`qq_remove_friend` |
| 记忆与画像 | `qq_memory_append`、`qq_memory_search`、`qq_memory_query`、`qq_memory_remove`、`qq_memory_clear`、`qq_profile_get`、`qq_profile_set` |
| 社交状态 | `qq_social_state`、`qq_global_overview`、`qq_get_system_config`、`qq_set_system_config`、`qq_set_wake_config`、`qq_get_activity_hours`、`qq_set_activity_hours`、`qq_admin_set`、`qq_whitelist`、`qq_blacklist`、`qq_like`、`qq_report_feedback` |
| 学习 | `qq_learning_submit`、`qq_learning_corpus`、`qq_slang_query`、`qq_slang_submit`、`qq_persona_learn_start`、`qq_persona_learn_status`、`qq_persona_learn_stop` |
| 跨会话与空间 | `qq_crosschat_inbox`、`qq_crosschat_send`、`qq_qzone_view`、`qq_qzone_like`、`qq_qzone_comment`、`qq_qzone_reply_comment`、`qq_send_qzone` |
| 定时与状态 | `qq_schedule_message`、`qq_schedule_list`、`qq_schedule_cancel`、`qq_deepsleep`、`qq_status` |
| 宿主与联网 | `napcat_status`、`start_napcat`、`stop_napcat`、`web_search`、`web_fetch` |

权限约束：

- `qq_admin_set`、`qq_whitelist` 与 `qq_set_system_config` 仅在主人私聊可用
- `qq_blacklist` 不能拉黑主人，`qq_remove_friend` 不能删除主人
- 发送类工具需要会话令牌，目标会话必须在名单内
- `social.tools` 开关在调用时拒绝，不减少请求体积；`social.slimTools` 在注册期排除，可减少请求体积
- 修改 `mcp-*.js` 后需要重启隔离 DSH

## 唤醒机制

唤醒原因写入注入正文的 `[Wake <原因>]`。

| 原因 | 触发条件 |
| --- | --- |
| `private` | 私聊消息 |
| `atMention` | 被 @ 或消息引用机器人 |
| `question` | 直接提问 |
| `nameMention` | 点名 |
| `keyword` | 命中关键词 |
| `speaker` | 命中指定发言人 |
| `anyMessage` | 会话处于活跃模式 |
| `topic` | 命中话题词 |
| `probability` | 概率接话 |
| `bootstrap` | 会话首次连接 |
| `poke` | 被戳一戳 |
| `timeout` | 潜水到期 |
| `proactiveCheck` | 主动开口机会 |
| `replyCheck` | 回复后复查 |
| `activityStart` | 进入活跃时段 |
| `deliveryWatchdog` | 该交付未交付 |
| `loopRecovery` | 复读恢复 |
| `timeoutRecovery` | 卡死恢复 |
| `admin` | 手动唤醒 |

多条消息在合并窗口内合并为一次唤醒，按优先级取最高的原因。回合进行中到达的消息以 `[Mid-turn]` 形式注入当前回合。

注入正文只包含数据，行为规则位于 preset。人设以 `[PERSONA]` 注入，发言风格以 `[SPEECH RULES]` 注入，主人私聊带 `[OWNER]` 标记。黑话表不注入上下文，需要时由模型调用 `qq_slang_query` 查询。

## 运维

```powershell
# 同步源码到运行目录与打包 payload
powershell -File tools\sync-to-live.ps1

# 重启管理端后端
powershell -File tools\restart-manager.ps1

# 重启桥与隔离 DSH
Invoke-WebRequest -Uri 'http://127.0.0.1:1921/api/instance/bridge-local/restart' -Method POST
Invoke-WebRequest -Uri 'http://127.0.0.1:1921/api/instance/dsh-isolated/restart' -Method POST

# 体检
powershell -File tools\diag-napcat-guard.ps1
```

`sync-to-live.ps1` 通过环境变量 `QBM_LIVE_RUNTIME` 读取运行目录，未设置时只同步打包 payload。

修改内容与所需操作：

| 修改内容 | 操作 |
| --- | --- |
| 桥接层代码 | 重启桥 |
| agent preset | 重启桥 |
| 人设或发言规则 | 无需重启，下一条消息生效 |
| 管理端后端 | 重启管理端 |
| 管理端前端 | 构建、同步、刷新页面 |
| 打包壳 | 重新打包 |

## 开发与打包

### 回归测试

```powershell
node tools\test-napcat-guardian.mjs
node tools\test-guardian-arming.mjs
node tools\test-guardian-hidden-window.mjs
node tools\test-provider-models.mjs
node tools\test-any-drive-startup.mjs
node tools\test-target-env.mjs
node tools\test-local-clone-pack.mjs

node qq-bridge\tools\test-wake-protocol.mjs
node qq-bridge\tools\test-slash-commands.mjs
node qq-bridge\tools\test-steer-batch.mjs
node qq-bridge\tools\test-steer-gate.mjs
node qq-bridge\tools\test-config-hotreload.mjs
node qq-bridge\tools\test-napcat-startup-retry.mjs
node qq-bridge\tools\test-qq-hold.mjs
```

### 打包

打包工程位于同级目录 `..\QQ-Bridge-packaging\`。

```powershell
cd ..\QQ-Bridge-packaging\moonbot-app

node ..\tools\build-moonbot-app.mjs full
node ..\tools\build-moonbot-app.mjs core

node ..\tools\verify-installer-content.ps1
```

发布流程：

1. 修改代码
2. 构建前端，执行 `npm run build`
3. 执行 `tools\sync-to-live.ps1`，确认输出 `DONE`
4. 执行打包脚本，脚本在打包前清理 payload 中的个人信息
5. 执行校验脚本，确认全部断言通过

## 常见问题

**安装位置**

运行数据保存在安装目录内，安装目录需要可写，且不能位于同步盘。首页在检测到风险位置时给出警告。

**界面或行为没有变化**

确认已执行 `tools\sync-to-live.ps1` 并看到 `DONE`，确认修改内容对应的进程已重启。

**机器人不回复**

依次检查桥接日志、管理端实例状态、隔离 DSH 状态与 NapCat 登录状态。首页实例卡片显示真实的探活结果与失败原因。

**窗口**

所有子进程以隐藏方式启动。守卫进程通过 WMI 创建并设置隐藏窗口，回归测试 `test-guardian-hidden-window.mjs` 校验该行为。

**远程部署失败**

先用 `tools\probe-ssh-banner.mjs` 确认端口可达。SSH 端口不一定是 22，管理器会记录上次可用端口。部署过程会自动安装缺失的 node、npm 与 docker。

## 隐私

- 本仓库不包含真实 QQ 号、群号、服务器地址与令牌，示例使用占位符
- `config.json`、`persona.md`、`roles/` 与 `state/` 不纳入版本管理
- 运行数据保存在本机，仅发送给模型服务商的上下文会离开本机
- 模型密钥保存在隔离 DSH 的 `.credentials.yaml`，NapCat 令牌保存在桥接配置中

## 许可

MIT，见 [LICENSE](LICENSE)。

第三方组件：

- NapCat，QQ NT 协议端，https://github.com/NapNeko/NapCatQQ
- DeepSeek Harness，agent 运行时，https://github.com/deepseek-ai/deepseek-harness
- Model Context Protocol SDK，https://github.com/modelcontextprotocol/typescript-sdk
