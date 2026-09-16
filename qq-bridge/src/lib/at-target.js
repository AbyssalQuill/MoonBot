// atUserId 入参体检：模型把 **messageId 当成 QQ 号**传进来时降级为"不带 @"，绝不整批失败。
//
// ── 为什么专门做这件事（真机双发现场，见 send-idempotency.js 顶部）────────────────
//   两次双发的触发链完全一样，起点都是 atUserId 传错：
//     · 14:12:34 group:868756515 atUserId=444195792（那正是当时最新一条消息 "@DeepSeek 喵喵喵" 的 messageId）
//       → NapCat `OneBot send_group_msg 失败: Get Uid Error` → 工具统一发送**部分成功 1/2 条**
//       → 模型看到 ok:false 重发整批 → 14:12:50「又不是猫娘」第二次进群。
//     · 14:28:15 同一个群 atUserId=874987121（同样命中当时 recentMessages 里的 messageId）
//       → 14:28:16 Get Uid Error → 14:28:17 部分成功 1/2 → 14:28:21 重发整批 → 「不过你确定不怕我画出来」双发。
//   所以"堵住触发源"= 在**发送之前**认出这种误传，把 @ 去掉照常发；整批就不会部分失败，模型也就没有
//   理由重发整批，双发这条链从源头断掉。
//
// ── 凭什么区分"messageId 误传"与"合法短 QQ 号"（本机实测数据）────────────────────
//   **只认一条无争议判据：这个值是否等于本会话近期真实出现过的 messageId。**
//   不做长度/位数判断 —— 本机实测两个集合的位数与量级**完全重叠**，用长度判必然误伤：
//     · messageId 位数直方图（group:868756515 近 36 条）：{8 位:2, 9 位:19, 10 位:15}
//       例：`44160592`(8位) / `874987121`(9位) / `1275818397`(10位)
//     · 真实 QQ 号（同群近窗发送者 userId）：9~10 位，例 `878281653`(9位) / `1736784911`(10位) / `3627645831`(10位)
//   即 9 位既可能是 messageId 也可能是真 QQ 号；10 位同理。数值区间（4.4e7 ~ 2.3e9）也重叠。
//   所以"值在 messageId 集合里"是**唯一**不会误伤真 QQ 号的判据，也是这次唯一被采用的判据。
//
// ── 不在群里（合法数字但不是群成员）怎么办：**不用缓存猜，交给 NapCat 权威判定** ──────
//   本模块**不**根据"近期群成员缓存"去否掉 @：group-cache.js 只缓存群主/管理员（warmGroupInfo 收 role
//   owner/admin），**没有全量成员名单**，拿它当"不是群成员"的依据会把普通群成员的 @ 全部误杀。
//   这类情况改由 qq-send.js 的 onebotSend 自愈兜底：真出现 `Get Uid Error` 时**去掉 @ 段重发一次**
//   （该错误发生在 uid 解析阶段 → 这条消息整体没发出去，重发不会重复），消息照样送达、只是没有 @，
//   并且同样会把"降级了"回执给模型。这样两层加起来：能确定的（误传 id）提前降级；
//   不能确定的（号码错/不在群）由权威错误触发降级，都不再走"整批部分失败 → 模型重发整批"。
import { log } from './log.js';

/** 合法的 QQ 号形态：纯数字、不能是 @all。 */
const NUMERIC_RE = /^\d+$/;

/** 从会话状态里收集"本会话近期真实出现过的 messageId"作为判据证据。
 *  两个来源都算：recentMessages（含自己发出去的气泡）与 answeredMessageIds（确实被回复过的 id）。
 *  只用这两个来源的原因：它们都是桥自己写下的真实 QQ message_id，不涉及任何推测。 */
export function collectAtUserIdEvidence(st) {
  const ids = new Set();
  for (const m of Array.isArray(st?.recentMessages) ? st.recentMessages : []) {
    const id = m && m.messageId != null ? String(m.messageId).trim() : '';
    if (id) ids.add(id);
  }
  for (const id of Array.isArray(st?.answeredMessageIds) ? st.answeredMessageIds : []) {
    const s = String(id ?? '').trim();
    if (s) ids.add(s);
  }
  return { messageIds: ids };
}

/**
 * 判定 atUserId 是否可以直接用。
 * @returns {{ok:true, id:string} | {ok:false, id:string, reason:'message-id'|'at-all'|'not-numeric', why:string}}
 *   ok:true  → 照常 @（真 QQ 号，含短号）
 *   ok:false → 调用方**降级为不带 @** 照常发送，并把 why 回执给模型
 */
export function judgeAtUserId(atUserId, evidence = {}) {
  const raw = atUserId === undefined || atUserId === null ? '' : String(atUserId).trim();
  if (!raw) return { ok: true, id: '' };
  if (!NUMERIC_RE.test(raw)) {
    return {
      ok: false, id: raw,
      reason: /^all$/i.test(raw) ? 'at-all' : 'not-numeric',
      why: /^all$/i.test(raw) ? '@全体成员是不允许的' : '不是纯数字 QQ 号',
    };
  }
  const ids = evidence && evidence.messageIds instanceof Set
    ? evidence.messageIds
    : new Set(Array.isArray(evidence?.messageIds) ? evidence.messageIds.map((x) => String(x)) : []);
  if (ids.has(raw)) {
    return { ok: false, id: raw, reason: 'message-id', why: '看着像 messageId 不是 QQ 号（它就是本会话近期某条消息的 id）' };
  }
  return { ok: true, id: raw };
}

/** 降级时那行明确日志（现场要求逐字可读：挡了哪条、为什么、怎么处理的）。 */
export function logAtUserIdDowngrade(key, judge) {
  const line = `[send] ${key} atUserId=${judge.id} ${judge.why} —— 本次降级为不带 @ 发送（避免整批失败后模型重发造成双发）`;
  log(line);
  return line;
}

/** 回执给模型的一句话（下一轮别再这么传）。 */
export function atUserIdDowngradeNote(judge) {
  return `本条消息已按"不带 @"发出（你传的 atUserId=${judge.id} ${judge.why}）。下次要 @ 人请传对方的 QQ 号；`
    + `消息 id（messageId）只能用于 replyToMessageId 引用，两者不能混用。`;
}

void log;
