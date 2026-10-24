# Summary · Task 08 chat-ui（会话列表、聊天时间线、流式渲染、工具卡片、审批条）

分支 `LAIJiangFeng/chat-ui`。worktree 照旧建在 `f5c2e91`（Initial commit）上。开工时确认 HEAD 是 `main` 的祖先，用 `git merge --ff-only main` 快进到 `aaec62e`，再在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`（`w/crlf` 为 0）。

读文档期间 `main` 又合并了 agent-host 和 settings-ui（`0b3d8fd`）。当时本分支还没有任何提交，于是再快进一次到 `0b3d8fd`，并再刷新一次行尾。`main` 本身没动。写总结时 `main` 已前进到 `9b5be7b`（只新增了 Task 11 任务卡，纯文档）。`git merge-tree --write-tree main HEAD` 退出码为 0，合并无冲突。

相对 `0b3d8fd` 有 8 个改动提交，涉及 34 个文件（+5378 / −21），全部在任务书「范围」内；另有本总结的 `docs(wave2)` 提交。每个提交都带 `Co-Authored-By: Claude Opus 5.5`。没有 BLOCKED 项。

## 做了什么

| 提交 | 内容 |
|---|---|
| `ec0c9e3` build(renderer) | devDependencies 加 `react-markdown@^10.1.0`、`remark-gfm@^4.0.1`、`shiki@^4.5.0`、`react-virtuoso@^4.18.19`；根目录 `pnpm install`，锁文件 +1026 行（只增不删） |
| `879ca73` feat(renderer) | `stores/sessions/reducer.ts`：纯函数 reducer 与配套的状态迁移函数，25 个用例 |
| `b82b136` feat(renderer) | `lib/api/sessions.ts`：`getSessionsApi()` 和内存 mock |
| `70c532a` feat(renderer) | `stores/sessions/`：`createSessionsStore`、`connectSessionsStore`、字段选择器、`index.ts`；store 用例 21 个，store + mock 端到端用例 3 个 |
| `f723ebb` feat(renderer) | `components/ui/collapsible.tsx` |
| `9a15dae` feat(renderer) | Markdown、shiki 代码高亮、复制按钮、思考折叠块、工具调用卡片（含编排工具专门样式）、纯展示函数，10 个用例 |
| `fe6d700` feat(renderer) | `ChatView`：标题行、虚拟化时间线、审批条、输入框、底部状态栏；新建会话弹层 |
| `1f71342` feat(renderer) | 侧栏会话分组（`Sidebar.tsx`）、主区域挂聊天视图（`MainArea.tsx`）、两个 hook |

### 1. `lib/api/sessions.ts`

- **`SessionsApi` 没有再写一份**：agent-host 已合并，`src/preload/domains/sessions.ts` 里就是 §9.3 原文（经 Biome 格式化）。这里写 `export type { SessionsApi } from '../../../preload/domains/sessions'` 原样转出，避免两份定义漂移。见注意事项 3。
- `getSessionsApi({ mock? })`：有 `window.fynvra.sessions` 就用它；没有，或 `mock: true` 时，返回内存 mock。
  - 经 `globalThis` 读，不碰 DOM 类型，因为本模块要被 node 环境的测试 import。
  - 没有 `declare global`。
- **mock 模式开关**：`RENDERER_VITE_SESSIONS_MOCK=1`（electron-vite 给 renderer 暴露 `RENDERER_VITE_` 前缀）。
  - 加这个开关的原因：agent-host 合并后 preload 一定有 sessions 域，「不存在才退回 mock」的分支在 `pnpm dev` 里永远走不到。而真实后端在 Task 11 接通 providers 之前需要 `FYNVRA_ANTHROPIC_API_KEY`，审批门也还没有。
- **mock 的脚本**（每次 prompt 走一遍）：
  1. `message_end(user)`；
  2. `thinking_delta` 和 `text_delta` 流式输出；
  3. `message_end(assistant)` + `usage`；
  4. `ls`、`read` 工具；
  5. **一次需要审批的 `bash`**：发 `approval_request` 事件，再经 `onApprovalRequest` 推送，状态 `waiting-approval`，等 `respondApproval`；拒绝时工具记为 error；
  6. orchestrator 会话演示 `dispatch_task` / `wait_for_workers`，其他角色演示 `report_done`；
  7. 最后一条带 GFM 表格和代码块的总结，然后 `agent_settled`。
- `abort` 会给流式中的正文补 `message_end(aborted)`，给运行中的工具补 error 的 `tool_end`，再发 `agent_settled(aborted)`。
- `history()` 返回「落盘」的消息：消息在 message_end 时写入，工具结果回填到发起它的消息上，与 Main 投影 pi jsonl 的方式一致。

### 2. reducer（`stores/sessions/reducer.ts`）

投影按 `sessionId` 分桶：`messagesBySession`、`runtimeBySession`（`lastSeq`、status、累计 usage、模型、错误、工具开始时间）、`pendingApprovals`。

- **seq**：`seq <= lastSeq` 丢弃，原对象返回（zustand 不触发更新）。跳号照常接收。
- **流式**：
  - `text_delta` / `thinking_delta` 累加到权威区末尾的流式 assistant 消息，没有就新建一条，id 为 `live-<seq>`，纯函数、可复现。
  - assistant 的 `message_end` 用权威正文整条替换，置 `streaming=false`，思考与工具调用保留。没有流式消息时（只有工具调用的回合）也落一条，后续 `tool_start` 才有归属。
- **工具**：
  - `tool_start` 按 id upsert。history 里已有的调用原位更新；否则挂到权威区最近的 assistant 消息上，没有 assistant 消息就补一条空的。
  - `tool_end` 更新 status / output / durationMs。缺 durationMs 时按本地开始时间推算。
- **乐观回显**：
  - 只出现在数组尾部。流式内容插在回显之前。user 的 `message_end` 原位确认最早的回显。
  - 回合开始前就出错（`error` 事件且没有 user 的 message_end）时，回显标为「未送达」，下次发送时清掉。
- **`agent_settled`**：结束流式；还没有结果的工具调用标为 error（中断）；清空待审批队列。
  - 状态：本轮没出错是 `idle`，出过错是 `error`，与 agent-host supervisor 的语义一致（见注意事项 5）。
- **`error`**：记录错误，立即置 `error`。agent-host 在 prompt 回合开始前就失败时只发 error、不发 `agent_settled`，不立即置 `error` 的话会话会一直停在 running。
- **`usage`**：挂到最近的 assistant 消息上（`ChatMessage.usage`），同时累计到会话，并记下模型。
- **`approval_request`**：入队（kind 按工具名推断，规则与 Main 相同），置 `waiting-approval`。
  - 同一 toolCallId 的 `tool_start` / `tool_end` 出队，`agent_settled` 清空。
  - Main 的推送（`enqueueApproval`）按 id 合并：以 Main 的字段为准，保留事件带来的 toolCallId。不论两者谁先到，都不会重复入队。
- **`applyHistory`**：用权威投影整体替换，按权威消息重算用量，不动 `lastSeq`。
  - 还没落盘的内容留在尾部：权威区末尾的流式消息、未确认的回显。
  - history 里出现本地还没见过的同文 user 消息时，对应的回显视为已送达。
- **`syncSessionStatuses`**：列表刷新时以 Main 的状态为准。prompt 调用还在途的会话除外，保留本地的乐观 running。

### 3. store（`stores/sessions/`）

- **`createSessionsStore(api, { schedule?, now? })`**：不读全局 window，写法同 `createSettingsStore`。
  - 字段：`sessionsByWorkspace`、`messagesBySession`、`activeSessionId`、`pendingApprovals`、`drafts`，另有 `runtimeBySession`、`workspaceId`、`loadingHistory`、`listErrors`、`notice`。
- **动作**：
  - `loadSessions`：按 `updatedAt` 倒序；晚到的旧回包丢弃；列表里消失的选中会话取消选中。
  - `createSession(roleId)`：建在当前工作区，然后选中它。
  - `selectSession`：拉 history；先归并已到的事件再替换；同一会话只认最后一次请求。
  - `send(text)`：去掉首部空行和尾部空白；空文本、会话 running / waiting-approval、上一条 prompt 还在途时，返回 false。prompt 失败时撤回回显、恢复草稿与状态、记录错误。
  - `abort`。
  - `respondApproval`：先出队再转发；没送达且会话还在等待时重新入队并提示。
  - `setDraft`、`setWorkspace`。
- **推送**：`connectSessionsStore` 接 `onEvent` / `onApprovalRequest` / `onSessionsChanged`。
  - 事件默认每 16 ms 攒一批，用一次 `set` 归并，流式高频时少渲染。用 `setTimeout` 而不是 rAF，因为窗口被遮挡时 rAF 会停。
  - `sessions:changed` 只刷新当前工作区或缓存过的工作区。
- **选择器**：`selectors.ts` 导出各字段选择器（`selectMessagesOf(id)`、`selectStatusOf(id)` 等）。缺省值用模块级常量，不在选择器里造新对象。`index.ts` 建应用实例并接上推送。

### 4. UI（`components/chat/**`）

- **侧栏**：会话按工作区分组，挂在选中的工作区条目下面，替换了原来的「会话 / 暂无会话」占位。
  - 每行显示状态点（空闲灰 / 运行中蓝 / 等待审批琥珀 / 出错红）、标题、角色徽标和最近更新时间。主 agent 的徽标是紫色加皇冠，判定为 `orchestrator` 或工具策略为 orchestrator 的角色。
  - 分组头有「新建会话」按钮。
  - 行用 react-virtuoso 虚拟化，滚动容器借用侧栏 ScrollArea 的 viewport（`customScrollParent`）。
  - 相对时间由全局一个 30 s 时钟驱动，不是每行一个计时器。
- **新建会话弹层**：角色下拉用 `ui/select`，下面显示角色描述，默认选中 Orchestrator。
  - 任务书写的是「先用 `[orchestrator, worker]` 常量，settings-ui 合并后接 roles API」。settings-ui 已经合并，所以直接读 `useRolesStore`（含内置角色）；还没读到或读取失败时退回 core 的 `BUILTIN_ROLES`。
  - 创建失败时在弹层内显示原因。
- **时间线**：react-virtuoso，打开时停在底部。
  - 贴底时跟随：新增消息走 `followOutput`；最后一条消息长高时在布局阶段调用 `autoscrollToBottom`。用户往上翻就停止跟随，并显示「回到底部」按钮。
  - 页脚显示「agent 正在工作…」和会话错误。
- **消息**：
  - user 是右侧气泡；发送中半透明，未送达显示红色提示。
  - assistant 依次是：思考折叠块、Markdown 正文、工具卡片、悬停时出现的复制按钮。
- **Markdown**：GFM（表格、任务列表、删除线），不渲染原始 HTML，链接 `target=_blank`，由 Main 交给系统浏览器。
- **代码块**：语言标签、复制按钮、shiki 双主题配色。
  - 用 JavaScript 正则引擎：CSP 没有 `wasm-unsafe-eval`，oniguruma 用不了。
  - 28 种语法按需懒加载。结果缓存，虚拟列表重新挂载时不闪。
  - 流式中的代码块先不高亮；超过 2 万字符的块不高亮。
- **工具卡片**：标题行有图标、中文名、一行参数摘要、耗时，以及运行中 spinner / 完成 / 失败图标；展开后看完整参数和输出。
  - 编排工具用紫色，worker 工具用天蓝。
  - `dispatch_task` 显示任务标题、执行角色、依赖，可展开任务书。
  - `report_done` 显示结果徽标（成功 / 失败）、总结和改动文件，默认展开。
- **输入框**：`field-sizing: content` 自动长高；Enter 发送，输入法组字时的 Enter 不发送；Shift+Enter 换行；运行中显示「停止」。草稿按会话存在 store 里，切到会话时把焦点放进输入框。
- **审批条**：固定在输入框上方，只显示最早的一条，另有「还有 N 条」计数。内容是 kind 标签、标题、detail，三个按钮：「允许」(allow)、「本会话都允许」(allowSession)、「拒绝」(deny)。
- **状态栏**（会话底部一行）：累计 tokens（输入↑ / 输出↓）、费用（大于 0 才显示）、模型（usage 事件里的模型，没有时取会话的 model）。
- **布局文件的改动**：
  - `Sidebar.tsx`：一行 `useSessionsWorkspaceSync()`；工作区列表的 map 改成 `Fragment`，在选中项后挂 `<SessionList>`；删掉原来的占位 section。
  - `MainArea.tsx`：选中会话时 `return <ChatView key=… />`；原「还没有会话」占位换成 `<ChatPlaceholder>`，带「新建会话」按钮。

## 怎么验证

**基线**（`0b3d8fd`，加依赖之前，根目录完整执行 `pnpm install` 之后）：

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | **exit 1**：`src/main/ipc/index.ts`、`src/preload/index.ts` 两处 `organizeImports`（agent-host 与 settings-ui 合并后 import 没排序），见注意事项 1 |
| `pnpm test` | 77 个文件，970 个用例，全部通过 |

**验收命令**（最终提交，根目录）：

```
pnpm typecheck   → exit 0（node / web / packages 三段）
pnpm lint        → exit 1：Checked 268 files … Found 2 errors，仍是上面那两个范围外文件，没有新增
                   本卡改动的 33 个 ts/tsx/json 文件单独 biome check：No fixes applied，0 错误
pnpm test        → exit 0：Test Files 81 passed (81)；Tests 1029 passed (1029)
pnpm build       → exit 0：out/main/index.js、out/main/chunks/index-<hash>.js（worker）、out/preload/index.cjs、
                   out/renderer/assets/index-*.js 2,227.66 kB（未压缩，electron-vite 默认）+ 56 kB CSS，
                   shiki core / 引擎 / 各语法是单独的懒加载 chunk
```

- **新增用例**：4 个文件，59 个。
  - `reducer.test.ts` 25 个：乱序 seq、重复 seq、跳号、分桶、流式到权威替换、无增量的 message_end、乐观回显的确认 / 尾部约束 / 撤回 / 未送达、工具配对与耗时推算、history 里已有的调用、`agent_settled`、error 的保持与清除、usage 累计、审批入队出队与按 id 合并、`applyHistory`、`syncSessionStatuses`。
  - `createSessionsStore.test.ts` 21 个：注入的假 `SessionsApi`。覆盖 send 拒绝空文本 / 纯空白、running 或 prompt 在途时不重复发送、失败撤回、草稿按会话保留、history 乱序回包、列表状态同步、攒批只通知一次、审批答复与失败重新入队、断开订阅。
  - `mockSessionsApi.test.ts` 3 个：store 加内存 mock，假定时器。覆盖完整一轮（含审批放行）、拒绝审批、中途停止；并断言 history 回放与实时投影逐字段一致（文本、思考、工具 id / 状态 / 输出、usage）。
  - `display.test.ts` 10 个：格式化与工具摘要。
- **renderer 测试的约束**：都在 `tsconfig.node.json` 覆盖范围内，被测模块不碰 DOM。`pnpm typecheck:node` 通过，正好说明没有用到 DOM 全局。
- **TDD 的实际顺序**（如实说明）：
  - reducer 与 store 是先写测试，跑红（模块不存在），再实现。
  - 两者都做了变异验证，每处改动都有用例变红，恢复后全绿：
    - reducer：去掉 seq 守卫，2 例失败；回显不再限制在尾部，2 例失败；settled 不再保持 error，1 例失败。
    - store：去掉忙碌守卫、空文本守卫、history 乱序守卫、在途会话跳过，各 1 例失败。
  - `format.ts` / `toolDisplay.ts` 的用例和实现在同一轮写成，不是严格的先红后绿。mock 的端到端用例是在 mock 写完之后补的。

**真机冒烟一：`pnpm dev` mock 模式**

- 环境：
  - 用 `node node_modules/electron/install.js` 装 Electron，用的是本机缓存，没有下载。
  - 临时 userData，预置一个指向临时 git 仓库的工作区，主题设为深色。
  - `RENDERER_VITE_SESSIONS_MOCK=1 FYNVRA_USER_DATA_DIR=<临时目录> pnpm dev --remoteDebuggingPort 9341`。
  - 经 CDP 发真实鼠标和键盘事件（`Input.dispatchMouseEvent` / `insertText` / Enter），只查 DOM，不截图。脚本放在仓库外的临时目录。
- 结果：**连续两轮 26 项全部 PASS**：
  - 深色主题生效；选中工作区后，会话分组出现在它下面；主区域有「新建会话」。
  - 弹层默认是 Orchestrator；创建后侧栏出现带皇冠徽标的行。
  - Enter 发送后输入框清空，显示「停止」，流式 Markdown 出现。
  - 审批条显示「执行命令 / bash / pnpm test」和三个按钮；审批前已有「列目录」「读取」卡片；标题行状态为「等待审批」。
  - 点「允许」后跑完：`dispatch_task` 卡片显示任务标题，`wait_for_workers` 也在；GFM 表格渲染出来。
  - 代码 token 的计算颜色 `rgb(249,117,131)` 等于 `--shiki-dark` 的 `#F97583`，深色配色生效；有复制按钮。
  - 状态栏是 `tokens ↑3.7k ↓296 $0.01 mock-model`；settled 后「停止」消失；展开 bash 卡片能看到输出。
  - 第二个会话经下拉选 Worker：草稿「第二个会话的草稿」切走再切回仍在，另一个会话的输入框是空的。
  - Worker 会话拒绝审批后，`report_done` 卡片显示「失败」与总结，bash 卡片标为失败。
  - 运行中点「停止」回到空闲。
  - 全程没有 console error / warning / 异常，也没有 CSP 违规。
- 关窗后进程正常退出（exit 0），没有残留进程。

**真机冒烟二：真实后端**（agent-host 的 worker 进程加真实 pi 会话；用本地假 Anthropic SSE 端点，不联网）

- 环境：
  - `FYNVRA_ANTHROPIC_API_KEY=smoke-local-key`，`FYNVRA_ANTHROPIC_BASE_URL=http://127.0.0.1:18765`，另用一个全新的 userData。
  - 假端点第一轮回「文本 + `bash {command: "git log --oneline -1"}`」，收到 tool_result 后回 Markdown 总结。
- 结果：
  - 经真实 `sessions.create` 建 Worker 会话，创建后状态栏就显示 `claude-sonnet-5-5`。
  - 发送后 user 消息被确认（没有「发送中」）。流式开场白之后，bash 卡片完成，**输出是 worker 进程真实执行的 `c9c7f57 init`**，耗时 222ms；随后是 Markdown 总结和代码块。
  - 状态栏是 `tokens ↑642 ↓99 $0.0023 claude-sonnet-5-5`，费用由 pi 按目录价格计算。
  - **重新选中会话，触发 history 从 pi jsonl 回放**：转录与实时投影相同，包括 222ms。唯一差别是测试时我展开过的那张卡片，回放后重新挂载又是折叠的；这是界面状态，不是数据差异。
  - 没有 console error。
  - 第一次假端点写错（见注意事项 8），pi 一直重试；在界面上点「停止」，250 ms 内回到空闲，顺带验证了真实后端的中止。
- 没有验证的：审批条走真实后端。agent-host 还没有审批门，`sessions:approval-request` 不会触发，审批只在 mock 下验证过。

## 未做 / 越界项

- **没有越界修改文件**。`src/main/**`、`src/preload/**`、`src/agent/**`、`packages/**`、`components/settings/**` 都没动。
- `src/shared/types/chat.ts` 没有创建：agent-host 合并后它已经存在，任务书写的是「仅当不存在时创建」。
- `ui/` 只新增了 `collapsible`。`textarea`、`badge`、`select` 已由 settings-ui 加入，直接复用。
- 工具输出的 `outputTruncated` 没有显示：`ChatToolCall` 没有这个字段，实时和 history 都截在 8 000 字。
- 没有做「删除会话」的界面（API 有 `remove`，任务书没要求）。
- 用户全局说明里的知识库检索（`maestro spec` / `maestro wiki`）本机用不了：没有 `maestro` 命令，`~/.maestro/workflows/coding-philosophy.md` 也不存在。与前几张卡的情况相同。

## 给验收人的注意事项

1. **`pnpm lint` 在 `main` 上本来就是红的**：`src/main/ipc/index.ts`、`src/preload/index.ts` 的 import 没排序，是 agent-host 与 settings-ui 两次合并叠出来的。
   - 这两个文件都在本卡的「不要动」里；Task 11 的范围也排除了 `src/preload/**`。
   - 建议在 `main` 上直接执行 `pnpm exec biome check --write src/main/ipc/index.ts src/preload/index.ts`，只是重排 import。之后本分支合并进去，lint 就是全绿。
2. **合并**：本分支基于 `0b3d8fd`。`main` 之后只多了 Task 11 任务卡（`9b5be7b`），`git merge-tree` 显示无冲突。锁文件只追加了四个包的条目。
3. **`SessionsApi` 是转出而不是复制**：`lib/api/sessions.ts` 从 `preload/domains/sessions.ts` 转出 §9.3 类型（agent-host 的原文）。renderer 统一从 `@/lib/api/sessions` 取，以后只维护一份。
4. **mock 模式**：
   - PowerShell：`$env:RENDERER_VITE_SESSIONS_MOCK='1'; pnpm dev`；bash：`RENDERER_VITE_SESSIONS_MOCK=1 pnpm dev`。
   - 不设这个变量时走真实后端。Task 11 接上 `createModelResolver()` 之前，真实后端需要 `FYNVRA_ANTHROPIC_API_KEY`，否则新建会话会在弹层里报模型解析失败。
   - mock 的会话只在内存里，刷新页面就没了。
   - 新 worktree 第一次 `pnpm dev` 报 `Electron uninstall` 时，先执行 `node node_modules/electron/install.js`（本机有缓存）。
5. **状态语义**：
   - `agent_settled` 后，本轮没出错是 `idle`，出过错是 `error`，与 agent-host 一致，否则列表刷新时会和 Main 的状态来回跳。
   - `error` 事件立即置 `error`。
   - 显示的状态以事件为准；`sessions:changed` 触发列表刷新时，以 Main 为准。
6. **已知的小竞态**：history 回包早于对应的 assistant `message_end` 事件到达时，可能多显示一条消息，下次切换会话就恢复。实测中 Main 总是先推事件、后回 history，没有遇到。
7. **未知工具在实时视图里不显示卡片**：模型调用当前角色没有的工具时（真实冒烟里假模型先调了 `ls`，而 worker 的 pi 默认工具只有 read / bash / edit / write），pi 不发 `tool_execution_*`。实时时间线没有卡片，history 却从 jsonl 的 toolCall 块显示出一张 error 卡片。这是 agent-runtime 归一化层的行为，不在本卡范围，可以留给后续卡片，比如在 `message_end` 带上工具调用。
8. **写 CDP 冒烟脚本的坑**：
   - **窗口被遮挡时**，`document.visibilityState` 是 `hidden`，rAF 停止。Base UI 的弹层、下拉、折叠动画会停在 `data-starting-style` / `data-ending-style`，透明的遮罩还会吞掉点击。我遇到的两次「点了没反应」都是这个原因，用户正常使用不受影响。自动化可以用 `element.click()`，或者让窗口可见。
   - **pi 在 tool_result 之后还会附一条 system 消息**。假端点不能只看最后一条消息来判断工具结果是否已回传。
   - **`/tmp` 被同机其他会话共用**（`/tmp/build.log` 被别的构建覆盖过）。日志请用 `mktemp -d`。
9. **体积**：renderer 主 chunk 从约 1.44 MB 增加到 2.23 MB（未压缩），主要来自 react-markdown / micromark 和 react-virtuoso。shiki 的 core、JS 引擎和 28 种语法都是按需加载的 chunk，最大的 cpp 约 850 KB，只在出现对应语言的代码块时才加载。体积成问题时可以再把 Markdown 整体懒加载。
