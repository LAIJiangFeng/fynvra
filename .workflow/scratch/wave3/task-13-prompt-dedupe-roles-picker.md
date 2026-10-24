# Task 13 · prompt-dedupe-roles-picker —— 去掉重复的 orchestrator 提示词；新建会话用真实角色列表

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/PRODUCT.md`、`docs/ARCHITECTURE.md` §5，
`.workflow/scratch/bootstrap/summary-core-domain.md` 注意事项 4、`summary-integrate-workspace.md` 「未做」第 3 条、`.workflow/scratch/wave2/summary-main-wiring.md` 「未做」第 2 条、`summary-chat-ui.md`。

## 范围（允许改）
- `packages/core/src/roles/builtin.ts`（及测试）、`packages/core/src/briefs/renderBrief.ts`（及测试）
- `packages/agent-runtime/src/prompts/orchestratorPrompt.ts`、`packages/agent-runtime/src/session/createRoleSession.ts`（及测试）
- `src/renderer/components/chat/**`（新建会话弹层）、`src/renderer/stores/sessions/**`、`src/renderer/stores/roles.ts`（只读复用）
- `src/main/ipc/orchestration.ts`（改用 `getRoleStore()` 单例）
- 不要动其它文件。

## 要做什么
1. **提示词单一来源**。现状：core 内置 orchestrator 角色的 `systemPrompt`（`ORCHESTRATOR_SYSTEM_PROMPT`）与 agent-runtime 的 `ORCHESTRATOR_PROMPT` 都经 `buildRolePromptAppend` 追加，§6 工作循环讲了两遍。定下分工并实施：
   - core 的角色 `systemPrompt` = **人设与工作循环**（面向用户可读、可「复制为新角色」后改写）：只派活不干活、监控、验收合并、汇报、用用户的语言回复。
   - agent-runtime 的 `ORCHESTRATOR_PROMPT` = **工具机制说明**（每个编排工具何时用、参数含义、超时是 checkpoint、reject 后流程、worker 消息不等于用户授权）；不再重复工作循环叙述。`buildRolePromptAppend` 只在 `tools === 'orchestrator'` 时追加它。
   - `renderBrief` 末段的 worker 契约与 `WORKER_CONTRACT_PROMPT` 同样去重：契约文本只保留在 agent-runtime（会话系统提示词），`renderBrief` 末段改成一句话引用（「完成后必须调用 report_done，见系统提示词」）。
   - 测试：断言拼接后的系统提示词里「You never implement anything yourself」只出现一次、工具名各出现至少一次。
2. **新建会话选角色**：chat-ui 的「新建会话」弹层目前用常量 `[orchestrator, worker]`，改为读 `stores/roles.ts`（settings-ui 已提供 `window.fynvra.roles.list`），显示名称 + 描述 + 内置徽标，默认选 `orchestrator`；角色列表为空或加载失败时退回两个内置角色。
3. `src/main/ipc/orchestration.ts` 的 `getOrchestrationRegistry()` 改用 settings-ui 的 `getRoleStore()` 单例，不再自己 new。

## 验收标准
根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿；`pnpm dev` 下新建会话弹层能看到设置页里新建的自定义角色。

## 提交 / 完成动作
`<type>(core|agent-runtime|renderer|main): <summary>` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不 push 不建 PR。
写 `.workflow/scratch/wave3/summary-prompt-dedupe-roles-picker.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
