# Summary · Task 26 general-settings（通用设置补齐：会话归档 / 删除、worktree 清理、时间线显示偏好）

分支 `LAIJiangFeng/general-settings`。worktree 建在 `f5c2e91`（Initial commit）上：开工时确认 HEAD 是 `main` 的祖先，`git merge --ff-only main` 快进到 `3777730`，在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`（没有产生改动），再 `pnpm install --frozen-lockfile`；冒烟前按惯例补装了 Electron 二进制（`node node_modules/electron/install.js`，本机缓存）。

写总结时 `main` 已前进到 `918a0e8`（只多了 Task 28 任务卡，纯文档），`git merge-tree --write-tree main HEAD` 退出码 0。

相对 `3777730` 有 16 个提交（33 个文件，+2836 / −134），另有本总结的 `docs(wave4)` 提交。每个提交都带 `Co-Authored-By: Claude Opus 5.5`，没有 push，没有建 PR。没有 BLOCKED 项。范围外改了两个文件，理由见「未做 / 越界项」。

## 做了什么

| 提交 | 内容 |
|---|---|
| `b9de768` feat(shared) | `Preferences` 加 `// --- sessions ---`、`// --- timeline ---` 两块；收窄与生效值；`SessionSummary.archivedAt?`；`sessions:archive` / `unarchive` / `sweep` 通道常量 |
| `e389581` feat(main) | `sessions.json` 收窄 `archivedAt`；状态变成 running 时注册表自动清掉归档 |
| `d9d46e9` feat(main) | `OrchestrationService.cleanupMergedWorktree`：只删已合并且干净的 worktree（新文件 `worktreeCleanup.ts`） |
| `3e77772` feat(main) | `archive.ts`（归档 / 恢复）与 `archiveSweeper.ts`（注入时钟的判定纯函数 + 定时扫描） |
| `26ceffe` feat(main) | sessions IPC：`list` 带 `includeArchived`、`archive`、`unarchive`、`sweep`；启动扫描器 |
| `3b81a8e` feat(preload) | sessions 域的四个方法；Renderer 内存 mock 跟上（范围外，类型需要） |
| `5940ea1` feat(renderer) | 会话 store：归档 / 恢复（乐观更新） |
| `5344bc4` feat(renderer) | 侧栏：底部可折叠的「已归档」分组，悬停按钮归档 / 恢复 |
| `947fa4b` refactor(shared) | 两个取生效值的函数只要自己那组字段 |
| `c001909` feat(renderer) | 设置「通用」追加「会话」「时间线」两组；`useGeneralPreferencesStore` |
| `1c5585c` feat(renderer) | `stores/sessions/timeline.ts`：消息 → 时间线的行（只读工具合并、历史轮次折叠、diff 视图） |
| `b39340e` feat(renderer) | Timeline / MessageItem / ToolCallCard / ThinkingBlock 按四个开关显示 |
| `771f775` fix(renderer) | 文件修改卡片按「这一轮还在跑」自动展开，而不是看工具自己的状态（见注意事项 6） |
| `a9aef81` test(main) | 归档清理的真实 git 集成用例 |
| `c07bbbf` docs | ARCHITECTURE §9.2 / §9.3 回写（范围外，可单独丢弃） |
| `efb1097` refactor(renderer) | 归档的会话放进单独的 `archivedByWorkspace`，`sessionsByWorkspace` 含义不变（见注意事项 2） |

### 1. 设置字段（`src/shared/types/settings.ts`）

| 字段 | 取值 | 默认 |
|---|---|---|
| `archiveIdleDays` | 0（关闭）/ 7 / 14 / 30 / 90 | 0 |
| `cleanupWorktreeOnArchive` | boolean | false |
| `deleteArchivedDays` | 0（永不）/ 30 / 90 | 0 |
| `compactReadonlyTools` | boolean | true |
| `autoExpandEdits` | boolean | true |
| `autoExpandThinking` | boolean | true |
| `foldHistoryTurns` | boolean | false |

- 字段在 `Preferences` 里都是可选的：`parsePreferences` 只保留合法值，没写过的不出现。读取时用 `sessionPreferencesOf` / `timelinePreferencesOf` 补默认值。这样原有的 `parsePreferences` / `parseSettings` 用例一条不用改，也不用动 `DEFAULT_PREFERENCES` 与 `createSettingsStore` 的 `partialize`。
- `settings:update`（`parsePreferencesPatch`）严格收：天数不在选项里、开关不是布尔，整个 patch 作废。
- 会话三项默认都不做事：都是改动用户数据的动作，由用户打开（EnsoCode 默认 30 天归档，这里没跟）。
- 时间线四项按任务书。

### 2. Main：归档、恢复、定时扫描

**注册表**（`sessionStore.ts`）
- `archivedAt` 随记录落盘，读不懂只丢时间、不丢会话。
- `update()` 遇到 `status: 'running'` 时一并清掉 `archivedAt`。这样用户在归档的会话里发消息，或主 agent 打回 / 发消息给归档的 worker，它都会回到会话列表。
- 这条规则放在注册表里，是因为 agent host 不在范围内，而它所有的状态更新都经过这里。

**归档 / 恢复**（`archive.ts`，IPC 与扫描共用）

归档：
- 只写 `archivedAt`，不改 `updatedAt`；运行中、等审批的会话拒绝。
- 广播 `sessions:changed`，并让会话退出 agent worker（释放 pi 会话与 MCP 连接，下次使用时按记录重建）。
- 「归档时清理 worktree」打开且会话绑定了 worktree 时，调 orchestration 的 `cleanupMergedWorktree`。
- 清理、退出 worker 失败都只记日志，不影响归档。

恢复：
- 清掉 `archivedAt`，并把 `updatedAt` 设为当前时间：闲置计时重新开始，否则下一次扫描马上又把它归档。
- 会话回到列表顶部。

**清理条件**（`worktreeCleanup.ts`，纯函数 `mergedCleanupBlocker`）

同时满足才删：
- 任务经 `merge_worktree` 合并过（`completed`）；
- `git status --porcelain` 干净；
- 相对基准分支当前位置 ahead 为 0（合并之后没有新提交）。

删的步骤与 `cleanup_worktree` 处理已合并任务相同（先停 worker → 删 worktree → 删记录 → 删分支），但更保守：
- `git worktree remove` 不加 `--force`：检查之后又有改动时 git 会拒绝。实测被忽略的 `node_modules` 不挡。
- 分支用 `-d`：git 再确认一次已合并。

**扫描**（`archiveSweeper.ts`）
- `planArchiveSweep(sessions, policy, now)` 是注入时钟的纯函数：
  - 闲置正好 N 天也算；
  - 删除按归档时间算，这一轮刚归档的不会同一轮删除；
  - 运行中、等审批的跳过；天数 0 为关闭 / 永不。
- 执行前按最新记录再判一次：计划之后开始运行、已被删除的跳过。
- 多次扫描排队执行，每次扫描现读设置。
- 启动后 30 秒扫第一次，之后每小时；`before-quit` 时停掉。
- 删除走 agent host 的 `remove`，与 `sessions:remove` 相同：pi jsonl 保留。

**IPC**（`ipc/sessions.ts`）
- `sessions:list`：
  - 传 workspaceId 时不列归档的会话（老调用方语义不变）；
  - 传 `{ workspaceId, includeArchived: true }` 时一并列出；
  - 严格收窄，多余字段、非布尔的 `includeArchived` 都拒绝。
- `sessions:archive` / `sessions:unarchive` 只收会话 id。
- `sessions:sweep` 无参，立即扫一次，返回 `{ archived, removed }`。设置页改了天数后调用它，不用等整点（见注意事项 5）。
- 会话注册表改成模块单例，agent host 与归档共用同一份。

### 3. Renderer

**会话 store**
- `loadSessions` 带 `includeArchived` 拉取，结果分进两份列表：
  - `sessionsByWorkspace`：不含归档的，含义与以前相同；
  - `archivedByWorkspace`：归档的，最近归档的在前。
- `findSession` 与换模型 / 换审批档位都看两份列表，打开归档的会话照样能用。
- `archiveSession` / `unarchiveSession`：
  - 乐观地把会话挪到另一份列表，回包后取 Main 的 `archivedAt` 与 `updatedAt`；
  - 失败时挪回、提示「归档失败：…」/「恢复失败：…」并重拉列表；
  - 运行中、等审批、消息在途时不归档。
- 选中的会话被 Main 的扫描归档后照常开着，只有被删除才取消选中。

**侧栏**（`SessionList.tsx`）
- 会话行照旧。归档的会话收在底部「已归档 N」分组里，默认收起，与会话行在同一个虚拟列表里。
- 每行右侧有悬停 / 聚焦时出现的图标按钮：普通行「归档」，归档行「恢复」。
- 运行中、等审批的行没有归档按钮。文字只在 `aria-label` / `title` 里。

**设置「通用」**（`GeneralSettings.tsx` + `stores/settings.ts` 的 `useGeneralPreferencesStore`）
- 在原来两组之后追加两组，一行一个控件，标签只写控件名，说明放在标签的悬停提示里：

| 组 | 控件 | 悬停提示 |
|---|---|---|
| 会话 | 归档闲置会话（关闭 / 7 天 / 14 天 / 30 天 / 90 天） | 超过天数没有更新的会话移入已归档 |
| 会话 | 归档时清理 worktree（开关） | 只删已合并且干净的 |
| 会话 | 删除归档会话（永不 / 30 天 / 90 天） | 归档超过天数后删除记录，pi 会话文件保留 |
| 时间线 | 精简只读工具 | read / grep / find / ls 单行显示，连续的合成一条 |
| 时间线 | 运行中展开文件改动 | edit / write 的 diff 与写入内容 |
| 时间线 | 思考时展开 | 思考结束后收起 |
| 时间线 | 折叠历史轮次 | 发送新消息后，之前的轮次折叠成一行 |

- `useGeneralPreferencesStore`：
  - 启动时与 `settings:changed` 时从 Main 读；
  - 改动只经 `settings:update` 写自己的字段（Main 按字段合并），不经 `useSettingsStore` 的整块落盘；
  - 界面先换上，保存失败时按 Main 重读并显示原因；
  - 改了归档或删除天数后调 `sessions:sweep`。

**时间线**（`stores/sessions/timeline.ts` 纯函数 + 四个组件）
- `buildTimelineRows`：
  - 轮次从每条 user 消息（含乐观回显）开始；
  - 只有工具调用、没有正文和思考的 assistant 消息并进上一行，所以跨工具往返的连续读取也能合成一组；
  - `reuseRows` 让内容没变的行沿用旧对象，流式时只重画变了的行。
- **精简只读工具**：
  - read / grep / find / ls 显示成无边框的单行（点开看输出）；
  - 连续多个合成一条「N 次读取」，摘要列出路径或模式，状态取最差的，点开看各行；
  - 关掉后每个调用一张卡片，与以前相同。
- **运行中展开文件改动**：
  - edit 卡片展开后显示「改动」：逐处替换的行级 diff，首尾相同的行作上下文，超过 400 行截断；
  - write 卡片展开后显示「内容」；参数读不懂时照常显示 JSON；
  - 开关打开时，最后一条提问之后、会话还在跑的那一轮里的 edit / write 卡片自动展开；
  - 之前轮次与历史里的照常折叠，展开后不自动收起，用户收起的不再弹开。
- **思考时展开**：流式思考中展开，开始出正文或结束时收起；手动点过以手动为准。
- **折叠历史轮次**：
  - 最后一轮之前的每轮折成一行「提问（一行）+ 时间」，时间格式为当天 `09:05`、其他日子 `10-24 23:59`、跨年带年份；
  - 点开后标题行变成展开态，整轮内容接在下面，手动展开的轮次在会话内记住；
  - 展开历史轮次时停止跟随输出，以免插入的行把视图拉到底；
  - 折叠打开时发送新消息会回到底部。

## 怎么验证

**基线**（`3777730`；写总结前在一个指向本 worktree `node_modules` 的临时 worktree 里测，测完即删）：lint 379 个文件，test 127 个文件 / 1852 个用例全过。

**验收命令**（最终提交 `efb1097`，根目录）：

```
pnpm typecheck  → exit 0（node / web / packages 三段）
pnpm lint       → exit 0：Checked 387 files … No fixes applied.
pnpm test       → exit 0：Test Files 131 passed (131)；Tests 1941 passed (1941)
pnpm build      → exit 0：out/main/index.js 349.45 kB、out/main/chunks/index-<hash>.js（worker）130.83 kB、
                  out/preload/index.cjs 13.97 kB、out/renderer/assets/index-<hash>.js 2,563.43 kB；
                  out/main/index.js 里 @earendil-works 出现 0 次
```

**用例变化**（+89 = 1941 − 1852）：

| 文件 | 变化 | 覆盖 |
|---|---|---|
| `shared/types/settings.test.ts` | +12 | 合法值保留、非法天数与非布尔丢弃、选项表、生效值的默认、`settings:update` 的接受与 7 种拒绝 |
| `sessions/sessionStore.test.ts` | +2 | `archivedAt` 收窄（读不懂只丢时间）；变成 running 时清掉归档，其他更新保留 |
| `sessions/archiveSweeper.test.ts`（新） | +13 | 正好 N 天 / 差 1 毫秒、0 天关闭、运行中与等审批跳过、删除按归档时间、同一轮不删、时钟回拨；执行前再判、单个失败只记日志、设置现读、并发排队、30 秒 / 每小时 / stop、异常后照常调度 |
| `sessions/archive.test.ts`（新） | +9 | 归档只写时间并广播、退出 worker；运行中拒绝；清理只对绑定 worktree 的会话且受开关控制；清理 / 退出失败不影响归档；恢复重置闲置计时 |
| `orchestration/worktreeCleanup.test.ts`（新） | +9 | `mergedCleanupBlocker`：6 种未合并状态、dirty、合并后又提交、基准前进不影响 |
| `orchestration/service.test.ts` | +4 | 假 git：已合并且干净才删（不加 `--force`、`-d`）、没合并不碰、合并后改动 / 新提交保留、git 拒绝时保留记录 |
| `orchestration.integration.test.ts` | +1 | 真实 git：带被忽略 `node_modules` 的已合并 worktree 删掉连同分支；没合并、合并后提交、未跟踪文件都保留 |
| `ipc/sessions.test.ts` | +12 | 新通道已注册、启动扫描与退出停止、`includeArchived` 过滤、归档 / 恢复只转发 id、`sweep` 回包与异常、8 种非法入参 |
| `preload/domains/sessions.test.ts` | 扩充 | 新方法映射到通道，`list` 不带选项时仍传字符串 |
| `stores/sessions/createSessionsStore.test.ts` | +8，改 3 | 两份列表与排序、被扫描归档后仍选中、归档会话换档位、乐观归档 / 失败回滚 / 忙时拒绝、恢复后回到顶部 / 失败提示 |
| `stores/sessions/timeline.test.ts`（新） | +19 | 只读调用合组（跨消息）、关掉时逐个、思考另起一行、无提问开场；历史折叠 / 手动展开 / 发送后折叠 / 一轮不折 / 开场不折；`reuseRows`；`fileChangeOf` 的四种参数形状与读不懂；`diffEdit`；`formatTurnTime`；`thinkingExpanded` |

**TDD 顺序**（如实说明）：
- 先写测试、跑红再实现的：settings 收窄、注册表、清理判定与服务方法、归档与扫描（模块不存在）、sessions IPC、会话 store 的归档。
- `timeline.ts` 的测试文件先写好，但没有单独跑红就写了实现，跑的时候直接全绿。为此做了变异验证，5 处各注入一个错误，每处都有用例变红，还原后 18 / 18 全绿：
  - 不合并只有工具的消息：2 例失败；
  - 最后一轮也折叠：5 例失败；
  - 不沿用旧行：2 例失败；
  - diff 不算尾部上下文：2 例失败；
  - 思考忽略手动：1 例失败。
- `formatTurnTime` 是后加的，先红后绿。

**渲染冒烟**（临时 `zz-smoke-*.test.tsx`，跑完即删，没有提交）：用 `react-dom/server` 渲染了「通用」页与一条 assistant 消息。
- 「通用」页：两组 7 行，标签带 `title`、`htmlFor` 关联到控件，开关有 `aria-label`。
- assistant 消息：流式思考展开；read / grep / ls 合成「3 次读取」并默认收起；运行中的 edit 展开为 `  a / - b / + B /   c`；结束的 write 折叠；单个 read 是单行。

**真机冒烟**（`pnpm dev` + CDP + 本地假 Anthropic SSE 端点）

环境：
- 隔离的 `FYNVRA_USER_DATA_DIR`；临时 git 仓库挂成工作区 `ws-smoke`。
- 预置两条 worker 会话：10 天前更新的「Old idle session」与 3 天前的「Recent session」。
- 开不节流开关：`--disable-backgrounding-occluded-windows` 等。

脚本：
- 位置：仓库外的 `%TEMP%\fynvra-t26\smoke\`（`setup.mjs` / `mock.mjs` / `drive.mjs` / `extra.mjs` / `peek.mjs`，最后一次的 `report.json` 也在那里）。
- 设置页的下拉与开关、侧栏按钮都经 CDP 鼠标事件或 `click()` 操作真实界面。
- 结果从 DOM、`window.fynvra.*`、`sessions.json`、`settings.json` 读，没有截图。

最终提交上 24 项全部 PASS，渲染进程 0 条 error / warning：

| 场景 | 结果 |
|---|---|
| 归档闲置会话默认「关闭」；选「7 天」 | 10 天前的会话进入「已归档 1」（默认收起），3 天前的留在列表；`sessions.json` 里它有 `archivedAt`、`updatedAt` 没变；`settings.json` 有 `archiveIdleDays: 7` |
| 展开已归档，点「恢复」 | 回到列表顶部，分组消失；再 `sweep` 返回 `archived: 0`（闲置计时已重置） |
| 悬停按钮「归档」 | 进入已归档；`sessions:list` 默认不含它，`includeArchived` 时带 `archivedAt` |
| 精简只读工具 | 开：两次 read 合成「2 次读取 a.txt · b.txt」，默认收起；关：两张带边框的卡片；再开立即合回 |
| 思考时展开 | 开：流式思考中展开并能看到内容，结束后收起；关：流式中也折叠 |
| 运行中展开文件改动 | 开：这一轮的 write 卡片自动展开，显示「内容 line1 line2 line3」；关：edit 卡片折叠，手动展开显示 `- line1 / + LINE1` |
| 折叠历史轮次 | 默认关没有标题行；开：前 4 轮各一行「提问 + 16:48」，最后一轮展开；点开第一轮整轮内容接在下面；再发一条后刚才那轮也折起来，手动展开的保持展开；关掉标题行消失 |

另外两项单独验证：
- **定时扫描**：同一 userData 重启前，把一条会话的 `updatedAt` 改成 10 天前、另一条的 `archivedAt` 改成 40 天前，并设 `deleteArchivedDays: 30`。应用就绪后第 30 秒，前者被归档、后者从 `sessions.json` 删除。侧栏显示 1 个会话加「已归档 1」。
- **归档的会话再次运行**：在已归档分组里打开会话并发消息，回复到达后它回到会话列表顶部，已归档分组消失。

冒烟中发现并修掉的问题：第一轮 write 卡片没有自动展开，因为 edit / write 几毫秒就结束，卡片挂载时已经结束了，修复见 `771f775` 与注意事项 6。验证修复时给假端点加了 1.2 秒「模型往返」延迟；不加的话，工具开始、结束、第二次回复和收尾会落进 Renderer 的同一批事件，真实模型不会这样。

**提交前扫描**：33 个改动文件没有不可见字符（BOM / 零宽 / U+2028 / U+2029 / NBSP），`git ls-files --eol` 全是 `i/lf w/lf`。

## 未做 / 越界项

**范围外修改**：
1. `src/renderer/lib/api/sessions.ts`（内存 mock，`3b81a8e`）：`SessionsApi` 加了方法，mock 不实现就过不了类型检查。行为与 Main 对齐：归档不改最后更新，恢复改；运行时清掉归档；`sweep` 是空操作，因为 mock 会话活不过一次刷新。
2. `docs/ARCHITECTURE.md`（`c07bbbf`）：文档要求改契约先改本文，所以把 §9.2 的 `archivedAt`、§9.3 的新方法与通道、归档语义写了回去。单独一个提交，代码不依赖它，可以丢弃。
3. 任务书没列、但属于本卡领域的新增：`sessions:sweep` 通道（理由见注意事项 5）、`OrchestrationService.cleanupMergedWorktree`（任务书说「走 orchestration 的 cleanup」，现有 cleanup 只在主 agent 的 Host 上，按 dispatch 与 run 校验，归档时没有主 agent，所以在服务上加了这个方法）。

**没做**：
- 右键菜单：任务书写「右键或悬停按钮」，只做了悬停 / 聚焦按钮。
- 「删除归档会话」的手动按钮：只按天数自动删除。
- 搜索 / 过滤已归档。
- 精简模式不把只读的 bash 命令（如 `ls`、`cat`）算作读取：EnsoCode 会，任务书只列了 read / grep / find / ls。
- edit 的 diff 只用参数里的 oldText / newText，没有读文件补上下文行：pi 的 `details.diff` 不在 `ChatToolCall` 里。
- 「自动折叠历史轮次」的手动展开状态只在当前会话视图里记住，切会话就重置：Timeline 按会话重新挂载。
- 用户全局说明里的知识库检索（`maestro spec` / `maestro wiki`）本机不可用：没有 `maestro` 命令，`~/.maestro` 也不存在，与前几张卡相同。

## 给验收人的注意事项

1. **与并行卡的合并**（`git merge-tree` 模拟；它们的分支还在变，以合并时为准）：
   - `shared/types/settings.ts` 与 Task 24 / 25 都能干净合并。我的两块字段放在 `sidePanelOpen` 之后，patch 的 case 放在 switch 开头，避开了大家都会追加的末尾。
   - `renderer/stores/settings.ts`：三张卡都在文件末尾追加了自己的 store 块，各有自己的 `onChanged`，取并集。
   - `components/chat/SessionList.tsx` 与 Task 25（keybindings）有一个冲突块：空态和 Virtuoso 那段。解法：
     - 保留本卡的 `{rows.length > 0 && scrollParent && (<Virtuoso data={rows} …/>)}`；
     - 空态改成 Task 25 的写法：`{sessions.length === 0 && (<p>{all.length === 0 ? '暂无会话' : '没有匹配的会话'}</p>)}`；
     - 删掉冲突块后面多出来的那一行 `)}`；
     - 其余部分（搜索按钮、搜索框、`const all` / `useFilteredSessions`）git 自动合并。
     - `rows` 由 `sessions`（已是过滤后的）生成，搜索只过滤会话、不过滤已归档；要一起过滤，给 `archived` 也套一层 `useFilteredSessions`。
   - Task 28（non-git-workspace）与 `main`：无冲突。
2. **`sessionsByWorkspace` 的含义没变**：它仍是侧栏的会话（不含归档的），归档的在 `archivedByWorkspace`。
   - Task 25 的「上一个 / 下一个会话」和会话搜索直接读 `sessionsByWorkspace`，合并后不会走到归档的会话里。
   - 最初的实现把两类混在一个列表里、靠选择器拆分，模拟合并时发现了这个隐患，于是在 `efb1097` 改掉。
3. **默认值**：会话三项默认都不做事（不归档、不清理、永不删除）。时间线前三项默认开，所以合并后用户会直接看到三处显示变化：
   - 只读工具变成单行或「N 次读取」；
   - 流式思考时思考块展开（以前一直折叠）；
   - 正在跑的那一轮里 edit / write 卡片展开。
   - 「折叠历史轮次」默认关。
4. **「再次运行即取消归档」写在注册表的 `update()` 里**：agent host 不在范围内，而它的状态更新都经过注册表。好处是用户发消息和主 agent 打回 / 发消息给 worker 一并覆盖；代价是这条领域规则放在持久层，已在注释和测试里写明。
5. **为什么多一个 `sessions:sweep`**：
   - 验收要「把归档天数设为 7 后能看到旧会话进入已归档」，只靠「启动后 30 秒、之后每小时」要等最多一小时。
   - 设置走的 `settings:update` 在 `ipc/settings.ts`，那是 Task 24 的范围，这张卡不能挂钩子，所以由设置页在保存成功后调一次 `sessions:sweep`。
   - 手改 `settings.json` 的话，要等下一次整点或重启。
6. **「运行中展开文件改动」按「这一轮还在跑」判断**：
   - pi 的 edit / write 只要几毫秒，`tool_start` 与 `tool_end` 往往落进 Renderer 同一批（16 ms）事件，卡片挂载时已经结束，按工具自己的状态判断几乎不会展开。
   - 现在的规则：最后一条提问之后的行、会话忙时，edit / write 卡片挂载即展开。这与 EnsoCode 的「while the agent is still running」一致。
   - 历史里的、之前轮次的不展开。
7. **恢复会把会话顶到列表最上面**：因为 `updatedAt` 被设为当前时间，这是为了让闲置计时重新开始。只想看一眼归档的会话，直接在分组里点开即可，不用恢复。
8. **归档会让会话退出 worker**：释放 pi 会话与 MCP 连接。之后再发消息会按记录重建，会话历史来自 pi jsonl，不受影响。
9. **清理只认 fynvra 自己的合并**：任务必须经 `merge_worktree` 变成 `completed`。用户在外面手动合并的分支（任务停在 in-review）不会被清理，worktree 留着，由主 agent 的 `cleanup_worktree` 或手动处理。worker 会话不论 worktree 状态都会被归档，没合并的 worktree 只是不删。
10. **冒烟脚本可复用**：`%TEMP%\fynvra-t26\smoke\` 的假端点支持四种标记：`SMOKE-READS: a b`（两次 read）、`SMOKE-WRITE: <path>`、`SMOKE-EDIT: <path>`、`SMOKE-THINK`（约 3 秒的流式思考），每次回复前等 1.2 秒。
