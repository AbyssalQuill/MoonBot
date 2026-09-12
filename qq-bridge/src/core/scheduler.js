// M12 定时发消息
// recordSentMessages（发送回执写入会话）经 setScheduledRecorder 注入。
import crypto from 'node:crypto';
import path from 'node:path';
import { log } from '../lib/log.js';
import { fmtBeijing } from '../lib/time.js';
import { STATE_DIR } from '../lib/paths.js';
import { readJsonSafe, atomicWriteJson } from '../lib/json-fs.js';
import { sendMessages, sendToQQ } from './qq-send.js';

export const SCHEDULED_FILE = path.join(STATE_DIR, 'scheduled-tasks.json');
export const scheduledTasks = readJsonSafe(SCHEDULED_FILE, []);
export const scheduledTimers = new Map(); // taskId -> timer
export const scheduledRetries = new Map(); // taskId -> 重试次数

let recordSent = null;
export function setScheduledRecorder(fn) { recordSent = fn; }

export function saveScheduledTasks() {
  atomicWriteJson(SCHEDULED_FILE, scheduledTasks);
}

export function fireScheduledTask(task) {
  const targetKey = task.targetKey;
  const message = String(task.message ?? '');
  const sendIt = async () => {
    try {
      const sent = await sendMessages(targetKey, [message], [], null, null);
      // 发送回执写会话日志是可选的: 失败(或未注入 recordSent)绝不影响“发送成功”判定,
      // 否则会误触发 60s 重试 → 同一条消息被连发 4 次并报假失败。
      if (recordSent) {
        try { await recordSent(targetKey, sent); } catch (e) { log(`[scheduled] 回执落库失败(忽略, 不影响发送) ${targetKey}: ${e?.message ?? e}`); }
      }
      log(`[scheduled] 定时消息已发送 ${targetKey}: ${message.slice(0, 30)}（来自 ${task.sourceKey || '?'}）`);
      return true;
    } catch (error) {
      log(`[scheduled] 定时消息发送失败 ${targetKey}: ${error?.message ?? error}`);
      return false;
    }
  };
  sendIt().then((ok) => {
    if (ok) {
      scheduledRetries.delete(task.id);
      if (task.repeatMs > 0) {
        task.at = Date.now() + task.repeatMs;
        saveScheduledTasks();
        scheduleTaskTimer(task);
      } else {
        const idx = scheduledTasks.indexOf(task);
        if (idx >= 0) scheduledTasks.splice(idx, 1);
        saveScheduledTasks();
      }
    } else {
      // 发送失败：60s 后重试，最多 3 次；仍失败则丢弃并通知发起会话
      const tries = (scheduledRetries.get(task.id) || 0) + 1;
      if (tries <= 3) {
        scheduledRetries.set(task.id, tries);
        task.at = Date.now() + 60000;
        saveScheduledTasks(); // 新的重试时刻必须落盘：否则重启后文件里仍是旧 at（已过期）→ 恢复时被丢弃
        scheduleTaskTimer(task);
      } else {
        scheduledRetries.delete(task.id);
        const idx = scheduledTasks.indexOf(task);
        if (idx >= 0) scheduledTasks.splice(idx, 1);
        saveScheduledTasks();
        if (task.sourceKey) {
          try { void sendToQQ(task.sourceKey, `定时消息发送失败（已放弃重试）：${message.slice(0, 40)}`); } catch {}
        }
      }
    }
  });
}

export function scheduleTaskTimer(task) {
  const prev = scheduledTimers.get(task.id);
  if (prev) clearTimeout(prev);
  const delay = Math.max(0, task.at - Date.now());
  const timer = setTimeout(() => {
    scheduledTimers.delete(task.id);
    fireScheduledTask(task);
  }, delay);
  timer.unref?.();
  scheduledTimers.set(task.id, timer);
}

export function loadScheduledTasks() {
  const now = Date.now();
  // 恢复前先剔除「无效」与「已过期的一次性」任务：只跳过不删除会让它们永久留在内存数组与
  // state/scheduled-tasks.json 里（控制台 GET 会一直把它们列成待触发，实际永远不会再发）。
  let dropped = 0;
  for (let i = scheduledTasks.length - 1; i >= 0; i -= 1) {
    const t = scheduledTasks[i];
    if (!t || !t.targetKey || typeof t.message !== 'string') { scheduledTasks.splice(i, 1); dropped += 1; continue; }
    if (t.at <= now && !(t.repeatMs > 0)) { scheduledTasks.splice(i, 1); dropped += 1; }
  }
  for (const t of scheduledTasks) scheduleTaskTimer(t);
  if (dropped > 0) {
    saveScheduledTasks();
    log(`[scheduled] 已清理无效/过期定时任务 ${dropped} 个`);
  }
  log(`[scheduled] 已恢复定时任务 ${scheduledTasks.length} 个`);
}

export function parseScheduledAt(raw) {
  const atRaw = String(raw ?? '').trim();
  if (!atRaw) return null;
  const asNum = Number(atRaw);
  if (Number.isFinite(asNum) && asNum > 0) return asNum < 1e12 ? asNum * 1000 : asNum; // 兼容秒/毫秒
  if (/(?:Z|[+-]\d{2}:?\d{2})\s*$/.test(atRaw)) {
    const parsed = Date.parse(atRaw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(atRaw);
  if (m) {
    const [, y, mo, d, hh, mm, ss] = m;
    const t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh) - 8, Number(mm), Number(ss) || 0);
    return Number.isFinite(t) ? t : null;
  }
  const parsed2 = Date.parse(atRaw);
  return Number.isFinite(parsed2) ? parsed2 : null;
}

export function createScheduledTask({ targetKey, message, at, repeatMs = 0, sourceKey = '', sourceUid = '' }) {
  const task = {
    id: crypto.randomBytes(8).toString('hex'),
    targetKey,
    message,
    at: Math.max(Date.now(), Number(at) || Date.now()),
    repeatMs: Math.max(0, Number(repeatMs) || 0),
    sourceKey,
    sourceUid,
    createdAt: Date.now()
  };
  scheduledTasks.push(task);
  saveScheduledTasks();
  scheduleTaskTimer(task);
  log(`[scheduled] 新增定时任务 ${task.id} -> ${targetKey} @ ${fmtBeijing(task.at)}: ${String(message).slice(0, 30)}`);
  return task;
}

export function cancelScheduledTask(id) {
  const idx = scheduledTasks.findIndex((t) => t && t.id === id);
  if (idx < 0) return false;
  const task = scheduledTasks[idx];
  const timer = scheduledTimers.get(id);
  if (timer) { clearTimeout(timer); scheduledTimers.delete(id); }
  scheduledTasks.splice(idx, 1);
  scheduledRetries.delete(id);
  saveScheduledTasks();
  log(`[scheduled] 已取消定时任务 ${id}`);
  return true;
}
