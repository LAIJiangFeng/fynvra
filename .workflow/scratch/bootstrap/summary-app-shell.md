# Summary · Task 01 app-shell

分支 `LAIJiangFeng/app-shell`。worktree 创建时停在 `f5c2e91`，看不到文档和任务卡，开工前把分支快进到了 `main@32bf977`（`git merge --ff-only main`，没有改 `main`）。相对 `main` 共 10 个提交，63 个文件，全部在任务书「范围」内。

## 做了什么

**工程骨架**（版本以安装结果为准）

| 项 | 版本 / 做法 |
|---|---|
| Electron / electron-vite / Vite | 45.0.0（内置 Node 24.22）/ 6.0.0 / 8.3.5 |
| React / Tailwind / Zustand / Base UI | 19.3 / 4.3（`@tailwindcss/vite`）/ 5.0 / 1.9 |
| TypeScript / Biome / Vitest | 7.0.2 strict / 2.6.2 / 4.1.12 |
| pnpm | 10.26.2 workspace（`packages/*`），`allowBuilds` 忽略 electron-winstaller 的安装脚本 |

- 脚本：`dev`、`build`、`preview`、`typecheck`（= `typecheck:node` + `typecheck:web`）、`lint`、`lint:fix`、`format`、`test`、`test:watch`。
- tsconfig：根 `tsconfig.json` 是基础配置（strict、`types: ["node"]`、`@fynvra/*` paths，`files: []` + references），供 `packages/*` 继承。`tsconfig.node.json` 覆盖 main / preload / shared 和全部测试，没有 DOM；`tsconfig.web.json` 覆盖 renderer，只有 DOM 和 vite/client，没有 Node 全局。
- Biome：2 空格、单引号、分号、宽 100。`noRestrictedImports` 禁止 `src/shared`、`src/renderer` import `electron` 和 `node:*`，禁止 `packages/**` import `electron`。
- Vitest：node 环境，include 覆盖 `src/**/*.test.ts(x)` 和 `packages/*/src/**/*.test.ts`；`electron`、`@electron-toolkit/utils` 指向 `test/stubs/`。
- Vite alias：main 配 `@shared` + `@fynvra/core` + `@fynvra/agent-runtime`；preload 配 `@shared`；renderer 配 `@`、`@shared`、`@fynvra/core`。两个包目前还不存在，只配了 alias，没有 import。
- 依赖：`dependencies` 只有 `@electron-toolkit/utils`（Main 运行时用），其余全部放 devDependencies。

**Main**（`src/main`）
- `index.ts`：单实例锁；dev 的 userData 隔离到 `%APPDATA%/fynvra-dev`，`FYNVRA_USER_DATA_DIR` 只在 dev 下生效；启动失败时弹错误框。
- `windows/createAppWindow.ts`：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。Windows / Linux 用 `titleBarStyle: 'hidden'`，窗口按钮由 Renderer 自绘；macOS 用 `hiddenInset`。外链交给系统浏览器，禁止页面跳离本地 UI。另外提供 `sendToAllWindows` / `sendToWindow`。
- `ipc/settings.ts`：`settings:get` / `settings:update`，入参按 `unknown` 严格收窄，变更后广播 `settings:changed`，`before-quit` 时 flush。`nativeTheme.themeSource` 跟随主题设置。
- `ipc/workspaces.ts`：`workspaces:list` / `add` / `remove`。挂入时由 Main 弹 `dialog.showOpenDialog`，Renderer 不传路径；校验通过才写入 settings；Renderer 只拿到 `{ id, name, displayPath, defaultBranch }`；移除只按 id。
- `ipc/window.ts`：最小化、切换最大化、关闭、`is-maximized`，外加 `window:maximized-changed` 推送。
- `services/settingsFile.ts`：内存快照 + 500ms debounce + 原子替换（先写同目录 `.tmp` 再 rename），写失败保留待写状态，下次重试。
- `services/gitRepository.ts`：只接受 git 工作区根目录。子目录返回 `not-repo-root` 并给出根路径，不会静默挂到外层仓库；默认分支按 origin/HEAD → 本地 main/master → 当前分支 → `main` 的顺序取。
- `services/workspaces.ts`：工作区注册表。重复挂入返回已有记录；Windows 下判重忽略大小写；展示路径只在非 Windows 下把 home 缩写成 `~`。

**Shared**（`src/shared`）：`types/ipc.ts`（`IPC_CHANNELS` 和 `IpcResult`）、`types/settings.ts`（`Settings` / `Preferences`、默认值、宽松的 `parseSettings`、严格的 `parsePreferencesPatch`）、`types/workspace.ts`（与 §4 一致的 `Workspace`、`WorkspaceSummary`、`parseWorkspaceId`）、`guards.ts`。

**Preload**：`window.fynvra = { settings, workspaces, window }`。不提供通用 invoke / send，事件回调拿不到 `IpcRendererEvent`。`types.ts` 只有类型、不 import electron，里面 `declare global` 了 `Window.fynvra`。preload 输出为 CJS（`out/preload/index.cjs`），这样能保留 sandbox。

**Renderer**
- 布局：自绘标题栏（主题菜单、右栏开关、Windows/Linux 窗口按钮）+ 三栏：左侧工作区/会话侧栏，中间主区域（未选工作区时显示「选择一个工作区开始」），右侧可折叠侧面板。
- 挂入被拒绝时，用 `NoticeDialog` 弹出原因。
- `stores/settings.ts` 是 Zustand persist，经 preload 落到 settings.json，带 hydration 写门控：首次 merge 之前的写入直接丢弃，读取失败时一直关闸。工厂函数在 `createSettingsStore.ts`，不依赖 window，可以在 node 下测试。
- `stores/workspaces.ts` 负责工作区列表。
- 主题支持 light / dark / system：Tailwind 4 `@theme inline` + oklch 变量（zinc），`.dark` 用 class 切换（`@custom-variant`）。
- `components/ui/` 下有 button、input、dialog、dropdown-menu、tooltip、scroll-area，基于 `@base-ui/react`，shadcn new-york 风格。

**测试**（10 个文件，84 个用例）
- `parseSettings`、`parsePreferencesPatch`、`parseWorkspaceId` 的坏输入，以及 IPC 通道命名。
- settings 文件读写（临时目录）：防抖、原子替换、损坏文件、写失败后重试。
- 用真实 git 校验工作区：非 git 目录、子目录、不存在的目录都被拒绝；另用注入的 runner 测 git 缺失和默认分支。
- IPC 入参收窄，通过 mock ipcMain 直接调 handler：非法入参返回 `{ ok: false }`，不抛异常也不改数据。工作区 IPC 走完整流程：mock dialog + 真实 git，包括非 git 目录被拒、挂入、移除。
- preload：不暴露通用 invoke，订阅能正确取消。
- settings store 的写门控：曾把闸门改成默认打开做反向验证，两个闸门用例确实会失败。

## 怎么验证

1. 删除 `node_modules` 和 `out` 后执行 `pnpm install && pnpm typecheck && pnpm lint && pnpm test`，exit 0：
   - install：`Packages: +379`，11.1s，没有警告。
   - typecheck：node 和 web 两个程序都通过。
   - lint：`Checked 57 files … No fixes applied.`
   - test：`Test Files 10 passed (10) / Tests 84 passed (84)`。
   - 跑完后 `git status` 是干净的，锁文件没有变化。
2. `pnpm build` 成功，产出 `out/main/index.js`、`out/preload/index.cjs`、`out/renderer/index.html` 和 assets。
3. 运行时冒烟：用临时 userData 预置一个工作区，`pnpm dev --remoteDebuggingPort` 启动，经 CDP 发真实鼠标事件。没有截图，结论全部来自 DOM 和磁盘：
   - `window.fynvra` 只有那三个域，没有 invoke；页面上没有 `require` / `process`。
   - 侧栏显示了预置的工作区，点击后标题栏和主区域都切换过去。
   - 主题菜单选「深色」后 `<html>` 加上了 `.dark`，0.9s 后 settings.json 里是 `theme: "dark"`；收起右栏后 `sidePanelOpen: false` 也写进了磁盘。
   - 重启后 `.dark` 和收起状态都恢复了。
   - 控制台没有任何 error、warning 或 CSP 违规（dev 下 React Refresh 正常）。
   - 用 `electron .` 跑 `out/`（`loadFile`，`file://`）复测，结果相同。
   - 通过 IPC 关窗后进程正常退出，exit 0。
4. `electron-builder --win --dir`（复用本地 electronDist）成功。app.asar 里只有 `out/**`、`package.json` 和 `@electron-toolkit/utils`。产物已经删除。
5. 边界探针（临时文件，已删除）：
   - Biome 对 shared 里的 `electron` / `node:*` 报错，main 里不报。
   - renderer 里写 `process` / `Buffer` / `require`，`typecheck:web` 会报 TS2591。

## 未做 / 越界项

- 没有修改范围外的文件。
- 建议补一个 `.gitattributes`，但它不在范围内，我没有加，理由见注意事项第 1 条。
- 没有自动化「点 + → 原生目录框 → 选目录」这一步（原生对话框无法用 CDP 驱动）。Main 侧用 mock dialog + 真实 git 测过，UI 侧验证了列表渲染。这一步需要用户在 `pnpm dev` 里手动点一次：选一个 git 仓库，应该出现在侧栏；选一个非 git 目录，应该弹出「无法挂入仓库 / 所选目录不是 git 仓库：…」。
- 以下不在本卡范围：会话、i18n、窗口尺寸记忆、settings.json 损坏时的备份（损坏时按默认值启动，下一次写入会覆盖它）。
- `Input` 组件已经封装，但壳里暂时没有地方用它。
- renderer 产物是未压缩的 1.19 MB，这是 electron-vite 的默认行为，暂时没有调整。
- `package.json` 没有 `author` 字段，electron-builder 会给一条警告。

## 给验收人的注意事项

1. **行尾**：本机 `core.autocrlf=true`（system 级），工作区会被检出为 CRLF，而 Biome 默认按 LF 检查，合并或新克隆后 `pnpm lint` 会全部失败（已实测）。范围内的修法是 `formatter.lineEnding: "auto"`（单独的提交 `6887cad`）：Windows 期望 CRLF，其他平台期望 LF，仓库里存的仍然是 LF。这样在本机和合并后的 `main` 上都能通过，但 Windows 上设置了 `autocrlf=false` 的人仍会失败。彻底的修法是加 `.gitattributes`（`* text=auto eol=lf`），同时把 lineEnding 改回 `"lf"`，两处必须一起改。
2. **合并 `packages/*` 时**：
   - 包里如果有自己的 `biome.json`，必须写成 `{ "root": false, "extends": "//" }` 或者删掉，否则根目录的 `biome check .` 会直接报配置错误退出（已实测，在 includes 里排除也没用）。
   - 包的 `tsconfig.json` 如果 `extends: "../../tsconfig.json"`，必须自己写 `include`（比如 `["src"]`）。根配置有 `files: []`，继承之后默认 include 不再生效。
   - 不要把 `@fynvra/*` 加进根 `dependencies`。`externalizeDeps` 会把它外置成运行时 import，而包入口是 `.ts`，运行时加载不了。现在是靠 alias 直接打包源码。
   - 包里的 `pnpm-lock.yaml` 删掉后在根目录重新 `pnpm install`（workspace 只用根锁文件）。
   - 根 vitest 会直接跑 `packages/*/src/**/*.test.ts`。
3. `Workspace` 类型目前在 `src/shared/types/workspace.ts` 和 `@fynvra/core` 各有一份，字段一致，Wave 2 接入 core 时需要统一。
4. renderer 的测试放在 `tsconfig.node.json` 里做类型检查（因为 vitest 的类型会把 Node 全局带进 web 程序），所以被测的 renderer 模块不能直接使用 DOM 全局，参照 `createSettingsStore` 的注入写法。以后要写需要 DOM 的组件测试（`.test.tsx`），得再加 jsdom 和对应的类型配置。
5. 本机 Node 是 23.11.1，所有命令都能通过，但 vitest 4 的 engines 声明是 `^20 || ^22 || >=24`。`.nvmrc` 设为 `24`，与 Electron 45 内置的 Node 主版本一致。
6. Electron 45 不再有 postinstall，二进制在第一次运行时才下载，默认从 GitHub 拉。国内首次 `pnpm dev` 如果很慢，可以临时设置环境变量 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。本 worktree 里的二进制已经下载好了。
7. 提交历史：第一个提交（只有工具链）单独检出时，`typecheck:web` 和 `test` 因为还没有源码而无法通过；从 `0d34c83` 起 typecheck、lint、test 都是绿的，从 `9f4a227` 起 `pnpm build` 也成功。
