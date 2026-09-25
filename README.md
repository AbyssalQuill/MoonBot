# MoonBot Pro

MoonBot Pro 是运行于 Windows 本机的 QQ 对话机器人一体化部署工具。**NapCat / OneBot v11** 承接 QQ 协议；**隔离的 DeepSeek Harness（DSH）实例**承担 agent 推理；**qq-bridge** 承担唤醒判定、提示词组装、工具调用与消息发送；**Electron 管理端**承担安装、配置、进程编排与运行监控。作者 AbyssalQuill，仓库 AbyssalQuill/MoonBot。

MIT · Windows 10 / 11 · Node.js ≥ 22.13 · Electron 28 · React 18 · 版本变更记录见 [CHANGELOG.md](CHANGELOG.md)

## 简介

管理端在一台 Windows 机器上编排五个部件：QQ 账号、NapCat、qq-bridge、隔离 DSH 与模型服务商，负责安装、配置、启动、探活、日志记录与停止。管理端位于管理面，不在 QQ 数据链路上。

消息链路：QQ 群 / 私聊 → OneBot v11（WebSocket）→ NapCat → qq-bridge → DSH HTTP API → 模型服务商；回复经工具调用沿原路返回 QQ。

隔离 DSH 使用独立 `DSH_HOME`，与桌面端 DSH 实例相互隔离。QQ 会话与 DSH 会话一对一映射（`private:<QQ 号>` 或 `group:<群号>`），映射持久化在 `qq-bridge/state/sessions.json`。分层结构、状态落盘位置与端口表见 [docs/TECHNICAL.md](docs/TECHNICAL.md)。

## 安装与首次启动

表 1：安装包（`release/`）

| 安装包 | 内容 | 适用 |
| --- | --- | --- |
| `MoonBot Pro Setup.exe` | 管理端与整套内置组件：NapCat（OneKey 与 QQ 客户端）、DSH CLI、qq-bridge 出厂桥 | 本机运行整套 |
| `MoonBot Pro Manager Setup.exe` | 管理端（内置 Node 运行时） | 远程控制台、连接自备服务器 |

安装步骤：

1. 双击安装包，安装到任意盘；运行时根目录按程序自身位置推导（`server/index.js` 的 `RUNTIME_ROOT`）。
2. 首次启动前完成两项准备：在首页 NapCat 卡点「启动」，用机器人 QQ 扫码登录（登录态只保存在本机，不随安装包分发）；在隔离 DSH 卡的配置中，向隔离 home 的 `.credentials.yaml` 写入 `DEEPSEEK_API_KEY: xxx`，或改在功能配置页配置模型服务商。
3. 按「NapCat → 扫码登录 QQ → 隔离 DSH → 桥」的顺序启动；NapCat 登录后自行写入 OneBot 网络配置（HTTP 3000 / WS 3001，令牌 `truefriend`）。
4. 在首页观察日志流；向机器人账号发送私聊消息或在群内 @ 机器人账号验证。

首次启动的完成判据：

- 隔离 DSH：`http://127.0.0.1:10721` 可打开，管理端状态显示运行中。
- NapCat：WebUI 可登录，OneBot 的 WebSocket 服务端与 HTTP API 均已开启。
- 桥：日志出现 `NapCat 已连接：ws://127.0.0.1:3001`，随后出现新会话创建与消息投递记录。
- 端到端：私聊或群内 @ 之后，日志出现 agent 回复行。

关闭窗口时管理端自动停止 NapCat、桥与隔离 DSH；不随应用进程树退出的关窗守卫 `server/napcat-guardian.mjs` 执行一次后备清理。

以源码运行时：在仓库根目录执行 `npm install` 与 `npm run dev`（或双击 `启动管理端.bat`）。桥接层在 `qq-bridge/` 下执行 `copy config.example.json config.json` 并填写后，再执行 `npm start`。桥启动时把 preset、MCP 组与内置插件幂等安装进隔离 DSH home（`qq-bridge/src/lib/dsh-side.js`），默认不修改桌面端 DSH 实例；手动补装执行 `node qq-bridge/scripts/setup-dsh.mjs`。

以手动方式接入时，缺少的部件只有 NapCat 本体：从 <https://github.com/NapCat/NapCat/releases/latest> 下载 `NapCat-v<版本>-win-x64.zip`，解压后执行 `launcher.bat`，在 WebUI 中完成首次引导（同意条款、设置密码、扫码接入 QQ 进程）并开启 WebSocket 服务端与 HTTP API，记录端口与 accessToken。

### 仓库结构

```
MoonBot Public/
├─ src/                   管理端前端（React + TypeScript + Vite）
├─ server/                管理端后端（HTTP API、实例编排与探活、SSH 部署）
├─ qq-bridge/             桥接层
│   ├─ src/core/*.js      业务：唤醒投递、会话、社交状态、发送链、媒体、语音、学习、用量
│   ├─ src/lib/*.js       基础库：OneBot 客户端、消息解析、图片体检、Pixiv、路径与文本
│   ├─ src/mcp-*.js       三组 MCP server
│   ├─ dsh/               agent preset（qq-chat）
│   ├─ plugins/           DSH 插件：dsh-qq-hold、qq-mode-console、dsh-memory
│   ├─ characters/        角色库（一个子目录 = 一个角色包）
│   ├─ roles/             角色卡（一个 .md = 一个角色）
│   ├─ config.example.json  出厂配置模板
│   └─ state/             运行数据（记忆库、聊天记录、社交状态、用量日志）
├─ tools/                 管理端侧开发与运维脚本
├─ docs/                  文档集
└─ CHANGELOG.md  LICENSE
```

## 快速开始

### 启动、停止与端口

表 2：端口与默认值

| 部件 | 地址 | 说明 |
| --- | --- | --- |
| 管理端 | `http://127.0.0.1:1921` | 界面入口；首页三张卡负责启动、重启、停止 |
| NapCat WebUI | `http://127.0.0.1:6099` | 登录令牌出厂为 `truefriend`，可由 `instances.napcatLocal.webuiToken` 覆盖 |
| NapCat OneBot | HTTP `http://127.0.0.1:3000`、反向 WS `ws://127.0.0.1:3001` | 出厂注入，令牌 `truefriend`；改动后须重启 NapCat 才生效 |
| 隔离 DSH | `http://127.0.0.1:10721` | `dsh.baseUrl` 缺省值，可由环境变量 `QQB_DSH_BASE_URL` 覆盖 |
| qq-bridge 控制台 | `http://127.0.0.1:3100` | 配置项 `consolePort`；配置合法 `consoleToken` 后所有请求须带 `x-console-token` |

- 整套启动：首页按钮按 NapCat → 隔离 DSH → 桥的顺序拉起；NapCat 首次仍需扫码。
- 单服务控制：每张卡各自提供启动、重启与停止，卡右下角齿轮为其启动配置。
- 连接服务器后，首页三张卡即代表服务器那一套，状态行显示服务端运行或未运行，按钮改为操作远端（隔离 DSH 走 `systemctl dsh-web`，NapCat 走 `docker`，桥走其自身启动脚本）。
- 打开界面：NapCat 与隔离 DSH 卡的「打开」经隧道加载远端界面并自动携带该机令牌；隧道映射为 NapCat WebUI 6099→13000、NapCat HTTP 3000→13001、DSH 3080→13080、桥控制台 3100→13100（桥控制台仅支持「新窗口打开」）。

### 聊天窗口命令

仅管理员私聊可用，由桥直接执行、不经过模型：`/reset` 或 `/new`（重置当前会话，保留已回复账本以防重复回复）、`/status`（会话 id、白名单是否通过、角色与模式）、`/token [天数]`（用量与花费）、`/op <QQ或昵称>` 与 `/op del <QQ或昵称>`（增删管理员，仅账号所有者）、`/role <包名>` 与 `/role clear`（从角色库合成人设或回到默认人格）、`/slang ...`（黑话学习）。

### SSH 配置与服务器同步

1. 首页「SSH 配置」卡 →「添加服务器」：填写名称、主机、端口、用户名以及密码或密钥，先「测试」再「连接」。
2. 连上之后，功能配置页读写的是服务器的 `/root/qq-bridge/config.json`（页首有横幅提示）：保存流程为备份 `config.json.bak-<时间戳>` → 原子替换 → 回读比对关键字段；桥按 mtime 热加载，无需重启桥即可生效，人设与发言规则亦可一并写入服务端。
3. 每台服务器行另设「同步」（把本地桥代码推送至服务器）与「清整套」（删除远端整套并备份）按钮。
4. 连接测试失败会短暂冷却（无法连接或超时 20 → 40 → 60 秒，凭据类 10 秒），提示中给出具体报错并提供「仍然重试一次」；不要反复点击测试，服务器上的 fail2ban 按认证失败次数封禁来源 IP，被误封时在服务器执行 `fail2ban-client set sshd unbanip <本机IP>`。

## 主要能力

- **桥接与消息**：唤醒判定（私聊、被 @、被引用、点名、关键词、直接提问、AI 与技术话题、指定发言人与概率接话），潜水与活跃双模式，活跃时段与免打扰窗口，在途注入与回合保持，私聊打字等待，文本气泡分段与发送节奏，引用回复、撤回、定时消息、跨会话留言，富文本卡片、音乐卡、合并转发与 Word 文档，收发图片，Pixiv 搜图与发图，QQ 空间动态与配图，语音合成与转写，QQ 原生表情、收藏贴纸与内置表情包，视频解析与检索。
- **记忆与画像**：SQLite 长期记忆（三层记忆 + FTS5 检索）、会话级记忆、群成员画像与结构化档案、黑话学习、人格学习、角色库与角色卡，以及隔离 DSH 侧的跨会话语义记忆插件（`remember` / `recall` / `/lmemory`）。
- **NapCat 集成**：三组 MCP server（`mcp-napcat` / `mcp-napcat-host` / `mcp-web-search-safe`），工具描述压缩代理与名单档位裁剪，发送白名单强制，`[CQ:` 注入转义，敏感内容拦截，NapCat 会话守护与登录态巡检。
- **SSH 部署与同步**：远程部署保留目标机既有数据，代码、数据、表情包与 `config.json` 分别同步；配置热加载；上下文压缩（阈值 0.16）与工具表压缩；Token 计量与费用估算。
- **管理端页面**：首页（进程与日志）、实例配置、SSH 配置、功能配置、聊天记录、群友画像、学习与用量、语音、内嵌界面、关系图。

### MCP 工具

三组 MCP server 共注册 98 条工具：`mcp-napcat` 91 条、`mcp-napcat-host` 5 条、`mcp-web-search-safe` 2 条。运行时实际注册数另受工具名单档位裁剪（`toolAllowedByTier`）与 `config.json` 的开关分支影响（如 `napcat.allowProcessControl` 关闭时进程控制工具不注册）。下表为名称清单，必填与可选参数、最低保留档位与功能表述见 [docs/TECHNICAL.md](docs/TECHNICAL.md) 附录 A 与附录 B。

表 3：MCP 工具清单（98 条）

| 用途分组 | 条数 | 工具 |
| --- | --- | --- |
| 状态、时间与运行时信息 | 5 | `qq_status`、`get_time`、`qq_get_prompt`、`qq_social_state`、`qq_global_overview` |
| 群组与会话 | 4 | `qq_list_groups`、`qq_get_group_members`、`qq_get_group_owner`、`qq_get_active_members` |
| 消息发送 | 7 | `qq_send_message`、`qq_reply`、`qq_send_group_message`、`qq_send_private_message`、`qq_proactive_send`、`qq_withdraw_message`、`qq_send_poke` |
| 消息读取与历史 | 8 | `qq_get_unread_messages`、`qq_get_recent_messages`、`qq_get_my_recent_messages`、`qq_get_message_detail`、`qq_get_group_history`、`qq_get_forward_msg`、`qq_history_delete`、`qq_history_clear` |
| 唤醒、收尾与等待 | 3 | `qq_set_wake_config`、`qq_mark_read`、`qq_wait_for_messages` |
| 记忆与群内用语 | 8 | `qq_memory_search`、`qq_memory_remember`、`qq_memory_query`、`qq_memory_append`、`qq_memory_remove`、`qq_memory_clear`、`qq_slang_query`、`qq_slang_submit` |
| 人设与角色 | 8 | `qq_persona_learn_start`、`qq_persona_learn_stop`、`qq_persona_learn_status`、`qq_character_list`、`qq_character_read`、`qq_character_pack`、`qq_character_search`、`qq_character_switch` |
| 档案、关系与权限 | 7 | `qq_profile_get`、`qq_profile_set`、`qq_like`、`qq_blacklist`、`qq_remove_friend`、`qq_admin_set`、`qq_whitelist` |
| 图片、表情与表情包 | 13 | `qq_get_message_images`、`qq_send_image`、`qq_get_self_image`、`qq_list_stickers`、`qq_get_sticker_image`、`qq_send_sticker`、`qq_collect_sticker`、`qq_sticker_note`、`qq_set_sticker_remark`、`qq_meme_search`、`qq_send_meme`、`qq_face_list`、`qq_send_qq_face` |
| 语音、文件与文档 | 4 | `qq_send_voice`、`qq_transcribe_voice`、`qq_get_file_content`、`qq_send_docx` |
| 卡片、转发与视频 | 4 | `qq_send_rich`、`qq_send_forward`、`qq_video_parse`、`qq_video_search` |
| 网络素材检索 | 4 | `qq_image_search`、`qq_pixiv_search`、`qq_send_pixiv`、`qq_music_search` |
| QQ 空间 | 5 | `qq_qzone_view`、`qq_qzone_comment`、`qq_qzone_reply_comment`、`qq_qzone_like`、`qq_send_qzone` |
| 计划与定时 | 3 | `qq_schedule_message`、`qq_schedule_list`、`qq_schedule_cancel` |
| 跨会话通信 | 2 | `qq_crosschat_send`、`qq_crosschat_inbox` |
| 配置与管理 | 6 | `qq_get_system_config`、`qq_set_system_config`、`qq_get_activity_hours`、`qq_set_activity_hours`、`qq_deepsleep`、`qq_report_feedback` |
| 宿主服务（`mcp-napcat-host`） | 5 | `qq_learning_corpus`、`qq_learning_submit`、`napcat_status`、`start_napcat`、`stop_napcat` |
| 联网检索（`mcp-web-search-safe`） | 2 | `web_search`、`web_fetch` |

## 配置要点

表 4：`qq-bridge/config.json` 关键项与出厂默认（模板为 `qq-bridge/config.example.json`；真实配置与 `state/` 不纳入版本管理）

| 配置项 | 出厂默认与说明 |
| --- | --- |
| `dsh.baseUrl` | `http://127.0.0.1:10721`，可由 `QQB_DSH_BASE_URL` 覆盖 |
| `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` | 会话使用的模型与推理强度；所选模型不存在时只记录日志，不阻塞启动 |
| `napcat.wsUrl` / `napcat.httpUrl` | OneBot WebSocket 与 HTTP 地址；`httpUrl` 填成 WebSocket 端口会使接口返回 HTTP 426 |
| `napcat.accessToken` | OneBot 访问令牌，须与 NapCat 网络配置一致；未配置时留空 |
| `napcat.launcherPath` / `napcat.homeDir` | NapCat 启动脚本与安装目录，供宿主侧进程控制使用 |
| `napcat.allowProcessControl` | 缺省 `false`；关闭时 `start_napcat` / `stop_napcat` 不注册 |
| `ownerQQ` | 账号所有者的 QQ 号，是管理员命令与权限判定的依据 |
| `agentPreset` / `workspaceTitle` | 会话使用的 preset 缺省 `qq-chat`；会话在 DSH 界面中的工作区名缺省 `Agents` |
| `allow.private` / `allow.groups` / `deny.*` | 白名单与黑名单（黑名单优先）；两侧为空且 `allowAllWhenEmpty: true` 时放行全部来源，此时应在配置阶段显式填写白名单 |
| `consolePort` / `consoleToken` | 控制台端口缺省 `3100`；未配置令牌时控制台默认本机可信 |

人设、角色与默认行为：

- 人设 `qq-bridge/persona.md` 与发言规则 `qq-bridge/speech-rules.md` 由 `qq-bridge/src/lib/preset-compose.js` 合成进 agent preset 的 `[PERSONA]` 与 `[SPEECH RULES]` 段，并保留运行时覆盖段：改动这两个文件立即对当前会话生效，新会话则直接从系统提示词取得。
- 出厂默认不提供人设文件，人设刻意留空，缺少人设时不扮演任何角色；发言规则随包提供内置模板 `qq-bridge/speech-rules.md`，功能配置页「人设与发言规则」可编辑并「恢复默认」写回内置模板。
- 角色卡保存在 `qq-bridge/roles/<角色名>.md`，当前角色记录在 `qq-bridge/state/current-role.json`，文件变更后无需重启即生效；单张角色卡注入上限 6000 字符，角色名只保留字母、数字、汉字、下划线与连字符，`README` 为保留名称。
- 聊天中的自然语言角色切换对非管理员一律拒绝，仅管理员可在管理端操作；`/role <包名>` 走角色库 `characters/` 的合成路径，与 `roles/` 下的角色卡是两套机制。
- 行为默认值：唤醒默认活跃（潜水须指定有限时长，到期自动恢复活跃），打字节拍 150 ms/字（桥侧夹在 60–320 ms 与 800–6000 ms 之内），上下文压缩阈值 0.16。

数据落盘与隐私：聊天记录 `qq-bridge/state/chat.db`、记忆档案 `qq-bridge/state/memory.db` 与 JSON 状态文件只保存在本机与部署方自行配置的服务器上，不上传至项目本身；模型调用会把当前会话上下文发送给部署方配置的模型服务商。隔离 DSH 侧的记忆插件另在 `~/.dsh/lmemory/` 及其注册的记忆根下保存一份语义事实记忆。

## 常用命令与故障处置

桥接层（在 `qq-bridge/` 下执行）：

```bash
npm install                  # 安装依赖
npm start                    # 启动桥，等价于 node src/bridge.js
start.bat                    # 守护方式启动：异常退出后 5 秒自动重启
restart.bat                  # 终止旧实例、清理锁文件后重新启动守护进程
npm run self-test [baseUrl]  # DSH 侧链路自测，创建独立测试会话
npm run check                # 全量回归，含 check-scope / check-size
node scripts/setup-dsh.mjs   # 手动把 preset、MCP 组与内置插件装进隔离 DSH home
```

管理端（仓库根目录）：

```bash
npm run dev                                  # 前端与后端开发模式
npm run build                                # tsc -b && vite build，改过 src/ 或 server/ 后必须执行
powershell -File tools\restart-manager.ps1   # 重启管理端后端，不影响桥与 DSH
```

服务器运维：

```bash
cd /root/qq-bridge && bash start-bridge.sh      # 启动桥接进程
bash /root/qq-bridge/tools/restart-bridge.sh    # 重启桥接，部署脚本认这一条
systemctl status dsh-web                        # 隔离 DSH
systemctl status napcat                         # NapCat（原生跑法）
```

桥接层的运行约束：

- 同一时刻只允许一个桥实例：启动时以 `state/bridge.lock` 记录 PID，检测到存活实例即以退出码 2 结束并打印「已有实例在运行」。
- 隔离 DSH 重启不影响桥：桥每 5 秒探活一次，其间收到的消息进入队列缓存（每会话上限 50 条），DSH 恢复后自动补投。
- `config.json` 由桥原地热加载；`roles/` 与 `state/current-role.json` 按文件 mtime 感知；agent preset 与 MCP 配置的改动须重启隔离 DSH。

表 5：常见故障与最短处置

| 现象 | 处置 |
| --- | --- |
| 机器人无回复 | 查 `qq-bridge/state/bridge.log`：缺少 `NapCat 已连接` 表示连接层问题；`[napcat-login]` 行区分登录态失效与连接中断。桥不退出进程，按退避持续重连 |
| 桥异常或消息无响应 | 执行 `restart.bat`，它终止旧实例并清理锁文件后重新启动守护进程 |
| 配置改动未生效 | 桥日志应出现 `已热加载，变更字段: …`；`agentPreset` 只在创建会话时绑定，旧会话需等待轮换或归档重建；工具名单档位在注册期生效，改动后须重启隔离 DSH |
| 唤醒后响应延迟 | 打字节拍被 `clampSendPace` 夹在 60–320 ms 与 800–6000 ms 之内，检查 `social.send` 取值 |

已知限制：

- 回复在回合结束时统一发送，不做流式逐字转发；单条正文超过 4000 字符时按换行切分。
- Markdown 转为纯文本：链接保留为 `文字 (url)` 形式，代码围栏、标题符与列表符被去除或改写。
- 视频段与转发内容中的非文本段渲染为 `[视频]` 等占位标记；文件段渲染为 `[文件:名称 · 类型 · 大小]`。
- 宿主进程控制在缺省配置下不可用：`start_napcat` / `stop_napcat` 不注册。
- 发送的图片可能为缩略图或内容不完整，见 [docs/PIXIV-AND-QZONE.md](docs/PIXIV-AND-QZONE.md)；单句成本偏高见 [docs/TECHNICAL.md](docs/TECHNICAL.md)。

## 文档索引

表 6：配套文档

| 文档 | 内容范围 |
| --- | --- |
| [docs/TECHNICAL.md](docs/TECHNICAL.md) | 体系结构（分层、单条消息的处理路径、状态落盘位置、端口与安装布局、线上部署）、能力域清单与生产约束、MCP 工具与路由全表、上下文压缩的数学建模与标定 |
| [docs/PIXIV-AND-QZONE.md](docs/PIXIV-AND-QZONE.md) | pixiv 原图发送链路的构成、QQ 空间配图不落盘的原因 |
| [CHANGELOG.md](CHANGELOG.md) | 逐版本变更记录 |

桥接层的项目说明书与 DSH 端安装说明见 [qq-bridge/docs/PROJECT_GUIDE.md](qq-bridge/docs/PROJECT_GUIDE.md) 与 [qq-bridge/docs/DSH_SETUP.md](qq-bridge/docs/DSH_SETUP.md)；本地运行与手动同步说明见 `本地运行指引.md` 与 `手动同步与SSH说明.md`。

## 许可与致谢

MIT，见 [LICENSE](LICENSE)。

第三方组件：NapCat 是独立第三方项目，与腾讯及 QQ 无隶属关系，仅用于学习与技术研究；使用前应阅读其 EULA 与《QQ 用户协议》。

访问控制：发送类工具的目标必须命中白名单（`allow.private` / `allow.groups`）；正文中的 `[CQ:` 一律转义，拒绝 CQ 码注入；NapCat 的进程控制缺省关闭。白名单两侧为空且 `allowAllWhenEmpty: true` 时全部来源被放行，此时账号的发送能力等同于交由模型使用，因此应在配置阶段显式填写白名单。
