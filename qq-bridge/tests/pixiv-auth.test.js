// Pixiv 官方 OAuth 登录态（PHPSESSID → refresh_token → access_token 自动轮换）离线自测。
// 跑法：node tests/pixiv-auth.test.js
//
// 为什么要有它：这一段全是"凭证 + 定时器 + 落盘"，坏起来**全是静默的** ——
// token 没换、换了没存、并发刷新把对方的 refresh_token 顶掉、last_error 没落盘，
// 线上只会看到"按名字搜画师不好使"。所以这里用假 fetch 把**发出去请求的每一个字段**和
// **落盘文件的每一个键**都钉住，并且逐条断言"凭证不出现在任何回显/返回里"。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_DIR = path.join(ROOT, 'state', '.tmp-pixiv-auth-test');
const TOKEN_FILE = path.join(TMP_DIR, 'pixiv-token.json');

// 必须先设好环境变量再 import：令牌路径与环境变量覆盖都是本模块的唯一外部输入。
process.env.QQBRIDGE_PIXIV_TOKEN_PATH = TOKEN_FILE;
delete process.env.QQBRIDGE_PIXIV_REFRESH_TOKEN;

const HASH_SECRET = '28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c';
const realFetch = globalThis.fetch;

const {
  PIXIV_CLIENT_ID, PIXIV_CLIENT_SECRET, PIXIV_APP_UA, PIXIV_OAUTH_TOKEN_URL, PIXIV_REDIRECT_URI,
  generatePixivPkce, pixivPkceChallenge, pixivAuthState, getPixivAccessToken, refreshPixivToken,
  loginWithPhpSessid, startPixivTokenRefresh, savePixivRefreshToken, pixivTokenPath, readPixivToken,
} = await import('../src/lib/pixiv-auth.js');

/* ─────────────────────────── 小工具 ─────────────────────────── */
let passed = 0;
const fails = [];
async function t(name, fn) {
  try { await fn(); passed += 1; console.log(`  PASS ${name}`); }
  catch (e) { fails.push(`${name}\n       ${e?.message ?? e}`); console.error(`  FAIL ${name}\n       ${e?.message ?? e}`); }
}
const writeFile = (data) => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ v: 1, ...data }));
};
const readFileRaw = () => fs.readFileSync(TOKEN_FILE, 'utf8');
const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** 假 fetch：记录每次请求，按 `route(url, init)` 决定回什么。 */
function stubFetch(route) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = String(url);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const call = { url: u, method: String(init.method ?? 'GET').toUpperCase(), headers, body: String(init.body ?? '') };
    calls.push(call);
    const r = await route(call, calls.length);
    return {
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      status: r.status ?? 200,
      headers: { get: (k) => (r.headers ?? {})[String(k).toLowerCase()] ?? null },
      text: async () => r.text ?? '',
      json: async () => JSON.parse(r.text ?? 'null'),
    };
  };
  globalThis.fetch = impl;
  return calls;
}
const form = (body) => Object.fromEntries(new URLSearchParams(String(body)).entries());

/* ─────────────────────────── 一、PKCE 形状 ─────────────────────────── */
console.log('\n一、PKCE 生成（charset/length/challenge）');
await t('code_verifier 是 128 字符、只含 RFC7636 允许的字符集', () => {
  for (let i = 0; i < 20; i += 1) {
    const { verifier } = generatePixivPkce();
    assert.equal(verifier.length, 128);
    assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
  }
});
await t('两次生成的 verifier 不同（真随机，不是常量）', () => {
  assert.notEqual(generatePixivPkce().verifier, generatePixivPkce().verifier);
});
await t('challenge = base64url(sha256(verifier))，无 padding、无 +/', () => {
  const { verifier, challenge } = generatePixivPkce();
  const mine = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, mine);
  assert.ok(!challenge.includes('=') && !challenge.includes('+') && !challenge.includes('/'), challenge);
  assert.equal(pixivPkceChallenge(verifier), mine);
});

/* ─────────────────────────── 二、refresh 成功路径 ─────────────────────────── */
console.log('\n二、refresh 成功路径（请求字段 + 落盘轮换）');
await t('请求形状（URL/method/表单字段/两个 X-Client-* 头）与落盘都对', async () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  writeFile({ refresh_token: 'R1-old-token-0123456789' });
  const calls = stubFetch(() => ({ status: 200, text: JSON.stringify({ access_token: 'A2-new-access', refresh_token: 'R2-rotated-0987654321', expires_in: 3600, user: { id: '12345', name: '测试画师' } }) }));

  const before = Date.now();
  const r = await refreshPixivToken();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, PIXIV_OAUTH_TOKEN_URL);
  assert.equal(c.method, 'POST');
  assert.match(c.headers['content-type'], /application\/x-www-form-urlencoded/);
  assert.deepEqual(form(c.body), {
    grant_type: 'refresh_token',
    refresh_token: 'R1-old-token-0123456789',
    client_id: PIXIV_CLIENT_ID,
    client_secret: PIXIV_CLIENT_SECRET,
    include_policy: 'true',
  });
  assert.equal(c.headers['user-agent'], PIXIV_APP_UA);
  assert.equal(c.headers['app-os'], 'android');
  assert.equal(c.headers['app-os-version'], '11');
  assert.equal(c.headers['app-version'], '5.0.234');
  assert.match(c.headers['x-client-time'], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
  // 独立复算一遍（用公开的 hash_secret 字面量），证明不是"自己算的自己信"
  assert.equal(c.headers['x-client-hash'], crypto.createHash('md5').update(c.headers['x-client-time'] + HASH_SECRET).digest('hex'));

  const saved = JSON.parse(readFileRaw());
  assert.equal(saved.refresh_token, 'R2-rotated-0987654321', '轮换后的 refresh_token 必须落盘（旧的会失效）');
  assert.equal(saved.access_token, 'A2-new-access');
  assert.equal(saved.user_id, '12345');
  assert.equal(saved.user_name, '测试画师');
  assert.ok(saved.last_refresh_at >= before);
  // expires_at = now + expires_in - 60 秒偏斜
  const skew = saved.expires_at - Date.now();
  assert.ok(skew > 3500_000 && skew <= 3600_000, `expires_at 偏斜不对：${skew}`);

  const st = pixivAuthState();
  assert.equal(st.hasRefreshToken, true);
  assert.equal(st.hasAccessToken, true);
  assert.equal(st.expired, false);
  assert.equal(st.userId, '12345');
  assert.equal(st.userName, '测试画师');
  assert.equal(st.source, 'file', '本用例要求令牌来自文件（若 config.json 里配了 pixiv.refreshToken，请改用 env 覆盖）');
  assert.equal(st.lastError, '');
  // 状态里绝不含凭证本体
  const dumped = JSON.stringify(st);
  assert.ok(!dumped.includes('R2-rotated-0987654321') && !dumped.includes('A2-new-access'), dumped);
});

/* ─────────────────────────── 三、refresh 失败路径 ─────────────────────────── */
console.log('\n三、refresh 失败路径（不抛 + 落 last_error + 保住旧令牌）');
await t('HTTP 400 → 结构化错误、不抛、last_error 落盘、旧 refresh_token 不被清掉', async () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  writeFile({ refresh_token: 'R-keep-me-0123456789', access_token: 'A-old', expires_at: Date.now() + 10_000 });
  const calls = stubFetch(() => ({ status: 400, text: JSON.stringify({ error: { message: 'invalid_grant' } }) }));

  const r = await refreshPixivToken();
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /HTTP 400/);
  assert.match(r.body, /invalid_grant/);
  assert.equal(calls.length, 1);

  const saved = JSON.parse(readFileRaw());
  assert.match(saved.last_error, /HTTP 400/);
  assert.ok(saved.last_error_at > 0);
  assert.equal(saved.refresh_token, 'R-keep-me-0123456789', '一次失败不能把还能用的 refresh_token 抹掉');
  // 回显里绝不能出现真实凭证
  assert.ok(!r.body.includes('R-keep-me-0123456789'));
});
await t('refresh 失败后 getPixivAccessToken() 返回 null（可选令牌失效，但不抛）', async () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  writeFile({ refresh_token: 'R-dead' });
  stubFetch(() => ({ status: 400, text: '{"error":"invalid_request"}' }));
  const token = await getPixivAccessToken();
  assert.equal(token, null);
});
await t('没有 refresh_token 时 getPixivAccessToken() 直接返回 null 且**不联网、不建文件**', async () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  const calls = stubFetch(() => ({ status: 200, text: '{}' }));
  assert.equal(await getPixivAccessToken(), null);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(TOKEN_FILE), false, '没登录态时不该凭空造一个令牌文件');
});

/* ─────────────────────────── 四、single-flight ─────────────────────────── */
console.log('\n四、single-flight（并发只发一次 POST）');
await t('三个并发调用 → 恰好 1 次 POST，拿到同一个 access_token', async () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  writeFile({ refresh_token: 'R-concurrent' });
  const calls = stubFetch(async () => {
    await new Promise((r) => setTimeout(r, 30));   // 让并发真的重叠
    return { status: 200, text: JSON.stringify({ access_token: 'A-once', refresh_token: 'R-next', expires_in: 3600, user: { id: '1', name: 'x' } }) };
  });
  const [a, b, c] = await Promise.all([getPixivAccessToken(), getPixivAccessToken(), refreshPixivToken()]);
  assert.equal(calls.length, 1, `并发刷新发了 ${calls.length} 次（refresh_token 轮换会互相顶掉，必须串行）`);
  assert.equal(a, 'A-once');
  assert.equal(b, 'A-once');
  assert.equal(c.ok, true);
});

/* ─────────────────────────── 五、一次性引导 ─────────────────────────── */
console.log('\n五、loginWithPhpSessid（PHPSESSID → code → refresh_token）');
await t('GET 拿 code（302 Location）→ 换 token：参数/凭证挂载/脱敏全对', async () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  const CODE = 'ABCDEFGHIJ0123456789';
  const calls = stubFetch((call) => {
    if (call.url.startsWith('https://app-api.pixiv.net/web/v1/login?')) {
      return { status: 302, headers: { location: `pixiv://account/login?code=${CODE}&via=login` }, text: '' };
    }
    if (call.url === PIXIV_OAUTH_TOKEN_URL) {
      return { status: 200, text: JSON.stringify({ access_token: 'A-boot', refresh_token: 'R-boot', expires_in: 3600, user: { id: '9999', name: '引导' } }) };
    }
    throw new Error(`不该请求这个地址：${call.url}`);
  });

  const r = await loginWithPhpSessid('PHPSESSID=sess-value-abcdefghijklmn');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.userId, '9999');
  assert.equal(r.userName, '引导');
  assert.equal(r.persisted, true);

  const [login, exchange] = calls;
  assert.equal(login.method, 'GET');
  const q = new URL(login.url).searchParams;
  assert.equal(q.get('client'), 'pixiv-android');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(login.headers.cookie, 'PHPSESSID=sess-value-abcdefghijklmn');   // cookie 只挂在这一个请求上
  assert.equal(login.headers.authorization, undefined);
  assert.equal(form(exchange.body).grant_type, 'authorization_code');
  assert.equal(form(exchange.body).code, CODE);
  assert.equal(form(exchange.body).client_id, PIXIV_CLIENT_ID);
  assert.equal(form(exchange.body).client_secret, PIXIV_CLIENT_SECRET);
  assert.equal(form(exchange.body).redirect_uri, PIXIV_REDIRECT_URI);
  assert.equal(exchange.headers.cookie, undefined, '换 token 那步绝不能带 cookie');
  assert.equal(exchange.headers.authorization, undefined);
  // 端到端 PKCE：交换用的 verifier 的 sha256 必须等于第一步给的 challenge
  const verifier = form(exchange.body).code_verifier;
  assert.equal(verifier.length, 128);
  assert.equal(q.get('code_challenge'), b64url(crypto.createHash('sha256').update(verifier).digest()));

  const saved = JSON.parse(readFileRaw());
  assert.equal(saved.refresh_token, 'R-boot');
  // 回显里不许出现 cookie / code / verifier
  const dump = JSON.stringify(r.attempts);
  assert.ok(!dump.includes('sess-value-abcdefghijklmn'), dump);
  assert.ok(!dump.includes(CODE), dump);
  assert.ok(!dump.includes(verifier), dump);
  assert.equal(r.attempts[0].status, 302);
});
await t('两个形状都拿不到 code → 不抛，逐条报 HTTP 状态与响应体（脱敏后）', async () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  const calls = stubFetch(() => ({ status: 400, text: '{"error":{"message":"不正确的请求。","code":"secret-code-value"}}' }));
  const r = await loginWithPhpSessid('bad-cookie-value-12345678');
  assert.equal(r.ok, false);
  assert.equal(calls.length, 2, 'GET 与 POST 两个形状都要试一次');
  assert.deepEqual(r.attempts.map((a) => a.status), [400, 400]);
  assert.deepEqual(r.attempts.map((a) => a.label), ['GET 带 query 参数', 'POST JSON']);
  assert.match(r.error, /两次尝试都没拿到 login code/);
  assert.ok(!JSON.stringify(r.attempts).includes('secret-code-value'), '回显里的 code= 值必须被隐去');
});
await t('cookie 认不出来 → 直接给用法，不联网', async () => {
  const calls = stubFetch(() => ({ status: 200, text: '{}' }));
  const r = await loginWithPhpSessid('   ');
  assert.equal(r.ok, false);
  assert.match(r.error, /PHPSESSID 认不出来/);
  assert.equal(calls.length, 0);
});

/* ─────────────────────────── 六、落盘与状态 ─────────────────────────── */
console.log('\n六、令牌文件的原子写 / 权限 / 状态汇报');
await t('写文件是 tmp+rename：不留 .tmp、内容始终是完整 JSON、POSIX 下 0600', async () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  writeFile({ refresh_token: 'R-mode' });
  stubFetch(() => ({ status: 200, text: JSON.stringify({ access_token: 'A-mode', refresh_token: 'R-mode2', expires_in: 3600, user: { id: '7', name: 'm' } }) }));
  await refreshPixivToken();
  assert.equal(fs.existsSync(`${TOKEN_FILE}.tmp`), false, '原子的 tmp 文件必须被 rename 掉，不能留垃圾');
  JSON.parse(readFileRaw());   // 能解析 = 不是半个文件
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(TOKEN_FILE).mode & 0o777, 0o600, '令牌文件里有长期凭证，必须 0600');
  }
  assert.equal(pixivTokenPath(), TOKEN_FILE);
});
await t('savePixivRefreshToken：长度不合格拒绝、合格则落盘', () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  assert.equal(savePixivRefreshToken('short').ok, false);
  assert.equal(fs.existsSync(TOKEN_FILE), false);
  assert.equal(savePixivRefreshToken('R-manual-01234567890123456789').ok, true);
  assert.equal(readPixivToken().refresh_token, 'R-manual-01234567890123456789');
  assert.equal(pixivAuthState().hasRefreshToken, true);
});

/* ─────────────────────────── 七、定时轮换 ─────────────────────────── */
console.log('\n七、startPixivTokenRefresh（重复调用安全 / 只在需要时刷新）');
await t('重复调用返回同一个停止函数（不会起第二个定时器），stop 后不再刷新', async () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  writeFile({ refresh_token: 'R-loop', access_token: 'A-loop', expires_at: Date.now() + 3600_000 });
  const calls = stubFetch(() => ({ status: 200, text: JSON.stringify({ access_token: 'A1', refresh_token: 'R1', expires_in: 3600, user: { id: '1', name: 'l' } }) }));
  const logs = [];
  const stop1 = startPixivTokenRefresh({ intervalMs: 60_000, logger: (m) => logs.push(m) });
  const stop2 = startPixivTokenRefresh({ intervalMs: 60_000, logger: (m) => logs.push(m) });
  assert.equal(typeof stop1, 'function');
  assert.equal(stop1, stop2);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 0, '令牌还有 1 小时有效期，启动时不该白白换一次');
  stop1();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 0);
});
await t('令牌已过期 → 启动后立刻换一次，并按日志如实说明', async () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  writeFile({ refresh_token: 'R-expired', access_token: 'A-expired', expires_at: Date.now() - 1000 });
  const calls = stubFetch(() => ({ status: 200, text: JSON.stringify({ access_token: 'A-fresh', refresh_token: 'R-fresh', expires_in: 3600, user: { id: '42', name: '轮换' } }) }));
  const logs = [];
  const stop = startPixivTokenRefresh({ intervalMs: 60_000, logger: (m) => logs.push(m) });
  await new Promise((r) => setTimeout(r, 80));
  stop();
  assert.equal(calls.length, 1);
  assert.match(logs.join('\n'), /已轮换/);
  assert.equal(readPixivToken().refresh_token, 'R-fresh');
});

globalThis.fetch = realFetch;
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\n' + '─'.repeat(64));
if (fails.length === 0) console.log(`pixiv-auth: 全部通过（${passed} 项）`);
else {
  console.error(`pixiv-auth: 失败 ${fails.length} 项 / 通过 ${passed} 项`);
  for (const f of fails) console.error(`  · ${f}`);
  process.exitCode = 1;
}
