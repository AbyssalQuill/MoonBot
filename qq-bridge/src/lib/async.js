// 异步小工具

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 带超时的 Promise：超时后 reject，随后清理定时器
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
