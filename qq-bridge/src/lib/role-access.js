// 角色/模式状态读写
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ROLE_STATE_FILE } from './paths.js';
import { readJsonSafe, atomicWriteJson } from './json-fs.js';

// 角色名清洗：只保留字母数字/汉字/下划线/连字符
export function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

// 读取角色/模式状态：{"role": "傲娇助手", "mode": "active"|"silent"}
export function readRoleState() {
  return readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
}

export function writeRoleState(role, mode) {
  atomicWriteJson(ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
}

// 列出可用角色（roles/*.md，排除 README.md）
export function listRoles() {
  try {
    return fs.readdirSync(path.join(ROOT, 'roles'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}
