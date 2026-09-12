// 单文件行数门禁：重构期间跟踪 bridge.js 是否真正在变小（而非改名式搬家）。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'src', 'bridge.js');
const lines = readFileSync(target, 'utf8').split('\n').length;
console.log(`bridge.js 当前行数: ${lines}`);
if (lines > 4000) {
  console.log('提示: 仍为巨型单文件，继续 P1→P3 拆分（本提示不视为失败）。');
} else {
  console.log('OK: bridge.js 已收敛到可维护规模。');
}
