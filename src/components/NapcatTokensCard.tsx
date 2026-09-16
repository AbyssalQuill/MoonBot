import { useCallback, useEffect, useState } from 'react';
import { KeyRound, RefreshCw, Loader2, AlertTriangle, ShieldCheck, Eye, EyeOff } from 'lucide-react';
import { getNapcatTokens, applyNapcatTokens } from '../api';

/**
 * NapCat 鉴权令牌卡（WebUI / HTTP / WS）
 *
 * 【为什么单独做一张卡】管理端原来只是把令牌存在**桥的 config.json** 里（桥"期望"用哪个），
 * NapCat 自己的配置（webui.json / onebot11*.json）从来没被改过 —— 于是：
 *   · 新令牌写进去没有用，NapCat 照样收默认 truefriend（旧令牌能进 WebUI）；
 *   · 桥拿着新令牌去连 NapCat，反而是 401/连不上。
 * 这张卡做的是"把令牌真正写进 NapCat + 重启容器 + 复验（新令牌能过、旧令牌被拒）"，
 * 顺手把桥 config.json 的期望值对齐，并把结果如实显示出来（不含任何明文令牌）。
 */
interface NapStatus {
  ok?: boolean;
  dir?: string;
  container?: string;
  napcat?: { webui?: string; http?: string; ws?: string };
  bridge?: { webui?: string; http?: string; ws?: string };
  files?: { webui?: boolean; onebot?: string[]; protocol?: string[] };
  mismatch?: { http?: boolean; ws?: boolean };
  /** 【2026-09-16】NapCat 自己的 QQ 登录态（"不回复"排查的第一分叉：要扫码 vs 桥聋了） */
  login?: { ok?: boolean; isLogin?: boolean; online?: boolean; nick?: string; uin?: string; loginPhase?: string; coreReady?: boolean; error?: string };
  /** 【2026-09-16 强化 NapCat 连接】桥→NapCat 这条链路自己的诊断（连上没有 / 多久没下行 / 重连过几次） */
  connection?: {
    url?: string; connected?: boolean; readyState?: number; everOpened?: boolean;
    lastActivityAgoMs?: number | null; reconnects?: number; outbox?: number; pending?: number;
    heartbeatProbeMs?: number; watchdogMs?: number; error?: string;
  };
  notes?: string[];
}

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
      if (r?.ok === false && r?.error) { setErr(String(r.error)); setSt(null); return; }
      setSt(r as NapStatus);
      // 输入框一律留空 = "不改动"，避免把掩码串（形如 ab****yz）当成真令牌写进去；要沿用桥的值就点「用桥里现有的令牌写入」
      setWebui(''); setHttp(''); setWs('');
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const apply = async (useBridgeTokens = false) => {
    if (busy) return;
    const patch: any = { restart };
    if (useBridgeTokens) patch.useBridgeTokens = true;
    else {
      if (webui.trim()) patch.webuiToken = webui.trim();
      if (http.trim()) patch.httpToken = http.trim();
      if (ws.trim()) patch.wsToken = ws.trim();
      if (!patch.webuiToken && !patch.httpToken && !patch.wsToken) {
        setMsg('先在下面至少填一个令牌（WebUI / HTTP / WS），或者点右边那个「用桥里现有的令牌写入」。');
        return;
      }
    }
    const ok = window.confirm(
      `${useBridgeTokens ? '把桥配置里现有的令牌统一写进 NapCat' : '把上面填的令牌写进 NapCat 配置'}${restart ? '并重启 NapCat 容器（约 30~60 秒）' : '（不重启，下次启动才生效）'}？\n\n`
      + `· 会先自动备份 webui.json / onebot11*.json（同目录 _bak-<时间>，最多留 5 份）\n`
      + `· 重启 NapCat 可能会掉登录态、需要重新扫码（当前若已掉登录，重启没有额外代价）\n`
      + `· 写完后旧令牌立即失效，管理端的入口链接会自动带上新令牌`,
    );
    if (!ok) return;
    setBusy(true);
    setMsg('正在写入并重启 NapCat…（约 30~60 秒）');
    try {
      const r: any = await applyNapcatTokens(patch);
      if (r?.ok === false || r?.error) { setMsg(`失败：${r?.error ?? '未知错误'}`); return; }
      const c = r?.changed ?? {};
      const chg = [c.webui ? 'WebUI' : '', c.http ? `HTTP×${c.http}` : '', c.ws ? `WS×${c.ws}` : ''].filter(Boolean).join('、');
      const v = r?.verify ?? {};
      setMsg(
        `${r?.note ?? '已写入'}；改动：${chg || '无'}`
        + `；重启：${r?.restart ? (r.restart.ok ? `成功（${Math.round((r.restart.ms ?? 0) / 1000)}s）` : `失败（${r.restart.detail ?? '未知'}）`) : '未重启'}`
        + `；复验：${v.note ?? '——'}`,
      );
      setWebui(''); setHttp(''); setWs('');
      await load();
    } catch (e: any) {
      setMsg(`失败：${e?.message ?? e}`);
    } finally { setBusy(false); }
  };

  const mismatch = Boolean(st?.mismatch?.http || st?.mismatch?.ws);
  // 【2026-09-16】连接诊断用 any 取一层：TS 在 `st.connection ? … : (access .error)` 的 else 分支里
  // 会把类型收窄成 never（可选属性访问报 TS2339），这里明确放宽，避免构建被卡。
  const conn: any = st?.connection;
  const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const };

  return (
    <div className="card">
      <div className="card-title">
        <KeyRound size={17} /> NapCat 鉴权令牌（WebUI / HTTP / WS）
        <span className="lrn-updated">写进 NapCat 自己的配置并重启，不只是改桥里的期望值</span>
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
            配置文件：<code>{st.dir || '（未找到）'}</code>　容器：<code>{st.container || 'napcat'}</code>
            {st.files?.onebot?.length ? <>　涉及文件：{st.files.onebot.join('、')}</> : null}
            <br />
            NapCat 磁盘现状：WebUI <code>{st.napcat?.webui || '（空）'}</code>　HTTP <code>{st.napcat?.http || '（空）'}</code>　WS <code>{st.napcat?.ws || '（空）'}</code>
            <br />
            桥配置期望值：HTTP <code>{st.bridge?.http || '（空）'}</code>　WS <code>{st.bridge?.ws || '（空）'}</code>
            <br />
            {/* 【2026-09-16】登录态是"机器人不回复"排查的第一分叉：要扫码 / 还是桥的连接断了 */}
            QQ 登录态：
            {st.login?.ok ? (
              st.login.isLogin ? (
                <span style={{ color: 'var(--nc-success-600, #16a34a)' }}>
                  ✅ 已登录{st.login.online ? '、在线' : ''}
                  {st.login.nick ? `（${st.login.nick}${st.login.uin ? ' · ' + st.login.uin : ''}）` : ''}
                </span>
              ) : (
                <span style={{ color: 'var(--nc-danger-600)' }}>
                  ⚠️ 未登录 —— 需要去管理端首页 → NapCat WebUI 扫码
                </span>
              )
            ) : (
              <span>查不到（{st.login?.error || 'NapCat 没起来 / WebUI 不可达'}）</span>
            )}
            <br />
            {/* 【2026-09-16 强化 NapCat 连接】桥这条链路自己健康与否：连上没有、多久没下行、重连过几次 */}
            桥 → NapCat 连接：
            {conn ? (
              conn.connected ? (
                <span style={{ color: 'var(--nc-success-600, #16a34a)' }}>
                  ✅ 已连接（
                  {typeof conn.lastActivityAgoMs === 'number'
                    ? `最近一次收到下行 ${Math.max(0, Math.round(conn.lastActivityAgoMs / 1000))} 秒前`
                    : '刚连上'}
                  {conn.reconnects ? `，累计重连 ${conn.reconnects} 次` : ''}）
                </span>
              ) : (
                <span style={{ color: 'var(--nc-danger-600)' }}>
                  ⚠️ 未连接（正在按退避重连，最长 10 秒一次）
                  {typeof conn.lastActivityAgoMs === 'number'
                    ? `，已 ${Math.max(0, Math.round(conn.lastActivityAgoMs / 1000))} 秒没收到下行`
                    : ''}
                  {conn.reconnects ? `，累计重连 ${conn.reconnects} 次` : ''}
                </span>
              )
            ) : (
              <span>查不到（{(conn && conn.error) || '桥刚启动/未暴露统计'}）</span>
            )}
            {mismatch && (
              <>
                <br />
                <span style={{ color: 'var(--nc-danger-600)' }}>
                  ⚠️ 两者不一致 —— 这正是"改了令牌却没生效"的原因：桥拿着新令牌去连，NapCat 只认旧的。
                  点下面「用桥里现有的令牌写入」让两边一致，或自己填好新令牌点「写入上面填的令牌」。
                </span>
              </>
            )}
          </div>

          <div className="cfg-fields">
            <label className="field-row">
              <span className="f-label">WebUI 登录令牌（6099）</span>
              <input className="input" type={show ? 'text' : 'password'} autoComplete="new-password"
                placeholder="留空 = 不改；填了就写进 webui.json（旧令牌立即失效）"
                value={webui} onChange={(e) => setWebui(e.target.value)} />
            </label>
            <label className="field-row">
              <span className="f-label">HTTP 令牌（3000）</span>
              <input className="input" type={show ? 'text' : 'password'} autoComplete="new-password"
                placeholder="留空 = 不改；填了就写进 onebot11*.json 的 httpServers"
                value={http} onChange={(e) => setHttp(e.target.value)} />
            </label>
            <label className="field-row">
              <span className="f-label">WS 令牌（3001）</span>
              <input className="input" type={show ? 'text' : 'password'} autoComplete="new-password"
                placeholder="留空 = 不改；填了就写进 onebot11*.json 的 websocketServers"
                value={ws} onChange={(e) => setWs(e.target.value)} />
            </label>
            <label className="switch-row">
              <input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} />
              <span>写完重启 NapCat 容器（推荐）</span>
              <em>NapCat 启动时才读配置；不重启则新令牌要等下次启动才生效。重启用 <code>docker restart -t 60</code>（给 30 秒宽限，避免掉登录态）</em>
            </label>
          </div>

          <div className="lrn-actions" style={rowStyle}>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void apply(false)}>
              {busy ? <Loader2 size={14} className="spin" /> : <ShieldCheck size={14} />} 写入上面填的令牌{restart ? '并重启' : ''}
            </button>
            <button className="btn btn-soft-primary btn-sm" disabled={busy || !st?.bridge?.http}
              title="不手抄令牌：直接用桥配置里现有的 HTTP/WS 令牌去写 NapCat（WebUI 也用它），让三处一致"
              onClick={() => void apply(true)}>
              {busy ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />} 用桥里现有的令牌写入
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={() => void load()}><RefreshCw size={13} /> 刷新现状</button>
            <button className="btn btn-sm" onClick={() => setShow((v) => !v)}>
              {show ? <EyeOff size={13} /> : <Eye size={13} />} {show ? '隐藏输入' : '显示输入'}
            </button>
          </div>
          {msg && <div className="lrn-inline-note" style={{ marginTop: 6 }}>{msg}</div>}

          <div className="lrn-inline-note" style={{ display: 'block', lineHeight: 1.75, marginTop: 6 }}>
            两种用法：<b>直接在上面填</b>三个令牌（想给 WebUI / HTTP / WS 设不同值就用这个）；
            或者点 <b>用桥里现有的令牌写入</b> —— 不用手抄，直接把桥配置里那两个令牌写进 NapCat，
            并让 WebUI 也用桥的令牌，三处一次对齐（最省事，推荐先试这个）。
            令牌只允许 4~64 位的字母/数字/符号（不能有空格、引号、中文）；写入前自动备份到同目录 <code>_bak-&lt;时间&gt;</code>。
            WebUI 令牌改完后，管理端首页/服务端入口里那些 NapCat 链接会<b>自动带新令牌</b>（它们每次从服务端读 webui.json，不是写死的）。
            <br />
            <b>重启 NapCat 不会掉登录态</b>：QQ 的会话存在数据卷 <code>napcat-qq</code> 里，登录票据在
            <code>webui.json</code> 同目录的 <code>napcat_&lt;QQ&gt;.json</code>；容器起来后 NapCat 按
            <code>ACCOUNT=&lt;QQ&gt;</code> <b>自动快速登录</b>，不需要重新扫码。我们已经把重启宽限统一成
            <code>-t 60</code>（宽限太短会被硬杀）。真正会让它掉登录的只有：① 在别处登录同一个 QQ（手机/电脑）；
            ② 手动 <code>docker rm</code> 掉容器或用不同的挂载重建（数据卷没带上的话）。
          </div>
        </>
      )}
    </div>
  );
}
