# Task 11 · main-wiring —— 在 Main 把 agentHost、orchestration、providers/roles/skills/mcp 接成一条链

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/PRODUCT.md`、`docs/ARCHITECTURE.md`（§3、§5、§6、§9.5），以及三份总结的「给验收人的注意事项」：
`.workflow/scratch/wave2/summary-agent-host.md`（第 1、3、4 条）、`summary-orchestration-host.md`（第 2、3、6、8 条）、`summary-settings-ui.md`（第 2、3 条）。
还有 `src/main/services/orchestration/README.md`（接线片段）与 `packages/agent-runtime/README.md`。
三张卡已全部合并到 `main`，但彼此还没接通：orchestrator 的 `dispatch_task` 会返回「agent host 未接 orchestration」；模型解析还是环境变量的临时实现；角色的 skills / MCP 没有解析。

## 范围（允许改）
- `src/main/index.ts`、`src/main/ipc/sessions.ts`（`createAppAgentHost` 等接线处）、`src/main/services/agentHost/**`、`src/main/services/sessions/**`、`src/main/services/orchestration/**`（仅接口对齐 / 小修）、`src/main/services/providers/resolveModel.ts`（仅接口对齐）
- `src/agent/**`（仅为把 `ResolvedModelSpec` 换成 pi provider 注册、以及 skills / MCP 配置映射所需的改动）
- `tsconfig.node.json`（include 加 `src/agent/**/*`）、`biome.json`（electron 禁令 override 加 `src/agent/**`）
- `docs/ARCHITECTURE.md`：回写 §1 持久化表（`userData/orchestration/<workspaceId>.json`）、§9.1（preload 域文件采用「不 import electron 的工厂函数」及理由）、§9.5（`createOrchestrationHost` deps 新增 `worktreesRoot` / `exec` / `checkPolicy?` / `now?`；`createWorkerHost` 的 `now?`）
- 测试文件与上述范围同目录
- **不要动** `src/renderer/**`、`src/preload/**`、`src/shared/**`、`packages/**`（如确需改契约，写进 summary 的 BLOCKED 段）。

## 要做什么
1. **ModelResolver**：`src/main/ipc/sessions.ts` 的 `createAppAgentHost` 用 `createModelResolver()` 替换 `envModelResolver`；删掉 `envModelResolver`、`ENV_MODEL_SECRET_VARS` 和 `electronWorker.ts` 里相应的环境变量传递。worker 侧按 `ResolvedModelSpec.providerId` 注册 pi provider（`registerProvider`），modelId 在 pi 内置目录里找不到时用 spec 自带字段 + 默认值。
2. **resolveResources**：实现 agentHost 的 `resolveResources(role)`：skills 取 `getSkillRegistry().list()` 中 `enabled` 且 `role.skillIds` 包含的条目的 `path`；MCP 取 `getMcpRegistry().list()` 中 `enabled` 且 `role.mcpServerIds` 包含的条目，映射为 agent-runtime 的 `McpServerConfig`（`name` = id；stdio → `{ type:'stdio', command, args, env }`；http / sse → `{ type:'http', url, headers }`），env / headers 明文只在 Main → worker 这一跳。引用了已删除的 id 时跳过并作为 `warnings` 记录。RoleStore 复用 settings-ui 的单例。
3. **orchestration 接线**（`src/main/index.ts`）：`getOrchestrationRegistry().setLauncher(getAgentHost().implementsLauncher())`；`setOrchestrationHostFactory((coordinatorSessionId, workspaceId) => registry.hostFor(...))`；`setWorkerHostFactory((sessionId) => registry.workerHostFor(sessionId))`；启动与恢复会话前 `await registry.openAll()`。`agentHost/types.ts` 的 `WorkerSessionLauncher` 改为从 `orchestration/launcher.ts` import。
4. **launcher 约定核对**（orchestration-host 总结第 2 条）：`createWorkerSession` 提交 brief 后立即 resolve；`promptSession` 在会话空闲时开启新一轮；WorkerHost 工厂在 host 调用到达时再取。不满足的地方修掉并加测试。worker 会话的 `parentSessionId` 设为 coordinator 会话 id（launcher 入参没有的话，通过 dispatch → run → coordinatorSessionId 反查）。
5. **类型护栏**：`tsconfig.node.json` include 加 `src/agent/**/*`；`biome.json` 给 `src/agent/**` 加 electron 禁令。
6. **端到端集成测试**（Main 层，不依赖 Electron 窗口、不调真实模型）：用 agent-host 已有的 InMemoryWorker / 假 session + 真实临时 git 仓库，跑通「orchestrator 会话调 dispatch_task → 建 worktree + worker 会话 → worker 提交并 report_done → orchestrator wait_for_workers 收到 worker_done → review_diff → merge_worktree → cleanup_worktree」整条链，断言 main 分支收到合并提交、worktree 与分支被清理、orchestration 快照落盘。
7. **真机冒烟**（若本机 providers.json 没有可用 key，用 agent-host 总结里的本地 mock 端点方式）：`pnpm dev`，在设置页添加 provider → 新建 orchestrator 会话 → 让它 dispatch 一个「在 README 末尾加一行」的任务 → 观察 worktree 出现、worker 完成、合并进分支。把观察到的事实（命令输出、文件、快照）写进总结；做不到的步骤如实写明。
8. 回写 `docs/ARCHITECTURE.md`（见范围）。

## 验收标准
- 根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿；第 6 条的集成测试真实执行。
- `pnpm dev` 下 orchestrator 的 `dispatch_task` 不再返回「未接线」。

## 提交
`<type>(main|agent|build|docs): <summary>`，末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不 push、不建 PR。

## 完成动作
写 `.workflow/scratch/wave2/summary-main-wiring.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
