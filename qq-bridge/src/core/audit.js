// 出站审计/静默拦截
import fs from 'node:fs';
import { log, appendActivity } from '../lib/log.js';
import { redactSensitiveText, redactSensitive, tokenDisclosureIn } from '../lib/text-safe.js';
import { SENSITIVE_RE, sensitiveHitKind, sensitiveHitSample } from '../sensitive.js';
import { readRoleState } from '../lib/role-access.js';
import { readJsonSafe, atomicWriteJson } from '../lib/json-fs.js';
import { TOOL_LOG_FILE, FEEDBACK_FILE, STATE_DIR } from '../lib/paths.js';
import { sendToQQ } from './qq-send.js';

let cfgRef = null;
export function initAuditCore(cfg) { cfgRef = cfg; }

// 单默认模式（default=default）：全部会话均需审计（closed-agent 时代跳过 owner 的特判已删除）
export function shouldAuditKey() {
  return true;
}

export function shouldBlockSilentReply(key) {
  const roleState = readRoleState();
  return roleState.mode === 'silent' && key !== `private:${String(cfgRef.ownerQQ ?? '')}`;
}

export async function handleSensitiveIntercept(key, kindLabel, hasKnownToken, sample) {
  const safeSample = sample ? redactSensitiveText(String(sample).slice(0, 60)) : '';
  log(`⚠️ 回复被安全策略拦截 (${key})，命中类别：${kindLabel}${hasKnownToken ? '（含会话令牌）' : ''}${safeSample ? `，片段样本：${safeSample}` : ''}`);
  appendActivity(`${key} agent 回复被拦截（${kindLabel}${hasKnownToken ? '/会话令牌' : ''}${safeSample ? `；${safeSample}` : ''}）`);
  // 注意：不在 QQ 上发送任何拦截/报错通知（主人明确要求隐藏所有报错）；
  // 如需人工提醒可查看 state/bridge.log 与活动记录。
}

export async function auditAndSend(key, text) {
  const tokenLeak = tokenDisclosureIn(text);
  const kindLabel = sensitiveHitKind(text);
  if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || tokenLeak)) {
    await handleSensitiveIntercept(key, kindLabel, !!tokenLeak, sensitiveHitSample(text));
    return false;
  }
  await sendToQQ(key, text);
  return true;
}


// P5-10 追加：反馈/工具日志

export function readFeedbackEntries() {
  const data = readJsonSafe(FEEDBACK_FILE, []);
  return Array.isArray(data) ? data : [];
}

export function appendFeedbackEntry(entry) {
  const safeEntry = {
    ...entry,
    ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
  };
  const list = readFeedbackEntries();
  list.push(safeEntry);
  if (list.length > 500) list.splice(0, list.length - 500);
  atomicWriteJson(FEEDBACK_FILE, list);
}

export function readToolLog(limit = 200) {
  try {
    const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const parsed = [];
    for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
      try { parsed.push(JSON.parse(line)); } catch {}
    }
    return parsed;
  } catch {
    return [];
  }
}

export function appendToolLog(entry) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const safeEntry = { ...entry };
    if (typeof safeEntry.error === 'string') safeEntry.error = redactSensitiveText(safeEntry.error);
    if (typeof safeEntry.args === 'string') {
      let parsed = safeEntry.args;
      let parsedOk = false;
      for (let i = 0; i < 4; i++) {
        try {
          const next = JSON.parse(parsed);
          parsed = next;
          parsedOk = true;
          if (typeof next !== 'string') break;
        } catch {
          break;
        }
      }
      if (parsedOk) {
        safeEntry.args = JSON.stringify(redactSensitive(parsed));
      } else {
        safeEntry.args = redactSensitiveText(safeEntry.args);
      }
    }
    fs.appendFileSync(TOOL_LOG_FILE, JSON.stringify(safeEntry) + '\n', 'utf8');
    // 防止工具调用日志无限增长：保留最近 2000 行。
    const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
    const lines = raw.split('\n');
    if (lines.length > 2000) {
      fs.writeFileSync(TOOL_LOG_FILE, lines.slice(-2000).join('\n') + '\n', 'utf8');
    }
  } catch (error) {
    log('写入工具调用日志失败:', error?.message ?? error);
  }
}
