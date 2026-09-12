// 纯工具库：任何模块都可以 import 的零状态函数。
// 约定：不得读取 bridge 运行态（state/config/sessions/ws/log）；只依赖入参与 node 内建。
// 用于承接 bridge.js 中 main() 内部与模块级真正无副作用的纯函数。
export { BJ_WEEK, beijingTs, pad2, bjMinToText, bjMinutes } from './time.js';
export { randInt, chance } from './rand.js';
export { clamp, lerp } from './math.js';
export { splitCjk, isCjkChar } from './cjk.js';
