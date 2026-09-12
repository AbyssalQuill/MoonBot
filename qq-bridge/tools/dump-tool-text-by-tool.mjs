// 按"工具归属"（源码里最近的 registerTool）把文案分组导出，便于逐工具改写。
// 用法：node tools/dump-tool-text-by-tool.mjs [topN] [out.txt]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const topN = Number(process.argv[2]) || 10;
const out = process.argv[3] || 'tools/top-tool-text2.txt';

const wl = JSON.parse(fs.readFileSync(path.join(HERE, 'tool-text-worklist.json'), 'utf8'));
const src = fs.readFileSync(wl.src, 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest-napcat-after.json'), 'utf8'));

const ownerOf = (pos) => {
  const before = src.slice(0, pos);
  const all = [...before.matchAll(/registerTool\(\s*(['"])([a-z_0-9]+)\1/g)];
  return all.length ? all[all.length - 1][2] : '(module)';
};

const byTool = new Map();
for (const it of wl.items) {
  if (it.raw == null) continue;
  const o = ownerOf(it.pos);
  if (!byTool.has(o)) byTool.set(o, []);
  byTool.get(o).push({ ...it, owner: o });
}

const rank = manifest.tools.map((t) => ({ n: t.name.replace('mcp__napcat__', ''), c: t.chars })).sort((a, b) => b.c - a.c);
const lines = [];
for (const r of rank.slice(0, topN)) {
  const items = byTool.get(r.n) || [];
  lines.push(`===== ${r.n}  total=${r.c}  parts=${items.length} =====`);
  for (const it of items.sort((a, b) => b.chars - a.chars)) {
    lines.push(`[${it.id}] (${it.chars})`);
    lines.push(it.raw);
    lines.push('');
  }
}
fs.writeFileSync(path.join(HERE, '..', out), lines.join('\n'), 'utf8');
console.log(`wrote ${out} (${lines.length} lines), tools: ${rank.slice(0, topN).map((r) => r.n).join(', ')}`);
