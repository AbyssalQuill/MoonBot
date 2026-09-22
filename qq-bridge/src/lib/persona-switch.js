/**
 * 人设切换：**写 `qq-bridge/persona.md` 的唯一公共实现**。
 *
 * 【2026-09-22 主人报「不能切换人设 / skill 的 bug」·调查结论】
 *   模型侧**根本没有**写 persona.md 的路径：`qq_character_list/read/pack/search` 四个工具是纯只读；
 *   旧的 `/role <名字>` 命令读的是 `qq-bridge/roles/<名字>.md` + `current-role.json` 那套老机制，
 *   而项目里 `roles/` 目录压根不存在 → 主人说"换成 XX 角色"，无论私聊还是群里都只会得到
 *   "角色「XX」不存在"（或模型在上下文里即兴演，轮换/压缩之后立刻掉回默认人格）。
 *
 * 这个模块把整件事收成一件事：**从角色库挑一张卡 → 合成 → 原子写 persona.md（带备份）**。
 *   入口一：桥侧斜杠命令 `/role <包名>`（`core/mux.js`，主人专用；私聊与群里都能用）
 *   入口二：桥 console 的 `POST /api/persona/switch`（给模型侧工具 `qq_character_switch` 用，带主人校验）
 *
 * 生效链路（不需要重启、不打断在跑回合）：persona.md 的 `mtime:size` 版本号一变，
 * `core/wake-send.js` 在下一次唤醒时重新注入 `[PERSONA]`（见 wake-send.js 的 runtimeOverrideStamp
 * 与 `_promptOverrideStamp`），隔离 DSH 系统提示词里那份由 `lib/preset-compose.js` 的 10 秒轮询跟上。
 *
 * 上限与 `wake-send.js` 的运行时覆盖一致（16000 字符），超了如实截断并说明 —— 不静默丢内容。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteText } from './json-fs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');   // <bridge>/
export const PERSONA_PATH = path.join(ROOT, 'persona.md');
const DEFAULT_CHARACTERS_DIR = path.join(os.homedir(), 'Downloads', 'characters', 'characters');
const MAX_PERSONA_BYTES = 16000;
const BACKUP_KEEP = 5;

/** 卡片合成顺序。**先放"最要紧的两份"**：SKILL.md（可演的完整定义）与 ULTIMATE_ROLEPLAY_PROMPT（终极扮演提示词），
 *  再是 personality / profile / interaction / relations / conflicts / memory。
 *  为什么是这个顺序：超过 16000 字节上限时是**按顺序截断**的，把这两份放前面，保证"台词与性格"永远在，
 *  被切掉的只会是更细的档案与记忆（响应里 truncated=true，模型也会收到一行截断说明）。 */
const CARD_FILES = ['SKILL.md', 'ULTIMATE_ROLEPLAY_PROMPT.md', 'personality.md', 'profile.md', 'interaction.md', 'relations.md', 'conflicts.md', 'memory.md'];

/** 角色库根：`social.charactersDir` 优先；否则 ~/Downloads/characters/characters；再否则 <bridge>/characters。 */
export function charactersRoot(cfg) {
  const pick = (d) => { try { return d && fs.existsSync(d) && fs.statSync(d).isDirectory(); } catch { return false; } };
  const configured = String(cfg?.social?.charactersDir ?? '').trim();
  if (pick(configured)) return configured;
  if (pick(DEFAULT_CHARACTERS_DIR)) return DEFAULT_CHARACTERS_DIR;
  const shipped = path.join(ROOT, 'characters');
  if (pick(shipped)) return shipped;
  // 只有一个"父目录套角色目录"时往下走一层（与角色只读工具同一套回落规则）
  for (const base of [DEFAULT_CHARACTERS_DIR, shipped]) {
    try {
      const kids = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory());
      if (kids.length === 1) {
        const inner = path.join(base, kids[0].name);
        const grand = fs.readdirSync(inner, { withFileTypes: true }).filter((e) => e.isDirectory());
        if (grand.length) return inner;
      }
    } catch { /* 不存在就算了 */ }
  }
  return configured || DEFAULT_CHARACTERS_DIR;
}

/** 角色库里有哪些包（一个子目录 = 一个角色）与散装卡（根目录下的 .md）。 */
export function listCharacterPacks(cfg) {
  const root = charactersRoot(cfg);
  const packs = [];
  let loose = [];
  try {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      if (ent.isDirectory()) packs.push(ent.name);
      else if (/\.(md|txt)$/i.test(ent.name)) loose.push(ent.name);
    }
  } catch { /* 库不存在 → 空列表 */ }
  return { root, packs, loose };
}

/** 找一张卡的入口文件（SKILL.md → manifest.json → ULTIMATE_ROLEPLAY_PROMPT* → personality.md）。 */
function pickEntry(dir) {
  try {
    const files = fs.readdirSync(dir);
    const exact = ['SKILL.md', 'manifest.json', 'personality.md'];
    for (const n of exact) if (files.includes(n)) return n;
    const ult = files.filter((n) => /^ULTIMATE_ROLEPLAY_PROMPT.*\.md$/i.test(n)).sort().pop();
    if (ult) return ult;
    const md = files.filter((n) => /\.md$/i.test(n)).sort()[0];
    if (md) return md;
  } catch { /* 忽略 */ }
  return '';
}

/**
 * 把一张卡合成 persona.md 的正文。
 * @returns {{ok:boolean, text?:string, pack?:string, files?:string[], bytes?:number, truncated?:boolean, error?:string}}
 */
export function composePersona(cfg, character) {
  const want = String(character ?? '').trim();
  if (!want) return { ok: false, error: 'character 不能为空' };
  const root = charactersRoot(cfg);
  const dir = path.join(root, want);
  const isLoose = !fs.existsSync(dir);
  const filePath = isLoose ? path.join(root, want) : '';
  if (isLoose && !fs.existsSync(filePath)) return { ok: false, error: `角色库里没有「${want}」（库：${root}）` };

  const sections = [];   // { title, text }
  const used = [];
  let truncated = false;
  const add = (title, text) => {
    const t = String(text ?? '').trim();
    if (!t) return;
    sections.push({ title, text: t });
    if (title) used.push(title);
  };

  if (isLoose) {
    const text = readText(filePath);
    if (text === null) return { ok: false, error: `读不到 ${filePath}` };
    add('', text);
  } else {
    try {
      const mf = path.join(dir, 'manifest.json');
      if (fs.existsSync(mf)) {
        const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
        const nm = String(m?.name ?? '').trim();
        const sm = String(m?.summary ?? m?.description ?? '').trim();
        if (nm || sm) add('设定摘要', [nm, sm].filter(Boolean).join(' · '));
      }
    } catch { /* manifest 坏了不影响主流程 */ }
    // ULTIMATE_ROLEPLAY_PROMPT* 已经在 CARD_FILES 的第二位（要紧的先放），这里不再重复追加
    for (const f of CARD_FILES) {
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) continue;
      const text = readText(p);
      if (text === null) continue;
      add(f, text);
    }
    if (!used.length) {
      const entry = pickEntry(dir);
      if (!entry) return { ok: false, error: `角色包 ${want} 里没有可读的 .md/.txt 正文` };
      const text = readText(path.join(dir, entry));
      if (text === null) return { ok: false, error: `读不到 ${path.join(dir, entry)}` };
      add(entry, text);
    }
  }

  const header = `# 角色：${want}（由角色库切换，${new Date().toISOString().slice(0, 10)}）\n` +
    `以下这份就是你现在的人设与说话方式；与默认人格冲突时以这份为准。\n\n`;
  let text = header;
  const budget = MAX_PERSONA_BYTES - Buffer.byteLength(header, 'utf8');
  let bodyBytes = 0;
  for (const s of sections) {
    const block = `${s.title ? `## ${s.title}\n` : ''}${s.text}\n\n`;
    const size = Buffer.byteLength(block, 'utf8');
    if (bodyBytes + size > budget) {
      const room = budget - bodyBytes;
      if (room > 200) text += Buffer.from(block, 'utf8').subarray(0, room).toString('utf8');
      truncated = true;
      break;
    }
    text += block;
    bodyBytes += size;
  }
  if (truncated) text += `\n（注：角色卡超过 ${MAX_PERSONA_BYTES} 字符上限，已按顺序截断；台词与性格设定优先保留在前。）\n`;
  if (!text.trim()) return { ok: false, error: `角色包 ${want} 合成结果为空` };
  return { ok: true, text, pack: want, files: used, bytes: Buffer.byteLength(text, 'utf8'), truncated };
}

function readText(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > 512 * 1024) return null;
    return fs.readFileSync(p, 'utf8');
  } catch { return null; }
}

/** 清空人设（回到默认人格）。 */
export function clearPersona() {
  const text = '# PERSONA\n（未启用角色卡：按默认人格与发言规则说话，不要再演任何角色。）\n';
  const backup = backupPersona();
  atomicWriteText(PERSONA_PATH, text);
  return { ok: true, cleared: true, bytes: Buffer.byteLength(text, 'utf8'), backup };
}

function backupPersona() {
  try {
    if (!fs.existsSync(PERSONA_PATH)) return '';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(ROOT, `persona.backup-switch-${stamp}.md`);
    fs.copyFileSync(PERSONA_PATH, dest);
    // 只留最近 5 份，别把桥目录堆满
    const all = fs.readdirSync(ROOT).filter((n) => /^persona\.backup-.*\.md$/.test(n))
      .map((n) => ({ n, t: fs.statSync(path.join(ROOT, n)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const old of all.slice(BACKUP_KEEP)) { try { fs.unlinkSync(path.join(ROOT, old.n)); } catch { /* 忽略 */ } }
    return dest;
  } catch { return ''; }
}

/**
 * 切换人设。
 * @param {{cfg:object, character?:string, clear?:boolean}} args
 * @returns {{ok:boolean, action:'use'|'clear', pack?:string, files?:string[], bytes?:number, truncated?:boolean, backup?:string, error?:string}}
 */
export function switchPersona({ cfg, character = '', clear = false }) {
  try {
    const off = clear || /^(off|none|clear|default|默认|清除|关闭)$/i.test(String(character).trim());
    if (off) {
      const r = clearPersona();
      return { ok: true, action: 'clear', bytes: r.bytes, backup: r.backup };
    }
    const composed = composePersona(cfg, character);
    if (!composed.ok) return { ok: false, action: 'use', error: composed.error };
    const backup = backupPersona();
    atomicWriteText(PERSONA_PATH, composed.text);
    return {
      ok: true, action: 'use', pack: composed.pack, files: composed.files,
      bytes: composed.bytes, truncated: !!composed.truncated, backup,
    };
  } catch (e) {
    return { ok: false, action: 'use', error: String(e?.message ?? e) };
  }
}
