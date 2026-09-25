#!/usr/bin/env node
/**
 * 「界面上真的渲染出中文」验证 —— 不用浏览器也能验。
 *
 * 做法：用项目自带的 esbuild 把真正的页面组件（src/pages/BridgeConfig.tsx、VoiceConfig.tsx）
 * 打成一个 Node 模块（只把 ../api 这个网络层换成空壳，其余代码原样），再用 react-dom/server
 * 的 renderToStaticMarkup 渲染成 HTML：
 *   · renderToStaticMarkup 只跑首次渲染、不跑 useEffect —— 所以不会真去请求桥接口；
 *   · 然后把 HTML 里的标签与属性全剥掉，只看文本节点，检查里面还会不会出现配置键名。
 * 覆盖范围：CommonTab（常用设置里的全部卡片）/ ToolsTab（工具开关）/ SlimToolsCard（工具 schema 精简）
 *          / Field 逐键渲染（配置树里的每个键都单独渲染一次）/ VoiceConfig 的角色名兜底。
 *
 * 用法：node tools/verify-rendered-labels.mjs
 * 退出码：0 = 渲染出来的文本里没有任何配置键名；1 = 有键名漏到文本里。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import React from 'react';
import ReactDOMServer from 'react-dom/server';

const { renderToStaticMarkup } = ReactDOMServer;
const h = React.createElement;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ---------- 1. 配置键清单（真实文件 + 桥声明的全部工具开关） ---------- */
const configs = ['qq-bridge/config.example.json', 'qq-bridge/config.json']
  .filter((f) => fs.existsSync(path.join(ROOT, f)))
  .map((f) => ({ file: f, obj: JSON.parse(read(f)) }));
const cfg = (configs.find((c) => c.file.endsWith('qq-bridge/config.json')) || configs[0]).obj;
const keyNames = new Set();
for (const c of configs) {
  (function walk(node) {
    for (const [k, v] of Object.entries(node)) {
      keyNames.add(k);
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v);
    }
  })(c.obj);
}

/* 2026-09-19 补：只看本机 config 会漏键：线上 config.json 里写着 social.tools.sendVoice /
   transcribeVoice，本机那份没有 —— 于是"页面上有没有漏出裸英文 key"这项检查，恰好在真正出问题
   的那两个键上失效（界面上看到「工具与规则」页里两行裸 key，就是这么来的）。
   这里把 core/config.js 声明的开关默认表整个并进来，检查面 = 桥真正支持的开关集合。 */
const configJsPath = path.join(ROOT, 'qq-bridge', 'src', 'core', 'config.js');
if (fs.existsSync(configJsPath)) {
  const defaults = fs.readFileSync(configJsPath, 'utf8').match(/tools:\s*\{([\s\S]*?)\n\s*\}/);
  const switchKeys = defaults ? [...defaults[1].matchAll(/([A-Za-z][A-Za-z0-9_]*)\s*:/g)].map((m) => m[1]) : [];
  cfg.social = cfg.social || {};
  cfg.social.tools = cfg.social.tools || {};
  for (const k of switchKeys) {
    if (!(k in cfg.social.tools)) cfg.social.tools[k] = true;
    keyNames.add(k);
  }
  console.log(`[labels] 工具开关覆盖 ${switchKeys.length} 个（含 core/config.js 的默认表）`);
}

/* ---------- 2. 用 esbuild 打出可被 Node 导入的探测模块（../api 换成空壳） ---------- */
/** 把 src 下所有文件从 '../api' 导入的名字收集起来，生成空壳模块 ——
 *  这样页面新增一个 api 函数时，本脚本不用跟着改（少一处会过期的清单）。 */
function collectApiExports() {
  const names = new Set();
  const files = [];
  (function walkDir(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walkDir(p);
      else if (/\.tsx?$/.test(ent.name)) files.push(p);
    }
  })(path.join(ROOT, 'src'));
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'\.\.?\/api'/g)) {
      for (const raw of m[1].split(',')) {
        const part = raw.trim();
        if (!part || /^type\s/.test(part)) continue;
        const name = part.split(/\s+as\s+/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
      }
    }
  }
  return [...names];
}
const apiNames = collectApiExports();
const API_STUB = `
const noop = async () => ({ ok: true });
const handler = { get: () => noop };
${apiNames.map((n) => `export const ${n} = noop;`).join('\n')}
export default new Proxy({}, handler);
`;
/* 探测模块必须落在仓库内（node 从它所在目录往上找 node_modules，放系统临时目录会因为
   解析不到 react 而报 ERR_MODULE_NOT_FOUND）；写在 tools/.tmp/ 下，跑完即删，不进任何打包产物。 */
const tmpDir = path.join(ROOT, 'tools', '.tmp');
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });
process.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ } });
const apiStubPlugin = {
  name: 'api-stub',
  setup(build) {
    build.onResolve({ filter: /(^|\/)api$/ }, (args) => ({ path: args.path, namespace: 'api-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'api-stub' }, () => ({ contents: API_STUB, loader: 'js' }));
  },
};
async function buildProbe(srcPath, extraExports, transform) {
  const out = path.join(tmpDir, path.basename(srcPath).replace(/\.tsx?$/, '') + (transform ? '.on' : '') + '.probe.mjs');
  const source = transform ? transform(read(srcPath)) : read(srcPath);
  await esbuild.build({
    stdin: {
      contents: source + `\n;export { ${extraExports} };\n`,
      resolveDir: path.dirname(path.join(ROOT, srcPath)),
      sourcefile: path.basename(srcPath),
      loader: 'tsx',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    jsx: 'automatic',
    packages: 'external',            // react / lucide-react 用真包，避免打进第二份 React（hooks 会炸）
    plugins: [apiStubPlugin],
    outfile: out,
    logLevel: 'silent',
  });
  return import(pathToFileURL(out).href);
}

/* ---------- 3. HTML → 文本节点 ---------- */
function textOf(html) {
  return html
    .replace(/<textarea[\s\S]*?<\/textarea>/g, ' ')   // textarea 里是配置的值（可能整段英文提示词），不是字段名
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
const CAMEL = /\b[a-z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g;   // refreshOnMessageMs 这种
const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;             // qq_send_message 这种

const bridge = await buildProbe('src/pages/BridgeConfig.tsx',
  'Field, CommonTab, ToolsTab, SlimToolsCard, pretty, prettyTool, mcpLabel, LABEL, TOOL_LABEL, MCP_LABEL, UNNAMED_LABEL');
/* 第二份探针：把「显示 MCP 工具原名」的开关默认值改成 true，
   用来验证勾开之后也只会多出工具原名（不是配置键名）。 */
const bridgeRaw = await buildProbe('src/pages/BridgeConfig.tsx',
  'ToolsTab, SlimToolsCard, UNNAMED_LABEL',
  (src) => src.replace(/const \[showRaw, setShowRaw\] = useState\(false\);/g, 'const [showRaw, setShowRaw] = useState(true);'));
const voiceMod = await buildProbe('src/pages/VoiceConfig.tsx', 'ROLE_LABEL, roleName, ROLE_ORDER');

const noop = () => {};
const ch = () => () => {};
const renders = [];
const push = (name, el) => {
  const html = renderToStaticMarkup(el);
  renders.push({ name, html, text: textOf(html) });
};

/* 3.1 常用设置的全部卡片（用真实 config.json 当数据） */
push('CommonTab（常用设置全部卡片）', h(bridge.CommonTab, {
  cfg, ch, onHelp: noop, uploadStickers: async () => {}, remote: null,
  writeConfig: async () => ({ ok: true }), onCfgChange: noop,
}));
/* 3.2 工具开关 / 工具 schema 精简（默认不显示英文原名） */
push('ToolsTab（工具开关 + 精简名单）', h(bridge.ToolsTab, { cfg, ch, onSave: async () => {} }));
push('SlimToolsCard（精简名单逐行）', h(bridge.SlimToolsCard, { cfg, ch, onSave: async () => {} }));
/* 3.2b 把「显示 MCP 工具原名」勾开：只该多出工具原名，不该多出配置键名 */
push('ToolsTab（勾开显示原名）', h(bridgeRaw.ToolsTab, { cfg, ch, onSave: async () => {} }));
push('SlimToolsCard（勾开显示原名）', h(bridgeRaw.SlimToolsCard, { cfg, ch, onSave: async () => {} }));

/* 3.3 配置树里的每个键都单独渲染一次 Field（最坏情况：任何键都漏不掉） */
const flatKeys = [];
(function walk(node, prefix) {
  for (const [k, v] of Object.entries(node)) {
    const p = prefix ? `${prefix}.${k}` : k;
    flatKeys.push(p);
    if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
  }
})(cfg, '');
/** 键不在 config.json 里时（例如 social.typing.*）按名字造一个同类型的值，保证 Field 会渲染出来 */
function synth(pathStr) {
  const cur = pathStr.split('.').reduce((x, k) => (x ? x[k] : undefined), cfg);
  if (cur !== undefined) return cur;
  const last = pathStr.split('.').pop() || '';
  if (/^(enabled|[a-z]*Enabled|includeInPrompt|privateOnly|recommendedDefaultInfinite|autoHeal|allVoice|autoResearch|injectIntoPrompt)$/.test(last)) return true;
  if (/(Probability|Ratio)$/.test(last)) return 0.15;
  if (/(Ms|Sec|Minutes|Days|Hours|Count|Limit|Max|Min|Threshold|Chars|Ahead|Port|Interval|Length|Size|Batch|Quota)$/.test(last)) return 1234;
  if (/^(keys|deny|recommendedKeywords|inferenceThresholds|trustedCrossSessionUids|deepsleepGroups|dockerPathMap)$/.test(last)) return [];
  if (/(Url|Dir|Path)$/.test(last)) return 'http://127.0.0.1:3000';
  return '示例值';
}
push('Field 逐键渲染（配置树全部键）', h('div', null,
  flatKeys.map((p) => h(bridge.Field, {
    key: p, path: p, val: synth(p), label: bridge.pretty(p.split('.').pop()), ch, onHelp: noop, cfg,
  }))));

/* ---------- 4. 抽查：挑几个键，看它渲染出来的字段名到底是什么 ---------- */
/** 合并两份配置后按路径取值：config.json 里没有的键（例如 social.typing.*）用 config.example.json 的真值 */
const merged = Object.assign({}, ...configs.map((c) => c.obj));
const at = (p) => p.split('.').reduce((x, k) => (x ? x[k] : undefined), merged);
const sampleKeys = [
  'social.typing.holdMaxMs', 'social.typing.refreshOnMessageMs', 'social.typing.breakProbability',
  'guard.probeIntervalMs', 'social.sessionArchive.idleMinutes', 'social.send.gapPerCharMs',
];
const spot = sampleKeys.map((p) => {
  const html = renderToStaticMarkup(h(bridge.Field, {
    path: p, val: at(p) ?? synth(p), label: bridge.pretty(p.split('.').pop()), ch, onHelp: noop, cfg,
  }));
  const text = textOf(html);
  const last = p.split('.').pop();
  return { path: p, rendered: text.slice(0, 70), hasRawKey: text.includes(last) };
});
/* 分组名（对象型键当小标题）：用真实配置里的对象渲染 */
const groupSpot = ['social.sticker.collect', 'social.slimTools', 'social.sessionArchive', 'guard', 'social.typing'].map((p) => {
  const html = renderToStaticMarkup(h(bridge.Field, {
    path: p, val: at(p) ?? {}, label: bridge.pretty(p.split('.').pop()), ch, onHelp: noop, cfg,
  }));
  return { path: p, rendered: textOf(html).slice(0, 90) };
});

/* ---------- 5. 判定 ---------- */
/* 文本里允许出现的英文（协议 / 文件 / 工具原名 / 配置取值本身）：它们不是字段名，
   翻掉反而看不懂 —— 逐条列在这里，新增必须显式加进来。 */
const ALLOW = [
  /^mcp__napcat__$/, /^qq_[a-z_]+$/, /^mcp$/i, /^todo_write$/, /^ask_user_question$/, /^get_rkey$/,
  /^napcat(_qq)?$/, /^napcat-qq$/, /^webui$/i, /^json$/i, /^truefriend$/, /^md5$/i,
  /^NAPCAT_QUICK_PASSWORD_MD5$/, /^config\.json$/, /^persona\.md$/, /^speech-rules\.md$/, /^webui\.json$/,
  /^state$/, /^activity-windows\.json$/, /^profiles\.json$/, /^docker$/, /^restart$/, /^mimo_default$/,
  /^characters?$/, /^js$/, /^md$/, /^sk$/, /^vbs$/i, /^onekey$/i, /^deepseek$/i, /^api$/i, /^key$/i,
  /^ws$/i, /^http$/i, /^https$/i, /^token$/i, /^dsh$/i, /^tts$/i, /^asr$/i, /^url$/i, /^qq$/i,
  /^png$/i, /^jpeg$/i, /^gif$/i, /^mp3$/, /^wav$/, /^deepseek-v4-pro$/, /^xhigh$/, /^max$/, /^off$/,
  /^low$/, /^high$/, /^medium$/, /^minimal$/, /^none$/, /^sh$/,
  /^\d+[a-z]*$/,                                     // 127.0.0.1:10721 这类数字/端口
  // 2026-09-19：「没有独立开关的工具」那一栏会列出宿主侧与联网工具的工具原名
  // （mcp-host-server.js / mcp-web-search-safe.js 注册的，不是字段名，也不是 config 键）
  /^web_(search|fetch)$/, /^napcat_status$/, /^(start|stop)_napcat$/, /^qq_learning_(corpus|submit)$/,
];
const hits = [];
const allowed = new Map();
for (const r of renders) {
  for (const re of [CAMEL, SNAKE]) {
    for (const m of r.text.matchAll(re)) {
      const tok = m[0];
      const ctx = r.text.slice(Math.max(0, m.index - 45), m.index + 45);
      if (ALLOW.some((a) => a.test(tok))) { if (!allowed.has(tok)) allowed.set(tok, { tok, ctx }); continue; }
      hits.push({ where: r.name, tok, ctx });
    }
  }
}
/* 硬判据：渲染出来的文本里，绝不允许出现任何一个配置键名（字段名必须已翻成中文） */
const keyHits = [];
for (const r of renders) {
  for (const k of keyNames) {
    if (k.length < 4) continue;                        // send / keys / enabled 这类会被正常中文文本误命中
    const re = new RegExp(`(^|[^A-Za-z0-9_.])${k}([^A-Za-z0-9_.]|$)`);
    if (re.test(r.text)) {
      const i = r.text.search(re);
      keyHits.push({ where: r.name, key: k, ctx: r.text.slice(Math.max(0, i - 45), i + 55) });
    }
  }
}

/* ---------- 5. 构建产物抽查：抽样键在 dist 里是不是「键 → 中文标签」 ---------- */
const distDir = path.join(ROOT, 'dist', 'assets');
const bundles = fs.existsSync(distDir)
  ? fs.readdirSync(distDir).filter((f) => /^index-.*\.js$/.test(f)).map((f) => ({ f, t: fs.statSync(path.join(distDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  : [];
const bundleName = bundles[0]?.f || null;
const bundleText = bundleName ? fs.readFileSync(path.join(distDir, bundleName), 'utf8') : '';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bundleSpot = sampleKeys.map((p) => {
  const last = p.split('.').pop();
  const occ = bundleText ? [...bundleText.matchAll(new RegExp(`(?:["'\`]?${esc(last)}["'\`]?|["'\`]${esc(p)}["'\`])\\s*:\\s*["'\`]([^"'\`]*)["'\`]`, 'g'))] : [];
  const all = bundleText ? [...bundleText.matchAll(new RegExp(esc(last), 'g'))].map((m) => m.index) : [];
  // 非「键: 标签」的出现处：应当是读取/写入配置用的路径字符串（'social.typing.xxx'），不是界面文字
  const otherUse = all.filter((i) => !/^\s*:\s*["'`]/.test(bundleText.slice(i + last.length, i + last.length + 8)))
    .map((i) => bundleText.slice(Math.max(0, i - 28), i + last.length + 20).replace(/\s+/g, ' '));
  return { key: p, last, count: occ.length, labels: occ.map((m) => m[1]).filter((v) => v && /[\u4e00-\u9fff]/.test(v)).slice(0, 4), total: all.length, otherUse: [...new Set(otherUse)].slice(0, 2) };
});

console.log('MoonBot 管理端「渲染成中文」验证（react-dom/server 真渲染 + 构建产物抽查，不用浏览器）');
console.log('─'.repeat(72));
console.log(`渲染数据      : ${configs.map((c) => c.file).join('、')}（本页渲染用 config.json）`);
console.log(`渲染组件      : CommonTab / ToolsTab / SlimToolsCard / Field×${flatKeys.length}（配置树全部键）`);
console.log(`渲染出的文本  : ${renders.map((r) => `${r.name.split('（')[0]}=${r.text.length}字`).join(' · ')}`);
console.log('─'.repeat(72));
console.log('抽查：单独渲染某个键的 Field，看字段名渲染成了什么 ——');
for (const s of spot) console.log(`  · ${s.path}\n      → ${s.rendered}${s.hasRawKey ? '   ❌ 字段名里还有英文键名' : ''}`);
console.log('抽查：对象型键（当小标题渲染） ——');
for (const g of groupSpot) console.log(`  · ${g.path}\n      → ${g.rendered}`);
const roleOut = voiceMod.ROLE_ORDER.map((id) => `${id} → ${voiceMod.roleName(id)}`).join('、');
console.log(`语音页角色名兜底：${roleOut}`);
console.log(`兜底占位符    : pretty('不认识的新键') = ${bridge.pretty('一个还不存在的键')}（UNNAMED_LABEL=${bridge.UNNAMED_LABEL}）`);
console.log('─'.repeat(72));
console.log(`构建产物抽查  : dist/assets/${bundleName || '（还没构建，先跑 npm run build）'}`);
for (const b of bundleSpot) {
  console.log(`  · ${b.key}\n      bundle 里的「键: 中文标签」条目 ${b.count} 条 → ${b.labels.length ? b.labels.join(' / ') : '❌ 没找到中文标签'}`);
  console.log(`      该键名在 bundle 里共出现 ${b.total} 次，其余 ${b.otherUse.length ? '都是读取/写入路径，不是界面文字' : '无'}：`);
  for (const u of b.otherUse) console.log(`        …${u}…`);
}
console.log('─'.repeat(72));
console.log(`渲染文本里的配置键名 = ${keyHits.length}`);
for (const k of keyHits.slice(0, 40)) console.log(`  · [${k.where}] ${k.key}\n      …${k.ctx}…`);
const residual = [...new Map(hits.map((x) => [x.tok, x])).values()];
console.log('');
console.log(`渲染文本里「有意保留」的技术引用（协议 / 文件 / 工具原名 / 配置取值，不是字段名）= ${allowed.size} 种：`);
for (const x of allowed.values()) console.log(`  · ${x.tok}   ← …${x.ctx}…`);
console.log('');
console.log(`渲染文本里的其它英文标识符（未登记，应为 0）= ${residual.length} 种：`);
for (const x of residual) console.log(`  · [${x.where}] ${x.tok}   ← …${x.ctx}…`);
console.log('');
if (keyHits.length === 0 && residual.length === 0 && bundleSpot.every((b) => b.labels.length > 0)) {
  console.log('✅ 组件真实渲染出来的文本里没有任何配置键名；抽查的键在构建产物里都是「键 → 中文标签」。');
  process.exit(0);
}
if (keyHits.length > 0) console.log('❌ 有配置键名被渲染进了界面文本。');
if (residual.length > 0) console.log('❌ 出现了没登记过的英文标识符（要么翻掉，要么加进 ALLOW 并说明理由）。');
if (!bundleSpot.every((b) => b.labels.length > 0)) console.log('❌ 抽查的键在构建产物里找不到中文标签（是不是没重新构建？）。');
process.exit(1);
