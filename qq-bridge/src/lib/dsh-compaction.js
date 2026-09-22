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
/* 【2026-09-19 / 2026-09-20 三次实测逼出来的下限（0.08）】
 * ① 2026-09-19：阈值曾被写成 **0.005**（窗口的 0.5%）→ 上下文刚到 ~5k token 就压缩，等于每轮都压；
 * ② 2026-09-20 上午：阈值 0.06，可**固定开销就有 2.75 万 token**（system 5.36 万字符 + 78 个工具
 *    8.11 万字符），加上历史，62.9k 的阈值被顶穿 → 114 个模型步触发 46 次摘要，每步之间多花 15~20 秒；
 * ③ 2026-09-20 晚：阈值抬到 0.12 后不再每步压缩，但上下文长期停在 ~11.7 万 token，主人实测
 *    **"一句话 1 分钱，不划算"** —— 于是收到 0.08。
 * ④ **2026-09-22 第四次重算（新提示词下）：按上下文区间分桶才发现，③ 那次把"冷启动/压缩后重建"
 *    和"上下文大"混在了一个桶里。** 实测（主聊天 4,659 次请求 / 11.2 天）：
 *      上下文 0~30k   → 每次 ¥0.0382，其中 49.8% 是大未命中（= 刚重建完的那些请求）
 *      上下文 50~70k  → 每次 ¥0.0033；70~90k → ¥0.0043；90~120k → ¥0.0040；120~160k → ¥0.0051
 *    50k 以上回归出：**每次 = ¥0.0020 + 0.022 ¥/M × 上下文** —— 上下文本身几乎只按缓存命中价计费，
 *    真正的开销是"压缩后第一次请求要整段重读"（实测 ≈ ¥0.036/次，频率 ∝ 1/阈值）。
 *    ⇒ 最省的是**少压缩**：0.08 → ¥3.34/天、0.12 → ¥2.67、**0.16 → ¥2.53**、0.18 → ¥2.53、0.25 → ¥2.66
 *    （模型在 0.08 处 vs 实测只差 −4%，可作标定）。因此缺省值改成 0.16，稳健区间 0.14~0.20。
 * 结论：**下限仍是 0.08**（低于它会被固定开销顶穿 → 每一步都压缩，见 ② 的 114 步 46 次），
 *       缺省值取 0.16。判据：`thresholdRatio × 模型窗口` 要明显大于固定开销，同时大于
 *       `固定开销 + 保留量`，否则会"压完立刻又压"。复算脚本 tools/compaction-threshold.mjs。 */
const MIN_THRESHOLD_RATIO = 0.08;

/** 缺省阈值比例（2026-09-22 第四次重算的最省值，见上面 ④）。 */
const DEFAULT_THRESHOLD_RATIO = 0.16;

/** 把任意配置值夹成合法的压缩策略（纯函数；返回值即可直接生成 YAML 的那组数字） */
export function normalizeCompaction(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const notes = [];
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  // 阈值比例：0.08 ~ 0.5（>0.5 等于没治理；<0.08 会被固定开销顶穿 → 每一步都压缩，见上面的四次实测）
  let thresholdRatio = Math.min(0.5, Math.max(MIN_THRESHOLD_RATIO, num(src.thresholdRatio, DEFAULT_THRESHOLD_RATIO)));
  if (thresholdRatio !== num(src.thresholdRatio, DEFAULT_THRESHOLD_RATIO)) {
    notes.push(`thresholdRatio 被夹到 ${thresholdRatio}（低于 ${MIN_THRESHOLD_RATIO} 会被固定开销顶穿 → 每一步都压缩，只会更慢更贵）`);
  }
  // 逐字保留比例：必须在 (0, thresholdRatio) 开区间内 —— DSH 加载期会校验 retainRatio < thresholdRatio
  const wantRetain = num(src.retainRatio, 0.02);
  let retainRatio = Math.min(thresholdRatio * 0.9, Math.max(0.0005, wantRetain));
  if (retainRatio >= thresholdRatio) { retainRatio = thresholdRatio * 0.2; notes.push(`retainRatio 被夹到 ${retainRatio}`); }
  else if (retainRatio !== wantRetain) notes.push(`retainRatio 被夹到 ${retainRatio}`);
  // 小数位收敛：0.005*0.9 会算出 0.0045000000000000005 这种值写进 YAML（难看且容易被误读）
  retainRatio = Math.round(retainRatio * 1e6) / 1e6;
  // 工具结果预算：整数、≥300；head=60%、tail=20%，剩下 20% 留给剪枝标记
  // 缺省 8192（与 DSH 插件默认一致）：整段 qq_get_prompt 协议 / 状态快照都能完整留下；
  // 以前缺省 1500 会把它们剪成 900+300，模型只看到零头（2026-09-19 主人反馈后改）。
  let toolResultMaxChars = Math.round(num(src.toolResultMaxChars, 8192));
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
  /* 【2026-09-19 主人要求】摘要一律用**会话主模型 / 全局服务商** —— 不再支持单独指定
     summarizationProvider / summarizationModel。理由：单独换一个服务商意味着摘要请求要走另一条额度与
     另一份缓存，实测省不下钱还多一处要配的凭据；老配置里若还留着这两个键，这里只提示、不再写进 patch。 */
  if (str(src.summarizationProvider) || str(src.summarizationModel)) {
    notes.push('已忽略 summarizationProvider/summarizationModel：摘要统一用主模型（全局语言模型服务商）');
  }
  return {
    enabled: src.enabled !== false,
    thresholdRatio,
    retainRatio,
    toolResultMaxChars,
    headChars,
    tailChars,
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
  /* 不写 summarizationProvider / summarizationModel：留空 = 跟主模型（复用同一服务商与提示词缓存）。
     2026-09-19 主人要求统一用全局语言模型服务商，改这里（lib/dsh-compaction.js）时别再加回来。 */
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
