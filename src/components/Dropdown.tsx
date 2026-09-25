/* ===================================================================================
   自定义下拉组件（全站替换原生 select 元素）
   -----------------------------------------------------------------------------------
   为什么自研：2026-09-30 要求「把下拉框的所有下拉面板宽度加宽」。
   原生 select 的选项浮层是浏览器/操作系统自己绘制的 popup widget：
   它不在本页面的 DOM 树里，宽度 = 控件自身宽度，CSS 既改不到它的宽度、也改不到
   它内部的滚动条（结论与依据见 styles/app.css 里「下拉框（select）的下拉列表」两段）。
   定稿方案：全站所有下拉都换成自定义下拉 —— 面板宽度由我们自己算，才能真的「加宽」。

   「外观」：触发器完全沿用既有的 class（调用方把原来的 `className` 原样传进来，
   所以 `.select` / `.input` / `.pg-filter-select` / `.cute-ui` / `.profile-panel` 那些
   既有样式规则一条都不用改），只在右侧多一个 ChevronDown 箭头。
   弹出面板不带任何主题色：白底 + 中性灰边框 + 轻阴影，悬停/选中一律极浅中性灰。

   「面板宽度」computePanelWidth(triggerWidth, longestLabelPx, viewportWidth)：
       min( max(触发控件实测宽, 320, 最长项文字宽 + 面板内衬), min(视口可用宽 - 24, 520) )
   触发宽度用 getBoundingClientRect() 实测；最长项文字宽用与面板同字体的隐藏测量盒
   逐项实测（不是估算）。面板挂 portal 到 document.body + position:fixed。
   「滚动策略」：二选一里选了「滚动即关闭」面板是 fixed 定位，一旦真实滚动发生，
   触发器就会从面板底下移开，实时跟随需要给每一级祖先都挂 scroll 监听（还可能踩到
   嵌套滚动容器）；关闭更简单也更接近原生下拉的观感。窗口 resize 则是重新定位
   （视口尺寸变了，翻转与左右夹取都得重算）。面板内部的滚动条不在「关闭」之列。
   =================================================================================== */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export type DropdownOption = { value: string; label: string; disabled?: boolean };

export type DropdownProps = {
  value: string;
  onChange: (v: string) => void;
  options: DropdownOption[];
  disabled?: boolean;
/** 原样套到触发器上，保证既有 `.select` / `.input` / `.pg-filter-select` 等样式继续生效 */
  className?: string;
/** 同上：套到触发器上（原来是给原生下拉的 width/maxWidth 之类） */
  style?: CSSProperties;
  title?: string;
  ariaLabel?: string;
/** value 为空（且没有可选项命中）时触发器里的灰字；不传即为空白 */
  placeholder?: string;
};

/* #region core-width —— 纯宽度计算（无 DOM 依赖，可单独抽出跑断言） */
/** 面板宽度下限：0 = 不设下限（2026-09-30「不要太宽」窄控件就用它自己的宽度，不再硬撑到 320） */
export const PANEL_MIN_WIDTH = 0;
/** 只在「还没量出触发控件宽度」的那一帧当兜底宽度用；正常路径下面板宽度恒等于触发控件宽度 */
export const PANEL_MAX_WIDTH = 340;
/** 宽度算式里给视口留的边距 */
export const PANEL_VIEWPORT_MARGIN = 24;
/** 面板贴视口左右边缘的最小留白（最终定位用） */
export const PANEL_EDGE_MARGIN = 8;
/** 面板最多先显示几项，超出后内部滚动：14 → 8（2026-09-30「下拉框还有点长」列表不要太长） */
export const PANEL_MAX_VISIBLE_ITEMS = 8;
/** 单项估算高度（CSS 里 .mb-dd-item 的 min-height 与它一致） */
export const ITEM_HEIGHT_ESTIMATE = 32;
/** 一项文字之外必须占掉的水平空间：项内边距 10+10 + 对勾槽 18 + 面板内边距 4+4 + 边框 2 + 余量 4 */
export const PANEL_CHROME_PX = 52;
/** 控件宽度下限：选项都很短（如 off）时不要把盒子压成一条细缝 */
export const TRIGGER_MIN_WIDTH = 130;

/**
 * 面板宽度（px）。纯函数，不碰 DOM。
 *
 * 2026-09-30 第三次纠正，原话：「下拉框和下拉面板还是不一样，下拉面板太宽」。
 * 所以这里不再做任何"内容驱动的加宽"：面板宽度恒等于触发控件实测宽度
 * （触发控件本身已按内容收缩，见 app.css 的 .mb-dd），只受视口留白约束。
 * 选项文字放不下时用省略号 + title 提示，绝不把面板撑得比控件宽。
 * （`longestLabelPx` 仍作为参数保留：调用方还在量，将来若要恢复"内容驱动"可直接启用。）
 * @param triggerWidth   触发控件实测宽度（getBoundingClientRect().width）
 * @param longestLabelPx 最长一项文字实测宽度（与面板同字体）—— 当前不影响结果
 * @param viewportWidth  视口宽度（window.innerWidth）
 */
export function computePanelWidth(triggerWidth: number, longestLabelPx: number, viewportWidth: number): number {
  void longestLabelPx;
  // 视口约束兜底：窗口极窄时面板最多只能占满视口（留 24px 边距），否则一律等于控件宽
  const cap = Math.max(1, viewportWidth - PANEL_VIEWPORT_MARGIN);
  return Math.max(1, Math.min(Math.round(triggerWidth), cap));
}
/* #endregion core-width */

/** 面板最大高度：先显示 14 项，超出内部滚动 */
const PANEL_MAX_HEIGHT = PANEL_MAX_VISIBLE_ITEMS * ITEM_HEIGHT_ESTIMATE + 10;

type PanelGeom = { left: number; top: number; width: number; maxHeight: number };

export function Dropdown({
  value, onChange, options, disabled, className, style, title, ariaLabel, placeholder,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [contentPx, setContentPx] = useState(0);
  const [geom, setGeom] = useState<PanelGeom | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  // 命中项是禁用项（原写法 `<option value="" disabled hidden>`）时按原生观感显示空白 / placeholder
  const triggerLabel = selected && !selected.disabled ? selected.label : (placeholder ?? '');

  const close = useCallback((focusBack?: boolean) => {
    setOpen(false);
    setGeom(null);
    if (focusBack) triggerRef.current?.focus();
  }, []);

  const openPanel = useCallback(() => {
    const idx = options.findIndex((o) => o.value === value && !o.disabled);
    setActive(idx >= 0 ? idx : Math.max(0, options.findIndex((o) => !o.disabled)));
    setGeom(null);            // 每次开都重新实测，避免用到上一轮的旧几何
    setOpen(true);
  }, [options, value]);

  const commit = useCallback((i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    close(true);
  }, [close, onChange, options]);

  const move = useCallback((dir: 1 | -1) => {
    setActive((cur) => {
      const n = options.length;
      if (!n) return 0;
      let i = cur;
      for (let step = 0; step < n; step++) {
        i = (i + dir + n) % n;
        if (!options[i]?.disabled) return i;
      }
      return cur;
    });
  }, [options]);

  const edgeIndex = useCallback((from: 'start' | 'end') => {
    if (from === 'start') {
      const i = options.findIndex((o) => !o.disabled);
      return i >= 0 ? i : 0;
    }
    for (let i = options.length - 1; i >= 0; i--) if (!options[i]?.disabled) return i;
    return Math.max(0, options.length - 1);
  }, [options]);

  /* ① 实测「最长一项」的文字宽度（面板同字体）——
   *    2026-09-30 要求「其他的横向要显示全字」把控件本身定成"刚好放下最长一项"的宽度，
   *    选项与当前值（只要在列表里）都能整行显示，不再是省略号。
   *    这里不管面板开没开都量，且只在选项/样式变化或字体就绪时重测 —— 宽度稳定，
   *    不会因为当前选中值字数不同而忽宽忽窄。 */
  const measure = useCallback(() => {
    const box = measureRef.current;
    if (!box) return;
    const fontSrc = triggerRef.current ?? panelRef.current;
    if (fontSrc) {
      const cs = window.getComputedStyle(fontSrc);
      box.style.fontFamily = cs.fontFamily;
      box.style.fontSize = cs.fontSize;
      box.style.fontWeight = cs.fontWeight;
      box.style.fontStyle = cs.fontStyle;
      box.style.letterSpacing = cs.letterSpacing;
    }
    let max = 0;
    for (const o of options) {
      const span = box.ownerDocument.createElement('span');
      span.textContent = o.label || '';
      box.appendChild(span);
      const w = span.getBoundingClientRect().width;
      box.removeChild(span);
      if (w > max) max = w;
    }
    setContentPx(max);
  }, [options]);

  useLayoutEffect(() => { measure(); }, [measure, className]);
  useEffect(() => {
    // 字体是后加载的：就绪后再量一次，否则首测会偏小
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts || typeof fonts.ready?.then !== 'function') return;
    let alive = true;
    fonts.ready.then(() => { if (alive) measure(); }).catch(() => { /* 量不到就维持首测值 */ });
    return () => { alive = false; };
  }, [measure]);

  /* ② 定位：fixed 坐标 + 下方空间不足时向上翻转 + 左右夹进视口；resize 时重算 */
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = computePanelWidth(r.width, contentPx, vw);
      const panelH = Math.min(PANEL_MAX_HEIGHT, Math.max(1, options.length) * ITEM_HEIGHT_ESTIMATE + 10);
      const left = Math.min(
        Math.max(r.left, PANEL_EDGE_MARGIN),
        Math.max(PANEL_EDGE_MARGIN, vw - width - PANEL_EDGE_MARGIN),
      );
      const below = r.bottom + 4;
      const above = r.top - 4 - panelH;
      const fitsBelow = below + panelH <= vh - PANEL_EDGE_MARGIN;
      const top = (!fitsBelow && above >= PANEL_EDGE_MARGIN)
        ? above
        : Math.min(below, Math.max(PANEL_EDGE_MARGIN, vh - panelH - PANEL_EDGE_MARGIN));
      setGeom({ left, top, width, maxHeight: Math.min(panelH, vh - 2 * PANEL_EDGE_MARGIN) });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open, contentPx, options.length]);

  /* ③ 打开时把当前选中项滚进可视区 */
  useLayoutEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`.mb-dd-item[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
    // 只在「刚打开」时滚一次，之后跟随键盘高亮即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /* ④ 点面板外 / Esc 关闭；滚动关闭（面板内部滚动除外） */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && (triggerRef.current?.contains(t) || panelRef.current?.contains(t))) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(true); }
    };
    const onScroll = (e: Event) => {
      const t = e.target;
      // 面板自己内部滚（最多 14 项）不该关；页面/容器滚动会带着触发器跑掉，直接关
      if (t instanceof Node && panelRef.current?.contains(t)) return;
      close();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close]);

  const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const k = e.key;
    if (!open) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') {
        e.preventDefault();
        openPanel();
      }
      return;
    }
    if (k === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (k === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (k === 'Home') { e.preventDefault(); setActive(edgeIndex('start')); }
    else if (k === 'End') { e.preventDefault(); setActive(edgeIndex('end')); }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); commit(active); }
    else if (k === 'Tab') { close(); }   // 不 preventDefault：焦点继续走正常顺序
  };

  const triggerClass = ['mb-dd', className].filter(Boolean).join(' ');

  /* 控件宽度 = 最长一项文字 + 控件自身占位（内边距/箭头/间距）。
   * 页面显式传了 style.width（筛选栏那几个）时以页面为准，不覆盖。 */
  const autoWidth = contentPx > 0 ? Math.max(contentPx + PANEL_CHROME_PX, TRIGGER_MIN_WIDTH) : undefined;
  const widthStyle: React.CSSProperties =
    autoWidth === undefined || (style && style.width !== undefined) ? {} : { width: autoWidth };

  return (
    <>
      {/* 隐藏测量盒：与控件同字体，逐项量文字宽度（不是估算）；面板未打开时也要在，所以放在外面 */}
      <div ref={measureRef} className="mb-dd-measure" aria-hidden="true" />
      <button
        ref={triggerRef}
        type="button"
        className={triggerClass}
        style={{ ...style, ...widthStyle }}
        title={title}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-controls={open ? `${baseId}-list` : undefined}
        aria-activedescendant={open ? `${baseId}-opt-${active}` : undefined}
        disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onClick={() => { if (disabled) return; if (open) close(); else openPanel(); }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="mb-dd-label">{triggerLabel === '' ? '\u00a0' : triggerLabel}</span>
        <ChevronDown size={14} className="mb-dd-caret" aria-hidden="true" />
      </button>

      {open && createPortal(
        <div
          className="mb-dd-panel"
          id={`${baseId}-list`}
          ref={panelRef}
          role="listbox"
          onMouseDown={(e) => e.preventDefault()}
          style={{
            left: geom ? geom.left : -9999,
            top: geom ? geom.top : -9999,
            width: geom ? geom.width : PANEL_MAX_WIDTH,
            maxHeight: geom ? geom.maxHeight : PANEL_MAX_HEIGHT,
            visibility: geom ? 'visible' : 'hidden',
          }}
        >
          {/* 隐藏测量盒已移到按钮旁（面板关着时也要能量宽度），这里不再放 */}
          <div className="mb-dd-list" ref={listRef}>
            {options.map((o, i) => {
              const isSel = o.value === value;
              const cls = 'mb-dd-item'
                + (i === active ? ' is-active' : '')
                + (isSel ? ' is-selected' : '')
                + (o.disabled ? ' is-disabled' : '');
              return (
                <div
                  key={`${o.value}#${i}`}
                  id={`${baseId}-opt-${i}`}
                  className={cls}
                  role="option"
                  aria-selected={isSel}
                  aria-disabled={o.disabled || undefined}
                  data-idx={i}
                  title={o.label}
                  onMouseEnter={() => { if (!o.disabled) setActive(i); }}
                  onClick={() => commit(i)}
                >
                  <span className="mb-dd-check" aria-hidden="true">{isSel ? <Check size={13} /> : null}</span>
                  <span className="mb-dd-text">{o.label}</span>
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

export default Dropdown;
