// 打印某个会话里指定工具的「调用 → 结果」，看它到底报什么错。
import fs from 'node:fs';
import zlib from 'node:zlib';

const FILE = process.argv[2];
const TOOL = process.argv[3] || 'qq_wait_for_messages';
if (!FILE) { console.log('用法: node dump-tool-results.mjs <session.jsonl.zstd> [toolName]'); process.exit(1); }

const buf = fs.readFileSync(FILE);
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const idx = [];
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) idx.push(i);
}
const parts = [];
for (let k = 0; k < idx.length; k++) {
  try { parts.push(zlib.zstdDecompressSync(buf.subarray(idx[k], k + 1 < idx.length ? idx[k + 1] : buf.length)).toString('utf8')); } catch {}
}
const events = parts.join('').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const T = (e) => e.type || e.event?.type;
const bj = (ms) => (Number(ms) > 0 ? new Date(Number(ms) + 8 * 3600e3).toISOString().slice(11, 19) : '-');

// tool/call 与 tool/result 按 callId 配对
const calls = [];
for (const e of events) {
  const t = T(e);
  const d = e.data ?? e.event?.data ?? {};
  if (t === 'tool/call') {
    const name = String(d.name ?? '');
    if (name.includes(TOOL)) calls.push({ callId: String(d.callId ?? ''), name, time: e.time ?? e.event?.time ?? 0, args: d.arguments ?? d.input ?? d });
  }
}
console.log(`=== ${TOOL} 调用 ${calls.length} 次 ===`);
for (const c of calls) {
  const res = events.find((e) => {
    if (T(e) !== 'tool/result') return false;
    const dd = e.data ?? e.event?.data ?? {};
    return String(dd.callId ?? '') === c.callId;
  });
  const rd = res ? (res.data ?? res.event?.data ?? {}) : null;
  const txt = rd ? JSON.stringify(rd.content ?? rd.result ?? rd.value ?? rd).replace(/\\n/g, ' ').slice(0, 400) : '(没找到结果)';
  console.log(`\n--- ${bj(c.time)}  ${c.name}`);
  console.log(`    参数: ${JSON.stringify(c.args).slice(0, 160)}`);
  console.log(`    结果: ${txt}`);
}
