#!/usr/bin/env node
/**
 * check-scope.mjs —— 扫「模块里用了不存在的标识符」这一类真实事故缺陷。
 *
 * 为什么专门做这一个检查：这个项目历史上最致命的故障全是同一个成因 ——
 * 代码里用了一个没 import / 没声明的名字，JS 语法检查（node --check）完全看不出来，
 * 只在运行时那一刻才炸。真实日志（logs/bridge-local.log）里累计出现过 56 次：
 *   fs is not defined                 × 36   工具调用日志写入整条失败
 *   KNOWN_AGENT_TOKENS is not defined ×  7   QQ 发送直接失败
 *   bot is not defined                ×  5   带合并转发的消息必抛错
 *   ALARM_RE is not defined           ×  3   私聊链路全挂
 *   getSocialV2State is not defined   ×  2   收藏表情失败
 *   PEER_TYPING_HOLD_MAX_MS is not defined × 1  输入状态事件处理中断
 *   isCjkLikeChar is not defined      ×  1   发送质检崩溃
 *   kind is not defined               ×  1   qq_wait_for_messages 工具持续报错
 *
 * 做法：借 TypeScript 的 allowJs + checkJs 做静态分析（tsc 只当工具用，不是构建依赖），
 * 只保留两类高价值诊断，其它类型噪音全部过滤：
 *   TS2304 / TS2552  Cannot find name 'X'        → 未定义标识符
 *   TS1117          对象字面量重复键（后者静默覆盖前者）
 *
 * 用法：node scripts/check-scope.mjs        # 有问题退出码 1
 * 注意：需要能解析到 `typescript` 包（开发仓库根 node_modules 里有）。
 *       运行时/打包副本里没有 typescript 时会打印提示并以 0 退出（跳过，不算失败）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');
const EXCLUDE_DIRS = new Set(['vendor', 'node_modules', '.git']);

function loadTypeScript() {
  const req = createRequire(import.meta.url);
  try { return req('typescript'); } catch {}
  // 兜底：显式找几个常见位置（开发仓库根 / 全局）
  const cands = [
    path.resolve(HERE, '..', '..', 'node_modules', 'typescript'),
    path.resolve(HERE, '..', '..', '..', 'node_modules', 'typescript'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'typescript')
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return req(c); } catch {}
  }
  return null;
}

function collectJsFiles(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      collectJsFiles(path.join(dir, e.name), out);
    } else if (e.isFile() && e.name.endsWith('.js')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const ts = loadTypeScript();
if (!ts) {
  console.log('[check-scope] 未找到 typescript 包（运行时/打包副本属正常）。跳过静态作用域检查。');
  console.log('[check-scope] 想在本机跑：在含 typescript 的仓库根执行 node qq-bridge/scripts/check-scope.mjs');
  process.exit(0);
}

const files = collectJsFiles(SRC);
if (!files.length) {
  console.log(`[check-scope] ${SRC} 下没有 .js 文件，跳过。`);
  process.exit(0);
}

const options = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  skipLibCheck: true,
  strict: false,
  noImplicitAny: false,
  types: [],
  maxNodeModuleJsDepth: 0
};

const program = ts.createProgram(files, options);
const diagnostics = ts.getPreEmitDiagnostics(program);

// 只保留两类真实事故诊断；其它（缺 @types/node 造成的 TS2307/TS2591、联合类型推断噪音等）一律不报。
const KEEP = new Set([2304, 2552, 1117]);
const hits = [];
for (const d of diagnostics) {
  if (!KEEP.has(d.code)) continue;
  const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ');
  let where = '(未知位置)';
  if (d.file && d.start !== undefined) {
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    where = `${path.relative(path.resolve(HERE, '..'), d.file.fileName)}:${line + 1}:${character + 1}`;
  }
  hits.push({ where, code: d.code, msg });
}

if (!hits.length) {
  console.log(`[check-scope] OK —— 扫了 ${files.length} 个文件，没有未定义标识符 / 重复对象键。`);
  process.exit(0);
}

console.error(`[check-scope] 发现 ${hits.length} 处高危缺陷（这类问题 node --check 看不出来，只在运行时炸）：\n`);
for (const h of hits) {
  const kind = h.code === 1117 ? '重复对象键' : '未定义标识符';
  console.error(`  ${h.where}  [${kind}]  ${h.msg}`);
}
console.error('\n修法：把缺失的 import / 声明补上；重复键删掉多余的那个（后写的会静默覆盖前面的）。');
process.exit(1);
