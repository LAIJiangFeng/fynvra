# Summary · Task 09 orchestration-ui（编排面板：任务看板、worker 实时输出、diff 查看）

分支 `LAIJiangFeng/orchestration-ui`。worktree 建在 `f5c2e91`（Initial commit）上，开工前 `git merge --ff-only main`
快进到 `main@9b5be7b`，并在干净状态下执行了 `git rm -r --cached -q . && git reset --hard -q`（没有产生改动），然后
`pnpm install --frozen-lockfile`。相对 `main` 共 10 个代码提交 + 本总结提交，全部带 `Co-Authored-By: Claude Opus 5.5`；
未 push、未建 PR；`main` 期间没有前进。没有 BLOCKED 项。

**先说结论**：typecheck / test / build 全绿；`pnpm lint` 不绿，但 2 个错误在 `main@9b5be7b` 基线上就有，位于本卡禁改的
`src/main/ipc/index.ts`、`src/preload/index.ts`（合并后 import 顺序没排），本分支改动的 19 个文件 lint 0 问题。修法见注意事项 1。

## 做了什么

| 文件 | 内容 |
|---|---|
| `src/renderer/lib/api/orchestration.ts` | `OrchestrationApi`（§9.4 原文，经 Biome 格式化）+ `getOrchestrationApi()` + 内存 mock + 开发模式演示开关。约 1000 行里大半是演示数据（脚本化的 worker 输出、生成的假 diff） |
| `src/renderer/stores/orchestration.ts` | `createOrchestrationStore(api)` 工厂 + 应用内实例 `useOrchestrationStore`；快照归并、派生选择器、输出分页轮询、diff 缓存 |
| `src/renderer/components/orchestration/diff.ts` | `parseUnifiedDiff`：diff 文本 → 按文件的 hunks（纯函数） |
| `…/orchestration/format.ts` | 状态文案 / 配色 / 分组顺序、消息摘要、时间格式、输出行分类（纯函数） |
| `…/orchestration/OrchestrationPanel.tsx` | 面板根：选中工作区 → 「任务」「改动」两个 tab、刷新、抽屉、开发模式演示开关 |
| `…/orchestration/TasksView.tsx` | Run 目标一行 + 完成进度（多个 Run 时可切换）+ 按状态分组可折叠的任务卡片 |
| `…/orchestration/TaskDrawer.tsx` | 详情抽屉：任务书（折叠）、依赖、Dispatch 时间线、消息流、worker 输出 |
| `…/orchestration/MessageStream.tsx` | 消息气泡：worker 靠左、主 agent 靠右；question / reply / instruction / worker_done / escalation 各自配色与图标 |
| `…/orchestration/WorkerOutput.tsx` | 等宽输出：自动滚底、可暂停、按 Transcript 标记着色、出错重试 |
| `…/orchestration/ChangesView.tsx` | 「改动」tab：选尝试 → reviewDiff → 文件列表 + stat + 按文件折叠的 diff（增删行着色、懒渲染） |
| `…/orchestration/common.tsx`、`hooks.ts` | 空态、状态 / 角色徽标；`useNow`、`useSeenOnce`（IntersectionObserver） |
| `src/renderer/components/ui/collapsible.tsx`、`progress.tsx` | Base UI 封装（任务书允许新增的两个；tabs / badge 已由 settings-ui 建好，直接复用） |
| `src/renderer/components/layout/SidePanel.tsx` | 占位换成 `<OrchestrationPanel />`；默认宽 360px，左边缘可拖动调宽 |

`src/shared/types/orchestration.ts` 已由 Task 06 按 §9.4 建好，本卡没有动。没有新增依赖，`package.json` / `pnpm-lock.yaml` 未改。

### 数据层

- **`getOrchestrationApi()`**：返回 `window.fynvra.orchestration`；不存在（node 测试、纯浏览器预览）或本窗口打开了演示开关时，返回同一个内存 mock。
  - 经 `globalThis` 读桥（Renderer 里就是 `window`），这样 node 下的测试能 import 本文件；没有 `declare global`。
  - 读出来的 preload 类型直接赋给 §9.4 的 `OrchestrationApi`，两边签名不一致时 typecheck 会报错。
- **mock**：1 个 Run、3 个 Task。进度按 mock 创建后经过的时间计算，到点用 `onChanged` 推送：
  - completed：worktree 已清理，reviewDiff 返回与 Main 相同的 `already cleaned up` 错误；
  - in-progress：输出约 60 秒内逐段出现；12s 向主 agent 提问、18s 收到答复、62s 结算为 in-review 并投 `worker_done`；
  - in-review：两次尝试（第一次被打回，带 `review feedback` 指示），假 diff 含 600 行新文件、改名、删除、二进制文件。
  - 每次 readWorkerOutput 最多返回 2 KB，cursor 分页真的会发生。假 diff 首次用到时才生成。
- **store**（Zustand，组件按字段订阅）：
  - **快照**：按 workspace 缓存。进入视图时 `watchWorkspace` 拉一次，之后 `orchestration:changed` 推到被观察的工作区时重拉；请求进行中又来变化，只在结束后再拉一次（不叠请求）。失败时保留上一份快照，只记错误。
  - **归并**：新快照里内容没变的记录和集合沿用旧引用，整份没变时返回旧快照本身。
  - **选择器**（按集合引用缓存，同一份快照反复调用拿到同一个对象）：
    - `tasksByStatus(view, runId)`、`dispatchesOf`、`messagesOf(dispatchId)`、`latestMessageOfTask`、`reviewCandidatesOf`、`runsOf`；
    - `activeDispatchOf(view, taskId)` 取 core `OrchestrationStore.activeDispatch` 的语义（未结算的那次，都结算了就是 undefined）；
    - 面板上「当前尝试」用 `latestDispatchOf`（进行中的那次，否则最近一次，与 Main 宿主的 `latestDispatch` 同义）。
  - **worker 输出**：按 dispatch 分页缓存。
    - cursor 按返回文本的长度递进；`cursor < total` 说明这页被 Host 截断，立即接着读；
    - 读到末尾而 worker 未结束时每 1.5s 轮询；`done` 且读完、出错（等 `retryOutput`）、最后一个观察者离开（立即清掉挂起的定时器）时停止；
    - 只在详情抽屉打开时轮询（`watchOutput` 引用计数），重新打开时从缓存的 cursor 续读；
    - `total < cursor`（Main 重启后从 jsonl 重建了投影）时从 0 重读；
    - 快照变化时把已结束的输出再读一次：`send_to_worker` 之后 worker 可能在同一次尝试里继续产出；
    - 最多保留最近 100 万字符，小页合并到 8 KB，页数随输出长度而不是轮询次数增长。
  - **diff**：按 dispatch 缓存，`force` 重新读取时保留旧内容并标记 refreshing，同一 dispatch 同时只有一个请求。

### 界面

- **「任务」tab**：
  - 顶部是 Run 目标（一行，悬停看全文）、创建时间、完成进度条。
  - 任务按 待开始 / 进行中 / 待验收 / 已完成 / 失败 分组，可折叠。`abandoned` 不在任务书的五组里，我加了第六组「已放弃」，默认收起，免得被放弃的任务凭空消失。
  - 卡片显示：标题、角色徽标（角色名取自 roles store，找不到就显示 id）、状态色左边框、分支名、运行计时、第 N 次尝试、依赖（未完成的标黄）、最近一条消息摘要和相对时间。
- **详情抽屉**：盖在面板上的非模态 `role="dialog"`。抽屉后面的内容设为 `inert`；Esc 或「返回」关闭，焦点回到原卡片。
  - 任务书默认折叠，展开后标题行加粗，空行收成小间距（没有引入 Markdown 库）。
  - 依赖可以点过去看。
  - 尝试时间线：开始 / 结束 / 用时 / 结果 / 总结 / 改动文件，运行中的尝试每秒刷新已运行时长，被取代的尝试半透明。
  - 消息流合并所有尝试，按时间排序，尝试之间有分隔；没有答复的提问标「等待答复」。
  - worker 输出：等宽、自动滚底；向上滚动或点「暂停」后停止跟随。暂停时画面冻结（后台照常拉取，显示「新增 N 字符」），继续后一次补齐。`[tool]` / `[tool error]` / `[settled]` 等标记行着色，跨页的半行沿用上一行的颜色。
  - 待验收 / 已完成的任务有「查看改动」，直接跳到「改动」tab 并选中这次尝试。
- **「改动」tab**：
  - 下拉里列出当前 Run 中待验收 / 已完成任务的当前尝试。
  - 上方显示分支、基准提交、`--stat` 汇总，原始 `git diff --stat` 可以折叠展开。
  - 文件列表带 A/M/D/R 和 +/−，点击后展开该文件并滚动过去。
  - 每个文件一个折叠区，增删行着色，旧 / 新双行号，hunk 头单独着色；二进制、仅改名、仅改模式的文件各有说明。
  - **超长 diff 分文件懒渲染**：
    - 单个文件超过 400 行，或累计超过 1500 行的文件默认收起；
    - 展开的文件接近视口时才渲染行；
    - 长文件每次多显示 400 行。
  - worktree 已清理时不再请求，说明原因；之前读到过的 diff 照常显示，并加一句提示。
- **只读**：面板里没有合并 / 打回按钮。
- **空态**：工作区没有 Run 时，两个 tab 都显示「主 agent 还没有派发任务」和一句说明；没选工作区时显示「选择一个工作区查看编排」。
- **暗色**：所有自定义颜色都带 `dark:` 变体或使用主题变量，暗色下实测正常（见验证部分）。
- **右栏宽度**：
  - 原来固定 288px，放 diff 和输出太窄。现在默认 360px，左边缘是可聚焦的分隔条：拖动或方向键调宽，最多占窗口 60%；双击恢复默认。
  - 宽度只在本次运行内记住：settings 不在本卡范围。
  - 右栏 `<aside>` 加了 `aria-label="编排面板"`，与左侧栏的 `<aside>` 区分开。

## 怎么验证

### 检查命令（最后一个代码提交之后，仓库根目录）

```
pnpm typecheck && pnpm lint && pnpm test && pnpm build   → EXIT=1（停在 lint）
pnpm typecheck  → EXIT=0（node / web / packages 都没有输出）
pnpm lint       → EXIT=1：Checked 256 files … Found 2 errors.
                   src\main\ipc\index.ts:1:1  assist/source/organizeImports
                   src\preload\index.ts:1:1   assist/source/organizeImports
                   （开工时在 main@9b5be7b 上跑的基线结果完全相同；两个文件都在本卡禁改范围内）
pnpm biome check <本分支改动的 19 个文件>  → Checked 19 files … No fixes applied.（0 错误 0 警告）
pnpm test       → EXIT=0：Test Files 81 passed (81) · Tests 1028 passed (1028)，没有 skipped
                   （基线 77 / 970，本卡新增 4 个文件 58 个用例）
pnpm build      → EXIT=0：out/renderer/assets/index-*.js 1,601 kB、*.css 58.8 kB
```

生产包里搜不到「使用演示数据」：开发模式的演示开关被摇树掉了。

### 新增测试（58 个）

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `components/orchestration/diff.test.ts` | 20 | 按文件切分与顺序、增删计数、行号、`---` 开头的删除行不当文件头、改名、二进制、仅模式变化、路径含空格时 git 追加的 tab、C 风格引号与 UTF-8 八进制转义、多 hunk、空上下文行、CRLF、省略的 hunk 行数、`diffLineCount`、`statSummary` |
| `stores/orchestration.test.ts` | 21 | 快照归并（引用沿用 / 替换 / 删除）、各选择器、watch 后 changed 重拉 / 未观察的不拉 / 退订后不拉、请求合并、失败保留旧快照；输出分页的 cursor 递进、截断页立即续读、1.5s 轮询、settle 后停止且没有残留定时器、未读完不算 done、观察者引用计数与续读、出错停止与重试、输出变短从 0 重读、快照变化后复查已结束的输出、保留上限；diff 缓存 / 强制刷新 / 出错重试 |
| `lib/api/orchestration.test.ts` | 9 | 桥存在时用桥、不存在时用共享 mock、演示开关优先；mock 的初始快照、分页连续、按时间流式输出并结算、diff 能被解析且 files / stat 与 patch 一致、清理与未知 dispatch 的错误、到点推送 changed 且退订后不留定时器 |
| `components/orchestration/format.test.ts` | 8 | 时长 / 相对时间 / 时钟格式、worker_done 结果与追加汇报、消息摘要、发送方判断、输出行分类 |

TDD 说明：
- **先写测试、跑出红再实现**：
  - `diff.ts`：红在找不到模块；
  - store：红在找不到模块；
  - `reviewCandidatesOf`：红在 `is not a function`。
- **先实现、再补测试**：mock 与 `format.ts`。
- **变异检查**：对 store 做了 4 个变异，分别是 done 后仍排轮询、cursor 直接取 total、不合并进行中的请求、退订不清定时器。
  - 起初有 2 个没被抓到：pump 里的第二道守卫兜住了行为，但定时器会残留。
  - 补了「结束 / 退订后立即没有挂起定时器」的断言，4 个变异都会失败；源码已还原。

### 运行时冒烟

驱动脚本放在仓库外的临时目录，使用临时 `FYNVRA_USER_DATA_DIR`，预置了一个指向临时 git 仓库的工作区。经 CDP 发送真实鼠标 / 键盘事件，结论来自 DOM。另外截了几张图，只给自己检查观感，已删除。跑完后应用都经自己的 IPC 关窗退出，exit 0。

环境插曲：

1. 第一次 `pnpm dev` 时，Vite 的 Rolldown 报 `memory allocation of 7096704 bytes failed` 崩溃。当时整机提交费用 55.4/56.6 GB，另有 58 个 node、14 个 electron 进程，是别的 worktree 和用户自己的，我没动。
2. 改用 `pnpm build` 产物跑 `electron .`。此时窗口在后台被遮挡（`visibilityState: hidden`），Chromium 不跑 rAF / IntersectionObserver，懒渲染断言因此失败。
3. 加上 Chromium 开关 `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding` 重启后，一切正常。
4. 后来内存余量回升，`pnpm dev` 也成功启动了，开发模式开关在真实 dev 进程里验证过。

结果（所有轮次控制台 0 条 error / warning / 异常）：

- **真实 IPC（不开演示）6/6**：
  - preload 暴露了 `window.fynvra.orchestration`；
  - 没选工作区时显示提示；
  - 选中后真实的 `orchestration:snapshot` 返回 `{ ok: true, runs: [], … }`，两个 tab 都显示「主 agent 还没有派发任务」。
- **演示数据，构建产物 50/50**：
  - 看板：演示徽标、Run 目标、`已完成 1 / 3`、分组顺序与折叠、3 张卡片、分支 / 依赖 / 最近消息；
  - 抽屉：打开后背景 inert；输出持续增长（如 857 → 965）并贴底；标记行着色；暂停冻结（965 → 965，显示「已暂停 · 新增 154 字符」）、继续后补齐；任务书展开；
  - 消息：提问出现后带「等待答复」，答复经 onChanged 到达后徽标消失，worker 靠左、主 agent 靠右；
  - 关闭：Esc 关闭抽屉、焦点回到卡片；
  - 两次尝试：取代标记、指示气泡、尝试分隔；
  - 改动：「查看改动」跳转并选中；分支 / 基准提交 / stat；6 个文件，增删行着色；600 行文件默认收起，点开后懒渲染、401 → 603 行分段；改名 / 二进制说明；切到已完成任务时显示「worktree 已清理」；
  - 其他：暗色截图；拖动分隔条 360 → 510；约 62 秒后 mock 推送 changed，任务自动移到「待验收」（`待验收 2 | 已完成 1`），输出以 `[settled]` 结束，出现完成汇报气泡。
- **`pnpm dev` 7/7**：
  - 没选工作区时就能看到演示开关，默认走真实桥；
  - 真实鼠标点开关后写入 sessionStorage 并重新加载，进入演示数据；
  - 输出滚动、diff 着色正常；
  - 再点一次回到真实桥，标记被清除。
- **截图修正**：截图里发现两处排版问题，修完后复查 1/1：
  - 「相对 <sha>」被挤成竖排；
  - 文件头路径按字符断行，现在只在 `/` 后换行。

## 未做 / 越界项

- **范围外的文件**：
  - `src/renderer/lib/api/orchestration.test.ts`、`src/renderer/stores/orchestration.test.ts`：任务书「测试」一节要求测 store 与假 API，按仓库惯例和源码放在同一目录；
  - orchestration-host 卡也这样处理过。其余文件都在「范围」清单内（`git diff --name-only main...HEAD` 已核对）。
- **lint 基线错误没有修**：两个文件在禁改范围内，见注意事项 1。
- **没有组件级测试**：仓库没有 jsdom / RTL（app-shell 注意事项 4），组件靠上面的运行时冒烟验证。
- **没有展示没有 `dispatchId` 的 Run 级消息**：例如 Main 在排队任务被放弃时发给主 agent 的 escalation。被放弃的任务在看板上只显示「已放弃」，原因要看主 agent 会话。
- **任务书没有完整渲染 Markdown**：只把标题加粗。chat-ui 引入 react-markdown 后，可以换成它的 Markdown 组件。
- **右栏宽度不持久化**：settings 不在本卡范围。
- **用户全局说明里的知识库检索没有做**：本机没有 `maestro` 命令，也没有 `~/.maestro`，与 settings-ui 卡的记录一致。

## 给验收人的注意事项

1. **`pnpm lint` 的基线失败**：
   - `main@9b5be7b` 上 `src/main/ipc/index.ts`、`src/preload/index.ts` 的 import 没排序，是三张 Wave 2 卡合并时取并集留下的。
   - 两个文件都在本卡（以及 Task 08、Task 11）的禁改范围内，所以合并时需要验收人顺手修。
   - 修法是 `pnpm biome check --write src/main/ipc/index.ts src/preload/index.ts`，只调整 import 行的顺序，修完 `pnpm lint` 即为 0 错误。
2. **「pnpm dev（mock 模式）」怎么进**：
   - Task 06 合并后 preload 总是带着 orchestration，`getOrchestrationApi()` 在 dev 下默认走真实桥（真实快照为空，就是空态）。
   - 要看演示数据：在 `pnpm dev` 里点面板右上角的烧瓶图标（「使用演示数据」）。没选工作区时也有这个按钮。
   - 它在 sessionStorage 写 `fynvra.orchestration.demo=1` 并重新加载，只对当前窗口有效，关窗即失效；再点一次退出。
   - 演示进度从页面加载算起，约 60 秒内能看到流式输出、提问 / 答复，最后自动移到「待验收」；重新加载会从头再来。
   - 生产构建里没有这个按钮。
3. **`components/ui/collapsible.tsx` 可能与 Task 08 冲突**：chat-ui 的范围里也有它，如果两边都新建了，会是 add/add 冲突。
   - API 是 shadcn 惯用的 `Collapsible` / `CollapsibleTrigger` / `CollapsibleContent`；
   - 本卡依赖「收起时卸载内容」（Base UI 默认）来懒渲染大 diff，取哪一份都行，只要 `CollapsibleContent` 没有强制 `keepMounted`。
4. **`activeDispatchOf` 的语义**：
   - 任务书点名的 `activeDispatchOf(taskId)` 我按 core 的 `activeDispatch` 实现，只取未结算的那次；
   - 卡片和抽屉里的「当前尝试」用另加的 `latestDispatchOf`。如果你期望 `activeDispatchOf` 在全部结算后也返回最近一次，改一行即可。
5. **worktree 清理之后**：`cleanup_worktree` 之后 reviewDiff 读不到改动，与 orchestration-host 注意事项 7 一致，面板会说明原因。如果以后要看已合并任务的 diff，需要先在 §4 的 Dispatch 里加 `mergeCommit` 之类的字段（改契约）。
6. **对接 Task 11（Main 接线）时**：接线前 readWorkerOutput 返回「未接线」错误，抽屉里会显示错误和「重试」按钮，不会无限轮询。接线后不需要改 Renderer。
7. **`lib/api/orchestration.ts` 体积**：约 1000 行，大半是演示数据。任务书要求 mock 放在这个文件里，所以没有拆出去。生产包也会带上这部分文本（几十 KB 的字符串），假 diff 只在首次使用时生成。
