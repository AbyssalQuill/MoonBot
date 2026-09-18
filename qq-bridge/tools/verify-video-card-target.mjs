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
import { fetchMiniAppArk, buildVideoCard, resolveVideo, biliHtmlSafeCardUrl } from '../src/core/video.js';

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
  if (wanted) return { bvid: wanted, aid: 0, cover: '', title: '(命令行指定)' };
  try {
    const r = await fetch('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(12000)
    });
    const j = await r.json();
    const v = (j?.data?.list ?? []).find((x) => /^BV[0-9a-zA-Z]{10}$/.test(String(x.bvid)));
    if (v) return { bvid: v.bvid, aid: Number(v.aid) || 0, cover: String(v.pic ?? '').replace(/^http:\/\//i, 'https://'), title: String(v.title ?? '').slice(0, 60) };
  } catch (e) { console.log(`（取榜单失败：${e?.message ?? e}）`); }
  return { bvid: 'BV1GJ411x7h7', aid: 80433022, cover: '', title: 'Never Gonna Give You Up' };
}

const picked = await pickRealVideo(process.argv[2]);
const bvid = picked.bvid;
const longUrl = `https://www.bilibili.com/video/${bvid}`;
const shortUrl = `https://b23.tv/${bvid}`;
console.log(`样本视频：${bvid}  ${picked.title}\n`);

/* ── 1. 跑真实函数 fetchMiniAppArk ────────────────────────────────────────── */
/* 【2026-09-18 第十九批】这份 info 的字段要**和 `resolveBilibili` 的返回值同形**，
 * 尤其 `cardUrl` —— 它是卡片的点击目标（抗 `.html` 的 av 形态）。
 * 原来这里没给 aid/cardUrl，于是自检跑的是"降级路径"，跟实发的形态对不上。 */
const info = {
  platform: 'bilibili',
  kind: 'bvid',
  id: bvid,
  aid: picked.aid,
  url: longUrl,
  cardUrl: biliHtmlSafeCardUrl({ aid: picked.aid, bvid }),
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
  /* 【2026-09-18 第十九批】qqdocurl 的契约换成了"**抗 `.html`** 的形态"：
   * 用户点卡片时落到的地址是 `https://b23.tv/<短码>.html`（b23.tv 回 `{"code":-404,"message":"啥都木有"}`），
   * 而补这个后缀的是 QQ 侧、不是我们 —— 拦不住，只能挑一个"补了照样进视频页"的 URL。
   * `tools/probe-bili-html-forms.mjs` 在家宽上实测（3 个视频 × 2 种 UA × 4 种后缀变体，判据是页面 <title>）：
   *   `b23.tv/<短码>`、`www.bilibili.com/video/BV…` 被补上 `.html` 就死；
   *   而 `https://m.bilibili.com/video/av<aid>.html` **四种变体（原样／补一个／补一个再挂查询串／补两个）全绿**。
   * 所以这里断言"卡片目标必须是那个形态"，别再改回短码或长链。 */
  ok(/^https:\/\/m\.bilibili\.com\/video\/av\d+\.html$/.test(String(d1.qqdocurl ?? '')),
    `qqdocurl 是抗 .html 的移动端 av 形态（av<aid>.html）实际=${d1.qqdocurl}`);
  ok(!/^https?:\/\/b23\.tv\//i.test(String(d1.qqdocurl ?? '')),
    `qqdocurl 不再是 b23.tv 短码（那种形态被 QQ 补 .html 就 404）实际=${d1.qqdocurl}`);
  ok(String(d1.url ?? '').startsWith('m.q.qq.com/a/s/'), 'url 是 QQ 服务端签的 m.q.qq.com 短链');
  ok(!!send.config?.token, 'config.token 非空（空 token 的手拼卡会被 QQ 服务端静默拒收）');
}

/* ── 2. 两条链接的重定向链 ──────────────────────────────────────────────── */
console.log('\n── 2) 重定向链（卡片实际带的 qqdocurl / 文案里的 b23.tv 短链）');
/* 【2026-09-18 第十九批】被跟的**必须是卡片里那个 qqdocurl 本身**，不能再用本地拼的 longUrl ——
 * 否则"自检跟的是 A、线上发的是 B"这种错位会一直躲过自检。 */
const cardTarget = String(ark ? JSON.parse(ark.data.data)?.meta?.detail_1?.qqdocurl ?? '' : '') || longUrl;
const aidFromTarget = Number(/\/video\/av(\d+)\.html/.exec(cardTarget)?.[1] || 0);
for (const [name, u] of [['qqdocurl（卡片点击目标）', cardTarget], ['文案里的 b23.tv 短链', shortUrl]]) {
  const hops = await chain(u);
  console.log(`   ${name}  ${u}`);
  for (const h of hops) console.log(`      ${h}`);
  /* 落到哪儿：有 30x 就取**最后一次跳转的目标**；一次都没跳（比如这台机房 IP 第一跳就被 412 挡了）
   * 就说明它本来就是目标页本身 —— 两种都算"落在同一条视频"。
   * 不能拿"终点那一跳"比：终点是 412 风控页，URL 里当然没有视频号。
   * 判据同时接受 **BV 号**和 **av 号**：第十九批起卡片目标是 `m.bilibili.com/video/av<aid>.html`，
   * 它 302 到的是 `www.bilibili.com/video/av<aid>/`，落点里只有 av 号。 */
  const stepped = [...hops].reverse().find((h) => /^3\d\d → /.test(h));
  const dest = stepped ? stepped.replace(/^3\d\d → /, '') : hops[0];
  ok(dest.includes(bvid) || (aidFromTarget > 0 && dest.includes(`/video/av${aidFromTarget}`)),
    `${name} 落在同一条视频（落点 ${dest}）`);
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
  console.log(`   shareUrl=${real?.shareUrl || '(空)'}  cardUrl=${real?.cardUrl || '(空)'}（卡片点击目标）`);
  ok(!!real?.cover, `真实解析拿到封面（source=${real?.source}）`);
  ok(!!real?.author, '真实解析拿到 UP 主');
  /* 真解析这条路必须产出**抗 `.html`** 的卡片目标：形如 `m.bilibili.com/video/av<aid>.html`。
   * 拿不到 aid 时会退回短码形态，那条会在下面的断言里红 —— 这正是要盯住的降级。 */
  ok(/^https:\/\/m\.bilibili\.com\/video\/av\d+\.html$/.test(String(real?.cardUrl ?? '')),
    `resolveVideo 给出的 cardUrl 是抗 .html 的形态 实际=${real?.cardUrl}`);
} catch (e) {
  ok(false, `resolveVideo 抛错：${e?.message ?? e}`);
}

console.log(fails === 0 ? '\n全部通过 ✅' : `\n有 ${fails} 项不通过 ❌`);
process.exit(fails === 0 ? 0 : 1);
