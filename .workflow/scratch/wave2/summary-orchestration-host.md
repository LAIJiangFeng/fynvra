# Summary · Task 06 orchestration-host（Main 侧 OrchestrationHost / WorkerHost + orchestration IPC）

分支 `LAIJiangFeng/orchestration-host`。worktree 建在 `f5c2e91`（Initial commit）上，开工前 `git merge --ff-only main`
快进到 `387ac2d`，并在干净状态下执行了 `git rm -r --cached -q . && git reset --hard -q`（没有产生改动）。
相对 `main` 共 13 个代码提交 + 本总结提交，全部带 `Co-Authored-By: Claude Opus 5.5`；未 push、未建 PR。没有 BLOCKED 项。

## 做了什么

| 文件 | 内容 |
|---|---|
| `src/main/services/orchestration/launcher.ts` | §9.5 `WorkerSessionLauncher`，逐字复制，只过了 Biome 格式化 |
| `…/host.ts` | `createOrchestrationHost(deps)`：10 个方法，全部返回 `HostResult`，从不抛异常（统一经 `guard()`） |
| `…/workerHost.ts` | `createWorkerHost(deps)`：`askCoordinator`（question → 等 `replyTo` 指向它的 reply）、`reportDone`（先结算再投 `worker_done`） |
| `…/service.ts` | `createOrchestrationService`：每个工作区一个，包含 `InMemoryOrchestrationStore`、`persistTo(userData/orchestration/<id>.json)`、`Inbox`、`GitWorktreeManager(nodeExec)`；提供 `hostFor` / `workerHostFor` / 面板查询 |
| `…/registry.ts` | `createOrchestrationRegistry`：管理所有工作区的服务；agent-host 的两个工厂和 IPC 都经它查找；支持 `setLauncher` 晚绑定 |
| `…/checkCommand.ts` | run_checks 命令白名单（可替换的 `CheckCommandPolicy`） |
| `…/brief.ts` | 把 dispatch_task 的 `spec` 拆成 renderBrief 的五段（标题、粗体标签、`Target:` 写法，含中文别名） |
| `…/queries.ts` | 工具与面板共用：当前分支、`reviewWorktreeDiff`（文件 + `--stat` + diff）、`readDispatchOutput` |
| `…/nodeExec.ts`、`…/shellRunner.ts` | core `ExecFn` 的 execFile 实现；run_checks 执行器（shell、合并输出、超时 / 中止时杀进程树） |
| `…/README.md` | 接线卡用：在 `src/main/index.ts` 接 `agentHost.implementsLauncher()` 的片段、launcher 需要保证的事、语义清单 |
| `src/main/ipc/orchestration.ts` + `ipc/index.ts` 一行 | §9.4 三个通道；`getOrchestrationRegistry()`；变更后 `sendToAllWindows('orchestration:changed', workspaceId)` |
| `src/shared/types/ipc.ts` | 追加 `// --- orchestration ---` 段（4 个常量） |
| `src/shared/types/orchestration.ts` | §9.4 `OrchestrationSnapshotView`，逐字复制，只过了 Biome（import 排序、接口换行，import 后没有空行） |
| `src/preload/domains/orchestration.ts` + `index.ts`、`types.ts` 各一行 | §9.4 `OrchestrationApi` |

### 对 §9.5 / §9.1 契约的补充与偏差（请验收时过目）

- **`createOrchestrationHost` 的 deps**：在 §9.5 的字段之外多了三项。
  - `worktreesRoot`（必填）：建 worktree 需要 `userData/worktrees`，而 store 里推导不出这个路径。
  - `exec`（必填）：`GitWorktreeManager.merge` 会合进 repoPath **当前检出**的分支，所以合并前必须用 `symbolic-ref` 确认这个分支就是 `coordinatorBranch`；另外 review 时要取 `--stat`。
  - `checkPolicy?` / `now?`。

  agent-host 不直接构造 Host，只经工厂拿 `OrchestrationHost`，所以这些补充不影响它。`createWorkerHost` 只多了可选的 `now?`。
- **preload 域文件导出 `createOrchestrationApi(ipcRenderer)` 工厂，而不是现成的 `orchestrationApi` 对象**。原因：
  - `types.ts` 要从这个文件拿 `OrchestrationApi`，而 `tsconfig.web.json` 包含 `types.ts`；
  - 如果这个文件 import electron，`electron.d.ts` 顶部的 `/// <reference types="node" />` 会把 Node 全局类型带进 Renderer 的类型检查。这样不会报错，只会悄悄削弱现有护栏。

  我用一个临时探针验证过：在 `src/renderer` 里写 `process.platform`，`tsc -p tsconfig.web.json` 仍然报 TS2591（探针已删除）。
  `index.ts` 里那一行是 `orchestration: createOrchestrationApi(ipcRenderer),`。agent-host 的 sessions 域如果直接 import electron，会遇到同一个问题。
- **持久化路径**：按任务书，每个工作区一个 `userData/orchestration/<workspaceId>.json`；ARCHITECTURE §1 的表里还写着 `userData/orchestration.json`，建议回写。

### 由我定下的语义（README「由我定下的语义」有完整清单）

- **排队补派**：任务书允许二选一，我选了在 `listWorkers` / `waitForWorkers` 被调用时补派，没有提供 `tick()`。理由：
  - 依赖只会经 `merge_worktree` 变成 completed，而主 agent 合并之后总会回到这两个工具上；
  - agent-runtime 对排队任务的工具文案也写着 “Keep monitoring with wait_for_workers”。

  依赖被放弃（或记录已不存在），或者排队任务启动失败时，该任务改为 `abandoned`，并给主 agent 投一条 `escalation`（`from: 'fynvra'`）。这样不会每次调用都重试，也不会留下永远排队的任务。
- **Run**：每个主 agent 会话一个，首次 `dispatch_task` 时创建。编排工具不带用户目标，`objective` 取首个任务的标题。
- **主 agent 所在分支**：取 Host 第一次被调用时仓库检出的分支，之后缓存。detached HEAD 时报错，且不缓存。
  - 合并前确认仓库仍在这个分支上，并且 worktree 的 `baseRef` 就是它；
  - 这样用户中途切换分支时不会合错地方。
- **`send_to_worker`**：先看 worker 是否正阻塞在 `ask_coordinator` 上，判断依据是挂在同一个 `Inbox` 上的进程内表（运行时状态，不持久化）。
  - 是：发 `reply` 并 ack 那条 question；
  - 否：记一条 `instruction` 并 `promptSession`，投递失败就撤回这条消息。
- **`report_done`**：
  - succeeded → task `in-review`；failed → task `failed`（core 迁移表的语义）。
  - 尝试已结算、又没有新尝试时（发生在 send_to_worker 之后的追加汇报），只转发一条 `worker_done`，subject 是 `… (follow-up)`，不改 dispatch。
- **`reject_work`**：`failed` 的任务也可以打回（core 迁移表里的「重试」）。投递失败时把新建的 dispatch、消息和状态全部回滚。
- **`merge_worktree`**：
  - worktree 有未提交改动或未跟踪文件时拒绝合并（任务书要求）；
  - 冲突时返回 `ok: true, merged: false, conflicts`，与工具的渲染方式一致；task 保持 `in-review`。
- **`cleanup_worktree`**：
  - 顺序是：先 `disposeSession`，再 `worktree remove --force`、从 store 删 worktree，最后删分支；
  - 已合并的分支用 `-d`；
  - 未完成的任务按放弃处理：进行中的尝试按 failed 结算、task 改为 `abandoned`，分支用 `-D`。
- **run_checks 白名单**：任务书的句子我读作「除 `;`、`|`、`&&` 之外的 shell 元字符一律不允许」。所以这三个分隔符放行，但**每一段**都必须以白名单程序开头，例如 `pnpm test; rm -rf /` 会被拒绝。
  - 其余字符走允许清单：字母、数字、空格、`_-./\:=@,+~"'`；
  - 默认策略在任务书之外更严格一些：git 只放行只读子命令（status / diff / log / show 等），拒绝 `--output`、`--ext-diff`；包管理器拒绝 publish / login 一类命令。
  - 如果你的本意是只允许 `&&`，把 `splitSegments` 里 `;`、`|` 的分支改成拒绝即可。

## 怎么验证

仓库根目录执行任务书的检查命令（最后一个代码提交之后又从头跑了一遍）：

```
pnpm typecheck && pnpm lint && pnpm test   → EXIT=0
  tsc --noEmit -p tsconfig.node.json / tsconfig.web.json / packages/core / packages/agent-runtime → 无输出
  biome check .  → Checked 137 files … No fixes applied.
  vitest run     → Test Files 42 passed (42) · Tests 582 passed (582)，没有 skipped
```

本卡新增和改动的测试（176 个，全部通过）：

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `checkCommand.test.ts` | 63 | 放行 / 拒绝表：分段程序检查、各类元字符、控制字符、单个 `&`、`\|\|`、git 只读、publish；策略可替换 |
| `host.test.ts` | 47 | 脚本化 git exec，断言命令序列：派发、排队补派与放弃、wait 的 any / all / question / 超时 / 中止、reply 与 instruction、review、白名单、合并的前置检查与冲突、打回与回滚、清理的两条路径 |
| `ipc/orchestration.test.ts` | 19 | 入参收窄（非法 id、路径、负数或非整数 cursor）、磁盘快照、launcher 未接线时的错误与 `setLauncher`、git 错误作为结果返回、`orchestration:changed` 广播 |
| `workerHost.test.ts` | 11 | 结算与 task 迁移、追加汇报、被取代的尝试、ask 的答复 / 超时 / 中止 |
| `service.test.ts` | 8 | 落盘与恢复、同一轮变更只通知一次、workerHostFor 反查与打回后重新绑定、加载前返回 null、detached HEAD、分支固定、读不懂的快照挪到一边 |
| `brief.test.ts` | 7 | 三种标签写法、中文、前言并入 Change、代码块、重复标签、渲染结果 |
| `orchestration.integration.test.ts` | 6 | **真实 git**（已实际执行，约 7 s）：派发 → 提交 → reportDone → review → run_checks → `--no-ff` 合并提交 → cleanup；冲突（HEAD 不变、无 MERGE_HEAD）；打回后再合并；未提交改动拒绝合并 + 白名单拒绝且 worktree 未被改动；依赖排队从新 main 切出；会话起不来时回滚真实的 worktree 与分支 |
| `shellRunner.test.ts` | 6 | 真实子进程：退出码、stderr 合并、`&&`、超时与中止时杀进程树（Windows 走 taskkill /T）、只保留尾部；nodeExec |
| `registry.test.ts` | 4 | 懒打开、launcher 晚绑定与 userData 路径、跨工作区查找、openAll |
| `preload/domains/orchestration.test.ts` | 2 | 通道映射只传 id / cursor；onChanged 只给 workspaceId；取消订阅 |
| `preload/index.test.ts`（改） | 3 | 暴露的域列表加上 orchestration |

额外检查（任务书没有要求）：

- `pnpm build` 通过（EXIT=0）；
- `out/main/index.js` 里有 orchestration 通道，没有任何 pi / `@earendil-works` 代码：Main 只 `import type` agent-runtime，没有把 pi 加载进主进程；
- `pnpm-lock.yaml` 没有变化。

TDD 如实说明：
- 纯函数是先写测试的：`checkCommand`、`parseSpecSections`，先跑红（找不到模块）再实现。
- 下面这些是先写实现、紧接着补的测试，不是严格的 red-first：WorkerHost / OrchestrationHost / service / registry / IPC / preload。
- 测试中出过两次失败，都是测试本身的错误：一条多余的断言；还有一次 flush 了错误的服务实例。
  - 后者顺带暴露出一个事实：同一个状态文件上如果有两个服务实例，会互相覆盖。注册表保证每个工作区只有一个实例，见注意事项 6。

## 未做 / 越界项

- **越界（必要）**：
  - `src/preload/index.test.ts`：现有断言写死了暴露的域列表，不改它就会失败，所以只把 `orchestration` 加进列表；
  - 两个与任务书范围内新文件同目录的测试文件：`src/main/ipc/orchestration.test.ts`、`src/preload/domains/orchestration.test.ts`。

  其余改动都在任务书范围内（`git diff --name-only main...HEAD` 已核对），没有碰 `src/agent/**`、`src/main/services/agentHost/**`、`src/renderer/**`、`packages/**`、`src/main/index.ts`。
- **未做（不在本卡范围）**：
  - `src/main/index.ts` 的接线，留给下一张卡，README 里有现成片段；
  - run_checks 的审批 UI；
  - 清理后再查 diff：Dispatch 没有合并提交字段，worktree 记录和分支删掉后就算不出来了；
  - 崩溃恢复：`worktree add` 之后、落库之前崩溃留下的孤儿 worktree；
  - 用用户原话作为 Run 的 objective；
  - 发送或消费 `heartbeat`。

## 给验收人的注意事项

1. **合并冲突预期**：其他 Wave 2 卡也会追加同样的位置，下面这些冲突都是纯追加，取并集即可：
   - `src/shared/types/ipc.ts`：对象末尾的追加段；
   - `src/main/ipc/index.ts`：import 行；调用我放在 `registerWorkspaceHandlers()` 之后，避开末尾；
   - `src/preload/index.ts` / `types.ts`：import 行，以及成员（放在 `workspaces` 之后）；
   - `src/preload/index.test.ts`：域列表。

   `src/shared/types/orchestration.ts` 如果与 Task 09 的版本只差格式，取哪一份都可以（类型相同）。
2. **agent-host 需要遵守的 launcher 约定**（README「`implementsLauncher()` 需要保证的事」）：
   - `createWorkerSession` 在提交 brief 后**立即** resolve，不能等 worker 这一轮跑完：Dispatch 在它 resolve 之后同步写入；
   - WorkerHost 工厂要在收到 worker 的 host 调用时再取：Dispatch 写入之前 `workerHostFor` 返回 null；
   - `promptSession` 在会话空闲时要开启新的一轮：reject_work 靠这一点重新开放 report_done；
   - 启动或恢复会话之前，先 `await getOrchestrationRegistry().openAll()`。
3. **接线之前的行为**：`dispatch_task` 返回 “worker sessions are unavailable: the agent host is not connected to orchestration yet”。orchestration IPC 不受影响，照常工作（快照、查询）。
4. **run_checks 白名单是护栏，不是沙箱**：node / npx / make 本身就能执行任意代码。另外 Windows 的 cmd 不把 `;` 当命令分隔符，这种命令只会运行失败，不会被注入。执行时关闭了颜色输出，默认超时 20 分钟；单条 git 命令的上限是 2 分钟。
5. **合并要求 worktree 干净（包括未跟踪文件）**：没有被 `.gitignore` 忽略的构建产物会挡住合并，需要 worker 提交或清掉，属于预期行为。worker 契约里已经要求先提交再汇报。
6. **同一个状态文件只能有一个服务实例**：两个实例会互相覆盖。注册表保证每个工作区只有一个实例，不要在别处另外创建服务。
7. **Task 09 的「改动」tab**：`cleanup_worktree` 之后，该 dispatch 的 `reviewDiff` 会返回错误（worktree 已清理）。如果以后需要查看已合并任务的 diff，建议在 §4 的 Dispatch 里加 `mergeCommit` 字段，这需要改契约。
8. **建议回写 ARCHITECTURE 的地方**：每个工作区一个编排快照文件；§9.5 deps 的三项补充；preload 域文件改用工厂函数的理由（§9.1）。
