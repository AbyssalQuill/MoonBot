import { useEffect, useMemo, useRef, useState } from 'react';
import { getLearningGraph, getOwnerProfile, getPersonMessages, getPersonProfile, getPortraitCfg, savePortraitCfg, getLearningGroups, getRelations, saveRelation } from '../api';
import type { PersonMsg, PortraitCfg, GroupInfo } from '../api';
import { NetCanvas, REL_CAT_COLOR, REL_CAT_LABEL, type EdgeClick } from './NetCanvas';
import type { GraphData, GraphNode, GraphLink, GraphRole, OwnerProfileResp } from '../api';
import { ArrowLeft, Users, Loader2, RefreshCw, RotateCcw, X, UserRound, Sparkles, History } from 'lucide-react';
import NumInput from '../components/NumInput';
import Dropdown from '../components/Dropdown';

interface Props { onBack: () => void; }

/* ============ 画像读取失败：区分「尚未生成」与「读取未成功」 ============
   （2026-09-30 反馈：「因为桥一次也没运行，所以没有群友画像正常，「部分画像数据读取失败」这个没必要，
    换个更贴切的说法」）
   桥从未运行过时，服务端直读记忆库会失败，原话是
   「找不到桥记忆库 memory.db（已探测 …），请先让桥至少跑过一次」——
   此时"还没有画像数据"是客观事实，说成"失败"既不准确，也容易让人以为出了故障。
   故：命中该原因 → 表述为「尚未生成」；其余 → 表述为「暂时读取不到」（读取环节的问题）。 */
const NEVER_RAN_RE = /memory\.db|至少跑过一次|找不到桥记忆库/;
/** 从接口回包/异常里取一句可读原因（桥侧信封的 detail > message > error）。 */
const reasonOf = (r: any): string => String(r?.detail || r?.message || r?.error || '').trim();

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
  /* 群主/管理员徽标色：两个色相拉开（金 42° / 青 172°），且不用私聊好友的靛蓝与群成员的蓝，
   * 以免「群主」与「管理员」之间、以及徽标与节点色之间产生歧义。NetCanvas 中同色的角色环取同一组色值。 */
  roleOwner: '#c98a00',
  roleAdmin: '#0b7d74',
};

export type VKind = 'owner' | 'friend' | 'member' | 'tag';
export interface VNode {
  uid: string; name: string; kind: VKind; tags?: string[];
/** 群内角色（由后端 /api/learning/graph 返回；null/undefined 表示未取到，按「群成员」回落） */
  role?: GraphRole | null;
  msgCount?: number; lastSeen?: number | null;
  birthday?: string | null; personality?: string | null; likes?: string | null;
  personaSummary?: string | null;
}
export interface VLink { from: string; to: string; strength: number; }
const KIND_LABEL: Record<VKind, string> = { owner: '主人', friend: '私聊好友', member: '群成员', tag: '标签' };
/* 角色文案。2026 反馈：页面上所有人都显示「群成员」。
 * 优先级：owner 本人（kind==='owner'）恒显示「主人」，不被 role 覆盖；其次 role==='owner' 显示「群主」，
 * role==='admin' 显示「管理员」；其余回落至 kind 文案（私聊好友／群成员）。
 * role 未取到（旧版后端或接口未返回该字段）时同样回落至 kind 文案，不会出现空白或 undefined。 */
function kindLabelOf(n: { kind: VKind; role?: GraphRole | null }): string {
  if (n.kind === 'owner') return KIND_LABEL.owner;
  if (n.role === 'owner') return '群主';
  if (n.role === 'admin') return '管理员';
  return KIND_LABEL[n.kind] ?? KIND_LABEL.member;
}
/** 群主/管理员徽标：有角色时以彩色药丸显示，其余走纯文本 kindLabelOf */
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

/* 过滤「给模型的说话要求／指导／闲聊记录」此类内容不进入画像 */
const INSTR_RE = /(主人|要求|希望|应该|不要|别|请|记得|以后|末尾|句号|中括号|括号|引用|矜持|AI\s*味|纠正|备注|说话|回复|消息|发帖|潜水|唤醒|token|额度|设置|配置)/;
/* 「实测补充」：除 INSTR_RE 外，由 owner notes 切出的标签还漏掉一类：「像正常人一样聊天」
 * （INSTR_RE 不含「聊天」）。这类同样是说话要求，不应作为人格标签展示。
 * 该规则只作用于标签一处，不改动 INSTR_RE（后者被整页复用，改动会牵动其它字段）。 */
const INSTR_TAG_EXTRA_RE = /(聊天|拟人|正常一点|像正常人)/;
/* persona-library 的正文属于学习产出（成文画像／口头禅／风格），不是聊天原话。此处刻意用一份
 * 窄名单判定「说话要求」，而不是整条 INSTR_RE：
 *  - INSTR_RE 含 主人／说话／消息／回复／聊天 等词，而正常画像几乎必然出现这些词
 *    （「owner 喜欢被叫小月…说话带撒娇语气」），逐行套用会把整份画像删空 ——
 *    即回到「已经学过了却一片空白」的旧问题（本次修复的目标）。
 *  - 窄名单只认「一旦出现基本即为命令」的词。实测 owner profile 字段中的说话要求即为此形态：
 *    「要求：回复不要超过两行」／「不要引用消息」／「记得群里要矜持」／「请以后发消息末尾不加句号」。
 * 代价：极少数正常句子中含「请／不要」的行会被误删一行（优于把说话要求当作人格档案展示）。 */
const INSTR_PROSE_RE = /(已纠正|纠正|要求|请|不要|不许|必须|务必|记得|禁止|避免)/;
/** persona 正文清洗：去除空行，并丢弃说话要求所在行（不截断长度，由界面折叠内滚） */
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
  layout?: 'free' | 'shell'; // shell：足球烯壳层，节点不自由游走
  anchorUid?: string;              // 锚点节点（如焦点人物）：柔和拉向画布中心，其余环绕
  selectedUid?: string | null;
  onPick?: (uid: string | null) => void;
  onOpen?: (n: VNode) => void;
  showLabels?: boolean;            // 默认仅在悬停／选中时显示姓名，减少杂乱
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
      // 足球烯壳层：owner／枢纽居中，其余按 BFS 深浅逐圈环绕，相邻圈错位（五边形／六边形格感），静止后不再游走
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
    // 锚点：焦点人物柔和拉向中心，邻居环绕（避免飞离）
    if (anchorUid) {
      const ap = m.get(anchorUid);
      if (ap) { ap.vx += (vw / 2 - ap.x) * 0.006; ap.vy += (vh / 2 - ap.y) * 0.006; }
    }
    let maxMove = 0; const pad = 70;
    const t = performance.now() / 1400; // 波荡时间基准（维持持续的自运动）
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (dragRef.current?.uid === n.uid) continue;
      const p = m.get(n.uid); if (!p) continue;
      // 向心牵引：防止节点全部跑向四周贴边
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
    // 收敛保持较久，随后趋于缓慢；稳定后仅保留波荡
    if (maxMove > 0.5) stillRef.current = 0; else if (stillRef.current < 400) stillRef.current++;
    setFrame((f) => f + 1);
  };
  const start = () => {
    if (runningRef.current || staticMode || layout === 'shell') return;
    runningRef.current = true; stillRef.current = 0;
    const tick = () => {
      if (!runningRef.current) return;
      stepRef.current();
      rafRef.current = requestAnimationFrame(tick); // 持续运行：拖拽、平移与自运动均实时
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

  /* 2026-09-22 变更要求：点击线不必再加深蓝色，互动强度越高颜色应越深
   * 原实现：线色按「是否含有 owner／好友」分三类，悬停与选中时统一加深变蓝 ——
   * 于是「深浅」表达的是「被选中」，与互动强弱无关，读图者容易误读（点一下即像关系变强）。
   * 现实现：单一色带，深浅仅由 l.strength 决定（越强越深、越饱和）；
   * 悬停／选中不再改变颜色，仅以「加宽 + 垫一层浅色光晕 + 其余变淡」标出当前这条。
   * 强度取值 0~1（两人互动占比，由服务端计算）。 */
  const strengthColor = (s: number, alpha = 1): string => {
    const t = Math.max(0, Math.min(1, Number(s) || 0));
    const light = Math.round(74 - 48 * t);   // 74% → 26%：浅灰蓝 → 深蓝
    const sat = Math.round(34 + 42 * t);     // 34% → 76%：弱线偏灰，强线更饱和
    return alpha >= 1 ? `hsl(214 ${sat}% ${light}%)` : `hsl(214 ${sat}% ${light}% / ${alpha})`;
  };
  const strengthWidth = (s: number) => 0.6 + Math.max(0, Math.min(1, Number(s) || 0)) * 2.6;
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
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={strengthColor(l.strength)} strokeWidth={0.7 + Math.max(0, Math.min(1, Number(l.strength) || 0)) * 1.6} strokeOpacity={0.45 + 0.45 * Math.max(0, Math.min(1, Number(l.strength) || 0))} strokeLinecap="round" />;
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
          const col = strengthColor(l.strength);
          const w = strengthWidth(l.strength);
          return (
            <g key={i}>
              {/* 悬停／选中：垫一层浅色光晕把该条线衬出 —— 深浅只表达互动强度，不再以加深蓝色表示选中 */}
              {hl && (
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke="#ffffff" strokeWidth={w + 4.5} strokeOpacity={0.85} strokeLinecap="round" />
              )}
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={col}
                strokeWidth={hl ? w + 1.5 : w}
                strokeOpacity={dim ? 0.06 : (0.3 + 0.5 * Math.max(0, Math.min(1, Number(l.strength) || 0)))}
                strokeLinecap="round" />
            </g>
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
 * 反馈「卡片的状态机要优化」。原实现的问题（均可在旧代码中对上）：
 *  1. saveRelation 返回 ok:false 时仍执行 setEdgeSel(null) 关闭卡片，且 catch{} 为空 →
 *     保存失败与成功在界面上完全一致，用户只会认为「点了没有反应」；
 *  2. 「清除标注」没有入口（clearRelCat 已定义但无人调用，且它传的是 'qunyou' 而非空串；
 *     后端语义为「空 category 才删除」，故该路径从未真正删除标注）；
 *  3. 上一次的失败／成功状态残留：取消或改选另一条线时只清了 edgeSel，卡片内状态未复位。
 * 现为四个状态：
 *  idle   = 刚打开或已取消，等待选择类别
 *  saving = 已提交、等待接口返回；五个类别按钮与「清除标注」禁用，重复点击不会发出第二次请求
 *           （「取消」不禁用：接口若长时间不返回，仍需保留退出的路径）
 *  error  = 保存失败（ok:false 或抛错）；卡片保留在屏幕上，显示原因并可原地重试
 *  done   = 保存或清除成功；先显示「已保存」，900ms 后自动收起卡片
 * 另以自增令牌（relReqRef）标识「本次提交」取消或改选另一条线后令牌变化，在途请求的迟到回包
 * 不再改动卡片状态（服务端返回的 relations 仍会应用）。
 */
type RelEdit =
  | { st: 'idle' }
  | { st: 'saving'; cat: string }
  | { st: 'error'; cat: string; msg: string }
  | { st: 'done'; cat: string };

/** 关系标注卡片：主图浮层与聚焦弹层共用同一份，避免两处状态机写法出现差异 */
function RelEdgeCard({ title, current, state, floating = false, onPick, onClose }: {
  title: string; current: string; state: RelEdit; floating?: boolean;
  onPick: (cat: string) => void; onClose: () => void;
}) {
  const busy = state.st === 'saving';
  // 正在提交／已提交的类别保持高亮（saving 时表示已按下、error 时可看出哪一类失败、done 时显示对勾）
  const pick = state.st === 'idle' ? null : state.cat;
  return (
    <div style={{
      border: '1px solid rgba(120,120,190,0.4)', background: 'rgba(255,255,255,0.96)', borderRadius: 12,
      padding: '8px 12px', boxShadow: '0 6px 20px rgba(0,0,0,0.14)', backdropFilter: 'blur(2px)',
      ...(floating ? {} : { marginBottom: 8 }),
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 6 }}>
        {title}
        {current && <span style={{ marginLeft: 6, fontWeight: 400, color: C.textMuted, fontSize: 12 }}>当前：{current}</span>}
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
        {/* 清除标注：传空 category 时后端会真正删除该条记录（见 server 的 PUT /learning/relations）。
            仅在「当前确有标注」时出现，否则点击无意义。 */}
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
/** 读取结果的一句话抬头（简短，用于图例上方那一行与画布占位区）。失败时才有值。 */
  const [err, setErr] = useState('');
/** 与抬头配套的说明（说清是哪一种情形、会不会自动重读）。正文用，不用感叹号。 */
  const [errDetail, setErrDetail] = useState('');
/** 是否处于失败后的自动退避重读中（2026-09-30 起本页不再有「重试」按钮）。 */
  const [retrying, setRetrying] = useState(false);
  const [autoRetryMs, setAutoRetryMs] = useState(0);
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
/** 提交令牌：卡片被取消或改选另一条线后自增，用于丢弃在途请求的迟到回包（否则旧回包会把新卡片标成「已保存」） */
  const relReqRef = useRef(0);
/** 主图上点击连线时记录落点与容器尺寸，用于把浮层卡片夹在画布内（容器 overflow:hidden，贴边会被裁切） */
  const [edgePos, setEdgePos] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const mainBoxRef = useRef<HTMLDivElement | null>(null);
  const [relayout, setRelayout] = useState(0);

  /* 2026-09-14 反馈：聚焦弹层原先只有一行「还没有整理过的档案：多聊几次或对 ta 做「人格学习」会充实起来」，
   * 即便该对象早已被学习过也照说（因弹层只读图谱接口中若干被截断的短字段）。
   * 现改为与「学习」页「人格学习状态」同一套口径：已学习／无档案、最近学习、近30天发言、记忆条目，
   * 数据按需直读桥的 memory.db（/api/learning/profile，不截断）；长文折叠并内滚，不拉长弹窗。 */
  const [profData, setProfData] = useState<Record<string, any>>({});
  const [profBusy, setProfBusy] = useState('');
  const [profErr, setProfErr] = useState<Record<string, string>>({});
  const [profOpen, setProfOpen] = useState(false);
  /* owner 画像卡中「展开档案」的折叠开关：刻意不复用 profOpen —— 后者是聚焦弹层内「学习档案」块的开关，
   * 共用同一 state 会导致展开该档案时把弹层那一块一并撑开（两处互不相关） */
  const [ownerOpen, setOwnerOpen] = useState(false);

  const loadAll = async (): Promise<boolean> => {
    setLoading(true); setErr('');
    try {
      const [g, o] = await Promise.all([getLearningGraph(), getOwnerProfile()]);
      if (g?.ok && Array.isArray(g.nodes)) setGraph(g); else setGraph(null);
      if (o?.ok) setOwner(o); else setOwner(null);
      if (!g?.ok || !o?.ok) {
        /* 2026-09-30 反馈：「因为桥一次也没运行，所以没有群友画像正常，「部分画像数据读取失败」这个没必要，
           换个更贴切的说法」原先无论何种原因都写「部分画像数据读取失败」，把两件不同的事实混成一句：
             ① 桥从未运行过 —— 服务端直读桥记忆库失败，原话是「找不到桥记忆库 memory.db…请先让桥至少跑过一次」，
                此时"还没有画像数据"是客观事实，说成"失败"既不准确，也让人误以为出了故障；
             ② 桥在运行、记忆库也在，但本次读取确实出错 —— 这才是"读取失败"。
           现按原因分开表述；两种都不再给「重试」按钮，改为按退避间隔自动重读。 */
        const reason = reasonOf(g) || reasonOf(o);
        if (NEVER_RAN_RE.test(reason)) {
          setErr('画像数据尚未生成');
          setErrDetail('桥还没有运行过，记忆库尚未建立，因此当前没有群友画像 —— 这是正常情形，不是读取故障。待桥首次正常运行、群里有往来之后，此处会自动出现内容。');
        } else {
          setErr('画像数据暂时读取不到');
          setErrDetail(`本次读取画像数据未成功${reason ? `：${reason}` : ''}。这属于读取环节的问题，不代表没有数据。`);
        }
        setRetrying(true);
        return false;
      }
      setErrDetail('');
      setRetrying(false);
      return true;
    } catch (e2: any) {
      const reason = String(e2?.message ?? e2);
      setErr('画像数据暂时读取不到');
      setErrDetail(NEVER_RAN_RE.test(reason)
        ? '桥还没有运行过，记忆库尚未建立，因此当前没有群友画像 —— 这是正常情形，不是读取故障。待桥首次正常运行、群里有往来之后，此处会自动出现内容。'
        : `本次读取画像数据未成功：${reason}。这属于读取环节的问题，不代表没有数据。`);
      setRetrying(true);
      return false;
    }
    finally { setLoading(false); }
  };
  useEffect(() => { void loadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  /* 2026-09-30 修改要求：读取失败不再要人"点重试再刷新"，改为自动重试，页面上不出现重试按钮：
     失败后按 5 → 10 → 20 → 40 → 60 秒（封顶 60 秒）逐档拉长重读，读到即停（retrying 置回 false → 本 effect 退出）。
     失败事实照常显示（画布占位区与图例上方那行都写清原因），画布不会变成"永远转圈"。
     循环由 `retrying` 这个布尔量驱动，而不是由 err 文本驱动：loadAll 不会在开头清 retrying，
     所以 err 文本在重读期间变化也不会把退避档位重置回 5 秒。 */
  const loadAllRef = useRef(loadAll);
  useEffect(() => { loadAllRef.current = loadAll; });
  useEffect(() => {
    if (!retrying) { setAutoRetryMs(0); return; }
    let alive = true;
    let backoff = 5000;
    let t: number | null = null;
    const step = () => {
      setAutoRetryMs(backoff);
      t = window.setTimeout(() => {
        if (!alive) return;
        backoff = Math.min(60000, backoff * 2);
        void loadAllRef.current().finally(() => { if (alive) step(); });
      }, backoff);
    };
    step();
    return () => { alive = false; if (t !== null) window.clearTimeout(t); };
  }, [retrying]);
  /* 更换焦点人物即更换一张关系网：同时把关系标注卡片彻底归零（原先只清 relSel，卡片状态会残留到下一次） */
  useEffect(() => {
    setMsgs(null); setMsgsOpen(false); setMsgsErr(''); setRelSel(null);
    setEdgeSel(null); setRelEdit({ st: 'idle' }); setEdgePos(null);
  }, [focus?.uid]);
  /* done 状态仅维持 900ms：既让「✓ 已保存」与图层上的线色变化可被看见，又不把卡片长期挂在图上 */
  useEffect(() => {
    if (relEdit.st !== 'done') return;
    const t = setTimeout(() => { setEdgeSel(null); setRelEdit({ st: 'idle' }); setEdgePos(null); }, 900);
    return () => clearTimeout(t);
  }, [relEdit]);
  // 聚焦某人时按需获取「完整档案」（与 Learning.tsx 同一套解包口径；已取过的不重复请求）
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

  // 页面整体禁止缩放：拦截 Ctrl/Cmd+滚轮（浏览器整页缩放）；仅保留画布自身的滚轮缩放
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
    // 有条理：保留强关系，且每个节点至少有一条边，总边数约为节点数×2.2，避免成一团乱麻
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
    // 保底：把孤点接上其最强边
    for (const id of set) if (deg.get(id)! < 1) {
      const l = sorted.find((x) => x.from === id || x.to === id);
      if (l && !pick.includes(l)) { pick.push(l); deg.set(l.from, (deg.get(l.from) || 0) + 1); deg.set(l.to, (deg.get(l.to) || 0) + 1); }
    }
    return pick;
  }, [allLinks, mainNodes, showWeak]);

  /* owner 画像：只保留真实档案，过滤「给模型的说话要求」
   * 2026-09-18 反馈：「已经学习过（64 条人格样本），却一个标签都没有、还写着暂无已整理档案」。
   * 根因（以只读脚本直读本机 qq-bridge/state/memory.db 实测）：profiles 表 owner 那行的
   * personality／likes／dislikes 全为空，仅 notes 有内容，而 notes 存的正是
   * 「已纠正：发消息末尾不带句号；此前要求以后全用数组发消息…」：这类给模型的说话要求。
   * 旧口径只读 personality／likes，于是可切出的标签全属应被 INSTR_RE 过滤之物 → 页面整块空白。
   * 而 /api/learning/owner-profile 早已返回三个更有用的字段，前端一个都未使用：
   *   profileTags —— 切自同几个字段（实测那 6 条全为说话要求，故取到后必须再过一遍过滤）
   *   memoryTop   —— 记忆条目中的高频二字词 {w,c}（见 server 的 memoryTopWords）
   *   persona     —— persona-library 的完整条目：nickname／profile／catchphrases／style／topics…
   * 现口径：标签 = profileTags（过滤后）→ 本地 likes／personality 切片 → 记忆高频词补足；
   *       只要存在任一已学习痕迹（persona 条目／样本>0／memoryTop 非空／profileTags 非空），
   *       即不再显示「暂无已整理档案」。 */
  const ownerInfo = useMemo(() => {
    const o = owner?.owner ?? allNodes.find((n) => n.kind === 'owner') ?? null;
    const persona = owner?.persona ?? null;

    /* 标签回退链。来自记忆的标签单独记账（memTag），界面上以虚线加注解标明「来自记忆高频词」；
     * 此类标签无词典可依，可能为碎词（实测 owner 最近 30 天只有 2 条空间说说记忆，
     * 切出的高频词为 傍晚／抽风／出水／… 甚至 果数／里游 这类碎片）。 */
    const TAG_BY_PROFILE = 8;   // profile 字段切出的标签不足此数时，才以记忆高频词补足
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
      /* 2026-09-22 反馈报告「技术／术问／问题／发起／分享／活跃／角洲」这类碎片标签
       * 记忆高频词按二字窗口切出，无词典可依，故「技术问题」会同时产出 技术／术问／问题，
       * 「三角洲」：会产出 三角／角洲 —— 中间那个为缝合词，观感近似乱码。
       * 两道过滤（均不需要词典）：
       *   ① substring：为已采纳标签的子串 → 丢弃（角洲 ⊂ 三角洲）；
       *   ② stitch  ：两字分别出现在两个计数更高的已采纳标签中 → 丢弃（术问：术∈技术、问∈问题）。
       * 仅作用于记忆高频词这一段（前文从档案字段切出的标签不受影响）。 */
      const accepted: Array<{ w: string; c: number }> = profileTags.map((w) => ({ w, c: Number.MAX_SAFE_INTEGER }));
      const isJunkWord = (w: string, c: number) => {
        if (w.length !== 2) return false;
        for (const a of accepted) if (a.w.length > w.length && a.w.includes(w)) return true;
        if (c > 0) {
          const [x, y] = [w[0], w[1]];
          const hasX = accepted.some((a) => a.w.includes(x) && a.c > c);
          const hasY = accepted.some((a) => a.w.includes(y) && a.c > c);
          if (hasX && hasY) return true;
        }
        return false;
      };
      for (const m of (owner?.memoryTop ?? [])) {
        if (profileTags.length >= TAG_BY_PROFILE) break;
        const w = String(m?.w ?? '').trim();
        const c = Number(m?.c) || 0;
        if (!w || w.length > 12 || INSTR_RE.test(w) || profileTags.includes(w)) continue;
        if (isJunkWord(w, c)) continue;
        profileTags.push(w);
        memTags.push({ w, c });
        accepted.push({ w, c });
      }
    }

    /* persona（学习产出）各字段；正文走 cleanProse（按窄名单丢弃说话要求行），碎片字段原样使用 */
    const nick = String(persona?.nickname ?? '').trim() || null;
    const address = String(persona?.addressTerms ?? '').trim() || null;
    // o 可能是 /owner-profile 的 owner 对象（无 personaSummary），也可能是图谱中的 VNode → 用 in 收窄
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

    /* 「是否学过」：按后端可获取的原始数据判定（过滤与否不计）：
     * persona 条目存在／样本>0／memoryTop 非空／profileTags 非空 —— 满足任一条即不再显示「暂无档案」 */
    const hasLearned = !!persona || (samples ?? 0) > 0
      || (owner?.memoryTop?.length ?? 0) > 0 || (owner?.profileTags?.length ?? 0) > 0;
    /* 存在已学习痕迹，但是否有可展示的内容（过滤之后）—— 决定显示内容还是那句「学过但无成文档案」 */
    const hasContent = !!(prose || personaEn || nick || address || styleLines.length || styleExamples.length
      || catchphrases.length || topics.length || taboos.length
      || profileTags.length || cleanField(o?.likes) || cleanField(o?.personality));
    /* 是否含人格学习档案中的实质内容（决定是否标注「内容来自 persona-library」） */
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
/** 打开或改选一条线：状态归零，不残留上一次的 error／done；token 自增使在途旧请求的回包作废 */
  const openEdge = (e: EdgeClick) => { relReqRef.current++; setEdgeSel(e); setRelEdit({ st: 'idle' }); };
/** 关闭卡片：saving 时同样允许关闭（否则接口长期不返回时，用户会被一张全部禁用的卡片困住）。
   *  关闭后 token 变化，回包不再改动卡片状态；但服务端确实保存成功时 setRels 仍照常应用（见 submitRel）。 */
  const closeEdge = () => {
    relReqRef.current++;
    setEdgeSel(null); setRelEdit({ st: 'idle' }); setEdgePos(null);
  };
/** 提交类别；cat 传空串即为清除标注（后端 PUT /learning/relations 收到空 category 会删除该条记录） */
  const submitRel = async (cat: string) => {
    if (!edgeSel || relEdit.st === 'saving') return;   // 按钮已 disabled，这里再挡一次（快速双击/回车）
    const token = ++relReqRef.current;
    setRelEdit({ st: 'saving', cat });
    try {
      const r = await saveRelation(edgeSel.from, edgeSel.to, cat);
      // 服务端返回的是全量 relations，属真值：无论卡片是否仍在，均予应用，线色当帧即变
      // （setRels → 两处 NetCanvas 重渲染 → relationsRef 由 useEffect 同步，下一帧读到新配色，
      //  无需等待重力收敛，也无需重排）。
      if (r?.ok) setRels(r.relations ?? {});
      // 卡片状态仅在「仍属本次提交」时改动：否则取消或改选另一条线后，旧回包会把新卡片标成已保存并自动收起
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
            <div className="page-subtitle">点选人物即自动聚焦 · 半透明圆形简约风格</div>
          </div>
        </div>
        <div className="page-actions">
          <button className="btn btn-sm" onClick={() => { setFilter(filter === 'core' ? 'all' : 'core'); setRelayout((x) => x + 1); }}>
            {filter === 'core' ? '显示全部人' : '仅显核心'}
          </button>
          <button className="btn btn-sm" onClick={() => setShowWeak(!showWeak)} title="切换弱关系连线的显示">
            {showWeak ? '隐藏弱关系' : '显示弱关系'}
          </button>
          <button className="btn btn-sm" disabled={loading} onClick={() => setRelayout((x) => x + 1)}><RotateCcw size={13} /> 重新布局</button>
          <button className="btn btn-sm" disabled={loading} onClick={loadAll}>{loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} 刷新</button>
        </div>
      </div>

      <div className="page-body">
        {/* 2026-09-23 点名修复：这条筛选栏原先整条写死行内样式：容器自带 `background/border`，
            「全部群」下拉与「输入昵称或 QQ」都写死 `border: 1px solid rgba(0,0,0,0.15)` 与白底 ——
            结果是全局输入框的悬停/聚焦/错误边框色在这里统统不生效，与页面其它控件不同一套观感。
            现在：容器改用全局卡片类 + `pg-filter`，下拉用 `className="select"`、输入框用 `className="input"`
            （数值框给 `className="input"`），一律不再写死边框与底色；
            仅保留布局所需的行内样式（flex 排列、换行、宽度上限、间距），这些与配色无关。 */}
        <div className="card pg-filter"
          style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', padding: '8px 12px', marginBottom: 14 }}>
          <span className="pg-filter-label" style={{ fontSize: 12.5, color: C.text, whiteSpace: 'nowrap' }}>选择群聊：</span>
          <Dropdown className="select pg-filter-select" value={grpSel} onChange={(v) => { setGrpSel(v); setRelayout((x) => x + 1); }}
            style={{ maxWidth: 380, minWidth: 240, width: 'auto', fontSize: 12.5 }}
            options={[
              { value: '', label: '全部群' },
              ...groupsList.map((g) => ({ value: g.id, label: `${g.id.replace(/^group:/, '群')}（${g.members.length}人）` })),
            ]} />
          <span className="pg-filter-label" style={{ fontSize: 12.5, color: C.text, whiteSpace: 'nowrap', marginLeft: 10 }}>快速定位：</span>
          <input className="input pg-filter-loc" list="pvLoc" value={locQ} onChange={(e) => setLocQ(e.target.value)}
            placeholder="输入昵称或 QQ" style={{ minWidth: 170, maxWidth: 280, width: 'auto', fontSize: 12.5 }} />
          <datalist id="pvLoc">
            {locCands.map((n) => <option key={n.uid} value={cleanName(n.name)}>{n.uid}</option>)}
          </datalist>
          <button className="btn btn-sm" disabled={!locCands.length} onClick={() => locCands[0] && pickLoc(locCands[0].uid)}>定位</button>
          <span className="pg-filter-refresh" style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12, color: C.textMuted }}>
            自动刷新画像
            {/* 【2026-09-23】画像自动刷新配置（pCfg）尚未读到时：开关显示为未勾选且不可点，
                天数留空且不可编辑 —— 否则会以"每 7 天"这类臆测值写回配置。 */}
            <input type="checkbox" checked={pCfg?.enabled === true} disabled={!pCfg} title={pCfg ? undefined : '配置尚未读取到，暂不可修改'}
              onChange={async (e) => {
                const next = { enabled: e.target.checked, intervalDays: pCfg?.intervalDays || 7 };
                setPCfgSaving(true);
                try { const r = await savePortraitCfg(next); if (r) setPCfg(r); } catch {} finally { setPCfgSaving(false); }
              }} />
            <NumInput className="input pg-filter-days" value={pCfg ? (pCfg.intervalDays || 7) : undefined}
              disabled={!pCfg} placeholder={pCfg ? undefined : '—'}
              onCommit={async (n) => {
                const next = { enabled: pCfg?.enabled !== false, intervalDays: Math.max(1, Math.min(90, Math.round(n) || 7)) };
                setPCfgSaving(true);
                try { const r = await savePortraitCfg(next); if (r) setPCfg(r); } catch {} finally { setPCfgSaving(false); }
              }} title={pCfg ? '每 N 天自动刷新一次（1–90）' : '配置尚未读取到，暂不可修改'}
              style={{ width: 52 }} />
            天{pCfgSaving ? '…' : ''}
            {pCfg && pCfg.lastAt > 0 && (
              <span>· 上次分析 {fmtTime(pCfg.lastAt)}</span>
            )}
          </span>
        </div>
        {/* ============ owner 画像（标准卡） ============ */}
        <div className="card">
          <div style={{ minWidth: 190 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <UserRound size={17} style={{ color: C.owner }} />
              <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>主人画像</span>
              {/* 徽标改为表示「是否学过」，不再依据那段短 personality 是否存在（后者正是「学过却显示暂无档案」的成因） */}
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
            {/* 标签：实心 = 由已整理档案字段切出；虚线 = 以记忆高频词补充（其来历见下方说明行） */}
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
                    虚线标签来自<b>记忆高频词</b>（记忆条目按字频切出的二字词，无词典可依，可能出现碎词）；
                    owner profile 的相应字段基本为空，故标签主要由它兜底
                  </div>
                )}
              </>
            )}

            {/* 学习档案：沿用聚焦弹层「学习档案」那套折叠与内滚（.pv-intro 折起 96px／展开 240px 封顶），
                档案再长也只滚动，不把这张卡拉长。整块仅在「确实学过」时出现，未学过则只余下方那句空状态 */}
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
                  若仍有个别命令句遗漏，可立即判断其来源 */}
              {ownerInfo.hasPersonaContent && (
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
                  内容来自人格学习档案（persona-library），已过滤「给模型的说话要求」；聊天中的说话要求不作为人格内容展示
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
              {/* 碎片信息仅在展开时出现；口径与「学习」页一致：口头禅／风格／话题／禁忌 */}
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
                ① 无任何已学习痕迹 → 保留原句（并说明为何不展示聊天中的说话要求）；
                ② 学过但过滤之后确无成文档案 → 说明情况，不再显示「暂无已整理档案」 */}
            {!ownerInfo.hasLearned && (
              <div style={{ color: C.textMuted, fontSize: 12.5 }}>暂无已整理档案（聊天中的说话要求不在此展示）</div>
            )}
            {ownerInfo.hasLearned && !ownerInfo.hasContent && (
              <div style={{ color: C.textMuted, fontSize: 12.5 }}>
                已学习过{ownerInfo.samples ? `（样本 ${ownerInfo.samples} 条）` : ''}，但记忆库中尚无成文档案可供展示；
                可到「学习」页查看「人格学习状态」，或对主人执行一次「人格立即学习」。
              </div>
            )}
          </div>
        </div>

        {/* ============ 群友关系图（标准卡，画布加高） ============ */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 15, fontWeight: 700, color: C.text }}>
              <Users size={16} style={{ color: C.friend }} /> 群友关系图
            </span>
            <span style={{ fontSize: 12, color: C.textMuted }}>
              {mainNodes.length} 人 · {mainLinks.length} 关系{filter === 'core' ? '（核心）' : ''} · 图上持续缓慢漂动；点击任一圆点即展开档案与关系网
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 12.5, color: C.textMuted }}>
              <span style={{ color: C.owner, marginRight: 12 }}>● 主人 ×{kindCnt.owner ?? 0}</span>
              {/* 群主／管理员计数取角色环同色，与球上那圈细环对应（未取到 role 时为 0，不显示虚计数） */}
              {(kindCnt.roleOwner ?? 0) > 0 && <span style={{ color: C.roleOwner, marginRight: 12 }}>◍ 群主 ×{kindCnt.roleOwner}</span>}
              {(kindCnt.roleAdmin ?? 0) > 0 && <span style={{ color: C.roleAdmin, marginRight: 12 }}>◍ 管理员 ×{kindCnt.roleAdmin}</span>}
              <span style={{ color: C.friend, marginRight: 12 }}>● 私聊 ×{kindCnt.friend ?? 0}</span>
              <span style={{ color: C.member }}>● 群员 ×{kindCnt.member ?? 0}</span>
            </span>
          </div>
          {/* 2026-09-30：此处原有「重试」按钮，已移除：本页会按退避间隔自动重读。
              文案也不再是「部分画像数据读取失败」——抬头区分「尚未生成」与「暂时读取不到」，说明写在 errDetail。 */}
          {err && (
            <div style={{ color: '#c0504d', fontSize: 12.5, marginBottom: 8, lineHeight: 1.7 }}>
              <b>{err}</b>{errDetail ? ` —— ${errDetail}` : ''}
              {autoRetryMs > 0 && <span style={{ color: C.textMuted }}>{`（正在自动重试：约每 ${Math.max(1, Math.round(autoRetryMs / 1000))} 秒重读一次，退避上限 60 秒。）`}</span>}
            </div>
          )}
          {/* 线色图例。2026-09-22 改口径：线色深浅 = 互动强度（按要求变更），
              故此处先说明深浅，再说明「已标注关系类别的线」（后者属人工标注，取固定色）。 */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', fontSize: 11.5, color: C.textMuted, marginBottom: 8 }}>
            <span>互动强度：</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <i style={{ width: 46, height: 2.5, borderRadius: 2, background: 'linear-gradient(90deg,#cfd8e3,#1f4e79)', display: 'inline-block' }} />
              浅 = 偶尔说话 · 深 = 常在一起（线越粗表示互动越强）
            </span>
            <span style={{ marginLeft: 6 }}>已标注的关系：</span>
            {(['guimi', 'jiaren', 'qinglv', 'chouren', 'qunyou'] as const).map((c) => (
              <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <i style={{ width: 15, height: 2.5, borderRadius: 2, background: REL_CAT_COLOR[c], display: 'inline-block' }} />{REL_CAT_LABEL[c]}
              </span>
            ))}
            <span>（点击一条连线即可标注或清除关系；点击本身不改变线色）</span>
          </div>
          <div ref={mainBoxRef} style={{ height: 600, position: 'relative', border: '1px solid rgba(0,0,0,0.07)', borderRadius: 16, background: 'rgba(255,255,255,0.6)', overflow: 'hidden' }}>
            {loading && !graph ? (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: C.textMuted }}><Loader2 size={18} className="spin" /> 读取画像数据…</div>
            ) : !graph ? (
              /* 2026-09-30：数据没读到时不再断言「尚无画像数据」那是一句结论，且多半是假的
                 （接口失败时此前也这样写，等于把"读不到"说成"没有"）；反过来也不再把"桥没跑过"
                 说成"读取失败"（本次的变更要求）。现按真实原因分两句，都不给重试按钮，改为自动重读。 */
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: C.textMuted, fontSize: 13, gap: 8, padding: '0 28px', textAlign: 'center' }}>
                <Sparkles size={28} style={{ opacity: 0.5 }} />
                {err
                  ? <>
                    <div style={{ color: '#c0504d', fontWeight: 700 }}>{err}</div>
                    {errDetail && <div style={{ maxWidth: 620, lineHeight: 1.75 }}>{errDetail}</div>}
                    {autoRetryMs > 0 && (
                      <div style={{ fontSize: 12 }}>
                        {`正在自动重试：约每 ${Math.max(1, Math.round(autoRetryMs / 1000))} 秒重读一次（失败后按 5／10／20／40／60 秒退避，最长 60 秒一次），无需手动刷新。`}
                      </div>
                    )}
                  </>
                  : <div>尚无画像数据：机器人需正常聊天一段时间，或执行数次「人格学习」</div>}
              </div>
            ) : mainNodes.length === 0 ? (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: C.textMuted, fontSize: 13, gap: 8 }}>
                <Sparkles size={28} style={{ opacity: 0.5 }} />
                <div>尚无画像数据：机器人需正常聊天一段时间，或执行数次「人格学习」</div>
              </div>
            ) : (
              <NetCanvas nodes={mainNodes} links={mainLinks} selectedUid={focus?.uid ?? null} relations={rels}
                onEdge={(e) => {
                  const el = mainBoxRef.current;
                  openEdge(e);
                  // 记录落点与容器尺寸，把浮层卡片夹在画布内（容器 overflow:hidden，贴边会被裁切）
                  setEdgePos({ x: e.sx, y: e.sy, w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 });
                }}
                onPick={(u) => { setFocus(u ? (byUid.get(u) ?? null) : null); if (!u) closeEdge(); }} onOpen={(n) => setFocus(n)} />
            )}
            {/* 主图上的关系标注浮层。此前 edgeSel 只在聚焦弹层内渲染，「在首页点击一条线」因而无任何反应
                （状态已设置但无人绘制），下次打开聚焦弹层还会把这口旧状态带出。 */}
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
            <div style={{ position: 'absolute', left: 12, bottom: 8, fontSize: 11.5, color: C.textMuted }}>拖拽移动 · 点击人物聚焦 · 点击连线标注关系（视图大小已固定）</div>
          </div>
        </div>
      </div>

      {/* ============ 聚焦弹层（大卡片，不依赖页面滚动） ============ */}
      {focus && ego && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(20,20,28,0.32)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} onClick={() => setFocus(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 18, width: 'min(980px, 94vw)', maxHeight: '88vh', overflow: 'auto', padding: '20px 24px', boxShadow: '0 18px 60px rgba(0,0,0,0.18)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ width: 14, height: 14, borderRadius: '50%', background: colorOf(focus.kind), opacity: 0.85, display: 'inline-block' }} />
              <span style={{ fontSize: 16, fontWeight: 800, color: C.text }}>{cleanName(focus.name)}</span>
              <span style={{ fontSize: 13, color: C.textMuted }}>QQ {focus.uid} ·</span>
              {/* 角色：群主／管理员显示彩色药丸徽标（金／青），其余为 kindLabelOf 的回落文案；
                  本人（kind==='owner'）恒显示「主人」，不被 role 覆盖 */}
              {(() => {
                const b = roleBadgeOf(focus);
                return b
                  ? <span style={{ fontSize: 12, fontWeight: 700, padding: '1px 9px', borderRadius: 999, background: b.bg, color: b.fg }}>{b.text}</span>
                  : <span style={{ fontSize: 13, color: C.textMuted }}>{kindLabelOf(focus)}</span>;
              })()}
              <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => setFocus(null)} title="关闭"><X size={18} /></button>
            </div>

            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 10 }}>
              {/* 左：重要档案 */}
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
                          const tag = s >= 0.6 ? '关系热络，常在一起聊天' : s >= 0.35 ? '有稳定往来' : s >= 0.12 ? '偶尔互动' : '互动较少';
                          return <>{tag}。如需进一步了解 ta，可在下方查看「发过的消息」。</>;
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
                {/* 学习档案：口径与「学习」页「人格学习状态」一致（已学习／无档案 · 最近学习 · 近30天发言 · 记忆条目）；
                    完整介绍折叠并内滚（app.css 的 .pv-intro），档案再长也不拉长弹窗 */}
                {(() => {
                  const uid = focus.uid;
                  const d = profData[uid] ?? null;
                  const busy = profBusy === uid;
                  const fErr = profErr[uid] || '';
                  const lib = d?.library ?? null;
                  const pf = d?.profile ?? null;
                  // 取不到库时退回图谱中那份（已截断的）摘要，避免已有信息凭空消失
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
                      {/* 【2026-09-30】与上方画布区同一口径：桥从未运行过时，档案是"尚未生成"（
                          服务端原话「找不到桥记忆库 memory.db…请先让桥至少跑过一次」），不是"读取失败"；
                          确系本次读取未成功，才说"暂时读取不到"。此处本就没有重试按钮（按需读取、点开才发一次请求）。 */}
                      {!busy && fErr && (
                        <div className="pv-note">
                          {NEVER_RAN_RE.test(fErr)
                            ? '尚无 ta 的档案：桥还没有运行过，档案尚未生成；待桥正常运行、群里有往来后此处会自行出现内容。'
                            : `档案暂时读取不到：${fErr}。这属于读取环节的问题，不代表没有档案；重新展开或稍后再展开会重读一次。`}
                        </div>
                      )}
                      {!busy && !fErr && !has && (
                        <div className="pv-note">记忆库中尚无 ta 的档案：多聊几次，或到「学习」页执行一次「人格立即学习」；此后本处将如「人格学习状态」一般显示是否已学习、最近学习时间与样本数。</div>
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
                {/* 完整介绍已在上方「学习档案」块中显示（且不截断），此处不再重复 personaSummary */}
                {/* 「近 30 天发言」已在上方学习档案块中（与 /api/learning/profile 同一口径），此处不再重复 */}
                <div style={{ display: 'flex', gap: 20, marginTop: 12, fontSize: 12.5, color: C.textMuted }}>
                  <span>最近活跃 {focus.lastSeen ? fmtTime(focus.lastSeen) : '—'}</span>
                </div>

                {/* 发过的消息（仅在点击后展开，不自动加载） */}
                <div style={{ marginTop: 14 }}>
                  <button className="btn btn-sm" onClick={() => { if (!msgsOpen && msgs === null) loadPersonMsgs(focus); setMsgsOpen(!msgsOpen); }}>
                    <History size={13} /> {msgsOpen ? '收起 Ta 发过的消息' : '查看 Ta 发过的消息'}
                  </button>
                  {msgsOpen && (
                    <div style={{ marginTop: 10, maxHeight: 220, overflowY: 'auto', border: '1px solid rgba(0,0,0,0.07)', borderRadius: 10, padding: '6px 10px', background: 'rgba(0,0,0,0.02)' }}>
                      {msgsLoading && <div style={{ color: C.textMuted, fontSize: 12, padding: 6 }}><Loader2 size={12} className="spin" /> 加载中…</div>}
                      {!msgsLoading && msgsErr && <div style={{ color: '#c0504d', fontSize: 12, padding: 6 }}>{msgsErr}</div>}
                      {!msgsLoading && !msgsErr && (!msgs || msgs.length === 0) && (
                        <div style={{ color: C.textMuted, fontSize: 12, padding: 6 }}>尚无 ta 发过的消息记录（需先在群聊或私聊中有往来并落库）</div>
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

              {/* 右：个人关系图（可拖转，默认自动缓转） */}
              <div style={{ flex: '1 1 440px', minWidth: 340 }}>
                {edgeSel && (
                  <RelEdgeCard
                    title={cleanName(byUid.get(edgeSel.from)?.name || edgeSel.from) + ' ↔ ' + cleanName(byUid.get(edgeSel.to)?.name || edgeSel.to)}
                    current={relLabelOf(edgeSel.from, edgeSel.to)}
                    state={relEdit}
                    onPick={submitRel} onClose={closeEdge} />
                )}
                <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 6 }}>
                  与 ta 互动较多（{ego.neigh.length} 人）· 拖转后暂停自动旋转（双击恢复）· 线色与主图同一套；点击壳上人物 → 查看 ta 与 {cleanName(focus.name)} 的互动强度，点击连线 → 标注关系
                </div>
                <div style={{ height: 340, border: '1px solid rgba(0,0,0,0.06)', borderRadius: 14, position: 'relative', overflow: 'hidden' }}>
                  {ego.egoNodes.length >= 2 ? (
                    <div style={{ position: 'absolute', inset: 0 }}>
                      {/* key 仅随焦点人物变化。原先还带 relSel?.node.uid —— 点击一个邻居即更换 key 而整块重挂，
                          重挂会重新初始化相机（已调好的角度被弹回正面）、并重新从 TEMP_INIT 收敛一遍，
                          此即「点一下图就跳一下」的成因。选中高亮本由 selectedUid 负责，无需重挂。 */}
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
                  <div style={{ position: 'absolute', right: 8, bottom: 6, fontSize: 11, color: C.textMuted }}>点击人物查看互动强度 · 双击空白处恢复自动旋转</div>
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
