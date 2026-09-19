# MoonBot

Windows 桌面应用，用于部署和管理 QQ 机器人。把 NapCat、QQ 桥接层、DeepSeek Harness 与模型服务商整合为一个可安装程序，提供图形化配置、进程编排、日志查看与远程部署。

当前版本 **1.2.0**，产品名 MoonBot Pro，对外安装包为 `MoonBot Pro Setup.exe`。更新记录见 [CHANGELOG.md](CHANGELOG.md)，1.0.0 那版的发布说明留档在 [docs/release-1.0.0.md](docs/release-1.0.0.md)。

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
- [关键机制](#关键机制)
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
- 富文本发送：图文卡、合并转发、Word 文档、QQ 原生表情、表情包；音乐点歌卡片可在手机端点开播放
- 语音：接入小米 MiMo（纯远端 API，无本地模型），内置音色 / 文字造音色 / 音频复刻三选一，支持全语音模式与收到语音自动转文字；语音与表情包的发送概率由桥侧掷骰决定（原理见[语音发送](#语音发送tts--asr)）
- 联网搜索与网页抓取、图片搜索、Pixiv 搜图发图（镜像站地址可配、本地筛选 + 自动翻页、按作品号直发无损原图；按画师名字找号要配一次登录 cookie，见 [Pixiv 搜图与发图](#pixiv-搜图与发图)）
- 潜水与活跃模式、活动时段、回合保持、连发合并
- Token 用量统计与费用估算，工具 schema 可按需精简
- SSH 远程部署，支持代码、数据、表情包与 config.json 分别同步，可一键克隆整套环境
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

各层的入口文件与职责：

| 层 | 入口 | 职责 |
| --- | --- | --- |
| 管理端前端 | `src/App.tsx`、`src/api.ts` | 页面切换与后端接口封装；页面在 `src/pages/`，共享组件在 `src/components/`，状态与类型在 `src/stores/types.ts` |
| 管理端后端 | `server/index.js` | HTTP API、实例编排与探活、前端静态托管、安装位置体检；SSH 远程部署在 `server/deploy.js`；关窗守卫是独立进程 `server/napcat-guardian.mjs` |
| QQ 桥 | `qq-bridge/src/bridge.js` | 桥的入口，负责载入配置、连接 OneBot 反向 WS、装载事件泵与各子系统 |
| 桥业务层 | `qq-bridge/src/core/*.js` | 唤醒判定与投递、提示词组装、会话映射、社交状态、发送链、媒体与卡片、语音、学习、用量计量 |
| 桥工具层 | `qq-bridge/src/mcp-*.js` | 三组 MCP server，向 agent 暴露 QQ/NapCat、学习语料与联网工具 |
| 桥基础库 | `qq-bridge/src/lib/*.js` | OneBot 客户端、消息解析、媒体工具、Pixiv、日志、路径与文本处理等无副作用的工具函数 |
| 隔离 DSH | `qq-bridge/dsh/agent-presets/qq-chat/` | agent preset：`preset.yml` 提供 `[WAKE TYPES]` 等行为规则，`qq-tool-restrict.mjs` 限制可用工具 |
| DSH 插件 | `qq-bridge/plugins/dsh-qq-hold/`、`qq-bridge/plugins/qq-mode-console/` | 回合保持与模式控制台两个本地插件 |
| NapCat | `napcat-onekey/bootmain/` | 便携版 NapCat 与 QQ，启动脚本 `napcat.bat`、扫码登录用 `napcat.quick.bat` |

两侧的配置与数据不混：管理端配置在 `%USERPROFILE%\.qq-bridge-manager\config.json`，桥配置在 `<运行时>\qq-bridge\config.json`，模板见 `qq-bridge/config.example.json`。

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

## 关键机制

### 会话唤醒与投递

一条 QQ 消息到一次回复，经过唤醒判定、正文组装、会话投递、回合保持与发送链五段。

| 环节 | 文件 | 说明 |
| --- | --- | --- |
| 唤醒判定与正文组装 | `qq-bridge/src/core/wake-send.js` | 注入正文只携带数据行：`[Token]`、`[Wake …]`、`[Unread n]`、`[Mid-turn]`、`[Note]`；每种唤醒原因「该怎么做」全部写在 preset 的 `[WAKE TYPES]`，不再随唤醒正文重复下发 |
| 唤醒调度与交付看门狗 | `qq-bridge/src/core/social-state.js` | `scheduleWake()` 统一入口，`startDeliveryWatchdog()` 对「该交付却未交付」的会话补一次 `deliveryWatchdog` 唤醒 |
| 卡死与复读恢复 | `qq-bridge/src/core/turn-guard.js` | 有未读却长时间无动作时以 `loopRecovery` 拉回，回合卡死时以 `timeoutRecovery` 收尾 |
| 回合保持与消息合并 | `qq-bridge/src/core/turn-hold.js`、`qq-bridge/src/core/mux.js` | 一个模型步只产生**一个** `[Mid-turn]` 块，把这步攒下的消息合成进去，而不是半路一条条塞 |
| 打字状态等待 | `qq-bridge/src/core/typing-hold.js` | 私聊按对方打字状态决定等待还是插话；等待期间的消息全部入队，只注入一次 |
| 发送与幂等 | `qq-bridge/src/core/send-chain.js`、`qq-bridge/src/core/send-idempotency.js`、`qq-bridge/src/lib/onebot-delivery.js` | 发送链负责分段与节奏，幂等闸门防止 `/reset` 之后重复回一次 |
| 会话映射与自愈 | `qq-bridge/src/core/session-state.js`、`qq-bridge/src/core/session-archive.js` | 维护 QQ 会话与 DSH 会话的映射；启动时清掉指向已删会话的映射，避免事件泵空转 |

### 人格学习与画像

| 能力 | 文件 | 说明 |
| --- | --- | --- |
| 人格学习 | `qq-bridge/src/core/persona-learn.js` | 每个目标一个模型会话；学习会话只加载 host 组 MCP，工具全名固定为 `mcp__napcat-host__qq_learning_submit` 与 `mcp__napcat-host__qq_learning_corpus`，写成 `mcp__napcat__` 那组会直接 unknown tool |
| 档案文本组装 | `qq-bridge/src/core/persona-text.js` | 把学习产出拼成一段完整介绍，不重复、不半句截断 |
| 档案存储 | `qq-bridge/state/persona-library.json` | 人格档案；管理端「人格学习」页直接读它 |
| 群友画像学习 | `qq-bridge/src/core/portrait-learn.js` | 按活跃度或指定 QQ 选目标，逐人写回 `profiles` 表 |
| 资料与关系展示 | `src/pages/Learning.tsx`、`src/pages/GroupPortrait.tsx`、`src/pages/NetCanvas.tsx` | 单人完整资料走 `/api/learning/profile`（直读记忆库、不截断），关系图与关系标注走 `/api/learning/graph` 与 `/api/learning/relations` |

### 黑话学习

- 学习会话与语料工具在 `qq-bridge/src/slang-learner.js`，词条、状态机、去重与查询在 `qq-bridge/src/core/slang.js`，产出落到 `qq-bridge/state/slang.json`。
- 已确认的词条**不再注入上下文**，模型需要时自己调 `qq_slang_query` 查，省额度。
- 候选堆积与「研究链从来没跑成」的排查脚本：`qq-bridge/tools/diag-slang-dupes.mjs`、`qq-bridge/tools/diag-slang-why.sh`。

### 工具 schema 精简

- `qq-bridge/src/mcp-napcat-safe.js` 里的 `bareToolName()` 负责 MCP 前缀归一化，`social.slimTools` 名单里写 `mcp__napcat__qq_x` 与写 `qq_x` 等价。少了这一步，精简名单会整体不命中。
- `social.slimTools` 在**注册期**排除工具，能真正减少每次请求的体积；`social.tools` 只在**调用期**拒绝，不减少体积。改完需要重启隔离 DSH。
- 工具体积数据由 `qq-bridge/tools/emit-tool-chars.mjs` 现场生成，写入 `src/tool-schema-chars.ts`；手工核对用 `tools/probe-mcp-tools.mjs`。

### 富文本卡片与封面处理

- 卡片与媒体组装：`qq-bridge/src/core/media.js`；发送链在 `qq-bridge/src/core/send-chain.js` 与 `qq-bridge/src/core/qq-send.js`；表情与收藏表情在 `qq-bridge/src/core/sticker.js`；Word 文档在 `qq-bridge/src/core/docx.js`。
- 封面只做 URL 归一化（`normalizeCoverUrl()`：http 升 https、限定尺寸、补 `type=jpg`），**不做图片代理** —— 代理过一次的那版正是「手机端没封面」的元凶，已回退。
- 版式分两种：`share` 版照抄真机分享的图文卡，手机端会画封面；旧的 `music.lua` 版手机端本来就不画封面，且会被「将要访问」中转页拦一层。
- 签名服务是独立进程 `qq-bridge/music-sign-proxy.py`；探针与回归在 `qq-bridge/tools/probe-netease-cover.mjs`、`probe-sign-payloads.mjs`、`probe-sign-types.mjs`、`test-music-card.mjs`、`test-qq-card-sign.mjs`。

### 语音发送（TTS / ASR）

- **没有本地模型，也没有随包音频**：合成与识别都走小米 MiMo 的 OpenAI 兼容端点（`POST {baseUrl}/chat/completions`，默认 `https://token-plan-cn.xiaomimimo.com/v1`），实现集中在 `qq-bridge/src/core/voice.js`。鉴权同时发 `api-key` 与 `Authorization: Bearer`；合成时**要念的文本放 `assistant` 消息**、风格描述放 `user` 消息（可选）、音色放 `audio.voice`，返回 `choices[0].message.audio.data` 的 base64 音频，落盘成 mp3 再交给 NapCat 发 `record`；识别（ASR）用 `input_audio` 传 data URL，返回文字。计费按 token（实测一条短句 163 tokens），与聊天同一本账。
- **三种音色来源**：`tts`（`mimo-v2.5-tts`，`audio.voice` 传官方音色 id）、`design`（`mimo-v2.5-tts-voicedesign`，用文字描述造音色，**不能**传 voice）、`clone`（`mimo-v2.5-tts-voiceclone`，`audio.voice` 必须是样本的 **DataURL**，裸 base64 会被 400 拒）。
- **官方音色只是一张 id 名单**：`voice.js` 的 `BUILTIN_VOICES`（`mimo_default`、冰糖、茉莉、苏打、白桦、Mia、Chloe、Milo、Dean，各带语言与性别），经 `/api/voice/config` 的 `builtinVoices` 下发给管理端「语音」页渲染；音色数据本身在服务端，仓库里 0 个音频文件。design/clone 造出来的音色存 `state/voice-voices.json`，克隆样本存 `state/voice-cache/samples/`。
- **什么时候发语音由模型决定**：每次唤醒桥侧先掷骰（`send-dice.js` 的 `dice('voice', …)`，概率 `send.probability`、冷却 `send.cooldownMs`），命中才往提示词里插一行「本轮可以额外加一条短语音气泡」，模型接着调 `qq_send_voice` 发出（HTTP 侧是 `POST /api/voice/send`，令牌/白名单/限频与文字发送同一套规矩，工具本身可用工具开关 `sendVoice` 关掉）。概率设 0 = 永不主动发，只能被明确要求。
- **全语音模式**：`send.allVoice=true` 时回复**一律**以语音发出（`qq-send.js` 走 `allVoicePlan()`）；任何一条不成立 —— 合成失败、超单条上限、当日额度用尽、被限流、带图、念不出来 —— 都**自动退回文字**并在日志留一行原因，绝不吞消息。
- **省钱与兜底**：同模型 + 同音色 + 同风格 + 同描述 + 同文本 → 命中 `state/voice-cache/*.mp3` 不再请求（上限 `maxCacheFiles`，默认 300）；单条上限 `maxChars`（硬上限 2000 字）、每日额度 `dailyChars`。语音文件必须落在 **NapCat 容器读得到的目录**（复用图片/表情那套 `napcat.tmpDir` + docker 路径映射），读不回来时自动退 base64 重发。
- **识别别人的语音**：收到的 `record` 段经 `get_record{out_format:'mp3'}` 转 mp3、`docker cp` 取回宿主再送 ASR（`mimo-v2.5-asr`，`asrLanguage` 默认 `zh`，原始音频 ≤7MB，对应 base64 后约 10MB）。
- **密钥**：存 `state/voice-config.json`（出厂安装包里被脱敏清空），管理端只回掩码与 `apiKeySet` 布尔值；换 key 走「语音」页或 `PUT /api/voice/config`。不配 key 不影响文字发送，语音相关调用一律降级。

### 内置表情包（meme-packs）

- **一份"表情包"就是一个目录**：`manifest.json`（id / 名字 / tag 列表 / 张数）+ `index.db`（SQLite，表 `memes(path, file_name, tag, caption, keywords, file_hash, mtime, captioned_at)`）+ `memes/<tag>/<文件名>.<ext>`（webp、png、jpg、jpeg、gif）。`qq_meme_search` 是拿 `index.db` 的 caption/keywords 搜、`qq_send_meme` 是拿表里的 `path` 发图，所以**改文件名必须同时重建表**，否则表现就是"搜得到、发不出"。
- **三处位置都认**（顺序即优先级）：出厂包 `<runtime>/meme/<包目录>/`、后装与上传的包 `<runtime>/meme-packs/<包目录>/`、角色专属包 `<角色库根>/<角色 slug>/meme-packs/<包目录>/`。包 id 取 `manifest.json` 的 `id`（目录名可以与 id 不同）；启动时一份都找不到会往 stderr 打**一行**日志，把尝试过的每条路径都列出来。
- **多包一起搜**：`qq_meme_search` 返回的每行是 `文件名 [tag] [包 id] 描述`，可以带 `pack` 只搜某一份；`qq_send_meme` 收 `文件名`，也收 `包id/文件名`。两份包里有同名文件时按**角色专属包 → 主人点名的包 → 出厂包**取第一份，并在返回里说明这个名字还存在于哪些包。
- **角色绑定**：`social.meme.personaPacks` 是「角色 slug → 包 id 数组」，`social.meme.activePersona` 记当前导进 `persona.md` 的角色（管理端导入角色卡时写）。`social.meme.packs` 非空时只搜这些包**加上**当前角色的包，留空 = 全都搜；总开关 `social.meme.enabled=false` 时 `qq_meme_search` / `qq_send_meme` 干脆不注册（模型列表里看不到，不是运行时拒绝）。
- **规整与重建表**：`qq-bridge/tools/relayout-meme-pack.mjs <包目录>` 按 tag 落位、重建 `index.db`、写 manifest v2，并做三件对账：表↔磁盘一致、桥侧真会跑的那两条 SQL 都能查到、包内文件名唯一。**已有的 caption/keywords 原样保留**（只给表里没有的新图生成兜底描述）；同名且内容完全相同的副本挪进 `.dedup/`（不删，可回滚），同名但内容不同则报错退出、一个文件都不动。
- **怎么加自己的包**：管理端「工具与规则」页的「内置表情包（meme-packs）」卡可以选 `.zip` 或整个文件夹上传，也可以直接把目录丢进 `<runtime>/meme-packs/`。上传先落到临时目录并跑一遍 `relayout`，失败会保留现场；成功才替换（旧包改名成 `<包目录>.bak-<时间戳>`），然后自动重启桥，新包立刻可用。

### 部署与克隆

- 一键克隆在 `server/deploy.js`：先在源机打包（桥代码与 `state`、`.dsh` home、NapCat 配置、NapCat 应用本体、QQ 登录态、代理、表情库），再传到目标机解包并接线，最后写 systemd 服务、灌登录态、启动自检。
- NapCat 跑法探针 `napcatModeCmd()`：有 `napcat.service` 判为原生，有 `napcat` 容器判为 docker，都没有才是 none；原生优先、docker 兜底。
- 原生装机脚本 `installNapcatNative()` 被抽成纯函数，可以离线做 `bash -n` 与 systemd 校验，不必真连服务器就能验语法。
- 启停与部署保持同一形状：`server/index.js` 与 `server/deploy.js` 都是「有 systemd unit 走 systemd，否则回退 docker」。
- 原生模式下没有 docker 路径映射这回事，图片/语音/表情的路径就是宿主机路径，直接写即可。

### 设备身份固定

- 桥与 NapCat 不参与这件事，处理在服务器侧：`qq-bridge/tools/pin-napcat-device.sh` 保证 `/etc/machine-id` 存在且与 `/var/lib/dbus/machine-id` 一致，把 hostname 钉成与机器无关的常量，并把钉好后的身份记到 `/opt/napcat/config/device-pin.json` 便于日后比对。
- `qq-bridge/tools/diag-napcat-device.sh` 是只读排查脚本，一条命令打出机器标识、QQ 实例目录（`~/.config/QQ/nt_qq_<hash>`，目录名一变服务端就当新设备）等全部证据。
- 注意：改 hostname 本身会让 QQ 认为换了一次设备，所以只在确实需要时跑，不要反复跑。

## 目录结构

标记 ✅ 的文件纳入版本管理，标记 ⛔ 的文件在本地存在但不纳入版本管理。

```
MoonBot Public/
├─ src/                      ✅ 管理端前端，React + TypeScript + Vite
│   ├─ App.tsx               页面切换
│   ├─ api.ts                后端接口封装
│   ├─ pages/                9 个页面：首页、实例配置、SSH 配置、功能配置、
│   │                        学习与用量、群友画像、语音、内嵌界面，以及关系图
│   ├─ components/           通用组件（含 NapCat 令牌卡）
│   ├─ stores/               状态与类型
│   ├─ styles/               主题与全局样式
│   └─ tool-schema-chars.ts  工具 schema 体积表
├─ server/                   ✅ 管理端后端
│   ├─ index.js              HTTP API、实例编排、探活、静态托管
│   ├─ deploy.js             SSH 远程部署
│   └─ napcat-guardian.mjs   关窗守卫
├─ qq-bridge/                ✅ 桥接层
│   ├─ src/                  桥入口与工具层
│   │   ├─ bridge.js         入口：载入配置、连 OneBot WS、装载事件泵
│   │   ├─ core/             业务实现：唤醒投递、会话、社交状态、发送链、媒体、
│   │   │                    语音、学习、用量计量等
│   │   ├─ lib/              基础库：OneBot 客户端、消息解析、媒体工具、Pixiv 等
│   │   └─ mcp-*.js          三组 MCP server
│   ├─ dsh/                  agent preset
│   ├─ plugins/              DSH 插件（dsh-qq-hold、qq-mode-console）
│   ├─ scripts/              运维脚本
│   ├─ tools/                开发与回归工具（含设备身份固定脚本）
│   ├─ tests/                单元测试
│   ├─ docs/                 桥接层文档
│   ├─ characters/           角色库：一个子目录 = 一个角色包（出厂 21 个 + 1 张散装卡）
│   ├─ config.example.json   出厂配置模板
│   ├─ music-sign-proxy.py   音乐卡片签名代理
│   ├─ state/                ⛔ 运行数据：记忆库、社交状态、用量日志
│   ├─ config.json           ⛔ 实际配置
│   ├─ persona.md  roles/    ⛔ 人设文件
│   └─ node_modules/         ⛔ 依赖
├─ dist/                     ⛔ 前端构建产物
├─ public/                   ⛔ 静态资源
├─ node_modules/             ⛔ 依赖
├─ dsh/  dsh-runtime/        ⛔ DSH 源码与依赖
├─ napcat-onekey/            ⛔ NapCat 便携版
├─ meme/                     ⛔ 出厂表情包（whale-fanart-001）
├─ meme-packs/               ⛔ 后装／上传的表情包，一份包一个目录
├─ release/                  ⛔ 安装包
├─ docs/                     ✅ 只有 release-1.0.0.md 纳入版本管理，
│                              其余为 ⛔ 内部交接文档（含服务器信息）
├─ tools/                    ✅ 开发与运维脚本
├─ README.md                 ✅ 本文档
├─ CHANGELOG.md              ✅ 更新日志
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
| `probe-dsh-model-catalog.mjs` | 查询 DSH 的服务商与模型目录 |
| `probe-dsh-system-prompt.mjs` | 抓取隔离 DSH 实际下发的系统提示词 |
| `audit-ui-labels.mjs`、`verify-rendered-labels.mjs` | 界面中文文案审计与渲染后校验 |
| `test-*.mjs` | 回归测试 |

## 安装

### 安装包

安装包两份产物，文件名不带版本号后缀：

| 产物 | 内容 | 适用场景 |
| --- | --- | --- |
| `MoonBot Pro Setup.exe` | 管理端 + 整套内置：NapCat（OneKey 与 QQ 客户端）、DSH CLI、qq-bridge 出厂模板 | 在一台 Windows 上跑整套 QQ 机器人 |
| `MoonBot Pro Manager Setup.exe` | 只有管理端（内含 Node 运行时） | 远程连自己的服务器用 |

安装步骤：

1. 运行 `release\MoonBot Pro Setup.exe`
2. 安装到普通目录，例如 `D:\MoonBot`
3. 启动后按 DSH、NapCat、桥的顺序启动实例，或使用一键启动

安装目录需要可写，且不能放在同步盘。原因是**程序的运行数据全部写在安装目录里**：

| 数据 | 位置 |
|---|---|
| 聊天记忆库（SQLite：`chat_messages` / `profiles` / `memory_entries`） | `<安装目录>\resources\runtime\qq-bridge\state\memory.db` |
| 会话与唤醒状态、活跃时段、用量计量、对账水位、日志 | 同层 `...\qq-bridge\state\` |
| 机器人人设 / 发言规则（「覆盖人设」写的就是它） | `...\qq-bridge\persona.md`、`speech-rules.md` |
| DSH 隔离运行目录（会话转录等） | `...\resources\runtime\.runtime\dsh-isolated-home` |

所以：

- **不要装到 `C:\Program Files`**：受保护目录，非管理员进程只能读不能写；更麻烦的是 Windows 的 UAC 虚拟化会把写入悄悄重定向到 `%LOCALAPPDATA%\VirtualStore\...`——看起来"存上了"，程序读的却是原路径，于是记忆库/人设对不上、甚至整库只读报错。
  安装包默认按用户装到 `%LOCALAPPDATA%\Programs\MoonBot`（不需要管理员、天然可写），只有你在安装向导里改了目录才会踩到这个坑。
- **不要装在同步盘**（OneDrive / Dropbox / Google Drive / 坚果云 / 微云）：SQLite 靠 WAL 日志 + 文件锁 + 原子替换保证一致性，而同步客户端会在任意时刻抓取/上传/回写文件，云盘的锁对本地 SQLite 也无效——结果可能是 `memory.db-wal` 与主库不匹配、半写文件被上传、旧版本回滚覆盖新数据，SQLite 直接报 `database disk image is malformed`，整个聊天记忆库打不开；还会冒出一堆 `memory.db (1)` 之类的冲突副本。
  另外安装树里带着 DSH 运行时和几十万个会话小文件（好几 GB），同步客户端会不停扫描上传：卡机器、占流量，还可能把会话内容一起传上云。
- **网络映射盘 / UNC 路径同理不要用**（例如 `\\nas\share\MoonBot`）：网络文件系统上的文件锁不可靠，SQLite 一样会损坏。

首页在检测到 `Program Files` 或上述同步盘目录时，会直接给出对应警告（见 `server/index.js` 的安装位置体检）。

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
| 填写管理员 QQ | 桥接配置，基础与会话 |
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
| 群友画像 | 关系图、画像卡片、互动强度、群角色与关系标注 |
| 语音 | 小米 MiMo 语音配置与全语音发送开关 |
| 内嵌界面 | NapCat 与 DSH 官方界面，令牌自动跟随 |

功能配置页关键行为：

- 模型列表按服务商从 DSH 配置读取，切换服务商时模型列表与主模型同步切换
- 推理档位使用 DSH 的真实档位标识，并显示当前生效值；服务商不支持所选档位时退回服务商默认
- 工具 schema 精简使被排除的工具**不注册**给模型，减少每次请求的体积；另有只在调用期生效的开关，见「关键机制」
- 群聊活跃时段按列表配置，群号不由管理端写死
- 方案页签保存整套配置，参数相同的方案自动复用
- 人格学习状态支持展开查看单人完整资料，资料直读记忆库，不做截断

### 保存规则：哪些点顶部「保存」，哪些卡片自己写盘

配置页有两类写盘方式，弄混就会出现"我改了但没生效"：

- **点顶部「保存」（写整份 `config.json`）**：常用设置里的全部字段 —— 模型/厂商、NapCat 地址与路径、基础与会话、允许/拒绝名单、唤醒与潜水、发送节奏、上下文与轮换、上下文治理、主动闲聊、等待、打字等待、表情包参数（收藏表情那一套）、静默群聊、投递与回合、好友申请、Word 额度，以及「工具与规则」里的工具开关与工具 schema 精简；内置表情包的总开关 `social.meme.enabled` 也在这一份里，但**包本身与角色绑定**由下面那张卡自己写盘。
- **卡片自己写盘、不用点顶部保存**：人设（`persona.md` · 点「保存人设」）、发言规则（`speech-rules.md` · 点「保存发言规则」）、群聊活跃时段（点「保存这个」，写的是桥的 `state/activity-windows.json`，不是 `config.json`）、NapCat 鉴权令牌（自己写 NapCat 的配置并重启 NapCat）、收藏表情上传（写表情库并重启桥）、内置表情包上传与角色绑定（写 `<runtime>/meme-packs/` 与 `social.meme.personaPacks`，并重启桥）、「保存并重启」（它会先替你点一次顶部保存、再重启 DSH/桥）。
- **会顺手写一份 `config.json` 的两个按钮**：「活跃时段 → 添加群」（把群加进允许名单）、「活跃时段 → 关闭静默，恢复群聊响应」（关 `deepsleep`）—— 它们立刻写盘，不必再点顶部保存。
- **配置方案页签**：点「存为新方案」只写方案文件；点「套用」写整份 `config.json`（等同一次全局保存）。

服务端模式下，上述写盘操作作用于**服务器上的那份**配置（页面顶部有横幅标明）。

## 聊天命令

命令由桥接层直接执行，不经过模型，仅管理员生效。其他会话发送会收到「管理命令仅管理员可用。」。命令在 `/deepsleep` 与暂停状态下仍然生效。

### 斜杠命令

| 命令 | 作用 |
| --- | --- |
| `/reset`、`/new` | 重置当前会话上下文 |
| `/status` | 查看会话标识、白名单、角色与模式 |
| `/silent`、`/quiet` | 本会话静默，群聊只记录不回应 |
| `/active`、`/speak` | 本会话恢复回应 |
| `/sleep` | 全程静默，不调用模型 |
| `/wake` | 解除静默 |
| `/deepsleep`、`deepsleep` | 静默所有群聊，私聊不受影响 |
| `/start`、`start` | 解除群聊静默 |
| `/set mode active`、`/set mode 活跃` | 本会话全天活跃，并清除该群的活跃时段 |
| `/set mode diving`、`/set mode 潜水` | 本会话转潜水 |
| `/set sleep 01:00-06:00` | 设置作息时段，分隔符可用 `-`、`~`、`年`、`到`，时间分隔符可用半角或全角冒号 |
| `/set sleep 30m`、`/set sleep 2h` | 定时休息，到点自动恢复 |
| `/set wake`、`/set cancel` | 取消休息与作息 |
| `/role`、`/role off`、`/role clear` | 清除角色，恢复默认人格 |
| `/role <名称>` | 切换 `roles/<名称>.md` 角色卡 |
| `/op` | 显示当前管理员与用法 |
| `/op <QQ 号或昵称>` | 设置管理员 |
| `/op del <QQ 号或昵称>` | 取消管理员，也可写作 `remove`、`删除`、`取消`、`撤销`、`解` |
| `/like <QQ 号> [次数]` | 点赞，次数范围 1 到 10 |
| 其他 `/` 开头 | 交给模型处理 |

`/deepsleep` 与 `/start` 也可直接发送不带斜杠的单词，大小写不敏感。

### 黑话学习

以 `/slang` 开头即命中，忽略大小写。

| 写法 | 作用 |
| --- | --- |
| `/slang 学习`、`/slang learn` | 立即执行一次黑话学习 |
| `/slang 停止`、`/slang stop` | 停止进行中的黑话学习与研究 |
| 其他 `/slang` 内容 | 返回用法说明 |

其他会话会收到「仅主人可操作」（源码里的固定提示语，见 `core/slang.js`，不变）。

### 群友画像学习

`/portrait` 可换用 `画像学习` 或 `群友画像学习`，子命令可省略，省略等同 `status`，指令后可跟 QQ 号列表。

| 子命令 | 作用 |
| --- | --- |
| `learn`、`start`、`学习` | 开始学习，未带 QQ 号时自动筛选活跃群成员 |
| `stop`、`停止` | 停止学习 |
| `status`、`状态` | 查看开关、间隔、定时、筛选条件与最近一轮目标 |

其他会话会收到「画像学习只有主人能指挥。」（同样是源码里的固定提示语，见 `core/portrait-learn.js`）

### 人格学习

不使用斜杠，直接发送短语，指令后可跟 QQ 号列表。

| 写法 | 作用 |
| --- | --- |
| `start learn`、`start learning`、`开始学习`、`学习一下` | 开始学习，未带 QQ 号时使用配置中的目标列表 |
| `stop learn`、`stop learning`、`停止学习` | 停止学习，不写入半成品档案 |
| `learn status`、`学习状态` | 查看档案状态、最近学习时间、样本数与性格预览 |

### 审批

机器人请求工具执行权限时，管理员回复下列词语决定是否放行。

| 决定 | 回复内容 |
| --- | --- |
| 通过 | `通过`、`同意`、`允许`、`批准`、`yes`、`y`、`approve`、`ok` |
| 拒绝 | `拒绝`、`不同意`、`不允许`、`驳回`、`no`、`n`、`reject`、`deny` |

其他会话回复会收到「审批仅管理员可操作」。

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
| `ownerQQ` | 管理员（owner）QQ，出厂模板为 0 |
| `allow`、`deny` | 私聊与群聊名单，`allowAllWhenEmpty` 为 true 时空白名单表示允许全部 |
| `social` | 社交行为、唤醒、发送节奏、主动闲聊、表情包、静默与跨会话 |
| `slang` | 黑话学习的定时、间隔、研究阈值与是否注入提示词 |
| `slimTools` | 工具精简名单，写 `qq_x` 或 `mcp__napcat__qq_x` 都可以（注册期生效，减少请求体积） |

## 数据与日志

### 桥接层 `state/`

| 文件 | 内容 |
| --- | --- |
| `memory.db` | SQLite，含 `profiles`、`memory_entries`、`chat_messages` 三张表 |
| `social-state.json` | 各会话社交状态、未读与会话令牌 |
| `sessions.json` | QQ 会话与 DSH 会话的映射 |
| `current-role.json` | 当前角色卡选择 |
| `slang.json` | 黑话词条与证据 |
| `slang-session.json` | 黑话学习会话的运行标记 |
| `stickers.json` | 收藏表情元数据 |
| `activity-windows.json` | 各群活跃时段 |
| `token-usage.jsonl` | Token 用量明细 |
| `tool-calls.jsonl` | 工具调用轨迹 |
| `scheduled-tasks.json` | 定时消息任务 |
| `crosschat.json` | 跨会话摘要与留言 |
| `feedback.json` | 模型经 `qq_report_feedback` 上报的问题 |
| `docx-quota.json` | 文档发送配额 |
| `persona-library.json` | 人格档案 |
| `learning-config.json` | 学习配置 |
| `bridge.lock` | 单实例锁 |
| `bridge.log`、`qq-activity.log` | 桥接日志与活动流水；`dsh-qq-hold.log`、`qq-mode-plugin.log` 是两个 DSH 插件的日志 |

路径常量集中在 `qq-bridge/src/lib/paths.js`，其余按需在各自模块里推导。

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
| GET、POST | `/api/napcat/tokens` | 读取或写入 NapCat 鉴权令牌并重启 |
| GET、POST | `/api/napcat/guard` | 读取或设置会话守护 |
| POST | `/api/napcat/guard/heal` | 会话假死自愈 |
| GET | `/api/napcat/qr` | 取登录二维码 |
| POST | `/api/napcat/quick-password` | 免扫码回退登录用的快速密码 |
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
| GET | `/api/ssh/status` | 当前 SSH 连接状态 |
| POST | `/api/ssh/connect` | 建立连接与隧道 |
| POST | `/api/ssh/disconnect` | 断开连接 |
| POST | `/api/ssh/sync` | 同步代码、数据、表情包与 config.json |
| GET、POST | `/api/ssh/bridge-config` | 单独读写远端桥配置 |
| POST | `/api/ssh/service` | 远端服务启停 |
| POST | `/api/ssh/stack` | 远端整套状态 |
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
| GET、POST | `/api/bridge/activity-hours` | 读写群聊活跃时段 |
| GET | `/api/bridge/activity-targets` | 活跃时段适用的群列表 |
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
| POST | `/api/learning/persona-apply` | 应用人格学习结果（结合原人设完善 / 整篇覆盖） |
| POST | `/api/learning/portrait` | 画像学习 |
| GET | `/api/learning/token-report` | 用量报表 |
| GET | `/api/learning/token-stream` | 用量实时推流 |
| POST | `/api/learning/token-reconcile` | 与 DSH 会话级计数对账 |
| GET | `/api/learning/graph` | 关系图数据 |
| GET | `/api/learning/groups` | 关系图可选的群列表 |
| GET | `/api/learning/messages` | 关系图上单个会话的消息 |
| GET | `/api/learning/profile` | 单人完整画像资料 |
| GET | `/api/learning/owner-profile` | 管理员本人的完整资料 |
| GET | `/api/learning/slang-library` | 黑话库 |
| GET、PUT | `/api/learning/portrait-config` | 画像自动刷新设置 |
| GET、PUT | `/api/learning/relations` | 关系标注 |
| POST | `/api/learning/relations/auto` | 让模型自动标注关系 |

### 黑话库

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/slang/research` | 触发一次黑话研究 |
| POST | `/api/slang/batch-confirm` | 批量确认候选 |
| POST | `/api/slang/batch-reject` | 批量拒绝候选 |
| POST | `/api/slang/batch-delete` | 批量删除词条 |

### 语音

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET、PUT | `/api/voice/config` | 语音配置与全语音开关 |
| GET、POST | `/api/voice/voices` | 音色列表与新增 |
| DELETE | `/api/voice/voices` | 删除音色 |
| POST | `/api/voice/preview` | 试听 |
| POST | `/api/voice/test` | 连通性测试 |

### 守卫

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/guardian/arm` | 武装关窗守卫，校验进程名 |
| POST | `/api/shutdown` | 停止实例，`{all:true}` 同时停止桥与隔离 DSH |

## MCP 工具

桥接层向 agent 注册 96 个工具。

| 来源文件 | 数量 | 范围 |
| --- | --- | --- |
| `mcp-napcat-safe.js` | 89 | QQ 与 NapCat 能力 |
| `mcp-host-server.js` | 5 | 学习语料与 NapCat 进程控制，进程控制默认不注册 |
| `mcp-web-search-safe.js` | 2 | 联网搜索与网页抓取 |

开启工具精简后实际下发给模型的会少于此数；`qq_status` 用裸 `server.tool` 注册，本来就不参与裁剪。

| 分组 | 数量 | 工具 |
| --- | --- | --- |
| 消息读取 | 13 | `qq_get_recent_messages`、`qq_get_unread_messages`、`qq_mark_read`、`qq_get_message_detail`、`qq_get_message_images`、`qq_get_my_recent_messages`、`qq_get_forward_msg`、`qq_get_file_content`、`qq_get_group_history`、`qq_history_clear`、`qq_history_delete`、`qq_wait_for_messages`、`qq_get_prompt` |
| 发送 | 13 | `qq_send_message`、`qq_send_group_message`、`qq_send_private_message`、`qq_reply`、`qq_send_burst`、`qq_send_poke`、`qq_send_rich`、`qq_send_forward`、`qq_send_docx`、`qq_send_qq_face`、`qq_send_sticker`、`qq_withdraw_message`、`qq_proactive_send` |
| 表情与媒体 | 18 | `qq_list_stickers`、`qq_collect_sticker`、`qq_get_sticker_image`、`qq_sticker_note`、`qq_set_sticker_remark`、`qq_face_list`、`qq_get_self_image`、`qq_meme_search`、`qq_send_meme`、`qq_music_search`、`qq_send_image`、`qq_image_search`、`qq_pixiv_search`、`qq_send_pixiv`、`qq_video_search`、`qq_video_parse`、`qq_send_voice`、`qq_transcribe_voice` |
| 群与成员 | 5 | `qq_list_groups`、`qq_get_group_members`、`qq_get_group_owner`、`qq_get_active_members`、`qq_remove_friend` |
| 记忆与画像 | 7 | `qq_memory_append`、`qq_memory_search`、`qq_memory_query`、`qq_memory_remove`、`qq_memory_clear`、`qq_profile_get`、`qq_profile_set` |
| 社交状态 | 12 | `qq_social_state`、`qq_global_overview`、`qq_get_system_config`、`qq_set_system_config`、`qq_set_wake_config`、`qq_get_activity_hours`、`qq_set_activity_hours`、`qq_admin_set`、`qq_whitelist`、`qq_blacklist`、`qq_like`、`qq_report_feedback` |
| 学习 | 5 | `qq_slang_query`、`qq_slang_submit`、`qq_persona_learn_start`、`qq_persona_learn_status`、`qq_persona_learn_stop` |
| 角色卡 | 4 | `qq_character_list`、`qq_character_read`、`qq_character_search`、`qq_character_pack` |
| 跨会话与空间 | 7 | `qq_crosschat_inbox`、`qq_crosschat_send`、`qq_qzone_view`、`qq_qzone_like`、`qq_qzone_comment`、`qq_qzone_reply_comment`、`qq_send_qzone` |
| 定时与静默 | 4 | `qq_schedule_message`、`qq_schedule_list`、`qq_schedule_cancel`、`qq_deepsleep` |
| 登录状态 | 1 | `qq_status` |
| 宿主与联网 | 7 | `qq_learning_corpus`、`qq_learning_submit`、`napcat_status`、`start_napcat`、`stop_napcat`、`web_search`、`web_fetch` |

权限约束：

- `qq_admin_set`、`qq_whitelist` 与 `qq_set_system_config` 仅在管理员私聊可用
- `qq_blacklist` 不能拉黑管理员，`qq_remove_friend` 不能删除管理员
- 发送类工具需要会话令牌，目标会话必须在名单内
- `social.tools` 开关在调用时拒绝，不减少请求体积；`social.slimTools` 在注册期排除，可减少请求体积
- 角色卡四个工具都是只读的，不会改动人设文件
- `napcat_status`、`start_napcat`、`stop_napcat` 属于进程控制，默认不注册，只在管理员私聊的 `default` 模式里可用
- 修改 `mcp-*.js` 后需要重启隔离 DSH

### Pixiv 搜图与发图

两个工具刻意分工：`qq_pixiv_search` **只查不发**、返回候选与筛选明细，`qq_send_pixiv` 负责真发（与"联网找图"同构，`qq-bridge/src/lib/pixiv.js`）。

- **镜像站只认 `keyword` 和 `page`**，其余全是本地筛：`tags`（须全部命中、按子串、大小写不敏感）、`author`、`orientation`、`minWidth` / `minHeight`、`multiPage`、`excludeAi`、`illustType`、`sort`、`r18`、`scanPages`。一页 60 条，`scanPages` 默认 3、上限 10；返回里的 `scan` / `scanNotice` 会如实说明扫了几页（**结果少 ≠ 全站少**）。排序只支持投稿时间（`date_desc` / `date_asc` / `random`），**不支持人气/收藏数**（镜像站返回体里没有收藏数，传 `popular`/`hot`/`rank` 会回落 `date_desc` 并在 `scan.warnings` 说明）。
- **R-18 的两个工具策略不同**：`qq_pixiv_search` 默认 `r18=exclude`，只有显式传 `only` / `include` 才放行；`qq_send_pixiv` **永远排除 R-18/R-18G**（刻意不给 r18 参数，避免把不宜内容发进 QQ）。要看 R-18 只能用搜索工具。
- **按号取原图**：`qq_send_pixiv` 给 `illustId`（作品号，或 `pixiv.net/artworks/<数字>` 链接）或 `authorId`（画师号）时，`size` 默认 `original` —— 发出去的就是 Pixiv 原图文件本身（直联 pximg、原字节落盘直发，不缩放不转码不二压，返回的 `sha256` / `bytes` 就是这次真发的字节）；只给 `query` 时默认 `size=master`（1200px jpg）。原图 >15MB 会被挡下并在返回里说明，改 `master`。
- **找"某位画师本人的作品"要用画师号**：关键词搜的是标题/标签含该词的图（搜「米山舞」多半是别人打了她名字标签的作品）。`qq_pixiv_search` 的 `author` 填名字 = 按 `userName` 子串匹配，填纯数字 = 按 `userId` 精确匹配（走镜像站数据，不需要登录态）。
- **按画师"名字"找号需要 pixiv 登录态**：`config.json` 的 `pixiv.cookie`（或环境变量 `QQBRIDGE_PIXIV_COOKIE`；`QQBRIDGE_PIXIV_COOKIE_OFF=1` 可临时停用而不删配置）。实测 `nick=米山舞` → 命中 `1554775:米山舞`，`nick=七菜` → 10 条同名候选；匿名请求会被 pixiv 判 400。实现要点：cookie **只发给 pixiv 自己的域名**，绝不带给第三方镜像站；**每次现读** config，贴上新 cookie 即时生效、不用重启 MCP 子进程；命中的名字→号会落盘缓存（`state/pixiv-artists.json`），所以 cookie 过期后已查过的名字照样能用；**没配就明确说"不支持"，不会悄悄退化成关键词搜**（那会给出错误答案）。填法容忍整条 cookie 串、`PHPSESSID=xxx` 或光秃秃的会话值。
- 镜像站地址在 `config.json` 的 `pixiv.base`（或环境变量 `QQBRIDGE_PIXIV_BASE`，同样每次现读）；登录态自检用 `pixivLoginState()` —— 拉"试纸作品"的 `urls.original`，比"看有没有配 cookie"可靠（cookie 会过期）。回归测试 `qq-bridge/tools/test-pixiv-filters.mjs`。

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

注入正文只包含数据，行为规则位于 preset。人设以 `[PERSONA]` 注入，发言风格以 `[SPEECH RULES]` 注入，管理员私聊带 `[OWNER]` 标记、其他私聊带 `[NOT-OWNER]` 标记。黑话表不注入上下文，需要时由模型调用 `qq_slang_query` 查询。

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
node tools\test-napcat-exit-kill.mjs
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
node qq-bridge\tools\test-send-latency.mjs
node qq-bridge\tools\test-music-card.mjs
node qq-bridge\tools\test-qq-card-sign.mjs
node qq-bridge\tools\test-pixiv-filters.mjs
```

`qq-bridge/tests/*.test.js` 是更细的单元测试（发送节奏、智能引用、幂等、打字保持、用量对账、语音等），逐个用 `node` 跑，或直接在 `qq-bridge` 目录执行 `npm run check`（顺带做作用域与体积检查、`node --check` 语法检查）。

### 打包

打包工程位于同级目录 `..\QQ-Bridge-packaging\`。

```powershell
cd ..\QQ-Bridge-packaging\moonbot-app

# full → ..\..\MoonBot Public\release\MoonBot Pro Setup.exe（对外发布的整套安装包）
node ..\tools\build-moonbot-app.mjs full
# core → MoonBot Pro Manager Setup.exe（管理端精简包，仅连远程服务器用）
node ..\tools\build-moonbot-app.mjs core

node ..\tools\verify-installer-content.ps1
```

出包脚本用 `artifactName` 把文件名固定为 `MoonBot Pro Setup.${ext}`，所以文件名不带版本号后缀；exe 本体与安装目录仍叫 `MoonBot`（`win.executableName`）。

发布流程：

1. 修改代码
2. 构建前端，执行 `npm run build`
3. 执行 `tools\sync-to-live.ps1`，确认输出 `DONE`
4. 执行打包脚本，脚本在打包前清理 payload 中的个人信息
5. 执行校验脚本，确认全部断言通过

## 常见问题

**安装位置**

运行数据（SQLite 记忆库、会话状态、日志、人设）都写在**安装目录里**，所以安装目录必须可写，且不能位于同步盘：

- 装在 `C:\Program Files` → 非管理员进程写不进去，或被 UAC 虚拟化"假写入"到 `%LOCALAPPDATA%\VirtualStore\`，表现为记忆库/人设对不上、数据库只读报错。安装包默认装到 `%LOCALAPPDATA%\Programs\MoonBot`，是安全的；别在安装向导里改成 `Program Files`。
- 装在 OneDrive / Dropbox / Google Drive / 坚果云 / 微云等同步盘 → SQLite 的 WAL 日志与文件锁会被云同步打断，可能出现 `database disk image is malformed`（记忆库打不开）、数据回滚、`memory.db (1)` 冲突副本。
- 网络映射盘 / UNC（`\\nas\share\...`）同样不行：网络文件系统上的文件锁不可靠。

想换位置：先退出管理端与所有组件，把整个安装目录**整体复制**到本地非同步盘（例如 `D:\MoonBot`），再改快捷方式指向新目录里的 `start-manager.vbs`。首页会在检测到风险位置时给出警告。

**界面或行为没有变化**

确认已执行 `tools\sync-to-live.ps1` 并看到 `DONE`，确认修改内容对应的进程已重启。

**机器人不回复**

依次检查桥接日志、管理端实例状态、隔离 DSH 状态与 NapCat 登录状态。首页实例卡片显示真实的探活结果与失败原因。

**窗口**

所有子进程以隐藏方式启动。守卫进程通过 WMI 创建并设置隐藏窗口，回归测试 `test-guardian-hidden-window.mjs` 校验该行为。

**远程部署失败**

先用 `tools\probe-ssh-banner.mjs` 确认端口可达。SSH 端口不一定是 22，管理器会记录上次可用端口。

部署会按需补齐目标机缺的基础环境：node 依次尝试 nodesource 官方源、apt、nodejs.org 官方 tarball；npm 随 tarball 自带或走 apt；基础工具走 apt。NapCat 默认按原生方式安装（官方 Linux QQ deb + `/opt/napcat` + `systemd` unit `napcat.service` + Xvfb + 非 root 用户 `qq`），只有目标机本来就在跑容器版时才走 docker 兜底。原生装机脚本是纯函数，出问题可以先离线做 `bash -n` 校验。

**掉线后要求重新扫码**

QQ 判断「是不是同一台设备」靠它自己从机器上读出的一组标识：`/etc/machine-id`、hostname、网卡 MAC，以及数据目录 `~/.config/QQ/nt_qq_<hash>`。容器重建或迁移会让这些标识变化，服务端就当新设备。

先在服务器上跑只读排查脚本 `qq-bridge\tools\diag-napcat-device.sh` 看证据，再按需跑 `qq-bridge\tools\pin-napcat-device.sh` 把 machine-id 与 hostname 钉死（钉完后的身份会记到 `/opt/napcat/config/device-pin.json`）。注意修改 hostname 本身会触发一次设备变更，只在确实需要时跑。

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
