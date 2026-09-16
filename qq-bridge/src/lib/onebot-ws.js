// NapCat OneBot v11 WebSocket 长连接客户端（2026-09-07 三期：直连 NapCat，旧版网关 SDK 依赖已移除）。
// - 纯 Node 内置 WebSocket（Node >= 22，undici），零第三方依赖；
// - 自动重连：已成功连接后断线按指数退避+抖动无限重连；心跳 watchdog 超时强制重建；
// - 断线期间出站 action 进入有界队列，恢复后按序补发；
// - 事件归一化：OneBot post_type → 既有桥接订阅接口
//   （onPrivateMessage / onGroupMessage / onNotice('notify') / onNotice(fn) / onRequest('friend') / on('open'|'close'|'error')）。
import { EventEmitter } from 'node:events';

const RECONNECT_BASE_MS = 1500;
// 【2026-09-15 修「又不回复了：桥连不上 NapCat 却一直刷错误」】见 _scheduleReconnect 的调用点。
// 原来这里封顶 30 秒：一旦 NapCat 侧重登/重启（WS 服务短暂拒绝连接），桥最长要等 30 秒才再试一次，
// 而且连续失败时退避会一直停在 30 秒 —— 实测出现"账号已重新登好、桥却还在刷 NapCat 错误"的状态，
// 直到手动重启桥才接上。封顶降到 10 秒：代价只是失败时多几次握手，收益是几秒内自动接回。
const RECONNECT_MAX_MS = 10000;
/* 【2026-09-16 强化 NapCat 连接】
 * ① 看门狗 90s → 45s：NapCat 正常每 5 秒会推一次心跳(meta_event)，45 秒没有任何下行就已经不正常了，
 *    90 秒纯属让"聋掉"多存在一倍时间。
 * ② 新增**主动探活**：安静超过 20 秒就主动问一句 `get_status`（8 秒超时）。
 *    回应了就说明链路真的活着（同时刷新活跃时间，避免误判）；没回应就立刻判死重建 ——
 *    原来的看门狗要等满 45/90 秒，现在最坏 ~28 秒就恢复。 */
const HEARTBEAT_WATCHDOG_MS = 45000;
const HEARTBEAT_PROBE_MS = 20000;   // 安静超过它就去探活
const HEARTBEAT_PROBE_TIMEOUT_MS = 8000;
const HEARTBEAT_TICK_MS = 5000;     // 探活检查的节拍
const CONNECT_TIMEOUT_MS = 15000;
const SEND_TIMEOUT_MS = 20000;
const OUTBOX_MAX = 200;

/** 与旧 SDK text() 等价的分段构造：纯文本段 */
export function qqTextSeg(s) {
  return { type: 'text', data: { text: String(s ?? '') } };
}

/* 【2026-09-16 强化 NapCat 连接】把最近一个客户端的连接诊断暴露出来，
 * 供桥的控制台 / 管理端卡片显示"桥→NapCat 到底连上没有、多久没动静、重连过几次"。 */
let lastClientRef = null;
export function napcatClientStats() {
  try { return lastClientRef?.stats?.() ?? null; } catch { return null; }
}

export class OneBotWsClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    lastClientRef = this;
    this.url = String(opts.url ?? '');
    this.accessToken = opts.accessToken || '';
    this.reconnect = opts.reconnect !== false;
    this.sendTimeoutMs = Number(opts.sendTimeoutMs) || SEND_TIMEOUT_MS;
    this._seq = 0;
    this._pending = new Map(); // echo -> { resolve, reject, timer }
    this._ws = null;
    this._everOpened = false;
    this._closed = false;
    this._connecting = false;
    this._reconnectTimer = null;
    this._watchdog = null;
    this._lastActivityAt = 0;
    this._outbox = [];
    this._reconnectAttempts = 0;
    this._reconnects = 0;                 // 累计成功重连次数（诊断用）
    this._heartbeatTimer = null;
    // 探活参数可被构造选项覆盖（测试里把它调小，避免等 20 秒）
    this.heartbeatProbeMs = Number(opts.heartbeatProbeMs) > 0 ? Number(opts.heartbeatProbeMs) : HEARTBEAT_PROBE_MS;
    this.heartbeatWatchdogMs = Number(opts.heartbeatWatchdogMs) > 0 ? Number(opts.heartbeatWatchdogMs) : HEARTBEAT_WATCHDOG_MS;
    this.heartbeatProbeTimeoutMs = Number(opts.heartbeatProbeTimeoutMs) > 0 ? Number(opts.heartbeatProbeTimeoutMs) : HEARTBEAT_PROBE_TIMEOUT_MS;
    this.heartbeatTickMs = Number(opts.heartbeatTickMs) > 0 ? Number(opts.heartbeatTickMs) : HEARTBEAT_TICK_MS;
    this._sub = { private: [], group: [], notify: [], noticeAll: [], friendRequest: [] };
    this._openResolve = null;
    this._openReject = null;
  }

  // ── 订阅接口（与旧 NapCatWebSocketClient 对齐） ────────────────
  onPrivateMessage(fn) { this._sub.private.push(fn); return this; }
  onGroupMessage(fn) { this._sub.group.push(fn); return this; }
  /** kind='notify' 订阅通知（拍一拍/输入状态）；不传 kind 订阅全部 notice */
  onNotice(kind, fn) {
    if (typeof kind === 'function') this._sub.noticeAll.push(kind);
    else if (kind === 'notify') this._sub.notify.push(fn);
    else if (kind != null) this._sub.noticeAll.push(fn);
    return this;
  }
  onRequest(kind, fn) {
    if (kind === 'friend' && fn) this._sub.friendRequest.push(fn);
    return this;
  }

  /** 安全 emit('error')：无监听器时写 stderr 而不是让 EventEmitter 抛出（避免进程被未监听 error 带崩） */
  _emitError(e) {
    if (this.listenerCount('error') > 0) this.emit('error', e);
    else console.error('[onebot-ws]', e?.message ?? e);
  }

  /** 连接：首次成功 open 前挂起；NapCat 完全不可达（closed before open）则 reject（对齐旧启动语义） */
  connect(timeoutMs = Math.max(CONNECT_TIMEOUT_MS * 2, 20000)) {
    /* 【2026-09-14 修「启动Bot 后 3100 永远不通」】
     * 现场：服务器上 NapCat 容器起着、但**还没扫码登录**，它的 OneBot WS 端口在听、却不会完成 upgrade。
     * 于是 ws 卡在 readyState=0：`_openOnce` 里那句 `ws.close(4000,'connect timeout')` 对 CONNECTING 的
     * socket 是**空操作**（WHATWG 语义下也不保证触发 onclose），既没有 open 也没有 close →
     * 这个 Promise 永远不 settle → bridge.js 的 `await connectNapcat(120000)` 卡死 →
     * `startConsoleServer()` 永远到不了 → 表现就是「整套启动成功、3100 死活不监听、点开白屏」。
     * 现在给 connect() 自己上一道硬超时：到点必定 reject（NAPCAT_CONN），
     * 让 bridge.js 那套"预算内重试 + 后台每 15s 重连"的正常逻辑跑起来（NapCat 登录后自动接上）。
     */
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._openResolve = null;
        this._openReject = null;
        try { this._ws?.close(4001, 'connect timeout'); } catch { /* ignore */ }
        const e = new Error('NapCatConnectionError: NapCat WebSocket 握手超时（未完成 upgrade）');
        e.code = 'NAPCAT_CONN';
        reject(e);
      }, timeoutMs);
      this._openResolve = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      this._openReject = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      };
      this._openOnce().catch((e) => this._emitError(e));
    });
  }

  _buildUrl() {
    let u = this.url;
    if (this.accessToken) {
      u += (u.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(this.accessToken)}`;
    }
    return u;
  }

  _openOnce() {
    return new Promise((resolve) => {
      let ws;
      const withHeaders = () => new WebSocket(this._buildUrl(), this.accessToken ? { headers: { Authorization: `Bearer ${this.accessToken}` } } : undefined);
      try {
        ws = withHeaders();
      } catch {
        try { ws = new WebSocket(this._buildUrl()); } catch { /* 构造函数失败会走 onerror? 无法到达：直接报 */ }
      }
      if (!ws) { this._scheduleReconnect(); return; }
      this._ws = ws;
      this._connecting = true;
      const timer = setTimeout(() => {
        if (this._connecting && ws.readyState === 0) {
          try { ws.close(4000, 'connect timeout'); } catch {}
          // 【2026-09-16】对 CONNECTING 的 socket，close() 按 WHATWG 语义不保证触发 onclose；
          // 一旦不触发，重连链就断在这里（见 _forceReconnect 的注释）。所以这里直接判死重排。
          if (this._ws === ws) this._forceReconnect('connect timeout');
        }
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        clearTimeout(timer);
        this._connecting = false;
        this._reconnectAttempts = 0;
        if (this._everOpened) this._reconnects += 1;   // 只统计"重连成功"，首次不算
        this._lastActivityAt = Date.now();
        if (!this._everOpened) {
          this._everOpened = true;
          this.emit('open');
          if (this._openResolve) { this._openResolve(); this._openResolve = null; this._openReject = null; }
        } else {
          this.emit('open');
        }
        this._startWatchdog();
        this._startHeartbeat();
        this._flushOutbox();
        resolve();
      };
      ws.onmessage = (ev) => { this._lastActivityAt = Date.now(); this._handleFrame(String(ev.data ?? '')); };
      ws.onclose = (info) => {
        clearTimeout(timer);
        // 【2026-09-16】陈旧 socket 的 close 一律忽略：它属于"已经判死、正在被 _forceReconnect 换掉"
        // 的那条连接。不挡住的话会把**新连接**上正在等待的 action 全部 reject、还多发一次 close 事件。
        if (this._ws !== ws) return;
        this._connecting = false;
        this._stopHeartbeat();
        const reason = new Error(`NapCat 连接已关闭 code=${info?.code ?? '?'}`);
        this._rejectPending(reason);
        this.emit('close', { code: info?.code ?? 1006, reason: info?.reason ?? '' });
        if (!this._everOpened) {
          // 从未成功连接：按旧启动语义让 main() 退出（NapCatConnectionError 等价）
          if (this._openReject) { const e = new Error('NapCatConnectionError: NapCat WebSocket closed before opening'); e.code = 'NAPCAT_CONN'; this._openReject(e); this._openResolve = null; this._openReject = null; }
          return;
        }
        this._scheduleReconnect();
      };
      ws.onerror = (e) => {
        this._emitError(e?.error ?? new Error('NapCat WebSocket error'));
        // 【2026-09-16】错误之后**不保证**有 close（实测 NapCat 抖一下只来 error）→ 这里就排重连，
        // 否则连接链断掉、桥从此聋掉（"又不回复了"）。已经开着的那条连接出错时同样该重建。
        if (!this._closed && this._ws === ws) this._forceReconnect('ws error');
      };
    });
  }

  _handleFrame(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    // 1) action 响应（带 echo 且已登记）
    if (msg.echo !== undefined && this._pending.has(msg.echo)) {
      this._resolveResponse(msg.echo, msg);
      return;
    }
    const post = msg.post_type;
    if (!post) return;
    if (post === 'meta_event') return; // heartbeat/lifecycle：仅刷新活动时间
    if (post === 'message') {
      const kind = msg.message_type === 'private' ? 'private' : (msg.message_type === 'group' ? 'group' : null);
      if (kind === 'private') for (const fn of this._sub.private) void safeCall(fn, msg);
      else if (kind === 'group') for (const fn of this._sub.group) void safeCall(fn, msg);
      return;
    }
    if (post === 'notice') {
      const nt = String(msg.notice_type ?? '');
      if (nt === 'group_recall' || nt === 'friend_recall') {
        for (const fn of this._sub.noticeAll) void safeCall(fn, msg);
        return;
      }
      if (nt === 'notify' || nt === 'poke' || nt === 'input_status') {
        const ev = { ...msg };
        if (!ev.sub_type) ev.sub_type = nt === 'input_status' ? 'input_status' : (nt === 'poke' ? 'poke' : '');
        for (const fn of this._sub.notify) void safeCall(fn, ev);
      } else {
        for (const fn of this._sub.noticeAll) void safeCall(fn, msg);
      }
      return;
    }
    if (post === 'request') {
      if (msg.request_type === 'friend') for (const fn of this._sub.friendRequest) void safeCall(fn, msg);
    }
  }

  _startWatchdog() {
    this._stopWatchdog();
    this._watchdog = setInterval(() => {
      if (this._closed) return;
      if (this._lastActivityAt && Date.now() - this._lastActivityAt > this.heartbeatWatchdogMs) {
        this._emitError(new Error('NapCat 心跳超时（假死），强制重建连接'));
        // 【2026-09-16 修「又不回复了」】原实现这里只 `this._ws?.close(4001)` 就完事，靠 onclose 里那句
        // `_scheduleReconnect()` 把连接接回来。实测（服务器 09-16 00:33 那次）：undici 的 WebSocket 在
        // 握手失败/连接已死时**只发 error、不发 close**，于是 onclose 永远不执行 —— 看门狗每 30 秒
        // 重复 close 一个已经死掉的 socket（空操作）、每 30 秒刷一次"假死"，但**再也不会重连**。
        // 现象就是主人看到的"又不回复了"：桥进程活着、3100 正常、NapCat 那边消息照收，桥却聋了，
        // 只有手动重启才恢复。现在重连由 _forceReconnect 直接负责，不再依赖 close 事件。
        this._forceReconnect('heartbeat timeout');
      }
    }, 30000);
    this._watchdog.unref?.();
  }
  _stopWatchdog() { if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; } }

  /**
   * 【2026-09-16】主动探活：安静超过 heartbeatProbeMs 就发一条 `get_status`。
   * - 回包 → 链路确实活着（顺带刷新活跃时间，避免看门狗误判）；
   * - 8 秒没回 → 立刻判死重建（不等看门狗那 45 秒）。
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this._closed) return;
      const ws = this._ws;
      if (!ws || ws.readyState !== 1) return;              // 没开着的话看门狗/重连逻辑负责
      if (this._heartbeatInFlight) return;
      const idle = Date.now() - (this._lastActivityAt || 0);
      if (idle < this.heartbeatProbeMs) return;
      this._heartbeatInFlight = true;
      this._raw('get_status', {}, this.heartbeatProbeTimeoutMs).then(() => {
        this._lastActivityAt = Date.now();
        this._heartbeatInFlight = false;
      }).catch((error) => {
        this._heartbeatInFlight = false;
        if (this._closed || this._ws !== ws) return;
        this._emitError(new Error(`NapCat 探活失败（${String(error?.message ?? error)}），强制重建连接`));
        this._forceReconnect('heartbeat probe failed');
      });
    }, this.heartbeatTickMs);
    this._heartbeatTimer.unref?.();
  }
  _stopHeartbeat() { if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; } }

  /** 连接诊断快照（控制台 / 管理端卡片用）。 */
  stats() {
    const ws = this._ws;
    return {
      url: this.url,
      connected: Boolean(ws && ws.readyState === 1),
      readyState: ws ? ws.readyState : -1,
      everOpened: Boolean(this._everOpened),
      lastActivityAgoMs: this._lastActivityAt ? Date.now() - this._lastActivityAt : null,
      reconnects: this._reconnects,
      reconnectAttempts: this._reconnectAttempts,
      outbox: this._outbox.length,
      pending: this._pending.size,
      heartbeatProbeMs: this.heartbeatProbeMs,
      watchdogMs: this.heartbeatWatchdogMs,
    };
  }

  /**
   * 【2026-09-16】把当前 socket 判死并**直接**排一次重连（不等 close 事件）。
   * 幂等：`_scheduleReconnect()` 自己会清掉旧定时器、只留一个；退避上限 10s。
   */
  _forceReconnect(reason) {
    if (this._closed || !this.reconnect) return;
    this._connecting = false;
    const sock = this._ws;
    this._ws = null;
    if (sock) {
      // 摘掉回调，防止这个"已判死"的 socket 稍后再触发 onclose/onerror 造成第二次重连
      try { sock.onclose = null; sock.onerror = null; sock.onmessage = null; sock.onopen = null; } catch { /* ignore */ }
      try { sock.close(4001, String(reason || 'force reconnect').slice(0, 100)); } catch { /* 对死 socket 是空操作 */ }
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._closed || !this.reconnect) return;
    this._reconnectAttempts += 1;
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, Math.min(6, this._reconnectAttempts - 1)));
    const delay = Math.floor(base * (0.5 + Math.random() * 0.5));
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._openOnce();
    }, delay);
  }

  dispose() {
    this._closed = true;
    this._stopWatchdog();
    this._stopHeartbeat();
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._rejectPending(new Error('客户端已主动关闭'));
    try { this._ws?.close(1000, 'bye'); } catch {}
    this._ws = null;
  }

  _rejectPending(err) {
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(err); }
    this._pending.clear();
  }

  _flushOutbox() {
    const box = this._outbox.splice(0);
    let dropped = 0;
    const now = Date.now();
    for (const item of box) {
      // 断线期间超过 sendTimeoutMs 的条目: 调用方早已按“响应超时”判失败, 这里再补发=双发/乱序, 直接丢弃
      if (now - (item.at || 0) > this.sendTimeoutMs) { dropped += 1; continue; }
      this._raw(item.action, item.params).catch(() => {});
    }
    if (dropped > 0) console.log(`[onebot-ws] outbox 跳过 ${dropped} 条已超时条目(避免断线补发双发)`);
  }

  _raw(action, params, timeoutMs) {
    if (this._closed) return Promise.reject(new Error('客户端已关闭'));
    const echo = `qqb_${Date.now().toString(36)}_${(this._seq += 1)}`;
    const ws = this._ws;
    const waitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.sendTimeoutMs;
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pending.delete(echo); reject(new Error(`${action} 响应超时`)); }, waitMs);
      this._pending.set(echo, { resolve, reject, timer });
    });
    const trySend = () => {
      if (!ws || ws.readyState !== 1) {
        if (this._outbox.length >= OUTBOX_MAX) { const evicted = this._outbox.shift(); console.log('[onebot-ws] outbox 满, 丢弃最早 1 条', evicted?.action); }
        this._outbox.push({ action, params: params ?? {}, at: Date.now() });
        return;
      }
      try { ws.send(JSON.stringify({ action, params: params ?? {}, echo })); }
      catch (e) { this._pending.delete(echo); p.catch(() => {}); }
    };
    trySend();
    return p;
  }

  _resolveResponse(echo, resp) {
    const item = this._pending.get(echo);
    if (!item) return;
    this._pending.delete(echo);
    clearTimeout(item.timer);
    const ok = resp?.status === 'ok' || resp?.retcode === 0;
    if (ok) item.resolve(resp?.data ?? resp);
    else item.reject(new Error(resp?.wording || resp?.message || `OneBot ${resp?.retcode ?? resp?.status ?? '?'}`));
  }

  // ── 旧接口兼容的具体动作 ───────────────────────────────────────
  raw(action, params) { return this._raw(action, params); }
  api(action, params) { return this._raw(action, params); }
  request(action, params) { return this._raw(action, params); } // 兼容 sticker 同步等旧调用
  /* 【2026-09-14 主人反馈"发消息报 无法获取用户信息"】
   * NapCat 刚登录那一小段时间（好友列表/UID 映射还没同步完）会给发送动作回 "无法获取用户信息"，
   * 这种错误**明确代表没发出去**，等一下再发就能成功。原来直接抛给调用方 → 模型只看到"发送失败"，
   * 那条回复就永久丢了（用户视角是"机器人不理我"）。这里对**这一类瞬时错误**做两次短重试。
   * 只重试"确认未送达"的错误：超时（响应超时）**不重试**，因为那种情况可能其实已经发出去了，
   * 重试会变成双发。 */
  sendGroupMessage(groupId, message) { return this._sendWithWarmupRetry('send_group_msg', { group_id: Number(groupId), message }); }
  sendPrivateMessage(userId, message) { return this._sendWithWarmupRetry('send_private_msg', { user_id: Number(userId), message }); }
  async _sendWithWarmupRetry(action, params) {
    const delays = [500, 2000];
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this._raw(action, params);
      } catch (error) {
        const message = String(error?.message ?? error);
        const transient = /无法获取用户信息|请检查是否已是好友|好友列表|user.?info|not ?found/i.test(message);
        if (!transient || attempt >= delays.length) throw error;
        console.log(`[onebot-ws] ${action} 第 ${attempt + 1} 次失败（${message}），${delays[attempt]}ms 后重试`);
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }
  sendGroupForwardMessage(groupId, messages) { return this.api('send_group_forward_msg', { group_id: Number(groupId), messages }); }
  sendPrivateForwardMessage(userId, messages) { return this.api('send_private_forward_msg', { user_id: Number(userId), messages }); }
  deleteFriend(userId, extra = {}) { return this.api('delete_friend', { user_id: Number(userId), ...(extra?.block ? { block: true } : {}) }); }
  setFriendAddRequest(flag, approve = true) { return this.api('set_friend_add_request', { flag: String(flag), approve: !!approve }); }
  getLoginInfo() { return this.api('get_login_info', {}); }
  getGroupInfo(groupId) { return this.api('get_group_info', { group_id: Number(groupId) }); }
  getGroupMemberList(groupId) { return this.api('get_group_member_list', { group_id: Number(groupId) }); }
  getGroupMemberInfo(groupId, userId) { return this.api('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) }); }
  getMessage(messageId) { return this.api('get_msg', { message_id: Number(messageId) }); }
  deleteMessage(messageId) { return this.api('delete_msg', { message_id: Number(messageId) }); }
  /** OneBot get_image：返回 {file,url,…}；base64 由 NapCat 按配置返回 */
  getImage(param, _opts = {}) { return this.api('get_image', { file: String(param?.file ?? param ?? '') }); }
  /** QQ 表情实体需 NapCat 私有协议，未实现时降级为文本（调用方有兜底） */
  fetchFaceEntity() { return null; }
}

function safeCall(fn, arg) {
  try { const r = fn(arg); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch {}
}
