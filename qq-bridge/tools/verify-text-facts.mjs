// 事实保全检查：把"原文里的硬事实 token"抽出来，逐条确认新文案里还在。
// 这是"压缩描述但不丢功能"的机械防线 —— 数字上限、参数名、配置键、工具名、代码样例、枚举、
// 否定式警告（never/do not）都是模型据此正确调用的东西，掉一个就是真丢功能。
// 用法：node tools/verify-text-facts.mjs tools/tooltext-pass2.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const mapFile = process.argv[2] || 'tools/tooltext-pass2.json';
const map = JSON.parse(fs.readFileSync(path.isAbsolute(mapFile) ? mapFile : path.join(process.cwd(), mapFile), 'utf8'));
const wl = JSON.parse(fs.readFileSync(path.join(HERE, 'tool-text-worklist.json'), 'utf8'));
const byId = new Map(wl.items.map((x) => [x.id, x]));

const TOKEN_RES = [
  [/qq_[a-z_]+/g, 'tool'],                       // 工具名
  [/[A-Za-z_][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+/g, 'config-key'],   // a.b.c 配置键
  [/\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/g, 'camel'],           // camelCase 参数名
  [/\b[a-z]+(?:_[a-z0-9]+)+\b/g, 'snake'],                        // snake_case
  [/\d[\d,_]*(?:\s?(?:ms|s|min|h|chars|items|messages|chars per|%))?/g, 'number'],
  [/\[[^\]\n]{2,40}\]/g, 'literal'],                              // [CQ:at,qq=...] 之类
  [/\b(never|do not|not|only)\b/gi, 'negation'],
];
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'when', 'into', 'your', 'you', 'are', 'its', 'can', 'may', 'same', 'one', 'only', 'not', 'never', 'default']);

const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ');
let problems = 0, checked = 0;
for (const [id, newText] of Object.entries(map)) {
  if (id.startsWith('_')) continue;
  const item = byId.get(id);
  if (!item) { console.log(`??  ${id} 不在 worklist 里`); problems += 1; continue; }
  const old = item.raw;
  const nNew = norm(newText);
  const missing = [];
  for (const [re, kind] of TOKEN_RES) {
    for (const m of old.matchAll(re)) {
      const tok = m[0].trim();
      if (!tok || tok.length < 2) continue;
      if (kind === 'camel' && STOP.has(tok.toLowerCase())) continue;
      if (kind === 'snake' && tok.length < 4) continue;
      if (kind === 'number') {
        // 纯数字要求按数字本身比对（容忍去掉千分位逗号/下划线）
        const digits = tok.replace(/[,_]/g, '');
        const num = (digits.match(/^\d+/) || [''])[0];
        if (!num || num === '0' && tok.length < 2) { /* 保留 0 的检查 */ }
        if (num && !newText.replace(/[,_]/g, '').includes(num)) missing.push(`${kind}:${tok}`);
      } else if (kind === 'negation') {
        if (!/\b(never|do not|not|only)\b/i.test(newText)) missing.push(`${kind}:${tok.toLowerCase()}`);
      } else if (!nNew.includes(norm(tok))) missing.push(`${kind}:${tok}`);
    }
  }
  checked += 1;
  const uniq = [...new Set(missing)];
  const ratio = Math.round((1 - newText.length / old.length) * 100);
  if (uniq.length) {
    problems += 1;
    console.log(`\n[${id}] ${old.length} → ${newText.length} (-${ratio}%)  缺 ${uniq.length} 个事实 token:`);
    console.log('   ' + uniq.slice(0, 20).join(', '));
  } else {
    console.log(`[${id}] ${old.length} → ${newText.length} (-${ratio}%)  事实 token 全保留`);
  }
}
console.log(`\n检查 ${checked} 条，${problems ? problems + ' 条有缺口（需人工确认/修正）' : '全部通过'}`);
process.exit(0);
