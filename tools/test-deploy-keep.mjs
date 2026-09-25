// tools/test-deploy-keep.mjs —— 证明"SSH 部署不会吃掉目标机的能力"（2026-09-22：部署只换代码、不动目标机已配好的东西）。
//
// 背景：bridge 那个部署包是"整套"打的（代码 + config.json + state/）。老行为只把目标机的
// config.json / voice-config.json 备份一下就删库重解包，从不放回去 —— 于是"更新一次代码"会顺带
// 把目标机上配好的东西整片覆盖：pixiv cookie、语音 TTS key、白名单、用户调过的工具档位/打字节拍/
// 压缩阈值，以及 state/ 里的记忆库、画像、贴纸库。
//
// 本测试在临时目录里完整演一遍部署流程（打包 → 删库 → 解包 → 跑保护脚本），断言：
//   ① 新代码确实进去了（部署的本职）；
//   ② 目标机 config.json 里调过的键一个不丢（含嵌套与数组）；
//   ③ 新版本新增的键也进来了（不会因为"保配置"而少能力）；
//   ④ state/ 里的记忆库与 persona.md 还是目标机那一份；
//   ⑤ QQB_DEPLOY_WHOLE_CLONE=1 时完全不保护（老的"整套复刻"语义仍可用）。
//
// 用法：node tools/test-deploy-keep.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDeployKeepScript } from '../server/deploy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbm-deploy-keep-'));
let fails = 0;
const check = (name, fn) => {
  try { fn(); console.log('PASS  ' + name); }
  catch (e) { fails += 1; console.log('FAIL  ' + name + '  ' + (e?.message ?? e)); }
};
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8' });

/** 造一份"目标机（服务器）"的桥目录：配置里有用户调过的值，state 里有记忆库，persona 是当前角色 */
function makeTarget(dir) {
  const br = path.join(dir, 'qq-bridge');
  fs.mkdirSync(path.join(br, 'src', 'core'), { recursive: true });
  fs.mkdirSync(path.join(br, 'state'), { recursive: true });
  fs.writeFileSync(path.join(br, 'src', 'core', 'bridge-old.js'), '// 旧代码\n');
  fs.writeFileSync(path.join(br, 'config.json'), JSON.stringify({
    ownerQQ: '1122334455',
    allow: { groups: ['1073589775'], private: [] },
    pixiv: { base: 'https://x.pixigraph.xyz', cookie: 'PHPSESSID=server-side-login' },
    social: {
      slimTools: { enabled: true, level: 'low' },              // 目标机上用户调过的档位
      send: { linearPerCharMs: 150, linearCapMs: 4000 },        // 目标机上用户调过的节拍
      toolCompressor: { enabled: true, level: 'max', toonify: true },
    },
    dshCompaction: { thresholdRatio: 0.16, retainRatio: 0.02 },
  }, null, 2));
  fs.writeFileSync(path.join(br, 'persona.md'), '# 服务器上的当前角色\n群魅魔\n');
  fs.writeFileSync(path.join(br, 'state', 'memory.db'), 'SQLITE-MEMORY-OF-THE-SERVER\n');
  fs.writeFileSync(path.join(br, 'state', 'voice-config.json'), JSON.stringify({ enabled: true, defaultVoice: 'server-voice' }));
  fs.writeFileSync(path.join(br, 'state', 'tool-schema-stats.json'), JSON.stringify({ level: 'low' }));
  return br;
}

/** 造一份"源机（本机/新版本）"的桥目录：新代码 + 一份没有用户调过值的配置 + 源机自己的 state */
function makeSource(dir) {
  const br = path.join(dir, 'qq-bridge');
  fs.mkdirSync(path.join(br, 'src', 'core'), { recursive: true });
  fs.mkdirSync(path.join(br, 'state'), { recursive: true });
  fs.writeFileSync(path.join(br, 'src', 'core', 'bridge-new.js'), '// 新代码\n');
  fs.writeFileSync(path.join(br, 'config.json'), JSON.stringify({
    ownerQQ: '',                                    // 出厂/本机的空值 —— 覆盖过去就等于丢了机主身份
    allow: { groups: [], private: [] },
    pixiv: { base: 'https://x.pixigraph.xyz', cookie: '' },
    social: {
      slimTools: { enabled: false, level: 'off' },
      send: { linearPerCharMs: 650, linearCapMs: 15000 },   // 本机被自调慢过的那组值
    },
    dshCompaction: { thresholdRatio: 0.16, retainRatio: 0.02 },
    // ↓ 新版本新增的键（目标机老配置里没有）
    newFeature: { enabled: true, level: 'beta' },
  }, null, 2));
  fs.writeFileSync(path.join(br, 'persona.md'), '# 出厂角色\n（模板）\n');
  fs.writeFileSync(path.join(br, 'state', 'memory.db'), 'MEMORY-OF-THE-SOURCE\n');
  return br;
}

/** 演一遍部署：打包源机 → 目标机备份 → 删库 → 解包 → 跑保护脚本 */
function simulateDeploy({ wholeClone = false } = {}) {
  const work = fs.mkdtempSync(path.join(root, 'run-'));
  fs.mkdirSync(path.join(work, '.qqbridge-clone'), { recursive: true });
  const srcRoot = path.join(work, 'src');
  const dstRoot = path.join(work, 'dst');
  fs.mkdirSync(srcRoot, { recursive: true });
  fs.mkdirSync(dstRoot, { recursive: true });
  makeSource(srcRoot);
  makeTarget(dstRoot);

  // ① 打包（与 server/deploy.js 的 pack 命令同形）
  const tarFile = path.join(work, '.qqbridge-clone', 'qq-bridge.tar.gz');
  run('tar', ['czf', tarFile, '-C', srcRoot, '--exclude=qq-bridge/.git', '--exclude=qq-bridge/node_modules', 'qq-bridge']);

  // ② 目标机：备份 config / persona / state（与 deploy.js 的 dst 前段同形）
  const keep = path.join(work, 'qqbridge-keep-TS');
  const dstBridge = path.join(dstRoot, 'qq-bridge');
  fs.mkdirSync(keep, { recursive: true });
  for (const rel of ['config.json', 'persona.md']) {
    const p = path.join(dstBridge, rel);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(keep, path.basename(rel)));
  }
  fs.cpSync(path.join(dstBridge, 'state'), path.join(keep, 'state'), { recursive: true });

  // ③ 删库 + 解包（新代码进来）
  fs.rmSync(dstBridge, { recursive: true, force: true });
  run('tar', ['xzf', tarFile, '-C', dstRoot]);

  // ④ 跑部署收尾的保护脚本（与 manager 在目标机上跑的是同一份生成逻辑）
  const script = buildDeployKeepScript();
  const js = script.split("<<'KEEPEOF'\n")[1].split('\nKEEPEOF')[0];
  const jsFile = path.join(work, 'keep.js');
  fs.writeFileSync(jsFile, js, 'utf8');
  const env = { ...process.env, QQB_DEPLOY_WHOLE_CLONE: wholeClone ? '1' : '0' };
  // 脚本里写死 /root/qq-bridge；测试把 BR 指到沙盒：直接改一行常量
  const patched = js.replace("const BR = '/root/qq-bridge';", `const BR = ${JSON.stringify(dstBridge)};`);
  fs.writeFileSync(jsFile, patched, 'utf8');
  const out = execFileSync('node', [jsFile, keep], { encoding: 'utf8', env });
  return { dstBridge, out, keep };
}

console.log('=== ① 默认行为：部署=换代码，目标机的配置/记忆/角色必须原样留住 ===');
{
  const { dstBridge, out } = simulateDeploy();
  const cfg = JSON.parse(fs.readFileSync(path.join(dstBridge, 'config.json'), 'utf8'));
  check('新代码进去了（src/core/bridge-new.js 存在）', () => assert.ok(fs.existsSync(path.join(dstBridge, 'src', 'core', 'bridge-new.js'))));
  check('目标机的 ownerQQ 没被源机的空值覆盖', () => assert.equal(cfg.ownerQQ, '1122334455'));
  check('目标机的白名单还在', () => assert.deepEqual(cfg.allow.groups, ['1073589775']));
  check('目标机的 pixiv 登录 cookie 还在（源机是空的）', () => assert.equal(cfg.pixiv.cookie, 'PHPSESSID=server-side-login'));
  check('目标机的工具名单档位 low 还在（源机是 off）', () => assert.deepEqual(cfg.social.slimTools, { enabled: true, level: 'low' }));
  check('目标机的打字节拍 150/4000 还在（源机是被自调慢的 650/15000）', () => assert.deepEqual(cfg.social.send, { linearPerCharMs: 150, linearCapMs: 4000 }));
  check('目标机的压缩阈值 0.16 还在', () => assert.equal(cfg.dshCompaction.thresholdRatio, 0.16));
  check('新版本新增的键（newFeature）也进来了 —— 保配置不等于少能力', () => assert.deepEqual(cfg.newFeature, { enabled: true, level: 'beta' }));
  check('state/memory.db 还是目标机那一份（记忆没丢）', () => assert.match(fs.readFileSync(path.join(dstBridge, 'state', 'memory.db'), 'utf8'), /SERVER/));
  check('state/voice-config.json 还是目标机的（语音音色/key 不丢）', () => assert.equal(JSON.parse(fs.readFileSync(path.join(dstBridge, 'state', 'voice-config.json'), 'utf8')).defaultVoice, 'server-voice'));
  check('persona.md 还是目标机的角色', () => assert.match(fs.readFileSync(path.join(dstBridge, 'persona.md'), 'utf8'), /服务器上的当前角色/));
  check('输出里写明了保留/新增了哪些键（这一步可见）', () => assert.match(out, /config\.json：按目标机为准保留 \d+ 个键/));
}

console.log('\n=== ② 想回到老的"整套复刻"：QQB_DEPLOY_WHOLE_CLONE=1 时完全不保护 ===');
{
  const { dstBridge } = simulateDeploy({ wholeClone: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(dstBridge, 'config.json'), 'utf8'));
  check('整套复刻时配置确实以源机为准（ownerQQ 为空 = 源机那份）', () => assert.equal(cfg.ownerQQ, ''));
  check('整套复刻时 state 也是源机的', () => assert.match(fs.readFileSync(path.join(dstBridge, 'state', 'memory.db'), 'utf8'), /SOURCE/));
}

fs.rmSync(root, { recursive: true, force: true });
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
