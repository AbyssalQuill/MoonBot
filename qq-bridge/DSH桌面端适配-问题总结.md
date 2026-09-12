# QQ Bridge + DSH 桌面端适配：问题总结与修复记录

> 生成时间：2026-08-28
> 最后更新：2026-08-28
> 目标：让 DSH 桌面端（DeepSeek Harness.exe）能像 DSH 官网版（dsh web）一样使用 qq-bridge

---

## 一、当前状态（修复后）

| 组件 | 状态 | 端口 |
|------|------|------|
| DSH 桌面端 | ✅ 运行中 | 3080 |
| NapCat | ✅ 在线 | HTTP=3030, WS=3001 |
| qq-bridge | ✅ 运行中 | 控制台=3100 |
| agentPreset.list API | ✅ 返回 default | — |
| QQ 消息自动回复 | ✅ **已修复** | — |

---

## 二、已修复的问题

### 2.1 端口冲突（已修复）
- DSH 桌面端默认端口 **3000**（不是文档里的 3080）
- 已修改 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\backend\htoe-runtime.json`：
  `"port": 3000` → `"port": 3080`
- Bridge config.json 的 `dsh.baseUrl` 也改为 `http://127.0.0.1:3080`

### 2.2 host.describe schema（已修复 + 自动化持久化）
- DSH 桌面端的 `host.describe` 返回缺少 `home` 字段，SDK schema 把它当必填
- 已修改 `@deepseek-ai/dsh-host-apiproxy/lib/types/api/host.schema.js`：
  `home: z.string()` → `home: z.string().optional()`
- **✅ 已自动化**：`server-boot.cjs` 每次启动时自动检测并修补，DSH 升级后不再需要手动打补丁

### 2.3 NapCat WebSocket/HTTP token 不同（已修复）
- WebSocket 和 HTTP API 可能用不同端口和 token
- 已修改 `bridge.js` 第 8021 行支持 `wsAccessToken`

### 2.4 控制台令牌太短（已修复）
- 桥接要求 16-128 位，`061228` 只有 6 位
- 改为 `061228-bridge-console`

### 2.5 Agent Preset 路径错误（已修复）
- `setup-dsh.mjs` 把 preset 装到 `~/.dsh/.agent-presets/`
- DSH 桌面端的 DSH_HOME 实际是 `%APPDATA%\DeepSeek Harness\dsh-home\`
- 已手动复制 default 到 `%APPDATA%\DeepSeek Harness\dsh-home\.agent-presets\`
- 已修改 `setup-dsh.mjs` 让后续安装同时覆盖两个位置

### 2.6 cordis.patch.yml 添加 agent-presets（已修复 + 自动化持久化）
- DSH 桌面端的 base bundle 不包含 agent-presets 插件注册
- 桌面端 `%APPDATA%\...\dsh-home\profiles\web\cordis.patch.yml` 原来缺少此项
- **✅ 已修复**：在 cordis.patch.yml 中添加了 agent-presets insert
- **✅ 已自动化**：`server-boot.cjs` 每次启动时自动检测并补充，DSH 升级后不再丢失

---

## 三、核心修复方案（2026-08-28 实施）

### 3.1 根因分析

DSH 存在两个不同的 DSH_HOME：
- CLI 版（`dsh web`）：`~/.dsh/`（由 home-paths 解析）
- 桌面版（DeepSeek Harness.exe）：`%APPDATA%\DeepSeek Harness\dsh-home\`（由 server-boot.cjs 生成）

两者是**完全独立的目录**，配置不互通。

**关键差异**：
1. 桌面端 cordis.patch.yml 缺少 `agent-presets` 插件注册 → AI 无法加载 default preset
2. 已安装 backend 的 host.schema.js 中 `home` 字段不是 optional → SDK 校验失败

### 3.2 修复措施

| 文件 | 修改内容 | 持久化方式 |
|------|----------|------------|
| 桌面端 cordis.patch.yml | 添加 agent-presets insert | server-boot.cjs 自动同步 |
| host.schema.js | `home: z.string()` → `z.string().optional()` | server-boot.cjs 自动修补 |
| depends/server-boot.cjs | 添加 patchHostSchema + ensureAgentPresetsInPatch | 打包到安装目录 |
| shell/server-boot.cjs | 添加相同补丁逻辑 | 开发环境用 |
| setup-dsh.mjs | 添加 agent-presets 注入 + 桌面端同步 | 手动运行 |

### 3.3 自动化补丁机制

`server-boot.cjs` 在每次 DSH 启动时执行两个自动补丁：

1. **patchHostSchema()**：扫描 host.schema.js，发现 `home: z.string(),` 自动改为 `.optional()`
2. **ensureAgentPresetsInPatch()**：扫描 cordis.patch.yml，发现缺少 `agent-presets` 自动补充

这意味着 DSH 升级后，只需重新运行一次安装脚本（或重启 DSH），补丁会自动重新应用。

---

## 四、个性化功能保留确认

| 功能 | 状态 | 说明 |
|------|------|------|
| 开始界面过渡动画 | ✅ 保留 | shell/main.js 的 splash fade-in/out 动画完好 |
| 动态壁纸 | ✅ 保留 | skin-center 目录和 skin-center-active.json 完好 |
| 桌面刷新 | ✅ 保留 | Electron 窗口标准行为 |
| 全屏 | ✅ 保留 | BrowserWindow 支持 |

---

## 五、关键文件清单

| 文件 | 用途 | 路径 |
|------|------|------|
| config.json | 桥接主配置 | `qq-bridge/config.json` |
| bridge.js (line 8021) | wsAccessToken 支持 | `qq-bridge/src/bridge.js` |
| cordis.patch.yml (桌面) | MCP + agent-presets | `%APPDATA%\DeepSeek Harness\dsh-home\profiles\web\cordis.patch.yml` |
| host.schema.js | home 字段 optional | `.../@deepseek-ai/dsh-host-apiproxy/lib/types/api/host.schema.js` |
| server-boot.cjs (已安装) | 自动补丁 | `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\backend\server-boot.cjs` |
| server-boot.cjs (开发) | 自动补丁 | `C:\Users\17367\Desktop\DeepSeek Harness\depends\server-boot.cjs` |
| server-boot.cjs (shell) | 自动补丁 | `C:\Users\17367\Desktop\DeepSeek Harness\shell\server-boot.cjs` |
| setup-dsh.mjs | DSH 安装脚本 | `qq-bridge/scripts/setup-dsh.mjs` |

---

## 六、DSH 升级后操作指南

1. **自动补丁生效**：重启 DSH 后 `server-boot.cjs` 会自动重新修补 host.schema.js 和 cordis.patch.yml
2. **agent-presets 补丁**：如果 cordis.patch.yml 被覆盖，重启 DSH 即可自动恢复
3. **端口配置**：htoe-runtime.json 如果被覆盖，需手动改回 `"port": 3080`
4. **重新安装 preset**：运行 `node qq-bridge/scripts/setup-dsh.mjs` 可一键同步所有配置

---

## 七、官方源码对比

已拉取最新官方源码到 `dsh-official-latest/`（deepseek-ai/deepseek-harness v0.1.2-alpha.1）

关键发现：
- 官方 home-paths 默认 DSH_HOME = `~/.dsh/`
- 桌面端 server-boot.cjs 通过环境变量覆盖为 `%APPDATA%\...\dsh-home\`
- agent-presets 是官方内置插件（packages/preset/agent-presets/）
- 桌面端 base bundle 需要通过 cordis.patch.yml 显式注册

---

## 八、启动顺序

1. DSH 桌面端（端口 3080）
2. NapCat（E:\NapCat\launcher.bat）
3. 桥接（start.bat）
