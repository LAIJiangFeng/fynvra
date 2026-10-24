# Task 02 · core-domain —— `packages/core`（@fynvra/core）

先读：`docs/PRODUCT.md`、`docs/ARCHITECTURE.md`（重点 §4）、`AGENTS.md`、`.workflow/specs/01-workflow.md`。
参考：`D:\project\EnsoCode\src\main\services\worktree\service.ts`（git worktree 操作）、`src/shared/types/assets.ts`（内置 agent 类型 / preset）、`src/shared/builtinAgents.ts`。Orca 的 Run / Task / Dispatch / Inbox 语义见 ARCHITECTURE §4 与 §6。

## 范围（允许改）
- 仅 `packages/core/**`（`package.json`、`tsconfig.json`、`src/**`、`README.md`）。
- **不要**创建或修改根目录任何文件（根 `package.json`、`pnpm-lock.yaml`、`vitest.config.ts` 等由 Task 01 负责；验收人合并时统一接线）。本地跑测试可以在 `packages/core` 内用自己的 `vitest.config.ts` 和 devDependencies（vitest、typescript、@biomejs/biome）；`pnpm install` 在 `packages/core` 目录执行，产生的 `packages/core/pnpm-lock.yaml` 可以提交。
- 不得 import Electron；只允许 Node 内置模块（`node:fs/promises`、`node:path`、`node:child_process` 等）且**全部通过注入**（fs / exec）进入，使得核心逻辑纯净可测。

## 要做什么
按 ARCHITECTURE §4 实现并导出（`src/index.ts`）：
1. `types.ts`：§4 全部类型，原样命名。
2. `roles/`：`BUILTIN_ROLES`（`orchestrator`：`tools: 'orchestrator'`、`approvalMode: 'full'`、systemPrompt 写清「只派活不干活、监控、验收合并、向用户汇报」的工作循环（见 §6）；`worker`：`tools: 'all'`、`approvalMode: 'auto-edits'`、无 systemPrompt）；`parseRole(unknown): { ok: true, role } | { ok: false, error }`；`RoleStore` 接口（list / get / save / remove）+ `JsonFileRoleStore`（目录下每个角色一个 `<id>.json`，注入 fs；内置角色不可覆盖、不可删除）。
3. `orchestration/`：
   - `transitions.ts`：`canTransitionTask(from, to)`、`applyTaskTransition`、`settleDispatch(dispatch, outcome, summary, filesModified)`；非法迁移返回 `{ ok: false, error }`。
   - `store.ts`：`OrchestrationStore`（Run / Task / Dispatch / Worktree / Message 的 CRUD + 查询：`listTasks(runId)`、`activeDispatch(taskId)`、`reclaimableDispatches(runId)`）+ `InMemoryOrchestrationStore` + `persistTo(path, fs)` / `loadFrom` 的 JSON 快照（原子写）。
   - `inbox.ts`：`Inbox`：`post(message)`、`peek(filter)`、`ack(id)`、`waitFor(filter, timeoutMs): Promise<Message | null>`（超时返回 null，不抛）。
   - `ids.ts`：`newId(prefix)`。
4. `git/GitWorktreeManager.ts`：§4 列出的方法；分支名 `fynvra/<slug>`，slug 规整（小写、`-`、长度 ≤ 40，冲突追加 `-2`、`-3`）；`merge` 用 `git merge --no-ff --no-edit <branch>`，失败时解析 `git diff --name-only --diff-filter=U` 得到冲突文件并 `git merge --abort`。所有 git 调用通过注入的 `exec` 做，单测用假 exec 断言命令序列；再写一个用真实 git 的集成测试（临时目录 `git init`，可用 `describe.skipIf(!hasGit)`）。
5. `briefs/renderBrief.ts`：输入 `{ title, target, change, constraints[], ownership, acceptance[], dispatchId, reportDoneHint }` 输出 Markdown 任务书，末段固定写明 worker 契约：完成必须调用一次 `report_done`，提问用 `ask_coordinator`。

## 硬约束
- TDD：每个模块先有失败测试。
- 公共 API 全部有 TSDoc。
- 不引入第三方运行时依赖（zod 等也不要；手写收窄）。

## 验收标准
- 在 `packages/core` 下：`pnpm install && pnpm typecheck && pnpm lint && pnpm test` 全绿。
- 测试覆盖：角色解析坏输入、内置角色保护、状态非法迁移、inbox 超时、worktree 分支冲突后缀、merge 冲突路径。

## 提交
多次小提交，`<type>(core): <summary>`，末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不 push、不建 PR。

## 完成动作
按 `.workflow/specs/01-workflow.md` 第 5 条：写 `.workflow/scratch/bootstrap/summary-core-domain.md` 并提交，`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
