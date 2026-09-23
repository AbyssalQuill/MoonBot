/**
 * 「重启远端桥」不许再退回"看着像成功其实没重启"的形状 —— 源码级门禁。
 *
 * 背景（2026-09-19 真机事故，同一类写法在三处）：重启桥原本是内联一条
 *   `cd /root/qq-bridge && nohup bash start-bridge.sh …& sleep 3; pgrep -f 'node src/bridge[.]js' && echo bridge-up || echo bridge-down`
 * ① `start-bridge.sh` 不杀旧桥 → 旧桥继续占着 3100，新实例报 `listen EADDRINUSE` 自己退出；
 * ② 判据只看"有没有桥进程"—— 旧桥正好命中 → 永远回 `bridge-up`、界面显示"重启成功"，
 *    新同步上去的代码一行都没生效（实测：服务器 pid 两次同步都没变）。
 * 内联 `pkill` 也救不了：命令要穿过「JS 字符串 → ssh → 远端 shell」几层解析，单引号一被吃掉就变成
 * `pkill -f node src/bridge[.]js`（参数错、一个都没杀）——实测同样报 bridge-up 而 pid 没变。
 * 所以真正逻辑搬进了随代码包同步过去的脚本 `qq-bridge/tools/restart-bridge.sh`，本门禁守住三件事：
 *   ① 脚本在、且它确实"先停旧桥"并回报 `pid= / old=`（有这两个数才看得出换了进程）；
 *   ② server/index.js 里**没有任何**内联 start-bridge.sh 的重启（一律走 remoteRestartBridge）；
 *   ③ server/deploy.js 的克隆路径也优先走脚本。
 *
 * 用法：node tools/check-remote-restart-uses-script.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SCRIPT = path.join(REPO, 'qq-bridge', 'tools', 'restart-bridge.sh');
const INDEX = path.join(REPO, 'server', 'index.js');
const DEPLOY = path.join(REPO, 'server', 'deploy.js');

let fails = 0;
let steps = 0;
const check = (name, ok, extra = '') => {
  steps += 1;
  if (!ok) fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  · ' + extra : ''}`);
};

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

const script = read(SCRIPT);
check('restart-bridge.sh 在仓库里', !!script);
check('脚本先停旧桥（有 pkill）', /pkill\s+-f/.test(script));
check('脚本会等旧桥退出（有等待循环）', /while\s*\[/.test(script) && /sleep\s+1/.test(script));
check('脚本超时会 -9（不会卡住同步）', /pkill\s+-9/.test(script));
check('脚本回报 pid= 与 old=（看得出真的换了进程）', /bridge-up pid=\$NEW old=/.test(script));
check('脚本回报 NapCat 连接数（新代码在跑的证据）', /napcat-conn=/.test(script));

const index = read(INDEX);
const calls = (index.match(/await remoteRestartBridge\(conn\)/g) || []).length;
check('server/index.js 定义了 remoteRestartBridge', /async function remoteRestartBridge\(conn\)/.test(index));
check('两条重启路都走 remoteRestartBridge（≥2 处调用）', calls >= 2, `调用 ${calls} 处`);
check('server/index.js 里不再有内联 start-bridge.sh 的重启',
  !/sshExecCapture\(conn,\s*"[^"]*start-bridge\.sh/.test(index),
  (index.match(/sshExecCapture\(conn,\s*"[^"]*start-bridge\.sh[^"]*"/) || ['(没有)'])[0].slice(0, 80));
check('remoteRestartBridge 里没有脚本时会明确报错（不是静默成功）',
  /restart-script-missing/.test(index) && /ok: false/.test(index));

const deploy = read(DEPLOY);
/* 【2026-09-23 加严】原来这里只判"deploy.js 里出现过 restart-bridge.sh 这个字符串"——
 * 于是**旧写法还在文件里也照样 PASS**：事实上 deploy.js 的克隆路径 1397 行就退回了
 * 「内联 nohup bash start-bridge.sh + pgrep 判据」的老形状（不杀旧桥、判据命中旧进程 →
 * 永远 bridge-up）。现在按 index.js 那两条同等的力度断言，并额外守住两件本次修掉的事：
 * 部署后必须显式重启 dsh-web（enable --now 对已 active 的 unit 是空操作）、
 * 重启桥必须以 old=/pid= 的比对为准（不是"有进程就算成功"）。 */
check('server/deploy.js 不留内联 start-bridge.sh 的旧写法（不杀旧桥 + 只看 pgrep）',
  !/pgrep -f 'node src\/bridge\.js' >\/dev\/null && echo bridge-up/.test(deploy)
  && !/nohup bash start-bridge\.sh[^\n]*\n[^\n]*pgrep -f 'node src\/bridge\.js' >\/dev\/null/.test(deploy));
check('server/deploy.js 的重启桥会回报 old=/pid=（看得出真的换了进程）',
  /old=\$OLD/.test(deploy) && /bridge-up pid=\$NEW old=\$OLD/.test(deploy));
check('server/deploy.js 部署后会显式 restart dsh-web（enable --now 对已在跑的 unit 是空操作）',
  /systemctl restart dsh-web/.test(deploy));

// 反面样本：确认这把门禁真的会抓到旧写法（自己测自己）
const WEAK = 'await sshExecCapture(conn, "cd /root/qq-bridge && nohup bash start-bridge.sh </dev/null >/dev/null 2>&1 & sleep 3; pgrep -f \'node src/bridge[.]js\' >/dev/null && echo bridge-up || echo bridge-down", 30000);';
check('门禁自测：旧写法会被抓出来', /sshExecCapture\(conn,\s*"[^"]*start-bridge\.sh/.test(WEAK));

console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}（${steps} 项检查）`);
process.exit(fails ? 1 : 0);
