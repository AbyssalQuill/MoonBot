// NapCat 鉴权令牌的真正落地：把 WebUI / HTTP / WS 三个令牌写进 NapCat 自己的配置文件并重启容器。
//
// 2026-09-15 用户反馈的诊断：在管理端改「NapCat 登录令牌」看起来成功了，但：
//   · NapCat 仍然收默认的 truefriend（旧令牌照样能进 WebUI）；
//   · 因为管理端改的只是桥自己 config.json 里"期望用哪个令牌"（napcat.accessToken / wsAccessToken），
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
  // 2026-09-16 保登录态：桥每次启动顺手把"登录票据"备份一份（napcat_<QQ>.json + protocol + webui.json）。
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
 * 2026-09-16 保登录态：登录票据文件：`napcat_<QQ>.json`（不含 protocol，那份在 protocolFiles 里）。
 * 它就是"重启后不用重新扫码"的依据 —— NapCat 启动时按 `ACCOUNT=<QQ>` 拿它做快速登录。
 * 早先的备份只覆盖 webui/onebot/protocol，漏了这一个：真要是被硬杀写坏，就只能重新扫码。
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

/** 现状：NapCat 磁盘上的令牌（掩码）+ 桥配置里"期望"的令牌（掩码）+ 是否不一致。不回传明文。 */
export async function napcatTokenStatus() {
  const dir = napcatConfigDir();
  const cfg = cfgRef?.napcat ?? {};
  const out = {
    ok: true,
    dir,
    container: containerName(),
    napcat: { webui: '', http: '', ws: '' },
    // 2026-09-15：桥这边的值也必须掩码：这个接口会经管理端代理回浏览器，
    // 早先直接把 config.json 里的令牌原样回传（实测回出来是明文）——那是"密钥只回掩码"这条规矩的例外，不能留。
    bridge: { webui: '', http: mask(cfg.accessToken), ws: mask(cfg.wsAccessToken) },
    files: { webui: false, onebot: [], protocol: [] },
    mismatch: { http: false, ws: false, webui: false },
    // 2026-09-16：顺带把"NapCat 到底登没登录 QQ"查出来：这是"机器人不回复"排查的第一分叉。
    login: null,
    // 2026-09-16 强化 NapCat 连接：桥→NapCat 这条链路自己的诊断（连上没有 / 多久没下行 / 重连过几次）。
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
    // 2026-09-24：改走带 TTL 缓存的探测：卡片刷新与 SSE 同时取数时只真打一次 NapCat。
    out.login = await probeNapcatLogin();
  } catch (error) {
    out.login = { ok: false, error: String(error?.message ?? error) };
  }
  if (out.login && out.login.ok && !out.login.isLogin) {
    out.notes.push('⚠️ NapCat 目前**没有登录 QQ**（需要去管理端首页 → NapCat WebUI 扫码）。会话/快速登录信息都在数据卷里，正常重启不会掉登录态；如果反复要扫码，先按 README/交接文档的"保登录"一节排查。');
  }
  // 桥→NapCat 的连接诊断（最近一个 OneBot 客户端）
  try {
    const { napcatClientStats } = await import('../lib/onebot-ws.js');
    // 2026-09-24：napcatClientStats() 在没有活动客户端实例时返回 null，
    // 前端把 null 说成「查询失败（桥刚启动或未暴露统计信息）」—— 是谎报。
    // 这里显式回一个 unavailable 标记，让前端把"没有这项数据"与"真的出错"分开说。
    out.connection = napcatClientStats() ?? {
      unavailable: true,
      reason: 'no-client',
      note: '桥当前没有活动的 OneBot WS 客户端实例（本次运行还没建立连接）',
    };
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
  // 2026-09-16 保护登录态：宽限从 30s 提到 60s：NapCat 的 PID1 是 `bash entrypoint.sh`
  // （只 trap 了 SIGPIPE、不转发 SIGTERM 给 QQ），所以 `docker stop`/`restart` 实际上等的是
  // "超时后 SIGKILL"；给足 60s 就是给 QQ 更多时间把会话刷回数据卷（卷：napcat-qq）。
  const r = spawnSync('docker', ['restart', '-t', '60', name], { timeout: 180000, encoding: 'utf8' });
  const ms = Date.now() - t0;
  if (r.status !== 0) {
    return { ok: false, ms, detail: String(r.stderr || r.stdout || `exit=${r.status}`).trim().slice(0, 300) };
  }
  return { ok: true, ms, detail: String(r.stdout || '').trim().slice(0, 200) };
}

/* 2026-09-23：去除探针与状态检测。
 *
 * 这里曾经有 `getWebuiCredential()` / `dropWebuiCredential()` / `probeWebuiLoginRaw()`：
 * 为了查一个登录态，先去 `POST /api/auth/login` 换一个 WebUI Credential 再用它查。
 * 问题在于 NapCat 的登录接口是按 IP 限流的（每 60 秒只放 loginRate 次，出厂 10），
 * 而 WebUI 页面自己也要用同一份额度去换它那份 Credential。桥这里多登一次，
 * 页面就少一次；登得多了页面直接登不进去 → 页面上所有接口 Unauthorized
 * （最先报出来的就是「获取QQ列表失败: Unauthorized」「获取二维码失败: Unauthorized」）。
 *
 * 现在这些整体删除：桥侧不再有任何一处调 NapCat 的 WebUI 登录接口。
 * 登录态改用 OneBot 端口判断（见下面 probeQqLoginState），那条路完全不碰限流桶。 */

/**
 * NapCat 的登录态（是否已登录 QQ）。
 *
 * 2026-09-23：去除探针与状态检测 → 改成不碰 WebUI 登录接口的版本。
 * 老版本是 `POST /api/auth/login` 换 Credential → `POST /api/QQLogin/CheckLoginStatus`。
 * 那两次调用都要吃 NapCat 按 IP 限流的登录额度，而那份额度 WebUI 页面自己也要用
 * —— 桥多问一次，页面就少一次，问多了页面直接 Unauthorized。
 *
 * 现在只问 OneBot 端口（默认 http://127.0.0.1:3000，`get_login_info`）：
 * 它是 NapCat 给机器人用的正经接口，完全不进登录限流桶，也不会影响 WebUI 会话。
 * 语义如实区分三种情况，不把"问不到"混成"没登录"：
 *   · 端口有响应且 retcode=0 → 已登录（带回 uin/nick）
 *   · 端口有响应但 401/retcode≠0 → NapCat 在跑，但登录态没就绪或 OneBot 令牌不对
 *   · 端口不监听 → 查不到（QQ 没登录时 OneBot 端口本来就不监听，NapCat 没起也一样）
 */
export async function probeQqLoginState() {
  const base = String(cfgRef?.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  /* 2026-09-24 实测发现：桥刚启动的头几秒，napcat.httpToken 还没被运行期的令牌同步填上，
   * 这里就会不带 Authorization 去问，NapCat 直接回 403「令牌不对」—— 看着像"没登录"，
   * 其实是"桥还没把令牌读进来"。既然本部署里 HTTP 与 WS 用的是同一个令牌（061228），
   * 就退回 accessToken，避免启动瞬间误报。 */
  const httpToken = String(cfgRef?.napcat?.httpToken || cfgRef?.napcat?.accessToken || '');
  let res;
  try {
    res = await fetch(`${base}/get_login_info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(httpToken ? { authorization: `Bearer ${httpToken}` } : {}) },
      body: '{}',
      signal: AbortSignal.timeout(6000)
    });
  } catch (error) {
    return {
      ok: false,
      error: `OneBot 端口 ${base} 没响应（${String(error?.name ?? error)}）—— NapCat 没起来、或 QQ 未登录时它本来就不监听（这不等于"QQ 掉线了"）`,
      source: 'onebot'
    };
  }
  const j = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: `OneBot 端口在跑，但令牌不对（HTTP ${res.status}）—— 号没登出来之前也常见`, source: 'onebot' };
  }
  if (!j || Number(j.retcode ?? j.status ?? -1) !== 0) {
    return { ok: false, error: `OneBot 说查不到登录信息：${String(j?.message ?? `HTTP ${res.status}`)}`, source: 'onebot' };
  }
  const d = j.data ?? {};
  return {
    ok: true,
    isLogin: true,
    online: true,
    uin: d.user_id != null ? String(d.user_id) : '',
    nick: String(d.nickname ?? ''),
    error: '',
    source: 'onebot'
  };
}

/* ===================================================================================
  2026-09-24：「napcat 登录态改为 SSE 实时探测」
   -----------------------------------------------------------------------------------
   做法（既不轮询轰炸 NapCat，又能真·实时）：
     · `probeQqLoginState()` 只读一句 OneBot `get_login_info`（不碰登录/扫码/退出接口）；
     · 3 秒 TTL 缓存 + 并发合并：连续点刷新、或卡片与 SSE 同时取数，只会真的打一次；
     · 真实链路事件（WS open / close / 看门狗）触发 force 重探 → 登录态一变立刻推给订阅者；
     · SSE 连接建立时先推一份真值，之后 30 秒兜底重探一次（2 次/分钟，用于抓
       "WebUI 上 isLogin 还是 true、实际已被 QQ 作废"这种静默失效），另有 20 秒纯注释心跳；
     · 无订阅者时一次都不探（只有联网卡片/SSE 有人在看时才问 NapCat）。
   =================================================================================== */
const LOGIN_TTL_MS = 3000;
const loginSubs = new Set();
let loginSnap = null;      // { at, login }
let loginInFlight = null;  // 并发合并用的在途探测

/** 订阅登录态变化（SSE 用）。返回退订函数。 */
export function subscribeNapcatLogin(fn) {
  loginSubs.add(fn);
  return () => { loginSubs.delete(fn); };
}

/** 有没有人在看（没人看就不去问 NapCat） */
export function napcatLoginHasSubscribers() { return loginSubs.size > 0; }

/** 最近一次探测结果（可能为 null＝从没探过） */
export function napcatLoginSnapshot() { return loginSnap; }

function publishLogin() {
  for (const fn of loginSubs) {
    try { fn(loginSnap); } catch { /* 单个订阅者出错不影响其他人 */ }
  }
}

/**
 * 探一次登录态。默认走 3 秒缓存；`force` 只给真实链路事件与用户显式刷新用。
 * 永不抛：任何异常都归一成 { ok:false, error }。
 */
export async function probeNapcatLogin({ force = false } = {}) {
  if (!force && loginSnap && Date.now() - loginSnap.at < LOGIN_TTL_MS) return loginSnap.login;
  if (loginInFlight) return loginInFlight;   // 并发请求合并成一次真实探测
  loginInFlight = (async () => {
    let value;
    try {
      value = await probeQqLoginState();
    } catch (error) {
      value = { ok: false, error: String(error?.message ?? error), source: 'onebot' };
    }
    const prev = loginSnap?.login;
    loginSnap = { at: Date.now(), login: value };
    // 只在"结论变了"时推送，避免同样的状态反复打订阅者
    if (!prev || prev.ok !== value.ok || prev.isLogin !== value.isLogin
        || String(prev.uin ?? '') !== String(value.uin ?? '')) {
      publishLogin();
    }
    return value;
  })();
  try { return await loginInFlight; } finally { loginInFlight = null; }
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

/* 2026-09-23：已删除 `probeWebuiLogin()`。
 * 它用 `POST /api/auth/login` 去"权威验证"一个 WebUI 令牌 —— 那是探针，已整体去除。
 * 桥侧现在不存在任何一处调 NapCat WebUI 登录接口的代码（全库可 grep 佐证）。
 * 令牌对不对，直接看 webui.json 的内容 + 页面能不能点开即可。 */

/**
 * 把令牌写进 NapCat 配置（可选重启 + 复验）。
 * @param {{ webuiToken?:string, httpToken?:string, wsToken?:string, restart?:boolean }} opts
 *        只改传进来的项；全部不传 = 只读现状（不会写盘、不会重启）。
 * @returns 结构化结果（任何情况下都不回传令牌明文，只有掩码）
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

  // 只在真的改了值时才重启：早先按"对齐了几个 token 字段"判断，导致同值重写也会白重启一次 NapCat
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
      /* 2026-09-23：去除探针与状态检测。
       * 这里以前会用 `POST /api/auth/login` 当场复验新/旧 WebUI 令牌（各一发登录额度）。
       * 已删除：那份额度是 WebUI 页面自己要用的，桥不该花；而且 NapCat 只认启动那一刻读进
       * 内存的令牌，文件写了、容器也重启了，页面点开就知道对不对，不需要桥再替它试。
       * WebUI 令牌这里只报"已写入 + 已重启"。 */
      if (wantWebui) {
        bits.push('WebUI 令牌：已写入 webui.json 并重启 NapCat（是否生效以页面能否点开为准 —— 桥不再代跑登录接口，免得占用页面的登录额度）');
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
