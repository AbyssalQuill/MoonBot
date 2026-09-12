import React, { useEffect, useMemo, useRef } from 'react';

/* ==================================================================
 * NetCanvas —— 零依赖球面力导向网络
 *  默认: 全员平等, 所有节点贴地壳(半径1硬归一, 永不脱离)
 *  centerUid 可选: 仅该"主人公"放球心(固定), 其余仍贴地壳环绕 + 细亮辐条
 *  防抖: DT=0.25 / DAMP=0.84 / MAX_SPEED=0.035 / temp*=0.985 / 静止休眠
 *  交互: 自动缓转; 拖=转球; 缩放已固定(≈滚轮放大两档的大小, 不再滚轮缩放);
 *        悬停不选中; 点击打开档案
 * ================================================================== */
export interface CNode { uid: string; name: string; kind: 'owner' | 'friend' | 'member' | 'tag'; }
export interface CLink { from: string; to: string; strength: number; }

/* 固定缩放: 等效原滚轮向上两档(每档约 ×1.14)后的大小; 之后滚轮不再缩放 */
const FIXED_SCALE = 1.3;

const PAL = {
  owner: 'rgba(214,140,168,0.9)', friend: '#7b86dc', member: '#5f9ed0',
  ownerSoft: 'rgba(214,140,168,0.12)', friendSoft: 'rgba(123,134,220,0.16)', memberSoft: 'rgba(95,158,208,0.14)',
  lineOwner: 'rgba(224,158,182,0.55)', lineFriend: 'rgba(123,134,220,0.55)', lineMember: 'rgba(150,164,178,0.55)',
  spoke: 'rgba(224,120,156,0.9)',
  muted: '#8a8f98',
};
const colorOf = (k: string) => (k === 'owner' ? PAL.owner : k === 'friend' ? PAL.friend : PAL.member);
const softOf = (k: string) => (k === 'owner' ? PAL.ownerSoft : k === 'friend' ? PAL.friendSoft : PAL.memberSoft);
const cleanName = (n: string) => String(n ?? '').split(/[（(]/)[0].trim() || '?';
const trunc = (s: string, n: number) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));
const initialOf = (n: CNode) => cleanName(n.name).slice(0, 2) || '?';

interface SNode {
  uid: string; x: number; y: number; z: number; vx: number; vy: number; vz: number;
  fixed?: boolean; sx: number; sy: number; depth: number;
}

const K_REP = 0.0022;
const K_SPR = 0.32;
const SPR_TARGET = 0.85;
const DAMP = 0.84;
const MAX_SPEED = 0.035;
const DT = 0.25;
const TEMP_INIT = 0.035;
const SZ = 1.5;

/* ── 强/弱关系的弹簧目标距离（球面弦长，单位球最大 2）──────────────────────────
 * 原来所有连线都用同一个 SPR_TARGET=0.85：显示弱关系时凭空多出一百多条
 * 「都要求贴到 0.85」的弹簧，总拉力翻倍 → 整颗球被压小、人挤成团，
 * 原本均匀的球面结构就没了（这正是「显示弱关系会把人拉一起」的原因）。
 * 现在按强度插值：强关系贴到 0.85（熟人靠在一起），弱关系目标 = 4/3
 * —— 单位球上两个随机点的平均弦长恰好是 4/3，也就是「既不强拉也不强推」的中性距离。
 * 于是弱关系只是**画出来给你看**，不再参与塑形，球面分布保持不变。
 */
const WEAK_TARGET = 4 / 3;   // 中性弦长：E[|p-q|] = 4/3（p,q 独立均匀分布在单位球面）
const STRENGTH_FLOOR = 0.35; // 数据里实际出现的最弱档（实测最小 0.367）
function springTarget(strength: number): number {
  const s = Math.max(0, Math.min(1, (strength - STRENGTH_FLOOR) / (1 - STRENGTH_FLOOR)));
  return WEAK_TARGET + (SPR_TARGET - WEAK_TARGET) * s;
}
/** 单条连线每帧最大速度增量：防止某条跨半球的弱关系一帧就把人拽飞（MAX_SPEED 的 ~1/4）。 */
const MAX_LINK_PULL = 0.009;

export interface EdgeClick { from: string; to: string; strength: number; sx: number; sy: number; }
export const REL_CAT_COLOR: Record<string, string> = {
  guimi: '#c77dff',   // 闺蜜/诡秘(紫)
  jiaren: '#e9b500',  // 家人(黄)
  qinglv: '#e5484d',  // 情侣(红)
  chouren: '#45b25e', // 仇人(绿)
  qunyou: '#8fb6e6',  // 群友(蓝白底)
};
const pairKey = (a: string, b: string) => (a < b ? a + '|' + b : b + '|' + a);

export function NetCanvas({ nodes, links, selectedUid, centerUid, relations, onEdge, onOpen, onPick }: {
  nodes: CNode[]; links: CLink[];
  selectedUid?: string | null;
  centerUid?: string | null;
  relations?: Record<string, string>;   // 'a|b' -> 类别(guimi/jiaren/qinglv/chouren/qunyou)
  onEdge?: (e: EdgeClick) => void;      // 点击连线
  onOpen?: (n: CNode) => void;
  onPick?: (uid: string | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const cvRef = useRef<HTMLCanvasElement | null>(null);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.uid, n])), [nodes]);
  const linkList = useMemo(() => links.filter((l) => nodeById.has(l.from) && nodeById.has(l.to)), [links, nodeById]);

  const listRef = useRef<SNode[]>([]);
  /** uid → SNode 的索引。原来每帧对每条连线做两次 arr.find()（O(连线×节点)），
   *  显示弱关系时连线从 ~84 涨到 ~200+，每帧就是上万次线性扫描，直接拖慢转球动画。 */
  const idxRef = useRef<Map<string, SNode>>(new Map());
  const reindex = () => { const m = new Map<string, SNode>(); for (const s of listRef.current) m.set(s.uid, s); idxRef.current = m; };
  const hoverRef = useRef<string | null>(null);
  const camRef = useRef({ yaw: 0, pitch: 0.2, Rscale: FIXED_SCALE, spinning: true });
  const ptrRef = useRef<{ x: number; y: number; mode: 'idle' | 'down' | 'drag'; hit?: string; moved: number }>({ x: 0, y: 0, mode: 'idle', moved: 0 });
  const tempRef = useRef(TEMP_INIT);
  const sleepRef = useRef(false);
  const centerUidRef = useRef<string | null>(centerUid ?? null);
  centerUidRef.current = centerUid ?? null;
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedUid ?? null;
  const relationsRef = useRef<Record<string, string> | undefined>(undefined);
  relationsRef.current = relations;

  /* ---------- 初始化 ---------- */
  useEffect(() => {
    const cid = centerUidRef.current;
    const arr: SNode[] = [];
    const shell = cid ? nodes.filter((n) => n.uid !== cid) : nodes;
    const M = Math.max(shell.length, 1);
    shell.forEach((n, i) => {
      const phi = Math.acos(1 - 2 * (i + 0.5) / M);
      const theta = i * Math.PI * (3 - Math.sqrt(5));
      arr.push({
        uid: n.uid, x: Math.sin(phi) * Math.cos(theta), y: Math.cos(phi), z: Math.sin(phi) * Math.sin(theta),
        vx: 0, vy: 0, vz: 0, sx: 0, sy: 0, depth: 0,
      });
    });
    if (cid) {
      const cn = nodes.find((n) => n.uid === cid);
      if (cn) arr.unshift({ uid: cn.uid, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, fixed: true, sx: 0, sy: 0, depth: 0 });
    }
    listRef.current = arr;
    reindex();
    tempRef.current = TEMP_INIT;
    sleepRef.current = false;
    camRef.current.yaw = 0; camRef.current.pitch = 0.2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, centerUid]);

  /* ---------- 连线集合变化：温和重排，而不是把新边直接叠到已冷却/休眠的系统上 ----------
   * 显示/隐藏弱关系、换群、换筛选都会换 linkList。以前没有这一步：系统若已休眠，
   * 新连线根本不参与计算（位置冻住、看着像"没生效"）；若还在动，一百多条边一帧全叠上去，
   * 就会猛地把人拽到一起。现在只补一点点温度让它平滑收敛，且因为弱关系目标=中性距离，
   * 收敛结果与"隐藏弱关系"时基本一致（球面分布不被破坏）。
   */
  useEffect(() => {
    tempRef.current = Math.max(tempRef.current, TEMP_INIT * 0.5);
    sleepRef.current = false;
    reindex();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkList, nodes.length]);

  /* ---------- 主循环 ---------- */
  useEffect(() => {
    const cv = cvRef.current, wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const ctx = cv.getContext('2d')!;
    let raf = 0;
    const resize = () => {
      const d = wrap.getBoundingClientRect();
      const s = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.max(10, Math.round(d.width * s));
      cv.height = Math.max(10, Math.round(d.height * s));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const step = () => {
      const arr = listRef.current;
      if (!arr.length) { raf = requestAnimationFrame(step); return; }
      const n = arr.length;
      const cam = camRef.current;
      const cid = centerUidRef.current;

      if (!sleepRef.current) {
        if (tempRef.current > 0.0002) tempRef.current *= 0.985;

        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
          const p1 = arr[i], p2 = arr[j];
          if (p1.fixed || p2.fixed) continue;
          const dx = p2.x - p1.x, dy = p2.y - p1.y, dz = p2.z - p1.z;
          const d2 = dx * dx + dy * dy + dz * dz + 0.0001;
          const d = Math.sqrt(d2);
          const f = (K_REP / d2) * DT;
          const nx = dx / d, ny = dy / d, nz = dz / d;
          const t1 = nx * p1.x + ny * p1.y + nz * p1.z;
          p1.vx -= (nx - t1 * p1.x) * f; p1.vy -= (ny - t1 * p1.y) * f; p1.vz -= (nz - t1 * p1.z) * f;
          const t2 = nx * p2.x + ny * p2.y + nz * p2.z;
          p2.vx += (nx - t2 * p2.x) * f; p2.vy += (ny - t2 * p2.y) * f; p2.vz += (nz - t2 * p2.z) * f;
        }

        for (const l of linkList) {
          const p1 = idxRef.current.get(l.from);
          const p2 = idxRef.current.get(l.to);
          if (!p1 || !p2) continue;
          if (p1.fixed || p2.fixed) continue; // 中心辐条不走壳面弹簧
          const dx = p2.x - p1.x, dy = p2.y - p1.y, dz = p2.z - p1.z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.0001;
          // 目标距离随强度插值：强关系贴紧、弱关系落在中性距离（见 springTarget 注释）
          const raw = (d - springTarget(l.strength)) * K_SPR * (0.5 + 0.5 * l.strength) * DT;
          const f = Math.max(-MAX_LINK_PULL, Math.min(MAX_LINK_PULL, raw));
          const nx = dx / d, ny = dy / d, nz = dz / d;
          const t1 = nx * p1.x + ny * p1.y + nz * p1.z;
          p1.vx += (nx - t1 * p1.x) * f; p1.vy += (ny - t1 * p1.y) * f; p1.vz += (nz - t1 * p1.z) * f;
          const t2 = nx * p2.x + ny * p2.y + nz * p2.z;
          p2.vx -= (nx - t2 * p2.x) * f; p2.vy -= (ny - t2 * p2.y) * f; p2.vz -= (nz - t2 * p2.z) * f;
        }

        let maxVel = 0;
        for (let i = 0; i < n; i++) {
          const p = arr[i];
          if (p.fixed) continue;
          if (tempRef.current > 0.002) {
            const kick = tempRef.current * 0.4;
            const rx = (Math.random() - 0.5) * kick, ry = (Math.random() - 0.5) * kick, rz = (Math.random() - 0.5) * kick;
            const rt = rx * p.x + ry * p.y + rz * p.z;
            p.vx += rx - rt * p.x; p.vy += ry - rt * p.y; p.vz += rz - rt * p.z;
          }
          p.vx *= DAMP; p.vy *= DAMP; p.vz *= DAMP;
          const cur = Math.hypot(p.vx, p.vy, p.vz);
          if (cur > MAX_SPEED) { const r = MAX_SPEED / cur; p.vx *= r; p.vy *= r; p.vz *= r; }
          maxVel = Math.max(maxVel, cur);
          p.x += p.vx; p.y += p.vy; p.z += p.vz;
          // 硬性地壳约束: 永远贴半径1球面, 绝不脱离
          const L = Math.hypot(p.x, p.y, p.z);
          if (L > 0.00001) { p.x /= L; p.y /= L; p.z /= L; }
        }
        if (maxVel < 0.0006 && tempRef.current <= 0.0005) sleepRef.current = true;
      }

      if (cam.spinning) cam.yaw += 0.0016;

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = cv.width / dpr, H = cv.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2;
      const R = Math.min(W, H) * 0.34 * cam.Rscale;
      const cosY = Math.cos(cam.yaw), sinY = Math.sin(cam.yaw);
      const cosP = Math.cos(cam.pitch), sinP = Math.sin(cam.pitch);

      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(175,190,210,0.16)'; ctx.lineWidth = 1; ctx.stroke();

      for (const p of arr) {
        const x1 = p.x * cosY - p.z * sinY;
        const z1 = p.x * sinY + p.z * cosY;
        const y2 = p.y * cosP - z1 * sinP;
        const z2 = p.y * sinP + z1 * cosP;
        p.sx = cx + x1 * R;
        p.sy = cy - y2 * R;
        p.depth = z2;
      }
      const sorted = [...arr].sort((a, b) => a.depth - b.depth);

      ctx.lineCap = 'round';
      // 壳面之间的连线
      for (const l of linkList) {
        if (cid && (l.from === cid || l.to === cid)) continue;
        const p1 = idxRef.current.get(l.from);
        const p2 = idxRef.current.get(l.to);
        if (!p1 || !p2) continue;
        const avg = (p1.depth + p2.depth) / 2;
        if (avg < -0.55) continue;
        const cat = relationsRef.current?.[pairKey(l.from, l.to)];
        let col: string;
        if (cat && REL_CAT_COLOR[cat]) {
          col = REL_CAT_COLOR[cat];
        } else {
          // 默认群友: 互动越多线越深(白→蓝)
          const tt = Math.max(0, Math.min(1, l.strength));
          const rr = Math.round(236 - (236 - 96) * tt), gg = Math.round(242 - (242 - 150) * tt), bb = Math.round(247 - (247 - 214) * tt);
          col = 'rgb(' + rr + ',' + gg + ',' + bb + ')';
        }
        ctx.globalAlpha = 0.14 + 0.44 * ((avg + 1) / 2) * (0.4 + 0.6 * l.strength);
        ctx.strokeStyle = col;
        ctx.lineWidth = (0.5 + l.strength * 1.2) * (0.7 + 0.6 * ((avg + 1) / 2));
        ctx.beginPath(); ctx.moveTo(p1.sx, p1.sy); ctx.lineTo(p2.sx, p2.sy); ctx.stroke();
      }

      // 主人公在球心: 细亮辐条
      const cObj = arr.find((s) => s.fixed);
      if (cObj) {
        for (const l of linkList) {
          const oth = l.from === cObj.uid ? l.to : (l.to === cObj.uid ? l.from : null);
          if (oth === null) continue;
          const o = idxRef.current.get(oth);
          if (!o) continue;
          const zf = (o.depth + 1) / 2;
          ctx.globalAlpha = 0.3 + 0.55 * zf;
          ctx.strokeStyle = PAL.spoke;
          ctx.lineWidth = 0.8 + l.strength * 1.1;
          ctx.beginPath(); ctx.moveTo(cObj.sx, cObj.sy); ctx.lineTo(o.sx, o.sy); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      // 壳面节点(远→近), 主人=普通一员淡色小圆
      for (const p of sorted) {
        if (p.fixed) continue;
        const nd = nodeById.get(p.uid);
        if (!nd) continue;
        const zf = (p.depth + 1) / 2;
        const scale = 0.6 + 0.9 * zf;
        const baseR = (nd.kind === 'owner' ? 10.5 : nd.kind === 'friend' ? 12.6 : 12.3) * SZ;
        const r = baseR * scale;
        const isHover = hoverRef.current === p.uid;
        const isSel = selectedRef.current === p.uid;
        const col = colorOf(nd.kind);
        ctx.globalAlpha = 0.4 + 0.6 * zf;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, r * (isHover || isSel ? 1.15 : 1), 0, Math.PI * 2);
        ctx.fillStyle = softOf(nd.kind);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = isSel ? 2.4 : isHover ? 1.9 : 1.1;
        ctx.strokeStyle = col;
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.font = '17px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(initialOf(nd), p.sx, p.sy + 1);
        if (isHover || isSel) {
          ctx.font = '15px sans-serif';
          ctx.fillStyle = PAL.muted;
          ctx.fillText(trunc(cleanName(nd.name), 10), p.sx, p.sy + r + 17);
        }
      }

      // 球心主人公最后画(恒在最前)
      if (cObj) {
        const nd = nodeById.get(cObj.uid);
        if (nd) {
          const col = colorOf(nd.kind);
          const r = 12.6 * SZ;
          const isHover = hoverRef.current === cObj.uid;
          const isSel = selectedRef.current === cObj.uid;
          ctx.globalAlpha = 0.95;
          ctx.beginPath(); ctx.arc(cObj.sx, cObj.sy, r * (isHover || isSel ? 1.15 : 1), 0, Math.PI * 2);
          ctx.fillStyle = softOf(nd.kind);
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.lineWidth = isSel ? 2.6 : isHover ? 2 : 1.3;
          ctx.strokeStyle = col;
          ctx.stroke();
          ctx.fillStyle = col;
          ctx.font = '17px sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(initialOf(nd), cObj.sx, cObj.sy + 1);
          ctx.font = '14px sans-serif';
          ctx.fillStyle = PAL.muted;
          ctx.fillText(trunc(cleanName(nd.name), 8), cObj.sx, cObj.sy + r + 16);
        }
      }
      ctx.globalAlpha = 1;

      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkList.length]);

  const toLocal = (e: { clientX: number; clientY: number }) => {
    const rect = cvRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const hitAt = (x: number, y: number): string | null => {
    let best: string | null = null, bd = 1e9;
    for (const p of listRef.current) {
      const d = Math.hypot(x - p.sx, y - p.sy);
      const k = nodeById.get(p.uid)?.kind;
      const base = p.fixed ? 12.6 : (k === 'owner' ? 10.5 : k === 'friend' ? 12.6 : 12.3);
      const rad = base * SZ * (p.fixed ? 1 : (0.6 + 0.9 * ((p.depth + 1) / 2))) + 10;
      if (d <= rad && d < bd) { best = p.uid; bd = d; }
    }
    return best;
  };

  const wake = () => {
    sleepRef.current = false;
    if (tempRef.current < 0.02) tempRef.current = 0.02;
  };

  const onDown = (e: React.PointerEvent) => {
    const p = toLocal(e);
    ptrRef.current = { x: p.x, y: p.y, mode: 'down', hit: hitAt(p.x, p.y) ?? undefined, moved: 0 };
    wake();
    cvRef.current?.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const p = toLocal(e);
    const h = hitAt(p.x, p.y);
    if (hoverRef.current !== h) hoverRef.current = h;
    const st = ptrRef.current;
    if (st.mode === 'idle') return;
    st.moved += Math.abs(p.x - st.x) + Math.abs(p.y - st.y);
    if (st.moved > 4) {
      st.mode = 'drag';
      const cam = camRef.current;
      cam.yaw += (st.x - p.x) * 0.007;
      cam.pitch = Math.max(-Math.PI / 2.1, Math.min(Math.PI / 2.1, cam.pitch + (st.y - p.y) * 0.007));
      cam.spinning = false;
    }
    st.x = p.x; st.y = p.y;
  };
  const segDist = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => {
    const vx = x2 - x1, vy = y2 - y1;
    const l2 = vx * vx + vy * vy || 1e-6;
    let tt = ((px - x1) * vx + (py - y1) * vy) / l2;
    tt = Math.max(0, Math.min(1, tt));
    return Math.hypot(px - (x1 + vx * tt), py - (y1 + vy * tt));
  };
  const onUp = (e: React.PointerEvent) => {
    const st = ptrRef.current;
    const p = toLocal(e);
    if (st.mode === 'down') {
      if (st.hit) {
        const nd = nodeById.get(st.hit);
        if (nd) { onPick?.(nd.uid); onOpen?.(nd); }
      } else if (st.moved <= 4) {
        // 没点到节点 → 尝试命中连线(点到线的中点最近距离<7px 视为点击连线)
        let bestEdge: { l: CLink; d: number } | null = null;
        for (const l of linkList) {
          const p1 = listRef.current.find((s) => s.uid === l.from);
          const p2 = listRef.current.find((s) => s.uid === l.to);
          if (!p1 || !p2) continue;
          const d = segDist(p.x, p.y, p1.sx, p1.sy, p2.sx, p2.sy);
          if (d < 8 && (!bestEdge || d < bestEdge.d)) bestEdge = { l, d };
        }
        if (bestEdge) {
          const midX = (listRef.current.find((s) => s.uid === bestEdge!.l.from)!.sx + listRef.current.find((s) => s.uid === bestEdge!.l.to)!.sx) / 2;
          const midY = (listRef.current.find((s) => s.uid === bestEdge!.l.from)!.sy + listRef.current.find((s) => s.uid === bestEdge!.l.to)!.sy) / 2;
          onEdge?.({ from: bestEdge.l.from, to: bestEdge.l.to, strength: bestEdge.l.strength, sx: midX, sy: midY });
        } else {
          onPick?.(null);
        }
      } else {
        onPick?.(null);
      }
    }
    st.mode = 'idle'; st.hit = undefined;
    camRef.current.spinning = true;
    try { cvRef.current?.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };

  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0 }}>
      <canvas
        ref={cvRef}
        style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none', cursor: 'grab' }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
        onPointerLeave={() => { hoverRef.current = null; }}
        onWheel={(e) => {
          // 缩放已固定(约滚轮放大两档), 滚轮不再改变球大小, 仅阻止页面滚动
          e.preventDefault();
        }}
      />
    </div>
  );
}
