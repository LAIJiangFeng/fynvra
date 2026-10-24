# Summary · Task 12 windows-shell（Windows 下 worker 的 bash 必须是 Git Bash，不能落到 WSL）

分支 `LAIJiangFeng/windows-shell`。worktree 建在 `f5c2e91`（Initial commit）上。开工前做了这些准备：

- `git merge --ff-only main` 快进到 `main@102a8b5`；
- 在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`，没有产生改动，`git ls-files --eol` 里 CRLF 为 0；
- `pnpm install --frozen-lockfile`；
- `node node_modules/electron/install.js`，从本机缓存解压 Electron，没有联网。

`main` 没动。相对 `102a8b5` 共 6 个改动提交，涉及 13 个文件（+469 / −4），另有本总结的 `docs(wave3)` 提交。每个提交都带 `Co-Authored-By: Claude Opus 5.5`，未 push、未建 PR。

**没有 BLOCKED 项。** 范围外改了两个文件：

- `src/shared/types/settings.ts`：任务书明确允许，只加了一个可选字段；
- `src/main/ipc/sessions.ts`：生产组合根，3 行。

理由见「未做 / 越界项」。

## 做了什么

| 提交 | 内容 |
|---|---|
| `1c10fec` feat(shared) | `SpawnSessionSpec` 加 `shellPath?: string`；parser 只接受非空字符串，其他值整条丢弃 |
| `39443a8` feat(shared) | `Preferences` 加 `shellPath?`，即 settings.json 里手写的覆盖值；`settings:update` 仍然不接受这个字段 |
| `91e5a6d` feat(main) | 新文件 `agentHost/shell.ts`：`detectShell()` 与 `createShellPathResolver()`，测试 17 条 |
| `fd9cbca` feat(main) | `createAgentHost` 新增可选依赖 `resolveShellPath`；`buildSpec` 把结果写进 spawn-session 的 spec |
| `c94a19b` feat(main) | 组合根 `createAppAgentHost` 注入 resolver（范围外，3 行） |
| `853155a` feat(agent) | 新文件 `src/agent/shell.ts`：`createSessionSettings(shellPath)`；`piSession.ts` 只改一处 |

### 1. Main 侧 `detectShell()`（任务书第 1 条）

**探测顺序**（`src/main/services/agentHost/shell.ts`）：Windows 上取第一个**存在**的路径。

1. `where.exe git.exe` 第一个结果所在安装目录下的 `bin\bash.exe`。安装根按 Git for Windows 的布局推出，支持三种位置：
   - `<root>\cmd\git.exe`
   - `<root>\bin\git.exe`
   - `<root>\{mingw64,mingw32,clangarm64}\bin\git.exe`

   其他布局（比如包管理器的 shim）跳过这一项。
2. `%ProgramFiles%\Git\bin\bash.exe`
3. `%ProgramFiles(x86)%\Git\bin\bash.exe`
4. `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`

**两种 PATH 下 `where git.exe` 的结果不同，都已覆盖**：

| 从哪里启动 | `where git.exe` 第一个结果 |
|---|---|
| PowerShell | `D:\Software\Git\cmd\git.exe` |
| Git Bash（mingw64\bin 在 PATH 前面） | `D:\Software\Git\mingw64\bin\git.exe` |

**其他行为**：

- **where.exe 的调用**：用 `%SystemRoot%\System32\where.exe` 的绝对路径，因为只给文件名时 Windows 会先在当前目录里找可执行文件。超时设为 5 秒，避免 PATH 上连不上的网络盘拖住第一个会话。where 失败（没找到时退出码为 1）、起不来或超时，都直接退回固定位置。
- **去重**：PATH 上的 Git 正好装在 `%ProgramFiles%` 时，同一个位置只查一次。
- **日志**：
  - 找到时记一条 info：`[shell] worker sessions run bash with <path>`；
  - 都没有时返回 `undefined`，记一条 warning，列出查过的全部路径，并提示安装 Git for Windows 或设置 `preferences.shellPath`。
- **非 Windows**：直接返回 `undefined`，不起子进程，也不查文件，交给 pi 的默认逻辑。
- **缓存**（`createShellPathResolver`）：第一次调用时探测，结果在进程内缓存（没找到也缓存）；并发调用共用同一个 Promise。

**settings.json 覆盖**：`preferences.shellPath` 优先，而且每次调用都会重读。读的是 SettingsFile 的内存快照，开销可以忽略；有覆盖时完全不探测。写法：

```json
{ "version": 1, "preferences": { "theme": "system", "sidePanelOpen": true, "shellPath": "D:\\Software\\Git\\bin\\bash.exe" }, "workspaces": [] }
```

- `parsePreferences` 只保留去掉首尾空白后的非空字符串，其他值丢弃。这个字段没有默认值。
- `parsePreferencesPatch` 照旧拒绝未知字段，所以 Renderer 不能经 `settings:update` 交给 Main 一个可执行文件路径（遵守「Renderer 不传路径」的约定）。
- Renderer 的 persist 层 `partialize` 只回写 `theme` / `sidePanelOpen`，所以手写的值不会被偏好更新冲掉。

### 2. 把 `shellPath` 带到 worker（第 2 条）

- **Main**：
  - `AgentHostDeps.resolveShellPath?(): Promise<string | undefined>`，与 `resolveResources` 的注入方式相同。缺省时返回 `undefined`，测试和现有用例因此不受本机环境影响。
  - `buildSpec` 每次 spawn 都会调用它，只在有值时写入 `spec.shellPath`。
  - worker 崩溃后重新 spawn 时沿用已存的 spec，shell 不变。
- **协议**：`parseSpawnSessionSpec` 遇到 `shellPath` 为空串或非字符串时整条丢弃，与 `baseUrl` 等可选字段的规则一致。
- **worker**：
  - `createSessionSettings(shellPath)` 返回 `SettingsManager.inMemory({ enableInstallTelemetry: false, ...(shellPath ? { shellPath } : {}) })`，也就是 agent-runtime 的默认设置再加上 shellPath。
  - pi 的 bash 工具经 `settingsManager.getShellPath()` 读到它。
  - `piSession.ts` 只多了一行 import，以及传给 `createRoleSession` 的 `settingsManager: createSessionSettings(spec.shellPath)`。
- 所有会话都带上 shellPath。orchestrator 角色没有 bash 工具，带上也没有影响。

### 3. 测试（第 3 条）

| 文件 | 变化 | 覆盖 |
|---|---|---|
| `agentHost/shell.test.ts` | 新增 17 | 见下文 |
| `agentHost/agentHost.test.ts` | 25 → 26 | resolver 的结果进入 spawn spec；resolver 返回 undefined 时 spec 里没有这个键 |
| `shared/types/agent.test.ts` | +3 | 带 shellPath 的 spec 原样保留；空串、非字符串整条拒绝 |
| `shared/types/settings.test.ts` | +3 | 磁盘上的 `preferences.shellPath` 保留；trim 后保留、各种坏值丢弃；patch 拒绝 shellPath |
| `src/agent/shell.test.ts` | 新增 2 | 有 / 没有 shellPath 时的 `getShellPath()`、`getGlobalSettings()`，以及遥测保持关闭 |
| `src/agent/piSession.test.ts` | 3 → 4 | 工厂交给 `createRoleSession` 的 `settingsManager` 带 spec 的 shellPath，且遥测关闭（只用 `vi.mock` 替换 `createRoleSession`） |

`agentHost/shell.test.ts` 的 17 条用例注入假的 `exec` / `existsSync`，断言：

- 探测顺序与 where.exe 的绝对路径；
- 四种 git.exe 布局；
- 只取 where 的第一行；
- 逐级回退到三个固定位置；
- where 失败时的处理；
- shim 布局跳过；
- 缺环境变量的位置跳过；
- 没找到时只告警一次、列出全部路径，同一位置不重复查；
- 非 Windows 不探测；
- settings 覆盖优先且不触发探测；
- 缓存与并发；
- 覆盖在每次调用时生效。

**TDD 顺序**（如实说明）：每一步都是先写测试、跑红、再实现。

- 协议：3 红；
- settings：2 红。「patch 拒绝 shellPath」那条本来就是绿的，它用来钉住现有行为；
- `shell.ts`：模块不存在；
- agentHost：1 红；
- worker：模块不存在，加上接线测试拿到的 `settingsManager` 为 undefined。

**变异验证**：对 `shell.ts` 做了 5 处变异，每一处都至少让 1 条用例失败。

| 变异 | 失败条数 |
|---|---|
| 去掉去重 | 1 |
| 不处理 mingw64 布局 | 2 |
| 取 where 的最后一行 | 1 |
| 不读覆盖 | 2 |
| 不缓存 | 2 |

恢复后用 `cmp` 确认与原文件完全一致，17 条全绿。

### 4. 真机验证（第 4 条）

**环境**：

- 从 PowerShell 启动，**没有改 PATH**。
- 冒烟脚本把 dev 进程拿到的环境记进了 `env.json`：

  ```
  where bash.exe → C:\Windows\System32\bash.exe, C:\Users\15407\AppData\Local\Microsoft\WindowsApps\bash.exe
  where git.exe  → D:\Software\Git\cmd\git.exe
  PATH 顺序      → C:\WINDOWS\system32 … D:\Software\Git\cmd
  C:\Program Files\Git\bin\bash.exe 存在？ → false
  ```

  也就是说，没有这次修复时，pi 自己找到的是 WSL。
- 注意：不能从 Git Bash（例如 Claude Code 的 Bash 工具）里启动冒烟。Git Bash 会把 `D:\Software\Git\usr\bin` 前置到 PATH，pi 会碰巧找到 Git 的 bash，问题被掩盖。

**做法**：

- `pnpm dev --remoteDebuggingPort 9412`，用隔离的 `FYNVRA_USER_DATA_DIR`。
- 在 127.0.0.1 起一个假的 Anthropic Messages SSE 端点（经 `providers.upsert` 注册，不联网）。
- 脚本经 CDP 调用 `window.fynvra.*`，与界面走同一套 IPC。结论都来自 IPC 返回值、Main 日志和 git，没有截图。

**第一次启动失败（与本卡代码无关）**：

- 当时整机可用提交内存只有 1.6 GB，同时还有 Task 13 的 Electron 实例、占 10 GB 的 WSL 虚拟机等。
- Vite 的依赖预构建报 `memory allocation of 338736 bytes failed`，`pnpm dev` 以 `0xC0000409` 退出。
- 等 Task 13 的实例退出、可用内存回到 5.8 GB 后重跑，`pnpm dev` 正常。

**第 1 轮：修复生效，不设覆盖**

- Main 日志：

  ```
  [shell] worker sessions run bash with D:\Software\Git\bin\bash.exe
  ```

- **场景 A**：新建 worker 角色会话（cwd 为工作区仓库根），让它执行探针命令：

  ```
  git --version; echo "BASH=$BASH"; uname -s; cygpath -m "$BASH" "$(command -v git)"; cd ../probe-wt && git commit -q --allow-empty -m "probe: commit inside a worktree" && git log --oneline -1
  ```

  bash 工具的输出（`status: done`）：

  ```
  git version 2.53.0.windows.1
  BASH=/usr/bin/bash
  MINGW64_NT-10.0-26200
  D:/Software/Git/usr/bin/bash.exe
  D:/Software/Git/mingw64/bin/git.exe
  e1dfb6b probe: commit inside a worktree
  ```

  `probe-wt` 是冒烟脚本先用 Windows git 建好的 worktree，它的 `gitdir` 是 Windows 路径。在里面提交成功，用 Windows git 读到 `e1dfb6b probe: commit inside a worktree`。
- **场景 B**：Task 11 的完整链路，这次不再前置 PATH。orchestrator 依次调用 `dispatch_task` → `wait_for_workers` → `review_diff` → `merge_worktree` → `cleanup_worktree`。
  - 派发出的 worker 的 cwd 是 Main 建的 worktree（`userData\worktrees\ws-shell-smoke\append-readme-line`），bash 输出：

    ```
    git version 2.53.0.windows.1
    BASH=/usr/bin/bash
    MINGW64_NT-10.0-26200
    D:/Software/Git/usr/bin/bash.exe
    D:/Software/Git/mingw64/bin/git.exe
    C:/Users/15407/AppData/Local/Temp/fynvra-shell-smoke-15a32bde/run-fix/userData/worktrees/ws-shell-smoke/append-readme-line
    warning: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it
    a1cd718 docs: append a line from the worker
    ```

  - `report_done` 返回 succeeded。orchestrator 的 5 个工具调用全部是 `done`：
    - merge 输出 ``merged into `main` as `9432372` ``；
    - cleanup 输出 `worktree removed: yes`、`branch deleted: yes`。
  - git：`main` 为 `9432372 Merge branch 'fynvra/append-readme-line'`（no-ff），README 最后一行是 `Line added by the worker through Git Bash.`。
  - 编排快照：tasks `[completed]`，dispatches `[succeeded]`，worktrees 0，messages `[worker_done]`。
  - 假端点收到 10 个请求，`x-api-key` 全部匹配。

**第 2 轮：对照，用覆盖强制 WSL**

settings.json 写 `"shellPath": "C:\\Windows\\System32\\bash.exe"`，执行同一条探针命令，bash 工具的输出（`status: error`）：

```
git version 2.53.0
BASH=/bin/bash
Linux
/bin/bash: line 1: cygpath: command not found
fatal: not a git repository: /mnt/c/Users/15407/AppData/Local/Temp/fynvra-shell-smoke-15a32bde/run-wsl-override/probe-wt/C:/Users/15407/AppData/Local/Temp/fynvra-shell-smoke-15a32bde/run-wsl-override/repo/.git/worktrees/probe-wt

Command exited with code 128
```

这一轮说明了三件事：

1. settings.json 的覆盖确实一路送到了 worker 的 bash 工具；而且有覆盖时 Main 不探测，日志里没有 `[shell]` 行。
2. 原问题在本机真实存在：WSL 的 git 把 worktree 的 Windows `gitdir:` 当成相对路径，与 Task 11 总结里描述的一致。
3. 因此第 1 轮里 worktree 提交成功，就是这次修复的效果。

**两轮共同的结果**：

- `pnpm dev` 都以 0 退出（经 IPC 关窗 → before-quit → 收尾）；
- Renderer 控制台 0 个 error；
- 之后本 worktree 没有残留的 electron 进程，9412 端口已关闭，`git status` 干净。

冒烟脚本、日志和两轮的 `report.json` 在 `%TEMP%\fynvra-shell-smoke-15a32bde`。这个目录在仓库外，只含假 key，可以直接删除。

## 怎么验证

**验收命令**（最后一个改动提交 `853155a`，根目录）：

```
pnpm typecheck  → exit 0（node / web / packages 三段，0 个 error TS）
pnpm lint       → exit 0：Checked 293 files，No fixes applied
pnpm test       → exit 0：Test Files 89 passed (89)；Tests 1127 passed (1127)（开工基线 87 / 1100）
pnpm build      → exit 0：out/main/index.js 230.44 kB、out/main/chunks/index-<hash>.js（worker）100.05 kB、out/preload/index.cjs 10.04 kB、out/renderer/…
```

构建产物：

- `out/main/index.js` 里 `@earendil-works` 出现 0 次，pi 没有进主进程；
- 探测代码在 Main 包里；
- `shellPath` / `enableInstallTelemetry` 的设置代码在 worker chunk 里。

真机验证见上文第 4 节。

## 未做 / 越界项

- **越界 1：`src/shared/types/settings.ts`**（及其测试）。
  - 任务书允许这样做：「如字段不存在就加到 `Preferences`……只加一个可选字段并补测试」。
  - 只加了 `shellPath?: string`，`parsePreferences` 多两行；`parsePreferencesPatch` 没改。
- **越界 2：`src/main/ipc/sessions.ts`（+3 行：两行 import，加一行依赖）**。
  - 生产环境的 `createAgentHost` 依赖是在这里的 `createAppAgentHost` 里拼装的，读 settings.json 的 `getSettingsFile()` 也只有 ipc 层拿得到。
  - 不在这里注入的话，生产环境拿不到探测结果，worker 照旧落到 WSL，第 4 条的真机验证也无法通过。
  - 我考虑过只改 `agentHost/**` 的两种做法，都放弃了：
    - 让 `createAgentHost` 默认执行真实探测：所有现有测试都会在本机跑 where.exe，结果随机器变化；
    - 由 agentHost 自己去读 settings：services 层要反向 import ipc 层，后者会带进 electron。
  - 这 3 行本身不含逻辑。
- **没有做设置界面**。renderer / preload 按任务书没有动，`shellPath` 目前只能手改 settings.json。
- **`run_checks` 不受影响**，没有改：orchestration 的 `shellRunner` 用 `spawn(command, { shell: true })`，在 Windows 上走 `cmd.exe`，不经过 bash。
- **用户全局说明里的知识库检索**（`maestro spec` / `maestro wiki`）本机不可用：没有 `maestro` 命令，`~/.maestro/workflows/coding-philosophy.md` 也不存在，与前几张卡相同。

## 给验收人的注意事项

1. **where.exe 的输出编码（实测发现的限制，按任务书保留了 where.exe）**
   - where.exe 写管道时用控制台代码页，本机是 GBK，而探测按 UTF-8 解码。
   - 我在临时目录建了 `…\软件\Git\cmd\git.exe` 来测：UTF-8 解码得到 `…\����\Git\cmd\git.exe`，`existsSync` 必然失败；按 GBK 解码才是正确路径。
   - 后果：Git 装在**含非 ASCII 字符的自定义目录**（例如 `D:\软件\Git`）时，第一项探测会漏掉，只能靠三个固定位置兜底。三个固定位置都取自环境变量，没有乱码问题，所以中文用户名下按用户安装的 `%LOCALAPPDATA%\Programs\Git` 仍然能找到。
   - 都没有时 worker 会落回 pi 的默认逻辑（WSL），Main 控制台有告警，用户可以设置 `preferences.shellPath` 解决。
   - 本机 Git 在 `D:\Software\Git`，不受影响。
   - 可选的修法：
     - **推荐**：改为在 Node 里按 PATH 顺序找第一个 `git.exe`（`existsSync(join(dir, 'git.exe'))`）。结果与 where 的第一个结果相同，不起子进程，没有编码问题，也不会先搜当前目录。代价是偏离任务书写明的「`where.exe git.exe`」和「注入假 exec」，所以我没有擅自改。
     - 经 `cmd /d /s /c "chcp 65001 >nul & where.exe git.exe"` 让 where 输出 UTF-8。已实测有效，但要处理 `windowsVerbatimArguments` 的引号，不如上一种简单。
2. **覆盖值原样传给 pi，不做存在性校验**。路径写错时，每次 bash 调用都会报 `Custom shell path not found: …`，这个错误在聊天里能看到，不会悄悄退回自动探测。这是有意的：拼写错误应该被看见，而不是被掩盖。
3. **探测结果在进程内缓存，没找到也缓存**。运行期间新装 Git 后需要重启 Fynvra。告警只出现在 Main 控制台，界面上看不到。如果以后想在界面上提示，可以把 detectShell 的结果经 IPC 暴露给设置页。
4. **`settings:get` 会把 `shellPath` 返回给 Renderer**。只读，不是密钥。以后如果要做设置界面，应参照 `workspaces:add` 由 Main 弹出文件选择框，不要让 Renderer 直接传路径。
5. **与 Wave 3 其他卡的合并冲突预期**：
   - 本卡在几个共享文件里的改动都是局部追加：
     - `agentHost.ts`：`buildSpec` 的 spec 字面量 +1 行，`resolveShellPath` 依赖 +3 行；
     - `src/agent/piSession.ts`：`createRoleSession` 的参数 +1 行，import +1 行；
     - `src/shared/types/agent.ts`：`SpawnSessionSpec` 与 `parseSpawnSessionSpec` 的末尾；
     - `src/main/ipc/sessions.ts`：+3 行。
   - Task 14（approval-gate）如果也改 `piSession.ts` 传给 `createRoleSession` 的参数，或给 spec 加字段，冲突都在同一位置，取并集即可。
   - 如果 Task 14 也需要自定义 `settingsManager`，应在 `createSessionSettings` 里合并设置，不要另外 new 一个，否则 shellPath 会丢失。
6. **冒烟经验**：
   - 验证 shell 相关行为时，要从 PowerShell 启动 dev，见第 4 节。
   - 整机提交内存接近上限时，`pnpm dev` 会在 Vite 依赖预构建阶段崩溃。
