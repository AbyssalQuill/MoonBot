/**
 * 连接服务端的**状态机**（纯逻辑，可单测）。
 *
 * 主人要求（2026-09-22）："我们连接上服务器之后，直接退出，下次打开自动连接服务器，这个过程希望能带上
 * 「服务端启动中」状态机。" —— 打开应用那一下最难受的不是慢，而是**看不出它在干什么**：SSH 连上没有？
 * 隧道几条？服务端那三个组件（DSH / NapCat / 桥）谁是好的、谁还在起？以前只在界面上写"服务端重连中…"，
 * 于是"服务端在起"和"凭据错了永远起不来"看起来一模一样。
 *
 * 所以这里把连接过程拆成能显示的阶段：
 *   idle → connecting（SSH）→ tunnels（隧道 x/y）→ server-starting（服务端组件逐个就绪）
 *        → warming（静默预鉴权 NapCat 界面，一次性）→ ready
 *   任何一步失败 → failed（带人话原因），并按退避重试。
 *
 * 本模块只做**状态与文案**：不联网、不起进程。推进由 server/index.js 的驱动函数负责，
 * 判定"服务端组件好了没有"用的就是既有的 getRemoteServerStatus 结果（纯函数 describeRemoteStatus）。
 */

/** 阶段枚举（界面按这个顺序显示进度）。 */
export const PHASES = ['idle', 'connecting', 'tunnels', 'server-starting', 'warming', 'ready', 'failed'];

/** 某个端口通不通。优先看**组件自己报的** ports（NapCat 那份），再退回顶层聚合表；两处都没有 → null（不判定）。 */
function portUpFor(remote, port, componentId = '') {
  const own = componentId ? remote?.[componentId]?.ports : null;
  const fromOwn = own ? own[String(port)] : undefined;
  if (fromOwn !== undefined && fromOwn !== null) return fromOwn === true;
  const ports = remote?.ports ?? {};
  const v = ports[String(port)];
  return v === undefined || v === null ? null : v === true;
}

/**
 * 把 getRemoteServerStatus 的结果翻译成"三个组件各自什么状态"。**纯函数**（单测直接喂样例对象）。
 * @returns {{ready:boolean, down:boolean, starting:boolean, components:Array<{id:string,name:string,state:'ready'|'starting'|'down',detail:string}>, note:string}}
 */
export function describeRemoteStatus(remote, opts = {}) {
  // 端口以服务端自报的为准（每台机器可能不一样），拿不到才用调用方给的默认值
  const napcatPort = Number(remote?.remotePorts?.napcat) || Number(opts.napcatWebuiPort) || 6099;
  if (!remote || remote.ok === false) {
    return { ready: false, down: false, starting: false, components: [], note: '服务端状态还没取到' };
  }
  const dshUp = remote.dsh?.running === true;
  const dshPort = remote.dsh?.portUp !== false;                 // 老版本没有 portUp 字段时不误判
  const napRunning = remote.napcat?.running === true;
  const brUp = remote.bridge?.running === true;
  const brPort = remote.bridge?.portUp !== false;
  const components = [
    {
      id: 'dsh', name: 'DSH',
      state: dshUp ? (dshPort ? 'ready' : 'starting') : 'down',
      detail: dshUp ? (dshPort ? `已就绪（端口 ${remote.dsh?.port ?? '?'} 在听）` : `进程在，端口 ${remote.dsh?.port ?? '?'} 还没听`) : '没在运行',
    },
    {
      id: 'napcat', name: 'NapCat',
      state: napRunning ? (portUpFor(remote, napcatPort, 'napcat') === false ? 'starting' : 'ready') : 'down',
      detail: napRunning ? (portUpFor(remote, napcatPort, 'napcat') === false ? '进程在，界面端口还没通' : '已就绪') : '没在运行',
    },
    {
      id: 'bridge', name: '桥',
      state: brUp ? (brPort ? 'ready' : 'starting') : 'down',
      detail: brUp ? (brPort ? `已就绪（${remote.bridge?.pids?.length ?? 0} 个进程）` : '进程在，控制台端口还没通') : '没在运行',
    },
  ];
  const ready = components.every((c) => c.state === 'ready');
  const down = components.every((c) => c.state === 'down');
  const starting = !ready && !down;
  const bad = components.filter((c) => c.state !== 'ready');
  const note = ready
    ? '服务端已就绪'
    : (starting
      ? '服务端启动中：' + bad.map((c) => `${c.name}${c.state === 'starting' ? '启动中' : '未运行'}`).join(' · ')
      : '服务端整套都没在运行（点「一键启动整套」）');
  return { ready, down, starting, components, note };
}

/**
 * 连接状态机。`set()` 只在阶段/文案真的变了时才更新时间戳，方便界面做"卡在这一步多久了"的显示。
 * @param {{now?:() => number, log?: (msg: string) => void}} [opts]
 */
export function createConnectMachine(opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  let state = {
    phase: 'idle',
    note: '未连接',
    serverId: '', serverName: '',
    components: [],
    attempts: 0,
    lastError: '',
    since: now(),
    updatedAt: now(),
    warm: { done: false, at: 0, note: '' },
  };

  function snapshot() { return { ...state, components: state.components.map((c) => ({ ...c })), warm: { ...state.warm }, now: now() }; }

  /** 更新状态；同阶段只改文案时不动 since（界面上的"已用时"才有意义）。 */
  function set(patch = {}, reason = '') {
    const next = { ...state, ...patch };
    if (next.phase !== state.phase) next.since = now();
    next.updatedAt = now();
    const changed = next.phase !== state.phase || next.note !== state.note || next.lastError !== state.lastError;
    state = next;
    if (changed) log(`[connect] ${state.phase}${state.serverName ? ' · ' + state.serverName : ''} — ${state.note}${reason ? '（' + reason + '）' : ''}`);
    return snapshot();
  }

  return {
    /** 开始连接（用户点「连接」或开机自动连接）。 */
    begin(server, reason = '') {
      state.attempts = state.serverId === (server?.id ?? '') ? state.attempts + 1 : 1;
      return set({ serverId: server?.id ?? '', serverName: server?.name || server?.host || '', phase: 'connecting', note: '正在连接服务器…', components: [], lastError: '', warm: { done: false, at: 0, note: '' } }, reason);
    },
    /** SSH 已建立、隧道建立结果回来了。 */
    tunnels(created = [], reason = '') {
      const okCount = (created || []).filter((x) => x?.ok).length;
      const total = (created || []).length;
      return set({ phase: 'tunnels', note: total ? `隧道已建立 ${okCount}/${total} 条` : '隧道已就绪' }, reason);
    },
    /** 服务端组件状态（每次轮询都调，文案跟着变）。 */
    remote(remote, reason = '') {
      const d = describeRemoteStatus(remote, { napcatWebuiPort: opts.napcatWebuiPort });
      if (d.ready) return set({ phase: 'warming', note: '服务端已就绪，正在静默完成 NapCat 界面鉴权…', components: d.components }, reason);
      return set({ phase: 'server-starting', note: d.note, components: d.components }, reason);
    },
    /** 静默预鉴权结果（一次性；成功/限流/失败都如实记）。 */
    warmed(result, reason = '') {
      const note = result?.ok ? 'NapCat 界面鉴权已静默完成（点开即用，不会再重复鉴权）' : `NapCat 界面预鉴权没成功：${result?.note ?? '未知原因'}`;
      return set({ phase: 'ready', note, warm: { done: result?.ok === true, at: now(), note: result?.note ?? '' } }, reason);
    },
    /** 就绪（本地这套或服务端那套都走这里收尾）。 */
    ready(note = '已就绪', reason = '') { return set({ phase: 'ready', note }, reason); },
    /** 失败：人话原因 + 交给调用方安排重试。 */
    fail(err, reason = '') {
      const msg = String(err?.message ?? err ?? '未知错误');
      return set({ phase: 'failed', note: '连接失败：' + msg, lastError: msg }, reason);
    },
    idle(note = '未连接', reason = '') { return set({ phase: 'idle', note, components: [] }, reason); },
    get: snapshot,
    /** 给界面用的轻量视图（不含 now/updatedAt 之外的东西，字段名稳定）。 */
    view() {
      const s = snapshot();
      return {
        phase: s.phase, note: s.note, serverId: s.serverId, serverName: s.serverName,
        components: s.components, attempts: s.attempts, lastError: s.lastError,
        since: s.since, updatedAt: s.updatedAt, elapsedMs: Math.max(0, s.now - s.since), warm: s.warm,
      };
    },
  };
}
