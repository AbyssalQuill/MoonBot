# MoonBot Pro

一个跑在 QQ 上的聊天机器人：**NapCat / OneBot v11** 负责接 QQ，**隔离的 DeepSeek Harness（DSH）实例**负责当大脑，中间的 **qq-bridge** 负责唤醒判定、提示词组装、工具调用与发送，一个 **Electron 管理端**负责装、配、拉起来、看着它。

当前版本 **1.2.5**，对外安装包为 `MoonBot Pro Setup.exe`。更新记录见 [CHANGELOG.md](CHANGELOG.md)。

<p>
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4">
  <img alt="electron" src="https://img.shields.io/badge/Electron-28-47848F">
  <img alt="node" src="https://img.shields.io/badge/Node-%E2%89%A5%2022.13-339933">
  <img alt="react" src="https://img.shields.io/badge/React-18-61DAFB">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
</p>

---

## 这套文档怎么读

这份 README 是**索引**：能跑起来的最短路径 + 能力清单 + 往哪儿深挖。深入内容全部在 `docs/` 下，四份文档各自成篇：

| 文档 | 回答什么问题 | 适合谁 |
| --- | --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 一共几层？一条 QQ 消息从进来到回复要走哪些代码？唤醒 / 在途注入 / 回合保持怎么协作？状态落在哪？线上部署在哪几个目录？ | 想读源码、想改行为、想知道"数据在哪"的人 |
| [docs/CAPABILITIES.md](docs/CAPABILITIES.md) | 机器人到底能干什么？每件事由哪个工具实现、代码在哪一行、生产上踩过什么坑？ | 想知道"能不能做 X"、想调工具的人 |
| [docs/COMPACTION-MATH.md](docs/COMPACTION-MATH.md) | 钱花在哪？上下文压缩阈值 0.16 是怎么算出来的？为什么永久会话比轮换便宜？ | 关心成本、想重新标定参数的人 |
| [docs/PIXIV-AND-QZONE.md](docs/PIXIV-AND-QZONE.md) | 发 pixiv 原图为什么这么绕？QQ 空间配图为什么不能落盘？ | 处理图片链路、排查"发出去的是缩略图"的人 |

其他：`CHANGELOG.md`（逐版本变更）、`docs/release-1.0.0.md`（1.0.0 发布说明）、`qq-bridge/docs/`（桥接层内部文档，含交接记录）。

---

## 这是什么

MoonBot 管理五个部件，负责安装、配置、拉起、探活、记录日志与停止。

| 部件 | 作用 | 界面 |
| --- | --- | --- |
| QQ 账号 | 机器人身份，扫码登录一次 | QQ 客户端 |
| NapCat | 内置便携版，把 QQ NT 转为 OneBot v11 服务端 | `http://127.0.0.1:6099` |
| qq-bridge | 桥接层：唤醒判定、提示词注入、人设、工具调用、发送链与学习 | `http://127.0.0.1:3100` |
| 隔离 DSH | DeepSeek Harness 实例，agent 运行时（独立 `DSH_HOME`，不碰桌面端那份） | `http://127.0.0.1:10721` |
| 模型服务商 | 推理服务，支持 DeepSeek 官方、小米 MiMo 与任意 OpenAI 兼容端点 | 管理端模型卡片 |

一句话链路：

```
QQ 群 / 私聊
   │ QQ 协议
NapCat   WebUI :6099 · OneBot HTTP :3000 · 反向 WS :3001
   │ OneBot v11（WS）
qq-bridge  入口 src/bridge.js · 控制台 :3100
   │ DSH HTTP API（session.prompt，mode:'steer'）
隔离 DSH  DSH_HOME=/root/.dsh（线上）· profile=web · 端口见下文
   │ LLM API
模型服务商
```

细节、端口全表、进程表、事件流逐步分解 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 快速开始

### 方式一：装安装包（推荐）

1. 双击 `MoonBot Pro Setup.exe`，装到任意盘（运行时根目录以程序自身位置推导，见 `server/index.js` 顶部的 `RUNTIME_ROOT`）。
2. 启动后打开管理端，首页按提示依次拉起 **NapCat → 扫码登录 QQ → 隔离 DSH → 桥**；也可以直接点"一键启动整套"。
3. 在「实例配置」里填模型服务商与 API Key；在「桥配置」里配白名单（`allow.private` / `allow.groups`）。
4. 私聊机器人或群里 @ 它，看「首页」的日志流。

关窗时管理端会自动停掉 NapCat、桥与隔离 DSH；不走应用进程树的关窗守卫 `server/napcat-guardian.mjs` 再做一次兜底清理。

### 方式二：从源码跑

```powershell
# 管理端前端 + 后端
npm install
npm run dev          # 或双击 启动管理端.bat
```

```bash
# 桥（在 qq-bridge/ 下，需要先 cp config.example.json config.json 并改）
node src/bridge.js
```

桥的端自安装是幂等的：启动时会把自己的 preset、MCP 组与内置插件装进隔离 DSH home（`qq-bridge/src/lib/dsh-side.js` 的 `installToIsolatedDsh()`），**默认绝不碰桌面端那份 DSH**。手动补装可以跑 `node qq-bridge/scripts/setup-dsh.mjs`。

更细的本地运行说明见 `本地运行指引.md`，同步与 SSH 说明见 `手动同步与SSH说明.md`。

---

## 它现在能做什么

按能力分组，**每条都能在 [docs/CAPABILITIES.md](docs/CAPABILITIES.md) 里找到实现工具、代码位置与踩过的坑**。

### 会话与唤醒

- 群聊与私聊对话；唤醒方式包括私聊、被 @、被引用、点名、关键词、直接提问、戳一戳、指定发言人、AI/技术话题接话、按概率随机接话
- 潜水 / 活跃双模式、活跃时段、免打扰窗口、沉睡前观察窗口
- **在途注入**：模型正在跑的时候来的消息直接 steer 进当前回合，不另起一轮
- **回合保持（turn-hold）**：首轮唤醒开起来之后，后续消息都塞进同一个回合，直到阈值/空闲/出错才关
- **连发合并**：一个模型步只产生**一个** `[Mid-turn]` 块，把这一步攒下的消息合成进去
- 私聊打字状态等待（不抢话）、投递看门狗兜底、卡死与复读自动恢复

### 说话与发东西

- 文本气泡（按字数拟人节奏分段，桥侧硬钳制过上限）、引用回复、连发、戳一戳、撤回、定时消息、跨会话留言
- 富文本卡片：音乐点歌卡（网易云 / QQ 音乐）、视频卡（B 站 / 抖音，原生小程序 Ark 优先）、Word 文档、合并转发
- QQ 原生表情（含动态大表情）、收藏贴纸、内置表情包（meme-packs）/ 自定义表情包
- 语音：小米 MiMo 的 TTS / ASR，内置音色 / 文字造音色 / 音频复刻三选一，支持全语音模式与"收到语音自动转文字"
- 图片：联网找图（Bing / 百度）、Pixiv 搜图发图、QQ 空间配图

### 记得住

- SQLite 长期记忆（`state/memory.db`）：三层记忆（permanent / durable / working）+ FTS5 trigram 全文索引 + BM25 相关性排序
- 群友画像（personality / likes / dislikes / notes…）、结构化档案文本注入
- 黑话学习：从群聊语料里抽候选、研究、确认，已确认词条不再常驻上下文，模型需要时自己查
- 人格学习、群友画像学习、跨会话互知（`qq_crosschat_*`）

### 会看会听

- 独立识图模型：图片先转文字再交给语言模型（也可直接当附件发）
- 转发消息展开、群文件读取、语音转写
- 联网搜索与网页抓取（`web_search` / `web_fetch`）

### 会管自己

- 会话轮换（按轮数换新会话）与**永久会话**（不换会话，上下文交给 DSH 自己的压缩治理）
- 上下文压缩阈值可调（默认 `0.16`），工具描述压缩档、MCP 压缩代理、工具裁剪档位
- Token 用量统计与费用估算，QQ 里打 `/token` 就能看到今日用量与花费
- NapCat 会话守护（`get_rkey` 探活，假死自动重启）、登录态巡检、Pixiv 登录态看护与长期令牌自动轮换
- SSH 远程部署：代码 / 数据 / 表情包 / `config.json` 分别同步，支持一键克隆整套环境到全新机器

---

## 仓库地图

```
MoonBot Public/
├─ src/                      管理端前端（React + TypeScript + Vite）
│   ├─ App.tsx  api.ts       页面切换 / 后端接口封装
│   ├─ pages/                首页、实例配置、SSH 配置、功能配置、学习与用量、
│   │                        群友画像、语音、内嵌界面、关系图
│   ├─ components/ stores/   通用组件与状态类型
│   ├─ styles/               主题与全局样式
│   └─ tool-schema-chars.ts  工具 schema 体积表（由桥的 tools/emit-tool-chars.mjs 生成）
├─ server/                   管理端后端
│   ├─ index.js              HTTP API、实例编排与探活、前端静态托管
│   ├─ deploy.js             SSH 远程部署 / 一键克隆
│   ├─ iso-credential.js     隔离 DSH 凭据文件读写（本地与服务端共用）
│   └─ napcat-guardian.mjs   关窗守卫（独立进程）
├─ qq-bridge/                桥接层
│   ├─ src/bridge.js         入口
│   ├─ src/core/*.js         业务：唤醒投递、会话、社交状态、发送链、媒体、语音、学习、用量
│   ├─ src/lib/*.js          基础库：OneBot 客户端、消息解析、图片体检、Pixiv、路径与文本
│   ├─ src/mcp-*.js          三组 MCP server
│   ├─ dsh/agent-presets/    agent preset（qq-chat / default）
│   ├─ plugins/              DSH 插件：dsh-qq-hold、qq-mode-console、dsh-memory
│   ├─ characters/           角色库（一个子目录 = 一个角色包）
│   ├─ tools/  tests/        开发工具与回归测试
│   ├─ config.example.json   出厂配置模板
│   └─ state/                运行数据（记忆库、社交状态、用量日志…）
├─ tools/                    管理端侧开发与运维脚本
├─ docs/                     本文档集
├─ CHANGELOG.md  LICENSE
└─ 启动管理端.bat
```

更完整的目录说明与"哪些文件纳入版本管理"见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#9-部署路径)。

---

## 常用命令

聊天窗口里（管理员专用，由桥直接执行、不经过模型）：

| 命令 | 作用 |
| --- | --- |
| `/reset` `/new` | 重置当前会话：换一个新的 DSH 会话，**保留已回复账本**（防重复回复） |
| `/status` | 当前 DSH 会话 id、白名单是否通过、角色与模式 |
| `/token [天数]` | 今日（或近 N 天）token 用量与花费，口径与管理端「学习」页一致 |
| `/op <QQ或昵称>`、`/op del <QQ或昵称>` | 增删管理员（仅主人） |
| `/role ...`、`/slang ...` | 角色切换、黑话学习（内部再判一次管理员） |

运维（服务器上）：

```bash
cd /root/qq-bridge && bash start-bridge.sh      # 起桥
bash /root/qq-bridge/tools/restart-bridge.sh    # 重启桥（部署脚本认这一条）
systemctl status dsh-web                        # 隔离 DSH
systemctl status napcat                         # NapCat（原生跑法）
```

---

## 常见问题

**"机器人不回复"** —— 先分岔：桥日志（`qq-bridge/state/bridge.log`）里如果没有 `NapCat 已连接`，是连接层问题；桥会每分钟探一次 NapCat WebUI，把"QQ 掉登录态"和"只是桥断了"分开写进 `[napcat-login]` 一行。桥连不上 NapCat 时**不会自杀**，会带退避一直重连（`qq-bridge/src/bridge.js` 的 `connectNapcat`）。

**"管理端改了配置没生效"** —— 桥对 `config.json` 是**原地热加载**（`qq-bridge/src/core/config.js` 的 `watchConfigFile`：目录监听 + 2 秒轮询双保险）。改完看桥日志有没有 `已热加载，变更字段: …`。改 `agentPreset` 例外：它只在建会话时绑定，老会话要等轮换或归档重建。

**"发出去的图是缩略图 / 半幅灰"** —— 见 [docs/PIXIV-AND-QZONE.md](docs/PIXIV-AND-QZONE.md)。两条独立闸门：地址档位（`pixivImageTier` / `planPixivSend`）+ 字节完整性（`verifyImageComplete`）。

**"一句话好几分钱"** —— 见 [docs/COMPACTION-MATH.md](docs/COMPACTION-MATH.md)。结论是"上下文本体几乎不花钱，花钱的是整段重读"，所以调阈值不是越小越好。

**"唤醒后要响应一段时间"** —— 先看 `clampSendPace`：线上曾出现 `linearPerCharMs: 650`（17 个字 = 11 秒），桥现在把它硬夹在 `[60, 320]`。

---

## 隐私

机器人会把 QQ 消息、群成员昵称与 QQ 号写入本地 SQLite（`qq-bridge/state/memory.db`）与 JSON 状态文件，用于上下文、画像与黑话学习。这些数据只在本机与你自己配置的服务器上，不会上传到 MoonBot 项目本身。模型调用会把当前会话上下文发给**你自己配置的**模型服务商。

## 许可

MIT，见 [LICENSE](LICENSE)。
