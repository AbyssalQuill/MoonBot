/* 回归测试：【切服务商 → 模型列表跟着换】的底层数据源
 *   —— 管理端「模型与推理」里主模型/识图模型的下拉，靠的是 server/index.js 的
 *      readDshProviderModels()：从 DSH 自己的配置里读出**每个服务商真实可用的模型**。
 *
 * 为什么值得一条回归：这是解析 YAML 片段的代码，写错不会报错、只会"列表变空/串味"
 *  （第一版就踩过：把 `providers:` 自己解析成了服务商名，导致小米的清单只剩一个模型）。
 *
 * 覆盖：
 *   ① 合成 YAML（两个服务商 / 多模型 / 额外字段 / 带引号 / 无 models 的块 / 内联空列表）逐项断言
 *   ② 活体：DSH 的 settings.yaml 里的小米清单（有多少算多少，不写死数量）
 *   ③ 活体：DSH 内置的 deepseek-official 目录（≥3 个模型，含识图模型）
 *   ④ 不允许出现 `providers` / `models` 这类伪服务商名
 *
 * 用法：node tools/test-provider-models.mjs
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { parseYamlProviderModels, readDshProviderModels } = await import(pathToFileURL(path.join(here, '..', 'server', 'index.js')).href);

let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

/* ── ① 合成 YAML ─────────────────────────────────────────────────────────── */
const SAMPLE = `
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
agent-default-model:
  provider: xiaomi-token-plan-cn
  model: mimo-v2.5
  reasoningEffort: medium
llm-pi-ai:
  providers:
    xiaomi-token-plan-cn:
      apiKeyEnv: XIAOMI_TOKEN_PLAN_CN_API_KEY
      models:
        - id: mimo-v2.5
          name: MiMo-V2.5
          contextWindow: 1048576
          maxTokens: 131072
        - id: mimo-v2.5-pro
          name: "MiMo-V2.5-Pro"
    another-provider:
      apiKeyEnv: FOO_KEY
      models:
        - id: foo-large
          name: Foo Large
        - id: foo-mini
    no-models-provider:
      apiKeyEnv: NONE_KEY
    empty-models-provider:
      models: []
permission:
  defaultPreset: danger-full-access
ui-theme:
  preference: light
`;

const parsed = parseYamlProviderModels(SAMPLE);
console.log('解析结果:', JSON.stringify(parsed));
check('① 解析出两个有模型的服务商', Object.keys(parsed).sort().join(',') === 'another-provider,xiaomi-token-plan-cn', Object.keys(parsed).join(','));
check('① 小米有 2 个模型（不是 1 个）', parsed['xiaomi-token-plan-cn']?.length === 2, JSON.stringify(parsed['xiaomi-token-plan-cn']));
check('① 模型 id 解析正确', parsed['xiaomi-token-plan-cn']?.[0]?.id === 'mimo-v2.5' && parsed['xiaomi-token-plan-cn']?.[1]?.id === 'mimo-v2.5-pro');
check('① 带引号的 name 也被剥掉引号', parsed['xiaomi-token-plan-cn']?.[1]?.name === 'MiMo-V2.5-Pro', parsed['xiaomi-token-plan-cn']?.[1]?.name);
check('① 第二个服务商解析正确', parsed['another-provider']?.map((m) => m.id).join(',') === 'foo-large,foo-mini', JSON.stringify(parsed['another-provider']));
check('① 没有 models 的服务商被跳过', !parsed['no-models-provider']);
check('① 内联空 models 被跳过', !parsed['empty-models-provider']);
check('① 没有伪服务商名（providers / models）', !parsed.providers && !parsed.models, Object.keys(parsed).join(','));
check('① name 缺省时回填 id', parsed['another-provider']?.[1]?.name === 'foo-mini', parsed['another-provider']?.[1]?.name);

/* ── ②③④ 活体：DSH 自己那份配置 ─────────────────────────────────────────── */
const live = readDshProviderModels();
console.log('活体来源:', JSON.stringify(live.sources));
const providers = live.providers || {};
const xiaomi = providers['xiaomi-token-plan-cn'] || [];
const deepseek = providers['deepseek-official'] || [];
check('② deepseek-official 至少 3 个模型', deepseek.length >= 3, JSON.stringify(deepseek.map((m) => m.id)));
check('② deepseek-official 含识图模型', deepseek.some((m) => /vision/.test(m.id)), JSON.stringify(deepseek.map((m) => m.id)));
check('③ 小米清单非空且形如 mimo-x', xiaomi.length >= 1 && xiaomi.every((m) => /^mimo-/.test(m.id)), JSON.stringify(xiaomi.map((m) => m.id)));
check('④ 没有伪服务商名', !providers.providers && !providers.models, Object.keys(providers).join(','));
check('④ 每个模型都有 id', Object.values(providers).every((list) => list.every((m) => m.id && m.id.trim())));

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
