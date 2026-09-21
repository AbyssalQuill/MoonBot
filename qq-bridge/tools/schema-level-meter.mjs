// 实测：用新的"描述压缩档"起一次 MCP server（关掉名单裁剪），量各档在**真实 wire 格式**下的大小。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'src', 'mcp-napcat-safe.js');

function start(env) {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let buf = ''; let seq = 1; const pending = new Map();
  child.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      try { const m = JSON.parse(line); const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); } } catch { /* skip */ }
    }
  });
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = seq++; const t = setTimeout(() => rej(new Error('timeout ' + method)), 30000);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    send({ jsonrpc: '2.0', id, method, params });
  });
  return { child, rpc, send };
}

const results = {};
for (const level of ['off', 'medium', 'high']) {
  const s = start({ QQB_SLIM_TOOLS_OFF: '1', QQB_SCHEMA_STATS_ONLY: '1', QQB_SCHEMA_LEVEL: level });
  await s.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'm', version: '0' } });
  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await s.rpc('tools/list', {});
  s.child.kill();
  const tools = list.result?.tools ?? [];
  const chars = tools.reduce((sum, t) => sum + JSON.stringify({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? {} }).length, 0);
  results[level] = { n: tools.length, chars };
  const withDesc = tools.filter((t) => t.description).length;
  const paramsWithDesc = tools.reduce((sum, t) => sum + Object.values(t.inputSchema?.properties ?? {}).filter((p) => p && p.description !== undefined).length, 0);
  const paramsTotal = tools.reduce((sum, t) => sum + Object.keys(t.inputSchema?.properties ?? {}).length, 0);
  console.log(`${level.padEnd(7)} 工具 ${String(tools.length).padStart(3)} 个 · ${String(chars).padStart(7)} 字符 · ${(chars / results.off.chars * 100).toFixed(1).padStart(5)}% · 有描述的工具 ${withDesc}/${tools.length} · 有描述的参数 ${paramsWithDesc}/${paramsTotal}`);
}

const base = results.off.chars;
console.log('');
console.log(`off 时的完整表：${base.toLocaleString()} 字符 ≈ ${Math.round(base / 3.2).toLocaleString()} token/步`);
for (const [k, v] of Object.entries(results)) {
  if (k === 'off') continue;
  console.log(`  切到 ${k.padEnd(6)} 省 ${(base - v.chars).toLocaleString()} 字符 ≈ ${Math.round((base - v.chars) / 3.2).toLocaleString()} token/步`);
}
