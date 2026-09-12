// 正确口径：tool-calls.jsonl 里部分 result 行没有 tool 字段，所以**按 key 做 FIFO 配对**
//（同一会话的工具调用是串行的），配对后再用 call 行里的 tool 归属。
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const filterTool = process.argv[3] || null;
const lines = readFileSync(file, 'utf8').split('\n');
const queues = new Map();   // key -> [{t, tool, args}]
const durations = new Map(); // tool -> number[]
let orphanResults = 0, unmatchedCalls = 0, emptyToolResults = 0;

for (const line of lines) {
  if (!line.trim()) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  const key = o.key || '?';
  if (o.type === 'call') {
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push({ t: Date.parse(o.time), tool: o.tool, args: o.args });
  } else if (o.type === 'result') {
    if (!o.tool) emptyToolResults += 1;
    const q = queues.get(key);
    if (!q || !q.length) { orphanResults += 1; continue; }
    const c = q.shift();
    const d = Date.parse(o.time) - c.t;
    if (!Number.isFinite(d) || d < 0) continue;
    const arr = durations.get(c.tool) || [];
    arr.push(d);
    durations.set(c.tool, arr);
  }
}
for (const q of queues.values()) unmatchedCalls += q.length;

const pct = (s, p) => s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)))];
let rows = [...durations.entries()].map(([tool, arr]) => {
  const s = [...arr].sort((a, b) => a - b);
  return {
    tool, n: s.length, avg: s.reduce((x, y) => x + y, 0) / s.length,
    p50: pct(s, 0.5), p90: pct(s, 0.9), p99: pct(s, 0.99), max: s[s.length - 1],
    over1s: s.filter((x) => x > 1000).length, over5s: s.filter((x) => x > 5000).length,
  };
}).sort((a, b) => b.n - a.n);
if (filterTool) rows = rows.filter((r) => r.tool === filterTool);
console.log(`（result 无 tool 字段 ${emptyToolResults} 条；孤儿 result ${orphanResults}；未配对 call ${unmatchedCalls}）`);
console.log('tool                                     n    avg    p50    p90    p99    max   >1s  >5s');
for (const r of rows) {
  console.log(`${r.tool.padEnd(40)} ${String(r.n).padStart(4)} ${(r.avg / 1000).toFixed(2).padStart(6)} ${(r.p50 / 1000).toFixed(2).padStart(6)} ${(r.p90 / 1000).toFixed(2).padStart(6)} ${(r.p99 / 1000).toFixed(2).padStart(6)} ${(r.max / 1000).toFixed(2).padStart(7)} ${String(r.over1s).padStart(5)} ${String(r.over5s).padStart(5)}`);
}
