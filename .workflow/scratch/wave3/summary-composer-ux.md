# Summary · Task 22 composer-ux（输入框切审批档位、方向键翻历史输入、显示当前分支）

分支 `LAIJiangFeng/composer-ux`。worktree 建在 `f5c2e91`（Initial commit）上：开工时确认 HEAD 是 `main` 的祖先，`git merge --ff-only main` 快进到 `e6c61ec`，在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`（没有产生改动），再 `pnpm install --frozen-lockfile`。写总结时 `main` 仍是 `e6c61ec`，`git merge-tree --write-tree main HEAD` 退出码 0。

相对 `e6c61ec` 有 10 个改动提交（34 个文件，+2132 / −79），另有本总结的 `docs(wave3)` 提交。每个提交都带 `Co-Authored-By: Claude Opus 5.5`，没有 push，没有建 PR。没有 BLOCKED 项。没有改范围外的文件（`docs/ARCHITECTURE.md` 需要回写的契约见「未做 / 越界项」，给了可直接贴的文字）。

## 做了什么

| 提交 | 内容 |
|---|---|
| `e34579f` feat(shared) | `chat.ts`：`APPROVAL_MODE_LABELS` / `APPROVAL_MODE_HINTS`、`nextApprovalMode`（Shift+Tab 的循环）；`agent.ts`：Main → worker 的 `set-approval-mode { identity, mode }` 与 parser |
| `c5e46f7` feat(agent-runtime) | 审批门 `setMode(mode)` / `mode`；allowSession 记忆规则；`ApprovalPolicyHooks.onGate` 把审批门交给宿主 |
| `d1bd6f2` feat(agent) | supervisor 处理 `set-approval-mode`（运行中即时生效，失败按 fatal 关会话）；piSession 经 onGate 拿到审批门；`agentHost/testing.ts` 的 ScriptedSession 补方法 |
| `6ec069b` feat(shared) | `SessionSummary.approvalMode`（必填）、`branch?`；sessionStore 的收窄与旧记录迁移；create / 派发取角色的档位；mock 与测试夹具补字段 |
| `088e638` feat(main) | `agentHost.setApprovalMode`、spawn 用会话的档位、`sessions:set-approval-mode` 通道与 handler |
| `3773545` feat(preload) | `window.fynvra.sessions.setApprovalMode`；Renderer mock 实现它并按档位决定脚本里的 bash 是否审批 |
| `42faba2` feat(main) | `sessions/branches.ts`：读分支（2 s）+ 缓存 / 节流（3 s）；list / history / agent_settled / 窗口 focus 时重读，变了广播 `sessions:changed` |
| `ce7bb19` feat(renderer) | `inputHistory.ts` 纯函数 |
| `2ba79c4` feat(renderer) | sessions store `setApprovalMode`：乐观更新、回滚、在途保护、只认最后一次回包 |
| `bb3b0b4` feat(renderer) | `ApprovalModePicker`（新建）、Composer（Shift+Tab、↑ / ↓ / Esc）、ChatView 分支徽标、StatusBar 档位与分支 |

### 1. 审批档位切换

- **审批门（agent-runtime）**：`setMode(mode)` 从下一次 `check` 起生效，回合进行中也可以；已经在等答复的那条请求仍以答复为准。
  - **allowSession 记忆**：按任务书定为保留；只有从 `full` 切回更严的档位（auto-edits / supervised）时清空。full → full、supervised ↔ auto-edits 都保留。
  - 保护底线不受影响：切到 full 之后 `git push` 等照样询问（有用例，真机也验证了）。
  - **`onGate`**：`createRoleSession`（`packages/agent-runtime/src/session/`，不在范围内）在内部建审批门、把 `approval` 钩子整体展开传进去，所以在钩子里加一个 `onGate(gate)`，审批门建好时回调，worker 就能拿到它；没有改 createRoleSession。
- **协议与 worker**：`set-approval-mode` 接在会话的 opening promise 上（排在先到的命令之后，比如慢的 set-model），但不等回合：运行中立即切，这一轮照常继续。成功时 worker 记一条 `session <id>: approval mode <mode>`。
  - 切不成功（只可能是会话没有审批通道）时，审批门可能还停在比记录宽松的旧档位：关掉会话、报 fatal，Main 下次使用前按记录重新 spawn。与 set-model 失败走同一段代码（抽成 `#abandon`）。
- **Main**：
  - 记录（sessions.json）是权威。`setApprovalMode` 更新记录、广播；会话在 worker 里就发 `set-approval-mode`，不论是否在跑；还没 spawn 时只改记录，下次 spawn 用新值；档位没变时什么都不做。
  - spawn 时 `spec.role.approvalMode` 换成会话的档位，审批门从记录起步，不再从角色文件起步。
  - 缓存的 spawn spec 一并改掉，**包括崩溃后等着重建的会话**：否则在 worker 重启的空档里切的档位，会被重建时缓存的旧档位盖掉（这个场景有用例，做了变异验证）。
  - 新会话取角色的档位；orchestrator 派出的 worker 会话按它自己角色的档位，不继承主 agent 的（用例 + 真机：主 agent 为 full 时派出的 worker 是 auto-edits）。
- **旧记录迁移**（sessionStore）：没有 `approvalMode` 的记录，内置角色取固定档位（orchestrator → full，worker → auto-edits，与以前每次 spawn 取角色的行为一致）；自定义角色要读角色文件才知道，fail-closed 取 supervised；不认识的值同样处理，不丢会话。见注意事项 1。
- **Renderer**：
  - 输入框左下角、模型胶囊旁的审批胶囊：图标 + 「全程审批 / 自动接受编辑 / 完全放行」，完全放行是琥珀色。点开是三项单选列表，每项第二行是说明；full 那项写明「rm -rf、git push、git reset --hard、publish 等保护底线仍要你确认」，列表底部再说一遍，并提示 Shift+Tab。
  - 输入框聚焦时 Shift+Tab 循环 supervised → auto-edits → full → supervised，运行中也能切；焦点留在输入框。
  - 切换后胶囊与状态栏的档位闪一下（ring，700 ms）；状态栏的档位是 `aria-live`，屏幕阅读器会读出新档位。
  - store 的 `setApprovalMode`：先在列表里换上（乐观），Main 回包后以记录为准；失败换回原档位、提示「切换审批档位失败：…」并重拉列表；在途时列表刷新不会把档位改回去；连按几次只认最后一次回包。

### 2. 方向键翻历史输入

- **`inputHistory.ts`**（纯函数，状态 `{ entries, draft, cursor }`）：`historyEntries` 从旧到新、去掉空的、相邻重复合并、只留最近 200 条（合并之后再计数）；`startHistory` 把输入框当前文字记为草稿；`up` 到最旧一条停住；`down` 越过最新一条回到草稿；`toDraft` 直接回到草稿；越界的游标按底部处理。
- **Composer**：
  - 输入框为空或光标在第一行时 ↑ 取上一条，在最后一行时 ↓ 取下一条，翻过最新一条回到草稿；Esc 直接回到草稿；翻到的内容一经编辑就成为新草稿（不再处于浏览态）。
  - ↑ 后光标放开头、↓ 后放末尾，连续按就能一直翻，多行的条目也不用先把光标挪到第一行。
  - 浏览中切走会话，原来的草稿放回去（同 Esc）；输入法组字时的按键都交给输入法。
  - 历史来源：store 时间线里该会话的 user 消息，它同时包含 history（pi jsonl）回放的和这次运行里发出去的；每个会话各自独立（Composer 按会话挂载，浏览状态在组件内）。

### 3. 显示当前分支

- **`sessions/branches.ts`**：
  - `readGitBranch(cwd)` 复用 `gitRepository.ts` 的 `runGit`：先 `git symbolic-ref --quiet --short HEAD`；detached 时 `git rev-parse --short HEAD` 给短 sha；不是 git 目录、目录已不存在（如已清理的 worktree）、没有 git 时返回空。整次读最多等 2 s，超时按读不到处理。
  - `createBranchTracker`：cwd → 分支的内存缓存；同一目录 3 s 内不重读（force 除外）；同一目录同时只起一次 git，force 遇到正在读的会等它读完再读一次，免得用上 checkout 之前的结果；返回分支有变化的目录。
- **agentHost**：
  - `list` 立即返回缓存里的分支，同时在后台重读；`history` 也重读；`agent_settled` 强制重读（这一轮 agent 可能切过分支）；`refreshBranches()` 重读所有读过的目录。
  - 分支有变化才给所属工作区广播 `sessions:changed`，Renderer 重拉列表拿到新分支；读到的相同不广播，重拉时又落在节流窗口里，不会循环。
  - create / setModel / setApprovalMode 回给 Renderer 的会话也带上分支。分支只在内存，不写 sessions.json（`StoredSession` 去掉了 `branch`，磁盘上有也丢掉）。
  - worker 会话的 cwd 是它的 worktree，读出来就是 `fynvra/<slug>`。
- **窗口 focus**：在 `ipc/sessions.ts` 的 `registerSessionHandlers` 里挂 `app.on('browser-window-focus')` → `refreshBranches()`。`src/main/index.ts` 不在范围内，所以没放那里。
- **Renderer**：标题行角色徽标后是分支徽标（git-branch 图标 + 分支名，悬停显示 cwd，长名截断）；状态栏右侧依次是审批档位、分支（悬停显示 cwd）、模型。

## 怎么验证

**基线**（`e6c61ec`）：typecheck 0；lint 0（372 个文件）；test 124 个文件 / 1759 个用例全过。

**验收命令**（最终提交，根目录）：

```
pnpm typecheck  → exit 0（node / web / packages 三段）
pnpm lint       → exit 0：Checked 377 files … No fixes applied.
pnpm test       → exit 0：Test Files 126 passed (126)；Tests 1844 passed (1844)
pnpm build      → exit 0：out/main/index.js 336.46 kB、out/main/chunks/index-<hash>.js（worker）130.83 kB、out/preload/index.cjs 13.10 kB
                  out/main/index.js 里 @earendil-works 出现 0 次
```

**新增 / 改动的用例**（+85 = 1844 − 1759）：

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `shared/types/agent.test.ts` | +10 | `set-approval-mode` 三档合法样本、未知字段剥离；**坏输入**：缺 identity、generation 0、缺 mode、未知 mode、大小写不同、null、数组 |
| `shared/types/chat.test.ts` | +3 | Shift+Tab 循环、三档显示名、说明（full 写明保护底线） |
| `agent-runtime/approval/gate.test.ts` | +7 | **setMode 的记忆规则**：下一次起生效；ask 档之间切换保留 allowSession；full 切回更严时清空；full 下底线询问时给的 allowSession 离开 full 后清空；切到 full 底线仍问；在等的请求以答复为准；onGate |
| `agent/supervisor.test.ts` | +5 | 运行中立即切且回合继续、排在慢 spawn 之后、排在先到的 set-model 之后且按到达顺序、失败报 fatal 并关会话、过期 / 未知 identity |
| `agent/piSession.test.ts` | +2 | 假 createRoleSession：经 onGate 拿到审批门并 setMode、宿主自己的 onGate 照样收到；没有审批通道时拒绝切换 |
| `agent/piSession.approval.test.ts` | +1 | **真实 pi 会话**（faux 模型）：supervised 会话切到 full 后 write 不再询问、文件写入 |
| `main/services/sessions/sessionStore.test.ts` | +2 | 档位落盘；旧记录迁移（内置角色 / 自定义角色 supervised / 未知值）；磁盘上的 branch 丢弃 |
| `main/services/sessions/branches.test.ts`（新） | 15 | **真实临时 git**：普通分支（含斜杠）、linked worktree、detached 短 sha、无提交的仓库、**非 git 目录与不存在的目录返回空**；注入 runner：先 symbolic-ref 后 rev-parse、2 s 超时、没有 git；缓存：首读、3 s 节流与 force、相同结果不报、并发合并、force 排在在读之后、读失败保留、known |
| `main/services/agentHost/agentHost.test.ts` | +11 | 新会话 / 派发会话的档位与落盘；**set-approval-mode 在 running / waiting-approval 时也成功**、未 spawn 只改记录、崩溃重建沿用新档位、worker 重启空档里切的档位进重建、档位不变不动、未知会话；分支：后台读并只广播一次、外部 checkout 过节流后可见、history 与窗口 focus 重读、agent_settled 强制重读、派发 worker 取 worktree 分支 |
| `main/services/agentHost/roundTrip.test.ts` | +1 | **端到端**（两端 parser + 真实 supervisor + 真实审批门）：supervised 会话等审批时切到 full，这一条仍以答复为准，下一条 bash 不再询问，git push 仍询问 |
| `main/ipc/sessions.test.ts` | +10 | 新通道转发与 8 条坏入参；窗口 focus 调 `refreshBranches` |
| `preload/domains/sessions.test.ts` | 扩展 | 新方法的通道映射 |
| `renderer/components/chat/inputHistory.test.ts`（新） | 12 | **全路径**：合并相邻重复、200 条上限（合并后计数）、去空；起点、↑ 到最旧停住、↓ 回到草稿、空草稿、Esc、没有历史、重复算一步、手工状态与越界游标 |
| `renderer/stores/sessions/createSessionsStore.test.ts` | +5 | **乐观更新与回滚**（Main 失败、IPC 抛异常）、运行中 / 等审批时照样切、在途时列表刷新不回退、连切只认最后一次回包、找不到会话 |
| `renderer/stores/sessions/mockSessionsApi.test.ts` | +1 | mock 的 orchestrator（full）bash 不询问；切到 supervised 后拒绝审批的原用例 |

**TDD 的实际顺序**（如实说明）：

- 先写测试、跑红、再实现：shared（7 红）、审批门（7 红）、supervisor + piSession（8 红）、agentHost 档位 + roundTrip + IPC（15 红）、preload（1 红）、branches（模块不存在）、agentHost 分支（5 红）、IPC focus（1 红）、inputHistory（模块不存在）、store（5 红）。
- 与实现同一轮写成的：
  - sessionStore 的档位收窄与迁移用例；
  - agentHost「新会话 / 派发会话取角色档位」那条：`SessionSummary.approvalMode` 变成必填后，create 与 launcher 必须同时补上；
  - 「worker 重启空档里切的档位进重建」那条：写实现时想到的边界；
  - mockSessionsApi 的拆分：mock 改为按档位决定是否审批后，原用例必须改。
- 变异验证（每处改完跑对应测试，再恢复）：
  - 审批门：永不清空 allowSession → 2 例失败；每次切换都清空 → 1 例失败。
  - sessionStore：忽略内置角色的档位 → 1 例失败；忽略记录里的档位 → 1 例失败。
  - agentHost：从不更新缓存的 spawn spec → 2 例失败；只在 spawned 时更新（set-model 的写法）→ 1 例失败。
  - store：不判断是不是最后一次回包 → 1 例失败；列表刷新不保留在途档位 → 1 例失败。

**真机冒烟**（`pnpm dev`，隔离 userData，本地假 Anthropic SSE 端点，不联网）：

- **准备**：
  - 新 worktree 没有 Electron 二进制，执行 `node node_modules/electron/install.js`（本机缓存，没有下载）。
  - `%TEMP%\fynvra-t22-smoke-6958a6\` 下建临时 git 仓库（`main`，一个空提交）和 userData（settings.json 只登记这个工作区）。
  - 假端点按最后一条带文字的 user 消息里的标记调工具（`SMOKE-BASH:` → bash、`SMOKE-CHECKS:` → run_checks、`SMOKE-DISPATCH:` → dispatch_task、`SMOKE-WRITE:` → write），工具结果回来后回复 `MODEL SAW (ok|error): <结果>`，并把模型实际收到的工具结果记进日志。
  - 经 CDP 调 `window.fynvra.providers.upsert` 注册假端点（key 为 `smoke-local-key`）。
- **启动**：从 PowerShell 执行 `pnpm exec electron-vite dev --remoteDebuggingPort 9372 --inspect 9373 '--' --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`。
- **驱动**：
  - CDP 脚本发真实的键盘事件（Shift+Tab、↑ / ↓ / Esc、Enter）、点胶囊列表与审批条上真实的按钮。
  - 结论来自 DOM、sessions / orchestration IPC、sessions.json、假端点日志与 dev 日志，不截图。
  - 「窗口 focus」用 Main 的 inspector 执行 `app.emit('browser-window-focus')` 触发真实的监听，没有把窗口切到前台。
- **第一轮**（全部 PASS，`SMOKE OK`，报告 `report.json`）：
  1. **orchestrator 会话**：新建即「完全放行」（角色档位），胶囊与状态栏一致；标题行出现分支徽标 `main`，悬停是仓库路径；状态栏分支 `main`。
  2. 让它 `dispatch_task` 派出一个 worker：派出的会话是 `auto-edits`（不继承 full），分支是 `fynvra/smoke-worktree-task`。
  3. **在输入框按 Shift+Tab**：胶囊变「全程审批」并带 `data-flash`，0.9 s 后消失；状态栏同步；焦点仍在输入框；Main 记录为 supervised。
     - 此时让它 `run_checks git rev-parse --abbrev-ref HEAD`：**弹审批条**「执行命令 / run_checks / git rev-parse --abbrev-ref HEAD」；
     - 点允许后输出 `fynvra/smoke-worktree-task`，说明是在 worker 的 worktree 里跑的。
  4. **再按两次 Shift+Tab**：依次「自动接受编辑」「完全放行」，dev 日志依次 `approval mode supervised / auto-edits / full`。
     - **切到 full 后让它 `run_checks git status`**：没有审批推送（计数 1 → 1）、审批条一次都没出现（MutationObserver 计数 0）；
     - 输出 `On branch fynvra/smoke-worktree-task / nothing to commit, working tree clean`。
  5. **新建 worker 会话**（「自动接受编辑」）：点胶囊，列表三项与说明齐全（full 那项含「保护底线」「git push」），选「全程审批」。
     - 发 `echo hi`：**弹审批条**「执行命令 / bash / echo hi」，允许后模型收到 `hi`。
     - 再发一条 `hello again`。
  6. **↑ / ↓**：
     - 空输入框按 ↑ 得 `hello again`（光标 0），再 ↑ 得 `SMOKE-BASH: echo hi`，再 ↑ 停住；
     - ↓ 回到 `hello again`（光标在末尾），再 ↓ 回到空草稿；
     - 输入 `my draft` 后 ↑ 得上一条，Esc 回到 `my draft`；
     - ↑ 后输入 `X` 得 `Xhello again`，再按 ↓ 不再翻（已脱离历史态）；
     - 切到 orchestrator 按 ↑ 得到的是它自己的最后一条 `SMOKE-CHECKS: … git status`；切回 worker，草稿 `Xhello again` 还在。
  7. **分支**：
     - agent 在 worker 会话里 `git checkout -b agent-branch`（审批后执行），回合结束后标题行变 `agent-branch`（agent_settled 重读，没有发 focus）；
     - **外部 `git checkout -b test`**：4 s 内没有任何触发时徽标仍是 `agent-branch`，发窗口 focus 后**标题行变 `test`**，状态栏也是 `test`；
     - 外部 `git checkout --detach` 后发 focus：徽标是短 sha `121e323`（与 `git rev-parse --short HEAD` 一致）；
     - 点开派出的 worker：标题行是 `fynvra/smoke-worktree-task`，悬停是它的 worktree 路径（`…\repo-worktrees\ws-smoke\smoke-worktree-task`），胶囊「自动接受编辑」。
  8. **持久化与卫生**：
     - sessions.json 里三个会话依次是 full / supervised / auto-edits，没有任何 `branch` 字段；
     - Renderer 的 DOM 里没有 key；
     - 控制台 0 个 error / warning；关窗后 `dev exited: 0`。
- **第二轮**（同一个 userData，重启 dev 后；全部 PASS，`SMOKE2 OK`，报告 `report2.json`）：
  1. 重启后 orchestrator 胶囊仍是「完全放行」，worker 仍是「全程审批」。
  2. **↑ 的历史来自 pi jsonl**：重启后 store 里的草稿与发送记录都没了，空输入框 ↑ 得 `SMOKE-BASH: git checkout -b agent-branch`，再 ↑ 得 `hello again`，Esc 回到空草稿。
  3. **新 worker（auto-edits）写文件不问**：`smoke-a.txt` 写入，审批推送 0。
  4. **会话已在 worker 里时**（这是第一轮里 worker 的 `echo` 证明不了的：auto-edits 下 bash 本来也问），Shift+Tab 两次切到「全程审批」：
     - 写 `smoke-b.txt` **弹审批条**「写入文件 / write / smoke-b.txt」；
     - 拒绝后文件不存在，模型收到 `The user denied writing smoke-b.txt; the tool was not run. …`。
  5. **运行中切换**：发 `echo mid`，审批条出现、会话 `waiting-approval`；这时按两次 Shift+Tab 到「完全放行」：
     - Main 记录为 full，没有错误提示；
     - 点允许后 `mid` 执行（等着的那条以答复为准）；
     - 下一条 `echo after` 不询问直接执行。
  6. **full 下保护底线**：`git push origin smoke` 仍弹审批条，标题「bash（保护底线：git push）」；拒绝后没有执行，模型收到 `… This is a protected action (git push) that always needs the user's confirmation. …`。
  7. dev 日志：这个会话依次 `approval mode full / supervised / auto-edits / full`；控制台 0 个 error / warning；`dev exited: 0`；假端点两轮收到的 key 只有 `smoke-local-key`；本 worktree 没有残留的 electron / node 进程，9372 / 9373 已释放。
- 脚本（`scripts/mock.mjs`、`drive.mjs`、`drive2.mjs`）、日志、两份报告、临时仓库与 userData 都在 `%TEMP%\fynvra-t22-smoke-6958a6`，只含假 key，可以整个删掉。

## 未做 / 越界项

- **没有改 `docs/ARCHITECTURE.md`**（不在范围内）。按文档「改动契约必须先改本文」的要求，需要回写的内容如下，可直接贴：
  - §9.2 `SessionSummary` 末尾加：

    ```ts
    approvalMode: ApprovalMode;   // 创建时取角色的值，之后是会话自己的设置（sessions:set-approval-mode，运行中也能切）
    branch?: string;              // cwd 当前检出的分支（Main 现读 git，不落盘）；detached 时是短 sha
    ```
  - §9.3 `SessionsApi` 加：

    ```ts
    /** 换审批档位：运行中也可以，即时生效；会话还没在 worker 里时下次启动用新档位 */
    setApprovalMode(input: { sessionId: string; mode: ApprovalMode }): Promise<IpcResult<{ session: SessionSummary }>>;
    ```

    通道列表加 `set-approval-mode`，并加一条：
    - **换审批档位**（`sessions:set-approval-mode`）：更新记录 → 会话在 worker 里时发 `set-approval-mode { identity, mode }` → worker 调审批门 `setMode`。
    - **分支**：Main 在 list / history / agent_settled / 窗口 focus 时用 git 重读（每个目录 3 s 节流、2 s 超时），变了推 `sessions:changed`。
  - §5 审批门一段末尾加：
    - `ApprovalGate.setMode(mode)` 运行中可切；
    - allowSession 记忆保留，从 full 切回更严档位时清空；
    - 宿主经 `ApprovalPolicyHooks.onGate` 拿到 createRoleSession 建的审批门；
    - spawn 时 `spec.role.approvalMode` 是会话的档位。
- **与范围相邻、按惯例一起改的测试文件**：
  - `src/preload/domains/sessions.test.ts`：范围只写了 `sessions.ts`，测试文件与它同目录，Task 17 也是这样改的。
  - `src/main/services/agentHost/testing.ts`：在 `agentHost/**` 内，是 ScriptedSession 这个测试替身。
- **没有动**：settings 页、orchestration、packages/core；`packages/agent-runtime/src/session/createRoleSession.ts`（用 `onGate` 绕开）；`src/main/index.ts`（focus 监听挂在 `ipc/sessions.ts`）；侧栏的 `SessionList` / `SessionBadges`（侧栏行不显示分支，任务书没要求）。
- 用户全局说明里的知识库检索（`maestro spec` / `maestro wiki`）本机不可用：没有 `maestro` 命令，`~/.maestro` 也不存在，与前几张卡相同。

## 给验收人的注意事项

1. **旧会话的迁移**：本分支合并前建的会话没有 `approvalMode`。
   - orchestrator / worker 内置角色的会话取原来的档位（full / auto-edits），行为不变；
   - **自定义角色的会话一律按 supervised（全程审批）**：读记录时拿不到角色文件，按 fail-closed 处理，会比以前多问；用户在输入框里 Shift+Tab 或点胶囊切一次即可。
   - 不想要这个行为的话，可以改成 agentHost 启动后异步按角色补档位。
2. **Shift+Tab 占用了输入框里「反向移焦点」**：与 Claude Code 的做法一致。Tab 正向移焦点不受影响；输入框标了 `aria-keyshortcuts="Shift+Tab"`。
3. **运行中切换的语义**：从下一次需要审批的工具调用起生效。已经弹出的审批条不会因为切到 full 自动放行，仍要点一下（真机第二轮第 5 步）。
4. **分支的刷新时机**：
   - 第一次列出会话时还没读过，先不带分支，后台读到后推一次 `sessions:changed`（大约一次 git 调用的时间）；
   - 外部 checkout 要等下一次触发（窗口重新获得焦点、切会话读 history、列表刷新且距上次读超过 3 s、回合结束）才会显示；
   - detached 只显示短 sha，没有「detached」字样（`branch` 只是字符串）。
5. **↑ 判断「第一行」按逻辑行（换行符）**，不识别自动折行：在一段很长、折成多行显示的单行草稿里，光标在第二个视觉行按 ↑ 也会翻历史；草稿保留在浏览状态里，↓ 到底或 Esc 就回来了。
6. **mock 模式**（`RENDERER_VITE_SESSIONS_MOCK=1`）现在按会话档位决定脚本里那次 bash 是否审批：mock 的 orchestrator 是 full，默认不再演示审批条，切到全程审批 / 自动接受编辑后才有。
7. **顺带发现、没有修的旧问题**（Task 17，范围外的逻辑）：`agentHost.setModel` 只在会话 `spawned` 时更新缓存的 spawn spec。worker 崩溃后到重启完成之间换的模型，会被重建时缓存的旧模型盖掉，记录与实际不一致，直到下次重新 spawn。审批档位这边已按「有 spec 就改」处理并加了用例；setModel 是一行的改动，建议另开卡。
8. 新增的 worker 日志 `session <id>: approval mode <mode>` 方便事后查某个会话什么时候放开了权限；觉得多余可以去掉（supervisor 里一行）。
