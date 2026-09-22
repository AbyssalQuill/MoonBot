# MoonBot Pro

一个跑在 QQ 上的聊天机器人：**NapCat / OneBot v11** 负责接 QQ，**隔离的 DeepSeek Harness（DSH）实例**负责当大脑，中间的 **qq-bridge** 负责唤醒判定、提示词组装、工具调用与发送，一个 **Electron 管理端**负责装、配、拉起来、看着它。

当前版本 **1.3.0**，对外安装包为 `MoonBot Pro Setup.exe`（完整版）与 `MoonBot Pro Manager Setup.exe`（管理端精简版）。更新记录见 [CHANGELOG.md](CHANGELOG.md)。

<p>
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4">
  <img alt="electron" src="https://img.shields.io/badge/Electron-28-47848F">
  <img alt="node" src="https://img.shields.io/badge/Node-%E2%89%A5%2022.13-339933">
  <img alt="react" src="https://img.shields.io/badge/React-18-61DAFB">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
</p>

---

## 这套文档怎么读

这份 README 是**索引加能力实现细节**：能跑起来的最短路径 + 能力清单 + 各组能力的实现路径与闸门 + 往哪儿深挖。能力实现细节就在本文的「能力实现细节」一节（在「快速开始」与「它现在能做什么」之间）；更完整的推导、实测数据与逐条旁证在 `docs/` 下，四份文档各自成篇：

| 文档 | 回答什么问题 | 适合谁 |
| --- | --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 一共几层？一条 QQ 消息从进来到回复要走哪些代码？唤醒 / 在途注入 / 回合保持怎么协作？状态落在哪？线上部署在哪几个目录？ | 想读源码、想改行为、想知道"数据在哪"的人 |
| [docs/CAPABILITIES.md](docs/CAPABILITIES.md) | 机器人到底能干什么？每件事由哪个工具实现、代码在哪一行、生产上踩过什么坑？ | 想知道"能不能做 X"、想调工具的人 |
| [docs/COMPACTION-MATH.md](docs/COMPACTION-MATH.md) | 钱花在哪？上下文压缩阈值 0.16 是怎么算出来的？为什么永久会话比轮换便宜？ | 关心成本、想重新标定参数的人 |
| [docs/PIXIV-AND-QZONE.md](docs/PIXIV-AND-QZONE.md) | 发 pixiv 原图为什么这么绕？QQ 空间配图为什么不能落盘？ | 处理图片链路、排查"发出去的是缩略图"的人 |

其他：`CHANGELOG.md`（逐版本变更）、`docs/release-1.0.0.md`（1.0.0 发布说明）、`qq-bridge/docs/`（桥接层内部文档，含交接记录）。

---

## 核心机制与实测数字

这一节把四份深潜文档里**最该被记住的结论**前置出来，每条都带代码入口，便于复算或推翻。

### 1. 上下文：钱花在「重建」，不在「上下文大」

按线上 `state/token-usage.jsonl` 的 4,659 次主聊天请求分桶实测（11.2 天）：

| 上下文区间 | 请求占比 | 每次平均花费 | 其中大未命中(≥20k) |
| --- | --- | --- | --- |
| 0~30k | 5.8% | **¥0.0382** | **49.8%**（刚压缩/换会话完的重建） |
| 30~50k | 36.8% | ¥0.0105 | 10.6% |
| 50~70k | 22.2% | ¥0.0033 | 0.9% |
| 70~90k | 15.6% | ¥0.0043 | 1.2% |
| 90~120k | 13.2% | ¥0.0040 | 0.0% |
| 120~160k | 5.5% | ¥0.0051 | 0.4% |

50k 以上回归得 **每次 ≈ ¥0.0020 + 0.022 ¥/M × 上下文**（≈ 缓存命中价）——上下文本身几乎不花钱，
贵的是「压缩 / 换会话 / 长时间空闲之后要**整段重读**一次」（实测一次重建 ≈ ¥0.036，频率 ∝ 1/阈值）。

- **压缩阈值**：每天成本 = 步数×(固定+边际×平均上下文) + 每天重建次数×重建单价 → 最省在 **0.16**
  （稳健区间 0.14~0.20）。代码：`qq-bridge/src/core/config.js` 的 `dshCompaction.thresholdRatio`，
  由 `qq-bridge/src/lib/dsh-compaction.js` 写进 DSH 的 `cordis.patch.yml`。
- **换会话频率**：换一次要付一次整段重建（≈¥0.04~0.11），而每步只省 `0.022¥/M × ΔC ≈ ¥0.00066` →
  平衡点 ≈75 步 ≈ 18~25 个来回；**纯成本最优是永久会话**（`social.autoReset.permanent = true`，
  上下文交给 DSH 压缩——压缩会留摘要，不丢连贯）。
- **复算脚本**：`node qq-bridge/tools/compaction-threshold.mjs`（参数全部从线上用量现场量，改价后重跑）。
- 完整推导（缓存 TTL、闭环最优、峰谷倍率）：[docs/COMPACTION-MATH.md](docs/COMPACTION-MATH.md)。

### 2. 工具表：代理恒开，两处旋钮分工明确

隔离 DSH **不直连** napcat MCP，而是连开源 **mcp-compressor** 代理；代理只把 2 个包装工具
（`napcat_get_tool_schema` / `napcat_invoke_tool`）发给模型，把压过的清单塞进描述里。
实测相对完整工具表：**低档 38.8% · 中档 14.0% · 高档 6.2% · 极限档 3.6%**。

- **代理恒开**：`qq-bridge/src/lib/dsh-side.js` 默认就拉代理；没装压缩机自动回退直连，绝不把工具表搞没。
- **工具名单档位**（`social.slimTools.level`，定义在 `qq-bridge/src/lib/tool-tiers.js`）决定**后端注册哪些**：
  实测在用的能力一个都不丢，当前档位砍掉的具体工具名**逐个列在管理端那张卡上**（不用猜）。
- 代价：模型遇到本轮没用过的工具要先查 schema 再调用（一步变两步）；桥已按真实工具名解包，
  发送判定 / 幂等账本 / 回合收尾都不受影响。

### 3. 图片链路：两道闸门、一条规矩

- **pixiv**：候选按档位分桶（**缩略档永不发**）、用作品详情的宽高与实际像素**对账**、字节要过完整性闸门
  （JPEG 的 FFD9 / PNG 的 IEND / GIF 的 0x3B / RIFF 长度 + `content-length`）——任一不过就换下一个候选，
  **绝不发半幅灰图**。入口：`qq-bridge/src/lib/pixiv.js`、`qq-bridge/src/safe-fetch.js`。
- **QQ 空间配图**：**零落盘优先**（≤10MB 直接把 `base64://` 交给 NapCat），超限才写进 `napcat.tmpDir`
  并在 `try/finally` 里成败都删；NapCat 的 `send_qzone_msg` **只读 `images`**（旧代码传的 `file` 一直被静默忽略）。
  入口：`qq-bridge/src/lib/qzone-image.js`。
- 两条链路的共同教训与回归测试：[docs/PIXIV-AND-QZONE.md](docs/PIXIV-AND-QZONE.md)。

### 4. 收到图片时：唤醒与在途注入**都要附**

模型正忙着那一步时你发的图走的是「在途注入」；图片附件原来只挂在「唤醒」那条路上 —— 于是模型只看到
`[图片] [image]` 占位文本。现在两条路共用 `pickAttachableMedia`（挑选规则）+ `resolveMediaList`（取图闸门），
带图被拒会自动回退纯文本重投，且**水位只在图真投出去后才推进**（否则那张图两条路都不再附）。
见 `qq-bridge/src/core/social-state.js`、`qq-bridge/src/core/wake-send.js`，回归测试 `qq-bridge/tests/steer-media.test.js`。

### 5. 行为默认值（拟人）

| 项 | 缺省 | 在哪改 |
| --- | --- | --- |
| 打字节拍 | 150 ms/字（第 2 条气泡起按字数等），下限 250 / 上限 4000 ms；桥侧夹在 [60,320] / [800,6000] | 「发送节奏与间隔」 |
| 回复前停顿 | 上限 30s、静默 8s、新消息后至少静默 10s | 「等待：回复前的停顿」 |
| 私聊不抢话 | 看对方打字、最多等 12s、连发续窗 5s、插话概率 0.15 | 「私聊打字等待」 |
| 唤醒模式 | **默认活跃**；想潜水时给有限时长（不再有「无限期潜水」这个勾） | 「唤醒 · 潜水 / 活跃」 |
| 上下文压缩 | 阈值 0.16、逐字保留 2%、单个工具结果 8192 字符 | 「上下文治理」 |

管理端「上下文治理」卡里还有一个 **「恢复默认配置（拟人默认，全局）」** 按钮：一次把上面这些写回表单。

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

## 能力实现细节

本节按能力分组给出**实现细节**：能力定义（做什么、由模型在什么场景调用）、实现路径（`文件:函数`，行号为撰写时的近似位置，重构后会平移）、关键约束与闸门、以及生产上真实踩过的坑。工具注册点在 `qq-bridge/src/mcp-napcat-safe.js`（QQ 主体）、`qq-bridge/src/mcp-host-server.js`（宿主与学习）、`qq-bridge/src/mcp-web-search-safe.js`（联网）。本节只收录已对着仓库代码核对过的条目。

### 语音：TTS 与 ASR

- **能力定义**：模型需要"用说的"回答时调 `qq_send_voice` 把文本合成语音发出；收到对方的 `record` 段时调 `qq_transcribe_voice` 转写后再理解，绝不猜测语音内容。
- **实现路径**：`core/voice.js`（`synthesize()`、`voiceTurnHint()`、`allVoicePlan()`、`allVoiceEnabled()`）、`core/send-dice.js`（`dice('voice', …)`）。工具：`qq_send_voice`（`mcp-napcat-safe.js:2211`）、`qq_transcribe_voice`（`mcp-napcat-safe.js:2239`）。三种音色来源见下表（`core/voice.js:11-13`）。

| 模式 | 模型 | 要点 |
| --- | --- | --- |
| `tts` | `mimo-v2.5-tts` | `audio.voice` 传官方音色 id；内置名单是 `BUILTIN_VOICES`，仓库里 0 个音频文件 |
| `design` | `mimo-v2.5-tts-voicedesign` | 用文字描述造音色，**不能**传 `voice` |
| `clone` | `mimo-v2.5-tts-voiceclone` | `audio.voice` 必须是样本的 **DataURL**，裸 base64 会被 400 拒 |

- **关键约束**：没有本地模型，合成与识别都走小米 MiMo 的 OpenAI 兼容端点；鉴权同时发 `api-key` 与 `Authorization: Bearer`，要念的文本放 `assistant` 消息、风格描述放 `user`。额度 `maxChars` / `dailyChars`，缓存 `state/voice-cache/*.mp3`（上限 `maxCacheFiles`）。是否主动发语音由**桥侧掷骰**决定（`core/send-dice.js` 的 `dice('voice', …)`），概率与冷却读 `state/voice-config.json` 的 `send.probability` / `send.cooldownMs`，命中才往唤醒正文插 `[Voice] dice HIT`；概率 0 = 只在被明确要求时发。`send.allVoice=true` 时回复一律转语音，任一前置不成立即**自动退回文字并在日志留一行原因**。
- **生产上的坑**：**引用会被桥丢掉** —— QQ 把"回复 + 语音"渲染成只有引用框的空气泡，要引用请用 `qq_reply` 发文字；语音文件必须落在 NapCat 读得到的目录（`napcat.tmpDir` + `dockerPathMap` 换成容器内路径），读不回来时自动退 base64 重发；`send.allVoice` 缺失或非布尔一律按关闭处理（`qq-bridge/tests/all-voice-mode.test.js`）。

### 发送链与正文格式治理

- **能力定义**：模型的全部对外正文经统一出口发出：分气泡、引用回复、连发、以及"读了不回"时的标读收尾，都由这条链完成。
- **实现路径**：`core/send-chain.js`（`enqueueSend`）、`core/qq-send.js`（`onebotSend`，`qq-send.js:168`，**所有模型正文的唯一出口**）、`core/send-idempotency.js`（幂等闸门）、`lib/onebot-delivery.js`（分段与节奏）、`lib/send-gaps.js`（`computeGaps`）、`core/config.js`（`clampSendPace`，`config.js:410`）。工具：`qq_send_message`（`:1295`）、`qq_reply`（`:909`）、`qq_send_burst`（`:1253`）、`qq_mark_read`（`:1188`）。
- **关键约束**：节奏只有"按字数"一种 —— 批内首条秒回，第 2 条起 = 本条字数 × `linearPerCharMs`（默认 150），±`linearJitterRatio` 抖动，夹在 `[linearMinMs, linearCapMs]`；`linearEnabled=false` 即完全不延迟。**钳制**：`linearPerCharMs ∈ [60,320]`、`linearCapMs ∈ [800,6000]`、`linearMinMs` 不得高过 `linearCapMs`（`clampSendPace`）。发送侧还有 `maxSendPerMinute` / `maxSendPerHour` / `maxMessageChars` 上限，以及 `core/audit.js` 的敏感内容拦截。
- **格式治理**："不许显式换行""颜文字要有出处""代码类不分段"三条由**提示词**（preset 的 `[TOOLS] 2b~2e`）约束，桥侧**不做正则清洗**；桥真正拦的是"工具参数数组被当成正文"—— 切不出正文就 **400 硬失败、一条都不发**（`lib/text-safe.js` + 发送端点 + `onebotSend`）。
- **生产上的坑**：线上那份 `config.json` 的 `social.send` 被调成 `linearPerCharMs: 650` / `linearCapMs: 15000`，17 个字等 11 秒，同一窗口 118 次发送累计执行 990 秒 —— 主人感觉到的"唤醒后要响应一段时间"就是它。这些键**模型自己在私聊里就能改**，只改配置文件挡不住下一次自调，所以才加了钳制（`qq-bridge/tests/send-pace-clamp.test.js`）。

### 收发图片

- **能力定义**：入站图片要作为**真附件**进模型（而不是占位文本）；出站则由模型联网找图并发送。
- **实现路径（入站）**：两条路共用同一套 —— 挑选规则 `core/social-state.js` 的 `pickAttachableMedia`（`social-state.js:1153`），取图闸门 `core/media-pipe.js` 的 `resolveMediaList`（`media-pipe.js:218`，由 `bridge.js:478` 注入）。唤醒路在 `wake-send.js:1104`，在途注入路在 `steerIntoRunningTurn` 里；另有 `qq_get_message_images`（`mcp-napcat-safe.js:1688`）供模型主动取某一批消息的图。
- **实现路径（出站）**：`qq_image_search`（`mcp-napcat-safe.js:3112`，只查不发）与 `qq_send_image`（`mcp-napcat-safe.js:3132`，找图并真发），搜图实现在 `lib/image-search.js`（Bing / 百度，**只返回 URL，不下载不落盘**）。四个来源按 `file > messageId > imageUrl > query` 取值：`file` 是**本地已有的图**（含 DSH 附件对象路径），`messageId` 是**转发聊天里那张图**（按消息 id 取回原图重发，模型在唤醒正文里就能看到 `(id:…)`），`imageUrl` 是 `qq_image_search` 给的直链，`query` 才是联网现搜。三条来源最后都汇成同一件事 —— 字节先过 `verifyImageComplete` 完整性闸门，再写进 `napcat.tmpDir`（这个目录就是挂进 NapCat 容器的那份），然后把该目录里的路径交给 `/api/social/send-message`（公共落盘函数 `stageImageBytes`）。跨会话发图（私聊里把图转进群）与正文同构，靠 `crossSession: true` 过 `console-server` 的跨会话闸门；**读图那一侧**按 messageId 找图时会先找目的地会话、再遍历所有活跃会话（`findMessageMedia(..., {info:true})`）——因为跨会话时 `key` 是目的地，图却躺在发起会话的记忆窗口里。
- **关键约束**：`qq_send_image` 下载走 `safe-fetch.js` 的 `safeFetchBuffer`（SSRF 防护 + 体积上限 + "确实是图片"校验），**除 NapCat 临时目录外什么都不写盘**；一次一张，不刷屏；`qq_image_search` 只给候选，模型不得编造图片 URL。入站侧带图被拒时自动**回退纯文本重投**，且附图水位只在图片真投出去之后才推进。
- **落盘为什么必须换地方**：不直接把宿主原路径丢给 NapCat，是因为 DSH 附件目录 `/root/.dsh/attachments/v1/objects/…` 不在 `napcat.dockerPathMap` 的挂载里，容器化的 NapCat 读不到（实测表现：接口返回 `ok`、用户端什么都没收到）。所以三条来源一律先读字节、再落到 `napcat.tmpDir`，只把这个目录里的路径交出去。
- **引用穿透（同一天第三处）**：主人"引用着自己那张图 + 让我转进群"时，图在**被引用的那条**消息里。两处一起兜：① 入站消息记下被引用消息的 id（`appendSocialMessage(..., quoteTargetId)` → `msg.quoteTarget`），`findMessageMedia` 本身没图时沿这个 id 往下找一层，结果如实报 `viaQuote`/`quoteMessageId`；② 引用内容里含 `[图片]`/`[表情]`/`[视频]` 时，唤醒正文渲染成 `[引用 某某#<id>：[图片]]`，模型可以直接拿这个 id 去转发（普通纯文字引用的格式一字不变）。
- **转发给的是原图（2026-09-22 主人要求「默认转发原图，别压缩」）**：取图这条腿分两个档位，由 `/api/images/message` 的 `raw` 参数选 —— 默认档**给模型看**（`resolveOneMedia` → `gateImage` → `image-compress.js`：长边缩到 `IMAGE_MAX_SIDE` 1280px、40KB 以上重编码，因为 DSH 附件层有单边上限、而且图直接吃 token），`raw=1` 档**转发用**（`resolveOneMedia(media, {raw:true})` → `fetchOneBotImage(media, {raw:true})`：只做安全校验——字节上限、像素上限、魔术字——**一个字节都不重编码**）。`qq_send_image` 的 `messageId` 来源固定走 `raw=1`，回执里有 `original: true` 与 `sha256`，可以拿它跟原图逐字节对齐。实测（服务器上 2400×1600 的真实 JPEG，`docs` 之外无第三方依赖）：默认档 216,572 B（重编码过），raw 档 **441,776 B 且与磁盘原图 hash 完全一致**。
- **生产上的坑（连发消息时"交了但没人读"，2026-09-22 私聊卡 4 分半的根因）**：批次"塞进 next-step"**不等于**模型读到了 —— 模型读到它要等**下一步跑起来**，而下一步跑起来要等 `agent/turn-stopping` 钩子**返回**。现场：主人连发两条，第一条 11:21:57 由 `wake-send` 的即时 steer 塞进 next-step，第二条 11:24:17 也塞了进去；可保持循环当时正卡在"对方还在打字"的退避里，它自己那几次 steer 全被 `typing-defer` 挡住，55s 预算到期时它看 `collectMidTurnBatch` 已经空了（被别的路径投掉了），于是照旧回 `{close:false, again:true}` 继续持有 —— 钩子不返回、DSH 走不到"next-step 非空 → 跑下一步"，那两条就静静躺在会话里，直到 30 分钟空闲放行（实测卡 4 分 28 秒；重启桥、钩子请求断掉的那一刻，模型立刻把两条都答了）。现在补了 `core/inbox-marks.js`：`noteStepEnd`（每个 `step/end`，在 `flushStepBatch` 里记）、`noteInboxDelivery`（真塞进 next-step 之后，wake-send 的 steer 成功与步边界发车各记一笔）、`clearInboxMarks`（`turn/end` 清账），判据用**步结束计数**而不是时间戳（`flushStepBatch` 就是在 step/end 那一刻发车，两者常常同一毫秒）；保持循环每次循环都先问一句"**手头没有待交批次**、而这批交了却没跑过新的模型步？"→ 是就**立刻返回放行**（不带 `again:true`），让插件返回、DSH 去跑下一步（手头还有消息时必须照常 steer，所以这条判据不能单独成立）。回归测试 `qq-bridge/tests/inbox-hold-release.test.js`（18 项，含"判据必须排在预算到期分支之前""必须有 `!collectMidTurnBatch(st).length` 这个前提"两条顺序断言）。
- **生产上的坑（三个同一天踩到，表现都是"图就是发不出去"）**：① 工具注册的 `inputSchema` 里**没声明的参数会被 zod 入参校验剥掉**——`qq_send_image` 原先既没有 `file` 也没有 `crossSession`，模型按提示补上 `crossSession: true` 后参数在入参校验处就被丢了，闸门于是每次都回"把参数 crossSession 设为 true 再发一次"，提示成了死循环；补声明后同样要记得**往请求 body 里塞**（file 分支与 imageUrl 分支是两份 body）。② **只按 `key` 找图**：跨会话时 `key` 是目的地、图在发起会话里，于是"转发到本会话成功、转到群里说没图"，模型只能退回联网搜一张差不多的（主人看到的就是"我要代码图，群里来了张鲸鱼图"）。③ 工具 schema 是**代理进程启动时**取的快照（`mcp-compressor` 包装 `napcat_get_tool_schema`），改完 `mcp-napcat-safe.js` 必须让代理链重建，否则模型看到的还是旧参数表。回归验证：`node --check` + 内层/代理两层各拉一次 `tools/list` 比字段 + 真实链路 `napcat_invoke_tool` 各打一发。
- **生产上的坑**：图片附件原来只挂在"唤醒"那条路上，而"忙时把消息塞进在跑的回合"（主路径）直接调 `sessions.prompt`、正文里只有一个文本块 —— 于是模型只看到 `[图片] [image]` 占位文本，会话日志里 `mediaType` 出现 0 次。现在两条路共用 `pickAttachableMedia` + `resolveMediaList`（回归测试 `qq-bridge/tests/steer-media.test.js`）。

### Pixiv 搜图与发图

- **能力定义**：`qq_pixiv_search` 只查不发（返回候选与筛选明细），`qq_send_pixiv` 找图并真发。模型在"来张 XX 的图 / 发个 pixiv 原图"这类场景调用。
- **实现路径**：`lib/pixiv.js`（`pixivImageTier:207`、`planPixivSend:232`、`normalizePixivFilters:351`、`filterPixivItems:479`、`pixivImageSources`）、`safe-fetch.js` 的 `verifyImageComplete`（`safe-fetch.js:286`）。工具：`mcp-napcat-safe.js:3215` / `:3250`。
- **关键约束**：三道闸门 —— **档位分桶**（缩略档永不发，降级必须显式并写进结果 `tierFallback`）、**像素对账**（用作品详情的宽高与实际像素比对）、**字节完整性**（JPEG 的 FFD9 / PNG 的 IEND / GIF 的 0x3B / RIFF 长度 + `content-length`），任一不过就换下一个候选。`qq_send_pixiv` **永远排除 R-18/R-18G**（刻意不给 `r18` 参数）；筛选条件全部在本地对已抓回的数据做（镜像站只认 `keyword` 与 `page`），排序只支持投稿时间。
- **生产上的坑**：`looksLikeImageBuffer` 只认开头 3 个字节，上半张正常、下半幅灰的图会全链路通过 —— 这是"半幅灰图"的根因；镜像站单张 2.7~5.7 秒、出现过 25 秒超时，所以它只垫底；cookie 与 Bearer **只发给 pixiv 自己的域名**（`pixivRequestHeaders`），镜像站永远看不到凭证。

### QQ 空间

- **能力定义**：看空间动态、评论、楼中楼回复、点赞、发说说（可带一张配图）。
- **实现路径**：工具 `qq_qzone_view`（`mcp-napcat-safe.js:2500`）、`qq_qzone_comment`（`:2542`）、`qq_qzone_reply_comment`（`:2581`）、`qq_qzone_like`（`:2626`）、`qq_send_qzone`（`:2666`）；业务在 `core/qzone.js`，配图在 `lib/qzone-image.js`。
- **关键约束**：配图**零落盘优先** —— 字节 ≤ `DEFAULT_BASE64_MAX_BYTES`（10MB，`lib/napcat-file.js:27`）时直接把 `base64://` 交给 NapCat，超限才写进 `napcat.tmpDir` 并在 `try/finally` 里成败都删（`qzone-image.js:101-131`）。空间是公开可见的，所以配图一律排除 R-18，与 `qq_send_pixiv` 同一规矩；`qq_send_qzone` / `qq_qzone_like` 受总开关 `QZONE_TOOL_DISABLED` 管。
- **生产上的坑**：旧代码传给 `send_qzone_msg` 的参数名是 `file`，而 NapCat **只读 `images`** —— 那个参数一直被静默忽略（配了图也发不出来、还不报错）；点赞已改走 QZone 现役接口 `internal_dolike_app`（老的 `emotion_cgi_do_like_v6` 已 HTTP 500）；成功后 `tid` 在 `data.tid`，旧写法只读 `data.data.tid`（多套一层）导致 `tid` 恒为 null。

### 撤回与历史

- **能力定义**：模型说错话或发错对象时撤回自己刚发的消息；看不懂被引用的内容时展开转发消息、读群文件；需要旧信息时检索历史记录。
- **实现路径**：`qq_withdraw_message`（`mcp-napcat-safe.js:1170`）、`qq_get_message_detail`（`:1488`）、`qq_get_my_recent_messages`（`:1470`）、`qq_get_forward_msg`（`:1923`，合并转发展开）、`qq_get_file_content`（`:1506`）、`qq_get_group_history`（`:862`）。检索在 `core/memory.js` 的 FTS5（`memory.js:172`），工具 `qq_memory_search`（`:2788`）。
- **关键约束**：**只能撤自己发的**，`messageId` 来自唤醒正文的 `(id:xxx)` 或 `qq_get_my_recent_messages`；撤回事件由桥落库并标 `[已撤回]` + 写 `chat_messages.recalled_at`（`bridge.js:589-614`）。
- **生产上的坑**：旧检索是 `content LIKE '%词%'` 全表扫，查不着时模型会说"我看不到更早的消息" —— 最贵的一种失败；现在是 FTS5 **trigram** 外部内容表 + 触发器同步 + BM25 排序，结构一变就把 `FTS_SCHEMA_VERSION` +1（`memory.js:120`、当前 `'2'`）自动重建。另有一个三角限制：trigram 要求每个 token 至少 3 个字符，**不足 3 字的关键词会被 FTS5 直接拒绝**（`memory.js:243`）。

### 在途注入与回合保持

- **能力定义**：模型正在跑某一步时到达的消息**不另起一轮**，直接 steer 进当前回合；回合保持（turn-hold）把首次唤醒开起来的回合继续吊住，让后续消息都落在同一个回合里。
- **实现路径**：`core/wake-send.js` 的 `steerIntoRunningTurn`（`wake-send.js:800`）、`core/turn-hold.js`（`holdLoop:131`、`flushStepBatch`）、插件 `qq-bridge/plugins/dsh-qq-hold/`（`agent/turn-stopping` 钩子，路由 `core/console-server.js:1667`）；另一个发车点是 `core/mux.js` 收到 `step/end` 时调的 `flushStepBatch`。
- **关键约束**：单个 HTTP 请求只持有 `requestBudgetMs`（默认 55 秒，夹在 `[3000, 120000]`，`turn-hold.js:137`），这一段没等来消息就返回 `{ close: false, again: true }`，插件收到后**立刻再发一次**（`again` 分片协议），于是对 DSH 而言钩子一直在等、对 HTTP 而言每个请求都很短。其余旋钮：`maxExchanges` 24、`idleCloseMs` 30 分钟、`maxWaitMs` 60 分钟、轮询 200ms、看门狗续期 5 秒。硬不变量：默认关闭（`social.turnHold.enabled !== true` 立即放行）、同一会话单飞（`activeHolds`）、**绝不在这里标读**、轮换到阈值即放行关回合。
- **合并注入**：同一个模型步内只产生**一个** `[Mid-turn]` 块（`STEER_COLLECT_MS` 收集窗 + `STEER_CYCLE_MS = 5000` 周期闸），送达时刻与"一到就注入"相同，但模型只看到一个块、只发一条气泡。
- **生产上的坑**：**一个 boolean 承担不了三种语义** —— `true` 既表示"真投进去了"，也表示"本回合已经给过它"，还表示"被周期闸攒住（其实什么都没投）"；`'typing-defer'` 表示对方在打字、继续攒；`false` 才是真失败。曾把"已经给过"返回 `false`，调用方读成没送成 → 又投一条完整唤醒进同一个回合 → 模型看到同一批未读两遍 → **QQ 上真的重复回了一次**。另外"被周期闸攒住"这个 `true` 必须验证真的落地（判据是 `collectMidTurnBatch(st)` 返回空），没落地就继续持有加重试，**绝不谎报成功**。

### 表情包两套体系

- **能力定义**：两套东西不要混 —— ① QQ 账号自己的**收藏表情**（官方接口）；② 随包分发的**内置表情包 meme-packs**（一份包 = 一个目录，`manifest.json` + `index.db` + `memes/<tag>/<文件名>`）。
- **实现路径**：收藏侧 `qq_list_stickers`（`:1730`）、`qq_get_sticker_image`（`:1756`）、`qq_send_sticker`（`:1784`）、`qq_collect_sticker`（`:1811`）、`qq_sticker_note`（`:1866`）、`qq_set_sticker_remark`（`:1897`），实现在 `core/sticker.js`；内置侧 `qq_meme_search`（`:2047`）、`qq_send_meme`（`:2097`）；QQ 原生表情 `qq_face_list`（`:2736`）、`qq_send_qq_face`（`:2756`）。
- **关键约束**：**一条消息就是一张贴纸或表情，不能同气泡带文字** —— 先发文字再发表情；`qq_set_sticker_remark` 默认关（`social.tools.setStickerRemark=false`），一般用 `qq_sticker_note` 就够。包目录三处：`<runtime>/meme/<packId>`（出厂）、`<runtime>/meme-packs/<packId>`（后装/上传）、`<角色库根>/<角色slug>/meme-packs/<packId>`（**角色专属**，跟着当前角色走，`mcp-napcat-safe.js:216-228`）；找不到包时 `qq_meme_search` / `qq_send_meme` **直接不注册**（`:251` 会打印尝试过的全部路径）。
- **发布节奏**：发不发由桥掷骰（`core/send-dice.js` 的 `memeTurnHint`），概率 `social.sticker.sendProbability`（默认 0.3）、冷却 `sendCooldownMs`（默认 3 分钟），命中才插 `[Meme] dice HIT`；0 = 不主动发，只有被明确要求才发。
- **生产上的坑**：NapCat 不暴露 `add_custom_face` 时收藏会**降级为本地图库**（`core/sticker.js:546-549`）；工具返回"这个 NapCat 版本不支持自动收藏"时就要停手、告诉对方暂时不行、**绝不重试**。GIF 不许当本地路径发（QQ 只显示闪烁的静态预览），必须走 `qq_send_meme`。

### 联网搜索与解析

- **能力定义**：`web_search` 联网搜索、`web_fetch` 抓网页正文；`qq_video_parse` 解析一个视频链接（只读）、`qq_video_search` 按关键词搜视频；位置信息走 `qq_send_rich` 的 `location` 卡片。
- **实现路径**：`mcp-web-search-safe.js`（`web_search:944`、`web_fetch:980`，SSRF 防护走 `safe-fetch.js` 的 `validateFetchUrl` / `safeFetchBuffer`）；`qq_video_parse`（`mcp-napcat-safe.js:3064`）、`qq_video_search`（`:3083`）、`core/video.js`；位置卡在 `core/console-server.js:3302-3403`。
- **关键约束**：视频解析拿不到元数据时会返回 `degraded:true` —— 就老实说看不到，别编。位置卡三种形态（`social.send.locationMode`）：`tuwen`（默认，高德图文卡）、`map`（静态地图图 + 地点文字 + 地图链接）、`native`（QQ 原生位置气泡）；配了高德 key 时用官方静态图，没配用实测可用的一张。
- **生产上的坑**：原生 `location` 段用 `get_friend_msg_history` 回读时**段列表是空的**（`console-server.js:3306-3317` 的线上取证），所以默认不发它；真机那张腾讯地图卡是微信小程序卡、构造不出来，做的是"看起来就是腾讯地图那张卡"的图文卡（`appid=100571486` 是高德在 QQ 里的应用号，`social.send.locationApp='amap'` 可切回高德身份）。

### 记忆与画像

- **能力定义**：长期记忆的写入与检索、群友结构化档案、黑话库、人格与画像学习，共同支撑"记得住"。
- **实现路径**：`core/memory.js`（分层 `MEMORY_TIERS:117`、FTS5 `:172`）、`core/persona-learn.js`、`core/portrait-learn.js`、`core/slang.js`、`core/persona-text.js`、`core/learning-token.js`。工具：`qq_memory_remember`（`:2826`）、`qq_memory_search`（`:2788`）、会话级记忆 `qq_memory_query` / `_append` / `_remove` / `_clear`（`:1578`/`:1548`/`:1598`/`:1622`）、档案 `qq_profile_get` / `qq_profile_set`（`:2262`/`:2280`）、学习 `qq_persona_learn_start` / `_stop` / `_status`（`:3578`/`:3598`/`:3616`）。
- **关键约束**：三层记忆 `permanent`（0 = 永不过期，`pinned=1` 或 `category ∈ {rule, owner, identity}`）/ `durable`（90 天不活跃淡出，默认层）/ `working`（7 天淡出）；检索是 FTS5 `tokenize='trigram'` 外部内容表 + BM25。学习会话只加载 host 组 MCP，提交工具全名固定为 `mcp__napcat-host__qq_learning_submit` / `mcp__napcat-host__qq_learning_corpus`，写成 `mcp__napcat__` 那组会直接 unknown tool。
- **`[Recall]` 注入位置是有讲究的**：永久层与高重要度记忆的短摘要走**唤醒正文**（`wake-send.js:451`，`limit: 14, maxChars: 700`），**不放进系统提示词** —— 系统提示词一变整段前缀缓存失效（那一步全价重读几万 token），摘要放在"每轮本来就新"的位置只花它自己那几百字符。
- **学习触发方式四类**：立即 / 间隔 / 每日定时 / 文本指令；画像学习复用人格学习这套触发方式（`core/portrait-learn.js:1-3`），只是目标来源不同（前者手填 `persona.targetQQ`，后者从聊天记录里自动筛活跃群成员）。
- **生产上的坑**：人格档案曾被一轮"只交了 nickname"的学习覆盖成两个词（旧的长文被整条覆盖），现在新文本明显更短且旧文够长时**保留旧文**（`mergePersonaProfileText`，`persona-learn.js:492`）；已确认的黑话词条不再常驻上下文，模型需要时自己查。

### 卡片与富媒体

- **能力定义**：音乐点歌卡、视频卡（原生小程序 Ark 优先）、联系人卡、位置卡、骰子/猜拳、合并转发、Word 文档。
- **实现路径**：`qq_send_rich`（`:2980`）与 `core/media.js`（`createMediaDomain`）、`qq_music_search`（`:3039`）、`qq_send_forward`（`:2947`）、`qq_send_docx`（`:2917`）与 `core/docx.js`；签名服务是独立进程 `qq-bridge/music-sign-proxy.py`。
- **封面三条硬规矩**：① 封面**只做 URL 归一化**（`normalizeCoverUrl()`：http 升 https、限定尺寸、补 `type=jpg`），**绝不过第三方图片代理**（`media.js:337-387`）；② 版式分两种 —— `share`（默认）照抄真机分享的图文卡，手机端会画封面，`music` 是旧的 `music.lua` 版式（手机端不画封面，还会被"将要访问"中转页拦一层，用 `social.send.musicCardStyle='music'` 可回退）；③ 视频卡**优先要原生 Ark**（B 站/微博走 NapCat 的 `com.tencent.miniapp_01`，`console-server.js:3273`），只有失败才回落"封面图 + 分享文本"。
- **关键约束**：**绝不手写卡片字段** —— 模型只传 `type=music` + `musicType` + `musicId`，桥自己解析标题/歌手/封面/音频，失败自动回落成官方歌曲链接并在结果里写 `music.card=link`。`qq_send_docx` 有每日额度（`state/docx-quota.json`，`core/docx.js:27`）；NapCat 在容器里时宿主路径读不到，这正是 `lib/napcat-file.js` 存在的原因。超单条上限（`social.send.maxMessageChars`）时用 `qq_send_forward` 或 `qq_send_docx`，**不是**拆气泡。
- **生产上的坑**：手写封面正是"手机端白卡"的元凶；封面加过一版 wsrv 代理，而代理会让签名服务把图转存成手机不渲染的 `qq.ugcimg.cn` 链接 —— 那一版已回退；网易云的封面 URL 写着 `.jpg`、`content-type` 也报 `image/jpg`，**字节却是 PNG**（magic `89504e`），光看扩展名分不出来，只能按首字节判；`y.gtimg.cn` 在本机客户端上时好时坏，统一改写成 `y.qq.com`。

### 权限与安全

- **能力定义**：决定"谁能跟机器人说话"（白名单/黑名单）与"谁能指挥它改配置"（主人/管理员），以及跨会话发送的授权。
- **实现路径**：`core/config.js:77-90`（`allow` / `deny` / `allowAllWhenEmpty` / `allowAllPrivate` / `allowAllGroups`）、`lib/config.js` 的 `isAllowed`、`core/console-server.js` 的 `crossSessionRefusal`（`:550`）。工具：`qq_whitelist`（`:2344`）、`qq_blacklist`（`:2306`）、`qq_admin_set`（`:2325`）、`qq_remove_friend`（`:2363`）、`qq_set_system_config`（`:1152`）。
- **关键约束**：白名单两边都空且 `allowAllWhenEmpty=true` 时放行所有，**启动会打警告**；`allowAllPrivate` / `allowAllGroups` 是分侧放行（"群严、私聊松"），这两个键恒为布尔（界面按"配置里存在的键"渲染）。`qq_whitelist` / `qq_admin_set` / `qq_set_system_config` 仅管理员私聊可用；**黑名单与删好友都不能作用于管理员**，主人不可删；发到非当前会话必须显式带 `crossSession=true`，否则拒绝。
- **缺 key 直接拒绝**：工具层**永不猜会话** —— 缺 `key` 时报错并指回唤醒正文的 `[Session] group:<群号>` / `[Session] private:<QQ>` 那一行（`mcp-napcat-safe.js:566-575`）。因为旧实现会去猜"当前在途会话"（多会话在途时挑最近活跃的那个），**结果把图片发到过别的群**。发送类工具还额外走 `/api/social/check-send`，跨会话闸门装在那里才关得上。
- **敏感内容兜底**：agent 回复命中本机路径/凭据特征（`qq-bridge/src/sensitive.js` 的 `SENSITIVE_RE`）时，`core/audit.js` 的 `handleSensitiveIntercept` **硬性拦截不发送**，宁可误拦不可泄露；`lib/text-safe.js` 提供 `redactSensitiveText` 供日志写入前脱敏。

### 唤醒与调度

- **能力定义**：一条群聊/私聊消息要不要唤醒模型、以什么理由唤醒；以及定时消息、主动搭话与活跃时段。
- **实现路径**：`core/wake-send.js` 的 `evaluateWakeTrigger`（`wake-send.js:179`）与 `buildWakePrompt`；调度统一入口 `core/social-state.js` 的 `scheduleWake`；定时 `core/scheduler.js` + `qq_schedule_message`（`:1040`）/ `qq_schedule_list`（`:1067`）/ `qq_schedule_cancel`（`:1081`）；主动 `qq_proactive_send`（`:2020`）；活跃时段 `core/activity.js`（`startActivityTick:100`）+ `qq_get_activity_hours`（`:1106`）/ `qq_set_activity_hours`（`:1120`）。
- **判定顺序即设计**：私聊 → 睡眠窗口（群聊窗口内只放行 @ 或引用）→ **@/引用优先于 `anyMessage`** → `anyMessage` → 点名 → 关键词（不超过 4 位的纯英文/数字关键词用词边界匹配，避免 `ADS`/`BDSM` 误触发）→ 提问（`isDirectedAtAi`）→ AI/技术话题（`TOPIC_WAKE_RE`）→ 指定发言人 → 概率。
- **关键约束**：默认 `social.wake.defaultMode = 'active'`（**默认活跃**，每条消息都唤醒，`core/config.js:166-169`）；不再默认"无限期潜水"，想潜水时给一个有限时长（`recommendedSleepMinMs` / `recommendedSleepMaxMs`，默认 5~120 分钟），到点自然醒；沉睡前有强制观察窗口（`preSleepWaitMs` 默认 30 秒）。限流：`maxWakePerMinute` 1、`maxWakePerHour` 12；连续 `noActionLimit`（默认 3）次唤醒既没发消息也没 `mark_read` / `set_wake_config` 就软重置唤醒配置。
- **生产上的坑**：`anyMessage` 分支曾排在 @ 前面，于是"@"被标成 `anyMessage`，而免打扰时段只放行"真实触发"→ 群里 @ 它却毫无反应（2026-09-19 修复，`wake-send.js:188-193`）。另外 `qq_wait_for_messages` 挂着时消息是作为**工具结果**回到模型手里的、根本不走投递路径，所以它配了 11 分钟的长等待超时，而不是默认的 180 秒静默判卡死。

### 跨会话投递

- **能力定义**：一个会话里的模型给**另一个会话**留言，或读取别的会话留给它的留言。
- **实现路径**：`qq_crosschat_send`（`mcp-napcat-safe.js:1376`）、`qq_crosschat_inbox`（`:1398`），落库 `state/crosschat.json`，实现在 `core/crosschat.js`。
- **关键约束**：工具必须显式带 `crossSession: true` 才允许发到非当前会话（`core/console-server.js` 的 `crossSessionRefusal`，`:550`）；"受信任的跨会话代发"名单 = 主人 `ownerQQ` 加上 `social.trustedCrossSessionUids`（`console-server.js:503`、`mux.js:314` 的 `isTrusted` 判定），名单外的来源不享受代发语义。
- **闸门性质**：它属于"调用期"约束（拒绝调用，但不减少请求体积），与 `social.slimTools.*` 的**注册期**裁剪是两套机制，排查时别混。

### 角色库与 persona 合成

- **能力定义**：角色包（一个子目录 = 一个包）的只读检索；以及 `persona.md` + `speech-rules.md` 如何与 agent preset 合成后进入系统提示词。
- **实现路径**：工具 `qq_character_list`（`:4405`）、`qq_character_read`（`:4421`）、`qq_character_pack`（`:4438`）、`qq_character_search`（`:4454`）；合成 `lib/preset-compose.js`（`composePresetText`、`readOverrideFiles`、`overrideStampOf`、`syncPresetOverrides`、`watchOverrideFiles`），装配在 `bridge.js:274-309`；是否需要补注入的判据在 `wake-send.js` 的 `shouldInjectPersonaBlock`（`:303`）。
- **关键约束**：四个角色工具都是**只读**的，不改动人设文件；**只有导入 `persona.md` 的那一张卡会自动进提示词**，其余角色包不会。字节上限：`qq_character_read` 默认 32KB（硬上限 131,072）、`qq_character_pack` 默认 24KB（可放宽到 128KB），截断会如实说明砍了哪个文件的哪部分。文件上限：`persona.md` 16000 字符、`speech-rules.md` 12000 字符。
- **生产上的坑**：旧实现超限只保头、整段丢尾 —— "**往文件末尾追加规则 = 大概率白写**"（线上 `speech-rules.md` 已到 6683 字符，从第 30 条后半句起一个字都没进模型）。现在改成**保头 + 保尾**（尾部 2500 字符必留），并把"砍掉了第几到第几个字符"写进日志（`wake-send.js:260-271`）。另外 `agentPreset` 只在**建会话时**绑定，改 preset 后老会话仍用旧提示词，要等轮换或归档重建。

### 管理端与部署

- **能力定义**：管理端是**编排者**（拉起进程、写配置、看日志、SSH 部署），不在 QQ 数据链上；桥侧则负责配置热加载与隔离 DSH 的装配。
- **实现路径**：`server/index.js`（HTTP API、实例编排与探活、前端静态托管；`RUNTIME_ROOT` 见 `server/index.js:25-31`）、`server/deploy.js`（一键克隆与 `buildDeployKeepScript()`，`deploy.js:350`）、`server/napcat-guardian.mjs`（关窗守卫，独立进程）；桥侧 `core/config.js` 的 `watchConfigFile` + `applyConfigInPlace`、`lib/dsh-side.js`（`installToIsolatedDsh:590`、`patchProfileCordis`、`mcpBlock`）、`lib/dsh-compaction.js`、`lib/tool-tiers.js`、`lib/tool-schema-compress.js`。
- **配置热加载**：`applyConfigInPlace` 是**原地合并**（不换对象引用，十几个模块持有的旧引用继续有效）；监听用**目录监听 + 2 秒轮询**双保险。生效期不同：`social.slimTools.*` 在**注册期**生效（改完要重启隔离 DSH），`social.tools.*` 只在**调用期**拒绝（不减少请求体积，不必重启）。
- **隔离 DSH 装配**：桥启动时幂等地刷新 preset、装配三个内置插件、把三组 MCP server 写进 profile 的 `cordis.patch.yml`，**默认绝不碰桌面端那份 DSH**。MCP 压缩代理（`social.toolCompressor`，默认 `enabled !== false` 恒开）只挂 `mcp-napcat` 这一路，把工具压成 `<server>_invoke_tool` / `<server>_get_tool_schema` 两个包装工具；探不到压缩机就**回落直连并把原因写进日志 —— 绝不把工具表搞没**。桥侧由 `core/mux.js` 的 `unwrapCompressedToolName` 把包装名还原成真实工具名。
- **部署保能力**：解包前把目标机原有的 `config.json` / `persona.md` / `state/` 存到 `/root/qqbridge-keep-<TS>/`，解包后逐键合并再恢复核对；旧行为把它们备份到 `/root/qqbridge-prev-<TS>/` 就删库重解包，**从来没放回去**过。
- **生产上的坑**：只监听文件会在管理端"临时文件 → 备份 → mv"原子替换后盯住已被 unlink 的旧 inode，此后**任何改动都不再触发**（线上实测 07:39:54 覆盖之后，桥日志里一条"已热加载"都没有）；桥自己还有 10 处会把内存里的旧 cfg 写回 `config.json`，没做热加载时管理端的改动不但不生效，还会被**回滚**掉。

### 成本与计量

- **能力定义**：每次请求记账、用量对账、QQ 里打 `/token` 直接看用量与花费。
- **实现路径**：`core/token-meter.js`（`meterTokenFrame:514`、`startTokenReconcile:990`）、`core/token-report.js`（`/token`）、`core/context-savings.js`（`initContextSavings:198`）、管理端 `src/pages/Learning.tsx`。
- **关键约束**：真实 `usage` 帧优先，没有就按帧内文本估算（估算行打 `est: true`）；对账把 DSH 自己 projcache 里的权威累计差额补成 `reconciled: true` 的行，找不到 DSH home 时静默跳过。计价参数在 `tokenCost`（`core/config.js:108-115`，单位 ¥/百万 token，`peakHours` 为北京时间高峰小时）；改它会同时改变 `/token` 的口径，管理端面板仍读自己的 `localStorage`。
- **两个日界口径别混**（`core/token-report.js:99-113`）：**计费日** = 北京 08:00 换日（提供方控制台口径，面板顶部"今日已用"）；**北京自然日** = 00:00 起（分时桶，面板"实测计量"里的"今日 token 合计"）。线上实测同一天两者分别是 592,685 与 12,182,789。现在**逐行标注口径**，`/token N` 按 `dates`（计费日逐日）求和。
- **压缩阈值数学**（阈值 0.16 怎么算出来的、为什么永久会话比轮换便宜）见 [docs/COMPACTION-MATH.md](docs/COMPACTION-MATH.md)，本节不复述；复算脚本 `node qq-bridge/tools/compaction-threshold.mjs`。
- **生产上的坑**：旧版 `/token` 把两个口径**挨着印**（第一行取计费日，第二行的分量与金额却来自自然日），读起来像算错了；`/token 7` 还曾把"只算今天"的 `billedTotal` 印成"近 7 天"—— 现在按计费日逐日合计。

---

## 它现在能做什么

按能力分组的能力清单。**实现工具、代码位置、关键闸门与踩过的坑见上文「能力实现细节」**；更细的旁证（含未逐行核实的条目标注）在 [docs/CAPABILITIES.md](docs/CAPABILITIES.md)。

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
