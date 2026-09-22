// 「文件类型也要标出来」回归（2026-09-22 主人报：模型把对方发来的文件当成图片）：
//   ① 文件段必须渲染成 `[文件:名字 · 类型 · 大小]`，没有名字时也不能退化成光秃秃的 `[文件]`；
//   ② 类型映射认得常见扩展名（PDF / Word / Excel / 压缩包 / 代码 / 图片文件 …）；
//   ③ 唤醒正文的消息标记 `[file:PDF]` 带上类型（而不是只有一个 `[file]`）；
//   ④ 三个渲染点共用同一份实现（segmentsToText / forward.js / wake-send），不各写一份。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = path.join(process.cwd(), 'src');
let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`); } else { console.log(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
};

const mp = await import(pathToFileURL(path.join(SRC, 'lib', 'message-parse.js')).href);

console.log('== ① 文件段的标记 ==');
ok('PDF + 大小：名字/类型/大小都在', mp.fileMarker('报告.pdf', 1258291) === '[文件:报告.pdf · PDF · 1.2 MB]', mp.fileMarker('报告.pdf', 1258291));
ok('Word', mp.fileMarker('合同.docx', 20480) === '[文件:合同.docx · Word · 20 KB]', mp.fileMarker('合同.docx', 20480));
ok('压缩包', mp.fileMarker('备份.zip', 0) === '[文件:备份.zip · 压缩包]', mp.fileMarker('备份.zip', 0));
ok('代码', mp.fileMarker('server.js', 512) === '[文件:server.js · 代码 · 512 B]', mp.fileMarker('server.js', 512));
ok('图片文件也照样说是"文件"（不是 [图片]）', mp.fileMarker('照片.jpg', 1024).startsWith('[文件:照片.jpg · 图片文件'), mp.fileMarker('照片.jpg', 1024));
ok('没有文件名时写"未命名文件"，绝不留 `[文件]`', mp.fileMarker('', 0) === '[文件:未命名文件 · 未知类型]', mp.fileMarker('', 0));
ok('认不出的扩展名回大写扩展名', mp.fileKindLabel('x.qqq') === 'QQQ', mp.fileKindLabel('x.qqq'));

console.log('== ② extractFilesFromSegments 带上类型 ==');
const files = mp.extractFilesFromSegments([{ type: 'file', data: { name: '报表.xlsx', file: 'fid-1', size: 3072 } }]);
ok('一条文件段被解析出来', files.length === 1, JSON.stringify(files));
ok('ext= xlsx', files[0].ext === 'xlsx', String(files[0].ext));
ok('kind= Excel', files[0].kind === 'Excel', String(files[0].kind));
ok('marker 就是 fileMarker 的产物', files[0].marker === '[文件:报表.xlsx · Excel · 3.0 KB]', files[0].marker);

console.log('== ③ segmentsToText 真的用上了（含无名字的文件） ==');
const txt = await mp.segmentsToText([{ type: 'file', data: { name: '报告.pdf', size: 1258291 } }]);
ok('正文里是带类型的标记', txt === '[文件:报告.pdf · PDF · 1.2 MB]', txt);
const txt2 = await mp.segmentsToText([{ type: 'file', data: {} }]);
ok('无名字文件不出现 [文件] 裸标记', txt2 === '[文件:未命名文件 · 未知类型]', txt2);

console.log('== ④ 唤醒正文的 [file:类型] 标记 ==');
const wake = fs.readFileSync(path.join(SRC, 'core', 'wake-send.js'), 'utf8');
ok('消息标记带类型（fileKindLabel(f0.name) 兜底）', /\[file:\$\{f0\.kind \|\| fileKindLabel\(f0\.name\)\}\]/.test(wake));
ok('只有 hasFile 而没有 files[] 时仍旧给 [file]', /\? ' \[file\]' : ''/.test(wake));
ok('文件与图片互斥：hasMedia 优先且不叠加', /const extra = m\.hasMedia \? ' \[image\]' : fileTag;/.test(wake));

console.log('== ⑤ 三处渲染共用一份实现 ==');
const fwd = fs.readFileSync(path.join(SRC, 'forward.js'), 'utf8');
ok('forward.js 用的是同一个 fileMarker', /case 'file': return fileMarker\(d\.name, d\.size\)/.test(fwd));
ok('forward.js 从 message-parse 引入（不是自己再写一份）', /import \{ fileMarker \} from '\.\/lib\/message-parse\.js'/.test(fwd));
const mcp = fs.readFileSync(path.join(SRC, 'mcp-napcat-safe.js'), 'utf8');
ok('qq_get_file_content 的说明写了"文件不是图片"', /A file is NEVER a picture/.test(mcp));
ok('说明里的标记示例已更新成新形态', /\[文件:报告\.pdf · PDF · 1\.2 MB\]/.test(mcp));

console.log(`\nALL PASS  pass=${pass} fail=${process.exitCode ? 1 : 0}`);
