import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import NoticeBar from '../components/NoticeBar';
import {
  ArrowLeft, Mic, Volume2, Play, Save, Trash2, Plus, Loader2, AlertTriangle,
  Zap, Upload, Wand2, FlaskConical, Clock3, Sparkles,
} from 'lucide-react';
import { api } from '../api';
import { CFG_VOICE, getCachedConfig, rememberConfig } from '../config-cache';
import NumInput from '../components/NumInput';
import Dropdown from '../components/Dropdown';

/**
 * MoonBot · 语音（MiMo-V2.5 TTS／音色设计／音色复刻／语音识别）
 *
 * 「为何单独设页」：语音使用独立的模型服务商与密钥（与聊天模型分属不同账号或端点的情况很常见），
 * 因此四类模型各自配置「请求地址 + API Key + 模型名」，互不影响。配置保存于桥侧
 * （state/voice-config.json），保存即生效，无需重启桥，且不进入公开仓库。
 *
 * 「安全」API Key 仅单向写入：界面读回的始终是掩码（前 3 位 + 后 4 位）；
 * 输入框留空表示不改动已保存的密钥。
 *
 * 「实测过的接口形态」（2026-09-15 服务器实测，与官方文档 api 一致）
 *   · 合成：POST {地址}/chat/completions，assistant 消息放待朗读文本、user 消息放风格／音色描述，
 *     音色置于 audio.voice；返回 choices[0].message.audio.data（base64 音频）。
 *   · 识别：messages 的 content 中放 input_audio（data URL，mp3/wav），返回 message.content（文本）。
 */

interface RoleCfg { baseUrl: string; model: string; apiKeyMasked: string; apiKeySet: boolean }
interface VoiceCfg {
  ok?: boolean;
  enabled?: boolean;
  defaultVoice?: string;
  style?: string;
  format?: string;
  maxChars?: number;
  dailyChars?: number;
  cacheEnabled?: boolean;
  maxCacheFiles?: number;
  asrLanguage?: string;
  asrAutoTranscribe?: boolean;
/** 主动发语音的节奏：概率（0~1）+ 同一会话冷却（毫秒）+ 全语音发送模式 */
  send?: { probability?: number; cooldownMs?: number; allVoice?: boolean };
  usage?: { day: string; chars: number; calls: number; cacheHits: number; asrCalls: number };
  roles?: { role: string; label: string; defaultModel: string }[];
  presets?: { tokenPlanCn: string; official: string };
  builtinVoices?: { id: string; label: string; lang: string; gender: string; note: string }[];
  models?: Record<string, RoleCfg>;
}
interface CustomVoice { id: string; name: string; kind: 'design' | 'clone'; description: string; sampleBytes: number; hasSample: boolean; createdAt: string }

interface Props { onBack: () => void }

const SAMPLE_TEXT = '你好呀，我是月亮，这是音色试听。';
/** 「全局风格指令（style）的默认值」——英文书写，描述"像真人一样说话"，供语音合成以 user 消息接收。
 *  「权威源在桥侧」：真正的出厂默认值在 `qq-bridge/src/core/voice.js` 的默认语音配置里
 *  （该文件不在本次改动范围内；此处与之同口径，改一处需同步另一处）。
 *  桥未保存过该项（style 为空）时，本页以此值呈现并写回，使「不填」等同于"采用默认风格"。
 *  写法要求：一段自然语言英文（非全大写 token 体例），涵盖自然口语、停顿与语气词、不疾不徐、
 *  情绪贴合内容，并明确排除播音腔、客服腔与机械朗读。 */
const DEFAULT_VOICE_STYLE = 'Talk the way a real person talks: natural, unhurried everyday speech with small pauses and the occasional filler, pitch and emphasis following what the line actually carries. Keep it warm and conversational, and avoid announcer or customer-service delivery, flat mechanical reading and over-clean articulation.';
const ROLE_ORDER = ['tts', 'design', 'clone', 'asr'] as const;
/** 2026-09-18四类模型的角色 id（tts / design / clone / asr）及其中文名称。
 *  桥返回的 roles[].label 通常可用；若旧版桥未提供 label，则由此表兜底，
 *  以免界面直接显示英文角色 id（tools/audit-ui-labels.mjs 会检查此表须覆盖 ROLE_ORDER 中的全部 id）。 */
const ROLE_LABEL: Record<string, string> = {
  tts: '语音合成', design: '音色设计', clone: '音色复刻', asr: '语音识别',
};
/** 角色 id → 界面显示名（优先取桥返回的 label，其次取本地兜底表，最后回落到原 id） */
const roleName = (role: string, label?: string) => label || ROLE_LABEL[role] || role;
const ROLE_HINT: Record<string, string> = {
  tts: '使用官方内置音色朗读（默认走此路径）',
  design: '以一段文字描述生成音色，无需样本',
  clone: '上传一段 mp3/wav 样本，复刻该样本的音色',
  asr: '将他人发来的语音转为文字（使机器人可识别语音内容）',
};

/** 2026-09-27 修复「点击预置未填入请求地址」预置接入点：一个预置 = 一家服务商的请求地址 + 四个模型名。
 *  地址来源（并非推断）：桥侧 `qq-bridge/src/core/voice.js:59-60` 的
 *  `DEFAULT_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1'`（国内 Token Plan，已验证可用，见该文件 :51 注释）
 *  与 `ALT_BASE_URL = 'https://api.xiaomimimo.com/v1'`（小米 MiMo 官方站）；
 *  同一对象在 `voiceConfigPublic()` 中以 `presets.tokenPlanCn / presets.official` 返回给管理端（voice.js:167）。
 *  模型名来源：`voice.js:52-57` 的 VOICE_ROLES[].defaultModel（两个地址同属小米，模型 id 相同）。
 *  「前端为何另存一份」：桥未运行时取不到 `cfg`（本页此时仍渲染表单，见下方 loadErr 分支），
 *  旧代码 `cfg?.presets?.tokenPlanCn ?? ''` 会把地址填为空串，表现为「点击预置后地址未被填入」。
 *  此处的本地常量仅作兜底：桥可正常返回时一律以桥为准（桥为权威源）。 */
const PRESETS: { key: 'tokenPlanCn' | 'official'; label: string; baseUrl: string; models: Record<string, string> }[] = [
  {
    key: 'tokenPlanCn', label: '小米 Token Plan（国内）',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    models: { tts: 'mimo-v2.5-tts', design: 'mimo-v2.5-tts-voicedesign', clone: 'mimo-v2.5-tts-voiceclone', asr: 'mimo-v2.5-asr' },
  },
  {
    key: 'official', label: '小米官方 API',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    models: { tts: 'mimo-v2.5-tts', design: 'mimo-v2.5-tts-voicedesign', clone: 'mimo-v2.5-tts-voiceclone', asr: 'mimo-v2.5-asr' },
  },
];

/** 桥控制台返回体兼容：管理端代理失败时会返回 { success:false, code, message }（无 ok 字段），
 *  因此判定成功一律使用 `ok === true`，不可仅判 `ok === false`，
 *  否则会把代理失败的结果当作成功数据渲染。
 *  2026-09-19 变更要求：文案不再于前端写死：「桥未运行」与「桥版本过旧」是两回事，
 *  服务端已按实际原因区分（code='bridge-offline' 表示对端无应答；code='bridge-stale' 表示桥有应答但无此路由），
 *  此处优先使用服务端返回的说明。前端另抄一份必然漂移：此前所抄的文案把「未启动」表述为
 *  「确认桥接进程已启动、远端连接与隧道正常」，仅因桥未运行的用户会误以为需要升级或排查隧道。 */
function pickErr(e: any): string {
  if (!e) return '未知错误';
  if (e.message || e.error) return String(e.message || e.error);
  if (e.code === 'bridge-offline') return '桥未运行，本页语音配置需在桥启动后方可读取（启动后本页会自动重读）';
  if (e.code === 'bridge-stale') return '桥正在运行，但其版本不含语音接口：请更新桥代码并重启桥，本页会自动重读';
  return String(e);
}

/** 自动重试说明（2026-09-30 原话：「不要我点击重试再刷新，而是自动刷新，也不要有点击重试这样的按钮」）。
 *  `ms > 0`：失败后的退避重读中（5 → 10 → 20 → 40 → 60 秒，封顶 60 秒）；`ms === 0`：已读到，停止重试。 */
const autoRetryNote = (ms: number): string =>
  ms > 0
    ? `正在自动重试：约每 ${Math.max(1, Math.round(ms / 1000))} 秒重读一次（失败后按 5／10／20／40／60 秒退避，最长 60 秒一次）。桥启动后本页会自行恢复，无需手动刷新。`
    : '';

/* ================= 表单取值（2026-09-23 重订口径） =================
 * 本页与「实例配置」同属配置页：有缓存即以缓存里的真实值渲染（缓存见 `src/config-cache.ts`），
 * 使本管理端会话内反复切换页面时数值不跳变；没有缓存（本次会话首次进入）时一律留空、
 * 开关不选中且不可编辑 —— 绝不以出厂默认值冒充，屏幕上不会出现与桥上配置不同的数值；
 * 「应用配置」：在真实配置读到之前一律禁用。 */

/** 表单取值。未读到的字段以 `undefined`/`null` 表示"未知"，渲染为空框或未选中且禁用。 */
interface VoiceForm {
  enabled: boolean | null;
  defaultVoice: string;
  style: string;
  format: string;
  maxChars?: number;
  dailyChars?: number;
  cacheEnabled: boolean | null;
  probPct?: number;
  coolMin?: number;
  allVoice: boolean | null;
  asrLanguage: string;
  models: Record<string, { baseUrl: string; model: string; apiKey: string }>;
}

/** 尚未读到任何配置时的表单取值：全空。 */
function emptyVoiceForm(): VoiceForm {
  const models: VoiceForm['models'] = {};
  for (const r of ROLE_ORDER) models[r] = { baseUrl: '', model: '', apiKey: '' };
  return {
    enabled: null, defaultVoice: '', style: '', format: '',
    maxChars: undefined, dailyChars: undefined,
    cacheEnabled: null, probPct: undefined, coolMin: undefined, allVoice: null,
    asrLanguage: '', models,
  };
}

/** 由一份桥配置导出表单取值（`applyCfg` 与"缓存预热"共用同一口径，避免两处写法漂移）。
 *  注意：此函数只处理"已读到配置"这一情形，其取值口径与本次改动之前完全一致
 *  （缺键时沿用桥侧既有默认），因此不会改变已读到配置时的任何显示。 */
function voiceFormOf(c: VoiceCfg): VoiceForm {
  const models: VoiceForm['models'] = {};
  for (const r of ROLE_ORDER) {
    const rc = c.models?.[r] ?? ({} as RoleCfg);
    // 密钥只写入不回显：此处始终留空（留空表示不改动已保存的密钥）
    models[r] = { baseUrl: String(rc.baseUrl ?? ''), model: String(rc.model ?? ''), apiKey: '' };
  }
  return {
    enabled: c.enabled === true,
    defaultVoice: String(c.defaultVoice ?? '冰糖'),
    // 全局风格指令：桥侧未设置（空串）时采用默认的英文拟人风格，见上方 DEFAULT_VOICE_STYLE
    style: String(c.style || DEFAULT_VOICE_STYLE),
    format: String(c.format ?? 'mp3'),
    maxChars: Number(c.maxChars) || 120,
    dailyChars: Number(c.dailyChars) || 0,
    cacheEnabled: c.cacheEnabled !== false,
    probPct: Math.round((Number(c.send?.probability ?? 0.2) || 0) * 100),
    coolMin: Math.round((Number(c.send?.cooldownMs ?? 600000) || 0) / 60000),
    // 全语音发送模式：缺失或非布尔值一律按 false 处理（旧配置无 send.allVoice 即普通模式），不报错
    allVoice: c.send?.allVoice === true,
    asrLanguage: String(c.asrLanguage ?? 'auto'),
    models,
  };
}

export default function VoiceConfig({ onBack }: Props) {
  /* 初值：缓存里的语音配置；没有缓存即为 null（下方字段留空、控件禁用），不使用任何出厂默认值。 */
  const [cfg, setCfg] = useState<VoiceCfg | null>(() => getCachedConfig<VoiceCfg>(CFG_VOICE));
  const [custom, setCustom] = useState<CustomVoice[]>([]);
  const [builtin, setBuiltin] = useState<VoiceCfg['builtinVoices']>([]);
  const [loadErr, setLoadErr] = useState('');
/** 读取失败后的自动重试间隔（毫秒，0 = 已读到）。仅用于提示条上如实说明"现在多久重读一次"。 */
  const [autoRetryMs, setAutoRetryMs] = useState(0);
/** 是否处于失败后的自动退避重读中（2026-09-30 起本页不再有「重试」按钮）。
   *  单独用一个布尔量驱动重读循环，而不是让循环去盯着错误文本 —— 见下方 load 的说明。 */
  const [retrying, setRetrying] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /* 配置读取状态：`cfgLoading` 与 `loadErr` 只用于一行行内提示以及各按钮的可用性，
     页面结构在回包之前即已可见，不出现「整页只有一行正在读取」的等待态。
     `touched` 记录本次读取期间表单是否已被改动：已改动则不让迟到的回包覆盖用户刚输入的内容。 */
  const [cfgLoading, setCfgLoading] = useState(true);
  const touched = useRef(false);
/** 配置是否已读到（缓存或回包）。为 false 时全部字段留空且不可编辑、保存禁用。 */
  const ready = cfg !== null;

  /* 各字段初值：缓存里有就用缓存值，没有就留空（见文件上方 VoiceForm 说明）。 */
  const [boot] = useState<VoiceForm>(() => {
    const c = getCachedConfig<VoiceCfg>(CFG_VOICE);
    return c ? voiceFormOf(c) : emptyVoiceForm();
  });
  const [enabled, setEnabled] = useState<boolean | null>(boot.enabled);
  const [defaultVoice, setDefaultVoice] = useState(boot.defaultVoice);
  const [style, setStyle] = useState(boot.style);
  const [format, setFormat] = useState(boot.format);
  const [maxChars, setMaxChars] = useState<number | undefined>(boot.maxChars);
  const [dailyChars, setDailyChars] = useState<number | undefined>(boot.dailyChars);
  const [cacheEnabled, setCacheEnabled] = useState<boolean | null>(boot.cacheEnabled);
  const [probPct, setProbPct] = useState<number | undefined>(boot.probPct);   // 主动发语音概率（百分数呈现，桥上按 0~1 存储）
  const [coolMin, setCoolMin] = useState<number | undefined>(boot.coolMin);   // 语音冷却时长（分钟）
/** 「全语音发送模式」send.allVoice：开启后机器人的回复一律以语音发出（是否实际发送由桥侧决定，本页仅读写配置）。 */
  const [allVoice, setAllVoice] = useState<boolean | null>(boot.allVoice);
  const [asrLanguage, setAsrLanguage] = useState(boot.asrLanguage);
  const [models, setModels] = useState<Record<string, { baseUrl: string; model: string; apiKey: string }>>(boot.models);

  // 试听
  // 2026-09-15 修按钮状态机：试听每个按钮各自持有忙碌状态（pvBusy[来源]=true）：
  // 原实现令所有试听按钮共用一个 busy 字符串并采用 disabled={busy!==null}，点击一个即全场置灰，观感如同全部在试听。
  // pvSeq 每次试听递增，用作 <audio> 的 key：命中缓存时 URL 完全相同，不更换 key 浏览器即不会重新
  // 加载与播放，表现为「点击后无反应」（本次一并修复）。
  const [preview, setPreview] = useState<{ url: string; label: string } | null>(null);
  const [pvBusy, setPvBusy] = useState<Record<string, boolean>>({});
  const [pvSeq, setPvSeq] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // 新建音色
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [sample, setSample] = useState<{ name: string; base64: string; bytes: number } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

/** 把一份配置写入表单。 */
/**  · `overwrite = true`（保存回包、清空密钥回包）：整份覆盖，以桥上返回的值为准； */
/**  · `overwrite = false`（首次读取的回包）：只登记配置本体（供预置地址、角色说明与用量读数使用）， */
/**    不覆盖表单字段 —— 用户若在回包到达之前已经动过表单，其输入必须保留。 */
  const applyCfg = useCallback((c: VoiceCfg, overwrite = true) => {
    setCfg(c);
    setBuiltin(c.builtinVoices ?? []);
    if (!overwrite) return;
    const f = voiceFormOf(c);
    setEnabled(f.enabled);
    setDefaultVoice(f.defaultVoice);
    setStyle(f.style);
    setFormat(f.format);
    setMaxChars(f.maxChars);
    setDailyChars(f.dailyChars);
    setCacheEnabled(f.cacheEnabled);
    setProbPct(f.probPct);
    setCoolMin(f.coolMin);
    // 全语音发送模式：缺失或非布尔值一律按 false 处理（旧配置无 send.allVoice 即普通模式），不报错
    setAllVoice(f.allVoice);
    setAsrLanguage(f.asrLanguage);
    setModels(f.models);
  }, []);

/** 读取语音配置。返回是否成功 —— 供下面的自动退避重试用（2026-09-30 起失败不再给「重试」按钮）。 */
/**  注意：本函数不在开头清 loadErr（原文是 `setLoadErr('')`）。若每轮开头都清， */
/**  提示条会一闪一闪，且退避循环若以 loadErr 为依赖，会每轮被重置回 5 秒； */
/**  失败原因留到下一次成功为止更稳。重读循环改由 `retrying` 布尔量驱动。 */
  const load = useCallback(async (): Promise<boolean> => {
    setCfgLoading(true);
    try {
      const [c, v] = await Promise.all([
        // 2026-09-19目标侧的选择不再由前端承担：管理端后端统一按「连上服务器则走服务器，否则走本机」路由
        // （server/index.js 的 resolveBridgeTarget），前端仅采用其结果，用户无需先理解本页作用于哪一侧。
        api<VoiceCfg>('/voice/config'),
        api<{ ok?: boolean; builtin?: any[]; custom?: CustomVoice[] }>('/voice/voices'),
      ]);
      if (!c || (c as any).ok !== true) { setLoadErr(pickErr(c)); setRetrying(true); return false; }
      if (((v as any)?.ok) !== true) { setLoadErr(pickErr(v)); setRetrying(true); return false; }
      /* 成功读到即写入模块级缓存：下次进入本页先按这份真实值渲染，切换页面时不闪默认值。 */
      rememberConfig(CFG_VOICE, c);
      // 表单若已被改动，则只登记配置本体，不用回包覆盖输入（见 applyCfg 的 overwrite 参数）
      applyCfg(c, !touched.current);
      setBuiltin(c.builtinVoices ?? v.builtin ?? []);
      setCustom(Array.isArray(v.custom) ? v.custom : []);
      setLoadErr('');
      setRetrying(false);
      return true;
    } catch (e: any) {
      setLoadErr(pickErr(e));
      setRetrying(true);
      return false;
    } finally { setCfgLoading(false); }
  }, [applyCfg]);

  useEffect(() => { void load(); }, [load]);

  /* 2026-09-30 修改要求：读取失败不再要人"点重试再刷新"，改为自动重试，页面上不出现重试按钮：
     失败后按 5 → 10 → 20 → 40 → 60 秒（封顶 60 秒）逐档拉长重读，读到即停（retrying 置回 false → 本 effect 退出）。
     失败事实照常显示在提示条上（原因来自 pickErr），页面不会变成"永远转圈"。
     循环由 `retrying` 布尔量驱动（load 不会在开头清它），故失败原因文本无论如何变化，
     退避档位都不会被重置回 5 秒。 */
  useEffect(() => {
    if (!retrying) { setAutoRetryMs(0); return; }
    let alive = true;
    let backoff = 5000;
    let t: number | null = null;
    const step = () => {
      setAutoRetryMs(backoff);
      t = window.setTimeout(() => {
        if (!alive) return;
        backoff = Math.min(60000, backoff * 2);
        void load().finally(() => { if (alive) step(); });
      }, backoff);
    };
    step();
    return () => { alive = false; if (t !== null) window.clearTimeout(t); };
  }, [retrying, load]);

/** 点击预置：将该项预置声明的字段直接写入表单（受控 state，修改后立即显示于输入框）。 */
/**  · 请求地址：必定覆盖 —— 切换预置本就是为了更换端点；地址优先取桥返回的 presets（权威来源）， */
/**    桥未运行或旧版桥未返回时使用 PRESETS 中的本地常量，绝不写入空串。 */
/**  · 模型名：仅补空白输入框（用户手工修改过的模型名不被覆盖；两个预置同属小米，模型 id 相同）。 */
/**  · 密钥、格式、试听等其余字段一律不改动。 */
  const applyPreset = (p: typeof PRESETS[number]) => {
    const fromBridge = cfg?.presets?.[p.key];
    const baseUrl = (typeof fromBridge === 'string' && fromBridge.trim()) ? fromBridge.trim() : p.baseUrl;
    setModels((prev) => {
      const next: Record<string, { baseUrl: string; model: string; apiKey: string }> = { ...prev };
      for (const r of ROLE_ORDER) {
        const cur = next[r] ?? { baseUrl: '', model: '', apiKey: '' };
        next[r] = { ...cur, baseUrl, model: cur.model.trim() ? cur.model : (p.models[r] ?? '') };
      }
      return next;
    });
    setMsg(`已按「${p.label}」填入请求地址：${baseUrl}（模型名仅补空白输入框，已填写者不变）`);
  };

  const save = async () => {
    setBusy('save');
    try {
      const patch: any = {
        enabled, defaultVoice, style: style.trim(), format,
        maxChars: Number(maxChars) || 120, dailyChars: Number(dailyChars) || 0,
        cacheEnabled, asrLanguage,
        // 主动发语音的节奏：界面以百分数与分钟表示，桥侧存 0~1 的概率与毫秒冷却；allVoice 为全语音发送模式
        send: {
          probability: Math.max(0, Math.min(100, Number(probPct) || 0)) / 100,
          cooldownMs: Math.max(0, Number(coolMin) || 0) * 60000,
          allVoice,
        },
        models: Object.fromEntries(ROLE_ORDER.map((r) => [r, {
          baseUrl: models[r]?.baseUrl ?? '', model: models[r]?.model ?? '',
          // 仅上传用户实际输入的密钥，留空表示保留原密钥
          ...(models[r]?.apiKey ? { apiKey: models[r].apiKey } : {}),
        }])),
      };
      const r = await api<VoiceCfg>('/voice/config', { method: 'PUT', body: JSON.stringify(patch) });
      if ((r as any)?.ok !== true) { setMsg(`保存失败：${pickErr(r)}`); return; }
      /* 保存成功即更新缓存：切走再回来看到的是刚保存的这份配置。 */
      rememberConfig(CFG_VOICE, r);
      // 「兼容旧桥」：回包若未带 send.allVoice（旧版桥不认识该字段，只返回其认识的字段），
      // 则按刚提交的值显示，避免开关自行弹回关闭状态；若带回 allVoice 则一律以桥返回值为准。
      const echoed = r?.send;
      applyCfg((typeof echoed?.allVoice === 'boolean' ? r : { ...r, send: { ...(echoed ?? {}), allVoice } }) as VoiceCfg);
      setMsg('语音配置已保存（桥侧立即生效，无需重启）');
    } catch (e: any) {
      setMsg(`保存失败：${pickErr(e)}`);
    } finally { setBusy(null); }
  };

  const runTest = async (role: string) => {
    setBusy(`test-${role}`);
    try {
      const r = await api<any>('/voice/test', { method: 'POST', body: JSON.stringify({ role }) });
      setMsg(r?.ok !== true ? `测试失败：${pickErr(r)}` : `测试通过：${r.detail ?? 'ok'}`);
    } catch (e: any) { setMsg(`测试失败：${pickErr(e)}`); }
    finally { setBusy(null); }
  };

/** 试听：仅被点击的那一个按钮进入忙碌态（pvBusy[自己的 key]），其余按钮照常可点击； */
/**  命中缓存时同样从头重播（更换 <audio> 的 key 并显式调用 play）。 */
  const doPreview = async (label: string, body: any, key = 'default') => {
    if (pvBusy[key]) return;                       // 同一按钮防重复点击，其他按钮不受影响
    setPvBusy((m) => ({ ...m, [key]: true }));
    try {
      const r = await api<any>('/voice/preview', { method: 'POST', body: JSON.stringify(body) });
      if (r?.ok !== true) { setMsg(`试听失败：${pickErr(r)}`); return; }
      setPreview({ url: `data:${r.mime || 'audio/mpeg'};base64,${r.audioBase64}`, label });
      setPvSeq((n) => n + 1);                      // 更换 key，使与上次完全相同的音频也重新播放
      setMsg(r.cached ? `试听：${label}（命中缓存，未重复请求）` : `试听：${label}（${r.bytes} 字节，${r.ms}ms）`);
    } catch (e: any) { setMsg(`试听失败：${pickErr(e)}`); }
    finally { setPvBusy((m) => { const n = { ...m }; delete n[key]; return n; }); }
  };

  // 每次试听均显式 load + play：浏览器对 data URL 的重复播放常表现为无反应，显式播放最为可靠；
  // 被自动播放策略拦截时保留原生 controls，用户仍可手动播放。
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !preview) return;
    try { el.load(); void el.play().catch(() => { /* 被拦截时交由 controls 处理 */ }); } catch { /* 忽略 */ }
  }, [pvSeq, preview]);

  const onPickFile = (f: File | null) => {
    if (!f) return;
    if (f.size > 7 * 1024 * 1024) { setMsg('样本过大（超过 7MB），请改用更短的 mp3/wav'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result || '');
      setSample({ name: f.name, base64: data.replace(/^data:[^,]+,/, ''), bytes: f.size });
    };
    reader.readAsDataURL(f);
  };

  const saveVoice = async (kind: 'design' | 'clone') => {
    setBusy('save-voice');
    try {
      const r = await api<any>('/voice/voices', {
        method: 'POST',
        body: JSON.stringify({
          name: newName.trim(), kind,
          description: kind === 'design' ? newDesc.trim() : '',
          sampleBase64: kind === 'clone' ? (sample?.base64 ?? '') : '',
        }),
      });
      if (r?.ok !== true) { setMsg(`保存音色失败：${pickErr(r)}`); return; }
      setMsg(`音色「${newName.trim()}」已存入音色库，可在「默认音色」中选用`);
      setNewName(''); setNewDesc(''); setSample(null);
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (e: any) { setMsg(`保存音色失败：${pickErr(e)}`); }
    finally { setBusy(null); }
  };

  const removeVoice = async (v: CustomVoice) => {
    setBusy(`del-${v.id}`);
    try {
      const r = await api<any>(`/voice/voices?id=${encodeURIComponent(v.id)}`, { method: 'DELETE' });
      if (r?.ok !== true) { setMsg(`删除失败：${pickErr(r)}`); return; }
      setMsg(`已删除音色「${v.name}」`);
      await load();
    } catch (e: any) { setMsg(`删除失败：${pickErr(e)}`); }
    finally { setBusy(null); }
  };

  const usage = cfg?.usage;
/** 2026-09-19配置未读取到时仍渲染页面骨架（桥未运行时取不到真实值，但页面不应退化为一块错误提示）：
   *  cfg 为空时以空壳承接，以下只读取值均通过可选访问进行；各输入控件的值另由表单 state 提供，
   *  未读到时为空白且不可编辑（见文件上方 VoiceForm 说明）。 */
  const view: VoiceCfg = cfg ?? {};
  const voiceOptions = useMemo(() => {
    const opts = (builtin ?? []).map((b) => ({ id: b.id, label: `${b.label}（内置·${b.lang}${b.gender !== '—' ? '·' + b.gender : ''}）` }));
    for (const v of custom) opts.push({ id: v.id, label: `${v.name}（自建·${v.kind === 'clone' ? '样本复刻' : '文字设计'}）` });
    return opts;
  }, [builtin, custom]);

  return (
    <div className="page cute-ui">
      <div className="page-header">
        <div className="page-header-left">
          <button className="btn btn-sm" onClick={onBack}><ArrowLeft size={15} /> 返回</button>
          <div className="page-title-wrap">
            <div className="page-title" style={{ color: 'var(--nc-primary-500)' }}>MoonBot · 语音</div>
            <div className="page-subtitle">机器人可发声（合成语音并发送至群聊），亦可听取（将他人语音转为文字）</div>
          </div>
        </div>
        <div className="page-actions">
          <span className="connection-bar" title="语音配置与试听经管理端代理至当前活动实例的桥控制台">
            <Zap size={13} /> 目标：当前活动实例
          </span>
        </div>
      </div>

      {/* 表单任何一处控件（含复选框、下拉、文本与文件输入）被改动时登记一次：
          首次读取的回包若在此之后到达，则不再覆盖用户已输入的内容（见 applyCfg 的 overwrite 参数）。
          用捕获阶段的 change 事件统一登记，无需为每个控件各写一遍。 */}
      <div className="page-body" onChangeCapture={() => { touched.current = true; }}>
        <NoticeBar msg={msg} onClose={() => setMsg(null)} />

        {loadErr && (
          /* 2026-09-19 变更要求：此前此处为 `loadErr ? <错误卡> : <整页表单>`，桥一停整页配置即消失。
             现改为错误仅作错误呈现（提示条，不含重试按钮），配置照常显示、照常可改；真正依赖桥运行时的
             部分（保存／测试／试听／音色库）在下方以一句说明标出，而非删除整页。
             2026-09-30 修改要求：原先这里那个「重试」按钮已移除：本页会按退避间隔自动重读。 */
          <div className="card">
            <div className="lrn-error">
              <AlertTriangle size={15} />
              <div style={{ flex: 1 }}>
                {loadErr}
                <div className="lrn-error-detail">
                  {ready
                    ? '下方为上次读取到的配置，可继续修改；但保存、测试、试听与音色库均须经由桥完成，桥启动前点击这些操作会报同样的错误。'
                    : <>尚未读取到桥上的配置：下方字段保持<b>空白且不可编辑</b>，「应用配置」暂不可用 —— 不会以任何默认值冒充桥上配置。保存、测试、试听与音色库均须经由桥完成，桥启动前不可用。</>}
                </div>
                <div className="lrn-error-detail">{autoRetryNote(autoRetryMs)}</div>
              </div>
            </div>
          </div>
        )}

        {/* 读取状态只占一行行内提示，页面结构照常可见：读到之前各字段为空白且不可编辑。
            {/* 2026-09-30：缓存命中时（`ready`）不再显示这一行 —— 下方字段本就是上次读到的真实值，
            再挂一句「正在读取…」等于每次进页面都闪一下中间态（此前反馈的正是这个）；回包到达后原地替换即可。 */}
        {!ready && cfgLoading && !loadErr && (
          <div className="card">
            <div className="lrn-inline-note">
              <Loader2 size={13} className="spin" /> 正在读取语音配置：读到之前下方字段为空白且不可编辑，以免呈现与桥上不一致的数值。
            </div>
          </div>
        )}

        {/* 目标侧不在此处暴露：管理端后端按「连上服务器则走服务器，否则走本机」自动路由
            （2026-09-19 按要求移除「当前编辑目标」那段提示）。仅当两侧均无法连接时才由后端给出错误。 */}

            {/* ───────── 总开关与发送设置 ───────── */}
            <div className="card">
              <div className="card-title"><Mic size={17} /> 语音功能</div>
              <div className="cfg-fields">
                <label className="switch-row" title={ready ? undefined : '配置尚未读取到，暂不可修改'}>
                  <input type="checkbox" checked={enabled === true} disabled={!ready} onChange={(e) => setEnabled(e.target.checked)} />
                  <span>启用语音（总开关）</span>
                  <em>关闭后模型调用语音工具将被拒绝，机器人仅发送文字</em>
                </label>
                <label className="field-row">
                  <span className="f-label">默认音色</span>
                  <Dropdown className="input" value={defaultVoice} disabled={!ready} onChange={setDefaultVoice}
                    options={ready
                      ? voiceOptions.map((o) => ({ value: o.id, label: o.label }))
                      : [{ value: '', label: '（配置尚未读取）' }]} />
                </label>
                <label className="field-row">
                  <span className="f-label">全局风格指令</span>
                  <input className="input" type="text" placeholder={ready ? '可选，例如：语气温和，语速稍快，带一点笑意' : '尚未读取'}
                    value={style} disabled={!ready} onChange={(e) => setStyle(e.target.value)} />
                </label>
                <label className="field-row">
                  <span className="f-label">单条语音最长字数</span>
                  {/* 【2026-09-19】此处原为原生 number 输入配合 `Number(v) || 120`：
                      数字被删空时 `Number('') === 0`，随即被 ||120 顶回 120，输入框内容始终无法清空。
                      现统一改用 NumInput（全站数字输入框的既有标准件）：输入期间允许为空，失焦时不写入 0。 */}
                  <NumInput value={maxChars} disabled={!ready} placeholder="尚未读取" onCommit={(n) => setMaxChars(n)} ariaLabel="单条语音最长字数" />
                  <em>超过此长度将被拒绝，以免发出长达数十秒的语音</em>
                </label>
                <label className="field-row">
                  <span className="f-label">每日合成字数上限</span>
                  <NumInput value={dailyChars} disabled={!ready} placeholder="尚未读取" onCommit={(n) => setDailyChars(n)} ariaLabel="每日合成字数上限" />
                  <em>0 表示不限；命中缓存的重复文本不计入</em>
                </label>
                <label className="field-row">
                  <span className="f-label">音频格式</span>
                  <Dropdown className="input" value={format} disabled={!ready} onChange={setFormat}
                    options={ready
                      ? [
                        { value: 'mp3', label: 'mp3（推荐，文件体积较小）' },
                        { value: 'wav', label: 'wav（无损，文件体积较大）' },
                      ]
                      : [{ value: '', label: '（配置尚未读取）' }]} />
                </label>
                <label className="field-row">
                  <span className="f-label">识别语言</span>
                  <Dropdown className="input" value={asrLanguage} disabled={!ready} onChange={setAsrLanguage}
                    options={ready
                      ? [
                        { value: 'auto', label: '自动判定' },
                        { value: 'zh', label: '中文' },
                        { value: 'en', label: '英文' },
                      ]
                      : [{ value: '', label: '（配置尚未读取）' }]} />
                </label>
                <label className="switch-row" title={ready ? undefined : '配置尚未读取到，暂不可修改'}>
                  <input type="checkbox" checked={cacheEnabled === true} disabled={!ready} onChange={(e) => setCacheEnabled(e.target.checked)} />
                  <span>相同内容复用缓存</span>
                  <em>同一句话配合同一音色仅合成一次，以节省时间与费用</em>
                </label>
                <label className="field-row">
                  <span className="f-label">主动发语音概率</span>
                  <NumInput value={probPct} disabled={!ready} placeholder="尚未读取" onCommit={(n) => setProbPct(Math.max(0, Math.min(100, Math.round(n))))} ariaLabel="主动发语音概率" />
                  <em>取值范围 0~100（%）。每次唤醒桥时掷一次判定，并将结果写入提示词，告知模型本轮是否可以掺入一条语音；0 表示不主动发送，仅在明确要求时发送</em>
                </label>
                <label className="field-row">
                  <span className="f-label">语音冷却（分钟）</span>
                  <NumInput value={coolMin} disabled={!ready} placeholder="尚未读取" onCommit={(n) => setCoolMin(Math.max(0, Math.round(n)))} ariaLabel="语音冷却分钟" />
                  <em>同一会话刚发送过语音后，该时长内不再被抽中（防止连续发送刷屏）</em>
                </label>
                {/* 全语音发送模式（send.allVoice）：本页仅读写配置并提示，真正的「一律发语音」由桥侧实现 */}
                <label className="switch-row" title={ready ? undefined : '配置尚未读取到，暂不可修改'}>
                  <input type="checkbox" checked={allVoice === true} disabled={!ready} onChange={(e) => setAllVoice(e.target.checked)} />
                  <span>全语音发送模式</span>
                  <em>开启后机器人的回复<b>一律以语音发出</b>（不再发送文字）；关闭即回到上方的「概率 + 冷却」规则。修改后须点击「应用配置」</em>
                </label>
                {allVoice === true && (
                  <div className="lrn-inline-note" style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'flex-start', lineHeight: 1.7 }}>
                    <Volume2 size={13} style={{ flex: 'none', marginTop: 2 }} />
                    <span>
                      全语音模式会<b>显著增加语音合成消耗</b>（每日合成字数存在上限，见上方「每日合成字数上限」）；
                      某句合成失败时将<b>自动退回文字</b>发出，不会丢失该条回复。
                    </span>
                  </div>
                )}
              </div>
              <div className="lrn-inline-note">
                <Clock3 size={13} />
                {usage
                  ? <>今日（{usage.day}）已合成 {usage.chars} 字，共 {usage.calls} 次，缓存命中 {usage.cacheHits} 次；语音识别 {usage.asrCalls} 次</>
                  /* 用量为桥侧的实时计数：桥未运行时不应持续显示「读取中…」，须说明该计数缺失的原因 */
                  : loadErr ? '今日用量无法读取（该计数需桥处于运行状态）' : '正在读取今日用量…'}
              </div>
              <div className="lrn-actions">
                {/* 「应用配置」在配置尚未读取到（读取中或读取失败）时禁用：此时表单为空值，
                    直接保存会把空值写回桥上，覆盖桥上已保存的真实配置。 */}
                <button className="btn btn-primary btn-sm" disabled={busy !== null || !ready}
                  title={!ready ? '语音配置尚未读取到，暂不可保存；本页会自动重读，读到后即可保存' : '写入桥侧语音配置，保存即生效'}
                  onClick={() => void save()}>
                  {busy === 'save' ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 应用配置
                </button>
                <button className="btn btn-soft-primary btn-sm" disabled={busy !== null} onClick={() => void runTest('tts')}>
                  {busy === 'test-tts' ? <Loader2 size={14} className="spin" /> : <FlaskConical size={14} />} 测试合成
                </button>
                <button className="btn btn-soft-primary btn-sm" disabled={busy !== null} onClick={() => void runTest('asr')}>
                  {busy === 'test-asr' ? <Loader2 size={14} className="spin" /> : <FlaskConical size={14} />} 测试识别
                </button>
              </div>
            </div>

            {/* ───────── 四个模型各自的地址与密钥 ───────── */}
            <div className="card">
              <div className="card-title">
                <Sparkles size={17} /> 模型接入（各模型分别配置地址与密钥）
                <span className="lrn-updated">密钥只写入不回显，留空即不改动</span>
              </div>
              <div className="card" style={{ boxShadow: 'none', marginBottom: 10 }}>
                <div className="lrn-inline-note">
                  预置地址：
                  {PRESETS.map((p) => (
                    <button key={p.key} className="btn btn-sm" style={{ marginLeft: 6 }}
                      disabled={!ready}
                      title={ready ? `填入 ${p.baseUrl}` : '配置尚未读取到，暂不可填入预置地址'}
                      onClick={() => applyPreset(p)}>{p.label}</button>
                  ))}
                  {/* 2026-09-24 变更要求：这段说明重写：原文把三件事塞进两句长句（兼容形态/计费/
                      预置会写什么/地址来源），读起来要来回找主语。现在按"是什么 → 点了会怎样 →
                      钱怎么算 → 填不上时怎么办"四句说清；并加 `.cute-note` 让整段（含 code）
                      都用可爱圆体（否则 code 会被全站的等宽规则压成 JetBrains Mono）。 */}
                  <div className="cute-note" style={{ marginTop: 6, color: 'var(--nc-foreground-400)' }}>
                    两处都是小米的 OpenAI 兼容入口，请求发往 <code>{'{地址}'}/chat/completions</code>：
                    <b>小米 Token Plan（国内）</b>、<b>小米官方 API</b>。
                    点一下预置，就把那一家的<b>请求地址</b>填进下面四个角色 —— 只补空着的模型名，密钥一个字都不动。
                    语音模型现在还在免费试用期，识别按实际用量计费。
                    地址以桥里的 presets 为准；桥没起来时用界面内置的常量顶上，不会填成空格子。
                  </div>
                </div>
              </div>
              {ROLE_ORDER.map((role) => {
                const rc = models[role] ?? { baseUrl: '', model: '', apiKey: '' };
                const meta = (view.roles ?? []).find((x) => x.role === role);
                const saved = view.models?.[role];
                // 音色设计与音色复刻同语音合成属同一家服务、同一把密钥（经确认请求地址相同），
                // 因此这两栏留空即自动跟随「语音合成」，无需重复填写。
                const followsTts = role !== 'tts';
                return (
                  <div key={role} className="lrn-block" style={{ marginBottom: 12 }}>
                    <div className="lrn-block-title">{roleName(role, meta?.label)}　<span style={{ fontWeight: 400, color: 'var(--nc-foreground-400)' }}>{ROLE_HINT[role]}</span></div>
                    <div className="cfg-fields">
                      <label className="field-row">
                        <span className="f-label">请求地址</span>
                        <input className="input" type="text"
                          placeholder={!ready ? '尚未读取' : (followsTts ? '留空即跟随「语音合成」的地址（属同一家服务）' : (view.presets?.tokenPlanCn || PRESETS[0].baseUrl))}
                          value={rc.baseUrl} disabled={!ready}
                          onChange={(e) => setModels({ ...models, [role]: { ...rc, baseUrl: e.target.value } })} />
                      </label>
                      <label className="field-row">
                        <span className="f-label">语音模型密钥</span>
                        <input className="input" type="password" autoComplete="new-password"
                          placeholder={!ready
                            ? '尚未读取'
                            : (saved?.apiKeySet
                              ? `已设置：${saved.apiKeyMasked}（留空表示不改动）`
                              : (followsTts ? '留空即使用「语音合成」的密钥（两者相同即可）' : '尚未设置，粘贴密钥即可'))}
                          value={rc.apiKey} disabled={!ready}
                          onChange={(e) => setModels({ ...models, [role]: { ...rc, apiKey: e.target.value } })} />
                      </label>
                      <label className="field-row">
                        <span className="f-label">模型名</span>
                        <input className="input" type="text" placeholder={ready ? (meta?.defaultModel ?? '') : '尚未读取'} value={rc.model} disabled={!ready}
                          onChange={(e) => setModels({ ...models, [role]: { ...rc, model: e.target.value } })} />
                      </label>
                    </div>
                    {ready && followsTts && !saved?.apiKeySet && (
                      <div className="lrn-inline-note" style={{ marginTop: -2 }}>
                        此栏可以留空：请求地址与密钥均跟随「语音合成」（二者本属同一服务）。模型名须保持接口所给的 id。
                      </div>
                    )}
                    <div className="lrn-actions">
                      <button className="btn btn-sm" disabled={busy !== null} onClick={() => void runTest(role)}>
                        {busy === `test-${role}` ? <Loader2 size={13} className="spin" /> : <FlaskConical size={13} />} 测试该模型
                      </button>
                      {saved?.apiKeySet && (
                        <button className="btn btn-outline-danger btn-sm" disabled={busy !== null} title="清除已保存的密钥"
                          onClick={async () => {
                            setBusy(`clear-${role}`);
                            try {
                              const r = await api<any>('/voice/config', { method: 'PUT', body: JSON.stringify({ enabled, clearKeys: [role] }) });
                              if (r?.ok !== true) { setMsg(`清空失败：${pickErr(r)}`); return; }
                              rememberConfig(CFG_VOICE, r);
                              applyCfg(r); setMsg(`已清空「${roleName(role, meta?.label)}」的密钥`);
                            } catch (e: any) { setMsg(`清空失败：${pickErr(e)}`); }
                            finally { setBusy(null); }
                          }}>
                          <Trash2 size={13} /> 清空密钥
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ───────── 音色库 ───────── */}
            <div className="card">
              <div className="card-title">
                <Volume2 size={17} /> 音色库
                <span className="lrn-updated">内置音色可直接试听；自建音色由文字描述生成或上传样本复刻</span>
              </div>

              {preview && (
                <div className="lrn-inline-note" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <b>试听：{preview.label}</b>
                  <audio key={pvSeq} ref={audioRef} controls src={preview.url} style={{ height: 32 }} />
                  <button className="btn btn-sm" onClick={() => setPreview(null)}>收起播放器</button>
                </div>
              )}

              <div className="lrn-block">
                {/* 配置（含内置音色清单）尚未读到时，不能把「0 个」当成事实显示。 */}
                <div className="lrn-block-title">{ready ? `内置音色（${builtin?.length ?? 0} 个）` : '内置音色'}</div>
                {!ready && <div className="lrn-inline-note">正在读取音色库；读到之前这里不显示任何音色条目。</div>}
                <div className="lrn-status-list">
                  {(builtin ?? []).map((v) => (
                    <div className="lrn-status-row" key={v.id} style={{ cursor: 'default' }}>
                      <div className="lrn-status-main">
                        <div className="lrn-status-uid">
                          <b>{v.label}</b>
                          <span className="lrn-nick">{v.lang}{v.gender !== '—' ? ` · ${v.gender}` : ''}</span>
                          {defaultVoice === v.id && <span className="badge badge-success">当前默认</span>}
                          <span className="lrn-status-caret">{v.id}</span>
                        </div>
                        {v.note && <div className="lrn-status-preview" style={{ opacity: .75 }}>{v.note}</div>}
                        <div className="lrn-actions">
                          <button className="btn btn-primary btn-sm" disabled={!!pvBusy[`builtin:${v.id}`]}
                            onClick={() => void doPreview(v.label, { mode: 'tts', voice: v.id, text: SAMPLE_TEXT }, `builtin:${v.id}`)}>
                            {pvBusy[`builtin:${v.id}`] ? <Loader2 size={13} className="spin" /> : <Play size={13} />} 试听
                          </button>
                          <button className="btn btn-sm" onClick={() => setDefaultVoice(v.id)}>设为默认音色</button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="lrn-divider" />

              <div className="lrn-block">
                <div className="lrn-block-title"><Wand2 size={14} /> 新建音色（两种方式，选填其一）</div>
                <div className="cfg-fields">
                  <label className="field-row">
                    <span className="f-label">音色名字</span>
                    <input className="input" type="text" placeholder="例如：清亮少女音" value={newName} onChange={(e) => setNewName(e.target.value)} />
                  </label>
                  <label className="field-row">
                    <span className="f-label">① 文字描述（生成音色）</span>
                    <input className="input" type="text" placeholder="例如：十六七岁少女音，清亮柔和，语速稍快，带一点笑意"
                      value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
                  </label>
                  <div className="field-row">
                    <span className="f-label">② 音频样本（复刻音色）</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <input ref={fileRef} type="file" accept="audio/mpeg,audio/wav,.mp3,.wav" style={{ display: 'none' }}
                        onChange={(e) => onPickFile(e.target.files?.[0] ?? null)} />
                      <button className="btn btn-sm" onClick={() => fileRef.current?.click()}><Upload size={13} /> 选择 mp3 / wav 文件</button>
                      {sample && <span className="lrn-dk">{sample.name}（{(sample.bytes / 1024).toFixed(0)}KB）</span>}
                    </div>
                  </div>
                </div>
                <div className="lrn-actions">
                  <button className="btn btn-primary btn-sm" disabled={!!pvBusy['new-design'] || !newDesc.trim()}
                    onClick={() => void doPreview('文字描述音色（未保存）', { mode: 'design', text: SAMPLE_TEXT, description: newDesc.trim() }, 'new-design')}>
                    {pvBusy['new-design'] ? <Loader2 size={14} className="spin" /> : <Play size={14} />} 试听描述音色
                  </button>
                  <button className="btn btn-primary btn-sm" disabled={!!pvBusy['new-clone'] || !sample}
                    onClick={() => void doPreview('样本复刻音色（未保存）', { mode: 'clone', text: SAMPLE_TEXT, sampleBase64: sample?.base64 ?? '' }, 'new-clone')}>
                    {pvBusy['new-clone'] ? <Loader2 size={14} className="spin" /> : <Play size={14} />} 试听复刻音色
                  </button>
                  <button className="btn btn-primary btn-sm" disabled={busy !== null || !ready || !newName.trim()}
                    title={ready ? undefined : '语音配置尚未读取到，暂不可保存音色'}
                    onClick={() => void saveVoice(sample ? 'clone' : 'design')}>
                    {busy === 'save-voice' ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
                    保存音色（{sample ? '按复刻' : '按文字描述'}）
                  </button>
                </div>
                <div className="lrn-inline-note">
                  文字描述音色：每次合成都依据描述生成，音色稳定但不依赖样本；样本复刻：以上传的那段声音复刻，更接近本人。
                  仅支持 mp3 / wav，样本须控制在 7MB 以内。
                </div>
              </div>

              {custom.length > 0 && (
                <div className="lrn-block">
                  <div className="lrn-block-title">已保存的音色（{custom.length} 个）</div>
                  <div className="lrn-status-list">
                    {custom.map((v) => (
                      <div className="lrn-status-row" key={v.id} style={{ cursor: 'default' }}>
                        <div className="lrn-status-main">
                          <div className="lrn-status-uid">
                            <b>{v.name}</b>
                            <span className="badge badge-soft">{v.kind === 'clone' ? '样本复刻' : '文字设计'}</span>
                            {defaultVoice === v.id && <span className="badge badge-success">当前默认</span>}
                          </div>
                          {v.description && <div className="lrn-status-preview">{v.description}</div>}
                          <div className="lrn-actions">
                            <button className="btn btn-primary btn-sm" disabled={!!pvBusy[`saved:${v.id}`]}
                              onClick={() => void doPreview(v.name, { voiceId: v.id, text: SAMPLE_TEXT }, `saved:${v.id}`)}>
                              {pvBusy[`saved:${v.id}`] ? <Loader2 size={13} className="spin" /> : <Play size={13} />} 试听
                            </button>
                            <button className="btn btn-sm" onClick={() => setDefaultVoice(v.id)}>设为默认音色</button>
                            <button className="btn btn-outline-danger btn-sm" disabled={busy !== null} onClick={() => void removeVoice(v)}>
                              {busy === `del-${v.id}` ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} 删除
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

      </div>
    </div>
  );
}
