// 检查 DSH 的 agentPreset.list 返回，验证 agent-presets 插件是否生效
import { NodeApiClient, unwrap } from '../src/dsh-client.js';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3080';
const api = new NodeApiClient(baseUrl, 10000);

try {
  const resp = await api.agentPresets.list({});
  const { presets } = unwrap(resp, 'agentPreset.list');
  console.log('=== agentPreset.list ===');
  for (const p of presets ?? []) {
    console.log(`- id=${p.id} trust=${p.trust ?? '?'} broken=${p.broken ?? false}`);
  }
} catch (error) {
  console.error('agentPreset.list 失败:', error?.message ?? error);
}

process.exit(0);
