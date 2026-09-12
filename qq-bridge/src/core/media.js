// 富媒体/卡片发送 + 音乐搜索
// 无跨域状态；cfg 由工厂参数静态注入。
import { sleep } from '../lib/async.js';
import { randInt } from '../lib/rand.js';
import { log } from '../lib/log.js';
import { enqueueSend } from './send-chain.js';

export function createMediaDomain(cfg) {

  // 发送富文本/卡片消息段（music/contact/location/json/xml/dice/rps），与文本/表情共用发送链。
  async function sendRich(key, seg, options = {}) {
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
      segments.push({ type: 'text', data: { text: ' ' } });
    }
    segments.push(seg);
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    let sendResolve;
    let sendReject;
    let settled = false;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = (v) => { settled = true; resolve(v); };
      sendReject = (e) => { settled = true; reject(e); };
    });
    const sendRun = enqueueSend(async () => {
      try {
        await sleep(randInt(500, 1500));
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.napcat?.accessToken ? { authorization: `Bearer ${cfg.napcat.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：napcat.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 napcat.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    }, key);
    // 会话重置/隔离（cancelKeyedSends）时 send-chain 会跳过已入链但未开始的任务——回调根本不会执行，
    // 上面的 sendResult 就永不 settle，调用方（qq_send_rich 等工具）会永久挂起。
    // 链上任务结算后仍未 settle，说明本任务被跳过，这里补一个明确失败。
    void sendRun.then(
      () => { if (!settled) sendReject(new Error('发送任务已被会话重置取消（未发出）')); },
      (e) => { if (!settled) sendReject(e); }
    );
    const data = await sendResult;
    return { messageId: data?.message_id ?? null };
  }

  // 音乐搜索（网易云/QQ音乐网页版，海外可访问）：返回可直接分享的歌曲链接，供"封面图+链接"分享用。
  async function musicSearch(query, platform = 'all', limit = 5) {
    const q = String(query ?? '').trim();
    if (!q) throw new Error('搜索关键词不能为空');
    const max = Math.min(10, Math.max(1, Number(limit) || 5));
    const results = [];
    const platforms = platform === 'netease' ? ['netease'] : platform === 'qqmusic' ? ['qqmusic'] : ['netease', 'qqmusic'];
    if (platforms.includes('netease')) {
      try {
        const url = `https://music.163.com/api/search/get?s=${encodeURIComponent(q)}&type=1&offset=0&limit=${max}`;
        const res = await fetch(url, { headers: { 'Referer': 'https://music.163.com', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
        const body = await res.json().catch(() => null);
        for (const s of (body?.result?.songs || []).slice(0, max)) {
          results.push({
            platform: 'netease',
            title: String(s?.name || ''),
            artist: Array.isArray(s?.artists) ? s.artists.map((a) => a?.name || '').filter(Boolean).join('/') : '',
            album: String(s?.album?.name || ''),
            id: String(s?.id || ''),
            url: s?.id ? `https://music.163.com/#/song?id=${s.id}` : '',
            cover: String(s?.album?.picUrl || s?.album?.artist?.img1v1Url || ''),
            duration: Number(s?.duration) || 0
          });
        }
      } catch (error) {
        log(`[music-search] 网易云搜索失败: ${error?.message ?? error}`);
      }
    }
    if (platforms.includes('qqmusic')) {
      try {
        const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(q)}&format=json&n=${max}&cr=1&t=0`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const body = await res.json().catch(() => null);
        for (const s of (body?.data?.song?.list || []).slice(0, max)) {
          const mid = String(s?.songmid || s?.media_mid || '');
          results.push({
            platform: 'qqmusic',
            title: String(s?.songname || ''),
            artist: Array.isArray(s?.singer) ? s.singer.map((a) => a?.name || '').filter(Boolean).join('/') : '',
            album: String(s?.albumname || ''),
            id: mid,
            url: mid ? `https://y.qq.com/n/ryqq/songDetail/${mid}` : '',
            cover: s?.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg` : '',
            duration: Number(s?.interval) || 0
          });
        }
      } catch (error) {
        log(`[music-search] QQ音乐搜索失败: ${error?.message ?? error}`);
      }
    }
    return { query: q, platform, results };
  }

  return { sendRich, musicSearch };
}
