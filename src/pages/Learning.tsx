import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import NumInput from '../components/NumInput';
import {
  getLearningConfig, saveLearningConfig, slangAction, personaAction, personaApply, portraitAction, getTokenReport, getSlangLibrary, getPersonProfile,
  reconcileTokens, slangBatchReject, slangResearch, slangBatchDelete,
} from '../api';
import type { SlangEntry, SlangLearnPhase, SlangLearningState } from '../api';
import {
  ArrowLeft, Save, Play, Square, RefreshCw, Loader2, AlertTriangle,
  Activity, TrendingUp, Users, Clock3, Zap, BarChart3, Wallet, RotateCcw, BookOpen, Scale,
  Check, X, Search, Wand2, Trash2,
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
/** 【2026-09-19 主人要求改写】读学习配置失败时的**第二行说明**（提示条里的一句，不是文档）。
 *  以前这里是一句写死的「学习接口来自桥侧新版本：请先更新并启动桥接…」——
 *  它把"桥没在运行"和"桥版本旧"混成一件，于是桥只是没启动的人会去更新一个不需要更新的桥。
 *  现在按服务端给的 code 分两种说法，各说清"现在不能做什么 + 下一步做什么"：
 *    · bridge-offline：对端根本没应答（进程没起 / 隧道没建 / 超时）→ 去把桥启动起来；
 *    · bridge-stale  ：桥答了，但它的版本里没有这条路由 → 这才是要更新桥代码的那种。 */
const learningErrDetail = (code: string, hasCfg: boolean): string => {
  if (code === 'bridge-offline') {
    // 分两种：从来没读到过（下面显示的是默认值）/ 读到过、这次重读失败（下面还是上次的值）。
    // 这两种都不该假装知道桥上的当前值，所以句子分开写。
    return hasCfg
      ? '桥没在运行，这次重读没成功：下面还是上次读到的值，可以继续看和改。启动桥（首页「一键启动整套」，远端就先点「连接」）后点重试。'
      : '桥没在运行，这份配置暂时读不到：下面字段里是默认值，不是桥上保存的设置。启动桥（首页「一键启动整套」，远端就先点「连接」）后点重试。';
  }
  if (code === 'bridge-stale') return '桥在运行，但它的版本里没有学习接口：把桥代码更新到最新并重启桥，再点重试。';
  return '点重试重新读一次；若一直失败，看上面那句里的具体原因。';
};
/** api() 抛出的 HTTP 错误 → 人话：404 基本等于「管理端还没转发这条桥接口」，
 *  直接抛 `API /xx -> HTTP 404` 会让主人以为桥坏了，这里补一句可落地的说明。 */
const apiErrText = (e: any): string => {
  const t = String(e?.message ?? e);
  const m = /API (\S+) -> HTTP (\d+)/.exec(t);
  if (m && m[2] === '404') {
    return `管理端没有转发该接口（HTTP 404：${m[1]}）——需要在 server 侧加一条到桥同名端点的代理`;
  }
  return t;
};
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
  /** 英文人设正文（桥侧 persona-library[uid].personaEn，随 status 一起回来）：主人审批/修正的对象 */
  personaEn: string;
  /** 审批痕迹：最近一次「保存修正」/「覆盖机器人人设」的时刻 */
  personaEditedAtMs: number;
  personaAppliedAtMs: number;
  /** 是否在 learning-config persona.targetQQ（人格学习目标列表）里；false 的多半是「画像学习」自动筛出来的 */
  inTargetList: boolean;
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
    // 老桥没有这几个字段 → 空值/0/false 走"没有英文人设正文"的老档案分支，不假装有
    personaEn: String(isObj(it) ? (it.personaEn ?? '') : ''),
    personaEditedAtMs: isObj(it) ? num(it.personaEditedAtMs) : 0,
    personaAppliedAtMs: isObj(it) ? num(it.personaAppliedAtMs) : 0,
    inTargetList: isObj(it) ? it.inTargetList !== false : true,
  }));
}

/* ---------- 黑话「学习状态机」（只用桥返回的 learning 快照，不做派生猜测） ---------- */
const SLANG_PHASES: SlangLearnPhase[] = ['disabled', 'extracting', 'stopping', 'queued', 'researching', 'ready', 'idle'];
/** 桥侧 GET /api/slang 的 learning 快照归一化。
 *  契约（桥侧已确认）：字段缺失/类型飘忽一律给安全默认值；**phase 不认识时整体判为"拿不到"（返回 null）**，
 *  绝不退化成某个默认阶段 —— 显示一个假状态比不显示更糟。 */
function normSlangLearning(raw: any): SlangLearningState | null {
  const phase = String(raw?.phase ?? '') as SlangLearnPhase;
  if (!SLANG_PHASES.includes(phase)) return null;
  const c = isObj(raw?.counts) ? raw.counts : {};
  return {
    phase,
    enabled: raw?.enabled !== false,
    inFlight: raw?.inFlight === true,
    queuedOps: num(raw?.queuedOps),
    stopRequested: raw?.stopRequested === true,
    researching: num(raw?.researching),
    learnerSessionActive: raw?.learnerSessionActive === true,
    lastLearnAtMs: num(raw?.lastLearnAtMs),
    counts: {
      candidate: num(c.candidate),
      confirmed: num(c.confirmed),
      rejected: num(c.rejected),
      total: num(c.total),
    },
  };
}
/** 每个 phase 的文案（**照桥侧确认的语义映射，不改含义**）+ 徽章样式。
 *  只有 extracting / researching 是"进行中样式"（转圈 + 呼吸高亮），其余是静态徽章。 */
const SLANG_PHASE_UI: Record<SlangLearnPhase, { label: string; cls: string; note: string; active?: boolean }> = {
  disabled: { label: '已关闭', cls: 'badge badge-soft', note: '黑话学习总开关没开（enabled=false）：桥侧会跳过所有黑话学习' },
  extracting: { label: '学习中（提取+研究）', cls: 'badge badge-warn', note: '正在批量提取语料并研究候选，本轮跑完自动落库', active: true },
  stopping: { label: '正在停止…', cls: 'badge badge-soft', note: '已收到停止请求，等当前分块结束就收尾（已经学到的不会丢）' },
  queued: { label: '排队中', cls: 'badge badge-info', note: '有已排队还没开始的任务在等前面的跑完' },
  researching: { label: '分析中（研究）', cls: 'badge badge-warn', note: '有候选正在研究会话里分析含义，拿到含义后桥侧会自动转成「已确认」', active: true },
  ready: { label: '空闲（随时可开始）', cls: 'badge badge-success', note: '学习会话已经建好，当前没有任务，随时可以再学一轮' },
  idle: { label: '空闲', cls: 'badge badge-soft', note: '没有学习会话、也没有任务，等下一次定时或手动学习触发' },
};

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
  /** 【2026-09-19】读配置失败时带上桥侧返回的 code（'bridge-offline' / 'bridge-stale'），
   *  用来把"桥没在跑"和"桥版本旧"分开说 —— 这两件事的下一步完全不同，混在一句里
   *  会把只是没启动桥的人指去升级桥。 */
  const [loadErrCode, setLoadErrCode] = useState<string>('');
  /** 桥没在运行、但那**文件本身**读到了（服务端直读/直写 state/learning-config.json）：
   *  值是服务端回来的 fallback 来源（'local-file' = 本机那份 / 'remote-file' = 服务端那份，经 SSH），
   *  空串 = 正常（配置是从桥控制台取的）。这时配置照常可看可改，只有依赖桥运行时的部分用不了。 */
  const [bridgeDown, setBridgeDown] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  // 【2026-09-16 修「按钮串台」】以前整页只有一个 busy，黑话区与人格区共用，于是：
  //   ① 两个区块的「保存配置」是**同一个 handler**（body 里 slang + persona 一起提交）→ 点黑话区的保存会连带写人格配置；
  //   ② busy === 'save' 时两处的保存按钮**同时转圈**，busy !== null 时两区的按钮一起变灰 → 视觉上"两个都在跑"；
  //   ③ 画像区（PortraitLearnBlock）自带一套同名 busy，又完全不受这里约束 → 黑话学习还在跑时还能再点画像立即学习，
  //      两个学习并行跑，看起来就是"点一个、另一个也一起跑"。
  //   现在拆成互不影响的三套：黑话 slangBusy / 人格 personaBusy / 画像（子组件内部自管）。
  const [slangBusy, setSlangBusy] = useState<string | null>(null);
  const [personaBusy, setPersonaBusy] = useState<string | null>(null);

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
  // 英文人设正文（personaEn）的编辑草稿 / 进行中的动作 / 每行结果提示。
  // 草稿单独存：60 秒静默轮询会重刷 pStatus，直接改源对象会把主人正在敲的字冲掉。
  const [peDraft, setPeDraft] = useState<Record<string, string>>({});
  const [peBusy, setPeBusy] = useState<string>('');   // `${mode}:${uid}`
  const [peNote, setPeNote] = useState<Record<string, string>>({});

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

  /** 人格学习的目标名单（左侧卡片「目标 QQ」里配的人）。
   *  只学名单里的人是主人要求的边界：名单外的人（「画像学习」按活跃度自动筛出来的群友、
   *  或主人指令里临时带的号码）档案能看，但**不许一键变成机器人自己的人设** —— 覆盖按钮直接禁用。 */
  const personaTargets = useMemo(
    () => new Set<string>(Array.isArray(cfg?.persona?.targetQQ) ? cfg.persona.targetQQ.map((x: any) => String(x)) : []),
    [cfg?.persona?.targetQQ],
  );
  /** 右卡两栏的"分家"（2026-09-15 主人要求：人格学习要和画像学习分立）：
   *   · 人格学习栏 = **只有目标名单里的人**（左侧「目标 QQ」里配的）；
   *   · 画像学习栏 = 名单外的那些（画像学习按活跃度自动筛出来的群友，以及主人指令里临时带的号）。
   *  以前学的那些人大多来自画像学习，就会**自动落到画像学习栏**，不再混在人格学习栏里；
   *  人设覆盖按钮也因此只会长在目标身上。 */
  const inTargetOf = (it: PItem): boolean => (cfg ? personaTargets.has(String(it.uid)) : it.inTargetList === true);
  const pTargetRows = useMemo(() => pStatus.filter((it) => inTargetOf(it)), [pStatus, cfg, personaTargets]);
  const pOtherRows = useMemo(() => pStatus.filter((it) => !inTargetOf(it)), [pStatus, cfg, personaTargets]);
  /** 框里当前该显示的正文：有草稿用草稿，否则用桥侧库里的值 */
  const peValueOf = (it: PItem): string => (peDraft[it.uid] !== undefined ? peDraft[it.uid] : String(it.personaEn ?? ''));
  const peErrOf = (r: any): string => firstErr(r) || String(unwrap(r)?.error ?? '');

  /** 「结合原人设完善」：让桥侧跑一轮模型，把学到的特点**融进当前的 persona.md**（增删改），
   *  产出的是**草稿**——只填进下面的框里让你看/改，绝不自动写盘。
   *  【2026-09-15 主人要求】覆盖人设不该只有"整篇替换"：更多时候要的是在原有基础上"完善"。 */
  const fusePersonaEn = async (uid: string) => {
    if (peBusy) return;
    setPeBusy(`fuse:${uid}`);
    setPeNote((m) => ({ ...m, [uid]: '正在结合当前人设生成完善稿（要跑一轮模型，十几秒到一分钟）…' }));
    try {
      const r: any = await personaApply(uid, 'fuse');
      const e = peErrOf(r);
      if (e) { setPeNote((m) => ({ ...m, [uid]: `生成完善稿失败：${e}` })); return; }
      const res = unwrap(r);
      const text = String(res?.text ?? '');
      if (!text.trim()) { setPeNote((m) => ({ ...m, [uid]: '生成完善稿失败：模型返回空内容' })); return; }
      setPeDraft((m) => ({ ...m, [uid]: text }));
      setPeNote((m) => ({
        ...m,
        [uid]: `已生成完善稿草稿（${num(res.chars) || text.length} 字；原人设 ${num(res.currentChars)} 字）。`
          + `**还没有生效**：先看/改下面的稿子，满意再点「整篇覆盖人设」写进去（会自动备份旧人设）。`,
      }));
    } catch (err: any) {
      setPeNote((m) => ({ ...m, [uid]: `生成完善稿失败：${apiErrText(err)}` }));
    } finally { setPeBusy(''); }
  };

  /** 「保存修正」：把框里的文字写回该 uid 的 personaEn（机器人当前人设不动） */
  const savePersonaEn = async (uid: string, text: string) => {
    if (peBusy) return;
    setPeBusy(`save:${uid}`);
    setPeNote((m) => ({ ...m, [uid]: '正在保存修正…' }));
    try {
      const r: any = await personaApply(uid, 'save', text);
      const e = peErrOf(r);
      if (e) { setPeNote((m) => ({ ...m, [uid]: `保存修正失败：${e}` })); return; }
      const res = unwrap(r);
      setPeDraft((m) => { const n = { ...m }; delete n[uid]; return n; });   // 落库成功后以库里的值为准
      setPeNote((m) => ({ ...m, [uid]: `已保存修正（${num(res.savedChars) || text.trim().length} 字）。机器人当前人设没动，想让它生效再点「整篇覆盖人设」。` }));
      await refreshStatus(true);
    } catch (err: any) {
      setPeNote((m) => ({ ...m, [uid]: `保存修正失败：${apiErrText(err)}` }));
    } finally { setPeBusy(''); }
  };

  /** 「覆盖机器人人设」：把框里的正文写 qq-bridge/persona.md（桥侧自动备份旧人设，下一条消息起生效）。
   *  覆盖是**不可逆**的破坏性动作，所以先 confirm 把"会覆盖 / 会自动备份"说清楚。 */
  const applyPersonaEn = async (uid: string, text: string) => {
    if (peBusy) return;
    const ok = window.confirm(
      `确定把框里这段英文【整篇替换】机器人当前的人设吗？（写 qq-bridge/persona.md）\n\n`
      + `· 当前人设会自动备份成 persona.md.bak-<日期-时间>（同目录，最多保留 5 份）\n`
      + `· 下一条消息起就用新人设，不用重启桥\n`
      + `· 正文必须是纯英文，含中文会被桥侧拒回\n`
      + `· 只想在原有基础上"完善"而不是替换：先点左边「结合原人设完善」生成草稿，改好再来这里覆盖`,
    );
    if (!ok) return;
    setPeBusy(`apply:${uid}`);
    setPeNote((m) => ({ ...m, [uid]: '正在覆盖机器人人设…' }));
    try {
      const r: any = await personaApply(uid, 'apply', text);
      const e = peErrOf(r);
      if (e) { setPeNote((m) => ({ ...m, [uid]: `覆盖失败：${e}` })); return; }
      const res = unwrap(r);
      setPeDraft((m) => { const n = { ...m }; delete n[uid]; return n; });
      setPeNote((m) => ({
        ...m,
        [uid]: `已覆盖机器人人设：写入 ${num(res.bytes)} 字节`
          + `${res.backup ? `，旧人设已备份为 ${String(res.backup)}` : '（此前没有 persona.md，所以没有备份）'}`
          + `。下一条消息起生效，不用重启桥。`,
      }));
      await refreshStatus(true);
    } catch (err: any) {
      setPeNote((m) => ({ ...m, [uid]: `覆盖失败：${apiErrText(err)}` }));
    } finally { setPeBusy(''); }
  };

  // 黑话库弹窗
  const [slangOpen, setSlangOpen] = useState(false);
  const [slangEntries, setSlangEntries] = useState<SlangEntry[]>([]);
  const [slangErr, setSlangErr] = useState('');
  const [slangQ, setSlangQ] = useState('');
  // 黑话库批量审批：勾选的词条 id（只认当前可见的**未确认**列表里勾上的那些）+ 进行中的动作 + 弹窗内结果提示
  const [slangSel, setSlangSel] = useState<string[]>([]);
  // 黑话库弹窗自己的 busy（批量拒收/分析/删除），与页面左卡那套 slangBusy 完全分开
  const [slangLibBusy, setSlangLibBusy] = useState<string>('');
  const [slangNote, setSlangNote] = useState('');
  // 「已拒收」那一组默认折起来（它既不进「已确认」也不进「未确认」，但数据不能丢，想看就点开）
  const [slangShowRejected, setSlangShowRejected] = useState(false);
  // 黑话「学习状态机」快照（GET /api/slang 的 learning，桥侧 slangLearningState()）；老桥没有该字段时为 null
  const [slangLearn, setSlangLearn] = useState<SlangLearningState | null>(null);
  // 画像学习状态（右卡「画像学习」栏；来源 portraitAction('status')，与人格状态共用 60 秒静默轮询）
  const [ptStatus, setPtStatus] = useState<any>(null);
  const [ptErr, setPtErr] = useState('');

  const openSlangLib = async () => {
    setSlangOpen(true); setSlangErr(''); setSlangNote('');
    await refreshSlangLib(!!slangEntries.length);
  };
  /** 取黑话库：**同一次请求**既拿到词条，也拿到桥侧「学习状态机」快照（learning）。
   *  页面上那行「学习中」状态就靠它 —— 用桥的真实运行态，不是前端猜的。 */
  const refreshSlangLib = async (quiet = false) => {
    try {
      const r = await getSlangLibrary();
      const list: SlangEntry[] = Array.isArray(r?.entries) ? r.entries
        : (Array.isArray(r?.result?.entries) ? r.result.entries : (Array.isArray(r?.data?.entries) ? r.data.entries : []));
      setSlangEntries(list);
      setSlangLearn(isObj(r?.learning) ? normSlangLearning(r.learning) : null);
      // 列表重取后，把已经不存在的勾选丢掉（否则「已选 N 条」会算进幽灵词条）
      setSlangSel((prev) => (prev.length ? prev.filter((id) => list.some((e) => String(e?.id ?? '') === id)) : prev));
      setSlangErr('');
    } catch (e) {
      if (!quiet) setSlangErr(String((e as Error)?.message ?? e));
    }
  };

  /** 黑话库批量操作：reject = 批量拒收 / research = 批量分析（桥侧只研究候选词条）。
   *  【2026-09-16】「批量通过」已按主人要求去掉：研究会话明确确认后桥侧会自动转 confirmed（slang.js 里
   *  autoConfirmed 那段），人工批量通过是多余的。这里只留拒收与分析两条。
   *  动作完成后按最新状态重取列表，并把结果同时写进页面提示条与弹窗内提示（弹窗盖着页面，只有前者看不见）。 */
  const slangBatch = async (kind: 'reject' | 'research', ids: string[]) => {
    if (slangLibBusy) return;
    if (!ids.length) { setSlangNote('请先勾选要处理的词条（只有「未确认」那一组的候选能勾选）'); return; }
    const label = kind === 'reject' ? '批量拒收' : '批量分析';
    setSlangLibBusy(kind);
    setSlangNote(`${label}：已提交 ${ids.length} 条，等待桥侧回执…`);
    try {
      const r: any = kind === 'reject' ? await slangBatchReject(ids) : await slangResearch(ids);
      const e = firstErr(r);
      if (e) { const t = `${label}失败：${e}`; setMsg(t); setSlangNote(t); return; }
      const res = unwrap(r);
      const text = kind === 'reject'
        ? `批量拒收：已拒收 ${num(res.rejectedCount)} 条`
        : `批量分析：已提交 ${num(res.count)} 条候选词条的研究任务（桥侧后台串行跑，完成后自动补释义；研究会话确认后自动转「已确认」）`;
      setMsg(text); setSlangNote(text);
      setSlangSel([]);
      await refreshSlangLib(true);
    } catch (err: any) {
      const t = `${label}失败：${apiErrText(err)}`;
      setMsg(t); setSlangNote(t);
    } finally { setSlangLibBusy(''); }
  };

  /** 删除单条黑话（**已确认和未确认都能删**）：走桥侧 `POST /api/slang/batch-delete`，body `{ ids: [id] }`。
   *  接口契约（已与桥侧 console-server.js:763-789 对齐）：
   *    · 成功 → `{ ok: true, removedCount: N }`；
   *    · 一条都匹配不到 → 桥回 `404 { ok:false, error:'没有匹配到要删除的黑话' }`；
   *    · 桥那条路由**还支持** `{ status:'confirmed' }` 整批删 —— 界面上**故意不暴露**这个口子
   *      （需求是"单条可删"），所以这里永远只传 ids、且只传一个。
   *  删除不可逆、且会让机器人再也查不到这条词，所以先 confirm 把后果写清楚；任何失败都在页面上给出提示，绝不静默。 */
  const deleteSlang = async (e: SlangEntry) => {
    if (slangLibBusy) return;
    const id = String(e?.id ?? '');
    const word = String(e?.content ?? '').trim() || '(这条词条)';
    if (!id) { setSlangNote('这条词条没有 id（桥侧旧数据），删不掉'); return; }
    const ok = window.confirm(
      `确定删除黑话「${word}」吗？\n\n`
      + `· 删除后不可恢复\n`
      + `· 机器人将不再用这条黑话（qq_slang_query 查库里再也查不到它）\n`
      + `· 只是想让它暂时不生效、又想留档的话，用「批量拒收」更合适`,
    );
    if (!ok) return;
    setSlangLibBusy(`del:${id}`);
    setSlangNote(`正在删除「${word}」…`);
    try {
      const r: any = await slangBatchDelete([id]);
      const err = firstErr(r);
      if (err) {
        // 桥侧「一条都匹配不到」回的是 404，而管理端代理把桥的 404 统一改写成 code='bridge-stale'
        //（文案是"桥在运行，但没有这条接口（HTTP 404）…"）—— 对"这条词已经不在了"这种正常结果来说很误导。
        // 按契约把话说明白：两种可能都写出来，不猜死是哪一种。
        const stale = r?.code === 'bridge-stale' && /404/.test(String(r?.detail ?? ''));
        const why = stale
          ? '桥侧没有匹配到这条词条（大概已经被删掉了）。若确认它还在，请检查桥是否为最新版本（该接口不在旧桥上）'
          : err;
        const t = `删除「${word}」失败：${why}`;
        setMsg(t); setSlangNote(t);
        return;
      }
      const removed = num(unwrap(r).removedCount);
      const t = removed > 0
        ? `已删除黑话「${word}」（删除后不可恢复，机器人不再用这条黑话）`
        : `删除「${word}」失败：桥侧回执 removedCount=0，没有匹配到这条词条（可能已被别处删掉）`;
      setMsg(t); setSlangNote(t);
      if (removed > 0) setSlangSel((prev) => prev.filter((x) => x !== id));
      await refreshSlangLib(true);
    } catch (err: any) {
      const t = `删除「${word}」失败：${apiErrText(err)}`;
      setMsg(t); setSlangNote(t);
    } finally { setSlangLibBusy(''); }
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
      if (e) { setLoadErr(e); setLoadErrCode(String((r as any)?.code ?? '')); setBridgeDown(''); setCfg(null); return; }
      const c = isObj(r.config) ? r.config : r; // 兼容 {config:{...}} 与直接配置对象
      setCfg(c);
      setLoadErr('');
      setLoadErrCode('');
      // 服务端在"桥没在跑、改用文件兜底"时会带 bridgeDown=true + fallback（local-file / remote-file）：
      // 配置是真值、可看可改，但依赖桥运行时的功能不可用 —— 界面据此标出来，而不是假装一切正常。
      setBridgeDown((r as any)?.bridgeDown === true && typeof (r as any)?.fallback === 'string' ? String((r as any).fallback) : '');
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
      setLoadErr(String(err?.message ?? err)); setLoadErrCode(''); setBridgeDown(''); setCfg(null);
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

  /** 画像学习状态（右卡下面那一栏）。回包 { ok, result:{ config, lastTargets, status, running } } */
  const refreshPortrait = async (quiet = false) => {
    try {
      const r: any = await portraitAction('status');
      const e = firstErr(r);
      if (e) { if (!quiet) setPtErr(e); return; }
      setPtStatus(unwrap(r));
      setPtErr('');
    } catch (err: any) {
      if (!quiet) setPtErr(String(err?.message ?? err));
    }
  };

  // 进页拉一次配置、人格状态、画像学习状态与黑话库（含学习状态机）；状态区只读，无手动刷新按钮 → 60 秒静默轮询
  useEffect(() => {
    loadConfig(); refreshStatus(); refreshPortrait(); refreshSlangLib(true);
    const iv = setInterval(() => { refreshStatus(true); refreshPortrait(true); refreshSlangLib(true); }, 60000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 「黑话立即学习」进行中时把轮询加快到 5 秒：桥侧 phase 会一路 extracting → researching → ready 地变，
   *  60 秒一次看不出"跑到哪一步了"。请求本身回来（slangBusy 复位）就结束这个快轮询，不影响上面那条 60 秒的。 */
  useEffect(() => {
    if (slangBusy !== 'learn') return;
    const iv = setInterval(() => { void refreshSlangLib(true); }, 5000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slangBusy]);

  /** 区块级 busy 包装：**同一区块内**防重复点击，且只影响本区块的按钮与 loading。
   *  修「按钮串台」的关键：黑话区与人格区从此各用各的 state，点一边不会把另一边也点着、点灰。 */
  const busyRunner = (set: (v: string | null) => void, cur: string | null) =>
    (key: string, fn: () => Promise<void>) => async () => {
      if (cur) return;
      set(key); setMsg(null);
      try { await fn(); } finally { set(null); }
    };
  const slangRun = busyRunner(setSlangBusy, slangBusy);
  const personaRun = busyRunner(setPersonaBusy, personaBusy);

  /** 只提交**黑话**这一块的字段（⚠️ 桥侧 PUT 有白名单：`slang.lastLearnAtMs` / `persona.lastRunAtMs` /
   *  `portrait.*` 由模块自己维护，整包回传会被 400 拒绝 —— "slang 不支持字段：lastLearnAtMs" 就是这么来的）。
   *  【2026-09-16】以前黑话区与人格区共用同一个 save（body 里 slang + persona 一起发），
   *  点「黑话定时学习」里的保存按钮会连带把人格配置也写一遍 —— 这就是「按钮串台」的一半。现在拆开。 */
  const saveSlang = slangRun('save', async () => {
    const r = await saveLearningConfig({
      slang: {
        enabled: slgEnabled,
        timeHHMM: normHHMM(slgTime) || '00:00',
        autoResearch: slgResearch,
        liveWindowExtract: slgLiveWin,
        autoIntervalEnabled: slgIntv,
        autoIntervalHours: clampHrs(slgIntvHours),
      },
    });
    const e = firstErr(r);
    if (e) { setMsg(`保存失败：${e}`); return; }
    // 桥没在跑时服务端是直接写那份配置文件的（本机 / 服务端，见 server 的 learningConfigRoute）：
    // 写成功了，但"桥还没读到"要说清楚，别让人以为已经生效。
    setMsg((r as any)?.bridgeDown === true
      ? `桥没在运行：已写入${(r as any)?.fallback === 'remote-file' ? '服务端' : '本机'} qq-bridge/state/learning-config.json，桥下次启动或下一轮学习时生效`
      : '黑话学习配置已保存');
    await loadConfig();
    await refreshSlangLib(true);   // 只刷新黑话侧（含学习状态机），不碰人格 / 画像
  });

  /** 只提交**人格**这一块的字段 */
  const savePersona = personaRun('save', async () => {
    const r = await saveLearningConfig({
      persona: {
        enabled: perEnabled,
        targetQQ: qqs,
        autoIntervalEnabled: perIntv,
        autoIntervalHours: clampHrs(perIntvHours),
        timeHHMM: normHHMM(perTime),      // 每日定时（留空=不定时）
      },
    });
    const e = firstErr(r);
    if (e) { setMsg(`保存失败：${e}`); return; }
    setMsg((r as any)?.bridgeDown === true
      ? `桥没在运行：已写入${(r as any)?.fallback === 'remote-file' ? '服务端' : '本机'} qq-bridge/state/learning-config.json，桥下次启动或下一轮学习时生效`
      : '人格学习配置已保存');
    await loadConfig();
    await refreshStatus(true);
  });

  /** 「黑话立即学习」：**只打这一条桥接口**。桥侧这个请求会一直挂到本轮提取跑完才回，
   *  所以它是"现在正在提取"的最强真实信号；跑完后再取一次黑话库+学习状态机（研究可能还在后台继续）。
   *  【2026-09-16】这里以前还会顺手 refreshStatus(true)（人格状态），而右卡「画像学习」栏的数据源正是
   *  同一份 persona status（pOtherRows）——于是点完黑话学习，画像学习那一栏也跟着刷新，看着像"画像学习也跑了"。
   *  现在只刷黑话侧，黑话的按钮就只触发黑话的东西。 */
  const learnSlang = slangRun('learn', async () => {
    const r = await slangAction('learn');
    const e = firstErr(r);
    if (e) { setMsg(`失败：${e}`); return; }
    const res = unwrap(r);
    const text = pick('message', 'msg', 'detail')(res) || pick('message', 'msg', 'detail')(r);
    setMsg(text ? `黑话学习：${text}` : '已受理「黑话立即学习」：从上次学习点/今日 0 点起提取并研究，完成后置学习标记');
    await refreshSlangLib(true);
  });

  const stopSlang = slangRun('stop', async () => {
    const r = await slangAction('stop');
    const e = firstErr(r);
    if (e) { setMsg(`失败：${e}`); return; }
    const res = unwrap(r);
    const text = pick('message', 'msg', 'detail')(res) || pick('message', 'msg', 'detail')(r);
    setMsg(text ? `黑话学习：${text}` : '已请求停止进行中的黑话学习/研究任务');
    await refreshSlangLib(true);
  });

  const startPersona = personaRun('start', async () => {
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

  const stopPersona = personaRun('stop', async () => {
    const r = await personaAction('stop');
    const e = firstErr(r);
    if (e) { setMsg(`失败：${e}`); return; }
    const res = unwrap(r);
    const stopped = Array.isArray(res?.stopped) ? res.stopped.map(String) : [];
    setMsg(stopped.length ? `已请求停止 ${stopped.join('、')} 的学习（本轮结束后收尾，不写半成品）` : '当前没有进行中的人格学习');
    await refreshStatus(true);
  });

  const lastLearnAt = isObj(cfg?.slang) ? num(cfg.slang.lastLearnAtMs) : 0;

  /** 学习阶段：**只用桥返回的 learning 快照**。learning 为 null（旧桥 / 本次读取失败）时这里是 null，
   *  界面走"状态不可用"降级分支 —— 不派生、不猜一个阶段出来假装知道。 */
  const slangPhase = slangLearn ? SLANG_PHASE_UI[slangLearn.phase] : null;
  /** 分组计数：优先用桥的 `learning.counts`（就是黑话库的真实构成）；拿不到 learning 时按 entries 的真实
   *  status 自己算 —— 两者是同一份数据，用哪个都行。rejected 单独一组，不并进另外两组、也不丢。 */
  const slangCounts = useMemo(() => {
    if (slangLearn) return slangLearn.counts;
    const by = (st: string) => slangEntries.filter((e) => String(e?.status ?? '') === st).length;
    return { candidate: by('candidate'), confirmed: by('confirmed'), rejected: by('rejected'), total: slangEntries.length };
  }, [slangLearn, slangEntries]);

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
              {/* 【2026-09-19 主人要求：桥不可达不该让配置页变成不可用】
                  以前这里是 `loadErr ? <错误块> : <>...全部配置字段...</>` —— 桥一停，整块学习配置
                  （黑话定时 / 人格学习 / 目标 QQ）连同"保存配置"一起消失，只剩一句错误提示。
                  现在拆开：**错误归错误，配置照常显示、照常能改**。
                  桥没在跑时服务端会直接读写本机 qq-bridge/state/learning-config.json（见 server/index.js
                  的 learningConfigRoute），所以配置里显示的就是真实值，保存也确实写得进去；
                  真正依赖桥运行时的只有"立即学习 / 停止 / 学习状态 / 黑话库 / 用量"这几处，单独标注。 */}
              {bridgeDown && (
                <div className="lrn-inline-note" style={{ display: 'block', lineHeight: 1.75 }}>
                  <AlertTriangle size={13} /> <b>桥没在运行</b>：下面这份配置直接读自
                  <code>{bridgeDown === 'remote-file' ? ' 服务端 qq-bridge/state/learning-config.json' : ' 本机 qq-bridge/state/learning-config.json'}</code>
                  ，<b>能看、能改，保存也会写进去</b>（桥下次启动或下一轮学习就会用到）。
                  但"立即学习 / 停止 / 学习状态 / 黑话库 / 用量"这些要桥在跑才能用 —— 桥起来后点
                  <button type="button" className="btn btn-sm" style={{ margin: '0 4px' }}
                    disabled={slangBusy !== null || personaBusy !== null}
                    onClick={() => { void loadConfig(); void refreshStatus(true); void refreshPortrait(true); void refreshSlangLib(true); }}>
                    <RefreshCw size={12} /> 重新读取
                  </button>
                  即可。
                </div>
              )}
              {loadErr && (
                <div className="lrn-error">
                  <AlertTriangle size={15} />
                  <div style={{ flex: 1 }}>
                    {loadErr}
                    <div className="lrn-error-detail">{learningErrDetail(loadErrCode, !!cfg)}</div>
                  </div>
                  <button className="btn btn-sm btn-danger" disabled={slangBusy !== null || personaBusy !== null} onClick={() => { setLoadErr(''); loadConfig(); }}>
                    <RefreshCw size={13} /> 重试
                  </button>
                </div>
              )}

              <>
                  {/* 黑话定时学习 */}
                  <div className="lrn-block">
                    <div className="lrn-block-title">黑话定时学习</div>
                    {/* ——— 学习中状态机：数据源就是桥 GET /api/slang 的 learning 快照（null = 拿不到） ——— */}
                    {slangPhase ? (
                      <>
                        <div className={`lrn-learn-state${slangPhase.active ? ' is-active' : ''}${slangLearn?.phase === 'disabled' ? ' is-off' : ''}`}>
                          {slangPhase.active
                            ? <Loader2 size={13} className="spin" />
                            : slangLearn?.phase === 'disabled' ? <AlertTriangle size={13} /> : <Activity size={13} />}
                          <span className={slangPhase.cls}>{slangPhase.label}</span>
                          <span className="lrn-learn-note">{slangPhase.note}</span>
                        </div>
                        <div className="lrn-status-meta" style={{ marginTop: 4 }}>
                          <span>
                            <Clock3 size={13} /> 上次学习：{num(slangLearn?.lastLearnAtMs) > 0 ? bjClock(num(slangLearn?.lastLearnAtMs)) : '还没学过'}
                          </span>
                          <span>黑话库：{slangCounts.total} 条 · 已确认 {slangCounts.confirmed} · 未确认 {slangCounts.candidate}{slangCounts.rejected > 0 ? ` · 已拒收 ${slangCounts.rejected}` : ''}</span>
                          {num(slangLearn?.queuedOps) > 0 && <span>排队 {num(slangLearn?.queuedOps)} 个任务</span>}
                          {num(slangLearn?.researching) > 0 && <span>分析中的候选 {num(slangLearn?.researching)} 条</span>}
                          {slangLearn?.stopRequested === true && <span>已收到停止请求</span>}
                          {slangLearn?.learnerSessionActive === true && <span>学习会话已建立</span>}
                        </div>
                      </>
                    ) : (
                      /* 拿不到状态（旧桥没有 learning 字段 / 这次读取失败）：明确说"拿不到"，
                         不显示任何学习阶段 —— 假状态比没状态更糟。黑话库本身照常可看可改。 */
                      <>
                        <div className="lrn-learn-state is-unknown">
                          <AlertTriangle size={13} />
                          <span className="badge badge-soft">学习状态不可用</span>
                          <span className="lrn-learn-note">
                            桥这次没有返回 learning 快照（旧版桥，或这次读取失败）。这里不显示学习阶段，免得显示一个假状态；
                            黑话库本身照常可看、可改、可删。
                          </span>
                          <button type="button" className="btn btn-sm" disabled={slangBusy !== null} onClick={() => refreshSlangLib()}>
                            <RefreshCw size={12} /> 重新读取
                          </button>
                        </div>
                        <div className="lrn-status-meta" style={{ marginTop: 4 }}>
                          <span>黑话库：{slangCounts.total} 条 · 已确认 {slangCounts.confirmed} · 未确认 {slangCounts.candidate}{slangCounts.rejected > 0 ? ` · 已拒收 ${slangCounts.rejected}` : ''}</span>
                        </div>
                      </>
                    )}
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
                      <button className="btn btn-primary btn-sm" disabled={slangBusy !== null} onClick={saveSlang}>
                        {slangBusy === 'save' ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 保存配置
                      </button>
                      <button className="btn btn-soft-primary btn-sm" disabled={slangBusy !== null} onClick={learnSlang}>
                        {slangBusy === 'learn' ? <Loader2 size={14} className="spin" /> : <Play size={14} />} 黑话立即学习
                      </button>
                      <button className="btn btn-outline-danger btn-sm" disabled={slangBusy !== null} onClick={stopSlang}>
                        {slangBusy === 'stop' ? <Loader2 size={14} className="spin" /> : <Square size={14} />} 停止学习
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
                      <button className="btn btn-primary btn-sm" disabled={personaBusy !== null} onClick={savePersona}>
                        {personaBusy === 'save' ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 保存配置
                      </button>
                      <button className="btn btn-soft-primary btn-sm" disabled={personaBusy !== null} onClick={startPersona}>
                        {personaBusy === 'start' ? <Loader2 size={14} className="spin" /> : <Play size={14} />} 人格立即学习
                      </button>
                      <button className="btn btn-outline-danger btn-sm" disabled={personaBusy !== null} onClick={stopPersona}>
                        {personaBusy === 'stop' ? <Loader2 size={14} className="spin" /> : <Square size={14} />} 停止学习
                      </button>
                    </div>
                  </div>

                  {/* 群友画像学习：目标自动从聊天记录里筛，落回 profiles 表 → 群友画像页立刻可见 */}
                  <PortraitLearnBlock />
                </>
            </div>

            {/* ============ 右：人格学习状态（与左卡片等高；上下两栏：人格学习 / 画像学习；超出滚动；点开看完整资料）
                【2026-09-19 为什么外面多包了一层 .lrn-status-col】
                主人要的是「粉色板里的滚动区铺到板底、但整行不许被拉长」。这两条同时要满足，
                就必须让右卡**完全不参与行高计算** —— 否则它内容一多就把 grid 的 auto 行撑高：
                  · .lrn-status-col 是个 position: relative 的 grid item（被 align-items: stretch 拉到行高），
                    它自己不产生任何内容高度（唯一的孩子是绝对定位）；
                  · 里面那张卡 position: absolute; inset: 0 —— 于是它**精确等于左栏撑出来的高度**，
                    内容再多也只是自己内部滚动，撑不到外面去。
                之前用 `.lrn-status-block-fill .lrn-status-scroll { max-height: 720px }` 这种手调上限
                就是在硬凑这件事（历史上调过三次 300→640→720），左栏一变高就露馅。 */}
            <div className="lrn-status-col">
            <div className="card lrn-status-card">
              <div className="card-title">
                <Users size={17} /> 人格学习状态
                <span className="lrn-updated">只读展示 · 每 60 秒自动刷新{statusAt ? ` · 更新于 ${statusAt}` : ''}</span>
              </div>
              <div className="lrn-status-body">
              {/* ——— 上面一栏：人格学习（现有那批人格学习目标；点一条展开看完整资料，行为不变） ——— */}
              <div className="lrn-status-block">
                <div className="lrn-block-title">人格学习<span className="lrn-status-hint">只学「目标 QQ」里的人 · 点一条看完整资料</span></div>
                {/* 主人看到的现状是"学完只攒了个性格档案"——这里把边界和出口写在栏标题上：
                    学谁、学完怎么变成机器人自己的人设。 */}
                <div style={{ margin: '-4px 0 8px', fontSize: 11.5, lineHeight: 1.65, color: 'var(--nc-foreground-400)' }}>
                  只学左侧「目标 QQ」里配的人，这一栏也只列**目标名单里的人**。展开一条可以看到学习产出的
                  <b>英文人设正文</b>，可以「结合原人设完善」（在现有基础上按学到的特点增删改，先出草稿）或直接「整篇覆盖人设」。
                  {pOtherRows.length > 0 && (
                    <> 另外 {pOtherRows.length} 个人的档案不在目标名单里（画像学习自动筛出来的），已归到下面「画像学习」栏。</>
                  )}
                </div>
              {statusErr ? (
                <div className="lrn-error">
                  <AlertTriangle size={15} />
                  <div style={{ flex: 1 }}>{statusErr}</div>
                  <button className="btn btn-sm btn-danger" onClick={() => refreshStatus()}><RefreshCw size={13} /> 重试</button>
                </div>
              ) : pTargetRows.length === 0 ? (
                <div className="empty-state" style={{ padding: '34px 12px' }}>
                  <Users size={34} style={{ color: 'var(--nc-foreground-300)', marginBottom: 10 }} />
                  <div style={{ color: 'var(--nc-foreground-400)', fontSize: 13 }}>
                    {pOtherRows.length > 0
                      ? <>目标名单里还没有档案<br />（另外 {pOtherRows.length} 个人的档案在下面「画像学习」栏）<br />点「人格立即学习」开始学目标 QQ</>
                      : <>暂无档案<br />学习过 / 正在学习的目标会显示在这里（点「人格立即学习」开始）</>}
                  </div>
                </div>
              ) : (
                <div className="lrn-status-list lrn-status-scroll">
                  {pTargetRows.map((it) => {
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
                            // 目标列表以本页读到的学习配置为准（和左侧「目标 QQ」同一份）；配置没读到时
                            // 退回桥侧 status 的 inTargetList，别因为一次加载失败就把按钮全禁了。
                            const inTarget = cfg ? personaTargets.has(it.uid) : it.inTargetList;
                            // 英文人设正文：库里有就展示（可编辑），没有走"旧版档案"提示，绝不假装有
                            const peLib = String(it.personaEn || lib?.personaEn || '').trim();
                            const peText = peValueOf(it);
                            const peHasDraft = peDraft[it.uid] !== undefined;
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

                              {/* 英文人设正文（personaEn）：人格学习这一轮的**成品**，主人在这里审批/修正，
                                  再一键覆盖机器人自己的人设。整块 stopPropagation：不清掉冒泡的话，
                                  在框里打字会触发整行的「点一下收起」，字还没敲完卡片就合上了。 */}
                              <div
                                className="lrn-wide"
                                style={{
                                  marginTop: 6, padding: '8px 10px', borderRadius: 8,
                                  background: 'hsl(339.13 92% 97.2% / .75)',
                                  border: '1px solid hsl(339.33 90% 90% / .9)',
                                }}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <span className="lrn-dk">英文人设正文</span>
                                {!inTarget && (
                                  <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.6, color: 'var(--nc-danger-600)' }}>
                                    该目标不在人格学习目标列表里（左侧「目标 QQ」里配的才算；这一条多半是「画像学习」自动筛出来的），只能看，不能覆盖机器人人设。
                                  </div>
                                )}
                                {!peLib && !peHasDraft && (
                                  <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.6, color: 'var(--nc-foreground-400)' }}>
                                    这条档案是旧版学的，还没有英文人设正文：重跑一次人格学习就会生成
                                    {inTarget ? '（也可以在下面自己写一段纯英文，再点保存或覆盖）' : ''}。
                                  </div>
                                )}
                                {(inTarget || !!peLib) && (
                                  <textarea
                                    value={peText}
                                    readOnly={!inTarget}
                                    onChange={(e) => setPeDraft((m) => ({ ...m, [it.uid]: e.target.value }))}
                                    rows={7}
                                    spellCheck={false}
                                    placeholder="纯英文人设正文（150~400 词）：你是谁、怎么说话、在意什么、什么口吻、忌讳什么。含中文会被桥侧拒回。"
                                    style={{
                                      width: '100%', marginTop: 5, padding: '7px 9px', boxSizing: 'border-box',
                                      fontSize: 12.5, lineHeight: 1.6, borderRadius: 8,
                                      border: '1px solid hsl(339.33 90% 88%)',
                                      background: inTarget ? '#fff' : 'hsl(339.13 92% 98%)',
                                      color: 'var(--nc-foreground-800)', resize: 'vertical',
                                    }}
                                  />
                                )}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                                  <button
                                    className="btn btn-soft-primary btn-sm"
                                    disabled={!!peBusy || !inTarget || !peLib}
                                    title={inTarget
                                      ? '让桥跑一轮模型：把学到的特点融进【当前机器人人设】重新增删改，产出一份草稿填到框里（不写盘，你确认后再覆盖）'
                                      : '该目标不在人格学习目标列表里，不能用'}
                                    onClick={() => fusePersonaEn(it.uid)}
                                  >
                                    {peBusy === `fuse:${it.uid}` ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />} 结合原人设完善
                                  </button>
                                  <button
                                    className="btn btn-soft-primary btn-sm"
                                    disabled={!!peBusy || !inTarget || !peText.trim()}
                                    title={inTarget ? '把框里的正文写回这条档案（机器人当前人设不动）' : '该目标不在人格学习目标列表里，不能改'}
                                    onClick={() => savePersonaEn(it.uid, peText)}
                                  >
                                    {peBusy === `save:${it.uid}` ? <Loader2 size={13} className="spin" /> : <Save size={13} />} 保存修正
                                  </button>
                                  <button
                                    className="btn btn-primary btn-sm"
                                    disabled={!!peBusy || !inTarget || !peText.trim()}
                                    title={inTarget ? '用框里的这段英文【整篇替换】机器人当前人设（旧人设自动备份）' : '该目标不在人格学习目标列表里，不能覆盖'}
                                    onClick={() => applyPersonaEn(it.uid, peText)}
                                  >
                                    {peBusy === `apply:${it.uid}` ? <Loader2 size={13} className="spin" /> : <Zap size={13} />} 整篇覆盖人设
                                  </button>
                                  {num(it.personaEditedAtMs) > 0 && <span style={{ fontSize: 11.5, color: 'var(--nc-foreground-400)' }}>上次修正 {bjClock(num(it.personaEditedAtMs))}</span>}
                                  {num(it.personaAppliedAtMs) > 0 && <span style={{ fontSize: 11.5, color: 'var(--nc-foreground-400)' }}>上次覆盖 {bjClock(num(it.personaAppliedAtMs))}</span>}
                                </div>
                                <div style={{ marginTop: 5, fontSize: 11.5, lineHeight: 1.65, color: 'var(--nc-foreground-400)' }}>
                                  两种用法：<b>「结合原人设完善」</b>＝在现在的人设上按学到的特点增删改，产出一份草稿（<b>不写盘</b>，你改好再覆盖）；
                                  <b>「整篇覆盖人设」</b>＝直接用框里这段替换掉当前人设（覆盖前自动备份，下一条消息生效）。
                                </div>
                                {peNote[it.uid] && (
                                  <div style={{ marginTop: 5, fontSize: 12, lineHeight: 1.6, color: 'var(--nc-foreground-500)' }}>{peNote[it.uid]}</div>
                                )}
                              </div>
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

              <div className="lrn-divider" />

              {/* ——— 下面一栏：画像学习（portraitAction('status') 的 config / status / lastTargets / running）———
                  这一栏 flex: 1：卡片被左卡拉高时由它吃满余量，资料区一直铺到卡底，不留死空白。 */}
              <div className="lrn-status-block lrn-status-block-fill">
                <div className="lrn-block-title">
                  画像学习
                  <button className="btn btn-sm lrn-block-refresh" onClick={() => refreshPortrait()} title="重新读一次画像学习状态（平时每 60 秒自动刷新）">
                    <RefreshCw size={12} /> 刷新
                  </button>
                </div>
                {ptErr ? (
                  <div className="lrn-error">
                    <AlertTriangle size={15} />
                    <div style={{ flex: 1 }}>{ptErr}</div>
                    <button className="btn btn-sm btn-danger" onClick={() => refreshPortrait()}><RefreshCw size={13} /> 重试</button>
                  </div>
                ) : !ptStatus ? (
                  <div className="lrn-status-meta"><Loader2 size={13} className="spin" /> 正在读取画像学习状态…</div>
                ) : (() => {
                  const ptCfg: Record<string, any> = isObj(ptStatus?.config) ? ptStatus.config : {};
                  const ptList: any[] = Array.isArray(ptStatus?.status) ? ptStatus.status : [];
                  const ptLast: string[] = Array.isArray(ptStatus?.lastTargets) ? ptStatus.lastTargets.map(String) : [];
                  const winDays = Math.max(1, Math.round(num(ptCfg.windowHours) / 24) || 1);
                  const ptTime = typeof ptCfg.timeHHMM === 'string' ? ptCfg.timeHHMM.trim() : '';
                  // 「进行中」按**这一栏真正列出来的档案**数，避免和上面的列表对不上
                  const ptLearning = pOtherRows.filter((x) => x.state === 'learning').length;
                  // 画像学习自己记录过、但库里还没有档案的目标（刚跑完还没落库）：单独列一行，不假装有资料
                  const ptOnlyUids = ptList.map((x: any) => String(x?.uid ?? '')).filter((u) => u && !pOtherRows.some((r) => String(r.uid) === u));
                  return (
                    <>
                      {/* 【2026-09-16 主人要求】标题、刷新按钮与这两行摘要**留在滚动区外**（头部固定），
                          只有下面的档案列表限高滚动 —— 画像学习这一栏不再把整张卡无限拉高。 */}
                      <div className="lrn-status-meta lrn-portrait-head">
                        <Clock3 size={13} /> 上次自动学习：{num(ptCfg.lastRunAtMs) > 0 ? bjClock(num(ptCfg.lastRunAtMs)) : '尚未跑过'}
                        {' · '}进行中 {ptLearning} 个
                        {ptLast.length > 0 && <> · 最近一轮目标 {ptLast.length} 个</>}
                        {ptCfg.enabled === false && <span className="badge badge-soft">已停用</span>}
                        {ptStatus?.running === true && <span className="badge badge-warn">正在跑</span>}
                      </div>
                      <div className="lrn-status-meta lrn-portrait-head">
                        取样窗口 {winDays} 天 · 最少发言 {num(ptCfg.minMessages)} 条 · 单轮最多 {num(ptCfg.maxTargets)} 个目标
                        {ptCfg.autoIntervalEnabled === true ? ` · 每 ${num(ptCfg.autoIntervalHours)} 小时自动一次` : ''}
                        {ptTime ? ` · 每日定时 ${ptTime}` : ''}
                      </div>
                      <div className="lrn-status-list lrn-status-scroll">
                      {/* 名单外的档案（含"以前学过的那些群友"）全部列在这一栏：点一条**展开/收起**完整资料，
                          展示字段与上面人格学习栏一致，但**没有**英文人设正文与「覆盖机器人人设」——
                          人设只能来自目标名单。 */}
                      {pOtherRows.map((it: PItem) => {
                        const uid = String(it.uid);
                        const open = openUid === uid;
                        const d = profDetail[uid] || null;
                        return (
                          <div className={`lrn-status-row${open ? ' is-open' : ''}`} key={uid} id={`lrn-row-${uid}`}
                            onClick={() => openProfile(uid)} title={open ? '点一下收起资料' : '点一下看完整资料'}>
                            <div className="lrn-status-main">
                              <div className="lrn-status-uid">
                                <b>{uid}</b>
                                {it.nickname && <span className="lrn-nick">{it.nickname}</span>}
                                <span className="lrn-status-caret">{open ? '收起 ▾' : '展开 ▸'}</span>
                              </div>
                              <div className="lrn-status-meta">
                                {it.state === 'learning'
                                  ? <span className="badge badge-warn">学习中…</span>
                                  : it.learnedAtMs > 0
                                    ? <span className="badge badge-success">已学习</span>
                                    : <span className="badge badge-soft">无资料</span>}
                                <span>{it.learnedAtMs > 0 ? `最近学习 ${bjClock(it.learnedAtMs)}` : '尚未学习'}</span>
                                {it.samples > 0 && <span>样本 {it.samples} 条</span>}
                                <span className="badge badge-soft">画像</span>
                              </div>
                              {!open && it.preview && <div className="lrn-status-preview">{it.preview}</div>}
                              {open && <PortraitDetail it={it} detail={d} busy={profBusy === uid} err={profErr[uid]} />}
                            </div>
                          </div>
                        );
                      })}
                      {pOtherRows.length === 0 && (
                        <div className="lrn-status-preview" style={{ borderLeft: 'none', paddingLeft: 0 }}>
                          {pStatus.length === 0
                            ? '还没有任何档案：点左侧「画像立即学习」按配置自动筛活跃群成员，或打开自动间隔 / 每日定时。'
                            : '目标名单以外的档案是空的（学过的都是目标名单里的人，或画像学习还没跑过）。'}
                        </div>
                      )}
                      {ptOnlyUids.length > 0 && (
                        <div className="lrn-status-preview" style={{ borderLeft: 'none', paddingLeft: 0 }}>
                          最近一轮画像学习到过 {ptOnlyUids.length} 个人但还没落下档案：{ptOnlyUids.slice(0, 12).join('、')}{ptOnlyUids.length > 12 ? ' …' : ''}
                        </div>
                      )}
                      </div>
                    </>
                  );
                })()}
              </div>
              </div>
            </div>
            </div>
          </div>

          {/* ============ 黑话库弹窗：分「已确认 / 未确认（候选）/ 已拒收」三组（已拒收默认折叠）；
              只有未确认的行能勾选；每条都有删除入口（二次确认）；
              【2026-09-16】已去掉「批量通过」（研究会话确认后桥侧自动转 confirmed） ============ */}
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
            const idOf = (e: SlangEntry): string => String(e?.id ?? '');
            const selSet = new Set(slangSel);
            // 【2026-09-16】按 **status 的真实取值** 分组（桥侧只可能是 candidate / confirmed / rejected 三种）：
            //   · 已确认 = confirmed（含研究会话自动转过来的 autoConfirmed）；
            //   · 未确认 = candidate —— 也就是桥侧 counts.candidate，两组标题计数直接对齐这份数据；
            //   · rejected 既不进"已确认"也不进"未确认"，单独折成第三组（默认收起）——
            //     不能丢数据，但也不能让它污染上面两组的计数语义。勾选框只出现在「未确认（候选）」这一组。
            const confirmedList = list.filter((e) => String(e?.status ?? '') === 'confirmed');
            const candidateList = list.filter((e) => String(e?.status ?? '') === 'candidate');
            const rejectedList = list.filter((e) => String(e?.status ?? '') === 'rejected');
            // 勾选只认「当前可见（过了搜索）的候选」里的那些，避免搜完词还留着幽灵勾选
            const visIds = candidateList.map(idOf).filter(Boolean);
            const selIds = visIds.filter((id) => selSet.has(id));
            const allSel = visIds.length > 0 && selIds.length === visIds.length;
            /** 标题计数用桥的 counts（拿不到就按 entries 算，同一份数据）；搜索时额外标出当前命中的条数 */
            const cnt = (n: number, hit: number) => `${n} 条${kw ? `（当前命中 ${hit}）` : ''}`;
            const toggle = (id: string) => {
              if (!id) return;
              setSlangSel((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
            };
            const act = (kind: 'reject' | 'research') => { void slangBatch(kind, selIds); };
            /** 一行词条。selectable=true 只有「未确认（候选）」那一组 —— 其余组只读展示 + 删除入口。 */
            const rowOf = (e: SlangEntry, idx: number, selectable: boolean) => {
              const ev = Array.isArray(e?.evidence) ? e.evidence : [];
              const id = idOf(e);
              const picked = !!id && selSet.has(id);
              const st = String(e?.status ?? '');
              return (
                <div
                  className={`lrn-status-row lrn-slang-row${picked ? ' is-selected' : ''}${selectable ? '' : ' is-readonly'}`}
                  key={id || `slang-${st || 'x'}-${idx}`}
                  title={selectable
                    ? (id ? (picked ? '点一下取消选择' : '点一下选择这一条') : '这条词条没有 id，无法勾选（桥侧旧数据）')
                    : st === 'rejected'
                      ? '已拒收的黑话：只读展示（不再参与查询，可留档）；不想留档就点右边的「删除」'
                      : '已确认的黑话：只读展示（研究会话确认后桥侧会自动转成已确认，不需要人工批量通过）'}
                  onClick={selectable ? (evt) => { if ((evt.target as HTMLElement)?.tagName === 'INPUT') return; toggle(id); } : undefined}
                >
                  {selectable
                    ? <input type="checkbox" className="lrn-pick" checked={picked} disabled={!id}
                        aria-label={`选择词条 ${String(e?.content ?? '')}`} onChange={() => toggle(id)} />
                    : <span className="lrn-pick-none" aria-hidden="true" />}
                  <div className="lrn-status-main">
                    <div className="lrn-status-uid">
                      <b>{String(e?.content ?? '(空)')}</b>
                      {badge(st)}
                      {e?.autoConfirmed === true && (
                        <span className="badge badge-info" title="研究会话明确确认（confirmed:true + 有含义 + 风险不高）后由桥自动转为已确认">自动确认</span>
                      )}
                      <span className="lrn-status-caret">出现 {num(e?.count)} 次 · {String(e?.source ?? '')}</span>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-danger lrn-slang-del"
                        disabled={!!slangLibBusy || !id}
                        title={id ? '删除这条黑话（会二次确认；删除后机器人不再用这条黑话）' : '这条词条没有 id，删不掉（桥侧旧数据）'}
                        onClick={(evt) => { evt.stopPropagation(); void deleteSlang(e); }}
                      >
                        {slangLibBusy === `del:${id}` ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} />} 删除
                      </button>
                    </div>
                    {String(e?.meaning ?? '').trim()
                      ? <div className="lrn-status-preview">{String(e.meaning)}</div>
                      : <div className="lrn-status-preview" style={{ opacity: .65 }}>（还没有释义：达到出现次数阈值后会自动研究补齐，也可以勾上它点「批量分析」）</div>}
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
            };
            return (
              <div className="pfp-mask" onClick={() => setSlangOpen(false)}>
                <div className="pfp-modal" onClick={(e) => e.stopPropagation()}>
                  <div className="pfp-head">
                    <div>
                      <div className="pfp-title">黑话库</div>
                      <div className="pfp-sub">
                        共 {slangCounts.total} 条 · 已确认 {slangCounts.confirmed} 条 · 未确认 {slangCounts.candidate} 条
                        {slangCounts.rejected > 0 ? ` · 已拒收 ${slangCounts.rejected} 条` : ''}
                        {kw ? ` · 命中 ${list.length} 条` : ''} · 确认后不会每轮注入聊天，机器人需要时会自己查黑话库
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-sm" disabled={!!slangLibBusy} onClick={() => refreshSlangLib()}><RefreshCw size={13} /> 刷新</button>
                      <button className="btn btn-sm" onClick={() => setSlangOpen(false)}>关闭</button>
                    </div>
                  </div>

                  <div className="lrn-slang-tools">
                    <input className="input" placeholder="搜词条 / 含义 / 例句…" value={slangQ} onChange={(e) => setSlangQ(e.target.value)} />
                    <div className="lrn-batch-bar">
                      <span className="lrn-batch-count">已选 {selIds.length} 条候选</span>
                      <button type="button" className="btn btn-sm" disabled={!visIds.length || allSel} onClick={() => setSlangSel((prev) => [...new Set([...prev, ...visIds])])}>全选未确认</button>
                      <button type="button" className="btn btn-sm" disabled={!visIds.length} onClick={() => setSlangSel((prev) => {
                        const s = new Set(prev);
                        for (const id of visIds) { if (s.has(id)) s.delete(id); else s.add(id); }
                        return [...s];
                      })}>反选</button>
                      <button type="button" className="btn btn-sm" disabled={!slangSel.length} onClick={() => setSlangSel([])}>清空选择</button>
                      <span className="lrn-batch-spacer" />
                      <button type="button" className="btn btn-outline-danger btn-sm" disabled={!!slangLibBusy || !selIds.length}
                        onClick={() => act('reject')} title="把选中词条标为已拒收（不再参与查询，可留档不删）">
                        {slangLibBusy === 'reject' ? <Loader2 size={13} className="spin" /> : <X size={13} />} 批量拒收
                      </button>
                      <button type="button" className="btn btn-soft-primary btn-sm" disabled={!!slangLibBusy || !selIds.length}
                        onClick={() => act('research')} title="对选中的候选词条触发一次研究分析（桥侧后台串行跑，完成后补上含义/用法/例句）">
                        {slangLibBusy === 'research' ? <Loader2 size={13} className="spin" /> : <Search size={13} />} 批量分析
                      </button>
                    </div>
                    <div className="lrn-slang-note">
                      确认的含义：这个词条「已入库、有含义、可被查到」。黑话默认不注入唤醒提示词（桥侧 injectIntoPrompt 默认关闭），
                      机器人遇到不认识的词时会自己调用 qq_slang_query 工具按需查库，所以只有「已确认 + 填了含义」的词条才查得到。
                      候选的释义由「批量分析」交给研究会话补齐，<b>研究会话明确确认后桥侧会自动转成「已确认」</b>
                      （slang.js 里的 autoConfirmed 那段），因此这里不再提供「批量通过」。删除是不可恢复的，想留档就改用「批量拒收」。
                    </div>
                    {slangNote && <div className="lrn-slang-result">{slangNote}</div>}
                  </div>

                  <div className="pfp-body">
                    {slangErr && <div className="pfp-empty">读取失败：{slangErr}（黑话库在桥的 state/slang.json 里，桥没连上时读不到）</div>}
                    {!slangErr && list.length === 0 && (
                      <div className="pfp-empty">
                        {slangEntries.length === 0 ? '还没有学到任何词条：点「黑话立即学习」跑一轮，或等定时学习到点。' : '没有匹配的词条。'}
                      </div>
                    )}
                    {!slangErr && list.length > 0 && (
                      <>
                        {/* ——— 已确认（只读；标题计数 = 桥 learning.counts.confirmed） ——— */}
                        <div className="lrn-slang-group">
                          <div className="lrn-slang-group-h">
                            <Check size={13} /> 已确认
                            <span className="lrn-slang-group-n">{cnt(slangCounts.confirmed, confirmedList.length)}</span>
                            <span className="lrn-slang-group-hint">只读 · 研究会话确认后桥侧自动转为已确认，不需要人工批量通过</span>
                          </div>
                          {confirmedList.length > 0
                            ? confirmedList.map((e, i) => rowOf(e, i, false))
                            : <div className="pfp-empty">{kw ? '没有命中的已确认词条。' : '这一组暂时是空的：还没有词条被确认（候选被研究会话确认、并给出含义后会自动进到这里）。'}</div>}
                        </div>
                        {/* ——— 未确认（= 候选，可勾选；标题计数 = 桥 learning.counts.candidate） ——— */}
                        <div className="lrn-slang-group">
                          <div className="lrn-slang-group-h">
                            <AlertTriangle size={13} /> 未确认
                            <span className="lrn-slang-group-n">{cnt(slangCounts.candidate, candidateList.length)}</span>
                            <span className="lrn-slang-group-hint">可勾选后「批量分析 / 批量拒收」；每条也都能单独删除</span>
                          </div>
                          {candidateList.length > 0
                            ? candidateList.map((e, i) => rowOf(e, i, true))
                            : <div className="pfp-empty">{kw ? '没有命中的未确认词条。' : '没有未确认的词条：候选都已经确认入库、机器人按需查得到了。'}</div>}
                        </div>
                        {/* ——— 已拒收：既不进"已确认"也不进"未确认"，单独折一组（默认收起），数据不丢 ——— */}
                        {(rejectedList.length > 0 || slangCounts.rejected > 0) && (
                          <div className="lrn-slang-group">
                            <div className="lrn-slang-group-h lrn-slang-group-h-btn" role="button" tabIndex={0}
                              onClick={() => setSlangShowRejected((v) => !v)}
                              onKeyDown={(evt) => { if (evt.key === 'Enter' || evt.key === ' ') { evt.preventDefault(); setSlangShowRejected((v) => !v); } }}
                              title="已拒收的词条不再参与查询，可留档；不想留档就展开后逐条删除">
                              <X size={13} /> 已拒收
                              <span className="lrn-slang-group-n">{cnt(slangCounts.rejected, rejectedList.length)}</span>
                              <span className="lrn-slang-group-hint">
                                既不进「已确认」也不进「未确认」（桥侧 status=rejected）· {slangShowRejected ? '点一下收起 ▾' : '点一下展开 ▸'}
                              </span>
                            </div>
                            {slangShowRejected && (
                              rejectedList.length > 0
                                ? rejectedList.map((e, i) => rowOf(e, i, false))
                                : <div className="pfp-empty">{kw ? '没有命中的已拒收词条。' : '这一组暂时是空的。'}</div>
                            )}
                          </div>
                        )}
                      </>
                    )}
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
  const [rcBusy, setRcBusy] = useState(false);
  const [rcMsg, setRcMsg] = useState('');
  const inflight = useRef(false);
  const lastReload = useRef(0);

  /** 与 DSH 会话级权威计数对账：把被漏记的 usage 帧补进来，面板数字对上真实值 */
  const doReconcile = async () => {
    setRcBusy(true); setRcMsg('');
    try {
      const r: any = await reconcileTokens();
      // 某一侧桥没在运行 = 状态（后端已把 fetch failed 翻成人话），不写成"失败"吓人；
      // 只有在两侧都没对成的时候才提示失败。
      const line = (name: string, side: any, reason: string) => {
        if (side) {
          const res = side.result || {};
          if (res.reason) return `${name}：${res.reason}`;
          const add = num(res.addedTokens);
          return add > 0 ? `${name}：补记 ${num(res.added)} 笔 / ${fmtFull(add)} tokens` : `${name}：无差额（桥侧累计已达 DSH 自己的会话累计，不代表与提供方控制台一致）`;
        }
        if (!reason) return '';
        return reason.includes(name) ? reason : `${name}：${reason}`;
      };
      const parts = [line('本机', r?.local, String(r?.localReason || '')), line('服务端', r?.remote, String(r?.remoteReason || ''))].filter(Boolean);
      if (!r?.ok) { setRcMsg('两侧桥都没取到，对账未执行：' + parts.join('；')); return; }
      setRcMsg(parts.length ? parts.join('；') : '对账完成');
      await load();
    } catch (e: any) {
      setRcMsg('对账失败：' + String(e?.message ?? e));
    } finally { setRcBusy(false); }
  };

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
  // 与 DSH 对账状态（桥侧每 5 分钟自动跑一次；标题栏那个按钮是手动再跑一次）
  //
  // 【2026-09-18 修「文案让人以为面板 = 提供方控制台」】原文案两处不准确：
  //  ①「逐会话与 DSH 完全一致」——对账比的只是 **DSH 自己**的会话级累计
  //     （DSH home 下 storages/session_projcache/sessions/*.json 的 record.rows.tokenUsage.val.totals），
  //     **不是**提供方控制台；而且桥侧 reconcileWithDsh 按"桶"补差额，只保证「桥侧累计 ≥ DSH 累计」。
  //  ②「平台控制台因结算延迟可能略差几秒的量」——实测不是几秒的量。2026-09-18 19:07:03 的实测数据：
  //     · 面板 21,842,584（= 服务端桥 today.billedTotal；本机那份对当日贡献为 0，故合计就是它）；
  //     · 同一窗口按 DSH 自己落的事件日志（sessions/<slug>/session-*/*.jsonl.zstd 里
  //       assistant/chunk|message 的 usage，按 turn/step 取最终值）逐 step 合计 = 21,562,418；
  //     · 提供方控制台 = 21,563,440（与 DSH 逐 step 只差 1,022 = 0.005% —— 这才是"结算延迟"的量级）。
  //     → 面板比 DSH/控制台多 476,993，且**正好等于 1 条对账补记行**
  //       （session-724f5d85，2026-09-18 13:35:13，prompt=476,993、cacheRead=0）；
  //       桥侧 reconcileWithDsh 的逐桶 max(0, dsh−桥侧) 是**单向棘轮**：某个桶记多了永远扣不回来
  //       （该会话桥侧终身 34,165,004 vs DSH 31,788,012，多 2,376,992），而补记行又按"对账时刻"
  //       写 tsMs，于是这一笔落在当日、把「今日已用」推高。
  //     所以文案必须写明口径，不能再承诺"与提供方控制台一致"。
  const rcLast = isObj(report?.reconcile?.last) ? report.reconcile.last : null;
  const rcText = rcLast
    ? `已与 DSH 的会话级计数对账：${bjClock(num(rcLast.at))} 扫描 ${num(rcLast.scanned)} 个会话 · `
      + (num(rcLast.addedTokens) > 0
        ? `本次补记 ${fmtFull(num(rcLast.addedTokens))} tokens（桥侧漏记的帧）`
        : '本次无差额')
    : '';

  return (
    <div className="card token-panel">
      <div className="card-title" style={{ justifyContent: 'space-between' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><TrendingUp size={17} /> Token 用量统计</span>
        <span className="page-actions" style={{ gap: 8 }}>
          <span className="lrn-updated">{live === 'sse' ? '实时推流（SSE）· 本机 + 服务端合并' : '每 60 秒自动刷新（SSE 不可用）'}{updatedAt ? ` · ${updatedAt}` : ''}</span>
          <button className="btn btn-sm" disabled={loading} onClick={load}>
            {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} 刷新
          </button>
          <button
            className="btn btn-sm" disabled={rcBusy} onClick={doReconcile}
            title="拿 DSH 自己记的每个会话累计用量与桥侧对账，补上桥侧漏记的 usage 帧（只比对 DSH 自己的会话累计，不比对提供方控制台；补记按对账时刻计入当日）"
          >
            {rcBusy ? <Loader2 size={13} className="spin" /> : <Scale size={13} />} 与 DSH 对账
          </button>
        </span>
      </div>

      {rcMsg && <div className="lrn-note lrn-note-soft">{rcMsg}</div>}
      {/* 【2026-09-18】口径必须写出来：对账只比 DSH 自己记的会话累计，**不比对提供方控制台**；
          补记行按"对账时刻"计入当日，当日数字因此可能高于控制台（实测 2026-09-18 高 476,993）。
          以前这里写「平台控制台因结算延迟可能略差几秒的量」，把 47 万的差说成"几秒"，是错的。 */}
      {!rcMsg && rcText && (
        <div className="lrn-note lrn-note-soft">
          {rcText}（对账口径 = 桥侧累计 ↔ DSH 自己记的会话累计，<b>不比对提供方控制台</b>；每 5 分钟自动跑一次。
          补记行按"对账时刻"计入当日，且桥侧某个桶一旦记多就扣不回来，所以当日数字可能高于控制台）
        </div>
      )}

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
            {/* 【2026-09-18】这行是实测教训：上面那个数**不一定**等于提供方控制台 ——
                它含 DSH 对账补记行（按对账时刻计入当日），桥侧记多的桶又扣不回来。实测当日高出 476,993。 */}
            <br />含 DSH 对账补记，可能与提供方控制台不一致
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

/** 画像学习栏展开后的资料：字段与上面人格学习栏用的是**同一份库数据**，展示也保持一致，
 *  但**没有**英文人设正文与「覆盖机器人人设」——人设只能来自目标名单（主人明确要求的边界）。
 *  抽成小组件，避免两栏各写一份、以后加字段漏改一边。 */
function PortraitDetail({ it, detail, busy, err }: { it: PItem; detail: any; busy: boolean; err?: string }) {
  const d = detail || null;
  const pf = d?.profile || null;
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
      {busy && <div className="lrn-dk">正在读取完整资料…</div>}
      {err && <div className="lrn-dk">读取失败：{err}</div>}
      <div>
        <span className="lrn-dk">资料样本</span>
        {it.samples} 条
        {num(d?.msgCount) > 0 ? ` · 近 30 天发言 ${num(d.msgCount)} 条` : ''}
        {num(d?.memoryCount) > 0 ? ` · 记忆条目 ${num(d.memoryCount)} 条` : ''}
      </div>
      {it.learnedAtMs > 0 && <div><span className="lrn-dk">最近学习</span>{bjClock(it.learnedAtMs)}</div>}
      {num(pf?.updatedAt) > 0 && <div><span className="lrn-dk">档案更新</span>{bjClock(num(pf.updatedAt))}</div>}
      {num(d?.lastSeen) > 0 && <div><span className="lrn-dk">最近活跃</span>{bjClock(num(d.lastSeen))}</div>}
      {pf?.name && <div><span className="lrn-dk">通讯录昵称</span>{pf.name}</div>}
      {pf?.birthday && <div><span className="lrn-dk">生日</span>{pf.birthday}</div>}
      {intro ? <div className="lrn-wide"><span className="lrn-dk">完整介绍</span><p className="lrn-prose">{intro}</p></div> : null}
      {!intro && lib?.personality && <div className="lrn-wide"><span className="lrn-dk">性格</span><p className="lrn-prose">{lib.personality}</p></div>}
      {!intro && !lib && pf?.personality && <div className="lrn-wide"><span className="lrn-dk">性格</span><p className="lrn-prose">{pf.personality}</p></div>}
      {lib?.addressTerms && <div className="lrn-wide"><span className="lrn-dk">称呼方式</span>{lib.addressTerms}</div>}
      {styleBits && <div className="lrn-wide"><span className="lrn-dk">说话风格</span>{styleBits}</div>}
      {lib?.style?.examples?.length ? <div className="lrn-wide"><span className="lrn-dk">原句样例</span>{lib.style.examples.join(' / ')}</div> : null}
      {lib?.chatHabits && <div className="lrn-wide"><span className="lrn-dk">聊天习惯</span>{lib.chatHabits}</div>}
      {lib?.emojiHabits && <div className="lrn-wide"><span className="lrn-dk">表情习惯</span>{lib.emojiHabits}</div>}
      {phraseText && <div className="lrn-wide"><span className="lrn-dk">口头禅</span>{phraseText}</div>}
      {lib?.topics?.length ? <div className="lrn-wide"><span className="lrn-dk">常聊话题</span>{lib.topics.join('；')}</div> : null}
      {lib?.taboos?.length ? <div className="lrn-wide"><span className="lrn-dk">要注意</span>{lib.taboos.join('；')}</div> : null}
      {lib?.relationshipAdvice && <div className="lrn-wide"><span className="lrn-dk">相处建议</span>{lib.relationshipAdvice}</div>}
      {pf?.likes && <div className="lrn-wide"><span className="lrn-dk">喜好</span>{pf.likes}</div>}
      {pf?.dislikes && <div className="lrn-wide"><span className="lrn-dk">不喜欢</span>{pf.dislikes}</div>}
      {pf?.notes && <div className="lrn-wide"><span className="lrn-dk">备注</span>{pf.notes}</div>}
      {summaryText && summaryText !== intro && <div className="lrn-wide"><span className="lrn-dk">画像摘要</span><p className="lrn-prose">{summaryText}</p></div>}
      {!busy && !err && !intro && !pf && !summaryText && <div className="lrn-dk">这个人在记忆库里还没有档案（只有上面的画像状态）。</div>}
      <div className="lrn-wide" style={{ fontSize: 11.5, lineHeight: 1.6, color: 'var(--nc-foreground-400)' }}>
        这属于「画像学习」的群友画像，只进群友画像，不会变成机器人的人设；想让它成为人设得先把号码填进左侧「目标 QQ」再走人格学习。
      </div>
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

      {/* 【2026-09-16】这一块也**限高 + 内部纵向滚动**：画像学习的目标一多，状态区以前会把左卡一路撑高。
          标题与上面那排操作按钮（保存配置 / 画像立即学习 / 停止学习）留在滚动区外，始终可见。 */}
      <div className="lrn-status-list" style={{ marginTop: 10, maxHeight: 180, overflowY: 'auto' }}>
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
