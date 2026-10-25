# Task 26 · general-settings —— 通用设置补齐：会话归档 / 删除、worktree 清理、时间线显示偏好

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/ARCHITECTURE.md` §7、§9.2、§9.3，`.workflow/scratch/wave3/summary-copy-trim.md`（文案极简）、`summary-worktrees-root.md`（通用页现状）、`summary-chat-ui.md`（时间线、工具卡片、思考块）。
参考 EnsoCode：`src/renderer/components/settings/GeneralSettings.tsx`（归档闲置会话 / 清理已合并 worktree / 归档超过天数删除 / 有文件改动时打开 Changes / 精简只读工具调用 / 运行中自动展开文件改动 / 流式推理时自动展开 / 自动折叠历史轮次）。只学语义。

## 范围（允许改）
- `src/shared/types/settings.ts`（`Preferences` 加 `// --- sessions ---` 与 `// --- timeline ---` 两块）及测试、`src/shared/types/chat.ts`（`SessionSummary.archivedAt?`）、`src/shared/types/ipc.ts`（`sessions:archive`、`sessions:unarchive`、`sessions:list` 带 `includeArchived`）
- `src/main/services/sessions/**`（归档字段、闲置归档与过期删除的定时扫描 `archiveSweeper.ts`，注入时钟可测）、`src/main/services/orchestration/**`（只加「归档时清理已合并且干净的 worktree」的调用）、`src/main/ipc/sessions.ts`、`src/preload/domains/sessions.ts`
- `src/renderer/components/settings/GeneralSettings.tsx`（追加两组）、`src/renderer/stores/settings.ts`、`src/renderer/stores/sessions/**`、`src/renderer/components/chat/{SessionList,Timeline,ToolCallCard,ThinkingBlock,MessageItem}.tsx`（只按偏好改显示行为）
- Task 24 / 25 并行在改 `settings.ts` 与 `SettingsView.tsx`：你的字段放自己的注释块；不要碰 `SettingsView.tsx`。

## 要做什么
1. **会话**：
   - 归档闲置会话：`archiveIdleDays`（关闭 / 7 / 14 / 30 / 90），超过天数未更新的会话移入「已归档」（侧栏底部可折叠分组，可手动归档 / 恢复，右键或悬停按钮）。
   - 归档时清理 worktree：`cleanupWorktreeOnArchive` 开关，仅当该会话绑定的 worktree 已合并且干净时删除（走 orchestration 的 cleanup）。
   - 归档超过天数后删除：`deleteArchivedDays`（永不 / 30 / 90），删除记录（pi jsonl 保留，与现有 `remove` 一致）。
   - 定时扫描：启动后 30 秒、之后每小时；注入时钟的纯函数决定哪些会话归档 / 删除。
2. **时间线**：
   - `compactReadonlyTools`（默认开）：read / grep / find / ls 单行显示，连续的折叠成一条「N 次读取」。
   - `autoExpandEdits`（默认开）：运行中文件修改工具的 diff / 写入内容自动展开。
   - `autoExpandThinking`（默认开）：流式思考时展开，结束后收起。
   - `foldHistoryTurns`（默认关）：发送新消息后之前轮次折叠成一行（提问 + 时间），最后一轮展开。
3. 设置页「通用」追加这两组，文案极简（标题一行，无说明；必要的放 tooltip）。
4. 测试：归档 / 删除判定纯函数（边界天数、时钟注入）、settings 收窄、reducer / 选择器对折叠的处理、worktree 清理条件。

## 验收标准
根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿；`pnpm dev` 下把归档天数设为 7 后能看到旧会话进入已归档分组，可恢复；时间线四个开关各自生效。

## 提交 / 完成动作
`<type>(main|renderer|shared|preload): <summary>` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不 push 不建 PR。
写 `.workflow/scratch/wave4/summary-general-settings.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
