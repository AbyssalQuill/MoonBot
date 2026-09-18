import { useEffect, useMemo, useRef, useState } from 'react';
import { getLearningGraph, getOwnerProfile, getPersonMessages, getPersonProfile, getPortraitCfg, savePortraitCfg, getLearningGroups, getRelations, saveRelation } from '../api';
import type { PersonMsg, PortraitCfg, GroupInfo } from '../api';
import { NetCanvas, REL_CAT_COLOR, REL_CAT_LABEL, type EdgeClick } from './NetCanvas';
import type { GraphData, GraphNode, GraphLink, GraphRole, OwnerProfileResp } from '../api';
import { ArrowLeft, Users, Loader2, RefreshCw, RotateCcw, X, UserRound, Sparkles, History } from 'lucide-react';
import NumInput from '../components/NumInput';

interface Props { onBack: () => void; }

/* ============ 简约半透明配色 ============ */
const C = {
  owner: '#d95f8e',
  friend: '#6f7bd8',
  member: '#5a9ccf',
  ownerSoft: 'rgba(217,95,142,0.15)',
  friendSoft: 'rgba(111,123,216,0.14)',
  memberSoft: 'rgba(90,156,207,0.13)',
  lineStrong: '#d95f8e',
  lineWeak: '#a9b4c2',
  text: '#33363d',
  textMuted: '#8a8f98',
  /* 群主/管理员徽标色：两个色相拉开（金 42° / 青 172°），且不用私聊好友的靛蓝、群成员的蓝，
   * 避免"群主 vs 管理员"、以及和节点色之间产生歧义。NetCanvas 里同色的角色环也取这两只色。 */
  roleOwner: '#c98a00',
  roleAdmin: '#0b7d74',
};

export type VKind = 'owner' | 'friend' | 'member' | 'tag';
export interface VNode {
  uid: string; name: string; kind: VKind; tags?: string[];
  /** 群内角色（后端 /api/learning/graph 新增；null/undefined = 没拿到 → 按"群成员"回落） */
  role?: GraphRole | null;
  msgCount?: number; lastSeen?: number | null;
  birthday?: string | null; personality?: string | null; likes?: string | null;
  personaSummary?: string | null;
}
export interface VLink { from: string; to: string; strength: number; }
const KIND_LABEL: Record<VKind, string> = { owner: '主人', friend: '私聊好友', member: '群成员', tag: '标签' };
/* 角色文案（2026 主人反馈：页面上所有人都写「群成员」）。
 * 优先级：主人自己(kind==='owner')永远显示「主人」，不被 role 覆盖 → 后端 role==='owner' 是「群主」
 * → role==='admin' 是「管理员」→ 其余回落到原来的 kind 文案（私聊好友/群成员）。
 * role 拿不到（老后端 / 接口没返回）时同样回落到 kind 文案，绝不会出现空白或 undefined。 */
function kindLabelOf(n: { kind: VKind; role?: GraphRole | null }): string {
  if (n.kind === 'owner') return KIND_LABEL.owner;
  if (n.role === 'owner') return '群主';
  if (n.role === 'admin') return '管理员';
  return KIND_LABEL[n.kind] ?? KIND_LABEL.member;
}
/** 群主/管理员徽标（有角色时用彩色药丸显示，其余走纯文本 kindLabelOf） */
function roleBadgeOf(n: { kind: VKind; role?: GraphRole | null }): { text: string; fg: string; bg: string } | null {
  if (n.kind === 'owner') return null;
  if (n.role === 'owner') return { text: '群主', fg: C.roleOwner, bg: 'rgba(201,138,0,0.14)' };
  if (n.role === 'admin') return { text: '管理员', fg: C.roleAdmin, bg: 'rgba(11,125,116,0.14)' };
  return null;
}

/* ---------- 小工具 ---------- */
const fmtTime = (ms?: number | null) => {
  if (!ms || !(ms > 0)) return '—';
  const d = new Date(ms), pad = (x: number) => String(x).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const cleanName = (n: string) => String(n ?? '').split(/[（(]/)[0].trim() || '?';
const trunc = (s: string, n: number) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));
const initialOf = (n: VNode) => (n.kind === 'owner' ? '主' : (cleanName(n.name).slice(0, 2) || '?'));
const colorOf = (k: VKind) => (k === 'owner' ? C.owner : k === 'friend' ? C.friend : k === 'member' ? C.member : '#9aa3b5');
const softOf = (k: VKind) => (k === 'owner' ? C.ownerSoft : k === 'friend' ? C.friendSoft : k === 'member' ? C.memberSoft : 'rgba(154,163,181,0.13)');

/* 过滤"给模型的说话要求/指导/闲聊记录"——这些不进画像 */
const INSTR_RE = /(主人|要求|希望|应该|不要|别|请|记得|以后|末尾|句号|中括号|括号|引用|矜持|AI\s*味|纠正|备注|说话|回复|消息|发帖|潜水|唤醒|token|额度|设置|配置)/;
/* 【实测补充】INSTR_RE 之外，从主人 notes 里切出来的标签还漏了这类：
 * "像正常人一样聊天"（INSTR_RE 里没有"聊天"）——同样是说话要求，不该当人格标签。
 * 只用在**标签**这一处，不动 INSTR_RE 本身（那个被整页复用，改它会牵动其它字段）。 */
const INSTR_TAG_EXTRA_RE = /(聊天|拟人|正常一点|像正常人)/;
/* persona-library 的正文是**学习产出**（成文画像/口头禅/风格），不是聊天原话。这里刻意用一份
 * **窄名单**判定"说话要求"，而不是整条 INSTR_RE：
 *  - INSTR_RE 里含 主人/说话/消息/回复/聊天 这些词，而正常画像几乎必然出现它们
 *    （"主人喜欢被叫小月…说话带撒娇语气"），逐行套 INSTR_RE 会把整份画像删空 ——
 *    那就又回到"已经学过了却一片空白"的老毛病（正是本次要修的 bug）。
 *  - 窄名单只认"一旦出现就基本是命令"的词。实测主人 profile 字段里的说话要求就长这样：
 *    "要求：回复不要超过两行" / "不要引用消息" / "记得群里要矜持" / "请以后发消息末尾不加句号"。
 * 代价：极少数正常句子里出现"请/不要"的行会被误删一行（比把说话要求当人格档案展示要好）。 */
const INSTR_PROSE_RE = /(已纠正|纠正|要求|请|不要|不许|必须|务必|记得|禁止|避免)/;
/** persona 正文清洗：去空行 + 丢掉说话要求行（不截断长度，界面自己折叠内滚） */
function cleanProse(s?: string | null): string {
  return String(s ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !INSTR_PROSE_RE.test(l)).join('\n').trim();
}
function cleanField(s?: string | null): string {
  if (!s) return '';
  return String(s).split('\n').map((l) => l.trim()).filter((l) => l && !INSTR_RE.test(l)).join('\n').slice(0, 120);
}
function splitTags(s?: string | null): string[] {
  const out: string[] = [];
  for (const seg of cleanField(s).split(/[；;、，,。]/)) {
    const t = seg.trim();
    if (t && t.length <= 12 && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 6);
}

/* ============ 力导向画布 ============ */
interface Pos { x: number; y: number; vx: number; vy: number; }
interface FCProps {
  nodes: VNode[]; links: VLink[];
  vw?: number; vh?: number; gid: string;
  interactive?: boolean; staticMode?: boolean;
  layout?: 'free' | 'shell'; // shell=足球烯壳层(不自由乱跑)
  anchorUid?: string;              // 锚点节点(如焦点人物)柔和拉向画布中心,其余环绕
  selectedUid?: string | null;
  onPick?: (uid: string | null) => void;
  onOpen?: (n: VNode) => void;
  showLabels?: boolean;            // 默认悬停/选中才显示名字(减少杂乱)
}
const REP_K = 1400, REST = 118, SPR_K = 0.14, DAMP = 0.9, MAX_SP = 4.6;

function ForceCanvas({ nodes, links, vw = 1500, vh = 680, gid, interactive = true, staticMode = false, layout = 'free', anchorUid, selectedUid, onPick, onOpen, showLabels = true }: FCProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const posRef = useRef<Map<string, Pos>>(new Map());
  const dragRef = useRef<{ uid: string; moved: boolean; px: number; py: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const stillRef = useRef(0);
  const [zoom, setZoom] = useState({ k: 1, tx: 0, ty: 0 });
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const [hover, setHover] = useState<string | null>(null);
  const [, setFrame] = useState(0);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.uid, n])), [nodes]);
  const linkList = useMemo(() => links.filter((l) => nodeById.has(l.from) && nodeById.has(l.to)), [links, nodeById]);

  useEffect(() => {
    const m = posRef.current;
    const ids = new Set(nodes.map((n) => n.uid));
    for (const k of [...m.keys()]) if (!ids.has(k)) m.delete(k);
    const cx = vw / 2, cy = vh / 2;
    if (layout === 'shell') {
      // 足球烯壳层: 主人/枢纽居中, 其余按 BFS 深浅一圈圈环绕, 相邻圈错位(五/六边格感), 静止不乱跑
      const adj = new Map<string, Array<{ id: string; s: number }>>(nodes.map((n) => [n.uid, []]));
      for (const l of linkList) { adj.get(l.from)?.push({ id: l.to, s: l.strength }); adj.get(l.to)?.push({ id: l.from, s: l.strength }); }
      for (const v of adj.values()) v.sort((a, b) => b.s - a.s);
      const startUid = nodes.find((n) => n.kind === 'owner')?.uid || nodes[0]?.uid;
      const order: string[] = [startUid];
      const seen = new Set<string>([startUid]);
      let q = [startUid];
      while (q.length && order.length < nodes.length) {
        const nq: string[] = [];
        for (const u of q) for (const e of adj.get(u) || []) if (!seen.has(e.id)) { seen.add(e.id); order.push(e.id); nq.push(e.id); if (order.length >= nodes.length) break; }
        q = nq;
      }
      for (const n of nodes) if (!seen.has(n.uid)) order.push(n.uid);
      const ringCap = [1, 6, 12, 18, 24, 30, 36];
      let ring = 0, acc = 0;
      order.forEach((uid, i) => {
        while (i >= acc + (ringCap[ring] ?? 20)) { acc += ringCap[ring] ?? 20; ring++; }
        const count = ringCap[ring] ?? 20;
        const a = ((i - acc) / count) * Math.PI * 2 + (ring % 2 ? Math.PI / count : 0) - Math.PI / 2;
        const rr = 58 + ring * 84;
        m.set(uid, { x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr * 0.6, vx: 0, vy: 0 });
      });
      return;
    }
    nodes.forEach((n, i) => {
      if (m.has(n.uid)) return;
      if (staticMode) {
        if (i === 0) { m.set(n.uid, { x: cx, y: cy, vx: 0, vy: 0 }); return; }
        const a = ((i - 1) / Math.max(nodes.length - 1, 1)) * Math.PI * 2 - Math.PI / 2;
        m.set(n.uid, { x: cx + Math.cos(a) * (vw / 2 - 70), y: cy + Math.sin(a) * (vh / 2 - 48), vx: 0, vy: 0 });
        return;
      }
      const t = (i / Math.max(nodes.length, 1)) * Math.PI * 2 + Math.random();
      const rr = Math.min(vw, vh) * 0.26 * (0.35 + 0.3 * Math.random());
      m.set(n.uid, { x: cx + Math.cos(t) * rr, y: cy + Math.sin(t) * rr * 0.62, vx: 0, vy: 0 });
    });
    if (!staticMode) start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, staticMode, layout, vw, vh]);

  const stepRef = useRef<() => void>(() => {});
  stepRef.current = () => {
    const m = posRef.current; if (!m.size) return;
    const ids = [...m.keys()];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = m.get(ids[i])!, b = m.get(ids[j])!;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      const f = Math.min(5, REP_K / d) / d;
      a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
    }
    for (const l of linkList) {
      const a = m.get(l.from), b = m.get(l.to); if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      const pull = (d - REST) * SPR_K * (0.35 + 0.65 * l.strength);
      a.vx += (dx / d) * pull; a.vy += (dy / d) * pull; b.vx -= (dx / d) * pull; b.vy -= (dy / d) * pull;
    }
    // 锚点: 焦点人物柔和拉向中心,邻居环绕(不倒飞)
    if (anchorUid) {
      const ap = m.get(anchorUid);
      if (ap) { ap.vx += (vw / 2 - ap.x) * 0.006; ap.vy += (vh / 2 - ap.y) * 0.006; }
    }
    let maxMove = 0; const pad = 70;
    const t = performance.now() / 1400; // 波荡时间基准(持续"自运动")
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (dragRef.current?.uid === n.uid) continue;
      const p = m.get(n.uid); if (!p) continue;
      // 向心牵引: 防止节点全跑到四周贴边
      p.vx += (vw / 2 - p.x) * 0.0045;
      p.vy += (vh / 2 - p.y) * 0.0045;
      p.vx += Math.sin(t + i * 1.71) * 0.04;
      p.vy += Math.cos(t * 0.93 + i * 2.13) * 0.04;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > MAX_SP) { p.vx = (p.vx / sp) * MAX_SP; p.vy = (p.vy / sp) * MAX_SP; }
      p.x += p.vx; p.y += p.vy; p.vx *= DAMP; p.vy *= DAMP;
      if (p.x < pad) { p.x = pad; p.vx *= -0.4; } if (p.x > vw - pad) { p.x = vw - pad; p.vx *= -0.4; }
      if (p.y < pad) { p.y = pad; p.vy *= -0.4; } if (p.y > vh - pad) { p.y = vh - pad; p.vy *= -0.4; }
      maxMove = Math.max(maxMove, Math.abs(p.vx) + Math.abs(p.vy));
    }
    // 收敛久一点再趋于缓慢; 稳定后仅保留波荡
    if (maxMove > 0.5) stillRef.current = 0; else if (stillRef.current < 400) stillRef.current++;
    setFrame((f) => f + 1);
  };
  const start = () => {
    if (runningRef.current || staticMode || layout === 'shell') return;
    runningRef.current = true; stillRef.current = 0;
    const tick = () => {
      if (!runningRef.current) return;
      stepRef.current();
      rafRef.current = requestAnimationFrame(tick); // 持续运行: 拖拽/平移/自运动都实时
    };
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  };
  const stop = () => { runningRef.current = false; if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; } };
  useEffect(() => { if (!staticMode) start(); return stop; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [linkList, nodes.length]);

  const svgPoint = (e: { clientX: number; clientY: number }) => {
    const pt = svgRef.current!.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svgRef.current!.getScreenCTM()!.inverse());
  };
  const toWorld = (e: { clientX: number; clientY: number }) => {
    const p = svgPoint(e), z = zoomRef.current;
    return { x: (p.x - z.tx) / z.k, y: (p.y - z.ty) / z.k };
  };
  const nodeAt = (wx: number, wy: number): VNode | null => {
    let best: VNode | null = null, bd = Infinity;
    for (const n of nodes) {
      const p = posRef.current.get(n.uid); if (!p) continue;
      const d = Math.hypot(p.x - wx, p.y - wy);
      if (d <= (n.kind === 'owner' ? 24 : 19) && d < bd) { best = n; bd = d; }
    }
    return best;
  };

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!interactive || staticMode) return;
    const w = toWorld(e), hit = nodeAt(w.x, w.y);
    svgRef.current?.setPointerCapture(e.pointerId);
    if (hit && layout === 'free') dragRef.current = { uid: hit.uid, moved: false, px: w.x, py: w.y };
    else if (hit && layout === 'shell') dragRef.current = { uid: hit.uid, moved: false, px: w.x, py: w.y, locked: true } as any;
    else panRef.current = { x: e.clientX, y: e.clientY, tx: zoomRef.current.tx, ty: zoomRef.current.ty };
    start();
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!interactive || staticMode) return;
    if (dragRef.current) {
      const d = dragRef.current, w = toWorld(e);
      if (Math.hypot(w.x - d.px, w.y - d.py) > 3) d.moved = true;
      const locked = (d as any).locked === true;
      const p = posRef.current.get(d.uid);
      if (p && !locked) { p.x = Math.max(30, Math.min(vw - 30, w.x)); p.y = Math.max(30, Math.min(vh - 30, w.y)); p.vx = 0; p.vy = 0; }
      setFrame((f) => f + 1);
    } else if (panRef.current) {
      const pan = panRef.current, z = zoomRef.current;
      if (Math.hypot(e.clientX - pan.x, e.clientY - pan.y) > 3) setZoom({ k: z.k, tx: pan.tx + (e.clientX - pan.x), ty: pan.ty + (e.clientY - pan.y) });
    }
  };
  const onUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!interactive || staticMode) return;
    const d = dragRef.current, pan = panRef.current, w = toWorld(e);
    if (d) {
      if (!d.moved) {
        const n = nodeAt(w.x, w.y);
        if (n) { onPick?.(n.uid); onOpen?.(n); } else onPick?.(null);
      }
      dragRef.current = null;
    } else if (pan && Math.hypot(e.clientX - pan.x, e.clientY - pan.y) < 4) onPick?.(null);
    panRef.current = null;
    try { svgRef.current?.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };

  const linkColor = (l: VLink): string => {
    const a = nodeById.get(l.from), b = nodeById.get(l.to);
    if (a?.kind === 'owner' || b?.kind === 'owner') return C.lineStrong;
    if (a?.kind === 'friend' || b?.kind === 'friend') return 'rgba(111,123,216,0.7)';
    return C.lineWeak;
  };
  const nodeRadius = (n: VNode) => (n.kind === 'owner' ? 19 : n.kind === 'friend' ? 14 : 13);
  const isNear = (n: VNode) => {
    if (!hover) return false;
    return n.uid === hover || linkList.some((l) => (l.from === n.uid || l.to === n.uid) && (l.from === hover || l.to === hover));
  };

  if (staticMode) {
    return (
      <svg ref={svgRef} viewBox={`0 0 ${vw} ${vh}`} role="img" aria-label="关系小图" style={{ width: '100%', height: '100%' }}>
        {linkList.map((l, i) => {
          const a = posRef.current.get(l.from), b = posRef.current.get(l.to);
          if (!a || !b) return null;
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={linkColor(l)} strokeWidth={0.7 + l.strength * 1.3} strokeOpacity={0.4 + 0.35 * l.strength} strokeLinecap="round" />;
        })}
        {nodes.map((n) => {
          const p = posRef.current.get(n.uid); if (!p) return null;
          if (n.kind === 'tag') {
            return <text key={n.uid} x={p.x} y={p.y + 3.5} textAnchor="middle" fontSize={10.5} fill={C.textMuted} style={{ userSelect: 'none' }}>{trunc(n.name, 9)}</text>;
          }
          const r = nodeRadius(n), col = colorOf(n.kind);
          return (
            <g key={n.uid}>
              {n.kind === 'owner'
                ? <ellipse cx={p.x} cy={p.y} rx={r + 4} ry={r} fill={softOf('owner')} stroke={col} strokeOpacity={0.6} strokeWidth={1} />
                : <circle cx={p.x} cy={p.y} r={r} fill={softOf(n.kind)} stroke={col} strokeOpacity={0.6} strokeWidth={1} />}
              <text x={p.x} y={p.y + (n.kind === 'owner' ? 1.5 : 2)} textAnchor="middle" fontSize={n.kind === 'owner' ? 10 : 9} fill={col} style={{ userSelect: 'none', pointerEvents: 'none' }}>{initialOf(n)}</text>
            </g>
          );
        })}
      </svg>
    );
  }

  return (
    <svg ref={svgRef} viewBox={`0 0 ${vw} ${vh}`} role="img" aria-label="群友关系图"
      style={{ cursor: dragRef.current ? 'grabbing' : 'grab', touchAction: 'none' }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      onPointerLeave={() => setHover(null)}>
      <g transform={`translate(${zoom.tx},${zoom.ty}) scale(${zoom.k})`}>
        {linkList.map((l, i) => {
          const a = posRef.current.get(l.from), b = posRef.current.get(l.to);
          if (!a || !b) return null;
          const na = nodeById.get(l.from) as VNode | undefined, nb = nodeById.get(l.to) as VNode | undefined;
          const near = hover && ((na && isNear(na)) || (nb && isNear(nb)));
          const hl = hover && (l.from === hover || l.to === hover);
          const dim = hover && !near && !hl;
          return (
            <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={linkColor(l)}
              strokeWidth={hl ? 1.5 + l.strength * 2.6 : 0.6 + l.strength * 2.2}
              strokeOpacity={dim ? 0.05 : hl ? 0.6 : 0.26 + 0.42 * l.strength}
              strokeLinecap="round" />
          );
        })}
        {nodes.map((n) => {
          const p = posRef.current.get(n.uid); if (!p) return null;
          const r = nodeRadius(n), col = colorOf(n.kind), soft = softOf(n.kind);
          const sel = selectedUid === n.uid;
          const dim = hover && !isNear(n) && n.uid !== hover;
          return (
            <g key={n.uid} onPointerEnter={() => setHover(n.uid)} opacity={dim ? 0.18 : 1} style={{ cursor: 'pointer' }}>
              {sel && <circle cx={p.x} cy={p.y} r={r + 6} fill="none" stroke={col} strokeOpacity={0.45} strokeWidth={1.3} />}
              {n.kind === 'owner'
                ? <ellipse cx={p.x} cy={p.y} rx={r + 5} ry={r} fill={soft} stroke={col} strokeOpacity={0.75} strokeWidth={1.1} />
                : <circle cx={p.x} cy={p.y} r={r} fill={soft} stroke={col} strokeOpacity={0.7} strokeWidth={1} />}
              <text x={p.x} y={p.y + (n.kind === 'owner' ? 1 : 1.6)} textAnchor="middle" fontSize={n.kind === 'owner' ? 11 : 10} fill={col} style={{ userSelect: 'none', pointerEvents: 'none' }}>{initialOf(n)}</text>
              {(sel || hover === n.uid || showLabels) && (
                <text x={p.x} y={p.y + r + (n.kind === 'owner' ? 17 : 14)} textAnchor="middle" fontSize={10.5} fill={sel || hover === n.uid ? col : C.textMuted} fontWeight={sel || hover === n.uid ? 600 : 400} style={{ userSelect: 'none', pointerEvents: 'none' }}>{trunc(cleanName(n.name), 7)}</text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/* ============ 关系标注卡片：状态机 ============
 * 主人反馈"卡片的状态机要优化"，原实现的实际问题（都能在旧代码里对上）：
 *  1. saveRelation 返回 ok:false 时照样 setEdgeSel(null) 把卡片关掉，catch{} 又是空的 →
 *     保存失败看起来和成功一模一样，主人只会觉得"点了没反应"；
 *  2. "清除标注"压根没有入口（clearRelCat 定义了却没人调用，而且它传的是 'qunyou' 不是空串，
 *     后端语义是"空 category 才删除"，所以那条路径从来没真正删过标注）；
 *  3. 上一次的失败/成功残留：取消或换一条线时只清了 edgeSel，卡片内的状态没归零。
 * 现在四个状态：
 *  idle   = 刚打开/已取消，等待选择类别
 *  saving = 已提交、等接口返回；五个类别按钮与「清除标注」禁用，重复点击不会再发第二次请求
 *           （「取消」**不**禁用：接口万一直不回来，也要让主人有路可走）
 *  error  = 保存失败（ok:false 或抛错）；卡片留在屏幕上，显示原因 + 可原地重试
 *  done   = 保存/清除成功；先显示「已保存」，900ms 后自动收起卡片
 * 另外用一个自增令牌（relReqRef）标识"这一次提交"：取消或换一条线后令牌变化，在途请求的迟到回包
 * 不再改卡片状态（服务端返回的 relations 仍会应用）。
 */
type RelEdit =
  | { st: 'idle' }
  | { st: 'saving'; cat: string }
  | { st: 'error'; cat: string; msg: string }
  | { st: 'done'; cat: string };

/** 关系标注卡片（主图浮层与聚焦弹层共用一份，避免两处状态机写法漂移） */
function RelEdgeCard({ title, current, state, floating = false, onPick, onClose }: {
  title: string; current: string; state: RelEdit; floating?: boolean;
  onPick: (cat: string) => void; onClose: () => void;
}) {
  const busy = state.st === 'saving';
  // 正在提交/已提交的类别保持高亮（saving 时"按下去了"、error 时能看出是哪一类失败、done 时是对勾）
  const pick = state.st === 'idle' ? null : state.cat;
  return (
    <div style={{
      border: '1px solid rgba(120,120,190,0.4)', background: 'rgba(255,255,255,0.96)', borderRadius: 12,
      padding: '8px 12px', boxShadow: '0 6px 20px rgba(0,0,0,0.14)', backdropFilter: 'blur(2px)',
      ...(floating ? {} : { marginBottom: 8 }),
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 6 }}>
        {title}
        {current && <span style={{ marginLeft: 6, fontWeight: 400, color: C.textMuted, fontSize: 12 }}>当前: {current}</span>}
        {state.st === 'saving' && <span style={{ marginLeft: 6, fontWeight: 400, color: C.textMuted, fontSize: 12 }}><Loader2 size={11} className="spin" /> 保存中…</span>}
        {state.st === 'done' && <span style={{ marginLeft: 6, fontWeight: 400, fontSize: 12, color: '#2f9e44' }}>✓ 已保存</span>}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {(['qunyou', 'guimi', 'jiaren', 'qinglv', 'chouren'] as const).map((c) => (
          <button key={c} className="btn btn-sm" disabled={busy || state.st === 'done'} onClick={() => onPick(c)}
            style={{
              border: '1px solid ' + REL_CAT_COLOR[c], background: pick === c ? REL_CAT_COLOR[c] : 'transparent',
              color: pick === c ? '#fff' : REL_CAT_COLOR[c], opacity: busy && pick !== c ? 0.55 : 1,
            }}>
            {REL_CAT_LABEL[c]}
          </button>
        ))}
        {/* 清除标注：传空 category 后端会真的删掉这条记录（见 server 的 PUT /learning/relations）。
            只在"当前确有标注"时出现，否则按了也没意义。 */}
        {current && (
          <button className="btn btn-sm" disabled={busy || state.st === 'done'} onClick={() => onPick('')}
            style={{ border: '1px solid rgba(0,0,0,0.2)', color: C.textMuted, background: 'transparent' }}>
            清除标注
          </button>
        )}
        <button className="btn btn-sm" onClick={onClose}>取消</button>
      </div>
      {state.st === 'error' && (
        <div style={{ marginTop: 6, fontSize: 12, color: '#c0504d', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span>保存失败：{state.msg}</span>
          <button className="btn btn-sm" onClick={() => onPick(state.cat)}>重试</button>
        </div>
      )}
    </div>
  );
}

/* ============ 页面 ============ */

export default function GroupPortrait({ onBack }: Props) {
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [owner, setOwner] = useState<OwnerProfileResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState<'core' | 'all'>('core');
  const [showWeak, setShowWeak] = useState(false);
  const [focus, setFocus] = useState<VNode | null>(null);
  const [msgs, setMsgs] = useState<PersonMsg[] | null>(null);
  const [msgsOpen, setMsgsOpen] = useState(false);
  const [msgsLoading, setMsgsLoading] = useState(false);
  const [msgsErr, setMsgsErr] = useState('');
  const [relSel, setRelSel] = useState<{ node: VNode; strength: number } | null>(null);
  const [groupsList, setGroupsList] = useState<GroupInfo[]>([]);
  const [grpSel, setGrpSel] = useState('');
  const [locQ, setLocQ] = useState('');
  const [pCfg, setPCfg] = useState<PortraitCfg | null>(null);
  const [pCfgSaving, setPCfgSaving] = useState(false);
  const [rels, setRels] = useState<Record<string, string>>({});
  const [edgeSel, setEdgeSel] = useState<EdgeClick | null>(null);
  const [relEdit, setRelEdit] = useState<RelEdit>({ st: 'idle' });
  /** 提交令牌：卡片被取消/换线后 +1，用来丢弃在途请求的迟到回包（否则旧回包会把新卡片标成"已保存"） */
  const relReqRef = useRef(0);
  /** 主图上点线时记录落点与容器尺寸，用来把浮层卡片夹在画布内（容器 overflow:hidden，贴边会被切掉） */
  const [edgePos, setEdgePos] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const mainBoxRef = useRef<HTMLDivElement | null>(null);
  const [relayout, setRelayout] = useState(0);

  /* 【2026-09-14 主人反馈】聚焦弹层原来只有一行「还没有整理过的档案：多聊几次或对 ta 做「人格学习」会充实起来」——
   * 哪怕这个人**早就被学习过**也照说不误（因为弹层只看图谱接口那几个被截断的短字段）。
   * 现在改成和「学习」页「人格学习状态」同一套说法：已学习/无档案 + 最近学习 + 近30天发言 + 记忆条目，
   * 数据按需直读桥的 memory.db（/api/learning/profile，不截断）；长文折叠 + 内滚，不把弹窗拉长。 */
  const [profData, setProfData] = useState<Record<string, any>>({});
  const [profBusy, setProfBusy] = useState('');
  const [profErr, setProfErr] = useState<Record<string, string>>({});
  const [profOpen, setProfOpen] = useState(false);
  /* 主人画像卡里"展开档案"的折叠开关：刻意**不复用** profOpen —— 那个是聚焦弹层里「学习档案」块的开关，
   * 共用一个 state 会导致展开主人的档案把弹层那一块也撑开（两处互不相干） */
  const [ownerOpen, setOwnerOpen] = useState(false);

  const loadAll = async () => {
    setLoading(true); setErr('');
    try {
      const [g, o] = await Promise.all([getLearningGraph(), getOwnerProfile()]);
      if (g?.ok && Array.isArray(g.nodes)) setGraph(g); else setGraph(null);
      if (o?.ok) setOwner(o); else setOwner(null);
      if (!g?.ok || !o?.ok) setErr('部分画像数据读取失败');
    } catch (e2: any) { setErr(String(e2?.message ?? e2)); }
    finally { setLoading(false); }
  };
  useEffect(() => { loadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  /* 换焦点人物 = 换一张关系网：顺带把关系标注卡片彻底归零（原来只清 relSel，卡片状态会残留到下一次） */
  useEffect(() => {
    setMsgs(null); setMsgsOpen(false); setMsgsErr(''); setRelSel(null);
    setEdgeSel(null); setRelEdit({ st: 'idle' }); setEdgePos(null);
  }, [focus?.uid]);
  /* done 状态只停 900ms：既让「✓ 已保存」和图层上的线色变化被看见，又不会把卡片一直挂在图上 */
  useEffect(() => {
    if (relEdit.st !== 'done') return;
    const t = setTimeout(() => { setEdgeSel(null); setRelEdit({ st: 'idle' }); setEdgePos(null); }, 900);
    return () => clearTimeout(t);
  }, [relEdit]);
  // 聚焦某人时按需取「完整档案」（与 Learning.tsx 同一套解包口径；已取过的不重复请求）
  useEffect(() => {
    setProfOpen(false);
    const uid = focus?.uid;
    if (!uid || profData[uid] !== undefined) return;
    let alive = true;
    setProfBusy(uid);
    getPersonProfile(uid)
      .then((r: any) => {
        if (!alive) return;
        if (r && r.ok === false) {
          setProfErr((m) => ({ ...m, [uid]: String(r?.error || '读取失败') }));
          setProfData((m) => ({ ...m, [uid]: null }));
        } else {
          const d = (r?.profile !== undefined ? r : (r?.result ?? r)) ?? null;
          setProfErr((m) => { const n = { ...m }; delete n[uid]; return n; });
          setProfData((m) => ({ ...m, [uid]: d }));
        }
      })
      .catch((e2: any) => {
        if (!alive) return;
        setProfErr((m) => ({ ...m, [uid]: String(e2?.message ?? e2) }));
        setProfData((m) => ({ ...m, [uid]: null }));
      })
      .finally(() => { if (alive) setProfBusy(''); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.uid]);
  useEffect(() => {
    getLearningGroups().then((g) => { if (g?.ok && Array.isArray(g.groups)) setGroupsList(g.groups); }).catch(() => {});
    getPortraitCfg().then((c) => { if (c) setPCfg(c); }).catch(() => {});
    getRelations().then((r) => { if (r?.ok && r.relations) setRels(r.relations); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadPersonMsgs = async (n: VNode) => {
    setMsgsLoading(true); setMsgsErr('');
    try {
      const r = await getPersonMessages(n.uid, 20);
      if (r?.ok && Array.isArray(r.messages)) setMsgs(r.messages); else { setMsgs([]); setMsgsErr(r?.message || '读取失败'); }
    } catch (e2: any) { setMsgs([]); setMsgsErr(String(e2?.message ?? e2)); }
    finally { setMsgsLoading(false); }
  };

  // 页面整体禁止缩放: 拦截 Ctrl/Cmd+滚轮(浏览器整页缩放); 只有画布自身的滚轮缩放保留
  useEffect(() => {
    const h = (e: WheelEvent) => { if (e.ctrlKey || e.metaKey || e.altKey) e.preventDefault(); };
    window.addEventListener('wheel', h, { passive: false });
    return () => window.removeEventListener('wheel', h);
  }, []);

  const allNodes: VNode[] = useMemo(() => (graph?.nodes ?? []).map((n: GraphNode) => ({
    uid: n.uid, name: n.name, kind: n.kind, role: n.role ?? null, tags: n.tags ?? [], msgCount: n.msgCount, lastSeen: n.lastSeen,
    birthday: n.birthday ?? null, personality: n.personality ?? null, likes: n.likes ?? null, personaSummary: n.personaSummary ?? null,
  })), [graph]);
  const allLinks = useMemo(() => (graph?.links ?? []).map((l: GraphLink) => ({ from: l.from, to: l.to, strength: l.strength })), [graph]);
  const byUid = useMemo(() => new Map(allNodes.map((n) => [n.uid, n])), [allNodes]);

  const mainNodes: VNode[] = useMemo(() => {
    const g = groupsList.find((x) => x.id === grpSel);
    const gset = g ? new Set(g.members.map((m) => m.uid)) : null;
    const pool = gset ? allNodes.filter((n) => n.kind === 'owner' || gset.has(n.uid)) : allNodes;
    if (filter === 'all') return pool;
    const arr = pool.filter((n) =>
      n.kind === 'owner' || n.kind === 'friend' ||
      (n.msgCount ?? 0) >= 30 || n.personality || n.likes || n.birthday ||
      allLinks.filter((l) => l.from === n.uid || l.to === n.uid).length >= 6
    );
    return arr.slice(0, 36);
  }, [allNodes, allLinks, filter, groupsList, grpSel]);
  const mainLinks = useMemo(() => {
    const set = new Set(mainNodes.map((n) => n.uid));
    const inside = allLinks.filter((l) => set.has(l.from) && set.has(l.to));
    if (showWeak) return inside;
    // 有条理: 保留"强关系"且每个节点至少一条边,总边数约为节点数×2.2,避免一团乱
    const sorted = [...inside].sort((a, b) => b.strength - a.strength);
    const deg = new Map<string, number>(); for (const id of set) deg.set(id, 0);
    const pick: VLink[] = [];
    for (const l of sorted) {
      const d1 = deg.get(l.from)! + (l.from === l.to ? 1 : 0), d2 = deg.get(l.to)!;
      if ((d1 < 1 || d2 < 1) && pick.length < set.size * 4) {
        pick.push(l); deg.set(l.from, d1 + 1); deg.set(l.to, d2 + 1);
      }
      if (pick.length >= set.size * 2.2) break;
    }
    // 保底把孤点接上其最强边
    for (const id of set) if (deg.get(id)! < 1) {
      const l = sorted.find((x) => x.from === id || x.to === id);
      if (l && !pick.includes(l)) { pick.push(l); deg.set(l.from, (deg.get(l.from) || 0) + 1); deg.set(l.to, (deg.get(l.to) || 0) + 1); }
    }
    return pick;
  }, [allLinks, mainNodes, showWeak]);

  /* 主人画像: 只留真实档案,过滤"给模型的说话要求"
   * 【2026-09-18 主人反馈】"已经学习过（64 条人格样本），却一个标签都没有、还写着暂无已整理档案"。
   * 根因（用只读脚本直读本机 qq-bridge/state/memory.db 实测）：profiles 表主人那行的
   * personality / likes / dislikes **全是空**，只有 notes 有内容，而 notes 里存的正是
   * "已纠正：发消息末尾不带句号；主人要求以后全用数组发消息…"这类**给模型的说话要求**。
   * 老口径只读 personality/likes，于是可切出来的标签全是该被 INSTR_RE 过滤掉的东西 → 页面整块空白。
   * 而 /api/learning/owner-profile 早就返回了三个更有用的字段，前端一个都没用：
   *   profileTags —— 切自同几个字段（**实测那 6 条全是说话要求**，所以拿到后必须再过一遍过滤）
   *   memoryTop   —— 记忆条目里的高频二字词 {w,c}（见 server 的 memoryTopWords）
   *   persona     —— persona-library 的完整条目：nickname/profile/catchphrases/style/topics…
   * 现在：标签 = profileTags(过滤后) → 本地 likes/personality 切片 → **记忆高频词补足**；
   *       只要有任何已学习痕迹（persona 条目 / 样本>0 / memoryTop 非空 / profileTags 非空）
   *       就不再显示"暂无已整理档案"。 */
  const ownerInfo = useMemo(() => {
    const o = owner?.owner ?? allNodes.find((n) => n.kind === 'owner') ?? null;
    const persona = owner?.persona ?? null;

    /* 标签回退链。记忆来源的标签单独记账（memTag），界面上用虚线 + 注解标明"来自记忆高频词"，
     * 因为它们没有词典可依，可能是碎词（实测主人最近 30 天只有 2 条空间说说记忆，
     * 切出来的高频词是 傍晚/抽风/出水/… 甚至 果数/里游 这种碎片）。 */
    const TAG_BY_PROFILE = 8;   // profile 字段切出来的标签不足这个数，才用记忆高频词补
    const TAG_CAP = 10;
    const profileTags: string[] = [];
    const memTags: Array<{ w: string; c: number }> = [];
    const addProfileTag = (t?: string | null) => {
      const s = String(t ?? '').trim();
      if (!s || s.length > 12 || profileTags.length >= TAG_CAP) return;
      if (profileTags.includes(s) || INSTR_RE.test(s) || INSTR_TAG_EXTRA_RE.test(s)) return;
      profileTags.push(s);
    };
    for (const t of (owner?.profileTags ?? [])) addProfileTag(t);
    for (const t of splitTags(o?.likes)) addProfileTag(t);
    for (const t of splitTags(o?.personality)) addProfileTag(t);
    if (profileTags.length < TAG_BY_PROFILE) {
      for (const m of (owner?.memoryTop ?? [])) {
        if (profileTags.length >= TAG_BY_PROFILE) break;
        const w = String(m?.w ?? '').trim();
        if (!w || w.length > 12 || INSTR_RE.test(w) || profileTags.includes(w)) continue;
        profileTags.push(w);
        memTags.push({ w, c: Number(m?.c) || 0 });
      }
    }

    /* persona（学习产出）各字段；正文走 cleanProse（窄名单丢说话要求行），碎片字段原样用 */
    const nick = String(persona?.nickname ?? '').trim() || null;
    const address = String(persona?.addressTerms ?? '').trim() || null;
    // o 可能是 /owner-profile 的 owner 对象（没有 personaSummary），也可能是图谱里的 VNode → 用 in 收窄
    const oSummary = o && 'personaSummary' in o ? o.personaSummary : null;
    const prose = cleanProse(persona?.profile) || cleanProse(persona?.personality) || cleanProse(oSummary);
    const personaEn = cleanProse(persona?.personaEn);
    const catchphrases = (persona?.catchphrases ?? [])
      .map((c) => ({ phrase: String(c?.phrase ?? '').trim(), context: String(c?.context ?? '').trim() }))
      .filter((c) => c.phrase).slice(0, 8);
    const st = persona?.style ?? null;
    const styleLines = [st?.sentenceLength, st?.rhetoricalQuestions, st?.toneWords]
      .map((x) => String(x ?? '').trim()).filter(Boolean);
    const styleExamples = (st?.examples ?? []).map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 4);
    const topics = (persona?.topics ?? []).map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 10);
    const taboos = (persona?.taboos ?? []).map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 6);
    const samples = persona?.samples ?? null;
    const learnedAtMs = Number(persona?.learnedAtMs || 0) || 0;

    /* "学过没有"按后端能拿到的**原始**数据判定（过滤与否不算）：
     * persona 条目存在 / 样本>0 / memoryTop 非空 / profileTags 非空 —— 满足任一条就不再显示"暂无档案" */
    const hasLearned = !!persona || (samples ?? 0) > 0
      || (owner?.memoryTop?.length ?? 0) > 0 || (owner?.profileTags?.length ?? 0) > 0;
    /* 有已学习痕迹，但是否有**能展示出来**的东西（过滤之后）——决定是显示内容还是那句"学过但没成文档案" */
    const hasContent = !!(prose || personaEn || nick || address || styleLines.length || styleExamples.length
      || catchphrases.length || topics.length || taboos.length
      || profileTags.length || cleanField(o?.likes) || cleanField(o?.personality));
    /* 是否有人格学习档案里的实质内容（决定要不要标"内容来自 persona-library"那句话） */
    const hasPersonaContent = !!(prose || personaEn || nick || address || styleLines.length || styleExamples.length
      || catchphrases.length || topics.length || taboos.length);

    return {
      name: o?.name || '主人', uid: o?.uid || '',
      nickname: nick && nick !== String(o?.name ?? '').trim() ? nick : null,
      address,
      birthday: cleanField(o?.birthday) || null,
      likes: cleanField(o?.likes) || null,
      personality: cleanField(o?.personality) || null,
      prose, personaEn, catchphrases, styleLines, styleExamples, topics, taboos,
      memTags, samples, learnedAtMs, hasLearned, hasContent, hasPersonaContent,
      tags: profileTags.slice(0, TAG_CAP),
    };
  }, [owner, allNodes]);

  const ego = useMemo(() => {
    if (!focus) return null;
    const links = allLinks.filter((l) => l.from === focus.uid || l.to === focus.uid).sort((a, b) => b.strength - a.strength).slice(0, 12);
    const neigh = links.map((l) => byUid.get(l.from === focus.uid ? l.to : l.from)).filter((x): x is VNode => !!x && x.uid !== focus.uid);
    const egoNodes = [focus, ...neigh];
    const egoLinks = links.map((l) => ({ from: focus.uid, to: l.from === focus.uid ? l.to : l.from, strength: l.strength })).filter((l) => egoNodes.some((n) => n.uid === l.to));
    return { neigh, egoNodes, egoLinks };
  }, [focus, allLinks, byUid]);

  const kindCnt = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of allNodes) {
      c[n.kind] = (c[n.kind] || 0) + 1;
      if (n.kind !== 'owner' && n.role === 'owner') c.roleOwner = (c.roleOwner || 0) + 1;
      if (n.kind !== 'owner' && n.role === 'admin') c.roleAdmin = (c.roleAdmin || 0) + 1;
    }
    return c;
  }, [allNodes]);

  const relLabelOf = (a: string, b: string): string => {
    const k = a < b ? a + '|' + b : b + '|' + a;
    return rels[k] ? (REL_CAT_LABEL[rels[k]] || rels[k]) : '';
  };
  /** 打开/切换一条线：状态归零，不残留上一次的 error / done；token+1 让在途的旧请求回包作废 */
  const openEdge = (e: EdgeClick) => { relReqRef.current++; setEdgeSel(e); setRelEdit({ st: 'idle' }); };
  /** 关闭卡片：**saving 时也允许关**（否则接口一直不回来，主人会被一个全禁用的卡片卡住）。
   *  关掉后 token 变化，回包不再改卡片状态；但服务端确实保存成功的话 setRels 照旧应用（见 submitRel）。 */
  const closeEdge = () => {
    relReqRef.current++;
    setEdgeSel(null); setRelEdit({ st: 'idle' }); setEdgePos(null);
  };
  /** 提交类别；cat 传空串 = 清除标注（后端 PUT /learning/relations 收到空 category 会 delete 这条记录） */
  const submitRel = async (cat: string) => {
    if (!edgeSel || relEdit.st === 'saving') return;   // 按钮已 disabled，这里再挡一次（快速双击/回车）
    const token = ++relReqRef.current;
    setRelEdit({ st: 'saving', cat });
    try {
      const r = await saveRelation(edgeSel.from, edgeSel.to, cat);
      // 服务端返回的是全量 relations，属于真值：卡片还在不在都应用，线色当帧就变
      // （setRels → 两处 NetCanvas 重渲染 → relationsRef 由 useEffect 同步，下一帧读到新配色，
      //  不用等重力收敛、也不用重排）。
      if (r?.ok) setRels(r.relations ?? {});
      // 卡片状态只在"还是这次提交"时才动：否则取消/换了另一条线之后，旧回包会把新卡片标成已保存并自动收起
      if (token !== relReqRef.current) return;
      if (r?.ok) setRelEdit({ st: 'done', cat });
      else setRelEdit({ st: 'error', cat, msg: r?.message || '接口返回失败' });
    } catch (e2: any) {
      if (token !== relReqRef.current) return;
      setRelEdit({ st: 'error', cat, msg: String(e2?.message ?? e2) });
    }
  };
  const locCands = locQ.trim() ? allNodes.filter((n) => cleanName(n.name).toLowerCase().includes(locQ.trim().toLowerCase()) || String(n.uid).includes(locQ.trim())).slice(0, 12) : [];
  const pickLoc = (uid: string) => { setLocQ(''); const n = byUid.get(uid); if (n) setFocus(n); };

  const tagsOf = (n: VNode) => {
    const arr = splitTags(n.likes).concat(splitTags(n.personality));
    for (const t of (n.tags ?? [])) { const tt = cleanField(t); if (tt && tt.length <= 12 && !arr.includes(tt)) arr.push(tt); }
    return arr.slice(0, 8);
  };

  return (
    <div className="page cute-ui">
      <div className="page-header">
        <div className="page-header-left">
          <button className="btn btn-sm" onClick={onBack}><ArrowLeft size={15} /> 返回</button>
          <div className="page-title-wrap">
            <div className="page-title">群友画像</div>
            <div className="page-subtitle">点一个人自动聚焦 · 半透明圆形简约风格</div>
          </div>
        </div>
        <div className="page-actions">
          <button className="btn btn-sm" onClick={() => { setFilter(filter === 'core' ? 'all' : 'core'); setRelayout((x) => x + 1); }}>
            {filter === 'core' ? '显示全部人' : '只显核心'}
          </button>
          <button className="btn btn-sm" onClick={() => setShowWeak(!showWeak)} title="弱关系连线开/关">
            {showWeak ? '隐藏弱关系' : '显示弱关系'}
          </button>
          <button className="btn btn-sm" disabled={loading} onClick={() => setRelayout((x) => x + 1)}><RotateCcw size={13} /> 重新布局</button>
          <button className="btn btn-sm" disabled={loading} onClick={loadAll}>{loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} 刷新</button>
        </div>
      </div>

      <div className="page-body">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', background: 'rgba(0,0,0,0.02)', border: '1px solid rgba(0,0,0,0.06)', borderRadius: 12, padding: '8px 12px', marginBottom: 14 }}>
          <span style={{ fontSize: 12.5, color: C.text, whiteSpace: 'nowrap' }}>选择群聊：</span>
          <select value={grpSel} onChange={(e) => { setGrpSel(e.target.value); setRelayout((x) => x + 1); }}
            style={{ maxWidth: 180, minWidth: 140, padding: '4px 8px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.15)', background: '#fff', color: C.text, fontSize: 12.5 }}>
            <option value="">全部群</option>
            {groupsList.map((g) => <option key={g.id} value={g.id}>{g.id.replace(/^group:/, '群')}（{g.members.length}人）</option>)}
          </select>
          <span style={{ fontSize: 12.5, color: C.text, whiteSpace: 'nowrap', marginLeft: 10 }}>快速定位：</span>
          <input list="pvLoc" value={locQ} onChange={(e) => setLocQ(e.target.value)}
            placeholder="输入昵称或QQ" style={{ minWidth: 150, padding: '4px 8px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.15)' }} />
          <datalist id="pvLoc">
            {locCands.map((n) => <option key={n.uid} value={cleanName(n.name)}>{n.uid}</option>)}
          </datalist>
          <button className="btn btn-sm" disabled={!locCands.length} onClick={() => locCands[0] && pickLoc(locCands[0].uid)}>定位</button>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12, color: C.textMuted }}>
            自动刷新画像
            <input type="checkbox" checked={!!pCfg?.enabled} onChange={async (e) => {
              const next = { enabled: e.target.checked, intervalDays: pCfg?.intervalDays || 7 };
              setPCfgSaving(true);
              try { const r = await savePortraitCfg(next); if (r) setPCfg(r); } catch {} finally { setPCfgSaving(false); }
            }} />
            <NumInput className="" value={pCfg?.intervalDays || 7}
              onCommit={async (n) => {
                const next = { enabled: pCfg?.enabled !== false, intervalDays: Math.max(1, Math.min(90, Math.round(n) || 7)) };
                setPCfgSaving(true);
                try { const r = await savePortraitCfg(next); if (r) setPCfg(r); } catch {} finally { setPCfgSaving(false); }
              }} title="每 N 天自动刷新一次（1~90）"
              style={{ width: 52, padding: '3px 6px', borderRadius: 6, border: '1px solid rgba(0,0,0,0.15)' }} />
            天{pCfgSaving ? '…' : ''}
            {pCfg && pCfg.lastAt > 0 && (
              <span>· 上次分析 {fmtTime(pCfg.lastAt)}</span>
            )}
          </span>
        </div>
        {/* ============ 主人画像(标准卡) ============ */}
        <div className="card">
          <div style={{ minWidth: 190 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <UserRound size={17} style={{ color: C.owner }} />
              <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>主人画像</span>
              {/* 徽标改成"学过没有"，不再看有没有那段短 personality（那正是"学过却显示暂无档案"的由来） */}
              <span style={{
                fontSize: 10.5, padding: '1px 8px', borderRadius: 999, fontWeight: 700,
                background: ownerInfo.hasLearned ? 'hsl(145 55% 93%)' : C.ownerSoft,
                color: ownerInfo.hasLearned ? 'hsl(150 50% 30%)' : C.owner,
              }}>{ownerInfo.hasLearned ? '已学习' : '未学习'}</span>
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginTop: 10 }}>{ownerInfo.name}</div>
            <div style={{ fontSize: 12, color: C.textMuted }}>QQ {ownerInfo.uid}</div>
            {ownerInfo.nickname && <div style={{ fontSize: 12.5, color: C.text, marginTop: 4 }}>昵称 {ownerInfo.nickname}</div>}
            {ownerInfo.address && <div style={{ fontSize: 12.5, color: C.text, marginTop: 2 }}>称呼 {ownerInfo.address}</div>}
            {ownerInfo.birthday && <div style={{ fontSize: 12.5, color: C.text, marginTop: 4 }}>生日 {ownerInfo.birthday}</div>}
            {ownerInfo.samples != null && <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 2 }}>人格样本 {ownerInfo.samples} 条</div>}
            {ownerInfo.learnedAtMs > 0 && <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 2 }}>最近学习 {fmtTime(ownerInfo.learnedAtMs)}</div>}
          </div>

          <div style={{ flex: '1 1 360px', minWidth: 280 }}>
            {(ownerInfo.likes || ownerInfo.personality) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 10 }}>
                {ownerInfo.likes && <div style={{ fontSize: 13, color: C.text }}>爱好：<span style={{ color: C.textMuted, fontWeight: 400 }}>{ownerInfo.likes}</span></div>}
                {ownerInfo.personality && <div style={{ fontSize: 13, color: C.text }}>性格：<span style={{ color: C.textMuted, fontWeight: 400 }}>{ownerInfo.personality}</span></div>}
              </div>
            )}
            {/* 标签：实心 = 已整理档案字段切出来的；虚线 = 记忆高频词补的（来历在下面那行说明） */}
            {ownerInfo.tags.length > 0 && (
              <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {ownerInfo.tags.map((t, i) => {
                    const mem = ownerInfo.memTags.find((m) => m.w === t);
                    return (
                      <span key={t + i} title={mem ? `记忆高频词，出现 ${mem.c} 次` : '来自已整理的档案字段'}
                        style={{
                          padding: '3px 11px', borderRadius: 999, fontSize: 12,
                          background: mem ? 'transparent' : (i % 2 ? C.friendSoft : C.ownerSoft),
                          color: mem ? C.textMuted : (i % 2 ? C.friend : C.owner),
                          border: mem ? '1px dashed rgba(0,0,0,0.2)' : '1px solid transparent',
                        }}>{t}</span>
                    );
                  })}
                </div>
                {ownerInfo.memTags.length > 0 && (
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>
                    虚线标签来自<b>记忆高频词</b>（记忆条目按字频切出来的二字词，没有词典，可能出现碎词）；
                    主人 profile 那几个字段基本是空的，所以标签主要靠它兜底
                  </div>
                )}
              </>
            )}

            {/* 学习档案：沿用聚焦弹层「学习档案」那套折叠 + 内滚（.pv-intro 折起来 96px / 展开 240px 封顶），
                档案再长也只滚，不把这张卡拉长。整块只在"确实学过"时才出现，没学过就只剩下面那句空状态 */}
            {ownerInfo.hasLearned && (
            <div className="pv-prof" style={{ marginTop: 10 }}>
              <div className="pv-prof-head">
                {ownerInfo.samples != null && <span className="pv-meta">人格样本 <b>{ownerInfo.samples}</b> 条</span>}
                {ownerInfo.memTags.length > 0 && <span className="pv-meta">记忆高频词 <b>{ownerInfo.memTags.length}</b> 个</span>}
                {ownerInfo.learnedAtMs > 0 && <span className="pv-meta">最近学习 {fmtTime(ownerInfo.learnedAtMs)}</span>}
                {ownerInfo.hasContent && (
                  <button className="btn btn-sm pv-prof-toggle" onClick={() => setOwnerOpen((v) => !v)}>
                    {ownerOpen ? '收起档案 ▾' : '展开档案 ▸'}
                  </button>
                )}
              </div>
              {/* 标明来历：档案内容来自人格学习（state/persona-library.json），已按「说话要求」规则过滤；
                  万一还有命令句漏进来，主人能立刻看出是从哪来的 */}
              {ownerInfo.hasPersonaContent && (
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
                  内容来自人格学习档案（persona-library），已过滤「给模型的说话要求」；聊天里的说话要求不会当成人格展示
                </div>
              )}
              {(ownerInfo.prose || ownerInfo.personaEn) && (
                <div className={`pv-intro${ownerOpen ? ' is-open' : ''}`}>
                  {ownerInfo.prose && <p className="pv-prose">{ownerInfo.prose}</p>}
                  {ownerOpen && ownerInfo.personaEn && (
                    <p className="pv-prose" style={{ marginTop: 8, opacity: 0.85 }}>
                      <b style={{ color: C.textMuted, fontWeight: 600 }}>英文人设正文</b>{'\n'}{ownerInfo.personaEn}
                    </p>
                  )}
                </div>
              )}
              {/* 碎片信息只在展开时出现；口径与「学习」页一致：口头禅/风格/话题/禁忌 */}
              {ownerOpen && (ownerInfo.catchphrases.length > 0 || ownerInfo.styleLines.length > 0 || ownerInfo.styleExamples.length > 0 || ownerInfo.topics.length > 0 || ownerInfo.taboos.length > 0) && (
                <div style={{ marginTop: 8, fontSize: 12.5, color: C.text, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {ownerInfo.catchphrases.length > 0 && (
                    <div>
                      <span style={{ color: C.textMuted }}>口头禅</span>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                        {ownerInfo.catchphrases.map((c, i) => (
                          <span key={c.phrase + i} title={c.context || undefined}
                            style={{ padding: '2px 9px', borderRadius: 999, fontSize: 12, background: C.ownerSoft, color: C.owner }}>{c.phrase}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {(ownerInfo.styleLines.length > 0 || ownerInfo.styleExamples.length > 0) && (
                    <div style={{ lineHeight: 1.7 }}>
                      <span style={{ color: C.textMuted }}>说话风格</span>
                      <div>{ownerInfo.styleLines.join(' · ')}</div>
                      {ownerInfo.styleExamples.length > 0 && (
                        <div style={{ color: C.textMuted, marginTop: 2 }}>例：{ownerInfo.styleExamples.map((e) => `「${e}」`).join(' ')}</div>
                      )}
                    </div>
                  )}
                  {ownerInfo.topics.length > 0 && (
                    <div style={{ lineHeight: 1.7 }}><span style={{ color: C.textMuted }}>常聊话题</span> {ownerInfo.topics.join('、')}</div>
                  )}
                  {ownerInfo.taboos.length > 0 && (
                    <div style={{ lineHeight: 1.7 }}><span style={{ color: C.textMuted }}>忌讳</span> {ownerInfo.taboos.join('、')}</div>
                  )}
                </div>
              )}
            </div>
            )}

            {/* 空状态两种口径：
                ① 一点已学习痕迹都没有 → 保留原来那句（并说明为什么不展示聊天里的说话要求）；
                ② 学过了、但过滤之后确实没有可展示的成文档案 → 说明情况，别再说"暂无已整理档案" */}
            {!ownerInfo.hasLearned && (
              <div style={{ color: C.textMuted, fontSize: 12.5 }}>暂无已整理档案（不会展示聊天里的说话要求）</div>
            )}
            {ownerInfo.hasLearned && !ownerInfo.hasContent && (
              <div style={{ color: C.textMuted, fontSize: 12.5 }}>
                已学习过{ownerInfo.samples ? `（样本 ${ownerInfo.samples} 条）` : ''}，但记忆库里还没有可展示的成文档案；
                可到「学习」页看「人格学习状态」，或对主人做一次「人格立即学习」。
              </div>
            )}
          </div>
        </div>

        {/* ============ 群友关系图(标准卡,图加高) ============ */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 15, fontWeight: 700, color: C.text }}>
              <Users size={16} style={{ color: C.friend }} /> 群友关系图
            </span>
            <span style={{ fontSize: 12, color: C.textMuted }}>
              {mainNodes.length} 人 · {mainLinks.length} 关系{filter === 'core' ? '（核心）' : ''} · 图上会自动缓缓漂动，点击任一圆点 → 弹开档案与关系网
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 12.5, color: C.textMuted }}>
              <span style={{ color: C.owner, marginRight: 12 }}>● 主人 ×{kindCnt.owner ?? 0}</span>
              {/* 群主/管理员计数用角色环同色，和球上那圈细环对得上（拿不到 role 时是 0，不显示假的） */}
              {(kindCnt.roleOwner ?? 0) > 0 && <span style={{ color: C.roleOwner, marginRight: 12 }}>◍ 群主 ×{kindCnt.roleOwner}</span>}
              {(kindCnt.roleAdmin ?? 0) > 0 && <span style={{ color: C.roleAdmin, marginRight: 12 }}>◍ 管理员 ×{kindCnt.roleAdmin}</span>}
              <span style={{ color: C.friend, marginRight: 12 }}>● 私聊 ×{kindCnt.friend ?? 0}</span>
              <span style={{ color: C.member }}>● 群员 ×{kindCnt.member ?? 0}</span>
            </span>
          </div>
          {err && <div style={{ color: '#c0504d', fontSize: 12.5, marginBottom: 8 }}>{err}<button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={loadAll}>重试</button></div>}
          {/* 线色图例：主人要求"大图上显示对应线的颜色"，但页面上原来没有图例，标过色的线看起来只是"随机彩色" */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', fontSize: 11.5, color: C.textMuted, marginBottom: 8 }}>
            <span>关系线：</span>
            {(['guimi', 'jiaren', 'qinglv', 'chouren', 'qunyou'] as const).map((c) => (
              <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <i style={{ width: 15, height: 2.5, borderRadius: 2, background: REL_CAT_COLOR[c], display: 'inline-block' }} />{REL_CAT_LABEL[c]}
              </span>
            ))}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <i style={{ width: 15, height: 2.5, borderRadius: 2, background: 'linear-gradient(90deg,#c9d2dd,#7a8ba0)', display: 'inline-block' }} />未标注
            </span>
            <span>（点一条连线即可标注/清除）</span>
          </div>
          <div ref={mainBoxRef} style={{ height: 600, position: 'relative', border: '1px solid rgba(0,0,0,0.07)', borderRadius: 16, background: 'rgba(255,255,255,0.6)', overflow: 'hidden' }}>
            {loading && !graph ? (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: C.textMuted }}><Loader2 size={18} className="spin" /> 读取画像数据…</div>
            ) : !graph || mainNodes.length === 0 ? (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: C.textMuted, fontSize: 13, gap: 8 }}>
                <Sparkles size={28} style={{ opacity: 0.5 }} />
                <div>还没有画像数据：让机器人正常聊一阵子，或做几次「人格学习」</div>
              </div>
            ) : (
              <NetCanvas nodes={mainNodes} links={mainLinks} selectedUid={focus?.uid ?? null} relations={rels}
                onEdge={(e) => {
                  const el = mainBoxRef.current;
                  openEdge(e);
                  // 记下落点+容器尺寸，把浮层卡片夹在画布内（容器 overflow:hidden，贴边会被切掉）
                  setEdgePos({ x: e.sx, y: e.sy, w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 });
                }}
                onPick={(u) => { setFocus(u ? (byUid.get(u) ?? null) : null); if (!u) closeEdge(); }} onOpen={(n) => setFocus(n)} />
            )}
            {/* 主图上的关系标注浮层。以前 edgeSel 只在聚焦弹层里渲染，于是"在首页点一条线"什么都没发生
                （状态设了但没人画），下次打开聚焦弹层还会把这口旧状态带出来。 */}
            {edgeSel && edgePos && !focus && (
              <div style={{
                position: 'absolute', width: 340, transform: 'translateX(-50%)', zIndex: 5,
                left: Math.max(178, Math.min(edgePos.w - 178, edgePos.x)),
                top: Math.max(8, Math.min(edgePos.h - 150, edgePos.y + 14)),
              }}>
                <RelEdgeCard
                  title={cleanName(byUid.get(edgeSel.from)?.name || edgeSel.from) + ' ↔ ' + cleanName(byUid.get(edgeSel.to)?.name || edgeSel.to)}
                  current={relLabelOf(edgeSel.from, edgeSel.to)}
                  state={relEdit} floating
                  onPick={submitRel} onClose={closeEdge} />
              </div>
            )}
            <div style={{ position: 'absolute', left: 12, bottom: 8, fontSize: 11.5, color: C.textMuted }}>拖拽移动 · 点击一个人聚焦 · 点一条线标注关系（视图大小已固定）</div>
          </div>
        </div>
      </div>

      {/* ============ 聚焦弹层(大卡片,不依赖滚动) ============ */}
      {focus && ego && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(20,20,28,0.32)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} onClick={() => setFocus(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 18, width: 'min(980px, 94vw)', maxHeight: '88vh', overflow: 'auto', padding: '20px 24px', boxShadow: '0 18px 60px rgba(0,0,0,0.18)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ width: 14, height: 14, borderRadius: '50%', background: colorOf(focus.kind), opacity: 0.85, display: 'inline-block' }} />
              <span style={{ fontSize: 16, fontWeight: 800, color: C.text }}>{cleanName(focus.name)}</span>
              <span style={{ fontSize: 13, color: C.textMuted }}>QQ {focus.uid} ·</span>
              {/* 角色：群主/管理员给药丸徽标（金/青），其余是纯文本 kindLabelOf 的回落文案；
                  主人自己（kind==='owner'）永远显示「主人」，不被 role 覆盖 */}
              {(() => {
                const b = roleBadgeOf(focus);
                return b
                  ? <span style={{ fontSize: 12, fontWeight: 700, padding: '1px 9px', borderRadius: 999, background: b.bg, color: b.fg }}>{b.text}</span>
                  : <span style={{ fontSize: 13, color: C.textMuted }}>{kindLabelOf(focus)}</span>;
              })()}
              <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => setFocus(null)} title="关闭"><X size={18} /></button>
            </div>

            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 10 }}>
              {/* 左: 重要档案 */}
              <div style={{ flex: '1 1 420px', minWidth: 320 }}>
                {relSel && (
                    <div style={{ border: '1px solid rgba(217,95,142,0.35)', background: 'rgba(217,95,142,0.05)', borderRadius: 12, padding: '10px 12px', marginBottom: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, fontWeight: 700, color: C.text }}>
                        <span style={{ width: 12, height: 12, borderRadius: '50%', background: colorOf(focus.kind), display: 'inline-block' }} />
                        <span>{cleanName(focus.name)}</span>
                        <span style={{ color: C.textMuted, fontWeight: 400 }}>与</span>
                        <span style={{ width: 12, height: 12, borderRadius: '50%', background: colorOf(relSel.node.kind), display: 'inline-block' }} />
                        <span>{cleanName(relSel.node.name)}</span>
                        <span style={{ marginLeft: 'auto', color: C.textMuted, fontWeight: 400, fontSize: 12 }}>
                          互动强度 {Math.round((relSel.strength ?? 0) * 100)}%
                        </span>
                      </div>
                      <div style={{ height: 6, borderRadius: 3, background: 'rgba(0,0,0,0.06)', marginTop: 8, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: Math.max(2, Math.min(100, Math.round((relSel.strength ?? 0) * 100))) + '%', background: 'linear-gradient(90deg,#e77ca4,#d95f8e)', borderRadius: 3 }} />
                      </div>
                      <div style={{ marginTop: 8, fontSize: 12.5, color: C.text, lineHeight: 1.6 }}>
                        {(() => {
                          const s = relSel.strength ?? 0;
                          const tag = s >= 0.6 ? '关系很热络，常在一起聊天' : s >= 0.35 ? '有稳定往来' : s >= 0.12 ? '偶尔互动' : '互动较少';
                          return <>{tag}。想进一步了解 ta，可在下方查看「发过的消息」。</>;
                        })()}
                      </div>
                    </div>
                  )}
                {tagsOf(focus).length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                    {tagsOf(focus).map((t, i) => (
                      <span key={t + i} style={{ padding: '3px 11px', borderRadius: 999, fontSize: 12.5, background: i % 2 ? C.friendSoft : C.memberSoft, color: i % 2 ? C.friend : C.member }}>{t}</span>
                    ))}
                  </div>
                )}
                {/* 学习档案：说法与「学习」页的「人格学习状态」一致（已学习/无档案 · 最近学习 · 近30天发言 · 记忆条目）；
                    完整介绍折叠 + 内滚（app.css 的 .pv-intro），多长的档案也不会把弹窗拉长 */}
                {(() => {
                  const uid = focus.uid;
                  const d = profData[uid] ?? null;
                  const busy = profBusy === uid;
                  const fErr = profErr[uid] || '';
                  const lib = d?.library ?? null;
                  const pf = d?.profile ?? null;
                  // 取不到库时退回图谱里那份（截断过的）摘要，别让已有信息凭空消失
                  const intro = String(lib?.profile || pf?.personality || d?.personaSummary || '').trim()
                    || (fErr ? String(focus.personaSummary || '').trim() : '');
                  const learnedAt = Number(d?.personaAt || pf?.updatedAt || 0) || 0;
                  const n30 = Number(d?.msgCount || 0) || 0;
                  const memN = Number(d?.memoryCount || 0) || 0;
                  const has = !!(intro || pf || lib) || learnedAt > 0;
                  return (
                    <div className="pv-prof">
                      <div className="pv-prof-head">
                        <span className={`pv-badge${has ? ' is-on' : ''}`}>{has ? '已学习' : '无档案'}</span>
                        <span className="pv-meta">{learnedAt > 0 ? `最近学习 ${fmtTime(learnedAt)}` : '尚未学习'}</span>
                        {n30 > 0 && <span className="pv-meta">近 30 天发言 <b>{n30}</b> 条</span>}
                        {memN > 0 && <span className="pv-meta">记忆条目 <b>{memN}</b> 条</span>}
                        {intro && (
                          <button className="btn btn-sm pv-prof-toggle" onClick={() => setProfOpen((o) => !o)}>
                            {profOpen ? '收起档案 ▾' : '展开档案 ▸'}
                          </button>
                        )}
                      </div>
                      {busy && <div className="pv-note"><Loader2 size={12} className="spin" /> 正在读取档案…</div>}
                      {!busy && fErr && <div className="pv-note">档案读取失败：{fErr}</div>}
                      {!busy && !fErr && !has && (
                        <div className="pv-note">记忆库里还没有 ta 的档案：多聊几次，或到「学习」页点一次「人格立即学习」，这里就会像「人格学习状态」那样显示已学习、最近学习时间和样本数。</div>
                      )}
                      {intro && (
                        <div className={`pv-intro${profOpen ? ' is-open' : ''}`}>
                          <p className="pv-prose">{intro}</p>
                        </div>
                      )}
                    </div>
                  );
                })()}
                {focus.birthday && <InfoRow k="生日" v={String(focus.birthday)} />}
                {cleanField(focus.personality) && <InfoRow k="性格特征" v={cleanField(focus.personality)} />}
                {cleanField(focus.likes) && <InfoRow k="爱好" v={cleanField(focus.likes)} />}
                {/* 完整介绍已在上面「学习档案」块里显示（且不截断），这里不再重复一遍 personaSummary */}
                {/* 「近 30 天发言」已在上面学习档案块里（与 /api/learning/profile 同一口径），这里不再说第二遍 */}
                <div style={{ display: 'flex', gap: 20, marginTop: 12, fontSize: 12.5, color: C.textMuted }}>
                  <span>最近活跃 {focus.lastSeen ? fmtTime(focus.lastSeen) : '—'}</span>
                </div>

                {/* 发过的消息(仅点击展开; 不自动) */}
                <div style={{ marginTop: 14 }}>
                  <button className="btn btn-sm" onClick={() => { if (!msgsOpen && msgs === null) loadPersonMsgs(focus); setMsgsOpen(!msgsOpen); }}>
                    <History size={13} /> {msgsOpen ? '收起 Ta 发过的消息' : '查看 Ta 发过的消息'}
                  </button>
                  {msgsOpen && (
                    <div style={{ marginTop: 10, maxHeight: 220, overflowY: 'auto', border: '1px solid rgba(0,0,0,0.07)', borderRadius: 10, padding: '6px 10px', background: 'rgba(0,0,0,0.02)' }}>
                      {msgsLoading && <div style={{ color: C.textMuted, fontSize: 12, padding: 6 }}><Loader2 size={12} className="spin" /> 加载中…</div>}
                      {!msgsLoading && msgsErr && <div style={{ color: '#c0504d', fontSize: 12, padding: 6 }}>{msgsErr}</div>}
                      {!msgsLoading && !msgsErr && (!msgs || msgs.length === 0) && (
                        <div style={{ color: C.textMuted, fontSize: 12, padding: 6 }}>还没有记录到 ta 发过的消息(需先在群里/私聊有往来并落库)</div>
                      )}
                      {!msgsLoading && msgs && msgs.map((m, i) => (
                        <div key={i} style={{ padding: '7px 2px', borderBottom: i < msgs.length - 1 ? '1px solid rgba(0,0,0,0.05)' : 'none' }}>
                          <div style={{ fontSize: 11, color: C.textMuted }}>{m.ts} · {String(m.conv || '').replace(/^(group|private):/, (x: string) => (x === 'group:' ? '群' : '私聊'))}</div>
                          <div style={{ fontSize: 12.5, color: C.text, lineHeight: 1.5, wordBreak: 'break-word' }}>{trunc(String(m.content || ''), 160) || '(图片/表情)'}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* 右: 个人关系图(可拖转,默认自动缓转) */}
              <div style={{ flex: '1 1 440px', minWidth: 340 }}>
                {edgeSel && (
                  <RelEdgeCard
                    title={cleanName(byUid.get(edgeSel.from)?.name || edgeSel.from) + ' ↔ ' + cleanName(byUid.get(edgeSel.to)?.name || edgeSel.to)}
                    current={relLabelOf(edgeSel.from, edgeSel.to)}
                    state={relEdit}
                    onPick={submitRel} onClose={closeEdge} />
                )}
                <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 6 }}>
                  与 ta 互动较多（{ego.neigh.length} 人）· 拖转后暂停自动旋转（双击恢复）· 线色与主图同一套；点壳上的人 → 看 ta 与 {cleanName(focus.name)} 的互动强度，点线 → 标注关系
                </div>
                <div style={{ height: 340, border: '1px solid rgba(0,0,0,0.06)', borderRadius: 14, position: 'relative', overflow: 'hidden' }}>
                  {ego.egoNodes.length >= 2 ? (
                    <div style={{ position: 'absolute', inset: 0 }}>
                      {/* key 只跟焦点人物走。原来还带了 relSel?.node.uid —— 点一个邻居就换 key 整块重挂，
                          重挂会重新初始化相机(看好的角度被弹回正面)、重新从 TEMP_INIT 收敛一遍，
                          这就是"点一下图就跳一下"的来源。选中高亮本来就由 selectedUid 负责，不用重挂。 */}
                      <NetCanvas key={'ego' + focus.uid} nodes={ego.egoNodes} links={ego.egoLinks} centerUid={focus.uid}
                        selectedUid={relSel?.node.uid ?? focus.uid}
                        relations={rels}
                        pauseSpinOnDrag
                        onEdge={openEdge}
                        onOpen={(nn) => {
                          if (nn.uid === focus.uid) { setRelSel(null); return; }
                          const lk = ego.egoLinks.find((l) => l.to === nn.uid);
                          setRelSel({ node: nn, strength: lk ? lk.strength : 0 });
                        }}
                        onPick={(u) => { if (!u) { setRelSel(null); closeEdge(); } }} />
                    </div>
                  ) : (
                    <div style={{ color: C.textMuted, fontSize: 12.5, textAlign: 'center', paddingTop: 150 }}>暂无明显关系人</div>
                  )}
                  <div style={{ position: 'absolute', right: 8, bottom: 6, fontSize: 11, color: C.textMuted }}>点一个人看互动强度 · 双击空白处恢复自动旋转</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InfoRow({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ marginBottom: 8, fontSize: 14, lineHeight: 1.6 }}>
      <span style={{ color: C.textMuted, marginRight: 8 }}>{k}</span>
      <span style={{ color: C.text }}>{v}</span>
    </div>
  );
}
