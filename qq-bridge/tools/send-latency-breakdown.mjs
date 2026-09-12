// 按「本条调用带了几条消息」分组统计 qq_send_message 的耗时，判断延迟到底来自条间节拍还是首条等待。
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const tool = 'mcp__napcat__qq_send_message';
const lines = readFileSync(file, 'utf8').split('\n');
const queues = new Map();
const rows = [];
for (const line of lines) {
  if (!line.trim()) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  const key = o.key || '?';
  if (o.type === 'call') {
    if (!queues.has(key)) queues.set(key, []);
    let n = 0, hasImg = false;
    try {
      const a = JSON.parse(o.args || '{}');
      const msgs = a.messages;
      n = Array.isArray(msgs) ? msgs.length : (typeof msgs === 'string' ? 1 : (a.message ? 1 : 0));
      hasImg = Array.isArray(a.images) && a.images.length > 0;
    } catch {}
    queues.get(key).push({ t: Date.parse(o.time), n, hasImg, tool: o.tool });
  } else if (o.type === 'result') {
    const q = queues.get(key); if (!q || !q.length) continue;
    const c = q.shift();
    if (c.tool !== tool) continue;
    rows.push({ d: Date.parse(o.time) - c.t, n: c.n, hasImg: c.hasImg });
  }
}
const groups = new Map();
for (const r of rows) {
  const k = r.n >= 4 ? '4+' : String(r.n);
  const a = groups.get(k) || [];
  a.push(r.d);
  groups.set(k, a);
}
console.log('本条条数  次数   中位(s)  平均(s)  最大(s)   >1.4s 的占比');
for (const k of ['0', '1', '2', '3', '4+']) {
  const a = groups.get(k); if (!a) continue;
  const s = [...a].sort((x, y) => x - y);
  const med = s[Math.floor(s.length / 2)];
  const avg = s.reduce((x, y) => x + y, 0) / s.length;
  const over = s.filter((x) => x > 1400).length;
  console.log(`${k.padEnd(9)} ${String(s.length).padStart(4)}  ${(med / 1000).toFixed(2).padStart(7)}  ${(avg / 1000).toFixed(2).padStart(7)}  ${(s[s.length - 1] / 1000).toFixed(2).padStart(7)}   ${(over / s.length * 100).toFixed(0)}%`);
}
console.log('\n单条（n=1）耗时的直方图（0.2s 一档，前 20 档）：');
const one = (groups.get('1') || []);
const bins = new Array(20).fill(0);
for (const d of one) { const i = Math.min(19, Math.floor(d / 200)); bins[i] += 1; }
bins.forEach((c, i) => { if (c) console.log(`  ${(i * 0.2).toFixed(1)}-${((i + 1) * 0.2).toFixed(1)}s  ${'#'.repeat(c)} ${c}`); });
