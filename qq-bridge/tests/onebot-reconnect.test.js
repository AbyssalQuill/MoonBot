// 回归测试：NapCat WebSocket 客户端的"判死即重建"（2026-09-16 修「又不回复了」）
//
// 线上故障（服务器 09-16 00:33 UTC 之后）：
//   16:33:35 NapCat 连接断开（code=1006），重连中…
//   16:33:52 NapCat 错误: Connection was closed before it was established.
//   16:35:17 起每 30 秒只刷「NapCat 心跳超时（假死），强制重建连接」——
//   **再没有任何重连尝试**；同期 NapCat 那边私聊/群聊消息照收（QQ 已登录）、
//   从桥主机手工建 WS 到 3001 一秒就 open（token 也一致）⇒ 是桥自己聋了，只有重启桥才恢复。
//
// 根因：undici 的 WebSocket 在握手失败/连接已死时**只发 error、不发 close**，
// 而重连链（_scheduleReconnect）挂在 onclose 里；看门狗又只会 `_ws.close()`（对死 socket 是空操作），
// 于是每 30 秒刷一次"假死"，连接永远不回来。现在判死走 _forceReconnect()：直接换 socket 并重排重连。
//
// 用法：node tests/onebot-reconnect.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-ws-'));
fs.cpSync(path.join(here, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-ws-sandbox', private: true, type: 'module' }));

// 假的 WebSocket：只记录实例，**什么都不触发** —— 精确复刻"只 error、不 close"的 undici 行为。
// 但构造后 5ms 会 fire 一次 onopen（模拟"曾经连上过"这个真实前提，否则 _openOnce 的 Promise 不会 settle）。
class FakeWS {
  constructor(url) {
    this.url = url; this.readyState = 0; this.closeCount = 0;
    FakeWS.instances.push(this);
    setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; try { this.onopen?.(); } catch { /* ignore */ } } }, 5);
  }
  close() { this.closeCount += 1; this.readyState = 3; }   // 故意不回调 onclose
  send() {}
  addEventListener() {}
}
FakeWS.instances = [];
globalThis.WebSocket = FakeWS;

const url = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const { OneBotWsClient } = await import(url('lib/onebot-ws.js'));

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('== NapCat WS 判死即重建 ==');

// ① 对照：旧实现「只 close、不重排」→ 永远不会有新连接（说明为什么必须 _forceReconnect）
{
  const before = FakeWS.instances.length;
  const c = new OneBotWsClient({ url: 'ws://127.0.0.1:3001', accessToken: 'tok' });
  await c._openOnce();
  assert.equal(FakeWS.instances.length, before + 1, '第一条连接应被创建');
  c._ws.close(4001, 'heartbeat timeout');       // ← 旧看门狗只做这一件事
  await sleep(2200);
  assert.equal(FakeWS.instances.length, before + 1, '对照：只 close 是不产生新连接的');
  c.dispose();
  console.log(`  PASS 对照：只 close（旧实现）不会重建 —— 这就是"每 30 秒刷假死却永远接不回"的原因`);
  pass += 1;
}

// ② 新实现：判死 → 必须真的换 socket 并重连
{
  const before = FakeWS.instances.length;
  const c = new OneBotWsClient({ url: 'ws://127.0.0.1:3001', accessToken: 'tok' });
  await c._openOnce();
  const dead = c._ws;
  assert.equal(dead.closeCount, 0);
  c._forceReconnect('heartbeat timeout');        // ← 看门狗/onerror/连接超时现在走的都是这一句
  assert.equal(c._ws, null, '被换掉的 socket 不能继续挂在客户端上');
  assert.equal(dead.closeCount, 1, '死 socket 要被关一次（尽力而为）');
  await sleep(2200);
  assert.equal(FakeWS.instances.length, before + 2, '判死后必须真的新建一条连接');
  assert.notEqual(c._ws, dead, '新 socket 必须替换旧的');
  c.dispose();
  console.log('  PASS 判死即重建：心跳超时后确实新建了连接（不再依赖 close 事件）');
  pass += 1;
}

// ③ 幂等：连续判死不会开出多条连接（只留一个重连定时器；退避会拉长，所以等久一点）
{
  const before = FakeWS.instances.length;
  const c = new OneBotWsClient({ url: 'ws://127.0.0.1:3001', accessToken: 'tok' });
  await c._openOnce();
  c._forceReconnect('a');
  c._forceReconnect('b');
  c._forceReconnect('c');
  await sleep(7000);   // 三次判死把退避推到 1500*4*(0.5~1)s，这里等满一轮
  assert.equal(FakeWS.instances.length, before + 2, '三次判死只应产生一条新连接（旧定时器被清掉）');
  c.dispose();
  console.log('  PASS 幂等：连续判死只重连一次（不会重连风暴）');
  pass += 1;
}

// ④ dispose 之后不许再重连
{
  const before = FakeWS.instances.length;
  const c = new OneBotWsClient({ url: 'ws://127.0.0.1:3001', accessToken: 'tok' });
  await c._openOnce();
  c.dispose();
  c._forceReconnect('after dispose');
  await sleep(2200);
  assert.equal(FakeWS.instances.length, before + 1, 'dispose 后不能再建连接');
  console.log('  PASS dispose 之后不再重连');
  pass += 1;
}

// ⑤ 陈旧 socket 的 close 不能影响新连接（不能把新连接上的等待动作全 reject）
{
  const rec = [];
  const c = new OneBotWsClient({ url: 'ws://127.0.0.1:3001', accessToken: 'tok' });
  c.on('close', (i) => rec.push(i));
  await c._openOnce();
  const stale = c._ws;
  const staleOnClose = stale.onclose;              // 先留一份原始回调（模拟"回调还是来了"）
  c._forceReconnect('stale test');                 // 正常路径：回调已被摘掉
  await sleep(2200);
  const fresh = c._ws;
  assert.notEqual(fresh, stale, '应已换上新连接');
  const n = rec.length;
  staleOnClose?.({ code: 1006, reason: '' });      // 万一下层还是回调了：必须被"陈旧 socket"这道闸挡掉
  assert.equal(rec.length, n, '陈旧 socket 的 close 不得再触发 close 事件');
  assert.equal(c._ws, fresh, '陈旧 socket 的 close 不得把新连接顶掉');
  c.dispose();
  console.log('  PASS 陈旧 socket 的 close 被忽略（不会误伤新连接）');
  pass += 1;
}

// ⑥ 【2026-09-16 强化 NapCat 连接】主动探活：安静一段时间就 get_status，没回就立刻判死重建
{
  class SilentWS extends FakeWS {
    send(data) { SilentWS.sent.push(String(data)); /* 故意什么都不回：模拟"链路还在、NapCat 侧已经不响应"的假死 */ }
  }
  SilentWS.sent = [];
  const prevWS = globalThis.WebSocket;
  globalThis.WebSocket = SilentWS;
  const before = SilentWS.instances.length;
  const c = new OneBotWsClient({
    url: 'ws://127.0.0.1:3001', accessToken: 'tok',
    heartbeatProbeMs: 300, heartbeatWatchdogMs: 60000, heartbeatProbeTimeoutMs: 700, heartbeatTickMs: 150,
  });
  await c._openOnce();
  const opened = c._ws;
  assert.ok(opened, '先连上一条');
  await sleep(3000);                       // 300ms 静默 → 探活 → 700ms 超时 → 判死重连
  const probes = SilentWS.sent.filter((s) => s.includes('get_status')).length;
  assert.ok(probes >= 1, `应发出过 get_status 探活（实际 ${probes}）`);
  assert.notEqual(c._ws, opened, '探活失败后必须换连接（立刻判死重建，不等看门狗）');
  assert.ok(SilentWS.instances.length >= before + 2, '应当已经新建了连接');
  c.dispose();
  globalThis.WebSocket = prevWS;
  console.log(`  PASS 探活：${probes} 次 get_status 无响应 → 立刻判死重建`);
  pass += 1;
}

// ⑦ stats()：诊断快照（管理端卡片就靠它）
{
  const c = new OneBotWsClient({ url: 'ws://127.0.0.1:3001', accessToken: 'tok' });
  await c._openOnce();
  const st = c.stats();
  assert.equal(typeof st.connected, 'boolean');
  assert.equal(st.everOpened, true);
  assert.equal(typeof st.reconnects, 'number');
  assert.equal(st.url, 'ws://127.0.0.1:3001');
  c.dispose();
  console.log('  PASS stats() 提供连接诊断（connected / lastActivityAgoMs / reconnects）');
  pass += 1;
}

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 占用忽略 */ }
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
