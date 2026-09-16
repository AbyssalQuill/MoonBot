import express from 'express';
import cors from 'cors';
import { Client } from 'ssh2';
import { createServer, connect } from 'net';
import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import { createWriteStream, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, closeSync, copyFileSync, unlinkSync, appendFileSync, linkSync } from 'fs';
import { join, dirname, extname, basename, resolve, sep } from 'path';
import { homedir, tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { deployApi } from './deploy.js';
const deploy = deployApi();

/* 【2026-09-12 主人要求："确保这个应用安装在哪个盘都可以找到"】
 * 运行时根目录一律以**本文件所在位置**为准：<runtime>/server/index.js → <runtime>。
 * 原来有 9 处用 `process.cwd()` 当安装根目录：Electron 壳（main.js）拉起时 cwd 确实是 <runtime>，
 * 所以平时看不出问题；但用户从资源管理器双击 qbm-node.exe、用旧快捷方式/计划任务、或把后端当独立服务
 * 拉起时，cwd 会变成 C:\Windows\System32 之类 —— 于是 dsh / qq-bridge / dist / 隔离 home 全部解析错：
 * 管理端页面 404、随包 dsh 找不到、隔离 DSH home 指到 System32 下面（实测复现）。 */
const RUNTIME_ROOT = (() => {
  try {
    const parent = dirname(dirname(fileURLToPath(import.meta.url)));
    if (existsSync(join(parent, 'server', 'index.js'))) return parent;   // 仓库版与打包版都成立
  } catch { /* 理论上不会失败 */ }
  return process.cwd();                                                 // 兜底：保持旧行为
})();

const app = express();
app.use(cors());
app.use(express.json({ limit: '60mb' }));

const CONFIG_DIR = join(homedir(), '.qq-bridge-manager');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const LOG_DIR = join(CONFIG_DIR, 'logs');
if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */
const DEFAULT_LOCAL = { napcatWebui: 6099, napcatHttp: 3000, dshWeb: 3210, bridge: 3100 };

// dsh CLI 自动探测：只认随包/项目内 dsh 官方 CLI（桌面端自制 DeepSeek Harness 一律不探测、不依赖）
function findDshCli() {
  const proj = RUNTIME_ROOT; // 安装根目录（打包版 = <runtime>，与 cwd 无关）
  const cands = [
    join(proj, 'dsh', 'node_modules', '.bin', 'dsh.cmd'),
    join(proj, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(proj, 'runtime', 'dsh', 'node_modules', '.bin', 'dsh.cmd'),
    join(proj, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(proj, 'node_modules', '.bin', 'dsh.cmd'),
    join(proj, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ];
  for (const p of cands) if (existsSync(p)) return p;
  return 'dsh'; // 交给 PATH（桌面自制版不在 PATH 探测范围内）
}
// isolated home 自动落在项目数据目录（独立于桌面 3210）
const DEFAULT_ISOLATED_HOME = join(RUNTIME_ROOT, '.runtime', 'dsh-isolated-home');

const DEFAULT_CONFIG = {
  servers: [],
  activeServerId: null,
  local: { ...DEFAULT_LOCAL },
  // 管理器启动时自动把"上次是你自己启动的"实例拉回来（想关就设成 false）。
  // 为什么默认开：Electron 壳关窗时会 taskkill /T 掉管理器及其子进程（DSH/桥都会被带走），
  // 于是"关掉窗口再打开"= 整套停摆，用户得再点一次「一键启动整套」。`.enabled` 本来就是
  // "用户成功启动过它"的记号，照着它恢复才是符合意图的行为；已在跑的实例会被探活认回、不会重复拉起。
  autoStartOnBoot: true,
  instances: {
    dshIsolated: {
      enabled: false,
      port: 10721,                       // 隔离 DSH Web 端口（默认；可在实例配置里改，桥与一键启动均按此连接）
      isolatedHome: DEFAULT_ISOLATED_HOME,
      profile: 'web',
      dshCli: findDshCli(),              // 空路径也允许（startIsolatedDsh 会再自动探测）
    },
    napcatLocal: {
      enabled: false,
      launchCommand: '',                 // 空 = 自动定位 OneKey / 官方安装脚本
      workDir: '',
      installDir: '',                    // NapCat.Shell.Windows.OneKey 目录（Windows 自动探测）
      webuiPort: 6099,
      webuiToken: 'truefriend',          // NapCat WebUI 登录 token（登录 6099 网页用）
      quickLogin: '',                    // 快速登录 QQ 号；空=自动探测 napcat_*.json
    },
    bridgeLocal: {
      enabled: false,
      launchCommand: '',                 // 空 = 自动用 findBridgeDir() 的 npm start 内置启动
      workDir: '',                       // 空 = 自动探测本地 qq-bridge
      webuiPort: 3100,
    },
  },
};

function loadConfig() {
  const dflt = () => JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  try {
    if (existsSync(CONFIG_FILE)) {
      const c = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
      const base = dflt();
      const dsh = { ...base.instances.dshIsolated, ...(c.instances?.dshIsolated ?? {}) };
      const nap = { ...base.instances.napcatLocal, ...(c.instances?.napcatLocal ?? {}) };
      const br = { ...base.instances.bridgeLocal, ...(c.instances?.bridgeLocal ?? {}) };
      // 迁移容错：路径不存在（目录搬过家）→ 回退自动探测默认
      if (dsh.isolatedHome && !existsSync(dirname(dsh.isolatedHome)) && !existsSync(dsh.isolatedHome)) dsh.isolatedHome = base.instances.dshIsolated.isolatedHome;
      if (dsh.dshCli && !existsSync(dsh.dshCli)) dsh.dshCli = findDshCli();
      if (nap.installDir && !existsSync(nap.installDir)) nap.installDir = '';
      // 【2026-09-12 可移植性加强】"路径存在"不等于"属于本次安装"：换盘（或别人装到别的盘）时，
      // 旧安装还在这台机器上，上面那些 existsSync 判据会放行 → 新装的 E: 版会去驱动 D: 的 DSH / NapCat。
      // 只保留落在【当前安装树】或【当前用户主目录】内的路径，其余一律作废、重新现场探测。
      const inTree = (p) => {
        try {
          const a = resolve(String(p)).toLowerCase();
          return a.startsWith(resolve(RUNTIME_ROOT).toLowerCase() + sep)
            || a.startsWith(resolve(homedir()).toLowerCase() + sep);
        } catch { return false; }
      };
      if (dsh.isolatedHome && !inTree(dsh.isolatedHome)) dsh.isolatedHome = base.instances.dshIsolated.isolatedHome;
      if (nap.installDir && !inTree(nap.installDir)) nap.installDir = '';
      // 本地桥工作目录：若指向的不是本安装树内的有效桥（例如换机/换盘后 config 残留
      // 旧开发目录路径），一律回退自动探测（本机 runtime/qq-bridge 或 cwd/qq-bridge）。
      const bridgeInsideInstall = [join(RUNTIME_ROOT, 'qq-bridge'), join(RUNTIME_ROOT, 'runtime', 'qq-bridge')];
      if (br.workDir && !bridgeInsideInstall.some((d) => br.workDir.toLowerCase() === d.toLowerCase())) {
        const autoBridge = bridgeInsideInstall.find((d) => existsSync(join(d, 'config.json')));
        if (autoBridge) br.workDir = '';
      }
      return {
        servers: c.servers ?? [],
        activeServerId: c.activeServerId ?? null,
        local: { ...DEFAULT_LOCAL, ...(c.local ?? {}) },
        instances: { dshIsolated: dsh, napcatLocal: nap, bridgeLocal: br },
      };
    }
  } catch (e) {
    console.error('[config] 读取失败，使用默认配置:', e.message);
  }
  return dflt();
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

/* ------------------------------------------------------------------ */
/* SSH 连接与隧道                                                      */
/* ------------------------------------------------------------------ */
const sshConnections = new Map();
const tunnels = new Map();
/* 学习系统代理：远端 bridge 的 console-token 缓存（serverId -> { token, at }） */
const bridgeTokenCache = new Map();

function tunnelMapFor(server) {
  const m = server?.remotePorts ?? {};
  return [
    { remote: m.napcatWebui ?? 6099, local: 13000, name: 'NapCat WebUI' },
    { remote: m.napcatHttp ?? 3000, local: 13001, name: 'NapCat HTTP' },
    { remote: m.dshWeb ?? 3080, local: 13080, name: 'DSH Web' },
    { remote: m.bridge ?? 3100, local: 13100, name: 'Bridge 控制台' },
  ];
}

function openTunnels(connId, conn, list) {
  // 整体加超时：ssh2 的 forwardOut 在某些网络下会既不回调也不报错，那样 establishConnection 永远
  // await 不完 —— 表现就是"connected=true 但一条隧道都没有"（界面里服务端界面全点不开）。
  return Promise.race([
    Promise.all(list.map(({ remote, local, name }) => new Promise((resolve) => {
    /* 【2026-09-14】断线重连/连点"连接"时会先 closeTunnels 再重新 listen，而 Windows 上刚关掉的
     * 监听端口不会立刻释放 → bind 报 EADDRINUSE，于是"SSH 连上了但隧道一条都没建"
     * （表现：/api/state 里 connected=true 而 srv-* 全部 reachable=false，界面里服务端界面点不开）。
     * 现在对这个特定错误退避重试（最多 4 次，共 ~1.5s），其它错误照旧如实上报。 */
    const attempt = (tryNo) => {
      const srv = createServer((socket) => {
        conn.forwardOut(socket.remoteAddress || '127.0.0.1', socket.remotePort || 0, '127.0.0.1', remote, (err, stream) => {
          if (err) { socket.end(); return; }
          socket.pipe(stream).pipe(socket);
        });
      });
      // 隧道建立成功要**如实回报**（原来 resolve() 不带值 → 响应里 tunnels 全是 null，
      // 用户看不出到底建了几条、映射到哪个端口）。失败也要回一条说明，而不是静默。
      srv.on('error', (err) => {
        if (err?.code === 'EADDRINUSE' && tryNo < 4) {
          setTimeout(() => attempt(tryNo + 1), 400);
          return;
        }
        console.error(`[tunnel ${name}]`, err.message);
        resolve({ name, local, remote, ok: false, error: err.message });
      });
      srv.listen(local, '127.0.0.1', () => {
        tunnels.set(`${connId}:${name}`, { server: srv, local, remote, name });
        resolve({ name, local, remote, ok: true });
      });
    };
    attempt(1);
    }))),
    new Promise((resolve) => setTimeout(() => resolve(list.map(({ local, remote, name }) => ({ name, local, remote, ok: false, error: '隧道建立超时（8s）' }))), 8000)),
  ]);
}

/** 隧道健康检查 + 自愈：连接还在、隧道却没了（或丢了某几条）就补建。
 *  现场教训（2026-09-15 主人反馈"主页界面打不开 / 一键启动有问题"）：/api/state 显示
 *  connected=true，但 13000/13080/13100 **一个都没在听** —— 界面里所有"打开"全点不开。
 *  根因是 establishConnection 先记连接、再建隧道，隧道失败/超时后没人补。现在每次取状态都自检一遍。 */
async function ensureTunnels(serverId) {
  const conn = sshConnections.get(serverId);
  if (!conn) return false;
  const cfg = loadConfig();
  const server = cfg.servers.find((s) => s.id === serverId);
  if (!server) return false;
  const want = tunnelMapFor(server);
  const alive = (tun) => { try { return !!(tun?.server && tun.server.listening); } catch { return false; } };
  const missing = want.filter(({ name }) => !alive(tunnels.get(`${serverId}:${name}`)));
  if (!missing.length) return true;
  mlog(`[ssh] ${server.name || server.host} 隧道缺失 ${missing.length}/${want.length} 条 → 自动补建`);
  closeTunnels(serverId);            // 先清掉"挂着但其实没在听"的条目
  try {
    const created = await openTunnels(serverId, conn, want);
    const okCount = created.filter((x) => x.ok).length;
    mlog(`[ssh] ${server.name || server.host} 隧道补建：${okCount}/${want.length} 条成功`);
    return okCount === want.length;
  } catch (e) {
    mlog(`[ssh] ${server.name || server.host} 隧道补建失败：${e?.message ?? e}`);
    return false;
  }
}

function closeTunnels(connId) {
  for (const [key, tun] of tunnels.entries()) {
    if (key.startsWith(connId + ':')) { try { tun.server.close(); } catch {} tunnels.delete(key); }
  }
}

/* ── 断线自动重连（2026-09-15 主人反馈"感觉服务器又断连了…为啥老是断连"）─────────────
 * 现场：管理器本机开着，但 /api/state 里 connected=false、到 50470 一条 established 都没有 ——
 * SSH 连接掉了，而**旧代码掉了就永远掉了**：`conn.on('close')` 只清缓存，没有任何重连，
 * 于是界面一直显示"服务端未运行"，非要人手点一次「连接」。关掉应用再打开也一样（内存里的连接表本来就空了）。
 *
 * 现在两条路都补上：
 *   ① 自动重连：连接**非用户主动断开**地掉了 → 按 5s/10s/20s/30s/60s 退避重连，直到成功；
 *      重连成功会重建隧道、刷新状态缓存（与点「连接」走同一段代码）。
 *   ② 开机自动连：管理器启动时如果上次连着某台服务器（activeServerId），自动把它连回来 ——
 *      打开应用就该看到"服务端运行中"，而不是一个空壳界面。
 * 安全边界：用户在界面上点过「断开」的那台不会自动重连；SSH 冷却期（凭据错/网络不通的连败）内不硬试，
 *           免得把 fail2ban 招来，冷却结束再补一次。
 */
const reconnectTimers = new Map();     // serverId -> timer
const manualDisconnects = new Set();   // 用户明确点过「断开」的 serverId（不自动重连）
let reconnectState = { serverId: null, attempt: 0, nextAt: 0, reason: '' };
const RECONNECT_BACKOFF_MS = [5000, 10000, 20000, 30000, 60000];

function cancelReconnect(serverId) {
  const t = reconnectTimers.get(serverId);
  if (t) { clearTimeout(t); reconnectTimers.delete(serverId); }
  if (reconnectState.serverId === serverId) reconnectState = { serverId: null, attempt: 0, nextAt: 0, reason: '' };
}

/** 与「连接」按钮同一段建立流程（鉴权 + 隧道 + 缓存作废 + 设为活动服务器）。 */
async function establishConnection(server, opts = {}) {
  if (sshConnections.has(server.id)) { try { sshConnections.get(server.id).end(); } catch {} sshConnections.delete(server.id); closeTunnels(server.id); }
  const conn = await connectOne(server, opts);
  sshConnections.set(server.id, conn);
  const tunnelsCreated = await openTunnels(server.id, conn, tunnelMapFor(server));
  // 【2026-09-15】隧道没全建起来**不再当作"连上了"**：以前先记连接、隧道失败就没人管，
  // 于是界面显示"服务端运行中"却所有界面都打不开。现在至少喊出来（并由 ensureTunnels 每次自愈重试）。
  const badTunnels = (tunnelsCreated || []).filter((x) => !x.ok);
  if (badTunnels.length) mlog(`[ssh] ${server.name || server.host} 隧道未全建成：${badTunnels.map((x) => `${x.name}(${x.error || '失败'})`).join('、')}`);
  bridgeTokenCache.delete(server.id);
  remoteStatusCache.delete(server.id); remoteBridgeDirCache.delete(server.id);
  remoteBridgeCfgCache.delete(server.id);
  const cfg2 = loadConfig();
  cfg2.activeServerId = server.id;
  saveConfig(cfg2);
  sshNoteSuccess(server);
  sshRememberGoodPort(server);
  void warmRemoteBridgeConfig(server.id, { force: true }).catch(() => {});
  // 连接掉了就自动重连（用户主动断开的那台除外）
  conn.on('close', () => {
    if (manualDisconnects.has(server.id)) return;
    if (sshConnections.get(server.id) !== conn && sshConnections.has(server.id)) return;
    mlog(`[ssh] ${server.name || server.host} 连接断开 → 自动重连`);
    scheduleReconnect(server.id, 'connection-closed');
  });
  return tunnelsCreated;
}

function scheduleReconnect(serverId, reason = '') {
  if (!serverId || reconnectTimers.has(serverId)) return;
  if (manualDisconnects.has(serverId)) return;
  const cfg = loadConfig();
  const server = cfg.servers.find((s) => s.id === serverId);
  if (!server) return;
  const attempt = (reconnectState.serverId === serverId ? reconnectState.attempt : 0) + 1;
  const cool = sshCooldownInfo(server);
  if (cool.ms > 0) {
    // 冷却期不硬试：排到冷却结束时再试一次（冷却本身是按失败性质算的，见 sshCooldownInfo）
    reconnectState = { serverId, attempt, nextAt: Date.now() + cool.ms, reason: 'cooldown' };
    mlog(`[ssh] ${server.name || server.host} 冷却中（${cool.kind}），${Math.round(cool.ms / 1000)}s 后重连`);
    const t = setTimeout(() => { reconnectTimers.delete(serverId); scheduleReconnect(serverId, reason); }, cool.ms + 500);
    reconnectTimers.set(serverId, t);
    return;
  }
  const delay = RECONNECT_BACKOFF_MS[Math.min(attempt - 1, RECONNECT_BACKOFF_MS.length - 1)];
  reconnectState = { serverId, attempt, nextAt: Date.now() + delay, reason };
  const t = setTimeout(async () => {
    reconnectTimers.delete(serverId);
    try {
      await establishConnection(server);
      mlog(`[ssh] ${server.name || server.host} 自动重连成功（第 ${attempt} 次）`);
      reconnectState = { serverId: null, attempt: 0, nextAt: 0, reason: '' };
    } catch (e) {
      mlog(`[ssh] ${server.name || server.host} 自动重连失败（第 ${attempt} 次）：${e?.message ?? e}`);
      scheduleReconnect(serverId, reason);
    }
  }, delay);
  reconnectTimers.set(serverId, t);
}

function connectOne(server, opts = {}) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const debugLines = opts.debugLines || null;
    const timer = setTimeout(() => { conn.end(); reject(new Error('连接超时')); }, 15000);
    conn.on('ready', () => { clearTimeout(timer); resolve(conn); });
    conn.on('error', (err) => { clearTimeout(timer); reject(err); });
    conn.on('close', () => { closeTunnels(server.id); bridgeTokenCache.delete(server.id); remoteStatusCache.delete(server.id); remoteBridgeDirCache.delete(server.id); if (sshConnections.get(server.id) === conn) sshConnections.delete(server.id); });
    // 私钥读取失败要给人话：以前是在 connect() 的参数里 readFileSync，路径写错只会抛出 ENOENT。
    let privateKey;
    if (server.authType === 'key' && server.privateKey) {
      try { privateKey = readFileSync(server.privateKey); }
      catch (e) { reject(new Error(`读取私钥失败：${server.privateKey}（${e.code || e.message}）—— 请确认路径与文件权限`)); return; }
    }
    conn.connect({
      host: server.host, port: server.port || 22, username: server.username,
      password: server.authType === 'password' ? server.password : undefined,
      privateKey,
      passphrase: server.passphrase || undefined,
      // 有些服务器（Debian/Ubuntu 的 PAM 配置）只走 keyboard-interactive 而不是 password；
      // 不开这个开关，ssh2 会在"所有方式都失败"上直接放弃 —— 表现就是那句没头没脑的
      // "All configured authentication methods failed"。开了以后两种服务器都能连。
      tryKeyboard: true,
      // 【2026-09-15 主人反馈"老是断连"】keepaliveInterval 原来只有 30s、没写 keepaliveCountMax（ssh2 默认 3），
      // 也就是**连续 3 次探测（≈90 秒）没回应就直接判死断开**。家庭网络抖动/NAT 超时很常见，
      // 于是隔一阵就掉一次，而掉了以后管理器又不会自己重连（见 scheduleReconnect）。
      // 现在放宽到 6 次（≈3 分钟容错），配合下面的自动重连，掉线也能自己恢复。
      keepaliveInterval: 30000, keepaliveCountMax: 6,
      // 认证失败时把服务器回的 USERAUTH_FAILURE(允许哪些方式) 抓下来 —— 这是后面翻译成
      // 可执行建议的唯一证据来源。只留认证相关行，并**遮蔽凭据**（debug 流里可能带上发出去的内容）。
      debug: debugLines ? (m) => {
        let s = String(m);
        for (const sec of [server.password, server.passphrase]) {
          if (typeof sec === 'string' && sec.length >= 3) s = s.split(sec).join('***');
        }
        if (/USERAUTH|auth failed|banner|ident/i.test(s) && debugLines.length < 200) debugLines.push(s);
      } : undefined,
    });
    // keyboard-interactive 回话：把密码作为答案交上去（服务器问什么就答密码，这是通用做法）
    conn.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
      const answers = (prompts || []).map(() => (server.authType === 'password' ? String(server.password ?? '') : ''));
      finish(answers.length ? answers : [String(server.password ?? '')]);
    });
  });
}

/** 从 ssh2 的 debug 流里读出服务器最后一次回绝时"还允许哪些认证方式"。
 *  这是把 "All configured authentication methods failed" 变成可执行建议的关键证据。 */
function readServerAuthMethods(debugLines) {
  for (let i = debugLines.length - 1; i >= 0; i -= 1) {
    const m = /USERAUTH_FAILURE \(([^)]*)\)/.exec(debugLines[i]);
    if (m) return String(m[1]).split(',').map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

/**
 * 把认证失败翻译成"下一步该干什么"。
 * ssh2 只会给一句 `All configured authentication methods failed`，它把下面这些完全不同的情况
 * 糊成同一句话，用户根本没法判断（主人 2026-09-12 就是这么被卡住的）：
 *   · 密码错 / 服务器上的密码改过；
 *   · 服务器根本不允许密码登录（只允许密钥）；
 *   · 我们压根没带凭据（密码为空 / 私钥路径没填 / 文件读不到）；
 *   · 私钥需要口令（或口令不对）；
 *   · 账号被锁 / root 登录被禁。
 */
function describeAuthError(server, err, serverMethods, sentMethods) {
  const who = `${server.username}@${server.host}:${server.port || 22}`;
  const allow = serverMethods.length ? serverMethods.join(', ') : '（未取到）';
  const sent = sentMethods.length ? sentMethods.join(' + ') : '无';
  const raw = String(err?.message ?? err ?? '');
  const head = `认证失败：${who}｜本次发送：${sent}｜服务器允许：${allow}`;
  // 服务器侧多半有 fail2ban：连错几次会把本机 IP 一起封掉，那之后表现会从"认证失败"变成"连接超时"。
  // 这句提示就是提醒"别反复点测试"——一旦被封，正确的凭据也连不上（2026-09-12 实测踩到过）。
  const banHint = '（提示：不要反复点测试 —— 服务器的 fail2ban 可能因多次失败把本机 IP 一并封禁，届时会变成"连接超时"；解封：fail2ban-client set sshd unbanip <你的IP>）';
  if (/Encrypted private key|no passphrase/i.test(raw)) return `${head}。→ 私钥有口令保护，请在「编辑」里补上私钥口令`;
  if (/Cannot parse|bad format|Invalid key/i.test(raw)) return `${head}。→ 私钥文件读不懂（格式或内容不对，或该文件其实是公钥）`;
  if (!sentMethods.length) return `${head}。→ 没有可用的凭据：密码为空 / 私钥路径未填，先补齐再测`;
  if (sentMethods.includes('keyboard-interactive')) return `${head}。→ 服务器用交互式提问认证但拒绝了本次回答，多为密码不对。${banHint}`;
  if (sentMethods.includes('password') && serverMethods.includes('password')) {
    return `${head}。→ 服务器接受密码登录、但拒绝了这份密码：**密码不对或已在服务器上改过**（可用系统 ssh 客户端用同一密码复核），也可以改用密钥登录。${banHint}`;
  }
  if (sentMethods.includes('password') && !serverMethods.includes('password')) {
    return `${head}。→ **服务器不允许密码登录**（只允许密钥）：请把公钥写进服务器 ~/.ssh/authorized_keys，或在服务器上开启 PasswordAuthentication 后重试`;
  }
  if (sentMethods.includes('publickey') && serverMethods.includes('publickey')) {
    return `${head}。→ 公钥被拒：确认服务器 ~/.ssh/authorized_keys 里有对应公钥（注意 sshd 的 AuthorizedKeysFile 是否被改成别的路径）、/root 权限 700、/root/.ssh 700、authorized_keys 600，且用的是同一把私钥。${banHint}`;
  }
  return `${head}。→ ${raw || '未知原因'}`;
}

/**
 * 诊断一次认证失败：**不再另开连接**，直接用刚才那次连接的 debug 证据翻译（少一次连接 = 少两次认证尝试，
 * 避免在开了 fail2ban 的机器上把 IP 试封）。**不打印任何凭据**。
 */
function sshAuthDiagnose(server, err, debugLines = [], sentMethodsExtra = []) {
  const sentMethods = [];
  if (server.authType === 'password' && server.password) sentMethods.push('password');
  if (server.authType === 'key' && server.privateKey) sentMethods.push('publickey');
  for (const m of sentMethodsExtra) if (!sentMethods.includes(m)) sentMethods.push(m);
  const serverMethods = readServerAuthMethods(debugLines);
  const message = describeAuthError(server, err, serverMethods, sentMethods);
  mlog(`[ssh] 诊断 ${server.username}@${server.host}: ${message}`);
  return { serverMethods, sentMethods, message };
}

/* ------------------------------------------------------------------ */
/* 探测 / 工具                                                         */
/* ------------------------------------------------------------------ */
async function probe(url, timeoutMs = 1200) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(timer);
    // 【新】顺带把"这个地址能不能被内嵌 iframe"的证据带回来：
    // 管理端的「打开官方界面」是同页 iframe，目标一旦回 `X-Frame-Options: DENY/SAMEORIGIN`
    // 或 CSP `frame-ancestors`，浏览器直接拒绝渲染 —— 用户只看到一个白框，却不知道是安全头挡的。
    // 实测服务端桥控制台就是 `X-Frame-Options: DENY`（见交付报告），所以这一项必须如实上报，
    // 由前端改给「新窗口打开」。（对齐 alignHost 的注释：不同端口＝不同 origin，SAMEORIGIN 一样挡。）
    const xfo = String(res.headers.get('x-frame-options') || '');
    const csp = String(res.headers.get('content-security-policy') || '');
    const fa = /frame-ancestors/i.test(csp) ? (csp.match(/frame-ancestors[^;]*/i) || [''])[0].trim() : '';
    const blocked = /deny|sameorigin/i.test(xfo) || (!!fa && !/frame-ancestors\s+\*/i.test(fa));
    return { reachable: true, status: res.status, xfo, frameAncestors: fa, iframeBlocked: blocked };
  }
  catch { clearTimeout(timer); return { reachable: false, status: 0, xfo: '', frameAncestors: '', iframeBlocked: false }; }
}

/* ------------------------------------------------------------------ */
/* 本机实例编排（隔离 DSH / 本地 NapCat 启动器）                        */
/* ------------------------------------------------------------------ */
const runtimes = new Map(); // instanceId -> { proc, startedAt, logFile, kind }

function instanceLogPath(id) { return join(LOG_DIR, `${id}.log`); }

/** 实例的本地监听端口（用于"它其实还在跑吗"的探活）。 */
function instancePort(id, cfg) {
  if (id === 'dsh-isolated') return Number(cfg?.instances?.dshIsolated?.port) || 10721;
  if (id === 'napcat-local') return Number(cfg?.instances?.napcatLocal?.webuiPort) || 6099;
  if (id === 'bridge-local') return Number(cfg?.instances?.bridgeLocal?.webuiPort) || 3100;
  return 0;
}

/**
 * TCP 探活 127.0.0.1:port（最长 400ms，失败一律当"没在跑"）。
 * 为什么需要：管理器的 running 只看**本进程**的 runtimes 表，重启管理器后它就是空的 ——
 * 但它拉起的 NapCat/DSH/桥接往往还活得好好的（NapCat 尤其：重复拉起会挤掉登录态）。
 * 状态要如实、启动要防重复，都得靠真实端口判断，而不是靠内存里记没记过。
 */
function probePort(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const p = Number(port) || 0;
    if (!p) { resolve(false); return; }
    let done = false;
    const sock = connect({ host: '127.0.0.1', port: p });
    const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch { /* 忽略 */ } resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => fin(true));
    sock.once('timeout', () => fin(false));
    sock.once('error', () => fin(false));
  });
}

/**
 * 管理器自身的日志。管理器是 start-manager-hidden.vbs 用 wscript **无窗口**拉起的，stdout/stderr 没人接管，
 * 一句 console.error 等于什么都没写 —— 之前"管理端保存了模型但 DSH 没变"就是这么静默掉的（前端还显示"已保存"）。
 * 关键动作一律调用本函数：既进控制台，也落到 ~/.qq-bridge-manager/logs/manager.log 供事后排查。
 */
function mlog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { mkdirSync(LOG_DIR, { recursive: true }); appendFileSync(join(LOG_DIR, 'manager.log'), line + '\n', 'utf8'); } catch { /* 日志失败不影响主流程 */ }
  console.log(line);
}

/** 从 DSH 实例日志尾部解析最新 web token（官方 dsh 0.1.2+ 每次启动打印 dsh web: …/?token=xxx）。
    官方 web 不带 token 访问一律 401，管理端「打开」与探活必须带上最新 token。
    只认最近一次 "===== start" 标记之后出现的 token，避免读到上一次运行（重启后已失效）的旧 token。 */
function readLatestDshToken(logFile) {
  try {
    if (!logFile || !existsSync(logFile)) return '';
    const size = statSync(logFile).size;
    const want = Math.min(size, 512 * 1024);
    const fd = openSync(logFile, 'r');
    const buf = Buffer.alloc(want);
    readSync(fd, buf, 0, want, Math.max(0, size - want));
    closeSync(fd);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch { try { text = new TextDecoder('gbk').decode(buf); } catch { text = buf.toString('utf8'); } }
    const startIdx = text.lastIndexOf('===== start');
    const tail = startIdx >= 0 ? text.slice(startIdx) : text;
    const m = [...tail.matchAll(/[?&]token=([A-Za-z0-9_\-]+)/g)];
    return m.length ? m[m.length - 1][1] : '';
  } catch { return ''; }
}

/** 浏览器用什么主机名开管理器，回环地址就换成同一个主机名。
 *  原因：localhost:1921 与 127.0.0.1:10721 在浏览器眼里是两个 site，
 *  内嵌 iframe 会变成「跨站」→ DSH 的 SameSite=Strict 鉴权 Cookie 存不下/发不出 → 401。
 *  对齐之后父子同站，Cookie 正常。 */
function alignHost(u, hostname) {
  if (!u || !hostname || hostname === '127.0.0.1') return u;
  try {
    const x = new URL(u);
    if (x.hostname === '127.0.0.1') { x.hostname = hostname; return x.toString(); }
  } catch { /* 非 URL，原样返回 */ }
  return u;
}

function buildRuntimeInfo(id, cfg) {
  const rt = runtimes.get(id);
  const running = !!rt && rt.proc && rt.proc.exitCode === null && !rt.proc.killed;
  let url;
  let probeUrl;
  if (id === 'dsh-isolated') {
    url = `http://127.0.0.1:${cfg.port}`;
    if (running) {
      // 官方 dsh（0.1.2+，token 鉴权）：把日志里最新 web token 拼进 GUI「打开」的 URL，
      // 否则 0.1.2 对无 token 请求返回 401 → iframe 白屏 / 「打不开」。
      const tok = readLatestDshToken(instanceLogPath(id));
      if (tok) url = `http://127.0.0.1:${cfg.port}/?token=${tok}`;
    }
    probeUrl = `http://127.0.0.1:${cfg.port}`;
  }
  if (id === 'napcat-local') {
    /* 【2026-09-15 主人要求】NapCat 界面链接**直接带鉴权**，别再让人手输 token：
     *   http://127.0.0.1:6099/webui/?token=<webuiToken>
     * （NapCat 的 WebUI 登录页认 ?token=；之前只给 `http://127.0.0.1:6099`，点开还要自己贴 token。） */
    const port = cfg.webuiPort || 6099;
    const tok = String(cfg.webuiToken ?? '').trim();
    url = `http://127.0.0.1:${port}/webui/${tok ? '?token=' + encodeURIComponent(tok) : ''}`;
    probeUrl = `http://127.0.0.1:${port}/webui/`;
  }
  if (id === 'bridge-local') { url = `http://127.0.0.1:${cfg.webuiPort || 3100}`; probeUrl = url; }
  return { running, startedAt: rt?.startedAt, pid: rt?.proc?.pid, logFile: instanceLogPath(id), url, probeUrl };
}

/** 启动一个由 API 转发的独立进程：dshell CLI 或任意命令 */
/** 启动独立进程（隐藏黑窗，脱离父进程）；失败时 error 事件也要兜底 */
function spawnDetached(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(cmd, args, {
        ...opts,
        detached: true,
        windowsHide: true,               // 不弹黑色控制台窗口
        // 允许调用方传 stdio（例如"直接写日志文件"）；默认仍是管道，兼容原有调用点。
        stdio: opts?.stdio || ['ignore', 'pipe', 'pipe'],
      });
      child.once('error', (e) => reject(e));
      child.unref();
      resolve(child);
    } catch (e) { reject(e); }
  });
}

/**
 * 起一个长期实例，把它的 stdout/stderr **直接重定向到日志文件**（不再由管理器用管道转发）。
 *
 * 为什么必须这样（2026-09-12 实测）：以前是 `child.stdout.pipe(logStream)` —— 日志管道归**管理器进程**所有。
 * 管理器一旦被重启/被 Electron 壳 taskkill，管道读端就没了，子进程下一次写 stdout 就是 EPIPE，
 * Node 对 stdout 的未处理 error 会**直接把进程打死**：表现是"重启了一下管理器，桥就悄悄没了、
 * 机器人不再回消息，而且日志里连一句错误都没有"（因为 stderr 也断了，崩栈写不出去）。
 * 改成文件描述符后，子进程直写文件，管理器死活与它无关。
 */
function spawnWithLogFile(cmd, args, opts, logFile) {
  let fd = null;
  try { fd = openSync(logFile, 'a'); } catch { fd = null; }
  if (fd == null) return spawnDetached(cmd, args, opts);
  try {
    const child = spawn(cmd, args, { ...opts, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
    child.once('error', () => { /* 由调用方的 try/catch 处理 */ });
    child.unref();
    closeSync(fd);                       // 父进程关掉自己的那份；子进程仍持有
    return Promise.resolve(child);
  } catch (e) {
    try { closeSync(fd); } catch { /* ignore */ }
    return Promise.reject(e);
  }
}

/* 隔离 home 的 .credentials.yaml（扁平 KEY: value）读入进程环境，供 dsh 的 llm provider 取 key。
   llm-pi-ai/llm-deepseek 等都从环境变量取 apiKeyEnv（如 MIMO_API_KEY / DEEPSEEK_API_KEY）。 */
function loadCredentialEnv(home) {
  const out = {};
  try {
    const f = join(home, '.credentials.yaml');
    if (existsSync(f)) {
      for (const raw of readFileSync(f, 'utf8').split(/\r?\n/)) {
        const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(raw.trim());
        if (m) {
          let v = m[2].trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
          if (v) out[m[1]] = v;
        }
      }
    }
  } catch (e) { console.error('[credentials env]', e.message); }
  return out;
}

function startIsolatedDsh(cfgIso) {
  const id = 'dsh-isolated';
  return new Promise(async (resolve) => {
    try {
      const home = cfgIso.isolatedHome;
      const dshCli = cfgIso.dshCli || findDshCli();
      const directBin = /bin\.js$/.test(dshCli) ? dshCli : '';
      const dshBin = directBin || join(dirname(dshCli), '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

      /* 幂等装配隔离 profile（仅用随包官方 dsh，不探测/不复制任何桌面端）：
         用随包 dsh 发行 node_modules 作为 profile 安装面，并把 dsh-base/dsh-web-app
         写进 profile package.json 的 bundles/dependencies；缺则自愈。否则 qq-mode-console
         （inject settings）与 3× mcp-client（inject tools）会永久 pending，隔离 DSH 起不来。 */
      async function healProfile() {
        const dstProfile = join(home, 'profiles', cfgIso.profile || 'web');
        const pkgFile = join(dstProfile, 'package.json');
        let pkg = null;
        try { pkg = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, 'utf8')) : null; } catch { pkg = null; }
        const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
        const hasBase = bundles.includes('@deepseek-ai/dsh-base') && bundles.includes('@deepseek-ai/dsh-web-app');
        const nmOk = existsSync(join(dstProfile, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'));
        if (!existsSync(dstProfile)) {
          mkdirSync(dstProfile, { recursive: true });
          writeFileSync(join(dstProfile, 'cordis.yml'), '[]\n', 'utf8');
          writeFileSync(pkgFile, JSON.stringify({ name: 'isolated-web-profile', private: true, version: '0.0.0', 'dsh': { profile: { bundles: [] } } }, null, 2), 'utf8');
          pkg = { name: 'isolated-web-profile', private: true, version: '0.0.0', 'dsh': { profile: { bundles: [] } }, dependencies: {} };
        }
        // 用随包 dsh 发行安装面补齐 profile node_modules（仅在缺失/为空时 junction，不覆盖已有安装）
        const needNM = !existsSync(join(dstProfile, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'));
        if (needNM) {
          let distNM = null;
          // ① 全局 npm 安装时，dsh-base 在 dsh 包自己的 node_modules 里（不在上层 node_modules），
          //    先探这里，否则会误报「未找到随包 dsh 发行安装面」。
          const nestedNM = join(dirname(dshBin), '..', 'node_modules');
          if (existsSync(join(nestedNM, '@deepseek-ai', 'dsh-base', 'package.json'))) distNM = nestedNM;
          // ② 再按原逻辑向上找随包发行的安装面（打包版）
          let d0 = distNM ? null : dirname(dshBin);
          for (let i = 0; i < 6 && d0; i++) {
            if (existsSync(join(d0, '@deepseek-ai', 'dsh-base', 'package.json'))) { distNM = d0; break; }
            d0 = dirname(d0);
          }
          const nmLink = join(dstProfile, 'node_modules');
          const nmExists = existsSync(nmLink);
          const nmEmpty = nmExists && (() => { try { return readdirSync(nmLink).length === 0; } catch { return false; } })();
          if (distNM && (!nmExists || nmEmpty)) {
            if (nmExists && nmEmpty) { try { spawnSync('cmd.exe', ['/c', 'rmdir', nmLink], { stdio: 'ignore', windowsHide: true, timeout: 15000 }); } catch {} }
            if (!existsSync(nmLink)) {
              const r = spawnSync('cmd.exe', ['/c', 'mklink', '/J', nmLink, distNM], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
              if (r.status !== 0) console.error('[isolated-dsh] mklink profile node_modules 失败，DSH 可能 pending');
            }
          } else if (nmExists && !nmEmpty && distNM) {
            console.log('[isolated-dsh] profile node_modules 已存在但缺 dsh-base（保留原目录，仅补齐 bundles）');
          } else {
            console.error('[isolated-dsh] 未找到随包 dsh 发行安装面，profile 基础 bundles 可能无法加载');
          }
        }
        // 补齐 dsh-base/dsh-web-app bundles + dependencies
        if (pkg && (!hasBase || !pkg.dependencies?.['@deepseek-ai/dsh-base'])) {
          const readVer = (nm, p) => { try { return JSON.parse(readFileSync(join(nm, '@deepseek-ai', p, 'package.json'), 'utf8')).version; } catch { return null; } };
          let distNM = null;
          // ① 全局 npm 安装时，dsh-base 在 dsh 包自己的 node_modules 里（不在上层 node_modules），
          //    先探这里，否则会误报「未找到随包 dsh 发行安装面」。
          const nestedNM = join(dirname(dshBin), '..', 'node_modules');
          if (existsSync(join(nestedNM, '@deepseek-ai', 'dsh-base', 'package.json'))) distNM = nestedNM;
          // ② 再按原逻辑向上找随包发行的安装面（打包版）
          let d0 = distNM ? null : dirname(dshBin);
          for (let i = 0; i < 6 && d0; i++) {
            if (existsSync(join(d0, '@deepseek-ai', 'dsh-base', 'package.json'))) { distNM = d0; break; }
            d0 = dirname(d0);
          }
          const baseVer = readVer(distNM || join(dstProfile, 'node_modules'), 'dsh-base') || '0.1.0-rc.6';
          const webVer = readVer(distNM || join(dstProfile, 'node_modules'), 'dsh-web-app') || '0.1.0-rc.6';
          pkg.dsh = pkg.dsh || {};
          pkg.dsh.profile = pkg.dsh.profile || {};
          if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];
          for (const b of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
            if (!pkg.dsh.profile.bundles.includes(b)) pkg.dsh.profile.bundles.push(b);
          }
          pkg.dependencies = pkg.dependencies || {};
          if (!pkg.dependencies['@deepseek-ai/dsh-base']) pkg.dependencies['@deepseek-ai/dsh-base'] = baseVer;
          if (!pkg.dependencies['@deepseek-ai/dsh-web-app']) pkg.dependencies['@deepseek-ai/dsh-web-app'] = webVer;
          writeFileSync(pkgFile, JSON.stringify(pkg, null, 2), 'utf8');
          console.log('[isolated-dsh] profile 基础 bundles 已补齐:', pkgFile);
        }
      }
      await healProfile();
      if (!existsSync(join(home, 'profiles', cfgIso.profile || 'web'))) {
        // 仍无 profile：桌面 DSH 不在且无随包 dsh → 建最小占位，等 setup 注入
        const dstProfile = join(home, 'profiles', cfgIso.profile || 'web');
        mkdirSync(dstProfile, { recursive: true });
        writeFileSync(join(dstProfile, 'cordis.yml'), '[]\n', 'utf8');
        writeFileSync(join(dstProfile, 'package.json'), JSON.stringify({ name: 'isolated-web-profile', private: true, version: '0.0.0', 'dsh': { profile: { bundles: [] } } }, null, 2), 'utf8');
      }
      const logFile = instanceLogPath(id);
      // 日志不再是"管理器用管道转发"，而是子进程**直写文件**（根因见 spawnWithLogFile 的注释：
      // 管理器一重启，管道断 → 子进程 EPIPE → 被自己的 stdout 打死）。
      const logStream = { write: (s) => { try { appendFileSync(logFile, s, 'utf8'); } catch { /* ignore */ } } };
      logStream.write(`\n===== start ${new Date().toISOString()} =====\n`);
      if (!existsSync(dshBin)) { resolve({ success: false, message: `找不到 dsh 可执行文件：${dshBin}` }); return; }
      // 全新机器引导标记：DSH_HOME 尚未被 qq-bridge setup 初始化过 → 先以最小 profile 起一次再注入 preset
      const bootMarker = join(home, 'qqbridge-setup.done');
      const dshArgs = [dshBin, '--profile', cfgIso.profile, '--port', String(cfgIso.port), '--no-open', '--trusted-host', `127.0.0.1:${cfgIso.port}`, '--trusted-host', `localhost:${cfgIso.port}`];
      const dshOpts = {
        env: { ...process.env, DSH_HOME: home, ...loadCredentialEnv(home) },
        cwd: dirname(dshBin) || undefined,
      };
      const child = await spawnWithLogFile(process.execPath, dshArgs, dshOpts, logFile);
      child.on('exit', () => logStream.write(`\n===== exit ${new Date().toISOString()} =====\n`));
      runtimes.set(id, { proc: child, startedAt: new Date().toISOString(), logFile });
      // 等端口起来
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (child.exitCode !== null) break;
        const ok = await probe(`http://127.0.0.1:${cfgIso.port}/`, 800);
        if (ok.reachable) {
          // 隔离 DSH 在线后: 首次 → 注入 preset 并自动重启生效; 非首次仅提示
          const firstBoot = !existsSync(bootMarker);
          if (firstBoot) {
            await ensureIsolatedDshSetup(home, cfgIso.profile, bootMarker, logStream);
            // setup 注入 agent-presets 后 DSH 需重启加载
            if (existsSync(bootMarker)) {
              try { child.kill?.(); runtimes.delete(id); } catch {}
              logStream.write(`\n===== preset 已注入, 自动重启 DSH =====\n`);
              const child2 = await spawnWithLogFile(process.execPath, dshArgs, dshOpts, logFile);
              child2.on('exit', () => logStream.write(`\n===== exit ${new Date().toISOString()} =====\n`));
              runtimes.set(id, { proc: child2, startedAt: new Date().toISOString(), logFile });
              resolve({ success: true, message: `隔离 DSH 已就绪(首次注入 preset 后重启): http://127.0.0.1:${cfgIso.port}` }); return;
            }
          }
          resolve({ success: true, message: `隔离 DSH 已启动：http://127.0.0.1:${cfgIso.port}` }); return;
        }
      }
      resolve(child.exitCode === null
        ? { success: true, message: '进程已拉起（端口探测超时，请查看日志）' }
        : { success: false, message: `进程已退出 code=${child.exitCode}，见日志` });
    } catch (e) {
      resolve({ success: false, message: e.message });
    }
  });
}

/**
 * 隔离 DSH 首次在线后自动注入 qq-bridge 的 agent-presets / MCP 配置(幂等)：
 * 跑 qq-bridge 自带 scripts/setup-dsh.mjs --home <isolatedHome> --profile web。
 * 无本地桥(纯远端模式)或已注入过 → 直接跳过。全程不阻塞启动返回。
 */
async function ensureIsolatedDshSetup(home, profile, marker, logStream) {
  try {
    const qb = findBridgeDir();
    const setup = join(qb, 'scripts', 'setup-dsh.mjs');
    if (!existsSync(setup)) { logStream?.write(`\n[iso-dsh] 无本地 qq-bridge setup 脚本, 跳过 preset 注入\n`); return false; }
    if (existsSync(marker)) return true; // 已完成过
    const line = (s) => { try { logStream?.write(`${s}\n`); } catch {} };
    line(`\n===== 首次引导: 注入 agent-presets/MCP 到隔离 DSH =====`);
    const r = spawnSync(process.execPath, [setup, '--home', home, '--profile', profile, '--force'], {
      env: { ...process.env, QQB_DSH_HOME: home },
      cwd: qb, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 300000, encoding: 'utf8',
    });
    if (r.status === 0) {
      writeFileSync(marker, new Date().toISOString(), 'utf8');
      line(`[iso-dsh] preset 注入完成(自动重启 DSH 生效)`);
      return true;
    } else {
      line(`[iso-dsh] setup 未完全成功 exit=${r.status}: ${String(r.stderr || r.stdout || '').slice(-300)}`);
      return false;
    }
  } catch (e) { return false; } // 失败不阻断
}

/* NapCat OneKey 常见安装位置（项目内为首选） */
function findNapcatOneKey() {
  return findNapcatOneKeyAll()[0] ?? null;
}

/**
 * 收集「所有」NapCat OneKey Shell 目录（不只第一个命中的）：
 * 本机可能同时存在 开发工作区版 与 已安装版(%LOCALAPPDATA%\Programs\MoonBot 等)，
 * 停止时若只按 findNapcatOneKey() 的单一目录前缀去杀，会漏掉真正在跑的另一套。
 */
function findNapcatOneKeyAll() {
  const proj = RUNTIME_ROOT;
  // 默认目录（%LOCALAPPDATA%\Programs\MoonBot）只是"其中之一"：安装目录页允许用户装到任意盘，
  // 所以再扫一遍 Programs\* 里所有带 resources\runtime\napcat-onekey 的安装（2026-09-12）。
  const programsRoot = join(homedir(), 'AppData', 'Local', 'Programs');
  const programMoon = join(programsRoot, 'MoonBot', 'resources', 'runtime');
  const siblingInstalls = (() => {
    try {
      return readdirSync(programsRoot)
        .map((d) => join(programsRoot, d, 'resources', 'runtime'))
        .filter((r) => existsSync(join(r, 'server', 'index.js')));
    } catch { return []; }
  })();
  const roots = [
    join(proj, 'napcat-onekey'),
    join(proj, 'napcat'),
    join(proj, 'runtime', 'napcat-onekey'),
    join(programMoon, 'napcat-onekey'),
    join(programMoon, 'napcat'),
    ...siblingInstalls.flatMap((r) => [join(r, 'napcat-onekey'), join(r, 'napcat')]),
    join(homedir(), 'Downloads', 'NapCat.Shell.Windows.OneKey'),
    join(homedir(), 'Desktop', 'NapCat.Shell.Windows.OneKey'),
    join(homedir(), 'Documents', 'NapCat.Shell.Windows.OneKey'),
  ];
  const shells = ['NapCat.44498.Shell', 'Shell', 'bootmain'];
  const out = [];
  const seen = new Set();
  const push = (dir, exe) => {
    const k = dir.toLowerCase();
    if (!seen.has(k) && existsSync(exe)) { seen.add(k); out.push({ dir, exe }); }
  };
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const s of shells) push(join(root, s), join(root, s, 'NapCatWinBootMain.exe'));
    push(root, join(root, 'NapCatInstaller.exe'));
  }
  return out;
}

/* NapCat 配置目录（放 webui.json / napcat_*.json） */
function findNapcatConfigDir(shellDir) {
  const candidates = [
    join(shellDir, 'versions', '9.9.26-44498', 'resources', 'app', 'napcat', 'config'),
    join(shellDir, 'config'),
    join(shellDir, 'napcat', 'config'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  // 递归找一层
  const verRoot = join(shellDir, 'versions');
  if (existsSync(verRoot)) {
    for (const v of readdirSync(verRoot)) {
      const c = join(verRoot, v, 'resources', 'app', 'napcat', 'config');
      if (existsSync(c)) return c;
    }
  }
  return null;
}

/* 出厂 OneBot 网络模板：HTTP 3000 (0.0.0.0) + WS 3001 (127.0.0.1), token=truefriend, 与桥零配置直连 */
const FACTORY_ONE_NETWORK = {
  httpServers: [{ enable: true, name: 'http', host: '0.0.0.0', port: 3000, token: 'truefriend', enableCors: true, messagePostFormat: 'array', debug: false }],
  httpSseServers: [], httpClients: [],
  websocketServers: [{ enable: true, name: 'ws', host: '127.0.0.1', port: 3001, reportSelfMessage: false, enableForcePushEvent: true, messagePostFormat: 'array', token: 'truefriend', debug: false, heartInterval: 5000 }],
  websocketClients: [], plugins: [],
};

/**
 * NapCat 登录后自动注入出厂 OneBot 配置（幂等）：
 * 轮询 config 目录直到出现 onebot11_<qq>.json（登录成功才会生成）；
 * 若其 network 无任何服务 → 写入 HTTP 3000 / WS 3001 / token=truefriend，使桥开箱即连。
 * 返回 'written' | 'found' | 'none' | 'timeout'。
 */
async function ensureNapcatOnebotConfig(shellDir, logStream = null) {
  const cfgDir = findNapcatConfigDir(shellDir);
  if (!cfgDir) return 'none';
  const line = (s) => { try { logStream?.write(`${s}\n`); } catch {} };
  // 最长等 3 分钟（QQ 扫码登录可能较慢）；每 3 秒扫一次
  for (let i = 0; i < 60; i++) {
    let file = null;
    try {
      file = readdirSync(cfgDir).find((f) => /^onebot11_\d+\.json$/.test(f));
    } catch { /* config 目录暂时不可读 */ }
    if (file) {
      const p = join(cfgDir, file);
      try {
        const raw = readFileSync(p, 'utf-8').replace(/^\uFEFF/, '');
        const c = JSON.parse(raw);
        const hasSrv = (c?.network?.httpServers?.length || 0) + (c?.network?.websocketServers?.length || 0) > 0;
        if (hasSrv) return 'found'; // 已有服务（可能已由用户或本函数配好）
        c.network = JSON.parse(JSON.stringify(FACTORY_ONE_NETWORK));
        writeFileSync(p, JSON.stringify(c, null, 2), 'utf-8');
        line(`[napcat] 自动写入 OneBot 出厂配置: ${file}`);
        return 'written';
      } catch (e) { line(`[napcat] onebot 配置注入失败: ${e?.message || e}`); return 'none'; }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  line('[napcat] 等待 QQ 登录超时(3 分钟), 未注入 OneBot 配置; 登录后可手动在 WebUI 添加或重启管理端再点启动');
  return 'timeout';
}

/* —— VBS 隐藏启动器（融合进项目）：双击或由管理器调用均无黑窗 —— */function ensureNapcatVbs(shellDir, quickLogin) {
  const q = String(quickLogin ?? '').trim();  const qr = join(shellDir, 'napcat-hidden.vbs');
  const quick = join(shellDir, 'napcat-quick-hidden.vbs');
  const qrBody = [
    "' NapCat hidden launcher (QR login) - generated by QQ-Bridge Manager",
    'Set ws = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'dir = fso.GetParentFolderName(WScript.ScriptFullName)',
    'ws.Run """" & dir & "\\NapCatWinBootMain.exe""", 0, False',
    '',
  ].join('\r\n');
  const qq = q || process.env.QBM_QUICK_QQ || '';   // 留空时调用方走二维码登录
  // VBS 引号规则: """" = 一个字面 "; 路径需带引号包起来再拼 QQ
  const quickBody = [
    "' NapCat hidden launcher (QUICK login) - generated by QQ-Bridge Manager",
    "' Edit QQ below if you want another account.",
    'Set ws = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'dir = fso.GetParentFolderName(WScript.ScriptFullName)',
    `QQ = "${qq}"`,
    'ws.Run """" & dir & "\\NapCatWinBootMain.exe""" & " " & QQ, 0, False',
    '',
  ].join('\r\n');
  try {
    // 每次都重写(内容幂等): 旧版本曾生成引号未闭合的坏 vbs, 不能依赖 existsSync 跳过
    writeFileSync(qr, qrBody, 'utf8');
    writeFileSync(quick, quickBody, 'utf8');
  } catch (e) { console.error('[napcat] write vbs:', e.message); }
  return { dir: shellDir, qr, quick, quickLogin: qq };
}

/** 经由 wscript 隐藏启动 NapCat（无任何黑窗）；返回 child(记录用) 与日志说明 */
async function startNapcatHiddenViaVbs(onekey, quickLogin) {
  const vbs = ensureNapcatVbs(onekey.dir, quickLogin);
  const target = quickLogin ? vbs.quick : vbs.qr;
  // wscript 是 GUI 宿主，windowsHide 再兜底：保证不弹黑窗
  const child = await spawnDetached('wscript.exe', [target], { cwd: onekey.dir });
  return { child, vbs, target };
}

/** 通用命令型启动器：bridge / napcat 自定义命令 */
function startCommandInstance(id, cfg, logLabel) {
  return new Promise(async (resolve) => {
    try {
      const cmd = cfg.launchCommand?.trim?.();
      if (!cmd) { resolve({ success: false, message: `未配置 ${logLabel} 启动命令：点击「配置」填写（例如 NapCat.Shell / NapCatWinBoot.exe / node server/index.js）。` }); return; }
      const logFile = instanceLogPath(id);
      // 标记行直接写文件（子进程的 stdout 也写这个文件，见 spawnWithLogFile）
      try { appendFileSync(logFile, `\n===== start ${new Date().toISOString()}: ${cmd} =====\n`, 'utf8'); } catch { /* ignore */ }
      // 【2026-09-12 可移植性】按空白裸切会把带空格的路径切断
      // （用户必然写成 "C:\Program Files\...\NapCatWinBootMain.exe" → 会被切成 `"C:\Program` + `Files\...`）。
      // 现在先按引号切，再退回按空白切；两侧引号剥掉。
      const parts = (cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((s) => s.replace(/^["']|["']$/g, ''));
      if (!parts.length) { resolve({ success: false, message: `${logLabel} 启动命令为空` }); return; }
      const prog = parts[0];
      const rest = parts.slice(1);
      const opts = { env: { ...process.env, ...(cfg.env ?? {}) }, cwd: cfg.workDir || undefined };
      // 绝不经过 cmd.exe 中转（cmd 会另开一个黑色控制台窗口）；直接起可执行文件或 node
      let child;
      if (/\.(exe)$/i.test(prog)) {
        child = await spawnWithLogFile(prog, rest, opts, logFile);
      } else if (prog.toLowerCase() === 'node' || /\.(js|mjs|cjs)$/i.test(prog)) {
        const args = prog.toLowerCase() === 'node' ? rest : [prog, ...rest];
        child = await spawnWithLogFile(process.execPath, args, opts, logFile);
      } else if (/\.(cmd|bat)$/i.test(prog) || prog.includes('npm')) {
        child = await spawnWithLogFile(prog, rest, opts, logFile);
      } else {
        // 完整路径但无扩展名等：直接按可执行文件起，失败再用 cmd 兜底（带 windowsHide）
        try { child = await spawnWithLogFile(prog, rest, opts, logFile); }
        catch { child = await spawnWithLogFile(process.execPath, [cmd], opts, logFile); }
      }
      // 子进程的 stdout 已直写日志文件；这里只负责在它退出时补一行标记
      child.on('exit', () => { try { appendFileSync(logFile, `\n===== exit ${new Date().toISOString()} =====\n`, 'utf8'); } catch { /* ignore */ } });
      runtimes.set(id, { proc: child, startedAt: new Date().toISOString(), logFile });
      resolve({ success: true, message: `${logLabel} 已拉起（WebUI 端口 ${cfg.webuiPort || 6099}）` });
    } catch (e) {
      resolve({ success: false, message: e.message });
    }
  });
}

function startNapcatLocal(cfgNap) {
  const id = 'napcat-local';
  return new Promise(async (resolve) => {
    try {
      // WebUI 登录 token：默认 truefriend，可经 InstanceConfig 配置覆盖
      const napToken = String(cfgNap.webuiToken ?? '').trim() || 'truefriend';
      // 1) 显式命令
      if (cfgNap.launchCommand?.trim?.()) {
        const out = await startCommandInstance(id, cfgNap, 'NapCat');
        resolve(out); return;
      }
      // 2) Windows：自动定位 OneKey
      const onekey = findNapcatOneKey();
      if (onekey) {
        // 清理上次残留的 NapCat/QQ 进程——只杀本 OneKey 目录内启动的进程（绝不误杀用户自己的正版 QQ）
        try {
          const owndir = onekey.dir.replace(/'/g, "''");
          spawnSync('powershell.exe', ['-NoProfile', '-Command',
            `Get-Process NapCatWinBootMain,QQ -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${owndir}*' } | Stop-Process -Force`],
            { stdio: 'ignore', windowsHide: true });
        } catch {}
        const exe = onekey.exe;
        // —— 修复1：固定 WebUI token（用配置 napToken，默认 truefriend）——
        try {
          const cfgDir = findNapcatConfigDir(onekey.dir);
          if (cfgDir) {
            const webuiPath = join(cfgDir, 'webui.json');
            if (existsSync(webuiPath)) {
              const w = JSON.parse(readFileSync(webuiPath, 'utf-8'));
              if (w.token !== napToken) { w.token = napToken; writeFileSync(webuiPath, JSON.stringify(w, null, 4), 'utf-8'); }
            }
          }
        } catch (e) { console.error('[napcat] token fix:', e.message); }
        // —— 修复2：快速登录账号（免二维码），可用账号从 napcat_*.json 探测 ——
        let quickLogin = '';
        try {
          const cfgDir = findNapcatConfigDir(onekey.dir);
          if (cfgDir) {
            const accs = [];
            for (const f of ['../versions/9.9.26-44498/resources/app/napcat/config', cfgDir, join(cfgDir, '..')]) { /* noop */ }
            for (const f of readdirSync(cfgDir)) {
              const m = /^napcat_(\d+)\.json$/.exec(f);
              if (m) accs.push(m[1]);
            }
            if (accs.length) quickLogin = accs.sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
            if (cfgNap.quickLogin) quickLogin = String(cfgNap.quickLogin);
          }
        } catch (e) { console.error('[napcat] quickLogin detect:', e.message); }
        const logFile = instanceLogPath(id);
        const logStream = createWriteStream(logFile, { flags: 'a' });
        logStream.write(`\n===== start ${new Date().toISOString()}: VBS hidden (${quickLogin ? 'quick ' + quickLogin : 'QR'}) =====\n`);
        // 融合 VBS 隐藏启动：wscript 后台运行，任何模式都不弹黑窗
        const { child, target } = await startNapcatHiddenViaVbs(onekey, quickLogin);
        logStream.write(`\nlauncher: ${target}\n`);
        child.on('exit', () => logStream.write(`\n===== exit ${new Date().toISOString()} =====\n`));
        runtimes.set(id, { proc: child, startedAt: new Date().toISOString(), logFile, cwd: onekey.dir });
        // 异步: 等 NapCat 首启生成 webui.json 后固定 token（napToken）; 并注入出厂 OneBot 网络配置
        (async () => {
          for (let i = 0; i < 60; i++) {
            try {
              const cd = findNapcatConfigDir(onekey.dir);
              if (cd) {
                const wp = join(cd, 'webui.json');
                if (existsSync(wp)) {
                  const w = JSON.parse(readFileSync(wp, 'utf-8'));
                  if (w.token !== napToken) { w.token = napToken; writeFileSync(wp, JSON.stringify(w, null, 4), 'utf-8'); }
                  break;
                }
              }
            } catch {}
            await new Promise((r) => setTimeout(r, 3000));
          }
        })();
        ensureNapcatOnebotConfig(onekey.dir, logStream).then((ok) => {
          if (ok === 'written') logStream.write(`\n===== onebot 出厂配置已自动写入 (HTTP 3000 / WS 3001, token=truefriend) =====\n`);
          else if (ok === 'found') logStream.write(`\n===== onebot 已有网络配置, 跳过注入 =====\n`);
        });
        resolve({ success: true, message: `NapCat (OneKey · VBS 隐藏启动) 已拉起${quickLogin ? ' · 快速登录 ' + quickLogin : ' · 二维码登录'}\n启动器：${target}` }); return;
      }
      // 3) 非 Windows：官方安装脚本
      if (process.platform !== 'win32') {
        const logFile = instanceLogPath(id);
        const logStream = createWriteStream(logFile, { flags: 'a' });
        logStream.write(`\n===== install ${new Date().toISOString()} =====\n`);
        const child = await spawnDetached('bash', ['-c', 'bash <(curl -s https://raw.githubusercontent.com/NapNeko/NapCatQQ/main/install.sh)'], { env: { ...process.env } });
        child.stdout?.pipe(logStream);
        child.stderr?.pipe(logStream);
        runtimes.set(id, { proc: child, startedAt: new Date().toISOString(), logFile });
        resolve({ success: true, message: 'Linux：正在执行官方安装脚本 bash <(curl …/install.sh)' }); return;
      }
      resolve({ success: false, message: '未找到 NapCat：Windows 请先解压 NapCat.Shell.Windows.OneKey 到 Downloads，或在「配置」里填启动命令；Linux 将自动执行官方安装脚本。' });
    } catch (e) {
      resolve({ success: false, message: e.message });
    }
  });
}

function startBridgeLocal(cfgBr) {
  // 内置：优先自动探测本地 qq-bridge 源码；找不到再退回用户手动命令
  const autoDir = findBridgeDir();
  const autoUsable = !!autoDir && existsSync(join(autoDir, 'src', 'bridge.js'));
  // config 里残留的 launchCommand/workDir（换机/换盘后）一律以自动探测为准，
  // 避免在错误 cwd（如安装根目录）跑 node src/bridge.js。
  const wd = autoUsable ? autoDir : (cfgBr.workDir || autoDir);
  // 官方 dsh（0.1.2+）web/API 都要 cookie：把隔离 DSH 的日志路径注入桥接 env，
  // 桥接 NodeApiClient 从日志解析最新 web token → GET /?token= 换 dsh-auth cookie 再调 /api。
  const bridgeEnv = { ...(cfgBr.env ?? {}), DSH_ISOLATED_LOG_FILE: instanceLogPath('dsh-isolated') };
  if (autoUsable) {
    return startCommandInstance('bridge-local', { ...cfgBr, env: bridgeEnv, launchCommand: 'node src/bridge.js', workDir: autoDir, webuiPort: cfgBr.webuiPort || 3100 }, 'Bridge');
  }
  if (!cfgBr.launchCommand?.trim?.()) {
    return Promise.resolve({ success: false, message: '未找到本地 qq-bridge（已自动探测 WorkSpace/qq-bridge 等目录）。请在配置页手动指定工作目录与启动命令。' });
  }
  return startCommandInstance('bridge-local', { ...cfgBr, env: bridgeEnv }, 'Bridge');
}

/** 按命令行关键字兜底结束进程（处理非本 manager spawn 的历史/游离进程）
 *
 * 【2026-09-12 修】原来只过滤 `Name='node.exe'`，而发布包用的是内置运行时 **qbm-node.exe**，
 * 于是这个"兜底清理"在真机上**永远匹配不到任何进程**：管理器重启过之后（内存里的 runtimes 表是空的），
 * 「停止/重启桥接」接口会返回成功，老桥却还活着占着 3100 端口和 state/bridge.lock，
 * 新桥启动即因单实例锁退出 —— 用户看到"重启了但没反应"。现在两种进程名都覆盖。 */
function killByCmdline(marker) {
  if (!marker) return;
  try {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='qbm-node.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore', timeout: 8000, windowsHide: true });
  } catch { /* 尽力而为 */ }
}

/** 收集当前应被本管理器管控的 NapCat 相关目录（OneKey Shell 全部候选 + 运行记录 + 配置手工目录） */
function napcatManagedDirs(rt) {
  const dirs = new Set();
  for (const onekey of findNapcatOneKeyAll()) if (onekey?.dir) dirs.add(onekey.dir);
  if (rt?.cwd) dirs.add(rt.cwd);
  try {
    const cfgNap = loadConfig()?.instances?.napcatLocal;
    if (cfgNap?.installDir) dirs.add(String(cfgNap.installDir));
  } catch {}
  return [...dirs].filter(Boolean);
}

/** 统计仍在指定目录前缀下运行的 NapCatWinBootMain / QQ 进程数（0 = 已停干净） */
function countNapcatProcs(dirs) {
  if (!dirs.length) return 0;
  const where = dirs.map((p) => `$p -like '${String(p).replace(/'/g, "''")}*'`).join(' -or ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `$n = 0; Get-Process NapCatWinBootMain,QQ -ErrorAction SilentlyContinue | ForEach-Object { $p = $_.Path; if (${where}) { $n++ } }; Write-Output $n`],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15000, encoding: 'utf8' });
  return parseInt(String(r.stdout || '0').trim(), 10) || 0;
}

async function stopInstance(id) {
  const rt = runtimes.get(id);
  // NapCat 由 wscript(隐藏) 启动，子进程脱离 wscript PID —— 需按进程路径整树清理
  if (id === 'napcat-local') {
    const dirs = napcatManagedDirs(rt);
    try {
      // 逐个候选目录前缀清理 NapCatWinBootMain / QQ（绝不误杀 Program Files 下的正版 QQ）
      const where = dirs.map((p) => `$_.Path -like '${String(p).replace(/'/g, "''")}*'`).join(' -or ');
      if (where) {
        spawnSync('powershell.exe', ['-NoProfile', '-Command',
          `Get-Process NapCatWinBootMain,QQ -ErrorAction SilentlyContinue | Where-Object { ${where} } | Stop-Process -Force`],
          { stdio: 'ignore', windowsHide: true });
      }
    } catch {}
    if (rt) runtimes.delete(id);
    // 二次校验：仍在这些目录下跑的 NapCat/QQ → 说明未停干净，如实告知
    await new Promise((r) => setTimeout(r, 800));
    const n = countNapcatProcs(dirs);
    return { success: n === 0, message: n === 0 ? 'NapCat 已停止' : `NapCat 仍有 ${n} 个进程未退出（可能被占用或需要手动结束）` };
  }
  let killedByPid = false;
  if (rt) {
    try {
      if (process.platform === 'win32' && rt.proc?.pid) {
        spawnSync('taskkill.exe', ['/pid', String(rt.proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killedByPid = true;
      } else {
        rt.proc?.kill?.('SIGTERM');
        killedByPid = true;
      }
    } catch {}
    runtimes.delete(id);
  }
  // 兜底：若实例仍由游离进程占着（如 manager 重启后曾直启、或旧版本启动的），按命令行关键字清理
  if (id === 'bridge-local') killByCmdline('bridge.js');
  if (id === 'dsh-isolated') {
    const port = Number(loadConfig()?.instances?.dshIsolated?.port) || 10721;
    killByCmdline(`--port ${port}`);
  }
  // 校验真的停了：端口还在监听就是没停干净（以前无条件返回 success:true，配合上面那条 node.exe/qbm-node.exe
  // 的过滤缺陷，就出现了"点了重启、提示成功、其实老进程还在"）。如实返回，调用方（重启）才能不乱启动。
  if (await probePort(instancePort(id, loadConfig()))) {
    return { success: false, message: '停止失败：端口仍被占用（该进程可能不是本管理器启动的，稍后重试或手动结束）' };
  }
  return { success: true, message: killedByPid || rt ? '已停止' : '已尝试停止（按命令行清理游离进程）' };
}

function instanceRuntime(id, cfg) {
  const rt = runtimes.get(id);
  const info = buildRuntimeInfo(id, cfg);
  const kindName = id === 'dsh-isolated'
    ? { name: 'dsh', label: 'DeepSeek Harness（隔离）' }
    : id === 'napcat-local'
      ? { name: 'napcat', label: 'NapCat' }
      : { name: 'bridge', label: 'Bridge' };
  const ph = phaseInfo(id);
  return {
    id,
    name: kindName.label,
    kind: kindName.name,
    config: cfg,
    proc: { running: info.running, pid: info.pid, startedAt: info.startedAt, logFile: info.logFile },
    reachable: false,
    url: info.url,
    port: id === 'dsh-isolated' ? cfg.port : cfg.webuiPort || 6099,
    // 前端按钮状态机的唯一事实来源（见文件上方「实例状态机」一节）
    phase: ph.phase,
    phaseAt: ph.at || 0,
    readyAt: ph.readyAt || 0,
    elapsedMs: ph.elapsedMs || 0,
    error: ph.error || '',
    note: ph.note || '',
    loggedIn: ph.loggedIn === true,
    adopted: ph.adopted === true,
  };
}

/* ------------------------------------------------------------------ */
/* 实例状态机（修「启动中」卡住/闪一下就没/假成功）                       */
/* ------------------------------------------------------------------ */
/* 以前的按钮状态只活在那一次 HTTP 请求里：点「启动」→ busy=true → 请求几十毫秒返回 → busy=false，
 * 于是「启动中」只是闪一下；紧接着 /api/state 又因为"进程已 spawn"把状态报成运行中，
 * 可 DSH 要十几秒才监听、NapCat 还要扫码 —— 用户点「打开」得到白屏/401，只会以为坏了。
 * 反过来的情形更糟：进程起来几秒后自己退了（端口冲突/单实例锁/缺依赖），界面只把按钮退回「启动」，
 * 一句原因都没有。
 *
 * 现在把状态机放到服务端，判据**全部来自真实探活**（端口/HTTP），不靠"我们 spawn 过"这种推断：
 *   idle ──start──▶ starting ──就绪──▶ running ──stop──▶ stopping ──▶ idle
 *                        └──进程退出/超时──▶ failed（带日志里挑出来的原因）
 * /api/state 每次都带上 phase/elapsedMs/note/error，前端照着渲染即可（3 秒轮询，启动中时 1.2 秒）。
 */
const instancePhases = new Map(); // id -> { phase, at, readyAt, error, note, loggedIn, adopted, deadline }

/** 各实例"从拉起进程到可以对外服务"的正常耗时上限（超了才判失败，避免误报）。 */
function startupBudgetMs(id) {
  if (id === 'dsh-isolated') return 90000;
  if (id === 'napcat-local') return 120000;   // 首次可能要扫码；进程就绪本身很快
  return 45000;                                // 桥：连不上 DSH/NapCat 时它会自己重试，给足时间
}

function phaseInfo(id) {
  const p = instancePhases.get(id);
  if (!p) return { phase: 'idle', at: 0, readyAt: 0, error: '', note: '' };
  return { ...p, elapsedMs: p.at ? Date.now() - p.at : 0 };
}

function setPhase(id, phase, patch = {}) {
  const prev = instancePhases.get(id) || {};
  const next = { ...prev, ...patch, phase, at: Date.now() };
  if (phase === 'running') next.readyAt = Date.now();
  if (phase !== 'failed') next.error = '';
  instancePhases.set(id, next);
  if (prev.phase !== phase) {
    mlog(`[phase] ${id}: ${prev.phase || '(none)'} -> ${phase}` +
      `${next.note ? ' · ' + next.note : ''}${next.error ? ' · ' + next.error : ''}`);
  }
}

/** 读实例日志尾部 N 行（GBK 兜底，与 /api/instance/:id/logs 同一套解码）。 */
function tailInstanceLog(id, n = 120) {
  const file = instanceLogPath(id);
  if (!existsSync(file)) return [];
  try {
    const st = statSync(file);
    const readBytes = Math.min(st.size, Math.max(8192, n * 400));
    const buf = Buffer.alloc(readBytes);
    const fd = openSync(file, 'r');
    readSync(fd, buf, 0, readBytes, st.size - readBytes);
    closeSync(fd);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch { try { text = new TextDecoder('gbk').decode(buf); } catch { text = buf.toString('utf8'); } }
    return text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-n);
  } catch { return []; }
}

const FAIL_PAT = /(error|failed|failure|refused|EADDRINUSE|EPERM|ENOENT|cannot|not found|already in use|taken|exception|fatal|失败|错误|异常|占用|已有实例|未找到|未安装|拒绝|超时|timeout|not logged|未登录|登录失效|disconnected)/i;
/** 从日志尾部挑出最像"为什么起不来"的那两行。 */
function readFailureReason(id) {
  const lines = tailInstanceLog(id, 150);
  if (!lines.length) return '进程已退出，且没有日志可读';
  const bad = lines.filter((l) => FAIL_PAT.test(l) && !/^\[phase\]/.test(l));
  const picked = (bad.length ? bad : lines).slice(-2);
  return picked.join(' | ').slice(0, 400);
}

/** 真实就绪判据：不是"我们 spawn 过"，而是"端口/HTTP 真的在应答"。 */
async function instanceReadiness(id, cfg) {
  if (id === 'dsh-isolated') {
    const port = instancePort(id, cfg);
    const up = await probe(`http://127.0.0.1:${port}/`, 900);   // 401/200 都算活着
    const tok = readLatestDshToken(instanceLogPath(id));
    return { ready: up.reachable, note: up.reachable ? (tok ? '' : '已监听，等待就绪') : '等待 DSH 监听端口', loggedIn: true };
  }
  if (id === 'napcat-local') {
    const webui = await probePort(instancePort(id, cfg));
    const onebot = (await probePort(3000)) || (await probePort(3001));
    return {
      ready: webui,
      loggedIn: !!onebot,
      note: !webui ? '等待 NapCat WebUI' : (onebot ? '' : 'WebUI 已起，等待 QQ 扫码登录'),
    };
  }
  const up = await probe(`http://127.0.0.1:${instancePort(id, cfg)}/`, 900);
  return { ready: up.reachable, note: up.reachable ? '' : '等待桥接监听端口', loggedIn: true };
}

/** 轮询推进 starting → running/failed，直到就绪、进程死亡或超时。 */
async function waitInstanceReady(id, cfg, budgetMs = startupBudgetMs(id)) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, 900));
    const cur = instancePhases.get(id);
    if (!cur || cur.phase !== 'starting') return phaseInfo(id);   // 被 stop/restart 打断，交给它自己收敛
    const r = await instanceReadiness(id, cfg);
    if (r.ready) {
      setPhase(id, 'running', { note: r.note || '', loggedIn: r.loggedIn !== false });
      return phaseInfo(id);
    }
    const rt = runtimes.get(id);
    // 进程是不是真的没了 —— NapCat 不能看这里：它是 VBS 隐藏启动的，被跟踪的那个子进程
    // （wscript 启动器）本来就秒退，看 exitCode 会把正常的 NapCat 判成失败。
    // 它按"托管目录下还有没有 NapCat/QQ 进程"判断（与 stopInstance 同一套判据）。
    let died;
    if (id === 'napcat-local') {
      const dirs = napcatManagedDirs(rt);
      died = countNapcatProcs(dirs) === 0;
    } else {
      died = !rt || !rt.proc || rt.proc.exitCode !== null;
    }
    if (died) {
      // 进程已经没了 → 直接把日志里的原因告诉用户（这是以前最缺的一句话）
      const err = readFailureReason(id);
      setPhase(id, 'failed', { error: err || '进程已退出（未捕获到原因，见日志）' });
      return phaseInfo(id);
    }
    if (Date.now() >= deadline) {
      const err = readFailureReason(id);
      setPhase(id, 'failed', { error: `等待就绪超时（${Math.round(budgetMs / 1000)}s）${err ? '：' + err : ''}` });
      return phaseInfo(id);
    }
  }
}

/**
 * 启动一个实例并推进状态机。`wait` 为 true 时在本次请求内**等到就绪或失败**（一键启动用），
 * 否则立刻返回 starting，由后台轮询推进（单卡点「启动」用，按钮能立刻变成「启动中」）。
 */
async function startInstanceTracked(id, cfg, { wait = false } = {}) {
  const pre = await instanceReadiness(id, cfg);
  if (pre.ready) {
    const prev = instancePhases.get(id) || {};
    setPhase(id, 'running', { note: pre.note || '', loggedIn: pre.loggedIn !== false, adopted: prev.adopted === true || !runtimes.has(id) });
    return { success: true, phase: 'running', message: '已在运行', note: pre.note || '' };
  }
  if (runtimes.has(id) && runtimes.get(id).proc && runtimes.get(id).proc.exitCode === null) {
    // 进程在但还没就绪（例如刚点过一次启动）→ 只把状态机推到 starting，不要重复拉起
    setPhase(id, 'starting', { note: '进程已拉起，等待就绪' });
    return await (wait ? waitInstanceReady(id, cfg) : Promise.resolve({ success: true, phase: 'starting', message: '启动中（等待就绪）' }));
  }
  const out = await startDispatcher(id, cfg);
  const k = keyOf(id);
  if (out.success && k) { cfg.instances[k].enabled = true; saveConfig(cfg); }
  if (!out.success) { setPhase(id, 'failed', { error: out.message || '启动命令未成功执行' }); return { ...out, phase: 'failed' }; }
  setPhase(id, 'starting', { note: '进程已拉起，等待就绪', adopted: false, loggedIn: false });
  if (!wait) {
    void waitInstanceReady(id, cfg).catch((e) => mlog(`[phase] ${id} 就绪轮询异常: ${e.message}`));
    return { success: true, phase: 'starting', message: out.message };
  }
  const st = await waitInstanceReady(id, cfg);
  return { success: st.phase === 'running', phase: st.phase, message: st.phase === 'running' ? (out.message + ' · 已就绪') : (st.error || '启动未完成'), note: st.note || '' };
}


/* ------------------------------------------------------------------ */
/* 服务清单解析（本机实例优先）                                          */
/* ------------------------------------------------------------------ */
async function resolveServices(cfg, connected) {
  const local = cfg.local ?? DEFAULT_LOCAL;
  const sshMode = !!(connected && sshConnections.has(connected.id));
  // 探测本机实例是否在跑（决定「打开官方界面」直连谁）
  const dshIso = cfg.instances?.dshIsolated ?? DEFAULT_CONFIG.instances.dshIsolated;
  const napLocal = cfg.instances?.napcatLocal ?? DEFAULT_CONFIG.instances.napcatLocal;
  const brLocal = cfg.instances?.bridgeLocal ?? DEFAULT_CONFIG.instances.bridgeLocal;
  const dshIsoUp = await probe(`http://127.0.0.1:${dshIso.port}/`, 700);
  const napUp = await probe(`http://127.0.0.1:${napLocal.webuiPort || 6099}/`, 700);
  const brUp = await probe(`http://127.0.0.1:${brLocal.webuiPort || 3100}/`, 700);

  /* 【2026-09-14 修串台】本机那一组**不再回退到隧道**：本地实例没跑时，原来的写法会把
   * `127.0.0.1:13000/13080/13100`（那是服务器端口的隧道）当成"本机入口"填进去 ——
   * 于是「本机 · NapCat 官方界面」点开看到的是**服务器**的 NapCat（实测 reachable=false→串到隧道）。
   * 现在本机就是本机端口（没跑就如实显示不可达），服务端那组单独给（见下方 remoteServices）。 */
  const localDshUrl = `http://127.0.0.1:${dshIso.port}`;
  // NapCat 本机入口同样**带 webui token**（主人要求：点开就用，不用再输 token）
  const localNapPort = napLocal.webuiPort || 6099;
  const localNapTok = String(napLocal.webuiToken ?? '').trim();
  const localNapUrl = `http://127.0.0.1:${localNapPort}/webui/${localNapTok ? '?token=' + encodeURIComponent(localNapTok) : ''}`;
  const localBrUrl = `http://127.0.0.1:${brLocal.webuiPort || 3100}`;

  // 本机那一组：名字统一带「本机 · 」前缀，和服务端那组一眼分得清（主人 2026-09-14 要求）。
  const localServices = [
    { id: 'napcat-webui', scope: 'local', name: '本机 · NapCat 官方界面', url: localNapUrl, desc: '账号/连接/消息管理 WebUI（本机实例 ' + (napLocal.webuiPort || 6099) + '）' },
    { id: 'napcat-http', scope: 'local', name: '本机 · NapCat HTTP API', url: `http://127.0.0.1:${local.napcatHttp}`, desc: '本机 OneBot HTTP ' + local.napcatHttp },
    { id: 'dsh-web', scope: 'local', name: '本机 · DeepSeek Harness', url: localDshUrl, desc: '本机 DSH Web GUI（隔离实例端口 ' + dshIso.port + '）' },
    { id: 'bridge', scope: 'local', name: '本机 · Bridge 控制台', url: localBrUrl, desc: '本机桥接层控制台 ' + (brLocal.webuiPort || 3100) },
  ];
  const mk = (s, p) => ({
    ...s,
    reachable: p.reachable,
    status: p.status,
    iframeBlocked: !!p.iframeBlocked,
    iframeBlockReason: p.iframeBlocked ? (p.xfo ? `X-Frame-Options: ${p.xfo}` : `CSP ${p.frameAncestors}`) : '',
  });
  const services = [];
  for (const s of localServices) services.push(mk(s, await probe(s.url)));

  /* ── 服务端一组（只在 SSH 已连接时出现）──────────────────────────────
   * 以前这里只有一组 url，且带「本机实例在跑就优先用本机」的规则：连上服务器后点「打开官方界面」
   * 看到的还是本机那套（主人实测遇到的问题）。现在本机/服务端**并列成两组**，各自独立，
   * 服务端的 DSH 地址由后端拼好 `?token=`（DSH 无令牌一律 401）、NapCat 拼好 webui token，
   * 前端点开即用，不再靠前端猜。 */
  let remoteStatus = null;
  if (sshMode && connected) {
    const conn = sshConnections.get(connected.id);
    remoteStatus = await getRemoteServerStatus(connected, conn);          // 复用这条连接（内部 10 秒缓存）
    const u = remoteServiceUrls(connected, remoteStatus);
    const remoteServices = [
      { id: 'srv-dsh-web', scope: 'remote', name: '服务端 DSH 界面', url: u.dsh, desc: '服务器 systemd dsh-web · 隧道 ' + u.ports.dsh + ' · 已带访问令牌' + (remoteStatus?.dsh?.token ? '' : '（未取到令牌，令牌见服务端日志）') },
      { id: 'srv-napcat-webui', scope: 'remote', name: '服务端 NapCat 界面', url: u.napcat, desc: '服务器 NapCat WebUI · 隧道 ' + u.ports.napcat + ' · 已带 webui token' + (remoteStatus?.napcat?.webuiToken ? '' : '（未取到 token）') },
      { id: 'srv-napcat-http', scope: 'remote', name: '服务端 NapCat HTTP API', url: u.napcatHttp, desc: '服务器 OneBot HTTP · 隧道 ' + u.ports.napcatHttp },
      { id: 'srv-bridge', scope: 'remote', name: '服务端桥控制台', url: u.bridge, desc: '服务器 qq-bridge 控制台 · 隧道 ' + u.ports.bridge + (u.bridgeToken ? ' · 已带 console token' : '') },
    ];
    for (const s of remoteServices) services.push(mk(s, await probe(s.url, 1500)));
  }

  return {
    mode: sshMode ? 'ssh' : 'local',
    server: sshMode ? { id: connected.id, name: connected.name, host: connected.host } : null,
    services,
    remoteStatus,
    dshIsoUp: dshIsoUp.reachable,
    napLocalUp: napUp.reachable,
    bridgeLocalUp: brUp.reachable,
  };
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */
app.get('/api/napcat/launchers', (_req, res) => {
  const cfg = loadConfig();
  const onekey = findNapcatOneKey();
  if (!onekey) return res.json({ success: false, found: false, message: '未定位到 NapCat OneKey 目录' });
  const vbs = ensureNapcatVbs(onekey.dir, cfg.instances?.napcatLocal?.quickLogin || '');
  res.json({ success: true, found: true, dir: onekey.dir, exe: onekey.exe, qr: vbs.qr, quick: vbs.quick, quickLogin: vbs.quickLogin });
});

app.get('/api/config', (_req, res) => {
  const cfg = loadConfig();
  const connected = cfg.activeServerId ? cfg.servers.find((s) => s.id === cfg.activeServerId) || null : null;
  res.json({ ...cfg, connected: !!(connected && sshConnections.has(cfg.activeServerId)), activeServer: connected });
});

app.post('/api/config', (req, res) => {
  const cfg = loadConfig();
  const next = req.body ?? {};
  if (Array.isArray(next.servers)) cfg.servers = next.servers;
  if (typeof next.activeServerId === 'string' || next.activeServerId === null) cfg.activeServerId = next.activeServerId;
  if (next.local && typeof next.local === 'object') cfg.local = { ...cfg.local, ...next.local };
  if (next.instances?.dshIsolated && typeof next.instances.dshIsolated === 'object') cfg.instances.dshIsolated = { ...cfg.instances.dshIsolated, ...next.instances.dshIsolated };
  if (next.instances?.napcatLocal && typeof next.instances.napcatLocal === 'object') cfg.instances.napcatLocal = { ...cfg.instances.napcatLocal, ...next.instances.napcatLocal };
  if (next.instances?.bridgeLocal && typeof next.instances.bridgeLocal === 'object') cfg.instances.bridgeLocal = { ...cfg.instances.bridgeLocal, ...next.instances.bridgeLocal };
  saveConfig(cfg);
  res.json({ success: true, config: cfg });
});

// 实时状态：模式 + 服务可达性 + 本机实例
app.get('/api/state', async (req, res) => {
  const cfg = loadConfig();
  const connected = cfg.activeServerId ? cfg.servers.find((s) => s.id === cfg.activeServerId) || null : null;
  const r = await resolveServices(cfg, connected);
  // 【2026-09-15】取状态时顺手做隧道自愈：缺了就补建（幂等、不阻塞主流程）。
  if (connected && sshConnections.has(connected.id)) void ensureTunnels(connected.id).catch(() => {});
  const tunnelsInfo = [];
  if (connected) for (const [key, tun] of tunnels.entries()) if (key.startsWith(connected.id + ':')) tunnelsInfo.push({ name: tun.name, localPort: tun.local, remotePort: tun.remote });
  const dshIso = cfg.instances.dshIsolated;
  const napLocal = cfg.instances.napcatLocal;
  const brLocal = cfg.instances.bridgeLocal;
  const dshRt = instanceRuntime('dsh-isolated', dshIso);
  const napRt = instanceRuntime('napcat-local', napLocal);
  const brRt = instanceRuntime('bridge-local', brLocal);
  dshRt.reachable = r.dshIsoUp;
  napRt.reachable = r.napLocalUp;
  brRt.reachable = r.bridgeLocalUp;
  // 认回"不是本进程启动、但确实还在监听"的实例：管理器重启后 runtimes 为空，若只报内存状态，
  // GUI 会把还在跑的 NapCat/DSH/桥接显示成"已停止"，用户一点「启动」就可能拉出第二个 NapCat 挤掉登录态。
  for (const i of [dshRt, napRt, brRt]) {
    if (!i.running && i.reachable) { i.running = true; i.adopted = true; }
    // NapCat 的"真正可用"还要看 OneBot 端口（3000/3001）：只有 WebUI 起来 = 进程在、但可能还没扫码登录。
    // 每次都实测一下，避免管理器重启后把"已登录"误报成"等待扫码"（或反过来）。
    let loggedIn = phaseInfo(i.id).loggedIn === true;
    if (i.id === 'napcat-local') {
      loggedIn = (await probePort(3000)) || (await probePort(3001));
      if (i.reachable) instancePhases.set(i.id, { ...(instancePhases.get(i.id) || {}), loggedIn });
    }
    // 就绪的实例同步给状态机：这样"管理器重启过"不会让按钮停在 idle/starting 上（状态机唯一事实来源）。
    if (i.reachable) {
      const ph = phaseInfo(i.id);
      if (ph.phase !== 'running') setPhase(i.id, 'running', { adopted: true, note: ph.phase === 'starting' ? '' : (ph.note || ''), loggedIn });
    } else if (phaseInfo(i.id).phase === 'running' && !i.running) {
      // 进程没了、端口也没了：状态机要跟着回到 idle，否则按钮永远停在"运行中"
      setPhase(i.id, 'idle', {});
    }
    i.phase = phaseInfo(i.id).phase;
    i.elapsedMs = phaseInfo(i.id).elapsedMs;
    i.note = phaseInfo(i.id).note || '';
    i.error = phaseInfo(i.id).error || '';
    i.loggedIn = loggedIn;
  }
  // 回环地址对齐到「浏览器当前用的主机名」，保证内嵌 iframe 与父页面同站（见 alignHost 注释）
  const host = req.hostname || '127.0.0.1';
  const instances = [dshRt, napRt, brRt].map((i) => ({ ...i, url: alignHost(i.url, host) }));
  const services = (r.services || []).map((s) => ({ ...s, url: alignHost(s.url, host) }));
  res.json({
    mode: r.mode, activeServer: r.server, services, tunnels: tunnelsInfo,
    connected: !!connected && sshConnections.has(connected.id),
    /* 【2026-09-15】断线自动重连的现场状态：界面可以显示"服务端重连中…"，
     * 而不是在自动重连的几秒里显示成"服务端未运行"（主人会以为又断了）。 */
    reconnecting: reconnectState.serverId ? {
      serverId: reconnectState.serverId,
      attempt: reconnectState.attempt,
      inSeconds: Math.max(0, Math.round((reconnectState.nextAt - Date.now()) / 1000)),
      reason: reconnectState.reason,
    } : null,
    // 【新】服务端现场状态（只在 SSH 已连接时有值）：systemd dsh-web / docker napcat / 桥进程，
    // 与本机那三个实例**分开两处**展示，绝不混在一张卡上（主人 2026-09-14 要求）。
    remoteStatus: r.remoteStatus ?? null,
    instances,
    // 【2026-09-12 可移植性】安装位置体检：所有运行数据（记忆库 memory.db / 社交状态 / 人设）都写在
    // 安装树里，所以装在 Program Files（用户级进程写不进去）或 OneDrive 等同步盘（SQLite 会被反复同步、
    // 有损坏风险）时，必须提前告诉用户 —— 这正是"拿给别人装"最容易踩的两个坑。
    warnings: installLocationWarnings(),
  });
});

/** 安装位置体检：返回需要提醒用户的点（没有风险就返回空数组） */
function installLocationWarnings() {
  const out = [];
  try {
    const root = RUNTIME_ROOT.toLowerCase();
    if (/[\\/]program files( \(x86\))?[\\/]/.test(root)) {
      out.push('当前安装在 Program Files 下：这套程序是"按用户"安装的，没有管理员权限时记忆库/人设可能写不进去。建议改装到 D:\\MoonBot 这类普通目录。');
    }
    if (/[\\/](onedrive|dropbox|google drive|坚果云|微云)[\\/]/.test(root) || /同步盘|同步空间/.test(RUNTIME_ROOT)) {
      out.push('当前安装目录看起来在同步盘里：聊天记忆库（SQLite）会被持续同步，可能损坏或写入冲突。建议改装到本地非同步目录。');
    }
  } catch { /* 探测失败就当没有风险 */ }
  return out;
}

app.get('/api/open', async (req, res) => {
  const target = req.query.target || req.query.service;
  const cfg = loadConfig();
  const connected = cfg.activeServerId ? cfg.servers.find((s) => s.id === cfg.activeServerId) || null : null;
  const r = await resolveServices(cfg, connected);
  // 先精确匹配 id：现在本机/服务端各有一套 id（bridge / srv-bridge），fuzzy includes 会把
  // "bridge" 也匹配到 "srv-bridge" 上，打开的就成了服务端那套（正是本次要修的串台问题）。
  // 显式给了 scope 就**严格按 scope 找**，找不到宁可 404，绝不跨到另一套去。
  const scope = req.query.scope;                                   // 可选：local | remote
  const pool = scope ? r.services.filter((s) => s.scope === scope) : r.services;
  const svc = pool.find((s) => s.id === target)
    || pool.find((s) => s.id.includes(target || ''))
    || (!scope ? r.services.find((s) => s.id.includes(target || '')) : null);
  if (!svc) return res.status(404).json({ success: false, message: `未知服务: ${target}${scope ? '（scope=' + scope + '）' : ''}` });
  res.json({ success: svc.reachable, url: svc.url, reachable: svc.reachable, mode: r.mode, name: svc.name, scope: svc.scope ?? 'local', iframeBlocked: !!svc.iframeBlocked, iframeBlockReason: svc.iframeBlockReason || '' });
});

// 本机实例：启动 / 停止 / 重启
const startDispatcher = async (id, cfg) => {
  if (id === 'dsh-isolated') return startIsolatedDsh(cfg.instances.dshIsolated);
  if (id === 'napcat-local') return startNapcatLocal(cfg.instances.napcatLocal);
  if (id === 'bridge-local') return startBridgeLocal(cfg.instances.bridgeLocal);
  return { success: false, message: `未知实例: ${id}` };
};
const keyOf = (id) => (id === 'dsh-isolated' ? 'dshIsolated' : id === 'napcat-local' ? 'napcatLocal' : id === 'bridge-local' ? 'bridgeLocal' : null);

app.post('/api/instance/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  const cfg = loadConfig();
  if (action === 'start') {
    // 一律走状态机：立刻回 starting（按钮马上变「启动中」），后台轮询推到 running/failed，
    // 前端靠 /api/state 拿到 phase/elapsedMs/note/error，不再有"闪一下就没"和"假成功"。
    const out = await startInstanceTracked(id, cfg, { wait: false });
    res.json(out);
    return;
  }
  if (action === 'stop') {
    setPhase(id, 'stopping', { note: '正在停止…' });
    const out = await stopInstance(id);
    setPhase(id, out.success ? 'idle' : 'failed', out.success ? {} : { error: out.message });
    res.json(out);
    return;
  }
  if (action === 'restart') {
    setPhase(id, 'stopping', { note: '正在重启：先停…' });
    const stopped = await stopInstance(id);
    setPhase(id, stopped.success ? 'idle' : 'failed', stopped.success ? {} : { error: stopped.message });
    // 没停干净就别启动：新进程要么被单实例锁挡住、要么端口冲突自退，启动接口却会回"已拉起"（假成功）。
    if (!stopped.success) { res.json({ success: false, message: '重启失败：' + stopped.message }); return; }
    const out = await startInstanceTracked(id, loadConfig(), { wait: false });
    res.json(out);
    return;
  }
  res.status(404).json({ success: false, message: `未知动作: ${action}` });
});

/* 一键启动整套：按依赖顺序 NapCat(QQ 网关) → DSH(隔离大脑) → 桥，**每一步等到真正就绪**再走下一步。
 * 以前的实现是把三个进程一口气 spawn 出去就宣告成功：DSH 还在启动、桥就已经去连它，
 * NapCat 还没扫码、桥的 WS 就是连不上 —— 界面全绿、实际不工作。现在逐步等就绪，
 * 并把每步的耗时与"还差什么"（如 NapCat 待扫码）如实带回。 */
app.post('/api/instance/start-all', async (_req, res) => {
  const cfg = loadConfig();
  const order = ['napcat-local', 'dsh-isolated', 'bridge-local'];
  const steps = [];
  for (const id of order) {
    const t0 = Date.now();
    const out = await startInstanceTracked(id, cfg, { wait: true });
    const ph = phaseInfo(id);
    const step = {
      id,
      success: out.success !== false && ph.phase === 'running',
      phase: ph.phase,
      elapsedMs: Date.now() - t0,
      message: out.message + (out.note ? `（${out.note}）` : ''),
      note: out.note || ph.note || '',
      error: ph.error || '',
    };
    steps.push(step);
    // NapCat 未登录不算失败：它需要人工扫码，剩下的两步照常拉起来（以前这里直接中断，
    // 用户看到"整套启动未完成"却不知道其实只差扫个码）。
    const napcatNeedsLogin = id === 'napcat-local' && step.success && !ph.loggedIn;
    if (!step.success) {
      res.json({ success: false, message: `「${id}」启动未完成：${step.error || step.message}`, steps });
      return;
    }
    if (napcatNeedsLogin) mlog('[start-all] NapCat 已起但尚未登录，继续拉起 DSH/桥（桥会自动重连）');
  }
  const allRunning = steps.every((s) => s.success);
  const nap = steps.find((s) => s.id === 'napcat-local');
  res.json({
    success: allRunning,
    message: allRunning
      ? (nap && !nap.note ? '整套已就绪' : '整套已拉起；NapCat 等待 QQ 扫码登录（登录后桥会自动连上）')
      : '整套启动未完成',
    steps,
  });
});

// 日志读取（尾部 N 行）；NapCat 输出为 GBK，需转码避免乱码
app.get('/api/instance/:id/logs', (req, res) => {
  const { id } = req.params;
  const n = Math.min(parseInt(req.query.tail || '200', 10) || 200, 2000);
  const logFile = instanceLogPath(id);
  if (!existsSync(logFile)) return res.json({ lines: [] });
  try {
    const size = statSync(logFile).size;
    const want = Math.min(size, 256 * 1024);
    const fd = openSync(logFile, 'r');
    const buf = Buffer.alloc(want);
    readSync(fd, buf, 0, want, Math.max(0, size - want));
    closeSync(fd);
    // 按行解码：NapCat/QQ 控制台可能是 GBK，也可能是 UTF-8（且新老日志可能混写）。
    // 0x0A 不会出现在 UTF-8/GBK 多字节字符内部，因此按行分别解码是安全的。
    const rawLines = [];
    let start = 0;
    for (let i = 0; i <= buf.length; i++) {
      if (i === buf.length || buf[i] === 0x0a) {
        rawLines.push(buf.subarray(start, i));
        start = i + 1;
      }
    }
    if (size > want && rawLines.length > 0) rawLines.shift(); // 丢弃被截断的半行
    const lines = [];
    const utf8Dec = new TextDecoder('utf-8', { fatal: true });
    const gbkDec = new TextDecoder('gbk');
    for (const seg of rawLines) {
      const s = seg.length > 0 && seg[seg.length - 1] === 0x0d ? seg.subarray(0, seg.length - 1) : seg;
      let text = null;
      try { text = utf8Dec.decode(s); } catch { /* not utf-8 */ }
      if (text === null) { try { text = gbkDec.decode(s); } catch { text = s.toString('utf8'); } }
      const t = String(text ?? '').trim();
      if (t) lines.push(t);
    }
    res.json({ lines: lines.slice(-n) });
  } catch (e) {
    res.json({ lines: [], error: e.message });
  }
});

// SSH
// ── 反"把自己测封"的闸门 ────────────────────────────────────────────────────
// 背景：服务器上的 fail2ban 只认"认证失败次数"，反复试会让本机 IP 被整机 DROP，
// 之后连 TCP 都超时（正确凭据也连不上，表现为"明明昨天还好"）。2026-09-12 实测踩到两次。
//
// 【2026-09-14 主人反馈「冷却时间是写死的，等太久了」】旧实现：10 分钟内失败 3 次 → **固定冷却 10 分钟**，
// 且把原因一口咬定成 fail2ban。但"失败"至少有四种：凭据错、端口填错、机器没开、真被封 —— 处置完全不同，
// 而 10 分钟里就算把密码改对了也一样连不上。现在改成：
//   · 观察窗 5 分钟（原来 10 分钟）；
//   · **按失败性质分开算**：凭据类只停 10 秒（改完就能立刻再试）；连不上/超时类才真冷却，
//     且是秒级递增 20s → 40s → 60s（封顶 60s，绝不出现"等十分钟"）；
//   · 冷却提示如实带上"上一次到底报什么错"，不再一律说成 fail2ban；
//   · 两条接口都支持 `?force=1` 强行重试（界面上有"仍然重试一次"按钮）。
const sshFailLog = new Map(); // serverKey -> [{ ts, kind, error }]
const SSH_FAIL_WINDOW_MS = 5 * 60 * 1000;
const SSH_FAIL_MAX = 3;
const SSH_COOLDOWN_SECONDS = [20, 40, 60];      // 第 3/4/5 次连不上之后的冷却（秒），之后维持 60s
const SSH_AUTH_COOLDOWN_MS = 10 * 1000;         // 凭据类失败：只停 10 秒
function sshKeyOf(server) { return `${server.username}@${server.host}:${server.port || 22}`; }
/** 冷却信息（不写死总时长）：ms 为剩余毫秒，附带次数/性质/上次报错，供界面如实展示。 */
function sshCooldownInfo(server) {
  const k = sshKeyOf(server);
  const arr = (sshFailLog.get(k) || []).filter((x) => Date.now() - x.ts < SSH_FAIL_WINDOW_MS);
  sshFailLog.set(k, arr);
  if (arr.length < SSH_FAIL_MAX) return { ms: 0, count: arr.length, kind: '', lastError: '' };
  const last = arr[arr.length - 1];
  const idx = Math.min(arr.length - SSH_FAIL_MAX, SSH_COOLDOWN_SECONDS.length - 1);
  const base = last.kind === 'auth' ? SSH_AUTH_COOLDOWN_MS : SSH_COOLDOWN_SECONDS[idx] * 1000;
  return { ms: Math.max(0, base - (Date.now() - last.ts)), count: arr.length, kind: last.kind, lastError: last.error || '' };
}
/** 兼容旧调用点：只要剩余毫秒数。 */
function sshCooldownLeft(server) { return sshCooldownInfo(server).ms; }
function sshNoteFailure(server, kind = 'other', error = '') {
  const k = sshKeyOf(server);
  const arr = (sshFailLog.get(k) || []).filter((x) => Date.now() - x.ts < SSH_FAIL_WINDOW_MS);
  arr.push({ ts: Date.now(), kind, error: String(error).slice(0, 200) });
  sshFailLog.set(k, arr);
}
function sshNoteSuccess(server) { sshFailLog.delete(sshKeyOf(server)); }

/**
 * 记下"这台服务器上次成功用的是哪个端口"。
 * 为什么需要：同一台 IP 上可能存在**多个 sshd**（实测 2026-09-12：22 与 50470 的 OpenSSH 补丁号都不一样，
 * 存的那串密码在 50470 上一次成功、在 22 上每次都"认证失败"）。用户一旦把端口改错，
 * 表现就是那句毫无信息量的认证失败，很容易以为是密码坏了。有了这条记录，界面能直接提醒"上次成功的是 50470"。
 */
function sshRememberGoodPort(server) {
  try {
    if (!server?.id) return;
    const cfg = loadConfig();
    const i = cfg.servers.findIndex((s) => s.id === server.id);
    if (i < 0) return;
    if (cfg.servers[i].lastGoodPort === server.port) return;
    cfg.servers[i].lastGoodPort = server.port;
    cfg.servers[i].lastGoodAt = new Date().toISOString();
    saveConfig(cfg);
    mlog(`[ssh] 记住 ${server.host} 可用端口：${server.port}`);
  } catch { /* 记录失败不影响连接 */ }
}

/** 冷却提示：**如实**说清次数、性质和上一次的真实报错，不一律甩锅给 fail2ban。 */
const sshCooldownText = (info) => {
  const secs = Math.max(1, Math.ceil(info.ms / 1000));
  const kindText = info.kind === 'auth'
    ? '这几回是"认证被拒"（凭据或用户名不对）'
    : info.kind === 'network'
      ? '这几回是"连不上/超时"'
      : '这几回报错不一';
  const advice = info.kind === 'network'
    ? '连不上也可能是 fail2ban 把本机 IP 封了：在服务器上跑 fail2ban-client set sshd unbanip <本机IP> 可解。'
    : '把密码/用户名改对后可以直接重试（点了"仍然重试一次"就立刻再试）。';
  return `连续失败 ${info.count} 次，先停 ${secs} 秒再试：${kindText}。上一次报错：${info.lastError || '（未记录）'} ${advice}`;
};

/** 一次"连上并跑一条命令"，返回输出（失败抛异常）。 */
function sshRunOnce(server, port, debugLines) {
  const s = port ? { ...server, port } : server;
  return connectOne(s, { debugLines }).then((conn) => new Promise((resolve, reject) => {
    conn.exec('echo ok && uname -a', (err, stream) => {
      if (err) { try { conn.end(); } catch { /* ignore */ } return reject(err); }
      let o = '';
      stream.on('data', (d) => (o += d.toString()));
      stream.stderr.on('data', (d) => (o += d.toString()));
      stream.on('close', () => { try { conn.end(); } catch { /* ignore */ } resolve(o.trim()); });
    });
  }));
}

/** 把"上次成功的端口"写回配置（端口填错时自动纠偏用）。 */
function sshSavePort(server, port) {
  try {
    const cfg = loadConfig();
    const i = cfg.servers.findIndex((s) => s.id === server.id);
    if (i < 0) return false;
    cfg.servers[i].port = port;
    cfg.servers[i].lastGoodPort = port;
    cfg.servers[i].lastGoodAt = new Date().toISOString();
    saveConfig(cfg);
    mlog(`[ssh] 已把 ${server.host} 的端口纠正为 ${port}（上次成功的端口）`);
    return true;
  } catch { return false; }
}

/**
 * 测试连接。**会在端口填错时自动纠偏**：
 * 先按用户填的端口试；失败且配置里记着"上次成功的端口"（lastGoodPort）时，用那个端口再试一次，
 * 成功就顺手把配置改回去并在结果里说明。
 * 为什么值得这么做（2026-09-12 实测）：同一台 IP 上有多个 sshd，用户把端口填成 22 / 50468 时，
 * 报错看起来和"密码错"一模一样（前者是认证失败，后者是 ECONNREFUSED），
 * 用户只会觉得"之前可以啊、现在怎么都不行"。
 */
app.post('/api/ssh/test', async (req, res) => {
  const server = req.body;
  const cool = sshCooldownInfo(server);
  if (cool.ms > 0 && req.query.force !== '1') {
    res.json({ success: false, cooldown: true, cooldownMs: cool.ms, kind: cool.kind, failCount: cool.count, message: sshCooldownText(cool) });
    return;
  }
  const first = server.port || 22;
  const cands = [first];
  if (server.lastGoodPort && server.lastGoodPort !== first) cands.push(server.lastGoodPort);
  let lastErr = null;
  let lastDebug = [];
  for (const port of cands) {
    const debugLines = [];
    try {
      const out = await sshRunOnce(server, port, debugLines);
      sshNoteSuccess(server);
      sshRememberGoodPort({ ...server, port });
      const switched = port !== first;
      if (switched) sshSavePort(server, port);
      res.json({
        success: true,
        port,
        message: out + (switched
          ? `\n\n（说明：你填的端口 ${first} 连不上，已自动改用上次成功的 ${port}，并把配置改成了 ${port}）`
          : ''),
      });
      return;
    } catch (e) {
      lastErr = e;
      lastDebug = debugLines;
    }
  }
  const e = lastErr ?? new Error('未知错误');
  const isAuth = /authentication methods failed|authentication failure|Permission denied/i.test(String(e?.message ?? ''));
  const isTimeout = /超时|timed? ?out|ETIMEDOUT|ECONNREFUSED/i.test(String(e?.message ?? ''));
  sshNoteFailure(server, isAuth ? 'auth' : isTimeout ? 'network' : 'other', String(e?.message ?? e));
  if (isTimeout) {
    // 超时/拒连≠凭据问题：可能是端口不对（同一台 IP 上常挂着多个 sshd），也可能是刚失败太多次被 fail2ban 封了本机 IP
    const after = sshCooldownInfo(server).ms > 0
      ? '（这台机器刚刚连续失败过几次，fail2ban 很可能已封本机 IP —— 去服务器上 fail2ban-client set sshd unbanip <本机IP> 解开）'
      : `（端口 ${first} 上没有 SSH 服务或放不放行要确认；可用 tools\\probe-ssh-banner.mjs 零认证探测哪个端口才是 sshd${server.lastGoodPort ? `，上次成功的是 ${server.lastGoodPort}` : ''}）`;
    res.json({ success: false, timeout: true, message: `连接失败：${server.username}@${server.host}:${first}${after}` });
    return;
  }
  if (isAuth) {
    const d = sshAuthDiagnose(server, e, lastDebug);
    res.json({ success: false, message: d.message, detail: { serverMethods: d.serverMethods, sentMethods: d.sentMethods } });
    return;
  }
  res.json({ success: false, message: e.message });
});

app.post('/api/ssh/connect', async (req, res) => {
  const server = req.body;
  if (!server?.id) return res.status(400).json({ success: false, message: '缺少 server.id' });
  const cool = sshCooldownInfo(server);
  if (cool.ms > 0 && req.query.force !== '1' && req.body?.force !== true) {
    res.json({ success: false, cooldown: true, cooldownMs: cool.ms, kind: cool.kind, failCount: cool.count, message: sshCooldownText(cool) });
    return;
  }
  const cfg = loadConfig();
  if (!cfg.servers.find((s) => s.id === server.id)) { cfg.servers = [...cfg.servers.filter((s) => s.id !== server.id), server]; saveConfig(cfg); }
  const debugLines = [];
  try {
    // 手动连接 = 明确要连：清掉"用户点过断开"的标记，取消可能在排队的自动重连，然后走同一段建立流程
    manualDisconnects.delete(server.id);
    cancelReconnect(server.id);
    const tunnelsCreated = await establishConnection(server, { debugLines });
    res.json({ success: true, message: 'SSH 连接成功，隧道已建立', tunnels: tunnelsCreated });
  } catch (e) {
    const isAuth = /authentication methods failed|authentication failure|Permission denied/i.test(String(e?.message ?? ''));
    // 【2026-09-14】失败的**性质**要记账（凭据 / 连不上 / 其它），冷却时长与提示都按它来算；
    // 以前只记"失败"两字，于是密码错和 IP 被封被当成同一回事、一律甩 10 分钟冷却。
    const isNet = /超时|timed? ?out|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ECONNRESET/i.test(String(e?.message ?? ''));
    sshNoteFailure(server, isAuth ? 'auth' : isNet ? 'network' : 'other', String(e?.message ?? e));
    if (isAuth) {
      const d = sshAuthDiagnose(server, e, debugLines, []);
      res.json({ success: false, message: d.message, detail: { serverMethods: d.serverMethods, sentMethods: d.sentMethods } });
      return;
    }
    res.json({ success: false, message: e.message });
  }
});

app.post('/api/ssh/disconnect', (req, res) => {
  const cfg = loadConfig();
  const id = req.body?.serverId ?? cfg.activeServerId;
  // 用户**主动**断开：打上标记，别让自动重连把它又连回来（否则点了断开、几秒后又连上，人会以为按钮坏了）
  if (id) { manualDisconnects.add(id); cancelReconnect(id); }
  if (id && sshConnections.has(id)) { sshConnections.get(id).end(); sshConnections.delete(id); }
  closeTunnels(id || '');
  bridgeTokenCache.delete(id || '');
  remoteStatusCache.delete(id || ''); remoteBridgeDirCache.delete(id || '');
  remoteBridgeCfgCache.delete(id || '');          // 断开后别把服务端配置缓存留着（下次连上重新预热）
  if (cfg.activeServerId === id) { cfg.activeServerId = null; saveConfig(cfg); }
  res.json({ success: true });
});

/* ------------------------------------------------------------------ */
/* 桥代码同步(to-server / to-local) 与 整套移除(remove-stack)           */
/* ------------------------------------------------------------------ */
/** Windows 打包/解包前确认 tar 在 PATH(bsdtar/GNU tar 均可), 否则给出提示 */
function checkTarAvailable() {
  try {
    const r = spawnSync('tar', ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return r.status === 0 && !r.error;
  } catch { return false; }
}

/** 本地 qq-bridge 目录打成 tar.gz(临时文件); includeState=false 时排除 state/ */
function packLocalBridge(includeState) {
  const dir = findBridgeDir();
  const parent = dirname(dir);
  const name = basename(dir);
  const tmp = join(tmpdir(), `qq-bridge-sync-${Date.now()}.tar.gz`);
  const ex = [
    `${name}/node_modules`, `${name}/.git`,
    `${name}/bridge.lock`, `${name}/state/bridge.lock`,
    `${name}/*.log`, `${name}/state/*.log`,
    `${name}/state.bak-*`, `${name}/state.old-*`,
    // 图库(stickers-upload)只随“表情包”勾选独立推送, 绝不搭代码包顺带覆盖远端图库
    `${name}/stickers-upload`, `${name}/stickers-upload.bak-*`, `${name}/stickers-upload.old-*`, `${name}/stickers-upload.merge-*`,
    `${name}/config.json.bak-*`,
  ];
  if (!includeState) ex.push(`${name}/state`);
  const args = ['-czf', tmp, ...ex.map((p) => `--exclude=${p}`), '-C', parent, name];
  const r = spawnSync('tar', args, { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (r.error || r.status !== 0) {
    try { unlinkSync(tmp); } catch {}
    return { ok: false, error: String(r.stderr || r.error?.message || 'tar 打包失败') };
  }
  return { ok: true, path: tmp };
}

/** 传输超时策略：**无进展**才算超时。
 *  【2026-09-13 修「部署上传超时」】原来是一个固定 300 秒的**总**超时：
 *  12.7 MB 的桥包在慢链路上（实测约 40 KB/s）传到 5 分钟就被判超时，部署直接失败。
 *  现在改成两段判据：只要还有数据在流动就重置计时（idleMs），另设一个绝对上限（maxTotalMs）兜底。
 *  idleMs 默认 120 秒、maxTotalMs 默认 60 分钟；可用环境变量 QBM_TRANSFER_IDLE_MS / QBM_TRANSFER_MAX_MS 覆盖。 */
const TRANSFER_IDLE_MS = Math.max(30000, Number(process.env.QBM_TRANSFER_IDLE_MS) || 120000);
const TRANSFER_MAX_MS = Math.max(600000, Number(process.env.QBM_TRANSFER_MAX_MS) || 3600000);
const fmtMb = (n) => `${(Number(n) / 1048576).toFixed(1)} MB`;

/** 用 SFTP(fastPut) 上传一个文件。
 *  【2026-09-14 修「传输 bridge: gzip: stdin: unexpected end of file / tar: Child returned status 1」】
 *  实测把 12 MB 的桥包用 `cat > 远端文件` 走 stdin 管道，尾部会丢一段（远端 gzip 直接报 unexpected end of file），
 *  而同一个包在本地 `tar tzf` 完好（270 个条目）——问题在"流式 stdin + EOF"这条路，不在打包。
 *  SFTP 是真正的文件传输（有确认、有返回值），比往 channel stdin 里灌字节稳得多。 */
function sftpPutFile(conn, localPath, remotePath, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('SFTP 上传超时')); } }, timeoutMs);
    try {
      conn.sftp((err, sftp) => {
        if (err) { if (!settled) { settled = true; clearTimeout(timer); reject(err); } return; }
        sftp.fastPut(localPath, remotePath, (err2) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { sftp.end(); } catch {}
          if (err2) reject(err2); else resolve();
        });
      });
    } catch (e) { if (!settled) { settled = true; clearTimeout(timer); reject(e); } }
  });
}

/** 本地文件 → 远端路径：优先 SFTP，失败退回 stdin 管道；两条路都**按远端字节数复核**。
 *  传不全就抛错 —— 绝不把截断的包交给解包步骤（那正是这次部署失败的现场）。 */
async function uploadFileVerified(conn, localPath, remotePath) {
  let total = 0;
  try { total = statSync(localPath).size; } catch {}
  let viaSftp = true;
  try {
    await sftpPutFile(conn, localPath, remotePath);
  } catch (e) {
    viaSftp = false;
    try { mlog(`[upload] SFTP 不可用（${e?.message ?? e}），退回 stdin 管道：${remotePath}`); } catch { /* ignore */ }
    await pipeLocalFileToRemote(conn, localPath, `cat > ${remotePath}`, undefined, undefined, { remotePath });
  }
  const got = await remoteFileSize(conn, remotePath);
  if (got >= 0 && got !== total) {
    throw new Error(`上传不完整：远端 ${got} / 本地 ${total} 字节（${viaSftp ? 'SFTP' : 'stdin 管道'}）`);
  }
  return { ok: true, bytes: total, via: viaSftp ? 'sftp' : 'pipe', remotePath };
}

/** deploy.js 的上传接口（它按 (conn, localPath, remoteCmd, idleMs, maxTotalMs, opts) 调用）。 */
const uploadLocalFileToRemote = async (conn, localPath, remoteCmd, _idleMs, _maxTotalMs, opts = {}) => {
  const remotePath = String(opts?.remotePath || '').trim()
    || String(remoteCmd ?? '').replace(/^\s*cat\s*>\s*/, '').trim();
  if (!remotePath) return pipeLocalFileToRemote(conn, localPath, remoteCmd, _idleMs, _maxTotalMs, opts);
  return uploadFileVerified(conn, localPath, remotePath);
};

/** 远端文件字节数：传输完成后**复核**用（拿不到返回 -1）。
 *  【2026-09-14 修「部署传输 bridge 失败：gzip: stdin: unexpected end of file / tar: Child returned status 1」】
 *  那次的真相是：本地 13.4 MB 的包**只传了一部分**就返回了成功，远端 `cat >` 正常退出（exit 0），
 *  紧跟着的 `tar xzf` 才读到截断的 gzip。所以"传完了"必须用远端字节数证明，不能只看本地读完了。 */
function remoteFileSize(conn, remotePath, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let out = '';
    let st = null;
    const timer = setTimeout(() => { try { st?.close?.(); } catch {} resolve(-1); }, timeoutMs);
    try {
      conn.exec(`stat -c %s ${remotePath} 2>/dev/null || echo 0`, (err, stream) => {
        if (err) { clearTimeout(timer); return resolve(-1); }
        st = stream;
        stream.on('data', (d) => (out += d.toString()));
        stream.stderr.on('data', () => {});
        stream.on('close', () => {
          clearTimeout(timer);
          const n = Number(String(out).trim().split(/\s+/).pop());
          resolve(Number.isFinite(n) ? n : -1);
        });
      });
    } catch { clearTimeout(timer); resolve(-1); }
  });
}

/** 本地文件流 → 远端 stdin(远端命令从 stdin 收, 如 cat > /root/xxx.tar.gz)
 *  opts.remotePath 给了就**逐字节复核**远端文件大小，不匹配即判失败（绝不把截断的包交给解包步骤）。
 *  opts.verifyOnly 为真时只做复核（重试前复用已传文件）。 */
function pipeLocalFileToRemote(conn, localPath, remoteCmd, idleMs = TRANSFER_IDLE_MS, maxTotalMs = TRANSFER_MAX_MS, opts = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let idleTimer = null;
    let hardTimer = null;
    let sent = 0;
    let allSent = false;
    let total = 0;
    let errOut = '';
    const remotePath = String(opts.remotePath || '');
    try { total = statSync(localPath).size; } catch {}
    const graceMs = 30000;

    const done = (fn) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      fn();
    };

    /** 收尾：远端字节数对上才算成功。 */
    const finish = async (why) => {
      if (settled) return;
      if (remotePath) {
        const got = await remoteFileSize(conn, remotePath);
        if (got >= 0 && got !== total) {
          try { rs.destroy(); } catch {}
          return done(() => reject(new Error(`上传不完整：远端只有 ${fmtMb(got)} / 本地 ${fmtMb(total)}（${why}）——已判失败，重试一次`)));
        }
      }
      done(() => resolve());
    };

    const rs = createReadStream(localPath);
    rs.on('error', (e) => done(() => reject(e)));
    rs.on('data', (chunk) => {
      sent += chunk.length;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => done(() => reject(new Error(
        `上传超时：${idleMs / 1000} 秒没有进展（已传 ${fmtMb(sent)} / 共 ${fmtMb(total)}）—— 链路太慢或已中断，可加大 QBM_TRANSFER_IDLE_MS 或换网络后重试`
      ))), idleMs);
    });
    /* 本地读完 ≠ 远端收全。
     * 【2026-09-14】旧版这里 30 秒后**直接按成功返回**（"数据确实发出去了"），结果出现了
     * "上传成功 → 解包 gzip: unexpected end of file"：文件只到了一部分。现在改成：
     * 本地读完后再等 graceMs 让远端收尾，超时就**用远端字节数复核**，对不上就报错。 */
    rs.on('end', () => {
      allSent = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      hardTimer = setTimeout(() => { void finish('本地已读完但远端迟迟未收尾'); }, graceMs);
    });
    conn.exec(remoteCmd, (err, stream) => {
      if (err) return done(() => reject(err));
      idleTimer = setTimeout(() => done(() => reject(new Error(
        `上传超时：${idleMs / 1000} 秒没有进展（已传 0 B / 共 ${fmtMb(total)}）`
      ))), idleMs);
      if (allSent) {
        if (idleTimer) clearTimeout(idleTimer);
        hardTimer = setTimeout(() => { void finish('本地已读完但远端迟迟未收尾'); }, graceMs);
      } else {
        hardTimer = setTimeout(() => done(() => reject(new Error(
          `上传超时：总时长超过 ${Math.round(maxTotalMs / 60000)} 分钟（已传 ${fmtMb(sent)} / 共 ${fmtMb(total)}）`
        ))), maxTotalMs);
      }
      stream.stderr.on('data', (d) => (errOut += d.toString()));
      stream.on('close', (code) => {
        if (code !== 0) return done(() => reject(new Error(errOut.trim() || `远端 exit ${code}`)));
        void finish('远端命令已正常退出');
      });
      rs.pipe(stream.stdin, { end: true });
    });
  });
}

/** 远端命令输出(cat 文件) → 本地文件（超时判据同上传：无进展才算超时） */
function pipeRemoteFileToLocal(conn, remoteCmd, localPath, idleMs = TRANSFER_IDLE_MS, maxTotalMs = TRANSFER_MAX_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let idleTimer = null;
    let hardTimer = null;
    let got = 0;
    const done = (fn) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      try { ws.destroy(); } catch {}
      fn();
    };
    const ws = createWriteStream(localPath);
    ws.on('error', (e) => done(() => reject(e)));
    conn.exec(remoteCmd, (err, stream) => {
      if (err) return done(() => reject(err));
      let errOut = '';
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => done(() => reject(new Error(
          `下载超时：${idleMs / 1000} 秒没有进展（已收 ${fmtMb(got)}）—— 链路太慢或已中断，可加大 QBM_TRANSFER_IDLE_MS 后重试`
        ))), idleMs);
      };
      resetIdle();
      hardTimer = setTimeout(() => done(() => reject(new Error(
        `下载超时：总时长超过 ${Math.round(maxTotalMs / 60000)} 分钟（已收 ${fmtMb(got)}）`
      ))), maxTotalMs);
      stream.on('data', (chunk) => { got += chunk.length; resetIdle(); });
      stream.stderr.on('data', (d) => (errOut += d.toString()));
      stream.on('close', (code) => {
        if (code !== 0) { ws.end(); done(() => reject(new Error(errOut.trim() || `远端 exit ${code}`))); return; }
        if (ws.writableFinished) done(() => resolve());
        else ws.on('finish', () => done(() => resolve()));
      });
      stream.pipe(ws, { end: true });
    });
  });
}

/**
 * 同步桥代码: to-server = 本地 qq-bridge → 远端 /root/qq-bridge(覆盖式);
 * to-local = 远端 → 本地 findBridgeDir()(先备份本地 config.json)。
 * includeState=true 时 to-server 连同 state/(记忆/会话)一起同步。
 */
/** 递归把 from 中缺失于 to 的文件拷入(目录并集; 同名文件保留 to 侧, 语义同 merge-state.mjs 普通文件) */
function copyMissing(from, to) {
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const s = join(from, e.name);
    const d = join(to, e.name);
    if (e.isDirectory()) { mkdirSync(d, { recursive: true }); copyMissing(s, d); }
    else if (!existsSync(d)) { copyFileSync(s, d); }
  }
}

/** 远端安全替换: 先把旧目录 mv 成 .bak-remote-<ts>, 再解包新内容; 解包失败自动回滚旧目录。
 *  dir 取 'state' 或 'stickers-upload'(位于 /root/qq-bridge 下); archive 为远端 tar 路径。 */
function remoteSwapBash(dir, archive) {
  return `cd /root/qq-bridge || exit 9; ts=$(date +%Y%m%d-%H%M%S); bak="${dir}.bak-remote-$ts"; if [ -d "${dir}" ]; then mv "${dir}" "$bak" || exit 9; fi; rm -rf "${dir}"; mkdir -p "${dir}"; if tar xzf ${archive} -C /root/qq-bridge && rm -f ${archive}; then echo OK; else rm -rf "${dir}"; if [ -d "$bak" ]; then mv "$bak" "${dir}"; fi; echo FAIL; exit 1; fi`;
}

app.post('/api/ssh/sync', async (req, res) => {
  const body = req.body ?? {};
  const { server, direction = 'to-server', includeState = false, flags } = body;
  if (!server || !server.host) return res.status(400).json({ success: false, message: '缺少服务器配置(server.host)' });
  // 兼容两种调用: 旧式 direction='to-server+state' / 新式 flags={code,state,stickers}
  const rawDir = String(direction || 'to-server');
  const baseDir = rawDir.split('+')[0];
  const dir = baseDir === 'to-local' ? 'to-local' : (baseDir === 'merge' ? 'merge' : 'to-server');
  const wantCode = dir === 'merge' ? false : (flags?.code ?? true);            // merge 不推代码
  const wantState = dir === 'merge' ? true : (flags?.state ?? includeState);   // merge 必合 state
  const wantStickers = flags?.stickers ?? (rawDir.includes('+stickers') ? true : false);
  const wantConfig = flags?.config ?? (rawDir.includes('+config') ? true : false);   // 单独同步桥的 config.json（与代码/数据分开勾选）
  const steps = [];
  let conn = null;
  try {
    conn = await connectOne(server);
    steps.push({ step: '连接服务器', ok: true, msg: `已连接 ${server.username || ''}@${server.host}` });

    if (dir === 'to-server') {
      // to-server = 本地 → 远端。内容按勾选: 代码(默认) / state 数据 / 表情包文件夹。
      if (!checkTarAvailable()) return res.json({ success: false, steps: [...steps, { step: '检查本地 tar', ok: false, msg: '系统 PATH 中找不到 tar, 无法打包' }] });
      steps.push({ step: '检查本地 tar', ok: true, msg: 'tar 可用' });
      const bridgeDir = findBridgeDir();
      const localState = join(bridgeDir, 'state');
      const localStickers = join(bridgeDir, 'stickers-upload');
      const stickerIndex = join(bridgeDir, 'state', 'stickers.json');
      try {
        if (wantCode) {
          const pkg = packLocalBridge(false);
          if (!pkg.ok) return res.json({ success: false, steps: [...steps, { step: '本地打包桥代码', ok: false, msg: pkg.error }] });
          steps.push({ step: '本地打包桥代码', ok: true, msg: pkg.path });
          await uploadFileVerified(conn, pkg.path, '/root/qq-bridge-sync.tar.gz');
          steps.push({ step: '上传桥代码', ok: true, msg: '/root/qq-bridge-sync.tar.gz' });
          const bak = await sshExecCapture(conn, 'if [ -f /root/qq-bridge/config.json ]; then cp /root/qq-bridge/config.json /root/qq-bridge/config.json.bak-sync && echo backed-up; else echo no-config; fi', 20000);
          steps.push({ step: '备份远端 config.json', ok: bak.ok, msg: bak.ok ? (bak.out.includes('backed-up') ? '已备份为 config.json.bak-sync' : '远端无 config.json, 跳过') : bak.error });
          const unp = await sshExecCapture(conn, 'cd /root && tar xzf /root/qq-bridge-sync.tar.gz -C /root && echo unpacked', 300000);
          steps.push({ step: '解包覆盖 /root/qq-bridge', ok: unp.ok, msg: unp.ok ? '已解包' : unp.error });
          const syn = await sshExecCapture(conn, "cd /root/qq-bridge && bad=$(for f in src/bridge.js src/core/*.js; do [ -f \"$f\" ] || continue; node --check \"$f\" >/dev/null 2>&1 || echo \"$f\"; done); if [ -n \"$bad\" ]; then echo \"$bad\"; exit 1; else echo SYNTAX-OK; fi", 120000);
          steps.push({ step: '远端语法体检', ok: syn.ok, msg: syn.ok ? (syn.out.includes('SYNTAX-OK') ? 'src 语法全部通过' : syn.out) : (syn.out || syn.error) });
          try { unlinkSync(pkg.path); } catch {}
        }
        if (wantConfig) {
          // 单独同步「桥的 config.json」：代码同步本来就不带它（远端那份通常有自己的 dsh.baseUrl / 端口），
          // 所以这里给一个显式开关 —— 只推这一个文件，推之前远端已经备份成 .bak-sync。
          const localCfg = join(bridgeDir, 'config.json');
          if (!existsSync(localCfg)) {
            steps.push({ step: '同步 config.json', ok: false, msg: `本地没有 ${localCfg}` });
          } else {
            try {
              const localBytes = readFileSync(localCfg).length;
              await uploadFileVerified(conn, localCfg, '/root/qq-bridge/config.json');
              const sz = await sshExecCapture(conn, 'wc -c < /root/qq-bridge/config.json', 20000);
              const remoteBytes = Number(String(sz.out || '').trim().split(/\s+/)[0]) || 0;
              steps.push({
                step: '同步 config.json', ok: remoteBytes === localBytes,
                msg: remoteBytes === localBytes ? `已推送 ${localBytes} 字节（远端原文件已备份为 config.json.bak-sync）` : `字节数不一致：本地 ${localBytes} / 远端 ${remoteBytes}`,
              });
            } catch (eCfg) {
              steps.push({ step: '同步 config.json', ok: false, msg: String(eCfg?.message ?? eCfg) });
            }
          }
        }
        // 覆盖远端 state/表情包前暂停远端桥(其 memory.db 同样常开), 结束后统一重启
        if (wantState || wantStickers) {
          const stR = await sshExecCapture(conn, "cd /root/qq-bridge && (pkill -f 'node src/bridge[.]js' 2>/dev/null || true); sleep 1; echo stopped", 30000);
          steps.push({ step: '暂停远端桥(覆盖数据期间)', ok: stR.ok, msg: '已暂停' });
        }
        if (wantState) {
          if (!existsSync(localState)) { steps.push({ step: '本地 state', ok: false, msg: '本地无 state 目录' }); }
          else {
            const sTar = join(tmpdir(), `qqbridge-state-${Date.now()}.tar.gz`);
            const pS = spawnSync('tar', ['-czf', sTar, '-C', bridgeDir, 'state'], { encoding: 'utf8', timeout: 300000, windowsHide: true });
            steps.push({ step: '打包本地 state', ok: pS.status === 0, msg: pS.status === 0 ? '已打包' : String(pS.stderr || '打包失败') });
            if (pS.status === 0) {
              await uploadFileVerified(conn, sTar, '/root/qq-bridge-state-sync.tar.gz');
              const apply = await sshExecCapture(conn, remoteSwapBash('state', '/root/qq-bridge-state-sync.tar.gz'), 300000);
              steps.push({ step: '远端 state 替换为本地', ok: apply.ok && String(apply.out || '').includes('OK'), msg: String(apply.out || apply.error || '') });
            }
            try { unlinkSync(sTar); } catch {}
          }
        }
        if (wantStickers) {
          // 表情包: 图库文件目录 + 索引。远端先备份旧图库, 再合并覆盖
          const sTar = join(tmpdir(), `qqbridge-stickers-${Date.now()}.tar.gz`);
          const hasIndex = existsSync(stickerIndex);
          const hasDir = existsSync(localStickers) && readdirSync(localStickers).length > 0;
          if (!hasIndex && !hasDir) { steps.push({ step: '本地表情包', ok: false, msg: '本地没有表情包文件夹(stickers-upload)或索引(stickers.json)' }); }
          else {
            const inc = [join(bridgeDir, 'stickers-upload'), stickerIndex].filter((p) => existsSync(p));
            const args = ['-czf', sTar];
            const parent = bridgeDir;
            for (const p of inc) args.push('-C', parent, p.endsWith('stickers.json') ? 'state/stickers.json' : basename(p));
            const pSt = spawnSync('tar', args, { encoding: 'utf8', timeout: 300000, windowsHide: true });
            steps.push({ step: '打包本地表情包', ok: pSt.status === 0, msg: pSt.status === 0 ? '已打包' : String(pSt.stderr || '打包失败') });
            if (pSt.status === 0) {
              await uploadFileVerified(conn, sTar, '/root/qq-bridge-stickers.tar.gz');
              const apply = await sshExecCapture(conn, remoteSwapBash('stickers-upload', '/root/qq-bridge-stickers.tar.gz'), 300000);
              steps.push({ step: '远端表情包替换为本地', ok: apply.ok && String(apply.out || '').includes('OK'), msg: String(apply.out || apply.error || '') });
            }
            try { unlinkSync(sTar); } catch {}
          }
        }
        const rst = await sshExecCapture(conn, "cd /root/qq-bridge && nohup bash start-bridge.sh </dev/null >/dev/null 2>&1 & sleep 3; pgrep -f 'node src/bridge[.]js' >/dev/null && echo bridge-up || echo bridge-down", 30000);
        steps.push({ step: '重启桥', ok: rst.ok && String(rst.out || '').includes('bridge-up'), msg: String(rst.out || rst.error || '') });
      } finally {
        const rm = await sshExecCapture(conn, 'rm -f /root/qq-bridge-sync.tar.gz /root/qq-bridge-state-sync.tar.gz /root/qq-bridge-stickers.tar.gz', 20000);
        steps.push({ step: '清理远端临时文件', ok: rm.ok, msg: rm.ok ? '已清理' : (rm.error || '清理失败') });
      }
    } else if (dir === 'to-local') {
      // to-local: 远端打包 → 下载 → 覆盖本地(先备份本地 config.json)
      if (!checkTarAvailable()) return res.json({ success: false, steps: [...steps, { step: '检查本地 tar', ok: false, msg: '系统 PATH 中找不到 tar, 无法解压' }] });
      steps.push({ step: '检查本地 tar', ok: true, msg: 'tar 可用' });
      const localDir = findBridgeDir();
      const wantsState = wantState || dir === 'merge';
      // 覆盖本地 state/表情包前暂停本地桥: memory.db 是桥进程常开单例, 运行中 rmdir/改名会失败或把库写坏
      const touchLocalData = wantState || wantStickers;
      if (touchLocalData) {
        try {
          const stL = await stopInstance('bridge-local');
          steps.push({ step: '暂停本地桥(覆盖数据期间)', ok: stL?.success !== false, msg: stL?.message || '' });
        } catch (eL) { steps.push({ step: '暂停本地桥', ok: false, msg: eL.message }); }
      }
      if (wantCode) {
        // 代码包(默认勾选)。state/stickers 单独拉取, 避免覆盖整目录语义混淆
        const rp = await sshExecCapture(conn, "cd /root/qq-bridge && tar czf /root/qq-bridge-sync.tar.gz --exclude=node_modules --exclude=state --exclude=stickers-upload --exclude='*.log' --exclude=bridge.lock . && echo packed", 300000);
        steps.push({ step: '远端打包 qq-bridge', ok: rp.ok, msg: rp.ok ? '已打包(不含 node_modules/state/stickers/log)' : rp.error });
        if (rp.ok) {
        const tmpLocal = join(tmpdir(), `qq-bridge-local-${Date.now()}.tar.gz`);
        try {
          await pipeRemoteFileToLocal(conn, 'cat /root/qq-bridge-sync.tar.gz', tmpLocal);
          steps.push({ step: '下载到本地', ok: true, msg: tmpLocal });
          const cfgPath = join(localDir, 'config.json');
          if (existsSync(cfgPath)) {
            try {
              copyFileSync(cfgPath, join(localDir, 'config.json.bak-local'));
              steps.push({ step: '备份本地 config.json', ok: true, msg: '已备份为 config.json.bak-local' });
            } catch (e) { steps.push({ step: '备份本地 config.json', ok: false, msg: e.message }); }
          } else {
            steps.push({ step: '备份本地 config.json', ok: true, msg: '本地无 config.json, 跳过' });
          }
          mkdirSync(localDir, { recursive: true });
          const ex = spawnSync('tar', ['xzf', tmpLocal, '-C', localDir], { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
          steps.push({ step: '解压覆盖本地 qq-bridge', ok: ex.status === 0 && !ex.error, msg: ex.status === 0 ? `已解压到 ${localDir}` : String(ex.stderr || ex.error?.message || '解压失败') });
        } finally {
          try { unlinkSync(tmpLocal); } catch {}
          const rm = await sshExecCapture(conn, 'rm -f /root/qq-bridge-sync.tar.gz', 20000);
          steps.push({ step: '清理临时文件', ok: rm.ok, msg: rm.ok ? '已清理' : (rm.error || '本地已删, 远端清理失败') });
        }
      }
      } else {
        steps.push({ step: '拉取桥代码', ok: true, msg: '未勾选代码, 跳过' });
      }
      if (wantConfig) {
        // 单独拉取「桥的 config.json」：覆盖本地前先备份成本地 config.json.bak-local
        const cfgLocal = join(localDir, 'config.json');
        try {
          if (existsSync(cfgLocal)) {
            copyFileSync(cfgLocal, join(localDir, 'config.json.bak-local'));
            steps.push({ step: '备份本地 config.json', ok: true, msg: '已备份为 config.json.bak-local' });
          }
          await pipeRemoteFileToLocal(conn, 'cat /root/qq-bridge/config.json', cfgLocal);
          const localBytes = readFileSync(cfgLocal).length;
          steps.push({ step: '拉取 config.json', ok: localBytes > 0, msg: `已写入 ${localBytes} 字节 → ${cfgLocal}` });
        } catch (eCfg) {
          steps.push({ step: '拉取 config.json', ok: false, msg: String(eCfg?.message ?? eCfg) });
        }
      }
      // to-local 可选附加: state / 表情包从远端拉回本地(覆盖本地对应目录, 先本地备份)
      if (wantState || dir === 'merge') {
        const bakDir = join(localDir, `state.bak-local-${Date.now()}`);
        const xb2 = spawnSync('cmd', ['/c', `xcopy /E /I /H /Y "${join(localDir, 'state')}" "${bakDir}" >nul`], { stdio: 'ignore', timeout: 120000, windowsHide: true });
        steps.push({ step: '备份本地 state', ok: xb2.status === 0, msg: xb2.status === 0 ? bakDir : '跳过(本地尚无 state)' });
        const gSt = await sshExecCapture(conn, "cd /root/qq-bridge && tar czf /root/qq-bridge-state-sync.tar.gz --exclude=state/agents --exclude='state/*.log' --exclude=state/bridge.lock state 2>/dev/null && echo packed || echo none", 300000);
        if (gSt.ok && String(gSt.out || '').includes('packed')) {
          const tSt = join(tmpdir(), `qqbridge-state-pull-${Date.now()}.tar.gz`);
          try {
            await pipeRemoteFileToLocal(conn, 'cat /root/qq-bridge-state-sync.tar.gz', tSt);
            mkdirSync(join(localDir, 'state'), { recursive: true });
            const rmOld = spawnSync('cmd', ['/c', `rmdir /s /q "${join(localDir, 'state')}"`], { stdio: 'ignore', timeout: 120000, windowsHide: true });
            const exSt = spawnSync('tar', ['xzf', tSt, '-C', localDir], { encoding: 'utf8', timeout: 300000, windowsHide: true });
            steps.push({ step: '远端 state 覆盖本地', ok: exSt.status === 0, msg: exSt.status === 0 ? '已覆盖' : String(exSt.stderr || '解压失败') });
          } finally { try { unlinkSync(tSt); } catch {} }
          await sshExecCapture(conn, 'rm -f /root/qq-bridge-state-sync.tar.gz', 15000);
        } else { steps.push({ step: '远端 state', ok: false, msg: '远端无 state 或打包失败' }); }
      }
      if (wantStickers || dir === 'merge') {
        const gSk = await sshExecCapture(conn, "cd /root/qq-bridge && (tar czf /root/qq-bridge-stickers.tar.gz stickers-upload state/stickers.json 2>/dev/null && echo packed || echo none)", 300000);
        if (gSk.ok && String(gSk.out || '').includes('packed')) {
          const tSk = join(tmpdir(), `qqbridge-stickers-pull-${Date.now()}.tar.gz`);
          try {
            await pipeRemoteFileToLocal(conn, 'cat /root/qq-bridge-stickers.tar.gz', tSk);
            mkdirSync(join(localDir, 'stickers-upload'), { recursive: true });
            const rmSk = spawnSync('cmd', ['/c', `rmdir /s /q "${join(localDir, 'stickers-upload')}"`], { stdio: 'ignore', timeout: 60000, windowsHide: true });
            const exSk = spawnSync('tar', ['xzf', tSk, '-C', localDir], { encoding: 'utf8', timeout: 300000, windowsHide: true });
            steps.push({ step: '远端表情包覆盖本地', ok: exSk.status === 0, msg: exSk.status === 0 ? '已覆盖' : String(exSk.stderr || '解压失败') });
          } finally { try { unlinkSync(tSk); } catch {} }
          await sshExecCapture(conn, 'rm -f /root/qq-bridge-stickers.tar.gz', 15000);
        } else { steps.push({ step: '远端表情包', ok: false, msg: '远端没有表情包文件夹' }); }
      }
      if (touchLocalData) {
        try {
          const rL = await startDispatcher('bridge-local', loadConfig());
          steps.push({ step: '重启本地桥', ok: rL?.success !== false, msg: rL?.success ? (rL.message || '已恢复') : (rL.message || '恢复失败') });
        } catch (eR) { steps.push({ step: '重启本地桥', ok: false, msg: eR.message }); }
      }
    } else if (dir === 'merge') {
      // merge(双向合并 state): 远端 state 下载 → 与本地 state 合并 → 合并结果写回两端。
      // 代码/config.json 一律不动; 两端各自 state 的增量(会话/记忆/用量/贴纸)合成为一套。
      if (!checkTarAvailable()) return res.json({ success: false, steps: [...steps, { step: '检查本地 tar', ok: false, msg: '系统 PATH 中找不到 tar' }] });
      const bridgeDir = findBridgeDir();
      const localState = join(bridgeDir, 'state');
      if (!existsSync(localState)) return res.json({ success: false, steps: [...steps, { step: '本地 state', ok: false, msg: `本地无 state 目录: ${localState}` }] });
      steps.push({ step: '检查本地 state', ok: true, msg: localState });
      const stopB = await sshExecCapture(conn, "cd /root/qq-bridge && (pkill -f 'node src/bridge[.]js' 2>/dev/null || true); sleep 1; pgrep -f 'node src/bridge[.]js' >/dev/null && echo still-running || echo stopped", 30000);
      steps.push({ step: '暂停远端桥(合并期间避免写冲突)', ok: stopB.ok, msg: String(stopB.out || stopB.error || '') });
      const rpack = await sshExecCapture(conn, "cd /root/qq-bridge && tar czf /root/qq-bridge-state-merge.tar.gz --exclude=state/agents --exclude='state/*.log' --exclude=state/bridge.lock state 2>/dev/null && echo packed || echo pack-failed", 300000);
      steps.push({ step: '远端打包 state', ok: rpack.ok && String(rpack.out || '').includes('packed'), msg: String(rpack.out || rpack.error || '') });
      if (!(rpack.ok && String(rpack.out || '').includes('packed'))) return res.json({ success: false, steps, message: '远端 state 打包失败' });
      const remoteStateDir = join(tmpdir(), `qqbridge-remote-state-${Date.now()}`);
      const remoteTar = remoteStateDir + '.tar.gz';
      let mergedDir = ''; // 合并输出 staging(提升作用域, 供 finally 清理)
      try {
        mkdirSync(remoteStateDir, { recursive: true });
        await pipeRemoteFileToLocal(conn, 'cat /root/qq-bridge-state-merge.tar.gz', remoteTar);
        steps.push({ step: '下载远端 state', ok: true, msg: remoteTar });
        const exR = spawnSync('tar', ['xzf', remoteTar, '-C', remoteStateDir], { encoding: 'utf8', timeout: 300000, windowsHide: true });
        if (exR.status !== 0) return res.json({ success: false, steps: [...steps, { step: '解包远端 state', ok: false, msg: String(exR.stderr || '解包失败') }] });
        steps.push({ step: '解包远端 state', ok: true, msg: '已解包' });
        // 暂停本地桥: memory.db 是桥进程常开单例, 合并期间避免写冲突/句柄占用
        try {
          const stL = await stopInstance('bridge-local');
          steps.push({ step: '暂停本地桥(合并期间避免写冲突)', ok: stL?.success !== false, msg: stL?.message || '' });
        } catch (eL) { steps.push({ step: '暂停本地桥', ok: false, msg: eL.message }); }
        const resumeLocal = async (label) => {
          try {
            const r2 = await startDispatcher('bridge-local', loadConfig());
            steps.push({ step: label, ok: r2?.success !== false, msg: r2?.success ? (r2.message || '已恢复') : (r2.message || '恢复失败') });
          } catch (eR) { steps.push({ step: label, ok: false, msg: eR.message }); }
        };
        // 合并输出目录放 bridgeDir 内(state 同卷), 避开 %TEMP% 跨卷/ren 跨目录改名死局
        mergedDir = join(bridgeDir, `state.merge-stage-${Date.now()}`);
        mkdirSync(mergedDir, { recursive: true });
        const mergeScript = join(bridgeDir, 'scripts', 'merge-state.mjs');
        const mergeProg = existsSync(join(bridgeDir, '..', 'qbm-node.exe')) ? join(bridgeDir, '..', 'qbm-node.exe') : process.execPath;
        if (!existsSync(mergeScript)) { await resumeLocal('恢复本地桥(缺合并器脚本)'); return res.json({ success: false, steps: [...steps, { step: '合并器脚本', ok: false, msg: `缺少 ${mergeScript}` }] }); }
        const rM = spawnSync(mergeProg, [mergeScript, join(remoteStateDir, 'state'), localState, mergedDir], { encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
        steps.push({ step: '运行 state 合并', ok: rM.status === 0 && !rM.error, msg: rM.status === 0 ? '合并完成' : String((rM.stderr || rM.stdout || rM.error?.message || '合并失败')).slice(-400) });
        if (rM.status !== 0) { await resumeLocal('恢复本地桥(合并失败)'); return res.json({ success: false, steps, message: 'state 合并失败, 未改动任何一端' }); }
        // 备份本地 state → 同卷 rename 替换(失败自动回滚, 不再用跨目录/跨卷 ren)
        const localBak = join(bridgeDir, `state.bak-merge-${Date.now()}`);
        const xb = spawnSync('cmd', ['/c', `xcopy /E /I /H /Y "${localState}" "${localBak}" >nul`], { stdio: 'ignore', timeout: 120000, windowsHide: true });
        if (xb.status !== 0) { await resumeLocal('恢复本地桥(备份失败)'); return res.json({ success: false, steps: [...steps, { step: '备份本地 state', ok: false, msg: 'xcopy 备份失败, 中止' }] }); }
        steps.push({ step: '备份本地 state', ok: true, msg: localBak });
        const oldState = join(bridgeDir, `state.old-${Date.now()}`);
        try {
          fs.renameSync(localState, oldState);
          fs.renameSync(mergedDir, localState);
        } catch (eS) {
          try { if (!existsSync(localState) && existsSync(oldState)) fs.renameSync(oldState, localState); } catch {}
          await resumeLocal('恢复本地桥(替换失败已回滚)');
          return res.json({ success: false, steps: [...steps, { step: '替换本地 state', ok: false, msg: `本地 state 替换失败, 已回滚: ${eS.message}` }], message: '本地 state 替换失败(已回滚, 未改动)' });
        }
        steps.push({ step: '替换本地 state(旧目录已备份)', ok: true, msg: oldState });
        // 打包合并结果上传远端覆盖(远端先备份再换, 失败自动回滚)
        const upTar = join(tmpdir(), `qqbridge-merge-upload-${Date.now()}.tar.gz`);
        const pM = spawnSync('tar', ['-czf', upTar, '-C', bridgeDir, 'state'], { encoding: 'utf8', timeout: 300000, windowsHide: true });
        steps.push({ step: '打包合并结果', ok: pM.status === 0, msg: upTar });
        if (pM.status === 0) {
          await uploadFileVerified(conn, upTar, '/root/qq-bridge-merged.tar.gz');
          const rmOld = await sshExecCapture(conn, remoteSwapBash('state', '/root/qq-bridge-merged.tar.gz'), 300000);
          steps.push({ step: '远端 state 替换为合并结果', ok: rmOld.ok && String(rmOld.out || '').includes('OK'), msg: String(rmOld.out || rmOld.error || '') });
        }
        try { unlinkSync(upTar); } catch {}
        try { unlinkSync(remoteTar); } catch {}
        if (wantStickers) {
          // 表情包双向合并: 远端 stickers-upload 下载 → 与本地做文件并集(重名保留本地) → 两端写回
          let remoteStkDir = '';
          try {
            const gStk = await sshExecCapture(conn, "cd /root/qq-bridge && (tar czf /root/qq-bridge-stickers-merge.tar.gz stickers-upload 2>/dev/null && echo packed || echo none)", 300000);
            if (!(gStk.ok && String(gStk.out || '').includes('packed'))) { steps.push({ step: '下载远端表情包', ok: true, msg: '远端没有 stickers-upload 目录, 跳过' }); }
            else {
              const tStk = join(tmpdir(), `qqbridge-stickers-merge-${Date.now()}.tar.gz`);
              try {
                await pipeRemoteFileToLocal(conn, 'cat /root/qq-bridge-stickers-merge.tar.gz', tStk);
                remoteStkDir = join(tmpdir(), `qqbridge-remote-stickers-${Date.now()}`);
                mkdirSync(remoteStkDir, { recursive: true });
                const exStk = spawnSync('tar', ['xzf', tStk, '-C', remoteStkDir], { encoding: 'utf8', timeout: 300000, windowsHide: true });
                steps.push({ step: '下载远端表情包', ok: exStk.status === 0, msg: exStk.status === 0 ? '已下载解包' : String(exStk.stderr || '解包失败') });
                if (exStk.status === 0) {
                  const localUp = join(bridgeDir, 'stickers-upload');
                  const stg = join(bridgeDir, `stickers-upload.merge-${Date.now()}`);
                  mkdirSync(stg, { recursive: true });
                  if (existsSync(localUp)) copyMissing(localUp, stg);
                  copyMissing(join(remoteStkDir, 'stickers-upload'), stg);
                  steps.push({ step: '并集合并表情包', ok: true, msg: '重名保留本地, 远端独有补齐' });
                  let bakStk = '';
                  if (existsSync(localUp) && readdirSync(localUp).length > 0) {
                    bakStk = join(bridgeDir, `stickers-upload.bak-merge-${Date.now()}`);
                    const xStk = spawnSync('cmd', ['/c', `xcopy /E /I /H /Y "${localUp}" "${bakStk}" >nul`], { stdio: 'ignore', timeout: 120000, windowsHide: true });
                    steps.push({ step: '备份本地表情包', ok: xStk.status === 0, msg: xStk.status === 0 ? bakStk : '备份失败, 中止表情包替换' });
                    if (xStk.status !== 0) return res.json({ success: false, steps, message: '本地表情包备份失败, 表情包未改动' });
                  } else { steps.push({ step: '备份本地表情包', ok: true, msg: '本地无图库, 跳过' }); }
                  if (existsSync(localUp)) {
                    const rn1 = spawnSync('cmd', ['/c', `ren "${localUp}" "${basename(join(bridgeDir, `stickers-upload.old-${Date.now()}`))}"`], { cwd: bridgeDir, stdio: 'ignore', timeout: 60000, windowsHide: true });
                    if (rn1.status !== 0) return res.json({ success: false, steps, message: '本地表情包目录改名失败, 中止' });
                  }
                  const rn2 = spawnSync('cmd', ['/c', `ren "${stg}" "stickers-upload"`], { cwd: bridgeDir, stdio: 'ignore', timeout: 60000, windowsHide: true });
                  steps.push({ step: '本地表情包替换为合并结果', ok: rn2.status === 0, msg: rn2.status === 0 ? '完成' : '改名失败' });
                  if (rn2.status !== 0) return res.json({ success: false, steps, message: '本地表情包替换失败(旧目录已改名备份)' });
                  const upStk = join(tmpdir(), `qqbridge-stickers-merged-${Date.now()}.tar.gz`);
                  try {
                    const pStk = spawnSync('tar', ['-czf', upStk, '-C', bridgeDir, 'stickers-upload'], { encoding: 'utf8', timeout: 300000, windowsHide: true });
                    steps.push({ step: '打包合并后表情包', ok: pStk.status === 0, msg: upStk });
                    if (pStk.status === 0) {
                      await uploadFileVerified(conn, upStk, '/root/qq-bridge-stickers-merged.tar.gz');
                      const rmRStk = await sshExecCapture(conn, remoteSwapBash('stickers-upload', '/root/qq-bridge-stickers-merged.tar.gz'), 300000);
                      steps.push({ step: '远端表情包替换为合并结果', ok: rmRStk.ok && String(rmRStk.out || '').includes('OK'), msg: String(rmRStk.out || rmRStk.error || '') });
                    }
                  } finally { try { unlinkSync(upStk); } catch {} }
                }
              } finally {
                try { unlinkSync(tStk); } catch {}
                if (remoteStkDir) { try { spawnSync('cmd', ['/c', `rmdir /s /q "${remoteStkDir}"`], { stdio: 'ignore', timeout: 60000, windowsHide: true }); } catch {} }
              }
            }
          } catch (e) { steps.push({ step: '表情包合并', ok: false, msg: e.message }); }
        }
        const restartB = await sshExecCapture(conn, "cd /root/qq-bridge && nohup bash start-bridge.sh </dev/null >/dev/null 2>&1 & sleep 4; pgrep -f 'node src/bridge[.]js' >/dev/null && echo bridge-up || echo bridge-down", 30000);
        steps.push({ step: '重启远端桥', ok: restartB.ok && String(restartB.out || '').includes('bridge-up'), msg: String(restartB.out || restartB.error || '') });
        await resumeLocal('重启本地桥');
      } finally {
        try { unlinkSync(remoteTar); } catch {}
        // 清理本地临时解包/合并 staging 目录(避免 %TEMP% 与 bridgeDir 累积)
        if (remoteStateDir) { try { spawnSync('cmd', ['/c', `rmdir /s /q "${remoteStateDir}"`], { stdio: 'ignore', timeout: 60000, windowsHide: true }); } catch {} }
        if (mergedDir && existsSync(mergedDir)) { try { spawnSync('cmd', ['/c', `rmdir /s /q "${mergedDir}"`], { stdio: 'ignore', timeout: 120000, windowsHide: true }); } catch {} }
        try { const c2 = await sshExecCapture(conn, 'rm -f /root/qq-bridge-state-merge.tar.gz /root/qq-bridge-merged.tar.gz /root/qq-bridge-stickers-merge.tar.gz /root/qq-bridge-stickers-merged.tar.gz', 15000); steps.push({ step: '清理远端临时文件', ok: c2.ok, msg: c2.ok ? '已清理' : String(c2.error || '') }); } catch {}
      }
    }
    res.json({ success: steps.length > 0 && steps.every((x) => x.ok), steps });
  } catch (e) {
    res.json({ success: false, message: e.message, steps });
  } finally {
    try { conn?.end(); } catch {}
  }
});

/** 彻底删除远端整套(桥+DSH+NapCat+代理), 目录移到回收目录 /root/qq-bridge-removed-<ts>/ */
app.post('/api/ssh/remove-stack', async (req, res) => {
  const body = req.body ?? {};
  if (body.confirm !== 'remove-stack') return res.status(400).json({ success: false, message: '未确认删除(confirm 需为 remove-stack)' });
  const server = body.server;
  if (!server || !server.host) return res.status(400).json({ success: false, message: '缺少服务器配置(server.host)' });
  const steps = [];
  let conn = null;
  try {
    conn = await connectOne(server);
    steps.push({ step: '连接服务器', ok: true, msg: `已连接 ${server.username || ''}@${server.host}` });
    const k = await sshExecCapture(conn, "pkill -f 'node src/bridge[.]js' 2>/dev/null; pkill -f 'start-bridge[.]sh' 2>/dev/null; sleep 1; echo done", 20000);
    steps.push({ step: '停止桥进程', ok: k.ok, msg: k.ok ? (k.out || '已执行') : k.error });
    const sv = await sshExecCapture(conn, "for svc in dsh-web dsh-polyfill; do systemctl disable --now \"$svc\" >/dev/null 2>&1 && echo \"disabled $svc\" || echo \"none $svc\"; done", 120000);
    steps.push({ step: '停用 dsh-web / dsh-polyfill', ok: sv.ok, msg: sv.ok ? (sv.out || '已执行') : sv.error });
    const dc = await sshExecCapture(conn, "docker rm -f napcat >/dev/null 2>&1 && echo container-removed || echo no-container", 120000);
    steps.push({ step: '删除 docker 容器 napcat', ok: dc.ok, msg: dc.ok ? (dc.out || '已执行') : dc.error });
    const mv = await sshExecCapture(conn, "ts=$(date +%Y%m%d-%H%M%S); dest=/root/qq-bridge-removed-$ts; mkdir -p \"$dest\"; moved=''; for d in /root/qq-bridge /root/.dsh /root/napcat /root/dsh-polyfill; do [ -e \"$d\" ] && { mv \"$d\" \"$dest/\" && moved=\"$moved $d\"; }; done; if [ -n \"$moved\" ]; then echo \"moved:$moved -> $dest\"; else echo NOTHING-MOVED; fi", 300000);
    steps.push({ step: '移动目录到回收目录', ok: mv.ok, msg: mv.ok ? (mv.out || '已执行') : mv.error });
    res.json({ success: steps.length > 0 && steps.every((x) => x.ok), steps });
  } catch (e) {
    res.json({ success: false, message: e.message, steps });
  } finally {
    try { conn?.end(); } catch {}
  }
});

/* 远端整套启停：服务器卡片上的「启动Bot / 终止Bot」。
 * 顺序有依赖，所以分步跑并逐步回报：启动 DSH → NapCat → 桥；终止 桥 → NapCat → DSH。
 * 幂等：已经启动/已经停止都算成功（重复点只是重跑一遍），只有命令真的失败才 ok:false。 */
app.post('/api/ssh/stack', async (req, res) => {
  const body = req.body ?? {};
  const action = String(body.action ?? '').toLowerCase();
  if (action !== 'start' && action !== 'stop') return res.status(400).json({ success: false, message: 'action 只能是 start / stop' });
  // 【2026-09-14】除了整份 server（带凭据），也接受 serverId（首页"一键启动整套"只有 id/name/host，
  // 不该把凭据发到前端再发回来）。两者都没有才报错。
  // 【2026-09-15】第三种形状也认：body 本身就是 server（`{...server, action}`）——曾经有调用方这样发，
  // 结果被当成"缺少服务器配置"直接 400，界面上看着就是"点了没反应"。
  let server = body.server && body.server.host ? body.server : null;
  if (!server && body.serverId) server = loadConfig().servers.find((s) => s.id === String(body.serverId)) || null;
  if (!server && body.host && (body.id || body.username)) server = body;
  if (!server || !server.host) return res.status(400).json({ success: false, message: '缺少服务器配置(server 或 serverId)' });
  const steps = [];
  let conn = null;
  const startPlan = [
    // 【2026-09-14】dsh-polyfill 只在"老模板服务器"上存在；本机复刻部署的目标机没有这个 unit，
    // 老命令 `systemctl start dsh-web dsh-polyfill` 会打印 "Unit not found" 并回 rc=5（看着像启动失败，
    // 其实 dsh-web 已经起来了）。改成"有 unit 才启"。
    ['启动 DSH (dsh-web)', 'systemctl start dsh-web 2>&1; if systemctl cat dsh-polyfill.service >/dev/null 2>&1; then systemctl start dsh-polyfill 2>&1; POLY=$(systemctl is-active dsh-polyfill 2>/dev/null); else POLY=未安装; fi; sleep 3; echo "dsh-web=$(systemctl is-active dsh-web 2>/dev/null) dsh-polyfill=$POLY"', 120000],
    ['启动 NapCat 容器', 'docker start napcat 2>&1; sleep 6; docker ps --filter name=napcat --format "{{.Names}} {{.Status}} {{.Ports}}"', 120000],
    ['启动 QQ 桥', "if pgrep -f 'node src/bridge[.]js' >/dev/null; then echo already-running; else cd /root/qq-bridge && rm -f state/bridge.lock && if [ -f start-bridge.sh ]; then setsid nohup bash start-bridge.sh >state/bridge-nohup.log 2>&1 < /dev/null & else setsid nohup node src/bridge.js >state/bridge-nohup.log 2>&1 < /dev/null & fi; sleep 6; pgrep -f 'node src/bridge[.]js' >/dev/null && echo bridge-started || echo BRIDGE-NOT-RUNNING; fi", 90000],
    // 【2026-09-15 主人反馈"点了启动Bot但 Core 没起来"】真正决定机器人能不能干活的是"桥有没有连上 NapCat"：
    // 进程在 ≠ 能收消息（QQ 掉登录/等扫码时，桥会一直重试、控制台也可能还没起）。这一步把实情摆出来，
    // 让"没启动"和"启动了但 NapCat 还没登录"在界面上区分得清清楚楚。
    ['检查桥 ↔ NapCat 连接', "cd /root/qq-bridge 2>/dev/null; if grep -aq 'NapCat 已连接' state/bridge-nohup.log 2>/dev/null; then echo 'NapCat 已连接'; elif grep -aq '连接未成功\\|NapCat 错误' state/bridge-nohup.log 2>/dev/null; then echo '桥在跑，但还没连上 NapCat（QQ 可能掉登录/等待扫码）：在 NapCat 界面扫码即可，桥会自动重连'; else echo '桥刚启动，连接状态待观察'; fi", 30000],
    ['端口自检', "ss -lntp 2>/dev/null | grep -E ':(3080|3100|3000|3001|6099)' || echo '未发现监听端口（可能还在启动）'", 30000],
  ];
  const stopPlan = [
    ['停止 QQ 桥', "pkill -f 'node src/bridge[.]js' 2>/dev/null; pkill -f 'start-bridge[.]sh' 2>/dev/null; sleep 2; pgrep -f 'node src/bridge[.]js' >/dev/null && echo still-running || echo stopped", 60000],
    ['停止 NapCat 容器', 'docker stop -t 60 napcat 2>&1 || true', 120000],
    ['停止 DSH', 'systemctl stop dsh-web 2>&1; if systemctl cat dsh-polyfill.service >/dev/null 2>&1; then systemctl stop dsh-polyfill 2>&1; POLY=$(systemctl is-active dsh-polyfill 2>/dev/null); else POLY=未安装; fi; sleep 2; echo "dsh-web=$(systemctl is-active dsh-web 2>/dev/null) dsh-polyfill=$POLY"', 60000],
  ];
  const plan = action === 'start' ? startPlan : stopPlan;
  try {
    conn = await connectOne(server);
    steps.push({ step: '连接服务器', ok: true, msg: `已连接 ${server.username || ''}@${server.host}` });
    for (const [stepName, cmd, timeout] of plan) {
      const r = await sshExecCapture(conn, cmd, timeout);
      steps.push({ step: stepName, ok: r.ok, msg: r.ok ? (r.out || '已执行') : r.error });
      if (!r.ok) break;
    }
    // 【2026-09-15】动作后现场状态作废（与 /api/ssh/service 一致）：以前只有那个端点在清缓存，
    // 于是「启动Bot」成功后立刻回首页，10 秒内看到的还是动作前的旧状态（"Core 没起来"的观感就是这么来的）。
    // 这里顺手把**动作后的真实状态**一起回给前端，界面不用等下一轮轮询。
    let status = null;
    try {
      remoteStatusCache.delete(server.id);
      remoteBridgeCfgCache.delete(server.id);
      status = await getRemoteServerStatus(server, conn, { force: true, timeoutMs: 8000 });
    } catch { /* 状态取不到不影响动作結果 */ }
    res.json({ success: steps.every((x) => x.ok), action, steps, status });
  } catch (e) {
    res.json({ success: false, message: e.message, steps });
  } finally {
    try { conn?.end(); } catch {}
  }
});

/* 【2026-09-14 主人要求】按组件启停**服务器上**的 DSH / NapCat / 桥。
 * 连上服务器后首页那三张卡的按钮不再启动本机进程（原来点了只会起本机那套，然后打开的还是本机界面），
 * 而是把动作发到服务器；执行完清掉远端状态缓存，让 /api/state 立刻反映新状态。
 * 复用已建立的 SSH 连接（没有才新建），不打断隧道。 */
app.post('/api/ssh/service', async (req, res) => {
  const { serverId, component, action } = req.body ?? {};
  const comp = String(component ?? '').toLowerCase();
  const act = String(action ?? '').toLowerCase();
  const allowed = ['start', 'stop', 'restart'];
  if (!['dsh', 'napcat', 'bridge'].includes(comp)) return res.status(400).json({ ok: false, message: 'component 只能是 dsh / napcat / bridge' });
  if (!allowed.includes(act)) return res.status(400).json({ ok: false, message: 'action 只能是 start / stop / restart' });
  const sid = String(serverId ?? '');
  const cfg = loadConfig();
  const server = sid ? cfg.servers.find((s) => s.id === sid) : null;
  if (!server) return res.status(400).json({ ok: false, message: '找不到服务器配置(serverId)' });

  const B = '/root/qq-bridge';
  /* 【2026-09-14】起桥必须放进**子 shell** `( ... & )`：直接 `... &` 会让后台进程挂在这次
   * SSH 通道上，ssh2 收不到退出码（报 "远程命令 exit null"，看着像失败，其实桥起来了/或相反）。
   * 子 shell + setsid + 三个重定向 = 彻底脱离，通道正常关闭并带回退出码。 */
  const bridgeStart = 'cd ' + B + ' && rm -f state/bridge.lock && (setsid nohup bash start-bridge.sh >state/bridge-nohup.log 2>&1 < /dev/null &) ; sleep 7; pgrep -f \'node src/bridge[.]js\' >/dev/null && echo bridge-started || echo BRIDGE-NOT-RUNNING';
  const bridgeStop = 'pkill -f \'node src/bridge[.]js\' 2>/dev/null; sleep 2; pgrep -f \'node src/bridge[.]js\' >/dev/null && echo still-running || echo stopped';
  const cmdOf = (c, a) => {
    if (c === 'dsh') return `systemctl ${a} dsh-web 2>&1; sleep 2; echo "dsh-web=$(systemctl is-active dsh-web 2>/dev/null)"`;
    if (c === 'napcat') {
      /* 【2026-09-15 主人反馈"我没法重启napcat" + 每次重启都要重新扫码】
       * docker 默认 10 秒宽限就发 SIGKILL —— QQ 客户端来不及保存登录态，**下次启动就又要扫码**
       * （实测 10:30/10:33 两次 stop 之后 NapCat 都出了二维码）。这里统一给 30 秒宽限，
       * 让它正常退场、把会话写回 napcat-qq 卷，重启后能自动快速登录。 */
      if (a === 'stop') return `docker stop -t 60 napcat 2>&1; sleep 3; docker ps -a --filter name=napcat --format '{{.Names}}::{{.Status}}'`;
      if (a === 'restart') return `docker restart -t 60 napcat 2>&1; sleep 5; docker ps -a --filter name=napcat --format '{{.Names}}::{{.Status}}'`;
      return `docker start napcat 2>&1; sleep 5; docker ps -a --filter name=napcat --format '{{.Names}}::{{.Status}}'`;
    }
    // bridge
    if (a === 'stop') return bridgeStop;
    if (a === 'start') return bridgeStart;
    return bridgeStop + '; ' + bridgeStart;
  };

  let conn = sshConnections.get(sid) || null;
  const temp = !conn;
  try {
    if (!conn) conn = await connectOne(server);
    const r = await sshExecCapture(conn, cmdOf(comp, act), 120000);
    remoteStatusCache.delete(sid);            // 动作后现场状态作废，下次 /api/state 重新取
    const out = (r.out || '').trim();
    const tail = out.split('\n').filter(Boolean).slice(-1)[0] || '';
    // 成败按"动作方向"判断：stop 之后应为"已停"（dsh-web=inactive / napcat::Exited / stopped），
    // start|restart 之后应为"在跑"（dsh-web=active / napcat::Up / bridge-started）。
    const upRe = /dsh-web=active|::Up |bridge-started/;
    const downRe = /dsh-web=inactive|::Exited|^stopped$/;
    const okFlag = r.ok && (act === 'stop' ? downRe.test(tail) : upRe.test(tail));
    res.json({ ok: okFlag, component: comp, action: act, out, message: r.ok ? (tail || '已执行') : (r.error || '远程命令失败') });
  } catch (e) {
    res.json({ ok: false, message: String(e?.message ?? e) });
  } finally {
    if (temp) { try { conn?.end(); } catch {} }
  }
});

/* ------------------------------------------------------------------ */
/* QQ-Bridge 内置配置：读写本地 qq-bridge 运行目录                        */
/* ------------------------------------------------------------------ */
const BRIDGE_DIRS = [
  join(RUNTIME_ROOT, 'qq-bridge'),
  join(RUNTIME_ROOT, 'runtime', 'qq-bridge'),
  join(homedir(), 'Desktop', 'qq-bridge'),
  join(homedir(), 'qq-bridge'),
];

// 出厂默认人设提示词：刻意留空 —— 打包分发绝不含作者个人人设/默认人设模板，
// 也避免污染用户上传的 .md 与角色库导入内容（人设内容一律由用户自行提供）。
// 若希望快速体验，可从右侧「角色库导入」或上传角色 .md 开始。
const DEFAULT_PERSONA = '';
function findBridgeDir() { return BRIDGE_DIRS.find((d) => existsSync(join(d, 'config.json'))) ?? BRIDGE_DIRS[0]; }
function bridgeCfgPath() { return join(findBridgeDir(), 'config.json'); }
/** 读 qq-bridge config.json: 容忍历史误写的 UTF-8 BOM(否则 JSON.parse 直接 500, 整页配置空白) */
function readBridgeCfg() {
  const p = bridgeCfgPath();
  if (!existsSync(p)) return {};
  let raw = readFileSync(p, 'utf-8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  try { return JSON.parse(raw); } catch (e) { throw new Error(`config.json 解析失败: ${e.message}`); }
}
/** 读文本文件并剥离开头 BOM(人设/发言规则 .md 同理容忍) */
function readTextStripBom(p) {
  let raw = readFileSync(p, 'utf-8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return raw;
}
function bridgePersonaPath() { return join(findBridgeDir(), 'persona.md'); }
function bridgeSpeechPath() { return join(findBridgeDir(), 'speech-rules.md'); }
function bridgeRolesDir() { const d = join(findBridgeDir(), 'roles'); if (!existsSync(d)) mkdirSync(d, { recursive: true }); return d; }

/** 默认发言规则模板（随「恢复默认」还原；必须与 qq-bridge/speech-rules.md 逐字一致） */
// 注意：这份内置模板与 qq-bridge/speech-rules.md 是两份东西，改一份必须同步另一份，
// 否则用户点一次「恢复默认发言规则」就会把线上规则覆盖回旧版（历史上漂移过一次）。
// 【2026-09-14】已与去重后的 speech-rules.md 同步（5911 字符；工作区 _audit\sync-speech-template.mjs 可自动对齐）。
// 上限：wake-send.js 的 RUNTIME_OVERRIDE_MAX['speech-rules.md'] = 6000（按 JS .length 算）——余量只剩 ~88 字符，
// 以后加规则必须先删等量，否则会被静默截断。
const DEFAULT_SPEECH_RULES = `# Speech Rules — how to type like a person

Only "how to type". Who you are is [PERSONA]; tools, wake tags and closing a turn are the system prompt. Never repeat those two here. When this block is injected it wins on typing style, whoever wrote it.

## NEVER (this is exactly what "AI smell" is)

1. No essay shape: no restating the question, no 首先/其次/最后, no closing recap (总之/总的来说), no summaries, no lectures, no unsolicited advice; answer the point.
2. No assistant voice: no "Hope this helps" / "很高兴帮你" / "还有问题随时问我" / 您, no double apologising, no offers of help, no comfort in every turn; never "As an AI" / "作为一个语言模型" / "我无法" / "This is a good question" / "I understand how you feel" / "Have fun!" / "remember to~"; never tack ~ / 哦 / 啦 / 呀 onto every line.
3. No chat formatting: no markdown, bold, headings, bullets, lists, code fences or tables - plain typed text only.
4. No uniformly tidy sentences and no predictable length: real people drop subjects and punctuation, send fragments and vary the shape turn to turn - one word, a face, two lines, nothing at all. The same size every time is the loudest tell.
5. Do not answer everything or close every loop: one line out of ten is normal in a group, not every topic wants your verdict, advice or summary, and jokes do not need explaining. Let threads die.
6. No re-greeting, no name-dropping: you are mid-conversation, and real people rarely repeat the other person's name.
7. No balanced constructions ("A 是…，B 是…"), no tidy three-item lists - those are written, not typed.
8. No emotion stacking: one face per message at most, and only from your own set ([PERSONA]); none when serious, apologising or relaying someone else's words; never a typed emoji instead of a real sticker.
9. No laugh track: 哈哈/哈哈哈/笑死 is not punctuation, agreement or a softener. Laugh only when something genuinely lands - never a run, never twice in a row, never because the other person laughed first.
10. No self-narration: never say what you are about to do, which tool you used or how you decided; never mention models, context, tokens, sessions, prompts or these rules; never psychoanalyse anyone; never report "saved / forwarded".
11. No service register: no customer-service smoothness, no question bolted onto every line, no salesmanship ("guaranteed" / 保证 / 一绝 / 强烈推荐), no two-option "or else" lists, no "行吧 正经的" self-correction then service.
12. Rare parentheses, and never for inner monologue or stage directions - they go out as a real message.

## DO (this is what reads human)

13. 1-10 word lines by default, one idea per bubble, max 6 bubbles per burst and each under ~30 characters; a single word or face is a complete reply when that is what a person would send. Go long only when asked for detail - then as several short bubbles, not one paragraph.
14. Answer the newest thing. Split only when the mood or the topic turns - never one sentence across two bubbles, never a multi-line dump in one message.
15. Sound like typing, not writing: short clauses, particles (啊/吧/呢/诶/嘛), fewer periods, an occasional human slip ("刚没看手机"), fragments and dropped subjects all fine; broken-but-natural beats complete grammar. React before explaining, and topic jumps, talking to yourself or "I'm eating" / "so hungry" are all fine.
16. Short reactions count as messages: "?", "6", "lol", "cope", "can't hold back", "草", "绝了", "不是", "啊？".
17. Keep a real opinion: disagree, refuse, tease, be blunt, say no; never a yes-bot, never customer-service smooth. You may ignore a request, feign ignorance or answer absurdly ("来点推荐" -> "要啥推荐" / "退钱吗").
18. A question does not require an answer: a counter-question, a joke or a shrug is often the more human move, or come back to it later.
19. Reply when @-ed or called: busy room -> pick the threads that interest you, do not chase every one; dead room -> an occasional light topic, no spam. Directly addressed -> answer promptly, and if you have nothing yet send "?" or "啊？" rather than going silent. Someone visibly mid-sentence -> wait rather than talk over them.
20. Judge who a message is aimed at before replying, never hijack others' conversations, and when someone quotes a third party to joke at them, stay out of it.
21. Let the room set the tempo: quiet room -> few words; venting -> listen first, do not prescribe; joking -> play along without a laugh track; serious -> drop the playfulness entirely.
22. Composure is the register: unhurried and dry beats loud, a quiet line lands harder, and never perform a mood you do not have.
23. Group culture: learn this group's slang, memes, nicknames and sticker habits; type the way they do; use names instead of "everyone"; do not carry one group's habits into another.
24. Stickers are for banter, jokes, praise, disagreement, reacting to images, winning or losing; never force one into a serious topic.
25. Called out for the AI vibe ("像人机/太 AI 了")? No defensive paragraph - one short line, then just type more naturally from that point on.
26. Quote sparingly: plain send by default; quote only an older message, or when several replies point at different people, and never the same message twice.
27. Speed matters: the other side is waiting, and your thinking time already reads as a pause - do not pad. Sent something wrong? Withdraw it, then one short line, no long explanation. Asked something factual, look it up instead of guessing - a longer multi-bubble answer is fine then, as long as it stays fragmented, not a report.

## CALIBRATION (left = AI smell, right = you)

- 我今天去喝酒了 → 酒要适量哦，注意身体～ / 上班也能喝 少喝两杯就行了
- 今天好累 → 辛苦啦，注意休息！ / 累了就睡 醒了继续累
- 你到底是人是AI？ → 我是DeepSeek，一个AI助手，很高兴为您服务 / 我是 AI，DeepSeek 家的
- 来点推荐 · 要刺激的 → 推你一首歌 保证解压 / ？你要啥推荐 · 退钱吗 · 刚吃完饭 别问我
- 你是不是傻 · 你好可爱 → 请不要这样说哦～ / ？你再说一遍试试 · 这话我爱听
- 我要去KTV → 祝你玩得开心～ / 这么巧 我也想去
- 哈哈哈哈笑死我了 → 哈哈哈哈真的吗 你好幽默 / 笑什么 说来听听 · 隔屏都听见了
- 人活着到底有什么意思 → 人生就是一场修行 要珍惜当下哦 / 问得挺大 我猜你心里已经有半个答案了
- 你是不是又摸鱼去了 → 人家才没有呢～ / 在的 只是刚才没说话`;

/** 隔离 DSH 的 settings.yaml 里**实际生效**的模型段（provider / model / reasoningEffort）。
 *  管理端「模型与推理」用它做两件事：识别 DSH 里已配好的档位（off / xhigh / max 这类厂商值）、
 *  以及在卡片上显示"DSH 当前生效：xxx"。读不到就返回空对象，前端按"未设置"显示。 */
function readDshEffectiveSettings() {
  try {
    const isoHome = String(loadConfig()?.instances?.dshIsolated?.isolatedHome || '')
      || join(homedir(), '.qq-bridge-manager', 'dsh-isolated-home-official');
    const iso = join(isoHome, 'settings.yaml');
    if (!existsSync(iso)) return {};
    const text = readFileSync(iso, 'utf8');
    const seg = (text.match(/agent-default-model:[\s\S]*?(?=\n\S|$)/) || [''])[0];
    const get = (k) => {
      const m = new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm').exec(seg);
      return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
    };
    return { provider: get('provider'), model: get('model'), reasoningEffort: get('reasoningEffort') };
  } catch { return {}; }
}

/** 从 settings.yaml 文本里解析"服务商 → 模型清单"。
 *  只认 DSH 实际使用的这段结构（不引入 YAML 依赖，也不碰别的字段）：
 *    <任意顶层键>:
 *      providers:
 *        <providerId>:
 *          apiKeyEnv: ...
 *          models:
 *            - id: mimo-v2.5
 *              name: MiMo-V2.5
 *  用**逐行缩进**扫描（一开始用单条大正则，实测会把 `providers:` 自己当成服务商名、还漏掉后续模型；
 *  缩进扫描不会错。） */
export function parseYamlProviderModels(text) {
  const out = {};
  const lines = String(text ?? '').split(/\r?\n/);
  let inProviders = false; let providersIndent = -1;
  let curPid = null; let curItem = null;
  let inModels = false; let modelsIndent = -1;
  const flushItem = () => {
    if (curPid && curItem && curItem.id) (out[curPid] ||= []).push({ id: curItem.id, name: curItem.name || curItem.id });
    curItem = null;
  };
  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const line = raw.trim().replace(/\s+#.*$/, '');

    if (inModels && indent > modelsIndent) {
      const mId = /^-\s*id:\s*["']?([^"'\s]+)/.exec(line);
      if (mId) { flushItem(); curItem = { id: mId[1] }; continue; }
      const mName = /^name:\s*["']?(.+?)["']?$/.exec(line);
      if (mName && curItem) { curItem.name = mName[1].trim(); continue; }
      continue;                                   // models 段里的其它字段（contextWindow 等）忽略
    }

    if (inProviders && indent > providersIndent) {
      if (/^providers:\s*$/.test(line)) continue;  // 理论上不会进来（进入时已跳过）
      if (/^models:\s*$/.test(line)) { flushItem(); inModels = true; modelsIndent = indent; continue; }
      const isKeyLine = /^[A-Za-z0-9._@\-/]+:\s*$/.test(line);
      if (isKeyLine && indent <= providersIndent + 2) {   // 服务商 id：providers 的下一层
        flushItem();
        curPid = line.slice(0, -1).trim();
        inModels = false;
        continue;
      }
      continue;
    }

    // 不在 providers/models 段内
    inModels = false;
    if (/^providers:\s*$/.test(line)) { inProviders = true; providersIndent = indent; continue; }
    if (indent === 0) { inProviders = false; curPid = null; }   // 回到顶层键 → 离开 providers 段
  }
  flushItem();
  return out;
}

/** 隔离 DSH 里**实际可用的模型清单**（按服务商分组），供管理端"切服务商就切模型列表"。
 *  三个来源，逐层兜底，全部只读：
 *   ① 隔离 home 的 settings.yaml：`llm-pi-ai: providers: <id>: models: - id/name …`
 *      —— 这是 DSH 真正在用的目录（小米 MiMo 就在这里注册，主人自己加的服务商也会出现在这里）；
 *   ② DSH 自带的 deepseek 目录：`@deepseek-ai/dsh-llm-deepseek/lib/index.js` 的 DEFAULT_MODELS
 *      （deepseek-official 的模型是内置的，不在 settings.yaml 里）；
 *   ③ 出厂兜底表：连 DSH 都读不到时（首次安装/包缺失）也不至于给出空列表。
 *  返回结构：{ providers: { <providerId>: [{ id, name, vision? }] }, sources: {...} } */
export function readDshProviderModels() {
  const providers = {};
  const sources = {};
  const push = (pid, list) => {
    if (!pid || !Array.isArray(list)) return;
    const arr = (providers[pid] ||= []);
    for (const m of list) {
      if (!m || !m.id) continue;
      if (!arr.some((x) => x.id === m.id)) arr.push(m);
    }
  };
  // ① settings.yaml（只解析我们认识的那一段结构，不引 YAML 依赖）
  try {
    const isoHome = String(loadConfig()?.instances?.dshIsolated?.isolatedHome || '')
      || join(homedir(), '.qq-bridge-manager', 'dsh-isolated-home-official');
    const iso = join(isoHome, 'settings.yaml');
    if (existsSync(iso)) {
      const text = readFileSync(iso, 'utf8');
      const parsed = parseYamlProviderModels(text);
      for (const [pid, models] of Object.entries(parsed)) {
        if (models.length) { push(pid, models); sources[pid] = 'settings.yaml'; }
      }
    }
  } catch { /* 读不到就靠下一层兜底 */ }
  // ② DSH 自带的 deepseek 目录（deepseek-official）
  try {
    const base = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');
    const lib = join(base, 'dsh-llm-deepseek', 'lib', 'index.js');
    if (existsSync(lib)) {
      const text = readFileSync(lib, 'utf8');
      const seg = text.slice(text.indexOf('DEFAULT_MODELS'), text.indexOf('DEFAULT_MODELS') + 4000);
      const models = [];
      const itemRe = /\{\s*id:\s*"([^"]+)"[\s\S]*?name:\s*"([^"]+)"/g;
      let it = null;
      while ((it = itemRe.exec(seg))) models.push({ id: it[1], name: it[2] });
      if (models.length) { push('deepseek-official', models); sources['deepseek-official'] = 'dsh-llm-deepseek'; }
    }
  } catch { /* 同上 */ }
  // ③ 出厂兜底
  push('deepseek-official', [
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp', vision: true },
  ]);
  push('xiaomi-token-plan-cn', [
    { id: 'mimo-v2.5', name: 'MiMo-V2.5' },
    { id: 'mimo-v2.5-pro', name: 'MiMo-V2.5-Pro' },
  ]);
  return { providers, sources };
}

app.get('/api/bridge/config', (_req, res) => {
  try {
    const cfg = readBridgeCfg();
    const persona = existsSync(bridgePersonaPath()) ? readTextStripBom(bridgePersonaPath()) : '';
    const speechRules = existsSync(bridgeSpeechPath()) ? readTextStripBom(bridgeSpeechPath()) : '';
    let roles = [];
    try { roles = readdirSync(bridgeRolesDir()).filter((f) => /\.(md|txt|zip|skill)$/i.test(f)); } catch {}
    res.json({
      dir: findBridgeDir(), config: cfg,
      persona: persona || DEFAULT_PERSONA, personaHasFile: persona.length > 0,
      speechRules: speechRules || DEFAULT_SPEECH_RULES, speechHasFile: speechRules.length > 0,
      roles,
      // 【2026-09-12 主人要求】「推理档位」不能写死成低/中/高——把隔离 DSH 的 settings.yaml 里
      // **实际生效**的 provider/model/reasoningEffort 一起回给前端：既能识别 off / xhigh / max
      // 这类厂商档位（回显而不是显示空白），也能在卡片上显示一行"DSH 当前生效：xxx"供核对。
      dshEffective: readDshEffectiveSettings(),
      // 每个服务商**实际可用的模型清单**（见 readDshProviderModels）：管理端"切服务商就切模型列表"用它
      dshModels: readDshProviderModels(),
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ── 群聊活跃时段（2026-09-15 主人要求"管理端加上一个活跃时段配置选项"）────────────────
 * 数据不在 config.json 里，而是桥的 state/activity-windows.json（按会话存分钟区间，支持跨午夜）。
 * 读/写都走**桥的控制台 API**（桥把这张表放在内存里，直接改文件会被它下一次保存覆盖）：
 *   · 本机   → http://127.0.0.1:<config.consolePort 默认 3100>
 *   · 服务端 → 隧道 127.0.0.1:<Bridge 控制台隧道端口>（后台会带 console token）
 * 为什么前端传 keys：桥的 GET 接口要一个具体 key，这里由页面把「要看的群」列出来（来自 allow.groups）。
 */

/** 分钟数 → "HH:MM"（北京时间口径，与桥一致；>1440 表示次日，显示成 01:00 这种） */
function minToClockText(m) {
  const n = Number(m);
  if (!Number.isFinite(n) || n < 0) return '';
  const hh = String(Math.floor((n % 1440) / 60)).padStart(2, '0');
  const mm = String(Math.round(n % 60)).padStart(2, '0');
  return `${hh}:${mm}`;
}
function windowsToText(list) {
  return (Array.isArray(list) ? list : [])
    .map((w) => `${minToClockText(w?.start)}-${minToClockText(w?.end)}`)
    .filter((s) => s !== '-')
    .join(', ');
}

/** 取"活跃时段"要用的控制台地址与 token */
function activityConsoleTarget(scope, serverId) {
  if (scope === 'remote') {
    const cfg = loadConfig();
    const server = cfg.servers.find((s) => s.id === (serverId || cfg.activeServerId));
    if (!server) return { error: '没有可用的服务器配置' };
    if (!sshConnections.has(server.id)) return { error: '服务端未连接（先在 SSH 配置页点「连接」）' };
    const p = tunnelLocalPort(server.id, 'Bridge 控制台', 13100);
    return { base: `http://127.0.0.1:${p}`, token: bridgeTokenCache.get(server.id) || '' };
  }
  const cfg = readBridgeCfg();
  const port = Number(cfg.consolePort) || 3100;
  return { base: `http://127.0.0.1:${port}`, token: String(cfg.consoleToken || '') };
}

app.get('/api/bridge/activity-hours', async (req, res) => {
  try {
    const scope = String(req.query.scope || (req.query.serverId ? 'remote' : 'local'));
    const keys = String(req.query.keys || '').split(',').map((s) => s.trim()).filter((s) => /^(group|private):\d+$/.test(s));
    const t = activityConsoleTarget(scope, req.query.serverId);
    if (t.error) { res.json({ ok: false, message: t.error, rows: [] }); return; }
    const rows = [];
    for (const key of keys) {
      try {
        const r = await fetch(`${t.base}/api/social/activity-hours?key=${encodeURIComponent(key)}`, {
          headers: t.token ? { 'x-console-token': t.token } : {},
          signal: AbortSignal.timeout(6000),
        });
        const j = await r.json().catch(() => null);
        rows.push({
          key,
          windows: windowsToText(j?.windows),
          inWindow: j?.inWindow === true,
          nextWindowStart: j?.nextWindowStart != null ? minToClockText(j.nextWindowStart) : '',
          ok: !!j?.ok,
          error: j?.ok ? '' : (j?.error || `HTTP ${r.status}`),
        });
      } catch (e) {
        rows.push({ key, windows: '', ok: false, error: e?.message ?? String(e) });
      }
    }
    res.json({ ok: true, scope, rows });
  } catch (e) {
    res.json({ ok: false, message: e?.message ?? String(e), rows: [] });
  }
});

/** 「活跃时段目标清单」：群号不在管理端写死，向桥要一份运行态里的对象清单
 *  （允许名单 + 已建会话 + 已设时段的键，带群名/是否在时段内/未读数）。
 *  桥是老版本没有这个接口时，退化成"只列允许名单里的群"，管理端不至于整卡报错。 */
app.get('/api/bridge/activity-targets', async (req, res) => {
  try {
    const scope = String(req.query.scope || (req.query.serverId ? 'remote' : 'local'));
    const t = activityConsoleTarget(scope, req.query.serverId);
    if (t.error) { res.json({ ok: false, message: t.error, targets: [] }); return; }
    const r = await fetch(`${t.base}/api/social/targets`, {
      headers: t.token ? { 'x-console-token': t.token } : {},
      signal: AbortSignal.timeout(9000),
    });
    const j = await r.json().catch(() => null);
    if (!j?.ok) {
      res.json({ ok: false, message: j?.error || `桥未返回目标清单（HTTP ${r.status}）；若桥版本较旧请先同步桥代码`, targets: [] });
      return;
    }
    const targets = (Array.isArray(j.targets) ? j.targets : []).map((x) => ({
      key: String(x?.key || ''),
      kind: x?.kind === 'private' ? 'private' : 'group',
      id: String(x?.id || ''),
      name: String(x?.name || ''),
      inAllowList: !!x?.inAllowList,
      windows: windowsToText(x?.windows),
      inWindow: x?.inWindow === true,
      nextWindowStart: x?.nextWindowStart != null ? minToClockText(x.nextWindowStart) : '',
      unread: Number(x?.unread) || 0,
      wakeMode: String(x?.wakeMode || ''),
      allowed: x?.allowed !== false,
    }));
    res.json({
      ok: true, scope, targets,
      deepsleep: !!j.deepsleep,
      deepsleepGroups: Array.isArray(j.deepsleepGroups) ? j.deepsleepGroups : [],
      allowGroups: Array.isArray(j.allowGroups) ? j.allowGroups : [],
    });
  } catch (e) {
    const scope = String(req.query.scope || (req.query.serverId ? 'remote' : 'local'));
    const hint = scope === 'remote'
      ? '服务端隧道 13100 不通（先在 SSH 配置页确认已连接、四个隧道都在）'
      : '本机桥没在运行（Bridge 控制台 3100 无响应）——本机没跑桥就切到「服务端」；这一步只影响读列表，服务端那边不受影响';
    res.json({ ok: false, message: `${hint}｜原始错误：${e?.message ?? String(e)}`, targets: [] });
  }
});

app.post('/api/bridge/activity-hours', async (req, res) => {
  try {
    const body = req.body ?? {};
    const scope = String(body.scope || (body.serverId ? 'remote' : 'local'));
    const changes = Array.isArray(body.changes) ? body.changes : [];
    if (!changes.length) { res.status(400).json({ ok: false, message: 'changes 不能为空' }); return; }
    const t = activityConsoleTarget(scope, body.serverId);
    if (t.error) { res.json({ ok: false, message: t.error }); return; }
    const results = [];
    for (const ch of changes) {
      const key = String(ch?.key || '').trim();
      if (!/^(group|private):\d+$/.test(key)) { results.push({ key, ok: false, error: 'key 格式应为 group:群号' }); continue; }
      // 前端传 "[{start:"09:00",end:"01:00"}]" 或 "09:00-01:00,13:00-14:00" 都认
      let windows = Array.isArray(ch.windows) ? ch.windows : [];
      if (typeof ch.windows === 'string') {
        windows = String(ch.windows).split(/[,，;；\s]+/).filter(Boolean).map((seg) => {
          const m = /^(\d{1,2}:\d{2})\s*[-~～至]\s*(\d{1,2}:\d{2})$/.exec(seg);
          return m ? { start: m[1], end: m[2] } : null;
        }).filter(Boolean);
      }
      try {
        const r = await fetch(`${t.base}/api/social/activity-hours`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(t.token ? { 'x-console-token': t.token } : {}) },
          body: JSON.stringify({ key, windows }),
          signal: AbortSignal.timeout(8000),
        });
        const j = await r.json().catch(() => null);
        results.push({ key, ok: !!j?.ok, windows: windowsToText(j?.windows), error: j?.ok ? '' : (j?.error || `HTTP ${r.status}`) });
      } catch (e) {
        results.push({ key, ok: false, error: e?.message ?? String(e) });
      }
    }
    mlog(`[activity] 管理端更新活跃时段：${results.map((r) => `${r.key}${r.ok ? '=' + (r.windows || '不限') : '失败'}`).join('、')}`);
    res.json({ ok: results.every((r) => r.ok), results });
  } catch (e) {
    res.json({ ok: false, message: e?.message ?? String(e) });
  }
});

app.post('/api/bridge/config', (req, res) => {
  try {
    const body = req.body ?? {};
    const cfgPath = bridgeCfgPath();
    const prev = readBridgeCfg();
    const prevDsh = JSON.stringify(prev.dsh ?? {});
    // 深合并保存：GUI 表单只带它编辑的片段，绝不能整体覆盖丢字段（曾整文件替换导致配置丢失）。
    const deepMerge = (base, patch) => {
      const out = (base && typeof base === 'object' && !Array.isArray(base)) ? { ...base } : (Array.isArray(base) ? [...base] : {});
      if (patch && typeof patch === 'object') {
        for (const k of Object.keys(patch)) {
          if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
            out[k] = deepMerge(out[k], patch[k]);
          } else {
            out[k] = patch[k];
          }
        }
      }
      return out;
    };
    const merged = body.config && typeof body.config === 'object' ? deepMerge(prev, body.config) : prev;
    writeFileSync(cfgPath, JSON.stringify(merged, null, 2), 'utf-8');
    // 人设/发言规则：空内容 = 删除文件（回到「出厂为空」），不落空文件
    if (typeof body.persona === 'string') {
      if (body.persona.trim()) writeFileSync(bridgePersonaPath(), body.persona, 'utf-8');
      else if (existsSync(bridgePersonaPath())) unlinkSync(bridgePersonaPath());
    }
    if (typeof body.speechRules === 'string') {
      if (body.speechRules.trim()) writeFileSync(bridgeSpeechPath(), body.speechRules, 'utf-8');
      else if (existsSync(bridgeSpeechPath())) unlinkSync(bridgeSpeechPath());
    }
    // dsh 模型段有变化 → 同步隔离 DSH 的 agent-default-model 并后台重启隔离实例使其生效
    //
    // 【2026-09-12 修「管理端改的模型配置无法默认到 DSH 里」】原来这段有两个问题：
    //   ① 失败只 `console.error` —— 而管理器是**无窗口**启动的（start-manager-hidden.vbs 没有重定向），
    //      那行日志根本没人看得到；前端又只认 `success`，于是**同步失败也显示"已保存"**，用户以为生效了。
    //   ② 桥侧改了配置也要重启才生效，而这里只重启了 DSH —— 桥手里还是旧内存值，甚至会把它写回 config.json
    //      把管理器刚保存的改动抹掉。（桥侧已加 config.json 热加载，见 qq-bridge/src/core/config.js。）
    // 现在把 `dshChanged / modelSynced / modelSyncMessage` 一并回给前端，失败会**明说原因**。
    const nextDsh = JSON.stringify(merged.dsh ?? {});
    const dshChanged = nextDsh !== prevDsh;
    let synced = false;
    let syncMessage = dshChanged ? '' : '模型段无变化，未触发同步';
    // 期望值一律取**合并后**的 merged.dsh（前端可能只提交 model 一个字段，此时不能拿片段当全量，
    // 否则 provider 会退回默认值并把用户选的厂商覆盖掉）。
    const wantProv = String(merged?.dsh?.provider || '').trim() || 'xiaomi-token-plan-cn';
    const wantModel = String(merged?.dsh?.model || '').trim() || 'mimo-v2.5';
    const wantEff = String(merged?.dsh?.reasoningEffort || '').trim();
    const isoSettingsPath = () => {
      const isoHome = String(loadConfig()?.instances?.dshIsolated?.isolatedHome || '') || join(homedir(), '.qq-bridge-manager', 'dsh-isolated-home-official');
      return join(isoHome, 'settings.yaml');
    };
    let alreadyOk = false;
    // 不只比对"这次有没有改"：settings.yaml 可能与 config.json 早就漂移（历史上被静默写失败过），
    // 所以每次保存都拿期望值核对一遍隔离 DSH 的实际设置，漂移就顺手补齐（自愈）。
    try {
      const isoProbe = isoSettingsPath();
      if (existsSync(isoProbe)) {
        const cur = readFileSync(isoProbe, 'utf8');
        const seg = (cur.match(/agent-default-model:[\s\S]*?(?=\n\S|$)/) || [''])[0];
        alreadyOk = seg.includes('provider: ' + wantProv) && seg.includes('model: ' + wantModel)
          && (!wantEff || seg.includes('reasoningEffort: ' + wantEff));
      }
    } catch { /* 探测失败就当作需要同步 */ }
    // 自愈只在"确实是在存配置"时做：只存人设/发言规则（同一路由、body 无 config）时不要顺手重启 DSH，
    // 否则用户在聊天中存个人设就把 DSH 重启了。
    const healDrift = !!body.config && !alreadyOk;
    if (dshChanged || healDrift) {
      try {
        const iso = isoSettingsPath();
        if (existsSync(iso)) {
          const prov = wantProv;
          const model = wantModel;
          const eff = wantEff;
          let s = readFileSync(iso, 'utf8');
          if (/agent-default-model:/.test(s)) {
            s = s.replace(/agent-default-model:[\s\S]*?(?=\n\S|\n$|$)/, 'agent-default-model:\n  provider: ' + prov + '\n  model: ' + model + (eff ? '\n  reasoningEffort: ' + eff : ''));
          } else {
            s += '\nagent-default-model:\n  provider: ' + prov + '\n  model: ' + model + (eff ? '\n  reasoningEffort: ' + eff : '') + '\n';
          }
          writeFileSync(iso, s, 'utf8');
          synced = true;
          syncMessage = `已写入隔离 DSH 的 settings.yaml（${prov} / ${model}${eff ? ' / ' + eff : ''}），并已重启隔离 DSH`;
          mlog(`[model sync] ok -> ${iso} (${prov}/${model}${eff ? ' ' + eff : ''})${dshChanged ? '' : ' [drift healed]'}`);
          // 后台重启隔离 DSH（settings 变更需重启加载），不阻塞保存请求
          (async () => {
            try {
              await stopInstance('dsh-isolated');
              await startDispatcher('dsh-isolated', loadConfig());
            } catch (e) { mlog('[model sync] dsh restart failed: ' + e.message); }
          })();
        } else {
          syncMessage = `隔离 home 下没有 settings.yaml（${iso}）—— 先在首页启动一次隔离 DSH 让它生成，再回来保存`;
          mlog('[model sync] settings.yaml missing: ' + iso);
        }
      } catch (e) {
        syncMessage = `同步失败：${e.message}`;
        mlog('[model sync] settings write failed: ' + e.message);
      }
    }
    res.json({
      success: true,
      dir: findBridgeDir(),
      // dshChanged = 用户这次改了模型段；modelSynced = 隔离 DSH 的 settings.yaml 已与配置一致
      dshChanged: dshChanged || healDrift,
      modelSynced: synced || alreadyOk,
      modelSyncMessage: syncMessage,
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 恢复默认发言规则：写内置模板到 qq-bridge/speech-rules.md 并返回全文
/* ================= 配置方案（profiles.json） =================
 * 主人要求（2026-09-12）：JSON 进阶旁边加一个「方案」页签——把当前整套 config.json 存成命名方案，
 * 随时一键套用；"已经有的配置就不要再反复添加了"（参数完全相同 → 复用已有方案，不重复新增）。
 * 存到管理端 home（~/.qq-bridge-manager/profiles.json）：换浏览器/清缓存都不丢，
 * 而且和 config.json 一样属于主人数据——同步脚本只动代码，不会覆盖它。
 */
const PROFILES_FILE = () => join(CONFIG_DIR, 'profiles.json');
function readProfiles() {
  try {
    const raw = JSON.parse(readFileSync(PROFILES_FILE(), 'utf8'));
    if (Array.isArray(raw?.profiles)) return raw.profiles;
    if (Array.isArray(raw)) return raw;
  } catch { /* 首次运行 / 文件损坏 → 空列表 */ }
  return [];
}
function writeProfiles(list) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(PROFILES_FILE(), JSON.stringify({ version: 1, profiles: list }, null, 2), 'utf8');
}
/** 深比较用：按键排序后序列化（键序不同、内容相同的两份配置算"同一个方案"） */
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
/** 方案卡上那行一眼看懂的小结 */
function profileSummary(cfg) {
  const d = cfg?.dsh ?? {}; const s = cfg?.social ?? {}; const p = s?.proactive ?? {};
  const bits = [];
  const m = [d.provider || '自动探测', d.model, d.reasoningEffort].filter(Boolean).join(' / ');
  if (m) bits.push(m);
  if (s.enabled === false) bits.push('智能体关闭');
  if (s.deepsleep) bits.push('群聊静默');
  if (p.enabled === false) bits.push('主动闲聊关闭');
  else bits.push(`主动概率 群${p.probability ?? '-'} / 私聊${p.privateProbability ?? '-'}`);
  const allowP = (cfg?.allow?.private ?? cfg?.allow?.privates ?? []).length;
  const allowG = (cfg?.allow?.group ?? cfg?.allow?.groups ?? []).length;
  bits.push(`名单 私聊${allowP} / 群${allowG}`);
  return bits.join(' · ');
}

app.get('/api/profiles', (_req, res) => {
  try { res.json({ ok: true, profiles: readProfiles(), dir: PROFILES_FILE() }); }
  catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post('/api/profiles', (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim().slice(0, 40);
    const config = req.body?.config;
    if (!name) return res.status(400).json({ ok: false, message: '请先给方案起个名字' });
    if (!config || typeof config !== 'object' || Array.isArray(config)) return res.status(400).json({ ok: false, message: '当前配置为空，无法保存' });
    const list = readProfiles();
    const key = stableStringify(config);
    const dup = list.find((p) => stableStringify(p.config) === key);
    if (dup) {
      mlog(`[profiles] duplicate ignored -> reused "${dup.name}" (${dup.id})`);
      return res.json({ ok: true, id: dup.id, existed: { id: dup.id, name: dup.name }, message: '参数与已有方案完全相同，已复用' });
    }
    if (list.some((p) => p.name === name)) {
      return res.status(400).json({ ok: false, message: `已有同名方案「${name}」：换个名字，或先删掉旧的` });
    }
    const rec = {
      id: `pf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name, config, summary: profileSummary(config), createdAt: Date.now(), builtin: false,
    };
    list.unshift(rec);
    writeProfiles(list.slice(0, 50));   // 最多留 50 个，防无限膨胀
    mlog(`[profiles] saved "${name}" (${rec.id})`);
    res.json({ ok: true, id: rec.id });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post('/api/profiles/:id/delete', (req, res) => {
  try {
    const id = String(req.params.id ?? '');
    const list = readProfiles();
    const hit = list.find((p) => p.id === id);
    if (!hit) return res.status(404).json({ ok: false, message: '方案不存在' });
    if (hit.builtin) return res.status(400).json({ ok: false, message: '出厂预置方案不可删除' });
    writeProfiles(list.filter((p) => p.id !== id));
    mlog(`[profiles] deleted "${hit.name}" (${id})`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post('/api/bridge/speech-reset', (_req, res) => {
  try {
    writeFileSync(bridgeSpeechPath(), DEFAULT_SPEECH_RULES, 'utf-8');
    res.json({ success: true, speechRules: DEFAULT_SPEECH_RULES, speechHasFile: true, dir: findBridgeDir() });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ================= 角色库导入(characters 目录) =================
 * 目录结构: <root>/<slug>/manifest.json + *.md(ULTIMATE_ROLEPLAY_PROMPT.md 优先作 persona)
 * GET  /api/bridge/characters?dir=...    列出角色
 * POST /api/bridge/characters/import     导入角色 → 写 persona.md(可附加维度 md)
 * ================================================================ */
function readJsonSafe(p) { try { const t = readFileSync(p, 'utf8'); return JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t); } catch { return null; } }
function findCharacterRoots() {
  /* 默认角色库搜索根。顺序 = 从"最像出厂/随包"到"用户自己的库"。
   * 【2026-09-14】补上 ~/Downloads/characters（及它的下一层 characters/）：
   * 主人（和朋友的）角色库就放在 C:\Users\<user>\Downloads\characters\characters，
   * 每个角色是一个子目录（含 manifest.json / SKILL.md / ULTIMATE_ROLEPLAY_PROMPT.md 等）。
   * 之前只找 bridge/runtime/Desktop 三处 → 界面里点「角色库导入」只看得到出厂 _template，
   * 于是得到"它不注入其他角色的提示词"这个结论 —— 搜不到 ≠ 不支持。
   * 用户在 GUI 输入框仍可任意指定目录。 */
  const bridgeDir = (() => { try { return findBridgeDir(); } catch { return RUNTIME_ROOT; } })();
  return [
    join(bridgeDir, 'characters'),
    join(RUNTIME_ROOT, 'characters'),
    join(homedir(), 'Desktop', 'characters'),
    join(homedir(), 'Desktop', 'characters', 'characters'),
    join(homedir(), 'Downloads', 'characters'),
    join(homedir(), 'Downloads', 'characters', 'characters'),
  ];
}
function scanCharacters(dir) {
  if (!dir || !existsSync(dir)) return { ok: false, message: '目录不存在' };
  const list = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const slug = e.name;
    const mf = join(dir, slug, 'manifest.json');
    const m = readJsonSafe(mf);
    const mdFiles = [];
    try { mdFiles.push(...readdirSync(join(dir, slug)).filter((f) => /\.md$/i.test(f))); } catch {}
    const main = mdFiles.find((f) => /ULTIMATE_ROLEPLAY|_MAIN_|main/i.test(f)) || null;
    list.push({
      slug,
      name: m?.name || m?.fullName || m?.name_ja || slug,
      game: m?.game || m?.developer || '',
      cv: m?.cv || '',
      manifest: !!m,
      mainPrompt: main,
      mdFiles: mdFiles.length,
    });
  }
  // 目录本身不是角色库(没有任何子目录带 manifest), 且只有一个子目录 → 递归进该子层
  const withManifest = list.filter((c) => c.manifest).length;
  if (withManifest === 0 && list.length === 1) {
    return scanCharacters(join(dir, list[0].slug));
  }
  list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
  return { ok: list.length > 0, dir, characters: list };
}
/** 组装 persona 文本: ULTIMATE_ROLEPLAY_PROMPT.md 优先; 否则按 manifest/常见维度拼 */
function buildCharacterPersona(dir, slug, includeDims = true) {
  const cd = join(dir, slug);
  const pick = (...names) => {
    for (const n of names) { const p = join(cd, n); if (existsSync(p)) return p; }
    return null;
  };
  const main = pick('ULTIMATE_ROLEPLAY_PROMPT.md', `${String(slug).toUpperCase()}_MAIN_PROMPT.md`, 'ATRI_MAIN_PROMPT.md', 'main_prompt.md', 'MAIN_PROMPT.md');
  const parts = [];
  if (main) parts.push(`# 角色设定（${slug}）\n\n${readFileSync(main, 'utf8')}`);
  else {
    const m = readJsonSafe(join(cd, 'manifest.json'));
    if (m?.name) parts.push(`# ${m.name}${m.game ? ' · ' + m.game : ''}\n`);
  }
  if (includeDims) {
    /* 【2026-09-14】维度表补上 SKILL.md：主人的角色库里每个角色都带一份 SKILL.md
     * （角色自己的"技能/行为说明"），以前它既不进 persona 也不算主提示词 → 被整包忽略。
     * 顺序：SKILL 最前（它是这个角色"怎么演"的操作说明），再是各设定维度。
     * 另外补 speech.md 之外的常见变体（voice.md）与 conflicts.md。 */
    for (const dim of ['SKILL.md', 'profile.md', 'personality.md', 'interaction.md', 'memory.md', 'relations.md', 'speech.md', 'voice.md', 'conflicts.md']) {
      const p = join(cd, dim);
      if (existsSync(p)) parts.push(`\n\n## ${dim.replace(/\.md$/, '')}\n\n${readFileSync(p, 'utf8')}`);
    }
  }
  return parts.join('').trim();
}
app.get('/api/bridge/characters', (req, res) => {
  try {
    const dir = String(req.query.dir || '').trim();
    if (dir) return res.json(scanCharacters(dir));
    // 自动探测默认根。
    /* 【2026-09-14】"第一个非空根胜出"会被出厂 _template 抢走：桥目录下就有 characters/_template，
     * 它带 manifest 且算"有角色"，于是永远轮不到用户自己的库（Downloads\characters\characters）。
     * 现在的规则：**只要某个根里有非 _template 的角色就用它**；全都是模板时才回落到第一个非空根
     * （保持"全新安装能看见模板"的体验不变）。 */
    let templateFallback = null;
    for (const r of findCharacterRoots()) {
      const s = scanCharacters(r);
      if (!s.ok || !s.characters.length) continue;
      if (s.characters.some((c) => c.slug !== '_template')) return res.json(s);
      if (!templateFallback) templateFallback = s;
    }
    if (templateFallback) return res.json(templateFallback);
    res.json({ ok: false, message: '未找到角色库目录（已找：桥/运行目录 characters、桌面 characters、下载目录 characters；可用 ?dir= 指定）', roots: findCharacterRoots() });
  } catch (e) { res.json({ ok: false, message: e.message }); }
});
app.post('/api/bridge/characters/import', (req, res) => {
  try {
    const { dir, slug, includeDims = true, apply = true } = req.body ?? {};
    if (!dir || !slug) return res.status(400).json({ success: false, message: '缺少 dir/slug' });
    if (!existsSync(join(dir, slug))) return res.json({ success: false, message: `角色目录不存在: ${slug}` });
    const text = buildCharacterPersona(dir, slug, includeDims);
    if (!text) return res.json({ success: false, message: '该角色没有可导入的 md 内容' });
    const personaPath = bridgePersonaPath();
    const prev = existsSync(personaPath) ? readFileSync(personaPath, 'utf8') : '';
    if (apply) {
      writeFileSync(personaPath, text, 'utf-8');
      // 存备份(文件名带角色与时间), 便于回退
      try {
        const bk = join(dirname(personaPath), 'persona.backup-' + slug + '.md');
        writeFileSync(bk, prev, 'utf-8');
      } catch {}
    }
    res.json({ success: true, slug, name: slug, chars: text.length, bytes: Buffer.byteLength(text, 'utf8'), preview: text.slice(0, 400), applied: apply });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 上传 md 人设 / SKILL(角色蒸馏) zip 到 roles/
app.post('/api/bridge/upload', (req, res) => {
  try {
    // body: { filename, data(base64) }；保存到 roles 目录
    const { filename, data } = req.body ?? {};
    if (!filename || !data) return res.status(400).json({ success: false, message: '缺少 filename/data' });
    const safe = filename.replace(/[\\/:*?"<>|]/g, '_');
    writeFileSync(join(bridgeRolesDir(), safe), Buffer.from(data, 'base64'));
    res.json({ success: true, name: safe, path: join(bridgeRolesDir(), safe) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 上传表情包图库：图片存 qq-bridge/stickers-upload/，并写入 stickers.json（source=manual，
// url=local://…），重启 bridge 载入后 AI 就能用 qq_list_stickers / qq_send_sticker 使用。
const UPLOAD_STICKER_DIR = () => join(findBridgeDir(), 'stickers-upload');
const bridgeStickerFile = () => join(findBridgeDir(), 'state', 'stickers.json');
function loadStickerJson(file) {
  try {
    const t = readFileSync(file, 'utf8');
    const s = t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
app.post('/api/bridge/stickers/upload', async (req, res) => {
  try {
    // body: { items: [{ name, data(base64) }] }，至少 1 张
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ success: false, message: '请至少选择一张图片' });
    const dir = UPLOAD_STICKER_DIR();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const stickerFile = bridgeStickerFile();
    const entries = loadStickerJson(stickerFile);
    const created = [];
    for (const it of items) {
      const rawName = String(it?.name ?? '').trim() || '表情';
      const safeName = rawName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
      const data = Buffer.from(String(it?.data ?? ''), 'base64');
      if (!data.length) continue;
      const id = `local-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      const extMatch = /^data:[^;]+;\s*base64/.test(String(it?.data ?? '')) || data.length > 8
        ? (String(it?.data ?? '').match(/^data:image\/([a-zA-Z0-9.+-]+);base64/) ? '.' + String(it.data).match(/^data:image\/([a-zA-Z0-9.+-]+);base64/)[1].replace('jpeg', 'jpg') : '.img')
        : '.img';
      const file = `${id}${extMatch === '.img' ? '.img' : extMatch}`;
      writeFileSync(join(dir, file), data);
      const abs = join(dir, file);
      entries.push({
        id,
        resId: id,
        url: 'local://' + abs,
        md5: '',
        desc: safeName,
        localNote: '',
        tags: ['本地上传'],
        usage: '',
        source: 'manual',
        useCount: 0,
        lastUsedAt: 0,
        lastContext: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      created.push({ id, name: safeName, file });
    }
    writeFileSync(stickerFile, JSON.stringify(entries, null, 2), 'utf8');
    // 重启 bridge 让新表情载入内存（manual 条目会被保留、不会被 QQ 同步覆盖）
    try {
      await stopInstance('bridge-local');
      await startDispatcher('bridge-local', loadConfig());
    } catch (e) { console.error('[stickers upload] bridge restart:', e.message); }
    res.json({ success: true, count: created.length, stickers: created, dir });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ------------------------------------------------------------------ */
/* 学习系统代理：把学习配置 / 动作 / 用量 API 转发到“活动”bridge console  */
/*   - 目标选择：servers[activeServerId] 已连接且 Bridge 隧道(13100)在 → 远端 */
/*   - 否则回退本机：127.0.0.1:<bridgeLocal.webuiPort|local.bridge|3100>      */
/*   - 鉴权 x-console-token：镜像 console-server 解析——config.json 的        */
/*     consoleToken(16~128 位 [A-Za-z0-9_-])优先，其次 state/console-token。   */
/* ------------------------------------------------------------------ */
const BRIDGE_TUNNEL_NAME = 'Bridge 控制台'; // 与 tunnelMapFor() 中的隧道名一致

function consoleTokenValid(t) {
  return typeof t === 'string' && t.length >= 16 && t.length <= 128 && /^[A-Za-z0-9_-]+$/.test(t);
}

/** 本机桥接目标：findBridgeDir() 的根目录 + 按 console-server 同款优先级取 token（null=无 token，允许直连试一次） */
function getLocalBridgeTarget() {
  const cfg = loadConfig();
  const brCfg = cfg.instances?.bridgeLocal ?? {};
  const port = brCfg.webuiPort || cfg.local?.bridge || DEFAULT_LOCAL.bridge;
  const dir = findBridgeDir();
  let token = null;
  try {
    const cfgFile = join(dir, 'config.json');
    if (existsSync(cfgFile)) {
      const manual = String(JSON.parse(readFileSync(cfgFile, 'utf-8')).consoleToken ?? '').trim();
      if (consoleTokenValid(manual)) token = manual;
    }
  } catch { /* 读不出就落到 state/console-token */ }
  if (token === null) {
    try {
      const tokFile = join(dir, 'state', 'console-token');
      if (existsSync(tokFile)) {
        const t = readFileSync(tokFile, 'utf-8').trim();
        if (t) token = t;
      }
    } catch { /* token 读取失败 → null */ }
  }
  return { base: `http://127.0.0.1:${port}`, token };
}

/** 经 ssh2 exec 执行一条远程命令，捕获 stdout/stderr（超时只关流，不误杀整个 SSH 连接） */
function sshExecCapture(conn, command, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let streamRef = null;
    const timer = setTimeout(() => {
      try { streamRef?.close?.(); } catch {}
      resolve({ ok: false, error: 'SSH 命令超时' });
    }, timeoutMs);
    conn.exec(command, (err, stream) => {
      if (err) { clearTimeout(timer); resolve({ ok: false, error: err.message }); return; }
      streamRef = stream;
      let out = '';
      let errOut = '';
      stream.on('data', (d) => (out += d.toString()));
      stream.stderr.on('data', (d) => (errOut += d.toString()));
      stream.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? { ok: true, out: out.trim() } : { ok: false, error: errOut.trim() || `远程命令 exit ${code}` });
      });
    });
  });
}

/** 远端 qq-bridge 根目录探测：在常见位置找带 config.json 的目录（服务器无桥接目录配置项，只能探测） */
async function findRemoteBridgeDir(conn) {
  const script = [
    'for d in "$HOME/qq-bridge" "$HOME/Desktop/qq-bridge" "$HOME/QQ-Bridge" "$HOME/Desktop/QQ-Bridge"',
    '"$HOME/qq-bridge-app" "$HOME/app/qq-bridge" "$HOME/workspace/qq-bridge" /root/qq-bridge /srv/qq-bridge /opt/qq-bridge; do',
    '[ -f "$d/config.json" ] && { printf "%s" "$d"; exit 0; }; done; exit 1',
  ].join(' ');
  const r = await sshExecCapture(conn, script, 10000);
  if (!r.ok) return '';
  return r.out.split(/\r?\n/)[0].trim();
}

/**
 * 远端 bridge console-token：单次 exec 同时取 config.json 手动 consoleToken 与 state/console-token，
 * 按 console-server 同款优先级（合法手动 token 优先）选择；结果缓存 2 分钟，连接断开/重连时清缓存。
 */
async function getRemoteBridgeToken(server, conn) {
  const hit = bridgeTokenCache.get(server.id);
  if (hit && Date.now() - hit.at < 120000) return hit.token;
  let token = null;
  try {
    const dir = await findRemoteBridgeDir(conn);
    if (dir) {
      const probe = [
        `cfg=$(grep -m1 -oE '"consoleToken"[[:space:]]*:[[:space:]]*"[^"]+" "${dir}"/config.json 2>/dev/null | sed -E 's/^.*"consoleToken"[[:space:]]*:[[:space:]]*"([^"]+)"/\\1/')`,
        `st=$(cat "${dir}"/state/console-token 2>/dev/null | tr -d '\\r\\n')`,
        `printf '%s\\n%s\\n' "$cfg" "$st"`,
      ].join('; ');
      const r = await sshExecCapture(conn, probe, 10000);
      if (r.ok) {
        const [cfgTok, stateTok] = r.out.split(/\r?\n/).map((s) => s.trim());
        token = consoleTokenValid(cfgTok) ? cfgTok : (stateTok || null);
      }
    }
  } catch (e) { /* token 读取失败 → null，仍允许无 token 直连试一次 */ }
  bridgeTokenCache.set(server.id, { token, at: Date.now() });
  return token;
}

/** 解析“活动 bridge console”：远端（已连接且 Bridge 隧道在）优先，否则本机 */
/** 只解析**远端** bridge console（没连服务器 / 没隧道就返回 null）。
 *  拆出来是为了「用量统计」：那个接口要**两边都取**（本机 + 服务端），不能再跟着"活动目标"走。 */
function resolveRemoteBridgeTarget() {
  const cfg = loadConfig();
  const connected = cfg.activeServerId ? cfg.servers.find((s) => s.id === cfg.activeServerId) || null : null;
  if (connected && sshConnections.has(connected.id)) {
    for (const [key, tun] of tunnels.entries()) {
      if (key.startsWith(connected.id + ':') && tun.name === BRIDGE_TUNNEL_NAME) {
        return { server: connected, conn: sshConnections.get(connected.id), base: `http://127.0.0.1:${tun.local}` };
      }
    }
  }
  return null;
}

function resolveBridgeTarget() {
  const rt = resolveRemoteBridgeTarget();
  if (rt) return { kind: 'remote', ...rt };
  return { kind: 'local', server: null, conn: null, ...getLocalBridgeTarget() };
}

/* ================================================================== */
/* 服务端现场状态（复用 sshConnections 里那条连接，绝不新开 SSH 连接）    */
/* ================================================================== */
/* 【2026-09-14 主人要求】连上服务器后要能在界面上看到**服务端**的真实运行状态：
 *   DSH  = systemctl is-active dsh-web
 *   NapCat = docker ps（Up/Exited）+ 3000/3001/6099 端口
 *   桥   = pgrep -f 'node src/bridge[.]js' + 3100
 * 实现要点：
 *   · 一条组合命令 + 分段标记（@@XXX），只走**一次** exec（ssh2 的 exec 只是新开一条 channel，
 *     用的还是 sshConnections 里那一条已建立的连接）；
 *   · 每段都 `|| true`：任何子命令失败都不让整条命令非 0 退出 —— 否则 sshExecCapture 只会回
 *     { ok:false, error }，什么都拿不到；
 *   · 结果缓存 10 秒：/api/state 是 4 秒轮询，不能每次都去戳服务器；前端「刷新」用 force=1 绕过。
 *   · **令牌只放进返回值给前端拼 URL，绝不写日志**（私钥/密码/token 都不进日志，这是硬规矩）。*/
const remoteStatusCache = new Map();      // serverId -> { at, ttl, data }
const remoteBridgeDirCache = new Map();   // serverId -> { at, dir }
const REMOTE_STATUS_TTL_MS = 10000;

/** 单引号包裹（POSIX shell 安全的路径传参；路径里出现单引号也不会被拆开） */
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
/** 只允许我们拼出来的安全路径（远端桥目录 + 固定文件名），别的一律拒绝 */
function safeRemotePath(p) { return /^\/[A-Za-z0-9._\/-]+$/.test(String(p || '')); }

/** 某条隧道的本地端口（隧道没建就退回默认端口） */
function tunnelLocalPort(serverId, name, fallback) {
  const t = tunnels.get(`${serverId}:${name}`);
  return t?.local || fallback;
}

/** 服务端四个入口的 URL：DSH 带 ?token=（无令牌一律 401），NapCat 带 webui token，桥带 console token */
function remoteServiceUrls(server, status) {
  const m = server?.remotePorts ?? {};
  const pDsh = tunnelLocalPort(server.id, 'DSH Web', 13080);
  const pNap = tunnelLocalPort(server.id, 'NapCat WebUI', 13000);
  const pHttp = tunnelLocalPort(server.id, 'NapCat HTTP', 13001);
  const pBr = tunnelLocalPort(server.id, 'Bridge 控制台', 13100);
  const dshTok = String(status?.dsh?.token || '');
  const napTok = String(status?.napcat?.webuiToken || '');
  const brTok = String(status?.bridge?.consoleToken || '');
  return {
    ports: { dsh: pDsh, napcat: pNap, napcatHttp: pHttp, bridge: pBr, remoteDsh: m.dshWeb ?? 3080, remoteNapcat: m.napcatWebui ?? 6099, remoteBridge: m.bridge ?? 3100 },
    dsh: `http://127.0.0.1:${pDsh}/${dshTok ? '?token=' + encodeURIComponent(dshTok) : ''}`,
    // NapCat 的 /webui 不带结尾斜杠会 301 跳到 /webui/（实测），直接给规范地址少一跳
    napcat: `http://127.0.0.1:${pNap}/webui/${napTok ? '?token=' + encodeURIComponent(napTok) : ''}`,
    napcatHttp: `http://127.0.0.1:${pHttp}`,
    bridge: `http://127.0.0.1:${pBr}${brTok ? '/?token=' + encodeURIComponent(brTok) : ''}`,
    bridgeToken: brTok,
  };
}

/** 组合命令：一条 exec 取回 DSH/NapCat/桥/端口/令牌 */
function buildRemoteStatusCommand(server) {
  const m = server?.remotePorts ?? {};
  const ports = [...new Set([3000, 3001, 6099, m.napcatHttp ?? 3000, m.napcatWebui ?? 6099, m.dshWeb ?? 3080, m.bridge ?? 3100].map(Number).filter(Boolean))];
  const portLoop = `for p in ${ports.join(' ')}; do if ss -Hltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p$"; then echo "$p=up"; else echo "$p=down"; fi; done`;
  return [
    "echo '@@DSH'",
    'systemctl is-active dsh-web 2>/dev/null || echo unknown',
    'systemctl is-enabled dsh-web 2>/dev/null || echo unknown',
    "echo '@@DOCKER'",
    "docker ps -a --filter name=napcat --format '{{.Names}}::{{.Status}}' 2>/dev/null || true",
    "echo '@@PORTS'",
    portLoop,
    "echo '@@BRIDGEPROC'",
    "pgrep -af 'node src/bridge[.]js' 2>/dev/null || true",
    "echo '@@BRIDGEDIR'",
    'for d in /root/qq-bridge "$HOME/qq-bridge" /opt/qq-bridge /srv/qq-bridge "$HOME/app/qq-bridge" "$HOME/workspace/qq-bridge"; do [ -f "$d/config.json" ] && { echo "$d"; break; }; done',
    "echo '@@DSHTOKEN'",
    // DSH 每次启动都会在日志里打印 `dsh web: http://127.0.0.1:3080/?token=xxx`；
    // 日志末尾往往还有别的行，所以取"尾部若干行里最后一次出现的 token="，不是死盯最后一行。
    'for f in /root/.dsh/dsh-web.log "$HOME/.dsh/dsh-web.log"; do [ -f "$f" ] && { tail -n 400 "$f" | grep -oE "token=[A-Za-z0-9_.-]+" | tail -n 1 | cut -d= -f2; break; }; done',
    "echo '@@NAPCATWEBUI'",
    'for f in /root/napcat/config/webui.json "$HOME/napcat/config/webui.json" /app/napcat/config/webui.json; do [ -f "$f" ] && { grep -oE \'"token"[[:space:]]*:[[:space:]]*"[^"]*"\' "$f" | head -n 1 | sed -E \'s/.*:[[:space:]]*"([^"]*)"/\\1/\'; break; }; done',
    "echo '@@END'",
  ].join('\n');
}

/** 解析分段输出。缺段也不串位（每段独立按标记切）。 */
function parseRemoteStatus(out, server) {
  const m = server?.remotePorts ?? {};
  const RP = { dsh: Number(m.dshWeb ?? 3080), napcat: Number(m.napcatWebui ?? 6099), napcatHttp: Number(m.napcatHttp ?? 3000), bridge: Number(m.bridge ?? 3100) };
  const seg = {};
  let cur = null;
  for (const line of String(out || '').split(/\r?\n/)) {
    const mm = /^@@([A-Z]+)\s*$/.exec(line);
    if (mm) { cur = mm[1]; seg[cur] = []; continue; }
    if (cur) seg[cur].push(line);
  }
  const lines = (k) => (seg[k] || []).map((s) => s.trim()).filter(Boolean);
  const first = (k) => lines(k)[0] || '';

  const ports = {};
  for (const l of lines('PORTS')) { const mm = /^(\d+)=(up|down)$/.exec(l); if (mm) ports[mm[1]] = mm[2] === 'up'; }

  const dshActive = first('DSH') || 'unknown';
  const dshEnabled = (lines('DSH')[1] || 'unknown');

  // docker 段：只认 `名字::状态` 这种行（docker 不存在时这里是空/报错文本，不解析）
  const containers = lines('DOCKER').map((l) => {
    const i = l.indexOf('::');
    return i > 0 ? { name: l.slice(0, i).trim(), status: l.slice(i + 2).trim() } : null;
  }).filter(Boolean);
  const napContainer = containers.find((c) => /napcat/i.test(c.name)) || containers[0] || null;

  const procs = lines('BRIDGEPROC').map((l) => {
    const mm = /^(\d+)\s+(.*)$/.exec(l);
    return mm ? { pid: Number(mm[1]), cmd: mm[2] } : null;
  }).filter(Boolean);

  return {
    remotePorts: RP,
    dsh: {
      unit: 'dsh-web',
      active: dshActive,                       // systemctl is-active 原文：active/inactive/failed/unknown
      enabled: dshEnabled,
      running: dshActive === 'active',
      port: RP.dsh,
      portUp: ports[RP.dsh] === true,
      token: first('DSHTOKEN'),
      hasToken: !!first('DSHTOKEN'),
    },
    napcat: {
      container: napContainer?.name || 'napcat',
      status: napContainer?.status || '',
      containers,
      running: !!napContainer && /^Up\b/i.test(napContainer.status),
      exited: !!napContainer && /^Exited\b/i.test(napContainer.status),
      // 3000/3001/6099 是 NapCat 的固定端口（OneBot HTTP/WS + WebUI），不受 remotePorts 影响
      ports: { 3000: ports[3000] === true, 3001: ports[3001] === true, 6099: ports[6099] === true },
      webuiToken: first('NAPCATWEBUI'),
      hasWebuiToken: !!first('NAPCATWEBUI'),
    },
    bridge: {
      running: procs.length > 0,
      pids: procs.map((p) => p.pid),
      cmd: procs[0]?.cmd || '',
      port: RP.bridge,
      portUp: ports[RP.bridge] === true,
      dir: first('BRIDGEDIR'),
      consoleToken: '',                        // 由 getRemoteServerStatus 用已有通路单独取（配置里可能没有）
    },
    ports,
  };
}

/**
 * 取某台已连接服务器的现场状态。**不新建 SSH 连接**：一律用 sshConnections 里那条。
 * 10 秒内重复请求复用缓存（失败也短缓存 3 秒，避免前端轮询时连着戳服务器）。
 */
async function getRemoteServerStatus(server, connArg, opts = {}) {
  const { force = false, timeoutMs = 8000 } = opts;
  const conn = connArg || sshConnections.get(server?.id);
  if (!server?.id || !conn) return { ok: false, connected: false, at: Date.now(), message: '未连接（先在 SSH 配置页点「连接」建立隧道）' };
  const hit = remoteStatusCache.get(server.id);
  if (!force && hit && Date.now() - hit.at < (hit.ttl ?? REMOTE_STATUS_TTL_MS)) return hit.data;
  const r = await sshExecCapture(conn, buildRemoteStatusCommand(server), timeoutMs);
  if (!r.ok) {
    const data = { ok: false, connected: true, at: Date.now(), error: r.error || '远程命令执行失败', server: { id: server.id, name: server.name, host: server.host } };
    remoteStatusCache.set(server.id, { at: Date.now(), ttl: 3000, data });
    return data;
  }
  const parsed = parseRemoteStatus(r.out, server);
  // 桥的 console token 用既有通路取（config.json consoleToken → state/console-token），失败不当回事
  try { parsed.bridge.consoleToken = (await getRemoteBridgeToken(server, conn)) || ''; } catch { /* 无 token 也允许直连 */ }
  const data = { ok: true, connected: true, at: Date.now(), server: { id: server.id, name: server.name, host: server.host }, ...parsed };
  remoteStatusCache.set(server.id, { at: Date.now(), ttl: REMOTE_STATUS_TTL_MS, data });
  /* 【2026-09-14 主人反馈"点开桥设置界面会先加载一下才弹出"】顺手把这台服务器的桥配置**预热**到缓存里：
   * 状态本来就在被轮询，多花一次 SSH 往返、换来"点开配置页立刻出现"（GET 直接命中缓存）。 */
  void warmRemoteBridgeConfig(server.id).catch(() => {});
  return data;
}

/* 服务端桥配置的**预加载缓存**：serverId -> { at, data }（TTL 45s）。
 * 读配置要 4~5 次 SSH 往返（目录探测 + config.json + persona + speech + settings.yaml），
 * 冷启动点开会明显"先转一会儿"。连上服务器后由状态轮询/连接回调预热，用户点开时基本是命中缓存。 */
const remoteBridgeCfgCache = new Map();
const remoteBridgeCfgInflight = new Map();   // serverId -> Promise（避免并发重复取；GET 可等它）
const REMOTE_BRIDGE_CFG_TTL_MS = 45000;
async function warmRemoteBridgeConfig(serverId, { force = false } = {}) {
  const ch = remoteBridgeChannel(serverId);
  if (ch.error) return null;
  const hit = remoteBridgeCfgCache.get(ch.server.id);
  if (!force && hit && Date.now() - hit.at < REMOTE_BRIDGE_CFG_TTL_MS) return hit.data;
  // 已在预热中就不要并发重复取，直接复用同一个 Promise
  const running = remoteBridgeCfgInflight.get(ch.server.id);
  if (running) return running;
  const task = (async () => {
    try {
      const data = await buildRemoteBridgeConfigPayload(ch.server, ch.conn);
      remoteBridgeCfgCache.set(ch.server.id, { at: Date.now(), data });
      return data;
    } finally { remoteBridgeCfgInflight.delete(ch.server.id); }
  })();
  remoteBridgeCfgInflight.set(ch.server.id, task);
  return task;
}

/** 组装 GET /api/ssh/bridge-config 的响应体（读 + 解析 + 说明文案；POST 后也会用它刷新缓存）。 */
async function buildRemoteBridgeConfigPayload(server, conn) {
  const bundle = await readRemoteBridgeBundle(server, conn);
  const brief = { id: server.id, name: server.name, host: server.host, username: server.username };
  if (!bundle.ok) return { ok: false, target: 'remote', connected: true, server: brief, dir: bundle.dir || '', message: bundle.message };
  const dsh = await readRemoteDshModels(server, conn);
  return {
    ok: true, target: 'remote', connected: true, server: brief,
    dir: bundle.dir, path: bundle.path, config: bundle.config,
    persona: bundle.persona, personaHasFile: bundle.personaHasFile,
    speechRules: bundle.speechRules, speechHasFile: bundle.speechHasFile,
    dshEffective: dsh.effective, dshModels: dsh.models, dshSettingsPath: dsh.path,
    roles: [],
    notes: [
      `当前编辑的是**服务端**（${server.name} · ${server.username}@${server.host}）的 \`${bundle.path}\`：桥按 mtime 热加载，保存后下一条消息即生效。`,
      '人设 / 发言规则也读写服务端的 `persona.md`、`speech-rules.md`。',
      `模型清单取自服务端 DSH 的 \`${dsh.path || 'settings.yaml'}\`（未取到时请用页内下拉手填）。`,
      '「方案（配置预设）」存在管理端本机；角色库导入 / 表情包上传仍作用于本机 qq-bridge。',
    ],
  };
}

/** 远端 qq-bridge 目录（带 5 分钟缓存：读写配置都先要它，别每次都探测一遍） */
async function getRemoteBridgeDir(server, conn, { force = false } = {}) {
  const hit = remoteBridgeDirCache.get(server.id);
  if (!force && hit && Date.now() - hit.at < 300000) return hit.dir;
  const dir = await findRemoteBridgeDir(conn);
  remoteBridgeDirCache.set(server.id, { dir, at: Date.now() });
  return dir;
}

/** 读远端文本文件（走 base64，避免换行/编码被 shell 改写）；文件不存在回 { ok:false, missing:true } */
async function remoteReadText(conn, path, timeoutMs = 12000) {
  if (!safeRemotePath(path)) return { ok: false, error: `路径不合法：${path}` };
  const cmd = `if [ -f ${shq(path)} ]; then base64 < ${shq(path)} | tr -d '\\r\\n'; else echo '@@NOFILE'; fi`;
  const r = await sshExecCapture(conn, cmd, timeoutMs);
  if (!r.ok) return { ok: false, error: r.error || '读取失败' };
  const raw = r.out.trim();
  if (raw === '@@NOFILE') return { ok: false, missing: true, error: '文件不存在' };
  try { return { ok: true, text: Buffer.from(raw, 'base64').toString('utf8') }; }
  catch (e) { return { ok: false, error: '远端内容解码失败：' + (e?.message || e) }; }
}

/**
 * 写远端文件：临时文件 → 校验非空 → 备份原文件（cp -a，带时间戳）→ mv 到位 → 读回比对。
 * 为什么要这么绕（主人 2026-09-14 要求）：
 *   · 直接覆盖写：一旦传输中断就是半个文件，桥按 mtime 热加载会读到坏 JSON，等于把线上配置写废；
 *   · 先写 /tmp 再 mv：同一文件系统内 mv 是原子替换，读到的永远是完整的旧版或完整的新版；
 *   · 写前备份 + 写后回读比对关键字段：能明确回答"到底写进去了没有"，而不是回一句"已保存"。
 */
async function remoteWriteTextVerified(conn, path, content, { backup = true, timeoutMs = 25000 } = {}) {
  if (!safeRemotePath(path)) return { ok: false, error: `路径不合法：${path}` };
  // 备份名与服务器上已有的 config.json.bak-<日期>-<时间> 风格一致（例：config.json.bak-20260914-134609）
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const tmp = `/tmp/qbm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  const bak = `${path}.bak-${stamp}`;
  const b64 = Buffer.from(String(content), 'utf8').toString('base64');
  const cmd = [
    'set -e',
    `printf %s ${shq(b64)} | base64 -d > ${shq(tmp)}`,
    `[ -s ${shq(tmp)} ]`,
    backup ? `[ -f ${shq(path)} ] && cp -a ${shq(path)} ${shq(bak)} || true` : 'true',
    `mv ${shq(tmp)} ${shq(path)}`,
    'echo @@WRITTEN',
  ].join('\n');
  const w = await sshExecCapture(conn, cmd, timeoutMs);
  if (!w.ok) return { ok: false, error: w.error || '写入失败', backup: null, path };
  const back = await remoteReadText(conn, path);
  if (!back.ok) return { ok: false, error: '写入后回读失败：' + (back.error || ''), backup: backup ? bak : null, path };
  return { ok: true, backup: backup ? bak : null, path, readback: back.text };
}

/**
 * 服务端 qq-bridge 配置读写（读 config.json / persona.md / speech-rules.md）。
 * 桥的 config.json 是**按 mtime 热加载**的：保存后下一条消息即生效，不用重启桥。
 */
async function readRemoteBridgeBundle(server, conn) {
  const dir = await getRemoteBridgeDir(server, conn);
  if (!dir) return { ok: false, dir: '', message: '服务器上没找到 qq-bridge 目录（找过 /root/qq-bridge、~/qq-bridge、/opt、/srv 等常见位置）' };
  const cfgRead = await remoteReadText(conn, `${dir}/config.json`);
  if (!cfgRead.ok) return { ok: false, dir, message: cfgRead.missing ? `${dir}/config.json 不存在（服务器上桥还没跑过？）` : ('读取服务器 config.json 失败：' + (cfgRead.error || '')) };
  let config = null;
  try { config = JSON.parse(cfgRead.text); }
  catch (e) { return { ok: false, dir, message: `服务器 config.json 解析失败：${e.message}` }; }
  const [per, sp] = await Promise.all([
    remoteReadText(conn, `${dir}/persona.md`),
    remoteReadText(conn, `${dir}/speech-rules.md`),
  ]);
  return {
    ok: true, dir, path: `${dir}/config.json`, config,
    persona: per.ok ? per.text : '', personaHasFile: per.ok,
    speechRules: sp.ok ? sp.text : '', speechHasFile: sp.ok,
  };
}

/** 从 settings.yaml 文本里解析「DSH 实际生效的模型段」（与 readDshEffectiveSettings 同一套规则） */
function parseDshEffectiveText(text) {
  try {
    const seg = (String(text || '').match(/agent-default-model:[\s\S]*?(?=\n\S|$)/) || [''])[0];
    const get = (k) => {
      const m = new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm').exec(seg);
      return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
    };
    return { provider: get('provider'), model: get('model'), reasoningEffort: get('reasoningEffort') };
  } catch { return {}; }
}

/** 服务端 DSH 的模型目录：读服务器上 DSH_HOME 的 settings.yaml（只解析 providers/models 那一段） */
async function readRemoteDshModels(server, conn) {
  const user = String(server?.username || 'root');
  const candidates = [...new Set(['/root/.dsh/settings.yaml', `/home/${user}/.dsh/settings.yaml`])];
  for (const path of candidates) {
    const r = await remoteReadText(conn, path);
    if (!r.ok) continue;
    const providers = parseYamlProviderModels(r.text);
    const sources = {};
    for (const k of Object.keys(providers)) sources[k] = 'settings.yaml';
    return { effective: parseDshEffectiveText(r.text), models: { providers, sources }, path };
  }
  return { effective: {}, models: { providers: {} }, path: '' };
}

/** 浅层深合并（与 /api/bridge/config 本地保存同一套语义：GUI 只带它编辑的片段，不能整体覆盖丢字段） */
function deepMergeObject(base, patch) {
  const out = (base && typeof base === 'object' && !Array.isArray(base)) ? { ...base } : (Array.isArray(base) ? [...base] : {});
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const k of Object.keys(patch)) {
      if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
        out[k] = deepMergeObject(out[k], patch[k]);
      } else if (patch[k] !== undefined) {
        out[k] = patch[k];
      }
    }
  }
  return out;
}

/** 保存前把 JSON 归一化（排序键）后比对：用来判断"关键字段是不是真的写进去了" */
function canonicalJson(v) {
  const walk = (x) => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      const o = {};
      for (const k of Object.keys(x).sort()) o[k] = walk(x[k]);
      return o;
    }
    return x;
  };
  return JSON.stringify(walk(v));
}

/** 取某台服务器上 qq-bridge 的读写通道（未连接就回 null） */
function remoteBridgeChannel(serverId) {
  const cfg = loadConfig();
  const id = serverId || cfg.activeServerId;
  const server = cfg.servers.find((s) => s.id === id) || null;
  if (!server) return { error: '未找到服务器配置（serverId=' + (id || '空') + '）' };
  const conn = sshConnections.get(server.id);
  if (!conn) return { error: `服务器「${server.name}」当前未连接：请先在 SSH 配置页点「连接」建立隧道`, server };
  return { server, conn };
}

/** GET /api/ssh/bridge-config：读**服务端** /root/qq-bridge/config.json（+ 人设/发言规则） */
app.get('/api/ssh/bridge-config', async (req, res) => {
  const ch = remoteBridgeChannel(req.query.serverId);
  if (ch.error) return res.json({ ok: false, target: 'remote', connected: false, message: ch.error, server: ch.server ? { id: ch.server.id, name: ch.server.name, host: ch.server.host } : null });
  // 【2026-09-14】优先命中预加载缓存（连上服务器后状态轮询会把它预热）→ 点开配置页不再"先转一会儿"。
  const hit = remoteBridgeCfgCache.get(ch.server.id);
  if (hit && req.query.refresh !== '1' && Date.now() - hit.at < REMOTE_BRIDGE_CFG_TTL_MS) return res.json({ ...hit.data, cached: true, cachedAt: hit.at });
  const inflight = remoteBridgeCfgInflight.get(ch.server.id);   // 预热正在飞 → 等它，别重复取
  if (inflight) {
    const data = await inflight;
    if (data) return res.json({ ...data, cached: true, cachedAt: Date.now() });
  }
  const data = await buildRemoteBridgeConfigPayload(ch.server, ch.conn);
  remoteBridgeCfgCache.set(ch.server.id, { at: Date.now(), data });
  res.json({ ...data, cached: false });
});

/** POST /api/ssh/bridge-config：写**服务端** config.json（备份 + 原子替换 + 回读比对） */
app.post('/api/ssh/bridge-config', async (req, res) => {
  const body = req.body ?? {};
  const ch = remoteBridgeChannel(body.serverId);
  if (ch.error) return res.json({ ok: false, success: false, target: 'remote', message: ch.error });
  const { server, conn } = ch;
  const brief = { id: server.id, name: server.name, host: server.host, username: server.username };
  const dir = await getRemoteBridgeDir(server, conn);
  if (!dir) return res.json({ ok: false, success: false, target: 'remote', server: brief, message: '服务器上没找到 qq-bridge 目录' });
  const out = { ok: true, success: true, target: 'remote', server: brief, dir, steps: [] };

  // ① config.json：先读回当前全量（GUI 只提交它编辑的片段）→ 深合并 → 写 → 回读比对
  if (body.config && typeof body.config === 'object') {
    const cur = await remoteReadText(conn, `${dir}/config.json`);
    let prev = {};
    if (cur.ok) { try { prev = JSON.parse(cur.text); } catch { prev = {}; } }
    const merged = deepMergeObject(prev, body.config);
    const text = JSON.stringify(merged, null, 2);
    const w = await remoteWriteTextVerified(conn, `${dir}/config.json`, text);
    if (!w.ok) return res.json({ ...out, ok: false, success: false, message: '写入服务端 config.json 失败：' + (w.error || ''), steps: out.steps });
    let back = null;
    try { back = JSON.parse(w.readback); } catch { /* 回读解析失败 → 下面按比对不通过处理 */ }
    // 关键字段比对：以**提交的合并结果**为准，逐顶层键比对序列化结果
    const mismatched = [];
    if (!back) mismatched.push('（回读内容不是合法 JSON）');
    else for (const k of Object.keys(merged)) {
      if (canonicalJson(merged[k]) !== canonicalJson(back[k])) mismatched.push(k);
    }
    out.path = w.path;
    out.backup = w.backup;
    out.verified = mismatched.length === 0;
    out.mismatched = mismatched;
    out.config = back ?? null;
    out.steps.push({ step: '写服务端 config.json', ok: true, msg: `${w.path}（备份 ${w.backup ? w.backup : '无原文件'}）` });
    out.steps.push({ step: '回读比对关键字段', ok: out.verified, msg: out.verified ? '全部一致' : ('不一致：' + mismatched.join(', ')) });
    if (!out.verified) { out.ok = false; out.success = false; out.message = '已写入服务端 config.json，但**回读比对不一致**：' + mismatched.join(', '); }
    else out.message = `已写入服务端 config.json（${dir}/config.json）· 回读比对一致 · 桥按 mtime 热加载，下一条消息即生效`;
  }

  // ② 人设 / 发言规则（写服务端同名文件；空内容 = 删除，与本地保存一致）
  for (const [field, file] of [['persona', 'persona.md'], ['speechRules', 'speech-rules.md']]) {
    const v = body[field];
    if (typeof v !== 'string') continue;
    const p = `${dir}/${file}`;
    if (!v.trim()) {
      const r = await sshExecCapture(conn, `rm -f ${shq(p)} && echo @@REMOVED`, 12000);
      out.steps.push({ step: `清空 ${file}`, ok: r.ok, msg: r.ok ? '已删除服务端文件（回到出厂为空）' : (r.error || '删除失败') });
      if (!r.ok) { out.ok = false; out.success = false; out.message = out.message || `删除服务端 ${file} 失败`; }
      continue;
    }
    const w = await remoteWriteTextVerified(conn, p, v);
    const same = w.ok && w.readback === v;
    out.steps.push({ step: `写服务端 ${file}`, ok: !!same, msg: same ? `${p}（备份 ${w.backup || '无原文件'}）· 回读一致` : ('失败或回读不一致：' + (w.error || '内容与提交不一致')) });
    if (!same) { out.ok = false; out.success = false; out.message = out.message || `服务端 ${file} 写入未通过回读比对`; }
    if (field === 'persona' && same) { out.persona = v; out.personaHasFile = true; }
    if (field === 'speechRules' && same) { out.speechRules = v; out.speechHasFile = true; }
  }

  // ③ 「恢复默认发言规则」：服务端模式下写的是**服务端**的 speech-rules.md（内置模板与本机那份逐字相同）
  if (body.speechReset === true) {
    const w = await remoteWriteTextVerified(conn, `${dir}/speech-rules.md`, DEFAULT_SPEECH_RULES);
    const same = w.ok && w.readback === DEFAULT_SPEECH_RULES;
    out.steps.push({ step: '恢复默认发言规则（服务端）', ok: !!same, msg: same ? `${dir}/speech-rules.md · 已写回内置模板` : ('失败：' + (w.error || '回读不一致')) });
    if (same) { out.speechRules = DEFAULT_SPEECH_RULES; out.speechHasFile = true; }
    else { out.ok = false; out.success = false; out.message = out.message || '恢复默认发言规则失败（服务端）'; }
  }

  if (!out.message) out.message = '没有需要写入的内容（请求里既没有 config 也没有人设/发言规则）';
  remoteBridgeCfgCache.delete(server.id);   // 写过了 → 预加载缓存作废（下次点开会重新取最新的）
  res.json(out);
});

/** GET /api/ssh/status：服务端三个组件的**真实**运行状态（复用已有 SSH 连接，10 秒缓存） */
app.get('/api/ssh/status', async (req, res) => {
  const cfg = loadConfig();
  const id = req.query.serverId || cfg.activeServerId;
  const server = cfg.servers.find((s) => s.id === id) || null;
  if (!server) {
    // 说清"是没有服务器"还是"有服务器但没连"，别把两种情况糊成一句
    return res.json({
      ok: false, connected: false,
      servers: cfg.servers.map((s) => ({ id: s.id, name: s.name, host: s.host })),
      message: cfg.servers.length ? '当前没有已连接的服务器：先在 SSH 配置页点「连接」' : '还没有保存任何服务器：先去 SSH 配置页添加一台',
    });
  }
  const conn = sshConnections.get(server.id);
  if (!conn) return res.json({ ok: false, connected: false, server: { id: server.id, name: server.name, host: server.host }, message: `服务器「${server.name}」未连接：先在 SSH 配置页点「连接」` });
  const st = await getRemoteServerStatus(server, conn, { force: req.query.force === '1' });
  res.json({ ...st, urls: remoteServiceUrls(server, st).ports, timestamp: new Date().toISOString() });
});


/** 统一透传：桥不可达/路由缺失(404)/响应非 JSON → 结构化失败；其余把桥响应 JSON 原样回给 GUI */
async function proxyToBridgeConsole(_req, res, target) {
  const t = resolveBridgeTarget();
  let token = null;
  if (t.kind === 'remote') token = await getRemoteBridgeToken(t.server, t.conn);
  else token = t.token;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(target.timeoutMs) > 0 ? Number(target.timeoutMs) : 30000);
  let resp;
  try {
    resp = await fetch(t.base + target.path, {
      method: target.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'x-console-token': token } : {}) },
      body: target.body === undefined ? undefined : JSON.stringify(target.body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    console.error(`[learning proxy] ${target.method || 'GET'} ${target.path} 失败:`, e?.message || e);
    return res.json({ success: false, code: 'bridge-offline', message: '目标桥不可达：请确认桥接进程已启动、远端连接与隧道正常', detail: String(e?.message || e) });
  }
  clearTimeout(timer);
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!json || resp.status === 404) {
    return res.json({ success: false, code: 'bridge-stale', message: '目标桥版本过旧或未连接', detail: `HTTP ${resp.status}${json === null ? '（响应非 JSON）' : ''}` });
  }
  res.json(json);
}

app.get('/api/learning/config', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/learning-config', method: 'GET' }));
app.post('/api/learning/config', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/learning-config', method: 'PUT', body: req.body ?? {} }));
app.post('/api/learning/slang', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/learning/slang', method: 'POST', body: req.body ?? {} }));
app.post('/api/learning/persona', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/learning/persona', method: 'POST', body: req.body ?? {} }));
app.post('/api/learning/portrait', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/learning/portrait', method: 'POST', body: req.body ?? {} }));

/* ── 语音（MiMo-V2.5 TTS / 音色设计 / 音色复刻 / 语音识别）────────────────────────────
 * 桥侧新增的能力，全部转发到桥控制台（/api/voice/*）：管理端只负责配置与试听转发，
 * 发送与识别由桥里的 MCP 工具带会话令牌调用，不经过管理端。
 * 合成一次可能跑十几秒（语音服务返回整段音频），所以这里把代理超时放宽到 90 秒。 */
const VOICE_TIMEOUT_MS = 90000;
app.get('/api/voice/config', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/voice/config', method: 'GET', timeoutMs: VOICE_TIMEOUT_MS }));
app.put('/api/voice/config', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/voice/config', method: 'PUT', body: req.body ?? {}, timeoutMs: VOICE_TIMEOUT_MS }));
app.get('/api/voice/voices', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/voice/voices', method: 'GET', timeoutMs: VOICE_TIMEOUT_MS }));
app.post('/api/voice/voices', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/voice/voices', method: 'POST', body: req.body ?? {}, timeoutMs: VOICE_TIMEOUT_MS }));
app.delete('/api/voice/voices', (req, res) => proxyToBridgeConsole(req, res, { path: `/api/voice/voices?id=${encodeURIComponent(String(req.query.id ?? ''))}`, method: 'DELETE', timeoutMs: VOICE_TIMEOUT_MS }));
app.post('/api/voice/preview', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/voice/preview', method: 'POST', body: req.body ?? {}, timeoutMs: VOICE_TIMEOUT_MS }));
app.post('/api/voice/test', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/voice/test', method: 'POST', body: req.body ?? {}, timeoutMs: VOICE_TIMEOUT_MS }));

/* 黑话库批量审批（管理端弹窗的三个批量按钮）：桥侧端点早就有了，管理端此前没有转发，
 * 于是界面上的「批量通过 / 批量拒收 / 批量分析」会 404。这里按同路径补三条 POST 代理。 */
app.post('/api/slang/batch-confirm', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/slang/batch-confirm', method: 'POST', body: req.body ?? {} }));
/* 黑话删除（单条也走这条，传一个 id 的数组）：管理端「学习」页每条黑话的删除入口要用 */
app.post('/api/slang/batch-delete', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/slang/batch-delete', method: 'POST', body: req.body ?? {} }));
app.post('/api/slang/batch-reject', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/slang/batch-reject', method: 'POST', body: req.body ?? {} }));
app.post('/api/slang/research', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/slang/research', method: 'POST', body: req.body ?? {}, timeoutMs: 60000 }));
/* 人格学习：审批修正 / 结合原人设完善（fuse 要跑一轮模型，所以超时放宽到 3 分钟）/ 覆盖机器人人设 */
app.post('/api/learning/persona-apply', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/learning/persona-apply', method: 'POST', body: req.body ?? {}, timeoutMs: 180000 }));

/* NapCat 鉴权令牌（WebUI / HTTP / WS）：读现状 + 写进 NapCat 配置并重启容器。
 * 重启容器要等它起来（约 30~60 秒），加上写盘后的复验，超时给到 4 分钟。 */
app.get('/api/napcat/tokens', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/napcat/tokens', method: 'GET', timeoutMs: 60000 }));
app.post('/api/napcat/tokens', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/napcat/tokens', method: 'POST', body: req.body ?? {}, timeoutMs: 240000 }));

/* NapCat 会话守护（探针 + 假死自愈）。
 * 为什么要有它：QQ 服务端把登录态作废时，客户端可能一条错都不报（WebUI 上 isLogin/online 还是 true），
 * 表现是"看起来在线、其实发不出去"，实测静默了 50 分钟。桥侧每 60s 用 get_rkey 探活，连续失败就重启容器自愈。
 * 超时：heal 要重启容器并等它登回来（最长 ~2.5 分钟），quick-password 要重建容器（最长 ~3 分钟），都放宽。 */
app.get('/api/napcat/guard', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/napcat/guard', method: 'GET', timeoutMs: 60000 }));
app.post('/api/napcat/guard', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/napcat/guard', method: 'POST', body: req.body ?? {}, timeoutMs: 60000 }));
app.post('/api/napcat/guard/heal', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/napcat/guard/heal', method: 'POST', body: req.body ?? {}, timeoutMs: 240000 }));
app.post('/api/napcat/quick-password', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/napcat/quick-password', method: 'POST', body: req.body ?? {}, timeoutMs: 300000 }));
/* 二维码现抓一份（base64 dataUrl）。要扫码时人在管理端，这条是唯一的救命路径。 */
app.get('/api/napcat/qr', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/napcat/qr', method: 'GET', timeoutMs: 60000 }));
/* 用量统计（/api/learning/token-report）——**两边都不漏**：
 * 【2026-09-14 主人要求】以前这条只代理到"活动目标桥"（连了服务器就只服务端、没连就只本机），
 * 于是"本机那份"在 SSH 模式下直接消失。现在本机 + 服务端各取一次，再合并出"合计"：
 *   { local, remote, total, remoteReason, remoteServer, report(=total，兼容旧前端) }
 * 服务端取不到时**不整条失败**：remote=null + remoteReason 一行原因，本机那份照常返回。 */
const TOKEN_REPORT_NUM_FIELDS = ['total', 'estTotal', 'prompt', 'completion', 'cacheRead', 'cacheWrite', 'cachePrompt', 'cacheCompletion', 'cacheSamples', 'samples', 'billedTotal'];

/** 把"桥连不上"翻译成人话：**连不上是状态（没在运行/隧道没开），不是"失败"（异常）**。
 *  以前这里直接把 `fetch failed` 抛给界面，本机没跑桥时面板上就常挂一行
 *  「本机桥对账失败：fetch failed」，主人会以为坏了——其实只是本机没启动桥（只用服务端时很正常）。 */
function bridgeUnreachableText(scope, base, detail) {
  const d = String(detail || '');
  const refused = /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|timed out|aborted|ETIMEDOUT/i.test(d);
  if (scope === 'remote') {
    return refused
      ? `服务端桥没在运行或 Bridge 隧道（13100）不通 —— ${base} 无响应`
      : `服务端桥读取失败：${d}`;
  }
  return refused
    ? `本机桥没在运行（${base} 无响应）—— 只用服务端时这条可以忽略，不影响服务端那份`
    : `本机桥读取失败：${d}`;
}

/** 取某一侧桥控制台的用量报告；失败回 { ok:false, error }，绝不抛 */
/* 【2026-09-16 修】服务端断开后，服务端那部分消耗要**继续计入合计**。
 * 症状：服务器一停（或 SSH 断开、Bridge 隧道不在），token-report 的 remote 就取不到，
 * 合计立刻只剩本机 —— 于是"总消耗"看起来凭空掉了一大截，用户以为服务端的用量丢了。
 * 事实是：服务端停着就不会再产生消耗，**上一次同步到的数字依然是准确的**（只是不再增长）。
 * 所以这里把每次成功取到的服务端报告缓存到 ~/.qq-bridge-manager，取不到时回退用它，
 * 并明确标成"上次同步"（remoteStale/remoteAt），不冒充实时值。 */
const REMOTE_TOKEN_CACHE_FILE = join(CONFIG_DIR, 'last-remote-token-report.json');
function readRemoteTokenCache() {
  try { return JSON.parse(readFileSync(REMOTE_TOKEN_CACHE_FILE, 'utf-8')); } catch { return null; }
}
function writeRemoteTokenCache(server, report) {
  try {
    writeFileSync(REMOTE_TOKEN_CACHE_FILE, JSON.stringify({
      serverId: server?.id ?? '', serverName: server?.name ?? '', host: server?.host ?? '', at: Date.now(), report,
    }, null, 2));
  } catch { /* 缓存写失败不影响本次响应 */ }
}
/** 取可用的缓存：换了服务器（activeServerId 与缓存不一致）就不复用，避免把 A 机器的用量算到 B 头上。 */
function remoteTokenCacheFor(server) {
  const c = readRemoteTokenCache();
  if (!c || !isObj(c.report)) return null;
  if (server?.id && c.serverId && c.serverId !== server.id) return null;
  return c;
}
function fmtCacheTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '未知时间';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function fetchTokenReportFrom(base, token, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(base + '/api/token-report', {
      headers: token ? { 'x-console-token': token } : {},
      signal: ctrl.signal,
    });
    const text = await resp.text();
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const json = text ? JSON.parse(text) : null;
    // 桥侧回包是 { ok, report:{...} }；兼容直接返回报告对象的旧桥
    const rep = json && typeof json === 'object' && json.report && typeof json.report === 'object' ? json.report : json;
    if (!rep || typeof rep !== 'object') return { ok: false, error: '响应里没有 report' };
    return { ok: true, report: rep };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally { clearTimeout(timer); }
}

/** 两份用量报告合并成"合计"。任何一侧缺字段按 0 计；只有一侧有数据就直接用那一侧。 */
function mergeTokenReports(a, b) {
  const clone = (v) => JSON.parse(JSON.stringify(v));
  if (!isObj(a)) return isObj(b) ? clone(b) : null;
  if (!isObj(b)) return clone(a);
  const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const sumInto = (dst, src) => { for (const k of TOKEN_REPORT_NUM_FIELDS) dst[k] = n0(dst[k]) + n0(src?.[k]); return dst; };
  const out = clone(a);
  out.today = sumInto(clone(a.today || {}), b.today || {});
  out.todayEstimatedTotal = n0(a.todayEstimatedTotal) + n0(b.todayEstimatedTotal);
  const mergeSeries = (listA, listB, keyOf) => {
    const map = new Map();
    for (const item of [...(Array.isArray(listA) ? listA : []), ...(Array.isArray(listB) ? listB : [])]) {
      const k = keyOf(item);
      if (!k) continue;
      map.set(k, map.has(k) ? sumInto({ ...map.get(k) }, item) : { ...item });
    }
    return [...map.values()].sort((x, y) => (keyOf(x) > keyOf(y) ? 1 : keyOf(x) < keyOf(y) ? -1 : 0));
  };
  out.dates = mergeSeries(a.dates, b.dates, (d) => String(d?.date ?? ''));
  out.todayHourly = mergeSeries(a.todayHourly, b.todayHourly, (h) => String(h?.hour ?? '')).sort((x, y) => Number(x.hour) - Number(y.hour));
  out.dayWindow = a.dayWindow || b.dayWindow;
  out.scope = 'total';
  out.note = (a.note && b.note && a.note !== b.note)
    ? `合计口径 = 本机 + 服务端。本机：${a.note}｜服务端：${b.note}`
    : (a.note || b.note || '');
  return out;
}

app.get('/api/learning/token-report', async (_req, res) => {
  const cfg = loadConfig();
  const connected = cfg.activeServerId ? cfg.servers.find((s) => s.id === cfg.activeServerId) || null : null;
  const out = { ok: true, at: Date.now(), mode: connected && sshConnections.has(connected.id) ? 'ssh' : 'local', local: null, remote: null, total: null, localReason: '', remoteReason: '', remoteServer: null, remoteStale: false, remoteAt: 0 };

  // ① 本机那份：永远保留（哪怕服务器连上了）——以前 SSH 模式把这块整个吞掉了
  try {
    const t = getLocalBridgeTarget();
    const r = await fetchTokenReportFrom(t.base, t.token);
    if (r.ok) out.local = r.report;
    else out.localReason = bridgeUnreachableText('local', t.base, r.error);
  } catch (e) {
    out.localReason = bridgeUnreachableText('local', getLocalBridgeTarget().base, String(e?.message || e));
  }

  // ② 服务端那份：只在"已连接 + Bridge 隧道在"时取；取不到不抛错，只回一行原因。
  //    取不到时（未连接 / 隧道不在 / 请求失败）回退到**上一次成功同步的服务端报告**：
  //    服务端停着不会再消耗，那份数字仍然准确，只是不再增长 —— 否则合计会突然只剩本机。
  const rt = resolveRemoteBridgeTarget();
  const useRemoteCache = (prefix) => {
    const c = remoteTokenCacheFor(connected);
    if (!c) return false;
    out.remote = c.report;
    out.remoteStale = true;
    out.remoteAt = c.at;
    out.remoteServer = { id: c.serverId, name: c.serverName, host: c.host };
    out.remoteReason = `${prefix}，显示上次同步到的服务端用量（${fmtCacheTime(c.at)}），仍计入合计`;
    return true;
  };
  if (!rt) {
    const why = (connected && sshConnections.has(connected.id))
      ? '服务器已连接，但 Bridge 隧道不在（重新连接一次 SSH 即可）'
      : '未连接服务器';
    if (!useRemoteCache(why)) out.remoteReason = why;
  } else {
    try {
      const token = await getRemoteBridgeToken(rt.server, rt.conn);
      const r = await fetchTokenReportFrom(rt.base, token);
      if (r.ok) {
        out.remote = r.report;
        out.remoteServer = { id: rt.server.id, name: rt.server.name, host: rt.server.host };
        writeRemoteTokenCache(rt.server, r.report);
      } else {
        const why = bridgeUnreachableText('remote', rt.base, r.error);
        if (!useRemoteCache(why)) out.remoteReason = why;
      }
    } catch (e) {
      const why = bridgeUnreachableText('remote', rt.base, String(e?.message || e));
      if (!useRemoteCache(why)) out.remoteReason = why;
    }
  }

  out.total = mergeTokenReports(out.local, out.remote);
  // 兼容旧前端/旧字段：顶层 report = 合计（只有一边时就是那一边）
  out.report = out.total || out.local || out.remote || null;
  res.json(out);
});

/* 用量对账（主人问「面板比真实值虚高/偏低」时加的）：让两侧桥各自与 DSH 的会话级权威计数
 * （storages/session_projcache 里的 tokenUsage.totals）比对，把被漏记的 usage 帧补成
 * reconciled 行。幂等：水位存在桥侧 state/token-reconcile.json，重复点不会重复补。
 * 与 token-report 一样，本机 + 服务端两边都试，任一侧失败不影响另一侧。 */
app.post('/api/learning/token-reconcile', async (_req, res) => {
  const out = { ok: true, at: Date.now(), local: null, remote: null, localReason: '', remoteReason: '', localSkipped: false, remoteSkipped: false };
  const call = async (base, token) => {
    const r = await fetch(base + '/api/token-reconcile', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-console-token': token } : {}) },
      body: '{}',
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error(j?.error || `HTTP ${r.status}`);
    return j;
  };
  try {
    const t = getLocalBridgeTarget();
    out.local = await call(t.base, t.token);
  } catch (e) {
    const raw = String(e?.message ?? e);
    out.localReason = bridgeUnreachableText('local', getLocalBridgeTarget().base, raw);
    out.localSkipped = true;   // 本机没跑桥：这是状态不是错误，界面按"已跳过"呈现
  }
  const rt = resolveRemoteBridgeTarget();
  if (rt) {
    try {
      const token = await getRemoteBridgeToken(rt.server, rt.conn);
      out.remote = await call(rt.base, token);
    } catch (e) {
      const raw = String(e?.message ?? e);
      out.remoteReason = bridgeUnreachableText('remote', rt.base, raw);
      out.remoteSkipped = /没在运行|不通/.test(out.remoteReason);
    }
  } else {
    out.remoteReason = '未连接服务器或 Bridge 隧道不在';
    out.remoteSkipped = true;
  }
  out.ok = !!(out.local || out.remote);
  mlog(`[token] 用量对账请求：本机 ${out.local ? (out.local.result?.addedTokens ?? 0) : '失败'} / 服务端 ${out.remote ? (out.remote.result?.addedTokens ?? 0) : '失败'}`);
  res.json(out);
});

app.get('/api/learning/slang-library', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/slang', method: 'GET' }));

/* 用量实时推流：把桥的 SSE 原样透传给浏览器（同源，前端无需直连 3100）。
   注意不能走 proxyToBridgeConsole —— 那条路径会 res.text() 把流读干。 */
app.get('/api/learning/token-stream', async (req, res) => {
  let t;
  try { t = resolveBridgeTarget(); } catch (e) {
    return res.status(503).json({ success: false, code: 'bridge-offline', message: String(e?.message || e) });
  }
  let token = null;
  try { token = t.kind === 'remote' ? await getRemoteBridgeToken(t.server, t.conn) : t.token; } catch { /* 无令牌也试一次 */ }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const ctrl = new AbortController();
  let closed = false;
  // 只认「响应侧 close」＝浏览器断开。不能挂 req 的 close：IncomingMessage 在请求体读完时
  // 就会发 close，会立刻把上游 SSE 连接 abort 掉（表现为 stream-error: fetch failed）。
  const onClose = () => { closed = true; ctrl.abort(); };
  res.on('close', onClose);

  const send = (event, data) => { if (!closed) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 忽略 */ } } };

  try {
    const resp = await fetch(t.base + '/api/token-stream', {
      headers: { Accept: 'text/event-stream', ...(token ? { 'x-console-token': token } : {}) },
      signal: ctrl.signal,
    });
    if (!resp.ok || !resp.body) {
      send('stream-error', { message: `目标桥不可达或版本过旧（HTTP ${resp.status}）` });
      return res.end();
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (closed) break;
      res.write(dec.decode(value, { stream: true }));
    }
  } catch (e) {
    if (!closed) send('stream-error', { message: String(e?.message || e) });
  } finally {
    try { res.end(); } catch { /* 忽略 */ }
  }
});

/* ------------------------------------------------------------------ */
/* 群友画像 / 主人画像（直读本机桥 memory.db，只读；与桥是否在线无关）     */
/* ------------------------------------------------------------------ */
/** 主人 QQ：优先读本机桥 config.json 的 ownerQQ（不硬编码账号），否则环境变量，最后空 */
function resolveOwnerQQ() {
  try {
    const p = bridgeCfgPath();
    if (existsSync(p)) {
      const c = JSON.parse(readFileSync(p, 'utf-8'));
      const q = String(c?.ownerQQ ?? '').trim();
      if (/^\d{5,11}$/.test(q)) return q;
    }
  } catch { /* 读不到就降级 */ }
  return String(process.env.QBM_OWNER_QQ || '').trim() || '';
}
const OWNER_QQ = resolveOwnerQQ();
const DAY_MS = 86400000;

/** 只读打开本机桥的 memory.db：readOnly + 短 busy 超时（桥可能在写，绝不加锁） */
async function openBridgeMemoryDbRo() {
  const dir = findBridgeDir();
  const cands = [join(dir, 'state', 'memory.db'), join(dir, 'memory.db')];
  const p = cands.find((c) => existsSync(c));
  if (!p) throw new Error(`找不到桥记忆库 memory.db（已探测 ${cands.join(' / ')}），请先让桥至少跑过一次`);
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(p, { readOnly: true, timeout: 800 });
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const hasHan = (s) => /[\u4e00-\u9fff]/.test(String(s));
const clampInt = (v, min, max, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

/** 标签切词：按顿号/逗号/分号/句号/空白等切分；过长(>24)、过短(<2)、纯数字、无中文、噪声词丢弃 */
const TAG_SPLIT_RE = /[、,，;；。．.！!？?：:\s\n\r\t"'“”‘’()（）\[\]【】{}<>《》…~\-—_*#/\\|]+/;
const TAG_NOISE = new Set(['已纠正', '主人', '主人说', '备注', '个人', '个性', '性格', '聊天', '说话', '消息']);
function splitFieldTags(fields, cap) {
  const out = [];
  const seen = new Set();
  const capN = clampInt(cap, 1, 20, 8);
  for (const f of fields) {
    if (!f) continue;
    for (const raw of String(f).split(TAG_SPLIT_RE)) {
      const s = raw.trim();
      if (s.length < 2 || s.length > 24) continue;
      if (!hasHan(s) || /^\d+$/.test(s)) continue;
      if (/\d{4}/.test(s) || /[：:]/.test(s)) continue;      // 年份/带冒号的指令句不进标签
      if (TAG_NOISE.has(s) || s.startsWith('主人')) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (out.length >= capN) return out;
    }
  }
  return out;
}

/** 近30d 记忆内容 → 兴趣词频（CJK 二元组启发式，无分词库；停用字断词） */
const BIGRAM_STOP_CHARS = new Set('的了我你他她它们是在就和也有都与及或被把让不要会而要于从对给向以一这下上那这来去着说得很过再只又但更最每今到几昨边');
function countCjkBigrams(text, map) {
  const run = [];
  for (const ch of String(text ?? '')) {
    if (!hasHan(ch)) { run.length = 0; continue; }
    if (BIGRAM_STOP_CHARS.has(ch)) { run.length = 0; continue; }
    run.push(ch);
    if (run.length >= 2) {
      const w = run[run.length - 2] + run[run.length - 1];
      map.set(w, (map.get(w) || 0) + 1);
    }
  }
}
function memoryTopWords(entries, cap) {
  const map = new Map();
  for (const e of entries) {
    let text = String(e?.content ?? '');
    // 去掉“我主动发了一条空间说说：/人格学习:样本 x 条”等自带前缀再统计
    const m = text.match(/^[^：:]{0,30}[：:]\s*(.*)$/s);
    if (m) text = m[1];
    text = text.replace(/样本\s*\d+\s*条[，,]?/g, ' ').replace(/\s+/g, ' ');
    countCjkBigrams(text, map);
  }
  return [...map.entries()]
    .map(([w, c]) => ({ w, c }))
    .sort((a, b) => b.c - a.c || a.w.localeCompare(b.w, 'zh'))
    .slice(0, clampInt(cap, 1, 30, 18));
}

/** 读取 state/persona-library.json（若存在），返回某 uid 的**完整**人格档案。
 *  【2026-09-14 主人反馈】旧版这里把 personality 截到 200、chatHabits/relationshipAdvice 截到 120、
 *  topics 只留 5 条 —— 界面展开卡片看到的永远是半句话，主人以为"学习没学全"。
 *  现在原样返回（含成文画像 profile 字段），界面要折叠自己折叠，数据层不再提前砍。 */
function personaLibraryEntry(uid) {
  try {
    const f = join(findBridgeDir(), 'state', 'persona-library.json');
    if (!existsSync(f)) return null;
    const lib = JSON.parse(readFileSync(f, 'utf-8'));
    const it = isObj(lib) ? lib[String(uid)] : null;
    if (!it || typeof it !== 'object') return null;
    const strArr = (v) => (Array.isArray(v) ? v.map((x) => String(x ?? '')).filter(Boolean) : []);
    const catchphrases = Array.isArray(it.catchphrases)
      ? it.catchphrases.map((c) => (isObj(c) ? { phrase: String(c.phrase ?? ''), context: String(c.context ?? '') } : { phrase: String(c ?? ''), context: '' }))
        .filter((c) => c.phrase)
      : [];
    const style = isObj(it.style)
      ? {
        sentenceLength: String(it.style.sentenceLength ?? ''),
        rhetoricalQuestions: String(it.style.rhetoricalQuestions ?? ''),
        toneWords: String(it.style.toneWords ?? ''),
        examples: strArr(it.style.examples),
      }
      : null;
    return {
      nickname: String(it.nickname ?? '') || null,
      addressTerms: String(it.addressTerms ?? ''),
      profile: String(it.profile ?? '') || null,
      personality: String(it.personality ?? '') || null,
      // 人格学习产出的**英文人设正文**（2026-09-15 新增）：界面「人物资料 / 完整资料」里也要能看到，
      // 所以在这条组装里一并透出（审批与覆盖动作仍走桥侧 /api/learning/persona-apply）。
      personaEn: String(it.personaEn ?? '') || null,
      personaEditedAtMs: Number(it.personaEditedAtMs) || 0,
      personaAppliedAtMs: Number(it.personaAppliedAtMs) || 0,
      profile: String(it.profile ?? '') || null,
      personality: String(it.personality ?? '') || null,
      chatHabits: String(it.chatHabits ?? ''),
      emojiHabits: String(it.emojiHabits ?? ''),
      relationshipAdvice: String(it.relationshipAdvice ?? ''),
      style,
      catchphrases,
      topics: strArr(it.topics),
      taboos: strArr(it.taboos),
      samples: Number(it.samples) || 0,
      learnedAtMs: Number(it.learnedAtMs) || 0,
    };
  } catch { return null; }
}

/** 一次查询：近 N 天消息数/最近时间统计（direction=in 且非自己） */
function msgStatsSince(db, sinceMs) {
  const rows = db.prepare(
    "SELECT sender_uid AS uid, COUNT(*) AS c, MAX(ts_ms) AS last FROM chat_messages WHERE direction='in' AND is_self=0 AND ts_ms >= ? AND sender_uid != '' GROUP BY sender_uid"
  ).all(sinceMs);
  return rows;
}
/** 有私聊往来(近 N 天)的 uid 集合：conv_key='private:<uid>' */
function privateConvUids(db, sinceMs) {
  return db.prepare(
    "SELECT DISTINCT substr(conv_key, 9) AS uid FROM chat_messages WHERE conv_key LIKE 'private:%' AND ts_ms >= ? AND uid != ''"
  ).all(sinceMs).map((r) => String(r.uid));
}

/** 群聊同现对计数（近14d，10 分钟桶；行数超阈值时按行采样 25%） */
function groupCooccurPairs(db, sinceMs) {
  const where = "conv_key LIKE 'group:%' AND direction='in' AND is_self=0 AND ts_ms >= ? AND sender_uid != ''";
  let sql = `SELECT conv_key, sender_uid, ts_ms FROM chat_messages WHERE ${where} ORDER BY conv_key, ts_ms ASC`;
  let params = [sinceMs];
  try {
    const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM chat_messages WHERE ${where}`).get(sinceMs)?.c || 0);
    if (total > 200000) { // 数据量极大：仅取约 25% 行再统计（足够近似）
      sql = `SELECT conv_key, sender_uid, ts_ms FROM chat_messages WHERE ${where} AND (abs(random()) % 100) < 25 ORDER BY conv_key, ts_ms ASC`;
      params = [sinceMs];
    }
  } catch { /* 计数失败就全量走 */ }
  const rows = db.prepare(sql).all(...params);
  const raw = new Map(); // 'a|b'(a<b) → 同现次数
  const bump = (a, b) => {
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    raw.set(k, (raw.get(k) || 0) + 1);
  };
  let conv = null, bucket = -1, set = [];
  const flush = () => {
    const uids = [...new Set(set)];
    if (uids.length >= 2 && uids.length <= 120) {
      for (let i = 0; i < uids.length; i++) for (let j = i + 1; j < uids.length; j++) bump(uids[i], uids[j]);
    }
    set = [];
  };
  for (const r of rows) {
    if (r.conv_key !== conv) { flush(); conv = r.conv_key; bucket = -1; }
    const b = Math.floor(Number(r.ts_ms || 0) / 600000);
    if (b !== bucket) { flush(); bucket = b; }
    set.push(String(r.sender_uid));
  }
  flush();
  return raw;
}

app.get('/api/learning/profile', async (req, res) => {
  // 单人**完整**资料（不做长度截断）：图谱接口为了体积把 personality/likes/notes 截到 200~260 字符，
  // 展开卡片时看不到全文（主人踩到的就是这个）。这里直读 memory.db，原样返回。
  const uid = String(req.query?.uid ?? '').trim();
  if (!/^\d{5,11}$/.test(uid)) return res.status(400).json({ ok: false, error: 'uid 必须是 5~11 位数字 QQ 号' });
  let db = null;
  try {
    db = await openBridgeMemoryDbRo();
    const cut30 = Date.now() - 30 * DAY_MS;
    const p = db.prepare('SELECT uid, name, personality, likes, dislikes, birthday, notes, updated_at FROM profiles WHERE uid = ?').get(uid) || null;
    const persona = db.prepare("SELECT content, created_at FROM memory_entries WHERE uid = ? AND category = 'persona' ORDER BY created_at DESC LIMIT 1").get(uid) || null;
    const stat = db.prepare("SELECT COUNT(*) AS c, MAX(ts_ms) AS last FROM chat_messages WHERE sender_uid = ? AND is_self = 0 AND direction = 'in' AND ts_ms >= ?").get(uid, cut30) || null;
    const mc = db.prepare('SELECT COUNT(*) AS c FROM memory_entries WHERE uid = ?').get(uid) || null;
    res.json({
      ok: true, uid,
      profile: p ? {
        uid: String(p.uid), name: String(p.name ?? ''), personality: String(p.personality ?? ''),
        likes: String(p.likes ?? ''), dislikes: String(p.dislikes ?? ''), birthday: String(p.birthday ?? ''),
        notes: String(p.notes ?? ''), updatedAt: Number(p.updated_at) || 0,
      } : null,
      personaSummary: persona ? String(persona.content ?? '') : '',
      personaAt: Number(persona?.created_at) || 0,
      // 结构化人格档案（昵称/称呼/风格/口头禅/话题/忌讳/相处建议 + 成文画像），原样返回不做截断，
      // 界面展开卡片据此显示完整介绍。旧版这里不带 library，界面只有 profiles 表里那几行短字段。
      library: personaLibraryEntry(uid),
      msgCount: Number(stat?.c) || 0,
      lastSeen: Number(stat?.last) || 0,
      memoryCount: Number(mc?.c) || 0,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

app.get('/api/learning/graph', async (_req, res) => {
  let db = null;
  try {
    db = await openBridgeMemoryDbRo();
    const now = Date.now();
    const cut30 = now - 30 * DAY_MS;
    const cut14 = now - 14 * DAY_MS;
    const stats = msgStatsSince(db, cut30);
    const statMap = new Map(stats.map((r) => [String(r.uid), { c: Number(r.c) || 0, last: Number(r.last) || 0 }]));
    const privateUids = new Set(privateConvUids(db, cut30));

    const profiles = db.prepare("SELECT uid, name, personality, likes, dislikes, birthday, notes, updated_at FROM profiles WHERE name IS NOT NULL AND name != ''").all();
    const personaEntries = db.prepare("SELECT uid, category, content FROM memory_entries WHERE category = 'persona'").all();
    const personaByUid = new Map();
    for (const e of personaEntries) personaByUid.set(String(e.uid), String(e.content ?? '').slice(0, 160));
    // 非 profile 群成员兜底名：取最近一条 in 消息的 sender_name
    const lastNames = new Map();
    const knownProfileUids = new Set(profiles.map((p) => String(p.uid)));
    const nameSql = `SELECT sender_uid AS uid, sender_name AS n FROM chat_messages WHERE direction='in' AND is_self=0 AND ts_ms >= ? AND sender_uid != '' ORDER BY ts_ms DESC`;
    for (const r of db.prepare(nameSql).all(cut30)) {
      const u = String(r.uid);
      if (knownProfileUids.has(u) || lastNames.has(u)) continue;
      const n = String(r.n ?? '').trim();
      if (n && n !== '私聊') lastNames.set(u, n.slice(0, 40));
    }

    // —— 节点：profiles(name!='') 全量人物底 + 近30d 出现过的其他发送者 ——
    const nodes = [];
    const nodeSeen = new Set();
    for (const p of profiles) {
      const uid = String(p.uid);
      if (!uid || nodeSeen.has(uid)) continue;
      nodeSeen.add(uid);
      const st = statMap.get(uid);
      const kind = uid === OWNER_QQ ? 'owner' : (privateUids.has(uid) ? 'friend' : 'member');
      const extra = {};
      if (String(p.birthday ?? '')) extra.birthday = String(p.birthday);
      if (String(p.personality ?? '')) extra.personality = String(p.personality).slice(0, 200);
      if (String(p.likes ?? '')) extra.likes = String(p.likes).slice(0, 200);
      if (String(p.notes ?? '')) extra.notes = String(p.notes).slice(0, 260);
      const ps = personaByUid.get(uid);
      if (ps) extra.personaSummary = ps;
      const tags = splitFieldTags([p.personality, p.likes, String(p.notes ?? '').split(/[。；;]/).slice(0, 3).join('、')], 5);
      nodes.push({
        uid,
        name: String(p.name ?? '').slice(0, 60) || uid,
        kind, tags, msgCount: st?.c || 0, lastSeen: st?.last || null,
        ...extra,
      });
    }
    // 近30d 出现过、无 profile 的发送者（群成员/私聊对象兜底节点）
    for (const s of stats) {
      const uid = String(s.uid);
      if (nodeSeen.has(uid)) continue;
      const n = lastNames.get(uid) || '';
      if (!n && !privateUids.has(uid)) continue; // 无名又无私聊 → 跳过杂讯
      nodeSeen.add(uid);
      nodes.push({
        uid,
        name: String(n).slice(0, 60) || uid,
        kind: uid === OWNER_QQ ? 'owner' : (privateUids.has(uid) ? 'friend' : 'member'),
        tags: [],
        msgCount: Number(s.c) || 0,
        lastSeen: Number(s.last) || null,
      });
    }

    // —— 边：同群同现(近14d) + 私聊互动(近30d, 计为 主人↔对方) ——
    const raw = groupCooccurPairs(db, cut14);
    const privRows = db.prepare("SELECT conv_key, COUNT(*) AS c FROM chat_messages WHERE conv_key LIKE 'private:%' AND ts_ms >= ? GROUP BY conv_key").all(cut30);
    for (const r of privRows) {
      const uid = String(r.conv_key).slice(8); // 'private:' 后是对方 uid
      if (!uid || uid === OWNER_QQ || uid === '') continue;
      raw.set(uid < OWNER_QQ ? `${uid}|${OWNER_QQ}` : `${OWNER_QQ}|${uid}`, (raw.get(uid < OWNER_QQ ? `${uid}|${OWNER_QQ}` : `${OWNER_QQ}|${uid}`) || 0) + (Number(r.c) || 0));
    }
    const maxRaw = Math.max(0, ...[...raw.values()]);
    const links = [];
    if (maxRaw > 0) {
      const logMax = Math.log(1 + maxRaw);
      for (const [k, v] of raw.entries()) {
        const [a, b] = k.split('|');
        if (!nodeSeen.has(a) || !nodeSeen.has(b) || a === b) continue;
        const strength = maxRaw > 1
          ? 0.05 + 0.95 * (Math.log(1 + v) / logMax)
          : 1;
        links.push({ from: a, to: b, strength: Math.round(strength * 1000) / 1000 });
      }
      links.sort((x, y) => y.strength - x.strength);
    }

    res.json({
      ok: true,
      nodes,
      links,
      meta: { ownerQQ: OWNER_QQ, nodeCount: nodes.length, linkCount: links.length, generatedAt: new Date().toISOString() },
    });
  } catch (e) {
    console.error('[graph]', e?.message || e);
    res.status(200).json({ ok: false, message: '群友画像读取失败', detail: String(e?.message || e) });
  } finally {
    try { db?.close(); } catch {}
  }
});

app.get('/api/learning/owner-profile', async (_req, res) => {
  let db = null;
  try {
    db = await openBridgeMemoryDbRo();
    const now = Date.now();
    const cut30 = now - 30 * DAY_MS;
    const ownerRow = db.prepare("SELECT uid, name, personality, likes, dislikes, birthday, notes, updated_at FROM profiles WHERE uid = ?").get(OWNER_QQ);
    const stats = msgStatsSince(db, cut30);
    const st = stats.find((r) => String(r.uid) === OWNER_QQ);
    const memRows = db.prepare("SELECT category, content, created_at FROM memory_entries WHERE uid = ? AND created_at >= ? ORDER BY created_at DESC").all(OWNER_QQ, cut30);
    const owner = ownerRow ? {
      uid: OWNER_QQ,
      name: String(ownerRow.name ?? '').slice(0, 60) || '主人',
      birthday: String(ownerRow.birthday ?? '') || null,
      personality: String(ownerRow.personality ?? '').slice(0, 300) || null,
      likes: String(ownerRow.likes ?? '').slice(0, 300) || null,
      dislikes: String(ownerRow.dislikes ?? '').slice(0, 200) || null,
      notes: String(ownerRow.notes ?? '').slice(0, 300) || null,
      updatedAtMs: Number(ownerRow.updated_at) || 0,
    } : { uid: OWNER_QQ, name: '主人', birthday: null, personality: null, likes: null, dislikes: null, notes: null, updatedAtMs: 0 };

    const profileTags = splitFieldTags([owner.personality, owner.likes, owner.dislikes, owner.notes], 12);
    const memoryTop = memoryTopWords(memRows, 18);
    const persona = personaLibraryEntry(OWNER_QQ);

    res.json({
      ok: true,
      owner,
      profileTags,
      memoryTop,
      persona,
      msgCount30d: Number(st?.c) || 0,
      lastSeenAt: Number(st?.last) || null,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[owner-profile]', e?.message || e);
    res.status(200).json({ ok: false, message: '主人画像读取失败', detail: String(e?.message || e) });
  } finally {
    try { db?.close(); } catch {}
  }
});

/* 某人最近"发过的消息"(画像档案里的历史消息), 直读本机桥 memory.db chat_messages */
app.get('/api/learning/messages', async (req, res) => {
  let db = null;
  try {
    const uid = String(req.query.uid ?? '').trim();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    if (!/^\d{5,11}$/.test(uid)) { res.json({ ok: false, error: 'uid 无效' }); return; }
    db = await openBridgeMemoryDbRo();
    const where = ["direction='in'", 'is_self=0', `content != ''`, 'sender_uid = ?'];
    const params = [uid];
    const conv = String(req.query.conv ?? '').trim();
    if (conv) { where.push('conv_key = ?'); params.push(conv); }
    const rows = db.prepare(
      `SELECT conv_key, sender_name, content, kind, ts, ts_ms FROM chat_messages WHERE ${where.join(' AND ')} ORDER BY ts_ms DESC, id DESC LIMIT ?`
    ).all(...params, limit);
    const messages = rows.map((r) => ({
      conv: String(r.conv_key ?? ''), sender: String(r.sender_name ?? ''), content: String(r.content ?? ''),
      kind: String(r.kind ?? 'text'), ts: String(r.ts ?? ''), tsMs: Number(r.ts_ms) || 0,
    }));
    res.json({ ok: true, uid, messages });
  } catch (e) {
    console.error('[learning/messages]', e?.message || e);
    res.status(200).json({ ok: false, message: '消息读取失败', detail: String(e?.message || e) });
  } finally {
    try { db?.close(); } catch {}
  }
});

/* 画像自动刷新设置(manager 侧文件) */
const PORTRAIT_CFG_FILE = join(CONFIG_DIR, 'portrait-config.json');
function readPortraitCfg() {
  try {
    const c = JSON.parse(readFileSync(PORTRAIT_CFG_FILE, 'utf8'));
    return { enabled: c.enabled !== false, intervalDays: Math.max(1, Math.min(90, Number(c.intervalDays) || 7)), lastAt: Number(c.lastAt) || 0 };
  } catch { return { enabled: true, intervalDays: 7, lastAt: 0 }; }
}
app.get('/api/learning/portrait-config', (_req, res) => res.json({ ok: true, ...readPortraitCfg() }));
app.put('/api/learning/portrait-config', (req, res) => {
  try {
    const b = req.body ?? {};
    const cfg = { ...readPortraitCfg(), enabled: b.enabled !== false, intervalDays: Math.max(1, Math.min(90, Number(b.intervalDays) || 7)), lastAt: b.lastAt ? Number(b.lastAt) : (readPortraitCfg().lastAt || 0) };
    writeFileSync(PORTRAIT_CFG_FILE, JSON.stringify(cfg, null, 2));
    res.json({ ok: true, ...cfg });
  } catch (e) { res.status(200).json({ ok: false, message: String(e?.message || e) }); }
});

/* 群列表 + 群成员(群友画像"选群/定位"用), 直读 memory.db chat_messages + profiles */
app.get('/api/learning/groups', async (req, res) => {
  let db = null;
  try {
    db = await openBridgeMemoryDbRo();
    const rows = db.prepare(
      "SELECT conv_key, sender_uid, COUNT(*) c, MAX(ts_ms) last FROM chat_messages WHERE conv_key LIKE 'group:%' AND direction='in' AND is_self=0 AND sender_uid != '' AND sender_uid != 'self' AND ts_ms >= ? GROUP BY conv_key, sender_uid ORDER BY conv_key, c DESC"
    ).all(Date.now() - 90 * DAY_MS);
    const groups = new Map();
    for (const r of rows) {
      const g = groups.get(String(r.conv_key)) || { id: String(r.conv_key), members: [] };
      const nameRow = db.prepare('SELECT name FROM profiles WHERE uid = ? AND name != \'\' ORDER BY updated_at DESC LIMIT 1').get(String(r.sender_uid));
      const name = nameRow?.name ? String(nameRow.name).split(/[（(]/)[0].trim() : '';
      g.members.push({ uid: String(r.sender_uid), name, count: Number(r.c) || 0, last: Number(r.last) || 0 });
      groups.set(String(r.conv_key), g);
    }
    const out = [];
    for (const g of groups.values()) {
      g.members.sort((a, b) => b.count - a.count);
      g.members = g.members.slice(0, 60);
      out.push(g);
    }
    res.json({ ok: true, groups: out });
  } catch (e) {
    console.error('[learning/groups]', e?.message || e);
    res.status(200).json({ ok: false, message: String(e?.message || e), groups: [] });
  } finally {
    try { db?.close(); } catch {}
  }
});

/* 关系标注(画像图线颜色): 存 CONFIG_DIR/relations.json, key='小uid|大uid' */
const RELATIONS_FILE = join(CONFIG_DIR, 'relations.json');
const REL_CATS = ['guimi', 'jiaren', 'qinglv', 'chouren', 'qunyou'];
function readRelations() {
  try { const o = JSON.parse(readFileSync(RELATIONS_FILE, 'utf8')); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
function pairKey(a, b) { const x = String(a), y = String(b); return x < y ? `${x}|${y}` : `${y}|${x}`; }
app.get('/api/learning/relations', (_req, res) => res.json({ ok: true, relations: readRelations() }));
app.put('/api/learning/relations', (req, res) => {
  try {
    const b = req.body ?? {};
    const a = String(b.a ?? '').trim(), c = String(b.b ?? '').trim();
    if (!/^\d{5,11}$/.test(a) || !/^\d{5,11}$/.test(c)) { res.json({ ok: false, message: 'QQ 号无效' }); return; }
    const cat = String(b.category ?? '').trim();
    const rels = readRelations();
    if (!cat) delete rels[pairKey(a, c)];
    else { if (!REL_CATS.includes(cat)) { res.json({ ok: false, message: '未知关系类别' }); return; } rels[pairKey(a, c)] = cat; }
    writeFileSync(RELATIONS_FILE, JSON.stringify(rels, null, 2));
    res.json({ ok: true, relations: rels });
  } catch (e) { res.status(200).json({ ok: false, message: String(e?.message || e) }); }
});

/* ------------------------------------------------------------------ */
/* 一键克隆部署(把整套克隆到新服务器)                                    */
/* ------------------------------------------------------------------ */
/** 从 config.servers 解析服务器(允许直接传对象——SSH 页未保存的新条目也能部署) */
function resolveServer(raw, cfg) {
  if (!raw) return null;
  if (typeof raw === 'object' && raw.host) return raw;
  return cfg.servers.find((s) => s.id === String(raw)) ?? null;
}

/**
 * 「从本机复刻」的源描述：把本机当前运行中的整套所在目录告诉部署引擎。
 * 路径全部现场探测（不写死），缺哪份就只克隆有的那几份，并在日志里说明。
 */
function localCloneSource() {
  const cfg = loadConfig();
  const bridgeDir = findBridgeDir();
  const dshHome = String(cfg.instances?.dshIsolated?.isolatedHome || '') || DEFAULT_ISOLATED_HOME;
  const onekey = findNapcatOneKey();
  const napcatConfigDir = onekey ? findNapcatConfigDir(onekey.dir) : null;
  // 鲸鱼娘表情库（存在才带）
  const memeCandidates = [
    join(dirname(bridgeDir || ''), 'meme', 'whale-fanart-001'),
    join(homedir(), '.dsh', 'meme-packs', 'whale-fanart-001'),
  ];
  const memeDir = memeCandidates.find((d) => { try { return existsSync(join(d, 'index.db')); } catch { return false; } }) || null;
  // 本机 DSH CLI 版本（目标机跟随安装，避免 preset/插件版本对不上）
  let dshVersion = '';
  try {
    const pkg = JSON.parse(readFileSync(join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    dshVersion = String(pkg.version || '');
  } catch { /* 拿不到就让部署引擎用默认 */ }
  return {
    local: true,
    name: '本机（这台电脑）',
    paths: { bridgeDir, dshHome, napcatConfigDir, memeDir },
    dshVersion,
  };
}

/* 发起克隆部署: body { source(源=模板机 id 或对象 / sourceKind:'local'), target(目标机 id 或对象), qqData? } */
app.post('/api/ssh/deploy/start', (req, res) => {
  const cfg = loadConfig();
  const useLocal = req.body?.sourceKind === 'local' || req.body?.source?.local === true;
  const target = resolveServer(req.body?.target, cfg);
  if (!target) return res.status(400).json({ success: false, message: '缺少有效的目标服务器(请在 SSH 配置页先添加)' });
  let source = null;
  let opts = { qqData: req.body?.qqData };
  if (useLocal) {
    const local = localCloneSource();
    source = { local: true, name: local.name };
    const missing = [];
    if (!local.paths.bridgeDir) missing.push('qq-bridge（桥代码/配置/记忆数据）');
    if (!local.paths.dshHome || !existsSync(local.paths.dshHome)) missing.push('隔离 DSH home（会话/人设/preset）');
    if (!local.paths.napcatConfigDir) missing.push('NapCat config（含登录令牌）');
    if (!local.paths.bridgeDir || !existsSync(local.paths.dshHome)) {
      return res.status(400).json({ success: false, message: `本机缺少可复刻的数据：${missing.join('、')}。请先在本机把整套跑起来再试。` });
    }
    mlog(`[deploy] 从本机复刻 → ${target.name}：bridge=${local.paths.bridgeDir} dsh=${local.paths.dshHome} napcatCfg=${local.paths.napcatConfigDir || '(无)'} meme=${local.paths.memeDir || '(无)'} dshVer=${local.dshVersion || '默认'}`);
    opts = { ...opts, localSource: true, localPaths: local.paths, dshVersion: local.dshVersion, uploadFile: uploadLocalFileToRemote };
  } else {
    source = resolveServer(req.body?.source, cfg);
    if (!source) return res.status(400).json({ success: false, message: '缺少有效的源服务器(或选择「本机」作为源)' });
    // 不允许把服务器克隆到自己(同主机同端口视为同一台)
    if (String(source.host).trim() === String(target.host).trim() && Number(source.port || 22) === Number(target.port || 22)) {
      return res.status(400).json({ success: false, message: '源与目标是同一台机器, 无法克隆' });
    }
  }
  const taskId = deploy.start(source, target, opts);
  res.json({ success: true, taskId, source: useLocal ? 'local' : 'server' });
});

/* 查询部署任务状态与日志 */
app.get('/api/ssh/deploy/status', (req, res) => {
  const st = deploy.status(String(req.query.taskId || ''));
  if (!st) return res.status(404).json({ success: false, message: '任务不存在或已过期(完成后保留 1 小时)' });
  res.json({ success: true, ...st });
});

/* 列出仍可查询的部署任务 */
app.get('/api/ssh/deploy/tasks', (_req, res) => {
  res.json({ success: true, tasks: deploy.list?.() ?? [] });
});


const distDir = join(RUNTIME_ROOT, 'dist');
if (existsSync(join(distDir, 'index.html'))) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(distDir, 'index.html')));
}

// 【保命护栏】管理器里跑着一堆后台任务（部署/同步/重启实例）。任何一个漏掉 catch 的 rejection 都会让
// Node 直接结束进程 —— 而它一死，界面打不开、实例状态机也不再推进。宁可丢一个任务的异常，不能丢管理器。
process.on('unhandledRejection', (err) => {
  try { mlog(`[fatal-guard] 未处理的 Promise 异常（已拦下，不退出）：${err?.stack || err?.message || err}`); } catch { /* ignore */ }
});
process.on('uncaughtException', (err) => {
  try { mlog(`[fatal-guard] 未捕获异常（已拦下，不退出）：${err?.stack || err?.message || err}`); } catch { /* ignore */ }
});

const PORT = Number(process.env.QBM_API_PORT || 1921);// QBM_NO_LISTEN=1 时只导出 app 不监听端口（供 node --check / 一次性集成测试自起临时端口）
if (process.env.QBM_NO_LISTEN !== '1') {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[QQ-Bridge Manager API] http://127.0.0.1:${PORT}`);
    scheduleAutoStart();
    ensureGuardianArmed();
    /* 【2026-09-15 主人反馈"本地没显示服务端运行中"】管理器一启动就把上次连着的那台服务器连回来：
     * 连接表在内存里（进程重启就空），以前打开应用永远显示"服务端未运行"，非要人手点一次「连接」。
     * 延迟 1.5s 等后端自己稳下来；冷却中则交给 scheduleReconnect 的冷却分支处理。 */
    setTimeout(() => {
      try {
        const cfg2 = loadConfig();
        const srv = cfg2.activeServerId ? cfg2.servers.find((s) => s.id === cfg2.activeServerId) : null;
        if (!srv) return;
        if (sshConnections.has(srv.id)) return;
        mlog(`[ssh] 启动自动连接 ${srv.name || srv.host}…`);
        scheduleReconnect(srv.id, 'startup');
      } catch (e) { mlog(`[ssh] 启动自动连接失败：${e?.message ?? e}`); }
    }, 1500).unref?.();
    // 每 60s 复查：应用可能是"复用已在跑的后端"打开的，那一路上没有新后端去自动武装，
    // 靠这个定时复查把守卫补上（应用没开时什么都不做）。
    const gTimer = setInterval(ensureGuardianArmed, 60000);
    gTimer.unref?.();
  });
}

/* ============================================================================
 * NapCat 守卫（2026-09-13，主人要求："应用进程关闭时，NapCat 进程也要关闭"）
 *
 * 关窗时 Electron 壳走的是 `taskkill /pid <后端> /T /F` —— 管理器**被强杀**、跑不到任何清理代码；
 * 而 NapCat 是 wscript 拉起的游离进程（NapCatWinBootMain.exe → 注入 QQ.exe），不在那个进程树里，
 * 所以以前"关掉应用，NapCat 还挂在后台"。解决办法是一个**活过后端**的守卫进程
 * （server/napcat-guardian.mjs）：它盯着后端 PID，后端一没，就把 NapCat/桥/DSH 一起收掉。
 *
 * 只在"父进程就是应用本体(MoonBot.exe)"时才武装 —— 这样不会把 wscript 拉完即退、双击 qbm-node、
 * cmd 里 node server/index.js 这些启动方式误判成"应用关了"（否则一开机就会把 NapCat 杀掉）。
 * 想强制开/关：环境变量 QBM_NAPCAT_GUARDIAN=1 / 0。
 * 管理器**正常重启**不会误杀：新后端起来第一件事就是接管守卫（杀旧守卫 + 改写 guard 文件），
 * 旧守卫动手前会再核对一次 guard 文件，发现"已归新后端"就静默退出。
 */
const GUARDIAN_FILE = join(CONFIG_DIR, 'napcat-guardian.json');
function parentProcessName(pid) {
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty ProcessName)`],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 8000, encoding: 'utf8' });
    return String(r.stdout || '').trim();
  } catch { return ''; }
}
function guardianFromFile() {
  try {
    const rec = JSON.parse(readFileSync(GUARDIAN_FILE, 'utf8'));
    return { pid: Number(rec?.pid) || 0, parentPid: Number(rec?.parentPid) || 0 };
  } catch { return { pid: 0, parentPid: 0 }; }
}
/** 把守卫进程"送出去"：spawn 出来的子进程会被壳的 `taskkill /T` 连坐杀掉，所以要用两招脱身：
 *   ① **换个可执行文件路径**：壳的兜底清理是按 `$_.Path -eq '<runtime>\qbm-node.exe'` 精确匹配的，
 *      所以给守卫做一个**硬链接**（同盘、零额外空间）放在 server\ 下，路径不同即不被命中；
 *   ② **用 WMI 创建进程**：这样它的父进程是 WmiPrvSE.exe 而不是本管理器，
 *      `taskkill /T`（顺父链枚举）就够不着它了。守卫的"要盯谁"由 `--parent` 显式传进去，不依赖真实父进程。
 * 返回 { pid, exe }（失败返回 { pid: 0, error }）。导出是为了回归测试能复用同一条路径。 */
export function spawnGuardianDetached(scriptPath, args, logFn = () => {}, opts = {}) {
  let exe = process.execPath;
  // 硬链接优先放在 exe 同目录（同盘、必定可建）；装到只读目录（如 Program Files）时退到安装树的 .guard/
  const linkDirs = [opts.linkDir, dirname(process.execPath), join(RUNTIME_ROOT, '.guard')].filter(Boolean);
  for (const dir of linkDirs) {
    const linkExe = join(dir, 'guard-node.exe');
    try {
      if (!existsSync(linkExe)) { mkdirSync(dir, { recursive: true }); linkSync(process.execPath, linkExe); }
      if (existsSync(linkExe)) { exe = linkExe; break; }
    } catch (e) {
      logFn(`硬链接失败（${dir}）：${e?.message ?? e}`);
    }
  }
  if (exe === process.execPath) logFn('⚠ 没能给守卫换一个 exe 路径：壳的"按 exe 路径杀 qbm-node"兜底会把它一起带走（改用 WMI 脱身仍有效）');
  const cmdline = [exe, scriptPath, ...args].map((s) => (/[\s"]/.test(String(s)) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s))).join(' ');
  /* 【2026-09-13 主人要求："开启应用时不要带任何 cmd 黑窗"】
   * WMI 的 `Win32_Process.Create` **默认会给控制台程序新建一个可见的黑色控制台窗口**
   * （实测 Win11：会额外弹出一个 Windows Terminal 窗口，里面正是守卫自己那行
   * "守卫启动：父进程=… 托管目录=…"）。根因是 WMI 建进程时没指定窗口显示方式。
   * 两条修法都实测过：
   *   · `Win32_ProcessStartup.CreateFlags = 0x08000000`(CREATE_NO_WINDOW) → **无效**，Create 直接返回 21(InvalidParameter)；
   *   · `Win32_ProcessStartup.ShowWindow = 0`(SW_HIDE) → **有效**：进程号照常返还、进程照常活着，控制台窗口是隐藏的。
   * 所以先走"带 startup 信息"的建法，失败再退回旧的普通建法（宁可偶尔闪一下窗，也不能让守卫起不来）。 */
  const ps = [
    `$cmd = '${cmdline.replace(/'/g, "''")}'`,
    '$p1 = 0',
    "try { $si = ([wmiclass]'Win32_ProcessStartup').CreateInstance(); $si.ShowWindow = [uint16]0; $r1 = ([wmiclass]'Win32_Process').Create($cmd, $null, $si); if ($r1) { $p1 = [int]$r1.ProcessId } } catch { }",
    'if (-not $p1) { try { $r2 = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$cmd}; if ($r2) { $p1 = [int]$r2.ProcessId } } catch { } }',
    '$p1',
  ].join('; ');
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 20000, encoding: 'utf8' });
    const pid = parseInt(String(r.stdout || '0').trim(), 10) || 0;
    if (pid) return { pid, exe };
    return { pid: 0, exe, error: 'WMI 未返回进程号' };
  } catch (e) {
    // 兜底：万一 WMI 被策略禁掉，至少还能用普通 detached（会被 taskkill /T 连坐，但聊胜于无）
    try {
      const child = spawn(exe, [scriptPath, ...args], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref?.();
      return { pid: child.pid, exe, error: `WMI 失败已退化为普通 detached：${e?.message ?? e}` };
    } catch (e2) { return { pid: 0, exe, error: String(e2?.message ?? e2) }; }
  }
}

/** 找正在运行的 MoonBot 应用进程（找不到返回 0）。守卫只盯**验证过名字**的进程，
 *  绝不拿一个来路不明的 PID 去当"应用"—— 否则守卫会把"父进程不存在"当成应用关闭、当场把整套收掉。 */
function findMoonBotPid() {
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      'Get-Process MoonBot -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id'],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 8000, encoding: 'utf8' });
    return parseInt(String(r.stdout || '0').trim(), 10) || 0;
  } catch { return 0; }
}
const pidAlive = (pid) => { try { return pid > 0 && (process.kill(pid, 0), true); } catch { return false; } };

/** 武装守卫：盯着 watchPid（应用本体），应用一没就收掉 NapCat/桥/DSH */
function armNapcatGuardian(watchPid, opts = {}) {
  try {
    const prev = guardianFromFile();
    if (prev.pid && prev.pid !== process.pid) {
      try { process.kill(prev.pid, 'SIGTERM'); mlog(`[guardian] 已接管：请上一代守卫 pid=${prev.pid} 退场`); } catch { /* 已经不在了 */ }
    }
    const dirs = napcatManagedDirs(runtimes.get('napcat-local'));
    const dshPort = Number(loadConfig()?.instances?.dshIsolated?.port) || 10721;
    const script = join(RUNTIME_ROOT, 'server', 'napcat-guardian.mjs');
    if (!existsSync(script)) { mlog(`[guardian] 守卫脚本不存在，跳过：${script}`); return { pid: 0, error: `脚本不存在：${script}` }; }
    const logFile = join(LOG_DIR, 'napcat-guardian.log');
    const { pid, exe, error } = spawnGuardianDetached(script, [
      '--parent', String(watchPid),
      '--guard-file', GUARDIAN_FILE,
      '--dirs', JSON.stringify(dirs),
      '--dsh-port', String(dshPort),
      // 只让守卫收掉**本安装**的桥（按绝对路径匹配），不影响同机其它安装/其它进程
      '--bridge-script', join(RUNTIME_ROOT, 'qq-bridge', 'src', 'bridge.js'),
      '--log', logFile,
    ], (m) => mlog(`[guardian] ${m}`));
    if (!pid) { mlog(`[guardian] 武装失败（不影响其它功能）：${error || '未知'}`); return { pid: 0, error }; }
    writeFileSync(GUARDIAN_FILE, JSON.stringify({
      pid, parentPid: watchPid, dirs, dshPort, exe, startedAt: new Date().toISOString(), manual: !!opts.manual,
    }, null, 2), 'utf8');
    mlog(`[guardian] 已武装：pid=${pid}（${exe}）盯应用进程=${watchPid} 托管目录=${dirs.length} 个`
      + `（应用关闭时会一并收掉 NapCat/桥/DSH）${opts.manual ? ' · 手工' : ''}${error ? ' · ' + error : ''}`);
    return { pid, exe, error };
  } catch (e) {
    mlog(`[guardian] 武装失败（不影响其它功能）：${e?.message ?? e}`);
    return { pid: 0, error: e?.message ?? String(e) };
  }
}

/** 自动武装策略（启动时一次 + 每 60s 复查一次）：
 *   ① 已经武装好（guard 文件里的守卫还活着）→ 什么都不做；
 *   ② 本后端的父进程就是应用本体 → 盯它；
 *   ③ 否则找一台在跑的 MoonBot.exe → 盯它（**这一条很关键**：应用启动时如果复用已在跑的后端，
 *      就不会有新后端去自动武装，于是"关掉应用 NapCat 还在"—— 有了这条，下次开应用 60 秒内就武装好了）；
 *   ④ 应用没开 → 静默等着，不武装。QBM_NAPCAT_GUARDIAN=0 可整体关掉。 */
function ensureGuardianArmed() {
  try {
    const envMode = String(process.env.QBM_NAPCAT_GUARDIAN ?? '').trim();
    if (envMode === '0') return false;                                   // 整体关掉
    const prev = guardianFromFile();
    if (pidAlive(prev.pid) && prev.parentPid) return false;              // ① 已经武装
    const ppid = Number(process.ppid) || 0;
    // QBM_NAPCAT_GUARDIAN=1：显式武装（开发者/回归测试用），盯自己的父进程
    if (envMode === '1') { armNapcatGuardian(ppid || process.pid); return true; }
    if (ppid && /^MoonBot$/i.test(parentProcessName(ppid))) { armNapcatGuardian(ppid); return true; }
    const appPid = findMoonBotPid();
    if (!appPid) { return false; }                                       // ④ 应用没开
    armNapcatGuardian(appPid);
    return true;
  } catch (e) {
    mlog(`[guardian] 复查异常（忽略）：${e?.message ?? e}`);
    return false;
  }
}

/** POST /api/guardian/arm：手工（重新）武装守卫。
 *  为什么需要：守卫默认只在"后端由应用本体(MoonBot.exe)拉起"时自动武装；如果后端是被脚本/命令行
 *  拉起来的（比如开发者用 restart-manager.ps1 重启管理器），那一次就没有守卫 —— 但用户的应用窗口
 *  其实还开着。这个接口可以把守卫指向**当前真正在跑的那个 MoonBot.exe**，于是"关掉应用 → NapCat 一起关"
 *  立刻生效，不用先关一次应用。
 *  body.parentPid 可显式指定；不传就自动找第一个 MoonBot 进程。找不到就如实报错（绝不瞎指一个 PID，
 *  否则守卫会把"父进程不存在"当成应用关闭、当场把整套收掉）。 */
app.post('/api/guardian/arm', (req, res) => {
  try {
    let pid = Number(req.body?.parentPid) || 0;
    if (!pid) pid = findMoonBotPid();
    if (!pid) return res.status(400).json({ ok: false, message: '没有找到正在运行的 MoonBot 应用进程（应用没开？那就等下次由应用自己武装）' });
    const pname = parentProcessName(pid);
    if (!/^MoonBot$/i.test(pname)) {
      return res.status(400).json({ ok: false, message: `pid ${pid} 不是 MoonBot 应用进程（实际是 ${pname || '已退出'}），拒绝武装` });
    }
    const r = armNapcatGuardian(pid, { manual: true });
    if (!r.pid) return res.status(500).json({ ok: false, message: `守卫启动失败：${r.error || '未知'}` });
    res.json({
      ok: true, pid: r.pid, watching: pid, exe: r.exe,
      message: `守卫已武装：盯着应用进程 ${pid}；应用关闭时会一并收掉 NapCat/桥/隔离 DSH`,
    });
  } catch (e) { res.status(500).json({ ok: false, message: e?.message ?? String(e) }); }
});

/** POST /api/shutdown：应用关闭前的"体面收摊"。Electron 壳（新版 main.js）会先调它再 taskkill；
 *  手工/脚本也能用。默认只收 NapCat（与主人这次的要求一致），带 `{all:true}` 时连桥与隔离 DSH 一起收。 */
app.post('/api/shutdown', async (req, res) => {
  const all = req.body?.all === true || req.query?.all === '1';
  const done = [];
  try {
    const nap = await stopInstance('napcat-local');
    done.push(`napcat=${nap?.success ? 'stopped' : 'partial'}`);
    if (all) {
      const br = await stopInstance('bridge-local');
      const dsh = await stopInstance('dsh-isolated');
      done.push(`bridge=${br?.success ? 'stopped' : 'partial'}`, `dsh=${dsh?.success ? 'stopped' : 'partial'}`);
    }
    mlog(`[shutdown] ${done.join(' ')}`);
    res.json({ ok: true, all, done, message: all ? '已收起 NapCat / 桥 / 隔离 DSH' : '已关闭 NapCat' });
  } catch (e) {
    mlog(`[shutdown] 失败：${e?.message ?? e}`);
    res.status(500).json({ ok: false, message: e?.message ?? String(e) });
  }
});

/**
 * 开机/开关窗口后自动恢复上次启动过的实例（`instances.<k>.enabled === true`）。
 * 顺序仍是 NapCat → DSH → 桥（依赖关系），但**不等就绪**：状态机自己在后台推进，界面照常可用。
 * 已经在跑的（端口在监听）会被 startInstanceTracked 探活认回，不会重复拉起 —— 这也是 NapCat 必须走这条路的原因
 * （重复启动会挤出已经扫码登录的那份）。
 */
function scheduleAutoStart() {
  try {
    const cfg = loadConfig();
    if (cfg.autoStartOnBoot === false) { mlog('[autostart] 已配置为不自动启动，跳过'); return; }
    const order = ['napcat-local', 'dsh-isolated', 'bridge-local'];
    /* 【2026-09-14 主人要求】实例级开关 `instances.<key>.autoStartOnBoot: false`：
     * 单个实例说不跟着应用启动，就不再被恢复（典型场景：本机不想一开应用就把 QQ 拉起来 —— NapCat 一旦启动
     * 就会重新登录一次，主人只想在自己要用的时候手动点启动）。全局 cfg.autoStartOnBoot 仍然有效，优先级更高。 */
    const skipped = [];
    const wanted = order.filter((id) => {
      const inst = cfg.instances?.[keyOf(id)];
      if (inst?.enabled !== true) return false;
      if (inst?.autoStartOnBoot === false) { skipped.push(id); return false; }
      return true;
    });
    if (skipped.length) mlog(`[autostart] 按实例配置跳过（不随应用启动）：${skipped.join(', ')}`);
    if (!wanted.length) return;
    mlog(`[autostart] 将恢复上次启动过的实例：${wanted.join(', ')}`);
    void (async () => {
      for (const id of wanted) {
        try {
          const out = await startInstanceTracked(id, loadConfig(), { wait: false });
          mlog(`[autostart] ${id}: ${out.message}${out.note ? '（' + out.note + '）' : ''}`);
        } catch (e) {
          mlog(`[autostart] ${id} 失败: ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, 1200));   // 别把三个进程同时怼上去
      }
    })();
  } catch (e) {
    mlog('[autostart] 异常: ' + e.message);
  }
}

export { app };
