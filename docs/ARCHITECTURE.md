# Fynvra 架构

> 本文是所有 agent 实现时的共同契约。改动契约必须先改本文。
> 参考实现：`D:\project\EnsoCode`（可直接读其源码学习模式，但 **不要复制粘贴大段代码**，fynvra 要保持精简）。

## 1. 技术栈（与 EnsoCode 对齐）

| 项 | 选择 |
|---|---|
| 桌面壳 | Electron 45 + electron-vite 6（main / preload / renderer 三段构建） |
| 语言 | TypeScript（strict），ESM（`"type": "module"`） |
| UI | React 19 + Tailwind 4（`@tailwindcss/vite`）+ `@base-ui/react` 封装成 shadcn 风格组件放 `src/renderer/components/ui/` + lucide-react |
| 状态 | Zustand 5（按字段订阅；会话正文用纯 reducer 归并） |
| Agent 运行时 | `@earendil-works/pi-coding-agent` 1.4.0 SDK（`createAgentSession`、`SessionManager`、`DefaultResourceLoader`、`InlineExtension`、`createMcpExtension`） |
| 工具链 | pnpm 10 workspace、Biome 2（2 空格、单引号、分号、宽 100）、Vitest 4、tsc `--noEmit` |
| 持久化 | `userData/settings.json`（元数据）、`userData/roles/*.json`、`userData/agent/sessions/*.jsonl`（pi 会话，权威源）、`userData/orchestration.json` |

## 2. 目录布局

```
fynvra/
  package.json  pnpm-workspace.yaml  electron.vite.config.ts  biome.json  vitest.config.ts
  tsconfig.json  tsconfig.node.json  tsconfig.web.json  electron-builder.yml
  src/
    main/        Electron 主进程：index.ts、ipc/<domain>.ts、services/、windows/
    preload/     index.ts（contextBridge 暴露 typed API）、types.ts
    renderer/    React：index.html、App.tsx、components/、stores/、hooks/、lib/、styles/
    shared/      纯类型与纯函数（无 Node/Electron import），含 types/ipc.ts
    agent/       Agent worker 入口（utilityProcess），封装 pi SDK
  packages/
    core/            纯 TS 领域库（无 Electron）：角色、编排状态机、git worktree、消息收件箱
    agent-runtime/   纯 Node 库：pi SDK 封装、fynvra 工具（orchestration 工具、worker 工具）、事件归一化
  docs/            PRODUCT.md、ARCHITECTURE.md
  .workflow/       多 agent 协作：specs/（规范）、scratch/<主题>/task-*.md（任务书）
```

包名：根 `fynvra`，`@fynvra/core`，`@fynvra/agent-runtime`。renderer 通过 Vite alias `@` → `src/renderer`，`@shared` → `src/shared`，`@fynvra/core` → `packages/core/src/index.ts`（源码直接打包）。

两个 `packages/*` 包各自有 `package.json`（`"type": "module"`、`main: src/index.ts`、`types: src/index.ts`），`tsconfig.json` 继承根配置，测试文件与源码同目录（`*.test.ts`）。根 `vitest.config.ts` 的 include 要覆盖 `src/**` 与 `packages/*/src/**`。

## 3. 进程模型

```
Renderer(React) ⇄ preload(typed API) ⇄ Main(ipc/*, services/*) ⇄ Agent Worker(utilityProcess, src/agent)
                                                                     └─ pi AgentSession × N（每个会话一个）
```

- Main 是权威：settings、roles、workspaces、orchestration 状态、worktree 注册表都在 Main 持久化。
- 一个 Agent Worker 进程托管多个 pi 会话（EnsoCode 的 `agentHost` 模式）。Main ⇄ Worker 走 `parentPort` 消息，协议是 tagged union `AgentCommand` / `AgentWorkerEvent`，每条事件带 `identity: { sessionId, generation }` 和递增 `seq`。
- Renderer 只持有投影；pi jsonl 是会话正文权威源。

## 4. 领域模型（`packages/core`，`@fynvra/core`）

```ts
// 角色
export type ApprovalMode = 'supervised' | 'auto-edits' | 'full';
export type ToolPolicy = 'all' | 'readonly' | 'orchestrator';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export interface Role {
  id: string;                 // slug；内置：'orchestrator' | 'worker'
  name: string;
  description?: string;
  builtin?: boolean;
  systemPrompt?: string;      // 追加到 pi 系统提示词后（EnsoCode: before_agent_start 追加）
  model?: { providerId: string; modelId: string; thinking?: ThinkingLevel };
  skillIds: string[];
  mcpServerIds: string[];
  tools: ToolPolicy;
  approvalMode: ApprovalMode;
}

// 工作区 & 会话
export interface Workspace { id: string; name: string; repoPath: string; defaultBranch: string; }
export interface SessionRef {
  id: string; workspaceId: string; roleId: string; cwd: string;
  worktreeId?: string; parentSessionId?: string;
}

// 编排（Orca 语义）：Run 是命名空间 + 收件箱；Task 是工作；Dispatch 是一次权威尝试
export type TaskStatus = 'todo' | 'in-progress' | 'in-review' | 'completed' | 'failed' | 'abandoned';
export interface Run { id: string; workspaceId: string; coordinatorSessionId: string; objective: string; createdAt: number; }
export interface Task { id: string; runId: string; title: string; spec: string; roleId: string; status: TaskStatus; dependsOn: string[]; }
export interface Dispatch {
  id: string; taskId: string; workerSessionId: string; worktreeId: string; branch: string;
  startedAt: number; settledAt?: number; outcome?: 'succeeded' | 'failed';
  summary?: string; filesModified?: string[];
}
export interface Worktree { id: string; workspaceId: string; path: string; branch: string; baseRef: string; baseCommit: string; }

// 收件箱消息（worker → coordinator，coordinator → worker）
export type MessageType = 'worker_done' | 'question' | 'reply' | 'escalation' | 'heartbeat' | 'instruction';
export interface Message {
  id: string; runId: string; dispatchId?: string; from: string; to: string;
  type: MessageType; subject?: string; body: string; replyTo?: string;
  createdAt: number; ackedAt?: number;
}
```

`packages/core` 提供：
- `roles/`：内置角色定义（`orchestrator`、`worker`）、`parseRole(unknown)` 校验收窄、`RoleStore` 接口 + 基于注入 fs 的 JSON 文件实现。
- `orchestration/`：`OrchestrationStore`（内存实现 + 可注入的 JSON 持久化）、状态迁移纯函数（task / dispatch 合法迁移表，非法迁移返回错误而不是抛异常）、`Inbox`（FIFO、ack、按类型过滤、`waitFor(predicate, timeoutMs)` Promise）。
- `git/`：`GitWorktreeManager`（注入 `exec(cmd, args, cwd)`）：`create({ repoPath, workspaceId, slug, baseRef, worktreesRoot })` → 分支 `fynvra/<slug>`（冲突加后缀），路径 `<worktreesRoot>/<workspaceId>/<slug>`；`status`（dirty / ahead / behind）；`diff(baseCommit)`；`remove`；`prune`；`merge({ repoPath, branch })` 走 `--no-ff`，返回 `{ ok, conflicts?: string[] }`，冲突时自动 `merge --abort`；`deleteBranch`。
- `briefs/`：任务书模板渲染（Target / Change / Constraints / Ownership / Acceptance 五段 + `report_done` 契约段）。

## 5. Agent 运行时（`packages/agent-runtime`，`@fynvra/agent-runtime`）

- `createRoleSession(opts: CreateRoleSessionOptions): Promise<RoleSession>` → 根据角色创建 pi `AgentSession`：

  ```ts
  interface CreateRoleSessionOptions {
    role: Role;
    cwd: string;                        // orchestrator 为工作区仓库，worker 为它的 worktree
    model: ResolvedModel;
    sessionManager: SessionManager;
    host: OrchestrationHost | null;     // tools: 'orchestrator' 必须提供，其他策略传 null
    resourcePaths: { skills: string[]; mcpServers: McpServerConfig[] };
    agentDir: string;                   // 必填：pi 的 agentDir，Fynvra 用 userData/agent（与用户的 ~/.pi 隔离）
    workerHost?: WorkerHost | null;     // 提供即为 worker 会话
    workerTools?: WorkerToolsOptions;   // ask_coordinator 的等待上限 askTimeoutMs（默认 10 分钟）
    roles?: readonly RoleOption[];      // dispatch_task 可选的角色：role 参数的枚举与显示名匹配
    settingsManager?: SettingsManager;  // 默认内存设置（不读 ~/.pi 与项目 .pi），enableInstallTelemetry: false
    exec?: ExecFn;                      // git_readonly 的命令执行器，默认 child_process.execFile
    onExtensionError?: (error: ExtensionError) => void;
  }
  interface RoleSession {
    session: AgentSession;
    warnings: string[];                 // skill 路径缺失、MCP 服务器名非法等配置问题，供 Main 展示
    dispose(): Promise<void>;           // 先发 session_shutdown（关闭 MCP 连接）再释放；可重复调用
  }
  // Main 按 role.model 解析；thinking 缺省取 role.model?.thinking
  interface ResolvedModel { runtime: ModelRuntime; model: Model<Api>; thinking?: ThinkingLevel }
  // pi 的 McpServerConfig 不带名字；未声明 exposure 时默认 'direct'（pi 默认的 'codemode' 需要额外扩展）
  type McpServerConfig = PiMcpServerConfig & { name: string };
  ```

  - `tools: 'orchestrator'` → `noTools: 'builtin'`，只注入只读工具（read / grep / find / ls + `git_readonly`）+ 编排工具；
  - `tools: 'readonly'` → 同样 `noTools: 'builtin'`，只注入只读工具（read / grep / find / ls + `git_readonly`）；`'all'` → pi 默认工具。
  - 传入 `workerHost` 时（不论哪种策略）再加 worker 工具，并追加 worker 契约提示词。
  - skills → `DefaultResourceLoader` 的 skill 路径；MCP → `createMcpExtension()`；`systemPrompt` → `before_agent_start` 追加扩展。
- 编排工具（仅 orchestrator 角色，pi `ToolDefinition`，参数 schema 完整类型，归一化先于校验）：
  `dispatch_task { title, spec, role?, depends_on? }`、`list_workers`、`wait_for_workers { timeout_ms, until: 'any' | 'all' }`、`read_worker_output { dispatch_id, cursor? }`、`send_to_worker { dispatch_id, body }`、`review_diff { dispatch_id }`、`run_checks { dispatch_id, command }`、`merge_worktree { dispatch_id }`、`reject_work { dispatch_id, feedback }`、`cleanup_worktree { dispatch_id }`。
  工具不直接操作 git / 进程，而是调用注入的 `OrchestrationHost` 接口（由 Main 实现），与 EnsoCode `AgentControlInvoker` 同构。`OrchestrationHost` 的方法名与上述工具一一对应。
- worker 工具：`ask_coordinator { question }`（阻塞直到 reply 或超时，返回答复文本）、`report_done { outcome: 'succeeded' | 'failed', summary, files_modified? }`（每轮只能成功调用一次，同一轮再次调用返回错误；新的 agent run 开始时重新开放，因此 Main 要把 `reject_work` 的 feedback 作为新 prompt 发给 worker，worker 才能再次汇报）。
- 事件归一化：pi session 事件 → `FynvraSessionEvent`（`text_delta`、`thinking_delta`、`tool_start` / `tool_end`、`message_end`、`agent_settled`、`approval_request`、`usage`、`error`），每条带 `seq`。

## 6. 主 agent 工作循环（产品核心）

1. 用户在 Orchestrator 会话输入需求。
2. 主 agent 调 `dispatch_task`（可多次、并行）→ Main：建 worktree（`fynvra/<slug>`）→ 新建 worker 会话（指定角色或 `worker`）→ 投递任务书（含 `report_done` 契约）。
3. 主 agent `wait_for_workers`；期间 `question` 到达时用 `send_to_worker` 回答。
4. `worker_done` → 主 agent `review_diff` + `run_checks`（如 `pnpm typecheck && pnpm lint && pnpm test`）→ 判定：
   - 通过：`merge_worktree`（no-ff 合并到主 agent 所在分支）→ `cleanup_worktree` → 向用户汇报。
   - 不通过：`reject_work` 把意见发回 worker，回到 3。
5. 全部任务 settled 后向用户给出每个任务的结果、证据、未解决项。

## 7. IPC 规则（照搬 EnsoCode）

- 新增 IPC 三件事必须同步：`src/shared/types/ipc.ts` 通道常量（`domain:action`）、`src/main/ipc/<domain>.ts` handler 并在 `ipc/index.ts` 注册、`src/preload/index.ts` 按领域暴露 typed API。
- 入参按 `unknown` 收窄；Renderer 只传 id 不传路径；返回 `{ ok, ... }` 不跨边界抛异常；不暴露通用 `invoke`。
- API key、MCP env 明文只在 Main。
- Main → Renderer 推送用 `sendToAllWindows`。

## 8. 分阶段

- **Wave 1（并行三张卡）**：`app-shell`（Electron 骨架 + settings + IPC 约定 + 布局壳）、`core-domain`（packages/core）、`agent-runtime`（packages/agent-runtime）。
- **Wave 2**：Main 接入 worker 进程与两个包；聊天 UI（流式、工具卡片、审批条）；Providers / Roles / Skills / MCP 设置页；Orchestration 面板（任务卡、worker 实时输出、diff）。
- **Wave 3**：导入本机 Claude Code / Codex 配置；Git Checkpoint；打包发布。

## 9. Wave 2 跨卡契约（并行卡片的共同边界）

Wave 2 的卡片并行开发，彼此只能通过本节定义的接口对接。**本节列出的文件内容是规范性的**：拥有该文件的卡片必须按此创建；
需要它但不拥有的卡片，可以在自己的分支里创建**逐字相同**的文件（相同内容的新增文件合并时不会冲突），不要改动。

### 9.1 共享文件的追加约定（避免合并冲突）
- `src/shared/types/ipc.ts`：每个领域在 `IPC_CHANNELS` 里追加自己的一段，用 `// --- <domain> ---` 注释隔开，放在对象末尾。
- `src/preload/`：每个领域一个文件 `src/preload/domains/<domain>.ts`，导出 `<domain>Api` 对象和 `<Domain>Api` 类型；`src/preload/index.ts` 与 `src/preload/types.ts` 只各加一行。
- `src/main/ipc/index.ts`：每个领域只加一行 `registerXxxHandlers()`。
- `src/renderer/App.tsx` / 布局文件只允许加挂载点（一行 import + 一行 JSX）。

### 9.2 `src/shared/types/chat.ts`（归属：agent-host；chat-ui / orchestration-ui 可逐字复制）
```ts
import type { FynvraSessionEvent } from '@fynvra/agent-runtime';

export type SessionStatus = 'idle' | 'running' | 'waiting-approval' | 'error';
export interface SessionSummary {
  id: string; workspaceId: string; roleId: string; title: string; cwd: string;
  worktreeId?: string; parentSessionId?: string; dispatchId?: string;
  status: SessionStatus; createdAt: number; updatedAt: number;
  model?: { providerId: string; modelId: string };
}
export type ChatRole = 'user' | 'assistant';
export interface ChatToolCall {
  id: string; name: string; args: unknown;
  status: 'running' | 'done' | 'error'; output?: string; durationMs?: number;
}
export interface ChatMessage {
  id: string; sessionId: string; role: ChatRole; text: string; thinking?: string;
  toolCalls: ChatToolCall[]; createdAt: number; streaming: boolean;
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
}
export type ApprovalKind = 'command' | 'file-edit' | 'file-write' | 'mcp';
export type ApprovalDecision = 'allow' | 'allowSession' | 'deny';
export interface ApprovalRequest {
  id: string; sessionId: string; kind: ApprovalKind; title: string; detail: string; expiresAt: number;
}
/** Main → Renderer 推送（通道 `sessions:event`）。 */
export interface SessionEventEnvelope { sessionId: string; event: FynvraSessionEvent; }
```

### 9.3 `window.fynvra.sessions`（归属：agent-host；chat-ui 消费）
```ts
export interface SessionsApi {
  list(workspaceId: string): Promise<IpcResult<{ sessions: SessionSummary[] }>>;
  create(input: { workspaceId: string; roleId: string; model?: { providerId: string; modelId: string } }): Promise<IpcResult<{ session: SessionSummary }>>;
  remove(sessionId: string): Promise<IpcResult>;
  prompt(input: { sessionId: string; text: string }): Promise<IpcResult>;
  abort(sessionId: string): Promise<IpcResult>;
  /** 从 pi jsonl 重建的消息投影；Renderer 切换会话时调用 */
  history(sessionId: string): Promise<IpcResult<{ messages: ChatMessage[] }>>;
  respondApproval(input: { sessionId: string; requestId: string; decision: ApprovalDecision }): Promise<IpcResult>;
  onEvent(cb: (envelope: SessionEventEnvelope) => void): Unsubscribe;
  onSessionsChanged(cb: (workspaceId: string) => void): Unsubscribe;
  onApprovalRequest(cb: (request: ApprovalRequest) => void): Unsubscribe;
}
```
通道：`sessions:list|create|remove|prompt|abort|history|respond-approval`，推送 `sessions:event`、`sessions:changed`、`sessions:approval-request`。

### 9.4 `window.fynvra.orchestration`（归属：orchestration-host；orchestration-ui 消费）
```ts
import type { Run, Task, Dispatch, Worktree, Message } from '@fynvra/core';
export interface OrchestrationSnapshotView { runs: Run[]; tasks: Task[]; dispatches: Dispatch[]; worktrees: Worktree[]; messages: Message[]; }
export interface OrchestrationApi {
  snapshot(workspaceId: string): Promise<IpcResult<OrchestrationSnapshotView>>;
  /** 读 dispatch 对应 worker 会话的输出（与 read_worker_output 同源） */
  readWorkerOutput(input: { dispatchId: string; cursor: number }): Promise<IpcResult<{ text: string; total: number; done: boolean }>>;
  reviewDiff(dispatchId: string): Promise<IpcResult<{ branch: string; baseCommit: string; files: string[]; stat: string; diff: string }>>;
  onChanged(cb: (workspaceId: string) => void): Unsubscribe;
}
```
通道：`orchestration:snapshot|read-worker-output|review-diff`，推送 `orchestration:changed`。

### 9.5 Main 内部接口（agent-host ⇄ orchestration-host，最终在 `src/main/index.ts` 接线）
```ts
// 归属：orchestration-host，文件 src/main/services/orchestration/launcher.ts
export interface WorkerSessionLauncher {
  createWorkerSession(input: { workspaceId: string; runId: string; dispatchId: string; roleId: string; cwd: string; worktreeId: string; brief: string }): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;
  promptSession(sessionId: string, text: string): Promise<{ ok: true } | { ok: false; error: string }>;
  readTranscript(sessionId: string, cursor: number): Promise<{ ok: true; text: string; total: number; done: boolean } | { ok: false; error: string }>;
  disposeSession(sessionId: string): Promise<void>;
}
// orchestration-host 导出：
export function createOrchestrationHost(deps: { workspace: Workspace; coordinatorSessionId: string; coordinatorBranch: string; store: OrchestrationStore; git: GitWorktreeManager; inbox: Inbox; launcher: WorkerSessionLauncher; roles: RoleStore; runChecks: (cwd: string, command: string, signal?: AbortSignal) => Promise<{ exitCode: number; output: string; durationMs: number }> }): OrchestrationHost;
export function createWorkerHost(deps: { store: OrchestrationStore; inbox: Inbox; runId: string; dispatchId: string }): WorkerHost;

// 归属：agent-host，文件 src/main/services/agentHost/types.ts
export interface ModelResolver { resolve(ref: { providerId: string; modelId: string } | undefined): Promise<{ ok: true; model: ResolvedModelSpec } | { ok: false; error: string }>; }
/** 跨进程可序列化的模型描述；worker 进程内再换成 agent-runtime 的 ResolvedModel */
export interface ResolvedModelSpec { providerId: string; api: string; baseUrl?: string; apiKey?: string; modelId: string; thinking?: ThinkingLevel; }
export interface AgentHost {
  implementsLauncher(): WorkerSessionLauncher;      // 供 orchestration-host 使用
  setOrchestrationHostFactory(f: (coordinatorSessionId: string, workspaceId: string) => OrchestrationHost | null): void;
  setWorkerHostFactory(f: (sessionId: string) => WorkerHost | null): void;
}
```

### 9.6 `src/shared/types/llm.ts`（归属：settings-ui；agent-host 可逐字复制）
```ts
export type ProviderApi = 'anthropic-messages' | 'openai-responses' | 'openai-completions' | 'google-generative-ai';
export interface ModelEntry { id: string; name: string; contextWindow?: number; maxOutput?: number; reasoning?: boolean; }
export interface ModelProvider { id: string; name: string; api: ProviderApi; baseUrl?: string; enabled: boolean; models: ModelEntry[]; }
/** Renderer 侧看到的脱敏形态 */
export interface ModelProviderView extends ModelProvider { hasApiKey: boolean; apiKeyHint?: string; }
export interface SkillEntry { id: string; name: string; path: string; description?: string; enabled: boolean; }
export interface McpServerEntry { id: string; name: string; transport: 'stdio' | 'sse' | 'http'; command?: string; args?: string[]; url?: string; enabled: boolean; }
/** Renderer 侧 env / headers 只给键名 */
export interface McpServerEntryView extends McpServerEntry { envKeys: string[]; headerKeys: string[]; }
```
settings-ui 还提供 `src/main/services/providers/resolveModel.ts` 导出 `createModelResolver(): ModelResolver`（形状同 9.5）。
持久化：`userData/providers.json`（含明文 key，仅 Main）、`userData/skills.json`、`userData/mcp.json`、`userData/roles/<id>.json`。
