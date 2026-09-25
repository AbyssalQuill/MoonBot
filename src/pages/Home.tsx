import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { instanceAction, startAllInstances, remoteStackById, sshServiceAction } from '../api';
import { pendingConnect, activeScopeInfo } from '../config-cache';
import type { ManagerState, LocalInstance } from '../stores/types';
import { Settings, Loader2, Rocket, BookOpen, X, RotateCw, Square, AlertTriangle } from 'lucide-react';

interface HomeProps {
  state: ManagerState | null;
  onOpenSSH: () => void;
  onOpenConfig: (id: 'dsh-isolated' | 'napcat-local' | 'bridge-local') => void;
  onOpenWeb: (url: string, title: string) => void;  // 应用内打开官方界面（同一页面内）
  onRefresh: () => void;
}

type Phase = 'idle' | 'starting' | 'running' | 'stopping' | 'failed';

/** 按钮与状态完全由服务端的 phase 驱动（服务端以真实探活推进，不再依据"本地曾 spawn 过"推断）。
 *  此处仅作一步兜底：服务端返回 running、但进程与端口均已消失（例如被任务管理器结束）时，
 *  不再显示"运行中"以误导用户点击「打开」。 */
function phaseOf(inst?: LocalInstance): Phase {
  if (!inst) return 'idle';
  const p = (inst.phase as Phase) || 'idle';
  if (p === 'running' && !inst.reachable && !inst.proc.running) return 'idle';
  return p;
}

const PHASE_TEXT: Record<Phase, string> = {
  idle: '未启动',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  failed: '启动失败',
};

/** 状态小字：说明当前处于何种等待（等待扫码 / 等待就绪 / 失败原因） */
function footText(inst: LocalInstance | undefined, phase: Phase): string {
  if (!inst) return PHASE_TEXT[phase];
  if (phase === 'starting') {
    const s = Math.max(0, Math.round((inst.elapsedMs || 0) / 1000));
    return `启动中 ${s}s${inst.note ? ' · ' + inst.note : ' · 等待就绪'}`;
  }
  if (phase === 'stopping') return '停止中…';
  if (phase === 'failed') return `启动失败：${(inst.error || '见日志').slice(0, 60)}`;
  if (phase === 'running') {
    if (inst.kind === 'napcat' && !inst.loggedIn) return '已启动 · 等待 QQ 扫码登录';
    return inst.kind === 'bridge' ? '运行中' : '运行中 · 点击打开';
  }
  return '未启动';
}

function dotClass(phase: Phase): string {
  if (phase === 'running') return 'online';
  if (phase === 'starting' || phase === 'stopping') return 'loading';
  return 'offline';
}

/* 2026-09-23：连接服务器的状态机改在卡片下方那行小字中显示。
 * 原实现中，连接期间卡片小字由「未启动」直接跳至「运行中」，其间数秒（连 SSH → 建隧道 →
 * 拉取服务端组件 → 界面鉴权）没有任何反馈，观感等同于卡死；而承担该反馈的横幅位于页面顶部，
 * 已按要求移除。阶段定义见 server/index.js 的 connectMachine。 */
const CONNECT_FOOT: Record<string, string> = {
  connecting: '服务端连接中 · 正在连接服务器',
  tunnels: '服务端连接中 · 建立隧道',
  'server-starting': '服务端连接中 · 服务端组件启动中',
  warming: '服务端连接中 · 界面鉴权',
  failed: '服务端连接失败（会自动重试）',
};

/** 一键启动整套时"哪一步失败归到哪张卡"：本机接口返回实例 id（napcat-local / dsh-isolated /
 *  bridge-local），服务端接口返回中文步骤名（'启动 DSH (dsh-web)' / '启动 NapCat' / '启动 QQ 桥'…），
 *  按关键字认领；无法识别的（如 '连接服务器'）归入 '*'，三张卡的小字均显示该条。 */
function stepOwner(key: string): string {
  const s = String(key || '').toLowerCase();
  if (s.includes('bridge') || s.includes('桥')) return 'bridge-local';
  if (s.includes('napcat')) return 'napcat-local';
  if (s.includes('dsh')) return 'dsh-isolated';
  return '*';
}

/* 2026-09-28：首页大标题明确不使用中文，改为英文短句（原创，未引用任何
 *  已有作品 / 歌词 / 名言）。主题是「虚拟角色也能成为真正的朋友」。
 *  —— Made a character, kept a friend.（32 字符）
 *  中文释义（仅供人阅读，代码注释用，不显示在页面上）：做出来的是角色，留下来的是朋友。
 *  长度说明：42px 单行 nowrap 显示，≤34 字符可保证不换行、不产生横向滚动。*/
const SLOGAN = 'Made a character, kept a friend.';

/** 打字机循环：逐字显示 → 完整显示并停留 hold 毫秒 → 归零后重新逐字显示（空屏不停留） */
function useTypewriterLoop(text: string, speed = 110, holdMs = 3200) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const tick = (i: number) => {
      if (cancelled) return;
      setN(i);
      if (i >= text.length) {
        // 全句显示：停顿后从头开始（先归零并立即重启，不在空屏停留）
        timer = setTimeout(() => { if (!cancelled) { setN(0); tick(1); } }, holdMs);
      } else {
        timer = setTimeout(() => tick(i + 1), speed);
      }
    };
    timer = setTimeout(() => tick(1), 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [text, speed, holdMs]);
  return text.slice(0, n);
}

type SvcId = 'dsh-isolated' | 'napcat-local' | 'bridge-local';

export default function Home({ state, onOpenSSH, onOpenConfig, onOpenWeb, onRefresh }: HomeProps) {
  const [busy, setBusy] = useState<SvcId | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [allBusy, setAllBusy] = useState(false);
  /* 2026-09-27首页原先每项动作都会向顶部 NoticeBar 写入一句「启动成功 / 启动失败…」，
   * 该提示出现时会把标题与按钮整体下压。现不再弹出任何提示条 / toast / 浮层：
   * 动作与整套启动的失败原因直接并入对应卡片下方那行小字（big-foot），成功不留任何字样 ——
   * 状态完全由服务端 phase 推进的那行小字承担。键 = 实例 id（见 SvcId）；'*' 为整套级别，三张卡均显示。 */
  const [footErr, setFootErr] = useState<Record<string, string>>({});
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const typed = useTypewriterLoop(SLOGAN);

  const inst = (id: SvcId) => state?.instances.find((i) => i.id === id);

  /* 2026-09-17 单点登录互斥 L3state 尚未返回的一两秒内 serverMode 为 false，卡片语义会退回"本机"，
   * 此时点「启动」拉起的是本机 NapCat；状态到达后再点一次又去拉服务端，同一 QQ 号在两处登录会被互踢。
   * 因此取得第一份 state 之前，所有动作按钮一律禁用（宁可多等待，也不产生第二个登录）。 */
  const stateReady = !!state;

/** 统一动作入口：启动 / 停止 / 重启均经此函数；按钮 busy 仅覆盖请求期间， */
/**  其后的状态由服务端 phase 接管（App 每 1.2~3 秒轮询），故"启动中"会持续显示到真正就绪。 */
/**  2026-09-27不再弹出「启动成功 / 失败」提示条：下发成功不留字样（状态交由 phase）， */
/**  仅在下发本身失败时将原因写入该卡片的小字。 */
  const doAction = async (id: SvcId, action: 'start' | 'stop' | 'restart') => {
    const label = action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启';
    setBusy(id); setActing(`${id}:${action}`); setFootErr({});
    try {
      const r = await instanceAction(id, action);
      if (r.success === false) setFootErr({ [id]: `${label}未成功：${(r.message || '见日志').slice(0, 80)}` });
    } catch { setFootErr({ [id]: `${label}失败：无法连接后端` }); }
    finally { setBusy(null); setActing(null); onRefresh(); }
  };

  const act = (id: SvcId) => doAction(id, 'start');
  const actStop = (id: SvcId) => doAction(id, 'stop');
  const actRestart = (id: SvcId) => doAction(id, 'restart');

  /* 2026-09-14连上服务器后，这三张卡即代表服务器那套：
   *   · 状态取自服务端（"服务端运行中 / 未运行"）；
   *   · 按钮直接操作服务端（systemctl / docker / 桥进程），不再启动本机进程；
   *   · 「打开」打开的是服务端界面（经隧道），而非本机那一份。
   *  未连接服务器时，一切保持原样（本机实例）。 */
  /* 2026-09-15 修「按钮仍操作本机 / NapCat 无法重启」
   * 原实现 `isRemote = remoteUp !== null && !!remoteId`：只要"服务端状态未取到"（断线的数秒内，
   * 或某个组件字段缺失），remoteUp 即为 null，三张卡会静默切回本机语义：
   * 显示本机那几个空闲实例的状态（表现为"只剩启动、没有重启/停止"），
   * 点「启动」拉起的是本机 NapCat / DSH / 桥（2026-09-14 已明确排除该行为）。
   * 现改为：只要存在活动服务器即按服务端语义显示；未连上时按钮提示"正在重连"，绝不误操作本机。 */
  /* 2026-09-24 主人要求："连接上服务器就读服务器，连接上本机就读本机"。
   * 首帧（/api/state 还没回来）同样按这条规则走：用缓存里的"上次连接事实"
   * （`activeScopeInfo().scope`，形如 `remote:<id>` / `local`，由 config-cache 播种）先决定读哪一侧，
   * 不摆一个"待核实"的中间态。真实动作仍受 remoteId/sshConn 把关（未连上时点服务端按钮只会提示重连，
   * 绝不会误操作本机实例）。 */
  const bootRemote = !stateReady && activeScopeInfo().scope.startsWith('remote');
  const serverMode = !!state?.activeServer || bootRemote;
  const remoteId = state?.activeServer?.id ?? null;
  const remoteCompOf = (id: SvcId): 'dsh' | 'napcat' | 'bridge' =>
    (id === 'napcat-local' ? 'napcat' : id === 'dsh-isolated' ? 'dsh' : 'bridge');
  const remoteSvcIdOf = (id: SvcId): string =>
    (id === 'napcat-local' ? 'srv-napcat-webui' : id === 'dsh-isolated' ? 'srv-dsh-web' : 'srv-bridge');
  const remoteServiceOf = (id: SvcId) => (state?.services ?? []).find((s) => s.id === remoteSvcIdOf(id));

  const doRemoteAction = async (id: SvcId, action: 'start' | 'stop' | 'restart') => {
    if (!remoteId) return;
    const label = action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启';
    if (!sshConn) { setFootErr({ [id]: '服务端正在重连，请稍候数秒再操作（不会操作本机实例）' }); return; }
    setBusy(id); setActing(`${id}:${action}`); setFootErr({});
    try {
      const r = await sshServiceAction(remoteId, remoteCompOf(id), action);
      if (r.ok !== true) setFootErr({ [id]: `${label}服务端未成功：${(r.message || '见日志').slice(0, 80)}` });
    } catch { setFootErr({ [id]: `${label}服务端失败：无法连接后端` }); }
    finally { setBusy(null); setActing(null); onRefresh(); }
  };

/** 一键启动整套：已连接服务器时走服务端整套（DSH → NapCat → 桥），否则仍为本机那套。 */
/**  2026-09-27结果不再弹出提示条：成功的每一步由各自卡片的 phase 小字反映； */
/**  失败的那一步按 id / 步骤名归入对应卡片的小字（无法识别的按 '*' 挂到三张卡上）。 */
  const actAll = async () => {
    setAllBusy(true); setFootErr({});
    try {
      if (remoteId && state?.activeServer) {
        const r = await remoteStackById(remoteId, 'start');
        const bad = (r.steps ?? []).filter((s) => !s.ok);
        if (r.success !== true || bad.length) {
          const list = bad.length ? bad : [{ step: '', msg: r.message || '' }];
          const next: Record<string, string> = {};
          for (const s of list) {
            next[stepOwner(s.step)] = `整套启动未完成：${s.step ? s.step + ' · ' : ''}${String(s.msg || r.message || '见日志').split('\n')[0].slice(0, 80)}`;
          }
          setFootErr(next);
        }
        return;
      }
      const r = await startAllInstances();
      if (r.success === false) {
        const bad = (r.steps ?? []).filter((s) => s.success === false);
        const next: Record<string, string> = {};
        if (bad.length) for (const s of bad) next[stepOwner(s.id)] = `启动失败：${(s.error || s.message || '见日志').slice(0, 80)}`;
        else next['*'] = `整套启动未完成：${(r.message || '见日志').slice(0, 80)}`;
        setFootErr(next);
      }
    } catch { setFootErr({ '*': '一键启动失败：无法连接后端' }); }
    finally { setAllBusy(false); onRefresh(); }
  };

  const svcs: Array<{ id: SvcId; label: string; sub: string; openTitle: string }> = [
    { id: 'napcat-local', label: 'NapCat', sub: 'QQ 网关', openTitle: 'NapCat 官方界面' },
    { id: 'dsh-isolated', label: 'DeepSeek Harness', sub: '内置模型服务 · 独立端口', openTitle: 'DeepSeek Harness' },
    { id: 'bridge-local', label: 'Core', sub: '内置核心层', openTitle: '功能配置' },
  ];

  const sshConn = state?.connected;
/** 断线自动重连中（管理器会在数秒内自行恢复连接）—— 此时显示"服务端重连中…"，避免显示为"未运行" */
  const sshReconnecting = !!state?.reconnecting;

/** 服务端某组件的运行状态：已连接服务器且已取得远程状态时返回 boolean；否则返回 null
   *（null 表示仍按本机那份文案显示，界面不会出现空白）。 */
  const serverUpOf = (id: SvcId): boolean | null => {
    if (!sshConn) return null;
    const rs: any = (state as any)?.remoteStatus;
    const key: 'dsh' | 'napcat' | 'bridge' = remoteCompOf(id);
    /* 2026-10-01 修「服务端其实在跑，首页却写未运行」：remoteStatus 这一轮取不到（探测失败、
       缓存冷、刚重连）时原先直接返回 null，卡片便落回本机那份文案「服务端未运行」——
       把"没读到"说成了"没在跑"。现在两层兜底，且只有拿到明确结论才敢说未运行：
         ① remoteStatus.ok 且该组件字段在 → 用它；
         ② 否则看连接状态机里同一组件的就绪度（server/index.js 的 connectMachine：
            ready = 该组件已探测就绪，down = 明确不可用），ready 记运行、down 记未运行；
         ③ 两者都没有 → null，界面显示「正在读取服务端状态…」而不是下结论。 */
    if (rs && rs.ok !== false && rs[key]) return !!rs[key].running;
    const comp = ((state as any)?.connect?.components ?? []).find((c: any) => c?.id === key);
    if (comp?.state === 'ready') return true;
    if (comp?.state === 'down') return false;
    return null;
  };

  /* 2026-09-23连接状态机的中间态 → 卡片小字（见 CONNECT_FOOT 注释）。
   * 除 idle/ready 之外均属"连接进行中"，此时小字不再直接表述「未运行」，
   * 而是写出当前阶段，以避免"未启动 → 运行中"的突兀跳变。 */
  const connPhase = state?.connect?.phase ?? 'idle';
  /* 2026-09-24该窗口（`stateReady = !!state`，首次 /api/state 尚未返回）语义上就是"正在连接服务端"，
   * 故卡片小字写「正在连接…」而不是「加载中…」。
   * 2026-09-24 主人要求（原话）："不要有正在核实的状态机和不能点的卡片状态机，就是我们刚启动应用的时候"
   * —— 首帧（/api/state 尚未返回）不再禁用任何按钮：按钮上的转圈只出现在真正在飞的那个动作上
   * （`allBusy` / `busy === id`）。单点登录保护不靠置灰，由后端在真正拉起实例时把关并回报原因。 */
  const connectBusy = connPhase !== 'idle' && connPhase !== 'ready';
  const connectFailed = connPhase === 'failed';

  /* 2026-09-29：消除"未连接远程 / 桥不可达"的空窗。此前的反馈是：连服务器时仍会短暂出现
   * "不可达 / 未连接"这类结论性文案，而这些结论此刻其实还不成立 ——
   *   · 页面刚打开的那几百毫秒：`/api/state` 尚未返回，`state` 为 null，此前一律显示"未连接远程"；
   *   · 自启动连接刚起步：首帧 `connect.phase` 仍是 `idle`（后端此刻才开始连），此前同样显示"未连接"。
   * 现改为：只要缓存里有"上次连上过"的事实（`pendingConnect()`，判据与边界见
   * config-cache.ts 的同名注释），上述窗口里就直说「正在连接 X…」（2026-09-24 起不再用
   * "正在核实…"这种待核实口吻），而不写"未连接"；只有当确定成立时才照实说：状态机 `failed`、
   * 上次就没连上、或用户自己关掉了"启动时自动连接服务器"。
   * 与缓存无关的首次连接（从未取到过 /api/state）行为完全不变。 */
  const probe = pendingConnect(state);
  const connectFootText = CONNECT_FOOT[connPhase] || `服务端连接中 · ${connPhase}`;

  return (
    <div className="launcher">
      {/* 【2026-09-28】首页氛围背景层：缓慢漂移的极光光斑 + 极淡的点阵网格。
          纯装饰（aria-hidden，pointer-events:none），不参与任何交互与布局；
          颜色一律取自主题变量（--nc-primary-*），动画只作用于 transform / opacity。 */}
      <div className="launcher-bg" aria-hidden="true">
        <i className="launcher-aurora a1" />
        <i className="launcher-aurora a2" />
        <i className="launcher-aurora a3" />
      </div>

      {/* 【2026-09-27】此处原有一条 NoticeBar（启动 / 停止 / 重启与一键启动的提示条）。
          它一出现即把整页下压，且与卡片小字各说一套，已整条删除：失败原因改挂于卡片下方那行小字，
          成功不留字样。NoticeBar 组件本身未改动（他处仍在使用）。 */}

      {/* 【2026-09-12】Home 页标题悬停不弹出说明（已去掉原生 title 提示框） */}
      <div className="launcher-title">
        <div className="typewriter">{typed}</div>
        <div className="launcher-tag">MoonBot · 一键配置本地和服务器的拟人 QQ Bot</div>
      </div>

      {/* 新手教程：位于副标题下方、一键启动上方，居中窄按钮 */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
        <button className="btn btn-primary tutorial-btn" onClick={() => setTutorialOpen(true)} title="首次使用请先阅读本教程">
          <BookOpen size={14} style={{ verticalAlign: -2, marginRight: 6 }} /> 新手教程
        </button>
      </div>

      {/* 【2026-09-12】安装位置体检：安装于 Program Files / 同步盘时提前提示（记忆库写在安装目录内，
          这类位置会写入失败或产生同步冲突）——分发安装时最易遇到的两个问题。 */}
      {(state?.warnings?.length ?? 0) > 0 && (
        <div className="notice-bar" style={{ maxWidth: 720, margin: '0 auto 12px', textAlign: 'left' }}>
          {(state?.warnings ?? []).map((w, i) => <div key={i}>注意 {w}</div>)}
        </div>
      )}

      {/* 【2026-09-23】此处原有一条「正在连接服务器 / 服务端启动中」横幅（连接状态机）。
          已按要求删除：连接进度改为就地写入每张卡片下方那行小字（见 CONNECT_FOOT 与 big-foot），
          以免顶部横幅与卡片小字各说一套、相互矛盾。阶段明细与失败原因改挂于卡片的 title。 */}

      {/* 【2026-09-14】服务端那套为常驻服务（systemd / docker），连上即可使用，无须再次点启动；
          仅当服务端整套均未运行时提示一句，以免面对三张「服务端未运行」的卡片时无从下手。 */}
      {sshConn && (() => {
        const rs: any = (state as any)?.remoteStatus;
        if (!rs) return null;
        const ups = [rs.dsh?.running, rs.napcat?.running, rs.bridge?.running].filter((x) => x !== undefined);
        if (!ups.length || ups.some(Boolean)) return null;
        return (
          <div className="notice-bar" style={{ maxWidth: 720, margin: '0 auto 12px', textAlign: 'left' }}>
            注意 已连接服务器，但服务端整套尚未运行（DSH / NapCat / 桥）。可点下方「一键启动整套」，或在对应卡片上点「启动服务端」。
          </div>
        );
      })()}

      {/* 【2026-09-17 单点登录互斥】本机与服务端同时运行 NapCat —— 同一 QQ 号两处登录会被腾讯互踢，须显著提示 */}
      {(state as any)?.dualNapcat && (
        <div className="notice-bar" style={{ maxWidth: 720, margin: '0 auto 12px', textAlign: 'left', borderColor: '#e5484d', color: '#b42318', background: '#fff5f5' }}>
          注意 本机与服务端的 NapCat 均在运行。同一 QQ 号在两处登录会被腾讯判为「已在另一台终端登录」，双方相互踢下线。
          请仅保留一处：点上方「一键启动整套（服务端）」（管理器会先停止本机那份），或到服务端卡片点「停止」。
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
        <button className="btn btn-primary" style={{ padding: '8px 26px', fontSize: 15, borderRadius: 12 }} disabled={allBusy} onClick={actAll} data-genui-primary-action>
          {allBusy ? <Loader2 size={16} className="spin" style={{ verticalAlign: -2, marginRight: 8 }} /> : <Rocket size={16} style={{ verticalAlign: -2, marginRight: 8 }} />}
          {allBusy ? '正在一键启动整套…' : (sshConn ? '一键启动整套（服务端）' : '一键启动整套（NapCat → DSH → 桥）')}
        </button>
      </div>

      <div className="tiles grid2x2">
        {svcs.map((t) => {
          const i = inst(t.id);
          const remoteUp = sshConn ? serverUpOf(t.id) : null;
          const isRemote = serverMode;
          // 连上服务器时：状态取自服务端、按钮操作服务端、打开的是服务端界面；否则完全按本机原有逻辑。
          const phase: Phase = isRemote ? (remoteUp ? 'running' : 'idle') : phaseOf(i);
          const startAct = () => (isRemote ? doRemoteAction(t.id, 'start') : act(t.id));
          const stopAct = () => (isRemote ? doRemoteAction(t.id, 'stop') : actStop(t.id));
          const restartAct = () => (isRemote ? doRemoteAction(t.id, 'restart') : actRestart(t.id));
          // QQ-Bridge 的「打开」直接进入配置页（连上服务器时，该页读写的是服务端配置）
          const handleOpen = () => {
            if (t.id === 'bridge-local') { onOpenConfig('bridge-local'); return; }
            if (isRemote) {
              const svc = remoteServiceOf(t.id);            // 服务端 DSH / NapCat 界面（经隧道）
              if (svc?.url) onOpenWeb(svc.url, t.openTitle);
              return;
            }
            if (i?.url) onOpenWeb(i.url, t.openTitle);
          };
          // 2026-09-27动作 / 整套启动的失败原因（原在顶部提示条中弹出）挂到该行小字；
          // 无失败时此处为空，小字完全由服务端 phase 状态机决定。
          const footErrText = footErr[t.id] || footErr['*'] || '';
          return (
            <div className="big-tile" key={t.id}>
              <div className="big-tile-head">
                <span className="big-name">{t.label}</span>
                <span className="big-sub">{t.sub}</span>
              </div>
              <div className="big-actions">
                {phase === 'starting' ? (
                  <button className="btn btn-primary btn-block" disabled>
                    <Loader2 size={16} className="spin" /> 启动中…
                  </button>
                ) : phase === 'stopping' ? (
                  <button className="btn btn-primary btn-block" disabled>
                    <Loader2 size={16} className="spin" /> 停止中…
                  </button>
                ) : phase === 'running' ? (
                  <>
                    <button className="btn btn-primary btn-block" onClick={handleOpen}>打开</button>
                    <button
                      className="icon-btn"
                      title={isRemote ? '重启服务端' : '重启'}
                      disabled={busy === t.id}
                      onClick={restartAct}
                    >{acting === `${t.id}:restart` ? <Loader2 size={16} className="spin" /> : <RotateCw size={16} />}</button>
                    <button
                      className="icon-btn"
                      title={t.id === 'bridge-local' ? '终止' : '停止'}
                      disabled={busy === t.id}
                      onClick={stopAct}
                    >{acting === `${t.id}:stop` ? <Loader2 size={16} className="spin" /> : <Square size={15} />}</button>
                  </>
                ) : (
                  <button className="btn btn-primary btn-block" disabled={busy === t.id} onClick={startAct}>
                    {busy === t.id ? <><Loader2 size={16} className="spin" /> {isRemote ? '下发中…' : '启动中…'}</> : phase === 'failed' ? '重试启动' : (isRemote ? '启动服务端' : '启动')}
                  </button>
                )}
                <button className="icon-btn" title="配置" onClick={() => onOpenConfig(t.id)}><Settings size={17} /></button>
              </div>
              <div className="big-foot" title={footErrText || ((probe || connectBusy) ? (probe || state?.connect?.note || '') : (isRemote ? (state?.connect?.note || '') : (phase === 'failed' ? (i?.error || '') : (i?.note || ''))))}>
                {/* 【2026-09-23 关键顺序】中间态必须排在 isRemote 之前。
                    isRemote = !!state.activeServer，而 connecting / tunnels 这两个最早阶段 SSH 尚未连上，
                    后端此时不会下发 activeServer（resolveServices 中服务端那组仅在 sshConnections 存在该连接时才拼装）
                    → isRemote 仍为 false → 会落入本机那份文案并显示为「未启动」。
                    这正是"从未启动直接跳到运行中"的成因：前两段被本机文案顶替，
                    后两段又不足 1 秒，4 秒的轮询无法采样到。现只要连接状态机在运行即显示中间态。 */}
                {connectBusy
                  ? <><span className={`status-dot ${connectFailed ? 'offline' : 'loading'}`} />{connectFailed ? <AlertTriangle size={12} /> : null}<span>{connectFootText}</span></>
                  : probe
                    /* 2026-09-29缓存说"上次是连着的"，而本次状态尚未核实（phase 仍为 idle：
                       后端此刻才开始连）—— 此时说"未启动 / 未运行"都是武断结论，改用中性一行。 */
                    ? <><span className="status-dot loading" /><span>{probe}</span></>
                    : isRemote
                    ? (sshReconnecting
                      ? <><span className="status-dot loading" /><span>服务端重连中…</span></>
                      /* 服务端未运行 + 上一轮动作 / 整套启动失败 → 先说明是哪一次失败、原因何在 */
                      : (!remoteUp && footErrText
                        ? <><span className="status-dot offline" /><AlertTriangle size={12} /><span>{footErrText}</span></>
                        /* remoteUp === null：这一轮没拿到服务端状态（既非 running，也非明确的
                           down）。此前会写成「服务端未运行」——把"没读到"说成了"没在跑"。如实写"正在读取"。 */
                        : remoteUp === null
                          ? <><span className="status-dot loading" /><span>正在读取服务端状态…</span></>
                          : <><span className={`status-dot ${remoteUp ? 'online' : 'offline'}`} /><span>{remoteUp ? '服务端运行中' : '服务端未运行'}</span></>))
                    /* 本机：仅当状态机未给出结论（idle）时使用动作失败原因，不得覆盖 starting / failed 的真实阶段 */
                    : (footErrText && phase === 'idle'
                      ? <><span className="status-dot offline" /><AlertTriangle size={12} /><span>{footErrText}</span></>
                      : <><span className={`status-dot ${dotClass(phase)}`} /><span>{footText(i, phase)}</span></>)}
              </div>
            </div>
          );
        })}

        <div className="big-tile ssh-tile">
          <div className="big-tile-head">
            <span className="big-name">SSH 配置</span>
            <span className="big-sub">远程服务器 · 隧道</span>
          </div>
          <div className="big-actions">
            <button className="btn btn-soft btn-block" onClick={onOpenSSH}>进入</button>
          </div>
          <div className="big-foot">
            {/* 【2026-09-29】连接尚未核实时（缓存说上次是连着的）不再写"未连接远程"这一结论；
                断线自动重连期间也说"重连中"，与三张卡的小字口径一致。 */}
            <span className={`status-dot ${sshConn ? 'online' : (sshReconnecting || probe) ? 'loading' : 'offline'}`} />
            <span>{sshConn ? '远程已连接' : sshReconnecting ? '服务端重连中…' : (probe ?? '未连接远程')}</span>
          </div>
        </div>
      </div>

      <div className="launcher-footer">© 2026 AbyssalQuill · MoonBot · 一键配置本地与服务器的拟人 QQ Bot</div>

      {tutorialOpen && (
        <div className="help-overlay" style={{ zIndex: 120 }} onClick={() => setTutorialOpen(false)}>
          <div className="help-panel tutorial-panel" onClick={(e) => e.stopPropagation()}>
            <div className="help-head">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><BookOpen size={16} /> 新手教程 · 首次启动前</span>
              <button className="icon-btn" onClick={() => setTutorialOpen(false)}><X size={16} /></button>
            </div>
            <div className="tutorial-body">
              <TutorialSection title="① 启动前的两项准备">
                <ol>
                  <li><b>机器人 QQ 扫码登录</b>：安装完成后，在首页 NapCat 卡点「启动」，将弹出二维码或登录窗口，用机器人 QQ 扫码；登录态仅保存在本机，不随安装包分发。</li>
                  <li><b>为隔离 DSH 填写模型密钥</b>：进入 DeepSeek Harness 卡 → 配置，在「隔离 home」下的 <code>.credentials.yaml</code> 中写入 <code>DEEPSEEK_API_KEY: xxx</code>（亦可在功能配置页选「自动探测/官方 DeepSeek」并在 DSH 中配置）。</li>
                </ol>
              </TutorialSection>
              <TutorialSection title="② 启动顺序">
                <ol>
                  <li>先启动 <b>NapCat</b>：登录后它自行写入 OneBot 配置（HTTP 3000 / WS 3001，token=truefriend）。</li>
                  <li>再启动 <b>DeepSeek Harness</b>：待其状态变为「运行中」。</li>
                  <li>最后启动 <b>QQ-Bridge</b>（桥）：由它将 QQ 消息转交 DSH 的 AI 处理。</li>
                  <li>亦可直接点上方 <b>「一键启动整套」</b>，程序按 NapCat → DSH → 桥 的顺序自动拉起（NapCat 首次仍需扫码）。</li>
                </ol>
              </TutorialSection>
              <TutorialSection title="③ SSH 远程服务器配置">
                <ol>
                  <li>在首页点 <b>SSH 配置</b> 卡 → 「添加服务器」，填写名称、主机 IP、端口、用户名（如 <code>root</code>）、密码或密钥，随后点「测试」，通过后点「连接」。</li>
                  <li><b>连上之后，首页那三张卡即代表服务器那套</b>：状态行显示 <b>服务端运行中 / 服务端未运行</b>，「启动 / 重启 / 停止」直接操作服务器（DSH 走 <code>systemctl dsh-web</code>、NapCat 走 <code>docker</code>、桥走其自身的启动脚本），「一键启动整套」亦为拉起服务器上的整套。未连接服务器时，这些按钮仍操作本机实例。</li>
                  <li><b>打开界面</b>：NapCat / DeepSeek Harness 卡点「打开」，经隧道打开<b>服务器上</b>的界面（自动携带该机的访问令牌），可在应用内直接查看。隧道映射：NapCat WebUI 6099→13000、NapCat HTTP 3000→13001、DSH 3080→13080、桥控制台 3100→13100（桥控制台设有安全响应头，只能「新窗口打开」）。</li>
                  <li><b>修改服务器上的桥配置</b>：连上服务器时，功能配置页读写的是服务器 <code>/root/qq-bridge/config.json</code>（页首有醒目横幅）。保存流程为：先备份 <code>config.json.bak-时间戳</code> → 原子替换 → 回读比对关键字段；桥按 mtime 热加载，故<b>不必重启桥即可生效</b>；人设与发言规则亦可一并写入服务端。</li>
                  <li><b>用量按两侧分别统计</b>：「学习与用量」页同时给出 <b>本机 / 服务端 / 合计</b>；服务器未连接时只显示本机那份，并注明原因。</li>
                  <li><b>关于失败与冷却</b>：连续测试失败会短暂冷却（<b>连不上 / 超时类：20 秒 → 40 秒 → 60 秒</b>；<b>凭据类仅停 10 秒</b>），提示中写明具体的报错内容，并提供「仍然重试一次」按钮以跳过冷却。<b>但不可反复点击测试</b>：服务器上的 fail2ban 只统计认证失败次数，点击过多会将本机 IP 整机封禁（届时正确密码亦无法连接，表现为连接超时）——若已被封禁，请在服务器上执行 <code>fail2ban-client set sshd unbanip &lt;本机IP&gt;</code>。</li>
                  <li>每台服务器行另设「同步」（将本地桥代码推送至服务器）与「清整套」（删除远端整套并备份）按钮。</li>
                </ol>
              </TutorialSection>
              <TutorialSection title="④ 常用设置入口">
                <ul>
                  <li><b>NapCat / DSH / Bridge</b> 三张卡右下角齿轮为各自的启动配置；<b>QQ-Bridge 卡</b>点开后直接进入「功能配置」页。</li>
                  <li>功能配置页含：<b>常用设置</b>（模型 / 连接 / 白名单 / 主动闲聊）、<b>工具与规则</b>（MCP 工具开关）、<b>人设与发言规则</b>（可上传 .md 或从角色库导入）、<b>JSON 进阶</b>。</li>
                  <li>桥运行后，右上角「群友画像 / 学习与用量」需经过一段时间的交流才会逐渐产生数据。</li>
                </ul>
              </TutorialSection>
              <TutorialSection title="⑤ 端口一览与返回方式">
                <p style={{ margin: 0 }}>
                  所有端口：管理端 1921 · NapCat 6099/3000/3001 · 隔离 DSH {instPortOf(state, 'dsh-isolated')} · 桥 {instPortOf(state, 'bridge-local')}。任一页按 <b>Esc</b> 返回首页。
                </p>
              </TutorialSection>
            </div>
            <div className="help-foot">
              <button className="btn btn-sm" onClick={() => setTutorialOpen(false)}>已阅读，开始配置</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TutorialSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="tutorial-sec">
      <div className="tutorial-sec-title">{title}</div>
      <div className="tutorial-sec-body">{children}</div>
    </div>
  );
}

function instPortOf(state: ManagerState | null, id: string): string {
  const i = state?.instances?.find((x) => x.id === id);
  if (!i) return '—';
  try { return new URL(i.url || '').port || '—'; } catch { return '—'; }
}
