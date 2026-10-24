# Task 16 · worktrees-root —— worktree 根目录可配置，默认不占 C 盘

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/ARCHITECTURE.md` §4（`Worktree`）、§7，
`src/main/services/orchestration/registry.ts`（现在 `worktreesRoot: join(userDataPath, 'worktrees')`，即 `%APPDATA%\fynvra\worktrees`，在 C 盘）、
`src/shared/types/settings.ts`（`Preferences` 已有 `shellPath` 可选字段，照它的写法）、`src/main/ipc/workspaces.ts`（Main 弹目录框、Renderer 不传路径的范式）、
`src/renderer/components/settings/`（`SettingsView.tsx` 导航、`AppearanceSettings.tsx` 页面形态）。

## 问题
worktree 全建在 C 盘用户数据目录，用户要求：默认不放 C 盘、能自己选目录。

## 范围（允许改）
- `src/shared/types/settings.ts`（及测试）：`Preferences.worktreesRoot?: string`
- `src/main/services/orchestration/registry.ts`、`service.ts`（及测试）：根目录改为可解析函数 `resolveWorktreesRoot(workspace)`，每次建 worktree 时现算
- `src/main/services/orchestration/worktreesRoot.ts`（新建）及测试
- `src/main/ipc/settings.ts`（新增 `settings:pick-worktrees-root`：Main 弹目录框、校验可写、写入 preferences；`settings:worktrees-root-info` 返回当前生效路径与是否为默认值、各工作区的 worktree 目录大小统计）、`src/shared/types/ipc.ts`（`// --- settings ---` 段内追加）、`src/preload/domains/settings.ts`（若 settings 域还在 `preload/index.ts` 内联，则只在那里加两个方法）
- `src/renderer/components/settings/GeneralSettings.tsx`（新建「通用」页）、`SettingsView.tsx`（导航加一项，放在「模型服务」之前）、`src/renderer/stores/settings.ts`
- 不要动其它文件（Task 15 正并行改 providers 相关文件）。

## 要做什么
1. **默认位置**：未配置时 = `<仓库父目录>/<仓库目录名>-worktrees/<workspaceId>/<slug>`，即与仓库同盘、同级（例：`D:\project\fynvra` → `D:\project\fynvra-worktrees\…`）。仓库父目录不可写时退回 `userData/worktrees` 并记 warning。
2. **用户配置**：`preferences.worktreesRoot` 为绝对路径时 = `<worktreesRoot>/<仓库目录名>/<workspaceId>/<slug>`。校验：绝对路径、不在任何已挂入仓库内部、可创建；不合法时 IPC 返回错误，不写入。
3. **设置页「通用」**：显示当前生效的根目录（默认时标注「默认：仓库同级目录」）、「选择目录…」（Main 弹框）、「恢复默认」；下方列出各工作区 worktree 目录的占用大小与数量（扫描 orchestration 快照里登记的 worktree，目录大小用 `fs` 递归统计，异步、可取消）；文案提醒「已合并任务的 worktree 会在 cleanup 后删除」。
4. **已有 worktree 不迁移**：路径存在 `Worktree.path` 里，改设置只影响新建的。
5. 测试：默认路径推导（含父目录不可写回退）、配置校验（相对路径、仓库内部、不可写）、IPC 收窄、settings 解析。

## 验收标准
根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿；`pnpm dev` 下改目录后新派任务的 worktree 出现在新目录（写进总结）。

## 提交 / 完成动作
`<type>(main|renderer|shared|preload): <summary>` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不 push 不建 PR。
写 `.workflow/scratch/wave3/summary-worktrees-root.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
