import type {
  ManagerState, ManagerConfig, OpenResult, InstanceActionResult,
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
export const getTokenReport = () => api<BridgeResp>('/learning/token-report');

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

export interface GraphNode {
  uid: string;
  name: string;
  kind: GraphNodeKind;
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
/** 黑话库（桥的 state/slang.json，经管理端代理） */
export const getSlangLibrary = () => api<any>('/learning/slang-library');
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

/* ================= 桥代码同步 / 整套移除（SSH 服务器） ================= */
export interface SyncStepsResp {
  success: boolean;
  steps?: Array<{ step: string; ok: boolean; msg?: string }>;
  message?: string;
}
/** 同步方向: to-server = 本地→远端 /root/qq-bridge; to-local = 远端→本地(覆盖); merge = 两端 state 数据双向合并 */
export interface SyncFlags { code?: boolean; state?: boolean; stickers?: boolean; config?: boolean }
export const syncBridge = (server: Record<string, unknown>, direction: 'to-server' | 'to-local' | 'merge' = 'to-server', includeState = false, flags?: SyncFlags) =>
  api<SyncStepsResp>('/ssh/sync', { method: 'POST', body: JSON.stringify({ server, direction, includeState, flags }) });
/** 彻底删除远端整套(桥+DSH+NapCat+代理), 目录移到回收目录备份 */
export const removeServerStack = (server: Record<string, unknown>) =>
  api<SyncStepsResp>('/ssh/remove-stack', { method: 'POST', body: JSON.stringify({ server, confirm: 'remove-stack' }) });
