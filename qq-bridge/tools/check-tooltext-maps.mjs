// 校验子任务产出的改写映射：key 齐全、单行、无撇号/双引号、不超长；并汇总体积变化。
// 用法：node tools/check-tooltext-maps.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const wl = JSON.parse(fs.readFileSync(path.join(HERE, 'tool-text-worklist.json'), 'utf8'));
const byId = new Map(wl.items.map((x) => [x.id, x]));

let totalIn = 0, totalOut = 0, n = 0;
const problems = [];
for (let g = 1; g <= 4; g++) {
  const f = path.join(HERE, `tooltext-group-${g}.out.json`);
  if (!fs.existsSync(f)) { problems.push(`group${g}: 文件不存在`); continue; }
  let map;
  try { map = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { problems.push(`group${g}: JSON 解析失败 ${e.message}`); continue; }
  const groupFile = path.join(HERE, `tooltext-group-${g}.json`);
  const group = JSON.parse(fs.readFileSync(groupFile, 'utf8'));
  const want = new Set(group.items.map((x) => x.id));
  const got = new Set(Object.keys(map));
  const missing = [...want].filter((id) => !got.has(id));
  const extra = [...got].filter((id) => !want.has(id));
  if (missing.length) problems.push(`group${g}: 缺 ${missing.length} 条（例：${missing.slice(0, 3).join(', ')}）`);
  if (extra.length) problems.push(`group${g}: 多 ${extra.length} 条（例：${extra.slice(0, 3).join(', ')}）`);

  let gi = 0, go = 0, grew = 0;
  for (const it of group.items) {
    const v = map[it.id];
    if (typeof v !== 'string') { problems.push(`group${g}: ${it.id} 值不是字符串`); continue; }
    gi += it.chars; go += v.length;
    if (v.length > it.chars) grew += 1;
    if (v.includes('\n')) problems.push(`group${g}: ${it.id} 含换行`);
    if (v.includes("'")) problems.push(`group${g}: ${it.id} 含撇号`);
    if (v.includes('"')) problems.push(`group${g}: ${it.id} 含双引号`);
    if (v !== v.trim()) problems.push(`group${g}: ${it.id} 首尾有空白`);
  }
  totalIn += gi; totalOut += go; n += group.items.length;
  console.log(`group${g}: ${group.items.length} 条  ${gi} → ${go} 字符（省 ${gi - go}，${Math.round(((gi - go) / gi) * 100)}%）  变长者 ${grew}`);
}
console.log(`\n合计 ${n} 条：${totalIn} → ${totalOut} 字符（省 ${totalIn - totalOut}，${Math.round(((totalIn - totalOut) / totalIn) * 100)}%）`);
console.log(problems.length ? `\n问题 ${problems.length} 项：\n  - ` + problems.slice(0, 25).join('\n  - ') : '\n无格式问题');
