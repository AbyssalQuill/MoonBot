// Pixiv 官方 OAuth 登录态：一次性用 PHPSESSID 换长期 refresh_token → 之后 access_token 自动轮换。
// （2026-09-20 新增。需求："脚本自动轮换 cookie/登录态""按名字搜画师要能一直用，不要再靠人手贴 PHPSESSID"。）
//
// 为什么非做不可（现场）：
//   · 桥原来只有一条路 —— 手动把 PHPSESSID 贴进 config.json，而 PHPSESSID 短命；一掉，
//     「按名字搜画师」立刻瘫（pixiv 的 `/ajax/search/users` 匿名一律 400，2026-09-19 实测），
//     每次都得回来重贴一次。这是本次要根治的那件事。
//   · 修法：借官方 Android 客户端那套 OAuth —— 用手贴的那一次 cookie 换一个长期
//     refresh_token，之后桥自己每小时换一次 access_token（且 pixiv 每次轮换都会给出新的
//     refresh_token，要落盘），之后不用再管登录态。
//
// 公开 App 常量（官方 Android 客户端与 pixivpy 一直在用的公开值，硬编码在客户端里，不是账号密码）：
//   client_id / client_secret ；hash_secret 用来算 X-Client-Hash = md5(X-Client-Time + hash_secret)
//   （pixiv 用这一对头挡"裸脚本直连"，所以两个头必须同时正确）。
//
// 三条纪律（与 lib/pixiv.js 的 cookie 纪律同源）：
//   ① refresh_token / access_token / PHPSESSID / code / code_verifier 绝不进日志、不进返回值、
//      不进 QQ 消息；对外只给长度与来源（如 `PHPSESSID(len=43)`）；
//   ② 失败绝不抛（桥的定时器里抛出去会把整轮 tick 打断）——一律返回 `{ok:false, error, status, body}`；
//   ③ 凭证只发给 pixiv 自己的域名：`oauth.secure.pixiv.net` / `app-api.pixiv.net`（见下面的白名单断言）。
//
// 令牌文件：<qq-bridge>/state/pixiv-token.json（原子写 tmp+rename，POSIX 下 0600）。
//   可用 QQBRIDGE_PIXIV_TOKEN_PATH 改路径（自检/测试用，避免碰到真凭证）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 桥的 config.json（本文件在 qq-bridge/src/lib/ 下 → 上两级就是 qq-bridge/）。 */
const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config.json');

/** 官方 Android 客户端的公开常量（客户端里硬编码的，非账号密码）。 */
export const PIXIV_CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
export const PIXIV_CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';
const HASH_SECRET = '28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c';
export const PIXIV_APP_UA = 'PixivAndroidApp/5.0.234 (Android 11; Pixel 5)';
export const PIXIV_APP_OS = 'android';
export const PIXIV_APP_OS_VERSION = '11';
export const PIXIV_APP_VERSION = '5.0.234';

export const PIXIV_OAUTH_TOKEN_URL = 'https://oauth.secure.pixiv.net/auth/token';
export const PIXIV_WEB_LOGIN_URL = 'https://app-api.pixiv.net/web/v1/login';
export const PIXIV_REDIRECT_URI = 'https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback';

/** 提前多少毫秒就开始换（pixiv 的 access_token 有效 1 小时，留 10 分钟余量给失败重试）。 */
export const PIXIV_REFRESH_AHEAD_MS = 10 * 60 * 1000;
/** 默认轮换间隔：50 分钟（< 1 小时有效期，任何一次抖动都还有一次机会）。 */
export const PIXIV_REFRESH_INTERVAL_MS = 50 * 60 * 1000;
const EXPIRES_SKEW_MS = 60 * 1000;      // 落盘时把 expires_at 往前挪 60 秒，抵消时钟/网络误差
const OAUTH_TIMEOUT_MS = 20000;
const BODY_ECHO_MAX = 300;              // 失败时回显响应体的长度上限（够人看，不至于刷屏）

/* ────────────────────────────── 令牌文件（原子写 + 0600） ────────────────────────────── */

/** 令牌文件路径。每次现读环境变量：自检/测试要能指到别处而不碰真凭证。 */
export function pixivTokenPath() {
  const override = String(process.env.QQBRIDGE_PIXIV_TOKEN_PATH ?? '').trim();
  return override ? path.resolve(override) : path.resolve(__dirname, '..', '..', 'state', 'pixiv-token.json');
}

/** 读令牌文件（读不到/坏文件都当空，绝不让它把主流程搞挂）。 */
export function readPixivToken() {
  try {
    const j = JSON.parse(fs.readFileSync(pixivTokenPath(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/**
 * 原子写：先写 `<file>.tmp` 再 rename（同目录 rename 在 POSIX 上是原子的，读侧永远看不到半个文件）。
 * 0600 是因为这个文件里躺着一个能代表账号的长期凭证 —— 同机上别的用户不该能读。
 * 注意 Windows 上 chmod 基本是空操作（mode 由 ACL 决定），所以失败只忽略、不报错。
 */
function writePixivToken(patch) {
  const next = { v: 1, ...readPixivToken(), ...patch };
  const file = pixivTokenPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows：忽略 */ }
  fs.renameSync(tmp, file);
  return next;
}

/** 把一个 token 字符串规整干净（剥掉引号/空白/换行 —— 有人从 JSON 里复制会带这些）。 */
function cleanToken(v) {
  return String(v ?? '').replace(/[\r\n\t\s]+/g, '').replace(/^["']|["']$/g, '');
}

/** config.json 的 pixiv.refreshToken（读不到/格式坏都当"没配"）。 */
export function configPixivRefreshToken() {
  try {
    let text = fs.readFileSync(CONFIG_PATH, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const t = JSON.parse(text)?.pixiv?.refreshToken;
    return typeof t === 'string' ? t : '';
  } catch {
    return '';
  }
}

/**
 * 当前生效的 refresh_token 与它的来源。优先级（2026-09-20 定：配置优先于文件）：
 *   环境变量 QQBRIDGE_PIXIV_REFRESH_TOKEN > config.json 的 pixiv.refreshToken > 令牌文件。
 * 为什么环境变量最前：它是"临时覆盖/自动化自检"的唯一入口（测试也靠它把网络挡在外面）；
 * 为什么 config 高于文件：手写进配置的是人的意图，机器轮换出来的只是最近一次结果。
 */
export function resolvePixivRefreshToken(fileToken = '') {
  const fromEnv = cleanToken(process.env.QQBRIDGE_PIXIV_REFRESH_TOKEN);
  if (fromEnv) return { token: fromEnv, source: 'env' };
  const fromConfig = cleanToken(configPixivRefreshToken());
  if (fromConfig) return { token: fromConfig, source: 'config' };
  const fromFile = cleanToken(fileToken);
  if (fromFile) return { token: fromFile, source: 'file' };
  return { token: '', source: 'none' };
}

/**
 * 对外汇报登录态（只给长度和来源，绝不给值）。
 * @returns {{hasRefreshToken:boolean, hasAccessToken:boolean, accessTokenValid:boolean, expiresAt:number,
 *            expired:boolean, userId:string, userName:string, lastError:string, lastRefreshAt:number,
 *            source:string, refreshTokenLen:number, accessTokenLen:number, tokenFile:string}}
 */
export function pixivAuthState() {
  const stored = readPixivToken();
  const accessToken = String(stored.access_token ?? '').trim();
  const expiresAt = Number(stored.expires_at) || 0;
  const { token: refreshToken, source } = resolvePixivRefreshToken(String(stored.refresh_token ?? '').trim());
  const valid = Boolean(accessToken) && expiresAt > Date.now();
  return {
    hasRefreshToken: Boolean(refreshToken),
    hasAccessToken: Boolean(accessToken),
    accessTokenValid: valid,
    expiresAt,
    expired: !(expiresAt > Date.now()),
    userId: String(stored.user_id ?? ''),
    userName: String(stored.user_name ?? ''),
    lastError: String(stored.last_error ?? ''),
    lastRefreshAt: Number(stored.last_refresh_at) || 0,
    source,
    refreshTokenLen: refreshToken.length,
    accessTokenLen: accessToken.length,
    tokenFile: pixivTokenPath(),
  };
}

/* ────────────────────────────── 请求头（X-Client-Time/Hash） ────────────────────────────── */

/** ISO-8601 UTC（`2026-09-20T04:05:06+00:00`）—— X-Client-Hash 就是拿**这个字符串**拼 hash_secret 算的。 */
export function pixivClientTime(time = new Date()) {
  return `${new Date(time).toISOString().slice(0, 19)}+00:00`;
}

/** X-Client-Hash = md5(time + hash_secret)，小写十六进制。导出是为了让自检能独立复算。 */
export function pixivClientHash(timeStr) {
  return crypto.createHash('md5').update(`${String(timeStr)}${HASH_SECRET}`).digest('hex');
}

/** 官方 App 的请求头（pixiv 会校验 X-Client-Hash 与 X-Client-Time 是否配套）。 */
export function pixivAppHeaders({ contentType = '', time = new Date() } = {}) {
  const t = pixivClientTime(time);
  return {
    'user-agent': PIXIV_APP_UA,
    'app-os': PIXIV_APP_OS,
    'app-os-version': PIXIV_APP_OS_VERSION,
    'app-version': PIXIV_APP_VERSION,
    'X-Client-Time': t,
    'X-Client-Hash': pixivClientHash(t),
    'accept-language': 'zh-cn',
    accept: 'application/json',
    ...(contentType ? { 'content-type': contentType } : {}),
  };
}

/** 凭证只许发给 pixiv 自己的域名（oauth / app-api / www）。**任何其它主机一律拒绝带凭证出去**。 */
export function isPixivHost(url) {
  return /^https?:\/\/(?:[a-z0-9-]+\.)*pixiv\.net(?:[/:]|$)/i.test(String(url ?? ''));
}

/* ────────────────────────────── PKCE ────────────────────────────── */

/** 128 字符的 code_verifier（charset 取 base64url：A-Za-z0-9-_ ⊂ RFC7636 允许集）。 */
export function generatePixivPkce() {
  const verifier = crypto.randomBytes(96).toString('base64url').slice(0, 128);
  return { verifier, challenge: pixivPkceChallenge(verifier) };
}

/** code_challenge = base64url(sha256(verifier))（无 padding）。 */
export function pixivPkceChallenge(verifier) {
  return crypto.createHash('sha256').update(String(verifier ?? '')).digest('base64url');
}

/* ────────────────────────────── 回显脱敏 ────────────────────────────── */

/** 把回显文本里出现过的**真实**密钥值替换掉（cookie 可能自己出现在响应里，宁可多遮不可漏）。 */
function redactEcho(text, secrets) {
  let out = String(text ?? '');
  for (const s of secrets) {
    const v = String(s ?? '').trim();
    if (v.length >= 6) out = out.split(v).join('[已隐去]');
  }
  return out
    .replace(/(PHPSESSID|refresh_token|access_token|code_verifier|code)=([^;"&\s]{4,})/gi, '$1=[已隐去]')
    // JSON 形状也要遮（`{"code":"…"}` / `{"refresh_token":"…"}`）——2026-09-20 自测发现只遮 `k=v` 会漏
    .replace(/("(?:PHPSESSID|refresh_token|access_token|code_verifier|code)"\s*:\s*")[^"]*(")/gi, '$1[已隐去]$2');
}

const echo = (text, secrets = []) => redactEcho(text, secrets).replace(/\s+/g, ' ').trim().slice(0, BODY_ECHO_MAX);

/* ────────────────────────────── refresh_token → access_token ────────────────────────────── */

/** 失败一律走这里：落盘 last_error（给人查），并返回结构化错误（绝不抛）。 */
function fail(message, status = 0, body = '') {
  try { writePixivToken({ last_error: message, last_error_at: Date.now() }); } catch { /* 落盘失败也只能算了 */ }
  return { ok: false, error: message, status, body };
}

async function doRefreshPixivToken() {
  const stored = readPixivToken();
  const { token: refreshToken, source } = resolvePixivRefreshToken(String(stored.refresh_token ?? '').trim());
  // 没登录态不算"故障"（是没配），所以这里不落盘 last_error，也不建令牌文件。
  if (!refreshToken) return { ok: false, error: '没有 refresh_token：先跑 tools/pixiv-login.mjs --cookie 换一次', status: 0, body: '' };

  let res;
  let text = '';
  try {
    res = await fetch(PIXIV_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: pixivAppHeaders({ contentType: 'application/x-www-form-urlencoded' }),
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: PIXIV_CLIENT_ID,
        client_secret: PIXIV_CLIENT_SECRET,
        include_policy: 'true',
      }).toString(),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e) {
    return fail(`换 token 请求失败：${e?.message ?? e}`);
  }

  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 也照报，给人看原文 */ }
  if (!res.ok || !json?.access_token) {
    const body = echo(text, [refreshToken]);
    return fail(`换 token 失败：HTTP ${res.status}${body ? ` ${body}` : ''}`, res.status, body);
  }

  const expiresIn = Number(json.expires_in) || 3600;
  const expiresAt = Date.now() + Math.max(30, expiresIn - EXPIRES_SKEW_MS / 1000) * 1000;
  // pixiv 每次轮换都会给一个新的 refresh_token（旧的会失效），所以必须把新的写回去。
  const patch = {
    refresh_token: String(json.refresh_token || refreshToken),
    access_token: String(json.access_token),
    expires_at: expiresAt,
    user_id: String(json.user?.id ?? stored.user_id ?? ''),
    user_name: String(json.user?.name ?? stored.user_name ?? ''),
    last_refresh_at: Date.now(),
    last_error: '',
    last_error_at: 0,
    source: source === 'none' ? 'file' : source,
  };
  try {
    writePixivToken(patch);
  } catch (e) {
    // 令牌拿到了但没落盘：本轮可用、重启后丢 —— 如实说，别假装成功。
    return {
      ok: true, accessToken: patch.access_token, expiresAt, userId: patch.user_id,
      userName: patch.user_name, refreshTokenRotated: patch.refresh_token !== refreshToken,
      persisted: false, error: `令牌落盘失败：${e?.message ?? e}`,
    };
  }
  return {
    ok: true,
    accessToken: patch.access_token,
    expiresAt,
    userId: patch.user_id,
    userName: patch.user_name,
    refreshTokenRotated: patch.refresh_token !== refreshToken,
    refreshTokenLen: patch.refresh_token.length,
    persisted: true,
  };
}

let refreshInflight = null;

/**
 * 换一次 access_token。同进程内 single-flight：并发调用共享同一次请求，绝不一起冲 pixiv
 * （pixiv 的 refresh_token 每次轮换就作废，并发刷新会互相把对方的 token 顶掉 —— 这是必须串行的硬理由）。
 * @returns {Promise<{ok:boolean, accessToken?:string, expiresAt?:number, userId?:string, userName?:string,
 *                    refreshTokenRotated?:boolean, persisted?:boolean, error:string, status?:number, body?:string}>}
 */
export function refreshPixivToken() {
  if (refreshInflight) return refreshInflight;
  refreshInflight = doRefreshPixivToken().finally(() => { refreshInflight = null; });
  return refreshInflight;
}

/**
 * 拿一个当前有效的 access_token；快过期/已过期时先换。
 * 没登录态（没有 refresh_token 且本地也没有效 access_token）时返回 null 而不联网 ——
 * 调用方（lib/pixiv.js）靠 null 决定"跳过官方接口，直接走匿名可用的那条路"。
 * @returns {Promise<string|null>}
 */
export async function getPixivAccessToken() {
  const stored = readPixivToken();
  const accessToken = String(stored.access_token ?? '').trim();
  const expiresAt = Number(stored.expires_at) || 0;
  if (accessToken && expiresAt - Date.now() > EXPIRES_SKEW_MS) return accessToken;
  const { token: refreshToken } = resolvePixivRefreshToken(String(stored.refresh_token ?? '').trim());
  if (!refreshToken) return null;
  const r = await refreshPixivToken();
  return r.ok ? r.accessToken : null;
}

/**
 * 把一份 refresh_token 直接写进令牌文件（`--refresh-token` / 手工恢复用）。
 * @returns {{ok:boolean, error?:string}}
 */
export function savePixivRefreshToken(token) {
  const t = cleanToken(token);
  if (t.length < 20) return { ok: false, error: 'refresh_token 看起来不合法（长度 < 20）' };
  try {
    writePixivToken({ refresh_token: t, last_error: '', last_error_at: 0, source: 'file' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `令牌落盘失败：${e?.message ?? e}` };
  }
}

/* ────────────────────────────── 定时轮换 ────────────────────────────── */

let refreshLoop = null;

/**
 * 启动自动轮换。重复调用安全：已有的循环直接返回它的停止函数，不会起第二个定时器。
 * 定时器 unref（不拖着进程不退出，与 core/pixiv-watch.js 同一套路）。
 * @param {{intervalMs?:number, logger?:Function}} opts
 * @returns {() => void} 停止函数
 */
export function startPixivTokenRefresh({ intervalMs = PIXIV_REFRESH_INTERVAL_MS, logger = () => {} } = {}) {
  if (refreshLoop) return refreshLoop.stop;
  let active = true;

  const tick = async () => {
    if (!active) return;
    try {
      const st = pixivAuthState();
      if (!st.hasRefreshToken) return;                                  // 没有长期令牌：静默（没配 ≠ 故障）
      if (st.accessTokenValid && st.expiresAt - Date.now() > PIXIV_REFRESH_AHEAD_MS) return;  // 还早，不动
      const r = await refreshPixivToken();
      if (r.ok) {
        logger(`[pixiv] access_token 已轮换（有效期至 ${new Date(r.expiresAt).toISOString()}，账号 ${r.userId || '?'}${r.refreshTokenRotated ? '，refresh_token 已落盘' : ''}）`);
      } else {
        logger(`[pixiv] access_token 轮换失败：${r.error}`);
      }
    } catch (e) {
      logger(`[pixiv] 轮换循环异常（已忽略）：${e?.message ?? e}`);
    }
  };

  const timer = setInterval(() => { void tick(); }, Math.max(60_000, Number(intervalMs) || PIXIV_REFRESH_INTERVAL_MS));
  try { timer.unref?.(); } catch { /* 忽略 */ }
  const stop = () => {
    if (!active) return;
    active = false;
    clearInterval(timer);
    if (refreshLoop?.stop === stop) refreshLoop = null;
  };
  refreshLoop = { stop, timer };
  void tick();   // 启动时先看一眼：令牌已经过期/快过期的话，不用等一个间隔
  return stop;
}

/* ────────────────────────────── 一次性引导：PHPSESSID → refresh_token ────────────────────────────── */

/** 从用户给的东西里抠出会话值本身（容忍整条 cookie 串 / `PHPSESSID=xxx` / 光秃秃的值）。 */
export function normalizePhpSessid(value) {
  let s = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!s) return '';
  if (!s.includes('=') && /^[A-Za-z0-9_%\-+/=.]{8,200}$/.test(s)) s = `PHPSESSID=${s}`;
  const m = /(?:^|;\s*)PHPSESSID=([^;]+)/i.exec(s);
  return m ? m[1].trim() : '';
}

/** 从 302 的 Location（`pixiv://account/login?code=…`）或响应体（JSON/HTML）里抠登录 code。
 *  只在没报错的响应体里找（见 loginWithPhpSessid 里的 okish 守卫）：pixiv 的错误体里也有
 *  一个叫 `code` 的字段（`{"error":{"message":"不正确的请求。","code":"…"}}`），
 *  2026-09-20 自测就踩到了这个 —— 拿错误体里的 code 去换 token，报出来的错会完全指错方向。 */
function extractLoginCode(text) {
  const t = String(text ?? '');
  const m = /[?&]code=([A-Za-z0-9._~-]{10,})/.exec(t);
  if (m) return m[1];
  try {
    const j = JSON.parse(t);
    if (!j?.error) {
      const c = j?.code ?? j?.body?.code;
      if (typeof c === 'string' && c) return c;
    }
  } catch { /* 不是 JSON：继续按文本找 */ }
  const m2 = /"code"\s*:\s*"([A-Za-z0-9._~-]{10,})"/.exec(t);
  return m2 && !/"error"/.test(t) ? m2[1] : '';
}

/** 用 login code + code_verifier 换 refresh_token（官方授权码流程）。 */
async function exchangePixivCode(code, verifier) {
  const secrets = [code, verifier];
  let res;
  let text = '';
  try {
    res = await fetch(PIXIV_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: pixivAppHeaders({ contentType: 'application/x-www-form-urlencoded' }),
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: PIXIV_CLIENT_ID,
        client_secret: PIXIV_CLIENT_SECRET,
        redirect_uri: PIXIV_REDIRECT_URI,
      }).toString(),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, status: 0, error: `换 token 请求失败：${e?.message ?? e}`, body: '' };
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* 见下：非 JSON 也原样回给人看 */ }
  if (!res.ok || !json?.refresh_token) {
    return { ok: false, status: res.status, error: `HTTP ${res.status}`, body: echo(text, secrets) };
  }
  const expiresIn = Number(json.expires_in) || 3600;
  const patch = {
    refresh_token: String(json.refresh_token),
    access_token: String(json.access_token ?? ''),
    expires_at: Date.now() + Math.max(30, expiresIn - EXPIRES_SKEW_MS / 1000) * 1000,
    user_id: String(json.user?.id ?? ''),
    user_name: String(json.user?.name ?? ''),
    last_refresh_at: Date.now(),
    last_error: '',
    last_error_at: 0,
    source: 'file',
  };
  try {
    writePixivToken(patch);
  } catch (e) {
    return { ok: true, userId: patch.user_id, userName: patch.user_name, expiresAt: patch.expires_at, persisted: false, error: `令牌落盘失败：${e?.message || e}` };
  }
  return { ok: true, userId: patch.user_id, userName: patch.user_name, expiresAt: patch.expires_at, persisted: true };
}

/**
 * 一次性引导：拿手贴的 PHPSESSID 换一个长期 refresh_token（之后就再也不需要 cookie 了）。
 *
 * 流程（2026-09-20 实现，两段都是"线上要能人工迭代"的写法）：
 *   ① 请求 app-api 的 web 登录口换 login code —— 先试 GET 带 query 参数（现代形状，pixiv web 版
 *      登录后 302 到 `pixiv://account/login?code=…`，所以必须 `redirect:'manual'` 自己看 Location，
 *      不让 fetch 替我们跟跳），再试 POST JSON（另一套被广泛记录的形状）。两段的 HTTP 状态 + 响应体
 *      （已脱敏、截断）全部原样返回，绝不吞 —— 真机上一次失败就能照着实测改。
 *   ② 拿 code + code_verifier 去 `oauth.secure.pixiv.net/auth/token` 换 refresh_token / access_token。
 *
 * 凭证只发往 app-api.pixiv.net 与 oauth.secure.pixiv.net（cookie 只加在 app-api 那次请求头上）。
 * @param {string} cookieValue 整条 cookie 串 / `PHPSESSID=xxx` / 光秃秃的会话值都认
 * @returns {Promise<{ok:boolean, userId?:string, userName?:string, expiresAt?:number, persisted?:boolean,
 *                    error?:string, status?:number, body?:string, attempts:Array<{label:string,status:number,location:string,body:string}>}>}
 */
export async function loginWithPhpSessid(cookieValue) {
  const sessid = normalizePhpSessid(cookieValue);
  const attempts = [];
  if (!sessid) {
    return { ok: false, error: 'PHPSESSID 认不出来：给 `PHPSESSID=xxxx`、整条 cookie 串，或者只给会话值本身', attempts };
  }
  const { verifier, challenge } = generatePixivPkce();
  const secrets = [sessid, verifier];
  const bodyJson = JSON.stringify({ code_challenge: challenge, code_challenge_method: 'S256', client: 'pixiv-android' });
  const getUrl = `${PIXIV_WEB_LOGIN_URL}?${new URLSearchParams({ code_challenge: challenge, code_challenge_method: 'S256', client: 'pixiv-android' })}`;

  // cookie 只加在这里（app-api.pixiv.net 的 web 登录口）；下面的 oauth 换 token 请求不带 cookie。
  const withCookie = (extra = {}) => ({ ...pixivAppHeaders(extra), cookie: `PHPSESSID=${sessid}` });

  const tries = [
    ['GET 带 query 参数', () => fetch(getUrl, { method: 'GET', headers: withCookie(), redirect: 'manual', signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS) })],
    ['POST JSON', () => fetch(PIXIV_WEB_LOGIN_URL, { method: 'POST', headers: withCookie({ contentType: 'application/json' }), body: bodyJson, redirect: 'manual', signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS) })],
  ];

  let code = '';
  for (const [label, run] of tries) {
    let res;
    let text = '';
    try {
      res = await run();
      text = await res.text();
    } catch (e) {
      attempts.push({ label, status: 0, location: '', body: `请求异常：${e?.message ?? e}` });
      continue;
    }
    const location = String(res.headers?.get?.('location') ?? '');
    // 4xx/5xx 的响应体里也可能出现 "code"（错误码），一律不当登录 code 用。
    code = extractLoginCode(location) || (res.status < 400 ? extractLoginCode(text) : '');
    attempts.push({ label, status: res.status, location: echo(location, secrets), body: echo(text, secrets) });
    if (code) break;
  }

  if (!code) {
    return {
      ok: false,
      error: `两次尝试都没拿到 login code（PHPSESSID(len=${sessid.length})）—— 多半是 cookie 无效/过期，或 pixiv 改了登录形状；逐个形状的 HTTP 状态与响应体见 attempts`,
      attempts,
    };
  }

  const ex = await exchangePixivCode(code, verifier);
  if (!ex.ok) {
    return { ok: false, error: `换 refresh_token 失败：${ex.error}`, status: ex.status, body: ex.body, attempts };
  }
  return {
    ok: true,
    userId: ex.userId,
    userName: ex.userName,
    expiresAt: ex.expiresAt,
    persisted: ex.persisted,
    error: ex.error,
    attempts,
  };
}
