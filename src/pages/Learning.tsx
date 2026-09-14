import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import NumInput from '../components/NumInput';
import {
  getLearningConfig, saveLearningConfig, slangAction, personaAction, portraitAction, getTokenReport, getSlangLibrary, getPersonProfile,
} from '../api';
import {
  ArrowLeft, Save, Play, Square, RefreshCw, Loader2, AlertTriangle,
  Activity, TrendingUp, Users, Clock3, Zap, BarChart3, Wallet, RotateCcw, BookOpen,
} from 'lucide-react';

interface Props { onBack: () => void; }

/* ---------- 通用容错工具（桥侧字段缺失/类型飘忽一律给默认值，不崩页） ---------- */
const isObj = (v: any): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: any): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const pick = (...ks: string[]) => (o: any): string => {
  if (!isObj(o)) return '';
  for (const k of ks) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
};
/** manager 失败信封（success:false/桥 ok:false）→ 错误文本；无错误返回 '' */const firstErr = (r: any): string => {
  if (isObj(r) && (r.success === false || r.ok === false)) {
    return pick('error', 'message', 'detail')(r) || '请求失败';
  }
  return '';
};
/** 兼容桥侧 { ok, result:{...} } 与直接对象两种回包 */
const unwrap = (r: any): any => (isObj(r?.result) ? r.result : isObj(r) ? r : {});
const bjClock = (ms: number): string =>
  new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/\//g, '-');
/** 紧凑计数：万 → W，到百万级切 M（例：14.7W / 1.25M / 12.5M） */
const fmtTok = (n: number): string => {
  const a = Math.abs(n);
  if (!Number.isFinite(n)) return '0';
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${(n / 1e4).toFixed(a >= 1e5 ? 1 : 2)}W`;
  return String(Math.round(n));
};
const fmtFull = (n: number): string => Math.round(n).toLocaleString('zh-CN');
/** 数值标注防裁切：贴近画布左右边界时改用 start/end 锚点，并把锚点夹回画布内。
 *  曲线最后一个节点、柱状图最右一根的柱顶数字都靠它保证不被裁掉。 */
function anchorInside(cx: number, text: string, pxPerChar: number, W: number): { x: number; anchor: 'start' | 'middle' | 'end' } {
  let w = 2;
  for (const ch of text) w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? pxPerChar * 1.75 : pxPerChar;
  if (cx + w / 2 > W - 2) return { x: Math.min(cx + w / 2, W - 2), anchor: 'end' };
  if (cx - w / 2 < 2) return { x: Math.max(cx - w / 2, 2), anchor: 'start' };
  return { x: cx, anchor: 'middle' };
}
const niceMax = (v: number): number => {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
};
const qqListOf = (t: string): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of String(t ?? '').split(/[\s,，、;；]+/)) {
    const q = s.trim();
    if (/^\d+$/.test(q) && !seen.has(q)) { seen.add(q); out.push(q); }
  }
  return out;
};

/* ---------- 状态模型（容错归一） ---------- */
interface DayStat { date: string; label: string; real: number; est: number; cacheRead: number; }
interface HourStat {
  hour: number; real: number; est: number;
  prompt: number; cacheRead: number; completion: number;
  /** 仅 cacheRead>0 的请求参与统计的「实测子集」——命中率只用它，保证是真实值 */
  cachePrompt: number; cacheCompletion: number; cacheSamples: number;
}
interface PItem {
  uid: string; state: string; learnedAtMs: number; samples: number;
  nickname: string; preview: string;
}

function normDays(dates: any[] | undefined): DayStat[] {
  if (!Array.isArray(dates)) return [];
  return dates.map((d: any, i: number): DayStat => {
    const date = String(isObj(d) ? pick('date')(d) : '');
    // 真实用量 = 未命中输入 + 缓存命中输入 + 输出。
    // 旧实现取了 total_tokens（提供方给的**会话累计快照**），逐条累加会把同一个上下文重复计数，
    // 曲线因此虚高一个量级——这里改用三项相加的真实计费量。
    const prompt = isObj(d) ? num(d.prompt) : 0;
    const completion = isObj(d) ? num(d.completion) : 0;
    const cacheRead = isObj(d) ? num(d.cacheRead) : 0;
    const sum = prompt + completion + cacheRead;
    return {
      date,
      label: date ? date.slice(5) : `第${i + 1}天`,
      real: sum > 0 ? sum : (isObj(d) ? num(d.total) : 0),
      est: isObj(d) ? num(d.estTotal) : 0,
      cacheRead,
    };
  });
}
function normHours(hours: any[] | undefined): HourStat[] {
  if (!Array.isArray(hours)) return [];
  const blank = (idx: number): HourStat => ({
    hour: idx, real: 0, est: 0, prompt: 0, cacheRead: 0, completion: 0,
    cachePrompt: 0, cacheCompletion: 0, cacheSamples: 0,
  });
  return hours.map((it: any, idx: number): HourStat => {
    if (typeof it === 'number') return { ...blank(idx), est: it };
    if (!isObj(it)) return blank(idx);
    const prompt = num(it.prompt);
    const completion = num(it.completion);
    const cacheRead = num(it.cacheRead);
    const sum = prompt + completion + cacheRead;
    return {
      hour: num(it.hour ?? it.h ?? idx),
      real: sum > 0 ? sum : num(it.total),
      est: num(it.estTotal),
      prompt, cacheRead, completion,
      cachePrompt: num(it.cachePrompt),
      cacheCompletion: num(it.cacheCompletion),
      cacheSamples: num(it.cacheSamples),
    };
  });
}
function normStatus(r: any): PItem[] {
  const res = unwrap(r);
  const arr = Array.isArray(res?.status) ? res.status : Array.isArray(r?.status) ? r.status : [];
  if (!Array.isArray(arr)) return [];
  return arr.map((it: any): PItem => ({
    uid: String(isObj(it) ? (it.uid ?? it.qq ?? it.target ?? '?') : it),
    state: String(isObj(it) ? (it.state ?? 'idle') : 'idle'),
    learnedAtMs: isObj(it) ? num(it.learnedAtMs) : 0,
    samples: isObj(it) ? num(it.samples) : 0,
    nickname: String(isObj(it) ? (it.nickname ?? '') : ''),
    preview: String(isObj(it) ? (it.personalityPreview ?? it.preview ?? '') : ''),
  }));
}

/** HH:MM 时间输入归一化。
 *  踩过的坑：中文输入法下打 ":" 常常出的是**全角「：」**（以及全角数字），
 *  原来的过滤 `[^0-9:]` 会把它直接吃掉 → 表现为"这个框输不了冒号"。这里先把全角转半角再过滤。 */
const normHHMM = (raw: any): string => String(raw ?? '')
  .replace(/[：]/g, ':')
  .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/[^0-9:]/g, '')
  .replace(/:{2,}/g, ':')
  .slice(0, 5);

/* ================================================================== */
export default function Learning({ onBack }: Props) {
  const [cfg, setCfg] = useState<any>(null);
  const [loadErr, setLoadErr] = useState<string>('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // 表单草稿（与 cfg 分离，避免 typing 直接改源对象）
  const [slgEnabled, setSlgEnabled] = useState(true);
  const [slgTime, setSlgTime] = useState('00:00');
  const [slgLiveWin, setSlgLiveWin] = useState(false);
  const [slgResearch, setSlgResearch] = useState(true);
  const [slgIntv, setSlgIntv] = useState(false);      // v2：黑话自动间隔学习
  const [slgIntvHours, setSlgIntvHours] = useState(24);
  const [perEnabled, setPerEnabled] = useState(true);
  const [perIntv, setPerIntv] = useState(false);      // v2：人格自动间隔学习
  const [perIntvHours, setPerIntvHours] = useState(24);
  const [perTime, setPerTime] = useState('');          // 人格学习：每日定时（北京时，留空=不定时）
  const [qqText, setQqText] = useState('');

  // 人格学习状态
  const [pStatus, setPStatus] = useState<PItem[]>([]);
  const [statusAt, setStatusAt] = useState<string>('');
  const [statusErr, setStatusErr] = useState<string>('');
  // 展开某人时按需取「完整资料」（直读桥的 memory.db，**不截断**；图谱接口会截断，所以不能用它）
  const [openUid, setOpenUid] = useState<string>('');
  const [profDetail, setProfDetail] = useState<Record<string, any>>({});
  const [profErr, setProfErr] = useState<Record<string, string>>({});
  const [profBusy, setProfBusy] = useState<string>('');

  const openProfile = async (uid: string) => {
    if (openUid === uid) { setOpenUid(''); return; }
    setOpenUid(uid);
    // 展开后把这条滚进可视区（列表本身是滚动的，避免"最后一个人的资料看着像被截断"）
    setTimeout(() => { try { document.getElementById(`lrn-row-${uid}`)?.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ } }, 80);
    if (profDetail[uid]) return;                       // 已缓存：直接展开
    setProfBusy(uid);
    try {
      const r: any = await getPersonProfile(uid);
      const d = (r && r.ok === false) ? null : (r?.profile !== undefined ? r : (r?.result ?? r));
      if (r && r.ok === false) setProfErr((m) => ({ ...m, [uid]: String(r?.error || '读取失败') }));
      else setProfErr((m) => { const n = { ...m }; delete n[uid]; return n; });
      setProfDetail((m) => ({ ...m, [uid]: d }));
    } catch (e: any) {
      setProfErr((m) => ({ ...m, [uid]: String(e?.message ?? e) }));
    } finally { setProfBusy(''); }
  };
  // 黑话库弹窗
  const [slangOpen, setSlangOpen] = useState(false);
  const [slangEntries, setSlangEntries] = useState<any[]>([]);
  const [slangErr, setSlangErr] = useState('');
  const [slangQ, setSlangQ] = useState('');

  const openSlangLib = async () => {
    setSlangOpen(true); setSlangErr('');
    if (slangEntries.length) { void loadSlangLib(true); return; }
    await loadSlangLib();
  };
  const loadSlangLib = async (quiet = false) => {
    try {
      const r: any = await getSlangLibrary();
      const list: any[] = Array.isArray(r?.entries) ? r.entries
        : (Array.isArray(r?.result?.entries) ? r.result.entries : (Array.isArray(r?.data?.entries) ? r.data.entries : []));
      setSlangEntries(list);
      setSlangErr('');
    } catch (e: any) {
      if (!quiet) setSlangErr(String(e?.message ?? e));
    }
  };

  const qqs = qqListOf(qqText);
/** 间隔小时数钳制到 1~720（合法输入），非法回退 24 */
const clampHrs = (v: any): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 24;
  return Math.min(720, Math.max(1, n));
};

  const loadConfig = async () => {
    try {
      const r = await getLearningConfig();
      const e = firstErr(r);
      if (e) { setLoadErr(e); setCfg(null); return; }
      const c = isObj(r.config) ? r.config : r; // 兼容 {config:{...}} 与直接配置对象
      setCfg(c);
      setLoadErr('');
      const s = isObj(c?.slang) ? c.slang : {};
      const p = isObj(c?.persona) ? c.persona : {};
      setSlgEnabled(s.enabled !== false);
      setSlgTime(String(s.timeHHMM ?? '00:00'));
      setSlgLiveWin(s.liveWindowExtract === true);
      setSlgResearch(s.autoResearch !== false);
      setSlgIntv(s.autoIntervalEnabled === true);
      setSlgIntvHours(clampHrs(s.autoIntervalHours));
      setPerEnabled(p.enabled !== false);
      setPerIntv(p.autoIntervalEnabled === true);
      setPerIntvHours(clampHrs(p.autoIntervalHours));
      setPerTime(String(p.timeHHMM ?? ''));
      setQqText(Array.isArray(p.targetQQ) ? p.targetQQ.join('\n') : '');
    } catch (err: any) {
      setLoadErr(String(err?.message ?? err)); setCfg(null);
    }
  };

  const refreshStatus = async (quiet = false) => {
    try {
      const r = await personaAction('status');
      const e = firstErr(r);
      if (e) { if (!quiet) setStatusErr(e); return; } // 静默轮询失败不打扰（保留已展示内容）
      setPStatus(normStatus(r));
      setStatusErr('');
      setStatusAt(bjClock(Date.now()));
    } catch (err: any) {
      if (!quiet) setStatusErr(String(err?.message ?? err));
    }
  };

  // 进页拉一次配置与人格状态；状态区只读，无手动刷新按钮 → 60 秒静默轮询
  useEffect(() => {
    loadConfig(); refreshStatus();
    const iv = setInterval(() => refreshStatus(true), 60000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doBusy = (key: string, fn: () => Promise<void>) => async () => {
    if (busy) return;
    setBusy(key); setMsg(null);
    try { await fn(); } finally { setBusy(null); }
  };

  const save = doBusy('save', async () => {
    // ⚠️ 只提交**可编辑**字段：桥侧 PUT 有白名单，`slang.lastLearnAtMs` / `persona.lastRunAtMs` /
    //    `portrait.*` 由模块自己维护，整包回传会被 400 拒绝（"slang 不支持字段：lastLearnAtMs"就是这么来的）。
    const body: any = {
      slang: {
        enabled: slgEnabled,
        timeHHMM: normHHMM(slgTime) || '00:00',
        autoResearch: slgResearch,
        liveWindowExtract: slgLiveWin,
        autoIntervalEnabled: slgIntv,
        autoIntervalHours: clampHrs(slgIntvHours),
      },
      persona: {
        enabled: perEnabled,
        targetQQ: qqs,
        autoIntervalEnabled: perIntv,
        autoIntervalHours: clampHrs(perIntvHours),
        timeHHMM: normHHMM(perTime),      // 每日定时（留空=不定时）
      },
    };
    const r = await saveLearningConfig(body);
    const e = firstErr(r);
    if (e) { setMsg(`保存失败：${e}`); return; }
    setMsg('学习配置已保存'); await loadConfig(); await refreshStatus(true);
  });

  const learnSlang = doBusy('slang', async () => {
    const r = await slangAction('learn');
    const e = firstErr(r);
    if (e) { setMsg(`失败：${e}`); return; }
    const res = unwrap(r);
    const text = pick('message', 'msg', 'detail')(res) || pick('message', 'msg', 'detail')(r);
    setMsg(text ? `黑话学习：${text}` : '已受理「黑话立即学习」：从上次学习点/今日 0 点起提取并研究，完成后置学习标记');
    await refreshStatus(true);
  });

  const stopSlang = doBusy('slang-stop', async () => {
    const r = await slangAction('stop');
    const e = firstErr(r);
    if (e) { setMsg(`失败：${e}`); return; }
    const res = unwrap(r);
    const text = pick('message', 'msg', 'detail')(res) || pick('message', 'msg', 'detail')(r);
    setMsg(text ? `黑话学习：${text}` : '已请求停止进行中的黑话学习/研究任务');
  });

  const startPersona = doBusy('persona', async () => {
    const r = await personaAction('start', qqs.length ? qqs : undefined);
    const e = firstErr(r);
    if (e) { setMsg(`学习启动失败：${e}`); return; }
    const res = unwrap(r);
    if (res?.disabled) { setMsg('人格学习未启动：配置中「人格学习」已停用，请先打开开关'); return; }
    const started = Array.isArray(res?.started) ? res.started.map(String) : [];
    if (started.length) setMsg(`已受理人格学习：${started.join('、')}（后台串行进行）`);
    else if (qqs.length) setMsg('未受理新任务：目标可能已在学习中，或 DSH 会话未就绪');
    else setMsg('未受理：请先在下方填写目标 QQ（每行一个，或逗号分隔）');
    await refreshStatus(true);
  });

  const stopPersona = doBusy('persona-stop', async () => {
    const r = await personaAction('stop');
    const e = firstErr(r);
    if (e) { setMsg(`失败：${e}`); return; }
    const res = unwrap(r);
    const stopped = Array.isArray(res?.stopped) ? res.stopped.map(String) : [];
    setMsg(stopped.length ? `已请求停止 ${stopped.join('、')} 的学习（本轮结束后收尾，不写半成品）` : '当前没有进行中的人格学习');
    await refreshStatus(true);
  });

  const lastLearnAt = isObj(cfg?.slang) ? num(cfg.slang.lastLearnAtMs) : 0;

  return (
    <div className="page cute-ui">
      <div className="page-header">
        <div className="page-header-left">
          <button className="btn btn-sm" onClick={onBack}><ArrowLeft size={15} /> 返回</button>
          <div className="page-title-wrap">
            <div className="page-title" style={{ color: 'var(--nc-primary-500)' }}>MoonBot · 学习与用量</div>
            <div className="page-subtitle">黑话 / 人格学习 · Token 用量统计（作用于当前活动桥接）</div>
          </div>
        </div>
        <div className="page-actions">
          <span className="connection-bar" title="学习配置与用量 API 由管理端代理到当前活动实例（远端隧道优先，其次本机 3100）">
            <Zap size={13} /> 目标：当前活动实例
          </span>
        </div>
      </div>

      <div className="page-body">
        <div className="lrn-body">
          {msg && <div className="notice-bar" onClick={() => setMsg(null)}>{msg}</div>}

          <div className="lrn-grid">
            {/* ============ 左：学习配置与操作 ============ */}
            <div className="card">
              <div className="card-title"><Activity size={17} /> 黑话 / 人格学习</div>
              {loadErr ? (
                <div className="lrn-error">
                  <AlertTriangle size={15} />
                  <div style={{ flex: 1 }}>{loadErr}<div className="lrn-error-detail">学习接口来自桥侧新版本：请先更新并启动桥接（本地或远端），且该桥需支持 /api/learning-config 等学习 API。</div></div>
                  <button className="btn btn-sm btn-danger" disabled={busy !== null} onClick={() => { setLoadErr(''); loadConfig(); }}>
                    <RefreshCw size={13} /> 重试
                  </button>
                </div>
              ) : (
                <>
                  {/* 黑话定时学习 */}
                  <div className="lrn-block">
                    <div className="lrn-block-title">黑话定时学习</div>
                    <div className="cfg-fields">
                      <label className="switch-row">
                        <input type="checkbox" checked={slgEnabled} onChange={(e) => setSlgEnabled(e.target.checked)} />
                        <span>启用定时学习</span>
                        <em>每天按下方时间自动学习一次群聊黑话</em>
                      </label>
                      <label className="field-row">
                        <span className="f-label">定时时间（北京时）</span>
                        <input className="input" type="text" inputMode="numeric" placeholder="如 04:00（留空=不定时）"
                          value={slgTime} onChange={(e) => setSlgTime(normHHMM(e.target.value))} />
                      </label>
                      <label className="switch-row">
                        <input type="checkbox" checked={slgLiveWin} onChange={(e) => setSlgLiveWin(e.target.checked)} />
                        <span>实时窗口提取</span>
                        <em>开启 = 消息到达时实时提取唤醒（更费额度）；关闭 = 仅定时批量学习</em>
                      </label>
                      <label className="switch-row">
                        <input type="checkbox" checked={slgResearch} onChange={(e) => setSlgResearch(e.target.checked)} />
                        <span>自动深入研究</span>
                        <em>提取到新词后自动跑一轮深度研究</em>
                      </label>
                      <label className="switch-row">
                        <input type="checkbox" checked={slgIntv} onChange={(e) => setSlgIntv(e.target.checked)} />
                        <span>自动间隔学习</span>
                        <em>按固定间隔增量学习一次（从上次学习点起），与每日定时可并存</em>
                      </label>
                      <label className="field-row">
                        <span className="f-label">间隔（小时）</span>
                        <NumInput className="input" value={slgIntvHours} onCommit={(n) => setSlgIntvHours(clampHrs(n || 24))} />
                      </label>
                    </div>
                    <div className="lrn-inline-note">
                      {lastLearnAt > 0
                        ? <><Clock3 size={13} /> 上次自动学习：{bjClock(lastLearnAt)}</>
                        : <><Clock3 size={13} /> 尚未执行过定时学习</>}
                    </div>
                    <div className="lrn-actions">
                      <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={save}>
                        {busy === 'save' ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 保存配置
                      </button>
                      <button className="btn btn-soft-primary btn-sm" disabled={busy !== null} onClick={learnSlang}>
                        {busy === 'slang' ? <Loader2 size={14} className="spin" /> : <Play size={14} />} 黑话立即学习
                      </button>
                      <button className="btn btn-outline-danger btn-sm" disabled={busy !== null} onClick={stopSlang}>
                        {busy === 'slang-stop' ? <Loader2 size={14} className="spin" /> : <Square size={14} />} 停止学习
                      </button>
                      <button className="btn btn-sm" onClick={openSlangLib} title="看已经学到的黑话词条（含含义/使用例/出现次数）">
                        <BookOpen size={14} /> 黑话库{slangEntries.length ? `（${slangEntries.length}）` : ''}
                      </button>
                    </div>
                  </div>

                  <div className="lrn-divider" />

                  {/* 人格学习 */}
                  <div className="lrn-block">
                    <div className="lrn-block-title">人格学习（学习某个 QQ 的语言风格 / 性格）</div>
                    <div className="cfg-fields">
                      <label className="switch-row">
                        <input type="checkbox" checked={perEnabled} onChange={(e) => setPerEnabled(e.target.checked)} />
                        <span>启用人格学习</span>
                        <em>关闭后桥侧会拒绝人格学习请求</em>
                      </label>
                      <label className="switch-row">
                        <input type="checkbox" checked={perIntv} onChange={(e) => setPerIntv(e.target.checked)} />
                        <span>自动间隔学习</span>
                        <em>按间隔对下方目标全量重学；窗口自上次学习起（未跑过则近 30 天）</em>
                      </label>
                      <label className="field-row">
                        <span className="f-label">间隔（小时）</span>
                        <NumInput className="input" value={perIntvHours} onCommit={(n) => setPerIntvHours(clampHrs(n || 24))} />
                      </label>
                      <label className="field-row">
                        <span className="f-label">每日定时（北京时）</span>
                        <input className="input" type="text" inputMode="numeric" placeholder="如 04:00（留空=不定时）"
                          value={perTime} onChange={(e) => setPerTime(normHHMM(e.target.value))} />
                      </label>
                    </div>
                    <div className="field-row full" style={{ marginTop: 8 }}>
                      <span className="f-label">目标 QQ（多填：每行一个，也支持逗号分隔）</span>
                      <textarea className="textarea" rows={Math.max(2, Math.min(5, qqs.length + 1))}
                        value={qqText} placeholder={'例如: 10001\n或: 123456789, 987654321'}
                        onChange={(e) => setQqText(e.target.value)} />
                    </div>
                    <div className="lrn-actions">
                      <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={save}>
                        {busy === 'save' ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 保存配置
                      </button>
                      <button className="btn btn-soft-primary btn-sm" disabled={busy !== null} onClick={startPersona}>
                        {busy === 'persona' ? <Loader2 size={14} className="spin" /> : <Play size={14} />} 人格立即学习
                      </button>
                      <button className="btn btn-outline-danger btn-sm" disabled={busy !== null} onClick={stopPersona}>
                        {busy === 'persona-stop' ? <Loader2 size={14} className="spin" /> : <Square size={14} />} 停止学习
                      </button>
                    </div>
                  </div>

                  {/* 群友画像学习：目标自动从聊天记录里筛，落回 profiles 表 → 群友画像页立刻可见 */}
                  <PortraitLearnBlock />
                </>
              )}
            </div>

            {/* ============ 右：人格学习状态（与左卡片等高；超出滚动；点开看完整资料） ============ */}
            <div className="card lrn-status-card">
              <div className="card-title">
                <Users size={17} /> 人格学习状态
                <span className="lrn-updated">只读展示 · 每 60 秒自动刷新{statusAt ? ` · 更新于 ${statusAt}` : ''}</span>
              </div>
              {statusErr ? (
                <div className="lrn-error">
                  <AlertTriangle size={15} />
                  <div style={{ flex: 1 }}>{statusErr}</div>
                  <button className="btn btn-sm btn-danger" onClick={() => refreshStatus()}><RefreshCw size={13} /> 重试</button>
                </div>
              ) : pStatus.length === 0 ? (
                <div className="empty-state" style={{ padding: '34px 12px' }}>
                  <Users size={34} style={{ color: 'var(--nc-foreground-300)', marginBottom: 10 }} />
                  <div style={{ color: 'var(--nc-foreground-400)', fontSize: 13 }}>暂无档案<br />学习过 / 正在学习的目标会显示在这里（点「人格立即学习」开始）</div>
                </div>
              ) : (
                <div className="lrn-status-list lrn-status-scroll">
                  {pStatus.map((it) => {
                    const open = openUid === it.uid;
                    const d = profDetail[it.uid] || null;
                    const pf = d?.profile || null;
                    return (
                      <div className={`lrn-status-row${open ? ' is-open' : ''}`} key={it.uid} id={`lrn-row-${it.uid}`}
                        onClick={() => openProfile(it.uid)} title={open ? '点一下收起' : '点一下看完整资料'}>
                        <div className="lrn-status-main">
                          <div className="lrn-status-uid">
                            <b>{it.uid}</b>
                            {it.nickname && <span className="lrn-nick">{it.nickname}</span>}
                            <span className="lrn-status-caret">{open ? '收起 ▾' : '展开 ▸'}</span>
                          </div>
                          <div className="lrn-status-meta">
                            {it.state === 'learning'
                              ? <span className="badge badge-warn">学习中…</span>
                              : it.learnedAtMs > 0
                                ? <span className="badge badge-success">已学习</span>
                                : <span className="badge badge-soft">无档案</span>}
                            <span>{it.learnedAtMs > 0 ? `最近学习 ${bjClock(it.learnedAtMs)}` : '尚未学习'}</span>
                            {it.samples > 0 && <span>样本 {it.samples} 条</span>}
                          </div>
                          {!open && it.preview && <div className="lrn-status-preview">{it.preview}</div>}
                          {open && (() => {
                            /* 【2026-09-14 主人反馈】展开卡片要能看到**完整**资料：
                             *   ① 旧版只显示 profiles 表里几个被截过的短字段（性格 200 字、备注 200~300 字），
                             *      加上两段几乎一样的"备注/人格摘要"，看着既重复又像没说完；
                             *   ② 现在优先显示**成文画像**（桥端合成的一整段介绍），结构化字段只在没有成文画像时
                             *      才退化成列表显示，避免同一件事讲两遍；
                             *   ③ 数据层（/api/learning/profile）已经不再截断，这里也不做任何 clamp。 */
                            const lib = d?.library ?? null;
                            const intro = String(lib?.profile || pf?.personality || d?.personaSummary || '').trim();
                            const summaryText = String(d?.personaSummary || '').trim();
                            const styleBits = lib?.style
                              ? [lib.style.sentenceLength, lib.style.toneWords, lib.style.rhetoricalQuestions].filter(Boolean).join('；')
                              : '';
                            const phraseText = (lib?.catchphrases ?? [])
                              .map((c: any) => (c?.context ? `${c.phrase}（${c.context}）` : c?.phrase))
                              .filter(Boolean).join('；');
                            return (
                            <div className="lrn-status-detail">
                              {profBusy === it.uid && <div className="lrn-dk">正在读取完整资料…</div>}
                              {profErr[it.uid] && <div className="lrn-dk">读取失败：{profErr[it.uid]}</div>}
                              <div>
                                <span className="lrn-dk">人格样本</span>
                                {it.samples} 条
                                {num(d?.msgCount) > 0 ? ` · 近 30 天发言 ${num(d.msgCount)} 条` : ''}
                                {num(d?.memoryCount) > 0 ? ` · 记忆条目 ${num(d.memoryCount)} 条` : ''}
                              </div>
                              {it.learnedAtMs > 0 && <div><span className="lrn-dk">最近学习</span>{bjClock(it.learnedAtMs)}</div>}
                              {num(pf?.updatedAt) > 0 && <div><span className="lrn-dk">档案更新</span>{bjClock(num(pf.updatedAt))}</div>}
                              {num(d?.lastSeen) > 0 && <div><span className="lrn-dk">最近活跃</span>{bjClock(num(d.lastSeen))}</div>}
                              {pf?.name && <div><span className="lrn-dk">通讯录昵称</span>{pf.name}</div>}
                              {pf?.birthday && <div><span className="lrn-dk">生日</span>{pf.birthday}</div>}

                              {intro ? (
                                <div className="lrn-wide">
                                  <span className="lrn-dk">完整介绍</span>
                                  <p className="lrn-prose">{intro}</p>
                                </div>
                              ) : null}

                              {/* 没有成文画像（老档案）时，退化成字段列表，保证信息不丢 */}
                              {!intro && lib?.personality && <div className="lrn-wide"><span className="lrn-dk">性格</span><p className="lrn-prose">{lib.personality}</p></div>}
                              {!intro && !lib && pf?.personality && <div className="lrn-wide"><span className="lrn-dk">性格</span><p className="lrn-prose">{pf.personality}</p></div>}

                              {lib?.addressTerms && <div className="lrn-wide"><span className="lrn-dk">称呼方式</span>{lib.addressTerms}</div>}
                              {styleBits && <div className="lrn-wide"><span className="lrn-dk">说话风格</span>{styleBits}</div>}
                              {lib?.style?.examples?.length ? (
                                <div className="lrn-wide"><span className="lrn-dk">原句样例</span>{lib.style.examples.join(' / ')}</div>
                              ) : null}
                              {lib?.chatHabits && <div className="lrn-wide"><span className="lrn-dk">聊天习惯</span>{lib.chatHabits}</div>}
                              {lib?.emojiHabits && <div className="lrn-wide"><span className="lrn-dk">表情习惯</span>{lib.emojiHabits}</div>}
                              {phraseText && <div className="lrn-wide"><span className="lrn-dk">口头禅</span>{phraseText}</div>}
                              {lib?.topics?.length ? <div className="lrn-wide"><span className="lrn-dk">常聊话题</span>{lib.topics.join('；')}</div> : null}
                              {lib?.taboos?.length ? <div className="lrn-wide"><span className="lrn-dk">要注意</span>{lib.taboos.join('；')}</div> : null}
                              {lib?.relationshipAdvice && <div className="lrn-wide"><span className="lrn-dk">相处建议</span>{lib.relationshipAdvice}</div>}

                              {pf?.likes && <div className="lrn-wide"><span className="lrn-dk">喜好</span>{pf.likes}</div>}
                              {pf?.dislikes && <div className="lrn-wide"><span className="lrn-dk">不喜欢</span>{pf.dislikes}</div>}
                              {pf?.notes && <div className="lrn-wide"><span className="lrn-dk">备注</span>{pf.notes}</div>}
                              {/* 人格摘要与成文画像内容相同就不再重复显示一遍 */}
                              {summaryText && summaryText !== intro && (
                                <div className="lrn-wide"><span className="lrn-dk">人格摘要</span><p className="lrn-prose">{summaryText}</p></div>
                              )}
                              {!profBusy && !profErr[it.uid] && !intro && !pf && !summaryText && (
                                <div className="lrn-dk">这个人在记忆库里还没有档案（只有上面的学习状态）。</div>
                              )}
                            </div>
                            );
                          })()}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* ============ 黑话库弹窗 ============ */}
          {slangOpen && (() => {
            const kw = slangQ.trim().toLowerCase();
            const list = slangEntries
              .filter((e) => {
                if (!kw) return true;
                return [e?.content, e?.meaning, e?.usage, e?.example].some((v) => String(v ?? '').toLowerCase().includes(kw));
              })
              .sort((a, b) => (num(b?.count) - num(a?.count)) || String(a?.content ?? '').localeCompare(String(b?.content ?? '')));
            const badge = (st: string) => (st === 'confirmed'
              ? <span className="badge badge-success">已确认</span>
              : st === 'rejected' ? <span className="badge badge-soft">已拒收</span> : <span className="badge badge-warn">候选</span>);
            return (
              <div className="pfp-mask" onClick={() => setSlangOpen(false)}>
                <div className="pfp-modal" onClick={(e) => e.stopPropagation()}>
                  <div className="pfp-head">
                    <div>
                      <div className="pfp-title">黑话库</div>
                      <div className="pfp-sub">
                        共 {slangEntries.length} 条{kw ? ` · 命中 ${list.length} 条` : ''} · 已确认的会注入到聊天上下文里
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-sm" onClick={() => loadSlangLib()}><RefreshCw size={13} /> 刷新</button>
                      <button className="btn btn-sm" onClick={() => setSlangOpen(false)}>关闭</button>
                    </div>
                  </div>
                  <div style={{ padding: '10px 18px 0' }}>
                    <input className="input" placeholder="搜词条 / 含义 / 例句…" value={slangQ} onChange={(e) => setSlangQ(e.target.value)} />
                  </div>
                  <div className="pfp-body">
                    {slangErr && <div className="pfp-empty">读取失败：{slangErr}（黑话库在桥的 state/slang.json 里，桥没连上时读不到）</div>}
                    {!slangErr && list.length === 0 && (
                      <div className="pfp-empty">
                        {slangEntries.length === 0 ? '还没有学到任何词条：点「黑话立即学习」跑一轮，或等定时学习到点。' : '没有匹配的词条。'}
                      </div>
                    )}
                    {list.map((e, idx) => {
                      const ev: any[] = Array.isArray(e?.evidence) ? e.evidence : [];
                      return (
                        <div className="lrn-status-row" key={String(e?.id ?? idx)} style={{ cursor: 'default' }}>
                          <div className="lrn-status-main">
                            <div className="lrn-status-uid">
                              <b>{String(e?.content ?? '(空)')}</b>
                              {badge(String(e?.status ?? ''))}
                              <span className="lrn-status-caret">出现 {num(e?.count)} 次 · {String(e?.source ?? '')}</span>
                            </div>
                            {String(e?.meaning ?? '').trim()
                              ? <div className="lrn-status-preview">{String(e.meaning)}</div>
                              : <div className="lrn-status-preview" style={{ opacity: .65 }}>（还没有释义：达到出现次数阈值后会自动研究补齐）</div>}
                            {String(e?.usage ?? '').trim() && <div className="lrn-dk">用法：{String(e.usage)}</div>}
                            {String(e?.example ?? '').trim() && <div className="lrn-dk">例句：{String(e.example)}</div>}
                            {ev.length > 0 && (
                              <div className="lrn-dk">
                                原话：{ev.slice(0, 2).map((x) => `「${String(x?.text ?? '').slice(0, 40)}」`).join(' ')}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* ============ 用量统计 ============ */}
          <UsagePanel />
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/* 用量统计：本机 + 服务端**两边都取**，再显示「本机 / 服务端 / 合计」三块  */
/* ================================================================== */
/** 一条"用量来源"摘要：本机桥 / 服务端桥 / 合计 */
interface UsageSource { rep: any | null; reason: string; server?: { name: string; host: string } | null; }

/** 某个报告里的"今日已用"（与下面 todayUsed 同一套口径：优先 billedTotal，其次四项相加） */
function todayUsedOf(rep: any): number {
  if (!isObj(rep)) return 0;
  const t = isObj(rep.today) ? rep.today : {};
  const billed = num(t.billedTotal) || (num(t.prompt) + num(t.completion) + num(t.cacheRead) + num(t.cacheWrite));
  return billed > 0 ? billed : num(t.total);
}

function UsageSourceCard({ title, src, badge, highlight }: { title: string; src: UsageSource; badge?: string; highlight?: boolean }) {
  const used = todayUsedOf(src.rep);
  const t = isObj(src.rep?.today) ? src.rep.today : {};
  const ok = !!src.rep;
  return (
    <div className={`lrn-stat ${highlight ? 'lrn-stat-azure' : ''}`}>
      <div className="lrn-stat-t">
        {title}
        {badge && <span className={`badge ${badge === '服务端' ? 'badge-remote' : 'badge-local'}`} style={{ marginLeft: 6 }}>{badge}</span>}
      </div>
      <div className="lrn-stat-v">{ok ? fmtFull(used) : '—'}</div>
      <div className="lrn-stat-s">
        {ok
          ? (used === 0
            ? '今日暂无记录'
            : `未命中 ${fmtFull(num(t.prompt))} · 命中 ${fmtFull(num(t.cacheRead))} · 输出 ${fmtFull(num(t.completion))}`)
          : (src.reason || '未取到数据')}
        {ok && src.server ? <><br />{src.server.name}（{src.server.host}）</> : null}
      </div>
    </div>
  );
}

function UsagePanel() {
  const [report, setReport] = useState<any>(null);
  const [split, setSplit] = useState<{ local: any | null; remote: any | null; total: any | null; localReason: string; remoteReason: string; remoteServer: any } | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState('');
  const [live, setLive] = useState<'sse' | 'poll'>('poll');
  const inflight = useRef(false);
  const lastReload = useRef(0);

  const load = async () => {
    if (inflight.current) return;
    inflight.current = true;
    if (!report) setLoading(true);
    try {
      const r: any = await getTokenReport();
      const e = firstErr(r);
      if (e) { setErr(e); return; }
      // 【2026-09-14】后端现在回 { local, remote, total, remoteReason, ... }：
      //   · local  = 本机桥那份（永远取，SSH 模式下也保留）；
      //   · remote = 服务端桥那份（没连服务器/服务端桥没跑时 null + remoteReason 一行原因）；
      //   · total  = 两份合并的合计 —— 曲线/分时图仍然按合计画。
      const total = isObj(r?.total) ? r.total : (isObj(r?.report) ? r.report : null);
      const next = {
        local: isObj(r?.local) ? r.local : null,
        remote: isObj(r?.remote) ? r.remote : null,
        total,
        localReason: String(r?.localReason || ''),
        remoteReason: String(r?.remoteReason || ''),
        remoteServer: isObj(r?.remoteServer) ? r.remoteServer : null,
      };
      setSplit(next);
      if (!total) {
        setErr([next.localReason, next.remoteReason].filter(Boolean).join('；') || '两侧桥都没有取到用量数据');
        return;
      }
      setReport(total); setErr('');
      setUpdatedAt(bjClock(Date.now()));
    } catch (e2: any) {
      setErr(String(e2?.message ?? e2));
    } finally {
      inflight.current = false; setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // 优先走 SSE 实时推流（桥侧 token-meter 一落行就推）；连续失败自动退回 60 秒轮询兜底
    let es: EventSource | null = null;
    let poll: number | null = null;
    let sseErrors = 0;
    const startPoll = () => { if (poll === null) poll = window.setInterval(load, 60000); };
    const stopPoll = () => { if (poll !== null) { clearInterval(poll); poll = null; } };

    const apply = (data: string) => {
      let payload: any = null;
      try { payload = JSON.parse(data); } catch { return; }
      const rep = isObj(payload?.report) ? payload.report : isObj(payload?.result?.report) ? payload.result.report : null;
      if (!rep) return;
      // SSE 只推**单侧**桥的原始报告，而面板显示的是"本机 + 服务端 + 合计"三段：
      // 直接 setReport(rep) 会把合计覆盖成单侧数据（服务端那份会被抹掉）。
      // 所以这里改成"节流地整段重取"（最多每 15 秒一次），数据仍然新鲜，三段也不会互相覆盖。
      const now = Date.now();
      if (now - lastReload.current < 15000) return;
      lastReload.current = now;
      load();
    };

    try {
      es = new EventSource('/api/learning/token-stream');
      es.addEventListener('token', (ev: MessageEvent) => {
        sseErrors = 0; stopPoll(); setLive('sse');
        apply(ev.data);
      });
      es.addEventListener('stream-error', () => { sseErrors += 1; setLive('poll'); startPoll(); });
      es.onerror = () => {
        // EventSource 自带重连；先并行开轮询兜底，推流恢复后自动停掉
        sseErrors += 1;
        if (sseErrors >= 2) { setLive('poll'); startPoll(); }
      };
    } catch {
      setLive('poll'); startPoll();
    }

    return () => {
      if (es) es.close();
      stopPoll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (err && !report) {
    return (
      <div className="card token-panel">
        <div className="card-title"><BarChart3 size={17} /> Token 用量统计</div>
        <div className="lrn-error">
          <AlertTriangle size={15} />
          <div style={{ flex: 1 }}>{err}<div className="lrn-error-detail">用量来自桥侧 /api/token-report：本机桥与服务端桥都取不到时无法统计（服务端桥没跑时会单独给出原因）。</div></div>
          <button className="btn btn-sm btn-danger" onClick={load}><RefreshCw size={13} /> 重试</button>
        </div>
      </div>
    );
  }

  const days = normDays(report?.dates);
  const hours = normHours(report?.todayHourly);
  const today = isObj(report?.today) ? report.today : {};
  // 【2026-09-12 修「今日已用比平台虚高 1/3」】根因不是重复计数，而是**日界口径**：
  //   桥原来按**北京自然日**聚合，而提供方（小米 MiMo 开放平台）按 **UTC 自然日** 结算
  //   —— 也就是北京时间每天 08:00 换日。实测：同一份 token-usage.jsonl，
  //   北京日合计 13,809,552（242 帧），UTC 日合计 10,382,792（164 帧），平台显示 10,383,812（差 0.0098%）。
  //   桥侧 token-meter.js 已改成"计费日"口径（默认偏移 480 分钟 = 北京 08:00 换日，
  //   可用 QQB_TOKEN_DAY_OFFSET_MIN 改，设 0 精确回退旧口径），today/dates 都跟着它走。
  // 这里同时把 cacheWrite（缓存写入输入）算进去 —— 提供方的 total_tokens 是四项相加。
  // 桥侧新版本会直接给 today.billedTotal（同一个定义），旧桥没有该字段时按四项手动相加兜底。
  const todayBilled = num(today.billedTotal)
    || (num(today.prompt) + num(today.completion) + num(today.cacheRead) + num(today.cacheWrite));
  const todayReal = todayBilled > 0 ? todayBilled : num(today.total);
  const todayEst = num(today.estTotal);
  // 「今日已用」= 真实计费量，**不把字符估算并进来**（估算只在下方单独一行说明）。
  const todayUsed = todayReal;
  const todayProj = report && report.todayEstimatedTotal !== undefined ? num(report.todayEstimatedTotal) : todayUsed;
  const dayAvg = days.length ? days.reduce((a, d) => a + d.real + d.est, 0) / days.length : 0;
  const realSum = days.reduce((a, d) => a + d.real, 0);
  const estSum = days.reduce((a, d) => a + d.est, 0);
  const allReal = realSum + todayReal;
  const allEst = estSum + todayEst;
  // 自然日（北京 00:00 起）合计：小时图本身就是自然日聚合，直接按小时求和即可（不为它加后端字段）
  const calTotal = hours.reduce((a, h) => a + h.prompt + h.completion + h.cacheRead, 0);
  // 计费日从几点开始（桥侧 dayWindow.startBjMinutes：480 = 北京 08:00 换日 = UTC 日 = 平台口径）
  const dayStartMin = num(report?.dayWindow?.startBjMinutes);
  const dayStartLabel = dayStartMin > 0
    ? `北京 ${String(Math.floor(dayStartMin / 60)).padStart(2, '0')}:${String(dayStartMin % 60).padStart(2, '0')} 换日`
    : '北京 00:00 换日';
  const note = typeof report?.note === 'string' && report.note ? report.note : '';

  return (
    <div className="card token-panel">
      <div className="card-title" style={{ justifyContent: 'space-between' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><TrendingUp size={17} /> Token 用量统计</span>
        <span className="page-actions" style={{ gap: 8 }}>
          <span className="lrn-updated">{live === 'sse' ? '实时推流（SSE）· 本机 + 服务端合并' : '每 60 秒自动刷新（SSE 不可用）'}{updatedAt ? ` · ${updatedAt}` : ''}</span>
          <button className="btn btn-sm" disabled={loading} onClick={load}>
            {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} 刷新
          </button>
        </span>
      </div>

      {note && <div className="lrn-note lrn-note-soft">{note}</div>}

      {/* 【2026-09-14 主人要求】用量**两边都不漏**：本机一份、服务端一份、再加合计，三块分开显示。
          服务端取不到时这里给出原因（例如"服务端桥未运行"），本机那份照常显示。 */}
      {split && (
        <div className="lrn-stat-row">
          <UsageSourceCard title="本机" badge="本机" src={{ rep: split.local, reason: split.localReason }} />
          <UsageSourceCard title="服务端" badge="服务端" src={{ rep: split.remote, reason: split.remoteReason, server: split.remoteServer }} />
          <UsageSourceCard title="合计（本机 + 服务端）" src={{ rep: split.total, reason: '两侧都没有数据' }} highlight />
        </div>
      )}

      {/* 顶部三张数字卡 */}
      <div className="lrn-stat-row">
        <div className="lrn-stat lrn-stat-azure">
          <div className="lrn-stat-t">今日已用 token</div>
          <div className="lrn-stat-v">{fmtFull(todayUsed)}</div>
          <div className="lrn-stat-s">
            {todayUsed === 0 ? '今日暂无记录' : `未命中 ${fmtFull(num(today.prompt))} · 命中 ${fmtFull(num(today.cacheRead))} · 输出 ${fmtFull(num(today.completion))}`}
            {/* 平台（小米 MiMo 控制台）按 UTC 日结算 = 北京 08:00 换日；这里并列显示自然日合计，方便对数 */}
            {calTotal > 0 && <><br />平台口径（{dayStartLabel}）· 自然日 00:00 起合计 {fmtFull(calTotal)}</>}
          </div>
        </div>
        <div className="lrn-stat">
          <div className="lrn-stat-t">今日预计</div>
          <div className="lrn-stat-v lrn-stat-proj">{fmtFull(todayProj)}</div>
          <div className="lrn-stat-s">按当前速率外推，仅供参考</div>
        </div>
        <div className="lrn-stat lrn-stat-azure">
          <div className="lrn-stat-t">近 {days.length || 7} 日日均</div>
          <div className="lrn-stat-v">{fmtFull(dayAvg)}</div>
          <div className="lrn-stat-s">未命中 + 缓存命中 + 输出，按平台计费日聚合</div>
        </div>
      </div>

      {/* 近 7 日曲线（实线=实际，虚线=估算） */}
      <Chart7d days={days} />
      {(days.length > 0 && realSum + todayReal === 0 && allEst > 0) && (
        <div className="lrn-note"><AlertTriangle size={13} /> 该时段无真实计量（未收到 usage 帧），整条曲线均为估算，仅供参考。</div>
      )}

      {/* 今日按北京小时迷你柱（自然日视图；「今日已用」卡片是平台计费日口径，两者在 00:00~08:00 段不同） */}
      <HourBars hours={hours} todayUsed={todayUsed} />

      {/* 实测计量 + 费用预算：口径分开，数据随 SSE 实时刷新 */}
      <TokenPanel hours={hours} />
    </div>
  );
}

function Chart7d({ days }: { days: DayStat[] }) {
  const W = 680; const H = 224;
  // 左右留白按「标注能完整放下」定：padL 收窄给纵轴标签，padR 留出一个数值标注的宽度，
  // 首末节点再用 start/end 锚点兜底，所以最后一个点的数字不会被卡片边缘裁掉。
  const padL = 46; const padR = 22; const padT = 28; const padB = 28;
  const iw = W - padL - padR; const ih = H - padT - padB;
  const hasData = days.some((d) => d.real > 0);
  if (!days.length) {
    return (
      <div className="lrn-chart-wrap">
        <div className="empty-state" style={{ padding: '26px 10px' }}><BarChart3 size={26} style={{ color: 'var(--nc-foreground-300)', marginBottom: 8 }} />暂无 7 日数据</div>
      </div>
    );
  }
  // 只用真实计量（未命中 + 命中 + 输出）；不再拿字符估算画第二条线
  const maxV = niceMax(Math.max(...days.map((d) => d.real)));
  const n = days.length;
  const X = (i: number) => padL + (n > 1 ? (i / (n - 1)) * iw : iw / 2);
  const Y = (v: number) => padT + ih - (v / maxV) * ih;
  const realPts = days.map((d, i) => `${X(i)},${Y(d.real)}`).join(' ');
  const areaPts = `${padL},${padT + ih} ${realPts} ${padL + iw},${padT + ih}`;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => maxV * f);
  const estSum = days.reduce((a, d) => a + d.est, 0);

  return (
    <div className="lrn-chart-wrap">
      <div className="lrn-legend">
        <span><i className="lrn-line tb-line-solid" /> 未命中 + 缓存命中 + 输出</span>
        <span className="lrn-updated">横轴为北京日期</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="lrn-chart" role="img" aria-label={`近 ${days.length} 日 token 实测用量曲线`}>
        <defs>
          <linearGradient id="tbLine" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="hsl(199 100% 72%)" />
            <stop offset="45%" stopColor="hsl(203 100% 56%)" />
            <stop offset="100%" stopColor="hsl(199 100% 72%)" />
            <animateTransform attributeName="gradientTransform" type="translate"
              values="-1 0; 0 0; 1 0; 0 0; -1 0" dur="6s" repeatCount="indefinite" />
          </linearGradient>
          <linearGradient id="tbArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(199 100% 60% / .38)" />
            <stop offset="100%" stopColor="hsl(199 100% 60% / 0)" />
          </linearGradient>
        </defs>
        {grid.map((g) => (
          <g key={g}>
            <line x1={padL} x2={W - padR} y1={Y(g)} y2={Y(g)} style={{ stroke: 'var(--nc-divider)', strokeWidth: 1 }} />
            <text x={padL - 8} y={Y(g) + 4} textAnchor="end" style={{ fill: 'var(--tb-azure-600)', fontSize: 11 }}>{fmtTok(g)}</text>
          </g>
        ))}
        <polygon points={areaPts} fill="url(#tbArea)" stroke="none" />
        <polyline points={realPts} fill="none" className="tb-flow" style={{ stroke: 'url(#tbLine)', strokeWidth: 2.8, strokeLinecap: 'round', strokeLinejoin: 'round' }} />
        {days.map((d, i) => {
          const lbl = fmtFull(d.real);
          const a = anchorInside(X(i), lbl, 6.2, W);
          return (
            <g key={`p${i}`}>
              <circle cx={X(i)} cy={Y(d.real)} r={4.2} className="tb-node" />
              <circle cx={X(i)} cy={Y(d.real)} r={2} style={{ fill: '#fff' }} />
              {d.real > 0 && (
                <text x={a.x} y={Math.max(Y(d.real) - 10, 13)} textAnchor={a.anchor} className="tb-node-label">{lbl}</text>
              )}
            </g>
          );
        })}
        {days.map((d, i) => (
          <text key={`x${i}`} x={X(i)} y={H - 10} textAnchor="middle" style={{ fill: 'var(--tb-azure-600)', fontSize: 10.5 }}>{d.label}</text>
        ))}
      </svg>
      {!hasData && <div className="lrn-note">近 {days.length} 日无用量记录。</div>}
      {estSum > 0 && (
        <div className="lrn-note lrn-note-soft">另有 {fmtFull(estSum)} tok 来自「未收到 usage 帧」时的字符估算，未计入曲线。</div>
      )}
    </div>
  );
}

function HourBars({ hours, todayUsed }: { hours: HourStat[]; todayUsed: number }) {
  const [tip, setTip] = useState<{ x: number; y: number; hour: number; total: number; miss: number; hit: number; out: number } | null>(null);
  // 【2026-09-12 修「提示框被右边挡」】原来固定写 `left: x+14`，鼠标停在最右那根柱子上时
  // 提示框会向右溢出视口（实测 1360 宽下右溢 52px、700 宽下右溢 89px），被面板右边缘/滚动条压住。
  // 现在：先按鼠标右下角试摆，右侧或下方放不下就翻到鼠标左上；仍越界则夹回视口内（留 10px 边距）。
  const tipRef = useRef<HTMLDivElement | null>(null);
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!tip || !tipRef.current) { setTipPos(null); return; }
    const el = tipRef.current;
    const w = el.offsetWidth; const h = el.offsetHeight;
    const vw = window.innerWidth; const vh = window.innerHeight;
    const M = 10;                       // 与视口边缘保持的边距
    let left = tip.x + 14;
    if (left + w > vw - M) left = tip.x - 14 - w;   // 右边放不下 → 翻到鼠标左侧
    left = Math.max(M, Math.min(left, vw - w - M)); // 再夹回视口（窗口很窄时也不会被挡）
    let top = tip.y + 14;
    if (top + h > vh - M) top = tip.y - 14 - h;     // 下边放不下 → 翻到鼠标上方
    top = Math.max(M, Math.min(top, vh - h - M));
    setTipPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
  }, [tip]);
  const W = 680; const H = 168;
  // padT 必须给「柱顶数字」留出一整行，否则今天最高的那根柱子被填满时标注会顶出画布；
  // padR 同理给最右一根柱子留位，柱顶文字再用 anchorInside 兜底。
  const padL = 44; const padR = 22; const padT = 22; const padB = 26;
  const iw = W - padL - padR; const ih = H - padT - padB;
  if (!hours.length) {
    return (
      <div className="lrn-hour-wrap">
        <div className="lrn-hour-title">今日分时（北京时）</div>
        <div className="lrn-note lrn-note-soft">{todayUsed === 0 ? '今日暂无用量记录' : '桥侧未返回分时明细（缺 todayHourly 字段）'}</div>
      </div>
    );
  }
  const maxV = niceMax(Math.max(...hours.map((h) => h.real + h.est)));
  const slot = iw / hours.length;
  const bw = Math.max(3, Math.min(26, slot * 0.74));
  const lastH = hours[hours.length - 1]?.hour ?? 23;
  // 每个小时都标出刻度（原来只标 0/3/6…+末位，1、2 看着像"没显示"）
  const labelAt = () => true;

  return (
    <div className="lrn-hour-wrap">
      <div className="lrn-hour-title">今日分时（北京时）</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="lrn-chart" role="img" aria-label="今日各小时 token 用量柱状图">
        <defs>
          <linearGradient id="tbBar" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="hsl(203 100% 50%)" />
            <stop offset="55%" stopColor="hsl(199 100% 62%)" />
            <stop offset="100%" stopColor="hsl(197 100% 78%)" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((f) => {
          const g = maxV * f;
          return (
            <g key={f}>
              <line x1={padL} x2={W - padR} y1={padT + ih - (g / maxV) * ih} y2={padT + ih - (g / maxV) * ih} style={{ stroke: 'var(--nc-divider)', strokeWidth: 1 }} />
              <text x={padL - 6} y={padT + ih - (g / maxV) * ih + 4} textAnchor="end" style={{ fill: 'var(--tb-azure-600)', fontSize: 10.5 }}>{fmtTok(g)}</text>
            </g>
          );
        })}
        {hours.map((h) => {
          const cx = padL + slot * (h.hour - (hours[0]?.hour ?? 0)) + slot / 2;
          const combined = h.real;
          const bh = combined > 0 ? Math.max(3, (combined / maxV) * ih) : 1;
          const by = padT + ih - bh;
          const lbl = fmtTok(combined);
          const a = anchorInside(cx, lbl, 5.6, W);
          return (
            <g key={h.hour}>
              <rect x={cx - bw / 2} y={by} width={bw} height={bh} rx={3} className={combined > 0 ? 'tb-bar' : undefined}
                style={{ fill: combined > 0 ? 'url(#tbBar)' : 'hsl(199 60% 92%)', cursor: combined > 0 ? 'pointer' : 'default' }}
                onMouseMove={combined > 0 ? (e) => setTip({ x: e.clientX, y: e.clientY, hour: h.hour, total: combined, miss: h.prompt, hit: h.cacheRead, out: h.completion }) : undefined}
                onMouseLeave={combined > 0 ? () => setTip(null) : undefined} />
              {combined > 0 && (
                <text x={a.x} y={Math.max(by - 5, 12)} textAnchor={a.anchor} className="tb-bar-label">{lbl}</text>
              )}
              {labelAt() && (
                <text x={cx} y={H - 8} textAnchor="middle" style={{ fill: 'var(--tb-azure-600)', fontSize: 10 }}>{h.hour}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="lrn-hour-foot">到 {lastH}:00（当前北京小时）为止，每格 = 1 小时 · 柱顶数字为该小时合计 · 自然日 00:00 起</div>
      {tip && (
        // 先以 raw 位置渲染一帧（visibility:hidden）供量尺寸，useLayoutEffect 量完立刻换成夹好的位置
        <div
          ref={tipRef}
          className="tb-tip"
          style={{ left: tipPos?.left ?? tip.x + 14, top: tipPos?.top ?? tip.y + 14, visibility: tipPos ? 'visible' : 'hidden' }}
          role="tooltip"
        >
          <div className="tb-tip-h">{tip.hour}:00</div>
          <div className="tb-tip-total">{fmtFull(tip.total)} tok</div>
          <div className="tb-tip-row"><span>未命中</span><b>{fmtFull(tip.miss)}</b></div>
          <div className="tb-tip-row"><span>缓存命中</span><b>{fmtFull(tip.hit)}</b></div>
          <div className="tb-tip-row"><span>输出</span><b>{fmtFull(tip.out)}</b></div>
        </div>
      )}
    </div>
  );
}

/* ---------- 实时计量（实测）与费用预算（假设口径）：两套口径物理分开，互不换算 ---------- */
/** 高峰时段（北京时）：09:00-12:00 与 14:00-18:00，单价 ×peakMult */
const PEAK_HOURS = new Set([9, 10, 11, 14, 15, 16, 17]);
const COST_KEY = 'qbm-token-cost-v2';

interface CostCfg {
  hitRate: number;   // 预算用的假设命中率（只影响预算区，绝不参与实测）
  pHit: number;      // ¥/M tok，谷时
  pMiss: number;
  pOut: number;
  peakMult: number;
}
const COST_DEFAULT: CostCfg = { hitRate: 0.98, pHit: 0.02, pMiss: 1, pOut: 4, peakMult: 2 };

function loadCostCfg(): CostCfg {
  try {
    const raw = JSON.parse(localStorage.getItem(COST_KEY) || 'null');
    if (isObj(raw)) {
      return {
        hitRate: num(raw.hitRate) > 0 && num(raw.hitRate) < 1 ? num(raw.hitRate) : COST_DEFAULT.hitRate,
        pHit: raw.pHit !== undefined ? num(raw.pHit) : COST_DEFAULT.pHit,
        pMiss: raw.pMiss !== undefined ? num(raw.pMiss) : COST_DEFAULT.pMiss,
        pOut: raw.pOut !== undefined ? num(raw.pOut) : COST_DEFAULT.pOut,
        peakMult: num(raw.peakMult) >= 1 ? num(raw.peakMult) : COST_DEFAULT.peakMult,
      };
    }
  } catch { /* 存储不可用 → 用默认 */ }
  return { ...COST_DEFAULT };
}
/** 预算专用：由未命中输入与假设命中率推算命中 tok（hits = miss × r / (1 − r)） */
const assumedHit = (miss: number, r: number): number =>
  r >= 0.9995 ? miss * 2000 : (r <= 0 ? 0 : (miss * r) / (1 - r));
const hourMult = (h: number, m: number): number => (PEAK_HOURS.has(h) ? m : 1);

/** 同一份小时数据算两套口径：
 *  实测 = 只统计确实带缓存命中字段的请求（cacheRead / cachePrompt / cacheCompletion），不反推、不外推；
 *  预算 = 以真实未命中/输出为基数、按假设命中率推算，单独成块。两者不共享任何数字。 */
function useLiveCost(hours: HourStat[], cfg: CostCfg) {
  return useMemo(() => {
    // 实测子集
    let mHit = 0; let mMiss = 0; let mOut = 0; let mSamples = 0;
    let mCost = 0; let mOffCost = 0; let mPeakCost = 0; let mPeakHours = 0;
    // 全量（曲线与预算基数）
    let dayMiss = 0; let dayCacheRead = 0; let dayOut = 0; let dayTotal = 0;
    // 预算
    let bHit = 0; let bCost = 0; let bOffCost = 0; let bPeakCost = 0; let bPeakHours = 0;

    for (const h of hours) {
      dayMiss += h.prompt; dayCacheRead += h.cacheRead; dayOut += h.completion;
      dayTotal += h.prompt + h.completion + h.cacheRead;
      const mult = hourMult(h.hour, cfg.peakMult);

      if (h.cacheSamples > 0) {
        mHit += h.cacheRead; mMiss += h.cachePrompt; mOut += h.cacheCompletion; mSamples += h.cacheSamples;
        const c = ((h.cacheRead * cfg.pHit + h.cachePrompt * cfg.pMiss + h.cacheCompletion * cfg.pOut) / 1e6) * mult;
        mCost += c;
        if (mult > 1) { mPeakCost += c; mPeakHours += 1; } else { mOffCost += c; }
      }

      const bh = assumedHit(h.prompt, cfg.hitRate);
      bHit += bh;
      const bc = ((bh * cfg.pHit + h.prompt * cfg.pMiss + h.completion * cfg.pOut) / 1e6) * mult;
      bCost += bc;
      if (mult > 1) { bPeakCost += bc; bPeakHours += 1; } else { bOffCost += bc; }
    }

    const measuredRate = (mHit + mMiss) > 0 ? mHit / (mHit + mMiss) : null;
    return {
      mHit, mMiss, mOut, mSamples, mCost, mOffCost, mPeakCost, mPeakHours,
      dayMiss, dayCacheRead, dayOut, dayTotal,
      bHit, bCost, bOffCost, bPeakCost, bPeakHours, measuredRate,
    };
  }, [hours, cfg]);
}

function TokenPanel({ hours }: { hours: HourStat[] }) {
  const [cfg, setCfg] = useState<CostCfg>(loadCostCfg);
  useEffect(() => { try { localStorage.setItem(COST_KEY, JSON.stringify(cfg)); } catch { /* 忽略 */ } }, [cfg]);
  const patch = (p: Partial<CostCfg>) => setCfg((c) => ({ ...c, ...p }));
  const m = useLiveCost(hours, cfg);

  if (!hours.length || m.dayTotal === 0) {
    return (
      <div className="cost-wrap">
        <div className="cost-head"><Activity size={15} /> 实测计量</div>
        <div className="lrn-note lrn-note-soft">今日还没有用量记录，拿到第一条 usage 帧后这里会实时累计。</div>
      </div>
    );
  }

  const rate = m.measuredRate;
  const mMonth = m.mCost * 30;
  const bMonth = m.bCost * 30;

  return (
    <div className="cost-wrap">
      {/* ============ 实测：精确计量，不反推、不估算 ============ */}
      <section className="cost-sec">
        <div className="cost-head">
          <Activity size={15} /> 实测计量
          <span className="cost-head-note">精确值 · 不做任何反推或估算 · 按北京自然日分时聚合</span>
        </div>

        <div className="cost-rate-row">
          <div className="cost-rate-num">
            <span className="cost-rate-v">{rate === null ? '—' : `${(rate * 100).toFixed(1)}%`}</span>
            <span className="cost-rate-l">
              {rate === null
                ? '当前缓存命中率 · 还没有带缓存命中字段的请求'
                : `当前缓存命中率 · 真实值（${fmtFull(m.mSamples)} 条请求的 cacheReadTokens ÷ 该批请求的输入）`}
            </span>
          </div>
          <div className="cost-rate-bar" role="img" aria-label={`缓存命中占比 ${rate === null ? '未知' : (rate * 100).toFixed(1) + '%'}`}>
            <i className="tb-flowbar" style={{ width: `${rate === null ? 0 : Math.max(0, Math.min(100, rate * 100))}%` }} />
          </div>
          <div className="cost-rate-split">
            <span>命中 <b>{fmtFull(m.mHit)}</b></span>
            <span>未命中 <b>{fmtFull(m.mMiss)}</b></span>
            <span>输出 <b>{fmtFull(m.mOut)}</b></span>
          </div>
        </div>

        <div className="cost-total-row">
          <div className="cost-total">
            <div className="cost-total-t">今日费用</div>
            <div className="cost-total-v">¥{m.mCost.toFixed(4)}</div>
            <div className="cost-total-s">谷时 ¥{m.mOffCost.toFixed(4)} · 高峰 ¥{m.mPeakCost.toFixed(4)}（{m.mPeakHours} 小时 ×{cfg.peakMult}）</div>
          </div>
          <div className="cost-total">
            <div className="cost-total-t">本月合计（30 天）</div>
            <div className="cost-total-v">¥{mMonth.toFixed(2)}</div>
            <div className="cost-total-s">按今日强度 ×30</div>
          </div>
        </div>

        <div className="cost-reset">
          <span className="cost-hint">
            今日 token 合计 <b>{fmtFull(m.dayTotal)}</b>
            （未命中 {fmtFull(m.dayMiss)} / 缓存命中 {fmtFull(m.dayCacheRead)} / 输出 {fmtFull(m.dayOut)}）
          </span>
        </div>
      </section>

      {/* ============ 预算：假设口径，与实测独立 ============ */}
      <section className="cost-sec cost-sec-budget">
        <div className="cost-head">
          <Wallet size={15} /> 费用预算
          <span className="cost-head-note">假设口径 · 与上方实测各自独立计算</span>
        </div>

        <div className="cost-params">
          <div className="cost-field">
            <label className="cost-label">假设缓存命中率</label>
            <span className="cost-custom">
              <NumInput className="" value={Number((cfg.hitRate * 100).toFixed(1))}
                onCommit={(n) => patch({ hitRate: Math.max(0, Math.min(0.999, n / 100)) })} />
              <em>%</em>
            </span>
            <span className="cost-hint">按此命中率反推缓存的输入量：{fmtTok(m.bHit)} tok</span>
          </div>

          <div className="cost-field">
            <label className="cost-label">单价（¥ / M tok，谷时价）</label>
            <div className="cost-prices">
              <span className="cost-price">
                <em>缓存命中输入</em>
                <NumInput className="" value={cfg.pHit} onCommit={(n) => patch({ pHit: Math.max(0, n) })} />
              </span>
              <span className="cost-price">
                <em>未命中输入</em>
                <NumInput className="" value={cfg.pMiss} onCommit={(n) => patch({ pMiss: Math.max(0, n) })} />
              </span>
              <span className="cost-price">
                <em>输出</em>
                <NumInput className="" value={cfg.pOut} onCommit={(n) => patch({ pOut: Math.max(0, n) })} />
              </span>
              <span className="cost-price">
                <em>高峰倍数</em>
                <NumInput className="" value={cfg.peakMult} onCommit={(n) => patch({ peakMult: Math.max(1, n || 1) })} />
              </span>
            </div>
            <span className="cost-hint">谷时 命中 ¥{cfg.pHit} / 未命中 ¥{cfg.pMiss} / 输出 ¥{cfg.pOut}；高峰（09-12、14-18）全部 ×{cfg.peakMult}</span>
          </div>
        </div>

        <div className="cost-total-row">
          <div className="cost-total">
            <div className="cost-total-t">今日预算</div>
            <div className="cost-total-v">¥{m.bCost.toFixed(4)}</div>
            <div className="cost-total-s">谷时 ¥{m.bOffCost.toFixed(4)} · 高峰 ¥{m.bPeakCost.toFixed(4)}（{m.bPeakHours} 小时 ×{cfg.peakMult}）</div>
          </div>
          <div className="cost-total">
            <div className="cost-total-t">月预算（30 天）</div>
            <div className="cost-total-v">¥{bMonth.toFixed(2)}</div>
            <div className="cost-total-s">按今日预算 ×30</div>
          </div>
        </div>

        <div className="cost-reset">
          <button type="button" className="btn btn-sm" onClick={() => setCfg({ ...COST_DEFAULT })}><RotateCcw size={12} /> 恢复默认参数</button>
        </div>
      </section>
    </div>
  );
}

/* ---------- 群友画像学习：立即 / 间隔 / 每日定时（目标自动筛，落回 profiles 表） ---------- */
interface PortraitCfg {
  enabled: boolean; minMessages: number; maxTargets: number; windowHours: number;
  autoIntervalEnabled: boolean; autoIntervalHours: number; timeHHMM: string;
}
const PORTRAIT_DEFAULT: PortraitCfg = {
  enabled: true, minMessages: 10, maxTargets: 20, windowHours: 720,
  autoIntervalEnabled: false, autoIntervalHours: 24, timeHHMM: '',
};

function normPortraitCfg(raw: any): PortraitCfg {
  const o = isObj(raw) ? raw : {};
  const ci = (v: any, d: number, lo: number, hi: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  return {
    enabled: o.enabled !== false,
    minMessages: ci(o.minMessages, PORTRAIT_DEFAULT.minMessages, 1, 5000),
    maxTargets: ci(o.maxTargets, PORTRAIT_DEFAULT.maxTargets, 1, 200),
    windowHours: ci(o.windowHours, PORTRAIT_DEFAULT.windowHours, 1, 8760),
    autoIntervalEnabled: o.autoIntervalEnabled === true,
    autoIntervalHours: ci(o.autoIntervalHours, PORTRAIT_DEFAULT.autoIntervalHours, 1, 720),
    timeHHMM: typeof o.timeHHMM === 'string' ? o.timeHHMM.trim() : '',
  };
}

function PortraitLearnBlock() {
  const [cfg, setCfg] = useState<PortraitCfg>(PORTRAIT_DEFAULT);
  const [status, setStatus] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const loadAll = async () => {
    try {
      const r: any = await getLearningConfig();
      const conf = isObj(r?.config) ? r.config : isObj(r?.result?.config) ? r.result.config : r;
      setCfg(normPortraitCfg(conf?.portrait));
    } catch { /* 桥不可达：保持默认值，不打断页面 */ }
    try {
      const s: any = await portraitAction('status');
      setStatus(isObj(s?.result) ? s.result : s);
    } catch { /* 忽略 */ }
  };
  useEffect(() => { loadAll(); }, []);

  const save = async () => {
    setBusy('save'); setMsg('');
    try {
      const r: any = await saveLearningConfig({ portrait: {
        enabled: cfg.enabled, minMessages: cfg.minMessages, maxTargets: cfg.maxTargets,
        windowHours: cfg.windowHours, autoIntervalEnabled: cfg.autoIntervalEnabled,
        autoIntervalHours: cfg.autoIntervalHours, timeHHMM: normHHMM(cfg.timeHHMM),
      } } as any);   // 只提交可编辑字段（lastRunAtMs 由画像模块自己维护）
      if (r?.ok === false || r?.success === false) { setMsg(String(r?.error || r?.message || '保存失败')); return; }
      setMsg('已保存');
      loadAll();
    } catch (e: any) { setMsg('保存失败：' + String(e?.message ?? e)); } finally { setBusy(null); }
  };
  const act = async (a: 'start' | 'stop') => {
    setBusy(a); setMsg('');
    try {
      const r: any = await portraitAction(a);
      const res = isObj(r?.result) ? r.result : r;
      if (r?.ok === false) { setMsg(String(r?.error || '调用失败')); return; }
      if (a === 'start') {
        if (res?.disabled) setMsg('画像学习已停用，先打开「启用」再学');
        else if (res?.busy) setMsg('上一轮还在跑，稍等');
        else if (res?.started?.length) setMsg(`已受理 ${res.started.length} 个目标（后台串行学习）`);
        else setMsg(String(res?.error || res?.reason || '没有可学的目标'));
      } else {
        setMsg(res?.stopped?.length ? `已请求停止 ${res.stopped.length} 个目标` : '当前没有进行中的画像学习');
      }
      loadAll();
    } catch (e: any) { setMsg('调用失败：' + String(e?.message ?? e)); } finally { setBusy(null); }
  };

  const patch = (p: Partial<PortraitCfg>) => setCfg((c) => ({ ...c, ...p }));
  const list: any[] = Array.isArray(status?.status) ? status.status : [];
  const lastTargets: string[] = Array.isArray(status?.lastTargets) ? status.lastTargets : [];
  const LEARNING = list.filter((x) => x?.state === 'learning').length;

  return (
    <div className="lrn-block" style={{ marginTop: 18, paddingTop: 14, borderTop: '1px dashed hsl(339.33 90% 90% / .9)' }}>
      <div className="lrn-block-title">群友画像学习（自动筛活跃群成员，学完直接写进 profiles → 画像页立刻可见）</div>

      <div className="lrn-grid">
        <div className="switch-row" style={{ gridColumn: '1 / -1' }}>
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          <div><span>启用画像学习</span><em>关闭后桥侧拒绝画像学习请求（含指令与自动触发）</em></div>
        </div>

        <div className="form-group">
          <label className="label">取样窗口（天）</label>
          <NumInput className="input" value={Math.round(cfg.windowHours / 24)}
            onCommit={(n) => patch({ windowHours: Math.max(1, Math.round(n) || 1) * 24 })} />
        </div>
        <div className="form-group">
          <label className="label">最少发言条数</label>
          <NumInput className="input" value={cfg.minMessages}
            onCommit={(n) => patch({ minMessages: Math.max(1, Math.round(n) || 1) })} />
        </div>
        <div className="form-group">
          <label className="label">单轮最多目标数</label>
          <NumInput className="input" value={cfg.maxTargets}
            onCommit={(n) => patch({ maxTargets: Math.max(1, Math.round(n) || 1) })} />
        </div>

        <div className="switch-row" style={{ gridColumn: '1 / -1' }}>
          <input type="checkbox" checked={cfg.autoIntervalEnabled} onChange={(e) => patch({ autoIntervalEnabled: e.target.checked })} />
          <div><span>自动间隔学习</span><em>距上次成功学习满下面这个间隔就自动跑一轮</em></div>
        </div>
        <div className="form-group">
          <label className="label">间隔（小时）</label>
          <NumInput className="input" value={cfg.autoIntervalHours}
            onCommit={(n) => patch({ autoIntervalHours: Math.max(1, Math.round(n) || 1) })} />
        </div>
        <div className="form-group">
          <label className="label">每日定时（北京时，留空=不定时）</label>
          <input className="input" type="text" inputMode="numeric" placeholder="如 04:00" value={cfg.timeHHMM}
            onChange={(e) => patch({ timeHHMM: normHHMM(e.target.value) })} />
        </div>
      </div>

      <div className="lrn-actions">
        <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={save}>
          {busy === 'save' ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 保存配置
        </button>
        <button className="btn btn-soft-primary btn-sm" disabled={busy !== null} onClick={() => act('start')}>
          {busy === 'start' ? <Loader2 size={14} className="spin" /> : <Play size={14} />} 画像立即学习
        </button>
        <button className="btn btn-outline-danger btn-sm" disabled={busy !== null} onClick={() => act('stop')}>
          {busy === 'stop' ? <Loader2 size={14} className="spin" /> : <Square size={14} />} 停止学习
        </button>
        {msg && <span className="lrn-updated">{msg}</span>}
      </div>

      <div className="lrn-status-list" style={{ marginTop: 10 }}>
        <div className="lrn-status-meta">
          <Clock3 size={13} /> 上次自动学习：{num(status?.config?.lastRunAtMs) > 0 ? bjClock(num(status?.config?.lastRunAtMs)) : '尚未跑过'}
          {' · '}进行中 {LEARNING} 个
          {lastTargets.length > 0 && <> · 最近一轮目标 {lastTargets.length} 个</>}
        </div>
        {list.length > 0 && (
          <div className="lrn-status-preview">
            {list.slice(0, 12).map((it: any) => `${it.uid}${it.nickname ? `（${it.nickname}）` : ''} ${it.state === 'learning' ? '学习中' : '空闲'}${num(it.samples) > 0 ? ` · 样本 ${num(it.samples)} 条` : ''}`).join('；')}
            {list.length > 12 ? ' …' : ''}
          </div>
        )}
      </div>
    </div>
  );
}
