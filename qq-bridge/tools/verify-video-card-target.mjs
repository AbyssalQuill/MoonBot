/* 「B 站卡片点进去不是那个视频」的可复现验证（第十五批）。
 *
 * 它**直接 import 线上那份 `src/core/video.js`**，跑的是真实代码路径，不是另写一份：
 *   1. 构造一个真实的 info（真实 BV + 真实封面）
 *   2. 调 fetchMiniAppArk() —— 就是桥发卡前调的那个函数
 *   3. 把返回的 Ark 解出来，断言 `meta.detail_1.qqdocurl` 存在且指向这条视频
 *      （缺 qqdocurl = 卡片点开落不到那条视频，这正是 2026-09-18 12:56:17 那张卡的问题）
 *   4. 把两条链接的**重定向链**原样打出来：b23.tv 短链（jumpUrl）与长链（qqdocurl）
 *   5. 断言 buildVideoCard(style:'json') 不再产出空 token 的手拼 Ark
 *
 * 不发送任何消息（只问 NapCat 要 Ark 数据），可以随时重跑。
 * 用法（cwd = qq-bridge，需要 NapCat 的 HTTP 在本机）：node tools/verify-video-card-target.mjs [BV号]
 */
import { fetchMiniAppArk, buildVideoCard, resolveVideo } from '../src/core/video.js';

const TOKEN = process.env.NAPCAT_TOKEN || '061228';
const HTTP = process.env.NAPCAT_HTTP || 'http://127.0.0.1:3000';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) fails += 1; };

/** 手动跟重定向链，每一跳都打出来 */
async function chain(url, maxHops = 6) {
  const hops = [url];
  let cur = url;
  for (let i = 0; i < maxHops; i += 1) {
    let res;
    try {
      res = await fetch(cur, { redirect: 'manual', headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(12000) });
    } catch (e) { hops.push(`<请求失败 ${e?.message ?? e}>`); break; }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      cur = new URL(loc, cur).toString();
      hops.push(`${res.status} → ${cur}`);
      continue;
    }
    hops.push(`${res.status}（终点；机房 IP 上的 412 是 bilibili 风控，不影响重定向判定）`);
    break;
  }
  return hops;
}

/** 找一个**真实存在**的 BV + 封面（榜单接口比 search/view 抗风控） */
async function pickRealVideo(wanted) {
  if (wanted) return { bvid: wanted, cover: '', title: '(命令行指定)' };
  try {
    const r = await fetch('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(12000)
    });
    const j = await r.json();
    const v = (j?.data?.list ?? []).find((x) => /^BV[0-9A-Za-z]{10}$/.test(String(x.bvid)));
    if (v) return { bvid: v.bvid, cover: String(v.pic ?? '').replace(/^http:\/\//i, 'https://'), title: String(v.title ?? '').slice(0, 60) };
  } catch (e) { console.log(`（取榜单失败：${e?.message ?? e}）`); }
  return { bvid: 'BV1GJ411x7h7', cover: '', title: 'Never Gonna Give You Up' };
}

const picked = await pickRealVideo(process.argv[2]);
const bvid = picked.bvid;
const longUrl = `https://www.bilibili.com/video/${bvid}`;
const shortUrl = `https://b23.tv/${bvid}`;
console.log(`样本视频：${bvid}  ${picked.title}\n`);

/* ── 1. 跑真实函数 fetchMiniAppArk ────────────────────────────────────────── */
const info = {
  platform: 'bilibili',
  kind: 'bvid',
  id: bvid,
  url: longUrl,
  title: picked.title || '测试标题',
  author: '测试UP主',
  cover: picked.cover || 'https://i0.hdslb.com/bfs/archive/0d3ba4c9c55e6fefd1e1d4b0b0b6b4b4a4a4a4a4.jpg',
  description: 'verify-video-card-target',
  durationText: '3:32',
  playText: '100万',
};

console.log('── 1) fetchMiniAppArk（桥发卡前调的就是它）');
const ark = await fetchMiniAppArk(info, { httpUrl: HTTP, token: TOKEN });
if (!ark) {
  console.log('❌ fetchMiniAppArk 返回 null（拿不到 Ark，本次无法判定）');
  fails += 1;
} else {
  const send = JSON.parse(ark.data.data);
  const d1 = send.meta?.detail_1 ?? {};
  console.log(`   app=${send.app}  view=${send.view}  config.token=${send.config?.token}`);
  console.log(`   detail_1.url      = ${d1.url}`);
  console.log(`   detail_1.qqdocurl = ${d1.qqdocurl ?? '(无)'}`);
  ok(!!d1.qqdocurl, 'Ark 带 qqdocurl（卡片点开才知道进哪个视频页）');
  /* 【2026-09-18 二次修正】qqdocurl 现在与真卡一致：是 **b23.tv 短链**
   * （真卡形如 `https://b23.tv/<不透明短码>?share_medium=android&share_source=qq&…`）。
   * 原来断言的是长链 `https://www.bilibili.com/video/BV…` —— 那种形态发出去后
   * **点进去仍落不到那条视频**，所以把 webUrl 改回了短链。判据相应改成"是 b23.tv 短链且带这条 BV"，
   * 真正"落到哪"由下面那段重定向链实测（不能只看字符串相等就以为点得进去）。 */
  ok(/^https?:\/\/b23\.tv\//i.test(String(d1.qqdocurl ?? '')), `qqdocurl 是 b23.tv 短链（真卡的形态）实际=${d1.qqdocurl}`);
  ok(String(d1.qqdocurl ?? '').includes(bvid), `qqdocurl 里带的是这条视频的 BV（${bvid}）`);
  ok(String(d1.url ?? '').startsWith('m.q.qq.com/a/s/'), 'url 是 QQ 服务端签的 m.q.qq.com 短链');
  ok(!!send.config?.token, 'config.token 非空（空 token 的手拼卡会被 QQ 服务端静默拒收）');
}

/* ── 2. 两条链接的重定向链 ──────────────────────────────────────────────── */
console.log('\n── 2) 重定向链（jumpUrl 短链 / qqdocurl 长链）');
for (const [name, u] of [['jumpUrl  (b23.tv 短链)', shortUrl], ['qqdocurl(长链，卡片实际带的目标)', longUrl]]) {
  const hops = await chain(u);
  console.log(`   ${name}`);
  for (const h of hops) console.log(`      ${h}`);
  /* 落到哪儿：有 30x 就取**最后一次跳转的目标**；一次都没跳（比如这台机房 IP 第一跳就被 412 挡了）
   * 就说明它本来就是目标页本身 —— 两种都算"落在同一个 BV"。
   * 不能拿"终点那一跳"比：终点是 412 风控页，URL 里当然没有 BV。 */
  const stepped = [...hops].reverse().find((h) => /^3\d\d → /.test(h));
  const dest = stepped ? stepped.replace(/^3\d\d → /, '') : hops[0];
  ok(dest.includes(bvid), `${name} 落在同一个 ${bvid}（落点 ${dest}）`);
}

/* ── 3. 空 token 的手拼 structmsg 卡必须已停用 ──────────────────────────── */
console.log('\n── 3) buildVideoCard(style:"json") 不再产出空 token 手拼卡');
const jsonPlan = buildVideoCard({ ...info }, { style: 'json' });
console.log(`   note=${jsonPlan.note}`);
ok(jsonPlan.primary === null, 'primary 为 null（不会发出手拼 structmsg Ark）');
ok(!/structmsg/.test(JSON.stringify(jsonPlan)), '产物里不再出现 com.tencent.structmsg');
const sharePlan = buildVideoCard({ ...info }, { style: 'share' });
ok(sharePlan.primary === null && sharePlan.link.includes(shortUrl), '默认 share 形态仍是"标题 + b23.tv 短链"');

/* ── 4. 真解析必须拿得到封面 ─────────────────────────────────────────────
 * 【2026-09-18 第十六批补的这一步】上面第 1 节的 info 是**手工拼的**，封面还带了个兜底假 URL
 * （`picked.cover || 'https://i0.hdslb.com/bfs/archive/0d3b…jpg'`），所以它**永远测不到**
 * "风控拿不到封面"这条真实失败路径 —— 线上连着两轮"自检全绿、实发还是纯链接"正是这么来的：
 *   resolveVideo 的 cover 是空串 → fetchMiniAppArk 当时要求必须有封面 → 返回 null
 *   → console-server 里 seg=null → 降级梯子发分享链接。
 * 这条自检工具的价值就在于"它绿的 == 实发能出卡"，所以必须把**真解析**也断言进来：
 * 一旦哪天 wbi/view 也被风控，这里会先红，而不是等用户收到一条纯链接才发现。 */
console.log('\n── 4) resolveVideo 真解析必须给出封面/UP主（否则实发会退化成纯链接）');
try {
  const real = await resolveVideo(`https://b23.tv/${bvid}`);
  console.log(`   source=${real?.source}  cover=${real?.cover || '(空)'}  author=${real?.author || '(空)'}`);
  ok(!!real?.cover, `真实解析拿到封面（source=${real?.source}）`);
  ok(!!real?.author, '真实解析拿到 UP 主');
} catch (e) {
  ok(false, `resolveVideo 抛错：${e?.message ?? e}`);
}

console.log(fails === 0 ? '\n全部通过 ✅' : `\n有 ${fails} 项不通过 ❌`);
process.exit(fails === 0 ? 0 : 1);
