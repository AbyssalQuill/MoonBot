// 功能冒烟：压缩文案之后，MCP server 仍能被拉起、工具仍能真正调用（不是只看 schema）。
// 只调只读工具，避免动线上任何状态。
// 用法：node tools/test-mcp-tools-live.mjs
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp-napcat-safe.js')], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const responses = new Map();
child.stderr.on('data', () => {});
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id != null) responses.set(m.id, m); } catch { /* ignore */ }
  }
});
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const wait = async (id, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (responses.has(id)) return responses.get(id); await new Promise((r) => setTimeout(r, 50)); } return null; };

let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } });
check('initialize 成功', !!(await wait(1)));
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'qq_status', arguments: {} } });
const st = await wait(10);
const stText = st?.result?.content?.[0]?.text ?? '';
check('qq_status 可调用且返回 JSON', /"(online|good|nickname|user_id)"/.test(stText), stText.slice(0, 120));

// 只读：用 owner 私聊 token 查两条历史（limit=2，最小代价）
// owner QQ 不写死在测试里（仓库要公开）：优先读线上 config.json 的 ownerQQ，
// 读不到就退化到"social-state 里第一个私聊会话"，保证换人部署也能跑。
let token = '';
let ownerKey = '';
try {
  const fs = await import('node:fs');
  const LIVE = 'D:\\MoonBot\\resources\\runtime\\qq-bridge';
  const social = JSON.parse(fs.readFileSync(path.join(LIVE, 'state', 'social-state.json'), 'utf8'));
  let ownerQQ = '';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(LIVE, 'config.json'), 'utf8'));
    ownerQQ = String(cfg?.ownerQQ || '');
  } catch { /* 配置读不到就退化 */ }
  if (ownerQQ && social.conversations?.[`private:${ownerQQ}`]) ownerKey = `private:${ownerQQ}`;
  if (!ownerKey) ownerKey = Object.keys(social.conversations || {}).find((k) => k.startsWith('private:')) || '';
  token = ownerKey ? (social.conversations?.[ownerKey]?.agentToken || '') : '';
} catch { /* 线上状态读不到就跳过这项 */ }
if (token) {
  send({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'qq_memory_search', arguments: { key: ownerKey, token, limit: 2 } } });
  const ms = await wait(11, 25000);
  const msText = ms?.result?.content?.[0]?.text ?? '';
  let parsed = null;
  try { parsed = JSON.parse(msText); } catch { /* ignore */ }
  check('qq_memory_search 可调用（只读，limit=2）', parsed?.ok === true && Array.isArray(parsed?.messages), `count=${parsed?.messages?.length} chars=${msText.length}`);
  check('检索结果仍被截断保护（≤12000 字符）', msText.length <= 12000, `${msText.length} 字符`);
} else {
  console.log('SKIP  qq_memory_search（读不到线上 token）');
}

child.kill();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
