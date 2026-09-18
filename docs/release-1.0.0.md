# MoonBot Pro 1.0.0

把 NapCat、QQ 桥接层、DeepSeek Harness 与模型服务商整合成一套可安装的 Windows 程序：装完扫码登录 QQ、填一次模型密钥，就能让机器人在群里和私聊里长期在线地聊天，并在图形界面里配置、巡检和远程部署整套环境。

> 发布日期：2026-09-18　·　安装包：`MoonBot Pro Setup.exe`

## 主要能力

- **一套程序管五个部件。** 管理端以 Electron 壳启动后端（`server/index.js`），由后端负责拉起、探活、记录日志与停止隔离 DSH、NapCat 与桥接层（`qq-bridge/src/bridge.js`）。所以用户不需要手工开终端、记端口、对着四份配置文件排错。

- **群聊与私聊对话。** 桥接层按 19 种唤醒原因决定是否接话，包括被 @、被点名、直接提问、命中关键词、命中指定发言人、戳一戳、概率接话、主动闲聊、进入活跃时段、潜水到期等（判定与投递在 `qq-bridge/src/core/wake-send.js`）。所以机器人既能被叫才答，也能在群里自然接话，而不是每条消息都烧一遍额度。

- **人设与发言规则分层。** 行为规则固定在 agent preset（`qq-bridge/dsh/agent-presets/qq-chat/`），人设正文与发言风格由桥在唤醒时以 `[PERSONA]` 与 `[SPEECH RULES]` 注入（`qq-bridge/src/core/role-hint.js`、`dsh/agent-presets/qq-chat/preset.yml`）。所以换人设不用改代码，改完下一条消息就生效。

- **三类学习。** 群友画像、人格、黑话各自独立成链：画像学习在 `qq-bridge/src/core/portrait-learn.js`，人格学习在 `qq-bridge/src/core/persona-learn.js`，黑话学习在 `qq-bridge/src/core/slang.js` 与 `qq-bridge/src/slang-learner.js`。所以机器人对一个群的了解会随时间积累，而不是每次从零开始猜。

- **群友关系图谱。** 管理端的画像页把群角色、互动强度、关系标注画成关系图（前端 `src/pages/GroupPortrait.tsx`、`src/pages/NetCanvas.tsx`，后端 `/api/learning/graph` 与 `/api/learning/relations`）。所以用户能一眼看出谁和谁熟，而不是翻聊天记录。

- **联网与视觉。** 桥向 agent 注册 QQ/NapCat 工具组（`qq-bridge/src/mcp-napcat-safe.js`）、学习语料与进程控制组（`qq-bridge/src/mcp-host-server.js`）以及联网搜索与抓取（`qq-bridge/src/mcp-web-search-safe.js`）。所以机器人能主动搜索、看图和读文件消息，而不是只能照抄上下文。

- **富文本发送。** 支持图文卡、合并转发、Word 文档、QQ 原生表情、收藏表情、戳一戳、定时消息、跨会话留言与 QQ 空间互动（`qq-bridge/src/core/qq-send.js`、`send-chain.js`、`core/media.js`、`core/docx.js`、`core/qzone.js`）。所以机器人发出来的东西接近真人在手机上发出来的样子。

- **音乐卡片。** 点歌会拼装成可以在手机端点开播放的卡片，封面逐张探活后再用（`qq-bridge/src/core/media.js`，签名与转发见 `qq-bridge/music-sign-proxy.py`，回归见 `qq-bridge/tools/test-music-card.mjs`）。

- **语音。** 接入小米 MiMo 语音，管理端有独立的语音页与全语音发送开关（`src/pages/VoiceConfig.tsx`、`qq-bridge/src/core/voice.js`）。所以机器人可以发语音，语音/表情包的发送概率由桥侧掷骰决定（`qq-bridge/src/core/send-dice.js`），不再让模型自己猜概率。

- **Pixiv 搜图。** 支持镜像站地址可配、本地筛选与自动翻页（`qq-bridge/src/lib/pixiv.js`，回归测试 `qq-bridge/tools/test-pixiv-filters.mjs`）。所以找图不用登录 Pixiv 账号。

- **SSH 远程部署与一键克隆。** 服务器列表、隧道、代码/数据/表情包/config.json 分别同步、整套克隆与清理远端都在管理端的 SSH 页完成（`src/pages/SSHConfig.tsx`、`server/deploy.js`）。所以机器人可以从本机搬到服务器上继续跑，登录态和数据一起带走。

- **Windows 与 Linux 都能跑。** 1.0.0 起服务器端部署以原生为准：官方 Linux QQ + `/opt/napcat` + systemd unit `napcat.service` + Xvfb + 非 root 用户 `qq`（`server/deploy.js` 的 `installNapcatNative()`），docker 只作兜底。所以服务器上少一层容器，也少一类路径映射问题。

- **关窗即停。** 退出管理端时，壳先请求后端停止桥与隔离 DSH，再由独立的守卫进程 `server/napcat-guardian.mjs` 兜底清理 NapCat。所以用户不需要事后去任务管理器杀残留进程。

## 本版重点

- **版本号与产物名统一。** 版本号定为 `1.0.0`，产品名统一为 MoonBot Pro，对外安装包固定为 `MoonBot Pro Setup.exe`（另有一份只含管理端的 `MoonBot Pro Manager Setup.exe`，用于远程连服务器）。安装包文件名不带版本号后缀，出包脚本用 `artifactName` 固定（见仓库同级打包工程的 `tools/build-moonbot-app.mjs`），安装目录仍按用户装到 `%LOCALAPPDATA%\Programs\MoonBot`。

- **部署与克隆从 docker 改成原生优先。** 探针 `napcatModeCmd()` 先看有没有 `napcat.service`，有就走 systemd，没有才回退容器；装机脚本被抽成纯函数，可以离线用 `bash -n` 验证。所以从容器迁到原生、或直接克隆出一台原生环境都不会中途卡死。

- **NapCat 连接稳定性。** 主动探活 + 看门狗（90s 收紧到 45s）+ 心跳重连统计 + 连接诊断进了管理端（`qq-bridge/src/core/napcat-guard.js`、`qq-bridge/src/lib/onebot-ws.js`）；会话守护用 `get_rkey` 探活，假死即自愈；登录票据会备份，重启前先判登录态。

- **设备身份固定。** 反复出现"掉线后报检测到设备异常、必须扫码"，根因是 QQ 读到的一组机器标识在容器里不稳定。`qq-bridge/tools/pin-napcat-device.sh` 把 machine-id 与 hostname 钉死并记录到 `/opt/napcat/config/device-pin.json`，`qq-bridge/tools/diag-napcat-device.sh` 一条命令打出全部证据。两个脚本是 1.0.0 之前的五份分散排查脚本合并而来的。

- **音乐卡片。** 网易云与 QQ 音乐卡片这一版被反复修：手机端封面空白、点不了播放、弹"将要访问"中转页、封面被聚合站的坏图顶掉、标题与歌曲对不上。最终形态是签名服务 + 不带 `audio`、封面逐张探活、优先用桥自己解析的那张，并按真机分享的图文卡形状组装。

- **工具 schema 精简真正生效。** 精简名单过去因为没做 MCP 前缀归一化而形同虚设，现在 `mcp__napcat__qq_x` 与 `qq_x` 等价（`qq-bridge/src/mcp-napcat-safe.js` 的 `bareToolName()`）。管理端的工具 schema 表也改成现场实测，补上了漏登记的 12 个工具（`tools/emit-tool-chars.mjs`、`src/tool-schema-chars.ts`）。

- **Pixiv 搜图本地筛选 + 自动翻页。** 镜像站只认 `keyword` 与 `page`，其余参数全被忽略，所以筛选改在已抓回来的数据上做，并按 `scanPages` 自动往后翻（默认 3 页、上限 10 页）；返回里会如实写明"只扫了 N 页、全站共多少条"。

- **界面全面中文化。** 界面残留的英文配置键全部换成中文（`tools/audit-ui-labels.mjs`、`tools/verify-rendered-labels.mjs` 做审计与校验）。

## 修复

- 桥接层发消息时遇到 NapCat 预热期错误会把回复丢掉，现在会自动重试；QQ 客户端的瞬时错误（网络连接异常 / rich media transfer failed / EventChecker Failed）也纳入重试。
- 服务端"发了消息不回"：坏会话刷屏与 90 秒兜底过长，已修。
- 服务器上改了 preset 却永远不生效。
- 部署时"上传超时"与"dsh 明明装了却报未装上"：传输改用 SFTP + 字节复核，修掉 `gzip: stdin: unexpected end of file`。
- 漏传 key/token 导致工具调用报 `-32602`，现在自动补齐。
- 推理档位不被服务商支持时会退回服务商默认，不再把"没配"当成 max。
- 表情包发不出去、引用错误、重复失败烧额度。
- `/reset` 之后重复回复一次：加了幂等闸门，并修掉 `atUserId` 误传导致的降级。
- 思考期间到达的消息不再被塞进下一个唤醒，改以 `[Mid-turn]` 注入当前回合；打字期间的消息全部入队、只注入一次。
- 智能引用改成"默认不引用"：回答最新那条就不挂引用框，多条候选零共同词也不自动引用。
- 陌生人加好友被误称 owner：非 owner 私聊显式带 `[NOT-OWNER]` 标记，预设与人设写死不能误称。
- 学过的黑话不再变回候选；修好"研究链从来没跑成"导致的候选堆积。
- 人格档案改成一段完整介绍，不再重复、不再半句截断、不再占用"备注"字段。
- 归档器在服务器上一直空转（`sessionsRoot=null`），现在覆盖全部工作区并清理本机残留工作区。
- 启动自愈：清掉指向已删会话的映射，不再让事件泵空转刷"follow 流终结"。
- NapCat 令牌真正写进 NapCat 配置并重启；令牌卡与连接卡去重，并提供"用桥里现有的令牌写入"一键对齐。
- SSH 断线自动重连，管理端界面显示"服务端重连中…"；隧道自愈；卡片不再悄悄切回本机。
- 桥连不上时不再显示"失败：fetch failed"，改为区分"没在运行"与真失败。
- Token 用量面板与 DSH 的会话级权威计数对齐，修掉"面板忽高忽低"的两个真实成因，并常驻显示对账状态。
- 管理端在服务端离线时用量仍计入合计。
- 群名拉取失败改走群列表回退。
- 图片下载超时改用 URL 兜底，更快。
- 默认音色没被用上（模型自己指定了内置冰糖）。
- 导入安装包时不再夹带开发期产物，`config.example.json` 与 `start-bridge.sh` 随包同步。
- 修 `[COMPREHEND]` 缺失的"把未读当对话延续"与"少发问"规则；看图规则改为直接读图；语义与上下文规则强化。
- 网易云卡片可以点播放，且不再弹"将要访问"中转页。
- QQ 音乐卡不再因为 `songmid` 对不上就退化成纯链接。
- 管理端粉色板里的滚动区铺到板底不再留空，右卡不参与行高计算、整行不被拉长。
- NapCat 登录态刷多了被限流报查不到，已降低刷取频率。
- 删掉容器时代遗留的"免扫码回退登录"卡。

## 已知限制

- **Pixiv 镜像站搜索不支持服务端排序与筛选。** 实测镜像站只认 `keyword` 与 `page`，`mode`、`s_mode`、`order`、`p`、`bl`、`type` 等参数全部被忽略；返回体里没有收藏数，所以只能按投稿时间排序，传"按人气/热度排序"会被回落成时间倒序并在 `warnings` 里写明原因。镜像站 `lastPage` 恒为 10，且越界页仍会返回 60 条兜底数据，因此自动翻页一律卡在 `lastPage` 内，不会去扫越界页。

- **不少能力依赖外部服务，这些服务不可用时会直接失败或退化。** 模型推理依赖所配置的服务商 API；联网搜索与网页抓取依赖 `web_search` / `web_fetch` 的上游；语音依赖小米 MiMo；音乐卡片依赖音乐聚合站与签名服务；Pixiv 搜图依赖镜像站；QQ 空间互动依赖腾讯侧接口。这类失败会在桥接日志与工具返回值里体现，程序本身不做离线降级。

- **NapCat 需要扫码登录，登录态不随安装包分发。** 镜像或迁移服务器、容器重建都可能让 QQ 判定为新设备而要求重新扫码。`qq-bridge/tools/pin-napcat-device.sh` 只能降低概率，不能保证不扫——钉身份时修改 hostname 本身也会触发一次设备变更。

- **安装目录必须可写，且不能放在同步盘或网络盘。** 聊天记忆库（SQLite）、会话状态、人设与日志全部写在安装目录里。装在 `C:\Program Files` 会被 UAC 虚拟化"假写入"，装在 OneDrive / Dropbox / 坚果云等同步盘或 UNC 路径上可能因 WAL 与文件锁失效而让记忆库损坏。安装包默认装到 `%LOCALAPPDATA%\Programs\MoonBot`，首页也会在检测到风险位置时给出警告。

- **音乐卡的版式取决于 QQ 客户端。** 手机端封面能否显示，取决于签名服务能否取到腾讯 CDN 的图；某些版式（如 `music.lua` 那种）在手机端本来就不画封面。这部分不是完全可控的。

- **管理端只提供 Windows 10/11 版本**；远程部署的目标机假定为 Debian/Ubuntu 系 Linux（脚本走 apt / systemd）。其他发行版没有验证过。

- **工具的精简有两种语义，容易混淆。** `social.slimTools` 在注册期排除工具，能减少每次请求的体积；`social.tools` 只在调用期拒绝，不减少体积。前者需要重启隔离 DSH 才会重新计算。

- **唤醒与发送受 QQ 风控影响。** 群聊发送频率、被 @ 频率、主动开口频率过高都可能触发限制，本版把群唤醒上限收到 30 并给"活跃模式"单列了一套参数，但没有、也无法彻底规避风控。

- **黑话、人格、画像三类学习的产出质量取决于聊天样本量。** 样本太少时学到的东西会偏，管理端只做展示与人工确认，不做正确性保证。

- **本版未对工具总数给出保证。** 工具清单随代码变动，管理端内的 schema 表以现场实测为准；README 与文档里列出的清单可能落后于实际注册结果。
