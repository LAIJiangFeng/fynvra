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
worktree 建在 `<根>/<workspaceId>/<slug>`，分支 `fynvra/<slug>`；角色读 `userData/roles/`。`<根>` 由 `worktreesRoot.ts`
在每次建 worktree 时现算：默认是仓库同级的 `<仓库目录名>-worktrees`（与仓库同盘），配置了 `preferences.worktreesRoot`
（设置 → 通用）时是 `<根目录>/<仓库目录名>`，默认位置用不了时退回 `userData/worktrees`。已有 worktree 的路径记在快照里，改设置不迁移。

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
- **WorkerHost 工厂按 run 绑定**：收到 worker 的首次 host 调用时才 `workerHostFor(sessionId)`（Dispatch 写入之前返回
  `null`）。返回的 WorkerHost 固定绑定该次尝试，Main 保留到下一次真实新 run 才重新查找；旧调用不能动态绑定到新尝试。
- **`promptSession`**：编排指令/打回反馈先在 Main 排队，等旧 run 真正 idle 后才开始新 run（重跑 `before_agent_start`，
  重新开放本地 `report_done` guard）。pi streaming `followUp` 可以在旧 run 内消费，不能当作新 run；
  删除、abort、dispose、崩溃会取消尚未投递的反馈。审批/askCoordinator 等待不当作 idle；挂起提问的 reply 仍直接投收件箱。
- **`sessionFailure` / `onSessionFailure`**：同步读取可信的缺失或明确异常终止证据，并在删除/异常终止时通知注册表。
  undefined 是正常或未知，不能凭 idle、未 fork、超时、注册表尚未接线或损坏判失败。
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
- **依赖排队**：依赖没全部 completed 的任务只建 Task（`todo`），在 `merge_worktree` 完成依赖时补派
  （`list_workers` / `wait_for_workers` 被调用时也会兑底补派；主 agent 派发后不再阻塞等待，靠合并推进队列）。
  依赖被放弃或排队任务启动失败时，该任务改为 `abandoned` 并给主 agent 投一条 `escalation`（发送方 `fynvra`，
  由协调者唤醒器自动唤醒主 agent）。
- **`wait_for_workers`**：question / escalation 立即返回；`'any'` 收到 worker_done 返回；没有运行中的 dispatch 时
  立即返回；返回时 ack 期间收到的消息；超时 `timedOut: true`；中止时返回错误且不 ack。
- **`send_to_worker`**：worker 正阻塞在 `ask_coordinator` → `reply`（并 ack 那条 question）；否则记 `instruction`
  并 `promptSession`，投递失败则撤回消息。已 completed / abandoned 的任务拒绝。
- **`report_done`**：succeeded → task `in-review`，failed → task `failed`；先结算再投 `worker_done`。
  每个 attempt 只报告一次，重复/并发及旧 attempt 的迟到报告拒绝，不转发或改写既有报告。需要再次交付时用 `reject_work` 新建 attempt。
- **`reject_work`**：只允许当前 attempt 的 `in-review` / `failed` 任务打回，同一 worktree / 会话上新建 Dispatch，
  反馈等旧 run 完结后作为新 prompt；投递中保护该 Dispatch，不参与恢复或工具绑定，失败回滚时不覆盖并发的显式 abandon。
- **失效恢复**：状态和会话注册表加载后，snapshot/list/wait、launcher 接线或会话删除/异常终止事件触发 Main 检查。
  只结算当前未结束且 Task 为 in-progress 的 attempt 为 failed，保留原报告/文件列表/历史及 worktree/分支，
  记录真实中断理由并投递 `worker_done`，正常持久化及 changed 通知；重复检查不重写 outcome。
  in-review/completed/abandoned 不动，审批、askCoordinator、idle、尚未 fork 或启动加载期间不误判。
  用量 `readSnapshot` 不触发恢复。接管任务已合并不自动验收原任务，Git 祖先不是 completed 的证据路径。
- **`merge_worktree`**：要求当前 dispatch、`in-review`、worktree 干净（含未跟踪文件）；验收通过后记为 `completed`，
  包括已审查的只读 / 空改动任务（Git 无需产生合并提交）。冲突返回 `{ merged: false, conflicts }`（不是错误），task 保持 `in-review`。
- **`cleanup_worktree { dispatch_id, abandon? }`**：只操作当前 dispatch，默认仅允许 `completed` / `abandoned`；
  未验收任务返回操作指引，不停 worker、不删资源、不改状态。成功汇报仍需 `merge_worktree` 验收或 `reject_work` 打回。
  显式 `abandon: true` 才放弃未完成任务（进行中的尝试按 failed 结算，已有汇报保留），再停止 worker、
  `worktree remove --force` 丢弃目录与未提交改动、`-D` 删分支；删除失败仍保持主动放弃的状态，保留记录供重试。
  已验收任务始终保持 `completed`（包括显式 abandon、失败和重复清理），要求干净且无新增未合并提交；
  停 worker 后不加 force 删除目录、用 `-d` 删分支。记录已清理时返回无资源可删，不按旧分支名删除可能被复用的分支。
  合并时在 Task 保存 `mergedDiff`（基准 / worker 提交），清理后 `review_diff` 与面板仍从主仓库读这对提交。
  旧记录没有固定范围时，使用尚存的 worktree 基准和 worker 分支，不在已注销的 worktree 目录里跑 diff。
- **`run_checks` 白名单**：每一段（`&&`、`;`、`|` 分隔）以 pnpm / npm / yarn / bun / node / npx / git / cargo / go /
  python / pytest / make 开头，其余 shell 元字符一律拒绝；默认另外只放行 git 只读子命令、拒绝 npm publish 之类的发布命令。
  这是护栏不是沙箱（node / npx / make 本身能执行任意代码），可通过 `checkPolicy` 替换。执行时关闭颜色、默认 20 分钟超时。

## 测试

- `host.test.ts`：脚本化的 git exec（断言命令序列）+ 假 launcher，覆盖 10 个方法的成功与失败路径。
- `orchestration.integration.test.ts`：真实 git 临时仓库（没有 git 时跳过）：派发 → 提交 → 汇报 → review → checks →
  merge → cleanup，冲突、打回、未提交改动与白名单拒绝、依赖排队、会话起不来时的回滚。
- `shellRunner.test.ts` 起真实子进程（含超时与中止杀进程树）。
