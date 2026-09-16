// NapCat 鉴权令牌的真正落地：把 WebUI / HTTP / WS 三个令牌**写进 NapCat 自己的配置文件**并重启容器。
//
// 【2026-09-15 主人反馈的诊断】在管理端改「NapCat 登录令牌」看起来成功了，但：
//   · NapCat 仍然收默认的 truefriend（旧令牌照样能进 WebUI）；
//   · 因为管理端改的只是**桥自己 config.json 里"期望用哪个令牌"**（napcat.accessToken / wsAccessToken），
//     从没写进 NapCat 的配置 —— 两者不一致时，桥会用新令牌去连、NapCat 只认旧令牌 → 401/连不上。
//
// 服务器上的令牌实际藏在这三个地方（都在 NapCat 的 config 目录里，容器挂载为 /app/napcat/config）：
//   1) webui.json                       → token          （WebUI 6099 登录令牌）
//   2) onebot11.json / onebot11_<qq>.json → network.httpServers[].token
//                                        → network.websocketServers[].token   （OneBot HTTP 3000 / WS 3001）
//   3) napcat_protocol_*.json           → network.*（当前 NapCat 用的是 onebot11 那套，这里一般是空的；
//                                        但如果它里面确实有 httpServers/websocketServers 条目，也一并改）
//
// 写文件不会立刻生效：NapCat 启动时读配置，所以必须重启容器（用 `docker restart -t 30`，
// 不要 `docker stop`——默认 10 秒会把登录态一起 SIGKILL 掉，回来还得扫码）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { log } from '../lib/log.js';

let cfgRef = null;
export function initNapcatTokens(cfg) {
  cfgRef = cfg;
  // 【2026-09-16 保登录态】桥每次启动顺手把"登录票据"备份一份（napcat_<QQ>.json + protocol + webui.json）。
  // 亲历：NapCat 的 PID1 不转发 SIGTERM，docker stop/restart 实际是硬杀；万一票据被写坏，
  // 有一份好备份就等于"不用重新扫码"。备份目录 <config>/login-backup/<时间>，只留最近 BACKUP_KEEP 份。
  try {
    backupLoginTickets();
  } catch (error) {
    log(`[napcat-tokens] 登录票据备份失败（不影响启动）: ${error?.message ?? error}`);
  }
}

/** 备份"登录票据"（快速登录的依据）。返回备份目录名，失败返回 ''。 */
export function backupLoginTickets(keep = BACKUP_KEEP) {
  const dir = napcatConfigDir();
  if (!dir) return '';
  const tickets = [...loginTicketFiles(dir), ...protocolFiles(dir)];
  if (!tickets.length) return '';
  const bj = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  const stamp = `${bj.slice(0, 10).replace(/-/g, '')}-${bj.slice(11, 19).replace(/:/g, '')}`;
  const target = path.join(dir, 'login-backup', stamp);
  fs.mkdirSync(target, { recursive: true });
  for (const p of [...tickets, path.join(dir, 'webui.json')]) {
    try { fs.copyFileSync(p, path.join(target, path.basename(p))); } catch { /* 单个失败不阻塞 */ }
  }
  const root = path.join(dir, 'login-backup');
  const dirs = fs.readdirSync(root).sort();
  for (const old of dirs.slice(0, Math.max(0, dirs.length - Math.max(1, keep)))) {
    try { fs.rmSync(path.join(root, old), { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  return stamp;
}

const BACKUP_KEEP = 5;
const TOKEN_RE = /^[A-Za-z0-9._~!@#$%^&*()\-+=]{4,64}$/;

function containerName() {
  return String(cfgRef?.napcat?.containerName ?? '').trim() || 'napcat';
}

/** NapCat 配置目录（宿主机路径）。优先按 dockerPathMap 的 host 侧推导，其次 tmpDir 的父目录，最后猜常见位置。 */
export function napcatConfigDir() {
  const nap = cfgRef?.napcat ?? {};
  const maps = Array.isArray(nap.dockerPathMap) ? nap.dockerPathMap : [];
  for (const m of maps) {
    const h = String(m?.host ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (h && fs.existsSync(h)) return h;
  }
  const tmpDir = String(nap.tmpDir ?? '').trim();
  if (tmpDir) {
    const parent = path.dirname(tmpDir);
    if (parent && fs.existsSync(parent)) return parent;
  }
  for (const cand of ['/root/napcat/config', path.resolve(process.cwd(), 'napcat', 'config')]) {
    if (fs.existsSync(cand)) return cand;
  }
  return '';
}

function mask(v) {
  const s = String(v ?? '');
  if (!s) return '';
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}****${s.slice(-2)}`;
}

function readJsonFile(p) {
  try {
    const t = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function writeJsonFile(p, obj) {
  // 保持 2 空格缩进、无 BOM：NapCat 自己写的也是这个风格，改完肉眼能 diff
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

/** 候选的 OneBot 配置文件（通用 + 每个账号一份） */
function onebotFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => /^onebot11.*\.json$/i.test(n)).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

function protocolFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => /^napcat_protocol.*\.json$/i.test(n)).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/**
 * 【2026-09-16 保登录态】**登录票据**文件：`napcat_<QQ>.json`（不含 protocol，那份在 protocolFiles 里）。
 * 它就是"重启后不用重新扫码"的依据 —— NapCat 启动时按 `ACCOUNT=<QQ>` 拿它做快速登录。
 * 早先的备份只覆盖 webui/onebot/protocol，**漏了这一个**：真要是被硬杀写坏，就只能重新扫码。
 * 现在把它一起纳入备份（写令牌时 + 安全重启前都会备份）。
 */
function loginTicketFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((n) => /^napcat_\d+\.json$/i.test(n))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

function readTokensFromObj(obj) {
  const net = obj?.network ?? {};
  const http = (Array.isArray(net.httpServers) ? net.httpServers : []).map((s) => String(s?.token ?? '')).filter(Boolean)[0] ?? '';
  const ws = (Array.isArray(net.websocketServers) ? net.websocketServers : []).map((s) => String(s?.token ?? '')).filter(Boolean)[0] ?? '';
  return { http, ws };
}

/** 现状：NapCat 磁盘上的令牌（掩码）+ 桥配置里"期望"的令牌（掩码）+ 是否不一致。**不回传明文。** */
export async function napcatTokenStatus() {
  const dir = napcatConfigDir();
  const cfg = cfgRef?.napcat ?? {};
  const out = {
    ok: true,
    dir,
    container: containerName(),
    napcat: { webui: '', http: '', ws: '' },
    // 【2026-09-15 修】桥这边的值也必须掩码：这个接口会经管理端代理回浏览器，
    // 早先直接把 config.json 里的令牌原样回传（实测回出来是明文）——那是"密钥只回掩码"这条规矩的例外，不能留。
    bridge: { webui: '', http: mask(cfg.accessToken), ws: mask(cfg.wsAccessToken) },
    files: { webui: false, onebot: [], protocol: [] },
    mismatch: { http: false, ws: false, webui: false },
    // 【2026-09-16】顺带把"NapCat 到底登没登录 QQ"查出来：这是"机器人不回复"排查的第一分叉。
    login: null,
    // 【2026-09-16 强化 NapCat 连接】桥→NapCat 这条链路自己的诊断（连上没有 / 多久没下行 / 重连过几次）。
    // 与 login 一起构成"不回复"的完整判据：桥聋了（connection.connected=false） vs QQ 掉登录态（login.isLogin=false）。
    connection: null,
    notes: []
  };
  if (!dir) {
    out.ok = false;
    out.notes.push('没找到 NapCat 配置目录（napcat.dockerPathMap / tmpDir 都没配或目录不存在）');
    return out;
  }
  const webuiPath = path.join(dir, 'webui.json');
  const webui = readJsonFile(webuiPath);
  if (webui) {
    out.files.webui = true;
    out.napcat.webui = mask(webui.token);
    out.mismatch.webui = false;   // WebUI 令牌在桥这边不参与连接，只看"能不能用"（管理端链接会带上它）
  }
  const ob = onebotFiles(dir);
  out.files.onebot = ob.map((p) => path.basename(p));
  for (const p of ob) {
    const j = readJsonFile(p);
    const t = readTokensFromObj(j);
    if (t.http && !out.napcat.http) out.napcat.http = mask(t.http);
    if (t.ws && !out.napcat.ws) out.napcat.ws = mask(t.ws);
  }
  out.files.protocol = protocolFiles(dir).map((p) => path.basename(p));
  out.mismatch.http = Boolean(out.bridge.http) && Boolean(out.napcat.http) && mask(String(cfg.accessToken ?? '')) !== out.napcat.http;
  out.mismatch.ws = Boolean(out.bridge.ws) && Boolean(out.napcat.ws) && mask(String(cfg.wsAccessToken ?? '')) !== out.napcat.ws;
  // 登录态是"不回复"排查的第一分叉：QQ 没登录（要扫码） vs 桥聋了（本版已修，10s 自愈）
  try {
    out.login = await probeQqLoginState();
  } catch (error) {
    out.login = { ok: false, error: String(error?.message ?? error) };
  }
  if (out.login && out.login.ok && !out.login.isLogin) {
    out.notes.push('⚠️ NapCat 目前**没有登录 QQ**（需要去管理端首页 → NapCat WebUI 扫码）。会话/快速登录信息都在数据卷里，正常重启不会掉登录态；如果反复要扫码，先按 README/交接文档的"保登录"一节排查。');
  }
  // 桥→NapCat 的连接诊断（最近一个 OneBot 客户端）
  try {
    const { napcatClientStats } = await import('../lib/onebot-ws.js');
    out.connection = napcatClientStats();
  } catch (error) {
    out.connection = { error: String(error?.message ?? error) };
  }
  if (out.connection && out.connection.everOpened && out.connection.connected === false) {
    out.notes.push('⚠️ 桥现在**没有连着 NapCat**（已断开，正在按退避重连；最长 10 秒一次）。若长时间不恢复，看桥日志里的 `NapCat 错误` 与 `[napcat-login]` 两行。');
  }
  return out;
}

function backupDir(dir) {
  const bj = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  const stamp = `${bj.slice(0, 10).replace(/-/g, '')}-${bj.slice(11, 19).replace(/:/g, '')}`;
  const target = path.join(dir, `_bak-${stamp}`);
  try {
    fs.mkdirSync(target, { recursive: true });
    const names = ['webui.json', ...onebotFiles(dir).map((p) => path.basename(p)), ...protocolFiles(dir).map((p) => path.basename(p)), ...loginTicketFiles(dir).map((p) => path.basename(p))];
    for (const n of names) {
      try { fs.copyFileSync(path.join(dir, n), path.join(target, n)); } catch { /* 单个失败不阻塞 */ }
    }
    // 只留最近 N 份
    const dirs = fs.readdirSync(dir).filter((n) => n.startsWith('_bak-')).sort();
    for (const old of dirs.slice(0, Math.max(0, dirs.length - BACKUP_KEEP))) {
      try { fs.rmSync(path.join(dir, old), { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    return path.basename(target);
  } catch (error) {
    log(`[napcat-tokens] 备份失败（继续写配置）: ${error?.message ?? error}`);
    return '';
  }
}

function restartContainer() {
  const name = containerName();
  const t0 = Date.now();
  // 【2026-09-16 保护登录态】宽限从 30s 提到 60s：NapCat 的 PID1 是 `bash entrypoint.sh`
  // （只 trap 了 SIGPIPE、**不转发 SIGTERM 给 QQ**），所以 `docker stop`/`restart` 实际上等的是
  // "超时后 SIGKILL"；给足 60s 就是给 QQ 更多时间把会话刷回数据卷（卷：napcat-qq）。
  const r = spawnSync('docker', ['restart', '-t', '60', name], { timeout: 180000, encoding: 'utf8' });
  const ms = Date.now() - t0;
  if (r.status !== 0) {
    return { ok: false, ms, detail: String(r.stderr || r.stdout || `exit=${r.status}`).trim().slice(0, 300) };
  }
  return { ok: true, ms, detail: String(r.stdout || '').trim().slice(0, 200) };
}

/**
 * 【2026-09-16】NapCat 自己的**登录态**（是否已登录 QQ）。
 *
 * 为什么要有它：所有"机器人不回消息"的排查里，第一件事就是分清
 *   ① QQ 掉登录态（要扫码，NapCat 里没登录） 还是 ② 桥聋了（QQ 在收消息、桥连不上）。
 * 以前只能靠 `docker logs napcat` 里有没有新消息去猜；现在直接问 NapCat 的 WebUI：
 *   `POST /api/auth/login`（拿 Credential）→ `POST /api/QQLogin/CheckLoginStatus`
 *   返回 `{isLogin, isOffline, loginPhase, coreReady}`（实测 2026-09-15）。
 * 登录态本身**不会**因为重启/掉电而丢：会话在数据卷 `napcat-qq` + 配置目录里的
 * `napcat_<qq>.json` 里，容器起来后 NapCat 用 `ACCOUNT=<qq>` 自动快速登录（不需要重新扫码）。
 */
export async function probeQqLoginState() {
  const dir = napcatConfigDir();
  if (!dir) return { ok: false, error: '没找到 NapCat 配置目录（napcat.dockerPathMap / tmpDir 没配好）' };
  const w = readJsonFile(path.join(dir, 'webui.json'));
  const token = String(w?.token ?? '');
  if (!token) return { ok: false, error: '读不到 webui.json 的 token，无法查询登录态' };
  const login = await probeWebuiLogin(token);
  if (login.code !== 0) return { ok: false, error: `NapCat WebUI 登录接口没通过（${login.message || login.http}）`, webui: login };
  const hash = crypto.createHash('sha256').update(`${token}.napcat`).digest('hex');
  let credential = '';
  try {
    const res = await fetch(`http://127.0.0.1:${webuiPort()}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash }),
      signal: AbortSignal.timeout(8000)
    });
    const j = await res.json().catch(() => null);
    credential = String(j?.data?.Credential ?? '');
  } catch (error) {
    return { ok: false, error: `拿不到 WebUI Credential：${error?.message ?? error}` };
  }
  if (!credential) return { ok: false, error: 'WebUI 登录成功但没返回 Credential' };
  const call = async (p) => {
    try {
      const res = await fetch(`http://127.0.0.1:${webuiPort()}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
        body: '{}',
        signal: AbortSignal.timeout(8000)
      });
      return await res.json().catch(() => null);
    } catch (error) {
      return { code: null, message: String(error?.message ?? error) };
    }
  };
  const st = await call('/api/QQLogin/CheckLoginStatus');
  const info = st?.code === 0 ? await call('/api/QQLogin/GetQQLoginInfo') : null;
  const d = st?.data ?? {};
  return {
    ok: st?.code === 0,
    isLogin: Boolean(d.isLogin),
    online: info?.data ? Boolean(info.data.online) : Boolean(d.isLogin) && d.isOffline === false,
    loginPhase: String(d.loginPhase ?? ''),
    coreReady: Boolean(d.coreReady),
    qrAccepted: Boolean(d.qrLoginAccepted),
    uin: info?.data?.uin != null ? String(info.data.uin) : '',
    nick: String(info?.data?.nick ?? ''),
    error: st?.code === 0 ? '' : String(st?.message ?? '查询登录态失败')
  };
}

async function probeHttp(token, timeoutMs = 6000) {
  const base = String(cfgRef?.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/get_status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs)
    });
    return { status: res.status, ok: res.ok };
  } catch (error) {
    return { status: 0, ok: false, error: String(error?.name ?? error) };
  }
}

async function waitHttpUp(timeoutMs = 90000) {
  const base = String(cfgRef?.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/get_status`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        signal: AbortSignal.timeout(3000)
      });
      if (res.status > 0) return true;   // 401 也算"服务起来了"（只是没带对令牌）
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** NapCat WebUI 端口（默认 6099；桥配置里可覆盖） */
function webuiPort() {
  return Number(cfgRef?.napcat?.webuiPort) || 6099;
}

/** 等 WebUI 起来（任何 HTTP 响应都算起来） */
async function waitWebuiUp(timeoutMs = 120000) {
  const url = `http://127.0.0.1:${webuiPort()}/`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status > 0) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * 用 NapCat WebUI 的登录接口权威验证一个 WebUI 令牌。
 * 【实测 2026-09-15】前端调的是 `POST /api/auth/login`，body 为 `{ hash: sha256(token + ".napcat") }`；
 * 令牌正确 → `{code:0, data:{Credential:…}}`，错误 → `{code:-1, message:"token is invalid"}`。
 * 这是唯一能"当场证明旧令牌已失效"的办法（OneBot 的 3000 端口在 QQ 未登录时根本不监听）。
 */
async function probeWebuiLogin(token) {
  const hash = crypto.createHash('sha256').update(`${token}.napcat`).digest('hex');
  try {
    const res = await fetch(`http://127.0.0.1:${webuiPort()}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash }),
      signal: AbortSignal.timeout(8000)
    });
    const j = await res.json().catch(() => null);
    return { code: j?.code ?? null, message: String(j?.message ?? ''), http: res.status };
  } catch (error) {
    return { code: null, message: String(error?.name ?? error), http: 0 };
  }
}

/**
 * 把令牌写进 NapCat 配置（可选重启 + 复验）。
 * @param {{ webuiToken?:string, httpToken?:string, wsToken?:string, restart?:boolean }} opts
 *        只改传进来的项；全部不传 = 只读现状（不会写盘、不会重启）。
 * @returns 结构化结果（**任何情况下都不回传令牌明文**，只有掩码）
 */
export async function applyNapcatTokens(opts = {}) {
  const dir = napcatConfigDir();
  if (!dir) return { ok: false, error: '没找到 NapCat 配置目录：请先在桥配置里设好 napcat.dockerPathMap（host 侧挂载目录）或 tmpDir' };

  const wantWebui = String(opts.webuiToken ?? '').trim();
  const wantHttp = String(opts.httpToken ?? '').trim();
  const wantWs = String(opts.wsToken ?? '').trim();
  for (const [label, v] of [['WebUI 令牌', wantWebui], ['HTTP 令牌', wantHttp], ['WS 令牌', wantWs]]) {
    if (v && !TOKEN_RE.test(v)) {
      return { ok: false, error: `${label}不合法：只允许 4~64 位的字母/数字/._~!@#$%^&*()-+=（不要空格、引号、中文）` };
    }
  }
  if (!wantWebui && !wantHttp && !wantWs) {
    return { ok: false, error: '没有要写入的令牌：至少填一个（WebUI / HTTP / WS）' };
  }

  // 旧值（用于验证"旧令牌已失效"）
  const before = { webui: '', http: '', ws: '' };
  try {
    const w = readJsonFile(path.join(dir, 'webui.json'));
    if (w) before.webui = String(w.token ?? '');
  } catch { /* 忽略 */ }
  for (const p of onebotFiles(dir)) {
    const t = readTokensFromObj(readJsonFile(p));
    if (t.http && !before.http) before.http = t.http;
    if (t.ws && !before.ws) before.ws = t.ws;
  }

  const backup = backupDir(dir);
  const changed = { webui: false, http: 0, ws: 0, files: [], dirty: false };

  if (wantWebui) {
    const p = path.join(dir, 'webui.json');
    const w = readJsonFile(p);
    if (!w) return { ok: false, error: `读不到 ${p}（NapCat 还没生成 WebUI 配置？先启动一次 NapCat 再来）` };
    if (String(w.token ?? '') !== wantWebui) {
      w.token = wantWebui;
      writeJsonFile(p, w);
      changed.webui = true;
      changed.dirty = true;
      changed.files.push('webui.json');
    }
  }

  for (const p of [...onebotFiles(dir), ...protocolFiles(dir)]) {
    const j = readJsonFile(p);
    if (!j) continue;
    let touched = false;
    const net = j.network;
    if (net && typeof net === 'object') {
      const sections = [
        ['httpServers', wantHttp, 'http'],
        ['websocketServers', wantWs, 'ws']
      ];
      for (const [name, want, counter] of sections) {
        if (!want || !Array.isArray(net[name])) continue;
        for (const srv of net[name]) {
          if (!srv || typeof srv !== 'object') continue;
          if (!Object.prototype.hasOwnProperty.call(srv, 'token')) continue;
          if (String(srv.token ?? '') !== want) { srv.token = want; touched = true; changed.dirty = true; }
          changed[counter] += 1;   // 按"这一段里有几个 token 字段被对齐"计数（两个令牌同值时也如实计数）
        }
      }
    }
    if (touched) {
      writeJsonFile(p, j);
      changed.files.push(path.basename(p));
    }
  }

  // 只在**真的改了值**时才重启：早先按"对齐了几个 token 字段"判断，导致同值重写也会白重启一次 NapCat
  // （每次重启 ~30 秒，还可能掉登录态要重扫码）。
  if (!changed.dirty) {
    return {
      ok: true, dir, backup, changed, restart: null,
      verify: null,
      note: 'NapCat 配置里已经是这些令牌了，没有改动（也没有重启）'
    };
  }

  let restart = null;
  if (opts.restart !== false) {
    restart = restartContainer();
    log(`[napcat-tokens] 已重启容器 ${containerName()}：${restart.ok ? '成功' : '失败'}（${restart.ms}ms）${restart.detail ? ' · ' + restart.detail : ''}`);
  }

  const verify = { webuiOk: null, webuiOldRejected: null, httpOk: null, httpOldRejected: null, note: '' };
  if (restart?.ok) {
    const up = await waitWebuiUp(120000);
    if (!up) {
      verify.note = '重启后 120 秒内没等到 NapCat WebUI 起来（稍后可在「服务端状态」里看，或看桥日志）';
    } else {
      const bits = [];
      // ① WebUI 令牌：用登录接口当场验证新旧
      if (wantWebui) {
        const now = await probeWebuiLogin(wantWebui);
        verify.webuiOk = now.code === 0;
        bits.push(`WebUI 新令牌：${verify.webuiOk ? '登录接口通过' : `未通过（${now.message || now.http}）`}`);
        if (before.webui && before.webui !== wantWebui) {
          const oldRes = await probeWebuiLogin(before.webui);
          verify.webuiOldRejected = oldRes.code !== 0;
          bits.push(`旧 WebUI 令牌：${verify.webuiOldRejected ? '已被拒（token is invalid）' : '居然还能用（请回报）'}`);
        }
      }
      // ② OneBot HTTP 令牌：只有 QQ 已登录时 3000 才会监听；能探就探，探不到就如实说明
      const tokenForProbe = wantHttp || String(cfgRef?.napcat?.accessToken ?? '');
      if (tokenForProbe) {
        const httpUp = await waitHttpUp(12000);
        if (!httpUp) {
          bits.push('OneBot HTTP(3000) 当前没监听（QQ 未登录时本来就不监听），HTTP/WS 令牌已按文件写入确认');
        } else {
          const newRes = await probeHttp(tokenForProbe);
          verify.httpOk = newRes.ok;
          bits.push(`HTTP 新令牌：${newRes.ok ? '通过' : `HTTP ${newRes.status}`}`);
          if (before.http && before.http !== tokenForProbe) {
            const oldRes = await probeHttp(before.http);
            verify.httpOldRejected = !oldRes.ok;
            bits.push(`旧 HTTP 令牌：${verify.httpOldRejected ? '已被拒' : '居然还能用（请回报）'}`);
          }
        }
      }
      verify.note = bits.join('；') || '已重启，未做在线复验';
    }
  } else if (opts.restart === false) {
    verify.note = '按请求没有重启：令牌已写入文件，但要等 NapCat 下次启动才生效';
  } else {
    verify.note = `重启容器失败：${restart?.detail ?? '未知原因'}（令牌已写入文件，但还没生效）`;
  }

  return {
    ok: true,
    dir,
    backup,
    changed: { ...changed, webui: changed.webui, http: changed.http, ws: changed.ws },
    restart,
    verify,
    note: `已写入 ${changed.files.length} 个文件（备份 ${backup || '无'}）`
  };
}
