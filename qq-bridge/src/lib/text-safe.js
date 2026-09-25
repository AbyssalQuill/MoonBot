// 敏感信息脱敏工具
// 注意：KNOWN_AGENT_TOKENS 是跨模块共享的可变集 —— main 侧通过 import 活绑定 add/delete，
// 与本文件内 redactSensitiveText 读写的是同一实例，行为与迁移前完全一致。
import { SENSITIVE_RE } from '../sensitive.js';
// 已知的default agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
export const KNOWN_AGENT_TOKENS = new Set();

// 学习会话专用令牌集合（见 core/learning-token.js）：故意与 KNOWN_AGENT_TOKENS 分开。
// 它的唯一作用是解锁 POST /api/learning/submit-persona；若混进 KNOWN_AGENT_TOKENS，
// 学习会话就能顺带通行 /api/blacklist、/api/social/deepsleep 等管理端点，属于扩权。
// 放进脱敏集合是另一回事——防止令牌被模型抄进 QQ 消息。
export const LEARNER_AGENT_TOKENS = new Set();

// 敏感文本脱敏：把 SENSITIVE_RE 命中的片段替换为 ***，供日志/反馈/活动记录写入前使用。
// SENSITIVE_RE 未带 g 标志，这里动态补 g 以替换所有命中片段。
export function redactSensitiveText(text) {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch {}
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  for (const token of LEARNER_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

// 对象/数组递归脱敏：键名命中敏感清单置 ***；字符串叶子走文本脱敏。
// 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
export const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);

export function redactSensitive(obj) {
  if (Array.isArray(obj)) return obj.map(redactSensitive);
  if (obj && typeof obj === 'object') {
    const out = Object.create(null);
    for (const [k, v] of Object.entries(obj)) {
      const key = String(k).toLowerCase();
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      out[k] = SENSITIVE_ARG_KEYS.has(key) ? '***' : redactSensitive(v);
    }
    return out;
  }
  if (typeof obj === 'string') return redactSensitiveText(obj);
  return obj;
}

/* 2026-09-20：把「这次调用要发给哪个会话」单独抽出来落盘。
 * 为什么需要：会话令牌本身就是 QQ/群号（见本文件下方说明），所以 `key:"private:1736784911"`
 * 里的号码会被脱敏成 `private:***` —— 结果工具日志根本看不出消息发去了哪个会话，
 * 排查「pixiv 发图发错群」时查不到目标，只能靠翻会话日志。
 * 群号/QQ 号属于日常信息（本文件下方也这么说），不是凭证；这里只在工具日志里补一个
 * 未脱敏的 `target` 字段用于诊断，token 依然照旧脱敏。 */
export function extractToolTargetKey(args) {
  let parsed = args;
  for (let i = 0; i < 4; i++) {
    if (typeof parsed !== 'string') break;
    try { const next = JSON.parse(parsed); parsed = next; if (typeof next !== 'string') break; } catch { break; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
  const key = parsed.key ?? parsed.targetKey ?? parsed.sessionKey;
  if (typeof key === 'string' && /^(group|private):\d+$/.test(key.trim())) return key.trim();
  const gid = parsed.groupId ?? parsed.group_id;
  if (gid !== undefined && gid !== null && /^\d+$/.test(String(gid))) return `group:${String(gid)}`;
  const uid = parsed.userId ?? parsed.user_id;
  if (uid !== undefined && uid !== null && /^\d+$/.test(String(uid))) return `private:${String(uid)}`;
  return '';
}

// 工具调用参数清洗（落盘/上报前）：逐层解 JSON 字符串后递归脱敏，避免 token 明文落盘。
export function sanitizeToolArgs(args) {
  if (args === undefined || args === null) return null;
  let parsed = args;
  // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
  for (let i = 0; i < 4; i++) {
    if (typeof parsed !== 'string') break;
    try {
      const next = JSON.parse(parsed);
      parsed = next;
      if (typeof next !== 'string') break;
    } catch {
      break;
    }
  }
  const safe = redactSensitive(parsed);
  let text;
  try { text = JSON.stringify(safe); } catch { text = String(safe); }
  if (text.length > 2000) text = text.slice(0, 2000) + '…(truncated)';
  return text;
}

// ── 出站“会话令牌泄露”判定（智能判定：只拦真令牌） ─────────────────────────
// 会话令牌 = 会话本体身份（QQ/群号本身, 见 social-state.js fixedTokenForKey）：
// 号码在聊天里出现属日常正常内容（提群号、@号码、报手机号…）一律放行；
// 只在“令牌形态”出现时才判定泄露：
//   1) 整条消息（忽略尾部标点/空白）就等于某个已知令牌；
//   2) 令牌前带“令牌型标签”（令牌/【令牌】/[Token]/[Session token]/会话令牌/token/session token/
//      x-agent-token/密钥/口令…，标签后可夹 是/为/: = 等分隔）并直接跟随该令牌。
//      注：2026-09-12 起唤醒正文里的令牌行由【令牌】改为 [Token]（英文方括号），
//      所以这里必须同时认方括号形态，否则模型把令牌抄进 QQ 消息时不再被拦。
// “群号 / QQ号 / 账号 / 手机号”等日常称呼标签刻意不在标签表内 → 不误伤。
// 2026-09-20：新增 `[Session] <key>` 标签：唤醒正文从这一天起带这一行（wake-send.js sessionLine），
// 而 key 里就含令牌本体（group:<群号> / private:<QQ>），所以模型照抄整行发进 QQ 时必须同样被拦。
const TOKEN_LABEL_SRC = '(?:\\u3010?\\s*(?:会话)?令牌\\s*\\u3011?|\\[\\s*(?:会话|session\\s*)?token\\s*\\]|\\[\\s*session\\s*\\]|x-agent-token|sessionToken|session[\\s-]?token|access[\\s-]?token|agent[\\s-]?token|api[\\s-]?key|token|密钥|口令)';
const TOKEN_SEP_SRC = '(?:\\s*(?:是|为|[:=：])\\s*|\\s+)?';
export function tokenDisclosureIn(text) {
  const s = String(text ?? '');
  const trimmed = s.trim();
  for (const t of KNOWN_AGENT_TOKENS) {
    if (!t || !trimmed) continue;
    const body = trimmed.replace(/[。.!！?？,，;；、\s]+$/u, '');
    if (body === t) return { kind: 'whole', token: t };
    const esc = String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      const re = new RegExp(TOKEN_LABEL_SRC + TOKEN_SEP_SRC + '["\'`]?' + esc + '(?![A-Za-z0-9])', 'i');
      if (re.test(s)) return { kind: 'label', token: t };
      /* [Session] 行的形态是 `[Session] group:868756515`，标签与令牌之间还夹着 `group:`，
       * 上面那条（标签后直接跟令牌）匹配不到，所以单独再配一条。 */
      const reSession = new RegExp('\\[\\s*session\\s*\\]\\s*(?:group|private)?\\s*[:：]\\s*["\'`]?' + esc + '(?![A-Za-z0-9])', 'i');
      if (reSession.test(s)) return { kind: 'label', token: t };
    } catch {}
  }
  return null;
}

// ── 出站文本清洗 ──────────────────────────────────────────────────────────────

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
// 同时把模型输出里残留的字面量转义（\n \r\n \t \" \uXXXX 等）还原成真实字符，
// 否则 QQ 里会原样显示 "\n" 而不是换行。
// 代码块（```...```）半保护：换行类转义照常还原（代码需要真实换行），
// \t / \" / \uXXXX 等保持原样，避免把代码内容改坏；[CQ: 一律防护。
export function escapeCqText(text) {
  const s = String(text ?? '');
  const codeBlocks = [];
  const masked = s.replace(/```[^\n]*\n?[\s\S]*?```/g, (m) => {
    codeBlocks.push(m
      .replace(/\\r\\n/gi, '\n')
      .replace(/\\r/gi, '\n')
      .replace(/\\n/gi, '\n')
      .replace(/\[CQ:/gi, '[CQ：'));
    return '\u0001';
  });
  const out = masked
    .replace(/\\r\\n/gi, '\n')
    .replace(/\\r/gi, '\n')
    .replace(/\\n/gi, '\n')
    .replace(/\\t/gi, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\[CQ:/gi, '[CQ：');
  // 恢复代码块（已还原换行、保留其余转义、[CQ: 已防护）
  return out.replace(/\u0001/g, () => codeBlocks.shift() || '');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
export function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

/* ── 出站正文形态治理（2026-09-20 实测）──────────────────────────────────────────
 * 两条规矩，都作用在"模型写的正文"上：
 *   ① 正文不许是"被序列化的工具参数数组"—— 那是容器，不是人话（桥侧真拦，见下）；
 *   ② 正文里不许显式写换行（代码、诗歌/诗词除外）、颜文字只在人设要求时发且短句内联/
 *      长句单独一条 —— 这两条只写在系统提示词里（preset [TOOLS] 2b / 2c），桥不做正则清洗：
 *      2026-09-20 定稿"换行不必正则"，而"人设到底要不要颜文字"桥根本猜不出来，
 *      猜错就是把脸糊在别人的正式话题后面。
 * 入口：onebotSend（所有模型正文的唯一出口）+ POST /api/social/send-message（数组还原/拒发）。
 */

// 引号类字符（半角 + 全角 + 弯引号）：容错切分"模型手写数组"时用
const QUOTE_CLASS = '"\u201c\u201d\u2018\u2019\'';
const QUOTE_ANY_RE = new RegExp(`[${QUOTE_CLASS}]`, 'g');
const QUOTE_LEAD_RE = new RegExp(`^[${QUOTE_CLASS}]`);
const QUOTE_TAIL_RE = new RegExp(`[${QUOTE_CLASS}]$`);
const QUOTE_ONLY_RE = new RegExp(`^[${QUOTE_CLASS}\\s]+$`);

/** 整条正文是不是被序列化的数组/对象？是则返回方括号内的原文，否则 null */
function arrayPayloadInner(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 2000 || /[\r\n]/.test(t)) return null;   // 多行 = 代码/排版，不掺和
  if (t.includes('```')) return null;                           // 明确包在代码块里 = 内容，不是参数
  if (t.startsWith('[') && t.endsWith(']')) return t.slice(1, -1);
  const obj = /^\{[\s\S]*?"(?:messages|message|msg|text)"\s*:\s*(\[[\s\S]*\])\s*[,}]?[\s\S]*\}$/.exec(t);
  return obj ? obj[1].slice(1, -1) : null;
}

function stripWrapQuotes(s) {
  let t = String(s ?? '').trim();
  /* 只剥"外面那层包裹引号"，判据是引号个数为奇数 —— 因为切的时机在 `", "` 上，
   * 现场原文（引号嵌套）切出来常常是已经配平的：
   *   `"比如"谬友圈活跃19点到23点""` → `比如"谬友圈活跃19点到23点"`（2 个引号 = 内容自身的）
   * 而首尾那两条是落单的：
   *   `"直接跟我说就行`（1 个）、`我帮你设 ᗜ ‸ ᗜ"`（1 个）→ 要剥。
   * 剥两层会把内容里的引号也削掉，所以这里只剥一次、且只在落单时剥。 */
  const quotes = (t.match(QUOTE_ANY_RE) || []).length;
  if (quotes % 2 === 1) {
    if (QUOTE_LEAD_RE.test(t)) t = t.slice(1).trim();
    else if (QUOTE_TAIL_RE.test(t)) t = t.slice(0, -1).trim();
  }
  return QUOTE_ONLY_RE.test(t) ? '' : t;   // `""` / `"` 这种只剩引号的不算一条气泡
}

/**
 * 把"被序列化成一个字符串的气泡数组"还原成多条气泡。
 * 现场形态（2026-09-20 实测；引号嵌套导致 JSON.parse 必然失败，
 * 旧代码于是把整串当"一条消息"原样发进 QQ）：
 *   ["直接跟我说就行", "比如"谬友圈活跃19点到23点"", "我帮你设 ᗜ ‸ ᗜ"]
 * @returns {string[]|null} null = 不是这个形状；数组 = 还原出的气泡
 */
export function splitSerializedBubbles(text) {
  const inner = arrayPayloadInner(text);
  if (inner === null) return null;
  const t = String(text ?? '').trim();
  try {
    let parsed = JSON.parse(t);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const k of ['messages', 'message', 'msg', 'text']) {
        if (Array.isArray(parsed[k])) { parsed = parsed[k]; break; }
      }
    }
    if (Array.isArray(parsed) && parsed.length) {
      const items = parsed.map((x) => String(x ?? '').trim()).filter(Boolean);
      if (items.length) return items;
    }
  } catch { /* 嵌套引号 → 走下面的容错切分 */ }
  const parts = inner
    .split(new RegExp(`[${QUOTE_CLASS}]\\s*,\\s*[${QUOTE_CLASS}]`))
    .map(stripWrapQuotes)
    .filter(Boolean);
  return parts.length >= 2 ? parts : null;
}

/** 正文是不是"被序列化的工具参数数组"形状？（真数组走不到这里，它本来就是数组） */
export function looksLikeSerializedBubbleArray(text) {
  return splitSerializedBubbles(text) !== null;
}
