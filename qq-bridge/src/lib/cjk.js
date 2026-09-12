// CJK 文本工具（纯函数）

/** 判断字符是否属 CJK 或全角区间 */
export function isCjkChar(ch) {
  if (!ch) return false;
  const c = ch.codePointAt(0);
  return (
    (c >= 0x2e80 && c <= 0x2eff) || // 部首
    (c >= 0x3000 && c <= 0x303f) || // CJK 符号/标点
    (c >= 0x3040 && c <= 0x30ff) || // 假名
    (c >= 0x3400 && c <= 0x4dbf) || // 扩展A
    (c >= 0x4e00 && c <= 0x9fff) || // 基本区
    (c >= 0xf900 && c <= 0xfaff) || // 兼容表意
    (c >= 0xff00 && c <= 0xffef)    // 全角/半角形式
  );
}

/** 在 CJK 密集文本中插入空格，方便逐字蹦出 */
export function splitCjk(text) {
  if (!text) return [];
  const out = [];
  let buf = '';
  for (const ch of text) {
    if (isCjkChar(ch)) {
      if (buf) { out.push(buf); buf = ''; }
      out.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}
