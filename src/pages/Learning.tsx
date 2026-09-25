import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import NoticeBar from '../components/NoticeBar';
import NumInput from '../components/NumInput';
import {
  getLearningConfig, saveLearningConfig, slangAction, personaAction, personaApply, portraitAction, getTokenReport, getSlangLibrary, getPersonProfile,
  reconcileTokens, slangBatchReject, slangResearch, slangBatchDelete,
} from '../api';
import type { SlangEntry, SlangLearnPhase, SlangLearningState } from '../api';
import type { CSSProperties } from 'react';
import { CFG_LEARNING, getCachedConfig, rememberConfig } from '../config-cache';
import {
  ArrowLeft, Save, Play, Square, RefreshCw, Loader2, AlertTriangle,
  Activity, TrendingUp, Users, Clock3, Zap, BarChart3, Wallet, RotateCcw, BookOpen,
  Check, X, Search, Wand2, Trash2,
} from 'lucide-react';

interface Props { onBack: () => void; }

/* ---------- 通用容错工具：桥侧字段缺失或类型异常时一律取默认值，避免整页渲染失败 ---------- */
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
/** 管理端失败信封（success:false 或桥侧 ok:false）转错误文本；无错误时返回空串 */const firstErr = (r: any): string => {
  if (isObj(r) && (r.success === false || r.ok === false)) {
    return pick('error', 'message', 'detail')(r) || '请求失败';
  }
  return '';
};
/** 同时兼容桥侧 { ok, result:{...} } 与直接对象两种回包形态 */
const unwrap = (r: any): any => (isObj(r?.result) ? r.result : isObj(r) ? r : {});
/** 2026-09-19 按要求改写：读取学习配置失败时提示条中的第二行说明（非文档正文）。
 *  此前为固定一句「学习接口来自桥侧新版本：请先更新并启动桥接…」，
 *  将「桥未运行」与「桥版本过旧」混为一谈，致使仅未启动桥的使用者去更新无需更新的桥。
 *  现按服务端返回的 code 分两种表述，分别说明「当前不能做什么」与「下一步做什么」
 *    · bridge-offline：对端无应答（进程未启动 / 隧道未建立 / 超时）→ 启动桥；
 *    · bridge-stale  ：桥有应答，但其版本不含该路由 → 属需更新桥代码的情形。 */
const learningErrDetail = (code: string, hasCfg: boolean): string => {
  if (code === 'bridge-offline') {
    // 分两种情形：从未读到过（下方显示默认值）与读到过但本次重读失败（下方仍为上次的值）。
    // 两种情形均不宜假定桥上的当前值，故分别表述。
    return hasCfg
      ? '桥未运行，本次重读未成功：下列为上次读取到的值，仍可查看与修改。启动桥（首页「一键启动整套」；远端先点「连接」）后本页会自动重新读取。'
      : '桥未运行，本页无法读取该配置：下列字段暂为空白（尚未读到桥上的值），请勿当作桥上保存的设置。启动桥（首页「一键启动整套」；远端先点「连接」）后本页会自动重新读取。';
  }
  if (code === 'bridge-stale') return '桥在运行，但其版本不含学习接口：请更新桥代码并重启桥，本页会自动重新读取。';
  return '本页会自行重新读取；若持续失败，见上方给出的具体原因。';
};
/** 自动重试说明（2026-09-30 原话：「不要我点击重试再刷新，而是自动刷新，也不要有点击重试这样的按钮」）。
 *  `ms > 0` 表示正处于失败后的退避重读中（5 → 10 → 20 → 40 → 60 秒，封顶 60 秒）；
 *  `ms === 0` 表示已读到、处于每 60 秒一次的常规静默轮询。页面上不出现任何"重试"按钮。 */
const autoRetryNote = (ms: number): string =>
  ms > 0
    ? `正在自动重试：约每 ${Math.max(1, Math.round(ms / 1000))} 秒重读一次（失败后按 5／10／20／40／60 秒退避，最长 60 秒一次）。桥启动后本页会自行恢复，无需手动刷新。`
    : '本页自行重读，无需手动刷新。';
/** api() 抛出的 HTTP 错误转可读说明：404 通常意味着「管理端未转发该桥接口」。
 *  直接抛出 `API /xx -> HTTP 404` 易被误判为桥故障，此处补充可执行的说明。 */
const apiErrText = (e: any): string => {
  const t = String(e?.message ?? e);
  const m = /API (\S+) -> HTTP (\d+)/.exec(t);
  if (m && m[2] === '404') {
    return `管理端未转发该接口（HTTP 404：${m[1]}）——需在 server 侧补一条指向桥同名端点的代理`;
  }
  return t;
};
const bjClock = (ms: number): string =>
  new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/\//g, '-');
/** 紧凑计数：以万为单位记 W，百万级起记 M（例：14.7W / 1.25M / 12.5M） */
const fmtTok = (n: number): string => {
  const a = Math.abs(n);
  if (!Number.isFinite(n)) return '0';
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${(n / 1e4).toFixed(a >= 1e5 ? 1 : 2)}W`;
  return String(Math.round(n));
};
const fmtFull = (n: number): string => Math.round(n).toLocaleString('zh-CN');
/** 数值标注防裁切：贴近画布左右边界时改用 start/end 锚点，并将锚点夹回画布内。
 *  曲线末节点与柱状图最右柱的顶部数值均由此保证不被裁切。 */
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
/** 仅 cacheRead>0 的请求计入的「实测子集」；命中率仅取该子集，以保证为真实值 */
  cachePrompt: number; cacheCompletion: number; cacheSamples: number;
}
interface PItem {
  uid: string; state: string; learnedAtMs: number; samples: number;
  nickname: string; preview: string;
/** 英文人设正文（桥侧 persona-library[uid].personaEn，随 status 一并返回）：审批与修正的对象 */
  personaEn: string;
/** 审批痕迹：最近一次「保存修正」或「覆盖机器人人设」的时刻 */
  personaEditedAtMs: number;
  personaAppliedAtMs: number;
/** 是否位于 learning-config 的 persona.targetQQ（人格学习目标列表）中；为 false 者多由「画像学习」自动筛出 */
  inTargetList: boolean;
}

function normDays(dates: any[] | undefined): DayStat[] {
  if (!Array.isArray(dates)) return [];
  return dates.map((d: any, i: number): DayStat => {
    const date = String(isObj(d) ? pick('date')(d) : '');
    // 真实用量 = 未命中输入 + 缓存命中输入 + 输出。
    // 旧实现取 total_tokens（提供方给出的会话累计快照），逐条累加会重复计入同一段上下文，
    // 曲线因此虚高一个量级；此处改用三项相加的真实计费量。
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
    // 旧版桥不含这几个字段：空值、0 或 false 一律走「无英文人设正文」的旧档案分支，不作假定
    personaEn: String(isObj(it) ? (it.personaEn ?? '') : ''),
    personaEditedAtMs: isObj(it) ? num(it.personaEditedAtMs) : 0,
    personaAppliedAtMs: isObj(it) ? num(it.personaAppliedAtMs) : 0,
    inTargetList: isObj(it) ? it.inTargetList !== false : true,
  }));
}

/* ---------- 黑话「学习状态机」（只用桥返回的 learning 快照，不做派生猜测） ---------- */
const SLANG_PHASES: SlangLearnPhase[] = ['disabled', 'extracting', 'stopping', 'queued', 'researching', 'ready', 'idle'];
/** 桥侧 GET /api/slang 的 learning 快照归一化。
 *  契约（桥侧已确认）：字段缺失或类型异常一律取安全默认值；phase 不可识别时整体判为「取不到」（返回 null），
 *  不退化到任何默认阶段——显示错误状态比不显示更为不利。 */
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
/** 各 phase 的文案（按桥侧确认的语义映射，不改含义）与徽章样式。
 *  仅 extracting / researching 使用进行中样式（转圈与呼吸高亮），其余为静态徽章。 */
const SLANG_PHASE_UI: Record<SlangLearnPhase, { label: string; cls: string; note: string; active?: boolean }> = {
  disabled: { label: '已关闭', cls: 'badge badge-soft', note: '黑话学习总开关未开启（enabled=false）：桥侧跳过全部黑话学习' },
  extracting: { label: '学习中（提取+研究）', cls: 'badge badge-warn', note: '正在批量提取语料并研究候选；本轮结束后自动落库', active: true },
  stopping: { label: '正在停止…', cls: 'badge badge-soft', note: '已收到停止请求，待当前分块结束后收尾；已学到的内容不会丢失' },
  queued: { label: '排队中', cls: 'badge badge-info', note: '已有排队任务，等待前序任务结束' },
  researching: { label: '分析中（研究）', cls: 'badge badge-warn', note: '候选正在研究会话中分析含义；取得含义后桥侧自动转为「已确认」', active: true },
  ready: { label: '空闲（随时可开始）', cls: 'badge badge-success', note: '学习会话已建立，当前无任务，可随时再发起一轮学习' },
  idle: { label: '空闲', cls: 'badge badge-soft', note: '无学习会话亦无任务，等待下一次定时或手动学习触发' },
};

/** HH:MM 时间输入归一化。
 *  已知问题：中文输入法下输入 ":" 常产生全角「：」及全角数字，先前的过滤 `[^0-9:]`
 *  会将其直接剔除，表现为「该输入框无法输入冒号」。此处先转半角再过滤。 */
const normHHMM = (raw: any): string => String(raw ?? '')
  .replace(/[：]/g, ':')
  .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/[^0-9:]/g, '')
  .replace(/:{2,}/g, ':')
  .slice(0, 5);

/* ================================================================== */
/** 间隔小时数限制在 1~720（合法输入范围），非法输入回退为 24。
 *  2026-09-23由组件内提到模块级：缓存起底与 loadConfig 两处都要用同一口径，避免漂移。 */
const clampHrs = (v: any): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 24;
  return Math.min(720, Math.max(1, n));
};

/** 本页两块表单（黑话学习 / 人格学习）的取值集合。
 *  可空类型是刻意的：`null` = 该开关"尚未读到配置"，布尔控件据此显示为未勾选且禁用；
 *  `undefined` = 数字尚未读到，NumInput 显示空白（不会把 0 当成真实取值写回）。 */
export interface LearnForm {
  slgEnabled: boolean | null;
  slgTime: string;
  slgLiveWin: boolean | null;
  slgResearch: boolean | null;
  slgIntv: boolean | null;
  slgIntvHours: number | undefined;
  perEnabled: boolean | null;
  perIntv: boolean | null;
  perIntvHours: number | undefined;
  perTime: string;
  qqText: string;
}

/** 未读到配置时的空白表单：开关一律未勾选（配合 disabled，不会被误当成"已开启"或"已关闭"），
 *  数字与文本一律留空。不填任何出厂默认值 —— 那正是"切页面先闪一下默认值"的来源。 */
const BLANK_LEARN_FORM: LearnForm = {
  slgEnabled: null, slgTime: '', slgLiveWin: null, slgResearch: null,
  slgIntv: null, slgIntvHours: undefined,
  perEnabled: null, perIntv: null, perIntvHours: undefined, perTime: '', qqText: '',
};

/** 由一份桥配置导出表单取值。缺键时的口径与本次改动之前完全一致（不改变已读到配置时的任何显示）。 */
function learnFormOf(c: any): LearnForm {
  if (!isObj(c)) return BLANK_LEARN_FORM;
  const s = isObj(c.slang) ? c.slang : {};
  const p = isObj(c.persona) ? c.persona : {};
  return {
    slgEnabled: s.enabled !== false,
    slgTime: String(s.timeHHMM ?? '00:00'),
    slgLiveWin: s.liveWindowExtract === true,
    slgResearch: s.autoResearch !== false,
    slgIntv: s.autoIntervalEnabled === true,
    slgIntvHours: clampHrs(s.autoIntervalHours),
    perEnabled: p.enabled !== false,
    perIntv: p.autoIntervalEnabled === true,
    perIntvHours: clampHrs(p.autoIntervalHours),
    perTime: String(p.timeHHMM ?? ''),
    qqText: Array.isArray(p.targetQQ) ? p.targetQQ.join('\n') : '',
  };
}

/** 由缓存起底的表单取值：无缓存时返回空白表单（绝不拿默认值冒充桥上配置）。 */
function cachedLearnForm(): LearnForm {
  const c = getCachedConfig<any>(CFG_LEARNING);
  return c ? learnFormOf(c) : BLANK_LEARN_FORM;
}

export default function Learning({ onBack }: Props) {
  /* 2026-09-23 反馈：切页面先闪一下"出厂默认值" —— 配置与表单草稿的初值先取模块级缓存
   *  （上次成功读到的那份）：切走再切回来时页面直接就是上次读到的真实配置；
   *  缓存取不到时保持空白且禁用（见下方 cfgReady），绝不拿默认值冒充桥上配置。 */
  const [boot] = useState<LearnForm>(cachedLearnForm);
  const [cfg, setCfg] = useState<any>(() => getCachedConfig<any>(CFG_LEARNING));
/** 配置是否已读到（缓存命中或本次读取成功）。未读到时：两块表单禁用、两个「保存配置」禁用。 */
  const cfgReady = cfg !== null;
  const [loadErr, setLoadErr] = useState<string>('');
/** 2026-09-19读取配置失败时一并记录桥侧返回的 code（'bridge-offline' / 'bridge-stale'），
   *  用以区分「桥未运行」与「桥版本过旧」——两者下一步处置不同，
   *  混写会把仅是未启动桥的使用者引向升级桥。 */
  const [loadErrCode, setLoadErrCode] = useState<string>('');
/** 桥未运行但配置文件本身可读（服务端直读直写 state/learning-config.json）：
   *  取值为服务端返回的 fallback 来源（'local-file' = 本机那份 / 'remote-file' = 服务端那份，经 SSH），
   *  空串表示正常（配置取自桥控制台）。此时配置仍可查看与修改，仅依赖桥运行时的功能不可用。 */
  const [bridgeDown, setBridgeDown] = useState('');
/** 自动重试的当前间隔（毫秒）。0 = 已读到、处于 60 秒常规轮询；>0 = 失败后退避重读中。
   *  仅用于在提示条上如实说明"现在多久重读一次"，界面上不再出现「重试」按钮。 */
  const [autoRetryMs, setAutoRetryMs] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  // 2026-09-16 修复「按钮串台」此前整页仅有一个 busy，黑话区与人格区共用，由此产生三类问题：
  //   ① 两个区块的「保存配置」为同一 handler（body 中 slang 与 persona 一并提交），点黑话区的保存会连带写入人格配置；
  //   ② busy === 'save' 时两处保存按钮同时转圈，busy !== null 时两区按钮一并置灰，视觉上呈现为两个任务同时运行；
  //   ③ 画像区（PortraitLearnBlock）自有同名 busy 且不受此处约束，黑话学习进行中仍可再次点画像立即学习，
  //      两项学习并行运行，表现为「点一个、另一个同时运行」。
  //   现拆为互不影响的三套：黑话 slangBusy / 人格 personaBusy / 画像（子组件内部自管）。
  const [slangBusy, setSlangBusy] = useState<string | null>(null);
  const [personaBusy, setPersonaBusy] = useState<string | null>(null);

  // 表单草稿（与 cfg 分离，避免输入过程直接改动源对象）
  // 2026-09-23初值一律取自上面的缓存起底（boot），不再写死出厂默认值：
  //   有缓存 = 上次读到的真实配置；无缓存 = 空白（布尔为 null → 未勾选且禁用；数字为 undefined → 输入框空白）。
  const [slgEnabled, setSlgEnabled] = useState<boolean | null>(boot.slgEnabled);
  const [slgTime, setSlgTime] = useState(boot.slgTime);
  const [slgLiveWin, setSlgLiveWin] = useState<boolean | null>(boot.slgLiveWin);
  const [slgResearch, setSlgResearch] = useState<boolean | null>(boot.slgResearch);
  const [slgIntv, setSlgIntv] = useState<boolean | null>(boot.slgIntv);      // v2：黑话自动间隔学习
  const [slgIntvHours, setSlgIntvHours] = useState<number | undefined>(boot.slgIntvHours);
  const [perEnabled, setPerEnabled] = useState<boolean | null>(boot.perEnabled);
  const [perIntv, setPerIntv] = useState<boolean | null>(boot.perIntv);      // v2：人格自动间隔学习
  const [perIntvHours, setPerIntvHours] = useState<number | undefined>(boot.perIntvHours);
  const [perTime, setPerTime] = useState(boot.perTime);          // 人格学习：每日定时（北京时；留空表示不定时）
  const [qqText, setQqText] = useState(boot.qqText);

  // 人格学习状态
  const [pStatus, setPStatus] = useState<PItem[]>([]);
  const [statusAt, setStatusAt] = useState<string>('');
  const [statusErr, setStatusErr] = useState<string>('');
  // 展开某条记录时按需读取「完整资料」（直读桥的 memory.db，不截断；图谱接口会截断，故不采用）
  const [openUid, setOpenUid] = useState<string>('');
  const [profDetail, setProfDetail] = useState<Record<string, any>>({});
  const [profErr, setProfErr] = useState<Record<string, string>>({});
  const [profBusy, setProfBusy] = useState<string>('');
  // 英文人设正文（personaEn）的编辑草稿、进行中的动作与逐行结果提示。
  // 草稿单独存放：60 秒静默轮询会重新拉取 pStatus，直接改写源对象会覆盖正在输入的文本。
  const [peDraft, setPeDraft] = useState<Record<string, string>>({});
  const [peBusy, setPeBusy] = useState<string>('');   // `${mode}:${uid}`
  const [peNote, setPeNote] = useState<Record<string, string>>({});

  const openProfile = async (uid: string) => {
    if (openUid === uid) { setOpenUid(''); return; }
    setOpenUid(uid);
    // 展开后将该条滚动至可视区（列表自身滚动，避免末条资料看似被截断）
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

/** 人格学习目标名单（左侧卡片「目标 QQ」中配置的号码）。 */
/**  仅学习名单内成员是既定边界：名单外人员（「画像学习」按活跃度自动筛出的群友， */
/**  或指令中临时携带的号码）档案可供查看，但不得直接变为机器人自身人设——覆盖按钮予以禁用。 */
  const personaTargets = useMemo(
    () => new Set<string>(Array.isArray(cfg?.persona?.targetQQ) ? cfg.persona.targetQQ.map((x: any) => String(x)) : []),
    [cfg?.persona?.targetQQ],
  );
/** 右卡两栏的划分（2026-09-15 要求：人格学习与画像学习分立）：
   *   · 人格学习栏：仅含目标名单内成员（左侧「目标 QQ」中配置）；
   *   · 画像学习栏：名单外成员（画像学习按活跃度自动筛出的群友，以及指令中临时携带的号码）。
   *  先前参加学习的对象多来自画像学习，故自动归入画像学习栏，不再与人格学习栏混列；
   *  人设覆盖按钮因此仅出现在目标名单成员上。 */
  const inTargetOf = (it: PItem): boolean => (cfg ? personaTargets.has(String(it.uid)) : it.inTargetList === true);
  const pTargetRows = useMemo(() => pStatus.filter((it) => inTargetOf(it)), [pStatus, cfg, personaTargets]);
  const pOtherRows = useMemo(() => pStatus.filter((it) => !inTargetOf(it)), [pStatus, cfg, personaTargets]);
/** 输入框当前应显示的正文：有草稿取草稿，否则取桥侧库中的值 */
  const peValueOf = (it: PItem): string => (peDraft[it.uid] !== undefined ? peDraft[it.uid] : String(it.personaEn ?? ''));
  const peErrOf = (r: any): string => firstErr(r) || String(unwrap(r)?.error ?? '');

/** 「结合原人设完善」由桥侧运行一轮模型，把已学到的特点并入当前 persona.md（增删改）。 */
/**  产出为草稿，仅填入下方输入框供查看与修改，不自动写盘。 */
/**  2026-09-15 要求：人设覆盖不应只有「整篇替换」一种方式：多数场景需要的是在原有基础上完善。 */
  const fusePersonaEn = async (uid: string) => {
    if (peBusy) return;
    setPeBusy(`fuse:${uid}`);
    setPeNote((m) => ({ ...m, [uid]: '正在结合当前人设生成完善稿（需运行一轮模型，用时约十几秒至一分钟）…' }));
    try {
      const r: any = await personaApply(uid, 'fuse');
      const e = peErrOf(r);
      if (e) { setPeNote((m) => ({ ...m, [uid]: `生成完善稿失败：${e}` })); return; }
      const res = unwrap(r);
      const text = String(res?.text ?? '');
      if (!text.trim()) { setPeNote((m) => ({ ...m, [uid]: '生成完善稿失败：模型返回内容为空' })); return; }
      setPeDraft((m) => ({ ...m, [uid]: text }));
      setPeNote((m) => ({
        ...m,
        [uid]: `已生成完善稿草稿（${num(res.chars) || text.length} 字；原人设 ${num(res.currentChars)} 字）。`
          + `尚未生效：请先查看并修改下方稿件，确认后再点「整篇覆盖人设」写入（写入前自动备份旧人设）。`,
      }));
    } catch (err: any) {
      setPeNote((m) => ({ ...m, [uid]: `生成完善稿失败：${apiErrText(err)}` }));
    } finally { setPeBusy(''); }
  };

/** 「保存修正」将输入框中的文本写回该 uid 的 personaEn（机器人当前人设不变） */
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
      setPeNote((m) => ({ ...m, [uid]: `已保存修正（${num(res.savedChars) || text.trim().length} 字）。机器人当前人设未改动；如需生效，请点「整篇覆盖人设」。` }));
      await refreshStatus(true);
    } catch (err: any) {
      setPeNote((m) => ({ ...m, [uid]: `保存修正失败：${apiErrText(err)}` }));
    } finally { setPeBusy(''); }
  };

/** 「覆盖机器人人设」将输入框中的正文写入 qq-bridge/persona.md（桥侧自动备份旧人设，自下一条消息起生效）。 */
/**  覆盖为不可逆的破坏性操作，故先以 confirm 说明「会覆盖」与「会自动备份」。 */
  const applyPersonaEn = async (uid: string, text: string) => {
    if (peBusy) return;
    const ok = window.confirm(
      `确定以输入框中的这段英文整篇替换机器人当前人设吗？（写入 qq-bridge/persona.md）\n\n`
      + `· 当前人设自动备份为 persona.md.bak-<日期-时间>（同目录，最多保留 5 份）\n`
      + `· 自下一条消息起使用新人设，无需重启桥\n`
      + `· 正文须为纯英文，含中文将被桥侧拒回\n`
      + `· 如需在原有基础上完善而非替换：先点左侧「结合原人设完善」生成草稿，修改后再在此处覆盖`,
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
          + `${res.backup ? `，旧人设已备份为 ${String(res.backup)}` : '（此前无 persona.md，故未生成备份）'}`
          + `。自下一条消息起生效，无需重启桥。`,
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
  // 黑话库批量审批：已勾选的词条 id（仅认可当前可见的未确认列表中勾选项）、进行中的动作与弹窗内结果提示
  const [slangSel, setSlangSel] = useState<string[]>([]);
  // 黑话库弹窗自身的 busy（批量拒收、分析、删除），与页面左卡的 slangBusy 相互独立
  const [slangLibBusy, setSlangLibBusy] = useState<string>('');
  const [slangNote, setSlangNote] = useState('');
  // 「已拒收」：分组默认折叠（该组既不属于已确认也不属于未确认，但数据不可丢弃，可展开查看）
  const [slangShowRejected, setSlangShowRejected] = useState(false);
  // 黑话「学习状态机」快照（GET /api/slang 的 learning，桥侧 slangLearningState()）；旧版桥无该字段时为 null
  const [slangLearn, setSlangLearn] = useState<SlangLearningState | null>(null);
/** 2026-09-30「拿不到学习状态」是否已是确定结论（本次请求已返回且没带来 learning，或请求失败）。
   *  初值为 false：首帧数据尚未回来时不得显示「学习状态不可用」——那是把"还没结论"说成结论，
   *  表现为此前反馈的"每次点开都跳一遍『学习状态不可用』再恢复正常"。此时渲染中性的"正在读取…"。 */
  const [slangLearnUnavailable, setSlangLearnUnavailable] = useState(false);
  // 画像学习状态（右卡「画像学习」栏；来源 portraitAction('status')，与人格状态共用 60 秒静默轮询）
  const [ptStatus, setPtStatus] = useState<any>(null);
  const [ptErr, setPtErr] = useState('');

  const openSlangLib = async () => {
    setSlangOpen(true); setSlangErr(''); setSlangNote('');
    await refreshSlangLib(!!slangEntries.length);
  };
/** 读取黑话库：同一次请求同时取得词条与桥侧「学习状态机」快照（learning）。
   *  页面上的「学习中」状态即取自该快照，为桥的真实运行态，非前端推测。
   *  2026-09-30`slangLearnUnavailable` 只在这次请求确实有了结果时才置位：
   *    回包正常但没带 learning（旧版桥）→ true（确定结论）；请求抛错 → true（确定失败）；
   *    数据还在路上 → 保持原值（初值 false），界面显示中性的"正在读取…"，不显示"不可用"。 */
  const refreshSlangLib = async (quiet = false): Promise<boolean> => {
    try {
      const r = await getSlangLibrary();
      const list: SlangEntry[] = Array.isArray(r?.entries) ? r.entries
        : (Array.isArray(r?.result?.entries) ? r.result.entries : (Array.isArray(r?.data?.entries) ? r.data.entries : []));
      setSlangEntries(list);
      const hasLearn = isObj(r?.learning);
      setSlangLearn(hasLearn ? normSlangLearning((r as any).learning) : null);
      setSlangLearnUnavailable(!hasLearn);
      // 列表重取后清除已不存在的勾选项，避免「已选 N 条」计入失效词条
      setSlangSel((prev) => (prev.length ? prev.filter((id) => list.some((e) => String(e?.id ?? '') === id)) : prev));
      setSlangErr('');
      return true;
    } catch (e) {
      setSlangLearnUnavailable(true);      // 请求已返回失败：这才是"不可用"的确定结论
      if (!quiet) setSlangErr(String((e as Error)?.message ?? e));
      return false;
    }
  };

/** 黑话库批量操作：reject = 批量拒收，research = 批量分析（桥侧仅研究候选词条）。 */
/**  2026-09-16「批量通过」已按要求移除：研究会话明确确认后桥侧自动转 confirmed（slang.js 中 */
/**  autoConfirmed 一段），人工批量通过属多余操作。此处仅保留拒收与分析两项。 */
/**  操作完成后按最新状态重取列表，并把结果同时写入页面提示条与弹窗内提示（弹窗遮盖页面时仅前者不可见）。 */
  const slangBatch = async (kind: 'reject' | 'research', ids: string[]) => {
    if (slangLibBusy) return;
    if (!ids.length) { setSlangNote('请先勾选待处理的词条（仅「未确认」分组的候选可勾选）'); return; }
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
        : `批量分析：已提交 ${num(res.count)} 条候选词条的研究任务（桥侧后台串行执行，完成后自动补齐释义；研究会话确认后自动转为「已确认」）`;
      setMsg(text); setSlangNote(text);
      setSlangSel([]);
      await refreshSlangLib(true);
    } catch (err: any) {
      const t = `${label}失败：${apiErrText(err)}`;
      setMsg(t); setSlangNote(t);
    } finally { setSlangLibBusy(''); }
  };

/** 删除单条黑话（已确认与未确认均可删除）：调用桥侧 `POST /api/slang/batch-delete`，body 为 `{ ids: [id] }`。 */
/**  接口契约（已与桥侧 console-server.js:763-789 对齐）： */
/**    · 成功 → `{ ok: true, removedCount: N }`； */
/**    · 无任何匹配 → 桥侧返回 `404 { ok:false, error:'没有匹配到要删除的黑话' }`； */
/**    · 该路由另支持 `{ status:'confirmed' }` 整批删除，界面有意不开放此入口（需求为「单条可删」）， */
/**      故此处始终只传 ids 且仅传一个。 */
/**  删除不可逆且会使机器人无法再查到该词条，故先以 confirm 说明后果；任何失败均在页面给出提示，不作静默处理。 */
  const deleteSlang = async (e: SlangEntry) => {
    if (slangLibBusy) return;
    const id = String(e?.id ?? '');
    const word = String(e?.content ?? '').trim() || '(这条词条)';
    if (!id) { setSlangNote('该词条没有 id（桥侧旧数据），无法删除'); return; }
    const ok = window.confirm(
      `确定删除黑话「${word}」吗？\n\n`
      + `· 删除后不可恢复\n`
      + `· 机器人将不再使用该黑话（qq_slang_query 已无法查到该词条）\n`
      + `· 如需暂不生效并保留存档，宜改用「批量拒收」`,
    );
    if (!ok) return;
    setSlangLibBusy(`del:${id}`);
    setSlangNote(`正在删除「${word}」…`);
    try {
      const r: any = await slangBatchDelete([id]);
      const err = firstErr(r);
      if (err) {
        // 桥侧「无任何匹配」返回 404，而管理端代理会把桥的 404 统一改写为 code='bridge-stale'
        //（文案为「桥在运行，但没有这条接口（HTTP 404）…」），对「该词条已不存在」这类正常结果具有误导性。
        // 故按契约并列写出两种可能，不作单一判定。
        const stale = r?.code === 'bridge-stale' && /404/.test(String(r?.detail ?? ''));
        const why = stale
          ? '桥侧未匹配到该词条（可能已被删除）。若确认其仍存在，请检查桥是否为最新版本（旧版桥不含该接口）'
          : err;
        const t = `删除「${word}」失败：${why}`;
        setMsg(t); setSlangNote(t);
        return;
      }
      const removed = num(unwrap(r).removedCount);
      const t = removed > 0
        ? `已删除黑话「${word}」（删除后不可恢复，机器人不再使用该黑话）`
        : `删除「${word}」失败：桥侧回执 removedCount=0，未匹配到该词条（可能已被他处删除）`;
      setMsg(t); setSlangNote(t);
      if (removed > 0) setSlangSel((prev) => prev.filter((x) => x !== id));
      await refreshSlangLib(true);
    } catch (err: any) {
      const t = `删除「${word}」失败：${apiErrText(err)}`;
      setMsg(t); setSlangNote(t);
    } finally { setSlangLibBusy(''); }
  };

  const qqs = qqListOf(qqText);

  const loadConfig = async (): Promise<boolean> => {
    try {
      const r = await getLearningConfig();
      const e = firstErr(r);
      /* 2026-09-30读取失败不清空已读到/缓存里的那份配置（原为 setCfg(null)）：
         清空会把"下列为上次读取到的值"这句话变成假话，还会把缓存命中的表单先抹白再填回来 ——
         正是此前反馈的"跳一遍"。真正的空态只发生在"从来就没读到过"（cfg 仍为 null）时。 */
      if (e) { setLoadErr(e); setLoadErrCode(String((r as any)?.code ?? '')); setBridgeDown(''); return false; }
      const c = isObj(r.config) ? r.config : r; // 兼容 {config:{...}} 与直接配置对象
      setCfg(c);
      /* 读到即入缓存：切走再切回本页时先显示这份配置再后台刷新，不会再闪默认值。 */
      rememberConfig(CFG_LEARNING, c);
      setLoadErr('');
      setLoadErrCode('');
      // 服务端在「桥未运行、改用文件兜底」时返回 bridgeDown=true 与 fallback（local-file / remote-file）：
      // 该配置为真实值，可查看与修改，但依赖桥运行时的功能不可用；界面据此标注，不作正常态处理。
      setBridgeDown((r as any)?.bridgeDown === true && typeof (r as any)?.fallback === 'string' ? String((r as any).fallback) : '');
      // 表单填充口径与缓存起底共用 learnFormOf()，两处不会漂移
      const f = learnFormOf(c);
      setSlgEnabled(f.slgEnabled);
      setSlgTime(f.slgTime);
      setSlgLiveWin(f.slgLiveWin);
      setSlgResearch(f.slgResearch);
      setSlgIntv(f.slgIntv);
      setSlgIntvHours(f.slgIntvHours);
      setPerEnabled(f.perEnabled);
      setPerIntv(f.perIntv);
      setPerIntvHours(f.perIntvHours);
      setPerTime(f.perTime);
      setQqText(f.qqText);
      return true;
    } catch (err: any) {
      setLoadErr(String(err?.message ?? err)); setLoadErrCode(''); setBridgeDown('');
      /* 同上一处：请求抛错亦不清空已有值（缓存命中时页面照常显示那份可查看、可修改的配置） */
      return false;
    }
  };

  const refreshStatus = async (quiet = false): Promise<boolean> => {
    try {
      const r = await personaAction('status');
      const e = firstErr(r);
      if (e) { if (!quiet) setStatusErr(e); return false; } // 静默轮询失败不作提示（保留已展示内容）
      setPStatus(normStatus(r));
      setStatusErr('');
      setStatusAt(bjClock(Date.now()));
      return true;
    } catch (err: any) {
      if (!quiet) setStatusErr(String(err?.message ?? err));
      return false;
    }
  };

/** 画像学习状态（右卡下方栏）。回包为 { ok, result:{ config, lastTargets, status, running } } */
  const refreshPortrait = async (quiet = false): Promise<boolean> => {
    try {
      const r: any = await portraitAction('status');
      const e = firstErr(r);
      if (e) { if (!quiet) setPtErr(e); return false; }
      setPtStatus(unwrap(r));
      setPtErr('');
      return true;
    } catch (err: any) {
      if (!quiet) setPtErr(String(err?.message ?? err));
      return false;
    }
  };

  // 进入页面时拉取一次配置、人格状态、画像学习状态与黑话库（含学习状态机）。
  /* 2026-09-30 变更要求：桥未起来时不再要人"点重试再刷新"，改为自动重试，页面上移除全部重试按钮：
     · 常规节奏：每 60 秒静默轮询一次（与改动前一致，状态区只读、无手动刷新按钮）。
     · 失败退避：本轮四项读取（配置 / 人格状态 / 画像状态 / 黑话库）任一项没读到即视为失败，
       下次改为 5s → 10s → 20s → 40s → 60s（封顶 60 秒）逐档拉长重读；全部读到即立刻复位回 60 秒。
     · 失败事实照常显示：loadConfig 每次失败都会刷新提示条上的原因与 code，页面不会变成"永远转圈"。
     · 用 setTimeout 自排程而非 setInterval，因为每次的间隔要随成败变化；
       闭包捕获的是首帧的这几个函数，它们只调 setState（函数式更新），不读当前 state，故无陈旧闭包问题。 */
  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    let backoff = 0;
    const tick = async () => {
      const [a, b, c, d] = await Promise.all([
        loadConfig(), refreshStatus(true), refreshPortrait(true), refreshSlangLib(true),
      ]);
      if (!alive) return;
      const ok = a && b && c && d;
      backoff = ok ? 0 : (backoff === 0 ? 5000 : Math.min(60000, backoff * 2));
      setAutoRetryMs(backoff);
      timer = window.setTimeout(() => { void tick(); }, ok ? 60000 : backoff);
    };
    void tick();
    return () => { alive = false; if (timer !== null) window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

/** 「黑话立即学习」进行期间将轮询缩短至 5 秒：桥侧 phase 会依次经过 extracting → researching → ready， */
/**  60 秒一次无法判断当前所处阶段。请求返回（slangBusy 复位）后即结束该快速轮询，不影响前述 60 秒轮询。 */
  useEffect(() => {
    if (slangBusy !== 'learn') return;
    const iv = setInterval(() => { void refreshSlangLib(true); }, 5000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slangBusy]);

/** 区块级 busy 包装：在同一区块内防止重复点击，且仅影响本区块的按钮与加载状态。 */
/**  此即修复「按钮串台」的关键：黑话区与人格区各自持有 state，操作一侧不会连带触发或置灰另一侧。 */
  const busyRunner = (set: (v: string | null) => void, cur: string | null) =>
    (key: string, fn: () => Promise<void>) => async () => {
      if (cur) return;
      set(key); setMsg(null);
      try { await fn(); } finally { set(null); }
    };
  const slangRun = busyRunner(setSlangBusy, slangBusy);
  const personaRun = busyRunner(setPersonaBusy, personaBusy);

/** 仅提交黑话部分的字段（注意 桥侧 PUT 设有白名单：`slang.lastLearnAtMs`、`persona.lastRunAtMs` 与 */
/**  `portrait.*` 由各模块自行维护，整包回传会被 400 拒绝，错误「slang 不支持字段：lastLearnAtMs」即由此产生）。 */
/**  2026-09-16此前黑话区与人格区共用同一个 save（body 中 slang 与 persona 一并发送）， */
/**  点「黑话定时学习」的保存按钮会连带写入人格配置，此为「按钮串台」的一半原因。现已拆分。 */
  const saveSlang = slangRun('save', async () => {
    const r = await saveLearningConfig({
      slang: {
        enabled: slgEnabled === true,
        timeHHMM: normHHMM(slgTime) || '00:00',
        autoResearch: slgResearch === true,
        liveWindowExtract: slgLiveWin === true,
        autoIntervalEnabled: slgIntv === true,
        autoIntervalHours: clampHrs(slgIntvHours),
      },
    });
    const e = firstErr(r);
    if (e) { setMsg(`保存失败：${e}`); return; }
    // 桥未运行时，服务端直接写入该配置文件（本机或服务端，见 server 的 learningConfigRoute）：
    // 写入虽已成功，但「桥尚未读取」须明确说明，避免误认为已生效。
    setMsg((r as any)?.bridgeDown === true
      ? `桥未运行：已写入${(r as any)?.fallback === 'remote-file' ? '服务端' : '本机'} qq-bridge/state/learning-config.json，将于桥下次启动或下一轮学习时生效`
      : '黑话学习配置已保存');
    await loadConfig();
    await refreshSlangLib(true);   // 仅刷新黑话侧（含学习状态机），不影响人格与画像
  });

/** 仅提交人格部分的字段 */
  const savePersona = personaRun('save', async () => {
    const r = await saveLearningConfig({
      persona: {
        enabled: perEnabled === true,
        targetQQ: qqs,
        autoIntervalEnabled: perIntv === true,
        autoIntervalHours: clampHrs(perIntvHours),
        timeHHMM: normHHMM(perTime),      // 每日定时（留空表示不定时）
      },
    });
    const e = firstErr(r);
    if (e) { setMsg(`保存失败：${e}`); return; }
    setMsg((r as any)?.bridgeDown === true
      ? `桥未运行：已写入${(r as any)?.fallback === 'remote-file' ? '服务端' : '本机'} qq-bridge/state/learning-config.json，将于桥下次启动或下一轮学习时生效`
      : '人格学习配置已保存');
    await loadConfig();
    await refreshStatus(true);
  });

/** 「黑话立即学习」仅调用这一条桥接口。桥侧该请求会保持到本轮提取完成后才返回， */
/**  因此它是「当前正在提取」最可靠的信号；完成后再次读取黑话库与学习状态机（研究可能仍在后台继续）。 */
/**  2026-09-16此前此处会一并调用 refreshStatus(true)（人格状态），而右卡「画像学习」栏的数据源 */
/**  即同一份 persona status（pOtherRows），点完黑话学习后画像学习栏随之刷新，表现为「画像学习也运行了」。 */
/**  现仅刷新黑话侧，黑话按钮只触发黑话相关逻辑。 */
  const learnSlang = slangRun('learn', async () => {
    const r = await slangAction('learn');
    const e = firstErr(r);
    if (e) { setMsg(`失败：${e}`); return; }
    const res = unwrap(r);
    const text = pick('message', 'msg', 'detail')(res) || pick('message', 'msg', 'detail')(r);
    setMsg(text ? `黑话学习：${text}` : '已受理「黑话立即学习」：自上次学习点或今日 0 点起提取并研究，完成后写入学习标记');
    await refreshSlangLib(true);
  });

  const stopSlang = slangRun('stop', async () => {
    const r = await slangAction('stop');
    const e = firstErr(r);
    if (e) { setMsg(`失败：${e}`); return; }
    const res = unwrap(r);
    const text = pick('message', 'msg', 'detail')(res) || pick('message', 'msg', 'detail')(r);
    setMsg(text ? `黑话学习：${text}` : '已请求停止进行中的黑话学习与研究任务');
    await refreshSlangLib(true);
  });

  const startPersona = personaRun('start', async () => {
    const r = await personaAction('start', qqs.length ? qqs : undefined);
    const e = firstErr(r);
    if (e) { setMsg(`学习启动失败：${e}`); return; }
    const res = unwrap(r);
    if (res?.disabled) { setMsg('人格学习未启动：配置中「人格学习」已停用，请先开启该开关'); return; }
    const started = Array.isArray(res?.started) ? res.started.map(String) : [];
    if (started.length) setMsg(`已受理人格学习：${started.join('、')}（后台串行执行）`);
    else if (qqs.length) setMsg('未受理新任务：目标可能已处于学习中，或 DSH 会话尚未就绪');
    else setMsg('未受理：请先在下方填写目标 QQ（每行一个，或用逗号分隔）');
    await refreshStatus(true);
  });

  const stopPersona = personaRun('stop', async () => {
    const r = await personaAction('stop');
    const e = firstErr(r);
    if (e) { setMsg(`失败：${e}`); return; }
    const res = unwrap(r);
    const stopped = Array.isArray(res?.stopped) ? res.stopped.map(String) : [];
    setMsg(stopped.length ? `已请求停止 ${stopped.join('、')} 的学习（本轮结束后收尾，不写入未完成内容）` : '当前没有进行中的人格学习');
    await refreshStatus(true);
  });

  const lastLearnAt = isObj(cfg?.slang) ? num(cfg.slang.lastLearnAtMs) : 0;

/** 学习阶段：仅采用桥返回的 learning 快照。learning 为 null（旧版桥或本次读取失败）时此处亦为 null， */
/**  界面进入「状态不可用」降级分支，不派生、不推测阶段。 */
  const slangPhase = slangLearn ? SLANG_PHASE_UI[slangLearn.phase] : null;
/** 分组计数：优先取桥的 `learning.counts`（即黑话库的真实构成）；取不到 learning 时按 entries 的真实
   *  status 自行计算——两者为同一份数据，取任一即可。rejected 单列一组，既不并入另两组也不丢弃。 */
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
            <div className="page-subtitle">黑话与人格学习 · Token 用量统计（作用于当前活动桥接）</div>
          </div>
        </div>
        <div className="page-actions">
          <span className="connection-bar" title="学习配置与用量接口由管理端代理至当前活动实例（优先远端隧道，其次本机 3100）">
            <Zap size={13} /> 目标：当前活动实例
          </span>
        </div>
      </div>

      <div className="page-body">
        <div className="lrn-body">
          <NoticeBar msg={msg} onClose={() => setMsg(null)} />

          <div className="lrn-grid">
            {/* ============ 左：学习配置与操作 ============ */}
            <div className="card">
              <div className="card-title"><Activity size={17} /> 黑话 / 人格学习</div>
              {/* 【2026-09-19 要求：桥不可达不应使配置页变为不可用】
                  此前此处为 `loadErr ? <错误块> : <>...全部配置字段...</>`：桥一停，整块学习配置
                  （黑话定时、人格学习、目标 QQ）连同「保存配置」一并消失，仅余一句错误提示。
                  现拆开处理：错误归错误，配置照常显示、照常可改。
                  桥未运行时服务端直接读写本机 qq-bridge/state/learning-config.json（见 server/index.js
                  的 learningConfigRoute），故显示的配置即为真实值，保存也确实生效；
                  真正依赖桥运行时的仅「立即学习 / 停止 / 学习状态 / 黑话库 / 用量」数处，单独标注。 */}
              {bridgeDown && (
                /* 2026-09-30：此处原有一个「重新读取」按钮（"点一下再刷新"），已按要求移除：
                   桥启动后本页的自动重试会自行把状态接回来，不需要人再点一次。 */
                <div className="lrn-inline-note" style={{ display: 'block', lineHeight: 1.75 }}>
                  <AlertTriangle size={13} /> <b>桥未运行</b>：下列配置直接读自
                  <code>{bridgeDown === 'remote-file' ? ' 服务端 qq-bridge/state/learning-config.json' : ' 本机 qq-bridge/state/learning-config.json'}</code>
                  ，<b>可查看、可修改，保存同样会写入</b>（将于桥下次启动或下一轮学习时生效）。
                  但「立即学习 / 停止 / 学习状态 / 黑话库 / 用量」须桥运行方可使用；桥启动后本页会自动重读并恢复这些功能，无需手动刷新。
                </div>
              )}
              {loadErr && (
                <div className="lrn-error">
                  <AlertTriangle size={15} />
                  <div style={{ flex: 1 }}>
                    {loadErr}
                    <div className="lrn-error-detail">{learningErrDetail(loadErrCode, cfgReady)}</div>
                    <div className="lrn-error-detail">{autoRetryNote(autoRetryMs)}</div>
                  </div>
                </div>
              )}
              {/* 读取中只占一行，页面结构照常可见；读到之前各字段为空白且不可编辑（见上方 cfgReady）。 */}
              {!cfgReady && !loadErr && (
                <div className="lrn-inline-note">
                  <Loader2 size={13} className="spin" /> 正在读取学习配置：读到之前下方字段为空白且不可编辑，以免呈现与桥上不一致的数值。
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
                            <Clock3 size={13} /> 上次学习：{num(slangLearn?.lastLearnAtMs) > 0 ? bjClock(num(slangLearn?.lastLearnAtMs)) : '尚未学习'}
                          </span>
                          <span>黑话库：{slangCounts.total} 条 · 已确认 {slangCounts.confirmed} · 未确认 {slangCounts.candidate}{slangCounts.rejected > 0 ? ` · 已拒收 ${slangCounts.rejected}` : ''}</span>
                          {num(slangLearn?.queuedOps) > 0 && <span>排队 {num(slangLearn?.queuedOps)} 个任务</span>}
                          {num(slangLearn?.researching) > 0 && <span>分析中的候选 {num(slangLearn?.researching)} 条</span>}
                          {slangLearn?.stopRequested === true && <span>已收到停止请求</span>}
                          {slangLearn?.learnerSessionActive === true && <span>学习会话已建立</span>}
                        </div>
                      </>
                    ) : !slangLearnUnavailable ? (
                      /* 2026-09-30数据尚未回来（首帧 / 本页刚从别处切回）：只显示中性一行。
                         此前此处的降级块带 AlertTriangle +「学习状态不可用」，等于把"还没结论"说成结论，
                         正是此前反馈的"每次点开都跳一遍『学习状态不可用』再恢复正常"。 */
                      <div className="lrn-learn-state is-unknown">
                        <Loader2 size={13} className="spin" />
                        <span className="lrn-learn-note">正在读取学习状态（桥侧 learning 快照）…</span>
                      </div>
                    ) : (
                      /* 状态取不到（旧版桥无 learning 字段，或本次读取已确定失败）：明确标注「取不到」，
                         不显示任何学习阶段——显示错误状态比不显示更为不利。黑话库本身仍可查看与修改。 */
                      <>
                        <div className="lrn-learn-state is-unknown">
                          <AlertTriangle size={13} />
                          <span className="badge badge-soft">学习状态不可用</span>
                          <span className="lrn-learn-note">
                            桥本次未返回 learning 快照（旧版桥，或本次读取失败）。此处不显示学习阶段，以免呈现错误状态；
                            黑话库本身仍可查看、修改与删除。
                            {/* 2026-09-30：此处原有一个「重新读取」按钮，已移除：本页会自行重读。 */}
                            {autoRetryNote(autoRetryMs)}
                          </span>
                        </div>
                        <div className="lrn-status-meta" style={{ marginTop: 4 }}>
                          <span>黑话库：{slangCounts.total} 条 · 已确认 {slangCounts.confirmed} · 未确认 {slangCounts.candidate}{slangCounts.rejected > 0 ? ` · 已拒收 ${slangCounts.rejected}` : ''}</span>
                        </div>
                      </>
                    )}
                    <div className="cfg-fields">
                      <label className="switch-row" title={cfgReady ? undefined : '配置尚未读取到，暂不可修改'}>
                        <input type="checkbox" checked={slgEnabled === true} disabled={!cfgReady} onChange={(e) => setSlgEnabled(e.target.checked)} />
                        <span>启用定时学习</span>
                        <em>每日按下方时间自动学习一次群聊黑话</em>
                      </label>
                      <label className="field-row">
                        <span className="f-label">定时时间（北京时）</span>
                        <input className="input" type="text" inputMode="numeric" placeholder="如 04:00（留空表示不定时）"
                          value={slgTime} disabled={!cfgReady} onChange={(e) => setSlgTime(normHHMM(e.target.value))} />
                      </label>
                      <label className="switch-row" title={cfgReady ? undefined : '配置尚未读取到，暂不可修改'}>
                        <input type="checkbox" checked={slgLiveWin === true} disabled={!cfgReady} onChange={(e) => setSlgLiveWin(e.target.checked)} />
                        <span>实时窗口提取</span>
                        <em>开启：消息到达时实时提取唤醒，额度消耗更高；关闭：仅在定时任务中批量学习</em>
                      </label>
                      <label className="switch-row" title={cfgReady ? undefined : '配置尚未读取到，暂不可修改'}>
                        <input type="checkbox" checked={slgResearch === true} disabled={!cfgReady} onChange={(e) => setSlgResearch(e.target.checked)} />
                        <span>自动深入研究</span>
                        <em>提取到新词后自动执行一轮深度研究</em>
                      </label>
                      <label className="switch-row" title={cfgReady ? undefined : '配置尚未读取到，暂不可修改'}>
                        <input type="checkbox" checked={slgIntv === true} disabled={!cfgReady} onChange={(e) => setSlgIntv(e.target.checked)} />
                        <span>自动间隔学习</span>
                        <em>按固定间隔增量学习一次（自上次学习点起），可与每日定时并存</em>
                      </label>
                      <label className="field-row">
                        <span className="f-label">间隔（小时）</span>
                        <NumInput className="input" value={slgIntvHours} disabled={!cfgReady} placeholder={cfgReady ? undefined : '尚未读取'}
                          onCommit={(n) => setSlgIntvHours(clampHrs(n || 24))} />
                      </label>
                    </div>
                    <div className="lrn-inline-note">
                      {lastLearnAt > 0
                        ? <><Clock3 size={13} /> 上次自动学习：{bjClock(lastLearnAt)}</>
                        : <><Clock3 size={13} /> 尚未执行定时学习</>}
                    </div>
                    <div className="lrn-actions">
                      {/* 配置尚未读到时禁用保存：此时表单是空的，保存下去等于把空值当成配置写回。 */}
                      <button className="btn btn-primary btn-sm" disabled={slangBusy !== null || !cfgReady}
                        title={cfgReady ? undefined : '学习配置尚未读取到，暂不可保存；本页会自动重读，读到后即可保存'}
                        onClick={saveSlang}>
                        {slangBusy === 'save' ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 保存配置
                      </button>
                      <button className="btn btn-soft-primary btn-sm" disabled={slangBusy !== null} onClick={learnSlang}>
                        {slangBusy === 'learn' ? <Loader2 size={14} className="spin" /> : <Play size={14} />} 黑话立即学习
                      </button>
                      <button className="btn btn-outline-danger btn-sm" disabled={slangBusy !== null} onClick={stopSlang}>
                        {slangBusy === 'stop' ? <Loader2 size={14} className="spin" /> : <Square size={14} />} 停止学习
                      </button>
                      <button className="btn btn-sm" onClick={openSlangLib} title="查看已学到的黑话词条（含含义、用法例句与出现次数）">
                        <BookOpen size={14} /> 黑话库{slangEntries.length ? `（${slangEntries.length}）` : ''}
                      </button>
                    </div>
                  </div>

                  <div className="lrn-divider" />

                  {/* 人格学习 */}
                  <div className="lrn-block">
                    <div className="lrn-block-title">人格学习（学习指定 QQ 的语言风格与性格）</div>
                    <div className="cfg-fields">
                      <label className="switch-row" title={cfgReady ? undefined : '配置尚未读取到，暂不可修改'}>
                        <input type="checkbox" checked={perEnabled === true} disabled={!cfgReady} onChange={(e) => setPerEnabled(e.target.checked)} />
                        <span>启用人格学习</span>
                        <em>关闭后桥侧将拒绝人格学习请求</em>
                      </label>
                      <label className="switch-row" title={cfgReady ? undefined : '配置尚未读取到，暂不可修改'}>
                        <input type="checkbox" checked={perIntv === true} disabled={!cfgReady} onChange={(e) => setPerIntv(e.target.checked)} />
                        <span>自动间隔学习</span>
                        <em>按间隔对下方目标全量重新学习；窗口自上次学习起算（未运行过则取近 30 天）</em>
                      </label>
                      <label className="field-row">
                        <span className="f-label">间隔（小时）</span>
                        <NumInput className="input" value={perIntvHours} disabled={!cfgReady} placeholder={cfgReady ? undefined : '尚未读取'}
                          onCommit={(n) => setPerIntvHours(clampHrs(n || 24))} />
                      </label>
                      <label className="field-row">
                        <span className="f-label">每日定时（北京时）</span>
                        <input className="input" type="text" inputMode="numeric" placeholder="如 04:00（留空表示不定时）"
                          value={perTime} disabled={!cfgReady} onChange={(e) => setPerTime(normHHMM(e.target.value))} />
                      </label>
                    </div>
                    <div className="field-row full" style={{ marginTop: 8 }}>
                      <span className="f-label">目标 QQ（可填多个：每行一个，亦支持逗号分隔）</span>
                      <textarea className="textarea" rows={Math.max(2, Math.min(5, qqs.length + 1))}
                        value={qqText} placeholder={'例如: 10001\n或: 123456789, 987654321'} disabled={!cfgReady}
                        onChange={(e) => setQqText(e.target.value)} />
                    </div>
                    <div className="lrn-actions">
                      <button className="btn btn-primary btn-sm" disabled={personaBusy !== null || !cfgReady}
                        title={cfgReady ? undefined : '学习配置尚未读取到，暂不可保存；本页会自动重读，读到后即可保存'}
                        onClick={savePersona}>
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

                  {/* 群友画像学习：目标自动从聊天记录中筛选，结果写回 profiles 表，群友画像页立即可见 */}
                  <PortraitLearnBlock />
                </>
            </div>

            {/* ============ 右：人格学习状态（与左卡片等高；分上下两栏：人格学习 / 画像学习；超出部分滚动；点击查看完整资料）
                【2026-09-19 外层增设 .lrn-status-col 的原因】
                需求为「粉色板内的滚动区铺至板底，同时整行不被拉长」。两项要求须同时满足，
                故须使右卡完全不参与行高计算，否则内容增多会把 grid 的 auto 行撑高：
                  · .lrn-status-col 为 position: relative 的 grid item（经 align-items: stretch 拉至行高），
                    自身不产生内容高度（唯一子元素为绝对定位）；
                  · 内部卡片 position: absolute; inset: 0，因而精确等于左栏撑出的高度，
                    内容再多也只在其内部滚动，不向外扩展。
                此前采用 `.lrn-status-block-fill .lrn-status-scroll { max-height: 720px }` 之类手调上限
                以勉强维持该效果（历史上调整过三次 300→640→720），左栏一变高即失效。 */}
            <div className="lrn-status-col">
            <div className="card lrn-status-card">
              <div className="card-title">
                <Users size={17} /> 人格学习状态
                <span className="lrn-updated">只读展示 · 每 60 秒自动刷新{statusAt ? ` · 更新于 ${statusAt}` : ''}</span>
              </div>
              <div className="lrn-status-body">
              {/* ——— 上面一栏：人格学习（现有那批人格学习目标；点一条展开看完整资料，行为不变） ——— */}
              <div className="lrn-status-block">
                <div className="lrn-block-title">人格学习<span className="lrn-status-hint">只学「目标 QQ」中的成员 · 点一条查看完整资料</span></div>
                {/* 现状为「学习完成后仅留存一份性格档案」，故在栏标题处写明边界与出口：
                    学习对象范围，以及学习结果如何转成机器人自身人设。 */}
                <div style={{ margin: '-4px 0 8px', fontSize: 11.5, lineHeight: 1.65, color: 'var(--nc-foreground-400)' }}>
                  仅学习左侧「目标 QQ」中配置的成员，本栏亦只列出目标名单内成员。展开一条可查看学习产出的
                  <b>英文人设正文</b>，并可「结合原人设完善」（在现有基础上按已学特点增删改，先生成草稿）或直接「整篇覆盖人设」。
                  {pOtherRows.length > 0 && (
                    <> 另有 {pOtherRows.length} 条档案不在目标名单中（由画像学习自动筛出），已归入下方「画像学习」栏。</>
                  )}
                </div>
              {statusErr ? (
                <div className="lrn-error">
                  <AlertTriangle size={15} />
                  <div style={{ flex: 1 }}>
                    {statusErr}
                    <div className="lrn-error-detail">{autoRetryNote(autoRetryMs)}</div>
                  </div>
                </div>
              ) : pTargetRows.length === 0 ? (
                <div className="empty-state" style={{ padding: '34px 12px' }}>
                  <Users size={34} style={{ color: 'var(--nc-foreground-300)', marginBottom: 10 }} />
                  <div style={{ color: 'var(--nc-foreground-400)', fontSize: 13 }}>
                    {pOtherRows.length > 0
                      ? <>目标名单中尚无档案<br />（另有 {pOtherRows.length} 条档案位于下方「画像学习」栏）<br />点「人格立即学习」开始学习目标 QQ</>
                      : <>暂无档案<br />已学习或正在学习的目标将显示于此（点「人格立即学习」开始）</>}
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
                        onClick={() => openProfile(it.uid)} title={open ? '点击收起' : '点击查看完整资料'}>
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
                            /* 2026-09-14 反馈：展开卡片须显示完整资料：
                             *   ① 旧版仅显示 profiles 表中若干被截断的短字段（性格 200 字、备注 200~300 字），
                             *      并叠加两段内容近似的「备注/人格摘要」，重复且显得未完；
                             *   ② 现优先显示成文画像（桥端合成的一整段介绍），结构化字段仅在无成文画像时
                             *      退化为列表显示，避免同一内容重复呈现；
                             *   ③ 数据层（/api/learning/profile）已不再截断，此处亦不作任何 clamp。 */
                            const lib = d?.library ?? null;
                            const intro = String(lib?.profile || pf?.personality || d?.personaSummary || '').trim();
                            const summaryText = String(d?.personaSummary || '').trim();
                            // 目标列表以本页读到的学习配置为准（与左侧「目标 QQ」为同一份）；配置读取失败时
                            // 回退到桥侧 status 的 inTargetList，避免因一次加载失败禁用全部按钮。
                            const inTarget = cfg ? personaTargets.has(it.uid) : it.inTargetList;
                            // 英文人设正文：库中存在则展示（可编辑），不存在则提示为旧版档案，不作假定
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

                              {/* 无成文画像（旧档案）时退化为字段列表，确保信息不丢失 */}
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
                              {/* 人格摘要与成文画像内容相同时不再重复显示 */}
                              {summaryText && summaryText !== intro && (
                                <div className="lrn-wide"><span className="lrn-dk">人格摘要</span><p className="lrn-prose">{summaryText}</p></div>
                              )}

                              {/* 英文人设正文（personaEn）：本轮人格学习的成品，在此处审批与修正，
                                  随后可覆盖机器人自身人设。整块调用 stopPropagation：若不阻止冒泡，
                                  在输入框内打字会触发整行「点击收起」，输入未完成即收起卡片。 */}
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
                                    该目标不在人格学习目标列表中（仅左侧「目标 QQ」中配置者计入；此条多由「画像学习」自动筛出），仅可查看，不能覆盖机器人人设。
                                  </div>
                                )}
                                {!peLib && !peHasDraft && (
                                  <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.6, color: 'var(--nc-foreground-400)' }}>
                                    该档案由旧版本学习生成，尚无英文人设正文：重新运行一次人格学习即可生成
                                    {inTarget ? '（也可在下方自行撰写纯英文正文，再点保存或覆盖）' : ''}。
                                  </div>
                                )}
                                {(inTarget || !!peLib) && (
                                  <textarea
                                    className="textarea"
                                    value={peText}
                                    readOnly={!inTarget}
                                    onChange={(e) => setPeDraft((m) => ({ ...m, [it.uid]: e.target.value }))}
                                    rows={7}
                                    spellCheck={false}
                                    placeholder="纯英文人设正文（150~400 词）：身份、表达方式、关注点、语气与忌讳。含中文将被桥侧拒回。"
                                    /* 2026-09-23原为写死边框/底色的行内样式（`border: 1px solid hsl(339.33 90% 88%)`
                                       与 `background: #fff`），绕开了全局输入框的悬停/聚焦/错误边框样式；现改用全局
                                       `textarea` 类，只保留排版所需的行内属性（宽度、外边距、撑满盒模型、可竖向拉伸）。 */
                                    style={{ width: '100%', marginTop: 5, boxSizing: 'border-box', resize: 'vertical' }}
                                  />
                                )}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                                  <button
                                    className="btn btn-soft-primary btn-sm"
                                    disabled={!!peBusy || !inTarget || !peLib}
                                    title={inTarget
                                      ? '由桥运行一轮模型：将已学特点并入当前机器人人设并重新增删改，产出草稿填入输入框（不写盘，确认后再覆盖）'
                                      : '该目标不在人格学习目标列表中，不可使用'}
                                    onClick={() => fusePersonaEn(it.uid)}
                                  >
                                    {peBusy === `fuse:${it.uid}` ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />} 结合原人设完善
                                  </button>
                                  <button
                                    className="btn btn-soft-primary btn-sm"
                                    disabled={!!peBusy || !inTarget || !peText.trim()}
                                    title={inTarget ? '将输入框中的正文写回该档案（机器人当前人设不变）' : '该目标不在人格学习目标列表中，不可修改'}
                                    onClick={() => savePersonaEn(it.uid, peText)}
                                  >
                                    {peBusy === `save:${it.uid}` ? <Loader2 size={13} className="spin" /> : <Save size={13} />} 保存修正
                                  </button>
                                  <button
                                    className="btn btn-primary btn-sm"
                                    disabled={!!peBusy || !inTarget || !peText.trim()}
                                    title={inTarget ? '以输入框中的这段英文整篇替换机器人当前人设（旧人设自动备份）' : '该目标不在人格学习目标列表中，不可覆盖'}
                                    onClick={() => applyPersonaEn(it.uid, peText)}
                                  >
                                    {peBusy === `apply:${it.uid}` ? <Loader2 size={13} className="spin" /> : <Zap size={13} />} 整篇覆盖人设
                                  </button>
                                  {num(it.personaEditedAtMs) > 0 && <span style={{ fontSize: 11.5, color: 'var(--nc-foreground-400)' }}>上次修正 {bjClock(num(it.personaEditedAtMs))}</span>}
                                  {num(it.personaAppliedAtMs) > 0 && <span style={{ fontSize: 11.5, color: 'var(--nc-foreground-400)' }}>上次覆盖 {bjClock(num(it.personaAppliedAtMs))}</span>}
                                </div>
                                <div style={{ marginTop: 5, fontSize: 11.5, lineHeight: 1.65, color: 'var(--nc-foreground-400)' }}>
                                  两种用法：<b>「结合原人设完善」</b>为在当前人设上按已学特点增删改，产出草稿（<b>不写盘</b>，修改后再覆盖）；
                                  <b>「整篇覆盖人设」</b>为直接以输入框中的正文替换当前人设（覆盖前自动备份，自下一条消息起生效）。
                                </div>
                                {peNote[it.uid] && (
                                  <div style={{ marginTop: 5, fontSize: 12, lineHeight: 1.6, color: 'var(--nc-foreground-500)' }}>{peNote[it.uid]}</div>
                                )}
                              </div>
                              {!profBusy && !profErr[it.uid] && !intro && !pf && !summaryText && (
                                <div className="lrn-dk">该对象在记忆库中尚无档案（仅存在上述学习状态）。</div>
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

              {/* ——— 下方一栏：画像学习（portraitAction('status') 的 config / status / lastTargets / running）———
                  本栏 flex: 1：卡片被左卡拉高时由其占满余量，资料区铺至卡底，不留空白。 */}
              <div className="lrn-status-block lrn-status-block-fill">
                <div className="lrn-block-title">
                  画像学习
                  <button className="btn btn-sm lrn-block-refresh" onClick={() => refreshPortrait()} title="重新读取一次画像学习状态（常规每 60 秒自动刷新）">
                    <RefreshCw size={12} /> 刷新
                  </button>
                </div>
                {ptErr ? (
                  <div className="lrn-error">
                    <AlertTriangle size={15} />
                    <div style={{ flex: 1 }}>
                      {ptErr}
                      <div className="lrn-error-detail">{autoRetryNote(autoRetryMs)}</div>
                    </div>
                  </div>
                ) : !ptStatus ? (
                  <div className="lrn-status-meta"><Loader2 size={13} className="spin" /> 正在读取画像学习状态…</div>
                ) : (() => {
                  const ptCfg: Record<string, any> = isObj(ptStatus?.config) ? ptStatus.config : {};
                  const ptList: any[] = Array.isArray(ptStatus?.status) ? ptStatus.status : [];
                  const ptLast: string[] = Array.isArray(ptStatus?.lastTargets) ? ptStatus.lastTargets.map(String) : [];
                  const winDays = Math.max(1, Math.round(num(ptCfg.windowHours) / 24) || 1);
                  const ptTime = typeof ptCfg.timeHHMM === 'string' ? ptCfg.timeHHMM.trim() : '';
                  // 「进行中」：按本栏实际列出的档案数统计，避免与上方列表不一致
                  const ptLearning = pOtherRows.filter((x) => x.state === 'learning').length;
                  // 画像学习已记录但库中尚无档案的目标（刚完成尚未落库）：单独列出，不作已有资料处理
                  const ptOnlyUids = ptList.map((x: any) => String(x?.uid ?? '')).filter((u) => u && !pOtherRows.some((r) => String(r.uid) === u));
                  return (
                    <>
                      {/* 【2026-09-16 要求】标题、刷新按钮与上述两行摘要置于滚动区外（头部固定），
                          仅下方档案列表限高滚动——画像学习栏不再把整张卡拉高。 */}
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
                      {/* 名单外档案（含以往学习过的群友）全部列于本栏：点击一条可展开或收起完整资料，
                          展示字段与上方人格学习栏一致，但不含英文人设正文与「覆盖机器人人设」——
                          人设仅可来自目标名单。 */}
                      {pOtherRows.map((it: PItem) => {
                        const uid = String(it.uid);
                        const open = openUid === uid;
                        const d = profDetail[uid] || null;
                        return (
                          <div className={`lrn-status-row${open ? ' is-open' : ''}`} key={uid} id={`lrn-row-${uid}`}
                            onClick={() => openProfile(uid)} title={open ? '点击收起资料' : '点击查看完整资料'}>
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
                            ? '尚无任何档案：点左侧「画像立即学习」按配置自动筛选活跃群成员，或开启自动间隔 / 每日定时。'
                            : '目标名单以外的档案为空（已学习者均属目标名单，或画像学习尚未运行）。'}
                        </div>
                      )}
                      {ptOnlyUids.length > 0 && (
                        <div className="lrn-status-preview" style={{ borderLeft: 'none', paddingLeft: 0 }}>
                          最近一轮画像学习涉及 {ptOnlyUids.length} 个对象，但尚未生成档案：{ptOnlyUids.slice(0, 12).join('、')}{ptOnlyUids.length > 12 ? ' …' : ''}
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

          {/* ============ 黑话库弹窗：分为「已确认 / 未确认（候选）/ 已拒收」三组（已拒收默认折叠）；
              仅未确认分组可勾选；每条均设删除入口（二次确认）；
              【2026-09-16】「批量通过」已移除（研究会话确认后桥侧自动转 confirmed） ============ */}
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
            // 2026-09-16按 status 的真实取值分组（桥侧仅可能为 candidate / confirmed / rejected 三种）：
            //   · 已确认 = confirmed（含研究会话自动转入的 autoConfirmed）；
            //   · 未确认 = candidate，即桥侧 counts.candidate，两组标题计数与该数据一致；
            //   · rejected 既不属「已确认」也不属「未确认」，单独折为第三组（默认收起）：
            //     数据不可丢失，但不得干扰上述两组的计数语义。勾选框仅出现在「未确认（候选）」一组。
            const confirmedList = list.filter((e) => String(e?.status ?? '') === 'confirmed');
            const candidateList = list.filter((e) => String(e?.status ?? '') === 'candidate');
            const rejectedList = list.filter((e) => String(e?.status ?? '') === 'rejected');
            // 勾选仅认可当前可见（经搜索过滤）的候选项，避免搜索后残留失效勾选
            const visIds = candidateList.map(idOf).filter(Boolean);
            const selIds = visIds.filter((id) => selSet.has(id));
            const allSel = visIds.length > 0 && selIds.length === visIds.length;
            /**           / 标题计数取桥的 counts（取不到则按 entries 计算，二者为同一份数据）；搜索时另行标出当前命中条数 */
            const cnt = (n: number, hit: number) => `${n} 条${kw ? `（当前命中 ${hit}）` : ''}`;
            const toggle = (id: string) => {
              if (!id) return;
              setSlangSel((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
            };
            const act = (kind: 'reject' | 'research') => { void slangBatch(kind, selIds); };
            /**           / 单条词条。仅「未确认（候选）」一组 selectable=true，其余组为只读展示并提供删除入口。 */
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
                    ? (id ? (picked ? '点击取消选择' : '点击选择该条') : '该词条没有 id，无法勾选（桥侧旧数据）')
                    : st === 'rejected'
                      ? '已拒收的黑话：只读展示（不参与查询，可留存档案）；无需留存时点右侧「删除」'
                      : '已确认的黑话：只读展示（研究会话确认后桥侧自动转为已确认，无需人工批量通过）'}
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
                        <span className="badge badge-info" title="研究会话明确确认（confirmed:true 且含含义、风险不高）后由桥自动转为已确认">自动确认</span>
                      )}
                      <span className="lrn-status-caret">出现 {num(e?.count)} 次 · {String(e?.source ?? '')}</span>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-danger lrn-slang-del"
                        disabled={!!slangLibBusy || !id}
                        title={id ? '删除该黑话（将二次确认；删除后机器人不再使用该黑话）' : '该词条没有 id，无法删除（桥侧旧数据）'}
                        onClick={(evt) => { evt.stopPropagation(); void deleteSlang(e); }}
                      >
                        {slangLibBusy === `del:${id}` ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} />} 删除
                      </button>
                    </div>
                    {String(e?.meaning ?? '').trim()
                      ? <div className="lrn-status-preview">{String(e.meaning)}</div>
                      : <div className="lrn-status-preview" style={{ opacity: .65 }}>（尚无释义：达到出现次数阈值后自动研究补齐，也可勾选后点「批量分析」）</div>}
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
                        {kw ? ` · 命中 ${list.length} 条` : ''} · 确认后不会在每轮对话中注入，机器人按需查询黑话库
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
                        onClick={() => act('reject')} title="将选中词条标记为已拒收（不再参与查询，可留存不删除）">
                        {slangLibBusy === 'reject' ? <Loader2 size={13} className="spin" /> : <X size={13} />} 批量拒收
                      </button>
                      <button type="button" className="btn btn-soft-primary btn-sm" disabled={!!slangLibBusy || !selIds.length}
                        onClick={() => act('research')} title="对选中的候选词条触发一次研究分析（桥侧后台串行执行，完成后补齐含义、用法与例句）">
                        {slangLibBusy === 'research' ? <Loader2 size={13} className="spin" /> : <Search size={13} />} 批量分析
                      </button>
                    </div>
                    <div className="lrn-slang-note">
                      「已确认」的含义为该词条已入库、具备含义且可被检索。黑话默认不注入唤醒提示词（桥侧 injectIntoPrompt 默认关闭），
                      机器人遇到不认识的词时自行调用 qq_slang_query 工具按需查库，故仅「已确认且已填含义」的词条可被检索到。
                      候选词条的释义由「批量分析」交由研究会话补齐，<b>研究会话明确确认后桥侧自动转为「已确认」</b>
                      （slang.js 中的 autoConfirmed 一段），因此此处不再提供「批量通过」。删除不可恢复；如需留存档案，宜改用「批量拒收」。
                    </div>
                    {slangNote && <div className="lrn-slang-result">{slangNote}</div>}
                  </div>

                  <div className="pfp-body">
                    {slangErr && <div className="pfp-empty">读取失败：{slangErr}（黑话库位于桥的 state/slang.json，桥未连通时无法读取）</div>}
                    {!slangErr && list.length === 0 && (
                      <div className="pfp-empty">
                        {slangEntries.length === 0 ? '尚未学到任何词条：点「黑话立即学习」执行一轮，或等待定时学习触发。' : '没有匹配的词条。'}
                      </div>
                    )}
                    {!slangErr && list.length > 0 && (
                      <>
                        {/* ——— 已确认（只读；标题计数 = 桥 learning.counts.confirmed） ——— */}
                        <div className="lrn-slang-group">
                          <div className="lrn-slang-group-h">
                            <Check size={13} /> 已确认
                            <span className="lrn-slang-group-n">{cnt(slangCounts.confirmed, confirmedList.length)}</span>
                            <span className="lrn-slang-group-hint">只读 · 研究会话确认后桥侧自动转为已确认，无需人工批量通过</span>
                          </div>
                          {confirmedList.length > 0
                            ? confirmedList.map((e, i) => rowOf(e, i, false))
                            : <div className="pfp-empty">{kw ? '没有命中的已确认词条。' : '本组当前为空：尚无词条被确认（候选经研究会话确认并给出含义后自动归入本组）。'}</div>}
                        </div>
                        {/* ——— 未确认（= 候选，可勾选；标题计数 = 桥 learning.counts.candidate） ——— */}
                        <div className="lrn-slang-group">
                          <div className="lrn-slang-group-h">
                            <AlertTriangle size={13} /> 未确认
                            <span className="lrn-slang-group-n">{cnt(slangCounts.candidate, candidateList.length)}</span>
                            <span className="lrn-slang-group-hint">可勾选后执行「批量分析 / 批量拒收」；每条亦可单独删除</span>
                          </div>
                          {candidateList.length > 0
                            ? candidateList.map((e, i) => rowOf(e, i, true))
                            : <div className="pfp-empty">{kw ? '没有命中的未确认词条。' : '无未确认词条：候选均已确认入库，机器人可按需检索。'}</div>}
                        </div>
                        {/* ——— 已拒收：既不进"已确认"也不进"未确认"，单独折一组（默认收起），数据不丢 ——— */}
                        {(rejectedList.length > 0 || slangCounts.rejected > 0) && (
                          <div className="lrn-slang-group">
                            <div className="lrn-slang-group-h lrn-slang-group-h-btn" role="button" tabIndex={0}
                              onClick={() => setSlangShowRejected((v) => !v)}
                              onKeyDown={(evt) => { if (evt.key === 'Enter' || evt.key === ' ') { evt.preventDefault(); setSlangShowRejected((v) => !v); } }}
                              title="已拒收的词条不再参与查询，可留存档案；无需留存时展开后逐条删除">
                              <X size={13} /> 已拒收
                              <span className="lrn-slang-group-n">{cnt(slangCounts.rejected, rejectedList.length)}</span>
                              <span className="lrn-slang-group-hint">
                                既不属「已确认」也不属「未确认」（桥侧 status=rejected）· {slangShowRejected ? '点击收起 ▾' : '点击展开 ▸'}
                              </span>
                            </div>
                            {slangShowRejected && (
                              rejectedList.length > 0
                                ? rejectedList.map((e, i) => rowOf(e, i, false))
                                : <div className="pfp-empty">{kw ? '没有命中的已拒收词条。' : '本组当前为空。'}</div>
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
/* 用量统计：本机与服务端两处数据均取，分别显示「本机 / 服务端 / 合计」三块 */
/* ================================================================== */
/** 用量来源摘要：本机桥 / 服务端桥 / 合计 */
interface UsageSource { rep: any | null; reason: string; server?: { name: string; host: string } | null; }

/** 某份报告中的「今日已用」（与下方 todayUsed 同一口径：优先 billedTotal，其次四项相加） */
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
  /* 2026-09-19 修复「剪枝数据行不显示」该字段位于响应顶层（r.contextSavings），不在 total 内；
   * 此前写作 report?.contextSavings（report = total），始终取不到，导致整行不渲染。 */
  const [savings, setSavings] = useState<any>(null);
  const [split, setSplit] = useState<{ local: any | null; remote: any | null; total: any | null; localReason: string; remoteReason: string; remoteServer: any } | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState('');
  const [live, setLive] = useState<'sse' | 'poll'>('poll');
/** 失败后的自动重试间隔（毫秒，0 = 正常）：仅用于如实说明"现在多久重读一次"。 */
  const [autoRetryMs, setAutoRetryMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [rcMsg, setRcMsg] = useState('');
  const inflight = useRef(false);
  const lastReload = useRef(0);

/** 2026-09：按要求「刷新和与 dsh 对账合并成刷新，自动对账」 */
/**  合并前是两个按钮：`刷新`（只取用量）与 `与 DSH 对账`（只补记并回读）。 */
/**  现在合成一个 `刷新`：点击后并发发起「取用量」与「对账」，两侧都结束后再取一次用量， */
/**  使界面反映本次补记的结果；两侧的提示合并为一条（对账明细原样保留在 msg 里，能力无损失）。 */
/**  桥侧每 5 分钟仍会自动对账一次，此按钮只是"手动再执行一次"的入口，未减少任何能力。 */
  const doRefresh = async () => {
    if (busy) return;
    setBusy(true); setRcMsg('');
    try {
      // 对账失败（含桥不可达）不阻断用量刷新：以 { ok:false } 兜底，仍走下面同一套文案。
      const [rc]: any[] = await Promise.all([
        reconcileTokens().catch((e: any) => ({ ok: false, __error: String(e?.message ?? e) })),
        load(),
      ]);
      await load();   // 对账可能补入漏记的帧：再取一次，令面板数字与补记后的桥侧累计一致
      // 某一侧桥未运行属状态而非故障（后端已将 fetch failed 转为可读说明），不表述为「失败」；
      // 仅两侧均未对账成功时提示对账未执行。
      const line = (name: string, side: any, reason: string) => {
        if (side) {
          const res = side.result || {};
          if (res.reason) return `${name}：${res.reason}`;
          const add = num(res.addedTokens);
          return add > 0 ? `${name}：补记 ${num(res.added)} 笔 / ${fmtFull(add)} tokens` : `${name}：无差额（桥侧累计已达 DSH 自身的会话累计，不代表与提供方控制台一致）`;
        }
        if (!reason) return '';
        return reason.includes(name) ? reason : `${name}：${reason}`;
      };
      const parts = [line('本机', rc?.local, String(rc?.localReason || '')), line('服务端', rc?.remote, String(rc?.remoteReason || ''))].filter(Boolean);
      if (!rc?.ok) {
        setRcMsg(`已刷新；与 DSH 的对账未执行${parts.length ? '：' + parts.join('；') : '：两侧桥均未取到数据'}${rc?.__error ? `（${rc.__error}）` : ''}`);
        return;
      }
      setRcMsg(`已刷新，并与 DSH 完成对账${parts.length ? '：' + parts.join('；') : '：两侧均无差额'}`);
    } catch (e: any) {
      setRcMsg('刷新失败：' + String(e?.message ?? e));
    } finally { setBusy(false); }
  };

/** 取用量报表。返回是否成功（供自动退避重试用；2026-09-30 起失败不再给「重试」按钮）。 */
  const load = async (): Promise<boolean> => {
    // 已有一次读取在途：本轮不计为失败（否则会误触退避），照常由在途那次写结果
    if (inflight.current) return true;
    inflight.current = true;
    if (!report) setLoading(true);
    try {
      const r: any = await getTokenReport();
      const e = firstErr(r);
      if (e) { setErr(e); return false; }
      // 2026-09-14后端现返回 { local, remote, total, remoteReason, ... }：
      //   · local：本机桥的数据（始终获取，SSH 模式下亦保留）；
      //   · remote：服务端桥的数据（未连接服务器或服务端桥未运行时为 null，另以 remoteReason 说明原因）；
      //   · total：两份合并后的合计；曲线与分时图仍按合计绘制。
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
      setSavings(isObj(r?.contextSavings) ? r.contextSavings : null);
      if (!total) {
        setErr([next.localReason, next.remoteReason].filter(Boolean).join('；') || '两侧桥均未取到用量数据');
        return false;
      }
      setReport(total); setErr('');
      setUpdatedAt(bjClock(Date.now()));
      return true;
    } catch (e2: any) {
      setErr(String(e2?.message ?? e2));
      return false;
    } finally {
      inflight.current = false; setLoading(false);
    }
  };

  useEffect(() => {
    /* 2026-09-30 变更要求：读取失败不再给「重试」按钮，改为自动退避重读：
       失败后 5s → 10s → 20s → 40s → 60s（封顶 60 秒）；一旦读到即复位、交回 SSE / 60 秒轮询。
       失败事实照常显示（走下面 err && !report 那条分支），页面不会变成"永远转圈"。 */
    let alive = true;
    let retry: number | null = null;
    let backoff = 0;
    const retryTick = async () => {
      const ok = await load();
      if (!alive) return;
      if (ok) { backoff = 0; setAutoRetryMs(0); return; }
      backoff = backoff === 0 ? 5000 : Math.min(60000, backoff * 2);
      setAutoRetryMs(backoff);
      retry = window.setTimeout(() => { void retryTick(); }, backoff);
    };
    void retryTick();
    // 优先采用 SSE 实时推流（桥侧 token-meter 写入即推送）；连续失败时自动回退为 60 秒轮询
    let es: EventSource | null = null;
    let poll: number | null = null;
    let sseErrors = 0;
    const startPoll = () => { if (poll === null) poll = window.setInterval(() => { void load(); }, 60000); };
    const stopPoll = () => { if (poll !== null) { clearInterval(poll); poll = null; } };

    const apply = (data: string) => {
      let payload: any = null;
      try { payload = JSON.parse(data); } catch { return; }
      const rep = isObj(payload?.report) ? payload.report : isObj(payload?.result?.report) ? payload.result.report : null;
      if (!rep) return;
      // SSE 仅推送单侧桥的原始报告，而面板显示「本机 + 服务端 + 合计」三段：
      // 直接 setReport(rep) 会把合计覆盖为单侧数据（服务端一份将被清除）。
      // 故此处改为节流地整段重取（最多每 15 秒一次），数据保持新鲜，三段互不覆盖。
      const now = Date.now();
      if (now - lastReload.current < 15000) return;
      lastReload.current = now;
      void load();
    };

    try {
      es = new EventSource('/api/learning/token-stream');
      es.addEventListener('token', (ev: MessageEvent) => {
        sseErrors = 0; stopPoll(); setLive('sse');
        apply(ev.data);
      });
      es.addEventListener('stream-error', () => { sseErrors += 1; setLive('poll'); startPoll(); });
      es.onerror = () => {
        // EventSource 自带重连；先并行启用轮询兜底，推流恢复后自动停止
        sseErrors += 1;
        if (sseErrors >= 2) { setLive('poll'); startPoll(); }
      };
    } catch {
      setLive('poll'); startPoll();
    }

    return () => {
      alive = false;
      if (retry !== null) window.clearTimeout(retry);
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
          <div style={{ flex: 1 }}>
            {err}
            <div className="lrn-error-detail">用量取自桥侧 /api/token-report：本机桥与服务端桥均不可用时无法统计（服务端桥未运行时单独给出原因）。</div>
            <div className="lrn-error-detail">{autoRetryNote(autoRetryMs)}</div>
          </div>
        </div>
      </div>
    );
  }

  const days = normDays(report?.dates);
  const hours = normHours(report?.todayHourly);
  const today = isObj(report?.today) ? report.today : {};
  // 2026-09-12 修复「今日已用较平台虚高 1/3」根因并非重复计数，而在日界口径：
  //   桥原按北京自然日聚合，而提供方（小米 MiMo 开放平台）按 UTC 自然日结算，
  //   即北京时间每日 08:00 换日。实测：同一份 token-usage.jsonl，
  //   北京日合计 13,809,552（242 帧），UTC 日合计 10,382,792（164 帧），平台显示 10,383,812（差 0.0098%）。
  //   桥侧 token-meter.js 已改为「计费日」口径（默认偏移 480 分钟，即北京 08:00 换日；
  //   可用 QQB_TOKEN_DAY_OFFSET_MIN 调整，设为 0 精确回退旧口径），today 与 dates 均随之。
  // 此处同时计入 cacheWrite（缓存写入输入）：提供方的 total_tokens 为四项相加。
  // 新版桥直接给出 today.billedTotal（同一口径）；旧版桥无该字段时按四项相加兜底。
  const todayBilled = num(today.billedTotal)
    || (num(today.prompt) + num(today.completion) + num(today.cacheRead) + num(today.cacheWrite));
  const todayReal = todayBilled > 0 ? todayBilled : num(today.total);
  const todayEst = num(today.estTotal);
  // 「今日已用」：为真实计费量，不含字符估算（估算值仅在下方单独一行说明）。
  const todayUsed = todayReal;
  const todayProj = report && report.todayEstimatedTotal !== undefined ? num(report.todayEstimatedTotal) : todayUsed;
  const linearProj = num(report?.todayLinearEstimatedTotal);
  const projBy = String(report?.projectedBy || '');
  /* 对账补记（reconciled）单独报出：该类记录为桥侧漏记后的补入项，可能属更早的用量却落在今日；
   * 与提供方控制台核对时，先看此数值即可定位差额来源。旧版桥无该字段时为 0。 */
  const reconciledToday = num(today.reconciledTotal);
  /* 重试（llm/retry）：失败的尝试提供方仍计费，DSH 不产出 usage。面板单独列出，方可与控制台核对。
   * 次数优先取「剪枝计量」一份（其扫描会话日志，可回填历史）；token 估算取桥侧实时记账的一份。 */
  const retryCountToday = Math.max(num(today.retryCount), num(savings?.today?.retryEvents));
  const retryEstimatedToday = num(today.retryEstimated);
  const dayAvg = days.length ? days.reduce((a, d) => a + d.real + d.est, 0) / days.length : 0;
  const realSum = days.reduce((a, d) => a + d.real, 0);
  const estSum = days.reduce((a, d) => a + d.est, 0);
  const allReal = realSum + todayReal;
  const allEst = estSum + todayEst;
  // 自然日（自北京 00:00 起）合计：小时图本身按自然日聚合，直接对小时求和即可（不为此新增后端字段）
  const calTotal = hours.reduce((a, h) => a + h.prompt + h.completion + h.cacheRead, 0);
  // 计费日的起始时刻（桥侧 dayWindow.startBjMinutes：480 表示北京 08:00 换日，即 UTC 日，与平台口径一致）
  const dayStartMin = num(report?.dayWindow?.startBjMinutes);
  const dayStartLabel = dayStartMin > 0
    ? `北京 ${String(Math.floor(dayStartMin / 60)).padStart(2, '0')}:${String(dayStartMin % 60).padStart(2, '0')} 换日`
    : '北京 00:00 换日';
  const note = typeof report?.note === 'string' && report.note ? report.note : '';
  /* 上下文剪枝节省量（实测）：取自组件 state 中的 `savings`（响应顶层字段），前端不作任何估算。 */
  // 与 DSH 的对账状态（桥侧每 5 分钟自动执行一次；标题栏按钮为手动再执行一次）
  //
  // 2026-09-18 修复「文案使人误认为面板等同提供方控制台」原文案两处不准确：
  //  ①「逐会话与 DSH 完全一致」对账比的仅为 DSH 自身的会话级累计
  //     （DSH home 下 storages/session_projcache/sessions/*.json 中 record.rows.tokenUsage.val.totals），
  //     并非提供方控制台；且桥侧 reconcileWithDsh 按桶补差额，仅保证「桥侧累计 ≥ DSH 累计」。
  //  ②「平台控制台因结算延迟可能略差几秒的量」实测并非数秒量级。2026-09-18 19:07:03 实测数据：
  //     · 面板 21,842,584（即服务端桥 today.billedTotal；本机一份对当日贡献为 0，故合计即此值）；
  //     · 同一窗口按 DSH 自身落盘的事件日志（sessions/<slug>/session-*/*.jsonl.zstd 中
  //       assistant/chunk|message 的 usage，按 turn/step 取最终值）逐 step 合计 = 21,562,418；
  //     · 提供方控制台 = 21,563,440（与 DSH 逐 step 仅差 1,022，即 0.005%，此方为结算延迟的量级）。
  //     → 面板较 DSH 与控制台多 476,993，且恰等于 1 条对账补记行
  //       （session-724f5d85，2026-09-18 13:35:13，prompt=476,993、cacheRead=0）；
  //       桥侧 reconcileWithDsh 的逐桶 max(0, dsh−桥侧) 为单向棘轮：某桶记多即无法扣回
  //       （该会话桥侧终身 34,165,004 vs DSH 31,788,012，多 2,376,992），而补记行按对账时刻
  //       写入 tsMs，故该笔落在当日，抬高「今日已用」。
  //     因此文案须写明口径，不得再承诺「与提供方控制台一致」。
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
          {/* 【合并为一个刷新】取用量与「与 DSH 对账」原本是两个按钮，现合并为一键：点击后自动对账。 */}
          <button
            className="btn btn-sm" disabled={busy || loading} onClick={() => void doRefresh()}
            title="重新读取用量，并自动以 DSH 记录的逐会话累计用量与桥侧对账，补入桥侧漏记的 usage 帧（仅比对 DSH 自身的会话累计，不比对提供方控制台；补记按对账时刻计入当日）"
          >
            {busy || loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} 刷新
          </button>
        </span>
      </div>

      {rcMsg && <div className="lrn-note lrn-note-soft">{rcMsg}</div>}
      {/* 【2026-09-18】口径须明示：对账仅比对 DSH 自身记录的会话累计，不比对提供方控制台；
          补记行按对账时刻计入当日，当日数字因此可能高于控制台（2026-09-18 实测高 476,993）。
          此前文案写作「平台控制台因结算延迟可能略差几秒的量」，将 47 万的差额表述为数秒，有误。 */}
      {!rcMsg && rcText && (
        <div className="lrn-note lrn-note-soft lrn-note-block">
          <div>
            {rcText}（对账口径为桥侧累计 ↔ DSH 自身记录的会话累计，<b>不比对提供方控制台</b>；每 5 分钟自动执行一次。补记行按对账时刻计入当日，且桥侧某桶一旦记多即无法扣回，故当日数字可能高于控制台）
          </div>
        </div>
      )}

      {/* 【2026-09-19 要求「量化对比」】上下文剪枝的节省量，取自实测而非字符估算：
          桥直接读取 DSH 落盘的会话日志（sessions/<slug>/<sessionId>/session.jsonl.zstd），累加 compaction/prune
          记录的 shadowedTokenCount，并统计该会话之后发生的请求次数（step/start）：
          这些请求原需重读上述内容（计费为 cacheRead），剪除后不再计费。
          数值为 0 时亦显示一行，以表明该机制存在但尚未触发。 */}
      {savings && (
        <div className="lrn-note lrn-note-soft lrn-note-block">
          <div>
            <b>上下文剪枝（实测）</b>：
            {savings.today.prunedTokens > 0 ? (
              <>
                今日已从上下文中剪除 <b>{fmtFull(savings.today.prunedTokens)}</b> token（{fmtFull(savings.today.pruneEvents)} 次）；
                上述内容原会在之后每次请求中被重读，<b>今日少读 {fmtFull(savings.today.rereadSaved)} token</b>
                {todayUsed > 0 && `（相当于今日已用的 ${((savings.today.rereadSaved / todayUsed) * 100).toFixed(1)}%）`}。
              </>
            ) : (
              <>今日尚未触发剪枝（0 token）；工具结果超过阈值后方才剪除。</>
            )}
            {(savings.lifetime.rereadSaved > 0) ? <> 近 {savings.windowDays ?? 7} 天累计：剪除 {fmtFull(savings.lifetime.prunedTokens)} · 少读 {fmtFull(savings.lifetime.rereadSaved)}（{fmtFull(savings.lifetime.pruneEvents)} 次）。</> : null}
          </div>
          {/* 【2026-09-19 关于「对话是否也会压缩」】会，但属另一条路径：剪枝仅作用于工具结果；
              聊天内容超过阈值时才会把最早一段替换为 <compacted-summary>（需一次模型调用）。此处如实报数。 */}
          <div>
            {num(savings.today.summaryEvents) > 0
              ? <>聊天摘要压缩：今日发生 <b>{fmtFull(num(savings.today.summaryEvents))} 次</b>（将最早一段聊天替换为摘要，覆盖 {fmtFull(num(savings.today.summarizedTokens))} token）；细节仍可用 qq_get_recent_messages 从桥的记忆库中检索。</>
              : <>聊天摘要压缩：今日 <b>0 次</b>（仅剪除工具历史，聊天记录逐字保留）。</>}
          </div>
          <div className="lrn-note-muted">
            口径与用量共用同一计费日（{dayStartLabel}）；数据源为 DSH 自身的会话日志（当前扫描 {fmtFull(num(savings.scannedFiles))} 份），幂等重算，桥重启不丢失。
          </div>
        </div>
      )}

      {note && <div className="lrn-note lrn-note-soft">{note}</div>}

      {/* 【2026-09-14 要求】用量两侧皆不得遗漏：本机、服务端与合计三块分列显示。
          服务端取不到时此处给出原因（例如「服务端桥未运行」），本机一份照常显示。 */}
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
            {/* 【2026-09-19 关于「token 虚高」】将两处看似虚高的来源直接标注：
                ① 对账补记（桥侧漏记、事后按 DSH 会话累计补入的记录，时间戳取该次会话动作的时刻，
                   可能属更早的用量却落在今日）：单独报数，便于与提供方控制台核对；
                ② 自然日 00:00 起的总量（含 00:00–08:00 一段，而平台将该段计入昨日）。 */}
            {reconciledToday > 0 && <><br />其中对账补记 {fmtFull(reconciledToday)}（{num(today.reconciledSamples)} 笔，可能属更早的用量）</>}
            {/* 【2026-09-19 与提供方控制台核对】重试为「面板低于控制台」的主要来源：失败尝试提供方仍计费，
                而 DSH 不产出 usage（当日实测 2 次重试 ≈ 14.4 万 token，与两侧差额一致）。次数为精确值，token 为估算值。 */}
            {retryCountToday > 0 && (
              <><br />另有 {retryCountToday} 次重试未计入（失败尝试提供方仍计费，DSH 不产出 usage）{retryEstimatedToday > 0 ? `，按上一步规模估算 ≈ ${fmtFull(retryEstimatedToday)}` : ''}；与控制台的差额主要源于此处</>
            )}
            {calTotal > 0 && (
              <>
                <br />北京自然日 00:00 起合计 {fmtFull(calTotal)}；其中 00:00–08:00 一段平台计入<b>昨日</b>，
                故此数大于上方数值属正常，不应视为两笔用量
              </>
            )}
          </div>
        </div>
        <div className="lrn-stat">
          <div className="lrn-stat-t">今日预计</div>
          <div className="lrn-stat-v lrn-stat-proj">{fmtFull(todayProj)}</div>
          <div className="lrn-stat-s">
            {projBy === 'shape' ? '按最近 7 天同时段平均用量推算剩余时段（夜间用量极低，线性外推会明显偏高）' : '按当前速率线性外推，仅供参考，结果偏高' }
            {todayProj !== todayUsed && <>（已用 {fmtFull(todayUsed)}）</>}
            {linearProj > 0 && projBy === 'shape' && <>；线性外推口径为 {fmtFull(linearProj)}</>}
          </div>
        </div>
        <div className="lrn-stat lrn-stat-azure">
          <div className="lrn-stat-t">近 {days.length || 7} 日日均</div>
          <div className="lrn-stat-v">{fmtFull(dayAvg)}</div>
          <div className="lrn-stat-s">未命中 + 缓存命中 + 输出，按平台计费日聚合（{dayStartLabel} 换日）</div>
        </div>
      </div>

      {/* 近 7 日曲线（实线为实际值，虚线为估算值） */}
      <Chart7d days={days} />
      {(days.length > 0 && realSum + todayReal === 0 && allEst > 0) && (
        <div className="lrn-note"><AlertTriangle size={13} /> 该时段无真实计量（未收到 usage 帧），整条曲线均为估算值，仅供参考。</div>
      )}

      {/* 今日按北京小时迷你柱（自然日视图；「今日已用」卡片为平台计费日口径，两者在 00:00~08:00 段不同） */}
      <HourBars hours={hours} todayUsed={todayUsed} />

      {/* 实测计量与费用预算：口径分立，数据随 SSE 实时刷新 */}
      <TokenPanel hours={hours} />
    </div>
  );
}

function Chart7d({ days }: { days: DayStat[] }) {
  const W = 680; const H = 224;
  // 左右留白按「标注可完整容纳」确定：padL 收窄以安置纵轴标签，padR 预留一个数值标注的宽度，
  // 首末节点再以 start/end 锚点兜底，确保末点数值不被卡片边缘裁切。
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
  // 仅采用真实计量（未命中 + 命中 + 输出），不再以字符估算绘制第二条线
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
        <div className="lrn-note lrn-note-soft">另有 {fmtFull(estSum)} tok 为「未收到 usage 帧」时的字符估算，未计入曲线。</div>
      )}
    </div>
  );
}

function HourBars({ hours, todayUsed }: { hours: HourStat[]; todayUsed: number }) {
  const [tip, setTip] = useState<{ x: number; y: number; hour: number; total: number; miss: number; hit: number; out: number } | null>(null);
  // 2026-09-12 修复「提示框被右侧遮挡」此前固定写作 `left: x+14`，鼠标停于最右一根柱子时
  // 提示框向右溢出视口（实测 1360 宽右溢 52px、700 宽右溢 89px），被面板右边缘或滚动条遮挡。
  // 现改为：先置于鼠标右下，右侧或下方容纳不下则翻至鼠标左上；仍越界则夹回视口内（保留 10px 边距）。
  const tipRef = useRef<HTMLDivElement | null>(null);
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!tip || !tipRef.current) { setTipPos(null); return; }
    const el = tipRef.current;
    const w = el.offsetWidth; const h = el.offsetHeight;
    const vw = window.innerWidth; const vh = window.innerHeight;
    const M = 10;                       // 与视口边缘保持的边距
    let left = tip.x + 14;
    if (left + w > vw - M) left = tip.x - 14 - w;   // 右侧容纳不下则翻至鼠标左侧
    left = Math.max(M, Math.min(left, vw - w - M)); // 再夹回视口内（窗口过窄时亦不被遮挡）
    let top = tip.y + 14;
    if (top + h > vh - M) top = tip.y - 14 - h;     // 下方容纳不下则翻至鼠标上方
    top = Math.max(M, Math.min(top, vh - h - M));
    setTipPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
  }, [tip]);
  const W = 680; const H = 168;
  // padT 须为柱顶数字预留完整一行，否则当日最高柱填满时标注会超出画布；
  // padR 同理为最右一根柱子预留位置，柱顶文字再以 anchorInside 兜底。
  const padL = 44; const padR = 22; const padT = 22; const padB = 26;
  const iw = W - padL - padR; const ih = H - padT - padB;
  if (!hours.length) {
    return (
      <div className="lrn-hour-wrap">
        <div className="lrn-hour-title">今日分时（北京时）</div>
        <div className="lrn-note lrn-note-soft">{todayUsed === 0 ? '今日暂无用量记录' : '桥侧未返回分时明细（缺少 todayHourly 字段）'}</div>
      </div>
    );
  }
  const maxV = niceMax(Math.max(...hours.map((h) => h.real + h.est)));
  const slot = iw / hours.length;
  const bw = Math.max(3, Math.min(26, slot * 0.74));
  const lastH = hours[hours.length - 1]?.hour ?? 23;
  // 每小时均标出刻度（此前仅标 0/3/6…与末位，1、2 看似未显示）
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
      <div className="lrn-hour-foot">截至 {lastH}:00（当前北京小时），每格为 1 小时 · 柱顶数字为该小时合计 · 自自然日 00:00 起</div>
      {tip && (
        // 先以原始位置渲染一帧（visibility:hidden）以便量取尺寸，useLayoutEffect 量取后立即替换为夹取后的位置
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

/* ---------- 实时计量（实测）与费用预算（假设口径）：两套口径彼此独立，互不换算 ---------- */
/** 高峰时段（北京时）：09:00-12:00 与 14:00-18:00，单价乘以 peakMult */
const PEAK_HOURS = new Set([9, 10, 11, 14, 15, 16, 17]);
const COST_KEY = 'qbm-token-cost-v2';

interface CostCfg {
  hitRate: number;   // 预算使用的假设命中率（仅影响预算区，不参与实测）
  pHit: number;      // ¥/M tok，谷时
  pMiss: number;
  pOut: number;
  peakMult: number;
}
const COST_DEFAULT: CostCfg = { hitRate: 0.98, pHit: 0.02, pMiss: 1, pOut: 4, peakMult: 2 };

/** 2026-09：按要求「输入框长度改小一定且数字居中」
 *  「费用预算」：卡内的五个数字输入框（假设缓存命中率 / 缓存命中输入 / 未命中输入 / 输出 / 高峰倍数）：
 *  宽度收窄到刚够 4~5 位数字，数字居中显示。原样式来自 app.css 的 `.cost-custom input` /
 *  `.cost-price input`（宽 60px、右对齐），此处以行内样式覆盖（行内优先级高于类选择器），
 *  不改动任何 .css 文件，也不涉及字段名、单位与计算口径。 */
const COST_INPUT_STYLE: CSSProperties = { width: 48, minWidth: 48, padding: '4px 5px', textAlign: 'center' };

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
  } catch { /* 存储不可用则取默认值 */ }
  return { ...COST_DEFAULT };
}
/** 预算专用：由未命中输入与假设命中率推算命中 tok（hits = miss × r / (1 − r)） */
const assumedHit = (miss: number, r: number): number =>
  r >= 0.9995 ? miss * 2000 : (r <= 0 ? 0 : (miss * r) / (1 - r));
const hourMult = (h: number, m: number): number => (PEAK_HOURS.has(h) ? m : 1);

/** 同一份小时数据按两套口径分别计算：
 *  实测：仅统计确实带缓存命中字段的请求（cacheRead / cachePrompt / cacheCompletion），不反推、不外推；
 *  预算：以真实未命中与输出为基数、按假设命中率推算，单独成块。两者不共用任何数字。 */
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
  /* 2026-09-19 关于「token 虚高」预算区假设命中率默认 98%，与实测（约 89%）相差过大，
   * 会低估预算金额，并使「实测与假设」看似两套矛盾口径。首次打开时以实测值兜底；
   * 若已手动修改（localStorage 中存在记录）则不再覆盖。 */
  const autoRef = useRef(false);
  useEffect(() => {
    if (autoRef.current) return;
    autoRef.current = true;
    if (m.measuredRate === null) return;
    if (typeof localStorage !== 'undefined' && localStorage.getItem(COST_KEY)) return;   // 已手动调整，不再覆盖
    const r = Math.max(0.3, Math.min(0.999, m.measuredRate));
    setCfg((c) => (Math.abs(c.hitRate - r) < 0.005 ? c : { ...c, hitRate: Number(r.toFixed(3)) }));
  }, [m.measuredRate]);

  if (!hours.length || m.dayTotal === 0) {
    return (
      <div className="cost-wrap">
        <div className="cost-head"><Activity size={15} /> 实测计量</div>
        <div className="lrn-note lrn-note-soft">今日尚无用量记录；收到第一条 usage 帧后此处将实时累计。</div>
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
          <span className="cost-head-note">精确值 · 不作任何反推或估算 · 按北京自然日分时聚合</span>
        </div>

        <div className="cost-rate-row">
          <div className="cost-rate-num">
            <span className="cost-rate-v">{rate === null ? '—' : `${(rate * 100).toFixed(1)}%`}</span>
            <span className="cost-rate-l">
              {rate === null
                ? '当前缓存命中率 · 尚无带缓存命中字段的请求'
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
              <NumInput className="" style={COST_INPUT_STYLE} value={Number((cfg.hitRate * 100).toFixed(1))}
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
                <NumInput className="" style={COST_INPUT_STYLE} value={cfg.pHit} onCommit={(n) => patch({ pHit: Math.max(0, n) })} />
              </span>
              <span className="cost-price">
                <em>未命中输入</em>
                <NumInput className="" style={COST_INPUT_STYLE} value={cfg.pMiss} onCommit={(n) => patch({ pMiss: Math.max(0, n) })} />
              </span>
              <span className="cost-price">
                <em>输出</em>
                <NumInput className="" style={COST_INPUT_STYLE} value={cfg.pOut} onCommit={(n) => patch({ pOut: Math.max(0, n) })} />
              </span>
              <span className="cost-price">
                <em>高峰倍数</em>
                <NumInput className="" style={COST_INPUT_STYLE} value={cfg.peakMult} onCommit={(n) => patch({ peakMult: Math.max(1, n || 1) })} />
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

/** 画像学习栏展开后的资料：字段与上方人格学习栏取自同一份库数据，展示方式保持一致，
 *  但不含英文人设正文与「覆盖机器人人设」——人设仅可来自目标名单（既定边界）。
 *  抽为独立组件，避免两栏各写一份、后续新增字段时漏改一侧。 */
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
      {!busy && !err && !intro && !pf && !summaryText && <div className="lrn-dk">该对象在记忆库中尚无档案（仅存在上述画像状态）。</div>}
      <div className="lrn-wide" style={{ fontSize: 11.5, lineHeight: 1.6, color: 'var(--nc-foreground-400)' }}>
        本条属「画像学习」的群友画像，仅写入群友画像，不会转成机器人人设；如需其成为人设，须先将号码填入左侧「目标 QQ」，再执行人格学习。
      </div>
    </div>
  );
}

/* ---------- 群友画像学习：立即 / 间隔 / 每日定时（目标自动筛选，写回 profiles 表） ---------- */
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
  /* 2026-09-23cfg 由"出厂默认值"改为可空：初值取模块级缓存（上次读到的 learning-config.portrait），
   *  无缓存则为 null —— 此时下方字段一律空白且不可编辑，不再先摆一套看起来像真的默认值。
   *  注意：已读到配置时的取值口径未变（仍由 normPortraitCfg 补齐）。 */
  const [cfg, setCfg] = useState<PortraitCfg | null>(() => {
    const c = getCachedConfig<any>(CFG_LEARNING);
    return isObj(c) && isObj(c.portrait) ? normPortraitCfg(c.portrait) : null;
  });
  const cfgReady = cfg !== null;
  const [status, setStatus] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const loadAll = async () => {
    try {
      const r: any = await getLearningConfig();
      const conf = isObj(r?.config) ? r.config : isObj(r?.result?.config) ? r.result.config : r;
      setCfg(normPortraitCfg(conf?.portrait));
      /* 读到的整份学习配置入缓存（含本块用到的 portrait 段），供下次进入本页起底。 */
      rememberConfig(CFG_LEARNING, conf);
    } catch { /* 桥不可达：本次不写入任何值（cfg 保持原状或为 null），字段留空且不可编辑 */ }
    try {
      const s: any = await portraitAction('status');
      setStatus(isObj(s?.result) ? s.result : s);
    } catch { /* 忽略 */ }
  };
  useEffect(() => { loadAll(); }, []);

  const save = async () => {
    /* 配置尚未读到时禁止写盘：此时表单是空的，保存下去等于把空值当成配置写回。 */
    if (!cfg) { setMsg('画像学习配置尚未读取到，暂不可保存'); return; }
    setBusy('save'); setMsg('');
    try {
      const r: any = await saveLearningConfig({ portrait: {
        enabled: cfg.enabled, minMessages: cfg.minMessages, maxTargets: cfg.maxTargets,
        windowHours: cfg.windowHours, autoIntervalEnabled: cfg.autoIntervalEnabled,
        autoIntervalHours: cfg.autoIntervalHours, timeHHMM: normHHMM(cfg.timeHHMM),
      } } as any);   // 仅提交可编辑字段（lastRunAtMs 由画像模块自行维护）
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

  const patch = (p: Partial<PortraitCfg>) => setCfg((c) => (c ? { ...c, ...p } : c));
  const list: any[] = Array.isArray(status?.status) ? status.status : [];
  const lastTargets: string[] = Array.isArray(status?.lastTargets) ? status.lastTargets : [];
  const LEARNING = list.filter((x) => x?.state === 'learning').length;

  return (
    <div className="lrn-block" style={{ marginTop: 18, paddingTop: 14, borderTop: '1px dashed hsl(339.33 90% 90% / .9)' }}>
      <div className="lrn-block-title">群友画像学习（自动筛选活跃群成员，结果直接写入 profiles，画像页立即可见）</div>

      <div className="lrn-grid">
        <div className="switch-row" style={{ gridColumn: '1 / -1' }} title={cfgReady ? undefined : '配置尚未读取到，暂不可修改'}>
          <input type="checkbox" checked={cfg?.enabled === true} disabled={!cfgReady} onChange={(e) => patch({ enabled: e.target.checked })} />
          <div><span>启用画像学习</span><em>关闭后桥侧拒绝画像学习请求（含指令与自动触发）</em></div>
        </div>

        <div className="form-group">
          <label className="label">取样窗口（天）</label>
          <NumInput className="input" value={cfg ? Math.round(cfg.windowHours / 24) : undefined} disabled={!cfgReady} placeholder={cfgReady ? undefined : '尚未读取'}
            onCommit={(n) => patch({ windowHours: Math.max(1, Math.round(n) || 1) * 24 })} />
        </div>
        <div className="form-group">
          <label className="label">最少发言条数</label>
          <NumInput className="input" value={cfg?.minMessages} disabled={!cfgReady} placeholder={cfgReady ? undefined : '尚未读取'}
            onCommit={(n) => patch({ minMessages: Math.max(1, Math.round(n) || 1) })} />
        </div>
        <div className="form-group">
          <label className="label">单轮最多目标数</label>
          <NumInput className="input" value={cfg?.maxTargets} disabled={!cfgReady} placeholder={cfgReady ? undefined : '尚未读取'}
            onCommit={(n) => patch({ maxTargets: Math.max(1, Math.round(n) || 1) })} />
        </div>

        <div className="switch-row" style={{ gridColumn: '1 / -1' }} title={cfgReady ? undefined : '配置尚未读取到，暂不可修改'}>
          <input type="checkbox" checked={cfg?.autoIntervalEnabled === true} disabled={!cfgReady} onChange={(e) => patch({ autoIntervalEnabled: e.target.checked })} />
          <div><span>自动间隔学习</span><em>距上次成功学习达到下列间隔即自动执行一轮</em></div>
        </div>
        <div className="form-group">
          <label className="label">间隔（小时）</label>
          <NumInput className="input" value={cfg?.autoIntervalHours} disabled={!cfgReady} placeholder={cfgReady ? undefined : '尚未读取'}
            onCommit={(n) => patch({ autoIntervalHours: Math.max(1, Math.round(n) || 1) })} />
        </div>
        <div className="form-group">
          <label className="label">每日定时（北京时，留空表示不定时）</label>
          <input className="input" type="text" inputMode="numeric" placeholder={cfgReady ? '如 04:00' : '尚未读取'} value={cfg?.timeHHMM ?? ''} disabled={!cfgReady}
            onChange={(e) => patch({ timeHHMM: normHHMM(e.target.value) })} />
        </div>
      </div>

      <div className="lrn-actions">
        <button className="btn btn-primary btn-sm" disabled={busy !== null || !cfgReady}
          title={cfgReady ? undefined : '画像学习配置尚未读取到，暂不可保存'}
          onClick={save}>
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

      {/* 【2026-09-16】本块同样限高并在内部纵向滚动：画像学习目标增多时，状态区此前会把左卡持续撑高。
          标题与上方操作按钮（保存配置 / 画像立即学习 / 停止学习）置于滚动区外，始终可见。 */}
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
