/**
 * NapCat WebUI 令牌验证的**唯一入口**：把"登录"变成一笔有预算的稀缺资源。
 *
 * 现场（2026-09-22 主人报「问不到 NapCat 状态：/api/napcat/webui-ready → HTTP 500，而且还鉴权失败，登录还 limit」）：
 *   · 500 是管理器自己的 bug：那条 handler 第一句就用了没定义的 `cfg`（ReferenceError），所以永远 500；
 *   · "登录 limit" 来自 NapCat 自己：`napcat.mjs` 的 `checkLoginRate(ip, loginRate)` 是**每 IP 每 60 秒**
 *     最多 `loginRate`（出厂 10，见 `napcat/config/webui.json`）次登录尝试，超了回 `login rate limit`；
 *     **WebUI 页面自己也要从这个额度里登录一次**。
 *   · 而管理器这边的多条路径都把登录接口当状态探针用（历史遗留），本机走 127.0.0.1、服务端走 SSH 隧道
 *     （NapCat 看到的来源同样是 127.0.0.1）—— 于是管理器的探测和页面自己的登录**抢同一个桶**，
 *     探针多打几下，页面就再也登不进去（"进去就鉴权失败"）。
 *
 * 所以这里做三件事：
 *   ① 一次登录只在这一个模块里发生，其它代码只能读缓存结论（`peek`）；
 *   ② 自建预算：每 (scope, port) 每 60 秒最多 2 次（= 出厂 loginRate 10 的 1/5），把额度留给页面自己；
 *   ③ 认得 NapCat 的 `login rate limit`，进入冷却窗（65 秒）并**如实报给界面**，冷却期内一次都不补刀。
 *
 * 纯逻辑 + 依赖注入（fetch / 时钟 / 日志 / 哈希都能换），所以 `tools/test-napcat-webui-auth.mjs`
 * 能用一个假 NapCat（连它的限流语义一起仿）把上面三条全测出来，不需要真机。
 */

/** NapCat 的限流窗口（`Lp.set(n, 1, 60)`：60 秒 TTL）。 */
export const LOGIN_WINDOW_MS = 60 * 1000;
/** NapCat 出厂 loginRate（webui.json 里的 loginRate，默认 10）。 */
export const DEFAULT_NAPCAT_LOGIN_LIMIT = 10;
/** 我们自己的预算：默认只花 NapCat 额度的 1/5。 */
export const DEFAULT_BUDGET_RATIO = 5;
/** 验证成功后的结论缓存时长（token 不变就没必要再登一次）。 */
export const VERDICT_TTL_MS = 30 * 60 * 1000;
/** 验证失败（token 不对）后的结论缓存时长：60 秒内不重复打。 */
export const INVALID_TTL_MS = 60 * 1000;
/** 撞上 NapCat 限流后的冷却：比它的 60 秒窗口多一点。 */
export const RATE_LIMIT_COOLDOWN_MS = 65 * 1000;

/** NapCat 令牌的加盐：hash = sha256(token + '.napcat')（从它前端 bundle 的 loginWithToken() 读出来的）。 */
export const NAPCAT_TOKEN_SALT = '.napcat';

const sha256Like = (text) => {
  // 默认实现只是占位：调用方必须注入真正的 sha256（管理器用 node:crypto）。
  throw new Error('napcat-webui-auth: 需要注入 hashOf（sha256 hex）');
};

/**
 * @param {object} opts
 * @param {typeof fetch} [opts.fetchImpl] 注入的 fetch（测试用假 NapCat 时换掉）
 * @param {() => number} [opts.now] 注入的时钟（测试里可以快进）
 * @param {(msg: string) => void} [opts.log] 日志（每个**真实**登录尝试一行）
 * @param {(text: string) => string} [opts.hashOf] 普通 sha256 hex（加盐 `.napcat` 由本模块负责，默认抛错，必须注入）
 */
export function createNapcatWebuiAuth(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const hashOf = opts.hashOf ?? sha256Like;

  /** `${scope}:${port}` → { ok, status, token, at, message } */
  const verdicts = new Map();
  /** `${scope}:${port}` → number[]：本窗口内我们自己的登录尝试时刻 */
  const attempts = new Map();
  /** `${scope}:${port}` → 冷却截止时刻（撞限流后） */
  const cooldownUntil = new Map();
  /** `${scope}:${port}` → NapCat 的 loginRate（默认 10），可由调用方按 webui.json 校准 */
  const napcatLimits = new Map();

  const keyOf = (scope, port) => `${String(scope)}:${Number(port)}`;
  const budgetOf = (key) => {
    const napcatLimit = Math.max(1, Number(napcatLimits.get(key)) || DEFAULT_NAPCAT_LOGIN_LIMIT);
    return Math.max(1, Math.floor(napcatLimit / DEFAULT_BUDGET_RATIO));
  };
  const liveAttempts = (key) => {
    const list = (attempts.get(key) ?? []).filter((t) => now() - t < LOGIN_WINDOW_MS);
    attempts.set(key, list);
    return list;
  };

  /**
   * 这个 token 现在能不能登进去。**唯一**会真的打登录接口的地方。
   * @param {{scope:string, port:number, token:string, baseUrl?:string, timeoutMs?:number,
   *          reason?:string, force?:boolean, napcatLoginRate?:number}} args
   * @returns {Promise<{ok:boolean, status:'ok'|'cached'|'invalid'|'limited'|'budget'|'unreachable'|'no-token',
   *                    note:string, verifiedAt:number, retryAfterMs:number, attemptsInWindow:number}>}
   */
  async function verify(args) {
    const scope = String(args?.scope ?? 'local');
    const port = Number(args?.port) || 0;
    const token = String(args?.token ?? '').trim();
    const key = keyOf(scope, port);
    const timeoutMs = Math.min(30000, Math.max(500, Number(args?.timeoutMs) || 5000));
    const reason = String(args?.reason ?? 'probe');
    const force = args?.force === true;
    if (Number(args?.napcatLoginRate) > 0) napcatLimits.set(key, Number(args.napcatLoginRate));
    const base = String(args?.baseUrl ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');

    if (!token) {
      return { ok: false, status: 'no-token', note: '没有可用的 WebUI 令牌', verifiedAt: 0, retryAfterMs: 0, attemptsInWindow: liveAttempts(key).length };
    }

    // ① 冷却期（撞过 NapCat 限流）：一次都不打
    const cool = Number(cooldownUntil.get(key)) || 0;
    if (cool > now()) {
      return {
        ok: false, status: 'limited', verifiedAt: 0, attemptsInWindow: liveAttempts(key).length,
        retryAfterMs: cool - now(),
        note: `NapCat 登录接口刚被限流（它自己每 IP 每 60 秒只允许 ${Math.max(1, Number(napcatLimits.get(key)) || DEFAULT_NAPCAT_LOGIN_LIMIT)} 次），等 ${Math.ceil((cool - now()) / 1000)} 秒再问；直接打开界面不受影响`
      };
    }

    // ② 结论缓存：token 没变就不必再登
    const cached = verdicts.get(key);
    if (!force && cached && cached.token === token) {
      const age = now() - Number(cached.at || 0);
      if (cached.ok && age < VERDICT_TTL_MS) {
        return { ok: true, status: 'cached', verifiedAt: cached.at, retryAfterMs: 0, attemptsInWindow: liveAttempts(key).length, note: '令牌此前已验证通过（结论缓存内，没有再登一次）' };
      }
      if (!cached.ok && age < INVALID_TTL_MS) {
        return { ok: false, status: 'invalid', verifiedAt: cached.at, retryAfterMs: 0, attemptsInWindow: liveAttempts(key).length, note: cached.message || '令牌没通过' };
      }
    }

    // ③ 我们自己的预算：额度留给页面自己登录
    const budget = budgetOf(key);
    const used = liveAttempts(key);
    if (used.length >= budget) {
      const oldest = Math.min(...used);
      const retryAfterMs = Math.max(0, LOGIN_WINDOW_MS - (now() - oldest));
      return {
        ok: false, status: 'budget', verifiedAt: 0, attemptsInWindow: used.length, retryAfterMs,
        note: `本分钟管理器已经把自查额度用完了（自限 ${budget} 次/分钟，NapCat 上限 ${Math.max(1, Number(napcatLimits.get(key)) || DEFAULT_NAPCAT_LOGIN_LIMIT)} 次）—— 剩下的额度留给界面自己登录，${Math.ceil(retryAfterMs / 1000)} 秒后可再问`
      };
    }

    // ④ 真打一次
    used.push(now());
    attempts.set(key, used);
    const n = used.length;
    let res; let j = null;
    try {
      res = await fetchImpl(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hash: hashOf(token + NAPCAT_TOKEN_SALT) }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      j = await res.json().catch(() => null);
    } catch (e) {
      const msg = String(e?.name === 'TimeoutError' ? 'timeout' : (e?.message ?? e));
      log(`[napcat-auth] ${key} 登录自查 #${n}/${budget}（${reason}）→ 打不通：${msg}`);
      return { ok: false, status: 'unreachable', verifiedAt: 0, retryAfterMs: 0, attemptsInWindow: n, note: `打不通 NapCat WebUI（${base}）：${msg}` };
    }
    const code = j?.code ?? null;
    const message = String(j?.message ?? '').trim();
    if (Number(code) === 0) {
      verdicts.set(key, { ok: true, status: 'ok', token, at: now(), message: '' });
      cooldownUntil.delete(key);
      log(`[napcat-auth] ${key} 登录自查 #${n}/${budget}（${reason}）→ 通过`);
      return { ok: true, status: 'ok', verifiedAt: now(), retryAfterMs: 0, attemptsInWindow: n, note: '令牌验证通过' };
    }
    if (/rate\s*limit|too\s*many/i.test(message)) {
      // ⑤ 撞上 NapCat 的限流：冷却 + 清掉失败结论（否则会把"限流"当成"token 不对"缓存下来）
      cooldownUntil.set(key, now() + RATE_LIMIT_COOLDOWN_MS);
      verdicts.delete(key);
      log(`[napcat-auth] ${key} 登录自查 #${n}/${budget}（${reason}）→ 被 NapCat 限流（${message}），冷却 ${Math.round(RATE_LIMIT_COOLDOWN_MS / 1000)} 秒`);
      return {
        ok: false, status: 'limited', verifiedAt: 0, attemptsInWindow: n, retryAfterMs: RATE_LIMIT_COOLDOWN_MS,
        note: 'NapCat 登录接口被限流（登录尝试太密，它自己按 IP 计数）—— 已停手，等 65 秒再问；这**不代表** QQ 掉线'
      };
    }
    verdicts.set(key, { ok: false, status: 'invalid', token, at: now(), message: message || `code=${code}` });
    log(`[napcat-auth] ${key} 登录自查 #${n}/${budget}（${reason}）→ 没通过：${message || `code=${code}`}`);
    return { ok: false, status: 'invalid', verifiedAt: now(), attemptsInWindow: n, retryAfterMs: 0, note: `令牌没通过（NapCat 说：${message || `code=${code}`}）—— 多半是它还在启动，或令牌与它自己 webui.json 不一致` };
  }

  /** 只读缓存结论：**不联网**。给"状态面板"这类高频调用用。 */
  function peek(scope, port) {
    const key = keyOf(scope, port);
    const v = verdicts.get(key);
    const cool = Number(cooldownUntil.get(key)) || 0;
    return {
      verdict: v ? { ok: v.ok, status: v.status, at: v.at, message: v.message ?? '' } : null,
      limited: cool > now(),
      retryAfterMs: cool > now() ? cool - now() : 0,
      attemptsInWindow: liveAttempts(key).length
    };
  }

  /** 给界面看的账本（预算用了多少、NapCat 上限多少、冷却到什么时候）。 */
  function state(scope, port) {
    const key = keyOf(scope, port);
    const p = peek(scope, port);
    const napcatLimit = Math.max(1, Number(napcatLimits.get(key)) || DEFAULT_NAPCAT_LOGIN_LIMIT);
    return {
      napcatLimit,
      budget: budgetOf(key),
      windowMs: LOGIN_WINDOW_MS,
      attemptsInWindow: p.attemptsInWindow,
      limited: p.limited,
      retryAfterMs: p.retryAfterMs,
      verdict: p.verdict
    };
  }

  /** 测试/排障用：清空全部账本。 */
  function reset() {
    verdicts.clear(); attempts.clear(); cooldownUntil.clear(); napcatLimits.clear();
  }

  return { verify, peek, state, reset };
}
