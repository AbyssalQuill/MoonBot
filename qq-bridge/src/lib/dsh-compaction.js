// 上下文治理：把「压缩 / 工具结果剪枝」策略写进 DSH home 的 cordis.patch.yml（home 级 patch 层）。
//
// 【为什么要这么做 · 2026-09-19 主人要求"一个会话永久用下去，但别让上下文堆积，省掉切新会话的首轮 token"】
// 桥侧**不能**自己去删 DSH 的会话历史。依据（读过 DSH 0.1.2-rc.1 源码，不是猜的）：
//   · dsh-session：模型历史由内存日志 `deriveMessages()` 派生，文件只在冷恢复（load）时读 —— 改文件对
//     运行中的会话零影响；
//   · dsh-session-persistence-jsonl：日志是 seq 连续的仅追加记录，删行会撞 `corrupt session log: seq gap`；
//     且默认 zstd 帧带校验和，正文一改就校验失败；
//   · 它自己也写明「每个会话一个活动写入方」，外部同时写会互相踩。
// 受支持的裁剪路径只有一条：**由 DSH 自己**通过 surface `replace` 改写历史 —— 也就是
// `dsh-compaction-tool-result-pruner`（剪枝）与 `dsh-compaction-basic`（摘要）。两者都只吃 cordis 配置行，
// 没有 settings.yaml 通道，所以这里把配置行写进 **home 级 `$DSH_HOME/cordis.patch.yml`**：
//   · 配置层顺序是 bundles → profile 的 cordis.patch.yml → **home 级 cordis.patch.yml** → --patch，
//     写 home 级不会碰到装着 MCP 挂载的 profile 那份；
//   · profile 的 `patchReload: live` 会**同时监视 home 级 patch 文件** → 改完不必重启 DSH；
//   · 用 BEGIN/END 标记包起来，只替换标记之间那段，home 级文件里别的内容（用户自己的 overlay）原样保留。
//
// 【两个必须守住的硬约束（否则插件会拒绝加载，DSH 起不来）】
//   ① compaction-basic：`retainRatio`（或 retainTokens）必须 **小于** thresholdRatio 解析出的阈值；
//   ② tool-result-pruner：`headChars + 标记 + tailChars ≤ thresholdChars`（标记是 "\n\n[... tool result middle pruned ...]\n\n"）。
// 本模块的归一化函数保证这两条永远成立，并在被夹紧时写日志说明。
import fs from 'node:fs';
import path from 'node:path';

export const COMPACTION_BEGIN = '# === qq-bridge compaction BEGIN ===';
export const COMPACTION_END = '# === qq-bridge compaction END ===';
/** 与 dsh-compaction-tool-result-pruner 里的 PRUNE_MARKER 逐字一致（用于校验预算） */
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n';

/** 摘要请求的输出上限（默认值同 DSH 的 8192，这里收紧到 4096：摘要本身不该吃太多输出 token） */
const SUMMARY_MAX_TOKENS = 4096;
/** 剪枝预算的下限：低于它就会出现"保留的比标记还短"，没有意义 */
const MIN_TOOL_RESULT_CHARS = 300;

/** 把任意配置值夹成合法的压缩策略（纯函数；返回值即可直接生成 YAML 的那组数字） */
export function normalizeCompaction(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const notes = [];
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  // 阈值比例：0.005 ~ 0.5（>0.5 等于没治理；<0.005 在 1M 窗口上约 5k token，太碎）
  let thresholdRatio = Math.min(0.5, Math.max(0.005, num(src.thresholdRatio, 0.06)));
  if (thresholdRatio !== num(src.thresholdRatio, 0.06)) notes.push(`thresholdRatio 被夹到 ${thresholdRatio}`);
  // 逐字保留比例：必须在 (0, thresholdRatio) 开区间内 —— DSH 加载期会校验 retainRatio < thresholdRatio
  const wantRetain = num(src.retainRatio, 0.012);
  let retainRatio = Math.min(thresholdRatio * 0.9, Math.max(0.0005, wantRetain));
  if (retainRatio >= thresholdRatio) { retainRatio = thresholdRatio * 0.2; notes.push(`retainRatio 被夹到 ${retainRatio}`); }
  else if (retainRatio !== wantRetain) notes.push(`retainRatio 被夹到 ${retainRatio}`);
  // 工具结果预算：整数、≥300；head=60%、tail=20%，剩下 20% 留给剪枝标记
  let toolResultMaxChars = Math.round(num(src.toolResultMaxChars, 1500));
  if (toolResultMaxChars < MIN_TOOL_RESULT_CHARS) { toolResultMaxChars = MIN_TOOL_RESULT_CHARS; notes.push(`toolResultMaxChars 被夹到 ${toolResultMaxChars}`); }
  let headChars = Math.floor(toolResultMaxChars * 0.6);
  let tailChars = Math.floor(toolResultMaxChars * 0.2);
  // 兜底：万一标记比预留的还长（DSH 改了标记），就把预算抬到"头尾 + 标记"之上
  const emitted = headChars + PRUNE_MARKER.length + tailChars;
  if (emitted > toolResultMaxChars) {
    toolResultMaxChars = emitted + 32;
    headChars = Math.floor(toolResultMaxChars * 0.6);
    tailChars = Math.floor(toolResultMaxChars * 0.2);
    notes.push(`toolResultMaxChars 被抬到 ${toolResultMaxChars}（标记长度 ${PRUNE_MARKER.length}）`);
  }
  const str = (v) => String(v ?? '').trim();
  return {
    enabled: src.enabled !== false,
    thresholdRatio,
    retainRatio,
    toolResultMaxChars,
    headChars,
    tailChars,
    summarizationProvider: str(src.summarizationProvider),
    summarizationModel: str(src.summarizationModel),
    notes,
  };
}

/** 生成 compaction 那两行 cordis 配置（纯函数；跨平台换行统一 \n） */
export function buildCompactionRows(p) {
  const lines = [];
  /* 【2026-09-19 实测踩坑：web profile 下这两行默认是**禁用**的，必须显式 disabled: false】
   * 依据：`dsh-web-app/cordis.patch.yml`（装在 node_modules 里，与线上同一份）把
   * `compaction-basic` / `tool-result-pruner` / `command-compact` 都写成 `disabled: true`
   * （原文注释说这些行归 host plane 所有）——而机器人用的正是 **web profile**。
   * 后果（真机复现）：配置写得再对，自动压缩也一次都不跑：
   *   · 本机隔离 home 的 86 个会话日志里 `compaction/*` 事件 0 条；
   *   · 我另起一个 web 实例、塞进 37k 字符的工具结果（压力 2.7 万 token，阈值才 1572），
   *     日志里依旧一条 prune 都没有；
   *   · 同样的配置在 headless profile 下**立刻**剪枝。
   * 补上 `disabled: false` 后立刻复现成功（真机验证：37k 字符的工具结果被剪成 1239 字符，
   * 剪枝后压力降到阈值以下 → 跳过摘要、聊天记录一字未动）。
   * 所以这两行必须带 `disabled: false`：它是"把 web profile 里被关掉的那两行重新打开"的唯一开关。 */
  lines.push('- id: compaction-basic');
  lines.push('  disabled: false');
  lines.push('  config:');
  lines.push('    auto: true');
  lines.push(`    thresholdRatio: ${p.thresholdRatio}`);
  lines.push(`    retainRatio: ${p.retainRatio}`);
  lines.push(`    maxTokens: ${SUMMARY_MAX_TOKENS}`);
  lines.push('    compactionRetries: 1');
  lines.push('    maxOverflowRetries: 1');
  if (p.summarizationProvider && p.summarizationModel) {
    lines.push(`    summarizationProvider: '${p.summarizationProvider.replace(/'/g, "''")}'`);
    lines.push(`    summarizationModel: '${p.summarizationModel.replace(/'/g, "''")}'`);
  }
  lines.push('- id: tool-result-pruner');
  lines.push('  disabled: false');
  lines.push('  config:');
  lines.push(`    thresholdChars: ${p.toolResultMaxChars}`);
  lines.push(`    headChars: ${p.headChars}`);
  lines.push(`    tailChars: ${p.tailChars}`);
  return lines.join('\n');
}

/** 生成要写进 cordis.patch.yml 的整段（带标记；关掉时只留标记和一句说明） */
export function buildCompactionBlock(rawCfg) {
  const p = normalizeCompaction(rawCfg);
  const head = [
    COMPACTION_BEGIN,
    '# 由 qq-bridge 自动维护（lib/dsh-compaction.js）：这段之内的内容每次启动/改配置都会重写，',
    '# 手改会被覆盖；想长期自定义就改 qq-bridge/config.json 的 dshCompaction 段。',
  ];
  if (!p.enabled) {
    head.push('# 当前 dshCompaction.enabled=false → 不覆盖 DSH 默认（默认要等上下文用到窗口 80% 才压缩）。');
    head.push(COMPACTION_END);
    return { text: head.join('\n'), values: p };
  }
  head.push(`# 策略：上下文用到窗口的 ${(p.thresholdRatio * 100).toFixed(1)}% 就开始治理：先剪掉超过 `
    + `${p.toolResultMaxChars} 字的工具结果（不发模型请求、聊天不动），仍超阈值才把最老一段摘要；`
    + `最近 ${(p.retainRatio * 100).toFixed(1)}% 的上下文逐字保留。`);
  if (p.notes.length) head.push(`# 归一化调整：${p.notes.join('；')}`);
  return { text: [...head, buildCompactionRows(p), COMPACTION_END].join('\n'), values: p };
}

/**
 * 把 compaction 段合并进 home 级 cordis.patch.yml 的文本（纯函数）。
 * @returns {{text:string, changed:boolean, existed:boolean}}
 */
export function mergeCompactionIntoPatch(curText, rawCfg) {
  const { text: block } = buildCompactionBlock(rawCfg);
  const cur = String(curText ?? '');
  if (cur.trim() === '') {
    const header = [
      '# DSH home 级 patch（作用于本 home 下所有 profile）',
      '# 用户自己的 overlay 写在下面即可；qq-bridge 只维护带 BEGIN/END 标记的那一段。',
      '',
    ].join('\n');
    return { text: `${header}${block}\n`, changed: true, existed: false };
  }
  const beginIdx = cur.indexOf(COMPACTION_BEGIN);
  const endIdx = cur.indexOf(COMPACTION_END);
  if (beginIdx >= 0 && endIdx > beginIdx) {
    const before = cur.slice(0, beginIdx);
    const after = cur.slice(endIdx + COMPACTION_END.length);
    const next = `${before}${block}${after}`;
    return { text: next, changed: next !== cur, existed: true };
  }
  const sep = cur.endsWith('\n') ? '' : '\n';
  const next = `${cur}${sep}\n${block}\n`;
  return { text: next, changed: true, existed: true };
}

/**
 * 真正落盘：读 <home>/cordis.patch.yml → 合并 → 原子写回。
 * @param {{home?:string, cfg?:object, log?:(m:string)=>void}} opts
 *        home 缺省用 resolveIsolatedDshHome()（环境变量 QQB_DSH_HOME/DSH_ISOLATED_HOME → 管理器配置 → 默认目录）
 * @returns {{ok:boolean, path:string, changed:boolean, values?:object, error?:string, home?:string}}
 */
export function syncDshCompactionPatch(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  /* 允许传整份 cfg 或只传 dshCompaction 段（两种调用都见过，别让它成为坑） */
  const rawCfg = (opts.cfg && typeof opts.cfg === 'object' && opts.cfg.dshCompaction) ? opts.cfg.dshCompaction : (opts.cfg ?? {});
  const home = String(opts.home || '').trim();
  if (!home) return { ok: false, path: '', changed: false, home: '', error: '没有拿到隔离 DSH home（QQB_DSH_HOME / 管理器配置都没给出）' };
  const file = path.join(home, 'cordis.patch.yml');
  let cur = '';
  try {
    if (fs.existsSync(file)) cur = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, path: file, changed: false, home, error: `读不到 ${file}：${e?.message ?? e}` };
  }
  const merged = mergeCompactionIntoPatch(cur, rawCfg);
  const values = normalizeCompaction(rawCfg);
  if (!merged.changed) return { ok: true, path: file, changed: false, values, home };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, merged.text, 'utf8');
    fs.renameSync(tmp, file);            // 原子替换：DSH 的 patch 监视不会读到半个文件
  } catch (e) {
    return { ok: false, path: file, changed: false, values, home, error: `写入 ${file} 失败：${e?.message ?? e}` };
  }
  return { ok: true, path: file, changed: true, values, home };
}
