// 分析 bridge.js：提取顶层符号（const/let/function/class at col0）及行号，
// 并粗算每段之间的调用引用，用于设计模块拆分边界。
import { readFileSync } from 'node:fs';
const f = process.argv[2];
const lines = readFileSync(f, 'utf8').split('\n');
const top = [];
const re = /^((?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?const\s+(\w+)\s*=|(?:export\s+)?let\s+(\w+)\s*=|(?:export\s+)?class\s+(\w+))/;
lines.forEach((l, idx) => {
  const m = l.match(re);
  if (!m) return;
  const name = m[2] || m[3] || m[4] || m[5];
  const kind = l.includes('function') ? 'fn' : l.includes('class') ? 'cls' : 'var';
  top.push({ name, kind, line: idx + 1 });
});
// 每个符号定义到下一个符号之间的正文作为 body
const bodies = top.map((s, i) => ({ ...s, bodyEnd: i + 1 < top.length ? top[i + 1].line - 1 : lines.length }));
// 为每个符号收集它在自己 body 内调用了哪些其它顶层符号
const nameSet = new Set(top.map((t) => t.name));
bodies.forEach((b) => {
  const seg = lines.slice(b.line, b.bodyEnd + 1).join('\n');
  const refs = new Set();
  for (const n of nameSet) {
    if (n === b.name) continue;
    // 用词边界粗匹配（避免命中字符串说明文字过多，仅统计）
    const r = new RegExp(`\\b${n}\\b`, 'g');
    let c = 0; const m2 = seg.match(r); c = m2 ? m2.length : 0;
    if (c > 0) refs.add(n);
  }
  b.refs = [...refs];
});
console.log('符号数:', top.length);
for (const b of bodies) {
  console.log(`${String(b.line).padStart(6)} ${b.kind.padEnd(3)} ${b.name.padEnd(42)} L${String(b.bodyEnd).padStart(6)} refs[${(b.refs || []).join(', ')}]`);
}
