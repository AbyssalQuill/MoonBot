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
  /* 【2026-09-22 修一处会静默失效的名单】这里原来写的是 `['default', 'liangshen']`，
   * 而仓库里实际只有 `dsh/agent-presets/{default, qq-chat}` —— `liangshen` 源不存在，只打一行 skip，
   * 于是 `qq-chat` 这套 preset **永远不会被装进隔离 DSH**；一旦有人把 `agentPreset` 改成 `qq-chat`，
   * `core/dsh-session.js` 会传一个 home 里根本不存在的 preset 名（建会话时才绑 preset）。
   * 现在按仓库真实存在的目录来装：default 必装，另一套若在就一起装（找不到只 skip，不报错）。 */
  for (const name of ['default', 'qq-chat']) {
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

/* 桥把当前配置注进来（installToIsolatedDsh 拿不到 cfg，而代理开关来自配置）。 */
let sideCfg = null;
export function setDshSideConfig(cfg) { sideCfg = cfg || null; }

/* ── 【2026-09-21】MCP 工具压缩代理（开源 mcp-compressor）────────────────────────────
 * 主人要求"用那套开源 MCP 压缩工具"。它是个**代理**：DSH 不再直连我们的 napcat MCP，
 * 而是连它，由它把 90 个工具压成 2 个包装工具（`<server>_invoke_tool` / `_get_tool_schema`），
 * 工具清单塞进包装工具的描述里。实测（挂我们真实的 90 个工具跑）：
 *     low 38.8% · medium 14.0% · **high 6.2%** · max 3.6%（相对完整工具表）
 * 代价：模型遇到不熟的工具要先 get_tool_schema 再 invoke_tool = **一步变两步**；
 *      桥侧靠工具名做的判断必须先解包（见 core/mux.js 的 unwrapCompressedToolName）。
 *
 * ⚠️ 必须有 fallback：压缩机没装 / 起不来时**绝不能**把工具表搞没（那等于机器人失能）。
 *    所以这里只做一次廉价的可用性探测，探不到就直连，并把原因写进日志。
 */
export const COMPRESSOR_LEVELS = ['low', 'medium', 'high', 'max'];
export function normalizeCompressorLevel(v) {
  const id = String(v ?? '').trim().toLowerCase();
  return COMPRESSOR_LEVELS.includes(id) ? id : 'medium';
}

let compressorProbe = null;      // { ok, command, version, reason, at }
/** 找 mcp-compressor 可执行文件（PATH 里有就直接用，否则探常见安装位置），结果缓存 10 分钟。
 *  【2026-09-21 Windows 上实测到的坑】`pip install mcp-compressor` 装出来的是
 *  `%LOCALAPPDATA%\Programs\Python\Python3XX\Scripts\mcp-compressor.exe`，
 *  它在**当前 shell 的 PATH 里**（`where mcp-compressor` 找得到），但 DSH 是管理器拉起的进程、
 *  继承的是另一个环境，PATH 不一定带 Python 的 Scripts 目录 —— 于是"明明装了却判成没装"、
 *  静默回退直连。所以这里把 Windows 上几个常见的 Scripts 位置也列成候选（含版本通配）。 */
export function compressorCandidates() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const list = [
    process.env.QQB_MCP_COMPRESSOR || '',
    'mcp-compressor',
    '/usr/local/bin/mcp-compressor',
    '/usr/bin/mcp-compressor',
    path.join(home, '.local', 'bin', 'mcp-compressor'),
  ];
  // Windows：%LOCALAPPDATA%\Programs\Python\Python3*\Scripts\mcp-compressor.exe
  try {
    const bases = [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Launcher'),
      'C:\\Python313', 'C:\\Python312', 'C:\\Python311',
    ].filter((b) => b && fs.existsSync(b));
    for (const base of bases) {
      let subs = [];
      try { subs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && /^Python3/i.test(e.name)).map((e) => e.name); } catch { /* 忽略 */ }
      for (const sub of subs) list.push(path.join(base, sub, 'Scripts', 'mcp-compressor.exe'));
      list.push(path.join(base, 'Scripts', 'mcp-compressor.exe'));
    }
  } catch { /* 忽略 */ }
  return [...new Set(list.filter(Boolean))];
}

export function resolveToolCompressor({ log = () => {}, force = false } = {}) {
  const now = Date.now();
  if (!force && compressorProbe && now - compressorProbe.at < 10 * 60 * 1000) return compressorProbe;
  const cands = compressorCandidates();
  for (const c of cands) {
    try {
      const isPath = /[\\/]/.test(c);
      if (isPath) {
        if (!fs.existsSync(c)) continue;
        const r = spawnSync(c, ['--version'], { timeout: 8000, encoding: 'utf8' });
        // 路径存在但要能真的跑起来（有的机器只剩个坏掉的 shim）
        compressorProbe = { ok: r.status === 0, command: c, version: String(r.stdout || '').trim().slice(0, 40), reason: 'path', at: now };
        if (compressorProbe.ok) { log(`[dsh-side] 找到 MCP 压缩代理：${c} ${compressorProbe.version}`); return compressorProbe; }
        continue;
      }
      const r = spawnSync(c, ['--version'], { timeout: 8000, encoding: 'utf8' });
      if (r.status === 0) {
        compressorProbe = { ok: true, command: c, version: String(r.stdout || '').trim().slice(0, 40), reason: 'which', at: now };
        log(`[dsh-side] 找到 MCP 压缩代理：${c} ${compressorProbe.version}`);
        return compressorProbe;
      }
    } catch { /* 试下一个 */ }
  }
  compressorProbe = { ok: false, command: '', reason: '未找到 mcp-compressor 可执行文件（pip 装一个即可：pip3 install mcp-compressor）', at: now };
  log(`[dsh-side] 未找到 MCP 压缩代理，工具代理关闭：${compressorProbe.reason}`);
  return compressorProbe;
}

function mcpBlock() {
  const node = process.execPath;
  const servers = {
    'mcp-napcat': path.join(REPO_ROOT, 'src', 'mcp-napcat-safe.js'),
    'mcp-napcat-host': path.join(REPO_ROOT, 'src', 'mcp-host-server.js'),
    'mcp-web-search-safe': path.join(REPO_ROOT, 'src', 'mcp-web-search-safe.js'),
  };
  // 压缩代理只挂在 napcat 这一路上（工具最多、体积最大）；另两个保持直连。
  const tc = sideCfg?.social?.toolCompressor ?? {};
  /* 【2026-09-21 主人定稿】压缩代理**默认恒开** —— 只有显式写 `enabled: false` 才关。
   * 语义从"必须显式打开"改成"除非显式关掉"：老配置里没有这个键 → 自动走代理（这才是主人要的"默认就用它"）。
   * 仍然保留关闭开关：代理是 Python 进程，出问题时要能一键回到直连。 */
  const wantProxy = tc.enabled !== false;
  const probe = wantProxy ? resolveToolCompressor({ log }) : { ok: false, reason: '未启用' };
  const useProxy = wantProxy && probe.ok;
  if (wantProxy && !probe.ok) log(`[dsh-side] 工具压缩代理已勾选但不可用，回退直连：${probe.reason}`);

  let out = '# === qq-bridge MCP BEGIN ===\n';
  for (const [id, script] of Object.entries(servers)) {
    out += '- insert:\n';
    out += `    - id: ${id}\n`;
    out += `      name: '@deepseek-ai/dsh-mcp-client'\n`;
    out += `      config:\n`;
    out += `        serverName: ${id.replace('mcp-', '')}\n`;
    out += `        transport: stdio\n`;
    if (id === 'mcp-napcat' && useProxy) {
      const level = normalizeCompressorLevel(tc.level);
      const exclude = Array.isArray(tc.excludeTools) ? tc.excludeTools.map(String).filter(Boolean) : [];
      out += `        command: ${yamlQuoteForPath(probe.command)}\n`;
      out += `        args:\n`;
      out += `          - '-c'\n          - ${level}\n`;
      out += `          - '-n'\n          - napcat\n`;
      if (exclude.length) out += `          - '--exclude-tools'\n          - ${exclude.join(',')}\n`;
      if (tc.toonify === true) out += `          - '--toonify'\n`;
      out += `          - '--'\n`;
      out += `          - ${yamlQuoteForPath(node)}\n`;
      out += `          - ${yamlQuoteForPath(script)}\n`;
      log(`[dsh-side] napcat MCP 走压缩代理：档位=${level}${exclude.length ? ` 排除 ${exclude.length} 个` : ''}（工具表由代理发给模型）`);
    } else {
      out += `        command: ${yamlQuoteForPath(node)}\n`;
      out += `        args:\n`;
      out += `          - ${yamlQuoteForPath(script)}\n`;
    }
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

/* ── 内置长期记忆插件（@meomeo-dev/dsh-memory）────────────────────────────────────────
 * 【2026-09-20 主人要求】"把桌面端 DSH 的记忆插件（remember）集成到项目内置 dsh 里"，
 * 目的是让 QQ 机器人**长久记住主人的要求和教训**（跨会话），而不是只靠每次唤醒的上下文。
 *
 * 为什么走"随包 vendored + link"这条路（而不是让目标机 npm install）：
 *   · 装机环境经常没网/没 npm，链式安装会在客户机上失败，而这是**出厂能力**；
 *   · 与 qq-mode-console / dsh-qq-hold 两个自带插件同一套落点约定，行为可预期；
 *   · 插件只有 peerDependencies（cordis / dsh-tools / dsh-llm / dsh-settings / dsh-system-prompt），
 *     这些由随包 DSH 发行版提供，所以源码直接放进 plugins/ 就能加载，不需要它的 node_modules。
 * 落点（幂等，Windows 用 junction、Linux 用 symlink）：
 *   ① <home>/plugins/dsh-memory                     → <qq-bridge>/plugins/dsh-memory
 *   ② <home>/profiles/node_modules/@meomeo-dev/dsh-memory → 同一份源码（profile 共享安装面）
 *   ③ <profile>/package.json 的 dependencies + dsh.profile.bundles 注册这个 bundle
 *   ④ settings.yaml 的 memory 段：provider/model 跟着本实例的 agent-default-model 走
 *      （否则默认值 deepseek-official 在非官方 provider 的实例上会让 recall/抽取一直失败） */
export const MEMORY_PLUGIN_PKG = '@meomeo-dev/dsh-memory';
const MEMORY_PLUGIN_DIRNAME = 'dsh-memory';

/** 读 <home>/settings.yaml 里的 agent-default-model（provider/model）——极简解析，够用且不引依赖。 */
export function readDefaultModel(home) {
  try {
    const text = fs.readFileSync(path.join(home, 'settings.yaml'), 'utf8');
    const block = /(?:^|\n)agent-default-model:[\s\S]*?(?=\n\S|$)/.exec(text);
    if (!block) return { provider: '', model: '' };
    /* 必须**按行首锚定**再取 key：块里第一行是 `agent-default-model:` 本身，
     * 宽松的 /model:\s*(...)/ 会命中它内部的 "model:" 尾巴，把下一行的 "provider:" 当成模型名
     * （2026-09-20 实测踩到：settings 里写成了 model: provider:）。 */
    const provider = /^[ \t]+provider:[ \t]*([^\s#]+)/m.exec(block[0]);
    const model = /^[ \t]+model:[ \t]*([^\s#]+)/m.exec(block[0]);
    return { provider: provider?.[1] ?? '', model: model?.[1] ?? '' };
  } catch { return { provider: '', model: '' }; }
}

/**
 * 把 memory 段写进 <home>/settings.yaml（幂等：已有 memory 段就整段替换，其余内容一字不动）。
 * `summaryMode: all` 是**故意的**：这个插件只把 global 层逐条注入系统提示词，user/project 层只给计数，
 * 而 remember 工具只允许写 user/project 两层 —— 用默认的 global 模式，机器人自己写下的要求/教训
 * **每次都得先 recall 一次模型调用**才看得见。用 all 模式它们一直都在眼前（代价是每步多几百~几千字符，
 * 见 README 的用量说明；条目写少而精就不明显）。
 *
 * 【2026-09-21 成本实测后改 extractInterval：8 → 40（主人要求"把这类重建减半"）】
 * 拿线上 14 天、5,326 次请求复盘账单发现：**72% 的钱花在"未命中输入"，而其中 42% 来自单次重读 ≥60k token
 * 的请求**（平均一次重读 116,925 token、单次 ¥0.155），成因就是上下文被重建 —— 而这个插件的记忆摘要
 * 写在**系统提示词**里，**每写一条记忆就把整个前缀作废一次**（实测 09-20 一天 132 次 prune + 78 次 summary）。
 * `extractMode: event-counter` + `extractInterval` 决定"攒多少个事件提炼一次"：
 *   8  → 平均每 8 个事件就可能写一条 → 一天十几次前缀作废；
 *   40 → 频率降到 1/5，省下的正是那 42% 里的一大块。
 * 代价是"自动学到的规矩/教训"入库变慢（仍然会学，只是没那么勤）；主人显式说"记住…"时走的是
 * qq_memory_remember / remember 工具，**不受这个间隔影响**。
 * 要恢复更勤的学习：把 extractInterval 改回小值，或把 autoExtract 设为 false 彻底关掉自动提炼。
 */
export function ensureMemorySettings(target) {
  if (isDesktopDshHome(target.home)) throw new Error(`refuse: desktop home ${target.home}`);
  const file = path.join(target.home, 'settings.yaml');
  const { provider, model } = readDefaultModel(target.home);
  const lines = [
    'memory:',
    `  provider: ${provider || 'deepseek-official'}`,
    `  model: ${model || 'deepseek-v4-flash'}`,
    `  reviewModel: ${model || 'deepseek-v4-flash'}`,
    '  warmupOnStart: true',
    '  autoExtract: true',
    '  extractMode: event-counter',
    '  extractInterval: 40',
    '  summaryMode: all',
    '  recallTopK: 10',
    '  maxNodeKb: 600',
  ].join('\n');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* 首次：文件还不存在 */ }
  const re = /(^|\n)memory:[\s\S]*?(?=\n\S|$)/;
  const next = re.test(text) ? text.replace(re, `\n${lines}`) : `${text.trimEnd()}${text.trim() ? '\n' : ''}${lines}\n`;
  try {
    fs.writeFileSync(file, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
    log(`settings.yaml memory 段已就位（provider=${provider || '(默认)'} model=${model || '(默认)'}）`);
    return true;
  } catch (e) { warn(`写 settings.yaml 失败：${e?.message ?? e}`); return false; }
}

/** 幂等装配内置记忆插件，返回是否装配成功。
 *
 * ⚠️ 这里**必须是真实拷贝**，不能像其它插件那样只做 junction —— 2026-09-20 实测踩到：
 *   `Cannot find package '@deepseek-ai/dsh-tools' imported from <repo>/plugins/dsh-memory/lib/src/index.js`
 * 原因：Node 解析裸包名时按**真实路径**向上找 node_modules。用 junction 指回仓库时，真实路径是
 * `<repo>/qq-bridge/plugins/dsh-memory`，往上只有 `qq-bridge/node_modules`（出厂只带了 schemastery，
 * 因为 qq-mode-console 恰好只用它）；而这个插件 import 了 @deepseek-ai/dsh-tools / dsh-llm / dsh-settings /
 * dsh-system-prompt / dsh-commands —— 仓库里一个都没有，于是整棵插件树加载失败（隔离 DSH 直接起不来）。
 * 真实拷贝到 `<home>/profiles/node_modules/@meomeo-dev/dsh-memory` 后，向上解析会命中
 * `<home>/profiles/node_modules`（= 随包 DSH 的扁平安装面，上面几个包都在），与 npm 装出来的市场插件同一条路。
 * 拷贝用签名（版本 + 文件数 + 字节数 + 最新 mtime）判新旧，变了才重拷，启动开销可忽略。 */
export function ensureMemoryPlugin(target) {
  if (isDesktopDshHome(target.home)) throw new Error(`refuse: desktop home ${target.home}`);
  const repoPlugin = path.join(REPO_ROOT, 'plugins', MEMORY_PLUGIN_DIRNAME);
  if (!fs.existsSync(path.join(repoPlugin, 'package.json'))) {
    warn(`记忆插件源码不存在，跳过：${repoPlugin}`);
    return false;
  }
  const destDir = path.join(target.home, 'profiles', 'node_modules', ...MEMORY_PLUGIN_PKG.split('/'));
  const sigFile = path.join(destDir, '.qqbridge-vendored.json');
  const sig = sourceSignature(repoPlugin);
  let needCopy = true;
  try {
    const prev = JSON.parse(fs.readFileSync(sigFile, 'utf8'));
    if (prev && prev.sig === sig && fs.existsSync(path.join(destDir, 'lib', 'src', 'index.js'))) needCopy = false;
  } catch { /* 没有签名就当需要拷 */ }
  if (needCopy) {
    try {
      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      fs.rmSync(destDir, { recursive: true, force: true });
      fs.cpSync(repoPlugin, destDir, { recursive: true });
      fs.writeFileSync(sigFile, JSON.stringify({ sig, from: repoPlugin, at: new Date().toISOString() }, null, 2), 'utf8');
      log(`plugins/${MEMORY_PLUGIN_DIRNAME} 已拷贝到 ${destDir}（${sig}）`);
    } catch (e) {
      warn(`拷贝记忆插件失败：${e?.message ?? e}`);
      return false;
    }
  }
  // <home>/plugins/dsh-memory 只作"看得见的落点"（与另两个自带插件一致）；解析仍走上面那份拷贝
  ensureSymlink(path.join(target.home, 'plugins', MEMORY_PLUGIN_DIRNAME), destDir, `plugins/${MEMORY_PLUGIN_DIRNAME}`);
  const pkgFile = path.join(target.profileDir, 'package.json');
  ensureDir(target.profileDir);
  let pkg = { name: `dsh-profile-${target.profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  if (fs.existsSync(pkgFile)) {
    try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); } catch (e) { throw new Error(`解析 ${pkgFile} 失败: ${e?.message ?? e}`); }
  }
  pkg.dependencies = (pkg.dependencies && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies)) ? pkg.dependencies : {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];
  const linkVal = `link:${path.join(target.home, 'plugins', MEMORY_PLUGIN_DIRNAME).replace(/\\/g, '/')}`;
  if (pkg.dependencies[MEMORY_PLUGIN_PKG] !== linkVal) pkg.dependencies[MEMORY_PLUGIN_PKG] = linkVal;
  if (!pkg.dsh.profile.bundles.includes(MEMORY_PLUGIN_PKG)) pkg.dsh.profile.bundles.push(MEMORY_PLUGIN_PKG);
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  log(`profile package.json 已注册 ${MEMORY_PLUGIN_PKG}（dependencies + bundles）`);
  ensureMemorySettings(target);
  return true;
}

/** 源码签名：版本 + 文件数 + 字节数 + 最新 mtime（够判断"要不要重拷"，不做全量哈希免得每次启动都读 700KB）。 */
function sourceSignature(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    let files = 0; let bytes = 0; let newest = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        const st = fs.statSync(p);
        files += 1; bytes += st.size; newest = Math.max(newest, st.mtimeMs);
      }
    };
    walk(dir);
    return `${pkg.name}@${pkg.version}|${files}|${bytes}|${Math.round(newest)}`;
  } catch { return 'unknown'; }
}

/** 每次桥启动都跑一遍的内置插件装配（幂等）：qq-mode-console + 记忆插件。 */
export function ensureBuiltinPlugins(target) {
  try { ensurePluginBundles(target); } catch (e) { warn(`qq-mode-console 装配失败：${e?.message ?? e}`); }
  try { ensureMemoryPlugin(target); } catch (e) { warn(`记忆插件装配失败：${e?.message ?? e}`); }
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
  ensureBuiltinPlugins(target);
  runPluginInstall(target);
  writeInstallMarker(target);
  log(`安装完成: ${target.home}（profile=${target.profile}，版本 ${INSTALL_VERSION}）`);
  return { ok: true, ...target };
}

