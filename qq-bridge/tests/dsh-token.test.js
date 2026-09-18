// dsh-client.readLatestToken 测试：桥靠它从 dsh-web 启动日志里取 ?token= 换 dsh-auth cookie。
// 关键性质（都是 2026-09-18 那次全链路 401 事故里踩到的）：
//   ① token 行后面只要跟了超过旧窗口 256KB 的噪声，旧实现就返回 null（静默降级成无鉴权请求 → 401）；
//   ② 噪声正是桥自己的 MCP 子进程写进同一个 dsh-web.log 的（现场 98.6% 的行都是它）；
//   ③ 一个文件里有多条 token 时，必须取**最后一条**（那才是当前进程的）；
//   ④ 文件不存在 / 完全没有 token → null（退化行为，不能抛）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const { readLatestToken } = await import('../src/dsh-client.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-token-'));
const log = path.join(tmp, 'dsh-web.log');

// 造一条“和线上同形”的噪声行：[qq-tool-restrict] 那行会嵌完整工具表。
// 线上实测平均 2341 字符/行；这里用 3913 字符/行（把工具名重复 200 次），比线上更长，属加压。
const noiseLine = '[qq-tool-restrict] skip restrict dev_x: tools.restrict() names unknown global tool "dev_x"; known global tools: ' + 'mcp__napcat__qq_a, '.repeat(200) + '\n';
const noiseBytes = Buffer.byteLength(noiseLine);
const tokenLine = (t) => `dsh web: http://127.0.0.1:3080/?token=${t}\n`;

// ① 现场复现：token 在文件末尾，但其后又被子进程灌了 300KB 噪声（> 旧的 256KB 窗口）
fs.writeFileSync(log, tokenLine('OLD_TOKEN') + noiseLine.repeat(Math.ceil(300 * 1024 / noiseBytes)));
assert.equal(readLatestToken(log), 'OLD_TOKEN', 'token 后跟 300KB 噪声仍应能找到（旧实现这里返回 null）');

// ② 噪声刚好不到 256KB（旧实现能过）——确认没有把原来能用的场景改坏
fs.writeFileSync(log, tokenLine('TOKEN_A') + noiseLine.repeat(Math.ceil(200 * 1024 / noiseBytes)));
assert.equal(readLatestToken(log), 'TOKEN_A', '噪声 200KB 时应能找到');

// ③ 多条 token：取最后一条（最新的那次 dsh-web 启动）
fs.writeFileSync(log, tokenLine('TOKEN_1') + noiseLine.repeat(30) + tokenLine('TOKEN_2'));
assert.equal(readLatestToken(log), 'TOKEN_2', '应取最后一条 token');

// ④ 超过 16MB 兜底上限的 token → null（有界，不随日志无限放大成本）
fs.writeFileSync(log, tokenLine('TOO_FAR') + noiseLine.repeat(Math.ceil(17 * 1024 * 1024 / noiseBytes)));
assert.equal(readLatestToken(log), null, '超过 16MB 兜底上限应返回 null 而不是继续放大');

// ⑤ 没有 token / 文件不存在 / 空文件
fs.writeFileSync(log, noiseLine.repeat(5));
assert.equal(readLatestToken(log), null, '文件里没有 token 应返回 null');
assert.equal(readLatestToken(path.join(tmp, 'nope.log')), null, '文件不存在应返回 null');
assert.equal(readLatestToken(''), null, '没有配日志路径应返回 null');
fs.writeFileSync(log, '');
assert.equal(readLatestToken(log), null, '空文件应返回 null');

console.log(`dsh-token: 全部通过 ✓（噪声行 ${noiseBytes} 字符/行，比线上实测的 2341 更长，属加压）`);
fs.rmSync(tmp, { recursive: true, force: true });
