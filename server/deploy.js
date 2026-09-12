/* ==========================================================================
 * 一键克隆部署：把「模板服务器」整套(DSH + NapCat 登录态 + 桥 + 全部数据)
 * 克隆到「目标服务器」(期望全新裸 Ubuntu)。
 *
 * 流程(每步写日志, GUI 轮询 /api/ssh/deploy/status)：
 *  0. 校验源/目标都在服务器列表, 连两端
 *  1. 目标机基础环境探测与安装: nodejs/npm/docker/python3 + 全局 dsh + mcp-compressor
 *  2. 源机短暂停机(停 dsh-web / napcat / bridge) → 本地打包成 tar.gz(stage)
 *  3. 源机立即恢复运行(总停机 ≈ 打包耗时, 与传输带宽无关)
 *  4. 逐包经 manager 流式转发到目标机并原地解包(不落目标机中间文件)
 *  5. 目标机: 写 systemd 服务 / 建 napcat 容器与卷 / 灌 QQ 登录态 / 启动自检
 *  6. 清理源机 stage, 断开连接
 *
 * 安全说明: 全程只在 manager→各机之间走 ssh2; 目标机不持有源机凭据;
 *           密钥/令牌原样随 .dsh 与配置目录迁移(与整盘克隆语义一致)。
 * ========================================================================== */
import { Client } from 'ssh2';
import crypto from 'crypto';
import { readFileSync, statSync, mkdirSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, basename, join } from 'path';
import os from 'os';

/* ---------------- 任务注册表 ---------------- */
const deployTasks = new Map(); // taskId -> { lines:[], status, updatedAt }

function taskLine(task, text) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  task.lines.push(`[${ts}] ${text}`);
  if (task.lines.length > 800) task.lines.splice(0, task.lines.length - 800);
  task.updatedAt = Date.now();
}

/* ---------------- 连接 / 执行工具(与 index.js 同款实现) ---------------- */
function connectOne(server) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => { try { conn.end(); } catch {} reject(new Error('连接超时')); }, 20000);
    conn.on('ready', () => { clearTimeout(timer); resolve(conn); });
    conn.on('error', (err) => { clearTimeout(timer); reject(err); });
    conn.connect({
      host: server.host, port: server.port || 22, username: server.username,
      password: server.authType === 'password' ? server.password : undefined,
      privateKey: server.authType === 'key' && server.privateKey ? readFileSyncSafe(server.privateKey) : undefined,
      passphrase: server.passphrase || undefined,
      readyTimeout: 15000, keepaliveInterval: 30000,
    });
  });
}

function readFileSyncSafe(p) {
  try { return readFileSync(p); } catch { return undefined; }
}

/** 单条远程命令, 捕获输出; 超时只断流不杀连接。 */
function runCmd(conn, command, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let streamRef = null;
    const timer = setTimeout(() => {
      try { streamRef?.close?.(); } catch {}
      resolve({ ok: false, out: '', err: 'SSH 命令超时' });
    }, timeoutMs);
    conn.exec(command, (err, stream) => {
      if (err) { clearTimeout(timer); resolve({ ok: false, out: '', err: err.message }); return; }
      streamRef = stream;
      let out = '', errOut = '';
      stream.on('data', (d) => (out += d.toString()));
      stream.stderr.on('data', (d) => (errOut += d.toString()));
      stream.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? { ok: true, out: out.trim(), err: '' } : { ok: false, out: out.trim(), err: errOut.trim() || `远程命令 exit ${code}` });
      });
    });
  });
}

/**
 * 把源机一个文件流式转发到目标机, 目标端从 stdin 直接解包:
 *   srcCmd     在源机执行(例: cat /root/.stage/x.tar.gz)
 *   dstCmd     在目标机执行, 期望从 stdin 读(例: mkdir -p /root && tar xzf - -C /root)
 * 两端同时收集 stderr; 任一端失败即 reject。
 */
function streamPipe(srcConn, srcCmd, dstConn, dstCmd, timeoutMs = 1800000) {
  return new Promise((resolve, reject) => {
    let srcErr = '', dstErr = '';
    let srcClosed = false, dstClosed = false;
    let dstStreamRef = null;
    const timer = setTimeout(() => {
      try { dstStreamRef?.close?.(); } catch {}
      reject(new Error('流式传输超时'));
    }, timeoutMs);

    const maybeFinish = (ok, msg) => {
      if (ok) {
        if (srcClosed && dstClosed) { clearTimeout(timer); resolve(); }
      } else {
        clearTimeout(timer);
        reject(new Error(msg || `${srcErr || dstErr || '传输失败'}`.trim()));
      }
    };

    dstConn.exec(dstCmd, (errD, dstStream) => {
      if (errD) { clearTimeout(timer); reject(errD); return; }
      dstStreamRef = dstStream;
      dstStream.stderr.on('data', (d) => (dstErr += d.toString()));
      dstStream.on('close', (code) => {
        if (code !== 0) { maybeFinish(false, dstErr.trim() || `目标端 exit ${code}`); return; }
        dstClosed = true;
        maybeFinish(true);
      });
      srcConn.exec(srcCmd, (errS, srcStream) => {
        if (errS) { clearTimeout(timer); reject(errS); return; }
        srcStream.stderr.on('data', (d) => (srcErr += d.toString()));
        srcStream.on('close', (code) => {
          if (code !== 0) { maybeFinish(false, srcErr.trim() || `源端 exit ${code}`); return; }
          srcClosed = true;
          try { dstStream.stdin.end(); } catch {}
          maybeFinish(true);
        });
        srcStream.pipe(dstStream.stdin, { end: true });
      });
    });
  });
}

/* ---------------- 目标机环境自愈（2026-09-12） --------------------------------
 * 主人实测反馈：目标机上没有 npm 时，部署**直接失败并把安装留给他**。原有实现有两个硬伤：
 *   ① 整段环境安装被 `if (needNode || needDocker)` 包着 —— node 已是 22 但缺 npm 时，
 *      这一整段根本不跑，后面 `npm install` 必然 command-not-found；
 *   ② 每一步都是"一次机会 + 失败就 throw"，apt 慢/源不通/网络抖动都会让整场部署中止。
 * 现在改成「探测 → 缺什么装什么 → 装完复核 → 还不行就换下一种装法」：
 *   node  : nodesource 22 → apt nodejs → **nodejs.org 官方 tarball 解到 /usr/local**（不依赖 apt/npm）
 *   npm   : 随 official tarball 自带；否则 apt npm；再否则 tarball 里的 npm 做软链
 *   docker: apt docker.io → get.docker.com 脚本 → 兜底 dockerd 后台拉起
 *   python3/pip: apt python3-pip → python3 -m ensurepip
 *   基础工具(curl/ca-certificates/gnupg/tar/gzip/xz-utils): apt（本来就有则跳过）
 * 全程只写日志；只有"所有装法都试过仍缺 node/npm 或 docker"才报错（那种情况确实没法继续）。
 */

/** 一次性探清目标机环境（每项一行，便于日志核对） */
export async function probeTargetEnv(conn) {
  const r = await runCmd(conn, [
    'echo "ARCH=$(uname -m)"',
    '. /etc/os-release 2>/dev/null && echo "OS=$PRETTY_NAME"',
    'echo "NODE=$(node -v 2>/dev/null || echo none)"',
    'echo "NPM=$(npm -v 2>/dev/null || echo none)"',
    'echo "DOCKER=$(docker -v 2>/dev/null || echo none)"',
    'echo "DOCKERD=$(systemctl is-active docker 2>/dev/null || service docker status >/dev/null 2>&1 && echo active || echo none)"',
    'echo "PY=$(python3 -V 2>&1 || echo none)"',
    'echo "PIP=$(pip3 -V 2>/dev/null || (python3 -m pip -V 2>/dev/null) || echo none)"',
    'echo "CURL=$(command -v curl || echo none)"',
    'echo "TAR=$(command -v tar || echo none)"',
    'echo "GZ=$(command -v gzip || echo none)"',
    'echo "XZ=$(command -v xz || echo none)"',
    'echo "GPG=$(command -v gpg || echo none)"',
    'echo "CA=$([ -f /etc/ssl/certs/ca-certificates.crt ] && echo yes || echo none)"',
    'echo "DSH=$(dsh --version 2>/dev/null | head -1 || echo none)"',
  ].join('; '), 45000);
  const get = (k) => {
    const m = new RegExp(`^${k}=(.*)$`, 'm').exec(r.out || '');
    return m ? m[1].trim() : 'none';
  };
  return {
    raw: r.out || r.err || '',
    arch: get('ARCH'), os: get('OS'),
    node: get('NODE'), npm: get('NPM'),
    docker: get('DOCKER'), dockerd: get('DOCKERD'),
    py: get('PY'), pip: get('PIP'),
    curl: get('CURL'), tar: get('TAR'), gz: get('GZ'),
    xz: get('XZ'), gpg: get('GPG'), ca: get('CA'), dsh: get('DSH'),
  };
}

const nodeMajor = (v) => {
  const m = /v?(\d+)\./.exec(String(v || ''));
  return m ? Number(m[1]) : 0;
};

/** apt 装包：多源重试 + --fix-missing + dpkg 修复；返回是否"命令没报 fatal"，成败以复核为准 */
async function aptInstall(conn, task, pkgs, timeoutMs = 900000) {
  if (!pkgs.length) return true;
  const list = pkgs.join(' ');
  const script = [
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -qq 2>&1 | tail -2 || apt-get update -qq --allow-releaseinfo-change 2>&1 | tail -2 || true',
    'dpkg --configure -a >/dev/null 2>&1 || true',
    `apt-get install -y -qq --fix-missing ${list} 2>&1 | tail -3 || apt-get install -y ${list} 2>&1 | tail -3 || true`,
  ].join('; ');
  const r = await runCmd(conn, script, timeoutMs);
  taskLine(task, `  apt(${list}) → ${r.ok ? '命令已执行' : '命令未干净退出，继续尝试别的装法'}`);
  return r.ok;
}

/** 备用装法：直接下 nodejs.org 官方 tarball（自带 node+npm+npx，完全不依赖 apt/npm） */
async function installNodeViaTarball(conn, task) {
  const script = [
    'set -e',
    'ARCH=$(uname -m)',
    'case "$ARCH" in aarch64|arm64) A=arm64;; *) A=x64;; esac',
    'mkdir -p /tmp/nodejs-dl /usr/local/lib/nodejs',
    'OK=0',
    'for V in 22.11.0 22.5.1 20.18.0 18.20.4; do',
    '  if curl -fsSL --connect-timeout 20 -o /tmp/nodejs-dl/node.tar.xz "https://nodejs.org/dist/v$V/node-v$V-linux-$A.tar.xz"; then OK=1; break; fi',
    'done',
    'test "$OK" = 1',
    'rm -rf /usr/local/lib/nodejs/*',
    'tar -xJf /tmp/nodejs-dl/node.tar.xz -C /usr/local/lib/nodejs --strip-components=1 || tar -xf /tmp/nodejs-dl/node.tar.xz -C /usr/local/lib/nodejs --strip-components=1',
    'for B in node npm npx corepack; do',
    '  if [ -x "/usr/local/lib/nodejs/bin/$B" ]; then ln -sf "/usr/local/lib/nodejs/bin/$B" "/usr/local/bin/$B"; fi',
    'done',
    'echo TARBALL_DONE',
  ].join('\n');
  const r = await runCmd(conn, script, 900000);
  const ok = (r.out || '').includes('TARBALL_DONE');
  taskLine(task, `  官方 tarball 安装 node/npm → ${ok ? '完成' : '未完成'}`);
  return ok;
}

/** node + npm：多装法直到两者都可用（npm 随 tarball 自带） */
async function ensureNodeAndNpm(conn, task) {
  let env = await probeTargetEnv(conn);
  const usable = () => nodeMajor(env.node) >= 20 && env.npm !== 'none';
  if (usable()) { taskLine(task, `  node/npm 已就绪：${env.node} / npm ${env.npm}`); return env; }

  if (env.node === 'none' || nodeMajor(env.node) < 20 || env.npm === 'none') {
    taskLine(task, `  node/npm 不满足（node=${env.node} npm=${env.npm}）→ 开始自动安装`);
    // 装法①：nodesource 官方源（apt 装 nodejs 22，npm 自带）
    await aptInstall(conn, task, ['curl', 'ca-certificates', 'gnupg']);
    const ns = await runCmd(conn, 'curl -fsSL --connect-timeout 20 https://deb.nodesource.com/setup_22.x | bash - 2>&1 | tail -3; apt-get install -y -qq nodejs 2>&1 | tail -3 || true; echo NS_DONE', 900000);
    taskLine(task, `  nodesource 安装 → ${(ns.out || '').includes('NS_DONE') ? '命令已执行' : '未完成'}`);
    env = await probeTargetEnv(conn);
    if (usable()) { taskLine(task, `  node/npm 装好了：${env.node} / npm ${env.npm}`); return env; }

    // 装法②：官方 tarball（不依赖 apt 与 npm，最稳的兜底）
    await installNodeViaTarball(conn, task);
    env = await probeTargetEnv(conn);
    if (usable()) { taskLine(task, `  node/npm 装好了（tarball）：${env.node} / npm ${env.npm}`); return env; }

    // 装法③：发行版自带包（版本可能偏旧，能用就行）
    await aptInstall(conn, task, ['nodejs', 'npm']);
    env = await probeTargetEnv(conn);
    if (usable()) { taskLine(task, `  node/npm 装好了（发行版包）：${env.node} / npm ${env.npm}`); return env; }
  }
  return env;
}

/** docker：apt → get.docker.com → 直接后台拉起 dockerd */
async function ensureDocker(conn, task) {
  let env = await probeTargetEnv(conn);
  if (env.docker === 'none') {
    taskLine(task, '  未检测到 docker → 自动安装');
    await aptInstall(conn, task, ['docker.io']);
    env = await probeTargetEnv(conn);
    if (env.docker === 'none') {
      const s = await runCmd(conn, 'curl -fsSL --connect-timeout 20 https://get.docker.com | sh 2>&1 | tail -3; echo GD_DONE', 1200000);
      taskLine(task, `  get.docker.com 安装 → ${(s.out || '').includes('GD_DONE') ? '命令已执行' : '未完成'}`);
      env = await probeTargetEnv(conn);
    }
  }
  // 二进制在但守护进程没起（容器化的 Ubuntu 常见）→ 拉起它
  if (env.docker !== 'none') {
    const st = await runCmd(conn, 'systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || (nohup dockerd >/var/log/dockerd.log 2>&1 & sleep 3); docker info >/dev/null 2>&1 && echo DOCKER_UP || echo DOCKER_DOWN', 120000);
    const up = (st.out || '').includes('DOCKER_UP');
    taskLine(task, `  docker 守护进程 → ${up ? '运行中' : '未起来（拉镜像时可能失败，会继续尝试）'}`);
  }
  return env;
}

/** 目标机环境总入口：探测 → 补缺 → 复核 → 打印结果表（绝不因单项失败中止部署） */
export async function ensureTargetEnv(conn, task) {
  let env = await probeTargetEnv(conn);
  taskLine(task, `目标机探测:\n${env.raw}`);

  // 1) 基础工具（tar/gzip 是解包必需；curl/ca-certificates 是后续所有下载的前提）
  //    只装**确实缺的**：都齐了就不碰 apt（避免每次都跑一次 apt-get update）
  const missingBase = [];
  if (env.curl === 'none') missingBase.push('curl');
  if (env.tar === 'none') missingBase.push('tar');
  if (env.gz === 'none') missingBase.push('gzip');
  if (env.xz === 'none') missingBase.push('xz-utils');
  if (env.gpg === 'none') missingBase.push('gnupg');
  if (env.ca === 'none') missingBase.push('ca-certificates');
  if (missingBase.length) {
    taskLine(task, `  基础工具缺失：${missingBase.join(', ')} → 自动安装`);
    await aptInstall(conn, task, missingBase);
  } else {
    taskLine(task, '  基础工具齐全（curl/tar/gzip/xz/gpg/ca-certificates）');
  }

  // 2) node + npm（硬需求）
  env = await ensureNodeAndNpm(conn, task);

  // 3) docker（硬需求：NapCat 跑在容器里）
  env = await ensureDocker(conn, task);

  // 4) python3 + pip（只有 mcp-compressor 需要，缺了只警告）
  if (env.pip === 'none') {
    await aptInstall(conn, task, ['python3', 'python3-pip']);
    env = await probeTargetEnv(conn);
    if (env.pip === 'none') {
      const ep = await runCmd(conn, 'python3 -m ensurepip --upgrade 2>&1 | tail -2; python3 -m pip -V 2>/dev/null || pip3 -V 2>/dev/null || echo NO_PIP', 300000);
      taskLine(task, `  pip 兜底(ensurepip) → ${/pip \d/.test(ep.out || '') ? '可用' : '仍不可用（mcp-compressor 会跳过，不影响主流程）'}`);
      env = await probeTargetEnv(conn);
    }
  }

  env = await probeTargetEnv(conn);
  taskLine(task, [
    '  环境复核:',
    `    node   : ${env.node}`,
    `    npm    : ${env.npm}`,
    `    docker : ${env.docker}（守护进程 ${env.dockerd}）`,
    `    python3: ${env.py}${env.pip !== 'none' ? ' + pip' : '（无 pip）'}`,
    `    curl   : ${env.curl} · tar: ${env.tar} · gzip: ${env.gz}`,
  ].join('\n'));

  const nodeOk = nodeMajor(env.node) >= 20;
  const npmOk = env.npm !== 'none';
  const dockerOk = env.docker !== 'none';
  if (!nodeOk || !npmOk) {
    taskLine(task, `  ⚠ node/npm 仍然不可用（node=${env.node} npm=${env.npm}）；已依次尝试 nodesource / 官方 tarball / 发行版包`);
  }
  if (!dockerOk) taskLine(task, '  ⚠ docker 仍不可用；已尝试 docker.io / get.docker.com（NapCat 容器将无法启动）');
  return { env, nodeOk, npmOk, dockerOk };
}

/* ---------------- 需要从源机带走的目录清单 ---------------- */
// stage 文件相对源机 /root/.qqbridge-clone/
function buildStagePlan(task, src, opts) {
  const plan = [];
  // 1. 桥(代码+config+state 记忆/画像数据; 排除 .git 与锁/日志/node_modules——原生模块 sharp 需目标机重新 npm install)
  plan.push({
    name: 'bridge',
    stage: 'qq-bridge.tar.gz',
    pack: `tar czf /root/.qqbridge-clone/qq-bridge.tar.gz -C /root --exclude='qq-bridge/.git' --exclude='qq-bridge/node_modules' --exclude='qq-bridge/state/bridge.lock' --exclude='qq-bridge/state/bridge*.log' qq-bridge`,
    dst: 'set -e; rm -rf /root/qq-bridge && mkdir -p /root && tar xzf - -C /root',
    restart: '', // bridge 单独管理
  });
  // 2. DSH 主目录(DSH_HOME 全部: settings/credentials/agent-presets/profiles/sessions/storages/meme-packs)
  plan.push({
    name: 'dsh-home',
    stage: 'dsh-home.tar.gz',
    pack: `tar czf /root/.qqbridge-clone/dsh-home.tar.gz -C /root/.dsh .`,
    dst: 'rm -rf /root/.dsh && mkdir -p /root/.dsh && tar xzf - -C /root/.dsh',
    restart: '',
  });
  // 3. NapCat 配置目录(bind 挂载 /root/napcat/config)
  plan.push({
    name: 'napcat-config',
    stage: 'napcat-config.tar.gz',
    pack: `tar czf /root/.qqbridge-clone/napcat-config.tar.gz -C /root/napcat config`,
    dst: 'rm -rf /root/napcat/config && mkdir -p /root/napcat && tar xzf - -C /root/napcat',
    restart: '',
  });
  // 4. QQ 登录态(容器卷 /app/.config/QQ → 直接 tar 卷目录, 不在源机产生第二份副本; 可选, 大)
  //    此包在目标机建好容器卷之后才解入(见主流程)
  if (opts.qqData !== false) {
    plan.push({
      name: 'qq-login-data',
      stage: 'qqdata.tar.gz',
      pack: `VOL=$(docker inspect napcat --format '{{range .Mounts}}{{if eq .Destination "/app/.config/QQ"}}{{.Source}}{{end}}{{end}}'); test -n "$VOL" && tar czf /root/.qqbridge-clone/qqdata.tar.gz -C "$VOL" .`,
      dst: `V=$(docker volume inspect napcat-qq --format '{{.Mountpoint}}'); test -n "$V" && tar xzf - -C "$V"`,
      restart: '',
      afterContainer: true,
    });
  }
  // 5. dsh-polyfill(反向代理脚本)
  plan.push({
    name: 'dsh-polyfill',
    stage: 'dsh-polyfill.tar.gz',
    pack: `tar czf /root/.qqbridge-clone/dsh-polyfill.tar.gz -C /root dsh-polyfill`,
    dst: 'rm -rf /root/dsh-polyfill && mkdir -p /root && tar xzf - -C /root',
    restart: '',
  });
  // 6. dsh-meme 插件目录(可选, 存在才带)
  plan.push({
    name: 'dsh-meme',
    stage: 'dsh-meme.tar.gz',
    pack: `[ -d /root/dsh-meme ] && tar czf /root/.qqbridge-clone/dsh-meme.tar.gz -C /root dsh-meme || true`,
    dst: 'rm -rf /root/dsh-meme && mkdir -p /root && tar xzf - -C /root || true',
    restart: '',
    optional: true,
  });
  return plan;
}

/* ---------------- 主执行 ---------------- */
/* ---------------- 本机作为源（"从本机复刻"） ----------------
 * 需求（2026-09-12 主人）：克隆整套不再必须"两台服务器"，直接拿**本机当前运行中的这套**做模板。
 *
 * 与"模板服务器→目标"的差别只有三处，其余远端步骤完全复用：
 *   ① 打包在本机做（Windows 上的 tar = bsdtar），不再连源服务器、也不需要源机停机；
 *   ② 传输走"本机文件 → 远端 stdin"，而不是"源机 → 本机 → 目标机"两段中转；
 *   ③ 源机特有的 systemd unit / .bashrc 环境变量，本机没有 → 在目标机**生成** unit，
 *      凭据则靠随包带过去的 .credentials.yaml（DSH 自己读，绝不猜着导出成环境变量，导错就把 key 写坏了）。
 *
 * 说明：Windows 的 QQ 客户端数据目录（NTQQ 本体数据）与 Linux 不通用，所以本机复刻**不带**容器卷那份
 * qqdata；真正可移植的是 NapCat 的登录令牌文件 napcat_<qq>.json（在 napcat/config 里），
 * 它随 napcat-config 包一起过去，目标机通常可以免扫码快速登录（不行就扫一次）。
 */
export function buildLocalStagePlan(task, opts = {}) {  const p = opts.localPaths ?? {};
  const plan = [];
  const stageDir = opts.stageDir || '/root/.qqbridge-clone';
  if (p.bridgeDir) {
    plan.push({
      name: 'bridge',
      stage: 'qq-bridge.tar.gz',
      cwd: dirname(p.bridgeDir),
      members: [basename(p.bridgeDir)],
      excludes: [
        `${basename(p.bridgeDir)}/node_modules`,
        `${basename(p.bridgeDir)}/.git`,
        // 运行期状态：锁/日志/临时合并目录不带（记忆与画像数据要带，那是"整套"的一部分）
        `${basename(p.bridgeDir)}/state/bridge.lock`,
        `${basename(p.bridgeDir)}/state/*.log`,
        `${basename(p.bridgeDir)}/state/agents/*/node_modules`,
        `${basename(p.bridgeDir)}/tests`,
      ],
      dstFile: `set -e; rm -rf /root/${basename(p.bridgeDir)} && mkdir -p /root && tar xzf ${stageDir}/qq-bridge.tar.gz -C /root`,
    });
  }
  if (p.dshHome) {
    plan.push({
      name: 'dsh-home',
      stage: 'dsh-home.tar.gz',
      cwd: p.dshHome,
      members: ['.'],
      excludes: ['./profiles/node_modules', './profiles/*/node_modules', './.git', './logs'],
      dstFile: `rm -rf /root/.dsh && mkdir -p /root/.dsh && tar xzf ${stageDir}/dsh-home.tar.gz -C /root/.dsh`,
    });
  }
  if (p.napcatConfigDir && opts.qqData !== false) {
    plan.push({
      name: 'napcat-config',
      stage: 'napcat-config.tar.gz',
      cwd: dirname(p.napcatConfigDir),
      members: [basename(p.napcatConfigDir)],
      excludes: [`${basename(p.napcatConfigDir)}/cache`, `${basename(p.napcatConfigDir)}/*.log`],
      dstFile: `rm -rf /root/napcat/config && mkdir -p /root/napcat && tar xzf ${stageDir}/napcat-config.tar.gz -C /root/napcat`,
    });
  }
  if (p.memeDir) {
    plan.push({
      name: 'dsh-meme',
      stage: 'dsh-meme.tar.gz',
      cwd: dirname(p.memeDir),
      members: [basename(p.memeDir)],
      excludes: [],
      dstFile: `rm -rf /root/dsh-meme && mkdir -p /root && (tar xzf ${stageDir}/dsh-meme.tar.gz -C /root || true)`,
      optional: true,
    });
  }
  return plan;
}

/** 在本机打一个 stage 包（Windows 的 tar 就是 bsdtar，支持 --exclude 与 -C）。 */
export function packLocalStage(task, item, outDir) {
  const out = join(outDir, item.stage);
  const args = ['czf', out, ...(item.excludes || []).map((e) => `--exclude=${e}`), '-C', item.cwd, ...item.members];
  const r = spawnSync('tar', args, { encoding: 'utf8', timeout: 900000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: false, error: String(r.stderr || '').trim().slice(0, 300) || `tar exit ${r.status}` };
  let size = 0;
  try { size = statSync(out).size; } catch { /* ignore */ }
  taskLine(task, `  已打包 ${item.name}: ${(size / 1048576).toFixed(1)} MB`);
  return { ok: true, path: out, size };
}

/**
 * 连接目标机：先按填的端口，不通且配置里记着"上次成功的端口"时再用那个端口试一次。
 * （同一台 IP 上可能挂着多个 sshd —— 2026-09-12 实测 22 与 50470 就是两台，
 *   填错端口的表现和"密码错"一模一样，这条兜底能让用户少踩一次。）
 */
async function connectWithFallback(server, task = null) {
  const ports = [server.port || 22];
  if (server.lastGoodPort && Number(server.lastGoodPort) !== Number(ports[0])) ports.push(server.lastGoodPort);
  let lastErr = null;
  for (const port of ports) {
    try {
      const conn = await connectOne({ ...server, port });
      if (Number(port) !== Number(ports[0]) && task) taskLine(task, `  （端口 ${ports[0]} 连不上，已自动改用上次成功的 ${port}）`);
      return conn;
    } catch (e) {
      lastErr = e;
      if (task) taskLine(task, `  端口 ${port} 连接失败：${e?.message || e}`);
    }
  }
  throw lastErr || new Error('连接失败');
}

export async function runDeploy(taskId, source, target, opts = {}) {
  const task = deployTasks.get(taskId);
  if (!task) return;
  const stageDir = '/root/.qqbridge-clone';
  const isLocal = opts.localSource === true || source?.local === true;
  const plan = isLocal ? buildLocalStagePlan(task, opts) : buildStagePlan(task, source, opts);
  let srcConn = null;
  let dstConn = null;
  // ⚠️ 必须声明在 try **之外**：catch/finally 里要用它清理本机临时目录。
  // 之前声明在 try 里面，catch 引用它就抛 ReferenceError —— 而这层 catch 之外的异常会变成
  // unhandledRejection 把**整个管理器进程**带崩（2026-09-12 dry-run 实测：部署一失败，管理器就没了）。
  let localStageDir = null;

  const step = async (label, fn) => {
    taskLine(task, `—— ${label}`);
    const t0 = Date.now();
    try {
      await fn();
      taskLine(task, `  ✓ ${label} (${Math.round((Date.now() - t0) / 1000)}s)`);
    } catch (e) {
      taskLine(task, `  ✗ ${label}: ${e?.message || e}`);
      throw e;
    }
  };

  const safely = async (label, fn) => {
    try { await step(label, fn); } catch (e) { taskLine(task, `  (跳过) ${label}: ${e?.message || e}`); }
  };

  try {
    taskLine(task, `===== 开始克隆部署 =====`);
    taskLine(task, isLocal
      ? `源(本机): ${source?.name || '本机（这台电脑）'} —— 直接用本机磁盘上的整套做模板，本机不会被停机`
      : `源(模板): ${source.name} (${source.host}:${source.port})`);
    taskLine(task, `目标(新机): ${target.name} (${target.host}:${target.port})`);
    taskLine(task, `包含 NapCat 登录令牌: ${opts.qqData === false ? '否(目标机需扫码一次)' : '是(免扫码快速登录)'}`);
    if (isLocal) taskLine(task, `本机不带 QQ 客户端数据（Windows↔Linux 不通用）；带的是 NapCat 登录令牌文件与全部套件数据`);

    /* 0. 连接两端（本机源只需连目标机） */
    if (!isLocal) await step('连接模板服务器', async () => { srcConn = await connectOne(source); });
    await step('连接目标服务器', async () => { dstConn = await connectWithFallback(target, task); });

    /* 0b. 源机磁盘预检(打包需要空间; QQ 数据大, 空间不足时明确失败而非中途爆盘) */
    if (!isLocal) {
      const disk = await runCmd(srcConn, `df -k /root | awk 'NR==2 {print int($4/1024)}'`, 15000);
      const availMb = Number(disk.out || 0);
      const needMb = opts.qqData === false ? 500 : 1000;
      if (disk.ok && availMb > 0 && availMb < needMb) {
        throw new Error(`模板机 /root 磁盘可用仅 ${availMb}MB, 克隆打包约需 ${needMb}MB。请先清理模板机空间后重试(可取消“克隆 QQ 登录态”以减小需求)。`);
      }
      taskLine(task, `模板机磁盘可用: ${availMb}MB ${availMb < needMb + 500 ? '(偏紧, 建议清理后重试)' : ''}`);
    } else {
      taskLine(task, '本机磁盘：打包到临时目录，本机服务全程不停机');
    }

    /* 1. 目标机基础环境：探测 → 缺什么装什么（多装法兜底）→ 复核
     * 【2026-09-12 主人要求】"自动检测服务器缺失环境，比如 npm/node，没有就自动安装别报错停止，
     * 别留我安装"。旧实现只在 `needNode || needDocker` 时才跑这一步，node 已是 22 但**缺 npm**
     * 时这一步被整个跳过 → 后面 `npm install` 直接失败。现在改成无条件自愈，
     * 并且每一步都只写日志、换下一种装法，不再单点失败即中止。 */
    const envRes = await ensureTargetEnv(dstConn, task);
    if (!envRes.nodeOk || !envRes.npmOk) {
      throw new Error(`目标机 node/npm 自动安装未成功（node=${envRes.env.node} npm=${envRes.env.npm}）。`
        + '已尝试 nodesource 源 / nodejs.org 官方 tarball / 发行版包三种装法；'
        + '请检查目标机是否能访问外网（apt 源与 nodejs.org），然后重试。');
    }
    if (!envRes.dockerOk) {
      taskLine(task, '  ⚠ docker 不可用：仍会继续（后面拉镜像/建容器会再次尝试并报出具体原因）');
    }
    await step('安装全局 DSH CLI(@deepseek-ai/dsh)', async () => {
      // 本机复刻时**跟随本机版本**（本机跑的是 0.1.2-rc.1 之类的新版；硬写模板机的版本会让目标机
      // 的 preset/插件版本对不上，出现"克隆完起不来"这类很难查的问题）。
      const dshVer = isLocal ? String(opts.dshVersion || '').trim() : '0.1.1-rc.2';
      const spec = dshVer ? `@deepseek-ai/dsh@${dshVer}` : '@deepseek-ai/dsh';
      // 【2026-09-12】多给一次机会 + 装完用真实可执行复核（原来一次 npm i -g 失败就 throw）。
      const script = [
        `npm ls -g ${spec} >/dev/null 2>&1 || npm i -g ${spec} --no-audit --no-fund 2>&1 | tail -3 || true`,
        `command -v dsh >/dev/null 2>&1 || npm i -g ${spec} --force --no-audit --no-fund 2>&1 | tail -3 || true`,
        // npm 全局 bin 目录有时不在 PATH（root 的 npm prefix 被改过）→ 主动软链到 /usr/bin/dsh
        'P=$(npm prefix -g 2>/dev/null); if [ -n "$P" ] && [ -x "$P/bin/dsh" ]; then ln -sf "$P/bin/dsh" /usr/bin/dsh 2>/dev/null || true; fi',
        'command -v dsh >/dev/null 2>&1 && ln -sf "$(command -v dsh)" /usr/bin/dsh 2>/dev/null',
        'command -v dsh >/dev/null 2>&1 && echo DSH_OK || echo DSH_MISSING',
        'dsh --version 2>&1 | head -1',
      ].join('; ');
      const r = await runCmd(dstConn, script, 900000);
      const ok = (r.out || '').includes('DSH_OK');
      taskLine(task, `  dsh: ${ok ? '已安装' : '未装上'}${isLocal ? `（跟随本机 ${dshVer || '默认'}）` : ''} ${r.out.split('\n').filter(Boolean).slice(-1)[0] || ''}`);
    });
    await step('安装 mcp-compressor (MCP 压缩器)', async () => {
      const r = await runCmd(dstConn, `(pip3 show mcp-compressor >/dev/null 2>&1 || python3 -m pip show mcp-compressor >/dev/null 2>&1) && echo ok || (pip3 install --break-system-packages mcp-compressor==0.31.9 2>&1 | tail -2 || python3 -m pip install --break-system-packages mcp-compressor==0.31.9 2>&1 | tail -2)`, 600000);
      if (!r.ok) throw new Error(r.err || 'pip 安装失败');
    }).catch((e) => { taskLine(task, `  ⚠ mcp-compressor 安装失败(不影响 DSH/桥主体, 仅 napcat MCP 压缩不可用): ${e.message}`); });
    // 校验 dsh 可执行（失败也不再直接中止：下面桥/DSH 起不来时日志会给出更具体的原因）
    const dshCheck = await runCmd(dstConn, `which dsh || echo NO_DSH`, 15000);
    if (dshCheck.out.includes('NO_DSH')) {
      taskLine(task, '  ⚠ dsh CLI 未装好（已尝试 npm 全局安装与 /usr/bin 软链）；DSH 服务可能起不来，继续往下走以便日志里看到真实原因');
    }

    /* 2. 打包(stage)：模板机需要短暂停机；本机复刻不停机（直接读磁盘副本） */
    const packResults = [];
    if (isLocal) {
      localStageDir = join(os.tmpdir(), `qqbridge-clone-${Date.now()}`);
      await step('本机打包(桥/DSH/登录令牌/表情库)', async () => {
        mkdirSync(localStageDir, { recursive: true });
        for (const item of plan) {
          const r = packLocalStage(task, item, localStageDir);
          if (!r.ok && !item.optional) throw new Error(`打包 ${item.name} 失败: ${r.error}`);
          packResults.push({ name: item.name, ok: r.ok, path: r.path, err: r.error });
          if (!r.ok) taskLine(task, `  (跳过) ${item.name}: ${r.error}`);
        }
      });
    } else {
      taskLine(task, '—— 模板服务器短暂停机并打包(桥/DSH/NapCat 会离线几十秒~几分钟)');
      const stopScript = [
        `mkdir -p ${stageDir} && rm -rf ${stageDir}/*`,
        `pkill -f 'node src/bridge.js' 2>/dev/null; sleep 1`,
        `systemctl stop dsh-web 2>/dev/null; docker stop napcat 2>/dev/null; sleep 1`,
      ].join('; ');
      const stopped = await runCmd(srcConn, stopScript, 60000);
      if (!stopped.ok) taskLine(task, `  停机阶段输出: ${stopped.out || stopped.err}`);
      taskLine(task, '  服务已停, 开始打包…');

      for (const item of plan) {
        const r = await runCmd(srcConn, item.pack, 900000);
        if (!r.ok && !item.optional) throw new Error(`打包 ${item.name} 失败: ${r.err || r.out}`);
        packResults.push({ name: item.name, ok: r.ok, err: r.err });
        taskLine(task, `  已打包 ${item.name} ${r.ok ? '✓' : '(跳过)'}`);
      }

      /* 3. 源机立即恢复(不等传输) */
      taskLine(task, '—— 恢复模板服务器服务');
      await safely('重启 dsh-web', async () => {
        const r = await runCmd(srcConn, `systemctl start dsh-web 2>&1; sleep 2; systemctl is-active dsh-web`, 60000);
        taskLine(task, `  dsh-web: ${r.out || r.err}`);
      });
      await safely('重启 NapCat', async () => {
        const r = await runCmd(srcConn, `docker start napcat 2>&1`, 60000);
        taskLine(task, `  napcat: ${r.out || r.err}`);
      });
      await safely('重启桥', async () => {
        const r = await runCmd(srcConn, `cd /root/qq-bridge && rm -f state/bridge.lock && nohup bash start-bridge.sh >/dev/null 2>&1 & sleep 3; pgrep -f 'node src/bridge.js' >/dev/null && echo bridge-up || echo bridge-down`, 60000);
        taskLine(task, `  bridge: ${r.out || r.err}`);
      });
    }

    /* 4. NapCat 容器卷先就绪(拉镜像耗时, 放传输前), 之后普通包直接传输 */
    // 4a. 目标机先建好容器与卷(停着), QQ 登录卷 napcat-qq
    taskLine(task, '—— 准备目标机 NapCat 容器(拉镜像可能较慢)');
    await step('拉取 napcat 镜像', async () => {
      const pull = await runCmd(dstConn, `docker pull mlikiowa/napcat-docker:latest 2>&1 | tail -2`, 1800000);
      if (!pull.ok) throw new Error(`拉取 napcat 镜像失败: ${pull.err}`);
    });
    await step('创建容器与 QQ 卷(先停着)', async () => {
      const prep = await runCmd(dstConn, `mkdir -p /root/napcat/config; docker rm -f napcat 2>/dev/null; docker volume create napcat-qq >/dev/null 2>&1; docker create --name napcat --restart unless-stopped -e NAPCAT_UID=0 -e NAPCAT_GID=0 -e TZ=Asia/Shanghai -p 3000:3000 -p 3001:3001 -p 6099:6099 -v /root/napcat/config:/app/napcat/config -v napcat-qq:/app/.config/QQ mlikiowa/napcat-docker:latest`, 120000);
      if (!prep.ok) throw new Error(`创建 napcat 容器失败: ${prep.err}`);
      taskLine(task, `  容器已创建(未启动, 待灌数据)`);
    });

    /* 4b. 逐包传到目标机并解包：本机源用"本机文件 → 远端 stdin"直传；模板源经本机两段中转 */
    taskLine(task, '—— 向目标机传输并解包(经本机中转)');
    for (const item of plan) {
      const packed = packResults.find((p) => p.name === item.name);
      if (!packed?.ok) continue;
      if (item.afterContainer) continue; // QQ 登录态在容器卷灌入阶段处理
      await step(`传输 ${item.name}`, async () => {
        if (isLocal) {
          await runCmd(dstConn, `mkdir -p ${stageDir}`, 20000);
          await opts.uploadFile(dstConn, packed.path, `cat > ${stageDir}/${item.stage}`);
          const deep = await runCmd(dstConn, item.dstFile, 900000);
          if (!deep.ok) throw new Error(deep.err || deep.out || '解包失败');
        } else {
          await streamPipe(
            srcConn, `cat ${stageDir}/${item.stage}`,
            dstConn, item.dst,
            1800000,
          );
        }
      });
    }
    // 4c. QQ 登录态 → 目标机容器卷(容器须已存在且停止)
    const qqItem = plan.find((p) => p.afterContainer);
    if (qqItem && packResults.find((p) => p.name === qqItem.name)?.ok) {
      await step('传输 QQ 登录态到容器卷', async () => {
        await streamPipe(
          srcConn, `cat ${stageDir}/${qqItem.stage}`,
          dstConn, qqItem.dst,
          1800000,
        );
      });
    }
    // 4d. 桥依赖装到目标机(原生模块按目标平台编译)
    // 【2026-09-12】失败不再只说"npm install 未完成"：先自动补上编译链（build-essential/python3/make/g++）
    // 再重试一次，最后才如实报错（原生模块 sharp 在裸 Ubuntu 上缺 make/g++ 时编译会失败）。
    await step('安装桥依赖(npm install, 需要一点时间)', async () => {
      const script = [
        'cd /root/qq-bridge',
        'npm install --omit=dev --no-audit --no-fund 2>&1 | tail -4',
        'if [ ! -d node_modules ]; then',
        '  echo "[deploy] 首次 npm install 未成功，自动补编译链后重试"',
        '  export DEBIAN_FRONTEND=noninteractive',
        '  apt-get install -y -qq --fix-missing build-essential python3 make g++ 2>&1 | tail -2 || true',
        '  npm install --omit=dev --no-audit --no-fund 2>&1 | tail -4',
        'fi',
        'test -d node_modules && echo NPM_OK || echo NPM_FAIL',
      ].join('\n');
      const r = await runCmd(dstConn, script, 1500000);
      if (!r.out.includes('NPM_OK')) {
        const tail = (r.out || r.err || '').split('\n').filter(Boolean).slice(-6).join(' | ');
        throw new Error(`npm install 未完成(node_modules 缺失)：${tail || '无输出'}（已尝试自动补编译链后重试）`);
      }
      taskLine(task, '  桥依赖已就绪 /root/qq-bridge/node_modules');
    });

    // 4e. 桥的 config.json 指向**本机**的隔离 DSH 端口（本机是 10721，目标机上 DSH 跑在 3080）——
    //     不改这一处，目标机的桥会一直连不上 DSH（表现：桥起来了但机器人不说话）。
    await step('调整桥配置指向目标机 DSH 端口', async () => {
      const patch = [
        `node -e "const fs=require('fs');const p='/root/qq-bridge/config.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));`,
        `const before=(c.dsh&&c.dsh.baseUrl)||'';c.dsh=c.dsh||{};c.dsh.baseUrl='http://127.0.0.1:3080';`,
        `fs.writeFileSync(p,JSON.stringify(c,null,2));console.log('baseUrl',before,'->',c.dsh.baseUrl)"`,
      ].join('');
      const r = await runCmd(dstConn, `cd /root/qq-bridge && ${patch}`, 30000);
      if (!r.ok) throw new Error(r.err || '改 config.json 失败');
      taskLine(task, `  ${(r.out || '').trim().split('\n').slice(-1)[0] || '已指向 3080'}`);
    });

    /* 5. 目标机装配: systemd / napcat 容器与卷 / 启动 */
    // 5a. systemd unit：模板源是从源机读；本机源没有 systemd unit → 现场生成（DSH Web + 不再需要 polyfill）
    await step('同步 systemd 服务定义', async () => {
      if (isLocal) {
        const dshBinPath = (await runCmd(dstConn, `command -v dsh || echo /usr/bin/dsh`, 15000)).out.trim() || '/usr/bin/dsh';
        const unit = [
          '[Unit]',
          'Description=DeepSeek Harness (isolated web)',
          'After=network.target',
          '',
          '[Service]',
          'Type=simple',
          'Environment=DSH_HOME=/root/.dsh',
          'EnvironmentFile=-/etc/qq-bridge.env',
          `ExecStart=${dshBinPath} --profile web --port 3080 --no-open --trusted-host 127.0.0.1:3080`,
          'Restart=always',
          'RestartSec=3',
          '',
          '[Install]',
          'WantedBy=multi-user.target',
        ].join('\n');
        const write = `cat > /etc/systemd/system/dsh-web.service <<'UNITEOF'\n${unit}\nUNITEOF\nsystemctl daemon-reload && echo wrote-dsh-web`;
        const dst = await runCmd(dstConn, write, 30000);
        if (!dst.ok || !dst.out.includes('wrote-dsh-web')) throw new Error(dst.err || '写 dsh-web.service 失败');
        taskLine(task, '  已在本机生成并写入 dsh-web.service（本机源没有现成 systemd unit）');
        return;
      }
      const units = ['dsh-web.service', 'dsh-polyfill.service'];
      for (const u of units) {
        const src = await runCmd(srcConn, `cat /etc/systemd/system/${u} 2>/dev/null || echo MISSING`, 15000);
        if (!src.ok || src.out === 'MISSING') { taskLine(task, `  源机无 ${u}, 跳过`); continue; }
        const write = `cat > /etc/systemd/system/${u} <<'UNITEOF'\n${src.out}\nUNITEOF\necho wrote-${u}`;
        const dst = await runCmd(dstConn, write, 15000);
        if (!dst.ok) throw new Error(`写 ${u} 失败: ${dst.err}`);
      }
      const reload = await runCmd(dstConn, `systemctl daemon-reload && echo ok`, 20000);
      if (!reload.ok) throw new Error(reload.err);
    });

    // 5b. 同步源机 .bashrc 中的密钥/环境导出行（模板源才有；本机复刻靠随包的 .credentials.yaml）
    if (isLocal) {
      taskLine(task, '—— 环境变量：本机复刻不导出 shell 环境（凭据随 .credentials.yaml 一起过去了，DSH 自己读；不猜着导出以免把 key 写坏）');
    } else await safely('同步环境变量到 .bashrc 与 systemd', async () => {
      const keys = await runCmd(srcConn, `grep -hE '^export (MIMO_API_KEY|OPENCODE_ZEN_API_KEY|DEEPSEEK_[A-Z_]*|LLM_[A-Z_]*|.*API_KEY)=' /root/.bashrc 2>/dev/null`, 15000);
      if (keys.ok && keys.out) {
        const lines = keys.out.split('\n').filter(Boolean);
        for (const line of lines) {
          const esc = line.replace(/'/g, `'\\''`);
          await runCmd(dstConn, `grep -qF '${esc.split('=')[0]}=' /root/.bashrc || echo "${esc}" >> /root/.bashrc`, 15000);
        }
        // 生成 systemd EnvironmentFile(去掉 export 前缀, 键值行)
        const envBody = lines.map((l) => l.replace(/^export\s+/, '')).join('\n');
        const escBody = envBody.replace(/'/g, `'\\''`);
        await runCmd(dstConn, `mkdir -p /etc/systemd/system/dsh-web.service.d && printf '%s\n' "${escBody}" > /etc/qq-bridge.env && chmod 600 /etc/qq-bridge.env && printf '[Service]\\nEnvironmentFile=/etc/qq-bridge.env\\n' > /etc/systemd/system/dsh-web.service.d/env.conf && systemctl daemon-reload && echo ENV_OK`, 20000);
        taskLine(task, `  已写入 ${lines.length} 条环境变量(bashrc + systemd)`);
      } else {
        taskLine(task, '  源机 .bashrc 未找到可迁移的 export(跳过)');
      }
    });

    // 5c. 启动系统服务 + 容器 + 桥
    await step('启动 DSH Web 与 polyfill', async () => {
      const r = await runCmd(dstConn, `systemctl enable --now dsh-polyfill 2>&1; systemctl enable --now dsh-web 2>&1; sleep 5; systemctl is-active dsh-web dsh-polyfill`, 60000);
      taskLine(task, `  ${r.out || r.err}`);
      if (!/^active\s+active/m.test(r.out)) taskLine(task, '  ⚠ dsh 服务未全部 active, 见上输出');
    });
    await step('启动桥', async () => {
      const r = await runCmd(dstConn, `cd /root/qq-bridge && rm -f state/bridge.lock && nohup bash start-bridge.sh >/dev/null 2>&1 & sleep 4; pgrep -f 'node src/bridge.js' >/dev/null && echo bridge-up || echo bridge-down`, 60000);
      taskLine(task, `  ${r.out || r.err}`);
    });
    await step('启动 NapCat 容器', async () => {
      const r = await runCmd(dstConn, `docker start napcat 2>&1 && sleep 6; docker ps --filter name=napcat --format '{{.Names}} {{.Status}} {{.Ports}}'`, 90000);
      taskLine(task, `  ${r.out || r.err}`);
    });

    /* 6. 自检 */
    taskLine(task, '—— 目标机自检');
    const checks = [
      ['DSH Web(3080)', `curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:3080/ || echo down`],
      ['Bridge(3100)', `curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:3100/api/ping 2>/dev/null; echo; pgrep -f 'node src/bridge.js' >/dev/null && echo bridge-proc-up || echo bridge-proc-down`],
      ['NapCat WebUI(6099)', `curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:6099/ || echo down`],
    ];
    for (const [label, cmd] of checks) {
      const r = await runCmd(dstConn, cmd, 20000);
      taskLine(task, `  ${label}: ${(r.out || r.err).replace(/\n/g, ' / ')}`);
    }

    /* 7. 清理打包残留 */
    if (isLocal) {
      await safely('清理本机打包临时目录', async () => {
        if (localStageDir) { rmSync(localStageDir, { recursive: true, force: true }); localStageDir = null; }
        taskLine(task, '  已清理本机临时目录');
      });
    } else {
      await safely('清理源机打包残留', async () => {
        await runCmd(srcConn, `rm -rf ${stageDir}`, 30000);
      });
    }

    task.status = 'done';
    taskLine(task, '===== 克隆部署完成 =====');
    taskLine(task, '下一步: 回管理端「SSH 配置」点该服务器的「连接」建立隧道即可使用;');
    if (opts.qqData === false) taskLine(task, `注意: 未带 NapCat 登录令牌, 请打开 NapCat WebUI(6099) 扫码登录一次。`);
    else if (isLocal) taskLine(task, 'NapCat: 若目标机没自动登入(令牌与 QQ 版本差异), 打开 WebUI(6099) 扫一次码即可, 之后就一直免扫;');
    taskLine(task, '若 DSH 未就绪, 可 ssh 目标机执行: systemctl status dsh-web / tail -50 /root/.dsh/dsh-web.log');
  } catch (e) {
    task.status = 'error';
    taskLine(task, `!!!!! 部署失败: ${e?.message || e}`);
    if (isLocal) {
      taskLine(task, '本机全程没有停机（只是读了磁盘副本），无需恢复；可修好目标机/SSH 后直接重试。');
      if (localStageDir) { try { rmSync(localStageDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    } else {
      taskLine(task, '模板服务器服务已在打包后尽力恢复; 若恢复失败请 ssh 模板机手动: systemctl start dsh-web; docker start napcat; bash /root/qq-bridge/start-bridge.sh');
      // 尽力恢复模板机(幂等: 已在运行的服务不重复拉)并清理打包残留
      if (srcConn) {
        try {
          await runCmd(srcConn, `systemctl is-active dsh-web >/dev/null 2>&1 || systemctl start dsh-web 2>/dev/null; docker inspect -f '{{.State.Running}}' napcat 2>/dev/null | grep -q true || docker start napcat 2>/dev/null; pgrep -f 'node src/bridge.js' >/dev/null || (cd /root/qq-bridge && rm -f state/bridge.lock && nohup bash start-bridge.sh >/dev/null 2>&1 &); rm -rf /root/.qqbridge-clone`, 30000);
        } catch { /* ignore */ }
      }
    }
  } finally {
    try { srcConn?.end(); } catch {}
    try { dstConn?.end(); } catch {}
    task.finishedAt = Date.now();
    deployTasks.set(taskId, task);
    // 保留任务记录 1 小时
    setTimeout(() => { if (deployTasks.get(taskId)?.finishedAt) deployTasks.delete(taskId); }, 3600000).unref?.();
  }
}

/* ---------------- 对外接口 ---------------- */
export function deployApi() {
  return {
    /** 注册新任务并立即后台执行。返回 taskId */
    start(source, target, opts = {}) {
      const taskId = `deploy-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
      const task = { lines: [], status: 'running', updatedAt: Date.now() };
      deployTasks.set(taskId, task);
    runDeploy(taskId, source, target, opts).catch((e) => {
      // runDeploy 内部已有 try/catch，这里是最后一道保险：**部署任务异常绝不能把管理器带走**
      // （后台任务未处理的 rejection 在 Node 下会直接结束进程 —— 2026-09-12 实测过一次）。
      const t = deployTasks.get(taskId);
      if (t) { t.status = 'error'; taskLine(t, `!!!!! 部署任务异常退出: ${e?.message || e}`); t.finishedAt = Date.now(); }
      console.error('[deploy] 任务异常:', e?.stack || e?.message || e);
    });
      return taskId;
    },
    status(taskId) {
      const t = deployTasks.get(taskId);
      return t ? { status: t.status, lines: t.lines } : null;
    },
    list() {
      return [...deployTasks.entries()].map(([id, t]) => ({ id, status: t.status, lines: t.lines.slice(-1)[0] ?? '', updatedAt: t.updatedAt, finishedAt: t.finishedAt ?? null })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 20);
    },
  };
}
