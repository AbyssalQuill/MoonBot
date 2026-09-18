/* 探针：把「点击 B 站卡落到 `b23.tv/<短码>.html`」这件事拆成可实测的几条路径。
 *
 * 背景（上一轮的结论已经被用户实测推翻，别再照抄）：
 *   上一轮认为 `.html` 是拼在**整串末尾**、会落进 query 被忽略，所以给 qqdocurl 补了
 *   `?share_medium=android&share_source=qq&ts=…` 三个非设备参数。实发后用户点开**仍然**是
 *   `.html` 那个 not found 页，说明 `.html` 是贴到 **pathname** 上的。
 *   ⇒ 「换 URL 形态让它容忍 .html」这条路是死的，必须搞清楚它**什么条件下才贴**。
 *
 * 这个探针一次性问三件事（全部只看 HTTP 真实返回，不猜）：
 *   A) `b23.tv/<短码>` 的重定向**会不会随 User-Agent 变**。
 *      如果 b23.tv 对 QQ 内置浏览器的 UA 回的是 `<短码>.html`，那 `.html` 根本不是 QQ 贴的、
 *      而是 b23.tv 自己给的 —— 这条以前从没测过（历次实测都用的 Chrome UA）。
 *   B) 一组候选 URL 形态，各自**带上 `.html` 后缀**之后还落不落到目标 BV。
 *      这一组用来回答"有没有一种形态是天生扛得住 `.html` 的"。
 *   C) 同一批形态在**不带 `.html`** 时的正常落点，作为对照基线。
 *
 * 用法：node tools/probe-bili-html-suffix.mjs [BV号]
 */
const BV = process.argv[2] || 'BV13Xb56NEEZ';
const TIMEOUT = 12000;

const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_QQ_PC = 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36 Core/1.98.4.400 QQBrowser/11.10.4396.400';
const UA_QQ_ANDROID = 'Mozilla/5.0 (Linux; U; Android 12; zh-cn; M2012K11AC Build/SKQ1.211006.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/89.0.4389.116 MQQBrowser/6.2 TBS/046123 Safari/537.36 V1_AND_SQ_8.9.33_1770_YYB_D QQ/8.9.33.10335 NetType/WIFI WebP/0.3.0 AppId/537148670';
const UA_QQ_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 QQ/8.9.33.606 V1_IPH_SQ_8.9.33_1_APP_A Pixel/1125 Core/UIWebView Device/Apple(iPhone) NetType/WIFI QBWebViewType/1';
const UA_TBS_X5 = 'Mozilla/5.0 (Linux; Android 12; M2012K11AC Build/SKQ1.211006.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/98.0.4758.102 MQQBrowser/6.2 TBS/046123 Mobile Safari/537.36';
const UA_WECHAT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.30(0x18001e2f) NetType/WIFI Language/zh_CN';
const UA_CURL = 'curl/7.81.0';

/** 拿一条**官方签发**的真短码（b23.tv/<不透明短码>），短码形态才是真卡用的那种 */
async function freshShortCode() {
  try {
    const aid = Number((await (await fetch(`https://api.bilibili.com/x/web-interface/wbi/view?bvid=${BV}`, {
      headers: { 'user-agent': UA_CHROME, referer: `https://www.bilibili.com/video/${BV}` }, signal: AbortSignal.timeout(TIMEOUT),
    })).json())?.data?.aid) || 0;
    if (!aid) return '';
    const body = new URLSearchParams({
      platform: 'unix', share_channel: 'COPY', share_id: 'main.ugc-video-detail.0.0.pv',
      share_mode: '4', oid: String(aid), buvid: 'qwq', build: '6114514',
    }).toString();
    const j = await (await fetch('https://api.bilibili.com/x/share/click', {
      method: 'POST',
      headers: { 'user-agent': UA_CHROME, referer: `https://www.bilibili.com/video/${BV}`, origin: 'https://www.bilibili.com', 'content-type': 'application/x-www-form-urlencoded' },
      body, signal: AbortSignal.timeout(TIMEOUT),
    })).json();
    return /b23\.tv\/([0-9A-Za-z]{5,12})/.exec(String(j?.data?.content ?? ''))?.[1] || '';
  } catch (e) { console.log(`（签发短码失败：${e?.message ?? e}）`); return ''; }
}

/** 只发一跳，拿 status + Location（`redirect:'manual'`） */
async function hop(url, headers) {
  try {
    const r = await fetch(url, { redirect: 'manual', headers: { ...headers }, signal: AbortSignal.timeout(TIMEOUT) });
    return { status: r.status, loc: r.headers.get('location') || '' };
  } catch (e) { return { status: 0, loc: `请求失败 ${e?.message ?? e}` }; }
}

/** 跟完整重定向链，返回每一跳 */
async function chain(url, headers, maxHops = 6) {
  const hops = [url];
  let cur = url;
  for (let i = 0; i < maxHops; i += 1) {
    const h = await hop(cur, headers);
    if (h.status >= 300 && h.status < 400 && h.loc) { cur = new URL(h.loc, cur).toString(); hops.push(`${h.status} → ${cur}`); continue; }
    hops.push(h.status === 0 ? h.loc : `${h.status}（终点）`);
    break;
  }
  return hops;
}

const code = await freshShortCode();
console.log(`目标视频：${BV}`);
console.log(`本次用的官方短码：${code || '(没拿到，UA 那一节会跳过)'}\n`);

/* ── A) 同一短码，换 UA：`.html` 会不会是 b23.tv 自己给的？ ─────────────────── */
if (code) {
  console.log('='.repeat(100));
  console.log('A) `https://b23.tv/<短码>` 换 User-Agent —— 看第一跳的 status 与 Location');
  console.log('='.repeat(100));
  for (const [name, ua] of [
    ['Chrome 桌面（历次实测用的那个）', UA_CHROME],
    ['PC QQ 内置浏览器', UA_QQ_PC],
    ['Android QQ 内置浏览器', UA_QQ_ANDROID],
    ['iOS QQ 内置浏览器', UA_QQ_IOS],
    ['X5/TBS 内核（无 QQ 标识）', UA_TBS_X5],
    ['微信内置浏览器', UA_WECHAT],
    ['curl 默认', UA_CURL],
  ]) {
    for (const [extra, hdrs] of [['无 Referer', {}], ['QQ 卡片式 Referer', { referer: 'https://m.q.qq.com/' }]]) {
      const h = await hop(`https://b23.tv/${code}`, { 'user-agent': ua, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...hdrs });
      const flag = /\.html(\?|$)/i.test(h.loc) ? ' ⚠️ Location 里出现 .html' : '';
      console.log(`  ${name.padEnd(28)} ${extra.padEnd(18)} → ${h.status}  ${h.loc || '(无 Location)'}${flag}`);
    }
  }
  console.log('');
}

/* ── B) 候选形态：带 `.html` 之后还能不能落到目标 BV ───────────────────────── */
const FORMS = [
  ['b23.tv 短码（我们现在的 qqdocurl）', `https://b23.tv/${code || BV}`],
  ['b23.tv/BV 形态（兜底）', `https://b23.tv/${BV}`],
  ['bilibili 桌面长链', `https://www.bilibili.com/video/${BV}`],
  ['bilibili 移动长链', `https://m.bilibili.com/video/${BV}`],
  ['bilibili 移动长链带 .html（B 站移动端历史形态）', `https://m.bilibili.com/video/${BV}.html`],
  ['bilibili 桌面长链带尾斜杠', `https://www.bilibili.com/video/${BV}/`],
];

console.log('='.repeat(100));
console.log('B) 候选形态：原样 / 路径尾部加 `.html` / 加 `.html` 且带查询串 —— 看落点是不是这条 BV');
console.log('='.repeat(100));
for (const [name, base] of FORMS) {
  const variants = [
    ['原样', base],
    ['+ .html', `${base}.html`],
    ['+ .html + 查询串', `${base}?share_medium=android&share_source=qq&ts=${Date.now()}`.replace(/^(.+)\.html\?/, '$1.html?')],
  ];
  for (const [tag, u] of variants) {
    const hops = await chain(u, { 'user-agent': UA_CHROME, referer: 'https://www.bilibili.com/' });
    const hit = hops.some((h) => new RegExp(`/video/${BV}`).test(h)) || hops[0].includes(BV);
    const stepped = [...hops].reverse().find((h) => /^3\d\d → /.test(h)) ?? '';
    console.log(`  ${hit ? '✅' : '❌'} ${name} 【${tag}】`);
    console.log(`       ${u}`);
    console.log(`       落点 ${stepped ? stepped.replace(/^3\d\d → /, '') : hops[hops.length - 1]}`);
  }
  console.log('');
}

/* ── C) 直接把"带 .html"的形态打到 b23.tv，看它回什么页 ───────────────────── */
if (code) {
  console.log('='.repeat(100));
  console.log('C) b23.tv 对 `.html` 后缀的响应体（200 那种就是用户看到的 not found）');
  console.log('='.repeat(100));
  for (const u of [`https://b23.tv/${code}.html`, `https://b23.tv/${code}.html?share_medium=android&share_source=qq&ts=${Date.now()}`, `https://b23.tv/${code}`]) {
    const r = await fetch(u, { redirect: 'manual', headers: { 'user-agent': UA_CHROME }, signal: AbortSignal.timeout(TIMEOUT) });
    const body = await r.text().catch(() => '');
    console.log(`  ${r.status}  ${u}`);
    console.log(`       body=${body.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
}
