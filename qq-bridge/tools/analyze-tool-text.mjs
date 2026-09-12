// 分析工具清单里"哪部分是文字、哪部分是结构"：文字（工具描述 + 每个参数的 .describe()）是**可以压缩**的，
// 结构（参数名/类型/required/enum）**绝不能动**。用来给"压缩描述但不丢功能"定目标与验收线。
// 用法：node tools/analyze-tool-text.mjs [manifest.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(HERE, 'manifest-napcat.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

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

const collectDescs = (node, acc = []) => {
  if (Array.isArray(node)) { node.forEach((n) => collectDescs(n, acc)); return acc; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'description' && typeof v === 'string') acc.push(v);
      else collectDescs(v, acc);
    }
  }
  return acc;
};

let textChars = 0, structChars = 0, toolDescChars = 0, paramDescChars = 0, nameChars = 0;
const rows = [];
for (const t of data.tools) {
  const paramDescs = collectDescs(t.inputSchema);
  const paramDescLen = paramDescs.join('').length;
  const structLen = JSON.stringify(stripDesc(t.inputSchema)).length;
  const toolDescLen = String(t.description || '').length;
  textChars += toolDescLen + paramDescLen;
  structChars += structLen;
  toolDescChars += toolDescLen;
  paramDescChars += paramDescLen;
  nameChars += t.name.length;
  rows.push({ name: t.name, toolDescLen, paramDescLen, structLen, total: t.chars, descs: paramDescs.length });
}

console.log(`清单: ${file}`);
console.log(`工具数 = ${rows.length}`);
console.log(`工具名   合计 ${nameChars}`);
console.log(`工具级描述        ${toolDescChars}`);
console.log(`参数 .describe()  ${paramDescChars}`);
console.log(`结构(schema去描述) ${structChars}`);
console.log(`文字合计 ${textChars}（占全部 ${Math.round((textChars / (textChars + structChars + nameChars)) * 100)}%）`);
console.log(`=> 理论可压缩上限 = 文字部分的 50~60%\n`);

console.log('排名  文字合计   工具描述  参数描述  参数数  工具');
for (const [i, r] of rows.sort((a, b) => (b.toolDescLen + b.paramDescLen) - (a.toolDescLen + a.paramDescLen)).entries()) {
  console.log(`${String(i + 1).padStart(4)}  ${String(r.toolDescLen + r.paramDescLen).padStart(8)}  ${String(r.toolDescLen).padStart(8)}  ${String(r.paramDescLen).padStart(8)}  ${String(r.descs).padStart(6)}  ${r.name}`);
}
