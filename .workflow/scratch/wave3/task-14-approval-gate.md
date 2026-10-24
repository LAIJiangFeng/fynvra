# Task 14 · approval-gate —— 按角色的 approvalMode 拦截工具调用，接通审批条

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/PRODUCT.md`（三档审批）、`docs/ARCHITECTURE.md` §4（`ApprovalMode`）、§9.2（`ApprovalRequest` / `ApprovalDecision`）、§9.3（`respondApproval`、`onApprovalRequest`），
`.workflow/scratch/wave2/summary-agent-host.md`（「未做」里的审批门、注意事项 5；agent-host 已有 approval broker 的骨架，先找到它）、`summary-chat-ui.md`（审批条已实现，等事件）、
pi 扩展文档 `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`（搜 `tool_call` 事件：扩展可以在工具执行前拦截 / 拒绝）。
参考 EnsoCode：`src/agent/approval.ts`（`ApprovalGate`，fail-closed，`allowSession` 集合，过期时间）、`src/agent/writeScope.ts`（从工具参数取写目标）——学语义，不复制。

## 范围（允许改）
- `packages/agent-runtime/src/approval/**`（新建）、`packages/agent-runtime/src/session/createRoleSession.ts`（增加 `approval?: ApprovalPolicyHooks` 参数）、`packages/agent-runtime/src/index.ts`、`packages/agent-runtime/src/events/normalize.ts`（如需补 `approval_request` 的发射）、及测试
- `src/agent/**`（approval broker 的 worker 侧：收 Main 的 `respond-approval`，回填 Promise）
- `src/main/services/agentHost/**`（Main 侧 broker：把 `approval_request` 推到 renderer `sessions:approval-request`，`respondApproval` 回传 worker；超时默认 deny）
- `src/shared/types/agent.ts`（协议若需补字段，更新 parser 与测试）
- 不要动 renderer / preload（审批条已存在）、`src/main/services/orchestration/**`。

## 语义（定死）
| approvalMode | 需要审批的工具 |
|---|---|
| `supervised` | 所有会改状态的工具：bash / 命令执行、write、edit、apply_patch、MCP 工具（kind 分别为 `command` / `file-write` / `file-edit` / `mcp`） |
| `auto-edits` | 只有 bash / 命令执行与 MCP 工具；文件读写编辑自动放行 |
| `full` | 全部放行（但下面的「保护底线」仍然要审批） |

保护底线（任何档位都要人确认）：命令里出现 `rm -rf` / `git push` / `git reset --hard` / `del /s` / `Remove-Item -Recurse` / 包管理器 `publish`。
决策：`allow` 一次；`allowSession` 本会话同类（kind + 工具名）后续自动放行；`deny` 返回给模型一条可读的拒绝文本（不抛）。未响应 10 分钟视为 deny（fail-closed）。orchestrator 角色是 `full` 且只有只读与编排工具，`run_checks` 命令按 `command` 走审批底线即可。

## 要做什么
1. agent-runtime：`createApprovalGate({ mode, request: (req) => Promise<ApprovalDecision>, now })`，用 pi 扩展的 `tool_call` 拦截点实现；从工具参数提取 `title` / `detail`（命令全文、文件路径）；单测覆盖三档 × 四类工具、保护底线、allowSession、超时 deny、deny 文本。
2. worker ↔ Main 往返：`approval_request` 事件（带 `requestId`、`expiresAt`）→ Main 转发 renderer，并记录 pending；`respond-approval` → worker 回填。worker 崩溃或会话 dispose 时 pending 一律 deny。
3. 测试：agentHost 往返（假 worker）；端到端：`InMemoryWorker` 下 worker 会话以 `supervised` 调 bash → 收到 `approval_request` → `respondApproval(allow)` → 工具继续执行。
4. 真机冒烟：`pnpm dev`，worker 角色（`auto-edits`）让它执行一条 `echo hi`，审批条弹出，点 allow 后输出出现；点 deny 时模型收到拒绝文本。

## 验收标准
根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿；冒烟证据写进总结。

## 提交 / 完成动作
`<type>(agent-runtime|agent|main|shared): <summary>` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不 push 不建 PR。
写 `.workflow/scratch/wave3/summary-approval-gate.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
