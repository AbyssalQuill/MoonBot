import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, RefreshCw, Loader2 } from 'lucide-react';
import { getState, getNapcatWebuiReady } from '../api';

/** WebUI 的 origin（协议 + 主机 + 端口），不含 token。
 *  2026-09-23 修「静默鉴权后点一次按钮还会再鉴权一次」详见下文 gateKey 的注释。
 *  （原 tokenOf() 已删除：鉴权账本改按 origin 分桶后已无使用方。） */
function originOf(u: string): string {
  try { const x = new URL(u, window.location.href); return x.origin || 'default'; } catch { return 'default'; }
}

/** 「该令牌已在浏览器中完成过一次鉴权」：的记录；45 分钟过期（NapCat 的 Credential 有效期为 1 小时）。 */
const AUTH_GATE_TTL_MS = 45 * 60 * 1000;
function readAuthGate(key: string): number {
  try {
    const at = Number(localStorage.getItem(key)) || 0;
    return at && Date.now() - at < AUTH_GATE_TTL_MS ? at : 0;
  } catch { return 0; }
}
function writeAuthGate(key: string) {
  try { localStorage.setItem(key, String(Date.now())); } catch { /* 隐私模式下无法写入，则每次均重载，功能不受影响 */ }
}

interface Props {
  url: string;
  title: string;
  onBack: () => void;
}

/** 按端口将当前地址对应到实例上，取回「最新」的入口地址（携带最新访问令牌）。
 *  DSH 每次重启都会更换令牌，而 url 是本组件挂载时的快照 —— 故必须每次实时获取。 */
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

/** 在应用内打开官方界面（同页 iframe，无跳转；ESC / 返回键回到主界面） */
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

  // ── 自动重新鉴权：挂载时对齐一次，之后每 3 秒跟随一次；目标重启更换令牌后自动重挂，
  //    无需用户操作。令牌未变化时不作处理（避免无谓重载导致页面被刷新）。
  useEffect(() => {
    let alive = true;
    const sync = async (first: boolean) => {
      try {
        const next = await freshestUrl(src, url);
        if (!alive || !next || next === src) return;
        setSrc(next);
        setNonce((n) => n + 1);
        setNote('已自动切换为最新令牌');
        if (first) autoDone.current = true;
      } catch { /* 管理器暂时不可达：保持现状，下一周期重试 */ }
    };
    sync(true);
    const iv = window.setInterval(() => sync(false), 3000);
    return () => { alive = false; clearInterval(iv); };
    // src 变化会重建 effect，正好使比对基准跟随至下一次
  }, [src, url]);

  /* 2026-09-22首次自动鉴权即可，不必每次点击都鉴权一次。
   * 2026-09-23管理器不再预鉴权，职责划分为：
   *   · 后端只判断"NapCat 是否已启动"（不消耗登录额度的 HTTP 探活 /webui/），
   *     不再代页面调用登录接口（否则会占用页面自身额度，导致「首次鉴权失败」）；
   *   · 界面负责"该浏览器中该页面尚未换到 Credential"时的一次性重载。 */
  useEffect(() => {
    let isNapcat = false;
    try { isNapcat = /^\/webui(\/|$)/.test(new URL(url, window.location.href).pathname); } catch { isNapcat = false; }
    if (!isNapcat) return;
    let alive = true;
    const reloadOnce = () => { if (alive) setNonce((n) => n + 1); };

    /* 已为该 NapCat 实例重载过一次（且未过期）→ 直接载入即可进入，不再重复处理。
     * 2026-09-23 修「首次启动静默鉴权后，仍需再点一次按钮才稳定」
     * 原实现按 token 分桶（`qbm.napcatAuth.<token>`），但读取的是挂载时那份 url 快照中的 token，
     * 而写入时（下方 tick / reauth）使用的是刚取回的最新 token —— 首次启动时两者恰好不一致
     * （NapCat 刚写出令牌、或刚更换过令牌），于是 gate 查不中 → 再次重载、再消耗一次登录额度。
     * 现改用 origin（host:port） 分桶：gate 要回答的是"该浏览器是否已为该 NapCat 换过 Credential"，
     * 而 Credential 本就存于该源下的 localStorage、与 token 无关 —— origin 才是正确的主键。
     * 45 分钟 TTL 仍覆盖 Credential 的 1 小时有效期。 */
    const gateKey = 'qbm.napcatAuth.' + originOf(url);
    const gate = readAuthGate(gateKey);
    if (gate) {
      setNote('已于 ' + Math.max(0, Math.round((Date.now() - gate) / 60000)) + ' 分钟前完成鉴权；如需强制重新登录，点「重新鉴权」');
      return;
    }

    const tick = async (): Promise<boolean> => {
      let r: Awaited<ReturnType<typeof getNapcatWebuiReady>> | null = null;
      try {
        r = await getNapcatWebuiReady();
      } catch (e: any) {
        /* 2026-09-29查询失败只是"这一轮没问到"（下方每 4 秒还会重试，最多 15 次），
         * 不是结论 —— 不再写「无法查询 NapCat 状态」这种终局措辞，改为中性一行并说明会自动重试。 */
        if (alive) setNote('暂时查不到 NapCat 状态（管理器未响应），将继续自动重试：' + String(e?.message ?? e));
        return true;
      }
      if (!alive || !r) return false;
      /* 2026-09-23 去除探针与状态检测：原实现在此处依据 rateLimit.limited（"管理器自查已将额度用尽"）
       * 放弃重载。管理器现已不调用 NapCat 的登录接口，额度 100% 留给页面自身，
       * 故该分支已删除：服务连通即直接重载，由页面自行登录。 */
      if (!r.serviceUp) {
        setNote(r.note || 'NapCat 尚未启动；待其启动后将自动重载一次');
        return true;
      }
      /* 2026-09-23 修「首次启动必须手点一次『重新鉴权』才能进入」
       * 成因为一处手动可行、自动不可行的不对称：手动 reauth() 先经 freshestUrl() 取回最新令牌
       * 再重载，故一点即通；而自动路径此处只 bump nonce 重载当前 src，而挂载时那份 url 为
       * 快照 —— 首次启动时 NapCat 往往尚未写出令牌、或刚更换令牌，以旧令牌重载必然登录失败。
       * 旧代码还在重载之前即写死 auth gate（45 分钟 TTL），故失败后再无自动重试，
       * 只能手动点击一次。此处按手动路径补齐"取最新地址"这一步，并以真正载入的那个令牌记账
       * （否则下次挂载算出的 gateKey 对不上，将额外刷新一次、多消耗一次登录额度）。 */
      let fresh = src;
      try { fresh = (await freshestUrl(src, url)) || src; } catch { /* 管理器暂时不可达：沿用当前地址 */ }
      if (!alive) return false;
      if (fresh !== src) setSrc(fresh);
      writeAuthGate('qbm.napcatAuth.' + originOf(fresh));
      reloadOnce();
      setNote('NapCat 已就绪，正在载入（页面将自行完成登录）…');
      return false;
    };
    void (async () => {
      if (!(await tick())) return;
      for (let i = 0; i < 15 && alive; i++) {
        await new Promise((res) => setTimeout(res, 4000));
        if (!alive) return;
        if (!(await tick())) return;
      }
      if (alive) setNote('NapCat 尚未启动；待其启动后点右侧「重新鉴权」');
    })();
    return () => { alive = false; };
  }, [url]);

/** 手动兜底（由用户显式触发）：取最新地址（令牌随 webui.json 变更）并强制重载一次 */
/**  2026-09-23 去除探针：原实现会带 { verify: true } 要求服务端实际调用一次 NapCat 登录接 */
/**  以"验证令牌" —— 该次调用正是页面自身首次登录所需，已删除。现仅取最新地址并重载 */
/**  登录由页面自行完成；管理器不消耗任何额度。  */
  const reauth = async () => {
    if (busy) return;
    setBusy(true); setNote('');
    try {
      const ready = await getNapcatWebuiReady().catch(() => null);
      const next = await freshestUrl(src, url);
      setSrc(next);
      setNonce((n) => n + 1);
      writeAuthGate('qbm.napcatAuth.' + originOf(next));
      if (!ready) { setNote('获取新令牌失败：管理器无响应'); return; }
      if (!ready.serviceUp) {
        setNote('NapCat WebUI 尚未启动：' + (ready.note || ''));
      } else {
        setNote('已按最新令牌重载一次，页面将自行完成登录（管理器不再预先验证令牌）');
      }
    } catch (e: any) {
      setNote('获取新令牌失败：' + String(e?.message ?? e));
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
          title="目标服务重启后会更换访问令牌；此处立即取回最新令牌并以新地址重开，同时实时查询一次 NapCat 是否已可登录">
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
