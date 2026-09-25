#!/usr/bin/env node
/* 把 server/index.js 里的 DEFAULT_SPEECH_RULES 模板重新生成为 qq-bridge/speech-rules.md 的逐字副本。
 *
 * 为什么要这个脚本：管理器上「恢复默认发言规则」写回的是这份内置模板，桥真正注入的是
 * speech-rules.md —— 两者必须一致，否则用户点一次恢复就把线上规则覆盖回旧版（2026-09-24
 * 之前两者已漂移过一次：模板 5911 字符的英文版 vs 文件里的中文版）。
 *
 * 用法：
 *   node tools/sync-speech-template.mjs           # 用 md 覆盖模板（写入 server/index.js）
 *   node tools/sync-speech-template.mjs --check   # 只校验是否一致，不一致退出码 1
 *
 * 模板里只需转义反引号与 ${（JS 模板字面量语法），其余逐字保留。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MD = join(ROOT, 'qq-bridge', 'speech-rules.md');
const JS = join(ROOT, 'server', 'index.js');
const MARKER = 'const DEFAULT_SPEECH_RULES = `';
const MAX = 12000; // 与 qq-bridge/src/core/wake-send.js 的 RUNTIME_OVERRIDE_MAX 对齐

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
const unesc = (s) => s.replace(/\\([`\\])/g, '$1').replace(/\\\$\{/g, '${');

/** 模板正文的起止（结束 = 其后第一个未被转义的 ` 紧跟 ;） */
function region(src) {
  const s = src.indexOf(MARKER);
  if (s < 0) throw new Error('没找到 DEFAULT_SPEECH_RULES');
  const from = s + MARKER.length;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '`' && src[i + 1] === ';') return { from, to: i };
  }
  throw new Error('没找到模板结尾');
}

const md = readFileSync(MD, 'utf8');
const src = readFileSync(JS, 'utf8');
const { from, to } = region(src);
const current = unesc(src.slice(from, to));
const check = process.argv.includes('--check');

if (current === md) {
  console.log('[sync-speech-template] 一致：模板与 speech-rules.md 逐字相同（' + md.length + ' 字符）');
} else if (check) {
  console.error('[sync-speech-template] 不一致：模板 ' + current.length + ' 字符 / 文件 ' + md.length + ' 字符');
  process.exit(1);
} else {
  writeFileSync(JS, src.slice(0, from) + esc(md) + src.slice(to), 'utf8');
  console.log('[sync-speech-template] 已同步：' + current.length + ' -> ' + md.length + ' 字符');
}

if (md.length > MAX) {
  console.error('[sync-speech-template] 超限：' + md.length + ' > ' + MAX + '，桥会截断注入（保留末尾 2500 字符）');
  process.exit(1);
}
