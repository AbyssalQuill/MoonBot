/* 抽样验证 `https://b23.tv/<BV号>` 是不是**真能**跳到那个 BV。
 *
 * 为什么必须抽样：全仓库只有主人手测过 1 个 BV（BV1GJ411x7h7）就写进了注释，
 * 而 b23.tv 的路径位本来是**短码**（如 /WZVnINP）。要判断"点进去不是那个视频"
 * 是不是短链被当短码解析，唯一办法就是拿一批真实 BV 逐个跑重定向链。
 *
 * 用法：node probe-b23-bv.mjs [个数]
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const n = Math.min(12, Math.max(1, Number(process.argv[2] || 6)));

/* 取一批**真实且互不相同**的 BV：用 bilibili 排行榜（不需要登录、不是搜索风控那条路） */
async function fetchBvids() {
  const out = [];
  const endpoints = [
    'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all',
    'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1'
  ];
  for (const u of endpoints) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(12000) });
      const j = await r.json();
      const list = j?.data?.list ?? [];
      for (const v of list) if (/^BV[0-9A-Za-z]{10}$/.test(String(v.bvid))) out.push({ bvid: v.bvid, title: String(v.title ?? '').slice(0, 40) });
    } catch (e) { console.log(`  (取榜单失败 ${u}: ${e?.message ?? e})`); }
    if (out.length >= n) break;
  }
  return out.slice(0, n);
}

/** 手动跟重定向链，把每一跳打出来 */
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
    hops.push(`${res.status} (终点)`);
    break;
  }
  return hops;
}

const items = await fetchBvids();
if (!items.length) { console.log('取不到真实 BV，退出'); process.exit(1); }

console.log(`抽样 ${items.length} 个真实 BV：\n`);
let bad = 0;
for (const { bvid, title } of items) {
  const shortUrl = `https://b23.tv/${bvid}`;
  const hops = await chain(shortUrl);
  /* 判据：**302 那一跳的 Location** 里必须出现同一个 BV。
   * 不能拿最后一跳比 —— 终点页在机房 IP 上恒为 412（风控），URL 里当然没有 BV。 */
  const locHop = hops.find((h) => /^3\d\d → /.test(h)) ?? '';
  const ok = locHop.includes(bvid) && /\/video\/(BV[0-9A-Za-z]{10})/.exec(locHop)?.[1] === bvid;
  if (!ok) bad += 1;
  console.log(`${ok ? '✅' : '❌'} ${bvid}  ${title}`);
  for (const h of hops) console.log(`     ${h}`);
  console.log('');
}
console.log(`结论：${items.length} 个里 ${items.length - bad} 个跳对，${bad} 个跳错/没跳到目标 BV`);
