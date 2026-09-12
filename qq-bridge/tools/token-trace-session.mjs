// 追查单个"冷会话"：为什么 82 次调用一次缓存都没命中。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 运行时目录从本文件位置推导（tools/ -> qq-bridge/），绝不写死盘符/安装路径。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FILE = path.join(ROOT, 'state', 'token-usage.jsonl');
const TARGET = process.argv[2] || 'session-07a2c8aa';

const rows = fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const mine = rows.filter((r) => String(r.sessionId || '').includes(TARGET));
console.log(`=== ${TARGET}: 共 ${mine.length} 条 ===`);
if (!mine.length) process.exit(0);

const bj = (ms) => new Date(Number(ms) + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
console.log(`时间跨度: ${bj(mine[0].tsMs)} → ${bj(mine[mine.length - 1].tsMs)}（北京）`);
console.log(`平均每次间隔: ${Math.round((Number(mine[mine.length - 1].tsMs) - Number(mine[0].tsMs)) / Math.max(1, mine.length - 1) / 1000)} 秒`);

const anyCache = mine.filter((r) => Number(r.cacheRead) > 0);
console.log(`其中缓存读>0 的: ${anyCache.length} 条`);

console.log('\n=== 全部字段（第 1 条）===');
console.log(JSON.stringify(mine[0], null, 1));

console.log('\n=== 前 6 条 / 后 6 条（prompt=新鲜输入, cacheRead=缓存命中, total=合计）===');
const show = [...mine.slice(0, 6), null, ...mine.slice(-6)];
for (const r of show) {
  if (!r) { console.log('  …'); continue; }
  console.log(`  ${bj(r.tsMs)}  prompt=${String(r.prompt).padStart(6)}  cacheRead=${String(r.cacheRead).padStart(6)}  total=${String(r.total).padStart(7)}  completion=${String(r.completion).padStart(4)}`);
}

// 关键判据：如果 prompt 每次都接近 total → 整包未命中；如果 prompt 很小而 total 很大 → 是缓存读
const avgPrompt = Math.round(mine.reduce((a, r) => a + Number(r.prompt || 0), 0) / mine.length);
const avgTotal = Math.round(mine.reduce((a, r) => a + Number(r.total || 0), 0) / mine.length);
console.log(`\n平均 prompt(新鲜)=${avgPrompt}  平均 total=${avgTotal}  → ${avgTotal ? Math.round((avgPrompt / avgTotal) * 100) : 0}% 是全价新输入`);
