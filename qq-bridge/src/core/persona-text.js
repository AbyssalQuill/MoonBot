/**
 * 人格画像的**中文成文**（2026-09-14 主人反馈后重做）。
 *
 * 主人看到的旧版长这样：
 *   `样本 195 条，昵称:The Dark Iceberg；性格:技术达人，…；风格:短句到中句混合…；聊天习惯:全天活跃，深夜（`
 * 三个毛病：
 *   ① 一堆机器标签（昵称:/性格:/风格:/聊天习惯:），读起来像表单；还顶着个「备注」；
 *   ② 大段重复 —— 性格里已经写了风格和习惯，摘要又把它们各说一遍；
 *   ③ **半句截断** —— 旧代码 `slice(0, 300)` 直接切字符，"深夜（"、"给予鼓" 这种断口就是这么来的。
 *
 * 现在的规则：
 *   - 只输出**一段完整的中文介绍**，不出现 `昵称:` / `性格:` / `备注` 这类字段名；
 *   - 句子级去重：一方包含另一方的整句直接丢掉，不重复说同一件事；
 *   - **绝不在句子中间截断**：真超长时只在句末标点处收尾，宁可少一句也不留半句。
 */

/** 中文画像的软上限：超过就在句末标点处收尾（不切字）。 */
export const PROFILE_MAX = 4000;

/** 把一段文字切成句子（。！？；换行都算句末）。 */
export function splitSentences(text) {
  return String(text ?? '')
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[。！？!?；;])/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 去重用的归一化键：去掉空白与标点，只比内容。 */
function keyOf(sentence) {
  return sentence.replace(/[\s，,。、；;：:！!？?～~“”"'（）()【】\[\]—\-]/g, '');
}

/** 昵称清理：模型偶尔把昵称写成半句（实测出现过 `The Dark Iceberg / 只是一座冰山…，被熟人称为`，
 *  后半句是被截断的"被称为…"；还有 `1-2^7(看见我请让我去背单词！…` 这种把整句话塞进昵称字段、
 *  括号还没闭合的）。这里只留名字本身：剪掉吊在半空的连接词、句号后的内容、以及未闭合的括号。 */
function cleanNickname(raw) {
  let s = String(raw ?? '').trim();
  s = s.replace(/[，,；;、\s]*(被熟人|被大家|被人们|被群友|被朋友)?\s*(称为|叫做|称作|简称)\s*$/, '');
  s = s.replace(/[，,；;、]\s*$/, '');
  // 名字里不可能有句末标点：出现即说明后面是句子不是名字
  s = s.replace(/[。！!；;].*$/, '');
  // 括号不闭合 → 从那个括号起全是句子（如 "1-2^7(看见我请让我去背单词"）
  for (const [open, close] of [['(', ')'], ['（', '）'], ['[', ']'], ['【', '】']]) {
    const i = s.indexOf(open);
    if (i > 0 && s.indexOf(close, i) < 0) s = s.slice(0, i);
  }
  return s.replace(/[，,、\s]+$/, '').slice(0, 40).trim();
}

/**
 * 把结构化字段揉成一段完整介绍。
 * @param {object} p persona-library 里的一条（或 normalizePersona 的结果）
 * @returns {string}
 */
export function composePersonaProfile(p) {
  if (!p || typeof p !== 'object') return '';
  const str = (v) => String(v ?? '').trim();
  const s = {
    nickname: cleanNickname(p.nickname),
    addressTerms: str(p.addressTerms),
    personality: str(p.personality),
    chatHabits: str(p.chatHabits),
    emojiHabits: str(p.emojiHabits),
    relationshipAdvice: str(p.relationshipAdvice),
    topics: Array.isArray(p.topics) ? p.topics.map(str).filter(Boolean) : [],
    taboos: Array.isArray(p.taboos) ? p.taboos.map(str).filter(Boolean) : [],
    catchphrases: Array.isArray(p.catchphrases) ? p.catchphrases : [],
    style: p.style && typeof p.style === 'object' && !Array.isArray(p.style) ? p.style : null,
  };

  const out = [];
  const seen = [];
  /** 逐句收录；与已收录内容重叠的整句丢弃（去重的关键）。 */
  const add = (text) => {
    for (const sentence of splitSentences(text)) {
      const k = keyOf(sentence);
      if (k.length < 4) continue;
      if (seen.some((prev) => prev.includes(k) || k.includes(prev))) continue;
      seen.push(k);
      out.push(sentence);
    }
  };

  // ① 身份：昵称 + 别人怎么称呼
  if (s.nickname) {
    const head = `昵称「${s.nickname}」`;
    if (s.addressTerms) add(`${head}；${s.addressTerms.replace(/。$/, '')}。`);
    else add(`${head}。`);
  } else if (s.addressTerms) {
    add(s.addressTerms);
  }

  // ② 性格（主体）
  add(s.personality);

  // ③ 说话风格：把三个小字段连成一句人话，而不是"风格:xxx"
  if (s.style) {
    const bits = [];
    const len = str(s.style.sentenceLength);
    if (len) bits.push(`说话${/^(短句|长句|混)/.test(len) ? '' : '偏'}${len}`);
    const tone = str(s.style.toneWords);
    if (tone) bits.push(`语气上${tone}`);
    const rq = str(s.style.rhetoricalQuestions);
    if (rq) bits.push(/^y/i.test(rq) ? '爱反问' : /^n/i.test(rq) ? '很少反问' : rq);
    if (bits.length) add(`${bits.join('，')}。`);
    const ex = Array.isArray(s.style.examples) ? s.style.examples.map(str).filter(Boolean).slice(0, 4) : [];
    if (ex.length) add(`说话样例（原句）：「${ex.join('」「')}」。`);
  }

  // ④ 聊天习惯 / 表情习惯
  add(s.chatHabits);
  add(s.emojiHabits);

  // ⑤ 口头禅
  const phrases = s.catchphrases
    .map((c) => (c && typeof c === 'object' ? str(c.phrase) : str(c)))
    .filter(Boolean)
    .slice(0, 6);
  if (phrases.length) add(`常挂嘴边的话：「${phrases.join('」「')}」。`);

  // ⑥ 常聊话题（列表自带说明，用顿号连）
  if (s.topics.length) add(`常聊：${s.topics.slice(0, 6).join('；')}。`);

  // ⑦ 忌讳 / 相处建议
  if (s.taboos.length) add(`要注意：${s.taboos.slice(0, 4).join('；')}。`);
  add(s.relationshipAdvice);

  // 收尾：只在句末标点处截，绝不切字（旧版 "深夜（" 那种断口就是这么来的）
  let text = out.join('');
  if (text.length > PROFILE_MAX) {
    const cut = text.slice(0, PROFILE_MAX);
    const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
    text = at > PROFILE_MAX * 0.5 ? cut.slice(0, at + 1) : '';
  }
  return text.trim();
}

/**
 * 清掉历史上写进 `profiles.notes` 的「人格学习:…」段落（那是学习结果，不是主人的备注）。
 * 旧版每次学习都把摘要追加到备注里，主人看到的就是两段几乎一样的"备注"。
 * 返回清理后的备注：主人自己写的部分保留，学习段落删掉；全是学习段落就返回空串。
 */
export function stripLearnNotes(notes) {
  const raw = String(notes ?? '');
  if (!raw.trim()) return '';
  const kept = raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^人格学习[:：]/.test(line));
  return kept.join('\n');
}
