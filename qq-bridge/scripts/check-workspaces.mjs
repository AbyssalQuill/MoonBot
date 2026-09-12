// 检查 DSH 的 workspace 列表，确认 QQ 聊天 workspace 存在
import { NodeApiClient, unwrap } from '../src/dsh-client.js';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3080';
const api = new NodeApiClient(baseUrl, 10000);

try {
  const resp = await api.workspace.list({});
  const { items } = unwrap(resp, 'workspace.list');
  console.log('=== workspace.list ===');
  for (const w of items ?? []) {
    console.log(`- title=${w.title ?? '(未命名)'} workspaceId=${w.workspaceId} sessions=${(w.sessionIds ?? []).length}`);
    for (const sid of w.sessionIds ?? []) console.log(`    session: ${sid}`);
  }
} catch (error) {
  console.error('workspace.list 失败:', error?.message ?? error);
}

process.exit(0);
