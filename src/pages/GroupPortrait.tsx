import { useEffect, useMemo, useRef, useState } from 'react';
import { getLearningGraph, getOwnerProfile, getPersonMessages, getPersonProfile, getPortraitCfg, savePortraitCfg, getLearningGroups, getRelations, saveRelation } from '../api';
import type { PersonMsg, PortraitCfg, GroupInfo } from '../api';
import { NetCanvas, REL_CAT_COLOR, type EdgeClick } from './NetCanvas';
import type { GraphData, GraphNode, GraphLink, OwnerProfileResp } from '../api';
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
};

export type VKind = 'owner' | 'friend' | 'member' | 'tag';
export interface VNode {
  uid: string; name: string; kind: VKind; tags?: string[];
  msgCount?: number; lastSeen?: number | null;
  birthday?: string | null; personality?: string | null; likes?: string | null;
  personaSummary?: string | null;
}
export interface VLink { from: string; to: string; strength: number; }
const KIND_LABEL: Record<VKind, string> = { owner: '主人', friend: '私聊好友', member: '群成员', tag: '标签' };

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
  const [relSaving, setRelSaving] = useState(false);
  const [relayout, setRelayout] = useState(0);

  /* 【2026-09-14 主人反馈】聚焦弹层原来只有一行「还没有整理过的档案：多聊几次或对 ta 做「人格学习」会充实起来」——
   * 哪怕这个人**早就被学习过**也照说不误（因为弹层只看图谱接口那几个被截断的短字段）。
   * 现在改成和「学习」页「人格学习状态」同一套说法：已学习/无档案 + 最近学习 + 近30天发言 + 记忆条目，
   * 数据按需直读桥的 memory.db（/api/learning/profile，不截断）；长文折叠 + 内滚，不把弹窗拉长。 */
  const [profData, setProfData] = useState<Record<string, any>>({});
  const [profBusy, setProfBusy] = useState('');
  const [profErr, setProfErr] = useState<Record<string, string>>({});
  const [profOpen, setProfOpen] = useState(false);

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
  useEffect(() => { setMsgs(null); setMsgsOpen(false); setMsgsErr(''); setRelSel(null); }, [focus?.uid]);
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
    uid: n.uid, name: n.name, kind: n.kind, tags: n.tags ?? [], msgCount: n.msgCount, lastSeen: n.lastSeen,
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

  /* 主人画像: 只留真实档案,过滤"给模型的说话要求" */
  const ownerInfo = useMemo(() => {
    const o = owner?.owner ?? allNodes.find((n) => n.kind === 'owner') ?? null;
    const persona = owner?.persona ?? null;
    const tags = splitTags(o?.likes);
    const pT = splitTags(o?.personality);
    for (const t of pT) if (!tags.includes(t)) tags.push(t);
    return {
      name: o?.name || '主人', uid: o?.uid || '',
      birthday: cleanField(o?.birthday) || null,
      likes: cleanField(o?.likes) || null,
      personality: cleanField(o?.personality) || null,
      persona: persona?.personality && !INSTR_RE.test(String(persona.personality)) ? String(persona.personality).slice(0, 160) : null,
      samples: persona?.samples ?? null,
      tags: tags.slice(0, 8),
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
    for (const n of allNodes) c[n.kind] = (c[n.kind] || 0) + 1;
    return c;
  }, [allNodes]);

  const relLabelOf = (a: string, b: string): string => {
    const k = a < b ? a + '|' + b : b + '|' + a;
    const map: Record<string, string> = { guimi: '闺蜜', jiaren: '家人', qinglv: '情侣', chouren: '仇人', qunyou: '群友' };
    return rels[k] ? (map[rels[k]] || rels[k]) : '';
  };
  const pickRelCat = async (cat: string) => {
    if (!edgeSel) return;
    setRelSaving(true);
    try { const r = await saveRelation(edgeSel.from, edgeSel.to, cat); if (r?.ok) setRels(r.relations); setEdgeSel(null); } catch {} finally { setRelSaving(false); }
  };
  const clearRelCat = async () => { await pickRelCat('qunyou'); };
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
              {ownerInfo.persona && <span style={{ fontSize: 10.5, padding: '1px 8px', borderRadius: 999, background: C.ownerSoft, color: C.owner }}>人格档案</span>}
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginTop: 10 }}>{ownerInfo.name}</div>
            <div style={{ fontSize: 12, color: C.textMuted }}>QQ {ownerInfo.uid}</div>
            {ownerInfo.birthday && <div style={{ fontSize: 12.5, color: C.text, marginTop: 4 }}>生日 {ownerInfo.birthday}</div>}
            {ownerInfo.samples != null && <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 2 }}>人格样本 {ownerInfo.samples} 条</div>}
          </div>

          <div style={{ flex: '1 1 360px', minWidth: 280 }}>
            {(ownerInfo.likes || ownerInfo.personality) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 10 }}>
                {ownerInfo.likes && <div style={{ fontSize: 13, color: C.text }}>爱好：<span style={{ color: C.textMuted, fontWeight: 400 }}>{ownerInfo.likes}</span></div>}
                {ownerInfo.personality && <div style={{ fontSize: 13, color: C.text }}>性格：<span style={{ color: C.textMuted, fontWeight: 400 }}>{ownerInfo.personality}</span></div>}
              </div>
            )}
            {ownerInfo.tags.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {ownerInfo.tags.map((t, i) => (
                  <span key={t + i} style={{ padding: '3px 11px', borderRadius: 999, fontSize: 12, background: i % 2 ? C.friendSoft : C.ownerSoft, color: i % 2 ? C.friend : C.owner }}>{t}</span>
                ))}
              </div>
            )}
            {ownerInfo.persona && (
              <div style={{ fontSize: 12.5, lineHeight: 1.65, color: C.text, marginTop: 10, borderLeft: `2px solid ${C.owner}55`, paddingLeft: 12 }}>
                {ownerInfo.persona}
              </div>
            )}
            {!ownerInfo.likes && !ownerInfo.personality && !ownerInfo.persona && ownerInfo.tags.length === 0 && (
              <div style={{ color: C.textMuted, fontSize: 12.5 }}>暂无已整理档案（不会展示聊天里的说话要求）</div>
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
              <span style={{ color: C.friend, marginRight: 12 }}>● 私聊 ×{kindCnt.friend ?? 0}</span>
              <span style={{ color: C.member }}>● 群员 ×{kindCnt.member ?? 0}</span>
            </span>
          </div>
          {err && <div style={{ color: '#c0504d', fontSize: 12.5, marginBottom: 8 }}>{err}<button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={loadAll}>重试</button></div>}
          <div style={{ height: 600, position: 'relative', border: '1px solid rgba(0,0,0,0.07)', borderRadius: 16, background: 'rgba(255,255,255,0.6)', overflow: 'hidden' }}>
            {loading && !graph ? (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: C.textMuted }}><Loader2 size={18} className="spin" /> 读取画像数据…</div>
            ) : !graph || mainNodes.length === 0 ? (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: C.textMuted, fontSize: 13, gap: 8 }}>
                <Sparkles size={28} style={{ opacity: 0.5 }} />
                <div>还没有画像数据：让机器人正常聊一阵子，或做几次「人格学习」</div>
              </div>
            ) : (
              <NetCanvas nodes={mainNodes} links={mainLinks} selectedUid={focus?.uid ?? null} relations={rels}
                onEdge={(e) => setEdgeSel(e)}
                onPick={(u) => setFocus(u ? (byUid.get(u) ?? null) : null)} onOpen={(n) => setFocus(n)} />
            )}
            <div style={{ position: 'absolute', left: 12, bottom: 8, fontSize: 11.5, color: C.textMuted }}>拖拽移动 · 点击一个人聚焦（视图大小已固定）</div>
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
              <span style={{ fontSize: 13, color: C.textMuted }}>QQ {focus.uid} · {KIND_LABEL[focus.kind]}</span>
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

              {/* 右: 个人关系图(可拖动、自动漂动,点邻居切换) */}
              <div style={{ flex: '1 1 440px', minWidth: 340 }}>
                {edgeSel && (
                  <div style={{ border: '1px solid rgba(120,120,190,0.4)', background: 'rgba(255,255,255,0.92)', borderRadius: 12, padding: '8px 12px', marginBottom: 8, boxShadow: '0 6px 20px rgba(0,0,0,0.1)' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 6 }}>
                      {cleanName(byUid.get(edgeSel.from)?.name || edgeSel.from)} ↔ {cleanName(byUid.get(edgeSel.to)?.name || edgeSel.to)}
                      {relLabelOf(edgeSel.from, edgeSel.to) && <span style={{ marginLeft: 6, fontWeight: 400, color: C.textMuted, fontSize: 12 }}>当前: {relLabelOf(edgeSel.from, edgeSel.to)}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      {(['qunyou', 'guimi', 'jiaren', 'qinglv', 'chouren'] as const).map((c) => (
                        <button key={c} className="btn btn-sm" disabled={relSaving} onClick={() => pickRelCat(c)}
                          style={{ border: '1px solid ' + REL_CAT_COLOR[c], color: REL_CAT_COLOR[c], background: 'transparent' }}>
                          {c === 'qunyou' ? '群友' : c === 'guimi' ? '闺蜜/诡秘' : c === 'jiaren' ? '家人' : c === 'qinglv' ? '情侣' : '仇人'}
                        </button>
                      ))}
                      <button className="btn btn-sm" disabled={relSaving} onClick={() => setEdgeSel(null)}>取消</button>
                    </div>
                  </div>
                )}
                <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 6 }}>与 ta 互动较多（{ego.neigh.length} 人）· 可拖转（视图大小已固定）；点壳上其它人 → 左边看 ta 与主人的关系</div>
                <div style={{ height: 340, border: '1px solid rgba(0,0,0,0.06)', borderRadius: 14, position: 'relative', overflow: 'hidden' }}>
                  {ego.egoNodes.length >= 2 ? (
                    <div style={{ position: 'absolute', inset: 0 }}>
                      <NetCanvas key={'ego' + focus.uid + (relSel?.node.uid ?? '')} nodes={ego.egoNodes} links={ego.egoLinks} centerUid={focus.uid}
                        selectedUid={relSel?.node.uid ?? focus.uid}
                        relations={rels}
                        onEdge={(e) => setEdgeSel(e)}
                        onOpen={(nn) => {
                          if (nn.uid === focus.uid) { setRelSel(null); return; }
                          const lk = ego.egoLinks.find((l) => l.to === nn.uid);
                          setRelSel({ node: nn, strength: lk ? lk.strength : 0 });
                        }}
                        onPick={(u) => { if (!u) setRelSel(null); }} />
                    </div>
                  ) : (
                    <div style={{ color: C.textMuted, fontSize: 12.5, textAlign: 'center', paddingTop: 150 }}>暂无明显关系人</div>
                  )}
                  <div style={{ position: 'absolute', right: 8, bottom: 6, fontSize: 11, color: C.textMuted }}>点其它人可切换查看</div>
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
