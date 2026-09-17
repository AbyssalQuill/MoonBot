// OneBot 发送回执判定：区分「真失败」与「已送达但回执异常」。
//
// 【2026-09-18 线上实测 · 纠正一条长期误判】
// 这台 QQ（Linux 3.2.33-52892 + NapCat 4.18.28）上，**每一条**发送（私聊/群聊、文本/语音/卡片）
// 都返回下面这种"失败"：
//
//   {"status":"failed","retcode":200,"data":null,
//    "message":"EventChecker Failed: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg
//               ListenerName:NodeIKernelMsgListener/onMsgInfoListUpdate EventRet:
//               {\"result\":1006514,\"errMsg\":\"网络连接异常!\"}\n"}
//
// 但消息**确实送到了**。两条硬证据（同一次调用的 NapCat 原生日志）：
//
//   23:45:33 发送 -> 私聊 (1736784911) [回复消息 私聊 (1736784911) …] 【Q1 引用+正文】…
//   23:45:33 发生错误 Error: EventChecker Failed: NTEvent … {\"result\":1006514,…}
//
// 也就是说 NapCat 先记了「发送 ->」（内核 sendMsg 已经完成），**之后**才因为等不到
// `onMsgInfoListUpdate` 事件而抛错。用 get_friend_msg_history 回读 QQ 内核消息表，
// 那条消息也在（reply+text 段完整），并且一次 2.5s 重试留下的是**两条不同 message_id** 的重复消息。
//
// 为什么必须改：旧代码把这类回执当成"确认没发出去"，于是
//   · lib/onebot-ws.js 的 _sendWithWarmupRetry 重试 3 次（800/2000/5000ms）
//   · core/qq-send.js 的 onebotSend 重试 1 次（2500ms）之后**抛错**
//   · core/voice.js 抛错 → sendMessages 判定"语音失败"→ 原地退回文字重发
//   · core/media.js / core/sticker.js / mcp-napcat-safe.js 抛错 → 工具回报失败 → 模型再发一次
// 净效果：**每条消息真的发出去 2~4 份**（重复气泡），而回执全是"发送失败"。
//
// 现在的规矩：这类回执 = 「已送达、回执未确认」——**绝不重试、绝不报失败**。
// message_id 拿不到（data 为 null），所以返回 null；要撤回的话以对方实际收到的那条为准。
//
// 注意判定要**窄**：只有 `EventChecker Failed` / `Timeout: …sendMsg` 才算已送达。裸的
// `网络连接异常`/`1006514` 没有这两个前缀时（例如会话真的被腾讯作废）仍按老规矩当失败重试。

/** 回执文本里出现它就说明：内核 sendMsg 已完成，失败的是事件确认（=已送达未确认）。
 *  【2026-09-19 扩充】除了 `EventChecker Failed`，NapCat 还会回**超时**形态：
 *    "Timeout: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg
 *     ListenerName:NodeIKernelMsgListener/onMsgInfoListUpdate EventRet:{\"result\":0,\"errMsg\":\"\"}"
 *  实测（发高德图文卡）：这条回执是 500，但**卡片确实进了内核消息表**（我们那串随机 token + ctime
 *  都在里面）。所以它跟 EventChecker 是同一类 —— 内核已经收下、只是等不到事件确认。 */
const DELIVERED_UNCONFIRMED_RE = /EventChecker Failed|Timeout:\s*NTEvent[\s\S]{0,200}?NodeIKernelMsgService\/sendMsg/i;

/**
 * @param {any} errText 响应里的 wording / errMsg / message / retcode 拼出来的文本
 * @returns {boolean} true = 这条消息其实已经发出去，只是回执异常
 */
export function isDeliveredUnconfirmed(errText) {
  return DELIVERED_UNCONFIRMED_RE.test(String(errText ?? ''));
}

/** 已送达未确认时的替身返回值：形状与 OneBot 成功回执的 data 一致，message_id 为 null。 */
export function deliveredUnconfirmedResult() {
  return { message_id: null, messageId: null, unconfirmed: true };
}

/** 把回执体拼成一段可判定的文本（各发送出口的字段名不一样，统一在这里拼）。 */
export function onebotErrText(body) {
  if (!body || typeof body !== 'object') return '';
  return `${body.errMsg ?? ''} ${body.wording ?? ''} ${body.message ?? ''} ${body.retcode ?? ''}`;
}
