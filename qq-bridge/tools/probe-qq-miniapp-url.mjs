/* 实测：卡片里的 `meta.detail_1.url`（`m.q.qq.com/a/s/<hash>` 这条 QQ 服务端签的短链）
 * 到底把客户端带到哪里去 —— 这是"点进去是不是那条视频"唯一能在服务端侧观察到的环节。
 *
 * 做法：拿真卡的 hash 和我们自己卡的 hash，分别用**QQ 的 UA**去请求，跟着重定向走到底，
 * 把每一跳的 Location 和终点页里出现的 bilibili 链接打出来，直接对比"两条卡指向的目标是否相同"。
 *
 * 用法：node probe-qq-miniapp-url.mjs <hash1> [hash2 ...]
 *      node probe-qq-miniapp-url.mjs real1036:3917dfae... our1337:f68181ed...
 */
const args = process.argv.slice(2);
if (!args.length) { console.log('用法：node probe-qq-miniapp-url.mjs [名字:]<hash> [...]'); process.exit(1); }

const UAS = {
  'Android-QQ': 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ2A.230505.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.0.0 Mobile Safari/537.36 V1_AND_SQ_8.9.63_4080_YYB_D QQ/8.9.63.10415 NetType/WIFI WebP/0.3.0 Pixel/1080',
  'iPhone-QQ': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 QQ/8.9.63.611 V1_IPH_SQ_8.9.63_1_APP_A',
  'PC-Chrome': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

const chainOnce = async (url, ua) => {
  const hops = [];
  let cur = url;
  for (let i = 0; i < 8; i += 1) {
    let res;
    try {
      res = await fetch(cur, { redirect: 'manual', headers: { 'user-agent': ua, accept: '*/*' }, signal: AbortSignal.timeout(15000) });
    } catch (e) { hops.push({ url: cur, note: `请求失败 ${e?.message ?? e}` }); break; }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      hops.push({ url: cur, status: res.status, loc });
      cur = new URL(loc, cur).toString();
      continue;
    }
    const text = await res.text().catch(() => '');
    hops.push({ url: cur, status: res.status, text });
    break;
  }
  return hops;
};

for (const a of args) {
  const idx = a.indexOf(':');
  const name = idx > 0 && !/^https?:/.test(a) ? a.slice(0, idx) : a;
  const hash = idx > 0 && !/^https?:/.test(a) ? a.slice(idx + 1) : a;
  const url = /^https?:/.test(hash) ? hash : `https://m.q.qq.com/a/s/${hash}`;
  console.log('\n' + '='.repeat(96));
  console.log(`### ${name}  ${url}`);
  for (const [uaName, ua] of Object.entries(UAS)) {
    console.log(`  ── UA=${uaName}`);
    const hops = await chainOnce(url, ua);
    for (const h of hops) {
      if (h.loc) console.log(`     ${h.status} ${h.url}\n        → ${h.loc}`);
      else if (h.status) {
        const t = String(h.text ?? '');
        console.log(`     ${h.status} (终点) ${h.url}  len=${t.length}`);
        // 终点页里所有跟 bilibili / 跳转有关的线索
        const hits = [...t.matchAll(/https?:\/\/[^\s"'<>\\]*(?:bilibili|b23\.tv)[^\s"'<>\\]*/g)].map((m) => m[0]);
        const bv = [...t.matchAll(/BV[0-9A-Za-z]{10}/g)].map((m) => m[0]);
        const mini = [...t.matchAll(/(?:miniapp|appid|scheme|mqqapi)[^\s"'<>]{0,120}/gi)].map((m) => m[0]).slice(0, 6);
        if (hits.length) console.log(`        页内 bilibili 链接：${[...new Set(hits)].slice(0, 6).join(' | ')}`);
        if (bv.length) console.log(`        页内 BV 号：${[...new Set(bv)].join(', ')}`);
        if (mini.length) console.log(`        页内小程序线索：${mini.join(' | ').slice(0, 400)}`);
        /* 页面本身是个壳，真正决定"打开小程序哪个页面"的参数多半在 JS/接口里 ——
         * 把 script src 和所有 /cgi 类接口原样列出来，好在下一步直接打那个接口。 */
        const scripts = [...t.matchAll(/<script[^>]*src=["']([^"']+)["']/g)].map((m) => m[1]);
        const cgis = [...t.matchAll(/["'(](\/[a-zA-Z0-9_\-/]*(?:cgi|api|get|json)[a-zA-Z0-9_\-/]*)["')]/g)].map((m) => m[1]);
        if (scripts.length) console.log(`        外链脚本：${[...new Set(scripts)].join(' | ').slice(0, 400)}`);
        if (cgis.length) console.log(`        页面内接口路径：${[...new Set(cgis)].join(' | ').slice(0, 400)}`);
        const ext = [...t.matchAll(/https?:\/\/[a-z0-9.-]*qq\.com\/[^\s"'<>]+/gi)].map((m) => m[0]);
        if (ext.length) console.log(`        页内 qq.com 链接：${[...new Set(ext)].slice(0, 8).join(' | ').slice(0, 500)}`);
      } else {
        console.log(`     ${h.note} ${h.url}`);
      }
    }
  }
}
