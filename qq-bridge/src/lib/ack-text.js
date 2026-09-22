// 「整条正文只是一句发送回执」的判定（OK / 好了 / 已发送 …）。
//
// 【2026-09-22】主人报「模型不是每次都是 OK，无伤大雅但是可以强化」。现场：模型用发送工具把话发完之后，
// 收尾时又单独发一条 `OK`（或"好了/已发送"），主人那边看到的就是「正经回复 + 一句 OK」两条。提示词里
// 已经加了 [RULES] 13 NO_TRAILING_REPORT，但那只是"请它别这样"；这里给桥一道**不依赖模型听话**的保证：
// 本回合已经真的发过气泡（session-state 的 turnHasBubble）之后，只要这一条正文整条就是回执，就不发。
//
// 闸门刻意开得很窄，只认"整条就是回执"这一种形态：
//   · 长度上限 12 字（正常句子不可能落进来）；
//   · 只匹配固定的回执表，不匹配"嗯/好/在/收到/行"这类**本身就是正常回复**的短句；
//   · 去掉 Markdown 加粗/行内代码包裹后必须是完整匹配（`**OK**`、`` `OK` `` 也算，`OK，我这就去办` 不算）。
const ACK_EN_RE = /^(?:ok|okay|okok|done|got\s*it|finished)$/i;
const ACK_ZH_RE = /^(?:好的|好嘞|好滴|好啦|好了|已发送|已发出|发送成功|发送完毕|发送完成|已经发送|已回复|已处理|已完成|完成)$/;

/** 去掉 Markdown 包裹与首尾空白/句末标点，得到用于判定的"纯净正文"。 */
function normalizeAckText(text) {
  return String(text ?? '')
    .trim()
    .replace(/^[*_`~]+/, '')
    .replace(/[*_`~]+$/, '')
    .trim()
    .replace(/[.。!！~～、,，;；:：]+$/, '')
    .trim();
}

/**
 * 这一条正文是不是"整条就是一句发送回执"。
 * @param {string} text 待判定的正文（原始 message 文本）
 * @param {{maxChars?: number}} [opts] maxChars 默认 12：超过这个长度一定不是回执
 * @returns {boolean} true = 整条只是一句回执（本回合已发过内容时应当拦下）
 */
export function isAckOnlyText(text, opts = {}) {
  const maxChars = Math.max(1, Number(opts.maxChars) || 12);
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > maxChars) return false;
  const plain = normalizeAckText(raw);
  if (!plain || plain.length > maxChars) return false;
  return ACK_EN_RE.test(plain) || ACK_ZH_RE.test(plain);
}
