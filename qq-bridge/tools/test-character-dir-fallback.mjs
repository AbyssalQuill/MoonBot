/**
 * 角色库目录回落的真调用测试（MCP over stdio，不是"看代码像不像"）。
 *
 * 这条测的是哪个事故：出厂角色库随安装包进了 `<qq-bridge>/characters`（21 个角色包）以后，
 * `resolveCharactersDir()` 以前"没配 social.charactersDir 就固定返回 ~/Downloads/characters/characters" ——
 * 全新机器上那个目录根本不存在（那是"用户自己放角色库的地方"），于是四个角色工具一起报
 * "角色库目录不存在"：装了 21 个包，一个都读不到。
 * 现在按"存在即用"回落：用户库 → 出厂库 → 老默认；配了 social.charactersDir 就完全以它为准。
 *
 * 做法：把 src 复制进沙箱当桥目录（顺带造一份假出厂库），`USERPROFILE` 指向一个没有 Downloads 的
 * 假 home，这样 DEFAULT 一定不存在 —— 正是新装机器的样子。然后真跑 MCP 调 qq_character_list：
 *   ① 没配 charactersDir → 必须读到出厂库里的包（修复前这里是"一个都读不到"）；
 *   ② 配了 charactersDir   → 必须改读那份，且出场库的包不再出现（证明配置优先）；
 *   ③ 配的路劲不存在       → 如实报错，不假装成功。
 *
 * 用法：node tools/test-character-dir-fallback.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');                 // qq-bridge/
const SANDBOX = path.join(REPO, `.char-dir-test-${Date.now()}`);
const BRIDGE = path.join(SANDBOX, 'qq-bridge');
const HOME = path.join(SANDBOX, 'home');
const USER_LIB = path.join(SANDBOX, 'user-lib');

let fails = 0;
let steps = 0;
const check = (name, ok, extra = '') => {
  steps += 1;
  if (!ok) fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  · ' + extra : ''}`);
};
const section = (t) => console.log(`\n=== ${t} ===`);

const w = (rel, text) => {
  const p = path.join(rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
};

// ─────────────────────────── 沙箱 ───────────────────────────
fs.mkdirSync(HOME, { recursive: true });               // 关键：故意不建 Downloads/
fs.cpSync(path.join(REPO, 'src'), path.join(BRIDGE, 'src'), { recursive: true });
// 假出厂库：两个包，默认档用 SKILL.md（和真出厂库同构）
w(path.join(BRIDGE, 'characters', 'demo-bundled', 'SKILL.md'), '# demo-bundled\n你是出厂库里的角色。\n');
w(path.join(BRIDGE, 'characters', 'demo-bundled', 'manifest.json'), JSON.stringify({ name: '出厂演示角色' }));
w(path.join(BRIDGE, 'characters', 'demo-second', 'SKILL.md'), '# demo-second\n出厂库第二个。\n');
// 用户自己那份库（只有配了 charactersDir 才该被读到）
w(path.join(USER_LIB, 'demo-user', 'SKILL.md'), '# demo-user\n你自己库里的角色。\n');
const CFG = path.join(BRIDGE, 'config.json');
const writeCfg = (social) => fs.writeFileSync(CFG, JSON.stringify({ ownerQQ: 1, social }, null, 2) + '\n', 'utf8');
writeCfg({});                                          // 先不配 charactersDir

function connect(serverFile, extraEnv = {}) {
  const cwd = path.dirname(path.dirname(serverFile));
  const child = spawn(process.execPath, [serverFile], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
  const responses = new Map();
  const errLines = [];
  let buf = '';
  let errBuf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m.id != null) responses.set(m.id, m); } catch { /* 非 JSON 行忽略 */ }
    }
  });
  child.stderr.on('data', (d) => {
    errBuf += d.toString();
    let i;
    while ((i = errBuf.indexOf('\n')) >= 0) {
      const line = errBuf.slice(0, i).trim(); errBuf = errBuf.slice(i + 1);
      if (line) errLines.push(line);
    }
  });
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  const wait = async (id, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (responses.has(id)) return responses.get(id); await new Promise((r) => setTimeout(r, 50)); }
    return null;
  };
  return { child, send, wait, errLines };
}
const textOf = (msg) => msg?.result?.content?.map((c) => c.text ?? '').join('\n') ?? '';

let child = null;
try {
  section('沙箱就绪');
  console.log(`沙箱 : ${SANDBOX}`);
  console.log(`假 home: ${HOME}（无 Downloads）`);
  console.log(`出厂库: ${path.join(BRIDGE, 'characters')}`);

  const { child: c, send, wait, errLines } = connect(path.join(BRIDGE, 'src', 'mcp-napcat-safe.js'), { USERPROFILE: HOME });
  child = c;
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'char-dir', version: '1' } } });
  check('MCP initialize 成功', !!(await wait(1)));
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  let nextId = 10;
  const list = async () => {
    const id = nextId++;
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'qq_character_list', arguments: {} } });
    return textOf(await wait(id, 25000));
  };

  section('① 没配 social.charactersDir 且用户库不存在 → 必须回落到出厂库');
  const t1 = await list();
  console.log(t1.split('\n').slice(0, 6).join('\n'));
  check('读到出厂库里的 demo-bundled', t1.includes('demo-bundled'));
  check('读到出厂库里的第二个包 demo-second', t1.includes('demo-second'));
  check('没有误读用户库（它这轮不该被看）', !t1.includes('demo-user'));
  check('不是"目录不存在"那种失败', !/not exist|does not exist|目录不存在|not found/i.test(t1), t1.slice(0, 120));
  check('stderr 里没报角色库缺失', !errLines.some((l) => /character library directory does not exist/i.test(l)));

  section('② 配了 social.charactersDir → 完全以它为准');
  writeCfg({ charactersDir: USER_LIB });
  const t2 = await list();
  console.log(t2.split('\n').slice(0, 6).join('\n'));
  check('改读用户库里那份', t2.includes('demo-user'));
  check('出厂库的包不再出现', !t2.includes('demo-bundled') && !t2.includes('demo-second'));

  section('③ 配了一个不存在的目录 → 如实报错，不假装成功');
  writeCfg({ charactersDir: path.join(SANDBOX, 'nowhere') });
  const t3 = await list();
  console.log(t3.split('\n').slice(0, 4).join('\n'));
  check('没有列出任何包', !t3.includes('demo-bundled') && !t3.includes('demo-user'));
  check('明确说了目录不在', /not exist|does not exist|目录不存在|not found/i.test(t3), t3.slice(0, 140));
} finally {
  if (child) child.kill();
  const base = path.basename(SANDBOX);
  if (base.startsWith('.char-dir-test-') && !/node_modules/i.test(SANDBOX)) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Remove-Item -LiteralPath ${JSON.stringify(SANDBOX)} -Recurse -Force`], { stdio: 'ignore' });
    console.log(`\n[cleanup] 沙箱已清理 exit=${r.status}；仍存在=${fs.existsSync(SANDBOX)}`);
    check('沙箱清理干净', !fs.existsSync(SANDBOX));
  } else {
    console.log(`清理已跳过：${SANDBOX}`);
  }
}
console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}（${steps} 项检查）`);
process.exit(fails ? 1 : 0);
