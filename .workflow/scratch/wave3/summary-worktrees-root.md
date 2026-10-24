# Summary · Task 16 worktrees-root（worktree 根目录可配置，默认放在仓库同级目录）

分支 `LAIJiangFeng/worktrees-root`。worktree 照旧建在 `f5c2e91`（Initial commit）上。开工时用 `git merge --ff-only main` 快进到 `17057c0`，在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`，然后 `pnpm install --frozen-lockfile`；冒烟前按惯例补装了 Electron 二进制（`node node_modules/electron/install.js`）。写总结时 `main` 仍是 `17057c0`，`git merge-tree --write-tree main HEAD` 退出码 0；与 Task 15 的分支 `LAIJiangFeng/provider-import` 一起模拟合并，`git merge-tree` 同样退出码 0。

相对 `17057c0` 有 9 个提交，另有本总结的 `docs(wave3)` 提交，每个都带 `Co-Authored-By: Claude Opus 5.5`。范围外改了几个文件，都是任务书要求的直接后果，理由见「未做 / 越界项」。没有 BLOCKED 项。

## 做了什么

| 提交 | 内容 |
|---|---|
| `80ae6d5` feat(shared) | `Preferences.worktreesRoot?`（只收绝对路径）；两个通道常量与结果类型；`parsePickWorktreesRootInput` / `parseWorktreesRootInfoInput` 严格收窄 |
| `c790f2a` feat(main) | 新建 `services/orchestration/worktreesRoot.ts`：根目录推导、默认位置的退回、校验、目录大小统计、设置页数据，22 个用例 |
| `f24a4cb` feat(main) | registry → service → host 改传 `resolveWorktreesRoot(workspace)`，host 在每次 `git.create` 前现算；registry 用例与真实 git 集成用例 |
| `e05ebc5` feat(main) | `ipc/orchestration.ts` 把 `preferences.worktreesRoot` 接进注册表（范围外，2 行） |
| `9df1b40` test(main) | `connectOrchestration.integration.test.ts` 的期望路径改成仓库同级（范围外，`f24a4cb` 的直接后果） |
| `7de00ec` feat(main) | `settings:pick-worktrees-root`、`settings:worktrees-root-info` 两个 handler 与测试 |
| `ccc7fbb` feat(preload) | settings 域加 `pickWorktreesRoot` / `worktreesRootInfo`（`preload/index.ts` 内联；类型在 `types.ts`） |
| `7f2ebed` feat(renderer) | 设置页「通用」、导航项、`useWorktreesRootStore` |
| `2e5f428` docs | ARCHITECTURE §9.5 与 orchestration README 回写（范围外，可单独丢弃） |

### 1. 根目录怎么定（`worktreesRoot.ts`，任务书第 1、2、4 条）

这里算出的是 `GitWorktreeManager.create` 的 `worktreesRoot`，worktree 本身在它下面的 `<workspaceId>/<slug>`（core 没改）。

- **默认**：`<仓库父目录>/<仓库目录名>-worktrees`。例如 `D:\project\fynvra` → `D:\project\fynvra-worktrees\<workspaceId>\<slug>`，与仓库同盘。
- **配置了 `preferences.worktreesRoot`**：`<worktreesRoot>/<仓库目录名>`，即 `<worktreesRoot>\<仓库目录名>\<workspaceId>\<slug>`。
- **退回 `userData/worktrees`（并记 warning）**：
  - 先 `mkdir -p` 默认目录，再写一个探测文件并删掉；任一步失败就退回。不用 `access(W_OK)`，因为它在 Windows 上不看 ACL。
  - 仓库在磁盘根目录上（没有同级目录）时也退回。
  - 默认位置落在另一个已挂入仓库的工作树里（嵌套仓库）时也退回。这一条比任务书多，理由见注意事项 4。
  - warning 形如 `[orchestration] worktrees of <repo> go to <userData>\worktrees: <原因>`。
- **配置了根目录时不探测、不退回**：选的时候已经校验过；之后用不了（比如移动硬盘拔了），就让 `git worktree add` 报错、`dispatch_task` 失败，不悄悄换地方。
- **手改 settings.json 写了相对路径**：`parsePreferences` 直接丢弃；resolver 再按 `isAbsolute` 查一次，不是绝对路径就按默认位置处理，并记 warning。
- **每次建 worktree 时现算**：registry 建一个 resolver，经 service 传给 host，host 在 `launch()` 里紧挨着 `git.create` 调用。
  - 所以运行中的同一个主 agent 会话，改设置后新派的任务就落到新目录。
  - 原来 host 拿的是字符串，而且按主 agent 会话缓存到退出。
- **已有 worktree 不迁移**：review / merge / cleanup 都用 store 里的 `Worktree.path`。registry 用例和真机冒烟都验证了第一个 worktree 原地不动。

### 2. 选目录时的校验（`validateWorktreesRoot`，第 2 条）

检查以下几项：

- 是绝对路径。
- 不是已挂入的仓库，也不在仓库里面。字面路径和真实路径各查一次，所以经 junction / 符号链接指进仓库的也会拒绝。
- 各仓库的 `<根目录>/<仓库目录名>` 不能落进仓库。例如选了仓库的父目录 `D:\project`，worktree 会建到 `D:\project\fynvra\…`，也就是仓库里面。
- 能创建、能写：同样是 `mkdir -p` 加探测文件。

前三项在创建任何目录之前检查，不会在仓库里建出目录。不合法时 IPC 返回 `{ ok: false, code: 'invalid', error }`（中文原因），不写入。

### 3. IPC（第 2、3 条）

- **`settings:pick-worktrees-root`**
  - 无参：Main 弹目录框。标题「选择 worktree 根目录」，起始目录是当前根目录或第一个仓库的父目录，`openDirectory` + `createDirectory`。
  - 选中后按弹框关闭时的工作区列表校验，然后写入 `preferences.worktreesRoot`，并广播 `settings:changed`。
  - `{ reset: true }`：删掉这个字段，恢复默认。
  - 取消返回 `code: 'canceled'`；非法入参（路径字符串、带 `path` 的对象、类型不符、`null`）返回 `code: 'invalid'`，不弹框。
  - 恢复默认没有另开通道，借鉴 `skills:add` 的「无参弹框 / 带参另一种动作」，通道数与任务书一致。
- **`settings:worktrees-root-info`**
  - 返回 `{ info: { isDefault, worktreesRoot?, fallbackRoot, workspaces: [{ workspaceId, name, root, fallback?, count, usage?: { bytes, missing } }] } }`。
  - `count` 来自 `getOrchestrationRegistry().serviceFor(id).snapshot().worktrees`，与编排面板同源。
  - 默认统计占用；`{ usage: false }` 只推导路径，很快。
  - 这个通道只读：打开设置页不会在用户的项目目录里建出 `-worktrees`，有测试断言这一点。
- **占用统计（异步、可取消）**
  - 每轮读 16 个目录、`lstat` 64 个文件；不跟随符号链接与 junction（pnpm 的 node_modules 里很多）。
  - 硬链接按 `(dev, ino)` 在同一工作区内只计一次（du 语义）；读不了的子目录跳过；目录已不存在的计入 `missing`。
  - 每轮之间检查 `AbortSignal`。新的统计请求会 abort 还在跑的那一次，旧请求返回 `{ ok: false, error: '占用统计已取消：有更新的统计请求' }`。
- `settings:update` 仍然拒绝 `worktreesRoot`（Renderer 不传路径），有测试。
- preload：settings 域还内联在 `preload/index.ts`，按任务书只在那里加两个方法；`SettingsApi` 类型在 `preload/types.ts`。

### 4. 设置页「通用」（第 3 条）

- 导航第一项，在「模型服务」之前，图标 `SlidersHorizontal`。打开设置时默认分组仍是「模型服务」。
- **Worktree 位置**
  - 默认时显示「默认：仓库同级目录」+「默认」徽标，说明 `<仓库目录名>-worktrees` 与退回目录。
  - 自定义时显示所选路径和 `<根目录>/<仓库目录名>/…` 的分组方式。
  - 按钮：「恢复默认」（默认状态下禁用）、「选择目录…」（Main 弹框）。操作结果用一行绿色 / 红色提示。
  - 说明文字写明「修改只影响之后新建的 worktree，已有的留在原处」。
- **磁盘占用**
  - 每个工作区一行：名称、「新建：<根目录>」、大小、worktree 数，以及已不存在的目录数。
  - 「重新统计」按钮；说明文字含任务书要求的「已合并任务的 worktree 会在 cleanup 后删除」。
- **两段加载**
  - `useWorktreesRootStore`（`stores/settings.ts`）先取路径（`{ usage: false }`），再统计占用，页面不用等几秒的扫描。
  - 路径和统计各自只认最新一次回包。统计结果只并入占用：统计期间改了目录，路径以最新一次读取为准。
  - 重新统计期间保留上次的数字。其他窗口改了设置，`settings:changed` 会触发重读。

### 5. 测试（第 5 条）

- `src/shared/types/settings.test.ts`（+15）
  - settings 解析：只保留绝对路径；相对路径、盘符相对路径、非字符串丢弃。
  - `settings:update` 拒绝 `worktreesRoot`。
  - 两个通道入参的收窄：路径字符串、多余字段、类型不符、原型污染键都拒绝。
- `src/main/services/orchestration/worktreesRoot.test.ts`（22，真实临时目录）
  - 默认 / 配置推导。
  - `isInsideDirectory`：前缀相同的兄弟目录、Windows 大小写、跨盘。
  - 嵌套仓库与仓库在根目录上时的退回。
  - 父目录不可写的退回，两种模拟：父路径是文件（ENOTDIR）、注入的 fs 写探测文件时报 EACCES。
  - 配置时不探测、每次调用重读设置、手写相对路径按默认处理。
  - 校验：合法目录、相对路径、仓库本身与内部、仓库父目录、junction 指进仓库、建不出来、写不进去。
  - 统计：递归累加、不跟随 junction、硬链接只计一次、AbortError、多 worktree 合计与 missing。
  - info 只读：默认目录不会被建出来。
- `registry.test.ts`
  - 仓库移到临时目录里（默认位置会被真的建出来）。
  - 新增：默认在仓库同级；同一会话两次派发之间改设置；父目录不可写时退回 userData 并记 warning。
- `orchestration.integration.test.ts`：新增真实 git 用例，worktree 建在 `<tmp>\repo-worktrees\ws_1\next-to-repo`，cleanup 按记录的路径删除。
- `src/main/ipc/settings.test.ts`（+11）
  - 两个通道的入参收窄：不弹框、不写入、不广播。
  - 取消；选中仓库内部目录被拒。
  - info 的默认位置、登记数、`{ usage: false }`；占用 8 字节加 1 个 missing。
  - 新统计取消旧统计（确定性：旧请求在等快照时被 abort）。
  - 选中合法目录后写入并广播、info 反映新路径；`{ reset: true }` 恢复默认。
- `src/preload/index.test.ts`：两个方法映射到通道，选目录不传参数。

## 怎么验证

根目录在最终提交 `2e5f428` 上按顺序执行 `pnpm typecheck && pnpm lint && pnpm test && pnpm build`：

```
pnpm typecheck  → exit 0
pnpm lint       → exit 0：Checked 305 files，No fixes applied（开工基线 302）
pnpm test       → exit 0：Test Files 95 passed (95)；Tests 1371 passed (1371)（开工基线 94 / 1320）
pnpm build      → exit 0：out/main/index.js 244.79 kB、out/main/chunks/index-<hash>.js 114.82 kB、out/preload/index.cjs 10.76 kB、renderer 构建通过；构建日志没有 warning
```

### 真机（`pnpm dev`）：改目录后新派任务的 worktree 出现在新目录

做法：

- 脚本放在仓库外的 `%TEMP%\fynvra-wtroot-smoke-KK0J3E\scripts\`（`smoke.mjs` / `drive.mjs` / `mock-anthropic.mjs`）。
- 临时 git 仓库 `<tmp>\project\demo`，经隔离的 `FYNVRA_USER_DATA_DIR` 挂成工作区 `ws-smoke`。
- 本机假的 Anthropic SSE 端点：主 agent 收到 `TASK:<标题>` 就调一次 `dispatch_task`；worker 只回一句话，不调工具。
- 启动：`pnpm exec electron-vite dev --remoteDebuggingPort 9461 --inspect 9462 -- <不节流开关>`。
- 渲染进程经 CDP 点设置页、调 `window.fynvra.*`。
- 原生目录框没法用 CDP 操作，所以经 Main 的 Node inspector 只把 `dialog.showOpenDialog` 换成直接返回 `<tmp>\custom-root`。校验、写入、广播、界面都是真实代码。

同一个主 agent 会话连续派了三个任务：

| 步骤 | 结果 |
|---|---|
| 1. 默认设置下派 `Smoke one` | `<tmp>\project\demo-worktrees\ws-smoke\smoke-one`，目录在磁盘上 |
| 2. 设置 → 通用 | 导航顺序「通用 / 模型服务 / 角色 / 技能 / MCP / 外观」；显示「默认：仓库同级目录」，demo 一行「新建：<tmp>\project\demo-worktrees」「1 个 worktree」 |
| 3. 点「选择目录…」 | Main 的目录框收到 `{ title: '选择 worktree 根目录', defaultPath: '<tmp>\project', properties: ['openDirectory','createDirectory'] }`；页面变成「自定义目录 <tmp>\custom-root」并提示「之后新建的 worktree 放在 … 下」；`settings.get()` 与磁盘上的 settings.json 都有 `worktreesRoot` |
| 4. 同一会话派 `Smoke two` | `<tmp>\custom-root\demo\ws-smoke\smoke-two`；`smoke-one` 仍在原处 |
| 5. 点「重新统计」 | `2 个 worktree`、`230 B`（每个 worktree 是 README 加 `.git` 文件）；info 里 `root` 为 `<tmp>\custom-root\demo` |
| 6. 点「恢复默认」 | `worktreesRoot` 从偏好里删掉，页面回到默认 |
| 7. 同一会话派 `Smoke three` | `<tmp>\project\demo-worktrees\ws-smoke\smoke-three` |

- 渲染进程与 Main 都没有错误；关窗后应用正常退出（`pnpm dev` exit 0）。
- 仓库的 `git worktree list` 列出这三个 worktree，各在上述路径。
- 截图看过，版式与其他设置页一致。
- 冒烟跑了两遍：第二遍在最终提交上，用全新的临时目录，结果相同。
- 临时仓库、worktree 与 userData 已删除，脚本、report.json 与截图留在上面的目录里。

没有在真机上验证的：

- 「仓库父目录不可写时退回」：本机造不出安全的不可写父目录，靠单测与 registry 用例覆盖。
- 原生目录框本身：被替换了。

## 未做 / 越界项

- **范围外修改**，都在独立或说明清楚的提交里：
  1. `src/main/services/orchestration/host.ts`（+ `host.test.ts` 一行）：依赖从 `worktreesRoot: string` 改为 `resolveWorktreesRoot(workspace)`。
     - host 按主 agent 会话缓存，只有在它建 worktree 时现算，才能做到「每次建 worktree 时现算」。
     - 考虑过不改 host、在 service 里继承 `GitWorktreeManager` 覆盖 `create` 换掉根目录，但那样 host 手里会留一个被忽略的 `worktreesRoot`，放弃了。
  2. `src/main/ipc/orchestration.ts`（+2 行）：注册表只在 `getOrchestrationRegistry()` 里创建，偏好读取函数只能在这里接上。写法同 `createShellPathResolver({ settings: getSettingsFile() })`。
  3. `src/main/services/agentHost/connectOrchestration.integration.test.ts`（+1 行注释、改 1 行期望路径）：它断言旧的默认位置 `userData/worktrees`。
  4. `src/preload/types.ts`：`SettingsApi` 类型在这里，不加签名 `index.ts` 过不了类型检查。
  5. `src/renderer/components/settings/settingsViewStore.ts`：`SETTINGS_SECTIONS` 加 `'general'`，否则导航项点不了（`isSettingsSection` 不认）。
  6. `docs/ARCHITECTURE.md` §9.5 与 `src/main/services/orchestration/README.md`：契约与持久化说明回写，单独一个提交，代码不依赖它。
  - `orchestration.integration.test.ts` 我按「service.ts（及测试）」理解为范围内：选项改名，新增一个真实 git 用例。
- **没做**：
  - 已有 worktree 的迁移（任务书第 4 条明确不做）。
  - 离开设置页时不会取消正在进行的统计。只有新的统计请求会取消它：Renderer 侧只有两个方法，统计一般几秒内结束。
- 用户全局说明里的知识库检索（`maestro spec` / `maestro wiki`）本机不可用：没有 `maestro` 命令，`~/.maestro/workflows/coding-philosophy.md` 也不存在，与前几张卡相同。

## 给验收人的注意事项

1. **默认位置变了，只影响新建的 worktree**。
   - 合并后新派的任务会建在仓库同级的 `<仓库目录名>-worktrees` 下，不再进 `%APPDATA%\fynvra\worktrees`。
   - 已经在 `%APPDATA%` 下的 worktree 留在原处，照常 review / merge / cleanup。它们计入「磁盘占用」的数量与大小，只有「新建：」那一栏显示新位置。
   - 想让旧的从 C 盘消失，清理掉对应任务即可。
2. **ipc 模块之间多了一个循环 import**：`ipc/settings.ts` 要编排快照，所以 import `./orchestration`；`ipc/orchestration.ts` 要读设置，所以 import `./settings`；它也经 `./workspaces` 间接 import 了 settings。
   - 双方只在 handler / getter 内部互相调用，模块加载时不调用，所以运行时安全。
   - 测试与 `pnpm build` 都通过，没有 warning。
   - 如果想消掉它，可以把占用统计的注册表经参数注入，但 `ipc/index.ts` 的「只加一行 registerXxxHandlers()」约定就要改。
3. **默认目录会被提前建出来**。
   - 第一次派发时 resolver 会 `mkdir -p <仓库>-worktrees`，并写一次探测文件 `.fynvra-probe-<uuid>` 随即删掉。
   - 如果随后 `git worktree add` 失败，会留下一个空的 `-worktrees` 目录。
4. **比任务书多做的两个检查**，不需要的话删掉对应分支即可：
   - 选了仓库父目录时拒绝：它在 `<根目录>/<仓库目录名>` 的布局下会把 worktree 建进仓库。
   - 默认位置落在另一个已挂入仓库里时退回 userData。
5. **占用是 du 语义**：硬链接在同一工作区内只计一次。pnpm 的 node_modules 是指向全局 store 的硬链接，删掉 worktree 实际能回收的空间可能比显示的少。
6. **与 Task 15 的合并**：两边共同改的文件只有 `src/shared/types/ipc.ts`，各在自己的段里；本卡的两个常量紧跟在 `SETTINGS_CHANGED` 后面（settings 常量在对象开头，没有 `// --- settings ---` 注释行）。`git merge-tree` 模拟两边合并无冲突。
7. **`f24a4cb` 单独存在时有一个测试失败**：`connectOrchestration.integration.test.ts` 还期望旧路径，下一个提交 `9df1b40` 修好。整枝 `--no-ff` 合并没有影响；要逐个 cherry-pick 的话两个一起拿。
8. **已有的小问题，没改**：`createSettingsStore` 的 `merge` 是 `{ ...current, ...parsePreferences(persisted) }`。磁盘上删掉的可选字段（`shellPath`、`worktreesRoot`）在 `useSettingsStore` 里会残留到下次启动。「通用」页不读它，用的是 Main 返回的 info，所以不受影响。
9. **新增测试的分布**：共 +51，即 shared 15、`worktreesRoot.test.ts` 22、registry 2、真实 git 集成 1、settings IPC 11。preload 用例是在原有用例里扩充的。
