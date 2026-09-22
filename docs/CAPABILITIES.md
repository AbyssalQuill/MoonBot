# 能力清单

本文按能力分组列出机器人**能做什么**，每一条给出：实现它的工具、代码在哪、以及**生产上真踩过的坑**。

行号引用写作时的仓库状态，重构后会平移；**文件路径与函数名是稳定锚点**。带"未逐行核实"标记的条目只核到了入口（工具描述 / 端点），没有通读实现。

---

## 0. 总表

| 分组 | 工具数 | 归属文件 | 深挖 |
| --- | --- | --- | --- |
| 会话读取与协议 | 8 | `mcp-napcat-safe.js` | §1 |
| 发送与收尾 | 12 | `mcp-napcat-safe.js` | §2 |
| 富文本卡片与文档 | 6 | `mcp-napcat-safe.js`、`core/media.js`、`core/docx.js` | §3 |
| 表情包与贴纸 | 11 | `mcp-napcat-safe.js`、`core/sticker.js` | §4 |
| 图片：联网 / Pixiv / 空间 | 6 | `mcp-napcat-safe.js`、`lib/image-search.js`、`lib/pixiv.js`、`lib/qzone-image.js` | §5、[PIXIV-AND-QZONE.md](PIXIV-AND-QZONE.md) |
| 语音 TTS / ASR | 2 | `mcp-napcat-safe.js`、`core/voice.js` | §6 |
| 记忆与画像 | 11 | `mcp-napcat-safe.js`、`core/memory.js` | §7 |
| 学习（黑话 / 人格 / 画像） | 8 | `slang-learner.js`、`core/slang.js`、`core/persona-learn.js`、`core/portrait-learn.js` | §8 |
| QQ 空间 | 5 | `mcp-napcat-safe.js`、`core/qzone.js` | §9 |
| 群 / 好友 / 权限 | 8 | `mcp-napcat-safe.js` | §10 |
| 角色库 | 4 | `mcp-napcat-safe.js` | §11 |
| 定时、跨会话、静默 | 7 | `core/scheduler.js`、`core/crosschat.js` | §12 |
| 自检与宿主 | 5 | `mcp-host-server.js` | §13 |
| 联网搜索 | 2 | `mcp-web-search-safe.js` | §14 |

> 数字来自源码计数（`registerTool(` / `server.tool(`），部分工具受 `cfg.social.tools.*` 开关包裹，运行时可能不注册。现有 README 写的"96 个工具 / napcat 组 89 个"与源码计数（90）不符，以代码与 `state/tool-schema-stats.json`（`available: 90`）为准。

---

## 1. 会话读取与协议

| 工具 | 做什么 | 代码位置 | 生产上的坑 |
| --- | --- | --- | --- |
| `qq_get_prompt` | 读整段唤醒协议、会话状态、角色卡、贴纸清单 | `mcp-napcat-safe.js:965` | 返回动辄好几 KB。`dshCompaction.toolResultMaxChars` 曾经是 1500，把它剪成"开头 900 + 标记 + 结尾 300"，模型只看到零头，越用越像"不知道工具怎么叫、不知道规矩"。已抬到 8192（`core/config.js:60-65`） |
| `qq_get_unread_messages` | 取未读 | `mcp-napcat-safe.js:979` | 唤醒正文没带未读时的兜底 |
| `qq_get_recent_messages` | 取最近消息 | `mcp-napcat-safe.js:993` | 引用/回复要用的 `messageId` / `seq` 从这里拿 |
| `qq_social_state` | 看自己 / 对方的状态 | `mcp-napcat-safe.js:1012` | |
| `qq_global_overview` | 全局总览 | `mcp-napcat-safe.js:1026` | |
| `qq_get_message_detail` | 单条消息详情（含 `userId`） | `mcp-napcat-safe.js:1488` | 撤回、拍一拍、收藏表情都要先拿它的 id |
| `qq_get_my_recent_messages` | 自己发过什么 | `mcp-napcat-safe.js:1470` | `qq_withdraw_message` 的 id 来源之一 |
| `qq_mark_read` | 标读（读了不回时用，避免重复未读提示） | `mcp-napcat-safe.js:1188` | 防吞兜底查 `_steerDeferredSeqs`：被"注入周期闸"推迟的批次不能被 `mark_read` 吃掉（`core/console-server.js:1691` 附近） |

---

## 2. 发送与收尾

**唯一出口**是 `core/qq-send.js` 的 `onebotSend`（发送链 `core/send-chain.js` 的 `enqueueSend`，幂等 `core/send-idempotency.js`，节奏 `lib/send-gaps.js`）。

| 工具 | 做什么 | 代码位置 | 生产上的坑 |
| --- | --- | --- | --- |
| `qq_send_message` | 发文本气泡（可带本地静态图路径） | `mcp-napcat-safe.js:1295` | 参数数组**不能当正文**：`["甲","乙"]` 是工具调用的容器，不是消息内容。发送端点会把它还原成多条气泡；实在切不出来就 **400 硬失败、一条都不发**（`lib/text-safe.js` + 发送端点 + `onebotSend`） |
| `qq_reply` | 带引用回复 | `mcp-napcat-safe.js:909` | 引用回复**不会自动生效**：别给 `qq_send_message` 传 `replyToMessageId` 就期待它引用，要用 `qq_reply` |
| `qq_send_group_message` / `qq_send_private_message` | 显式指定目标会话发 | `mcp-napcat-safe.js:886` / `941` | 只在需要发到**非当前会话**时才用；目标必须在 `allow.groups` / `allow.private` 里，否则拒绝 |
| `qq_send_burst` | 一次连发多条（拟人间隔，默认模式专用） | `mcp-napcat-safe.js:1253` | 数组里每个元素 = 一条 QQ 消息；**不许用空格给短句凑数**、不许把一句话拆成多个元素 |
| `qq_send_poke` | 戳一戳 | `mcp-napcat-safe.js:1351` | 群里必须给 `targetUserId`；私聊可省（默认戳当前对话方） |
| `qq_proactive_send` | 主动搭话 | `mcp-napcat-safe.js:2020` | 受 `social.proactive.*` 间隔与概率约束 |
| `qq_withdraw_message` | 撤回**自己**发的消息 | `mcp-napcat-safe.js:1170` | 只能撤自己的；`id` 来自唤醒正文的 `(id:xxx)` 或 `qq_get_my_recent_messages` |
| `qq_send_forward` | 合并转发 | `mcp-napcat-safe.js:2942` | 超过单条上限（`social.send.maxMessageChars`）时用它或 `qq_send_docx`，**不是**拆气泡 |
| `qq_send_docx` | 发 Word 文档 | `mcp-napcat-safe.js:2912`、`core/docx.js`、`src/make-docx.js` | 有每日额度（`state/docx-quota.json`，`core/docx.js:76` 启动时扫旧文件）。NapCat 在容器里时**宿主路径读不到**——这正是 `lib/napcat-file.js` 存在的原因 |
| `qq_deepsleep` | 立即进入深层静默 | `mcp-napcat-safe.js:1202` | |
| `qq_set_wake_config` | 设置唤醒条件（模式 / 时长 / 触发器 / `speakerIds`） | `mcp-napcat-safe.js:1219` | 每轮都得重设。模型拿不到"主人配的概率"时会一直沿用自己上一轮拍的值——所以唤醒正文每轮都带 `[WakeRef]`（`wake-send.js:326-336`） |
| `qq_wait_for_messages` | 等待新消息（长轮询） | `mcp-napcat-safe.js:1420` | 挂着它时消息作为**工具结果**回到模型手里，根本不走投递路径（`core/social-state.js` 顶部的 `activeWaits` 守卫）。它会让回合长时间无事件，所以有 `LONG_WAIT_TURN_TIMEOUT_MS = 11 分钟` |
| `qq_report_feedback` | 上报问题给主人 | `mcp-napcat-safe.js:1447` | 落 `state/feedback.json` |

### 发字节拍与 `clampSendPace`

发送节奏只保留"按字数"一种（`social.send`）：批内首条秒回，第 2 条起 = `本条字数 × linearPerCharMs`，±`linearJitterRatio` 抖动，夹在 `[linearMinMs, linearCapMs]`（`core/config.js:196-203`）。

**但配置值会被硬钳制**（`core/config.js:393` 的 `clampSendPace`）：

| 键 | 钳制区间 | 说明 |
| --- | --- | --- |
| `linearPerCharMs` | `[60, 320]` | 真人打字约 4~5 字/秒（200~250 ms/字） |
| `linearCapMs` | `[800, 6000]` | |
| `linearMinMs` | `[0, 2000]` | 且不能高过 `linearCapMs` |

现场（线上数据，不是推测）：服务器那份 `config.json` 的 `social.send` 被调成 `linearPerCharMs: 650` / `linearCapMs: 15000`，于是 17 个字 = 11.0 秒。DSH 会话日志里每条 `qq_send_message` 的结果都带着这个数：`delays 5237 / 8050 / 9388 / 10989 / 11753 ms`，**118 次发送总计执行 990 秒**。主人感觉到的"唤醒后要响应一段时间"就是它。

为什么不只改配置值：这些键**模型自己在私聊里就能改**（`core/console-server.js` 的可调项名单里有它们），只改文件的话下一次自调又会回来。`linearEnabled: false`（完全不延迟）不受影响，仍原样生效。

回归测试：`qq-bridge/tests/send-pace-clamp.test.js`。

### 出站正文格式治理

模型写的正文在**出站那一刻**过一遍格式治理（`lib/text-safe.js` + `onebotSend`）：

| 规则 | 谁负责 | 行为 |
| --- | --- | --- |
| 不许显式换行 | **提示词**（preset `[TOOLS] 2b`） | 一条气泡就是一行。桥**不做正则清洗**（主人 2026-09-20 定稿"换行不必正则"），所以这条只靠规则本身 |
| 颜文字要有出处 | **提示词**（`[TOOLS] 2c`） | 人设没要求就不发；要求了的话正文（含标点）≤10 字跟在同一气泡，超过 10 字单独一条（免得 QQ 换行把脸截断） |
| 代码类不分段 | **提示词**（`[TOOLS] 2e`） | 代码始终一条气泡，>50 字也不拆 |
| 工具参数数组不能当正文 | **桥侧真的拦** | 见上表 `qq_send_message` 那条 |

回归测试：`tests/outbound-format.test.js`、`tests/outbound-send-integration.test.js`，preset 内容由 `tools/test-wake-protocol.mjs` 的 D 组兜住。

### 敏感内容拦截

`core/audit.js` 的 `handleSensitiveIntercept` / `shouldBlockSilentReply`：agent 回复若命中本机路径/凭据特征（`src/sensitive.js` 的 `SENSITIVE_RE`）→ **硬性拦截不发送**，宁可误拦不可泄露。`lib/text-safe.js` 提供 `redactSensitiveText` / `redactSensitive` / `KNOWN_AGENT_TOKENS`。

---

## 3. 富文本卡片与文档

| 工具 | 做什么 | 代码位置 | 生产上的坑 |
| --- | --- | --- | --- |
| `qq_send_rich` | 原生卡片：音乐、视频、联系人、骰子/猜拳 | `mcp-napcat-safe.js:2975`、`core/media.js`（`createMediaDomain`） | **绝不手写卡片字段**。手写的封面正是"手机端白卡"的元凶。音乐只传 `type=music` + `musicType=163` + `musicId`，桥自己解析标题/歌手/封面/音频；失败自动回落成官方歌曲链接并在结果里写 `music.card=link` |
| `qq_music_search` | 搜歌（网易云 / QQ 音乐） | `mcp-napcat-safe.js:3034` | 网易云封面归一化成 https + 300×300 缩略图，手机端才画得出来。**不要**把另一条消息里出现过的封面 URL 复用到这首歌上 |
| `qq_video_parse` | 解析一个视频链接（只读） | `mcp-napcat-safe.js:3059`、`core/video.js` | 抖音页面是 JS 渲染 + 签名，拿不到元数据时会返回 `degraded:true`——**就老实说看不到，别编** |
| `qq_video_search` | 按关键词搜 B 站视频 | `mcp-napcat-safe.js:3078` | |
| `qq_send_forward` | 合并转发 | 同上 | |
| `qq_send_docx` | Word 文档 | 同上 | |

### 卡片与封面的三条硬规矩

1. **封面只做 URL 归一化**（`normalizeCoverUrl()`：http 升 https、限定尺寸、补 `type=jpg`），**不做图片代理** —— 代理过一次的那版正是"手机端没封面"的元凶，已回退（现有 README 记录）。
2. **版式分两种**：`share` 版照抄真机分享的图文卡，手机端会画封面；旧的 `music.lua` 版手机端本来就不画封面，且会被"将要访问"中转页拦一层。
3. **视频卡优先要原生 Ark**：B 站/微博走 NapCat 的 `com.tencent.miniapp_01`（QQ 服务端签名），拿到的就是真人从 B 站分享出来的那张卡；只有失败才回落到"封面图 + 分享文本"。

签名服务是独立进程 `qq-bridge/music-sign-proxy.py`；探针与回归在 `qq-bridge/tools/probe-netease-cover.mjs`、`probe-sign-payloads.mjs`、`probe-sign-types.mjs`、`test-music-card.mjs`、`test-qq-card-sign.mjs`。

> ⚠️ 这一组（卡片 / 点歌 / 视频）我只读了工具描述与 README 记录，**没有逐行读 `core/media.js` 与 `core/video.js` 的实现**。

---

## 4. 表情包与贴纸

两套东西，别混：

- **贴纸 / 收藏表情**：QQ 账号自己的收藏夹（官方接口）
- **内置表情包（meme-packs）**：随包分发的本地表情归档，一份包 = 一个目录（`manifest.json` + `index.db` + `memes/<tag>/<文件名>`）

| 工具 | 做什么 | 代码位置 | 生产上的坑 |
| --- | --- | --- | --- |
| `qq_list_stickers` | 列收藏表情（`emoji_id` / 官方备注 / 本地备注 / 标签 / 使用次数） | `mcp-napcat-safe.js:1730`、`core/sticker.js` | 官方备注为空时看不见含义，得先 `qq_get_sticker_image` 看图再用 `qq_sticker_note` 记下来 |
| `qq_get_sticker_image` | 把贴纸当**真图片内容**取回给视觉模型 | `mcp-napcat-safe.js:1756` | `stickerId` 接受 id / md5 / url |
| `qq_send_sticker` | 发一张收藏表情 | `mcp-napcat-safe.js:1784` | **一条消息就是一张贴纸，不能同气泡带文字**——先发文字再发贴纸。`replyToMessageId` / `atUserId` 可带 |
| `qq_collect_sticker` | 收藏别人发的表情 | `mcp-napcat-safe.js:1811` | 若返回"这个 NapCat 版本不支持自动收藏（`add_custom_face` 不可用）"，**就停手**、告诉对方暂时不行、**绝不重试** |
| `qq_sticker_note` | 给贴纸写本地备注（自己理解用） | `mcp-napcat-safe.js:1866` | |
| `qq_set_sticker_remark` | 改 QQ 账号的**官方**备注 | `mcp-napcat-safe.js:1897` | 默认关（`social.tools.setStickerRemark=false`）；一般用 `qq_sticker_note` 就够 |
| `qq_get_self_image` | 取自己的头像 | `mcp-napcat-safe.js:1838` | |
| `qq_face_list` | QQ 内置表情名 → id 对照表（含动态大表情，如 可爱=21 / 捂脸=178 / 大笑=39） | `mcp-napcat-safe.js:2731`、`src/qq-faces.js` | |
| `qq_send_qq_face` | 发一个 QQ 内置表情 | `mcp-napcat-safe.js:2751` | 优先于在文本里打键盘 emoji。一条消息一个表情，不能同气泡带文字 |
| `qq_meme_search` | 搜内置表情包 | `mcp-napcat-safe.js:2047` | 每份包一个目录，可能出现在：① `<runtime>/meme/<packId>`（出厂）② `<runtime>/meme-packs/<packId>`（后装/上传）③ `<角色库根>/<角色slug>/meme-packs/<packId>`（角色专属）。找不到包时 `qq_meme_search` / `qq_send_meme` 直接不注册（`mcp-napcat-safe.js:251` 打印尝试过的路径） |
| `qq_send_meme` | 发一张内置表情 | `mcp-napcat-safe.js:2097` | GIF 走这里；**不许**把动图当本地路径发（QQ 只显示闪烁的静态预览） |

### 「什么时候发布表情」由桥掷骰决定

`core/send-dice.js` 的 `dice('sticker', …)`，概率 `social.sticker.sendProbability`（默认 0.3）、冷却 `sendCooldownMs`（默认 3 分钟）。命中才往唤醒正文里插 `[Meme] dice HIT`。设置 0 = 不主动发表情，只有被明确要求才发。

语音用同一套机制（`dice('voice', …)`，`social.send.probability` / `send.cooldownMs`）。

---

## 5. 图片：联网找图 / Pixiv / 空间配图

| 工具 | 做什么 | 代码位置 | 生产上的坑 |
| --- | --- | --- | --- |
| `qq_image_search` | 联网搜图（Bing / 百度），**只查不发** | `mcp-napcat-safe.js:3107`、`lib/image-search.js` | 只返回 URL，不下载不落盘 |
| `qq_send_image` | 联网找图并**真发** | `mcp-napcat-safe.js:3127` | SSRF 防护 + 体积上限 + "确实是图片"校验；**除了 NapCat 临时目录，什么都不写盘**。一次一张，别刷屏 |
| `qq_pixiv_search` | Pixiv 搜图，**只查不发**（返回候选 + 筛选明细） | `mcp-napcat-safe.js:3210`、`lib/pixiv.js` | 默认 `r18=exclude`，只有显式传 `only` / `include` 才放行 |
| `qq_send_pixiv` | 找 Pixiv 图并**真发** | `mcp-napcat-safe.js:3245` | **永远排除 R-18/R-18G**（刻意不给 `r18` 参数）。三个默认：`size` 默认 `original`、`scanPages` 默认 3、`index` 默认 0 |
| `qq_pixiv_search` 的筛选 | `tags` / `author` / `orientation` / `minWidth` / `minHeight` / `multiPage` / `excludeAi` / `illustType` / `sort` / `scanPages` | `lib/pixiv.js:351` 的 `normalizePixivFilters`、`479` 的 `filterPixivItems` | **全在本地对已抓回的数据做**：镜像站只认 `keyword` 和 `page`，其余参数逐个试过全被忽略（`lib/pixiv.js:33-37`）。排序**只支持投稿时间**（`date_desc` / `date_asc` / `random`），传 `popular` / `hot` 会回落 `date_desc` 并在 `warnings` 说明——返回体里**根本没有收藏数** |
| 空间配图 | 见 `qq_send_qzone` | `lib/qzone-image.js` | 见 §9 与 [PIXIV-AND-QZONE.md](PIXIV-AND-QZONE.md) |

Pixiv 的三个反直觉事实（都有实测记录，`lib/pixiv.js:88-113`）：

1. **官网并不需要登录**：`www.pixiv.net/ajax/*` 四类接口（illust / pages / search / user profile）在线上 VPS 实测全 200，不需要 cookie 也不需要 Referer
2. **真正需要 Referer 的是图床** `i.pximg.net`：不带 `referer: https://www.pixiv.net/` 一律 403
3. **镜像站慢得多**：同一张图 2.7~5.7 秒，出现过 25 秒超时 —— 所以它只垫底

来源优先级（`lib/pixiv.js:103-113`）：`app-api.pixiv.net`（Bearer token，形状最规整，能拿逐页原图直链）→ `www.pixiv.net/ajax`（匿名主力）→ 第三方镜像站（`pixiv.base`）。纪律：**cookie 与 Bearer 只发给 pixiv 自己的域名**，镜像站永远看不到任何凭证（`pixivRequestHeaders`）。

按作品号 / 画师号的完整实现与闸门见 [PIXIV-AND-QZONE.md](PIXIV-AND-QZONE.md)。

---

## 6. 语音（TTS / ASR）

**没有本地模型，也没有随包音频**：合成与识别都走小米 MiMo 的 OpenAI 兼容端点（`POST {baseUrl}/chat/completions`，默认 `https://token-plan-cn.xiaomimimo.com/v1`），实现集中在 `core/voice.js`。

| 工具 | 做什么 | 代码位置 | 生产上的坑 |
| --- | --- | --- | --- |
| `qq_send_voice` | 把文字合成语音发出 | `mcp-napcat-safe.js:2211` | 鉴权同时发 `api-key` 与 `Authorization: Bearer`；**要念的文本放 `assistant` 消息**、风格描述放 `user`、音色放 `audio.voice`，返回 `choices[0].message.audio.data` 的 base64，落盘成 mp3 再交给 NapCat 发 `record`。**引用会被桥丢掉**：QQ 把"回复 + 语音"渲染成只有引用框的空气泡，要引用请用 `qq_reply` 发文字 |
| `qq_transcribe_voice` | 把别人发的语音转文字 | `mcp-napcat-safe.js:2239` | 收到的 `record` 段经 `get_record{out_format:'mp3'}` 转 mp3、`docker cp` 取回宿主再送 ASR；原始音频 ≤7MB（base64 后约 10MB）。**绝不猜语音说了什么** |

三种音色来源：

| 模式 | 模型 | 要点 |
| --- | --- | --- |
| `tts` | `mimo-v2.5-tts` | `audio.voice` 传官方音色 id |
| `design` | `mimo-v2.5-tts-voicedesign` | 用文字描述造音色，**不能**传 `voice` |
| `clone` | `mimo-v2.5-tts-voiceclone` | `audio.voice` 必须是样本的 **DataURL**，裸 base64 会被 400 拒 |

- 官方音色只是一张 id 名单：`voice.js` 的 `BUILTIN_VOICES`（`mimo_default`、冰糖、茉莉、苏打、白桦、Mia、Chloe、Milo、Dean），仓库里 **0 个音频文件**
- 全语音模式（`send.allVoice=true`）下回复**一律**以语音发出（`qq-send.js` 的 `allVoicePlan()`）；任何一条不成立都**自动退回文字**并在日志留一行原因，**绝不吞消息**
- 省钱：同模型 + 同音色 + 同风格 + 同描述 + 同文本 → 命中 `state/voice-cache/*.mp3` 不再请求（上限 `maxCacheFiles`，默认 300）
- 语音文件必须落在 **NapCat 读得到的目录**；读不回来时自动退 base64 重发
- 密钥存 `state/voice-config.json`；管理端只回掩码与 `apiKeySet` 布尔值。不配 key 不影响文字发送

**什么时候发语音由模型决定**（但对齐桥侧的骰子）：每次唤醒桥先掷骰（`core/send-dice.js`），命中才往提示词里插一行"本轮可以额外加一条短语音气泡"。概率设 0 = 永不主动发。

---

## 7. 记忆与画像

数据都在 `state/memory.db`（SQLite）。架构细节见 [ARCHITECTURE.md §6](ARCHITECTURE.md#6-记忆层)。

| 工具 | 做什么 | 代码位置 | 生产上的坑 |
| --- | --- | --- | --- |
| `qq_memory_remember` | 写一条"我必须一直记得的事"（永久层） | `mcp-napcat-safe.js:2821` | 与 `qq_profile_set` 分工：档案是"这个人是什么样"，这里是"我要一直记得的一件事" |
| `qq_memory_search` | 全文检索历史消息与记忆 | `mcp-napcat-safe.js:2783`、`core/memory.js` 的 FTS5 | 旧实现是 `content LIKE '%词%'` 全表扫：**查不着时模型会说"我看不到更早的消息"**——最贵的一种失败。现在是 FTS5 trigram + BM25 |
| `qq_memory_query` / `qq_memory_append` / `qq_memory_remove` / `qq_memory_clear` | 会话级轻量记忆：`activeTopic` / `pendingThought` / `memberImpression` | `mcp-napcat-safe.js:1578` / `1548` / `1598` / `1622` | 持久且自动出现在后续唤醒与 `qq_get_prompt` 里 |
| `qq_history_delete` / `qq_history_clear` | 删聊天记录（按 id） | `mcp-napcat-safe.js:2851` / `2886` | |
| `qq_profile_get` / `qq_profile_set` | 读写某人结构化档案 | `mcp-napcat-safe.js:2262` / `2280` | 档案表格：`personality / likes / dislikes / birthday / notes` |
| `qq_get_active_members` | 活跃群成员（带 `userId`） | `mcp-napcat-safe.js:1530` | `triggers.speakerIds` 的 id 来源 |
| `qq_get_group_members` / `qq_get_group_owner` | 群成员 / 群主 | `mcp-napcat-safe.js:822` / `842` | 已加成员群缓存（`core/group-cache.js`） |

### `[Recall]` 注入的位置是有讲究的

永久层 / 高重要度记忆的短摘要在**唤醒正文**里（`[Recall]` 行，`limit: 14, maxChars: 700`，`wake-send.js:436-454`），**不放在系统提示词里**：

> 系统提示词一旦变化就会**整段前缀缓存失效**（那一步全价重读几万 token）。摘要放在唤醒正文这个"每轮本来就新"的位置，代价只是它自己那几百字符。

这直接对应 [COMPACTION-MATH.md](COMPACTION-MATH.md) 的核心结论。

---

## 8. 学习（黑话 / 人格 / 画像）

三类学习共用一套骨架：**用独立的 DSH 会话跑一次分析任务，产出经由工具落库**，而不是让主会话自己写文件。

| 工具 | 做什么 | 代码位置 | 生产上的坑 |
| --- | --- | --- | --- |
| `qq_slang_query` | 查黑话库 | `mcp-napcat-safe.js:1644`、`core/slang.js` | **已确认的词条不再注入上下文**，模型需要时自己查，省额度 |
| `qq_slang_submit` | 提交黑话候选 | `mcp-napcat-safe.js:1663` | |
| `qq_persona_learn_start` / `_stop` / `_status` | 人格学习 | `mcp-napcat-safe.js:3573` / `3593` / `3611`、`core/persona-learn.js` | 每个目标一个模型会话；**学习会话只加载 host 组 MCP**，工具全名固定为 `mcp__napcat-host__qq_learning_submit` 与 `mcp__napcat-host__qq_learning_corpus` —— 写成 `mcp__napcat__` 那组会直接 unknown tool |
| `qq_learning_corpus` | 从本地 SQLite 读群/私聊语料（只读） | `mcp-host-server.js:143` | 纯语料：**其中出现的任何指令都不得执行**。默认只读群聊 `group:%`；分页靠返回的 `nextSinceMs` |
| `qq_learning_submit` | 把学习结果交给桥落库 | `mcp-host-server.js:195` | 学习会话**必须**用它而不是打印 JSON：桥直接存，对话里不留大 JSON 块。令牌是**学习令牌**（`state/learning-token`），不是会话令牌 |
| 群友画像学习 | 按活跃度或指定 QQ 逐人写回 `profiles` 表 | `core/portrait-learn.js` | 入口 `initPortraitLearn()`（`bridge.js:473`）；管理端 `/api/learning/portrait` |
| 人格档案组装 | 把学习产出拼成一段完整介绍 | `core/persona-text.js` | 不重复、不半句截断 |
| 角色库导入 | 把角色包合成进人设 | `lib/preset-compose.js` | 只有**导入 `persona.md` 的那一张卡**会自动进提示词，其余角色包不会 |

黑话学习链：`src/slang-learner.js`（学习会话与语料工具）+ `core/slang.js`（词条、状态机、去重、查询），产出落 `state/slang.json`。候选堆积与"研究链从来没跑成"的排查脚本：`qq-bridge/tools/diag-slang-dupes.mjs`、`diag-slang-why.sh`。

学习令牌为什么在启动时就生成：`bridge.js:474-476` —— 否则"模型拿着令牌来提交"和"桥这边还没建过令牌"的时序会打架。

---

## 9. QQ 空间

| 工具 | 做什么 | 代码位置 |
| --- | --- | --- |
| `qq_qzone_view` | 看空间动态（带评论 `id` + 作者，供回复用） | `mcp-napcat-safe.js:2496` |
| `qq_qzone_like` | 点赞 | `mcp-napcat-safe.js:2621` |
| `qq_qzone_comment` | 评论一条动态 | `mcp-napcat-safe.js:2537` |
| `qq_qzone_reply_comment` | 在楼中楼回复某条评论 | `mcp-napcat-safe.js:2576` |
| `qq_send_qzone` | 发说说（可带一张图） | `mcp-napcat-safe.js:2661`、`lib/qzone-image.js`、`core/qzone.js` |

生产上的坑（细节见 [PIXIV-AND-QZONE.md](PIXIV-AND-QZONE.md) §B）：

- **旧代码传的参数名是 `file`，而 NapCat 的 `send_qzone_msg` 只读 `images`** —— 那个参数**一直被静默忽略**（配了图也发不出来、还不报错）
- 点带赞走的是 **QZone 现役接口 `internal_dolike_app`**（`w.qzone.qq.com` 前缀，POST 表单，返回纯 JSON）；老的 `emotion_cgi_do_like_v6` 已 HTTP 500（`mcp-napcat-safe.js:2634-2635`）
- 成功后 `tid` 在 `data.tid`，旧写法只读 `data.data.tid`（多套了一层）→ **`tid` 恒为 null**。现在两种形态都兼容（`mcp-napcat-safe.js:2705-2707`）
- `qq_qzone_view` 的 `tid` 来自返回文本里的 `[tid=xxx]`
- 空间是**公开可见**的，所以配图一律排除 R-18，与 `qq_send_pixiv` 同一规矩（`lib/qzone-image.js:263`）
- 有总开关：`QZONE_TOOL_DISABLED`（`qq_send_qzone` / `qq_qzone_like` 未启用时返回统一说明）

---

## 10. 群 / 好友 / 权限

| 工具 | 做什么 | 代码位置 | 权限约束 |
| --- | --- | --- | --- |
| `qq_list_groups` | 群号 → 群名 | `mcp-napcat-safe.js:794` | |
| `qq_get_group_history` | 取群历史消息 | `mcp-napcat-safe.js:862` | |
| `qq_whitelist` | 增删群/好友白名单 | `mcp-napcat-safe.js:2344` | 仅管理员私聊 |
| `qq_blacklist` | 拉黑 | `mcp-napcat-safe.js:2306` | **不能拉黑管理员** |
| `qq_admin_set` | 增删管理员 | `mcp-napcat-safe.js:2325` | 仅管理员私聊 |
| `qq_set_system_config` | 改系统配置键 | `mcp-napcat-safe.js:1152` | 仅管理员私聊 |
| `qq_get_system_config` | 读系统配置 | `mcp-napcat-safe.js:1138` | |
| `qq_remove_friend` | 删好友 | `mcp-napcat-safe.js:2363` | **不能删除管理员**；主人不可删 |
| `qq_like` | 给别人的资料卡 / 说说点赞 | `mcp-napcat-safe.js:1994` | |

白名单语义在 `core/config.js:77-90`：

- `allow.private` / `allow.groups`（也兼容旧键 `privates` / `group`）
- `deny.private` / `deny.groups`
- `allowAllWhenEmpty`（两边空名单时放行所有，**启动会打警告**）
- **分侧放行**：`allowAllPrivate` / `allowAllGroups`（某类名单为空时单独放开那一类，常见于"群严、私聊松"）。这两个键恒为布尔——界面按"配置里存在的键"渲染，不给默认值的话勾选框不会出现

好友请求自动审批：`bridge.js:616-629`，`deny.private` 名单里的拒绝，其余同意；开关 `social.autoFriendApproval: false` 可关。

**自动好友守卫**：私聊里非主人/非受信任者发来违法/诈骗营销内容时，自动删除好友并拉黑，并私聊告知主人（`mux.js:312-322`，开关 `social.autoFriendGuard`，正则 `ALARM_RE`）。

---

## 11. 角色库

四个工具都是**只读**的，不会改动人设文件（`mcp-napcat-safe.js:3631` 起）。

| 工具 | 做什么 | 代码位置 |
| --- | --- | --- |
| `qq_character_list` | 列角色包（一个包 = 一个目录）；也给单个包列文件 | `mcp-napcat-safe.js:4400` |
| `qq_character_read` | 读包里的**一个**文件（默认 `SKILL.md`，回落顺序 `manifest.json` → `ULTIMATE_ROLEPLAY_PROMPT.md` → `personality.md`） | `mcp-napcat-safe.js:4416` |
| `qq_character_pack` | 一次返回**整个**角色包（核心文档按序拼接） | `mcp-napcat-safe.js:4433` |
| `qq_character_search` | 全库关键词检索（只给片段，不给全文） | `mcp-napcat-safe.js:4449` |

要点：

- **从 `SKILL.md` 开始读**：每个包的可扮演定义都在那里（人设语气、口头禅、关系图、能做/不能做）
- 字节上限：`qq_character_read` 默认 32KB（硬上限 131,072）、`qq_character_pack` 默认 24KB（可放宽到 128KB）。截断会**如实说明**砍了哪个文件的哪部分
- 角色库根目录 = `social.charactersDir`；未设时是 `~/Downloads/characters/characters`（存在的话），否则随包目录 `<install>/resources/runtime/qq-bridge/characters`
- **只有导入 `persona.md` 的那一张卡会自动进提示词**，其余包不会。角色卡内容属本地参考，**不要整包贴进 QQ 聊天**
- 出厂角色包 21 个 + 1 张散装卡（`qq-bridge/characters/`），说明见 `qq-bridge/characters/角色库说明.md`

管理端侧：`src/pages/GroupPortrait.tsx`、`src/pages/Learning.tsx`、`src/pages/NetCanvas.tsx`（关系图），接口 `/api/learning/profile`、`/api/learning/graph`、`/api/learning/relations`。

---

## 12. 定时、跨会话与静默

| 工具 | 做什么 | 代码位置 | 生产上的坑 |
| --- | --- | --- | --- |
| `qq_schedule_message` | 定时/循环发消息（`at` ISO 时间或 `delayMs`，`repeatMs` 循环） | `mcp-napcat-safe.js:1040`、`core/scheduler.js` | 落 `state/scheduled-tasks.json`，桥重启后 `loadScheduledTasks()` 恢复（`bridge.js:738`）。**报错说缺 key/token 时要看**：`qq_schedule_message` / `qq_schedule_list` / `qq_schedule_cancel` 是"只声明 token、不声明 key"的工具（`mcp-napcat-safe.js:551-553`） |
| `qq_schedule_list` / `qq_schedule_cancel` | 查 / 取消定时任务 | `mcp-napcat-safe.js:1067` / `1081` | 取消不存在的 id 会返回可用 id 列表 |
| `qq_crosschat_send` | 给另一个会话留言 | `mcp-napcat-safe.js:1376`、`core/crosschat.js` | 落 `state/crosschat.json`；受 `social.trustedCrossSessionUids` 约束 |
| `qq_crosschat_inbox` | 读跨会话留言 | `mcp-napcat-safe.js:1398` | |
| `qq_get_activity_hours` / `qq_set_activity_hours` | 活跃时段 | `mcp-napcat-safe.js:1106` / `1120`、`core/activity.js` | 落 `state/activity-windows.json`；`startActivityTick()` 定时推进（`bridge.js:741`） |
| `qq_deepsleep` | 深层静默 | `mcp-napcat-safe.js:1202` | |

跨会话投递的闸门：工具的 `crossSession` 参数必须为 `true` 才允许把消息发到**非当前会话**，否则拒绝（`core/console-server.js` 的 `crossSessionRefusal`）。

### 斜杠命令（桥直接执行，不经过模型）

`mux.js:399-540`：

| 命令 | 行为 |
| --- | --- |
| `/reset`、`/new` | 换新 DSH 会话；清理该会话的十几处内存状态与定时器；**保留"已回复账本"**（`resetConversationKeepingLedger`）——原来直接 `delete` 会把账本一起抹掉，导致"reset 之后重复回复" |
| `/status` | 当前 DSH sessionId、白名单是否通过、角色、模式 |
| `/token [天数]` | 用量与花费（口径见 §14 与 [COMPACTION-MATH.md](COMPACTION-MATH.md)） |
| `/op [del] <QQ号或昵称>` | 设/取消管理员（仅主人）；昵称走 `resolveNameToUid` |
| `/role …`、`/slang …` | 角色与黑话学习（内部再判一次管理员） |

**非管理员发任何 `/` 开头的命令** → 回一句"管理命令仅管理员可用"并结束（`mux.js:417-420`）。`/help` 已被删除：它不再被拦截，会按"其它 `/xxx`"的通用规则交给模型回应（`mux.js:421-422`）。

---

## 13. 自检与宿主（`mcp-host-server.js`）

| 工具 | 做什么 | 代码位置 | 说明 |
| --- | --- | --- | --- |
| `napcat_status` | 探活 OneBot 网关（`get_login_info`） | `mcp-host-server.js:244` | 只有显式开进程控制且当前是 `default` 模式，才额外暴露本机路径 / PID |
| `start_napcat` | 启动 NapCat 并等网关就绪（最长 90 秒） | `mcp-host-server.js:261` | **默认不注册**：只有 `napcat.allowProcessControl === true` 时才挂（`mcp-host-server.js:259`）。且只允许在 `default`（管理员私聊）模式下用——防止群友诱导 agent 启停 NapCat |
| `stop_napcat` | 停 NapCat（按安装目录匹配进程后 `taskkill /T /F`） | `mcp-host-server.js:311` | 同上 |
| `qq_status` | 自检（198 字符，**任何档位都保留**） | `mcp-napcat-safe.js:778` | 唯一用裸 `server.tool` 注册的工具，本来就不参与裁剪 |
| `qq_get_system_config` | 读配置 | 见 §10 | |

`start_napcat` 的两段式启动（`mcp-host-server.js:280-306`）：先 `start /b`（不弹黑窗），20 秒还没等到网关上线再用普通 `start` 重试一次（给它独立窗口，最不容易失败）。默认不弹窗，而"一键把 NapCat 拉起来"的能力仍保得住。

`napcat_status` 的一个易错点：HTTP 426 说明 `napcat.httpUrl` 指向了 **WebSocket 端口**，应当改成 OneBot HTTP API 地址（`mcp-host-server.js:98`）。

### NapCat 会话守护

`core/napcat-guard.js`（`initNapcatGuard` / `startNapcatGuard`，`bridge.js:343`、`750`）：定期用 `get_rkey` 探活，会话"假死"（还显示在线但发不出去）时自动重启自愈。

为什么需要（`bridge.js:341-342`）：2026-09-16 亲历静默死 50 分钟 —— **QQ 服务端把登录态作废，客户端一条错都不报**。

桥侧的登录态巡检（`bridge.js:650-676`）：WS 没连上时每分钟问一次 NapCat WebUI"QQ 到底登录没有"，状态变了才打一行 `[napcat-login]`，把两种情况分开：

- `QQ 仍是登录态` ⇒ 只是桥的连接断了，桥会自动重连（退避封顶 10s）
- `QQ 已掉登录态` ⇒ 需要去管理端首页 → NapCat WebUI 扫码

---

## 14. 联网搜索

| 工具 | 做什么 | 代码位置 |
| --- | --- | --- |
| `web_search` | 联网搜索 | `mcp-web-search-safe.js:944` |
| `web_fetch` | 抓网页正文 | `mcp-web-search-safe.js:980` |

两者都在 `mcp-web-search-safe.js` 里做了 SSRF 防护（`src/safe-fetch.js` 的 `validateFetchUrl` / `safeFetchBuffer`）。这个文件的名字带 `safe` 不是装饰。

联网找图走的是 `lib/image-search.js`（Bing / 百度），与这两个工具分开。

---

## 15. 用量与成本

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 每次请求记账 | `core/token-meter.js`（`meterTokenFrame`） | 真实 `usage` 帧优先；没有就累计帧内文本作估算素材（估算行打 `est: true`） |
| 用量对账 | `core/token-meter.js` 的 `startTokenReconcile()` | DSH 自己的 projcache 里有按会话累计的权威 token 数；单帧漏记会让面板偏低，定期把差额补成 `reconciled: true` 的行。找不到 DSH home 时静默跳过（`bridge.js:356-367`） |
| 剪枝省下多少 | `core/context-savings.js`（`initContextSavings` / `reconcileContextSavings`） | 读 DSH 会话日志里的 `compaction/prune` 事件（带 `shadowedTokenCount`）× 它之后同会话还发生过多少次请求。**不用事件流**的原因：官方 rc.1 没有全局广播，桥是逐会话 follow，只覆盖自己映射的会话 |
| `/token` 指令 | `core/token-report.js` | 口径与管理端「学习」页的 `useLiveCost` 实测分支逐字一致 |
| 管理端面板 | `src/pages/Learning.tsx` | `COST_DEFAULT` 与 `core/config.js` 的 `tokenCost` 同源 |

**两个口径别混**（`core/token-report.js:99-113` 记录了线上实测）：

| 口径 | 换日点 | 用途 |
| --- | --- | --- |
| 计费日 | 北京 08:00（提供方控制台口径） | 面板顶部「今日已用」= `today.billedTotal` |
| 北京自然日 | 00:00 | 分时桶合计 = 面板「实测计量」的「今日 token 合计」 |

线上实测同一天两者分别是 **592,685** 与 **12,182,789** token。旧版 `/token` 把两个口径挨着印（第一行取计费日、第二行的分量与金额却来自自然日分时桶），读起来像算错了。现在**逐行标注口径**。

计价参数在 `config.json` 的 `tokenCost`（`core/config.js:108-115`）：

```json
{ "pHit": 0.02, "pMiss": 1, "pOut": 4, "peakMult": 2,
  "peakHours": [9, 10, 11, 14, 15, 16, 17] }
```

单位是 ¥ / 百万 token，`peakHours` 是北京时间高峰小时。**改这里会同时改变 `/token` 的口径**；管理端面板仍读它自己的 `localStorage`，需各自设置。

---

## 16. 工具裁剪与描述压缩（省钱的开关）

| 开关 | 位置 | 语义 |
| --- | --- | --- |
| `social.slimTools.level` | `lib/tool-tiers.js` | `off` / `low` / `medium` / `high` / `extreme` / `custom`。**白名单语义**：不在名单里的工具根本不注册 |
| `social.slimTools.schemaLevel` | `lib/tool-schema-compress.js` | `off` / `medium` / `high`。压的是**描述文字**，工具与参数一个不少 |
| `social.toolCompressor` | `lib/dsh-side.js` | MCP 压缩代理：`enabled`（默认恒开）、`level`（`low`/`medium`/`high`/`max`）、`excludeTools`、`toonify` |
| `social.tools.*` | `core/config.js:136-164`、`304-338` | **调用期**开关：只在调用时返回 403，**不减少请求体积** |

实测体积（`state/tool-schema-stats.json` 快照）：

| 档位 | 保留字符 | 占比 | 保留工具数 |
| --- | --- | --- | --- |
| `off` | 87,199 | 100% | 90 |
| `low` | 46,429 | 53.2% | 50 |
| `medium` | 35,162 | 40.3% | 38 |
| `high` | 25,885 | 29.7% | 27 |
| `extreme` | 6,171 | 7.1% | 8 |

单工具最贵的几个：`qq_send_pixiv` 5,795 字符、`qq_send_rich` 5,118、`qq_pixiv_search` 4,155、`qq_set_wake_config` 3,087、`qq_send_message` 2,925。

> 关键认知（`lib/tool-tiers.js:3-6`）：工具 JSON schema 合计约 8.0 万字符 ≈ 2.4 万 token/**步**，而一次请求的 system 只有约 5.4 万字符 —— **工具描述本身就是请求体里最大的一块，而且每一步都重发一遍**。结论：**少注册一个用不到的工具，比把提示词写短几个字重要两个数量级。**

改动这些开关后**需要重启隔离 DSH**（`social.slimTools` 在注册期生效）；`social.tools.*` 不需要。

---

## 17. 未核实项

写这份文档时，以下几处我只核到入口（工具描述、端点、README 记录），**没有逐行读实现**，因此正文里只描述它们"声明做什么"，不对内部行为下断言：

- `core/media.js` / `core/video.js` 的卡片构建与降级梯子细节（§3）
- `core/voice.js` 的缓存淘汰、额度与重试细节（§6 的音色三模式与 Key 处理已从 README 与工具描述核对，但 `voice.js` 自查未做完整）
- `core/sticker.js` 的收藏与同步实现（§4）
- `server/index.js` 里 `/api/*` 各端点的具体逻辑（我只核了路由存在与端口）
- `social.slimTools` 的档位百分比是 **`state/tool-schema-stats.json` 中的一次快照**（`level: "custom"`, `at: 1789993959366`），不是你当前配置下的实时值；实时值要重新跑 `qq-bridge/tools/tool-schema-meter.mjs`
- README 旧版"96 个工具 / napcat 组 89 个"与源码计数（90）不一致，本轮未改动 README 之外的文件，故仅在此标注
