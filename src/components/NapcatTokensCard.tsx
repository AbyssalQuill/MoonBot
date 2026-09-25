import { useCallback, useEffect, useState } from 'react';
import { KeyRound, RefreshCw, Loader2, AlertTriangle, ShieldCheck, Eye, EyeOff } from 'lucide-react';
import { getNapcatTokens, applyNapcatTokens } from '../api';

/**
 * NapCat 鉴权令牌卡（WebUI / HTTP / WS）
 *
 * 背景：管理端原先只把令牌写入桥的 `config.json`（即桥侧的期望值），
 * NapCat 自身的配置（`webui.json` / `onebot11*.json`）从未被改写。由此出现两种现象：
 *   · 写入的新令牌不生效，NapCat 仍按默认值接收（旧令牌仍可进入 WebUI）；
 *   · 桥以新令牌连接 NapCat 时返回 401 或无法建立连接。
 * 本卡的职责为：将令牌真正写入 NapCat 配置、按需重启、并使桥 `config.json` 中的期望值与之对齐；
 * 结果如实展示，现状仅显示掩码，不含任何明文令牌。
 *
 * 2026-09-23 变更记录
 *   · 「NapCat 登录二维码」卡整张删除：本机 OneKey 形态下二维码位于 Docker 容器内，本机无法获取，
 *     属无效界面。相关状态（qr/qrErr/qrBusy）、fetchQr 回调、自动抓码的 useEffect，
 *     以及 getNapcatQr/NapcatQrSnapshot/QrCode 的 import 一并移除。
 *   · 支持后端新增的「本机 OneKey」形态：mode === 'local-onekey' 时不再涉及容器；
 *     三个输入框默认填入 current 中的当前明文值，提交时只提交与载入值不同的字段。
 *   · 说明文字压至 3~4 行（用法 / 令牌规则 / 重启要求 / 风险提示）。
 */
interface NapStatus {
  ok?: boolean;
/** 2026-09-23'local-onekey' = 本机 OneKey（NapCat 直接运行于本机，配置写在它自身的 config 目录） */
  mode?: string;
  dir?: string;
  container?: string;
  napcat?: { webui?: string; http?: string; ws?: string };
  bridge?: { webui?: string; http?: string; ws?: string };
/** 2026-09-23NapCat 配置中当前的明文令牌（本机形态下用作输入框默认值，并参与变更比较） */
  current?: { webui?: string; http?: string; ws?: string };
  files?: { webui?: boolean; onebot?: string[]; protocol?: string[] };
  mismatch?: { http?: boolean; ws?: boolean };
/** 2026-09-16NapCat 自身的 QQ 登录态（"机器人不回复"排查的第一处判据：需扫码，或桥未连通） */
  login?: { ok?: boolean; isLogin?: boolean; online?: boolean; nick?: string; uin?: string; loginPhase?: string; coreReady?: boolean; error?: string };
/** 2026-09-16 强化 NapCat 连接：桥 → NapCat 链路的诊断信息（是否连通、距上次下行时长、重连次数） */
  connection?: {
    url?: string; connected?: boolean; readyState?: number; everOpened?: boolean;
    lastActivityAgoMs?: number | null; reconnects?: number; outbox?: number; pending?: number;
    heartbeatProbeMs?: number; watchdogMs?: number; error?: string;
  };
  notes?: string[];
}

type TokenKey = 'webui' | 'http' | 'ws';

export default function NapcatTokensCard() {
  const [st, setSt] = useState<NapStatus | null>(null);
  const [err, setErr] = useState('');
  const [webui, setWebui] = useState('');
  const [http, setHttp] = useState('');
  const [ws, setWs] = useState('');
  const [restart, setRestart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [show, setShow] = useState(false);

  const load = useCallback(async () => {
    setErr('');
    try {
      const r: any = await getNapcatTokens();
      if (r?.ok === false && r?.error) { setErr(String(r.error)); setSt(null); }
      else {
        setSt(r as NapStatus);
        /* 2026-09-23输入框默认填入当前值（本机形态下后端在 current 中给出明文），
         * 使用者可直接核对现值，需要修改哪一项就改哪一项。
         * current 缺失时（旧接口 / docker 形态）退回「留空 = 不改动」。
         * 提交时会与此处载入的值比较，相等的字段不写盘。 */
        setWebui(String(r?.current?.webui ?? ''));
        setHttp(String(r?.current?.http ?? ''));
        setWs(String(r?.current?.ws ?? ''));
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /* 2026-09-24 变更要求：登录态改为 SSE 实时探测：
   * 桥侧的 /api/napcat/login-stream 在"建立连接 / 链路开关 / 登录态变化"时推一份完整诊断，
   * 前端就地更新（不再靠手动刷新）。SSE 不可用（桥版本较旧）时静默退回"一次性读取 + 手动刷新"，
   * 并在界面上如实标注，绝不假装还是实时的。 */
  const [live, setLive] = useState<any | null>(null);
  const [liveState, setLiveState] = useState<'connecting' | 'live' | 'offline'>('connecting');
  useEffect(() => {
    if (typeof EventSource === 'undefined') { setLiveState('offline'); return () => {}; }
    const es = new EventSource('/api/napcat/login-stream');
    es.addEventListener('napcat-login', (ev: MessageEvent) => {
      try {
        const d = JSON.parse(String(ev.data));
        if (d?.ok === false) { setLiveState('offline'); return; }
        setLive(d);
        setLiveState('live');
      } catch { setLiveState('offline'); }
    });
    es.addEventListener('stream-error', () => setLiveState('offline'));
    es.onopen = () => setLiveState((s) => (s === 'live' ? s : 'connecting'));
    es.onerror = () => setLiveState('offline');
    return () => es.close();
  }, []);
  /* 实时值优先；SSE 没数据时用手动读取到的那份 */
  const view: any = live
    ? { login: live.login, connection: live.connection }
    : { login: st?.login, connection: st?.connection };

  const apply = async (useBridgeTokens = false) => {
    if (busy) return;
    const patch: any = { restart };
    if (useBridgeTokens) patch.useBridgeTokens = true;
    else {
      /* 只提交与载入值不同的字段：默认显示当前值不会导致"每次点击都把三处令牌重写一遍"。
         空输入仍表示"该项不改动"。 */
      const loaded = (k: TokenKey) => String((st?.current as any)?.[k] ?? '');
      const changedOf = (k: TokenKey, v: string) => { const t = v.trim(); return t !== '' && t !== loaded(k); };
      if (changedOf('webui', webui)) patch.webuiToken = webui.trim();
      if (changedOf('http', http)) patch.httpToken = http.trim();
      if (changedOf('ws', ws)) patch.wsToken = ws.trim();
      if (!patch.webuiToken && !patch.httpToken && !patch.wsToken) {
        setMsg('未检测到改动：输入框内容与 NapCat 当前的令牌一致。如需更换，请修改对应字段，或点右侧「用桥里现有的令牌写入」。');
        return;
      }
    }
    const ok = window.confirm(
      `${useBridgeTokens ? '将桥配置中现有的令牌统一写入 NapCat' : '将上方改动的令牌写入 NapCat 配置'}${restart ? '，并重启 NapCat（约 30~60 秒）' : '（不重启，下次启动时生效）'}？\n\n`
      + `· 写入前自动备份 webui.json / onebot11*.json（同目录 _bak-<时间>，最多保留 5 份）；\n`
      + `· 重启 NapCat 可能丢失登录态并需重新扫码（当前若已掉登录，重启无额外代价）；\n`
      + `· 写入完成后旧令牌立即失效，管理端入口链接会自动携带新令牌。`,
    );
    if (!ok) return;
    setBusy(true);
    setMsg('正在写入 NapCat 配置并重启…（约 30~60 秒）');
    try {
      const r: any = await applyNapcatTokens(patch);
      if (r?.ok === false || r?.error) { setMsg(`失败：${r?.error ?? '未知错误'}`); return; }
      const c = r?.changed ?? {};
      const chg = [c.webui ? 'WebUI' : '', c.http ? `HTTP×${c.http}` : '', c.ws ? `WS×${c.ws}` : ''].filter(Boolean).join('、');
      setMsg(
        `${r?.note ?? '已写入'}；改动：${chg || '无'}`
        + `；重启：${r?.restart ? (r.restart.ok ? `成功（${Math.round((r.restart.ms ?? 0) / 1000)}s）` : `失败（${r.restart.detail ?? '未知'}）`) : '未重启'}`
        + `；校验：${r?.verify?.note ?? '（见下方登录态）'}`,
      );
      setWebui(''); setHttp(''); setWs('');
      await load();
    } catch (e: any) {
      setMsg(`失败：${e?.message ?? e}`);
    } finally { setBusy(false); }
  };

  const mismatch = Boolean(st?.mismatch?.http || st?.mismatch?.ws);
  /* 2026-09-16连接诊断按 any 取一层：TS 在 `st.connection ? … : (access .error)` 的 else 分支中
   * 会将类型收窄为 never（可选属性访问报 TS2339），此处显式放宽，以免构建中断。
   * 2026-09-30改从 view 取：SSE 实时值优先，没有实时值时用一次性读取的那份。 */
  const conn: any = view.connection;
  /* 2026-09-23本机 OneKey 形态：NapCat 运行于本机、配置写在它自身的 config 目录，不涉及容器 */
  const isLocal = st?.mode === 'local-onekey';
  const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const };

  return (
    <div className="card-stack">
      {/* ============ 卡 1/1：NapCat 鉴权令牌（WebUI / HTTP / WS） ============
          仅承载令牌：现状展示 → 填入或对齐 → 写入并重启。
          【2026-09-23】原「NapCat 登录二维码」卡已整张删除。 */}
      <div className="card">
        <div className="card-title">
          <KeyRound size={17} /> NapCat 鉴权令牌（WebUI / HTTP / WS）
          <span className="lrn-updated">写入 NapCat 自身的配置，重启后生效</span>
        </div>

        {err ? (
          <div className="lrn-error">
            <AlertTriangle size={15} />
            <div style={{ flex: 1 }}>{err}</div>
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => void load()}><RefreshCw size={13} /> 重试</button>
          </div>
        ) : !st ? (
          <div className="lrn-inline-note"><Loader2 size={13} className="spin" /> 正在读取 NapCat 令牌现状…</div>
        ) : (
          <>
            <div className="lrn-inline-note" style={{ display: 'block', lineHeight: 1.75 }}>
              {/* 【2026-09-16】登录态是"机器人不回复"排查的第一处判据：需扫码，或桥的连接已断开
                  【2026-09-30】改为 SSE 实时值优先；下面那行小字如实标注推送是否在工作。 */}
              QQ 登录态：
              <span className="lrn-updated" style={{ marginLeft: 6 }}>
                {liveState === 'live' ? '实时推送中' : liveState === 'connecting' ? '正在连接实时推送…' : '实时推送不可用（用一次性读取的值，可点刷新）'}
              </span>
              {view.login?.ok ? (
                view.login.isLogin ? (
                  <span style={{ color: 'var(--nc-success-600, #16a34a)' }}>
                    ✅ 已登录{view.login.online ? '、在线' : ''}
                    {view.login.nick ? `（${view.login.nick}${view.login.uin ? ' · ' + view.login.uin : ''}）` : ''}
                  </span>
                ) : (
                  <span style={{ color: 'var(--nc-danger-600)' }}>
                    注意 未登录 —— 需在管理端首页打开 NapCat WebUI 扫码
                    {/* 2026-09-24：避免把"本机 OneKey 这份安装没登录"误读成"服务器上的机器人没登录"：
                        本机形态只按本地配置文件判定，与服务器上的桥完全无关。 */}
                    {isLocal ? '（注：这是本机 OneKey 这份安装的登录态 —— 只读本地配置文件判定，与服务器上的桥无关）' : ''}
                  </span>
                )
              ) : (
                <span>查询失败（{view.login?.error || 'NapCat 未启动或端口不通'}）</span>
              )}
              <br />
              {/* 【2026-09-16 强化 NapCat 连接】桥 → NapCat 链路的自身健康状况：是否连通、距上次下行时长、重连次数 */}
              桥 → NapCat 连接：
              {/* 2026-09-24：这里原先在 conn 为空时一律写「查询失败（桥刚启动或未暴露统计信息）」，
                  这是谎报：本机 OneKey 形态根本不做这项诊断（管理器直读 NapCat 配置，桥进程可能压根没跑），
                  而服务端形态下桥也可能只是没带这个字段。现在按真实原因分三种说法，绝不再拿"失败"兜底。 */}
              {conn ? (
                conn.unavailable ? (
                  <span style={{ color: 'var(--nc-foreground-600, #57606a)' }}>
                    —— 本形态不提供该诊断（{conn.note || '桥未运行 OneBot 客户端'}）
                  </span>
                ) : conn.connected ? (
                  <span style={{ color: 'var(--nc-success-600, #16a34a)' }}>
                    ✅ 已连接（
                    {typeof conn.lastActivityAgoMs === 'number'
                      ? `最近一次收到下行 ${Math.max(0, Math.round(conn.lastActivityAgoMs / 1000))} 秒前`
                      : '连接刚建立'}
                    {conn.reconnects ? `，累计重连 ${conn.reconnects} 次` : ''}）
                  </span>
                ) : (
                  <span style={{ color: 'var(--nc-danger-600)' }}>
                    注意 未连接（按退避策略重连，间隔最长 10 秒）
                    {typeof conn.lastActivityAgoMs === 'number'
                      ? `，已 ${Math.max(0, Math.round(conn.lastActivityAgoMs / 1000))} 秒未收到下行`
                      : ''}
                    {conn.reconnects ? `，累计重连 ${conn.reconnects} 次` : ''}
                  </span>
                )
              ) : (
                <span style={{ color: 'var(--nc-foreground-600, #57606a)' }}>
                  —— 桥没有返回该诊断字段（多为桥版本较旧；不代表桥没连上）
                </span>
              )}
              {conn && conn.error ? (
                <>
                  <br />
                  <span style={{ color: 'var(--nc-danger-600)' }}>诊断取值时报错：{String(conn.error)}</span>
                </>
              ) : null}
              {/* 2026-09-24：「改成服务器连接时就看服务器」：这张卡现在按当前目标取数
                  （连上服务器 → 数据来自服务器上的桥；否则才是本机 OneKey 安装）。
                  把来源写在卡上，避免再把它误读成另一套环境的登录态。 */}
              <br />
              <span style={{ color: 'var(--nc-foreground-600, #57606a)' }}>
                数据来源：{isLocal ? '本机 OneKey 安装' : '服务器（另一端桥的控制台）'}
                {st.dir ? `（${st.dir}）` : ''}
              </span>
              {mismatch && (
                <>
                  <br />
                  <span style={{ color: 'var(--nc-danger-600)' }}>
                    注意 两者不一致 —— 桥以新令牌连接，NapCat 仅接受旧令牌。
                    可点下方「用桥里现有的令牌写入」统一两处，或修改令牌后点「写入改动的令牌」。
                  </span>
                </>
              )}
            </div>

            <div className="cfg-fields">
              <label className="field-row">
                <span className="f-label">WebUI 登录令牌（6099）</span>
                <input className="input" type={show ? 'text' : 'password'} autoComplete="new-password"
                  placeholder="留空 = 不改动"
                  value={webui} onChange={(e) => setWebui(e.target.value)} />
              </label>
              <label className="field-row">
                <span className="f-label">HTTP 令牌（3000）</span>
                <input className="input" type={show ? 'text' : 'password'} autoComplete="new-password"
                  placeholder="留空 = 不改动"
                  value={http} onChange={(e) => setHttp(e.target.value)} />
              </label>
              <label className="field-row">
                <span className="f-label">WS 令牌（3001）</span>
                <input className="input" type={show ? 'text' : 'password'} autoComplete="new-password"
                  placeholder="留空 = 不改动"
                  value={ws} onChange={(e) => setWs(e.target.value)} />
              </label>
              <label className="switch-row">
                <input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} />
                <span>{isLocal ? '写完重启 NapCat（推荐）' : '写完重启 NapCat 容器（推荐）'}</span>
                <em>
                  NapCat 仅在启动时读取配置；不重启则新令牌须待下次启动生效。
                  {isLocal ? '重启会预留足够的宽限时间，避免被强制终止。' : '重启用 docker restart -t 60（预留 30 秒宽限，避免被强制终止）。'}
                </em>
              </label>
            </div>

            <div className="lrn-actions" style={rowStyle}>
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void apply(false)}>
                {busy ? <Loader2 size={14} className="spin" /> : <ShieldCheck size={14} />} 写入改动的令牌{restart ? '并重启' : ''}
              </button>
              <button className="btn btn-soft-primary btn-sm" disabled={busy || !st?.bridge?.http}
                title="无需手工抄录：直接以桥配置中现有的 HTTP/WS 令牌写入 NapCat（WebUI 同用该值），使三处一致"
                onClick={() => void apply(true)}>
                {busy ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />} 用桥里现有的令牌写入
              </button>
              <button className="btn btn-sm" disabled={busy} onClick={() => void load()}><RefreshCw size={13} /> 刷新现状</button>
              <button className="btn btn-sm" onClick={() => setShow((v) => !v)}>
                {show ? <EyeOff size={13} /> : <Eye size={13} />} {show ? '隐藏输入' : '显示输入'}
              </button>
            </div>
            {msg && <div className="lrn-inline-note" style={{ marginTop: 6 }}>{msg}</div>}
          </>
        )}
      </div>
    </div>
  );
}
