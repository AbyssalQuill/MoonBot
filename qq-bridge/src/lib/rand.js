// 随机/概率纯函数

/**
 * [min, max] 闭区间随机整数（源自 bridge.js main 内 randInt@7214，含 min>max 守卫，行为 1:1）
 */
export function randInt(min, max) {
  if (min > max) [min, max] = [max, min];
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** 以概率 p 返回 true */
export function chance(p) {
  return p > 0 && Math.random() < p;
}
