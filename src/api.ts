import type {
  ManagerState, ManagerConfig, OpenResult, InstanceActionResult, RemoteServerStatus,
} from './stores/types';

/** 与后端交互的轻量封装（走 Vite /api 代理，生产同源） */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) throw new Error(`API ${path} -> HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const getState = () => api<ManagerState>('/state');
/** 群友画像学习：action = start | stop | status；start 不带 qq 时由桥侧按配置自动筛活跃群成员 */
export const portraitAction = (action: 'start' | 'stop' | 'status', qq?: string[]) =>
  api<any>('/learning/portrait', { method: 'POST', body: JSON.stringify({ action, ...(qq && qq.length ? { qq } : {}) }) });
export const getConfig = () => api<ManagerConfig>('/config');

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

export const postConfig = (patch: Record<string, unknown>) =>
  api<{ success: boolean }>('/config', { method: 'POST', body: JSON.stringify(patch) });

/* ================= 一键克隆部署(把模板服务器整套部署到新服务器) ================= */
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
/** 发起克隆: source/target 传服务器对象(未保存的新条目也能用)或已保存的 id；
 *  source 传 `{ local: true, name }` 表示**从本机复刻**（不需要模板服务器）。 */
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

export const getLearningConfig = () => api<BridgeResp>('/learning/config');
export const saveLearningConfig = (cfg: LearningConfig) =>
  api<BridgeResp>('/learning/config', { method: 'POST', body: JSON.stringify(cfg) });
export const slangAction = (action: 'learn' | 'stop') =>
  api<BridgeResp>('/learning/slang', { method: 'POST', body: JSON.stringify({ action }) });
export const personaAction = (action: 'start' | 'stop' | 'status', qq?: string[]) =>
  api<BridgeResp>('/learning/persona', { method: 'POST', body: JSON.stringify(qq?.length ? { action, qq } : { action }) });
/** 人格学习：**审批 / 修正**学到的英文人设正文（personaEn）。
 *  mode='save'  → 把 text 作为修正后的正文写回该 uid 的库记录（机器人人设不动）；
 *  mode='apply' → 把 text（不传则用库里的 personaEn）覆盖写入桥的 qq-bridge/persona.md，
 *                 桥侧覆盖前自动备份旧人设（persona.md.bak-<日期-时间>，最多留 5 份），下一条消息起生效。
 *  返回 save: { ok, uid, savedChars }；apply: { ok, uid, bytes, backup }；失败 { ok:false, error }（中文）。 */
export const personaApply = (uid: string, mode: 'save' | 'apply' | 'fuse', text?: string) =>
  api<BridgeResp>('/learning/persona-apply', {
    method: 'POST',
    body: JSON.stringify(text === undefined ? { uid, mode } : { uid, mode, text }),
  });

/* ================= NapCat 鉴权令牌（WebUI / HTTP / WS） =================
 * 之前管理端改「NapCat 令牌」只改了桥 config.json 里"期望用哪个"，没写进 NapCat 自己的配置，
 * 于是旧令牌（默认 truefriend）照样能进、桥却用新令牌连不上。现在这两个接口是真正落地的那个：
 *   GET  /api/napcat/tokens → NapCat 磁盘现状 + 桥配置期望值（都只回掩码）
 *   POST /api/napcat/tokens → 写进 NapCat 的 webui.json / onebot11*.json + 重启容器 + 复验新/旧令牌
 * 请求体：{ webuiToken?, httpToken?, wsToken?, restart?, useBridgeTokens? }
 *   useBridgeTokens=true → 不填令牌，直接用**桥配置里现有的** HTTP/WS 令牌去写 NapCat
 *   （WebUI 令牌没单独填时也用它）：语义是"让三处一致成桥里那个令牌"。 */
export const getNapcatTokens = () => api<any>('/napcat/tokens');
export const applyNapcatTokens = (patch: { webuiToken?: string; httpToken?: string; wsToken?: string; restart?: boolean; useBridgeTokens?: boolean }) =>
  api<any>('/napcat/tokens', { method: 'POST', body: JSON.stringify(patch) });

/* ================= NapCat 会话守护（探针 + 假死自愈） =================
 * 【2026-09-16】QQ 服务端把登录态作废时客户端可能**一条错都不报**（WebUI 上还是 isLogin/online=true），
 * 实测静默了 50 分钟没人知道。桥侧现在每 60 秒用 NapCat 的 get_rkey 探活，连续失败就重启容器自愈；
 * 这几个接口就是把它的状态读出来、把两个开关写回去、手动触发一次自愈、配置"免扫码回退登录"，
 * 以及在它已经掉登录态时把二维码现抓出来给人扫（那种情况重启救不了）。
 *   GET  /api/napcat/guard           → { ok, guard }
 *   POST /api/napcat/guard           → body { autoHeal?, enabled? } → { ok, guard }
 *   POST /api/napcat/guard/heal      → { ok, healed, detail, waitedMs }（自愈要重启+等登录，可能一两分钟）
 *   POST /api/napcat/quick-password  → body { password }（明文只随请求发送，桥侧只算 md5 写容器环境变量）
 *   GET  /api/napcat/qr              → { ok, path, bytes, dataUrl }（掉登录态时给人扫的那张码）
 * 鉴权：走管理端代理（它自己带 x-console-token），前端不接触桥的控制台令牌。 */
export type NapcatGuardAlertLevel = 'failed' | 'cooldown' | 'giveup' | 'manual' | 'needs-login';
export interface NapcatGuardAlert {
  ts?: string;
  level?: NapcatGuardAlertLevel;
  reason?: string;
  qrPath?: string | null;
}
export interface NapcatGuard {
  /** 桥侧守护总开关（关掉则完全不再探活） */
  enabled?: boolean;
  /** 自动自愈开关（POST 写的就是它） */
  autoHeal?: boolean;
  /** 这个开关是配置给的还是人手动设的（桥侧回传，界面不依赖它） */
  autoHealSource?: 'auto' | 'manual';
  /** ok | suspect | dead（另有 disabled=守护关闭、unknown=还没探过） */
  verdict?: string;
  lastProbeAt?: number;
  lastProbeOk?: boolean;
  lastProbeDetail?: string;
  consecutiveFails?: number;
  failThreshold?: number;
  probeIntervalMs?: number;
  /** 最近自愈时间戳（最多 20 条） */
  heals?: number[];
  lastHealAt?: number;
  /** "" | success | failed | cooldown | giveup | manual */
  lastHealResult?: string;
  alert?: NapcatGuardAlert | null;
  /** 免扫码回退登录是否已配置（只回 configured/source，不回值本身） */
  passwordFallback?: { configured?: boolean; source?: string; error?: string };
  container?: { name?: string; status?: string; startedAt?: string };
}
export const getNapcatGuard = () => api<{ ok: boolean; guard?: NapcatGuard; error?: string; message?: string }>('/napcat/guard');
export const setNapcatGuard = (patch: { autoHeal?: boolean; enabled?: boolean }) =>
  api<{ ok: boolean; guard?: NapcatGuard; error?: string; message?: string }>('/napcat/guard', { method: 'POST', body: JSON.stringify(patch) });
/** 手动自愈：忽略冷却与开关，直接重启容器并等登录（可能一两分钟，期间 NapCat 不可用） */
export const healNapcatGuard = () =>
  api<{ ok: boolean; healed?: boolean; detail?: string; waitedMs?: number; guard?: NapcatGuard; error?: string; message?: string }>(
    '/napcat/guard/heal', { method: 'POST', body: '{}' });
/** 免扫码回退登录：桥侧只把密码算成 md5 写进容器环境变量（明文不落盘、不进日志），过程会重建容器。
 *  【安全约定】密码只随这一条请求发送 —— 不写日志、不进 localStorage、不落任何本地文件。 */
export const applyNapcatQuickPassword = (password: string) =>
  api<{ ok: boolean; detail?: string; loginState?: { isLogin?: boolean; online?: boolean }; error?: string; message?: string }>(
    '/napcat/quick-password', { method: 'POST', body: JSON.stringify({ password }) });

/* 【2026-09-16 补充契约】二维码现抓：alert.level='needs-login'（QQ 已掉登录态，重启救不了）时，
 * 人必须扫码 —— 而人往往不在服务器边上，所以把容器里的缓存二维码 docker cp 出来转成 dataUrl 直接显示。
 *   GET /api/napcat/qr → { ok, path, bytes, dataUrl } / 失败 { ok:false, error }（没在等登录、docker cp 失败…）
 * NapCat 会定期换新码，所以界面上要给「重新获取二维码」重新打这一条（不要缓存）。 */
export interface NapcatQrSnapshot {
  ok: boolean;
  path?: string;
  bytes?: number;
  /** data:image/png;base64,... —— 直接塞给 <img src> */
  dataUrl?: string;
  error?: string;
}
export const getNapcatQr = () => api<NapcatQrSnapshot>('/napcat/qr');
/** 【2026-09-14】用量统计现在**两边都取**：local=本机桥、remote=服务端桥（null=没取到，看 remoteReason）、
 *  total=两份合并的合计。report 保留为合计（兼容旧字段）。 */
export interface TokenReportSide {
  dates?: Array<Record<string, any>>;
  todayHourly?: Array<Record<string, any>>;
  today?: Record<string, number>;
  todayEstimatedTotal?: number;
  dayWindow?: Record<string, any>;
  note?: string;
  [k: string]: any;
}
export interface TokenReportResp {
  ok: boolean;
  at?: number;
  mode?: 'local' | 'ssh';
  /** 本机桥那份（取不到时 null，原因在 localReason） */
  local: TokenReportSide | null;
  /** 服务端桥那份（取不到时 null，原因在 remoteReason） */
  remote: TokenReportSide | null;
  /** 两份合并的合计 */
  total: TokenReportSide | null;
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
export const getRemoteBridgeConfig = (serverId?: string) =>
  api<RemoteBridgeConfigResp>(`/ssh/bridge-config${serverId ? '?serverId=' + encodeURIComponent(serverId) : ''}`);
/** 写服务端配置：后端会「临时文件 → 备份 config.json.bak-<时间戳> → mv 原子替换 → 回读比对关键字段」 */
export const saveRemoteBridgeConfig = (body: Record<string, any>) =>
  api<RemoteBridgeConfigResp>('/ssh/bridge-config', { method: 'POST', body: JSON.stringify(body) });

/** 【2026-09-14】按组件启停**服务器上**的组件（连上服务器后首页那三张卡的按钮走这条路，
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

/* ================= 群友画像 / 主人画像（manager 直读本机桥 memory.db，无需桥在线） ================= */
export type GraphNodeKind = 'owner' | 'friend' | 'member';
/** 群内角色：owner=群主、admin=管理员、member=普通群成员。
 *  由后端 /api/learning/graph 每个 node 新增；注意它与 kind 不是一回事
 *  （kind='owner' 是"主人自己"，role='owner' 是"群主"）。老后端没有这个字段时为 null/undefined，
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
  } | null;
  /** profile 字段切出的标签 */
  profileTags?: string[];
  /** 近 30 天记忆词频 [{w,c}] */
  memoryTop?: Array<{ w: string; c: number }>;
  /** persona-library[owner] 摘要 */
  persona?: {
    nickname?: string | null;
    personality?: string | null;
    chatHabits?: string | null;
    relationshipAdvice?: string | null;
    topics?: string[];
    samples?: number;
    learnedAtMs?: number;
  } | null;
  msgCount30d?: number;
  lastSeenAt?: number | null;
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
  /** 研究会话明确确认（confirmed:true + 有含义 + risk 非 high）后桥侧**自动**转 confirmed 时打的标 */
  autoConfirmed?: boolean;
  confirmedAt?: string;
  updatedAt?: string;
  addedAt?: string;
  evidence?: Array<{ key?: string; sender?: string; text?: string; time?: number }>;
}
/** 黑话学习状态机的阶段（**桥侧已确认的契约，前端只做展示映射**）：
 *  disabled=学习开关关着 · extracting=正在批量提取+研究 · stopping=收到停止请求，等当前分块结束 ·
 *  queued=有排队任务 · researching=有候选正在研究会话里分析 · ready=学习会话在、当前空闲 ·
 *  idle=没有会话也没有任务 */
export type SlangLearnPhase = 'disabled' | 'extracting' | 'stopping' | 'queued' | 'researching' | 'ready' | 'idle';
/** 桥侧「学习状态机」快照：`GET /api/slang` 回包里的 `learning`（管理端 `GET /api/learning/slang-library` 即转发此条）。
 *  **老桥 / 接口失败时该字段可能是 null** —— 前端必须按"拿不到状态"降级显示，不能报错、也不能显示假状态。 */
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
/** 黑话库**批量审批 / 删除**（管理端同名路径转发到桥控制台，body 一律 `{ ids: string[] }`）：
 *   · batch-confirm：只对 **candidate 且 meaning 非空** 的条目生效，其余跳过并回
 *     `{ ok, confirmedCount, skippedCount, skipped:[{id,content?,reason}] }`。
 *     【2026-09-16】管理端「黑话库」弹窗**不再调它**：研究会话明确确认后桥侧会自动把候选转成 confirmed
 *     （slang.js 里 autoConfirmed 那段），人工批量通过是多余的，「批量通过」按钮已按主人要求删除。
 *     单个确认若要恢复，走的是桥侧 `POST /api/slang/:id/confirm`（管理端目前**没有**转发这条）。
 *   · batch-reject：`{ ok, rejectedCount }`（不再参与查询，可留档不删）。
 *   · research：只对候选生效（已确认/已拒收会被桥侧过滤掉）→ `{ ok, count }`。
 *   · batch-delete：**只按 ids 删** → `{ ok, removedCount }`；一条都匹配不到时桥回
 *     `404 { ok:false, error:'没有匹配到要删除的黑话' }`（前端必须给出提示，不能静默）。
 *     桥那条路由**还支持** `{ status:'confirmed' }` 整批删，但界面上**故意不暴露**这个口子
 *     （需求是"单条可删"）—— 所以这个函数只接受 ids，传不出 status。 */
export const slangBatchConfirm = (ids: string[]) =>
  api<BridgeResp>('/slang/batch-confirm', { method: 'POST', body: JSON.stringify({ ids }) });
export const slangBatchReject = (ids: string[]) =>
  api<BridgeResp>('/slang/batch-reject', { method: 'POST', body: JSON.stringify({ ids }) });
export const slangResearch = (ids: string[]) =>
  api<BridgeResp>('/slang/research', { method: 'POST', body: JSON.stringify({ ids }) });
/** 删黑话。**单条删除就传一个 id 的数组**（`[id]`）；界面上只走这条路，不按 status 整批删。 */
export const slangBatchDelete = (ids: string[]) =>
  api<BridgeResp>('/slang/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) });
/** 单人**完整**画像资料（直读 memory.db，不做截断） */
export const getPersonProfile = (uid: string) => api<any>(`/learning/profile?uid=${encodeURIComponent(uid)}`);
export const getOwnerProfile = () => api<OwnerProfileResp>('/learning/owner-profile');

/* ================= 角色库导入(characters 目录) ================= */
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

/* 某人最近发过的消息(画像档案历史消息) */
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
export const getBridgeConfig = () => api<BridgeResp>('/bridge/config');
export const saveBridgeConfig = (body: Record<string, any>) =>
  api<BridgeResp>('/bridge/config', { method: 'POST', body: JSON.stringify(body) });
export const resetSpeechRules = () => api<BridgeResp>('/bridge/speech-reset', { method: 'POST' });

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

/** 活跃时段「可选对象清单」：群号/QQ 由桥的运行态枚举出来（不写死在管理端），带群名与当前状态 */
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
  /** /ssh/stack 专用：动作**执行完之后**的服务端现场状态（后端已顺手清掉状态缓存） */
  status?: { ok?: boolean; dsh?: { running?: boolean }; napcat?: { running?: boolean }; bridge?: { running?: boolean }; [k: string]: unknown } | null;
}
/** 同步方向: to-server = 本地→远端 /root/qq-bridge; to-local = 远端→本地(覆盖); merge = 两端 state 数据双向合并 */
export interface SyncFlags { code?: boolean; state?: boolean; stickers?: boolean; config?: boolean }
export const syncBridge = (server: Record<string, unknown>, direction: 'to-server' | 'to-local' | 'merge' = 'to-server', includeState = false, flags?: SyncFlags) =>
  api<SyncStepsResp>('/ssh/sync', { method: 'POST', body: JSON.stringify({ server, direction, includeState, flags }) });
/** 彻底删除远端整套(桥+DSH+NapCat+代理), 目录移到回收目录备份 */
export const removeServerStack = (server: Record<string, unknown>) =>
  api<SyncStepsResp>('/ssh/remove-stack', { method: 'POST', body: JSON.stringify({ server, confirm: 'remove-stack' }) });

/** 远端整套的启停（服务器卡片上的「启动Bot / 终止Bot」）。
 *  启动顺序 DSH → NapCat → 桥；终止反序（先断桥，免得它连着一个已经消失的 NapCat）。 */
export const remoteStack = (server: Record<string, unknown>, action: 'start' | 'stop') =>
  api<SyncStepsResp>('/ssh/stack', { method: 'POST', body: JSON.stringify({ server, action }) });

/** 同上，但按 serverId 走（首页只有 id/name/host，不必把凭据发到前端再发回来）。 */
export const remoteStackById = (serverId: string, action: 'start' | 'stop') =>
  api<SyncStepsResp>('/ssh/stack', { method: 'POST', body: JSON.stringify({ serverId, action }) });
