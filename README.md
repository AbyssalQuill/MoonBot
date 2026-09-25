# MoonBot Pro

MoonBot Pro 是运行于 QQ 平台的对话机器人系统。**NapCat / OneBot v11** 承接 QQ 协议；**隔离的 DeepSeek Harness（DSH）实例**承担 agent 推理；**qq-bridge** 承担唤醒判定、提示词组装、工具调用与消息发送；**Electron 管理端**承担安装、配置、进程启动与运行监控。

当前版本 **1.3.0**，对外安装包为 `MoonBot Pro Setup.exe`（完整版）与 `MoonBot Pro Manager Setup.exe`（管理端精简版）。版本变更记录见 [CHANGELOG.md](CHANGELOG.md)。

表 1：运行环境与依赖（口径：仓库打包配置与 `package.json`）

| 项目 | 值 |
| --- | --- |
| 平台 | Windows 10 / 11 |
| Electron | 28 |
| Node.js | ≥ 22.13 |
| React | 18 |
| 许可 | MIT |

---

## 1. 文档索引

本章界定本 README 的章节范围与配套文档的分工。

本 README 为索引加能力实现细节：最短可运行路径、能力清单、各能力域的实现路径与闸门，以及进一步阅读的入口。各能力域的实现细节见第 5 章；推导过程、测量数据与逐条旁证见 `docs/` 下的四份文档。

本章之外的章节顺序如下：

- 1. 文档索引
- 2. 关键机制与测量数据
- 3. 系统组成与链路
- 4. 安装与初始化
- 5. 能力实现细节
- 6. 能力概览
- 7. 仓库目录结构
- 8. 常用命令与运维操作
- 9. 已知限制
- 10. 数据与隐私
- 11. 许可与合规

表 2：配套文档与内容范围（口径：`docs/` 下当前文档）

| 文档 | 内容范围 | 适用场景 |
| --- | --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层结构、单条 QQ 消息的处理路径、唤醒 / 在途注入 / 回合保持的协作方式、状态落盘位置、线上部署目录 | 阅读源码、修改行为、定位数据存放位置 |
| [docs/CAPABILITIES.md](docs/CAPABILITIES.md) | 能力域清单、各能力的实现工具与 `path:line` 位置、生产环境中出现的非显然约束；附录 A 为 91 条 napcat 侧 MCP 工具表（按 16 组），附录 B 为宿主侧 5 条与联网检索侧 2 条，合计 98 条 | 判定某项能力是否存在、查某个 MCP 工具的必填与可选参数及最低保留档位、调整工具配置 |
| [docs/COMPACTION-MATH.md](docs/COMPACTION-MATH.md) | 成本构成、上下文压缩阈值 0.16 的推导过程、永久会话与轮换会话的成本比较 | 成本核对、参数重新标定 |
| [docs/PIXIV-AND-QZONE.md](docs/PIXIV-AND-QZONE.md) | pixiv 原图发送链路的构成、QQ 空间配图不落盘的原因 | 图片链路维护、缩略图问题定位 |

其他文档：`CHANGELOG.md`（逐版本变更）、`docs/release-1.0.0.md`（1.0.0 发布说明）、[qq-bridge/docs/PROJECT_GUIDE.md](qq-bridge/docs/PROJECT_GUIDE.md)（桥接层项目说明书）、[qq-bridge/docs/DSH_SETUP.md](qq-bridge/docs/DSH_SETUP.md)（DSH 端安装说明），另有桥接层的交接与重构记录。资源文件：`qq-bridge/assets/project-intro.mp4`（项目介绍视频）。

---

## 2. 关键机制与测量数据

本章界定影响复算的四组结论，每条附代码入口，便于复算或推翻。

### 2.1 上下文成本构成

按线上 `state/token-usage.jsonl` 的 4,659 次主聊天请求分桶统计（时间跨度 11.2 天）：

表 3：上下文区间与请求成本分布（口径：`state/token-usage.jsonl`，样本 4,659 次主聊天请求，时间跨度 11.2 天）

| 上下文区间 | 请求占比 | 每次平均花费 | 其中大未命中（≥20k） |
| --- | --- | --- | --- |
| 0~30k | 5.8% | **¥0.0382** | **49.8%**（压缩或换会话之后的重建） |
| 30~50k | 36.8% | ¥0.0105 | 10.6% |
| 50~70k | 22.2% | ¥0.0033 | 0.9% |
| 70~90k | 15.6% | ¥0.0043 | 1.2% |
| 90~120k | 13.2% | ¥0.0040 | 0.0% |
| 120~160k | 5.5% | ¥0.0051 | 0.4% |

50k 以上区间回归得 **每次 ≈ ¥0.0020 + 0.022 ¥/M × 上下文**（≈ 缓存命中价）。结论：上下文长度本身的成本占比很低，主要成本来自「压缩 / 换会话 / 长时间空闲之后整段重读一次」，单次重建 ≈ ¥0.036，频率 ∝ 1/阈值。

- **压缩阈值**：每天成本 = 步数×(固定+边际×平均上下文) + 每天重建次数×重建单价，最小值出现在 **0.16**（稳健区间 0.14~0.20）。代码：`qq-bridge/src/core/config.js` 的 `dshCompaction.thresholdRatio`，由 `qq-bridge/src/lib/dsh-compaction.js` 写入 DSH 的 `cordis.patch.yml`。
- **换会话频率**：每次换会话需支付一次整段重建（≈¥0.04~0.11），而每步仅节省 `0.022¥/M × ΔC ≈ ¥0.00066`，平衡点 ≈75 步 ≈ 18~25 个来回；纯成本最优为永久会话（`social.autoReset.permanent = true`，上下文交由 DSH 压缩治理，压缩保留摘要，不损失连贯性）。
- **复算脚本**：`node qq-bridge/tools/compaction-threshold.mjs`（参数取自线上用量记录，价格变更后重新执行）。
- 完整推导（缓存 TTL、闭环最优、峰谷倍率）见 [docs/COMPACTION-MATH.md](docs/COMPACTION-MATH.md)。

### 2.2 工具表压缩

隔离 DSH 不直连 napcat MCP，而是连接 mcp-compressor 代理。代理只向模型暴露 2 个包装工具（`napcat_get_tool_schema` / `napcat_invoke_tool`），压缩后的清单写入工具描述。相对完整工具表的测量结果如下。

表 4：工具表体积与档位（口径：相对完整工具表的百分比，档位定义见 `qq-bridge/src/lib/tool-tiers.js`）

| 档位 | 相对完整工具表体积 |
| --- | --- |
| 低档 | 38.8% |
| 中档 | 14.0% |
| 高档 | 6.2% |
| 极限档 | 3.6% |

- **代理常态启用**：`qq-bridge/src/lib/dsh-side.js` 默认加载代理；未安装压缩机时自动回退直连，不会造成工具表缺失。
- **工具名单档位**（`social.slimTools.level`，定义在 `qq-bridge/src/lib/tool-tiers.js`）决定后端注册的工具集合；当前档位裁剪掉的具体工具名逐项列出在管理端对应卡片上。
- 成本：模型遇到本轮未使用过的工具时需先查询 schema 再调用（一步变为两步）。桥按真实工具名解包，发送判定、幂等账本与回合收尾均不受影响。

### 2.3 图片链路

- **pixiv**：候选按档位分桶（缩略档不发送），以作品详情的宽高与实际像素比对，并要求字节通过完整性闸门（JPEG 的 FFD9 / PNG 的 IEND / GIF 的 0x3B / RIFF 长度 + `content-length`）；任一条件不成立即换用下一个候选，不发送不完整图像。入口：`qq-bridge/src/lib/pixiv.js`、`qq-bridge/src/safe-fetch.js`。
- **QQ 空间配图**：不落盘优先（≤10MB 时直接把 `base64://` 交给 NapCat），超过上限才写入 `napcat.tmpDir`，并在 `try/finally` 中无论成败都删除；NapCat 的 `send_qzone_msg` 只读取 `images`，参数名为 `file` 时被静默忽略。入口：`qq-bridge/src/lib/qzone-image.js`。
- 两条链路的共同约束与回归测试见 [docs/PIXIV-AND-QZONE.md](docs/PIXIV-AND-QZONE.md)。

### 2.4 图片附件的投递路径

唤醒路径与在途注入路径均须附加图片附件。两条路径共用 `pickAttachableMedia`（挑选规则）与 `resolveMediaList`（取图闸门），带图被拒时自动回退为纯文本重新投递；附图水位仅在图片实际投出之后推进，否则该图片在两条路径上都不会再被附加。见 `qq-bridge/src/core/social-state.js`、`qq-bridge/src/core/wake-send.js`，回归测试 `qq-bridge/tests/steer-media.test.js`。

### 2.5 行为默认值

表 5：行为默认值与配置位置（口径：桥侧缺省配置，`qq-bridge/src/core/config.js`）

| 项 | 缺省值 | 配置位置 |
| --- | --- | --- |
| 打字节拍 | 150 ms/字（第 2 条气泡起按字数等待），下限 250 / 上限 4000 ms；桥侧夹在 [60,320] / [800,6000] | 「发送节奏与间隔」 |
| 回复前停顿 | 上限 30s、静默 8s、新消息后至少静默 10s | 「等待：回复前的停顿」 |
| 私聊不抢话 | 检测对方打字、最多等 12s、连发续窗 5s、插话概率 0.15 | 「私聊打字等待」 |
| 唤醒模式 | **默认活跃**；潜水模式需指定有限时长，配置中无「无限期潜水」项 | 「唤醒 · 潜水 / 活跃」 |
| 上下文压缩 | 阈值 0.16、逐字保留 2%、单个工具结果 8192 字符 | 「上下文治理」 |

管理端「上下文治理」卡片提供 **「恢复默认配置（拟人默认，全局）」** 按钮，将上表各项一次性写回表单。

---

## 3. 系统组成与链路

本章界定 MoonBot Pro 的部件划分与消息链路。

MoonBot 管理五个部件，负责安装、配置、启动、探活、日志记录与停止。

表 6：部件与职责（口径：`server/index.js` 的实例编排、`qq-bridge/src/bridge.js` 的入口）

| 部件 | 职责 | 界面 |
| --- | --- | --- |
| QQ 账号 | 机器人身份，一次扫码登录 | QQ 客户端 |
| NapCat | 内置便携版，将 QQ NT 转换为 OneBot v11 服务端 | `http://127.0.0.1:6099` |
| qq-bridge | 桥接层：唤醒判定、提示词注入、人设、工具调用、发送链与学习 | `http://127.0.0.1:3100` |
| 隔离 DSH | DeepSeek Harness 实例，agent 运行时（独立 `DSH_HOME`，与桌面端实例相互隔离） | `http://127.0.0.1:10721` |
| 模型服务商 | 推理服务，支持 DeepSeek 官方、小米 MiMo 与任意 OpenAI 兼容端点 | 管理端模型卡片 |

QQ 会话与 DSH 会话按一对一映射：一个 `private:<QQ 号>` 或 `group:<群号>` 对应一个独立的 DSH 会话，映射持久化在 `state/sessions.json`（`qq-bridge/src/lib/paths.js:9`）；新建会话在 DSH 界面中归组到 `workspaceTitle` 指定的工作区，缺省名称为 `Agents`（`qq-bridge/src/core/config.js:74`）【已核验】。

桥侧只存在一种运行模式：`currentMode` 恒为 `'default'`（`qq-bridge/src/core/mode.js:9`），历史的多模式及其切换入口已移除，白名单与黑名单访问控制保留（`qq-bridge/src/core/mode.js:30-32`）【已核验】。DSH 侧的三组 MCP server（`mcp-napcat` / `mcp-napcat-host` / `mcp-web-search-safe`）由桥在启动时写入 profile 的 `cordis.patch.yml`，装配流程见 5.16。

消息链路如下：

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

端口全表、进程表与事件流逐步分解见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 4. 安装与初始化

本章界定两种安装方式、桥接层的前置条件、完整启动顺序与配置字段。

### 4.1 方式一：使用安装包

1. 双击 `MoonBot Pro Setup.exe`，安装到任意盘（运行时根目录按程序自身位置推导，见 `server/index.js` 顶部的 `RUNTIME_ROOT`）。
2. 启动后打开管理端，首页按提示依次启动 **NapCat → 扫码登录 QQ → 隔离 DSH → 桥**；也可在首页按同一顺序启动整套。
3. 在「实例配置」中填写模型服务商与 API Key；在「桥配置」中配置白名单（`allow.private` / `allow.groups`）。
4. 在私聊中向机器人账号发送消息，或在群内 @ 机器人账号，观察「首页」的日志流。

关闭窗口时管理端自动停止 NapCat、桥与隔离 DSH；不随应用进程树退出的关窗守卫 `server/napcat-guardian.mjs` 执行一次后备清理。

### 4.2 方式二：源码运行

管理端前端与后端（在 `MoonBot Public` 根目录执行）：

```powershell
npm install
npm run dev          # 或双击 启动管理端.bat
```

桥接层（在 `qq-bridge/` 下执行，需先执行 `cp config.example.json config.json` 并修改）：

```bash
node src/bridge.js
```

桥侧的安装是幂等的：启动时将自身的 preset、MCP 组与内置插件安装进隔离 DSH home（`qq-bridge/src/lib/dsh-side.js` 的 `installToIsolatedDsh()`），默认不修改桌面端 DSH 实例。手动补装可执行 `node qq-bridge/scripts/setup-dsh.mjs`；该脚本对未初始化的隔离 DSH 会提示先在管理端启动一次 `dsh-isolated`，且仅在显式传入 `--desktop` 时才写入桌面端 home（`qq-bridge/scripts/setup-dsh.mjs:20-38`）【已核验】。

本地运行的详细说明见 `本地运行指引.md`，同步与 SSH 说明见 `手动同步与SSH说明.md`。

### 4.3 桥接层的前置条件

本节界定以源码或手动方式运行桥接层所需的外部条件。

表 7：桥接层运行前置条件（口径：`qq-bridge/config.example.json` 与 `qq-bridge/src/core/config.js:19-20`）

| 项 | 取值 | 说明 |
| --- | --- | --- |
| 隔离 DSH | `dsh.baseUrl` 缺省 `http://127.0.0.1:10721` | 环境变量 `QQB_DSH_BASE_URL` 可覆盖；管理端需先启动一次 `dsh-isolated` |
| NapCat | OneBot WebSocket `ws://127.0.0.1:3001`、OneBot HTTP API `http://127.0.0.1:3000` | `napcat.wsUrl` 与 `napcat.httpUrl` 分别指向两类端口，`httpUrl` 不得填成 WebSocket 端口，否则接口返回 HTTP 426 |
| OneBot accessToken | `napcat.accessToken` | 与 NapCat WebUI 中配置的一致；未配置时留空 |
| Node.js | ≥ 22.13 | `qq-bridge/package.json` 的 `engines` 字段；桥的数据库层使用内置模块 `node:sqlite`（`qq-bridge/src/bridge.js:12`） |

### 4.4 完整启动流程

采用安装包时，管理端首页按「NapCat → 扫码登录 QQ → 隔离 DSH → 桥」的顺序启动（见 4.1）。以手动方式接入时，两端部件按下列顺序启动；隔离 DSH 与桥接层已就绪时，缺失的部件只有 NapCat 本体。

表 8：桥接层完整启动顺序（口径：桥接层的五步启动流程，与 `qq-bridge/config.example.json` 对照）

| 顺序 | 操作 | 完成判据 |
| --- | --- | --- |
| 1 | 启动隔离 DSH | `http://127.0.0.1:10721` 可打开；管理端需先启动一次 `dsh-isolated` |
| 2 | 取得 NapCat 本体：从 <https://github.com/NapCat/NapCat/releases/latest> 下载 `NapCat-v<版本>-win-x64.zip`（完整版自带 Node 运行时，Lite 版要求本机 Node ≥ 22.13），解压到任意目录后执行 `launcher.bat` | 启动日志打印出 WebUI 地址（手册记载为 `http://localhost:5099`，以日志实际打印的地址为准） |
| 3 | 在 WebUI 中完成首次引导：以启动日志中的初始密码登录，依次同意条款、设置密码、接入 QQ 进程（扫码登录）；随后开启 WebSocket 服务端与 HTTP API，记录端口（缺省 WS `3001`、HTTP `3000`）与 accessToken | OneBot WebSocket 与 HTTP API 均已开启，端口与令牌已记录 |
| 4 | 填写桥接配置：`config.json` 的 `napcat.wsUrl` / `napcat.httpUrl` / `napcat.accessToken`（字段全表见表 9） | 两个地址分别指向 WS 与 HTTP 端口，未填成同一端口 |
| 5 | 在 `qq-bridge/` 下执行 `npm start`（或 `start.bat`）启动桥接进程 | 日志出现 `NapCat 已连接` |

桥接进程的日志判据（口径：桥接层启动日志的实际输出行）：

```text
12:00:01 [bridge] NapCat 已连接：ws://127.0.0.1:3001
12:00:02 [bridge] 新会话 private:12345678 -> sess_xxxx
12:00:02 [bridge] 已投递 private:12345678: 测试消息
12:00:20 [bridge] agent 回复 (private:12345678) 42 字
```

### 4.5 桥接配置字段

本节界定 `qq-bridge/config.json` 的主要字段。真实 `config.json` 与 `state/` 不进入公开仓库，仓库只提供脱敏的 `config.example.json` 模板；Windows CMD 下复制模板的命令为 `copy config.example.json config.json`。

表 9：桥接配置字段（口径：`qq-bridge/config.example.json` 与 `qq-bridge/src/core/config.js`）

| 字段 | 说明 |
| --- | --- |
| `dsh.baseUrl` | DSH Web 地址，缺省 `http://127.0.0.1:10721`，可用 `QQB_DSH_BASE_URL` 覆盖 |
| `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` | DSH 会话使用的模型与推理强度；所选模型在目标 DSH 中不存在时只记录日志，不阻塞启动 |
| `napcat.wsUrl` | NapCat OneBot WebSocket 地址（如 `ws://127.0.0.1:3001`） |
| `napcat.httpUrl` | OneBot HTTP API 地址（如 `http://127.0.0.1:3000`）；填成 WebSocket 端口会使接口返回 HTTP 426 |
| `napcat.accessToken` | OneBot accessToken，未配置时留空 |
| `napcat.launcherPath` / `napcat.homeDir` | NapCat 启动脚本与安装目录，供宿主侧进程控制使用 |
| `napcat.allowProcessControl` | NapCat 进程控制开关，缺省 `false`，语义与非显然约束见 5.12 |
| `ownerQQ` | 账号所有者的 QQ 号，管理员命令与权限判定的依据（见 5.12） |
| `agentPreset` | QQ 会话使用的 DSH agent preset，缺省 `qq-chat`（见 5.15） |
| `workspaceTitle` | QQ 会话在 DSH 界面中的工作区名称，缺省 `Agents` |
| `allow.private` / `allow.groups` | 白名单（QQ 号 / 群号数组）；两侧为空且 `allowAllWhenEmpty: true` 时放行全部来源 |
| `deny.*` | 黑名单，优先于白名单 |
| `ackMessage` | 消息投递后的立即回执，空字符串表示关闭 |
| `sendDelayMs` | 连续发送之间的间隔，缺省 `300` ms，用于规避频率限制 |
| `consolePort` / `consoleToken` | 控制台端口缺省 `3100`；`consoleToken` 为空时控制台默认本机可信，配置合法令牌后所有 API 请求须带 `x-console-token`（见 5.16） |

---

## 5. 能力实现细节

本章界定各能力域的实现细节，给出能力定义、实现路径、关键约束与非显然约束。

本章按能力域分组：能力定义（模型在何种场景调用哪个工具）、实现路径（`文件:函数`，行号为撰写时的近似位置，重构后会平移）、关键约束与闸门，以及生产环境观测到的非显然约束。工具注册点为 `qq-bridge/src/mcp-napcat-safe.js`（QQ 主体）、`qq-bridge/src/mcp-host-server.js`（宿主与学习）、`qq-bridge/src/mcp-web-search-safe.js`（联网）。本章仅收录已对照仓库代码核对的条目。

### 5.1 语音：TTS 与 ASR

- **能力定义**：需要以语音形式回答时调用 `qq_send_voice` 将文本合成为语音发出；收到对方的 `record` 段时调用 `qq_transcribe_voice` 转写后再理解，不对语音内容作推断。
- **实现路径**：`core/voice.js`（`synthesize()`、`voiceTurnHint()`、`allVoicePlan()`、`allVoiceEnabled()`）、`core/send-dice.js`（`dice('voice', …)`）。工具：`qq_send_voice`（`mcp-napcat-safe.js:2170`）、`qq_transcribe_voice`（`mcp-napcat-safe.js:2198`）。三种音色来源见表 10（`core/voice.js:11-13`）。

表 10：音色来源与约束（口径：`core/voice.js:11-13`）

| 模式 | 模型 | 要点 |
| --- | --- | --- |
| `tts` | `mimo-v2.5-tts` | `audio.voice` 传官方音色 id；内置名单为 `BUILTIN_VOICES`，仓库内音频文件数为 0 |
| `design` | `mimo-v2.5-tts-voicedesign` | 用文字描述构造音色，不可传 `voice` |
| `clone` | `mimo-v2.5-tts-voiceclone` | `audio.voice` 必须为样本的 **DataURL**，裸 base64 会被 400 拒绝 |

- **关键约束**：无本地模型，合成与识别均走小米 MiMo 的 OpenAI 兼容端点；鉴权同时发送 `api-key` 与 `Authorization: Bearer`，待合成文本放在 `assistant` 消息、风格描述放在 `user` 消息。额度为 `maxChars` / `dailyChars`，缓存为 `state/voice-cache/*.mp3`（上限 `maxCacheFiles`）。是否主动发送语音由桥侧掷骰决定（`core/send-dice.js` 的 `dice('voice', …)`），概率与冷却读 `state/voice-config.json` 的 `send.probability` / `send.cooldownMs`，命中时向唤醒正文插入 `[Voice] dice HIT`；概率为 0 表示仅在明确要求时发送。`send.allVoice=true` 时回复一律转换为语音，任一前置条件不成立即自动退回文字并在日志中记录原因。
- **非显然约束（生产观测）**：引用在语音模式下会被桥丢弃，QQ 将「回复 + 语音」渲染为仅含引用框的气泡，需要引用时应使用 `qq_reply` 发送文字；语音文件必须落在 NapCat 可读的目录（`napcat.tmpDir` + `dockerPathMap` 映射为容器内路径），读取失败时自动改以 base64 重发；`send.allVoice` 缺失或非布尔值一律按关闭处理（`qq-bridge/tests/all-voice-mode.test.js`）。

### 5.2 发送链与正文格式治理

- **能力定义**：模型的全部对外正文经统一出口发出，包括分气泡、引用回复、连发，以及「已读不回」时的标读收尾。
- **实现路径**：`core/send-chain.js`（`enqueueSend`）、`core/qq-send.js`（`onebotSend`，`qq-send.js:168`，所有模型正文的唯一出口）、`core/send-idempotency.js`（幂等闸门）、`lib/onebot-delivery.js`（分段与节奏）、`lib/send-gaps.js`（`computeGaps`）、`core/config.js`（`clampSendPace`，`config.js:410`）。工具：`qq_send_message`（`:1314`）、`qq_reply`（`:969`）、`qq_mark_read`（`:1249`）。
- **关键约束**：节奏仅有「按字数」一种。批内首条立即发送；第 2 条起 = 本条字数 × `linearPerCharMs`（默认 150），叠加 ±`linearJitterRatio` 抖动，夹在 `[linearMinMs, linearCapMs]`；`linearEnabled=false` 即不延迟。钳制：`linearPerCharMs ∈ [60,320]`、`linearCapMs ∈ [800,6000]`、`linearMinMs` 不得高于 `linearCapMs`（`clampSendPace`）。发送侧另有 `maxSendPerMinute` / `maxSendPerHour` / `maxMessageChars` 上限，以及 `core/audit.js` 的敏感内容拦截。
- **格式治理**：「不显式换行」「颜文字须有出处」「代码类不分段」三条由提示词（preset 的 `[TOOLS] 2b~2e`）约束，桥侧不做正则清洗；桥实际拦截的是「工具参数数组被当作正文」，无法切出正文时以 400 硬失败，不发送任何内容（`lib/text-safe.js` + 发送端点 + `onebotSend`）。
- **收尾令牌 `OK` 的约定**：`OK` 作为回合结束令牌，仅由提示词约定（preset 的 `[RULES] 13 CLOSING_OK`）：发送工具成功后，正文以单独一个 `OK` 收尾；该行由桥丢弃，不进入 QQ（`core/mux.js`：`sendToolSucceeded` 为真时正文按思考忽略；未调用发送工具时的裸 `OK` 按「本轮不说话」处理，同时免去「写了正文未调工具」的未交付草稿暂存）。桥侧的闸门与判定器已删除（`src/lib/ack-text.js`、`tests/ack-suppress.test.js` 及发送端点中的拦截段），发送端点回到单一语义：按模型指令发送，幂等闸门仍拦截重复。preset 中编号冲突的 MUSIC 由 13 改为 14。
- **非显然约束（生产观测）**：现象：一条 17 个字的回复等待 11 秒，同一窗口内 118 次发送累计执行 990 秒，对应线上 `config.json` 的 `social.send` 取 `linearPerCharMs: 650` / `linearCapMs: 15000`。机制：这两个键可由模型在私聊中自行写入，改动配置文件只改变当前取值，不构成上限。现行实现与判据：`clampSendPace` 把 `linearPerCharMs` 夹在 `[60,320]`、`linearCapMs` 夹在 `[800,6000]`，越界取值在加载时即被改写。回归测试 `qq-bridge/tests/send-pace-clamp.test.js`。

### 5.3 收发图片

- **能力定义**：入站图片作为附件进入模型，而非占位文本；出站由模型联网检索图片并发送。
- **实现路径（入站）**：两条路径共用同一套实现。挑选规则为 `core/social-state.js` 的 `pickAttachableMedia`（`social-state.js:1153`），取图闸门为 `core/media-pipe.js` 的 `resolveMediaList`（`media-pipe.js:218`，由 `bridge.js:478` 注入）。唤醒路径在 `wake-send.js:1104`，在途注入路径在 `steerIntoRunningTurn` 内；另有 `qq_get_message_images`（`mcp-napcat-safe.js:1706`）供模型主动获取某一批消息的图片。
- **实现路径（出站）**：`qq_image_search`（`mcp-napcat-safe.js:3071`，只检索不发送）与 `qq_send_image`（`mcp-napcat-safe.js:3091`，检索并发送），检索实现在 `lib/image-search.js`（Bing / 百度，只返回 URL，不下载、不落盘）。四个来源按 `file > messageId > imageUrl > query` 取值：`file` 为本地已有图片（含 DSH 附件对象路径）；`messageId` 为转发聊天中的图片（按消息 id 取回原图重发，模型在唤醒正文中可见 `(id:…)`）；`imageUrl` 为 `qq_image_search` 返回的直链；`query` 为联网实时检索。三条来源最终汇入同一处理：字节先通过 `verifyImageComplete` 完整性闸门，再写入 `napcat.tmpDir`（该目录即挂载进 NapCat 容器的目录），随后将该目录中的路径交给 `/api/social/send-message`（公共落盘函数 `stageImageBytes`）。跨会话发图（在私聊中将图片转入群）与正文同构，依靠 `crossSession: true` 通过 `console-server` 的跨会话闸门；读图一侧按 messageId 查找时先查找目的地会话、再遍历所有活跃会话（`findMessageMedia(..., {info:true})`），因为跨会话时 `key` 为目的地，而图片位于发起会话的记忆窗口中。
- **关键约束**：`qq_send_image` 的下载走 `safe-fetch.js` 的 `safeFetchBuffer`（SSRF 防护 + 体积上限 + 图片格式校验），除 NapCat 临时目录外不写入任何位置；一次一张，不连续发送；`qq_image_search` 仅提供候选，模型不得构造图片 URL。入站侧带图被拒时自动回退为纯文本重新投递，且附图水位仅在图片实际投出之后推进。
- **落盘路径的选取依据**：不将宿主原路径直接交给 NapCat，是因为 DSH 附件目录 `/root/.dsh/attachments/v1/objects/…` 不在 `napcat.dockerPathMap` 的挂载范围内，容器化的 NapCat 无法读取（观测现象：接口返回 `ok`，用户端未收到内容）。因此三条来源一律先读取字节，再落到 `napcat.tmpDir`，仅将该目录中的路径对外提供。
- **引用穿透**：被引用的消息中含有图片时，图片位于被引用的那条消息内。两处处理：① 入站消息记录被引用消息的 id（`appendSocialMessage(..., quoteTargetId)` → `msg.quoteTarget`），`findMessageMedia` 自身无图时沿该 id 向下查找一层，结果如实上报 `viaQuote` / `quoteMessageId`；② 引用内容含 `[图片]` / `[表情]` / `[视频]` 时，唤醒正文渲染为 `[引用 某某#<id>：[图片]]`，模型可直接使用该 id 转发（纯文字引用的格式不变）。
- **转发使用原图**：取图分为两个档位，由 `/api/images/message` 的 `raw` 参数选择。默认档供模型查看（`resolveOneMedia` → `gateImage` → `image-compress.js`：长边缩至 `IMAGE_MAX_SIDE` 1280px、40KB 以上重编码，因为 DSH 附件层有单边上限且图片直接占用 token）；`raw=1` 档供转发（`resolveOneMedia(media, {raw:true})` → `fetchOneBotImage(media, {raw:true})`：仅做安全校验，包括字节上限、像素上限、魔术字，不做任何重编码）。`qq_send_image` 的 `messageId` 来源固定走 `raw=1`，回执含 `original: true` 与 `sha256`，可用于与原图逐字节比对。测量（服务器上 2400×1600 的真实 JPEG，除 `docs` 外无第三方依赖）：默认档 216,572 B（已重编码），raw 档 **441,776 B 且与磁盘原图 hash 完全一致**。
- **非显然约束（生产观测）：批次入队与模型读取的关系**。现象：2026-09-22，两条连发消息分别于 11:21:57 与 11:24:17 由 `wake-send` 的即时 steer 放入 next-step，实际直到 30 分钟空闲放行才被模型读取（延迟 4 分 28 秒）。机制：把批次放入 next-step 不等于模型已经读取，模型读取需等待下一步执行，而下一步执行需等待 `agent/turn-stopping` 钩子返回；保持循环处于「对方仍在打字」的退避状态时，其 steer 被 `typing-defer` 阻挡，55s 预算到期时 `collectMidTurnBatch` 已为空（已被其它路径投递），保持循环据此返回 `{close:false, again:true}` 继续持有，钩子因此不返回，DSH 不进入「next-step 非空 → 执行下一步」。现行实现与判据：`core/inbox-marks.js` 以 `noteStepEnd`（每个 `step/end`，在 `flushStepBatch` 中记录）、`noteInboxDelivery`（实际放入 next-step 之后，wake-send 的 steer 成功与步边界发车各记一次）、`clearInboxMarks`（`turn/end` 清账）维护投递与执行的对应关系；保持循环每次迭代先判定「当前无待投批次、且该批次已投递但未执行新的模型步」，成立即返回放行（不带 `again:true`），使插件返回、DSH 执行下一步；仍有待投消息时必须照常 steer，因此该判据不能单独成立。判据使用步结束计数而非时间戳，因为 `flushStepBatch` 在 step/end 时刻发车，二者常处于同一毫秒。回归测试 `qq-bridge/tests/inbox-hold-release.test.js`（18 项，含「判据必须排在预算到期分支之前」与「必须有 `!collectMidTurnBatch(st).length` 前提」两条顺序断言）。
- **非显然约束（生产观测）：三类图片发送失败**。① 现象：闸门每次回复「将参数 crossSession 设为 true 后重发」，调用无法推进。机制：工具注册的 `inputSchema` 中未声明的参数会被 zod 入参校验剥离，`qq_send_image` 原先既无 `file` 也无 `crossSession`，补充的参数在入参校验处即被丢弃。现行实现与判据：`file` 与 `crossSession` 均已声明并写入请求 body，file 分支与 imageUrl 分支为两份 body。② 现象：转发到本会话成功、转发到群时报告无图，调用退回联网检索相似图片。机制：取图仅按 `key` 查找，跨会话时 `key` 是目的地，图片位于发起会话。现行实现与判据：按目的地会话未命中时遍历所有活跃会话（`findMessageMedia(..., {info:true})`）。③ 现象：修改 `mcp-napcat-safe.js` 后模型读取到的仍是旧参数表。机制：工具 schema 是代理进程启动时取得的快照（mcp-compressor 包装 `napcat_get_tool_schema`）。现行实现与判据：改动后重建代理链。回归验证：`node --check` + 内层与代理两层各拉取一次 `tools/list` 比对字段 + 真实链路 `napcat_invoke_tool` 各调用一次。
- **非显然约束（生产观测）：图片附件的路径覆盖**。现象：在途注入路径（主路径）投递的正文只含一个文本块，模型只见到 `[图片] [image]` 占位文本，会话日志中 `mediaType` 出现 0 次。机制：图片附件原先仅挂载在唤醒路径上，在途注入路径直接调用 `sessions.prompt`，不经过附件挂载。现行实现与判据：两条路径共用 `pickAttachableMedia` + `resolveMediaList`，附图水位仅在图片实际投出之后推进。回归测试 `qq-bridge/tests/steer-media.test.js`。

### 5.4 Pixiv 搜图与发图

- **能力定义**：`qq_pixiv_search` 只检索不发送（返回候选与筛选明细），`qq_send_pixiv` 检索并发送。
- **实现路径**：`lib/pixiv.js`（`pixivImageTier:207`、`planPixivSend:232`、`normalizePixivFilters:351`、`filterPixivItems:479`、`pixivImageSources`）、`safe-fetch.js` 的 `verifyImageComplete`（`safe-fetch.js:286`）。工具：`mcp-napcat-safe.js:3174` / `:3250`。
- **关键约束**：三道闸门，分别为档位分桶（缩略档不发送，降级必须显式并在结果中写入 `tierFallback`）、像素比对（以作品详情的宽高与实际像素比较）、字节完整性（JPEG 的 FFD9 / PNG 的 IEND / GIF 的 0x3B / RIFF 长度 + `content-length`），任一不通过即换用下一个候选。`qq_send_pixiv` 始终排除 R-18/R-18G，不提供 `r18` 参数；筛选条件全部在本地对已抓取数据执行（镜像站只支持 `keyword` 与 `page`），排序仅支持投稿时间。
- **非显然约束（生产观测）**：现象：上半部分正常、下半部分灰化的图片通过全链路校验，是不完整图像的成因。机制：`looksLikeImageBuffer` 只校验开头 3 个字节。现行实现与判据：字节完整性由 `verifyImageComplete` 判定（JPEG 的 FFD9 / PNG 的 IEND / GIF 的 0x3B / RIFF 长度 + `content-length`）；镜像站单张耗时 2.7~5.7 秒，观测到的最长单张耗时 25 秒，因此仅作为最后候选；cookie 与 Bearer 只发送给 pixiv 自身的域名（`pixivRequestHeaders`），镜像站不接触凭证。

### 5.5 QQ 空间

- **能力定义**：查看空间动态、评论、楼中楼回复、点赞、发布说说（可带一张配图）。
- **实现路径**：工具 `qq_qzone_view`（`mcp-napcat-safe.js:2535`）、`qq_qzone_comment`（`:2578`）、`qq_qzone_reply_comment`（`:2617`）、`qq_qzone_like`（`:2662`）、`qq_send_qzone`（`:2702`）；业务在 `core/qzone.js`，配图在 `lib/qzone-image.js`。
- **关键约束**：配图不落盘优先，字节 ≤ `DEFAULT_BASE64_MAX_BYTES`（10MB，`lib/napcat-file.js:27`）时直接把 `base64://` 交给 NapCat，超过上限才写入 `napcat.tmpDir`，并在 `try/finally` 中无论成败都删除（`qzone-image.js:101-131`）。空间内容公开可见，因此配图一律排除 R-18，与 `qq_send_pixiv` 同一约束；`qq_send_qzone` / `qq_qzone_like` 受总开关 `QZONE_TOOL_DISABLED` 控制。
- **非显然约束（生产观测）**：现象：配置了配图也不会发出且不报错；点赞接口返回 HTTP 500；成功响应中的 `tid` 恒为 null。机制：`send_qzone_msg` 只读取 `images`，参数名为 `file` 时被静默忽略；点赞接口 `emotion_cgi_do_like_v6` 已停用；`tid` 位于 `data.tid`，多读一层 `data.data.tid` 即取不到值。现行实现与判据：配图写入 `images`，点赞走 QZone 现役接口 `internal_dolike_app`，`tid` 从 `data.tid` 读取。

### 5.6 撤回与历史

- **能力定义**：撤回自身刚发送的消息；展开被引用的转发消息、读取群文件；检索历史记录。
- **实现路径**：`qq_withdraw_message`（`mcp-napcat-safe.js:1230`）、`qq_get_message_detail`（`:1507`）、`qq_get_my_recent_messages`（`:1489`）、`qq_get_forward_msg`（`:1942`，合并转发展开）、`qq_get_file_content`（`:1525`）、`qq_get_group_history`（`:922`）。检索实现在 `core/memory.js` 的 FTS5（`memory.js:172`），工具 `qq_memory_search`（`:2824`）。
- **文件段与图片段的区分**：现象：文件段原先渲染为 `[文件名字]`，无名字时仅剩一个 `[文件]`，唤醒正文另加一个 ` [file]`，模型无法判断对象类型，可能把对方发来的 PDF 当作图片去调用识图工具。现行实现与判据：统一为 `[文件:报告.pdf · PDF · 1.2 MB]`（名字 · 类型 · 大小），`[Unread]` 行上的标记为 ` [file:PDF]`；名字缺省时写入「未命名文件」，不退化为裸 `[文件]`。类型映射与渲染只有一份实现：`lib/message-parse.js` 的 `fileKindLabel` / `formatBytesShort` / `fileMarker`，三个调用点（`segmentsToText`、`forward.js` 的合并转发展开、`wake-send.js` 的 `[Unread]` 行）全部 import 该实现；`extractFilesFromSegments` 同时把 `ext` / `kind` / `marker` 记入消息对象。preset 中补充一条：`[图片]/[image]` 是图片，使用识图工具处理；`[文件:…]/[file:…]` 是文档，不是图片，读取须使用 `qq_get_file_content`，不得直接描述内容。回归测试 `qq-bridge/tests/file-marker.test.js`（20 项）。
- **关键约束**：只能撤回自身发送的消息，`messageId` 来自唤醒正文的 `(id:xxx)` 或 `qq_get_my_recent_messages`；撤回事件由桥落库并标记 `[已撤回]` + 写入 `chat_messages.recalled_at`（`bridge.js:589-614`）。
- **非显然约束（生产观测）**：现象：检索未命中时模型报告无法检索更早的消息，属成本较高的失败模式，对应实现为 `content LIKE '%词%'` 全表扫描。现行实现与判据：FTS5 trigram 外部内容表 + 触发器同步 + BM25 排序，结构变更时将 `FTS_SCHEMA_VERSION` 加 1（`memory.js:120`，当前值 `'2'`）并自动重建。另有一项限制：trigram 要求每个 token 至少 3 个字符，不足 3 字的关键词会被 FTS5 直接拒绝（`memory.js:243`）。

### 5.7 在途注入与回合保持

- **能力定义**：模型正在执行某一步时到达的消息不另起一轮，直接 steer 进当前回合；回合保持（turn-hold）使首次唤醒开启的回合继续持有，让后续消息落在同一回合内。
- **实现路径**：`core/wake-send.js` 的 `steerIntoRunningTurn`（`wake-send.js:800`）、`core/turn-hold.js`（`holdLoop:131`、`flushStepBatch`）、插件 `qq-bridge/plugins/dsh-qq-hold/`（`agent/turn-stopping` 钩子，路由 `core/console-server.js:1667`）；另一发车点为 `core/mux.js` 收到 `step/end` 时调用的 `flushStepBatch`。
- **关键约束**：单个 HTTP 请求只持有 `requestBudgetMs`（默认 55 秒，夹在 `[3000, 120000]`，`turn-hold.js:137`），该时段未等到消息即返回 `{ close: false, again: true }`，插件收到后立即重新发起一次请求（`again` 分片协议），因此对 DSH 而言钩子持续等待，对 HTTP 而言每个请求都很短。其余参数：`maxExchanges` 24、`idleCloseMs` 30 分钟、`maxWaitMs` 60 分钟、轮询 200ms、看门狗续期 5 秒。硬不变量：默认关闭（`social.turnHold.enabled !== true` 立即放行）、同一会话单飞（`activeHolds`）、不在该路径标记已读、轮换到阈值即放行关回合。
- **已答复回合的尽早关闭**：现象：2026-09-22 的 14:57~15:02 之间每 55 秒一条 `keep-holding` 记录，`exchanges=0`，单回合持续十余分钟，DSH 界面维持等待显示。机制：保持循环的作用是把同一轮内连续到达的消息并入同一回合，其空闲放行门槛为 `idleCloseMs` 30 分钟，因此在「模型已发出气泡且对方不再发言」的状态下钩子不返回。现行实现与判据：本回合已发出过内容（`turnHasBubble(key, sid, st)`，即发送类工具成功过 / 已有待发正文 / `lastAiReplyAt` 晚于本回合开始）且静默超过 `social.turnHold.answeredIdleCloseMs`（默认 90 秒）即关回合（`finish('answered-idle')`）；连发合并窗口（数秒内）不受影响。回归：`qq-bridge/tests/inbox-hold-release.test.js` 的第 ④ 组 6 条断言（判据存在、默认值、三参调用、理由名、排序在 30 分钟门槛之前、import 正确）。
- **合并注入**：同一个模型步内只产生一个 `[Mid-turn]` 块（`STEER_COLLECT_MS` 收集窗 + `STEER_CYCLE_MS = 5000` 周期闸），送达时刻与「到达即注入」相同，但模型只见到一个块、只发出一个气泡。
- **非显然约束（生产观测）**：现象：同一批未读消息被两次读取，QQ 上出现重复回复一次。机制：投递结果由单个 boolean 加一个字符串标记表达，`true` 既表示「实际投递成功」，也表示「本回合已经提供过」，还表示「被周期闸暂存，实际未投递」；`'typing-defer'` 表示对方正在打字、继续暂存；`false` 才表示真实失败。把「已经提供过」返回为 `false` 时，调用方据此判定投递失败并再次投递完整唤醒至同一回合。现行实现与判据：「已经提供过」不再以 `false` 表达；「被周期闸暂存」返回 `true` 时必须验证确实落地（判据是 `collectMidTurnBatch(st)` 返回空），未落地则继续持有并重试，不报告虚假成功。

### 5.8 表情包两套体系

- **能力定义**：两套体系相互独立。① QQ 账号自身的收藏表情（官方接口）；② 随包分发的内置表情包 meme-packs（一个包 = 一个目录，含 `manifest.json` + `index.db` + `memes/<tag>/<文件名>`）。
- **实现路径**：收藏侧 `qq_list_stickers`（`:1749`）、`qq_get_sticker_image`（`:1775`）、`qq_send_sticker`（`:1803`）、`qq_collect_sticker`（`:1830`）、`qq_sticker_note`（`:1885`）、`qq_set_sticker_remark`（`:1916`），实现在 `core/sticker.js`；内置侧 `qq_meme_search`（`:2066`）、`qq_send_meme`（`:2116`）；QQ 原生表情 `qq_face_list`（`:2772`）、`qq_send_qq_face`（`:2792`）。
- **关键约束**：一条消息只能是一张贴纸或一个表情，不能在同一气泡内附带文字，须先发送文字再发送表情；`qq_set_sticker_remark` 默认关闭（`social.tools.setStickerRemark=false`），通常使用 `qq_sticker_note` 即可。包目录有三个位置：`<runtime>/meme/<packId>`（出厂）、`<runtime>/meme-packs/<packId>`（后装或上传）、`<角色库根>/<角色slug>/meme-packs/<packId>`（角色专属，随当前角色变化，`mcp-napcat-safe.js:1915-1939`）；未找到包时 `qq_meme_search` / `qq_send_meme` 不注册（`:251` 会打印尝试过的全部路径）。
- **未提供文件名时的选取**：`qq_send_meme` 的 `file` 参数由必填改为可选，并补充三条路径。① `fileName` 别名，客户端使用其它名称时不再触发 `-32602`；② `query`（情绪或内容描述）+ `tag`（分类），未提供文件名时桥使用与 `qq_meme_search` 相同的 SQL 选取第一条（`firstMemeByQuery`：按 `orderedMemePacks` 顺序只读打开各 pack 的 `index.db`，跳过损坏包），并把选中的 `file` / `pack` / 命中的 caption 一并回报（`pickedByQuery: true`）；③ 两者均未提供时返回可操作提示，即要求提供 `file` 或 `query`，而非校验层的原始错误。回归 `qq-bridge/tests/meme-query-fallback.test.js`（20 项，含「两条返回路径都带上 `pickedByQuery`」）。
- **发送节奏**：是否发送由桥掷骰决定（`core/send-dice.js` 的 `memeTurnHint`），概率 `social.sticker.sendProbability`（默认 0.3）、冷却 `sendCooldownMs`（默认 3 分钟），命中时插入 `[Meme] dice HIT`；取值为 0 表示不主动发送，仅在明确要求时发送。
- **非显然约束（生产观测）**：NapCat 未暴露 `add_custom_face` 时，收藏降级为本地图库（`core/sticker.js:546-549`）；工具返回「当前 NapCat 版本不支持自动收藏」时应停止重试并向对方说明暂不可用。GIF 不得作为本地路径发送，QQ 只显示闪烁的静态预览，必须走 `qq_send_meme`。

### 5.9 联网搜索与解析

- **能力定义**：`web_search` 联网检索、`web_fetch` 抓取网页正文；`qq_video_parse` 解析视频链接（只读）、`qq_video_search` 按关键词检索视频；位置信息由 `qq_send_rich` 的 `location` 卡片承载。
- **实现路径**：`mcp-web-search-safe.js`（`web_search:944`、`web_fetch:980`，SSRF 防护走 `safe-fetch.js` 的 `validateFetchUrl` / `safeFetchBuffer`）；`qq_video_parse`（`mcp-napcat-safe.js:3023`）、`qq_video_search`（`:3123`）、`core/video.js`；位置卡在 `core/console-server.js:3163-3403`。
- **关键约束**：视频解析无法取得元数据时返回 `degraded:true`，此时如实报告无法获取，不构造内容。位置卡有三种形态（`social.send.locationMode`）：`tuwen`（默认，高德图文卡）、`map`（静态地图图 + 地点文字 + 地图链接）、`native`（QQ 原生位置气泡）；配置高德 key 时使用官方静态图，未配置时使用已验证可用的一张。
- **非显然约束（生产观测）**：原生 `location` 段用 `get_friend_msg_history` 回读时段列表为空（`console-server.js:3167-3178` 的线上取证），因此默认不发送该形态；腾讯地图卡的实测形态为微信小程序卡，无法直接构造，现行实现生成等价的图文卡（`appid=100571486` 为高德在 QQ 内的应用号，`social.send.locationApp='amap'` 可切回高德身份）。

### 5.10 记忆与画像

- **能力定义**：长期记忆的写入与检索、群成员结构化档案、黑话库、人格与画像学习。
- **实现路径**：`core/memory.js`（分层 `MEMORY_TIERS:117`、FTS5 `:172`）、`core/persona-learn.js`、`core/portrait-learn.js`、`core/slang.js`、`core/persona-text.js`、`core/learning-token.js`。工具：`qq_memory_remember`（`:2862`）、`qq_memory_search`（`:2824`）、会话级记忆 `qq_memory_query` / `_append` / `_remove` / `_clear`（`:1578` / `:1548` / `:1598` / `:1622`）、档案 `qq_profile_get` / `qq_profile_set`（`:2316` / `:2280`）、学习 `qq_persona_learn_start` / `_stop` / `_status`（`:3578` / `:3598` / `:3616`）。
- **关键约束**：三层记忆为 `permanent`（0 = 永不过期，`pinned=1` 或 `category ∈ {rule, owner, identity}`）、`durable`（90 天不活跃淡出，默认层）、`working`（7 天淡出）；检索为 FTS5 `tokenize='trigram'` 外部内容表 + BM25。学习会话只加载 host 组 MCP，提交工具全名固定为 `mcp__napcat-host__qq_learning_submit` / `mcp__napcat-host__qq_learning_corpus`，写成 `mcp__napcat__` 那组会直接返回 unknown tool。
- **`[Recall]` 注入位置**：永久层与高重要度记忆的短摘要写入唤醒正文（`wake-send.js:451`，`limit: 14, maxChars: 700`），不写入系统提示词，因为系统提示词一经变更会使整段前缀缓存失效（该步全价重读数万 token），摘要写在每轮更新的位置只占用其自身字符数。
- **学习触发方式**：共四类，分别为立即 / 间隔 / 每日定时 / 文本指令；画像学习复用人格学习的这套触发方式（`core/portrait-learn.js:1-3`），只是目标来源不同，前者为手工填写的 `persona.targetQQ`，后者从聊天记录中筛选活跃群成员。
- **非显然约束（生产观测）**：现象：人格档案被一轮只提交 nickname 的学习覆盖为两个词，旧的长文被整条覆盖。机制：档案写入按整条替换执行，不比较新旧文本的长度与信息量。现行实现与判据：新文本明显更短且旧文本足够长时保留旧文本（`mergePersonaProfileText`，`persona-learn.js:492`）；已确认的黑话词条不再常驻上下文，由模型按需检索。

#### 5.10.1 DSH 侧长期记忆插件（`@meomeo-dev/dsh-memory`）

- **能力定义**：在桥自身的长期记忆（`core/memory.js`）之外，隔离 DSH 内另有一套跨会话语义事实记忆，只保存提炼后的 `rules` / `lessons` 两类条目，不保存整段历史会话；与 DSH 内置的 `session-reference`（整段历史会话快照）互补。
- **实现路径**：插件源码位于 `qq-bridge/plugins/dsh-memory/`（包名 `@meomeo-dev/dsh-memory`，版本 0.5.6）；桥启动时幂等安装，源码拷贝到 `<DSH home>/profiles/node_modules/@meomeo-dev/dsh-memory`，并在 `<DSH home>/plugins/dsh-memory` 建立指向该拷贝的符号链接（`qq-bridge/src/lib/dsh-side.js:408-566`）。模型侧工具为 `remember` / `recall` / `forget` / `memory-find` / `memory-update` / `memory-delete`，其中 `recall` 由多节点记忆 team 召回并逐条返回完整字段与来源文件，`forget` 与 `memory-delete` 删除 `rules` 类条目时须带 `confirm: true`。人工侧命令为 `/lmemory`，Web 模式下 `/lmemory ui` 返回带访问令牌的面板链接，面板含记忆、状态、目录、节点、设置与 Global 六个页面。
- **存储模型**：真相源为 `.remember.jsonl`（一行一条 JSON，逐行 schema 校验，字段含 `id` / `createdAt` / `type` / `domain` / `scope` / `layer` / `entry`）；渲染投影为 `.remember.md`（9 列 Markdown 表格，只由纯函数生成，不反向解析）；派生索引为 `catalog.json`（每层记忆目录一个，记录「记忆 id → 所在文件」，可重建）。文件命名规范为 `YYYY-MM-DD[.<partition>].<type>.remember.{jsonl,md}`。目录发现优先级为：内置 < 用户 `~/.agents/lmemory` < 用户 `~/.dsh/lmemory` < 项目 `<repo>/.agents/lmemory` < 项目 `<repo>/.dsh/lmemory`；global 目录 `~/.dsh/lmemory/global/` 独立于该发现链，按消费方显式追加。
- **关键约束**：内置层（`qq-bridge/plugins/dsh-memory/lmemory/`）只读，读路径（发现、召回、统计）包含该层，写路径（`remember`、`catalog rebuild`）不作用于该层；当前内置层无条目，目录留空时发现逻辑静默跳过，该目录必须保留在包内（git 追踪与 npm `files` 白名单均包含 `lmemory`），否则内置层在所有安装上缺失。global 层只由四个门禁路径写入（文档抽取、提升评审、global 导入、存量迁移），`remember` 的 `layer` 参数只接受 `user` / `project`。
- **非显然约束**：插件的依赖解析走 `<DSH home>/profiles/node_modules` 下的真实拷贝，`<DSH home>/plugins/dsh-memory` 只是可见落点；源码目录直接放在 `qq-bridge/plugins/` 下时解析不到 `@deepseek-ai/dsh-*` 系列依赖，因此装配流程必须拷贝而非仅建链接（`qq-bridge/src/lib/dsh-side.js:490-526`）。单元测试以 mock 注入模型调用；召回、质检、抽取与提升需真实 `DEEPSEEK_API_KEY` 才能端到端验证。
- **人工侧子命令**：`/lmemory` 的子命令与作用见表 11；`global extract` 读取的本地文档上限为 1 MiB，`--dry-run` 只回显不写盘，`--confirm` 在命中暂存时零调用写盘，未确认时 `global promote` 不发起调用。

表 11：`/lmemory` 子命令与作用（口径：插件的命令注册表，见 5.10.1）

| 子命令 | 作用 |
| --- | --- |
| `help [command]` | 全部命令一览；带子命令名时给出该命令的详细帮助 |
| `status` | team 节点数与每节点状态 |
| `stats` | 记忆统计：条目数（rules / lessons）、layer 与 domain 分布、文件大小、catalog 条目数（纯文件读，不发起模型调用） |
| `usage [--days N]` | 预热 team 与 system prompt 摘要的上下文成本估算，以及本进程 recall / extract / review 的调用消耗；`--days N`（1~90）按 `~/.dsh/lmemory/usage.jsonl` 聚合，重启不丢 |
| `team start / stop / restart` | 组装、释放、重新组装 team |
| `query <text>` | 人工查询长期记忆 |
| `review [layer / domain]` | 以 `deepseek-v4-pro` 质检记忆中的矛盾、重复、过时与背离，报告注入主会话 |
| `catalog rebuild [--root <path>]` | 从全部 jsonl 重建 catalog；`--root` 只重建给定的记忆根目录 |
| `global extract <file> [--dry-run / --confirm]` | 读取本地文档交抽取小队处理，回显候选与门禁结论 |
| `global promote [--confirm]` | 对全部 user / project 记忆严格评估并提炼为 global 候选，先回显预估节点数与成本 |
| `global review` | 质检 global 目录条目，报告注入主会话 |
| `config get / set <key> [value]` | 读写插件配置 |
| `collections list / add <root> / forget <root> / export [--out <dir>]` | 记忆根注册表管理与记忆包导出（备份、分享） |
| `pricing` | 打印价格表全文与文件路径（CNY 每百万 token，成本估算的计价依据） |
| `ui` | 返回记忆 Web 面板的页面链接（仅 web 模式可用） |

### 5.11 卡片与富媒体

- **能力定义**：音乐点歌卡、视频卡（原生小程序 Ark 优先）、联系人卡、位置卡、骰子与猜拳、合并转发、Word 文档。
- **实现路径**：`qq_send_rich`（`:3018`）与 `core/media.js`（`createMediaDomain`）、`qq_music_search`（`:3079`）、`qq_send_forward`（`:2985`）、`qq_send_docx`（`:2955`）与 `core/docx.js`；签名服务是独立进程 `qq-bridge/music-sign-proxy.py`。
- **封面处理三条约束**：① 封面只做 URL 归一化（`normalizeCoverUrl()`：http 升为 https、限定尺寸、补 `type=jpg`），不经过第三方图片代理（`media.js:337-387`）；② 版式分两种，`share`（默认）按真机分享的图文卡渲染，手机端会绘制封面，`music` 为旧的 `music.lua` 版式（手机端不绘制封面，且会被「将要访问」中转页拦截一层），可用 `social.send.musicCardStyle='music'` 回退；③ 视频卡优先使用原生 Ark（B 站 / 微博走 NapCat 的 `com.tencent.miniapp_01`，`console-server.js:3134`），只有失败才回落为「封面图 + 分享文本」。
- **关键约束**：不手工书写卡片字段。模型只传 `type=music` + `musicType` + `musicId`，桥自行解析标题、歌手、封面与音频，失败时自动回落为官方歌曲链接并在结果中写入 `music.card=link`。`qq_send_docx` 有每日额度（`state/docx-quota.json`，`core/docx.js:27`）；NapCat 在容器内运行时宿主路径不可读，这正是 `lib/napcat-file.js` 的存在依据。超过单条上限（`social.send.maxMessageChars`）时使用 `qq_send_forward` 或 `qq_send_docx`，不拆分气泡。
- **非显然约束（生产观测）**：现象：手工书写封面字段会导致手机端出现空白卡片；一版 wsrv 代理会使签名服务把图片转存为手机端不渲染的 `qq.ugcimg.cn` 链接（该版本已回退）；`y.gtimg.cn` 在本机客户端上可用性不稳定。机制：封面只做 URL 归一化，第三方图片代理会改写最终域名，而手机端只渲染白名单内的域名。现行实现与判据：统一改写为 `y.qq.com`；网易云封面的 URL 后缀为 `.jpg`、`content-type` 也报 `image/jpg`，实际字节为 PNG（magic `89504e`），因此按首字节判定，不按扩展名判定。

### 5.12 权限与安全

- **能力定义**：判定「谁可以与机器人对话」（白名单 / 黑名单）与「谁可以修改机器人配置」（账号所有者 / 管理员），以及跨会话发送的授权。
- **实现路径**：`core/config.js:77-90`（`allow` / `deny` / `allowAllWhenEmpty` / `allowAllPrivate` / `allowAllGroups`）、`lib/config.js` 的 `isAllowed`、`core/console-server.js` 的 `crossSessionRefusal`（`:550`）。工具：`qq_whitelist`（`:2380`）、`qq_blacklist`（`:2342`）、`qq_admin_set`（`:2361`）、`qq_remove_friend`（`:2399`）、`qq_set_system_config`（`:1213`）。
- **关键约束**：白名单两侧均为空且 `allowAllWhenEmpty=true` 时放行所有来源，启动时会输出警告；`allowAllPrivate` / `allowAllGroups` 为分侧放行（群聊严格、私聊宽松），这两个键恒为布尔值，界面按「配置中存在的键」渲染。`qq_whitelist` / `qq_admin_set` / `qq_set_system_config` 仅在管理员私聊中可用；黑名单与删除好友均不作用于管理员，账号所有者（`config.social.ownerQq`）不可删除；发送到非当前会话必须显式携带 `crossSession=true`，否则拒绝。
- **缺少 `key` 时直接拒绝**：工具层不推断会话。现象：多会话在途时按「最近活跃者」推断目标会话，图片被发送到其它群。现行实现与判据：缺少 `key` 时报错并指回唤醒正文的 `[Session] group:<群号>` / `[Session] private:<QQ>` 那一行（`mcp-napcat-safe.js:566-575`），不做任何推断。发送类工具还额外经过 `/api/social/check-send`，跨会话闸门设置在该处。
- **敏感内容拦截**：agent 回复命中本机路径或凭据特征（`qq-bridge/src/sensitive.js` 的 `SENSITIVE_RE`）时，`core/audit.js` 的 `handleSensitiveIntercept` 硬性拦截不发送，宁可误拦不漏发；`lib/text-safe.js` 提供 `redactSensitiveText` 供日志写入前脱敏。
- **发送侧的白名单强制**：发送类 MCP 工具的目标必须命中白名单，群发送校验 `allow.groups`、私聊发送校验 `allow.private`，未命中即拒绝（`mcp-napcat-safe.js:948`、`:1003`、`:1316`）【已核验】。
- **CQ 码注入拒绝**：正文中的 `[CQ:` 一律转义为 `[CQ：`，避免底层网关把模型正文当作消息段解析（`mcp-napcat-safe.js:391-393`、`lib/text-safe.js:130-154`、`core/qq-send.js:262`）；唯一的例外是显式的 `[CQ:at,qq=<数字>]`，它被解析为真正的 at 段并补一个分隔空格（`core/qq-send.js:249-270`）【已核验】。
- **宿主进程控制闸门**：`start_napcat` / `stop_napcat` 在 `napcat.allowProcessControl !== true` 时根本不注册（`mcp-host-server.js:263`），调用时再校验一次并拒绝（`:273-278`）；`napcat_status` 仅在该开关开启且模式判据成立时才回报 `launcher` / `homeDir` / 进程 PID（`:254-256`）。模式判据取 `GET /api/status` 的 `mode` 字段是否等于 `'default'`（`mcp-host-server.js:73-86`），而该端点当前返回 `role` / `roleMode` / `dshReady` / `ownerQQ` / `allowGroups` / `allowPrivate` / `socialPaused` / `activity`，不含 `mode`（`console-server.js:768-780`），因此进程控制与进程信息在当前版本上实际不可用【已核验】。

### 5.13 唤醒与调度

- **能力定义**：判定一条群聊或私聊消息是否唤醒模型、以何种理由唤醒，以及定时消息、主动发言与活跃时段。
- **实现路径**：`core/wake-send.js` 的 `evaluateWakeTrigger`（`wake-send.js:179`）与 `buildWakePrompt`；调度统一入口 `core/social-state.js` 的 `scheduleWake`；定时 `core/scheduler.js` + `qq_schedule_message`（`:1101`）/ `qq_schedule_list`（`:1128`）/ `qq_schedule_cancel`（`:1142`）；主动 `qq_proactive_send`（`:2039`）；活跃时段 `core/activity.js`（`startActivityTick:100`）+ `qq_get_activity_hours`（`:1167`）/ `qq_set_activity_hours`（`:1181`）。
- **判定顺序**：私聊 → 睡眠窗口（群聊窗口内只放行 @ 或引用）→ @ / 引用优先于 `anyMessage` → `anyMessage` → 点名 → 关键词（不超过 4 位的纯英文或数字关键词按词边界匹配，避免 `ADS` / `BDSM` 误触发）→ 提问（`isDirectedAtAi`）→ AI / 技术话题（`TOPIC_WAKE_RE`）→ 指定发言人 → 概率。
- **关键约束**：默认 `social.wake.defaultMode = 'active'`（默认活跃，每条消息都唤醒，`core/config.js:166-169`）；不再默认「无限期潜水」，潜水时需给出有限时长（`recommendedSleepMinMs` / `recommendedSleepMaxMs`，默认 5~120 分钟），到期自动恢复活跃；沉睡前有强制观察窗口（`preSleepWaitMs` 默认 30 秒）。限流：`maxWakePerMinute` 1、`maxWakePerHour` 12；连续 `noActionLimit`（默认 3）次唤醒既未发送消息也未调用 `mark_read` / `set_wake_config` 时软重置唤醒配置。
- **非显然约束（生产观测）**：现象：群内 @ 机器人无响应。机制：`anyMessage` 分支排在 @ 之前，@ 因此被标记为 `anyMessage`，而免打扰时段只放行「真实触发」。现行实现与判据：@ 与引用分支排在 `anyMessage` 之前（2026-09-19 修改，`wake-send.js:188-193`）。另外，`qq_wait_for_messages` 挂起时消息作为工具结果返回模型，不经过投递路径，因此该工具配置了 11 分钟的长等待超时，而非默认的 180 秒无响应判定。

### 5.14 跨会话投递

- **能力定义**：一个会话中的模型向另一个会话留言，或读取其它会话留下的留言。
- **实现路径**：`qq_crosschat_send`（`mcp-napcat-safe.js:1394`）、`qq_crosschat_inbox`（`:1417`），落库 `state/crosschat.json`，实现在 `core/crosschat.js`。
- **关键约束**：工具必须显式携带 `crossSession: true` 才允许发送到非当前会话（`core/console-server.js` 的 `crossSessionRefusal`，`:550`）；受信任的跨会话代发名单为账号所有者 `ownerQQ` 加上 `social.trustedCrossSessionUids`（`console-server.js:503`、`mux.js:314` 的 `isTrusted` 判定），名单外的来源不适用代发语义。
- **闸门性质**：该约束属于调用期约束，拒绝调用但不减少请求体积，与 `social.slimTools.*` 的注册期裁剪是两套机制，排查时不应混淆。

### 5.15 角色库与 persona 合成

- **能力定义**：角色包（一个子目录 = 一个包）的只读检索；`persona.md` + `speech-rules.md` 与 agent preset 合成后进入系统提示词的方式。
- **实现路径**：工具 `qq_character_list`（`:4601`）、`qq_character_read`（`:4617`）、`qq_character_pack`（`:4634`）、`qq_character_search`（`:4650`）；合成在 `lib/preset-compose.js`（`composePresetText`、`readOverrideFiles`、`overrideStampOf`、`syncPresetOverrides`、`watchOverrideFiles`），装配在 `bridge.js:274-309`；是否需要补充注入的判据在 `wake-send.js` 的 `shouldInjectPersonaBlock`（`:303`）。
- **关键约束**：四个角色工具均为只读，不修改人设文件；只有导入 `persona.md` 的那一张卡会自动进入提示词，其余角色包不会进入。字节上限：`qq_character_read` 默认 32KB（硬上限 131,072）、`qq_character_pack` 默认 24KB（可放宽到 128KB），截断时如实说明裁剪了哪个文件的哪一部分。文件上限：`persona.md` 16000 字符、`speech-rules.md` 12000 字符。
- **非显然约束（生产观测）**：现象：向文件末尾追加的规则不进入提示词（线上 `speech-rules.md` 已达 6683 字符，自第 30 条后半句起未进入模型）。机制：超限处理只保留头部、整段丢弃尾部，追加位置恰好落在被丢弃的部分。现行实现与判据：保留头部与尾部（尾部 2500 字符必留），并把「裁剪了第几到第几个字符」写入日志（`wake-send.js:260-271`）。另外，`agentPreset` 只在创建会话时绑定，修改 preset 后旧会话仍使用旧提示词，需等待轮换或归档重建。

#### 5.15.1 角色卡目录（`roles/`）

- **能力定义**：`roles/` 目录以「一个 `<角色名>.md` = 一个角色」的形式保存人设卡；当前角色由 `state/current-role.json` 的 `role` 字段标识，取值为角色文件名（不含扩展名）。
- **实现路径**：读写与列表在 `qq-bridge/src/lib/role-access.js`（`listRoles` 列出该目录下除 `README.md` 以外的 `.md`，`readRoleState` / `writeRoleState` 读写状态文件）；注入在 `qq-bridge/src/core/role-hint.js` 的 `currentRoleHint` / `currentRoleHint2`，由 `qq-bridge/src/core/console-server.js:1647` 提供给会话；控制台端点为 `GET /api/roles`、`POST /api/role`、`POST /api/role-mode`、`POST /api/roles/create`（`console-server.js:782-829`）。
- **关键约束**：单张角色卡的注入上限为 6000 字符，超出部分截断（`role-hint.js:24`）；角色名经 `sanitizeRoleName` 清洗，只保留字母、数字、汉字、下划线与连字符（`role-access.js:8-10`）；`README` 为保留名称，创建同名角色会被拒绝（`console-server.js:822`）；注入内容按 `state/current-role.json` 与角色卡的 mtime 缓存，文件内容变更后无需重启即生效（`role-hint.js:19-25`）。
- **非显然约束（生产观测）**：聊天中的自然语言角色切换句（如「进入角色扮演」）对非管理员一律拦截并回复「角色切换仅管理员可在管理端操作」（`core/mux.js:374-377`）；管理员侧的斜杠命令 `/role <包名>` 走的是角色库（`characters/`）合成路径，把整张卡合成为 `persona.md` 后原子写入，与本目录的角色卡是两套机制（`core/mux.js:531-558`、`lib/persona-switch.js`）。角色卡的字段与含义见表 12。

表 12：角色卡字段（口径：`qq-bridge/roles/*.md` 的示例文件格式，见 5.15.1）

| 字段 | 含义 |
| --- | --- |
| 性格 | 角色的稳定倾向（示例：嘴硬心软，被称赞时回避） |
| 说话风格 | 句长、语气词与标点的用法 |
| 背景设定 | 与账号所有者及其他成员的关系设定与说话分寸 |
| 与群友的互动规则 | 对哪类消息必须回应、哪类消息不主动介入 |
| 特殊能力 | 该角色可使用的工具范围，或限定为仅对话 |

### 5.16 管理端与部署

- **能力定义**：管理端是编排者，负责启动进程、写入配置、查看日志与 SSH 部署，不位于 QQ 数据链路上；桥侧负责配置热加载与隔离 DSH 的装配。
- **实现路径**：`server/index.js`（HTTP API、实例编排与探活、前端静态托管；`RUNTIME_ROOT` 见 `server/index.js:25-31`）、`server/deploy.js`（克隆部署与 `buildDeployKeepScript()`，`deploy.js:350`）、`server/napcat-guardian.mjs`（关窗守卫，独立进程）；桥侧 `core/config.js` 的 `watchConfigFile` + `applyConfigInPlace`、`lib/dsh-side.js`（`installToIsolatedDsh:590`、`patchProfileCordis`、`mcpBlock`）、`lib/dsh-compaction.js`、`lib/tool-tiers.js`、`lib/tool-schema-compress.js`。
- **配置热加载**：`applyConfigInPlace` 为原地合并，不替换对象引用，十几个模块持有的旧引用继续有效；监听采用目录监听 + 2 秒轮询双重机制。生效期不同：`social.slimTools.*` 在注册期生效，修改后需重启隔离 DSH；`social.tools.*` 只在调用期拒绝，不减少请求体积，无需重启。
- **隔离 DSH 装配**：桥启动时幂等地刷新 preset、装配三个内置插件、把三组 MCP server（`mcp-napcat` / `mcp-napcat-host` / `mcp-web-search-safe`）写进 profile 的 `cordis.patch.yml`，默认不修改桌面端 DSH 实例。MCP 压缩代理（`social.toolCompressor`，默认 `enabled !== false` 即常态启用）只挂载 `mcp-napcat` 这一路，把工具压成 `<server>_invoke_tool` / `<server>_get_tool_schema` 两个包装工具；探测不到压缩机时回退直连并把原因写入日志，不会造成工具表缺失。桥侧由 `core/mux.js` 的 `unwrapCompressedToolName` 把包装名还原成真实工具名。
- **本地控制台**：控制台 API 监听 `consolePort`（缺省 `3100`），提供状态查询（`GET /api/status`）、角色设置与清除（`POST /api/role`）、角色列表（`GET /api/roles`）、角色创建（`POST /api/roles/create`）、静默开关（`POST /api/role-mode`）与活动日志等端点（`core/console-server.js:768-829`）；独立页面已并入管理端主界面，桥侧仅保留 JSON API（`console-server.js:764-765`）。鉴权：`consoleToken` 为空时控制台默认本机可信且不生成令牌，配置合法令牌后所有 API 请求须带 `x-console-token` 或 `?token=`（`console-server.js:540-546`、`:686-694`）【已核验】。
- **部署保留既有数据**：现象：备份目录存在而既有数据未恢复。机制：解包前把目标机原有的 `config.json` / `persona.md` / `state/` 备份到 `/root/qqbridge-prev-<TS>/`，随后的解包步骤直接覆盖并删除该备份，备份内容未参与恢复。现行实现与判据：备份写入 `/root/qqbridge-keep-<TS>/`，解包后逐键合并再恢复核对。
- **NapCat 界面鉴权与登录额度**：入口地址本身携带令牌（`server/index.js` 的 `buildRuntimeInfo` / `resolveServices`，令牌按「NapCat 自身的 `webui.json` → 管理器配置 → 最近一次验证可用 → 出厂值」的顺序取值），但 NapCat WebUI 的首屏只用 `?token=` 换取一次 Credential 并写入 localStorage，自身不再进入应用，页面停留在「未登录 / Unauthorized」；而应用内 WebView 只在 URL 变化时重挂 iframe，因此缺少的是「用同一个地址再载入一次」。现行实现为：WebView 挂载后请求一次 `GET /api/napcat/webui-ready`，服务已通即重载一次（只重载一次），未通则每 4 秒检查一次、最多 60 秒，服务起来后同样只重载一次。
- **登录接口额度**：NapCat 的登录接口按 IP 每 60 秒限量 `loginRate` 次（`napcat/config/webui.json` 的 `loginRate: 10`，语义见 `/opt/napcat/napcat.mjs` 的 `checkLoginRate(ip, loginRate)`），超出即返回 `login rate limit`，而 WebUI 页面自身也要从同一额度中登录一次。管理端的本机入口走 `127.0.0.1`，服务端入口走 SSH 隧道，NapCat 观测到的来源同样是 `127.0.0.1`。现象：页面始终无法登录。机制：任何以登录接口作为探测手段的轮询都会与页面争用同一额度；`/api/napcat/webui-ready` 一度每 2 秒调用一次、每次实际登录一次（最多 20 次），页面因此无法登录。该版本的实现与判据（已于 2026-09-23 移除，见下方更正）：新增 `server/napcat-webui-auth.js` 作为唯一允许登录的位置，包含三项机制：结论缓存（同一 token 通过后 30 分钟内不再登录，失败结论缓存 60 秒）、自建预算（每 `scope:port` 每 60 秒最多 2 次，即 NapCat 上限的 1/5）、限流冷却（识别到 `login rate limit` 后 65 秒内不再尝试）；`/api/napcat/webui-ready` 默认只探活并读取缓存结论（零登录），`?verify=1`（点击「重新鉴权」）才实际验证一次，返回中包含账本 `rateLimit: { napcatLimit, budget, attemptsInWindow, limited, retryAfterMs }`；桥侧 `core/napcat-tokens.js` 的 Credential 复用期由 10 分钟延长至 45 分钟，与 NapCat 校验 Credential 的「一小时内有效」口径对齐。回归 `qq-bridge/tools/test-napcat-webui-auth.mjs`（26 项，使用复现 NapCat 限流语义的模拟 NapCat）。
  > **后续更正（2026-09-23）**：`server/napcat-webui-auth.js` 及其回归已整体移除。相较于为登录接口设置预算，现行方案不以登录接口作为探测手段。判据、替代实现与测量记录见 `docs/ARCHITECTURE.md` §14.4 与 `CHANGELOG.md` 同日记事；本段保留为该版本的历史结论。
- **首次自动鉴权**：管理端在连接刚建立（服务端方式）或本机 NapCat 刚启动（本地方式，每 60 秒检查一次）时，后台静默预鉴权一次 WebUI（`server/index.js` 的 `warmNapcatWebuiOnce`：同一令牌 45 分钟内只执行一次，经 funnel 执行，因此不会与页面争用登录额度），结果记入 `napcatWarmDone`，`GET /api/napcat/webui-ready` 返回 `warm.done`。前端 `src/pages/WebView.tsx` 把「该令牌在此浏览器中已完成过一次鉴权」记入管理器自身的 localStorage（键 `qbm.napcatAuth.<token>`，与 NapCat Credential 一小时的寿命对齐，取 45 分钟）：命中即直接载入，不重载也不鉴权。只有在首次、令牌变更、令牌过期或用户点击「重新鉴权」时才重载一次，该次重载是 NapCat 首屏换取 Credential 所必需的，其取得 Credential 只写入 localStorage，自身不进入应用。
- **连接服务端的状态机**：现象：「服务器正在启动」与「凭据错误导致无法启动」在界面上表现相同，都只有一句「服务端重连中」。机制：原实现走 `scheduleReconnect`（首次还需等待 5 秒退避），只暴露一个等待文案，不区分阶段与失败原因。现行实现与判据：`server/connect-machine.js`（纯逻辑，可单元测试）把过程拆分为阶段：`idle → connecting(SSH) → tunnels(x/y) → server-starting(DSH/NapCat/桥逐个就绪) → warming(静默预鉴权) → ready`，失败进入 `failed` 并记录原因。三个入口（开机自动连接 / 点击「连接」/ 掉线重连）统一走 `connectStep`（SSH + 隧道，失败立即回报）+ `waitServerReady`（后台轮询远程状态、逐个组件就绪、最后预鉴权），因此点击「连接」不会长时间无响应。状态读取接口为 `GET /api/connect`（`/api/state` 中也包含一份），读取该接口不产生网络动作；Home 页把它渲染成横幅（阶段 + 已用时 + `DSH 已就绪 · NapCat 启动中` 明细），SSH 配置页在服务器行内就地显示，并含「启动时自动连接服务器」复选框（写入 `autoConnectServer`，默认开启）。回归 `qq-bridge/tools/test-connect-machine.mjs`（28 项）。
- **非显然约束（生产观测）**：现象：2026-09-23 的 07:39:54 覆盖 `config.json` 之后，桥日志中没有任何「已热加载」记录，此后任何改动都不再触发。机制：管理端以「临时文件 → 备份 → mv」原子替换写入文件，只监听文件时监听器指向已被 unlink 的旧 inode。现行实现与判据：`watchConfigFile` 采用目录监听 + 2 秒轮询双重机制，热加载生效时输出 `已热加载，变更字段: …`；桥自身另有 10 处会把内存中的旧 cfg 写回 `config.json`，未启用热加载时管理端的改动不生效，且会被回滚。

### 5.17 成本与计量

- **能力定义**：逐次请求记账、用量对账、在 QQ 中发送 `/token` 查询用量与花费。
- **实现路径**：`core/token-meter.js`（`meterTokenFrame:514`、`startTokenReconcile:990`）、`core/token-report.js`（`/token`）、`core/context-savings.js`（`initContextSavings:198`）、管理端 `src/pages/Learning.tsx`。
- **关键约束**：真实 `usage` 帧优先，缺失时按帧内文本估算（估算行标记 `est: true`）；对账把 DSH 自身 projcache 中的权威累计差额补成 `reconciled: true` 的行，未找到 DSH home 时静默跳过。计价参数在 `tokenCost`（`core/config.js:108-115`，单位 ¥/百万 token，`peakHours` 为北京时间高峰小时）；修改该参数会同时改变 `/token` 的口径，管理端面板仍读取自身的 `localStorage`。
- **两个日界口径**（`core/token-report.js:99-113`）：计费日以北京 08:00 换日，属于提供方控制台口径，对应面板顶部的「今日已用」；北京自然日以 00:00 起算，属于分时桶口径，对应面板「实测计量」中的「今日 token 合计」。线上测量中同一日的两个口径分别为 592,685 与 12,182,789。现行实现逐行标注口径，`/token N` 按 `dates`（计费日逐日）求和。
- **压缩阈值数学**（阈值 0.16 的推导、永久会话与轮换会话的成本比较）见 [docs/COMPACTION-MATH.md](docs/COMPACTION-MATH.md)，本章不复述；复算脚本为 `node qq-bridge/tools/compaction-threshold.mjs`。
- **非显然约束（生产观测）**：现象：两个口径相邻输出，第一行取计费日，第二行的分量与金额却来自自然日，易被读作计算错误；`/token 7` 把「只计算今日」的 `billedTotal` 标记为「近 7 天」。现行实现与判据：按计费日逐日合计，两个口径在输出中分别标注。

### 5.18 交互面：提问、工具审批、引用与斜杠命令

- **能力定义**：模型的提问、工具审批请求与斜杠命令在 QQ 侧形成可操作的往返：提问与审批以 QQ 消息发出，对方的回复被回注为该请求的应答；DSH 的斜杠命令由桥原样转发执行。
- **实现路径**：事件泵 `core/mux.js` 处理 `question/requested` 与 `approval/requested` 帧（`mux.js:1338-1373`），应答在 `core/events-aux.js` 的 `handlePendingAnswer`（`:44-104`）；斜杠命令的透传在 `mux.js:717`；引用正文的渲染在 `lib/message-parse.js:56-66`。
- **关键约束**：审批只有管理员（`ownerQQ` 或 `adminQQ`）的消息会被消费，非管理员的回复被拒绝并提示「审批仅管理员可操作」（`events-aux.js:69-72`）；提问的回复先按选项标签精确匹配，匹配不中则作为自由文本 `custom` 提交（`events-aux.js:47-51`）；只有应答回执成功才移除挂起项，回执被拒时保留挂起并提示重试（`events-aux.js:87-97`）；黑话学习会话的提问与审批被自动拒绝，避免阻塞学习任务（`mux.js:1318-1336`）。
- **引用与回复的注入格式**：入站引用渲染为 `[引用 <昵称>：<原文>]`（`lib/message-parse.js:62`），使模型能判定该句指向的对象，避免把成员之间引用第三方的对话误判为指向自身；引用机器人自身时按必须回复处理（`mux.js:346-348`）。发送侧引用只可能来自模型显式传入的 `replyToMessageId`，桥不会自行添加引用（`core/qq-send.js:451-457`）。
- **非显然约束（生产观测）**：转发到 QQ 的提问文本、选项标签、审批理由与工具名在命中敏感特征（`src/sensitive.js` 的 `SENSITIVE_RE`）时替换为「（含敏感信息，已隐藏）」并写日志，而非拦截整条消息（`mux.js:1343-1371`），这与发送正文的硬拦截是两套策略。

---

## 6. 能力概览

本章界定按子系统分组的能力清单，给出能力域、实现位置与触发条件。

实现工具、代码位置、关键闸门与非显然约束见第 5 章；更详细的旁证（含未逐行核实的条目标注）见 [docs/CAPABILITIES.md](docs/CAPABILITIES.md)。实现位置一栏相对 `qq-bridge/src/` 解析。

表 13：会话、唤醒与投递能力（口径：`qq-bridge/src/`，触发条件为该能力被调用的前置）

| 能力域 | 实现位置 | 触发条件 |
| --- | --- | --- |
| 群聊与私聊对话 | `core/wake-send.js`（`evaluateWakeTrigger`、`buildWakePrompt`） | 私聊、被 @、被引用、点名、关键词、直接提问、戳一戳、指定发言人、AI / 技术话题、按概率随机接话 |
| 潜水与活跃双模式 | `core/config.js`（`social.wake`）、`core/activity.js` | 通过唤醒配置切换；潜水须给出有限时长 |
| 活跃时段与免打扰窗口 | `core/activity.js`、`qq_get_activity_hours` / `qq_set_activity_hours` | 到达配置的活跃时段或进入免打扰窗口 |
| 在途注入 | `core/wake-send.js` 的 `steerIntoRunningTurn`（`wake-send.js:800`） | 模型正在执行某一步时到达消息 |
| 回合保持（turn-hold） | `core/turn-hold.js`（`holdLoop`）、`plugins/dsh-qq-hold/` | 首次唤醒开启回合后，回合未达阈值、未空闲、未出错 |
| 连发合并 | `core/turn-hold.js`（`STEER_COLLECT_MS`、`STEER_CYCLE_MS`） | 同一个模型步内到达多条消息 |
| 私聊打字状态等待 | `core/social-state.js` | 对方处于打字状态，最多等待 12s，连发续窗 5s |
| 投递看门狗与重复回复恢复 | `core/inbox-marks.js`、`core/turn-hold.js` | 批次已投递但未触发新的模型步 |

表 14：消息发送与表达能力（口径：`qq-bridge/src/`，触发条件为该能力被调用的前置）

| 能力域 | 实现位置 | 触发条件 |
| --- | --- | --- |
| 文本气泡分段 | `core/send-chain.js`、`core/qq-send.js`（`onebotSend`）、`lib/onebot-delivery.js` | 模型调用 `qq_send_message`，且本条字数超过首条以外的节奏阈值 |
| 引用回复 | `qq_reply`（`core/qq-send.js`） | 模型调用并给出引用目标 `messageId` |
| 撤回 | `qq_withdraw_message` | 模型调用，且 `messageId` 属于机器人自身发送的消息 |
| 定时消息 | `core/scheduler.js`、`qq_schedule_message` / `qq_schedule_list` / `qq_schedule_cancel` | 到达预定的发送时刻 |
| 跨会话留言 | `core/crosschat.js`、`qq_crosschat_send` / `qq_crosschat_inbox` | 显式携带 `crossSession: true` |
| 富文本卡片 | `qq_send_rich`（`core/media.js`）、`qq_music_search`、`qq_send_forward`、`qq_send_docx` | 模型按 `type` 调用，卡片字段由桥解析 |
| QQ 原生表情 | `qq_face_list` / `qq_send_qq_face` | 模型调用；一条消息一个表情 |
| 收藏贴纸 | `qq_list_stickers` / `qq_send_sticker` / `qq_collect_sticker` / `qq_sticker_note` | 模型调用；`qq_set_sticker_remark` 默认关闭 |
| 内置表情包（meme-packs） | `qq_meme_search` / `qq_send_meme`（`core/sticker.js`） | 模型调用，或概率 `social.sticker.sendProbability`（默认 0.3）掷骰命中 |
| 语音（TTS / ASR） | `core/voice.js`、`qq_send_voice` / `qq_transcribe_voice` | 模型调用；或 `send.allVoice=true` 且掷骰命中 |
| 图片检索与发送 | `lib/image-search.js`、`qq_image_search` / `qq_send_image` | 模型调用；来源按 `file > messageId > imageUrl > query` 取值 |
| Pixiv 搜图与发图 | `lib/pixiv.js`、`qq_pixiv_search` / `qq_send_pixiv` | 模型调用；始终排除 R-18/R-18G |
| QQ 空间 | `core/qzone.js`、`qq_qzone_*` / `qq_send_qzone` | 模型调用；受总开关 `QZONE_TOOL_DISABLED` 控制 |
| 提问与工具审批转发 | `core/mux.js`（`question/requested` / `approval/requested`）、`core/events-aux.js` | 模型发起提问或工具请求审批；审批仅管理员可应答 |
| 斜杠命令透传 | `core/mux.js`（`:717`） | 会话内消息以 `/` 开头且未被桥的命令处理器截获 |

表 15：记忆、学习与画像能力（口径：`qq-bridge/src/`，触发条件为该能力被调用的前置）

| 能力域 | 实现位置 | 触发条件 |
| --- | --- | --- |
| SQLite 长期记忆 | `core/memory.js`（`state/memory.db`，三层记忆 + FTS5 trigram + BM25） | 模型调用 `qq_memory_remember` / `qq_memory_search` |
| DSH 侧长期记忆插件（dsh-memory） | `plugins/dsh-memory/`（`remember` / `recall` / `forget`、`/lmemory`） | 模型调用记忆工具，或人工执行 `/lmemory` 子命令 |
| 聊天记录库 | `state/chat.db`（`chat_messages` + 全量可搜的 FTS5 索引 + 会话汇总与总量计数） | 管理端「聊天记录」页查看、检索、按条或按会话删除 |
| 会话级记忆 | `qq_memory_query` / `_append` / `_remove` / `_clear` | 模型调用 |
| 群成员画像与结构化档案 | `core/portrait-learn.js`、`qq_profile_get` / `qq_profile_set` | 模型调用，或画像学习任务触发 |
| 黑话学习 | `core/slang.js`、`mcp__napcat-host__qq_learning_submit` | 立即 / 间隔 / 每日定时 / 文本指令 |
| 人格学习 | `core/persona-learn.js`、`qq_persona_learn_start` / `_stop` / `_status` | 同上四类触发方式 |
| 角色库与角色卡 | `qq_character_list` / `_read` / `_pack` / `_search`、`lib/preset-compose.js`、`roles/`、`state/current-role.json` | 模型调用只读工具；管理员执行 `/role <包名>` 或经管理端设置角色 |
| 跨会话互知 | `qq_crosschat_*` | 显式携带 `crossSession: true` |

表 16：感知、检索与媒体处理能力（口径：`qq-bridge/src/`，触发条件为该能力被调用的前置）

| 能力域 | 实现位置 | 触发条件 |
| --- | --- | --- |
| 识图 | `core/media-pipe.js`（`resolveMediaList`）、`core/social-state.js`（`pickAttachableMedia`） | 图片先转文字再交给语言模型，或作为附件直接投递 |
| 图片附件投递 | `core/media-pipe.js`、`core/social-state.js` | 唤醒路径与在途注入路径携带图片段 |
| 转发消息展开 | `qq_get_forward_msg` | 模型调用，且目标为合并转发消息 |
| 群文件读取 | `qq_get_file_content` | 模型调用；唤醒正文中出现 `[文件:…]` 段 |
| 语音转写 | `qq_transcribe_voice`（`core/voice.js`） | 收到 `record` 段 |
| 联网搜索与网页抓取 | `mcp-web-search-safe.js`（`web_search` / `web_fetch`） | 模型调用 |
| 视频解析与检索 | `core/video.js`、`qq_video_parse` / `qq_video_search` | 模型调用 |
| 消息图片获取 | `qq_get_message_images` | 模型调用并给出消息批次 |

表 17：上下文与运行时治理能力（口径：`qq-bridge/src/` 与 `server/`，触发条件为该能力被调用的前置）

| 能力域 | 实现位置 | 触发条件 |
| --- | --- | --- |
| 会话轮换与永久会话 | `core/config.js`（`social.autoReset`） | 达到轮数阈值；`permanent = true` 时不换会话 |
| 上下文压缩阈值 | `core/config.js`（`dshCompaction.thresholdRatio`）、`lib/dsh-compaction.js` | 上下文占用达到阈值比例（默认 0.16） |
| 工具描述压缩与裁剪档位 | `lib/tool-schema-compress.js`、`lib/tool-tiers.js`、`social.toolCompressor` | 注册期生效，修改后需重启隔离 DSH |
| Token 用量统计与费用估算 | `core/token-meter.js`、`core/token-report.js` | QQ 中发送 `/token` |
| NapCat 会话守护与登录态巡检 | `server/napcat-guardian.mjs`、`server/napcat-repair.js` | `get_rkey` 探活失败或登录态异常 |
| Pixiv 登录态看护与令牌轮换 | `lib/pixiv.js` | 令牌到期或探测失败 |
| SSH 远程部署 | `server/deploy.js` | 由管理端触发部署，代码 / 数据 / 表情包 / `config.json` 分别同步 |
| 配置热加载 | `core/config.js` 的 `watchConfigFile` / `applyConfigInPlace` | 目录变更事件或 2 秒轮询命中 |

---

## 7. 仓库目录结构

本章界定仓库的目录划分与各目录的职责。

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
│   ├─ deploy.js             SSH 远程部署 / 克隆部署
│   ├─ iso-credential.js     隔离 DSH 凭据文件读写（本地与服务端共用）
│   ├─ connect-machine.js    开机自动连服务器 / 服务端组件状态机
│   ├─ napcat-repair.js      NapCat 自修动作（由守卫按需调用）
│   └─ napcat-guardian.mjs   关窗守卫（独立进程）
├─ qq-bridge/                桥接层
│   ├─ src/bridge.js         入口
│   ├─ src/dsh-client.js     Node 版 DSH API 客户端（fetch unary + WS 下行事件流）
│   ├─ src/md-to-plain.js    Markdown → QQ 纯文本与 4000 字符分段
│   ├─ src/self-test.js      DSH 侧自测
│   ├─ src/core/*.js         业务：唤醒投递、会话、社交状态、发送链、媒体、语音、学习、用量
│   ├─ src/lib/*.js          基础库：OneBot 客户端、消息解析、图片体检、Pixiv、路径与文本
│   ├─ src/mcp-*.js          三组 MCP server
│   ├─ dsh/agent-presets/    agent preset（qq-chat，仓库与隔离 home 各一份）
│   ├─ plugins/              DSH 插件：dsh-qq-hold、qq-mode-console、dsh-memory
│   ├─ characters/           角色库（一个子目录 = 一个角色包）
│   ├─ roles/                角色卡（一个 .md = 一个角色，见 5.15.1）
│   ├─ docs/                 桥接层文档（PROJECT_GUIDE.md、DSH_SETUP.md 等）
│   ├─ assets/               图片与项目介绍视频（project-intro.mp4）
│   ├─ tools/  tests/  scripts/  开发工具、回归测试与运维脚本
│   ├─ config.example.json   出厂配置模板（真实 config.json 与 state/ 不纳入版本管理）
│   └─ state/                运行数据（记忆库、社交状态、用量日志等）
├─ tools/                    管理端侧开发与运维脚本
├─ docs/                     本文档集
├─ CHANGELOG.md  LICENSE
├─ 本地运行指引.md  手动同步与SSH说明.md
└─ 启动管理端.bat
```

更完整的目录说明与「哪些文件纳入版本管理」见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#2-安装布局与路径解析)。

---

## 8. 常用命令与运维操作

本章界定聊天窗口命令、桥接层的运行与自测命令，以及运维命令。

聊天窗口内（管理员专用，由桥直接执行、不经过模型）：

表 18：聊天窗口命令（口径：桥侧命令处理器，仅管理员私聊可用）

| 命令 | 作用 |
| --- | --- |
| `/reset` `/new` | 重置当前会话：换一个新的 DSH 会话，**保留已回复账本**（防重复回复） |
| `/status` | 当前 DSH 会话 id、白名单是否通过、角色与模式 |
| `/token [天数]` | 今日（或近 N 天）token 用量与花费，口径与管理端「学习」页一致 |
| `/op <QQ或昵称>`、`/op del <QQ或昵称>` | 增删管理员（仅账号所有者） |
| `/role <包名>`、`/role clear` | 从角色库合成并切换人设；`clear` 回到默认人格（见 5.15.1） |
| `/slang ...` | 黑话学习（内部再判一次管理员） |

桥接层的运行、自测与维护命令（在 `qq-bridge/` 下执行）：

表 19：桥接层运行、自测与维护命令（口径：`qq-bridge/package.json` 的 `scripts`、`start.bat`、`restart.bat` 与 `src/core/runtime.js`）

| 命令 | 作用 | 备注 |
| --- | --- | --- |
| `npm install` | 安装桥接层依赖 | 依赖为 `@deepseek-ai/schemastery`、`@modelcontextprotocol/sdk` 与 `zod` |
| `npm start` | 启动桥接进程 | 等价于 `node src/bridge.js` |
| `start.bat` | 以守护方式启动 | 异常退出后 5 秒自动重启；关闭窗口即停止 |
| `restart.bat` | 终止旧实例、清理锁文件、重新启动守护进程 | 桥异常或消息无响应时使用 |
| `npm run self-test [baseUrl]` | DSH 侧链路自测，创建独立测试会话，不触碰现有会话 | 预期输出为连接成功、测试会话创建、prompt 被接受、打印 agent 回复；缺省地址 `http://127.0.0.1:3080`（`src/self-test.js:15`），指向隔离实例时须给出其地址 |
| `npm run check` | 全量回归（含 `check-scope` / `check-size`） | 见「修改源码后」 |
| `node scripts/setup-dsh.mjs` | 在隔离 DSH home 中安装 preset、MCP 组与控制台插件 | 桥启动时自动执行等价装配；见 4.2 |

桥接层的运行约束如下。

- 同一时刻只允许一个桥接实例：启动时以 `state/bridge.lock` 记录 PID，检测到存活实例即以退出码 2 结束并打印「已有实例在运行」（`qq-bridge/src/core/runtime.js:37-53`）【已核验】。
- 隔离 DSH 重启不影响桥：桥每 5 秒探活一次（`qq-bridge/src/core/dsh-watch.js:314`），其间收到的 QQ 消息进入队列缓存，每会话上限 50 条（`qq-bridge/src/core/prompt-deliver.js:17`），DSH 恢复后自动补投【已核验】。
- `config.json` 由桥原地热加载，无需重启（见第 9 章）；`roles/` 内容与 `state/current-role.json` 按文件 mtime 感知（`qq-bridge/src/core/role-hint.js:19-25`）；agent preset 与 MCP 配置的改动须重启隔离 DSH（见 5.16）。

运维（服务器上）：

```bash
cd /root/qq-bridge && bash start-bridge.sh      # 启动桥接进程
bash /root/qq-bridge/tools/restart-bridge.sh    # 重启桥接（部署脚本认这一条）
systemctl status dsh-web                        # 隔离 DSH
systemctl status napcat                         # NapCat（原生跑法）
```

修改源码后（本机）：

```bash
cd qq-bridge && npm run check                   # 全量回归（含 check-scope / check-size）
node tools/align-readme-lines.mjs               # 校验「工具名（:行号）」引用是否与源码一致（目标文件为仓库根 README.md，见第 9 章）
node tools/align-readme-lines.mjs --write       # 按当前源码对齐行号引用（纯机械替换，可重复执行）
node tools/test-meme-search.mjs                 # 表情包：真实 MCP 握手 + 真实 SQLite 查询（16 项）
node tools/test-meme-search.mjs --multipack     # 表情包：多包跨包检索 / pack 过滤 / 未提供文件名时的后备选取（25 项）
node tools/test-meme-search.mjs --negative      # 表情包：无 pack 必须明确报错（7 项）
node tools/test-connect-machine.mjs             # 连接状态机 + 服务端组件判定（28 项）
```

管理端（`MoonBot Public` 根目录）：

```bash
npm run build                                   # tsc -b + vite build：修改过 src/ 或 server/ 之后必须执行
powershell -File tools\restart-manager.ps1      # 重启管理端后端（只终止 qbm-node 的 server/index.js，不影响桥与 DSH）
```

---

## 9. 已知限制

本章界定已知的限制与故障定位入口。

- **机器人无回复**：桥日志（`qq-bridge/state/bridge.log`）中缺少 `NapCat 已连接` 表示连接层问题；桥每分钟探测一次 NapCat WebUI，并以 `[napcat-login]` 行区分「QQ 登录态失效」与「桥连接中断」。桥无法连接 NapCat 时不退出进程，按退避持续重连（`qq-bridge/src/bridge.js` 的 `connectNapcat`）。
- **行号引用对齐器的作用范围**：`qq-bridge/tools/align-readme-lines.mjs` 以仓库根 `README.md` 为目标文件（`align-readme-lines.mjs:20` 的 `ROOT/README.md`，`ROOT` 由 `align-readme-lines.mjs:19` 解析为仓库根），仅重写能唯一对应到 `registerTool` 注册行的「工具名（`:行号`）」引用；本次合并后文中共 64 处 `:NNNN` 引用，其中 47 处经 `--write` 就地校正，余 17 处指向非注册行（普通函数、其它文件或表内示例），脚本只列出而不改写。报告模式与写入模式可重复执行，实测复查为 0 处待对齐。
- **管理端配置修改未生效**：桥对 `config.json` 采用原地热加载（`qq-bridge/src/core/config.js` 的 `watchConfigFile`，目录监听 + 2 秒轮询双重机制）；生效时桥日志输出 `已热加载，变更字段: …`。`agentPreset` 例外，它只在创建会话时绑定，旧会话需等待轮换或归档重建。
- **回复一次性发送**：agent 的回复在回合结束时统一发送，不做流式逐字转发（`qq-bridge/src/core/turn-guard.js:124`）；单条正文超过 4000 字符时按换行切分（`qq-bridge/src/md-to-plain.js:33`）。
- **Markdown 转为纯文本**：链接保留为 `文字 (url)` 形式，代码围栏、标题符与列表符被去除或改写（`qq-bridge/src/md-to-plain.js:2-29`）。
- **媒体占位**：视频段与转发内容中的非文本段渲染为 `[视频]` 等占位标记（`qq-bridge/src/forward.js:46`、`qq-bridge/src/lib/message-parse.js:43`）；图片与语音分别走附件投递与转写路径（见 5.3、5.1），文件段渲染为 `[文件:… · 类型 · 大小]`（见 5.6）。
- **宿主进程控制不可用**：`start_napcat` / `stop_napcat` 在缺省配置下不注册，且模式判据在当前版本上恒不成立，见 5.12。
- **发送的图片为缩略图或内容不完整**：见 [docs/PIXIV-AND-QZONE.md](docs/PIXIV-AND-QZONE.md)；相关闸门为地址档位（`pixivImageTier` / `planPixivSend`）与字节完整性（`verifyImageComplete`）。
- **单句成本偏高**：见 [docs/COMPACTION-MATH.md](docs/COMPACTION-MATH.md)；结论为上下文长度本身几乎不占用成本，成本集中于整段重读，因此阈值并非越小越好。
- **唤醒后响应延迟**：检查 `clampSendPace`；线上观测到 `linearPerCharMs: 650`（17 个字 = 11 秒），桥将其夹在 `[60, 320]`。

---

## 10. 数据与隐私

本章界定数据落盘位置与对外传输范围。

机器人将 QQ 消息、群成员昵称与 QQ 号写入本地 SQLite（聊天记录 `qq-bridge/state/chat.db`、记忆档案 `qq-bridge/state/memory.db`）与 JSON 状态文件，用于上下文、画像与黑话学习。这些数据只保存在本机与部署方自行配置的服务器上，不上传至 MoonBot 项目本身。模型调用会把当前会话上下文发送给部署方配置的模型服务商。

隔离 DSH 侧的长期记忆插件在 `~/.dsh/lmemory/` 及其注册的记忆根下另存一份语义事实记忆（存储模型与子命令见 5.10.1），其 Web 面板仅在 web 模式启用并提供带访问令牌的链接。

---

## 11. 许可与合规

本章界定许可条款与第三方组件的合规边界。

MIT，见 [LICENSE](LICENSE)。

第三方组件：NapCat 是独立第三方项目，与腾讯及 QQ 无隶属关系，仅用于学习与技术研究；使用前应阅读其 EULA 与《QQ 用户协议》【据仓库记载】。

访问控制的三条强制项与合规相关，实现见 5.12：发送类工具的目标必须命中白名单（`allow.private` / `allow.groups`）；正文中的 `[CQ:` 一律转义，拒绝 CQ 码注入；NapCat 的进程控制缺省关闭。白名单两侧为空且 `allowAllWhenEmpty: true` 时全部来源被放行，此时账号的发送能力等同于交由模型使用，因此配置阶段应显式填写白名单。
