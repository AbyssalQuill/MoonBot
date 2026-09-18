/* 直接从**跑起来的 MCP server** 上量每个工具的 schema 体积（字符数）—— 不用翻会话转录。
 *
 * 为什么要有这个：`src/tool-schema-chars.ts`（管理端「工具 schema 精简」卡的数据源）
 * 原来是从 DSH 会话转录里抽的（dump-tool-schema.mjs），转录是**过去某一刻的快照** ——
 * 之后新加的工具（pixiv / 联网找图 / 语音 / 角色卡…）就**一条都不会出现在表里**，
 * 表现是精简卡里根本看不到这些工具（既不能勾掉、也看不到它的体积）。
 * 现在改成**每次现问 server**：zod schema 由注册代码现场生成，量到的就是此刻的真实体积。
 *
 * 用法（在 qq-bridge 目录下）：
 *     node tools/mcp-tool-chars.mjs                 # 打印「字符数 工具名」，按体积倒序
 *     node tools/mcp-tool-chars.mjs --ts            # 直接输出 mcp__napcat__* 段落（TS 字面量），贴进 tool-schema-chars.ts
 *     node tools/mcp-tool-chars.mjs --json          # 输出 JSON，交给别的脚本合并
 *
 * 口径：= JSON.stringify({ name, description, inputSchema }) 的长度，
 * 与 DSH 实际下发的那份工具定义同构（`mcp__napcat__` 前缀算在名字里）。
 *
 * 【坑】精简名单（social.slimTools）开启时，被 deny 的工具**根本不注册** → 量不到。
 * 本脚本会临时把 config.json 的 social.slimTools.enabled 改成 false 再起 server，量完原样还原；
 * 所以**表里永远是全量**（界面才有得算"勾掉这个能省多少"）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'mcp__napcat__';
const MODE = process.argv[2] || '';

/* ── 1. 临时关掉精简名单（否则被 deny 的工具量不到） ───────────────────── */
const cfgPath = path.join(ROOT, 'config.json');
let cfgBackup = null;
try {
  const raw = fs.readFileSync(cfgPath, 'utf8');
  const cfg = JSON.parse(raw);
  if (cfg?.social?.slimTools?.enabled === true) {
    cfgBackup = raw;
    cfg.social.slimTools.enabled = false;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    console.error('[tool-chars] 已临时关闭 social.slimTools.enabled（量完还原）');
  }
} catch (error) {
  console.error('[tool-chars] 读 config.json 失败，按原样继续：' + (error?.message ?? error));
}

/* ── 2. 起 server，握手，tools/list ──────────────────────────────────── */
const child = spawn(process.execPath, ['src/mcp-napcat-safe.js'], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env
});

const pending = new Map();
let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg = null;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[server] ' + d.toString('utf8')));

const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
const call = (id, method, params) => new Promise((resolve, reject) => {
  pending.set(id, resolve);
  send({ jsonrpc: '2.0', id, method, params });
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, 30000);
});

let tools = null;
try {
  await call(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'tool-chars-dump', version: '1.0.0' }
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  const res = await call(2, 'tools/list', {});
  tools = res?.result?.tools ?? null;
} catch (error) {
  console.error('[tool-chars] 失败：' + (error?.message ?? error));
}

child.kill();

/* ── 3. 还原 config ──────────────────────────────────────────────────── */
if (cfgBackup !== null) {
  try { fs.writeFileSync(cfgPath, cfgBackup); console.error('[tool-chars] config.json 已还原'); } catch (error) {
    console.error('[tool-chars] 还原 config.json 失败（请手动还原！）：' + (error?.message ?? error));
  }
}

if (!tools) {
  console.error('[tool-chars] 没拿到工具表。');
  process.exit(1);
}

const rows = tools.map((t) => ({
  name: PREFIX + t.name,
  chars: JSON.stringify({ name: PREFIX + t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? {} }).length
})).sort((a, b) => b.chars - a.chars);

const total = rows.reduce((s, r) => s + r.chars, 0);

if (MODE === '--json') {
  console.log(JSON.stringify(rows, null, 2));
} else if (MODE === '--ts') {
  for (const r of rows) console.log(`  "${r.name}": ${r.chars},`);
  console.error(`[tool-chars] ${rows.length} 个工具，合计 ${total} 字符`);
} else if (MODE === '--write') {
  /* 把 src/tool-schema-chars.ts 就地重写：**mcp__napcat__ 那一段按现场实测全量替换**，
   * 其它（DSH 自带工具、别的 MCP server）原样保留 —— 那些量不到，只有 DSH 转录里才有。
   * 用法：node tools/mcp-tool-chars.mjs --write ../../src/tool-schema-chars.ts */
  const target = process.argv[3];
  if (!target) { console.error('[tool-chars] --write 需要给 ts 文件路径'); process.exit(1); }
  const tsPath = path.resolve(ROOT, target);
  const tsText = fs.readFileSync(tsPath, 'utf8');

  const kept = [];
  for (const m of tsText.matchAll(/^\s*"([^"]+)":\s*(\d+),?\s*$/gm)) {
    if (!m[1].startsWith(PREFIX)) kept.push({ name: m[1], chars: Number(m[2]) });
  }
  const merged = [...rows, ...kept].sort((a, b) => b.chars - a.chars);
  const grand = merged.reduce((s, r) => s + r.chars, 0);

  const body = merged.map((r) => `  ${JSON.stringify(r.name)}: ${r.chars},`).join('\n');
  const head = tsText.slice(0, tsText.indexOf('export const TOOL_SCHEMA_CHARS'));
  const tail = tsText.slice(tsText.indexOf('/** 只有这批工具受管理端'));
  const headFixed = head.replace(
    /\* 合计 \d+ 个工具 \d+ 字符，其中 mcp__napcat__ 系列 \d+ 个 \d+ 字符/,
    `* 合计 ${merged.length} 个工具 ${grand} 字符，其中 mcp__napcat__ 系列 ${rows.length} 个 ${total} 字符`
  );
  fs.writeFileSync(tsPath, `${headFixed}export const TOOL_SCHEMA_CHARS: Record<string, number> = {\n${body}\n};\n\n${tail}`);
  console.log(`[tool-chars] 已重写 ${tsPath}`);
  console.log(`[tool-chars] ${merged.length} 个工具合计 ${grand} 字符；其中 mcp__napcat__ ${rows.length} 个 ${total} 字符（现场实测）`);
  console.log(`[tool-chars] 非 napcat 保留 ${kept.length} 条（来自原文件，量不到 —— 正常，那些是 DSH 自带/别的 server 的工具）`);
} else {
  console.log(`tool count=${rows.length}  total chars=${total}`);
  for (const r of rows) console.log(String(r.chars).padStart(7), r.name);
}
