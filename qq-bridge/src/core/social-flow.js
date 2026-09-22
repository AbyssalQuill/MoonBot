// default default 消息流写入/引用解析
import { redactKnownTokensOnly } from '../lib/outbound-text.js';
import { log } from '../lib/log.js';
import { sanitizeForwardId } from '../forward.js';
import { persistChatMessage, recentChatMessages } from './memory.js';
import { getSocialState, saveSocialState, social, seenForwardIds } from './social-state.js';
import { messageMediaStore } from './session-state.js';
import { currentMode } from './mode.js';
import { resolveReplyInfo } from './message-cache.js';

let cfgRef = null;
export function initSocialFlowCore(cfg) { cfgRef = cfg; }

export function appendSocialMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = [], atSelf = false, files = [], quoteTargetId = null) {
  const st = getSocialState(key);
  const recentLimit = Number(cfgRef.social?.context?.recentLimit) || 100;
  const unreadLimit = Number(cfgRef.social?.context?.unreadLimit) || 30;
  const safeMedia = Array.isArray(media) ? media.map((m) => ({
    kind: m?.kind === 'face' ? 'face' : 'image',
    file: m?.file ? String(m.file) : undefined,
    url: m?.url ? String(m.url) : undefined,
    faceId: m?.faceId ? String(m.faceId) : undefined
  })).filter((m) => m.kind === 'face' ? !!m.faceId : !!(m.file || m.url)) : [];
  const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
  if (safeForwardIds.length) {
    let set = seenForwardIds.get(key);
    if (!set) {
      set = new Set();
      seenForwardIds.set(key, set);
    }
    for (const fid of safeForwardIds) set.add(fid);
    // 有界：最多保留 1000 个最近见过的 forward id
    if (set.size > 1000) {
      for (const old of set) {
        set.delete(old);
        if (set.size <= 1000) break;
      }
    }
  }
  const msg = {
    seq: (st.lastUnreadSeq || 0) + 1,
    messageId: messageId != null ? String(messageId) : null,
    sender,
    userId: userId != null ? String(userId) : null,
    text: String(textContent).slice(0, 200),
    plain: String(plainContent ?? textContent).slice(0, 200),
    tail: String(plainContent ?? textContent).slice(-200),
    quoteTargetIsSelf: !!quoteTargetIsSelf,
    /* 【2026-09-22】把被引用那条消息的 id 一并记住：主人"引用着自己的图 + 让我转进群"时，
     * 图在**被引用的那条**里，而模型手上只有当前这条的 id —— 找不到 id 就只能联网搜一张差不多的。
     * findMessageMedia 会沿这个 id 往下找一层（见该函数注释）。 */
    quoteTarget: quoteTargetId != null && String(quoteTargetId).trim() !== '' ? String(quoteTargetId) : '',
    atSelf: !!atSelf,
    isOwner: !!isOwner,
    ownerLabel: isOwner ? `管理员（ownerQQ ${cfgRef.ownerQQ ?? ''}）` : '',
    isSelf: false,
    media: safeMedia,
    hasMedia: safeMedia.length > 0,
    files: (Array.isArray(files) ? files : []).slice(0, 5),
    hasFile: Array.isArray(files) && files.length > 0,
    forwardIds: safeForwardIds,
    hasForward: safeForwardIds.length > 0,
    time: Date.now()
  };
  st.lastUnreadSeq = msg.seq;
  st.lastIncomingAt = Date.now();
  // 【2026-09-15 主人要求「不停打字发消息，打字状态应该是不断的」】
  // QQ 的 input_status 事件并不可靠（有时只在开始/结束各来一次，中间一直打字也不重发），
  // 所以这里用"消息本身"续上打字窗口：收到对方一条消息 = ta 刚才在打字，很可能还在接着打。
  // 私聊才这么做（群里多人说话不代表某一个人在连续打字，误续会把群聊唤醒拖慢）。
  if (String(key).startsWith('private:') && cfgRef?.social?.typing?.enabled !== false) {
    const refreshMs = Number(cfgRef?.social?.typing?.refreshOnMessageMs);
    const keep = Number.isFinite(refreshMs) && refreshMs >= 0 ? refreshMs : 5000;
    if (keep > 0) {
      const until = Date.now() + keep;
      if (!st.peerTypingSince) st.peerTypingSince = Date.now();
      st.peerTypingUntil = Math.max(Number(st.peerTypingUntil) || 0, until);
    }
  }
  st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废
  st.preSleepWaitObservedAt = 0;
  st.preSleepWaitAccumMs = 0;
  st.recentMessages.push(msg);
  if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
  st.unread.push(msg);
  if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
  const lowerPlain = String(plainContent ?? textContent ?? '');
  for (const t of st.activeTopics || []) {
    if (!t || typeof t !== 'object') continue;
    const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
    const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
    if (topicHit || participantHit) t.lastMentionAt = Date.now();
  }
  persistChatMessage(key, msg);
  saveSocialState();
}

export function appendSocialPoke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
  const st = getSocialState(key);
  const recentLimit = Number(cfgRef.social?.context?.recentLimit) || 100;
  const unreadLimit = Number(cfgRef.social?.context?.unreadLimit) || 30;
  const actor = String(sender || userId || '未知');
  const target = targetIsSelf ? '你' : (String(targetId || '未知'));
  const actionText = action ? String(action) : '拍了拍';
  const suffixText = suffix ? ` ${String(suffix)}` : '';
  const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
  const msg = {
    seq: (st.lastUnreadSeq || 0) + 1,
    messageId: null,
    sender: actor,
    userId: userId != null ? String(userId) : null,
    text,
    plain: text,
    tail: text,
    kind: 'poke',
    quoteTargetIsSelf: !!targetIsSelf,
    isOwner: !!isOwner,
    ownerLabel: isOwner ? `管理员（ownerQQ ${cfgRef.ownerQQ ?? ''}）` : '',
    isSelf: false,
    media: [],
    hasMedia: false,
    forwardIds: [],
    hasForward: false,
    poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
    time: Date.now()
  };
  st.lastUnreadSeq = msg.seq;
  st.lastIncomingAt = Date.now();
  st.preSleepWaitSatisfiedAt = 0;
  st.preSleepWaitObservedAt = 0;
  st.preSleepWaitAccumMs = 0;
  st.recentMessages.push(msg);
  if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
  st.unread.push(msg);
  if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
  persistChatMessage(key, msg);
  saveSocialState();
  return msg;
}

/**
 * 引用解析失败时给模型的「可用 id 候选」提示。
 * 模型常常把本地 seq 或过期 id 当 message id 传进来，只回一句“解析失败”它会换着猜、
 * 反复重试；直接把它刚看到的那几条真实 id 列出来，一次就能改对。
 */
export function replyTargetHint(key) {
  try {
    const st = getSocialState(key);
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const ids = recent
      .filter((m) => m && m.messageId)
      .slice(-6)
      .map((m) => `${m.isSelf ? '我' : (m.sender || '对方')}=${m.messageId}`);
    return ids.length ? `。本会话最近可引用的真实 message id：${ids.join('、')}` : '';
  } catch {
    return '';
  }
}

export async function resolveReplyTarget(st, kind, convId, ref) {
  const refStr = String(ref ?? '').trim();
  if (!refStr) return null;
  const found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
  // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
  if (found && found.messageId && String(found.messageId) !== refStr) {
    const realId = String(found.messageId);
    const realInfo = await resolveReplyInfo(kind, convId, realId);
    log(`[reply-target] seq=${refStr} 映射为真实 id=${realId}（${kind}:${convId}${realInfo ? '' : '，OneBot 未返回详情，用本地记录兜底'}）`);
    return {
      info: realInfo || {
        sender: String(found.sender || ''),
        text: String(found.text || found.plain || '').slice(0, 200),
        userId: null,
        messageId: realId,
        seq: found.seq
      },
      messageId: realId
    };
  }
  let info = await resolveReplyInfo(kind, convId, refStr);
  if (info) {
    // ref 实际命中的是「本地 seq」（OneBot 查不到这个 id，靠 DB 按本地 seq 兜底命中）：
    // 必须换成该行的真实 message id 再引用；该行没有真实 id（拍一拍/系统记录）则直接判失败。
    // 否则会把本地 seq 当 message id 发给 QQ —— 引用到一条无关消息，或整条发送失败却回 ok。
    if (info.matchedBySeq) {
      const realIdBySeq = info.messageId ? String(info.messageId) : '';
      if (!realIdBySeq) {
        log(`[reply-target] ref=${refStr} 命中的是本地 seq 且该消息没有真实 message id（${String(info.sender || '未知')}：${String(info.text || '').slice(0, 20)}），拒绝作为引用 id`);
        return null;
      }
      log(`[reply-target] ref=${refStr} 按本地 seq 命中，改用真实 id=${realIdBySeq}（${kind}:${convId}）`);
      return { info, messageId: realIdBySeq };
    }
    return { info, messageId: refStr };
  }
  if (found && found.messageId) {
    const realId = String(found.messageId);
    const realInfo = await resolveReplyInfo(kind, convId, realId);
    return {
      info: realInfo || {
        sender: String(found.sender || ''),
        text: String(found.text || found.plain || '').slice(0, 200),
        userId: null,
        messageId: realId,
        seq: found.seq
      },
      messageId: realId
    };
  }
  // 内存 miss（超窗/重启后窗口为空）→ SQLite chat_messages 兜底：DB 是撤回/引用/上下文回退的可靠事实源。
  // 只做 messageId / 本地 seq 精确匹配（“按最近时间对齐”容易误命中无关消息，不做）；
  // 已撤回（recalled_at>0）的行不参与引用解析，避免把 [已撤回] 内容当引用目标。
  try {
    const convKeyDb = kind === 'group' ? `group:${String(convId)}` : `private:${String(convId)}`;
    const dbRows = recentChatMessages(convKeyDb, 60);
    if (dbRows.length) {
      const dbById = dbRows.find((m) => m && !m.recalled && m.messageId && String(m.messageId) === refStr);
      const dbBySeq = dbRows.find((m) => m && !m.recalled && m.messageId && Number(m.seq) > 0 && String(m.seq) === refStr);
      const dbHit = dbById || dbBySeq;
      if (dbHit) {
        const realIdDb = String(dbHit.messageId);
        const infoDb = {
          sender: String(dbHit.sender || dbHit.userId || ''),
          text: String(dbHit.text || '').slice(0, 200),
          userId: dbHit.userId || null,
          messageId: realIdDb,
          seq: Number(dbHit.seq) || 0,
          time: Number(dbHit.time) || 0
        };
        log(`[reply-target] DB 兜底命中引用目标 ${convKeyDb} ref=${refStr} → id=${realIdDb}`);
        return { info: infoDb, messageId: realIdDb };
      }
    }
  } catch (error) {
    log(`[reply-target] DB 兜底解析引用失败 ${kind}:${String(convId)} ref=${refStr}: ${error?.message ?? error}`);
  }
  log(`[reply-target] 引用解析失败 ${kind}:${String(convId)} ref=${refStr}（OneBot 与 DB 均无此 id）${replyTargetHint(kind === 'group' ? `group:${convId}` : `private:${convId}`)}`);
  return null;
}

export async function isQuoteTargetSelf(message, kind, id, selfId) {
  if (!Array.isArray(message) || selfId == null) return false;
  for (const seg of message) {
    if (seg?.type === 'reply' && seg.data?.id != null) {
      const info = await resolveReplyInfo(kind, id, String(seg.data.id), selfId);
      if (info?.userId && String(info.userId) === String(selfId)) return true;
    }
  }
  return false;
}


// P5-10 追加

export function recordSentMessages(key, messages) {
  const st = getSocialState(key);
  const now = Date.now();
  const recentLimit = Number(cfgRef.social?.context?.recentLimit) || 100;
  const list = Array.isArray(messages) ? messages : [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    // 兼容旧调用传字符串；新调用传 { text, messageId }（sendMessages 捕获真实 QQ message_id，供撤回使用）
    const raw = (item && typeof item === 'object') ? String(item.text ?? '') : String(item ?? '');
    const messageId = (item && typeof item === 'object' && item.messageId != null) ? String(item.messageId) : null;
    const text = redactKnownTokensOnly(raw).slice(0, 200);
    const sentEntry = {
      messageId,
      sender: '我',
      text,
      plain: text,
      quoteTargetIsSelf: false,
      isOwner: true,
      ownerLabel: '我',
      isSelf: true,
      time: now + i * 1000
    };
    st.recentMessages.push(sentEntry);
    persistChatMessage(key, sentEntry);
  }
  if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
  // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
  st.preSleepWaitSatisfiedAt = 0;
  st.preSleepWaitObservedAt = 0;
  st.preSleepWaitAccumMs = 0;
  saveSocialState();
}


// P5-11 追加

export function findMessageMedia(key, ref, opts = {}) {
  const wantInfo = opts.info === true;
  const refStr = String(ref ?? '').trim();
  const miss = () => (wantInfo ? { media: [], viaQuote: false, quoteMessageId: '', ref: refStr, foundIn: '' } : []);
  if (!refStr) return miss();

  /* 在某个会话的内存窗口（或媒体登记表）里按 messageId / seq 找一条消息对象 */
  const lookupIn = (sKey, r) => {
    if (currentMode === 'default' || social.conversations.has(sKey)) {
      try {
        const st = getSocialState(sKey);
        if (st && Array.isArray(st.recentMessages)) {
          const found = st.recentMessages.find((m) => m && (String(m.messageId || '') === r || String(m.seq || '') === r));
          if (found) return found;
        }
      } catch {}
    }
    const byRef = messageMediaStore.get(sKey);
    if (byRef) {
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === r && Array.isArray(media)) return { media };
      }
    }
    return null;
  };

  /* 【2026-09-22 第三轮修 · 之二】跨会话转发时传进来的 `key` 是**目的地**（例如 group:1072393236），
   * 而那张图明明躺在**发起会话**（private:…）的记忆窗口里 —— 只按 key 找必然找不到，
   * 模型于是又退回"联网搜一张差不多的"。QQ 的 message_id 是全局唯一的，所以这里按序找：
   * 先目的地、再**所有已存在的会话**，并回报到底在哪个会话里找到的。 */
  const lookupEntry = (r) => {
    const hit = lookupIn(key, r);
    if (hit) return { entry: hit, foundIn: key };
    if (opts.anywhere === false) return null;
    const keys = [];
    try {
      for (const k of social.conversations.keys()) if (k !== key) keys.push(k);
    } catch {}
    try {
      for (const k of messageMediaStore.keys()) if (k !== key && !keys.includes(k)) keys.push(k);
    } catch {}
    for (const k of keys) {
      const h = lookupIn(k, r);
      if (h) return { entry: h, foundIn: k };
    }
    return null;
  };

  const hit0 = lookupEntry(refStr);
  const media = Array.isArray(hit0?.entry?.media) ? hit0.entry.media : [];
  if (media.length) {
    return wantInfo ? { media, viaQuote: false, quoteMessageId: '', ref: refStr, foundIn: hit0.foundIn } : media;
  }

  /* 本身没图 → 沿"被引用的那条"往下找一层。
   * 现场：主人在私聊里**引用着自己刚发的那张图**说"现在把我这张图转发到实验群"，
   * 图在被引用的那条消息里；模型只拿得到当前这条的 id，于是只能联网搜一张差不多的
   * （主人看到的就是"我要代码图，群里来了张鲸鱼图"）。 */
  const quoteRef = String(hit0?.entry?.quoteTarget ?? '').trim();
  if (quoteRef && quoteRef !== refStr) {
    const qHit = lookupEntry(quoteRef);
    const qMedia = Array.isArray(qHit?.entry?.media) ? qHit.entry.media : [];
    if (qMedia.length) {
      if (wantInfo) return { media: qMedia, viaQuote: true, quoteMessageId: quoteRef, ref: refStr, foundIn: qHit.foundIn };
      return qMedia;
    }
  }
  return miss();
}


// P6-3

export function recordDocxSent(key, sent) {
  const st = getSocialState(key);
  st.recentMessages.push({
    messageId: sent.fileId ? String(sent.fileId) : null,
    sender: '我',
    text: `[文档:${sent.fileName}]`,
    plain: `[文档:${sent.fileName}]`,
    quoteTargetIsSelf: false,
    isOwner: true,
    ownerLabel: '我',
    isSelf: true,
    media: [],
    hasMedia: false,
    forwardIds: [],
    hasForward: false,
    docFile: { fileName: sent.fileName, fileId: sent.fileId, size: sent.size },
    time: Date.now()
  });
  const recentLimit = Number(cfgRef.social?.context?.recentLimit) || 100;
  if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
  persistChatMessage(key, st.recentMessages[st.recentMessages.length - 1]);
  st.lastAiReplyAt = Date.now();
  st.lastActionAt = Date.now();
  st.wakeConfig.noActionCount = 0;
  saveSocialState();
}
