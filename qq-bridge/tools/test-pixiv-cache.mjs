/* 验证"cookie 只填一次"到底能不能成立：
 *   ① 正常态：按名字解一次 → 缓存落盘；
 *   ② 模拟 cookie 没了（QQBRIDGE_PIXIV_COOKIE_OFF=1 子进程）：同一个名字**仍然解得出来**（走缓存）；
 *   ③ 没缓存的名字 + 没登录态 → 明确报"需要登录态"，不静默退化。
 *
 * 用法（桥的机器上）：node qq-bridge/tools/test-pixiv-cache.mjs [名字，默认 米山舞]
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pixivLoginState, pixivSearchUsersByName, artistCacheSize, artistCacheGet, rankArtistCandidates } from '../src/lib/pixiv.js';

const NAME = process.argv[2] || '米山舞';
const SRC = fileURLToPath(new URL('../src/lib/pixiv.js', import.meta.url));

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => { if (cond) { pass += 1; console.log(`  ✅ ${label}`); } else { fail += 1; console.log(`  ❌ ${label}${extra ? `\n     ${extra}` : ''}`); } };

console.log('=== ① 正常态：解一次并落缓存 ===');
const login = await pixivLoginState();
console.log(`  登录态：configured=${login.configured} loggedIn=${login.loggedIn} —— ${login.evidence}`);
const before = artistCacheSize();
const found = await pixivSearchUsersByName(NAME);
const ranked = rankArtistCandidates(found.users, NAME);
console.log(`  解出 ${found.users.length} 个候选（来源 ${found.endpoint}${found.cached ? '，缓存' : ''}）：` +
  ranked.candidates.slice(0, 3).map((u) => `${u.id}:${u.name}${u.worksKnown ? `(${u.works}件)` : ''}`).join(' | '));
ok('拿到了候选', found.users.length > 0);
const after = artistCacheSize();
console.log(`  缓存条目：${before} → ${after}（文件里已记住 ${after} 个名字）`);
ok('缓存已落盘（或本来就有）', after >= before && artistCacheGet(NAME) !== null);
const cachedId = ranked.unique?.id || ranked.candidates[0]?.id || '';
console.log(`  ⇒ 当前排序下会用的号：${cachedId}${ranked.unique ? '（有唯一同名号，敢直接定）' : '（同名不唯一，会列候选让人挑）'}`);

console.log('\n=== ② 模拟 cookie 没了：同一个名字必须还能解出来 ===');
const probe = `
import { pixivLoggedIn, pixivSearchUsersByName } from ${JSON.stringify(pathToFileURL(SRC).href)};
console.log('cookieConfigured=' + pixivLoggedIn());
const r = await pixivSearchUsersByName(${JSON.stringify(NAME)});
console.log(JSON.stringify({ endpoint: r.endpoint, cached: !!r.cached, n: r.users.length, first: r.users[0]?.id ?? '' }));
`;
const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
  env: { ...process.env, QQBRIDGE_PIXIV_COOKIE_OFF: '1' },
  encoding: 'utf8',
});
console.log('  子进程输出：' + out.trim().replace(/\n/g, ' | '));
ok('子进程里确实没有 cookie 了', /cookieConfigured=false/.test(out));
ok('★ 没登录态也能从缓存解出这个名字（这就是"只填一次"）', /"endpoint":"cache"/.test(out) && /"cached":true/.test(out));
ok('缓存里的号与刚才解出来的一致', out.includes(`"first":"${cachedId}"`) || cachedId === '', `期望 ${cachedId}`);

console.log('\n=== ③ 没缓存的名字 + 没登录态 → 必须明确报不支持 ===');
const probe2 = `
import { pixivSearchUsersByName } from ${JSON.stringify(pathToFileURL(SRC).href)};
try { await pixivSearchUsersByName('这个名字肯定没缓存_' + Date.now()); console.log('UNEXPECTED_OK'); }
catch (e) { console.log('ERR:' + e.message); }
`;
const out2 = execFileSync(process.execPath, ['--input-type=module', '-e', probe2], {
  env: { ...process.env, QQBRIDGE_PIXIV_COOKIE_OFF: '1' },
  encoding: 'utf8',
});
ok('报错说清"需要登录态"', /ERR:.*需要 pixiv 登录态/.test(out2), out2.trim().slice(0, 200));
ok('没有偷偷退化成关键词搜', !/UNEXPECTED_OK/.test(out2));

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
