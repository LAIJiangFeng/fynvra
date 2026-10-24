# @fynvra/agent-runtime

纯 Node 库，运行在 Agent Worker（Electron `utilityProcess`，`src/agent`）里：封装 pi SDK
（`@earendil-works/pi-coding-agent` **1.4.0**），提供 fynvra 工具（编排 / worker / 只读）和事件归一化。
不 import Electron；对 pi 私有或不稳定 API 的依赖集中在 `src/pi/`。

| 模块 | 作用 |
|---|---|
| `src/session/createRoleSession.ts` | 按 `Role` 创建 pi `AgentSession`（ARCHITECTURE §5） |
| `src/tools/orchestrationTools.ts` | orchestrator 的 10 个编排工具，背后是 `OrchestrationHost` |
| `src/tools/workerTools.ts` | `ask_coordinator` / `report_done`，背后是 `WorkerHost` |
| `src/tools/readonlyTools.ts` | pi 的 read / grep / find / ls + `git_readonly`（白名单） |
| `src/prompts/orchestratorPrompt.ts` | `ORCHESTRATOR_PROMPT`、`WORKER_CONTRACT_PROMPT` |
| `src/events/normalize.ts` | pi 会话事件 → `FynvraSessionEvent`（带 `seq`） |
| `src/host.ts` | `OrchestrationHost` / `WorkerHost` 契约 |
| `src/pi/` | pi 适配层（升级复检点，见文末） |
| `src/coreTypes.ts` | §4 类型的临时副本，Task 02 合并后改为从 `@fynvra/core` 导入 |

## 工具策略

| `role.tools` | 会话里的工具 |
|---|---|
| `orchestrator` | `noTools: 'builtin'` + read / grep / find / ls / `git_readonly` + 编排工具（必须传 `host`） |
| `readonly` | `noTools: 'builtin'` + read / grep / find / ls / `git_readonly` |
| `all` | pi 默认工具（read / bash / edit / write） |

传入 `workerHost` 的会话就是 worker：再加 `ask_coordinator` / `report_done`，系统提示词追加
`WORKER_CONTRACT_PROMPT`。orchestrator 策略追加 `ORCHESTRATOR_PROMPT`。两者都排在 `role.systemPrompt` 之后，
经 before_agent_start 扩展进入系统提示词的 addendum 段。

所有工具都是「先归一化再校验」：`prepareArguments` 在 pi 的 schema 校验前修正参数（别名、trim、
`timeout_ms` clamp 到 [1000, 900000]、`until` 默认 `'all'`、`role` 默认 `'worker'`），`execute` 再做语义校验。
`execute` 永不抛异常，失败以 `isError` 文本返回；`report_done` 每轮只能成功一次（新的 agent run 开始时重新开放，
用于 reject_work 之后重新汇报）。

## 由 Main 实现 OrchestrationHost 并接线

```
Renderer ⇄ preload ⇄ Main ── OrchestrationService（@fynvra/core：OrchestrationStore / Inbox / GitWorktreeManager / renderBrief）
                       ⇅ parentPort：AgentCommand / AgentWorkerEvent（identity + seq）
                     Agent Worker（src/agent）
                       ├─ orchestrator 会话：createRoleSession({ host: OrchestrationHost 代理 })
                       └─ worker 会话 × N：createRoleSession({ workerHost: WorkerHost 代理, cwd: worktree })
```

工具只调用注入的接口，不碰 git / 进程（与 EnsoCode 的 `AgentControlInvoker` 同构）。真正的实现在 Main，
worker 进程里只放一个转发代理。

### 1. Main：实现编排逻辑

方法与工具一一对应（`ORCHESTRATION_TOOL_METHODS`），全部返回 `{ ok: true, ... } | { ok: false, error }`，不抛异常：

| 方法（工具） | Main 做什么 |
|---|---|
| `dispatchTask`（dispatch_task） | 建 Task；依赖都已完成时 `GitWorktreeManager.create({ slug, baseRef: 主 agent 所在分支 })` → 建 worker 会话（`roleId`，默认 worker）→ `renderBrief` 投递 → 建 Dispatch。依赖未完成只排队、不返回 `dispatch`，依赖完成后自动派发 |
| `listWorkers`（list_workers） | 本 Run 的 `listTasks` + 每个 task 的当前 Dispatch |
| `waitForWorkers`（wait_for_workers） | `Inbox.waitFor` 等发给 coordinator 的消息：`until: 'any'` 收到 worker_done 即返回，`'all'` 等所有运行中的 dispatch settle；**question / escalation 一到就返回**（否则阻塞提问的 worker 与等待的主 agent 互等）。返回期间送达的消息并 ack；超时返回 `timedOut: true`，不是错误 |
| `readWorkerOutput`（read_worker_output） | worker 输出的文本投影（如由它的 `FynvraSessionEvent` 拼出），`cursor` 是字符偏移；返回 `{ text, total, done }`，分页由工具负责 |
| `sendToWorker`（send_to_worker） | worker 有挂起的 question → 发 `reply`（`replyTo`）唤醒 `askCoordinator`；否则发 `instruction` 并 steer / followUp 给 worker 会话 |
| `reviewDiff`（review_diff） | `GitWorktreeManager.diff(baseCommit)`：文件列表、stat、diff 全文（工具负责截断） |
| `runChecks`（run_checks） | 在 worktree 里执行命令，返回退出码与合并输出。这是主 agent 唯一能执行命令的入口，建议按设置做白名单或走审批 |
| `mergeWorktree`（merge_worktree） | `GitWorktreeManager.merge`（`--no-ff` 合到主 agent 所在分支，冲突时已 `merge --abort`，返回冲突文件） |
| `rejectWork`（reject_work） | task 回到 in-progress，发 `instruction`，并把 feedback 作为**新 prompt** 发给 worker：新 run 开始时 report_done 重新开放 |
| `cleanupWorktree`（cleanup_worktree） | `remove` worktree + `deleteBranch`，关闭 worker 会话 |

`WorkerHost`：

| 方法 | Main 做什么 |
|---|---|
| `askCoordinator(question, timeoutMs, signal?)` | 发 `question` → 等 `reply`（`replyTo` 指向它）→ `{ ok: true, answer }`；超时 `{ ok: true, answer: null }` |
| `reportDone(outcome, summary, filesModified?)` | `settleDispatch` + 发 `worker_done`，task → in-review |

### 2. Worker 进程：转发代理

```ts
// src/agent/hostProxy.ts（Wave 2 示意）
import type { OrchestrationHost, WorkerHost } from '@fynvra/agent-runtime';

// invoke：经 parentPort 发 { type: 'host-call', identity, seq, requestId, method, input }，
// 等 Main 回 { type: 'host-result', requestId, result }；signal 中止时发 'host-cancel'。
// IPC 失败也 resolve 成 { ok: false, error }，保持「不跨边界抛异常」。
type Invoke = (method: string, input: unknown, signal?: AbortSignal) => Promise<any>;

export function orchestrationHostProxy(invoke: Invoke): OrchestrationHost {
  return {
    dispatchTask: (input, signal) => invoke('dispatchTask', input, signal),
    listWorkers: (signal) => invoke('listWorkers', undefined, signal),
    waitForWorkers: (input, signal) => invoke('waitForWorkers', input, signal),
    readWorkerOutput: (input, signal) => invoke('readWorkerOutput', input, signal),
    sendToWorker: (input, signal) => invoke('sendToWorker', input, signal),
    reviewDiff: (input, signal) => invoke('reviewDiff', input, signal),
    runChecks: (input, signal) => invoke('runChecks', input, signal),
    mergeWorktree: (input, signal) => invoke('mergeWorktree', input, signal),
    rejectWork: (input, signal) => invoke('rejectWork', input, signal),
    cleanupWorktree: (input, signal) => invoke('cleanupWorktree', input, signal),
  };
}

export function workerHostProxy(invoke: Invoke): WorkerHost {
  return {
    askCoordinator: (question, timeoutMs, signal) =>
      invoke('askCoordinator', { question, timeoutMs }, signal),
    reportDone: (outcome, summary, filesModified) =>
      invoke('reportDone', { outcome, summary, filesModified }),
  };
}
```

### 3. 创建会话与转发事件

```ts
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { createRoleSession, subscribeNormalized } from '@fynvra/agent-runtime';

// 一个 worker 进程共享一个 ModelRuntime
const runtime = await ModelRuntime.create({
  authPath: path.join(agentDir, 'auth.json'),
  modelsPath: null,
  refreshOnCreate: false,
});
const model = runtime.getModel(role.model.providerId, role.model.modelId);

const { session, warnings, dispose } = await createRoleSession({
  role,                                   // 来自 @fynvra/core 的 Role
  cwd: workspace.repoPath,                // worker 会话传 worktree.path
  agentDir,                               // userData/agent
  model: { runtime, model },
  sessionManager: SessionManager.create(cwd, path.join(agentDir, 'sessions')),
  host: orchestrationHostProxy(invoke),   // worker 会话：host: null, workerHost: workerHostProxy(invoke)
  resourcePaths: {
    skills: resolvedSkillPaths,           // role.skillIds → skill 目录 / SKILL.md
    mcpServers: resolvedMcpServers,       // role.mcpServerIds → { name, ...pi McpServerConfig }
  },
  roles,                                  // dispatch_task 的 role 枚举与显示名匹配
});

const events = subscribeNormalized(session, (event) =>
  parentPort.postMessage({ type: 'session-event', identity, event })
);
await session.prompt(text);               // worker 会话的第一条 prompt 是 renderBrief(...) 的任务书
// ……会话结束时
events.unsubscribe();
await dispose();                          // 先发 session_shutdown（关闭 MCP 连接）再 dispose
```

- `warnings` 是 skill 路径缺失、MCP 服务器名非法等配置问题，建议展示给用户。
- `subscribeNormalized` 的事件带递增 `seq`，worker 包上 `identity: { sessionId, generation }` 发给 Main；
  消费方丢弃过期 seq。未映射的 pi 事件按类型计入 `stats().droppedByType`。
- pi 没有审批事件。Wave 2 的审批门（按 `role.approvalMode` 在 `tool_call` 钩子里拦截）用
  `events.emit({ type: 'approval_request', ... })` 把请求注入同一条 seq 序列。

### 4. 进程与配置注意事项

- **`PI_CODING_AGENT_DIR`**：Main 启动 agent worker 时设为 fynvra 的 agentDir（`userData/agent`）。pi 的全局路径
  （grep / find 缺 `rg` / `fd` 时下载二进制到 `<agentDir>/bin`）在模块加载时读这个变量，不受 `agentDir` 参数影响；
  不设就会落到用户的 `~/.pi/agent`。
- 默认设置是 `SettingsManager.inMemory({ enableInstallTelemetry: false })`：不读用户的 `~/.pi` 与项目 `.pi`
  设置，不发 pi 的安装遥测与 provider 署名请求头。需要压缩 / 重试等设置时由 Main 传入 `settingsManager`。
- 角色是资源的唯一来源：磁盘扩展、skill 发现、提示词模板、主题、`SYSTEM.md` / `APPEND_SYSTEM.md` 都不加载；
  项目的 `AGENTS.md` 等上下文文件照常加载（从 cwd 向上查找）。
- MCP 服务器经 `loadConfig` 注入、`/mcp` 的修改不落盘；未声明 `exposure` 时默认 `direct`
  （pi 默认的 `codemode` 需要 codemode 扩展）。服务器的 env / headers 由 Main 经 parentPort 交给 worker 进程，
  不经过 Renderer。
- pi 默认系统提示词以 “operating inside pi” 开头并带 pi 文档段；需要 fynvra 自己的人设时可在适配层替换
  （EnsoCode 的 `replacePersonaParagraph` 做法）。

## 升级复检点（`src/pi/`）

升级 pi 时逐条复查：

1. `pi/extensions.ts`：before_agent_start 事件上可变的 `systemPromptOptions.appendSystemPrompt`；该事件每个 run 恰好触发一次。
2. `pi/lifecycle.ts`：`AgentSession.dispose()` 不发 `session_shutdown`，经 `session.extensionRunner` 补发。
3. `pi/mcp.ts`：`createMcpExtension({ loadConfig, updateConfig })` 与 `LoadedMcpConfig` 结构；MCP 在 session_start 连接、
   session_shutdown 关闭；exposure 语义。
4. `events/normalize.ts` 按 `AgentSessionEvent` 类型编写：字段变化会编译失败，新增事件类型出现在 `stats().droppedByType`。

## 开发

```bash
cd packages/agent-runtime
pnpm install && pnpm typecheck && pnpm lint && pnpm test
```

测试不联网、不需要 API key：`createRoleSession` 用 `SessionManager.inMemory()` 加 pi-ai 的 faux provider 跑真实会话，
断言工具集、模型实际收到的系统提示词和工具调用链路。
