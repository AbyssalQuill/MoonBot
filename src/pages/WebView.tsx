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

  /* 【2026-09-22 主人报「NapCat 界面点进去首次鉴权失败，刷新一次才好；不要每次点都重新弄一遍」】
   * 机制：NapCat WebUI 认 URL 上的 `?token=`，首屏会拿它换一次 Credential 写进 localStorage ——
   * 但**首屏自己不会再进入应用**，停在"未登录 / Unauthorized"那一屏；手工按一次 F5 立即正常，
   * 缺的就是"用同一个地址再载入一次"。
   * 只靠固定秒数盲刷解决不了 "它还没起来"（那时刷几次都没用），所以改成**问服务端要判据**：
   *   GET /api/napcat/webui-ready 会当场打一次 NapCat 的登录接口，返回
   *   { ok, serviceUp, tokenPresent, note } —— ok 才重载；没就绪就继续等（每 2 秒问一次，最多约 40 秒）。
   * 重载次数有上限（就绪后 2 次、等待期 2 次），不会无限刷屏；状态栏一直说明当前卡在哪一步。 */
  useEffect(() => {
    let isNapcat = false;
    try { isNapcat = /^\/webui(\/|$)/.test(new URL(url, window.location.href).pathname); } catch { isNapcat = false; }
    if (!isNapcat) return;
    let alive = true;
    let blindReloads = 0;
    let readyReloads = 0;
    const bump = () => setNonce((n) => n + 1);
    const loop = async () => {
      for (let i = 0; i < 20 && alive; i++) {
        let r: Awaited<ReturnType<typeof getNapcatWebuiReady>> | null = null;
        try {
          r = await getNapcatWebuiReady();
        } catch (e: any) {
          if (alive) setNote('问不到 NapCat 状态：' + String(e?.message ?? e));
        }
        if (!alive) return;
        if (r) {
          if (r.ok) {
            /* 就绪了：用同一个带 token 的地址再载入一次就进去了。第一次重载后隔 3 秒再补一次 ——
             * 首屏那次登录 POST 可能刚好和重载撞上，补第二下能盖住这个竞态（实测常见）。 */
            if (readyReloads === 0) {
              readyReloads = 1; bump(); setNote('NapCat 已就绪：自动完成鉴权中…');
            } else if (readyReloads === 1) {
              readyReloads = 2; bump(); setNote('已自动完成鉴权（仍提示未登录就点右侧「重新鉴权」）'); return;
            }
          } else {
            if (r.note) setNote(r.note);
            // 还没起来：先把首屏刷掉（最多 2 次），等它起来那次由上面的分支接管
            if (!r.serviceUp && blindReloads < 2) { blindReloads += 1; bump(); }
            else if (!r.serviceUp && blindReloads >= 2) return;   // 一直起不来就别再刷了，状态栏已写明原因
          }
        }
        await new Promise((res) => setTimeout(res, 2000));
      }
    };
    void loop();
    return () => { alive = false; };
  }, [url]);

  /** 手动兜底：立刻问一次服务端 + 取最新令牌重开（两个动作都给结果反馈） */
  const reauth = async () => {
    if (busy) return;
    setBusy(true); setNote('');
    try {
      const ready = await getNapcatWebuiReady().catch(() => null);
      const next = await freshestUrl(src, url);
      setSrc(next);
      setNonce((n) => n + 1);
      setNote(ready
        ? (ready.ok ? '已重新鉴权：' + ready.note : '还没就绪：' + ready.note)
        : (next === src ? '令牌已是最新' : '已换用最新令牌'));
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
