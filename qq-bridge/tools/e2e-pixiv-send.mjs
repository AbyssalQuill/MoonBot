/* 端到端验证 qq_send_pixiv 按号取图：像 DSH 那样用 MCP 协议起一个全新的 mcp-napcat-safe 子进程，
 * 真调工具（走的是真代码，不是复刻），最后一步把图真发进 owner 的 QQ 私聊。
 *
 * 注意：会真的发图（默认 3 张 + 若干"应被拒绝"的调用不发图）。只在需要现场取证时手动跑。
 * 注意：必须带 5 个通过项才算数：这次修的就是"下载 0 个地址"，而"图到底有没有进 QQ"只有真发才知道
 *    （本项目历史上多次栽在"自检绿了、实发没解决"）。
 *
 * 用法（在桥的机器上）：node qq-bridge/tools/e2e-pixiv-send.mjs
 * 依赖：桥的 config.json 里 social.tools.sendMessage 开着；agentToken 实测就是会话 QQ 号。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const OWNER = process.env.E2E_OWNER_QQ || '1736784911';   // 收图的那个会话（默认 owner 私聊）
const KEY = `private:${OWNER}`;
const TOKEN = OWNER;

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${extra ? '\n     ' + extra : ''}`); }
};
/** 桥的发送回执：老版本给的是条数（number），别按数组写断言。 */
const sentCount = (v) => (typeof v === 'number' ? v : Array.isArray(v) ? v.length : (v ? 1 : 0));

const entry = fileURLToPath(new URL('../src/mcp-napcat-safe.js', import.meta.url));
const client = new Client({ name: 'pixiv-e2e', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry] }));
const call = async (args, timeout = 180000) => {
  const r = await client.callTool({ name: 'qq_send_pixiv', arguments: args }, undefined, { timeout });
  return { isError: Boolean(r.isError), text: String(r.content?.[0]?.text ?? '') };
};
const show = (t, n = 700) => (t.length > n ? t.slice(0, n) + ' …' : t);

console.log('=== 0. MCP 加载的是新代码吗 ===');
const tool = (await client.listTools()).tools.find((t) => t.name === 'qq_send_pixiv');
ok('qq_send_pixiv 存在', Boolean(tool));
ok('描述里有 authorId（新参数）', /authorId/.test(tool?.description ?? ''));
ok('描述里有"原图无损"说明', /原图无损/.test(tool?.description ?? ''));
const schema = JSON.stringify(tool?.inputSchema ?? {});
ok('inputSchema 里有 authorId / illustId / size', /authorId/.test(schema) && /illustId/.test(schema) && /size/.test(schema));

console.log('\n=== 1. 主人报的那次调用：illustId + original（原来返回"试了 0 个地址"）===');
const r1 = await call({ key: KEY, token: TOKEN, illustId: '80643572', size: 'original' });
console.log(show(r1.text));
const j1 = (() => { try { return JSON.parse(r1.text); } catch { return null; } })();
ok('不再报错', !r1.isError);
ok('id = 80643572，46 页', j1?.id === '80643572' && j1?.pageCount === 46);
ok('size=original 且 lossless=true', j1?.size === 'original' && j1?.lossless === true);
ok('字节 = 源文件 1,886,996B', j1?.bytes === 1886996, `bytes=${j1?.bytes}`);
ok('sha256 = 536c4aeb…（与直联/代理实测一致）', String(j1?.sha256 ?? '').startsWith('536c4aebbabc'), String(j1?.sha256));
ok('回执说发出去了', sentCount(j1?.sent) >= 1, JSON.stringify(j1?.sent));
ok('结果里带 authorId（可接着按画师发）', j1?.authorId === '52021072', `authorId=${j1?.authorId}`);

console.log('\n=== 2. 新能力：按画师号发最新作品（这条同时验证 png 原图无损）===');
const r2 = await call({ key: KEY, token: TOKEN, authorId: '26249081', index: 0, size: 'original' });
console.log(show(r2.text));
const j2 = (() => { try { return JSON.parse(r2.text); } catch { return null; } })();
ok('不再报错', !r2.isError);
ok('source=authorId', j2?.source === 'authorId');
ok('取到该作者最新作品 149807268', j2?.id === '149807268', `id=${j2?.id}`);
ok('png 原图字节 = 696,829B', j2?.bytes === 696829, `bytes=${j2?.bytes}`);
ok('sha256 = c792e5ce…（png 直联/代理曾实测同值）', String(j2?.sha256 ?? '').startsWith('c792e5cef111'), String(j2?.sha256));
ok('回执说发出去了', sentCount(j2?.sent) >= 1, JSON.stringify(j2?.sent));

console.log('\n=== 3. 画师号名下没有作品要说人话（不静默失败）===');
const r3 = await call({ key: KEY, token: TOKEN, authorId: '533797' });
console.log(show(r3.text, 400));
ok('报错而不是静默失败', r3.isError);
ok('说人话：名下没有公开作品', /名下没有公开作品/.test(r3.text));

console.log('\n=== 4. R-18 作品必须被挡下（不能发进 QQ）===');
const r4 = await call({ key: KEY, token: TOKEN, illustId: '110000000', size: 'original' });
console.log(show(r4.text, 400));
ok('被拒绝', r4.isError);
ok('原因写明 R-18', /R-18/.test(r4.text));

console.log('\n=== 5. 不存在的作品号 ===');
const r5 = await call({ key: KEY, token: TOKEN, illustId: '99999999999' });
console.log(show(r5.text, 400));
ok('报错并带来源说明', r5.isError && /取 Pixiv 作品 99999999999 失败/.test(r5.text));

console.log('\n=== 6. 旧路径（关键词搜索）没被改坏 ===');
const r6 = await call({ key: KEY, token: TOKEN, query: '初音ミク', size: 'master', index: 0 });
console.log(show(r6.text, 500));
const j6 = (() => { try { return JSON.parse(r6.text); } catch { return null; } })();
ok('搜索路径仍能发图', !r6.isError && j6?.source === 'search', r6.text.slice(0, 200));
ok('默认还是 master（1200px）', j6?.size === 'master');
ok('回执说发出去了', sentCount(j6?.sent) >= 1, JSON.stringify(j6?.sent));

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
await client.close();
process.exit(fail ? 1 : 0);
