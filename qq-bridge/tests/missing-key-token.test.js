// 回归测试：模型漏传 key/token 时不再「-32602 校验失败」，而是自动补齐/给出可执行提示。
//
// 线上报错原文：
//   Error: MCP error -32602: Input validation error: Invalid arguments for tool qq_send_message:
//   Invalid input: expected string, received undefined at key
//   Invalid input: expected string, received undefined at token
// 根因：会话级工具的 zod schema 把 key/token 声明成必填 → 请求在进处理器之前就被 SDK 打回，
// 模型拿不到任何可执行提示，答不上人，还白烧一整个模型步（该会话实测 ≈34k tokens/步）。
//
// 本测试用一个**桩桥**（临时端口）验证：
//   ① 只传 messages、不传 key/token → 工具自动按"当前在途会话"补齐，并把消息真的发出去；
//   ② 桥说"无法推断"（409）→ 回一句能照着做的提示，而不是 JSON schema 校验失败；
//   ③ tools/list 的 schema 里 key/token 不再是 required（否则 -32602 还会发生）。
//
// 用法：node tests/missing-key-token.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_TOKEN = 'test-console-token';
const AGENT_TOKEN = 'agent-token-abc';
const SESSION_KEY = 'private:100001';

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});

const port = await freePort();
// 沙盒必须放在**仓库内**（tests/.tmp-keys）：MCP server 要 import @modelcontextprotocol/sdk，
// 放到系统临时目录会解析不到 qq-bridge/node_modules（ERR_MODULE_NOT_FOUND）。
const sandbox = path.join(HERE, '.tmp-keys');
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(sandbox, { recursive: true });
fs.cpSync(path.join(HERE, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-keys-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({
  ownerQQ: '100001',
  consolePort: port,
  consoleToken: CONSOLE_TOKEN,
  napcat: { httpUrl: 'http://127.0.0.1:1' },
  dsh: { baseUrl: 'http://127.0.0.1:1' },
}, null, 2));

// ── 桩桥 ────────────────────────────────────────────────────────────────
const seen = { currentTurn: 0, sendMessage: [] };
let currentTurnMode = 'ok';   // ok | ambiguous
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = (() => { try { return JSON.parse(raw || '{}'); } catch { return {}; } })();
    const reply = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/api/social/current-turn') {
      seen.currentTurn += 1;
      if (req.headers['x-console-token'] !== CONSOLE_TOKEN) return reply(403, { ok: false, error: 'bad console token' });
      if (currentTurnMode === 'ambiguous') return reply(409, { ok: false, reason: 'ambiguous', active: ['private:1', 'private:2'] });
      return reply(200, { ok: true, key: SESSION_KEY, token: AGENT_TOKEN, source: 'active-turn' });
    }
    if (req.url === '/api/social/send-message') {
      seen.sendMessage.push({ key: body.key, agentToken: req.headers['x-agent-token'], messages: body.messages });
      if (body.key !== SESSION_KEY || req.headers['x-agent-token'] !== AGENT_TOKEN) {
        return reply(403, { ok: false, error: 'default 模式发送必须携带有效 agent token' });
      }
      return reply(200, { ok: true, key: body.key, sent: 1, failed: 0, delays: [], quoted: null });
    }
    return reply(404, { ok: false, error: 'stub: no such endpoint ' + req.url });
  });
});
await new Promise((r) => stub.listen(port, '127.0.0.1', r));

// ── MCP 客户端 ───────────────────────────────────────────────────────────
function startServer(serverFile, timeoutMs = 25000) {
  const child = spawn(process.execPath, [serverFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let seq = 700;
  const pending = new Map();
  child.stdout.on('data', (c) => {
    stdout += c.toString('utf8');
    let idx;
    while ((idx = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, idx).trim();
      stdout = stdout.slice(idx + 1);
      if (!line.startsWith('{')) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}; stderr=${stderr.slice(0, 300)}`)); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    send({ jsonrpc: '2.0', id, method, params });
  });
  return { rpc, send, stop: () => { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} } };
}

const srv = startServer(path.join(sandbox, 'src', 'mcp-napcat-safe.js'));
await srv.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'keys-test', version: '0' } });
srv.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

const call = async (name, args) => {
  const r = await srv.rpc('tools/call', { name, arguments: args });
  return { isError: !!r.result?.isError, text: String(r.result?.content?.[0]?.text ?? ''), raw: r };
};

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

console.log('== 漏传 key/token ==');

const list = await srv.rpc('tools/list', {});
const sendTool = (list.result?.tools ?? []).find((x) => x.name === 'qq_send_message');
await t('schema：qq_send_message 的 required 里不再有 key/token', () => {
  assert.ok(sendTool, 'qq_send_message 未注册');
  const req = sendTool.inputSchema?.required ?? [];
  assert.ok(!req.includes('key'), 'required 里还有 key：' + JSON.stringify(req));
  assert.ok(!req.includes('token'), 'required 里还有 token：' + JSON.stringify(req));
});

const okCall = await call('qq_send_message', { messages: '在的' });
await t('只传 messages：**直接拒绝**（绝不猜会话）—— 契约是"缺 key 就当错"', () => {
  /* 2026-09-22 改口径：这条断言原来要求"自动补齐 key/token 并真的发出"，那是**改契约之前**的行为。
   * 现在（起因：一次 pixiv 发图发错群）缺 key 一律拒绝，绝不替模型猜会话：
   *   mcp-napcat-safe.js 里 schema 声明了 key → hasKeyField=true → 不传 key 命中 missingKey 分支。 */
  assert.ok(!/Invalid input|Invalid arguments|-32602/.test(okCall.text), '不该是 schema 校验失败：' + okCall.text.slice(0, 200));
  assert.equal(okCall.isError, true, '缺 key 必须是错误：' + okCall.text.slice(0, 200));
  assert.ok(/缺\s*key|缺 key/i.test(okCall.text), '应提示缺 key：' + okCall.text.slice(0, 200));
  assert.equal(seen.sendMessage.length, 0, '缺 key 时**不该**向桩桥发任何请求（不能猜会话）');
});

currentTurnMode = 'ambiguous';
// 换一个全新的 MCP 进程（避免命中"刚补过"的 5 秒缓存），模拟"桥说无法推断"的情形
const srv2 = startServer(path.join(sandbox, 'src', 'mcp-napcat-safe.js'));
await srv2.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'keys-test-2', version: '0' } });
srv2.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
const r2 = await srv2.rpc('tools/call', { name: 'qq_send_message', arguments: { messages: '在的' } });
const ambiguous = { isError: !!r2.result?.isError, text: String(r2.result?.content?.[0]?.text ?? '') };
await t('缺 key：回可执行提示（指名去哪一行取），且不是 schema 校验失败', () => {
  /* 2026-09-22 改口径：缺 key 的提示现在指向**唤醒正文的 [Session] 行**（[Token] 只出现在"缺 token"
   * 那条分支里，而本用例走的是"缺 key"分支）。断言改成按实际契约来，不再钉死旧文案。 */
  assert.equal(ambiguous.isError, true);
  assert.ok(/缺\s*key/i.test(ambiguous.text), '提示文案不对：' + ambiguous.text.slice(0, 200));
  assert.ok(/\[Session\]/.test(ambiguous.text), '提示里要指名去 [Session] 行取 key：' + ambiguous.text.slice(0, 200));
  assert.ok(!/Invalid input|Invalid arguments/.test(ambiguous.text));
});
srv2.stop();

srv.stop();
stub.close();
fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
