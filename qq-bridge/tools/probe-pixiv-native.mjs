/* 镜像站前端 JS 里暴露了另一组接口（白名单）：api/native.php / api/pixiv/ / api/detail.php 等。
 * 这些可能是**原站透传口** —— 如果它们接受 Pixiv 官方参数，就能真正支持"各种参数搜索"。
 * 逐个探它们的形状（只 GET，不改任何东西）。
 *
 * 用法：node qq-bridge/tools/probe-pixiv-native.mjs
 */
const HOSTS = ['https://x.pixigraph.xyz', 'https://pixigraph.online'];
const KW = encodeURIComponent('初音ミク');

const tries = [
  ['detail.php?id=149807268', '/api/detail.php?id=149807268'],
  ['native.php（空参）', '/api/native.php'],
  ['native.php?url=…search…', `/api/native.php?url=${encodeURIComponent(`https://www.pixiv.net/ajax/search/illust/${decodeURIComponent(KW)}?mode=r18&p=1`)}`],
  ['pixiv/（空）', '/api/pixiv/'],
  ['pixiv/ajax/search/illust/…', `/api/pixiv/ajax/search/illust/${KW}?mode=r18&p=1`],
  ['pixiv/search/illust/…', `/api/pixiv/search/illust/${KW}?mode=r18&p=1`],
  ['creator/list.php?uid=…', '/api/creator/list.php'],
  ['image-status.php', '/api/image-status.php'],
];

for (const host of HOSTS) {
  console.log(`\n########## ${host} ##########`);
  for (const [label, path] of tries) {
    try {
      const res = await fetch(host + path, { headers: { 'user-agent': 'Mozilla/5.0', referer: `${host}/` }, signal: AbortSignal.timeout(20000) });
      const text = await res.text();
      let j = null; try { j = JSON.parse(text); } catch {}
      if (j) {
        const keys = Object.keys(j).slice(0, 10).join(',');
        const im = j?.body?.illustManga ?? j?.illustManga;
        console.log(`${label.padEnd(34)} HTTP ${res.status} JSON keys=${keys}${im ? `  illustManga.total=${im.total}` : ''}`);
        if (!im && text.length < 600) console.log('      ' + text.replace(/\s+/g, ' ').slice(0, 260));
      } else {
        console.log(`${label.padEnd(34)} HTTP ${res.status} 非JSON(${text.length}字) ${text.replace(/\s+/g, ' ').slice(0, 130)}`);
      }
    } catch (error) {
      console.log(`${label.padEnd(34)} ERR ${error?.message ?? error}`);
    }
  }
}
