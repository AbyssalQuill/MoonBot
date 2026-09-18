/* 探针：`detail_1.url`（`m.q.qq.com/a/s/<hash>`）到底会不会把点击落到 `…<短码>.html`。
 *
 * 为什么怀疑它：用户点开卡片的最终地址是 `https://b23.tv/<短码>.html`，
 * 而卡片里我们给 QQ 的 `qqdocurl` 是**干净**的（回读消息记录逐张核对过，没有 `.html`）。
 * 上一轮只在"b23.tv 会不会自己补"上找过原因（本目录 probe-bili-html-suffix.mjs 已排除：
 * 换 12 组 UA/Referer，b23.tv 的第一跳 Location 一个字都没变）。
 * 剩下唯一一个"点一下就会真正发生的事"就是：客户端/服务端把 `detail_1.url` 这个
 * **QQ 自己签的短链** 展开成目标地址 —— 如果展开时按"文档路径"补了 `.html`，
 * 那它就是元凶，而且**这一条在服务端就能测**（跟重定向链即可）。
 *
 * 用法：node tools/probe-qq-hash-redirect.mjs [hash ...]
 * 不带参数时用下面写死的两组对照：一张**我们的卡** + 一张**真人卡**。
 */
const TIMEOUT = 15000;

const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_QQ_PC = 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36 Core/1.98.4.400 QQBrowser/11.10.4396.400';
const UA_QQ_ANDROID = 'Mozilla/5.0 (Linux; U; Android 12; zh-cn; M2012K11AC Build/SKQ1.211006.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/89.0.4389.116 MQQBrowser/6.2 TBS/046123 Safari/537.36 V1_AND_SQ_8.9.33_1770_YYB_D QQ/8.9.33.10335 NetType/WIFI WebP/0.3.0';
const UA_QQ_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 QQ/8.9.33.606 V1_IPH_SQ_8.9.33_1_APP_A Pixel/1125';

/** 对照样本（都是从 /root/qq-bridge 的回读里抄来的原文，没有手改）：
 *   ① 我们的卡：2026-09-18 15:50:12 私聊 1736784911，qqdocurl 带查询串（上一轮"修过"的那张，
 *      用户点开仍落到 `.html`）
 *   ② 我们的卡（更早）：qqdocurl 是**长链**，没有任何查询串
 *   ③ 真人卡：群 868756515，scene=1036，qqdocurl 带 bbid
 *   ④ 用户自己发的卡：scene=0 + 纯长链 qqdocurl（就是"真卡里也存在长链形态"那张样本）
 */
const SAMPLES = [
  ['① 我们的卡（短码+查询串，用户说点开仍 404）', '9c60a79f4ab5c96b8b5506188ea7fdb8'],
  ['② 我们的卡（qqdocurl=纯长链）', '6ed850ccbc74eca845ef6e2a18c77536'],
  ['③ 真人卡（scene=1036，带 bbid）', '36c0400d1c2288add530d0c3f0d21f76'],
  ['④ 用户自己发的卡（scene=0 + 纯长链）', '0a94c1b1126e836c064f08e047e930ea'],
];

const hashes = process.argv.slice(2).length ? process.argv.slice(2).map((h) => [h, h]) : SAMPLES;

/** 手动跟链：每一跳都打出来；终点若是 HTML，把里面所有 bilibili/b23.tv 链接抠出来 */
async function chase(url, ua, maxHops = 8) {
  const hops = [{ url, status: 0, loc: '' }];
  let cur = url;
  for (let i = 0; i < maxHops; i += 1) {
    let r;
    try {
      r = await fetch(cur, { redirect: 'manual', headers: { 'user-agent': ua, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }, signal: AbortSignal.timeout(TIMEOUT) });
    } catch (e) { hops.push({ url: cur, status: 0, loc: `请求失败 ${e?.message ?? e}` }); break; }
    const loc = r.headers.get('location') || '';
    if (r.status >= 300 && r.status < 400 && loc) {
      const next = new URL(loc, cur).toString();
      hops.push({ url: next, status: r.status, loc: next });
      cur = next;
      continue;
    }
    const body = await r.text().catch(() => '');
    hops.push({ url: cur, status: r.status, loc: '', body });
    break;
  }
  return hops;
}

for (const [label, hash] of hashes) {
  const start = `https://m.q.qq.com/a/s/${hash}`;
  console.log('='.repeat(100));
  console.log(`${label}`);
  console.log(`  起点 ${start}`);
  for (const [uaName, ua] of [['PC Chrome', UA_PC], ['PC QQ', UA_QQ_PC], ['Android QQ', UA_QQ_ANDROID], ['iOS QQ', UA_QQ_IOS]]) {
    const hops = await chase(start, ua);
    console.log(`  ── UA=${uaName}`);
    for (const h of hops) {
      if (h.status === 0 && !h.body) { console.log(`       ${h.loc}`); continue; }
      if (h.loc) console.log(`       ${h.status} → ${h.loc}`);
      else {
        console.log(`       ${h.status}（终点，${h.body?.length ?? 0} 字节）`);
        /* 终点页正文里出现的所有外链：真卡/我们的卡如果落点不同，这里能直接看出来 */
        const links = [...new Set(String(h.body ?? '').match(/https?:\/\/[^\s"'<>()\\]+/g) ?? [])]
          .filter((u) => /bilibili|b23\.tv|\.html/i.test(u)).slice(0, 8);
        for (const l of links) console.log(`          body 里的链接：${l}`);
        const html = String(h.body ?? '').match(/[\w./-]+\.html/gi);
        if (html) console.log(`          body 里出现的 .html 片段：${[...new Set(html)].slice(0, 6).join(' | ')}`);
      }
    }
  }
  console.log('');
}
