# Task 01 · app-shell —— Electron 应用骨架

先读：`docs/PRODUCT.md`、`docs/ARCHITECTURE.md`、`AGENTS.md`、`.workflow/specs/01-workflow.md`。
参考：`D:\project\EnsoCode`（`electron.vite.config.ts`、`tsconfig*.json`、`biome.json`、`vitest.config.ts`、`src/main/index.ts`、`src/main/ipc/index.ts`、`src/main/ipc/settings.ts`、`src/preload/index.ts`、`src/renderer/stores/settings/`、`src/renderer/components/ui/`、`src/renderer/styles/`）。学模式，不要整段复制。

## 范围（允许改）
- 根配置文件：`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`electron.vite.config.ts`、`biome.json`、`vitest.config.ts`、`tsconfig.json`、`tsconfig.node.json`、`tsconfig.web.json`、`electron-builder.yml`、`.gitignore`、`.nvmrc`、`.npmrc`
- `src/main/**`、`src/preload/**`、`src/renderer/**`、`src/shared/**`、`src/types/**`、`test/stubs/**`、`resources/**`（图标可用占位 PNG）
- **不要动** `packages/**`、`src/agent/**`、`docs/**`（除非发现契约错误，写进总结）。

## 要做什么
1. **工程骨架**：pnpm workspace（`packages/*`），Electron 45 + electron-vite 6 + React 19 + Tailwind 4 + Zustand 5 + Biome 2 + Vitest 4 + TypeScript strict。脚本：`dev`、`build`、`typecheck`、`lint`、`lint:fix`、`test`、`format`。`vitest.config.ts` include 要覆盖 `src/**/*.test.ts(x)` 和 `packages/*/src/**/*.test.ts`；对 `electron`、`@electron-toolkit/utils` 提供 `test/stubs/` 别名。Vite alias：`@`、`@shared`、`@fynvra/core` → `packages/core/src/index.ts`、`@fynvra/agent-runtime` → `packages/agent-runtime/src/index.ts`（这两个包此时可能还不存在，alias 先配上，不要 import 它们）。
2. **Main**：`src/main/index.ts` 创建主窗口（`contextIsolation: true`、`nodeIntegration: false`）；`windows/createAppWindow.ts` 提供 `sendToAllWindows`；`ipc/index.ts` 的 `registerIpcHandlers()`；`ipc/settings.ts`（读写 `userData/settings.json`，500ms debounce + 原子替换）、`ipc/workspaces.ts`（挂入 / 列出 / 移除仓库：`dialog.showOpenDialog` 选目录，校验是 git 仓库，存入 settings，Renderer 只拿到 id 和展示用路径）、`ipc/window.ts`（最小化 / 最大化 / 关闭）。
3. **Shared**：`src/shared/types/ipc.ts`（`IPC_CHANNELS`，`domain:action`）、`src/shared/types/settings.ts`（`Settings` 类型 + 默认值 + `parseSettings(unknown)`）、`src/shared/types/workspace.ts`（与 ARCHITECTURE §4 的 `Workspace` 一致）。
4. **Preload**：按领域暴露 `window.fynvra = { settings, workspaces, window }`，`src/preload/types.ts` 导出类型并 `declare global`。
5. **Renderer 壳**：三栏布局（左：工作区 / 会话侧栏；中：主区域占位「选择一个工作区开始」；右：可折叠侧面板占位），顶部自绘标题栏（Windows 下 `titleBarStyle: 'hidden'` + 自绘窗口按钮）。`stores/settings.ts`（Zustand persist，通过 preload 落到 settings.json，带 hydration 写门控）、`stores/workspaces.ts`。主题：light / dark / system，Tailwind 4 `@theme` + oklch 变量，`.dark` class。`components/ui/` 先封装 `button`、`input`、`dialog`、`dropdown-menu`、`tooltip`、`scroll-area`（基于 `@base-ui/react`，shadcn new-york 风格）。
6. **测试**：`parseSettings`、settings 文件读写（临时目录）、workspace 校验（非 git 目录拒绝）、IPC 入参收窄。

## 硬约束
- 遵守 `docs/ARCHITECTURE.md` §7 IPC 规则；入参 `unknown` 收窄；不暴露通用 invoke。
- `src/shared` 不 import Node / Electron。
- 只有 Main / worker 运行时 import 的包放 `dependencies`，renderer 库放 `devDependencies`。
- `pnpm dev` 能起窗口；`pnpm build` 能产出 `out/`。

## 验收标准
- `pnpm install && pnpm typecheck && pnpm lint && pnpm test` 全绿。
- `pnpm build` 成功。
- 能挂入一个本地 git 仓库并在侧栏看到；非 git 目录被拒绝并有提示。
- 主题切换生效并持久化。

## 提交
多次小提交，`<type>(<scope>): <summary>`，末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不 push、不建 PR。

## 完成动作
按 `.workflow/specs/01-workflow.md` 第 5 条：写 `.workflow/scratch/bootstrap/summary-app-shell.md` 并提交，`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
