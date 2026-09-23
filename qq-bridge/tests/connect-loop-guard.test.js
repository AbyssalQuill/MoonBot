// 【2026-09-23 主人报「管理端卡片在本机断网之后重连服务器的时候反复循环状态机」】
//
// 现象：本机断网 → 服务器连接掉 → 网络恢复后，管理端首页卡片的状态机在
//       connecting → tunnels → server-starting → (failed) 之间反复空转，停不下来。
//
// 根因（读 server/index.js 得到的确定链条，不是猜）：
//   ① establishConnection() 在换连接时会对**旧连接**调 end()：
//        if (sshConnections.has(id)) { sshConnections.get(id).end(); sshConnections.delete(id); … }
//      而 end() 会让旧连接异步抛 'close'。
//   ② 'close' 处理器里那条"是不是已被新连接取代"的判据是：
//        if (sshConnections.get(id) !== conn && sshConnections.has(id)) return;
//      旧连接触发 close 时，sshdConnections 里这台**刚被 delete 掉** →
//      get() 是 undefined（!== conn 成立，但）has() 是 false（第二个条件不成立）
//      → 两个条件同时成立才 return，这里不成立 → **被当成真掉线** → scheduleReconnect()。
//   ③ 于是：排重连 → 5s 后 connectStep → 在 establishConnection 里又 end() 一个连接
//      → 又抛 close → 又排重连 …… 状态机永远在走这几步，界面看着就是"反复循环"。
//
//   ④ 另外 waitServerReady() 在"三件套都没在跑"（d.down）时 break 出来直接 fail()，
//      之后**没有任何人再推进状态机**；而重连定时器还在按退避触发，同样表现为循环。
//
// 本测试锁住这两条修法的关键契约（纯源码断言 + 行为断言，不联网、不起进程）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`); } else { console.log(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
};

const SERVER = path.join(process.cwd(), '..', 'server', 'index.js');
const src = fs.readFileSync(SERVER, 'utf8');
/* 状态机模块在仓库根的 server/ 下（不是 qq-bridge/src），用 pathToFileURL 从 cwd 解析，
 * 不依赖测试文件自身的相对位置 —— 后者在 Windows 上容易因反斜杠/空格路径解析失败。 */
const CONNECT_MACHINE = pathToFileURL(path.join(process.cwd(), '..', 'server', 'connect-machine.js')).href;

console.log('== ① 主动替换旧连接时，必须打标记让旧连接的 close 被忽略 ==');
ok('声明了 replacingConnections 集合', /const replacingConnections = new Set\(\)/.test(src));
ok('establishConnection 换连接前先 add 标记', /replacingConnections\.add\(server\.id\)/.test(src));
ok('换完连接后摘掉标记（异步摘，避免同 tick 就清掉）',
  /setTimeout\(\(\) => \{ replacingConnections\.delete\(server\.id\); \}, 0\)/.test(src));
ok("close 处理器里认这个标记并直接 return",
  /if \(replacingConnections\.has\(server\.id\)\) return;/.test(src));

console.log('\n== ② 标记必须在 replace 那一刻就生效（同一段里 add 早于 delete/end）==');
{
  // 关键顺序：add 必须在 sshConnections.delete() 与 .end() **之前**，
  // 否则旧连接的 close 回调跑起来时标记还没打上，照样会误判成掉线。
  const addIdx = src.indexOf('replacingConnections.add(server.id)');
  const delIdx = src.indexOf('sshConnections.delete(server.id)', addIdx - 400);
  const endIdx = src.indexOf('.end();', addIdx - 400);
  ok('add 先于 sshConnections.delete', addIdx > 0 && delIdx > 0 && addIdx < delIdx,
    `add@${addIdx} delete@${delIdx}`);
  ok('add 先于 旧连接.end()', addIdx > 0 && endIdx > 0 && addIdx < endIdx,
    `add@${addIdx} end@${endIdx}`);
}

console.log('\n== ③ waitServerReady 失败后要自己安排重连，不能死等（死等=假循环）==');
{
  const failIdx = src.indexOf("connectMachine.fail(new Error('服务端组件到点还没就绪");
  const schedIdx = src.indexOf("scheduleReconnect(server.id, 'server-not-ready')");
  ok('fail 之后调用了 scheduleReconnect', failIdx > 0 && schedIdx > failIdx);
  ok('排重连前先判重（reconnectTimers 有本机就不重复排）',
    /if \(!reconnectTimers\.has\(server\.id\) && !manualDisconnects\.has\(server\.id\)\)/.test(src));
  ok('用户主动断开的机器不自动重连（manualDisconnects 仍被尊重）',
    /!manualDisconnects\.has\(server\.id\)/.test(src));
}

console.log('\n== ④ 行为断言：状态机在"服务端没起"时不应被误报成掉线 ==');
{
  const { createConnectMachine } = await import(CONNECT_MACHINE);
  const m = createConnectMachine({ log: () => {} });
  m.begin({ id: 's1', name: 'myserver' }, 'connection-closed');
  ok('begin → connecting', m.get().phase === 'connecting');
  m.tunnels([{ ok: true }, { ok: true }], 'reconnect');
  ok('tunnels → tunnels', m.get().phase === 'tunnels');
  m.remote({ ok: true, dsh: { running: false }, napcat: { running: false }, bridge: { running: false } }, 'reconnect');
  ok('三件套都没跑 → server-starting（不是 failed，也不是 ready）',
    m.get().phase === 'server-starting', m.get().phase);
  ok('文案点名"整套都没在运行"（界面据此提示一键启动，而不是假装在连）',
    /整套都没在运行/.test(m.get().note), m.get().note);
  m.fail(new Error('服务端组件到点还没就绪'), 'server-not-ready');
  ok('确实失败时如实进 failed（不掩盖）', m.get().phase === 'failed');
  ok('lastError 保留原文供排查', /服务端组件到点还没就绪/.test(m.get().lastError));
}

console.log('\n== ⑤ 状态机阶段序列合法（回归护栏）==');
{
  const { PHASES } = await import(CONNECT_MACHINE);
  for (const p of ['idle', 'connecting', 'tunnels', 'server-starting', 'warming', 'ready', 'failed']) {
    ok(`PHASES 含 ${p}`, PHASES.includes(p));
  }
}

console.log(`\n${process.exitCode ? 'FAILED' : 'ALL PASS'}  pass=${pass}`);
