// DSH 会话创建/视觉模型
// cfg 静态注入（initDshSessionCore），api 注入（setDshSessionApi），sessionEpoch 模块共享（bump 由 reset 用）。
import fs from 'node:fs';
import path from 'node:path';
import { unwrap } from '../dsh-client.js';
import { sleep } from '../lib/async.js';
import { log } from '../lib/log.js';
import { STATE_DIR } from '../lib/paths.js';
import { state, saveState } from './config.js';
import { modePreset, currentMode } from './mode.js';
import { reverse, sessionPromises, visionModelAppliedSessions } from './session-state.js';

export let sessionEpoch = 0;
/** reset/清空工作区时递增（主内 console 调用） */
export function bumpSessionEpoch() { sessionEpoch += 1; }

export let dshReady = false;
/** DSH 可用性开关（main 探活回调） */
export function setDshReady(v) { dshReady = v; }

let cfgRef = null;
let apiRef = null;
export function initDshSessionCore(cfg) { cfgRef = cfg; }
export function setDshSessionApi(api) { apiRef = api; }

/**
 * 【2026-09-12】让**已有会话**也重新套用一次模型配置。
 *
 * `ensureVisionModel()` 每个会话只跑一次（`visionModelAppliedSessions` 记住已套用的 sessionId），
 * 所以"在管理端改了 provider/model/reasoningEffort"之后，**老会话会一直用旧模型**——这正是"改了模型不生效"
 * 的另一半原因（另一半是运行中的桥根本不重读 config.json，见 core/config.js 的 watchConfigFile）。
 * 配置热加载时清掉这个集合，下一次 ensureSession 就会用新模型重新 selectModel。
 *
 * 实现放在 session-state.js（那个 Set 的归属模块），这里只做转发，避免两处各写一份。
 */
export { resetVisionModelApplications } from './session-state.js';

export async function ensureVisionModel(sessionId) {
  if (visionModelAppliedSessions.has(sessionId)) return;
  if (!cfgRef.dsh?.provider && !cfgRef.dsh?.model) return; // 未显式配置则用 DSH 默认（官方 deepseek）
  const provider = String(cfgRef.dsh?.provider || 'deepseek-official');
  const model = String(cfgRef.dsh?.visionModel || cfgRef.dsh?.model || 'deepseek-v4-flash-vision-exp');
  const configured = String(cfgRef.dsh?.reasoningEffort ?? '').trim();

  const selectWith = async (effort) => {
    const payload = { sessionId, provider, model };
    if (effort) payload.reasoningEffort = effort;   // 没配档位 = 连参数都不带（服务商默认档位）
    return unwrap(await apiRef.sessions.selectModel(payload), 'session.selectModel');
  };

  /* 档位计划：配了就按配置先试，被服务商**明确拒绝**时退回"不带档位"。
   *
   * 【2026-09-13 实测踩坑】pi-ai 只认 profile 里显式声明过的 `xhigh`/`max`：小米 MiMo（mimo-v2.5）
   * 的 settings.yaml 没声明 reasoningEfforts，传 max 直接 UNSUPPORTED_REASONING_EFFORT。
   * 原来这里把"没配档位"当成 `max`，于是 selectModel 一直失败 → **会话模型永远切不过去**，
   * 整条会话卡在旧模型（deepseek-official + mimo-v2.5 这种错配）上，之后每一轮都在网关报
   * "The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed mimo-v2.5" / 400。
   * 所以：空档位不带参数，档位不被支持就退回默认，而不是死磕。 */
  const plan = configured ? [configured, ''] : [''];
  for (const effort of plan) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await selectWith(effort);
        visionModelAppliedSessions.add(sessionId);
        if (!effort && configured) log(`档位 ${configured} 不被 ${provider}/${model} 支持，已改用服务商默认档位`);
        log(`已设置会话视觉模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'})`);
        return;
      } catch (error) {
        const message = String(error?.message ?? error);
        if (/session.not.found/i.test(message)) throw error;
        log(`设置会话视觉模型失败 ${sessionId}（${effort ? `档位 ${effort}` : '服务商默认档位'}，第 ${attempt}/2 次）: ${message}`);
        if (effort && /UNSUPPORTED_REASONING_EFFORT|does not support reasoning effort/i.test(message)) break;  // 该档位不被支持 → 换默认档位
        if (attempt < 2) await sleep(1000);
      }
    }
  }
}

export async function ensureSession(key) {
  const epoch = sessionEpoch;
  const existing = state.sessions[key];
  if (existing) {
    // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
    if (epoch !== sessionEpoch) {
      delete state.sessions[key];
      if (reverse.get(existing) === key) reverse.delete(existing);
      try { await apiRef.workspace.archiveSession({ sessionId: existing }); } catch {}
    } else {
      try {
        await ensureVisionModel(existing);
        /* 【2026-09-22 修 M17·"代际守卫恒 false"】上面那个 await 期间可能发生过 /workspace/reset
         * （sessionEpoch 会变）：旧映射指向的会话正在被归档，直接 `return existing` 等于把消息投进一个
         * 已作废的会话。而原来那个 `epoch !== sessionEpoch` 判断的两个读点之间**没有 await**，恒为 false，
         * 等于根本没有守卫。现在在 await **之后**复核一次：代际变了就丢掉映射，往下走去重建新会话。 */
        if (epoch !== sessionEpoch) {
          delete state.sessions[key];
          if (reverse.get(existing) === key) reverse.delete(existing);
          log(`会话 ${existing} 在设置视觉模型期间被重置（代际 ${epoch} → ${sessionEpoch}），丢弃旧映射并重建`);
        } else {
          return existing;
        }
      } catch (vErr) {
        if (/session.not.found/i.test(String(vErr?.message ?? vErr))) {
          log(`会话 ${existing} 不存在（DSH 可能已重启），清除映射并重建`);
          delete state.sessions[key];
          if (reverse.get(existing) === key) reverse.delete(existing);
        } else {
          throw vErr;
        }
      }
    }
  }
  if (sessionPromises.has(key)) return sessionPromises.get(key);
  const promise = (async () => {
    const dir = cfgRef.sessionCwd ? String(cfgRef.sessionCwd) : path.join(STATE_DIR, 'agents');
    fs.mkdirSync(dir, { recursive: true });
    let sessionId;
    let lastError = null;
    // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
    for (const withPreset of [true, false]) {
      try {
        const wsValue = unwrap(await apiRef.workspace.create({ path: dir }), 'workspace.create');
        if (wsValue.created && cfgRef.workspaceTitle) {
          await apiRef.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: cfgRef.workspaceTitle });
        }
        const params = { workspaceId: wsValue.workspace.workspaceId };
        const preset = modePreset(key, currentMode, cfgRef);
        if (withPreset && preset) params.agentPreset = preset;
        const value = unwrap(await apiRef.sessions.create(params), 'session.create');
        sessionId = value.sessionId;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!sessionId) {
      log(`归组创建失败（${lastError?.message}），回退无参创建`);
      const value = unwrap(await apiRef.sessions.create({}), 'session.create');
      sessionId = value.sessionId;
    }
    // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
    if (epoch !== sessionEpoch) {
      log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
      try { await apiRef.workspace.archiveSession({ sessionId }); } catch {}
      throw new Error('会话创建期间已重置，丢弃新会话');
    }
    state.sessions[key] = sessionId;
    reverse.set(sessionId, key);
    saveState();
    await ensureVisionModel(sessionId);
    log(`新会话 ${key} -> ${sessionId}（模式 ${currentMode}，preset: ${modePreset(key, currentMode, cfgRef) ?? '默认'}）`);
    return sessionId;
  })();
  sessionPromises.set(key, promise);
  try {
    return await promise;
  } finally {
    // 只有仍持有该条目的 promise 才删除，避免旧 promise 误删 reset 后新建的 promise。
    if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
  }
}

/**
 * 会话轮换「预热」：提前建好下一代 DSH 会话（同样的归组工作区 + agent preset + 视觉模型），
 * 不写入 state.sessions / reverse 映射，也不触发任何投递——仅占用一个就绪的 sessionId，
 * 供唤醒引擎在 12 轮阈值到达时直接切换过去（首轮提示词已被预热请求命中 provider 前缀缓存）。
 * 返回 sessionId；彻底失败返回 null（调用方回退原「归档旧会话 + 下次现建」路径）。
 */
export async function createStandbySession(key) {
  const dir = cfgRef.sessionCwd ? String(cfgRef.sessionCwd) : path.join(STATE_DIR, 'agents');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  let sessionId = null;
  let lastError = null;
  for (const withPreset of [true, false]) {
    try {
      const wsValue = unwrap(await apiRef.workspace.create({ path: dir }), 'workspace.create');
      if (wsValue.created && cfgRef.workspaceTitle) {
        await apiRef.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: cfgRef.workspaceTitle });
      }
      const params = { workspaceId: wsValue.workspace.workspaceId };
      const preset = modePreset(key, currentMode, cfgRef);
      if (withPreset && preset) params.agentPreset = preset;
      const value = unwrap(await apiRef.sessions.create(params), 'session.create');
      sessionId = value.sessionId;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!sessionId) {
    try {
      const value = unwrap(await apiRef.sessions.create({}), 'session.create');
      sessionId = value.sessionId;
    } catch (error) { lastError = error; }
  }
  if (!sessionId) {
    log(`预热会话创建失败（${key}）：${lastError?.message ?? lastError}`);
    return null;
  }
  try { await ensureVisionModel(sessionId); } catch (error) {
    log(`预热会话设置视觉模型失败（${key}）：${error?.message ?? error}`);
  }
  log(`已预建预热会话 ${key} -> ${sessionId}（待轮换使用，未入映射）`);
  return sessionId;
}
