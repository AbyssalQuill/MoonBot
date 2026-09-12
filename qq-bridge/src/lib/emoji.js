// 输入法 emoji 剥离工具
// 说明：QQ 会把 ♥❤😊☀♪ 这类输入法字符自动转成彩色 emoji，因此一律剥离；
// 只有紧跟 U+FE0E（文本呈现符）的字符保留——那是"冷脸萌/颜文字"所需的文本样式（如 ✌︎ ᗜ ‸ ᗜ）。

// emoji 呈现码点判断（含 ♥❤☺⚠ 等"无 FE0F 也会被 QQ 自动渲染成彩色 emoji"的符号区段）
export function isEmojiLikeCp(cp) {
  return (cp >= 0x2300 && cp <= 0x23FF) ||  // 时钟/技术符号等
    (cp >= 0x2600 && cp <= 0x27BF) ||      // 杂项符号+花体（♥❤☀☁☺⚡✈★♪ 等）
    (cp >= 0x2B00 && cp <= 0x2BFF) ||      // 箭头装饰
    (cp >= 0xFE00 && cp <= 0xFE0F) ||      // 变体选择符（FE0F=emoji式，FE0E=文本式单独出现时丢弃）
    (cp >= 0x1F000 && cp <= 0x1FAFF) ||    // 高平面 emoji 图形（😀😂🥺🥰😭😤 等）
    (cp >= 0x1F1E6 && cp <= 0x1F1FF);      // 国旗/地区
}

// 剥离普通文本里的输入法 emoji，但保留 [CQ:...]（原生表情段）与颜文字（U+FE0E 文本变体时保留）。
export function stripImeEmoji(text) {
  let s = String(text ?? '');
  const cq = [];
  s = s.replace(/\[CQ:[^\]]*\]/g, (m) => { cq.push(m); return '\u0002'; });
  const chars = Array.from(s);
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const cp = ch.codePointAt(0);
    const next = chars[i + 1];
    // U+FE0E 文本呈现符：把前面字符按"文本样式"保留（✌︎ 这类颜文字组成部分）
    if (next === '\uFE0E') { out.push(ch, next); i++; continue; }
    if (isEmojiLikeCp(cp)) continue; // 输入法 emoji / ♥❤ 符号一律剥离（QQ 会自动渲染成彩色 emoji）
    out.push(ch);
  }
  s = out.join('');
  s = s.replace(/\u0002/g, () => cq.shift() || '');
  // 清理剥离留下的多余空格/标点前空格，避免 "好的 ~" 或 "好的 ！！" 这类痕迹
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/\s+([，。！？；：、,.!?;:])/g, '$1').replace(/^\s+|\s+$/g, '');
  return s;
}
