# 更新日志

本文件按主题归纳 MoonBot 的用户可见变化，不逐条罗列提交标题。版本号遵循语义化版本；分组约定为「新增能力 / 修复 / 变更与不兼容 / 内部与工程」。

## 1.0.0 — 2026-09-18

首个公开发布版本。仓库在这一版之前从内部的 QQ-Bridge 仓库整体迁移而来，所以下面同时覆盖迁移前后的全部改动。

### 新增能力

- 管理端把隔离 DSH、NapCat、桥接层与模型服务商整合成一套 Windows 程序，提供安装、配置、拉起、探活、日志与停止（`server/index.js`、`src/App.tsx`）。
- 唤醒判定支持 19 种原因，涵盖被 @、被点名、直接提问、关键词、指定发言人、话题词、概率接话、戳一戳、私聊、主动闲聊、潜水到期、进入活跃时段、交付看门狗与各类恢复（`qq-bridge/src/core/wake-send.js`，规则见 `qq-bridge/dsh/agent-presets/qq-chat/preset.yml` 的 `[WAKE TYPES]`）。
- 潜水与活跃两套独立参数、群聊活跃时段（可列表化，群号不再写死）、回合保持、连发合并窗口、打字状态感知（`core/social-state.js`、`core/activity.js`、`core/turn-hold.js`、`core/typing-hold.js`），活跃时段由 `/api/social/targets` 下发。
- 人设与规则分层：规则固定在 preset，人设正文以 `[PERSONA]`、发言风格以 `[SPEECH RULES]` 交付，管理员私聊带 `[OWNER]`、其他私聊带 `[NOT-OWNER]`（`core/role-hint.js`、`core/prompt-deliver.js`）。
- 群友画像学习与关系图谱：群角色、互动强度、关系标注、模型自动标注关系（`core/portrait-learn.js`、`src/pages/GroupPortrait.tsx`、`src/pages/NetCanvas.tsx`），并提供单人完整资料接口，资料直读记忆库不做截断。
- 人格学习产出英文人设正文，支持「结合原人设完善」与「整篇覆盖」两种应用方式（`core/persona-learn.js`、`core/persona-text.js`）。
- 黑话学习带状态机，已确认词条不再注入上下文，改为按需调用 `qq_slang_query` 查询，省额度（`core/slang.js`、`src/slang-learner.js`）。
- 语音能力：接入小米 MiMo 语音，管理端独立语音页，并支持全语音发送模式（`core/voice.js`、`src/pages/VoiceConfig.tsx`）。
- 语音与表情包的发送概率改由桥侧掷骰决定，不再让模型自己估概率（`core/send-dice.js`）。
- 联网与视觉：网页搜索与抓取工具，看图规则改为直接读图，多平台聚合提速（`src/mcp-web-search-safe.js`、`src/lib/image-search.js`）。
- 富文本与媒体：图文卡、合并转发、Word 文档、QQ 原生表情、收藏表情、表情包、戳一戳、定时消息、跨会话留言、QQ 空间互动（`core/qq-send.js`、`core/send-chain.js`、`core/media.js`、`core/docx.js`、`core/qzone.js`、`core/sticker.js`）。
- 音乐卡片：网易云与 QQ 音乐点歌卡片，支持手机端点开播放（`core/media.js`、`music-sign-proxy.py`）。
- Pixiv 搜图支持镜像站地址可配、本地筛选与自动翻页（`qq-bridge/src/lib/pixiv.js`）。
- 发送节奏改为按单个字的速度计算，并支持用自然语言调整（`core/tunables.js`、`core/send-chain.js`）。
- Token 用量统计、费用估算与面板对账，面板常驻显示对账状态（`core/token-meter.js`、`core/learning-token.js`）。
- 管理端新增群聊活跃时段配置卡、NapCat 鉴权令牌卡、关闭界面时结束 NapCat 开关，并把 NapCat 卡拆成三张（`src/pages/BridgeConfig.tsx`、`src/pages/Home.tsx`、`src/components/NapcatTokensCard.tsx`）。
- NapCat 连接强化：主动探活、看门狗收紧到 45 秒、连接诊断进管理端、心跳重连统计、会话守护 `get_rkey` 探活、登录票据备份与登录态可见（`core/napcat-guard.js`、`lib/onebot-ws.js`）。
- SSH 远程能力：服务器列表、连接测试与端口纠偏、隧道、代码/数据/表情包/config.json 分别同步、一键克隆整套、清理远端（`src/pages/SSHConfig.tsx`、`server/deploy.js`）。
- 服务器端部署与克隆以原生优先：官方 Linux QQ + `/opt/napcat` + systemd unit + Xvfb + 非 root 用户，docker 兜底（`server/deploy.js`）。
- 设备身份固定：`qq-bridge/tools/pin-napcat-device.sh` 钉住 machine-id 与 hostname 并留档，`qq-bridge/tools/diag-napcat-device.sh` 一条命令输出全部排查证据。
- 关窗守卫以独立进程运行，退出管理端后兜底清理 NapCat（`server/napcat-guardian.mjs`）。

### 修复

- 桥接层发送遇到 NapCat 预热期错误会丢弃回复，改为自动重试；QQ 客户端瞬时错误（网络连接异常 / rich media transfer failed / EventChecker Failed）一并纳入重试。
- 服务端「发了消息不回」：坏会话刷屏与 90 秒兜底过长，已修。
- 服务器上改了 preset 却永远不生效。
- 部署「上传超时」与「dsh 明明装了却报未装上」：传输改用 SFTP + 字节复核，修掉 `gzip: stdin: unexpected end of file`。
- 漏传 key/token 导致 `-32602`，现在自动补齐，并清掉过时的工具入口文案。
- 推理档位不被服务商支持时退回服务商默认，不再把「没配」当成 max。
- 表情包发不出去、引用错误、重复失败烧额度；新增角色卡只读工具。
- `/reset` 之后重复回复一次：加幂等闸门，并修掉 `atUserId` 误传导致的降级。
- 思考期间到达的消息不再被塞进下一个唤醒，改以 `[Mid-turn]` 注入当前回合；打字期间消息全部入队只注入一次。
- 智能引用改成「默认不引用」：回答最新那条不挂引用框，多条候选零共同词不自动引用，并把自动引用如实告知模型。
- 非 owner 私聊不再被误称 owner（`[NOT-OWNER]` 标记 + 预设与人设写死禁止误称）。
- 学过的黑话不再变回候选，并修好「研究链从来没跑成」导致的候选堆积。
- 人格档案改成一段完整介绍，不再重复、不再半句截断、不再占用「备注」字段。
- 归档器在服务器上一直空转（`sessionsRoot=null`），现在覆盖全部工作区并清理本机残留工作区。
- 启动自愈：清掉指向已删会话的映射，不再让事件泵空转刷「follow 流终结」。
- NapCat 令牌真正写进 NapCat 配置并重启；令牌卡与连接卡去重，新增「用桥里现有的令牌写入」一键对齐。
- NapCat「桥聋了、只刷心跳假死、永不重连」：改为判死即重建。
- NapCat 登录态刷取过频被限流报「查不到」，已降低频率。
- SSH 断线自动重连，启动时自动连回来，界面显示「服务端重连中…」；隧道自愈；卡片不再悄悄切回本机。
- 桥连不上时不再显示「失败：fetch failed」，改为区分「没在运行」与真失败。
- Token 用量面板与 DSH 的会话级权威计数对齐，修掉「面板忽高忽低」的两个真实成因。
- 管理端在服务端离线时用量仍计入合计。
- 群名拉取失败改走群列表回退。
- 图片下载超时改用 URL 兜底，更快。
- 默认音色没被用上（模型自己指定了内置冰糖），已修。
- 打包 payload 不再夹带开发期产物；`config.example.json` 与 `start-bridge.sh` 随包同步。
- `[COMPREHEND]` 补齐「把未读当对话延续」与「少发问」；看图规则改为直接读图；语义与上下文规则强化。
- 网易云卡片可以点播放了，且不再弹「将要访问」中转页。
- QQ 音乐卡不再因为 `songmid` 对不上就退化成纯链接。
- 手机端音乐卡封面为空：真因是签名服务取不到腾讯 CDN 的图，最终改为封面逐张探活、优先用桥自己解析的那张。
- 管理端粉色板里的滚动区铺到板底不再留空；右卡不参与行高计算，整行不被拉长。
- 删除容器时代遗留的「免扫码回退登录」卡。
- vite dev server 绑定 `127.0.0.1:5173`（原本与后端抢端口，且绑 `localhost` 只监听 `::1`）。

### 变更与不兼容

- 仓库从内部的 QQ-Bridge 整体迁移到 MoonBot Public，并做公开仓库脱敏；界面上的 GitHub 徽标指向 MoonBot 仓库。
- 版本号定为 `1.0.0`，产品名与安装包统一为 MoonBot Pro：对外为 `MoonBot Pro Setup.exe`，另提供只含管理端的 `MoonBot Pro Manager Setup.exe`。
- 服务器端部署与克隆从 docker 改成原生优先（systemd + 官方 Linux QQ），探测已有 `napcat.service` 就走 systemd。
- 打字节拍只保留「按字数」一种，删掉多余的另外两套。
- 黑话指令只保留 `/slang 学习`、`/slang learn`、`/slang 停止`、`/slang stop`，代码不再识别 `/slanglearn`、`/slangstop` 与无空格中文写法。
- 已确认的黑话不再注入上下文，需要时由模型自行查询。
- 表情工具改名为 `qq_meme_search` / `qq_send_meme`。
- 智能引用由「尽量引用」改为「默认不引用」。
- 默认音色与语音锚点固定，模型不再自行指定内置音色。
- 群唤醒上限收到 30；「活跃模式」改用自己的一套参数，不再沿用潜水那套。
- 安装包默认按用户装到 `%LOCALAPPDATA%\Programs\MoonBot`，安装向导可改目录。
- 仓库术语统一：文档一律用「管理员」表述，不再混用其它叫法。
- 去掉了开发初版鲸鱼人设的痕迹。

### 内部与工程

- README 重写并按桥接层源码实测逐项修订（架构图、逐目录说明、界面/API/工具/命令、唤醒原因、媒体阈值、工具权限与 `state` 清单）。
- 原生装机脚本抽成纯函数，可离线做 `bash -n` 与 systemd 校验（验证脚本随 `server/deploy.js`）。
- 五份分散的设备指纹排查脚本合并成一份 `qq-bridge/tools/diag-napcat-device.sh`。
- 新增三个 Pixiv 镜像站参数探针，实测它到底认哪些搜索参数（`qq-bridge/tools/probe-pixiv-params.mjs` 等）。
- 工具 schema 体积表改为现场实测生成，补上漏登记的 12 个工具（`qq-bridge/tools/emit-tool-chars.mjs`、`src/tool-schema-chars.ts`）。
- 界面文案中文化审计与渲染校验脚本（`tools/audit-ui-labels.mjs`、`tools/verify-rendered-labels.mjs`）。
- 回归测试扩充：唤醒协议、斜杠命令、steer 批处理与闸门、配置热重载、NapCat 启动重试、`qq-hold`、发送延迟、音乐卡、Pixiv 筛选、平台模型列表、守卫武装与隐藏窗口等（`tools/test-*.mjs`、`qq-bridge/tools/test-*.mjs`、`qq-bridge/tests/*.test.js`）。
- 交接文档一律本机专用，含服务器信息的 `HANDOFF*`、`CTX`、`PROJECT_GUIDE` 等不进公开仓库。
- 打包流程与校验脚本：出包前清理 payload 中的个人信息，出包后跑内容校验。
- 开发期端口冲突修复与 `.gitignore` 收口。
