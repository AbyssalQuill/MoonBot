import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import NoticeBar from '../components/NoticeBar';
import { deleteChatHistory, getChatConvs, getChatMessages, getChatStats } from '../api';
import type { ChatConv, ChatMessage, ChatScope, ChatStatsResp } from '../api';
import { ArrowLeft, Loader2, MessageSquare, Radio, Search, Trash2, Users } from 'lucide-react';

interface Props {
  onBack: () => void;
  /* 数据来源由连接状态决定，页面不提供"本机/服务端"开关：
   * 连上服务器就读服务器（App.tsx 传 `state.connected && state.activeServer` 的那台），
   * 没连上就读本机 —— 与桥配置页、语音页、学习页同一条规则。 */
  remote: { id: string; name: string; host: string } | null;
}

/* 两个常量的来历（都不是随手写的）：
 *   · PAGE = 50 —— 与后端契约的 limit 默认值一致。翻页只改 offset 不改 limit，
 *     免得同一次浏览里出现两种页长，分页边界也跟着漂。
 *   · DAY_MS —— 后端只接受绝对时间戳 beforeMs，不接受「天数」；天数在点击那一刻算成时间戳，
 *     慢一拍重发也不会因为时间流逝而多删几条（换算结果是一次性的、确定的）。 */
const PAGE = 50;
const DAY_MS = 86400000;

type ConvKindFilter = 'all' | 'group' | 'private';
type DirectionFilter = 'all' | 'in' | 'out';

/** 千分位整数（后端字段缺失时按 0 显示，不出现 NaN） */
const num = (v?: number | null) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('zh-CN') : '0');
/** 平均 token：小数值有意义（<100 保留一位），大数值取整；一律加千分位 */
const fmtAvg = (v?: number | null) => {
  const n = Number(v) || 0;
  if (!(n > 0)) return '—';
  return (n < 100 ? n.toFixed(1) : String(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};
/** 大数缩写（token 量级）：≥1 亿写「X.YZ 亿」、≥1 万写「X.Y 万」，避免卡片里塞一长串数字 */
const fmtBig = (v?: number | null) => {
  const n = Number(v) || 0;
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return num(n);
};
/** MM-DD HH:mm（与群友画像页同一口径，便于两页对照看时间） */
const fmtTs = (ms?: number | null) => {
  const t = Number(ms) || 0;
  if (!(t > 0)) return '—';
  const d = new Date(t), p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const trunc = (s: unknown, n: number) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '…' : t;
};

export default function ChatHistory({ onBack, remote }: Props) {
  /* 作用域完全跟随连接事实（没有开关，也没有"待选择"的中间态）：
   *   remote 有值 → 服务端那台（serverId 就是它的 id）；否则本机。
   * 连接一变（连上 / 断开 / 换服务器），scope 与 serverId 自身就跟着变，
   * 下面的 effect 依赖它们，因此会自动重读，不需要用户做任何选择。 */
  const scope: ChatScope = remote ? 'remote' : 'local';
  const serverId = remote?.id ?? '';

  const [stats, setStats] = useState<ChatStatsResp | null>(null);
  const [statsErr, setStatsErr] = useState('');
  /* 会话列表一律取全量（kind=all），群聊/私聊的筛选在前端做：
     推流推的是全量，切「群聊/私聊」不必再发请求，也不会因为筛选把新会话挡在外面。 */
  const [allConvs, setAllConvs] = useState<ChatConv[]>([]);
  const [convsErr, setConvsErr] = useState('');
  const [kind, setKind] = useState<ConvKindFilter>('all');
  /* 数据通路：sse=实时推流；poll=推流连续失败，已退回轮询兜底（界面上给一个小标）。 */
  const [live, setLive] = useState<'sse' | 'poll'>('sse');

  const [selKey, setSelKey] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [msgsErr, setMsgsErr] = useState('');
  const [msgsBusy, setMsgsBusy] = useState(false);
  /* q 与 qInput 分开：输入框每敲一个字都改 qInput，只有回车/点「搜索」才写进 q（并发出请求）。
     这样翻页、切方向、刷新都沿用一个已提交的关键词，不会把半截输入当成筛选条件。 */
  const [q, setQ] = useState('');
  const [qInput, setQInput] = useState('');
  const [direction, setDirection] = useState<DirectionFilter>('all');

  const [selIds, setSelIds] = useState<string[]>([]);
  const [days, setDays] = useState('7');
  /* busy 用「正在执行的操作名」而非布尔量：按钮上的转圈只出现在被点的那一个，
     其余删除按钮同时禁用，避免两条危险操作并行。 */
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [msgKind, setMsgKind] = useState<'notice' | 'warn'>('notice');

  /* 连接状态由 App 统一轮询并作为 remote 传进来，页面不再自己读一次
     （自己读只会读到打开那一刻的快照，连上/断开时不会跟着变）。 */

  const loadStats = useCallback(async () => {
    setStatsErr('');
    try {
      const r = await getChatStats({ scope, serverId });
      setStats(r);
      if (!r?.ok) setStatsErr(String(r?.message || '后端未给出原因'));
    } catch (e: any) {
      setStats(null);
      setStatsErr(String(e?.message ?? e));
    }
  }, [scope, serverId]);

  const loadConvs = useCallback(async () => {
    setConvsErr('');
    try {
      const r = await getChatConvs({ scope, serverId, kind: 'all', limit: 300 });
      if (r?.ok) setAllConvs(Array.isArray(r.convs) ? r.convs : []);
      else { setAllConvs([]); setConvsErr(String(r?.message || '后端未给出原因')); }
    } catch (e: any) {
      setAllConvs([]);
      setConvsErr(String(e?.message ?? e));
    }
  }, [scope, serverId]);

  const loadMsgs = useCallback(async (key: string, nextOffset: number, nextQ: string, nextDir: DirectionFilter) => {
    if (!key) return;
    setMsgsBusy(true); setMsgsErr('');
    try {
      const r = await getChatMessages({
        scope, serverId,
        key, limit: PAGE, offset: nextOffset, query: nextQ, direction: nextDir,
      });
      if (r?.ok) {
        setMessages(Array.isArray(r.messages) ? r.messages : []);
        setTotal(Number(r.total) || 0);
        setOffset(nextOffset);
        setSelIds([]);   // 换页/换筛选后旧的勾选已不在屏上，留着会让「删除选中」删到看不见的条目
      } else {
        setMessages([]); setTotal(0);
        setMsgsErr(String(r?.message || '后端未给出原因'));
      }
    } catch (e: any) {
      setMessages([]); setTotal(0);
      setMsgsErr(String(e?.message ?? e));
    } finally { setMsgsBusy(false); }
  }, [scope, serverId]);

  /* 2026-09-24 主人要求："去掉刷新按钮，改为 SSE"。
   * 打开页面即挂一条 SSE（/api/bridge/chat-stream）：后端每 5 秒取一次 stats + convs，
   * 只有内容真变了才推一帧过来，所以这里不需要定时器、也不会无谓重渲染。
   *   · stats / convs 事件 → 直接替换对应状态（数字与列表自己会长出来）；
   *   · 事件里带 ok:false → 当错误显示，但**保留上一次的数据**（不清屏）；
   *   · stream-error 或连续两次 onerror → 退回 30 秒轮询兜底（EventSource 自身也在重连，
   *     推流恢复后会自动切回实时，界面上那个小标会跟着变）。
   * 作用域变了（连上/断开服务器）就重建这条流：query 里的 scope / serverId 跟着走。 */
  useEffect(() => {
    if (typeof EventSource === 'undefined') { setLive('poll'); return () => {}; }
    let alive = true;
    let errs = 0;
    let poll: number | null = null;
    let es: EventSource | null = null;
    const startPoll = () => { if (poll === null) poll = window.setInterval(() => { void loadStats(); void loadConvs(); }, 30000); };
    const stopPoll = () => { if (poll !== null) { clearInterval(poll); poll = null; } };

    const applyStats = (payload: any) => {
      if (!alive || !payload || typeof payload !== 'object') return;
      setStats(payload);
      setStatsErr(payload.ok ? '' : String(payload.message || '后端未给出原因'));
    };
    const applyConvs = (payload: any) => {
      if (!alive || !payload || typeof payload !== 'object') return;
      if (payload.ok) { setAllConvs(Array.isArray(payload.convs) ? payload.convs : []); setConvsErr(''); }
      else setConvsErr(String(payload.message || '后端未给出原因'));
    };

    try {
      es = new EventSource(`/api/bridge/chat-stream?scope=${encodeURIComponent(scope)}&serverId=${encodeURIComponent(serverId)}`);
      es.addEventListener('snapshot', () => { errs = 0; stopPoll(); if (alive) setLive('sse'); });
      es.addEventListener('stats', (ev: MessageEvent) => { errs = 0; stopPoll(); if (alive) setLive('sse'); try { applyStats(JSON.parse(ev.data)); } catch { /* 半截帧，下一帧再说 */ } });
      es.addEventListener('convs', (ev: MessageEvent) => { try { applyConvs(JSON.parse(ev.data)); } catch { /* 同上 */ } });
      es.addEventListener('stream-error', () => { errs += 1; if (errs >= 2) { setLive('poll'); startPoll(); } });
      es.onerror = () => { errs += 1; if (alive && errs >= 2) { setLive('poll'); startPoll(); } };
    } catch {
      setLive('poll');
      startPoll();
    }

    return () => { alive = false; if (es) es.close(); stopPoll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, serverId]);

  useEffect(() => { void loadStats(); }, [loadStats]);
  useEffect(() => { void loadConvs(); }, [loadConvs]);
  /* 作用域一变（连上/断开服务器）即换一份库：上一个作用域的会话与消息全部作废
     （否则会拿着服务端的 key 去查本机）。 */
  useEffect(() => {
    setSelKey(''); setMessages([]); setTotal(0); setOffset(0); setSelIds([]); setMsgsErr('');
  }, [scope, serverId]);

  /* 会话列表全量在前、筛选在后：切「全部/群聊/私聊」是本地过滤，网格立刻变，不发请求。 */
  const convs = useMemo(
    () => (kind === 'all' ? allConvs : allConvs.filter((c) => c.kind === kind)),
    [allConvs, kind],
  );
  /* 选中的会话从全量里找：筛成「群聊」时，之前选中的私聊仍然能取到名字（用于标题与删除确认）。 */
  const selConv = useMemo(() => allConvs.find((c) => c.key === selKey) ?? null, [allConvs, selKey]);

  /* 推流把新消息送进来后，若当前正开着的这个会话变了（条数或最后时间），
     自动重载第一页 —— 只在"停在第一页且没有搜索筛选"时做，避免把正在翻页/搜索的人顶走；
     删除进行中也不动（那由 runDelete 自己收尾）。
     基线按会话记（key + 签名）：选中某个会话后第一次拿到数据只记基线，不当成"有变化"。 */
  const selSigRef = useRef<{ key: string; sig: string }>({ key: '', sig: '' });
  useEffect(() => {
    if (!selKey) { selSigRef.current = { key: '', sig: '' }; return; }
    const c = allConvs.find((x) => x.key === selKey);
    if (!c) return;
    const sig = `${c.count}|${c.lastTs}`;
    const prev = selSigRef.current;
    if (prev.key !== selKey) { selSigRef.current = { key: selKey, sig }; return; }
    if (prev.sig === sig) return;
    selSigRef.current = { key: selKey, sig };
    if (offset === 0 && !q && !busy && !msgsBusy) void loadMsgs(selKey, 0, '', direction);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allConvs, selKey, offset, q, busy, msgsBusy, direction]);

  const pickConv = (key: string) => {
    setSelKey(key); setQ(''); setQInput(''); setDirection('all');
    selSigRef.current = { key: '', sig: '' };
    void loadMsgs(key, 0, '', 'all');
  };

  /** 所有删除都走这里：调用方先弹二次确认，这里只负责发请求 + 汇报 + 刷新。
   *  成功后必须重读统计与会话列表（否则卡片和列表还显示删除前的条数，看起来像没生效），
   *  并按需重载当前会话的消息页。 */
  const runDelete = async (
    label: string,
    body: { key?: string; ids?: string[]; beforeMs?: number; all?: boolean },
  ) => {
    setBusy(label);
    setMsg(null);
    try {
      const r = await deleteChatHistory({ scope, serverId, ...body });
      if (r?.ok) {
        setMsgKind('notice');
        setMsg(`${label}完成：已删除 ${num(r.deleted)} 条${r.mode ? `（${r.mode}）` : ''}`);
        await Promise.all([loadStats(), loadConvs()]);
        if (body.key) await loadMsgs(body.key, 0, q, direction);
      } else {
        setMsgKind('warn');
        setMsg(`${label}未执行：${r?.message || '后端未给出原因'}`);
      }
    } catch (e: any) {
      setMsgKind('warn');
      setMsg(`删除失败：${String(e?.message ?? e)}`);
    } finally { setBusy(''); }
  };

  const toggleId = (id: string) =>
    setSelIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  /* 三个危险按钮：一律先 window.confirm，文案里写明「不可恢复」与影响范围（多少条 / 哪个会话）——
     只说「确定删除吗」不足以让人意识到这是从记忆库里真删。 */
  const doDeleteSelected = () => {
    if (!selIds.length) return;
    if (!window.confirm(`将永久删除选中的 ${selIds.length} 条聊天记录，删除后不可恢复。是否继续？`)) return;
    void runDelete('删除选中', { ids: selIds });
  };

  const doDeleteConv = () => {
    if (!selKey) return;
    const name = selConv?.name || selKey;
    if (!window.confirm(`将永久删除会话「${name}」的全部记录（共 ${num(selConv?.count)} 条），删除后不可恢复。是否继续？`)) return;
    void runDelete('删除该会话全部记录', { key: selKey, all: true });
  };

  const doDeleteBefore = () => {
    if (!selKey) return;
    const d = Math.floor(Number(days));
    if (!Number.isFinite(d) || d <= 0) {
      setMsgKind('warn');
      setMsg(`「删除 X 天前」的天数要填正整数（当前填的是「${days}」），未发出请求。`);
      return;
    }
    const beforeMs = Date.now() - d * DAY_MS;
    const name = selConv?.name || selKey;
    if (!window.confirm(`将永久删除会话「${name}」中 ${d} 天前（即 ${fmtTs(beforeMs)} 之前）的全部记录，删除后不可恢复。是否继续？`)) return;
    void runDelete(`删除 ${d} 天前`, { key: selKey, beforeMs });
  };

  const submitSearch = () => {
    if (!selKey) return;
    const kw = qInput.trim();
    setQ(kw);
    void loadMsgs(selKey, 0, kw, direction);
  };

  const setDir = (d: DirectionFilter) => {
    setDirection(d);
    if (selKey) void loadMsgs(selKey, 0, q, d);
  };

  const c = stats?.counters;
  const u = stats?.usage;
  const avg = Number(u?.avgTokensPerMessage) || 0;

  return (
    <div className="page cute-ui">
      <div className="page-header">
        <div className="page-header-left">
          <button className="btn btn-sm" onClick={onBack}><ArrowLeft size={15} /> 返回</button>
          <div className="page-title-wrap">
            <div className="page-title">聊天记录</div>
            <div className="page-subtitle">
              {/* 来源跟着连接走，标题里把当前这一侧说出来即可（没有可切换的开关） */}
              {remote ? `服务端：${remote.name}（${remote.host}）` : '本机：本机桥的聊天记录库 chat.db'}
            </div>
          </div>
        </div>
        <div className="page-actions">
          {/* 2026-09-24 主人要求："去掉刷新按钮，改为 SSE" —— 这里不再有手动刷新。
              数字与会话列表由 /api/bridge/chat-stream 推过来（后端 5 秒探一次、有变化才推），
              这个小标只说数据是"实时推流"还是"推流断了、已退回 30 秒轮询"。 */}
          <span className={`chat-live${live === 'poll' ? ' is-poll' : ''}`}
            title={live === 'sse'
              ? '数据由 SSE 实时推流（/api/bridge/chat-stream）：有新消息时数字与列表自动更新，无需手动刷新'
              : '实时推流暂时没连上，已退回每 30 秒自动重读；推流恢复后会自动切回实时'}>
            <Radio size={13} /> {live === 'sse' ? '实时推流' : '轮询兜底'}
          </span>
        </div>
      </div>

      <div className="page-body">
        <NoticeBar msg={msg} onClose={() => setMsg(null)} kind={msgKind} />

        {statsErr && (
          <div className="notice-bar" style={{ borderColor: '#e5484d', background: '#fef2f2', color: '#912018', cursor: 'default' }}>
            统计读取失败：{statsErr}
          </div>
        )}

        {/* 三张统计卡：粉 / 浅黄 / 浅蓝，各带一层流动渐变光效（样式在 app.css 的 .c-pink/.c-yellow/.c-blue）。
            数字口径全部来自 /bridge/chat-stats（现在由 SSE 推送），不在前端二次计算。
            2026-09-24 主人反馈"这个计数和聊天记录对不上吧"：卡片的"发送"只算机器人发出的，
            而左边会话列表的"条"是发出+收到，两者本来就不是一个数。现在每张卡把自己的口径
            写在数字下面（从哪个窗口、算的是哪一部分、分母是多少），一眼能对回列表。 */}
        <div className="chat-stat-row stagger-in">
          <div className="chat-stat-card c-pink" title={`stats.counters.todaySent（今天共 ${num(c?.todayTotal)} 条）`}>
            <div className="k">今日发送消息总数</div>
            <div className="v">{num(c?.todaySent)}</div>
            <div className="k-sub">今天 00:00 起 · 全部 {num(c?.convTotal)} 个会话合计 · 只算机器人发出的（今天这里共 {num(c?.todayTotal)} 条）</div>
          </div>
          <div className="chat-stat-card c-yellow" title={`stats.counters.sentTotal（库内共 ${num(c?.total)} 条）`}>
            <div className="k">总发送消息总数</div>
            <div className="v">{num(c?.sentTotal)}</div>
            <div className="k-sub">全部历史 · 只算机器人发出的；库内合计 {num(c?.total)} 条 = 发出 {num(c?.sentTotal)} + 收到 {num(c?.receivedTotal)}</div>
          </div>
          <div className="chat-stat-card c-blue" title="stats.usage.avgTokensPerMessage">
            <div className="k">平均每条消息 token 消耗</div>
            <div className="v">{fmtAvg(avg)}</div>
            <div className="k-sub">
              近 {num(u?.sinceDays || 7)} 天 · 会话轮次 {fmtBig(u?.totalTokens)} token ÷ 同期发出 {num(u?.messages)} 条
              （含上下文与缓存命中，所以远大于回复本身的长度）
            </div>
          </div>
        </div>
        <div className="chat-stat-note">
          数据来源：{remote ? '服务端' : '本机'}桥的聊天记录库 <code>{stats?.dbPath || '（路径未返回）'}</code>
          {/* 口径写清楚是为了让这三个数字可核对：前两张只统计机器人发出的消息。 */}
          ；对账：库内 {num(c?.total)} 条 = 收到 {num(c?.receivedTotal)} + 发出 {num(c?.sentTotal)}（会话列表里每行的「发/收」相加即这两个数）
          {u?.sinceDays ? `；token 窗口最近 ${u.sinceDays} 天（台账 ${u.ledgerPath || '未返回'}${u.ledgerLines ? `，计入 ${num(u.ledgerLines)} 轮` : ''}${u.excludedLines ? `，另有 ${num(u.excludedLines)} 轮与会话无关的内部任务未计入` : ''}）` : ''}
          {avg > 0 ? '' : `；平均 token 暂无数据，显示为 —${u?.note ? `：${u.note}` : '（后端未给出 note）'}`}
        </div>

        <div className="chat-main">
          <div className="card" style={{ padding: '14px 16px' }}>
            <div className="card-title"><Users size={15} /> 会话（{num(convs.length)}）</div>
            <div className="chat-toolbar">
              {([['all', '全部'], ['group', '群聊'], ['private', '私聊']] as const).map(([k, label]) => (
                <button key={k} className={`btn btn-sm${kind === k ? ' btn-soft-primary' : ''}`}
                  onClick={() => setKind(k)}>{label}</button>
              ))}
            </div>
            {convsErr && <div className="chat-err">会话列表读取失败：{convsErr}</div>}
            {!convsErr && convs.length === 0 && (
              <div className="chat-empty">{remote ? '服务端上还没有读到会话记录。' : '本机桥的聊天记录库里还没有会话记录。'}</div>
            )}
            <div className="chat-conv-list">
              {convs.map((cv) => (
                <div key={cv.key} className={`chat-conv-row${cv.key === selKey ? ' active' : ''}`}
                  onClick={() => pickConv(cv.key)} title={`${cv.key} · 共 ${num(cv.count)} 条（发 ${num(cv.sent)} / 收 ${num(cv.received)}）`}>
                  <div className="chat-conv-name">{cv.name || cv.key}</div>
                  <div className="chat-conv-meta">
                    {cv.key} · {cv.kind === 'group' ? '群聊' : '私聊'} · {num(cv.count)} 条
                    {' '}（发 {num(cv.sent)} / 收 {num(cv.received)}）· {fmtTs(cv.lastTs)}
                  </div>
                  <div className="chat-conv-last">{trunc(cv.lastText, 46) || '（无内容摘要）'}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ padding: '14px 16px' }}>
            <div className="card-title">
              <MessageSquare size={15} /> 消息{selConv ? ` · ${selConv.name || selConv.key}` : ''}
            </div>
            {!selKey ? (
              <div className="chat-empty">请先在左侧选择一个会话。</div>
            ) : (
              <>
                <div className="chat-toolbar">
                  <input className="input" style={{ maxWidth: 240 }} value={qInput}
                    placeholder="搜索消息内容（回车生效）"
                    onChange={(e) => setQInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitSearch(); }} />
                  <button className="btn btn-sm" onClick={submitSearch}><Search size={13} /> 搜索</button>
                  {q && (
                    <button className="btn btn-sm" title="清除关键词并回到完整列表"
                      onClick={() => { setQInput(''); setQ(''); void loadMsgs(selKey, 0, '', direction); }}>清除搜索</button>
                  )}
                  <span className="chat-sep" />
                  {([['all', '全部'], ['in', '收到的'], ['out', '我发的']] as const).map(([d, label]) => (
                    <button key={d} className={`btn btn-sm${direction === d ? ' btn-soft-primary' : ''}`}
                      onClick={() => setDir(d)}>{label}</button>
                  ))}
                </div>

                <div className="chat-toolbar">
                  <span className="chat-batch-count">已选 {num(selIds.length)} 条</span>
                  <button className="btn btn-sm" disabled={!messages.length}
                    onClick={() => setSelIds(messages.map((m) => m.id).filter(Boolean))}>全选本页</button>
                  <button className="btn btn-sm" disabled={!selIds.length} onClick={() => setSelIds([])}>清空选择</button>
                  <button className="btn btn-outline-danger btn-sm" disabled={!!busy || !selIds.length}
                    onClick={doDeleteSelected} title="永久删除选中的记录，不可恢复（点击后二次确认）">
                    {busy === '删除选中' ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} 删除选中
                  </button>
                  <button className="btn btn-outline-danger btn-sm" disabled={!!busy}
                    onClick={doDeleteConv} title="删除该会话的全部记录，不可恢复（点击后二次确认）">
                    {busy === '删除该会话全部记录' ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} 删除该会话全部记录
                  </button>
                  <span className="chat-sep" />
                  <input className="input chat-days" style={{ width: 58 }} inputMode="numeric" value={days}
                    title="删除多少天前的记录（正整数天数）"
                    onChange={(e) => setDays(e.target.value.replace(/\D/g, '').slice(0, 4))} />
                  <button className="btn btn-outline-danger btn-sm" disabled={!!busy}
                    onClick={doDeleteBefore} title="按 beforeMs 删除该会话中早于 N 天的记录，不可恢复（点击后二次确认）">
                    {busy.startsWith('删除 ') ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} 删除该会话 N 天前
                  </button>
                </div>

                {msgsErr && <div className="chat-err">消息读取失败：{msgsErr}</div>}
                <div className="chat-msg-list">
                  {msgsBusy && <div className="chat-empty"><Loader2 size={14} className="spin" /> 正在读取…</div>}
                  {!msgsBusy && !msgsErr && messages.length === 0 && (
                    <div className="chat-empty">{q ? `没有匹配「${q}」的消息。` : '该会话没有消息记录。'}</div>
                  )}
                  {!msgsBusy && messages.map((m) => (
                    <div className="chat-msg-row" key={m.id || `${m.ts}-${m.senderUid}-${m.content}`}>
                      <input type="checkbox" checked={!!m.id && selIds.includes(m.id)} disabled={!m.id}
                        title={m.id ? '勾选后可「删除选中」' : '该条没有 id，无法选中删除'}
                        onChange={() => { if (m.id) toggleId(m.id); }} />
                      <span className="chat-msg-time">{fmtTs(m.ts)}</span>
                      <span className="chat-msg-sender">{m.sender || m.senderUid || '未知'}</span>
                      {m.isSelf && <span className="badge badge-info" title="本人（owner）发出的消息">me</span>}
                      <span className="chat-msg-content" style={m.recalled ? { opacity: .6, textDecoration: 'line-through' } : undefined}>
                        {m.content || '（空内容）'}
                      </span>
                      {m.recalled && <span className="chat-msg-recalled">已撤回</span>}
                    </div>
                  ))}
                </div>

                <div className="chat-pager">
                  <span>
                    共 {num(total)} 条
                    {messages.length ? ` · 当前第 ${num(offset + 1)}–${num(offset + messages.length)} 条` : ''}
                    {q ? ` · 关键词「${q}」` : ''}
                  </span>
                  <span className="chat-pager-btns">
                    <button className="btn btn-sm" disabled={msgsBusy || offset <= 0}
                      onClick={() => void loadMsgs(selKey, Math.max(0, offset - PAGE), q, direction)}>上一页</button>
                    <button className="btn btn-sm" disabled={msgsBusy || offset + messages.length >= total}
                      onClick={() => void loadMsgs(selKey, offset + PAGE, q, direction)}>下一页</button>
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
