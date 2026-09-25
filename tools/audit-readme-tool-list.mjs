/**
 * Audit the documented MCP tool list against what the bridge actually defines.
 *
 * WHY: the docs enumerate every tool the bridge registers to the agent (98 of them, grouped by
 * purpose). Adding or removing a tool without updating that table silently makes the docs wrong --
 * exactly what the Pixiv tools did once.
 *
 * Two views of the code, because they answer different questions:
 *   · static scan  -- every tool the source defines (registerTool('x') / server.tool('x')).
 *                     This is what the documented table must cover, independent of any config.
 *   · live probe   -- what this machine's qq-bridge config actually registers right now
 *                     (social.slimTools excludes some at registration; start_napcat/stop_napcat are
 *                     only registered in the owner's private chat). Reported for context.
 *
 * Where the list lives: 2026-09-25 起唯一 README 只作索引与实现细节，工具全表在
 * `docs/CAPABILITIES.md` 附录 A（napcat 侧 91 条）与附录 B（宿主侧 5 条）；脚本默认读该文件。
 * 传第二/第三个参数可指向其它文档（例如根 README.md），提取方式相同：文档中所有反引号包裹的
 * 工具名。文档里若存在 `## MCP 工具` 或 `## 附录 A MCP 工具全表` 这样的章节标题，则只在从该标题
 * 到下一个二级标题的范围内提取；没有该标题时退回全文提取。
 *
 * Usage: node tools/audit-readme-tool-list.mjs [bridgeDir] [docPath]
 * Exit code 1 when the static set and the documented list disagree.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BRIDGE = path.resolve(process.argv[2] || path.join(REPO, 'qq-bridge'));
const README = path.resolve(process.argv[3] || path.join(REPO, 'docs', 'CAPABILITIES.md'));
const FILES = ['mcp-napcat-safe.js', 'mcp-host-server.js', 'mcp-web-search-safe.js'];

/** Every tool name the source defines, per file. */
function staticTools(file) {
  const src = fs.readFileSync(path.join(BRIDGE, 'src', file), 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/(?:registerTool|server\.tool)\(\s*['"]([A-Za-z0-9_]+)['"]/g)) names.add(m[1]);
  return names;
}

/** What the MCP server registers with the config that is in place right now. */
function liveTools(file) {
  const probe = path.join(REPO, 'tools', 'probe-mcp-tools.mjs');
  const r = spawnSync(process.execPath, [probe, BRIDGE, file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const names = [];
  let inList = false;
  for (const line of out.split('\n')) {
    if (/^工具名:\s*$/.test(line.trim())) { inList = true; continue; }
    if (/^---/.test(line)) { inList = false; continue; }
    if (inList && /^ {2}\S+$/.test(line)) names.push(line.trim());
  }
  return names;
}

const defined = new Map();
const liveTotal = new Map();
for (const f of FILES) {
  const statics = staticTools(f);
  for (const n of statics) defined.set(n, f);
  const live = liveTools(f);
  liveTotal.set(f, live.length);
  console.log(`[audit] ${f}: ${statics.size} defined in source, ${live.length} registered with the current config`);
}

const md = fs.readFileSync(README, 'utf8');
// 优先在专门的工具表章节内提取；找不到该章节（例如根 README 已不再承载全表）则退回全文提取。
const marker = md.match(/^## (?:MCP 工具|附录 A MCP 工具全表)[^\n]*$/m);
let section = md;
if (marker) {
  const start = marker.index;
  const end = md.indexOf('\n## ', start + 5);
  // 附录 A 的工具表跨到附录 B，故终点取「附录 C 管理端路由表」之前的最后一个二级标题。
  const nextStop = md.indexOf('\n## 附录 C', start + 5);
  section = md.slice(start, nextStop > 0 ? nextStop : (end > 0 ? end : undefined));
}
const fromReadme = new Set();
for (const m of section.matchAll(/`([a-z][a-z0-9_]{2,})`/g)) {
  const name = m[1];
  // 工具名形状：小写字母开头、可含数字与下划线、不以分隔符结尾（排除 `qq_`、`mcp__napcat__` 这类表头片段）。
  if (/_$/.test(name)) continue;
  if (/^(qq_|web_|napcat_|start_|stop_|get_)/.test(name)) fromReadme.add(name);
}

const missing = [...defined.keys()].filter((n) => !fromReadme.has(n)).sort();
const extra = [...fromReadme].filter((n) => !defined.has(n)).sort();

console.log('');
console.log(`[audit] defined in source=${defined.size}  documented in README=${fromReadme.size}`);
if (missing.length) console.log(`[audit] MISSING from README (${missing.length}): ${missing.join(', ')}`);
if (extra.length) console.log(`[audit] IN README but not defined (${extra.length}): ${extra.join(', ')}`);
if (!missing.length && !extra.length) console.log('[audit] OK  README tool list covers every defined tool');
process.exit(missing.length || extra.length ? 1 : 0);

