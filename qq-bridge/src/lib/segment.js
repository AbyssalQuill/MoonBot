// QQ 出站文本分条工具

// 把含换行的文本压成一行：换行 → 空格、连续空格折叠、去首尾空白
export function singleLineForQQ(s) {
  return String(s ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// 超长段落：先按次要标点拆，再按字符硬拆，保证不丢内容、不退回单条长消息。
// URL 会被当作不可拆分的原子，避免把 https://... 这种整条网页地址拆断。
export function splitLongSegment(segment, max) {
  const s = String(segment ?? '').trim();
  if (!s) return [];
  const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
  if (s.length <= safeMax) return [s];

  const urlRe = /https?:\/\/[^\s，。；、]+/g;
  const urls = [];
  const masked = s.replace(urlRe, (m) => {
    urls.push(m);
    return `\u0000URL${urls.length - 1}\u0000`;
  });

  const raw = masked.split(/([，、；：,;:])/);
  const tokens = [];
  for (let i = 0; i < raw.length; i += 2) {
    tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
  }
  const out = [];
  let cur = '';
  for (const tok of tokens) {
    if (!tok) continue;
    if (tok.length > safeMax) {
      if (cur) { out.push(cur); cur = ''; }
      for (let i = 0; i < tok.length; i += safeMax) out.push(tok.slice(i, i + safeMax));
    } else if (cur.length + tok.length <= safeMax) {
      cur += tok;
    } else {
      out.push(cur);
      cur = tok;
    }
  }
  if (cur) out.push(cur);

  return out
    .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
    .filter(Boolean);
}

