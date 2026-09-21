// tools/tool-schema-meter.mjs — 量一量「每一个 MCP 工具在每次请求里值多少字符」
//
// 为什么需要它：实测 QQ 主会话一次请求 ≈ 26k token，其中 **87% 是工具 JSON schema**
// （tools 72,692 字符 ≈ 22.7k token，见 src/mcp-napcat-safe.js 顶部那段注释），而且**每一步都重发一次**。
// 于是"少注册一个用不到的工具"比"把提示词写短几个字"重要两个数量级 —— 但**该砍哪几个**必须拿数字说话，
// 不能凭感觉：一个 2,000 字符的工具顶得上二十个 100 字符的工具。
//
// 做法：真的 spawn 一次 src/mcp-napcat-safe.js（stdio），走 initialize + tools/list，
// 逐个量 `JSON.stringify({name, description, inputSchema}).length`（这就是进请求体的那份 JSON 的大小），
// 再按候选档位（social.slimTools.level 的名单）算「注册后还剩多少 / 占全额百分比」。
//
// 跑法：cd qq-bridge && node tools/tool-schema-meter.mjs [--json] [--level high|medium|low]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SERVER = path.join(ROOT, 'src', 'mcp-napcat-safe.js');
const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const levelArg = (() => { const i = argv.indexOf('--level'); return i >= 0 ? argv[i + 1] : ''; })();

function startServer(serverFile, timeoutMs = 25000) {
  const child = spawn(process.execPath, [serverFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let seq = 100;
  const pending = new Map();
  child.stdout.on('data', (c) => {
    stdout += c.toString('utf8');
    let idx;
    while ((idx = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, idx).trim();
      stdout = stdout.slice(idx + 1);
      if (!line.startsWith('{')) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}; stderr=${stderr.slice(0, 400)}`)); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    send({ jsonrpc: '2.0', id, method, params });
  });
  return {
    rpc,
    init: async () => {
      const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tool-schema-meter', version: '0' } });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return init;
    },
    stop: () => { try { child.stdin.end(); } catch { /* ignore */ } try { child.kill(); } catch { /* ignore */ } },
  };
}

/** 工具名归一（去掉 mcp__server__ 前缀，与 mcp-napcat-safe.js 的 bareToolName 同口径） */
const bare = (n) => String(n).replace(/^mcp__[A-Za-z0-9_-]+__/, '');
/** 一个工具的「进请求体」字符数：name + description + inputSchema 的紧凑 JSON */
const costOf = (t) => JSON.stringify({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? {} }).length;

const srv = startServer(SERVER);
let out;
try {
  await srv.init();
  const list = await srv.rpc('tools/list', {});
  const tools = (list.result?.tools ?? []).map((t) => ({ name: bare(t.name), raw: t.name, cost: costOf(t) }));
  tools.sort((a, b) => b.cost - a.cost);
  const total = tools.reduce((s, t) => s + t.cost, 0);
  let tiers = null;
  try {
    const mod = await import(new URL('../src/lib/tool-tiers.js', import.meta.url));
    tiers = mod.TOOL_TIERS;
  } catch { /* 档位模块还没建：只报逐工具体积 */ }
  out = { ok: true, count: tools.length, totalChars: total, totalTokensApprox: Math.round(total / 3.2), tools, tiers };
} catch (e) {
  out = { ok: false, error: String(e?.message ?? e) };
} finally {
  srv.stop();
}

if (AS_JSON) {
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

if (!out.ok) { console.error('量不到工具表：' + out.error); process.exit(1); }
console.log(`工具数 ${out.count} · 全量 schema ${out.totalChars.toLocaleString()} 字符 ≈ ${out.totalTokensApprox.toLocaleString()} token/步`);
console.log('\n占体积最大的 25 个（Pareto：先看这几个就够）:');
for (const t of out.tools.slice(0, 25)) {
  console.log(`  ${String(t.cost).padStart(6)}  ${(t.cost / out.totalChars * 100).toFixed(1).padStart(5)}%  ${t.name}`);
}
if (out.tiers) {
  console.log('\n候选档位（social.slimTools.level）:');
  for (const [id, def] of Object.entries(out.tiers)) {
    if (!def || !Array.isArray(def.keep)) { console.log(`  ${id}: （无名单）`); continue; }
    const keep = new Set(def.keep.map(bare));
    let kept = 0;
    for (const t of out.tools) if (keep.has(t.name) || t.name === 'qq_status') kept += t.cost;
    const pct = (kept / out.totalChars * 100);
    const extra = levelArg && id === levelArg ? '   ← 目标档' : '';
    console.log(`  ${id.padEnd(8)} 保留 ${kept.toLocaleString()} 字符（${pct.toFixed(1)}%）≈ ${Math.round(kept / 3.2).toLocaleString()} token/步，省 ${(100 - pct).toFixed(1)}%${extra}`);
  }
}
