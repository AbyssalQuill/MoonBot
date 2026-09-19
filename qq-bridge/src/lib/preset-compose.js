// 人设 / 发言规则 → 系统提示词（DSH agent preset）合成器。
//
// 【2026-09-19 主人要求】把「人设」「规则」「系统提示词」分成三层，并把**人设与发言规则合成进系统提示词**：
//   · 系统提示词（preset）只放规则：安全 / 工具 / 唤醒协议 / 内容边界 / 说话兜底 —— 全角色通用、不带任何角色特色，
//     避免"提示词打架"；**不含默认人设**（没有 [PERSONA] 时不扮演任何角色）。
//   · 人设（persona.md）保留角色特性，原样进 [PERSONA] 段。
//   · 发言规则（speech-rules.md）管"怎么打字"，原样进 [SPEECH RULES] 段。
//
// 为什么既写进 preset 又保留运行时注入（wake-send.js 的动态覆盖段）：
//   DSH 的 agentPreset **只在建会话那一刻绑定**。写进 preset 的版本能让**新会话**一建起来就带着人设；
//   而正在跑的会话（尤其开着「永久会话不轮换」时）拿不到新 preset，只能靠运行时那段覆盖 —— 两条路都留着，
//   改 persona.md / speech-rules.md 立刻对当前会话生效，新会话则直接从系统提示词里拿到。
//
// 幂等：带 BEGIN/END 标记，重复合成只替换标记之间那段；源模板改了（= 外面改系统提示词）也会被保留，
// 因为标记之外的内容原样不动。
import fs from 'node:fs';
import path from 'node:path';

export const COMPOSE_BEGIN = '      # === qq-bridge persona/rules BEGIN ===';
export const COMPOSE_END = '      # === qq-bridge persona/rules END ===';
/** preset 的 text: |- 块内缩进（6 空格），插入的每一行都必须带同样缩进，否则 YAML 会散架 */
const INDENT = '      ';
const NO_PERSONA_LINE = '(主人还没有上传人设：不要扮演任何角色，也不要自己编一个；就做那个说话直接、有判断、不谄媚的助手。)';
const NO_RULES_LINE = '(主人还没有写发言规则：按 [SPEECH - FALLBACK ONLY] 那一节打字。)';

function indentBlock(text, fallbackLine) {
  const body = String(text || '').replace(/\r\n/g, '\n').trim();
  const lines = body ? body.split('\n') : [fallbackLine];
  return lines.map((l) => (l.trim() ? INDENT + l.replace(/\s+$/, '') : ''));
}

/** 生成带标记的那段（缩进已就位） */
export function buildOverrideBlock({ persona = '', speechRules = '' } = {}) {
  return [
    COMPOSE_BEGIN,
    `${INDENT}[PERSONA]`,
    ...indentBlock(persona, NO_PERSONA_LINE),
    '',
    `${INDENT}[SPEECH RULES]`,
    ...indentBlock(speechRules, NO_RULES_LINE),
    COMPOSE_END,
  ].join('\n');
}

/** 把合成段插进 preset 文本（幂等）。纯函数，便于测试与"外面改了也能重算"。 */
export function composePresetText(text, opts = {}) {
  const src = String(text ?? '');
  const block = buildOverrideBlock(opts);
  const bi = src.indexOf(COMPOSE_BEGIN);
  const ei = src.indexOf(COMPOSE_END);
  if (bi >= 0 && ei > bi) return src.slice(0, bi) + block + src.slice(ei + COMPOSE_END.length);
  // 首次合成：插进 persona 插件那段 block scalar 的末尾 —— 也就是"下一个顶格行"之前。
  const anchor = src.indexOf('- id: persona');
  const from = anchor >= 0 ? anchor : 0;
  const tail = src.slice(from);
  const m = /\n(?=\S)/.exec(tail);
  const at = m ? from + m.index : src.length;
  return `${src.slice(0, at)}\n${block}${src.slice(at)}`;
}

/** 去掉合成段（给"源模板 vs 已安装版本"的比对用：两边都剥掉它就能直接比哈希）。
 *  首次插入时是在插入点补了一个换行再放 block，所以这里连那个换行一起删掉，剥完必须与原始文本逐字节相同。 */
export function stripOverrideBlock(text) {
  const src = String(text ?? '');
  const bi = src.indexOf(COMPOSE_BEGIN);
  const ei = src.indexOf(COMPOSE_END);
  if (bi < 0 || ei <= bi) return src;
  const cutFrom = bi > 0 && src[bi - 1] === '\n' ? bi - 1 : bi;
  return src.slice(0, cutFrom) + src.slice(ei + COMPOSE_END.length);
}

/** 读桥目录下的 persona.md / speech-rules.md（读不到当空，绝不抛） */
export function readOverrideFiles(root) {
  const read = (name) => {
    try { return fs.readFileSync(path.join(root, name), 'utf8').replace(/^\uFEFF/, ''); } catch { return ''; }
  };
  return { persona: read('persona.md'), speechRules: read('speech-rules.md') };
}

/** 人设 / 发言规则的"版本号"：每个文件 mtimeMs:size，`|` 分隔。
 *  【必须与 core/wake-send.js::runtimeOverrideStamp() 的格式逐字一致】——那边用它判断
 *  "唤醒正文里的那份是不是已经过时了"，这边用它记下"preset 里合成的是哪一版"。 */
export function overrideStampOf(root) {
  const one = (name) => {
    try { const s = fs.statSync(path.join(root, name)); return `${s.mtimeMs}:${s.size}`; } catch { return ''; }
  };
  return `${one('persona.md')}|${one('speech-rules.md')}`;
}

/** 当前**已合成进 preset**的人设/发言规则版本号（每次 syncPresetOverrides 时更新，含"内容没变"的情况）。
 *  见 core/wake-send.js 里的用法：一致就说明新会话的系统提示词里已经带着这一份，唤醒正文里不必重复。 */
let composedPersonaStamp = '';
export function getComposedPersonaStamp() { return composedPersonaStamp; }

/** 把 home 里已安装的 preset 重新合成一次（幂等；内容没变就不写盘） */
export function syncPresetOverrides({ home, root, log = () => {} } = {}) {
  const file = path.join(String(home || ''), '.agent-presets', 'default', 'agent.cordis.yml');
  if (!home || !fs.existsSync(file)) return { ok: false, error: `preset 不在：${file}` };
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, error: `读不到 ${file}：${e?.message ?? e}` }; }
  const { persona, speechRules } = readOverrideFiles(root);
  // 无论内容变没变，都记下"preset 里现在是哪一版" —— wake-send 靠它决定要不要求唤醒正文重复注入。
  composedPersonaStamp = overrideStampOf(root);
  const next = composePresetText(cur, { persona, speechRules });
  const info = { ok: true, file, changed: next !== cur, personaChars: persona.trim().length, speechChars: speechRules.trim().length };
  if (!info.changed) return info;
  try {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    return { ok: false, file, error: `写入 ${file} 失败：${e?.message ?? e}` };
  }
  log(`[preset] 人设 ${info.personaChars} 字 / 发言规则 ${info.speechChars} 字已合成进系统提示词`);
  return info;
}

/**
 * 盯住 persona.md / speech-rules.md：一改就重新合成（主人说"外面改系统提示词里面也要改"）。
 * 用 mtime+size 轮询（10 秒一次），不引 fs.watch（Windows 上 rename 语义不稳）。
 * @returns {() => void} 停止函数
 */
export function watchOverrideFiles({ home, root, log = () => {}, intervalMs = 10000 } = {}) {
  const stamp = () => {
    const one = (name) => {
      try { const s = fs.statSync(path.join(root, name)); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; }
    };
    return `${one('persona.md')}|${one('speech-rules.md')}`;
  };
  let prev = stamp();
  const timer = setInterval(() => {
    const now = stamp();
    if (now === prev) return;
    prev = now;
    try {
      const r = syncPresetOverrides({ home, root, log });
      if (r.ok && r.changed) log(`[preset] 检测到人设/发言规则变化：已重新合成（人设 ${r.personaChars} 字 / 规则 ${r.speechChars} 字）`);
      else if (!r.ok) log(`[preset] 重新合成失败：${r.error}`);
    } catch (e) { log(`[preset] 重新合成异常：${e?.message ?? e}`); }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
