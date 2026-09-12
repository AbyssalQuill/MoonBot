// 共享：定位隔离 DSH home 与其 sessions 目录。
// 全部运行时推导（环境变量 / 管理器配置 / 当前用户主目录），
// 不写死任何盘符、安装路径或某个具体用户名 —— 换盘/换机/换用户都必须能用。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function isolatedDshHome() {
  const env = String(process.env.QQB_DSH_HOME || '').trim();
  if (env) return env;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.qq-bridge-manager', 'config.json'), 'utf8'));
    const h = cfg?.instances?.dshIsolated?.isolatedHome;
    if (h && fs.existsSync(h)) return h;
  } catch { /* 没有管理器配置就用默认位置 */ }
  return path.join(os.homedir(), '.qq-bridge-manager', 'dsh-isolated-home-official');
}

export const SESSIONS_ROOT = path.join(isolatedDshHome(), 'sessions');

/**
 * 返回最新改动的 session.jsonl.zstd。
 * DSH 的布局是两层：sessions/<workspace>--/session-<id>/session.jsonl.zstd
 * （workspace 目录名本身由桥的工作目录编码而来，所以换盘/换机后这一层名字会变，
 *  必须现场遍历，不能按名字拼。）
 */
export function newestSessionFile() {
  let best = null;
  const consider = (p) => {
    try {
      const st = fs.statSync(p);
      if (!best || st.mtimeMs > best.mtimeMs) best = { p, mtimeMs: st.mtimeMs };
    } catch { /* 没有这个文件 */ }
  };
  try {
    for (const ws of fs.readdirSync(SESSIONS_ROOT)) {
      const wsDir = path.join(SESSIONS_ROOT, ws);
      consider(path.join(wsDir, 'session.jsonl.zstd'));           // 一层（防御）
      let subs = [];
      try { subs = fs.readdirSync(wsDir); } catch { continue; }
      for (const s of subs) consider(path.join(wsDir, s, 'session.jsonl.zstd'));
    }
  } catch { /* sessions 目录不存在 */ }
  if (!best) throw new Error('在 ' + SESSIONS_ROOT + ' 下没找到任何 session.jsonl.zstd（先让隔离 DSH 跑起来）');
  return best.p;
}
