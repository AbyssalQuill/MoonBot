// 验收：压缩工具文案**不得损失功能**。
// 判据（任一不满足即 FAIL 退出码 1）：
//   ① 工具集合完全一致（没有多、没有少）；
//   ② 去掉 description 之后的 inputSchema **逐字节相同**（参数名/类型/必填/enum/默认值都不许动）——
//      这是"功能不损失"的硬证据，比人眼扫一遍可靠；
//   ③ 每个工具都必须还有描述（非空），且没有哪个工具的文字变长了（>5% 视为改坏）。
// 另外打印总体与单工具的体积变化，供报告引用。
//
// 用法：node tools/verify-tool-compress.mjs tools/manifest-napcat-before.json tools/manifest-napcat-after.json
import fs from 'node:fs';
import path from 'node:path';

const [beforeFile, afterFile] = process.argv.slice(2);
if (!beforeFile || !afterFile) { console.error('用法: node tools/verify-tool-compress.mjs <before.json> <after.json>'); process.exit(2); }

const load = (f) => {
  const j = JSON.parse(fs.readFileSync(path.isAbsolute(f) ? f : path.join(process.cwd(), f), 'utf8'));
  return new Map(j.tools.map((t) => [t.name, t]));
};

const stripDesc = (node) => {
  if (Array.isArray(node)) return node.map(stripDesc);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'description' && typeof v === 'string') continue;
      out[k] = stripDesc(v);
    }
    return out;
  }
  return node;
};

const before = load(beforeFile);
const after = load(afterFile);
let fail = 0;
const failMsg = (s) => { fail += 1; console.log('FAIL  ' + s); };
const okMsg = (s) => console.log('PASS  ' + s);

// ① 工具集合
const added = [...after.keys()].filter((n) => !before.has(n));
const removed = [...before.keys()].filter((n) => !after.has(n));
if (added.length || removed.length) failMsg(`工具集合变了：新增 ${added.join(',') || '-'}；缺失 ${removed.join(',') || '-'}`);
else okMsg(`工具集合一致（${after.size} 个）`);

// ② 结构（去描述）逐字节相同
const structBad = [];
for (const [name, b] of before) {
  const a = after.get(name);
  if (!a) continue;
  const sb = JSON.stringify(stripDesc(b.inputSchema));
  const sa = JSON.stringify(stripDesc(a.inputSchema));
  if (sb !== sa) structBad.push(name);
}
if (structBad.length) failMsg(`参数结构被改动（功能可能受损）：${structBad.join(', ')}`);
else okMsg('参数结构（名称/类型/必填/enum/默认值）逐字节一致');

// ③ 描述非空 + 不膨胀
const grew = [];
for (const [name, a] of after) {
  const b = before.get(name);
  if (!b) continue;
  if (!String(a.description || '').trim()) failMsg(`${name} 描述变空了`);
  if (a.chars > b.chars * 1.05) grew.push(`${name} ${b.chars}→${a.chars}`);
}
if (grew.length) failMsg(`有工具文字变长：${grew.join('; ')}`);
else okMsg('没有任何工具的文字变长');

// 体积统计
const sum = (m) => [...m.values()].reduce((a, t) => a + t.chars, 0);
const descSum = (m) => [...m.values()].reduce((a, t) => a + String(t.description || '').length, 0);
const schemaSum = (m) => [...m.values()].reduce((a, t) => a + JSON.stringify(t.inputSchema || {}).length, 0);
const tb = sum(before), ta = sum(after);
console.log('');
console.log(`合计：${tb} → ${ta} 字符（省 ${tb - ta}，${Math.round(((tb - ta) / tb) * 100)}%）`);
console.log(`  工具级描述：${descSum(before)} → ${descSum(after)}`);
console.log(`  参数 schema（含 describe）：${schemaSum(before)} → ${schemaSum(after)}`);
console.log('');
const deltas = [...after.values()].map((a) => {
  const b = before.get(a.name);
  return { name: a.name, d: (b ? b.chars : 0) - a.chars, from: b ? b.chars : 0, to: a.chars };
}).sort((x, y) => y.d - x.d);
console.log('省得最多的一批：');
for (const r of deltas.slice(0, 18)) console.log(`  -${String(r.d).padStart(5)}  ${r.from} → ${r.to}  ${r.name}`);

console.log(fail ? `\n${fail} 项 FAIL` : '\nALL PASS（功能结构零改动）');
process.exit(fail ? 1 : 0);
