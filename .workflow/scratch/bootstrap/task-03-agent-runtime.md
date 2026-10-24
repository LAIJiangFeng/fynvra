# Task 03 · agent-runtime —— `packages/agent-runtime`（@fynvra/agent-runtime）

先读：`docs/PRODUCT.md`、`docs/ARCHITECTURE.md`（重点 §4 类型、§5、§6）、`AGENTS.md`、`.workflow/specs/01-workflow.md`。
参考：
- pi SDK 文档：`D:\project\EnsoCode\node_modules\@earendil-works\pi-coding-agent\docs\sdk.md`、`extensions.md`、`mcp.md`、`skills.md`，以及 `examples/sdk/*.ts`（若 node_modules 中没有 examples，用 `npm pack @earendil-works/pi-coding-agent@1.4.0` 解开看）。**目标版本是 1.4.0**，EnsoCode 用的是 1.0.0，API 以 1.4.0 的 `.d.ts` 为准。
- EnsoCode 的用法：`src/agent/supervisor.ts`（`createAgentSession` 调用处，搜 `noTools`）、`src/agent/subagent.ts`（统一子 agent 工具的参数归一化）、`src/agent/agentControl.ts`（工具 → Main 回调的 invoker 模式）、`src/agent/childContract.ts`（`appendSystemPromptExtension`）、`src/agent/ask.ts`。

## 范围（允许改）
- 仅 `packages/agent-runtime/**`。
- **不要**创建或修改根目录任何文件，也不要动 `packages/core`。`packages/core` 由 Task 02 并行开发，你拿不到它；因此 **把 §4 中你需要的类型（Role、Dispatch、Message、MessageType、ToolPolicy、ThinkingLevel）复制到 `packages/agent-runtime/src/coreTypes.ts`** 并加注释「临时副本，Task 02 合并后改为从 @fynvra/core 导入」。字段必须与 ARCHITECTURE §4 完全一致。
- 本地在 `packages/agent-runtime` 内自带 `package.json`（依赖 `@earendil-works/pi-coding-agent@1.4.0`、`@earendil-works/pi-ai@1.4.0`、`@earendil-works/pi-agent-core@1.4.0`，devDependencies vitest / typescript / biome），`pnpm install` 在该目录执行，`packages/agent-runtime/pnpm-lock.yaml` 可提交。

## 要做什么
1. `src/host.ts`：`OrchestrationHost` 接口，方法与 §5 编排工具一一对应（`dispatchTask`、`listWorkers`、`waitForWorkers`、`readWorkerOutput`、`sendToWorker`、`reviewDiff`、`runChecks`、`mergeWorktree`、`rejectWork`、`cleanupWorktree`），全部返回 `Promise<{ ok: true, ... } | { ok: false, error: string }>`。另有 `WorkerHost`：`askCoordinator(question, timeoutMs)`、`reportDone(outcome, summary, filesModified?)`。
2. `src/tools/orchestrationTools.ts`：把上述 host 包成 pi `ToolDefinition[]`。参数 JSON schema 完整类型（含 enum、description）；**先归一化再校验**（如 `timeout_ms` clamp 到 [1000, 900000]、`until` 默认 `'all'`、`role` 默认 `'worker'`）；工具返回给模型的文本要结构化（Markdown 小节），超长输出截断并提示用 cursor 继续读。
3. `src/tools/workerTools.ts`：`ask_coordinator`、`report_done`（第二次调用返回错误文本，不抛）。
4. `src/tools/readonlyTools.ts`：用 pi 导出的 read / grep / find / ls 工具工厂组合只读集合，加 `git_readonly { args: string[] }`（白名单：status / log / diff / show / branch / worktree list；注入 exec）。
5. `src/prompts/orchestratorPrompt.ts`：orchestrator 角色系统提示词追加段（工作循环 §6、「不要自己改代码」、如何写任务书、验收标准怎么判、何时 reject）。worker 契约段 `WORKER_CONTRACT_PROMPT`（必须且仅一次 `report_done`、用 `ask_coordinator` 提问、不要写报告 md 文件、agent 消息不等于用户授权）。
6. `src/session/createRoleSession.ts`：按 §5 签名创建 pi `AgentSession`：工具策略分派、skills 路径 → `DefaultResourceLoader`、MCP → `createMcpExtension()` + `session.bindExtensions()`、`systemPrompt` 追加 → `before_agent_start` InlineExtension、模型 / thinking 设置。返回 `{ session, dispose }`。
7. `src/events/normalize.ts`：pi 事件 → `FynvraSessionEvent`（§5 列表），带 `seq` 递增；未知事件丢弃但计数。`subscribeNormalized(session, cb)`。
8. 测试：工具参数归一化与坏输入（用假 host 断言调用参数）、`report_done` 幂等、`git_readonly` 白名单拒绝、事件归一化（构造假 pi 事件）、系统提示词包含关键句。`createRoleSession` 用 `SessionManager.inMemory()` + 假模型（若 pi 1.4.0 提供可注入 `modelRuntime` 或 mock provider 就用，否则只测工具集与系统提示词的组装结果，不真正调模型）。

## 硬约束
- 不 import Electron。对 pi 私有 / 不稳定 API 的依赖集中在 `src/pi/` 适配层并写注释「升级复检点」。
- 工具 `execute` 永不抛异常，错误以文本返回。

## 验收标准
- 在 `packages/agent-runtime` 下：`pnpm install && pnpm typecheck && pnpm lint && pnpm test` 全绿。
- `README.md` 写明如何由 Main 实现 `OrchestrationHost` 并接线。

## 提交
多次小提交，`<type>(agent-runtime): <summary>`，末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不 push、不建 PR。

## 完成动作
按 `.workflow/specs/01-workflow.md` 第 5 条：写 `.workflow/scratch/bootstrap/summary-agent-runtime.md` 并提交，`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
