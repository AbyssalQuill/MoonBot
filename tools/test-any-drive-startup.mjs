/* 回归测试：【装到任意盘都能起来】（主人 2026-09-12 原话："要确保这个应用安装在哪个盘都可以找到，
 * 这样拿给别人安装才可以整成使用"）。
 *
 * 这个测试不复述代码逻辑，而是**真的**在另一个盘上造一棵安装树、用一个错的 cwd 拉起后端，
 * 再看它自己找到的是不是那棵树里的目录：
 *   ① 安装树：<别的盘>:\mb-anydrive-test\resources\runtime\{server,dist,qq-bridge,node_modules}
 *   ② 启动方式：`node <runtime>/server/index.js`，但 **cwd = C:\Windows\System32**
 *      （等价于用户从资源管理器双击 qbm-node.exe / 旧快捷方式 / 计划任务拉起 —— 旧代码在这里会把
 *        dsh / qq-bridge / dist / 隔离 home 全部解析到 System32 下面，管理端页面 404）
 *   ③ 断言：/api/bridge/config 的 dir 落在**测试树**里、/api/state 能起来、dist/index.html 能取到
 *   ④ 隔离：给子进程一个临时 USERPROFILE，绝不让它读到/写到主人真正的 ~/.qq-bridge-manager/config.json
 *
 * 用法：node tools/test-any-drive-startup.mjs        （可选环境变量 MB_TEST_DRIVE=E:）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DRIVE = (process.env.MB_TEST_DRIVE || 'D:').replace(/[\\/]+$/, '');
const PORT = 1941 + Math.floor(Math.random() * 40);

let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = path.join(`${DRIVE}${path.sep}`, 'mb-anydrive-test');
const runtime = path.join(root, 'resources', 'runtime');
let child = null;

function rmTree(p) {
  // Windows 上删除可能因为句柄占用失败，重试几次；含中文时不要用 fs.rmSync（本机曾硬崩）
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 交给下面的重试 */ }
}

async function main() {
  if (!fs.existsSync(`${DRIVE}${path.sep}`)) throw new Error(`测试盘不存在：${DRIVE}（可用 MB_TEST_DRIVE 指定别的盘）`);
  rmTree(root);
  fs.mkdirSync(path.join(runtime, 'server'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'qq-bridge'), { recursive: true });
  fs.mkdirSync(path.join(runtime, '.runtime'), { recursive: true });

  // 安装树内容：server（真代码）+ dist（占位）+ qq-bridge/config.json（让 findBridgeDir 认得它）
  fs.copyFileSync(path.join(REPO, 'server', 'index.js'), path.join(runtime, 'server', 'index.js'));
  fs.copyFileSync(path.join(REPO, 'server', 'deploy.js'), path.join(runtime, 'server', 'deploy.js'));
  fs.writeFileSync(path.join(runtime, 'dist', 'index.html'), '<!doctype html><title>anydrive-test</title>ok\n', 'utf8');
  fs.writeFileSync(path.join(runtime, 'qq-bridge', 'config.json'), JSON.stringify({
    ownerQQ: null,
    dsh: { baseUrl: 'http://127.0.0.1:10721' },
    social: { enabled: true },
    allow: { private: [], group: [] }, deny: { private: [], group: [] },
  }, null, 2), 'utf8');
  // node_modules 用 junction 指回仓库（避免复制 100MB+；junction 不需要管理员权限）
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(runtime, 'node_modules'), 'junction');

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-anydrive-home-'));
  console.log(`安装树: ${runtime}`);
  console.log(`cwd   : C:\\Windows\\System32（故意用错的 cwd）`);
  console.log(`HOME  : ${fakeHome}（隔离，不碰主人真正的配置）`);

  child = spawn(process.execPath, [path.join(runtime, 'server', 'index.js')], {
    cwd: 'C:\\Windows\\System32',
    env: { ...process.env, USERPROFILE: fakeHome, QBM_API_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });

  const j = async (p) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return { status: r.status, body: await r.json().catch(() => null) }; };
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/api/state`); if (r.ok) { up = true; break; } } catch {} await sleep(500); }
  check('① 用错误的 cwd 也能把后端拉起来', up, up ? '' : out.slice(-300));
  if (!up) { child.kill(); rmTree(root); return; }

  const cfg = await j('/api/bridge/config');
  const dir = String(cfg.body?.dir ?? '');
  check('② 找到了**本安装树**里的 qq-bridge（不是 cwd 下的）', dir.toLowerCase().startsWith(runtime.toLowerCase()), `dir=${dir}`);
  check('② 没有解析到 System32 之类的外部目录', !/system32/i.test(dir), dir);

  const st = await j('/api/state');
  check('③ 状态接口可用', st.status === 200 && Array.isArray(st.body?.instances), `status=${st.status}`);
  const enabled = (st.body?.instances ?? []).filter((i) => i?.enabled === true);
  check('③ 测试树里没有 enabled 实例（不会去拉起真 NapCat）', enabled.length === 0, JSON.stringify((st.body?.instances ?? []).map((i) => [i.id, i.enabled])));

  const page = await fetch(`http://127.0.0.1:${PORT}/`);
  const html = await page.text();
  check('④ 管理端静态页也能从本安装树取到（不是 cwd/dist）', page.status === 200 && /anydrive-test/.test(html), `status=${page.status}`);

  const prof = await j('/api/profiles');
  check('⑤ 方案文件写在隔离的 USERPROFILE 下（没碰主人配置）',
    String(prof.body?.dir ?? '').toLowerCase().startsWith(fakeHome.toLowerCase()), `dir=${prof.body?.dir}`);

  child.kill();
  await sleep(800);
  rmTree(root);
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* 忽略 */ }
  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
}

main()
  .catch((e) => { console.error('ERR', e?.message || e); fails += 1; })
  .finally(() => { try { child?.kill(); } catch {} process.exit(fails === 0 ? 0 : 1); });
