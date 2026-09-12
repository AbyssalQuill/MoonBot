// 图片压缩 / 降采样工具（给 AI 看图）
//
// 背景（2026-09-11 修复）：DSH 附件层对**单边像素**有硬限制（rc.1 默认 maxImageDimension = 8192，
// 超限直接以 `attachment-error: Image exceeds the configured per-side pixel limit.` 拒收整条 prompt，
// 桥侧表现为 QQ 里冒出「⚠️ 消息未被接受：attachment-error: ...」）。
// 旧实现只依赖 sharp，而运行时/打包里**根本没装 sharp** → 压缩静默禁用 → 长截图、超宽图、
// 大尺寸表情直接原样送给 DSH → 被拒。
//
// 现在分三级兜底，任何一级可用即可把图缩到安全尺寸：
//   1) sharp（如果装了）：质量最好，支持动图保动画；
//   2) 内置纯 JS 编解码（src/lib/vendor/pngjs + jpeg-js，零依赖、随源码一起同步）：
//      PNG / JPEG 解码 → 盒式平均降采样 → 重编码；覆盖绝大多数超限场景；
//   3) 以上都不可用/格式不支持（GIF/WebP 无 sharp）：由 ensureDeliverableImage 明确判定
//      “不可投递”，调用方退化成文字占位，**绝不再把超限图交给 DSH**（避免整条消息被拒）。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// sharp（可选依赖）：装了就用它，未安装时自动走纯 JS 兜底。
let sharp = null;
try { sharp = require('sharp'); } catch {}

// 内置纯 JS 编解码（vendor，随 src 一起同步到运行时/打包副本）。
let PNGCodec = null;
let jpegCodec = null;
try { PNGCodec = require('./vendor/pngjs/lib/png.js').PNG; } catch {}
try { jpegCodec = require('./vendor/jpeg-js/index.js'); } catch {}

/** 常态目标长边：够了就够看清，顺带省 token。 */
export const IMAGE_MAX_SIDE = 1280;
/** 硬上限：任何情况下送进 DSH 的单边都不得超过它（DSH 默认 8192，这里留 2 倍余量）。 */
export const IMAGE_HARD_MAX_SIDE = 4096;
/** 硬字节上限：与 DSH 附件层实际限制一致。
 *  DSH `@deepseek-ai/dsh-attachment-local` 的 maxImageBytes 默认 5MB（DEFAULT_MAX_IMAGE_BYTES），
 *  且本机 profile 未覆盖该值；此前按 20MB 放行会把 5~20MB 的图交给 DSH，
 *  被 `IMAGE_TOO_LARGE` 拒收 → 整条 prompt（含文字）一起丢，用户看到「⚠️ 消息未被接受」。
 *  超限时由本闸门判"不可投递"，只退化成文字占位，代价远小于整条消息被拒。
 *  注意：若在 DSH 侧调大 maxImageBytes，必须同步调大本常量。 */
export const IMAGE_HARD_MAX_BYTES = 5 * 1024 * 1024;
/** 纯 JS 解码的像素上限（解码后 RGBA = 4 字节/像素，太大就别硬解，直接判不可投递）。 */
export const IMAGE_PUREJS_MAX_PIXELS = 40_000_000;
const IMAGE_JPEG_QUALITY = 82;
const IMAGE_MIN_COMPRESS_BYTES = 40 * 1024; // 小于 40KB 的图不值得压字节（但尺寸超限仍会缩）
const IMAGE_ANIM_KEEP_MAX = 4 * 1024 * 1024; // 动图 4MB 以内且不超硬上限时完全原样

/** 当前可用的压缩后端（诊断/日志用）。 */
export function imageBackend() {
  if (sharp) return 'sharp';
  if (PNGCodec || jpegCodec) return 'pure-js';
  return 'none';
}

/* ───────────────────────── 头部尺寸嗅探（零依赖） ───────────────────────── */

/** 从图片字节头解析宽高与格式；识别不了返回 null。 */
export function sniffImageInfo(buf) {
  if (!buf || buf.length < 24) return null;
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), animated: false };
    }
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
      return { format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), animated: true };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) { offset += 1; continue; }
        const marker = buf[offset + 1];
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
        const len = buf.readUInt16BE(offset + 2);
        if (len < 2) break;
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { format: 'jpeg', height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7), animated: false };
        }
        offset += 2 + len;
      }
      return null;
    }
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8X' && buf.length >= 30) {
        const flags = buf[20];
        return {
          format: 'webp',
          width: 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16),
          height: 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16),
          animated: (flags & 0x02) !== 0
        };
      }
      if (fourcc === 'VP8L' && buf.length >= 25) {
        const bits = [buf[21], buf[22], buf[23], buf[24]];
        return {
          format: 'webp',
          width: 1 + (((bits[1] & 0x3f) << 8) | bits[0]),
          height: 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6)),
          animated: false
        };
      }
      if (fourcc === 'VP8 ' && buf.length >= 30) {
        return { format: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, animated: false };
      }
    }
  } catch {}
  return null;
}

/** 统一元信息读取：优先 sharp（更准，能识别动图），否则退回头部嗅探。 */
async function readMeta(buf) {
  if (sharp) {
    try {
      const m = await sharp(buf, { animated: true }).metadata();
      if (m && m.width && m.height) {
        return {
          format: String(m.format || ''),
          width: m.width,
          height: m.height,
          animated: m.format === 'gif' || (m.pages !== undefined && m.pages > 1)
        };
      }
    } catch {}
  }
  return sniffImageInfo(buf);
}

/* ───────────────────────── 纯 JS 盒式平均降采样 ───────────────────────── */

/**
 * RGBA 缓冲盒式平均降采样（预乘 alpha，避免透明边发灰）。
 * @returns {{data: Buffer, width: number, height: number}|null} 不需要缩时返回 null
 */
export function downscaleRgba(src, width, height, maxSide) {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= maxSide) return null;
  const nw = Math.max(1, Math.round(width * (maxSide / longest)));
  const nh = Math.max(1, Math.round(height * (maxSide / longest)));
  const dst = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy0 = Math.floor((y * height) / nh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * height) / nh));
    for (let x = 0; x < nw; x++) {
      const sx0 = Math.floor((x * width) / nw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * width) / nw));
      let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let idx = (sy * width + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++, idx += 4) {
          const a = src[idx + 3];
          sr += src[idx] * a;
          sg += src[idx + 1] * a;
          sb += src[idx + 2] * a;
          sa += a;
          n += 1;
        }
      }
      const o = (y * nw + x) * 4;
      if (sa > 0) {
        dst[o] = Math.min(255, Math.round(sr / sa));
        dst[o + 1] = Math.min(255, Math.round(sg / sa));
        dst[o + 2] = Math.min(255, Math.round(sb / sa));
      }
      dst[o + 3] = n > 0 ? Math.round(sa / n) : 0;
    }
  }
  return { data: dst, width: nw, height: nh };
}

/** 纯 JS 缩图（PNG / JPEG）。不支持或失败返回 null。 */
function pureJsDownscale(buf, meta, targetSide) {
  if (!meta || !meta.width || !meta.height) return null;
  const pixels = meta.width * meta.height;
  if (!Number.isFinite(pixels) || pixels > IMAGE_PUREJS_MAX_PIXELS) return null;
  try {
    if (meta.format === 'png' && PNGCodec) {
      // 不能传 skipRescale:true —— 它会让 16bit PNG 保持 Uint16Array、低位深灰度保持未归一值，
      // 而 downscaleRgba 按 8bit RGBA 逐字节取样本，结果是整幅图错色/发白（低深灰图 alpha 近乎 0）。
      // 默认（不跳）由 pngjs 统一归一成 8bit RGBA，256 位深/1、2、4bit 都能正确降采样。
      const decoded = PNGCodec.sync.read(buf);
      const scaled = downscaleRgba(decoded.data, decoded.width, decoded.height, targetSide);
      if (!scaled) return null;
      const out = new PNGCodec({ width: scaled.width, height: scaled.height });
      scaled.data.copy(out.data);
      return Buffer.from(PNGCodec.sync.write(out));
    }
    if ((meta.format === 'jpeg' || meta.format === 'jpg') && jpegCodec) {
      const decoded = jpegCodec.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 200, maxMemoryUsageInMB: 1024 });
      if (!decoded || !decoded.width || !decoded.height) return null;
      const scaled = downscaleRgba(Buffer.from(decoded.data), decoded.width, decoded.height, targetSide);
      if (!scaled) return null;
      const encoded = jpegCodec.encode({ data: scaled.data, width: scaled.width, height: scaled.height }, IMAGE_JPEG_QUALITY);
      return encoded?.data ? Buffer.from(encoded.data) : null;
    }
  } catch {
    return null;
  }
  return null;
}

/** sharp 缩图；未装 sharp 或失败返回 null。 */
async function sharpDownscale(buf, meta, targetSide) {
  if (!sharp) return null;
  try {
    const animated = !!meta?.animated;
    const proc = sharp(buf, { animated }).rotate();
    const longest = Math.max(meta?.width || 0, meta?.height || 0);
    if (longest > targetSide) {
      const landscape = (meta?.width || 0) >= (meta?.height || 0);
      proc.resize({
        width: landscape ? targetSide : undefined,
        height: landscape ? undefined : targetSide,
        fit: 'inside'
      });
    }
    if (animated) {
      const isGif = String(meta?.format || '').toLowerCase() === 'gif';
      const out = isGif
        ? await (longest > targetSide ? proc.coalesce() : proc).gif().toBuffer()
        : await (longest > targetSide ? proc.coalesce() : proc).webp({ quality: IMAGE_JPEG_QUALITY }).toBuffer();
      return out && out.length > 0 ? out : null;
    }
    const out = await proc.jpeg({ quality: IMAGE_JPEG_QUALITY, mozjpeg: true }).toBuffer();
    return out && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/* ───────────────────────── 对外接口 ───────────────────────── */

/**
 * 压缩图片：只在需要（尺寸超常态目标，或字节 >= 40KB）时处理，失败一律原样返回。
 * 关键保证：**返回值的单边不会超过 IMAGE_HARD_MAX_SIDE**（只要后端能解码该格式）。
 */
export async function compressImageBuffer(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) return buf;
  const meta = await readMeta(buf);
  if (!meta || !meta.width || !meta.height) return buf;
  const longest = Math.max(meta.width, meta.height);
  const exceedsHard = longest > IMAGE_HARD_MAX_SIDE;
  const needShrink = longest > IMAGE_MAX_SIDE;
  const needByteTrim = buf.length >= IMAGE_MIN_COMPRESS_BYTES;
  const bytesOverHard = buf.length > IMAGE_HARD_MAX_BYTES;

  // 动图：默认原样保留（有什么发什么），只有超硬上限或字节过大才动。
  if (meta.animated && !exceedsHard && buf.length <= IMAGE_ANIM_KEEP_MAX && !bytesOverHard) return buf;
  // 静态小图且不超尺寸：不值得压。
  if (!meta.animated && !needShrink && !needByteTrim && !bytesOverHard) return buf;

  const target = needShrink || exceedsHard ? IMAGE_MAX_SIDE : longest;
  let out = null;
  if (sharp) out = await sharpDownscale(buf, meta, target);
  if (!out) out = pureJsDownscale(buf, meta, needShrink || exceedsHard ? target : longest);
  if (!out) out = pureJsDownscale(buf, meta, IMAGE_MAX_SIDE);
  if (!out || out.length === 0) return buf;
  // 尺寸超硬上限时必须用缩后的；否则只在真的更小时才替换（避免小图转码反而变大）。
  if (exceedsHard || out.length < buf.length) return out;
  return buf;
}

/**
 * 统一收口：压缩 buffer 并归一 mime。
 * @returns {{buffer: Buffer, mimeType: string, compressed: boolean}}
 */
export async function finalizeImageBuffer(buf, mime) {
  const out = await compressImageBuffer(buf);
  if (out === buf) return { buffer: buf, mimeType: mime, compressed: false };
  // 输出 mime 必须按【输出字节的真实格式】判定：未装 sharp 时 PNG 走纯 JS 后端，压出来的仍是 PNG，
  // 若沿用输入 mime 会得到「PNG 字节 + image/jpeg 声明」，DSH 附件层 inspectMetadata 会以
  // IMAGE_TYPE_MISMATCH 拒收整条 prompt（2026-09-11 实测）。认不出格式时才退回按输入 mime 推断。
  const sniffed = sniffImageInfo(out);
  const byFormat = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  const origLow = String(mime ?? '').toLowerCase();
  const outMime = byFormat[sniffed?.format]
    || (/gif/.test(origLow) ? 'image/gif' : (/webp/.test(origLow) ? 'image/webp' : 'image/jpeg'));
  return { buffer: out, mimeType: outMime, compressed: true };
}

/**
 * 投递前闸门：保证交出去的图一定符合 DSH 附件层限制。
 * 不满足时**不要**交给 DSH（否则整条 prompt 会被 `attachment-error` 拒收），
 * 调用方应退化成文字占位。
 * @returns {{ok: boolean, buffer?: Buffer, mimeType?: string, reason?: string, width?: number, height?: number}}
 */
export async function ensureDeliverableImage(buf, mime) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) return { ok: false, reason: 'empty' };
  const fin = await finalizeImageBuffer(buf, mime);
  if (fin.buffer.length > IMAGE_HARD_MAX_BYTES) {
    return { ok: false, reason: `图片字节超过 ${Math.round(IMAGE_HARD_MAX_BYTES / 1024 / 1024)}MB` };
  }
  const info = await readMeta(fin.buffer);
  if (!info || !info.width || !info.height) {
    // 认不出尺寸（罕见格式）：字节也不大，按可投递处理，交给 DSH 自行判定。
    return { ok: true, buffer: fin.buffer, mimeType: fin.mimeType };
  }
  const longest = Math.max(info.width, info.height);
  if (longest > IMAGE_HARD_MAX_SIDE) {
    return {
      ok: false,
      reason: `图片单边 ${longest}px 超过安全上限 ${IMAGE_HARD_MAX_SIDE}px 且当前无法缩放（${info.format}${imageBackend() === 'none' ? '，且未安装 sharp' : ''}）`,
      width: info.width,
      height: info.height
    };
  }
  if (info.width * info.height > 64_000_000) {
    return { ok: false, reason: `图片总像素 ${info.width}x${info.height} 超过上限`, width: info.width, height: info.height };
  }
  return { ok: true, buffer: fin.buffer, mimeType: fin.mimeType, width: info.width, height: info.height };
}
