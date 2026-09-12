// 直接调用运行时里的 steerIntoRunningTurn，验证 TDZ 异常已消除。
//
// 为什么这个测试是有效的：TDZ 错误（`Cannot access 'sessionId' before initialization`）
// 发生在函数**开头几行**（闸门里引用了后面才声明的 sessionId），在 `apiRef` 等任何 I/O 之前。
// 所以只要这次调用**没有抛异常**，就说明闸门那几行已经能正常求值 —— 不管它最后返回什么。
// 期望结果：不抛异常，并在日志里留下 `[steer] 跳过 ...：不允许即时注入（...）`。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'wake-send.js')).href);

if (typeof mod.steerIntoRunningTurn !== 'function') {
  console.log('FAIL  没有导出 steerIntoRunningTurn');
  process.exit(1);
}

let threw = null;
let returned;
try {
  // force=true 会短路 allowed 判断，但闸门里那几行 const 声明**仍然会执行** —— 正是它们当初抛了 TDZ。
  returned = await mod.steerIntoRunningTurn('private:123456789', 'unit-test', { force: true });
} catch (error) {
  threw = error;
}

if (threw) {
  console.log('FAIL  仍然抛异常：' + (threw?.message ?? threw));
  process.exit(1);
}
console.log('PASS  未抛异常（闸门几行已能正常求值），返回 ' + JSON.stringify(returned));

// 顺带验证非 force 的路径也不会抛（那条路会走到 allowed=false 的日志分支）
let threw2 = null;
try {
  await mod.steerIntoRunningTurn('private:123456789', 'unit-test-no-force', {});
} catch (error) {
  threw2 = error;
}
if (threw2) {
  console.log('FAIL  非 force 路径抛异常：' + (threw2?.message ?? threw2));
  process.exit(1);
}
console.log('PASS  非 force 路径也未抛异常');
process.exit(0);
