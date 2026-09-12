// 导出 MCP 工具清单（名称 / 描述 / inputSchema），用于"压缩描述但功能不变"的可验证对比。
//
// 为什么用 MCP 握手而不是读源码：只有真正握手拿到的 `tools/list` 才是模型看到的东西，
// 也是唯一能逐字节证明"参数 schema 没被改动"的办法 —— 改描述时最怕手滑改了 zod 定义（那才是真丢功能）。
//
// 用法：
//   node tools/dump-tools-manifest.mjs                       # napcat 主 server → tools/manifest-napcat.json
//   node tools/dump-tools-manifest.mjs host                  # mcp-host-server.js
//   node tools/dump-tools-manifest.mjs web                   # mcp-web-search-safe.js
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const which = (process.argv[2] || 'napcat').toLowerCase();
const SERVERS = {
  napcat: { file: 'src/mcp-napcat-safe.js', out: 'manifest-napcat.json' },
  host: { file: 'src/mcp-host-server.js', out: 'manifest-host.json' },
  web: { file: 'src/mcp-web-search-safe.js', out: 'manifest-web.json' },
};
const s = SERVERS[which];
if (!s) { console.error('未知 server:', which, '（napcat | host | web）'); process.exit(1); }

const outFile = process.argv[3] || path.join(HERE, s.out);
const child = spawn(process.execPath, [path.join(ROOT, s.file)], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

let buf = '';
const responses = new Map();
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) responses.set(msg.id, msg);
    } catch { /* 非 JSON 行忽略 */ }
  }
});

const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
const waitFor = async (id, timeoutMs = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (responses.has(id)) return responses.get(id);
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
};

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'manifest-dump', version: '1.0' } } });
const init = await waitFor(1);
if (!init) { console.error('initialize 超时。stderr:\n' + stderr.slice(0, 2000)); child.kill(); process.exit(1); }
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
const list = await waitFor(2);
child.kill();

const tools = list?.result?.tools ?? [];
if (!tools.length) { console.error('tools/list 为空。stderr:\n' + stderr.slice(0, 2000)); process.exit(1); }

const rows = tools.map((t) => ({
  name: t.name,
  chars: t.name.length + String(t.description ?? '').length + JSON.stringify(t.inputSchema ?? {}).length,
  descChars: String(t.description ?? '').length,
  schemaChars: JSON.stringify(t.inputSchema ?? {}).length,
  description: t.description ?? '',
  inputSchema: t.inputSchema ?? {},
})).sort((a, b) => b.chars - a.chars);

const total = rows.reduce((a, r) => a + r.chars, 0);
fs.writeFileSync(outFile, JSON.stringify({ server: which, at: new Date().toISOString(), total, tools: rows }, null, 2), 'utf8');

console.log(`server=${which}  工具数=${rows.length}  合计 ${total} 字符  → ${outFile}`);
console.log('排名  合计   描述  schema  工具');
for (const [i, r] of rows.entries()) {
  console.log(`${String(i + 1).padStart(4)}  ${String(r.chars).padStart(6)}  ${String(r.descChars).padStart(5)}  ${String(r.schemaChars).padStart(6)}  ${r.name}`);
}
