// QQ 文本发送
// 依赖全部来自 lib/core；cfg 静态注入（initQqSendCore），bot 运行期注入（setQqSendBot）。
import { qqTextSeg } from '../lib/onebot-ws.js';
import { sweepMessageArtifacts, cleanOutboundText, redactKnownTokensOnly } from '../lib/outbound-text.js';
import { splitForQQ } from '../md-to-plain.js';
import { escapeCqText, tokenDisclosureIn } from '../lib/text-safe.js';
import fs from 'node:fs';
import path from 'node:path';
import { withTimeout, sleep } from '../lib/async.js';
import { log } from '../lib/log.js';
import { enqueueSend, currentSendChain, setSendLinearCfgReader, nextSendPaceMs, markSendDelivered, resetSendPace } from './send-chain.js';
import { getSocialState } from './social-state.js';
import { activeAiTurns } from './session-state.js';
import { recordAiTurnOutbound } from './turn-guard.js';
import { resolveArtifactFaceId } from '../lib/qq-face-parse.js';
import { writeStickerTmpFile } from './sticker.js';
import { napcatImageFileArg } from '../lib/napcat-file.js';

export const SEND_TIMEOUT_MS = 15000;

let cfgRef = null;
let botRef = null;
/** main 启动时调用：注入 cfg（此后不再变）；并向 send-chain 注册线性节拍配置读取器（读同一可变对象，口头可调即时生效） */
export function initQqSendCore(cfg) {
  cfgRef = cfg;
  setSendLinearCfgReader(() => (cfgRef?.social?.send ?? null));
}
/** NapCat 网关就绪后注入 bot（NapCat client） */
export function setQqSendBot(bot) {
  botRef = bot;
}

// 发送单条文本（按 QQ 分条），入发送链
export function sendToQQ(key, msg) {
  const rawText = String(msg ?? '');
  const swept = sweepMessageArtifacts(rawText);
  const stripped = cleanOutboundText(rawText);
  // 整条是纯占位（[表情:…]）：绝不按文字发出（根治"文字版表情"）；纯 emoji/颜文字清洗为空则保留原文
  let safeMsg = stripped;
  if (safeMsg === '' && swept.removed === 0 && rawText.trim() !== '') safeMsg = redactKnownTokensOnly(rawText);
  if (!safeMsg) return currentSendChain();
  const [kind, id] = key.split(':');
  const parts = splitForQQ(safeMsg);
  let partIndex = 0;
  for (const part of parts) {
    const isFirst = partIndex++ === 0;
    enqueueSend(async () => {
      // 发送线性节拍：pace=null 表示线性关闭 → 保留旧 sendDelayMs 尾部停顿；否则按会话连续计数线性等
      //
      // 【2026-09-12 加速】同一条回复的**第一条**不再等节拍（isFirst → 0）。
      // 线性节拍的本意写在本文件顶部注释里："唤醒/首轮即时，首条 n=0 → base（默认 0 → 秒醒，不延迟）"，
      // 它要管的是"这一条回复内部、分条之间的真人打字节奏"。但计数器 n 是**按整个会话**累加的
      // （只有静默超过 linearResetMs 才归零），于是热聊时 n 早早顶到 cap，**每条回复的第一条气泡
      // 也要先干等最多 1.5 秒**——实测 245 次 qq_send_message 调用**全部是单条调用**，
      // 也就是说那 1.5 秒纯属白等（NapCat 自身 RTT 实测只有 18ms）。
      // 改成首条 0 → 模型一决定回，气泡立刻出；第 2 条起按"这条自己打完要多久"等（perChar 模式）。
      const pace = isFirst ? 0 : nextSendPaceMs(key, part.length);
      if (pace != null && pace > 0) await sleep(pace);
      try {
        if (kind === 'private') await withTimeout(botRef.sendPrivateMessage(Number(id), qqTextSeg(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        else await withTimeout(botRef.sendGroupMessage(Number(id), qqTextSeg(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        if (pace != null) markSendDelivered(key, part.length);
      } catch (error) { log(`QQ 发送失败 (${key}):`, error?.message ?? error); if (error?.stack) log('[send-stack]', error.stack.split(String.fromCharCode(10)).slice(0, 8).join(' | ')); }
      if (pace == null) await sleep(cfgRef.sendDelayMs);
    }, key);
  }
  return currentSendChain(key);
}

// 分条发送：与 sendToQQ 共用同一发送链，严格顺序；条间随机间隔，
// 有概率使用长间隔（错落感）；最后一条后不再 sleep。
export function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
  const [kind, id] = key.split(':');
  // 节奏统一走 send-chain.js 的「按字数」打字节拍（social.send.linear*）；
  // 这里的 min/max/longGap* 只服务于"显式传入固定间隔"的老调用方（本函数当前无调用方，保留兼容）。
  let min, max, longProb = 0, longMin = 0, longMax = 0;
  if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
    const cfg = socialCfgOrMin;
    // burstIntervalMinMs/MaxMs 已废弃（节奏统一走线性节拍）；这里用内联兜底值。
    // 注意本函数当前无调用方，保留仅为兼容。
    min = Math.max(0, 1000);
    max = Math.max(min, 3000);    longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
    longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
    longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
  } else {
    min = Math.max(0, Number(socialCfgOrMin) || 0);
    max = Math.max(min, Number(maybeMax) || min);
  }

  const sent = [];
  for (let i = 0; i < messages.length; i++) {
    const sweptOne = sweepMessageArtifacts(messages[i]);
    const strippedOne = cleanOutboundText(messages[i]);
    // 纯占位条（[表情:…]）直接跳过不发；纯 emoji/颜文字清洗为空则保留原文
    let msg = strippedOne;
    if (msg === '' && sweptOne.removed === 0 && String(messages[i] ?? '').trim() !== '') msg = redactKnownTokensOnly(messages[i]);
    if (msg === '') continue;
    enqueueSend(async () => {
      // 打字节拍：批内首条秒回；第 2 条起间隔 = 这条气泡字数 × linearPerCharMs（见 send-chain.js）
      const pace = i === 0 ? 0 : nextSendPaceMs(key, msg.length);
      if (pace != null && pace > 0) await sleep(pace);
      try {
        if (kind === 'private') await withTimeout(botRef.sendPrivateMessage(Number(id), qqTextSeg(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        else await withTimeout(botRef.sendGroupMessage(Number(id), qqTextSeg(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        sent.push(msg);
        if (pace != null) markSendDelivered(key, msg.length);
      } catch (error) { log(`QQ 发送失败 (${key}):`, error?.message ?? error); if (error?.stack) log('[send-stack]', error.stack.split(String.fromCharCode(10)).slice(0, 8).join(' | ')); }
      // 【2026-09-15 清理】这里原本还有一段"线性关闭时按 gapBaseMs+字数×gapPerCharMs 兜底"的旧节奏。
      // 主人定稿只留"按字数"一种节拍（send-chain.js），两套并存只会互相打架 —— 已删除。
      // 现在 pace==null 就等于"不做打字延迟"（linearEnabled=false 的语义），要节奏就调 linearPerCharMs。
    }, key);
  }
  return currentSendChain(key).then(() => sent);
}

// ── P5-7 追加：onebotSend/sendMessages（自 bridge.js 抽取，1:1） ──────

export async function onebotSend(kind, id, message, replyToMessageId, atUserId = null, imagePath = null) {
  const segments = [];
  if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
    const rid = String(replyToMessageId).trim();
    if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
    segments.push({ type: 'reply', data: { id: rid } });
  }
  if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
    const at = String(atUserId).trim();
    // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
    if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
    segments.push({ type: 'at', data: { qq: at } });
    // QQ 规范：@昵称 后跟图片/表情/文本都要用空格隔开（文本走 pushTextWithAtSpace，这里先兜底补一格）
    segments.push({ type: 'text', data: { text: ' ' } });
  }
  const rawMessage0 = String(message ?? '');
  const tokenLeak = tokenDisclosureIn(rawMessage0);
  if (tokenLeak) {
    log(`发送内容疑似泄露会话令牌(${tokenLeak.kind})，已阻止发送 (${kind}:${id})`);
    throw new Error('发送内容疑似泄露会话令牌，已阻止发送');
  }
  // 出站文本清洗：输入法 emoji 剥离 + 表情/图片占位符清扫。
  // 根治规则：整条=纯占位（[表情:…] 之类）时先尝试翻译成真 QQ face（能识别出 id）；翻译不出就整条丢弃，
  // 绝不以文字形式发出"文字版表情"；只有整条是纯 emoji/颜文字（清扫占位数为 0）清洗为空时才保留原文，避免误删纯表情消息。
  const swept = sweepMessageArtifacts(rawMessage0);
  const strippedText = cleanOutboundText(rawMessage0);
  let rawMessage = strippedText;
  let artifactFaceId = null;
  if (swept.removed > 0 && strippedText === '') {
    const faceIdGuess = resolveArtifactFaceId(swept.tokens[0] ?? '');
    if (faceIdGuess != null) artifactFaceId = faceIdGuess;
    else log(`占位表情未能翻译成 QQ face，已丢弃不发 (${kind}:${id}): ${rawMessage0.slice(0, 50)}`);
  } else if (strippedText === '' && swept.removed === 0 && rawMessage0.trim() !== '') {
    rawMessage = redactKnownTokensOnly(rawMessage0);
  }
  if (artifactFaceId != null) segments.push({ type: 'face', data: { id: artifactFaceId } });
  if (imagePath) {
    // 本地图片路径：gif 用本地路径才能播放动画；webp/png/jpg 直接发。
    // 本机部署（bridge 与 NapCat 同机，Windows/裸机）：把源图片复制到本机可写临时目录
    // qq-bridge/state/sticker-tmp（writeStickerTmpFile 已迁移为本机路径），图段直接传该本机绝对路径，
    // NapCat 同机可读。（已迁移：曾映射服务器 Docker 挂载对 /root/napcat/... ↔ /app/napcat/...，
    //   以及 blue-fish-gifs / whale-memes 服务器专属目录，本机不存在 → ENOENT；
    //   不再构造死路径，源资源缺失时给友好提示。）
    let srcStat = null;
    try { srcStat = fs.statSync(imagePath); } catch {}
    if (!srcStat || !srcStat.isFile()) {
      throw new Error(`图片文件不存在或不可访问: ${imagePath}。请传本机真实存在的图片绝对路径；发内置表情包里的表情请用 qq_meme_search + qq_send_meme，发收藏表情请用 qq_send_sticker。`);
    }
    const buf = fs.readFileSync(imagePath);
    const ext = String(path.extname(imagePath) || '').replace(/^\./, '') || 'img';
    // 【2026-09-15 修「表情包一张都发不出去」】临时文件路径不能原样交给 NapCat：
    // 服务器上 NapCat 在 Docker 里，读不到宿主路径 → 必须按配置换成容器路径或 base64。
    const napcatFile = napcatImageFileArg(writeStickerTmpFile(buf, ext), cfgRef);
    segments.push({ type: 'image', data: { file: napcatFile } });
  }
  if (rawMessage) {
    // 解析 AI 手写的 [CQ:at,qq=xxx] 为真正的 at 消息段（纯文本 @ 不触发 QQ 提醒）；其余 [CQ: 仍转义防注入。
    const atPattern = /\[CQ:at,qq=(\d{5,12})\]/g;
    let hasAt = false;
    const atMatches = [];
    let m;
    while ((m = atPattern.exec(rawMessage)) !== null) {
      hasAt = true;
      atMatches.push({ qq: m[1], start: m.index, end: m.index + m[0].length });
    }
    // at 段后紧跟文本时补一个空格（QQ 规范：@昵称 后带空格，避免粘连成“@名字哎哎哎…”）
    const pushTextWithAtSpace = (txt) => {
      let t = txt;
      if (segments.length && segments[segments.length - 1].type === 'at' && !/^\s/.test(t)) t = ' ' + t;
      segments.push({ type: 'text', data: { text: escapeCqText(t) } });
    };
    if (hasAt) {
      let last = 0;
      for (const a of atMatches) {
        if (a.start > last) pushTextWithAtSpace(rawMessage.slice(last, a.start));
        segments.push({ type: 'at', data: { qq: a.qq } });
        last = a.end;
      }
      if (last < rawMessage.length) pushTextWithAtSpace(rawMessage.slice(last));
    } else {
      pushTextWithAtSpace(rawMessage);
    }
  }
  const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
  const buildParams = () => (kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments });
  const httpUrl = String(cfgRef.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  // 瞬时网络类错误自动重试一次(间隔 2.5s), 降低偶发抖动误报; 持续失败仍如实报错, 不做无限重试。
  //
  // 2026-09-11 补：原来只认**响应体**里的 1006514/网络连接异常，而日志里真实出现过的是
  // `QQ 发送失败 (private:***): fetch failed` —— fetch 层就失败了，拿不到响应，正则匹配不上，
  // 于是**不重试、静默丢弃**（只在日志留一行）。现在把 fetch 层失败也纳入，但**只重试
  // "确定没送出去"的连接级错误**：超时(AbortError/TimeoutError)绝不重试 —— 请求可能已经被
  // NapCat 处理并发出去了，重试会**真的发两遍**（比丢一条更糟）。
  const CONN_ERR = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ECONNABORTED/i;
  const isConnError = (e) => {
    const name = String(e?.name ?? '');
    if (name === 'AbortError' || name === 'TimeoutError') return false; // 超时可能已送出，禁止重试
    const code = String(e?.cause?.code ?? e?.code ?? '');
    return CONN_ERR.test(code);
  };
  const attemptSend = async () => {
    try {
      const res = await fetch(`${httpUrl}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfgRef.napcat?.accessToken ? { authorization: `Bearer ${cfgRef.napcat.accessToken}` } : {})
        },
        body: JSON.stringify(buildParams()),
        signal: AbortSignal.timeout(15000)
      });
      const body = await res.json().catch(() => ({}));
      return { res, body, fetchErr: null };
    } catch (fetchErr) {
      return { res: null, body: null, fetchErr };
    }
  };
  let { res, body, fetchErr } = await attemptSend();
  if (!res && fetchErr) {
    if (isConnError(fetchErr)) {
      const code = fetchErr?.cause?.code ?? fetchErr?.code ?? fetchErr?.message;
      log(`[send] ${kind}:${id} 连接级失败(${code})自动重试(1/1)`);
      await sleep(2500);
      ({ res, body, fetchErr } = await attemptSend());
    }
    if (!res && fetchErr) {
      const code = fetchErr?.cause?.code ?? fetchErr?.code ?? '';
      const abort = ['AbortError', 'TimeoutError'].includes(String(fetchErr?.name ?? ''));
      throw new Error(`OneBot ${action} 请求失败: ${fetchErr?.message ?? fetchErr}${code ? ` (${code})` : ''}${abort ? '（超时未重试：请求可能已送出，重试会导致重复发送）' : ''}`);
    }
  }
  const errText = `${body?.errMsg ?? ''} ${body?.wording ?? ''} ${body?.retcode ?? ''}`;
  if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
    if (/1006514|网络连接异常|网络.*异常/i.test(errText)) {
      log(`[send] ${kind}:${id} 触发网络异常重试(1/1): ${body.retcode || body.wording || res.status}`);
      await sleep(2500);
      const again = await attemptSend();
      res = again.res; body = again.body; fetchErr = again.fetchErr;
      if (!res && fetchErr) throw new Error(`OneBot ${action} 请求失败: ${fetchErr?.message ?? fetchErr}`);
    }
  }
  // 【2026-09-15 自愈】NapCat 读不到我们给的图片路径时的兜底重发（**只在明确"图没发出去"时**触发）：
  // 服务器 NapCat 在 Docker 里，宿主路径它读不到 → `文件处理失败: 识别URL失败, uri= /root/...`。
  // 配置（napcat.imageFileMode/dockerPathMap）配对了就不会走到这里；这里是配置漂移时的保险：
  // 把 image 段换成 base64:// 再发一次。该错误意味着**这条消息整体没发出去**，重发不会重复。
  const fileErrRe = /文件处理失败|识别URL失败|ENOENT|no such file/i;
  if (fileErrRe.test(errText)) {
    const imgSeg = segments.find((s) => s.type === 'image' && typeof s.data?.file === 'string' && !/^(base64|file|https?):\/\//i.test(s.data.file));
    if (imgSeg) {
      try {
        const buf = fs.readFileSync(imgSeg.data.file);
        imgSeg.data.file = `base64://${buf.toString('base64')}`;
        log(`[send] ${kind}:${id} NapCat 读不到路径（${errText.trim().slice(0, 60)}），改用 base64 重发(1/1)`);
        const again = await attemptSend();
        res = again.res; body = again.body; fetchErr = again.fetchErr;
        if (!res && fetchErr) throw new Error(`OneBot ${action} 请求失败: ${fetchErr?.message ?? fetchErr}`);
      } catch (eB64) {
        log(`[send] ${kind}:${id} base64 兜底重发失败: ${eB64?.message ?? eB64}`);
      }
    }
  }
  if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
    const hint = res.status === 426 ? '（HTTP 426：napcat.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 napcat.httpUrl 是否为 OneBot HTTP API 地址）' : '';
    throw new Error(`OneBot ${action} 失败: ${body.wording || body.errMsg || body.retcode || res.status}${hint}`);
  }
  return body.data;
}

// ── 智能引用：只引用「本回合真正交给过模型、并且这句话就在答的那条」────────────────
/** 参与相关度打分的词：英文/数字词（≥3 字符）+ 中文 2-gram */
export function smartQuoteGrams(text) {
  const t = String(text || '').toLowerCase();
  const set = new Set();
  for (const w of t.match(/[a-z0-9]{3,}/g) || []) set.add(w);
  const cjk = t.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let j = 0; j + 2 <= cjk.length; j += 1) set.add(cjk.slice(j, j + 2));
  return set;
}

export const SMART_QUOTE_WINDOW_MS = 10 * 60 * 1000;   // 候选消息的最大年龄
export const SMART_QUOTE_FALLBACK_MS = 120 * 1000;     // 没有本回合投递记录时，只认"刚到的"最新一条
export const SMART_QUOTE_REUSE_MS = 10 * 60 * 1000;    // 同一条消息多久内不再被自动引用
const SMART_QUOTE_MAX_CANDIDATES = 12;

/* 【2026-09-16 修「零相关也引用 = 引用错误」】
 * 主人 09-15 在群里实测（随后在私聊追问"你群聊里那个，引用错误了吧"）：
 *   群里 猫猫头 发了「吓哭了」+ 一张图 +「决定，绝地反击」+ 两个拍一拍，
 *   bot 回复「投降喵是什么投降法」，气泡上却挂着**「决定，绝地反击」的引用框**（工具结果里
 *   autoQuoted 报出来的就是那条的 messageId）。
 * 复盘：打分循环用 `hit >= bestScore`、初值 -1 且**没有下限**，于是"和这句话 0 个共同词"的候选
 * 也会被选出来 —— 候选多于一条时，这等于**按位置瞎猜**（挑最靠后的那条），正是"引用错误"的来源。
 * 现在两道收紧（方向统一是"**宁可不引用，也不张冠李戴**"，要引用由模型自己传 replyToMessageId）：
 *   ① 候选**多于一条**时至少要有 `SMART_QUOTE_MIN_SCORE` 个共同词才允许自动引用（默认 1）；
 *      候选只有一条时例外 —— 本回合只给过它这一条，引用它没有歧义（旧行为保留）；
 *   ② 打分前剔除"什么/就是/可以"这类高频 2-gram 停用词 —— 它们几乎和任何一句话都"有共同词"。
 */
export const SMART_QUOTE_MIN_SCORE = 1;

/** 高频中文 2-gram 停用词：命中它们不代表"在答这条"，反而制造假相关。 */
const SMART_QUOTE_STOP_GRAMS = new Set([
  '什么', '怎么', '这个', '那个', '我们', '你们', '他们', '她们', '自己', '可以', '不是', '就是',
  '没有', '一个', '现在', '时候', '然后', '因为', '所以', '但是', '如果', '真的', '知道', '觉得',
  '应该', '一下', '一样', '这么', '那么', '还是', '已经', '出来', '起来', '不好', '不是', '不能',
  '不会', '大家', '一点', '有点', '好像', '可能', '意思', '东西', '事情', '问题', '怎么', '为啥',
]);

function dropStopGrams(grams) {
  for (const g of [...grams]) if (SMART_QUOTE_STOP_GRAMS.has(g)) grams.delete(g);
  return grams;
}

/**
 * 自动智能引用：返回要引用的 messageId（字符串），不引用返回 null。
 *
 * 【2026-09-15 修「引用错误 + 看着像重复回复」】旧实现（2026-09-13 版）给"@过我 / 引用过我"的
 * 消息固定 +3 分，且对消息年龄没有任何约束、同分时保留**更早**的一条。于是只要近 12 条里有一条
 * 老消息引用了 bot，它就永远压过所有新消息：主人实测 —— 22:52:00 起连续 4 条回复
 * （"说好了啊" / "那就说定了" / "笑啥" / "私聊发不了表情包呜呜"）**全部引用了同一条 90 秒前的
 * "等我以后给你接入MC一起玩吧~"**，主人看到的就是"引用错误 + 重复回复"。
 *
 * 现在的判据（宁可不引用，也不张冠李戴）：
 *   ① 候选 = 本回合**真正投递过**的对端消息（`turnSeenUnread` 唤醒正文展示过 ∪ `turnSteeredSeqs`
 *      steer 注入过）—— 模型只可能回答它见过的东西；
 *      没有投递记录（主动发起 / 控制台发送）时，只认最近 2 分钟内到的**最新一条**，否则不引用；
 *   ② 打分只按"和这句话有共同词"（CJK 2-gram / 英文词，每命中 +1，上限 3），同分取更新的一条；
 *   ③ 最近 10 分钟已经自动引用过的消息不再引用（同一条不会被反复引用）。
 */
export function pickSmartQuote(st, bubbleText, opts = {}) {
  try {
    const now = Number(opts.now) || Date.now();
    const windowMs = Number(opts.windowMs) > 0 ? Number(opts.windowMs) : SMART_QUOTE_WINDOW_MS;
    const fallbackMs = Number(opts.fallbackMs) > 0 ? Number(opts.fallbackMs) : SMART_QUOTE_FALLBACK_MS;
    const msgs = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const peers = msgs
      .filter((m) => m && !m.isSelf && m.messageId
        && (now - Number(m.time || 0) < windowMs)
        && Number(m.time || 0) <= now)      // 未来时间戳不算（测试夹具/时钟偏移时别把"还没到的消息"当最新）
      .slice(-SMART_QUOTE_MAX_CANDIDATES);
    if (!peers.length) return null;

    const delivered = new Set(
      [...(Array.isArray(st?.turnSeenUnread) ? st.turnSeenUnread : []),
        ...(Array.isArray(st?.turnSteeredSeqs) ? st.turnSteeredSeqs : [])]
        .map(Number).filter((n) => Number.isFinite(n) && n > 0)
    );
    let cands = delivered.size ? peers.filter((m) => delivered.has(Number(m.seq))) : [];
    if (!cands.length) {
      const latest = peers[peers.length - 1];
      if (now - Number(latest.time || 0) > fallbackMs) return null;
      cands = [latest];
    }

    const usedRecently = new Set(
      (Array.isArray(st?.recentQuoteIds) ? st.recentQuoteIds : [])
        .filter((q) => q && now - Number(q.at || 0) < SMART_QUOTE_REUSE_MS)
        .map((q) => String(q.id))
    );
    const pool = cands.filter((m) => !usedRecently.has(String(m.messageId)));
    if (!pool.length) return null;

    const mine = dropStopGrams(smartQuoteGrams(bubbleText));
    let best = null;
    let bestScore = -1;
    for (const m of pool) {
      let hit = 0;
      if (mine.size) {
        const g = dropStopGrams(smartQuoteGrams(m.tail || m.plain || m.text || ''));
        for (const x of g) { if (mine.has(x)) { hit += 1; if (hit >= 3) break; } }
      }
      // >= ：同分保留时间更靠后（更新）的一条 —— 旧实现用 > 会永远挑最早的
      if (hit >= bestScore) { bestScore = hit; best = m; }
    }
    if (!best) return null;
    // 【2026-09-16】判定"依据够不够"：候选只有一条（本回合就给过它这一条）→ 无歧义，照旧引用；
    // 有**多条**候选却一个共同词都没有 → 纯属瞎猜（主人看到的"引用错误"就是这样来的），不引用。
    const need = pool.length > 1 ? SMART_QUOTE_MIN_SCORE : 0;
    if (bestScore < need) {
      log(`[quote] 自动引用放弃：候选有 ${pool.length} 条、最相关的一条只有 ${Math.max(0, bestScore)} 个共同词（需 ≥${need}）—— 宁可不引用，也不张冠李戴（模型要引用可自己传 replyToMessageId）`);
      return null;
    }
    /* 【2026-09-15 修「每句话都引用」】上面挑出来的候选，如果**就是最新一条对端消息**，
     * 那引用框纯属噪音 —— 大家都在看这一条，谁都知道你在回它。主人实测：私聊里每句回复
     * 都挂一个引用框，看着很机械。所以：
     *   · 回答最新那条 → 不自动引用；
     *   · 只有"你在答一条更早的消息"（候选不是最新的、或有共同词指向更早的）才引用，
     *     因为这时候引用框真的在帮你说明"我在回哪句"。
     * 模型想显式引用任何消息，随时可以自己传 replyToMessageId（qq_reply / qq_send_message）。 */
    const newestPeer = peers[peers.length - 1];
    if (newestPeer && String(best.messageId) === String(newestPeer.messageId)) return null;
    if (opts.record !== false && st && typeof st === 'object') {
      const prev = Array.isArray(st.recentQuoteIds) ? st.recentQuoteIds : [];
      st.recentQuoteIds = [...prev, { id: String(best.messageId), at: now }].slice(-30);
    }
    return String(best.messageId);
  } catch { return null; }
}

export function sendMessages(key, messages, delays, replyToMessageId, atUserId = null, images = []) {
  // 循环复读监测：AI 回合内通过本函数发出的文本计入本回合输出（2026-09-03）
  try {
    if (activeAiTurns.has(key) && Array.isArray(messages)) {
      const rawList = messages.map((m) => (m && typeof m === 'object') ? String(m.text ?? m.message ?? '') : String(m ?? ''));
      recordAiTurnOutbound(key, rawList);
    }
  } catch {}
  const [kind, id] = key.split(':');
  // 【2026-09-12 加速】这一次调用 = 一次新的"连发批"：清掉前几轮攒下的连续发送计数，
  // 让批内节奏从 0 / step / 2×step 起算（配合下面"首条不等节拍"，第一条气泡零延迟出）。
  resetSendPace(key);
  // 自动智能引用：候选 = 本回合真正投递过的那批消息，打分只按"共同词"，同分取更新的一条。
  // 规则与踩坑经过见本文件上方 pickSmartQuote 的注释（【2026-09-15 修引用错误 / 重复回复观感】）。
  const pickSmartQuoteFor = (k, bubbleText) => pickSmartQuote(getSocialState(k), bubbleText);
  const sent = [];
  const failed = [];
  const total = Math.max(messages.length, images.length);
  for (let i = 0; i < total; i++) {    const msg = messages[i] ?? '';
    const img = images[i] ?? null;
    // 模型显式指定的引用(显式 replyToMessageId)永远原样保留——复检只针对「自动智能引用」,
    // 否则显式引用一条较早消息也会被"必须是最新"规则悄悄摘掉引用, 用户看到的就是"引用失败"。
    const explicitQuote = replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '';
    const useAt = i === 0 ? atUserId : null;
    enqueueSend(async () => {
      // 自动智能引用在真正发送那一刻复检(防排队延迟后引用到过时消息); 显式引用不在此列
      // 自动智能引用：在真正发送那一刻按相关性挑（不再要求"必须是最新一条"）；显式引用永远原样保留。
      const useReply = i === 0
        ? (explicitQuote
          ? String(replyToMessageId).trim()
          : (cfgRef.social?.send?.smartQuoteEnabled !== false ? pickSmartQuoteFor(key, msg) : null))
        : null;
      // 发送线性节拍：pace=null=线性关闭 → 保留调用方传入的旧 delays 节奏；否则由会话连续计数决定。
      //
      // 【2026-09-12 加速 · 这是主人要的"qq_send_message 更快"】**这一条回复的第一条气泡不再等节拍**。
      // 线性节拍的设计意图（见 send-chain.js 顶部注释）是"唤醒/首轮即时，首条 n=0 → base（默认 0 → 秒醒，不延迟）"，
      // 它要管的是"同一条回复内部、分条之间的真人打字节奏"。但计数器 n 是**按整个会话**累加的
      // （只有静默超过 `social.send.linearResetMs` 才归零），于是热聊时 n 早早顶到 cap（1500ms），
      // **每条回复的第一条气泡也要先干等最多 1.5 秒**。
      // 实测（`state/tool-calls.jsonl` 245 次 `qq_send_message`）：
      //   · 245 次**全部是单条调用**（没有一次是"一次调多条"）→ 那 1.5 秒对当前行为**纯属白等**；
      //   · 中位 0.59s / 平均 1.21s / p90 2.55s，而 NapCat 自身 HTTP RTT 实测只有 **18ms**，
      //     全量日志里"发送失败/自动重试"**各 0 次** → 这段耗时就是桥自己 sleep 出来的。
      // 改成首条 = 0：模型一决定回，气泡立刻出；第 2 条起按"这条气泡自己打完要多久"等
      // （perChar 模式：字数 × linearPerCharMs，见 send-chain.js 顶部说明）。
      const pace = i === 0 ? 0 : nextSendPaceMs(key, String(msg || '').length);
      if (pace != null && pace > 0) await sleep(pace);
      try {
        const sendData = await onebotSend(kind, id, msg, useReply, useAt, img);
        // 记录真实 QQ message_id：撤回（qq_withdraw_message）与 (id:xxx) 展示都依赖它。
        // 【2026-09-15 主人要求"检查它是否知道自己引用了"】把**实际用上的引用目标**也带回去
        // （auto 引用以前是桥偷偷加的，工具结果里 quoted:null → 模型压根不知道自己引用了谁，
        //   于是它既无法解释、也无法自我纠正）。现在 sent[i].quoted 就是那条被引用的消息 id。
        sent.push({
          text: msg || (img ? '[图]' : ''),
          messageId: sendData && sendData.message_id != null ? String(sendData.message_id) : null,
          quoted: useReply ? String(useReply) : null,
        });
        if (pace != null) markSendDelivered(key, msg ? String(msg).length : 0);
      } catch (error) {
        log(`QQ 发送失败 (${key}):`, error?.message ?? error); if (error?.stack) log('[send-stack]', error.stack.split(String.fromCharCode(10)).slice(0, 8).join(' | '));
        failed.push(error);
      }
      // delays 可选：部分调用方（如音乐分享 sendMessages(key, [text])）不传；
      // 线性节拍关闭时直接取 length 会 TypeError（被发送链吞掉，'条间延迟'静默失效）。
      if (pace == null && Array.isArray(delays) && i < delays.length) await sleep(delays[i]);
    }, key);
  }
  return currentSendChain(key).then(() => {
    if (failed.length > 0) {
      const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
      err.sent = sent.slice();
      throw err;
    }
    return sent;
  });
}
