/* 探测 MCP server 实际注册了哪些工具（走 stdio 协议 tools/list），用来验证 slimTools 裁剪是否真的生效。
   用法：node tools/probe-mcp-tools.mjs <qq-bridge 目录> [server文件]
   例：  node tools/probe-mcp-tools.mjs "D:\MoonBot\resources\runtime\qq-bridge"
   说明：必须在**目标 qq-bridge 目录**里跑（MCP server 从自己的目录读 config.json）。 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

const BRIDGE = path.resolve(process.argv[2] || process.cwd());
const FILE = process.argv[3] || 'mcp-napcat-safe.js';
const script = path.join(BRIDGE, 'src', FILE);
if (!existsSync(script)) { console.log(`找不到 ${script}`); process.exit(1); }

const child = spawn(process.execPath, [script], { cwd: BRIDGE, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const responses = new Map();
let stderrAll = '';
child.stderr.on('data', (d) => { stderrAll += String(d); });
child.stdout.on('data', (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id != null) responses.set(m.id, m); } catch { /* ignore */ }
  }
});
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const wait = async (id, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (responses.has(id)) return responses.get(id); await new Promise((r) => setTimeout(r, 40)); } return null; };

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
const init = await wait(1);
if (!init) { console.log('initialize 失败（MCP server 没起来）'); console.log(stderrAll.slice(0, 800)); process.exit(1); }
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
const list = await wait(2);
const rawTools = list?.result?.tools ?? [];
const tools = rawTools.map((t) => t.name).sort();
const chars = rawTools.reduce((n, t) => n + JSON.stringify(t).length, 0);
console.log(`文件: ${FILE}`);
console.log(`工具数: ${tools.length}`);
console.log(`工具表体积: ${chars} 字符（≈ ${Math.round(chars / 3.2)} tokens，每次模型请求都要重发一遍）`);
console.log('工具名:');
for (const t of tools) console.log('  ' + t);
if (stderrAll.trim()) {
  console.log('--- stderr（MCP server 日志）---');
  console.log(stderrAll.trim().split('\n').slice(0, 6).join('\n'));
}
try { child.kill(); } catch { /* ignore */ }
process.exit(0);
