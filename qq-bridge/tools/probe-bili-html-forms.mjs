/* 探针：找一个「**点击时被补上 `.html` 也照样进视频页**」的 B 站 URL 形态。
 *
 * ── 要解决的问题 ────────────────────────────────────────────────────────────────
 * 用户点小程序卡片落到的地址是 `https://b23.tv/<短码>.html`（b23.tv 对它回
 * `{"code":-404,"message":"啥都木有"}`），而卡片里 `qqdocurl` 是**干净**的
 * （回读消息记录逐张核对：`detail_1.qqdocurl = https://b23.tv/QzqIREH?share_medium=…&ts=…`）。
 * 也就是说那个后缀是 QQ 侧在**点击那一刻**补的，我们既拦不住、也改不了它。
 *
 * ── 已经排除的 ──────────────────────────────────────────────────────────────────
 *   · 不是 b23.tv 自己补的：`probe-bili-html-suffix.mjs` 拿 **12 组** User-Agent × Referer
 *     （Chrome 桌面 / PC QQ / Android QQ / iOS QQ / X5 内核 / 微信 / curl）打同一个短码，
 *     第一跳 Location **一个字符都没变**，全是 302 到视频页。所以补 `.html` 的那一方在 QQ。
 *
 * ── 本探针的做法（换思路：既然拦不住，就找一个"补了也不怕"的形态）────────────────
 * 对每个候选形态，把 **QQ 可能贴出来的几种样子**都真打一遍，并用 `<title>` 里有没有
 * 目标视频标题来判定"是不是真的进了那条视频"（只看状态码会被机房 IP 的 412 风控骗过去）：
 *     原始形态 / 路径尾 + `.html` / 路径尾 + `.html` + 查询串 / 路径尾 + 两个 `.html`
 * 只要**四个变体全都进视频页**，这个形态就是"对 `.html` 免疫"的，可以放心当 qqdocurl。
 *
 * 用法：node tools/probe-bili-html-forms.mjs [BV号 ...]
 * 建议在**家宽**上跑：机房 IP 打 www.bilibili.com 稳定 412，判不出是 404 还是被拦。
 */
const UAS = {
  桌面: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  手机QQ: 'Mozilla/5.0 (Linux; U; Android 12; zh-cn; M2012K11AC Build/SKQ1.211006.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/89.0.4389.116 MQQBrowser/6.2 TBS/046123 Safari/537.36 V1_AND_SQ_8.9.33_1770_YYB_D QQ/8.9.33.10335 NetType/WIFI WebP/0.3.0',
};
const BVS = process.argv.slice(2).length ? process.argv.slice(2) : ['BV13Xb56NEEZ', 'BV1GJ411x7h7', 'BV1d4411N7zD'];

const jsonOf = async (url, ua) => {
  const r = await fetch(url, { headers: { 'user-agent': ua, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(15000) });
  return r.json();
};

/** 打一个 URL，返回 { status, finalUrl, title, hit }；hit = <title> 里出现目标标题前 12 字 */
async function probe(url, ua, wantTitle) {
  try {
    const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': ua, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(15000) });
    const body = await r.text();
    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? '').trim();
    return { status: r.status, finalUrl: r.url, title, hit: !!wantTitle && title.includes(wantTitle.slice(0, 12)) };
  } catch (e) { return { status: 0, finalUrl: '', title: `请求失败 ${e?.message ?? e}`, hit: false }; }
}

let failures = 0;
for (const BV of BVS) {
  const v = await jsonOf(`https://api.bilibili.com/x/web-interface/wbi/view?bvid=${BV}`, UAS.桌面);
  const aid = Number(v?.data?.aid) || 0;
  const title = String(v?.data?.title ?? '');
  console.log('='.repeat(100));
  console.log(`${BV}  aid=${aid}  标题=${JSON.stringify(title)}`);
  if (!aid || !title) { console.log('  （拿不到 aid/标题，跳过）'); failures += 1; continue; }

  /* 候选形态：只测"**点开真的会进那条视频**"这一件事 */
  const forms = [
    ['① b23.tv 官方短码（现在生产在用的形态）', `https://b23.tv/av${aid}`],
    ['② 桌面长链', `https://www.bilibili.com/video/${BV}`],
    ['③ 移动端 av + .html（B 站移动端历史形态，自带 .html 结尾）', `https://m.bilibili.com/video/av${aid}.html`],
    ['④ 移动端 av（不带 .html，作对照）', `https://m.bilibili.com/video/av${aid}`],
  ];

  for (const [name, base] of forms) {
    /* QQ 可能把 `.html` 贴在 pathname 尾（带查询串时贴在查询串**之前**），
     * 也可能贴在整个字符串末尾；这四种变体把两种情况都覆盖了。 */
    const variants = [
      ['原样', base],
      ['路径尾 + .html', `${base}.html`],
      ['路径尾 + .html + 查询串', `${base}.html?share_medium=android&share_source=qq&ts=${Date.now()}`],
      ['路径尾 + 两个 .html', `${base}.html.html`],
    ];
    for (const uaName of Object.keys(UAS)) {
      const marks = [];
      let allOk = true;
      for (const [tag, u] of variants) {
        const r = await probe(u, UAS[uaName], title);
        if (!r.hit) allOk = false;
        marks.push(`${r.hit ? '✅' : '❌'}${tag}(${r.status}${r.hit ? '' : '→' + (r.title || r.finalUrl).slice(0, 40)})`);
      }
      if (!allOk) failures += 1;
      console.log(`  ${allOk ? '★ 全变体都进视频页' : '  '} ${name}  [UA=${uaName}]`);
      console.log(`      ${marks.join('   ')}`);
    }
  }
  console.log('');
}
console.log(failures === 0
  ? '结论：上面所有形态都抗 .html ✅'
  : `结论：有 ${failures} 组不抗 .html ❌（只有标 ★ 的形态可以当 qqdocurl）`);
