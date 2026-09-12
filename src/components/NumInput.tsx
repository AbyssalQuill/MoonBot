import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

/**
 * NumInput —— 纯数字输入框（2026-09-12 主人要求）
 *
 * 为什么不用 `<input type="number">`：
 *   ① 它带原生上下箭头（spinner），"点一下加一"，很容易误触；
 *   ② 更难受的是**删不掉**：受控的 number 输入把空串当成 0 回填，用户想把 "15" 删掉时，
 *      删到最后总会冒出一个 0，还得多点一次鼠标把光标挪到 0 前面才能继续删。
 * 现在的行为：
 *   · 渲染成 `type="text" + inputMode="decimal"`（手机上仍然是数字键盘，桌面上没有箭头）；
 *   · 输入期间**允许全空**（本地文本框 state，不被外部值覆盖）；
 *   · 非空且是合法数字 → 立刻上抛（界面实时跟着变）；
 *   · 失焦时若为空 → 按 0 上抛（"保存时为空就默认为 0"）；
 *   · 外部值变化（比如点「恢复默认参数」）会同步回文本框 —— 但正在输入时不打断。
 */
export default function NumInput({
  value, onCommit, className = 'input', disabled, placeholder, ariaLabel, title, style,
}: {
  value: number | undefined | null;
  onCommit: (n: number) => void;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  title?: string;
  style?: CSSProperties;
}) {
  const ext = (v: number | undefined | null) => (v === undefined || v === null || Number.isNaN(Number(v)) ? '' : String(v));
  const [txt, setTxt] = useState<string>(ext(value));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setTxt(ext(value));
  }, [value, editing]);

  const commit = (raw: string) => {
    const s = String(raw).trim();
    if (s === '') { onCommit(0); return; }
    const n = Number(s);
    onCommit(Number.isFinite(n) ? n : 0);
  };

  return (
    <input
      className={className}
      type="text"
      inputMode="decimal"
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      title={title}
      style={style}
      value={txt}
      onFocus={() => setEditing(true)}
      onChange={(e) => {
        const raw = e.target.value;
        // 只接受数字、小数点、负号与空白，避免把字母敲进去
        if (!/^[-+0-9.eE\s]*$/.test(raw)) return;
        setTxt(raw);
        const s = raw.trim();
        if (s !== '' && Number.isFinite(Number(s))) onCommit(Number(s));
      }}
      onBlur={() => { setEditing(false); commit(txt); }}
    />
  );
}
