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
 * 格式化北京时间 YYYY-MM-DD 周X HH:MM（消息时间戳展示用）
 *
 * 2026-09-20：给人看的时间保持分钟精度，不要秒。
 * 中途试过精确到秒（对齐 memory.db 的 chat_messages.ts），确认后定稿"不需要带秒"：
 * 唤醒正文里的每一行消息、[Status]、工具结果都会带时间，秒级数字只占字符不提信息量。
 * 需要"精确到毫秒"的只有一处 —— 唤醒的 `[Now]` 行，那里单独附 epochMs（见 wake-send.js），
 * 模型要算"多久之前"用 epochMs 减去消息行的 ts_ms 即可，不需要把秒铺满整段正文。
 */
export function fmtBeijing(ts) {
  if (!ts) return '????-??-?? ??:??';
  const d = new Date(Number(ts) + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  // 星期几由北京时间日期精确计算（getUTCDay），不靠猜
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${BJ_WEEK[d.getUTCDay()]} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
