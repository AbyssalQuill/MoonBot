import { useEffect, useState } from 'react';
import NoticeBar from '../components/NoticeBar';
import type { ReactNode } from 'react';
import { instanceAction, startAllInstances, remoteStackById, sshServiceAction } from '../api';
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

/** 按钮/状态完全由服务端的 phase 驱动（服务端用真实探活推进，不再靠"我们 spawn 过"来推断）。
 *  这里只做一步兜底：服务端说是 running、但进程和端口都没了（例如被任务管理器杀了），
 *  就别再显示"运行中"骗用户点「打开」。 */
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

/** 状态小字：尽量说清"现在在等什么"（等扫码 / 等就绪 / 失败原因） */
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

/* 【2026-09-23 主人要求】连上服务器这套的状态机，**搬到卡片底下那行小字里**显示。
 * 原来连接期间卡片小字是「未启动 → 运行中」直接跳，中间那几秒（连 SSH → 建隧道 →
 * 拉服务端组件 → 界面鉴权）毫无反馈，看着像卡住；而反馈它的那条横幅在顶部、
 * 主人已明确要求去掉。阶段定义见 server/index.js 的 connectMachine。 */
const CONNECT_FOOT: Record<string, string> = {
  connecting: '服务端连接中 · 正在连接服务器',
  tunnels: '服务端连接中 · 建立隧道',
  'server-starting': '服务端连接中 · 服务端组件启动中',
  warming: '服务端连接中 · 界面鉴权',
  failed: '服务端连接失败（会自动重试）',
};

const SLOGAN = 'One Chat, One Soul Companion';

/** 打字机循环：逐字蹦出 → 完整句停留 hold → 快速回到 0 重新蹦出（空屏不停留） */
function useTypewriterLoop(text: string, speed = 110, holdMs = 3200) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const tick = (i: number) => {
      if (cancelled) return;
      setN(i);
      if (i >= text.length) {
        // 全句显示：停顿后再从头（先归零再立即开始，不在空屏停留）
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
  const [msg, setMsg] = useState<string | null>(null);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const typed = useTypewriterLoop(SLOGAN);

  const inst = (id: SvcId) => state?.instances.find((i) => i.id === id);

  /* 【2026-09-17 单点登录互斥 L3】state 还没回来的那一两秒里 serverMode 是 false，卡片语义会退回"本机"——
   * 这时点「启动」拉起的是本机 NapCat；紧接着状态到了再点一次又去拉服务端 → 同一个 QQ 号两处登录互踢。
   * 所以在拿到第一份 state 之前，所有动作按钮一律禁用（宁可多等一下，也不要拉出第二个登录）。 */
  const stateReady = !!state;

  /** 统一动作入口：启动/停止/重启都走它，按钮 busy 只覆盖请求本身，
   *  之后的状态由服务端 phase（App 每 1.2~3 秒轮询）接管 —— 这样"启动中"会一直显示到真正就绪。 */
  const doAction = async (id: SvcId, action: 'start' | 'stop' | 'restart') => {
    setBusy(id); setActing(`${id}:${action}`); setMsg(null);
    try {
      const r = await instanceAction(id, action);
      const label = action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启';
      setMsg(r.message ? `${label}：${r.message}` : `${label}已下发`);
    } catch { setMsg('操作失败：无法连接后端'); }
    finally { setBusy(null); setActing(null); onRefresh(); }
  };

  const act = (id: SvcId) => doAction(id, 'start');
  const actStop = (id: SvcId) => doAction(id, 'stop');
  const actRestart = (id: SvcId) => doAction(id, 'restart');

  /* 【2026-09-14 主人要求】连上服务器后，这三张卡就是**服务器那套**：
   *   · 状态看服务端（"服务端运行中/未运行"）；
   *   · 按钮直接操作服务端（systemctl / docker / 桥进程），不再去起本机进程；
   *   · "打开"打开的是**服务端**的界面（经隧道），不是本机那份。
   *  没连服务器时，一切保持原样（本机实例）。 */
  /* 【2026-09-15 修「按钮还是操作本机 / NapCat 没法重启」】
   * 原来 `isRemote = remoteUp !== null && !!remoteId` —— 只要"服务端状态没取到"（断线那几秒、
   * 或某个组件字段缺失），remoteUp 就是 null，于是三张卡**悄悄切回本机语义**：
   * 显示的是本机那几个空闲实例的状态（所以出现"只剩启动、没有重启/停止"），
   * 点「启动」去拉的是**本机** NapCat/DSH/桥（主人 2026-09-14 明确不要）。
   * 现在只要存在活动服务器就按服务端语义显示；没连上时按钮提示"正在重连"，绝不误操作本机。 */
  const serverMode = !!state?.activeServer;
  const remoteId = serverMode ? (state?.activeServer?.id ?? null) : null;
  const remoteCompOf = (id: SvcId): 'dsh' | 'napcat' | 'bridge' =>
    (id === 'napcat-local' ? 'napcat' : id === 'dsh-isolated' ? 'dsh' : 'bridge');
  const remoteSvcIdOf = (id: SvcId): string =>
    (id === 'napcat-local' ? 'srv-napcat-webui' : id === 'dsh-isolated' ? 'srv-dsh-web' : 'srv-bridge');
  const remoteServiceOf = (id: SvcId) => (state?.services ?? []).find((s) => s.id === remoteSvcIdOf(id));

  const doRemoteAction = async (id: SvcId, action: 'start' | 'stop' | 'restart') => {
    if (!remoteId) return;
    if (!sshConn) { setMsg('服务端正在重连，稍等几秒再操作（不会去动本机那套）'); return; }
    setBusy(id); setActing(`${id}:${action}`); setMsg(null);
    try {
      const r = await sshServiceAction(remoteId, remoteCompOf(id), action);
      const label = action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启';
      setMsg(`${label}服务端 ${remoteCompOf(id)}：${r.message || (r.ok ? '已下发' : '未成功')}`);
    } catch { setMsg('操作服务端失败：无法连接后端'); }
    finally { setBusy(null); setActing(null); onRefresh(); }
  };

  /** 一键启动整套：连上服务器时走服务端整套（DSH → NapCat → 桥），否则还是本机那一套 */
  const actAll = async () => {
    setAllBusy(true); setMsg(null);
    try {
      if (remoteId && state?.activeServer) {
        const r = await remoteStackById(remoteId, 'start');
        const lines = (r.steps ?? []).map((s) => `${s.ok ? '✓' : '✗'} ${s.step}：${String(s.msg || '').split('\n')[0]}`).join('\n');
        setMsg(`${r.success ? '服务端整套启动成功' : '服务端整套启动未完成'}\n${lines}`);
        return;
      }
      const r = await startAllInstances();
      const lines = (r.steps ?? []).map((s) => {
        const secs = s.elapsedMs ? `${(s.elapsedMs / 1000).toFixed(1)}s` : '';
        return `${s.success ? '✓' : '✗'} ${s.id}：${s.message}${secs ? '（' + secs + '）' : ''}`;
      }).join('\n');
      setMsg(`${r.success ? '整套启动成功' : '整套启动未完成'}\n${lines}`);
    } catch { setMsg('一键启动失败：无法连接后端'); }
    finally { setAllBusy(false); onRefresh(); }
  };

  const svcs: Array<{ id: SvcId; label: string; sub: string; openTitle: string }> = [
    { id: 'napcat-local', label: 'NapCat', sub: 'QQ 网关', openTitle: 'NapCat 官方界面' },
    { id: 'dsh-isolated', label: 'DeepSeek Harness', sub: '内置大脑 · 独立端口', openTitle: 'DeepSeek Harness' },
    { id: 'bridge-local', label: 'Core', sub: '内置核心层', openTitle: '功能配置' },
  ];

  const sshConn = state?.connected;
  /** 断线自动重连中（管理器会在几秒内自己连回来）—— 这时显示"服务端重连中…"，别显示成"未运行"让人以为坏了 */
  const sshReconnecting = !!state?.reconnecting;

  /** 服务端某个组件的运行状态：连上服务器且已拿到远程状态时返回 boolean；拿不到就返回 null
   *（null = 还是按本机那套文案显示，界面上不会突然空掉）。 */
  const serverUpOf = (id: SvcId): boolean | null => {
    const rs: any = (state as any)?.remoteStatus;
    if (!sshConn || !rs) return null;
    if (id === 'dsh-isolated') return rs.dsh ? !!rs.dsh.running : null;
    if (id === 'napcat-local') return rs.napcat ? !!rs.napcat.running : null;
    if (id === 'bridge-local') return rs.bridge ? !!rs.bridge.running : null;
    return null;
  };

  /* 【2026-09-23】连接状态机 → 卡片小字的中间态（见 CONNECT_FOOT 注释）。
   * idle/ready 之外都算"正在连接途中"，那时小字不再直接说「未运行」，
   * 而是把当前阶段写出来，避免"未启动 → 运行中"的突兀跳变。 */
  const connPhase = state?.connect?.phase ?? 'idle';
  /* 【2026-09-23 主人要求】"应用首次打开按钮会有一小段浅粉色点不了的状态，想让它不出现，
   * 直接就是『服务端连接中』这种。"
   * 那一段是**首次 /api/state 还没回来**的窗口（`stateReady = !!state`）：此时按钮文案是「加载中…」
   * 且带 disabled 样式（浅粉），看着像"坏了"。而应用首开本来就会自动连服务器，
   * 所以这个窗口在语义上就是"正在连接服务器"——直接按它显示，既准确又不突兀。 */
  const booting = !stateReady;
  const connectBusy = booting || (connPhase !== 'idle' && connPhase !== 'ready');
  const connectFailed = connPhase === 'failed';
  const connectFootText = booting
    ? CONNECT_FOOT.connecting
    : (CONNECT_FOOT[connPhase] || `服务端连接中 · ${connPhase}`);

  return (
    <div className="launcher">
      <NoticeBar msg={msg} onClose={() => setMsg(null)} />

      {/* 【2026-09-12】主人要求：Home 页标题悬停不要弹说明（去掉原生 title 提示框） */}
      <div className="launcher-title">
        <div className="typewriter">{typed}</div>
        <div className="launcher-tag">MoonBot · 一键配置本地和服务器的拟人 QQ Bot</div>
      </div>

      {/* 新手教程：副标题下方、一键启动上方，居中窄按钮 */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
        <button className="btn btn-primary tutorial-btn" onClick={() => setTutorialOpen(true)} title="第一次使用？先看这里">
          <BookOpen size={14} style={{ verticalAlign: -2, marginRight: 6 }} /> 新手教程
        </button>
      </div>

      {/* 【2026-09-12】安装位置体检：装在 Program Files / 同步盘时提前提醒（记忆库写在安装目录里，
          这类位置会写不进去或同步冲突）——"拿给别人安装"最容易踩的两个坑。 */}
      {(state?.warnings?.length ?? 0) > 0 && (
        <div className="notice-bar" style={{ maxWidth: 720, margin: '0 auto 12px', textAlign: 'left' }}>
          {(state?.warnings ?? []).map((w, i) => <div key={i}>⚠️ {w}</div>)}
        </div>
      )}

      {/* 【2026-09-23 主人要求】原来这里有一条「正在连接服务器 / 服务端启动中」的横幅（连接状态机）。
          主人要求去掉它：连接进度改为就地写在**每张卡片底下那行小字**里（见 CONNECT_FOOT 与 big-foot），
          免得顶部横幅和卡片小字两处各说一套、还自相矛盾。阶段明细与失败原因改挂在卡片的 title 上。 */}

      {/* 【2026-09-14 主人问"连上服务器就算跑起来了吗"】服务器那套是常驻的（systemd/docker），
          连上就能用、不用再点一次启动；只有当服务端整套都没在跑时才提示一句，免得看着三张
          「服务端未运行」的卡不知道该干什么。 */}
      {sshConn && (() => {
        const rs: any = (state as any)?.remoteStatus;
        if (!rs) return null;
        const ups = [rs.dsh?.running, rs.napcat?.running, rs.bridge?.running].filter((x) => x !== undefined);
        if (!ups.length || ups.some(Boolean)) return null;
        return (
          <div className="notice-bar" style={{ maxWidth: 720, margin: '0 auto 12px', textAlign: 'left' }}>
            ⚠️ 已连上服务器，但服务端整套都没在跑（DSH / NapCat / 桥）。点下面「一键启动整套」，或卡片上的「启动服务端」。
          </div>
        );
      })()}

      {/* 【2026-09-17 单点登录互斥】本机和服务端同时有 NapCat 在线 —— 同一个 QQ 号两处登录会被腾讯互踢，显著提示 */}
      {(state as any)?.dualNapcat && (
        <div className="notice-bar" style={{ maxWidth: 720, margin: '0 auto 12px', textAlign: 'left', borderColor: '#e5484d', color: '#b42318', background: '#fff5f5' }}>
          ⚠️ 本机和服务端的 NapCat 同时在跑。同一个 QQ 号两处登录会被腾讯判为「已在另一台终端登录」，两边互相踢下线。
          请只保留一个：点上面「一键启动整套（服务端）」（管理器会先停掉本机那份），或去服务端卡片点「停止」。
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
        <button className="btn btn-primary" style={{ padding: '8px 26px', fontSize: 15, borderRadius: 12 }} disabled={allBusy || booting} onClick={actAll} data-genui-primary-action>
          {(booting || allBusy) ? <Loader2 size={16} className="spin" style={{ verticalAlign: -2, marginRight: 8 }} /> : <Rocket size={16} style={{ verticalAlign: -2, marginRight: 8 }} />}
          {booting ? '服务端连接中…' : allBusy ? '正在一键启动整套…' : (sshConn ? '一键启动整套（服务端）' : '一键启动整套（NapCat → DSH → 桥）')}
        </button>
      </div>

      <div className="tiles grid2x2">
        {svcs.map((t) => {
          const i = inst(t.id);
          const remoteUp = sshConn ? serverUpOf(t.id) : null;
          const isRemote = serverMode;
          // 连上服务器时：状态取服务端、按钮操作服务端、打开的是服务端界面；否则完全按本机老逻辑。
          const phase: Phase = isRemote ? (remoteUp ? 'running' : 'idle') : phaseOf(i);
          const startAct = () => (isRemote ? doRemoteAction(t.id, 'start') : act(t.id));
          const stopAct = () => (isRemote ? doRemoteAction(t.id, 'stop') : actStop(t.id));
          const restartAct = () => (isRemote ? doRemoteAction(t.id, 'restart') : actRestart(t.id));
          // QQ-Bridge「打开」直接进配置页（连上服务器时那一页读写的就是服务端配置）
          const handleOpen = () => {
            if (t.id === 'bridge-local') { onOpenConfig('bridge-local'); return; }
            if (isRemote) {
              const svc = remoteServiceOf(t.id);            // 服务端 DSH / NapCat 界面（经隧道）
              if (svc?.url) onOpenWeb(svc.url, t.openTitle);
              return;
            }
            if (i?.url) onOpenWeb(i.url, t.openTitle);
          };
          void restartAct;
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
                  <button className="btn btn-primary btn-block" disabled={busy === t.id || booting} onClick={startAct}>
                    {booting ? '服务端连接中…' : busy === t.id ? <><Loader2 size={16} className="spin" /> {isRemote ? '下发中…' : '启动中…'}</> : phase === 'failed' ? '重试启动' : (isRemote ? '启动服务端' : '启动')}
                  </button>
                )}
                <button className="icon-btn" title="配置" onClick={() => onOpenConfig(t.id)}><Settings size={17} /></button>
              </div>
              <div className="big-foot" title={connectBusy ? (state?.connect?.note || '') : (isRemote ? (state?.connect?.note || '') : (phase === 'failed' ? (i?.error || '') : (i?.note || '')))}>
                {/* 【2026-09-23 关键顺序】中间态必须排在 isRemote 前面。
                    isRemote = !!state.activeServer，而 **connecting / tunnels 这两个最早阶段 SSH 还没连上**，
                    后端此时不会下发 activeServer（resolveServices 里服务端那组只在 sshConnections 里有这条连接时才拼）
                    → isRemote 仍是 false → 会掉进本机那套文案，显示成「未启动」。
                    这正是主人看到的"从未启动直接跳到运行中"：前两段被本机文案顶掉，
                    最后两段又不到 1 秒、4 秒的轮询根本采样不到。现在只要连接状态机在跑就显示中间态。 */}
                {connectBusy
                  ? <><span className={`status-dot ${connectFailed ? 'offline' : 'loading'}`} />{connectFailed ? <AlertTriangle size={12} /> : null}<span>{connectFootText}</span></>
                  : isRemote
                    ? (sshReconnecting
                      ? <><span className="status-dot loading" /><span>服务端重连中…</span></>
                      : <><span className={`status-dot ${remoteUp ? 'online' : 'offline'}`} /><span>{remoteUp ? '服务端运行中' : '服务端未运行'}</span></>)
                    : <><span className={`status-dot ${dotClass(phase)}`} /><span>{footText(i, phase)}</span></>}
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
            <span className={`status-dot ${sshConn ? 'online' : 'offline'}`} />
            <span>{sshConn ? '远程已连接' : '未连接远程'}</span>
          </div>
        </div>
      </div>

      <div className="launcher-footer">© 2026 AbyssalQuill · MoonBot · 一键配置本地与服务器的拟人 QQ Bot</div>

      {tutorialOpen && (
        <div className="help-overlay" style={{ zIndex: 120 }} onClick={() => setTutorialOpen(false)}>
          <div className="help-panel tutorial-panel" onClick={(e) => e.stopPropagation()}>
            <div className="help-head">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><BookOpen size={16} /> 新手教程 · 第一次启动前</span>
              <button className="icon-btn" onClick={() => setTutorialOpen(false)}><X size={16} /></button>
            </div>
            <div className="tutorial-body">
              <TutorialSection title="① 启动前需要准备的两件事">
                <ol>
                  <li><b>机器人 QQ 扫码登录</b>：装好 MoonBot 后点首页 NapCat 卡「启动」，会弹出二维码/登录窗口，用机器人 QQ 扫一下（登录态只存在本机，不随安装包分发）。</li>
                  <li><b>给隔离 DSH 填模型密钥</b>：DeepSeek Harness 卡 → 配置 → 把「隔离 home」下的 <code>.credentials.yaml</code> 里写上你的 <code>DEEPSEEK_API_KEY: xxx</code>（也可在功能配置页选「自动探测/官方 DeepSeek」并在 DSH 里配好）。</li>
                </ol>
              </TutorialSection>
              <TutorialSection title="② 正确的启动顺序">
                <ol>
                  <li>先 <b>NapCat</b>：登录后它自己会写 OneBot 配置（HTTP 3000 / WS 3001，token=truefriend）。</li>
                  <li>再 <b>DeepSeek Harness</b>：等它变「运行中」。</li>
                  <li>最后 <b>QQ-Bridge</b>（桥）：它把 QQ 消息转给 DSH 的 AI 处理。</li>
                  <li>也可以直接点上方 <b>「一键启动整套」</b>，程序会按 NapCat → DSH → 桥 的顺序自动拉起（NapCat 首次仍需扫码）。</li>
                </ol>
              </TutorialSection>
              <TutorialSection title="③ SSH 远程服务器怎么配">
                <ol>
                  <li>首页点 <b>SSH 配置</b> 卡 → 「添加服务器」填：名称、主机 IP、端口、用户名（如 <code>root</code>）、密码或密钥，然后点「测试」再点「连接」。</li>
                  <li><b>连上之后，首页那三张卡就代表服务器那套</b>：状态行显示 <b>服务端运行中 / 服务端未运行</b>，「启动 / 重启 / 停止」直接操作服务器（DSH 走 <code>systemctl dsh-web</code>、NapCat 走 <code>docker</code>、桥走它自己的启动脚本），「一键启动整套」也是拉起服务器上的整套。没连服务器时，这些按钮还是操作本机。</li>
                  <li><b>打开界面</b>：NapCat / DeepSeek Harness 卡点「打开」会经隧道打开<b>服务器上</b>的界面（自动带上该机的访问令牌），可在应用内直接看。隧道映射：NapCat WebUI 6099→13000、NapCat HTTP 3000→13001、DSH 3080→13080、桥控制台 3100→13100（桥控制台有安全响应头，只能「新窗口打开」）。</li>
                  <li><b>改服务器上的桥配置</b>：连上服务器时，功能配置页读写的就是服务器 <code>/root/qq-bridge/config.json</code>（页首有醒目横幅）。保存 = 先备份 <code>config.json.bak-时间戳</code> → 原子替换 → 回读比对关键字段，桥按 mtime 热加载，所以<b>不用重启桥就生效</b>；人设与发言规则也能一起写到服务端。</li>
                  <li><b>用量按两边分开算</b>：「学习与用量」页会同时给出 <b>本机 / 服务端 / 合计</b>；服务器没连上时只显示本机那份，并写明原因。</li>
                  <li><b>关于失败与冷却</b>：连续测失败会短暂冷却（<b>连不上/超时类：20 秒 → 40 秒 → 60 秒</b>；<b>凭据类只停 10 秒</b>），提示里会写清"这几回到底报什么错"，并给一个「仍然重试一次」按钮可以跳过冷却。<b>但别狂点测试</b>：服务器上的 fail2ban 只认认证失败次数，点多了会把本机 IP 整机封掉（那时正确密码也连不上，表现为连接超时）——真被封了就在服务器上跑 <code>fail2ban-client set sshd unbanip &lt;本机IP&gt;</code>。</li>
                  <li>每台服务器行还有「同步」（把本地桥代码推到服务器）和「清整套」（删除远端整套并备份）按钮。</li>
                </ol>
              </TutorialSection>
              <TutorialSection title="④ 常用设置入口">
                <ul>
                  <li><b>NapCat / DSH / Bridge</b> 三张卡右下角齿轮 = 各自的启动配置；<b>QQ-Bridge 卡</b>点开直接进「功能配置」页。</li>
                  <li>功能配置页：<b>常用设置</b>（模型/连接/白名单/主动闲聊）、<b>工具与规则</b>（MCP 工具开关）、<b>人设与发言规则</b>（可上传 .md 或从角色库导入）、<b>JSON 进阶</b>。</li>
                  <li>桥跑起来后，右上角「群友画像 / 学习与用量」需要聊一阵子才会慢慢有数据。</li>
                </ul>
              </TutorialSection>
              <TutorialSection title="⑤ 忘了在哪？">
                <p style={{ margin: 0 }}>
                  所有端口：管理端 1921 · NapCat 6099/3000/3001 · 隔离 DSH {instPortOf(state, 'dsh-isolated')} · 桥 {instPortOf(state, 'bridge-local')}。任一页按 <b>Esc</b> 返回首页。
                </p>
              </TutorialSection>
            </div>
            <div className="help-foot">
              <button className="btn btn-sm" onClick={() => setTutorialOpen(false)}>知道了，开始配置</button>
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
