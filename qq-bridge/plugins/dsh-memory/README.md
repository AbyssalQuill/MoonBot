# dsh-memory

DeepSeek Harness 的「长期记忆(Long-Term Memory)」插件(bundle)。跨会话持久化**提炼过的语义事实**——用户偏好、经验教训、项目约定——而不是整段历史会话。

## 定位

与 dsh 内置的 `session-reference`(整段历史会话快照)互补:

| 能力 | 记什么 |
|---|---|
| `session-reference`(内置) | 整段历史会话快照 |
| `dsh-memory`(本插件) | 提炼的语义事实(只含 `rules` / `lessons` 两类) |

## 用法

```sh
dsh plugin --profile demo add @meomeo-dev/dsh-memory
dsh --profile demo
```

模型在会话里主动调用工具:

- `remember` —— 写入一条记忆(`type` / `domain` / `scope` / `layer` / `entry` + 可选 `entryPoint` / `references`)
- `recall` —— 经多 `deepseek-v4-flash` 记忆节点 team 召回相关条目,每条返回完整字段(`id` / `type` / `domain` / `scope` / `layer` / `entry` / `entryPoint` / `references` / `file`,供溯源)
- `forget` —— 按 `entry` 精确匹配删除(`rules` 删除需 `confirm: true`)
- `memory-find` —— 按 `id` 或 `type` / `domain` / `scope` / `layer` 过滤查找
- `memory-update` —— 按 `id` 改写可改字段(`entry` / `domain` / `scope` / `entryPoint` / `references`)
- `memory-delete` —— 按 `id` 删除(`rules` 删除需 `confirm: true`)

人可操作 `/lmemory` 命令:

- `/lmemory help [command]` —— 全部命令一览;带子命令名时查看该命令的详细帮助
- `/lmemory status` —— 查看 team 节点数 / 每节点状态
- `/lmemory stats` —— 记忆统计:条目数(rules/lessons)、layer / domain 分布、文件大小、catalog 条目数(纯文件读,不发模型调用)
- `/lmemory usage` —— token 用量:预热 team 与 system prompt 摘要的上下文成本估算 + 本进程 recall/extract/review 的 LLM 调用消耗(输入/输出/缓存读)
- `/lmemory usage --days N` —— 按 `~/.dsh/lmemory/usage.jsonl` 持久化日志聚合近 N 天(1..90,重启不丢)
- `/lmemory team start|stop|restart` —— 组装 / 释放 / 重新组装 team
- `/lmemory query <text>` —— 人主动查询长期记忆
- `/lmemory review [layer|domain]` —— 用 `deepseek-v4-pro` 质检记忆,发现矛盾/重复/过时/背离,报告注入主会话
- `/lmemory catalog rebuild [--root <path>]` —— 从全部 jsonl 重建 catalog;`--root` 只重建给定记忆根目录(如 global 目录)
- `/lmemory global extract <file> [--dry-run|--confirm]` —— 读本地文档(≤1MiB)交 extract&lt;global-type1&gt; 小队抽取,回显候选 + gate 结论;`--dry-run` 只回显不写盘,`--confirm` 命中暂存零调用写盘(见 `docs/global-layer-design.md`)
- `/lmemory global promote [--confirm]` —— review&lt;global-type2&gt; 小队对全部 user/project 记忆严格评估并总结提炼为 global 候选;先回显预估节点数与成本,`--confirm` 才执行(未确认不发调用)
- `/lmemory global review` —— review&lt;global-type1&gt; 小队质检 global 目录条目,报告注入主会话
- `/lmemory config get|set <key> [value]` —— 读写配置(见 `docs/design.md` §9 / `docs/auto-extraction.md` §7)
- `/lmemory collections list|add <root>|forget <root>|export [--out <dir>] [--root <path>...]` —— 记忆根注册表管理与记忆包导出(备份/分享)
- `/lmemory pricing` —— 打印价格表全文与文件路径(成本估算的计价依据,CNY 每百万 tokens;改表即重算,见 `docs/pricing-and-cost.md`)
- `/lmemory ui` —— 返回记忆 Web 面板全部页面链接(记忆/状态/目录/节点/设置/Global,带访问 token;仅 web 模式可用,见 `docs/web-panel.md`)

Web 模式下还有图形界面:`/lmemory ui` 返回带访问 token 的面板链接(启动时也会打印面板 URL 到 stdout,与 `dsh web:` 行一致);面板含六个页面——记忆页(顶部筛选 + Timeline/Table 布局切换)、状态页(记忆活动大表 + team 状态 + 统计指标块 + usage 图表,含近 14 天每日柱状图、近 12 周日历热力图与按价格表的估算成本列)、目录页(记忆根注册表 + 登记/移除/导出)、节点状态页(跨进程 recall/extract/review 运行与装载状态,见 `docs/node-status.md`)、设置页(14 个配置键)、Global 页(global 条目只读列表 + 文档抽取/提升评审/质检/导出导入,见 `docs/global-layer-design.md` §9)。

## 存储模型

- **真相源** `.remember.jsonl`:一行一条 JSON,逐行 schema 校验(`id` 唯一编号、`createdAt` 创建时间(epoch 毫秒,系统赋值)、`type` ∈ rules/lessons、`domain` ∈ 21 枚举、`scope` 非空自由文本(影响范围)、`layer` ∈ global/user/project、`entry` 非空)。
- **渲染投影** `.remember.md`:9 列 Markdown 表格(首列 `id` + 8 个字段,含创建时间),由纯函数渲染生成,绝不解析 MD。
- **派生索引** `catalog.json`:每层 `lmemory/` 目录一个(含 global 目录),记录「记忆 id → 所在文件」,全量重写、可 `rebuild` 重建(真相源仍是 jsonl)。
- 命名规范:`YYYY-MM-DD[.<partition>].<type>.remember.{jsonl,md}`。
- 目录发现:内置 < 用户 `~/.agents/lmemory` < 用户 `~/.dsh/lmemory` < 项目 `<repo>/.agents/lmemory` < 项目 `<repo>/.dsh/lmemory`;global 目录 `~/.dsh/lmemory/global/` 独立于发现链、按消费方显式追加(召回/逆查/统计/注入)。
- global 层只由四个 gated 路径写入:文档抽取、提升评审、global 导入、存量迁移;`remember` 工具的 layer 参数只收 user/project(见 `docs/global-layer-design.md`)。

## 文档

- [concept.md](docs/concept.md) —— 领域模型:scope/domain 框架、21 个 domain、两类信息、时间衰减、表格格式
- [design.md](docs/design.md) —— 技术设计:接缝、目录发现、数据模型、工具、AC
- [auto-extraction.md](docs/auto-extraction.md) —— 自动提取设计:三种触发形态、抽取器、抽取窗口
- [memory-review.md](docs/memory-review.md) —— 记忆寻址、目录与质检:唯一编号 id、catalog、review
- [global-layer-design.md](docs/global-layer-design.md) —— global 记忆层设计:门禁写入、三泛型 team、注入语义、workspace 匹配、导入导出
- [data-contract.md](docs/data-contract.md) —— 数据契约与演进式数据设计:ER/3NF、Data+Schema+Migrate
- [robustness.md](docs/robustness.md) —— 健壮性设计:节点容错、LLM 停机语义
- [web-panel.md](docs/web-panel.md) —— Web 面板设计:路由、token、信任栅栏、RPC 端点、构建管线
- [storage-and-collections.md](docs/storage-and-collections.md) —— 存储目录改名、整体注册表、记忆包导出、usage 持久化
- [pricing-and-cost.md](docs/pricing-and-cost.md) —— 价格表与成本估算:官方时段价格(含峰谷)持久化,cost 即时计算不落盘

## 状态

已实现主动记忆(remember / recall / forget)+ 质检(review)+ 自动提取(auto-extraction)+ 数据契约(schema v2:createdAt + 迁移引擎)+ 节点容错 + 跨进程节点状态 + global 记忆层(门禁写入 / 三泛型 team / 注入最小化 / 导入导出,见 `docs/global-layer-design.md`)+ Web 面板(/memory、/memory/status、/memory/collections、/memory/nodes、/memory/settings、/memory/global 六页)。单元测试全绿(模型调用以 mock 注入);召回 / 质检 / 抽取 / 提升需真实 `DEEPSEEK_API_KEY` 端到端验证。
