/* 回归测试：【目标机环境自愈】（2026-09-12 的需求：部署功能要求自动检测服务器缺失环境，比如 npm、node 这些，
 *   没有就自动安装别报错停止）。
 *
 * 用一个假的 SSH 连接（模拟一台全新 Ubuntu 的 shell 行为）驱动真实的 ensureTargetEnv()，
 * 覆盖四种现场，其中 ② 就是现场真实踩到的那个坑（有 node、缺 npm → 旧实现直接跳过安装、后面必失败）：
 *   ① 全缺（全新 Ubuntu）      → 自动装好 node/npm/docker
 *   ② 有 node 22 但缺 npm      → 自动补 npm（旧代码这一步整个被 if 跳过）
 *   ③ 全部装法都失败（没外网）  → 不抛异常，如实警告，交由调用方决定
 *   ④ 一切就绪                 → 只探测，不做多余安装
 *
 * 用法：node tools/test-target-env.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { ensureTargetEnv } = await import(pathToFileURL(path.join(here, '..', 'server', 'deploy.js')).href);

let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

/** 假 SSH 连接：解析被执行的 shell 片段，维护"这台机器当前装了什么"的状态 */
function fakeTarget(init = {}) {
  const s = {
    node: init.node ?? 'none',          // 'none' | 'v18.19.1' | 'v22.11.0'
    npm: init.npm ?? 'none',
    docker: init.docker ?? 'none',
    dockerd: init.dockerd ?? 'none',
    pip: init.pip ?? 'none',
    net: init.net !== false,            // 目标机有没有外网
    log: [],                            // 走过的装法（断言"真的去装了"）
  };

  const probeLines = () => [
    'ARCH=x86_64', 'OS=Ubuntu 24.04.1 LTS',
    `NODE=${s.node}`, `NPM=${s.npm}`, `DOCKER=${s.docker}`, `DOCKERD=${s.dockerd}`,
    'PY=Python 3.12.3', `PIP=${s.pip}`,
    `CURL=${s.curl ?? '/usr/bin/curl'}`, `TAR=${s.tar ?? '/usr/bin/tar'}`, `GZ=${s.gz ?? '/usr/bin/gzip'}`,
    `XZ=${s.xz ?? '/usr/bin/xz'}`, `GPG=${s.gpg ?? '/usr/bin/gpg'}`, `CA=${s.ca ?? 'yes'}`,
    'DSH=none',
  ].join('\n');

  /** 按命令内容决定"这台机器"的输出与状态变化 */
  function respond(cmd) {
    if (cmd.includes('echo "NODE=')) return probeLines();
    if (cmd.includes('deb.nodesource.com')) {
      s.log.push('try:nodesource');
      if (s.net && s.node === 'none') { s.node = 'v22.11.0'; s.npm = '10.9.0'; }
      return 'NS_DONE';
    }
    if (cmd.includes('nodejs.org/dist')) {
      s.log.push('try:tarball');
      if (s.net && s.npm === 'none') { s.node = 'v22.11.0'; s.npm = '10.9.0'; }
      return s.net ? 'TARBALL_DONE' : 'curl: (6) Could not resolve host';
    }
    if (cmd.includes('apt-get install') && cmd.includes('docker.io')) {
      s.log.push('try:apt-docker');
      if (s.net) { s.docker = 'Docker version 27.3.1'; s.dockerd = 'active'; }
      return 'apt done';
    }
    if (cmd.includes('get.docker.com')) {
      s.log.push('try:get-docker');
      if (s.net) { s.docker = 'Docker version 27.3.1'; s.dockerd = 'active'; }
      return 'GD_DONE';
    }
    if (cmd.includes('docker info')) return s.docker !== 'none' ? 'DOCKER_UP' : 'DOCKER_DOWN';
    if (cmd.includes('ensurepip')) {
      s.log.push('try:ensurepip');
      if (s.net) s.pip = 'pip 24.0';
      return s.pip === 'none' ? 'NO_PIP' : 'pip 24.0';
    }
    if (cmd.includes('apt-get install') && cmd.includes('nodejs')) {
      s.log.push('try:apt-nodejs');
      if (s.net && s.node === 'none') s.node = 'v18.19.1';
      return 'apt done';
    }
    if (cmd.includes('apt-get install') && cmd.includes('npm')) {
      s.log.push('try:apt-npm');
      if (s.net && s.npm === 'none') s.npm = '9.2.0';
      return 'apt done';
    }
    if (cmd.includes('apt-get install')) {
      s.log.push('try:apt-base');
      return 'apt done';
    }
    return 'ok';
  }

  return {
    state: s,
    exec(command, cb) {
      const resp = respond(String(command));
      const listeners = {};
      const stream = {
        on(ev, fn) { (listeners[ev] ||= []).push(fn); return stream; },
        stderr: { on() { return this; } },
        close() {},
      };
      cb(null, stream);
      setTimeout(() => {
        for (const fn of (listeners.data || [])) fn(Buffer.from(resp + '\n'));
        for (const fn of (listeners.close || [])) fn(0);
      }, 0);
      return null;
    },
  };
}

const makeTask = () => ({ lines: [], status: 'running', updatedAt: 0 });

/* ── ① 全新 Ubuntu：全缺 → 必须自动全部装好 ─────────────────────────────── */
{
  const conn = fakeTarget();
  const task = makeTask();
  const res = await ensureTargetEnv(conn, task);
  check('① 全缺时 node 装好', res.nodeOk, conn.state.node);
  check('① 全缺时 npm 装好', res.npmOk, conn.state.npm);
  check('① 全缺时 docker 装好', res.dockerOk, conn.state.docker);
  check('① 真的走了安装流程（nodesource）', conn.state.log.includes('try:nodesource'), conn.state.log.join(','));
  check('① 日志里打印了环境复核表', task.lines.join('\n').includes('环境复核'));
}

/* ── ② 有 node 22 但缺 npm（现场真实遇到的坑）───────────────────────────── */
{
  const conn = fakeTarget({ node: 'v22.11.0', npm: 'none' });
  const task = makeTask();
  const res = await ensureTargetEnv(conn, task);
  check('② 缺 npm 会被自动补上（旧实现这一步整个被跳过）', res.npmOk, `npm=${conn.state.npm}`);
  check('② 缺 npm 时确实执行了安装动作', conn.state.log.some((x) => x.startsWith('try:')), conn.state.log.join(','));
  check('② node 版本没被降级（仍是 v22.11.0）', conn.state.node === 'v22.11.0', conn.state.node);
}

/* ── ③ 目标机没外网：所有装法都失败也不能抛异常 ─────────────────────────── */
{
  const conn = fakeTarget({ net: false });
  const task = makeTask();
  let threw = null;
  let res = null;
  try { res = await ensureTargetEnv(conn, task); } catch (e) { threw = e; }
  check('③ 全装法失败时不抛异常（调用方决定怎么报）', threw === null, threw?.message ?? '');
  check('③ 如实报告 node 不可用', res?.nodeOk === false);
  check('③ 日志里有明确警告', task.lines.join('\n').includes('⚠'));
  check('③ 三种装法都试过（nodesource / tarball / 发行版包）',
    ['try:nodesource', 'try:tarball', 'try:apt-nodejs'].every((x) => conn.state.log.includes(x)), conn.state.log.join(','));
}

/* ── ④ 一切就绪：不该做多余安装 ────────────────────────────────────────── */
{
  const conn = fakeTarget({ node: 'v22.11.0', npm: '10.9.0', docker: 'Docker version 27.3.1', dockerd: 'active', pip: 'pip 24.0' });
  const task = makeTask();
  const res = await ensureTargetEnv(conn, task);
  check('④ 就绪时三项都判定可用', res.nodeOk && res.npmOk && res.dockerOk);
  check('④ 就绪时不触发任何安装动作', conn.state.log.filter((x) => x.startsWith('try:')).length === 0, conn.state.log.join(','));
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
