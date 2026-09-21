// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SENSITIVE_RE } from './sensitive.js';
import { napcatImageFileArg } from './lib/napcat-file.js';
// 【2026-09-18】联网找图：图片搜索引擎（Bing/百度）+ SSRF 安全下载。
// 两者都是纯函数模块，直接 import；下载复用 safe-fetch（禁内网、限字节、校验真是图片）。
import { searchImages } from './lib/image-search.js';
import {
  pixivSearch, parsePixivId,
  pixivIllustDetail, pixivIllustOriginals, pixivImageSources, pixivUserWorkIds,
  resolvePixivAuthor, pixivLoggedIn,
} from './lib/pixiv.js';
import { safeFetchBuffer, MAX_IMAGE_FETCH_BYTES } from './safe-fetch.js';
import { isDeliveredUnconfirmed, deliveredUnconfirmedResult, onebotErrText } from './lib/onebot-delivery.js';
import { resolveToolTier, toolAllowedByTier, measureSchemaShare, TOOL_TIERS } from './lib/tool-tiers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 内置表情包（meme packs）：**多包**发现 + 角色专属包绑定，全部运行时探测，禁止写死。
//
// 【2026-09-20 从"单包"改成"多包"】此前这里只认一个写死的 pack id（whale-fanart-001），
// 于是：主人再传一份表情包进来，模型根本看不见它；角色卡里配的"这个角色用这套表情"也无处落地。
// 现在一份 pack 的形态固定为：
//     <包目录>/{manifest.json, index.db, memes/<tag>/<文件名>.<ext>}
//   · index.db 表 memes(path 主键, file_name, tag, caption, keywords[, file_hash, mtime, captioned_at])
//   · path 是相对包根的路径（'/' 分隔），**发图靠它**；file_name 只是文件名（包内唯一），搜索靠它。
// 包出现在三类位置（都认，顺序即优先级）：
//   1) 出厂包      <runtimeRoot>/meme/<packId>/          —— 随安装包分发（鲸鱼包就在这里）
//   2) 后装/上传包 <runtimeRoot>/meme-packs/<packId>/    —— 管理端上传的新包落点
//   3) 角色专属包  <角色库根>/<角色slug>/meme-packs/<packId>/ —— 跟着角色走
//
// 【2026-09-15 改名】工具从 qq_whale_meme_search / qq_send_whale_meme 改成 qq_meme_search / qq_send_meme：
// 旧名字带开发初版「鲸鱼娘人设」的味道，工具本身跟人设无关（就是"从内置表情包里挑一张发"）。
// **pack 目录名 whale-fanart-001 保持不变**：那是已分发到本机 runtime 与安装包 payload 里的真实
// 磁盘路径，改名会让所有已装好的机器找不到表情包；id 由 manifest.id 决定，目录名不再等于 id。
//
// 【2026-09-13 修「表情包图库搜索失败」】现网 <安装目录>\resources\runtime 与所有安装包 payload
// 都漏装了 meme/ 表情包 → 解析为 null → 工具直接回"本机没装表情包"，
// 而且是**静默降级**（只在被调用时才暴露）。现在：
//   1) 候选表补上隔离 DSH home / 桌面端 DSH home 下的 meme-packs 与 plugins 形态；
//   2) 启动时一个都找不到就必打**一行 stderr**，把尝试过的每条路径都列出来；
//   3) 运行期补装（sync-to-live.ps1 拷进 runtime）或管理端上传新包后，**无需重启桥即自愈**（5 秒缓存）。
const MEME_LEGACY_PACK_ID = 'whale-fanart-001';
/** 发现结果缓存：管理端刚传完包就能搜到，不用等重启；但也不至于每次搜索都全盘 readdir */
const MEME_RESCAN_MS = 5000;

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

/** 全部候选根（顺序即优先级）；解析与启动日志共用同一张表，日志里列的就是真正试过的那些。
 *  每条候选**既可能是包本身**（目录里有 index.db），也可能是**包根**（下面一层的子目录才是各个包）——
 *  两种形态都认，这样"出厂单包目录"与"上传的多包目录"共用同一套代码。 */
function memeRootCandidates() {
  const list = [];
  const add = (p) => { if (p && !list.includes(p)) list.push(p); };
  const explicit = String(process.env.QQB_MEME_ROOT || '').trim();
  // 显式覆盖：可指 pack 本身，也可指 pack 的父目录
  if (explicit) { add(explicit); add(path.join(explicit, MEME_LEGACY_PACK_ID)); }
  // ROOT = qq-bridge；项目根 meme/ 与 meme-packs/ 都在 ROOT/..（setup 分发后与 qq-bridge 平级）
  add(path.join(ROOT, '..', 'meme'));                                       // 出厂包所在（随安装包分发，默认）
  add(path.join(ROOT, '..', 'meme-packs'));                                 // 后装/上传的包落点
  add(path.join(ROOT, '..', '.runtime', 'meme-packs'));
  add(path.join(ROOT, 'meme'));
  add(path.join(ROOT, 'meme-packs'));
  add(path.join(ROOT, '.runtime', 'meme-packs'));
  // 【2026-09-13 补】"从本机复刻到服务器"那条路把表情包放在 <源机 qq-bridge 的父目录>/dsh-meme ——
  // 目标机上就是 /root/dsh-meme/<pack>。原来候选表里没有这一条，克隆过去的服务器会重演
  // "表情包图库搜索失败"。这里补上两种形态（与部署脚本 buildLocalStagePlan 的 dsh-meme 目录一致）。
  add(path.join(ROOT, '..', 'dsh-meme'));
  add(path.join(ROOT, 'dsh-meme'));
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) add(path.join(home, '.dsh', 'meme-packs'));
  add('/root/.dsh/meme-packs');                                             // 服务器（Linux）旧形态
  for (const h of dshHomeCandidates()) {
    add(path.join(h, 'meme-packs'));                                        // DSH home 形态：<home>/meme-packs/<pack>
    // home 内再嵌一层 .dsh（桌面端旧形态）；home 本身就叫 .dsh 时不必再加一遍
    if (!/\.dsh$/i.test(h)) add(path.join(h, '.dsh', 'meme-packs'));
    add(path.join(h, 'plugins', 'meme-packs'));                             // 作为 DSH 插件/pack 安装的形态
    add(path.join(h, 'plugins', MEME_LEGACY_PACK_ID));
  }
  return list;
}

const MEME_ROOT_CANDIDATES = memeRootCandidates();

/** index.db 必须是**非空文件**才算一份可用的 pack（半截拷贝不算） */
function hasMemePack(dir) {
  try { const st = fs.statSync(path.join(dir, 'index.db')); return st.isFile() && st.size > 0; } catch { return false; }
}

/** 读 pack 的 manifest.json（读不到/坏掉都当没有，绝不抛） */
function readMemeManifest(dir) {
  try {
    const t = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(t);
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}

/** 出厂包判定：<qq-bridge 的父目录>/meme/ 下面（含 <父目录>/qq-bridge/meme/ 这种旧形态） */
function isFactoryMemeDir(dir) {
  for (const base of [path.join(ROOT, '..', 'meme'), path.join(ROOT, 'meme')]) {
    const rel = path.relative(base, dir);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}

/**
 * 把一个候选根展开成若干份 pack，追加进 out（按 realpath 去重：同一条路径被多条候选指到时只算一次）。
 * @param {string} candidate 候选根（包本身或包根）
 * @param {string|null} character 角色 slug（角色专属包才有）
 */
function collectMemePacks(candidate, character, out) {
  const push = (dir, fallbackId) => {
    if (!hasMemePack(dir)) return;
    let real = dir;
    try { real = fs.realpathSync(dir); } catch { /* 路径读不到就用原样，后面查库时会自然失败 */ }
    if (out.some((p) => p.dir === real)) return;
    const manifest = readMemeManifest(dir);
    out.push({
      id: String(manifest?.id || fallbackId || path.basename(dir)),
      dir: real,
      source: character ? 'character' : (isFactoryMemeDir(dir) ? 'factory' : 'global'),
      character: character || null,
      name: String(manifest?.name || fallbackId || path.basename(dir)),
      manifest
    });
  };
  if (hasMemePack(candidate)) { push(candidate, path.basename(candidate)); return out; }
  let ents = [];
  try { ents = fs.readdirSync(candidate, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;                       // .dedup / .upload-* / 隐藏目录都不算包
    /* 【2026-09-20 修「服务器上一份包都找不到」】这里以前用 `e.isDirectory()` 过滤 ——
     * 而 readdir 的 Dirent **不跟随符号链接**：服务器上的 `/root/.dsh/meme-packs/whale-fanart-001`
     * 正是指向 `/root/whale-fanart-001` 的软链，isDirectory() 为 false → 整份包被跳过 → 工具回
     * "本机没装内置表情包"。改用 statSync 判目录（跟随链接），与 hasMemePack 的口径一致。 */
    let st = null;
    try { st = fs.statSync(path.join(candidate, e.name)); } catch { continue; }
    if (!st.isDirectory()) continue;
    push(path.join(candidate, e.name), e.name);
  }
  return out;
}

/** 全局包（出厂 meme/ + 后装 meme-packs/ + DSH home 等旧形态）。只读文件系统、不读配置，故模块初始化期也能调。 */
function scanGlobalPacks() {
  const out = [];
  for (const c of MEME_ROOT_CANDIDATES) collectMemePacks(c, null, out);
  return out;
}

/** 角色专属包落在哪些角色库根下（与角色只读工具组同一套解析：config.social.charactersDir 优先） */
function characterMemeRoots() {
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  try { add(resolveCharactersDir(null)); } catch { /* 角色库解析器异常不该让表情包一起废掉 */ }
  add(path.join(ROOT, 'characters'));                       // 随安装包分发的角色库
  add(path.join(ROOT, '..', 'characters'));
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) {
    add(path.join(home, 'Desktop', 'characters'));
    add(path.join(home, 'Desktop', 'characters', 'characters'));
  }
  return out;
}

/** 角色专属包：<角色库根>/<角色slug>/meme-packs/<packId>/（要读配置，只能在工具调用期调） */
function scanCharacterPacks() {
  const out = [];
  for (const root of characterMemeRoots()) {
    let slugs = [];
    try {
      // 同样用 statSync 判目录（跟随软链）：角色库根与角色目录都可能是链接（服务器上常见）
      slugs = fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.') && e.name !== '_template')
        .filter((e) => { try { return fs.statSync(path.join(root, e.name)).isDirectory(); } catch { return false; } })
        .map((e) => e.name);
    } catch { continue; }
    for (const slug of slugs) collectMemePacks(path.join(root, slug, 'meme-packs'), slug, out);
  }
  return out;
}

/** 全局包缓存（5 秒）：管理端刚传完的包不用重启桥就能搜到，但也不至于每次搜索都全盘 readdir */
let globalMemePacksCache = { at: 0, packs: [] };
function findGlobalMemePacks() {
  const now = Date.now();
  if (globalMemePacksCache.packs.length && now - globalMemePacksCache.at < MEME_RESCAN_MS) return globalMemePacksCache.packs;
  const packs = scanGlobalPacks();
  globalMemePacksCache = { at: now, packs };
  return packs;
}

/** 启动自检：一份全局包都没有就必打**一行 stderr**，把尝试过的每条路径都列出来。
 *  （静默降级是 2026-09-13「表情包图库搜索失败」那场事故的根因：装漏了不报，只在被调用时才暴露。）
 *  这里只扫全局包、不读配置 —— 模块初始化期 DEFAULT_CHARACTERS_DIR 还在 TDZ 里。 */
{
  const initial = findGlobalMemePacks();
  if (initial.length) {
    console.error(`[mcp-napcat-safe] 内置表情包已加载 ${initial.length} 份：${initial.map((p) => `${p.id}(${p.source})`).join(', ')}`);
  } else {
    console.error(`[mcp-napcat-safe] 未找到内置表情包（meme-packs）：qq_meme_search / qq_send_meme 将不可用。已尝试 ${MEME_ROOT_CANDIDATES.length} 条路径：${MEME_ROOT_CANDIDATES.join(' | ')}`);
  }
}

/** 全部可用包（全局 + 角色专属），同样 5 秒缓存。工具调用期用这个。 */
let allMemePacksCache = { at: 0, packs: [] };
function findMemePacks() {
  const now = Date.now();
  if (allMemePacksCache.packs.length && now - allMemePacksCache.at < MEME_RESCAN_MS) return allMemePacksCache.packs;
  const packs = scanGlobalPacks();
  try {
    for (const p of scanCharacterPacks()) if (!packs.some((x) => x.dir === p.dir)) packs.push(p);
  } catch { /* 角色库读不到不该让全局表情包一起废掉 */ }
  allMemePacksCache = { at: now, packs };
  return packs;
}

const memeMissingHint = '本机没装内置表情包（meme-packs），这个工具不可用。想发图可以试试 qq_send_message 带本地图片路径，或直接发文字。';

/** 当前生效的角色 slug：管理端导入角色卡时写 social.meme.activePersona；没写但**只有一个**角色绑了包时用它兜底 */
function activeMemePersona(cfg) {
  const m = cfg?.social?.meme ?? {};
  const explicit = String(m.activePersona || '').trim();
  if (explicit) return explicit;
  const keys = Object.keys(m.personaPacks ?? {}).filter((k) => Array.isArray(m.personaPacks[k]) && m.personaPacks[k].length);
  return keys.length === 1 ? keys[0] : '';
}

/**
 * 一次搜索要考虑的包，按优先级排序：
 *   ① 当前角色的专属包（social.meme.personaPacks[角色]）→ ② 该角色自己的目录包 → ③ 主人点名的包（social.meme.packs）
 *   → ④ 出厂包 → ⑤ 其余。social.meme.packs 非空时只在这些包 + 角色包里搜（空 = 全都搜）。
 */
function orderedMemePacks(cfg) {
  const all = findMemePacks();
  const m = cfg?.social?.meme ?? {};
  const persona = activeMemePersona(cfg);
  const bound = new Set((persona ? (m.personaPacks?.[persona] ?? []) : []).map(String));
  const wanted = new Set((Array.isArray(m.packs) ? m.packs : []).map(String));
  const pool = wanted.size ? all.filter((p) => wanted.has(p.id) || bound.has(p.id)) : all;
  const rank = (p) => (bound.has(p.id) ? 0 : (persona && p.character === persona) ? 1 : wanted.has(p.id) ? 2 : p.source === 'factory' ? 3 : 4);
  return pool.slice().sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

/**
 * 从一份 pack 的表里取某个文件的相对路径。
 * 老 pack（<= v1.1.1 的 relayout 产物）没有 path 列，这里按 memes/<tag>/<文件名> 兜底推出来 ——
 * 否则表现就是"搜得到、发不出"。
 */
function queryMemePath(db, fileName) {
  try {
    const r = db.prepare('SELECT path FROM memes WHERE file_name = ?').get(String(fileName));
    if (r?.path) return String(r.path);
  } catch { /* 没有 path 列，走下面的兜底 */ }
  try {
    const r = db.prepare('SELECT tag, file_name FROM memes WHERE file_name = ?').get(String(fileName));
    return r ? `memes/${r.tag}/${r.file_name}` : null;
  } catch { return null; }
}

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
    allowAllWhenEmpty: c.allowAllWhenEmpty === true,
    // 分侧放行（名单为空时生效）：群 / 私聊各自一个开关（见 lib/config.js 的 allowed()）
    allowAllGroups: c.allowAllGroups === true,
    allowAllPrivate: c.allowAllPrivate === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.napcat?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.napcat?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时看"放行开关"。
// 【2026-09-19】第 5 个参数改名为 allowAll：调用方按类传 `allowAllXxx || allowAllWhenEmpty`
// （分侧开关与全局开关是"或"关系，名单非空时两者都不生效——口径与 lib/config.js 的 allowed() 完全一致）。
function isAllowed(allowList, denyList, id, allowAll) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAll === true;
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
    // EventChecker Failed = 已送达未确认（见 lib/onebot-delivery.js）：不报失败、不重试。
    if (isDeliveredUnconfirmed(onebotErrText(body))) return deliveredUnconfirmedResult();
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

/* 【2026-09-15 省额度】重复失败短路：同一个工具 + 完全相同的参数，如果刚刚（90s 内）已经失败过，
 * 就不再真的执行一次，直接把上次的失败原因回给它，并明确叫它别用同样的参数重试。
 *
 * 为什么值得单独做一层：线上实测（2026-09-14 22:52-22:53 的私聊）模型一次并列调了 3 个
 * qq_send_sticker（同一个 stickerId 连失败 3 次），下一步又同样地重试 —— 每一次失败都要付
 * **一整个模型步**的上下文重发（该会话实测 ≈34k tokens/步），3 次重试≈10 万 tokens 白花。
 * 这一层把重复失败挡在桥内：相同参数第二次进来直接短路，模型不会再为同一件失败的事反复烧额度。
 *
 * 只对**确定性错误**生效（找不到表情 / 参数非法 / 文件处理失败 …）；
 * 超时、网络、限频这类"再试一次可能就好了"的错误不记，免得挡住合理的重试。 */
const recentFailures = new Map();          // key -> { at, text }
const FAIL_MEMO_MS = 90_000;
const TRANSIENT_RE = /超时|timeout|timed out|ECONN|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|网络|频率|限频|429|50[0-4]|fetch failed/i;
const failureKey = (name, args) => {
  try { return `${name}|${JSON.stringify(args ?? {})}`; } catch { return String(name); }
};
const pruneFailures = () => {
  if (recentFailures.size < 200) return;
  const now = Date.now();
  for (const [k, v] of recentFailures) if (now - v.at > FAIL_MEMO_MS) recentFailures.delete(k);
};
/* 【2026-09-15 修「缺 key/token 直接 -32602」】模型偶尔漏传 key/token（正文里 [Token] 行离得远、
 * 或者它把参数名写成了别的），而全部会话级工具的 zod schema 把两者声明成**必填** —— 于是请求在
 * **进任何处理器之前**就被 MCP SDK 以 `-32602 Invalid input: expected string, received undefined at key`
 * 打回：模型拿不到任何可执行提示，答不上人，还白烧一整个模型步（线上该会话实测 ≈34k tokens/步）。
 *
 * 现在两层兜底：
 *   ① schema 里把 key/token 放宽成 optional（描述照旧，模型仍会正常传）；
 *   ② 处理器入口把缺的补上：传了 key 就按 key 取该会话的 agent token；只缺 key 就问桥
 *      "当前唯一在途回合"是哪个会话（/api/social/current-turn，本机可信通道）；
 *   ③ 实在补不上，回一句**能照着做**的提示，而不是一句 JSON schema 校验失败。
 */
let sessionFallback = null;                    // { key, token, at }
const SESSION_FALLBACK_TTL_MS = 5000;
async function resolveMissingSession(wantKey) {
  const now = Date.now();
  if (!wantKey && sessionFallback && now - sessionFallback.at < SESSION_FALLBACK_TTL_MS) return sessionFallback;
  try {
    const tok = readConsoleToken();
    const res = await fetch(`${agentApiBase()}/api/social/current-turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(tok ? { 'x-console-token': tok } : {}) },
      body: JSON.stringify(wantKey ? { key: wantKey } : {}),
      signal: AbortSignal.timeout(8000)
    });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.ok) {
      const hit = { key: String(body.key ?? ''), token: String(body.token ?? ''), at: now, source: String(body.source ?? '') };
      if (!wantKey) sessionFallback = hit;
      return hit;
    }
    return { error: String(body?.reason || body?.error || `HTTP ${res.status}`) };
  } catch (e) {
    return { error: e?.message ?? String(e) };
  }
}
const MISSING_ARG_HINT = '缺 token：唤醒正文第一行就是 `[Token] <值>`，照抄即可；同一区域的 `[Session] group:<群号>` / '
  + '`[Session] private:<QQ>` 就是本次要发的 key。两者照常传就行。如果这一轮确实没有在途会话可推断，就先别发，下一条消息进来时再处理。';

{
  const rawTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    // ① 放宽 key/token 的必填（只在原本就是必填时才动，且不动描述）
    let hasKeyField = false;
    let hasTokenField = false;
    try {
      const shapeIdx = rest.findIndex((x) => x && typeof x === 'object' && !Array.isArray(x)
        && typeof x !== 'function'
        && Object.values(x).some((v) => v && typeof v === 'object' && typeof v.optional === 'function'));
      if (shapeIdx >= 0) {
        const shape = rest[shapeIdx];
        hasKeyField = !!shape.key;
        hasTokenField = !!shape.token;
        const relaxed = { ...shape };
        for (const field of ['key', 'token']) {
          const t = relaxed[field];
          if (t && typeof t.optional === 'function' && typeof t.isOptional === 'function' && !t.isOptional()) {
            relaxed[field] = t.optional();
          }
        }
        rest[shapeIdx] = relaxed;
      }
    } catch { /* 放宽失败就维持原样（最坏情况退回 -32602，与改动前一致） */ }

    const i = rest.map((x) => typeof x === 'function').lastIndexOf(true);
    if (i >= 0) {
      const handler = rest[i];
      rest[i] = async (...args) => {
        // ② 补齐缺的 key/token
        const callArgs = (args[0] && typeof args[0] === 'object') ? args[0] : {};
        /* 【2026-09-18 修「qq_schedule_message 明明传了 key 还报缺 key/token」】
         * 旧写法把两个字段**绑在一起**判断（`hasKeyField || hasTokenField`），于是对
         * "只声明 token、不声明 key"的工具（qq_schedule_message / qq_schedule_list / qq_schedule_cancel
         * 这些用 targetKey 的）会得出 `missingKey = true` —— 因为 zod 解析会把 schema 里
         * **没声明的 `key` 字段直接剥掉**，处理器拿到的 args[0].key 永远是 undefined。
         * 结果：模型照提示传了 key，包装层却认为它没传 → 去问桥"当前在途会话" → 手动测试时没有
         * 在途回合 → 回一句"缺 key/token"，调用整个失败。
         * 现在**两个字段各判各的**：没声明 key 的工具根本不检查 key，只检查 token。 */
        const missingKey = hasKeyField && (callArgs.key === undefined || callArgs.key === null || callArgs.key === '');
        const missingToken = hasTokenField && (callArgs.token === undefined || callArgs.token === null || callArgs.token === '');
        /* 【2026-09-20 根因修复：桥**不再替模型猜 key**（修「pixiv 发图发错群」）】
         * 旧写法在缺 key 时问桥 `/api/social/current-turn`，把"当前在途会话"的 key 填进去 ——
         * 而多会话同时有在途回合时，桥会按"最近活动"挑一个（console-server 的 PICKED-newest-of-N）。
         * 于是：群 A 的人要一张图，模型漏传 key，图就被发进了当时更活跃的群 B / 主人的私聊。
         * 现在唤醒正文每一轮都带 `[Session] group:<群号>` 行（wake-send.js 的 sessionLine），
         * 模型手上一直有确切答案；所以这里**缺 key 直接拒绝并指回那一行**，绝不猜。
         * 只缺 token 仍然照旧补齐（token 不决定发到哪个会话，补错最多是鉴权失败，不会误导目标）。 */
        if (missingKey) {
          console.error(`[napcat-safe] ${name} 缺 key，按新规矩拒绝（不猜会话）`);
          return {
            content: [{
              type: 'text',
              text: '缺 key。唤醒正文第一行区域有一行 `[Session] group:<群号>` 或 `[Session] private:<QQ>` —— '
                + '把那一行里的值照抄进 key 即可（例如 [Session] group:123456 → key="group:123456"）。'
                + '不要凭记忆或用别的会话的 key：桥以前会替你猜目标会话，结果把图片发到过别的群，所以现在缺 key 一律拒绝。'
            }],
            isError: true
          };
        }
        if (missingToken) {
          const got = await resolveMissingSession(String(callArgs.key ?? ''));
          if (got && !got.error && got.token) {
            callArgs.token = got.token;
            console.error(`[napcat-safe] ${name} 缺 token，已按会话补齐（${got.source || 'fallback'}）: ${callArgs.key || '(仅 token)'}`);
          } else {
            console.error(`[napcat-safe] ${name} 缺 token 且无法推断：${got?.error ?? 'unknown'}`);
            return { content: [{ type: 'text', text: MISSING_ARG_HINT }], isError: true };
          }
        }
        if ((hasKeyField && !callArgs.key) || (hasTokenField && !callArgs.token)) {
          return { content: [{ type: 'text', text: MISSING_ARG_HINT }], isError: true };
        }
        // ③ 重复失败短路（见上方常量说明）
        const key = failureKey(name, callArgs);
        const memo = recentFailures.get(key);
        if (memo && Date.now() - memo.at < FAIL_MEMO_MS) {
          console.error(`[napcat-safe] 重复失败短路：${name}`);
          return {
            content: [{ type: 'text', text: `这个调用刚刚已经失败过，失败原因：${memo.text}\n不要用完全相同的参数再试一次（那只会白烧一次上下文）。换个参数、换个工具，或者这次先不做 —— 下一条消息进来时再处理。` }],
            isError: true
          };
        }
        const res = await handler(...args);
        try {
          if (res && res.isError) {
            const text = String(res.content?.[0]?.text ?? '').replace(/\s+/g, ' ').slice(0, 200);
            /* 【2026-09-18】参数类错误**不记进"重复失败短路"**。
             * 主人踩到的：位置卡片第一次漏传 lat/lon → 报"位置卡片需要 lat（纬度）"→ 被记成重复失败 →
             * 第二次**改对了参数**也被短路拦住，回一句"这个调用刚刚已经失败过…别用完全相同参数再试"。
             * 参数错本来就是"改一下就能过"的，挡住重试纯属帮倒忙。 */
            const paramErr = /不能为空|需要 lat|需要 lon|缺少|必须|格式应为|格式错误|仅支持|不支持|不是合法|too (?:small|big)/i.test(text);
            if (!TRANSIENT_RE.test(text) && !paramErr) { recentFailures.set(key, { at: Date.now(), text }); pruneFailures(); }
            else if (paramErr) recentFailures.delete(key);
          } else if (res) {
            recentFailures.delete(key);
          }
        } catch { /* 记账失败不影响工具结果 */ }
        return res;
      };
    }
    return rawTool(name, ...rest);
  };
}

// ── 工具 schema 精简（2026-09-12 起；2026-09-21 升级成「压缩档」）─────────────────────
// 实测（QQ 主会话的 request/header）：tools **72,692 字符 ≈ 22.7k tokens**、system 13.1k 字符 ≈ 3.3k，
// 单次请求合计 ≈ 26k tokens —— 也就是说**每一分钱里 87% 是工具 JSON schema**，
// 而且**每一步都会把这整包重发一次**（靠前缀缓存按缓存读计价，占账单约 61%）。
// 所以"少注册一个用不到的工具"比"把提示词写短几个字"重要两个数量级。
// 复算工具：`node tools/tool-schema-meter.mjs`（会真的起一次本文件、逐个量 schema 尺寸）。
//
// ⚠️ 一个必须记住的事实：`config.json` 里的 `social.tools.*` 开关**根本省不了 schema**。
//    console-server.js 的 `ToolEnabled()` 只在**调用时**返回 403（"工具未启用"），
//    工具描述照样每次全量下发。要真的省，只能**根本不注册** —— 就是这里做的。
//    （交接文档 §4.7b.3 曾写"关掉 = schema 整段消失"，那是错的；本文件是更正。）
//
// 2026-09-21 主人要求「MCP 压缩工具调到 high 档、压缩到 8.6%、并支持管理端切换」：
//   · 档位定义在 lib/tool-tiers.js（off / low / medium / high / custom，含实测百分比与名单）；
//   · 本文件按档位决定**注册哪些**（白名单语义 = 名单外根本不注册）；
//   · 注册完把**实测**结果写 state/tool-schema-stats.json 并打到 stderr ——
//     管理端「工具 schema 精简」卡直接读它显示"当前档位实际留了多少字符、占百分之几"，
//     这样"省了多少"是可验证的数，而不是配置里的一句承诺。
// 开关语义（可一键回退）：
//   `social.slimTools.enabled !== true` → **全部注册**，行为与改动之前**完全一致**；
//   `social.slimTools.level` = off/low/medium/high → 按该档名单；
//   `social.slimTools.level` = custom（或老配置只有 allow/deny）→ 走手写名单：
//        · `deny` 里的工具 **不注册**（黑名单；名单以外的照常注册 → 将来新增工具默认可见，不会"忘了加白名单"）；
//        · `allow` 非空时改成**只注册 allow 里的**（白名单，最省，但新增工具要手动加）。
// 改动这份名单只需要重启隔离 DSH（DSH 启动时向 MCP server 取一次工具表），不用改别的地方。
// 名单里的工具名**允许带或不带 MCP server 前缀**（`mcp__napcat__qq_x` 与 `qq_x` 等价）。
// 踩过的坑：管理端「出厂默认名单」写的是**带前缀**的全名，而这里注册用的是裸名 →
// deny 名单一条都匹配不上 → 实际裁剪 0 个、"省 schema" 静默失效（实测：77 个工具一个没少）。
// 现在两边都归一化，谁写都能生效；`qq_status` 用裸 server.tool 注册，本来就不参与裁剪。
const bareToolName = (n) => String(n).replace(/^mcp__[A-Za-z0-9_-]+__/, '');
const TIER = resolveToolTier(getConfig().social?.slimTools);
const SLIM_ON = TIER.level !== 'off';
// 实测账本：注册期逐个累加（只算进请求体的三样：name / description / inputSchema）。
const schemaMeter = { tools: [], totalChars: 0, keptChars: 0, keptCount: 0 };
const schemaCostOf = (name, description, params) => {
  try { return JSON.stringify({ name, description: description ?? '', inputSchema: params ?? {} }).length; }
  catch { return String(name).length + String(description ?? '').length; }
};
if (SLIM_ON) {
  // stdout 是 MCP 的协议通道，日志一律走 stderr
  console.error(`[napcat-safe] 工具 schema 精简已启用：档位=${TIER.level}（${TIER.source}）`
    + `${TIER.keep ? ` 白名单 ${TIER.keep.size} 个` : TIER.allow ? ` 白名单 ${TIER.allow.size} 个` : TIER.deny ? ` 黑名单 ${TIER.deny.size} 个` : ''}`);
}

/** 注册工具；精简模式下被排除的**直接不注册** —— 它的 JSON schema 从此不出现在任何一次请求里。
 *  同时把尺寸记进 schemaMeter：注册完写一份实测统计给管理端读。 */
function registerTool(name, ...rest) {
  const bare = bareToolName(name);
  const cost = schemaCostOf(name, rest[0], rest[1] && typeof rest[1] === 'object' ? rest[1] : {});
  schemaMeter.tools.push({ name: bare, cost });
  schemaMeter.totalChars += cost;
  if (!toolAllowedByTier(bare, TIER)) return;
  schemaMeter.keptChars += cost;
  schemaMeter.keptCount += 1;
  return server.tool(name, ...rest);
}

/** 把实测结果落盘（管理端「工具 schema 精简」卡读它显示"实际省了多少"）。
 *  MCP server 是 DSH 的子进程，写盘失败绝不能影响工具注册 —— 全部包在 try 里。 */
function flushSchemaStats() {
  try {
    const share = schemaMeter.totalChars > 0 ? schemaMeter.keptChars / schemaMeter.totalChars : 1;
    const payload = {
      at: Date.now(),
      level: TIER.level,
      enabled: SLIM_ON,
      source: TIER.source,
      registered: schemaMeter.keptCount,
      available: schemaMeter.tools.length,
      totalChars: schemaMeter.totalChars,
      keptChars: schemaMeter.keptChars,
      share: Number(share.toFixed(4)),
      savedChars: schemaMeter.totalChars - schemaMeter.keptChars,
      approxTokensPerStep: Math.round(schemaMeter.keptChars / 3.2),
      // 各档位若切过去会是多少（同一份尺寸表算出来的，管理端可以并列显示做选择）
      tiers: Object.fromEntries(Object.entries(TOOL_TIERS).map(([id, def]) => {
        const keep = Array.isArray(def?.keep) ? new Set(def.keep.map(bareToolName)) : null;
        const m = measureSchemaShare(schemaMeter.tools, keep);
        return [id, { label: def?.label ?? id, note: def?.note ?? '', share: Number(m.share.toFixed(4)), keptChars: m.keptChars, keptCount: m.keptCount }];
      })),
      top: [...schemaMeter.tools].sort((a, b) => b.cost - a.cost).slice(0, 12),
    };
    fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true });
    const file = path.join(ROOT, 'state', 'tool-schema-stats.json');
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    console.error(`[napcat-safe] 工具 schema 实测：注册 ${payload.registered}/${payload.available} 个，`
      + `${payload.keptChars}/${payload.totalChars} 字符（${(share * 100).toFixed(1)}%）≈ ${payload.approxTokensPerStep} token/步`);
  } catch (e) {
    console.error(`[napcat-safe] 工具 schema 统计落盘失败（不影响工具）: ${e?.message ?? e}`);
  }
}
process.on('exit', flushSchemaStats);


/* qq_status 走 registerTool（原来直接 server.tool，不进账本）：
 * 它是自检通道、体积只 198 字符，lib/tool-tiers.js 里写死"任何档位都保留"，
 * 但**必须被记进 schemaMeter** —— 否则管理端看到的"全量字符数"少一个工具，百分比就不准。 */
registerTool(
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
          .filter((g) => isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllGroups || a.allowAllWhenEmpty))
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
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllGroups || a.allowAllWhenEmpty)) {
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
    token: z.string().optional().describe('Session token (required in default mode)'),
    crossSession: z.boolean().optional().describe('ONLY when deliberately replying into a different session than the one you are answering; a mismatched key is refused instead of silently sent elsewhere')
  },
  async ({ key, groupId, replyToMessageId, message, token, crossSession }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      // key 优先；模型偶尔用 groupId 老参数 → 转成 group:群号。
      const targetKey = (key && String(key).trim())
        ? String(key).trim()
        : (groupId !== undefined && groupId !== null ? `group:${String(groupId)}` : '');
      if (!targetKey) throw new Error('必须传 key（group:群号 或 private:QQ号）或 groupId');
      const data = await agentApi('/api/social/send-message', {
        method: 'POST',
        body: JSON.stringify({ key: targetKey, messages: cleanMessage, replyToMessageId, token: token || undefined, ...(crossSession === true ? { crossSession: true } : {}) }),
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
    key: z.string().optional().describe('Same as targetKey - accepted as an alias so a copied [Key] line works verbatim; usually omit and pass targetKey'),
    targetKey: z.string().optional().describe('Session key to send to (defaults to current session)'),
    message: z.string().describe('Message content to send when scheduled'),
    at: z.string().optional().describe('Trigger time: ISO string (e.g. 2026-09-02T08:00:00+08:00) or ms/s timestamp'),
    delayMs: z.number().optional().describe('Alternatively, trigger after this many ms from now (at takes precedence)'),
    repeatMs: z.number().optional().describe('Repeat interval in ms; 0 or omitted = one-shot'),
    sourceKey: z.string().optional().describe('Initiating session key (derived from token by default; usually omit)')
  },
  async ({ token, key, targetKey, message, at, delayMs, repeatMs, sourceKey }) => {
    try {
      // key 是 targetKey 的别名（2026-09-18）：模型偶尔会把唤醒正文里的 [Key] 行原样传进来
      const body = { targetKey: targetKey || key || '', message, repeatMs: repeatMs || 0, sourceKey: sourceKey || '' };
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
  'Modify system run config (owner private chat only). Keys: proactiveEnabled; privateProactiveMin / privateProactiveMax (private proactive interval, e.g. 120min or ms) and privateProbability (0 = never proactive in private); groupProactiveMin / groupProactiveMax and groupProbability; idleThresholdMs (dead-air threshold); replyCheckMs (reply-check interval); modelProvider (default xiaomi-token-plan-cn = Xiaomi MiMo), model (e.g. mimo-v2.5, mimo-v2-pro), reasoningEffort (auto/low/medium/high), visionModel (empty = follows the main model), visionBaseUrl (OpenAI-compatible endpoint for a SEPARATE vision model; empty = images are sent to the main model as attachments), visionApiKey (key for that endpoint), permanentSession (true = never rotate the DSH session; context is kept bounded by DSH compaction instead, which saves the first-turn tokens of every new session), compactionEnabled (true = prune oversized tool results before summarizing), compactionThresholdRatio (fraction of the model context window that triggers cleanup, default 0.06), compactionToolResultChars (per tool result character budget, default 1500) - model keys auto-sync, isolated from the DSH default model. value = number or duration string like 30min, 2h. Tell the owner the applied value; non-owner sessions are rejected.',
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
    images: z.array(z.string()).optional().describe('Absolute local paths of static images (e.g. C:\\\\path\\\\xx.webp; meme/ sticker files work too), one per sent item or a single one. Never send animated GIFs by path - QQ shows a flickering static preview; find those with qq_meme_search (GIF set) or qq_list_stickers and send via qq_send_sticker. Only static png/jpg/webp go by path.'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('Message id to quote/reply to (non-zero int, may be negative, optional)'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('QQ id to @ (group chats; needed for at-mentions). This must be a real person\'s QQ NUMBER - never a messageId: ids you would pass to replyToMessageId are NOT QQ numbers, and mixing them up makes the whole send fail. Never hand-write [CQ:at,qq=...] in the message text - it is sent verbatim as garbage. Not together with a quote; do not overuse.'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto = random (bridge default), fixed = interval, byLength = by text length'),
    gapMs: z.number().optional().describe('Interval for fixed mode (ms)'),
    gaps: z.array(z.number()).optional().describe('Per-message intervals for fixed mode (length = count - 1)'),
    crossSession: z.boolean().optional().describe('ONLY for deliberately sending into a DIFFERENT session than the one you are answering (e.g. the owner asks you in private to say something in a group): set true to confirm. key MUST be the [Session] value from the wake prompt you are answering - a wrong key is refused instead of silently sent elsewhere, so only set this when the target really is another chat. Never set it to "fix" a mismatch you did not intend.')
  },
  async ({ key, token, messages, message, images, replyToMessageId, atUserId, gapMode, gapMs, gaps, crossSession }) => {
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
        body: JSON.stringify({ key, messages: finalMessages, images: imgList, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps, ...(crossSession === true ? { crossSession: true } : {}) }),
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
    'View your own default avatar image (the bot account\'s built-in chibi avatar). Call when asked what you look like, to send a selfie, or what your form is; the returned image goes straight into your visual context.',
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


if (cfg.social?.meme?.enabled !== false) {
  registerTool(
    'qq_meme_search',
    'Search the bundled meme packs (local fan-art/GIF sticker archives shipped with the bot, one folder per pack). query = an emotion/content description (e.g., angry, crying, sleeping); every hit is returned as "file_name [tag] [packId] caption". Send the chosen one with qq_send_meme. When the owner has uploaded their own packs, their packs are searched together with the built-in one.',
    {
      query: z.string().describe('Query: emotion/content description, e.g., 生气、哭、睡觉、开心、疑惑'),
      tag: z.string().optional().describe('Filter by category: happy/angry/sad/shy/confused/surprised/sigh/sleep/daily/love/work'),
      pack: z.string().optional().describe('Search one pack only, by the packId shown in results; omit to search every pack the owner allows'),
      limit: z.number().optional().describe('Max results returned; default 8')
    },
    async ({ query, tag, pack, limit }) => {
      try {
        const packs = orderedMemePacks(getConfig());
        if (!packs.length) return { content: [{ type: 'text', text: memeMissingHint }] };
        const only = String(pack ?? '').trim();
        if (only && !packs.some((p) => p.id === only)) {
          return { content: [{ type: 'text', text: `没有叫 ${only} 的表情包。现在能用的是：${packs.map((p) => p.id).join(', ')}` }], isError: true };
        }
        const q = String(query ?? '').trim();
        const tg = String(tag ?? '').trim().toLowerCase();
        const n = Math.min(20, Math.max(1, Number(limit) || 8));
        const { DatabaseSync } = await import('node:sqlite');
        const rows = [];
        let broken = 0;
        for (const p of packs) {
          if (rows.length >= n) break;
          if (only && p.id !== only) continue;
          let db;
          try { db = new DatabaseSync(path.join(p.dir, 'index.db'), { readOnly: true }); } catch { broken += 1; continue; }
          try {
            let sql = 'SELECT file_name, tag, caption, keywords FROM memes WHERE 1=1';
            const params = [];
            if (tg) { sql += ' AND tag = ?'; params.push(tg); }
            if (q) { sql += ' AND (caption LIKE ? OR keywords LIKE ?)'; params.push('%' + q + '%', '%' + q + '%'); }
            sql += ' LIMIT ?'; params.push(n - rows.length);
            for (const r of db.prepare(sql).all(...params)) rows.push({ ...r, packId: p.id });
          } catch { broken += 1; } finally { try { db.close(); } catch { /* 只读句柄，关不掉不影响结果 */ } }
        }
        if (!rows.length) return { content: [{ type: 'text', text: `没找到匹配的表情，试试：生气/哭/睡觉/开心/疑惑/害羞/干活/日常` }] };
        const lines = rows.map((r, i) => `${i + 1}. ${r.file_name} [${r.tag}] [${r.packId}] ${r.caption}`).join('\n');
        const used = [...new Set(rows.map((r) => r.packId))];
        const tailNote = broken ? `\n（另有 ${broken} 份表情包读不出来，已跳过）` : '';
        return { content: [{ type: 'text', text: `找到 ${rows.length} 张表情（来自 ${used.join(', ')}）：\n${lines}${tailNote}` }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `搜索失败：${error.message}` }], isError: true };
      }
    }
  );
}

if (cfg.social?.meme?.enabled !== false) {
  registerTool(
    'qq_send_meme',
    'Send one meme from the bundled meme packs to a QQ session. file = the file_name returned by qq_meme_search (a meme file name is its description note); pass pack as well when two packs contain the same file_name. Send the image directly with no preceding text; replyToMessageId optionally makes it a quoted reply.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token'),
      file: z.string().describe('Meme file name from qq_meme_search, e.g., 蓝发女仆生气.webp; "<packId>/<file_name>" also works'),
      pack: z.string().optional().describe('Pack id shown in qq_meme_search results; only needed when several packs contain the same file_name'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('Optional: message id to quote/reply to'),
      crossSession: z.boolean().optional().describe('ONLY when deliberately posting into a different session than the one you are answering; a key that is not this session\'s is refused otherwise')
    },
    async ({ key, token, file, pack, replyToMessageId, crossSession }) => {
      try {
        const packs = orderedMemePacks(getConfig());
        if (!packs.length) return { content: [{ type: 'text', text: memeMissingHint }] };
        // file 允许写成 "<packId>/<文件名>"（搜索结果里的 [packId] 就是它）
        let wantPack = String(pack ?? '').trim();
        let wantFile = String(file ?? '').trim();
        const slashAt = wantFile.indexOf('/');
        if (!wantPack && slashAt > 0) {
          const maybePack = wantFile.slice(0, slashAt);
          if (packs.some((p) => p.id === maybePack)) { wantPack = maybePack; wantFile = wantFile.slice(slashAt + 1); }
        }
        const { DatabaseSync } = await import('node:sqlite');
        const hits = [];
        for (const p of packs) {
          if (wantPack && p.id !== wantPack) continue;
          let db;
          try { db = new DatabaseSync(path.join(p.dir, 'index.db'), { readOnly: true }); } catch { continue; }
          try {
            const rel = queryMemePath(db, wantFile);
            if (rel) hits.push({ pack: p, rel });
          } catch { /* 坏包跳过：一个包读不出来不该让发图整个失败 */ } finally { try { db.close(); } catch { /* 只读句柄，关不掉不影响发图 */ } }
        }
        if (!hits.length) return { content: [{ type: 'text', text: `找不到表情 ${file}${wantPack ? `（包 ${wantPack}）` : ''}，请先用 qq_meme_search 搜索` }], isError: true };
        // 多份包都有同名文件时按优先级取第一份（角色专属包排在最前），并把这件事如实告诉模型
        const hit = hits[0];
        const otherPacks = hits.slice(1).map((h) => h.pack.id);
        const filePath = path.join(hit.pack.dir, hit.rel.replace(/\\/g, '/'));
        if (!fs.existsSync(filePath)) return { content: [{ type: 'text', text: `图片文件不存在：${filePath}（包 ${hit.pack.id} 的表里有它，磁盘上没有）` }], isError: true };
        // NapCat 需读它**自己能读到**的路径：先复制到配置的临时目录（服务器指向 NapCat 容器的
        // 宿主挂载目录），再用 napcatImageFileArg 按 dockerPathMap 换成容器内路径 / base64。
        // 【2026-09-15】此前直接把宿主绝对路径交给 NapCat，服务器（Docker）报
        // 「文件处理失败: 识别URL失败」→ 主人看到的是"表情包一张都发不出去"。
        const tmpDir = path.join(ROOT, 'state', 'sticker-tmp');
        const cfgMeme = getConfig();
        const wantTmpDir = String(cfgMeme?.napcat?.tmpDir ?? '').trim() || tmpDir;
        fs.mkdirSync(wantTmpDir, { recursive: true });
        const tmpName = `${Date.now()}-meme-${path.basename(hit.rel || 'meme.webp')}`;
        const tmpPath = path.join(wantTmpDir, tmpName);
        fs.copyFileSync(filePath, tmpPath);
        const napcatPath = napcatImageFileArg(tmpPath, cfgMeme);
        const [kind, id] = key.split(':');
        const hasQuote = replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '';
        // 带引用时统一走桥的发送端点：它用 resolveReplyTarget 把「本地 seq」和「真实 QQ message id」
        // 都解析成真正可引用的 id，并顺带做限频/防重复/会话记录。此前这里直接把模型给的原始值当
        // QQ message id 塞进 reply 段 —— 模型传了本地 seq 或过期 id 时 NapCat 照常受理，但 QQ 端
        // 不显示引用框，工具却回报成功，正是用户看到的"引用失败"。
        if (hasQuote) {
          const data = await agentApi('/api/social/send-message', {
            method: 'POST',
            body: JSON.stringify({ key, messages: [], images: [tmpPath], replyToMessageId, ...(crossSession === true ? { crossSession: true } : {}) }),
            headers: { 'x-agent-token': token },
            timeoutMs: 120000
          });
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, file: wantFile, pack: hit.pack.id, ...(otherPacks.length ? { sameNameAlsoIn: otherPacks } : {}), quoted: data?.quoted ?? null, sent: data?.sent ?? null, via: 'bridge' }, null, 2) }] };
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
          body: JSON.stringify({ key, token, tool: kind === 'private' ? 'sendPrivate' : 'sendGroup', ...(crossSession === true ? { crossSession: true } : {}) }),
          timeoutMs: 15000
        });
        let data;
        try {
          data = await onebot(action, params);
        } catch (eSend) {
          // 【2026-09-15 自愈】NapCat 读不到图片路径（Docker 容器读不到宿主路径）→ 换 base64 重发一次。
          // 该错误 = 整条消息没发出去，重发不会重复（服务器实测报「文件处理失败: 识别URL失败」）。
          const em = String(eSend?.message ?? eSend);
          if (!/文件处理失败|识别URL失败|ENOENT|no such file/i.test(em)) throw eSend;
          const imgSeg = msg.find((s) => s.type === 'image' && typeof s.data?.file === 'string' && !/^(base64|file|https?):\/\//i.test(s.data.file));
          if (!imgSeg) throw eSend;
          imgSeg.data.file = `base64://${fs.readFileSync(tmpPath).toString('base64')}`;
          data = await onebot(action, params);
        }
        const messageId = data?.data?.message_id ?? data?.message_id ?? null;
        // 登记到桥接会话：让 AI 记住自己发过这张表情、可被 qq_withdraw_message 撤回（含 (id:xxx) 展示）
        try {
          if (messageId != null && token) {
            await agentApi('/api/social/record-own-sent', {
              method: 'POST',
              body: JSON.stringify({ key, messageId: String(messageId), text: `[表情:${wantFile}]`, token }),
              headers: { 'x-agent-token': token },
              timeoutMs: 10000
            });
          }
        } catch (regError) {
          // 登记失败不影响发送本身
        }
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, file: wantFile, pack: hit.pack.id, ...(otherPacks.length ? { sameNameAlsoIn: otherPacks } : {}), messageId }) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送失败：${error.message}` }], isError: true };
      }
    }
  );
}

registerTool(
  'qq_send_voice',
  'Send a spoken (voice) message to a QQ session: the text is synthesized into real speech with the configured voice and sent as a QQ voice bubble. Use it ONLY when a voice is actually wanted (the owner or the conversation asks you to speak / sing / say it out loud, or the session is in a voice mood) - normal replies stay text, and voice is not a substitute for answering. text = what to say (short, one breath; over the configured limit it is rejected). voice = LEAVE IT OUT unless someone explicitly asks for a specific voice: omitting it uses the owner\'s configured default voice (the wake body\'s [Voice] line shows it as default voice=<name>). Never substitute a built-in voice on your own initiative - 冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean are only for when that exact voice is asked for. If you do pass one: a built-in id or a saved custom voice id/name. style = optional one-sentence delivery direction (e.g. 轻轻的，带一点笑意). mode = tts (default, built-in voice) | design (with description = a voice description, synthesizes that voice) | clone (voice = a saved clone voice). replyToMessageId optionally quotes a message - but the bridge DROPS it for voice (QQ renders a reply+voice message as an empty bubble with just the quote box), so when you actually need to quote someone, say it with qq_reply/qq_send_message as text instead.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token (from the wake prompt)'),
    text: z.string().describe('What the voice should say (short; Chinese works best)'),
    voice: z.string().optional().describe('LEAVE EMPTY to use the owner\'s configured default voice. Only pass a voice when one is explicitly requested: built-in (冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean) or a saved custom voice'),
    style: z.string().optional().describe('Optional delivery direction, one sentence, e.g. 轻轻的，带一点笑意'),
    mode: z.enum(['tts', 'design', 'clone']).optional().describe('tts = built-in voice (default); design = voice described by text; clone = saved cloned voice'),
    description: z.string().optional().describe('Only for mode=design: the voice description'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('Optional: message id to quote/reply to')
  },
  async ({ key, token, text, voice, style, mode, description, replyToMessageId }) => {
    try {
      const data = await agentApi('/api/voice/send', {
        method: 'POST',
        body: JSON.stringify({ key, text, voice, style, mode, description, replyToMessageId }),
        headers: { 'x-agent-token': token },
        timeoutMs: 180000
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送语音失败：${error?.message ?? error}（语音发不出去时改用文字回复，不要反复重试）` }], isError: true };
    }
  }
);

registerTool(
  'qq_transcribe_voice',
  'Transcribe (speech to text) a voice message someone sent, so you know what was actually said. Call it whenever the text shows [语音] and the content matters. messageId = that voice message\'s id (from qq_get_unread_messages / qq_get_recent_messages / (id:xxx)). Never guess or make up what a voice message said.',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token (from the wake prompt)'),
    messageId: z.union([z.number(), z.string()]).describe('Message id of the voice message')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi('/api/voice/transcribe', {
        method: 'POST',
        body: JSON.stringify({ key, messageId }),
        headers: { 'x-agent-token': token },
        timeoutMs: 180000
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `语音识别失败：${error?.message ?? error}` }], isError: true };
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

if (cfg.social?.tools?.memoryRemember !== false) {
  /* 【2026-09-21 记忆架构升级】长期记忆的**写入**入口。
   * 与 qq_profile_set（结构化档案）分工：档案是"这个人是什么样"，这里是"我必须一直记得的一件事"
   * （主人定的规矩、承诺、重要事件）。tier=permanent 的条目会**每一轮**出现在唤醒正文的 [Recall] 里，
   * 所以写进去的必须是"值得每轮都读一遍"的一句话 —— 提示词里写死了这条纪律。 */
  registerTool(
    'qq_memory_remember',
    'Write ONE durable long-term memory (rule / fact / promise about a person) so it survives context rotation. Use when the owner states a standing rule ("以后都这样" / "别再…" / "记住…"), corrects you, or a lesson cost real pain. tier: permanent = never fades and shows in every wake (use for owner rules/identity); durable = default, fades after ~90 idle days; working = short-lived. Never store secrets, tokens or private/intimate content, never a chat log. One sentence per call.',
    {
      content: z.string().describe('ONE sentence, concrete and self-contained (no pronouns like "he" without a name)'),
      token: z.string().describe('Session token'),
      key: z.string().optional().describe('Session key; omit to let the bridge pick (private chat = that person, group = the owner)'),
      tier: z.enum(['permanent', 'durable', 'working']).optional().describe('permanent = never fades + injected every wake; durable = default; working = fades in ~7 days'),
      category: z.string().optional().describe('Short label: rule / owner / identity / fact / event / note (default note)'),
      pin: z.boolean().optional().describe('true = pin it (same effect as tier=permanent: never fades, injected every wake)'),
      tags: z.string().optional().describe('A few keywords for later recall, comma separated')
    },
    async ({ content, token, key, tier, category, pin, tags }) => {
      try {
        const q = new URLSearchParams({ content });
        if (key) q.set('key', key);
        if (tier) q.set('tier', tier);
        if (category) q.set('category', category);
        if (pin) q.set('pin', '1');
        if (tags) q.set('tags', tags);
        const data = await agentApi(`/api/social/memory-remember?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 15000 });
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `写长期记忆失败：${error?.message ?? error}` }], isError: true };
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
    'Send native rich interactive cards: music, video (B站/抖音… link card), contact (contact card), dice/rps (dice / rock-paper-scissors). MUSIC: pass ONLY type=music + musicType=163 + musicId=<the NetEase song id from qq_music_search> - the bridge resolves title/artist/cover/audio itself and builds the whole card (https cover + 300x300 thumbnail, the shape that renders on mobile QQ as well); if the card cannot be sent the bridge automatically falls back to the official song link and the result says music.card=link. NEVER hand-write card fields (image/title/audio/url): a hand-written cover is exactly what makes mobile QQ show a blank card. musicType=qq (QQ Music) is also built by the bridge now: pass type=music + musicType=qq + musicId=<songmid from qq_music_search> + title=<song name> (and content=<artist> if you have it) - the bridge resolves the playable link/cover itself and sends a real music card; if it cannot resolve them it automatically sends the official share link instead and the result says music.card=link. VIDEO: pass ONLY type=video + videoUrl=<the bilibili/douyin link or a bare BV id> - the bridge resolves title/uploader/cover/duration/play-count; for bilibili/weibo it asks NapCat for a real mini-program Ark (com.tencent.miniapp_01, QQ-server-signed) so the result is the same 哔哩哔哩 card a human gets when sharing from B站, and only if that fails does it fall back to cover-image + share text (video.card=native/cover+link); other platforms send cover + share text. If resolving fails it still sends the link as text and the result says video.card=link, so never send both the card and the link yourself.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token'),
      type: z.enum(['music', 'video', 'contact', 'location', 'dice', 'rps']).describe('Card type: music (NetEase real card / QQ Music real card built by the bridge), video (bilibili/weibo = a REAL mini-program card the bridge asks QQ to sign; douyin/YouTube/X = cover + share link), contact=contact card, location=share a place (needs lat+lon, locTitle/locContent optional) - sent as an AMap rich-text card (the same com.tencent.tuwen.lua card a human gets when sharing a place from 高德地图) plus a text line with the place name and a 高德 map link, dice, rps=rock-paper-scissors'),
      musicType: z.enum(['qq', '163', 'kugou', 'migu', 'kuwo', 'custom']).optional().describe('musicType: 163=NetEase (real music card, built by the bridge), qq=QQ Music (also built by the bridge; needs title, falls back to the official share link), kugou/kuwo/migu/custom=other platforms (custom needs musicUrl+image, last resort)'),
    // 【2026-09-19 主人定稿·硬规则】封面必须由调用方传进来 —— 实测同一个 musicId，传了 image 封面就正常、
    // 不传就空白（手机端尤其明显）。所以音乐卡一律要带 image（用 qq_music_search 返回的 cover 原样传）。
      musicId: z.union([z.number(), z.string()]).optional().describe('Platform music id: 163=song id from qq_music_search, qq=songmid. This is the ONLY music field you normally pass.'),
      musicUrl: z.string().optional().describe('Only for musicType=custom/kugou/kuwo/migu: the click-through song URL.'),
      audio: z.string().optional().describe('Only for custom platforms - leave empty for 163 (the bridge resolves it).'),
      title: z.string().optional().describe('LEAVE EMPTY for 163/qq - the bridge reads the real title itself. Only for custom platforms.'),
      image: z.string().optional().describe('Cover URL - OPTIONAL and normally LEAVE IT OUT. The bridge resolves the cover itself for 163/qq (matched to the song id, and it checks the image actually loads before using it), which is the only reliable way to get the RIGHT cover. Only pass this when the bridge cannot resolve one at all, and copy it verbatim from the cover field of the SAME song in qq_music_search - NEVER reuse a cover URL that appears in another message or an earlier card (that is how a card ends up showing a different song\'s cover).'),
      content: z.string().optional().describe('Artist/description - custom platforms only.'),
      videoUrl: z.string().optional().describe('VIDEO only: the video link or bare id - bilibili (https://www.bilibili.com/video/BV..., https://b23.tv/xxx, or just BV1xx411c7mD) or douyin (https://v.douyin.com/xxx, https://www.douyin.com/video/ID). This is the ONLY video field you normally pass; the bridge resolves the title/uploader/cover itself. Do NOT hand-write video title/cover.'),
      contactType: z.enum(['qq', 'group']).optional().describe('Contact card type'),      contactId: z.union([z.number(), z.string()]).optional().describe('Contact QQ number or group number'),
      result: z.union([z.number(), z.string()]).optional().describe('dice/rps result (optional)'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('Message id to quote (optional)'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('QQ number of group member to @ (optional; group chats)')
    },
    async ({ key, token, type, musicType, musicId, musicUrl, audio, title, image, content, videoUrl, contactType, contactId, lat, lon, locTitle, locContent, data, result, replyToMessageId, atUserId }) => {
      try {
        const body = { key, type };
        if (musicType) body.musicType = musicType;
        if (musicId !== undefined && musicId !== null) body.musicId = musicId;
        if (musicUrl) body.musicUrl = musicUrl;
        if (videoUrl) body.videoUrl = videoUrl;
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
    'Search songs (overseas-reachable NetEase music.163.com / QQ Music c.y.qq.com); returns platform/title/artist/album/link/cover per song (NetEase covers are resolved to https + a 300x300 thumbnail, so they load on mobile too). TO SHARE A SONG: pick a result and call qq_send_rich with ONLY {type:"music", musicType:"163", musicId:"<the NetEase id>"} - the bridge resolves the fields and builds the card; if the card cannot be sent it automatically sends the official song link instead and the result says music.card=link. So never hand-write card JSON or cover URLs, and never send both the card and the link for the same song. QQ Music results (platform=qqmusic) are shared with qq_send_rich {type:"music", musicType:"qq", musicId:"<the id>", title:"<the title>", content:"<the artist>"} — the bridge resolves the playable link and builds the card itself, and falls back to the song link if it cannot.',
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

// ── 视频：看链接 / 搜视频 / 发视频卡片（bridge 侧解析，模型不碰卡片字段）──
if (cfg.social?.tools?.videoSearch !== false) {
  registerTool(
    'qq_video_parse',
    'Look up ONE video link (read-only, no sending): returns platform / title / uploader / duration / play count / cover / description for bilibili (https://www.bilibili.com/video/BV..., https://b23.tv/xxx, or a bare BV id) and douyin (https://v.douyin.com/xxx) links. CALL THIS whenever someone drops a video link or asks "这个视频讲了啥 / 看看这个 / 这什么视频" - never guess from the URL alone. When it returns degraded:true (douyin pages are JS-rendered and signed, so the title/cover may be unavailable), just say you cannot see the content instead of inventing it. To actually SHARE a video into the chat afterwards, call qq_send_rich with type=video + videoUrl (do not paste the link as text if a card is wanted).',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token'),
      url: z.string().describe('The video link, or a bare BV id like BV1xx411c7mD'),
    },
    async ({ key, token, url }) => {
      try {
        const q = new URLSearchParams({ key, url: String(url ?? '') });
        const data = await agentApi(`/api/social/video-parse?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 30000 });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `视频解析失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  registerTool(
    'qq_video_search',
    'Search bilibili videos by keyword (read-only): returns bvid / title / uploader / duration / play count / cover / link per hit. Use it to find a specific video to share, or to answer "帮我找个关于X的视频". To send one of the hits, call qq_send_rich with type=video + videoUrl="<the link or bvid from the result>" - the bridge builds the card, so never hand-write title/cover.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token'),
      query: z.string().describe('Search keyword'),
      limit: z.number().optional().describe('How many results, default 8, max 20'),
    },
    async ({ key, token, query, limit }) => {
      try {
        const q = new URLSearchParams({ key, q: String(query ?? '') });
        if (limit) q.set('limit', String(limit));
        const data = await agentApi(`/api/social/video-search?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 30000 });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `搜索视频失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

/* ── 联网找图 / 发图（2026-09-18 主人要求："支持联网找图并发图"）──────────────
 * 分工：qq_image_search 只查不发（把候选 URL 摆给模型看）；qq_send_image 负责真发。
 * qq_send_image 可以只给 query（自己搜第一张就发），也可以给 imageUrl（直接发这个链接）。
 * 下载走 safeFetchBuffer：禁内网/本机地址、限制 15MB（MAX_IMAGE_FETCH_BYTES，原为写死的 8MB，
 * 定标依据见 safe-fetch.js 顶部注释）、并且**验证确实是图片**（不是伪装成图片的 HTML）。
 * 落盘落到 napcat 的 tmpDir（就是 NapCat 容器/进程能读到的那份），再走桥的统一发送端点。 */
if (cfg.social?.tools?.imageSearch !== false) {
  registerTool(
    'qq_image_search',
    'Search images on the web by keyword (read-only, sends nothing): returns candidate {title, imageUrl, thumbUrl, pageUrl, source} from Bing Images and Baidu Images. Use it when someone asks for a picture ("来张XX的图 / 找张图 / 发个XX的照片"), when a reply would land better with an image, or to look at what a thing looks like before describing it. THEN call qq_send_image with the SAME query (it will pick the top hit) or with a specific imageUrl from this list. Never invent image URLs.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token'),
      query: z.string().describe('What to look for, e.g. 蓝鲸 高清 / 猫娘 表情包 / deepseek logo'),
      limit: z.number().optional().describe('How many candidates, default 8, max 20'),
      source: z.enum(['bing', 'baidu']).optional().describe('Only use one engine (default: both)'),
    },
    async ({ query, limit, source }) => {
      try {
        const r = await searchImages(query, { limit, source });
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `找图失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  registerTool(
    'qq_send_image',
    'Find an image online and SEND it to a QQ session as a real picture. Pass EITHER query (the bridge searches for it and sends the best hit - the normal case: someone asks 来张XX的图) OR imageUrl (a URL you already got from qq_image_search). index picks which search hit to send (0 = first, default). The image is downloaded with SSRF protection, size-capped and verified to be a real image; nothing is written outside the NapCat temp dir. Prefer ONE image per request - do not spam several pictures in a row unless asked.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token'),
      query: z.string().optional().describe('Search keyword (used when imageUrl is not given)'),
      imageUrl: z.string().optional().describe('Direct image URL (from qq_image_search). Takes precedence over query.'),
      index: z.number().optional().describe('Which search hit to send when using query, 0-based, default 0'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('Optional: message id to quote/reply to'),
    },
    async ({ key, token, query, imageUrl, index, replyToMessageId }) => {
      try {
        let url = String(imageUrl ?? '').trim();
        let picked = null;
        if (!url) {
          const q = String(query ?? '').trim();
          if (!q) return { content: [{ type: 'text', text: '要么给 query（关键词），要么给 imageUrl（图片直链）' }], isError: true };
          const r = await searchImages(q, { limit: 10 });
          picked = r.results[Math.max(0, Number(index) || 0)] || r.results[0];
          if (!picked) return { content: [{ type: 'text', text: `没搜到「${q}」的图片（失败源：${JSON.stringify(r.failures)}）。换个更具体的说法再试。` }] };
          url = picked.imageUrl;
        }

        const got = await safeFetchBuffer(url, MAX_IMAGE_FETCH_BYTES);
        const buf = got.buffer;
        const ext = buf[0] === 0x89 ? 'png'
          : buf[0] === 0xff ? 'jpg'
            : buf.toString('ascii', 0, 3) === 'GIF' ? 'gif'
              : 'webp';

        const cfgImg = getConfig();
        const tmpRoot = String(cfgImg?.napcat?.tmpDir ?? '').trim() || path.join(ROOT, 'state', 'image-tmp');
        fs.mkdirSync(tmpRoot, { recursive: true });
        const tmpPath = path.join(tmpRoot, `${Date.now()}-webimg-${Math.random().toString(36).slice(2, 8)}.${ext}`);
        fs.writeFileSync(tmpPath, buf);

        const body = { key, messages: [], images: [tmpPath] };
        const rid = replyToMessageId !== undefined && replyToMessageId !== null ? String(replyToMessageId).trim() : '';
        if (rid) body.replyToMessageId = rid;
        const data = await agentApi('/api/social/send-message', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'x-agent-token': token },
          timeoutMs: 120000,
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: true,
              from: picked ? 'search' : 'url',
              query: picked ? String(query) : undefined,
              title: picked?.title || '',
              imageUrl: got.url || url,
              bytes: buf.length,
              format: ext,
              sent: data?.sent ?? null,
              quoted: data?.quoted ?? null,
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `发图失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

/* ── Pixiv 找图 / 发图（2026-09-18 主人要求："支持搜索和下载 Pixiv 的图片，不用到官网"）──────
 * 【2026-09-20 主人定调：官方 pixiv API 优先，第三方镜像站 x.pixigraph.xyz 只做兜底】
 *   每条能力都按 app-api（OAuth 长期令牌，见 lib/pixiv-auth.js）→ pixiv web ajax → 镜像站 的顺序试；
 *   结果里如实报出这次是谁供的数据（搜索的 source/sourcesTried、详情的 source）。细节见 lib/pixiv.js 顶部。
 * 分工与"联网找图"完全同构：qq_pixiv_search 只查不发，qq_send_pixiv 负责真发。
 * 下载仍走 safeFetchBuffer（禁内网、限 15MB、校验确实是图片），落盘到 napcat.tmpDir 再走统一发送端点。
 *
 * 【2026-09-18 加本地筛选 + 自动翻页（方案 A：不登录、不用会员、不加部署）】
 *   实测镜像站只认 keyword / page（mode=s_mode=order=bl=type= 全部被忽略），所以标签/构图/尺寸/AI/
 *   时间排序这些筛选**只能在桥本地做**（三个来源先归一成同一行形状再筛，见 lib/pixiv.js）；
 *   本地筛就要多翻几页才凑得齐 → 有 scanPages。
 *   参数含义、取值与"做不到"的边界全写在每个 .describe() 里（工具描述是模型唯一的说明书），
 *   实现细节与实测依据见 lib/pixiv.js；回归自测见 tools/test-pixiv-filters.mjs。 */
if (cfg.social?.tools?.pixiv !== false) {
  registerTool(
    'qq_pixiv_search',
    'Search Pixiv illustrations by keyword (read-only, sends nothing). Returns {id, title, author, tags, pageUrl, thumbUrl, pages, size} per work - Pixiv is where most anime/game fan art lives, so use it when someone asks for an illustration / original picture / fan art of a character (e.g. 初音ミク, 原神 荧, 蔚蓝档案 白子) or when web image search gave you low-quality or unrelated results. THEN call qq_send_pixiv with the SAME query (index picks which hit, 0 = first) - never invent Pixiv URLs.'
      + '\n\n[SOURCES] The bridge queries the **official Pixiv API first** (app-api, then pixiv.net ajax) and only falls back to a third-party mirror when both fail; every result says which source served it (result.source / scan.source, plus sourcesTried when a source failed).'
      + '\n\n[LOCAL FILTERING AND PAGING] tags / author / orientation / minWidth / minHeight / multiPage / excludeAi / illustType / sort / r18 / scanPages are all filtered **locally** on the fetched rows (no source accepts tag/sort parameters). One page is 60 works (30 via app-api), at most scanPages pages are scanned (default 3, cap 10); the scan object and scanNotice in the result state honestly which pages were scanned, the site-wide total (0/unknown when the source does not report one) and the last page - **never present that as "I filtered the whole site"**. Sorting only supports upload time (date_desc newest first / date_asc / random), **not popularity or bookmark count** (no source returns bookmark counts; passing it falls back to date_desc and says so in scan.warnings). R-18/R-18G is excluded by default; only an explicit r18=only/include lets it through.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token'),
      query: z.string().describe('Keyword, e.g. 初音ミク / 原神 荧 / ブルーアーカイブ. A keyword is not a tag - use the tags parameter to filter by tag'),
      page: z.number().optional().describe('Which page to start from (1-based, default 1). It is only the starting point; scanPages walks forward from here'),
      limit: z.number().optional().describe('Max rows to return, default 8, cap 20'),
      r18: z.enum(['exclude', 'only', 'include']).optional().describe('How to treat R-18/R-18G: exclude = drop them (default, safe to post in QQ) / only = R-18 only / include = both. Omitted means exclude. Filtered locally (no source accepts a mode=r18 parameter); anonymous sources mostly return all-ages works for a plain search, so "only" is often empty'),
      tags: z.array(z.string()).optional().describe('Tags that must **all** match - case-insensitive substring match, e.g. ["初音ミク","VOCALOID"]. Passing this enables local filtering'),
      author: z.string().optional().describe('Author: a name -> case-insensitive substring match on userName; pure digits -> exact userId match'),
      orientation: z.enum(['portrait', 'landscape', 'square']).optional().describe('Shape: portrait = taller than wide / landscape = wider than tall / square (uses the original width/height; works missing either dimension never match)'),
      minWidth: z.number().optional().describe('Minimum width in pixels (original width); narrower works are dropped. Use it when you want a high-resolution image, e.g. 2000'),
      minHeight: z.number().optional().describe('Minimum height in pixels (original height); shorter works are dropped'),
      multiPage: z.boolean().optional().describe('true = only multi-image works (pageCount>1): for sets / series, or manga with panels'),
      excludeAi: z.boolean().optional().describe('true = drop AI-generated works (aiType=2, plus an AI-tag fallback; measured: aiType=2 is AI, 1 is hand-drawn)'),
      illustType: z.enum(['illust', 'manga']).optional().describe('Only illustrations (illust, illustType=0) or manga (manga, illustType=1). illustType=2 animations (ugoira) belong to neither and are excluded by both values'),
      sort: z.enum(['date_desc', 'date_asc', 'random']).optional().describe('Order: date_desc = newest first (default) / date_asc = oldest first / random (useful for "just give me any"). **Popularity / bookmark sorting is not supported** - no source returns a bookmark count; popular/hot/rank fall back to date_desc with the reason written into scan.warnings'),
      scanPages: z.number().optional().describe('How many pages to walk forward looking for matches: default 3, cap 10 (clamped). Filtering is local and a page holds only 60 works (30 via app-api), so too few hits means walking further; scan.pagesScanned is the real number of pages scanned - few results does not mean the site has few'),
    },
    async ({ query, page, limit, r18, tags, author, orientation, minWidth, minHeight, multiPage, excludeAi, illustType, sort, scanPages }) => {
      try {
        const r = await pixivSearch(query, {
          page, limit, r18, tags, author, orientation, minWidth, minHeight, multiPage, excludeAi, illustType, sort, scanPages,
        });
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Pixiv search failed: ${error?.message ?? error}` }], isError: true };
      }
    }
  );

  registerTool(
    'qq_send_pixiv',
    'Find a Pixiv illustration and SEND it to a QQ session as a real picture. Give illustId (a Pixiv work id / pixiv.net link you already know), authorId (an artist user id or an artist name - the bridge looks the id up itself), or query (the bridge searches Pixiv and sends the best hit). index picks which hit / which work of that artist (0 = first). size defaults to **original** on all three paths (the untouched original file); pass size=master for the 1200px jpg. Prefer ONE image per request. The bridge skips R-18/R-18G works.'
      + '\n\n[WORKS BY ONE SPECIFIC ARTIST] A keyword search matches titles/tags that contain the word (searching an artist name usually returns works other people tagged with that name). ① You have a work id -> illustId; ② you have an artist id (pixiv.net/users/<digits>) -> authorId, newest first, index picks which work; ③ you only have an artist **name** -> pass it as authorId anyway: the bridge resolves ids by name itself (official user search; ambiguous names come back as candidates for you to choose from) - **never ask the user for an artist id**; ④ neither -> send any one of their works first, the returned authorId is the artist id. Never pass an artist id as illustId.'
      + '\n\n[LOSSLESS ORIGINAL] size=original sends the Pixiv original file itself (per-page urls from the official API when available, downloaded from pximg, stored byte-for-byte, no scaling, no re-encode, no second compression; the returned sha256/bytes are exactly the bytes that were sent). master is the 1200px jpg. An original over 15MB is refused (the result says so) - use size=master.'
      + '\n\n[SOURCES] The bridge queries the **official Pixiv API first** (app-api, then pixiv.net ajax) and only falls back to a third-party mirror when both fail; the result reports pixivSource (which API gave the metadata) and fetchedVia (pximg-direct or mirror-proxy).'
      + '\n\n[LOCAL FILTERING AND PAGING] tags / author / orientation / minWidth / minHeight / multiPage / excludeAi / illustType / sort / scanPages are filtered **locally** on the fetched rows; one page is 60 works (30 via app-api), at most scanPages pages (default 3, cap 10), and index picks from the **filtered** list. To inspect the filtering first (how many dropped, pages scanned, candidates) use qq_pixiv_search. Sorting supports upload time only (date_desc/date_asc/random), **not popularity/bookmarks**. This tool **always excludes R-18/R-18G** (it deliberately has no r18 parameter, so unsuitable content cannot be posted into QQ); use qq_pixiv_search if you need to see R-18.',
    {
      key: z.string().describe('Session key: group:ID or private:QQ'),
      token: z.string().describe('Session token'),
      query: z.string().optional().describe('Search keyword (used when no illustId/authorId is given), e.g. 初音ミク 壁纸. Note: a keyword search matches tags/titles and cannot find "works by this specific person" - use authorId for that'),
      illustId: z.string().optional().describe('A Pixiv **work id** or a pixiv.net/artworks/<digits> link (NOT an artist id). Sends that exact work; every other search/filter parameter is ignored and size defaults to original'),
      authorId: z.string().optional().describe('Artist: an **artist id** (pixiv.net/users/<digits>, or the bare number) OR an artist **name** - the bridge looks the id up by name itself via the official user search, so never ask the user for an id. Sends that artist\'s work number `index`, newest first; an ambiguous name returns candidates instead of guessing. Mutually exclusive with illustId; other filter parameters are ignored'),
      index: z.number().optional().describe('Zero-based pick (default 0): with authorId = which work of that artist, newest first; with query = which filtered search hit'),
      size: z.enum(['master', 'original']).optional().describe('Default **original** (the Pixiv original file, lossless, byte-for-byte) for all three paths; pass master for the 1200px jpg (much smaller). An original over 15MB is refused - use master'),
      page: z.number().optional().describe('Which page to send for a multi-page work (0-based, default 0). This is a page **inside the work**, not a search page'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('Optional: message id to quote/reply to'),
      tags: z.array(z.string()).optional().describe('Tags that must **all** match (case-insensitive substring), e.g. ["初音ミク","壁紙"]. Passing this enables local filtering'),
      author: z.string().optional().describe('Author: a name -> case-insensitive userName substring; pure digits -> exact userId'),
      orientation: z.enum(['portrait', 'landscape', 'square']).optional().describe('Shape: portrait = taller than wide / landscape = wider than tall / square (works missing either dimension never match)'),
      minWidth: z.number().optional().describe('Minimum width in pixels (original width); use it when you want a high-resolution image'),
      minHeight: z.number().optional().describe('Minimum height in pixels (original height)'),
      multiPage: z.boolean().optional().describe('true = only multi-image works (pageCount>1); combine with page to pick which image of a set'),
      excludeAi: z.boolean().optional().describe('true = drop AI-generated works (aiType=2 plus an AI-tag fallback)'),
      illustType: z.enum(['illust', 'manga']).optional().describe('Only illustrations (illust, illustType=0) or manga (manga, illustType=1); illustType=2 animations (ugoira) are excluded by both values'),
      sort: z.enum(['date_desc', 'date_asc', 'random']).optional().describe('Order: date_desc = newest first (default) / date_asc = oldest first / random. **Popularity / bookmark sorting is not supported** (no source returns a bookmark count); it falls back to date_desc and writes the reason into a warning'),
      scanPages: z.number().optional().describe('How many pages to walk forward looking for matches: default 3, cap 10. Filtering is local, so too few hits means walking further'),
      crossSession: z.boolean().optional().describe('ONLY when deliberately sending into a different session than the one you are answering; the key must be that session\'s own (a key that is not this session\'s is refused)'),
    },
    async ({ key, token, query, illustId, authorId, index, size, page, replyToMessageId, tags, author, orientation, minWidth, minHeight, multiPage, excludeAi, illustType, sort, scanPages, crossSession }) => {
      try {
        const wantId = parsePixivId(illustId);
        const wantAuthor = String(authorId ?? '').trim();
        /* size 的默认值（2026-09-20 主人定："发图默认原图，不要缩略图"）：三条路都默认 original。
         * 以前只有"给了 illustId/authorId"才默认原图，只给 query 时回落 master —— 主人明确要改掉这一点；
         * 显式传 size 时永远以调用方为准，怕超 15MB 就传 master。 */
        const sizeEff = String(size ?? 'original').toLowerCase() === 'master' ? 'master' : 'original';

        let work = null;
        let originals = [];       // 逐页原图直链（按号取图时才有）
        let originalsNote = '';
        let pickNote = '';

        if (wantId || wantAuthor) {
          /* ── 按作品号 / 按画师号取图（2026-09-18 修「试了 0 个地址」）────────────────
           * 旧写法在这里造了个 thumbUrl 为空的对象就往下走，而候选是**从缩略图推日期路径**的，
           * 于是 0 个候选 —— 这条路从来没通过。现在先按号把详情和原图直链问出来（2026-09-20 起
           * 官方 app-api 优先，web ajax 次之，镜像站兜底），见 lib/pixiv.js 顶部【按作品号取图】。 */
          if (wantId) {
            work = await pixivIllustDetail(wantId);
          } else {
            /* 画师入参三种形态统一收口：画师号 / users/<数字> 链接 / **画师名字**（走登录态用户搜索）。
             * 名字可能撞号，所以 resolvePixivAuthor 只在不歧义时才定号，否则把候选交回来让用户挑。 */
            const resolved = await resolvePixivAuthor(wantAuthor);
            if (resolved.kind === 'candidates') {
              const lines = resolved.candidates.map((u, i) => {
                // 作品数 0 与"没查到"要分开说：前者是"这个号没公开作品"，后者是"补查失败"
                const w = u.worksKnown ? (u.works ? `${u.works} 件作品` : '无公开作品') : '作品数未知';
                return `${i + 1}. ${u.name || '(无名字)'}（${w}）${u.comment ? `｜签名：${u.comment}` : ''}\n   ${u.pageUrl}`;
              });
              return {
                content: [{
                  type: 'text',
                  text: `「${resolved.name}」在 Pixiv 上有 ${resolved.candidates.length} 个同名/近似画师，分不清是哪一个，没敢乱发。候选（按"名字完全相等 → 作品多"排的）：\n${lines.join('\n')}\n`
                    + '把候选（尤其主页链接）念给用户确认是哪一个 —— 不要反过来问用户要画师号（号是桥自己查的）；'
                    + '用户认得主页的话，也可以让 ta 直接给一件作品链接（pixiv.net/artworks/<数字>）走 illustId。',
                }],
                isError: true,
              };
            }
            if (resolved.kind !== 'id') {
              return { content: [{ type: 'text', text: `画师入参不认识：「${wantAuthor}」。给画师名（桥会自己查号）、画师号（如 1554775）或 pixiv.net/users/<数字> 链接。` }], isError: true };
            }
            const { userId, ids } = await pixivUserWorkIds(resolved.id);
            if (!ids.length) {
              return {
                content: [{
                  type: 'text',
                  text: `画师 ${userId} 名下没有公开作品（Pixiv 上这个号没有投稿，或者号填错了）。`
                    + '要发某个具体作品请用 illustId（作品号）；要按关键词找图请用 query。'
                    + '提示：pixiv.net/users/<数字> 里的数字才是画师号。',
                }],
                isError: true,
              };
            }
            const pick = Math.max(0, Number(index) || 0);
            const target = ids[pick] || ids[0];
            work = await pixivIllustDetail(target);
            const how = resolved.from === 'name'
              ? `按名字「${resolved.name}」搜到画师 ${userId}（${resolved.endpoint}）`
              : `画师 ${userId}`;
            const alt = resolved.alternatives?.length ? `（另有 ${resolved.alternatives.length} 个同名/近似账号未采用）` : '';
            pickNote = `${how}${alt}，名下共 ${ids.length} 件公开作品，按投稿时间新→旧取第 ${pick + 1} 件（${target}）`;
          }
          // R-18 闸门：这条路人肉不过搜索的本地筛选，必须自己判（xRestrict 缺失/非 0 都当 R-18）
          if (work.adult) {
            return {
              content: [{
                type: 'text',
                text: `作品 ${work.id} 是 R-18/R-18G（xRestrict=${work.xRestrict}${work.tags.length ? '，标签：' + work.tags.slice(0, 6).join('/') : ''}），按规矩不发进 QQ。`,
              }],
              isError: true,
            };
          }
          const op = await pixivIllustOriginals(work);
          originals = op.urls;
          originalsNote = op.source ? `原图地址来源：${op.source}` : `原图地址没拿到（${op.note}）`;
        } else {
          const q = String(query ?? '').trim();
          if (!q) {
            return { content: [{ type: 'text', text: '要么给 illustId（Pixiv 作品号）、authorId（画师号），要么给 query（关键词）' }], isError: true };
          }
          const r = await pixivSearch(q, {
            limit: 10, tags, author, orientation, minWidth, minHeight, multiPage, excludeAi, illustType, sort, scanPages,
          });
          work = r.results[Math.max(0, Number(index) || 0)] || r.results[0];
          if (!work) {
            /* 用了本地筛选时把"筛掉多少 / 扫了几页"一并说清楚，否则模型会以为"Pixiv 上没有这张图"。
             * R-18 那部分单独算，免得和本地筛选条数重复计数。 */
            const localDrop = r.scan ? r.scan.droppedTotal - r.scan.dropped.adult - r.scan.dropped.notR18 : 0;
            const scanInfo = r.scan ? `，筛选条件再筛掉 ${localDrop} 条（已扫 ${r.scan.pagesScanned} 页 / 上限 ${r.scan.scanPagesLimit} 页，全站共 ${r.scan.total} 条）` : '';
            return { content: [{ type: 'text', text: `Pixiv 没搜到「${q}」符合条件的作品（R-18 过滤 ${r.filtered} 条${scanInfo}）。换个更具体的说法或放宽筛选再试。` }] };
          }
        }

        // 作品内页号边界（两条路共用）：越界直接说清楚，别让它变成一次"下载失败"。
        const pageCount = Math.max(1, Number(work.pageCount) || originals.length || 1);
        const pageIdx = Math.max(0, Number(page) || 0);
        if (pageIdx > pageCount - 1) {
          return {
            content: [{ type: 'text', text: `作品 ${work.id} 只有 ${pageCount} 页（page 从 0 开始，最大 ${pageCount - 1}）` }],
            isError: true,
          };
        }

        /* 候选逐个试（**按可靠性排序**，见 lib/pixiv.js 的 pixivImageSources）：
         * ① i.pximg.net 直联（带 Referer，实测 60~400ms，字节与源文件逐字节一致）→
         * ② 镜像站同名图代理（同字节，但慢，实测 2.7~5.7s，偶发超时）→
         * ③ 老候选（从缩略图推日期路径，搜索路径一直在用）。
         * 逐个试而不是只试一个：原图扩展名不定（jpg/png）、大图可能超体积上限、兜底链路可能同时抖动。 */
        const sources = pixivImageSources(work, { page: pageIdx, size: sizeEff, originals });
        let got = null;
        let gotFrom = '';
        let gotVia = '';          // pximg-direct / mirror-proxy（2026-09-20：如实告诉模型字节是谁给的）
        const tried = [];
        for (const s of sources) {
          try {
            got = await safeFetchBuffer(s.url, MAX_IMAGE_FETCH_BYTES, s.referer ? { referer: s.referer } : null);
            gotFrom = s.url;
            gotVia = s.referer ? 'pximg-direct' : 'mirror-proxy';
            break;
          } catch (e) {
            tried.push(`${s.referer ? '[直联] ' : '[代理]'}${s.url.slice(0, 96)} → ${e?.message ?? e}`);
          }
        }
        if (!got) {
          const overSize = /超过大小限制/.test(tried.join(' '));
          return {
            content: [{
              type: 'text',
              text: `Pixiv 图片下载失败（试了 ${sources.length} 个地址）：\n${tried.join('\n')}`
                + (overSize ? `\n提示：这张图超过本桥单张 ${Math.round(MAX_IMAGE_FETCH_BYTES / 1024 / 1024)}MB 的下载上限，改用 size=master 才能发。` : ''),
            }],
            isError: true,
          };
        }

        const buf = got.buffer;
        const ext = buf[0] === 0x89 ? 'png'
          : buf[0] === 0xff ? 'jpg'
            : buf.toString('ascii', 0, 3) === 'GIF' ? 'gif'
              : 'webp';
        const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        const cfgPx = getConfig();
        const tmpRoot = String(cfgPx?.napcat?.tmpDir ?? '').trim() || path.join(ROOT, 'state', 'image-tmp');
        fs.mkdirSync(tmpRoot, { recursive: true });
        const tmpPath = path.join(tmpRoot, `${Date.now()}-pixiv-${work.id}-p${pageIdx}.${ext}`);
        fs.writeFileSync(tmpPath, buf);

        const body = { key, messages: [], images: [tmpPath] };
        const rid = replyToMessageId !== undefined && replyToMessageId !== null ? String(replyToMessageId).trim() : '';
        if (rid) body.replyToMessageId = rid;
        // 跨会话闸门（见 console-server 的 crossSessionRefusal）：目标不是本会话时要显式声明
        if (crossSession === true) body.crossSession = true;
        const data = await agentApi('/api/social/send-message', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'x-agent-token': token },
          timeoutMs: 120000,
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: true,
              source: wantId ? 'illustId' : (wantAuthor ? 'authorId' : 'search'),
              pick: pickNote || undefined,
              id: work.id,
              page: pageIdx,
              pageCount,
              title: work.title || undefined,
              author: work.author || undefined,
              // 画师号一并回给模型：拿它就能接着用 authorId 发这位画师的其它/最新作品（见工具说明 ③）
              authorId: work.authorId || undefined,
              tags: work.tags?.length ? work.tags : undefined,
              pageUrl: work.pageUrl,
              size: sizeEff,
              // 无损保证：size=original 时发出去的就是 Pixiv 原图文件本身（字节与 sha256 一致，不缩放不转码）
              lossless: sizeEff === 'original',
              bytes: buf.length,
              sha256,
              format: ext,
              fetchedFrom: gotFrom,
              // 元数据是谁给的（app-api / web-ajax / mirror）+ 字节是谁给的（直联 i.pximg / 镜像代理）
              pixivSource: work.source || undefined,
              fetchedVia: gotVia || undefined,
              contentKind: sizeEff === 'original' ? 'pixiv-original' : 'pixiv-master',
              originalsNote: originalsNote || undefined,
              sent: data?.sent ?? null,
              quoted: data?.quoted ?? null,
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `发 Pixiv 图失败：${error?.message ?? error}` }], isError: true };
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

// ── 角色库（角色包）只读工具组（2026-09-14 新增）：qq_character_list / qq_character_read / qq_character_pack / qq_character_search ──
// 为什么需要：管理器「角色库导入」只把**一张**角色卡写进 qq-bridge/persona.md，再由
// core/wake-send.js::buildRuntimeOverrideBlock 作为 [PERSONA] 整段注入 —— 于是角色库里
// **其它角色卡的提示词根本不会被注入**：模型既不知道库里还有什么，也读不到别的卡。
// 这组工具让模型自己按需去读本机那份角色库（纯只读，不写任何人设文件、不发任何 QQ 消息）。
//
// ⚠️ 真实结构（本机实测，别当成"一堆 .md"）：**一个角色 = 一个子目录 = 一个"角色包"**，例如
//   characters/arihara-nanami/{SKILL.md, ULTIMATE_ROLEPLAY_PROMPT.md, personality.md, profile.md,
//     interaction.md, relations.md, memory.md, conflicts.md, manifest.json, sources/wiki.md}
//   characters/ATRI_MAIN_PROMPT.md                      ← 库根下**散装**的卡片文件（列出时标 (loose file)）
//   本机规模：21 个角色包 + 1 个散装文件 = 211 个文件（含每包的 manifest.json）。
//   所以：list 列的是**包**；read 读包里的**一份**（默认 SKILL.md）；pack 一次把核心几份拼回来。
//
// 目录：config.json → social.charactersDir（见 config.example.json；空/缺失 → DEFAULT_CHARACTERS_DIR）。
// 开关：config.json → social.tools.characterCards（!== false 即注册；默认开。理由：纯只读、只碰本机文件、
//       有大小上限与防穿越，关掉只会让"读不到其它角色卡"这个原问题复现；写法与 sendRich/musicSearch 同类）。
//
// 安全边界（全部落在下面的纯函数里，工具只是薄壳）：
//   1) 只认 .md / .txt / .json（.json 只有 manifest.json 这类元信息）；
//   2) 拒绝绝对路径/盘符/UNC、`.`、`..`、NUL、Windows 非法文件名字符；
//      `character` 只允许**单段**（包名或散装文件名），包内 file 最多 CHARACTER_PACK_MAX_FILE_DEPTH 层；
//   3) 每个真实路径都做 realpath **库根包含性**校验：符号链接/junction 指到库外一律当"不存在"；
//   4) 单文件 > CHARACTER_MAX_FILE_BYTES 直接不读；read 默认截断到 32KB、pack 封顶 24KB，超了如实说明；
//   5) 正文只出现在工具返回值里 —— 这段代码不新增任何含正文的日志（console.* 只打路径/计数）。
const DEFAULT_CHARACTERS_DIR = path.join(os.homedir(), 'Downloads', 'characters', 'characters');
/** 出厂角色库：随安装包分发的 21 个角色包就放在 <qq-bridge>/characters 下（与 mcp-napcat-safe.js 同级目录的上一层） */
const BUNDLED_CHARACTERS_DIR = path.join(ROOT, 'characters');
const CHARACTER_EXTS = new Set(['.md', '.txt', '.json']);
const CHARACTER_SCAN_MAX_DEPTH = 3;                  // 库根(0) → 角色包(1) → 包内一层(2) → 包内两层(3)，覆盖 <包>/sources/wiki.md
const CHARACTER_PACK_MAX_FILE_DEPTH = 2;             // 包内允许的最大层数：sources/wiki.md = 1 层
const CHARACTER_SCAN_MAX_FILES = 2000;               // 扫描上限，防止误把整盘当库时卡住
const CHARACTER_MAX_FILE_BYTES = 2 * 1024 * 1024;    // 单文件硬上限：超过这个大小不读
const CHARACTER_MANIFEST_MAX_BYTES = 256 * 1024;     // manifest.json 超过这个大小就不解析（只当元信息）
const CHARACTER_READ_DEFAULT_BYTES = 32 * 1024;      // qq_character_read 默认上限 = 32KB
const CHARACTER_READ_MAX_BYTES = 128 * 1024;         // 模型显式放宽的上限 = 128KB
const CHARACTER_PACK_DEFAULT_BYTES = 24 * 1024;      // qq_character_pack 默认封顶 = 24KB
const CHARACTER_PACK_MAX_BYTES = 128 * 1024;         // qq_character_pack 显式放宽的上限
const CHARACTER_LIST_DEFAULT_LIMIT = 100;
const CHARACTER_LIST_MAX_LIMIT = 500;
const CHARACTER_SEARCH_DEFAULT_LIMIT = 10;
const CHARACTER_SEARCH_MAX_LIMIT = 50;
const CHARACTER_SEARCH_MAX_SNIPPETS = 3;
const CHARACTER_SNIPPET_MAX_CHARS = 200;
const CHARACTER_TITLE_MAX_CHARS = 80;
const CHARACTER_TITLE_HEAD_BYTES = 4096;
const CHARACTER_SUMMARY_MAX_CHARS = 120;
// qq_character_pack 的正文顺序：主人点名的"核心几份"在前，memory/conflicts 次之，主提示词与其余在后
const CHARACTER_FILE_ORDER = [
  /^skill\.md$/i, /^personality\./i, /^profile\./i, /^interaction\./i, /^relations\./i,
  /^memory\./i, /^conflicts\./i, /^ultimate_roleplay_prompt/i, /^main_prompt/i
];
// qq_character_read(character) 不传 file 时的默认阅读顺序：SKILL.md → manifest.json → 终极扮演提示词 → personality
const CHARACTER_DEFAULT_FILE_ORDER = [/^skill\.md$/i, /^manifest\.json$/i, /^ultimate_roleplay_prompt/i, /^personality\./i];

/** 目录（不是文件）存在吗 —— 用于角色库回落探测，读不到一律当不存在 */
function isCharacterDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * 角色库根目录：config.json → social.charactersDir 优先；没配就按"存在即用"回落：
 *   ① 用户自己的 `~/Downloads/characters/characters`（老默认，主人自己的库）
 *   ② 出厂库 `<qq-bridge>/characters`（随安装包分发的那 21 个角色包）
 *
 * 【2026-09-20 修「装了一堆角色包却一个都读不到」】以前没配就直接返回 ① —— 出厂库装上以后，
 * 全新机器上 ① 往往根本不存在（那是"主人自己放角色库的地方"），于是四个角色工具一起报
 * "角色库目录不存在"，而真正装着 21 个包的出厂库就在旁边没人看。现在按存在性回落；
 * 两个都不在时仍然返回 ①，让报错里出现的是那个熟悉的路径。
 */
function resolveCharactersDir(config) {
  let raw = '';
  try {
    const c = config ?? getConfig();
    if (typeof c?.social?.charactersDir === 'string') raw = c.social.charactersDir.trim();
  } catch { raw = ''; }
  if (raw) {
    try { return path.resolve(raw); } catch { /* 路径非法 → 落到下面的探测 */ }
  }
  if (isCharacterDir(DEFAULT_CHARACTERS_DIR)) return DEFAULT_CHARACTERS_DIR;
  if (isCharacterDir(BUNDLED_CHARACTERS_DIR)) return BUNDLED_CHARACTERS_DIR;
  return DEFAULT_CHARACTERS_DIR;
}

function characterExtOf(name) {
  return path.extname(String(name ?? '')).toLowerCase();
}

/**
 * 把「角色名 / 相对路径」归一化成库内相对段。
 * 绝对路径、盘符、UNC、`.`、`..`、NUL、非法文件名字符、层级过深都在这里被拒（ok:false + 原因）。
 */
function normalizeCharacterRel(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return { ok: false, error: 'name is empty' };
  if (raw.length > 400) return { ok: false, error: 'name is too long (max 400 chars)' };
  if (raw.includes('\u0000')) return { ok: false, error: 'name contains a NUL character' };
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('\\') || raw.startsWith('/')) {
    return { ok: false, error: 'absolute paths (drive letter / UNC / leading separator) are not allowed - pass a name relative to the character library' };
  }
  const segs = raw.split(/[\\/]+/).filter((s) => s.length > 0);
  if (!segs.length) return { ok: false, error: 'name has no path segment' };
  for (const s of segs) {
    if (s === '.' || s === '..') return { ok: false, error: 'parent-directory traversal ("." / "..") is not allowed' };
    if (s.includes(':')) return { ok: false, error: 'drive letters / NTFS alternate data streams are not allowed' };
    if (/[*?"<>|]/.test(s)) return { ok: false, error: `name contains a character that is invalid in a file name: ${s}` };
  }
  // 「角色」= 一个子目录（角色包）：character 只允许单段，包内 file 最多 CHARACTER_PACK_MAX_FILE_DEPTH 层
  if (segs.length > CHARACTER_PACK_MAX_FILE_DEPTH + 1) {
    return { ok: false, error: `too deep: at most ${CHARACTER_PACK_MAX_FILE_DEPTH} level(s) below a character pack (${CHARACTER_PACK_MAX_FILE_DEPTH + 1} path segment(s))` };
  }
  return { ok: true, segs, rel: segs.join('/') };
}

/** 解析成库内文件绝对路径（只做名字层校验；真实路径包含性由 containedRealPath 负责） */
function resolveCharacterPath(rootDir, name) {
  const root = path.resolve(String(rootDir ?? ''));
  const norm = normalizeCharacterRel(name);
  if (!norm.ok) return { ok: false, error: norm.error };
  if (!CHARACTER_EXTS.has(characterExtOf(norm.rel))) {
    return { ok: false, error: `only .md / .txt / .json character-pack files can be read (got "${norm.rel}")` };
  }
  return { ok: true, rel: norm.rel, abs: path.join(root, ...norm.segs) };
}

/** real 是否落在 rootReal 之内（大小写按平台语义；符号链接已由调用方的 realpath 解开） */
function isInsideDir(rootReal, real) {
  const rel = path.relative(String(rootReal ?? ''), String(real ?? ''));
  if (!rel || path.isAbsolute(rel)) return false;
  return rel.split(/[\\/]+/)[0] !== '..';
}

/**
 * realpath + 包含性校验。返回 { ok:true, abs, rootReal } 或 { ok:false, error }。
 * 库目录不存在 / 目标不存在 / 符号链接（junction）指到库外 —— 全部走 ok:false，调用方不抛异常。
 */
function containedRealPath(rootDir, targetAbs) {
  let rootReal;
  try { rootReal = fs.realpathSync(path.resolve(String(rootDir ?? ''))); }
  catch { return { ok: false, error: 'character library directory does not exist' }; }
  let real;
  try { real = fs.realpathSync(targetAbs); } catch { return { ok: false, error: 'not found' }; }
  if (!isInsideDir(rootReal, real)) {
    return { ok: false, error: 'resolved path is outside the character library (symlink/junction escape?)' };
  }
  return { ok: true, abs: real, rootReal };
}

/** 打开角色库根：{ ok:true, dir, rootReal } 或 { ok:false, dir, reason }（目录不在也**不抛异常**） */
function openCharactersRoot(rootDir) {
  const dir = path.resolve(String(rootDir ?? ''));
  let real;
  try { real = fs.realpathSync(dir); } catch { return { ok: false, dir, reason: 'directory-not-found' }; }
  let st;
  try { st = fs.statSync(real); } catch { return { ok: false, dir, reason: 'directory-not-found' }; }
  if (!st.isDirectory()) return { ok: false, dir, reason: 'not-a-directory' };
  return { ok: true, dir, rootReal: real };
}

/** 条目探测（跟随符号链接）：坏链 / 逃逸到库外 / 读不到 → null，调用方当"没有这个条目" */
function inspectVfsEntry(rootReal, abs) {
  let real;
  try { real = fs.realpathSync(abs); } catch { return null; }
  if (!isInsideDir(rootReal, real)) return null;
  try { return { abs: real, st: fs.statSync(real) }; } catch { return null; }
}

/** 扫描库内全部 .md/.txt（最多 CHARACTER_SCAN_MAX_DEPTH 层、最多 CHARACTER_SCAN_MAX_FILES 个） */
function scanCharacterFiles(rootDir, opts = {}) {
  const maxDepth = Number.isFinite(opts.maxDepth) ? Math.max(0, Math.floor(opts.maxDepth)) : CHARACTER_SCAN_MAX_DEPTH;
  const maxFiles = Number.isFinite(opts.maxFiles) ? Math.max(1, Math.floor(opts.maxFiles)) : CHARACTER_SCAN_MAX_FILES;
  const opened = openCharactersRoot(rootDir);
  if (!opened.ok) return { ok: false, dir: opened.dir, reason: opened.reason, files: [], truncated: false };
  const files = [];
  let truncated = false;
  const walk = (dirAbs, depth, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (truncated) return;
      if (e.name.startsWith('.')) continue;                     // 隐藏项（.git / .DS_Store 之类）不算角色卡
      const abs = path.join(dirAbs, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const info = inspectVfsEntry(opened.rootReal, abs);        // 跟随符号链接 + 包含性校验
      if (!info) continue;
      if (info.st.isDirectory()) {
        if (depth < maxDepth) walk(info.abs, depth + 1, rel);
        continue;
      }
      if (!info.st.isFile()) continue;
      if (!CHARACTER_EXTS.has(characterExtOf(e.name))) continue;
      if (info.st.size <= 0) continue;
      files.push({ rel, abs: info.abs, size: info.st.size, mtimeMs: info.st.mtimeMs });
      if (files.length >= maxFiles) { truncated = true; return; }
    }
  };
  walk(opened.rootReal, 0, '');
  return { ok: true, dir: opened.dir, rootReal: opened.rootReal, files, truncated };
}

function clampReadBytes(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return CHARACTER_READ_DEFAULT_BYTES;
  return Math.min(Math.max(Math.floor(n), 1024), CHARACTER_READ_MAX_BYTES);
}

function clampLimit(v, def, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.max(Math.floor(n), 1), max);
}

/** 卡片标题：跳过 YAML front matter，取第一个 Markdown 标题；没有标题就用 front matter 的 name */
function cardTitle(abs) {
  try {
    const fd = fs.openSync(abs, 'r');
    let head = '';
    try {
      const buf = Buffer.alloc(CHARACTER_TITLE_HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString('utf8').replace(/^\uFEFF/, '');
    } finally { fs.closeSync(fd); }
    let body = head;
    let fmName = '';
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(head);
    if (fm) {
      const m = /^\s*name\s*:\s*["']?([^"'\r\n]+)/m.exec(fm[1]);
      if (m) fmName = m[1].trim();
      body = head.slice(fm[0].length);
    }
    const h = /^\s{0,3}#{1,6}\s+(.+?)\s*$/m.exec(body);
    const title = (h ? h[1] : '').replace(/[#*`>]+/g, ' ').replace(/\s+/g, ' ').trim();
    const finalTitle = title || fmName;
    return finalTitle ? finalTitle.slice(0, CHARACTER_TITLE_MAX_CHARS) : '';
  } catch { return ''; }
}

function formatCardMtime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 'unknown';
  return new Date(n).toISOString().replace('T', ' ').slice(0, 16);
}

/** 读单个卡片文件：按字节上限截断，返回真实截断情况（不抛异常） */
function readCardFileBytes(abs, rel, maxBytes) {
  const limit = clampReadBytes(maxBytes);
  let st;
  try { st = fs.statSync(abs); } catch { return { ok: false, rel, reason: 'not-found' }; }
  if (!st.isFile()) return { ok: false, rel, reason: 'not-a-file' };
  if (st.size > CHARACTER_MAX_FILE_BYTES) {
    return {
      ok: false, rel, reason: 'too-large', size: st.size,
      error: `file is ${st.size} B, over the ${CHARACTER_MAX_FILE_BYTES} B per-file limit - refused, not read`
    };
  }
  let buf;
  try { buf = fs.readFileSync(abs); } catch (error) {
    return { ok: false, rel, reason: 'read-failed', error: error?.message ?? String(error) };
  }
  const truncated = buf.length > limit;
  let text = (truncated ? buf.subarray(0, limit) : buf).toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  // 切在多字节字符中间时丢掉残留替换符（真实库是中文卡，必须保证不产生乱码尾巴）
  if (truncated && text.endsWith('\uFFFD')) text = text.slice(0, -1);
  return {
    ok: true, rel, size: buf.length, bytes: Buffer.byteLength(text, 'utf8'),
    truncated, limitBytes: limit, title: cardTitle(abs), mtimeMs: st.mtimeMs, text
  };
}

/** 角色包内文件的排序：按 CHARACTER_FILE_ORDER 的核心顺序 → 同名新版本在前 → 其余按名（manifest.json 排最后且不进 pack 正文） */
function orderCardFiles(files) {
  const baseOf = (rel) => String(rel).split('/').pop().toLowerCase();
  const scoreOf = (rel) => {
    const base = baseOf(rel);
    for (let i = 0; i < CHARACTER_FILE_ORDER.length; i++) if (CHARACTER_FILE_ORDER[i].test(base)) return i;
    return CHARACTER_FILE_ORDER.length;
  };
  const versionOf = (rel) => {
    const m = /v(\d+(?:\.\d+)?)/i.exec(baseOf(rel));
    return m ? Number(m[1]) : 0;
  };
  return [...files].sort((a, b) => {
    const sa = scoreOf(a.rel); const sb = scoreOf(b.rel);
    if (sa !== sb) return sa - sb;
    const va = versionOf(a.rel); const vb = versionOf(b.rel);
    if (va !== vb) return vb - va;
    return a.rel.localeCompare(b.rel);
  });
}

/** qq_character_pack 的字节上限：默认 24KB，可放宽到 CHARACTER_PACK_MAX_BYTES */
function clampPackBytes(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return CHARACTER_PACK_DEFAULT_BYTES;
  return Math.min(Math.max(Math.floor(n), 2048), CHARACTER_PACK_MAX_BYTES);
}

function truncateText(s, max) {
  const t = String(s ?? '').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

/** 读角色包 manifest.json 的名字/简介/版本（只当元信息）：读不到/坏了都返回 { ok:false }，从不抛异常 */
function readPackManifest(packDir) {
  const p = path.join(String(packDir ?? ''), 'manifest.json');
  let st;
  try { st = fs.statSync(p); } catch { return { ok: false, reason: 'missing' }; }
  if (!st.isFile() || st.size <= 0 || st.size > CHARACTER_MANIFEST_MAX_BYTES) return { ok: false, reason: 'unusable' };
  let obj;
  try { obj = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return { ok: false, reason: 'bad-json' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'bad-shape' };
  const first = (keys) => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
      if (Array.isArray(v) && v.length) {
        const parts = v.filter((x) => typeof x === 'string' && x.trim());
        if (parts.length) return parts.join(', ');
      }
    }
    return '';
  };
  const name = first(['name', 'displayName', 'display_name', 'title', 'slug']);
  const version = first(['version', 'version_release']);
  const description = first(['description', 'summary', 'desc', 'intro', 'tagline', 'bio', '简介']);
  const extras = first(['game', 'kit', 'dimensions', 'tags', 'dimensions_count']);
  return { ok: true, name, version, description, extras, summary: description || extras };
}

/** 角色包默认阅读的那一份：优先包**顶层**的 SKILL.md → manifest.json → ULTIMATE_ROLEPLAY_PROMPT*(新版本在前) → personality.md */
function pickDefaultPackFile(files) {
  const list = Array.isArray(files) ? files.filter((f) => f && typeof f.rel === 'string') : [];
  if (!list.length) return null;
  const top = list.filter((f) => !f.rel.includes('/'));
  const pool = top.length ? top : list;
  for (const re of CHARACTER_DEFAULT_FILE_ORDER) {
    const hit = pool.filter((f) => re.test(f.rel.split('/').pop()));
    if (hit.length === 1) return hit[0];
    if (hit.length > 1) return orderCardFiles(hit)[0];
  }
  return orderCardFiles(pool)[0];
}

/** 表头里的 manifest 一行（名字/版本/简介） */
function formatVersion(v) {
  const t = String(v ?? '').trim();
  if (!t) return '';
  return /^v/i.test(t) ? t : `v${t}`;          // manifest 里版本有写 "2.0" 也有写 "V2.0"，统一成 vX
}

function manifestLine(m) {
  if (!m || !m.ok) return 'Manifest: (none)';
  const bits = [m.name || '(unnamed)'];
  if (m.version) bits.push(formatVersion(m.version));
  const summary = truncateText(m.summary, CHARACTER_SUMMARY_MAX_CHARS);
  return `Manifest: ${bits.join(' ')}${summary ? ` - ${summary}` : ''}`;
}

/** 列角色包（一个子目录 = 一个角色包）+ 库根下散装的卡片文件；目录不存在 → ok:false + reason（不抛异常） */
function listCharacterPacks(rootDir, opts = {}) {
  const limit = clampLimit(opts.limit, CHARACTER_LIST_DEFAULT_LIMIT, CHARACTER_LIST_MAX_LIMIT);
  const scan = scanCharacterFiles(rootDir);
  if (!scan.ok) return { ok: false, dir: scan.dir, reason: scan.reason, limit, total: 0, packs: [], loose: [] };
  const byPack = new Map();
  const loose = [];
  for (const f of scan.files) {
    const slash = f.rel.indexOf('/');
    if (slash < 0) {                                            // 库根下散装的文件（如 ATRI_MAIN_PROMPT.md）
      loose.push({ name: f.rel, size: f.size, mtimeMs: f.mtimeMs, title: cardTitle(f.abs) });
      continue;
    }
    const name = f.rel.slice(0, slash);
    if (!byPack.has(name)) byPack.set(name, { name, files: [], totalBytes: 0, mtimeMs: 0 });
    const pack = byPack.get(name);
    pack.files.push({ rel: f.rel.slice(slash + 1), abs: f.abs, size: f.size, mtimeMs: f.mtimeMs });
    pack.totalBytes += f.size;
    if (f.mtimeMs > pack.mtimeMs) pack.mtimeMs = f.mtimeMs;
  }
  const all = [...byPack.values()].sort((a, b) => a.name.localeCompare(b.name));
  const packs = all.slice(0, limit).map((p) => {
    const main = pickDefaultPackFile(p.files);
    return {
      name: p.name, fileCount: p.files.length, totalBytes: p.totalBytes, mtimeMs: p.mtimeMs,
      mainFile: main ? main.rel : '', hasManifest: p.files.some((f) => /^manifest\.json$/i.test(f.rel)),
      manifest: readPackManifest(path.join(scan.rootReal, p.name))
    };
  });
  return {
    ok: true, dir: scan.dir, limit, packs, total: all.length, totalPacks: all.length,
    totalFiles: scan.files.length, loose, scanTruncated: scan.truncated
  };
}

/** 列某个角色包里的文件（qq_character_read 的 file 参数索引）；name 给了散装文件或无此包都会说清楚 */
function listPackFiles(rootDir, character) {
  const opened = openCharactersRoot(rootDir);
  if (!opened.ok) return { ok: false, dir: opened.dir, reason: opened.reason };
  const norm = normalizeCharacterRel(character);
  if (!norm.ok || norm.rel.includes('/')) {
    return {
      ok: false, dir: opened.dir, character: String(character ?? ''), reason: 'rejected',
      error: norm.ok ? 'character must be a single pack name (or a loose file name), not a path' : norm.error
    };
  }
  const target = path.join(opened.rootReal, norm.rel);
  const info = inspectVfsEntry(opened.rootReal, target);
  if (!info) {
    let exists = false;
    try { fs.lstatSync(target); exists = true; } catch { exists = false; }
    return {
      ok: false, dir: opened.dir, character: norm.rel, reason: exists ? 'rejected' : 'not-found',
      error: exists
        ? 'path exists but resolves outside the character library (symlink/junction escape) - refused'
        : `no character pack or card file named "${norm.rel}" in the character library`
    };
  }
  if (!info.st.isDirectory()) {
    return {
      ok: false, dir: opened.dir, character: norm.rel, reason: 'not-a-pack',
      error: `"${norm.rel}" is a loose card file at the library root, not a character pack - read it with qq_character_read`
    };
  }
  const scan = scanCharacterFiles(info.abs, { maxDepth: CHARACTER_PACK_MAX_FILE_DEPTH });
  const files = orderCardFiles(scan.files).map((f) => ({ rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, title: cardTitle(f.abs) }));
  return {
    ok: true, dir: opened.dir, character: norm.rel, files, totalBytes: files.reduce((s, f) => s + f.size, 0),
    manifest: readPackManifest(info.abs), mainFile: (pickDefaultPackFile(scan.files) || {}).rel || ''
  };
}

/** 把 character（单段：角色包名或库根下散装文件名）解析成库内真实条目；不合法/不存在/逃逸都 ok:false（不抛异常） */
function resolveCharacterEntry(opened, character) {
  const norm = normalizeCharacterRel(character);
  if (!norm.ok || norm.rel.includes('/')) {
    return {
      ok: false, name: String(character ?? ''), reason: 'rejected',
      error: norm.ok
        ? 'character must be a single pack name (or a loose file name at the library root), not a path - use the file parameter for files inside a pack'
        : norm.error
    };
  }
  const target = path.join(opened.rootReal, norm.rel);
  const info = inspectVfsEntry(opened.rootReal, target);
  if (!info) {
    let exists = false;
    try { fs.lstatSync(target); exists = true; } catch { exists = false; }
    return {
      ok: false, name: norm.rel, reason: exists ? 'rejected' : 'not-found',
      error: exists
        ? 'path exists but resolves outside the character library (symlink/junction escape) - refused'
        : `no character pack or card file named "${norm.rel}" in the character library`
    };
  }
  return { ok: true, name: norm.rel, abs: info.abs, st: info.st, isDir: info.st.isDirectory() };
}

/**
 * 读角色包里**一份**文件（或库根下散装的一张卡）。
 * character = 角色包名 / 散装文件名；file 省略时按 SKILL.md → manifest.json → ULTIMATE_ROLEPLAY_PROMPT* → personality.md 挑一份。
 * 包内允许最多 CHARACTER_PACK_MAX_FILE_DEPTH 层（sources/wiki.md = 1 层）。内容按 maxBytes（默认 32KB，上限 128KB）截断并如实回报。
 */
function readCharacterFile(rootDir, character, file, opts = {}) {
  const opened = openCharactersRoot(rootDir);
  if (!opened.ok) return { ok: false, dir: opened.dir, reason: opened.reason };
  const ent = resolveCharacterEntry(opened, character);
  if (!ent.ok) return { ok: false, dir: opened.dir, character: ent.name, reason: ent.reason, error: ent.error };
  const limit = clampReadBytes(opts.maxBytes);
  const hasFileArg = file !== undefined && file !== null && String(file).trim() !== '';
  if (!ent.isDir) {                                            // 库根下散装的文件
    if (!CHARACTER_EXTS.has(characterExtOf(ent.name))) {
      return { ok: false, dir: opened.dir, character: ent.name, reason: 'rejected', error: `only .md / .txt / .json files can be read (got "${ent.name}")` };
    }
    const r = readCardFileBytes(ent.abs, ent.name, limit);
    if (!r.ok) return { ok: false, dir: opened.dir, character: ent.name, reason: r.reason, error: r.error ?? r.reason, size: r.size };
    return {
      ok: true, kind: 'loose-file', dir: opened.dir, character: ent.name, file: ent.name, fileIgnored: hasFileArg,
      manifest: { ok: false, reason: 'n/a' }, files: [ent.name], packFileCount: 1, packTotalBytes: r.size,
      parts: [r], includedCount: 1, totalBytes: r.bytes, totalSize: r.size, notIncluded: [],
      truncated: r.truncated, limitBytes: limit
    };
  }
  const scan = scanCharacterFiles(ent.abs, { maxDepth: CHARACTER_PACK_MAX_FILE_DEPTH });
  const packFiles = scan.files;
  const manifest = readPackManifest(ent.abs);
  if (!packFiles.length) {
    return { ok: false, dir: opened.dir, character: ent.name, reason: 'empty-pack', error: 'this character pack contains no readable .md / .txt / .json file' };
  }
  let chosen = null;
  if (hasFileArg) {
    const nf = normalizeCharacterRel(file);
    if (!nf.ok) return { ok: false, dir: opened.dir, character: ent.name, reason: 'rejected', error: nf.error, files: packFiles.map((f) => f.rel) };
    if (!CHARACTER_EXTS.has(characterExtOf(nf.rel))) {
      return { ok: false, dir: opened.dir, character: ent.name, reason: 'rejected', error: `only .md / .txt / .json files can be read (got "${nf.rel}")`, files: packFiles.map((f) => f.rel) };
    }
    const want = nf.rel.toLowerCase();
    chosen = packFiles.find((f) => f.rel.toLowerCase() === want) || null;
    if (!chosen) {
      return { ok: false, dir: opened.dir, character: ent.name, reason: 'not-in-pack', error: `"${nf.rel}" is not in character pack "${ent.name}"`, files: packFiles.map((f) => f.rel) };
    }
  } else {
    chosen = pickDefaultPackFile(packFiles);
    if (!chosen) return { ok: false, dir: opened.dir, character: ent.name, reason: 'empty-pack', error: 'no readable file in this pack' };
  }
  const r = readCardFileBytes(chosen.abs, `${ent.name}/${chosen.rel}`, limit);
  if (!r.ok) {
    return { ok: false, dir: opened.dir, character: ent.name, reason: r.reason, error: r.error ?? r.reason, size: r.size, files: packFiles.map((f) => f.rel) };
  }
  return {
    ok: true, kind: 'pack-file', dir: opened.dir, character: ent.name, file: chosen.rel, defaultFile: !hasFileArg,
    manifest, files: packFiles.map((f) => f.rel), packFileCount: packFiles.length,
    packTotalBytes: packFiles.reduce((s, f) => s + f.size, 0), parts: [r], includedCount: 1,
    totalBytes: r.bytes, totalSize: r.size, notIncluded: [], truncated: r.truncated, limitBytes: limit
  };
}

/**
 * 一次读回某个角色包的**核心几份**并拼起来（"扮演/参考这个角色"最有用的一次调用）：
 * SKILL.md → personality.md → profile.md → interaction.md → relations.md → memory.md → conflicts.md
 * → ULTIMATE_ROLEPLAY_PROMPT* → 其余；总长默认封顶 CHARACTER_PACK_DEFAULT_BYTES（24KB），
 * 超了如实说明截断在哪一份、还剩哪些没装下。manifest.json 只当元信息（进表头），不进正文。
 */
function readCharacterPack(rootDir, character, opts = {}) {
  const opened = openCharactersRoot(rootDir);
  if (!opened.ok) return { ok: false, dir: opened.dir, reason: opened.reason };
  const ent = resolveCharacterEntry(opened, character);
  if (!ent.ok) return { ok: false, dir: opened.dir, character: ent.name, reason: ent.reason, error: ent.error };
  if (!ent.isDir) {
    return {
      ok: false, dir: opened.dir, character: ent.name, reason: 'not-a-pack',
      error: `"${ent.name}" is a loose card file at the library root, not a character pack - use qq_character_read for it`
    };
  }
  const scan = scanCharacterFiles(ent.abs, { maxDepth: CHARACTER_PACK_MAX_FILE_DEPTH });
  const manifest = readPackManifest(ent.abs);
  const body = scan.files.filter((f) => !/^manifest\.json$/i.test(f.rel.split('/').pop()));
  if (!body.length) {
    return { ok: false, dir: opened.dir, character: ent.name, reason: 'empty-pack', error: 'this character pack has no readable body file (only manifest.json?)' };
  }
  const ordered = orderCardFiles(body);
  const limit = clampPackBytes(opts.maxBytes);
  const parts = [];
  let totalBytes = 0;
  for (const f of ordered) {
    const remaining = limit - totalBytes;
    if (remaining < 512) break;                                // 剩得太少就不塞半个文件进去
    const r = readCardFileBytes(f.abs, `${ent.name}/${f.rel}`, remaining);
    if (!r.ok) continue;
    parts.push({ rel: r.rel, size: r.size, bytes: r.bytes, truncated: r.truncated, title: r.title, mtimeMs: r.mtimeMs, text: r.text });
    totalBytes += r.bytes;
    if (r.truncated) break;
  }
  const included = new Set(parts.map((p) => p.rel));
  const notIncluded = ordered.filter((f) => !included.has(`${ent.name}/${f.rel}`)).map((f) => f.rel);
  const cut = parts.find((p) => p.truncated);
  return {
    ok: true, kind: 'pack', dir: opened.dir, character: ent.name, manifest,
    parts, files: ordered.map((f) => f.rel), fileCount: scan.files.length, bodyFileCount: ordered.length,
    includedCount: parts.length, skippedManifest: scan.files.length - ordered.length,
    totalBytes, totalSize: ordered.reduce((s, f) => s + f.size, 0),
    packTotalBytes: scan.files.reduce((s, f) => s + f.size, 0),
    cutIn: cut ? cut.rel : '', notIncluded, limitBytes: limit,
    truncated: notIncluded.length > 0 || parts.some((p) => p.truncated)
  };
}

/**
 * 在角色卡正文里搜关键词：空格分词 = AND（同一张卡里都要出现），返回命中的卡 + 短片段（不返回全文）。
 * 目录不存在 → ok:false + reason（空结果，不抛异常）。
 */
function searchCharacterCards(rootDir, query, opts = {}) {
  const q = String(query ?? '').trim();
  const dir = path.resolve(String(rootDir ?? ''));
  if (!q) return { ok: false, dir, reason: 'empty-query', hits: [], scanned: 0, total: 0 };
  const tokens = q.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
  const limit = clampLimit(opts.limit, CHARACTER_SEARCH_DEFAULT_LIMIT, CHARACTER_SEARCH_MAX_LIMIT);
  const scan = scanCharacterFiles(rootDir);
  if (!scan.ok) return { ok: false, dir: scan.dir, reason: scan.reason, hits: [], scanned: 0, total: 0 };
  const hits = [];
  let scanned = 0;
  for (const f of scan.files) {
    scanned++;
    const nameMatch = tokens.some((t) => f.rel.toLowerCase().includes(t));
    let text = '';
    if (f.size <= CHARACTER_MAX_FILE_BYTES) {
      try { text = fs.readFileSync(f.abs, 'utf8'); } catch { text = ''; }
    }
    const lower = text.toLowerCase();
    const contentMatch = text.length > 0 && tokens.every((t) => lower.includes(t));
    if (!contentMatch && !nameMatch) continue;
    let matchCount = 0;
    const snippets = [];
    if (contentMatch) {
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!tokens.some((t) => line.toLowerCase().includes(t))) continue;
        matchCount++;
        if (snippets.length < CHARACTER_SEARCH_MAX_SNIPPETS) {
          const trimmed = line.trim();
          snippets.push(`L${i + 1}: ${trimmed.length > CHARACTER_SNIPPET_MAX_CHARS ? `${trimmed.slice(0, CHARACTER_SNIPPET_MAX_CHARS)}...` : trimmed}`);
        }
      }
    }
    hits.push({
      rel: f.rel, title: cardTitle(f.abs), size: f.size, mtimeMs: f.mtimeMs,
      nameMatch, matchCount, snippets
    });
  }
  hits.sort((a, b) => (Number(b.nameMatch) - Number(a.nameMatch)) || (b.matchCount - a.matchCount) || a.rel.localeCompare(b.rel));
  return { ok: true, dir: scan.dir, query: q, scanned, total: hits.length, limit, hits: hits.slice(0, limit) };
}

// ── 四个工具真正返回的文本（工具只做薄壳；tests/character-library.test.js 调的就是这几个函数）──

/** 库目录不可用 / 目标不在时的统一说明（不抛异常，只把原因和修法说清楚） */
function characterUnavailableText(r, fallbackDir) {
  const dir = (r && r.dir) || fallbackDir;
  const why = r?.reason === 'directory-not-found'
    ? 'the directory does not exist on this machine'
    : `unusable (${r?.reason ?? 'unknown'})`;
  return [
    `Character library unavailable: ${dir}`,
    `Reason: ${why} - 0 pack(s)/file(s) returned.`,
    `Fix: set "social.charactersDir" in qq-bridge/config.json to your character library path (default: ${DEFAULT_CHARACTERS_DIR}).`,
    'This is not an error in the conversation - just tell the owner the character library directory is missing.'
  ].join('\n');
}

function characterListText(limit, character, dirOverride) {
  const dir = dirOverride ? path.resolve(String(dirOverride)) : resolveCharactersDir();
  if (character !== undefined && character !== null && String(character).trim() !== '') {
    const r = listPackFiles(dir, character);
    if (!r.ok) {
      if (r.reason === 'not-a-pack') {
        return [
          `"${String(character)}" is a loose card file at the library root, not a character pack - read it with qq_character_read(character="${String(character)}").`,
          `Library: ${r.dir}`,
          'Call qq_character_list without the character parameter to see all packs.'
        ].join('\n');
      }
      if (r.reason === 'directory-not-found') return characterUnavailableText(r, dir);
      return [
        `Cannot list character pack "${String(character)}": ${r.error ?? r.reason}`,
        `Library: ${r.dir}`,
        'Call qq_character_list without the character parameter to see all packs.'
      ].join('\n');
    }
    const lines = [];
    lines.push(`Character pack: ${r.character}/ (${r.files.length} file(s), ${r.totalBytes} B on disk)`);
    lines.push(`Library: ${r.dir}`);
    lines.push(manifestLine(r.manifest));
    if (r.mainFile) lines.push(`Default file of qq_character_read(character="${r.character}"): ${r.mainFile}`);
    for (const f of r.files) {
      lines.push(`${r.character}/${f.rel} | ${f.title || '(no title)'} | ${f.size} B | ${formatCardMtime(f.mtimeMs)}`);
    }
    lines.push(`Read one with qq_character_read(character="${r.character}", file="<one of the paths above>"), or the core docs at once with qq_character_pack(character="${r.character}").`);
    return lines.join('\n');
  }
  const r = listCharacterPacks(dir, { limit });
  if (!r.ok) return characterUnavailableText(r, dir);
  const lines = [];
  lines.push(`Character library: ${r.dir}`);
  lines.push(`${r.totalPacks} character pack(s) (one folder = one character), ${r.totalFiles} file(s) on disk, ${r.loose.length} loose file(s) at the library root${r.scanTruncated ? `, scan stopped at ${CHARACTER_SCAN_MAX_FILES} files` : ''}`);
  lines.push(`Showing ${r.packs.length} of ${r.totalPacks} pack(s) (limit ${r.limit}; raise limit up to ${CHARACTER_LIST_MAX_LIMIT})`);
  for (const p of r.packs) {
    const mName = p.manifest?.ok ? `${p.manifest.name || '(unnamed)'}${p.manifest.version ? ` ${formatVersion(p.manifest.version)}` : ''}` : '(no manifest.json)';
    const mSummary = p.manifest?.ok ? truncateText(p.manifest.summary, CHARACTER_SUMMARY_MAX_CHARS) : '';
    lines.push(`${p.name}/ | ${p.fileCount} file(s) | ${p.totalBytes} B | ${formatCardMtime(p.mtimeMs)} | default file: ${p.mainFile || '(none)'} | manifest: ${mName}${mSummary ? ` - ${mSummary}` : ''}`);
  }
  for (const f of r.loose) {
    lines.push(`${f.name} | ${f.title || '(no title)'} | ${f.size} B | ${formatCardMtime(f.mtimeMs)} | (loose file)`);
  }
  lines.push('A character = one pack folder. Play/reference one with qq_character_pack(character="<pack name>"); read a single file with qq_character_read; list one pack\'s files with qq_character_list(character="<pack name>"). Only the card imported into persona.md is injected into your prompt automatically - every other pack is not.');
  lines.push('START FROM SKILL.md: every pack keeps its playable definition in SKILL.md (persona voice, mannerisms, relationship map, do/don\'t) - read it FIRST with qq_character_read(character="<pack name>", file="SKILL.md"), then pull only the extra files you actually need (personality.md / profile.md / interaction.md / relations.md / memory.md / conflicts.md / ULTIMATE_ROLEPLAY_PROMPT.md). The library root is whatever social.charactersDir says; with that unset it is the owner\'s ~/Downloads/characters/characters when that folder exists, otherwise the packs shipped with the bot under <install>/resources/runtime/qq-bridge/characters (one folder per character; a parent folder that contains only more character folders is walked one level down automatically).');
  return lines.join('\n');
}

function characterReadText(character, file, maxBytes, dirOverride) {
  const dir = dirOverride ? path.resolve(String(dirOverride)) : resolveCharactersDir();
  const r = readCharacterFile(dir, character, file, { maxBytes });
  if (!r.ok) {
    if (r.reason === 'directory-not-found') return characterUnavailableText(r, dir);
    const lines = [`Cannot read character file: ${r.error ?? r.reason}`, `Library: ${r.dir} - 0 bytes read.`];
    if (Array.isArray(r.files) && r.files.length) lines.push(`Files in this pack: ${r.files.join(', ')}`);
    else lines.push('Use qq_character_list to see the pack names, or qq_character_list(character="<pack>") for one pack\'s files.');
    return lines.join('\n');
  }
  const lines = [];
  lines.push(r.kind === 'loose-file'
    ? `Character file (loose file at the library root): ${r.character}`
    : `Character pack file: ${r.character}/${r.file}${r.defaultFile ? ' (default file of this pack)' : ''}`);
  lines.push(`Library: ${r.dir} | pack: ${r.packFileCount} file(s), ${r.packTotalBytes} B`);
  lines.push(manifestLine(r.manifest));
  if (r.fileIgnored) lines.push('Note: the "file" argument was ignored because "character" is a loose card file.');
  lines.push(`Returned: ${r.totalBytes} B of ${r.totalSize} B (limit ${r.limitBytes} B)`);
  if (r.truncated) {
    lines.push(`TRUNCATED at ${r.limitBytes} B (${Math.round(r.limitBytes / 1024)} KB): this file is larger than what is returned here.`);
    lines.push(`To read more: call again with maxBytes up to ${CHARACTER_READ_MAX_BYTES}${r.kind === 'pack-file' ? `, or get the core docs with qq_character_pack(character="${r.character}")` : ''}.`);
  }
  lines.push('');
  for (const p of r.parts) {
    lines.push(`===== FILE: ${p.rel} (${p.size} B${p.truncated ? `, truncated to ${p.bytes} B` : ''}) =====`);
    lines.push(p.text);
  }
  lines.push('');
  lines.push('Local reference only: this is the owner\'s private character pack. Do not paste a whole pack into QQ chat and do not reveal the library path to chat peers.');
  return lines.join('\n');
}

function characterPackText(character, maxBytes, dirOverride) {
  const dir = dirOverride ? path.resolve(String(dirOverride)) : resolveCharactersDir();
  const r = readCharacterPack(dir, character, { maxBytes });
  if (!r.ok) {
    if (r.reason === 'directory-not-found') return characterUnavailableText(r, dir);
    return [
      `Cannot read character pack: ${r.error ?? r.reason}`,
      `Library: ${r.dir} - 0 bytes read.`,
      'Use qq_character_list to see the pack names (a character = one pack folder).'
    ].join('\n');
  }
  const lines = [];
  lines.push(`Character pack: ${r.character}/ (${r.fileCount} file(s), ${r.packTotalBytes} B on disk${r.skippedManifest ? `, ${r.skippedManifest} manifest.json kept out of the body` : ''})`);
  lines.push(`Library: ${r.dir}`);
  lines.push(manifestLine(r.manifest));
  lines.push(`Returned: ${r.totalBytes} B of ${r.totalSize} B body text (${r.includedCount}/${r.bodyFileCount} file(s); cap ${r.limitBytes} B)`);
  if (r.truncated) {
    lines.push(`TRUNCATED at ${r.limitBytes} B (${Math.round(r.limitBytes / 1024)} KB)${r.cutIn ? ` - cut off inside ${r.cutIn}` : ''}: this pack is larger than what is returned here.`);
    if (r.notIncluded.length) lines.push(`Files not included (${r.notIncluded.length}): ${r.notIncluded.join(', ')}`);
    lines.push(`To read the rest: qq_character_read(character="${r.character}", file="<name>") one file at a time, or raise maxBytes up to ${CHARACTER_PACK_MAX_BYTES}.`);
  }
  lines.push('');
  for (const p of r.parts) {
    lines.push(`===== FILE: ${p.rel} (${p.size} B${p.truncated ? `, truncated to ${p.bytes} B` : ''}) =====`);
    lines.push(p.text);
  }
  lines.push('');
  lines.push('Local reference only: this is the owner\'s private character pack. Do not paste a whole pack into QQ chat and do not reveal the library path to chat peers.');
  return lines.join('\n');
}

function characterSearchText(query, limit, dirOverride) {
  const dir = dirOverride ? path.resolve(String(dirOverride)) : resolveCharactersDir();
  if (!String(query ?? '').trim()) {
    return `Search keyword is empty - pass what to look for inside the character packs (e.g. "猫娘" or "傲娇"), then call again. Library: ${dir}`;
  }
  const r = searchCharacterCards(dir, query, { limit });
  if (!r.ok) return characterUnavailableText(r, dir);
  const lines = [];
  const packsHit = new Set(r.hits.filter((h) => h.rel.includes('/')).map((h) => h.rel.split('/')[0])).size;
  lines.push(`Search "${r.query}" in ${r.dir}: ${r.total} matching file(s) in ${packsHit} character pack(s), ${r.scanned} file(s) scanned (space-separated words are ANDed)`);
  if (!r.total) {
    lines.push('Nothing matched. Try a shorter keyword, or list the packs with qq_character_list.');
    return lines.join('\n');
  }
  if (r.total > r.hits.length) lines.push(`Showing ${r.hits.length} of ${r.total} (limit ${r.limit}; raise limit up to ${CHARACTER_SEARCH_MAX_LIMIT})`);
  for (const h of r.hits) {
    const slash = h.rel.indexOf('/');
    const where = slash < 0 ? `${h.rel} (loose file)` : `${h.rel.slice(0, slash)} -> ${h.rel.slice(slash + 1)}`;
    lines.push(`${where} | ${h.title || '(no title)'} | ${h.size} B | ${h.matchCount} matching line(s)${h.nameMatch ? ' | file name matched' : ''}`);
    for (const s of h.snippets) lines.push(`  ${s}`);
  }
  lines.push('Snippets only - use qq_character_read(character, file) for one file or qq_character_pack(character) for a whole pack; never paste character card content into QQ chat.');
  return lines.join('\n');
}

if (cfg.social?.tools?.characterCards !== false) {
  registerTool(
    'qq_character_list',
    'List the character packs (roleplay personas) in the owner\'s local character library (read-only). One pack = one folder (e.g. atri/ with SKILL.md, ULTIMATE_ROLEPLAY_PROMPT.md, personality.md, profile.md, interaction.md, relations.md, memory.md, conflicts.md, manifest.json, sources/wiki.md); each row shows pack name, file count, total size, modified time, and the name/summary from its manifest.json. Loose card files sitting at the library root are listed too and marked "(loose file)". Use when the owner says "看看角色库有什么 / 有哪些角色 / which characters do you have", before switching or roleplaying a character, or to get the pack name for qq_character_pack. Pass character="<pack name>" to list the files inside one pack - that is how you find the file= value for qq_character_read. Only the one card imported into persona.md is injected into your prompt; every other pack is NOT, so this is how you find one.',
    {
      limit: z.number().optional().describe('Max packs to list, default 100, max 500'),
      character: z.string().optional().describe('Optional pack name (e.g. "atri"): list the files inside that pack instead of all packs')
    },
    async ({ limit, character }) => {
      try {
        return { content: [{ type: 'text', text: characterListText(limit, character) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Failed to list character packs: ${error?.message ?? error}` }], isError: true };
      }
    }
  );

  registerTool(
    'qq_character_read',
    'Read ONE file out of a character pack (or a loose card file at the library root) in the owner\'s local character library (read-only). Pass character="<pack name from qq_character_list>" plus file="<path inside the pack, e.g. SKILL.md, personality.md, sources/wiki.md>"; with file omitted it returns the pack\'s SKILL.md (fallback order: manifest.json -> ULTIMATE_ROLEPLAY_PROMPT.md -> personality.md). Use when the owner says "把某个角色的 SKILL 读出来 / 换成 XX 角色 / 扮演 XX / 参考某张角色卡", or when you need one exact file\'s wording before roleplaying - for a whole character in one call use qq_character_pack instead. Content is capped at 32KB (raise maxBytes, hard cap 131072) and truncation is reported honestly. Local reference only: do not paste a whole pack into QQ chat.',
    {
      character: z.string().describe('Character pack name (a folder, e.g. "atri") or a loose card file name at the library root (e.g. "ATRI_MAIN_PROMPT.md")'),
      file: z.string().optional().describe('File inside the pack, relative to it (e.g. "SKILL.md", "personality.md", "sources/wiki.md"); omitted = that pack\'s default file'),
      maxBytes: z.number().optional().describe('Byte cap for this read, default 32768 (32KB), max 131072 (128KB)')
    },
    async ({ character, file, maxBytes }) => {
      try {
        return { content: [{ type: 'text', text: characterReadText(character, file, maxBytes) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Failed to read character file: ${error?.message ?? error}` }], isError: true };
      }
    }
  );

  registerTool(
    'qq_character_pack',
    'Return one entire character pack in a single call (read-only): the pack\'s core documents concatenated in order SKILL.md -> personality.md -> profile.md -> interaction.md -> relations.md -> memory.md -> conflicts.md -> ULTIMATE_ROLEPLAY_PROMPT*, with the manifest.json name/summary in the header. Use this FIRST when the owner says "换成 XX 角色 / 扮演 XX / 参考某个角色卡 / let us roleplay X" - it is the most useful single call for getting into a character. Capped at 24KB by default (raise maxBytes, hard cap 131072); when it truncates it says exactly which file was cut and what was left out, and you can pull the rest with qq_character_read. Local reference only: do not paste a whole pack into QQ chat.',
    {
      character: z.string().describe('Character pack name (a folder, e.g. "atri"); see qq_character_list'),
      maxBytes: z.number().optional().describe('Byte cap for the concatenated text, default 24576 (24KB), max 131072 (128KB)')
    },
    async ({ character, maxBytes }) => {
      try {
        return { content: [{ type: 'text', text: characterPackText(character, maxBytes) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Failed to read character pack: ${error?.message ?? error}` }], isError: true };
      }
    }
  );

  registerTool(
    'qq_character_search',
    'Search the owner\'s local character library (read-only, packs) for a keyword or phrase and get the matching files with short line snippets (never full text). Space-separated words are ANDed. Use when the owner asks which character has some trait, setting or catchphrase (e.g. "哪个角色的设定里有猫娘"), or to locate the right pack/file before qq_character_pack / qq_character_read. Do not paste character card content into QQ chat.',
    {
      query: z.string().describe('Keyword or phrase to find inside the packs (e.g. "猫娘", "傲娇", a character name); space-separated words must all appear'),
      limit: z.number().optional().describe('Max files to return, default 10, max 50')
    },
    async ({ query, limit }) => {
      try {
        return { content: [{ type: 'text', text: characterSearchText(query, limit) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Failed to search character packs: ${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// 供 tests/character-library.test.js 直接 import 调用（纯逻辑，不依赖 MCP 传输层）
export {
  DEFAULT_CHARACTERS_DIR,
  BUNDLED_CHARACTERS_DIR,
  CHARACTER_EXTS,
  CHARACTER_READ_DEFAULT_BYTES,
  CHARACTER_READ_MAX_BYTES,
  CHARACTER_PACK_DEFAULT_BYTES,
  CHARACTER_PACK_MAX_BYTES,
  CHARACTER_PACK_MAX_FILE_DEPTH,
  resolveCharactersDir,
  normalizeCharacterRel,
  resolveCharacterPath,
  isInsideDir,
  containedRealPath,
  openCharactersRoot,
  scanCharacterFiles,
  readCardFileBytes,
  orderCardFiles,
  pickDefaultPackFile,
  readPackManifest,
  listCharacterPacks,
  listPackFiles,
  readCharacterFile,
  readCharacterPack,
  searchCharacterCards,
  characterListText,
  characterReadText,
  characterPackText,
  characterSearchText
};

// 启动 MCP stdio server（修复: 缺少 connect 导致进程静默退出）
// QQB_MCP_NO_LISTEN=1 时只加载模块、不连 stdio：给 tests/character-library.test.js 直接用纯函数。
// DSH spawn 时不设这个变量，启动行为与改动前完全一致。
if (process.env.QQB_MCP_NO_LISTEN !== '1') {
  await server.connect(new StdioServerTransport());
}
