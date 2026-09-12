// 分句规划
import { splitLongSegment, singleLineForQQ } from './segment.js';
import { splitByCjkSpaces, isCjkLikeChar } from './cjk-split.js';
import { fmtBeijing } from './time.js';

// 新分句逻辑：分句权交给 AI。
// AI 用空格表示"这里要分成下一条消息"，桥接按空格拆条；
// 不想分条时用标点连接、不加空格即可。单条消息只做 maxReplyChars（默认 500 字）安全硬拆。
export function planSocialTimeline(text, socialCfg) {
  const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
  const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
  const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
  const enabled = socialCfg?.burstEnabled !== false;
  if (!src) return { main: [], followUp: null };

  // 关闭分条：整条作为一条消息发送，只做安全硬拆
  if (!enabled) {
    return { main: splitLongSegment(src, maxChars).map(singleLineForQQ), followUp: null };
  }

  // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
  const parts = splitByCjkSpaces(src);
  if (parts.length <= 1) {
    return { main: splitLongSegment(parts[0] || src, maxChars).map(singleLineForQQ), followUp: null };
  }

  const main = [];
  for (const part of parts) {
    main.push(...splitLongSegment(part, maxChars).map(singleLineForQQ));
  }
  return { main: main.filter(Boolean), followUp: null };
}

// 是否"直接针对 AI"的提问/挑战：提到 AI 相关词且带疑问/比较，或对"你"开火，或追问催促
export function isDirectedAtAi(textContent) {
  const lower = String(textContent ?? '').toLowerCase();
  const aiMention = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
  const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
  const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
  if (aiMention && (question || challenge)) return true;
  // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
  if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
  if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
  // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
  if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
  // 追问/催促：AI 没回时的真人式催促
  if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
  return false;
}

// 给消息对象附加可读的北京时间 timeText 字段（年月日+时分），供 AI 直接阅读，避免它对着 epoch 毫秒猜日期。
export function withTimeText(m) {
  if (!m || typeof m !== 'object') return m;
  const t = Number(m.time) || 0;
  if (t > 0) return { ...m, timeText: fmtBeijing(t) };
  return m;
}


// P5-10 追加：default发送质量软提醒

export function findCjkSpaceWarning(messages) {
  const bad = [];
  for (let i = 0; i < (messages || []).length; i++) {
    const chars = Array.from(String(messages[i] ?? ''));
    for (let j = 0; j < chars.length; j++) {
      const ch = chars[j];
      if (ch !== ' ' && ch !== '\t') continue;
      const prev = chars[j - 1];
      const next = chars[j + 1];
      if (prev && next && isCjkLikeChar(prev) && isCjkLikeChar(next)) {
        bad.push(i + 1);
        break;
      }
    }
  }
  if (!bad.length) return null;
  const list = [...new Set(bad)];
  const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
  return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
}

export function findSplitBoundaryWarning(messages) {
  if (!Array.isArray(messages) || messages.length <= 1) return null;
  const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
  // 这些是常见“短句但完整”的结尾，不应因为以“的/了”等结尾就被当成半句话。
  const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
  const bad = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const prev = String(messages[i] ?? '').trim();
    const next = String(messages[i + 1] ?? '').trim();
    if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
    const nextStartsCjk = isCjkLikeChar(Array.from(next)[0]);
    const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
    const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
    if (nonTerminalPunct || incompleteTail) {
      bad.push(`${i + 1}、${i + 2}`);
    }
  }
  if (!bad.length) return null;
  return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
}
