// 回归测试：【重复失败短路】同一个工具 + 完全相同的参数，90s 内第二次直接短路，不再真的执行。
//
// 线上实测（2026-09-14 22:52–22:53 私聊）：模型一次并列调 3 个 qq_send_sticker（同一 stickerId 连失败 3 次），
// 下一步又原样重试 —— 每次失败都要付**一整个模型步**的上下文重发（该会话 ≈34k tokens/步）。
//
// 用 qq_send_meme 的"找不到这张表情"路径触发确定性失败：纯本地查库、不发网络请求、不碰真状态。
// 用法：node tests/repeat-failure-guard.test.js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'src', 'mcp-napcat-safe.js');

function startServer(serverFile, timeoutMs = 25000) {
  const child = spawn(process.execPath, [serverFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let seq = 500;
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}; stderr=${stderr.slice(0, 200)}`)); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    send({ jsonrpc: '2.0', id, method, params });
  });
  return { rpc, send, stop: () => { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} } };
}

const srv = startServer(SERVER);
let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

await srv.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'repeat-guard-test', version: '0' } });
srv.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

const call = async (name, args) => {
  const r = await srv.rpc('tools/call', { name, arguments: args });
  return { isError: !!r.result?.isError, text: String(r.result?.content?.[0]?.text ?? '') };
};

console.log('== 重复失败短路 ==');
const args = { key: 'private:10001', token: 'test-token', file: '__no_such_meme__.webp' };

const first = await call('qq_send_meme', args);
await t('第一次失败：正常报错（不是短路文案）', () => {
  assert.equal(first.isError, true, 'first should fail: ' + first.text.slice(0, 120));
  assert.ok(!first.text.includes('刚刚已经失败过'), '第一次不该是短路文案');
});

const second = await call('qq_send_meme', args);
await t('同参数第二次：被短路，并明确叫它别再重复', () => {
  assert.equal(second.isError, true);
  assert.ok(second.text.includes('刚刚已经失败过'), '第二次应命中短路：' + second.text.slice(0, 160));
  assert.ok(/不要用完全相同的参数再试一次/.test(second.text));
});

const other = await call('qq_send_meme', { key: 'private:10001', token: 'test-token', file: '__another_missing__.webp' });
await t('换了参数：不短路（只挡完全相同的调用）', () => {
  assert.equal(other.isError, true);
  assert.ok(!other.text.includes('刚刚已经失败过'), '换参数不该被短路：' + other.text.slice(0, 160));
});

srv.stop();
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
