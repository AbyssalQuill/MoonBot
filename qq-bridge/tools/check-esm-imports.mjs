/* ESM 导入/导出一致性自检（**静态分析，绝不 import**）。
 *
 * 为什么不用真的 import：src/bridge.js 顶层就 `main()` 起服务（实测在开发机上 import 一次就把桥跑起来了、
 * 还改了本机 state），所以这里只做静态检查 —— 用 TypeScript 编译器解析每个模块，
 * 把"具名导入"与"目标模块导出的名字"对一遍。这正好补上 `node --check` 查不出的那一类错：
 * 2026-09-19 一次编辑吃掉了 `export function buildWakePrompt` 的 `export`，语法检查照样过、沙盒单测也过
 * （没用到那个导出），但 mux.js 一 import 就 `does not provide an export named …`，**桥起不来**。
 *
 * 用法：node tools/check-esm-imports.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.js$/.test(e.name)) files.push(p);
  }
})(SRC);

/** 一个模块导出的具名集合（含 export { a as b } 与 export * from） */
function exportsOf(file) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const named = new Set();
  let starFrom = [];
  for (const st of sf.statements) {
    const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined;
    const isExport = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (isExport) {
      const d = st.declaration ?? st;
      if (d?.name?.text) named.add(d.name.text);                                  // export function/const/class
      for (const el of d?.declarationList?.declarations ?? []) {
        if (el.name?.text) named.add(el.name.text);                               // export const a = …, b = …
      }
      if (!st.declaration && Array.isArray(st.exportClause?.elements)) {          // export { a, b as c }
        for (const el of st.exportClause.elements) named.add(el.name.text);
      }
    }
    if (ts.isExportDeclaration(st) && !st.exportClause && st.moduleSpecifier) starFrom.push(st.moduleSpecifier.text);
  }
  return { named, starFrom, sf };
}

const cache = new Map();
const getExports = (f) => { if (!cache.has(f)) cache.set(f, exportsOf(f)); return cache.get(f); };

let bad = 0;
for (const f of files) {
  const { sf } = exportsOf(f);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const spec = st.moduleSpecifier?.text ?? '';
    if (!spec.startsWith('.')) continue;                    // 只看项目内部模块
    const target = path.resolve(path.dirname(f), spec.endsWith('.js') ? spec : spec + '.js');
    let ex;
    try { ex = getExports(target); } catch { continue; }    // 目标不存在交给 Node 自己报
    const nb = st.importClause.namedBindings;
    if (!nb || !ts.isNamedImports(nb)) continue;
    for (const el of nb.elements) {
      const want = el.propertyName?.text ?? el.name.text;
      if (ex.named.has(want)) continue;
      bad += 1;
      console.log(`FAIL  ${path.relative(SRC, f)} 从 ${spec} 导入「${want}」，但那边没有导出这个名字`);
    }
  }
}
console.log(bad === 0
  ? `\nESM 导入/导出自检通过：${files.length} 个模块的具名导入全部对得上`
  : `\n${bad} 处导入对不上 —— 部署前必须修（桥会起不来）`);
process.exit(bad ? 1 : 0);
