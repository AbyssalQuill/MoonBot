// 验证「从本机复刻」的**本机打包**这半段（远端部分需要目标机，单独验）。
// 为什么值得单独测：这套包里混着"必须带"（桥代码/配置/记忆、DSH home 的 settings+凭据+preset+会话、
// NapCat 登录令牌）和"必须不带"（node_modules、桥的锁与日志、DSH profiles 里的 junction 目录）——
// 带错了会让目标机起不来或把本机几 GB 的东西传上去。
//
// 用法：node tools/test-local-clone-pack.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// 优先用活体运行时里的 deploy.js（依赖 ssh2 一定装好了）；退回源码树
const candidates = [
  'D:/MoonBot/resources/runtime/server/deploy.js',
  path.join(ROOT, 'server', 'deploy.js'),
];
let mod = null;
let usedFrom = '';
for (const c of candidates) {
  if (!fs.existsSync(c)) continue;
  try { mod = await import(pathToFileURL(c).href); usedFrom = c; break; } catch (e) { console.log(`(跳过 ${c}: ${e.message.split('\n')[0]})`); }
}
if (!mod) { console.error('找不到可用的 deploy.js'); process.exit(2); }

let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

// 本机三份数据的真实位置（与 index.js 的 localCloneSource() 同一套推导）
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.qq-bridge-manager', 'config.json'), 'utf8'));
const bridgeDir = 'D:\\MoonBot\\resources\\runtime\\qq-bridge';
const dshHome = String(cfg.instances?.dshIsolated?.isolatedHome || '');
const napcatCfgCandidates = [
  path.join(os.homedir(), 'Downloads', 'NapCat.Shell.Windows.Node', 'napcat', 'config'),
  path.join(os.homedir(), 'Downloads', 'runtime', 'NapCatQQ', 'config'),
];
const napcatConfigDir = napcatCfgCandidates.find((d) => fs.existsSync(d)) || null;

console.log(`deploy.js: ${usedFrom}`);
console.log(`bridgeDir=${fs.existsSync(bridgeDir)}  dshHome=${dshHome && fs.existsSync(dshHome)}  napcatConfig=${napcatConfigDir || '(未找到)'}`);

const task = { lines: [] };
const plan = mod.buildLocalStagePlan(task, {
  localPaths: { bridgeDir, dshHome, napcatConfigDir, memeDir: null },
  qqData: true,
});
check('计划里包含 bridge/dsh-home' + (napcatConfigDir ? '/napcat-config' : ''), plan.length >= (napcatConfigDir ? 3 : 2), plan.map((p) => p.name).join(','));

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbl-clone-'));
const results = [];
for (const item of plan) {
  const r = mod.packLocalStage(task, item, outDir);
  results.push({ item, r });
  check(`打包 ${item.name} 成功`, r.ok, r.ok ? `${(r.size / 1048576).toFixed(1)} MB` : r.error);
}

// 解出清单来判断"该带的带了、不该带的没带"
const list = (file) => {
  const r = spawnSync('tar', ['tzf', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // Windows 的 tar 输出是 CRLF —— 不按 \r 切，`$` 锚点永远匹配不上（第一次就栽在这）
  return { ok: r.status === 0, names: (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean) };
};
for (const { item, r } of results) {
  if (!r.ok) continue;
  const { ok, names } = list(r.path);
  check(`能列出 ${item.stage} 的内容`, ok);
  if (!ok) continue;
  const has = (re) => names.some((n) => re.test(n));
  const anyNodeModules = names.some((n) => /(^|\/)node_modules\//.test(n));
  if (item.name === 'bridge') {
    check('bridge 包含 src/bridge.js', has(/qq-bridge\/src\/bridge\.js$/));
    check('bridge 包含 config.json', has(/qq-bridge\/config\.json$/));
    check('bridge 包含 state/（记忆/画像数据）', has(/qq-bridge\/state\//));
    check('bridge 不含 node_modules', !anyNodeModules);
    check('bridge 不含 bridge.lock', !has(/bridge\.lock$/));
  }
  if (item.name === 'dsh-home') {
    check('dsh-home 包含 settings.yaml', has(/settings\.yaml$/));
    check('dsh-home 包含 .credentials.yaml（凭据随包过去）', has(/\.credentials\.yaml$/));
    check('dsh-home 包含 agent-presets', has(/agent-presets\//));
    check('dsh-home 不含 profiles/node_modules（junction 会被带坏）', !anyNodeModules);
  }
  if (item.name === 'napcat-config') {
    check('napcat-config 含登录令牌 napcat_*.json', has(/napcat_\d+\.json$/));
  }
}

try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* Windows 占用忽略 */ }
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
