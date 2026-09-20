# 更新日志

本文件按主题归纳 MoonBot 的用户可见变化，不逐条罗列提交标题。版本号遵循语义化版本；分组约定为「新增能力 / 修复 / 变更与不兼容 / 内部与工程」。

## 未发布 — 2026-09-20（1.2.2）

### 修复

- **"一句话 1 分钱"：压缩阈值按实测账单又收了一档（0.12 → 0.08）**。上一版把阈值从 0.06 抬到 0.12，解决了"每一步都压缩"，代价是上下文长期停在 ~11.7 万 token，主人实测这个档位**一句话 1 分钱**。把 `state/token-usage.jsonl` 逐条算开（1M 窗口、缓存命中价约为全价 0.1）：花费几乎完全正比于**上下文大小** —— 每次请求真正未复用的只有 1.4k~3.4k token（工具结果剪枝在起作用），大头是 3~12 万 token 的缓存读：

  | 上下文 | 平均未缓存 | 平均缓存读 | 折合每条 |
  | --- | --- | --- | --- |
  | 0~40k | 2,339 | 30,807 | **0.41 分** |
  | 40~70k | 2,568 | 49,894 | 0.56 分 |
  | 70~90k | 3,449 | 75,515 | 0.79 分 |
  | 90~110k | 1,437 | 99,809 | 0.82 分 |
  | 110~140k | 2,894 | 117,573 | **1.04 分** ← 主人看到的"1 分钱" |

  现在缺省 `thresholdRatio = 0.08`、`retainRatio = 0.02`（1M 窗口 ≈ 8.4 万 token 才压缩、最近 2.1 万逐字保留）：上下文稳定在 8 万上下 ≈ **0.7 分/条**，压缩后约 4.9 万、离阈值还有 3.5 万余量，不会退回"压完立刻又压"。下限 `MIN_THRESHOLD_RATIO` 同步钉在 0.08 —— 低于它必被固定开销（system + 78 个工具 ≈ 2.75 万 token）顶穿。
- **唤醒正文以前没有稳定可用的时间行，模型想算"多久之前"只能再花一步**：哨兵轮（绝大多数唤醒走的就是这条路）原先**完全没有时间行**。现在两类正文都带 `[Now]`：首轮是 `[Now] 2026-09-20 周日 19:15 (Beijing, epochMs=1789902923920)`，哨兵轮是 `[Now] 2026-09-20 周日 19:15`（约 30 字符、稳定前缀按缓存读计价）。精确度落在 **epochMs** 上（与 `memory.db` 的 `chat_messages.ts_ms` 同单位，要算差值直接相减），人读的时间保持**分钟精度** —— 中途试过精确到秒，主人当场定稿**"不需要带秒"**。以前算不准时间就只能多调一次 `qq_get_recent_messages`，而每多一步就重发一整份系统提示词与工具表。

### 变更与不兼容

- **两个运行时各自一份 `state/`（含 `memory.db`），代码同步从来不带它** —— 这不是 bug，是设计：`state/` 里有各自的会话令牌、未读水位、语音配置，两边同时写一份库只会互相踩。代价是"本机这份记忆落后于服务器"。本次把一个真实落差补齐了：服务器私聊 `private:1736784911` 有 1777 条、本机只有 661 条（本机桥停机期间的消息全在服务器那份里），已按"服务器版为基准 + 保留本机独有的 294 条消息"合并（合并前备份 `memory.db.bak-before-merge-*`），本机独有的 18 条 `memory_entries` 也一并补回。
- 顺带核对了一次"主人的生日查不到"：**不是丢数据、也不是没同步** —— `chat_messages` 里私聊 09-11 ~ 09-20 一天不漏，但**9 月中旬的私聊里从来没有出现过"生日"**（用"生日 / 农历 / 初九 / 冬月 / 11 月 / 12 月"宽口径搜过，两个运行时的库里都没有）；生日是 **09-20 07:16** 在私聊里说的（"每年的11月初九"），当天就已落进库与档案（`profiles.birthday = 农历十一月初九`）—— 机器人当时回"库里最早一条相关的就是今早 2:58 那句"是对的。

### 内部与工程

- **「merge 双向合并」按钮以前点了等于没点（两个真 bug）**：主人点 SSH 配置页的同步按钮 → 方向选 `merge 双向合并`，步骤永远停在 `[BAD] 备份本地 state  xcopy 备份失败, 中止`，本地 state 一个字没改。两个根因：① 备份用 `xcopy /E /I /H /Y` 判 `status === 0` —— xcopy 的退出码不止 0 一种成功，且对共享冲突（桥刚被停掉、`memory.db` 句柄还没释放）在非交互下直接算失败，判失败又**中止整个合并**；可回滚路径其实不依赖这份拷贝（紧接着的 rename 会把原目录留成 `state.old-<ts>`）。现在改 `robocopy`（退出码 0~7 都算成功、≥8 才失败，`/R:1 /W:1`）→ 失败退 `tar` → 都失败也只如实记一步、不再中止。② 替换本地 state 那一步写的是 `fs.renameSync(...)`，而本文件的 `fs` 是**具名导入**（没有 `fs` 这个命名空间对象）→ 必然抛 `fs is not defined`。两处都修好后已真机跑通：备份（robocopy）→ 替换（原目录留 `state.old-*`）→ 打包 → 上传覆盖远端 → 重启两端桥，全绿（`server/index.js`）。
- 顺手把一个真实的落差补齐了：服务器私聊 `private:1736784911` 有 1775 条消息、本机只有 661 条（本机桥停机期间的消息全在服务器那份里），已按"服务器版为基准 + 保留本机独有的 294 条消息"合并（`state.bak-merge-*` / `state.old-*` 两份备份都在），本机独有的 `memory_entries` 也一并补回。
- **"0.7 分一条还能不能再省"的账（本次实测，别再来回调参）**：把 `state/token-usage.jsonl` 里 1936 次真实请求当量折算（1 分 ≈ 14,962 全价输入 token，缓存命中按 0.115 折算），单步成本 = 0.0668 × (0.115 × 缓存读 + 未缓存 + 3 × 输出)：
  | 上下文 | 折合每条 |
  | --- | --- |
  | 0~40k | **0.41 分**（地板：固定开销 2.75 万 × 0.115 ≈ 0.21 分 + 新内容 ~0.17 分 + 输出 0.03 分） |
  | 40~70k | 0.56 分 |
  | 70~90k | 0.79 分 |
  | 110~140k | 1.04 分 |
  阈值继续往下降**不划算**：把上下文压到 40k 需要每 ~15 步压缩一次，而一次压缩的真实代价是 **3~7 分**（摘要请求把上下文整段按全价读一遍 + 改写历史后整段前缀缓存作废、下一步全量重读）—— 0.06/0.012 那次的实测就是"每 2.5 步压一次"，账面上比 0.08 更贵更慢。工具表也不是大头：实测 15.5% 的表体积（8 个几乎没人调的工具）只值 **0.017 分/步**。所以 0.08/0.02 是实测出来的平衡点，**每步 ~0.7 分是该模型 + 该提示词体积下的地板**；想再往下走只有两条路：换更便宜的模型/套餐，或者砍系统提示词与工具表（合计约占单步 30%，砍一半也只省 ~6%）。另外线上那台的推理档位本来就是 `off`（最省也最快），本机原来是 `high`，这次统一成 `off`。
- `tools/test-dsh-compaction.mjs` 的阈值门禁改成两头夹：缺省阈值 × 1M 必须落在 [8 万, 10 万] token（低于 8 万 = 被固定开销顶穿、每步压缩；高于 10 万 = 一句话 1 分钱）、压缩后离阈值至少留 2.5 万 token、事故值 0.12 不再允许做缺省、低于下限的 0.06/0.02/0.005 必须被夹回、出厂 `config.example.json` 与代码缺省必须一致。
- 定位手法留档：会话日志是**多帧 zstd**，Node 的 `zstdDecompressSync` 只解第一帧（本次踩过：以为"搜不到生日"，其实是只解了 199 字符）—— 要么逐帧解、要么直接用 `zstd -dc`；`memory.db` 则可用 `node --experimental-sqlite` 直读。

## 1.2.1 — 2026-09-20

### 修复

- **上下文压缩阈值被"固定开销"顶穿 → 每一步都压缩一次（又慢又贵）**：`dshCompaction.thresholdRatio` 原来是 `0.06`（1M 窗口 = 6.3 万 token），可实测这个会话**每次请求的上下文基线就有 6.9 万 token** —— system 提示词 5.36 万字符 + 78 个工具 8.11 万字符 ≈ **2.75 万 token 的固定开销**，阈值被它自己顶穿。后果（VPS 私聊会话 10 回合 114 步的实测）：`compaction/start` 71 次、`compaction/summary` **46 次**，几乎每一步之间都夹一次压缩 —— 每次压缩 = 一次额外模型请求（把整段上下文读一遍写摘要，单次 3~6.9 万 token 未命中缓存）+ 改写会话历史（前缀缓存全废，下一步只能全量重读）；该会话未缓存输入 **116.9 万 token**，每一步之间多花 **15~20 秒**，一个搜索回合被拖成 6 分钟。现在缺省改为 `0.12 / 0.03`（1M 窗口 ≈ 12.6 万 token 才压缩、最近 3% 逐字保留），压缩后上下文约 5.9 万 token，远低于阈值，不会再"压完立刻又压"；下限从 0.02 抬到 **0.08**，低于它会被自动夹回并写日志（`qq-bridge/src/lib/dsh-compaction.js`、`src/core/config.js`、`config.example.json`、`tunables.js`、管理端「上下文治理」卡片）。
- **搜索型回合会失控成十几步**：同日线上实测，主人问一个记不得的日期，模型连发 10 次历史检索（`qq_memory_search` 换着关键词搜「生日 / 几月几号 / 月日 / 1月 / 2月」…）跑了 6 分钟才回一句"翻遍了没找到"，每一步都要重发一整份提示词。preset `[TOOLS]` 新增 5b：历史/记忆检索**每回合最多 2 次**（尽量在同一个 step 里发），第二次还没答案就停下、用一句话说清楚没找到，禁止换词反复检索。
- **整串数组被当成一条消息发进 QQ**：模型偶尔把 `qq_send_message` 的 `messages` 整体序列化成一个字符串，里面的引号还是嵌套的（`["直接跟我说就行", "比如"朋友圈活跃19点到23点"", "我帮你设 ᗜ ‸ ᗜ"]`）—— `JSON.parse` 必然失败，旧代码于是把这串数组当"一条消息"原样发了出去。现在发送端点先尝试还原（严格 JSON、`{"messages":[…]}` 包装、以及引号嵌套的容错切分），还原不了就 **400 硬失败**、一条都不发并回执让模型重传真正的数组；即使绕到别的发送工具，`onebotSend` 也会拒发这条正文（`qq-bridge/src/lib/text-safe.js`、`qq-bridge/src/core/console-server.js`、`qq-bridge/src/core/qq-send.js`）。
- **系统提示词的正文格式要求太散**：`[TOOLS]` 新增 2b~2e 四条 —— 不许显式换行（代码/诗歌例外）、颜文字只在人设要求时发且 10 字内联/超 10 字单独一条、工具参数数组当正文是硬失败、代码类生成与解释不分段（>50 字仍一条）。这四条讲的是"正文长什么样"，因此放在管发送工具的 `[TOOLS]` 段，而不是 `[PERSONA]` / `[SPEECH RULES]`（后两者管"你是谁、你怎么打字"）。

### 变更与不兼容

- **DSH Web GUI 里每个工具步的那个「系统提示词」标签不是桥在重复注入**：LLM 请求是无状态的，每一次请求（含同回合里的每个工具步）都要带 system + 工具清单 + 全部历史，标签就是这次请求的记录。同一会话 31 条 `request/header` 的 system 文本 sha **完全相同**（53,645 字符），桥每一步真正灌进去的只有 `[Mid-turn] …`（约 150 字符）这类数据行 —— 省钱的杠杆是"少步数 + 前缀稳定（别频繁压缩）"，不是提示词本身。
- **换行与颜文字只写在提示词里，桥不做正则清洗**（主人 2026-09-20 定稿）：出站正文原样透传，`[TOOLS] 2b` 明确告诉模型"这条在你自己身上，桥发什么就是什么"。数组形状（`2d`）是唯一**桥侧真拦**的一条：形状对、能还原就还原成多条气泡，还原不了就 400 拒发。
- `[TOOLS] 2d` 的示例刻意不含颜文字 —— 出厂 preset 里出现 `ᗜ` 之类会破坏"默认人设不带表情符号要求"的既有约束（`tools/test-wake-protocol.mjs` 的鲸鱼清理门禁）。

### 内部与工程

- 新增回归测试：`qq-bridge/tests/outbound-format.test.js`（判据，含"换行不该被桥改写"）、`qq-bridge/tests/outbound-send-integration.test.js`（端到端：真起控制台 + 假 OneBot 端点收消息）、`qq-bridge/tools/test-dsh-compaction.mjs` 新增 4 项（缺省阈值必须高于实测基线、事故值 0.06/0.02/0.005 必须被夹回、压缩后必须远低于阈值、出厂模板与代码缺省一致），全部接进 `npm run check`；preset 内容门禁补 6 条（`qq-bridge/tools/test-wake-protocol.mjs`）。
- `summarizationProvider/Model` 早已按主人定稿"摘要统一用主模型"而不再写进 patch，测试里的旧断言（还在要求写进 YAML）已改成钉住新契约。
- `.gitignore` 忽略 `qq-bridge/tests/.tmp-*/`（测试沙箱每次重建，Windows 上 sqlite 连接要到进程结束才释放，收尾删不掉）。

## 1.2.0 — 2026-09-19

### 新增能力

- **内置表情包从"单包"改成"多包"**：以前桥只认一个写死的包名（`whale-fanart-001`），主人再传一份表情包进来模型根本看不见。现在一份包 = 一个目录（`manifest.json` + `index.db` + `memes/<分类>/<文件名>`），桥同时认三个位置：出厂包 `<运行目录>/meme/<包目录>/`、后装与上传的包 `<运行目录>/meme-packs/<包目录>/`、角色专属包 `<角色库根>/<角色>/meme-packs/<包目录>/`。`qq_meme_search` 一次搜全部包（结果行带 `[包 id]`，可用 `pack` 只搜一份），`qq_send_meme` 收文件名，也收 `包id/文件名`（`qq-bridge/src/mcp-napcat-safe.js`）。
- **角色专属表情包**：`social.meme.personaPacks` 把包绑到角色，`social.meme.activePersona` 记当前导进 `persona.md` 的角色。两份包有同名文件时按「角色专属包 → 主人点名的包 → 出厂包」取第一份，并在返回里说明这个名字还存在于哪些包；`social.meme.packs` 非空时只搜点名的包加上当前角色的包。
- **管理端可以上传自己的表情包**：「常用设置」新增「内置表情包（meme-packs）」卡 —— 选 `.zip` 或整个文件夹上传，服务端自动判定包根、跑规整、缺 `index.db` 自动生成，并回一份逐文件报告（收到多少、入库多少、跳过了哪些、可展开规整脚本输出）；卡片同时显示每个包（出厂 / 全局 / 角色专属 / 坏包）与每个角色绑了哪些包，并按角色勾选保存（`server/index.js`、`src/pages/BridgeConfig.tsx`、`src/api.ts`）。
- **出厂 21 个角色包**：`qq-bridge/characters/` 随包携带 21 个角色包（每个含 `SKILL.md`、`personality.md`、`profile.md`、`interaction.md`、`relations.md`、`memory.md`、`conflicts.md`、`ULTIMATE_ROLEPLAY_PROMPT.md`、`manifest.json`、`sources/wiki.md`）外加 1 张散装卡，撤掉原来的 `_template` 模板卡。角色库里只有导进 `persona.md` 的那一张会进提示词，其余靠 `qq_character_list/read/pack/search` 按需读。
- 表情包总开关 `social.meme.enabled`：关掉时 `qq_meme_search` / `qq_send_meme` 干脆不注册给模型（不是调用时才拒绝）。

### 修复

- **人设/发言规则不再在唤醒正文里重复一遍**：从 1.1.x 起这两份已经由 `lib/preset-compose.js` 合成进**系统提示词**（新会话一建起来就带着），可是唤醒正文里仍**无条件**再塞一份 —— 实测一条首连正文里 `[PERSONA]` + `[SPEECH RULES]` 就有 10KB 量级。现在只在"preset 里那份过时了（刚改完人设还没合成）"或"这个会话被标记要补注入（人设刚改 / 桥停机期间改过 / 升级前建的老会话）"时才注入一次；补过就记上版本号，此后不再重复。启动时会自动把"没见过当前人设版本"的会话标记一次（本机启动日志实测标记了 6 个会话）。回归测试 `qq-bridge/tests/persona-inject.test.js`。
- **系统提示词把"只发 OK、说话必须走工具"写到不容误读**：`[TOOLS]` 第 1 条改成 **NO TEXT. SPEAK ONLY THROUGH TOOLS.**（列出全部发送工具、"你的词必须在工具调用里"、收尾前自检、这轮不说话就只调 `qq_mark_read` 且不写任何文本），第 1b 条改成 **THE ONLY TEXT YOU MAY EVER OUTPUT IS THE BARE TOKEN `OK`**（只能是单独一个 `OK`，不许带标点/句子/总结/解释/草稿，也不许"就这一次"). 配套修了桥侧：以前**裸 `OK`** 会被当成"写了正文没调发送工具"的未交付草稿，下一轮还往正文里塞一句 `[Undelivered draft] …("OK…")`；现在认它是控制令牌，按"本轮不说话"处理。
- **模型"像是不记得工具怎么调、也忘了规矩"：工具结果被剪得太狠**。`dshCompaction.toolResultMaxChars` 原来是 1500 —— 单个工具结果超过 1500 字就被剪成「开头 900 + 剪枝标记 + 结尾 300」，而 `qq_get_prompt` 返回的整段唤醒协议、状态快照、角色卡、贴纸清单动辄几 KB，模型每轮只看到零头。现在**代码默认值与出厂配置都改成 8192**（与 DSH 插件默认一致）；桥会热加载并重写隔离 DSH home 的 `cordis.patch.yml`，不用重启 DSH、也不打断正在聊的会话。顺带把系统提示词 [TOOLS] 那行的示例点名到具体工具（含 `qq_social_state`）—— 实测模型曾自造 `qq_get_social_state` 这个名字（代码库里不存在），这条对**新会话**生效。
- **表情包发现没跟随符号链接**：服务器上 `<meme-packs>/<包里>` 是指向别处的软链，而 `readdir(..., { withFileTypes: true })` 的 Dirent 不跟随链接（`isDirectory()` 为 false）→ 整份包被跳过，工具回"本机没装内置表情包"。现在改用 `statSync` 判目录（桥侧与管理端同一口径），并加进多包回归测试。
- **全新机器上"装了 21 个角色包，四个角色工具却一个都读不到"**：`social.charactersDir` 没配时，角色库根以前固定指向 `~/Downloads/characters/characters` —— 那是"主人自己放角色库的地方"，新机器上根本不存在，而真正装着出厂包的 `<安装目录>\resources\runtime\qq-bridge\characters` 谁都没看。现在按"存在即用"回落：用户库 → 出厂库 → 老默认；配了 `social.charactersDir` 就完全以它为准。
- **导入列表和模型读的库不再是两套**：管理端「角色库导入」的扫描根以前是"桥目录 characters 排最前"，出厂库随包进 runtime 之后就永远胜出 —— 你往自己那份库里新加的角色**不会出现在导入列表里**，而模型侧四个工具读的却是用户那份。现在只要配了 `social.charactersDir`，导入列表就以它为准，两边看到同一个库。
- 导入角色卡时顺手把 `social.meme.activePersona` 记成这个角色（角色专属表情包据此排最前），不再需要手写这个键。
- **「重启桥」以前可能报成功却没重启**：`start-bridge.sh` 不杀旧桥，新实例撞 3100 自退，而判据只看 `pgrep` 有没有命中 —— 旧桥正好命中，于是界面显示"重启成功"、新代码一行没生效（实测服务器两次同步 pid 都没变）。内联 `pkill` 也救不了（多层引号一吃就变成参数错）。现在重启逻辑放进随代码包走 `qq-bridge/tools/restart-bridge.sh`（停旧桥 → 等它优雅退出、超时才 -9 → 起新桥 → 回报 `pid / old / napcat-conn / console-listen`），管理端两条路 + 克隆路径都走它，并加了源码门禁 `tools/check-remote-restart-uses-script.mjs`。
- **重启管理端不再顺手关掉本机的桥与隔离 DSH**：关窗守卫是按"后端进程还在不在"判定的 —— 后端一没、宽限期（原来 6 秒）一到、guard 文件还没被新后端接管，它就认定"应用关了"，把 NapCat、桥、隔离 DSH 一起收掉。而重启后端时新后端常要 5~20 秒才起来并武装新守卫，于是"重启一次管理端，机器人就哑了"（本机实测被收掉一次）。现在宽限期放宽到 30 秒，`tools/restart-manager.ps1` 也会先退掉那个盯着旧后端的守卫，等新后端自己武装一个新的。
- **代码同步不再覆盖服务器自己的配置**：`/api/ssh/sync` 的代码包以前**没有排除 `config.json`**，每次"只同步代码"都会把本机那份调试配置覆盖到服务器上 —— 远端 NapCat 令牌被换掉（桥每次连上就被踢，日志 282 条 `code=1005`）、`dsh.baseUrl` 从 3080 变成 10721（事件流连不上）、docker 路径映射与白名单一起丢，整台 QQ 哑火而界面每一步都显示 OK。现在代码包排除它，解包后再兜底还原（显式推配置仍走自己的开关），并新增 17 项回归测试。
- **「重启远端桥」以前其实没重启**：`start-bridge.sh` 不会杀旧桥，新起的实例只能报 `listen EADDRINUSE` 然后自己退出；而这一步的成功判据是 `pgrep` 有没有命中——旧桥正好命中，于是界面永远显示"重启成功"、新代码一行都没生效。现在先停旧桥、等它退干净再起，并把新进程 pid 与到 NapCat 的连接数一起回报。
- **表情包"搜得到、发不出"的根因**：规整脚本重建 `index.db` 时漏了 `path` 列，而 `qq_send_meme` 恰恰是拿 `path` 发图。现在表以 `path` 为主键，脚本结尾还会真跑一遍桥侧那两条 SQL 自检，不通过就报错退出。
- **规整不再吃掉已有描述**：以前按文件名拆词重写 `caption`/`keywords`，会覆盖掉已有的人工/模型描述；现在按「老表 path → 老表 file_name → 去扩展名同名」认领老行并原样保留，只有表里没有的新图才生成兜底描述。
- 出厂表情包索引与磁盘漂移（184 张图只有 162 行入库）已对齐；顺带发现并隔离了一张与 `angry/` 字节完全相同的 `daily/` 副本。
- `qq_meme_search` 遇到坏包不再整次失败：跳过读不出来的包继续搜，并在结果里说明跳过了几份。
- 语音测试与现契约不一致（语音早已默认丢弃引用段，测试还在断言"先加 reply 段"）已按契约改写，并补上 `quoteMode=native` 那一支 —— 之前它让整条自检链一直红。

### 变更与不兼容

- **斜杠指令统一英文**：新增 `/set active [HH:MM-HH:MM]`（这段时间活跃，其余只回 @）与 `/set diving [HH:MM-HH:MM]`（这段时间潜水，其余活跃），**不带时段 = 全天**；`/set mode active|diving` 保留为等价老写法。中英混写的旧写法全部移除：`/slang 学习`、`/slang 停止`（改用 `/slang learn`、`/slang stop`）、`/set mode 活跃`、`/set mode 潜水`、`/op del 删除|取消|撤销|解`（改用 `/op del` / `/op remove`），作息时段的分隔符也不再认「年」「到」。`sleep` 那一套（`/set sleep 01:00-06:00`、`/set sleep 30m`、`/set wake`、`/set cancel`）照旧。
- 删掉过期的 `qq-bridge/QQ聊天角色设定.md`：概率早已改成桥侧掷骰（`core/send-dice.js`），那份手写参数表不再对应任何真实行为。
- 内置表情包的搜索结果行多了一段 `[包 id]`（`文件名 [分类] [包 id] 描述`）；`qq_meme_search` 与 `qq_send_meme` 各多一个可选 `pack` 参数。
- 包 id 取 `manifest.json` 的 `id`，目录名不再等于 id；出厂包 `whale-fanart-001` 的目录名与 id 不变。
- 出厂角色卡由模板 `_template` 换成 21 个真实角色包 —— 管理端「角色库导入」列出的默认内容随之改变。
- **上传的表情包在后装目录 `meme-packs/` 里，升级不会覆盖**；出厂包在 `meme/` 里，随更新整体替换（界面里出厂包只提供禁用不提供删除）。

### 内部与工程

- 桥侧工具描述改动后重新实测生成 `src/tool-schema-chars.ts`（89 个 napcat 工具 / 84251 字符）。
- 新增多包回归测试：`qq-bridge/tools/test-meme-search.mjs --multipack`（跨包搜索、`pack` 过滤、同名歧义与角色包优先、`social.meme.packs` 收紧、启动日志）。
- 新增上传接口集成自测 `tools/test-meme-pack-import.mjs`：把 `server/index.js` 复制进沙箱当运行目录（`RUNTIME_ROOT` 是按文件位置推导的，环境变量改不动），`USERPROFILE` 指向沙箱 home，`QBM_NO_LISTEN=1` 只导出 app 由脚本自己 `listen(0)`。覆盖 zip 与文件夹上传、zip-slip 与坏输入零痕迹、出厂包拒绝删除、`bind` 只动 `social.meme.personaPacks`（保留 BOM 与其它字段）、以及"沙箱里自动重启被安全挡掉"。
- 表情包上传的"自动重启桥"加了前置判断：`stopInstance` 末尾的 `killByCmdline('bridge.js')` 按命令行关键字杀全机器的 node/qbm-node，管理端与桥不是同一份目录时会**误杀一座不归自己管的桥**，所以只有在确实管着这座桥时才重启。
- `tools/sync-to-live.ps1` 同步清单加上 `characters`，并显式清掉旧 payload 里残留的 `_template`；该文件注释改回纯 ASCII（它自己要求 ASCII-only：PS 5.1 按 GBK 读 `.ps1`，含中文就依赖 BOM，而编辑工具会丢 BOM）。

## 1.1.0 / 1.1.1（补记）— 2026-09-19

> 这一版的分组当时没有写进本文件（只发在 GitHub Release 说明里），这里按改动主题补记，便于对照。

### 新增能力

- 人设 / 发言规则 / 系统提示词分成三层：人设与发言规则**合成进系统提示词**（`qq-bridge/src/lib/preset-compose.js`，带幂等标记），正在跑的会话则继续走运行时注入那一段。
- 管理端「角色库导入」与角色库只读工具组的提示词强化：先读 `SKILL.md`，默认库路径 `~/Downloads/characters/characters`，父目录自动下钻一层。
- 发布工具沉淀：`publish-release.mjs`、`edit-release.mjs`、`api-commit-file.mjs`，以及四个界面/文档审计脚本（工具名、标签、配置说明、README 工具清单）。

### 修复

- **安装器的两个静默失败**：electron-builder 只要定义了 `customRemoveFiles` 就会跳过自己的 `RMDir /r $INSTDIR`，导致旧版卸载**什么都不删**；杀进程的 PowerShell 内联写在 `nsExec` 里被多层引号解析搞坏，导致"无法关闭，请重试"。现在卸载宏自己删并加延迟兜底，杀进程脚本先写 `$PLUGINSDIR` 再用 `-File` 调，名单补上 `guard-node.exe` 与"路径在安装目录内"判据。
- **更新安装会静默删掉用户数据**：更新时用 `Uninstall.exe /S /KEEP_APP_DATA --updated` 调旧卸载器，现在按 `--updated` 挡掉。
- 服务端模式读不到 DeepSeek 官方模型：`safeRemotePath` 正则漏 `@`，npm 作用域路径被静默拒；另外官方模型内置在 DSH 包里而不在 `settings.yaml`，旧代码只读后者。
- 上下文治理阈值被夹到窗口 0.5%，导致**每轮都压缩**、模型响应极慢；桥侧下限提到 2% 并在被夹紧时写日志。
- 「QQ 工具开关」行集原来只列配置里已有的键（少一大截），现在 = 桥侧全部开关 ∪ 配置已有键，并新增"无独立开关"工具单列一卡；同时删掉 6 个桥侧从来不读的废开关与 4 个对不上开关的标签。
- 插话概率：旧口径保留"模型自定"的值，导致主人设 0.15 但唤醒词显示 0.08；现在主人保存的值覆盖所有会话。
- 顶部提示条 6 秒自动收起、文案变化重新计时、点击即关。

### 变更与不兼容

- 系统提示词**不再内置默认人设**（没有 `[PERSONA]` 时不扮演任何角色）。
- 上下文治理卡去掉"摘要模型服务商 / 摘要模型"两栏（摘要统一用主模型）。
- 出厂 `persona.md` 为空；管理端「接口密钥」改名「语言模型密钥」。

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
