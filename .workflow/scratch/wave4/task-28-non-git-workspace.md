# Task 28 · non-git-workspace —— 没有 git 的目录也能挂入使用，只是不启用 worktree 模式

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/PRODUCT.md`、`docs/ARCHITECTURE.md` §4、§6、§9.4、§9.5，
`src/main/services/gitRepository.ts`、`src/main/services/workspaces.ts`、`src/main/ipc/workspaces.ts`（现在非 git 目录被拒绝）、`src/main/services/orchestration/host.ts`（dispatch → 建 worktree）、`.workflow/scratch/wave3/summary-worktrees-root.md`、`summary-composer-ux.md`（分支徽标）。
用户原话：「必须有 git 才可以用这是不对的，如果没有 git 就不要启动工作树的模式就行了」。

## 范围（允许改）
- `src/shared/types/workspace.ts`（`Workspace.vcs: 'git' | 'none'`，`defaultBranch` 改为可选）及测试、`src/main/services/{gitRepository,workspaces}.ts`、`src/main/ipc/workspaces.ts` 及测试
- `src/main/services/orchestration/host.ts`、`service.ts`、`registry.ts`（及测试、集成测试）：非 git 工作区的派发路径
- `packages/agent-runtime/src/tools/orchestrationTools.ts`、`src/prompts/orchestratorPrompt.ts`（工具描述里说明非 git 模式）及测试
- `src/main/services/sessions/**`（分支读取对非 git 返回空，已是如此则不动）
- `src/renderer/components/layout/Sidebar.tsx`、`src/renderer/components/chat/{ChatView,StatusBar,SessionBadges}.tsx`、`src/renderer/components/orchestration/**`、`src/renderer/components/settings/GeneralSettings.tsx`（只做显示上的区分，极简）
- 不要动 settings 的 Preferences、`SettingsView.tsx`、chat 的 Composer / 时间线（Task 24 / 25 / 26 正并行在改）。

## 要做什么
1. **挂入**：`workspaces:add` 接受任意目录；是 git 仓库根 → `vcs: 'git'`（子目录仍提示选根目录，但允许「仍然挂入该子目录」作为普通目录）；不是 → `vcs: 'none'`。侧栏工作区条目对 `none` 显示小徽标「无 git」（tooltip：不会使用 worktree）。
2. **会话**：普通会话在 `none` 工作区照常工作（cwd = 目录）；标题行 / 状态栏不显示分支徽标。
3. **编排**：`none` 工作区里 orchestrator 的 `dispatch_task` 不建 worktree，worker 直接在工作区目录里干活（`cwd` = 目录，`worktreeId` 为空 / Dispatch 记 `mode: 'in-place'`）；并行任务共用同一目录——工具返回文本里提示「无 git：worker 直接在目录中修改，建议一次只派一个任务」；`review_diff` 返回「无 git，无法生成 diff」并列出 worker 汇报的 `files_modified`；`merge_worktree` / `cleanup_worktree` 在该模式下返回 ok 且说明「无需合并 / 清理」，task 直接 `completed`；`run_checks` 照常。orchestrator 提示词里加一段非 git 模式的说明（由 Main 在 spawn 时按工作区 `vcs` 决定是否追加）。
4. **编排面板**：`in-place` 的 dispatch 不显示分支，「改动」tab 显示「无 git」空态。
5. **通用页**：worktree 根目录统计里 `none` 工作区显示「无 git」。
6. 测试：挂入三种目录（git 根 / git 子目录 / 普通目录）；host 在 `none` 下 dispatch / review / merge / cleanup 的行为（假 launcher）；真实目录集成测试（临时普通目录：派发 → worker 写文件 → report_done → 任务 completed，没有调用任何 git）。真机：挂入一个非 git 目录，新建 orchestrator 会话派一个「新建 hello.txt」任务，文件出现在目录里。

## 验收标准
根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿；真机证据写进总结。

## 提交 / 完成动作
`<type>(main|renderer|shared|agent-runtime): <summary>` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不 push 不建 PR。
写 `.workflow/scratch/wave4/summary-non-git-workspace.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
