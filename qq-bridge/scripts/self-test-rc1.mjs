// rc.1 桥接迁移验收脚本: 完整跑一个 turn, 验证 turn/end 边界与 assistant 最终文本可收集。
// 用法: qbm-node scripts/self-test-rc1.mjs [baseUrl]
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { fileURLToPath } from 'node:url';
const dsh = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'dsh-client.js')).href);
const { NodeApiClient, unwrap } = dsh;

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:13210';
const api = new NodeApiClient(baseUrl, 30000, { dshLogFile: process.env.DSH_ISOLATED_LOG_FILE });
const cookie = await api._ensureSession();
console.log('cookie:', !!cookie);
if (!cookie) process.exit(2);

async function unary(method, args) {
  const res = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r' + Math.random().toString(36).slice(2, 10), method, payload: { args } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${method}`);
  const env = await res.json();
  if (!env.result.ok) throw new Error(`${method}: ${env.result.error.code}: ${env.result.error.message}`);
  return env.result.value;
}

const ROOT = path.resolve(__dirname, '..');
const cwd = path.join(ROOT, 'state', 'selftest-rc1');
fs.mkdirSync(cwd, { recursive: true });
const created = await unary('session/create', { request: { cwd } });
const sessionId = created.sessionId;
console.log('created:', sessionId);

// 打开 WS remote.mux, 复用一条连接开 session/follow 与 $events 两条流
const WSUrl = baseUrl.replace(/^http/, 'ws') + '/api/remote.mux';
const ws = new WebSocket(WSUrl, { headers: { cookie } });
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
console.log('ws open');

const followId = 'f' + crypto.randomUUID();
const eventsId = 'e' + crypto.randomUUID();
const byStream = new Map();
ws.addEventListener('message', (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.type === 'item' && msg.streamId) {
    const arr = byStream.get(msg.streamId);
    if (arr) arr.push(msg.value);
  }
  if (msg.type === 'end' && msg.streamId) {
    const arr = byStream.get(msg.streamId);
    if (arr) arr.push({ __end: true });
  }
  if (msg.type === 'error' && msg.streamId) {
    const arr = byStream.get(msg.streamId);
    if (arr) arr.push({ __error: msg.error });
  }
});
function tail(streamId) {
  let arr = byStream.get(streamId);
  if (!arr) { arr = []; byStream.set(streamId, arr); }
  return arr;
}

// 开 session/follow
ws.send(JSON.stringify({
  type: 'open', streamId: followId, endpoint: 'session/follow',
  payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 60 } } },
}));
// 开 $events (收 approval/user-questions waterfall)
ws.send(JSON.stringify({
  type: 'open', streamId: eventsId, endpoint: '$events',
  payload: { args: {} },
}));
tail(followId); tail(eventsId);

// 等 follow snapshot
let snapshot = null;
for (let i = 0; i < 50; i++) {
  const items = tail(followId);
  const snap = items.find((it) => it && it.type === 'snapshot');
  if (snap) { snapshot = snap; break; }
  await new Promise((r) => setTimeout(r, 200));
}
console.log('snapshot cursor:', snapshot?.cursor, 'records:', snapshot?.records?.length ?? 0);

// prompt: queue 模式
const promptText = '只回复两个字：收到';
const requestId = 'req-' + crypto.randomUUID();
const accepted = await unary('session/prompt', {
  request: { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] },
});
console.log('prompt accepted:', accepted.accepted);

// 记录事件 seq, 结束时以实际游标 page 读回
const deadline = Date.now() + 90000;
let turnEnd = null;
const seen = [];
const lastSeq = { v: -1 };
let assistantText = '';
while (Date.now() < deadline) {
  const items = tail(followId);
  while (items.length) {
    const it = items.shift();
    if (!it) continue;
    if (it.__end || it.__error) { console.log('stream terminal:', JSON.stringify(it).slice(0, 200)); process.exit(3); }
    if (it.type === 'event') {
      const t = it.event?.type;
      if (typeof it.event?.seq === 'number' && it.event.seq > lastSeq.v) lastSeq.v = it.event.seq;
      if (!seen.includes(t)) { seen.push(t); console.log('ev:', t); }
      if (t === 'turn/end') { turnEnd = it.event; items.length = 0; break; }
    }
  }
  if (turnEnd) break;
  await new Promise((r) => setTimeout(r, 300));
}
if (!turnEnd) { console.log('TIMEOUT waiting turn/end'); process.exit(4); }
console.log('turn/end reason:', JSON.stringify(turnEnd.data?.reason ?? null).slice(0, 300));

// page 读回完整事件拿最终 assistant 文本 (throughSeq 用最后已知 seq)
const page = await unary('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: Math.max(lastSeq.v, 0) } });
const text = page.records
  .filter((rec) => rec.type === 'event' && rec.event.type === 'assistant/message')
  .map((rec) => JSON.stringify(rec.event.data))
  .join('\n');
console.log('--- page records count:', page.records.length);
console.log(text.slice(0, 2000));

try { ws.close(); } catch {}
console.log('DONE');
process.exit(0);
