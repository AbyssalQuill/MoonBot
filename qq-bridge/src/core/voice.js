// 语音能力（MiMo-V2.5-TTS 系列 + MiMo-V2.5-ASR）—— 2026-09-15 新增
//
// 设计要点（已按官方文档 + 服务器实测逐条验证过，见文件末尾「实测记录」）：
//   · 合成/识别都走同一个 OpenAI 兼容端点：POST {baseUrl}/chat/completions
//       - 鉴权两种都发：`api-key: <KEY>`（官方文档首选）与 `Authorization: Bearer <KEY>`；
//       - 合成：messages 里 **assistant 角色**放要读的文本，**user 角色**放风格/音色描述（可选）；
//         音色放在 audio.voice；返回 choices[0].message.audio.data（base64 音频）。
//       - 识别：messages 里 content 用 [{type:'input_audio', input_audio:{data:'data:audio/mpeg;base64,...'}}]，
//         返回 choices[0].message.content（文本）。
//   · 三种合成模式：
//       tts    → mimo-v2.5-tts         内置音色（audio.voice = 音色 id）
//       design → mimo-v2.5-tts-voicedesign  用文字描述造音色（描述放 user 消息，不能传 voice）
//       clone  → mimo-v2.5-tts-voiceclone   用音频样本复刻（audio.voice = 样本的 **DataURL**，
//               形如 data:audio/mpeg;base64,…；**裸 base64 会被服务端 400 拒**
//               「audio.voice must be a DataURL for voice clone model」，已实测踩到）
//   · 语音文件必须落在 **NapCat 容器能读到的目录**：复用图片/表情那套路径归一化
//     （napcat.tmpDir + dockerPathMap → 容器内路径），实测发出去正常；读不回来时自动退 base64 重发。
//   · 省钱：同文本+同音色+同风格+同模型 → 命中缓存不再请求；每日合成字数上限；失败一律降级成文字，绝不吞消息。
//   · 全语音发送模式（voice-config.json 的 send.allVoice，2026-09-16 新增）：开启后回复**一律**走语音，
//     任何一条不成立（合成失败/超单条上限/当日额度用尽/被限流/带图/念不出来）都退回原来的文字发送，
//     并在日志里留一行带原因的记录。判定与回退集中在下面「全语音发送模式」一节。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { STATE_DIR } from '../lib/paths.js';
import { log } from '../lib/log.js';
import { napcatImageFileArg, resolveStickerTmpDir } from '../lib/napcat-file.js';
import { readJsonSafe, atomicWriteJson } from '../lib/json-fs.js';
import { isDeliveredUnconfirmed, deliveredUnconfirmedResult, onebotErrText } from '../lib/onebot-delivery.js';

const VOICE_CFG_FILE = path.join(STATE_DIR, 'voice-config.json');
const VOICE_LIB_FILE = path.join(STATE_DIR, 'voice-voices.json');
const VOICE_USAGE_FILE = path.join(STATE_DIR, 'voice-usage.json');
const CACHE_SUBDIR = 'voice-cache';
const RECV_TMP_SUBDIR = 'voice-recv';

/** 官方内置音色（文档 mimo-v2.5-tts 的 voice 取值表，2026-09-15 抄录） */
export const BUILTIN_VOICES = [
  { id: 'mimo_default', label: 'MiMo 默认', lang: '跟随集群', gender: '—', note: '国内集群默认=冰糖，其它集群默认=Mia' },
  { id: '冰糖', label: '冰糖', lang: '中文', gender: '女', note: '' },
  { id: '茉莉', label: '茉莉', lang: '中文', gender: '女', note: '' },
  { id: '苏打', label: '苏打', lang: '中文', gender: '男', note: '' },
  { id: '白桦', label: '白桦', lang: '中文', gender: '男', note: '' },
  { id: 'Mia', label: 'Mia', lang: '英文', gender: '女', note: '' },
  { id: 'Chloe', label: 'Chloe', lang: '英文', gender: '女', note: '' },
  { id: 'Milo', label: 'Milo', lang: '英文', gender: '男', note: '' },
  { id: 'Dean', label: 'Dean', lang: '英文', gender: '男', note: '' }
];

/** 四种角色各自的默认模型；地址默认给**已验证可用**的国内 Token Plan 端点，可改成官方 api.xiaomimimo.com */
export const VOICE_ROLES = [
  { role: 'tts', label: '语音合成（内置音色）', defaultModel: 'mimo-v2.5-tts', needsKey: true },
  { role: 'design', label: '音色设计（文字描述生成音色）', defaultModel: 'mimo-v2.5-tts-voicedesign', needsKey: true },
  { role: 'clone', label: '音色复刻（音频样本克隆）', defaultModel: 'mimo-v2.5-tts-voiceclone', needsKey: true },
  { role: 'asr', label: '语音识别（把别人的语音转成文字）', defaultModel: 'mimo-v2.5-asr', needsKey: true }
];

const DEFAULT_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1';
const ALT_BASE_URL = 'https://api.xiaomimimo.com/v1';
const DEFAULT_FORMATS = new Set(['mp3', 'wav', 'pcm', 'pcm16']);
const MAX_ASR_BYTES = 7 * 1024 * 1024;   // 官方限制：base64 后 ≤10MB（原始约 7.5MB，取 7MB 留余量）
const MAX_TTS_CHARS = 2000;              // 单次合成的硬上限（配置的 maxChars 只能更小）

let cfgRef = null;

export function initVoiceCore(cfg) {
  cfgRef = cfg;
}

// ── 配置 ────────────────────────────────────────────────────────────────────

function defaults() {
  const models = {};
  for (const r of VOICE_ROLES) {
    models[r.role] = { baseUrl: DEFAULT_BASE_URL, apiKey: '', model: r.defaultModel };
  }
  return {
    enabled: false,
    models,
    defaultVoice: '冰糖',
    style: '',                 // 全局风格指令（可选，放进 user 消息；如「语气甜甜的，语速稍快」）
    format: 'mp3',
    maxChars: 120,             // 单条语音文本上限（群聊语音太长没人听）
    dailyChars: 20000,         // 每日合成字数上限（0 = 不限）
    cacheEnabled: true,
    maxCacheFiles: 300,
    asrLanguage: 'auto',
    // 主动发语音的节奏（主人要求：文字里**掺着**发语音，且概率可调）
    send: {
      probability: 0.2,     // 每次唤醒抽签命中的概率（0~1）。0 = 永不主动发（只能被明确要求），1 = 每次都可以
      cooldownMs: 600000,   // 同一会话刚发过语音后，多久内不再抽中（防连发刷屏），默认 10 分钟
      // 全语音发送模式：true = 回复一律以语音发出（不再发文字），失败自动退回文字。
      // 【默认关闭且只认严格布尔 true】字段缺失（老配置）= 关闭，行为与加这个开关之前完全一致。
      allVoice: false
    }
  };
}

/** 递归深合并纯对象（models.<role>.<field>、send.<field> 这类嵌套都要逐字段合并，
 *  否则旧配置缺字段时会被 patch 整体替换掉默认值）。数组/非对象一律直接覆盖。 */
function mergeConfig(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === undefined) continue;
    const b = base?.[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[k] = mergeConfig(b, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function readStored() {
  const j = readJsonSafe(VOICE_CFG_FILE, null);
  return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
}

/** 生效配置 = 默认值 ← 主 config.json 的 voice 段 ← state/voice-config.json（管理端写入的优先） */
export function voiceConfig() {
  const fromMain = (cfgRef && typeof cfgRef.voice === 'object' && cfgRef.voice) ? cfgRef.voice : {};
  return mergeConfig(mergeConfig(defaults(), fromMain), readStored());
}

function maskKey(k) {
  const s = String(k ?? '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

/** 给管理端看的配置：**绝不回传完整密钥**，只回「是否已设置 + 掩码」 */
export function voiceConfigPublic() {
  const c = voiceConfig();
  const models = {};
  for (const r of VOICE_ROLES) {
    const m = c.models?.[r.role] ?? {};
    models[r.role] = {
      baseUrl: String(m.baseUrl ?? ''),
      model: String(m.model ?? r.defaultModel),
      apiKeyMasked: maskKey(m.apiKey),
      apiKeySet: Boolean(String(m.apiKey ?? '').trim())
    };
  }
  return {
    ok: true,
    enabled: c.enabled === true,
    defaultVoice: String(c.defaultVoice ?? ''),
    style: String(c.style ?? ''),
    format: String(c.format ?? 'mp3'),
    maxChars: Number(c.maxChars) > 0 ? Number(c.maxChars) : 120,
    dailyChars: Number(c.dailyChars) >= 0 ? Number(c.dailyChars) : 0,
    cacheEnabled: c.cacheEnabled !== false,
    maxCacheFiles: Number(c.maxCacheFiles) > 0 ? Number(c.maxCacheFiles) : 300,
    asrLanguage: String(c.asrLanguage ?? 'auto'),
    // 主动发语音的节奏：概率 + 冷却（管理端可调；提示词里的「抽签」就用这两个值）
    send: {
      probability: Math.min(1, Math.max(0, Number(c.send?.probability ?? 0.2) || 0)),
      cooldownMs: Math.max(0, Number(c.send?.cooldownMs ?? 600000) || 0),
      // 全语音发送模式：管理端「语音」页的开关（回读给前端渲染用；只认严格布尔 true）
      allVoice: c.send?.allVoice === true
    },
    usage: usageToday(),
    roles: VOICE_ROLES.map((r) => ({ ...r })),
    presets: { tokenPlanCn: DEFAULT_BASE_URL, official: ALT_BASE_URL },
    builtinVoices: BUILTIN_VOICES,
    // 【2026-09-15 修】这里曾经漏传 models：管理端读不到已保存的地址/模型名，
    // 于是「保存」会把空值写回去，把配好的接入信息洗掉（密钥只回掩码是故意设计）。
    models
  };
}

/** 保存配置（管理端）。apiKey 传空/不传 = 保持原值；要清空请用 clearKeys 显式列出角色。 */
export function saveVoiceConfig(patch = {}) {
  const cur = voiceConfig();
  const next = mergeConfig(cur, patch ?? {});
  // 密钥：只有非空才覆盖，避免管理端回传掩码或空串把真 key 洗掉
  for (const r of VOICE_ROLES) {
    const incoming = patch?.models?.[r.role] ?? {};
    const key = incoming.apiKey;
    if (typeof key === 'string' && key.trim() !== '') next.models[r.role].apiKey = key.trim();
    else next.models[r.role].apiKey = cur.models[r.role].apiKey;
    // 地址/模型名同理：空串一律视为「这次没填」，保留原值（界面预填失效时也不会把配置洗掉）
    if (!String(incoming.baseUrl ?? '').trim()) next.models[r.role].baseUrl = cur.models[r.role].baseUrl;
    if (!String(incoming.model ?? '').trim()) next.models[r.role].model = cur.models[r.role].model;
  }
  for (const role of Array.isArray(patch?.clearKeys) ? patch.clearKeys : []) {
    if (next.models[role]) next.models[role].apiKey = '';
  }
  next.enabled = patch?.enabled === true;
  next.maxChars = Math.max(1, Math.min(MAX_TTS_CHARS, Number(patch?.maxChars) || cur.maxChars));
  next.dailyChars = Math.max(0, Number(patch?.dailyChars ?? cur.dailyChars) || 0);
  next.format = DEFAULT_FORMATS.has(String(patch?.format ?? cur.format)) ? String(patch?.format ?? cur.format) : 'mp3';
  // 发语音概率：允许传 0~1 的小数，也允许界面用百分数（>1 时按百分数换算），夹在 0~1
  if (patch?.send && typeof patch.send === 'object') {
    const raw = Number(patch.send.probability);
    if (Number.isFinite(raw)) {
      const v = raw > 1 ? raw / 100 : raw;
      next.send.probability = Math.min(1, Math.max(0, v));
    }
    const cd = Number(patch.send.cooldownMs);
    if (Number.isFinite(cd)) next.send.cooldownMs = Math.max(0, cd);
    // 全语音开关：**只认严格布尔**（字符串 "false" 是真值，放进来会把老用户的文字回复全变成语音）。
    // 前端传的不是布尔（如 undefined / 1 / "true"）时保持原值，避免一次半成品保存把开关洗掉。
    if (typeof patch.send.allVoice === 'boolean') next.send.allVoice = patch.send.allVoice;
  }
  atomicWriteJson(VOICE_CFG_FILE, next);
  log(`[voice] 配置已保存（启用=${next.enabled}, 默认音色=${next.defaultVoice}, 单条上限=${next.maxChars}字, 每日上限=${next.dailyChars}字/天, 发语音概率=${next.send.probability}, 冷却=${Math.round(next.send.cooldownMs / 1000)}s, 全语音模式=${next.send.allVoice === true ? '开' : '关'}）`);
  return voiceConfigPublic();
}

// ── 用量（北京时自然日） ─────────────────────────────────────────────────────

function beijingDayKey(nowMs = Date.now()) {
  return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function loadUsage() {
  const j = readJsonSafe(VOICE_USAGE_FILE, null);
  return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
}

export function usageToday() {
  const day = beijingDayKey();
  const all = loadUsage();
  const u = all[day] ?? { chars: 0, calls: 0 };
  return {
    day,
    chars: Number(u.chars) || 0,
    calls: Number(u.calls) || 0,
    cacheHits: Number(u.cacheHits) || 0,
    asrCalls: Number(u.asrCalls) || 0
  };
}

function bumpUsage(patch = {}) {
  const all = loadUsage();
  const day = beijingDayKey();
  const u = { chars: 0, calls: 0, cacheHits: 0, asrCalls: 0, ...(all[day] ?? {}) };
  for (const [k, v] of Object.entries(patch)) u[k] = (Number(u[k]) || 0) + (Number(v) || 0);
  all[day] = u;
  // 只保留最近 30 天
  const keys = Object.keys(all).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 30))) delete all[k];
  atomicWriteJson(VOICE_USAGE_FILE, all);
}

// ── 缓存目录（必须让 NapCat 容器读得到，否则语音发不出去） ────────────────────

function cacheDir() {
  const cfg = voiceConfig();
  const base = String(cfgRef?.napcat?.tmpDir ?? '').trim();
  if (cfgRef) {
    try {
      return path.join(resolveStickerTmpDir(cfgRef, path.join(STATE_DIR, CACHE_SUBDIR)), CACHE_SUBDIR);
    } catch { /* 落到 state 下 */ }
  }
  return path.join(STATE_DIR, CACHE_SUBDIR);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cacheKeyFor({ mode, model, text, voice, style, description, format }) {
  return crypto.createHash('sha1')
    .update([mode, model, format, voice, style, description, text].join('\u0000'))
    .digest('hex');
}

function pruneCache(dir, maxFiles) {
  try {
    const files = fs.readdirSync(dir)
      .map((f) => { const p = path.join(dir, f); let st = null; try { st = fs.statSync(p); } catch {} return st && st.isFile() ? { p, mtime: st.mtimeMs } : null; })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(maxFiles)) { try { fs.unlinkSync(f.p); } catch {} }
  } catch { /* 清理失败不影响主流程 */ }
}

// ── 与 MiMo 语音服务通信 ────────────────────────────────────────────────────

function roleConfig(role, cfg = voiceConfig()) {
  const m = cfg.models?.[role] ?? {};
  let baseUrl = String(m.baseUrl ?? '').trim();
  let apiKey = String(m.apiKey ?? '').trim();
  // 设计/复刻没单独配就复用合成的地址与密钥（同一家服务，省得填两遍）
  if (role !== 'tts') {
    if (!baseUrl) baseUrl = String(cfg.models?.tts?.baseUrl ?? '').trim();
    if (!apiKey) apiKey = String(cfg.models?.tts?.apiKey ?? '').trim();
  }
  return { baseUrl, apiKey, model: String(m.model ?? '').trim() };
}

function endpointOf(baseUrl) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  if (!b) throw new Error('未配置请求地址');
  return /\/chat\/completions$/i.test(b) ? b : `${b}/chat/completions`;
}

function shortBody(txt) {
  return String(txt ?? '').replace(/\s+/g, ' ').slice(0, 220);
}

async function chatCall(roleCfg, body, timeoutMs = 120000) {
  if (!roleCfg.apiKey) throw new Error('未配置该模型的 API Key（管理端「语音」页填写）');
  const res = await fetch(endpointOf(roleCfg.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'api-key': roleCfg.apiKey,
      authorization: `Bearer ${roleCfg.apiKey}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`语音服务 HTTP ${res.status}：${shortBody(txt)}`);
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error(`语音服务返回了非 JSON 内容：${shortBody(txt)}`);
  }
}

/** 极短静音 WAV（识别连通性自检用；免外部素材） */
function silentWavBuffer(ms = 300, sampleRate = 8000) {
  const samples = Math.max(1, Math.round((sampleRate * ms) / 1000));
  const data = Buffer.alloc(samples * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// ── 合成 ────────────────────────────────────────────────────────────────────

const MODE_LABEL = { tts: '语音合成', design: '音色设计', clone: '音色复刻' };

/* ── 【2026-09-18 二修「每次发都音色不同」】"音色锚点"必须与回复内容无关 ────────────────
 * §11.3 的冻结（design 音色 → 冻一段音频 → 之后都走 clone）已经把"每次现设计一个音色"解决了，
 * 线上日志也确实全是 `音色复刻 / 音色=样本复刻`（= m 已经是 clone，冻结生效）。但主人仍听出漂移，
 * 因为剩下的这条链路里还有两件事：
 *   ① 冻结用的那一段音频是**某一条回复的朗读** —— 它短（一两秒到几秒）、而且带着那句话的情绪
 *      （疑问/惊叹/撒娇都被念进音色里）。零样本复刻里参考越短越糊，说话人嵌入估计得越不准。
 *   ② 官方文档明确说**合成文本会左右音色**：`_diag/mimo-tts-guide.md:601`
 *      「Synthetic text should match the voice tone ... to achieve the best results」。
 *      也就是说"音色"不是只由参考样本决定的常量，当前这句话也是条件之一。
 * 两条叠加的结果：每条回复都是不同文本，而锚点又太弱压不住，于是模型每次都重新采样出一个
 * 略有偏差的说话人 → 听感就是"每次像不同的人、有轻微漂移"。
 *
 * 修法（保守、不动任何配置语义）：锚点改成**一段固定文本**的合成结果 —— 与"这条回复说了什么"完全无关、
 * 长度足够、情绪中性。这样每条消息送出去的参考样本字节完全一致，模型只需要把当前这句话套进同一个音色。
 * 锚点只在一个音色第一次被锚定时生成一次（`rebuildFixedAnchor`），之后终身复用；失败则退回老行为。
 * 请求里没有任何可以钉死采样的旋钮（seed/temperature 都不在文档的 audio 字段里，见 `_diag/mimo-tts-api.md`），
 * 所以"把参考样本做到最强、最一致"是桥侧唯一能做的稳定化手段。
 */
const ANCHOR_TEXT = '你好呀，我是你设置的那个音色。今天天气还不错，风不大，路上的人也慢慢多了起来。要是你愿意的话，就跟我说说今天遇到的事吧，我会认真听的。';
/** 冻结点上的来源标记：fixed-text = 用上面这段固定文本设计出来的**强锚点**；其余（含历史遗留）都是弱锚点 */
const ANCHOR_TAG_FIXED = 'fixed-text';
/** 每个进程里"已经尝试重建过锚点"的音色 id —— 重建失败也不再每条消息都重试（否则等于每条都换音色） */
const anchorRebuildTried = new Set();

/**
 * 合成语音 → 本地音频文件。
 * @param {object} [cfg] 显式传入的生效配置（省略 = 现读 state/voice-config.json）。
 *   存在的意义：调用方（全语音模式）与测试可以钉死一份配置，不必依赖磁盘上的现读值。
 * @returns {{ ok:true, filePath:string, bytes:number, mime:string, cached:boolean, ms:number, finalTextPreview:string|null, mode:string }}
 */
export async function synthesize({
  text, mode = 'tts', voice = '', style = '', description = '', sampleBase64 = '', format = '', cfg: cfgIn = null
} = {}) {
  const cfg = cfgIn ?? voiceConfig();
  if (cfg.enabled !== true) throw new Error('语音功能未启用（管理端「语音」页打开总开关后再试）');
  const clean = String(text ?? '').trim();
  if (!clean) throw new Error('要合成的文本为空');
  const maxChars = Math.min(MAX_TTS_CHARS, Math.max(1, Number(cfg.maxChars) || 120));
  if (clean.length > maxChars) throw new Error(`文本过长：${clean.length} 字，超过单条上限 ${maxChars} 字`);
  let m = ['tts', 'design', 'clone'].includes(mode) ? mode : 'tts';
  let wantDesc = String(description ?? '');
  let wantSample = String(sampleBase64 ?? '');
  // ── 自建音色解析（2026-09-15 修「Unknown voice: design-xxxx」）────────────────
  // 默认音色或调用方传进来的 voice 可能是**音色库里的自建音色**（design-xxx / clone-xxx，或它的名字）。
  // 以前只有「发送」「试听」两个端点做了这层解析，模型测试按钮 / 其它调用方会把 design-xxx 直接当
  // 内置音色 id 发给服务端 → 400 Unknown voice（可用音色只有那 9 个内置的）。
  // 现在统一在合成入口解析：设计型改走 design（用它的描述），复刻型改走 clone（读它的样本）。
  let resolvedVoice = String(voice || '').trim();
  // 这次合成用的到底是"哪一种音色来源" + 具体是哪个文件：**只进日志**，是线上定位音色漂移的唯一证据
  let voiceSrc = '';
  let voiceRefPath = '';
  // 【2026-09-18】本音色是从音色库里的**描述型自建音色**解析来的，记一下 —— 合成成功后要把它冻结
  let designRec = null;
  if (m === 'tts') {
    const wanted = resolvedVoice || String(cfg.defaultVoice ?? '').trim();
    if (wanted && !BUILTIN_VOICES.some((v) => v.id === wanted)) {
      const hit = findCustomVoice(wanted);
      if (hit?.kind === 'clone' && hit.samplePath && fs.existsSync(hit.samplePath)) {
        m = 'clone';
        wantSample = fs.readFileSync(hit.samplePath).toString('base64');
        voiceSrc = '音色库复刻样本';
        voiceRefPath = hit.samplePath;
        resolvedVoice = '';
      } else if (hit?.kind === 'design' && hit.description) {
        // 【2026-09-18】冻结过就按 clone 走同一个锚点（音色才稳），没冻结才现设计
        const frozen = frozenSampleOf(hit);
        if (frozen) {
          m = 'clone';
          /* 【2026-09-18 二修】老锚点（frozenFrom 不是 fixed-text）是"某一条回复的音频"，是弱锚点：
           * 它短、还带着那句话的情绪，而服务端会把**当前文本**也算进音色条件里（见 ANCHOR_TEXT 上方说明），
           * 于是每条不同文本都会把它拉出一点偏差 —— 这就是冻结生效之后仍在漂的那部分。
           * 这里补一次重建：换成固定锚点文本；重建成功立刻就用新的，失败/已试过就继续用旧锚点。
           * 重建是"一次性"的（进程内 anchorRebuildTried + 落库 frozenFrom 双重去重），
           * 绝不会退化成"每条消息都重新设计一个音色"。 */
          let anchorPath = frozen;
          let anchorFrom = String(hit.frozenFrom ?? 'reply-audio');
          if (anchorFrom !== ANCHOR_TAG_FIXED) {
            const rebuilt = await rebuildFixedAnchor(hit, { cfg, format });
            if (rebuilt) { anchorPath = rebuilt; anchorFrom = ANCHOR_TAG_FIXED; }
          }
          wantSample = fs.readFileSync(anchorPath).toString('base64');
          voiceSrc = `冻结样本(${anchorFrom})`;
          voiceRefPath = anchorPath;
          resolvedVoice = '';
        } else {
          m = 'design';
          wantDesc = hit.description;
          voiceSrc = '现设计（文字描述）';
          resolvedVoice = '';
          designRec = hit;
        }
      } else if (/^(design|clone)-/i.test(wanted)) {
        // 以我们自己的自建音色 id 前缀开头却查不到 → 多半是音色被删了，给一句人话而不是 400
        throw new Error(`默认音色「${wanted}」在音色库里已经不存在了（可能刚被删除）：请到管理端「语音」页重新选一个默认音色`);
      }
    }
  }
  const fmt = DEFAULT_FORMATS.has(String(format || cfg.format)) ? String(format || cfg.format) : 'mp3';
  if (!voiceSrc) voiceSrc = m === 'clone' ? '调用方传入样本' : (m === 'design' ? '现设计（文字描述）' : '内置音色');
  const roleCfg = roleConfig(m, cfg);
  const useVoice = m === 'clone' ? wantSample.trim() : String(resolvedVoice || cfg.defaultVoice || 'mimo_default').trim();
  if (m === 'clone' && !useVoice) throw new Error('音色复刻需要音频样本（mp3/wav 的 base64）');
  if (m === 'design' && !wantDesc.trim()) throw new Error('音色设计需要一段音色描述文字');
  // 复刻模型要求 audio.voice 是 DataURL（裸 base64 会被 400 拒），这里统一归一化
  const cloneVoice = m === 'clone' ? toVoiceDataUrl(useVoice) : '';
  const styleText = String(style || cfg.style || '').trim();

  /* 【2026-09-18 修「音色抖动」的关键日志】每次合成到底用了哪种模式、哪个参考样本、样本哈希是多少。
   * 线上连发三条语音，看这行就知道该怎么定论：
   *   · `样本sha1=` 三条完全一样 → 送出去的参考样本字节一致，"音色被换掉"这条排除，
   *     漂移只可能来自服务端按当前文本重新采样（见 ANCHOR_TEXT 那段说明）；
   *   · `样本sha1=` 会变 / 反复出现"模式=design" → 锚点没被复用（重建或丢失），那才是桥侧的问题。
   * 顺带把 `样本文件=` 打成完整路径，"是不是同一个文件"一眼可判。 */
  if (m === 'clone') {
    const anchorBuf = Buffer.from(String(useVoice).replace(/^data:[^,]+,/, ''), 'base64');
    log(`[voice] 合成请求：模式=clone（音色复刻）样本来源=${voiceSrc} 样本sha1=${crypto.createHash('sha1').update(anchorBuf).digest('hex').slice(0, 16)} 样本=${anchorBuf.length}字节${voiceRefPath ? ` 样本文件=${voiceRefPath}` : ''} 风格=${styleText || '（无）'} 文本=${clean.length}字`);
  } else {
    log(`[voice] 合成请求：模式=${m}（${MODE_LABEL[m]}）音色=${useVoice}（${voiceSrc}）描述hash=${wantDesc.trim() ? descHashOf(wantDesc.trim()) : '（无）'} 风格=${styleText || '（无）'} 文本=${clean.length}字`);
  }

  const messages = [];
  if (m === 'design') messages.push({ role: 'user', content: wantDesc.trim() });
  else if (styleText) messages.push({ role: 'user', content: styleText });
  messages.push({ role: 'assistant', content: clean });

  const audio = { format: fmt };
  if (m !== 'design') audio.voice = m === 'clone' ? cloneVoice : useVoice;

  const body = { model: roleCfg.model, messages, audio, stream: false };
  const ck = cacheKeyFor({ mode: m, model: roleCfg.model, text: clean, voice: m === 'clone' ? `sample:${crypto.createHash('sha1').update(cloneVoice).digest('hex').slice(0, 12)}` : useVoice, style: styleText, description: wantDesc.trim(), format: fmt });
  const dir = ensureDir(cacheDir());
  const filePath = path.join(dir, `${ck}.${fmt === 'pcm16' ? 'pcm' : fmt}`);

  if (cfg.cacheEnabled !== false && fmt !== 'pcm' && fs.existsSync(filePath)) {
    const st = fs.statSync(filePath);
    if (st.size > 0) {
      bumpUsage({ cacheHits: 1, calls: 1 });
      log(`[voice] ${MODE_LABEL[m]} 命中缓存：${path.basename(filePath)}（${st.size} 字节）`);
      return { ok: true, filePath, bytes: st.size, mime: fmt === 'wav' ? 'audio/wav' : 'audio/mpeg', cached: true, ms: 0, finalTextPreview: null, mode: m };
    }
  }

  // 每日字数上限：命中缓存的不算（上面已经先返回了）
  const daily = Number(cfg.dailyChars) || 0;
  if (daily > 0) {
    const u = usageToday();
    if (u.chars + clean.length > daily) {
      throw new Error(`今日语音合成额度已用尽（${u.chars}/${daily} 字），明天 0 点（北京时）恢复；这条内容请改成文字发送`);
    }
  }

  const t0 = Date.now();
  const j = await chatCall(roleCfg, body);
  const msg = j?.choices?.[0]?.message ?? {};
  const b64 = msg?.audio?.data;
  if (!b64 || typeof b64 !== 'string') {
    throw new Error(`语音服务没返回音频（${MODE_LABEL[m]}）：${shortBody(JSON.stringify(j))}`);
  }
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error('语音服务返回的音频为空');
  fs.writeFileSync(filePath, buf);
  /* 【2026-09-18 修「音色小幅漂移」】第一次按描述设计出来的音色，立刻把这段音频冻成参考样本，
   * 之后每次合成都会走 clone 复用同一个锚点 —— 否则每次都是"重新设计一个音色"，必然轻微漂移。
   * 放在这里（而不是只放在 synthesizeWithSavedVoice）是因为全语音模式走的是 synthesize({text,cfg})
   * 这条直路，冻结必须在合成入口就发生。
   *
   * 【2026-09-18 二修】锚点**不能再是"这条回复的音频"**：那条音频短、还带着这句话的情绪，
   * 而服务端又把当前文本算进音色条件（见 ANCHOR_TEXT 上方说明）→ 弱锚点压不住，每条文本都把它拉偏一点。
   * 所以顺序改成：
   *   ① 先用**固定锚点文本**设计一段，冻成强锚点（与回复内容无关、长度足够、情绪中性）；
   *   ② 这一段合成不出来（额度/网络/接口拒绝）时，退回老行为：把本次这条回复的音频冻成锚点。
   * 两个分支都只在"这个音色第一次被锚定"时发生一次（designRec 仅在这条直路上非空），之后终身复用。 */
  if (designRec) {
    let frozenPath = '';
    try {
      const anchor = await synthesize({
        text: ANCHOR_TEXT, mode: 'design', description: designRec.description, format: fmt, cfg
      });
      if (anchor?.filePath && fs.existsSync(anchor.filePath)) {
        frozenPath = freezeDesignVoice(designRec, anchor.filePath, log, ANCHOR_TAG_FIXED);
      }
    } catch (e) {
      // 只影响"锚点的质量"，绝不影响这条消息能不能发出去（音频此时已经落盘）
      log(`[voice] 固定锚点文本合成失败（退回用本次回复的音频当锚点）：${e?.message ?? e}`);
    }
    if (!frozenPath) freezeDesignVoice(designRec, filePath, log, 'reply-audio');
  }
  bumpUsage({ chars: clean.length, calls: 1 });
  pruneCache(dir, Math.max(20, Number(cfg.maxCacheFiles) || 300));
  const ms = Date.now() - t0;
  log(`[voice] ${MODE_LABEL[m]} 完成：${clean.length} 字 → ${buf.length} 字节（${ms}ms，音色=${m === 'clone' ? '样本复刻' : useVoice}）`);
  return {
    ok: true,
    filePath,
    bytes: buf.length,
    mime: fmt === 'wav' ? 'audio/wav' : 'audio/mpeg',
    cached: false,
    ms,
    finalTextPreview: msg?.final_text_preview ? String(msg.final_text_preview) : null,
    mode: m
  };
}

// ── 识别 ────────────────────────────────────────────────────────────────────

function sniffAudio(buf) {
  if (buf.length >= 3 && (buf.slice(0, 3).toString('latin1') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))) return { mime: 'audio/mpeg', format: 'mp3' };
  if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WAVE') return { mime: 'audio/wav', format: 'wav' };
  return null;
}

/**
 * 复刻模型的 audio.voice 必须是 **DataURL**，不能是裸 base64。
 * 【2026-09-15 实测踩到】给裸 base64 会直接被服务端拒：
 *   `Param Incorrect: audio.voice must be a DataURL for voice clone model`（HTTP 400）。
 * 这里统一按样本头部字节推断 MIME（mp3/wav），已经带 data: 前缀的原样放行。
 */
function toVoiceDataUrl(sample) {
  const s = String(sample ?? '').trim();
  if (!s) return '';
  if (/^data:audio\//i.test(s)) return s;
  const bare = s.replace(/^data:[^,]+,/, '');
  const sniff = sniffAudio(Buffer.from(bare, 'base64'));
  return `data:${sniff?.mime ?? 'audio/mpeg'};base64,${bare}`;
}

/** 识别一段音频（Buffer）→ 文本 */
export async function transcribeBuffer(buf, { language = '' } = {}) {
  const cfg = voiceConfig();
  if (cfg.enabled !== true) throw new Error('语音功能未启用（管理端「语音」页打开总开关后再试）');
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('音频内容为空');
  if (buf.length > MAX_ASR_BYTES) {
    throw new Error(`音频太大（${(buf.length / 1048576).toFixed(1)}MB），识别接口上限约 7MB；请让对方发短一点的语音`);
  }
  const sniff = sniffAudio(buf);
  if (!sniff) throw new Error('这个音频格式识别接口不支持（只支持 mp3 / wav）');
  const roleCfg = roleConfig('asr', cfg);
  const body = {
    model: roleCfg.model,
    messages: [{
      role: 'user',
      content: [{ type: 'input_audio', input_audio: { data: `data:${sniff.mime};base64,${buf.toString('base64')}` } }]
    }],
    asr_options: { language: String(language || cfg.asrLanguage || 'auto') }
  };
  const t0 = Date.now();
  const j = await chatCall(roleCfg, body);
  const out = String(j?.choices?.[0]?.message?.content ?? '').trim();
  bumpUsage({ asrCalls: 1 });
  const ms = Date.now() - t0;
  log(`[voice] 语音识别完成：${(buf.length / 1024).toFixed(0)}KB → ${out.length} 字（${ms}ms）`);
  return { ok: true, text: out, ms, format: sniff.format };
}

export async function transcribeFile(filePath, opts = {}) {
  const p = String(filePath ?? '').trim();
  if (!p || !fs.existsSync(p)) throw new Error(`音频文件不存在：${p}`);
  return transcribeBuffer(fs.readFileSync(p), opts);
}

/** 连通性自检：合成 4 个字 / 识别一段静音（管理端「测试」按钮用） */
export async function testRole(role) {
  if (role === 'asr') {
    const r = await transcribeBuffer(silentWavBuffer(), { language: 'zh' });
    return { ok: true, role, detail: `识别接口连通（静音样本返回 ${r.text.length} 字，${r.ms}ms）`, ms: r.ms };
  }
  const mode = role === 'design' ? 'design' : role === 'clone' ? 'clone' : 'tts';
  if (mode === 'clone') throw new Error('音色复刻需要上传音频样本，无法用测试按钮直接试；请在「音色库」里上传样本后试听');
  const r = await synthesize({
    text: '你好呀',
    mode,
    description: mode === 'design' ? '年轻女声，清亮柔和，语速中等' : ''
  });
  return { ok: true, role, detail: `合成接口连通（${r.bytes} 字节，${r.ms}ms）`, ms: r.ms };
}

// ── 音色库（管理端自建音色） ──────────────────────────────────────────────────

function loadVoiceLib() {
  const j = readJsonSafe(VOICE_LIB_FILE, null);
  return (j && Array.isArray(j.voices)) ? j : { voices: [] };
}

/** 按 id 或名字找自建音色（内置音色不走这里）。找的是**磁盘上的库**，所以管理端刚存完就能用。 */
function findCustomVoice(idOrName) {
  const want = String(idOrName ?? '').trim();
  if (!want) return null;
  const lib = loadVoiceLib();
  return lib.voices.find((v) => v?.id === want || (v?.name && v.name === want)) ?? null;
}

export function listVoices() {
  const lib = loadVoiceLib();
  return {
    ok: true,
    builtin: BUILTIN_VOICES,
    custom: lib.voices.map((v) => ({
      id: v.id,
      name: v.name,
      kind: v.kind,                       // design = 文字描述生成；clone = 音频样本复刻
      description: v.description ?? '',
      sampleBytes: Number(v.sampleBytes) || 0,
      hasSample: Boolean(v.samplePath && fs.existsSync(v.samplePath)),
      createdAt: v.createdAt ?? '',
      // 【2026-09-18】锚点状态：管理端「语音」页看一眼就知道这个音色的参考样本是什么时候、按哪种方式冻的
      // （fixed-text = 固定锚点文本，音色最稳；reply-audio = 某条回复的音频，属弱锚点，下次合成会自动重建）
      frozenAt: v.frozenAt ?? '',
      frozenFrom: v.frozenFrom ?? '',
      hasFrozen: Boolean(frozenSampleOf(v))
    }))
  };
}

function sampleDir() {
  const dir = path.join(ensureDir(cacheDir()), 'samples');
  ensureDir(dir);
  return dir;
}

export function saveCustomVoice({ name, kind = 'design', description = '', sampleBase64 = '' } = {}) {
  const nm = String(name ?? '').trim();
  if (!nm) throw new Error('音色名字不能为空');
  const k = kind === 'clone' ? 'clone' : 'design';
  if (k === 'design' && !String(description ?? '').trim()) throw new Error('请先写一段音色描述（例如「十六七岁少女音，清亮软糯，语速稍快」）');
  let samplePath = '';
  let sampleBytes = 0;
  if (k === 'clone') {
    const raw = String(sampleBase64 ?? '').replace(/^data:[^,]+,/, '').trim();
    if (!raw) throw new Error('音色复刻需要上传 mp3/wav 音频样本');
    const buf = Buffer.from(raw, 'base64');
    if (!buf.length) throw new Error('音频样本解析失败');
    if (buf.length > MAX_ASR_BYTES) throw new Error(`样本太大（${(buf.length / 1048576).toFixed(1)}MB），请压到 7MB 以内`);
    const sniff = sniffAudio(buf);
    if (!sniff) throw new Error('样本格式不支持（只支持 mp3 / wav）');
    samplePath = path.join(sampleDir(), `${crypto.randomBytes(6).toString('hex')}.${sniff.format}`);
    fs.writeFileSync(samplePath, buf);
    sampleBytes = buf.length;
  }
  const lib = loadVoiceLib();
  const rec = {
    id: `${k}-${crypto.randomBytes(4).toString('hex')}`,
    name: nm,
    kind: k,
    description: String(description ?? '').trim(),
    samplePath,
    sampleBytes,
    createdAt: new Date().toISOString()
  };
  lib.voices.push(rec);
  atomicWriteJson(VOICE_LIB_FILE, lib);
  log(`[voice] 音色已保存：${nm}（${k === 'clone' ? '音频复刻' : '文字设计'}）`);
  return { ok: true, voice: { id: rec.id, name: nm, kind: k, description: rec.description, sampleBytes } };
}

export function deleteCustomVoice(id) {
  const lib = loadVoiceLib();
  const idx = lib.voices.findIndex((v) => v.id === String(id ?? ''));
  if (idx < 0) throw new Error('音色不存在');
  const [gone] = lib.voices.splice(idx, 1);
  if (gone?.samplePath) { try { fs.unlinkSync(gone.samplePath); } catch {} }
  atomicWriteJson(VOICE_LIB_FILE, lib);
  // 【2026-09-15 修】删掉的正好是当前默认音色时，把默认音色退回内置的冰糖：
  // 否则默认音色指向一个已不存在的自建音色，之后每次合成都报「Unknown voice」。
  const cfg = voiceConfig();
  const def = String(cfg.defaultVoice ?? '');
  if (def && (def === gone?.id || def === gone?.name)) {
    atomicWriteJson(VOICE_CFG_FILE, { ...readStored(), defaultVoice: '冰糖' });
    log(`[voice] 默认音色「${def}」已被删除，自动退回内置音色 冰糖`);
  }
  return { ok: true };
}

/* ── 【2026-09-18 修「每次发送的语音音色有小幅漂移」】────────────────────────────
 * 根因（子代理复核过代码链路）：
 *   · `design`（文字设计）型音色是**每次调用现设计一个音色** —— 同一段描述两次合成，
 *     服务端内部有随机性，音色就会轻微漂移。而主人的默认音色正是自建 design 音色，
 *     全语音模式下每条回复都重新设计一次，漂移最明显。
 *   · `cacheKeyFor()` 把 `text` 也算进 key，所以只有"同一句话"才命中缓存，换个说法必然重新合成。
 *   · `clone`（音频复刻）有参考音频当锚点，天然稳得多。
 *
 * 修法：**把 design 音色"冻住"** —— 第一次合成成功后，把那段音频留作参考样本
 * （`frozenSamplePath`），之后每次都按 clone 走同一个锚点。等于"一次设计、终身复用"，音色就稳了。
 * 描述被改过（hash 对不上）或样本文件丢了，就自动忽略冻结、重新设计一次。
 * 这是最小改动：不动合成接口、不动缓存 key 的语义，只加一个"锚点"。
 */
function descHashOf(desc) {
  return crypto.createHash('sha1').update(String(desc ?? '')).digest('hex').slice(0, 16);
}

/** 取某个自建音色当前可用的"冻结样本"（没有/失效就返回 null） */
function frozenSampleOf(v) {
  try {
    if (!v || v.kind !== 'design') return null;
    const p = String(v.frozenSamplePath ?? '').trim();
    if (!p || !fs.existsSync(p)) return null;
    if (String(v.frozenDescHash ?? '') !== descHashOf(v.description)) return null;
    return p;
  } catch { return null; }
}

/** 把一次 design 合成的音频冻成该音色的参考样本（音色锚点）；失败只记日志，不影响本次合成。
 *  @param {string} from 锚点来源标记：ANCHOR_TAG_FIXED = 固定锚点文本（强）；'reply-audio' = 某条回复的音频（弱）
 *  @returns {string|false} 成功返回锚点文件路径（真值，老调用方按布尔用也没问题），失败返回 false */
function freezeDesignVoice(rec, audioPath, logFn = log, from = 'reply-audio') {
  try {
    if (!rec?.id || !audioPath || !fs.existsSync(audioPath)) return false;
    const ext = path.extname(audioPath).replace(/^\./, '') || 'mp3';
    const frozenPath = path.join(sampleDir(), `frozen-${rec.id}.${ext}`);
    fs.copyFileSync(audioPath, frozenPath);
    // 重新读库再写，避免覆盖期间别处的改动
    const lib = loadVoiceLib();
    const target = lib.voices.find((x) => x.id === rec.id);
    if (!target) return false;
    target.frozenSamplePath = frozenPath;
    target.frozenDescHash = descHashOf(target.description);
    target.frozenAt = new Date().toISOString();
    // 记下来源：下次合成看到不是 fixed-text 就知道这个锚点还是"某条回复的音频"，值得重建一次（见 rebuildFixedAnchor）
    target.frozenFrom = from;
    atomicWriteJson(VOICE_LIB_FILE, lib);
    // 日志带上完整路径与来源：线上排查音色漂移时，"锚点到底是哪个文件、谁冻的"必须一眼可见
    logFn?.(`[voice] 音色「${target.name}」已冻结参考样本（来源=${from}）：${frozenPath}（${fs.statSync(frozenPath).size} 字节）`);
    return frozenPath;
  } catch (e) {
    logFn?.(`[voice] 冻结参考样本失败（不影响本次合成，下次还会重新设计）：${e?.message ?? e}`);
    return false;
  }
}

/**
 * 给一个 design 型音色补上"强锚点"：用**固定锚点文本**（ANCHOR_TEXT）现设计一段并冻住。
 * 为什么值得多花这一次合成：锚点一旦是"某条回复的音频"，音色就会随每条文本漂（见 ANCHOR_TEXT 上方说明）；
 * 换成固定文本后，每条消息送出去的参考样本字节完全一致。
 *
 * 去重（关键，否则会退化成"每条都换音色"）：
 *   · 进程内 `anchorRebuildTried`：同一个音色一个进程只试一次，失败也不每条重试；
 *   · 落库 `frozenFrom = fixed-text`：成功之后（含桥重启后）都不再重建。
 * @returns {Promise<string>} 可用的锚点路径；没重建（或失败）返回 ''，调用方继续用旧锚点
 */
async function rebuildFixedAnchor(rec, { cfg = null, format = '' } = {}) {
  const id = String(rec?.id ?? '');
  if (!id || anchorRebuildTried.has(id)) return '';
  anchorRebuildTried.add(id);
  try {
    const r = await synthesize({
      text: ANCHOR_TEXT, mode: 'design', description: rec.description, format, cfg
    });
    if (!r?.filePath || !fs.existsSync(r.filePath)) return '';
    const frozenPath = freezeDesignVoice(rec, r.filePath, log, ANCHOR_TAG_FIXED);
    if (!frozenPath) return '';
    log(`[voice] 音色「${rec.name}」的参考样本已换成固定锚点文本（${ANCHOR_TEXT.length} 字 → ${path.basename(r.filePath)}）：之后每条回复都用同一段样本，音色不再随文本漂`);
    return frozenPath;
  } catch (e) {
    log(`[voice] 固定锚点重建失败（继续用旧样本当锚点，不会每条都换音色）：${e?.message ?? e}`);
    return '';
  }
}

/** 用自定义音色合成：**优先用冻结样本走 clone（音色稳定）**，没有才回退 design，并把结果冻下来 */
export async function synthesizeWithSavedVoice(text, voiceId, { style = '', format = '' } = {}) {
  const lib = loadVoiceLib();
  const v = lib.voices.find((x) => x.id === String(voiceId ?? ''));
  if (!v) {
    throw new Error(`自定义音色不存在：${voiceId}（内置音色请用 voice 传音色 id，如 冰糖 / Chloe）`);
  }
  if (v.kind === 'clone') {
    const sample = fs.readFileSync(v.samplePath).toString('base64');
    const r = await synthesize({ text, mode: 'clone', sampleBase64: sample, style, format });
    return { ...r, voiceName: v.name };
  }

  // design 型：先看有没有可用的冻结样本
  const frozen = frozenSampleOf(v);
  if (frozen) {
    const r = await synthesize({ text, mode: 'clone', sampleBase64: fs.readFileSync(frozen).toString('base64'), style, format });
    return { ...r, voiceName: v.name, frozen: true };
  }

  // 第一次：按描述设计（这条消息本身仍按老行为发出来），然后给这个音色补一个**固定文本**的强锚点
  const r = await synthesize({ text, mode: 'design', description: v.description, style, format });
  try {
    // 没有可用锚点时才重建；重建成功就落库，失败退回老行为（把这次设计出来的音频冻成弱锚点）
    if (!frozenSampleOf(v)) {
      const built = await rebuildFixedAnchor(v, { format });
      if (!built && r?.filePath && fs.existsSync(r.filePath)) freezeDesignVoice(v, r.filePath, log, 'reply-audio');
    }
  } catch (e) {
    // 冻结失败不影响这次合成（只是下次还会重新设计）
    log(`[voice] 冻结参考样本失败（不影响本次合成）：${e?.message ?? e}`);
  }
  return { ...r, voiceName: v.name, frozen: false };
}

/** 手动解冻：删掉冻结样本，下次合成会重新设计一次（管理端"重新设计音色"用得上） */
export function unfreezeVoice(id) {
  const lib = loadVoiceLib();
  const v = lib.voices.find((x) => x.id === String(id ?? ''));
  if (!v) throw new Error('音色不存在');
  if (v.frozenSamplePath) { try { fs.unlinkSync(v.frozenSamplePath); } catch { /* ignore */ } }
  delete v.frozenSamplePath;
  delete v.frozenDescHash;
  delete v.frozenAt;
  delete v.frozenFrom;
  atomicWriteJson(VOICE_LIB_FILE, lib);
  // 允许本进程里立刻再重建一次（否则解冻后要等重启桥才会重新锚定）
  anchorRebuildTried.delete(String(v.id));
  log(`[voice] 音色「${v.name}」已解冻，下次合成会重新设计音色`);
  return { ok: true };
}

// ── 全语音发送模式（voice-config.json 的 send.allVoice）────────────────────────
// 主人要的：开关一开，机器人的回复**一律以语音发出**，不再发文字。
//
// 为什么由**桥**来转，而不是只在提示词里写一句"本轮必须用语音"：
//   提示词是软约束，模型会不照办（本文件上面那条「默认音色被模型自己换成冰糖」就是同一类问题）。
//   而"全语音"要求的是**送达形态**，那是投递层的不变量 —— 必须在真正发送的那一刻由桥保证。
//
// 三条硬规矩（也是这个功能的三条防线）：
//   ① **绝不丢消息**：合成失败 / 超单条上限 / 当日额度用尽 / 被限流 / 念不出来 / 这条带图……
//      任何一条不成立，都退回**原来的文字发送**，并留一行带原因的日志（调用方见 tryAllVoiceReply）；
//   ② **不突破既有额度**：真开始合成就是走既有的 synthesize()，dailyChars / maxChars / 缓存那一套
//      原样生效；这里只做"值不值得试"的前置判断，**不碰也不重算任何额度**；
//   ③ **老用户零变化**：字段缺失 / 配置损坏 / 字段不是严格布尔 true → 一律按关闭处理，
//      而且**连一行日志都不打**（这是每条消息都会经过的路径，刷日志比省事更贵）。
// 关于 send.cooldownMs：它是"文字里掺着发语音"的防连发闸门（给抽签用的）。全语音模式下**不再用它挡** ——
// 默认 10 分钟冷却意味着"第一条之后的十分钟内全部退回文字"，与"全语音"自相矛盾。

/** 全语音模式是否生效。**容错**：配置读不到/损坏/字段不是严格布尔 true 一律视为关闭。 */
export function allVoiceEnabled(cfg = null) {
  try {
    const c = cfg ?? voiceConfig();
    return c?.send?.allVoice === true;
  } catch {
    // 配置炸了也不能影响回复发送：按关闭处理（= 退回文字通道）
    return false;
  }
}

/**
 * 「这条文本能不能用语音发」的前置判断（纯函数：不发请求、不写盘、不读额度之外的任何东西）。
 * @param {string} text 已经清洗过的回复正文（占位符/CQ 码由调用方先清）
 * @param {{cfg?:object|null, hasMedia?:boolean}} [opts]
 * @returns {{ok:true,text:string} | {ok:false,reason:string,off?:boolean}} off=true 表示开关没开（不是失败，别打日志）
 */
export function allVoicePlan(text, { cfg = null, hasMedia = false } = {}) {
  let c;
  try {
    c = cfg ?? voiceConfig();
  } catch {
    return { ok: false, reason: '语音配置读取失败', off: true };
  }
  if (c?.send?.allVoice !== true) return { ok: false, reason: '未开启全语音模式', off: true };
  if (c.enabled !== true) return { ok: false, reason: '语音功能总开关没开（管理端「语音」页）' };
  // 带图/带媒体的那条：转成语音会把图丢掉，属"丢消息"，宁可这条按图文原样发
  if (hasMedia) return { ok: false, reason: '这条带图/媒体，转成语音会把图丢掉' };
  const t = String(text ?? '').trim();
  if (!t) return { ok: false, reason: '这条没有可朗读的文本（清洗后为空，或含会话令牌交由文字通道拦截）' };
  const maxChars = Math.min(MAX_TTS_CHARS, Math.max(1, Number(c.maxChars) || 120));
  if (t.length > maxChars) {
    return { ok: false, reason: `文本 ${t.length} 字超过单条语音上限 ${maxChars} 字（要整条都能念请调大管理端「单条上限」，硬上限 ${MAX_TTS_CHARS}）` };
  }
  // 链接/CQ 码念出来是一串乱码，不如交给文字通道
  if (/https?:\/\/|\[CQ:/i.test(t)) return { ok: false, reason: '内容含链接或 CQ 码，语音念不出来' };
  return { ok: true, text: t };
}

/**
 * 全语音模式：把一条回复正文用语音发出去。**任何失败都不抛**，只返回失败结果，
 * 由调用方（qq-send.js 的发送任务）接着走原来的文字发送 —— 这就是"不丢消息"的落点。
 * @returns {{ok:true,messageId:any,bytes:number,cached:boolean,text:string}
 *          | {ok:false,reason:string,off?:boolean}}
 */
export async function tryAllVoiceReply(key, text, { replyToMessageId = null, hasMedia = false, cfg = null } = {}) {
  const plan = allVoicePlan(text, { cfg, hasMedia });
  if (!plan.ok) {
    // 未开启：老用户每条消息都会走这里，一行日志都不打（提示词那边也不再注入语音行）
    if (!plan.off) log(`[voice] 全语音模式：${plan.reason}，退回文字（${key}）`);
    return plan;
  }
  let synth;
  try {
    synth = await synthesize({ text: plan.text, cfg });
  } catch (error) {
    const reason = String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 200);
    log(`[voice] 全语音模式：合成失败，退回文字（原因：${reason}）`);
    return { ok: false, reason };
  }
  try {
    const out = await sendVoiceToOneBot(key, synth.filePath, { replyToMessageId });
    // 登记一次冷却：万一之后又切回"掺着发"模式，不会紧接着再抽中一次
    noteVoiceSent(key);
    log(`[voice] 全语音模式：已用语音发出 ${key}（${plan.text.length} 字 → ${out.bytes} 字节${synth.cached ? '，缓存' : ''}，message_id=${out.messageId}）`);
    return { ok: true, messageId: out.messageId, bytes: out.bytes, cached: synth.cached === true, text: plan.text };
  } catch (error) {
    const reason = String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 200);
    // ⚠️ 注意：与文字通道同一类风险 —— 请求报错不代表绝对没送出去（超时可能已送出），
    // 这里仍然退回文字。极少数情况下对方会同时看到一条语音和一条文字；
    // 相比"整条消息消失"，这个方向的代价是主人明确要的（不丢消息优先）。
    log(`[voice] 全语音模式：语音发送失败，退回文字（原因：${reason}）`);
    return { ok: false, reason };
  }
}

// ── 「文字里掺着发语音」的抽签 ────────────────────────────────────────────────
// 主人要求：提示词里写成「文字和语音掺着发」，并且发语音的**概率可配置**。
// 实现选择：不让模型自己去猜概率（那要多花一轮思考、而且判得很飘），而是桥这边每次唤醒掷一次骰子，
// 把结果当**数据行**写进唤醒提示词（[Voice] dice HIT/MISS + 概率 + 默认音色），模型照着办。
// 掷骰与冷却的具体实现抽在 core/send-dice.js 里，表情包用的是同一套（只是 kind 不同）。
import { dice, noteSent } from './send-dice.js';

/** 发送成功后登记一次，用于冷却窗口内不再抽中。 */
export function noteVoiceSent(key) {
  noteSent('voice', key);
}

/**
 * 唤醒提示词里的一行语音数据（英文，与 preset 的英文指令框架一致）。
 * 语音未启用时返回 ''（一字符都不注入）。
 *
 * 【2026-09-16 修「我设了自定义音色，它却一直用内置冰糖」】主人 09-16 报：默认音色已经设成自建的
 * 「20岁女大音色」，发出来的还是冰糖。查日志与工具调用记录，根因是**模型自己显式传了内置音色**：
 *   04:17:44 [voice] 语音合成 完成：14 字 → 21336 字节（音色=冰糖）
 * 提示词里只有 HIT 那一支会带音色名，MISS 支不带 → 模型在"主人让我多说语音"这种场景下自己挑了一个
 * 它认识的内置音色（冰糖）。现在**两支都把默认音色名带上**，并在 preset/工具描述里明确：
 *   省略 voice = 用主人配的默认音色；除非有人点名要某个音色，否则不要自己指定。
 */
export function voiceTurnHint(key) {
  const cfg = voiceConfig();
  if (cfg.enabled !== true) return '';
  // 提示词里给模型看的音色名：自建音色显示名字（模型直接把名字当 voice 传回来也能用），内置的显示 id
  const rawDef = String(cfg.defaultVoice ?? '').trim() || 'mimo_default';
  const voiceName = findCustomVoice(rawDef)?.name ?? rawDef;
  /* ── 全语音模式（send.allVoice）────────────────────────────────────────────
   * 桥侧本来就会把正文自动转成语音（tryAllVoiceReply），那为什么还要改提示词？
   * 因为**能合成**和**好意思听**是两回事：文字通道的正文可以几百字、带 markdown/链接/表情，
   * 而这些要么超过 maxChars 被退回文字（主人看到的就是"开了全语音还在发文字"），要么念出来很怪。
   * 所以这里只做一件事：把"本轮一律语音、说人话、一口气之内"交给模型，让它直接产出**可朗读的短句**；
   * 同时明确告诉它桥会兜底，**别自己再发一遍文字造成双发**。
   * 这一支**不掷骰**：全语音模式下概率与冷却是无关参数（见文件上方"关于 send.cooldownMs"的说明）。 */
  if (cfg.send?.allVoice === true) {
    const hardCap = Math.min(MAX_TTS_CHARS, Math.max(1, Number(cfg.maxChars) || 120));
    return `[Voice] ALL-VOICE MODE ON (default voice=${voiceName}): EVERY reply this turn must reach the chat as a VOICE bubble, not text - say it out loud instead of typing it. Speak ONE short breath (hard limit ${hardCap} chars), plain speakable words only: no markdown, no links/URLs, no emoji or [CQ:] codes, no lists. Just answer with the normal send tools - the bridge turns your text into speech for you and quietly falls back to text only if it truly cannot be spoken, so never send the same words twice (no voice + text duplicate).\n`;
  }
  const { p, cooling, hit } = dice('voice', key, cfg.send?.probability ?? 0.2, cfg.send?.cooldownMs ?? 0);
  const cap = Math.min(60, Number(cfg.maxChars) || 60);
  if (hit) {
    return `[Voice] dice HIT (p=${p}, default voice=${voiceName}): you MAY mix ONE short voice bubble into this turn's reply - text is still the carrier, never voice instead of the answer, never the same words twice, under ${cap} chars.\n`;
  }
  const why = cooling ? 'cooldown' : 'dice MISS';
  return `[Voice] ${why} (p=${p}, default voice=${voiceName})${p <= 0 ? ' voice off' : ''}: text only this turn unless someone explicitly asks you to speak or sing (when they do, OMIT the voice field so the default above is used).\n`;
}

// ── 发送：把音频作为 QQ 语音发出去 ───────────────────────────────────────────

function napcatHttp() {
  const cfg = cfgRef ?? {};
  const httpUrl = String(cfg.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg.napcat?.accessToken || '');
  return { httpUrl, token };
}

async function onebotPost(action, params, timeoutMs = 60000) {
  const { httpUrl, token } = napcatHttp();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

/**
 * 发送一条语音。key = group:<群号> / private:<QQ>。
 * 路径先按 napcat.tmpDir + dockerPathMap 换成容器内路径（实测可用），
 * NapCat 读不到时自动退 base64 重发一次。
 */
export async function sendVoiceToOneBot(key, filePath, { replyToMessageId = null } = {}) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) throw new Error('key 格式应为 group:群号 或 private:QQ号');
  const kind = m[1];
  const id = Number(m[2]);
  const p = String(filePath ?? '').trim();
  if (!p || !fs.existsSync(p)) throw new Error(`语音文件不存在：${p}`);
  const fmt = (path.extname(p).replace(/^\./, '') || 'mp3').toLowerCase();
  // 路径归一化交给共享助手：配置了 napcat.tmpDir + dockerPathMap 时换成容器内路径（实测可用），
  // 换不出去就退回 base64:// —— 与图片/表情走的是同一套逻辑，避免各写一份。
  const fileArg = napcatImageFileArg(p, cfgRef);
  const segments = [];
  /* 【2026-09-18 修「引用有框、框下面没内容」】语音**不带 reply 段**。
   * 实测（线上 16:14–16:15，全语音模式）：QQ 渲染不了 `[{type:'reply'},{type:'record'}]` ——
   * 引用框在、语音没了；内核消息表里那几条也正是 `[reply+record]`。
   * 只有把 `social.send.quoteMode` 显式设成 `native`（老行为）才保留这个组合。 */
  const quoteMode = String(cfgRef?.social?.send?.quoteMode ?? 'native-text').trim().toLowerCase();
  if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
    const rid = String(replyToMessageId).trim();
    if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数');
    if (quoteMode === 'native') {
      segments.push({ type: 'reply', data: { id: rid } });
    } else {
      log(`[voice] ${key} 这条要引用 ${rid} 但发的是语音 —— 丢弃引用段（QQ 渲染不了"引用+语音"，会变成空气泡）；要带引用请按文字发（quoteMode=${quoteMode}）`);
    }
  }
  const recordSeg = { type: 'record', data: { file: fileArg } };
  segments.push(recordSeg);
  const build = () => (kind === 'private' ? { user_id: id, message: segments } : { group_id: id, message: segments });
  const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';

  let { res, body } = await onebotPost(action, build());
  let errText = onebotErrText(body);
  if (!res.ok || body?.status !== 'ok' || body?.retcode !== 0) {
    if (/文件处理失败|识别URL失败|ENOENT|no such file|语音|record/i.test(errText) && !/^base64:\/\//i.test(String(recordSeg.data.file))) {
      try {
        recordSeg.data.file = `base64://${fs.readFileSync(p).toString('base64')}`;
        log(`[voice] NapCat 读不到语音路径（${shortBody(errText).slice(0, 60)}），改用 base64 重发一次`);
        ({ res, body } = await onebotPost(action, build()));
        errText = onebotErrText(body);
      } catch (e) {
        log(`[voice] base64 兜底重发失败：${e?.message ?? e}`);
      }
    }
  }
  if (!res.ok || body?.status !== 'ok' || body?.retcode !== 0) {
    /* 【2026-09-18 线上实测】EventChecker Failed = 语音**已经发出去**了。
     * 旧代码在这里抛错 → sendMessages 判定"语音发送失败"→ 原地退回文字再发一遍，
     * 于是每条回复都变成"语音 + 文字"两份。现在按已送达处理。
     * 详见 lib/onebot-delivery.js。 */
    if (isDeliveredUnconfirmed(errText)) {
      const bytes = fs.statSync(p).size;
      log(`[voice] 回执 EventChecker Failed —— 语音已发出（只是事件确认失败），按已送达处理：${path.basename(p)}（${fmt}）`);
      return { ok: true, messageId: deliveredUnconfirmedResult().messageId, unconfirmed: true, bytes, format: fmt };
    }
    throw new Error(`发送语音失败：${body?.wording || body?.errMsg || body?.message || body?.retcode || res.status}`);
  }
  const messageId = body?.data?.message_id ?? body?.data?.messageId ?? null;
  log(`[voice] 语音已发送 ${key}：${path.basename(p)}（${fmt}，message_id=${messageId}）`);
  return { ok: true, messageId, bytes: fs.statSync(p).size, format: fmt };
}

// ── 取回「别人发来的语音」音频并识别 ────────────────────────────────────────

function containerName() {
  return String(cfgRef?.napcat?.containerName ?? '').trim() || 'napcat';
}

/** 容器内文件 → Buffer：宿主能直接读就读，否则 docker cp，再不行 docker exec base64 */
function readContainerFile(p) {
  const target = String(p ?? '').trim();
  if (!target) throw new Error('音频路径为空');
  if (fs.existsSync(target)) return fs.readFileSync(target);
  const tmpDir = ensureDir(path.join(cacheDir(), RECV_TMP_SUBDIR));
  const ext = path.extname(target) || '.mp3';
  const tmp = path.join(tmpDir, `recv-${Date.now()}${ext}`);
  const cp = spawnSync('docker', ['cp', `${containerName()}:${target}`, tmp], { timeout: 30000 });
  if (cp.status === 0 && fs.existsSync(tmp)) {
    const buf = fs.readFileSync(tmp);
    try { fs.unlinkSync(tmp); } catch {}
    return buf;
  }
  const ex = spawnSync('docker', ['exec', containerName(), 'base64', '-w0', target], { timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  if (ex.status === 0 && ex.stdout && String(ex.stdout).trim()) {
    return Buffer.from(String(ex.stdout).trim(), 'base64');
  }
  throw new Error(`读不到容器内音频文件（${target}）：docker cp 与 docker exec 都失败，请确认桥能执行 docker（napcat.containerName 默认 napcat）`);
}

/** 取某条语音消息的音频（NapCat get_record 会把它转成 mp3） */
export async function fetchVoiceFromMessage(messageId) {
  const mid = String(messageId ?? '').trim();
  if (!mid) throw new Error('messageId 不能为空');
  const got = await onebotPost('get_msg', { message_id: /^-?\d+$/.test(mid) ? Number(mid) : mid });
  const segs = Array.isArray(got.body?.data?.message) ? got.body.data.message : [];
  const rec = segs.find((s) => s?.type === 'record')?.data ?? null;
  if (!rec) throw new Error('这条消息里没有语音（record）段，无法识别');
  const params = { file: rec.file, out_format: 'mp3' };
  if (rec.file_id) params.file_id = rec.file_id;
  const out = await onebotPost('get_record', params, 90000);
  const filePath = out.body?.data?.file ?? out.body?.data?.path ?? '';
  if (out.body?.status !== 'ok' || !filePath) {
    throw new Error(`取语音文件失败：${out.body?.wording || out.body?.message || out.body?.retcode || '未知错误'}`);
  }
  return { buf: readContainerFile(filePath), sourcePath: filePath };
}

// ── 实测记录（2026-09-15，服务器 202.61.72.79 上逐条验过） ────────────────────
//  1) mimo-v2.5-tts（音色 冰糖）→ 返回 mp3，31,392 字节；usage 163 tokens；
//  2) mimo-v2.5-tts-voicedesign（中文音色描述）→ 返回 mp3，37,224 字节（首次带 optimize_text_preview
//     时遇到 IncompleteRead，去掉该参数并放宽超时后正常）；
//  3) mimo-v2.5-asr 对上面合成音频回识别 → 文本与原文完全一致；
//  4) NapCat 发 record：把 mp3 放进 napcat.tmpDir（宿主 /root/napcat/config/moonbot-tmp
//     ↔ 容器 /app/napcat/config/moonbot-tmp），传容器内路径 → 发送成功（message_id 已回）；
//  5) 取回别人发来的语音：get_msg 的 record 段 {file, path, url} → get_record{file,out_format:'mp3'}
//     返回容器内 mp3 路径 → docker cp 取回宿主 → ASR 识别成功。
//  6) 【2026-09-15 补】音色复刻（clone）：样本必须用 DataURL 传 audio.voice，裸 base64 会被
//     400 拒（Param Incorrect: audio.voice must be a DataURL for voice clone model）；
//     改成 DataURL 后复刻成功，把复刻出的音频再喂给 ASR 能识别回原文。
//  验证脚本留在 _diag/（mimo-voice-verify.py / qq-voice-send-verify.py / qq-voice-inbound-verify.py /
//  voice-clone-verify.py）。
