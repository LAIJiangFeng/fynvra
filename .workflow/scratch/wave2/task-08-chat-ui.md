# Task 08 · chat-ui —— 会话列表、聊天时间线、流式渲染、工具卡片、审批条

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/PRODUCT.md`、`docs/ARCHITECTURE.md`（§3、**§9.1、§9.2、§9.3**）、
`packages/agent-runtime/src/events/normalize.ts`（`FynvraSessionEvent` 全部变体与字段）、`.workflow/scratch/bootstrap/summary-app-shell.md`（布局、store、测试 tsconfig 说明）。
参考 EnsoCode：`src/renderer/stores/sessions/reducer.ts`（事件归并、seq 丢弃、message-upsert）、`src/renderer/components/chat/`（时间线、ToolCall 卡片、ApprovalBar、输入框）。只学结构，不复制。

## 范围（允许改）
- `src/renderer/components/chat/**`（新建）、`src/renderer/stores/sessions/**`（新建）、`src/renderer/lib/api/sessions.ts`（新建）、`src/renderer/hooks/**` 新增文件
- `src/renderer/components/layout/Sidebar.tsx`：把「会话列表」填进现有侧栏占位；`MainArea.tsx`：选中会话时渲染聊天视图
- `src/renderer/components/ui/` 可新增 `textarea`、`badge`、`collapsible`、`select`
- `src/shared/types/chat.ts`：**仅当不存在时逐字按 §9.2 创建**（agent-host 并行开发同一文件，内容必须一字不差）
- `package.json` devDependencies：可加 `react-markdown`、`remark-gfm`、`shiki`（代码高亮）、`react-virtuoso`（长列表）；加后根目录 `pnpm install` 并提交锁文件
- **不要动** `src/main/**`、`src/preload/**`、`src/agent/**`、`packages/**`、`src/renderer/components/settings/**`。

## 要做什么
1. `src/renderer/lib/api/sessions.ts`：导出 `SessionsApi` 类型（**逐字按 §9.3**）与 `getSessionsApi(): SessionsApi`，实现为读取 `window.fynvra.sessions`；若不存在（agent-host 未合并时的 dev 态）返回一个 **内存 mock**（create 后对 prompt 产出假的流式 `text_delta` / `tool_start` / `tool_end` / `message_end` / `agent_settled` 事件，便于你在 `pnpm dev` 里真实看效果）。不要 `declare global`（preload/types.ts 归 agent-host）。
2. `stores/sessions/reducer.ts`：纯函数 `reduceSessionEvent(state, envelope)`：按 `sessionId` 分桶；`seq` 小于等于已处理值丢弃；`text_delta` / `thinking_delta` 累加到当前流式 assistant 消息；`tool_start` 新建 `ChatToolCall(running)`，`tool_end` 更新 output/status/duration；`message_end` 用权威内容整条替换并 `streaming=false`；`agent_settled` 置会话 `idle`；`approval_request` 入待审批队列；`usage` 累计；`error` 记录。用户发送时的乐观回显只允许追加在末尾，`history` 回放后用权威投影整体替换。
3. `stores/sessions/index.ts`：Zustand（`sessionsByWorkspace`、`messagesBySession`、`activeSessionId`、`pendingApprovals`、`drafts`），actions：`loadSessions`、`createSession(roleId)`、`selectSession`（拉 `history`）、`send(text)`、`abort`、`respondApproval`；订阅 `onEvent` / `onSessionsChanged` / `onApprovalRequest`，按字段选择器导出。
4. UI：
   - 侧栏会话列表：按工作区分组，显示角色徽标（orchestrator 特殊标记）、状态点（idle / running / waiting-approval / error）、最近更新时间；「新建会话」弹层选角色（角色列表先用 `[orchestrator, worker]` 常量，settings-ui 合并后再接 roles API）。
   - 时间线：用户 / assistant 消息；Markdown 渲染（GFM、代码块高亮、复制按钮）；thinking 折叠块；工具调用卡片（名称、参数摘要、可展开输出、耗时、running spinner）；`report_done` / `dispatch_task` 等编排工具卡片有专门样式（显示 task 标题 / outcome）。
   - 输入框：多行、Enter 发送 / Shift+Enter 换行、运行中显示「停止」；草稿按会话保存在 store。
   - 审批条：待审批时固定在输入框上方，显示 kind / title / detail，三个按钮 allow / allowSession / deny。
   - 状态栏（会话底部一行）：tokens、费用（有则显示）、模型。
5. 测试：reducer 全路径（乱序 seq、重复 seq、流式→权威替换、工具 start/end 配对、approval 入队出队）、store 的 send 拒绝空文本 / running 时不重复发；用注入的假 `SessionsApi`。renderer 测试放在 `tsconfig.node.json` 覆盖范围，被测模块不直接碰 DOM（参照 `createSettingsStore` 的注入写法）。

## 硬约束
- 组件只用 `components/ui` 封装，不直接 import `@base-ui/react` 原语到业务组件。
- Zustand 按字段订阅；长列表虚拟化。
- 不传路径、不碰 Node API。

## 验收标准
- 根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿。
- `pnpm dev`（mock 模式）：新建会话 → 发送 → 看到流式输出与工具卡片 → 审批条交互 → 切换会话草稿保留。暗色主题可用。

## 提交
`<type>(renderer|shared): <summary>`，末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不 push、不建 PR。

## 完成动作
写 `.workflow/scratch/wave2/summary-chat-ui.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
