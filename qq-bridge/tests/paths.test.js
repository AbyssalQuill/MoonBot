// 验证 lib 模块可加载且路径值与原语义一致
import { ROOT, STATE_DIR, STATE_FILE, LOCK_FILE } from '../src/lib/paths.js';
import { readJsonSafe, atomicWriteJson, atomicWriteText } from '../src/lib/json-fs.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

if (!ROOT.endsWith('qq-bridge')) throw new Error('ROOT 路径错误: ' + ROOT);
if (STATE_DIR !== join(ROOT, 'state')) throw new Error('STATE_DIR 错误');
if (LOCK_FILE !== join(STATE_DIR, 'bridge.lock')) throw new Error('LOCK_FILE 错误');
console.log('ROOT =', ROOT);
console.log('STATE_DIR =', STATE_DIR);
console.log('readJsonSafe/atomicWrite 类型:', typeof readJsonSafe, typeof atomicWriteJson, typeof atomicWriteText);
console.log('lib 加载与路径语义验证通过 ✓');
