/* 只读探针：向隔离 DSH 要"模型目录"（session/modelCatalog），确认每个模型**实际支持的推理档位**。
 *
 * 为什么需要它：桥给会话设视觉模型时带 reasoningEffort，档位不被服务商支持会直接
 * UNSUPPORTED_REASONING_EFFORT → session/model-unavailable → 会话模型切不过去（2026-09-13 踩过）。
 * 这个脚本把 DSH 自己认的档位清单打出来，用来核对"管理端选 max 到底行不行"。
 *
 * 用法（在仓库根目录）：
 *   node tools/probe-dsh-model-catalog.mjs
 *     → 打印各服务商各模型支持的档位
 *   node tools/probe-dsh-model-catalog.mjs --select <sessionId> --provider <pid> --model <id> [--effort <level>]
 *     → 对指定会话真的调一次 session/selectModel，验证某个档位能不能用
 *       （不带 --effort = 不传该参数，即"服务商默认档位"，正是桥里的兜底路径）
 * 环境变量：QBM_DSH_URL（默认 http://127.0.0.1:10721）、DSH_ISOLATED_LOG_FILE（取 token 用）
 */
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { NodeApiClient, unwrap } from '../qq-bridge/src/dsh-client.js';

const baseUrl = process.env.QBM_DSH_URL || 'http://127.0.0.1:10721';
const logFile = process.env.DSH_ISOLATED_LOG_FILE
  || path.join(os.homedir(), '.qq-bridge-manager', 'logs', 'dsh-isolated.log');
if (!existsSync(logFile)) console.warn(`[warn] DSH 日志不存在（可能取不到 token）：${logFile}`);

const api = new NodeApiClient(baseUrl, 15000, { dshLogFile: logFile });

/* --select 模式：对指定会话真的调一次 selectModel，验证档位是否被接受（会改该会话的模型选择）。 */
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sel = opt('--select');
if (sel) {
  const provider = opt('--provider');
  const model = opt('--model');
  const effort = opt('--effort');
  if (!provider || !model) { console.error('用法: --select <sessionId> --provider <pid> --model <id> [--effort <level>]'); process.exit(2); }
  console.log(`selectModel：${sel} -> ${provider}/${model}${effort ? ' @' + effort : '（不带档位参数 = 服务商默认）'}`);
  try {
    const r = unwrap(await api.sessions.selectModel({ sessionId: sel, provider, model, ...(effort ? { reasoningEffort: effort } : {}) }), 'session.selectModel');
    console.log('结果：成功 ->', JSON.stringify(r?.selected ?? r));
  } catch (e) {
    console.log('结果：失败 ->', e?.message ?? String(e));
    process.exitCode = 1;
  }
  // 不调 process.exit()：undici 的 keep-alive 连接还在收尾，硬退会触发
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) ... async.c"（噪音，但吓人）。
  // 让事件循环自然结束即可。
} else {
  const cat = unwrap(await api.sessions.modelCatalog(), 'session/modelCatalog');
  // 实际结构：{ default:{provider,model,reasoningEffort}, routableProviders:[…], groups:[{id,name,models:[…]}] }
  const groups = Array.isArray(cat?.groups) ? cat.groups : [];
  console.log(`服务商组数：${groups.length}  可路由：${(cat?.routableProviders ?? []).join(', ')}`);
  const d = cat?.default ?? {};
  console.log(`DSH 默认：${d.provider}/${d.model}${d.reasoningEffort ? ' @' + d.reasoningEffort : ''}`);

  for (const g of groups) {
    console.log(`\n[${g.id}] ${g.name ?? ''}`);
    for (const m of g.models ?? []) {
      const efforts = (m.reasoning?.efforts ?? []).map((e) => e.id);
      const def = m.reasoning?.defaultEffort;
      console.log(`  - ${m.id}`);
      console.log(`      支持档位: ${efforts.length ? efforts.join(', ') : '(无 reasoning 段 → 不支持档位参数，带了就报错)'}${def ? `   默认: ${def}` : ''}`);
    }
  }
}
