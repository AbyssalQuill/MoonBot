/* 判定镜像站到底认哪些参数 —— 用 `body.illustManga.total` + 首个 id 做**可观测对比**。
 *
 * 第一版教训：只看顶层 key 什么都没看出来。真实结构是
 *   { error:false, body:{ illustManga:{ data:[…], total, lastPage, bookmarkRanges }, … } }
 * 也就是**Pixiv 官方 /ajax/search/illust/{word} 的原样结构** —— 所以官方那套参数名
 * （mode / s_mode / order / p / type / bl）**很可能被直接透传**。这里逐个验。
 *
 * 用法：node qq-bridge/tools/probe-pixiv-params.mjs [关键词]
 */
const BASE = 'https://x.pixigraph.xyz';
const KW = process.argv[2] || '初音ミク';
const enc = encodeURIComponent(KW);

async function probe(label, extra = '') {
  const qs = `keyword=${enc}${extra}`;
  try {
    const res = await fetch(`${BASE}/api/search.php?${qs}`, {
      headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000)
    });
    const j = await res.json().catch(() => null);
    const im = j?.body?.illustManga;
    if (!im?.data) { console.log(`${label.padEnd(38)} HTTP ${res.status} 无 illustManga（error=${j?.error}）`); return null; }
    const ids = im.data.slice(0, 4).map((x) => String(x.id));
    const r18 = im.data.filter((x) => Number(x.xRestrict) === 1).length;
    const out = { total: im.total, lastPage: im.lastPage, n: im.data.length, ids, r18 };
    console.log(
      `${label.padEnd(38)} total=${String(im.total).padStart(7)} lastPage=${String(im.lastPage).padStart(3)}`
      + ` 本页=${String(out.n).padStart(2)} 本页R18=${String(r18).padStart(2)} 前4=${ids.join(',')}`
    );
    return out;
  } catch (error) {
    console.log(`${label.padEnd(38)} ERR ${error?.message ?? error}`);
    return null;
  }
}

const base = await probe('① 基线（只有 keyword）');
console.log('');

console.log('=== mode 全年龄/不过滤/R18（官方参数）===');
const safe = await probe('mode=safe', '&mode=safe');
const all = await probe('mode=all', '&mode=all');
const r18 = await probe('mode=r18', '&mode=r18');
console.log('');

console.log('=== s_mode 搜索范围（官方参数）===');
await probe('s_mode=s_tag（默认）', '&s_mode=s_tag');
await probe('s_mode=s_tag_full（完全匹配）', '&s_mode=s_tag_full');
await probe('s_mode=s_tc（标题说明）', '&s_mode=s_tc');
console.log('');

console.log('=== order 排序（官方参数）===');
await probe('order=date_d（最新）', '&order=date_d');
await probe('order=popular_d（热门）', '&order=popular_d');
await probe('order=popular_male_d', '&order=popular_male_d');
console.log('');

console.log('=== 页码 / 收藏数下限 / 类型 ===');
await probe('p=1', '&p=1');
await probe('p=2', '&p=2');
await probe('page=2（镜像自称的参数名）', '&page=2');
await probe('bl=1000（收藏≥1000）', '&bl=1000');
await probe('type=illust', '&type=illust');
await probe('type=manga', '&type=manga');
console.log('');

console.log('=== 对照结论 ===');
const verdict = (name, a, b) => {
  if (!a || !b) { console.log(`  ${name}: 数据不足，无法判定`); return; }
  const sameIds = a.ids.join() === b.ids.join();
  const sameTotal = a.total === b.total;
  console.log(`  ${name}: ${(!sameIds || !sameTotal) ? '**有差异 → 生效**' : '完全一致 → 疑似无效/被忽略'}`
    + `（total ${a.total} vs ${b.total}，首个 id ${a.ids[0]} vs ${b.ids[0]}）`);
};
verdict('mode=safe  vs  mode=r18', safe, r18);
verdict('mode=all   vs  mode=safe', all, safe);
verdict('p=1        vs  p=2', base, await probe('p=2 复核', '&p=2'));
