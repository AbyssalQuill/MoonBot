// default沉睡/唤醒守卫的纯判断工具

// 显式收尾用语（“不聊了/晚安/去忙了…”）：命中即视为本轮对话已有明确结束信号。
export const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

// 最近一条“非自己发的”消息是否含显式收尾用语（用于判断是否可跳过沉睡前观察窗）
export function hasExplicitEnd(st) {
  const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
  const last = [...recent].reverse().find((m) => m && !m.isSelf);
  if (!last) return false;
  return EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
}

// 唤醒配置是否属于“沉睡/潜水”态：active 或 anyMessage 不算（需先观察），其余 diving 均视为沉睡
export function isSleepingConfig(wc) {
  if (!wc) return false;
  if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
  return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
}

// 归一化“指定群友发言唤醒”名单：
// - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
// - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
// - undefined/null 都视为“不启用”（空数组）。
export function normalizeSpeakerIds(value) {
  if (value === undefined || value === null) return [];
  const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
  const seen = new Set();
  const clean = [];
  for (const v of rawList) {
    const s = String(v ?? '').trim();
    if (!/^[1-9]\d*$/.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    clean.push(s);
    if (clean.length >= 20) break;
  }
  return clean;
}
