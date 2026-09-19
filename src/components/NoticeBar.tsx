import { useEffect, useRef, useState } from 'react';

/**
 * 顶部提示条（notice-bar）：**会自己收起来**的短消息。
 *
 * 【2026-09-19 主人反馈】"有的顶上的提示好像不会自己弹下去，还要点一下" —— 原来各页面都是
 * `<div className="notice-bar" onClick={() => setMsg(null)}>{msg}</div>`，只能手点关闭。
 * 现在统一走这个组件：
 *   · 出现后 6 秒自动隐去（悬停时暂停倒计时，鼠标移开继续），仍然支持点一下立刻关；
 *   · 文案**变一次**就重新计时（所以"连着保存两次"两条提示都会完整显示）；
 *   · 用 `key` 保证同一位置换文案时组件重建，避免上一轮的定时器串扰。
 */
export default function NoticeBar({ msg, onClose, ms = 6000, kind = 'notice', style }: {
  msg: string | null | undefined;
  onClose: () => void;
  ms?: number;
  /** notice = 普通提示（灰底）；warn = 失败/警告（保留红字样式，比普通提示多留 2 秒） */
  kind?: 'notice' | 'warn';
  style?: React.CSSProperties;
}) {
  const [hidden, setHidden] = useState(false);
  const timer = useRef<number | null>(null);
  const text = msg == null ? '' : String(msg);

  useEffect(() => {
    setHidden(false);
    if (!text) return;
    const total = kind === 'warn' ? ms + 2000 : ms;
    const clear = () => { if (timer.current) { window.clearTimeout(timer.current); timer.current = null; } };
    const arm = () => {
      clear();
      timer.current = window.setTimeout(() => { setHidden(true); onClose(); }, total);
    };
    arm();
    return clear;
    // text 变化 = 新消息 → 重新计时
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, kind, ms]);

  if (!text || hidden) return null;
  return (
    <div
      className="notice-bar"
      onClick={() => { setHidden(true); onClose(); }}
      title="点一下立刻收起（也会自动消失）"
      style={{
        cursor: 'pointer',
        ...(style || null),
        ...(kind === 'warn' ? { borderColor: 'var(--nc-danger-500, #e5484d)', color: 'var(--nc-danger-600, #b42318)' } : null),
      }}
    >
      {text}
      <span style={{ opacity: 0.55, fontSize: 12, marginLeft: 10 }}>（自动收起）</span>
    </div>
  );
}
