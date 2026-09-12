# qq-bridge 代码重构计划（从 12k 行屎山到规范结构）

> 目标文件：`src/bridge.js`（约 12,000 行，ESM 单文件）。
> 现状：模块级工具约 1–975 行；随后是一个巨型 `async function main()`（976–文件尾），
> 内部以闭包方式内嵌 265+ 个函数，共享 state/config/ws/sqlite 等同一作用域——"一整坨"。

## 原则

1. **行为不变、可随时回滚**：每一步拆分后都必须通过
   `npm run self-test`、`node --check`、以及真实启动冒烟，才允许合入。
2. **自上而下建立边界，再自下而上搬函数**：先让 `main()` 变成"装配器"，
   再按域把闭包函数抽到独立模块并以显式 `ctx` 传参。
3. **不追求一次到位**：按阶段推进，每个阶段产出一个可运行版本。

## 目标结构（终态）

```
qq-bridge/
├─ src/
│  ├─ index.js                # 入口：加载配置 → 组装 ctx → 启动各域
│  ├─ main.js                 # 装配器（原 main 只剩编排/初始化/退出）
│  ├─ config/
│  │  ├─ schema.js            # config 校验/归一化（原 loadConfig 区）
│  │  └─ paths.js             # 路径/文件名/状态目录
│  ├─ core/
│  │  ├─ ctx.js               # 共享状态容器（state/sessions/timers/db/ws…）
│  │  ├─ logger.js            # log/audit/activity 抽象
│  │  ├─ store.js             # JSON 读写原子化（原 readJsonSafe/atomicWrite*）
│  │  └─ lock.js              # 会话锁（acquireLock/releaseLock）
│  ├─ lib/
│  │  ├─ text.js              # escapeCqText/unquoteJsonString/CJK 分句/拆长段
│  │  ├─ media.js             # mime/图片压缩/维度/base64/file 解析
│  │  ├─ time.js              # beijingTs/pad/北京时钟/活动窗口
│  │  ├─ json.js              # 安全 JSON 读写/文档卡片解析
│  │  └─ rand.js              # randInt/概率抽样
│  ├─ napcat/                 # OneBot v11 WS 客户端层
│  │  ├─ ws-client.js         # 连接/心跳/重连/看门狗
│  │  ├─ send.js              # sendToQQ/onebotSend/sendBurst/gaps 节奏
│  │  └─ receive.js           # handleIncoming/事件归一化
│  ├─ dsh/                    # DeepSeek Harness 客户端
│  │  ├─ client.js            # prompt/stream/工具回传（现 dsh-client.js）
│  │  └─ session.js           # 会话生命周期（ensureSession…）
│  ├─ engine/                 # 行为引擎
│  │  ├─ wake.js              # 唤醒/潜水/活跃模式、睡眠窗口
│  │  ├─ social.js            # 主动回复/闲聊时间线/批次
│  │  ├─ proactive.js         # 主动巡查/空间说说等低频任务
│  │  ├─ timers.js            # 所有 setTimeout 的登记/清理（防泄漏）
│  │  └─ pipeline.js          # turn 看门狗/防抖/排队（armTurnWatchdog…）
│  ├─ memory/
│  │  ├─ sqlite.js            # memory.db 初始化/查询（现 initMemoryDb…）
│  │  ├─ sessions.js          # sessions.json 状态读写
│  │  ├─ profiles.js          # 群友画像
│  │  ├─ chat-history.js      # 聊天记录搜索/删除
│  │  └─ crosschat.js         # 跨会话留言箱
│  ├─ tools/                  # MCP 工具注册表（按能力拆）
│  │  ├─ registry.js          # tool map 装配 + 白名单
│  │  ├─ send.js  wake.js  memory.js  sticker.js
│  │  ├─ qzone.js  social.js  file.js  music.js  docx.js
│  │  └─ help.js  feedback.js forward.js
│  ├─ learner/
│  │  ├─ slang.js             # 黑话学习（现有 slang-learner 封装）
│  │  └─ sticker-learn.js
│  ├─ server/
│  │  └─ console-server.js    # 3100 控制台 HTTP + token
│  └─ util/                   # 其它纯工具
├─ scripts/                   # 分析/补丁/迁移脚本
├─ tests/                     # 单测（先覆盖 lib/ 纯函数）
├─ config.example.json
└─ package.json
```

## 阶段

- **P0 文档与体检（本轮）**：结构分析、计划、基线 self-test 通过。
- **P1 模块级工具外提（低风险）**：1–975 行按 lib/ 拆分，行为不变。
- **P2 ctx 化**：把 main 闭包共享状态收进 `core/ctx.js`，函数签名注入。
- **P3 域抽取（大块）**：按依赖矩阵逐域搬 napcat/engine/memory/tools。
- **P4 入口拆分与回归**：index/main 分离，自我冒烟+真实链路测试。

## 验收命令（每阶段）

```bash
cd qq-bridge
node --check src/index.js            # 语法
npm run self-test                    # 现有自检
npm run start                        # 冒烟（需 NapCat/DSH 在场，或 dry-run 配置）
node scripts/check-size.mjs          # 单文件行数门槛（渐进下降）
```

## 现状体检（2026-09-05 基线 / 迁移后更新）

- `src/bridge.js` 基线 **12,014 行**；完成模块级 lib 外提后降至 **11,646 行**，`node --check` 通过。
- 模块级（import 之后、`main()` 之前）约 65 个顶层符号（工具函数/常量/路径），其中低风险纯工具
  已按 ANALYSIS.md 分批外提：`src/lib/paths.js`、`json-fs.js`、`message-parse.js`（+`tests/` 单测）。
- `main()` 从约 L976 延伸到文件尾，内部以 2 空格缩进嵌套 **265+ 个函数**
  （含 `sendToQQ`、`socialLoopTick`、`handleIncoming`、`pumpMux` 等核心逻辑），
  全部闭包共享 `state/config/sessions/ws/db/timers` 等 main 局部变量 —— 这是"一整坨"的本质。
- `npm run self-test` 目前需真实 DSH API 才能全绿（`fetch failed` = 未起 DSH 时的预期失败）。
- 单文件行数门禁脚本：`scripts/check-size.mjs`（阈值 4000 行）。
- 迁移门禁：每批先 `cp src/bridge.js src/bridge.js.bak-<阶段>-<日期>`，`node --check` + `npm run check`
  通过后才允许下一批；纯函数迁移同时补 `tests/*.test.js`。

