import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { KeyRound, RefreshCw, Loader2, AlertTriangle, ShieldCheck, Eye, EyeOff, Activity, Siren, Lock, QrCode } from 'lucide-react';
import type { NapcatGuard, NapcatQrSnapshot } from '../api';
import {
  getNapcatTokens, applyNapcatTokens, getNapcatGuard, setNapcatGuard, healNapcatGuard, getNapcatQr,
} from '../api';

/**
 * NapCat 两张卡：① 鉴权令牌（WebUI / HTTP / WS） ② 会话守护
 *
 * 【为什么令牌要单独说】管理端原来只是把令牌存在**桥的 config.json** 里（桥"期望"用哪个），
 * NapCat 自己的配置（webui.json / onebot11*.json）从来没被改过 —— 于是：
 *   · 新令牌写进去没有用，NapCat 照样收默认 truefriend（旧令牌能进 WebUI）；
 *   · 桥拿着新令牌去连 NapCat，反而是 401/连不上。
 * 令牌卡做的是"把令牌真正写进 NapCat + 重启容器 + 复验（新令牌能过、旧令牌被拒）"，
 * 顺手把桥 config.json 的期望值对齐，并把结果如实显示出来（不含任何明文令牌）。
 *
 * 【为什么拆成卡】主人反馈"掺杂到一起了"：令牌 / 会话守护本来是两件事，
 * 混在一张卡里几处标题各说各话。现在各自一张卡、各自的标题与说明、各自的底，互不掺杂；
 * 请求与功能一个字都没变（同一个 GET/POST，只是重新归位到对应的卡里）。
 * （2026-09-19 又删掉了第三张「免扫码回退登录」卡 —— 那是容器时代的产物，
 *   原生 systemd 跑法下它必然报「docker inspect 失败」，见下方组件内的说明。）
 * 三张卡的渲染条件与拆分前完全一致：令牌那份读失败时，后两张卡跟以前一样不渲染。
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

/* ================= 会话守护的小工具（纯展示逻辑，不碰网络） ================= */

/** 毫秒时间戳 → HH:mm:ss；0/非法值 = 还没探过 */
function tsToClock(ms?: number | null): string {
  const n = Number(ms);
  if (!n || !Number.isFinite(n) || n <= 0) return '还没探过';
  const d = new Date(n);
  const p2 = (v: number) => String(v).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** verdict → 文案 + 颜色。ok=绿 / suspect=黄 / dead=红；healing 由前端在"点了立即自愈"时自己显示。 */
function verdictInfo(verdict?: string): { text: string; color: string; note: string } {
  switch (String(verdict || '')) {
    case 'ok': return { text: '正常', color: 'var(--nc-success-600, #16a34a)', note: '最近一次探针通过（get_rkey 有返回）' };
    case 'suspect': return { text: '疑似异常', color: 'var(--nc-warning-500, #d97706)', note: '探针失败次数还没到阈值，再失败就会自愈' };
    case 'dead': return { text: '会话已死', color: 'var(--nc-danger-600)', note: '连续失败已达阈值 —— QQ 侧登录态多半已失效' };
    case 'healing': return { text: '自愈中', color: 'var(--nc-warning-500, #d97706)', note: '正在重启 NapCat 并等它登回来' };
    case 'disabled': return { text: '未启动', color: 'var(--nc-foreground-400)', note: '桥侧的会话守护总开关是关的（本卡只控制"自动自愈"）' };
    default: return { text: '未启动', color: 'var(--nc-foreground-400)', note: '还没探过（桥刚起来，或守护还没跑第一轮）' };
  }
}

/** 自愈结果的英文枚举 → 中文 */
function healResultText(r?: string): string {
  switch (String(r || '')) {
    case 'success': return '成功';
    case 'failed': return '失败（重启后仍探不通）';
    case 'cooldown': return '冷却中（同小时内自愈次数过多）';
    case 'giveup': return '已放弃（一小时自愈次数到上限）';
    case 'manual': return '需人工处理（要扫码／过验证，重启救不了）';
    default: return '——';
  }
}

/** 告警级别 → 中文（桥侧枚举：needs-login / failed / cooldown / giveup / manual） */
function alertLevelText(l?: string): string {
  switch (String(l || '')) {
    case 'needs-login': return 'QQ 未登录，需要人工扫码/完成验证';
    case 'failed': return '自愈失败';
    case 'cooldown': return '拒绝自愈（冷却）';
    case 'giveup': return '停止自愈（一小时次数到顶）';
    case 'manual': return '需人工处理';
    default: return '异常';
  }
}

/** needs-login：QQ 已经掉登录态（waiting_qrcode 等），**重启救不了**，必须人工扫码/过验证 */
function isNeedsLogin(a?: { level?: string } | null): boolean {
  return String(a?.level || '') === 'needs-login';
}

/** 告警横幅配色：needs-login 要比普通 failed/cooldown 更醒目（底色更深 + 加粗红边） */
function alertBoxStyle(urgent: boolean): CSSProperties {
  return {
    alignItems: 'flex-start',
    ...(urgent
      ? { background: 'var(--nc-danger-100)', border: '2px solid var(--nc-danger-500)', boxShadow: '0 2px 10px hsl(325.82 69.62% 53.53% / .18)' }
      : null),
  };
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
  /* 【2026-09-16】NapCat 会话守护：挂载时 GET 一次就够（不轮询），要新数据点「刷新现状」。 */
  const [guard, setGuard] = useState<NapcatGuard | null>(null);
  const [guardErr, setGuardErr] = useState('');
  const [guardMsg, setGuardMsg] = useState('');
  const [guardBusy, setGuardBusy] = useState(false);
  const [healing, setHealing] = useState(false);
  /* 【2026-09-19 已删除「免扫码回退登录」整张卡】它是**容器时代**的产物（把 QQ 密码算成 md5
   * 写进 docker 容器的环境变量、再重建容器来免扫码）。现在 NapCat 早就是**原生 systemd** 跑法，
   * 那套 docker inspect/重建逻辑在原生环境下必然失败 —— 主人看到的正是
   * 「docker inspect 失败（容器不存在或没权限）」，留着只会误导。
   * 原生跑法的免扫码依据是配置目录里的 napcat_<qq>.json（快速登录票据）**加稳定的设备身份**，
   * 见 qq-bridge/tools/pin-napcat-device.sh 与 start-bridge.sh 的说明。 */
  /* 【2026-09-16 补充契约】掉登录态（alert.level='needs-login'）时人必须扫码：把容器里的二维码现抓出来显示。
     不缓存（NapCat 会定期换新码），`qrFor` 记录"这份二维码是为哪条告警抓的"，避免显示上一次的旧码。 */
  const [qr, setQr] = useState<NapcatQrSnapshot | null>(null);
  const [qrErr, setQrErr] = useState('');
  const [qrBusy, setQrBusy] = useState(false);
  const [qrFor, setQrFor] = useState('');

  const fetchQr = useCallback(async (stamp: string) => {
    if (qrBusy) return;
    setQrBusy(true); setQrErr('');
    try {
      const r = await getNapcatQr();
      if (r?.ok === false || !r?.dataUrl) {
        // 桥侧明确说"暂时没有二维码"（没在等登录 / docker cp 失败）→ 不显示破图，只留一行灰字
        setQr(null);
        setQrErr(String(r?.error || '容器里暂时没有二维码（没在等登录，或 docker cp 失败）'));
      } else {
        setQr(r);
        setQrErr('');
      }
      setQrFor(stamp);
    } catch (e: any) {
      setQr(null);
      setQrErr(String(e?.message ?? e));
      setQrFor(stamp);
    } finally { setQrBusy(false); }
  }, [qrBusy]);

  const loadGuard = useCallback(async () => {
    setGuardErr('');
    try {
      const r = await getNapcatGuard();
      if (r?.ok === false) { setGuardErr(String(r.error || r.message || '桥侧会话守护不可用')); return; }
      setGuard(r?.guard ?? null);
    } catch (e: any) {
      // 桥没起来 / 桥版本较旧（这条接口还不存在）都会走到这里，如实显示，不要假装"守护正常"。
      // 【实测 2026-09-16】管理端 server/index.js 目前只代理了 /api/napcat/tokens：
      //   浏览器直连 3100 会撞跨站校验、也拿不到控制台令牌，所以这里走 /api/napcat/guard 代理；
      //   代理还没加时这里会显示 "API /napcat/guard -> HTTP 404"，此时补几条代理即可（见交付说明）。
      setGuardErr(String(e?.message ?? e));
    }
  }, []);

  const load = useCallback(async () => {
    setErr('');
    try {
      const r: any = await getNapcatTokens();
      if (r?.ok === false && r?.error) { setErr(String(r.error)); setSt(null); }
      else {
        setSt(r as NapStatus);
        // 输入框一律留空 = "不改动"，避免把掩码串（形如 ab****yz）当成真令牌写进去；要沿用桥的值就点「用桥里现有的令牌写入」
        setWebui(''); setHttp(''); setWs('');
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
    // 同一次刷新：令牌现状与会话守护一起刷新（守护那份失败不拖垮令牌那份）
    await loadGuard();
  }, [loadGuard]);

  useEffect(() => { void load(); }, [load]);

  /* 一出现"需要人工扫码"的告警就自动抓一次二维码；同一份告警只自动抓一次，
     要最新码由用户点「重新获取二维码」（NapCat 会定期换新码）。 */
  const loginQrStamp = isNeedsLogin(guard?.alert) ? String(guard?.alert?.ts || 'needs-login') : '';
  useEffect(() => {
    if (!loginQrStamp || qrFor === loginQrStamp || qrBusy) return;
    void fetchQr(loginQrStamp);
  }, [loginQrStamp, qrFor, qrBusy, fetchQr]);

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

  /** 自动自愈开关：POST 后以桥返回的那份 guard 为准，并顺手重读一次登录态 */
  const toggleAutoHeal = async (next: boolean) => {
    if (guardBusy) return;
    setGuardBusy(true); setGuardMsg(next ? '正在开启自动自愈…' : '正在关闭自动自愈…');
    try {
      const r = await setNapcatGuard({ autoHeal: next });
      if (r?.ok === false) { setGuardMsg(`失败：${r.error || r.message || '未知错误'}`); return; }
      if (r?.guard) setGuard(r.guard);
      setGuardMsg(`已${next ? '开启' : '关闭'}自动自愈（探针失败达阈值时${next ? '自动重启 NapCat' : '不再自动重启'}）`);
      void loadGuard();
    } catch (e: any) {
      setGuardMsg(`失败：${e?.message ?? e}`);
    } finally { setGuardBusy(false); }
  };

  /** 立即自愈：POST /napcat/guard/heal —— 后台要重启容器再等登录，通常一两分钟 */
  const healNow = async () => {
    if (guardBusy || healing) return;
    const ok = window.confirm(
      '立即自愈会重启 NapCat 容器（docker restart -t 60），并等它重新登上 QQ。\n\n'
      + '· 过程里 NapCat 会短暂不可用（约 20~60 秒，探活成功才返回，最长可能等到两分钟）\n'
      + '· 登录态在数据卷里，不会因此丢失；只有「QQ 被别处登录 / 容器没带挂载重建」才会掉\n'
      + '· 成功后本卡会刷新；失败时桥会把二维码导出到 state/napcat-qr.png 并在下面显示红条',
    );
    if (!ok) return;
    setHealing(true); setGuardMsg('正在自愈：重启 NapCat 容器并等待登录…（约 20~60 秒，别关这个页面）');
    try {
      const r = await healNapcatGuard();
      if (r?.ok === false) { setGuardMsg(`失败：${r.error || r.message || '未知错误'}`); }
      else {
        const waited = Math.max(0, Math.round(Number(r?.waitedMs ?? 0) / 1000));
        setGuardMsg(`${r?.healed ? '自愈成功' : '自愈未恢复'}：${r?.detail || '——'}${waited ? `（耗时 ${waited}s）` : ''}`);
      }
      if (r?.guard) setGuard(r.guard);
      await loadGuard();
      await load();
    } catch (e: any) {
      setGuardMsg(`失败：${e?.message ?? e}`);
    } finally { setHealing(false); }
  };

  const mismatch = Boolean(st?.mismatch?.http || st?.mismatch?.ws);
  // 【2026-09-16】连接诊断用 any 取一层：TS 在 `st.connection ? … : (access .error)` 的 else 分支里
  // 会把类型收窄成 never（可选属性访问报 TS2339），这里明确放宽，避免构建被卡。
  const conn: any = st?.connection;
  const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const };

  /* ===== 会话守护的展示态（都在渲染里算，避免多存一份可能过期的 state） ===== */
  const vi = verdictInfo(healing ? 'healing' : guard?.verdict);
  const healthDetail = guard?.lastProbeDetail ? String(guard.lastProbeDetail) : '（桥侧没写探针细节）';
  const healCount = Array.isArray(guard?.heals) ? guard.heals.length : 0;
  const containerDown = Boolean(guard?.container?.status && guard.container.status !== 'running');
  const needsLogin = isNeedsLogin(guard?.alert);

  return (
    /* 两张卡各自独立成块（card-stack = 页面既有的竖排叠卡容器），不再共用一张卡的底 */
    <div className="card-stack">
      {/* ============ 卡 1/2：NapCat 鉴权令牌（WebUI / HTTP / WS） ============
          只放令牌：现状展示 → 填入/对齐 → 写入并重启。会话守护不在这一张卡里。 */}
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

      {!err && st && (
        <>
          {/* ============ 卡 2/2：NapCat 会话守护 ============
              桥侧每 60 秒 get_rkey 探活，连续失败自动重启容器。
              为什么要在管理端露出来：QQ 把登录态作废时 NapCat 可能**一条错都不报**，
              WebUI 上 isLogin/online 还是 true，消息却发不出去 —— 当天静默了 50 分钟没人发现。
              这张卡只放守护自己的东西：状态机 / 探针 / 自愈次数与开关 / 立即自愈 / 二维码。 */}
          <div className="card">
            <div className="card-title">
              <Activity size={17} /> NapCat 会话守护
              <span className="lrn-updated">每 {Math.max(1, Math.round(Number(guard?.probeIntervalMs ?? 60000) / 1000))} 秒用 get_rkey 探活，连续失败自动重启容器</span>
            </div>

            {guardErr ? (
              <div className="lrn-error">
                <AlertTriangle size={15} />
                <div style={{ flex: 1 }}>会话守护不可用：{guardErr}</div>
                <button className="btn btn-sm" disabled={guardBusy} onClick={() => void loadGuard()}><RefreshCw size={13} /> 重试</button>
              </div>
            ) : !guard ? (
              <div className="lrn-inline-note"><Loader2 size={13} className="spin" /> 正在读取会话守护状态…</div>
            ) : (
              <>
                <div className="lrn-inline-note" style={{ display: 'block', lineHeight: 1.75 }}>
                  会话健康：
                  <span style={{ color: vi.color, fontWeight: 700 }}>{vi.text}</span>
                  <span style={{ color: 'var(--nc-foreground-400)' }}>（{vi.note}）</span>
                  {/* 桥侧 verdict 还有 disabled / unknown 两种；容器本身的状态单列一行更直观 */}
                  {containerDown && (
                    <span style={{ color: 'var(--nc-danger-600)' }}>
                      　· 容器 {guard?.container?.name || 'napcat'} 当前是 {guard?.container?.status}，先去首页确认 NapCat 起没起来
                    </span>
                  )}
                  <br />
                  最近探针：{tsToClock(guard?.lastProbeAt)}
                  {guard?.lastProbeAt ? <span style={{ color: 'var(--nc-foreground-400)' }}>{guard?.lastProbeOk ? ' ✅ 通过' : ' ⚠️ 失败'}</span> : null}
                  　结果：<code>{healthDetail}</code>
                  　连续失败：{Number(guard?.consecutiveFails ?? 0)} / {Number(guard?.failThreshold ?? 0)} 次
                  <br />
                  自愈：累计 <b>{healCount}</b> 次
                  （桥侧只留最近 20 条记录）
                  　最近一次：{tsToClock(guard?.lastHealAt)}　结果：{healResultText(guard?.lastHealResult)}
                </div>

                {/* 有 alert 时红条显著提示，并显示 reason 原文。
                    level='needs-login'（QQ 已掉登录态、重启救不了）用更重的配色，并把二维码直接摆出来给人扫。 */}
                {guard?.alert && (
                  <div className="lrn-error" style={alertBoxStyle(needsLogin)}>
                    <Siren size={needsLogin ? 17 : 15} />
                    <div style={{ flex: 1, lineHeight: 1.7 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                        <b style={{ fontSize: needsLogin ? 14 : undefined }}>
                          会话守护告警 · {alertLevelText(guard.alert.level)}
                        </b>
                        <span className="lrn-updated" style={{ marginLeft: 0 }}>{guard.alert.ts || ''}</span>
                      </div>
                      <div style={{ marginTop: 2 }}>{guard.alert.reason || '（桥侧没有给出原因）'}</div>

                      {needsLogin && (
                        <div style={{ marginTop: 4, fontWeight: 700 }}>
                          QQ 未登录，需要扫码/完成验证 —— 光靠自动自愈救不回来（重启只会把验证流程打断，再重启也没用）。
                        </div>
                      )}

                      {(needsLogin || guard.alert.qrPath) && (
                        <div style={{ marginTop: 2, color: 'var(--nc-foreground-500)' }}>
                          <Lock size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                          {needsLogin
                            ? '用手机 QQ 扫下面的码即可恢复登录。'
                            : '需要重新扫码才能登录。'}
                          二维码文件在 <code>{guard.alert.qrPath || qr?.path || '（桥还没导出）'}</code>
                          （NapCat WebUI 里也能看到）。
                        </div>
                      )}

                      {/* ===== 二维码本体：needs-login 时自动抓一次，可手动重取（NapCat 会定期换新码） ===== */}
                      {needsLogin && (
                        <div style={{ marginTop: 10 }}>
                          {qrBusy && !qr?.dataUrl && (
                            <div className="lrn-inline-note" style={{ marginTop: 0 }}>
                              <Loader2 size={13} className="spin" /> 正在从 NapCat 容器里取二维码…
                            </div>
                          )}
                          {qr?.dataUrl && (
                            <>
                              <img
                                src={qr.dataUrl}
                                alt="NapCat 登录二维码：用手机 QQ 扫码恢复登录"
                                style={{
                                  display: 'block', margin: '0 auto', maxWidth: '100%', width: 240,
                                  height: 'auto', background: '#fff', padding: 8, borderRadius: 10,
                                  border: '1px solid var(--nc-divider)',
                                }}
                              />
                              <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--nc-foreground-400)', marginTop: 4 }}>
                                二维码会过期，扫不出来就点「重新获取二维码」
                                {qr?.path ? <>　文件：<code>{qr.path}</code>{typeof qr.bytes === 'number' ? `（${qr.bytes} 字节）` : ''}</> : null}
                              </div>
                            </>
                          )}
                          {qrErr && (
                            <div style={{ fontSize: 12, color: 'var(--nc-foreground-400)', marginTop: 2 }}>
                              暂时没有可扫的二维码：{qrErr}
                              （通常说明 NapCat 这会儿没在等登录，或容器刚重建还没来得及出码；稍后再点一次「重新获取二维码」）
                            </div>
                          )}
                          <div className="lrn-actions" style={{ marginTop: 8 }}>
                            <button className="btn btn-sm" disabled={qrBusy}
                              onClick={() => void fetchQr(loginQrStamp || 'manual')}>
                              {qrBusy ? <Loader2 size={13} className="spin" /> : <QrCode size={13} />} 重新获取二维码
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div className="cfg-fields" style={{ marginTop: 8 }}>
                  <label className="switch-row">
                    <input type="checkbox" checked={guard?.autoHeal === true} disabled={guardBusy || healing}
                      onChange={(e) => void toggleAutoHeal(e.target.checked)} />
                    <span>自动自愈</span>
                    <em>
                      探针连续失败 {Number(guard?.failThreshold ?? 0)} 次（约 {Math.max(1, Math.round(Number(guard?.failThreshold ?? 0) * Number(guard?.probeIntervalMs ?? 60000) / 60000))} 分钟）就重启 NapCat 容器自愈。
                      关掉后只报警不动手（上面那行状态照常更新）。
                      {guard?.autoHealSource === 'manual' ? '（当前是手动设定值）' : '（当前跟随桥配置）'}
                    </em>
                  </label>
                </div>

                <div className="lrn-actions" style={rowStyle}>
                  <button className="btn btn-primary btn-sm" disabled={guardBusy || healing} onClick={() => void healNow()}>
                    {healing ? <Loader2 size={14} className="spin" /> : <Siren size={14} />} {healing ? '自愈进行中…' : '立即自愈'}
                  </button>
                  <button className="btn btn-sm" disabled={guardBusy || healing} onClick={() => void loadGuard()}>
                    <RefreshCw size={13} /> 刷新守护状态
                  </button>
                </div>
                {guardMsg && <div className="lrn-inline-note" style={{ marginTop: 6 }}>{guardMsg}</div>}
              </>
            )}
          </div>

        </>
      )}
    </div>
  );
}
