#!/usr/bin/env node
// setup-dsh.mjs — 安装/重装 qq-bridge 的 DSH 端配置到「内置隔离 DSH」。
//
// 默认目标：内置隔离 DSH home（自动探测：QQB_DSH_HOME 环境变量 → 项目
// QQ-Bridge\.runtime\dsh-isolated-home → manager 持久化的隔离 home）。
// 默认绝不写入桌面端 DSH（AppData\Roaming\DeepSeek Harness\dsh-home 与 ~/.dsh），
// 除非显式传 --desktop（仅在你知道要装桌面端时使用）。
//
// 用法：
//   node scripts/setup-dsh.mjs [--home <dir>] [--profile <p>] [--desktop] [--force]
import { installToIsolatedDsh, resolveDshTarget, DESKTOP_DSH_HOME } from '../src/lib/dsh-side.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const has = (name) => argv.includes(name);

async function main() {
  const home = flag('--home');
  const profile = flag('--profile') || undefined;
  const allowDesktop = has('--desktop');
  if (allowDesktop && !home) process.env.QQB_DSH_HOME = DESKTOP_DSH_HOME;
  else if (home) process.env.QQB_DSH_HOME = home;

  const t = resolveDshTarget({ profile, allowDesktopHome: allowDesktop });
  if (t.refusedDesktop) {
    console.error(`[setup-dsh] ERROR: ${t.error}`);
    process.exit(1);
  }
  if (!t.booted) {
    console.warn(`[setup-dsh] WARN: 隔离 DSH 尚未初始化 profiles/${t.profile}（${t.home}）。请先在 Manager 启动一次 dsh-isolated，再重跑本脚本。`);
    process.exit(0);
  }
  const r = await installToIsolatedDsh({ profile, allowDesktopHome: allowDesktop, force: has('--force') });
  if (!r.ok) process.exit(2);
}

main().catch((e) => {
  console.error(`[setup-dsh] ERROR: ${e?.stack || e?.message || e}`);
  process.exit(1);
});
