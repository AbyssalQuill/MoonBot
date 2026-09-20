// 回归测试：【唤醒规则搬进系统提示词 + 正文只留数据行 + 去 ➤ + 【令牌】→[Token]】
//   主人 2026-09-12 要求：
//     ① 每一种唤醒类型的规则都提前写进系统提示词（persona），之后唤醒注入不再重复带规则；
//     ② 注入只保留 "[Token] …" + "[Mid-turn] N new message(s)…" 这种**数据形态**；
//     ③ 去掉正文里的 ➤ 哨兵符号；④ 【令牌】改成英文标签 + 英文方括号 [Token]。
//
// 这个测试守两件事，缺一不可：
//   A. 注入侧：正文里**没有**规则散文 / 没有 ➤ / 没有【令牌】，且体积明显下降；
//   B. 提示词侧：被搬走的每条规则**确实在 preset 里**（搬走了，不是删了），否则模型会失去规则。
//
// 用法：node tools/test-wake-protocol.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-protocol-'));
fs.cpSync(path.join(REPO, 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-protocol-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({
  ownerQQ: '123456789',
  dsh: { baseUrl: 'http://127.0.0.1:10721' },
  // 唤醒概率用的就是主人配置里的 recommendedProbability：测试里固定 0.42，方便断言 [WakeRef] 行
  social: { enabled: true, steerEnabled: true, wake: { recommendedProbability: 0.42 } },
  // 访问控制：唤醒调度会先过白名单（沙箱里必须显式放行主人私聊，否则 wake 直接被跳过）
  allow: { private: ['123456789'], group: [] },
  deny: { private: [], group: [] },
}, null, 2));

const url = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const cfgMod = await import(url('core/config.js'));
const stateMod = await import(url('core/session-state.js'));
const socialMod = await import(url('core/social-state.js'));
const modeMod = await import(url('core/mode.js'));
const wakeMod = await import(url('core/wake-send.js'));
const diceMod = await import(url('core/send-dice.js'));
const textSafeMod = await import(url('lib/text-safe.js'));

const cfg = cfgMod.loadConfig();
modeMod.initModeCore(cfg);
wakeMod.initWakeCore(cfg);
diceMod.initSendDice(cfg);
socialMod.initSocialCore(cfg);

let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const KEY = `private:${cfg.ownerQQ}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SID = 'session-protocol-test';
cfgMod.state.sessions[KEY] = SID;

const delivered = [];
wakeMod.setWakeDeliver(async (key, text) => { delivered.push({ key, text: String(text) }); return { ok: true }; });
wakeMod.setWakeApi({ sessions: { prompt: async () => ({ result: { ok: true } }) } });

const st = socialMod.getSocialState(KEY);
st.agentToken = 'tok-protocol';
st.unread = [];
st.recentMessages = [];
st.turnSeenUnread = [];
st.turnSteeredSeqs = [];
st.wakeConfig = { mode: 'diving', infinite: false, sleepUntil: '', triggers: {} };

const push = (seq, text, opts = {}) => {
  const row = { seq, messageId: `m${seq}`, sender: '主人', userId: cfg.ownerQQ, isOwner: true, plain: text, text, isSelf: false, time: Date.now(), atSelf: false, hasMedia: false, ...opts };
  st.unread.push(row);
  st.recentMessages.push(row);
  st.lastUnreadSeq = Math.max(Number(st.lastUnreadSeq) || 0, seq);
};

/* ── A. 首轮完整注入：数据形态 + 无规则散文 ─────────────────────────────── */
push(1, '在吗');
st._promptInjected = false;
await wakeMod.sendWakePrompt(KEY, 'private');
const first = delivered[0]?.text ?? '';
console.log(`—— 首轮完整注入：${first.length} 字符`);
check('A1 首轮注入成功', delivered.length === 1);
check('A2 首行是 [Token] 令牌行（英文方括号）', /^\[Token\] tok-protocol/.test(first), first.split('\n')[0]);
check('A3 主人私聊带 [OWNER] 标记', /\[OWNER\]/.test(first));
// 首轮走 [Status] + [Recent messages] 窗口（这是既有架构：首轮给上下文，不重复给 [Unread n]）
check('A4 首轮带上了未读正文（[Status] n unread + 消息正文）', /\[Status\] 1 unread/.test(first) && /在吗/.test(first));
check('A5 首轮注入里没有 ➤ 哨兵符号', !/➤/.test(first));
check('A5b 首轮 [Now] 精确到秒并带 epochMs', /\[Now\] \d{4}-\d{2}-\d{2} 周[一二三四五六日] \d{2}:\d{2}:\d{2} \(Beijing, epochMs=\d{13}\)/.test(first), JSON.stringify(first.split('\n').filter((l) => l.startsWith('[Now]'))));
check('A6 首轮注入里没有【令牌】旧标签', !/【令牌】/.test(first));
check('A7 首轮注入不再内联 12 条 Rules 大段（原 rulesShort 4,274 字符）', !/Cross-session: one AI, separate contexts per session/.test(first));
check('A8 首轮注入不再内联回合协议（原 protocolNote 2,886 字符）', !/Round protocol \(applies to every later wake/.test(first));
check('A9 首轮注入不再内联"Read step - sometimes NOT NEEDED"-类步骤说明', !/Read step - sometimes NOT NEEDED/.test(first));
check('A10 首轮注入 < 2,500 字符（原约 5.6KB：含 rules+protocol）', first.length < 2500, `实测 ${first.length}`);

/* ── B. 哨兵轮：只有 [Token] + [Wake 原因] + 数据 ─────────────────────── */
delivered.length = 0;
st._promptInjected = true;
st.unread = [];
push(2, '第二条：还在吗');
await wakeMod.sendWakePrompt(KEY, 'private');
const sentinel = delivered[0]?.text ?? '';
console.log(`—— 哨兵轮：${sentinel.length} 字符 | ${JSON.stringify(sentinel.split('\n'))}`);
check('B1 哨兵轮注入成功', delivered.length === 1);
check('B2 首行是 [Token]', /^\[Token\] tok-protocol/.test(sentinel));
check('B3 带 [Wake <原因>] 标签（这一步不用再读状态）', /\[Wake private\]/.test(sentinel));
check('B4 直接带未读正文', /\[Unread 1\] owner\(id:m2\): 第二条：还在吗$/.test(sentinel));
check('B5 没有 ➤', !/➤/.test(sentinel));
check('B5b 哨兵轮也带 [Now] 精确到秒（主人 2026-09-20 要求：和 sqlite 的 ts 同形）', /^\[Now\] \d{4}-\d{2}-\d{2} 周[一二三四五六日] \d{2}:\d{2}:\d{2}$/m.test(sentinel), JSON.stringify(sentinel.split('\n').filter((l) => l.startsWith('[Now]'))));
check('B6 没有【令牌】', !/【令牌】/.test(sentinel));
check('B7 没有内联收尾规则（qq_wait_for_messages 那段）', !/qq_wait_for_messages/.test(sentinel));
check('B8 没有内联"reply and close in the SAME step"', !/SAME step/.test(sentinel));
check('B9 哨兵轮 < 800 字符（原约 2KB 含规则；2026-09-19 起还要带抽签行）', sentinel.length < 800, `实测 ${sentinel.length}`);
/* 【2026-09-19 修「概率设置不生效」的回归】抽签行原先只在"首轮完整注入"里掷一次，
 * 哨兵轮（= 绝大多数唤醒）没有 → 概率实际要等会话轮换（~10 轮）才重掷一次，
 * 表现就是"设了 0.6 却几乎看不到表情包/语音"。现在哨兵轮也必须带抽签行。 */
check('B10 哨兵轮带 [Meme] 抽签行（这就是本轮修复）', /^\[Meme\] /m.test(sentinel), JSON.stringify(sentinel));
/* 【2026-09-19 主人要求"插话概率等所有概率都要改好落地"】
 * [WakeRef] 行必须每轮都在（首轮 + 哨兵轮），并且写着主人配置的那个数字 ——
 * 否则模型拿不到它，就会一直沿用自己上一轮拍的概率，主人在界面上改等于没改。 */
check('B10b 哨兵轮带 [WakeRef] 主人插话概率行', /\[WakeRef\][^\n]*插话概率=0\.42/.test(sentinel), JSON.stringify(sentinel.split('\n').filter((l) => l.includes('WakeRef'))));
check('B10c 首轮也带 [WakeRef]', /\[WakeRef\][^\n]*插话概率=0\.42/.test(first));
// 把概率拧到 1 / 0，哨兵轮必须分别给出 HIT / MISS —— 证明它真的每轮现掷，而不是照抄首轮结论
const stickerCfg = (cfg.social && cfg.social.sticker) || (cfg.social.sticker = {});
stickerCfg.enabled = true;
stickerCfg.sendProbability = 1;
stickerCfg.sendCooldownMs = 0;
delivered.length = 0;
await wakeMod.sendWakePrompt(KEY, 'private');
const hitText = delivered[0]?.text ?? '';
check('B11 概率 1 → 哨兵轮出现 [Meme] dice HIT', /\[Meme\] dice HIT/.test(hitText), JSON.stringify(hitText.split('\n').filter((l) => l.startsWith('[Meme]'))));
stickerCfg.sendProbability = 0;
delivered.length = 0;
await wakeMod.sendWakePrompt(KEY, 'private');
const missText = delivered[0]?.text ?? '';
check('B12 概率 0 → 哨兵轮出现 [Meme] dice MISS', /\[Meme\] dice MISS/.test(missText), JSON.stringify(missText.split('\n').filter((l) => l.startsWith('[Meme]'))));
check('B13 刚发过一次就登记（用于冷却判定）', (() => {
  stickerCfg.sendProbability = 1;
  stickerCfg.sendCooldownMs = 180000;   // 冷却要真的开着，否则永远是 HIT
  diceMod.noteMemeSent(KEY);
  return true;
})());
delivered.length = 0;
await wakeMod.sendWakePrompt(KEY, 'private');
const cdText = delivered[0]?.text ?? '';
check('B14 冷却中 → 哨兵轮显示 cooldown', /\[Meme\] cooldown/.test(cdText), JSON.stringify(cdText.split('\n').filter((l) => l.startsWith('[Meme]'))));
stickerCfg.sendProbability = 0.3;
stickerCfg.sendCooldownMs = 180000;

/* ── C. 无未读的哨兵轮（空唤醒）：保留主人点名的那种一行式说明 ────────── */
delivered.length = 0;
st.unread = [];
st.recentMessages = st.recentMessages.filter((m) => m.seq !== 2);
await wakeMod.sendWakePrompt(KEY, 'proactiveCheck');
const emptyWake = delivered[0]?.text ?? '';
console.log(`—— 空唤醒：${JSON.stringify(emptyWake.slice(0, 200))}`);
check('C1 空唤醒仍是数据形态（[Wake proactiveCheck] + [Unread 0]）', /\[Wake proactiveCheck\]/.test(emptyWake) && /\[Unread 0\] nothing new to answer/.test(emptyWake));
check('C2 空唤醒没有 ➤', !/➤/.test(emptyWake));
/* 【2026-09-20 主人要求】唤醒要带精确时间戳，与 memory.db 的 chat_messages.ts 同形：
 *   首轮/完整正文：[Now] 2026-09-20 周日 19:15:23 (Beijing, epochMs=1789902923920)
 *   哨兵轮（绝大多数唤醒）：[Now] 2026-09-20 周日 19:15:23
 * 只到分钟时模型算不准"这条多久之前的"，只能多花一步调 qq_get_recent_messages ——
 * 那一步 = 再发一整份系统提示词与工具表。 */
check('C2b 哨兵轮/空唤醒带 [Now] 精确到秒', /^\[Now\] \d{4}-\d{2}-\d{2} 周[一二三四五六日] \d{2}:\d{2}:\d{2}$/m.test(emptyWake), JSON.stringify(emptyWake.split('\n').filter((l) => l.startsWith('[Now]'))));
check('C3 空唤醒 < 600 字符（含抽签行后的上限）', emptyWake.length < 600, `实测 ${emptyWake.length}`);
check('C4 空唤醒也带 [Meme] 抽签行（每轮都掷）', /^\[Meme\] /m.test(emptyWake));

/* ── D. 规则确实搬进了系统提示词（搬走 ≠ 删掉） ────────────────────────── */
const presetPath = path.join(REPO, 'dsh', 'agent-presets', 'default', 'agent.cordis.yml');
const preset = fs.readFileSync(presetPath, 'utf8');
const mustHave = [
  ['[WAKE DATA] 段', /\[WAKE DATA/],
  ['[WAKE TYPES] 段', /\[WAKE TYPES/],
  ['[RULES] 段', /\[RULES\]/],
  ['令牌行语义（[Token] <value>）', /\[Token\] <value>/],
  ['[Mid-turn] 规则（ONE-AND-DONE）', /ONE-AND-DONE/],
  ['[Mid-turn] 一条气泡覆盖全部', /ONE short bubble covering ALL/],
  ['[Mid-turn] 不复读', /never restate what you already said/],
  ['[Mid-turn] 第一次看到当普通唤醒', /treat it as a normal wake/],
  ['[Mid-turn] 真没内容才不发', /Skip the bubble only if there is truly nothing to answer/],
  ['[Mid-turn] 主人私聊收尾 + 禁用等待工具', /never call qq_wait_for_messages/],
  ['replyCheck 规则', /\[Wake replyCheck\]/],
  ['proactiveCheck 规则', /\[Wake proactiveCheck\]/],
  ['poke 规则', /\[Wake poke\]/],
  ['timeout 规则', /\[Wake timeout\]/],
  ['bootstrap 规则', /\[Wake bootstrap\]/],
  ['[Unread 0] 规则', /\[Unread 0\] nothing new to answer/],
  ['[Nag] 规则', /\[Nag\] - the peer is pressing/],
  ['[Rebroadcast] 规则', /\[Rebroadcast\] - make-up wake/],
  ['[Note] 不许装失忆 + 要去翻历史', /NEVER PLAY AMNESIAC|Never answer "I can't see/],
  ['[Note] [Preheat] 作废规则', /\[Preheat\] was a one-off cache warm-up/],
  ['[Undelivered draft] 规则', /\[Undelivered draft\] - you ended the last round/],
  ['(peer may still be typing) 规则', /peer may still be typing/],
  ['[Reminder] 规则', /\[Reminder\] round not closed/],
  ['跨会话规则（原 rulesShort 第 1 条）', /Cross-session: one AI, separate contexts per session/],
  ['@ 人规则（原 rulesShort 第 4 条）', /atUserId = their QQ/],
  ['定时提醒规则（原 rulesShort 第 5 条）', /qq_schedule_message/],
  ['撤回规则（原 rulesShort 第 6 条）', /qq_withdraw_message/],
  ['转发/长文 docx 规则（原 rulesShort 第 8 条）', /qq_send_docx/],
  ['主人私聊回合保持规则（原 rulesShort 第 10 条）', /the bridge keeps this round open by itself/],
  ['活跃时段规则（原 rulesShort 第 11 条）', /qq_set_activity_hours/],
  ['系统配置键规则（原 rulesShort 第 12 条）', /proactiveEnabled/],
  // 【2026-09-20 主人要求：正文不许显式换行 / 颜文字有条件发 / 数组当正文是硬失败 / 代码不分段】
  ['[TOOLS] 2b 正文不许显式换行（代码/诗歌例外）', /FORMATTING - NO EXPLICIT NEWLINES/],
  ['[TOOLS] 2c 颜文字只在人设要求时发', /KAOMOJI - ONLY IF THE CHARACTER ASKS FOR THEM/],
  ['[TOOLS] 2c 10 字内联 / 超 10 字单独一条', /10 characters or fewer[\s\S]{0,200}its OWN separate bubble/],
  ['[TOOLS] 2d 工具参数数组当正文 = 硬失败', /NEVER SEND THE TOOL-ARGUMENT ARRAY AS TEXT - HARD FAILURE/],
  ['[TOOLS] 2e 代码类不分段（>50 字仍一条）', /CODE IS NEVER SPLIT[\s\S]{0,200}over 50 characters is still one message/],
  ['[TOOLS] 5b 搜索预算（两次就答，不许反复换词检索）', /SEARCH BUDGET - TWO TRIES, THEN ANSWER[\s\S]{0,300}at most 2 calls per round/],
  // 【2026-09-13 主人要求：默认人设改为 "You are a helpful assistant"，不要小鲸鱼】
  ['主人段落不再有撒娇/顺从注册', null],
];
for (const [label, re] of mustHave) {
  if (re === null) continue;
  check('D 提示词包含：' + label, re.test(preset));
}
// 鲸鱼身份必须清零（表情工具现在叫 qq_send_meme / qq_meme_search，名字里也不带鲸鱼了）
const whaleHits = preset.split(/\r?\n/).filter((l) => /小鲸鱼|鲸鱼娘|大肥鱼|whale-girl|ᗜ|本鱼/.test(l));
/* 【2026-09-19 主人要求】系统提示词里**不再内置默认人设**：
 * 原来这三条断言要求提示词里有 "You are a helpful assistant" 与 [DEFAULT CHARACTER] 段 —— 那是旧契约。
 * 现在改成反向断言：既不能有默认角色段，又必须明确"没有人设时不要自己编、不要扮演"。 */
check('D 系统提示词不再内置默认人设（无 [DEFAULT CHARACTER] 段）', !/\[DEFAULT CHARACTER/.test(preset));
check('D 没有人设时写明"不扮演、别自己编"', /\[NO PERSONA[^\n]*\]/.test(preset) && /(invent nothing|role-play nothing|no default character)/i.test(preset));
check('D 仍保留"没有名字/吉祥物/语域/口头禅"的约束', /(no name|no persona name)[^\n]{0,60}(mascot|register|catchphrases)/i.test(preset));
check('D 预设里不再有鲸鱼身份字样', whaleHits.length === 0, whaleHits.map((l) => l.trim().slice(0, 80)).join(' / '));
check('D 主人段落已中性化（不再有撒娇/顺从/娇羞注册）', !/撒娇|顺从|娇羞|配合调情|装可怜/.test(preset));
check('D 默认人设不含表情符号要求（ᗜ 之类）', !/ᗜ/.test(preset));
check('D 提示词里没有 ➤ 残留', !/➤/.test(preset));
check('D 提示词里没有【令牌】残留', !/【令牌】/.test(preset));

/* ── E. 令牌标签改动没有削弱出站泄露防护 ─────────────────────────────── */
textSafeMod.KNOWN_AGENT_TOKENS.add(String(cfg.ownerQQ));
const leakOld = textSafeMod.tokenDisclosureIn('【令牌】123456789');
const leakNew = textSafeMod.tokenDisclosureIn('[Token] 123456789');
const normal = textSafeMod.tokenDisclosureIn('我的群号是 123456789');
check('E1 旧标签【令牌】仍判定为泄露（向后兼容）', !!leakOld);
check('E2 新标签 [Token] 也判定为泄露（模型抄令牌进 QQ 会被拦）', !!leakNew, JSON.stringify(leakNew));
check('E3 日常提到号码不算泄露（不误伤）', !normal);

/* ── F. 源码侧：模型可见的唤醒路径里不再有 ➤ / 【令牌】 ───────────────── */
const srcFiles = ['core/wake-send.js', 'core/social-state.js', 'core/console-server.js'];
for (const rel of srcFiles) {
  const raw = fs.readFileSync(path.join(sandbox, 'src', rel), 'utf8');
  // 注释行（以 // 开头）允许保留历史说明，只检查真正的代码行
  const codeLines = raw.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const arrow = codeLines.filter((l) => /➤/.test(l));
  const oldTag = codeLines.filter((l) => /【令牌】|【会话令牌】/.test(l));
  check(`F ${rel} 代码行里没有 ➤`, arrow.length === 0, arrow[0]?.trim().slice(0, 80) ?? '');
  check(`F ${rel} 代码行里没有【令牌】/【会话令牌】`, oldTag.length === 0, oldTag[0]?.trim().slice(0, 80) ?? '');
}

/* ── G. 人设注入（2026-09-12 主人反馈："我上传的人设不是你注入的人设而是精简版"）──
 * 旧行为：persona.md 含中文 → **整段跳过注入**（模型只能演内置精简版小鲸鱼）。
 * 新行为：原样注入（中英文都不拦），且人设文件一变，下一次唤醒就重新注入完整 prompt。 */
{
  const personaPath = path.join(sandbox, 'persona.md');
  fs.writeFileSync(personaPath, '# 角色卡：测试用中文人设\n名字叫「测试鲸」，说话带点懒\n自定义规矩：每天最多主动说三次话。', 'utf8');
  delivered.length = 0;
  st._promptInjected = false;
  st._promptOverrideStamp = '';
  await wakeMod.sendWakePrompt(KEY, 'private');
  const withPersona = delivered[0]?.text ?? '';
  check('G1 persona.md（含中文）会被注入', /\[PERSONA\]/.test(withPersona) && /测试用中文人设/.test(withPersona));
  check('G2 人设里的自定义规矩原文也在（不做过滤/删减）', /每天最多主动说三次话/.test(withPersona));
  check('G3 注入后记下了人设版本号', typeof st._promptOverrideStamp === 'string' && st._promptOverrideStamp.length > 0, String(st._promptOverrideStamp).slice(0, 40));

  // 改人设 → 下一次唤醒必须重新注入完整 prompt（"保存人设后下一条消息就是新人设"）
  await sleep(1100);   // mtime 精度：确保 statKey 真的变了
  fs.writeFileSync(personaPath, '# 角色卡：改过的人设\n现在叫「改名鲸」。', 'utf8');
  delivered.length = 0;
  await wakeMod.sendWakePrompt(KEY, 'private');
  const afterEdit = delivered[0]?.text ?? '';
  check('G4 人设文件变更后自动重新注入完整 prompt', /改名鲸/.test(afterEdit));
  check('G5 重新注入时不再带旧人设', !/测试鲸/.test(afterEdit));
}

/* ── H. 主人改插话概率 → 正在跑的会话立刻跟上（只动 source=owner 的）──────────
 * 【2026-09-19 主人要求"插话概率等所有概率都要改好落地"】这一节的现场是：
 * 界面上把概率从 0.05 改成 0.2，但已经聊过的会话一直用旧值（模型早就自己定过一个 prob），
 * 于是"改了没反应"。现在给概率带来源标记：owner 的跟着配置走，model 的保留模型的选择。 */
{
  const mk = (key, prob, src) => {
    const s = socialMod.getSocialState(key);
    const def = socialMod.defaultWakeConfig();
    s.wakeConfig = { ...def, triggers: { ...def.triggers, probability: prob, probabilitySource: src } };
    return s;
  };
  const sOwner = mk('group:900001', 0.05, 'owner');
  const sModel = mk('group:900002', 0.33, 'model');
  cfg.social.wake.recommendedProbability = 0.2;
  const r = socialMod.applyOwnerWakeProbabilityToSessions();
  check('H1 owner 会话立刻用新值', sOwner.wakeConfig.triggers.probability === 0.2, String(sOwner.wakeConfig.triggers.probability));
  /* 【2026-09-19 改口径】主人保存的概率现在覆盖**所有**会话，包括"模型自己定过"的那些
   * （主人反馈："我调的 0.15，唤醒词里带的好像是 0.08" —— 旧口径保留了模型的值，看起来就是没生效）。 */
  check('H2 model 会话也被主人配置覆盖', sModel.wakeConfig.triggers.probability === 0.2, String(sModel.wakeConfig.triggers.probability));
  check('H3 统计：updated 有、kept 为 0、overridden 记一笔', r.updated >= 2 && r.kept === 0 && r.overridden >= 1, JSON.stringify(r));
  // 再把概率调回去，确认是"双向"的（不是只能改一次）
  cfg.social.wake.recommendedProbability = 0.07;
  socialMod.applyOwnerWakeProbabilityToSessions();
  check('H4 再改一次也生效（双向）', sOwner.wakeConfig.triggers.probability === 0.07, String(sOwner.wakeConfig.triggers.probability));
}

/* ── I. 永久会话（social.autoReset.permanent）───────────────────────────────
 * 【2026-09-19 主人要求"一个会话永久使用，但别让上下文堆积，省掉切新会话的首轮 token"】
 * 这里断言的是**一处开关管住全部轮换路径**：
 *   · rotateThresholdOf 返回 Infinity（阈值不再是数字）；
 *   · rotationDue 即便轮次远超 wakeThreshold 也判 false（wake-send 的轮换块 / busy 分支、
 *     turn-hold 的"到点放行关回合"、控制台那条 [Rotate] 收尾指令全都看它）；
 *   · 关掉开关立刻恢复按轮数轮换（双向，不是一次性的）。 */
{
  cfg.social.autoReset = cfg.social.autoReset || {};
  cfg.social.autoReset.wakeThreshold = 5;
  cfg.social.autoReset.permanent = undefined;
  const st9 = socialMod.getSocialState('group:900009');
  st9.rotateTurns = 99;
  st9._promptInjected = true;
  cfgMod.state.sessions['group:900009'] = 'session-permanent-test';
  const normalThreshold = wakeMod.rotateThresholdOf(cfg);
  const normalDue = wakeMod.rotationDue('group:900009', st9, cfg);
  check('I1 默认（非永久）：阈值是配置里的数字', normalThreshold === 5, String(normalThreshold));
  check('I2 默认（非永久）：轮次超阈值 → 该轮换', normalDue.due === true, JSON.stringify(normalDue));

  cfg.social.autoReset.permanent = true;
  const permThreshold = wakeMod.rotateThresholdOf(cfg);
  const permDue = wakeMod.rotationDue('group:900009', st9, cfg);
  check('I3 永久会话：阈值变成 Infinity（不再是数字）', permThreshold === Infinity, String(permThreshold));
  check('I4 永久会话：轮次 99/5 也判「不该轮换」', permDue.due === false && permDue.why === 'permanent-session', JSON.stringify(permDue));
  check('I5 isPermanentSession 与阈值同源', wakeMod.isPermanentSession(cfg) === true);

  cfg.social.autoReset.permanent = false;
  check('I6 关掉立刻恢复按轮数轮换（双向）', wakeMod.rotationDue('group:900009', st9, cfg).due === true);
  // 非布尔真值不算开启（避免 "false" 字符串之类把永久会话误开）
  cfg.social.autoReset.permanent = 'false';
  check('I7 只认布尔 true（"false" 字符串不开启）', wakeMod.isPermanentSession(cfg) === false);
  delete cfg.social.autoReset.permanent;
}

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 占用忽略 */ }
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);