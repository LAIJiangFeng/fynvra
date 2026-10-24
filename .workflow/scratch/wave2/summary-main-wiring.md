# Summary · Task 11 main-wiring（在 Main 把 agentHost、orchestration、providers / roles / skills / mcp 接成一条链）

分支 `LAIJiangFeng/main-wiring`。worktree 建在 `f5c2e91`（Initial commit）上。开工前先用 `git merge --ff-only main` 快进到 `main@9b5be7b`，在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`（没有产生改动），再 `pnpm install --frozen-lockfile`。`main` 本身没动，写总结时也没有前进。

相对 `9b5be7b` 有 9 个改动提交，涉及 28 个文件（+1043 / −428），另有本总结的 `docs(wave2)` 提交。每个提交都带 `Co-Authored-By: Claude Opus 5.5`。未 push、未建 PR。全部改动都在任务书范围内（`git diff --stat main..HEAD` 已核对）。有一个 BLOCKED 项，与本卡代码无关：`main` 上原有的两个 lint 错误。

## BLOCKED

**验收标准「`pnpm lint` 全绿」不改范围外的文件就做不到。** `main@9b5be7b` 上 `pnpm lint` 本来就失败（开工时的基线），原因是三张 Wave 2 卡合并后留下了两处没排序的 import：

```
src\main\ipc\index.ts:1:1 assist/source/organizeImports  FIXABLE
src\preload\index.ts:1:1  assist/source/organizeImports  FIXABLE
```

`src/main/ipc/index.ts` 不在本卡范围内，`src/preload/**` 任务书明确写了不要动，所以我没有改。本卡的改动全部 lint 干净：`biome check .` 共检查 242 个文件，只报上面这两条，两个文件都没被本卡碰过。

需要验收人决定（或在集成分支上直接执行）。下面这条命令只重排这两个文件的 import，不改行为：

```bash
pnpm exec biome check --write src/main/ipc/index.ts src/preload/index.ts
```

`typecheck`、`test`、`build` 都全绿，见「怎么验证」。

## 做了什么

| 提交 | 内容 |
|---|---|
| `731f4f8` build(agent) | `tsconfig.node.json` 的 include 加 `src/agent/**/*`；`biome.json` 给 `src/agent/**` 加 electron 禁令 |
| `044633e` feat(agent) | worker 按 `ResolvedModelSpec.providerId` 注册 pi provider |
| `1fe51f0` feat(agent) | 角色的 MCP 服务器映射成 pi 配置时显式带上 `type: 'stdio' \| 'http'` |
| `de5981c` feat(main) | `resolveResources`：按角色取技能路径与 MCP 服务器；`createAppAgentHost` 复用 roles IPC 的 RoleStore 单例 |
| `f8c81cf` feat(main) | `createModelResolver()` 替换 `envModelResolver`；修复接口不一致：会话把运行时 provider 键当成设置引用存了下来 |
| `cb741b1` feat(main) | worker 会话的 `parentSessionId` 经 Run 反查 coordinator；用测试钉住 launcher 约定 |
| `24882a7` feat(main) | `connectOrchestration()`：在 `src/main/index.ts` 把 agent host 与编排注册表接起来 |
| `c57904f` test(main) | Main 层端到端集成测试（真实 git） |
| `f8a1d89` docs | 回写 ARCHITECTURE §1 / §9.1 / §9.5 |

### 1. ModelResolver（任务书第 1 条）

- `createAppAgentHost` 改用 `createModelResolver()`（读 providers.json）。删掉了 `envModelResolver.ts`、它的测试和 `ENV_MODEL_SECRET_VARS`。`electronWorker.ts` 不再过滤环境变量，只设置 `PI_CODING_AGENT_DIR`：key 只经 `spawn-session` 交给 worker，本来就不走环境变量。
- **worker 侧**（`src/agent/models.ts`）直接以 `spec.providerId` 作为 pi provider 名调用 `registerProvider`，不再自己哈希 api / baseUrl / key 生成一份键。
  - 模型能力取 pi 内置目录里同 id、同 api 的模型；查不到时用 spec 自带的字段（id、api、baseUrl）加保守默认值（上下文 128k、输出 32k、无 reasoning）。
  - spec 没给 baseUrl 时，用该协议的官方地址。
  - key 仍然用 `setRuntimeApiKey` 只放在内存里。
  - **新增的护栏**：不带 `fynvra-` 前缀的 provider 名直接报错（session-error），不注册。原因是 `anthropic` 这类不带前缀的名字就是 pi 内置的 provider，`registerProvider` 会整个替换掉它的模型目录。`createModelResolver` 产出的键都带这个前缀。
- **接口对齐时发现并修掉的 bug**（这是本卡最需要验收人注意的改动，见注意事项 2）：
  - `createModelResolver` 返回的 `ResolvedModelSpec.providerId` 是运行时 provider 键（`fynvra-<sha256(baseUrl+key) 前 16 位>`）。
  - 但 agent host 在 `create` / `createWorkerSession` 里把 `resolved.model.providerId` 存成了会话的 `model.providerId`，每次 spawn 再拿它去解析。直接换上 `createModelResolver` 的话，**所有会话第一次发消息都会失败**，报「模型服务 fynvra-… 不存在」。
  - 我先写测试复现：会话记录里出现 `providerId: "fynvra-d6a140b7a38b45c4"`，14 个用例连锁失败。
  - 修法：`ModelResolver.resolve` 的成功结果多返回一个 `ref`，即实际解析到的**设置里的**服务 id 和模型 id；不指定模型时，就是选中的那个默认服务和模型。会话记录与 `SessionSummary.model` 存 `ref`，所以 Renderer 能按它找到对应的模型服务；之后每次 spawn 再按它解析。
  - `resolveModel.ts` 删掉自己声明的那份 `ModelResolver` / `ResolvedModelSpec`，改为实现 `agentHost/types.ts` 的接口；`Role.model`（带 thinking）仍可以直接传入。
  - §9.5 的接口文本同步更新了（见第 8 条）。

### 2. resolveResources（第 2 条）

- 新文件 `src/main/services/agentHost/roleResources.ts`，导出 `createRoleResourceResolver({ skills, mcpServers })`。生产环境接 `getSkillRegistry()` / `getMcpRegistry()`。
- **技能**：`role.skillIds` 中 `enabled` 的条目，按角色里的顺序取 `path`。
- **MCP**：`role.mcpServerIds` 中 `enabled` 的条目，`name` 用注册表 id。stdio 映射为 `{ command, args, env }`，http / sse 映射为 `{ url, headers }`。
  - 协议里的 `AgentMcpServer`（`src/shared`）没有 transport 字段，worker 的 parser 也会丢掉未知字段，所以 `type: 'stdio' | 'http'` 由 worker 的 `toMcpServerConfig` 显式补上（提交 `1fe51f0`）。
  - 注册表 id（`[a-z0-9-]`）总是满足 pi 对服务器名的要求。
- 同一个 id 在角色里出现多次，只取一次。停用的条目不加载，也不告警。
- **引用了已删除的 id**：跳过，并作为 `warnings` 返回。`RoleResources` 因此新增 `warnings` 字段；agent host 在 spawn 时按会话写进日志（`session <id>: …`），与 worker 处理自己 session warnings 的方式相同。警告文本里不带 env / headers 的值。
- 角色没有引用技能或 MCP 时不读注册表；每次 spawn 都会重读注册表（注册表有内存缓存），设置页的修改对之后启动的会话生效。
- env / headers 明文只出现在 `spawn-session`（Main → worker）。测试断言 Renderer 收到的推送里没有这些值。
- RoleStore：`createAppAgentHost` 改用 roles IPC 的 `getRoleStore()` 单例，不再另外 new 一个。

### 3. orchestration 接线（第 3 条）

- 新文件 `src/main/services/agentHost/connectOrchestration.ts`。`src/main/index.ts` 在 `whenReady` 里调用它，**先 await，再** `agentHost.start()` 和打开窗口：

  ```ts
  registry.setLauncher(agentHost.implementsLauncher());
  agentHost.setOrchestrationHostFactory((coordinatorSessionId, workspaceId) => registry.hostFor(coordinatorSessionId, workspaceId));
  agentHost.setWorkerHostFactory((sessionId) => registry.workerHostFor(sessionId));
  agentHost.setCoordinatorLookup((workspaceId, runId) => registry.coordinatorOf(workspaceId, runId)); // 第 4 条
  await registry.openAll();
  ```

- 接线写成一个函数而不是直接写在 `index.ts` 里，是为了让端到端测试调用与生产**同一段**接线代码。
- 退出时：agent host 关闭之后再 `registry.flushAll()`，失败只记日志，照常退出。
- `agentHost/types.ts` 的 `WorkerSessionLauncher` 改为从 `orchestration/launcher.ts` import（删掉了结构相同的副本）。
- 编排 README 的「接线」一节改成指向真实代码。

### 4. launcher 约定核对（第 4 条）

逐条核对结果：

| 约定 | 原实现 | 处理 |
|---|---|---|
| `createWorkerSession` 提交 brief 后立即 resolve | 已满足：发出 `prompt` 命令即返回，不等这一轮跑完 | 加测试钉住 |
| `promptSession` 在会话空闲时开启新一轮 | 已满足：空闲时发 `prompt`，supervisor 当作新一轮 | 加测试钉住 |
| WorkerHost 工厂在 host 调用到达时再取 | 已满足：`runHostCall` 每次调用时才查 | 加测试：Dispatch 写入前的调用拿不到 Host，写入后的调用拿得到 |
| worker 会话的 `parentSessionId` = coordinator | **不满足**：一直没设 | 已修，见下 |

- launcher 入参只有 `runId`，而且 `createWorkerSession` 被调用时 Dispatch 还没写入（Host 在它 resolve 之后才写），所以没法走 dispatch → run。但 Run 在启动 worker 之前就已经落库，所以直接按 runId 反查：
  - orchestration service / registry 新增只读的 `coordinatorOf(workspaceId, runId)`（「小修」范围内）；
  - agent host 新增 `setCoordinatorLookup`，由 `connectOrchestration` 注入。
  - 没接线、或者 run 不存在时，不设 `parentSessionId`，与原来的行为一致。

### 5. 类型护栏（第 5 条）

- `tsconfig.node.json` 加入 `src/agent/**/*` 后，`typecheck:node` 0 错误，`--listFilesOnly` 核对过 10 个 `src/agent` 文件都在程序里。
- `biome.json` 的 electron 禁令：探针文件 `src/agent/__probe.ts`（`import { app } from 'electron'`）被 `lint/style/noRestrictedImports` 报错，报的是新加的那条提示。探针已删除。

### 6. 端到端集成测试（第 6 条）

- 文件：`src/main/services/agentHost/connectOrchestration.integration.test.ts`。
- **用的都是真实组件**：
  - `createAgentHost`，worker 由 agent-host 已有的 `InMemoryWorker` 代替（经两端协议 parser 到真实的 `SessionSupervisor`）；
  - 真实的 `createOrchestrationRegistry`、`nodeExec` 和临时 git 仓库；
  - 生产用的 `createModelResolver`（读内存里的 provider 列表）；
  - 与 `index.ts` 同一个 `connectOrchestration`。
- **假的只有模型**：两个 `ScriptedSession`。
  - orchestrator 依次调用 `dispatch_task` → `wait_for_workers` → `read_worker_output` → `review_diff` → `merge_worktree` → `cleanup_worktree`；
  - worker 在 worktree 里用真实的 git 子进程提交，然后 `report_done`。
- **断言**：
  - `dispatch_task` 成功；
  - worker 会话的 `parentSessionId` 是 coordinator，`dispatchId`、`worktreeId`、`cwd` 正确，`model` 是设置里的引用；
  - `wait_for_workers` 收到来自 worker 的 `worker_done`；
  - worker 输出经 launcher 的 transcript 能读到；
  - `main` 上有 `--no-ff` 合并提交（2 个父提交），README 内容正确；
  - worktree 目录、git 的 worktree 记录和 `fynvra/*` 分支都被清理；
  - `userData/orchestration/ws_1.json` 落盘：task `completed`、dispatch `succeeded`、worktrees 为空、`worker_done` 已 ack。
- `InMemoryWorker` / `ScriptedSession` 从 `roundTrip.test.ts` 挪到 `agentHost/testing.ts` 两边共用，写法同 `orchestration/testing.ts`。

### 7. 真机冒烟（第 7 条）

结果见「怎么验证 · 真机冒烟」：本机 `pnpm dev` 下整条链路走通。

### 8. ARCHITECTURE 回写（第 8 条）

- **§1**：持久化表改为 `userData/orchestration/<workspaceId>.json`。
- **§9.1**：preload 领域文件导出 `create<Domain>Api` 工厂、不 import electron，并写明理由。
- **§9.5**：
  - `createOrchestrationHost` 的 deps 补上 `worktreesRoot` / `exec` / `checkPolicy?` / `now?`；
  - `createWorkerHost` 补上 `now?`；
  - **任务书范围之外，但属于必要的契约变更**：`ModelResolver` 的结果多了 `ref`（新增 `ModelRef` 类型），并写明 `ResolvedModelSpec.providerId` 是运行时 provider 键。文档头写着「改动契约必须先改本文」，所以一起回写；
  - 补了一段接线说明。

## 怎么验证

**验收命令**（最终提交，根目录）：

```
pnpm typecheck  → exit 0（node / web / packages 三段，0 个 error TS）
pnpm lint       → exit 1：Checked 242 files；只有 BLOCKED 里那两条 main 原有的 organizeImports
pnpm test       → exit 0：Test Files 79 passed (79)；Tests 983 passed (983)（基线 77 / 970）
pnpm build      → exit 0：out/main/index.js 226.26 kB、out/main/chunks/index-<hash>.js（worker）99.32 kB、
                  out/preload/index.cjs、out/renderer/…
```

- 构建产物：`out/main/index.js` 里 `@earendil-works` 出现 0 次（pi 没有进主进程）；worker chunk 只外部 import `pi-ai`、`pi-coding-agent` 和 Node 内置模块。

**测试增减**（+13 = 983 − 970）：

| 文件 | 变化 | 覆盖 |
|---|---|---|
| `agentHost/roleResources.test.ts` | 新增 6 | 技能顺序与停用、MCP 三种传输方式的映射、已删除 id 告警（不带密钥）、去重、不读注册表、每次重读 |
| `agentHost/connectOrchestration.integration.test.ts` | 新增 1 | 第 6 条的端到端链路（真实 git） |
| `src/agent/piSession.test.ts` | 新增 3 | `toMcpServerConfig` 的 stdio / http 映射与可选字段 |
| `src/agent/models.test.ts` | 4 → 6 | 按 Main 的键注册、同键累积与不同键隔离、目录外模型的默认值、无 baseUrl 时用官方地址、未知 api、拒绝不带前缀的键且不改动内置目录 |
| `agentHost/agentHost.test.ts` | 21 → 25 | 资源进 spawn spec 与告警日志；设置引用存进会话并在 spawn 时重新解析；`parentSessionId`；launcher 约定三点 |
| `orchestration/registry.test.ts`、`service.test.ts` | 各 +1 | `coordinatorOf`（含「launcher 被调用时 Run 已落库」） |
| `agentHost/envModelResolver.test.ts` | 删除 −5 | 随实现删除 |
| `resolveModel.test.ts`、`roundTrip.test.ts` | 用例数不变 | 断言 `ref`；§9.5 类型钉子加上 `ref`；round-trip 改用 `createModelResolver` |

**TDD 的实际顺序**（如实说明）：

- 先写测试、跑红、再实现的：
  - `models.ts`：4 红 2 绿，绿的两条是原有行为；
  - `toMcpServerConfig`：函数未导出，3 红；
  - `roleResources`：模块不存在；
  - 设置引用的 bug：14 红；
  - `coordinatorOf`：2 红；
  - `parentSessionId`：1 红。
- launcher 约定的那条测试在现有实现上直接是绿的（约定原本就满足），这符合预期。
- 告警日志那一行代码写在测试之前。为此做了变异验证：去掉那行日志，测试失败 1 条，恢复后通过。

**端到端测试的有效性**：

- 实际执行，没有 skip。verbose 输出：`✓ … agent host ⇄ orchestration（真实 git） > dispatch_task → … → cleanup_worktree 1412ms`。
- 连续跑 5 次都通过。
- 变异验证：
  - 去掉 `setLauncher`：失败，报 `could not start the worker session: worker sessions are unavailable: the agent host is not connected to orchestration yet`，正是原来那个「未接线」错误；
  - 去掉 `setCoordinatorLookup`：失败，报缺 `parentSessionId`。
  - 两处都已恢复，`git status` 干净。

**真机冒烟**（`pnpm dev`，隔离的 userData，不联网）：

- **准备**：
  - 本机 dev 的 `%APPDATA%\fynvra-dev\providers.json` 不存在，没有可用的 key，所以按 agent-host 总结的办法，在 127.0.0.1 起了一个假的 Anthropic Messages SSE 端点。它按会话里已有的工具调用决定下一步，同时扮演 orchestrator 和 worker 两个模型。
  - 新 worktree 里没有 Electron 二进制，先执行了 `node node_modules/electron/install.js`：从本机缓存解压 v45.0.0，没有联网。
  - 临时目录：一个新的 git 仓库（README 一行说明），以及 `FYNVRA_USER_DATA_DIR`（`settings.json` 里预置了这个工作区）。
  - 启动：`pnpm dev --remoteDebuggingPort 9347`。
  - 驱动：脚本经 CDP 在页面里调用 `window.fynvra.*`，与设置页、聊天面板走同一套 IPC；结论全部来自 IPC 返回值、磁盘文件和 git，没有截图。
- **第 1 轮**（脚本自身的 bug）：
  - worker 一侧全部正常：Git Bash 执行 bash，提交 `2a2b6d5`，`report_done` 成功，task 变为 `in-review`，worker 会话带 `parentSessionId`。
  - 但假端点用正则从 dispatch_task 的结果里取 dispatch id 时，匹配到了字段名本身（`dispatch_id`），于是 `review_diff` 报 `unknown dispatch_id "dispatch_id"`。这是 fynvra 正确拒绝了非法 id。
  - 修正正则后，换新的仓库和 userData 重跑。
- **第 2 轮**（时间从发出 prompt 起算）：

  | 时间 | 观察到的事实 |
  |---|---|
  | 1.6 s | `providers.upsert`（设置页同一个 IPC）返回 `ok`，`hasApiKey: true`、`apiKeyHint: "-key"`，返回值里没有 key |
  | 1.6 s | `sessions.create({ roleId: 'orchestrator' })` 返回的 `model` 为 `{ providerId: "smoke-mock", modelId: "claude-sonnet-5-5" }`，是设置里的服务 id，不是运行时键 |
  | 3.2 s | task `Append README line:in-progress`；worktree `fynvra/append-readme-line` 出现，`git worktree list` 从 1 条变成 2 条；worker 会话 `running`，parent 指向 orchestrator |
  | 3.8 s | dispatch `succeeded`，task `in-review` |
  | 4.3 s | task `completed`，worktrees 为空，`git worktree list` 回到 1 条，orchestrator 空闲 |

  - **orchestrator 的工具调用**（取自 `sessions.history`）：`dispatch_task` / `wait_for_workers` / `review_diff` / `merge_worktree` / `cleanup_worktree` 全部是 `done`。
    - merge 输出：``merged into `main` as `ab43d93` ``；
    - cleanup 输出：`worktree removed: yes`、`branch deleted: yes`。
  - **worker 的工具调用**：`bash` 输出 `75c6157 docs: append a smoke line to README`，随后 `report_done` 成功。
  - **git**：`main` 为 `ab43d93 Merge branch 'fynvra/append-readme-line'`，有 2 个父提交；README 最后一行是 `Smoke test line added by the worker.`；分支只剩 `* main`。
  - **磁盘**：`userData/orchestration/ws-smoke.json` 中 tasks 为 `[completed]`，dispatches 为 `[succeeded]`，worktrees 为 0，messages 为 `[worker_done]`。providers.json 里有 key（只在 Main）。
  - **key 的去向**：假端点收到 8 个请求，`x-api-key` 全部匹配；Renderer 拿到的所有返回值里都没有 key；Renderer 控制台 0 个 error。
  - **退出**：经 IPC 关窗 → `before-quit` → worker 关闭会话 → flush → `pnpm dev exit: 0`。之后本 worktree 没有残留的 electron 进程，9347 端口已关闭。
- 冒烟脚本、日志和两轮的 `report.json` 留在 `%TEMP%\fynvra-smoke-ePtgdW`（在仓库外，只含假 key），可以直接删掉。

## 未做 / 越界项

- **越界修改**：没有。任务书范围之外，只回写了 §9.5 的 `ModelResolver.ref`，属于必要的契约变更，理由见第 1 条和第 8 条。
- **没有动 `src/main/ipc/orchestration.ts`（不在范围）**：它的 `getOrchestrationRegistry()` 仍然自己 new 一个 `JsonFileRoleStore`（而且没有传 `onInvalidFile`）。`JsonFileRoleStore` 每次都读磁盘、不缓存，所以和 `getRoleStore()` 读到的结果一致，功能上没有问题。以后可以统一改用 `getRoleStore()`。
- **没有修改 Windows 上 pi 找 shell 的方式**：需要改 `src/agent` 的 settings（`shellPath`）或 agent-runtime，不在本卡范围。见注意事项 1。
- **按 `approvalMode` 拦截工具调用**：仍未接线（agent-host 总结第 5 条），本卡不涉及。冒烟中 worker 的 bash 没有审批，直接执行了。
- 用户全局说明里的知识库检索（`maestro spec` / `maestro wiki`）本机不可用：没有 `maestro` 命令，`~/.maestro/workflows/coding-philosophy.md` 也不存在，与前几张卡的情况相同。

## 给验收人的注意事项

1. **自己在浏览器或终端测试之前请先看这一条：本机 worker 的 bash 很可能会走到 WSL，导致 git 提交失败。**
   - pi 在 Windows 上找 shell 的顺序是：先 `%ProgramFiles%\Git\bin\bash.exe`，再 PATH 上第一个 `bash.exe`。本机 Git 装在 `D:\Software\Git`，而 `where bash.exe` 第一个返回的是 `C:\Windows\System32\bash.exe`，即 WSL 启动器。
   - 实测：在 worktree 里经 WSL 执行 `git status`，报 `fatal: not a git repository: /mnt/c/…/C:/Users/…/.git/worktrees/…`。WSL 的 git 把 worktree 的 Windows `gitdir:` 路径当成了相对路径，所以 worker 的 `git commit` 会失败。
   - 冒烟时我把 `D:\Software\Git\bin` 放在 PATH 最前面绕过了这个问题。你自己测试时，可以先执行 `$env:Path = "D:\Software\Git\bin;$env:Path"; pnpm dev`。
   - 建议另开一张卡：在 `src/agent/piSession.ts` 给 `createRoleSession` 传入带 `shellPath` 的 SettingsManager，路径从 `git.exe` 的位置推出 `..\bin\bash.exe`。
2. **`ModelResolver` 契约多了 `ref`**（§9.5 已回写）。
   - 实现新的 resolver 时，要把实际解析到的设置引用一起返回。
   - 会话和 `SessionSummary.model` 里存的是**设置里的服务 id**；`spawn-session` 里的 `model.providerId` 是运行时键，两者不要混用。
   - 旧版 `envModelResolver` 时期建的会话，`model.providerId` 存的是 `anthropic` / `openai`。现在会按设置里同名的服务 id 去解析，找不到就返回「模型服务 … 不存在，请在「设置 → 模型服务」中添加」。
3. **worker 侧的护栏**：`ResolvedModelSpec.providerId` 必须带 `fynvra-` 前缀，否则这个会话启动失败（session-error）。`createModelResolver` 产出的键都带前缀；以后换别的 resolver，也要保留这个命名空间。
4. **MCP 的 env / headers 值会被 pi 展开**：`${VAR}` 当环境变量，`!cmd` 当命令执行。这是 pi 的 McpServerConfig 语义，与 Claude Code 的配置写法一致，值来自用户自己的 mcp.json。本卡原样透传，没有转义；如果想当作字面值处理，需要另行决定。
5. **端到端测试的时序前提**（给以后写测试的人）：
   - `InMemoryWorker` 用微任务投递消息，而 Host 在 `createWorkerSession` resolve 之后几个微任务才写入 Dispatch。
   - 生产环境里 IPC 消息是宏任务，worker 的 host 调用不可能插到这中间；测试里的 worker 脚本如果不做任何真实异步操作就立刻调 `report_done`，理论上可能抢在 Dispatch 写入之前。
   - 端到端测试里的 worker 先跑真实的 git 子进程，所以不受影响。
6. **合并冲突预期**：Task 08 / 09 如果也改了 `src/main/index.ts`，本卡只改了 `whenReady` 和 `before-quit` 两处，冲突很小；`agentHost/**`、`orchestration/**` 的其他卡应该没有碰。BLOCKED 里那两个文件如果由集成分支统一排序，后续卡在同一位置追加 import 时，需要再跑一次 `biome check --write`。
