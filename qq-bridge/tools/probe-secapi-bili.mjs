/* 只读探针：把第三方解析接口 secapi.top 的 B 站接口**摸全**，不改任何业务代码。
 *
 * 目的（对应"先摸接口再改代码"这条要求）：在把 secapi 接进 `resolveBilibili` 之前，
 * 必须先知道 ① 字段全集（尤其**有没有可播放直链**、画质字段）② 错误形态
 * （无效 BV / 已删除 / 超时各自返回什么 HTTP + body）③ 稳定性（连胜调用会不会限流、耗时多少）
 * ④ 是否认别的平台（接口名只写了 bilibili）。
 *
 * 用法（cwd 任意；在**服务器上**跑才代表桥的真实出口 IP）：
 *   node qq-bridge/tools/probe-secapi-bili.mjs            # 跑全部用例
 *   node qq-bridge/tools/probe-secapi-bili.mjs --quick    # 只跑"字段全集"那一段
 * 环境变量：
 *   SECAPI_BILI_BASE  覆盖接口前缀，默认 http://secapi.top/API/jiexi/bilibili.php
 *   SECAPI_BILI_BV    指定用来打全字段的 BV，默认 BV13Xb56NEEZ
 * 产物：state/probe-secapi-bili/*.json（原始返回，方便 diff）。
 *   为什么落在 `state/` 下：那是仓库里已经 gitignore 的"运行数据"目录，
 *   探针产物不会变成待提交的脏文件（放到根目录会被 git status 一直挂着）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.SECAPI_BILI_BASE || 'http://secapi.top/API/jiexi/bilibili.php';
const BV = process.env.SECAPI_BILI_BV || 'BV13Xb56NEEZ';
const SHORT_URL = process.env.SECAPI_BILI_SHORT || 'https://b23.tv/hcBfL2T';
const OUT = 'state/probe-secapi-bili';
const QUICK = process.argv.includes('--quick');

mkdirSync(OUT, { recursive: true });

const UA = 'Mozilla/5.0';

/** 统一打一次请求，把"我们这侧看到的一切"都记下来：状态码/耗时/字节数/content-type/正文。 */
async function hit(label, params, { timeoutMs = 20000, headers = { 'user-agent': UA } } = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}?${qs}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    const ms = Date.now() - t0;
    let json = null;
    try { json = JSON.parse(text); } catch { /* 不是 JSON 就留 null */ }
    console.log(`\n===== ${label} =====`);
    console.log(`GET ${url}`);
    console.log(`→ HTTP ${res.status} ${res.headers.get('content-type') || '(无 content-type)'} ${text.length}B ${ms}ms`);
    console.log(text.length > 4000 ? `正文（截断 4000 字）：\n${text.slice(0, 4000)}` : `正文：\n${text}`);
    writeFileSync(`${OUT}/${label.replace(/[^\w.-]+/g, '_')}.json`, text);
    return { label, url, status: res.status, ct: res.headers.get('content-type'), ms, text, json };
  } catch (error) {
    const ms = Date.now() - t0;
    console.log(`\n===== ${label} =====`);
    console.log(`GET ${url}`);
    console.log(`→ 抛异常（${ms}ms）：${error?.name}: ${error?.message ?? error}`);
    return { label, url, status: 0, ct: '', ms, text: '', json: null, err: String(error?.name) + ': ' + String(error?.message ?? error) };
  }
}

/** 把任意 JSON 拍平成 `路径 = 值`，用来一眼看全字段（含嵌套）。 */
function flatten(node, prefix = '', out = []) {
  if (Array.isArray(node)) {
    if (!node.length) out.push(`${prefix} = []（空数组）`);
    node.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    return out;
  }
  if (node && typeof node === 'object') {
    const keys = Object.keys(node);
    if (!keys.length) out.push(`${prefix} = {}（空对象）`);
    for (const k of keys) flatten(node[k], prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out.push(`${prefix} = ${JSON.stringify(node)}`);
  return out;
}

/** 从整份返回里"地毯式"找可能的直链：值里带 http 且像媒体/播放地址的。 */
function huntPlayUrls(node, path = '', hits = []) {
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) huntPlayUrls(v, path ? `${path}.${k}` : k, hits);
    return hits;
  }
  if (typeof node !== 'string') return hits;
  if (!/^https?:\/\//i.test(node)) return hits;
  // 已知的封面图床/主页域名不算"播放直链"
  const isImage = /\.(jpg|jpeg|png|webp|gif|avif)(\?|$)/i.test(node) || /hdslb\.com\/bfs\/archive/i.test(node);
  hits.push({ path, url: node, isImage });
  return hits;
}

/** 探一个 URL：能不能取到、什么类型、头 1KB 是不是真 MP4。
 *
 * ⚠️ **只读前 1KB 就把流掐掉**：这个代理会把整个 mp4 吐出来（一条 29MB），
 * `await res.arrayBuffer()` 老老实实读完的结果就是 15s 超时 + 什么都看不到
 * （第一版探针就是这么被坑的：video/mp4 那几条 magic 全空，其实字节是好的）。
 * 读到 JSON 时把正文前 300 字带回来 —— 失败时它返回的是**伪装成 200 的 JSON**。 */
async function probeUrl(url, { referer = '', range = 'bytes=0-1023' } = {}) {
  const headers = { 'user-agent': UA };
  if (referer) headers.referer = referer;
  if (range) headers.range = range;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    const chunks = [];
    let got = 0;
    if (res.body) {
      const reader = res.body.getReader();
      while (got < 1024) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        got += value.length;
      }
      try { await reader.cancel(); } catch { /* ignore */ }
    }
    const buf = Buffer.concat(chunks).subarray(0, 1024);
    const ct = String(res.headers.get('content-type') || '');
    const isJson = /json/i.test(ct) || buf[0] === 0x7b;   // 0x7b = '{'
    return {
      ok: res.ok, status: res.status, ct, len: res.headers.get('content-length'),
      magic: buf.subarray(0, 12).toString('hex'), len_read: got,
      ...(isJson ? { body: buf.toString('utf8').slice(0, 300) } : {}),
      ms: Date.now() - t0,
    };
  } catch (error) {
    return { ok: false, status: 0, ct: '', len: '', magic: '', ms: Date.now() - t0, err: String(error?.message ?? error) };
  }
}

const print = (o) => console.log('  ' + JSON.stringify(o));

console.log(`探针目标：${BASE}`);
console.log(`字段全集用 BV：${BV}`);

/* ── 1) 字段全集：长链 / 裸 BV / b23.tv 短码 三种入参，打全 JSON 并拍平 ───────── */
const main = await hit('A1_长链URL', { url: `https://www.bilibili.com/video/${BV}` });
const bare = await hit('A2_裸BV', { url: BV });
const short = await hit('A3_b23短码', { url: SHORT_URL }, { timeoutMs: 25000 });

const full = main.json || bare.json || short.json || null;
if (full) {
  console.log('\n########## 字段全集（拍平，看这一份就够） ##########');
  for (const line of flatten(full)) console.log(line);

  console.log('\n########## 所有 http(s) 值（找播放直链） ##########');
  const urls = huntPlayUrls(full);
  for (const h of urls) console.log(`  [${h.isImage ? '图' : '★非图'}] ${h.path} = ${h.url}`);
  if (!urls.some((h) => !h.isImage)) console.log('  （除图片以外没有任何 http 值 —— 见下面结论）');

  console.log('\n########## 疑似播放地址的字段名扫描 ##########');
  const flatLines = flatten(full);
  const suspect = flatLines.filter((l) => /(播放地址|播放链接|直链|url|link|video_url|play|src|地址|画质|清晰|quality|qn|分辨率|durl|backup)/i.test(l));
  for (const l of suspect) console.log('  ' + l);
  if (!suspect.length) console.log('  （没有匹配到任何疑似字段）');

  /* 直链探活：真去 GET 一下，看要不要 Referer、会不会 403、是不是分片。
   * ⚠️ 探针**故意只取头 1KB**（带 Range）—— 不带 Range 时这个代理会把整个 mp4 吐出来，
   * 一次就是 29MB，既慢又没意义（我们只关心"能不能取到、什么类型、是不是真 mp4"）。 */
  console.log('\n########## 直链探活（带/不带 Referer；带 Range 看是否分段） ##########');
  for (const h of urls.filter((x) => !x.isImage)) {
    print({ url: h.url.slice(0, 120) + '…', 元信息: await probeUrl(h.url, { range: 'bytes=0-1023' }) });
  }

  /* 把 `code=` 那段 base64 解开，看**真实 CDN 地址**与 `deadline`（有时效就绝不能进缓存）。 */
  console.log('\n########## 播放直链解包（code= 是 base64 包了一层） ##########');
  const pods = full?.视频播放地址;
  if (pods && typeof pods === 'object' && !Array.isArray(pods)) {
    for (const [q, v] of Object.entries(pods)) {
      const link = String(v?.视频链接 ?? '');
      let real = '';
      try { real = Buffer.from(link.split('code=')[1] || '', 'base64').toString('utf8'); } catch { /* ignore */ }
      const dl = Number((real.match(/[?&]deadline=(\d+)/) || [])[1] || 0);
      const ttl = dl ? dl - Math.floor(Date.now() / 1000) : 0;
      console.log(`  ${q}: 文件大小=${v?.文件大小} 时长字段=${v?.['时长(秒)']}（注意：这个值看着是**毫秒**，不是秒）`);
      console.log(`      真实地址=${real.split('?')[0]}`);
      console.log(`      deadline=${dl || '(无)'} → 距今 ${dl ? (ttl > 0 ? `还剩 ${Math.round(ttl / 60)} 分钟（会过期）` : `已过期 ${Math.round(-ttl / 60)} 分钟`) : '不适用'}`);
    }
  } else {
    console.log(`  （视频播放地址 不是对象，实际是：${JSON.stringify(pods)}）`);
  }

  /* 哪些清晰度能真取到、哪些取回来的是 JSON —— 逐个验，别拿一个当全体。 */
  console.log('\n########## 逐个清晰度实取（Range 1KB） ##########');
  if (pods && typeof pods === 'object' && !Array.isArray(pods)) {
    for (const [q, v] of Object.entries(pods)) {
      const link = String(v?.视频链接 ?? '');
      const r = await probeUrl(link);
      const looksMp4 = String(r.magic || '').includes('66747970');   // "ftyp"
      console.log(`  ${q}: HTTP ${r.status} ct=${r.ct} magic=${r.magic || '(空)'} ${looksMp4 ? '✅ 真 MP4 字节' : '⚠️ 不是 MP4'}`);
      if (r.body) console.log(`     正文=${r.body.replace(/\s+/g, ' ')}`);
    }
  }
}

/* ── 2) 入参形态矩阵：接进桥之前必须知道**到底能喂什么** ─────────────────────── */
console.log('\n########## 入参形态矩阵 ##########');
const FORMS = [
  ['长链', `https://www.bilibili.com/video/${BV}`],
  ['长链带query', `https://www.bilibili.com/video/${BV}?spm_id_from=333.999&vd_source=abc`],
  ['裸BV', BV],
  ['裸BV小写bv', `bv${BV.slice(2)}`],
  ['b23短码', SHORT_URL],
  ['b23短码带query', `${SHORT_URL}?share_medium=android&share_source=qq&bbid=X&ts=1789000000`],
  ['b23带BV', `https://b23.tv/${BV}`],
  ['av链接', 'https://www.bilibili.com/video/av113000000000000'],
  ['手机端长链', `https://m.bilibili.com/video/${BV}`],
];
for (const [name, u] of FORMS) {
  const r = await hit(`G_${name}`, { url: u });
  console.log(`  → ${name}：code=${r.json?.code ?? '(无)'} 状态=${r.json?.状态 ?? '(无)'} BVID=${r.json?.视频信息?.BVID ?? '(无)'} 标题=${String(r.json?.视频信息?.标题 ?? '').slice(0, 24) || '(空)'}`);
}

/* ── 3) 参数名与错用形态：确认 `url` 才认 ─────────────────────────────────────── */
await hit('B1_错误参数bv', { bv: BV });

/* ── 3) 错误形态：无效 BV / 不存在的视频 / 已删除视频 ────────────────────────── */
await hit('C1_无效BV格式', { url: 'BV0000000000' });
await hit('C2_随机不存在BV', { url: 'BV1zz411c7zz' });
await hit('C3_不存在的aid', { url: 'https://www.bilibili.com/video/av99999999' });
await hit('C4_非B站链接', { url: 'https://www.bilibili.com/' });
await hit('C5_空参数', {});

if (!QUICK) {
  /* ── 4) 超时：把 timeout 压到 1ms，看**我们这侧**是抛什么（接口本身的超时抓不到）── */
  await hit('D1_1ms超时', { url: `https://www.bilibili.com/video/${BV}` }, { timeoutMs: 1 });

  /* ── 5) 稳定性：连胜 10 次，看限流与耗时分布 ─────────────────────────────────── */
  console.log('\n########## 稳定性：连胜 10 次 ##########');
  const times = [];
  let fail = 0;
  for (let i = 1; i <= 10; i += 1) {
    const r = await hit(`E_stab_${String(i).padStart(2, '0')}`, { url: `https://www.bilibili.com/video/${BV}` });
    times.push(r.ms);
    const okCode = Number(r.json?.code ?? 0);
    if (!r.json || r.status !== 200 || okCode !== 200) fail += 1;
    console.log(`  第 ${i} 次：HTTP ${r.status} code=${r.json?.code ?? '(无)'} ${r.ms}ms 状态=${r.json?.状态 ?? '(无)'}`);
    await new Promise((res) => setTimeout(res, 700));   // 别打成压测，留出间隔
  }
  const sorted = [...times].sort((a, b) => a - b);
  console.log(`  成功 ${10 - fail}/10，失败 ${fail}；耗时 min=${sorted[0]}ms 中位=${sorted[Math.floor(sorted.length / 2)]}ms max=${sorted[sorted.length - 1]}ms`);

  /* ── 6) 是否认别的平台 ──────────────────────────────────────────────────────── */
  console.log('\n########## 其它平台 ##########');
  await hit('F1_抖音', { url: 'https://v.douyin.com/iRNBho6/' });
  await hit('F2_快手', { url: 'https://v.kuaishou.com/abcdef' });
  await hit('F3_微博', { url: 'https://weibo.com/tv/show/1034:4970000000000000' });
}

console.log('\n探针结束。原始返回都落在 ' + OUT + '/ 下，可 diff。');
