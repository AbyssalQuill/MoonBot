/**
 * 「代码同步包不许带 config.json」回归测试。
 *
 * 为什么值得单独立一个测试（2026-09-19 的真实事故）：`/api/ssh/sync` 的代码包里，`packLocalBridge` 的排除表
 * 只排了 `config.json.bak-*`，**config.json 本体没排** —— 于是每次"同步代码"都会把本机那份配置覆盖到服务器上：
 * 远端 `napcat.accessToken` 061228 → truefriend（NapCat 回 retcode 1403，桥连上就被踢，282 条 code=1005）、
 * `dsh.baseUrl` 3080 → 10721（remote.mux 事件流连不上）、`napcat.dockerPathMap/tmpDir/homeDir` 与白名单一起丢。
 * 整台 QQ 哑火，而界面上每一步都显示 OK。
 *
 * 做法：把 `server/index.js` 复制进沙箱当运行目录（`RUNTIME_ROOT` 是按文件位置推导的），沙箱里造一个假的
 * `<沙箱>/qq-bridge`（config.json + src + state + node_modules + 各种 .bak），调真函数打一次包，然后 `tar -tzf`
 * 逐条断言"该有的有、不该有的没有"。
 *
 * 用法：node tools/test-bridge-pack-excludes-config.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SANDBOX = path.join(REPO, `.bridge-pack-test-${Date.now()}`);
const BRIDGE = path.join(SANDBOX, 'qq-bridge');

let fails = 0;
let steps = 0;
const check = (name, ok, extra = '') => {
  steps += 1;
  if (!ok) fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  · ' + extra : ''}`);
};

const w = (rel, text) => {
  const p = path.join(BRIDGE, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

fs.mkdirSync(path.join(SANDBOX, 'server'), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, 'home'), { recursive: true });
fs.cpSync(path.join(REPO, 'server'), path.join(SANDBOX, 'server'), { recursive: true });

// 假桥目录：该被排除的和该被打包的各来一份
w('config.json', JSON.stringify({ napcat: { accessToken: 'SERVER-ONLY-TOKEN' }, dsh: { baseUrl: 'http://127.0.0.1:3080' } }));
w('config.json.bak-sync', '{"napcat":{}}');
w('config.json.bak-20260919-000000', '{"napcat":{}}');
w('src/bridge.js', '// fake bridge entry\n');
w('tools/relayout-meme-pack.mjs', '// fake tool\n');
w('characters/demo/SKILL.md', '# demo character\n');
w('state/bridge.log', 'log line\n');
w('state/social.json', '{"x":1}');
w('state/stickers.json', '[]');
w('node_modules/pkg/index.js', '// dep\n');
w('bridge.lock', '12345\n');
w('qq-mode.log', 'log\n');
w('stickers-upload/a.webp', 'RIFF');

process.env.USERPROFILE = path.join(SANDBOX, 'home');
process.env.QBM_NO_LISTEN = '1';

let tarPath = '';
try {
  const mod = await import(`file:///${path.join(SANDBOX, 'server', 'index.js').replace(/\\/g, '/')}`);
  check('server/index.js 导出了 packLocalBridge', typeof mod.packLocalBridge === 'function');

  const hasTar = spawnSync('tar', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (hasTar.error) { console.error('系统 PATH 里没有 tar，无法测'); process.exit(2); }

  // includeState=false：代码同步那条路
  const packed = mod.packLocalBridge(false);
  check('打包成功', packed.ok === true, packed.error ?? '');
  tarPath = packed.path;

  const list = (p) => spawnSync('tar', ['-tzf', p], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }).stdout
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const names = list(tarPath);
  const has = (re) => names.some((n) => re.test(n));
  console.log(`包内条目 ${names.length} 条（示例：${names.slice(0, 6).join(', ')}）`);

  check('【核心】不含 config.json 本体', !names.includes('qq-bridge/config.json'), names.filter((n) => /config\.json$/.test(n)).join(',') || '（没有）');
  check('不含 config.json.bak-*', !has(/^qq-bridge\/config\.json\.bak-/));
  check('不含 node_modules', !has(/^qq-bridge\/node_modules\//));
  check('不含 state/（includeState=false）', !has(/^qq-bridge\/state\//));
  check('不含 bridge.lock', !has(/^qq-bridge\/bridge\.lock$/));
  check('不含 *.log', !has(/\.log$/));
  check('不含 stickers-upload/', !has(/^qq-bridge\/stickers-upload\//));

  check('含 src/bridge.js（代码确实打进去了）', names.includes('qq-bridge/src/bridge.js'));
  check('含 tools/relayout-meme-pack.mjs（上传接口要用）', names.includes('qq-bridge/tools/relayout-meme-pack.mjs'));
  check('含 characters/（出厂角色库随包走）', has(/^qq-bridge\/characters\//));

  // includeState=true：数据同步那条路仍然要带 state，但 config.json 依旧不许进
  const packed2 = mod.packLocalBridge(true);
  check('includeState=true 打包成功', packed2.ok === true, packed2.error ?? '');
  const names2 = list(packed2.path);
  check('includeState=true 时带上了 state/social.json', names2.includes('qq-bridge/state/social.json'));
  check('includeState=true 时仍不含 config.json', !names2.includes('qq-bridge/config.json'));
  check('includeState=true 时仍不含 state/bridge.log', !names2.includes('qq-bridge/state/bridge.log'));
  for (const p of [packed.path, packed2.path]) { try { fs.unlinkSync(p); } catch { /* 临时文件 */ } }
} finally {
  const base = path.basename(SANDBOX);
  if (base.startsWith('.bridge-pack-test-') && !/node_modules/i.test(SANDBOX)) {
    spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Remove-Item -LiteralPath ${JSON.stringify(SANDBOX)} -Recurse -Force`], { stdio: 'ignore' });
    console.log(`\n[cleanup] 沙箱已清理；仍存在=${fs.existsSync(SANDBOX)}`);
    check('沙箱清理干净', !fs.existsSync(SANDBOX));
  } else {
    console.log(`清理已跳过：${SANDBOX}`);
  }
  if (tarPath && fs.existsSync(tarPath)) { try { fs.unlinkSync(tarPath); } catch { /* ignore */ } }
}
console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}（${steps} 项检查）`);
process.exit(fails ? 1 : 0);
