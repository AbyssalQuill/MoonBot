// 只读 HTTP(S) 安全抓取工具：供 qq-bridge / MCP 共用。
// 设计目标与 mcp-web-search-safe 一致：
// - 仅 http/https
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址
// - 域名先 DNS 解析并检查全部解析结果，避免 DNS rebinding
// - 手动跟随重定向，每一跳重新校验
// - 响应体按字符数限量读取，避免超大响应拖垮进程
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';

const dnsLookup = dns.promises.lookup;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  // 兼容 ::ffff:0:7f00:1、::ffff:0:c0a8:101、::c0a8:101 等非规范 IPv4-mapped/compatible 写法。
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  // NAT64 前缀（64:ff9b::/96 与 64:ff9b:1::/48）内嵌 IPv4，例如 64:ff9b::c0a8:101 -> 192.168.1.1
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

export function isPrivateIp(ip) {
  const h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  const embedded = h.includes(':') ? parseEmbeddedIpv4(h) : null;
  if (embedded) return isPrivateIp(embedded);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }

  return false;
}

export async function resolveSafeHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) throw new Error('主机名为空');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await withTimeout(dnsLookup(h, { all: true, verbatim: true }), 5000, `DNS 解析 ${h}`);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses[0].address;
}

export async function validateFetchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname);
  return { url, ip };
}

function sliceByCodePoints(s, max) {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

function readBoundedText(res, maxChars) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let text = '';
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };
    res.on('data', (chunk) => {
      if (settled) return;
      text += decoder.write(chunk);
      if (text.length >= maxChars) {
        text = sliceByCodePoints(text, maxChars);
        try { res.destroy(); } catch {}
        finish(resolve, text);
      }
    });
    res.on('end', () => {
      if (!settled) {
        text += decoder.end();
        finish(resolve, sliceByCodePoints(text, maxChars));
      }
    });
    res.on('error', (err) => finish(reject, err));
  });
}

function requestOnce(url, ip, maxChars = 50000) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      timeout: 20000,
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        res.resume();
        resolve({ statusCode, redirect: String(res.headers.location || '') });
        return;
      }
      readBoundedText(res, maxChars)
        .then((body) => resolve({ statusCode, body }))
        .catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}

export async function safeFetch(urlString, maxChars = 50000) {
  const MAX_REDIRECTS = 5;
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, maxChars);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    const body = result.body || '';
    return {
      url: url.toString(),
      statusCode: result.statusCode,
      truncated: body.length >= maxChars,
      body,
    };
  }
  throw new Error('重定向次数过多，已停止');
}

/** 仅接受 DSH 支持的四种图片格式：PNG/JPEG/GIF/WebP。 */
export function looksLikeImageBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return true;
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 【2026-09-21 新增：图片字节完整性校验 —— 修「半幅纯 #808080 的图被当成合法图片发出去」】
 *
 * 现场（主人报的）：qq_send_pixiv 发到 QQ 的那张 pixiv 图，**下面 60~70% 是纯 #808080 平色、边界干净、
 * 没有 JPEG 块状噪声**。这个形状不是画的内容，是**渐进式 JPEG 被截断**的教科书特征：
 * 解码器对"从没收到的系数"只能填 DC 均值，于是整片区域变成一片平色。
 *
 * 「截断发生在哪」的取证（不是猜）：
 *   · **不是** MAX_IMAGE_FETCH_BYTES 造成的：超限那条路（requestOnceBuffer 里 `size > maxBytes`）是
 *     `settled=true; res.destroy(); reject(...)` —— 是**拒绝**，不是"截一半留下"。上限不会产生半截图。
 *   · **不是**我们的传输层"静默收半截"：本地实测（node v24.13.0，探针：服务端声明 Content-Length=1000
 *     只发 400 字节后 destroy socket；以及 chunked 发 400 字节后 destroy）两种形状**都**触发
 *     `res.on('error') → "aborted"`，也就是走到 reject。真·断链不会静默变成"完整响应"。
 *   · **是**"没有校验就收下"：`res.on('end')`（requestOnceBuffer 末尾）把收到的 chunk 直接 concat 就 resolve，
 *     而唯一的体检是 `looksLikeImageBuffer`（上面这个函数）——**只认开头 3 个字节**。
 *     于是只要**上游自己给的字节就是残的**（第三方代理把"没拉完就被掐断的原图"缓存下来、再带正确的
 *     Content-Length 完整吐给我们；这正是镜像站常见形态，也是我们唯一会拿到 720 档 + 半幅灰的来源），
 *     我们就会**原样写盘、原样发给 NapCat**，文件看着是合法 JPEG、尺寸也对，用户看到半张灰。
 *   · 对照口径：`content-length` 这个头**在改动前一次都没被读过**（全文件 grep 无命中），
 *     JPEG 的 EOI（FFD9）也从没检查过。
 *
 * 修法：把"完整性"变成一道独立闸门，任何调用方（qq_send_pixiv / 联网找图 / 卡片封面 …）取图都过它：
 *   ① 字节尾标记：JPEG 必须以 FFD9 收尾、PNG 必须以 IEND 块收尾、GIF 必须以 0x3B 收尾、
 *      WebP 的 RIFF 长度字段必须与实际字节数一致；
 *   ② 有 content-length 且没被编码压缩时，实际字节数必须与之相等；
 *   ③ 不通过 → 抛「图片字节不完整」→ 调用方**换下一个候选**或如实报错，绝不发半截图。
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/** JPEG 的 EOI（End Of Image）标记：截断的 JPEG 一定缺它。 */
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
/** PNG 的 IEND 块尾部（长度 0 + 类型 'IEND' + 固定 CRC）。 */
const PNG_IEND_TAIL = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/**
 * 校验"这份字节是**完整**的一张图"。**纯函数，离线可测**。
 * @param {Buffer} buf 图片字节
 * @param {number|string|null} [contentLength] 响应的 content-length（没有就传 null）
 * @param {string|null} [contentEncoding] 响应的 content-encoding（有压缩时长度对不上属正常，跳过长度比对）
 * @returns {{ok:boolean, format:string, reason:string, declaredBytes:number, actualBytes:number, endMarker:string, lengthChecked:boolean}}
 */
export function verifyImageComplete(buf, contentLength = null, contentEncoding = null) {
  const actualBytes = Buffer.isBuffer(buf) ? buf.length : 0;
  const declaredNum = Number(contentLength);
  const declaredBytes = Number.isFinite(declaredNum) && declaredNum > 0 ? declaredNum : 0;
  const encoded = Boolean(contentEncoding) && !/^identity$/i.test(String(contentEncoding).trim());
  const base = { format: '', declaredBytes, actualBytes, endMarker: '', lengthChecked: false };
  if (!actualBytes) return { ...base, ok: false, reason: '字节为空' };

  let format = 'unknown';
  let endMarker = '';
  let complete = null;   // null = 这种格式没法判定尾标记（不拦）
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    format = 'jpeg';
    const tail = buf.subarray(Math.max(0, actualBytes - 64));
    const idx = tail.lastIndexOf(JPEG_EOI);
    endMarker = idx >= 0 ? 'ffd9' : 'none';
    complete = idx >= 0;
  } else if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    format = 'png';
    const tail = buf.subarray(Math.max(0, actualBytes - 16));
    complete = tail.includes(PNG_IEND_TAIL);
    endMarker = complete ? 'IEND' : 'none';
  } else if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
    format = 'gif';
    complete = buf.subarray(Math.max(0, actualBytes - 8)).includes(0x3b);
    endMarker = complete ? '3b' : 'none';
  } else if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.toString('ascii', 8, 12) === 'WEBP') {
    format = 'webp';
    // RIFF 头里的长度字段 = 文件应有长度 - 8：这是 WebP 自带的"我该有多长"。
    // 只在"声明的比实际的还多"时才算截断（声明得更少 = 尾部有额外填充，图本身是完整的，别误杀）。
    const riffBytes = buf.readUInt32LE(4) + 8;
    complete = riffBytes <= actualBytes;
    endMarker = `riff=${riffBytes}`;
  }
  const info = { ...base, format, endMarker };
  if (!encoded && declaredBytes && declaredBytes !== actualBytes) {
    return { ...info, ok: false, lengthChecked: true, reason: `字节数与 content-length 不符（声明 ${declaredBytes}B，实际 ${actualBytes}B，差 ${declaredBytes - actualBytes}B）` };
  }
  if (complete === false) {
    return { ...info, lengthChecked: !encoded && declaredBytes > 0, ok: false, reason: `${format} 字节不完整（缺结束标记：${format === 'jpeg' ? 'FFD9' : format === 'png' ? 'IEND' : format === 'gif' ? '0x3B' : 'RIFF 长度'}）` };
  }
  return { ...info, ok: true, lengthChecked: !encoded && declaredBytes > 0, reason: '' };
}

/**
 * 读图（下载图片字节）的默认字节上限 = 15MB。
 *
 * 【2026-09-18 定标：4MB → 15MB，并把散落的 8MB 一并收拢到这里】
 * 改之前全桥有三个互不相干的上限：本函数默认 4MB、qq_image_search/qq_send_image 8MB、
 * qq_send_pixiv 8MB —— 同一张图走不同入口结论不同，也没有任何一处说明依据是什么。
 * 现在统一成这一个常量，改上限只需改一行。
 *
 * 为什么 15MB 是安全的（依据，非估计）：真正卡人的是 DSH 附件层。线上装的是 DSH 0.1.2-rc.1，
 * `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js:637`
 * 写着 `const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024`，同包 README.zh.md 第 41 行也写明
 * `maxImageBytes` 默认 20 MiB；`/root/.dsh/profiles/web/` 下的 profile 没有覆盖这个值
 * （grep maxImageBytes 在 profile 里无命中）。所以 15MB < DSH 的 20MB，下载侧放宽不会把 DSH 撑爆。
 * 反过来说，原来的 4MB/8MB 纯粹是自设的更紧上限，会在图还没到投递闸门之前就把它丢掉。
 *
 * 注意：本常量只管"把图下载下来"，投递前的闸门是 image-compress.js 的 IMAGE_HARD_MAX_BYTES，
 * 两者是两道独立的卡口（都放宽到 15MB 才叫端到端 15MB），但都不允许超过 DSH 的 20MB。
 */
export const MAX_IMAGE_FETCH_BYTES = 15 * 1024 * 1024;

/**
 * 抓取图片字节并返回 Buffer（带 SSRF 防护，且校验确实为图片）。
 *
 * @param {string} urlString
 * @param {number} [maxBytes]
 * @param {Record<string,string>|null} [extraHeaders] 追加的请求头。**默认不带**（老调用行为一字不变）。
 *   存在的唯一理由：有些图床按 Referer 防盗链，不给这个头就一律 403 —— 典型是 i.pximg.net
 *   （Pixiv 原图站）：实测带 `referer: https://www.pixiv.net/` 是 200，不带是 403 nginx。
 *   之前 pixiv 取图只能全走第三方镜像站代理，就是因为这里不能带头；现在补上，
 *   `qq_send_pixiv` 才能直联 pximg 拿**逐字节一致**的原图（见 lib/pixiv.js 顶部）。
 *   `host` 由本函数自己按 URL 设置，调用方传进来也会被丢掉（防止把 host 改成别的域名）。
 */
export async function safeFetchBuffer(urlString, maxBytes = MAX_IMAGE_FETCH_BYTES, extraHeaders = null) {
  const MAX_REDIRECTS = 5;
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnceBuffer(url, ip, maxBytes, extraHeaders);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`图片抓取失败：HTTP ${result.statusCode}`);
    }
    if (!looksLikeImageBuffer(result.buffer)) {
      throw new Error(`抓取内容不是有效图片（PNG/JPEG/GIF/WebP）`);
    }
    /* 【2026-09-21】完整性强校验：只看开头 3 个字节是不够的 —— 被截断的 JPEG 同样是合法开头，
     * 解码出来就是那半幅 #808080（线上现场，见 verifyImageComplete 上方那段取证）。
     * 这里抛错而不是返回，是为了让调用方（qq_send_pixiv）**换下一个候选**或如实报错，绝不发半截图。 */
    const complete = verifyImageComplete(result.buffer, result.contentLength, result.contentEncoding);
    if (!complete.ok) {
      throw new Error(`图片字节不完整（${complete.format || '未知格式'}，实际 ${complete.actualBytes}B${complete.declaredBytes ? `／声明 ${complete.declaredBytes}B` : ''}）：${complete.reason}`);
    }
    /* 【2026-09-22 修 M4】以前这里漏了 contentEncoding，而 qzone-image.js 明确要它：
     * 缺了就会把「带 gzip/br 的图片响应」按压缩前的字节长度去比解压后的字节数 → 好图被判不完整、
     * 说说降级成纯文字还写个误导原因。第一道闸门 (verifyImageComplete) 用的是正确值，两道结论会相反。 */
    return { url: url.toString(), statusCode: result.statusCode, buffer: result.buffer, contentLength: result.contentLength ?? null, contentEncoding: result.contentEncoding ?? null, complete };
  }
  throw new Error('重定向次数过多，已停止');
}

function requestOnceBuffer(url, ip, maxBytes, extraHeaders = null) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    // 调用方追加的头（现在只有取图时的 referer）：host 一律以 URL 为准，不允许被覆盖。
    const extra = extraHeaders && typeof extraHeaders === 'object'
      ? Object.fromEntries(Object.entries(extraHeaders).filter(([k, v]) => k && !/^host$/i.test(k) && v != null))
      : {};
    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0',
        accept: 'image/*,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
        ...extra,
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      timeout: 20000,
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        res.resume();
        resolve({ statusCode, redirect: String(res.headers.location || '') });
        return;
      }
      // content-length / content-encoding 一并带出去：完整性校验要拿它们对账（见 verifyImageComplete）
      const contentLength = res.headers['content-length'] ?? null;
      const contentEncoding = res.headers['content-encoding'] ?? null;
      const chunks = [];
      let size = 0;
      let settled = false;
      res.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) {
          settled = true;
          try { res.destroy(); } catch {}
          reject(new Error(`图片超过大小限制（${maxBytes} 字节）`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ statusCode, buffer: Buffer.concat(chunks), contentLength, contentEncoding });
      });
      res.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}
