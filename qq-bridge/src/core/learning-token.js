// 学习会话专用令牌（2026-09-11 新增）
//
// 为什么需要它：
//   黑话 / 人格 / 画像三类学习会话不是 QQ 会话，拿不到唤醒提示词顶部的
//   【会话令牌】（= 群号或 QQ 号）。而桥侧凡是要写库的工具（qq_profile_set、
//   新的 qq_learning_submit）都挂在「必须携带有效 agent token」的校验后面，
//   于是学习会话一直只能把结果**当文本吐出来**、由桥正则解析 JSON。结果就是
//   每个学习 turn 的会话里都留一大坨 JSON，白烧 token。
//
// 为什么不直接把令牌塞进 KNOWN_AGENT_TOKENS：
//   那张表是「会话令牌」集合，进了它就同时通行 /api/profile、/api/blacklist、
//   /api/social/deepsleep、/api/social/schedule* 等敏感端点。给学习会话发一个
//   通行全场的令牌是扩权；而且会话令牌可预测（= 群号），学习令牌必须不可猜。
//   所以这里单开一个集合，只解锁 /api/learning/submit-persona 一个端点。
//
// 持久化在 state/learning-token（32 hex），跨重启稳定：首轮任务说明只注入一次，
// 令牌每轮提醒都会重新带上，就算轮换也不会让已注入的说明失效。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from '../lib/paths.js';
import { log } from '../lib/log.js';
import { LEARNER_AGENT_TOKENS } from '../lib/text-safe.js';

export const LEARNING_TOKEN_FILE = path.join(STATE_DIR, 'learning-token');

let cachedToken = '';

/** 读（或首次生成）学习令牌，并登记进脱敏集合。幂等，可在启动与每次请求时调用。 */
export function ensureLearningToken() {
  if (cachedToken) return cachedToken;
  try {
    const saved = String(fs.readFileSync(LEARNING_TOKEN_FILE, 'utf8') ?? '').trim();
    if (/^[a-f0-9]{32}$/i.test(saved)) {
      cachedToken = saved.toLowerCase();
      LEARNER_AGENT_TOKENS.add(cachedToken);
      return cachedToken;
    }
  } catch { /* 文件不存在 → 生成 */ }
  const fresh = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(LEARNING_TOKEN_FILE, `${fresh}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    // 落盘失败仍返回令牌：本进程内可用，只是重启后轮换（旧说明会失效，但不影响正确性）
    log('学习令牌落盘失败（重启后会轮换）:', error?.message ?? error);
  }
  cachedToken = fresh;
  LEARNER_AGENT_TOKENS.add(fresh);
  log(`学习令牌已生成：${LEARNING_TOKEN_FILE}`);
  return cachedToken;
}

/** 常量时间比较，避免按字符比较泄漏前缀。 */
export function isValidLearningToken(token) {
  const given = String(token ?? '').trim();
  if (!given) return false;
  const expected = ensureLearningToken();
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
