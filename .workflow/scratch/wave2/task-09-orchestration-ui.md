# Task 09 · orchestration-ui —— 编排面板：任务看板、worker 实时输出、diff 查看

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/PRODUCT.md`（主 agent 工作模式）、`docs/ARCHITECTURE.md`（§4 类型、§6、**§9.1、§9.4**）、
`packages/core/src/types.ts`（Run / Task / Dispatch / Worktree / Message）、`.workflow/scratch/bootstrap/summary-app-shell.md`（SidePanel 占位、store、测试 tsconfig 说明）。
参考 EnsoCode：`src/renderer/components/sidepanel/`（可停靠侧面板的形态）、`src/renderer/components/chat/CoworkerTabs.tsx`（子会话 tab 思路）、`@pierre/diffs` 或 `src/renderer/components/changes/`（diff 渲染，只学结构）。

## 范围（允许改）
- `src/renderer/components/orchestration/**`（新建）、`src/renderer/stores/orchestration.ts`（新建）、`src/renderer/lib/api/orchestration.ts`（新建）
- `src/renderer/components/layout/SidePanel.tsx`：把编排面板填进现有右侧面板占位（tab：「任务」「改动」）
- `src/renderer/components/ui/` 可新增 `tabs`、`badge`、`progress`、`collapsible`
- `src/shared/types/orchestration.ts`：**仅当不存在时逐字按 §9.4 创建 `OrchestrationSnapshotView`**（orchestration-host 并行开发同一文件）
- `package.json` devDependencies：可加 diff 渲染库（如 `@pierre/diffs` 或 `diff` + 自绘）；加后根目录 `pnpm install` 并提交锁文件
- **不要动** `src/main/**`、`src/preload/**`、`src/agent/**`、`packages/**`、`src/renderer/components/{chat,settings}/**`、`Sidebar.tsx`、`MainArea.tsx`。

## 要做什么
1. `src/renderer/lib/api/orchestration.ts`：`OrchestrationApi` 类型（**逐字按 §9.4**）+ `getOrchestrationApi()`：读 `window.fynvra.orchestration`；不存在时返回 **内存 mock**（预置 1 个 Run、3 个 Task（一个 completed、一个 in-progress 带 Dispatch 和滚动的假输出、一个 in-review 带假 diff），便于 `pnpm dev` 看效果）。不要 `declare global`。
2. `stores/orchestration.ts`：按 workspace 缓存 snapshot；订阅 `onChanged` 重新拉取；派生选择器：`tasksByStatus`、`activeDispatchOf(taskId)`、`messagesOf(dispatchId)`；worker 输出按 dispatch 分页缓存（cursor 递进，running 时 1.5s 轮询，settled 后停止）。
3. UI（右侧面板）：
   - 「任务」tab：Run 目标一行；任务卡片列表（标题、角色徽标、状态色、分支名、依赖、最近消息摘要），按 todo / in-progress / in-review / completed / failed 分组可折叠；点开卡片 → 详情抽屉：任务书（Markdown 折叠）、Dispatch 时间线（startedAt / settledAt / outcome / summary / filesModified）、消息流（question / reply / instruction / worker_done 以气泡区分）、worker 实时输出（等宽字体、自动滚底、可暂停）。
   - 「改动」tab：选择一个 in-review / completed 的 dispatch → `reviewDiff` → 文件列表 + stat + 按文件折叠的 diff 高亮（增删行着色），超长 diff 分文件懒渲染。
   - 空态文案：「主 agent 还没有派发任务」。
4. 测试：store 的 snapshot 归并与选择器、分页 cursor 推进与停止轮询（假 API + 假定时器）、diff 文本切分为按文件的 hunks（纯函数）。

## 硬约束
- 只用 `components/ui` 封装；Zustand 按字段订阅；不碰 Node / 路径。
- 面板是只读视图：不提供合并 / 拒绝按钮（这些是主 agent 的职责，用户通过对话指挥）。

## 验收标准
- 根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿。
- `pnpm dev`（mock 模式）：右侧面板能看到任务分组、详情抽屉、滚动输出、diff 高亮；暗色可用。

## 提交
`<type>(renderer|shared): <summary>`，末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不 push、不建 PR。

## 完成动作
写 `.workflow/scratch/wave2/summary-orchestration-ui.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。

## 补充（验收人，Task 04/10 合并后）
- 仓库已统一 LF；若 `pnpm lint` 报大量格式错误，先在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`。
- renderer / shared 不能 import `@fynvra/agent-runtime`（web tsconfig 刻意不映射）；需要的类型从 `@fynvra/core` 拿。
- 根 `pnpm-lock.yaml` 若与 main 冲突，取 main 版本后 `pnpm install` 重新生成。
