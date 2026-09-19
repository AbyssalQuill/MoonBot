/* 让 DSH 用上刚改好的 MCP 工具代码（不用重启 dsh-web）。
 *
 * 背景：MCP server 是 dsh 进程（mcp-client 插件）spawn 的**长期子进程**，启动时读一次脚本文件；
 * 改完 src/mcp-*.js 后如果不重载，运行中的会话仍在跑老代码 —— 表现就是"改了但没生效"，
 * 而 `systemctl restart dsh-web` 能生效却会打断 QQ 侧正在跑的会话。
 *
 * 做法：只杀掉那个 MCP 子进程。mcp-client 的 Connection supervisor 自带
 * bounded exponential backoff（默认 initialDelayMs=500 / maxAttempts=10），会在半秒内重新 spawn，
 * 新进程自然读到新代码。代价只有"此刻正在飞的那一次工具调用会失败"。
 *
 * 实测（2026-09-19，线上 VPS）：kill 前 pid 362239（跑了 17.5h），kill 后 4s 内出现新 pid，
 * ppid 仍是 dsh —— 会话侧工具列表无缝恢复。
 *
 * 用法：node qq-bridge/tools/reload-mcp-child.mjs [进程名关键字，默认 mcp-napcat-safe.js]
 */
import { execFileSync } from 'node:child_process';

const needle = process.argv[2] || 'mcp-napcat-safe.js';
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }); } catch (e) { return String(e?.stdout ?? ''); } };
const list = () => sh('ps', ['-eo', 'pid,ppid,etimes,args']).split('\n').filter((l) => l.includes(needle) && !l.includes('reload-mcp-child'));
/** ⚠️ `ps` 的行以空格开头：直接 split 会把 pid 解析成空串，判重就永远为假（本脚本第一版真踩了）。 */
const pidOf = (line) => line.trim().split(/\s+/)[0];

const before = list();
console.log('=== 重载前 ===');
for (const l of before) console.log('  ' + l.trim().slice(0, 120));
if (!before.length) { console.log('  没找到该 MCP 子进程（名字对不对？）'); process.exit(1); }

/* pkill -f '<脚本>' 会把自己这条命令行也匹配上（历史上真的自杀过）→ 用 [x] 技巧让模式不匹配自身。 */
const pattern = `[${needle[0]}]${needle.slice(1)}`;
execFileSync('bash', ['-c', `pkill -f '${pattern}' || true`]);
await new Promise((r) => setTimeout(r, 4000));

const after = list();
console.log('\n=== 重载后（监督器应已复活）===');
for (const l of after) console.log('  ' + l.trim().slice(0, 120));
const oldPids = new Set(before.map(pidOf));
const survived = after.some((l) => !oldPids.has(pidOf(l)));
console.log(survived ? '  ⇒ 新进程已起：会话侧用的是新代码' : '  ⇒ 没有新进程！需要重启 dsh-web');
process.exit(survived ? 0 : 1);
