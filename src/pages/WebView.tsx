import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, RefreshCw, Loader2 } from 'lucide-react';
import { getState, getNapcatWebuiReady } from '../api';

interface Props {
  url: string;
  title: string;
  onBack: () => void;
}

/** 按端口把当前地址对到实例上，取回「最新」的入口地址（带最新访问令牌）。
 *  DSH 每次重启都会换令牌，而 url 是本组件挂载时的快照 —— 必须每次现取。 */
async function freshestUrl(cur: string, fallback: string): Promise<string> {
  let port = '';
  try { port = new URL(cur, window.location.href).port; } catch { /* 忽略 */ }
  if (!port) return fallback;
  const st: any = await getState();
  const list: any[] = Array.isArray(st?.instances) ? st.instances : [];
  const byUrl = list.find((i) => { try { return new URL(i.url).port === port; } catch { return false; } });
  const byCfg = list.find((i) => String(i?.config?.port ?? '') === port);
  return (byUrl || byCfg)?.url || fallback;
}

/** 应用内打开官方界面（同页 iframe，无跳转；ESC/返回键回主界面） */
export default function WebView({ url, title, onBack }: Props) {
  const [src, setSrc] = useState(url);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const autoDone = useRef(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onBack(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onBack]);

  // ── 自动重新鉴权：挂载时对齐一次，之后每 3 秒跟一次；目标重启换了令牌就自动重挂，
  //    用户不需要点任何东西。令牌没变时不动（避免无谓重载把页面刷掉）。
  useEffect(() => {
    let alive = true;
    const sync = async (first: boolean) => {
      try {
        const next = await freshestUrl(src, url);
        if (!alive || !next || next === src) return;
        setSrc(next);
        setNonce((n) => n + 1);
        setNote('已自动换用最新令牌');
        if (first) autoDone.current = true;
      } catch { /* 管理器暂时不可达：保持现状，下个周期再试 */ }
    };
    sync(true);
    const iv = window.setInterval(() => sync(false), 3000);
    return () => { alive = false; clearInterval(iv); };
    // src 变化会重建 effect，正好让比对基准跟上下一次
  }, [src, url]);

  /* 【2026-09-22 第二次修（主人报「还鉴权失败，登录还 limit」）：别再把登录接口当轮询探针】
   * 上一版这里每 2 秒问一次 /api/napcat/webui-ready，而那个端点当时**每次都会真打一次** NapCat 的登录
   * 接口（最多 20 次）。NapCat 的登录是按 IP 限量的（每 60 秒 loginRate 次，出厂 10），页面自己那一次
   * 就被挤掉了 —— 表现就是"进去还是鉴权失败 / login rate limit"。现在：
   *   · 只问"端口通不通"（服务端不再自查令牌，零登录）；
   *   · 通了就**重载一次**（NapCat 首屏只拿 ?token= 换 Credential、自己不进入应用，所以需要这一次重载）；
   *   · 没通就每 4 秒看一次、最多 60 秒，起来后照样只重载一次；
   *   · 限流期间**不重载**（重载会让页面再登一次、白花额度），状态栏写明还有多少秒。
   * 轮询次数也砍到 15 次 × 4 秒（原来 20 次 × 2 秒），因为这里问的东西不再有"多问几次就能变好"的性质。 */
  useEffect(() => {
    let isNapcat = false;
    try { isNapcat = /^\/webui(\/|$)/.test(new URL(url, window.location.href).pathname); } catch { isNapcat = false; }
    if (!isNapcat) return;
    let alive = true;
    let reloaded = false;
    /** 只重载一次：首屏那次登录 POST 已经发生过，再刷只会多花一次额度。 */
    const reloadOnce = () => {
      if (reloaded || !alive) return false;
      reloaded = true;
      setNonce((n) => n + 1);
      return true;
    };
    /** @returns true = 还要继续等 */
    const tick = async (): Promise<boolean> => {
      let r: Awaited<ReturnType<typeof getNapcatWebuiReady>> | null = null;
      try {
        r = await getNapcatWebuiReady();
      } catch (e: any) {
        if (alive) setNote('问不到 NapCat 状态：' + String(e?.message ?? e));
        return true;
      }
      if (!alive || !r) return false;
      if (r.rateLimit?.limited) {
        setNote('NapCat 登录接口被限流中（还有 ' + Math.ceil((r.rateLimit.retryAfterMs || 0) / 1000) + ' 秒）：先不重载，免得把页面自己的登录额度也花掉');
        return false;
      }
      if (!r.serviceUp) {
        setNote(r.note || 'NapCat 还没起来：等它起来会自动重载一次');
        return true;
      }
      reloadOnce();
      setNote('NapCat 已就绪：正在自动完成鉴权…');
      return false;
    };
    void (async () => {
      if (!(await tick())) return;
      for (let i = 0; i < 15 && alive; i++) {
        await new Promise((res) => setTimeout(res, 4000));
        if (!alive) return;
        if (!(await tick())) return;
      }
      if (alive) setNote('NapCat 还没起来：起来后点右侧「重新鉴权」即可');
    })();
    return () => { alive = false; };
  }, [url]);

  /** 手动兜底：**显式**让服务端真验一次令牌（会花 NapCat 一次登录额度，所以只在用户点的时候做），
   *  同时取最新地址重开一次。服务端那边有预算与限流冷却，这里把它的账本如实显示出来。 */
  const reauth = async () => {
    if (busy) return;
    setBusy(true); setNote('');
    try {
      const ready = await getNapcatWebuiReady({ verify: true }).catch(() => null);
      const next = await freshestUrl(src, url);
      setSrc(next);
      setNonce((n) => n + 1);
      if (!ready) { setNote('取新令牌失败：管理器没响应'); return; }
      if (ready.rateLimit?.limited) {
        setNote('NapCat 登录接口被限流中（还有 ' + Math.ceil((ready.rateLimit.retryAfterMs || 0) / 1000) + ' 秒）—— 稍后再点；这不代表 QQ 掉线');
      } else if (!ready.serviceUp) {
        setNote('NapCat WebUI 还没起来：' + (ready.note || ''));
      } else if (ready.verify?.status === 'ok' || ready.verify?.status === 'cached') {
        setNote('令牌已验证通过：已用最新地址重载一次');
      } else {
        setNote('已重载一次；服务端自查结果：' + (ready.verify?.note || ready.note || '未知'));
      }
    } catch (e: any) {
      setNote('取新令牌失败：' + String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="webview">
      <div className="webview-bar">
        <button className="btn btn-sm" onClick={onBack}><ArrowLeft size={14} /> 返回</button>
        <span className="webview-title">{title}</span>
        <span style={{ flex: 1 }} />
        <code style={{ fontSize: 12 }}>{src}</code>
        <span style={{ fontSize: 12, color: 'var(--nc-foreground-500)' }}>{note || '令牌自动跟随'}</span>
        <button className="btn btn-sm btn-outline" onClick={reauth} disabled={busy}
          title="目标服务重启会换访问令牌；这里立刻取最新令牌并用新地址重开，同时实时查一次 NapCat 是否已经能登录">
          {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 重新鉴权
        </button>
        <a className="btn btn-sm btn-outline" href={src} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={14} /> 新窗口
        </a>
      </div>
      <iframe key={nonce} className="webview-frame" src={src} title={title} />
    </div>
  );
}
