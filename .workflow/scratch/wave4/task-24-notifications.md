# Task 24 · notifications —— 桌面通知：回合完成、worker 完成、需要审批 / 提问

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/ARCHITECTURE.md` §7、§9.2，`.workflow/scratch/wave3/summary-copy-trim.md`（文案极简原则：控件名能说明的不加说明，说明放 tooltip）。
参考 EnsoCode：`src/main/services/notifications.ts`、`src/shared/coworkerNotification.ts`、`src/renderer/components/settings/GeneralSettings.tsx` 里「仅主 agent 发送完成通知」一项。只学结构。

## 范围（允许改）
- `src/main/services/notifications/**`（新建）、`src/main/services/agentHost/**`（只加事件钩子调用，不改逻辑）、`src/main/services/orchestration/**`（只加 worker_done / question 钩子调用）
- `src/main/ipc/{settings,notifications}.ts`、`src/shared/types/{settings,ipc}.ts`（`Preferences.notifications` 块 + `notifications:test` 通道）、`src/preload/domains/notifications.ts`（新建）+ `preload/index.ts`、`preload/types.ts` 各一行
- `src/renderer/components/settings/NotificationSettings.tsx`（新建）、`SettingsView.tsx` / `settingsViewStore.ts`（加「通知」一项，放在「通用」之后）、`src/renderer/stores/settings.ts`
- 不要动 chat 组件、packages。Task 25 / 26 并行在改 `settings.ts` 的 Preferences 与 `SettingsView.tsx`：你的字段放在 `// --- notifications ---` 注释块里，导航只加一行。

## 要做什么
1. 事件 → 通知（Electron `Notification`，窗口聚焦且正看着该会话时不弹）：
   - 主 agent（orchestrator 或用户直接对话的会话）回合结束（`agent_settled`）：标题 = 会话标题，正文 = 最后一条 assistant 文本前 80 字；失败（`error`）另一条。
   - worker 会话：`worker_done`（succeeded / failed）、`question`、`escalation`。
   - 任何会话的审批请求（`approval_request`）。
   - 点击通知：聚焦窗口并切到该会话（经 `sessions:focus` 推送给 Renderer，Renderer 的 store 订阅后 `selectSession`；这一行订阅允许加在 `stores/sessions`）。
2. 设置「通知」页（极简文案）：总开关；「仅主 agent 完成」开关（默认开：worker 的完成 / 失败不弹，提问与审批仍弹）；「提问与审批」开关；「声音」开关（系统默认音）；「发送测试通知」按钮。字段：`notifications: { enabled, mainAgentOnly, askAndApproval, sound }`，默认值与 `parsePreferences` 收窄 + 测试。
3. 节流：同一会话 2 秒内多条合并为最后一条；应用启动后 5 秒内不弹（避免恢复会话时轰炸）。
4. 测试：规则纯函数（哪些事件在哪些设置下弹、聚焦抑制、节流）、settings 收窄、IPC 入参。真机：`pnpm dev` 最小化窗口让一个会话回答一句，收到 Windows 通知；点击回到该会话。

## 验收标准
根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿；真机证据写进总结。

## 提交 / 完成动作
`<type>(main|renderer|shared|preload): <summary>` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不 push 不建 PR。
写 `.workflow/scratch/wave4/summary-notifications.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
