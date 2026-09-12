// 敏感信息脱敏工具
// 注意：KNOWN_AGENT_TOKENS 是跨模块共享的可变集 —— main 侧通过 import 活绑定 add/delete，
// 与本文件内 redactSensitiveText 读写的是同一实例，行为与迁移前完全一致。
import { SENSITIVE_RE } from '../sensitive.js';
// 已知的default agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
export const KNOWN_AGENT_TOKENS = new Set();

// 学习会话专用令牌集合（见 core/learning-token.js）：**故意与 KNOWN_AGENT_TOKENS 分开**。
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
//      所以这里**必须同时认方括号形态**，否则模型把令牌抄进 QQ 消息时不再被拦。
// “群号 / QQ号 / 账号 / 手机号”等日常称呼标签刻意不在标签表内 → 不误伤。
const TOKEN_LABEL_SRC = '(?:\\u3010?\\s*(?:会话)?令牌\\s*\\u3011?|\\[\\s*(?:会话|session\\s*)?token\\s*\\]|x-agent-token|sessionToken|session[\\s-]?token|access[\\s-]?token|agent[\\s-]?token|api[\\s-]?key|token|密钥|口令)';
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
