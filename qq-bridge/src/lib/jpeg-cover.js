// 封面一律转成 JPG —— 主人实测（2026-09-19）：**卡片 preview 字段里的封面必须是 JPG 格式，手机端才会显示**。
//
// 为什么需要这个模块：我们各个来源的封面格式并不统一，实测：
//   · 腾讯 `y.qq.com` / `y.gtimg.cn`  → `image/jpeg`（JPG，没问题）
//   · 网易云 `p2.music.126.net`        → **`image/jpg`**（非标准 MIME，严格的客户端可能直接跳过）
//   · 静态地图 `static-maps.yandex.ru` → **`image/png`**（位置卡的 preview 就是它，肯定不是 JPG）
//
// 而要"把 PNG 转成 JPG"，光有转码库不够 —— 卡片的 preview 需要的是**一个 URL**，
// 我们转出来的字节没有地方托管（而且实测把 QQ 图床地址当封面会让整张卡被签名服务拒掉，见 media.js 注释）。
//
// 所以走 **图片代理就地转格式**：`https://wsrv.nl/?url=<原始图>&output=jpg`
// 线上实测（VPS）：
//   · yandex PNG  → `200 image/jpeg` 42724 字节，文件头 `ff d8 ff`（真 JPEG）
//   · 网易云 `image/jpg` → `200 image/jpeg`
//   · `y.qq.com` jpg → `200 image/jpeg`
//   · 同一请求连打 3 次全 200、耗时 15~20ms（走它的缓存），老域名 `images.weserv.nl` 同样可用

const PROXY = 'https://wsrv.nl/';
const FALLBACK_PROXY = 'https://images.weserv.nl/';

/** URL 是否已经是 .jpg/.jpeg 结尾（这类本身就是 JPEG，默认不动它）。 */
export function hasJpegExtension(url) {
  return /\.(jpe?g)(\?|#|$)/i.test(String(url ?? ''));
}

/** 包一层"输出 JPEG"的图片代理。 */
export function wrapForJpeg(url, opts = {}) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  const base = String(opts.proxy || process.env.QQBRIDGE_JPEG_PROXY || PROXY);
  const q = new URLSearchParams({ url: raw, output: 'jpg' });
  if (Number(opts.w) > 0) q.set('w', String(Math.round(Number(opts.w))));
  if (Number(opts.h) > 0) q.set('h', String(Math.round(Number(opts.h))));
  if (opts.fit) q.set('fit', String(opts.fit));
  return `${base}?${q.toString()}`;
}

export function fallbackWrapForJpeg(url, opts = {}) {
  return wrapForJpeg(url, { ...opts, proxy: FALLBACK_PROXY });
}

/**
 * 把封面 URL 归一成"JPG 形态"。
 * @param {string} url 原始封面 URL
 * @param {{force?:boolean, w?:number, h?:number, fit?:string, proxy?:string}} opts
 *   force=true（默认）→ **一律**过代理转成 `image/jpeg`（哪怕它自己已经是 .jpg）
 *   force=false      → 已经是 .jpg 结尾就原样返回，只有非 JPG（PNG / 无扩展名）才走代理
 */
export function toJpegCover(url, opts = {}) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  const force = opts.force !== false;
  if (!force && hasJpegExtension(raw) && !/\.png(\?|#|$)/i.test(raw)) return raw;
  return wrapForJpeg(raw, opts);
}
