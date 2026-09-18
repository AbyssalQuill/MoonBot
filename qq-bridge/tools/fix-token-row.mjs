/* 清掉那条凭空的"对账补记"行，并重新算出当日口径。
 *
 * 依据（离线对账得出）：2026-09-18 当日 295 行里，唯一对不上 DSH 任何 step 的就是
 *   session-724f5d85 / tsMs=2026-09-18 13:35:13 / prompt=476,993 / cacheRead=0 / reconciled=true
 * 桥侧当日至 19:16:32 = 22,039,411，减去这 476,993 = 21,562,418 = DSH 逐 step = 提供方控制台(21,563,440，差 1022)
 *
 * ⚠️ 这是**改数据**，所以：先备份、只删完全匹配的那一行、删完复核。
 * 用法：node /root/napfix-tools/fix-token-row.mjs            （预演，只报告不写）
 *       node /root/napfix-tools/fix-token-row.mjs --apply    （真删，先自动备份）
 */
import fs from 'node:fs';

const FILE = '/root/qq-bridge/state/token-usage.jsonl';
const APPLY = process.argv.includes('--apply');
const SID = 'session-724f5d85';
const WANT_PROMPT = 476993;

const raw = fs.readFileSync(FILE, 'utf8');
const lines = raw.split('\n').filter((l) => l.trim());
console.log(`原文件 ${lines.length} 行，${(raw.length / 1024).toFixed(0)} KB`);

const hit = [];
const keep = [];
for (const l of lines) {
  let o = null;
  try { o = JSON.parse(l); } catch { keep.push(l); continue; }
  const isTarget = String(o?.sessionId || '').startsWith(SID)
    && Number(o?.prompt) === WANT_PROMPT
    && Number(o?.completion) === 0
    && Number(o?.cacheRead) === 0
    && o?.reconciled === true;
  if (isTarget) hit.push({ line: l, ts: o.tsMs });
  else keep.push(l);
}

console.log(`匹配到目标行 ${hit.length} 条：`);
for (const h of hit) console.log(`   ts=${new Date(h.ts).toISOString()}  ${h.line.slice(0, 120)}`);

if (hit.length !== 1) {
  console.log('⚠️ 期望恰好 1 条；数量不符就**不动手**，请人工确认。');
  process.exit(hit.length === 0 ? 0 : 2);
}

// 删前/删后的当日合计对照（北京 08:00 换日）
const dayKey = (ms) => {
  const bj = new Date(ms + 8 * 3600 * 1000);
  const shifted = new Date(bj.getTime() - 8 * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
};
const sumDay = (arr, day) => {
  let s = 0;
  for (const l of arr) {
    let o = null; try { o = JSON.parse(l); } catch { continue; }
    if (!o?.tsMs) continue;
    if (dayKey(Number(o.tsMs)) !== day) continue;
    s += Number(o.prompt || 0) + Number(o.completion || 0) + Number(o.cacheRead || 0) + Number(o.cacheWrite || 0);
  }
  return s;
};
const today = dayKey(Date.now());
console.log(`\n当日在文件里的口径（${today}，北京 08:00 换日）：`);
console.log(`   删前 = ${sumDay(lines, today).toLocaleString()}`);
console.log(`   删后 = ${sumDay(keep, today).toLocaleString()}`);
console.log(`   期望 = 21,562,418（= DSH 逐 step；提供方控制台 21,563,440，差 1022 属结算延迟）`);

if (!APPLY) { console.log('\n（预演模式：没有写文件。加 --apply 才真删）'); process.exit(0); }

const bak = `${FILE}.bak-tokenrow-${Date.now()}`;
fs.copyFileSync(FILE, bak);
fs.writeFileSync(FILE, keep.join('\n') + '\n', 'utf8');
console.log(`\n已备份到 ${bak}`);
console.log(`已写回 ${keep.length} 行（删了 ${hit.length} 行）`);
