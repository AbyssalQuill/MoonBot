# QQ-Bridge Manager — 官方界面集成版 (v3.1 nc_pink)

> 数据来源/设计参照：官方仓库 [NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ)（`packages/napcat-webui-frontend`，主题 = 官方 **nc_pink**，本仓库自带的 HeroUI 亮色 Pink token）与 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`apps/web`，即 DeepSeek Harness 官方 Web GUI）。

## 主题

界面配色、圆角（8/12/14px）、阴影、按钮/徽章样式全部取自 NapCat WebUI 官方 **nc_pink**（亮色粉）主题 token（`napcat-webui-frontend` 构建产物 `nc_pink.light` 段），非自造暗色主题。

## 设计原则（v3 与 v2 的区别）

- ❌ **不自研仿版控制台**：不再自己画 NapCat/DSH/Bridge 的仿制管理页。
- ❌ **不做内嵌无效首页**：不在管理器里 iframe 一个孤零零的 6099 页面当「首页」。
- ✅ **官方原版界面直达**：首页打开就是几个按钮——「打开 NapCat 官方界面」「打开 DeepSeek Harness 官方界面」「SSH 配置」。点按钮即**跳转**到官方原版 WebUI（新窗口），两个官方界面可互相切换。
- ✅ **应用内拉起**：不必自己先启动 dsh——首页可直接「应用内拉起」一个**隔离 DSH**（独立 DSH_HOME + 独立端口 13210，不与你正在用的本机 3210 dsh 共用数据）；也可以配置命令后在本应用内拉起本机 NapCat。启动后「打开官方界面」自动指向该实例。
- ✅ **本地运行 + SSH 远程都支持**：本机跑着服务就直连本机端口；远程 Ubuntu 则经 SSH 隧道映射到 127.0.0.1 后再打开官方界面。

## 运行

```bash
npm install
npm run dev        # vite(5173) + api(3177)，浏览器开 http://localhost:5173
# 或生产模式
npm run build && node server/index.js   # 单端口 http://127.0.0.1:3177 托管 dist + API
```

后端配置持久化在 `~/.qq-bridge-manager/config.json`（服务器列表、本机端点、活动服务器）。

## 端口约定

| 服务 | 本机默认 | 应用内拉起（隔离） | 远程(经 SSH 隧道→本机) |
|---|---|---|---|
| NapCat WebUI | 6099 | 6099（本机 NapCat 启动器） | 6099 → 13000 |
| NapCat HTTP | 3000 | — | 3000 → 13001 |
| DeepSeek Harness Web | 3210 | **13210**（隔离实例） | 3080 → 13080 |
| Bridge 控制台 | 3100 | — | 3100 → 13100 |

首页「打开」按钮始终指向**官方原版界面**，优先级：本机隔离实例（运行中）→ 本机默认端口 → SSH 隧道端口。

## API（server/index.js，默认 3177，可用环境变量 QBM_API_PORT 覆盖）

- `GET /api/config` / `POST /api/config` — 配置读写（含 instances 本地实例配置）
- `GET /api/state` — 模式(本地/SSH)、服务可达性与 URL、活动隧道、本机实例状态
- `GET /api/open?target=napcat-webui|napcat-http|dsh-web|bridge` — 跳转前探测，返回官方 URL
- `POST /api/instance/:id/:action` — 本机实例 `start|stop|restart`（`dsh-isolated` / `napcat-local`）
- `GET /api/instance/:id/logs?tail=N` — 实例日志尾部
- `POST /api/ssh/test|connect|disconnect` — SSH 测试 / 连接(建隧道) / 断开

## 目录

```
src/App.tsx            壳：首页/SSH/实例/QQ-Bridge 配置 同页跳转（ESC 返回）
src/pages/Home.tsx     启动器（2×2 大按钮 + 打字机标题）· 应用内拉起
src/pages/WebView.tsx  应用内 iframe 打开官方界面（不新开标签）
src/pages/SSHConfig.tsx 服务器列表（先列表后添加）
src/pages/InstanceConfig.tsx 单实例配置（含 VBS 隐藏启动器信息）
src/pages/BridgeConfig.tsx QQ-Bridge 零代码功能配置（中文分栏 UI）
src/api.ts             后端封装
src/styles/global.css  nc_pink 主题 token + AaCute 圆体标题字体
server/index.js        Express API：配置 / SSH 隧道 / 状态探测 / 实例编排 / 静态托管
```

## 内置运行时（v3.3 起全部随项目走，自动探测，无需配置）

```
QQ-Bridge/
├─ qq-bridge\       内置桥接层源码（原 Desktop\WorkSpace\qq-bridge）
├─ napcat-onekey\   内置 NapCat OneKey（原 Downloads\NapCat.Shell.Windows.OneKey）
├─ dsh\             内置 DeepSeek Harness 源码（原 Desktop\DSH）
└─ .runtime\        隔离 DSH 数据目录（独立 DSH_HOME）
```

后端对 NapCat OneKey / dsh CLI / qq-bridge 均按「项目内 → 常见位置 → PATH」自动探测，
旧配置中的失效路径会自动回退到新默认，目录搬家不影响使用。

## 相关文档

架构总文档：`C:\Users\17367\Desktop\WorkSpace\QQ-Bridge-Manager-架构文档.md`（v3 已取代 v2）。
