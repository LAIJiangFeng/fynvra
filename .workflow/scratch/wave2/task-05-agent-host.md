# Task 05 · agent-host —— Agent worker 进程 + Main 会话管理 + sessions IPC

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/PRODUCT.md`、`docs/ARCHITECTURE.md`（§3、§5、§7、**§9 全部**）、
`packages/agent-runtime/README.md`、`.workflow/scratch/bootstrap/summary-agent-runtime.md`（「Wave 2 接线须知」）、`summary-app-shell.md`。
参考 EnsoCode：`src/main/services/agentHost.ts`（utilityProcess fork、ready 握手、事件收窄广播）、`src/agent/index.ts` + `supervisor.ts`（多会话托管、`parentPort` 协议）、
`src/shared/types/agent.ts`（`AgentCommand` / `AgentWorkerEvent` tagged union + parser）、`src/main/ipc/agent.ts`、`src/renderer/stores/sessions/reducer.ts`（只看思路）。

## 范围（允许改）
- `src/agent/**`（新建，worker 进程入口）
- `src/main/services/agentHost/**`（新建）、`src/main/services/sessions/**`（新建：会话注册表，持久化到 `userData/sessions.json`）
- `src/main/ipc/sessions.ts`（新建）+ `src/main/ipc/index.ts` 加一行
- `src/shared/types/agent.ts`（新建：Main ⇄ Worker 协议）、`src/shared/types/chat.ts`（新建，**逐字按 §9.2**）、`src/shared/types/llm.ts`（如需，**逐字按 §9.6**）
- `src/shared/types/ipc.ts`：追加 `// --- sessions ---` 段
- `src/preload/domains/sessions.ts`（新建）+ `src/preload/index.ts`、`src/preload/types.ts` 各加一行
- `electron.vite.config.ts`：为 `src/agent/index.ts` 增加 worker 入口构建（参考 EnsoCode 的 `?modulePath` 方式或 main 多入口），`electron-builder.yml` 如需同步
- `package.json`：仅允许在 `dependencies` 加 worker 运行时需要的包（如 `@fynvra/agent-runtime` 不能加，走 alias 打包；pi 三件套由 packages/agent-runtime 带入，若 externalizeDeps 要求根也声明则加并说明）
- `test/stubs/**` 如需补桩
- **不要动** `src/renderer/**`（chat-ui 负责）、`src/main/services/orchestration/**`（orchestration-host 负责）、`src/main/services/providers/**`（settings-ui 负责）、`packages/**`。

## 要做什么
1. **协议** `src/shared/types/agent.ts`：`AgentCommand`（`spawn-session`、`prompt`、`steer`、`abort`、`dispose-session`、`respond-approval`、`host-result`（Main 回传 OrchestrationHost/WorkerHost 调用结果）、`shutdown`）与 `AgentWorkerEvent`（`ready`、`session-event {identity, seq, event: FynvraSessionEvent}`、`session-status`、`host-invoke {callId, kind: 'orchestration'|'worker', method, input}`、`session-error`、`log`），每条带 `identity: { sessionId, generation }`；`parseAgentCommand` / `parseAgentWorkerEvent` 按 `unknown` 收窄；单测覆盖坏输入。
2. **Worker 进程** `src/agent/index.ts`：`utilityProcess` 入口；`SessionSupervisor` 托管多个 `createRoleSession`（来自 `@fynvra/agent-runtime`）；用 `subscribeNormalized` 转发事件；把 `OrchestrationHost` / `WorkerHost` 实现为「发 `host-invoke` 给 Main，等 `host-result`」的代理（带 callId、超时、AbortSignal）；`PI_CODING_AGENT_DIR` 由 Main 通过 env 传入（见 agent-runtime 总结）；SIGTERM / `shutdown` 时 dispose 全部会话。
3. **Main** `src/main/services/agentHost/`：fork worker、ready 握手、重启策略（崩溃后 generation+1 重新 spawn 活跃会话）、事件解析后用 `sendToAllWindows` 推 `sessions:event`；`AgentHost` 实现 §9.5 的 `implementsLauncher()`、`setOrchestrationHostFactory`、`setWorkerHostFactory`；`ModelResolver` 接口（§9.5）作为注入点，本卡提供一个基于环境变量的临时实现 `envModelResolver`（`FYNVRA_ANTHROPIC_API_KEY` / `FYNVRA_OPENAI_API_KEY`，读不到就返回 `{ok:false}`），**settings-ui 合并后替换**。
4. **会话注册表** `src/main/services/sessions/`：`SessionSummary` 持久化（`userData/sessions.json`，原子写）；`history(sessionId)` 从 pi jsonl（`SessionManager.open`，或 agent-runtime 暴露的读取方式）重建 `ChatMessage[]` 投影；会话 cwd 由 workspace / worktree 记录推导，Renderer 不传路径。
5. **IPC + preload**：§9.3 全部通道。
6. **接线** `src/main/index.ts`：启动 agentHost，注册 handlers；orchestration host factory 先注入 `() => null`（orchestrator 角色此时只有只读工具 + 编排工具会返回「未接线」错误文本），后续卡片接上。

## 硬约束
- 遵守 §7 IPC 规则；API key 只在 Main → worker 的 `spawn-session` 里传，不进 Renderer。
- worker 事件必须先 parse 收窄再广播；过期 generation 的事件丢弃。
- `src/agent` 只能 import `@fynvra/agent-runtime`、`@fynvra/core`、`src/shared`、Node 内置；不能 import electron（除 `utilityProcess` 的 `parentPort` 来自 `node:worker_threads`? —— 以 EnsoCode 的做法为准，并说明）。

## 验收标准
- 根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿；新增单测：协议 parser、supervisor 命令处理（假 session）、host-invoke 往返、sessions.json 读写、history 投影。
- 真机冒烟（需要你机器上有可用的 API key 环境变量，没有就说明并跳过）：`pnpm dev`，用 CDP 调 `window.fynvra.sessions.create` + `prompt`，收到流式 `sessions:event`，`history` 能回放。

## 提交
`<type>(agent|main|shared|preload): <summary>`，末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不 push、不建 PR。

## 完成动作
写 `.workflow/scratch/wave2/summary-agent-host.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。

## 补充（验收人，Task 04/10 合并后）
- `FynvraSessionEvent` 已由 `@fynvra/core` 导出（agent-runtime 仍 re-export）。`src/shared/**` 只能从 `@fynvra/core` 导入它，不能 import `@fynvra/agent-runtime`（web tsconfig 没有映射，这是刻意的护栏）。
- 仓库已统一 LF（根 `.gitattributes`）；若你的 worktree 里 `pnpm lint` 报大量格式错误，先在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`。
- 根 `pnpm-lock.yaml` 若与 main 冲突，取 main 版本后在根目录 `pnpm install` 重新生成，不要手工合并。
