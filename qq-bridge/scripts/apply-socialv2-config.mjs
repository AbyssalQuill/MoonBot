// 应用 socialV2 推荐配置（控制台热更新，自动写回 config.json）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'socialv2-recommended.json'), 'utf8'));
const token = '061228-bridge-console';

const resp = await fetch('http://127.0.0.1:3100/api/socialV2/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-console-token': token },
  body: JSON.stringify(config),
});
const json = await resp.json();
if (json.ok) {
  console.log('OK: socialV2 配置已热更新');
  const w = json.config?.wake ?? {};
  console.log(`- wake.recommendedProbability = ${w.recommendedProbability}`);
  console.log(`- wake.recommendedSleepMinMs = ${w.recommendedSleepMinMs} / MaxMs = ${w.recommendedSleepMaxMs}`);
  console.log(`- wake.maxWakePerHour = ${w.maxWakePerHour}`);
  console.log(`- wake.recommendedKeywords = ${(w.recommendedKeywords ?? []).join(',')}`);
  const s = json.config?.send ?? {};
  // burstIntervalMinMs/MaxMs 已废弃（2026-09-11 节奏重整）→ 改打印线性节拍
  console.log(`- send.linear = enabled:${s.linearEnabled} base:${s.linearBaseMs}ms step:${s.linearStepMs}ms cap:${s.linearCapMs}ms, longGap = ${s.longGapProbability}`);
  console.log(`- send.maxSendPerHour = ${s.maxSendPerHour}`);
  const p = json.config?.proactive ?? {};
  console.log(`- proactive.probability = ${p.probability}`);
} else {
  console.error('失败:', json.error ?? JSON.stringify(json));
  process.exit(1);
}
process.exit(0);
