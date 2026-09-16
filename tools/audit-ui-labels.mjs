#!/usr/bin/env node
/**
 * 管理端界面「裸露英文键」审计（Node 脚本，不进打包产物）。
 *
 * 起因：管理端会把 config.json 的键直接渲染成字段名；没登记中文名的键就回落成
 *       `refreshOnMessageMs` 这种原始英文键名。本脚本是「一个都不许留」的验收依据。
 *
 * 数据全部来自**真实文件**，不手抄：
 *   ① qq-bridge/config.example.json + qq-bridge/config.json → 全部配置键路径（含中间分组键）
 *   ② src/pages/BridgeConfig.tsx → 卡片白名单（path= / path: / only: / topOnly）、LABEL / TOOL_LABEL / MCP_LABEL 标签表
 *   ③ src/tool-schema-chars.ts → 「工具 schema 精简」卡里逐行渲染的 MCP 工具原名
 *   ④ src/pages/VoiceConfig.tsx → 语音页四类模型的角色 id（meta.label 缺失时的回落值）
 *
 * 判定：键（含分组键）必须有中文标签，且标签非空、含汉字。
 *       标签解析与界面一致：LABEL[完整路径] ?? LABEL[末段名] ?? TOOL_LABEL[末段名]（社交工具开关）。
 * 注意：脚本读的是**静态标签表**，不是 pretty() 的运行时兜底 —— 因此运行时兜底不会让审计蒙混过关。
 *
 * 用法：node tools/audit-ui-labels.mjs
 * 退出码：0 = 未翻译键 0 个；1 = 有未翻译键（清单会逐条打印）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const readIf = (p) => { const f = path.join(ROOT, p); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const hasHan = (s) => HAN.test(String(s ?? ''));

/* ---------- 1. 从 JS 对象字面量里取键值（跳过注释、支持引号键） ---------- */
function blockOf(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return '';
  const start = src.indexOf('{', at);
  if (start < 0) return '';
  let depth = 0, q = null;
  for (let j = start; j < src.length; j++) {
    const c = src[j], prev = src[j - 1];
    if (q) { if (c === q && prev !== '\\') q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '/' && src[j + 1] === '/') { const nl = src.indexOf('\n', j); j = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && src[j + 1] === '*') { const e = src.indexOf('*/', j); j = e < 0 ? src.length : e + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start + 1, j); }
  }
  return '';
}
/** 取出字面量顶层 `键: 值`（值只保留其首段字符串，够判空/判中文）。
 *  逐字符扫描时就跳过 // 与 /* *\/ 注释（标签表分段注释很密；不剥注释的话
 *  「注释行 + 紧随其后的第一条」会拼成一个坏 chunk 被整条丢掉 —— 第一版就是这么漏了 36 条）。 */
function entriesOf(block) {
  const out = [];
  let depth = 0, q = null, buf = '';
  const push = () => {
    const m = /^\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]*)$/.exec(buf);
    if (m) {
      const key = m[1] ?? m[2] ?? m[3];
      const valChunk = m[4] || '';
      const lit = /(['"`])((?:[^\\]|\\.)*?)\1/.exec(valChunk);
      out.push({ key, value: lit ? lit[2] : valChunk.trim() });
    }
    buf = '';
  };
  for (let i = 0; i < block.length; i++) {
    const c = block[i], prev = block[i - 1];
    if (q) { buf += c; if (c === q && prev !== '\\') q = null; continue; }
    if (c === '/' && block[i + 1] === '/') { const nl = block.indexOf('\n', i); i = nl < 0 ? block.length : nl; continue; }
    if (c === '/' && block[i + 1] === '*') { const e = block.indexOf('*/', i); i = e < 0 ? block.length : e + 1; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; buf += c; continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    if (c === '}' || c === ']' || c === ')') depth--;
    if (c === ',' && depth === 0) { push(); continue; }
    buf += c;
  }
  push();
  return out.filter((e) => e.key);
}
const tableOf = (src, marker) => {
  const list = entriesOf(blockOf(src, marker));
  const map = new Map();
  for (const e of list) map.set(e.key, e.value);
  return map;
};

/* ---------- 2. 配置键（真实文件） ---------- */
function collectPaths(file) {
  const raw = readIf(file);
  if (!raw) return null;
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { console.error(`× 解析失败 ${file}: ${e.message}`); process.exit(2); }
  const keys = [], branches = [], commentKeys = [];
  const walk = (node, prefix) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [k, v] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${k}` : k;
      // `_note` 这类「JSON 注释键」（值一定是一段说明文字）：按约定不进界面渲染，
      // 由 keysOf/Field 侧跳过（见 src/pages/BridgeConfig.tsx 的 isCommentKey），单列不查标签。
      if (k.startsWith('_') && typeof v === 'string') { commentKeys.push(p); continue; }
      keys.push(p);
      if (v && typeof v === 'object' && !Array.isArray(v)) { branches.push(p); walk(v, p); }
    }
  };
  walk(obj, '');
  return { file, keys, branches, commentKeys, text: obj };
}

const configs = ['qq-bridge/config.example.json', 'qq-bridge/config.json']
  .map((f) => collectPaths(f))
  .filter(Boolean);
if (!configs.length) { console.error('× 没找到任何 qq-bridge 配置文件，无法审计'); process.exit(2); }

/* ---------- 3. 页面里的标签表与白名单 ---------- */
const bridge = readIf('src/pages/BridgeConfig.tsx');
if (!bridge) { console.error('× 读不到 src/pages/BridgeConfig.tsx'); process.exit(2); }
const LABEL = tableOf(bridge, 'const LABEL: Record<string, string>');
const TOOL_LABEL = tableOf(bridge, 'const TOOL_LABEL: Record<string, string>');
const MCP_LABEL = tableOf(bridge, 'const MCP_LABEL: Record<string, string>');

/* 白名单：path="x.y"、path: 'x.y'、only: [...]、const topOnly = [...]、ch('a.b.c') / get(cfg,'a.b') 里出现的点路径 */
const quotedKeys = new Set();
const quotedPaths = new Set();
const CONFIG_ROOTS = ['dsh', 'napcat', 'social', 'slang', 'guard', 'security', 'allow', 'deny'];
const addPath = (raw) => {
  if (typeof raw !== 'string' || !raw) return;
  const segs = raw.split('.');
  if (!CONFIG_ROOTS.includes(segs[0])) return;
  if (!segs.every((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s))) return;
  quotedPaths.add(raw);
  for (const s of segs) quotedKeys.add(s);
};
for (const m of bridge.matchAll(/\bpath\s*[:=]\s*\{?\s*(?:'([^']+)'|"([^"]+)")/g)) addPath(m[1] ?? m[2]);
for (const m of bridge.matchAll(/\bonly\s*[:=]\s*\[([^\]]*)\]/g)) {
  for (const q of m[1].matchAll(/'([^']+)'|"([^"]+)"/g)) quotedKeys.add(q[1] ?? q[2]);
}
for (const m of bridge.matchAll(/\bconst\s+(\w+)\s*=\s*\[([^\]]*)\]/g)) {
  if (!new RegExp(`only=\\{${m[1]}\\}`).test(bridge)) continue;
  for (const q of m[2].matchAll(/'([^']+)'|"([^"]+)"/g)) quotedKeys.add(q[1] ?? q[2]);
}
for (const m of bridge.matchAll(/'((?:[a-z][A-Za-z0-9_]*)(?:\.[A-Za-z0-9_]+)+)'/g)) addPath(m[1]);

/* 白名单键落成完整路径：只在它确实是某配置文件里某分组的成员时才算路径 */
const cfgPathSet = new Set();
const cfgLeafByParent = new Map(); // parent -> Set(child)
for (const c of configs) {
  for (const p of c.keys) {
    cfgPathSet.add(p);
    const i = p.lastIndexOf('.');
    const parent = i < 0 ? '' : p.slice(0, i);
    const child = i < 0 ? p : p.slice(i + 1);
    if (!cfgLeafByParent.has(parent)) cfgLeafByParent.set(parent, new Set());
    cfgLeafByParent.get(parent).add(child);
  }
}
const whitelistPaths = new Set();
for (const p of quotedPaths) whitelistPaths.add(p);
const dumpKeys = (keys) => [...keys].sort().join('、');

/* ---------- 4. MCP 工具原名（工具 schema 精简卡逐行渲染） ---------- */
const charsTs = readIf('src/tool-schema-chars.ts') || '';
const slimPrefix = (/'SLIM_PREFIX'\s*=\s*'([^']+)'/.exec(charsTs) || /export const SLIM_PREFIX = '([^']+)'/.exec(charsTs) || [])[1] || 'mcp__napcat__';
const schemaTable = tableOf(charsTs, 'export const TOOL_SCHEMA_CHARS: Record<string, number>');
const mcpRendered = [...schemaTable.keys()].filter((n) => n.startsWith(slimPrefix)).map((n) => n.slice(slimPrefix.length));

/* ---------- 5. 语音页四类模型的角色 id ---------- */
const voice = readIf('src/pages/VoiceConfig.tsx') || '';
const roleOrder = [...(/ROLE_ORDER\s*=\s*\[([^\]]*)\]/.exec(voice)?.[1] || '').matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
const ROLE_LABEL = tableOf(voice, 'const ROLE_LABEL: Record<string, string>');

/* ---------- 6. 判定 ---------- */
const misses = [];
const addMiss = (kind, key, why) => misses.push({ kind, key, why });
const labelFor = (fullPath) => {
  const last = fullPath.split('.').pop();
  return { text: LABEL.get(fullPath) ?? LABEL.get(last) ?? TOOL_LABEL.get(last), where: LABEL.get(fullPath) != null ? 'LABEL[路径]' : (LABEL.get(last) != null ? 'LABEL[键名]' : (TOOL_LABEL.get(last) != null ? 'TOOL_LABEL' : '—')) };
};

/* 6.1 配置键（叶子 + 分组键，全部要中文标签） */
for (const c of configs) {
  for (const p of c.keys) {
    const { text, where } = labelFor(p);
    if (text == null) addMiss('配置键', p, `${rel(path.join(ROOT, c.file))} 里的键没有中文标签`);
    else if (!String(text).trim()) addMiss('配置键', p, '标签是空串（界面上会显示成空白）');
    else if (!hasHan(text)) addMiss('配置键', p, `标签不是中文：“${text}”（命中 ${where}）`);
  }
}
/* 6.2 页面白名单路径（可能出现于 config 尚未包含的版本） */
for (const p of whitelistPaths) {
  if (cfgPathSet.has(p)) continue;
  const { text } = labelFor(p);
  if (text == null) addMiss('白名单路径', p, 'BridgeConfig.tsx 里引用、但 LABEL 没有条目');
  else if (!hasHan(text)) addMiss('白名单路径', p, `标签不是中文：“${text}”`);
}
/* 6.3 白名单裸键名（only: [...] 里的短名） */
for (const k of quotedKeys) {
  if (cfgPathSet.has(k)) continue;                                  // 完整路径已在 6.1/6.2 覆盖
  const known = LABEL.has(k) || TOOL_LABEL.has(k) || MCP_LABEL.has(k);
  if (!known) continue;                                            // 不是配置键的短名（如角色 slug）不在此列
  const text = LABEL.get(k) ?? TOOL_LABEL.get(k);
  if (text != null && !hasHan(text)) addMiss('白名单键名', k, `标签不是中文：“${text}”`);
}
/* 6.4 social.tools.* 工具开关（prettyTool 回落 = 英文工具 key） */
const toolKeys = new Set();
for (const c of configs) for (const p of c.keys) { const m = /^social\.tools\.(.+)$/.exec(p); if (m) toolKeys.add(m[1]); }
for (const k of TOOL_LABEL.keys()) toolKeys.add(k);
for (const k of toolKeys) {
  const text = TOOL_LABEL.get(k) ?? LABEL.get(k);
  if (text == null) addMiss('工具开关', `social.tools.${k}`, 'MCP 工具开关没有中文名（界面上会显示英文 key）');
  else if (!hasHan(text)) addMiss('工具开关', `social.tools.${k}`, `中文名不是中文：“${text}”`);
}
/* 6.5 工具 schema 精简卡逐行渲染的 MCP 工具原名 */
for (const short of mcpRendered) {
  const text = MCP_LABEL.get(short);
  if (text == null) addMiss('MCP 工具原名', `${slimPrefix}${short}`, '精简名单里逐行渲染，但没有中文名');
  else if (!hasHan(text)) addMiss('MCP 工具原名', `${slimPrefix}${short}`, `中文名不是中文：“${text}”`);
}
/* 6.6 语音页角色 id 的回落显示 */
for (const r of roleOrder) {
  const text = ROLE_LABEL.get(r);
  if (text == null) addMiss('语音角色', r, 'meta.label 缺失时会回落成这个英文 id，VoiceConfig.tsx 没有 ROLE_LABEL 兜底');
  else if (!hasHan(text)) addMiss('语音角色', r, `兜底名不是中文：“${text}”`);
}
/* 6.7 标签表自身的体检：任何一条标签都不许是空串/纯英文（空串会让字段名整片空白） */
for (const [name, table] of [['LABEL', LABEL], ['TOOL_LABEL', TOOL_LABEL], ['MCP_LABEL', MCP_LABEL], ['ROLE_LABEL', ROLE_LABEL]]) {
  for (const [k, v] of table) {
    if (!String(v).trim()) addMiss('标签表', `${name}.${k}`, '标签是空串（界面上会显示成空白字段）');
    else if (!hasHan(v)) addMiss('标签表', `${name}.${k}`, `标签不是中文：“${v}”`);
  }
}
/* 6.8 全站静态扫描（用 TypeScript 的语法树真解析 JSX，不靠正则猜）：
 *      · 短文案（≤40 字，就是"字段名 / 按钮 / 小标题"那一类）里出现 camelCase / snake_case → 直接算未翻译；
 *      · 长文案（说明段落、ⓘ 说明）里点名桥里的键名 → 不算错，单列出来（主人明确要求说明里写清键名）。
 *      覆盖 Home / Learning / SSHConfig / GroupPortrait / WebView / components / api 等所有 src 文件。 */
const TECH_ALLOW = [
  /^mcp__napcat__$/, /^todo_write$/, /^ask_user_question$/, /^get_rkey$/, /^NAPCAT_QUICK_PASSWORD_MD5$/,
  /^config\.json$/, /^persona\.md$/, /^speech-rules\.md$/, /^webui\.json$/, /^activity-windows\.json$/,
  /^profiles\.json$/, /^qq_/, /^httpServers$/, /^websocketServers$/, /^onebot11/,
  /^[a-z][a-z0-9-]*\.(?:js|mjs|json|md|py|ya?ml)$/,        // mcp-napcat-safe.js / napcat_<QQ>.json 这类文件名
  /^napcat_qq$/, /^napcat-qq$/, /^mimo_default$/, /^deepseek-v4-pro$/, /^truefriend$/,
  /^[a-z][a-z0-9-]*(?:_[a-z0-9-]+)+$/,                     // docker 容器/数据卷名
];
const srcFiles = [];
(function walkDir(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkDir(p);
    else if (/\.tsx?$/.test(ent.name)) srcFiles.push(path.relative(ROOT, p).replace(/\\/g, '/'));
  }
})(path.join(ROOT, 'src'));
const IDENT = /\b[a-z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const LABELISH_ATTRS = new Set(['label', 'title', 'placeholder', 'aria-label', 'alt']);
/* 纯英文标签的判定：先把**单位 / 产品名 / 协议名 / 数字 / 链接**这些"翻掉反而看不懂"的部分去掉，
   剩下的字符里还有英文字母才算未翻译。这样做的好处：'API Key' 会被抓出来（Key 不认识），
   而 '5MB'、'26.9k tokens'、'PID：'、'GitHub: AbyssalQuill/MoonBot'、'tok' 不会误报。 */
/* 长的词必须排在前面（否则 'G' 会先把 'GitHub' 咬掉一半）；单字母单位加边界，
   免得把 "GitHub" 里的 G、"MoonBot" 里的 M 当成单位。 */
const KNOWN_TOKENS = new RegExp([
  'https?://\\S+', '\\d+(?:[.,]\\d+)*',
  'AbyssalQuill', 'MoonBot', 'NapCat', 'DeepSeek', 'Harness', 'GitHub', 'truefriend', 'OneKey', 'DSH',
  'WebUI', 'HTTPS', 'tokens', 'token', 'Token', 'tok', 'Bridge', 'MCP', 'JSON', 'JPEG', 'WSS',
  'MP3', 'WAV', 'PNG', 'GIF', 'VBS', 'API', 'SDK', 'CLI', 'MD5', 'URL', 'URI', 'PID', 'Esc',
  'HTTP', 'Agent', 'QQ', 'WS', 'ID', 'MB', 'KB', 'GB', 'TB', 'ms',
  '(?<![A-Za-z])[MGks%](?![A-Za-z])',
].join('|'), 'g');
const shortHits = [];
const proseHits = [];
function scanNode(file, src, node) {
  const consider = (text, nodeForLine) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // <code>/<pre> 里的内容是**行内技术引用**（文件名、工具原名、桥里的键名）——
    // 与说明段落同等待遇：列出来但不判错（主人明确要求说明里写清桥里的键名）。
    const parentTag = node.parent && ts.isJsxElement(node.parent)
      ? node.parent.openingElement.tagName.getText(src) : '';
    const inCode = parentTag === 'code' || parentTag === 'pre';
    const line = src.getLineAndCharacterOfPosition(nodeForLine.getStart(src)).line + 1;
    if (!inCode && !hasHan(trimmed) && trimmed.length <= 60
      && /[A-Za-z]/.test(trimmed.replace(KNOWN_TOKENS, ''))) {
      shortHits.push({ file, line, tok: trimmed, text: trimmed });
      return;
    }
    for (const id of trimmed.matchAll(IDENT)) {
      if (TECH_ALLOW.some((re) => re.test(id[0]))) continue;
      const rec = { file, line, tok: id[0], text: trimmed.replace(/\s+/g, ' ').slice(0, 70) };
      (inCode || trimmed.length > 40 ? proseHits : shortHits).push(rec);
    }
  };
  if (ts.isJsxText(node)) consider(node.text, node);
  if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)
    && LABELISH_ATTRS.has(node.name.getText(src))) consider(node.initializer.text, node);
  ts.forEachChild(node, (c) => scanNode(file, src, c));
}
for (const f of srcFiles) {
  const raw = readIf(f) || '';
  const sf = ts.createSourceFile(f, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  scanNode(f, sf, sf);
}
for (const hit of shortHits) addMiss('全站短文案', `${hit.file}:${hit.line}`, `短文案里出现英文标识符 “${hit.tok}”（…${hit.text}…）`);

/* ---------- 7. 报告 ---------- */
const kindOrder = ['配置键', '白名单路径', '白名单键名', '工具开关', 'MCP 工具原名', '语音角色', '标签表', '全站短文案'];
const uniq = new Map();
for (const m of misses) uniq.set(`${m.kind}\u0000${m.key}`, m);
const list = [...uniq.values()].sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || a.key.localeCompare(b.key));

console.log('MoonBot 管理端界面标签审计（裸露英文键检查）');
console.log('─'.repeat(64));
console.log(`配置文件      : ${configs.map((c) => `${rel(path.join(ROOT, c.file))}（${c.keys.length} 键 / ${c.branches.length} 分组）`).join('、')}`);
console.log(`页面          : src/pages/BridgeConfig.tsx（标签表 LABEL ${LABEL.size} 条、TOOL_LABEL ${TOOL_LABEL.size} 条、MCP_LABEL ${MCP_LABEL.size} 条）`);
console.log(`白名单        : ${quotedPaths.size} 条显示路径、${quotedKeys.size} 个键名（来自 path= / only: / topOnly / ch() / get()）`);
console.log(`工具原名      : src/tool-schema-chars.ts 里受精简卡控制的 ${mcpRendered.length} 个 ${slimPrefix}* 工具`);
console.log(`语音角色      : ${roleOrder.length} 个角色 id（${roleOrder.join(' / ')}）`);
const commentKeys = [...new Set(configs.flatMap((c) => c.commentKeys))];
console.log(`注释键        : ${commentKeys.length} 个 \`_\` 前缀 JSON 注释键（按约定不进界面渲染，不查标签）：${dumpKeys(commentKeys) || '无'}`);
console.log('─'.repeat(64));
console.log(`检查键总数    : ${new Set(configs.flatMap((c) => c.keys)).size} 个配置键 + ${whitelistPaths.size} 条白名单路径 + ${toolKeys.size} 个工具开关 + ${mcpRendered.length} 个 MCP 原名 + ${roleOrder.length} 个语音角色`);
console.log(`全站短文案    : 扫了 src 下 ${srcFiles.length} 个文件（TypeScript 语法树解析 JSX 文本与 title/label/placeholder 属性）`);
const proseUniq = [...new Map(proseHits.map((p) => [p.file + p.line + p.tok, p])).values()];
console.log(`说明文字里点名的键名: ${proseUniq.length} 处（**有意保留**：主人要求 ⓘ/说明里写清"桥里的键名"，不是字段名）`);
for (const p of proseUniq.slice(0, 60)) console.log(`    · ${p.file}:${p.line} 「${p.tok}」  …${p.text}…`);
if (list.length === 0) {
  console.log('');
  console.log('未翻译键 = 0');
  console.log('');
  console.log('✅ 界面上所有会渲染的配置键 / 工具标识符都有中文名。');
  process.exit(0);
}
console.log('');
console.log(`未翻译键 = ${list.length}`);
console.log('');
for (const kind of kindOrder) {
  const group = list.filter((m) => m.kind === kind);
  if (!group.length) continue;
  console.log(`【${kind}】${group.length} 个`);
  for (const m of group) console.log(`  · ${m.key} —— ${m.why}`);
  console.log('');
}
console.log('❌ 有键会在界面上裸奔英文名，请补中文标签（必要时补 ⓘ 说明）后重跑。');
process.exit(1);
