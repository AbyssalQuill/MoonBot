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
  social: { enabled: true, steerEnabled: true },
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
const textSafeMod = await import(url('lib/text-safe.js'));

const cfg = cfgMod.loadConfig();
modeMod.initModeCore(cfg);
wakeMod.initWakeCore(cfg);
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
check('B6 没有【令牌】', !/【令牌】/.test(sentinel));
check('B7 没有内联收尾规则（qq_wait_for_messages 那段）', !/qq_wait_for_messages/.test(sentinel));
check('B8 没有内联"reply and close in the SAME step"', !/SAME step/.test(sentinel));
check('B9 哨兵轮 < 320 字符（原约 2KB 含规则）', sentinel.length < 320, `实测 ${sentinel.length}`);

/* ── C. 无未读的哨兵轮（空唤醒）：保留主人点名的那种一行式说明 ────────── */
delivered.length = 0;
st.unread = [];
st.recentMessages = st.recentMessages.filter((m) => m.seq !== 2);
await wakeMod.sendWakePrompt(KEY, 'proactiveCheck');
const emptyWake = delivered[0]?.text ?? '';
console.log(`—— 空唤醒：${JSON.stringify(emptyWake.slice(0, 200))}`);
check('C1 空唤醒仍是数据形态（[Wake proactiveCheck] + [Unread 0]）', /\[Wake proactiveCheck\]/.test(emptyWake) && /\[Unread 0\] nothing new to answer/.test(emptyWake));
check('C2 空唤醒没有 ➤', !/➤/.test(emptyWake));
check('C3 空唤醒 < 260 字符', emptyWake.length < 260, `实测 ${emptyWake.length}`);

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
  // 【2026-09-13 主人要求：默认人设改为 "You are a helpful assistant"，不要小鲸鱼】
  ['默认人设是通用助手', /You are a helpful assistant/],
  ['默认人设放在 DEFAULT CHARACTER 段里', /\[DEFAULT CHARACTER[^\n]*\]\s*\n\s*You are a helpful assistant/],
  ['默认人设明确"没有名字/吉祥物/设定"', /no persona name, no mascot, no roleplay register|no name, no mascot and no lore/],
  ['主人段落不再有撒娇/顺从注册', null],
];
for (const [label, re] of mustHave) {
  if (re === null) continue;
  check('D 提示词包含：' + label, re.test(preset));
}
// 鲸鱼身份必须清零（工具名 qq_send_whale_meme / qq_whale_meme_search 是随包表情库的真实工具名，允许保留）
const whaleHits = preset.split(/\r?\n/).filter((l) => /小鲸鱼|鲸鱼娘|大肥鱼|whale-girl|ᗜ|本鱼/.test(l));
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

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 占用忽略 */ }
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
