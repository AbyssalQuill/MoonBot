// 工具文案提取/回填工具（"压缩描述但不丢功能"的机械部分）。
//
// 为什么要有它：工具描述与参数 .describe() 是**模型唯一看到的说明书**，手改 77 个工具极易漏改或改坏引号。
// 所以流程拆成两半：
//   ① --extract：把源码里每一段文案连**原始转义形态**一起导成 worklist（含 id/工具名/是否参数/字符数）；
//   ② --apply  ：拿一份 {id: 新文案} 的 JSON，按 id 精确回填，并**逐条校验原文案在文件里唯一命中**。
// 结构（工具名/参数名/类型/必填/enum/默认值）一律不碰 —— 那是功能，不是文案。
//
// 用法：
//   node tools/rewrite-tool-text.mjs --extract [src/mcp-napcat-safe.js] [out.json]
//   node tools/rewrite-tool-text.mjs --apply map.json [src/mcp-napcat-safe.js]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const mode = argv[0];
const isApply = mode === '--apply';
const srcFile = isApply ? (argv[2] || 'src/mcp-napcat-safe.js') : (argv[1] || 'src/mcp-napcat-safe.js');
const ioFile = isApply ? argv[1] : (argv[2] || path.join(HERE, 'tool-text-worklist.json'));
const SRC = path.isAbsolute(srcFile) ? srcFile : path.join(ROOT, srcFile);

/** 从 [start] 处扫描一个字符串字面量；返回 { raw, quote, end }（raw 是**含转义的原文**）。 */
function scanLiteral(text, start) {
  const q = text[start];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  let i = start + 1;
  let raw = '';
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { raw += c + (text[i + 1] ?? ''); i += 2; continue; }
    if (c === q) return { raw, quote: q, end: i + 1 };
    if (c === '\n' && q !== '`') return null;         // 单行字面量里不该有裸换行
    raw += c; i += 1;
  }
  return null;
}

const text = fs.readFileSync(SRC, 'utf8');

if (!isApply) {
  const items = [];
  // ① 工具描述：registerTool( <ws> 'name' <ws> , <ws> 'desc' ...
  const regRe = /registerTool\(\s*(['"])([a-z_0-9]+)\1\s*,\s*/g;
  let m;
  while ((m = regRe.exec(text))) {
    const name = m[2];
    const lit = scanLiteral(text, regRe.lastIndex);
    if (!lit) { items.push({ id: '', tool: name, kind: 'tool', raw: null, note: '描述不是字面量（可能是模板/变量）', pos: regRe.lastIndex }); continue; }
    items.push({ id: `${name}#tool`, tool: name, kind: 'tool', raw: lit.raw, chars: lit.raw.length, pos: regRe.lastIndex });
  }
  // ② 参数描述：.describe( <ws> 'text'
  const descRe = /\.describe\(\s*/g;
  while ((m = descRe.exec(text))) {
    const lit = scanLiteral(text, descRe.lastIndex);
    // 排除非工具参数场景（例如 zod 变量定义里的 describe）
    const before = text.slice(Math.max(0, m.index - 400), m.index);
    const owner = [...before.matchAll(/registerTool\(\s*(['"])([a-z_0-9]+)\1/g)].pop();
    const paramName = [...before.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(?:z\.|z$)/g)].pop();
    items.push({
      id: owner ? `${owner[2]}@${paramName ? paramName[1] : '?'}${m.index}` : `(模块级)${m.index}`,
      tool: owner ? owner[2] : null,
      kind: 'param',
      param: paramName ? paramName[1] : null,
      raw: lit ? lit.raw : null,
      chars: lit ? lit.raw.length : 0,
      note: lit ? undefined : '不是字面量',
      pos: descRe.lastIndex,
    });
  }
  const toolDesc = items.filter((x) => x.kind === 'tool');
  const paramDesc = items.filter((x) => x.kind === 'param');
  const out = {
    src: SRC,
    extractedAt: new Date().toISOString(),
    summary: {
      tools: toolDesc.length,
      toolDescChars: toolDesc.reduce((a, x) => a + (x.chars || 0), 0),
      paramDescs: paramDesc.length,
      paramDescChars: paramDesc.reduce((a, x) => a + (x.chars || 0), 0),
      nonLiteral: items.filter((x) => x.raw === null).length,
    },
    items,
  };
  fs.writeFileSync(ioFile, JSON.stringify(out, null, 2), 'utf8');
  console.log(`提取完成：工具描述 ${out.summary.tools} 段 / ${out.summary.toolDescChars} 字符，` +
    `参数描述 ${out.summary.paramDescs} 段 / ${out.summary.paramDescChars} 字符，非字面量 ${out.summary.nonLiteral} 处`);
  console.log(`→ ${ioFile}`);
  for (const x of items.filter((y) => y.raw === null)) console.log(`  [非字面量] ${x.id} ${x.note ?? ''}`);
  process.exit(0);
}

// ── apply ──────────────────────────────────────────────────────────────────
// 按**位置**回填（而不是按文本匹配）：很多参数文案是重复的（如 'Session token (from the wake prompt)'
// 在 48 个工具里一模一样），按文本匹配要么歧义要么误伤。worklist 里每条都带 pos（字面量起始偏移），
// 从后往前替换即可保证前面的偏移不失效。
const map = JSON.parse(fs.readFileSync(mapFile(), 'utf8'));
function mapFile() { return path.isAbsolute(ioFile) ? ioFile : path.join(process.cwd(), ioFile); }

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const wl = JSON.parse(fs.readFileSync(path.join(HERE, 'tool-text-worklist.json'), 'utf8'));
const byId = new Map(wl.items.map((x) => [x.id, x]));

const jobs = [];
let unknown = 0;
const misses = [];
for (const [id, newText] of Object.entries(map)) {
  const item = byId.get(id);
  if (!item || item.raw == null) { unknown++; misses.push(`${id}: worklist 里没有这条（或不是字面量）`); continue; }
  jobs.push({ item, newText });
}
jobs.sort((a, b) => b.item.pos - a.item.pos);   // 从后往前

let next = text;
let applied = 0;
for (const { item, newText } of jobs) {
  const quote = item.quote || "'";
  const start = item.pos;                        // 指向开引号
  const end = start + 1 + item.raw.length + 1;   // 含闭引号
  const at = next.slice(start, end);
  if (at !== quote + item.raw + quote) { misses.push(`${item.id}: 位置 ${start} 处的字面量与 worklist 不符`); continue; }
  next = next.slice(0, start) + quote + (quote === '`' ? newText : esc(newText)) + quote + next.slice(end);
  applied += 1;
}
fs.writeFileSync(SRC, next, 'utf8');
console.log(`回填：成功 ${applied}，未命中 ${misses.length}，未知 ${unknown}`);
for (const s of misses.slice(0, 20)) console.log('  - ' + s);
process.exit(misses.length + unknown === 0 ? 0 : 1);
