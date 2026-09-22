import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, RefreshCw, Loader2 } from 'lucide-react';
import { getState } from '../api';

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
  const napcatAuthed = useRef(false);

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

  /* 【2026-09-22 主人报「NapCat 界面点进去首次鉴权失败，刷新一次才好」】
   * 机制：NapCat WebUI 认 URL 上的 `?token=`，首屏会拿它换一次 Credential 写进 localStorage ——
   * 但**首屏自己不会再进入应用**，停在"未登录 / Unauthorized"那一屏；手工按一次 F5 立即正常，
   * 说明缺的只是"用同一个地址再载入一次"。而地址没变，上面那个令牌轮询不会重挂 iframe
   * （它只在 URL 变化时 setNonce），于是首次进去必然要人手刷一次。
   * 这里对 NapCat WebUI 做一次**进来自动重新鉴权**：首屏落定后把 iframe 重挂一次，
   * 用户不需要自己刷新；重载用的还是带 token 的同一个 URL（不是别的路径），只发生一次。 */
  useEffect(() => {
    let isNapcat = false;
    try { isNapcat = /^\/webui(\/|$)/.test(new URL(url, window.location.href).pathname); } catch { isNapcat = false; }
    if (!isNapcat || napcatAuthed.current) return;
    const t = window.setTimeout(() => {
      napcatAuthed.current = true;
      setNonce((n) => n + 1);
      setNote('已自动重新鉴权一次（NapCat 首屏鉴权后需要再载入一次）');
    }, 1600);
    return () => window.clearTimeout(t);
  }, [url]);

  /** 手动兜底：即便轮询还没跑到，也能立刻换最新令牌重开 */
  const reauth = async () => {    if (busy) return;
    setBusy(true); setNote('');
    try {
      const next = await freshestUrl(src, url);
      setSrc(next);
      setNonce((n) => n + 1);
      setNote(next === src ? '令牌已是最新' : '已换用最新令牌');
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
          title="目标服务重启会换访问令牌；这里立刻取最新令牌并用新地址重开">
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
