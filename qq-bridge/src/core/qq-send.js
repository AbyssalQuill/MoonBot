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
      // 改成首条 0 → 模型一决定回，气泡立刻出；第 2 条起仍按线性节拍，分条节奏不变。
      const pace = isFirst ? 0 : nextSendPaceMs(key);
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
  // 拟人停顿参数来源（social.send）。此前下方直接引用未声明的 socialCfg → 一旦走「线性节拍关闭」
  // 分支（pace=null 且非最后一条）就抛 ReferenceError，被发送链吞掉 → 条间间隔全部失效、连发。
  const socialCfg = (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) ? socialCfgOrMin : null;
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
    const isLast = i === messages.length - 1;
    enqueueSend(async () => {
      // 发送线性节拍：pace=null=线性关闭 → 保留旧条间节奏；否则按会话连续计数线性等（条间/跨回合统一）
      // 【2026-09-12 加速】首条不等节拍，理由与 sendMessages 处相同（那 1.5s 对单条调用纯属白等）。
      const pace = i === 0 ? 0 : nextSendPaceMs(key);
      if (pace != null && pace > 0) await sleep(pace);
      try {
        if (kind === 'private') await withTimeout(botRef.sendPrivateMessage(Number(id), qqTextSeg(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        else await withTimeout(botRef.sendGroupMessage(Number(id), qqTextSeg(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        sent.push(msg);
        if (pace != null) markSendDelivered(key, msg.length);
      } catch (error) { log(`QQ 发送失败 (${key}):`, error?.message ?? error); if (error?.stack) log('[send-stack]', error.stack.split(String.fromCharCode(10)).slice(0, 8).join(' | ')); }
      if (pace == null && !isLast) {
        // 按字数线性延迟 + 随机抖动：base + 每字递增，再乘抖动系数，模拟真人打字忽快忽慢的停顿
        // 显式配置的 0 就是 0（2026-09-11 修）：原用 `Number(x) || 默认值`，导致下面注释承诺的
        // "gapBaseMs/gapPerCharMs 都配 0 = 秒回"永远不成立（0 被当成没配 → 3500/140）。
        const numCfg = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
        const baseMs = Math.max(0, numCfg(socialCfg?.gapBaseMs, 3500));
        const perCharMs = Math.max(0, numCfg(socialCfg?.gapPerCharMs, 140));
        const jitterRatio = Math.min(1, Math.max(0, numCfg(socialCfg?.gapJitterRatio, 0.3)));
        const chars = Math.max(1, String(msg || '').length);
        let delay = baseMs + chars * perCharMs;
        if (jitterRatio > 0) delay = delay * (1 - jitterRatio + Math.random() * jitterRatio * 2);
        // 秒回开关：gapBaseMs/gapPerCharMs 都配 0 → 视为关闭拟人停顿，多气泡也基本连发(下限 250ms)；
        // 否则保留原 ≥1.8s 的真人节奏下限
        const instant = baseMs <= 0 && perCharMs <= 0;
        delay = Math.min(15000, Math.max(instant ? 250 : 1800, Math.round(delay)));
        await sleep(delay);
      }
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
      throw new Error(`图片文件不存在或不可访问: ${imagePath}。请传本机真实存在的图片绝对路径；发鲸鱼娘同人表情请用 qq_whale_meme_search + qq_send_whale_meme，发收藏表情请用 qq_send_sticker。`);
    }
    const buf = fs.readFileSync(imagePath);
    const ext = String(path.extname(imagePath) || '').replace(/^\./, '') || 'img';
    const napcatFile = writeStickerTmpFile(buf, ext);
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
  const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
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
        body: JSON.stringify(params),
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
  if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
    const hint = res.status === 426 ? '（HTTP 426：napcat.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 napcat.httpUrl 是否为 OneBot HTTP API 地址）' : '';
    throw new Error(`OneBot ${action} 失败: ${body.wording || body.errMsg || body.retcode || res.status}${hint}`);
  }
  return body.data;
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
  // 智能引用发送时刻复检: 引用对象必须仍是「对话里最新一条 @/引用自己」的消息, 否则放弃引用,
  // 避免排队/节拍延迟(通常 0~4s+)期间群里又来人/再 @ 时, 把旧消息当最新引用(引用回复不精确)。
  const recheckSmartReply = (k, wanted) => {
    if (wanted === null || wanted === undefined) return null;
    try {
      const stQ = getSocialState(k);
      const nowQ = Date.now();
      const msgs = Array.isArray(stQ.recentMessages) ? stQ.recentMessages : [];
      const recentNonSelf = [...msgs].reverse().find((mm) => mm && !mm.isSelf);
      if (!recentNonSelf || !recentNonSelf.messageId) return null;
      const recentAt = [...msgs].reverse().find((mm) => mm && !mm.isSelf && (mm.atSelf || mm.quoteTargetIsSelf) && mm.messageId && (nowQ - Number(mm.time || 0) < 600000));
      if (!recentAt || String(recentAt.messageId) !== String(wanted)) return null;
      if (String(recentNonSelf.messageId) !== String(recentAt.messageId)) return null;
      return String(wanted);
    } catch { return null; }
  };
  const sent = [];
  const failed = [];
  const total = Math.max(messages.length, images.length);
  for (let i = 0; i < total; i++) {    const msg = messages[i] ?? '';
    const img = images[i] ?? null;
    // 模型显式指定的引用(显式 replyToMessageId)永远原样保留——复检只针对「自动智能引用」,
    // 否则显式引用一条较早消息也会被"必须是最新"规则悄悄摘掉引用, 用户看到的就是"引用失败"。
    const explicitQuote = replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '';
    let smartReply = replyToMessageId;
    if (!explicitQuote && kind === 'group' && cfgRef.social?.send?.smartQuoteEnabled !== false) {
      // 智能引用（默认开启但严格受限）：只有「最近 10 分钟内有人 @ 我/引用我」且「那条消息就是对话里最新一条别人发的消息」时，
      // 才自动引用——这时机器人就是直接回复对方，挂引用不会错。
      // 若 @ 我之后又有别人发言（机器人大概率是在回更新的消息），绝不自动引用，避免张冠李戴（引用 A 的话来回复 B）。
      try {
        const stSmart = getSocialState(key);
        const nowSmart = Date.now();
        const recentNonSelf = [...(Array.isArray(stSmart.recentMessages) ? stSmart.recentMessages : [])].reverse().find((mm) => mm && !mm.isSelf);
        const recentAt = [...(Array.isArray(stSmart.recentMessages) ? stSmart.recentMessages : [])].reverse().find((mm) => mm && !mm.isSelf && (mm.atSelf || mm.quoteTargetIsSelf) && mm.messageId && (nowSmart - Number(mm.time || 0) < 600000));
        const lastNonSelfRef = recentNonSelf ? String(recentNonSelf.messageId || recentNonSelf.seq || '') : '';
        if (recentAt && lastNonSelfRef && String(recentAt.messageId) === lastNonSelfRef) {
          smartReply = String(recentAt.messageId);
        }
      } catch {}
    }
    const useAt = i === 0 ? atUserId : null;
    enqueueSend(async () => {
      // 自动智能引用在真正发送那一刻复检(防排队延迟后引用到过时消息); 显式引用不在此列
      const useReply = i === 0 ? (explicitQuote ? smartReply : recheckSmartReply(key, smartReply)) : null;
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
      // 改成首条 = 0：模型一决定回，气泡立刻出；第 2 条起仍走线性节拍，**分条节奏完全不变**。
      const pace = i === 0 ? 0 : nextSendPaceMs(key);
      if (pace != null && pace > 0) await sleep(pace);
      try {
        const sendData = await onebotSend(kind, id, msg, useReply, useAt, img);
        // 记录真实 QQ message_id：撤回（qq_withdraw_message）与 (id:xxx) 展示都依赖它
        sent.push({
          text: msg || (img ? '[图]' : ''),
          messageId: sendData && sendData.message_id != null ? String(sendData.message_id) : null
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
