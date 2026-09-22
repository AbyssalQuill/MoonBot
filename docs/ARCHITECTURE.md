# 架构

本文描述 MoonBot Pro 的完整结构：分层、一条 QQ 消息的完整生命周期、唤醒 / 在途注入 / 回合保持三套机器、工具面、记忆层、状态文件、以及线上部署路径。

行号引用的是写作时的仓库状态，重构后可能平移；**函数名与文件名是稳定锚点**。

---

## 1. 分层

```
用户（QQ 群 / 私聊）
        │ QQ 协议
┌───────────────────────────────────────────────────────────────┐
│ NapCat  WebUI :6099   OneBot HTTP :3000   反向 WS :3001        │
│        把 QQ NT 转成 OneBot v11 服务端                          │
└───────────────────────────┬───────────────────────────────────┘
                            │ OneBot v11（WebSocket）
┌───────────────────────────▼───────────────────────────────────┐
│ qq-bridge   入口 qq-bridge/src/bridge.js   控制台 :3100         │
│   唤醒判定 → 提示词组装 → 会话映射 → DSH 投递 → 事件泵 →         │
│   工具调用 → 发送链 → QQ                                        │
│   三组 MCP server（stdio）：mcp-napcat-safe / mcp-napcat-host / │
│   mcp-web-search-safe                                           │
└───────────────────────────┬───────────────────────────────────┘
                            │ DSH HTTP API（session.prompt mode:'steer'）
┌───────────────────────────▼───────────────────────────────────┐
│ 隔离 DSH   独立 DSH_HOME   profile=web                         │
│   agent preset（qq-chat / default）：[WAKE TYPES] / [RULES] /   │
│   [TOOLS] / [TOOLS 2b~2e] 等行为规则                            │
│   本地插件：dsh-qq-hold（回合保持钩子）、qq-mode-console、      │
│             dsh-memory（长期记忆 remember/recall）              │
└───────────────────────────┬───────────────────────────────────┘
                            │ LLM API
                        模型服务商
```

管理端（Electron + React + Express）不在这条数据链上，它是**编排者**：拉起上面的进程、写配置、看日志、SSH 部署。

各层入口与职责：

| 层 | 入口 | 职责 |
| --- | --- | --- |
| 管理端前端 | `src/App.tsx`、`src/api.ts` | 页面切换与后端接口封装；页面在 `src/pages/`，共享组件在 `src/components/`，类型在 `src/stores/types.ts` |
| 管理端后端 | `server/index.js` | HTTP API、实例编排与探活、前端静态托管、安装位置体检（`RUNTIME_ROOT`，`server/index.js:25-31`） |
| 远程部署 | `server/deploy.js` | SSH 一键克隆：打包 → 流式转发 → 目标机解包 → systemd / NapCat 容器 → 启动自检 |
| 关窗守卫 | `server/napcat-guardian.mjs` | 独立进程，壳退出后兜底停 NapCat / 桥 / 隔离 DSH |
| QQ 桥入口 | `qq-bridge/src/bridge.js` | 载入配置、连接 OneBot 反向 WS、装载事件泵与各子系统 |
| 桥业务层 | `qq-bridge/src/core/*.js` | 唤醒投递、提示词组装、会话映射、社交状态、发送链、媒体与卡片、语音、学习、用量 |
| 桥基础库 | `qq-bridge/src/lib/*.js` | OneBot 客户端、消息解析、图片体检、Pixiv、路径、文本处理等 |
| 桥工具层 | `qq-bridge/src/mcp-*.js` | 三组 MCP server |
| 隔离 DSH | `qq-bridge/dsh/agent-presets/qq-chat/` | `preset.yml` / `agent.cordis.yml` 提供行为规则，`qq-tool-restrict.mjs` 限制可用工具 |
| DSH 插件 | `qq-bridge/plugins/dsh-qq-hold/`、`qq-bridge/plugins/qq-mode-console/`、`qq-bridge/plugins/dsh-memory/` | 回合保持、模式控制台、长期记忆 |
| NapCat | `napcat-onekey/bootmain/` | 便携版 NapCat 与 QQ，启动脚本 `napcat.bat`、扫码用 `napcat.quick.bat` |

两侧配置严格分开：

- 管理端配置：`%USERPROFILE%\.qq-bridge-manager\config.json`，日志 `…\.qq-bridge-manager\logs\`（`server/index.js:37-41`）
- 桥配置：`<运行时>/qq-bridge/config.json`，模板 `qq-bridge/config.example.json`

---

## 2. 端口与进程

### 端口

| 端口 | 服务 | 用途 |
| --- | --- | --- |
| 1921 | 管理端后端 | HTTP API + 前端静态托管，可用 `QBM_API_PORT` 覆盖（`server/index.js:7206`） |
| 5173 | Vite dev server | 仅开发模式 |
| 6099 | NapCat | 官方 WebUI，扫码登录与 OneBot 配置 |
| 3000 | NapCat | OneBot HTTP 动作接口（`send_qzone_msg` 等走这里） |
| 3001 | NapCat | OneBot 反向 WS 事件推送（桥连的就是它，`core/config.js:70`） |
| 10721 | 隔离 DSH | agent 运行时 API（`core/config.js:20` 的默认 `dsh.baseUrl`） |
| 3100 | 桥 | 本地控制台（`core/config.js:94` 的 `consolePort`） |

> 线上克隆部署时，`server/deploy.js:1291-1295` 有一段 node 内联脚本把目标机 `/root/qq-bridge/config.json` 的 `dsh.baseUrl` 改写成 `http://127.0.0.1:3080`。也就是说**服务器上隔离 DSH 与本地默认端口不同**，对着日志排查时不要混用。（该改写发生在"目标机配置对齐"步骤里；我没有逐条验证它所有分支条件。）

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

1. 壳向 `/api/shutdown` 发 `{all:true}`（`server/index.js:7595`），后端停桥、隔离 DSH 与 NapCat
2. 壳 `taskkill /pid <后端> /T /F`
3. 壳按可执行文件路径清理残留 `qbm-node.exe`
4. 守卫每 2 秒看 `MoonBot.exe`，进程消失后等 6 秒再核对 guard 文件，确认无新后端接管后依次停 NapCat、桥、隔离 DSH

守卫只按托管目录、桥的绝对路径与 DSH 端口匹配进程，缺少参数时跳过对应清理。

---

## 3. 一条入站 QQ 消息的完整事件流

入口在 `qq-bridge/src/bridge.js`：

- `bot.onPrivateMessage` → `handleIncoming('private', user_id, event, cfg)`（`bridge.js:575-578`）
- `bot.onGroupMessage` → `handleIncoming('group', group_id, event, cfg)`（`bridge.js:579-582`）
- `bot.onNotice('notify')` → 拍一拍 / 输入状态（`bridge.js:583-586`）
- 撤回事件 → 标 `[已撤回]` + 落库 `chat_messages.recalled_at`（`bridge.js:589-614`）

### 3.1 入站归一（`core/mux.js` 的 `handleIncoming`，`mux.js:295`）

| 步骤 | 做什么 | 位置 |
| --- | --- | --- |
| 1 | `convKey(kind, id)` → 会话键 `private:<QQ>` / `group:<群号>`；模式不允许直接忽略 | `mux.js:296-300` |
| 2 | 两套正文：`textContent`（带 `[引用 X：…]`，供判断"这句话在对谁说"）与 `plainContent`（只有本条文字，供命令与指向性判定） | `mux.js:309-310` |
| 3 | 私聊违法/诈骗内容自动删好友并拉黑（`social.autoFriendGuard`） | `mux.js:312-322` |
| 4 | 抽媒体段与文件段，按 `message_id` / `message_seq` 存进 `messageMediaStore`（超过 `MAX_MEDIA_STORE_PER_KEY` 丢最旧） | `mux.js:323-341` |
| 5 | 判断"引用的对象是不是机器人自己"（`isQuoteTargetSelf`）——**必须在空文本过滤之前**，否则"只引用不附文"会被漏掉 | `mux.js:344` |
| 6 | 入站幂等去重 `isDuplicateInbound(key, messageId)`，防重复入库 → 重复唤醒 → 重复回复 | `mux.js:347-350` |
| 7 | 有挂起提问时先当回答消费；静默模式只记不投；角色切换/人格学习/画像学习/斜杠命令分流 | `mux.js:356-540` |

### 3.2 唤醒判定（`core/wake-send.js` 的 `evaluateWakeTrigger`，`wake-send.js:174`）

返回一个"原因字符串"，它会变成注入正文里的 `[Wake …]`。判定顺序（顺序本身就是设计，改之前先读注释）：

1. 私聊 → `private`
2. 群聊且处于睡眠窗口 → 只放行 @ 或引用机器人，其余一律不投（省 token）
3. **@ / 引用优先于 `anyMessage`** —— 这条是 2026-09-19 的修复：`anyMessage` 排在前面时，"@" 会被标成 `anyMessage`，而免打扰时段只放行"真实触发"，于是群里 @ 它却没反应
4. `nameMention`（点名）、`keyword:<词>`（短英文/数字关键词用词边界匹配，避免 `ADS`/`BDSM` 误触发）、`question`（`isDirectedAtAi`）、`topic`（AI/技术话题接话，正则 `TOPIC_WAKE_RE`）、`speaker:<昵称>`、`probability`

### 3.3 唤醒调度与投递

| 环节 | 文件 | 说明 |
| --- | --- | --- |
| 唤醒调度统一入口 | `core/social-state.js` 的 `scheduleWake(key, reason)`，`social-state.js:854` | 合并窗、免打扰、忙碌分流、轮换判定都在这条路上 |
| 投递看门狗 | `social-state.js` 的 `startDeliveryWatchdog()`，`social-state.js:1052` | 间隔 20 秒扫一次；`WATCHDOG_DEFAULT_OVERDUE_MS = 25000`，重试下限 `WATCHDOG_DEFAULT_MIN_RETRY_MS = 60000`（`social-state.js:1000-1002`）。判据是 `_wakeIntendedSeq`（**桥打算交付**的最高 seq）而不是"有没有被回复"——模型看到后选择不回是它的自由，但**没看到**必须被兜住 |
| 提示词组装 | `wake-send.js` 的 `buildWakePrompt(key, reason)`，`wake-send.js:400` | 见 3.4 |
| 投递执行 | `core/prompt-deliver.js` 的 `deliverPrompt` → `deliverPromptNow`，`prompt-deliver.js:107` | 过 `ensureSession()` 拿 sessionId，30 秒超时；超时/失败 → `quarantineSession()` 隔离该会话 |
| DSH 调用 | `prompt-deliver.js:158` | `api.sessions.prompt({ sessionId, mode: 'steer', content })` |
| 事件泵 | `core/mux.js` 的 `pumpMux()`，`mux.js:745` | `api.events.mux()` 逐帧处理 `session/event` |

**为什么投递只用 `mode:'steer'`、永远不用 `queue`**（`prompt-deliver.js:137-157` 的完整论证）：

- `queue` → `agent.followup()` → 进 inbox 的 **next-turn** 队列；`next-turn` 只在回合循环的**下一次迭代**被 claim。只要当前回合永不结束（模型挂着长轮询、或被重启打断后僵在 running），这条消息就**永久停在 next-turn 里**——模型看不到，桥也收不到任何事件。
- `steer` → `agent.steer()` → 进 **next-step** 队列；`inbox.claim()` 总是先把 `next-step` 全部取走。回合在跑 → 本回合的下一个 step 边界就交给模型；agent 空闲 → 第一时刻开回合并领走。
- 结论：**steer 是全定义的**，无论忙闲都必定被取走，不可能被搁浅。定调是"**不静默 > 不注入**"。

投递队列（`prompt-deliver.js:17` 起）：`QUEUE_MAX = 50`，同 key 去重，退避 `min(3000·2^(n-1), 60000)`，连续失败 5 次后降到 60 秒一次。DSH 未就绪时消息**入队不丢**，就绪后按序补投（`flushQueue`）。

### 3.4 注入正文长什么样

唤醒正文只携带**数据行**，"该怎么做"全部在预设的系统提示词里（`[WAKE TYPES]`）。正文骨架由 `buildWakePrompt` 拼（`wake-send.js:400-550`）：

| 行 | 含义 | 位置 |
| --- | --- | --- |
| `[Token] <令牌>` | 本会话当前有效令牌（发送类工具要它） | `wake-send.js:415` |
| `[Session] <key>` | **确切的会话键**，工具层"永不猜 key"，缺 key 就指回这一行 | `wake-send.js:344`、`415` |
| `[Style] …` | 每轮一句语感提醒，文案走 `config.json` 的 `prompt.styleLine`（默认 `[Style] 说人话：短、有态度，别讲课别列举`） | `wake-send.js:360-374` |
| `[OWNER]` / `[NOT-OWNER]` | 主人私聊带前者；**非主人的私聊**显式写后者（修"认主认错人"） | `wake-send.js:404-411` |
| `[Now]` / `[Status]` | 北京时间（带 `epochMs`）与 `N unread; waiting on …; last from …; said Nmin ago` | `wake-send.js:484-485` |
| `[Wake]` / `[WakeRef]` | 当前模式、时长、触发器，以及**主人配置的插话概率 / 当前生效值 / 来源** | `wake-send.js:326-336`、`496` |
| `[Recall]` / `[Profile]` / 联系人行 | 长期记忆摘要（永久层，约 700 字符上限、14 条）、会话对象档案 | `wake-send.js:436-454` |
| `[Unread n]` / `[Mid-turn]` / `[Note]` | 未读与在途块 | 见第 4 节 |
| `[PERSONA]` / `[SPEECH RULES]` | **只在需要时**注入 | 见下 |

人设与发言规则已经由 `lib/preset-compose.js` 合成进**系统提示词**，所以唤醒正文默认不再重复塞一份。判据（`shouldInjectPersonaBlock`，`wake-send.js:298`）：preset 里那份**是当前版本**（`getComposedPersonaStamp() === runtimeOverrideStamp()`）且这个会话没有"需要补注入"标记 → 不注入；否则注入一次。

- 文件上限：`persona.md` 16000 字符、`speech-rules.md` 12000 字符（`wake-send.js:240`）
- 超限时**保头 + 保尾**（尾部 2500 字符必留），并把"砍掉了第几到第几个字符"写进日志（`wake-send.js:260-271`）。旧实现只保头、整段丢尾——这是"往文件末尾追加规则等于白写"的机制原因
- 改文件 → `watchOverrideFiles()`（`lib/preset-compose.js`，由 `bridge.js:288` 装上）立刻重新合成进预设；正在跑的老会话靠 `markStalePersonaReinjects()` 在启动时打一次补注入标记

### 3.5 出站：回合结束 → QQ

事件泵里 `collector.push(frame.event)` 返回 `ended` 时回合收尾（`mux.js:909-1084`），要点：

- **已回复账本**：本回合"负责"的消息 = 唤醒时展示的（`turnSeenUnread`）+ 中途 steer 进来的（`turnSteeredSeqs`）。只算前半截会造成致命循环——steer 进来的 seq 永远进不了 `answeredMessageIds` → 下一轮又被当新消息 → 重复回复。
- 账本要从 `recentMessages` 里找，**不能遍历 `unread`**：模型在回合内调 `mark_read` 时就已经把"展示过的"未读摘掉了。
- 回合结束清空 `turnSeenUnread` / `turnSteeredSeqs` / `_steerDeferredSeqs`。
- **无行动兜底**：连续 `social.wake.noActionLimit`（默认 3）次唤醒既没发消息也没 `mark_read` / `set_wake_config` → `softResetWakeConfig()`。
- **防遗忘提醒**：`pendingWakeKeys` 里的会话若没更新唤醒配置，发提醒，最多 `maxWakeConfigReminders`（默认 2）次，之后软重置。
- **暂存唤醒合并补发**：忙的时候暂存的唤醒原因**合并成一次**最高优先级唤醒投出去，避免"补发 → 又忙 → 再积压"的连环唤醒。

发送链本身在 `core/send-chain.js`（`enqueueSend` / `currentSendChain`）、`core/qq-send.js`（`onebotSend`，所有模型正文的唯一出口）、`core/send-idempotency.js`（幂等闸门，防 `/reset` 之后重复回一次）、`lib/onebot-delivery.js`（分段与节奏）、`lib/send-gaps.js`（`computeGaps` / `clampGap`）。

---

## 4. 唤醒 / 在途注入 / 回合保持

这三套机器是同一个问题的三个层次：**消息到了，怎么让它尽快、尽量少花钱地进到模型手里。** 主实现在 `core/wake-send.js`、`core/turn-hold.js`、`plugins/dsh-qq-hold/`。

### 4.1 回合保持的原理（为什么能"不另起一轮"）

依据 DSH 源码（`dsh-agent-loop/lib/index.js:564-572`，写进 `turn-hold.js:4-14`）：一个模型步跑完、没有活着的工具调用、`next-step` 为空时回合**会**关；但关之前会 `await` 一次 `agent/turn-stopping` 插件钩子，并在钩子返回后**重新检查** `next-step`。

所以：

- 只要钩子里肯等，桥就能趁这段时间把新消息 steer 进 `next-step` → 回合不关，直接跑下一步。
- 对照 `mode:'queue'`：投的是 `next-turn`，**必然多出一整轮**（含整包 prompt 重发）。

分工：**插件只当时序闸门**（`dsh-qq-hold` 提供 `POST /api/qq/turn-hold`，由 `core/console-server.js:1667` 接），**桥负责 steer**（`steerIntoRunningTurn`）。

### 4.2 分段持有

单个 HTTP 请求挂不了太久（undici/fetch 的 `headersTimeout` 默认 300 秒），长持有会被 HTTP 层截断。所以：

- 桥每次只持有 `requestBudgetMs`（默认 55 秒，硬上限 120 秒，`turn-hold.js:137`）
- 这一段没等来消息就返回 `{ close: false, again: true }`，**插件收到后立刻再发一次请求**

对 DSH 而言钩子一直在等待，回合一直不关；对 HTTP 而言每个请求都很短，不碰任何超时。

### 4.3 保持循环的几个旋钮与不变量（`turn-hold.js` 的 `holdLoop`）

| 参数 | 默认 | 位置 |
| --- | --- | --- |
| `maxExchanges` | 24 | `turn-hold.js:133` |
| `idleCloseMs` | 30 分钟 | `turn-hold.js:134` |
| `maxWaitMs` | 60 分钟（不短于 `idleCloseMs`） | `turn-hold.js:135` |
| `requestBudgetMs` | 55 秒，夹在 `[3000, 120000]` | `turn-hold.js:137` |
| 轮询 `POLL_MS` | 200 ms | `turn-hold.js:44` |
| 看门狗续期 `RENEW_MS` | 5000 ms | `turn-hold.js:47` |
| 打字挡住时的退避 | `min(1500, 200·2^(n-1))` | `turn-hold.js:226` |

团队守住的不变量：

1. **默认关闭**：`cfg.social.turnHold.enabled !== true` → 立刻放行，行为与加这个功能之前完全一致
2. **灰度**：`keys` 非空时只对白名单生效；`privateOnly`（默认 true）只做私聊
3. **绝不在这里标读**：steer 不碰 `unread`，只有模型真发出回复后回合结束的 mux 钩子才清。DSH 的 `cancel()` 会 `inbox.clear()`，塞进去没被领会的会在中断时消失——靠 `unread` 兜底
4. **同一会话单飞**：`activeHolds` 保证一处持有，防双重 steer → 重复注入
5. **轮换阈值到了就不再保持**：`holdLoop` 每轮调 `rotationDue()`，到点 `finish('rotate-threshold')` 主动放行关回合（`turn-hold.js:181-186`）。
   - 这条是 2026-09-19 的修复：`noteExchange()` 每记一次来回就给 `rotateTurns` +1，但轮换判定过去只存在于"**会话不忙**"那条路上——而保持循环恰恰让会话一直是忙的，于是计数涨过阈值却没人在看（线上实测 `rotateTurns=20` / 阈值 15，一条 `[rotate]` 日志都没有）
6. **每个提前返回都留日志**——这个功能吃过四次"静默失败"的亏

### 4.4 "一个模型步 = 一个 `[Mid-turn]` 块"（合并注入）

机理（`wake-send.js:631-658` 有一段完整推导）：

- 每次 steer 都是 inbox 里**独立的一条** `next-step` 消息（`dsh-agent-loop/lib/index.js:399-401`）
- `inbox.claim()` 在**下一个 step 的开端**把 `next-step` **一次全取走**（`dsh-agent/lib/index.js:56-61`）
- ⇒ 同一个 step 里注入 N 次，模型在同一次思考里看到 **N 个独立的 `[Mid-turn]` 块**，只能一块一块顺序处理
- 关键推论：**同一个 step 边界本来就只能带走一批**。所以"把这一步里到达的消息攒起来、在步边界一次性注入"的**送达时刻与"消息一到就立刻注入"完全相同**，但模型只看到一个块、只发一条气泡——白拿的合并

实现上有两道闸门 + 两个发车点：

| 机制 | 常量 / 函数 | 说明 |
| --- | --- | --- |
| 收集窗 | `STEER_COLLECT_MS = 1000`、`STEER_COLLECT_MAX_MS = 3000` | 真要注入时先等"这口气说完" |
| 周期闸 | `STEER_CYCLE_MS = 5000`（保持托管）、`STEER_CYCLE_SHORT_MS = 1500`（非保持） | 同一个模型步周期内只注入一次 |
| 特例：模型还在生成、本回合一条气泡都没发出去 | `midTurnSteerGate({ noReplyYet })` | **不攒批**，直接即时注入。攒批在这里没有合并价值，却把送达时刻押在"步边界一定会来"上（线上撞过一次 28 秒没来步边界、靠 20 秒兜底才投出去） |
| 防饥饿兜底 | `STEER_PENDING_MAX_MS = 20000` | 攒这么久还没等到任何步边界 → 兜底即时注入，绝不静默卡住 |
| 发车点 1 | `turn-hold.js` 的 `holdLoop`（在 `agent/turn-stopping` 钩子里） | |
| 发车点 2 | `turn-hold.js` 的 `flushStepBatch()`（`mux.js:896-899` 收到 `step/end` 调） | 保持循环只在 `turnEnds && nextStep.length === 0` 时才被 await，**模型连调几个工具的那种步走不到钩子**；`step/end` 每一步都有 |

### 4.5 `steerIntoRunningTurn` 的判据与"三种语义"教训（`wake-send.js:795`）

允许 steer 的三种情形：

1. `forced`：turn-hold 的保持循环（调用点就在 `turn-stopping` 钩子里，确定有回合在跑）
2. `social.steerEnabled === true`：全局开关（**默认开**，只有显式写 `false` 才关）
3. **turn-hold 灰度内的会话 + 有"回合真的在跑"的证据**

核心硬守卫是第 3 条的证据来源：

```
runningTurn = agentRunningSessions.has(sessionId)   // DSH 权威状态
           || TurnStartAt.has(sessionId)            // 桥观测：turn/start 置位、turn/end 清除
           || collectors.has(sessionId)             // 桥观测
```

- `host/session-status` 那个权威帧**没有进桥的事件流**（计数 0，那批 `host/*` 帧走的是 Web UI 的 host 流），所以只能回退到桥自己观测的回合边界（`wake-send.js:830-835`）
- 没有 `runningTurn` 就**只记账、不投**，留一行"只能留到下一轮（原因：…）"的日志，消息**留在 unread 里**

**一个 boolean 承担不了三种语义**——这是本项目反复踩到的坑：

| 返回值 | 真实含义 |
| --- | --- |
| `true` | 真塞进去了 · 本回合**已经给过它**（唤醒正文展示过 / 刚 steer 过）· **被周期闸攒住了**（其实什么都没投） |
| `'typing-defer'` | 对方还在打字，这批继续攒（明确信号，不能返回 `false`） |
| `false` | 真失败 / 回合没在跑 |

- "已经给过"必须返回 `true`：曾经返回 `false`，调用方读成"没送成"→ 落回完整唤醒流程 → 又投一条完整唤醒进同一个回合 → 模型看到同一批未读两遍 → **QQ 上真的重复回了一次**
- "被周期闸攒住"这个 `true` **什么都没投**，如果照旧返回 `close: false`，DSH 会看到 `next-step` 为空而直接把回合关掉，表现成"保持悄悄结束了"。所以 `holdLoop` 与 `flushStepBatch` 记这一笔之前**必须验证真的落地了**——判据是 `collectMidTurnBatch(st)` 返回空（这批 seq 已不在待交付批里）。没落地就继续持有 + 重试，**绝不谎报成功**

### 4.6 打字状态等待（不抢话）

`core/typing-hold.js` 的 `midTurnSteerGate` / `midTurnSteerText`，配置在 `social.typing`：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | true | 总开关 |
| `holdMaxMs` | 12000 | 最多等这么久（到点就插话，避免遇到"打字没完"的人一直不回复） |
| `refreshOnMessageMs` | 5000 | QQ 输入事件不可靠，收到一条消息就把"对方在打字"再续这么多毫秒 |
| `breakProbability` | 0.15 | 每次唤醒的插话概率（0 = 只等他停，1 = 从不等待） |

三条路径（`wake-send.js:943-947` 有明确取舍）：

1. 模型还在生成、本回合一条都没发出去 → **注入当前轮，不等**
2. 本回合已经发过气泡 + 对方确实在连发 → **短暂延迟后注入**（≤ `STEER_IN_TURN_DEFER_MAX_MS`），并排一次 `scheduleInTurnRedeliver`（最多 3 次，`wake-send.js:727`），打字窗一结束就投
3. 没有正在跑的回合 / 注入通道失败 → **只能留到下一轮**（由 `runningTurn` 守卫与补投失败分支各打一行日志）

> ⚠️ 一个已修复的接线错误值得记住：`midTurnSteerGate` 读的是 `cfg.social.typing`，而调用点曾经传的是 `cfgRef?.social?.typing` —— 于是 `typingCfg` 拿到 `undefined`，一路回落到 `TYPING_DEFAULTS`，**管理端配的 `social.typing.*` 在在途注入这条路线上从来没生效过**（`wake-send.js:955-958`）。

### 4.7 看门狗、卡死与恢复（`core/turn-guard.js`）

| 机制 | 常量 | 说明 |
| --- | --- | --- |
| 静默判卡死 | `TURN_TIMEOUT_MS = 180000` | **完全静默** 180 秒（无任何 turn/tool/流式事件）才判定卡死 |
| 回合总时长 | `TURN_TOTAL_TIMEOUT_MS = 360000` | 6 分钟仍未结束（疑似模型无限重复输出）→ 强制隔离 |
| 长等待 | `LONG_WAIT_TURN_TIMEOUT_MS = 11 分钟` | `touchTurnGuardsByKey()` 用于 `qq_wait_for_messages` / 回合保持这类"合法的长时间无事件" |
| 隔离 | `quarantineSession(key, sessionId)` | 投递超时/卡死时用 |
| 启动时的唤醒租约 | `armPendingWakeLease` / `disarmPendingWakeLease` | |

回合保持会**每 5 秒续期看门狗**（`turn-hold.js:47` `RENEW_MS`），否则吊住回合期间没有任何事件，计时器会一直往前走而被误判卡死。

另外两条恢复路径在 `wake-send.js` / `social-state.js`：

- `loopRecovery`：有未读却长时间无动作时拉回
- `timeoutRecovery`：回合卡死时收尾

---

## 5. 工具面

### 5.1 三组 MCP server

由 `lib/dsh-side.js` 的 `mcpBlock()`（`dsh-side.js:249`）写进隔离 DSH profile 的 `cordis.patch.yml`：

| MCP server id | serverName | 脚本 | 内容 |
| --- | --- | --- | --- |
| `mcp-napcat` | `napcat` | `qq-bridge/src/mcp-napcat-safe.js` | QQ 与 NapCat 能力（主体） |
| `mcp-napcat-host` | `napcat-host` | `qq-bridge/src/mcp-host-server.js` | `qq_learning_corpus`、`qq_learning_submit`、`napcat_status`，进程控制在显式开启前不注册 |
| `mcp-web-search-safe` | `web-search-safe` | `qq-bridge/src/mcp-web-search-safe.js` | `web_search`、`web_fetch` |

静态统计（按源码数）：

| 文件 | `registerTool(` / `server.tool(` 出现次数 |
| --- | --- |
| `mcp-napcat-safe.js` | 90（其中若干受 `cfg.social.tools.*` 开关包裹，运行时可能不注册） |
| `mcp-host-server.js` | 5（`start_napcat` / `stop_napcat` 只在 `napcat.allowProcessControl === true` 时才注册，见 `mcp-host-server.js:259`） |
| `mcp-web-search-safe.js` | 2 |

`mcp-napcat-safe.js` 的注册函数把每个工具的 JSON 尺寸记进账本，注册完写 `state/tool-schema-stats.json` 并打到 stderr（`mcp-napcat-safe.js:761`）。实测快照：`totalChars = 87199`、`available = 90`、`approxTokensPerStep = 24014`。

> ⚠️ 现有 README 的"MCP 工具"一节写的是"96 个工具 / `mcp-napcat-safe.js` 89 个"，与源码计数（90）和统计文件（`available: 90`）不一致。本文以**代码计数与 `state/tool-schema-stats.json` 为准**；那处 README 数字在本轮文档整理中未改动（本次只允许改五份文件）。

`mcp-host-server.js` 与 MCP 客户端的约定写在文件头注释里：它由 DSH 的 MCP 客户端 spawn。`qq_learning_submit` **故意不放在 napcat 组**：学习会话只加载 `mcp__napcat-host__` 那一组，写成 `mcp__napcat__qq_learning_submit` 会直接 unknown tool。

### 5.2 MCP 压缩代理（开源 mcp-compressor）

配置在 `config.json` 的 `social.toolCompressor`，装配在 `lib/dsh-side.js:171-296`：

- 默认**恒开**（`tc.enabled !== false`），只有显式 `enabled: false` 才回到直连
- 它是个**代理进程**：DSH 不再直连 `mcp-napcat`，而是连它；它把工具压成两个包装工具（`<server>_invoke_tool` / `<server>_get_tool_schema`），工具清单塞进包装工具的描述里
- 档位语义：`low`（去冗余）/ `medium`（每条描述只留第一句）/ `high`（完全不发描述）/ `max`（连工具清单都不发，改用包装工具）
- **只挂在 `mcp-napcat` 这一路**（工具最多、体积最大），另两组保持直连
- 必须有 fallback：压缩机没装 / 起不来时**绝不能把工具表搞没**（那等于机器人失能），所以先做一次廉价探测，探不到就直连并把原因写进日志（`dsh-side.js:179-181`、`221-247`）

桥侧的配套：`core/mux.js` 的 `unwrapCompressedToolName(name, rawArgs)`（`mux.js:127`）把包装工具还原成**后端真实工具名**。代理模式下，`invoke_tool` 的真实目标藏在 `args.tool_name` 里，而桥下面一整段逻辑（发送类判定、漏引号兜底、幂等账本、抽签登记、回合收尾，49 处）全是按真实工具名判断的——不解包就等于全部失灵（`mux.js:802-811`）。

实测（`dsh-side.js:174-176`，挂真实的 90 个工具跑）：`low 38.8% · medium 14.0% · high 6.2% · max 3.6%`（相对完整工具表）。**代理在实际窗口里没有带来额外往返**——同一段窗口里 `napcat_get_tool_schema` 的调用次数为 0。

细节与成本 → [COMPACTION-MATH.md](COMPACTION-MATH.md#72-mcp-压缩代理开源-mcp-compressor)。

### 5.3 工具裁剪档位与描述压缩档

- **裁剪档位**：`lib/tool-tiers.js` 的 `TOOL_TIERS`，配置键 `social.slimTools`。语义是**白名单**——不在名单里的工具**根本不注册**（描述才不会进请求体）。
  - 档位：`off`（默认）/ `low`（drop 名单，其余保留）/ `medium` / `high` / `extreme` / `custom`
  - `ESSENTIAL`（协议必需，任何档位都留）：`qq_send_message`、`qq_reply`、`qq_mark_read`、`qq_set_wake_config`、`qq_get_prompt`、`qq_social_state`、`qq_get_unread_messages`、`qq_wait_for_messages`、`qq_list_groups`、`qq_status`
  - `OBSERVED_USED`：按**服务器真实调用日志**（`state/tool-calls.jsonl`，1108 次调用）挑出的"实测被调用过"的工具，切档绝不能砍掉
  - `qq_status` 永远保留（198 字符）
  - 选了具体档位时 **`allow` / `deny` 两张手写表一律忽略**：线上的 `deny` 老名单与档位白名单会自相矛盾，失手砍掉的正是模型在用的工具，且极难发现（`tool-tiers.js:144-148`）
- **描述压缩档**：`lib/tool-schema-compress.js` 的 `SCHEMA_LEVELS = ['off','medium','high']`，配置键 `social.slimTools.schemaLevel`。它照搬 mcp-compressor 的档位语义，但**压的是描述文字**，工具一个不少、参数名/类型/枚举/必填全都照旧。
  - 特意**不提供** mcp-compressor 的 `low`：实测压完反而比不压还大 2.6%（重建 union 容器会把描述搬进每个分支）
  - 实测（90 个工具，真实 wire 格式）：`off 89,603 字符` / `medium 61,587 字符 ≈ 68.7%` / `high 27,109 字符 ≈ 30.2%`
  - 重建容器后**必须把容器自己那条描述补回去**（`withOwnDesc`）：否则 `z.union([...]).optional().describe('Group id')` 这类参数描述会凭空消失（`tool-schema-compress.js:72-81`）
  - `social.slimTools` 在**注册期**排除工具，能真正减少请求体积；`social.tools.*` 只在**调用期**拒绝，不减少体积

### 5.4 工具名归一化

`bareToolName()`（`mcp-napcat-safe.js:650` 附近、`tool-tiers.js:130`）去掉 `mcp__server__` 前缀。名单里写 `mcp__napcat__qq_x` 与写 `qq_x` 等价——少了这一步，精简名单会整体不命中。

---

## 6. 记忆层

单文件 SQLite：`qq-bridge/state/memory.db`，模块 `core/memory.js`（`memDb` 为模块级单例）。

### 6.1 表

| 表 | 内容 |
| --- | --- |
| `profiles` | 每个 QQ 一份结构化档案：`uid / name / personality / likes / dislikes / birthday / notes / updated_at`（`memory.js:40-49`） |
| `memory_entries` | 通用记忆条目：`uid / category / content / created_at`，v1.3.0 起补列 `pinned / importance / last_used_at / hits / expires_at / conv_key / tags / source / tier / updated_at`（`memory.js:50-56`、`134-151`） |
| `chat_messages` | 完整聊天记录（桥自动写入、不经过大模型）：`conv_key / msg_seq / message_id / sender_uid / sender_name / is_self / direction / kind / content / quote_target / media / ts / ts_ms`，后续补列 `qq_seq / read_at / recalled_at`（`memory.js:60-84`） |
| `memory_meta` | 一行 KV，存索引结构版本（`memory.js:154`） |
| `mem_entries_fts` / `chat_messages_fts` | FTS5 外部内容表（见下） |

索引：`idx_mem_uid`、`idx_chat_conv_ts`、`idx_chat_ts`、`idx_chat_sender`、`idx_chat_conv_content`、`idx_chat_msgid`（**部分唯一索引**，`WHERE message_id != ''`，防 WS 重投/双路径并发双写）、`idx_mem_tier`、`idx_mem_conv`、`idx_mem_expire`。

> 建部分唯一索引前必须**先清掉存量重复行**（每组保留 `id` 最小一行），否则建索引会失败（`memory.js:85-101`）。

### 6.2 三层记忆（v1.3.0）

| tier | 默认存活 | 归属判据 |
| --- | --- | --- |
| `permanent` | 0（永不过期） | `pinned = 1` 或 `category ∈ {rule, owner, identity}` |
| `durable` | 90 天不活跃淡出 | 默认层（`expires_at` 可显式指定） |
| `working` | 7 天淡出 | 显式 `working=true` 或 `importance` 很低的临时条目 |

常量：`MEMORY_TIERS = { permanent: 0, durable: 90d, working: 7d }`、`PERMANENT_CATEGORIES = Set(['rule','owner','identity'])`（`memory.js:117-119`）。

### 6.3 检索：FTS5 trigram

```
CREATE VIRTUAL TABLE IF NOT EXISTS <name> USING fts5(
  content, tokenize='trigram', content='<源表>', content_rowid='id'
)
```

（`memory.js:172`）

- **trigram** 对中文是"三字滑窗"，中文子串照样命中，**不需要分词器**
- BM25 天然给出相关性排序
- `content='表名'` 是外部内容表，靠触发器同步；索引与触发器全部在 SQLite 内部完成（C 实现），桥侧只多一次 INSERT 的开销
- 结构一变就把 `FTS_SCHEMA_VERSION` +1 → 下次启动自动重建（幂等），当前版本 `'2'`（`memory.js:120`）

改动动机（`memory.js:4-23` 的三条结论）：原来只有 `content LIKE '%词%'` 全表扫 —— 检索慢且不准（查不着时模型会说"我看不到更早的消息"，是最贵的一种失败）、没有轻重、没有"永久"这个概念。

**成本纪律**：注入给模型的是**几百字符的摘要**（`[Recall]` 行，`limit: 14, maxChars: 700`，`wake-send.js:446`），不是把历史塞回上下文。省钱靠"按需检索"，不是"全都记住"。摘要放在唤醒正文这个"每轮本来就新"的位置，而不是系统提示词里——系统提示词一变就会让**整段前缀缓存失效**（那一步全价重读几万 token）。

---

## 7. 状态文件

桥的数据都在 `qq-bridge/state/`（路径常量集中在 `src/lib/paths.js`）。关键文件：

| 文件 | 谁写 | 内容 |
| --- | --- | --- |
| `sessions.json` | `core/config.js`（`saveState`） | QQ 会话键 ↔ DSH sessionId 映射。启动时会**剔掉指向磁盘上已不存在会话的映射**（`bridge.js:486-503`），否则事件泵每秒重开一次死会话的 `session/follow` |
| `bridge.lock` | `core/runtime.js`（`acquireLock` / `releaseLock`） | 单实例锁 |
| `social-state.json` | `core/social-state.js`（`saveSocialState`） | 每个会话的社交状态：未读、最近消息、唤醒配置、账本（`answeredMessageIds` / `lastDeliveredSeq` / `_wakeIntendedSeq` / `lastUnreadSeq`）、`rotateTurns`、回合保持计数 |
| `current-role.json` | `lib/role-access.js` | 当前角色与模式（`role` / `mode`） |
| `slang.json`、`slang-session.json` | `core/slang.js` | 黑话词条与学习会话 |
| `stickers.json` | `core/sticker.js` | 收藏表情库、备注与使用计数 |
| `memory.db` | `core/memory.js` | 记忆库（唯一 SQLite） |
| `token-usage.jsonl` | `core/token-meter.js` | 每次请求的用量行（计价与统计分析的数据源） |
| `tool-calls.jsonl` | `core/audit.js`（`appendToolLog`） | 工具调用/结果流水，`tool-tiers.js` 的档位名单就是从它统计出来的 |
| `tool-schema-stats.json` | `mcp-napcat-safe.js` | 工具 schema 体积实测快照 |
| `feedback.json` | `core/audit.js` | `qq_report_feedback` 的反馈条目 |
| `qq-activity.log` | `lib/log.js`（`appendActivity`） | 会话活动流水 |
| `bridge.log` | `lib/log.js`（`log`） | 桥主日志 |
| `crosschat.json` | `core/crosschat.js` | 跨会话留言信箱 |
| `scheduled-tasks.json` | `core/scheduler.js` | 定时消息任务 |
| `activity-windows.json` | `core/activity.js` | 活跃时段 |
| `docx-quota.json` | `core/docx.js` | Word 文档每日额度 |
| `learning-config.json`、`learning-token` | 学习子系统 | 学习计划与学习会话令牌（`core/learning-token.js` 的 `ensureLearningToken()` 在启动时就建，避免"模型拿着令牌来提交"和"桥还没建过令牌"的时序打架） |
| `dsh-seq.json` | `lib/dsh-side`/`dsh-client`（`bridge.js:463-466`） | 每会话已处理的最高事件 `seq`。**不可省**：桥一重启就丢水位，`follow` 快照会把整段历史重放一遍，而重放帧与实时帧同形、`pumpMux` 分不出来 |
| `sticker-tmp/`、`doc-tmp/`、`qzone-img-tmp/`、`image-tmp/` | 各媒体模块 | 临时媒体目录，启动时各自扫一次旧文件 |
| `voice-config.json`、`voice-voices.json`、`voice-cache/` | `core/voice.js` | 语音配置、自定义音色、合成缓存 |

隔离 DSH 侧（不是桥的）：`<DSH_HOME>/sessions/`（会话日志）、`<DSH_HOME>/storages/session_projcache/sessions`（用量对账读它）、`<DSH_HOME>/cordis.patch.yml`、`<DSH_HOME>/profiles/<profile>/cordis.patch.yml`、`<DSH_HOME>/.credentials.yaml`。

---

## 8. 隔离 DSH 的装配

### 8.1 端自安装

`bridge.js:274-309` 启动时异步（幂等、非阻塞）做三件事：

1. `installPresets(target)` —— **每次启动都刷新**。preset 是桥自带的代码资产（persona / `[WAKE TYPES]` / `[RULES]`），不是主人数据；旧逻辑"装过一次就靠 marker 全跳过"，导致改了 `agent.cordis.yml` 后重启桥根本不会把新 preset 装进去
2. `watchOverrideFiles()` —— 盯 `persona.md` / `speech-rules.md`，一改就重新合成进已安装的 preset
3. `ensureBuiltinPlugins(target)` —— **每次启动都幂等装配一遍**（link + profile 注册 + settings 的 memory 段）。不能只在被 marker 挡住的 `installToIsolatedDsh()` 里做，否则老安装永远升不上来

DSH home 的解析顺序（`core/tunables.js:123-138` 的 `resolveIsolatedDshHome`）：环境变量 `QQB_DSH_HOME` → `DSH_ISOLATED_HOME` → 管理器配置里的隔离 home（`~/.qq-bridge-manager/dsh-isolated-home-official`，其次 `dsh-isolated-home`）。

> 历史坑：这里原来**写死** `~/.qq-bridge-manager/dsh-isolated-home`，而管理器实际启用的是 `…-official`，于是"管理端改的模型配置到不了 DSH 里"（`tunables.js:117-118`）。

### 8.2 两份 cordis.patch.yml

| 文件 | 内容 | 谁维护 |
| --- | --- | --- |
| `<home>/profiles/<profile>/cordis.patch.yml` | agent-presets overlay + 三组 MCP server（含压缩代理参数） | `lib/dsh-side.js` 的 `patchProfileCordis()`（`dsh-side.js:299`） |
| `<home>/cordis.patch.yml`（home 级） | 上下文压缩 / 工具结果剪枝策略 | `lib/dsh-compaction.js` 的 `syncDshCompactionPatch()`（`dsh-compaction.js:198`） |

配置层顺序是 bundles → profile 的 `cordis.patch.yml` → **home 级 `cordis.patch.yml`** → `--patch`；写 home 级不会碰到装着 MCP 挂载的 profile 那份。profile 的 `patchReload: live` 会同时监视 home 级 patch 文件 → **改完不必重启 DSH**。

home 级那份用 `# === qq-bridge compaction BEGIN/END ===` 标记包起来，只替换标记之间那段，用户自己的 overlay 原样保留。

### 8.3 桥不能自己改 DSH 的历史（四条依据）

写进 `lib/dsh-compaction.js:4-9`，读过 DSH 0.1.2-rc.1 源码得出：

1. `dsh-session`：模型历史由内存日志 `deriveMessages()` 派生，文件只在冷恢复时读 —— 改文件对运行中的会话零影响
2. `dsh-session-persistence-jsonl`：日志是 seq 连续的仅追加记录，删行会撞 `corrupt session log: seq gap`；默认 zstd 帧带校验和，正文一改就校验失败
3. 它自己也写明"每个会话一个活动写入方"，外部同时写会互相踩
4. 受支持的裁剪路径只有一条：**由 DSH 自己**通过 surface `replace` 改写历史 —— 也就是 `dsh-compaction-tool-result-pruner`（剪枝）与 `dsh-compaction-basic`（摘要）

两个必须守住的硬约束（否则插件拒绝加载、DSH 起不来）：

- `compaction-basic`：`retainRatio` 必须**小于** `thresholdRatio` 解析出的阈值
- `tool-result-pruner`：`headChars + 标记 + tailChars ≤ thresholdChars`（标记是 `"\n\n[... tool result middle pruned ...]\n\n"`，与 DSH 里的 `PRUNE_MARKER` 逐字一致）

`normalizeCompaction()` 保证这两条永远成立，被夹紧时写日志说明。

**第三个坑（真机复现）**：web profile 下这两行默认是 `disabled: true`（归 host plane 所有），所以即使配置写得再对，自动压缩也一次都不跑 —— 本机隔离 home 的 86 个会话日志里 `compaction/*` 事件 0 条。`buildCompactionRows()` 因此必须显式写 `disabled: false`（`dsh-compaction.js:112-123`）。

### 8.4 三个内置插件

| 插件 | 作用 |
| --- | --- |
| `dsh-qq-hold` | 提供 `agent/turn-stopping` 钩子的时序闸门，暴露 `POST /api/qq/turn-hold`（`core/console-server.js:1667` 接它） |
| `qq-mode-console` | 模式控制台 |
| `dsh-memory` | 长期记忆插件的 `remember` / `recall` 工具（`plugins/dsh-memory/lib/src/index.js:1093`、`1148`）。随包 vendored |

`plugins/*` 通过**符号链接**接进 DSH：`<home>/plugins/<name>` 与 `<home>/profiles/node_modules/<name>` 都指向 `qq-bridge/plugins/<name>`（`server/deploy.js:869-882` 的克隆脚本就是干这个的）。

---

## 9. 部署路径

### 9.1 本地（Windows）

- 运行时根目录 = `server/index.js` 的**上两级目录**（`RUNTIME_ROOT`），与 `cwd` 无关。原来有 9 处用 `process.cwd()`，用户从资源管理器双击或走计划任务时 cwd 会变成 `C:\Windows\System32`，于是 dsh / qq-bridge / dist / 隔离 home 全部解析错
- 管理端数据：`%USERPROFILE%\.qq-bridge-manager\`
- 隔离 DSH home：`%USERPROFILE%\.qq-bridge-manager\dsh-isolated-home-official`
- 桥：`<运行时>\qq-bridge\`，`config.json` 与 `state/` 都在这一层

### 9.2 线上（Linux）

| 路径 | 内容 |
| --- | --- |
| `/root/qq-bridge` | 桥整棵树（源码、`state/`、`config.json`、`plugins/`、`tools/`） |
| `/root/.dsh` | 隔离 DSH home：`sessions/`、`storages/`、`profiles/web/`、`cordis.patch.yml`、`.credentials.yaml`、`dsh-web.log` |
| `/opt/napcat` | NapCat 应用（原生跑法） |
| `/opt/napcat/config` 或 `/root/napcat/config` | NapCat 配置目录（原生 / 容器两种跑法） |
| `/root/.qqbridge-clone` | 克隆部署的 stage 目录（打包产物 + `napcat-mode` 标记），收尾时删掉 |
| `/root/qqbridge-keep-<TS>` / `/root/qqbridge-prev-<TS>` | 克隆时对目标机原有 `config.json` / `persona.md` / `state/` 的能力保护备份 |

systemd 单元：

| 单元 | 说明 |
| --- | --- |
| `dsh-web.service` | 隔离 DSH，`Environment=DSH_HOME=/root/.dsh`、`EnvironmentFile=-/etc/qq-bridge.env`、stdout/stderr 落 `/root/.dsh/dsh-web.log`（`server/deploy.js:1329-1344`） |
| `napcat.service` | NapCat 原生跑法（源机没有该单元时，部署脚本现场生成，`deploy.js:641`） |
| `dsh-polyfill.service` | 可选；不存在时部署脚本不把它当失败（`deploy.js:1385-1390`） |

NapCat 有**两种跑法**，`deploy.js:504` 的探针是唯一判据：

```bash
if systemctl cat napcat.service >/dev/null 2>&1; then echo native;
elif docker ps -a --filter name=^napcat$ --format "{{.Names}}" | grep -q napcat; then echo docker;
else echo none; fi
```

原生跑法 = 官方 Linux QQ deb + `/opt/napcat` + systemd unit + Xvfb + 非 root 用户 `qq`；容器跑法 = `mlikiowa/napcat-docker:latest`，卷 `napcat-qq:/app/.config/QQ`，端口 `3000/3001/6099`。启停统一走 `napcatCtlCmd()`（systemd 优先，`deploy.js:514-518`），与 `server/index.js` 的控制路径同形状。

**容器联动的一个必配项**：服务器上 NapCat 跑在容器里，看不到宿主路径。`config.json` 要写

```json
"napcat": {
  "imageFileMode": "auto",
  "tmpDir": "/root/napcat/config/moonbot-tmp",
  "dockerPathMap": [{ "host": "/root/napcat/config", "container": "/app/napcat/config" }]
}
```

（`lib/napcat-file.js:16-21`）。不配对时 NapCat 报 `文件处理失败: 识别URL失败, uri= /root/...`，表现是"表情包一张都发不出去"——本机裸机部署时同机能读，所以本地一直正常、一到服务器全灭。克隆脚本会把这几个键自动改对（`deploy.js:806-831`）。

### 9.3 管理端的一键克隆（`server/deploy.js`）

流程（每步写日志，GUI 轮询 `/api/ssh/deploy/status`）：

| 步骤 | 做什么 |
| --- | --- |
| 0 | 校验源/目标都在服务器列表，连两端 |
| 1 | 目标机基础环境探测与安装：nodejs / npm / docker / python3 + 全局 dsh + `mcp-compressor`（pip 装） |
| 2 | 源机**短暂停机**（停 dsh-web / napcat / bridge）→ 本地打包成 `tar.gz` |
| 3 | 源机**立即恢复运行**（总停机 ≈ 打包耗时，与传输带宽无关） |
| 4 | 逐包经 manager **流式转发**到目标机并原地解包（`streamPipe`，不落目标机中间文件） |
| 5 | 目标机：写 systemd 服务 / 建 napcat 容器与卷 / 灌 QQ 登录态 / 启动自检 |
| 6 | 清理源机 stage，断开连接 |

迁了哪些包：`qq-bridge.tar.gz`（排除 `.git`、`node_modules`、`bridge.lock`、`bridge*.log`）、`dsh-home.tar.gz`（`/root/.dsh`）、`napcat-config.tar.gz`、`napcat-app.tar.gz`（`/opt/napcat`，排除 cache/config/db）、`qqdata.tar.gz`（QQ 登录态）、`dsh-polyfill.tar.gz`、`dsh-meme.tar.gz`。

安全说明（`deploy.js:14-15`）：全程只在 manager → 各机之间走 ssh2；目标机不持有源机凭据；密钥/令牌原样随 `.dsh` 与配置目录迁移（与整盘克隆语义一致）。

**能力保护**：解包前把目标机原有的 `config.json` / `persona.md` / `state/` 存到 `/root/qqbridge-keep-<TS>/`，解包后再恢复并核对（`buildDeployKeepScript()`，`deploy.js:334-403`）。旧行为只把 `config.json` / `voice-config.json` 备份到 `/root/qqbridge-prev-<TS>/` 就删库重解包——**从来没有放回去**过。

### 9.4 管理端本身

| 部分 | 位置 |
| --- | --- |
| 前端 | `src/`（React + TS + Vite），构建产物 `dist/`，由后端静态托管 |
| 后端 | `server/index.js`，监听 1921（`QBM_API_PORT` 可覆盖），`QBM_NO_LISTEN=1` 时只导出 app 不监听 |
| 桥控制台 API | `qq-bridge/src/core/console-server.js`（端口 `consolePort`，默认 3100，鉴权 `x-console-token`，令牌文件 `state/console-token`） |

管理端到桥是**代理**关系：`server/index.js` 把 `/api/learning-config`、`/api/slang`、`/api/token-report`、`/api/token-stream` 等转给桥控制台（`callBridgeConsole` / `proxyToBridgeConsole`，`server/index.js:5754`、`6142`、`5901`、`6172`）。桥控制台自己暴露约 150 个端点，覆盖状态、发送、社交配置、记忆、黑话、语音、学习、用量、NapCat 令牌与守护。

---

## 10. 两张"改之前先读"的地图

### 10.1 配置热加载

桥启动时 `const cfg = loadConfig()` 只读一次，而这个对象被 `initXxxCore(cfg)` 注入到十几个模块里。所以：

- **保存配置立即生效**靠 `watchConfigFile()` 的**原地合并**（`applyConfigInPlace`，`core/config.js:447`）：不换对象引用，旧引用继续有效
- `loadConfig` 会补齐全部默认键，因此 `target` 里多出来的键说明用户已从文件删除 → 同步删掉，避免用旧值
- **为什么不能只监听文件**：`fs.watch(file)` 在 Linux 上盯的是**那个 inode**，而管理端保存走的是"临时文件 → 备份 → mv 原子替换"，rename 一覆盖 inode 就换了，监视器从此盯在一个已被 unlink 的旧 inode 上——**之后任何改动都不再触发事件**，直到桥重启。线上实测：07:34 装好监视，07:39:54 管理端 mv 覆盖，此后桥日志里一条 `已热加载` 都没有。
- 现在的双保险：**目录监听**（`fs.watch(dir)`，按文件名过滤，mv 覆盖会给 rename 事件）+ **2 秒轮询兜底**（`fs.watchFile`，跨 inode / 跨文件系统都能发现）
- 桥自己还有 **10 处**会把内存里的旧 cfg 写回 `config.json`（`console-server.js` 5 处 + `mux.js` 4 处 + `tunables.js` 1 处），没做热加载时管理端的改动不但不生效，还会被**回滚**掉

热加载回调里做三件事（`bridge.js:756-790`）：`dsh*` 变化 → `resetVisionModelApplications()`；`social.wake.*` 变化 → `applyOwnerWakeProbabilityToSessions()`；`dshCompaction.*` 变化 → 重写 DSH 的 `cordis.patch.yml`。

### 10.2 会话轮换与永久会话

- 计数落在 `social-state.json` 的 `rotateTurns`（重启不重置）
- 阈值 `social.autoReset.wakeThreshold` 默认 10、下限 5，`rotateThresholdOf()` **每轮现读** cfg（`wake-send.js:92`）
- 判定统一到 `rotationDue(key, st, cfg)`（`wake-send.js:108`），**三个调用点共用**：`wake-send` 的 busy 分支、轮换块、`turn-hold` 的保持循环
- 防卡死：推迟注入最多 `ROTATE_DEFER_MAX_MS = 120000`，超时后 `rotationDue()` 自动改判 `false` —— **宁可晚一点轮换，也绝不把用户的消息扣死**
- `social.autoReset.permanent === true` → 阈值返回 `Infinity`，所有判定写成 `count >= threshold` 天然恒为 false，于是轮换块、busy 分支、保持循环、控制台的 `[Rotate]` 收尾指令**一处不改就自动停用**
- 轮换还有个"预热"：`createStandbySession()`（`core/dsh-session.js:159`）提前建好下一代会话（同工作区 + 同 preset + 视觉模型），不写入映射、不触发投递，首轮提示词已被提供方前缀缓存命中
- `agentPreset` 只在**建会话时**绑定：换 preset 后老会话仍用旧提示词，要等轮换或空闲归档重建（`lib/dsh-compaction.js:293-295` 记录了这条注意事项）

永久会话的完整成本论证见 [COMPACTION-MATH.md](COMPACTION-MATH.md#6-轮换新会话的最优点)。
