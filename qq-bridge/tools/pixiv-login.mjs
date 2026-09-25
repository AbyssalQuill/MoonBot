#!/usr/bin/env node
/* Pixiv 一次性登录引导 / 登录态自检（2026-09-20 新增，无第三方依赖）。
 *
 * 为什么要有这个脚本：桥的「按名字搜画师」需要一个长期登录态，而 pixiv 只给两条路 ——
 *   ① PHPSESSID（短命、要人手动维护）；② OAuth（长期，但要有人第一次去换）。
 * 这个脚本就是那个"第一次"：手动贴一次 PHPSESSID，它换成 refresh_token 落盘（state/pixiv-token.json），
 * 之后桥自己每 50 分钟轮换 access_token，不需要再人工干预（见 src/lib/pixiv-auth.js）。
 *
 * 用法：
 *   node tools/pixiv-login.mjs --cookie "PHPSESSID=xxxx"        # 整条 cookie 串 / 只给会话值都认
 *   node tools/pixiv-login.mjs --cookie-file /path/to/cookie.txt
 *   node tools/pixiv-login.mjs --refresh-token <token>          # 手上已经有 refresh_token
 *   node tools/pixiv-login.mjs --status                         # 看现在的登录态 + 实时探测 app-api
 *
 * 纪律：绝不回显任何凭证（cookie / code / verifier / access_token / refresh_token 只报长度）。
 *   换 code 的那两步失败时会原样打印每个形状的 HTTP 状态与响应体（已脱敏），方便照着实测改。
 */
import fs from 'node:fs';
import {
  loginWithPhpSessid, savePixivRefreshToken, refreshPixivToken,
  pixivAuthState, getPixivAccessToken, pixivAppHeaders,
} from '../src/lib/pixiv-auth.js';

const APP_API = 'https://app-api.pixiv.net/v1';
const argv = process.argv.slice(2);
const argOf = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? String(argv[i + 1] ?? '') : '';
};
const hasFlag = (k) => argv.includes(k);
const mask = (v) => `${String(v ?? '').length} 字符`;

/** 实时探测：拿当前令牌调一次 app-api 搜索（证明"轮换出来的 token 真的能用"）。 */
async function probeAppApi(word = '初音ミク') {
  const token = await getPixivAccessToken();
  if (!token) return { ok: false, error: '没有可用的 access_token（先 --cookie 引导一次）' };
  const url = `${APP_API}/search/illust?word=${encodeURIComponent(word)}&search_target=partial_match_for_tags&filter=for_android&offset=0&lang=zh`;
  try {
    const res = await fetch(url, { headers: { ...pixivAppHeaders(), authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON：下面按失败报原文 */ }
    if (!res.ok || !Array.isArray(json?.illusts)) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}`, body: text.replace(/\s+/g, ' ').slice(0, 300) };
    }
    const first = json.illusts[0];
    return {
      ok: true,
      status: res.status,
      n: json.illusts.length,
      first: first ? `${first.id}「${String(first.title ?? '').slice(0, 30)}」by ${first.user?.name ?? '?'}` : '（无结果）',
    };
  } catch (e) {
    return { ok: false, error: `请求异常：${e?.message ?? e}` };
  }
}

/** 打印当前登录态（只含长度/来源/时间，不含任何凭证值）。 */
async function printStatus({ withProbe = true } = {}) {
  const st = pixivAuthState();
  console.log('── pixiv 登录态 ──');
  console.log(`  长期令牌 refresh_token：${st.hasRefreshToken ? `有（${st.refreshTokenLen} 字符，来源 ${st.source}）` : '没有'}`);
  console.log(`  access_token：${st.hasAccessToken ? `有（${st.accessTokenLen} 字符，${st.accessTokenValid ? '有效' : '已过期'}）` : '没有'}`);
  if (st.expiresAt) console.log(`  到期时间：${new Date(st.expiresAt).toISOString()}（${st.expired ? '已过期' : `还有 ${Math.round((st.expiresAt - Date.now()) / 60000)} 分钟`}）`);
  if (st.lastRefreshAt) console.log(`  最近一次轮换：${new Date(st.lastRefreshAt).toISOString()}`);
  if (st.userId || st.userName) console.log(`  账号：${st.userId || '?'}「${st.userName || '?'}」`);
  if (st.lastError) console.log(`  最近一次错误：${st.lastError}`);
  console.log(`  令牌文件：${st.tokenFile}`);
  if (!withProbe) return;
  const p = await probeAppApi();
  console.log('── 实时探测（app-api 关键词搜索）──');
  if (p.ok) console.log(`  ✅ HTTP ${p.status}，返回 ${p.n} 条，首条 ${p.first}`);
  else console.log(`  ❌ ${p.error}${p.body ? `\n     ${p.body}` : ''}`);
}

function printAttempts(attempts) {
  if (!Array.isArray(attempts) || !attempts.length) return;
  console.log('  逐个形状的实测结果（HTTP 状态 + 响应体，凭证已隐去）：');
  for (const a of attempts) {
    console.log(`   · ${a.label} → HTTP ${a.status}`);
    if (a.location) console.log(`     location: ${a.location}`);
    if (a.body) console.log(`     body: ${a.body}`);
  }
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h') || !argv.length) {
    console.log('用法：');
    console.log('  node tools/pixiv-login.mjs --cookie "PHPSESSID=xxxx"   一次性引导（换长期 refresh_token）');
    console.log('  node tools/pixiv-login.mjs --cookie-file <path>        同上，cookie 从文件读');
    console.log('  node tools/pixiv-login.mjs --refresh-token <token>     直接写入手上的 refresh_token');
    console.log('  node tools/pixiv-login.mjs --status                    看登录态 + 实时探测（不写任何东西）');
    return 0;
  }

  if (hasFlag('--status')) {
    await printStatus();
    // 退出码如实反映"长期登录态在不在"：脚本化自检（cron/巡检）靠它判断，别一律 0。
    return pixivAuthState().hasRefreshToken ? 0 : 1;
  }

  const refreshTokenArg = argOf('--refresh-token');
  if (refreshTokenArg) {
    const w = savePixivRefreshToken(refreshTokenArg);
    if (!w.ok) { console.log(`❌ ${w.error}`); return 1; }
    console.log(`已写入 refresh_token（${mask(refreshTokenArg)}）→ ${pixivAuthState().tokenFile}`);
  } else {
    let cookieValue = argOf('--cookie');
    const cookieFile = argOf('--cookie-file');
    if (!cookieValue && cookieFile) {
      try { cookieValue = fs.readFileSync(cookieFile, 'utf8'); } catch (e) {
        console.log(`❌ 读不到 cookie 文件：${e?.message ?? e}`);
        return 1;
      }
    }
    if (!cookieValue) {
      console.log('❌ 没给 cookie：用 --cookie "PHPSESSID=xxxx" / --cookie-file <path> / --refresh-token <token>，或 --status 看现状');
      return 1;
    }
    console.log(`开始一次性引导（PHPSESSID 长度 ${cookieValue.replace(/\s/g, '').length} 字符，只用于换长期令牌，不会落盘也不会回显）…`);
    const r = await loginWithPhpSessid(cookieValue);
    if (!r.ok) {
      console.log(`❌ 引导失败：${r.error}`);
      printAttempts(r.attempts);
      if (r.status || r.body) console.log(`  换 token 那步：HTTP ${r.status ?? '?'} ${r.body ?? ''}`);
      return 1;
    }
    const stAfter = pixivAuthState();
    console.log(`✅ 已拿到长期令牌并落盘：账号 ${r.userId || '?'}「${r.userName || '?'}」，refresh_token(${stAfter.refreshTokenLen} 字符，来源 ${stAfter.source})`);
    if (r.error) console.log(`⚠️ ${r.error}`);
  }

  // 轮换自检：换一次（或直接用刚拿到的 access_token 探一次），证明这条路真的通。
  const rr = await refreshPixivToken();
  if (rr.ok) {
    console.log(`🔄 轮换自检：access_token 有效期至 ${new Date(rr.expiresAt).toISOString()}${rr.refreshTokenRotated ? '，refresh_token 已随之更新并落盘' : ''}`);
  } else {
    console.log(`❌ 轮换失败：${rr.error}`);
    if (rr.status || rr.body) console.log(`   HTTP ${rr.status ?? '?'} ${rr.body ?? ''}`);
  }
  console.log('');
  await printStatus();
  const st = pixivAuthState();
  console.log('');
  console.log(st.hasRefreshToken
    ? '✅ 完成：以后桥会自己每 50 分钟续期，不需要再给 cookie（启动日志里会有一行 [pixiv] token 自动轮换已启动）。'
    : '❌ 没拿到长期令牌，按名字搜画师仍然不可用。');
  return st.hasRefreshToken ? 0 : 1;
}

const code = await main().catch((e) => {
  console.log(`❌ 脚本崩了：${e?.stack ?? e}`);
  return 1;
});
process.exit(code);
