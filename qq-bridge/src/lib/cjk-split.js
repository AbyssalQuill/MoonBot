// 一代"按空格分条"文本工具
// 注意：与 lib/cjk.js（逐字蹦出用、isCjkChar 含标点/全角）语义不同，勿混用。
// 判断字符是否属于"中文汉字"范围，用于识别空格分句意图。
// 注意：这里只认汉字，不认中文标点/全角符号，避免"你好， 世界"这种 AI 排版空格被误拆。
export function isCjkChar(ch) {
  if (!ch) return false;
  const code = ch.codePointAt(0);
  return (
    (code >= 0x4E00 && code <= 0x9FFF) ||
    (code >= 0x3400 && code <= 0x4DBF) ||
    (code >= 0xF900 && code <= 0xFAFF)
  );
}

// 按"有意的空格"拆分：真人不会主动用空格，因此 AI 回复里的空格视为分条信号。
// 空格两侧只要有一侧是中文/中文标点，就按分条处理（包括中英文/数字之间的空格）。
// 注意：该逻辑只用于一代 reserved 的自动转发文本；default default 不走这里，default必须显式用数组分条。
export function splitByCjkSpaces(src) {
  const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length <= 1) return tokens;
  const groups = [];
  let cur = tokens[0];
  for (let i = 1; i < tokens.length; i++) {
    const prevLast = [...cur].pop() || '';
    const currFirst = [...tokens[i]][0] || '';
    // 空格两侧只要有一侧是汉字，就视为分条信号。
    if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
      groups.push(cur);
      cur = tokens[i];
    } else {
      cur = cur + ' ' + tokens[i];
    }
  }
  if (cur) groups.push(cur);
  return groups;
}

// default角色卡 CJK 判断：汉字 + CJK 标点（0x3000-0x303F）。与上方只认汉字的 isCjkChar 语义不同。
export function isCjkLikeChar(ch) {
  if (!ch) return false;
  const code = ch.codePointAt(0);
  return (
    (code >= 0x4E00 && code <= 0x9FFF) ||
    (code >= 0x3400 && code <= 0x4DBF) ||
    (code >= 0xF900 && code <= 0xFAFF) ||
    (code >= 0x3000 && code <= 0x303F)
  );
}

// 仅用于default角色卡"回复示例"节：把示例里用于分条的中文空格改写成中文逗号。
// 空格两侧只要有一侧是中文/中文标点，且另一侧不是 / \ ( ) [ ] { } " ' < > | 等符号，就转成逗号。
export function convertExampleSpacesToComma(line) {
  const chars = Array.from(String(line ?? ''));
  const NO_REPLACE = new Set(['/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.', '。', '，', '、']);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === ' ' || ch === '\t') {
      const prev = chars[i - 1];
      const next = chars[i + 1];
      const prevCjk = !!prev && isCjkLikeChar(prev);
      const nextCjk = !!next && isCjkLikeChar(next);
      const prevBlocked = !!prev && NO_REPLACE.has(prev);
      const nextBlocked = !!next && NO_REPLACE.has(next);
      if ((prevCjk || nextCjk) && !prevBlocked && !nextBlocked) {
        out += '，';
        continue;
      }
    }
    out += ch;
  }
  return out;
}
