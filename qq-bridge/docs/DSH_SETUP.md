# DSH 端安装说明

本文界定在目标设备的 DSH 环境中安装两个聊天模式（`qq-chat` / `default`）与三个 MCP 挂载项的步骤、判据与
故障处置对照。内容面向另一台设备的首次安装与脚本迁移后的重装。

## 目录

```text
0. 适用范围与前置条件
1. 安装步骤
2. 验证判据
3. 故障处置对照
4. 未核验声明
```

**证据等级**：`【已核验】` 表示读过源码或跑过命令；`【据仓库记载】` 表示引自其它文档；`【未核验】` 表示推断或
未复现。

---

## 0. 适用范围与前置条件

本章界定本文的适用范围与组件边界。

`qq-bridge` 仓库包含桥接层、控制台与插件；DSH 端的两个聊天模式（`qq-chat` / `default`）与 MCP 挂载项不在
仓库根目录内，需按本文安装到目标设备的 DSH 环境中。

表 1：组件归属（口径：安装主体列为该组件的安装位置）

| 组件 | 内容 | 安装主体 |
| --- | --- | --- |
| 桥接层 | `src/bridge.js`、`src/dsh-client.js`、`src/mcp-*.js` | 仓库自带 |
| agent preset | `~/.dsh/.agent-presets/qq-chat` | 由 `scripts/setup-dsh.mjs` 安装 |
| MCP 挂载项 | `mcp-napcat`、`mcp-napcat-host`、`mcp-web-search-safe` | 由 `scripts/setup-dsh.mjs` 写入 profile 的 `cordis.patch.yml` |
| 控制台插件 | `qq-mode-console` | 由 `scripts/setup-dsh.mjs` 写入 profile 的 `package.json` |

前置条件：目标设备已安装 Node.js 与 npm；目标设备的 DSH 已安装且 `dsh` CLI 可用（不可用时缺失依赖需手动补齐，
见 §3）。

---

## 1. 安装步骤

本章界定安装的执行顺序。步骤之间为强顺序关系，前一步完成是后一步成立的前提。

### 1.1 获取仓库

```bash
git clone https://github.com/Derpyu520/qq-bridge.git
cd qq-bridge
```

### 1.2 安装依赖

```bash
npm install
```

`postinstall` 会自动修补旧版网关 SDK 的 ESM 打包缺陷。

### 1.3 创建配置文件

```bash
cp config.example.json config.json
```

Windows CMD 环境使用：

```bash
copy config.example.json config.json
```

随后编辑 `config.json`，按下表填写字段。

表 2：配置字段（口径：端口示例为默认部署形态；实际取值以目标设备为准）

| 字段 | 取值说明 |
| --- | --- |
| `napcat.wsUrl` | OneBot WebSocket 地址，例如 `ws://127.0.0.1:3001` |
| `napcat.httpUrl` | OneBot HTTP API 地址，例如 `http://127.0.0.1:3000` |
| `napcat.accessToken` | OneBot 鉴权令牌 |
| `ownerQQ` | 所有者账号标识 |
| `allow.private` / `allow.groups` | 私聊与群聊白名单 |

### 1.4 执行 DSH 端安装脚本

```bash
node scripts/setup-dsh.mjs
```

默认安装到 `web` profile。DSH 使用其它 profile 时通过参数指定：

```bash
node scripts/setup-dsh.mjs <profile名>
```

也可用环境变量指定 DSH 根目录：

```bash
DSH_HOME=/path/to/.dsh node scripts/setup-dsh.mjs <profile>
```

脚本完成的动作：

表 3：安装脚本动作（口径：路径为脚本写入的绝对或 profile 相对位置）

| 动作 | 目标 |
| --- | --- |
| 安装 agent preset | `~/.dsh/.agent-presets/qq-chat` |
| 挂载 MCP 条目 | `~/.dsh/profiles/web/cordis.patch.yml` 挂载 `mcp-napcat`（`src/mcp-napcat-safe.js`）、`mcp-napcat-host`（`src/mcp-host-server.js`）、`mcp-web-search-safe`（`src/mcp-web-search-safe.js`） |
| 注册控制台插件 | 在 `~/.dsh/profiles/web/package.json` 注册 `qq-mode-console` |
| 设定默认模式 | 把 `qq-mode-console` 插件的默认模式设为 `reserved2` |
| 创建模式状态文件 | 创建本地 `state/mode.json`（`mode: reserved2`），作为 DSH settings 不可用时的后备路径 |
| 注册插件依赖 | 尝试自动执行 `dsh plugin --profile web install`（当 `dsh` CLI 在 PATH 中可用时），注册 `qq-mode-console` 的 bundle 依赖；`dsh` 不在 PATH 时，缺失依赖由 DSH 在启动时提示补跑 |

表 4：脚本的重复执行语义（口径：重复运行与搬迁两种情形）

| 情形 | 行为 |
| --- | --- |
| 重复运行 | 脚本可重复运行：覆盖 `~/.dsh/.agent-presets/qq-chat*`、更新 MCP 路径、重建失效的插件链接 |
| 已存在的模式文件 | `qq-bridge/state/mode.json` 被保留，不覆盖既有设置；仅全新安装写入 `mode: reserved2` |
| 目录位置变更 | `qq-bridge` 目录被移动或重新克隆到其它路径后，必须重新运行本脚本，否则 DSH 中的 MCP 与插件绝对路径仍指向旧位置 |

### 1.5 重启 DSH

必须重启 DSH（或使 DSH 重新加载 profile），新 preset 与 MCP 工具才会生效。

默认模式为 `reserved2`，语义为“文本不自动转发、由模型通过工具自主收发”。改用 `chat` / `closed-agent` /
`reserved` 的途径为：在 DSH 设置页的 `qq-mode` 卡片切换，或修改 `state/mode.json` 后重启桥接层。

---

## 2. 验证判据

本章界定安装完成后的三条验证判据。

表 5：验证判据与期望结果（口径：检查项与期望结果一一对应）

| 编号 | 检查项 | 期望结果 |
| --- | --- | --- |
| V1 | DSH WebUI 设置页 | 存在 `qq-mode` 配置卡片，可在 `chat` / `closed-agent` / `reserved` / `reserved2` 之间切换 |
| V2 | 新建会话时的 agent preset 列表 | 存在 `QQ 聊天角色`（`qq-chat`）与 `QQ 聊天角色`（`default`）两项 |
| V3 | QQ 会话中的工具列表 | 存在 `mcp__napcat__*`、`mcp__napcat-host__*`、`mcp__web-search-safe__*` 等工具；不存在 `dev_*` 等开发工具 |

---

## 3. 故障处置对照

本章按现象、机制、处置与判据给出故障对照。每条的现象为可观测的界面或日志输出。

表 6：故障处置对照（口径：判定顺序为机制说明，处置列为按序执行的动作）

| 编号 | 现象 | 机制 | 处置 |
| --- | --- | --- | --- |
| E1 | 看不到 `qq-mode` 设置卡片 | profile 的 `package.json` 未包含该 bundle | 确认 `setup-dsh.mjs` 已把 `qq-mode-console` 加入 profile 的 `package.json` bundles，并重启 DSH |
| E2 | MCP 工具没有出现 | `cordis.patch.yml` 中三个 MCP 条目的路径未指向当前仓库 | 确认三个条目的路径指向当前仓库，并重启 DSH |
| E3 | preset 没有出现 | `~/.dsh/.agent-presets/qq-chat` 不存在 | 确认该目录存在，并重启 DSH |
| E4 | 启动 DSH 报 `failed to parse overlay cordis.patch.yml: YAMLException` | 历史版脚本残留的空数组 `[]` 导致解析失败 | 重新运行最新版脚本（自动剥离残留内容）；或手动删除该文件中独立成行的 `[]` 后重启 DSH |
| E5 | 启动 DSH 报 `cannot resolve profile bundle "qq-mode-console"` | profile 的 bundle 依赖尚未安装 | 执行 `dsh plugin --profile web install`（`web` 替换为实际 profile 名）后重启 DSH；新版脚本会尝试自动执行该步骤 |
| E6 | 发送消息报 `unauthorized` / HTTP 401 | `config.json` 的 `napcat.accessToken` 与 NapCat 的 OneBot 实例令牌不一致 | 在 NapCat WebUI 中把 HTTP 与 WebSocket 两端的 accessToken 设为相同值，填入 `config.json`，随后重启桥接层 |
| E7 | 发送消息报 HTTP 426（Upgrade Required） | `config.json` 的 `napcat.httpUrl` 指向了 WebSocket 端口 | `httpUrl` 必须为 OneBot 的 HTTP API 地址（例如 `http://127.0.0.1:3000`），`wsUrl` 为 WebSocket 地址（例如 `ws://127.0.0.1:3001`）；在 NapCat WebUI 的 OneBot 配置中分别确认两类端口 |

网关状态诊断脚本：

```bash
node scripts/check-onebot-status.mjs
```

---

## 4. 未核验声明

表 7：未核验项清单（口径：等级按本文证据分级）

| 项 | 声明 | 等级 |
| --- | --- | --- |
| 脚本动作清单 | §1.4 的动作清单取自脚本实现与本文原始版本记录，本轮未在目标设备执行验证 | 【据仓库记载】 |
| 验证判据 | §2 的三条判据为界面与列表层面的观测，本轮未在已安装环境复核 | 【未核验】 |
| 故障对照 | §3 各条为记录的故障与其处置，本轮未逐条复现 | 【据仓库记载】 |
