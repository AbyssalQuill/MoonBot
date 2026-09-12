// dsh-qq-hold 插件隔离测试：验证"桥不可用/超时/被 abort 时必须放行关回合，绝不卡死"。
// 这是整个 turn-hold 方案里最要命的一条：插件若在 turn-stopping 里挂住，回合就永远关不掉。
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD = pathToFileURL(path.join(ROOT, 'plugins', 'dsh-qq-hold', 'lib', 'index.js')).href;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
}

function makeCtx() {
  const listeners = [];
  return { listeners, on: (ev, fn) => { listeners.push({ ev, fn }); } };
}
function newListener(cfg) {
  const c = makeCtx();
  mod.apply(c, cfg);
  if (c.listeners.length !== 1) throw new Error('listener 注册数异常: ' + c.listeners.length);
  return c.listeners[0].fn;
}

const mod = await import(MOD);
check('导出 name', mod.name === 'dsh-qq-hold', String(mod.name));
check('导出 apply', typeof mod.apply === 'function');

const probe = makeCtx();
mod.apply(probe, {});
check('注册到 agent/turn-stopping', probe.listeners[0]?.ev === 'agent/turn-stopping', probe.listeners[0]?.ev);

// A. 桥完全不可达（端口 9）→ 必须立刻返回，不能把回合边界卡住
{
  const fn = newListener({ endpoint: 'http://127.0.0.1:9/nope', timeoutMs: 3000 });
  const t0 = Date.now();
  let threw = null;
  let nextCalled = false;
  try { await fn({ agent: { session: { id: 'sess-A' } }, turn: 1 }, () => { nextCalled = true; }); }
  catch (e) { threw = e; }
  const ms = Date.now() - t0;
  check('A 桥不可达：不抛异常', threw === null, threw ? String(threw) : '');
  check('A 桥不可达：1s 内返回（不卡回合）', ms < 1000, ms + 'ms');
  check('A next() 被调用（不挂死后续监听器）', nextCalled);
}

// 起一个本地假桥
let mode = 'close-disabled';
let sawBody = null;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    sawBody = raw;
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (mode === 'slow-steer') { await new Promise((r) => setTimeout(r, 1500)); return json({ ok: true, close: false, reason: 'steered', exchanges: 2 }); }
    if (mode === 'hang') return; // 永不响应 → 只能靠 abort / 超时脱身
    return json({ ok: true, close: true, reason: 'disabled', exchanges: 0 });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const endpoint = `http://127.0.0.1:${server.address().port}/api/qq/turn-hold`;

// B. 关闭态（桥说 close）→ 快速返回
{
  mode = 'close-disabled';
  const fn = newListener({ endpoint, timeoutMs: 3000 });
  const t0 = Date.now();
  await fn({ agent: { session: { id: 'sess-B' } }, turn: 2 }, () => {});
  const ms = Date.now() - t0;
  check('B 关闭态：快速返回', ms < 800, ms + 'ms');
  check('B 请求体含 sessionId 与 turn', /"sessionId":"sess-B"/.test(sawBody || '') && /"turn":2/.test(sawBody || ''), sawBody);
}

// C. 保持态（桥拖 1.5s 再答 steer）→ 插件必须真的等，这才叫"吊住回合边界"
{
  mode = 'slow-steer';
  const fn = newListener({ endpoint, timeoutMs: 6000 });
  const t0 = Date.now();
  await fn({ agent: { session: { id: 'sess-C' } }, turn: 3 }, () => {});
  const ms = Date.now() - t0;
  check('C 保持态：确实等到桥回答（>=1.4s）', ms >= 1400, ms + 'ms');
}

// D. 回合被 abort（DSH 关闭/取消）→ 必须立刻脱身，不等满超时
{
  mode = 'hang';
  const fn = newListener({ endpoint, timeoutMs: 10000 });
  const ac = new AbortController();
  const t0 = Date.now();
  const p = fn({ agent: { session: { id: 'sess-D' } }, turn: 4, signal: ac.signal }, () => {});
  setTimeout(() => ac.abort(), 300);
  await p;
  const ms = Date.now() - t0;
  check('D abort 后立刻返回（<2s，远小于 10s 超时）', ms < 2000, ms + 'ms');
}

// E. 没有 session.id 时也要放行（不能因为取不到 id 就卡住）
{
  const fn = newListener({ endpoint, timeoutMs: 3000 });
  const t0 = Date.now();
  await fn({ agent: {}, turn: 5 }, () => {});
  check('E 取不到 session.id：立刻放行', Date.now() - t0 < 200, (Date.now() - t0) + 'ms');
}

server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n结果：通过 ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
