// DSH 端安装与定位（2026-09-06 二期）：
// qq-bridge 需要把 agent preset / MCP(cordis.patch.yml) / qq-mode 插件装进「内置隔离 DSH」
// （QQ-Bridge\.runtime\dsh-isolated-home，端口 13210）。所有路径自动推导，不写死；
// 默认绝不动桌面端 DSH（AppData\Roaming\DeepSeek Harness\dsh-home 与 ~/.dsh），
// 仅当显式传入 allowDesktopHome / --home 指向它们时才允许。
//
// 约定（来自 DeepSeek Harness 源码）：
//   DSH_HOME 根：preset → <home>/.agent-presets/<name>；
//   profile 补丁：<home>/profiles/<profile>/cordis.patch.yml（MCP/agent-presets overlay）；
//   插件安装：<home>/plugins/qq-mode-console 链接 + <home>/profiles/node_modules/qq-mode-console 链接
//             （profiles/node_modules 是各 profile 共享的“安装面”，不会落到桌面端）。
//   隔离实例由 manager（server/index.js）以 DSH_HOME=<home> dsh --profile web --port 13210 启动。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncPresetOverrides } from './preset-compose.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..'); // qq-bridge/
export const DESKTOP_DSH_HOME = path.join(process.env.APPDATA || os.homedir(), 'DeepSeek Harness', 'dsh-home');
const HOME_DSH = path.join(os.homedir(), '.dsh');
export const INSTALL_MARKER_NAME = '.qq-bridge-dsh-installed.json';
export const INSTALL_VERSION = 1;

/** 项目相对推导「内置隔离 DSH home」：QQ-Bridge\.runtime\dsh-isolated-home */
export function defaultIsolatedDshHome() {
  return path.resolve(REPO_ROOT, '..', '.runtime', 'dsh-isolated-home');
}

/** 是否属于“桌面端 DSH home”（默认禁止写入）
 *
 * 【2026-09-15 修「服务器上改了 preset 却永远不生效」】原来在**任何**平台上都把 `~/.dsh` 当作桌面端
 * home 拒绝写入。Windows 上这是对的（桌面端 GUI 和隔离实例是两个 home，不能乱写桌面那份）；
 * 但 Linux 服务器上 DSH 的 home **就是** `/root/.dsh`（systemd 起 dsh-web、没有桌面端），于是
 * `resolveDshTarget()` 判定"refusedDesktop"直接 return —— 桥每次重启都不再刷新 preset，
 * 实测服务器上 `.agent-presets/default/agent.cordis.yml` 一直停在部署那一刻的旧哈希，
 * 提示词改动（[TOOLS]/唤醒协议/角色卡豁免）**一个字都没进模型**。
 * 现在只在 Windows 上做这层保护；非 Windows 平台 `~/.dsh` 是正常安装目标。 */
export function isDesktopDshHome(dir) {
  if (!dir) return false;
  if (process.platform !== 'win32') return false;
  const a = path.resolve(dir).toLowerCase();
  const desk = path.resolve(DESKTOP_DSH_HOME).toLowerCase();
  const homeD = path.resolve(HOME_DSH).toLowerCase();
  return a === desk || a.startsWith(desk + path.sep) || a === homeD || a.startsWith(homeD + path.sep);
}

/**
 * 解析安装目标 home（自动探测，不写死）：
 *  1) QQB_DSH_HOME 环境变量（显式覆盖）；
 *  2) 项目相对的内置隔离 home（QQ-Bridge\.runtime\dsh-isolated-home）；
 *  3) manager 持久化配置的隔离实例 home（~/.qq-bridge-manager/config.json）作为兜底；
 * 桌面端 DSH home（AppData\Roaming\DeepSeek Harness\dsh-home 与 ~/.dsh）默认拒绝。
 * 返回 { home, profile, source, exists, booted }
 */
export function resolveDshTarget(opts = {}) {
  const profile = opts.profile || process.env.QQB_DSH_PROFILE || 'web';
  const env = process.env.QQB_DSH_HOME;
  const projRuntime = defaultIsolatedDshHome();
  const managerHome = readManagerIsolatedHome();
  const isBooted = (h) => h && fs.existsSync(h) && fs.existsSync(path.join(h, 'profiles', profile));
  // 探测顺序：env（显式）→ 项目 .runtime（若已启动过）→ manager 持久化隔离 home → 项目 .runtime（尚未初始化，仅提示用）
  let home = env || (isBooted(projRuntime) ? projRuntime : (isBooted(managerHome) ? managerHome : projRuntime));
  const source = env ? 'env' : home === managerHome && isBooted(managerHome) ? 'manager' : 'isolated';
  if (isDesktopDshHome(home) && !opts.allowDesktopHome) {
    return { home, profile, source, exists: false, booted: false, refusedDesktop: true, error: `目标 DSH home 是桌面端（${home}），默认不写入；请用 QQB_DSH_HOME 指向隔离目录或显式授权` };
  }
  home = path.resolve(home);
  const exists = fs.existsSync(home);
  const profileDir = path.join(home, 'profiles', profile);
  const booted = exists && fs.existsSync(profileDir);
  return { home, profile, source, exists, booted, profileDir, marker: path.join(home, INSTALL_MARKER_NAME), error: null };
}

/** 读取 manager 持久化的隔离实例 home（只读，项目外配置），读取失败返回 null */
function readManagerIsolatedHome() {
  try {
    const p = path.join(os.homedir(), '.qq-bridge-manager', 'config.json');
    if (!fs.existsSync(p)) return null;
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const h = cfg?.instances?.dshIsolated?.isolatedHome;
    return h ? path.resolve(h) : null;
  } catch {
    return null;
  }
}

/** 已装标记（version/home/profile 一致且文件在） */
export function isInstalled(target) {
  try {
    if (!target || !target.marker) return false;
    if (!fs.existsSync(target.marker)) return false;
    const rec = JSON.parse(fs.readFileSync(target.marker, 'utf8'));
    return rec.version === INSTALL_VERSION && String(rec.home).toLowerCase() === String(target.home).toLowerCase()
      && String(rec.profile || 'web') === String(target.profile || 'web');
  } catch {
    return false;
  }
}

export function writeInstallMarker(target) {
  fs.writeFileSync(target.marker, `${JSON.stringify({
    version: INSTALL_VERSION,
    home: target.home,
    profile: target.profile,
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
}

export function findDshCli() {
  const projRoot = path.resolve(REPO_ROOT, '..'); // QQ-Bridge/
  const cands = [
    process.env.QQB_DSH_CLI || '',
    path.join(projRoot, 'dsh', 'node_modules', '.bin', 'dsh.cmd'),
    path.join(projRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(projRoot, 'runtime', 'dsh', 'node_modules', '.bin', 'dsh.cmd'),
    path.join(projRoot, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(projRoot, 'node_modules', '.bin', 'dsh.cmd'),
  ].filter(Boolean);
  for (const p of cands) if (fs.existsSync(p)) return p;
  return '';
}

export function log(msg) {
  console.log(`[dsh-side] ${msg}`);
}
export function warn(msg) {
  console.warn(`[dsh-side] WARN: ${msg}`);
}

// ── 安装动作（全部写入 target.home 以内；绝不写入桌面 home） ──────────────
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function yamlSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}
function yamlQuoteForPath(p) {
  return yamlSingleQuote(p);
}

/** 拷贝两套 agent preset 到 <home>/.agent-presets/ */
export function installPresets(target) {
  if (isDesktopDshHome(target.home)) throw new Error(`refuse: desktop home ${target.home}`);
  for (const name of ['default', 'liangshen']) {
    const src = path.join(REPO_ROOT, 'dsh', 'agent-presets', name);
    if (!fs.existsSync(src)) { log(`preset source missing, skip: ${src}`); continue; }
    const dest = path.join(target.home, '.agent-presets', name);
    ensureDir(path.dirname(dest));
    fs.cpSync(src, dest, { recursive: true, force: true });
    log(`preset installed: ${name}`);
    /* 【2026-09-19】拷完立刻把主人的人设/发言规则合成进 default preset 的 [PERSONA] / [SPEECH RULES] 段：
     * 新会话建起来时就直接从系统提示词里拿到人设，不再只依赖唤醒正文里的运行时覆盖段。
     * 正在跑的会话（尤其永久会话）仍由唤醒正文覆盖 —— 两条路都留着，见 lib/preset-compose.js。 */
    if (name === 'default') {
      try {
        const r = syncPresetOverrides({ home: target.home, root: REPO_ROOT, log });
        if (r.ok && r.changed) log('[dsh-side] 人设/发言规则已合成进 preset（新会话即生效）');
        else if (!r.ok) log(`[dsh-side] 合成人设到 preset 失败：${r.error}`);
      } catch (e) { log(`[dsh-side] 合成人设到 preset 异常：${e?.message ?? e}`); }
    }
  }
}

function mcpBlock() {
  const node = process.execPath;
  const servers = {
    'mcp-napcat': path.join(REPO_ROOT, 'src', 'mcp-napcat-safe.js'),
    'mcp-napcat-host': path.join(REPO_ROOT, 'src', 'mcp-host-server.js'),
    'mcp-web-search-safe': path.join(REPO_ROOT, 'src', 'mcp-web-search-safe.js'),
  };
  let out = '# === qq-bridge MCP BEGIN ===\n';
  for (const [id, script] of Object.entries(servers)) {
    out += '- insert:\n';
    out += `    - id: ${id}\n`;
    out += `      name: '@deepseek-ai/dsh-mcp-client'\n`;
    out += `      config:\n`;
    out += `        serverName: ${id.replace('mcp-', '')}\n`;
    out += `        transport: stdio\n`;
    out += `        command: ${yamlQuoteForPath(node)}\n`;
    out += `        args:\n`;
    out += `          - ${yamlQuoteForPath(script)}\n`;
    if (id === 'mcp-napcat') out += '        toolCallTimeoutMs: 725000\n';
  }
  out += '# === qq-bridge MCP END ===\n';
  return out;
}

/** 写 <home>/profiles/<profile>/cordis.patch.yml：agent-presets overlay + 三个 MCP server */
export function patchProfileCordis(target) {
  if (isDesktopDshHome(target.home)) throw new Error(`refuse: desktop home ${target.home}`);
  const profileDir = target.profileDir;
  ensureDir(profileDir);
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  let text = '';
  if (fs.existsSync(patchFile)) text = fs.readFileSync(patchFile, 'utf8');

  // dsh-web-app 已 insert id: agent-presets → 用户层只能 overlay 同 id
  const agentPresetsOverlay =
    '# === agent-presets (qq-bridge support) ===\n' +
    '- id: agent-presets\n' +
    '  config:\n' +
    '    default: standard\n' +
    '    includeUserRoot: true\n';
  const insertRe = /# === agent-presets \(qq-bridge support\) ===\r?\n- insert:\r?\n(?:[ \t]+- id: agent-presets\r?\n(?:[ \t]+.+\r?\n)*)/;
  if (insertRe.test(text)) {
    text = text.replace(insertRe, `${agentPresetsOverlay}\n`);
    log('cordis.patch.yml: agent-presets insert -> overlay');
  } else if (!text.includes('id: agent-presets')) {
    const mIdx = text.indexOf('# === qq-bridge MCP BEGIN ===');
    const block = `${agentPresetsOverlay}\n`;
    text = mIdx >= 0 ? text.slice(0, mIdx) + block + text.slice(mIdx) : text.trimEnd() + '\n\n' + block;
    log('cordis.patch.yml: agent-presets overlay added');
  }

  const beginMarker = '# === qq-bridge MCP BEGIN ===';
  const endMarker = '# === qq-bridge MCP END ===';
  const block = mcpBlock();
  if (text.includes(beginMarker) && text.includes(endMarker)) {
    text = text.replace(/[^\n]*# === qq-bridge MCP BEGIN ===[\s\S]*?# === qq-bridge MCP END ===[^\n]*/, block.trimEnd());
    log('cordis.patch.yml: MCP block updated');
  } else if (text.includes('id: mcp-napcat') || text.includes('mcp-napcat-safe.js')) {
    log('cordis.patch.yml: mcp-napcat already present, skipped auto-insert');
  } else {
    text = text.replace(/^[ \t]*\[\][ \t]*(?:\r?\n|$)/gm, '');
    if (text.trim().length > 0) {
      if (!text.endsWith('\n')) text += '\n';
      text += `\n${block}`;
    } else {
      text += block;
    }
    log('cordis.patch.yml: MCP block appended');
  }
  fs.writeFileSync(patchFile, text, 'utf8');
  log(`cordis.patch.yml written: ${patchFile}`);
}

function ensureSymlink(link, repoDir, what) {
  ensureDir(path.dirname(link));
  let existing = null;
  try { existing = fs.lstatSync(link); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
  if (existing) {
    if (!existing.isSymbolicLink()) {
      log(`${what} 已存在且不是链接，跳过: ${link}`);
      return false;
    }
    let same = false;
    try {
      const t = fs.realpathSync(link);
      const e = fs.realpathSync(repoDir);
      same = process.platform === 'win32' ? t.toLowerCase() === e.toLowerCase() : t === e;
    } catch {}
    if (same) return true;
    fs.rmSync(link, { recursive: true, force: true });
  }
  try {
    fs.symlinkSync(repoDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    log(`${what} link created: ${link}`);
    return true;
  } catch (e) {
    log(`${what} link 创建失败（跳过）: ${e?.message ?? e}`);
    return false;
  }
}

/** 插件：<home>/plugins/qq-mode-console + <home>/profiles/node_modules/qq-mode-console（安装面，扁平共享） */
export function ensurePluginBundles(target) {
  if (isDesktopDshHome(target.home)) throw new Error(`refuse: desktop home ${target.home}`);
  const repoPlugin = path.join(REPO_ROOT, 'plugins', 'qq-mode-console');
  if (!fs.existsSync(repoPlugin)) { log(`插件源码不存在，跳过: ${repoPlugin}`); return; }
  const pluginLink = path.join(target.home, 'plugins', 'qq-mode-console');
  ensureSymlink(pluginLink, repoPlugin, 'plugins/qq-mode-console');
  // 扁平安装面（profiles/node_modules，各 profile 共享；不会进入桌面端 junction 的 profile node_modules）
  const flatLink = path.join(target.home, 'profiles', 'node_modules', 'qq-mode-console');
  ensureSymlink(flatLink, repoPlugin, 'profiles/node_modules/qq-mode-console');
  // profile package.json 注册 link 依赖 + bundle（供 cordis 启动解析）
  const pkgFile = path.join(target.profileDir, 'package.json');
  ensureDir(target.profileDir);
  let pkg = { name: `dsh-profile-${target.profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  if (fs.existsSync(pkgFile)) {
    try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); } catch (e) { throw new Error(`解析 ${pkgFile} 失败: ${e?.message ?? e}`); }
  }
  pkg.name = pkg.name || `dsh-profile-${target.profile}`;
  pkg.private = pkg.private !== false;
  if (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)) pkg.dependencies = {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];
  const linkVal = `link:${pluginLink.replace(/\\/g, '/')}`;
  if (pkg.dependencies['qq-mode-console'] !== linkVal) pkg.dependencies['qq-mode-console'] = linkVal;
  if (!pkg.dsh.profile.bundles.includes('qq-mode-console')) pkg.dsh.profile.bundles.push('qq-mode-console');
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  log(`profile package.json ensured: ${pkgFile}`);
}

/** 找 dsh CLI 并跑 `dsh plugin --profile <p> install`（DSH_HOME=target.home，纯读桌面二进制、只写隔离 home） */
export function runPluginInstall(target) {
  const cli = findDshCli();
  if (!cli) { log('dsh CLI 未找到：跳过 plugin install（扁平 link 已就位，presets/MCP 不受影响）'); return false; }
  const binJs = /bin\.js$/.test(cli) ? cli : '';
  const dshBin = binJs || path.join(path.dirname(cli), '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(dshBin)) { log(`dsh bin 不存在：${dshBin}，跳过 plugin install`); return false; }
  try {
    const r = spawnSync(process.execPath, [dshBin, 'plugin', '--profile', target.profile, 'install'], {
      encoding: 'utf8', timeout: 120000,
      windowsHide: true,   // 不弹黑色控制台窗口（父进程没有控制台时 Windows 会给子进程新建一个可见的）
      env: { ...process.env, DSH_HOME: target.home },
      cwd: path.dirname(dshBin),
    });
    if (r.status === 0) { log(`dsh plugin install (${target.profile}) OK`); return true; }
    log(`dsh plugin install 返回码 ${r.status ?? r.error?.message ?? '?'}；扁平 link 已兜底`);
  } catch (e) {
    log(`dsh plugin install 异常（跳过）: ${e?.message ?? e}`);
  }
  return false;
}

/** 一键安装到内置隔离 DSH（幂等；隔离实例需至少启动过一次产生 profiles/<profile>） */
export function installToIsolatedDsh(opts = {}) {
  const target = resolveDshTarget({ profile: opts.profile, allowDesktopHome: opts.allowDesktopHome });
  if (target.refusedDesktop) { warn(target.error); return { ok: false, ...target }; }
  if (opts.force && target.marker && fs.existsSync(target.marker)) {
    try { fs.rmSync(target.marker, { force: true }); } catch {}
    log('force 模式：已清除安装标记');
  }
  if (isInstalled(target)) { log(`已安装（marker），跳过: ${target.home}`); return { ok: true, ...target, skipped: true }; }
  if (!target.booted) {
    warn(`隔离 DSH 尚未初始化 profiles/${target.profile}（请先在 Manager 启动一次 dsh-isolated），本次跳过安装`);
    return { ok: false, ...target, error: 'isolated home 未初始化' };
  }
  installPresets(target);
  patchProfileCordis(target);
  ensurePluginBundles(target);
  runPluginInstall(target);
  writeInstallMarker(target);
  log(`安装完成: ${target.home}（profile=${target.profile}，版本 ${INSTALL_VERSION}）`);
  return { ok: true, ...target };
}

