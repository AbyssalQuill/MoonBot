import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, RefreshCw, Loader2 } from 'lucide-react';
import { getState, getNapcatWebuiReady } from '../api';

/** 从带 token 的 WebUI 地址里取令牌（只用于给 localStorage 记账分桶，不做鉴权）。 */
function tokenOf(u: string): string {
  try { return new URL(u, window.location.href).searchParams.get('token') || ''; } catch { return ''; }
}

/** "这个令牌已经在浏览器里完成过一次鉴权"-的记录；45 分钟过期（NapCat 的 Credential 一小时有效）。 */
const AUTH_GATE_TTL_MS = 45 * 60 * 1000;
function readAuthGate(key: string): number {
  try {
    const at = Number(localStorage.getItem(key)) || 0;
    return at && Date.now() - at < AUTH_GATE_TTL_MS ? at : 0;
  } catch { return 0; }
}
function writeAuthGate(key: string) {
  try { localStorage.setItem(key, String(Date.now())); } catch { /* 隐私模式写不了就每次都重载，功能不受影响 */ }
}

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

  /* 【2026-09-22 第三次修（主人："首次自动鉴权就行了，不要每次点一下就鉴权一次"）】
   * 分工变了：
   *   · **后端**负责"鉴权"这件事本身 —— 连接建立、或本机 NapCat 起来时，它已经静默打过一次登录接口
   *     （见 server/index.js 的 warmNapcatWebuiOnce；同一个令牌一小时只做一次），readiness 会回 warm.done；
   *   · **界面**只负责"这个浏览器里那个页面还没换到 Credential"这一次性的重载。
   * NapCat 的首屏只拿 ?token= 换一次 Credential 写进 localStorage、自己不再进入应用，所以**第一次**必须
   * 用同一个地址再载入一次；之后就靠 localStorage 里的 Credential 直接进应用了。为了不再"点一次刷一次"，
   * 这里把"我重载过这个令牌"记在**管理器自己的 localStorage** 里（键里带 tokens/端口，45 分钟过期 ——
   * NapCat 的 Credential 一小时有效）：命中就直接载入，不重载、不鉴权、不花额度。
   * 手动「重新鉴权」按钮仍然强制走一次（那才是用户明确要的动作）。 */
  useEffect(() => {
    let isNapcat = false;
    try { isNapcat = /^\/webui(\/|$)/.test(new URL(url, window.location.href).pathname); } catch { isNapcat = false; }
    if (!isNapcat) return;
    let alive = true;
    const reloadOnce = () => { if (alive) setNonce((n) => n + 1); };

    /* 已经为这个令牌重载过一次（且没过期）→ 直接载入就进去了，别再动它。 */
    const gateKey = 'qbm.napcatAuth.' + (tokenOf(url) || 'default');
    const gate = readAuthGate(gateKey);
    if (gate) {
      setNote('已登录过（' + Math.max(0, Math.round((Date.now() - gate) / 60000)) + ' 分钟前完成鉴权）—— 需要的话点「重新鉴权」');
      return;
    }

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
      writeAuthGate(gateKey);
      reloadOnce();
      setNote(r.warm?.done ? 'NapCat 已就绪（后台已静默鉴权）：载入中…' : 'NapCat 已就绪：正在自动完成鉴权…');
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

  /** 手动兜底（用户明确点的）：**显式**让服务端真验一次令牌，并强制重载一次。
   *  服务端有预算与限流冷却，这里把它的账本如实显示出来。 */
  const reauth = async () => {
    if (busy) return;
    setBusy(true); setNote('');
    try {
      const ready = await getNapcatWebuiReady({ verify: true }).catch(() => null);
      const next = await freshestUrl(src, url);
      setSrc(next);
      setNonce((n) => n + 1);
      writeAuthGate('qbm.napcatAuth.' + (tokenOf(next) || 'default'));
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
