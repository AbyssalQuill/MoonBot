// QQ 桥接安全硬边界：只允许 QQ MCP 工具与少量无害模型侧工具。
// 本文件是 agent preset 内相对插件，随 preset 装载进每个 QQ agent 的 scope。
// 作用：
//  1) 用 tools.restrict 把已知的开发/管理工具从工具列表隐藏；
//  2) 用 tools.guard 白名单兜底：即使未来新增 dev_* 工具，也会在执行时被拒绝。
export const name = 'qq-tool-restrict'

export const inject = ['tools']

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  // dsh-super-injector / 开发注入器（当前 DSH 0.1.1-rc.2 实际注册的全局工具）
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_mode_set',
  'dev_mode_status',
  'dev_mode_subagent',
  'dev_plugin_status',
  'dev_router_mode',
  'dev_router_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

// 执行期白名单：不在这些范围内的工具一律拒绝。
// 前缀覆盖 DSH MCP client 暴露的命名空间工具。
const SAFE_PREFIXES = [
  'mcp__napcat__',
  'mcp__napcat-host__',
  'mcp__web-search-safe__',
]

// 无害模型侧工具：ask_user_question 用于把问题转给管理员/用户，
// todo_write 仅维护任务列表。若后续 preset 不再挂载这些工具，保留无害。
// 【2026-09-12 实测更正】这两个工具（共 2678 字符 ≈ 840 tokens/步）已从**源头**去掉 ——
//   办法是在 `agent.cordis.yml` 里**不再挂载** `dsh-tool-ask-user` / `dsh-tool-todo` 两个插件，
//   而不是在这里 deny。原因是实测发现：**`ctx.tools.restrict({deny})` 只认全局层（mcp__* 那一批）的工具**，
//   对 preset 自己挂载的 scoped 工具会抛
//   `tools.restrict() names unknown global tool "todo_write"; known global tools: mcp__napcat__...`
//   —— deny 在这里是个静默无效的动作（错误被下面的 catch 吞掉）。想让它们彻底消失只能卸载插件。
//   顺带一条更重要的结论：下面这份 KNOWN_DANGEROUS_GLOBAL_TOOLS 名单**从来没有生效过**
//   （dev_* 那些名字在当前 DSH 里根本不在全局工具表里，每次启动都只是被 catch 吞掉），
//   真正兜底的是第 2 步的**执行期白名单 guard**。名单保留只为将来 DSH 真注册了这些工具。
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
])

export function apply(ctx) {
  // 1) 把已知危险全局工具从 schema 隐藏（restrict 只影响继承的全局层，
  //    不会误删 preset 自己注册的 scoped 工具）。
  // 逐个 restrict：当前 DSH 版本不存在的工具名会单独抛错并跳过，
  // 不会导致整批限制失败（restrict 的 unknown 校验是整批原子性的）。
  for (const name of KNOWN_DANGEROUS_GLOBAL_TOOLS) {
    try {
      ctx.tools.restrict({ deny: [name] })
    } catch (error) {
      // 名字不存在时跳过；执行期白名单仍然兜底。
      //
      // 【2026-09-18 修：这行日志曾经把桥整条 DSH 链路搞断】
      // DSH 抛出的原话里嵌着**完整的已知工具列表**（实测约 4KB/行），而 dsh-web.service 把
      // 整个进程树（含它拉起的 MCP 子进程）的 stdout/stderr 都 append 到同一个
      // /root/.dsh/dsh-web.log —— 于是这里的 23 个名字 ×2 份 preset 一次启动就往日志里灌几百 KB。
      // 实测现场：该日志 4260469 B 里有 1794 行、合计 4201098 B 是这种行，占 98.6%，
      // 把 dsh-web 自己刚打印的 `?token=` 挤出了 dsh-client.js 的读取窗口 → readLatestToken 返回 null
      // → 桥不带 dsh-auth cookie 打 /api → 全链路 401（remote.mux 每 3 秒重连失败）。
      // 名字不存在这条信息本身有用，但没必要把整张工具表再抄一遍，故截断。
      const detail = String(error?.message ?? error)
      console.error(`[qq-tool-restrict] skip restrict ${name}: ${detail.slice(0, 160)}${detail.length > 160 ? `…（原话 ${detail.length} 字符，含完整工具表，已截断以免刷爆 dsh-web.log）` : ''}`)
    }
  }

  // 2) 执行期白名单：任何不在允许范围内的工具调用都会被拒绝。
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return
    if (SAFE_EXACT.has(name)) return
    if (SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))) return
    return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`
  })
}
