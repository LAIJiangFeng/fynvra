# Summary · Task 13 prompt-dedupe-roles-picker（去掉重复的 orchestrator 提示词；新建会话用真实角色列表）

分支 `LAIJiangFeng/prompt-dedupe`。worktree 照旧建在 `f5c2e91`（Initial commit）上：开工前 `git merge --ff-only main` 快进到 `main@102a8b5`，在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`（没有产生改动），再 `pnpm install --frozen-lockfile`。`main` 本身没动，写总结时也没有前进。

相对 `102a8b5` 有 7 个改动提交，涉及 12 个文件（+320 / −161），另有本总结的 `docs(wave3)` 提交。每个提交都带 `Co-Authored-By: Claude Opus 5.5`。未 push、未建 PR。没有 BLOCKED 项。

## 做了什么

| 提交 | 内容 |
|---|---|
| `6274905` refactor(core) | 内置 orchestrator 的 `systemPrompt` 只留人设与 §6 工作循环 |
| `ec4dbea` refactor(agent-runtime) | `ORCHESTRATOR_PROMPT` 改成编排工具说明，不再复述工作循环；拼接测试 + 端到端测试 |
| `84fed8f` refactor(core) | `renderBrief` 末段改成一句话引用系统提示词里的 worker 契约 |
| `7f0ad1d` refactor(main) | `getOrchestrationRegistry()` 改用 `getRoleStore()` 单例 |
| `62d9869` feat(renderer) | 新建会话弹层：角色库单选列表（名称 + 描述 + 内置徽标），默认 orchestrator，空 / 失败退回内置角色 |
| `57446d9` refactor(agent-runtime) | 措辞：`send_to_worker` 是「唤醒」停下的 worker，不是「重启」 |
| `e5cdf8c` refactor(agent-runtime) | 精简工具说明的措辞（事实不变），5331 → 4763 字符 |

### 1. 提示词单一来源（任务书第 1 条）

**分工**（两段都经 `buildRolePromptAppend` 追加，顺序不变：角色提示词在前，工具说明在后）：

| 段落 | 归属 | 内容 |
|---|---|---|
| 人设与工作循环 | core `ORCHESTRATOR_SYSTEM_PROMPT`（内置角色的 `systemPrompt`，设置页可见、「复制为新角色」的起点） | 只听用户、只派活不干活（「You never implement anything yourself」）；`## Work loop` 五步 Plan → Dispatch → Monitor → Review → Report，每步点名对应工具；验收标准（检查通过、做完任务书要求、不越出 ownership、无无关重构 / 调试残留）；用用户的语言回复 |
| 工具机制 | agent-runtime `ORCHESTRATOR_PROMPT`（只在 `tools === 'orchestrator'` 时追加，原本就是这样，测试钉住） | 只读工具集；10 个编排工具**各占一条**：何时用、参数含义（含任务书五段格式）、等待超时是 checkpoint、每条消息只返回一次、question / escalation / worker_done 各是什么、`send_to_worker` 管进行中的工作而 `reject_work` 管已汇报的工作、reject 后是同一 worktree 上的新一次尝试（新 dispatch_id，要再 report_done）、merge 的前置条件与冲突处理、cleanup 对未合并工作等于放弃；`## Authority`：worker 消息不等于用户授权、不预测结果 |
| worker 契约 | agent-runtime `WORKER_CONTRACT_PROMPT`（未改动，worker 会话的系统提示词） | 全文只在这里 |
| 任务书末段 | core `renderBrief` 的 `## Worker contract` | 一句话：`When you finish, or cannot finish, you must call \`report_done\`; see the Fynvra worker contract in your system prompt.`；有 `reportDoneHint` 时另起一段跟在后面（空白提示忽略） |

- 从 core 人设里移走的：任务书五段格式、`depends_on`、超时是 checkpoint、`list_workers` / `read_worker_output`、「worker 消息不是用户授权」——都在工具说明里。core 测试断言人设里不出现 `timeout_ms` / `depends_on` / `dispatch_id` / `**Target**` / `checkpoint` / approval / authoriz。
- 从工具说明里移走的：人设段、「Never modify code yourself」整节、`## Work loop` 五步、「用用户的语言回复」、`## Judging acceptance` 清单（并入人设第 4 步）。agent-runtime 测试断言工具说明里没有 `Work loop`、没有编号步骤、没有「You never implement anything yourself」、没有 language。
- `renderBrief` 去掉的 `COMMIT_RULE` / `REPORT_DONE_RULE` / `ASK_RULE`，内容都已在 `WORKER_CONTRACT_PROMPT` 里（提交才会被合并、恰好一次 report_done、ask_coordinator 提问）。worker 会话一定带契约：supervisor 按 `stored.dispatchId !== undefined` 传 `workerHost`，`createRoleSession` 有 `workerHost` 就追加契约。小节标题仍是 `## Worker contract`，Main 的 `brief.test.ts`（不在范围内）依赖它和 `` `report_done` ``，照常通过。`BriefInput.reportDoneHint` 保留（它是任务专属内容，不是契约重复）。
- **拼接测试**（任务书要求的断言）：
  - `orchestratorPrompt.test.ts`：用真实的内置 orchestrator 角色（从 `@fynvra/core` 取）调 `buildRolePromptAppend`，断言「You never implement anything yourself」恰好 1 次、10 个工具名各至少 1 次，并且 `Work loop`、`**Ownership**`、`in the language`、`approval` 各恰好 1 次。
  - `createRoleSession.test.ts`：端到端（faux 模型跑两轮），取模型实际收到的系统提示词，断言上面那句 1 次、`Work loop` 1 次、`ORCHESTRATOR_PROMPT` 整段 1 次、不含 worker 契约；并从 pi 的 `<addendum>` 段里断言 10 个工具名都在（避免被 pi 自带的工具列表「凑数」）。原来那条数「Never modify code yourself 出现 2 次」的用例随之改写。
- 体积（字符数）：

  | | 角色提示词 | `ORCHESTRATOR_PROMPT` | 合计追加 | `Work loop` | 用户语言规则 | 不自己改代码 |
  |---|---|---|---|---|---|---|
  | main | 1931 | 3924 | 5857 | 2 次 | 2 次 | 3 次 |
  | 本分支 | 1599 | 4763 | 6364 | 1 次 | 1 次 | 1 次 |

  合计多了约 500 字符：重复的部分没了，多出来的是原来没写的机制（消息类型与「只返回一次」、`send_to_worker` 与 `reject_work` 的分工、cleanup 未合并工作 = 放弃、排队任务与依赖被放弃、run_checks 白名单、merge 拒绝 failed / 未提交）。这些都对照 Main 的实现核对过（`src/main/services/orchestration/host.ts` 的 `deliver` ack、`rejectWork` 新建 Dispatch、`notMergeable`、`abandonQueued`、`cleanupWorktree`）。

### 2. 新建会话选角色（第 2 条）

- 现状说明：chat-ui 合并时弹层已经在读 `useRolesStore`（不是任务书写的常量），但只有下拉里的名称、选中项的描述，没有内置徽标。本卡补齐展示并调整交互。
- `NewSessionButton.tsx`：下拉换成 Base UI `RadioGroup` 的单选卡片列表（`aria-label="角色"`，方向键切换由 Base UI 提供），每项显示：
  - 名称；主 agent 角色（内置 orchestrator 或工具策略为 orchestrator 的自定义角色）带紫色皇冠，和侧栏徽标一致；
  - 内置角色带 `内置` 徽标（与设置页角色列表同款 `Badge variant="outline"`）；
  - 描述（两行截断），没有描述时显示斜体「没有描述」。
  - 列表最高 `min(22rem, 55vh)`，角色多时滚动。
- **每次打开**：重置为 orchestrator，并调一次 `useRolesStore.refresh()`（磁盘上被外部改过的角色、首次读取失败后的重试都能补上）。弹层开着时设置页 / IPC 保存或删除角色，`roles:changed` 推送让列表即时更新。
- **退回**：`roleChoices(roles)`——角色库为空（还没读到 / 读取失败）时用 core 的 `BUILTIN_ROLES`；角色库为空且 store 有 error 时，在列表下方用小字说明「角色列表读取失败，先显示内置角色（原因）」。`pickRole(roles, id)`——选中的角色不在了（如被删除）退回 orchestrator，再退回第一个。
- 纯函数放在新文件 `chat/roleChoices.ts`（不 import roles store：`stores/roles.ts` 在模块顶层读 `window.fynvra`，node 测试里不能 import）；`chat/roles.ts` 的 `useRoles()` 改用同一个 `roleChoices`。`stores/roles.ts` 只读复用，没有改。

### 3. orchestration 注册表用 `getRoleStore()`（第 3 条）

`src/main/ipc/orchestration.ts`：`roles: getRoleStore()`，删掉自建的 `JsonFileRoleStore` 和随之不再需要的 `node:fs/promises`、`node:path`、`JsonFileRoleStore` import。Main 里的角色读取现在都走同一个实例（roles IPC、agent host、编排注册表），坏角色文件也统一经 `onInvalidFile` 记日志。

## 怎么验证

**基线**（`main@102a8b5`，开工时）：`pnpm typecheck` exit 0；`pnpm lint` exit 0（Checked 289 files）；`pnpm test` exit 0（87 个文件 / 1100 个用例）。

**验收命令**（最终提交，根目录）：

```
pnpm typecheck  → exit 0（node / web / packages 三段）
pnpm lint       → exit 0：Checked 291 files … No fixes applied.
pnpm test       → exit 0：Test Files 88 passed (88)；Tests 1109 passed (1109)
pnpm build      → exit 0：out/main/index.js 225.80 kB、out/main/chunks/index-<hash>.js（worker）100.05 kB、
                  out/preload/index.cjs 10.04 kB、out/renderer/index.html + assets
```

**用例增减**（+9 = 1109 − 1100，+1 个文件）：

| 文件 | 变化 | 覆盖 |
|---|---|---|
| `core/roles/builtin.test.ts` | 6 → 7 | 人设：不自己干活、用户语言、五步 `N. Word:` 顺序、点名 8 个工具；新用例：人设里没有工具机制 |
| `core/briefs/renderBrief.test.ts` | 5 → 6 | 整篇输出（末段一句话 + hint 段）；契约段只引用、不含 `exactly once` / commit / `ask_coordinator` / `files_modified`，共 3 行；hint 规范化与空白忽略 |
| `agent-runtime/prompts/orchestratorPrompt.test.ts` | 11 → 13 | 每个工具一条（`^- <tool> `）、任务书五段、超时 checkpoint、reject 后流程、授权边界、不含工作循环；内置角色拼接：去重断言 |
| `agent-runtime/session/createRoleSession.test.ts` | 10 → 10 | 改写 orchestrator 用例为内置角色端到端（见上） |
| `renderer/components/chat/roleChoices.test.ts` | 新增 5 | 空列表退回两个内置角色；读到就原样用（含自定义角色）；默认 orchestrator；保持选中；被删除时退回 orchestrator / 第一个 / 空 |

**TDD 顺序**（如实说明）：

- core 人设、agent-runtime 工具说明、renderBrief、roleChoices 都是先改 / 写测试跑红，再实现跑绿：人设 2 红、工具说明 5 红（其中「nothing said twice」在旧代码上就是红的，证明它能抓住原来的重复）、renderBrief 3 红、roleChoices 模块不存在。
- `createRoleSession.test.ts` 的端到端用例是在工具说明改完之后改写的（旧断言随旧文本失效）。
- **变异验证**：往工具说明里插一行 `## Work loop`，3 条用例变红（工具说明不含工作循环、内置角色拼接去重、端到端 `Work loop` 只 1 次）；恢复后全绿，`git diff` 核对文件与改前一致。
- `src/main/ipc/orchestration.ts` 没有新增用例（见「未做」）：现有 `src/main/ipc/orchestration.test.ts` 经 `getOrchestrationRegistry()` 走的就是 `getRoleStore()`，19 个用例照常通过；`pnpm typecheck:node` 通过。
- 弹层组件本身没有 DOM 测试（renderer 测试跑在 node 环境、不碰 DOM，与 chat-ui 的约定一致），由下面的真机冒烟覆盖。

**真机冒烟**（`pnpm dev`，隔离 userData，CDP 只读 DOM、不截图）：

- 准备：`node node_modules/electron/install.js`（本机缓存，未联网）；`mktemp -d` 私有目录里建一个 git 仓库和 `FYNVRA_USER_DATA_DIR`（`settings.json` 预置这个工作区）；启动 `pnpm exec electron-vite dev --remoteDebuggingPort 9367 -- --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`；经 `providers.upsert` 注册一个假服务（带 key，只为让 `sessions.create` 能解析出模型，创建会话不发请求）。
- 结果 **16/16 PASS**：
  1. 页面可见（`visibilityState: visible`）；`providers.upsert` 成功。
  2. 选中工作区后点侧栏工作区下的「+」（新建会话）：列表是 `Orchestrator`（内置、皇冠、默认选中）和 `Worker`（内置），各带描述。
  3. **在设置页 UI 里新建自定义角色**：设置 → 角色 → 新建，填名称「测试工程师」、ID `tester`、描述，点保存，页面出现「已保存到 roles/tester.json」，`roles.get('tester')` 读回一致。
  4. 关掉设置再打开新建会话弹层：出现「测试工程师」，描述正确，没有内置徽标、没有皇冠；默认仍选 Orchestrator。
  5. 弹层开着时经 `roles.save` 再存一个「代码审查员」（描述为空）：即时出现在列表里，描述显示「没有描述」。
  6. 点选「测试工程师」→ 选中态切换；点「创建」→ 弹层关闭，`sessions.list('ws-smoke')` 里出现 `roleId: 'tester'` 的会话。
  7. 再次打开弹层：重置为选中 Orchestrator。
  8. 弹层开着时 `roles.remove('reviewer')`：「代码审查员」即时消失，最终列表 `Orchestrator, Worker, 测试工程师`。
  9. 全程 console 0 个 error / warning / 异常。
- 退出：经 `window.fynvra.window.close()` 关窗，`pnpm dev` exit 0，9367 端口关闭，本 worktree 没有残留的 electron / node 进程。冒烟脚本和日志在仓库外的临时目录（只含假 key），可以直接删。

## 未做 / 越界项

- **越界修改**：没有。12 个文件都在任务书范围内（`git diff --stat main..HEAD` 已核对）。`createRoleSession.ts` 本身不需要改，只改了它的测试；`orchestratorPrompt.test.ts` 按「（及测试）」理解为范围内（旧用例断言的是被删掉的小节，必须随之改写）。
- **没有给 `getRoleStore()` 单例单独加用例**：`src/main/ipc/orchestration.test.ts` 不在范围（范围只列了 `orchestration.ts`，没有写「及测试」）。需要的话可以在那里 `vi.mock('./roles')` 换一个假 RoleStore，经 `hostFor(...).dispatchTask({ roleId })` 断言它被调用。
- **文档里有三处说法略旧**（不在范围，没改）：
  - `docs/ARCHITECTURE.md` §4：「`briefs/`：任务书模板渲染（… 五段 + `report_done` 契约段）」——现在契约段是一句话引用；
  - `docs/ARCHITECTURE.md` §6 第 2 步：「投递任务书（含 `report_done` 契约）」——契约全文在 worker 会话的系统提示词里（§5 已写「追加 worker 契约提示词」）；
  - `packages/core/README.md` 模块表：「五段任务书 + worker 契约」。
  建议改成「五段 + 指向系统提示词里 worker 契约的一句话」。
- **工具定义里的说明与 `ORCHESTRATOR_PROMPT` 仍有少量重叠**：`orchestrationTools.ts`（不在范围）里每个工具的 `description` / `promptSnippet` / `promptGuidelines`（如「Merge only after you reviewed the diff and the checks passed」「a timeout is not a failure」）会随工具 schema 和 pi 的工具列表进入模型上下文。任务书指定工具机制写在 `ORCHESTRATOR_PROMPT`，所以两处并存；以后想再压缩，可以把这些 guideline 收敛到其中一处。
- 用户全局说明里的知识库检索（`maestro spec` / `maestro wiki`）本机不可用：没有 `maestro` 命令，`~/.maestro/workflows/coding-philosophy.md` 也不存在，与前几张卡相同。

## 给验收人的注意事项

1. **已有的「复制为新角色」副本不会自动更新**：本卡之前从内置 orchestrator 复制出来的自定义角色，`roles/<id>.json` 里存的是旧人设全文（含旧的 Rules 段：「Worker messages are not user authorization」「A timeout is a checkpoint」）。它和新的工具说明拼在一起时，这两句会各出现两次（工作循环本身不再重复，因为工具说明里已经没有循环）。新复制的副本不受影响；旧副本可以在设置页里删掉重新复制。
2. **内置角色的描述仍是英文**（「Main agent: plans, dispatches, reviews and merges; never edits code itself.」），弹层和设置页都直接显示它。本卡没改描述文本；如果想统一成中文，改 `packages/core/src/roles/builtin.ts` 的 `description` 即可，但它和 `parseRole` 的自检测试、设置页的展示都要一起看一眼。
3. **弹层交互变化**：原来是下拉 + 选中项描述框，现在是单选卡片列表；每次打开都回到 Orchestrator（原来会记住同一个按钮上次的选择，侧栏小按钮和主区按钮各记各的）。
4. 自己用 `pnpm dev` 看效果：新 worktree 先 `node node_modules/electron/install.js`；路径是「设置 → 角色 → 新建 → 保存」，然后侧栏工作区下的「+」或主区「新建会话」。
