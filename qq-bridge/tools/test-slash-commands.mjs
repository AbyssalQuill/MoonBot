// 回归测试：斜杠指令的写法（2026-09-19 / 2026-09-24：斜杠指令只支持英文）
//   ① 全英文写法（含大写/多空格）被识别成同一条 /slang 指令（不会被丢给模型当普通消息）
//   ② 中英混写的 /slang 学习、/slang 停止 不再被当成学习指令（只回用法）
//   ③ 帮助文案里给的是全英文规范写法
//   ④ 非 /slang 的文本照旧 handled:false（不影响原有链路）
//   ⑦ /portrait 同一口径：只认 /portrait learn|stop|status；中文别名（画像学习 / 群友画像学习）、
//      中文子命令（学习 / 停止 / 状态）与简写（/portrait start、/portraitlearn）都不再被识别
//      （2026-09-24：斜杠指令只支持英文，删掉中文别名与历史简写）
// 用法：node tools/test-slash-commands.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-slash-'));
fs.cpSync(path.join(here, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-slash-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({
  ownerQQ: '123456789',
  dsh: { baseUrl: 'http://127.0.0.1:10721' },
  social: { enabled: true },
  allow: { private: ['123456789'], group: [] }, deny: { private: [], group: [] },
}, null, 2));

const url = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const cfgMod = await import(url('core/config.js'));
const modeMod = await import(url('core/mode.js'));
const slangMod = await import(url('core/slang.js'));
const cfg = cfgMod.loadConfig();
modeMod.initModeCore(cfg);
try { slangMod.initSlangCore?.(cfg); } catch { /* 可选 */ }

let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const handle = (text, ctx = { isOwner: false, kind: 'private' }) => slangMod.handleSlangSlashCommand(text, ctx);

// ① 各种写法的归一化结果（这就是代码里实际的比对方式：小写 + 连续空白压成一个空格）
const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
for (const [label, text, want] of [
  ['英文「/slang learn」', '/slang learn', '/slang learn'],
  ['全大写「/SLANG LEARN」', '/SLANG LEARN', '/slang learn'],
  ['多空格「/slang   learn」', '/slang   learn', '/slang learn'],
  ['英文「/slang stop」', '/slang stop', '/slang stop'],
  ['全大写「/SLANG STOP」', '/SLANG STOP', '/slang stop'],
  ['历史简写「/slanglearn」不再等同规范写法', '/slanglearn', '/slanglearn'],
]) check(`① ${label} 归一化正确`, norm(text) === want, `${norm(text)} vs ${want}`);

// ② 全英文写法都会被 /slang 处理器接住（非 owner 调用 → 只回权限提示，说明它没被当成普通消息）
for (const text of ['/slang learn', '/slang stop', '/slang']) {
  const r = await handle(text);
  check(`② ${text} 被识别为 /slang 指令（不交给模型）`, r.handled === true, JSON.stringify(r).slice(0, 80));
}

// ⑥ 历史简写不再被识别（2026-09-13：/slanglearn、/slangstop、无空格中文写法）
//    + 2026-09-19："去除 /slang 学习 这种中英混杂的指令" → 带中文子命令的也一并只回用法
for (const text of ['/slang学习', '/slang停止', '/slanglearn', '/slangstop', '/slang 学习', '/slang 停止']) {
  const r = await handle(text, { isOwner: true, kind: 'private' });
  const txt = (r.reply ?? []).join(' ');
  check(`⑥ ${text} 不再被当成学习指令（只回用法）`, r.handled === true && /黑话指令/.test(txt), txt.slice(0, 70));
}

// ③ 帮助文案是全英文的规范写法
const help = await handle('/slang', { isOwner: true, kind: 'other' });
const helpText = (help.reply ?? []).join(' ');
check('③ 帮助文案里是「/slang learn」', /\/slang learn/.test(helpText), helpText);
check('③ 帮助文案里是「/slang stop」', /\/slang stop/.test(helpText), helpText);
check('③ 帮助文案里不再出现中文子命令', !/\/slang 学习|\/slang 停止/.test(helpText), helpText);

// ④ 别的文本不受影响
for (const text of ['你好呀', '/status', '/portrait learn', '']) {
  const r = await handle(text);
  check(`④ ${JSON.stringify(text)} 不被黑话处理器接走`, r.handled === false, JSON.stringify(r));
}

// ⑦ /portrait：只认英文 learn|stop|status（2026-09-24：斜杠指令只支持英文）
{
  const portraitMod = await import(url('core/portrait-learn.js'));
  const portrait = (text, ctx = { isOwner: true, kind: 'private' }) => portraitMod.handlePortraitLearnCommand(text, ctx);
  const usageRe = /画像指令/;   // 用法文案：子命令一律英文

  // 英文规范写法：`/portrait` 与 `/portrait status` 都回当前状态（不是用法文案）
  for (const text of ['/portrait', '/portrait status', '/PORTRAIT   STATUS']) {
    const r = await portrait(text);
    const txt = (r.reply ?? []).join(' ');
    check(`⑦ ${text} 被识别为 /portrait 指令（回状态）`, r.handled === true && !usageRe.test(txt), txt.slice(0, 60));
  }

  // learn / stop 的英文写法被接住（非 owner 调用 → 只回权限提示，说明它没被当成普通消息）
  for (const text of ['/portrait learn', '/PORTRAIT  LEARN', '/portrait stop']) {
    const r = await portrait(text, { isOwner: false, kind: 'private' });
    const txt = (r.reply ?? []).join(' ');
    check(`⑦ ${text} 被识别为 /portrait 指令（非主人 → 只回权限提示）`, r.handled === true && /只有主人/.test(txt), txt.slice(0, 60));
  }

  // 中文子命令 + 历史简写 `/portrait start`：不再落到 learn/stop，只回用法
  for (const text of ['/portrait 学习', '/portrait 停止', '/portrait 状态', '/portrait start']) {
    const r = await portrait(text);
    const txt = (r.reply ?? []).join(' ');
    check(`⑦ ${text} 不再被当成学习/停止指令（只回用法）`, r.handled === true && usageRe.test(txt), txt.slice(0, 70));
  }

  // 中文别名 + 无空格简写：连 /portrait 前缀都不算，整条放行给模型
  for (const text of ['画像学习', '群友画像学习', '画像学习 learn', '/群友画像学习', '/portraitlearn']) {
    const r = await portrait(text);
    check(`⑦ ${JSON.stringify(text)} 不再被画像指令处理器接走`, r.handled === false, JSON.stringify(r));
  }

  // 用法文案里不出现中文子命令
  const help = await portrait('/portrait ?');
  const helpText = (help.reply ?? []).join(' ');
  check('⑦ 用法文案里是「/portrait learn|stop|status」', /\/portrait learn/.test(helpText) && /\/portrait stop/.test(helpText) && /\/portrait status/.test(helpText), helpText);
  check('⑦ 用法文案里不再出现中文子命令', !/\/portrait (学习|停止|状态|开始)/.test(helpText), helpText);
}

/* ── ⑤ /help 已删除（2026-09-13：不要《小鲸鱼能力概览》了）────────────────
 * 判据同时看两边：docx.js 不再导出 sendHelpDoc、mux.js 里不再有 /help 分支。
 * 这样"谁把它加回来"能被立刻发现（加回来会让 /help 又去发那个 docx）。 */
{
  const docxMod = await import(url('core/docx.js'));
  check('⑤ docx 模块不再导出 sendHelpDoc', typeof docxMod.sendHelpDoc === 'undefined');
  check('⑤ docx 模块不再导出 HELP_DOC_ASSET', typeof docxMod.HELP_DOC_ASSET === 'undefined');
  const muxSrc = fs.readFileSync(path.join(sandbox, 'src', 'core', 'mux.js'), 'utf8');
  const muxCode = muxSrc.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('⑤ mux 里不再有 /help 分支', !/'\/help'/.test(muxCode), (muxCode.match(/.*\/help.*/) || [''])[0].slice(0, 80));
  const withHelp = await handle('/help', { isOwner: true, kind: 'private' });
  check('⑤ /help 不再被桥特殊处理（按普通 /xxx 交给模型）', withHelp.handled === false, JSON.stringify(withHelp));
}

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 占用忽略 */ }
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
