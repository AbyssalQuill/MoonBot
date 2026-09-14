/* Dump what DSH actually holds as a session's system prompt, so "UI display cropped it" can be
 * told apart from "the model really got a cut prompt".
 *
 * Usage: node probe-dsh-system-prompt.mjs <sessionId>
 * Env  : QBM_DSH_URL (default http://127.0.0.1:10721), DSH_ISOLATED_LOG_FILE
 */
import os from 'node:os';
import path from 'node:path';
import { NodeApiClient, unwrap } from '../qq-bridge/src/dsh-client.js';

const sessionId = process.argv[2];
if (!sessionId) { console.error('usage: node probe-dsh-system-prompt.mjs <sessionId>'); process.exit(2); }
const baseUrl = process.env.QBM_DSH_URL || 'http://127.0.0.1:10721';
const logFile = process.env.DSH_ISOLATED_LOG_FILE || path.join(os.homedir(), '.qq-bridge-manager', 'logs', 'dsh-isolated.log');
const api = new NodeApiClient(baseUrl, 20000, { dshLogFile: logFile });

const list = unwrap(await api.sessions.list({}), 'session/list');
const items0 = list?.sessions ?? list?.items ?? [];
const me = items0.find((s) => s?.sessionId === sessionId) ?? null;
if (me) console.log(`会话字段: ${Object.keys(me).join(', ')}`);
const throughSeq = Number(me?.eventSeq ?? me?.throughSeq ?? me?.seq ?? me?.lastSeq ?? 0);
console.log(`throughSeq = ${throughSeq}`);

const page = unwrap(await api.sessions.page({ address: { kind: 'session', sessionId }, throughSeq, maxMessages: 40 }), 'session/page');
const items = page?.messages ?? page?.items ?? page?.records ?? [];
console.log(`消息条目: ${items.length}（page 顶层键: ${Object.keys(page ?? {}).join(', ')}）`);

const longest = (o) => {
  let best = '';
  const walk = (v, depth = 0) => {
    if (depth > 6 || v == null) return;
    if (typeof v === 'string') { if (v.length > best.length) best = v; return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === 'object') { for (const x of Object.values(v)) walk(x, depth + 1); }
  };
  walk(o);
  return best;
};

items.forEach((m, i) => {
  const role = m?.role ?? m?.kind ?? m?.type ?? '?';
  const text = longest(m);
  const marker = /truncated|已截断|budget \d+ bytes/i.test(text);
  console.log(`[${i}] role=${role}  最长字段 ${text.length} 字符  截断标记=${marker}`);
  if (text.length > 3000) {
    console.log(`    头 120: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    console.log(`    尾 120: ${text.slice(-120).replace(/\s+/g, ' ')}`);
  }
});
const sys = items.filter((m) => String(m?.role ?? m?.kind ?? '').includes('system'));
console.log(`\nrole 含 system 的条目: ${sys.length}`);
