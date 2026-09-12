// Node 环境的 DSH Web API 客户端 —— 官方 dsh 0.1.2-rc.1 typert Remote 协议版。
// 协议(官方 0.1.2 换代,旧 apiproxy 点号端点 /api/session.list 等已移除):
//   - unary RPC: POST /api/<namespace>/<method>(斜杠),body
//     {type:'client-request', rpcId, method:'<ns>/<m>', payload:{args:{<参数wire>}}},
//     响应 {type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}。
//     参数 wire 由 typert descriptor 决定(session/create、session/prompt、workspace/* 等多数是
//     {request:{…}};session/list 是 {_request:{…}};无参数端点用 {})——本文件按桥接实际面固化。
//   - 事件流: 官方 rc.1 无全局广播 mux,必须逐会话 open session/follow;approval/ask 走 $events。
//     统一经 WebSocket /api/remote.mux(上行 {type:'open',streamId,endpoint,payload:{args}},
//     下行 {type:'item',streamId,value} / end / error;host 每 2s 发 ping,ws 库自动回 pong)。
//   - 审批/提问应答: POST /api/$events/result {args:{clientId,eventId,outcome:{kind:'result',value}}}。
// 鉴权: 官方 web 启动打印 ?token=;先 GET /?token=xxx 换 dsh-auth-* cookie(303 + Set-Cookie),
// 后续 /api 与 WebSocket 都带 cookie;无 token 环境自动免鉴权。
// 兼容面: 向 bridge 暴露 api.sessions.* / api.workspace.* / api.events.mux / api.respond /
// api.host.describe / api.settings.describe —— 与旧 apiproxy 时代调用点 1:1。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const rid = () => crypto.randomUUID();

// 会话 seq 水位的"自愈"阈值：快照里最大 seq 比持久化水位低这么多，就判定 DSH 侧序号被重置，
// 丢弃旧水位重新开始（详见 eventsMux 的 snapshot 分支）。
//
// 为什么阈值取 100 而不是一个大数：session/follow 快照给的是"该会话最新的一批事件"，
// 而水位 = 我们处理过的最大 seq。任何晚于水位的实时事件都会把水位抬高，所以正常情况
// 快照最大 seq 必然 ≥ 水位（空闲会话二者相等）——**低于水位本身就是异常信号**。
// 留 100 的余量只是防边界抖动。宁可多处理一批历史（副作用已被幽灵回合守卫兜住），
// 也不能让一个被重置的会话被永久吞消息。
const SEQ_RESET_GAP = 100;

/**
 * 判定"持久化的 seq 水位是否应当被丢弃"（自愈闸门，抽成纯函数便于单测）。
 * @param {number} known  持久化/内存里的水位（该会话已处理的最大 seq）
 * @param {number} maxRec 本次 session/follow 快照里出现的最大 seq
 * @returns {boolean} true = 判定 DSH 侧序号已重置，丢弃旧水位重新开始
 */
export function shouldResetSeqWatermark(known, maxRec) {
  return Number(known) > 0 && Number(maxRec) > 0 && (Number(known) - Number(maxRec)) > SEQ_RESET_GAP;
}

function readLatestToken(logFile) {
  try {
    if (!logFile || !fs.existsSync(logFile)) return null;
    const size = fs.statSync(logFile).size;
    const want = Math.min(size, 256 * 1024);
    const fd = fs.openSync(logFile, 'r');
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, Math.max(0, size - want));
    fs.closeSync(fd);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch { try { text = new TextDecoder('gbk').decode(buf); } catch { text = buf.toString('utf8'); } }
    const startIdx = text.lastIndexOf('===== start');
    const tail = startIdx >= 0 ? text.slice(startIdx) : text;
    const m = [...tail.matchAll(/[?&]token=([A-Za-z0-9_\-]+)/g)];
    return m.length ? m[m.length - 1][1] : null;
  } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把响应 result 槽解出来;业务错误抛错。兼容旧调用: unwrap(await api.x.y(), label)。 */
export function unwrap(response, label) {
  if (response?.result?.ok) return response.result.value;
  const err = response?.result?.error ?? { code: 'unknown', message: 'no result' };
  throw new Error(`${label} failed: ${err.code}: ${err.message}`);
}

export class NodeApiClient {
  constructor(baseUrl, timeoutMs, opts) {
    this.baseUrl = String(baseUrl ?? 'http://127.0.0.1:10721').replace(/\/+$/, '');
    this.timeoutMs = timeoutMs ?? 20000;
    this.dshLogFile = opts?.dshLogFile || '';
    this._cookie = null;
    this._cookieAt = 0;
    this._sessionPromise = null;
    // rc.1 需要逐会话 follow: 桥接经 setSessionIdSource(() => sessionId[]) 提供活跃会话全集。
    this._sessionIdSource = null;
    // $events 会话(clientId → {clientId, socket}) —— bridge 单例使用一个。
    this._eventsClient = null;
    // 会话 → 已投递最高 event seq(跨 pump/重连持久): 快照回放按此去重, 不重不漏
    this._sidSeq = new Map();
    // 2026-09-11：把这张表**落盘**。它原来只在内存里，桥一重启就清空 → follow 快照会把
    // 整段历史当成新事件重放一遍，而 pumpMux 对重放帧与实时帧**完全同形**、分不出来，于是
    // 历史回合的副作用被重跑：重复计 token（实测重复率 63.7%）、重放"无正文收尾"把重启后
    // 新收到的未读整批标已读（表现为吞消息）、把旧回复正文写回 pendingUndeliveredText 让模型
    // 下一轮"补发"（表现为重复回复）、多排一次唤醒。持久化后重启时按 seq 正确识别为"已处理过"，
    // 又不影响真正的断连补漏（那些事件的 seq 一定大于水位）。
    this._seqFile = opts?.seqFile || '';
    this._seqSaveTimer = null;
    this._loadSeqFromDisk();
    // follow 会话的"在线会话列表"由调用方决定,eventsMux 只负责按流分拣。

    // —— 兼容面(sessions/workspace/events/respond/host/settings) ——
    this.sessions = {
      create: (p) => this.sessionCreate(p),
      prompt: (p) => this.sessionPrompt(p),
      selectModel: (p) => this.sessionSelectModel(p),
      list: (p) => this.sessionList(p),
      cancel: (p) => this.sessionCancel(p),
      page: (p) => this.sessionPage(p),
      rename: (p) => this.sessionRename(p),
      attachment: (p) => this.sessionAttachment(p),
      modelCatalog: () => this.sessionModelCatalog(),
    };
    this.workspace = {
      create: (p) => this.workspaceCreate(p),
      rename: (p) => this.workspaceRename(p),
      archiveSession: (p) => this.workspaceArchiveSession(p),
      list: () => this.workspaceListLocal(),
      delete: (p) => this.workspaceDelete(p),
    };
    this.events = {
      mux: (payload, signal, onOpen) => this.eventsMux(payload, signal, onOpen),
      host: (payload, signal, onOpen) => this.eventsMux(payload, signal, onOpen),
    };
    this.host = { describe: () => this.hostDescribe() };
    this.settings = { describe: () => this.settingsDescribe() };
    this.respond = (req) => this.respondProxy(req);
  }

  /** 桥接注入活跃会话列表源。 */
  setSessionIdSource(fn) { this._sessionIdSource = fn; }

  /* ---------- 会话 seq 水位的持久化（跨重启） ---------- */
  /** 启动时把上次进程的 seq 水位读回来；损坏/缺失一律当作空（退化为旧行为，不会更差）。 */
  _loadSeqFromDisk() {
    if (!this._seqFile) return;
    try {
      const raw = fs.readFileSync(this._seqFile, 'utf8').replace(/^\uFEFF/, '');
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        for (const [sid, v] of Object.entries(obj)) {
          const n = Number(v);
          if (sid && Number.isFinite(n) && n > 0) this._sidSeq.set(sid, n);
        }
      }
    } catch { /* 首次运行/文件损坏：留空即可 */ }
  }

  /** 合并写盘（3s 去抖）：seq 每帧都在涨，不逐帧写。有界到 500 个会话，防无限增长。 */
  _scheduleSeqSave() {
    if (!this._seqFile || this._seqSaveTimer) return;
    this._seqSaveTimer = setTimeout(() => {
      this._seqSaveTimer = null;
      try {
        let entries = [...this._sidSeq.entries()].filter(([k, v]) => k && Number.isFinite(v) && v > 0);
        if (entries.length > 500) {
          // 保留水位最高的 500 个会话（水位高的通常是当前活跃会话）
          entries.sort((a, b) => b[1] - a[1]);
          entries = entries.slice(0, 500);
          this._sidSeq = new Map(entries);
        }
        fs.mkdirSync(path.dirname(this._seqFile), { recursive: true });
        // 原子替换：临时文件 + rename，避免崩溃时留下半个 JSON
        const tmp = `${this._seqFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)), 'utf8');
        fs.renameSync(tmp, this._seqFile);
      } catch { /* 写失败不影响事件处理，下次再试 */ }
    }, 3000);
    this._seqSaveTimer.unref?.();
  }

  /* ---------- 鉴权 ---------- */
  async _ensureSession() {
    const now = Date.now();
    if (this._cookie !== null && now - this._cookieAt < 55 * 1000) return this._cookie;
    if (this._sessionPromise) return this._sessionPromise;
    this._sessionPromise = (async () => {
      const token = readLatestToken(this.dshLogFile);
      if (!token) { this._cookie = null; this._cookieAt = now; return null; }
      try {
        // token GET 必须有超时: 否则 TCP 半开会让共享 _sessionPromise 永久挂起, 全链路(含重连)一起冻死
        const res = await fetch(`${this.baseUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
        const sc = res.headers.get('set-cookie') || '';
        const first = sc.split(',')[0].split(';')[0].trim();
        if ((res.status === 200 || res.status === 303) && first.startsWith('dsh-auth-')) this._cookie = first;
        else this._cookie = null;
      } catch { this._cookie = null; }
      this._cookieAt = Date.now();
      return this._cookie;
    })();
    try { return await this._sessionPromise; }
    finally { this._sessionPromise = null; }
  }
  async _headers() {
    const cookie = await this._ensureSession();
    return cookie ? { 'content-type': 'application/json', cookie } : { 'content-type': 'application/json' };
  }

  /** 泛型 unary: 方法 'ns/name',args 为 descriptor 顶层 args(已包好 request 等)。 */
  async _call(nsMethod, args, timeoutMs) {
    const [ns, m] = String(nsMethod).split('/');
    if (!ns || !m) throw new Error(`_call: 非法方法 ${nsMethod}`);
    const doCall = async () => fetch(`${this.baseUrl}/api/${ns}/${m}`, {
      method: 'POST',
      headers: await this._headers(),
      body: JSON.stringify({ type: 'client-request', rpcId: rid(), method: `${ns}/${m}`, payload: { args } }),
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    });
    let res = await doCall();
    if (res.status === 401 || res.status === 403) {
      // token 轮换/单次换取失败导致的 401: 强制换新 cookie 后只重试一次(避免风暴), 仍失败才抛错,
      // 否则会被上层误判成“DSH 卡死”而归档重建会话
      this._cookie = null; this._cookieAt = 0; this._sessionPromise = null;
      res = await doCall();
    }
    if (!res.ok) throw new Error(`transport failure for ${nsMethod}: HTTP ${res.status}`);
    const envelope = await res.json();
    if (envelope?.type !== 'server-response') throw new Error(`${nsMethod}: 非法响应`);
    return { result: envelope.result };
  }

  /* ---------- session ---------- */
  async sessionCreate(params = {}) {
    const request = {};
    if (params?.workspaceId != null) request.workspaceId = params.workspaceId;
    if (params?.cwd != null) request.cwd = params.cwd;
    if (params?.agentPreset != null) request.agentPreset = params.agentPreset;
    return this._call('session/create', { request }, 30000);
  }
  async sessionPrompt(params = {}) {
    const request = {
      requestId: params?.requestId ?? rid(),
      sessionId: params.sessionId,
      mode: params.mode ?? 'queue',
      content: params.content ?? [],
    };
    if (params?.clientTimeZone != null) request.clientTimeZone = params.clientTimeZone;
    return this._call('session/prompt', { request }, 30000);
  }
  async sessionSelectModel(params = {}) {
    const request = { sessionId: params.sessionId, provider: params.provider, model: params.model };
    if (params?.reasoningEffort != null) request.reasoningEffort = params.reasoningEffort;
    return this._call('session/selectModel', { request }, 30000);
  }
  async sessionList(params = {}) {
    const request = {};
    if (params?.cursor != null) request.cursor = params.cursor;
    return this._call('session/list', { _request: request }, 30000);
  }
  async sessionCancel(params = {}) {
    return this._call('session/cancel', { request: { sessionId: params.sessionId } }, 10000);
  }
  async sessionPage(params = {}) {
    // 兼容: {address:{kind:'session',sessionId}, throughSeq, beforeSeq?, maxMessages?}
    return this._call('session/page', { request: params }, 30000);
  }
  async sessionRename(params = {}) {
    return this._call('session/rename', { request: { sessionId: params.sessionId, title: params.title } }, 10000);
  }
  async sessionAttachment(params = {}) {
    return this._call('session/attachment', { request: params }, 60000);
  }
  async sessionModelCatalog() {
    return this._call('session/modelCatalog', {}, 15000);
  }

  /* ---------- workspace ---------- */
  async workspaceCreate(params = {}) {
    return this._call('workspace/create', { request: { path: params.path } }, 30000);
  }
  async workspaceRename(params = {}) {
    return this._call('workspace/rename', { request: { workspaceId: params.workspaceId, title: params.title } }, 10000);
  }
  async workspaceArchiveSession(params = {}) {
    return this._call('workspace/archiveSession', { request: { sessionId: params.sessionId } }, 15000);
  }
  async workspaceDelete(params = {}) {
    return this._call('workspace/delete', { request: { workspaceId: params.workspaceId } }, 15000);
  }
  /** rc.1 无 workspace/list: 桥接本地维护,从订阅源取。 */
  async workspaceListLocal() {
    const ids = typeof this._sessionIdSource === 'function' ? (this._sessionIdSource() ?? []) : [];
    return { result: { ok: true, value: { items: ids.filter(Boolean).map((sessionId) => ({ sessionId, title: '', workspaceId: null, sessionIds: [] })) } } };
  }

  /* ---------- settings / host ---------- */
  async settingsDescribe() {
    return this._call('settings/describe', {}, 15000);
  }
  /** 旧 host.describe 无 rc.1 等价物; 用 settings/describe 探活。 */
  async hostDescribe() {
    return this._call('settings/describe', {}, 15000);
  }

  /* ---------- $events/approval/ask 应答代理 ---------- */
  /** 兼容旧 respond 调用: 把 (rpcId,value 形状) 映射到 $events/result。
      eventsMux 收到 question/approval 帧时把 rpcId 设成 rc.1 的 eventId,并把本客户端
      clientId 记到 this._eventsClientId;应答即 POST /api/$events/result。 */
  async respondProxy(req) {
    const eventId = req?.rpcId;
    const clientId = this._eventsClientId;
    if (!eventId || !clientId) {
      // 无 $events 上下文(旧直连/纯学习会话)时静默成功
      return { result: { ok: true, value: {} } };
    }
    const value = req?.result?.value ?? {};
    let outcomeValue;
    if (value?.outcome != null) outcomeValue = value.outcome; // approval: 'allowed-once'|'rejected'...
    else if (value?.answer != null) outcomeValue = value.answer; // question: {answers:[...]}
    else if (value?.answers != null) outcomeValue = value.answers;
    else outcomeValue = value;
    const res = await this._call('$events/result', {
      args: { clientId, eventId, outcome: { kind: 'result', value: outcomeValue } },
    }, 10000);
    return res;
  }

  /* ---------- WS remote.mux 多路事件泵 ---------- */
  async _openMux() {
    const cookie = await this._ensureSession();
    const url = new URL('/api/remote.mux', this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = cookie ? new WebSocket(url, { headers: { cookie } }) : new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('remote.mux WebSocket 连接失败')), { once: true });
    });
    return ws;
  }

  /**
   * 兼容旧 events.mux: async generator。对订阅源里的每个 sessionId 开 session/follow,
   * 同时开一条 $events(收 approval/user-questions waterfall,转成旧 question/requested /
   * approval/requested 帧)。产出 envelope { rpcId, payload: frame }:
   *   - { type:'session/event', sessionId, event }          (follow 事件)
   *   - { type:'question/requested', sessionId, questions, clientId, eventId }
   *   - { type:'approval/requested', sessionId, approvalId, toolName, reason?, clientId, eventId }
   *   - { type:'stream/error', error }
   * frame 顶层带 clientId/eventId 供 respondProxy 定位(兼容旧 respond 面)。
   */
  async *eventsMux(_payload, _signal, onOpen) {
    let socket = null;
    const followBySid = new Map(); // sessionId -> streamId
    const sidByStream = new Map(); // streamId -> sessionId
    let eventsClientId = null;
    let eventsStreamId = null;
    const pendingByEventId = new Map(); // eventId -> { clientId }
    const inbox = [];
    let wake = null;
    const push = (item) => { inbox.push(item); if (wake) { wake(); wake = null; } };
    let closed = false;

    try { socket = await this._openMux(); }
    catch (error) {
      push({ envelope: { rpcId: null, payload: { type: 'stream/error', error: { code: 'ws-open', message: String(error?.message ?? error), details: {} } } } });
      yield* drain();
      return;
    }
    onOpen?.();

    const send = (msg) => { try { socket.send(JSON.stringify(msg)); } catch {} };

    const openFollow = (sessionId) => {
      if (followBySid.has(sessionId) || !socket) return;
      const id = 'f' + crypto.randomUUID().slice(0, 14);
      followBySid.set(sessionId, id);
      sidByStream.set(id, sessionId);
      send({ type: 'open', streamId: id, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 200 } } } });
    };
    const closeFollow = (sessionId) => {
      const id = followBySid.get(sessionId);
      if (!id) { followBySid.delete(sessionId); return; }
      send({ type: 'cancel', streamId: id });
      followBySid.delete(sessionId);
      sidByStream.delete(id);
    };
    // 开 $events(断流后由 reconcile 循环兜底重开)
    const openEvents = () => {
      eventsStreamId = 'ev' + crypto.randomUUID().slice(0, 14);
      eventsClientId = null;
      send({ type: 'open', streamId: eventsStreamId, endpoint: '$events', payload: { args: {} } });
    };
    openEvents();

    socket.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type !== 'item') {
        if (msg.type === 'end' || msg.type === 'error') {
          // 单流终结必须清理映射并记日志: 否则 followBySid 僵尸项会让该会话事件永久断供,
          // $events 流僵尸还会让审批/提问整体哑火且无人知晓
          const deadSid = sidByStream.get(msg.streamId);
          if (deadSid) {
            followBySid.delete(deadSid);
            sidByStream.delete(msg.streamId);
            console.log(`[dsh-client] follow 流终结 ${deadSid} (${msg.type}), 下轮对账会重开`);
          } else if (msg.streamId === eventsStreamId) {
            eventsStreamId = null;
            eventsClientId = null;
            this._eventsClientId = null;
            console.log(`[dsh-client] $events 流终结(${msg.type}), 将自动重开`);
          }
        }
        return;
      }
      const value = msg.value;
      if (msg.streamId === eventsStreamId) {
        if (!value) return;
        if (value.type === 'ready') {
          eventsClientId = value.clientId;
          this._eventsClientId = value.clientId;
          return;
        }
        if (value.type === 'emit') {
          // 业务 emit(agent-preset/selected、settings/...): 桥接暂不消费
          return;
        }
        if (value.type === 'waterfall') {
          const { eventId, agentId, request } = value;
          const eid = eventId ?? 'x';
          pendingByEventId.set(eid, { clientId: eventsClientId ?? '' });
          if (request && typeof request === 'object' && Array.isArray(request.questions)) {
            // user-questions/request → question/requested
            push({
              envelope: {
                rpcId: eid,
                payload: { type: 'question/requested', sessionId: agentId, questions: request.questions, clientId: eventsClientId ?? '', eventId: eid },
              },
            });
          } else if (request && typeof request === 'object') {
            // approval/request
            push({
              envelope: {
                rpcId: eid,
                payload: {
                  type: 'approval/requested', sessionId: agentId,
                  approvalId: request.id ?? request.approvalId ?? eid,
                  toolName: request.toolName ?? request.name ?? '',
                  reason: request.reason,
                  callId: request.callId,
                  clientId: eventsClientId ?? '', eventId: eid,
                },
              },
            });
          }
          return;
        }
        if (value.type === 'cancel') {
          pendingByEventId.delete(value.eventId);
          return;
        }
        return;
      }
      // follow item
      const sessionId = sidByStream.get(msg.streamId);
      if (!sessionId) return;
      if (value?.type === 'snapshot' && Array.isArray(value.records)) {
        // 断连间隙整回合事件补漏: follow 重开时服务器会回放快照(含断连窗口内未投递的事件)。
        // 此前一律丢弃 → accepted 后的整段回合若落在断连窗口内会静默消失(吞消息/漏回复)。
        // 按会话 seq 去重后补投(跨 pump/重连的 _sidSeq 持久, 保证不重不漏)。
        const known0 = this._sidSeq.get(sessionId) ?? 0;
        // —— 自愈闸门（2026-09-11）——
        // 水位现在跨重启持久化了，于是多了一种新的失效方式：DSH 侧若把同一 sessionId 的事件序号
        // 重置/重建（我们只在进程内记忆时看不出来），持久化的旧水位就会**永久吞掉该会话后续所有事件**。
        // 判据：session/follow 快照给的是"该会话最新的若干条事件"，所以正常情况它的最大 seq 应当
        // 紧贴水位；若最大 seq 比水位低了 SEQ_RESET_GAP 以上，只可能是序号被重置 → 丢弃旧水位重来。
        // 宁可多处理一批历史（副作用由 B 的幽灵回合守卫兜住），也不能永久吞消息。
        let maxRec = 0;
        for (const rec of value.records) {
          if (!rec || rec.type !== 'event' || !rec.event) continue;
          const s = Number(rec.event?.seq);
          if (Number.isFinite(s) && s > maxRec) maxRec = s;
        }
        let known = known0;
        if (shouldResetSeqWatermark(known, maxRec)) {
          console.log(`[dsh-client] 会话 ${sessionId} 快照最大 seq=${maxRec} 远低于持久化水位 ${known}，判定 DSH 侧序号已重置，丢弃旧水位`);
          this._sidSeq.delete(sessionId);
          this._scheduleSeqSave();
          known = 0;
        }
        let max = known;
        for (const rec of value.records) {
          if (!rec || rec.type !== 'event' || !rec.event) continue;
          const s = Number(rec.event?.seq);
          if (!Number.isFinite(s) || s <= known) continue;
          if (s > max) max = s;
          push({ envelope: { rpcId: null, payload: { type: 'session/event', sessionId, event: rec.event } } });
        }
        if (max > known) { this._sidSeq.set(sessionId, max); this._scheduleSeqSave(); }
        return;
      }
      if (value?.type === 'event' && value.event) {
        // 实时事件也按 seq 去重: 与快照尾部重叠/重复的帧直接跳过, 防重复回复
        const s = Number(value.event?.seq);
        const known = this._sidSeq.get(sessionId) ?? 0;
        if (Number.isFinite(s) && s <= known) return;
        if (Number.isFinite(s) && s > known) { this._sidSeq.set(sessionId, s); this._scheduleSeqSave(); }
        push({ envelope: { rpcId: null, payload: { type: 'session/event', sessionId, event: value.event } } });
      }
    });
    socket.addEventListener('close', () => { closed = true; push({ __end: true }); });
    socket.addEventListener('error', () => { closed = true; push({ __end: true }); });

    function* drain() {
      while (inbox.length > 0) {
        const item = inbox.shift();
        if (item.__end) return;
        yield item.envelope;
      }
    }

    try {
      while (!closed) {
        if (!eventsStreamId) openEvents(); // $events 曾断流 → 自动重开(审批/提问不哑火)
        const ids = typeof this._sessionIdSource === 'function' ? (this._sessionIdSource() ?? []) : [];
        const want = new Set(ids.filter(Boolean));
        for (const sid of [...followBySid.keys()]) if (!want.has(sid)) closeFollow(sid);
        for (const sid of want) openFollow(sid);
        while (inbox.length > 0) {
          const item = inbox.shift();
          if (item.__end) return;
          yield item.envelope;
        }
        await sleep(500);
      }
      yield* drain();
    } finally {
      try { socket?.close(); } catch {}
      followBySid.clear(); sidByStream.clear();
    }
  }
}

/** 在会话事件流里收集一次 turn 的 assistant 文本(按 turn 分组)。 */
export function createTurnCollector() {
  const turns = new Map();
  return {
    push(event) {
      if (event.type === 'turn/start') { turns.set(event.data.turn, { text: '' }); return null; }
      if (event.type === 'assistant/chunk') return null;
      if (event.type === 'assistant/message') {
        const t = turns.get(event.data.turn);
        if (!t) return null;
        const newText = (event.data.message?.content ?? [])
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('');
        if (newText) t.text = newText;
        return null;
      }
      if (event.type === 'turn/end') {
        const t = turns.get(event.data.turn);
        turns.delete(event.data.turn);
        if (!t) return null;
        return { turn: event.data.turn, reason: event.data.reason, text: t.text };
      }
      return null;
    },
    has(turn) { return turns.has(turn); }
  };
}

/** 从 assistant 消息 ContentBlock[] 提取纯文本。 */
export function blocksToText(content) {
  return (content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}
