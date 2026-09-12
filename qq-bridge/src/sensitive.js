// 共享的敏感信息审计：桥接回复、MCP 发送、审批/提问文本统一使用，避免两处维护不一致。
//
// 设计要点（V3，本机部署修正）：
// - 只拦截“明显像凭据/本机敏感路径”的形态，不再因聊天里提到 token/密码/密钥 等词就误伤。
//   例：`token 是什么`、`密码是手机号吗` 这类正常聊天不再命中；
//   例：`token: sk-xxxx`、`password=12345678`、`C:\Users\...\.ssh\id_rsa` 仍命中。
// - 路径要求是“绝对路径形态”：盘符路径、UNC、/home|/etc|/var|/Users|/tmp|/opt 开头，
//   且后面跟着至少 1 个非空白内容。**不再把 /app/、/root/ 一律当敏感**：桥接从服务器迁移后
//   模型向主人汇报时可能提到 /app/napcat、/root/.dsh 等“项目自身部署形态”路径（说明性问题，
//   非真实本机凭据）；而 /root/.ssh、/root/.aws 这类密钥目录仍会被 credential 形态覆盖。
// - 凭据要求是“键 + 赋值符(:/=：) + 至少 6 位 ASCII 形态值”；纯中文举例不命中。

const PATH_RE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?!\s)[^\s"'<>|，。；、]{2,}|\\\\[^\\s]+\\\\.*?(?<![,\s])|(?<![A-Za-z0-9])(?:\/home\/|\/Users\/|\/etc\/|\/var\/|\/tmp\/|\/opt\/)[^\s"'<>|，。；、]{1,}/;
// 密钥文件形态（不限盘符）：.ssh/、.aws/、.gnupg/、id_rsa/dsa/ecdsa/ed25519、*.pem、credentials、.netrc
const SECRET_PATH_RE = /(?:\/|\\|^)(?:\.ssh\/|\.aws\/|\.gnupg\/|id_rsa|id_dsa|id_ecdsa|id_ed25519|[\w.-]+\.pem|credentials|\.netrc)(?=[/\\\s"'<>|，。；、]|$)/i;
const CRED_RE = /(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|access[_-]?key|authorization|bearer|credential|私钥)(?:\s*)(?:[:=：])(?:\s*)[A-Za-z0-9_\-./+@]{6,}/i;

export const SENSITIVE_RE = new RegExp(`${PATH_RE.source}|${SECRET_PATH_RE.source}|${CRED_RE.source}`, 'i');

// 判断命中类别，便于日志定位真伪。返回 null | 'path' | 'secret-path' | 'credential'
export function sensitiveHitKind(text) {
  const s = String(text ?? '');
  if (PATH_RE.test(s)) return 'path';
  if (SECRET_PATH_RE.test(s)) return 'secret-path';
  if (CRED_RE.test(s)) return 'credential';
  return null;
}

// 供日志使用：只暴露命中类别与命中的少量上下文（本身仍可能含凭据，仅写入服务器端日志）。
export function sensitiveHitSample(text, max = 48) {
  const s = String(text ?? '');
  for (const re of [PATH_RE, CRED_RE]) {
    const m = re.exec(s);
    if (m && m[0]) return m[0].slice(0, max);
  }
  return '';
}
