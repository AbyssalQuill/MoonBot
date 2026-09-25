// 活跃时段表
// activityWindows: { key: [{ start: 分钟数(0-1439), end: 分钟数(可>1440=次日) }] }
// 持久化在 state/activity-windows.json；QQ_set_activity_hours 工具读写。
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from '../lib/paths.js';
import { atomicWriteJson } from '../lib/json-fs.js';
import { bjMinutes, bjMinToText } from '../lib/time.js';
import { log } from '../lib/log.js';
import { social } from './social-state.js';
import { sendWakePrompt } from './wake-send.js';
import { activityWakeCooldown } from './session-state.js';

const ACTIVITY_WINDOWS_FILE = path.join(STATE_DIR, 'activity-windows.json');
export let activityWindows = {};

export function loadActivityWindows() {
  // 仅在文件缺失(首次运行)时 seed 默认时段；文件存在但为空(用户已清除全部时段)绝不再 seed，
  // 否则用户清空时段后一重启，旧群的 12-14/18-次日1 时段又“复活”。
  if (fs.existsSync(ACTIVITY_WINDOWS_FILE)) {
    try { activityWindows = JSON.parse(fs.readFileSync(ACTIVITY_WINDOWS_FILE, 'utf8')) || {}; return; }
    catch (e) { log('[activity] 时段表文件损坏，重新 seed:', e?.message ?? e); }
  }
  // 2026-09-12 去硬编码：这里原来 seed 的是开发者自己那两个群的 12-14 / 18-次日1 时段，
  // 也就是把群号写死在代码里（打包给别人时会被夹带，别人还会莫名地在"某些群只在特定时段活跃"）。
  // 现在默认 seed 空表：要活跃时段就自己设（管理端 / 对话里说），不设=不限制。
  activityWindows = {};
  saveActivityWindows();
  log('[activity] 首次运行：活跃时段表为空（不 seed 任何群，默认不限制）');
}

export function saveActivityWindows() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(ACTIVITY_WINDOWS_FILE, activityWindows);
  } catch (e) { log('[activity] 时段表保存失败:', e?.message ?? e); }
}

export function getActivityWindows(key) {
  const list = activityWindows[String(key)];
  return Array.isArray(list)
    ? list.filter((w) => w && Number.isFinite(Number(w.start)) && Number.isFinite(Number(w.end)) && Number(w.end) > Number(w.start))
    : [];
}

// 当前北京时间是否在某活跃窗口内；无时段配置返回 null
export function inActivityWindow(key, now = Date.now()) {
  const wins = getActivityWindows(key);
  if (!wins.length) return null;
  const bj = bjMinutes(now);
  for (const w of wins) {
    const s = Number(w.start), e = Number(w.end);
    if (e > 1440) {
      // 跨午夜窗口（如 18:00-25:00）
      if ((bj >= s && bj < e) || bj < e - 1440) return true;
    } else if (bj >= s && bj < e) {
      return true;
    }
  }
  return false;
}

// 下一个活跃窗口起点（分钟数，相对今天 0 点的绝对分钟，可能 >1440）
export function nextActivityWindowStart(key, now = Date.now()) {
  const wins = getActivityWindows(key);
  if (!wins.length) return null;
  const bj = bjMinutes(now);
  let best = null;
  for (const w of wins) {
    const s = Number(w.start);
    let cand = s;
    if (cand <= bj) cand = s + 1440;
    if (best === null || cand < best) best = cand;
  }
  return best;
}

// 给唤醒 prompt 注入的活跃时段状态行（仅群）。
// fullActive=true（本会话已处于“全活跃”：mode=active 或 anyMessage 已开）时不注入——
// 用户已把该群转为全天活跃，时段提醒只会让模型在窗外继续潜水/睡到下一时段，
// 造成“转活跃了怎么还是有时间段”的假象。
export function activityStatusLine(key, fullActive = false) {
  if (!key.startsWith('group:') || fullActive) return '';
  const wins = getActivityWindows(key);
  if (!wins.length) return '';
  const inW = inActivityWindow(key);
  const next = nextActivityWindowStart(key);
  const fmt = wins.map((w) => `${bjMinToText(w.start)}-${bjMinToText(w.end)}`).join(', ');
  const nowTxt = bjMinToText(bjMinutes());
  if (inW) {
    return `\n[Active hours] Owner set this group active: ${fmt}. Beijing time now: ${nowTxt} - INSIDE active window: join chat normally, do not rush to dive; when closing, keep dives ≤ 15 min inside active hours.`;
  }
  return `\n[Active hours] Owner set this group active: ${fmt}. Beijing time now: ${nowTxt} - OUTSIDE active window: if nothing needs a reply this round, dive directly (qq_set_wake_config to sleep until next active window starts ≈ ${bjMinToText(next)}); don't surface during quiet hours just to be seen.`;
}

// P5-1 追加：活跃到点提醒定时器（自 bridge.js 抽取，1:1）

export let activityTickTimer = null;

export function startActivityTick() {
  if (activityTickTimer) clearInterval(activityTickTimer);
  activityTickTimer = setInterval(() => {
    try {
      const bj = bjMinutes();
      for (const key of Object.keys(activityWindows)) {
        if (!key.startsWith('group:')) continue;
        for (const w of getActivityWindows(key)) {
          const s = Number(w.start);
          if (!(bj >= s && bj < s + 2)) continue; // 窗口起点后 2 分钟内
          const last = activityWakeCooldown.get(key) || 0;
          if (Date.now() - last < 55 * 60 * 1000) continue;
          activityWakeCooldown.set(key, Date.now());
          const stCur = social.conversations.get(key);
          const wcCur = stCur?.wakeConfig || {};
          const alreadyActive = wcCur.mode === 'active' || wcCur.triggers?.anyMessage === true || Number(wcCur.triggers?.probability || 0) >= 0.3;
          if (alreadyActive) continue;
          log(`[activity] ${key} 到达活跃时段起点（北京时间 ${bjMinToText(bj)}），唤醒提醒`);
          void sendWakePrompt(key, 'activityStart').catch((err) => log(`[activity] 唤醒异常 ${key}: ${err?.message ?? err}`));
        }
      }
    } catch (err) { log('[activity] 到点检查错误:', err?.message ?? err); }
  }, 60000);
  if (activityTickTimer.unref) activityTickTimer.unref();
}
