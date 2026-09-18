/* 实测：`get_mini_app_ark` 的 `scene` 能不能**由我们指定**，真卡那张 1036 是"请求里带的"还是
 * "QQ 服务端按别的字段自己算的"。
 *
 * 为什么必须先验证：真卡的 detail_1.scene=1036、我们的卡=0，看上去像是一个可以照抄的参数；
 * 但 NapCat 的 bili 模板里 scene 本来就写的是 **1**（见 /root/napcat-build/napcat.mjs 里
 * `class rs { static Bili = ... scene: 1 ... }`），而我们回读到的却是 0 —— 也就是说
 * **请求里的 scene 和卡片里的 scene 未必是同一个值**。瞎填一个 1036 可能不但没用，
 * 还会把别的字段带偏，所以这里做"同一 BV、只改 scene"的对照实验，直接看服务端回什么。
 *
 * NapCat 的 get_mini_app_ark 有两套入参（见 napcat.mjs 的 fSe 联合 schema）：
 *   A 模板形式：{ type:'bili', title, desc, picUrl, jumpUrl, webUrl? }        ← scene 固定 1
 *   B 显式形式：{ title, desc, picUrl, jumpUrl, iconUrl, appId, scene, templateType,
 *                 businessType, verType, shareType, versionId, sdkId, withShareTicket, webUrl? }
 * 想改 scene 只能走 B。B 的其余字段照抄 A 的模板值，保证"只改一个变量"。
 *
 * 用法（cwd=/root/qq-bridge）：node tools/probe-miniapp-scene.mjs [webUrl]
 */
import { readFileSync } from 'node:fs';

const WEBURL = process.argv[2] || 'https://b23.tv/BV13Xb56NEEZ';
const cfg = JSON.parse(readFileSync('/root/qq-bridge/config.json', 'utf8'));
const HTTP = String(cfg.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const TOKEN = String(cfg.napcat?.accessToken || '');

/** 模板形式（A）走 bili 模板；把模板里的值原样抄出来给显式形式（B）用 */
const TEMPLATE = {
  sdkId: 'V1_PC_MINISDK_99.99.99_1_APP_A',
  appId: '1109937557',
  iconUrl: 'https://miniapp.gtimg.cn/public/appicon/51f90239b78a2e4994c11215f4c4ba15_200.jpg',
  templateType: '1',
  businessType: '0',
  verType: '3',
  shareType: '0',
  versionId: 'cfc5f7b05b44b5956502edaecf9d2240',
  withShareTicket: '0',
};

const call = async (body) => {
  const r = await fetch(`${HTTP}/get_mini_app_ark`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ ...body, rawArkData: 'true' }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => null);
  const ark = j?.data?.data ?? j?.data ?? null;
  return { status: r.status, j, ark };
};

const show = (label, out) => {
  const d1 = out.ark?.metaData?.detail_1;
  console.log(`\n── ${label}`);
  console.log(`   HTTP ${out.status}  message=${JSON.stringify(out.j?.message ?? out.j?.wording ?? '')}`);
  if (!d1) { console.log(`   ❌ 没拿到 Ark：${JSON.stringify(out.j).slice(0, 300)}`); return; }
  console.log(`   detail_1.scene = ${JSON.stringify(d1.scene)}   （真卡是 1036）`);
  console.log(`   detail_1.url   = ${JSON.stringify(d1.url)}`);
  console.log(`   detail_1.qqdocurl = ${JSON.stringify(d1.qqdocurl)}`);
  console.log(`   detail_1.icon  = ${JSON.stringify(d1.icon)}`);
  console.log(`   config.token   = ${out.ark?.config?.token ? '非空' : '【空】'}`);
};

const base = {
  title: '五十个角色、五十种声音、同一个我',
  desc: '困雀雀 · 39.2万播放 · 3:24',
  picUrl: 'https://i1.hdslb.com/bfs/archive/d806bc14c8c044b81799200896aa1cb7be45a8e2.jpg',
  jumpUrl: WEBURL,
  webUrl: WEBURL,
};

show('A 模板形式 type=bili（模板内 scene=1）', await call({ type: 'bili', ...base }));
show('B 显式形式 scene=1（照抄模板）', await call({ ...base, ...TEMPLATE, scene: '1' }));
show('B 显式形式 scene=1036（照抄真卡）', await call({ ...base, ...TEMPLATE, scene: '1036' }));
show('B 显式形式 scene=0', await call({ ...base, ...TEMPLATE, scene: '0' }));
