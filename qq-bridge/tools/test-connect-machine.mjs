// 连接状态机 + "服务端组件好了没有"判定的回归（2026-09-22 主人要求：
// "连接上服务器之后直接退出，下次打开自动连接服务器，这个过程希望能带上「服务端启动中」状态机"）。
//
// 纯逻辑测试：喂样例 remoteStatus（与 getRemoteServerStatus 的真实形状一致）与状态机钩子，
// 断言界面读到的阶段/文案/组件明细。
//   node tools/test-connect-machine.mjs
import { createConnectMachine, describeRemoteStatus, PHASES } from '../../server/connect-machine.js';

let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`); } else { console.log(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
};

/** 真实形状的样例（字段名照抄服务器上 /api/state 的 remoteStatus）。 */
const sample = (over = {}) => ({
  ok: true, connected: true, at: Date.now(),
  server: { id: 'srv1', name: '我的服务器', host: '202.61.72.79' },
  remotePorts: { dsh: 3080, napcat: 6099, napcatHttp: 3000, bridge: 3100 },
  ports: { 3000: true, 3001: true, 3080: true, 3100: true, 6099: true },
  dsh: { unit: 'dsh-web', active: 'active', enabled: 'enabled', running: true, port: 3080, portUp: true, hasToken: true },
  napcat: { container: 'napcat', status: 'Up', running: true, exited: false, ports: { 3000: true, 3001: true, 6099: true }, webuiToken: '061228', hasWebuiToken: true },
  bridge: { running: true, pids: [981889], cmd: 'node src/bridge.js', port: 3100, portUp: true, dir: '/root/qq-bridge', consoleToken: '' },
  ...over,
});

console.log('== ① 组件判定（describeRemoteStatus） ==');
{
  const all = describeRemoteStatus(sample());
  ok('三件套都在 → ready', all.ready === true && all.down === false, JSON.stringify(all.components.map((c) => c.state)));
  ok('文案是"服务端已就绪"', all.note === '服务端已就绪', all.note);

  const dshBooting = describeRemoteStatus(sample({ dsh: { running: true, port: 3080, portUp: false } }));
  ok('DSH 进程在但端口没听 → starting', dshBooting.ready === false && dshBooting.components.find((c) => c.id === 'dsh').state === 'starting');
  ok('文案点名是 DSH 在起', /服务端启动中/.test(dshBooting.note) && /DSH启动中/.test(dshBooting.note.replace(/\s/g, '')), dshBooting.note);

  const napDown = describeRemoteStatus(sample({ napcat: { running: false, status: 'down', ports: {} } }));
  ok('NapCat 没跑 → down，且整体不是 ready', napDown.components.find((c) => c.id === 'napcat').state === 'down' && !napDown.ready);

  const allDown = describeRemoteStatus(sample({ dsh: { running: false }, napcat: { running: false, ports: {} }, bridge: { running: false, pids: [], portUp: false } }));
  ok('三件套都没跑 → down（界面提示"点一键启动整套"）', allDown.down === true && /一键启动整套/.test(allDown.note), allDown.note);

  const noStatus = describeRemoteStatus(null);
  ok('状态取不到时不假装"就绪"，也不假装"没跑"', noStatus.ready === false && noStatus.down === false, JSON.stringify(noStatus));
  const napPortShut = describeRemoteStatus(sample({ napcat: { running: true, ports: { 3000: true, 3001: true, 6099: false } } }));
  ok('NapCat 进程在、界面端口没通 → starting（组件自己的 ports 优先）', napPortShut.components.find((c) => c.id === 'napcat').state === 'starting', JSON.stringify(napPortShut.components));
}

console.log('== ② 状态机的阶段推进 ==');
{
  let t = 1_700_000_000_000;
  const logs = [];
  const m = createConnectMachine({ now: () => t, log: (s) => logs.push(s) });
  ok('初始是 idle', m.view().phase === 'idle', m.view().phase);

  m.begin({ id: 'srv1', name: '我的服务器' }, 'startup');
  ok('begin → connecting 且带上服务器名', m.view().phase === 'connecting' && m.view().serverName === '我的服务器', JSON.stringify(m.view()));
  ok('attempts 从 1 开始', m.view().attempts === 1, String(m.view().attempts));

  t += 3000;
  m.tunnels([{ name: 'NapCat WebUI', ok: true }, { name: 'DSH Web', ok: true }, { name: 'Bridge 控制台', ok: false }], 'startup');
  ok('tunnels → 写清几条成功', m.view().phase === 'tunnels' && /2\/3/.test(m.view().note), m.view().note);

  t += 3000;
  m.remote(sample({ dsh: { running: true, port: 3080, portUp: false } }), 'startup');
  ok('服务端没全就绪 → server-starting + 组件明细', m.view().phase === 'server-starting' && m.view().components.length === 3, JSON.stringify(m.view().components.map((c) => `${c.name}:${c.state}`)));
  ok('文案就是"服务端启动中"', /^服务端启动中/.test(m.view().note), m.view().note);

  t += 3000;
  m.remote(sample(), 'startup');
  ok('全就绪 → warming（去静默鉴权）', m.view().phase === 'warming', m.view().phase);

  t += 1000;
  m.warmed({ ok: true, note: '令牌验证通过' }, 'startup');
  ok('warmed → ready', m.view().phase === 'ready', m.view().phase);
  ok('warm.done = true（界面据此不再重载）', m.view().warm.done === true, JSON.stringify(m.view().warm));
  ok('文案说"不会再重复鉴权"', /不会再重复鉴权/.test(m.view().note), m.view().note);
  /* elapsedMs 是"卡在**当前阶段**多久了"（阶段变了才归零，只改文案不归零）——界面用它显示"已用时 Ns"。 */
  t += 12000;
  ok('elapsedMs 是当前阶段的停留时长', m.view().elapsedMs === 12000, String(m.view().elapsedMs));
  t += 1000;
  m.ready('同阶段的文案更新');
  ok('同阶段只改文案：计时不清零（"卡在这一步多久"才有意义）', m.view().elapsedMs === 13000, String(m.view().elapsedMs));

  t += 5000;
  m.begin({ id: 'srv1', name: '我的服务器' }, 'reconnect');
  ok('同一台再连一次 → attempts 累加', m.view().attempts === 2, String(m.view().attempts));
  ok('新的一轮把 warm 标记清掉', m.view().warm.done === false, JSON.stringify(m.view().warm));

  m.fail(new Error('All configured authentication methods failed'), 'reconnect');
  ok('失败 → failed + 人话原因', m.view().phase === 'failed' && /连接失败：/.test(m.view().note), m.view().note);
  ok('lastError 保留原文供排查', /authentication methods failed/.test(m.view().lastError), m.view().lastError);
  ok('阶段序列合法（PHASES 里都有）', PHASES.includes('server-starting') && PHASES.includes('warming'), PHASES.join(','));

  ok('每次阶段变化都写了日志（现场可查）', logs.length >= 6, String(logs.length));
}

console.log('== ③ 界面上"服务端启动中"这一步必须能看见组件名字 ==');
{
  const m = createConnectMachine({ now: () => 1 });
  m.begin({ id: 's', name: 'S' });
  m.remote(sample({ napcat: { running: true, ports: { 6099: false } }, bridge: { running: false, pids: [] } }));
  const v = m.view();
  ok('napcat 报"启动中"、桥报"未运行"', v.components.find((c) => c.id === 'napcat').state === 'starting' && v.components.find((c) => c.id === 'bridge').state === 'down');
  ok('文案把两个都点名', /NapCat/.test(v.note) && /桥/.test(v.note), v.note);
}

console.log(`\nALL PASS  pass=${pass} fail=${process.exitCode ? 1 : 0}`);
