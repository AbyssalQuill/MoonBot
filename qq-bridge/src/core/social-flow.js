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

export function appendSocialMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = [], atSelf = false, files = []) {
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

export function findMessageMedia(key, ref) {
  const refStr = String(ref ?? '').trim();
  if (!refStr) return [];
  // default：消息对象上直接带 media（仅在确实存在default会话状态时读取，避免为 gen1 创建影子状态）
  if (currentMode === 'default' || social.conversations.has(key)) {
    try {
      const st = getSocialState(key);
      if (st && Array.isArray(st.recentMessages)) {
        const found = st.recentMessages.find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
        if (found && Array.isArray(found.media)) return found.media;
      }
    } catch {}
  }
  // 一代/普通模式：messageMediaStore
  const byRef = messageMediaStore.get(key);
  if (byRef) {
    const hit = byRef.get(refStr);
    if (Array.isArray(hit)) return hit;
    // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
    for (const [storedRef, media] of byRef) {
      if (String(storedRef) === refStr && Array.isArray(media)) return media;
    }
  }
  return [];
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
