// README 行号引用对齐器。
//
// 起因：README 用「`工具名`（`:行号`）」的方式给出实现位置（62 处 `:NNNN` 引用），而源码一改行号就漂。
// 2026-09-22 这一轮往 mcp-napcat-safe.js 里插了兜底挑图的辅助函数，后面所有工具的行号整体 +29，
// README 里的引用就全错了 —— 手工对一遍很容易漏，所以把这件事做成可重跑的脚本。
//
// 只处理**能唯一定位**的引用：`工具名`（`:NNNN`）→ registerTool 那一行的行号。
// 其它形式的引用（文件内普通函数、其它文件）原样不动，只在报告里列出来，不做猜测性改写。
//
//   node tools/align-readme-lines.mjs          # 只报告差异
//   node tools/align-readme-lines.mjs --write   # 写回 README.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 用 fileURLToPath 而不是手撕 URL.pathname：仓库路径里有空格（"MoonBot Public"），
// pathname 会把空格留成 %20，拼出来的路径直接 ENOENT。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const README = path.join(ROOT, 'README.md');
const MCP = path.join(ROOT, 'qq-bridge', 'src', 'mcp-napcat-safe.js');

const write = process.argv.includes('--write');

const mcpText = fs.readFileSync(MCP, 'utf8');
const mcpLines = mcpText.split(/\r?\n/);

/** 工具名 → registerTool 调用所在行号（1 基）。同名重复注册时取第一处并标记。 */
function toolLineMap() {
  const map = new Map();
  for (let i = 0; i < mcpLines.length; i++) {
    if (!/^\s*registerTool\(/.test(mcpLines[i])) continue;
    const m = /^\s*'([a-zA-Z0-9_]+)'/.exec(mcpLines[i + 1] ?? '');
    if (!m) continue;
    if (map.has(m[1])) map.set(m[1], 'DUP');
    else map.set(m[1], i + 1);
  }
  return map;
}

const toolLines = toolLineMap();
let readme = fs.readFileSync(README, 'utf8');
const mismatches = [];
let fixed = 0;

// `qq_send_meme`（`:2097`） / `qq_send_meme`(`:2097`)
readme = readme.replace(/`([a-zA-Z0-9_]+)`\s*（?`?:(\d{3,5})`/g, (whole, name, num) => {
  const line = toolLines.get(name);
  if (!line || line === 'DUP') return whole;
  if (String(line) === num) return whole;
  mismatches.push({ name, was: Number(num), now: line });
  fixed++;
  return whole.replace(':' + num, ':' + line);
});

console.log(`工具名引用：${mismatches.length} 处需要对齐（README 里共 ${(readme.match(/`:[0-9]{3,5}`/g) || []).length} 处 \`:NNNN\` 引用）`);
for (const m of mismatches) console.log(`  ${m.name}  :${m.was} -> :${m.now}`);
if (!mismatches.length) console.log('  全部已对齐');
if (write && fixed) {
  fs.writeFileSync(README, readme, 'utf8');
  console.log(`已写回 ${README}`);
} else if (mismatches.length) {
  console.log('（加 --write 才会写回）');
}
