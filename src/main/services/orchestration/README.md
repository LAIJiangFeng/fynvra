# Main 侧编排（orchestration-host）

ARCHITECTURE §6 / §9.4 / §9.5 在 Main 里的实现：`OrchestrationHost`（主 agent 的 10 个编排工具背后）、
`WorkerHost`（worker 的 `ask_coordinator` / `report_done` 背后）、每个工作区一个 `OrchestrationService`，
以及面板用的 orchestration IPC。本目录不 import Electron，Electron 只出现在 `src/main/ipc/orchestration.ts`。

| 文件 | 内容 |
|---|---|
| `launcher.ts` | §9.5 `WorkerSessionLauncher`（逐字），由 agent-host 的 `implementsLauncher()` 实现 |
| `host.ts` | `createOrchestrationHost(deps)`：10 个方法，全部返回 `HostResult`、从不抛 |
| `workerHost.ts` | `createWorkerHost(deps)`；挂起中的 `ask_coordinator`（send_to_worker 据此发 reply） |
| `service.ts` | `createOrchestrationService`：store + 快照文件 + Inbox + GitWorktreeManager，变更即落盘并通知 |
| `registry.ts` | `createOrchestrationRegistry`：所有工作区的服务；agent-host 的两个工厂与 IPC 都经它查找 |
| `checkCommand.ts` | run_checks 命令白名单 |
| `brief.ts` | 把 dispatch_task 的 spec 拆成 renderBrief 的五段 |
| `queries.ts` | 工具与面板共用的只读查询（当前分支、diff、worker 输出） |
| `nodeExec.ts` / `shellRunner.ts` | git 执行（execFile）与 run_checks 执行器（shell，超时 / 中止时杀进程树） |
| `testing.ts` | 测试用假实现（脚本化 git exec、假 launcher、内存角色仓库），只被 `*.test.ts` 引用 |

持久化：`userData/orchestration/<workspaceId>.json`（`InMemoryOrchestrationStore` 快照，消息也在里面）；
worktree 建在 `userData/worktrees/<workspaceId>/<slug>`，分支 `fynvra/<slug>`；角色读 `userData/roles/`。

## 与 agent host 的接线

`registerIpcHandlers()` 已经注册了 orchestration IPC；注册表在第一次使用时创建（`getOrchestrationRegistry()`）。
`src/main/index.ts` 在启动窗口前调用 `connectOrchestration(getAgentHost(), getOrchestrationRegistry())`
（`src/main/services/agentHost/connectOrchestration.ts`）：

1. `setLauncher(agentHost.implementsLauncher())`：worker 会话由 agent host 启动；接上之前 dispatch_task 返回「agent host 未接线」；
2. `setOrchestrationHostFactory → hostFor`：主 agent 会话的编排工具 → 该工作区服务里属于这个会话的 Host（同步返回，调用时再等状态就绪）；
3. `setWorkerHostFactory → workerHostFor`：worker 会话的 report_done / ask_coordinator → 按 Dispatch.workerSessionId 反查；
4. `setCoordinatorLookup → coordinatorOf`：worker 会话的 parentSessionId 经 Run 反查主 agent 会话（launcher 被调用时 Run 已落库、Dispatch 还没有）；
5. `await openAll()`：在恢复或新建任何 agent 会话之前加载全部工作区的编排快照，workerHostFor 只认已加载的状态。

退出时 agent host 关闭后再 `flushAll()`；平时每次变更都已在一个微任务里原子写盘。

## `implementsLauncher()` 需要保证的事

- **`createWorkerSession`**：用 `roleId` 的角色、`cwd`（worktree 路径）创建 worker 会话（`createRoleSession` 传
  `workerHost` 代理），把 `brief` 作为第一条 prompt 提交，然后**立刻** resolve `{ ok: true, sessionId }`——不要等 worker
  这一轮跑完。Host 在它 resolve 之后同步写入 Dispatch（中间没有 await），worker 的第一次 `report_done` 才能找到它。
  `dispatchId` / `runId` / `worktreeId` 可以记进 `SessionSummary`（§9.2 有 `dispatchId`、`worktreeId` 字段）。
- **WorkerHost 工厂按调用时机取**：收到 worker 的 host 调用时再 `workerHostFor(sessionId)`（或至少在
  createWorkerSession resolve 之后）；Dispatch 写入之前它返回 `null`。返回的 WorkerHost 每次调用都会重新绑定到该会话
  当前的 Dispatch（`reject_work` 之后同一会话换成了新的尝试），所以按会话缓存它没有问题。
- **`promptSession`**：会话空闲时开始新的一轮（`reject_work` 依赖这一点重新开放 `report_done`），正在运行时按
  steer / follow-up 投递（`send_to_worker` 的 instruction）。
- **`readTranscript(sessionId, cursor)`**：worker 输出的文本投影（例如由它的 `FynvraSessionEvent` 拼出的正文与工具行），
  `cursor` 是字符偏移，返回 `{ text, total, done }`，`done` 表示会话空闲或已释放。Host 会再与 Dispatch 是否结算合并。
  会话释放后最好仍能从 pi jsonl 读到（面板会看已结束 worker 的输出）。
- **`disposeSession`**：停止并释放会话；对未知会话不要抛。`cleanup_worktree` 先调它再删 worktree。

## 由我定下的语义

- **Run**：每个主 agent 会话一个，按 `(workspaceId, coordinatorSessionId)` 查找，首次 `dispatch_task` 时创建；
  编排工具不携带用户目标，`objective` 取首个任务的标题。
- **主 agent 所在分支**：Host 第一次被调用时仓库检出的分支（detached HEAD 时报错、不缓存）。worktree 从它切出；
  `merge_worktree` 合并前确认仓库仍检出在这个分支上（`GitWorktreeManager.merge` 合进的是当前检出的分支），
  且 worktree 的 `baseRef` 就是它。
- **依赖排队**：依赖没全部 completed 的任务只建 Task（`todo`），在 `list_workers` / `wait_for_workers` 被调用时补派
  （依赖只会经 `merge_worktree` 完成，主 agent 合并之后总会回到这两个工具；工具文案也让它继续 wait）。
  依赖被放弃或排队任务启动失败时，该任务改为 `abandoned` 并给主 agent 投一条 `escalation`（发送方 `fynvra`）。
- **`wait_for_workers`**：question / escalation 立即返回；`'any'` 收到 worker_done 返回；没有运行中的 dispatch 时
  立即返回；返回时 ack 期间收到的消息；超时 `timedOut: true`；中止时返回错误且不 ack。
- **`send_to_worker`**：worker 正阻塞在 `ask_coordinator` → `reply`（并 ack 那条 question）；否则记 `instruction`
  并 `promptSession`，投递失败则撤回消息。已 completed / abandoned 的任务拒绝。
- **`report_done`**：succeeded → task `in-review`，failed → task `failed`；先结算再投 `worker_done`。
  尝试已结算且没有新尝试时（`send_to_worker` 之后的追加汇报）只转发一条 `worker_done`（subject 带 `(follow-up)`）。
- **`reject_work`**：`in-review` 或 `failed` 的任务都可以打回，同一 worktree / 会话上新建 Dispatch，反馈作为新 prompt；
  投递失败整体回滚。
- **`merge_worktree`**：要求 `in-review`、worktree 干净（含未跟踪文件）；冲突返回 `{ merged: false, conflicts }`
  （不是错误），task 保持 `in-review`。
- **`cleanup_worktree`**：先 `disposeSession`，再 `worktree remove --force`、从 store 删 worktree，最后删分支：
  已合并用 `-d`，未完成的任务视为放弃（进行中的尝试按 failed 结算、task → `abandoned`）用 `-D`。删 worktree 失败时
  返回错误并保留记录，可以重试。清理后该 dispatch 的 `review_diff` 不再可用（worktree 记录与分支都没了）。
- **`run_checks` 白名单**：每一段（`&&`、`;`、`|` 分隔）以 pnpm / npm / yarn / bun / node / npx / git / cargo / go /
  python / pytest / make 开头，其余 shell 元字符一律拒绝；默认另外只放行 git 只读子命令、拒绝 npm publish 之类的发布命令。
  这是护栏不是沙箱（node / npx / make 本身能执行任意代码），可通过 `checkPolicy` 替换。执行时关闭颜色、默认 20 分钟超时。

## 测试

- `host.test.ts`：脚本化的 git exec（断言命令序列）+ 假 launcher，覆盖 10 个方法的成功与失败路径。
- `orchestration.integration.test.ts`：真实 git 临时仓库（没有 git 时跳过）：派发 → 提交 → 汇报 → review → checks →
  merge → cleanup，冲突、打回、未提交改动与白名单拒绝、依赖排队、会话起不来时的回滚。
- `shellRunner.test.ts` 起真实子进程（含超时与中止杀进程树）。
