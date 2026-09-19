/**
 * 只读诊断：拿真配置起一遍 MCP，列出模型实际能看到的工具名，
 * 并检查几个关键工具在不在（发消息 / 状态 / 表情包 / 角色库）。
 * 用法：node tools/diag-live-tool-list.mjs [server.js 路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SERVER = path.resolve(process.argv[2] || path.join(REPO, 'src', 'mcp-napcat-safe.js'));
const cwd = path.dirname(path.dirname(SERVER));

const child = spawn(process.execPath, [SERVER], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
const responses = new Map();
const errLines = [];
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id != null) responses.set(m.id, m); } catch { /* ignore */ }
  }
});
let errBuf = '';
child.stderr.on('data', (d) => {
  errBuf += d.toString();
  let i;
  while ((i = errBuf.indexOf('\n')) >= 0) {
    const line = errBuf.slice(0, i).trim(); errBuf = errBuf.slice(i + 1);
    if (line) errLines.push(line);
  }
});
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const wait = async (id, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (responses.has(id)) return responses.get(id); await new Promise((r) => setTimeout(r, 50)); }
  return null;
};

console.log(`server : ${SERVER}`);
console.log(`cwd    : ${cwd}`);
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tool-list-diag', version: '1' } } });
console.log('initialize:', !!(await wait(1)));
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const list = await wait(2, 30000);
const names = (list?.result?.tools ?? []).map((t) => t.name);
console.log(`\n共 ${names.length} 个工具`);
const want = ['qq_send_message', 'qq_reply', 'qq_send_group_message', 'qq_send_private_message', 'qq_social_state', 'qq_get_social_state', 'qq_meme_search', 'qq_send_meme', 'qq_character_list', 'qq_get_prompt', 'qq_mark_read'];
for (const w of want) console.log(`  ${names.includes(w) ? '有 ' : '缺 '} ${w}`);
console.log('\n名字里带 social 的：', names.filter((n) => /social/i.test(n)).join(', ') || '(没有)');
console.log('\n前 40 个工具：');
console.log('  ' + names.slice(0, 40).join(', '));
console.log('\nstderr:');
for (const l of errLines.slice(0, 8)) console.log('  ' + l);
child.kill();
process.exit(0);
