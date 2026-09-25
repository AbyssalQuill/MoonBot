// 「qq_send_meme 没给 file 也能发」回归（2026-09-22 线上看到 `-32602: missing required tool_input fields: file`）：
//   ① schema 里 file 不再是必填，多了 fileName 别名与 query/tag 兜底；
//   ② 没有 file 但有 query/tag 时，桥自己按 qq_meme_search 同一套 SQL 挑第一张，并把挑中的名字回报模型；
//   ③ 既没有 file 也没有 query 时给的是"两条路怎么走"的提示，而不是参数校验层的 -32602；
//   ④ 兜底搜索只读打开各 pack 的 index.db，坏包跳过（一个包读不出来不该让发图整个失败）。
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'src');
let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`); } else { console.log(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
};

const mcp = fs.readFileSync(path.join(SRC, 'mcp-napcat-safe.js'), 'utf8');
// 只截 qq_send_meme 这一段（从工具名开始，够长覆盖 handler 的两条返回路径），避免匹配到别的工具。
const at = mcp.indexOf("'qq_send_meme'");
const send = mcp.slice(at, at + 20000);

console.log('== ① schema：file 可选 + query 兜底 ==');
ok('file 变成 optional', /file: z\.string\(\)\.optional\(\)\.describe\('Meme file name from qq_meme_search/.test(send));
ok('没有"必填 file"的旧声明', !/file: z\.string\(\)\.describe\('Meme file name from qq_meme_search/.test(send));
ok('多了 fileName 别名', /fileName: z\.string\(\)\.optional\(\)\.describe\('Alias of file/.test(send));
ok('多了 query（没 file 时用）', /query: z\.string\(\)\.optional\(\)\.describe\('Used when file is omitted/.test(send));
ok('多了 tag（收窄分类）', /tag: z\.string\(\)\.optional\(\)\.describe\('Optional category filter for query/.test(send));
ok('工具说明写清了没文件名时改传 query', /If you do not have a file name yet, pass query/.test(send));
ok('handler 解构里收下了 fileName / query / tag', /async \(\{ key, token, file, fileName, query, tag, pack, replyToMessageId, crossSession \}\)/.test(send));
ok('fileName 与 file 等价（file ?? fileName）', /let wantFile = String\(file \?\? fileName \?\? ''\)\.trim\(\);/.test(send));

console.log('== ② 兜底挑图 ==');
ok('定义了 firstMemeByQuery', /async function firstMemeByQuery\(packs, query, tag, onlyPack\)/.test(mcp));
ok('用的是 qq_meme_search 同一套 SQL', /AND \(caption LIKE \? OR keywords LIKE \?\)/.test(mcp) && /sql \+= ' LIMIT 1'/.test(mcp));
ok('只读打开 index.db', /new DatabaseSync\(path\.join\(p\.dir, 'index\.db'\), \{ readOnly: true \}\)/.test(mcp));
ok('坏包跳过（continue 而不是抛）', /catch \{ continue; \}\s*\n\s*try \{\s*\n\s*let sql/.test(mcp));
ok('没有 file 时才会兜底挑图', /if \(!wantFile\) \{\s*\n\s*pickedByQuery = await firstMemeByQuery\(packs, query, tag, wantPack \|\| ''\);/.test(send));
ok('挑中的 pack 会回填 wantPack', /wantFile = pickedByQuery\.file;\s*\n\s*if \(!wantPack\) wantPack = pickedByQuery\.packId;/.test(send));
ok('回报里带 pickedByQuery + 命中的说明', /pickedByQuery: true, matched: pickedByQuery\.caption \|\| pickedByQuery\.tag/.test(send));
ok('两处成功回报都带上了（直连 OneBot 与带引用两条路）', (send.match(/pickedByQuery: true, matched: pickedByQuery\.caption \|\| pickedByQuery\.tag/g) || []).length === 2);

console.log('== ③ 两条路都给不出来的提示 ==');
ok('没搜到时提示换说法 + 先搜索', /没搜到匹配的表情，换个说法/.test(send));
ok('file 与 query 都没给时说明两条路', /file 传 qq_meme_search 结果里的文件名/.test(send) && /或者改成传 query（情绪\/内容描述，如 生气）让我挑一张/.test(send));

console.log('== ④ 旧行为不动 ==');
ok('"<packId>/<文件名>" 写法仍然支持', /if \(!wantPack && slashAt > 0\) \{/.test(send));
ok('找不到文件名时的旧提示保留', /请先用 qq_meme_search 搜索/.test(send));

console.log(`\nALL PASS  pass=${pass} fail=${process.exitCode ? 1 : 0}`);
