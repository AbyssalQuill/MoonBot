// 内置表情包工具的真调用测试（MCP over stdio，不是"看文件在不在"）。
//
// 背景：现网 qq_meme_search 一直回"表情包图库搜索失败 / 本机没装内置表情包"，
// 根因是安装包 payload 与现网 runtime 都漏装了 meme/ 表情包。本脚本用**真实 MCP 握手 + 真实工具调用**
// 证明：工具找得到 pack、SQLite 查得到行、返回的文件名在本机磁盘上真实存在（且不是提示语）。
//
// 用法：
//   node tools/test-meme-search.mjs                       # 测本仓库 src/mcp-napcat-safe.js
//   node tools/test-meme-search.mjs <server.js 路径>       # 测指定副本（现网 runtime / 打包 payload）
//   node tools/test-meme-search.mjs <server.js> --pack <pack 根>
//   node tools/test-meme-search.mjs --negative             # 反向自测：无 pack 时必须"响亮报错"
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..'); // qq-bridge/
const argv = process.argv.slice(2);
const NEGATIVE = argv.includes('--negative');
const packArgIdx = argv.indexOf('--pack');
const PACK_ARG = packArgIdx >= 0 ? argv[packArgIdx + 1] : '';
const execIdx = argv.indexOf('--exec');
// --exec：换解释器（例如线上真正用的 <安装目录>\resources\runtime\qbm-node.exe），默认系统 node
const EXEC_PATH = execIdx >= 0 ? path.resolve(argv[execIdx + 1]) : process.execPath;
const SERVER = path.resolve(
  NEGATIVE ? path.join(REPO, 'src', 'mcp-napcat-safe.js')
    : (argv.find((a) => !a.startsWith('--') && a !== PACK_ARG && a !== (execIdx >= 0 ? argv[execIdx + 1] : '')) || path.join(REPO, 'src', 'mcp-napcat-safe.js'))
);
const SERVER_ROOT = path.dirname(path.dirname(SERVER)); // qq-bridge/

let fails = 0;
let steps = 0;
const check = (name, ok, extra = '') => {
  steps += 1;
  if (!ok) fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};
const section = (t) => console.log(`\n=== ${t} ===`);

/** MD5(前 8 位)，用于报告里证明测的是哪份代码 */
async function md5of(p) {
  const { createHash } = await import('node:crypto');
  return createHash('md5').update(fs.readFileSync(p)).digest('hex').slice(0, 8);
}

/** 与 server 同序的候选表（仅用于测试侧独立定位 pack，用来核对"文件名在磁盘上真实存在"） */
function discoverPack(serverRoot) {
  if (PACK_ARG) return fs.existsSync(path.join(PACK_ARG, 'index.db')) ? PACK_ARG : null;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const cands = [
    path.join(serverRoot, '..', 'meme', 'whale-fanart-001'),
    path.join(serverRoot, '..', '.runtime', 'meme-packs', 'whale-fanart-001'),
    path.join(serverRoot, 'meme', 'whale-fanart-001'),
    path.join(serverRoot, '.runtime', 'meme-packs', 'whale-fanart-001'),
    home ? path.join(home, '.dsh', 'meme-packs', 'whale-fanart-001') : '',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.statSync(path.join(c, 'index.db')).size > 0) return c; } catch { /* next */ } }
  return null;
}

/** 磁盘上真实存在的表情文件表：<文件名> -> { size }（独立于工具用的 index.db，避免自证） */
function listPackFiles(packRoot) {
  const map = new Map();
  if (!packRoot) return map;
  const memes = path.join(packRoot, 'memes');
  const stack = [memes];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { map.set(e.name, fs.statSync(p).size); } catch { /* skip */ } }
    }
  }
  return map;
}

/** 起 MCP server（stdio）并完成 initialize 握手 */
function connect(serverFile) {
  const cwd = path.dirname(path.dirname(serverFile));
  const child = spawn(EXEC_PATH, [serverFile], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const responses = new Map();
  const stderrLines = [];
  let buf = '';
  let errBuf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m.id != null) responses.set(m.id, m); } catch { /* 非 JSON 行忽略 */ }
    }
  });
  child.stderr.on('data', (d) => {
    errBuf += d.toString();
    let i;
    while ((i = errBuf.indexOf('\n')) >= 0) {
      const line = errBuf.slice(0, i).trim();
      errBuf = errBuf.slice(i + 1);
      if (line) stderrLines.push(line);
    }
  });
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  const wait = async (id, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (responses.has(id)) return responses.get(id); await new Promise((r) => setTimeout(r, 50)); }
    return null;
  };
  return { child, send, wait, stderrLines };
}

const textOf = (msg) => msg?.result?.content?.map((c) => c.text ?? '').join('\n') ?? '';

// ---------------------------------------------------------------- 反向自测
if (NEGATIVE) {
  section('反向自测：无 pack 时必须响亮报错（不许静默降级）');
  // 【2026-09-13 事故修复】原来把隔离副本建在 `qq-bridge/node_modules/.meme-selftest-X/qq-bridge`，
  // 清理时却 `Remove-Item dirname(dirname(tmp))` —— 那正好是 **qq-bridge/node_modules 本身**，
  // 于是跑一次 --negative 就把整套桥依赖删了（现网 `<安装目录>\resources\runtime\qq-bridge\node_modules`
  // 就是这样被删掉的，重启桥就会起不来）。现在：副本放在项目根下的点目录（**不在 node_modules 里**），
  // 清理只删那一个 `.meme-selftest-*` 目录，并加一道"名字必须是 .meme-selftest- 开头"的安全断言。
  // 放这里仍然满足 ESM 解析：`@modelcontextprotocol/sdk` 靠向上找 `<REPO>/node_modules` 命中。
  const selftestDir = path.join(REPO, `.meme-selftest-${Date.now()}`);
  const tmp = path.join(selftestDir, 'qq-bridge');
  fs.mkdirSync(tmp, { recursive: true });
  fs.cpSync(path.join(REPO, 'src'), path.join(tmp, 'src'), { recursive: true });
  const fake = path.join(tmp, 'src', 'mcp-napcat-safe.js');
  console.log(`隔离测试副本：${fake}\n（该副本下 qq-bridge/meme 与 qq-bridge/../meme 都不存在）`);
  try {
    const { child, send, wait, stderrLines } = connect(fake);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'meme-negative', version: '1' } } });
    check('initialize 成功', !!(await wait(1)));
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await new Promise((r) => setTimeout(r, 400)); // 等启动日志落到 stderr
    const line = stderrLines.find((l) => l.includes('未找到内置表情包')) ?? '';
    console.log(`stderr 启动日志：${line || '(没有！)'}`);
    check('启动时打出一行"未找到表情库"日志', !!line);
    const m = line.match(/已尝试 (\d+) 条路径/);
    const listed = line.includes('：') ? line.slice(line.lastIndexOf('：') + 1).split(' | ').filter(Boolean) : [];
    check('日志列出每条尝试过的路径', !!m && listed.length === Number(m[1]), `声明 ${m?.[1] ?? '?'} 条 / 实际 ${listed.length} 条`);
    check('候选里包含隔离 DSH home 的 meme-packs 位置', listed.some((p) => /\.qq-bridge-manager[\\/]dsh-isolated-home/.test(p) && /meme-packs/.test(p)));
    check('候选里包含 DSH plugins pack 位置', listed.some((p) => /[\\/]plugins[\\/]/.test(p)));
    send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'qq_meme_search', arguments: { query: '开心' } } });
    const t = textOf(await wait(10, 20000));
    console.log(`工具返回：${t.slice(0, 200)}`);
    check('无 pack 时工具返回缺包提示（而不是崩溃）', t.includes('本机没装内置表情包'));
    child.kill();
  } finally {
    // 安全闸：只允许删 `.meme-selftest-` 开头的临时目录（绝不能是 node_modules）
    const base = path.basename(selftestDir);
    if (!base.startsWith('.meme-selftest-') || /node_modules/i.test(selftestDir)) {
      console.log(`清理已跳过（路径不像自测临时目录）：${selftestDir}`);
    } else {
      // 含中文/长路径一律交给 PowerShell 删（Node 的 fs.rmSync 在本机遇 CJK 路径会硬崩）
      const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Remove-Item -LiteralPath ${JSON.stringify(selftestDir)} -Recurse -Force`], { stdio: 'inherit' });
      console.log(`清理隔离副本 exit=${r.status}；仍存在=${fs.existsSync(tmp)}`);
      // 关键回归：绝对不允许动到依赖目录
      check('清理没有伤到 node_modules', fs.existsSync(path.join(REPO, 'node_modules')), path.join(REPO, 'node_modules'));
    }
  }
  console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}（${steps} 项检查）`);
  process.exit(fails ? 1 : 0);
}

// ---------------------------------------------------------------- 正向真调用
const packRoot = discoverPack(SERVER_ROOT);
const packFiles = listPackFiles(packRoot);

section('被测对象');
console.log(`server : ${SERVER}`);
console.log(`md5(8) : ${await md5of(SERVER)}`);
console.log(`pack   : ${packRoot ?? '(未发现)'}  磁盘表情文件 ${packFiles.size} 个`);
if (packRoot) {
  const all = fs.readdirSync(path.join(packRoot, 'memes'), { withFileTypes: true });
  console.log(`分类   : ${all.map((e) => e.name).join(', ')}`);
}

const { child, send, wait, stderrLines } = connect(SERVER);
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'meme-live', version: '1' } } });
const init = await wait(1);
check('MCP initialize 握手成功', !!init, init?.result?.serverInfo?.name ?? '');
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const list = await wait(2, 30000);
const names = list?.result?.tools?.map((t) => t.name) ?? [];
check('tools/list 里有两个表情工具', names.includes('qq_meme_search') && names.includes('qq_send_meme'), `共 ${names.length} 个工具`);

/** 校验一次搜索返回：不是提示语、行数对得上、文件名在磁盘上真实存在且非空 */
function verifySearch(label, text, expectCountMin) {
  console.log(`\n--- ${label} 原始返回 ---\n${text}\n---`);
  check(`${label}: 不是"没装表情库"提示`, !text.includes('本机没装内置表情包'));
  check(`${label}: 不是"搜索失败"错误`, !text.includes('搜索失败'));
  const m = text.match(/找到 (\d+) 张表情/);
  check(`${label}: 声称找到表情张数`, !!m && Number(m[1]) >= expectCountMin, m ? `found=${m[1]}` : '无"找到 N 张"字样');
  const rows = text.split('\n').slice(1).map((l) => l.match(/^\d+\.\s+(.+?)\s+\[(.+?)\]\s+(.*)$/)).filter(Boolean);
  check(`${label}: 解析出真实行数`, rows.length >= expectCountMin, `rows=${rows.length}`);
  const missing = rows.filter((r) => !packFiles.has(r[1]));
  const empty = rows.filter((r) => packFiles.has(r[1]) && !(packFiles.get(r[1]) > 0));
  check(`${label}: 每个文件名都在磁盘上真实存在`, missing.length === 0 && rows.length > 0, missing.length ? `缺: ${missing.map((r) => r[1]).join(',')}` : `全部命中（0 字节 ${empty.length} 个）`);
  return rows;
}

send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'qq_meme_search', arguments: { query: '开心' } } });
const t1 = textOf(await wait(10, 30000));
const rows1 = verifySearch('query="开心"', t1, 1);

send({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'qq_meme_search', arguments: { query: '', tag: 'happy', limit: 5 } } });
const t2 = textOf(await wait(11, 30000));
const rows2 = verifySearch('tag="happy" limit=5', t2, 1);
check('tag 过滤真的生效（每行 tag 都是 happy）', rows2.length > 0 && rows2.every((r) => r[2].toLowerCase() === 'happy'), rows2.map((r) => r[2]).join(','));
const uniq2 = new Set(rows2.map((r) => r[1]));
check('tag 过滤返回的是不同图片', uniq2.size === rows2.length, `unique=${uniq2.size}/${rows2.length}`);

send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'qq_meme_search', arguments: { query: 'zzz-不存在的关键词-zzz' } } });
const t3 = textOf(await wait(12, 30000));
console.log(`\n--- 空结果对照 原始返回 ---\n${t3}\n---`);
check('查不到时是"没找到匹配"而不是缺包提示', t3.includes('没找到匹配的表情') && !t3.includes('本机没装内置表情包'));

section('server stderr（启动日志）');
for (const l of stderrLines) console.log(l || '(空)');
check('启动日志里报了 pack 位置（可诊断）', stderrLines.some((l) => l.includes('内置表情包已加载') || l.includes('未找到内置表情包')));

child.kill();
console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}（${steps} 项检查）`);
process.exit(fails ? 1 : 0);
