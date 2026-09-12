// 循环复读监测的纯文本工具
// 归一化：去空白、压缩重复标点、限长，用于比较两回合输出是否"复读"。
export function normalizeLoopSignature(text) {
  const t = String(text ?? '')
    .replace(/[ \t\r\n]+/g, ' ')
    .replace(/([，。！？、,.!?])\1+/g, '$1')
    .trim();
  return t.slice(0, 120);
}

// 防循环回复：判断两条发送文本是否构成重复（相同、包含、或前 20 字高度相似）
export function isDuplicateSendText(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (la < 4 || lb < 4) return false;
  if (la >= lb && a.includes(b)) return true;
  if (lb > la && b.includes(a)) return true;
  const sa = a.slice(0, 20), sb = b.slice(0, 20);
  const n = Math.max(sa.length, sb.length);
  if (!n) return false;
  let same = 0;
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) if (sa[i] === sb[i]) same++;
  return same / n > 0.8;
}
