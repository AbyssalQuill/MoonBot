// 北京时间与时间文本纯函数（无运行态依赖）
// 注意：不再保留旧版「返回东八区时间戳」的数值版 beijingTs（该语义在运行时无消费方）。

/** 周名表：北京时间星期（BJ_WEEK[d.getUTCDay()]） */
export const BJ_WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 北京时间日期时间文本 "YYYY-MM-DD 周X HH:MM:SS"（源自 main beijingTs，1:1） */
export function beijingTs(tsMs) {
  const d = new Date(Number(tsMs) + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  // 星期几由北京时间日期精确计算（getUTCDay），不靠猜
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${BJ_WEEK[d.getUTCDay()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** 北京时间当日分钟数（0-1439）（源自 main bjMinutes，1:1） */
export function bjMinutes(now = Date.now()) {
  const d = new Date(now + 8 * 3600 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** 两位补零（独立纯函数，保留供工具使用） */
export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 将"分钟数（北京时间日分钟，允许跨日值）"格式化为 HH:MM（源自 main bjMinToText，1:1；负数不做归一化） */
export function bjMinToText(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 北京时间日期键 YYYY-MM-DD（源自 main beijingDateKey，1:1） */
export function beijingDateKey(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** "18:00"/"18点"/"01:00" → 分钟数；返回 null 表示无法解析（源自 main parseClockMin，1:1） */
export function parseClockMin(text) {
  const s = String(text ?? '').trim().replace(/[：:]/g, ':').replace(/点半/, ':30');
  let m = /^(\d{1,2})[:：点](\d{1,2})$/.exec(s) || /^(\d{1,2})点?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = m[2] !== undefined ? Number(m[2]) : 0;
  if (h > 47 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * 格式化北京时间 YYYY-MM-DD 周X HH:MM:SS（消息时间戳展示用）
 *
 * 【2026-09-20 主人要求：精确到秒，与 memory.db 的 chat_messages.ts 完全同形】
 * 原来是分钟精度（HH:MM）。主人在私聊里问"这个多久之前说的 / 你多久没回我"时，分钟精度不够：
 * 模型要么瞎猜，要么为了拿到准确时间**多花一步**去调 qq_get_recent_messages（那一步 = 再发一整份
 * 系统提示词与工具表）。sqlite 里 chat_messages.ts 本来就是 `YYYY-MM-DD 周X HH:MM:SS`（还有 ts_ms），
 * 唤醒正文与工具结果都对齐到同一个形状，模型看到的时间就能和库里逐条对上。
 * 形态直接复用 beijingTs（它本来就是秒精度），避免两处各写一份格式化。
 */
export function fmtBeijing(ts) {
  if (!ts) return '????-??-?? ??:??:??';
  return beijingTs(ts);
}
