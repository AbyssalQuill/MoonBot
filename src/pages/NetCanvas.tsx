import React, { useEffect, useMemo, useRef } from 'react';

/* ==================================================================
 * NetCanvas —— 零依赖球面力导向网络
 *  默认: 全员平等, 所有节点贴地壳(半径1硬归一, 永不脱离)
 *  centerUid 可选: 仅该"主人公"放球心(固定), 其余仍贴地壳环绕 + 细亮辐条
 *  防抖: DT=0.25 / DAMP=0.84 / MAX_SPEED=0.035 / temp*=0.985 / 静止休眠
 *  交互: 自动缓转; 拖=转球; 缩放已固定(≈滚轮放大两档的大小, 不再滚轮缩放);
 *        悬停不选中; 点击打开档案; 双击恢复自动缓转(配合 pauseSpinOnDrag)
 *  线色: 标注过的关系用 REL_CAT_COLOR 的五类色(大图小图同一套)，没标注的是低饱和蓝灰默认线
 *  尺寸: 节点圆与圈内文字按球半径等比缩放(uScaleOf)，主图观感不变、小图不再糊成一团
 * ================================================================== */
/** 群内角色：'owner'=群主、'admin'=管理员（**不是** CNode.kind 的 'owner'=主人本人） */
export type CRole = 'owner' | 'admin' | 'member';
export interface CNode { uid: string; name: string; kind: 'owner' | 'friend' | 'member' | 'tag'; role?: CRole | null; }
export interface CLink { from: string; to: string; strength: number; }

/* 固定缩放: 等效原滚轮向上两档(每档约 ×1.14)后的大小; 之后滚轮不再缩放 */
const FIXED_SCALE = 1.3;

const PAL = {
  owner: 'rgba(214,140,168,0.9)', friend: '#7b86dc', member: '#5f9ed0',
  ownerSoft: 'rgba(214,140,168,0.12)', friendSoft: 'rgba(123,134,220,0.16)', memberSoft: 'rgba(95,158,208,0.14)',
  lineOwner: 'rgba(224,158,182,0.55)', lineFriend: 'rgba(123,134,220,0.55)', lineMember: 'rgba(150,164,178,0.55)',
  spoke: 'rgba(224,120,156,0.9)',
};
/** 群主/管理员在球上的一圈细色环（与聚焦卡片里的角色徽标同色，见 GroupPortrait 的 ROLE_BADGE） */
const ROLE_RING: Record<string, string> = { owner: '#c98a00', admin: '#0b7d74' };
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
/* 关系配色（2026 主人要求「大图上也显示对应线的颜色，且五类要区分得开」）
 * 原来 qunyou='#8fb6e6' 与「未标注」渐变线的中段几乎同色，标了「群友」的线和没标注的线看不出区别。
 * 现在五类统一用中高饱和色（色相拉开 紫 271° / 金 41° / 红 358° / 绿 131° / 蓝 204°），
 * 未标注线整体降饱和成蓝灰（见 defaultLineColor）。实测（脚本按源码取值算）：
 * 五类两两最小 RGB 距离 105、关系色与未标注线的最小距离 92（≥40 即可分辨）；
 * 画布底色是浅色（卡片 rgba(255,255,255,.6)），五类对浅底的对比度 3.3~4.4（jiaren 原本 #c98a00 只有
 * 2.85，细线会发飘，压深到 #b57d00），对深底 4.0~5.3。
 * （2026-09-19 主人澄清：未标注线**保留**"互动越多线越深"的强度梯度，但整条梯度走**蓝系**、
 *   强端直接取 qunyou 的值 —— 未标注的那对本来就是群友关系。这样「显示强关系」与「显示弱关系」
 *   两个视图里的线读起来是同一支蓝色，不会一边偏蓝一边偏灰。
 *   另外 qunyou 由原来的蓝白 #8fb6e6 改成饱和的 #1f8fdc：它既要有别于未标注的淡蓝，
 *   又不能让"标了群友"和"没标注"看起来是两种颜色 —— 取同一个蓝的深浅两端即可。
 *   实测（脚本按源码取值算）：五类两两最小 RGB 距离 105，关系色与未标注线最小距离 92（≥40 即可分辨）。） */
export const REL_CAT_COLOR: Record<string, string> = {
  guimi: '#9b51e0',   // 闺蜜/诡秘(紫)
  jiaren: '#b57d00',  // 家人(金)
  qinglv: '#e5484d',  // 情侣(红)
  chouren: '#2f9e44', // 仇人(绿)
  qunyou: '#1f8fdc',  // 群友(蓝；原 #8fb6e6 太浅、会和未标注线混)
};
/** 类别文案：卡片按钮与图例共用一份，避免两处写不一致 */
export const REL_CAT_LABEL: Record<string, string> = {
  guimi: '闺蜜/诡秘', jiaren: '家人', qinglv: '情侣', chouren: '仇人', qunyou: '群友',
};
/** 未标注（默认群友）连线：**蓝系**强度梯度，弱→强 = 淡蓝→群友蓝。
 *
 *  【2026-09-19 主人澄清】**不是**要去掉梯度 —— 要的是「显示强关系」和「显示弱关系」这两个视图里
 *  线色**读起来是同一支颜色**，并且**未标注线默认就是群友色（蓝）**：没标注的那对本来就是群友关系，
 *  所以它不该是灰调，而应该和 qunyou 同属蓝系。
 *
 *  · 强端**直接取 qunyou 的值**（REL_CAT_COLOR.qunyou），这样"标了群友的线"和"没标注的线"
 *    在强关系视图里是同一个蓝，不会一个偏灰一个偏蓝；
 *  · 弱端是同一色相的淡蓝（不是灰）→ 弱关系视图里那些弱线看起来仍然是"蓝色系",
 *    于是两个视图之间不会出现"一边蓝一边灰"的观感差；
 *  · 深浅仍然表达强度（"互动越多线越深"这条原意保留）。
 *
 *  ⚠️ qunyou 的色值改这里也要跟着改 —— 所以下面从 REL_CAT_COLOR 取，不另写一份字面量。
 */
function hexRgb(hex: string): [number, number, number] {
  const h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
/** 弱端：与 qunyou 同色相的淡蓝。不用灰 —— 灰调会让"弱关系视图"整体看着不是蓝色系。 */
const WEAK_LINE_RGB: [number, number, number] = [172, 203, 231];
function defaultLineColor(strength: number): string {
  const t = Math.max(0, Math.min(1, strength));
  const [r2, g2, b2] = hexRgb(REL_CAT_COLOR.qunyou);
  const r = Math.round(WEAK_LINE_RGB[0] + (r2 - WEAK_LINE_RGB[0]) * t);
  const g = Math.round(WEAK_LINE_RGB[1] + (g2 - WEAK_LINE_RGB[1]) * t);
  const b = Math.round(WEAK_LINE_RGB[2] + (b2 - WEAK_LINE_RGB[2]) * t);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}
/** 节点/文字尺寸随球半径等比缩放。
 *  依据（按同一套常量复算）：R = min(W,H) * 0.34 * 1.3。主图卡片高 600 → R≈265；聚焦弹层里的小图
 *  只有 340 高 → R≈150。原来所有尺寸都是固定像素，小图里前排节点半径 27.7px（直径 55px，占球径
 *  301px 的 1/5），12 个人挤成一团；缩放后前排 16.6px、后排 11.1→6.6px。主图 R≥265 时系数为 1，观感不变。 */
const NODE_REF_R = 265;
const uScaleOf = (R: number) => Math.max(0.6, Math.min(1, R / NODE_REF_R));
const pairKey = (a: string, b: string) => (a < b ? a + '|' + b : b + '|' + a);

export function NetCanvas({ nodes, links, selectedUid, centerUid, relations, onEdge, onOpen, onPick, pauseSpinOnDrag = false }: {
  nodes: CNode[]; links: CLink[];
  selectedUid?: string | null;
  centerUid?: string | null;
  relations?: Record<string, string>;   // 'a|b' -> 类别(guimi/jiaren/qinglv/chouren/qunyou)
  onEdge?: (e: EdgeClick) => void;      // 点击连线
  onOpen?: (n: CNode) => void;
  onPick?: (uid: string | null) => void;
  /** 拖转后不自动恢复缓转（聚焦弹层里的小图用）。默认 false=主图行为：松手即恢复自动缓转。 */
  pauseSpinOnDrag?: boolean;
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
  /* relations 用 effect 同步，而不是渲染期直接 relationsRef.current = relations：
   * 渲染期写 ref 在并发渲染下可能来自一次被丢弃的渲染、StrictMode 下还会写两次；
   * 绘图循环每帧都现场读 relationsRef.current，所以走 effect 最多晚一帧(≈16ms)，
   * 保存关系后两个图的线色依旧是"立刻"变，既不需要重启循环也不需要重排球面。 */
  useEffect(() => { relationsRef.current = relations; }, [relations]);

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
      const USCALE = uScaleOf(R);
      const cosY = Math.cos(cam.yaw), sinY = Math.sin(cam.yaw);
      const cosP = Math.cos(cam.pitch), sinP = Math.sin(cam.pitch);

      /** 圆角矩形路径（名字气泡底衬用；手写 arcTo，不依赖 ctx.roundRect 的浏览器支持） */
      const roundRectPath = (x: number, y: number, w: number, h: number, rr: number) => {
        const k = Math.min(rr, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + k, y);
        ctx.arcTo(x + w, y, x + w, y + h, k);
        ctx.arcTo(x + w, y + h, x, y + h, k);
        ctx.arcTo(x, y + h, x, y, k);
        ctx.arcTo(x, y, x + w, y, k);
        ctx.closePath();
      };
      /** 圈内首字 + 悬停/选中时的名字气泡。两个实测坑：
       *  1) 原来固定 17px 字号且永远画 2 个汉字；球背面节点半径只有 ~11px（小图里 ~6.6px），
       *     两个汉字宽 34px 比圆（直径 22px／小图 13px）还宽，糊成一团。现在字号跟半径走（≈0.72r），
       *     半径 < 14px 只画 1 个字 —— 同一套常量复算过：背面文字宽 34px → 11px（小图 8.5px）。
       *  2) 悬停名字原来是 15px 灰字直接压在连线上，密集交叉处读不出来。现在先铺一层半透明白底
       *     再写字，并把气泡夹在画布内，贴边时不会被截断。 */
      const drawNodeText = (nd: CNode, x: number, y: number, r: number, col: string, act: boolean) => {
        const init = initialOf(nd);
        const one = r < 14;
        ctx.fillStyle = col;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = Math.max(one ? 8.5 : 9.5, Math.round(r * (one ? 0.95 : 0.72))) + 'px sans-serif';
        ctx.fillText(one ? init.slice(0, 1) : init, x, y + 1);
        if (!act) return;
        const nm = trunc(cleanName(nd.name), 10);
        const fs = Math.max(10.5, Math.round(12 * USCALE) + 1);
        ctx.font = fs + 'px sans-serif';
        const bw = ctx.measureText(nm).width + 10, bh = fs + 7;
        const bx = Math.max(2, Math.min(W - bw - 2, x - bw / 2));
        const by = Math.max(2, Math.min(H - bh - 2, y + r + 3));
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        roundRectPath(bx, by, bw, bh, bh / 2);
        ctx.fill();
        ctx.fillStyle = col;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(nm, bx + bw / 2, by + bh / 2 + 0.5);
      };
      /** 群主/管理员：节点外再套一圈细色环（与聚焦卡片的徽标同色），一个图里也认得出谁是谁。
       *  只画在圆外侧 2.5px，不动节点本身尺寸 —— 主人调好的球面观感不变。 */
      const drawRoleRing = (nd: CNode, x: number, y: number, r: number, act: boolean) => {
        const rc = nd.kind === 'owner' || !nd.role ? undefined : ROLE_RING[nd.role];
        if (!rc) return;
        ctx.globalAlpha = act ? 0.95 : 0.68;
        ctx.lineWidth = act ? 1.8 : 1.3;
        ctx.strokeStyle = rc;
        ctx.beginPath(); ctx.arc(x, y, r + 2.5, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      };

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
      // 壳面之间的连线（标注过的线用关系色，没标注的用低饱和蓝灰默认色）
      for (const l of linkList) {
        if (cid && (l.from === cid || l.to === cid)) continue;
        const p1 = idxRef.current.get(l.from);
        const p2 = idxRef.current.get(l.to);
        if (!p1 || !p2) continue;
        const avg = (p1.depth + p2.depth) / 2;
        const zf01 = (avg + 1) / 2;
        const cat = relationsRef.current?.[pairKey(l.from, l.to)];
        const labeled = !!(cat && REL_CAT_COLOR[cat]);
        // 远侧减负：只隐藏"没标注"的线。标注过的关系即使转到球背面也照画（下面有 alpha 下限），
        // 否则主人标完一条线、球刚好转过去，就以为"颜色没生效"。
        if (avg < -0.55 && !labeled) continue;
        // 关系线的 alpha 有下限（0.34）：原来最低 0.14，深色线转到远侧直接被冲成灰。
        // 未标注线保留强度因子（"互动越多线越实"这条原意主人要求保留）——
        // 淡蓝 + 低 alpha 只是"更淡的蓝"，色相不变，所以弱关系视图里读起来仍是蓝系。
        ctx.globalAlpha = labeled ? 0.34 + 0.5 * zf01 : 0.2 + 0.44 * zf01 * (0.5 + 0.5 * l.strength);
        ctx.strokeStyle = labeled ? REL_CAT_COLOR[cat!] : defaultLineColor(l.strength);
        ctx.lineWidth = (0.5 + l.strength * 1.2 + (labeled ? 0.4 : 0)) * (0.7 + 0.6 * zf01);
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
          /* 原来辐条一律 PAL.spoke（粉）—— 而小图里 12 条线**全是辐条**（壳面之间的线被上面
           * `if (cid && ...) continue` 跳过了），于是 relations 传进来根本没机会生效，
           * 这正是主人说的"小图的线和它表示的关系对不上"。现在标注过的辐条用同一套关系色，
           * 没标注的保持原来的粉色细辐条（= 默认群友线），两者一眼可分辨。 */
          const cat = relationsRef.current?.[pairKey(l.from, l.to)];
          const labeled = !!(cat && REL_CAT_COLOR[cat]);
          ctx.globalAlpha = labeled ? 0.42 + 0.5 * zf : 0.3 + 0.55 * zf;
          ctx.strokeStyle = labeled ? REL_CAT_COLOR[cat!] : PAL.spoke;
          ctx.lineWidth = 0.8 + l.strength * 1.1 + (labeled ? 0.35 : 0);
          ctx.beginPath(); ctx.moveTo(cObj.sx, cObj.sy); ctx.lineTo(o.sx, o.sy); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      /* 壳面节点 + 球心那位，统一按 depth 从远到近画。
       * 原来球心那位是**无条件最后画**（恒在最前），可它 depth=0，正对相机那一半的壳面点投影后
       * 差不多落在同一个位置（正交投影下屏幕距球心 = R*sqrt(1-depth²)）。按同一套常量复算：
       * 小图转一整圈共 1728 个"点·帧"，旧画法有 46 个被球心圆盖住 —— 其中 40 个本该在球心**前面**，
       * 看着就是"有人挤没了、点不中"。改成按深度画后只剩 6 个，且都在球心后面（几何上正确的遮挡）。
       * 球心尺寸不随深度缩放（它是"这张网的中心"）。 */
      for (const p of sorted) {
        const nd = nodeById.get(p.uid);
        if (!nd) continue;
        const isHover = hoverRef.current === p.uid;
        const isSel = selectedRef.current === p.uid;
        const col = colorOf(nd.kind);
        if (p.fixed) {
          const r = 12.6 * SZ * USCALE;
          ctx.globalAlpha = 0.95;
          ctx.beginPath(); ctx.arc(p.sx, p.sy, r * (isHover || isSel ? 1.15 : 1), 0, Math.PI * 2);
          ctx.fillStyle = softOf(nd.kind);
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.lineWidth = isSel ? 2.6 : isHover ? 2 : 1.3;
          ctx.strokeStyle = col;
          ctx.stroke();
          // 球心这位若是群主/管理员，同样给角色环（和聚焦卡片的徽标对上）
          drawRoleRing(nd, p.sx, p.sy, r, isHover || isSel);
          // 球心这位的名字一直显示（小图里就是"这张网的中心是谁"，比灰字压在辐条上看得清）
          drawNodeText(nd, p.sx, p.sy, r, col, true);
          continue;
        }
        const zf = (p.depth + 1) / 2;
        const scale = 0.6 + 0.9 * zf;
        const baseR = (nd.kind === 'owner' ? 10.5 : nd.kind === 'friend' ? 12.6 : 12.3) * SZ * USCALE;
        const r = baseR * scale;
        ctx.globalAlpha = 0.4 + 0.6 * zf;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, r * (isHover || isSel ? 1.15 : 1), 0, Math.PI * 2);
        ctx.fillStyle = softOf(nd.kind);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = isSel ? 2.4 : isHover ? 1.9 : 1.1;
        ctx.strokeStyle = col;
        ctx.stroke();
        drawRoleRing(nd, p.sx, p.sy, r, isHover || isSel);
        drawNodeText(nd, p.sx, p.sy, r, col, isHover || isSel);
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
    // 命中半径必须和绘制时的 USCALE 用同一个口径，否则小图里"看着圆很大、点不中"
    const cv = cvRef.current;
    const U = cv ? uScaleOf(Math.min(cv.clientWidth, cv.clientHeight) * 0.34 * camRef.current.Rscale) : 1;
    let best: string | null = null, bd = 1e9;
    for (const p of listRef.current) {
      const d = Math.hypot(x - p.sx, y - p.sy);
      const k = nodeById.get(p.uid)?.kind;
      const base = p.fixed ? 12.6 : (k === 'owner' ? 10.5 : k === 'friend' ? 12.6 : 12.3);
      const rad = base * SZ * U * (p.fixed ? 1 : (0.6 + 0.9 * ((p.depth + 1) / 2))) + 10;
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
        // 没点到节点 → 尝试命中连线(点到线段的最近距离<8px 视为点击连线)
        // 用 idxRef 而不是每次 find()：前者是文件顶部就写明的索引，这里原来漏了
        let bestEdge: { l: CLink; d: number } | null = null;
        for (const l of linkList) {
          const p1 = idxRef.current.get(l.from), p2 = idxRef.current.get(l.to);
          if (!p1 || !p2) continue;
          const d = segDist(p.x, p.y, p1.sx, p1.sy, p2.sx, p2.sy);
          if (d < 8 && (!bestEdge || d < bestEdge.d)) bestEdge = { l, d };
        }
        if (bestEdge) {
          const a = idxRef.current.get(bestEdge.l.from)!, b = idxRef.current.get(bestEdge.l.to)!;
          onEdge?.({ from: bestEdge.l.from, to: bestEdge.l.to, strength: bestEdge.l.strength, sx: (a.sx + b.sx) / 2, sy: (a.sy + b.sy) / 2 });
        } else {
          onPick?.(null);
        }
      } else {
        onPick?.(null);
      }
    }
    st.mode = 'idle'; st.hit = undefined;
    /* 主图：松手就恢复自动缓转（主人调好的"缓缓漂动"）。
     * 小图(pauseSpinOnDrag)：拖转后停下 —— 原来松手立刻继续转，刚转到的角度马上跑掉，想点某个
     * 壳上的人全靠追。暂停后视图稳定，双击（onDoubleClick）可恢复自动旋转，不会走进死胡同。 */
    if (!pauseSpinOnDrag) camRef.current.spinning = true;
    try { cvRef.current?.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };

  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0 }}>
      <canvas
        ref={cvRef}
        style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none', cursor: 'grab' }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
        onDoubleClick={() => { camRef.current.spinning = true; }}
        onPointerLeave={() => { hoverRef.current = null; }}
        onWheel={(e) => {
          // 缩放已固定(约滚轮放大两档), 滚轮不再改变球大小, 仅阻止页面滚动
          e.preventDefault();
        }}
      />
    </div>
  );
}
