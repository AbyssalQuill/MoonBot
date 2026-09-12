// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SENSITIVE_RE } from './sensitive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 鲸鱼娘同人表情资源根：优先项目 meme/ 目录（随项目分发，已从服务器打包集成，分类在 meme/whale-fanart-001/memes/），
// 再退到项目 .runtime / 项目 meme-packs / 用户主目录 .dsh（服务器旧形态），全部运行时探测，禁止写死。
//
// 【2026-09-13 修「表情包图库搜索失败」】现网 <安装目录>\resources\runtime 与所有安装包 payload
// 都漏装了 meme/ 表情包 → MEME_ROOT 解析为 null → 工具直接回"本机没装鲸鱼娘同人表情库"，
// 而且是**静默降级**（只在被调用时才暴露）。现在：
//   1) 候选表补上隔离 DSH home / 桌面端 DSH home 下的 meme-packs 与 plugins 形态；
//   2) 启动时一个都找不到就必打**一行 stderr**，把尝试过的每条路径都列出来；
//   3) 运行期补装（sync-to-live.ps1 拷进 runtime）后无需重启桥即自愈。
const MEME_PACK_ID = 'whale-fanart-001';

/** DSH home 候选（与 core/tunables.js::resolveIsolatedDshHome / lib/dsh-side.js 同源，只读不改） */
function dshHomeCandidates() {
  const out = [];
  const add = (v) => { const s = String(v || '').trim(); if (s && !out.includes(s)) out.push(s); };
  add(process.env.QQB_DSH_HOME);
  add(process.env.DSH_ISOLATED_HOME);
  add(process.env.DSH_HOME);
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) {
    add(path.join(home, '.dsh'));
    // 管理器持久化配置里的隔离 home（读不到就跳过，不影响其它候选）
    try {
      const mgr = path.join(home, '.qq-bridge-manager', 'config.json');
      if (fs.existsSync(mgr)) {
        const iso = JSON.parse(fs.readFileSync(mgr, 'utf8').replace(/^\uFEFF/, ''))?.instances?.dshIsolated?.isolatedHome;
        if (iso) add(path.resolve(String(iso)));
      }
    } catch { /* 忽略：管理器配置损坏/被占用都不该让表情工具不可用 */ }
    add(path.join(home, '.qq-bridge-manager', 'dsh-isolated-home-official'));
    add(path.join(home, '.qq-bridge-manager', 'dsh-isolated-home'));
  }
  if (process.env.APPDATA) add(path.join(process.env.APPDATA, 'DeepSeek Harness', 'dsh-home'));
  return out;
}

/** 全部候选路径（顺序即优先级）；解析与启动日志共用同一张表，日志里列的就是真正试过的那些 */
function memeCandidates() {
  const list = [];
  const add = (p) => { if (p && !list.includes(p)) list.push(p); };
  const explicit = String(process.env.QQB_MEME_ROOT || '').trim();
  // 显式覆盖：可指 pack 本身，也可指 pack 的父目录
  if (explicit) { add(explicit); add(path.join(explicit, MEME_PACK_ID)); }
  // ROOT = qq-bridge；项目根 meme = ROOT/../meme（setup 分发后与 qq-bridge 平级的 meme/）
  add(path.join(ROOT, '..', 'meme', MEME_PACK_ID));                        // 项目根 meme/（随 setup 分发，默认）
  add(path.join(ROOT, '..', '.runtime', 'meme-packs', MEME_PACK_ID));
  // 【2026-09-13 补】"从本机复刻到服务器"那条路把表情包放在 <源机 qq-bridge 的父目录>/dsh-meme ——
  // 目标机上就是 /root/dsh-meme/<pack>。原来候选表里没有这一条，克隆过去的服务器会重演
  // "表情包图库搜索失败"。这里补上两种形态（与部署脚本 buildLocalStagePlan 的 dsh-meme 目录一致）。
  add(path.join(ROOT, '..', 'dsh-meme', MEME_PACK_ID));
  add(path.join(ROOT, 'dsh-meme', MEME_PACK_ID));
  add(path.join(ROOT, 'meme', MEME_PACK_ID));
  add(path.join(ROOT, '.runtime', 'meme-packs', MEME_PACK_ID));
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) add(path.join(home, '.dsh', 'meme-packs', MEME_PACK_ID));
  add('/root/.dsh/meme-packs/' + MEME_PACK_ID);                            // 服务器（Linux）旧形态
  for (const h of dshHomeCandidates()) {
    add(path.join(h, 'meme-packs', MEME_PACK_ID));                          // DSH home 形态：<home>/meme-packs/<pack>
    // home 内再嵌一层 .dsh（桌面端旧形态）；home 本身就叫 .dsh 时不必再加一遍
    if (!/\.dsh$/i.test(h)) add(path.join(h, '.dsh', 'meme-packs', MEME_PACK_ID));
    add(path.join(h, 'plugins', MEME_PACK_ID));                             // 作为 DSH 插件/pack 安装的形态
    add(path.join(h, 'plugins', 'meme-packs', MEME_PACK_ID));
  }
  return list;
}

const MEME_CANDIDATES = memeCandidates();

/** index.db 必须是**非空文件**才算一份可用的 pack（半截拷贝不算） */
function hasMemePack(dir) {
  try { const st = fs.statSync(path.join(dir, 'index.db')); return st.isFile() && st.size > 0; } catch { return false; }
}

function resolveMemeRoot() {
  for (const c of MEME_CANDIDATES) { if (hasMemePack(c)) return c; }
  return null;
}

let memeRootCache = resolveMemeRoot();
if (memeRootCache) {
  console.error(`[mcp-napcat-safe] 鲸鱼娘同人表情库已加载：${memeRootCache}`);
} else {
  console.error(`[mcp-napcat-safe] 未找到鲸鱼娘同人表情库（${MEME_PACK_ID}）：qq_whale_meme_search / qq_send_whale_meme 将不可用。已尝试 ${MEME_CANDIDATES.length} 条路径：${MEME_CANDIDATES.join(' | ')}`);
}

/** 取 pack 根：启动时没找到会重新探测，运行期补装后无需重启桥 */
function getMemeRoot() {
  if (!memeRootCache) memeRootCache = resolveMemeRoot();
  return memeRootCache;
}
const memeMissingHint = '本机没装鲸鱼娘同人表情库（meme-packs），这个工具不可用。想发图可以试试 qq_send_message 带本地图片路径，或直接发文字。';

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = loadConfig();

function getConfig() {
  return loadConfig();
}

function getAccess() {
  const c = getConfig();
  return {
    allowGroups: (c.allow?.groups ?? []).map(String),
    allowPrivate: (c.allow?.private ?? []).map(String),
    denyGroups: (c.deny?.groups ?? []).map(String),
    denyPrivate: (c.deny?.private ?? []).map(String),
    allowAllWhenEmpty: c.allowAllWhenEmpty === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.napcat?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.napcat?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
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

// 构造可选的“引用/回复”消息段：
// - 传了 replyToMessageId 时，在文本前追加 reply 段，让 QQ 显示“引用了某条消息”；
// - 使用结构化消息段而不是 CQ 码，避免注入；
// - replyToMessageId 必须是非零整数（字符串数字也接受；QQ 消息 id 可能为负数）。
function messageSegments(message, replyToMessageId) {
  const segments = [];
  const replyId = replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== ''
    ? String(replyToMessageId).trim()
    : null;
  if (replyId !== null) {
    if (!/^-?[1-9]\d*$/.test(replyId)) {
      throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
    }
    segments.push({ type: 'reply', data: { id: replyId } });
  }
  segments.push({ type: 'text', data: { text: escapeCqText(String(message ?? '')) } });
  return segments;
}

async function onebot(action, params = {}) {
  const { httpUrl, token } = getOneBotConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 napcat.httpUrl 是否为 OneBot HTTP API 地址' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// 桥接控制台/内部 Agent API 访问：default模式的状态工具都通过这里读写桥接内存态。
function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}
function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
  try {
    const c = getConfig();
    if (c.consoleToken) return String(c.consoleToken);
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const { timeoutMs: _omit, ...rest } = init;
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(rest.headers ?? {})
  };
  const res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    throw new Error(body?.error || `桥接 API HTTP ${res.status}`);
  }
  return body;
}

async function authorizeRead(key, token) {
  await agentApi('/api/authorize/read', { method: 'POST', body: JSON.stringify({ key, token: token || undefined }) });
}

const server = new McpServer({ name: 'napcat-safe', version: '0.1.0' });

// ── 工具 schema 精简（2026-09-12）：token 账单上最大的一刀 ────────────────────────────
// 实测（QQ 主会话的 request/header）：tools **72,692 字符 ≈ 22.7k tokens**、system 13.1k 字符 ≈ 3.3k，
// 单次请求合计 ≈ 26k tokens —— 也就是说**每一分钱里 87% 是工具 JSON schema**，
// 而且**每一步都会把这整包重发一次**（靠前缀缓存按缓存读计价，占账单约 61%）。
// 所以"少注册一个用不到的工具"比"把提示词写短几个字"重要两个数量级。
//
// ⚠️ 一个必须记住的事实：`config.json` 里的 `social.tools.*` 开关**根本省不了 schema**。
//    console-server.js 的 `ToolEnabled()` 只在**调用时**返回 403（"工具未启用"），
//    工具描述照样每次全量下发。要真的省，只能**根本不注册** —— 就是这里做的。
//    （交接文档 §4.7b.3 曾写"关掉 = schema 整段消失"，那是错的；本文件是更正。）
//
// 开关语义（可一键回退）：
//   `social.slimTools.enabled === true` → 按名单精简：
//        · `deny` 里的工具 **不注册**（黑名单；名单以外的照常注册 → 将来新增工具默认可见，不会"忘了加白名单"）；
//        · `allow` 非空时改成**只注册 allow 里的**（白名单，最省，但新增工具要手动加）。
//   未配置 / enabled 不为 true → **全部注册**，行为与改动之前**完全一致**。
// 改动这份名单只需要重启隔离 DSH（DSH 启动时向 MCP server 取一次工具表），不用改别的地方。
// 名单里的工具名**允许带或不带 MCP server 前缀**（`mcp__napcat__qq_x` 与 `qq_x` 等价）。
// 踩过的坑：管理端「出厂默认名单」写的是**带前缀**的全名，而这里注册用的是裸名 →
// deny 名单一条都匹配不上 → 实际裁剪 0 个、"省 schema" 静默失效（实测：77 个工具一个没少）。
// 现在两边都归一化，谁写都能生效；`qq_status` 用裸 server.tool 注册，本来就不参与裁剪。
const bareToolName = (n) => String(n).replace(/^mcp__[A-Za-z0-9_-]+__/, '');
const toNameSet = (arr) => new Set((Array.isArray(arr) ? arr : []).map(bareToolName));
const slimTools = getConfig().social?.slimTools;
const SLIM_ON = !!slimTools && slimTools.enabled === true;
const SLIM_ALLOW = (SLIM_ON && Array.isArray(slimTools.allow) && slimTools.allow.length)
  ? toNameSet(slimTools.allow)
  : null;
const SLIM_DENY = (SLIM_ON && Array.isArray(slimTools.deny))
  ? toNameSet(slimTools.deny)
  : null;
if (SLIM_ON && (SLIM_ALLOW || SLIM_DENY)) {
  // stdout 是 MCP 的协议通道，日志一律走 stderr
  console.error(`[napcat-safe] 精简工具集已启用：${SLIM_ALLOW ? `白名单 ${SLIM_ALLOW.size} 个` : `黑名单 ${SLIM_DENY ? SLIM_DENY.size : 0} 个`}（social.slimTools）`);
}

/** 注册工具；精简模式下被排除的**直接不注册** —— 它的 JSON schema 从此不出现在任何一次请求里。 */
function registerTool(name, ...rest) {
  const bare = bareToolName(name);
  if (SLIM_ALLOW && !SLIM_ALLOW.has(bare)) return;
  if (!SLIM_ALLOW && SLIM_DENY && SLIM_DENY.has(bare)) return;
  return server.tool(name, ...rest);
}

server.tool(
  'qq_status',
  'Query the QQ bot\'s login status and account info (read-only).',
  {},
  async () => {
    try {
      const login = await onebot('get_login_info');
      let status = {};
      try { status = await onebot('get_status'); } catch {}
      return { content: [{ type: 'text', text: JSON.stringify({ ...login, online: status.online, good: status.good }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_list_groups',
  'List all QQ groups the bot is in (read-only): group IDs and names.',
  {},
  async () => {
    // 旧只读工具没有 agent token；default 模式下通过桥接 /api/status 直接拒绝，
    // 避免绕过default模式的令牌隔离。
    try {
      const status = await agentApi('/api/status');
      if (status?.mode === 'default') {
        return { content: [{ type: 'text', text: 'Legacy read-only tools are unavailable in default mode; use the session-token tools instead.' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝执行：${error?.message ?? error}` }], isError: true };
    }
    try {
      const a = getAccess();
      const data = await onebot('get_group_list');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
          .filter((g) => isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllWhenEmpty))
          .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_get_group_members',
  'List all members of a group (read-only): QQ ID, nickname, group card, role (owner/admin/member). In default mode key and session token are required.',
  {
    key: z.string().describe('Session key: group:ID'),
    token: z.string().describe('Session token (from wake prompt)'),
    groupId: z.union([z.number(), z.string()]).optional().describe('Group id (optional; defaults to key group)')
  },
  async ({ key, token, groupId }) => {
    try {
      const q = new URLSearchParams({ key });
      if (groupId != null) q.set('groupId', String(groupId));
      const data = await agentApi(`/api/social/group-members?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_get_group_owner',
  'Return a group owner (role=owner) and admins (role=admin) with QQ IDs and nicknames/cards (read-only); do not guess. Default mode needs key and token.',
  {
    key: z.string().describe('Session key: group:ID'),
    token: z.string().describe('Session token (from wake prompt)'),
    groupId: z.union([z.number(), z.string()]).optional().describe('Group id (optional; defaults to key group)')
  },
  async ({ key, token, groupId }) => {
    try {
      const q = new URLSearchParams({ key });
      if (groupId != null) q.set('groupId', String(groupId));
      const data = await agentApi(`/api/social/group-members?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: data.ok, group_id: data.group_id, member_count: data.member_count, owner: data.owner, admins: data.admins }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询群主失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_get_group_history',
  'Get recent message history of a group (read-only); optional messageSeq fetches messages before that seq. Needs NapCat get_group_msg_history.',
  { groupId: z.union([z.number(), z.string()]).describe('Group id'), messageSeq: z.number().optional().describe('Starting message seq (optional)') },
  async ({ groupId, messageSeq }) => {
    const g = String(groupId);
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中。白名单：${a.allowGroups.join(', ') || '（空）'}` }], isError: true };
    }
    try { await authorizeRead(`group:${g}`); } catch (error) {
      return { content: [{ type: 'text', text: `拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    try {
      const params = { group_id: Number(g) };
      if (messageSeq !== undefined) params.message_seq = messageSeq;
      const data = await onebot('get_group_msg_history', params);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_send_group_message',
  'Send one plain-text message to a group. Quote via replyToMessageId (non-zero int, may be negative; from qq_get_recent_messages / qq_get_message_detail). Default mode works but prefer qq_send_message; token required or the call is rejected. Do not output sent reports. Group must be whitelisted (config.json allow.groups) or rejected.',
  {
    groupId: z.union([z.number(), z.string()]).describe('Group id (must be whitelisted)'),
    message: z.string().describe('Plain-text message; no Markdown or CQ codes'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('Message id to quote/reply to (non-zero int, may be negative, optional)'),
    token: z.string().optional().describe('Session token (required in default mode)')
  },
  async ({ groupId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/group', {
        method: 'POST',
        body: JSON.stringify({ groupId: String(groupId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_reply',
  'Reply quoting an earlier message (group or private). replyToMessageId = the quoted id (non-zero int, may be negative; query it first). Quote only when answering one specific earlier message or when several lines answer different people - not when the context is clear, never the same message twice, and use the latest relevant one. Default mode needs the token; the session must be whitelisted. Prefer key (group:<gid> / private:<qq>); legacy groupId still works for groups.',
  {
    key: z.string().optional().describe('Session key: group:ID or private:QQ (recommended; works for group and private)'),
    groupId: z.union([z.number(), z.string()]).optional().describe('Legacy param: group id (still accepted; prefer key)'),
    replyToMessageId: z.union([z.number(), z.string()]).describe('Message id being quoted/replied to (non-zero int, may be negative)'),
    message: z.string().describe('Text to send; plain text, no Markdown or CQ codes'),
    token: z.string().optional().describe('Session token (required in default mode)')
  },
  async ({ key, groupId, replyToMessageId, message, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      // key 优先；模型偶尔用 groupId 老参数 → 转成 group:群号。
      const targetKey = (key && String(key).trim())
        ? String(key).trim()
        : (groupId !== undefined && groupId !== null ? `group:${String(groupId)}` : '');
      if (!targetKey) throw new Error('必须传 key（group:群号 或 private:QQ号）或 groupId');
      const data = await agentApi('/api/social/send-message', {
        method: 'POST',
        body: JSON.stringify({ key: targetKey, messages: cleanMessage, replyToMessageId, token: token || undefined }),
        headers: { 'x-agent-token': token || undefined },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_send_private_message',
  'Send a private message to a QQ friend. With replyToMessageId it is sent as a QQ quote/reply (quoted message + text); that id must be a non-zero integer (QQ ids can be negative), check qq_get_message_detail first. Default mode works but prefer qq_send_message; token required or rejected. Do not output sent reports. Friend must be whitelisted (config.json allow.private) or rejected.',
  {
    userId: z.union([z.number(), z.string()]).describe('Friend QQ id (must be whitelisted)'),
    message: z.string().describe('Plain-text message; no Markdown or CQ codes'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('Message id to quote/reply to (non-zero int, may be negative, optional)'),
    token: z.string().optional().describe('Session token (required in default mode)')
  },
  async ({ userId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/private', {
        method: 'POST',
        body: JSON.stringify({ userId: String(userId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── default模式（default）工具 ─────────────────────────────────────────
registerTool(
  'qq_get_prompt',
  'View the current default-mode simulation prompt (read-only): role, recommended values, available tools, wake config.',
  { key: z.string().describe('Session key: group:ID or private:QQ'), token: z.string().describe('Session token (from wake prompt)') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/social/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_get_unread_messages',
  'View unread messages of a session (read-only; does not auto-mark them read).',
  { key: z.string().describe('Session key: group:ID or private:QQ'), token: z.string().describe('Session token (from wake prompt)'), limit: z.number().optional().describe('Max results, default 30, max 100') },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/social/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_get_recent_messages',
  'View recent messages of a session (read-only); offset widens the range to earlier messages.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token (from wake prompt)'),
    limit: z.number().optional().describe('Max results, default 20, max 100'),
    offset: z.number().optional().describe('Skip the newest N messages to page back further; default 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/social/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_social_state',
  'View the default-mode simulation state of a session (read-only): WakeConfig, unread count, last wake reason, last message time.',
  { key: z.string().describe('Session key: group:ID or private:QQ'), token: z.string().describe('Session token (from wake prompt)') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/social/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_global_overview',
  'Overview of activity in all sessions (read-only): per session key, unread count, latest message (sender, summary, time), last AI message time, wake mode. Use for cross-session awareness, e.g. when asked what other sessions chat about. Default mode requires the current session token.',
  { token: z.string().describe('Session token (from wake prompt)') },
  async ({ token }) => {
    try {
      const data = await agentApi('/api/social/global-overview', { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取全局概览失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_schedule_message',
  'Schedule a one-time or repeating message: at the trigger time it auto-sends message to the targetKey session. at = ISO time string (e.g. 2026-09-02T08:00:00+08:00) or ms timestamp, or delayMs = ms from now; repeatMs > 0 repeats every repeatMs ms. Use for remind me at 8pm / message someone tomorrow / remind me every weekend; targetKey may be another session (the current session token works). Tell the user it is set; list and cancel via qq_schedule_list / qq_schedule_cancel.',
  {
    token: z.string().describe('Session token (from wake prompt)'),
    targetKey: z.string().optional().describe('Session key to send to (defaults to current session)'),
    message: z.string().describe('Message content to send when scheduled'),
    at: z.string().optional().describe('Trigger time: ISO string (e.g. 2026-09-02T08:00:00+08:00) or ms/s timestamp'),
    delayMs: z.number().optional().describe('Alternatively, trigger after this many ms from now (at takes precedence)'),
    repeatMs: z.number().optional().describe('Repeat interval in ms; 0 or omitted = one-shot'),
    sourceKey: z.string().optional().describe('Initiating session key (derived from token by default; usually omit)')
  },
  async ({ token, targetKey, message, at, delayMs, repeatMs, sourceKey }) => {
    try {
      const body = { targetKey: targetKey || '', message, repeatMs: repeatMs || 0, sourceKey: sourceKey || '' };
      if (at) body.at = at;
      else if (delayMs) body.delayMs = delayMs;
      const data = await agentApi('/api/social/schedule', { method: 'POST', body: JSON.stringify(body), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `安排定时消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_schedule_list',
  'List scheduled message tasks (read-only).',
  { token: z.string().describe('Session token (from wake prompt)') },
  async ({ token }) => {
    try {
      const data = await agentApi('/api/social/schedule-list', { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询定时任务失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_schedule_cancel',
  'Cancel a scheduled message task. id is the task id from qq_schedule_list.',
  { token: z.string().describe('Session token (from wake prompt)'), id: z.string().describe('Task id to cancel') },
  async ({ token, id }) => {
    try {
      const data = await agentApi('/api/social/schedule-cancel', { method: 'POST', body: JSON.stringify({ id }), headers: { 'x-agent-token': token } });
      // 后端固定返回 { ok:true, removed:<bool> }（console-server: /api/social/schedule-cancel）：
      // removed=false 表示库里没有这个 id 的任务、什么都没取消。旧判断写成
      // `data.ok === true || data.removed === true || ...`，第一个条件恒真 → 取消不存在的任务
      // 也会回报"已取消"，模型以为定时任务已撤销、实际到点照样发。
      const removedOk = data ? (data.removed === undefined ? data.ok === true : data.removed === true) : false;
      if (removedOk) {
        return { content: [{ type: 'text', text: `已取消定时任务 ${id}` }] };
      }
      if (data && data.removed === false) {
        return { content: [{ type: 'text', text: `取消失败：定时任务 ${id} 不存在或已执行，未取消任何任务。可用 qq_schedule_list 查看当前有效 id。` }], isError: true };
      }
      return { content: [{ type: 'text', text: `取消失败：${data?.error || JSON.stringify(data)}` }], isError: true };
    } catch (error) {
      return { content: [{ type: 'text', text: `取消定时任务失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_get_activity_hours',
  'View a session active-hours config (read-only): active windows (e.g. 12:00-14:00, 18:00-next-day 01:00) and whether Beijing time is now inside one. Use when the owner asks which groups are active when.',
  { key: z.string().describe('Session key to query (group:ID or private:QQ)'), token: z.string().describe('Session token (from wake prompt)') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/social/activity-hours?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询活跃时段失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_set_activity_hours',
  'Set, modify or clear a session active hours; parse the owner natural-language request (e.g. group X active from H to H, silent otherwise) into windows. Takes effect immediately and persists; do not just say got it. Each windows item {start,end} uses 24-hour HH:MM; end < start spans midnight (start 18:00 end 01:00 = 18:00 next day 01:00). windows:[] clears the limits.',
  {
    key: z.string().describe('Session key to configure (group:ID or private:QQ)'),
    token: z.string().describe('Session token (from wake prompt)'),
    windows: z.array(z.object({ start: z.string().describe('Start time HH:MM, e.g. 18:00'), end: z.string().describe('End time HH:MM, e.g. 23:00; less than start = spans midnight') })).describe('Active-window list; empty array = clear hour restrictions')
  },
  async ({ key, token, windows }) => {
    try {
      const data = await agentApi('/api/social/activity-hours', { method: 'POST', body: JSON.stringify({ key, windows: windows || [] }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设定活跃时段失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_get_system_config',
  'Verbal-adjustable system config (read-only): each item key, value and meaning (proactive on/off and interval, proactive probability, reply-check interval, model provider/main/vision model, reasoning tier). Check first when the owner asks how often you are proactive, which model, or your config, and before any change.',
  { token: z.string().describe('Session token (from wake prompt)') },
  async ({ token }) => {
    try {
      const data = await agentApi('/api/social/tunables', { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询系统配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_set_system_config',
  'Modify system run config (owner private chat only). Keys: proactiveEnabled; privateProactiveMin / privateProactiveMax (private proactive interval, e.g. 120min or ms) and privateProbability (0 = never proactive in private); groupProactiveMin / groupProactiveMax and groupProbability; idleThresholdMs (dead-air threshold); replyCheckMs (reply-check interval); modelProvider (default xiaomi-token-plan-cn = Xiaomi MiMo), model (e.g. mimo-v2.5, mimo-v2-pro), reasoningEffort (auto/low/medium/high), visionModel (empty = follows the main model) - model keys auto-sync, isolated from the DSH default model. value = number or duration string like 30min, 2h. Tell the owner the applied value; non-owner sessions are rejected.',
  {
    key: z.string().describe('Config key: privateProbability / privateProactiveMin / proactiveEnabled etc. (see qq_get_system_config)'),
    value: z.union([z.string(), z.number(), z.boolean()]).describe('New value: probability/interval etc.; intervals accept ms numbers or 30min, 2h, 30分钟'),
    token: z.string().describe('Session token (from wake prompt)')
  },
  async ({ key, value, token }) => {
    try {
      const data = await agentApi('/api/social/tunables', { method: 'POST', body: JSON.stringify({ key, value }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `修改系统配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_withdraw_message',
  'Withdraw a message you (the bot) sent (misspoke or wrong target). messageId comes from (id:xxx) in the wake prompt or qq_get_my_recent_messages. Only your own messages can be withdrawn; it then disappears from that session. Do not over-explain, smooth it over naturally.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    messageId: z.union([z.number(), z.string()]).describe('Id of your own message to withdraw (QQ message ids may be negative)'),
    token: z.string().describe('Session token (from wake prompt)')
  },
  async ({ key, messageId, token }) => {
    try {
      const data = await agentApi('/api/social/withdraw', { method: 'POST', body: JSON.stringify({ key, messageId: String(messageId) }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `撤回失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_mark_read',
  'Mark the session unread messages as read (use after reading but not replying, to avoid repeated unread prompts). When winding down, judge instead of idling: if the other side said goodnight, the topic is over, or you said all needed, mark_read and wind down to sleep; only wait briefly to confirm they finished (qq_wait_for_messages, 30s is enough).',
  { key: z.string().describe('Session key: group:ID or private:QQ'), token: z.string().describe('Session token (from the wake prompt)') },
  async ({ key, token }) => {
    try {
      const data = await agentApi('/api/social/mark-read', { method: 'POST', body: JSON.stringify({ key }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_deepsleep',
  'Global master switch for GROUP silence: enabled=true silences all group chats - messages are stored but never woken on, answered or collected (biggest token saver) - while private chat keeps working normally; enabled=false restores all groups. /start always revives the bot, run by the bridge without the model. Use true for deep sleep / silence all groups / master switch; false for wake up / restore / unsilence.',
  {
    enabled: z.boolean().describe('true silences every group chat (private chat unaffected); false restores all groups'),
    token: z.string().describe('Session token (from the wake prompt). Required: admin-level switch, rejected unless it carries the current session token.')
  },
  async ({ enabled, token }) => {
    try {
      const data = await agentApi('/api/social/deepsleep', { method: 'POST', body: JSON.stringify({ enabled }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置失败：${error?.message ?? String(error)}` }], isError: true };
    }
  }
);

registerTool(
  'qq_set_wake_config',
  'Set this session wake config: mode diving/active plus triggers (@, name, keyword, question, probability, anyMessage, triggers.speakerIds = wake when a listed member speaks, triggers.poke = any poke in the group, yours or others). When diving do not idle: goodnight / topic over / said enough -> set config, then confirm briefly with qq_wait_for_messages (within 30 s).',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token (from the wake prompt)'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving = quiet; active = active (anyMessage enabled)'),
      infinite: z.boolean().optional().describe('true = indefinite, wake only when a condition hits; false = finite'),
      sleepMs: z.number().optional().describe('Finite-diving duration in ms (from now)'),
      sleepUntil: z.string().optional().describe('Finite-diving end time as ISO string; takes precedence over sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('Wake when at-mentioned or quoted'),
        nameMention: z.boolean().optional().describe('Wake when your name/nickname is called'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('QQ ids to watch: wake when any of them speaks (optional, max 20; empty = off; not for private chat, the bridge clears it). Ids come from the userId/user_id field of qq_get_active_members or qq_get_message_detail.'),
        keywords: z.array(z.string()).optional().describe('Wake when any keyword appears'),
        question: z.boolean().optional().describe('Wake when directly questioned or called out'),
        poke: z.boolean().optional().describe('Wake on a poke (groups: any poke, incl. poking others; private: poking you)'),
        anyMessage: z.boolean().optional().describe('Wake on any new message (active mode)'),
        probability: z.number().optional().describe('Randomly wake on ordinary messages with this probability (0~1)')
      }).optional(),
      batchWindowMs: z.number().optional().describe('Merge window for a burst of messages to wake once (ms, >=1000)')
    }).describe('Wake config to set; omitted fields keep current values')
  },
  async ({ key, token, config }) => {
    try {
      const data = await agentApi('/api/social/wake-config', { method: 'POST', body: JSON.stringify({ key, config }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_send_burst',
  'Send several messages to a QQ group in one burst (default mode only), at randomized human-like intervals. No quoting - use qq_reply. Each array element is one QQ message: for several messages use separate elements, and never pad short Chinese phrases with spaces or split one sentence across elements; each must read complete.',
  {
    groupId: z.union([z.number(), z.string()]).describe('Group id (must be whitelisted)'),
    token: z.string().describe('Session token (from the wake prompt)'),
    messages: z.union([z.array(z.string()).min(1), z.string()]).describe('Messages to send, each plain text; a JSON array string is also accepted')
  },
  async ({ groupId, token, messages }) => {
    try {
      const key = `group:${groupId}`;
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/social/send-burst', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分条发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_send_message',
  'Send messages: string = one; array = several (each complete, never split a sentence). replyToMessageId only to quote one specific earlier message - use the latest relevant one, never twice, skip it when unambiguous. images = local image paths for text+image, image-only (messages = []) or image-first (first messages item empty, first images item = the image). Needs the token; target must be whitelisted.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token (from the wake prompt)'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).optional().describe('string = one message; array = several; empty array = images only'),
    message: z.string().optional().describe('Alias of messages (string; kept only for typos). Prefer messages.'),
    images: z.array(z.string()).optional().describe('Absolute local paths of static images (e.g. C:\\\\path\\\\xx.webp; meme/ sticker files work too), one per sent item or a single one. Never send animated GIFs by path - QQ shows a flickering static preview; find those with qq_list_stickers (search 大肥鱼 for the whale GIF set) and send via qq_send_sticker. Only static png/jpg/webp go by path.'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('Message id to quote/reply to (non-zero int, may be negative, optional)'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('QQ id to @ (group chats; needed for at-mentions). Never hand-write [CQ:at,qq=...] in the message text - it is sent verbatim as garbage. Not together with a quote; do not overuse.'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto = random (bridge default), fixed = interval, byLength = by text length'),
    gapMs: z.number().optional().describe('Interval for fixed mode (ms)'),
    gaps: z.array(z.number()).optional().describe('Per-message intervals for fixed mode (length = count - 1)')
  },
  async ({ key, token, messages, message, images, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      // 兼容模型误用 message 单数字段（schema 也有同名兼容别名）；messages 为空时回退到 message。
      if (messages === undefined || messages === null || (Array.isArray(messages) && messages.length === 0)) {
        if (typeof message === 'string' && message.trim()) messages = message;
        else if (Array.isArray(message) && message.length) messages = message;
      }
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const imgList = Array.isArray(images) ? images.map(String).filter(Boolean) : [];
      const data = await agentApi('/api/social/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, images: imgList, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.social?.tools?.sendPoke !== false) {
  registerTool(
    'qq_send_poke',
    'Send a QQ poke (group or private chat): replaces a filler line, nudges someone, answers others pokes, or occasionally pokes a chat partner - more human-like, but do not overdo it. Groups must pass targetUserId (member QQ ID from qq_get_active_members / qq_get_message_detail userId); private chat may omit it (pokes the current counterpart by default). Default mode requires the token; bridge whitelist and send-rate limits apply.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token (from the wake prompt)'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('QQ id of the member to poke (required in groups; optional in private)')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/social/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.social?.tools?.crosschat !== false) {
  registerTool(
    'qq_crosschat_send',
    'Leave a note for another QQ session (e.g. group ↔ owner private chat); the target gets it at its next wake and knows you left it. Use when something here concerns another session, when your other self there must know, when it should watch a person/topic, or to pass something to its conversation partner. The note never enters any QQ chat (that group cannot see it), only the target wake prompt - very token-cheap.',
    {
      toKey: z.string().describe('Target session key: group:ID or private:QQ (e.g. group:<群号> / private:<QQ号>)'),
      content: z.string().max(400).describe('Memo/request for the other session to read - internal note, NOT sent to any QQ chat'),
      token: z.string().describe('Current session token (from the wake prompt)')
    },
    async ({ toKey, content, token }) => {
      try {
        const data = await agentApi('/api/social/crosschat-send', {
          method: 'POST',
          body: JSON.stringify({ toKey, content }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `留言失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  registerTool(
    'qq_crosschat_inbox',
    'Check whether other sessions left you notes. They normally arrive at your wake automatically (wake prompt, cross-session notes section); use this to confirm you missed none.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token (from the wake prompt)')
    },
    async ({ key, token }) => {
      try {
        const data = await agentApi('/api/social/crosschat-inbox?key=' + encodeURIComponent(key), {
          method: 'GET',
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取留言失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

registerTool(
  'qq_wait_for_messages',
  'Wait for new messages without leaving the round; they come back as newMessages, and timeout=true means nothing arrived in the window (normal - call again). Do NOT use it to hold the round open in 主人 private chat: the bridge holds that round open by itself（回合保持）and injects messages, and a long wait blocks the round from reaching its stopping point. Groups only, for a genuine mid-sentence pause (<= 10 s). Messages received just before this call are included too.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token (from the wake prompt)'),
    timeoutMs: z.number().optional().describe('Total wait ms, default 30000, max 86400000. In 主人 private chat do NOT pass 86400000 - the bridge already holds that round, so 30000 is enough for a short confirmation.'),
    minNewMessages: z.number().optional().describe('Return early once this many new messages arrive; default 1'),
    quietMs: z.number().optional().describe('Quiet window (ms) to keep waiting after new messages arrive, to tell whether the other side is done; suggest 8000~12000; default social.wait.defaultQuietMs (8000)')
  },
  async ({ key, token, timeoutMs, minNewMessages, quietMs }) => {
    try {
      const data = await agentApi('/api/social/wait', {
        method: 'POST',
        body: JSON.stringify({ key, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        // 【2026-09-11 23:35】老写法 `Math.min(725000, …)` 把等待**硬顶在 12 分钟**，
        // 即使传 24 小时也会被截到 725000 —— 长轮询永远挂不住。放到 25 小时。
        timeoutMs: Math.min(90000000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_report_feedback',
  'Report to the console/admin any problem, confusion, or situation needing administrator intervention.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token (from the wake prompt)'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('Feedback level; default info'),
    message: z.string().describe('Feedback content')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/social/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_get_my_recent_messages',
  'View your own recent messages (read-only), to avoid repeating yourself and stay in character.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token (from the wake prompt)'),
    limit: z.number().optional().describe('Max results returned; default 10, max 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/social/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_get_message_detail',
  'View a single message full content, sender, and quote info by message_id (read-only).',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token (from the wake prompt)'),
    messageId: z.union([z.number(), z.string()]).describe('Message id to view (QQ message id may be negative)')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/social/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_get_file_content',
  'Read a file message content in a session (read-only). Supports .md / .txt / .json / .log / .csv / .js / .py / .html and .docx (Word). Call when the text shows a file marker like [文件xxx], or when a message carries files / hasFile:true; messageId = that message messageId or seq. Returns the content, truncated at 20000 characters.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token (from the wake prompt)'),
    messageId: z.union([z.number(), z.string()]).describe('messageId or seq of the message containing the file'),
    fileIndex: z.number().optional().describe('File index (when one message has multiple files); default 0')
  },
  async ({ key, token, messageId, fileIndex }) => {
    try {
      const data = await agentApi('/api/social/file-content', {
        method: 'POST',
        headers: { 'x-agent-token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, messageId: String(messageId), fileIndex: fileIndex ?? 0 }),
        timeoutMs: 120000
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取文件失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_get_active_members',
  'List the recently active members of the current session (read-only), to help judge who is in the conversation.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token (from the wake prompt)'),
    limit: z.number().optional().describe('Max members returned; default 10, max 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/social/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_memory_append',
  'Save lightweight memory: activeTopic = the ongoing topic; pendingThought = what you want to say but have not yet; memberImpression = an impression of a group member. Persist and auto-appear at later wakes and in qq_get_prompt.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token (from the wake prompt)'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('Memory category'),
    content: z.string().describe('Content: topic, something to say, or member impression tag'),
    extra: z.object({
      target: z.string().optional().describe('Member name/nickname for memberImpression'),
      participants: z.array(z.string()).optional().describe('Participants of the activeTopic'),
      pendingQuestion: z.string().optional().describe('Questions in the activeTopic you have not asked yet'),
      motivation: z.string().optional().describe('Motive of the pendingThought, e.g., curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought expiry in ms; default 2 hours')
    }).optional().describe('Extra info')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/social/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_memory_query',
  'Read-only: view this session lightweight memories: ongoing topic, thoughts you wanted to say, impressions of group members.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token (from the wake prompt)'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('Optional: view only one memory category')
  },
  async ({ key, token, category }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/social/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_memory_remove',
  'Delete one memory: for activeTopic/pendingThought pass content (the exact original text to match), for memberImpression pass target (the member name to remove).',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token (from the wake prompt)'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('Memory category'),
    content: z.string().optional().describe('Exact topic/thought text to delete; not used for memberImpression'),
    target: z.string().optional().describe('Member name whose memberImpression to delete')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/social/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_memory_clear',
  'Clear memories. Omit category to clear all; pass activeTopic, pendingThought, or memberImpression to clear only that category.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token (from the wake prompt)'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('Category to clear; omit = clear all')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/social/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_slang_query',
  'Read-only: confirmed group slang/memes/internet expressions. Returns the entries plus a formatted slang table; check here first for an unfamiliar word before searching or using it.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().min(1).describe('Session token (from the wake prompt)'),
    q: z.string().optional().describe('Optional search term; filter by term/meaning/usage/example')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/social/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_slang_submit',
  'Submit an unfamiliar slang/meme you keep seeing in groups for admin screening: it joins a candidate pool, and once confirmed by the admin it enters the slang prompt as memory you can query and use later.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token (from the wake prompt)'),
    content: z.string().describe('Unknown word/slang/meme to submit (max 50 chars)'),
    context: z.string().optional().describe('Optional: context or the message you saw it in, to help admin judge')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/social/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 图片/表情查看工具（一代/default共用） ─────────────────────────────────
if (cfg.social?.tools?.getImages !== false) {
  registerTool(
    'qq_get_message_images',
    'Fetch the images/stickers in a QQ message as actual image content the vision model can see. Call when text contains [图片], [表情], or hasMedia=true. Supports multiple images; needs the session token in default mode.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      messageId: z.union([z.number(), z.string()]).describe('Message id to view (QQ id may be negative; 2nd-gen also accepts local seq)'),
      token: z.string().optional().describe('2nd-gen session token (required under default; from the wake prompt)')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        for (const img of images) {
          if (img?.data && img?.mimeType) {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（default模式） ─────────────────────────────────────────
if (cfg.social?.sticker?.enabled !== false && cfg.social?.tools?.listStickers !== false) {
  registerTool(
    'qq_list_stickers',
    'List the QQ account collected custom stickers: emoji_id, official remark desc, local note, tags, usage count. query filters by remark/note/tag. For stickers with no remark, view the image via qq_get_sticker_image, then record its meaning via qq_sticker_note. refresh=true forces resync after adding or deleting stickers.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token (from the wake prompt)'),
      query: z.string().optional().describe('Optional search term; filter by remark/note/tag/usage'),
      count: z.number().optional().describe('Max results returned; default 48, capped by the social.sticker.maxListCount config (usually 100)'),
      refresh: z.boolean().optional().describe('Force resync stickers from QQ; default false (use cache)')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        const q = new URLSearchParams({ key });
        if (query) q.set('query', String(query));
        if (count != null) q.set('count', String(count));
        if (refresh) q.set('refresh', '1');
        const data = await agentApi(`/api/social/sticker-list?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.social?.sticker?.enabled !== false && cfg.social?.tools?.getStickerImage !== false) {
  registerTool(
    'qq_get_sticker_image',
    'Fetch a collected sticker image as actual image content for the vision model. Use when its desc/localNote from qq_list_stickers is empty, or to confirm how the sticker looks. stickerId accepts the id, md5, or url from qq_list_stickers.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token (from the wake prompt)'),
      stickerId: z.string().describe('Sticker id: emoji_id / md5 / image URL (from qq_list_stickers)')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/social/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${data?.error || '未知'}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.social?.sticker?.enabled !== false && cfg.social?.tools?.sendSticker !== false) {
  registerTool(
    'qq_send_sticker',
    'Send one collected QQ custom sticker in this session; stickerId = the id/md5/url from qq_list_stickers. One message is one sticker and cannot carry text in the same bubble - send your words first via qq_send_message/qq_reply, then the sticker. replyToMessageId/atUserId (group) allow quoting/mentioning. Occasional stickers feel natural; do not spam.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token (from the wake prompt)'),
      stickerId: z.string().describe('Sticker id: emoji_id / md5 / image URL (from qq_list_stickers)'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('Message id to quote/reply to (non-zero int, may be negative, optional)'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('Group member QQ to at-mention (optional in group chats; N/A in private chats)')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/social/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.social?.sticker?.enabled !== false && cfg.social?.tools?.collectSticker !== false) {
  registerTool(
    'qq_collect_sticker',
    'Collect a sticker/image someone sent in this session into your QQ sticker collection, optionally with a short note; messageId = the messageId or seq from qq_get_unread_messages / qq_get_recent_messages. Do not collect often - only what genuinely amuses or fits you; collected items appear in qq_list_stickers. If the result says this NapCat build does not support auto-collect (add_custom_face unavailable), stop trying, tell the other person collecting is currently unavailable, and never retry.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token (from the wake prompt)'),
      messageId: z.string().describe('messageId or seq of the message to collect (from qq_get_unread_messages / qq_get_recent_messages)'),
      remark: z.string().optional().describe('Short remark, max 20 chars, e.g., 好图偷了，兄弟')
    },
    async ({ key, token, messageId, remark }) => {
      try {
        const data = await agentApi('/api/social/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        const msg = String(error?.message ?? error ?? '');
        return { content: [{ type: 'text', text: msg.startsWith('收藏表情失败：') ? msg : `收藏表情失败：${msg}` }], isError: true };
      }
    }
  );
}

if (cfg.social?.tools?.getSelfImage !== false) {
  registerTool(
    'qq_get_self_image',
    'View your own default chibi avatar image (the DeepSeek little whale). Call when asked what you look like, to send a selfie, or what your form is; the returned image goes straight into your visual context.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token (from the wake prompt)')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/social/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${data?.error || '未知'}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: '这是你的默认 Q 版形象：' },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.social?.sticker?.enabled !== false && cfg.social?.tools?.stickerNote !== false) {
  registerTool(
    'qq_sticker_note',
    'Record your own understanding/note/tags/usage for a collected sticker to guide later sticker choices. Local memory only: it does not change the QQ account official remark. Use it to remember un-remarked stickers after seeing their images.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token (from the wake prompt)'),
      stickerId: z.string().describe('Sticker id: emoji_id / md5 / image URL (from qq_list_stickers)'),
      note: z.string().optional().describe('Your reading of the sticker meaning / best use cases; max 200 chars'),
      tags: z.array(z.string()).optional().describe('Optional tags, e.g., [嘲讽, 笑哭, 怼人]'),
      usage: z.string().optional().describe('Optional usage note; max 200 chars')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/social/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.social?.sticker?.enabled !== false && cfg.social?.tools?.setStickerRemark !== false) {
  registerTool(
    'qq_set_sticker_remark',
    'Set a collected sticker official QQ remark (desc). A write that directly changes the QQ account sticker remarks; available only when the admin allows it (social.tools.setStickerRemark=true). Generally prefer qq_sticker_note for your own understanding; do not casually change official remarks.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token (from the wake prompt)'),
      stickerId: z.string().describe('Sticker id: emoji_id / md5 / image URL (from qq_list_stickers)'),
      remark: z.string().describe('New sticker remark; max 50 chars')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/social/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（default模式） ────────────────────────────────────
if (cfg.social?.tools?.getForwardMsg !== false) {
  registerTool(
    'qq_get_forward_msg',
    'Read-only: read a merged-forward / chat-record message from the current session. Call it when the text shows [转发消息 id=...] or a message from qq_get_unread_messages / qq_get_recent_messages / qq_get_message_detail has forwardIds/hasForward true. Only ids received in this session are readable. Returns each message text, media metadata and nestedForwardIds; up to 5 images inside come back as image content for the vision model, and nested ids can be read again the same way.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token (from the wake prompt)'),
      id: z.string().describe('Forward message id (from [转发消息 id=...] in the text or the forwardIds array)')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/social/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: JSON.stringify(data, null, 2) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/social/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.social?.tools?.like !== false) {
  registerTool(
    'qq_like',
    'Like a QQ user profile page: show appreciation to a group member, acquaintance, or the owner. times = like count, default 1, max 10. Must carry the session token in default mode.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token (from the wake prompt)'),
      targetUserId: z.union([z.number(), z.string()]).describe('QQ to like'),
      times: z.number().optional().describe('Like count; default 1, max 10')
    },
    async ({ key, token, targetUserId, times }) => {
      try {
        const data = await agentApi('/api/social/like', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: String(targetUserId), times: Number(times) || 1 }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `点赞失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.social?.tools?.proactiveSend !== false) {
  registerTool(
    'qq_proactive_send',
    'Proactively send a message to a session without waiting for others to speak first. Use to initiate chat with group members or the owner, or to relay across sessions (e.g., the owner tells you in private chat to carry a message into a group). targetKey = target session key (group:群号 or private:QQ号); message = content to send.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token (from the wake prompt)'),
      targetKey: z.string().describe('Target session key (group:<groupID> or private:<QQ>)'),
      message: z.string().describe('Content to send proactively')
    },
    async ({ key, token, targetKey, message }) => {
      try {
        const data = await agentApi('/api/social/proactive-send', {
          method: 'POST',
          body: JSON.stringify({ key: targetKey, message }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `主动发送失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}


registerTool(
  'qq_whale_meme_search',
  'Search the whale-girl fan meme pack (Blue Big Fat Fish archive fan art, 163 images). query = an emotion/content description (e.g., angry, crying, sleeping); returns matching memes whose filename equals the description. Send the chosen one with qq_send_whale_meme.',
  {
    query: z.string().describe('Query: emotion/content description, e.g., 生气、哭、睡觉、开心、疑惑'),
    tag: z.string().optional().describe('Filter by category: happy/angry/sad/shy/confused/surprised/sigh/sleep/daily/love/work'),
    limit: z.number().optional().describe('Max results returned; default 8')
  },
  async ({ query, tag, limit }) => {
    try {
      const root = getMemeRoot();
      if (!root) return { content: [{ type: 'text', text: memeMissingHint }] };
      const q = String(query ?? '').trim();
      const tg = String(tag ?? '').trim().toLowerCase();
      const n = Math.min(20, Math.max(1, Number(limit) || 8));
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(root + '/index.db', { readOnly: true });
      let sql = 'SELECT file_name, tag, caption, keywords FROM memes WHERE 1=1';
      const params = [];
      if (tg) { sql += ' AND tag = ?'; params.push(tg); }
      if (q) { sql += ' AND (caption LIKE ? OR keywords LIKE ?)'; params.push('%' + q + '%', '%' + q + '%'); }
      sql += ' LIMIT ?'; params.push(n);
      const rows = db.prepare(sql).all(...params);
      db.close();
      if (!rows.length) return { content: [{ type: 'text', text: `没找到匹配的鲸鱼娘表情，试试：生气/哭/睡觉/开心/疑惑/害羞/干活/日常` }] };
      const lines = rows.map((r, i) => `${i + 1}. ${r.file_name} [${r.tag}] ${r.caption}`).join('\n');
      return { content: [{ type: 'text', text: `找到 ${rows.length} 张鲸鱼娘表情：\n${lines}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `搜索失败：${error.message}` }], isError: true };
    }
  }
);

registerTool(
  'qq_send_whale_meme',
  'Send one whale-girl fan meme to a QQ session. file = the filename returned by qq_whale_meme_search (the filename is the description note). Send the image directly with no preceding text; replyToMessageId optionally makes it a quoted reply.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token'),
    file: z.string().describe('Sticker filename (from qq_whale_meme_search), e.g., 蓝发女仆生气.webp'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('Optional: message id to quote/reply to')
  },
  async ({ key, token, file, replyToMessageId }) => {
    try {
      const root = getMemeRoot();
      if (!root) return { content: [{ type: 'text', text: memeMissingHint }] };
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(root + '/index.db', { readOnly: true });
      const row = db.prepare('SELECT path FROM memes WHERE file_name = ?').get(String(file));
      db.close();
      if (!row) return { content: [{ type: 'text', text: `找不到表情 ${file}，请先用 qq_whale_meme_search 搜索` }], isError: true };
      const filePath = root + '/' + row.path;
      if (!fs.existsSync(filePath)) return { content: [{ type: 'text', text: '图片文件不存在' }], isError: true };
      // NapCat 需读本机可见路径：先复制到本机可写临时目录再发送（服务器 Docker 曾用 /app/napcat 挂载路径，本机直接传绝对路径即可）。
      const tmpDir = path.join(ROOT, 'state', 'sticker-tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpName = `${Date.now()}-whale-${path.basename(row.path || 'meme.webp')}`;
      const tmpPath = path.join(tmpDir, tmpName);
      fs.copyFileSync(filePath, tmpPath);
      const napcatPath = tmpPath;
      const [kind, id] = key.split(':');
      const hasQuote = replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '';
      // 带引用时统一走桥的发送端点：它用 resolveReplyTarget 把「本地 seq」和「真实 QQ message id」
      // 都解析成真正可引用的 id，并顺带做限频/防重复/会话记录。此前这里直接把模型给的原始值当
      // QQ message id 塞进 reply 段 —— 模型传了本地 seq 或过期 id 时 NapCat 照常受理，但 QQ 端
      // 不显示引用框，工具却回报成功，正是用户看到的"引用失败"。
      if (hasQuote) {
        const data = await agentApi('/api/social/send-message', {
          method: 'POST',
          body: JSON.stringify({ key, messages: [], images: [filePath], replyToMessageId }),
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, file, quoted: data?.quoted ?? null, sent: data?.sent ?? null, via: 'bridge' }, null, 2) }] };
      }
      const msg = [];
      msg.push({ type: 'image', data: { file: napcatPath } });
      const params = kind === 'private' ? { user_id: Number(id), message: msg } : { group_id: Number(id), message: msg };
      const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
      // 这条直连 OneBot 的路径不经过桥的发送端点，必须先用 /api/social/check-send 校验
      // 会话令牌 + 白名单（config.json allow.groups/allow.private）——否则模型可以给任意群/私聊发图，
      // 绕过本文件开头声明的"发送类工具强制白名单"。校验不通过时 agentApi 抛错，由外层 catch 报失败。
      await agentApi('/api/social/check-send', {
        method: 'POST',
        body: JSON.stringify({ key, token, tool: kind === 'private' ? 'sendPrivate' : 'sendGroup' }),
        timeoutMs: 15000
      });
      const data = await onebot(action, params);
      const messageId = data?.data?.message_id ?? data?.message_id ?? null;
      // 登记到桥接会话：让 AI 记住自己发过这张表情、可被 qq_withdraw_message 撤回（含 (id:xxx) 展示）
      try {
        if (messageId != null && token) {
          await agentApi('/api/social/record-own-sent', {
            method: 'POST',
            body: JSON.stringify({ key, messageId: String(messageId), text: `[鲸鱼表情:${file}]`, token }),
            headers: { 'x-agent-token': token },
            timeoutMs: 10000
          });
        }
      } catch (regError) {
        // 登记失败不影响发送本身
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, file, messageId }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error.message}` }], isError: true };
    }
  }
);

registerTool(
  'qq_profile_get',
  'Read someone long-term profile by QQ number: nickname, personality, likes, dislikes, birthday, notes. Everything previously recorded about this person lives here - check it first to know or confirm something about them, so you never forget or misremember.',
  {
    uid: z.string().describe('QQ or session key (private:<QQ> / group:<groupID>)'),
    token: z.string().describe('Session token (from the wake prompt)')
  },
  async ({ uid, token }) => {
    try {
      const cleanUid = String(uid).trim().split(':').pop();
      const data = await agentApi(`/api/profile?uid=${encodeURIComponent(cleanUid)}`, { timeoutMs: 10000, headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error.message}` }], isError: true };
    }
  }
);

registerTool(
  'qq_profile_set',
  'Write/update fields in a QQ number long-term profile: name (nickname), personality, likes (hobbies), dislikes, birthday (e.g. 8月30日), notes. Save facts the owner states or you observe.',
  {
    uid: z.string().describe('QQ'),
    field: z.string().describe('Field name: name / personality / likes / dislikes / birthday / notes'),
    value: z.string().describe('Content to write'),
    token: z.string().describe('Session token (from the wake prompt)')
  },
  async ({ uid, field, value, token }) => {
    try {
      const cleanUid = String(uid).trim().split(':').pop();
      const data = await agentApi('/api/profile', { method: 'POST', body: JSON.stringify({ uid: cleanUid, field, value }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `写入失败：${error.message}` }], isError: true };
    }
  }
);

// 注：`qq_learning_submit` **故意不放在这里**。它属于学习会话的落库工具，而学习会话
// 只加载 mcp__napcat-host__ 那一组 MCP（实测：学习者调 mcp__napcat__qq_learning_submit
// 会得到 ToolNotFoundError / UNKNOWN_TOOL），放在这里学习者根本调不到；放在这边还会
// 顺手把「写人格档案」的能力交给 QQ 群聊会话，属于不该给的面。它现在的家在
// mcp-host-server.js（暴露为 mcp__napcat-host__qq_learning_submit）。

registerTool(
  'qq_blacklist',
  'Blacklist or unblacklist a QQ number: they can no longer private-message you and you stop handling their messages. Use for hostile or harassing people, or an extremely bad impression; unblacklist once they improve. ownerQQ can never be blacklisted.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token'),
    uid: z.string().describe('QQ to blacklist/unblacklist'),
    action: z.enum(['black', 'unblack']).describe('black=blacklist, unblack=unblacklist')
  },
  async ({ key, token, uid, action }) => {
    try {
      const data = await agentApi('/api/blacklist', { method: 'POST', body: JSON.stringify({ uid, action }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `操作失败：${error.message}` }], isError: true };
    }
  }
);

registerTool(
  'qq_admin_set',
  'Grant or revoke DSH admin permission - only works from the owner private chat. Use when the owner says to make X an admin or remove those rights. uid = the QQ number (from contacts or the group member list).',
  {
    key: z.string().describe('Session key; must be the owner private session key (private:<owner QQ>), else rejected'),
    token: z.string().describe('Session token (from the wake prompt)'),
    uid: z.string().describe('Target QQ number'),
    action: z.enum(['grant', 'revoke']).describe('grant=set as admin, revoke=remove admin')
  },
  async ({ key, token, uid, action }) => {
    try {
      const data = await agentApi('/api/social/admin-set', { method: 'POST', body: JSON.stringify({ key, token, uid, action }) });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `操作失败：${error.message}` }], isError: true };
    }
  }
);

registerTool(
  'qq_whitelist',
  'Add a group to or remove it from the chat whitelist - only works from the owner private chat. Use when the owner says to whitelist/open group X or remove/ban group X.',
  {
    key: z.string().describe('Session key; must be the owner private session key (private:<owner QQ>), else rejected'),
    token: z.string().describe('Session token (from the wake prompt)'),
    groupId: z.union([z.number(), z.string()]).describe('Group id'),
    action: z.enum(['add', 'remove']).describe('add=add to whitelist, remove=remove from whitelist')
  },
  async ({ key, token, groupId, action }) => {
    try {
      const data = await agentApi('/api/social/whitelist', { method: 'POST', body: JSON.stringify({ key, token, groupId: String(groupId), action }) });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `操作失败：${error.message}` }], isError: true };
    }
  }
);

registerTool(
  'qq_remove_friend',
  'Delete a QQ friend (they leave your friend list and can no longer private-message you). For an extremely bad impression needing a complete break; ownerQQ can never be deleted. Optionally blacklist first via qq_blacklist.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token'),
    userId: z.string().describe('QQ number of the friend to delete')
  },
  async ({ key, token, userId }) => {
    try {
      const cleanUid = String(userId).trim();
      if (cleanUid === String(getConfig().ownerQQ ?? '')) {
        return { content: [{ type: 'text', text: '主人是永远的好友，不能删除~' }], isError: true };
      }
      await onebot('delete_friend', { user_id: Number(cleanUid) });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, deleted: cleanUid }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `删除失败：${error.message}` }], isError: true };
    }
  }
);

// ── QZone 共享鉴权与 HTTP（看/评/赞都走空间网页 API；cookie 由 NapCat get_cookies 中转）────────
// 统一开关：config.json → social.tools.qzone（评论/回复/点赞/查看/发说说；默认开）。管理端可关。
const QZONE_TOOL_DISABLED = cfg.social?.tools?.qzone === false || cfg.social?.tools?.qzoneView === false;
function qzoneDisabledNote() {
  return '空间互动功能已关闭（config → social.tools.qzone），需要时可在管理端开启';
}
const QZONE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// QZone 网页端实际在用的三个 CGI（真机实测确认）：
//  - 说说列表：taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6
//  - 评论/回复：taotao.qq.com/cgi-bin/emotion_cgi_re_feeds，参数名是 topicId=「主人QQ_说说tid__评论tid」(新评论用 __1)
//  - 点赞：w.qzone.qq.com/cgi-bin/likes/internal_dolike_app（POST，返回纯 JSON，不是 JSONP）
// 旧写法 taotao.qq.com/cgi-bin/emotion_cgi_comment_v6（tid 参数）恒返回 code=-3 参数错误；
// 旧写法 emotion_cgi_do_like_v6 直接 HTTP 500 空响应 → 解析不出 code，就是日志里的 code=undefined。
const QZONE_MSG_LIST = 'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6';
const QZONE_RE_FEEDS = 'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_re_feeds';
const QZONE_DOLIKE = 'https://user.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app';
async function getQzoneAuth() {
  let cookies = '';
  for (let i = 0; i < 3; i++) {
    const j = await agentApi('/api/qzone-cookie', { method: 'GET', timeoutMs: 8000 }).catch(() => null);
    if (j?.ok && j.cookies) { cookies = j.cookies; break; }
    await new Promise((r) => setTimeout(r, 600));
  }
  if (!cookies) throw new Error('拿不到 QZone 登录态（NapCat get_cookies 失败），稍后再试');
  const skey = cookies.match(/p_skey=([^;\s]+)/)?.[1] || cookies.match(/(?<![A-Za-z_])skey=([^;\s]+)/)?.[1];
  if (!skey) throw new Error('缺少 p_skey/skey，无法操作空间（可能未在 NapCat 登录过空间）');
  // QQ NT 的 uin / p_uin cookie 是 "o<QQ>" 这种带 o 前缀的形态（不同接口宽容度不一），
  // 统一剥成纯数字 QQ 再传，避免任何接口把它当非法 uin。
  const cookieUin = cookies.match(/(?<![A-Za-z_])uin=([^;\s]+)/)?.[1] || '';
  const uin = cookieUin.replace(/^o/i, '').replace(/\D/g, '') || String(getConfig().ownerQQ ?? '');
  let hash = 5381;
  for (let i = 0; i < skey.length; i++) hash += (hash << 5) + skey.charCodeAt(i);
  return { cookies, skey, uin, gtk: hash & 0x7fffffff };
}
// QZone 响应有三种壳：纯 JSON（点赞接口直接返回 JSON）、
// JSONP（document.domain=...;frameElement.callback({...})）、带 try/catch 的自定义 JSONP。
// 统一抽「首个 { 到最后一个 }」的 JSON，避免壳不同导致 code=undefined 的假象。
function qzoneParseBody(txt) {
  const s = String(txt ?? '').trim();
  if (!s) return null;
  if (s[0] === '{' || s[0] === '[') { try { return JSON.parse(s); } catch {} }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  const c = s.indexOf('(');
  const d = s.lastIndexOf(')');
  if (c >= 0 && d > c) { try { return JSON.parse(s.slice(c + 1, d).trim()); } catch {} }
  return null;
}
// 诊断友好：任何失败都带回 HTTP 状态 + 原始前 240 字符(_raw/_http), 便于定位风控页/参数错。
async function qzoneApi(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    // QZone 接口偶发挂起（风控/连接不返回）时，无超时的 fetch 会让整个 MCP 工具调用永不返回、卡死当前回合；
    // 与文件内其它 HTTP 一致给 20s 上限。
    signal: init.signal || AbortSignal.timeout(20000),
    headers: {
      Cookie: init.headers?.Cookie || '',
      Referer: init.headers?.Referer || 'https://user.qzone.qq.com/',
      Origin: 'https://user.qzone.qq.com',
      'User-Agent': QZONE_UA,
      'content-type': 'application/x-www-form-urlencoded',
      ...(init.headers || {})
    }
  });
  const txt = await res.text();
  const raw = (txt.slice(0, 240) || '').replace(/\s+/g, ' ').trim();
  const parsed = qzoneParseBody(txt);
  if (!parsed || typeof parsed !== 'object') return { _http: res.status, _raw: raw };
  const recognized = parsed.code !== undefined || parsed.ret !== undefined || parsed.subcode !== undefined
    || parsed.message !== undefined || parsed.msg !== undefined;
  // 成功/失败字段都没认出来 → 附诊断, 别让调用方看到 code=undefined 一脸懵
  return recognized ? { ...parsed, _http: res.status } : { ...parsed, _http: res.status, _raw: raw };
}
// 只读：从说说列表里取该条评论的作者昵称/QQ，用于回复时的 @ 语法(paramstr)
async function qzoneFindComment(cookies, hostUid, tid, commentId, gtk) {
  try {
    const j = await qzoneApi(`${QZONE_MSG_LIST}?uin=${hostUid}&hostUin=${hostUid}&format=json&num=20&start=0&g_tk=${gtk}`, { headers: { Cookie: cookies } });
    for (const m of Array.isArray(j?.msglist) ? j.msglist : []) {
      if (String(m.tid) !== String(tid)) continue;
      for (const c of Array.isArray(m.commentlist) ? m.commentlist : []) {
        if (String(c.id ?? c.commentid) === String(commentId)) return { name: c.name || '', uin: String(c.uin ?? '') };
      }
    }
  } catch {}
  return null;
}

registerTool(
  'qq_qzone_view',
  'View the recent QZone posts (moments) of a QQ number, to follow their status/mood; also works on your own QQ number to confirm posts you made.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token'),
    uid: z.string().describe('QQ number to view (pass your own QQ to view your own)'),
    num: z.number().optional().describe('Count to fetch, default 10, max 20')
  },
  async ({ key, token, uid, num }) => {
    try {
      if (QZONE_TOOL_DISABLED) return { content: [{ type: 'text', text: qzoneDisabledNote() }], isError: true };
      const cleanUid = String(uid).trim().replace(/^o/i, '').replace(/\D/g, '') || String(uid).trim();
      const count = Math.min(20, Math.max(1, Number(num) || 10));
      const { cookies, gtk } = await getQzoneAuth();
      const url = `${QZONE_MSG_LIST}?uin=${cleanUid}&hostUin=${cleanUid}&format=json&num=${count}&start=0&g_tk=${gtk}`;
      const j = await qzoneApi(url, { headers: { Cookie: cookies } });
      if (j.code !== 0) {
        return { content: [{ type: 'text', text: `空间访问失败：code=${j.code}${j._http != null ? ` http=${j._http}` : ''}${j.message ? ' ' + j.message : ''}${j._raw ? ' raw=' + j._raw : ''}` }], isError: true };
      }
      const list = Array.isArray(j.msglist) ? j.msglist : [];
      const out = list.map((m, i) => {
        const time = m.created_time ? new Date(Number(m.created_time) * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') : '';
        const content = m.content || m.summary || '';
        const pics = (m.picinfo?.list || m.pic || []).length;
        const likes = m.likeinfo?.total_num || 0;
        const line = `${i + 1}. [tid=${m.tid}] ${time} 赞${likes} ${pics ? `[${pics}图] ` : ''}${String(content).slice(0, 120)}`;
        // 带上评论（id + 作者 + 内容）：qq_qzone_reply_comment 需要 commentId，回复时的 @ 需要作者昵称
        const cmts = (Array.isArray(m.commentlist) ? m.commentlist : []).map((c) => {
          const cid = c.id ?? c.commentid ?? '';
          return `     └ [commentId=${cid}] ${c.name || c.uin || '?'}${c.parent_tid ? '(回复)' : ''}: ${String(c.content ?? '').slice(0, 80)}`;
        }).join('\n');
        return cmts ? `${line}\n${cmts}` : line;
      }).join('\n');
      return { content: [{ type: 'text', text: `空间主人 ${cleanUid} 最近 ${list.length} 条说说（评论/回复用 tid + commentId）：\n${out || '（空）'}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查看空间失败：${error.message}` }], isError: true };
    }
  }
);

registerTool(
  'qq_qzone_comment',
  'Comment on a QZone post by someone (or yourself). tid comes from the [tid=xxx] that qq_qzone_view returns. Write one casual natural sentence, like a real person browsing.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token'),
    hostUid: z.string().describe('QZone owner QQ number (mood author)'),
    tid: z.string().describe('tid of the mood to comment (from qq_qzone_view)'),
    content: z.string().describe('Comment content, one natural conversational sentence')
  },
  async ({ key, token, hostUid, tid, content }) => {
    try {
      if (QZONE_TOOL_DISABLED) return { content: [{ type: 'text', text: qzoneDisabledNote() }], isError: true };
      const { cookies, uin, gtk } = await getQzoneAuth();
      // QZone 现行评论接口：emotion_cgi_re_feeds，用 topicId 而不是 tid。
      // topicId 结构 =「说说主人QQ_说说tid__被回复评论tid」，发表新评论时固定用 __1。
      const topicId = `${hostUid}_${tid}__1`;
      const body = new URLSearchParams({
        topicId, uin: String(uin), hostUin: String(hostUid),
        content: String(content).slice(0, 200),
        format: 'fs', plat: 'qzone', source: 'ic', platformid: '52', ref: 'feeds',
        qzreferrer: `https://user.qzone.qq.com/${hostUid}`
      });
      const url = `${QZONE_RE_FEEDS}?g_tk=${gtk}`;
      const j = await qzoneApi(url, {
        method: 'POST',
        headers: { Cookie: cookies, Referer: `https://user.qzone.qq.com/${hostUid}` },
        body: body.toString()
      });
      if (j.code === 0 || j.code === '0' || j.ret === 0) {
        return { content: [{ type: 'text', text: `已评论 ${hostUid} 的说说：${String(content).slice(0, 50)}` }] };
      }
      return { content: [{ type: 'text', text: `评论失败：code=${j.code}${j._http != null ? ` http=${j._http}` : ''} ${j.message || j.msg || ''}${j._raw ? ' raw=' + j._raw : ''}` }], isError: true };
    } catch (error) {
      return { content: [{ type: 'text', text: `评论失败：${error.message}` }], isError: true };
    }
  }
);

registerTool(
  'qq_qzone_reply_comment',
  'Reply in-thread to a specific comment under a QZone post. tid and commentId come from the comment list qq_qzone_view returns (e.g. answering someone who commented on your post).',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token'),
    hostUid: z.string().describe('QZone owner QQ number (mood author)'),
    tid: z.string().describe('tid of the mood holding the comment'),
    commentId: z.string().describe('commentId of the comment to reply to'),
    replyUid: z.string().optional().describe('QQ number of the replied-to user (optional, defaults to the comment author)'),
    content: z.string().describe('Reply content, one sentence')
  },
  async ({ key, token, hostUid, tid, commentId, replyUid, content }) => {
    try {
      if (QZONE_TOOL_DISABLED) return { content: [{ type: 'text', text: qzoneDisabledNote() }], isError: true };
      const { cookies, uin, gtk } = await getQzoneAuth();
      // 回复某条评论：同一 re_feeds 接口，topicId 末段换成被回复评论的 commentId，
      // 并用 paramstr 做 @作者 前缀（昵称优先，拿不到就退化用 QQ 号）。
      const topicId = `${hostUid}_${tid}__${commentId}`;
      const target = await qzoneFindComment(cookies, hostUid, tid, commentId, gtk).catch(() => null);
      const atName = target?.name || (replyUid ? String(replyUid) : '');
      const body = new URLSearchParams({
        topicId, uin: String(uin), hostUin: String(hostUid),
        content: String(content).slice(0, 200),
        format: 'fs', plat: 'qzone', source: 'ic', platformid: '52', ref: 'feeds',
        richtype: '', richval: '',
        paramstr: atName ? `@${atName} ${String(content).slice(0, 200)}` : '',
        qzreferrer: `https://user.qzone.qq.com/${hostUid}`
      });
      const url = `${QZONE_RE_FEEDS}?g_tk=${gtk}`;
      const j = await qzoneApi(url, {
        method: 'POST',
        headers: { Cookie: cookies, Referer: `https://user.qzone.qq.com/${hostUid}` },
        body: body.toString()
      });
      if (j.code === 0 || j.code === '0' || j.ret === 0) {
        return { content: [{ type: 'text', text: `已回复评论${atName ? ` @${atName}` : ''}：${String(content).slice(0, 50)}` }] };
      }
      return { content: [{ type: 'text', text: `回复失败：code=${j.code}${j._http != null ? ` http=${j._http}` : ''} ${j.message || j.msg || ''}${j._raw ? ' raw=' + j._raw : ''}` }], isError: true };
    } catch (error) {
      return { content: [{ type: 'text', text: `回复失败：${error.message}` }], isError: true };
    }
  }
);

registerTool(
  'qq_qzone_like',
  'Like a QZone post (no dislike exists; a like is public interaction). tid comes from qq_qzone_view.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token'),
    hostUid: z.string().describe('QZone owner QQ number (mood author)'),
    tid: z.string().describe('tid of the mood to like'),
    curKey: z.string().optional().describe('Ignore; internal use')
  },
  async ({ key, token, hostUid, tid }) => {
    try {
      if (QZONE_TOOL_DISABLED) return { content: [{ type: 'text', text: qzoneDisabledNote() }], isError: true };
      const { cookies, uin, gtk } = await getQzoneAuth();
      // 点赞走 QZone 现役接口 internal_dolike_app（w.qzone.qq.com 前缀），POST 表单，
      // 返回纯 JSON（不是 JSONP）；老 emotion_cgi_do_like_v6 已 HTTP 500。
      const unikey = `http://user.qzone.qq.com/${hostUid}/mood/${tid}`;
      const body = new URLSearchParams({
        opuin: String(uin), unikey, curkey: unikey,
        from: '1', appid: '311', typeid: '0',
        abstime: String(Math.floor(Date.now() / 1000)),
        fid: String(tid), active: '0', format: 'json', fupdate: '1',
        qzreferrer: `https://user.qzone.qq.com/${hostUid}`
      });
      const url = `${QZONE_DOLIKE}?g_tk=${gtk}`;
      const j = await qzoneApi(url, {
        method: 'POST',
        headers: { Cookie: cookies, Referer: `https://user.qzone.qq.com/${hostUid}` },
        body: body.toString()
      });
      if (j.code === 0 || j.code === '0' || j.ret === 0) {
        return { content: [{ type: 'text', text: `已赞 ${hostUid} 的说说（tid=${tid}）` }] };
      }
      return { content: [{ type: 'text', text: `点赞失败：code=${j.code}${j._http != null ? ` http=${j._http}` : ''} ${j.message || j.msg || ''}${j._raw ? ' raw=' + j._raw : ''}` }], isError: true };
    } catch (error) {
      return { content: [{ type: 'text', text: `点赞失败：${error.message}` }], isError: true };
    }
  }
);

registerTool(
  'qq_send_qzone',
  'Post a QZone post (moment). content = post text; optional file = absolute local path of an image/gif to attach (a local machine path is fine). For sharing moods, daily life, and photos.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token'),
    content: z.string().describe('Mood text content'),
    file: z.string().optional().describe('Optional: local image/gif path to attach')
  },
  async ({ key, token, content, file }) => {
    try {
      const body = { content: String(content ?? '') };
      if (file) body.file = String(file);
      const data = await onebot('send_qzone_msg', body);
      // onebot() 返回的就是 OneBot 响应里的 data，tid 在 data.tid；旧写法只读 data.data.tid（多套了一层）
      // → 发说说成功后 tid 恒为 null。这里两种形态都兼容。
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, tid: data?.tid ?? data?.data?.tid ?? null, content }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发说说失败：${error.message}` }], isError: true };
    }
  }
);

// ── QQ 自带表情（face）对照表与发送：优先发 QQ 原生表情（含动态大表情），其次才用输入法 emoji ──
if (cfg.social?.tools?.faceList !== false) {
  registerTool(
    'qq_face_list',
    'Look up the QQ built-in face name-to-id table, animated big faces included (e.g. cute 可爱=21, covering-face 捂脸=178, laugh 大笑=39). To send a native QQ face, pick one here, then use qq_send_qq_face.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/social/qq-face-list?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取 QQ 表情表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.social?.tools?.sendQqFace !== false) {
  registerTool(
    'qq_send_qq_face',
    'Send one QQ built-in face, animated big faces included. Prefer this over keyboard emoji typed in text. Give faceId or name (e.g. 可爱, 捂脸; full table via qq_face_list). One message is one face, no text in the same bubble.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token'),
      faceId: z.union([z.number(), z.string()]).optional().describe('QQ face id (e.g. 21=可爱, 178=捂脸); use either id or name'),
      name: z.string().optional().describe('QQ face name (e.g. 可爱, 捂脸); use either name or faceId'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('Message id to quote (nonzero int, may be negative); must be the message you are responding to'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('QQ number of group member to @ (optional; group chats)')
    },
    async ({ key, token, faceId, name, replyToMessageId, atUserId }) => {
      try {
        const body = { key, faceId: faceId != null ? String(faceId) : undefined, name: name || undefined };
        if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') body.replyToMessageId = replyToMessageId;
        if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') body.atUserId = atUserId;
        const data = await agentApi('/api/social/send-qq-face', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送 QQ 表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 完整聊天记录检索与管理（SQLite 永久存储，桥接自动写入，不占模型额度） ──
if (cfg.social?.tools?.memorySearch !== false) {
  registerTool(
    'qq_memory_search',
    'Search the full chat history (SQLite): filter by session key, keyword, sender, date (YYYY-MM-DD) or direction (in=received, out=sent by you); omit key to search all sessions. Returns timestamps, session, sender and content. Results are trimmed (lines truncated, total capped) - narrow with query/date when you need detail.',
    {
      key: z.string().optional().describe('Session key (group:<gid> or private:<qq>); omit to search all sessions'),
      token: z.string().describe('Session token'),
      query: z.string().optional().describe('Keyword; matches message content'),
      sender: z.string().optional().describe('Sender (nickname or QQ number)'),
      date: z.string().optional().describe('Date YYYY-MM-DD, e.g. 2026-08-31'),
      direction: z.enum(['in', 'out']).optional().describe('in=received messages, out=messages you sent'),
      limit: z.number().optional().describe('Max results, default 30, max 60 (keep it small - every line stays in your context)'),
      offset: z.number().optional().describe('Skip count (pagination)')
    },
    async ({ key, token, query, sender, date, direction, limit, offset }) => {
      try {
        const q = new URLSearchParams();
        if (key) q.set('key', key);
        if (query) q.set('query', query);
        if (sender) q.set('sender', sender);
        if (date) q.set('date', date);
        if (direction) q.set('direction', direction);
        if (limit) q.set('limit', String(limit));
        if (offset) q.set('offset', String(offset));
        const data = await agentApi(`/api/social/history-search?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 20000 });
        // 紧凑序列化（不再 null,2 缩进）：这条结果可能上万字符，缩进白占 ~30%，而且它会长期留在上下文里。
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `搜索聊天历史失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.social?.tools?.historyDelete !== false) {
  registerTool(
    'qq_history_delete',
    'Delete chat history records: by an id list, or by session plus keyword/sender/date. Requires confirm:true; deletion cannot be undone.',
    {
      key: z.string().optional().describe('Session key; omit to delete globally by other criteria'),
      token: z.string().describe('Session token'),
      ids: z.union([z.number(), z.array(z.number())]).optional().describe('Record id to delete (returned by qq_memory_search)'),
      query: z.string().optional().describe('Keyword; delete messages matching it'),
      sender: z.string().optional().describe('Sender (nickname or QQ number)'),
      date: z.string().optional().describe('Date YYYY-MM-DD; delete messages from that date'),
      confirm: z.literal(true).describe('Confirmation required; must be true')
    },
    async ({ key, token, ids, query, sender, date }) => {
      try {
        const body = { confirm: true };
        if (key) body.key = key;
        if (ids !== undefined && ids !== null) body.ids = Array.isArray(ids) ? ids : [ids];
        if (query) body.query = query;
        if (sender) body.sender = sender;
        if (date) body.date = date;
        const data = await agentApi('/api/social/history-delete', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'x-agent-token': token },
          timeoutMs: 20000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `删除聊天历史失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.social?.tools?.historyClear !== false) {
  registerTool(
    'qq_history_clear',
    'Clear chat history: omit key to clear everything, pass key to clear only that session. Requires confirm:true; clearing cannot be undone.',
    {
      key: z.string().optional().describe('Session key; omit to clear all'),
      token: z.string().describe('Session token'),
      confirm: z.literal(true).describe('Confirmation required; must be true')
    },
    async ({ key, token }) => {
      try {
        const data = await agentApi('/api/social/history-clear', {
          method: 'POST',
          body: JSON.stringify({ key: key || undefined, confirm: true }),
          headers: { 'x-agent-token': token },
          timeoutMs: 20000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `清空聊天历史失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 文档（docx）发送：写小说/长文直接发 Word 文档，不贴长文进输入框 ──
if (cfg.social?.tools?.sendDocx !== false) {
  registerTool(
    'qq_send_docx',
    'Generate a Word (.docx) from long content (novel, article, report, settings) and send it as a file - use it instead of pasting long text into chat. title = doc title; content = body (newlines make paragraphs, up to 1,000,000 chars). Limit: 100,000 docx chars per session per Beijing day; if rejected for the daily limit, tell the other person the quota is used up and to try tomorrow - never retry and never pretend success.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token'),
      title: z.string().describe('Doc title (used as filename prefix and first heading line)'),
      content: z.string().describe('Doc body; multiline text, split by \\\\n'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('Message id to quote (optional)')
    },
    async ({ key, token, title, content, replyToMessageId }) => {
      try {
        const body = { key, title: String(title ?? ''), content: String(content ?? '') };
        if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') body.replyToMessageId = replyToMessageId;
        const data = await agentApi('/api/social/send-docx', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送文档失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 智能合并转发：把多条消息合并成一条转发卡片发送 ──
if (cfg.social?.tools?.sendForward !== false) {
  registerTool(
    'qq_send_forward',
    'Merge several messages into one forward card sent to a session (group or private). Use for forwarding a batch, summarizing chat records or bundling segments - never send them one by one. nodes = [{ name: display nickname, uin: display QQ, content: text }], max 50 items, 3000 chars per item.',
    {
      key: z.string().describe('Session key (group:<gid> or private:<qq>); where to send'),
      token: z.string().describe('Session token (from the wake prompt)'),
      nodes: z.array(z.object({
        name: z.string().optional().describe('Display nickname for this message'),
        uin: z.union([z.number(), z.string()]).optional().describe('Display QQ number for this message'),
        content: z.string().describe('Text content for this message')
      })).describe('Messages to merge into a forward card (max 50)'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('Message id to quote (optional)')
    },
    async ({ key, token, nodes, replyToMessageId }) => {
      try {
        const body = { key, nodes: Array.isArray(nodes) ? nodes : [] };
        if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') body.replyToMessageId = replyToMessageId;
        const data = await agentApi('/api/social/forward-send', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 富文本/卡片发送：发音乐/联系人/位置/JSON卡片/XML/骰子/猜拳（接受各种卡片的"反过来"） ──
if (cfg.social?.tools?.sendRich !== false) {
  registerTool(
    'qq_send_rich',
    'Send native rich interactive cards: music (native on NapCat 4.18; recommended after qq_music_search: type=music with musicType=163 (NetEase) / qq (QQ Music) plus musicId, so the recipient can tap to play), contact (contact card), dice/rps (dice / rock-paper-scissors).',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token'),
      type: z.enum(['music', 'contact', 'dice', 'rps']).describe('Card type: music (netease: real card, QQ Music: official share link, both playable), contact=contact card, dice, rps=rock-paper-scissors'),
      musicType: z.enum(['qq', '163', 'kugou', 'migu', 'kuwo', 'custom']).optional().describe('musicType: 163=NetEase, qq=QQ Music, kugou/kuwo/migu=other platforms, custom=custom (163/qq recommended)'),
      musicId: z.union([z.number(), z.string()]).optional().describe('Platform music id: 163=song id, qq=songmid'),
      musicUrl: z.string().optional().describe('Required when musicType=custom: click-through URL'),
      audio: z.string().optional().describe('custom audio URL (optional)'),
      title: z.string().optional().describe('Song title (for custom)'),
      image: z.string().optional().describe('custom cover image URL (required)'),
      content: z.string().optional().describe('Artist/description (for custom)'),
      contactType: z.enum(['qq', 'group']).optional().describe('Contact card type'),
      contactId: z.union([z.number(), z.string()]).optional().describe('Contact QQ number or group number'),
      result: z.union([z.number(), z.string()]).optional().describe('dice/rps result (optional)'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('Message id to quote (optional)'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('QQ number of group member to @ (optional; group chats)')
    },
    async ({ key, token, type, musicType, musicId, musicUrl, audio, title, image, content, contactType, contactId, lat, lon, locTitle, locContent, data, result, replyToMessageId, atUserId }) => {
      try {
        const body = { key, type };
        if (musicType) body.musicType = musicType;
        if (musicId !== undefined && musicId !== null) body.musicId = musicId;
        if (musicUrl) body.musicUrl = musicUrl;
        if (audio) body.audio = audio;
        if (title) body.title = title;
        if (image) body.image = image;
        if (content) body.content = content;
        if (contactType) body.contactType = contactType;
        if (contactId !== undefined && contactId !== null) body.contactId = contactId;
        if (lat !== undefined && lat !== null) body.lat = lat;
        if (lon !== undefined && lon !== null) body.lon = lon;
        if (locTitle) body.locTitle = locTitle;
        if (locContent) body.locContent = locContent;
        if (data !== undefined && data !== null) body.data = data;
        if (result !== undefined && result !== null) body.result = result;
        if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') body.replyToMessageId = replyToMessageId;
        if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') body.atUserId = atUserId;
        const resp = await agentApi('/api/social/send-rich', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送卡片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 音乐搜索（海外可达的网易云/QQ音乐接口）──
if (cfg.social?.tools?.musicSearch !== false) {
  registerTool(
    'qq_music_search',
    'Search songs (overseas-reachable NetEase music.163.com / QQ Music c.y.qq.com); returns platform/title/artist/album/link/cover per song. To share music, search first then send a music card via qq_send_rich music type (type=163 passes the NetEase id, type=qq passes songmid; NapCat hooks a local signing service so it sends directly); for old clients fall back to a cover image plus the song-link text.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token'),
      query: z.string().describe('Search keyword (song title or artist)'),
      platform: z.enum(['all', 'netease', 'qqmusic']).optional().describe('Platform: all=both (default), netease=NetEase, qqmusic=QQ Music'),
      limit: z.number().optional().describe('Results per platform, default 5, max 10')
    },
    async ({ key, token, query, platform, limit }) => {
      try {
        const q = new URLSearchParams({ key, q: String(query ?? ''), platform: platform || 'all' });
        if (limit) q.set('limit', String(limit));
        const data = await agentApi(`/api/social/music-search?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 20000 });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `搜索音乐失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 人格学习（persona）控制：针对目标 QQ 用户从聊天历史学习其风格/性格/习惯并沉淀档案 ──
// mcp 进程与 bridge 进程分离：这里只通过本机 bridge console 学习 API 触发（POST /api/learning/persona，
// body {action:'start'|'stop'|'status', qq?: string[], days?}），不 import 任何 bridge 模块。
// 鉴权（以 console-server.js 实际为准）：所有 API 请求带请求头 x-console-token: <token>，
// 不是 Bearer。token 文件 = ../state/console-token（本文件在 src/ 下，../state/ 即 qq-bridge/state/），
// 每次请求现读 readConsoleToken()（优先 config.consoleToken，其次该文件）；文件读不到时
// 回退"无鉴权头"再试一次。请求头只带 content-type + x-console-token，不带 Origin（回环调用天然无 Origin）。
async function personaConsoleRequest(action, qq, days) {
  const port = Number(getConfig().consolePort) || 3100;
  const body = { action };
  if (Array.isArray(qq) && qq.length) body.qq = qq.map(String);
  if (action === 'start' && days !== undefined && days !== null) body.days = Number(days);
  const mkHeaders = (tok) => ({
    'content-type': 'application/json',
    ...(tok ? { 'x-console-token': tok } : {})
  });
  const call = async (tok) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/learning/persona`, {
      method: 'POST',
      headers: mkHeaders(tok),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
    let parsed = null;
    try { parsed = await res.json(); } catch {}
    if (!res.ok) throw new Error(parsed?.error || `bridge console HTTP ${res.status}`);
    return parsed;
  };
  const token = readConsoleToken();
  try {
    return await call(token);
  } catch (err) {
    if (!token && /401|403/.test(String(err?.message ?? ''))) return call('');
    throw err;
  }
}

registerTool(
  'qq_persona_learn_start',
  'Start persona learning for the given target QQ user(s) from chat history (defaults to configured targets); one model session per target. Use when asked to imitate a specific person.',
  {
    targetQQ: z.array(z.string()).optional().describe('Target QQ user number(s) to learn; empty = learning-config persona.targetQQ'),
    days: z.number().optional().describe('Look-back window in days for chat samples (default 30)')
  },
  async ({ targetQQ, days }) => {
    try {
      const data = await personaConsoleRequest('start', targetQQ, days);
      if (data && data.ok === false) return { content: [{ type: 'text', text: `Persona learning failed: ${data.error ?? 'unknown error'}` }], isError: true };
      const started = Array.isArray(data?.result?.started) ? data.result.started : [];
      if (!started.length) return { content: [{ type: 'text', text: 'Persona learning: no target started (targets already in progress, feature disabled, or no valid QQ given).' }], isError: true };
      return { content: [{ type: 'text', text: `Persona learning started for: ${started.join(', ')}. It runs in the background; check qq_persona_learn_status later for the learned profiles.` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Failed to start persona learning: ${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_persona_learn_stop',
  'Stop an in-flight persona learning run for the target(s).',
  {
    targetQQ: z.array(z.string()).optional().describe('Target QQ user number(s) to stop; empty = stop all in-flight runs')
  },
  async ({ targetQQ }) => {
    try {
      const data = await personaConsoleRequest('stop', targetQQ);
      if (data && data.ok === false) return { content: [{ type: 'text', text: `Persona learning stop failed: ${data.error ?? 'unknown error'}` }], isError: true };
      const stopped = Array.isArray(data?.result?.stopped) ? data.result.stopped : [];
      return { content: [{ type: 'text', text: stopped.length ? `Persona learning stop requested for: ${stopped.join(', ')}.` : 'No persona learning run is currently in flight.' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Failed to stop persona learning: ${error?.message ?? error}` }], isError: true };
    }
  }
);

registerTool(
  'qq_persona_learn_status',
  'Show persona learning status & learned profiles for targets.',
  {},
  async () => {
    try {
      const data = await personaConsoleRequest('status');
      if (data && data.ok === false) return { content: [{ type: 'text', text: `Persona learning status failed: ${data.error ?? 'unknown error'}` }], isError: true };
      const status = Array.isArray(data?.result?.status) ? data.result.status : [];
      if (!status.length) return { content: [{ type: 'text', text: 'Persona learning: no learned profiles yet. Start one with qq_persona_learn_start.' }] };
      const lines = status.map((s) => {
        const when = s.learnedAtMs ? new Date(Number(s.learnedAtMs)).toISOString().replace('T', ' ').slice(0, 16) : 'never';
        return `QQ ${s.uid}: ${s.state === 'learning' ? 'learning now' : 'learned'} (${when}, ${s.samples || 0} samples)${s.personalityPreview ? ` - personality: ${s.personalityPreview}` : ''}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Persona learning status unavailable: ${error?.message ?? error}` }], isError: true };
    }
  }
);

// 启动 MCP stdio server（修复: 缺少 connect 导致进程静默退出）
await server.connect(new StdioServerTransport());
