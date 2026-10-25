# Summary · Task 28 non-git-workspace（没有 git 的目录也能挂入，只是不用 worktree）

分支 `LAIJiangFeng/non-git-workspace`。worktree 建在 `f5c2e91`（Initial commit）上：开工时 `git merge --ff-only main` 快进到 `918a0e8`，在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`（没有产生改动），再 `pnpm install --frozen-lockfile`；冒烟前按惯例补装 Electron 二进制（`node node_modules/electron/install.js`，本机缓存）。写总结时 `main` 仍是 `918a0e8`，`git merge-tree --write-tree main HEAD` 退出码 0。

相对 `918a0e8` 有 7 个提交（46 个文件，+1398 / −241，其中测试 19 个文件），另有本总结的 `docs(wave4)` 提交。每个提交都带 `Co-Authored-By: Claude Opus 5.5`，没有 push，没有建 PR。没有 BLOCKED 项。范围外改了几个文件，都是任务书要求的直接后果，理由见「未做 / 越界项」。

## 做了什么

| 提交 | 内容 |
|---|---|
| `51c9142` feat(shared) | `Workspace.vcs: 'git' \| 'none'`、`defaultBranch?`（core 与 shared 两份一致）；没有 vcs 的旧记录按 git 读；`Dispatch.mode?: 'in-place'` 与快照解析；测试夹具补 `vcs: 'git'` |
| `c675652` feat(main) | 任意目录都能挂入；git 仓库子目录先弹确认框（挂仓库根目录 / 仍然挂入该子目录 / 取消） |
| `8b51f23` feat(agent-runtime) | 工具描述与工具结果的非 git 文案；`IN_PLACE_ORCHESTRATOR_PROMPT`、`IN_PLACE_WORKER_CONTRACT_PROMPT`；`buildRolePromptAppend` / `createRoleSession` 的 `inPlace` |
| `6e9eb89` feat(main) | 编排 host / service 的 in-place 路径：派发、review、run_checks、merge、cleanup、打回、指示，全程不调用 git |
| `059e74b` feat(main) | spawn spec 带 `inPlace`（Main 每次 spawn 时按工作区决定）；派发的 worker 会话没有 worktree 时不记 `worktreeId` |
| `cec41f9` feat(renderer) | 侧栏「无 git」徽标；标题行 / 状态栏不显示分支；编排面板不显示分支、「改动」是「无 git」空态；通用页统计行显示「无 git」 |
| `3132051` docs | ARCHITECTURE §4 / §5 / §6 / §9.5 回写契约（范围外，可单独丢弃） |

### 1. 挂入（任务书第 1 条）

- `gitRepository.ts`：`inspectGitRepository` 改为 `inspectDirectory`，结果带 `vcs`：
  - git 仓库根目录 → `vcs: 'git'`，默认分支探测同以前；
  - 不是 git 仓库，或没装 git → `vcs: 'none'`（普通目录），不再报错；
  - 仓库子目录 → 仍不静默提升为外层仓库，返回 `not-repo-root` 和 `repoRoot`；
  - `plain: true` 时不跑 git，直接按普通目录（用户选了「仍然挂入该子目录」）。
  - 磁盘根目录（如 `D:\`）没有目录名，用路径本身当名字，免得空名字的记录下次启动被丢掉。
- `workspaces.ts`：`addDirectory(dir, { plain })` 按检查结果写 `vcs`，git 才写 `defaultBranch`；子目录原样返回 `not-repo-root`（带 `repoRoot`，只在 Main 内部用）。
- `ipc/workspaces.ts`：
  - 目录框标题「挂入目录」；
  - 子目录时 Main 弹原生确认框：标题「挂入目录」，正文「所选目录位于 git 仓库内」，说明「仓库根目录：<路径>」「仍然挂入该子目录时按无 git 目录使用，不建 worktree。」，按钮「挂入仓库根目录」「仍然挂入该子目录」「取消」；
  - 选根目录就挂根目录（git），选子目录就按普通目录挂（不跑 git），取消返回 `canceled`。Renderer 仍然不传路径。
- 失败码收成 `canceled` / `failed`（`not-git-repo`、`git-unavailable` 不会再出现）；Renderer 只用到 `canceled`。
- 同一目录重复挂入仍返回已有记录，**不改它的 vcs**（见注意事项 4）。

### 2. 会话（第 2 条）

- 普通会话在普通目录里照常工作（cwd = 目录），Main 不用改。
- 标题行与状态栏的分支：`SessionBadges.tsx` 新增 `useSessionBranch`，ChatView / StatusBar 改用它；无 git 工作区的会话不显示分支。
  - 按工作区判断，而不是看 git 读不读得到：按普通目录挂入的仓库子目录，Main 的 `readGitBranch` 读得到外层仓库的分支（真机冒烟证实读到 `main`），但界面不显示。
  - `src/main/services/sessions/**` 没改：真正不是 git 的目录已经读不到分支（`branches.test.ts` 已有用例）。

### 3. 编排（第 3 条）

Main（`orchestration/host.ts`、`service.ts`）：

- `service.hostFor`：`vcs: 'none'` 不读当前分支（子目录里 git 会读到外层仓库），`coordinatorBranch` 为空串。
- `dispatch_task`：不建 worktree、不算 worktree 根目录；worker 会话的 cwd 是工作区目录、不带 `worktreeId`；Dispatch 记 `mode: 'in-place'`，`worktreeId` / `branch` 为空串。会话起不来时没有 worktree 要回滚。并行任务共用目录，不拦（任务书是「建议」）。
- `review_diff`：返回 `mode: 'in-place'` 与这个任务各次尝试里 worker 汇报的 `files_modified`（去重、按汇报顺序），其余字段为空。
- `run_checks`：在工作区目录里跑，白名单照旧。
- `merge_worktree`：无需合并，`in-review` 的任务直接 `completed`；没汇报 / 汇报失败的照旧拒绝，已完成的报「already accepted」。
- `cleanup_worktree`：无需清理，只停 worker；没完成的任务照样放弃（进行中的尝试按 failed 结算），改动留在目录里；重复调用也返回 ok。
- `reject_work` / `send_to_worker`：in-place 的尝试不再要求 worktree；打回的新尝试沿用 `mode`，反馈里写「在工作区目录里改（无 git：不要提交）」而不是「在 worktree 里提交」。
- 面板的 `orchestration:review-diff` 对 in-place 尝试返回「dispatch … has no diff: the workspace has no git」（面板本身不会去调）。

agent-runtime：

- 工具描述（`orchestrationTools.ts`）：`dispatch_task`、`review_diff`、`run_checks`、`merge_worktree`、`cleanup_worktree` 各加一句没有 git 时的行为。
- 工具结果：
  - `dispatch_task` 写「works in: the workspace directory itself (no git: no worktree or branch)」，并提示「No git: the worker edits files directly in the workspace directory, and every running worker shares it. Dispatch one task at a time unless their files are strictly disjoint.」；
  - `list_workers` 写「in place (no git)」代替分支；
  - `review_diff` 写「No git: … there is no diff to show」并列出汇报的文件（一个都没有时提示 read_worker_output / reject_work）；
  - `merge_worktree` 写「## Accepted (no git) … nothing to merge … the task is completed」；
  - `cleanup_worktree` 写「nothing to clean up … the changes it made stay in the workspace directory」。
  - 为此 `host.ts` 的 review / merge / cleanup 输出类型加了可选的 `mode: 'in-place'`。
- 提示词（`orchestratorPrompt.ts`）：
  - `IN_PLACE_ORCHESTRATOR_PROMPT`：追加在工具说明之后，逐个说明受影响的工具，建议一次只派一个任务，说明放弃的任务改动收不回、不要叫 worker 提交；
  - `IN_PLACE_WORKER_CONTRACT_PROMPT`：没有自己的 worktree / 分支、目录可能有别的 worker 在改、不跑会写的 git 命令、`files_modified` 要列全（主 agent 只能靠它找改动）；其余几条与原契约共用。
  - git 模式的契约改成由共用条目拼出，改前改后逐字比对一致（临时测试导出全文比较，已删）。
- **由 Main 在 spawn 时决定**：`agentHost.buildSpec` 看会话所在工作区的 `vcs`，spawn spec 带 `inPlace: true` → worker 进程（`piSession.ts`）→ `createRoleSession({ inPlace })` → `buildRolePromptAppend`。Main 不加载 agent-runtime，所以提示词文本留在 agent-runtime，Main 只传开关。

### 4. 编排面板（第 4 条）

- 任务卡片与任务详情：in-place 的尝试不显示分支；任务详情里没有「查看改动」按钮（点过去只有空态），汇报的改动文件照常列在尝试下面。
- 「改动」tab：无 git 工作区不带计数，内容是「无 git」空态；选中某个 in-place 尝试时同样显示「无 git」（兜底）。

### 5. 通用页（第 5 条）

- worktree 磁盘占用里，无 git 工作区那一行只有名字和「无 git」徽标（悬停「不会使用 worktree」），不显示新建位置、大小与 worktree 数。

### 6. 其他界面（极简）

- 侧栏：无 git 工作区用普通文件夹图标，名字后一个小徽标「无 git」，悬停「不会使用 worktree」；挂入按钮与空态按钮改叫「挂入目录」。
- 中栏（`MainArea.tsx`，范围外）：默认分支变成可选，只在有时显示，免得普通目录出现一个空的分支图标；空态按钮同样叫「挂入目录」。

## 怎么验证

**基线**（`918a0e8`）：typecheck 0；lint 0（379 个文件）；test 127 个文件 / 1852 个用例全过。

**验收命令**（最终代码提交 `3132051`，根目录，按顺序）：

```
pnpm typecheck  → exit 0
pnpm lint       → exit 0：Checked 379 files … No fixes applied.
pnpm test       → exit 0：Test Files 127 passed (127)；Tests 1901 passed (1901)
pnpm build      → exit 0：out/main/index.js 341.44 kB、out/main/chunks/index-<hash>.js 136.60 kB、out/preload/index.cjs 13.10 kB；没有 warning
                  out/main/index.js 里 @earendil-works 出现 0 次
```

**新增用例**（+49 = 1901 − 1852，都加在已有测试文件里）：

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `core/orchestration/store.test.ts` | +2 | 快照保留 `mode: 'in-place'`；未知 mode 拒绝 |
| `shared/types/workspace.test.ts` | +6 | 旧记录无 vcs → git；普通目录无默认分支；拒绝未知 vcs、大小写不同、默认分支非字符串 / 空串 |
| `shared/types/agent.test.ts` | +3 | spawn spec 的 `inPlace`：合法样本、false 不保留、非布尔拒绝 |
| `main/services/gitRepository.test.ts` | +2 | **真实 git**：普通目录、仓库根、子目录返回 `repoRoot`、`plain` 下子目录按普通目录；注入 runner：没装 git → 普通目录、`plain` 不跑 git |
| `main/services/workspaces.test.ts` | +3 | 普通目录写入与视图、`plain` 原样交给 inspect、子目录 / 出错原样返回且不写入 |
| `main/ipc/workspaces.test.ts` | +5 | **三种目录**：普通目录、git 根、子目录三个选项（根 / 子目录 / 取消）；确认框按钮与 detail；重复挂入不广播；用例之间不再互相依赖 |
| `agent-runtime/prompts/orchestratorPrompt.test.ts` | +6 | 两段新提示词的内容；`inPlace` 时追加位置、只加一次、不重复角色提示词里的内容；只读 worker 也换契约；非 orchestrator 不加编排说明 |
| `agent-runtime/session/createRoleSession.test.ts` | +1 | **真实 pi 会话**（faux 模型）：`inPlace` 的 orchestrator 系统提示词里非 git 段出现一次，worker 是非 git 契约、没有 worktree 契约 |
| `agent-runtime/tools/orchestrationTools.test.ts` | +6 | 五个工具在 in-place 下的结果文本；工具描述都提到没有 git 时的行为 |
| `main/services/orchestration/host.test.ts` | +11 | **假 launcher**：dispatch（cwd、无 worktreeId、in-place）、并行共用目录、会话起不来、review（各次尝试的文件并集）、run_checks 的 cwd 与白名单、merge、cleanup（完成 / 放弃 / 重复）、打回、指示、排队补派；每条都断言**没有任何 git 调用、没算 worktree 根目录** |
| `main/services/orchestration/service.test.ts` | +1 | 不读分支；落盘后新实例读回 in-place；面板 reviewDiff 报没有 diff |
| `main/services/orchestration/registry.test.ts` | +1 | 普通目录工作区派发不建 `<目录>-worktrees`、不跑 git，worker 反查得到 |
| `main/services/orchestration/orchestration.integration.test.ts` | +1 | **真实目录**（临时普通目录，不依赖 git）：派发 → worker 写 hello.txt → report_done → wait → review → `node check.js` 读到文件 → 验收 completed → cleanup；所有 exec 调用都记下来：**0 次**；快照重载后仍是 in-place |
| `main/services/agentHost/agentHost.test.ts` | +1 | 无 git 工作区的 orchestrator / 派发 worker 的 spawn spec 带 `inPlace`、worker 会话没有 worktreeId；git 工作区不带 |
| `agent/piSession.test.ts` | 扩展 | `inPlace` 原样交给 createRoleSession |

**变异验证**（改坏 → 跑对应测试 → 恢复）：host 里 `inPlace` 恒为 false → 11 例失败；去掉 merge 的 in-place 分支 → 3 例；service 照旧读分支 → 2 例；打回不沿用 mode → 2 例。

**真机冒烟**（`pnpm dev`，隔离 userData，本地假 Anthropic SSE 端点，不联网；脚本与日志在 `%TEMP%\fynvra-t28-smoke-ltvz3n\`）：

- 准备：临时普通目录 `plain\notes`（放一个 `check.js` 读 hello.txt，作验收命令）、临时 git 仓库 `repo`（`main`，一个提交）和它的子目录 `repo\docs`。从 PowerShell 用 `Start-Process pnpm.cmd` 起 `exec electron-vite dev --remoteDebuggingPort 9528 --inspect 9529 -- <不节流开关>`，结束时只停命令行里带本 worktree 路径的 electron。
- 原生目录框与确认框经 Main inspector 换成脚本应答（记录收到的参数）；挂入、写入、广播、会话、编排、界面都是真实代码。假端点按对话推进：orchestrator 依次调 dispatch_task → wait_for_workers → review_diff → run_checks → merge_worktree → cleanup_worktree；worker 调 write 写 hello.txt → report_done；每次请求记下系统提示词里有没有各段、上一个工具结果原文。
- 第一轮 42 项检查全部 PASS（`report-run1.json`，`SMOKE OK`）：
  1. **挂入**：notes → `vcs: 'none'`、没有默认分支、不弹确认框，目录框标题「挂入目录」；docs → 弹确认框（三个按钮，detail 是仓库根目录），选「仍然挂入该子目录」→ `vcs: 'none'`；再挂 docs 点「取消」→ `canceled`、没有写入；repo → `vcs: 'git'`、默认分支 main。
  2. **侧栏**：notes、docs 是 `lucide-folder` 图标加「无 git」徽标（title「不会使用 worktree」），repo 是 `lucide-folder-git-2`、没有徽标；挂入按钮叫「挂入目录」。中栏：notes 没有分支图标，repo 显示 `main`。
  3. **编排**：在 notes 新建 orchestrator 会话，发「SMOKE-ORCH: Create hello」：
     - `hello.txt` 出现在 notes 里，内容 `hello from fynvra`；notes 里没有 `.git`，旁边没有 `notes-worktrees`；
     - 快照：任务 completed，尝试 `mode: 'in-place'`、`worktreeId` / `branch` 为空、`filesModified: ['hello.txt']`，没有登记 worktree；
     - worker 会话 cwd 是 notes、没有 worktreeId，auto-edits 下 write 不用审批；
     - 假端点：orchestrator 的 7 次请求都带工具说明和「# This workspace has no git」；worker 的 2 次请求是非 git 契约、没有 worktree 契约；key 只有 `smoke-local-key`；
     - 模型实际收到的工具结果：dispatch_task 写着在工作区目录里干活、「Dispatch one task at a time…」；wait 收到 worker_done；review_diff「there is no diff」并列出 `hello.txt`；run_checks「Checks passed」，输出 `hello from fynvra`（证明在工作区目录里跑）；merge「Accepted (no git)… nothing to merge」；cleanup「nothing to clean up」。
  4. **界面**：notes 的会话标题行与状态栏没有分支；编排面板的任务卡片没有分支，任务详情没有分支、没有「查看改动」，改动文件（1）照常列出；「改动」tab 没有计数，内容是「无 git」。设置 → 通用：notes、docs 两行是「notes 无 git」「docs 无 git」，repo 一行照常有「新建：…\repo-worktrees」「0 个 worktree」。
  5. **子目录的分支**：docs 的会话里 Main 读到外层仓库的分支 `main`（`sessions.list` 里有），标题行与状态栏都不显示。**对照**：repo 的会话标题行与状态栏显示 `main`。
  6. 控制台 0 个 error / warning；dev 日志没有错误；结束后本 worktree 没有残留进程，9528 / 9529 已释放。
- 第二轮（同一个 userData 重启 dev，5 项检查全部 PASS，`report-run2.json`，`SMOKE2 OK`）：三个工作区的 vcs 不变；没有 worktreeId 的 worker 会话照常读回；编排快照读回 in-place 的尝试与 completed 的任务；面板读 worker 输出可用，reviewDiff 对 in-place 尝试如实报没有 diff。
- 没有截图；结论来自 DOM、IPC、磁盘与假端点日志。临时目录只含假 key，可以整个删掉。

## 未做 / 越界项

- **范围外修改**（都是任务书要求的直接后果）：
  1. `packages/core/src/types.ts`、`orchestration/store.ts`（+ `store.test.ts`）：
     - `src/shared/types/workspace.ts` 注明「字段与 core 的 Workspace 保持一致」，而且 `ipc/orchestration.ts` 把 shared 的 Workspace 交给按 core 类型声明的注册表：shared 的 `defaultBranch` 变可选、加 `vcs`，core 必须跟着改，否则类型不兼容。
     - 任务书要 Dispatch 记 `mode: 'in-place'`；快照解析会丢掉未知字段，不加进 schema 重启后就没了。
  2. `packages/agent-runtime/src/host.ts`：review / merge / cleanup 的输出类型加可选 `mode`，工具才能按 in-place 写结果文本（任务书范围里的 `orchestrationTools.ts` 依赖它）。
  3. 「由 Main 在 spawn 时按工作区 vcs 决定是否追加」需要一条从 Main 到 worker 进程的通道：`src/shared/types/agent.ts`（spawn spec 的 `inPlace` 与解析，+ 测试）、`src/agent/piSession.ts`（+ 测试）、`packages/agent-runtime/src/session/createRoleSession.ts`（+ 测试）、`src/main/services/agentHost/agentHost.ts`（`buildSpec` 一处，+ 测试）。每处 1–5 行。
     - 考虑过让 Main 直接把文本拼进 `role.systemPrompt`：Main 不加载 agent-runtime，文本就得挪到 Main，和其余编排提示词分家，worker 契约也没法按模式切换，放弃了。
  4. `agentHost.ts` 的 launcher：派发的 worker 没有 worktree 时不记 `worktreeId`。若记成空串，sessionStore 的解析会拒绝整条会话记录，下次启动会话就丢了。
  5. `src/main/services/orchestration/launcher.ts`：`worktreeId` 变可选（与 host 同目录的接口文件）。
  6. `src/renderer/components/layout/MainArea.tsx`：`defaultBranch` 变可选后，不改会给普通目录渲染一个空的分支图标；顺带把空态按钮改成「挂入目录」。
  7. 测试夹具补 `vcs: 'git'`（类型要求）：`agentHost.test.ts`、`roundTrip.test.ts`、`connectOrchestration.integration.test.ts`、`worktreesRoot.test.ts`、`src/shared/types/settings.test.ts`（各一处）。
  8. `docs/ARCHITECTURE.md`：契约回写，单独一个提交，代码不依赖它。
- **按任务书没动**：settings 的 Preferences、`SettingsView.tsx`、chat 的 Composer / 时间线；`src/main/services/sessions/**`（非 git 目录本来就读不到分支）。
- 用户全局说明里的知识库检索（`maestro spec` / `maestro wiki`）本机不可用：没有 `maestro` 命令，`~/.maestro` 也不存在，与前几张卡相同。

## 给验收人的注意事项

1. **与 Task 26（`LAIJiangFeng/general-settings`）合并有一处冲突**：`GeneralSettings.tsx` 的 import 段相邻两行——它把 `@/stores/settings` 那行改成 `{ useGeneralPreferencesStore, useWorktreesRootStore }`，我在它后面加了 `import { useWorkspacesStore } from '@/stores/workspaces';`（Biome 的 import 排序决定它只能在那里）。两行都保留即可；`git merge-tree` 显示其余部分无冲突。与 `keybindings`、`notifications` 两个分支模拟合并无冲突。
2. **一次没复现的测试失败**：提交 `6e9eb89` 之前的一次全量 `pnpm test` 报 1 个用例失败（输出被我截短，没看到是哪个），之后 10 次全量运行（含 JSON reporter 一次）全过。JSON 计时里最慢的是两个已有的真实 git 集成用例（5.9 s / 5.7 s，各自把超时放宽到 90 s / 120 s）；我新增或改写的用例最慢 1.4 s（真实 git 挂入）。怀疑是机器负载下某个已有的计时敏感用例，没有证据，如实记在这里。
3. **并行派发不拦**：无 git 时几个 worker 共用同一个目录，工具结果和提示词都建议一次派一个、文件严格不相交才并行，但 Host 不强制（任务书是「建议」）。
4. **重复挂入不改 vcs**：一个普通目录之后 `git init` 了，再挂入同一路径仍返回原记录（`vcs: 'none'`）；要用 worktree 需要先从列表移除再挂入（新的工作区 id，旧会话仍挂在旧 id 下，与现有移除行为一致）。原因：编排注册表按工作区缓存了服务，运行中改 vcs 要连带重建，超出本卡。
5. **git 读失败一律按普通目录**：`git rev-parse --show-toplevel` 失败的原因不止「不是仓库」，还有 dubious ownership 之类；这些情况现在也按普通目录挂入，侧栏的「无 git」徽标能让用户看出来。没装 git 同理。
6. **cleanup 收不回改动**：无 git 时放弃任务，worker 已经写的文件留在目录里；提示词与工具结果都这么说，并让主 agent 把文件告诉用户。
7. **分支只在界面上不显示**：按普通目录挂入的仓库子目录，Main 照样读出外层仓库的分支（`SessionSummary.branch` 有值），只是标题行 / 状态栏不显示。想在 Main 里就不读，要改 `ipc/sessions.ts` 或 agentHost 的分支读取（本卡范围外）。
8. **orchestrator 的 `git_readonly`** 在普通目录里照常可用：真不是仓库时 git 报错给模型；仓库子目录时看到的是外层仓库。提示词没禁止它。
9. 确认框与按钮文案按「极简」取：确认框正文一句、说明两行（仓库根目录、子目录的后果），侧栏徽标只有「无 git」，说明放在悬停提示里。
