// 端到端：真的 spawn src/mcp-napcat-safe.js（stdio 传输），走 initialize + tools/list，
// 断言（按"一个角色 = 一个角色包目录"的真实结构）：
//   1) 四个 qq_character_* 工具确实注册给 MCP 客户端（名字 / 英文描述 / 参数 schema / 只读）；
//   2) 真调一次（list 包清单 / list 单个包 / read 拒穿越 / read 不存在 / pack 真读一个包 / search）；
//   3) 开关与现有机制一致：social.tools.characterCards=false → 四个工具根本不注册；
//      slimTools.deny 命中单个名字 → 只少那一个（用临时 src 副本跑，不碰真实 config.json）。
// 跑法：cd qq-bridge && node tests/character-tools-mcp.test.js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* 2026-09-22：多了 qq_character_switch（唯一的写入者：把角色库里的一张卡合成成 persona.md，
 * 见 lib/persona-switch.js）；它和四个只读工具同属 characterCards 这一组开关，所以一起断言注册/不注册。 */
const WANTED = ['qq_character_list', 'qq_character_read', 'qq_character_pack', 'qq_character_search', 'qq_character_switch'];
const failures = [];
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, message: error?.message ?? String(error) });
    console.log(`FAIL  ${name}\n      ${error?.message ?? error}`);
  }
};

/** 起一个 MCP server（stdio），跑完 initialize + tools/list，返回 { names, rpc, stop }
 *  extraEnv：给这个子进程额外注入的环境变量（phase 1 用它关掉工具裁剪档 —— 见下面的调用处）。 */
function startServer(serverFile, timeoutMs = 20000, extraEnv = null) {
  const child = spawn(process.execPath, [serverFile], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}; stderr=${stderr.slice(0, 300)}`)); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    send({ jsonrpc: '2.0', id, method, params });
  });
  return {
    rpc,
    init: async () => {
      const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'character-tools-test', version: '0' } });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return init;
    },
    stop: () => { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} }
  };
}

const callText = async (srv, tool, args) => {
  const res = await srv.rpc('tools/call', { name: tool, arguments: args });
  return { res, text: res.result?.content?.[0]?.text ?? '' };
};

// ── 1. 真实源码：注册 + 真调用 ──
/* 2026-09-25：这里必须关掉工具裁剪档（QQB_SLIM_TOOLS_OFF=1），否则本测试的结果取决于
 * **本机 config.json 里选的那一档**：low 档的 drop 名单里就有 qq_character_list/read/pack/search
 * （lib/tool-tiers.js:110 明列，理由是"实测零调用且体积大"），于是同一份源码在"主人选了低档"的
 * 机器上必然少这四个 —— 测试报的是环境，不是回归。关掉裁剪后量的才是"注册表本身"这一层。 */
const SERVER = path.join(HERE, '..', 'src', 'mcp-napcat-safe.js');
const srv = startServer(SERVER, 20000, { QQB_SLIM_TOOLS_OFF: '1' });
try {
  await check('工具表：四个 qq_character_* 已注册，描述英文、只读、写清"什么时候用它"和参数', async () => {
    const init = await srv.init();
    assert.equal(init.result?.serverInfo?.name, 'napcat-safe');
    const list = await srv.rpc('tools/list', {});
    const tools = list.result?.tools ?? [];
    assert.ok(tools.length > 10, `tools/list 返回 ${tools.length} 个工具`);
    for (const name of WANTED) {
      const t = tools.find((x) => x.name === name);
      assert.ok(t, `${name} 没注册`);
      assert.ok(t.description && t.description.length > 40, `${name} 描述太短`);
      // 描述主体必须是英文；中文只允许出现在引号里的"使用者原话"举例（约定：举例要贴合中文说法）
      const outsideQuotes = String(t.description).replace(/"[^"]*"/g, '""');
      assert.ok(!/[\u4e00-\u9fff]/.test(outsideQuotes), `${name} 描述除引号内的中文举例外必须全英文`);
      assert.ok(/Use (when|this)/i.test(t.description), `${name} 描述没写"什么时候用它"`);
      /* 2026-09-22："只读"这条只对四个读取工具成立：新增的 qq_character_switch 是唯一的写入者
       * （把角色卡合成 persona.md），它当然不是 read-only，而且必须带 key/token 做 owner 校验。 */
      if (name !== 'qq_character_switch') {
        assert.ok(/read-only/i.test(t.description), `${name} 描述没说清是只读`);
      } else {
        assert.ok(/persona\.md/i.test(t.description), 'qq_character_switch 描述要说清它写的是 persona.md');
        assert.match(String(t.description), /Owner only/i, 'qq_character_switch 描述要写明只有主人能用');
      }
    }
    const byName = Object.fromEntries(WANTED.map((n) => [n, tools.find((t) => t.name === n)]));
    assert.ok(/换成 XX 角色/.test(byName.qq_character_read.description), 'read 描述要贴合主人说法（换成 XX 角色）');
    assert.ok(/SKILL\.md/.test(byName.qq_character_read.description), 'read 描述要提到 SKILL.md');
    assert.ok(/看看角色库有什么/.test(byName.qq_character_list.description), 'list 描述要贴合"看看角色库有什么"');
    assert.deepEqual(Object.keys(byName.qq_character_list.inputSchema.properties ?? {}), ['limit', 'character']);
    assert.deepEqual(Object.keys(byName.qq_character_read.inputSchema.properties ?? {}), ['character', 'file', 'maxBytes']);
    assert.deepEqual(byName.qq_character_read.inputSchema.required, ['character']);
    assert.deepEqual(Object.keys(byName.qq_character_pack.inputSchema.properties ?? {}), ['character', 'maxBytes']);
    assert.deepEqual(byName.qq_character_pack.inputSchema.required, ['character']);
    assert.deepEqual(Object.keys(byName.qq_character_search.inputSchema.properties ?? {}), ['query', 'limit']);
    console.log(`      工具表共 ${tools.length} 个；参数：list{limit,character} / read{character,file,maxBytes} / pack{character,maxBytes} / search{query,limit}`);
  });

  await check('真调用：list 包清单 / list 单个包的文件 / 穿越被拒 / 不存在名 → not-found / pack 读到真包 / search 正常', async () => {
    const list = await callText(srv, 'qq_character_list', { limit: 10 });
    assert.notEqual(list.res.result?.isError, true);
    assert.ok(/character pack\(s\).*file\(s\) on disk/.test(list.text), list.text.split('\n')[1] ?? '');
    assert.ok(list.text.includes('(loose file)'), '库根散装文件要标出来');
    const packNames = list.text.split('\n').filter((l) => /\/ \| \d+ file\(s\)/.test(l));
    assert.ok(packNames.length > 0, '至少列出一个角色包');
    const firstName = packNames[0].split('/')[0];

    const one = await callText(srv, 'qq_character_list', { character: firstName });
    assert.notEqual(one.res.result?.isError, true);
    assert.ok(one.text.startsWith(`Character pack: ${firstName}/ (`), one.text.split('\n')[0]);
    assert.ok(one.text.includes(`${firstName}/SKILL.md`), '单包清单里应有 SKILL.md');
    const fileInPack = ((one.text.split('\n').find((l) => l.startsWith(`${firstName}/SKILL.md`)) || '').split(' | ')[0]).slice(`${firstName}/`.length);

    const traversal = await callText(srv, 'qq_character_read', { character: '..\\..\\Windows' });
    assert.notEqual(traversal.res.result?.isError, true, '参数被拒应是正常文本，不该是 isError');
    assert.ok(traversal.text.includes('Cannot read character file'));
    assert.ok(/traversal/.test(traversal.text));
    const traversalFile = await callText(srv, 'qq_character_read', { character: firstName, file: '../../secret.txt' });
    assert.ok(/traversal/.test(traversalFile.text));

    const missing = await callText(srv, 'qq_character_read', { character: 'no-such-pack-xyz' });
    assert.ok(/no character pack or card file named/.test(missing.text));

    const tmpRead = await callText(srv, 'qq_character_read', { character: firstName, file: fileInPack });
    assert.notEqual(tmpRead.res.result?.isError, true);
    assert.ok(tmpRead.text.startsWith(`Character pack file: ${firstName}/SKILL.md`), tmpRead.text.split('\n')[0]);
    assert.ok(/Returned: \d+ B of \d+ B/.test(tmpRead.text));

    const pack = await callText(srv, 'qq_character_pack', { character: firstName });
    assert.notEqual(pack.res.result?.isError, true, 'qq_character_pack 不该报 isError');
    assert.ok(pack.text.startsWith(`Character pack: ${firstName}/ (`), pack.text.split('\n')[0]);
    assert.ok(pack.text.includes('===== FILE: '), '拼起来的正文要带 FILE 标记');
    assert.ok(!/===== FILE: [^\n]*manifest\.json/.test(pack.text), 'manifest 只当元信息，不进正文');

    const search = await callText(srv, 'qq_character_search', { query: '角色', limit: 2 });
    assert.notEqual(search.res.result?.isError, true);
    assert.ok(/matching file\(s\) in \d+ character pack\(s\)/.test(search.text));
    assert.ok(search.text.includes('Snippets only'));
    console.log(`      list → ${packNames.length} 行包; list(character) → 单包文件; read(穿越) → 拒; read(不存在) → not-found; read(${firstName}/SKILL.md) → 有返回; pack(${firstName}) → 有 FILE 段; search → 有命中（未打印任何正文）`);
  });
} finally {
  srv.stop();
}

// ── 2. 开关（用临时 src 副本 + 临时 config.json，绝不碰真实 config.json） ──
const TMP = path.join(HERE, '.tmp-switch');
const probe = async (configJson) => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.cpSync(path.join(HERE, '..', 'src'), path.join(TMP, 'src'), { recursive: true });
  if (configJson !== null) fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify(configJson, null, 2));
  const s = startServer(path.join(TMP, 'src', 'mcp-napcat-safe.js'));
  try {
    await s.init();
    const list = await s.rpc('tools/list', {});
    return (list.result?.tools ?? []).map((t) => t.name);
  } finally {
    s.stop();
  }
};

try {
  const baseline = await probe(null);
  let shut = [];
  let denied = [];
  await check('开关默认开：临时副本里没有 config.json → 四个工具照常注册', async () => {
    for (const n of WANTED) assert.ok(baseline.includes(n), `${n} 应该注册（默认开）`);
    console.log(`      无 config.json：工具表 ${baseline.length} 个，四个 qq_character_* 都在`);
  });

  await check('开关关闭：social.tools.characterCards=false → 四个工具根本不注册（不是运行时 403）', async () => {
    shut = await probe({ social: { tools: { characterCards: false } } });
    for (const n of WANTED) assert.ok(!shut.includes(n), `${n} 不该注册（开关已关）`);
    assert.equal(baseline.length - shut.length, WANTED.length, `关掉后应正好少 ${WANTED.length} 个`);
    console.log(`      关掉后工具表 ${shut.length} 个（比默认少 ${baseline.length - shut.length}），四个都不在`);
  });

  await check('与 slimTools 黑名单一致：deny 里点名一个 → 只少那一个', async () => {
    denied = await probe({ social: { slimTools: { enabled: true, deny: ['qq_character_read'] } } });
    assert.ok(!denied.includes('qq_character_read'), '被 deny 的不该注册');
    for (const n of WANTED.filter((x) => x !== 'qq_character_read')) assert.ok(denied.includes(n), `${n} 应该还在`);
    assert.equal(baseline.length - denied.length, 1, '只该少一个');
    console.log(`      slimTools.deny=[qq_character_read]：工具表 ${denied.length} 个，只少 read 一个`);
  });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${failures.length ? 'FAILED' : 'ALL PASS'}  (${failures.length} failed)`);
if (failures.length) {
  for (const f of failures) console.log(`- ${f.name}: ${f.message}`);
  process.exit(1);
}
