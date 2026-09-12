// M5 口头可调配置
// cfg 为 main 持有的同一可变对象，经 setTunableCfg 注入（applyTunable 会直接改它并落盘 config.json）。
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../lib/log.js';
import { ROOT } from '../lib/paths.js';
import { cancelProactiveCheck, scheduleProactiveCheck, social } from './social-state.js';
import { resetVisionModelApplications } from './session-state.js';

let cfgObj = null;
export function setTunableCfg(cfg) { cfgObj = cfg; }

export const TUNABLE_SPECS = [
  { key: 'proactiveEnabled', path: ['social', 'proactive', 'enabled'], type: 'bool', label: '主动冒泡总开关', desc: 'false=关闭所有主动冒泡（群/私聊都不主动找人）；true=打开' },
  { key: 'groupProactiveMin', path: ['social', 'proactive', 'checkIntervalMinMs'], type: 'dur', min: 60000, max: 86400000, label: '群主动最短间隔', desc: '群聊两次主动机会之间的最短间隔（调小=更频繁）' },
  { key: 'groupProactiveMax', path: ['social', 'proactive', 'checkIntervalMaxMs'], type: 'dur', min: 60000, max: 86400000, label: '群主动最长间隔', desc: '群聊两次主动机会之间的最长间隔' },
  { key: 'groupProbability', path: ['social', 'proactive', 'probability'], type: 'float', min: 0, max: 1, label: '群主动概率', desc: '群聊每次机会实际开口概率，0~1（0.2≈五次机会开一次口）' },
  { key: 'privateProactiveMin', path: ['social', 'proactive', 'privateCheckIntervalMinMs'], type: 'dur', min: 60000, max: 86400000, label: '私聊主动最短间隔', desc: '私聊（含主人私聊）主动找人的最短间隔' },
  { key: 'privateProactiveMax', path: ['social', 'proactive', 'privateCheckIntervalMaxMs'], type: 'dur', min: 60000, max: 86400000, label: '私聊主动最长间隔', desc: '私聊（含主人私聊）主动找人的最长间隔' },
  { key: 'privateProbability', path: ['social', 'proactive', 'privateProbability'], type: 'float', min: 0, max: 1, label: '私聊主动概率', desc: '私聊主动开口概率（0=私聊从不主动找人）' },
  { key: 'idleThresholdMs', path: ['social', 'proactive', 'idleThresholdMs'], type: 'dur', min: 60000, max: 86400000, label: '冷场判定时长', desc: '对方多久没说话才算冷场，才可能主动开口' },
  { key: 'replyCheckMs', path: ['social', 'autoReplyCheckMs'], type: 'dur', min: 15000, max: 3600000, label: '回复检查间隔', desc: '回复后多久系统自动再检查一次是否漏回' },
  { key: 'dndWindows', path: ['social', 'dndWindows'], type: 'str', label: '免打扰时段', desc: '如 23:00-08:00 或 23:00-08:00,13:00-14:00;空=关闭。免打扰内不主动找话,但被@/私聊仍秒回' },
  { key: 'proactiveFreshOnly', path: ['social', 'proactive', 'freshContextOnly'], type: 'bool', label: '主动需有话题', desc: 'true=主动开口前需有新消息或近2h群友话题,避免凌晨空转(默认 true)' },
  // —— 发送线性节拍（学习规格「发消息线性延迟」，挂在 social.send.* 与发送限额同层）——
  // 同一会话连续投递的多条消息，间隔按 delay(n)=min(cap, base+n*step) 线性递增（n=已连续成功投递数，
  // 会话静默 >60s 归零）；首条 n=0 → base（默认 0=秒醒不延迟）。三条发送主路径 sendToQQ/sendBurstToQQ/sendMessages 统一内置。
  { key: 'sendLinearEnabled', path: ['social', 'send', 'linearEnabled'], type: 'bool', label: '发送线性节拍', desc: 'true=同一会话连续发送的多条消息投递间隔线性递增,首条即时;false=完全恢复旧节奏' },
  { key: 'sendLinearStep', path: ['social', 'send', 'linearStepMs'], type: 'dur', min: 100, max: 2000, label: '发送线性步进', desc: '连续发送时每条消息递增的间隔步长(默认 350ms):第2条约350、第3条约700,以此类推直到封顶' },
  { key: 'sendLinearCap', path: ['social', 'send', 'linearCapMs'], type: 'dur', min: 500, max: 10000, label: '发送线性封顶', desc: '线性间隔的最大值(默认 4000ms),超过后不再递增;也作为长文兜底下限的天花板' },
  { key: 'sendLinearBase', path: ['social', 'send', 'linearBaseMs'], type: 'dur', min: 0, max: 2000, label: '发送线性底延迟', desc: '每条线性间隔额外加的基础值(默认 0=首条不延迟,唤醒/首轮秒级即时);>0 时整体平移加 base' },
  // —— 模型相关（改完会同步给隔离 DSH 的 agent-default-model，见 applyTunable）——
  { key: 'modelProvider', path: ['dsh', 'provider'], type: 'str', modelGroup: true, label: '模型服务商', desc: 'deepseek-official=DeepSeek 官方（默认）；xiaomi-token-plan-cn=小米 MiMo；空=自动探测用 DSH 端默认' },
  { key: 'model', path: ['dsh', 'model'], type: 'str', modelGroup: true, label: '主模型', desc: '如 deepseek-v4-flash / deepseek-v4-flash-vision-exp / deepseek-v4-pro / mimo-v2.5；留空=DSH 默认' },
  { key: 'visionModel', path: ['dsh', 'visionModel'], type: 'str', modelGroup: true, label: '识图模型', desc: '留空=跟随主模型（默认多模态）' },
  { key: 'reasoningEffort', path: ['dsh', 'reasoningEffort'], type: 'str', modelGroup: true, label: '推理档位', desc: 'auto/low/medium/high；留空或 auto=自动探测' }
];

export function readCfgPath(arr) { let o = cfgObj; for (const k of arr) { if (o == null || typeof o !== 'object') return undefined; o = o[k]; } return o; }

export function writeCfgPath(arr, v) { let o = cfgObj; for (let i = 0; i < arr.length - 1; i++) { if (o[arr[i]] == null || typeof o[arr[i]] !== 'object') o[arr[i]] = {}; o = o[arr[i]]; } o[arr[arr.length - 1]] = v; }

export function parseTunableDur(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  let m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|min|h)?$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    const u = m[2];
    if (u === 'h') return Math.round(n * 3600000);
    if (u === 'm' || u === 'min') return Math.round(n * 60000);
    if (u === 's') return Math.round(n * 1000);
    return Math.round(n);
  }
  m = /^(\d+(?:\.\d+)?)\s*(分钟|分|小时|毫秒)$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    if (m[2] === '小时') return Math.round(n * 3600000);
    if (m[2] === '分钟' || m[2] === '分') return Math.round(n * 60000);
    return Math.round(n);
  }
  return null;
}

export function tunableListItems() { return TUNABLE_SPECS.map((s) => ({ key: s.key, label: s.label, type: s.type, value: readCfgPath(s.path), desc: s.desc })); }

export function findTunable(key) { return TUNABLE_SPECS.find((s) => s.key === String(key ?? '').trim()); }

export function applyTunable(spec, raw) {
  let v;
  if (spec.type === 'bool') {
    const s = String(raw ?? '').trim().toLowerCase();
    if (s === 'true' || s === 'on' || s === '1' || s === '开' || s === '打开') v = true;
    else if (s === 'false' || s === 'off' || s === '0' || s === '关' || s === '关闭') v = false;
    else throw new Error(`值应为 true/false（开/关），收到 "${raw}"`);
  } else if (spec.type === 'float') {
    v = Number(raw);
    if (!Number.isFinite(v)) throw new Error(`值应为数字（${spec.min}~${spec.max}），收到 "${raw}"`);
    v = Math.min(spec.max, Math.max(spec.min, v));
  } else if (spec.type === 'dur') {
    v = parseTunableDur(raw);
    if (v === null) throw new Error(`时长无法解析（支持毫秒数字、"30min"、"2h"、"30分钟"），收到 "${raw}"`);
    v = Math.min(spec.max, Math.max(spec.min, Math.round(v)));
  } else if (spec.type === 'str') {
    v = String(raw ?? '').trim();
    if (spec.modelGroup && spec.key === 'reasoningEffort' && v === 'auto') v = '';
  }
  writeCfgPath(spec.path, v);
  try { fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(cfgObj, null, 2)); } catch (e) { log('[tunable] 配置落盘失败:', e?.message ?? e); }
  // 模型相关：同步给隔离 DSH 的 agent-default-model（settings.yaml），并让已在用的会话立刻改用新模型
  if (spec.modelGroup) {
    try { syncDshAgentDefaultModel(); } catch (e) { log('[tunable] 同步 DSH 模型设置失败:', e?.message ?? e); }
    // 会话缓存：ensureVisionModel 每个会话只 selectModel 一次，不清缓存的话老会话会一直用旧模型。
    try { resetVisionModelApplications(); } catch (e) { log('[tunable] 重置会话模型缓存失败:', e?.message ?? e); }
  }
  return v;
}

/**
 * 解析隔离 DSH 的 home 目录。
 *
 * 【2026-09-12 修「管理端改的模型配置无法默认到 DSH 里」】这里原来**写死** `~/.qq-bridge-manager/dsh-isolated-home`，
 * 而管理器实际启用的隔离实例是 `dsh-isolated-home-official`（见管理器 config.json 的
 * `instances.dshIsolated.isolatedHome`，DSH 端口 10721 就是它）。于是模型改动全写进了那个**早就没人读的旧目录**，
 * DSH 侧当然毫无变化 —— 用户看到的就是"改了模型没生效"。
 * 现在按 环境变量 → 管理器 config.json → 常见默认目录（取真实存在 settings.yaml 的那个）依次探测。
 */
export function resolveIsolatedDshHome() {
  const base = process.env.USERPROFILE || process.env.HOME || '';
  const cands = [];
  for (const k of ['QQB_DSH_HOME', 'DSH_ISOLATED_HOME']) {
    const v = String(process.env[k] || '').trim();
    if (v) cands.push(v);
  }
  try {
    const mgr = path.join(base, '.qq-bridge-manager', 'config.json');
    if (fs.existsSync(mgr)) {
      const home = JSON.parse(fs.readFileSync(mgr, 'utf8'))?.instances?.dshIsolated?.isolatedHome;
      if (typeof home === 'string' && home.trim()) cands.push(home.trim());
    }
  } catch (e) { log('[tunable] 读管理器 config.json 失败:', e?.message ?? e); }
  cands.push(path.join(base, '.qq-bridge-manager', 'dsh-isolated-home-official'));
  cands.push(path.join(base, '.qq-bridge-manager', 'dsh-isolated-home'));
  for (const c of cands) { try { if (c && fs.existsSync(path.join(c, 'settings.yaml'))) return c; } catch {} }
  return cands[0] || '';
}

/** 把 cfg.dsh 的 provider/model/reasoningEffort 同步到隔离 DSH 的 settings.yaml（agent-default-model）。 */
export function syncDshAgentDefaultModel() {
  if (!cfgObj?.dsh) return { synced: false, reason: '未配置 dsh 段' };
  const home = resolveIsolatedDshHome();
  const sp = path.join(home, 'settings.yaml');
  if (!home || !fs.existsSync(sp)) { log('[tunable] 未找到隔离 DSH settings.yaml，跳过同步:', sp); return { synced: false, reason: 'settings.yaml 不存在: ' + sp }; }
  let s = fs.readFileSync(sp, 'utf8');
  const prov = String(cfgObj.dsh.provider || '').trim() || 'deepseek-official';
  const model = String(cfgObj.dsh.model || '').trim() || 'deepseek-v4-flash-vision-exp';
  const eff = String(cfgObj.dsh.reasoningEffort || '').trim();
  if (/agent-default-model:/.test(s)) {
    s = s.replace(/agent-default-model:[\s\S]*?(?=\n\S|\n$|$)/, 'agent-default-model:\n  provider: ' + prov + '\n  model: ' + model + (eff ? '\n  reasoningEffort: ' + eff : ''));
  } else {
    s += '\nagent-default-model:\n  provider: ' + prov + '\n  model: ' + model + (eff ? '\n  reasoningEffort: ' + eff : '') + '\n';
  }
  fs.writeFileSync(sp, s, 'utf8');
  // settings.yaml 只在 DSH 启动时读取；已在跑的会话由 ensureVisionModel(selectModel) 立刻切到新模型，
  // 故这里不重启 DSH（避免把正在进行的对话打断）。新会话/DSH 网页端要重启后才吃到新默认值。
  log('[tunable] 已同步隔离 DSH agent-default-model ->', prov + '/' + model + (eff ? '/' + eff : ''), '@', sp);
  return { synced: true, path: sp, provider: prov, model, effort: eff };
}

export function rearmProactiveTimersAfterChange() {
  for (const key of social.conversations.keys()) { try { cancelProactiveCheck(key); } catch {} }
  for (const key of social.conversations.keys()) { try { scheduleProactiveCheck(key); } catch (e) { log(`[tunable] 重排 proactive 失败 ${key}: ${e?.message ?? e}`); } }
}

export function tokenBelongsToOwner(tok) {
  if (!tok) return false;
  const ownerKey = 'private:' + String(cfgObj.ownerQQ);
  for (const [ck, cst] of social.conversations.entries()) {
    if (cst && cst.agentToken && tok === cst.agentToken) return ck === ownerKey;
  }
  return false;
}
