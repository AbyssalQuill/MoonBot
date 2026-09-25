import type {
  ManagerState, ManagerConfig, OpenResult, InstanceActionResult, RemoteServerStatus,
} from './stores/types';
import {
  CFG_MANAGER, CFG_BRIDGE_LOCAL, CFG_LEARNING,
  bridgeRemoteKey, dropUnknownSecrets, noteActiveScope, rememberConfig, rememberLastConnect,
} from './config-cache';

/** 与后端交互的轻量封装（走 Vite /api 代理，生产同源） */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) throw new Error(`API ${path} -> HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/* ================= 缓存接入点（见 src/config-cache.ts） =================
 * 「口径」：凡是成功读到"某一份配置/连接状态"的请求，都在这里顺手写入持久化缓存；
 * 页面挂载时先取缓存渲染，因此切页面、刷新页面都不会再先闪一份不同的数值。
 *   · 键按"读取目标"分：本机桥配置 / 服务端桥配置（键里带 serverId）——绝不互相回落；
 *   · 失败一律不写（`ok === false`、回包缺 config、请求抛错）：缓存里只留"真实读到过"的值，
 *     绝不把失败/空壳回包当成配置存下来；
 *   · 落盘的副本会剔除密钥（脱敏规则见 config-cache.ts 文件头 段），内存里仍是完整值。 */

/** 连接状态：写入"上次已知的连接事实"（只含 connected / 服务器 id 与名字），
 *  并登记当前活动作用域（本机 / 某台服务器）。
 *  用途一（config-cache.ts 的 CFG_LAST_CONNECT）：页面刚打开、状态尚未回来时，
 *  界面据此说"正在连接 X…"，而不是武断地先写一句"未连接远程"。
 *  用途二（作用域鉴别）：语音/学习这两个接口读的是"当前活动目标"上的配置，
 *  同一份缓存键在两侧含义不同 —— 登记作用域后，缓存不会把服务端那份当成本机的显示。 */
export const getState = async () => {
  const s = await api<ManagerState>('/state');
  try { rememberLastConnect(s); } catch { /* 缓存写入失败不影响状态读取 */ }
  try { noteActiveScope(!!s?.connected, s?.activeServer?.id ?? null); } catch { /* 忽略 */ }
  return s;
};
/** 群友画像学习：action = start | stop | status；start 不带 qq 时由桥侧按配置自动筛活跃群成员 */
export const portraitAction = (action: 'start' | 'stop' | 'status', qq?: string[]) =>
  api<any>('/learning/portrait', { method: 'POST', body: JSON.stringify({ action, ...(qq && qq.length ? { qq } : {}) }) });
/** 管理端实例配置（各配置页的初值来源；缓存键 CFG_MANAGER） */
export const getConfig = async () => {
  const c = await api<ManagerConfig>('/config');
  try { rememberConfig(CFG_MANAGER, c); } catch { /* 忽略 */ }
  return c;
};

export async function openOfficial(target: string) {
  return api<OpenResult>(`/open?target=${encodeURIComponent(target)}`);
}

/** 本机实例：start / stop / restart */
export function instanceAction(id: string, action: 'start' | 'stop' | 'restart') {
  return api<InstanceActionResult>(`/instance/${id}/${action}`, { method: 'POST' });
}
/** 一键启动整套：NapCat → DSH → 桥（按依赖顺序, 失败即停） */
export function startAllInstances() {
  return api<InstanceActionResult>('/instance/start-all', { method: 'POST' });
}

/** 本机实例日志尾部 */
export function instanceLogs(id: string, tail = 200) {
  return api<{ lines: string[] }>(`/instance/${id}/logs?tail=${tail}`);
}

export const postConfig = (patch: Record<string, unknown>) => {
  /* 脱敏副本保护：若本次是"从磁盘缓存起底、尚未读到实时配置"，则把其中我们并不知道真实值、
   * 且此刻恰好为空的凭证字段从补丁里删掉（后端 /api/config 是浅合并 → 缺键即保留原值，
   * 详见 config-cache.ts 的 dropUnknownSecrets）。 */
  try { dropUnknownSecrets(CFG_MANAGER, patch); } catch { /* 忽略 */ }
  return api<{ success: boolean }>('/config', { method: 'POST', body: JSON.stringify(patch) });
};

/* ================= 一键克隆部署（把模板服务器整套部署到新服务器） ================= */
export interface DeployTaskStatus {
  success?: boolean;
  taskId?: string;
  status?: 'running' | 'done' | 'error';
  lines?: string[];
  message?: string;
}
export interface DeployTaskBrief {
  id: string;
  status: string;
  lines: string;
  updatedAt?: number;
  finishedAt?: number | null;
}
/** 发起克隆。`source` 与 `target` 可传服务器对象（尚未保存的新条目亦可）或已保存的 id；
 *  `source` 传 `{ local: true, name }` 表示从本机复刻，不需要模板服务器。 */
export const deployStart = (source: Record<string, unknown> | string, target: Record<string, unknown> | string, qqData: boolean) =>
  api<DeployTaskStatus>('/ssh/deploy/start', {
    method: 'POST',
    body: JSON.stringify({
      source,
      sourceKind: (source as { local?: boolean })?.local === true ? 'local' : undefined,
      target,
      qqData,
    }),
  });
export const deployStatus = (taskId: string) =>
  api<DeployTaskStatus>(`/ssh/deploy/status?taskId=${encodeURIComponent(taskId)}`);
export const deployTasks = () =>
  api<{ success: boolean; tasks: DeployTaskBrief[] }>('/ssh/deploy/tasks');

/* ================= 学习系统（经 manager /api/learning/* 代理到活动 bridge console） ================= */
/** 学习配置（对应桥侧 state/learning-config.json，v2：定时 + 自动间隔） */
export interface SlangLearningCfg {
  enabled?: boolean;
  timeHHMM?: string;
  autoResearch?: boolean;
  liveWindowExtract?: boolean;
  lastLearnAtMs?: number;
/** v2：自动间隔学习 */
  autoIntervalEnabled?: boolean;
  autoIntervalHours?: number;
}
export interface PersonaLearningCfg {
  enabled?: boolean;
  targetQQ?: string[];
/** v2：自动间隔学习（每次对 targetQQ 全量重学并推进 lastRunAtMs） */
  autoIntervalEnabled?: boolean;
  autoIntervalHours?: number;
  lastRunAtMs?: number;
  [k: string]: unknown;
}
export interface LearningConfig {
  slang?: SlangLearningCfg;
  persona?: PersonaLearningCfg;
  [k: string]: unknown;
}
/** 桥响应原样透传，具体字段以桥侧为准（GUI 各处均做容错） */
export type BridgeResp = Record<string, any>;

/** 学习配置。回包可能是 `{config:{...}}` 也可能是配置本体（页面两处都做了兼容），
 *  这里按同一口径取"配置本体"入缓存（键 CFG_LEARNING），页面的初值才拿得到同一形状的值。 */
export const getLearningConfig = async () => {
  const r = await api<BridgeResp>('/learning/config');
  try {
    const bad = (r as any)?.ok === false || (r as any)?.success === false
      || !!(r as any)?.error || !!(r as any)?.code;
    if (!bad) {
      const c = (r as any)?.config ?? (r as any)?.result?.config ?? r;
      if (c && typeof c === 'object') rememberConfig(CFG_LEARNING, c);
    }
  } catch { /* 忽略 */ }
  return r;
};
export const saveLearningConfig = (cfg: LearningConfig) =>
  api<BridgeResp>('/learning/config', { method: 'POST', body: JSON.stringify(cfg) });
export const slangAction = (action: 'learn' | 'stop') =>
  api<BridgeResp>('/learning/slang', { method: 'POST', body: JSON.stringify({ action }) });
export const personaAction = (action: 'start' | 'stop' | 'status', qq?: string[]) =>
  api<BridgeResp>('/learning/persona', { method: 'POST', body: JSON.stringify(qq?.length ? { action, qq } : { action }) });
/** 人格学习：审批或修正学到的英文人设正文 `personaEn`。
 *  `mode='save'`：把 `text` 作为修正后的正文写回该 uid 的库记录，机器人人设不变；
 *  `mode='apply'`：把 `text`（缺省则取库中的 `personaEn`）覆盖写入桥的 `qq-bridge/persona.md`，
 *                 覆盖前自动备份旧人设（`persona.md.bak-<日期-时间>`，最多保留 5 份），自下一条消息起生效。
 *  返回 `save: { ok, uid, savedChars }`；`apply: { ok, uid, bytes, backup }`；失败 `{ ok:false, error }`（中文）。 */
export const personaApply = (uid: string, mode: 'save' | 'apply' | 'fuse', text?: string) =>
  api<BridgeResp>('/learning/persona-apply', {
    method: 'POST',
    body: JSON.stringify(text === undefined ? { uid, mode } : { uid, mode, text }),
  });

/* ================= NapCat 鉴权令牌（WebUI / HTTP / WS） =================
 * 早先管理端修改「NapCat 令牌」只改桥 `config.json` 中"期望使用哪个"，未写入 NapCat 自身配置，
 * 结果是旧令牌（默认 `truefriend`）仍可进入，而桥以新令牌连不上。以下两个接口是实际写入落盘的一对：
 *   GET  /api/napcat/tokens → NapCat 磁盘现状与桥配置期望值（两者均只返回掩码）
 *   POST /api/napcat/tokens → 写入 NapCat 的 `webui.json` / `onebot11*.json` + 重启容器 + 复验新旧令牌
 * 请求体：{ webuiToken?, httpToken?, wsToken?, restart?, useBridgeTokens? }
 *   useBridgeTokens=true → 不填令牌，直接以桥配置中现有的 HTTP/WS 令牌写入 NapCat
 *   （WebUI 令牌未单独填写时亦用它）：语义为使三处一致为桥中那个令牌。 */
export const getNapcatTokens = () => api<any>('/napcat/tokens');
export const applyNapcatTokens = (patch: { webuiToken?: string; httpToken?: string; wsToken?: string; restart?: boolean; useBridgeTokens?: boolean }) =>
  api<any>('/napcat/tokens', { method: 'POST', body: JSON.stringify(patch) });

/* ================= NapCat WebUI 可达性判定 =================
 * 2026-09-23 去除探针与状态检测：该端点现为纯本地判定：
 *   · serviceUp —— 端口是否可达（对 /webui/ 做 HTTP 探活，不消耗 NapCat 登录额度）；
 *   · ok        —— 等于 serviceUp。服务可达即重载一次，页面自行登录。
 * 管理器不再以 NapCat 的登录接口验证令牌：该接口为每 IP 每 60 秒 loginRate（出厂 10）次的限量资源，
 * WebUI 页面自身亦需占用一次；探针每多发一次，页面可用次数即减少一次，用尽后页面返回
 * 「获取QQ列表失败: Unauthorized」。故 verify 与 warm 现仅为"已去除"的静态说明，
 * rateLimit 恒为 0（管理器未消耗任何 NapCat 额度）。 */
export interface NapcatWebuiReady {
  ok: boolean;
  scope: string;
  port: number;
  server?: string | null;
  serviceUp: boolean;
  tokenPresent: boolean;
  off?: string;
  note: string;
  error?: string;
/** attempted 恒为 false：管理器不再自查令牌（removed=true 表示"这个能力已不存在"） */
  verify?: { attempted: boolean; status: string; note: string; verifiedAt: number; retryAfterMs: number; removed?: boolean; requested?: boolean };
/** done 恒为 false：静默预鉴权已整体删除（removed=true） */
  warm?: { done: boolean; at: number; removed?: boolean };
  rateLimit?: { napcatLimit: number; budget: number; windowMs: number; attemptsInWindow: number; limited: boolean; retryAfterMs: number; removed?: boolean; note?: string };
}
/** `opts.verify` 已废弃（管理器直接忽略）：保留参数只为不改动老调用点。 */
export const getNapcatWebuiReady = (_opts?: { verify?: boolean }) =>
  api<NapcatWebuiReady>('/napcat/webui-ready');

/* ================= 连接服务端的状态机 =================
 * 2026-09-22连接服务器后可直接退出；下次打开时自动连接服务器，该过程带有「服务端启动中」状态机。
 * 阶段：idle → connecting(SSH) → tunnels → server-starting(组件逐个就绪)
 * → warming(静默预鉴权) → ready / failed。轮询该接口不产生任何网络动作。 */
export interface ConnectPhase {
  phase: 'idle' | 'connecting' | 'tunnels' | 'server-starting' | 'warming' | 'ready' | 'failed';
  note: string;
  serverId: string;
  serverName: string;
  components: { id: string; name: string; state: 'ready' | 'starting' | 'down'; detail: string }[];
  attempts: number;
  lastError: string;
  since: number;
  updatedAt: number;
  elapsedMs: number;
  warm: { done: boolean; at: number; note: string };
}
export const getConnectState = () => api<{ ok: boolean; connect: ConnectPhase; connected: boolean }>('/connect');

/* ================= NapCat 二维码（登录态失效时供扫码使用） =================
 * 2026-09-23 去除探针与状态检测
 * 桥侧主动探测 NapCat、自愈与换码的逻辑已全部删除，"会话守护"相关接口
 * （GET/POST /api/napcat/guard、POST /api/napcat/guard/heal）随之失去意义：
 * 桥仍会应答，但一律返回 `removed:true`（heal 返回 410）。
 * 因而此处仅保留仍在使用的唯一一条：读取 NapCat 已落盘的二维码供扫描。
 *   GET /api/napcat/qr → { ok, path, bytes, dataUrl } / 失败 { ok:false, error }
 *
 * 「既定契约」：不再支持 `fresh`：此前 `fresh=true` 会使桥调用 NapCat 的 RefreshQRCode 更换新码，
 * 属破坏性动作（正在扫描的那张立即作废，首次扫码即报鉴权失败），且需先登录 WebUI（占用页面额度）。
 * 现桥只做一件事：原样读出既有的那张码。若需全新二维码，请在 NapCat 自身界面中生成。 */
export interface NapcatQrSnapshot {
  ok: boolean;
  path?: string;
  bytes?: number;
/** data:image/png;base64,... —— 直接塞给 <img src> */
  dataUrl?: string;
  error?: string;
}
/** 只读现有的二维码（桥侧已无"更换一张"的能力）。 */
export const getNapcatQr = () => api<NapcatQrSnapshot>('/napcat/qr');
/** 2026-09-14用量统计两侧均取：local=本机桥、remote=服务端桥（为 null 表示未取到，原因见 remoteReason）、
 *  total=两份合并的合计。report 保留为合计的兼容字段。 */
export interface TokenReportSide {
  dates?: Array<Record<string, any>>;
  todayHourly?: Array<Record<string, any>>;
  today?: Record<string, number>;
  todayEstimatedTotal?: number;
/** 时段法外推（新口径）；旧桥没有该字段时前端退回 todayEstimatedTotal */
  todayLinearEstimatedTotal?: number;
/** 'shape' = 按最近 7 天同时段平均；'linear' = 线性外推；'none' = 样本太少不外推 */
  projectedBy?: string;
  dayWindow?: Record<string, any>;
  note?: string;
  [k: string]: any;
}
export interface ContextSavingsBucket {
/** 被 DSH 的 compaction/prune 从上下文中剪除的 token（取自 DSH 记录的 shadowedTokenCount） */
  prunedTokens: number;
/** 剪枝事件条数 */
  pruneEvents: number;
/** 剪除内容原本会在后续每次请求中被重读，此处为累计少读的 token（实测 cacheRead 口径） */
  rereadSaved: number;
/** 另一条路径为摘要压缩：最老一段对话被替换为 <compacted-summary> 时盖掉的 token */
  summarizedTokens?: number;
/** 摘要压缩发生次数 */
  summaryEvents?: number;
/** 失败后重试的请求次数（提供方计费而 DSH 不产生 usage，是面板数值低于控制台的主要来源） */
  retryEvents?: number;
}
export interface ContextSavings {
  today: ContextSavingsBucket;
/** 最近几天（不含今天），按计费日倒序 */
  days: Array<ContextSavingsBucket & { date: string }>;
  lifetime: ContextSavingsBucket;
/** 当前还有"已剪掉的内容"留在上下文里的会话数 */
  liveSessions?: number;
  since?: string;
  note?: string;
  [k: string]: any;
}
export interface TokenReportResp {
  ok: boolean;
  at?: number;
  mode?: 'local' | 'ssh';
/** 本机桥那一份（未取到时为 null，原因见 localReason） */
  local: TokenReportSide | null;
/** 服务端桥那一份（未取到时为 null，原因见 remoteReason） */
  remote: TokenReportSide | null;
/** 两份合并的合计 */
  total: TokenReportSide | null;
/** 上下文剪枝节省的量（实测值，来自 DSH 的 compaction/prune 事件；旧版桥无此字段） */
  contextSavings?: ContextSavings | null;
  localReason?: string;
  remoteReason?: string;
  remoteServer?: { id: string; name: string; host: string } | null;
/** 兼容：= total（只有一边时就是那一边） */
  report?: TokenReportSide | null;
  [k: string]: any;
}

export const getTokenReport = () => api<TokenReportResp>('/learning/token-report');

/* ================= 服务端（SSH）状态与桥配置：复用已建立的 SSH 连接，不新建连接 ================= */
/** 服务端三个组件的真实运行状态：DSH=systemd dsh-web、NapCat=docker、桥=node src/bridge.js */
export const getSshStatus = (serverId?: string, force = false) =>
  api<RemoteServerStatus>(`/ssh/status?${serverId ? 'serverId=' + encodeURIComponent(serverId) + '&' : ''}${force ? 'force=1' : ''}`);

/** 服务端 qq-bridge 配置（读 /root/qq-bridge/config.json；target=remote 表示这份来自服务器） */
export interface RemoteBridgeConfigResp {
  ok: boolean;
  target?: 'remote';
  connected?: boolean;
  message?: string;
  server?: { id: string; name: string; host: string; username?: string };
  dir?: string;
  path?: string;
  config?: Record<string, any>;
  persona?: string;
  personaHasFile?: boolean;
  speechRules?: string;
  speechHasFile?: boolean;
  dshEffective?: { provider?: string; model?: string; reasoningEffort?: string };
  dshModels?: { providers: Record<string, Array<{ id: string; name?: string; vision?: boolean }>>; sources?: Record<string, string> };
  dshSettingsPath?: string;
  roles?: string[];
  notes?: string[];
  steps?: Array<{ step: string; ok: boolean; msg?: string }>;
  verified?: boolean;
  mismatched?: string[];
  backup?: string | null;
}
/**
 * 读取服务端 `/root/qq-bridge/config.json`。
 *
 * 2026-09-19 增加 refresh：后端对该配置设有 45 秒预热缓存（每次状态轮询都会预热，一次预热需
 * 4~5 个 SSH 往返），但 POST 写入后仅删除缓存、无代次校验，因此"写入之前发出的那次预热"可能在
 * 写入之后把写入之前的旧内容重新塞回缓存，GET 再读到旧值。表现即为：点保存、切出再返回时值复原，
 * 第二次点保存才真正生效。故保存后的重载（以及其它必须读到刚写入值的场合）一律带 refresh=1 绕过缓存。
 */
export const getRemoteBridgeConfig = async (serverId?: string, opts?: { refresh?: boolean }) => {
  const r = await api<RemoteBridgeConfigResp>(`/ssh/bridge-config?${[
    serverId ? 'serverId=' + encodeURIComponent(serverId) : '',
    opts?.refresh ? 'refresh=1' : '',
  ].filter(Boolean).join('&')}`);
  /* 缓存只在明确指定了 serverId 时写入：不传 serverId 时后端按"当前活动服务器"路由，
   * 前端拿不到它到底读了哪一台 —— 把它写进某个键就等于让 A 的配置冒充 B 的，故宁可不缓存。
   * 回包没有 config（读取失败/服务器上没找到目录）时同样不写：缓存只留真实读到过的值。 */
  try {
    if (serverId && r && r.ok !== false && r.config && typeof r.config === 'object') {
      rememberConfig(bridgeRemoteKey(serverId), r.config);
    }
  } catch { /* 忽略 */ }
  return r;
};
/** 写服务端配置：后端会「临时文件 → 备份 config.json.bak-<时间戳> → mv 原子替换 → 回读比对关键字段」 */
export const saveRemoteBridgeConfig = (body: Record<string, any>) => {
  /* 同 postConfig：脱敏副本起底期间，把"值未知且为空"的凭证字段从提交体里删掉
   * （服务端 POST 同样是深合并 → 缺键保留原值，令牌/密钥不会被空值覆盖）。 */
  try {
    const sid = (body as any)?.serverId;
    if (sid) dropUnknownSecrets(bridgeRemoteKey(String(sid)), body);
  } catch { /* 忽略 */ }
  return api<RemoteBridgeConfigResp>('/ssh/bridge-config', { method: 'POST', body: JSON.stringify(body) });
};

/** 2026-09-14按组件启停服务器上的组件（连上服务器后首页那三张卡的按钮走这条路，
 *  不再去启动本机进程）。component: dsh / napcat / bridge；action: start / stop / restart。 */
export const sshServiceAction = (serverId: string, component: 'dsh' | 'napcat' | 'bridge', action: 'start' | 'stop' | 'restart') =>
  api<{ ok: boolean; component?: string; action?: string; out?: string; message?: string }>(
    '/ssh/service', { method: 'POST', body: JSON.stringify({ serverId, component, action }) },
  );

/* ================= 配置方案（把整套 config.json 存成命名方案，随时套用） ================= */
export interface ConfigProfile {
  id: string;
  name: string;
/** 保存时刻的完整桥配置（config.json 的一份快照） */
  config: Record<string, unknown>;
/** 一眼看懂的小结（模型 / 主动闲聊 / 名单等关键项） */
  summary?: string;
  createdAt?: number;
/** 出厂预置的方案（可套用、不可删） */
  builtin?: boolean;
}
export const listProfiles = () => api<{ ok: boolean; profiles: ConfigProfile[]; dir?: string }>('/profiles');
/** 存为新方案；参数与已有方案完全相同时服务器直接复用（返回 existed），不会重复堆 */
export const saveProfile = (name: string, config: Record<string, unknown>) =>
  api<{ ok: boolean; id?: string; existed?: { id: string; name: string } }>('/profiles', {
    method: 'POST', body: JSON.stringify({ name, config }),
  });
export const deleteProfile = (id: string) =>
  api<{ ok: boolean }>(`/profiles/${encodeURIComponent(id)}/delete`, { method: 'POST' });

/* ================= 群友画像 / owner 画像（manager 直读本机桥 memory.db，无需桥在线） ================= */
export type GraphNodeKind = 'owner' | 'friend' | 'member';
/** 群内角色：owner=群主、admin=管理员、member=普通群成员。
 *  由后端 /api/learning/graph 每个 node 新增；注意它与 kind 不是一回事
 *  （kind='owner' 是"owner 自己"，role='owner' 是"群主"）。老后端没有这个字段时为 null/undefined，
 *  前端一律按"群成员"回落，不显示空白。 */
export type GraphRole = 'owner' | 'admin' | 'member';

export interface GraphNode {
  uid: string;
  name: string;
  kind: GraphNodeKind;
/** 群内角色（可选；拿不到时 null/undefined → 回落为"群成员"） */
  role?: GraphRole | null;
/** 兴趣/特征标签（≤5，启发式切词） */
  tags: string[];
/** 近 30 天发言条数（direction=in 且非自己） */
  msgCount: number;
/** 最近活跃时间戳(ms)，无则 null */
  lastSeen: number | null;
  birthday?: string | null;
  personality?: string;
  likes?: string;
  notes?: string;
  personaSummary?: string;
}
export interface GraphLink {
  from: string;
  to: string;
/** 归一化强度 0.05~1（对数压缩） */
  strength: number;
}
export interface GraphData {
  ok: boolean;
  nodes?: GraphNode[];
  links?: GraphLink[];
  meta?: { nodeCount?: number; linkCount?: number; generatedAt?: string };
  message?: string;
  detail?: string;
}
/** 说话风格（persona-library 里 persona 的 style 字段，前端只读用来展示） */
export interface PersonaStyle {
  sentenceLength?: string;
  rhetoricalQuestions?: string;
  toneWords?: string;
  examples?: string[];
}
/** persona-library.json 里某个 uid 的完整条目（server 的 personaLibraryEntry 原样返回，不截断） */
export interface PersonaEntry {
  nickname?: string | null;
/** 称呼用语（owner/老公/宝贝…） */
  addressTerms?: string;
/** 成文画像（学习产出的人设正文，可能是长文） */
  profile?: string | null;
  personality?: string | null;
/** 英文人设正文 */
  personaEn?: string | null;
  chatHabits?: string;
  emojiHabits?: string;
  relationshipAdvice?: string;
  style?: PersonaStyle | null;
  catchphrases?: Array<{ phrase: string; context: string }>;
  topics?: string[];
  taboos?: string[];
  samples?: number;
  learnedAtMs?: number;
  personaEditedAtMs?: number;
  personaAppliedAtMs?: number;
}
export interface OwnerProfileResp {
  ok: boolean;
  owner?: {
    uid: string;
    name: string;
    birthday?: string | null;
    personality?: string | null;
    likes?: string | null;
    dislikes?: string | null;
    notes?: string | null;
    updatedAtMs?: number;
    /**   / owner 在自己群里的真实角色（与图谱 node.role 同一套取值；null=拿不到）。注意这不是 owner 这个身份 */
    role?: GraphRole | null;
  } | null;
/** 由 profile 的 personality/likes/dislikes/notes 切出的标签，最多 12 个。
   *  「实测」owner 的 profile 中 personality/likes/dislikes 均为空，仅 notes 有内容，
   *  而 notes 保存的正是"给模型的说话要求"（例如发消息末尾不带句号），前端取到后须再过一遍 INSTR_RE。 */
  profileTags?: string[];
/** 近 30 天记忆条目中的高频二字词，形状 {w,c}，来源为 server 的 memoryTopWords
   *  （按汉字连续段切 bigram 并以停用字切断）：未使用词典，故可能出现"果数/里游"一类碎词，
   *  界面上须标明来历，不得当作人格标签。 */
  memoryTop?: Array<{ w: string; c: number }>;
/** persona-library 里该 uid 的条目（存在就说明这个人是学习过的）；老数据/没学过时为 null */
  persona?: PersonaEntry | null;
  msgCount30d?: number;
  lastSeenAt?: number | null;
  generatedAt?: string;
  message?: string;
  detail?: string;
}

export const getLearningGraph = () => api<GraphData>('/learning/graph');
/** 一条黑话词条（桥的 state/slang.json 里的一条；字段以桥侧 slang-learner 的 upsertSlangEntry 为准） */
export interface SlangEntry {
  id?: string;
  content?: string;
  meaning?: string;
  usage?: string;
  example?: string;
  risk?: string;
/** candidate | confirmed | rejected（桥侧 SLANG_STATUS） */
  status?: string;
/** 出现次数 */
  count?: number;
/** 来源：manual / 群会话 key 等 */
  source?: string;
/** 研究会话明确确认（confirmed:true + 有含义 + risk 非 high）后桥侧自动转 confirmed 时打的标 */
  autoConfirmed?: boolean;
  confirmedAt?: string;
  updatedAt?: string;
  addedAt?: string;
  evidence?: Array<{ key?: string; sender?: string; text?: string; time?: number }>;
}
/** 黑话学习状态机的阶段（桥侧已确认的契约，前端只做展示映射）：
 *  disabled=学习开关关着 · extracting=正在批量提取+研究 · stopping=收到停止请求，等当前分块结束 ·
 *  queued=有排队任务 · researching=有候选正在研究会话里分析 · ready=学习会话在、当前空闲 ·
 *  idle=没有会话也没有任务 */
export type SlangLearnPhase = 'disabled' | 'extracting' | 'stopping' | 'queued' | 'researching' | 'ready' | 'idle';
/** 桥侧「学习状态机」快照：`GET /api/slang` 回包里的 `learning`（管理端 `GET /api/learning/slang-library` 即转发此条）。
 *  老桥 / 接口失败时该字段可能是 null —— 前端必须按"拿不到状态"降级显示，不能报错、也不能显示假状态。 */
export interface SlangLearningState {
  phase: SlangLearnPhase;
/** 黑话学习总开关是否开着 */
  enabled: boolean;
/** 是否有学习任务正在跑 */
  inFlight: boolean;
/** 已排队未开始的任务数 */
  queuedOps: number;
/** 是否收到过停止请求（等当前分块结束） */
  stopRequested: boolean;
/** 正在研究（分析含义）的候选条数 */
  researching: number;
/** 学习会话是否已建立 */
  learnerSessionActive: boolean;
/** 上次学习水位（毫秒时间戳，0 = 还没学过） */
  lastLearnAtMs: number;
/** 黑话库构成（与 entries 同一份数据；可直接当两个分组的标题计数，未确认 = candidate） */
  counts: { candidate: number; confirmed: number; rejected: number; total: number };
}
/** 黑话库回包（桥 /api/slang：{ entries, config, learning }；learning 可能为 null） */
export interface SlangLibraryResp {
  ok?: boolean;
  error?: string;
  entries?: SlangEntry[];
  config?: Record<string, unknown>;
  learning?: SlangLearningState | null;
/** 兼容回包被包一层的情况 */
  result?: SlangLibraryResp;
  data?: SlangLibraryResp;
}
/** 黑话库（桥的 state/slang.json，经管理端代理） */
export const getSlangLibrary = () => api<SlangLibraryResp>('/learning/slang-library');
/** 黑话库的批量审批与删除（管理端同名路径转发至桥控制台，body 一律为 `{ ids: string[] }`）：
 *   · batch-confirm：仅对候选（candidate）且 meaning 非空的条目生效，其余跳过并返回
 *     `{ ok, confirmedCount, skippedCount, skipped:[{id,content?,reason}] }`。
 *     2026-09-16管理端「黑话库」弹窗不再调用它：研究会话明确确认后，桥侧会自动将候选转为
 *     confirmed（见 slang.js 中 autoConfirmed 一段），人工批量通过已无必要，「批量通过」按钮已删除。
 *     如需恢复单条确认，对应桥侧 `POST /api/slang/:id/confirm`（管理端目前未转发该路由）。
 *   · batch-reject：`{ ok, rejectedCount }`（不再参与查询，可仅留档而不删除）。
 *   · research：仅对候选生效（已确认或已拒收者由桥侧过滤）→ `{ ok, count }`。
 *   · batch-delete：仅按 ids 删除 → `{ ok, removedCount }`；无匹配条目时桥返回
 *     `404 { ok:false, error:'没有匹配到要删除的黑话' }`（前端必须给出提示，不得静默）。
 *     桥的路由另支持 `{ status:'confirmed' }` 整批删除，但界面有意不暴露该入口（需求为单条可删），
 *     故本函数只接受 ids，无法传出 status。 */
export const slangBatchConfirm = (ids: string[]) =>
  api<BridgeResp>('/slang/batch-confirm', { method: 'POST', body: JSON.stringify({ ids }) });
export const slangBatchReject = (ids: string[]) =>
  api<BridgeResp>('/slang/batch-reject', { method: 'POST', body: JSON.stringify({ ids }) });
export const slangResearch = (ids: string[]) =>
  api<BridgeResp>('/slang/research', { method: 'POST', body: JSON.stringify({ ids }) });
/** 删黑话。单条删除就传一个 id 的数组（`[id]`）；界面上只走这条路，不按 status 整批删。 */
export const slangBatchDelete = (ids: string[]) =>
  api<BridgeResp>('/slang/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) });
/** 单人完整画像资料（直读 memory.db，不做截断） */
export const getPersonProfile = (uid: string) => api<any>(`/learning/profile?uid=${encodeURIComponent(uid)}`);
export const getOwnerProfile = () => api<OwnerProfileResp>('/learning/owner-profile');

/* ================= 角色库导入（characters 目录） ================= */
export interface CharacterEntry {
  slug: string; name: string; game: string; cv: string;
  manifest: boolean; mainPrompt: string | null; mdFiles: number;
}
export const listCharacters = (dir?: string) =>
  api<{ ok: boolean; dir?: string; characters?: CharacterEntry[]; message?: string; roots?: string[] }>(
    `/bridge/characters${dir ? '?dir=' + encodeURIComponent(dir) : ''}`);
export const importCharacter = (dir: string, slug: string, includeDims = true, apply = true) =>
  api<{ success: boolean; slug?: string; chars?: number; bytes?: number; preview?: string; applied?: boolean; message?: string }>(
    '/bridge/characters/import', { method: 'POST', body: JSON.stringify({ dir, slug, includeDims, apply }) });

/* ================= 内置表情包（meme pack） =================
 * 磁盘约定（已冻结，不得更改）：一份 pack 即一个目录
 *   <包目录>/manifest.json + index.db(SQLite) + memes/<分类>/<文件名>.<ext>（webp/png/jpg/jpeg/gif）
 * 包来源：均由用户导入，即角色专属包与上传（后装）包两类；程序不再附带出厂表情包，
 * 故 <runtimeRoot>/meme/<包名>/ 这一出厂位置通常不存在，仅旧环境残留时出现，属兼容位置。
 * 三处存放位置均须识别（不存在者跳过，不报错）：
 *   ① <runtimeRoot>/meme/<包名>/                        出厂位置（兼容保留，当前不再随程序分发）
 *   ② <runtimeRoot>/meme-packs/<包名>/                  上传的包存放于此
 *   ③ <charactersDir>/<角色slug>/meme-packs/<包名>/      角色专属包
 * 后端：GET 列表 / POST 上传（zip 或文件夹，base64-in-JSON）/ POST 删除 / POST 角色绑定。
 * 「这三个接口不使用 api() 的原因」api() 遇非 2xx 直接抛出，而后端失败时会在响应体带回中文原因
 * （"一个图片都没有"、"规整脚本退出码 1"、"没找到可删除的包"等），该原因须呈现给用户，
 * 故下列接口改用 apiSoft() 原样取回 body，由界面自行判断 success。 */
async function apiSoft<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...init });
  let body: any = null;
  try { body = await res.json(); } catch { /* 非 JSON（桥/后端没答上）就按 HTTP 状态报 */ }
  if (!body || typeof body !== 'object') throw new Error(`API ${path} -> HTTP ${res.status}`);
  return body as T;
}

/** 列表中的一个包（坏包同样会列出：`count=null`，原因写在 `broken`） */
export interface MemePackEntry {
  id: string;
/** 包目录的绝对路径（界面悬停可见，便于直接定位文件） */
  dir: string;
/** 包来源：`factory` = 出厂位置（兼容保留，当前发行版不含）；`global` = 用户上传的包；`character` = 角色专属包 */
  source: 'factory' | 'global' | 'character';
/** 角色专属包的归属角色；其它包为 null */
  character: string | null;
/** index.db 里真读出来的张数；坏包为 null */
  count: number | null;
  tags: string[];
/** 磁盘上真实存在的图片文件数（与 count 不一致 = 表/盘漂移） */
  imageCount: number;
  manifest?: Record<string, any> | null;
  mtimeMs?: number;
/** 坏包原因（index.db 缺失/为空/读不了）；有它时 count 一定是 null */
  broken?: string;
}
export interface MemePackListResp {
  success: boolean;
/** 三处根目录（不存在的不列） */
  dirs?: { global?: string[]; packs?: string[]; characters?: string[] };
  packs?: MemePackEntry[];
/** 角色 ↔ 包绑定（读的是桥 config.json 的 social.meme.personaPacks） */
  bindings?: Record<string, string[]>;
  message?: string;
}
export interface MemePackUploadReport {
/** 收到的条目数（zip 里被跳过的目录项不算） */
  received: number;
/** 校验通过、真的写进包里的图片张数 */
  images: number;
/** 被跳过的非图片文件数（含 __MACOSX/、.DS_Store、Thumbs.db） */
  skipped: number;
/** 被跳过的文件名（最多前 20 个） */
  skippedNames: string[];
/** 还有多少个跳过项没列出来 */
  skippedMore?: number;
/** 同名同内容、被规整脚本挪进 .dedup/ 的重复张数 */
  deduped: number;
/** 覆盖同名旧包时，旧包改名后的名字（空 = 原来没有同名包） */
  backup: string;
/** 规整脚本（qq-bridge/tools/relayout-meme-pack.mjs）的原始输出 */
  relayoutOutput: string;
}
export interface MemePackUploadResp {
  success: boolean;
  packId?: string;
  dir?: string;
/** 落盘后真读 index.db 得到的张数 */
  count?: number;
  tags?: string[];
  report?: MemePackUploadReport;
/** 重启本机桥的结果（skipped=true 表示没重启，message 里写了为什么）；重启失败不算上传失败 */
  restart?: { ok?: boolean; skipped?: boolean; message?: string };
/** 规整脚本没跑通时：收到的图片留在临时目录里没动 */
  keptTemp?: boolean;
  tempDir?: string;
  message?: string;
}
export const memePacks = () => apiSoft<MemePackListResp>('/bridge/meme-packs');
/** 上传一个包：files（文件夹，path 用 webkitRelativePath）或 zip 二选一；留空 packId 则由目录名/zip 名推导 */
export const memePackUpload = (payload: {
  packId?: string;
  character?: string;
  files?: Array<{ path: string; data: string }>;
  zip?: { name: string; data: string };
}) => apiSoft<MemePackUploadResp>('/bridge/meme-packs/upload', { method: 'POST', body: JSON.stringify(payload) });
/** 删包（仅删上传包与角色包；出厂位置中的包会被拒绝，返回 success:false 与中文原因） */
export const memePackDelete = (id: string) =>
  apiSoft<{ success: boolean; id?: string; source?: string; character?: string | null; trash?: string; message?: string; restart?: { ok?: boolean; skipped?: boolean; message?: string } }>(
    '/bridge/meme-packs/delete', { method: 'POST', body: JSON.stringify({ id }) });
/** 角色 ↔ 包绑定（写进桥 config.json 的 social.meme.personaPacks；空数组 = 解绑） */
export const memePackBind = (character: string, packs: string[]) =>
  apiSoft<{ success: boolean; character?: string; packs?: string[]; path?: string; backup?: string; unknown?: string[]; localOnly?: boolean; message?: string }>(
    '/bridge/meme-packs/bind', { method: 'POST', body: JSON.stringify({ character, packs }) });

/* 某人最近发送的消息（画像档案的历史消息） */
export interface PersonMsg { conv: string; sender: string; content: string; kind: string; ts: string; tsMs: number; }
export const getPersonMessages = (uid: string, limit = 20) =>
  api<{ ok: boolean; uid: string; messages: PersonMsg[]; message?: string }>(`/learning/messages?uid=${encodeURIComponent(uid)}&limit=${limit}`);

/* 关系标注(线颜色) */
export const getRelations = () => api<{ ok: boolean; relations: Record<string, string> }>('/learning/relations');
export const saveRelation = (a: string, b: string, category: string) =>
  api<{ ok: boolean; relations: Record<string, string>; message?: string }>('/learning/relations', { method: 'PUT', body: JSON.stringify({ a, b, category }) });

export interface PortraitCfg { enabled: boolean; intervalDays: number; lastAt: number; ok?: boolean; }
export const getPortraitCfg = () => api<PortraitCfg>('/learning/portrait-config');
export const savePortraitCfg = (cfg: { enabled: boolean; intervalDays: number }) =>
  api<PortraitCfg>('/learning/portrait-config', { method: 'PUT', body: JSON.stringify(cfg) });

/* 群列表 + 群成员 */
export interface GroupMember { uid: string; name: string; count: number; last: number; }
export interface GroupInfo { id: string; members: GroupMember[]; }
export const getLearningGroups = () =>
  api<{ ok: boolean; groups: GroupInfo[]; message?: string }>('/learning/groups');

/* ================= 桥接人设 / 发言规则双卡（manager 读写 qq-bridge/*.md） ================= */
/** 本机桥配置（`qq-bridge/config.json` 本体，键 CFG_BRIDGE_LOCAL）。
 *  「只缓存 `r.config`」：页面（BridgeConfig）取用的就是这一层；把人设/发言规则等同页面的其它字段
 *  一起塞进缓存会与该键的既有形状不符。失败（无 config）时不写，保留上一次真实读到的那份。 */
export const getBridgeConfig = async () => {
  const r = await api<BridgeResp>('/bridge/config');
  try {
    const c = (r as any)?.config;
    if (c && typeof c === 'object') rememberConfig(CFG_BRIDGE_LOCAL, c);
  } catch { /* 忽略 */ }
  return r;
};
/** 写本机桥配置。同 postConfig/saveRemoteBridgeConfig：脱敏副本起底期间，
 *  把"值未知且为空"的凭证字段（napcat.accessToken / wsAccessToken / pixiv.refreshToken /
 *  dsh.visionApiKey 等）从提交体里删掉 —— 后端 POST /api/bridge/config 是深合并，缺键即保留原值。 */
export const saveBridgeConfig = (body: Record<string, any>) => {
  try { dropUnknownSecrets(CFG_BRIDGE_LOCAL, body); } catch { /* 忽略 */ }
  return api<BridgeResp>('/bridge/config', { method: 'POST', body: JSON.stringify(body) });
};
export const resetSpeechRules = () => api<BridgeResp>('/bridge/speech-reset', { method: 'POST' });
/* 工具 schema 压缩档的实测统计（桥在注册工具时测量，用于显示当前档位实际节省量） */
export interface ToolSchemaTierStat {
  label: string; note: string; share: number; keptChars: number; keptCount: number;
  /* 2026-09-22该档位被裁掉的具体工具（名称 + 所占字符数，按体积由大到小排列）：
   * 界面直接列出明细，不再只给出百分比，以免读者自行推断。 */
  droppedCount?: number; droppedChars?: number;
  dropped?: Array<{ n: string; c: number }>;
}
export interface ToolSchemaStats {
  ok: boolean; message?: string; at?: number; level?: string; enabled?: boolean; source?: string;
  registered?: number; available?: number; totalChars?: number; keptChars?: number; share?: number;
  savedChars?: number; approxTokensPerStep?: number;
  tiers?: Record<string, ToolSchemaTierStat>;
/** 描述压缩档（2026-09-21）：与"名单档位"正交，压的是描述文字，工具一个不少 */
  schemaLevel?: string;
  schemaLevelInfo?: Record<string, { label: string; note: string }>;
  top?: Array<{ name: string; cost: number }>;
}
export const getToolSchemaStats = () => api<ToolSchemaStats>('/bridge/tool-schema-stats');
/* 「上下文治理」：智能推荐所用的固定开销实测值（system 提示词 + 工具 schema 的 token）。
 * 来源：隔离 DSH 自身 token-meter 对最后一次 `request/header` 计价得到的
 * `contextBreakdown`（含 systemTokens / toolsTokens / messageTokens）与 `contextPressure`
 * （含 contextWindow），落盘于 <隔离 DSH home>/storages/session_projcache/sessions/session-*.json。
 * 服务端接口：server/index.js 的 GET /api/bridge/context-overhead（只读，缓存 30 秒）。 */
export interface ContextOverhead {
  ok: boolean; message?: string;
  file?: string; sessionId?: string; at?: number;
/** system 提示词的实测 token */
  systemTokens?: number;
/** 工具 schema 的实测 token */
  toolsTokens?: number;
/** 固定开销 = systemTokens + toolsTokens（每一步都要重发的那部分） */
  fixedTokens?: number;
/** 会话正文（聊天历史）的 token，随对话增长 */
  messageTokens?: number;
/** 这次会话用的模型窗口（token），推荐公式要用它 */
  contextWindow?: number;
  surfaceTokens?: number;
}
export const getContextOverhead = () => api<ContextOverhead>('/bridge/context-overhead');
/* 记忆架构（v1.3.0）总览：分层 + 全文索引（只读 memory.db） */
export interface MemoryStats {
  ok: boolean; message?: string;
  profiles?: number; entries?: number; chat?: number; permanent?: number;
  tiers?: Array<{ tier: string; count: number }>;
  fts?: Record<string, number>;
  ftsVersion?: string; ftsRebuiltAt?: number;
  top?: Array<{ id: number; uid: string; category: string; content: string; tier: string }>;
}
export const getMemoryStats = () => api<MemoryStats>('/bridge/memory-stats');

/* ================= 群聊活跃时段（按会话存，走桥控制台；本机/服务端两种 scope） ================= */
export interface ActivityHoursRow { key: string; windows: string; inWindow?: boolean; nextWindowStart?: string; ok: boolean; error?: string }
export const getActivityHours = (keys: string[], opts?: { scope?: 'local' | 'remote'; serverId?: string }) =>
  api<{ ok: boolean; rows: ActivityHoursRow[]; message?: string }>(
    `/bridge/activity-hours?keys=${encodeURIComponent(keys.join(','))}`
    + (opts?.scope ? `&scope=${opts.scope}` : '')
    + (opts?.serverId ? `&serverId=${encodeURIComponent(opts.serverId)}` : ''),
  );
export const saveActivityHours = (changes: Array<{ key: string; windows: string | Array<{ start: string; end: string }> }>, opts?: { scope?: 'local' | 'remote'; serverId?: string }) =>
  api<{ ok: boolean; results: Array<{ key: string; ok: boolean; windows?: string; error?: string }>; message?: string }>(
    '/bridge/activity-hours',
    { method: 'POST', body: JSON.stringify({ changes, ...(opts ?? {}) }) },
  );

/** 活跃时段「可选对象清单」群号/QQ 由桥的运行态枚举出来（不写死在管理端），带群名与当前状态 */
export interface ActivityTarget {
  key: string; kind: 'group' | 'private'; id: string; name: string;
  inAllowList: boolean; windows: string; inWindow: boolean; nextWindowStart: string;
  unread: number; wakeMode: string; allowed: boolean;
}
export const getActivityTargets = (opts?: { scope?: 'local' | 'remote'; serverId?: string }) =>
  api<{ ok: boolean; targets: ActivityTarget[]; deepsleep?: boolean; deepsleepGroups?: string[]; allowGroups?: string[]; message?: string }>(
    '/bridge/activity-targets'
    + (opts?.scope ? `?scope=${opts.scope}` : '')
    + (opts?.serverId ? `${opts?.scope ? '&' : '?'}serverId=${encodeURIComponent(opts.serverId)}` : ''),
  );

/** 用量对账：让本机/服务端桥各自与 DSH 会话级权威计数比对，补上被漏记的 usage 帧（幂等） */
export interface TokenReconcileResp {
  ok: boolean; at: number;
  local: { ok?: boolean; result?: { added?: number; addedTokens?: number; reason?: string } } | null;
  remote: { ok?: boolean; result?: { added?: number; addedTokens?: number; reason?: string } } | null;
  localReason?: string; remoteReason?: string;
}
export const reconcileTokens = () =>
  api<TokenReconcileResp>('/learning/token-reconcile', { method: 'POST', body: '{}' });

/* ================= 桥代码同步 / 整套移除（SSH 服务器） ================= */
export interface SyncStepsResp {
  success: boolean;
  steps?: Array<{ step: string; ok: boolean; msg?: string }>;
  message?: string;
/** /ssh/stack 专用：动作执行完毕后的服务端现场状态（后端已同时清除状态缓存） */
  status?: { ok?: boolean; dsh?: { running?: boolean }; napcat?: { running?: boolean }; bridge?: { running?: boolean }; [k: string]: unknown } | null;
}
/** 同步方向：to-server = 本地→远端 `/root/qq-bridge`；to-local = 远端→本地（覆盖）；merge = 两端 state 数据双向合并 */
export interface SyncFlags { code?: boolean; state?: boolean; stickers?: boolean; config?: boolean }
export const syncBridge = (server: Record<string, unknown>, direction: 'to-server' | 'to-local' | 'merge' = 'to-server', includeState = false, flags?: SyncFlags) =>
  api<SyncStepsResp>('/ssh/sync', { method: 'POST', body: JSON.stringify({ server, direction, includeState, flags }) });
/** 彻底删除远端整套（桥 + DSH + NapCat + 代理），目录移入回收目录备份 */
export const removeServerStack = (server: Record<string, unknown>) =>
  api<SyncStepsResp>('/ssh/remove-stack', { method: 'POST', body: JSON.stringify({ server, confirm: 'remove-stack' }) });

/** 远端整套的启停（服务器卡片上的「启动Bot / 终止Bot」）。
 *  启动顺序为 DSH → NapCat → 桥；终止取反序，先断桥，避免桥连着一个已被停止的 NapCat。 */
export const remoteStack = (server: Record<string, unknown>, action: 'start' | 'stop') =>
  api<SyncStepsResp>('/ssh/stack', { method: 'POST', body: JSON.stringify({ server, action }) });

/** 同上，但按 `serverId` 调用（首页仅有 id/name/host，无须把凭据发到前端再回传）。 */
export const remoteStackById = (serverId: string, action: 'start' | 'stop') =>
  api<SyncStepsResp>('/ssh/stack', { method: 'POST', body: JSON.stringify({ serverId, action }) });

/* ================= owner QQ（首次启动引导：未配置时弹窗一次） =================
 * 契约（后端已实现；管理端只读写这一项，不涉及其它配置）：
 *   GET  /api/bridge/owner-qq → { ok:true, ownerQQ:'', source:'bridge-config'|'env'|'none', configPath:'...' }
 *   POST /api/bridge/owner-qq body { ownerQQ } → { ok:true, ownerQQ, configPath }
 *        非法（非纯数字正整数 / 超过 12 位）→ { ok:false, error:'...' }（中文原因）
 * 「使用 apiSoft 而非 api() 的原因」api() 遇非 2xx 直接抛出，只剩一句 HTTP 状态；
 * 而后端的失败原因（"owner QQ 必须是纯数字"）位于响应体内，弹窗须将其原样显示。
 * 注意：ownerQQ 为空并非失败（`source:'none'` 表示尚未配置），调用方须按字段判断，不可用 !ok 判断。 */
export interface OwnerQQResp {
  ok: boolean;
  ownerQQ?: string;
/** 取值来源：bridge-config = 桥 config.json 已有；env = 环境变量；none = 尚未配置 */
  source?: 'bridge-config' | 'env' | 'none';
  configPath?: string;
  error?: string;
}
export const getOwnerQQ = () => apiSoft<OwnerQQResp>('/bridge/owner-qq');
export const setOwnerQQ = (ownerQQ: string) =>
  apiSoft<OwnerQQResp>('/bridge/owner-qq', { method: 'POST', body: JSON.stringify({ ownerQQ }) });

/* ================= 聊天记录（查 / 删各群聊与私聊的历史消息） =================
 * 契约（后端已实现；前端严格按这份形状对接，不改路径与字段名）：
 *   GET  /bridge/chat-stats?scope=local|remote&serverId=
 *        → { ok:true, scope, dbPath, counters:{ total, privateTotal, groupTotal, sentTotal,
 *            receivedTotal, todaySent, todayTotal, convTotal, groupConvs, privateConvs },
 *            usage:{ totalTokens, messages, avgTokensPerMessage, sinceDays, ledgerPath, note? } }
 *   GET  /bridge/chat-convs?scope=&serverId=&kind=all|group|private&limit=200
 *        → { ok:true, scope, convs:[{ key, kind:'group'|'private', name, count, sent, received, lastTs, lastText }] }
 *   GET  /bridge/chat-messages?scope=&serverId=&key=group:123456&limit=50&offset=0&query=&direction=all|in|out
 *        → { ok:true, key, total, count, messages:[{ id, ts, sender, senderUid, isSelf, kind, content, recalled }] }
 *   POST /bridge/chat-delete body { scope, serverId, confirm:true, key?, ids?, beforeMs?, all? }
 *        → { ok:true, deleted, mode }；失败 → { ok:false, message }
 *
 * 「为什么这几个接口用 apiSoft 而不是 api()」api() 遇非 2xx 直接抛出，调用方只剩一句
 * `HTTP 4xx`，而真实的失败原因（remote 未带 serverId、服务端上桥的记忆库读不到…）在响应体
 * 的 message 里；删除又属于不可恢复的危险操作，失败原因必须原样呈现给用户。
 * 故走 apiSoft 原样取回 body，由页面按 ok / message 判断（与 /bridge/meme-packs 同一取舍）。
 *
 * counters / usage / convs / messages 一律声明为可选：失败回包不带它们，页面按缺省值兜底，
 * 不会因为后端只回 `{ok:false,message}` 就把界面打崩。 */
export type ChatScope = 'local' | 'remote';
/** 消息方向：all=双向、in=收到的、out=本人发出的 */
export type ChatDirection = 'all' | 'in' | 'out';
/** 会话类型：group=群聊、private=私聊 */
export type ChatConvKind = 'group' | 'private';

export interface ChatCounters {
/** 库内消息总数（收+发） */
  total: number;
  privateTotal: number;
  groupTotal: number;
/** 本人（owner）发出的条数 */
  sentTotal: number;
  receivedTotal: number;
/** 今日发出 / 今日总量 */
  todaySent: number;
  todayTotal: number;
/** 会话数（群聊 + 私聊） */
  convTotal: number;
  groupConvs: number;
  privateConvs: number;
}
export interface ChatUsage {
  totalTokens: number;
  messages: number;
/** 平均每条消息 token 消耗；无台账记录时为 0，界面显示「—」并把 note 写在小字里 */
  avgTokensPerMessage: number;
/** 统计口径：最近多少天 */
  sinceDays: number;
/** token 台账文件路径（小字里展示，便于直接定位） */
  ledgerPath: string;
/** 进分子的账本行数（只算带 convKey 的会话轮次；老后端不返回时按未提供处理） */
  ledgerLines?: number;
/** 与会话无关、未计入平均的内部任务轮次（黑话学习/群友画像等），单独报出以便对账 */
  excludedLines?: number;
  excludedTokens?: number;
/** 后端对口径的补充说明（可选） */
  note?: string;
}
export interface ChatStatsResp {
  ok: boolean;
  scope?: string;
/** 本次读的是哪一份记忆库（界面小字里原样展示） */
  dbPath?: string;
  counters?: ChatCounters;
  usage?: ChatUsage;
  message?: string;
}
export interface ChatConv {
/** 会话键，形如 `group:123456` / `private:10001`；也是删除时的 key 参数 */
  key: string;
  kind: ChatConvKind;
/** 群名或 QQ 号（后端已解析；拿不到时可能是空串，界面回落显示 key） */
  name: string;
  count: number;
  sent: number;
  received: number;
/** 最后一条消息时间戳(ms) */
  lastTs: number;
/** 最后一条消息摘要 */
  lastText: string;
}
export interface ChatConvsResp {
  ok: boolean;
  scope?: string;
  convs?: ChatConv[];
  message?: string;
}
export interface ChatMessage {
/** 记忆库主键；删除选中时按它组 ids（没有 id 的条目界面会禁用勾选框） */
  id: string;
  ts: number;
  sender: string;
  senderUid: string;
/** 是否本人（owner）发出 —— 界面上的 `me` 标记 */
  isSelf: boolean;
  kind: string;
  content: string;
  recalled: boolean;
}
export interface ChatMessagesResp {
  ok: boolean;
  key?: string;
/** 满足本次筛选（key + query + direction）的总条数，用于分页 */
  total?: number;
/** 本页实际返回条数 */
  count?: number;
  messages?: ChatMessage[];
  message?: string;
}
export interface ChatDeleteResp {
  ok: boolean;
/** 实际删除条数 */
  deleted?: number;
/** 后端本次走的删除模式（如 ids / all / before），原样回显便于核对 */
  mode?: string;
  message?: string;
}

/** 统计卡（三个数字）与口径说明。scope=remote 且未检测到活动服务器时不传 serverId，
 *  由后端返回原因，前端照实显示 —— 绝不写死服务器 id。 */
export const getChatStats = (opts?: { scope?: ChatScope; serverId?: string }) =>
  apiSoft<ChatStatsResp>('/bridge/chat-stats'
    + (opts?.scope ? `?scope=${opts.scope}` : '')
    + (opts?.serverId ? `${opts?.scope ? '&' : '?'}serverId=${encodeURIComponent(opts.serverId)}` : ''));

/** 会话列表（群聊 / 私聊）。limit 默认 200，够覆盖常见量级；kind=all 时两类一起返回。 */
export const getChatConvs = (opts?: { scope?: ChatScope; serverId?: string; kind?: 'all' | ChatConvKind; limit?: number }) =>
  apiSoft<ChatConvsResp>('/bridge/chat-convs'
    + `?scope=${opts?.scope ?? 'local'}`
    + (opts?.serverId ? `&serverId=${encodeURIComponent(opts.serverId)}` : '')
    + `&kind=${opts?.kind ?? 'all'}`
    + `&limit=${opts?.limit ?? 200}`);

/** 某会话的消息（分页 + 关键词 + 方向）。key 形如 `group:123456`，由会话列表给出。 */
export const getChatMessages = (opts: {
  key: string; scope?: ChatScope; serverId?: string;
  limit?: number; offset?: number; query?: string; direction?: ChatDirection;
}) =>
  apiSoft<ChatMessagesResp>('/bridge/chat-messages'
    + `?scope=${opts.scope ?? 'local'}`
    + (opts.serverId ? `&serverId=${encodeURIComponent(opts.serverId)}` : '')
    + `&key=${encodeURIComponent(opts.key)}`
    + `&limit=${opts.limit ?? 50}`
    + `&offset=${opts.offset ?? 0}`
    + `&query=${encodeURIComponent(opts.query ?? '')}`
    + `&direction=${opts.direction ?? 'all'}`);

/** 删除聊天记录（不可恢复）。三选一的定位方式：ids=选中若干条、key+all=整个会话、key+beforeMs=X 天前。
 *  `confirm:true` 由本函数统一带上（后端的最终保险），界面侧仍会先弹一次二次确认。 */
export const deleteChatHistory = (body: {
  scope?: ChatScope; serverId?: string;
  key?: string; ids?: string[]; beforeMs?: number; all?: boolean;
}) =>
  apiSoft<ChatDeleteResp>('/bridge/chat-delete', { method: 'POST', body: JSON.stringify({ ...body, confirm: true }) });
