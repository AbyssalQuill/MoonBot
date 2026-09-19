#!/usr/bin/env node
/* 给"补说明文"用的清单：把缺 HELP 的键分组打印，并带上出厂示例值，便于逐条写说明。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readIf = (p) => { const f = path.join(ROOT, p); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };
const src = readIf('src/pages/BridgeConfig.tsx');
const cfg = JSON.parse(readIf('qq-bridge/config.example.json'));

function tableKeys(marker) {
  const at = src.indexOf(marker); if (at < 0) return new Set();
  const start = src.indexOf('{', at); let depth = 0; let q = null;
  for (let j = start; j < src.length; j++) {
    const c = src[j], prev = src[j - 1];
    if (q) { if (c === q && prev !== '\\') q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) {
      const body = src.slice(start + 1, j); const keys = new Set();
      const re = /(?:^|[\s,{])(?:'([^']+)'|"([^"]+)"|([A-Za-z_][\w.]*))\s*:/g; let m;
      while ((m = re.exec(body)) !== null) keys.add(m[1] ?? m[2] ?? m[3]);
      return keys;
    } }
  }
  return new Set();
}
const HELP = tableKeys('const HELP');
const LABEL = tableKeys('const LABEL');
const TOOL_LABEL = tableKeys('const TOOL_LABEL');
const MCP_LABEL = tableKeys('const MCP_LABEL');
const has = (set, p) => set.has(p) || set.has(p.split('.').pop());

function walk(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (k.startsWith('_')) continue;
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) { out.push({ p, v: '(分组)', group: true }); walk(v, p, out); }
    else out.push({ p, v: Array.isArray(v) ? `[${v.length} 项]` : JSON.stringify(v) });
  }
  return out;
}
const rows = walk(cfg);
const miss = rows.filter((r) => !has(HELP, r.p));
console.log(`HELP 覆盖 ${rows.length - miss.length}/${rows.length}；缺 ${miss.length} 个\n`);
let section = '';
for (const r of miss) {
  const top = r.p.split('.')[0];
  if (top !== section) { section = top; console.log(`\n## ${top}`); }
  const label = has(LABEL, r.p) || has(TOOL_LABEL, r.p) || has(MCP_LABEL, r.p) ? '' : '  ⚠️无中文标签';
  console.log(`- ${r.p} = ${r.v}${r.group ? '（分组键）' : ''}${label}`);
}
