# Summary · Task 05 agent-host（Agent worker 进程 + Main 会话管理 + sessions IPC）

分支 `LAIJiangFeng/agent-host`。worktree 照旧建在 `f5c2e91`（Initial commit）上。开工前（还没有任何提交）先确认 HEAD 是 `main` 的祖先，用 `git merge --ff-only main` 快进到 `main@387ac2d`，再在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`（之后 `git ls-files --eol` 里 `w/crlf` 为 0）。`main` 本身没动，写总结时也没有前进。

相对 `387ac2d` 有 14 个改动提交，涉及 43 个文件，另有本总结的 `docs(wave2)` 提交。每个提交都带 `Co-Authored-By: Claude Opus 5.5`。范围外只改了一处：`src/preload/index.test.ts` 的期望键列表（见「未做 / 越界项」）。没有 BLOCKED 项。

## 做了什么

| 提交 | 内容 |
|---|---|
| `7ebf16a` build(agent) | 根 `dependencies` 加 `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`（钉 1.4.0），锁文件 +6 行 |
| `8302e70` feat(shared) | `chat.ts`（§9.2 原文经 Biome 格式化）；`ipc.ts` 追加 `// --- sessions ---` 段 |
| `2347630` feat(shared) | `agent.ts`：Main ⇄ Worker 协议与收窄 parser |
| `94a7c1d` feat(agent) | host-invoke 代理（callId / 超时 / AbortSignal）与审批请求表 |
| `30019fb` feat(agent) | `SessionSupervisor`（多会话、generation、状态、host 代理） |
| `194b8c8` feat(agent) | utilityProcess 入口、pi 会话适配、模型注册 |
| `df4d98f` feat(main) | `sessions.json` 注册表、从 pi jsonl 重建 `ChatMessage[]` |
| `691e2c5` feat(main) | §9.5 接口（`types.ts`）与 `envModelResolver` |
| `1418df6` feat(main) | worker 进程客户端：fork、ready 握手、排队、崩溃重启；Electron 适配 `electronWorker.ts` |
| `de54e91` feat(main) | `createAgentHost`：会话生命周期、事件转发、host 调用、崩溃恢复、launcher、审批 |
| `8114f62` feat(main) | `ipc/sessions.ts`、`ipc/index.ts` 一行、`src/main/index.ts` 接线 |
| `cb7285e` feat(preload) | `window.fynvra.sessions` |
| `6890c88` build(main) | `electron.vite.config.ts` 注释：worker 入口怎么构建 |
| `dd70de9` test(agent) | `src/agent` 的 import 边界测试 |

### 1. 协议 `src/shared/types/agent.ts`

- `AgentCommand`：`spawn-session`、`prompt`、`steer`、`abort`、`dispose-session`、`respond-approval`、`host-result`、`shutdown`。
- `AgentWorkerEvent`：`ready`、`session-event {identity, seq, event}`、`session-status`、`host-invoke {callId, kind, method, input}`、`session-error`、`log`，另加 `host-cancel`（见下）。
- `parseAgentCommand` / `parseAgentWorkerEvent` 按 `unknown` 收窄。只按已知字段重建对象，任一字段不合法就整条丢弃。
  - 会话事件按 `FynvraSessionEventBody['type']` 的映射表逐变体校验。core 新增变体而这里没跟上时，会编译失败（Task 10 总结注意事项 2 的建议）。
  - `spawn-session` 里的角色复用 core 的 `parseRole`。
- 与任务书字面的差异（都是有意的）：
  - **identity**：只有会话级消息带 identity。`shutdown`、`ready`、`log` 是进程级消息，不属于任何会话，所以不带。
  - **新增 `host-cancel`**（worker → Main）：worker 侧放弃等待（工具被中止或调用超时）时通知 Main 中止对应的 host 调用。否则 `wait_for_workers`（最长 15 分钟）这类阻塞调用会替一个已经不在等的调用方继续跑。
  - **`session-error.fatal`**：表示 worker 已不再持有该会话（例如创建失败）。Main 据此在下次使用前重新 spawn。
  - **`session-event` 的 `seq`** 与 `event.seq` 相同，parser 会检查两者一致。
- **`ResolvedModelSpec` 定义在这里**，`agentHost/types.ts` 原样 re-export。§9.5 把它写在 `types.ts`，但 `spawn-session` 要携带它，而 `src/shared` 不能 import `src/main`。
- `SpawnSessionSpec` 由 Main 全部解析好，包括 role、cwd、jsonl 路径、模型（含 key）、skills、MCP、`worker` 标志、角色枚举。worker 不读 Main 的任何存储。**API key 只出现在这一跳。**

### 2. Worker 进程 `src/agent/`

- **`index.ts`**：通道是 Electron 注入的 `process.parentPort`，与 EnsoCode 相同。
  - 硬约束里问的 `node:worker_threads` 的 `parentPort` 只属于 worker 线程，在 utilityProcess 里是 `null`，所以不用它。
  - 不 import electron，只在本地声明用到的两个方法。
  - 收到的命令一律先 `parseAgentCommand`，解析失败的记一条 log，不静默丢弃。
  - `shutdown` 命令和 SIGTERM 都会先关闭全部会话再退出。`unhandledRejection` 只记 log，不让进程崩溃。
  - `PI_CODING_AGENT_DIR` 由 Main 经 env 传入，同时作为 agentDir 使用（userData/agent）。
- **对硬约束 import 白名单的偏离**：`models.ts` / `piSession.ts` 直接 import `@earendil-works/pi-coding-agent`（`ModelRuntime`、`SessionManager`）和 `@earendil-works/pi-ai`（类型）。原因：
  - agent-runtime 不导出这两个 pi 入口；
  - `packages/**` 不在本卡范围；
  - 这些 import 集中在上述两个文件里，以后 agent-runtime re-export 时容易替换。
  - electron 依然被禁止，由 `boundary.test.ts` 守住（见「怎么验证」）。
- **`supervisor.ts`**：`SessionSupervisor` 托管多个会话。
  - 同一会话的命令排在它的 spawn 之后。
  - generation 严格比较：不更新的 spawn 被忽略；更新的 spawn 先关闭旧会话；旧 generation 的命令丢弃。
  - 收到 worker 里没有的会话的命令时，回 fatal `session-error`。
  - 状态：prompt 时置 `running`，`agent_settled` 时置 `idle`；本轮出过 error 事件则置 `error`。
  - prompt 在回合开始前就失败时（如缺 key），不会有 `agent_settled`。这种情况自己补一条 host `error` 事件，并把状态置为 `error`。
  - `steer` 在会话忙时是 steer，空闲时按 prompt 处理。
  - `tools: 'orchestrator'` 的角色拿到编排 host 代理；`spec.worker` 的会话拿到 worker host 代理。
- **`hostProxy.ts`**：每次调用分配一个进程内唯一的 callId，按 callId + identity 结算。
  - 中止、超时、发送失败、会话关闭，都 resolve 成 `{ ok: false }`，从不 reject。
  - 超时：入参带 `timeoutMs` 的方法（`wait_for_workers`、`ask_coordinator`）等 `timeoutMs + 60 s`，其余方法等 15 分钟（`run_checks` 可能要跑整套测试）。
- **`models.ts`**：一个 worker 进程共享一个 `ModelRuntime`。
  - 每个（api, baseUrl, apiKey）注册成独立的 provider，provider id 只含哈希，不暴露 key 或端点。能力（上下文、thinking、价格）取 pi 目录里同 id、同 api 的模型。
  - **key 用 `setRuntimeApiKey` 设置**：只在内存里，不写 `auth.json`（实测 `auth.json` 一直是 `{}`）。原因是实测 `registerProvider` 的 `apiKey` 会被 pi 当作配置值模板，`$VAR` 当环境变量展开，`!cmd` 当 shell 命令执行；EnsoCode 的写法在这类 key 上会出错。
- **`piSession.ts`**：`SessionManager.open(<Main 指定的 jsonl>, <其目录>, cwd)`，文件不存在时新建，存在时续写。
  - 之后 `createRoleSession` + `subscribeNormalized`。
  - prompt 一律带 `streamingBehavior: 'followUp'`。
  - dispose 前先 abort 进行中的回合，最多等 5 s（pi 的 bash 是独立进程组，只有中止时才会整树结束）。
- **审批**：`ApprovalBroker` + `SessionSupervisor.requestApproval()` 已实现：发出 `approval_request` 事件，置 `waiting-approval`，等 `respond-approval`，超时、中止或会话关闭按 deny。
  - **按 `role.approvalMode` 拦截工具调用尚未接线**：`createRoleSession` 没有可以挂 `tool_call` 钩子的扩展点，而 `packages/**` 不在范围内。见注意事项 5。

### 3. Main `src/main/services/agentHost/`、`sessions/`

- **`workerClient.ts`**：
  - fork 后排队，等 worker 发 `ready` 再按序发出；60 s 内没有 `ready` 就 kill，按崩溃处理。
  - 意外退出时自动重启：第一次立即，之后间隔 (n−1)×1 s，每分钟最多 3 次；超过后停止，等下一次使用时再手动 `start()`。
  - 发往已退出进程的排队命令丢弃。`onStarted` 在任何命令之前调用，Main 在这里为崩溃前的会话重新 spawn。
  - `shutdown`：发 `shutdown`，超时则 kill。
- **`agentHost.ts`**（`createAgentHost`，实现 §9.5 的 `AgentHost`，外加 IPC 用的会话操作）：
  - `create` 校验工作区、角色、模型，cwd 取工作区记录。会话第一次 prompt 时才在 worker 里 spawn，每次 spawn 换新 generation；第一条 prompt 同时成为会话标题。
  - **事件**：丢弃过期 generation、重复或乱序的 seq，再**改写为会话级 seq** 推 `sessions:event`。
    - 原因：新 generation 的归一化器从 seq 1 重新计数，而 chat-ui 的 reducer 会丢弃 seq ≤ 已处理值的事件；不改写的话，worker 重启后的事件会全部被 Renderer 当成过期丢掉。
    - 改写后的 seq 在一个 Main 进程的生命周期内单调递增（冒烟实测 1→16）。
  - **host-invoke**：每次调用都现查注入的工厂。工厂返回 null 时，回「not wired」错误文本，工具会把它当错误显示给模型。
    - 过期 generation 的调用**不执行**，避免替已关闭的会话派活或合并；`host-cancel` 会中止该调用的 signal；等待期间会话换了 generation，就不回传结果。
    - Main 不 import agent-runtime 的值，否则 pi 会进主进程（构建产物里主进程 0 处 pi import）。方法表用 `Record<keyof OrchestrationHost, true>` 在编译期穷举。
  - **崩溃**：进行中的会话收到 host `error` 事件和 `agent_settled(aborted)`，状态置 `error`。所有在 worker 里的会话按 generation+1 重新 spawn，排在其他命令之前。
  - **launcher**（`implementsLauncher()`）：
    - `createWorkerSession` 建 worker 会话（开 worker 工具，第一条 prompt 是任务书），失败时删掉记录。
    - `readTranscript` 返回纯文本投影：先从 jsonl 初始化，之后只追加；cursor 是字符偏移，`done` = 会话不在运行。
    - `disposeSession` 关闭 worker 会话，保留记录。
  - **审批**：`approval_request` 事件转成 `ApprovalRequest`，推 `sessions:approval-request`。`respondApproval` 只转发一次，并且只发给提出请求的那个 generation。
- **`sessions/sessionStore.ts`**：`userData/sessions.json`。
  - 内存快照，300 ms 防抖，先写 `.tmp` 再 rename；写失败保留待写状态，下次重试。
  - 读入时逐条收窄：非法或重复 id、未知字段丢弃；`running` / `waiting-approval` 回到 `idle`。
  - 会话 id 同时用作 jsonl 文件名，所以 `parseSessionId` 拒绝一切路径形状。
- **`sessions/history.ts`**：`<agentDir>/sessions/<id>.jsonl` → `ChatMessage[]`。
  - 只走当前分支（从最后一条条目沿 parentId 回到根）。toolResult 回填到发起它的工具调用，包括 status、输出（截 8 000 字，与实时 `tool_end` 一致）和 durationMs。
  - 跳过 system 提示词（pi 1.4 会把它存成一条消息）、模型切换、标签和读不懂的行。
  - **Main 自己解析 jsonl，不加载 pi**。格式漂移由一个用例守住：它投影的是真实 pi 会话经 worker 适配层写出的文件。
- **`envModelResolver.ts`**：临时实现，读 `FYNVRA_ANTHROPIC_API_KEY` / `FYNVRA_OPENAI_API_KEY`，默认模型分别为 `claude-sonnet-5-5` / `gpt-5.5`，读不到 key 返回 `{ ok: false }`。
  - **额外加了可选的 `FYNVRA_ANTHROPIC_BASE_URL` / `FYNVRA_OPENAI_BASE_URL`**，供代理和本地端点使用，本卡的冒烟就靠它。
  - fork worker 时会从环境变量里去掉这两个 key。
- **`ipc/sessions.ts`**：§9.3 的 7 个 invoke 通道。入参严格收窄，**不允许多余字段**：`create` 带 `cwd` 或 `model.apiKey` 会被整体拒绝。prompt 文本不能全是空白，上限 100 万字符，原样保留。handler 不跨边界抛异常。
  - `getAgentHost()` 是 Main 单例，写法同 `getWorkspaceService()`。依赖：
    - 角色：core 的 `JsonFileRoleStore`（`userData/roles`，含内置角色）；
    - 模型：`envModelResolver()`；
    - 推送：`sendToAllWindows`。
- **`src/main/index.ts`**：注册 handler 之后启动 agent host，注入 `setOrchestrationHostFactory(() => null)`（orchestrator 的编排工具因此返回「未接线」）。`before-quit` 时最多等 5 s 让 worker 关闭会话再退出，因为 Electron 退出时不给 utilityProcess 发信号。

### 4. Preload

- `src/preload/domains/sessions.ts`：§9.3 的 `SessionsApi` 和 `createSessionsApi(bridge)`。**这个文件刻意不 import electron**：
  - `preload/types.ts` 属于 Renderer 的类型程序，而 electron 的类型声明带 `/// <reference types="node" />`。
  - 反向探针实测：只要在这里加一行 `import type {} from 'electron'`，renderer 里写 `process.env` 就会通过类型检查，Task 10 守住的 TS2591 护栏会悄悄失效。
- 因此 `index.ts` 给领域文件传一个 `{ invoke, subscribe }` 桥（`subscribe` 仍然拿不到 IpcRendererEvent），`types.ts` 只加一行 `sessions: import('./domains/sessions').SessionsApi;`。
- §9.1 写的是「导出 `<domain>Api` 对象」，这里改成了基于桥的工厂函数，原因同上。

### 5. 构建

- 采用 EnsoCode 的 `?modulePath`，`electron.vite.config.ts` 不需要改配置（只加了说明注释）。
  - Main 以 `?modulePath` 引用 `src/agent/index.ts`，electron-vite 用 main 段的 alias 和 externalizeDeps 单独构建出 `out/main/chunks/index-<hash>.js`。
  - 没用 main 多入口：EnsoCode 注释说多入口会把无 export 的入口 tree-shake 成空壳。
- `externalizeDeps` 只外置根 `dependencies` 里的包，所以 pi 必须写进根依赖。否则 worker 无法从 `src/` 解析 pi，agent-runtime 用到的 pi 值也会被打进产物（pi 运行时要读自己包目录里的文件）。
  - pnpm 把根和 agent-runtime 链接到同一个 store 条目（realpath 实测相同），运行时只有一份 pi。
- `electron-builder.yml` 未改：`pnpm build` 不需要，pi 的打包属于 Wave 3。

## 怎么验证

**验收命令**（根目录，最终提交）：

```
pnpm install --frozen-lockfile   → exit 0
pnpm typecheck && pnpm lint && pnpm test && pnpm build   → exit 0
  typecheck：node / web / packages 三段通过
  lint：Checked 147 files … No fixes applied.
  test：Test Files 47 passed (47)；Tests 634 passed (634)（基线 32 / 409）
  build：out/main/index.js、out/main/chunks/index-<hash>.js（worker）、out/preload/index.cjs、out/renderer/…
```

**新增用例**：15 个文件，225 个，全部通过。

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `shared/types/agent.test.ts` | 82 | 协议 parser：每个变体的合法样本、坏输入表、未知字段剥离 |
| `agent/supervisor.test.ts` | 19 | 命令处理（假 session，prompt 时序与 pi 一致）、generation、状态、host 代理往返、审批 |
| `agent/hostProxy.test.ts` | 11 | callId、乱序结算、超时 / 中止与 host-cancel、代理参数打包 |
| `agent/models.test.ts` | 4 | 真实 pi `ModelRuntime`（不联网）：哈希 provider、字面 key（含 `$VAR` 和 `!cmd`）、key 不落盘 |
| `agent/boundary.test.ts` | 1 | `src/agent` 不 import electron |
| `main/services/agentHost/agentHost.test.ts` | 21 | 创建、懒 spawn、seq 改写、过期丢弃、host 调用、崩溃重 spawn、launcher、审批、key 不进 Renderer |
| `main/services/agentHost/roundTrip.test.ts` | 3 | **host-invoke 往返**：真实 AgentHost ⇄（结构化克隆 + 两端 parser）⇄ 真实 SessionSupervisor |
| `main/services/agentHost/workerClient.test.ts` | 10 | ready 握手、排队、重启 / 退避 / 放弃、ready 超时、shutdown |
| `main/services/agentHost/hostDispatch.test.ts` | 14 | 方法表、参数还原、坏入参、Host 抛错与返回值形状不对 |
| `main/services/agentHost/transcript.test.ts` | 5 | 文本投影、cursor、只追加 |
| `main/services/agentHost/envModelResolver.test.ts` | 5 | 环境变量组合 |
| `main/services/sessions/sessionStore.test.ts` | 21 | **sessions.json 读写**：收窄、状态复位、防抖原子写、写失败重试 |
| `main/services/sessions/history.test.ts` | 8 | **history 投影**：分支、工具结果、截断、坏行，以及真实 pi 写出的 jsonl |
| `main/ipc/sessions.test.ts` | 19 | IPC 收窄：坏入参不触达 host，异常不抛出 |
| `preload/domains/sessions.test.ts` | 2 | 通道映射与推送 |

**TDD 的实际顺序**（如实说明）：

- 先写测试、跑红再实现的模块：`sessionStore`、`history`、`envModelResolver`、`transcript`。`workerClient` 的测试与实现在同一轮写成，之后才首次运行，不是严格的先红后绿。
- 其余模块的测试与实现同时写或在其后补：协议 parser、worker 侧模块、`hostDispatch`、`agentHost`、IPC、preload。
- 协议 parser 做了变异验证：去掉 `event.seq !== seq` 检查，失败 1 例；把 generation 校验放宽成任意数字，失败 3 例。恢复后全绿。

**`src/agent` 的类型检查**：`tsconfig.node.json` 的 include 没有 `src/agent`，而 tsconfig 不在本卡范围。

- 用仓库外的临时配置（extends `tsconfig.node.json`，额外 include `src/agent/**/*`）检查了 main / preload / shared / agent 及全部测试：exit 0，9 个 agent 文件都在程序里（`--listFilesOnly` 核对过）。
- 仓库自己的 `pnpm typecheck` 经 Main 侧测试的 import，已经顺带覆盖 `approvals.ts`、`hostProxy.ts`、`supervisor.ts`、`piSession.ts`。`index.ts`、`models.ts` 和 `src/agent` 下的测试没有覆盖，见注意事项 1。

**探针**（临时文件，均已删除，`git status` 干净）：

| 探针 | 结果 |
|---|---|
| renderer 写 `process.env`，跑 `tsc -p tsconfig.web.json` | TS2591：护栏还在 |
| renderer 用 `window.fynvra.sessions.history(...)`、`onEvent` | 通过：类型可用 |
| 在 `domains/sessions.ts` 加 `import type {} from 'electron'` 后再跑 `process.env` 探针 | **exit 0：护栏失效**，证明领域文件必须不 import electron |
| `src/agent/__probe.ts` import electron | `boundary.test.ts` 失败，报 `__probe.ts → electron` |

**构建产物核对**：

- `out/main/index.js` 没有任何 `@earendil-works` import。
- worker chunk 只外部 import `pi-ai`、`pi-coding-agent` 和 Node 内置模块（agent-runtime 和 core 已打进去）。
- Main 以 `join(import.meta.dirname, "./chunks/index-<hash>.js")` 引用 worker。

**真机冒烟**：

- **本机没有 `FYNVRA_ANTHROPIC_API_KEY` / `FYNVRA_OPENAI_API_KEY`，接真实模型服务的冒烟跳过。** 当前 Claude Code 会话自己的 `ANTHROPIC_*` 凭据没有挪用。
- 替代做法：在 127.0.0.1 起一个假的 Anthropic Messages SSE 端点（文本流式回复；对 orchestrator 回一个 `list_workers` 的 tool_use），不产生任何外网流量。
  - 环境变量：`FYNVRA_ANTHROPIC_API_KEY=smoke-local-key`、`FYNVRA_ANTHROPIC_BASE_URL=http://127.0.0.1:<端口>`、`FYNVRA_USER_DATA_DIR=<临时目录>`（预置了一个工作区）。
  - 启动：`pnpm dev --remoteDebuggingPort 9339`，用 CDP 在页面里调 `window.fynvra.sessions.*`。
  - 走的是真实的 utilityProcess worker、真实 pi 会话、真实 anthropic-messages 客户端。
  - 脚本放在临时目录，已删除；完整流程如上，可以照此复现。
- 第一次启动报 `Electron uninstall`：这个新 worktree 里还没有 Electron 二进制（Electron 45 没有 postinstall）。执行 `node node_modules/electron/install.js` 后解决，它用的是本机缓存里的 `electron-v45.0.0-win32-x64.zip`，没有下载。
- 第一轮跑出来是 mock 的问题：pi 请求的是 `/v1/messages?beta=true`，带查询串，被 mock 当 404。即便如此，「请求 → 错误事件 → `agent_settled` → 状态 error → history 回放」这条错误路径也走通了。修好 mock 后，第二轮在**同一个 userData 上重启应用**再跑：
  - **worker 会话两轮对话**：`message_end(user)` → 4 个 `text_delta` → `message_end(assistant)` → `usage` → `agent_settled`，seq 1→16 连续。
    - `history` 回放出两问两答，usage 带费用：0.000094 美元，按目录价格计算。
    - 标题变成第一条 prompt，最终状态 `idle`。
  - **orchestrator 会话**：模型调用 `list_workers` → host-invoke → Main → 工厂返回 null → 工具返回 `orchestration is not wired yet…`（`tool_end` 为 error）→ 模型拿到工具结果后继续回答。history 里这次工具调用是 error，带输出。
  - **重启持久化**：上一轮运行的两个会话出现在列表里，history 从 jsonl 回放出上一轮的 4 条消息。
  - **key**：只以 `x-api-key: smoke-local-key` 出现在 mock 收到的请求里。Renderer 收到的事件和推送里都没有它；userData 里 grep 不到；`auth.json` 是 `{}`。
  - **边界**：`window.fynvra` 只有 `sessions/settings/window/workspaces`，没有通用 invoke；`create` 带 `cwd` 被拒（「无效的会话参数」）。
  - **退出**：经 IPC 关窗 → `before-quit` → worker 关闭会话 → 进程退出，`dev exited: 0`，没有残留的 electron 进程。

## 未做 / 越界项

- **越界修改**：只有 `src/preload/index.test.ts`。它断言 `window.fynvra` 的键恰好是 settings / workspaces / window，加了 sessions 之后必然失败，所以把 `sessions` 补进期望列表和成员检查，改了 3 行。这是任务书要求的 preload 改动的直接后果。
- `src/main/index.ts` 不在范围列表里，但任务书「要做什么」第 6 条要求在这里接线，所以改了。
- **建议改但没改**（不在范围）：
  - `tsconfig.node.json` 的 include 加 `"src/agent/**/*"`；
  - `biome.json` 的 electron 禁令 override 加 `src/agent/**`（暂由 `boundary.test.ts` 兜住）；
  - agent-runtime re-export `ModelRuntime` / `SessionManager`，以后 `src/agent` 就不必直接 import pi。
- **未做**：
  - 按 `approvalMode` 的工具调用拦截：需要 agent-runtime 开放扩展点。拦截一旦上线，内置 worker 角色（`auto-edits`）跑 bash 就要等人确认，这是产品层面的决定。
  - skills / MCP 的解析：`createAgentHost` 留了 `resolveResources` 注入点，默认为空，等 settings-ui 的注册表接入。
  - `llm.ts`：本卡用不到，没有创建。
  - worker 会话的 `parentSessionId`：launcher 的入参里没有 coordinator 会话 id，所以没设。
- **`remove` 只删注册表记录**，pi jsonl 保留：它是正文的权威源，误删时还能恢复。是否清理文件由后续决定。
- 用户全局说明里的知识库检索（`maestro`）本机不可用：没有这个命令，`~/.maestro/workflows/coding-philosophy.md` 也不存在，与 Task 10 的情况相同。

## 给验收人的注意事项

1. **把 `src/agent` 纳入类型检查**：在 `tsconfig.node.json` 的 include 加一行 `"src/agent/**/*"`。已用临时配置实测，加上后 0 错误。
2. **合并冲突**：orchestration-host、settings-ui 两个分支也改了下面这些文件，都是在同一位置追加行的冲突，两边都保留即可：
   - `src/shared/types/ipc.ts`、`src/main/ipc/index.ts`、`src/preload/index.ts`、`src/preload/types.ts`、`src/preload/index.test.ts`；
   - `index.test.ts` 的期望键要合成全部领域；
   - 锁文件冲突时按补充说明的做法：取 main 的版本后重新 `pnpm install`。

   三个分支各自独立地采用了「不 import electron 的领域文件 + 工厂函数」，但桥的形状不同：
   - orchestration-host：`createOrchestrationApi(ipcRenderer)`；
   - settings-ui：`createXxxApi(ipcRenderer, subscribe)`；
   - 本卡：`createSessionsApi({ invoke, subscribe })`。

   各自在文件内声明桥的类型，所以不会冲突。以后可以统一成一个共用的桥类型。
3. **orchestration-host 接线**（在 `src/main/index.ts`）：
   - 用 `getAgentHost().implementsLauncher()` 作为 launcher；
   - `setOrchestrationHostFactory((coordinatorSessionId, workspaceId) => service.hostFor(...))`；
   - `setWorkerHostFactory((sessionId) => service.workerHostFor(sessionId))`；
   - `agentHost/types.ts` 里的 `WorkerSessionLauncher` 改为从 `orchestration/launcher.ts` import（结构相同）。
   - 工厂每次调用都会现查，factory 自己缓存即可。
4. **settings-ui 接线**（在 `src/main/ipc/sessions.ts` 的 `createAppAgentHost`）：
   - `models` 换成 `createModelResolver()`；
   - 补上 `resolveResources`；
   - 有 RoleStore 单例时复用它，不要再 new 一个。
   - `envModelResolver` 和 `ENV_MODEL_SECRET_VARS` 可以随之删除，`electronWorker.ts` 里去掉环境变量的那段也一起删。
5. **给 chat-ui**：
   - 事件 seq 是会话级的，worker 重启后继续递增；
   - spawn 失败、prompt 失败、worker 崩溃都会以 `error`（source `host`）事件出现，崩溃时还会补一条 `agent_settled(aborted)`；
   - `history` 中每条 pi 的 user / assistant 消息各成一条 `ChatMessage`，工具调用挂在发起它的那条 assistant 消息上；
   - **`sessions:approval-request` 目前不会触发**（没有审批门）。
6. **新 worktree 里跑 `pnpm dev`**：如果报 `Electron uninstall`，先执行 `node node_modules/electron/install.js`。本机缓存里有 v45.0.0，不需要联网。
7. 一个小插曲：Biome 2.6.2 的格式化在 `agentHost.test.ts` 上要跑两遍才收敛，第一遍 `--write` 之后 `check` 仍然报格式问题。已经处理，这里只是提醒。
8. **本机残留文件，需要手动删除**：我做类型检查时一次临时路径写错，在 Git 安装目录下建了 `D:\Software\Git\fynvra-agent-host-typecheck\tsconfig.json`（640 字节的 tsconfig，没有别的东西）。删除它被 Claude Code 的安全检查拦下了，请手动删掉这个目录。
