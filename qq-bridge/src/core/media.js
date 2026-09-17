// 富媒体/卡片发送 + 音乐搜索
// 无跨域状态；cfg 由工厂参数静态注入。
import { sleep } from '../lib/async.js';
import { randInt } from '../lib/rand.js';
import { log } from '../lib/log.js';
import { enqueueSend } from './send-chain.js';
import { isDeliveredUnconfirmed, deliveredUnconfirmedResult, onebotErrText } from '../lib/onebot-delivery.js';
import { napcatImageFileArg } from '../lib/napcat-file.js';
import fs from 'node:fs';
import path from 'node:path';

// 网易云接口统一请求头（这几个接口对 Referer 敏感，缺了会返回空 result）
const NETEASE_HEADERS = { Referer: 'https://music.163.com', 'User-Agent': 'Mozilla/5.0' };

/**
 * 封面 URL 归一化 —— 手机端"网易云卡片白框"的根因处理（2026-09-16 实测，非推测）。
 *
 * 实测（node 真实请求）：
 *   · 网易云封面同时有 http / https 两种形态（老接口给 http://p2.music.126.net/...）；
 *     手机 QQ 取卡片封面走的是它自己的图片管线，明文 http 更容易被拦（电脑端宽松）→ 一律升级 https
 *     （p1/p2.music.126.net 实测 https 返回 200 image/jpg）。
 *   · 同一首歌的**原图**可以非常大：现场那张 id=3381504830 的卡片封面实测 4,410,875 B ≈ 4.4MB，
 *     手机端大概率加载超时白框；补网易云自家的 `?param=300y300` 后实测 210,031 B（缩 20 倍），
 *     而 QQ 音乐自己分享歌曲用的也正是 300×300 缩略图（y.gtimg.cn/.../T002R300x300M000...jpg）。
 */
export function normalizeCoverUrl(raw, size = 300) {
  let u = String(raw ?? '').trim();
  if (!u) return '';
  if (/^http:\/\//i.test(u)) u = u.replace(/^http:\/\//i, 'https://');
  // 只给网易云图补缩略参数（别人家的 CDN 参数语义不同，不猜）
  if (/music\.126\.net\//i.test(u) && !/[?&]param=/i.test(u)) {
    u += `${u.includes('?') ? '&' : '?'}param=${size}y${size}`;
  }
  return u;
}

/** 媒体 URL 归一化：手机端同样不吃明文 http（网易云 m*.music.126.net 实测支持 https） */
export function normalizeMediaUrl(raw) {
  const u = String(raw ?? '').trim();
  if (!u) return '';
  return /^http:\/\//i.test(u) ? u.replace(/^http:\/\//i, 'https://') : u;
}

/**
 * 音乐分享的发送梯子：**卡片 → NapCat 原生卡片 → 纯链接**。
 * 需求：卡片发不出去时分享动作不能整体失败，必须还能落到一条能点开的官方链接。
 *
 * 做成独立导出（发送器由调用方注入）是为了能离线单测这把梯子 —— 见 tools/test-music-card.mjs。
 * 返回 { ok, card: 'primary'|'native'|'link', seg, messageId, degradedFrom? }。
 */
export async function sendMusicCardWithFallback({ key, plan = null, seg = null, options = {}, sendRichFn, sendText }) {
  const sendLink = async () => {
    const sent = await sendText(plan.link);
    return {
      ok: true,
      card: 'link',
      seg: { type: '_shareText', data: { title: plan?.title ?? '', url: plan.link } },
      messageId: sent?.messageId ?? null
    };
  };
  if (seg) {
    try {
      const sent = await sendRichFn(key, seg, options);
      return { ok: true, card: 'primary', seg, messageId: sent?.messageId ?? null };
    } catch (primaryError) {
      // ① 退回 NapCat 原生 id 卡片（老行为）
      if (plan?.native) {
        try {
          const sent = await sendRichFn(key, plan.native, options);
          return { ok: true, card: 'native', seg: plan.native, messageId: sent?.messageId ?? null, degradedFrom: primaryError };
        } catch { /* 继续降级 */ }
      }
      // ② 退回纯链接
      if (plan?.link && typeof sendText === 'function') {
        const out = await sendLink();
        return { ...out, degradedFrom: primaryError };
      }
      throw primaryError;
    }
  }
  // 压根没有卡片段（例如 custom 卡片字段不全）：直接发链接
  if (plan?.link && typeof sendText === 'function') return sendLink();
  throw new Error('没有可发送的卡片段或兜底链接');
}

export function createMediaDomain(cfg) {

  // 发送富文本/卡片消息段（music/contact/location/json/xml/dice/rps），与文本/表情共用发送链。
  async function sendRich(key, seg, options = {}) {
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
      segments.push({ type: 'text', data: { text: ' ' } });
    }
    segments.push(seg);
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    let sendResolve;
    let sendReject;
    let settled = false;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = (v) => { settled = true; resolve(v); };
      sendReject = (e) => { settled = true; reject(e); };
    });
    const sendRun = enqueueSend(async () => {
      try {
        await sleep(randInt(500, 1500));
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.napcat?.accessToken ? { authorization: `Bearer ${cfg.napcat.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          // 已送达未确认（EventChecker Failed）：卡片其实已经发出去了，别报失败（见 lib/onebot-delivery.js）
          const errText = onebotErrText(body);
          if (isDeliveredUnconfirmed(errText)) {
            log(`[rich] ${action} 回执 EventChecker Failed —— 卡片已发出（只是事件确认失败），按已送达处理`);
            sendResolve(deliveredUnconfirmedResult());
            return;
          }
          const hint = res.status === 426 ? '（HTTP 426：napcat.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 napcat.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    }, key);
    // 会话重置/隔离（cancelKeyedSends）时 send-chain 会跳过已入链但未开始的任务——回调根本不会执行，
    // 上面的 sendResult 就永不 settle，调用方（qq_send_rich 等工具）会永久挂起。
    // 链上任务结算后仍未 settle，说明本任务被跳过，这里补一个明确失败。
    void sendRun.then(
      () => { if (!settled) sendReject(new Error('发送任务已被会话重置取消（未发出）')); },
      (e) => { if (!settled) sendReject(e); }
    );
    const data = await sendResult;
    return { messageId: data?.message_id ?? null };
  }

  /* ── 封面为什么要先搬到 QQ 图床 ───────────────────────────────────────────────
   * 【2026-09-19 修「手机端音乐卡片封面空白、电脑端正常」】
   * 实测对照（线上同一台机器，两条卡都发到主人私聊）：
   *
   *   对照A：直接把网易云的外部封面 URL 交给卡片
   *     → 卡里 preview = https://p2.music.126.net/…jpg?param=300y300   （外部域名）
   *     → 手机端空白、电脑端正常
   *   对照B：先把同一张图**发一遍**换成 QQ 图床 URL，再把那个 URL 交给卡片
   *     → 卡里 preview = https://qq.ugcimg.cn/v1/kgij0dgo…             （QQ 自己的 CDN）
   *     → 与主人从高德/腾讯地图分享进来的**真卡**同一个域名（真卡 preview 也是 qq.ugcimg.cn / qpic.cn）
   *
   * 也就是说：**卡片里的图必须是 QQ 自己的图床地址，手机端才肯加载**；外部 URL 电脑端能读、手机端不读。
   * NapCat 那个音乐签名服务（`musicSignUrl` 默认 http://106.55.0.102:10087/）对 QQ 域名的图会转存成
   * `qq.ugcimg.cn/v1/…`，对外部 URL 则原样透传 —— 所以桥这边得先把图送进 QQ。
   *
   * 怎么"安静地"把图送进 QQ：**发给机器人自己的 QQ**（user_id = 自己的 uin，就是"我的设备"那个会话）——
   * 实测 200 且能回读到 `https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=…` 的图床地址，
   * **不会在任何人（包括主人）的聊天里留下气泡**。拿到的地址缓存起来，同一张封面只搬一次。
   */
  const qqHostedCache = new Map();
  let botUin = 0;
  const NAPCAT_HTTP = () => String(cfg.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const NAPCAT_HDR = () => ({ 'content-type': 'application/json', ...(cfg.napcat?.accessToken ? { authorization: `Bearer ${cfg.napcat.accessToken}` } : {}) });

  function isQqHosted(u) {
    try { return /(^|\.)(qpic\.cn|qq\.com|ugcimg\.cn)$/i.test(new URL(u).hostname); } catch { return false; }
  }

  /** 外部图 → QQ 图床 URL（失败就原样返回，绝不让卡片因此发不出去）。 */
  async function ensureQqHostedImage(url) {
    const src = String(url ?? '').trim();
    if (!src || isQqHosted(src)) return src;
    if (qqHostedCache.has(src)) return qqHostedCache.get(src);
    try {
      const res = await fetch(src, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) return src;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > 4 * 1024 * 1024) return src;
      const tmpDir = String(cfg.napcat?.tmpDir || '').trim() || path.join(process.cwd(), 'state', 'image-tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmp = path.join(tmpDir, `cover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);
      fs.writeFileSync(tmp, buf);
      if (!botUin) {
        const li = await fetch(`${NAPCAT_HTTP()}/get_login_info`, { method: 'POST', headers: NAPCAT_HDR(), body: '{}', signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => null);
        botUin = Number(li?.data?.user_id) || 0;
      }
      if (!botUin) return src;
      const sent = await fetch(`${NAPCAT_HTTP()}/send_private_msg`, {
        method: 'POST', headers: NAPCAT_HDR(),
        body: JSON.stringify({ user_id: botUin, message: [{ type: 'image', data: { file: napcatImageFileArg(tmp, cfg) } }] }),
        signal: AbortSignal.timeout(20000)
      }).then((r) => r.json()).catch(() => null);
      const mid = sent?.data?.message_id;
      if (mid == null) { log(`[cover] 封面搬到 QQ 图床失败（send_private_msg 到自身没给 message_id），仍用外部 URL：${sent?.wording || sent?.message || ''}`); return src; }
      const got = await fetch(`${NAPCAT_HTTP()}/get_msg`, { method: 'POST', headers: NAPCAT_HDR(), body: JSON.stringify({ message_id: mid }), signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => null);
      const seg = (got?.data?.message || []).find((s) => s?.type === 'image');
      const hosted = String(seg?.data?.url ?? '').trim();
      try { fs.unlinkSync(tmp); } catch {}
      if (!hosted) { log('[cover] 封面搬到 QQ 图床失败（get_msg 里没有 image.url），仍用外部 URL'); return src; }
      qqHostedCache.set(src, hosted);
      log(`[cover] 封面已搬到 QQ 图床（手机端才会显示）：${hosted.slice(0, 70)}…`);
      return hosted;
    } catch (error) {
      log(`[cover] 封面搬 QQ 图床异常（改用外部 URL）：${error?.message ?? error}`);
      return src;
    }
  }

  /**
   * 网易云单曲详情（封面/歌名/歌手/专辑/时长），一次最多 10 个 id。
   *
   * 为什么必须单独查一次：老接口 /api/search/get **已经不返回 album.picUrl**（2026-09-16 实测只有 picId），
   * 旧代码于是回落到 album.artist.img1v1Url —— 那是**歌手默认头像**（每首歌返回同一张图），根本不是专辑封面。
   * 这里走 /api/song/detail（实测 https picUrl），顺带把封面归一化成 https + 300×300 缩略图。
   */
  async function neteaseSongDetails(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).map((v) => String(v ?? '').trim()).filter(Boolean).slice(0, 10);
    const out = new Map();
    if (!list.length) return out;
    const url = `https://music.163.com/api/song/detail?ids=[${list.join(',')}]`;
    const res = await fetch(url, { headers: NETEASE_HEADERS, signal: AbortSignal.timeout(8000) });
    const body = await res.json().catch(() => null);
    for (const s of (body?.songs || [])) {
      const id = String(s?.id ?? '');
      if (!id) continue;
      out.set(id, {
        title: String(s?.name || ''),
        artist: Array.isArray(s?.artists) ? s.artists.map((a) => a?.name || '').filter(Boolean).join('/') : '',
        album: String(s?.album?.name || ''),
        cover: normalizeCoverUrl(s?.album?.picUrl || ''),
        duration: Number(s?.duration) || 0
      });
    }
    return out;
  }

  /**
   * 音频直链：走网易云官方"外链播放"端点，跟随 302 拿 CDN 直链，再统一升 https。
   * 直链里带时间戳会过期（和 NapCat 原生卡片的 musicUrl 一样），https 化只是让它不再被手机端按明文拦；
   * 拿不到 Location 就退回外链端点本身（https，客户端自己跟 302）。
   */
  async function neteaseAudioUrl(id) {
    const outer = `https://music.163.com/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`;
    try {
      const res = await fetch(outer, { redirect: 'manual', headers: NETEASE_HEADERS, signal: AbortSignal.timeout(8000) });
      const loc = res.headers.get('location');
      try { await res.body?.cancel(); } catch {}
      if (loc) return normalizeMediaUrl(loc);
    } catch (error) {
      log(`[music-resolve] 音频直链解析失败，退回官方外链端点: ${error?.message ?? error}`);
    }
    return outer;
  }

  /** 单曲解析：卡片字段全部由桥侧拿到，模型只给 platform + id */
  async function musicResolve(platform, id) {
    const pid = String(id ?? '').trim();
    if (!pid) throw new Error('缺少歌曲 id（网易云=数字 song id，QQ 音乐=songmid）');
    if (platform === 'qq' || platform === 'qqmusic') {
      // QQ 音乐：卡片形态见 buildMusicCard 的 qq 分支（secapi 拿可播放直链）；这里只做兜底返回。
      return {
        platform: 'qqmusic',
        id: pid,
        title: '',
        artist: '',
        album: '',
        cover: '',
        audio: '',
        url: `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(pid)}`
      };
    }
    const detail = (await neteaseSongDetails([pid])).get(pid) || null;
    if (!detail) throw new Error(`网易云解析不到这首歌（id=${pid}）`);
    return {
      platform: 'netease',
      id: pid,
      title: detail.title,
      artist: detail.artist,
      album: detail.album,
      cover: detail.cover,
      audio: await neteaseAudioUrl(pid),
      url: `https://music.163.com/#/song?id=${pid}`
    };
  }

  /**
   * QQ 音乐解析：歌名/歌手/封面/**可播放直链**，**不需要任何 key**。
   *
   * 为什么不用 QQ 官方 vkey：2026-09-18 在线上这台 VPS 实测
   * `u.y.qq.com/cgi-bin/musicu.fcg` 的 `vkey.GetVkeyServer/CgiGetVkey` 直接被拒：
   *   `{"code":104009, ... "msg":"202.61.72.79;invalidq;", "purl":""}`
   * （歌名/封面的 `music.pf_song_detail_svr` 是通的，唯独取 vkey 这条把机房 IP 判成无效请求。）
   *
   * 可用的是 secapi.top 的聚合解析（主人 2026-09-18 实测：**不带 Authorization 也返回 200**）：
   *   GET https://secapi.top/API/QQ音乐/?msg=<歌名 歌手>&list=2&n=2
   *   → {code:200, title, singer, cover, link, music_url}
   * 字段映射：title→title、singer→content(歌手)、cover→image、link→url、music_url→audio。
   *
   * ⚠️ 两个坑：
   *   ① `music_url` 里的 `vkey` 是**带时效**的直链 —— 绝不能进缓存 key，也不能存下来复用；
   *   ② 这个接口是**关键词搜索**，不是按 songmid 查（拿 songmid 当 msg 会返回一首完全无关的歌，
   *      实测 mid=004Fs2FP1EvZYc 返回了 "W O F"）。所以这里必须**按 songmid 或歌名回检**，
   *      对不上就宁可不发卡片（退官方分享链接），绝不把别人的歌当卡片发出去。
   */
  async function qqMusicResolve(mid, opts = {}) {
    const givenTitle = String(opts?.title ?? '').trim();
    const givenArtist = String(opts?.artist ?? '').trim();
    const fallbackUrl = `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(mid)}`;
    const out = {
      platform: 'qqmusic',
      id: mid,
      title: givenTitle,
      artist: givenArtist,
      cover: normalizeCoverUrl(opts?.cover ?? opts?.image),
      audio: '',
      url: fallbackUrl,
      via: ''
    };
    const q = [givenTitle, givenArtist].filter(Boolean).join(' ').trim();
    if (!q) {
      log('[qqmusic] 没有歌名/歌手，无法解析可播放直链（模型应先调 qq_music_search 拿到 title/artist）');
      return out;
    }
    /* 关键词要**先只用歌名**：实测 `msg=晴天 周杰伦` 会被服务端回 404「歌曲信息获取失败」，
     * 而 `msg=晴天` 正常。两条候选依次试。 */
    const queries = [givenTitle, q].filter((v, i, a) => v && a.indexOf(v) === i);
    const headers = { 'user-agent': 'Mozilla/5.0' };
    const secapiKey = String(cfg?.social?.secapiKey ?? process.env.QQBRIDGE_SECAPI_KEY ?? '').trim();
    if (secapiKey) headers.authorization = `Bearer ${secapiKey}`;
    const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s（）()【】\[\]·\-—_·,，.。!！?？]/g, '');
    for (const query of queries) {
      let pick = null;
      // 这个聚合接口**偶发**返回 404「歌曲信息获取失败」（同一句话隔几秒再问就正常），所以重试一次。
      for (let attempt = 0; attempt < 2 && !pick; attempt += 1) {
        try {
          const url = `https://secapi.top/API/QQ%E9%9F%B3%E4%B9%90/?msg=${encodeURIComponent(query)}&list=2&n=2`;
          const res = await fetch(url, { headers, signal: AbortSignal.timeout(9000) });
          const body = await res.json().catch(() => null);
          // 接口可能返回单个对象，也可能返回数组 —— 两种形状都吃
          const raw = Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data : (body ? [body] : []));
          const ok = raw.filter((s) => Number(s?.code ?? 200) === 200 && s?.music_url);
          // ① 按 songmid 精确回检（最可靠）② 歌名归一化后相等 ③ 歌名互相包含且歌手对得上
          pick = ok.find((s) => String(s?.link ?? '').includes(mid))
            || ok.find((s) => norm(s?.title) === norm(givenTitle))
            || ok.find((s) => {
              const t = norm(s?.title); const g = norm(givenTitle);
              if (!t || !g || !(t.includes(g) || g.includes(t))) return false;
              if (!givenArtist) return true;
              const a1 = norm(s?.singer); const a2 = norm(givenArtist);
              return a1.includes(a2) || a2.includes(a1);
            });
          if (!pick) log(`[qqmusic] 查询「${query}」返回 ${raw.length} 条，没有一条对得上 mid=${mid}/${givenTitle}`);
        } catch (error) {
          log(`[qqmusic] secapi 请求失败（query=${query}）：${error?.message ?? error}`);
        }
        if (!pick && attempt === 0) await sleep(1200);
      }
      if (pick) {
        out.title = String(pick.title || givenTitle);
        out.artist = String(pick.singer || givenArtist);
        out.cover = normalizeCoverUrl(pick.cover) || out.cover;
        out.url = String(pick.link || fallbackUrl);
        out.audio = normalizeMediaUrl(pick.music_url);
        out.via = `secapi/${String(pick.quality || '').trim()}`;
        return out;
      }
    }
    log(`[qqmusic] 试了 ${queries.length} 个关键词都解析不到可播放直链（id=${mid}），退回官方分享链接`);
    return out;
  }

  /**
   * 音乐卡片：**桥内拼好**，模型只给 musicType + musicId（不许模型手写卡片 JSON / 封面 URL）。
   *
   * 现场故障与实测结论（2026-09-16，D:\MoonBot 线上日志 + 真机请求）：
   *   · 线上模型三次都只传 {type:music, musicType:163, musicId:<id>}，桥发的是 NapCat 原生 music 段
   *     {type:'163', id}；NapCat 把这段 POST 给 musicSignUrl（线上为默认的 ss.xingzhige.com）换取整张卡片。
   *   · 带 id 时**签名服务自己解析封面**，给的是**未缩尺寸的原图**（实测其中一张 4.4MB，content-type
   *     image/jpg; charset=UTF-8），且 musicUrl 是明文 http + 带时间戳的会过期直链 —— 手机端白框、电脑端正常。
   *   · 不带 id、字段自己给时，签名服务**原样采用**我们给的 image（实测回传一字不差），返回的卡片
   *     tag 仍是"网易云音乐"、appid 仍是 100495085、view 仍是 music —— 与真人从网易云分享到 QQ 同款，
   *     只有封面/音频换成了我们归一化过的 https + 300×300。
   * 所以默认走"桥拼卡片"，并保留三段降级梯子（任何一段失败都不让"分享"整体失败）：
   *   primary（桥拼卡片）→ native（NapCat 原生 id 卡片，老行为）→ link（官方分享链接纯文本）
   */
  async function buildMusicCard(platform, id, opts = {}) {
    const mt = String(platform ?? '').trim() || '163';
    const pid = String(id ?? '').trim();
    const givenTitle = String(opts?.title ?? '').trim();
    const givenArtist = String(opts?.artist ?? '').trim();
    if (!pid) throw new Error('音乐卡片需要 musicId（qq_music_search 返回的 id）');

    if (mt === '163' || mt === 'netease') {
      let song = null;
      try {
        song = await musicResolve('netease', pid);
      } catch (error) {
        log(`[music-card] 网易云解析失败，退回 NapCat 原生卡片(id=${pid}): ${error?.message ?? error}`);
      }
      const title = song?.title || givenTitle || '网易云音乐';
      const artist = song?.artist || givenArtist || '';
      const link = `${title}${artist ? ' ' + artist : ''} https://music.163.com/#/song?id=${pid}`;
      const native = { type: 'music', data: { type: '163', id: pid } };
      if (!song?.cover || !song?.audio) {
        return { title, primary: native, native: null, link, note: '解析不到封面/音频，退回 NapCat 原生 163 卡片' };
      }
      const data = { type: '163', url: song.url, audio: song.audio, title, image: await ensureQqHostedImage(song.cover) };
      if (artist) data.singer = artist;
      return {
        title,
        primary: { type: 'music', data },
        native,
        link,
        note: '桥拼 163 卡片（https 封面 + 300×300 缩略图，避免手机端白框）'
      };
    }

    /* 【2026-09-18】QQ 音乐：以前只会发"官方分享链接纯文本"（因为 ss.xingzhige 关闭了 qq id 解析、
     * 自造 Ark 又被 QQ 判"版本过低"）。现在 secapi.top 能直接给到**可播放直链**，所以改成真卡片：
     *   primary = 桥拼 music 卡（type=custom，url/audio/image/title/singer 全由桥解析填好）
     *   native  = 无（`type:'qq'` + id 那条路签名服务已知关闭，不值得占一格降级梯子）
     *   link    = 官方分享链接文本（与真人"分享歌曲到QQ"一致，客户端自己渲染）
     * 解析不到直链/封面时**只**发 link —— 宁可少一张卡，也不发一张点不开或配错歌的卡。
     * 想改回带平台身份的 `type:'qq'` 卡片：设 QQBRIDGE_QQMUSIC_CARD=qq。 */
    if (mt === 'qq' || mt === 'qqmusic') {
      let song = null;
      try {
        song = await qqMusicResolve(pid, { title: givenTitle, artist: givenArtist, cover: opts?.image });
      } catch (error) {
        log(`[music-card] QQ 音乐解析失败，退回官方分享链接(id=${pid}): ${error?.message ?? error}`);
      }
      const title = song?.title || givenTitle || 'QQ音乐';
      const artist = song?.artist || givenArtist || '';
      const url = song?.url || `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(pid)}`;
      const link = `${title}${artist ? ' ' + artist : ''} ${url}`;
      if (!song?.audio || !song?.cover) {
        return {
          title,
          primary: null,
          native: null,
          link,
          note: '解析不到可播放直链/封面，发官方分享链接（QQ 客户端自己渲染卡片）'
        };
      }
      const cardType = String(process.env.QQBRIDGE_QQMUSIC_CARD ?? '').trim() === 'qq' ? 'qq' : 'custom';
      const data = { type: cardType, url, audio: song.audio, title, image: await ensureQqHostedImage(song.cover) };
      if (artist) data.singer = artist;
      if (cardType === 'custom') data.content = artist || 'QQ音乐';
      return {
        title,
        primary: { type: 'music', data },
        native: null,
        link,
        note: `QQ 音乐卡片（桥拼 type=${cardType}，直链 ${song.via || 'secapi'}；vkey 带时效，不缓存）`
      };
    }

    // 其它平台（kugou/kuwo/migu/custom）：没有可用的解析接口，沿用调用方给的字段，
    // 但仍然做 https 归一化（封面再补缩略参数），并**永远**留一条链接兜底。
    const url = String(opts?.musicUrl ?? '').trim();
    const image = normalizeCoverUrl(opts?.image);
    const audio = normalizeMediaUrl(opts?.audio);
    const title = givenTitle;
    if (!url) throw new Error(`${mt} 音乐卡片需要 musicUrl（可点开的歌曲链接）`);
    if (!image) throw new Error(`${mt} 音乐卡片需要封面 URL（image）`);
    const data = { type: mt, url, image };
    if (audio) data.audio = audio;
    if (title) data.title = title;
    if (givenArtist) data.content = givenArtist;
    return {
      title,
      primary: { type: 'music', data },
      native: null,
      link: url,
      note: `${mt} 自定义卡片（封面已归一化 https + 缩略尺寸）`
    };
  }

  // 音乐搜索（网易云/QQ音乐网页版，海外可访问）：返回可直接分享的歌曲链接，供"封面图+链接"分享用。
  async function musicSearch(query, platform = 'all', limit = 5) {
    const q = String(query ?? '').trim();
    if (!q) throw new Error('搜索关键词不能为空');
    const max = Math.min(10, Math.max(1, Number(limit) || 5));
    const results = [];
    const platforms = platform === 'netease' ? ['netease'] : platform === 'qqmusic' ? ['qqmusic'] : ['netease', 'qqmusic'];
    if (platforms.includes('netease')) {
      try {
        const url = `https://music.163.com/api/search/get?s=${encodeURIComponent(q)}&type=1&offset=0&limit=${max}`;
        const res = await fetch(url, { headers: NETEASE_HEADERS, signal: AbortSignal.timeout(8000) });
        const body = await res.json().catch(() => null);
        const songs = (body?.result?.songs || []).slice(0, max);
        // 封面单独查一次（老接口不返回 album.picUrl；且绝不回落"歌手默认头像"，那是错图不是封面）
        let details = new Map();
        try {
          details = await neteaseSongDetails(songs.map((s) => s?.id).filter(Boolean));
        } catch (error) {
          log(`[music-search] 网易云封面解析失败（仍返回搜索结果，cover 会为空）: ${error?.message ?? error}`);
        }
        for (const s of songs) {
          const d = details.get(String(s?.id ?? '')) || null;
          results.push({
            platform: 'netease',
            title: d?.title || String(s?.name || ''),
            artist: d?.artist || (Array.isArray(s?.artists) ? s.artists.map((a) => a?.name || '').filter(Boolean).join('/') : ''),
            album: d?.album || String(s?.album?.name || ''),
            id: String(s?.id || ''),
            url: s?.id ? `https://music.163.com/#/song?id=${s.id}` : '',
            cover: d?.cover || '',
            duration: d?.duration || Number(s?.duration) || 0
          });
        }
      } catch (error) {
        log(`[music-search] 网易云搜索失败: ${error?.message ?? error}`);
      }
    }
    if (platforms.includes('qqmusic')) {
      try {
        const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(q)}&format=json&n=${max}&cr=1&t=0`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const body = await res.json().catch(() => null);
        for (const s of (body?.data?.song?.list || []).slice(0, max)) {
          const mid = String(s?.songmid || s?.media_mid || '');
          results.push({
            platform: 'qqmusic',
            title: String(s?.songname || ''),
            artist: Array.isArray(s?.singer) ? s.singer.map((a) => a?.name || '').filter(Boolean).join('/') : '',
            album: String(s?.albumname || ''),
            id: mid,
            url: mid ? `https://y.qq.com/n/ryqq/songDetail/${mid}` : '',
            cover: normalizeCoverUrl(s?.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg` : ''),
            duration: Number(s?.interval) || 0
          });
        }
      } catch (error) {
        log(`[music-search] QQ音乐搜索失败: ${error?.message ?? error}`);
      }
    }
    return { query: q, platform, results };
  }

  return { sendRich, musicSearch, musicResolve, buildMusicCard, qqMusicResolve };
}
