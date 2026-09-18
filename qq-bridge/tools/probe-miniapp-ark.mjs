/* 探针：直接问 NapCat 的 get_mini_app_ark 要 Ark，逐个参数组合打印**完整原始返回**，
 * 目的是找出「真实 B 站卡里有 qqdocurl、我们生成的卡里没有」差在哪个请求参数上。
 *
 * 用法：node probe-miniapp-ark.mjs
 */
const TOKEN = process.env.NAPCAT_TOKEN || '061228';
const HTTP = process.env.NAPCAT_HTTP || 'http://127.0.0.1:3000';

const BV = process.env.PROBE_BV || 'BV1GJ411x7h7';
const TITLE = 'Never Gonna Give You Up - Rick Astley';
const PIC = 'https://i0.hdslb.com/bfs/archive/0d3ba4c9c55e6fefd1e1d4b0b0b6b4b4a4a4a4a4.jpg';

const post = async (ep, body) => {
  const r = await fetch(`${HTTP}/${ep}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000)
  });
  return r.json();
};

const cases = [
  ['A 现状（不传 webUrl，jumpUrl=b23.tv 短链）', {
    type: 'bili', title: TITLE, desc: 'desc', picUrl: PIC, jumpUrl: `https://b23.tv/${BV}`
  }],
  ['B 传 webUrl = b23.tv 短链', {
    type: 'bili', title: TITLE, desc: 'desc', picUrl: PIC,
    jumpUrl: `https://b23.tv/${BV}`, webUrl: `https://b23.tv/${BV}`
  }],
  ['C 传 webUrl = bilibili 长链', {
    type: 'bili', title: TITLE, desc: 'desc', picUrl: PIC,
    jumpUrl: `https://b23.tv/${BV}`, webUrl: `https://www.bilibili.com/video/${BV}`
  }],
  ['D 长链 jumpUrl + 长链 webUrl', {
    type: 'bili', title: TITLE, desc: 'desc', picUrl: PIC,
    jumpUrl: `https://www.bilibili.com/video/${BV}`, webUrl: `https://www.bilibili.com/video/${BV}`
  }]
];

for (const [label, body] of cases) {
  console.log('='.repeat(96));
  console.log(`### ${label}`);
  console.log(`请求: ${JSON.stringify(body)}`);
  let j;
  try {
    j = await post('get_mini_app_ark', { ...body, rawArkData: 'true' });
  } catch (e) {
    console.log(`请求失败: ${e?.message ?? e}\n`);
    continue;
  }
  const raw = j?.data?.data ?? j?.data ?? null;
  console.log(`status=${j?.status} message=${j?.message ?? ''}`);
  if (!raw) { console.log(`原始返回: ${JSON.stringify(j).slice(0, 500)}\n`); continue; }
  const d1 = raw?.metaData?.detail_1 ?? {};
  console.log(`  appName=${raw.appName}  appView=${raw.appView}`);
  console.log(`  metaData.detail_1.url      = ${d1.url ?? '(无)'}`);
  console.log(`  metaData.detail_1.qqdocurl = ${d1.qqdocurl ?? '(无 qqdocurl)'}`);
  console.log(`  metaData.detail_1.preview  = ${String(d1.preview ?? '').slice(0, 90)}`);
  console.log(`  config.token = ${raw?.config?.token ?? '(无)'}`);
  console.log(`  完整 metaData.detail_1 = ${JSON.stringify(d1)}`);
  console.log('');
}
