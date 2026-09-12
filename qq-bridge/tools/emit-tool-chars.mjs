// 从 DSH 会话转录里抽出「所有出现过的工具名 → 其 schema 字符数（取最大）」，
// 用于管理端展示每个工具的真实 token 成本。多帧 zstd 逐帧解。
import { readFileSync } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';

const files = process.argv.slice(2);
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
async function inflate(frame) {
  const z = createZstdDecompress();
  const chunks = [];
  z.on('data', (c) => chunks.push(c));
  await new Promise((res, rej) => { z.on('end', res); z.on('error', rej); z.end(frame); });
  return Buffer.concat(chunks).toString('utf8');
}
const chars = new Map();
for (const file of files) {
  const buf = readFileSync(file);
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i);
  }
  starts.push(buf.length);
  let text = '';
  for (let i = 0; i < starts.length - 1; i++) {
    try { text += await inflate(buf.subarray(starts[i], starts[i + 1])); } catch {}
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"tools"')) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    const tools = obj?.data?.header?.tools;
    if (!Array.isArray(tools)) continue;
    for (const t of tools) {
      const n = t?.name; if (!n) continue;
      const c = JSON.stringify(t).length;
      chars.set(n, Math.max(chars.get(n) || 0, c));
    }
  }
}
const rows = [...chars.entries()].sort((a, b) => b[1] - a[1]);
let total = 0; for (const [, c] of rows) total += c;
console.log(`// 共 ${rows.length} 个工具，合计 ${total} 字符`);
console.log('const TOOL_SCHEMA_CHARS: Record<string, number> = {');
for (const [n, c] of rows) console.log(`  '${n}': ${c},`);
console.log('};');
