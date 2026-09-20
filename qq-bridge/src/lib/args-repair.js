// 工具参数修复：模型偶尔把字符串值漏掉引号（不是合法 JSON），DSH 的宽松解析会把**整个字段丢掉**，
// 于是到达桥侧时 messages 已经不存在了 —— 现场见 tests/args-repair.test.js 顶部。
//
// 【为什么在这里修】参数解析发生在 DSH 里，桥改不了；但桥在事件流里**拿得到原始参数串**
// （core/mux.js 的 tool/call 帧），所以可以在"这次调用已经失败"之后，把那段裸文本捞回来、
// 由桥自己把它发出去（走同一条发送端点，额度/幂等/脱敏全都不绕过），并且把这一批记进幂等账本，
// 让模型的"重发"被判成"已经发过了"。用户看到的是**消息照常到达**，而不是一条报错。
//
// 修复策略（保守，只动"值没引用"这一种病）：
//   · 单引号值 '...' → 双引号 "..."
//   · 裸值（后面紧跟 , "下一个键": 或 } 结尾）→ 整体包成双引号，内部 " 转义
//   · 末尾多余逗号、JSON 里的中文全角引号 “ ” → 半角
// 任何一步失败就返回 null，绝不猜。

const FULLWIDTH_QUOTE = /[\u201c\u201d]/g;

/** 找到 raw 里 key 之后的值的结束位置（下一个 `, "next":` 或收尾的 } / ]） */
function scanBareValueEnd(s, start) {
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      // 看这个引号是不是"下一个键名"的开头：配对引号之后紧跟冒号
      const close = s.indexOf('"', i + 1);
      if (close > 0) {
        let k = close + 1;
        while (k < s.length && /\s/.test(s[k])) k++;
        if (s[k] === ':') {
          let j = i - 1;                       // 退到这个键名前面的逗号
          while (j >= start && /\s/.test(s[j])) j--;
          if (j >= start && s[j] === ',') return j;
        }
      }
      continue;
    }
    if (ch === '}' || ch === ']') return i;
  }
  return s.length;
}

/** 把一段"漏引号"的参数串修成合法 JSON；修不出来返回 null */
export function repairToolArgs(raw) {
  const src = String(raw ?? '').trim();
  if (!src || src[0] !== '{') return null;
  try { const v = JSON.parse(src); if (v && typeof v === 'object') return v; } catch { /* 继续修 */ }
  const s = src.replace(FULLWIDTH_QUOTE, '"').replace(/,\s*([}\]])/g, '$1');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    // 键名与冒号原样保留（单引号键名也一并转成双引号 —— 模型偶尔整体用单引号）
    if (ch === '"' || ch === "'") {
      const end = s.indexOf(ch, i + 1);
      if (end < 0) return null;
      out += '"' + s.slice(i + 1, end).replace(/"/g, '\\"') + '"';
      i = end + 1;
      continue;
    }
    if (ch === ':') {
      out += ch;
      i += 1;
      while (i < s.length && /\s/.test(s[i])) { out += s[i]; i += 1; }
      if (i >= s.length) return null;
      const v = s[i];
      if (v === '"' || v === '{' || v === '[' || /[-0-9tfn]/.test(v)) { continue; }   // 合法值，照原样解析
      if (v === "'") {                                                              // 单引号值 → 双引号
        const end = s.indexOf("'", i + 1);
        if (end < 0) return null;
        out += '"' + s.slice(i + 1, end).replace(/"/g, '\\"') + '"';
        i = end + 1;
        continue;
      }
      const end = scanBareValueEnd(s, i);                                           // 裸值 → 整体加引号
      const bare = s.slice(i, end).trim();
      if (!bare) return null;
      out += '"' + bare.replace(/"/g, '\\"') + '"';
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  try {
    const v = JSON.parse(out);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** 这段原始参数是不是"某个字段漏了引号"的形状？（只用来决定要不要尝试修复） */
export function looksLikeUnquotedArgs(raw) {
  const s = String(raw ?? '');
  if (!s.trim().startsWith('{')) return false;
  try { JSON.parse(s); return false; } catch { /* 不是合法 JSON，才看形状 */ }
  return /"\s*:\s*(?!["\[{-]|\d|true|false|null)[^\s"][^,}]*/.test(s);
}
