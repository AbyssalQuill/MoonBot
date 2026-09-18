/* 实测：发 **3 张 B 站小程序卡** 到私聊，每张只改一个"点击目标形态"，让用户点完回报。
 *
 * ── 为什么只能真发 ──────────────────────────────────────────────────────────────
 * 「QQ 会不会把 `.html` 贴到点击目标上」是 QQ 客户端/服务端的行为，
 * 服务端能证明的只有"我们发出去的 `qqdocurl` 是干净的"（回读消息记录已逐张核对），
 * 补后缀那一步**只有真机点击**才看得到。
 *
 * ── 三张卡各自要回答什么 ────────────────────────────────────────────────────────
 *   A  `https://m.bilibili.com/video/av<aid>.html`
 *        B 站移动端的历史形态，本身就以 `.html` 结尾。`tools/probe-bili-html-forms.mjs`
 *        在家宽上实测：原样 / 再补一个 `.html` / 补 `.html` 再挂查询串 / 补两个 `.html`，
 *        **四种变体全部 200 且 `<title>` 就是那条视频**（三个不同 aid 各测一遍）。
 *        所以它是"QQ 爱怎么补都无所谓"的形态 —— 这张就是候选修法。
 *   B  `https://www.bilibili.com/video/<BV>`（纯长链）
 *        真人的卡里出现过这个形态（回读到的那张 `scene=0` + 纯长链 qqdocurl）。
 *        实测"原样"能进视频页、**补一个 `.html` 就是 404**。用它来判定：
 *        QQ 到底是"无条件补"还是"只对某些形态补"。
 *   C  `https://b23.tv/<当场签发的短码>?share_medium=android&share_source=qq&ts=<毫秒>`
 *        就是生产当前在用的形态（上一轮"补查询串"那版）。这张专门让用户**在电脑上看地址栏**，
 *        用来回答"`.html` 是贴在 pathname 上还是整串末尾"—— 两种情况下地址栏长得不一样。
 *
 * 三张卡的 `jumpUrl` 与 `webUrl` 取**同一个 URL**：客户端看到的卡片里只有 `qqdocurl`、
 * 没有 `jumpUrl`（回读的卡片全文可证），这样写是为了"万一它读的是 jumpUrl"也不引入第二个变量。
 *
 * 用法（cwd = /root/qq-bridge）：node tools/send-bili-html-experiment.mjs
 */
import { readFileSync } from 'node:fs';

const KEY = process.env.EXP_KEY || 'private:1736784911';
const [, uid] = KEY.split(':');
const cfg = JSON.parse(readFileSync('/root/qq-bridge/config.json', 'utf8'));
const HTTP = String(cfg.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const TOKEN = String(cfg.napcat?.accessToken || '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const napcatPost = async (ep, body) => {
  const r = await fetch(`${HTTP}/${ep}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return r.json();
};

/** 取视频信息（标题/封面/aid）：这台机器上 `wbi/view` 是通的（老 view 接口才 412） */
async function info(bv) {
  try {
    const j = await (await fetch(`https://api.bilibili.com/x/web-interface/wbi/view?bvid=${bv}`, {
      headers: { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bv}` }, signal: AbortSignal.timeout(12000),
    })).json();
    const d = j?.data ?? {};
    return { aid: Number(d.aid) || 0, title: String(d.title ?? ''), cover: String(d.pic ?? '').replace(/^http:\/\//i, 'https://') };
  } catch (e) { console.log(`  取 ${bv} 信息失败：${e?.message ?? e}`); return { aid: 0, title: '', cover: '' }; }
}

/** 跟一跳，看它到底落到哪（判据：Location 里必须出现目标 BV 或 av 号） */
async function firstHop(url) {
  try {
    const r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000) });
    return `${r.status} → ${r.headers.get('location') || '(无 Location)'}`;
  } catch (e) { return `请求失败 ${e?.message ?? e}`; }
}

/* ── 组三张卡 ─────────────────────────────────────────────────────────────── */
const { fetchBiliShareCode } = await import('/root/qq-bridge/src/core/video.js');

const A = { ...await info('BV13Xb56NEEZ') };
const B = { ...await info('BV1GJ411x7h7') };
const C = { ...await info('BV1d4411N7zD') };

const codeC = await fetchBiliShareCode('BV1d4411N7zD', C.aid);
console.log(`C 卡当场签发的短码：${codeC || '(没拿到，退回 b23.tv/av<aid>)'}`);

const cards = [
  {
    tag: 'A',
    label: '测试卡 A',
    note: '移动端 av + .html（自带 .html，实测补到两个 .html 都照样进视频页）',
    title: A.title,
    cover: A.cover,
    url: `https://m.bilibili.com/video/av${A.aid}.html`,
    wantBv: 'BV13Xb56NEEZ',
  },
  {
    tag: 'B',
    label: '测试卡 B',
    note: '纯桌面长链（真卡里出现过的形态）',
    title: B.title,
    cover: B.cover,
    url: `https://www.bilibili.com/video/BV1GJ411x7h7`,
    wantBv: 'BV1GJ411x7h7',
  },
  {
    tag: 'C',
    label: '测试卡 C',
    note: 'b23.tv 短码 + 非设备查询串（生产现状）',
    title: C.title,
    cover: C.cover,
    url: `https://b23.tv/${codeC || 'av' + C.aid}?share_medium=android&share_source=qq&ts=${Date.now()}`,
    wantBv: 'BV1d4411N7zD',
  },
];

console.log('\n========== 1) 发卡前的 HTTP 核对（每张卡的 URL 与"被补 .html 之后"的样子）==========');
for (const c of cards) {
  console.log(`\n【${c.tag}】${c.note}`);
  console.log(`   qqdocurl(将发)     ${c.url}`);
  console.log(`      一跳：${await firstHop(c.url)}`);
  const withHtml = `${c.url}.html`;
  console.log(`   万一被补成 .html   ${withHtml}`);
  console.log(`      一跳：${await firstHop(withHtml)}`);
}

console.log('\n========== 2) 逐张要 Ark 并检查 qqdocurl 回显 ==========');
const arks = [];
for (const c of cards) {
  const body = {
    type: 'bili',
    title: c.title.slice(0, 100),
    desc: c.title.slice(0, 100),
    picUrl: c.cover || '',
    jumpUrl: c.url,
    webUrl: c.url,
    rawArkData: 'true',
  };
  const j = await napcatPost('get_mini_app_ark', body);
  const raw = j?.data?.data ?? j?.data ?? null;
  const send = raw?.appName ? {
    ver: raw.ver, prompt: raw.prompt, config: raw.config, app: raw.appName, view: raw.appView,
    meta: raw.metaData, miniappShareOrigin: 3, miniappOpenRefer: '10002',
  } : null;
  const doc = send?.meta?.detail_1?.qqdocurl;
  console.log(`【${c.tag}】app=${send?.app ?? '(无)'}  qqdocurl=${doc ?? '(无)'}`);
  console.log(`   ${doc === c.url ? '✅ 服务端原样回显，没有加料' : '⚠️ 回显与请求不一致：请求=' + c.url}`);
  if (send) arks.push({ ...c, send });
}

console.log('\n========== 3) 真发（每张先发一行文字标签，再发卡片）==========');
const before = await napcatPost('get_friend_msg_history', { user_id: String(uid), count: 3 });
const seqBefore = Math.max(-1, ...(before?.data?.messages ?? []).map((m) => Number(m?.real_seq ?? -1)));
console.log(`发送前 real_seq 水位 = ${seqBefore}`);

for (const a of arks) {
  const text = `${a.label}｜${a.note}\n点开应该看到：${a.title}`;
  const r1 = await napcatPost('send_private_msg', { user_id: Number(uid), message: [{ type: 'text', data: { text } }] });
  await new Promise((r) => setTimeout(r, 1200));
  const r2 = await napcatPost('send_private_msg', { user_id: Number(uid), message: [{ type: 'json', data: { data: JSON.stringify(a.send) } }] });
  console.log(`${a.label}：文字=${r1?.status}(${r1?.data?.message_id ?? '-'})  卡片=${r2?.status}(${r2?.data?.message_id ?? '-'})  ${r2?.message ?? ''}`);
  await new Promise((r) => setTimeout(r, 1500));
}

console.log('\n========== 4) 回读消息记录，核对真正发出去的 qqdocurl ==========');
await new Promise((r) => setTimeout(r, 3000));
const after = await napcatPost('get_friend_msg_history', { user_id: String(uid), count: 12 });
const msgs = (after?.data?.messages ?? []).slice().sort((x, y) => Number(x.time) - Number(y.time));
const fmt = (t) => new Date(Number(t) * 1000).toISOString().replace('T', ' ').slice(0, 19);
for (const m of msgs) {
  const seq = Number(m?.real_seq ?? -1);
  if (seq < seqBefore) continue;
  let line = `${fmt(m?.time)}(UTC) msgId=${m?.message_id} real_seq=${seq} 前进=${seq > seqBefore ? '是' : '否'}  `;
  for (const s of (Array.isArray(m?.message) ? m.message : [])) {
    if (s?.type !== 'json') continue;
    let p = s?.data?.data ?? s?.data;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch { /* ignore */ } }
    line += `app=${p?.app} scene=${p?.meta?.detail_1?.scene} qqdocurl=${p?.meta?.detail_1?.qqdocurl}`;
  }
  console.log(line);
}
