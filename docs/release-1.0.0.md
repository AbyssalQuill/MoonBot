# MoonBot Pro 1.0.0 版本说明

本文界定 MoonBot Pro 1.0.0 的构成、版本变更、缺陷修复与已知限制。文中所有命令、路径、端口、常量与版本号均为
可执行原值；能力描述为构成性描述，不含评价性表述。

## 目录

```text
0. 术语与证据等级
1. 版本标识与交付物
2. 能力构成
3. 版本变更
4. 缺陷修复
5. 已知限制
6. 未核验声明
```

**证据等级**：`【已核验】` 表示读过源码或跑过命令；`【据仓库记载】` 表示引自其它文档并给出处；`【未核验】`
表示推断或未复现。

---

## 0. 术语与证据等级

本章界定本文使用的交付物名称与证据标记。术语首次出现给出“中文（English / 代码标识符）”三件套，其后固定使用
该词。

表 1：术语表（口径：全文统一使用下表术语）

| 术语 | 代码标识符 / 原文 | 界定 |
| --- | --- | --- |
| 管理端 | `MoonBot Pro Manager Setup.exe` 所安装的程序 | Electron 壳与后端组成的图形界面程序，负责拉起、探活、记录日志与停止各子进程 |
| 桥接层 | `qq-bridge/src/bridge.js` | 独立 Node.js 进程，负责 QQ 消息接入、社交状态机与 DSH 投递 |
| 隔离 DSH | 隔离实例 | 由管理端拉起的 DeepSeek Harness 实例，与用户自己的 DSH 会话隔离 |
| 原生部署 | `installNapcatNative()` | 以官方 Linux QQ 与 systemd 服务承载 NapCat 的部署形态 |

---

## 1. 版本标识与交付物

本章界定本版的版本号、产品名与安装包标识。

表 2：版本标识（口径：值为构建与分发时固定的标识）

| 项 | 值 |
| --- | --- |
| 版本号 | `1.0.0` |
| 产品名 | MoonBot Pro |
| 发布日期 | 2026-09-18 |
| 主安装包 | `MoonBot Pro Setup.exe` |
| 管理端安装包 | `MoonBot Pro Manager Setup.exe`（仅含管理端，用于远程连接服务器） |
| 默认安装目录 | `%LOCALAPPDATA%\Programs\MoonBot` |

安装包文件名不带版本号后缀，由出包脚本以 `artifactName` 固定（出包脚本位于同级打包工程的
`tools/build-moonbot-app.mjs`）。

集成构成：NapCat、QQ 桥接层、DeepSeek Harness 与模型服务商被整合为单一可安装的 Windows 程序。安装完成后的
必填交互只有两项：扫码登录 QQ，以及填写一次模型密钥。

---

## 2. 能力构成

本章界定本版对外提供的能力域及其实现位置。

表 3：能力域与实现位置（口径：实现位置为相对仓库根的路径；触发条件为该能力生效的前提）

| 能力域 | 实现位置 | 构成说明 |
| --- | --- | --- |
| 进程管理 | `server/index.js`、`qq-bridge/src/bridge.js` | 管理端以 Electron 壳启动后端，后端负责拉起、探活、记录日志与停止隔离 DSH、NapCat 与桥接层 |
| 群聊与私聊对话 | `qq-bridge/src/core/wake-send.js` | 桥接层按 19 种唤醒原因判定是否接话，包括被 @、被点名、直接提问、命中关键词、命中指定发言人、戳一戳、概率接话、主动闲聊、进入活跃时段、潜水到期等 |
| 人设与发言规则分层 | `qq-bridge/dsh/agent-presets/qq-chat/`、`qq-bridge/src/core/role-hint.js`、`dsh/agent-presets/qq-chat/preset.yml` | 行为规则固定在 agent preset；人设正文与发言风格由桥在唤醒时以 `[PERSONA]` 与 `[SPEECH RULES]` 注入。更换人设不需修改代码，改动于下一条消息生效 |
| 三类学习 | `qq-bridge/src/core/portrait-learn.js`、`qq-bridge/src/core/persona-learn.js`、`qq-bridge/src/core/slang.js`、`qq-bridge/src/slang-learner.js` | 群友画像、人格、黑话各自独立成链，对群的了解随时间累积 |
| 群友关系图谱 | `src/pages/GroupPortrait.tsx`、`src/pages/NetCanvas.tsx`、`/api/learning/graph`、`/api/learning/relations` | 管理端画像页把群角色、互动强度与关系标注绘制为关系图 |
| 工具注册面 | `qq-bridge/src/mcp-napcat-safe.js`、`qq-bridge/src/mcp-host-server.js`、`qq-bridge/src/mcp-web-search-safe.js` | 桥向 agent 注册 QQ / NapCat 工具组、学习语料与进程控制组，以及联网搜索与抓取 |
| 富文本发送 | `qq-bridge/src/core/qq-send.js`、`send-chain.js`、`core/media.js`、`core/docx.js`、`core/qzone.js` | 支持图文卡、合并转发、Word 文档、QQ 原生表情、收藏表情、戳一戳、定时消息、跨会话留言与 QQ 空间互动 |
| 音乐卡片 | `qq-bridge/src/core/media.js`、`qq-bridge/music-sign-proxy.py`、`qq-bridge/tools/test-music-card.mjs` | 点歌组装为可在手机端播放的卡片，封面逐张探活后使用；签名与转发由 `music-sign-proxy.py` 承担 |
| 语音 | `src/pages/VoiceConfig.tsx`、`qq-bridge/src/core/voice.js`、`qq-bridge/src/core/send-dice.js` | 接入小米 MiMo 语音；管理端提供独立语音页与全语音发送开关；语音与表情包的发送概率由桥侧随机判定决定 |
| Pixiv 搜图 | `qq-bridge/src/lib/pixiv.js`、`qq-bridge/tools/test-pixiv-filters.mjs` | 支持镜像站地址可配、本地筛选与自动翻页；检索不依赖 Pixiv 账号登录 |
| SSH 远程部署 | `src/pages/SSHConfig.tsx`、`server/deploy.js` | 服务器列表、隧道、代码与数据与表情包与 `config.json` 的分项同步、整套克隆与远端清理均在管理端 SSH 页完成 |
| 跨平台部署 | `server/deploy.js` 的 `installNapcatNative()` | 服务器端部署自 1.0.0 起以原生为准：官方 Linux QQ、`/opt/napcat`、systemd unit `napcat.service`、Xvfb、非 root 用户 `qq`；docker 仅作后备 |
| 退出清理 | `server/napcat-guardian.mjs` | 退出管理端时，壳先请求后端停止桥与隔离 DSH，再由独立守卫进程清理 NapCat |

---

## 3. 版本变更

本章界定 1.0.0 相对前一版本的变更项、机制与实现位置。

### 3.1 版本号与产物名统一

版本号定为 `1.0.0`，产品名统一为 MoonBot Pro，对外安装包固定为 `MoonBot Pro Setup.exe`，另有仅含管理端的
`MoonBot Pro Manager Setup.exe`，用于远程连接服务器。安装包文件名不带版本号后缀，由出包脚本以 `artifactName`
固定（`tools/build-moonbot-app.mjs`）；安装目录仍按用户安装路径 `%LOCALAPPDATA%\Programs\MoonBot`。

### 3.2 部署形态由容器改为原生优先

探针 `napcatModeCmd()` 先检查是否存在 `napcat.service`：存在则以 systemd 承载，不存在时回退容器。装机脚本被抽取
为纯函数，可用 `bash -n` 离线校验。因此由容器迁移到原生形态，或直接克隆出原生环境的路径均不再中断。

### 3.3 NapCat 连接稳定性

- 主动探活与看门狗：看门狗阈值由 90 s 收紧到 45 s。
- 心跳重连统计与连接诊断进入管理端。
- 会话守护以 `get_rkey` 探活，无响应即自愈。
- 登录票据做备份，重启前先判定登录态。

实现位置：`qq-bridge/src/core/napcat-guard.js`、`qq-bridge/src/lib/onebot-ws.js`。

### 3.4 设备身份固定

现象：“掉线后报检测到设备异常、要求重新扫码”反复出现。机制：QQ 读取的一组机器标识在容器内不稳定。
现行实现：`qq-bridge/tools/pin-napcat-device.sh` 固定 machine-id 与 hostname，并把结果记录到
`/opt/napcat/config/device-pin.json`；`qq-bridge/tools/diag-napcat-device.sh` 以单条命令输出全部证据。
两个脚本由 1.0.0 之前的五份分散排查脚本合并而来。

### 3.5 音乐卡片

本版对网易云与 QQ 音乐卡片做了多轮修订，涉及的现象包括手机端封面空白、无法触发播放、弹出“将要访问”中转页、
封面被聚合站的损坏图像替换、标题与歌曲不匹配。最终形态为：签名服务加不带 `audio` 的卡片、封面逐张探活、优先
使用桥自身解析的封面，并按真机分享的图文卡形状组装。

### 3.6 工具 schema 精简生效

精简名单此前的实现缺少 MCP 前缀归一化，因而未生效；现行实现中 `mcp__napcat__qq_x` 与 `qq_x` 等价
（`qq-bridge/src/mcp-napcat-safe.js` 的 `bareToolName()`）。管理端的工具 schema 表改为在线实测，补登记了
12 个此前遗漏的工具（`tools/emit-tool-chars.mjs`、`src/tool-schema-chars.ts`）。

### 3.7 Pixiv 搜图本地筛选与自动翻页

镜像站只接受 `keyword` 与 `page` 参数，其余参数全部被忽略，因此筛选实现于已抓取的数据之上，并按 `scanPages`
自动向后翻页（默认 3 页、上限 10 页）。返回值如实写明“只扫了 N 页、全站共多少条”。

### 3.8 界面中文化

界面残留的英文配置键全部替换为中文；审计与校验脚本为 `tools/audit-ui-labels.mjs`、`tools/verify-rendered-labels.mjs`。

---

## 4. 缺陷修复

本章界定本版修复的缺陷及其判据。表中“现象”列为修复前的观测值，“现行行为”列为修复后的实现。

表 4：桥接层与投递链缺陷修复（口径：现象列为修复前观测；实现列为现行行为）

| 编号 | 现象 | 现行行为 |
| --- | --- | --- |
| F1 | 桥接层发消息遇到 NapCat 预热期错误时丢弃回复 | 自动重试；QQ 客户端的瞬时错误（网络连接异常、`rich media transfer failed`、`EventChecker Failed`）纳入重试 |
| F2 | 服务端发了消息不回 | 坏会话刷屏与 90 秒后备超时过长，已修复 |
| F3 | 服务器上修改 preset 后不生效 | 修改后生效 |
| F4 | 部署时报“上传超时”，或 DSH 已安装却报未装上 | 传输改用 SFTP 加字节复核，修复 `gzip: stdin: unexpected end of file` |
| F5 | 漏传 key / token 导致工具调用报 `-32602` | 自动补齐 |
| F6 | 推理档位不被服务商支持时被当作 max | 退回服务商默认值，不再把“未配置”当作 max |
| F7 | 表情包无法发送、引用错误、重复失败消耗额度 | 已修复 |
| F8 | `/reset` 之后重复回复一次 | 增加幂等闸门，并修复 `atUserId` 误传导致的降级 |
| F9 | 思考期间到达的消息被推入下一个唤醒 | 改以 `[Mid-turn]` 注入当前回合；打字期间的消息全部入队，且只注入一次 |
| F10 | 智能引用在多候选场景自动引用 | 改为默认不引用：回答最新一条时不挂引用框；多条候选且零共同词时不自动引用 |
| F11 | 陌生人加好友被误称 owner | 非 owner 私聊显式携带 `[NOT-OWNER]` 标记，预设与人设写死不得误称 |
| F12 | 已学习的黑话回退为候选 | 修好“研究链从未执行成功”导致的候选堆积 |
| F13 | 人格档案重复、半句截断、占用“备注”字段 | 改为一段完整介绍 |
| F14 | 归档器在服务器上持续空转（`sessionsRoot=null`） | 覆盖全部工作区并清理本机残留工作区 |
| F15 | 启动时事件泵空转刷 `follow 流终结` | 清除指向已删会话的映射 |
| F16 | NapCat 令牌未写入 NapCat 配置 | 令牌写入配置并重启；令牌卡与连接卡去重，并提供“用桥里现有的令牌写入”的单次对齐操作 |
| F17 | SSH 断线后不重连、隧道不自愈、卡片切回本机 | 自动重连，界面显示“服务端重连中…”；隧道自愈；卡片不切回本机 |
| F18 | 桥连不上时统一显示“失败：fetch failed” | 区分“未运行”与真实失败 |
| F19 | Token 用量面板与 DSH 会话级计数不一致 | 与 DSH 的会话级权威计数对齐，修复两个成因，并常驻显示对账状态 |
| F20 | 服务端离线时用量不计入合计 | 计入合计 |
| F21 | 群名拉取失败 | 走群列表回退 |
| F22 | 图片下载超时 | 改用 URL 后备路径 |
| F23 | 默认音色未被使用 | 模型指定内置冰糖的行为已修正 |

表 5：表达与预设缺陷修复（口径：现象列为修复前观测；实现列为现行行为）

| 编号 | 现象 | 现行行为 |
| --- | --- | --- |
| F24 | 导入安装包时夹带开发期产物 | 不再夹带；`config.example.json` 与 `start-bridge.sh` 随包同步 |
| F25 | `[COMPREHEND]` 缺失“把未读当对话延续”与“少发问”规则 | 补齐该两条规则；看图规则改为直接读图；语义与上下文规则强化 |
| F26 | 网易云卡片无法点播放并弹“将要访问”中转页 | 可播放，且不再弹中转页 |
| F27 | QQ 音乐卡因 `songmid` 不匹配退化为纯链接 | 不再退化 |
| F28 | 管理端粉色板的滚动区未铺到板底 | 滚动区铺满；右卡不参与行高计算，整行不被拉长 |
| F29 | NapCat 登录态刷新过频被限流 | 降低刷新频率 |
| F30 | 容器时代遗留的“免扫码回退登录”卡 | 已删除 |

---

## 5. 已知限制

本章界定本版已知的限制、影响面与判据。

表 6：已知限制清单（口径：影响列为用户可观测的后果；判据列为约束来源）

| 编号 | 限制 | 影响 | 判据 |
| --- | --- | --- | --- |
| L1 | Pixiv 镜像站搜索不支持服务端排序与筛选 | 只能按投稿时间排序；“按人气/热度排序”回落为时间倒序并在 `warnings` 写明原因 | 实测镜像站只接受 `keyword` 与 `page`，`mode`、`s_mode`、`order`、`p`、`bl`、`type` 等参数全部被忽略；返回体不含收藏数。镜像站 `lastPage` 恒为 10，越界页仍返回 60 条后备数据，因此自动翻页限制在 `lastPage` 之内 |
| L2 | 多项能力依赖外部服务 | 外部服务不可用时直接失败或退化；失败在桥接日志与工具返回值中体现，程序不做离线降级 | 模型推理依赖所配置的服务商 API；联网搜索与网页抓取依赖 `web_search` / `web_fetch` 的上游；语音依赖小米 MiMo；音乐卡片依赖音乐聚合站与签名服务；Pixiv 搜图依赖镜像站；QQ 空间互动依赖腾讯侧接口 |
| L3 | NapCat 需要扫码登录，登录态不随安装包分发 | 镜像服务器、迁移服务器或重建容器都可能使 QQ 判定为新设备并要求重新扫码 | `qq-bridge/tools/pin-napcat-device.sh` 只能降低概率，不能保证免扫码；固定身份时修改 hostname 本身会触发一次设备变更 |
| L4 | 安装目录必须可写，且不能位于同步盘或网络盘 | 装在 `C:\Program Files` 会被 UAC 虚拟化导致写入不落盘；装在 OneDrive / Dropbox / 坚果云等同步盘或 UNC 路径上可能因 WAL 与文件锁失效而损坏记忆库 | 聊天记忆库（SQLite）、会话状态、人设与日志全部写入安装目录；安装包默认装到 `%LOCALAPPDATA%\Programs\MoonBot`，首页在检测到风险位置时给出警告 |
| L5 | 音乐卡的版式取决于 QQ 客户端 | 手机端封面能否显示取决于签名服务能否取得腾讯 CDN 的图像；部分版式（如 `music.lua`）在手机端本身不绘制封面 | 该部分不受本程序控制 |
| L6 | 管理端只提供 Windows 10/11 版本 | 其他客户端平台无交付物 | 远程部署的目标机假定为 Debian / Ubuntu 系 Linux，脚本使用 apt 与 systemd；其他发行版未验证 |
| L7 | 工具精简存在两种语义 | 两者容易混淆：前者减少每次请求体积，后者不减少 | `social.slimTools` 在注册期排除工具，需要重启隔离 DSH 才重新计算；`social.tools` 只在调用期拒绝 |
| L8 | 唤醒与发送受 QQ 风控影响 | 群聊发送频率、被 @ 频率、主动开口频率过高都可能触发限制 | 本版把群唤醒上限收到 30，并为“活跃模式”单列一套参数；风控无法完全规避 |
| L9 | 三类学习的产出质量取决于聊天样本量 | 样本不足时学习结果偏差较大；管理端只做展示与人工确认 | 黑话、人格、画像三类学习均以样本量为输入口径，不对正确性作保证 |
| L10 | 本版不对工具总数作保证 | README 与文档中列出的清单可能落后于实际注册结果 | 工具清单随代码变动，管理端内的 schema 表以在线实测为准 |

---

## 6. 未核验声明

表 7：未核验项清单（口径：等级按 §0 的证据分级）

| 项 | 声明 | 等级 |
| --- | --- | --- |
| 修复项的复现 | 第 4 章各条的现象与现行行为取自版本开发记录，本轮未逐条复现回归 | 【据仓库记载】 |
| 能力域实现位置 | 第 2 章的路径与函数名取自版本开发记录，本轮未逐条打开核对 | 【据仓库记载】 |
| 工具总数 | 本版未给出工具总数保证；实际注册结果以管理端 schema 表为准 | 【未核验】 |
| 工具 schema 生成脚本 | 文中记为 `tools/emit-tool-chars.mjs`；本轮检索发现该路径不存在，同名脚本实际位于 `qq-bridge/tools/emit-tool-chars.mjs`。原值按“不删改技术信息”的要求保留，未改写 | 【未核验】 |
| 归档器路径 | 第 4 章 F14 涉及的归档器路径未逐一复核；本轮只核对了第 2 章的脚本路径 | 【未核验】 |
