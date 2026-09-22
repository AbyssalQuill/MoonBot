// NapCat WebUI 登录自查 funnel 的回归（2026-09-22 主人报「问不到 NapCat 状态：HTTP 500，而且还鉴权失败，
// 登录还 limit」）。
//
// 用一个**假 NapCat**（把它的限流语义照抄：每 IP 每 60 秒 loginRate 次登录尝试，超了回 `login rate limit`）
// 把三件必须成立的事测出来：
//   ① 面板/轮询路径**一次登录都不打**（`peek`/`state` 零网络）—— 额度留给 WebUI 页面自己；
//   ② 只有 `verify` 会真打，且结论进缓存（同 token 30 分钟内不重复登）、token 变了才重登；
//   ③ 撞上限流会进冷却并如实回报（`status:'limited'`），冷却期内**一次都不补刀**；自建预算也不会被突发打穿。
//
//   node tools/test-napcat-webui-auth.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createNapcatWebuiAuth, LOGIN_WINDOW_MS } from '../../server/napcat-webui-auth.js';

let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`); } else { console.log(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
};
const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

/** 假 NapCat：/webui/ 探活（不鉴权）+ /api/auth/login（照抄 NapCat 的 checkLoginRate 语义）。 */
function fakeNapcat({ token = '061228', loginRate = 10 } = {}) {
  const state = { logins: 0, attempts: [], ip: '' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/webui/' || url.pathname === '/webui') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>webui</html>');
      return;
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        state.logins += 1;
        state.ip = req.socket.remoteAddress || '';
        const now = Date.now();
        state.attempts = state.attempts.filter((t) => now - t < LOGIN_WINDOW_MS);
        // NapCat: r === 0 → 放行并计数；否则 r >= limit 就拒绝（注意它是"先判断再计数"）
        const r = state.attempts.length;
        let allow;
        if (r === 0) { state.attempts.push(now); allow = true; }
        else if (r >= loginRate) { allow = false; }
        else { state.attempts.push(now); allow = true; }
        const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (!allow) return send({ code: -1, message: 'login rate limit' });
        let hash = '';
        try { hash = JSON.parse(body).hash || ''; } catch { /* 空 body */ }
        if (hash === sha256(token + '.napcat')) return send({ code: 0, message: 'ok', data: { Credential: 'cred-' + state.logins } });
        return send({ code: -1, message: 'token is invalid' });
      });
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  return { server, state };
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** 可控时钟：让"60 秒窗口"能在毫秒级测出来。 */
function clock() {
  let t = 1_700_000_000_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

console.log('== ① 轮询/面板路径零登录 ==');
{
  const { server, state } = fakeNapcat();
  const port = await listen(server);
  const c = clock();
  const auth = createNapcatWebuiAuth({ now: c.now, hashOf: sha256 });
  for (let i = 0; i < 20; i++) { auth.peek('srv', port); auth.state('srv', port); }
  ok('20 次 peek + 20 次 state 之后，假 NapCat 收到 0 次登录', state.logins === 0, 'logins=' + state.logins);
  ok('peek 报告"从没验过"', auth.peek('srv', port).verdict === null);
  server.close();
}

console.log('== ② 只有 verify 才真打，且结论进缓存 ==');
{
  const { server, state } = fakeNapcat();
  const port = await listen(server);
  const c = clock();
  const auth = createNapcatWebuiAuth({ now: c.now, hashOf: sha256 });
  const r1 = await auth.verify({ scope: 'srv', port, token: '061228', reason: 'manual' });
  ok('第一次 verify 通过', r1.ok === true && r1.status === 'ok', JSON.stringify(r1));
  ok('假 NapCat 恰好收到 1 次登录', state.logins === 1, 'logins=' + state.logins);
  for (let i = 0; i < 5; i++) await auth.verify({ scope: 'srv', port, token: '061228', reason: 'state' });
  ok('之后 5 次 verify 全部命中缓存（还是 1 次登录）', state.logins === 1, 'logins=' + state.logins);
  ok('缓存命中时 status=cached', (await auth.verify({ scope: 'srv', port, token: '061228' })).status === 'cached');
  c.advance(31 * 60 * 1000);   // 超过结论 TTL
  await auth.verify({ scope: 'srv', port, token: '061228', reason: 'state' });
  ok('结论过期后会重新验一次（2 次）', state.logins === 2, 'logins=' + state.logins);
  const rBad = await auth.verify({ scope: 'srv', port, token: '错的令牌', reason: 'state' });
  ok('换了 token → 重新验，并如实说没通过', rBad.ok === false && rBad.status === 'invalid', JSON.stringify(rBad));
  ok('假 NapCat 现在 3 次登录', state.logins === 3, 'logins=' + state.logins);
  await auth.verify({ scope: 'srv', port, token: '错的令牌', reason: 'state' });
  ok('错 token 的结论也会缓存（60 秒内不再打）', state.logins === 3, 'logins=' + state.logins);
  server.close();
}

console.log('== ③ 自建预算：突发也不会打穿额度 ==');
{
  const { server, state } = fakeNapcat({ loginRate: 10 });
  const port = await listen(server);
  const c = clock();
  const auth = createNapcatWebuiAuth({ now: c.now, hashOf: sha256 });
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await auth.verify({ scope: 'srv', port, token: '061228', reason: 'manual', force: true }));
  ok('force 也受预算约束：只真打了 2 次（10 的 1/5）', state.logins === 2, 'logins=' + state.logins);
  ok('超预算的那几次报 status=budget', results.filter((r) => r.status === 'budget').length === 4, results.map((r) => r.status).join(','));
  ok('budget 回报里带 retryAfterMs（界面能显示还要等多久）', results[2].retryAfterMs > 0 && results[2].retryAfterMs <= LOGIN_WINDOW_MS, String(results[2].retryAfterMs));
  c.advance(LOGIN_WINDOW_MS + 1000);
  await auth.verify({ scope: 'srv', port, token: '061228', reason: 'manual', force: true });
  ok('窗口过去后又能验一次', state.logins === 3, 'logins=' + state.logins);
  server.close();
}

console.log('== ④ 撞上 NapCat 限流 → 冷却期内一次都不补刀 ==');
{
  // loginRate=1：第一次登录就吃掉全部额度，第二次必然被 NapCat 拒
  const { server, state } = fakeNapcat({ loginRate: 1 });
  const port = await listen(server);
  const c = clock();
  const auth = createNapcatWebuiAuth({ now: c.now, hashOf: sha256 });
  const r1 = await auth.verify({ scope: 'srv', port, token: '061228', reason: 'manual' });
  ok('第一次通过', r1.ok === true, JSON.stringify(r1));
  const r2 = await auth.verify({ scope: 'srv', port, token: '别的令牌', reason: 'manual', force: true });
  ok('第二次被 NapCat 限流 → status=limited（不是 invalid）', r2.status === 'limited', JSON.stringify(r2));
  ok('限流回报是人话（说明只管自查、不代表 QQ 掉线）', /限流/.test(r2.note) && /不代表/.test(r2.note), r2.note);
  ok('限流时带 retryAfterMs≈65 秒', r2.retryAfterMs >= 60_000, String(r2.retryAfterMs));
  const before = state.logins;
  for (let i = 0; i < 5; i++) await auth.verify({ scope: 'srv', port, token: '061228', reason: 'manual', force: true });
  ok('冷却期内 5 次 verify 全被挡下（一次都没再打）', state.logins === before, 'logins=' + state.logins);
  ok('冷却期内 peek/state 也说 limited', auth.peek('srv', port).limited === true && auth.state('srv', port).limited === true);
  c.advance(66_000);
  ok('冷却过后不再报 limited', auth.peek('srv', port).limited === false);
  server.close();
}

console.log('== ⑤ 空 token / 打不通都是"如实说"，不伪装成"令牌不对" ==');
{
  const { server } = fakeNapcat();
  const port = await listen(server);
  const c = clock();
  const auth = createNapcatWebuiAuth({ now: c.now, hashOf: sha256 });
  const rNo = await auth.verify({ scope: 'srv', port, token: '', reason: 'state' });
  ok('空 token → no-token', rNo.status === 'no-token', JSON.stringify(rNo));
  const rDead = await auth.verify({ scope: 'srv', port: 1, token: '061228', timeoutMs: 800 });
  ok('端口不通 → unreachable（不是 invalid）', rDead.status === 'unreachable', JSON.stringify(rDead));
  server.close();
}

console.log('== ⑥ 账本给界面看的数字 ==');
{
  const { server } = fakeNapcat();
  const port = await listen(server);
  const c = clock();
  const auth = createNapcatWebuiAuth({ now: c.now, hashOf: sha256 });
  await auth.verify({ scope: 'srv', port, token: '061228', napcatLoginRate: 20, reason: 'manual' });
  const st = auth.state('srv', port);
  ok('按 webui.json 的 loginRate 校准（20 → 预算 4）', st.napcatLimit === 20 && st.budget === 4, JSON.stringify(st));
  ok('账本里有窗口长度与已用次数', st.windowMs === LOGIN_WINDOW_MS && st.attemptsInWindow === 1, JSON.stringify(st));
  ok('scope 分开记账（另一个 scope 不受影响）', auth.state('local', port).attemptsInWindow === 0);
  server.close();
}

console.log(`\nALL PASS  pass=${pass} fail=${process.exitCode ? 1 : 0}`);
