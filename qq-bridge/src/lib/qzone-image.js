// QQ 空间（说说）配图：找图 → 体检 → 变成 NapCat 收得下的参数（2026-09-21 新增）
//
// ── 先说清"发说说的真实链路"，因为配图怎么给完全由它决定（下面每条都是读代码/读装好的包得到的，不是猜）──
//   ① 桥侧：mcp-napcat-safe.js 的 qq_send_qzone → OneBot `POST <httpUrl>/send_qzone_msg`（mcp-napcat-safe.js:2637）。
//   ② NapCat 侧（本机装的是 9.9.26-44498，包体 resources/app/napcat/napcat.mjs）：
//        · `SendQzoneMsg._handle`（80276~80283 行）逐个处理 `e.images`：先
//          `Ti(this.core.NapCatTempPath, a)`（9237 行那个图片解析器：case 1 本地路径 / case 2 http(s) 下载 /
//          case 3 `base64://` 解码）归一成一个真正的文件路径；URL 与 base64 这两种"非本地"来源，
//          NapCat 自己在 finally 里删掉（`c.isLocal || o.push(c.path)` + `Pg(s)`）；
//        · 再把该文件字节转 base64 → `uploadImageToQzone`（11560 行）POST
//          `up.qzone.qq.com/cgi-bin/upload/cgi_upload_image` 拿 richval；
//        · 最后 `publishQzoneMsg(content, richvals, ugc_right, target_uins)`（11578 行）把 richval 用 \t 拼起来
//          POST `emotion_cgi_publish_v6`（11585 行）。
//   ⇒ 结论两条：
//      (a) 图片可以按 URL / base64 直传，桥这边一个字节都不用落盘 ⇒ 策略选"能零落盘就零落盘"；
//      (b) 旧代码给的是 `file`（mcp-napcat-safe.js:2636），而 NapCat 只读 `images` —— 那个参数
//          一直被静默忽略（配了图也发不出来，还不报错）。这一条顺手修掉，见 mcp-napcat-safe.js 的 qq_send_qzone。
//
// ── 策略：优先零落盘；只有超限才临时落盘，而且成败都立刻删 ──
//   · 字节 ≤ DEFAULT_BASE64_MAX_BYTES（10MB，napcat-file.js:27）→ 直接把 `base64://…` 交给
//     napcatImageFileArg —— 它对 `base64://` 原样返回（napcat-file.js:63），于是"最终交给 NapCat 的形态"
//     仍然只由那一个 helper 决定：docx 那次「识别URL失败」正是把宿主路径绕过 helper 塞给容器 NapCat 造成的；
//   · 字节 > 10MB → 才写进 napcat.tmpDir（服务器上它指向容器挂载目录，见 napcat-file.js:16-21），
//     仍走 helper（auto 模式映射成容器内路径），cleanup 由调用方 finally 调 —— try/finally 保证异常路径也删；
//   · 残留兜底：sweepQzoneImageTmp 在启动时扫一次（只删我们自己命名的临时文件，原因见该函数注释）。
//
// ── 不落盘的前提是"字节是好的"：与 safe-fetch 用同一道闸门 ──
//   safeFetchBuffer 内部已经跑 verifyImageComplete（safe-fetch.js:382），这里再显式对一次，两个理由：
//   ① 本地 file 参数这条路的字节没经过 safeFetchBuffer，必须自己过闸；
//   ② 体检不过就发纯文字说说（return 里如实写原因），既不报错也不 attach 半幅灰的截断图。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { log } from './log.js';
import { napcatImageFileArg, DEFAULT_BASE64_MAX_BYTES } from './napcat-file.js';
import { safeFetchBuffer, MAX_IMAGE_FETCH_BYTES, verifyImageComplete } from '../safe-fetch.js';
import { searchImages } from './image-search.js';
import {
  pixivSearch, parsePixivId, pixivIllustDetail, pixivIllustOriginals,
  pixivImageSources, planPixivSend, pixivTierSizeVerdict,
} from './pixiv.js';
import { sniffImageInfo } from './image-compress.js';

/** 一条说说最多配几张图（默认一张；多了就卡在这个上限，见 clampQzoneImageCount）。 */
export const QZONE_IMAGE_MAX = 3;

/** 临时图的启动清扫阈值：3 小时（一次成功的发帖在秒级完成，超过这个岁数的必然是"写盘后进程被打断"的残留）。 */
export const QZONE_IMAGE_TMP_MAX_AGE_MS = 3 * 60 * 60 * 1000;

/** 我们自己命名的临时文件：`qzone-<毫秒>-<6位随机>.<ext>`。
 *  清扫只认这个形状且必须从头匹配（^…$）—— 见 sweepQzoneImageTmp 里"为什么不按目录清空"的注释。 */
const QZONE_TMP_NAME_RE = /^qzone-\d{10,}-[0-9a-z]{4,}\.(?:jpe?g|png|gif|webp)$/i;

/** 配图张数：默认 1，非法值当 1，上限 QZONE_IMAGE_MAX（3）。 */
export function clampQzoneImageCount(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(QZONE_IMAGE_MAX, v);
}

/** 配图临时目录：napcat.tmpDir 优先（服务器 = 容器挂载目录），否则 <root>/state/qzone-img-tmp。 */
export function qzoneImageTmpDir(cfg, root) {
  const configured = String(cfg?.napcat?.tmpDir ?? '').trim();
  if (configured) return configured;
  if (!root) throw new Error('qzoneImageTmpDir 需要 napcat.tmpDir 或 root（qq-bridge 根目录）');
  return path.join(root, 'state', 'qzone-img-tmp');
}

/** 魔数认格式（与 safe-fetch.js:236 的 looksLikeImageBuffer 同一套判定），返回扩展名或 ''。**纯函数，离线可测**。 */
export function sniffQzoneImageExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  const head6 = buf.toString('ascii', 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return '';
}

/**
 * 配图体检：字节完整（FFD9 / IEND / 0x3B / RIFF 长度对得上，且 content-length 对得上）+ 认得出格式。
 * 纯函数，离线可测。宽高拿不到不拦（有的格式/裁剪形状嗅探不出来），只作附带的像素对账信息。
 */
export function verifyQzoneImage(buf, info = {}) {
  const complete = verifyImageComplete(buf, info.contentLength ?? null, info.contentEncoding ?? null);
  const ext = sniffQzoneImageExt(buf);
  const meta = sniffImageInfo(buf) || {};
  const base = {
    ext,
    format: complete.format || meta.format || '',
    width: Number(meta.width) || 0,
    height: Number(meta.height) || 0,
    bytes: Buffer.isBuffer(buf) ? buf.length : 0,
  };
  if (!complete.ok) return { ...base, ok: false, reason: complete.reason || '图片字节不完整' };
  if (!ext) return { ...base, ok: false, reason: '认不出图片格式（魔数不是 PNG/JPEG/GIF/WebP）' };
  return { ...base, ok: true, reason: '' };
}

/**
 * 把配图字节变成"可以塞进 OneBot `images` 数组"的那个字符串。零落盘优先。
 * @returns {{arg:string, mode:'base64'|'file', path:string, bytes:number, cleanup:(()=>Promise<void>)|null}}
 *   mode=base64 → 一个字节都没写盘（NapCat 拿到 base64 后自己落它的临时目录并在 finally 删）；
 *   mode=file   → 只有超过 base64 上限才会出现，调用方必须在 finally 里 await cleanup()。
 */
export function prepareQzoneImageArg(buf, cfg, opts = {}) {
  const logger = typeof opts.log === 'function' ? opts.log : log;
  const bytes = Buffer.isBuffer(buf) ? buf.length : 0;
  if (!bytes) throw new Error('配图字节为空，不能交给 NapCat');
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_BASE64_MAX_BYTES;
  const ext = sniffQzoneImageExt(buf) || 'jpg';

  if (bytes <= maxBytes) {
    const arg = napcatImageFileArg(`base64://${buf.toString('base64')}`, cfg, { log: logger, maxBytes });
    return { arg, mode: 'base64', path: '', bytes, cleanup: null };
  }

  const dir = qzoneImageTmpDir(cfg, opts.root);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `qzone-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`);
  fs.writeFileSync(file, buf);
  const arg = napcatImageFileArg(file, cfg, { log: logger, maxBytes });
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(file, { force: true }); }
    catch (e) { logger(`[qzone-image] 删临时配图失败（留着也会被启动清扫收走）: ${path.basename(file)} ${e?.message ?? e}`); }
  };
  const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${n}B`);
  logger(`[qzone-image] 配图 ${mb(bytes)} 超过 base64 上限 ${mb(maxBytes)}，临时落盘 ${path.basename(file)}（发完即删；交给 NapCat 的形态=${arg.startsWith('base64://') ? 'base64' : arg}）`);
  return { arg, mode: 'file', path: file, bytes, cleanup };
}

/**
 * 启动清扫：删掉自己写的、超过 maxAgeMs 的配图临时文件。同步、纯文件系统，离线可测。
 *
 * 为什么按文件名过滤而不是"按目录清空"：临时目录可能是 `napcat.tmpDir`，那是与表情包/文档
 * 共用的容器挂载目录（napcat-file.js:16-21 的部署配置就是这么写的），清空目录等于把别人的东西删了。
 * 同名做法可参照 core/sticker.js:439 / core/docx.js:76（都是"启动时扫一次旧文件"）。
 */
export function sweepQzoneImageTmp(dir, maxAgeMs = QZONE_IMAGE_TMP_MAX_AGE_MS, now = Date.now()) {
  const out = { dir: String(dir ?? ''), scanned: 0, removed: 0, names: [] };
  if (!out.dir) return out;
  let entries = [];
  try { entries = fs.readdirSync(out.dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    out.scanned += 1;
    if (!QZONE_TMP_NAME_RE.test(e.name)) continue;
    const full = path.join(out.dir, e.name);
    let st = null;
    try { st = fs.statSync(full); } catch { continue; }
    if (now - Number(st.mtimeMs || 0) < maxAgeMs) continue;
    try {
      fs.rmSync(full, { force: true });
      out.removed += 1;
      out.names.push(e.name);
    } catch { /* 删不掉不影响发帖 */ }
  }
  return out;
}

/**
 * 按入参取图（本地文件 / 直链 / pixiv / 联网搜图），逐张过体检，最多 want 张。
 * 不抛错：拿不到图就返回空 items + notes，让调用方发纯文字说说（约定边界：配图失败别把发帖搞挂）。
 * 入参优先级（第一条非空者生效）：file > imageUrl > pixivIllustId/pixivQuery > imageQuery。
 * @returns {{requested:boolean, want:number, items:object[], notes:string[], tried:string[]}}
 */
export async function collectQzoneImages(opts = {}) {
  const cfg = opts.cfg ?? {};
  const want = clampQzoneImageCount(opts.imageCount);
  const index = Math.max(0, Number(opts.imageIndex) || 0);
  const pixivSize = String(opts.pixivSize ?? 'original').toLowerCase() === 'master' ? 'master' : 'original';
  const items = [];
  const notes = [];
  const tried = [];
  const filePath = String(opts.file ?? '').trim();
  const directUrl = String(opts.imageUrl ?? '').trim();
  const pixivQuery = String(opts.pixivQuery ?? '').trim();
  const imageQuery = String(opts.imageQuery ?? '').trim();
  const requested = Boolean(filePath || directUrl || pixivQuery || opts.pixivIllustId || imageQuery);

  /** 下载一个候选 + 体检（+ pixiv 档位像素对账），通过就收进 items。任何失败只记 tried，不抛。 */
  const accept = async ({ url, referer, tier, from, title, work, page = 0 }) => {
    const label = String(url).slice(0, 96);
    try {
      const got = await safeFetchBuffer(url, MAX_IMAGE_FETCH_BYTES, referer ? { referer } : null);
      const v = verifyQzoneImage(got.buffer, { contentLength: got.contentLength, contentEncoding: got.contentEncoding });
      if (!v.ok) { tried.push(`${label} → ${v.reason}`); return null; }
      if (work) {
        // 档位 × 实际像素：第三方代理可能拿原图地址给你一张缩过的图（见 lib/pixiv.js 顶部现场）
        const verdict = pixivTierSizeVerdict(tier, {
          originalWidth: page === 0 ? Number(work.width) || 0 : 0,
          originalHeight: page === 0 ? Number(work.height) || 0 : 0,
          imageWidth: v.width,
          imageHeight: v.height,
          page,
        });
        if (!verdict.ok) { tried.push(`${label} → ${verdict.reason}`); return null; }
      }
      const item = {
        buffer: got.buffer, bytes: v.bytes, ext: v.ext, from,
        url: got.url || url, title: String(title || ''),
        tier: String(tier || ''), via: referer ? 'pximg-direct' : 'mirror-proxy',
        pixels: v.width && v.height ? `${v.width}x${v.height}` : '',
        tierFallback: null,
      };
      items.push(item);
      return item;
    } catch (e) {
      tried.push(`${label} → ${e?.message ?? e}`);
      return null;
    }
  };

  /** pixiv 一张作品：候选按档分桶发（原图档优先；缩略档不试；降级必须显式说清）。 */
  const takePixivWork = async (work) => {
    const op = await pixivIllustOriginals(work).catch(() => ({ urls: [], source: '', note: '' }));
    const sources = pixivImageSources(work, { page: 0, size: pixivSize, originals: op.urls });
    const plan = planPixivSend(sources, { size: pixivSize });
    for (const s of plan.skipped) {
      console.error(`[qzone-image] pixiv ${work.id}：跳过一个不该发的档（${s.tier}）${s.url.slice(0, 96)} —— ${s.reason}`);
    }
    for (const s of plan.primary) {
      const it = await accept({ url: s.url, referer: s.referer, tier: s.tier, from: `pixiv:${work.id}`, title: work.title, work });
      if (it) return it;
    }
    if (plan.fallback.length) {
      console.error(`[qzone-image] pixiv ${work.id}：原图档 ${plan.primary.length} 个候选全失败 → 显式降级到 ${plan.fallback.map((s) => s.tier).join('/')}；失败原因：${tried.slice(-3).join(' | ') || '(无)'}`);
      for (const s of plan.fallback) {
        const it = await accept({ url: s.url, referer: s.referer, tier: s.tier, from: `pixiv:${work.id}`, title: work.title, work });
        if (it) {
          it.tierFallback = { to: s.tier, reason: String(s.fallbackReason ?? ''), originalTried: plan.primary.length };
          return it;
        }
      }
    }
    return null;
  };

  // ① 本地文件（老参数 file）：字节没经过 safeFetchBuffer，必须自己过同一道体检
  if (filePath) {
    try {
      const buf = fs.readFileSync(filePath);
      const v = verifyQzoneImage(buf);
      if (v.ok) {
        items.push({
          buffer: buf, bytes: v.bytes, ext: v.ext, from: 'file', url: '', title: '', tier: '', via: 'local',
          pixels: v.width && v.height ? `${v.width}x${v.height}` : '', tierFallback: null, localPath: filePath,
        });
      } else {
        notes.push(`本地配图 ${path.basename(filePath)} 没通过体检（${v.reason}），这次只发文字`);
      }
    } catch (e) {
      notes.push(`读本地配图失败（${e?.message ?? e}），这次只发文字`);
    }
  }

  // ② 显式直链
  if (!items.length && directUrl) await accept({ url: directUrl, from: 'url' });

  // ③ pixiv（作品号优先，其次关键词；一律排除 R-18 —— 说说是公开可见的，与 qq_send_pixiv 同一规矩）
  if (!items.length && (pixivQuery || opts.pixivIllustId)) {
    const workList = [];
    const wantId = parsePixivId(opts.pixivIllustId);
    if (wantId) {
      const work = await pixivIllustDetail(wantId).catch((e) => { notes.push(`取 pixiv 作品 ${wantId} 失败：${e?.message ?? e}`); return null; });
      if (work) workList.push(work);
    } else {
      const r = await pixivSearch(pixivQuery, { limit: 10 }).catch((e) => { notes.push(`pixiv 搜索失败：${e?.message ?? e}`); return null; });
      if (r && !r.results?.length) notes.push(`pixiv 没搜到「${pixivQuery}」（R-18 过滤 ${r.filtered} 条）`);
      for (const w of r?.results ?? []) workList.push(w);
    }
    const safeWorks = workList.filter((w) => {
      if (w?.adult) { notes.push(`pixiv 作品 ${w.id} 是 R-18，不配进公开说说`); return false; }
      return true;
    });
    for (let i = index; i < safeWorks.length && items.length < want; i += 1) {
      await takePixivWork(safeWorks[i]);
    }
  }

  // ④ 联网搜图（默认只发第 index 张；要多张就顺着相关度往下取）
  if (!items.length && imageQuery) {
    const r = await searchImages(imageQuery, { limit: Math.max(8, index + want + 2) })
      .catch((e) => { notes.push(`联网搜图失败：${e?.message ?? e}`); return null; });
    const rows = r?.results ?? [];
    if (r && !rows.length) notes.push(`没搜到「${imageQuery}」的图片（失败源：${JSON.stringify(r.failures)}）`);
    for (let i = index; i < rows.length && items.length < want; i += 1) {
      await accept({ url: rows[i].imageUrl, from: 'search', title: rows[i].title });
    }
  }

  if (requested && !items.length) notes.push('这次没有可用的配图（原因见 tried），只发文字说说');
  return { requested, want, items, notes, tried: tried.slice(0, 5) };
}
