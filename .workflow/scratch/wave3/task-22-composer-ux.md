# Task 22 · composer-ux —— 输入框切审批档位、方向键翻历史输入、显示当前分支

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/PRODUCT.md`（三档审批）、`docs/ARCHITECTURE.md` §4（`ApprovalMode`）、§7、§9.2、§9.3，
`.workflow/scratch/wave3/summary-approval-gate.md`（审批门：`createApprovalGate({ mode })`、allowSession 记忆、保护底线）、`summary-model-picker.md`（会话级设置 + `set-model` 往返的做法，本卡的审批档位照它做）、`summary-chat-ui.md`（Composer / StatusBar / drafts）。
参考市面做法（只学交互，不复制）：Claude Code 的 Shift+Tab 循环权限模式（default → acceptEdits → plan → bypassPermissions）并在输入框下方显示当前模式；EnsoCode 的三档审批（全程审批 / 自动接受编辑 / 完全放行）运行中可切，状态栏显示档位；Cursor 的 Ask / Agent / Auto-run。终端类工具的 ↑ / ↓ 翻历史输入。

## 范围（允许改）
- `src/shared/types/chat.ts`（`SessionSummary` 加 `approvalMode: ApprovalMode`、`branch?: string`）、`src/shared/types/agent.ts`（新增 `set-approval-mode` 命令，parser + 测试）、`src/shared/types/ipc.ts`（`// --- sessions ---` 段内追加 `sessions:set-approval-mode`）
- `packages/agent-runtime/src/approval/**`（审批门加 `setMode(mode)`，切换时清空 allowSession 记忆？——**定为保留记忆**，但从 full 切回更严档位时清空）及测试
- `src/agent/**`（收 `set-approval-mode`，调用 gate.setMode）、`src/main/services/agentHost/**`、`src/main/services/sessions/**`（记录持久化；`branch` 由 Main 在 `list` / `sessions:changed` 时用 git 读 cwd 的当前分支：`git symbolic-ref --short HEAD`，detached 时给短 sha；复用 `src/main/services/gitRepository.ts` 或 orchestration 的 `nodeExec`，带 2 秒超时与结果缓存，agent_settled 后刷新一次）
- `src/main/ipc/sessions.ts`（及测试）、`src/preload/domains/sessions.ts`
- `src/renderer/components/chat/{Composer,StatusBar,ChatView,ApprovalModePicker}.tsx`（ApprovalModePicker 新建）、`src/renderer/stores/sessions/**`、`src/renderer/lib/api/sessions.ts`、`src/renderer/components/chat/inputHistory.ts`（新建，纯函数）及测试
- 不要动 settings 页、orchestration、packages/core。

## 要做什么
1. **审批档位切换**
   - 会话创建时 `approvalMode` 取角色的值并存进 `SessionSummary`；输入框左下角模型胶囊旁加「审批」胶囊：`supervised`（全程审批）/ `auto-edits`（自动接受编辑）/ `full`（完全放行），点开为三项说明列表，`Shift+Tab` 在输入框聚焦时循环切换，切换后胶囊闪一下并在状态栏显示。
   - `sessions:set-approval-mode { sessionId, mode }` → Main 更新记录、落盘、向 worker 发 `set-approval-mode` → 审批门即时生效（运行中也允许切，这是和模型切换的区别）；worker 未启动时只改记录，下次 spawn 用新值。
   - 保护底线（`rm -rf`、`git push` 等）在 full 下仍要人确认，提示文案要说明。
   - orchestrator 派出的 worker 会话按其角色的档位，不继承。
2. **方向键翻历史输入**
   - `inputHistory.ts`：输入 `{ entries: string[], draft, cursor }`，`up()` / `down()` 返回新状态；到底部回到草稿；重复的相邻条目去重；最多 200 条。
   - Composer：输入框为空或光标在第一行时按 ↑ 取上一条，在最后一行按 ↓ 取下一条；浏览历史时编辑会脱离历史态；Esc 回到草稿。历史来源 = 该会话 history 里的 user 消息 + 本次会话里发送过的（store 内存）；切换会话各自独立。
3. **显示当前分支**
   - 会话标题行角色徽标后加分支徽标（`git-branch` 图标 + 分支名；worker 会话显示其 worktree 分支，detached 显示短 sha），hover 显示 cwd；状态栏右侧也显示分支。
   - 分支变化（用户在外部 checkout）通过 `sessions:changed` 刷新：Main 在 `history` / `list` 调用、`agent_settled`、窗口 focus 时重读（节流 3 秒）。
4. **测试**：parser 坏输入；审批门 setMode 的记忆规则；set-approval-mode 在 running 时也成功；分支读取（真实临时 git：普通分支、detached、非 git 目录返回空）；`inputHistory` 全路径；store 乐观更新与回滚。
5. **真机**：`pnpm dev`，orchestrator 会话切到 full 后让它跑 `run_checks`；新建 worker 会话切 supervised 跑 `echo` 弹审批条；↑ 翻出上一条输入；在外部 `git checkout -b test` 后标题行分支随之变化。证据写进总结。

## 验收标准
根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿；真机证据写进总结。

## 提交 / 完成动作
`<type>(renderer|main|agent|agent-runtime|shared|preload): <summary>` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不 push 不建 PR。
写 `.workflow/scratch/wave3/summary-composer-ux.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
