// SQLite FTS5（trigram）检索的两个纯工具函数。
//
// 2026-09-24 从 core/memory.js 抽出来：聊天记录迁到独立库（state/chat.db）之后，
// memory.js（记忆条目）与 chat-db.js（聊天记录）都要「探索引是否可用」和「把自然语言
// 变成 FTS 查询串」。两份实现必然漂移（一处改了分词规则另一处忘改 → 只有一半检索走 BM25，
// 而症状只是"搜不到"，不报错），所以规则只留这一份。
//
// 为什么是 trigram：中文没有词边界，trigram 用"三字滑窗"建索引，中文子串照样命中，
// 不需要分词器；BM25 天然给出相关性排序。代价是 token 必须 ≥ 3 字符（见 ftsQueryOf）。

/** 全文索引可用吗（FTS5 表存在且能查）。不可用时调用方退回 LIKE：功能不消失、只是慢。 */
export function ftsUsable(db, name) {
  try { db.prepare(`SELECT rowid FROM ${name} LIMIT 1`).get(); return true; } catch { return false; }
}

/**
 * 把用户/模型给的一段自然语言变成 FTS5 查询串。
 * trigram 分词器要求每个 token ≥ 3 个字符：不足 3 字的碎片会被 FTS5 直接拒绝（返回空），
 * 所以这里拆成"够长的词"分别 OR，并把双引号去掉（避免语法错误）。
 * 返回 '' 表示"没法用 FTS 查"→ 调用方退回 LIKE（单字/两字查询就是这条路）。
 */
export function ftsQueryOf(text) {
  const raw = String(text ?? '').replace(/["']/g, ' ').trim();
  if (!raw) return '';
  const parts = raw.split(/[\s,，。;；、:：!！?？()（）\[\]【】/\\|+*^-]+/).map((s) => s.trim()).filter((s) => s.length >= 3);
  if (!parts.length) return '';
  // 最多 8 个词：词越多越贵，且后面几个基本不改变排序
  return parts.slice(0, 8).map((p) => `"${p}"`).join(' OR ');
}
