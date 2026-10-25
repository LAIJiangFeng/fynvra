# Task 25 · keybindings —— 快捷键：统一注册、可改键、设置页

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/ARCHITECTURE.md` §7，`.workflow/scratch/wave3/summary-copy-trim.md`（文案极简）、`summary-composer-ux.md`（输入框已有 Shift+Tab 切审批、↑↓ 翻历史）。
参考 EnsoCode：`src/renderer/components/settings/KeybindingsSettings.tsx`、`src/shared/keybindingAccelerator.ts`（按键串规整 / 显示 / 冲突）。只学结构。

## 范围（允许改）
- `src/shared/keybindings.ts`（新建：动作表、默认键、按键串规整 `normalizeChord`、显示名、冲突检测；纯函数 + 测试）、`src/shared/types/settings.ts`（`Preferences.keybindings: Record<ActionId, string>` 覆盖表，放 `// --- keybindings ---` 块）
- `src/renderer/lib/keybindings/**`（新建：`useKeybindings` 全局监听、作用域判断、`KeybindingProvider`）、`src/renderer/App.tsx`（只加一行挂载）
- `src/renderer/components/settings/KeybindingsSettings.tsx`（新建）、`SettingsView.tsx` / `settingsViewStore.ts`（加「快捷键」一项）、`src/renderer/stores/settings.ts`
- 现有组件只允许把「写死的按键判断」替换为动作调用（`Composer.tsx` 的 Shift+Tab / ↑↓ / Enter、`TitleBar.tsx` 的设置按钮、`SidePanel.tsx` 开关），每处改动 ≤ 5 行
- 不要动 Main、packages。Task 24 / 26 并行在改 `settings.ts` 与 `SettingsView.tsx`，各自加自己的块与导航行。

## 动作表（默认键，Windows / Linux 用 Ctrl，macOS 用 Cmd）
| 动作 | 默认 | 作用域 |
|---|---|---|
| 新建会话 | Ctrl+N | 全局 |
| 打开设置 | Ctrl+, | 全局 |
| 切换右侧面板 | Ctrl+B | 全局 |
| 聚焦输入框 | Ctrl+L | 全局 |
| 上一个 / 下一个会话 | Ctrl+Shift+[ / Ctrl+Shift+] | 全局 |
| 发送 | Enter | 输入框 |
| 换行 | Shift+Enter | 输入框 |
| 切换审批档位 | Shift+Tab | 输入框 |
| 停止当前回合 | Esc（运行中） | 输入框 |
| 打开模型选择器 | Ctrl+M | 输入框 |
| 搜索会话 | Ctrl+K | 全局（如无搜索功能，做成按标题过滤侧栏的简单输入） |

## 要做什么
1. 动作表 + 默认键 + 用户覆盖（settings），`normalizeChord('ctrl+shift+k')` 规整大小写与顺序，显示用平台符号（⌘⇧ / Ctrl+Shift+），冲突检测（同作用域同键）。
2. 全局监听器：忽略在 `<input>/<textarea>` 里的全局键（除非动作标了 `allowInInput`）；输入框作用域由 Composer 自己派发。
3. 设置页「快捷键」：每行「动作 — 当前键 — 改键 / 重置」，改键是「按下组合键录入」，冲突红字提示，「全部重置」。文案极简。
4. 测试：规整 / 冲突 / 平台显示；settings 收窄；监听器作用域判断。

## 验收标准
根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿；`pnpm dev` 下默认键都生效，改一个键后立即生效且重启保留。

## 提交 / 完成动作
`<type>(renderer|shared): <summary>` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不 push 不建 PR。
写 `.workflow/scratch/wave4/summary-keybindings.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
