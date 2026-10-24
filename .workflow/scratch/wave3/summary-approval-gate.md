# Summary · Task 14 approval-gate（按角色 approvalMode 拦截工具调用，接通审批条）

分支 `LAIJiangFeng/approval-gate`。worktree 照旧建在 `f5c2e91`（Initial commit）上。开工时（还没有任何提交）确认 HEAD 是 `main` 的祖先，用 `git merge --ff-only main` 快进到 `102a8b5`，再在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`，然后 `pnpm install --frozen-lockfile`。`main` 本身没动，写总结时也没有前进；`git merge-tree --write-tree main HEAD` 退出码 0。

相对 `102a8b5` 有 7 个提交（6 个改动 + 1 个文档回写），另有本总结的 `docs(wave3)` 提交，每个都带 `Co-Authored-By: Claude Opus 5.5`。范围外只动了 `docs/ARCHITECTURE.md`（单独一个提交，见「未做 / 越界项」）。没有 BLOCKED 项。

## 做了什么

| 提交 | 内容 |
|---|---|
| `772cb50` feat(agent-runtime) | `src/approval/`：工具分类、保护底线匹配、`createApprovalGate`（pi `tool_call` 扩展），140 个单测；`index.ts` 导出 |
| `c8e3ca5` feat(agent-runtime) | `createRoleSession` 增加 `approval?: ApprovalPolicyHooks`，审批门作为第一个扩展注册；不提供时 fail-closed；8 个真实 pi 会话用例 |
| `b7571c1` feat(shared) | 协议新增 worker → Main 的 `approval-request` 消息及 parser，16 个用例 |
| `7a20c10` feat(agent) | supervisor 给每个会话一个审批通道；`ApprovalBroker.cancel`；`piSession.ts` 把通道传给 `createRoleSession` |
| `c2f4550` feat(main) | Main 按 `approval-request` 记待审批并推 `sessions:approval-request`；dispose 运行中的会话时收尾；`InMemoryWorker` 往返端到端 |
| `0df2492` docs | ARCHITECTURE §5 回写 `approval` 参数与审批门语义（范围外，可单独丢弃） |
| `aedacb9` test(agent) | 真实会话的通道用例挪到独立文件，避开 Task 12 在 `piSession.test.ts` 里的文件级 `vi.mock` |

### 1. 审批门（`packages/agent-runtime/src/approval/`）

- **`policy.ts`**：`approvalKindOf(toolName)`：`bash` / `powershell` / `run_checks` → `command`，`write` → `file-write`，`edit` / `apply_patch` → `file-edit`，`mcp__<server>__<tool>` → `mcp`，其余（read / grep / find / ls / git_readonly / report_done / ask_coordinator / 编排工具 / MCP 资源工具 / codemode）返回 null，任何档位都不审批。
  - `modeRequiresApproval`：`supervised` 四类都审批；`auto-edits` 只审批 `command` 与 `mcp`；`full` 都不审批。不认识的档位按 `supervised` 处理（fail-closed）。
  - `describeToolCall`：title 是工具名；detail 是命令全文（command 类）、写目标路径（write / edit 取 `path`，apply_patch 从 `*** Add/Update/Delete File:`、`*** Move to:` 里取，每行一个）、MCP 等其余情况是参数 JSON 预览（上限 2000 字，超出以 `…` 结尾）。
  - `ApprovalKind` / `ApprovalDecision` 在这里定义（packages 不能 import `src/shared`），与 `chat.ts` 同形；`src/agent/supervisor.test.ts` 里用 `expectTypeOf` 钉住两边相等。
- **`protectedCommand.ts`**（保护底线）：`protectedAction(command)` 返回命中的规则名或 undefined。
  - 先接上 bash（`\` + 换行）与 PowerShell（`` ` `` + 换行）的续行，按 `; & | ( ) { } ` 换行` 切成简单命令，再按空白切词、去掉两端引号。所以 `bash -c "rm -rf x"`、`` echo `rm -rf x` ``、`sudo` / `xargs` / `find -exec` / `cmd //c` 包装的都能命中。
  - 规则：`rm` 带递归选项（`-r` / `-rf` / `-fr` / `-Rf` / `-r -f` / `--recursive`，可缩写）→ `rm -rf`；`Remove-Item` 及其 PowerShell 别名（`ri` / `rm` / `del` / `erase` / `rd` / `rmdir`）带 `-Recurse`（可缩写、可带 `:$true`）→ `Remove-Item -Recurse`；`del` / `erase` / `rd` / `rmdir` 带 `/s`（含 `/q/s` 连写）→ `del /s`；`git` 子命令为 `push`（跳过 `-C <dir>`、`-c <kv>`、`--no-pager` 等全局选项）→ `git push`；`git reset … --hard` → `git reset --hard`；npm / pnpm / yarn / bun / deno / jsr / cargo / poetry / uv / hatch / flit / pdm 后面出现 `publish` → `<pm> publish`。
  - 子命令位置上的 `rm` 不当作删除程序：`git rm -r --cached .`、`pnpm rm -r left-pad`、`docker rm -f web` 不命中。
  - 比任务书字面多拦的部分见注意事项 5。
- **`gate.ts`**：`createApprovalGate({ mode, request, now?, timeoutMs? })` 返回 `{ check(call, signal?), extension }`。
  - `check`：不需要审批的直接放行；命中底线的不看档位、不看 allowSession，一律询问。请求带 `toolCallId / toolName / kind / title / detail / args / protectedAction? / expiresAt`，`expiresAt = now() + timeoutMs`（默认 10 分钟）。
  - `allow` 放行一次；`allowSession` 记住 `kind:工具名`（同一个审批门，即同一个 pi 会话实例内有效）；`deny` 返回 `{ block: true, reason }`，pi 把 reason 当作错误工具结果交给模型，回合不中断、不抛异常。
  - fail-closed：超时、pi 回合的 `ctx.signal` 中止、宿主 `request` 抛错或 reject、返回未知决定，都按拒绝处理。超时和中止时会 abort 交给宿主的 `signal`，让宿主撤下请求；超时后才到的答复不改结果，也不会记进 allowSession。
  - 拒绝文本（英文，给模型看）示例：``The user denied the command `echo hi`; the tool was not run. Do not retry the same call: continue another way or ask the user what they want instead.``；命中底线时再加一句 `This is a protected action (git push) that always needs the user's confirmation.`；超时、中止、宿主出错各有对应文本。
  - `extension`：`{ name: 'fynvra-approval-gate', hidden: true }`，`pi.on('tool_call', …)`。pi 的 ctx 在会话替换 / 重载后读 `signal` 会抛，这里当作没有中止信号，照常询问。

### 2. `createRoleSession`

- 新参数 `approval?: ApprovalPolicyHooks`（`{ request, timeoutMs?, now? }`），审批档位取 `role.approvalMode`。
- 审批门是 `extensionFactories` 的第一个，在 MCP 等扩展的 `tool_call` 处理之前拦截（pi 遇到第一个 block 就停）。
- **不提供 `approval` 时 fail-closed**：需要审批的调用一律拒绝，拒绝文本写明 `this session has no approval channel`；不需要审批的照常执行。

### 3. 协议（`src/shared/types/agent.ts`）

- 新增 `AgentWorkerEvent` 变体 `{ type: 'approval-request'; identity; request: AgentApprovalRequest }`，`request` = `requestId / toolCallId / toolName / kind / title / detail / protectedAction? / expiresAt`。parser 逐字段收窄，任一字段不合法整条丢弃，未知字段剥离。
- **为什么不是给 `approval_request` 会话事件加字段**（任务书写的是「`approval_request` 事件（带 requestId、expiresAt）」）：
  - 会话事件类型自 Task 10 起定义在 `packages/core`（`FynvraSessionEventBody`），不在本卡范围；
  - 审批条要的 kind / title / detail 由 agent-runtime 算出，而 Main 不能加载 agent-runtime 的值（否则 pi 进主进程），只能由 worker 带过来。
  - 所以 worker 先发 `approval-request`（Main 记 pending、推审批条），再发 `approval_request` 会话事件（时间线据 toolCallId 关联工具卡片，工具结束时出队）。会话事件本身没改。
  - 顺序是刻意的：Renderer 先收到 Main 的推送（权威字段），随后的事件只给已有条目补 toolCallId；按 Renderer 现有 reducer，临时推导的 kind / detail 不会闪现。

### 4. Worker（`src/agent/`）

- `OpenSessionInput` 增加 `approval?: ApprovalPolicyHooks`；supervisor 打开每个会话时都给：`request = (req, signal) => this.requestApproval(identity, req, signal)`，`timeoutMs` = supervisor 的审批时限（默认 `APPROVAL_TIMEOUT_MS` 10 分钟，与审批门一致）。字段设为可选，是因为范围外的 `src/main/services/sessions/history.test.ts` 手写了 `OpenSessionInput`；缺省时同样 fail-closed。
- `requestApproval(identity, request, signal?)`：发 `approval-request` → emit `approval_request` 会话事件（命中底线时 `reason: protected action: …`）→ 状态 `waiting-approval` → 等 `respond-approval`。审批门撤回（`signal` abort）时 `ApprovalBroker.cancel(requestId)` 按 deny 结束；原有的会话 abort / dispose / `agent_settled` 一律 deny 不变；broker 自己的超时保留作兜底。
- `piSession.ts` 只改了一处：解构出 `approval` 并传给 `createRoleSession`。

### 5. Main（`src/main/services/agentHost/agentHost.ts`）

- `approval-request`：过期 generation 的丢弃；否则记 pending（`expiresAt` 用 worker 给的），推 `sessions:approval-request`，kind / title / detail 原样使用；命中底线时标题为 `bash（保护底线：git push）`。
- `approval_request` 会话事件照常转发给 Renderer，**不再**据它推送；原来按工具名猜 kind、按参数猜 detail 的 `approvalKindOf` / `describeArgs` 删除（规则只剩 agent-runtime 一份）。
- `respondApproval` 不变：只转发一次、只发给提出请求的 generation、过期拒绝。worker 崩溃时 pending 清空（原有）；Renderer 由原有的 `agent_settled(aborted)` 清掉审批条。
- **dispose 运行中的会话**（`launcher.disposeSession`、`remove`）：worker 关闭会话时按 deny 结束待审批，之后不再发事件，Renderer 原本会一直挂着一个答不了的审批条，会话状态也停在 `running` / `waiting-approval`。现在 Main 替它补一条 `agent_settled(aborted)` 并置 `idle`。空闲会话 dispose 时不发任何事件。

## 怎么验证

**验收命令**（根目录，最终提交）：

```
pnpm typecheck   → exit 0（node / web / packages 三段）
pnpm lint        → exit 0：Checked 296 files … No fixes applied.
pnpm test        → exit 0：Test Files 91 passed (91)；Tests 1284 passed (1284)（基线 87 / 1100）
pnpm build       → exit 0：out/main/index.js 226.99 kB、out/main/chunks/index-<hash>.js（worker）113.37 kB、out/preload/index.cjs
```

- 构建产物：`out/main/index.js` 里 `@earendil-works` 出现 0 次；审批门（`fynvra-approval-gate`）只在 worker chunk 里。

**新增 / 改动的用例**（+184）：

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `approval/protectedCommand.test.ts`（新） | 67 | 六类底线的各种写法、包装、复合命令、续行；子命令位置与常见误报不命中 |
| `approval/policy.test.ts`（新） | 40 | 工具分类、三档 × 四类、未知档位 fail-closed、title / detail 提取（命令、路径、apply_patch、MCP 预览截断、缺字段、循环引用） |
| `approval/gate.test.ts`（新） | 33 | 三档 × 四类、只读工具、请求内容与 expiresAt、底线（full / run_checks / powershell / 不被 allowSession 豁免 / 拒绝文本）、allow / allowSession / deny、超时 deny 并撤回、自定义时限、回合中止、已中止不询问、宿主抛错 / 同步抛错 / 未知决定、迟到答复不生效、pi 扩展注册与失效 ctx |
| `session/createRoleSession.test.ts` | 10 → 18 | 真实 pi 会话 + faux 模型：supervised 写文件先问、允许后写入；拒绝后文件不存在、模型收到拒绝文本、回合正常结束；auto-edits 写文件不问而 bash 要问；full 下 `git push` 仍问；allowSession；中止回合撤回待审批；无通道 fail-closed；orchestrator 的 `run_checks` 走底线 |
| `shared/types/agent.test.ts` | 82 → 98 | `approval-request` 合法样本、未知字段剥离、13 种坏输入 |
| `agent/supervisor.test.ts` | 19 → 27 | 通道与时限、先 `approval-request` 后事件、无底线时不带 reason、审批门撤回、已撤回不询问、abort / dispose / settle / 超时 deny、类型钉子 |
| `agent/piSession.approval.test.ts`（新） | 1 | 会话工厂经 supervisor 的通道审批（真实 pi 会话） |
| `main/services/agentHost/agentHost.test.ts` | 25 → 33 | 推送字段以 worker 为准、底线标题、单独的事件不推送、过期 generation、worker 的到期时间、settle / 崩溃清 pending、dispose 等待中的会话收尾、空闲会话 dispose 不发事件 |
| `main/services/agentHost/roundTrip.test.ts` | 3 → 6 | **端到端**（`InMemoryWorker`：两端 parser + 真实 SessionSupervisor + 真实审批门）：supervised 会话调 bash → 推送审批、状态 `waiting-approval` → `respondApproval(allow)` → 工具继续执行；deny → 拒绝文本作为工具结果；派发的 worker（内置 `auto-edits`）allowSession 后下一条 bash 不再问、`git push` 仍问 |

**TDD 的实际顺序**（如实说明）：

- 先写测试、跑红、再实现：`protectedCommand` / `policy` / `gate`（模块不存在，3 个文件全红）；`createRoleSession` 的 8 个审批用例（8 红）；协议 parser（接受类 3 红，拒绝类在实现前因整条消息类型未知而恰好通过，实现后由新分支负责拒绝）；supervisor（9 红）；会话工厂（1 红）；agentHost（先 4 红 1 绿，那 1 个是旧的推导规则恰好产出相同的值，我把 worker 的到期时间改成与 Main 时钟无关的值后变红，再实现）。
- 写在实现之后的：`roundTrip.test.ts` 的 3 个端到端用例。为此做了变异验证：去掉 Main 对 `approval-request` 的处理，6 个用例失败（含这 3 个），恢复后全绿。
- 审批门与底线的变异验证（每次改完跑对应测试，再恢复）：底线不再优先于档位 / allowSession → 4 失败；不记 allowSession → 2 失败；已中止的回合仍询问 → 1 失败；子命令位置当作程序 → 1 失败；去掉 `git push` 规则 → 8 失败。`git status` 恢复干净。
- 写测试时自己的一个错误：「迟到答复不生效」那条第一次写成第二次审批永远不答复，跑超时了；改成显式答复后通过，不是实现问题。

**与同波次分支的合并预检**（快照，供参考）：

- Task 12（`LAIJiangFeng/windows-shell@853155a`）一开始与本分支在 `src/agent/piSession.test.ts` 文本冲突：它把整个文件的 `createRoleSession` `vi.mock` 掉了，我的真实会话用例留在那里会跑在 mock 上。已把我的用例挪到 `piSession.approval.test.ts`，`piSession.test.ts` 恢复为 main 的版本（`aedacb9`）。
- 之后 `git merge-tree` 与 Task 12、Task 13（`LAIJiangFeng/prompt-dedupe@180ca03`）、`main` 都是 exit 0。在临时本地分支上依次合入这两个快照跑全量：typecheck 0、lint 0（302 files）、test 94 files / 1320 passed；临时分支已删除。自动合并后的 `piSession.ts` 同时带 `approval` 与 `settingsManager: createSessionSettings(spec.shellPath)`。

**真机冒烟**（`pnpm dev`，隔离 userData，不联网）：

- 准备：
  - 新 worktree 没有 Electron 二进制，执行 `node node_modules/electron/install.js`，用本机缓存，没有下载。
  - 127.0.0.1 上起一个假的 Anthropic Messages SSE 端点：最后一条 `SMOKE: <命令>` 的 prompt 让模型调用 `bash { command: <命令> }`；该 prompt 之后出现 tool_result 时回复 `MODEL SAW (ok|error): <工具结果原文>`，并把每次请求收到的工具结果记到日志。
  - 临时 git 仓库 + 新的 `FYNVRA_USER_DATA_DIR`（`settings.json` 预置这个工作区）；经 CDP 调 `window.fynvra.providers.upsert` 注册假端点（设置页同一个 IPC，key 为 `smoke-local-key`）。
  - Task 12 还没合入，本机 PATH 上第一个 `bash.exe` 是 WSL，所以给 dev 进程的 PATH 前置了 `D:\Software\Git\bin`（与 Task 11 的做法相同）。
  - 启动：`pnpm exec electron-vite dev --remoteDebuggingPort 9361 -- --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`。
  - 驱动：CDP 脚本点侧栏工作区、经 IPC 新建 **Worker 角色（auto-edits）** 会话并点开，在输入框 `Input.insertText` + Enter 发 prompt，**点击审批条上真实的「允许 / 拒绝 / 本会话都允许」按钮**；结论来自 DOM、`sessions.history` 与假端点日志，没有截图。
- 第一轮跑出来的两个失败都是脚本问题：一是对 DOM 元素用 `returnByValue` 拿不到值；二是用带反引号的文本去匹配 DOM，而 Markdown 把反引号渲染成了行内代码。产品行为当时已从假端点日志确认正确。修正脚本后在**全新的 userData 上整轮重跑**，结果如下（全部 PASS，`SMOKE OK`）：

  | 轮次 | 操作 | 观察到的事实 |
  |---|---|---|
  | R1 | `SMOKE: echo hi` → 点「允许」 | 审批条出现：标签「执行命令」、标题 `bash`、详情 `echo hi`，三个按钮；会话状态 `waiting-approval`。允许后 bash 真实执行，工具调用 `done`，输出 `hi\n`；模型收到的工具结果是 `hi\n`（非错误），时间线出现 `MODEL SAW (ok): hi` |
  | R2 | `SMOKE: echo hi` → 点「拒绝」 | 工具调用 `error`，输出即拒绝文本；**模型收到的工具结果**（假端点日志）：`isError: true`，``The user denied the command `echo hi`; the tool was not run. Do not retry the same call: continue another way or ask the user what they want instead.``；时间线显示模型复述的这段话 |
  | R3 | `SMOKE: echo session-ok` → 点「本会话都允许」 | 审批条详情 `echo session-ok`，允许后执行，输出 `session-ok` |
  | R4 | `SMOKE: echo no-ask` | **没有**审批推送（推送计数前后都是 3），审批条一次都没出现（MutationObserver 计数 0），bash 直接执行，输出 `no-ask` |
  | R5 | `SMOKE: git push origin main` | allowSession 之后仍弹审批条，标题 `bash（保护底线：git push）`、详情 `git push origin main`；点「拒绝」后 git push 没有执行，模型收到 `… This is a protected action (git push) that always needs the user's confirmation. …` |

  - 推送共 4 次（R1 / R2 / R3 / R5），`expiresAt` 都在 10 分钟后（worker 给的）。
  - 假端点收到 10 个请求，`x-api-key` 都是假 key；Renderer 的 DOM 和推送里没有 key。
  - Renderer 控制台 0 个 error / warning。
  - 退出：经 IPC 关窗 → `dev exited: 0`；9361 端口已释放，本 worktree 没有残留的 electron / node 进程。
  - 冒烟脚本、日志、`report2.json` 与两份 userData 在 `%TEMP%\fynvra-approval-smoke-BkpEN5`（仓库外，只含假 key），可以直接删掉。

## 未做 / 越界项

- **越界修改**：`docs/ARCHITECTURE.md`（`0df2492`）。ARCHITECTURE 要求「改动契约必须先改本文」，而任务书要求给 `createRoleSession` 加 `approval` 参数，所以在 §5 的 `CreateRoleSessionOptions` 里加了一行，并补了一段审批门语义。不同意的话可以只丢这个提交，代码不依赖它。
- 没有动 renderer / preload / `src/main/services/orchestration/**` / `packages/core`。
- `src/main/services/sessions/history.test.ts`（范围外）手写了 `OpenSessionInput`；为了不改它，`approval` 在 `OpenSessionInput` 上是可选的（缺省 fail-closed），supervisor 总会提供。
- `packages/agent-runtime/README.md` 不在范围，没有写 `approval` 参数；JSDoc 已说明。README 里「审批门用 `events.emit({ type: 'approval_request' })` 注入」的说法仍然成立（worker 照此发事件）。
- **没做**：
  - allowSession 的记忆跟着 pi 会话实例走：worker 崩溃重启、应用重启、会话重新 spawn 后会重新询问（往更安全的方向偏）。
  - 同一时刻挂着多个同类请求时（pi 对一批工具调用是逐个过 `tool_call` 的，只有 codemode 之类的嵌套调用可能并发），对其中一个选 allowSession 不会自动放行其他已在等的请求。
  - 除 `run_checks` 外的编排工具（`merge_worktree` 等）不审批，严格按任务书的表。
- 用户全局说明里的知识库检索（`maestro spec` / `maestro wiki`）本机不可用：没有 `maestro` 命令，`~/.maestro` 也不存在，与前几张卡相同。

## 给验收人的注意事项

1. **产品影响：内置 worker 角色（`auto-edits`）现在每条 bash 都要人确认。** 主 agent 派出的 worker 也一样。审批条只显示在当前选中的会话里：用户只盯着 Orchestrator 会话时，看不到 worker 的审批请求，只能从侧栏 worker 行的琥珀色状态点（等待审批）发现；10 分钟没人答复按 deny，worker 拿到拒绝文本继续。建议后续加一个跨会话的待审批入口（如在 Orchestrator 视图或标题栏汇总子会话的审批），本卡没有动 renderer。
2. **合并**：本分支基于 `102a8b5`，与 `main` 无冲突。与 Task 12 / 13 当前快照的文本合并都干净，合在一起全量检查通过（见「合并预检」）。如果 Task 12 后续又改了 `src/agent/piSession.test.ts`，注意我的真实会话用例在 `piSession.approval.test.ts`，不要合回那个带文件级 `vi.mock` 的文件里。
3. **本机自测 bash**：Task 12 合入之前，worker 的 bash 在本机会落到 WSL；自测审批条时先 `$env:Path = "D:\Software\Git\bin;$env:Path"; pnpm dev`。
4. **allowSession 的语义**：按 kind + 工具名记忆（放行过 `bash` 不等于放行 `powershell`、放行过 `write` 不等于放行 `edit`）。对一条命中底线的请求选「本会话都允许」，只放行这一次的底线命令，同时记住该类工具；之后的非底线 bash 自动放行，底线命令照样要问。
5. **底线比任务书字面多拦的部分**（都是往多问的方向）：
   - `rm -r`（不带 `-f`）也拦：PowerShell 里 `rm -r` 就是 `Remove-Item -Recurse`；
   - `rd /s`、`rmdir /s` 归入 `del /s`；`Remove-Item` 的别名（`ri` / `rm` / `del` / `erase` / `rd` / `rmdir`）带 `-Recurse` 都拦；
   - 引号不当边界，命令文本里提到这些操作（如 `git commit -m "use rm -rf"`、`echo git push`）也会问。
   - 没覆盖：`Get-ChildItem … | Remove-Item`（不带 `-Recurse`）、`rimraf`、`find -delete`、`git` 别名，任务书没列。
6. **dispose 的行为变化**：关闭一个还在跑的会话（orchestration 清理 worktree 时、或删除会话）现在会给 Renderer 补一条 `agent_settled(aborted)` 并把状态置 `idle`；以前状态会停在 `running` / `waiting-approval`。
7. **不需要审批通道的调用方**：`createRoleSession` 不传 `approval` 时，需要审批的调用会被拒绝而不是放行。以后若有别的宿主直接用 agent-runtime 起会话，记得接上通道。
8. Renderer 的 mock 模式（`RENDERER_VITE_SESSIONS_MOCK=1`）不受影响，仍走它自己的脚本化审批。
