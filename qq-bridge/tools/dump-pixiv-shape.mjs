/* 把镜像站搜索接口的**原始返回结构**打出来（形状不明时唯一的办法）。
 * 用法：node qq-bridge/tools/dump-pixiv-shape.mjs [关键词]
 */
const BASE = 'https://x.pixigraph.xyz';
const kw = process.argv[2] || '初音ミク';

const url = `${BASE}/api/search.php?keyword=${encodeURIComponent(kw)}&page=1`;
const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(25000) });
const j = await res.json();

const shape = (v, depth = 0) => {
  if (depth > 3) return '…';
  if (Array.isArray(v)) return `[${v.length}]${v.length ? ' of ' + shape(v[0], depth + 1) : ''}`;
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).slice(0, 14).map((k) => `${k}:${shape(v[k], depth + 1)}`).join(', ') + '}';
  }
  return typeof v;
};

console.log('HTTP', res.status);
console.log('结构：', JSON.stringify(shape(j), null, 2).slice(0, 2000));
console.log('\n原始前 1500 字：\n' + JSON.stringify(j).slice(0, 1500));

/* 顺便看它前端 app.js 里到底怎么拼参数 */
try {
  const js = await (await fetch(`${BASE}/assets/app.js?v=20260831apifo2`, { signal: AbortSignal.timeout(25000) })).text();
  const i = js.indexOf('search.php');
  console.log('\n=== app.js 里 search.php 附近的原文 ===');
  console.log(js.slice(Math.max(0, i - 700), i + 700).replace(/\s+/g, ' '));
} catch (e) { console.log('取 app.js 失败：', e?.message ?? e); }
