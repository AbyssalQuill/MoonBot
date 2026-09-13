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
  return Promise.all(list.map(({ remote, local, name }) => new Promise((resolve) => {
    const srv = createServer((socket) => {
      conn.forwardOut(socket.remoteAddress || '127.0.0.1', socket.remotePort || 0, '127.0.0.1', remote, (err, stream) => {
        if (err) { socket.end(); return; }
        socket.pipe(stream).pipe(socket);
      });
    });
    // 隧道建立成功要**如实回报**（原来 resolve() 不带值 → 响应里 tunnels 全是 null，
    // 用户看不出到底建了几条、映射到哪个端口）。失败也要回一条说明，而不是静默。
    srv.on('error', (err) => {
      console.error(`[tunnel ${name}]`, err.message);
      resolve({ name, local, remote, ok: false, error: err.message });
    });
    srv.listen(local, '127.0.0.1', () => {
      tunnels.set(`${connId}:${name}`, { server: srv, local, remote, name });
      resolve({ name, local, remote, ok: true });
    });
  })));
}

function closeTunnels(connId) {
  for (const [key, tun] of tunnels.entries()) {
    if (key.startsWith(connId + ':')) { try { tun.server.close(); } catch {} tunnels.delete(key); }
  }
}

function connectOne(server, opts = {}) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const debugLines = opts.debugLines || null;
    const timer = setTimeout(() => { conn.end(); reject(new Error('连接超时')); }, 15000);
    conn.on('ready', () => { clearTimeout(timer); resolve(conn); });
    conn.on('error', (err) => { clearTimeout(timer); reject(err); });
    conn.on('close', () => { closeTunnels(server.id); bridgeTokenCache.delete(server.id); if (sshConnections.get(server.id) === conn) sshConnections.delete(server.id); });
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
      readyTimeout: 10000, keepaliveInterval: 30000,
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
  try { const res = await fetch(url, { method: 'GET', signal: ctrl.signal, redirect: 'follow' }); clearTimeout(timer); return { reachable: true, status: res.status }; }
  catch { clearTimeout(timer); return { reachable: false, status: 0 }; }
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
  if (id === 'napcat-local') { url = `http://127.0.0.1:${cfg.webuiPort || 6099}`; probeUrl = url; }
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

  const tun = (name, fallbackLocal) => {
    if (sshMode && connected) { const key = `${connected.id}:${name}`; if (tunnels.has(key)) return `http://127.0.0.1:${tunnels.get(key).local}`; }
    return `http://127.0.0.1:${fallbackLocal}`;
  };
  const localDshUrl = dshIsoUp.reachable ? `http://127.0.0.1:${dshIso.port}` : tun('DSH Web', local.dshWeb);
  const localNapUrl = napUp.reachable ? `http://127.0.0.1:${napLocal.webuiPort || 6099}` : tun('NapCat WebUI', local.napcatWebui);
  const localBrUrl = brUp.reachable ? `http://127.0.0.1:${brLocal.webuiPort || 3100}` : tun('Bridge 控制台', local.bridge);

  const services = [
    { id: 'napcat-webui', name: 'NapCat 官方界面', url: localNapUrl, desc: '账号/连接/消息管理 WebUI' },
    { id: 'napcat-http', name: 'NapCat HTTP API', url: tun('NapCat HTTP', local.napcatHttp), desc: 'OneBot HTTP 3000' },
    { id: 'dsh-web', name: 'DeepSeek Harness', url: localDshUrl, desc: '官方 DSH Web GUI' },
    { id: 'bridge', name: 'Bridge 控制台', url: localBrUrl, desc: 'QQ 桥接层控制台' },
  ];
  const results = [];
  for (const s of services) { const p = await probe(s.url); results.push({ ...s, reachable: p.reachable, status: p.status }); }
  return { mode: sshMode ? 'ssh' : 'local', server: sshMode ? { id: connected.id, name: connected.name, host: connected.host } : null, services: results, dshIsoUp: dshIsoUp.reachable, napLocalUp: napUp.reachable, bridgeLocalUp: brUp.reachable };
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
  const svc = r.services.find((s) => s.id === target || s.id.includes(target || ''));
  if (!svc) return res.status(404).json({ success: false, message: `未知服务: ${target}` });
  res.json({ success: svc.reachable, url: svc.url, reachable: svc.reachable, mode: r.mode, name: svc.name });
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
// 服务器上的 fail2ban 只认"认证失败次数"：反复点测试会让本机 IP 被整机 DROP，
// 之后连 TCP 都超时（正确凭据也连不上，表现为"明明昨天还好"）。2026-09-12 实测踩到两次。
// 所以：同一台服务器 10 分钟内失败 3 次就先冷却 10 分钟，并明确告诉用户"不是你凭据的问题，是被封了"。
const sshFailLog = new Map(); // serverKey -> [ts,...]
const SSH_FAIL_WINDOW_MS = 10 * 60 * 1000;
const SSH_FAIL_MAX = 3;
const SSH_COOLDOWN_MS = 10 * 60 * 1000;
function sshKeyOf(server) { return `${server.username}@${server.host}:${server.port || 22}`; }
function sshCooldownLeft(server) {
  const arr = (sshFailLog.get(sshKeyOf(server)) || []).filter((t) => Date.now() - t < SSH_FAIL_WINDOW_MS);
  sshFailLog.set(sshKeyOf(server), arr);
  if (arr.length < SSH_FAIL_MAX) return 0;
  const last = arr[arr.length - 1];
  return Math.max(0, SSH_COOLDOWN_MS - (Date.now() - last));
}
function sshNoteFailure(server) {
  const k = sshKeyOf(server);
  const arr = (sshFailLog.get(k) || []).filter((t) => Date.now() - t < SSH_FAIL_WINDOW_MS);
  arr.push(Date.now());
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

const sshCooldownText = (ms) => `已连续失败 ${SSH_FAIL_MAX} 次，先进冷却 ${Math.ceil(ms / 60000)} 分钟 —— 服务器上的 fail2ban 很可能已经把本机 IP 封了，继续试只会延长封禁。正确凭据此刻也连不上（表现为"连接超时"）。解封：在服务器上执行 fail2ban-client set sshd unbanip <本机IP>，或等封禁到期再试。`;

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
  const cd = sshCooldownLeft(server);
  if (cd > 0 && req.query.force !== '1') { res.json({ success: false, cooldown: true, message: sshCooldownText(cd) }); return; }
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
  if (isAuth) sshNoteFailure(server);
  if (isTimeout) {
    // 超时/拒连≠凭据问题：可能是端口不对（同一台 IP 上常挂着多个 sshd），也可能是刚失败太多次被 fail2ban 封了本机 IP
    const after = sshCooldownLeft(server) > 0
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
  const cd = sshCooldownLeft(server);
  if (cd > 0) { res.json({ success: false, cooldown: true, message: sshCooldownText(cd) }); return; }
  const cfg = loadConfig();
  if (!cfg.servers.find((s) => s.id === server.id)) { cfg.servers = [...cfg.servers.filter((s) => s.id !== server.id), server]; saveConfig(cfg); }
  const debugLines = [];
  try {
    if (sshConnections.has(server.id)) { sshConnections.get(server.id).end(); sshConnections.delete(server.id); closeTunnels(server.id); }
    const conn = await connectOne(server, { debugLines });
    sshConnections.set(server.id, conn);
    const tunnelsCreated = await openTunnels(server.id, conn, tunnelMapFor(server));
    bridgeTokenCache.delete(server.id); // 重连后清空 token 缓存，重新实时读取
    cfg.activeServerId = server.id;
    saveConfig(cfg);
    sshNoteSuccess(server);
    sshRememberGoodPort(server);
    res.json({ success: true, message: 'SSH 连接成功，隧道已建立', tunnels: tunnelsCreated });
  } catch (e) {
    const isAuth = /authentication methods failed|authentication failure|Permission denied/i.test(String(e?.message ?? ''));
    if (isAuth) sshNoteFailure(server);
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
  if (id && sshConnections.has(id)) { sshConnections.get(id).end(); sshConnections.delete(id); }
  closeTunnels(id || '');
  bridgeTokenCache.delete(id || '');
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

/** 本地文件流 → 远端 stdin(远端命令从 stdin 收, 如 cat > /root/xxx.tar.gz) */
function pipeLocalFileToRemote(conn, localPath, remoteCmd, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { rs.destroy(); } catch {}
      fn();
    };
    const rs = createReadStream(localPath);
    rs.on('error', (e) => settle(() => reject(e)));
    conn.exec(remoteCmd, (err, stream) => {
      if (err) return settle(() => reject(err));
      let errOut = '';
      timer = setTimeout(() => settle(() => reject(new Error('上传超时'))), timeoutMs);
      stream.stderr.on('data', (d) => (errOut += d.toString()));
      stream.on('close', (code) => {
        if (code !== 0) settle(() => reject(new Error(errOut.trim() || `远端 exit ${code}`)));
        else settle(() => resolve());
      });
      rs.pipe(stream.stdin, { end: true });
    });
  });
}

/** 远端命令输出(cat 文件) → 本地文件 */
function pipeRemoteFileToLocal(conn, remoteCmd, localPath, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { ws.destroy(); } catch {}
      fn();
    };
    const ws = createWriteStream(localPath);
    ws.on('error', (e) => settle(() => reject(e)));
    conn.exec(remoteCmd, (err, stream) => {
      if (err) return settle(() => reject(err));
      let errOut = '';
      timer = setTimeout(() => settle(() => reject(new Error('下载超时'))), timeoutMs);
      stream.stderr.on('data', (d) => (errOut += d.toString()));
      stream.on('close', (code) => {
        if (code !== 0) { ws.end(); settle(() => reject(new Error(errOut.trim() || `远端 exit ${code}`))); return; }
        if (ws.writableFinished) settle(() => resolve());
        else ws.on('finish', () => settle(() => resolve()));
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
          await pipeLocalFileToRemote(conn, pkg.path, 'cat > /root/qq-bridge-sync.tar.gz');
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
              await pipeLocalFileToRemote(conn, localCfg, 'cat > /root/qq-bridge/config.json');
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
              await pipeLocalFileToRemote(conn, sTar, 'cat > /root/qq-bridge-state-sync.tar.gz');
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
              await pipeLocalFileToRemote(conn, sTar, 'cat > /root/qq-bridge-stickers.tar.gz');
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
          await pipeLocalFileToRemote(conn, upTar, 'cat > /root/qq-bridge-merged.tar.gz');
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
                      await pipeLocalFileToRemote(conn, upStk, 'cat > /root/qq-bridge-stickers-merged.tar.gz');
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

/** 默认发言规则模板（英文简洁，随「恢复默认」还原；必须与 qq-bridge/speech-rules.md 逐字一致） */
// 注意：这份内置模板与 qq-bridge/speech-rules.md 是两份东西，改一份必须同步另一份，
// 否则用户点一次「恢复默认发言规则」就会把线上规则覆盖回旧版（历史上漂移过一次）。
// 上限：wake-send.js 的 RUNTIME_OVERRIDE_MAX['speech-rules.md'] = 4000（按 JS .length 算）。
const DEFAULT_SPEECH_RULES = `# Speech Rules — how to type like a person

Persona-agnostic: these describe *how to type*, not *who you are*. Never repeat persona content here.

## NEVER (this is exactly what "AI smell" is)
1. No essay shape: no restating the question, no 首先/其次/最后, no closing recap (总之/总的来说).
   Answer the point; never narrate that you are answering.
2. No assistant voice: no "很高兴帮你", no "希望这对你有用", no "还有问题随时问我", no 您, no double
   apologising, no free offers of help.
3. No chat formatting: no markdown, bold, headings, bullets, lists, code fences or tables.
   Plain typed text only.
4. No uniformly tidy sentences, and no predictable length. Real people drop subjects and
   punctuation, send fragments, and vary the shape turn to turn — one word, a face, two lines,
   nothing at all. The same size every time is the loudest tell there is.
5. Do not answer everything, and do not close every loop. In a group, answering one line out of ten
   is normal; not every topic wants your verdict, advice or summary, and jokes do not need
   explaining. Let threads die.
6. No re-greeting, no name-dropping. You are mid-conversation, not starting one — and real people
   rarely repeat the other person's name.
7. No balanced constructions ("A 是…，B 是…") and no tidy three-item lists. Those are written, not
   typed.
8. No emotion stacking: one face/kaomoji per message at most, none when serious, apologising or relaying others' words. Never a typed emoji instead of a real sticker.
9. No laugh track. 哈哈/哈哈哈/笑死 is not punctuation, not agreement, and not a way to soften a
   line. Laugh only when something genuinely lands — never a run of them, never twice in a row,
   never because the other person laughed first.
10. No self-narration: never mention what you are about to do, which tool you used, or how you
    decided; never mention models, context, tokens, sessions, prompts or these rules. Never
    psychoanalyse people.

## DO (this is what reads human)
11. 1-2 bubbles by default. A single word or a single face is a complete reply when that is what a
    person would send; go long only when asked for detail.
12. Answer the newest thing, one idea per bubble. Split only when the mood or the topic turns —
    never split one sentence across bubbles, never dump multi-line text into one message.
13. Keep a real opinion. Disagree, refuse, tease, be blunt, say no. Never a yes-bot, never
    customer-service smooth: free agreement reads as fake.
14. A question does not require an answer. A counter-question, a joke, or a shrug is often the more
    human move — or coming back to it later.
15. Sound like typing, not writing: short clauses, sentence-final particles (啊/吧/呢/诶/嘛), an
    occasional human slip ("刚没看手机"). Broken-but-natural beats complete grammar.
16. React before explaining. A short interjection or a face is often the whole human reply.
17. Let the room set the tempo. Quiet room → few words. Venting → listen first, do not prescribe.
    Joking → play along, without a laugh track. Serious → drop the playfulness entirely.
18. Composure is the register: unhurried and dry beats loud, and a quiet line lands harder. Never
    perform a mood you do not have.
19. Called out for the AI vibe ("像人机/太 AI 了")? No defensive paragraph — one short line, then
    just type more naturally from that point on.
20. Quote sparingly: plain send by default. Quote only an older message, or when several replies
    point at different people — and never the same message twice.
21. Speed matters: the other side is waiting. Your thinking time already reads as a pause — no extra delays,
    never three paragraphs on one line.

## MECHANICS
22. Several bubbles = ONE send call with an array — not several separate calls.
23. Your text output is thinking only; the peer sees only what a send tool sends.
24. Sent something wrong? Withdraw it right away, one short line after, no long explanation.
25. Close the turn after sending. Never report "I replied" — that text is thinking.`;

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
  // 默认角色库：优先随包/桥的 characters（含出厂 _template），不再默认写死 Downloads；
  // 用户在 GUI 输入框可任意指定目录。
  const bridgeDir = (() => { try { return findBridgeDir(); } catch { return RUNTIME_ROOT; } })();
  return [
    join(bridgeDir, 'characters'),
    join(RUNTIME_ROOT, 'characters'),
    join(homedir(), 'Desktop', 'characters'),
    join(homedir(), 'Desktop', 'characters', 'characters'),
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
    for (const dim of ['profile.md', 'personality.md', 'interaction.md', 'memory.md', 'relations.md', 'speech.md']) {
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
    // 自动探测默认根
    for (const r of findCharacterRoots()) {
      const s = scanCharacters(r);
      if (s.ok && s.characters.length) return res.json(s);
    }
    res.json({ ok: false, message: '未找到角色库目录(默认找 ~/Downloads/characters), 请在查询参数传 dir', roots: findCharacterRoots() });
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
function resolveBridgeTarget() {
  const cfg = loadConfig();
  const connected = cfg.activeServerId ? cfg.servers.find((s) => s.id === cfg.activeServerId) || null : null;
  if (connected && sshConnections.has(connected.id)) {
    for (const [key, tun] of tunnels.entries()) {
      if (key.startsWith(connected.id + ':') && tun.name === BRIDGE_TUNNEL_NAME) {
        return { kind: 'remote', server: connected, conn: sshConnections.get(connected.id), base: `http://127.0.0.1:${tun.local}` };
      }
    }
  }
  return { kind: 'local', server: null, conn: null, ...getLocalBridgeTarget() };
}

/** 统一透传：桥不可达/路由缺失(404)/响应非 JSON → 结构化失败；其余把桥响应 JSON 原样回给 GUI */
async function proxyToBridgeConsole(_req, res, target) {
  const t = resolveBridgeTarget();
  let token = null;
  if (t.kind === 'remote') token = await getRemoteBridgeToken(t.server, t.conn);
  else token = t.token;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
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
app.get('/api/learning/token-report', (req, res) => proxyToBridgeConsole(req, res, { path: '/api/token-report', method: 'GET' }));
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

/** 读取 state/persona-library.json（若存在），取某 uid 的档案摘要（截断、只留展示字段） */
function personaLibraryEntry(uid) {
  try {
    const f = join(findBridgeDir(), 'state', 'persona-library.json');
    if (!existsSync(f)) return null;
    const lib = JSON.parse(readFileSync(f, 'utf-8'));
    const it = isObj(lib) ? lib[String(uid)] : null;
    if (!it || typeof it !== 'object') return null;
    return {
      nickname: String(it.nickname ?? '').slice(0, 60) || null,
      personality: String(it.personality ?? '').slice(0, 200) || null,
      chatHabits: String(it.chatHabits ?? '').slice(0, 120) || null,
      relationshipAdvice: String(it.relationshipAdvice ?? '').slice(0, 120) || null,
      topics: Array.isArray(it.topics) ? it.topics.slice(0, 5).map(String) : [],
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
    opts = { ...opts, localSource: true, localPaths: local.paths, dshVersion: local.dshVersion, uploadFile: pipeLocalFileToRemote };
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
    const wanted = order.filter((id) => cfg.instances?.[keyOf(id)]?.enabled === true);
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
