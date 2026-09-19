/**
 * Audit the manager UI's tool-related tables against the bridge itself.
 *
 * WHY: the config pages carry three hand-maintained tables that all reference bridge names:
 *   · TOOL_MCP   switch key -> MCP tool name(s)        (shown as "中文名 · 工具名")
 *   · MCP_LABEL  MCP tool name -> Chinese label        (slim-tools card; missing -> "未登记")
 *   · TOOL_LABEL switch key -> Chinese label           (missing -> raw English key leaks into the UI)
 * Every time a tool is added/renamed, these drift silently -- a tool shows up as 未登记, or a config
 * entry is offered for a switch the bridge never reads (an unregistered-name config item).
 *
 * Sources of truth: the bridge source itself (registerTool/server.tool), console-server's
 * ToolEnabled('key') switches, and src/tool-schema-chars.ts (the slim card's row list).
 *
 * Usage: node tools/audit-ui-tool-names.mjs
 * Exit code 1 when anything drifts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const UI = path.join(REPO, 'src', 'pages', 'BridgeConfig.tsx');
const CHARS = path.join(REPO, 'src', 'tool-schema-chars.ts');
const BRIDGE_SRC = path.join(REPO, 'qq-bridge', 'src');

const uiSrc = fs.readFileSync(UI, 'utf8');

/** Parse a `const NAME: Record<string, string> = { ... };` block into [key, value] pairs. */
function recordBlock(name) {
  const start = uiSrc.indexOf(`const ${name}`);
  if (start < 0) throw new Error(`block ${name} not found`);
  const eq = uiSrc.indexOf('{', start);
  const end = uiSrc.indexOf('\n};', eq);
  const body = uiSrc.slice(eq + 1, end);
  const out = new Map();
  // values may contain quotes/commas inside strings; keys are plain identifiers
  for (const m of body.matchAll(/(^|[\s,{])([A-Za-z][A-Za-z0-9_]*)\s*:\s*(['"])((?:\\.|(?!\3)[\s\S])*?)\3/g)) {
    out.set(m[2], m[4]);
  }
  return out;
}

const TOOL_MCP = recordBlock('TOOL_MCP');
const MCP_LABEL = recordBlock('MCP_LABEL');
const TOOL_LABEL_BLOCK = (() => {
  // the switch-label table sits right above TOOL_MCP; find the nearest record before it
  const idx = uiSrc.indexOf('const TOOL_MCP');
  const before = uiSrc.slice(0, idx);
  const names = [...before.matchAll(/const ([A-Z][A-Z0-9_]+)(?=: Record<string, string> = \{)/g)].map((m) => m[1]);
  return names[names.length - 1];
})();
const TOOL_LABEL = recordBlock(TOOL_LABEL_BLOCK);

// ---- bridge side ------------------------------------------------------------
const defined = new Set();
for (const f of ['mcp-napcat-safe.js', 'mcp-host-server.js', 'mcp-web-search-safe.js']) {
  const src = fs.readFileSync(path.join(BRIDGE_SRC, f), 'utf8');
  for (const m of src.matchAll(/(?:registerTool|server\.tool)\(\s*['"]([A-Za-z0-9_]+)['"]/g)) defined.add(m[1]);
}

const consoleSrc = fs.readFileSync(path.join(BRIDGE_SRC, 'core', 'console-server.js'), 'utf8');
const toolEnabledKeys = new Set([...consoleSrc.matchAll(/ToolEnabled\(\s*['"]([A-Za-z0-9_]+)['"]/g)].map((m) => m[1]));
// Registration-time gates live in the tool files (e.g. `cfg.social?.tools?.pixiv !== false`), so scan
// every bridge module for that shape -- scanning only console-server produced false "never read" hits.
for (const f of fs.readdirSync(BRIDGE_SRC, { recursive: true })) {
  if (typeof f !== 'string' || !f.endsWith('.js')) continue;
  const src = fs.readFileSync(path.join(BRIDGE_SRC, f), 'utf8');
  for (const m of src.matchAll(/social\?\.tools\?\.([A-Za-z][A-Za-z0-9_]*)/g)) toolEnabledKeys.add(m[1]);
  for (const m of src.matchAll(/social\.tools\.([A-Za-z][A-Za-z0-9_]*)/g)) toolEnabledKeys.add(m[1]);
}
// config.js lists the defaults; those keys are switch keys by definition
const configSrc = fs.readFileSync(path.join(BRIDGE_SRC, 'core', 'config.js'), 'utf8');
const toolsDefaults = configSrc.match(/tools:\s*\{([\s\S]*?)\n\s*\}/);
if (toolsDefaults) for (const m of toolsDefaults[1].matchAll(/([A-Za-z][A-Za-z0-9_]*)\s*:/g)) toolEnabledKeys.add(m[1]);

const charsSrc = fs.readFileSync(CHARS, 'utf8');
const slimTools = new Set([...charsSrc.matchAll(/"(mcp__napcat__[A-Za-z0-9_]+)"/g)].map((m) => m[1].replace('mcp__napcat__', '')));

// ---- diffs ------------------------------------------------------------------
const problems = [];
function report(title, list) {
  if (list.length) { problems.push(title); console.log(`[audit] ${title} (${list.length}): ${list.join(', ')}`); }
}

console.log(`[audit] bridge defines ${defined.size} tools; console-server knows ${toolEnabledKeys.size} switch keys`);
console.log(`[audit] UI: TOOL_MCP=${TOOL_MCP.size}, MCP_LABEL=${MCP_LABEL.size}, ${TOOL_LABEL_BLOCK}=${TOOL_LABEL.size}, slim list=${slimTools.size}`);

// 1) the slim card renders tool-schema-chars rows -> every one of them needs a Chinese label
report('slim tool rows without a Chinese label (would render 未登记)', [...slimTools].filter((n) => !MCP_LABEL.has(n)).sort());
// 2) labels pointing at tools that do not exist
report('MCP_LABEL entries for tools that are not defined in the bridge', [...MCP_LABEL.keys()].filter((n) => !defined.has(n)).sort());
// 3) every switch the bridge actually reads should be exposed with a label
report('bridge switch keys missing from the UI label table', [...toolEnabledKeys].filter((k) => !TOOL_LABEL.has(k)).sort());
// 4) config entries offered for switches the bridge never reads (unregistered-name config items)
report('UI switches the bridge never reads', [...TOOL_MCP.keys()].filter((k) => !toolEnabledKeys.has(k)).sort());
report('UI label entries the bridge never reads', [...TOOL_LABEL.keys()].filter((k) => !toolEnabledKeys.has(k)).sort());
// 5) tool names quoted in TOOL_MCP must be real tool names
const bogus = new Set();
for (const [, v] of TOOL_MCP) for (const n of v.split('/').map((s) => s.trim()).filter(Boolean)) if (!defined.has(n)) bogus.add(n);
report('TOOL_MCP names that are not defined tools', [...bogus].sort());

// 6) every key a real config file carries must have a label, or the page renders the raw English key
const configArgIdx = process.argv.indexOf('--config');
const configPaths = configArgIdx > 0 ? process.argv.slice(configArgIdx + 1) : [path.join(REPO, 'qq-bridge', 'config.json')];
for (const cp of configPaths) {
  if (!fs.existsSync(cp)) { console.log(`[audit] (skipped, not found) ${cp}`); continue; }
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(cp, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { console.log(`[audit] (unreadable) ${cp}: ${e.message}`); continue; }
  const keys = Object.keys(cfg?.social?.tools || {});
  const unlabeled = keys.filter((k) => !TOOL_LABEL.has(k)).sort();
  const unmapped = keys.filter((k) => !TOOL_MCP.has(k)).sort();
  console.log(`[audit] ${path.basename(path.dirname(cp))}/${path.basename(cp)}: ${keys.length} switch keys`);
  report(`config keys with no Chinese label in ${cp}`, unlabeled);
  report(`config keys with no tool-name mapping in ${cp}`, unmapped);
}

console.log('');
if (!problems.length) console.log('[audit] OK  UI tool tables match the bridge');
process.exit(problems.length ? 1 : 0);
