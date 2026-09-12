// 把工具文案 worklist 切成 N 份（按源码顺序连续切分，保证"一个工具的描述+它的参数"落在同一份里），
// 供并行的改写任务使用。每份自带 tool 归属（从 pos 往前找最近的 registerTool）。
// 用法：node tools/split-tool-text.mjs [N] [worklist.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const N = Math.max(1, Number(process.argv[2]) || 4);
const wlFile = process.argv[3] || path.join(HERE, 'tool-text-worklist.json');
const wl = JSON.parse(fs.readFileSync(wlFile, 'utf8'));
const src = fs.readFileSync(wl.src, 'utf8');

const ownerOf = (pos) => {
  const before = src.slice(0, pos);
  const all = [...before.matchAll(/registerTool\(\s*(['"])([a-z_0-9]+)\1/g)];
  return all.length ? all[all.length - 1][2] : '(module)';
};

const items = wl.items
  .filter((x) => x.raw != null)
  .sort((a, b) => a.pos - b.pos)
  .map((x) => ({ id: x.id, kind: x.kind, param: x.param || null, chars: x.chars, owner: ownerOf(x.pos), raw: x.raw }));

const total = items.reduce((a, x) => a + x.chars, 0);
const target = total / N;
const groups = [];
let cur = [];
let sum = 0;
for (const it of items) {
  cur.push(it);
  sum += it.chars;
  if (sum >= target && groups.length < N - 1) { groups.push({ sum, items: cur }); cur = []; sum = 0; }
}
if (cur.length) groups.push({ sum, items: cur });

for (const [i, g] of groups.entries()) {
  const tools = [...new Set(g.items.map((x) => x.owner))];
  const out = {
    group: i + 1,
    of: groups.length,
    instructions: 'See task prompt. Return ONLY a JSON object mapping id -> new text.',
    tools,
    chars: g.sum,
    items: g.items,
  };
  const f = path.join(HERE, `tooltext-group-${i + 1}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2), 'utf8');
  console.log(`group ${i + 1}: ${g.items.length} 段 / ${g.sum} 字符 / ${tools.length} 个工具 → ${path.basename(f)}`);
}
console.log(`合计 ${items.length} 段 / ${total} 字符`);
