// 引用上下文回归：模型看到的那一行必须带上被引用的原文（主人 2026-09-21 反馈：
// 私聊里引用一条消息，机器人答"查不到 / 拿不到引用内容"——落库是对的，最后一跳丢了）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = path.join(process.cwd(), 'src');
const sandbox = path.join(process.cwd(), 'tests', `.tmp-quote-context-${process.pid}`);
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.cpSync(SRC, path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-quote-context', private: true, type: 'module' }));

const cfg = {
  ownerQQ: '1736784911',
  consolePort: 3998,
  napcat: { httpUrl: 'http://127.0.0.1:1', accessToken: '' },
  dsh: { baseUrl: 'http://127.0.0.1:1' },
  allow: {}, deny: {}, allowAllWhenEmpty: true,
  social: { tools: {}, send: { linearEnabled: false }, wake: {} },
};
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify(cfg, null, 2));

const url = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const socialState = await import(url('core/social-state.js'));
socialState.initSocialCore(cfg);
const modeMod = await import(url('core/mode.js'));
modeMod.initModeCore(cfg);
const wake = await import(url('core/wake-send.js'));
wake.initWakeCore(cfg);

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass += 1; console.log(`  PASS ${name}`); } catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); } };

const KEY = 'private:1736784911';

t('① unreadBody：有引用时给出「[引用 谁：原文] + 他说的话」', () => {
  const m = {
    sender: '群魅魔',
    plain: '你说这个，我本来就养了你一个',
    text: '[引用 DeepSeek Harness：这就是你养的那群吗 ᗜ ‸ ᗜ]你说这个，我本来就养了你一个',
  };
  const body = wake.unreadBody(m, 200);
  assert.match(body, /^\[引用 DeepSeek Harness：这就是你养的那群吗/);
  assert.match(body, /你说这个，我本来就养了你一个/);
});

t('② unreadBody：没有引用时与旧行为完全一致（plain 优先，不加料）', () => {
  const m = { plain: '行', text: '行' };
  assert.equal(wake.unreadBody(m, 200), '行');
  const m2 = { plain: '', text: '只有 text' };
  assert.equal(wake.unreadBody(m2, 200), '只有 text');
  assert.equal(wake.unreadBody(undefined, 200), '');
});

t('③ unreadBody：超长引用先掐引用、保住正文，总长有上限', () => {
  const longQuote = `[引用 某人：${'啊'.repeat(300)}]正文在这里`;
  const body = wake.unreadBody({ plain: '正文在这里', text: longQuote }, 60);
  assert.ok(body.includes('正文在这里'), '正文不能被引用挤掉');
  assert.ok(body.length <= 60 + 140 + 4, `总长应受控，实际 ${body.length}`);
});

t('④ 首轮唤醒的 [Status] 行带上引用原文（"这一步该答哪条"的指针）', () => {
  const st = socialState.getSocialState(KEY);
  st._promptInjected = false;
  st.unread = [{
    seq: 1, userId: '1736784911', sender: '群魅魔', isOwner: true, messageId: '779625557',
    time: Date.now(), atSelf: false, hasMedia: false, hasFile: false,
    plain: '你说这个，我本来就养了你一个',
    text: '[引用 DeepSeek Harness：这就是你养的那群吗 ᗜ ‸ ᗜ]你说这个，我本来就养了你一个',
  }];
  const prompt = wake.buildWakePrompt(KEY, 'private');
  assert.match(prompt, /\[Status\][^\n]*waiting on owner\(id:779625557\)/, '应点名在等哪一条');
  assert.match(prompt, /\[引用 DeepSeek Harness：这就是你养的那群吗/, '[Status] 行必须带被引用原文');
  assert.match(prompt, /你说这个，我本来就养了你一个/);
});

t('④b 哨兵轮的 [Unread] 行也走同一份 quote-aware 正文（静态接线断言 + 直接调用）', () => {
  // 哨兵轮正文在 sendWakePrompt 里拼（buildWakePrompt 只出首轮那份），所以这里两头都查：
  // ① 源码里两条渲染路径都必须调 unreadBody；② 直接调 unreadBody 验证结果带引用。
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'wake-send.js'), 'utf8');
  const calls = (src.match(/unreadBody\(/g) || []).length;
  assert.ok(calls >= 3, `首轮/哨兵轮/中轮注入三处都应调用 unreadBody，实际 ${calls} 处`);
  assert.doesNotMatch(src, /const body = String\(m\.plain \|\| m\.text \|\| ''\)/, '旧的 plain 优先写法不该还在');
  assert.doesNotMatch(src, /String\(waiting\.plain \|\| waiting\.text/, '[Status] 行不该再 plain 优先');
  const body = wake.unreadBody({ plain: '这个就是说我，不是说你', text: '[引用 AbyssalQuill：生气了]这个就是说我，不是说你' }, 120);
  assert.match(body, /\[引用 AbyssalQuill：生气了\]/);
});

t('⑤ 唤醒正文里没有引用标记时保持原样（不带多余的引用字样）', () => {
  const st = socialState.getSocialState(KEY);
  st.unread = [{
    seq: 2, userId: '1736784911', sender: '群魅魔', isOwner: true, messageId: '760000001',
    time: Date.now(), plain: '在吗', text: '在吗',
  }];
  const prompt = wake.buildWakePrompt(KEY, 'private');
  assert.match(prompt, /在吗/);
  assert.doesNotMatch(prompt, /\[引用/, '没有引用就不该出现引用标记');
});

t('⑥ 系统提示词里有缩略语与引用归属的规则', () => {
  const preset = fs.readFileSync(path.join(process.cwd(), 'dsh', 'agent-presets', 'default', 'agent.cordis.yml'), 'utf8');
  /* 【2026-09-21 提示词压缩后的断言口径】
   * 这三条原来钉的是 1.2.5 的**原句**（`ABBREVIATIONS ARE THE ROOM'S LANGUAGE` 之类）。
   * 2026-09-21 把 [COMPREHEND] 压成短行 spec（TEACHER/缩略语/引用归属一条不删，只是换了更短的写法），
   * 原句自然就没了 —— 测试跟着失效说明它钉的是"措辞"而不是"规则"。
   * 现在改成钉**规则本身**：断言那条规则的关键词都在（缩写表、引用归属判据、抓住整条线），
   * 并且断言规则里点名的中文缩略语样本确实还在（那是最容易被压缩顺手删掉的东西）。
   * 目的不变：只要有人把这三条规则删掉或删空，这个用例必须红。 */
  assert.match(preset, /_ABBREVIATIONS|ABBREVIATION/, '缩略语规则不见了');
  assert.match(preset, /yyds/, '缩略语规则里的中文样本被删空了');
  assert.match(preset, /xdm\(|srds\(/, '拼音首字母样本不见了');
  assert.match(preset, /\[引用 X：…\]/, '引用标记的语法没写出来');
  assert.match(preset, /someone else's -> they talk to them, not you/i, '引用归属判据（引用别人=在跟别人说话）不见了');
  assert.match(preset, /HOLD_THE_THREAD|HOLD THE THREAD/, '抓住整条线（而不只最后一句）的规则不见了');
});

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 上 sqlite 句柄未释放 */ }
console.log(`quote-context: ${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
