export interface SSHServer {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'key';
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** 服务器上各服务的端口（默认 6099/3000/3080/3100） */
  remotePorts?: Partial<Record<'napcatWebui' | 'napcatHttp' | 'dshWeb' | 'bridge', number>>;
  /** 上次成功登录用的端口（管理端记住的）：填错端口的表现就是"认证失败"，靠它提示用户 */
  lastGoodPort?: number;
  lastGoodAt?: string;
}

export interface Tunnel {
  id?: string;
  serverId?: string;
  name: string;
  localPort: number;
  remotePort: number;
  status: 'active' | 'inactive' | 'error';
}

export interface ServiceInfo {
  id: string;
  name: string;
  desc: string;
  url: string;
  reachable: boolean;
  status?: number;
  /** 【2026-09-14】local = 本机那套；remote = 服务端（经 SSH 隧道）那套。两组并列，绝不互相顶替。 */
  scope?: 'local' | 'remote';
  /** 目标回了 X-Frame-Options / CSP frame-ancestors，浏览器会拒绝内嵌 → 前端改给「新窗口打开」 */
  iframeBlocked?: boolean;
  iframeBlockReason?: string;
}

/** 服务端现场状态（GET /api/ssh/status，复用已建立的 SSH 连接取得） */
export interface RemoteServerStatus {
  ok: boolean;
  connected: boolean;
  at?: number;
  message?: string;
  error?: string;
  server?: { id: string; name: string; host: string };
  dsh?: { unit: string; active: string; enabled: string; running: boolean; port: number; portUp: boolean; hasToken: boolean };
  napcat?: { container: string; status: string; running: boolean; exited: boolean; ports: Record<string, boolean>; hasWebuiToken: boolean };
  bridge?: { running: boolean; pids: number[]; cmd: string; port: number; portUp: boolean; dir: string };
  remotePorts?: { dsh: number; napcat: number; napcatHttp: number; bridge: number };
  timestamp?: string;
}

export interface ManagerState {
  mode: 'local' | 'ssh';
  activeServer: { id: string; name: string; host: string } | null;
  services: ServiceInfo[];
  tunnels: Tunnel[];
  connected: boolean;
  instances: LocalInstance[];
  /** 服务端现场状态（连上服务器时才有；本机状态在 instances 里，两者分开两处展示） */
  remoteStatus?: RemoteServerStatus | null;
  /** 断线自动重连的现场状态（重连中才有值）：界面显示"服务端重连中…"而不是"未运行" */
  reconnecting?: { serverId: string; attempt: number; inSeconds: number; reason?: string } | null;
  /** 安装位置体检（装在 Program Files / 同步盘等风险位置的提醒；正常安装为空） */
  warnings?: string[];
  /** 【2026-09-17】本机与服务端同时有 NapCat 在线（同一个 QQ 号两处登录，会被腾讯互踢）；界面要显著提醒 */
  dualNapcat?: boolean;
}

export interface LocalInstance {
  id: 'dsh-isolated' | 'napcat-local' | 'bridge-local';
  name: string;
  desc: string;
  kind: 'dsh' | 'napcat' | 'bridge';
  /** 实例自身配置 */
  config: DSHIsolatedConfig | NapcatLocalConfig;
  /** 进程状态 */
  proc: {
    running: boolean;
    pid?: number;
    port?: number;
    startedAt?: string;
    logFile?: string;
  };
  /** 官方界面可达性（健康探测） */
  reachable: boolean;
  url?: string;
  port?: number;
  /** ── 服务端状态机（「启动中」按钮状态的唯一事实来源）──
   *  idle → starting → running；starting 时进程退出/超时 → failed（带 error）。
   *  由管家进程用**真实探活**推进，前端只负责渲染，不再自己猜。 */
  phase?: 'idle' | 'starting' | 'running' | 'stopping' | 'failed';
  phaseAt?: number;
  readyAt?: number;
  /** 当前阶段已持续毫秒（启动中用来显示秒数） */
  elapsedMs?: number;
  /** 失败原因（从实例日志尾部挑出的最像"为什么起不来"的那行） */
  error?: string;
  /** 正在等什么（例如「WebUI 已起，等待 QQ 扫码登录」） */
  note?: string;
  /** NapCat 专用：OneBot 端口在监听 = QQ 已登录 */
  loggedIn?: boolean;
  /** 进程不是本管理器启动的，被探活认回来的 */
  adopted?: boolean;
}

export interface DSHIsolatedConfig {
  enabled: boolean;
  port: number;
  isolatedHome: string;      // 独立 DSH_HOME（隔离，不与本机 3210 共用）
  profile: string;           // 默认 web
  dshCli: string;            // dsh CLI 路径
  extraArgs?: string[];
  env?: Record<string, string>;
}

export interface NapcatLocalConfig {
  enabled: boolean;
  /** 启动器/启动命令：可以是可执行文件路径或命令模板 */
  launchCommand: string;
  workDir?: string;
  /** Windows OneKey 目录（空=自动探测） */
  installDir?: string;
  /** 快速登录 QQ 号（空=自动探测/二维码） */
  quickLogin?: string;
  webuiPort?: number;        // 本机 WebUI 端口（默认 6099）
  /** NapCat WebUI 登录 token（默认 truefriend） */
  webuiToken?: string;
  env?: Record<string, string>;
}

export interface LocalEndpoints {
  napcatWebui: number;
  napcatHttp: number;
  dshWeb: number;
  bridge: number;
}

export interface ManagerConfig {
  servers: SSHServer[];
  activeServerId: string | null;
  local: LocalEndpoints;
  instances: { dshIsolated: DSHIsolatedConfig; napcatLocal: NapcatLocalConfig; bridgeLocal: NapcatLocalConfig };
  connected: boolean;
  activeServer: SSHServer | null;
}

export interface OpenResult {
  success: boolean;
  url?: string;
  reachable?: boolean;
  mode?: 'local' | 'ssh';
  name?: string;
  message?: string;
}

export interface InstanceActionResult {
  success: boolean;
  message: string;
  instance?: LocalInstance;
  /** 服务端状态机在动作下发后的即时阶段：start 会立刻回 starting，随后由 /api/state 推进 */
  phase?: 'idle' | 'starting' | 'running' | 'stopping' | 'failed';
  /** 正在等什么（如「WebUI 已起，等待 QQ 扫码登录」） */
  note?: string;
  /** 一键启动整套：每一步的阶段/耗时/错误 */
  steps?: Array<{
    id: string;
    success: boolean;
    message: string;
    phase?: 'idle' | 'starting' | 'running' | 'stopping' | 'failed';
    elapsedMs?: number;
    note?: string;
    error?: string;
  }>;
}
