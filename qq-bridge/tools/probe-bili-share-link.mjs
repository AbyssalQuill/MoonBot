/* 实测：bilibili 的 `x/share/click` 能不能为指定视频吐一条 **b23.tv/<短码>** 形态的短链。
 *
 * 为什么必须实测而不是照抄文档：
 *   · 官方 API 文档（bilibili-API-collect，docs/misc/b23tv.md）明确写了这条接口的参数表，
 *     但同一份文档里也标注"参数对照表基本失效"（issue #979）。所以只信本机实跑结果。
 *   · 文档里给出的另一条事实很关键：**b23.tv 的视频短链本来就有 "BV"+bvid 这种形态**
 *     （"直接手动拼接字符串即可"），所以 `https://b23.tv/BVxxxx` 并不是我们编出来的野路子。
 *     这条接口要验证的是：**除 BV 形态外，能不能拿到"真卡那种 7 位不透明短码"**。
 *   · 本机出口是机房 IP，bilibili 风控敏感（老 view 接口稳定 412），所以每条路径单独记通/不通。
 *
 * 用法：node probe-bili-share-link.mjs [BV号]
 */
const BV = process.argv[2] || 'BV13Xb56NEEZ';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HDR = {
  'user-agent': UA,
  referer: `https://www.bilibili.com/video/${BV}`,
  origin: 'https://www.bilibili.com',
  'accept-language': 'zh-CN,zh;q=0.9',
};

const j = async (url, hdrs) => {
  const r = await fetch(url, { headers: { ...HDR, ...hdrs }, signal: AbortSignal.timeout(12000) });
  const t = await r.text();
  let o = null;
  try { o = JSON.parse(t); } catch { /* 非 JSON */ }
  return { status: r.status, text: t, json: o };
};

/* 0) 先拿 aid：share/click 的 oid 参数要的是 **aid**，不是 bvid（文档对照表） */
let aid = process.env.PROBE_AID || '';
try {
  const r = await j(`https://api.bilibili.com/x/web-interface/wbi/view?bvid=${BV}`);
  aid = String(r.json?.data?.aid ?? '');
  console.log(`[对照] wbi/view → HTTP ${r.status} code=${r.json?.code} aid=${aid} title=${JSON.stringify(r.json?.data?.title ?? '')}`);
} catch (e) { console.log(`[对照] wbi/view 异常：${e?.message ?? e}`); }
if (!aid) { console.log('拿不到 aid，后面的 oid 只能拿 BV 硬填（结果会说明差别）'); }

/* 1) 文档给的那一版参数（原文示例逐字照搬，只把 oid 换成目标视频）：
 *    platform=unix / share_channel=COPY / share_mode=4 / buvid=qwq / build=6114514 */
const docBody = (oid) => new URLSearchParams({
  platform: 'unix', share_channel: 'COPY', share_id: 'main.ugc-video-detail.0.0.pv',
  share_mode: '4', oid: String(oid), buvid: 'qwq', build: '6114514',
}).toString();

const tries = [
  ['api.bilibili.com 文档参数(oid=aid)', 'https://api.bilibili.com/x/share/click', docBody(aid || BV)],
  ['api.biliapi.net 文档参数(oid=aid)', 'https://api.biliapi.net/x/share/click', docBody(aid || BV)],
  ['api.bilibili.com 文档参数+share_origin/share_mode=1', 'https://api.bilibili.com/x/share/click',
    docBody(aid || BV) + '&share_origin=share&share_session_id=00000000-0000-0000-0000-000000000000&ts=' + Math.floor(Date.now() / 1000)],
  ['api.biliapi.net 参数全填 + android', 'https://api.biliapi.net/x/share/click',
    new URLSearchParams({
      platform: 'android', share_channel: 'COPY', share_id: 'main.ugc-video-detail.0.0.pv',
      share_mode: '4', oid: String(aid || BV), buvid: 'XY' + '0'.repeat(32) + 'infoc', build: '7710300',
      share_origin: 'share', share_pattern: '0', panel_type: '1',
    }).toString()],
];

let firstShort = null;
for (const [label, url, body] of tries) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { ...HDR, 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(12000),
    });
    const t = await r.text();
    const code = (() => { try { return JSON.parse(t)?.code; } catch { return 'non-json'; } })();
    const content = (() => { try { return JSON.parse(t)?.data?.content; } catch { return null; } })();
    const short = String(content ?? '').match(/b23\.tv\/([0-9A-Za-z]+)/)?.[1] ?? null;
    console.log(`\n── ${label}`);
    console.log(`   HTTP ${r.status}  code=${code}`);
    console.log(`   body = ${t.slice(0, 300)}`);
    if (content) console.log(`   ★ data.content = ${content}`);
    if (short) console.log(`   ★ 短码 = ${short}（${short.length} 位，${/^BV[0-9A-Za-z]{10}$/.test(short) ? 'BV 形态' : '不透明短码形态'}）`);
    if (short && !firstShort) firstShort = short;
  } catch (e) { console.log(`\n── ${label}\n   请求异常：${e?.message ?? e}`); }
}

/* 2) 关键一步：把刚拿到的短码**跟到底**，确认它真的落到我们那条 BV。
 *    只拿到短码不算通 —— 必须证明"短码 → 同一个 BV"，否则换了形态反而更糟。
 *    顺便带上真卡那种 `?share_medium=android&share_source=qq&ts=…` 参数再跟一次，
 *    看这些参数会不会破坏解析（bbid 是设备标识，我们编不出来，所以只测非设备参数）。 */
const chain = async (url, maxHops = 6) => {
  const hops = [url];
  let cur = url;
  for (let i = 0; i < maxHops; i += 1) {
    let res;
    try {
      res = await fetch(cur, { redirect: 'manual', headers: { ...HDR, accept: 'text/html,*/*' }, signal: AbortSignal.timeout(12000) });
    } catch (e) { hops.push(`<请求失败 ${e?.message ?? e}>`); break; }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) { cur = new URL(loc, cur).toString(); hops.push(`${res.status} → ${cur}`); continue; }
    hops.push(`${res.status} (终点)`);
    break;
  }
  return hops;
};

if (firstShort) {
  console.log('\n── 跟着刚拿到的短码走一遍（证明它确实指向目标 BV）');
  for (const [label, u] of [
    ['原样', `https://b23.tv/${firstShort}`],
    ['带真卡那串非设备参数', `https://b23.tv/${firstShort}?share_medium=android&share_source=qq&ts=${Math.floor(Date.now() / 1000)}`],
  ]) {
    const hops = await chain(u);
    const hit = hops.find((h) => /\/video\/(BV[0-9A-Za-z]{10})/.exec(h)?.[1] === BV);
    console.log(`   ${label}：${hit ? '✅ 落到 ' + BV : '❌ 没落到 ' + BV}`);
    for (const h of hops) console.log(`      ${h}`);
  }
}

/* 3) 形态对照（纯静态判据，用来证明"真卡短码"和"BV 当路径"确实不是一回事） */
console.log('\n── 形态对照');
for (const s of ['1ncmZVP', 'WZVnINP', 'WZcddcS', '0hEdnD1', '9kFv2VX', 'w1c4DfM', BV]) {
  console.log(`   ${s.padEnd(14)} 长度=${s.length}  ${/^BV[0-9A-Za-z]{10}$/.test(s) ? 'BV 号形态' : '不透明短码形态'}`);
}

/* 4) 把**历史真卡里那 6 个短码**逐个跟一遍，看它们各自落到哪条 BV。
 *    这一步是为了把"真卡短码 = 有效视频短链"坐实，而不是只看长度像。 */
const REAL_CODES = ['WZcddcS', 'WZVnINP', '0hEdnD1', '9kFv2VX', 'w1c4DfM', '1ncmZVP'];
console.log('\n── 历史真卡里的 6 个短码，逐个跟重定向');
for (const c of REAL_CODES) {
  const hops = await chain(`https://b23.tv/${c}`);
  const bv = hops.map((h) => /\/video\/(BV[0-9A-Za-z]{10})/.exec(h)?.[1]).find(Boolean) ?? '';
  console.log(`   ${c.padEnd(9)} → ${bv ? '✅ ' + bv : '❌ 没跟到 BV：' + hops.join(' ')}`);
}
