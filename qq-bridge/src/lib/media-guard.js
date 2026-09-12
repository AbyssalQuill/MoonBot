// 媒体/文件引用安全校验
// isSafeLocalMediaPath 原读取运行态 cfg.napcat.homeDir，现改为参数注入（调用方传 cfg.napcat?.homeDir）。
import fs from 'node:fs';
import path from 'node:path';

// 校验本地媒体路径必须位于 homeDir 之内（homeDir = 原 cfg.napcat.homeDir，由调用方注入）
export function isSafeLocalMediaPath(filePath, homeDir) {
  try {
    const real = fs.realpathSync(String(filePath));
    if (!homeDir) return false;
    const realHome = fs.realpathSync(String(homeDir));
    return real === realHome || real.startsWith(realHome + path.sep);
  } catch {
    return false;
  }
}

// OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
// 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
export function isProbablySafeImageFileRef(file) {
  const s = String(file ?? '').trim();
  if (!s || s.length > 512) return false;
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  if (/[\\/]/.test(s)) return false;
  if (/^[a-zA-Z]:/.test(s)) return false;
  if (/^(file|https?|base64|data):/i.test(s)) return false;
  if (s.includes('..')) return false;
  return /^[\w.+=@-]+$/.test(s);
}
