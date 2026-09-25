# 更新日志

本文件按主题归纳 MoonBot 的用户可见变化，不逐条罗列提交标题。版本号遵循语义化版本规范；分组约定为「新增能力 / 修复 / 变更与不兼容 / 内部与工程」四类。每个版本节下的条目均为 `- **短标题**：正文` 形式，正文只陈述事实、现象与判据，不作评价性描述。

## 2.0.3 — 2026-09-25

### 变更与不兼容

- **文档收敛为单一 README**：`qq-bridge/README.md`、`qq-bridge/README.en.md`、`qq-bridge/plugins/dsh-memory/README.md`、`qq-bridge/plugins/dsh-memory/lmemory/README.md` 及本地未跟踪的 `qq-bridge/roles/README.md` 一并删除，其安装前置条件、五步启动顺序与判据、桥接命令与三条运行约束、`/lmemory` 命令表、角色卡字段表、发送白名单强制与 `[CQ:` 注入拒绝等条目全部并入仓库根 `README.md`（705 行 / 19 张表，章节为 `## 1.` 至 `## 11.`）。英文版正文不再单独维护，其独有技术条目已转写为中文并入第 5 章。指向上述文件的历史链接改指根 `README.md` 对应章节（`qq-bridge/docs/PROJECT_GUIDE.md` 第 3 章目录树、`qq-bridge/RULES.md:72`）。

### 内部与工程

- **三份技术文档二次重写为学术技术文体并分块**：`docs/ARCHITECTURE.md` 1,490 → 1,762 行 / 129 张表（`## 1.` – `## 12.` 加目录）；`docs/CAPABILITIES.md` 1,764 → 2,854 行 / 146 张表（`§0` – `§16` 加附录 A–D）；`docs/COMPACTION-MATH.md` 1,676 → 2,074 行 / 46 张表（`## 0.` – `## 11.` 加附录 A–B，原 §4.5 生产复算记录升格为第 5 章并逐字保留，$0.16$ 出厂值推导、$T^\*=137{,}300$ 与 $\tau^\*=13.7\%$ 复算结论不变）。
- **补齐 MCP 工具全表**：`docs/CAPABILITIES.md` 附录 A 收 91 条 napcat 侧工具（工具名、必填与可选参数、最低保留档位、功能表述，按 16 组分表），附录 B 收 5 条宿主侧工具；数据取自 MCP 协议 `tools/list` 实取结果（启动时注入 `QQB_SLIM_TOOLS_OFF=1` 以取得完整注册表），并新增附录 A.1 记录导出与复现方法。
- **工具表统计口径更新**：`tool-schema-stats.json` 的现行值记入 `docs/ARCHITECTURE.md` —— `totalChars = 95,595`、`approxTokensPerStep = 31,675`、四档 `share` 为 `0.8281 / 0.4189 / 0.3488 / 0.0680`（对应保留 68 / 42 / 33 / 9 条），与压缩代理实测（相对完整工具表 `38.8% / 14.0% / 6.2% / 3.6%`）为两个不同测量对象，文档中已分别标注口径。
- **README 行号引用整体对齐**：`qq-bridge/tools/align-readme-lines.mjs` 以仓库根 `README.md` 为目标文件，本轮以 `--write` 校正 47 处「工具名（`:行号`）」漂移（如 `qq_send_message :1323 → :1314`、`qq_reply :937 → :969`），复查为 0 处待对齐；余 17 处 `:NNNN` 指向非注册行，脚本只报告不改写。
- **其余公开文档语域规范化**：`docs/PIXIV-AND-QZONE.md`（505 → 661 行 / 30 表）、`docs/release-1.0.0.md`（106 → 218 行 / 7 表）、`docs/NEXT-SESSION.md`（195 → 433 行 / 29 表，本地未跟踪）、`qq-bridge/docs/DSH_SETUP.md`（93 → 180 行 / 7 表）、`qq-bridge/docs/PROJECT_GUIDE.md`（362 → 483 行 / 21 表）统一为第三人称技术文体，情节化段落改写为「现象 / 机制 / 现行实现与判据」，并各自新增未核验声明章节。
- **表格排版缺陷修复**：`docs/COMPACTION-MATH.md` 表 25 表头中 `$|X'|$`、`$|X|$` 的竖线与 Markdown 分隔符冲突导致该表结构错误，改用 `$\lvert X'\rvert$`、`$\lvert X\rvert$`。
- **回归复验**：`cd qq-bridge && npm run check` → exit 0，全部套件 ALL PASS。

## 2.0.2 — 2026-09-25

### 修复

- **首次启动并在随包 QQ 配置完成后，整屏存在无法消除的半透明遮罩层残留**。根因是 `.view-veil`（`position:fixed; inset:0; z-index:60` 的近白径向渐变）以动画淡出自身，而 `prefers-reduced-motion: reduce` 分支中声明了 `animation: none !important`；动画被禁用后该元素停留在初始态（不透明度 1），因而成为一层永久固定的遮罩层。首次启动时报告者 QQ 弹窗的 `z-index:160` 位于其上，关闭弹窗后遮罩层随即显现，故该现象的表现时点为随包 QQ 配置完成之后。修复方式：`.view-veil` 的基础态直接设为 `opacity: 0` 并以 `animation: … forwards` 淡出，同时在 reduced-motion 分支中补 `display: none` 作为后备路径；`.view-swap::after` 的高光层采用相同处理（`src/styles/app.css`）。
- **陈旧注释与端口口径**：`qq-bridge/src/lib/dsh-side.js` 顶部注释与 `qq-bridge/README.md` / `README.en.md` 中记载的「隔离实例默认端口 13210」更正为 **10721**（端口实际取自 `instances.dshIsolated.port`，目标机为 `3080`）；`server/index.js` 隐藏器两处注释中的「观察 120 秒」更正为 **12 小时**（与常量 `QQB_HIDER_DEFAULTS.budgetMs = 43200000` 一致）。
- **README 引用了已删除的模块**：仓库地图与测试命令清单中移除 `server/napcat-webui-auth.js` 及其回归项，并把该模块的既有结论标注为「后续更正（2026-09-23 整体移除）」，以免读者按文档检索不存在的文件。

### 内部与工程

- **三份技术文档重写**（采用技术／学术文体，逐条给出相对路径与常量，未知项显式标注；行数均按「含空行」口径统计）：`docs/ARCHITECTURE.md` 628 → 1,490 行 / 134 KB（新增安装布局与路径解析、通信面全表、首启与鉴权、NapCat 守护、SSH 克隆部署、DSH 集成、打包分发、可靠性与不变量、待确认清单等分块）；`docs/CAPABILITIES.md` 457 → 1,764 行 / 201 KB（§0 总表 52 条能力，加 §13.5–13.9 与 §17–§18 的 DSH／管理端／部署面）；`docs/COMPACTION-MATH.md` 540 → 1,676 行 / 106 KB（符号系统、分块与递归摘要、成本泛函与触发判据、最优性、复杂度、实验口径，新增 §4.5 生产复算记录）。
- **压缩阈值按生产用量复算**：取生产机 `/root/qq-bridge/state/token-usage.jsonl`（1.6 MB / 6,952 行）执行 `node qq-bridge/tools/compaction-threshold.mjs <stateDir> 1000000`，样本为 5,957 次请求 / 13.8 天 / 430 步每天：最优点为 **0.14**（¥2.057/天），稳健区间为 **12%~16%**，出厂值 **0.16** 落在区间上端（¥2.082/天，与最优点相差 1.2%）；同一口径下模型对实测值仍存在**系统性低估 27%**（¥2.310 对 ¥3.161/天）。出厂值不变，复算过程与口径说明写入 `docs/COMPACTION-MATH.md` §4.5。
- **回归套件恢复全绿**（`cd qq-bridge && npm run check` → exit 0）。三处结果取决于本机环境的断言改为密闭条件：`tests/send-pace-clamp.test.js` 随 2026-09-24 的契约变更（`perChar` 上限 320 → 1000）更新期望值；`tests/character-tools-mcp.test.js` 以 `QQB_SLIM_TOOLS_OFF=1` 量测注册表本身（否则角色卡四件会被本机所选 `slimTools` 档位按设计裁剪）；`tests/repeat-failure-guard.test.js` 自建临时表情包并经 `QQB_MEME_ROOT` 指向该目录（产品已不再随包分发表情库，否则该测试在干净机器上必然失败）。

## 2.0.1 — 2026-09-24

### 新增能力

- **完全性角色扮演**：内置发言规则新增 `[Roleplay]` 一节，明确「人设即当前发言主体」——每条消息、每个话题、每一轮均处于角色之内，不插入半出戏的旁白；更换人设即更换发言主体，不将上一个角色的自称、口癖、称呼与世界观带入；同一时刻只承认本轮注入的那一份人设。同一条约束亦写入系统提示词（`agent-presets/default` 与 `qq-chat`），群聊与社交会话一并生效。

### 变更与不兼容

- **移除「连发」工具 `qq_send_burst`**：模型不再拥有「一次连发多条」的独立入口，以减少一次性补完式的刷屏。发送多条 Message 的能力不变——`qq_send_message` 的 `messages` 数组走同一条发送链，分条节奏、频率上限、敏感词与重复拦截、发送后的质量软提醒均照旧。同时移除控制台的 `/api/social/send-burst` 端点、`social.tools.sendBurst` 开关（管理端「连发多条」开关项）、工具发送正则中的 `send_burst` 与参数修复名单中的同名条目；`sendMessages` / `computeGaps`（分条节奏）等底层能力原样保留。
- **NapCat 启动方式收敛为一条**：移除 VBScript 启动器（`.vbs` 生成、引擎探测、按需功能安装、提权路径与四级回退路径全部移除），现仅使用 `powershell -WindowStyle Hidden -Command "Start-Process … -WindowStyle Hidden"`。控制台窗口、QQ 窗口与任务栏按钮在整条进程链（启动器 → NapCatWinBootMain → QQ）上均不出现；系统自带 PowerShell 始终存在，因此不再依赖脚本引擎、不再需要安装按需功能，也不再触发 UAC 提示。
- **内置发言规则重写为角色无关的短句模板**：原规则夹带某一具体人设的示例（例如「我是鲸鱼不是萝莉」）与整节对照样例，切换人设时会带入旧角色的口吻。现仅保留必要且可判定的描述——发送与引用协议、分段节奏、场合判断、表情包用法、去除 AI 味的硬性约束——全部写为**正常大小写的英文短句**（不再使用全大写 token 体例），节标题一律使用英文中括号（`[Delivery]`、`[Splitting]`、`[Quoting]`、`[Wake]`、`[Meme]`、`[Style]`、`[Room]`），仅示例保留中文（实际发出的内容即为中文）。文件体积由 11.2 KB 降至 6.9 KB；管理器「恢复默认发言规则」写回的模板与 `qq-bridge/speech-rules.md` 逐字对齐（此前两者长期漂移，触发一次恢复会把规则覆盖为旧版），上限 12000 字符（`RUNTIME_OVERRIDE_MAX`）不变。
- **清空人设不再写入提示语到 persona.md**：此前的清空操作会把一句中文提示（「未启用角色卡：按默认人格与发言规则说话，不要再演任何角色。」）写入人设文件，而该段文字会**原样注入给模型**，等同于每轮重复声明不得扮演角色。现在清空即真正清空；管理端人设编辑框改用灰色占位词 `You're a helpful assistant.` 表示「当前为人设，即默认助手」，占位词只显示、不落盘、不注入。
- **斜杠指令只识别英文**：`/portrait` 只保留 `learn | stop | status`（移除中文别名「画像学习 / 群友画像学习」、中文子命令与 `/portrait start`、`/portraitlearn` 等缩写形式）；`/role` 的清除只识别 `clear | off | none | default`（移除「默认 / 清除 / 关闭」）。未知子命令只回用法文案。管理端「指令速查」与说明文档同步移除「亦识别…」「中英混写已不再识别」一类兼容备注。
- **工具名单档位改为自定义预设方案**：移除 off/low/medium/high/extreme 档位选择器及其全部实测读数（工具个数、字符数、占比），名单一律由使用方勾选产生；勾选结果可存为**命名方案**，并支持改名、删除、以当前名单覆盖、单步载入（载入即刻同步卡内勾选状态与计数）。方案存于 `social.slimTools.schemes`；写入名单时自动把 `social.slimTools.level` 置为 `custom`（仅该档位下手写名单才会生效）。
- **界面字体与按钮动效**：全站说明文字统一为随包自带的圆体（AaCute / AaCute-full），不再回退到系统字体；等宽字体只保留三处——首页卡片中的日志查看器、`config.json` 编辑区与代码片段，等宽字体改用随包自带的 JetBrains Mono。所有按钮改为低对比度的流动渐变（15 秒一循环，色差压至最小）；首页主按钮原先的白色扫光与卡片强反光已调弱或移除；`prefers-reduced-motion` 下全部动画关闭。
- **首页改版**：标题改为英文 `Made a character, kept a friend.`（中文副标题保留）；新增极光背景、标题入场与渐变字、四张卡片错峰入场与悬停微光，全部为纯 CSS 动效。
- **不再附带出厂表情包**：`meme/whale-fanart-001` 已从仓库与安装包载荷中移除，表情包一律由使用方自行导入（上传包、角色专属包）。相关工具路径、SSH 部署软链与「从本机复刻」的源探测均改为扫描任意存在的包，不再写死包名。
- **界面说明文案重写并取消等待态**：管理端各页说明统一为庄重书面语体（去除口语感叹、卖点词与比喻；键名、命令、数值原样保留），每处按「功能定义 → 使用方式 → 注意事项」组织。「拟人默认与安全线」整张卡片、NapCat 令牌卡中的现状说明块（配置文件 / 运行形态 / 涉及文件 / 磁盘现状 / 期望值）与首页英文标语已删除或改写。进入桥页面、连接远端服务器、语音配置页不再出现「加载配置中…」「正在读取语音配置…」这类阻塞等待态：界面先按出厂默认值渲染，数据到达后就地填充，读取失败时只显示一行原因与重试入口。

### 新增能力

- **模型可主动查当前时间（`get_time`）**：新增 MCP 工具 `get_time`，返回北京时间（UTC+8）至分钟精度，与消息行、工具结果同一口径，字段含 `beijing / date / weekday / time / hour / timezone / epochMs`。唤醒正文不再自带时间行（原因见下条），因此任何与时间有关的回答均以本次调用为准。该工具读取本机系统时钟，不发网络请求、不访问 NapCat，schema 约 450 字符，不占检索预算。
- **深夜休息提醒**：系统提示词新增 `OWNER_REST` 规则——在私聊中，若北京时间已过约 23:30（或凌晨 1 点后对方仍在线），模型可收尾一句休息提醒，亦可在聊天安静时主动发送一条；每个自然日最多一次，执行过一次即写入记忆，并在下次动作前先查记忆；对方表示忙碌或不需要时立即停止。群聊与陌生私聊不适用。

### 变更与不兼容

- **去掉唤醒正文中的时间行**：原 `[Now] 2026-09-20 周日 19:15（epochMs=…）` 记录的是**拼装正文那一刻**的时间，模型实际动手时该值已经过期；同一条上下文内堆积多轮旧 `[Now]` 时还会取到更早的一条，导致时刻答错。现在该行整体移除，`[Status]` 保留（未读数、最后说话人、潜水模式等均为过去已确定的事实，不会过期），「现在几点」改由 `get_time` 实时获取。
- **agent preset 合并为单份 `qq-chat`**：仓库与隔离 home 此前同时存在 `default` 与 `qq-chat` 两份预设，显示名同为「QQ 聊天角色」，在 DSH 预设列表中重复出现。现只保留 `qq-chat` 一份（内容取线上实际生效者，原 `qq-chat` 中已过时的提示词正文废弃，`qq-tool-restrict.mjs` 取带实测结论的版本），配置默认值（`agentPreset` / `slang.learnerPreset`）与人设合成路径（`lib/preset-compose.js`）一并改名。需要说明：DSH 的预设只在建会话那一刻绑定，**已在运行的会话不受影响**；要使其获得新预设名，需等待会话轮换（或先关闭「永久会话不轮换」）。
- **「添加群」按钮尺寸与配色调整**：此前该按钮与群号输入框等宽等高（196×38、浅粉 `btn-soft-primary`），三字标签在按钮内留白过大。现在输入框保持 196×38，按钮改为 30px 高的紧凑尺寸，并改用与「添加服务器」相同的 `btn-primary`（红/pink 主色），圆角、阴影、悬停态完全沿用既有按钮样式。
- **说明文字统一为圆体**：语音配置「预置地址」说明与工具压缩代理卡首段说明含 `<code>` 片段，此前被全站等宽规则压成 JetBrains Mono，同一段文字出现两种字形。这两处改用 `.cute-note`（含子元素），代码编辑器与日志查看器仍保持等宽。
- **界面滚动条全部隐藏**：所有滚动容器不再绘制滚动条（标准属性与 `::-webkit-scrollbar` 成对覆盖），滚动行为本身不受影响——滚轮、触摸板、键盘与拖动照常可用。`select` 一类此前的滚动条规则一并被覆盖。

### 内部与工程

- 新增 `tools/sync-speech-template.mjs`：把发言规则模板重新生成为 `qq-bridge/speech-rules.md` 的逐字副本，`--check` 可校验一致性（防止两处再次漂移）。
- 仓库与载荷移除出厂表情包后，安装包与运行目录体积同步减小约 7 MB。
- 代码注释统一整改：去除「某人要求」式的转述口吻与日期装饰壳（形如 `【<日期> <身份>要求】` 的标注改为 `<日期>：`）、去除注释中的表情符号与加粗强调，只保留可验证的事实（数值、实测结论、报错原文、设计原因）。

## 2.0.0 — 2026-09-23

本版打通**安装包在他人机器上的可运行性与到自有新服务器的自动部署链路**，并附带修掉若干仅真机环境才会暴露的失效。

### 修复

- **到新服务器的自动部署完全不可用（阻断级）**：`server/deploy.js` 在打包 `dsh-home` 时必然失败——tar 报 `tar: ./profiles/node_modules/…: Cannot stat`，且**整个 tar 以退出码 1 结束**。现场查明：pnpm 安装的 `profiles/node_modules` 是一整片 junction（本机实测 **489 条中 484 条悬空**，均指向已被卸载的全局 `dsh`），Windows 的 bsdtar 遇到悬空 junction 会 stat 失败。排除规则无法规避（做过 8 组对照，**即使完全不使用 `--exclude` 同样失败**），而 `dsh-home` 不是可选包，于是 `throw` → 部署在打包阶段即中断，无法进入传输阶段。现在按「归档确实生成且非空 + stderr 每行均为良性警告」放行，其它错误照常判失败；跳过的条数写入部署日志。
- **出厂包少带 41.4 MB 本机残留数据**：`state.bak-* / state.old-* / state.merge-stage-*`（六个目录）与 **30 多个 `config.json.bak-*`** 会被搬运至目标机，后者每一个都带有报告者 QQ、NapCat 令牌与服务器地址。现已排除，`bridge` 包由 27.8 MB 降至 15.6 MB。
- **`/token` 的分时数据全为 0**：根因是 `Number(null) === 0`。`initTokenMeter` 把 `nowMsOverride` 写为 `null`，而 `nowMsOf()` 以 `Number(null)` 判断有限性，得到 0 而非 NaN，于是「现在」变为 1970-01-01，分时桶的门限永远不匹配。**总量正确而分时全为 0** 这一组合即由此产生。现已改为先判 null/undefined。
- **断网重连时状态机反复循环**：`establishConnection` 更换连接时对旧连接调用 `end()`，旧连接异步抛出 `close`，而此刻 `sshConnections` 中该主机刚被删除，于是「是否已被新连接取代」的判据两个条件均不成立，被误判为真实掉线 → 排队重连 → 再次更换连接 → 无限空转。新增 `replacingConnections` 标记以识别自身发起的人为切断；同时 `waitServerReady` 失败后改为自行安排重连（原实现失败后无人推进状态机）。
- **主动唤醒的回合挂起于「深度求索中」**：保持循环的价值仅在于合并对方连发的若干条消息，而自发起回合（`proactiveCheck`/`probability`/`replyCheck`/`timeout`/`topic`/`activityStart`）本无对方消息可并；模型该轮不发言时连 `turnHasBubble` 均为 false，必然拖至 `idleCloseMs` 30 分钟。现在自发起且无待交付内容时立即收尾。
- **群聊中的昵称对不上人**：`profiles` 表有 23 行、**其中有名字的仅 1 行**，而通讯录查询为 `WHERE name != ''`，因此注入给模型的 `[Contacts]` 中只有报告者一项。群友的群名片实际一直解析成功（随消息携带），只是从未写入档案。现在每条入站消息附带补写一行 `profiles.name`（仅在为空时写入）。
- **NapCat 静默鉴权后仍需手动点击一次**：鉴权账本按 **token** 分桶，但读取的是挂载时的旧快照、写入的是刚取回的新 token，首次启动时两者必然不一致 → 账本查不中 → 白刷一次。改用 **origin（host:port）** 分桶：Credential 本已存在于该源下的 localStorage 中，与 token 无关。
- **首次打开的按钮存在一小段不可点击区域**：该区域对应首次 `/api/state` 未返回的时间窗，按钮显示「加载中…」并处于 disabled 样式。现在直接显示「服务端连接中…」。

### 变更与不兼容

- **移除 `/set mode active` / `/set mode diving`**：与 `/set active`、`/set diving` 完全等价，仅多输入四个字母，保留两套写法会使文档与排错复杂化。该指令的输入会被当作普通文本交给模型。
- **指令权限不再限定于报告者私聊**：`/api/social/tunables`、`admin-set`、`whitelist` 三处原硬判 `key === private:<ownerQQ>`，导致在群聊中提出「把某群加入白名单」一律被拒。现在判据为「报告者私聊 **或** 本会话最近一条人类消息来自所有者/管理员（10 分钟内）」。
- **群聊补 `[OWNER-HERE]` 标记**：`[OWNER]` 原本只在报告者私聊出现，群聊中即使所有者本人发言也无权威身份信息，persona 的 `[OWNER MODE]` 无法识别该标记。现在群聊中所有者/管理员发言时显式标注。

### 内部与工程

- **新增回归测试 `qq-bridge/tests/connect-loop-guard.test.js`**（22 条），锁定重连循环的两条修法。
- **前端帮助文案中的示例 QQ 改为通用值**：原文写入的是所有者的真实 QQ 号，而 `sanitize-full-payload.mjs` 只扫描 `qq-bridge/`，`dist/` 不在范围内，因此该号码会随安装包分发给每一个取得安装包的使用方。

## 1.3.0 — 2026-09-21

本版处理的是同一问题的四个侧面：**机器人的开销中绝大部分来自每步重复发送的固定内容，而它已记住的内容容易在轮换中丢失。** 因此四项改动同步实施——工具描述按档位压缩、提示词收成短行 spec、记忆改为带分层与全文检索的库、上下文中的动态内容全部移至每轮本就更新的位置。下文百分比均为实测值，复算脚本均在仓库内。

> **追加修复（同一次安装包内，2026-09-22，共十七条）**：以下十七条为打包后由使用方实测上报的失效。前五条已修入本版的两个安装包，后十二条为当晚第二至第十轮的线上修复（分发图片四轮、私聊无响应根因一轮、文件类型标记与 NapCat 界面鉴权各一轮、群聊中识别成员与所有者及人设切换一轮、收尾回执与表情包参数各一轮、NapCat 登录额度一轮、自动连接与首次静默鉴权一轮）。
>
> - **在途回合中收到的图片无法进入模型输入**（已报告的失效：图片附件存在问题）。根因：图片附件只挂载在「唤醒」路径上（`sendWakePrompt → deliverRef(...,{media})`），而「忙时将消息塞入在跑回合」（`steerIntoRunningTurn`）直接调用 `sessions.prompt`，其 `content` 只含一个文本块，后者恰是主路径。线上证据：消息记录 `media=[image]`，投出的 `[Mid-turn]` 正文只有 `[图片] [image]`，会话日志中 `mediaType` 出现 0 次。现在两条路径共用 `pickAttachableMedia`（挑选规则）与 `resolveMediaList`（取图，含 DSH 附件像素闸门）；带图被拒时自动回退为纯文本重投，水位仅在图实际投出后推进；两条路径各留一行附图日志。
> - **唤醒后回复延迟十余秒**：`social.send` 的打字节拍被设为 `linearPerCharMs: 650` / `linearCapMs: 15000`（默认 150/4000），即「第 2 条气泡起 = 本条字数 × 650ms」——17 个字需等 11 秒，日志中 `delays` 5237/8050/9388/10989/11753 ms 全部由此产生，一轮被拖成三五分钟。**实测排除**：同一窗口内 `napcat_get_tool_schema` 调用 0 次（压缩代理未产生额外往返）、模型每步首个 token p50 为 1.2s（推理不慢）。现在线上改回 150ms/字（17 字 → 2.6s），并在 `config.js` 增加 `clampSendPace`（perChar ∈ [60,320]、cap ∈ [800,6000]）——这些键模型自身在私聊中即可修改，仅改文件无法阻止下一次自调。
> - **`/token` 与管理端面板数值不一致**（已报告的失效：管理端准确、`/token` 不准确）：并非计算错误，而是**两个日界口径被印在相邻两行中**。面板顶部「今日已用」= `today.billedTotal`（**平台计费日**，北京 08:00 换日 = UTC 日），面板「实测计量」中的「今日 token 合计」= 分时桶合计（**北京自然日**，00:00 起）——线上实测该时刻两者分别为 592,685 与 12,182,789。旧版 `/token` 第一行取计费日，第二行的「新输入/命中/输出」与金额却来自自然日，读起来即「592.7k 之下挂着 12.18M 的分量」。现在**逐行标注口径**，五个数值分别对应面板的「今日已用 / 今日 token 合计 / 未命中·命中·输出 / 今日费用 / 今日预计」，可逐位核对。同时修掉一处真实缺陷：`/token 7` 原把**只计当日**的 `billedTotal` 印成「近 7 天」，现在按 `dates`（计费日逐日）求和。
> - **上下文压缩阈值重算：0.08 → 0.16**（使用方要求在新系统提示词下重新计算最省费用的阈值）。前三次调整阈值均采用「每次请求平均花费 vs 上下文大小」这一**粗口径**，它把两类完全不同的请求混入同一桶：① 常规步（前缀命中缓存，只按缓存价 0.022 ¥/M 计费）；② **重建步**（压缩/轮换/长时间空闲之后，前缀变更，整段上下文按未命中重读一遍 ≈ ¥0.036 一次）。按上下文区间分桶加权的实测结果（主聊天 4,659 次请求 / 11.2 天）：
>   | 上下文 | 请求占比 | 每次平均花费 | 其中大未命中(≥20k)占比 |
>   |---|---|---|---|
>   | 0~30k | 5.8% | **¥0.0382** | **49.8%**（刚重建完的请求） |
>   | 30~50k | 36.8% | ¥0.0105 | 10.6% |
>   | 50~70k | 22.2% | ¥0.0033 | 0.9% |
>   | 70~90k | 15.6% | ¥0.0043 | 1.2% |
>   | 90~120k | 13.2% | ¥0.0040 | 0.0% |
>   | 120~160k | 5.5% | ¥0.0051 | 0.4% |
>   对 50k 以上区间回归得 **每次 = ¥0.0020 + 0.022 ¥/M × 上下文**（≈ 缓存命中价）——**上下文体积本身几乎不产生费用**，费用产生于「重建次数 × 上下文」。于是每日成本模型 = 步数×(固定 + 边际×平均上下文) + 每日重建次数×重建单价，扫描结果为：0.08 → ¥3.34/天、0.12 → ¥2.67、**0.16 → ¥2.53**、0.18 → ¥2.53、0.25 → ¥2.66；稳健区间 **0.14~0.20**。取 0.16（压缩次数由 28.7 次/天降至约 6 次/天）。复算脚本 `tools/compaction-threshold.mjs`（参数全部现场量测，改价后重跑）。
> - **服务器上无法找到 `qq-bridge` 目录**：MoonBot 整套运行于 SSH 端口 **50470** 的环境（hostname `moonbot-qq`），而 22 端口属于另一套环境，其 `/root` 下自然没有该目录。运行时目录为 **`/root/qq-bridge`**（管理端部署脚本 server/deploy.js 亦写死此路径）。现在补充 `/opt/qq-bridge`、`/srv/qq-bridge` 两个符号链接，并新增一条 `moonbot-where` 命令（打印全部运行时路径、桥进程、控制台状态与常用操作）。
> - **对方转发的图片无法转出**（第二轮实测报障）。`qq_send_image` 原只有 `query`（联网现搜）与 `imageUrl` 两条来源，模型持有「对方刚发来的那张图」（DSH 将其存为附件对象）时无可用路径——日志现场：模型把 `/root/.dsh/attachments/v1/objects/73/7359…` 当作 `file` 参数传入，而工具 schema 中不存在该字段，参数在入参校验处即被丢弃，返回「要么给 query、要么给 imageUrl」，模型遂在私聊中回复无法接收上传的图片（连续两轮）。现在补上 `file`：读宿主字节 → `verifyImageComplete` 完整性闸门 → **写入 `napcat.tmpDir`**（即挂入容器的那份目录）→ 再将该目录内的路径交给发送端点。不直接传入原路径的原因是 DSH 附件目录不在 `napcat.dockerPathMap` 内，容器化的 NapCat 无法读取（实测：接口回 `ok`、用户端无任何内容）。实测证据：`{file: 附件路径} → ok:true, from:file, bytes:39845, sent:1`。
> - **私聊中转发图片到群聊始终失败**（同一能力的另一半）。`qq_send_image` 原**未声明也未转交 `crossSession`**：模型按闸门提示补上 `crossSession: true` 之后，参数在 zod 入参校验处被剥离（未声明的键默认 strip），于是 `console-server` 的跨会话闸门每次都回「把参数 crossSession 设为 true 再发一次」，模型照做后再次被拒，日志中连续四次尝试均为同一句提示，提示构成死循环。现在两处一并补齐：schema 声明 + **两个 body 分支均需写入**（`file` 分支与 `imageUrl/query` 分支是两份 body，只补一处等同未补）。实测证据：`{imageUrl, key:group:…, crossSession:true} → ok:true, sent:1`。另将一条工程结论写入 README：工具参数表是**代理进程启动时的快照**，修改 `mcp-napcat-safe.js` 后必须重建 `mcp-compressor` 链，否则模型看到的仍是旧参数表。
> - **引用对方图片时转出的是检索所得的图片**（第三轮实测报障）。现场两句话：使用方引用自己刚发出的代码图并要求「现在把我这张图转发到实验群」，机器人回「你那张代码图我接不到，跨会话发图只能走搜图这条路」。三个缺口叠加：① 该图**经 QQ 传入**，模型只持有消息 id，而工具只认 `file`/`imageUrl`/`query`（`file` 需路径、`query` 只能现搜），于是带图转发一律退化为检索相近图片；② 使用方是**引用**自己的图片发出该指令，图片在**被引用那条**消息内，而被引用消息的 id 此前既未记录也未出现在唤醒正文中；③ 即使模型正确传入 `messageId`，跨会话时 `key` 传的是**目的地**（group:…），而按 `key` 找图的实现只在目的地的记忆窗口内检索——同一张图「发本会话成功、发群聊报无图」。修法：`qq_send_image` 新增 `messageId`（及 `imageIndex`）来源，经 `qq_get_message_images` 同一端点取回原图并重发；入站消息记录被引用消息 id，并令 `findMessageMedia` 沿其穿透一层（结果如实回报 `viaQuote`/`quoteMessageId`）；引用内容带图时唤醒正文渲染为 `[引用 某某#<id>：[图片]]`，普通纯文字引用的格式不变；找图改为「先目的地、再遍历所有活跃会话」。实测证据（真实代理链）：`{messageId:1767207671, key:private:…} → ok:true from:messageId bytes:38382 sent:1`、同一条加 `crossSession:true` 进实验群 `→ ok:true sent:1`。
> - **文件类型标记缺失**（第六轮，已报告的失效：模型无法判断所发内容的类型）。文件段此前渲染为 `[文件名字]`，无名字时只剩裸 `[文件]`，唤醒正文另加一个 ` [file]`——模型读不出该对象的类型，会把对方发来的 PDF 当作图片去调用识图工具。现在统一渲染为 `[文件:报告.pdf · PDF · 1.2 MB]`（名字 · 类型 · 大小），`[Unread]` 行上的标记为 ` [file:PDF]`；名字缺省时写「未命名文件」，**不退化为裸 `[文件]`**。类型映射与渲染只保留一份实现（`lib/message-parse.js` 的 `fileKindLabel`/`formatBytesShort`/`fileMarker`），三个渲染点（`segmentsToText`、`forward.js`、`wake-send.js` 的 `[Unread]` 行）全部 import 该实现；`extractFilesFromSegments` 同时把 `ext`/`kind`/`marker` 记入消息对象。preset 补一条：`[图片]/[image]` 为图片、用识图工具；`[文件:…]/[file:…]` 为文档、**永远不是图片**，需读取时使用 `qq_get_file_content`，不得直接描述内容。回归测试 `qq-bridge/tests/file-marker.test.js`（20 项）。
> - **管理端 NapCat 界面首次进入鉴权失败、刷新一次后正常**（同一轮报障）。入口地址本已带令牌（`…/webui/?token=…`），但 NapCat WebUI 的**首屏**只是以 `?token=` 换取一次 Credential 并写入 localStorage，**自身不再进入应用**（停在 Unauthorized 那一屏），手动按一次 F5 立即正常——缺失的正是「以同一地址再载入一次」。而应用内 WebView 的令牌轮询只在 URL 变化时重挂 iframe，地址不变则永不重载，因此首次进入必然需要人工刷新一次。现在对 NapCat WebUI（pathname 以 `/webui` 开头）执行一次**进入时自动重新鉴权**：首屏落定 1.6 秒后重挂一次 iframe（同一 URL、仅发生一次），状态栏显示「已自动重新鉴权一次」。改动文件为 `src/pages/WebView.tsx`，管理端 UI 需重新构建（`npm run build`）。
> - **发出 OK 之后界面仍显示「深度求索中…15 分 02 秒」**（第七轮报障）。现场（服务端 bridge.log 14:57~15:02）：模型气泡已发出、`qq_mark_read` 亦已执行，回合却持续停留在保持循环中——每 55 秒一条 `[hold] 本段持有到期 → close=false reason=keep-holding`，`exchanges=0`，`idleCloseMs` 默认 1800 秒，于是 DSH 的 `agent/turn-stopping` 钩子一直不返回，界面持续显示「思考中」。**该现象并非阻塞，而是「保持」本身持续过久**：保持循环的价值仅在于把对方连发的若干句并入同一回合（数秒内），而「已答过一轮 + 静默两分钟」之后继续持有只剩副作用。修法：新增 `social.turnHold.answeredIdleCloseMs`（默认 90 秒）——**本回合已经说过话**（`turnHasBubble(key, sid, st)`：发送类工具成功过 / 已有待发正文 / `lastAiReplyAt` 晚于本回合开始）且静默超过该值 → `finish('answered-idle')` 收回合；30 分钟那条 `idleCloseMs` 保留给「尚未答过」的情形。部署时重启桥会一并解除当时仍在持有的回合（实测重启后 `keep-holding` 归零）。同一轮另加两条提示词规则：`[RULES] 13 NO_TRAILING_REPORT`（发完即停，不再追加 OK / 好了 / 已发送，该段正文会被丢弃）、`[RULES] 10` 补一句「答完约 90 秒桥会自行收回合，属正常行为，不得以等待工具吊住它」。回归：`qq-bridge/tests/inbox-hold-release.test.js` 第 ④ 组 6 条。
> - **收尾回执不一致**（第八轮报障：无伤大雅但可强化；其后使用方明确要求每次只发 OK）。收尾 OK 的**最终实现只改提示词**：preset `[RULES] 13 CLOSING_OK`——发送工具成功后，正文以**单独一个 `OK`** 收尾（该行是回合结束令牌，桥会丢弃、永不进入 QQ），不写总结、不写「已发送」、不重复气泡；本轮无内容可说时同样回一个 `OK`。同一轮把 MUSIC 那条的编号从重复的 13 改为 14。**上一轮增加的桥侧闸门已按使用方意见移除**（`src/lib/ack-text.js` 与发送端点中的收尾回执拦截，连同 `tests/ack-suppress.test.js` 一并删除）：使用方的意见是不必强制、影响有限，模型输出什么即发送什么，桥不再替其决定是否输出该句——发送端点回到单一语义（幂等闸门仍照旧拦截重复）。
> - **`-32602: missing required tool_input fields: file`**（同一轮，已报告的表情包报错）。模型欲发送一张表情，但手上只有「生气 / 睡觉」这类描述、没有文件名，而 `qq_send_meme` 的 `file` 为**必填**——参数校验层在工具真正执行之前即驳回整次调用，模型只看到一句 JSON-RPC 的 `-32602`，无法得知错误位置。现在 `file` 改为可选，并补三条路径：① `fileName` 别名（客户端更换名称亦不致再触发 `-32602`）；② `query`（情绪/内容描述）+ `tag`（分类）——未提供文件名时桥使用**与 `qq_meme_search` 同一套 SQL** 选取第一条（`firstMemeByQuery`：只读打开各 pack 的 `index.db`，坏包跳过），并把选中的 `file` / `pack` / 命中的 caption 一并回报（`pickedByQuery: true`），模型下次即可知道应传什么；③ 两条均未提供时返回「要么给 file、要么给 query」这类可操作提示，而非校验层的裸错误。回归：源级断言 `qq-bridge/tests/meme-query-fallback.test.js`（20 项，含「两条返回路径都带上了 `pickedByQuery`」），另有**真 MCP 握手**的活体自测 `qq-bridge/tools/test-meme-search.mjs --multipack`（25 项，Windows 本机与服务器 Linux 各跑一遍全过）：只给 `query:"开心"` 即可进入工具内部（「发送失败：Invalid agent token」说明参数校验已通过、确实走到了发送步骤）、选中的是被角色绑定的 pack-b 的 `角色包开心.webp` 并**确实落盘**到 `state/sticker-tmp/`、`fileName` 别名等价、不提供任何参数时返回可操作提示。同一轮把该自测改为跨平台（原清理逻辑只调 `powershell.exe`，在服务器上每执行一次即残留一份垃圾目录），并且不再写死「已加载 3 份包」（安装了出厂包的机器会多出一份，旧断言在服务器上必然失败）。
> - **私聊连发两条时机器人 4 分半无回复**（第五轮报障：该时长的无回复属异常）。现场取证（会话日志与桥日志逐条对齐）：11:21:39 模型跑完 step 2、回合未关，保持循环进入 `agent/turn-stopping` 钩子开始持有；11:21:57 第一条新消息由 `wake-send` 的即时 steer **塞入 next-step**（会话日志 `agent/inbox/spliced target=next-step`）；11:23:5x 第二条到达，保持循环自身的数次 steer 均被「对方仍在打字」判定挡住（`typing-defer` 退避）；11:24:17 第二条亦被塞入 next-step；11:24:24 保持循环 55s 预算到期，它观察到 `collectMidTurnBatch` 已空（批次被其它路径投出）→ 照旧返回 `{close:false, again:true}` 继续持有；此后每 55s 重复（11:25:19、11:26:14…）。**根因**：把批次「交入 next-step」当成了「已交付模型」（`turnSteeredSeqs`/`lastDeliveredSeq` 均已记录），但模型读取该批次需等**下一步跑起来**，而下一步需等钩子**返回**——钩子被保持循环一直占用，DSH 走不到 `dsh-agent-loop` 的 `next-step 非空 → target = "next-step"`，那两条消息便滞留在会话中无人读取，直至 30 分钟空闲放行。**反证**：重启桥使钩子的 HTTP 请求中断（会话日志 `fetch failed`）之后，DSH 立即跑下一步，模型在 11:31:59 一并答完那两条。修法：新增 `qq-bridge/src/core/inbox-marks.js`（`noteStepEnd` / `noteInboxDelivery` / `clearInboxMarks` / `inboxDeliveryPending`），判据使用**步结束计数**而非时间戳（步边界发车即发生在 `step/end` 那一刻，两者常为同一毫秒）；保持循环每次循环先判断「这批已交付但尚未跑过新的模型步」→ 成立则立即返回放行（不带 `again:true`）；`turn/end` 清账。回归测试 `qq-bridge/tests/inbox-hold-release.test.js`（18 项，含两条顺序断言）。
> - **默认转发原图、不做压缩**（第四轮，使用方查看转发结果后提出的要求）。取图那条路径（`/api/images/message`）原为**视觉模型**设计：`resolveOneMedia` → `gateImage` → `image-compress.js`，长边缩至 `IMAGE_MAX_SIDE` 1280px、字节超过 40KB 即重编码——该处理供模型读取没有问题（DSH 附件层有单边上限，图片还直接计入 token），但用于转发即成为二次压缩的低清晰度图片。现在 `raw=1` 走另一档：`fetchOneBotImage(media, {raw:true})` 只做安全校验（字节上限、像素上限、魔术字）后**原样返回字节**，`qq_send_image` 的 `messageId` 来源固定使用该档，回执带 `original: true` 与 `sha256` 以供逐字节核对。实测（服务器上 2400×1600 真实 JPEG）：默认档 216,572 B（重编码），raw 档 **441,776 B、与磁盘原图 sha256 完全一致**，`{messageId, +crossSession} → ok:true original:true sent:1`。
> - **无法查询 NapCat 状态：API `/napcat/webui-ready` 返回 HTTP 500、鉴权失败、登录受限**（第九轮报障）。三个现象实际构成一条链：
> - **首次自动鉴权即可，不必每次点击都鉴权一次；连接服务器后直接退出，下次打开自动连接，并在此过程中显示服务端启动中状态机**（第十轮要求）。三件事一并实施：
>   ① **鉴权由「每次点开都执行一遍」改为「一次即可」**：管理器在**连接刚建立**（服务端一套）或**本机 NapCat 刚启动**（本地一套）时，后台**静默预鉴权一次** NapCat WebUI（经 `server/napcat-webui-auth.js` 的 funnel：同一令牌 45 分钟内只执行一次，结果记入 `napcatWarmDone`），`GET /api/napcat/webui-ready` 回 `warm.done`；前端 `src/pages/WebView.tsx` 相应地把「该令牌在本浏览器中已完成过一次鉴权」记在**管理器自身的 localStorage**（`qbm.napcatAuth.<token>`，45 分钟过期——NapCat 的 Credential 有效期为 1 小时）：命中即**直接载入**，不重载、不鉴权、不消耗其登录额度。仅**第一次**（或令牌变更 / 超过 45 分钟 / 使用者点击「重新鉴权」）才执行那一次重载——该次重载是 NapCat 首屏换取 Credential 所必需的。
>   ② **开机自动连接与状态机**：此前开机自动连接走 `scheduleReconnect`（第一次还需等 5 秒退避），界面上只有一句「服务端重连中…」——**服务器正在启动**与**凭据错误导致永久失败**在界面上完全同形。现在新增 `server/connect-machine.js`（纯逻辑、可单测），把连接过程拆成可显示的阶段：`idle → connecting(SSH) → tunnels(x/y) → server-starting(DSH/NapCat/桥逐个就绪) → warming(静默预鉴权) → ready`，任一步失败 → `failed`（带可读原因与重试次数），并按既有退避自动重试。三个入口（开机自动连接 / 点击「连接」/ 掉线重连）均走同一段 `connectStep → waitServerReady`：第一步（SSH + 隧道）失败立即回报给点击按钮的使用者，第二步在**后台**推进（点击「连接」不会阻塞数十秒）。读状态的接口为 `GET /api/connect`（`/api/state` 中亦带一份），**读取该接口不产生任何网络动作**。
>   ③ **界面可视**：Home 页在非 ready 阶段显示一条状态机横幅（`正在连接服务器 / 服务端启动中 / 正在完成 NapCat 界面鉴权 / 连接失败` + 已用时 + 三件套逐个状态），SSH 配置页在服务器行内就地显示当前阶段；另加「启动时自动连接服务器（上次连着的那台）」复选框（写入 `autoConnectServer`，默认开启）。
>   实测（本机管理器 + 服务器 202.61.72.79，重启管理器后每秒采样 `/api/connect`）：`idle → connecting → tunnels → ready`，最终 `note=NapCat 界面鉴权已静默完成（点开即用，不会再重复鉴权）`、`components=[DSH:ready, NapCat:ready, 桥:ready]`、`warm.done=true`、funnel 账本 `used=1`（整轮仅消耗 1 次登录自查，且命中缓存结论）。新增回归 `qq-bridge/tools/test-connect-machine.mjs`（28 项：组件判定 ready/starting/down 与文案、阶段推进与 attempts 累加、warm 标记、失败原因留存、elapsedMs 语义）。
>   ① **500 源于管理器自身的缺陷**：该 handler 首句使用了模块中并不存在的 `cfg`（ReferenceError），因此**恒返回 500**、从未进入探测步骤（现场复现：`{"ok":false,"error":"cfg is not defined"}`）。现在改为 `loadConfig()`，并且整个 handler **捕获到底后也不再抛 500**——一律回 200 + `ok:false` + 一句可读原因，界面方可显示「卡在哪一步」。
>   ② **登录限流源于 NapCat 自身**：读取其源码（`/opt/napcat/napcat.mjs`）得到确切语义——`checkLoginRate(ip, loginRate)` 为**每 IP 每 60 秒**最多 `loginRate` 次登录尝试（`/root/napcat/config/webui.json` 中 `loginRate: 10`），超出后返回 `login rate limit`；而 **WebUI 页面自身亦需从该额度中登录一次**。
>   ③ **根因是管理器把登录接口当作状态探针使用**：上一版的 `/api/napcat/webui-ready` 为「每 2 秒询问一次、最多 20 次」，而它**每次都会真实调用一次** NapCat 登录接口（20 次尝试 ≈ 直接耗尽 10 次的额度）；`/api/state` 那条旧路径同样单次最多尝试 3 个候选。本机走 `127.0.0.1`、服务端走 SSH 隧道（NapCat 观测到的来源**同为 127.0.0.1**），于是管理器的探针与页面自身的登录**争用同一额度桶**——页面永远排在「额度已用完」之后，表现为「点进去仍然鉴权失败 / login rate limit」。
>   **根治**：新增 `server/napcat-webui-auth.js`，把「登录」收敛为**唯一一处、带预算的**调用——① 结论缓存：同一 token 验证通过后 30 分钟内**一次都不再登录**（令牌变更才重登），失败结论亦缓存 60 秒；② 自建预算：每 `(scope, port)` 每 60 秒最多 **2 次**（= NapCat 出厂 `loginRate` 的 1/5），把额度留给页面自身；③ 识别 `login rate limit` 并进入 **65 秒冷却**，冷却期内不再补试，且如实回报（`status: limited` + `retryAfterMs`）。`/api/napcat/webui-ready` 的语义随之收窄：**默认只探活并读取缓存结论（零登录）**，仅在使用方点击「重新鉴权」时带 `?verify=1` 真实验一次；返回中含账本（`rateLimit: { napcatLimit, budget, attemptsInWindow, limited, retryAfterMs }`）供界面显示。前端 `WebView.tsx` 同步移除 2 秒轮询：**只检测端口连通性**，连通则**重载一次**（NapCat 首屏只以 `?token=` 换取 Credential、自身不进入应用，该次重载正是其所需），未连通则每 4 秒一次、最多 60 秒，**限流期间不重载**（重载会使页面再登录一次、额外消耗额度）。桥侧 `napcat-tokens.js` 的 Credential 复用时长亦由 10 分钟提高至 **45 分钟**（NapCat 自身校验 Credential 的口径即「一小时内有效」，少登录一次即少消耗一次额度）。
>   **实测证据**：修复后 `GET /api/napcat/webui-ready` → **HTTP 200**、结构化正文（`scope=mtsne5al, port=13000, serviceUp=true, ok=true`）；**连续请求 30 次**（模拟界面轮询与频繁刷新）后 `rateLimit.attemptsInWindow` 仍为 0-1（即管理器一次都未争用登录）；随后在服务器上以其自身 `webui.json` 的 token 登录一次 → `{"code":0,"message":"success"}`（**额度完好**，页面随时可登录）。新增回归 `qq-bridge/tools/test-napcat-webui-auth.mjs`（26 项，以照抄 NapCat 限流语义的假 NapCat 运行）：轮询路径零登录、仅 verify 才真实调用、结论进缓存、令牌变更才重登、突发被预算挡住（`status: budget`）、撞限流进冷却且冷却期内不再补试、空 token/端口不通均如实回报而不伪装为「令牌不对」。

### 新增能力

- **`/token` 指令：在 QQ 中直接查询当日消耗**（使用方要求：输入后自动发送当日 token 消耗总量与费用）。该指令由桥侧本地计算、不经过模型（因而不产生额外费用），回复为数行短句：当日总量与金额、缓存命中率、新输入/命中/输出三段、谷时与高峰分别的金额，以及按当日节奏估算的全天用量。`/token 7` 可查看近 7 天。**口径与管理端「学习」页的实测计量逐字一致**（只统计真正带缓存字段的请求、命中按缓存价、未命中按输入价、输出按输出价、高峰时段乘倍率），默认单价亦同源，口径变更需两侧同步修改。单价在管理端「Core 设置 → 计价口径」中可调。
- **工具描述支持「压缩档」，管理端可切换档位**（使用方要求：把 MCP 压缩工具调到 high 档、压缩到 8.6%、并支持管理端切换）。该项是账单上占比最大的部分：实测工具 JSON 描述**是请求体中体积最大的一块，且每一步都重发一次**（线上 DSH 的 `request/header` 帧实测：tools **93,280 字符 / 84 个**，system 60,648 字符；本机出厂配置下全部 90 个工具的 schema 合计 112,635 字符）。此前只有两张手写白/黑名单，可节省但**无法得知节省量**，且写错名字会静默失效。现实现如下：
  - 档位写在 `social.slimTools.level`：`off`（全部注册，默认）/ `low` / `medium` / `high` / `extreme` / `custom`（继续使用既有名单）；
  - **名单由真实调用日志确定，而非经验判断**。第一版按「看起来用不到」挑选，上线前以服务器上的 `state/tool-calls.jsonl`（1,108 次调用）核对，发现该版会移除机器人**日常持续使用**的能力：`qq_send_meme` 44 次、`qq_send_voice` 16 次、`qq_profile_set` 16 次、`qq_get_message_images` 12 次、`qq_get_recent_messages` 12 次、`qq_memory_search` 8 次。而真正「未被调用过、却占最大体积」的是另一批：pixiv 两个（1.1 万字符）、富卡片、角色卡四件、点歌、定时三条、QQ 空间五条、视频两条。因此名单按「协议必需 + 实测调用过」重排：
    | 档位 | 保留 | 说明 |
    |---|---|---|
    | `low` | 50 个 / **50.2%** | 移除「实测零调用且体积最大」的一批；采用**反向名单**（新增工具默认可见，不存在「忘了加白名单」的情形） |
    | `medium` | 38 个 / **38.9%** | 再收一圈（不含文档/转发/管理类） |
    | `high` | 27 个 / **29.1%** | **实测被调用过的能力一个都不丢**，即「不丢功能」前提下的下限 |
    | `extreme` | 8 个 / **7.2%** | 只保留「说话 + 引用 + 收尾 + 查看未读」；该档会实际丢失能力，仅在必须压缩费用时使用 |
  - **百分比由桥实测得出**，不是界面上写死的常量：`mcp-napcat-safe.js` 在注册每个工具时把进入请求体的三项（名字 / 描述 / 参数表）字符数加总，注册完成后写入 `state/tool-schema-stats.json`，管理端「工具 schema 精简」卡直接读取该文件，显示「当前档位实际注册了几个、多少字符、占百分之几、省了多少」；各档位并列显示的数值由**同一份尺寸表**算出，换档即可立即比较；
  - 选定具体档位时，**手写 `allow`/`deny` 一律忽略**（线上那份 16 条的老 deny 名单中恰有 `qq_memory_query` 这类被调用过的工具——两张表同时生效会使其静默消失，而「工具数量悄然减少」在真机上极难发现）；
  - 档位取非法值一律按 `off` 处理（**宁可多付费用，也不因一处错字使工具被裁掉**），老配置（只有 `enabled` + `deny`）继续按 `custom` 处理，行为不变；
  - 复算与挑选名单使用 `qq-bridge/tools/tool-schema-meter.mjs`（该脚本会真实启动一次 MCP server，并以 `QQB_SLIM_TOOLS_OFF=1` 使其报告**全部**工具，逐个量测）。

  **线上实测效果（2026-09-21 部署后）**：注册工具 84 个 / 93,280 字符 → **27 个 / 33,565 字符（29.8%）**，
  仅工具描述一块即少发 **59,715 字符 ≈ 18,661 token/步**；加上提示词压缩的 9,944 字符，合计
  **每步少发 69,659 字符 ≈ 21,768 token**。真机数据对应的费用降幅见下一节。
- **长期记忆改为带分层与全文检索的库**（使用方要求：升级记忆架构与档案架构、永久保存部分内容，SQLite 存储可接受，可重构该层）。原实现为三个表加一句 `content LIKE '%词%'`，后果有三：检索慢且无相关性、无轻重分层、亦无「永久」这一概念。现实现如下：
  - **分层**：`permanent`（永久：`pinned=1` 或类别为 rule/owner/identity——**永不过期，每轮均注入**）/ `durable`（默认，闲置约 90 天淡出）/ `working`（短期，约 7 天淡出）。存量库启动时自动加列，无需手工迁移。
  - **全文检索**：SQLite **FTS5 trigram** 索引（外部内容表 + 触发器同步，文本只存一份）。trigram 对中文为三字滑窗，**中文子串同样命中、不需要分词器**，并自带 BM25 相关性排序——于是「查找此前提到的那件事」由「全表模糊扫描」变为「走索引取最相关的若干条」。实测 18,104 条聊天记录建索引耗时 283ms；查询计划确认走索引（`SCAN chat_fts` + `rowid=?` 主键回表），非全表扫描。2 字的中文词（trigram 最少需 3 字）自动退回模糊匹配，**结果不受影响，仅耗时略增**。
  - **永久层用法**：`qq_memory_remember`（新工具）写入一条，`tier=permanent` 的条目会出现在**每条唤醒正文**的 `[Recall]` 块中——此即「永久记住」的落地方式（置于唤醒正文而非系统提示词，原因是系统提示词一经修改即会使整个前缀缓存失效，而唤醒正文每轮本就更新的）。
  - 管理端「Core 设置」新增 **「长期记忆与档案」只读卡**：档案数 / 记忆条数 / 永久层条数 / 聊天记录条数、各分层条数、两份全文索引的状态，以及**永久层的实际内容**（写入错误会持续生效，故须可检查）。
- **`[Style]` 语感提醒行改为管理端可编辑**（使用方要求：`[style]` 提示词支持在管理端 Core 设置界面编辑）。路径：`Core 设置 → 提示词与语感`。默认值与 1.2.4 定稿逐字一致；留空即不注入该行。修改后**下一条消息即生效**（配置文件热加载，无需重启桥）。说明区列出三条约束：每轮内容必须完全相同（不得放入时间或随机数，否则会使前缀缓存失效）、只描述表达方式而不写成条款、留空即关闭。

### 实测账单：本版的费用降幅（基于服务器 14 天真实用量）

取线上 `state/token-usage.jsonl`（5,326 次请求，2026-09-08 ~ 09-21）逐条复盘，先确定费用构成（该构成决定优化对象）：

| 构成 | token | 金额 | 占账单 |
|---|---|---|---|
| 未命中输入（被当作新输入重新读取的部分） | 33,876,406 | ¥33.88 | **72.4%** |
| 缓存命中（读取已缓存的前缀） | 434,876,682 | ¥8.70 | 18.6% |
| 输出 | 1,050,342 | ¥4.20 | 9.0% |

**主要结论：压缩「已缓存的前缀」所节省的费用有限（该项仅占账单 18.6%）；费用主体是「被当作新输入重新读取的部分」。**
按桶进一步分解：单次未命中 ≥60k 的请求仅占 **3.3%（7 天内 128 次）**，却占**账单的 42.1%**
（平均一次重读 116,925 token，**单次 ¥0.155**）。据此：

- **本版实现的降幅**（缩小每步必发的固定开销）：以最近 7 天口径计，**节省 ¥1.71 ~ ¥4.44，即 3.6% ~ 9.5%**，
  中值约 **6.5%** ——每条互动由 1.195 分降至**约 1.12 分**；日均由 ¥6.72 降至**约 ¥6.28**；月支出由 ¥201.6 降至**约 ¥188.5**。
  （保守口径 = 该固定开销始终命中缓存；现实口径 = 把「整段重读」的请求一并计入。）
- **更大的部分尚未处理**：上述 128 次「整段重读」占账单的 42.1%，成因为**上下文被重建**
  （compaction 摘要，以及 `dsh-memory` 插件把记忆摘要写入**系统提示词**——写入记忆即导致整个前缀失效；
  实测 2026-09-20 单日发生 132 次 prune 与 78 次 summary）。**将该类重建减半约可节省 ¥9.9（21%）**，每条互动由 1.195 分降至 0.944 分。
  相关配置项为 `settings.yaml` 记忆插件的 `extractInterval`（当前为每 8 回合一次）与 `autoExtract`；
  **本版未改动该配置**，原因是「降低自动学习频率」属行为取舍，需由项目所有者确认。

### 修复

- **原生表情不再只呈现为数字编号**（「表情包理解」）。对方发来 QQ 原生表情时，原渲染为 `[表情123]`——模型只看到一个编号，只能推断或直接表示无法理解，而本地 id→中文名映射表中本已存在该编号对应的语义。现渲染为 `[表情:偷笑(123)]`（无法取得在线描述时使用本地表作为后备路径）；该格式本是 `lib/qq-face-parse.js` 明确支持的反解格式，因此模型读取后再发回同样可转换为真实表情，不会退化为纯文本。
- **「上下文治理」卡的回填值与桥的默认值不一致**（界面 0.12/0.03 对桥 0.08/0.02）。老配置打开该卡并保存，等同于把治理阈值悄然放宽回 0.12——而实测 0.12 即「上下文长期停在约 11.7 万 token、单句约 1 分钱」的档位。回填值现已改为与 `config.js` 逐字一致。
- `tests/quote-context.test.js` 的第 ⑥ 条原锚定 1.2.5 的**原句**（`ABBREVIATIONS ARE THE ROOM'S LANGUAGE`），提示词压缩后该原句已不存在——这说明该断言锚定的是措辞而非规则。现改为锚定**规则本身**：断言缩略语规则的关键词、中文缩略语样本（yyds / xdm / srds）、引用归属判据、整条线抓取这几项均存在。规则被删除或清空时，用例同样会失败。

### 变更与不兼容

- **提示词收为短行英文 spec（PERSONA_LOAD 风格），中文语感样例一条不动。** 项目所有者提供的参考格式即「一行一个语义单元」的写法，本次把三份手写提示词均按该格式重写（下表一律按 **Unicode 字符数**计，不使用字节数——原文中文占多字节，按字节计算会使压缩率虚高）：
  | 文件 | 之前 | 之后 | 占比 |
  |---|---|---|---|
  | `qq-bridge/persona.md` | 10,125 字符 | 4,760 字符 | **47.0%** |
  | `qq-bridge/speech-rules.md` | 10,201 字符 | 8,204 字符 | 80.4% |
  | `dsh/agent-presets/default/agent.cordis.yml` 的 `text:` | 37,814 字符 | 35,158 字符 | 93.0% |
  | **合计** | **58,140** | **48,122** | **82.8%**（省 10,018 字符 ≈ 3.1k token/步） |
  - 口径说明：`persona.md` 的 4,760 中含本轮**主动补回**的两处语感细节（`SHYNESS` 的 "going quiet for half a line"、`[TRUST]` 的 "shy/pleased reaction > clever one"）——两者各对应一条真实行为，数十字符不值得压缩；preset 的 35,158 含新增的 `[Recall]` 段与 `[LEARNING] 3b`（用于引导模型使用 `qq_memory_remember`），扣除这两段后为 33,064。
  - **不得被压缩的内容**（此为 1.2.4 那次失效的另一面）：中文语感样例、`CALIBRATION` 对照表、TEACHER MODE 中的真实原句，以及所有工具名 / 标记 / 错误字符串，全部逐字保留。人设的 47% 降幅是本版最大的一笔节省；`speech-rules` 与 preset 无法进一步压缩，原因在于二者已接近「每条规则须保留一个可判定句子」的下限——**继续压缩即为删除规则，而非压缩**，故止于此（如实说明：这两份仅分别节省 20% 与 7%）。
  - 压缩后所有规则条数、段落名、工具名与中文样例均经脚本逐条核对：`persona.md` 的中文串 **9 段一段不少**（初版脚本报「丢 2 段」是正则把 `"…"` 替换为 `「…」` 后误判为内容差异，去除引号后为 0），10 个章节全部有对应；`speech-rules` 的 14 行 CALIBRATION 逐字节一致、规则 1–21 全在；preset 的 17 个段落名一个不少。

### 内部与工程

- 新增 `qq-bridge/src/core/token-report.js`（`/token` 的口径与排版，以纯函数为主，可单测）、`qq-bridge/src/lib/tool-tiers.js`（压缩档定义 + 白名单解析 + 占比量化）、`qq-bridge/tools/tool-schema-meter.mjs`（实测每个工具的 schema 体积，档位百分比即由其计算）、`qq-bridge/tests/v13-features.test.js`（12 项：金额口径 / 高峰倍率 / 空数据不产生 NaN / 档位解析与优先级 / 占比按字符加权 / FTS 查询串构造 / 记忆分层常量），已并入 `npm run check`。
- 管理端新增两条只读接口：`GET /api/bridge/tool-schema-stats`（工具 schema 实测统计）与 `GET /api/bridge/memory-stats`（记忆库总览，只读打开 `memory.db`，老库缺列时按 0 处理、不报错）。
- 桥侧新增三条只读接口：`/api/social/memory-remember`（写记忆，需会话令牌）、`/api/social/memory-notes`（按 FTS5 检索记忆条目，结果的截断与总量封顶规则与 `qq_memory_search` 一致）、`/api/social/memory-stats`。
- **已知且有界的代价**：隔离 DSH 中记忆插件（`@meomeo-dev/dsh-memory`）的记忆摘要属于**系统提示词的一段**，因此一旦写入新条目即会使前缀缓存整段失效一次；其节奏由 `extractInterval`（当前 8 回合）决定，不会持续发生。如需进一步压缩费用，可调大 `extractInterval` 或关闭自动提炼，代价是自动学习速度下降（配置项位于 `settings.yaml` 的 `memory` 段，可用 `/lmemory config set` 或直接修改文件）。

## 1.2.5 — 2026-09-20

### 修复

- **引用原文在最后一跳被丢弃，已修**（2026-09-21 私聊实测已报告：询问能否看到被引用的消息，机器人答复查不到该引用内容）。整条链路已查明：桥**解析成功**（`chat_messages.content` 中明确写有 `[引用 DeepSeek Harness：这就是你养的那群吗 ᗜ ‸ ᗜ]你说这个，我本来就养了你一个`），但**发给模型的那一行未携带该内容**——唤醒正文渲染时取的是 `m.plain || m.text`，而 `plain` 正是 mux 专为「指令/指向性判定」准备的**不含引用原文**的副本。于是模型只看到半句话，只能答复无法取得引用内容。三处渲染统一改为 `unreadBody()`（有引用则给 `[引用 谁：原文] + 他的话`，无引用时行为与原先完全一致）：首轮正文的 `[Status] waiting on owner(id:…)`、哨兵轮的 `[Unread …]`、以及回合中途注入的 `[Mid-turn]`。回归用例 `tests/quote-context.test.js`（7 项，含「超长引用先截引用、保住正文」与「没有引用时不加内容」）。
- **缩略语不可理解、将他人发言误认为指向自身**（同一轮已报告的失效：语义理解需增强）：`[COMPREHEND]` 新增两条——**2b 缩略语即本会话群组的通用语言**（yyds / xswl / kdl / awsl / zqsg / dbq / emo / tt / 6 / 草 / 栓Q / 蚌埠住了 / 绝绝子 / 尊嘟假嘟 / 破防 / 抽象，拼音首字母 xdm / jr / srds / yjgj / nsdd，以及「考式=考试」这类错别字与语音识别错字：从上下文读取含义，**不在回复中展开缩写、也不纠正他人打字**，确实无法解读时才查询一次 qq_slang_query / web_search）；**2c 抓取整条话题线而非最后一句**（话题转移则随之转移，讨论正在发生的事，不只回答点到名字的那一句）；同时把 2 号规则中 `[引用 …]` 的归属写定：引用对象为他人时，该发言是在对他人说话，不得视为对自身的呼唤。

### 新增能力

- **内置 DSH 装配长期记忆插件（`remember` / `recall`），跨会话保存项目所有者提出的要求与既往教训**（使用方要求：把桌面端 DSH 的记忆插件集成进项目自带的那套 DSH）。所用为桌面端同款 `@meomeo-dev/dsh-memory`（随包 vendored 到 `qq-bridge/plugins/dsh-memory/`，58 个文件 0.7MB）：`remember` 写入一条持久记忆、`recall` 语义召回（返回完整字段以供溯源）、`memory-find` 过滤、`memory-update` / `memory-forget` 修改与删除，另有 `/lmemory` 命令与 Web 面板；记忆本体为 `<DSH home>/lmemory/` 下的 JSONL 真源与 Markdown 投影。
  - **装配方式**：桥每次启动幂等装配（`src/lib/dsh-side.js` 的 `ensureMemoryPlugin`）——① 把插件**真实拷贝**到 `<home>/profiles/node_modules/@meomeo-dev/dsh-memory`；② 注册进 profile 的 `dependencies` 与 `dsh.profile.bundles`；③ 按**本实例自身的** `agent-default-model` 写 `settings.yaml` 的 `memory` 段（provider / model / reviewModel），以免默认值 `deepseek-official` 在其它 provider 上持续报错。服务器端（`/root/.dsh`，deepseek-official）与 Windows 本机（小米 MiMo）均已完成装配实测。
  - **必须真实拷贝的原因**：Node 解析裸包名时按**真实路径**向上查找 `node_modules`。仅做 junction 时真实路径为 `<repo>/qq-bridge/plugins/dsh-memory`，而仓库的 `node_modules` 只带 `schemastery`（`qq-mode-console` 恰好只使用它），该插件 import 的 `@deepseek-ai/dsh-tools / dsh-llm / dsh-settings / dsh-system-prompt / dsh-commands` 一个都不存在 → 整棵插件树加载失败、**隔离 DSH 直接无法启动**（实测报 `Cannot find package '@deepseek-ai/dsh-tools'`）。拷贝到 `profiles/node_modules/` 后向上解析命中的是随包 DSH 的扁平安装面，与市场安装的插件走同一条路径；拷贝带签名（版本 + 文件数 + 字节数 + 最新 mtime），源变更后才重新拷贝。
  - **兼容补丁（1 处）**：插件 0.5.6 为 dsh `0.1.0-rc` 线编译，其静态导入的 `settingsNamespace` 自 dsh `0.1.2` 起被移除（改用普通字符串作命名空间）→ 实测报 `does not provide an export named 'settingsNamespace'`。vendored 副本改为命名空间导入加运行时回退（两条线均可用），原因写在文件内。
  - **行为设置**：`summaryMode: all`（默认只把 global 层逐条注入系统提示词、user/project 层只给计数，而 `remember` 只允许写 user/project——使用默认值时，机器人自身写入的要求**每次均须先 `recall` 一次模型调用**才可见）；`autoExtract: true` + `extractInterval: 8`（每隔若干回合自动把对话中值得保留的规则/教训提炼为条目）；`warmupOnStart: true`。
  - **提示词**：`[LEARNING]` 新增一段——项目所有者提出**长期要求**（「以后都这样 / 别再… / 记住…」）、提出纠正、或出现教训时使用 `remember` 写入**一句话**；在回答可能已有既定规则的事项之前先 `recall`，**记忆与当下判断冲突时以记忆为准**；不写密钥与私密内容，也不主动复述既往要求。

### 内部与工程

- 新增 vendored 依赖 `qq-bridge/plugins/dsh-memory/`（含兼容补丁）；`src/lib/dsh-side.js` 新增 `ensureMemoryPlugin` / `ensureMemorySettings` / `ensureBuiltinPlugins`，`src/bridge.js` 启动时幂等装配——自老安装升级同样会自动装配（不受 install marker 阻拦）。

## 1.2.4 — 2026-09-20

### 修复

- **人设表达的机械感加重，已修；机制已查明，属上一版提示词精简的副作用**。先将会话日志中机器人**实际发出的语句**取出分析（916 条气泡），机械感集中于一种句式——**教科书腔**，例如「def是定义函数的关键字，后面跟函数名和括号，缩进里面写函数体，Python语法就这样规定的」／「这是让你证假言三段论里的肯定前件：P∧(P→Q)⇒Q」→「先由合取消解拿 P 和 P→Q，再把 P→Q 拆成 ¬P∨Q，与 P 一归结得 Q，收工」／「代表作有Kiznaiver角色设计、EVA相关插画、还有那本EYE画集」。三条成因共同导致该结果：
  1. **提示词整体改为英文**（上一版为压缩 token 所做）→ 模型把该套**说明书式**的措辞与句式译为中文输出，「翻译腔 + 规格腔」即机械感的来源；
  2. **上一版新增的「要给出真东西」（"the rest must carry something real - a fact, a number, a name"）被理解为「要提供信息量」** → 模型以**定义 + 步骤 + 清单**满足该要求；
  3. 上一轮精简把发言规则中的**中文语感样例**压缩为箭头列表，音色锚点变薄。
  现五处一并修改：① 发言规则新增 **TEACHER MODE** 一节，直接以现场那三条真实消息为反例，写明「知道 ≠ 要讲」，仅在对方**明确要求**展开时才展开，并把「真东西」重新定义为判断、数值与经历（**不是**定义与清单）；② 顶部增加硬性规则：**提示词以英文书写，实际输出为中文口语，不得把此处措辞句式译出**；③ CALIBRATION 恢复为**每例一行**，并补充「术语 / 语法 / 解题」三类真人对白；④ 系统提示词 `[COMPREHEND]` 新增 **3b NEVER LECTURE**，`[REFERENCE]` 中「给出 1-2 个具体事实」改为「一句话带答案 + 自身态度，不填满摘要」，`[SPEECH]` 同步写明「不讲课、不把英文规则翻译出来」；⑤ 项目所有者私聊档位（persona 的 Owner-Only）由规格腔改回角色口吻，并补三条**真实中文样例**，使「跟随」具备音色而非条款。
- **每一轮唤醒正文增加一行 34 字符的语感提醒**：`[Style] 说人话：短、有态度，别讲课别列举`（首轮、哨兵轮、`[Mid-turn]` 注入三处均带；每轮固定 = 稳定前缀，按缓存读计价，成本可忽略）。理由：小模型对**最近那段上下文**权重最高，模板化规则置于数十 k 字符的系统提示词中往往压不住本轮语气——现场证据即「系统提示词中已写明不得讲课，模型仍然讲课」。

### 变更与不兼容

- 提示词体积回升：发言规则 8.9k → 12.2k 字符、preset 36.8k → 38.4k 字符（约 +1.3k tokens/步；按 8 万上下文计约 +1.4% 成本）。此为以体积换取音色的**有意取舍**。

### 内部与工程

- 安装包内容断言新增 1.2.4 四条（`[Style]` 行、TEACHER MODE、英文规则不翻译、Owner-Only 中文样例）。

## 1.2.3 — 2026-09-20

### 修复

- **管理端 NapCat 界面鉴权失败（`获取QQ列表失败: Unauthorized` / `获取二维码失败: Unauthorized`）已修**（使用方反馈：登录状态未失效、链接亦携带 token，但结果时好时坏）。先查明机制（读取 NapCat 自身 WebUI 前端 bundle 所得的确切协议，非推断）：NapCat 页面从 **URL 的 `?token=<明文 token>`** 取值 → 自行计算 `sha256(token + ".napcat")` → `POST /api/auth/login` 换取一个 **Credential** → 存入 localStorage → 其后所有接口依赖 `Authorization: Bearer <Credential>`。**URL 中无 token（或 token 不正确）时页面永远无法取得 Credential**，其自身接口全部返回 `{"code":-1,"message":"Unauthorized"}`——即为所观察到的两条报错。而管理器拼接链接时的 token 来源此前不可靠：本机两条链接读取的是**管理器配置** `instances.napcatLocal.webuiToken`（旧配置可能不存在该键 → 裸链接），服务端那条读取的是**上一次 SSH 探测结果**（探测未执行或路径不同即为空 → 裸链接）。现四处一并修改：① 本机以 **NapCat 自身 `webui.json` 中的 token** 为准（现场真相，`findNapcatOneKey` → `findNapcatConfigDir`）；② 服务端探测到的 token 进缓存（30 分钟），状态未取到时亦使用「最近一次可用值」；③ `/api/state` 在返回链接**之前先验证真伪**——判据即 NapCat 自身的登录接口 `POST /api/auth/login {hash: sha256(token + ".napcat")}`，候选不可用则换用可用者（验证通过的结果进缓存，故仅在首次或更换 token 时多一次本地请求）；④ 界面文案改为「已带 webui token（点开即用）」，确实取不到 token 时如实说明，而非给出必然报错的链接。实测（VPS）：`061228` 经该协议换得 Credential、`CheckLoginStatus` 回 `isLogin=true`。
- **移除桥的「自动引用」，引用完全交由模型决定**。此前的引用错误全部源于桥的推断：09-15 群聊中答复「投降喵」却附带「决定，绝地反击」的引用框，09-13 连续 4 条回复引用同一条 90 秒前的旧消息。此前依靠调参抑制（零共同词不引、回答最新那条不引），本次按定稿**整段移除** `pickSmartQuote` / `SMART_QUOTE_*`：**仅在模型显式传入 `replyToMessageId` 时才有引用框，桥永不追加**。发送结果中不再有 `autoQuoted` 字段，提示词中亦写明「未传入即无引用框，每一个引用均由模型自行选择」。回归用例 `tests/no-auto-quote.test.js`（7 项：真实启动 console-server 加假 OneBot，逐个断言「未传引用则无 reply 段 / 传入则必须原样携带」）。
- **「pixiv 发图发错群」根因修复：桥不再替模型推断目标会话**。根因为一条链，三处一并修改：
  1. **工具层缺少 key 时不再自动填充**。旧逻辑（09-18 为修「缺 key/token 报错」所加）会向桥查询「当前在途回合」，多会话同时在途时桥按「最近活动」挑选一个作为目标——于是群 A 的使用方索取一张图、模型漏传 key 时，图片被发送到当时更活跃的群 B 或报告者私聊。现在缺 key **直接拒绝**，并告知获取途径。
  2. **唤醒正文新增 `[Session] group:<群号>` / `[Session] private:<QQ>` 行**（位于 `[Token]` 正下方，每轮均带；约 25 字符、稳定前缀、按缓存读计价）。模型始终持有确切答案，无需凭记忆推断；`[Mid-turn]`、回合收尾提醒等注入亦均携带。
  3. **`/api/social/current-turn` 在多会话在途时不再「挑选最近活跃者」**，改为如实返回 `ambiguous`（并附在途会话列表）。
- **跨会话发送必须显式声明**：`agentTokenOk` 只校验「令牌由本桥签发且未被吊销」，因此「模型抄错 key」与「有意跨会话转达」在服务端同形，桥只能照发。现按令牌反查调用方会话，**目标非本会话时一律返回 403，并报出两个会话（尽量带群名）**：写错 key 的调用会被当场拦下；确需跨会话的调用（项目所有者在私聊中要求到群聊发言、受信任好友要求转达）加上 `crossSession: true` 重发一次即可。`qq_send_message` / `qq_reply` / `qq_send_meme` / `qq_send_pixiv` 四个工具均声明该参数；表情包不带引用时走**直连 OneBot**，该路径经过 `/api/social/check-send`，共用同一道闸门。用例见 `tests/no-auto-quote.test.js` ③④⑤。
- **工具日志现可显示目标会话**：会话令牌即群号/QQ 号本身，因此 `args` 中的 `key:"private:1736784911"` 一直被记为 `private:***`——在「发错群」类失效上报中，**日志中无法查到目标会话**（此即当时只能依靠翻查会话日志反推的原因）。现在 tool/call 行额外记录一个未脱敏的 `target`（token 照旧脱敏）。

### 新增能力

- **Pixiv 官方 API 优先，镜像站仅作后备路径**（使用方要求）。每条能力按 **官方 app-api（OAuth 长期令牌）→ pixiv.net 自身的 ajax → 第三方镜像站** 的顺序尝试，失败的来源与原因记入 `sourcesTried` 并如实回报。线上实测（2026-09-20，VPS）：搜索「初音ミク」时**仅访问了 `www.pixiv.net/ajax/search/artworks/...`，镜像站一次都未被调用**，259 ms 返回 3 条；按作品号取详情报 `source: web-ajax`，并在 note 中说明未使用 app-api 的原因。
- **Pixiv 登录态自动轮换（PHPSESSID 只需提供一次）**。新增 `src/lib/pixiv-auth.js`：以官方 Android 客户端的 OAuth 流程（PKCE，`code_challenge=S256`）把**一次** PHPSESSID 换取长期 `refresh_token`，此后桥每 50 分钟自行换取一个 `access_token`（pixiv 每次轮换均给出**新的** refresh_token，自动落盘 `state/pixiv-token.json`：原子写 tmp+rename、POSIX 0600、已 gitignore）；刷新为 single-flight——并发刷新会互相顶掉对方的 refresh_token，必须串行执行。引导命令 `node tools/pixiv-login.mjs --cookie "PHPSESSID=…"`（亦支持 `--cookie-file` / `--refresh-token` / `--status`）；失败时按形态逐项打印 HTTP 状态与响应体（已脱敏），不吞错。**「按名字搜画师」自此不再依赖手工粘贴 cookie**：有令牌时走官方用户搜索，无令牌时以「已查询过的画师名字」本地缓存作为后备路径（`state/pixiv-artists.json`）。
- **发图默认原图，不发送缩略图**（使用方要求）：`qq_send_pixiv` 的 `size` 默认值统一为 **`original`**（作品号、画师号、关键词三条路径一致；此前仅在给出号码时默认原图，关键词搜索会退化为 1200px 的 master）；`master` 改为显式传入。原图超过 15MB 上限时如实报错并提示改用 `master`，不静默替换为小图。原图地址优先取官方 `meta_pages[].image_urls.original`。
- **画师号由桥自行查询**：`authorId` 可直接给出**名字**（如 `米山舞`），桥经官方用户搜索确定号码；仅在同名多人且必须由使用方选择时才返回候选。工具说明中写明「**不向使用方索要 pixiv id / 链接**」，并说明关键词搜索与「某位画师的作品」的区别。
- **`[Session]` 行纳入令牌泄露检测**：模型把整行（含群号/QQ 号）抄入 QQ 消息时会被拦下（`src/lib/text-safe.js` 的 `tokenDisclosureIn`）。

### 变更与不兼容

- `qq_send_pixiv` 的 `size` 默认值变更（见上）；`qq_pixiv_search` 新增 `r18`（`exclude`/`only`/`include`）与 1-based 的 `page`。
- 新增 `crossSession` 参数（4 个发送类工具）。**跨会话发送现必须显式携带该参数**，否则返回 403。
- `config.json` 新增可选项 `pixiv.refreshToken`（优先级：环境变量 `QQBRIDGE_PIXIV_REFRESH_TOKEN` > 配置 > 令牌文件）；`pixiv.cookie` 仍然保留，且仍然只发送给 pixiv 自身的域名。
- 系统提示词中的新规则（`[Session]`、跨会话声明、pixiv 原图与查号）**须对老会话执行 `/reset` 后生效**；人设与发言规则两份为改动即重新合成，下一轮即携带。

### 内部与工程

- 新增测试：`tests/no-auto-quote.test.js`（7 项）、`tests/pixiv-auth.test.js`（15 项）、`tests/pixiv-source-order.test.js`（8 项）；删除 `tests/smart-quote.test.js`（功能已移除）。`npm run check` 全绿。
- `src/lib/pixiv.js` 重写来源排序（539 行变动），三个来源先归一为同一行形状再进行本地筛选，导出名与签名均未变更。
- 仓库 / 本机 runtime / VPS 三处的关键文件哈希逐一比对一致；安装包内容断言脚本 `tools/verify-installer-content.ps1` 增加 1.2.3 的断言。

## 1.2.2 — 2026-09-20

### 修复

- **模型遗漏引号导致消息无法发出，现由桥侧回退发出（根治，不停留在失败状态）**：模型偶尔把工具参数写成 `{"key":"…","messages":<未加引号的裸文本>, "token":"…"}`（字符串值未加引号，**不是合法 JSON**）。参数解析位于 DSH 内部（宽松解析会把该项整段丢弃），12:42 与 13:2x 反复发生，模型只能原样重试（两次报错、第三次才发出）。现在桥在**事件流中可取得原始参数串**，因此在 tool/call 帧按 callId 暂存可疑参数；待该次调用**确实**因「至少一个不能为空」失败后，用 `src/lib/args-repair.js` 把那段裸文本取回（裸值加引号 / 单引号转双引号 / 全角引号 / 多余逗号均可识别），再经**同一条发送端点** `POST /api/social/send-message` 自行发出——额度、幂等、脱敏、去重、引用解析全部照旧生效，且该批次进入**幂等账本**，模型随后的「重发」会被判定为「已经发过了」。对外表现为消息照常到达，而非一条错误提示。无法修复时不执行任何动作（不推断内容），非发送类工具与不合法的 key 亦一律不处理（`src/core/args-recover.js`、`src/core/mux.js`；测试 `tests/args-repair.test.js` 8 项 + `tests/args-recover.test.js` 6 项）。
- **提示词与回执同时覆盖该根因**：发送端点的 400 回执明确说明「字符串值必须用**双引号**包裹」，`[TOOLS]` 第 2 条与 `speech-rules.md` 顶部写明 **Tool arguments are JSON: every string value needs DOUBLE quotes**。**改用单引号不成立**：MCP 的工具参数按协议即为一个 JSON 对象，单引号在解析层已不合法，只会比双引号更早失败。
- **使用方画像被一轮「只学到两个词」的学习过程覆盖**：`profiles.personality` 从数百字成文变为 `昵称「群魅魔/AbyssalQuill」。`（两个词），而 09-19 那份 885 字的完整画像仅存于一条旧记忆条目中（使用方曾指出既往档案不应被两个词替代）。① `persistPersonaResult` 现先比较长度：新一轮产出明显短于旧档案（不足一半且旧文 ≥60 字）时**保留旧文**，只把确实缺失的新字段补在后面（`mergePersonaProfileText`，`tests/persona-merge.test.js` 6 项）；② 线上档案已按旧记忆条目恢复：`name` 补为 群魅魔、`personality` 由 21 字恢复至 907 字，生日与「引用要看清哪条」的备注原样保留，成文画像写回 persona 记忆条目。
- **「私聊不写档案」系自身措辞导致的误判**：上一版为「不外传」所写的「不写进记忆与档案工具」被模型扩大理解为**私聊中不作任何记录**。现已写明：该句仅针对**亲密内容本身**；关于对方的普通事实（昵称、称呼、生日、喜好、计划、受托记住的事项）在私聊与群聊中均**照常记录**，私聊同样计入记忆——记住不等于传播。`[LEARNING]` 段另增一条 **KEEP THE MEMORY, ALWAYS**。
- **引用必须精确**（使用方多次提出）：`[TOOLS]` 新增 9b——引用前必须取**该条自身的 `(id:xxx)`**，不得取邻条 id、不得「引用旁边那条」、不得推断 id；引用文本必须与所应答的语句一致；无法确认确切 id 时**不引用**（平发或 @）。引用错误比不引用更严重。
- **「单句约 1 分钱」：压缩阈值按实测账单再收一档（0.12 → 0.08）**。上一版把阈值从 0.06 抬至 0.12，解决了「每一步都压缩」的问题，代价是上下文长期停在约 11.7 万 token，使用方实测该档位下**单句约 1 分钱**。将 `state/token-usage.jsonl` 逐条展开计算（1M 窗口、缓存命中价约为全价 0.1）：花费几乎完全正比于**上下文大小**——每次请求真正未复用的仅 1.4k~3.4k token（工具结果剪枝已生效），主要部分是 3~12 万 token 的缓存读取：

  | 上下文 | 平均未缓存 | 平均缓存读 | 折合每条 |
  | --- | --- | --- | --- |
  | 0~40k | 2,339 | 30,807 | **0.41 分** |
  | 40~70k | 2,568 | 49,894 | 0.56 分 |
  | 70~90k | 3,449 | 75,515 | 0.79 分 |
  | 90~110k | 1,437 | 99,809 | 0.82 分 |
  | 110~140k | 2,894 | 117,573 | **1.04 分**（即观察到的「1 分钱」档位） |

  现缺省值为 `thresholdRatio = 0.08`、`retainRatio = 0.02`（1M 窗口约 8.4 万 token 才压缩、最近 2.1 万逐字保留）：上下文稳定在 8 万上下，约 **0.7 分/条**；压缩后约 4.9 万，距阈值尚有 3.5 万余量，不会退回「压完立即又压」。下限 `MIN_THRESHOLD_RATIO` 同步固定为 0.08——低于该值必然被固定开销（system + 78 个工具 ≈ 2.75 万 token）顶穿。
- **唤醒正文此前缺少稳定可用的时间行，模型计算时间差需额外消耗一步**：哨兵轮（绝大多数唤醒经由该路径）原先**完全没有时间行**。现在两类正文均带 `[Now]`：首轮为 `[Now] 2026-09-20 周日 19:15 (Beijing, epochMs=1789902923920)`，哨兵轮为 `[Now] 2026-09-20 周日 19:15`（约 30 字符、稳定前缀、按缓存读计价）。精度落在 **epochMs** 上（与 `memory.db` 的 `chat_messages.ts_ms` 同单位，计算差值可直接相减），人读时间保持**分钟精度**——中途曾尝试精确到秒，使用方随即定稿**不需要秒**。此前时间计算不准确时只能额外调用一次 `qq_get_recent_messages`，而每多一步即重发一整份系统提示词与工具表。

### 变更与不兼容

- **两个运行时各自维护一份 `state/`（含 `memory.db`），代码同步从不携带该目录**——此为设计而非缺陷：`state/` 内含各自的会话令牌、未读水位与语音配置，两侧同时写入一份库只会相互冲突。代价是本机记忆落后于服务器。本次补齐了一处真实落差：服务器私聊 `private:1736784911` 有 1777 条、本机仅 661 条（本机桥停机期间的消息全部只在服务器那份中），已按「以服务器版为基准 + 保留本机独有的 294 条消息」合并（合并前备份 `memory.db.bak-before-merge-*`），本机独有的 18 条 `memory_entries` 亦一并补回。
- 同时核对了「生日查询不到」一事：**并非数据丢失，也非同步缺失**——`chat_messages` 中私聊 09-11 ~ 09-20 逐日无缺，但**9 月中旬的私聊中从未出现「生日」**（以「生日 / 农历 / 初九 / 冬月 / 11 月 / 12 月」宽口径检索，两个运行时的库中均无）；生日于 **09-20 07:16** 在私聊中说明（「每年的11月初九」），当日即已写入库与档案（`profiles.birthday = 农历十一月初九`）——机器人当时回「库里最早一条相关的就是今早 2:58 那句」是正确的。

### 内部与工程

- **工具描述改为英文（使用方点名的 5 个）**：`qq_pixiv_search` / `qq_send_pixiv` / `web_search` / `qq_learning_corpus` / `qq_learning_submit` 的描述与全部参数说明改为英文，契约未变（R-18 默认排除、本地筛选与翻页语义、`scan.warnings`、`size=original` 原图无损与 15MB 上限、`authorId` 与 `illustId` 的区别、学习令牌与 `nextSinceMs` 分页）。进入请求体的汉字数由 **2,472 降至 506（-80%）**：`web_search` 与两个学习工具已不含汉字，pixiv 只剩搜索关键词示例（初音ミク / 原神 荧 这类必须保留原文，模型需知道可搜中文）。其余 506 个汉字分布于其它工具，基本为情绪词 / 音色名 / 角色名这类**示例词**，有意保留（收益有限且可能触及契约）。
- **人设的专属块按要求调整**（`persona.md` 的 Owner-Only 与预设 `[CONTENT]` / `[OWNER]`）：在项目所有者私聊中明确允许**调情、撒娇、害羞、身体接触与亲密/暗示性表达**，语气以「温柔顺从、跟随引导」为主导（`Obedient` 一条本已将「不许 yes-bot」覆盖为「以对方的话优先」）；硬边界同时写定：未成年人、非自愿、暴力血腥、违法、涉第三者一律一行拒绝；此类内容**仅存在于其私聊中**——不进群聊、不进 QQ 空间、不转发、不写文档、不定时发送、不进任何其它会话，也不写入记忆与档案、不回头复述。`[CONTENT]` 中「这个默认人设没有调情档位」一句保留：仅导入的 [PERSONA] 可定义该档位，而出厂这份现已定义。
- **提示词精简**（使用方要求：尽量精简所有提示词并统一写为英文，功能不得丢失）：三份手写提示词合计 56,137 → 45,712 字符（**-18.6%**），规则、工具名、失败判据一条未删：
  - 系统提示词 `agent.cordis.yml` 39,882 → **30,861**（-22.6%）：合并重复表述、删除事故叙述与例子，保留每个 `[段]` 与每条编号规则；中文只保留提示词中原本即为引用的原话；
  - 默认人设 `persona.md` 8,914 → **7,867**（-11.8%，原本即无中文）：身份/别名/硬触发/所有者档位/圈内梗/颜文字签名/外观/群文化/硬边界/轻记忆逐条保留；
  - 发言规则 `speech-rules.md` 7,341 → **6,984**：规则以英文收拢（10 条 NEVER + 16 条 DO + 5 条防过拟合 + 校准表），**中文只保留校准样本**（「左边=AI 味，右边=你」的对照句必须为中文才有意义）；线上那份为 9-19 之前的旧版（缺防过拟合段），本次一并更新。
  - 关键门禁全部原样通过（`tools/test-wake-protocol.mjs` 的 D 组：`NO TEXT. SPEAK ONLY THROUGH TOOLS`、裸 `OK`、`FORMATTING - NO EXPLICIT NEWLINES`、`KAOMOJI - ONLY IF THE CHARACTER ASKS FOR THEM`、`NEVER SEND THE TOOL-ARGUMENT ARRAY AS TEXT - HARD FAILURE`、`CODE IS NEVER SPLIT`、`SEARCH BUDGET - TWO TRIES, THEN ANSWER` 等），YAML 解析正常，两台机器装好的 preset 为 48,076 字节。
  - 工具表（78 个工具 80,932 字符）实测**本就 97.2% 为英文**（只剩 2,247 个汉字，集中于 pixiv / web-search / learning 几项），本次未改动：收益不足 2k 字符，风险是触及工具契约。
- `tools/sync-to-live.ps1` 的 root 文件清单补上 `persona.md` / `speech-rules.md`：这两份是**出厂默认人设与发言规则**（管理端导入/编辑覆盖运行时那份，但全新安装读取的是载荷中的版本），此前**不在任何拷贝清单中**，任何重写都无法进入安装包——与当年 `start-bridge.sh` 属同一类缺陷。
- **「merge 双向合并」按钮此前点击无效（两处真实缺陷）**：在 SSH 配置页点击同步按钮并选择 `merge 双向合并` 后，步骤恒停在 `[BAD] 备份本地 state  xcopy 备份失败, 中止`，本地 state 完全未变。两个根因：① 备份使用 `xcopy /E /I /H /Y` 并判 `status === 0`——xcopy 的退出码并非只有 0 表示成功，且对共享冲突（桥刚被停掉、`memory.db` 句柄尚未释放）在非交互模式下直接判为失败，判失败后又**中止整个合并**；而可回滚路径实际并不依赖该拷贝（紧随其后的 rename 会把原目录保留为 `state.old-<ts>`）。现改用 `robocopy`（退出码 0~7 均判成功、≥8 才判失败，`/R:1 /W:1`）→ 失败时退回 `tar` → 两者均失败亦只如实记录一步、不再中止。② 替换本地 state 的那一步写的是 `fs.renameSync(...)`，而本文件的 `fs` 为**具名导入**（不存在 `fs` 命名空间对象），必然抛出 `fs is not defined`。两处修复后已真机跑通：备份（robocopy）→ 替换（原目录保留 `state.old-*`）→ 打包 → 上传覆盖远端 → 重启两端桥，全绿（`server/index.js`）。
- 同时补齐一处真实落差：服务器私聊 `private:1736784911` 有 1775 条消息、本机仅 661 条（本机桥停机期间的消息全部只在服务器那份中），已按「以服务器版为基准 + 保留本机独有的 294 条消息」合并（`state.bak-merge-*` / `state.old-*` 两份备份均在），本机独有的 `memory_entries` 亦一并补回。
- **「0.7 分一条是否还有压缩空间」的核算（本次实测，无需再反复调参）**：把 `state/token-usage.jsonl` 中 1936 次真实请求作当量折算（1 分 ≈ 14,962 全价输入 token，缓存命中按 0.115 折算），单步成本 = 0.0668 × (0.115 × 缓存读 + 未缓存 + 3 × 输出)：
  | 上下文 | 折合每条 |
  | --- | --- |
  | 0~40k | **0.41 分**（下限：固定开销 2.75 万 × 0.115 ≈ 0.21 分 + 新内容约 0.17 分 + 输出 0.03 分） |
  | 40~70k | 0.56 分 |
  | 70~90k | 0.79 分 |
  | 110~140k | 1.04 分 |
  阈值继续下调**不划算**：把上下文压到 40k 需约每 15 步压缩一次，而一次压缩的真实代价为 **3~7 分**（摘要请求把上下文整段按全价读取一遍，且改写历史后整段前缀缓存作废、下一步全量重读）——0.06/0.012 那次实测即「每 2.5 步压一次」，账面上比 0.08 更贵且更慢。工具表也非主要开销：实测 15.5% 的表体积（8 个几乎无人调用的工具）仅值 **0.017 分/步**。因此 0.08/0.02 是实测得出的平衡点，**每步约 0.7 分是该模型与该提示词体积下的下限**；进一步下降仅有两条路径：更换更便宜的模型或套餐，或裁剪系统提示词与工具表（合计约占单步 30%，减半亦仅省约 6%）。另：线上那台的推理档位本为 `off`（最省且最快），本机原为 `high`，本次统一为 `off`。
- `tools/test-dsh-compaction.mjs` 的阈值门禁改为双向约束：缺省阈值 × 1M 必须落在 [8 万, 10 万] token（低于 8 万 = 被固定开销顶穿、每步压缩；高于 10 万 = 单句约 1 分钱）、压缩后距阈值至少保留 2.5 万 token、事故值 0.12 不再允许作为缺省、低于下限的 0.06/0.02/0.005 必须被夹回、出厂 `config.example.json` 与代码缺省必须一致。
- 定位手法留档：会话日志为**多帧 zstd**，Node 的 `zstdDecompressSync` 只解第一帧（本次曾因此误判：以为检索不到生日，实为只解出 199 字符）——应逐帧解压，或直接使用 `zstd -dc`；`memory.db` 则可用 `node --experimental-sqlite` 直读。

## 1.2.1 — 2026-09-20

### 修复

- **上下文压缩阈值被「固定开销」顶穿，导致每一步都压缩一次（既慢且贵）**：`dshCompaction.thresholdRatio` 原为 `0.06`（1M 窗口 = 6.3 万 token），而实测该会话**每次请求的上下文基线即达 6.9 万 token**——system 提示词 5.36 万字符 + 78 个工具 8.11 万字符 ≈ **2.75 万 token 的固定开销**，阈值被其自身顶穿。后果（VPS 私聊会话 10 回合 114 步的实测）：`compaction/start` 71 次、`compaction/summary` **46 次**，几乎每两步之间即夹一次压缩——每次压缩 = 一次额外模型请求（把整段上下文读取一遍并写摘要，单次 3~6.9 万 token 未命中缓存）+ 改写会话历史（前缀缓存全部作废，下一步只能全量重读）；该会话未缓存输入 **116.9 万 token**，每一步之间多消耗 **15~20 秒**，一个检索回合被拖至 6 分钟。现缺省值改为 `0.12 / 0.03`（1M 窗口约 12.6 万 token 才压缩、最近 3% 逐字保留），压缩后上下文约 5.9 万 token，远低于阈值，不再出现「压完立即又压」；下限由 0.02 提高至 **0.08**，低于该值时自动夹回并写日志（`qq-bridge/src/lib/dsh-compaction.js`、`src/core/config.js`、`config.example.json`、`tunables.js`、管理端「上下文治理」卡片）。
- **检索型回合会失控为十余步**：同日线上实测，使用方询问一个记不确切的日期，模型连续发起 10 次历史检索（`qq_memory_search` 更换关键词检索「生日 / 几月几号 / 月日 / 1月 / 2月」等）耗时 6 分钟才回复未找到，每一步均需重发一整份提示词。preset `[TOOLS]` 新增 5b：历史/记忆检索**每回合最多 2 次**（尽量在同一 step 内发起），第二次仍无答案即停止，以一句话说明未找到，禁止更换词语反复检索。
- **整串数组被当作一条消息发入 QQ**：模型偶尔把 `qq_send_message` 的 `messages` 整体序列化为字符串，其中引号存在嵌套（`["直接跟我说就行", "比如"朋友圈活跃19点到23点"", "我帮你设 ᗜ ‸ ᗜ"]`）——`JSON.parse` 必然失败，旧代码于是把该数组字符串当作「一条消息」原样发出。现发送端点先尝试还原（严格 JSON、`{"messages":[…]}` 包装、以及引号嵌套的容错切分），无法还原则 **400 硬失败**、一条都不发，并回执要求模型重传真正的数组；即使绕经其它发送工具，`onebotSend` 亦会拒发该正文（`qq-bridge/src/lib/text-safe.js`、`qq-bridge/src/core/console-server.js`、`qq-bridge/src/core/qq-send.js`）。
- **系统提示词的正文格式要求过于分散**：`[TOOLS]` 新增 2b~2e 四条——不得显式换行（代码与诗歌例外）、颜文字只在人设要求时发送且 10 字内联、超 10 字单独一条、工具参数数组作为正文属硬失败、代码类生成与解释不分段（>50 字仍为一条）。这四条描述的是「正文形态」，因此置于管发送工具的 `[TOOLS]` 段，而非 `[PERSONA]` / `[SPEECH RULES]`（后两者管「角色身份与打字方式」）。

### 变更与不兼容

- **DSH Web GUI 中每个工具步的「系统提示词」标签并非桥在重复注入**：LLM 请求是无状态的，每一次请求（含同一回合内的每个工具步）均须携带 system + 工具清单 + 全部历史，该标签即本次请求的记录。同一会话 31 条 `request/header` 的 system 文本 sha **完全相同**（53,645 字符），桥每一步真正注入的仅为 `[Mid-turn] …`（约 150 字符）这类数据行——压缩费用的杠杆是「减少步数 + 前缀稳定（避免频繁压缩）」，而非提示词本身。
- **换行与颜文字只写于提示词，桥不做正则清洗**（2026-09-20 定稿）：出站正文原样透传，`[TOOLS] 2b` 明确告知模型该约束由其自身遵守、桥发出什么即是什么。数组形状（`2d`）是唯一**桥侧实际拦截**的一条：形状正确且可还原则还原为多条气泡，无法还原则 400 拒发。
- `[TOOLS] 2d` 的示例刻意不含颜文字——出厂 preset 中出现 `ᗜ` 一类字符会破坏「默认人设不带表情符号要求」的既有约束（`tools/test-wake-protocol.mjs` 的鲸鱼清理门禁）。

### 内部与工程

- 新增回归测试：`qq-bridge/tests/outbound-format.test.js`（判据，含「换行不应被桥改写」）、`qq-bridge/tests/outbound-send-integration.test.js`（端到端：真实启动控制台 + 假 OneBot 端点接收消息）、`qq-bridge/tools/test-dsh-compaction.mjs` 新增 4 项（缺省阈值必须高于实测基线、事故值 0.06/0.02/0.005 必须被夹回、压缩后必须远低于阈值、出厂模板与代码缺省一致），全部接入 `npm run check`；preset 内容门禁补 6 条（`qq-bridge/tools/test-wake-protocol.mjs`）。
- `summarizationProvider/Model` 早已按定稿「摘要统一使用主模型」而不再写入 patch，测试中的旧断言（仍要求写入 YAML）已改为锚定新契约。
- `.gitignore` 忽略 `qq-bridge/tests/.tmp-*/`（测试沙箱每次重建，Windows 上 sqlite 连接需至进程结束才释放，收尾无法删除）。

## 1.2.0 — 2026-09-19

### 新增能力

- **系统提示词中「只发 OK、说话必须走工具」改为不可误读的表述**：`[TOOLS]` 第 1 条改为 **NO TEXT. SPEAK ONLY THROUGH TOOLS.**（列出全部发送工具、说明「全部用词必须位于工具调用内」、收尾前自检、本轮不发言时只调用 `qq_mark_read` 且不写任何文本），第 1b 条改为 **THE ONLY TEXT YOU MAY EVER OUTPUT IS THE BARE TOKEN `OK`**（只能是单独一个 `OK`，不得带标点、句子、总结、解释或草稿，亦不得声明「仅此一次」）。配套修复桥侧：此前**裸 `OK`** 会被判定为「写了正文但未调用发送工具」的未交付草稿，下一轮还会向正文中插入一句 `[Undelivered draft] …("OK…")`；现在将其识别为控制令牌，按「本轮不发言」处理。
- **内置表情包由「单包」改为「多包」**：此前桥只识别一个写死的包名（`whale-fanart-001`），使用方再导入一份表情包时模型完全不可见。现一个包 = 一个目录（`manifest.json` + `index.db` + `memes/<分类>/<文件名>`），桥同时识别三个位置：出厂包 `<运行目录>/meme/<包目录>/`、后装与上传的包 `<运行目录>/meme-packs/<包目录>/`、角色专属包 `<角色库根>/<角色>/meme-packs/<包目录>/`。`qq_meme_search` 一次检索全部包（结果行带 `[包 id]`，可用 `pack` 限定单包），`qq_send_meme` 接受文件名，亦接受 `包id/文件名`（`qq-bridge/src/mcp-napcat-safe.js`）。
- **角色专属表情包**：`social.meme.personaPacks` 把包绑定到角色，`social.meme.activePersona` 记录当前导入 `persona.md` 的角色。两份包存在同名文件时按「角色专属包 → 指定的包 → 出厂包」取第一份，并在返回中说明该名称还存在于哪些包；`social.meme.packs` 非空时只检索指定的包与当前角色的包。
- **管理端可上传自有表情包**：「常用设置」新增「内置表情包（meme-packs）」卡——选择 `.zip` 或整个文件夹上传，服务端自动判定包根、执行规整、缺 `index.db` 时自动生成，并返回一份逐文件报告（接收数、入库数、跳过项、可展开的规整脚本输出）；该卡同时显示每个包（出厂 / 全局 / 角色专属 / 坏包）与每个角色绑定的包，并支持按角色勾选保存（`server/index.js`、`src/pages/BridgeConfig.tsx`、`src/api.ts`）。
- **出厂 21 个角色包**：`qq-bridge/characters/` 随包携带 21 个角色包（每个含 `SKILL.md`、`personality.md`、`profile.md`、`interaction.md`、`relations.md`、`memory.md`、`conflicts.md`、`ULTIMATE_ROLEPLAY_PROMPT.md`、`manifest.json`、`sources/wiki.md`）外加 1 张散装卡，并移除原 `_template` 模板卡。角色库中只有导入 `persona.md` 的那一张会进入提示词，其余由 `qq_character_list/read/pack/search` 按需读取。
- 表情包总开关 `social.meme.enabled`：关闭时 `qq_meme_search` / `qq_send_meme` 不注册给模型（而非在调用时才拒绝）。

### 修复

- **人设/发言规则不再在唤醒正文中重复**：自 1.1.x 起这两份已由 `lib/preset-compose.js` 合成进**系统提示词**（会话建立时即携带），但唤醒正文仍**无条件**再注入一份——实测一条首连正文中 `[PERSONA]` 与 `[SPEECH RULES]` 合计达 10KB 量级。现在仅在「preset 中那份已过时（修改人设后尚未合成）」或「该会话被标记需补注入（人设刚修改 / 桥停机期间修改过 / 升级前建立的老会话）」时注入一次；补注入后记录版本号，此后不再重复。启动时会自动标记「未见过当前人设版本」的会话一次（本机启动日志实测标记 6 个会话）。回归测试 `qq-bridge/tests/persona-inject.test.js`。
- **模型表现为不记得工具调用方式与规则：工具结果被裁剪过度**。`dshCompaction.toolResultMaxChars` 原为 1500——单个工具结果超过 1500 字即被裁为「开头 900 + 剪枝标记 + 结尾 300」，而 `qq_get_prompt` 返回的整段唤醒协议、状态快照、角色卡与贴纸清单动辄数 KB，模型每轮只能看到其中一小部分。现**代码默认值与出厂配置均改为 8192**（与 DSH 插件默认一致）；桥会热加载并重写隔离 DSH home 的 `cordis.patch.yml`，无需重启 DSH，也不打断正在进行的会话。同时把系统提示词 `[TOOLS]` 那行的示例明确到具体工具（含 `qq_social_state`）——实测模型曾自造 `qq_get_social_state` 这一名称（代码库中不存在），该条对**新会话**生效。
- **表情包发现未跟随符号链接**：服务器上 `<meme-packs>/<包内>` 是指向别处的软链，而 `readdir(..., { withFileTypes: true })` 的 Dirent 不跟随链接（`isDirectory()` 为 false）→ 整份包被跳过，工具回「本机未安装内置表情包」。现改用 `statSync` 判定目录（桥侧与管理端同一口径），并纳入多包回归测试。
- **全新机器上「已安装 21 个角色包，四个角色工具却均读取不到」**：`social.charactersDir` 未配置时，角色库根此前固定指向 `~/Downloads/characters/characters`——该路径为使用方自行放置角色库的位置，新机器上并不存在，而真正装有出厂包的 `<安装目录>\resources\runtime\qq-bridge\characters` 未被任何代码读取。现按「存在即使用」回退：用户库 → 出厂库 → 旧默认值；配置了 `social.charactersDir` 时完全以其为准。
- **导入列表与模型读取的库不再分离**：管理端「角色库导入」的扫描根此前为「桥目录 characters 优先」，出厂库随包进入 runtime 之后即永远胜出——使用方在自有库中新增的角色**不会出现在导入列表**，而模型侧四个工具读取的却是用户库。现只要配置了 `social.charactersDir`，导入列表即以其为准，两侧使用同一个库。
- 导入角色卡时同时把 `social.meme.activePersona` 记为该角色（角色专属表情包据此排最前），不再需要手写该键。
- **「重启桥」此前可能报成功但未实际重启**：`start-bridge.sh` 不终止旧桥，新实例因端口 3100 冲突自行退出，而判据仅检查 `pgrep` 是否有命中——旧桥恰好命中，于是界面显示「重启成功」、新代码一行未生效（实测服务器两次同步 pid 均未变化）。内联 `pkill` 亦无法解决（多层引号解析后变为参数错误）。现重启逻辑放入随代码包分发的 `qq-bridge/tools/restart-bridge.sh`（终止旧桥 → 等待其优雅退出、超时则 -9 → 启动新桥 → 回报 `pid / old / napcat-conn / console-listen`），管理端两条路径与克隆路径均使用该脚本，并增加源码门禁 `tools/check-remote-restart-uses-script.mjs`。
- **重启管理端不再顺带终止本机的桥与隔离 DSH**：关窗守卫按「后端进程是否仍在」判定——后端一旦消失、宽限期（原为 6 秒）届满、guard 文件尚未被新后端接管，即判定为「应用已关闭」，从而一并收掉 NapCat、桥与隔离 DSH。而重启后端时新后端常需 5~20 秒才启动并武装新守卫，于是出现「重启一次管理端，机器人即失联」（本机实测被收掉一次）。现宽限期放宽至 30 秒，`tools/restart-manager.ps1` 亦先退出监视旧后端的守卫，再等待新后端自行武装新的守卫。
- **代码同步不再覆盖服务器自身的配置**：`/api/ssh/sync` 的代码包此前**未排除 `config.json`**，每次「只同步代码」都会把本机那份调试配置覆盖到服务器——远端 NapCat 令牌被替换（桥每次连上即被剔除，日志 282 条 `code=1005`）、`dsh.baseUrl` 由 3080 变为 10721（事件流无法连接）、docker 路径映射与白名单一并丢失，整台 QQ 不可用而界面每一步均显示 OK。现代码包排除该文件，解包后再作后备路径还原（显式推送配置仍走其独立开关），并新增 17 项回归测试。
- **「重启远端桥」此前实际未重启**：`start-bridge.sh` 不终止旧桥，新启动的实例只能报 `listen EADDRINUSE` 后自行退出；而该步骤的成功判据是 `pgrep` 是否有命中——旧桥恰好命中，于是界面始终显示「重启成功」、新代码一行未生效。现先终止旧桥、等待其完全退出后再启动，并一并回报新进程 pid 与到 NapCat 的连接数。
- **表情包「可检索、无法发送」的根因**：规整脚本重建 `index.db` 时遗漏 `path` 列，而 `qq_send_meme` 正是以 `path` 发送图片。现该表以 `path` 为主键，脚本结尾还会实际执行桥侧那两条 SQL 自检，不通过则报错退出。
- **规整不再覆盖既有描述**：此前按文件名拆词重写 `caption`/`keywords`，会覆盖已有的人工或模型描述；现按「老表 path → 老表 file_name → 去扩展名同名」认领老行并原样保留，仅对表中不存在的新图生成后备描述。
- 出厂表情包索引与磁盘的漂移（184 张图仅 162 行入库）已对齐；同时发现并隔离了一张与 `angry/` 字节完全相同的 `daily/` 副本。
- `qq_meme_search` 遇到坏包不再整次失败：跳过无法读取的包继续检索，并在结果中说明跳过了几份。
- 语音测试与现行契约不一致（语音早已默认丢弃引用段，测试仍断言「先加 reply 段」）已按契约改写，并补上 `quoteMode=native` 那一分支——此前该分支使整条自检链持续失败。

### 变更与不兼容

- **斜杠指令统一为英文**：新增 `/set active [HH:MM-HH:MM]`（该时段活跃，其余仅回 @）与 `/set diving [HH:MM-HH:MM]`（该时段潜水，其余活跃），**不带时段 = 全天**；`/set mode active|diving` 保留为等价的老写法。中英混写的旧写法全部移除：`/slang 学习`、`/slang 停止`（改用 `/slang learn`、`/slang stop`）、`/set mode 活跃`、`/set mode 潜水`、`/op del 删除|取消|撤销|解`（改用 `/op del` / `/op remove`），作息时段的分隔符亦不再识别「年」「到」。`sleep` 那一套（`/set sleep 01:00-06:00`、`/set sleep 30m`、`/set wake`、`/set cancel`）照旧。
- 删除过期的 `qq-bridge/QQ聊天角色设定.md`：概率早已改为桥侧掷骰（`core/send-dice.js`），该手写参数表不再对应任何真实行为。
- 内置表情包的搜索结果行增加一段 `[包 id]`（`文件名 [分类] [包 id] 描述`）；`qq_meme_search` 与 `qq_send_meme` 各增加一个可选 `pack` 参数。
- 包 id 取自 `manifest.json` 的 `id`，目录名不再等于 id；出厂包 `whale-fanart-001` 的目录名与 id 不变。
- 出厂角色卡由模板 `_template` 替换为 21 个真实角色包——管理端「角色库导入」列出的默认内容随之变更。
- **上传的表情包位于后装目录 `meme-packs/` 中，升级不会覆盖**；出厂包位于 `meme/` 中，随更新整体替换（界面中出厂包只提供禁用、不提供删除）。

### 内部与工程

- 桥侧工具描述改动后重新实测生成 `src/tool-schema-chars.ts`（89 个 napcat 工具 / 84251 字符）。
- 新增多包回归测试：`qq-bridge/tools/test-meme-search.mjs --multipack`（跨包检索、`pack` 过滤、同名歧义与角色包优先、`social.meme.packs` 收紧、启动日志）。
- 新增上传接口集成自测 `tools/test-meme-pack-import.mjs`：把 `server/index.js` 复制进沙箱作为运行目录（`RUNTIME_ROOT` 按文件位置推导，无法由环境变量改写），`USERPROFILE` 指向沙箱 home，`QBM_NO_LISTEN=1` 只导出 app 并由脚本自行 `listen(0)`。覆盖 zip 与文件夹上传、zip-slip 与坏输入零痕迹、出厂包拒绝删除、`bind` 只修改 `social.meme.personaPacks`（保留 BOM 与其它字段），以及「沙箱中自动重启被安全挡下」。
- 表情包上传的「自动重启桥」增加前置判断：`stopInstance` 末端的 `killByCmdline('bridge.js')` 按命令行关键字终止全机器的 node/qbm-node，管理端与桥不在同一目录时会**误杀不归其管理的桥**，因此仅在确实管理该桥时才执行重启。
- `tools/sync-to-live.ps1` 同步清单加入 `characters`，并显式清除旧 payload 中残留的 `_template`；该文件注释改回纯 ASCII（该文件自身要求 ASCII-only：PS 5.1 按 GBK 读取 `.ps1`，含中文即依赖 BOM，而编辑工具会使 BOM 丢失）。

## 1.1.0 / 1.1.1（补记）— 2026-09-19

> 该版的分组当时未写入本文件（仅发布在 GitHub Release 说明中），此处按改动主题补记，便于对照。

### 新增能力

- 人设 / 发言规则 / 系统提示词分为三层：人设与发言规则**合成进系统提示词**（`qq-bridge/src/lib/preset-compose.js`，带幂等标记），正在运行的会话则继续走运行时注入那一段。
- 管理端「角色库导入」与角色库只读工具组的提示词强化：先读 `SKILL.md`，默认库路径为 `~/Downloads/characters/characters`，父目录自动下钻一层。
- 发布工具沉淀：`publish-release.mjs`、`edit-release.mjs`、`api-commit-file.mjs`，以及四个界面/文档审计脚本（工具名、标签、配置说明、README 工具清单）。

### 修复

- **安装器的两处静默失败**：electron-builder 只要定义了 `customRemoveFiles` 就会跳过自身的 `RMDir /r $INSTDIR`，导致旧版卸载**不删除任何内容**；终止进程的 PowerShell 内联写法置于 `nsExec` 中会被多层引号解析破坏，导致提示「无法关闭，请重试」。现卸载宏自行删除并增加延迟后备路径，终止进程脚本先写入 `$PLUGINSDIR` 再以 `-File` 调用，名单补上 `guard-node.exe` 与「路径位于安装目录内」的判据。
- **更新安装会静默删除用户数据**：更新时以 `Uninstall.exe /S /KEEP_APP_DATA --updated` 调用旧卸载器；现按 `--updated` 予以拦阻。
- 服务端模式读取不到 DeepSeek 官方模型：`safeRemotePath` 正则遗漏 `@`，npm 作用域路径被静默拒绝；另外官方模型内置于 DSH 包中而不在 `settings.yaml`，旧代码只读取后者。
- 上下文治理阈值被夹至窗口的 0.5%，导致**每轮都压缩**、模型响应极慢；桥侧下限提高至 2%，并在被夹紧时写日志。
- 「QQ 工具开关」行集此前只列出配置中已有的键（缺失较多），现为桥侧全部开关与配置已有键的并集，并新增「无独立开关」工具单列一卡；同时删除 6 个桥侧从未读取的无效开关与 4 个与开关不对应的标签。
- 插话概率：旧口径保留「模型自定」的值，导致设定为 0.15 而唤醒词显示 0.08；现使用方保存的值覆盖所有会话。
- 顶部提示条 6 秒自动收起、文案变化重新计时、点击即关闭。

### 变更与不兼容

- 系统提示词**不再内置默认人设**（无 `[PERSONA]` 时不扮演任何角色）。
- 上下文治理卡移除「摘要模型服务商 / 摘要模型」两栏（摘要统一使用主模型）。
- 出厂 `persona.md` 为空；管理端「接口密钥」改名为「语言模型密钥」。

## 1.0.0 — 2026-09-18

首个公开发布版本。仓库在本版之前由内部 QQ-Bridge 仓库整体迁移而来，因此下文同时覆盖迁移前后的全部改动。

### 新增能力

- 管理端把隔离 DSH、NapCat、桥接层与模型服务商整合为一套 Windows 程序，提供安装、配置、拉起、探活、日志与停止（`server/index.js`、`src/App.tsx`）。
- 唤醒判定支持 19 种原因，涵盖被 @、被点名、直接提问、关键词、指定发言人、话题词、概率接话、戳一戳、私聊、主动闲聊、潜水到期、进入活跃时段、交付看门狗与各类恢复（`qq-bridge/src/core/wake-send.js`，规则见 `qq-bridge/dsh/agent-presets/qq-chat/preset.yml` 的 `[WAKE TYPES]`）。
- 潜水与活跃两套独立参数、群聊活跃时段（可列表化，群号不再写死）、回合保持、连发合并窗口、打字状态感知（`core/social-state.js`、`core/activity.js`、`core/turn-hold.js`、`core/typing-hold.js`），活跃时段由 `/api/social/targets` 下发。
- 人设与规则分层：规则固定在 preset，人设正文以 `[PERSONA]`、发言风格以 `[SPEECH RULES]` 交付，所有者私聊带 `[OWNER]`、其它私聊带 `[NOT-OWNER]`（`core/role-hint.js`、`core/prompt-deliver.js`）。
- 群友画像学习与关系图谱：群角色、互动强度、关系标注、模型自动标注关系（`core/portrait-learn.js`、`src/pages/GroupPortrait.tsx`、`src/pages/NetCanvas.tsx`），并提供单人完整资料接口，资料直读记忆库、不作截断。
- 人格学习产出英文人设正文，支持「结合原人设完善」与「整篇覆盖」两种应用方式（`core/persona-learn.js`、`core/persona-text.js`）。
- 黑话学习带状态机，已确认词条不再注入上下文，改为按需调用 `qq_slang_query` 查询，以节省额度（`core/slang.js`、`src/slang-learner.js`）。
- 语音能力：接入小米 MiMo 语音，管理端设独立语音页，并支持全语音发送模式（`core/voice.js`、`src/pages/VoiceConfig.tsx`）。
- 语音与表情包的发送概率改由桥侧掷骰决定，不再由模型自行估计概率（`core/send-dice.js`）。
- 联网与视觉：网页搜索与抓取工具，看图规则改为直接读图，多平台聚合提速（`src/mcp-web-search-safe.js`、`src/lib/image-search.js`）。
- 富文本与媒体：图文卡、合并转发、Word 文档、QQ 原生表情、收藏表情、表情包、戳一戳、定时消息、跨会话留言、QQ 空间互动（`core/qq-send.js`、`core/send-chain.js`、`core/media.js`、`core/docx.js`、`core/qzone.js`、`core/sticker.js`）。
- 音乐卡片：网易云与 QQ 音乐点歌卡片，支持手机端点开播放（`core/media.js`、`music-sign-proxy.py`）。
- Pixiv 搜图支持镜像站地址可配、本地筛选与自动翻页（`qq-bridge/src/lib/pixiv.js`）。
- 发送节奏改为按单字速度计算，并支持以自然语言调整（`core/tunables.js`、`core/send-chain.js`）。
- Token 用量统计、费用估算与面板对账，面板常驻显示对账状态（`core/token-meter.js`、`core/learning-token.js`）。
- 管理端新增群聊活跃时段配置卡、NapCat 鉴权令牌卡、关闭界面时结束 NapCat 开关，并把 NapCat 卡拆为三张（`src/pages/BridgeConfig.tsx`、`src/pages/Home.tsx`、`src/components/NapcatTokensCard.tsx`）。
- NapCat 连接强化：主动探活、看门狗收紧至 45 秒、连接诊断进管理端、心跳重连统计、会话守护 `get_rkey` 探活、登录票据备份与登录态可见（`core/napcat-guard.js`、`lib/onebot-ws.js`）。
- SSH 远程能力：服务器列表、连接测试与端口纠偏、隧道、代码/数据/表情包/config.json 分别同步、整套克隆、清理远端（`src/pages/SSHConfig.tsx`、`server/deploy.js`）。
- 服务器端部署与克隆以原生方式优先：官方 Linux QQ + `/opt/napcat` + systemd unit + Xvfb + 非 root 用户，docker 作为后备路径（`server/deploy.js`）。
- 设备身份固定：`qq-bridge/tools/pin-napcat-device.sh` 钉住 machine-id 与 hostname 并留档，`qq-bridge/tools/diag-napcat-device.sh` 以一条命令输出全部排查证据。
- 关窗守卫以独立进程运行，退出管理端后清理 NapCat（`server/napcat-guardian.mjs`）。

### 修复

- 桥接层发送遇到 NapCat 预热期错误时会丢弃回复，改为自动重试；QQ 客户端瞬时错误（网络连接异常 / rich media transfer failed / EventChecker Failed）一并纳入重试。
- 服务端「已发消息但无回复」：坏会话刷屏与 90 秒后备时限过长，已修。
- 服务器上修改 preset 后始终不生效。
- 部署「上传超时」与「dsh 明明已安装却报未安装」：传输改用 SFTP + 字节复核，修掉 `gzip: stdin: unexpected end of file`。
- 漏传 key/token 导致 `-32602`，现自动补齐，并清除过时的工具入口文案。
- 推理档位不被服务商支持时退回服务商默认值，不再把「未配置」当作 max。
- 表情包发送失败、引用错误、重复失败消耗额度；新增角色卡只读工具。
- `/reset` 之后重复回复一次：增加幂等闸门，并修掉 `atUserId` 误传导致的降级。
- 思考期间到达的消息不再被塞入下一个唤醒，改以 `[Mid-turn]` 注入当前回合；打字期间消息全部入队且只注入一次。
- 智能引用改为「默认不引用」：回答最新那条不挂引用框，多条候选零共同词不自动引用，并把自动引用的实际行为如实告知模型。
- 非所有者私聊不再被误称 owner（`[NOT-OWNER]` 标记 + 预设与人设写定禁止误称）。
- 已学习的黑话不再变回候选，并修好「研究链从未执行成功」导致的候选堆积。
- 人格档案改为一段完整介绍，不再重复、不再半句截断、不再占用「备注」字段。
- 归档器在服务器上始终空转（`sessionsRoot=null`），现覆盖全部工作区并清理本机残留工作区。
- 启动自愈：清除指向已删除会话的映射，不再使事件泵空转并反复输出「follow 流终结」。
- NapCat 令牌真正写入 NapCat 配置并重启；令牌卡与连接卡去重，新增「用桥里现有的令牌写入」对齐操作。
- NapCat「桥失去响应、仅刷心跳而无响应、永不重连」：改为判定失效即重建。
- NapCat 登录态刷取过频被限流并报「查不到」，已降低频率。
- SSH 断线自动重连，启动时自动连回，界面显示「服务端重连中…」；隧道自愈；卡片不再静默切回本机。
- 桥连不上时不再显示「失败：fetch failed」，改为区分「未在运行」与真实失败。
- Token 用量面板与 DSH 的会话级权威计数对齐，修掉「面板数值忽高忽低」的两处真实成因。
- 管理端在服务端离线时用量仍计入合计。
- 群名拉取失败改走群列表回退。
- 图片下载超时改用 URL 作为后备路径，耗时更短。
- 默认音色未被使用（模型自行指定了内置冰糖），已修。
- 打包 payload 不再夹带开发期产物；`config.example.json` 与 `start-bridge.sh` 随包同步。
- `[COMPREHEND]` 补齐「把未读当作对话延续」与「减少提问」；看图规则改为直接读图；语义与上下文规则强化。
- 网易云卡片可以点开播放，且不再弹出「将要访问」中转页。
- QQ 音乐卡不再因 `songmid` 不匹配即退化为纯链接。
- 手机端音乐卡封面为空：真因是签名服务无法取得腾讯 CDN 的图片，最终改为封面逐张探活、优先使用桥自身解析的那张。
- 管理端粉色面板中的滚动区铺至板底不再留空；右卡不参与行高计算，整行不被拉长。
- 删除容器时代遗留的「免扫码回退登录」卡。
- vite dev server 绑定 `127.0.0.1:5173`（原本与后端争用端口，且绑定 `localhost` 只监听 `::1`）。

### 变更与不兼容

- 仓库由内部 QQ-Bridge 整体迁移至 MoonBot Public，并做公开仓库脱敏；界面上的 GitHub 徽标指向 MoonBot 仓库。
- 版本号定为 `1.0.0`，产品名与安装包统一为 MoonBot Pro：对外为 `MoonBot Pro Setup.exe`，另提供只含管理端的 `MoonBot Pro Manager Setup.exe`。
- 服务器端部署与克隆由 docker 改为原生优先（systemd + 官方 Linux QQ），探测到已有 `napcat.service` 即走 systemd。
- 打字节拍只保留「按字数」一种，移除多余的另外两套。
- 黑话指令只保留 `/slang 学习`、`/slang learn`、`/slang 停止`、`/slang stop`，代码不再识别 `/slanglearn`、`/slangstop` 与无空格中文写法。
- 已确认的黑话不再注入上下文，需要时由模型自行查询。
- 表情工具改名为 `qq_meme_search` / `qq_send_meme`。
- 智能引用由「尽量引用」改为「默认不引用」。
- 默认音色与语音锚点固定，模型不再自行指定内置音色。
- 群唤醒上限收至 30；「活跃模式」改用独立的一套参数，不再沿用潜水那套。
- 安装包默认按用户安装到 `%LOCALAPPDATA%\Programs\MoonBot`，安装向导可更改目录。
- 仓库术语统一：文档一律使用「管理员」表述，不再混用其它叫法。
- 移除开发初版鲸鱼人设的痕迹。

### 内部与工程

- README 重写并按桥接层源码实测逐项修订（架构图、逐目录说明、界面/API/工具/命令、唤醒原因、媒体阈值、工具权限与 `state` 清单）。
- 原生装机脚本抽为纯函数，可离线执行 `bash -n` 与 systemd 校验（验证脚本随 `server/deploy.js`）。
- 五份分散的设备指纹排查脚本合并为一份 `qq-bridge/tools/diag-napcat-device.sh`。
- 新增三个 Pixiv 镜像站参数探针，实测其支持哪些搜索参数（`qq-bridge/tools/probe-pixiv-params.mjs` 等）。
- 工具 schema 体积表改为现场实测生成，补上漏登记的 12 个工具（`qq-bridge/tools/emit-tool-chars.mjs`、`src/tool-schema-chars.ts`）。
- 界面文案中文化审计与渲染校验脚本（`tools/audit-ui-labels.mjs`、`tools/verify-rendered-labels.mjs`）。
- 回归测试扩充：唤醒协议、斜杠命令、steer 批处理与闸门、配置热重载、NapCat 启动重试、`qq-hold`、发送延迟、音乐卡、Pixiv 筛选、平台模型列表、守卫武装与隐藏窗口等（`tools/test-*.mjs`、`qq-bridge/tools/test-*.mjs`、`qq-bridge/tests/*.test.js`）。
- 交接文档一律本机专用，含服务器信息的 `HANDOFF*`、`CTX`、`PROJECT_GUIDE` 等不进入公开仓库。
- 打包流程与校验脚本：出包前清理 payload 中的个人信息，出包后执行内容校验。
- 开发期端口冲突修复与 `.gitignore` 收口。
