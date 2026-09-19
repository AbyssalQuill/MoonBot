#!/usr/bin/env node
/**
 * 配置项「说明文」覆盖率审计（Node 脚本，不进打包产物）。
 *
 * 起因：主人要求"给每一个配置输入框加上详细说明"。界面每个字段旁边有个 ⓘ 按钮，
 * 点开显示 `HELP[完整路径] ?? HELP[末段名]`；两处都没有时会走 `unnamedHelp()` 自动兜底
 * （只有一句"这是哪个键、当前值是什么、在配置文件的哪一层"的机械说明，不算详细说明）。
 * 这个脚本用**真实文件**列出"会落到自动兜底"的键，作为补说明文的清单依据：
 *   ① qq-bridge/config.example.json  → 出厂全部配置键（含中间分组键）
 *   ② qq-bridge/config.json          → 本机实际在用的键（可能含 example 里没有的）
 *   ③ src/pages/BridgeConfig.tsx     → HELP 表
 * 用法：node tools/audit-config-help.mjs [--list]
 * 退出码：0 = 每个叶子键都有说明；1 = 有缺口（逐条打印）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readIf = (p) => { const f = path.join(ROOT, p); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };

/** 收集一个对象里所有叶子键路径（跳过以 _ 开头的说明键与注释） */
function leafPaths(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (k.startsWith('_')) continue;
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leafPaths(v, p, out);
    else out.push(p);
  }
  return out;
}
/** 收集中间分组键（卡片是按分组渲染的，分组本身也可能出现在界面上） */
function allPaths(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (k.startsWith('_')) continue;
    const p = prefix ? `${prefix}.${k}` : k;
    out.push(p);
    if (v && typeof v === 'object' && !Array.isArray(v)) allPaths(v, p, out);
  }
  return out;
}

/** 从 BridgeConfig.tsx 里取出某张表的键名（不依赖 TS 编译器：按大括号配平找块） */
function tableKeys(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return [];
  const start = src.indexOf('{', at);
  if (start < 0) return [];
  let depth = 0;
  let q = null;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    const prev = src[j - 1];
    if (q) { if (c === q && prev !== '\\') q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) {
      const body = src.slice(start + 1, j);
      const keys = new Set();
      const re = /(?:^|[\s,{])(?:'([^']+)'|"([^"]+)"|([A-Za-z_][\w.]*))\s*:/g;
      let m;
      while ((m = re.exec(body)) !== null) keys.add(m[1] ?? m[2] ?? m[3]);
      return [...keys];
    } }
  }
  return [];
}

const src = readIf('src/pages/BridgeConfig.tsx');
if (!src) { console.error('找不到 src/pages/BridgeConfig.tsx'); process.exit(1); }
const helpKeys = new Set(tableKeys(src, 'const HELP'));
const labelKeys = new Set(tableKeys(src, 'const LABEL'));

const example = readIf('qq-bridge/config.example.json');
const live = readIf('qq-bridge/config.json');
const cfgExample = example ? JSON.parse(example) : {};
const cfgLive = live ? JSON.parse(live) : {};

const want = new Set([...allPaths(cfgExample), ...allPaths(cfgLive)]);
const missing = [];
for (const p of [...want].sort()) {
  const last = p.split('.').pop();
  const hasHelp = helpKeys.has(p) || helpKeys.has(last);
  const hasLabel = labelKeys.has(p) || labelKeys.has(last);
  if (!hasHelp) missing.push({ path: p, last, hasLabel });
}

console.log(`配置键总数 ${want.size}；HELP 表 ${helpKeys.size} 条、LABEL 表 ${labelKeys.size} 条`);
console.log(`缺详细说明的键：${missing.length} 个`);
for (const m of missing) console.log(`  - ${m.path}${m.hasLabel ? '' : '   ⚠️ 连中文标签都没有'}`);
const noLabel = missing.filter((m) => !m.hasLabel);
if (noLabel.length) console.log(`\n其中连中文标签也缺的：${noLabel.length} 个（界面会显示英文键名）`);
process.exit(missing.length ? 1 : 0);
