# Task 12 · windows-shell —— Windows 下 worker 的 bash 必须是 Git Bash，不能落到 WSL

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`.workflow/scratch/wave2/summary-main-wiring.md` 的「给验收人的注意事项」第 1 条（本卡动机）、
`packages/agent-runtime/README.md`（`createRoleSession` 的 `settingsManager` 参数）、pi 文档 `node_modules/@earendil-works/pi-coding-agent/docs/settings.md`（搜 `shellPath`）与 pi 在 Windows 上找 shell 的源码（`node_modules/@earendil-works/pi-coding-agent/dist/**` 里搜 `bash.exe`）。

## 问题
pi 在 Windows 找 shell 的顺序是 `%ProgramFiles%\Git\bin\bash.exe` → PATH 上第一个 `bash.exe`。本机 Git 装在 `D:\Software\Git`，PATH 第一个 `bash.exe` 是 `C:\Windows\System32\bash.exe`（WSL）。WSL 的 git 把 worktree 的 `gitdir:` Windows 路径当相对路径，worker 的 `git commit` 失败。

## 范围（允许改）
- `src/main/services/agentHost/shell.ts`（新建：探测逻辑）及测试；`src/main/services/agentHost/**` 里把探测结果塞进 `spawn-session` 的 spec（字段名 `shellPath?: string`）
- `src/shared/types/agent.ts`：`spawn-session` 的 spec 加可选 `shellPath` 并更新 parser 与测试
- `src/agent/shell.ts`（新建）+ `src/agent/piSession.ts`：**只允许改一处**——把 `shellPath` 传给 `createRoleSession` 的 `settingsManager`（内存 SettingsManager 设 `shellPath`），其它逻辑放新文件
- 不要动 renderer / preload / packages。

## 要做什么
1. Main 侧 `detectShell()`：Windows 下按顺序取 `where.exe git.exe` 的第一个结果推出 `<GitRoot>\bin\bash.exe`（校验存在）→ `%ProgramFiles%\Git\bin\bash.exe` → `%ProgramFiles(x86)%\Git\bin\bash.exe` → `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`；都没有则 `undefined` 并记 warning。非 Windows 返回 `undefined`（用 pi 默认）。结果缓存；允许用户在 settings.json 用 `shellPath` 覆盖（读 `Settings`，如字段不存在就加到 `Preferences` 并走 `parseSettings`——这属于范围外的 `src/shared/types/settings.ts`，若要加请只加一个可选字段并补测试，在总结里说明）。
2. 把 `shellPath` 带到 worker，worker 用它构造 SettingsManager。
3. 测试：注入假 `exec` / `existsSync` 断言探测顺序；parser 坏输入；worker 侧断言 settings 里有 `shellPath`。
4. 真机验证：在本机 `pnpm dev`（不要改 PATH），新建 worker 会话让它执行 `git --version && echo $BASH` 之类命令，确认走的是 Git Bash（输出 `D:/Software/Git/...`）。把输出写进总结。

## 验收标准
根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿；真机验证证据在总结里。

## 提交 / 完成动作
`<type>(main|agent|shared): <summary>` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不 push 不建 PR。
写 `.workflow/scratch/wave3/summary-windows-shell.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
