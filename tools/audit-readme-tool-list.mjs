/**
 * Audit the README's MCP tool list against what the bridge actually defines.
 *
 * WHY: the README documents every tool the bridge registers to the agent (96 of them, grouped by
 * purpose). Adding or removing a tool without updating that table silently makes the docs wrong --
 * exactly what the Pixiv tools did once.
 *
 * Two views of the code, because they answer different questions:
 *   · static scan  -- every tool the source defines (registerTool('x') / server.tool('x')).
 *                     This is what the README's table must cover, independent of any config.
 *   · live probe   -- what this machine's qq-bridge config actually registers right now
 *                     (social.slimTools excludes some at registration; start_napcat/stop_napcat are
 *                     only registered in the owner's private chat). Reported for context.
 *
 * Usage: node tools/audit-readme-tool-list.mjs [bridgeDir] [readmePath]
 * Exit code 1 when the static set and the README disagree.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BRIDGE = path.resolve(process.argv[2] || path.join(REPO, 'qq-bridge'));
const README = path.resolve(process.argv[3] || path.join(REPO, 'README.md'));
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
const start = md.indexOf('## MCP 工具');
const end = md.indexOf('\n## ', start + 5);
const section = md.slice(start, end > 0 ? end : undefined);
const fromReadme = new Set();
for (const m of section.matchAll(/`([a-z][a-z0-9_]{2,})`/g)) {
  const name = m[1];
  if (/^(qq_|web_|napcat_|start_|stop_)/.test(name)) fromReadme.add(name);
}

const missing = [...defined.keys()].filter((n) => !fromReadme.has(n)).sort();
const extra = [...fromReadme].filter((n) => !defined.has(n)).sort();

console.log('');
console.log(`[audit] defined in source=${defined.size}  documented in README=${fromReadme.size}`);
if (missing.length) console.log(`[audit] MISSING from README (${missing.length}): ${missing.join(', ')}`);
if (extra.length) console.log(`[audit] IN README but not defined (${extra.length}): ${extra.join(', ')}`);
if (!missing.length && !extra.length) console.log('[audit] OK  README tool list covers every defined tool');
process.exit(missing.length || extra.length ? 1 : 0);

