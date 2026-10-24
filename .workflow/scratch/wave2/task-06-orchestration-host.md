# Task 06 · orchestration-host —— Main 侧 OrchestrationHost / WorkerHost 实现 + orchestration IPC

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/PRODUCT.md`、`docs/ARCHITECTURE.md`（§4、§5、§6、**§9 全部**）、
`packages/core/README.md`、`packages/agent-runtime/README.md`、`packages/agent-runtime/src/host.ts`（接口与各 Input/Output 的字段注释）、
`.workflow/scratch/bootstrap/summary-core-domain.md`（「由我定下的语义」）、`summary-agent-runtime.md`（注意事项 1、3）。

## 范围（允许改）
- `src/main/services/orchestration/**`（新建）
- `src/main/ipc/orchestration.ts`（新建）+ `src/main/ipc/index.ts` 加一行
- `src/shared/types/ipc.ts`：追加 `// --- orchestration ---` 段；`src/shared/types/orchestration.ts`（新建，放 §9.4 的 `OrchestrationSnapshotView`）
- `src/preload/domains/orchestration.ts`（新建）+ `src/preload/index.ts`、`src/preload/types.ts` 各加一行
- **不要动** `src/agent/**`、`src/main/services/agentHost/**`、`src/renderer/**`、`packages/**`。`WorkerSessionLauncher` 由你定义接口（§9.5），测试里用假实现。

## 要做什么
1. `launcher.ts`：§9.5 `WorkerSessionLauncher` 接口（逐字）。
2. `createOrchestrationHost(deps)`（§9.5 签名）实现 `OrchestrationHost` 全部 10 个方法，语义按 §6 与 host.ts 注释：
   - `dispatchTask`：校验 roleId 存在（`roles.get`）；`dependsOn` 未全部 `completed` 时只建 Task 不建 Dispatch（返回 `dispatch: undefined`），并在依赖完成后由 `waitForWorkers` / `listWorkers` 调用时机触发补派（或提供 `tick()`，说明选择）；否则 `git.create` 建 worktree（`worktreesRoot` = `userData/worktrees`）→ `renderBrief` 渲染任务书 → `launcher.createWorkerSession` → 记 Dispatch、Task→in-progress。失败时回滚已建 worktree。
   - `waitForWorkers`：基于 `inbox.waitFor`，`until: any|all`，返回新消息并 ack；超时 `timedOut: true` 不报错。
   - `readWorkerOutput` → `launcher.readTranscript`。`sendToWorker` → 记 `instruction` 消息 + `launcher.promptSession`。
   - `reviewDiff` → `git.diff(baseCommit)`；`runChecks` → `deps.runChecks(worktreePath, command)`（命令白名单：只允许以 `pnpm|npm|yarn|bun|node|npx|git|cargo|go|python|pytest|make` 开头且不含 `;`、`|`、`&&` 之外的 shell 元字符；可配置）。
   - `mergeWorktree`：目标分支 = `coordinatorBranch`；先 `git.status` 确认 worker 分支无未提交改动（有则返回错误要求 worker 先提交）；`git.merge`；成功 → Task `in-review`→`completed`、Dispatch settle；冲突 → 返回 `conflicts`。
   - `rejectWork`：Task `in-review`→`in-progress`，新建 Dispatch（同 worktree），发 `instruction` 消息 + `launcher.promptSession(feedback)`。
   - `cleanupWorktree`：`git.remove` + `git.deleteBranch` + 从 store 删 worktree + `launcher.disposeSession`。
3. `createWorkerHost(deps)`：`askCoordinator` → 投 `question` 消息、`inbox.waitFor(reply 且 replyTo=该消息)`；`reportDone` → settle Dispatch（Task→`in-review`）并投 `worker_done`。
4. `OrchestrationService`（每个 workspace 一个）：持有 `InMemoryOrchestrationStore` + `persistTo(userData/orchestration/<workspaceId>.json)`、`Inbox`、`GitWorktreeManager(nodeExec)`；提供 `hostFor(coordinatorSessionId)`、`workerHostFor(sessionId)`（通过 Dispatch.workerSessionId 反查）；变更后 `sendToAllWindows('orchestration:changed', workspaceId)`。
5. IPC + preload：§9.4 全部。
6. 测试：假 launcher + 假 exec（命令序列断言）+ 真实 git 的集成测试（临时仓库：dispatch → 在 worktree 里提交 → reportDone → review → merge → cleanup；冲突路径；reject 路径；runChecks 白名单拒绝）。

## 硬约束
- 不 import Electron 到 `services/orchestration`（`sendToAllWindows` 通过注入回调）；只有 `ipc/orchestration.ts` 碰 Electron。
- 全部方法不抛，返回 `HostResult`。
- `Workspace.repoPath` 以外的路径一律由 store 记录推导。

## 验收标准
- 根目录 `pnpm typecheck && pnpm lint && pnpm test` 全绿；集成测试真实执行。
- README 片段写在 `src/main/services/orchestration/README.md`：如何在 `src/main/index.ts` 把 `agentHost.implementsLauncher()` 接进来（给下一张接线卡用）。

## 提交
`<type>(main|shared|preload): <summary>`，末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不 push、不建 PR。

## 完成动作
写 `.workflow/scratch/wave2/summary-orchestration-host.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。

## 补充（验收人，Task 04/10 合并后）
- 仓库已统一 LF；若 `pnpm lint` 报大量格式错误，先在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`。
- renderer / shared 不能 import `@fynvra/agent-runtime`（web tsconfig 刻意不映射）；需要的类型从 `@fynvra/core` 拿。
- 根 `pnpm-lock.yaml` 若与 main 冲突，取 main 版本后 `pnpm install` 重新生成。
