// 自测：config.json 热加载（管理器改配置后桥接免重启即生效，且**不换对象引用**）
//
// 为什么要有这个测试：桥接启动时 `const cfg = loadConfig()` 被注入到十几个模块（initXxxCore(cfg)），
// 所以热加载必须**原地**改这个对象；如果换成新对象，所有已注入的模块仍指向旧配置（表现为"改了不生效"）。
// 测试在临时沙箱里跑（把 src/ 复制过去 + 自造 config.json），绝不碰真实配置。
//
// 用法：node tools/test-config-hotreload.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const realSrc = path.join(here, '..', 'src');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-hotreload-'));
fs.cpSync(realSrc, path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-hotreload-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
const cfgFile = path.join(sandbox, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({
  dsh: { baseUrl: 'http://127.0.0.1:10721', provider: 'xiaomi-token-plan-cn', model: 'model-A', reasoningEffort: 'medium' },
  ownerQQ: '111',
  social: { send: { linearEnabled: true, linearStepMs: 350 } },
}, null, 2));

const mod = await import(pathToFileURL(path.join(sandbox, 'src', 'core', 'config.js')).href);
const { loadConfig, watchConfigFile, configFilePath } = mod;

let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = loadConfig();
const dshRef = cfg.dsh;             // 模拟 initXxxCore(cfg) 之前各模块拿到的引用
const sendRef = cfg?.social?.send;
check('初值 model=model-A', cfg.dsh.model === 'model-A');
check('configFilePath 指向沙箱', configFilePath() === cfgFile, cfgFile);

const seen = [];
let stopped = false;
const stop = watchConfigFile(cfg, { onChange: (c) => seen.push(c), debounceMs: 150 });

// ① 模拟"管理器保存"：外部进程改盘（provider/model/档位 + ownerQQ + 发送节拍）
const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
raw.dsh.provider = 'deepseek-official';
raw.dsh.model = 'model-B';
raw.dsh.reasoningEffort = 'low';
raw.ownerQQ = '222';
raw.social.send.linearStepMs = 700;
fs.writeFileSync(cfgFile, JSON.stringify(raw, null, 2));
await sleep(900);

check('改盘后 model 热加载为 model-B', cfg.dsh.model === 'model-B', `got ${cfg.dsh.model}`);
check('provider 热加载', cfg.dsh.provider === 'deepseek-official', `got ${cfg.dsh.provider}`);
check('档位热加载 low', cfg.dsh.reasoningEffort === 'low', `got ${cfg.dsh.reasoningEffort}`);
check('ownerQQ 热加载 222', String(cfg.ownerQQ) === '222', `got ${cfg.ownerQQ}`);
check('嵌套 social.send 热加载 700', cfg.social.send.linearStepMs === 700, `got ${cfg.social.send.linearStepMs}`);
check('对象引用未被替换（注入方仍有效）', cfg.dsh === dshRef && cfg.social.send === sendRef);
check('onChange 被调用一次', seen.length === 1, `got ${seen.length}`);
check('onChange 报出 dsh.model 变更', (seen[0] || []).includes('dsh.model'), JSON.stringify(seen[0] || []));
check('onChange 报出 social.send.linearStepMs 变更', (seen[0] || []).includes('social.send.linearStepMs'), JSON.stringify(seen[0] || []));

// ② 桥接自己写盘（值与内存一致）不得再次触发回调，否则会和"回写 config.json"形成自激
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
await sleep(600);
check('自身回写不触发回调（无自激）', seen.length === 1, `got ${seen.length}`);

// ③ 文件被写坏时保留旧配置、不崩
fs.writeFileSync(cfgFile, '{ 这不是合法 JSON');
await sleep(600);
check('坏文件保留旧配置', cfg.dsh.model === 'model-B', `got ${cfg.dsh.model}`);

// ④ 删除字段要跟着删除（loadConfig 会补默认值，旧键不能残留）
fs.writeFileSync(cfgFile, JSON.stringify({ dsh: { provider: 'deepseek-official', model: 'model-C' }, ownerQQ: '333' }, null, 2));
await sleep(700);
check('字段删除与新增同步', cfg.dsh.model === 'model-C' && cfg.social.send.linearPerCharMs === 150, `model=${cfg.dsh.model} perChar=${cfg.social.send.linearPerCharMs}`);

stop();
stopped = true;
fs.writeFileSync(cfgFile, JSON.stringify({ dsh: { model: 'model-D' } }, null, 2));
await sleep(500);
check('stop() 后不再热加载', stopped && cfg.dsh.model === 'model-C', `got ${cfg.dsh.model}`);

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 下目录可能被占用，忽略 */ }
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
