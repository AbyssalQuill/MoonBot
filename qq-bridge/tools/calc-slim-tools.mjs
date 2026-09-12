// 计算"MCP schema 里有、但既没被 prompt 教过、也没在日志里被用过"的工具 → 精简候选
import { readFileSync } from 'node:fs';

const schemaFile = process.argv[2];   // tools list dump 输出文件（每行 "  chars name"）
const usedFile = process.argv[3];     // tool-calls.jsonl
const promptFiles = process.argv.slice(4);

const schema = new Map();
for (const line of readFileSync(schemaFile, 'utf8').split('\n')) {
  const m = line.trim().match(/^(\d+)\s+(\S+)$/);
  if (m) schema.set(m[2], Number(m[1]));
}

const used = new Map();
for (const line of readFileSync(usedFile, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try { const o = JSON.parse(line); const t = o.tool; if (t) used.set(t, (used.get(t) || 0) + 1); } catch {}
}

let promptText = '';
for (const f of promptFiles) { try { promptText += readFileSync(f, 'utf8'); } catch {} }

const taught = new Set();
for (const m of promptText.matchAll(/qq_[a-z0-9_]+/g)) taught.add(m[0]);

const rows = [...schema.entries()].map(([name, chars]) => ({
  name, chars,
  used: used.get(name) || 0,
  taught: taught.has(name.replace(/^mcp__[a-z-]+__/, '')),
}));
rows.sort((a, b) => b.chars - a.chars);

let dropTotal = 0;
const drop = [];
for (const r of rows) {
  if (r.used > 0 || r.taught) continue;
  drop.push(r);
  dropTotal += r.chars;
}
let schemaTotal = 0; for (const c of schema.values()) schemaTotal += c;
let usedTotal = 0, taughtTotal = 0;
for (const r of rows) if (r.used > 0) usedTotal += r.chars;
for (const r of rows) if (r.taught) taughtTotal += r.chars;

console.log(`schema tools=${rows.length} chars=${schemaTotal}`);
console.log(`droppable(never used AND never taught)=${drop.length} chars=${dropTotal} (${(dropTotal / schemaTotal * 100).toFixed(1)}%)`);
for (const r of drop) console.log(String(r.chars).padStart(6), r.name);
console.log('---- KEEP LIST (used or taught) ----');
const keep = rows.filter((r) => r.used > 0 || r.taught).map((r) => r.name);
console.log(JSON.stringify(keep, null, 0));
