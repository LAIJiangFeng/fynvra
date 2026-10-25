# Summary · Task 24 notifications（桌面通知：回合完成、worker 完成、需要审批 / 提问）

分支 `LAIJiangFeng/notifications`。worktree 建在 `f5c2e91`（Initial commit）上：开工时 `git merge --ff-only main` 快进到 `3777730`，在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`（没有产生改动），再 `pnpm install --frozen-lockfile`；真机冒烟前 `node node_modules/electron/install.js` 补了 Electron 二进制。写总结时 `main` 已前进到 `918a0e8`（只多了 Task 28 的任务书），`git merge-tree --write-tree main HEAD` 退出码 0。

相对 `3777730` 有 8 个提交（30 个文件，+2347 / −7），另有本总结的 `docs(wave4)` 提交。每个提交都带 `Co-Authored-By: Claude Opus 5.5`，没有 push，没有建 PR。没有 BLOCKED 项。越界改动 4 处，都是接线或测试需要，见「未做 / 越界项」。

## 做了什么

| 提交 | 内容 |
|---|---|
| `8a6f553` | `feat(shared)`：`Preferences.notifications`（`// --- notifications ---` 块）：`{ enabled, mainAgentOnly, askAndApproval, sound }`，默认全开；`notificationPreferencesOf` 取生效值；`parsePreferences` 宽松收窄（逐项默认、丢未知键），`parsePreferencesPatch` 只收四项齐全的布尔值（`settings:update` 整块替换） |
| `9ebb02f` | `feat(main)`：agent host 加 `observe(observer)`（推给 Renderer 的 `sessions:event` / `sessions:approval-request` 原样抄送，观察者抛异常只记日志）和 `get(sessionId)`；只在两处既有广播之后加调用，不改逻辑 |
| `0e4d975` | `feat(main)`：编排服务加 `onMessagePosted`（messages 表每插入一行即每次 `Inbox.post`），注册表加 `onMessage(listener)` 带工作区 id 扇出；从快照恢复的消息不触发 |
| `ef3618f` | `feat(main)`：`services/notifications/` 的纯逻辑：`rules.ts`（事件 → 候选、开关映射、聚焦抑制、正文摘录）、`coalesce.ts`（同一会话 2 秒合并）、`notifier.ts`（启动 5 秒静默、开关前后各查一次） |
| `b0e9031` | `feat(main)`：`notifications:test` / `notifications:set-viewing` 两个通道与 `sessions:focus` 推送；`ipc/notifications.ts` 接上 agent host 与收件箱；`desktop.ts` 弹 Electron `Notification`、点击还原聚焦窗口并推 `sessions:focus`；preload 领域文件 + `index.ts` / `types.ts` 各一行 |
| `1fc1e64` | `feat(renderer)`：设置「通知」页（放在「通用」之后）与它的 store |
| `d96d566` | `feat(renderer)`：点了通知切到会话所在工作区并选中会话；屏幕上正看着的会话报给 Main |
| `836c94d` | `fix(renderer)`：启动时先报一次正看着的会话（页面重新加载后 Main 记着的还是旧的） |

### 什么时候弹、弹什么

「主 agent」= 没有 `dispatchId` 的会话：Orchestrator，以及用户直接对话的任何会话。worker = 编排派出的会话。

| 来源 | 事件 | 受哪个开关管 | 标题 | 正文 | 点开 |
|---|---|---|---|---|---|
| 主 agent | 一轮结束（`agent_settled`，没出错、没中止） | 总开关 | 会话标题 | 这一轮最后一条有文字的 assistant 消息前 80 字；一轮没文字时「完成」 | 该会话 |
| 主 agent | `error` | 总开关 | `会话标题 · 出错` | 错误信息前 80 字 | 该会话 |
| worker | 收件箱 `worker_done`（succeeded / 追加汇报同理） | 总开关 +「仅主 agent 完成」关掉时 | `worker 标题 · 完成` | 汇报前 80 字 | worker 会话 |
| worker | `worker_done`（failed）/ worker 会话 `error` | 同上 | `· 失败` / `· 出错` | 汇报 / 错误 | worker 会话 |
| worker | `question` | 「提问与审批」 | `· 提问` | 问题 | worker 会话 |
| worker 或 Fynvra | `escalation` | 「提问与审批」 | `· 上报` | 正文 | 发送方是会话时为它，否则（Fynvra 自己上报）主 agent 会话 |
| 任何会话 | 审批请求 | 「提问与审批」 | `会话标题 · 待审批` | `工具：命令或路径` | 该会话 |

不弹：中止的一轮（用户停止、会话被删、崩溃时先到的 error 照弹）、worker 自己的一轮结束（看 `worker_done`）、reply / instruction / heartbeat。正文压成一行，去掉行首的 `#` / `>` / 列表符号和 `` ` `` / `**`，按字符截断（不拆 emoji）。

- **聚焦抑制**：窗口聚焦且正看着该会话时不弹。「正看着」由 Renderer 经 `notifications:set-viewing` 报告（`activeSessionId`；设置视图盖住时报 `null`），Main 按窗口（webContents id）记；看别的会话、最小化、切到别的应用都照弹。
- **合并**：同一会话 2 秒窗口（从第一条起算，不随后来者顺延）只弹最后一条。开关在进窗口前先筛一次（被关掉的通知不能顶替能弹的），窗口结束时再按当时的开关、聚焦状态与声音决定。
- **启动静默**：Main 注册通知后 5 秒内的事件丢弃，不补发。
- **出错的一轮**：`error` 立刻弹「出错」，这一轮结束时不再弹完成；回合外的错误（如启动会话失败）不影响下一轮的完成通知。
- **测试通知**：标题「Fynvra」、正文「测试通知」，不看聚焦、静默期与开关（界面上总开关关着时按钮不可用），声音按设置；系统不支持时返回「系统不支持桌面通知」。

### 设置页「通知」

| 控件 | 文案 | 悬停 |
|---|---|---|
| 开关 | 桌面通知 | — |
| 开关 | 仅主 agent 完成 | worker 的完成与失败不弹 |
| 开关 | 提问与审批 | worker 提问、上报与审批请求 |
| 开关 | 声音 | — |
| 按钮 | 发送测试通知 | — |

总开关关掉时其余三个开关与测试按钮不可用（标签变灰）。没有页内说明、没有分组标题（页头已经是「通知」）。读取中「读取中…」，失败「读取失败：…」，保存失败行内红字并换回原值。settings.json 里的形状：`"notifications": { "enabled": true, "mainAgentOnly": true, "askAndApproval": true, "sound": true }`，没有这一块时按默认值。

### 接线

- Main：`registerNotificationHandlers()`（`ipc/index.ts` 加一行）建 notifier，订阅 `getAgentHost().observe(...)` 与 `getOrchestrationRegistry().onMessage(...)`，每次决定时现读 `settings.json` 的开关，退出时丢掉还没弹的。
- Electron：`new Notification({ title, body, silent: !sound })`；弹过的通知留引用（最多 50 个，关闭后也不放），对象被 GC 后点击不再触发，留着在通知中心里点也能回到会话。点击：还原（最小化时）、`show()`、`focus()`，再推 `sessions:focus { sessionId, workspaceId }`。
- Renderer：`stores/sessions/index.ts` 订阅 `onFocusSession`：先 `setWorkspace(工作区)`、再 `select(工作区)`、关设置视图、`selectSession(会话)`。顺序有讲究：侧栏随后把选中的工作区同步给会话 store 时已经是同一个，不会因为那个工作区的列表还没读过而清掉选中。

## 怎么验证

**基线**（`3777730`）：typecheck 0；lint 0（379 个文件）；test 127 个文件 / 1852 个用例全过。

**验收命令**（最终提交 `836c94d`，根目录）：

```
pnpm typecheck  → exit 0（node / web / packages 三段）
pnpm lint       → exit 0：Checked 396 files … No fixes applied.
pnpm test       → exit 0：Test Files 136 passed (136)；Tests 1925 passed (1925)
pnpm build      → exit 0：out/main/index.js 350.81 kB、out/main/chunks/index-<hash>.js（worker）130.83 kB、
                  out/preload/index.cjs 14.66 kB、out/renderer/assets/index-<hash>.js 2,539.45 kB；
                  out/main/index.js 里 @earendil-works 出现 0 次
```

**用例变化**（+73 = 1925 − 1852，9 个新文件）：

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `shared/types/settings.notifications.test.ts` | 18 | 默认值（冻结、取生效值是副本）；收窄：没有这一块不加字段、逐项默认、非对象整块丢弃、原型污染键；patch：四项齐全才收、缺项 / 类型不符 / 未知键 / `__proto__` 拒绝 |
| `main/services/agentHost/observe.test.ts` | 4 | 观察者拿到与 `sessions:event` 相同的事件（顺序、seq）；审批请求与推给审批条的相同；`get` 返回 IPC 视图、删除后 undefined；取消订阅；抛异常的观察者记日志、不挡其他观察者与推送 |
| `main/services/orchestration/onMessage.test.ts` | 3 | question / worker_done 带工作区 id 送达（之后才打开的服务也算）；取消订阅、抛异常只记日志且投递仍成功；快照恢复的消息不重放 |
| `main/services/notifications/rules.test.ts` | 21 | 各开关组合下允许哪些种类；聚焦抑制四种情况；摘录（压行、80 字、emoji、Markdown）；回合跟踪（完成、无文字、出错后不弹完成且下一轮照常、回合外错误、中止、崩溃、worker、多会话交错）；审批；收件箱四类消息与不弹的类型 |
| `main/services/notifications/coalesce.test.ts` | 4 | 窗口从第一条起算只发最后一条、不顺延；不同 key 独立；发出后开新窗口；clear |
| `main/services/notifications/notifier.test.ts` | 9 | 合并窗口结束才弹、带声音与点击目标；启动 5 秒静默不补发；同会话合并 / 不同会话各弹；被关掉的不顶替能弹的；窗口结束时按当时设置与声音；聚焦抑制按弹出那一刻；两个开关分别管哪些；只为关心的事件查会话；clear 与弹出失败只记日志 |
| `main/ipc/notifications.test.ts` | 7 | 通道都注册；test 无参、带参拒绝、声音、系统不支持；set-viewing 只收 `{ sessionId: id \| null }`（9 种非法形状）；聚焦窗口看着的会话不弹、别的照弹、审批与上报；点击还原聚焦并推 `sessions:focus`；退出丢弃 |
| `preload/domains/notifications.test.ts` | 2 | 方法映射到通道、只传 id；`onFocusSession` 只交出两个 id，形状不对的推送丢弃 |
| `renderer/stores/createNotificationSettingsStore.test.ts` | 5 | 读取（默认 / 已配置 / 失败）；乐观更新整块发送、以 Main 回包为准；失败换回、没读到前不发；连着改只认最后一次回包；test 透传、抛异常折成 `{ ok: false }` |

`preload/index.test.ts` 的领域清单加了 `notifications` 一行。

**TDD 顺序**：settings 收窄（5 红）、agent host 钩子（4 红）、编排钩子（3 红）、合并器（模块不存在，红）、notifier（红）、IPC（7 红）、渲染层 store（5 红）都是先写测试跑红再实现。`rules.test.ts` 也是先于 `rules.ts` 写的，但没有单独跑红（模块不存在必然失败）；preload 领域测试是在领域文件之后补的；`preload/index.test.ts` 是加了领域之后跑红再改。设置页组件靠 typecheck / lint / build 与下面的渲染冒烟。

**渲染冒烟**（临时 `zz-smoke` 文件，跑完即删，没有提交）：`react-dom/server` 渲染 `NotificationSettings` 四种状态：全开时四个 `role=switch` 都 `aria-checked="true"`，只有「仅主 agent 完成」「提问与审批」两行带 `title`，按钮可用；总开关关时其余三个 `aria-disabled="true"`、标签变灰、按钮 `disabled`、错误行 `role="alert"`；读取中「读取中…」；失败「读取失败：读不到」。

**真机（Windows 11，`pnpm dev`）**：隔离的 userData（`FYNVRA_USER_DATA_DIR`）里登记两个临时 git 仓库 `repo-a` / `repo-b` 为两个工作区；模型是本机 `127.0.0.1` 上的假 Anthropic SSE 端点（沿用 Task 22 的 mock，回答「ok: <问题首行>」），经 `providers.upsert` 注册；dev 带 `--remoteDebuggingPort` / `--inspect` 与不节流开关。Renderer 侧经 CDP 操作真实界面与 IPC；Main inspector 只做四件事：包一层 `Notification.prototype.show` 记下交给系统的通知（真实通知照弹）、最小化窗口、对通知对象 `emit('click')`、第 1 轮里临时替换 `getFocusedWindow` 模拟聚焦。不截屏。

| 轮次 | 场景 | 结果 |
|---|---|---|
| 1 | 侧栏选 repo-a、看着会话 A，（模拟）窗口聚焦，A 回答一句 | 不弹 ✅ |
| 1 | **最小化窗口**，repo-b 的会话 B 回答一句 | 弹 1 条：标题「通知冒烟：请回答一句」（会话标题）、正文「ok: 通知冒烟：请回答一句」、有声音；Notification `show` 事件触发、没有 `failed` ✅ |
| 1 | 点这条通知 | 窗口还原、可见、`isFocused()` 为 true；侧栏切到 repo-b，聊天区标题是 B ✅（会话行高亮的断言写错了，见下） |
| 1 | 设置：导航顺序 | 通用、通知、模型服务、角色、技能、MCP、外观 ✅ |
| 1 | 设置「通知」页 | 四个开关默认全开，悬停提示只在两行 ✅ |
| 1 | 点「声音」开关 | settings.json 写入 `{ "enabled": true, "mainAgentOnly": true, "askAndApproval": true, "sound": false }` ✅ |
| 1 | 点「发送测试通知」 | 立刻弹「Fynvra / 测试通知」，静音 ✅ |
| 1 | 设置视图盖着会话 B，（模拟）聚焦，B 回答 | 照弹（静音）✅ |
| 1 | 点「桌面通知」关掉 | 其余开关与测试按钮不可用；最小化后 B 回答不弹 ✅ |
| 2 | 新 userData（声音预设关），看着 repo-a 的 A，最小化，B 回答 | 弹 1 条静音通知，`show` 触发 ✅ |
| 2 | 点通知 | 窗口还原；**OS 真的给了焦点**（`getFocusedWindow()` 非空）✅ |
| 2 | 真聚焦（不再模拟）、正看着 B，B 再回答 | 不弹 ✅ |
| 2 | 真聚焦但 A 不在屏幕上，A 回答 | 弹「聚焦冒烟：另一个工作区」✅ |
| 3 | 同一进程：切回 repo-a 看 A，最小化，B 回答 → 点通知 | 214 ms 内聊天区标题是 B、侧栏 `aria-current` 是 repo-b 与 B 那一行 ✅ |

- **Windows 通知中心里确实有这些通知**：用 Windows PowerShell 5.1 的 WinRT `ToastNotificationManager.History.GetHistory(<AUMID>)`（dev 下 AUMID 是 electron.exe 的路径）读到 6 条，与 Main 记下的一一对应；第一条没有 `audio silent`（有声音），其余 5 条 `silent="true"`。冒烟结束后用 `History.Clear(<AUMID>)` 清掉了这些测试通知（只有这个 worktree 的 electron.exe 名下的），dev 与 mock 进程都已结束。
- 第 1、2 轮报告里各有一条 FAIL，都是断言写错，不是功能问题：第 1 轮按 `startsWith(标题)` 找会话行，但行文本以状态点的「空闲」开头；第 2 轮在聊天区标题刚变成 B 的那一刻读侧栏，而侧栏会话行是 react-virtuoso 虚拟列表，晚一帧才插入。现场探针随后读到 B 那一行 `aria-current="true"`；第 3 轮改成「标题、工作区、会话行三者同时成立」再等，通过。
- Renderer 控制台三轮都没有 error / warning，dev 日志里没有报错。
- 冒烟脚本在 `%TEMP%\fynvra-t24-8dffa0\scripts\`（`drive.mjs`、`drive-click*.mjs`、`mock.mjs`、`toast-history.ps1`、`toast-clear.ps1`、`probe.mjs`），报告在同目录的 `smoke\report*.json`。

**提交前扫描**：30 个改动文件没有不可见字符（BOM / 零宽 / U+2028 / U+2029 / NBSP / CR），`git ls-files --eol` 全是 `i/lf w/lf`。

## 未做 / 越界项

**越界改动（都写在提交信息里）**

1. `src/main/ipc/index.ts`：一行 import + 一行 `registerNotificationHandlers()`。新增 IPC 领域按 ARCHITECTURE §7 / §9.1 要在这里注册。
2. `src/preload/index.test.ts`：领域清单加 `notifications` 一行（这个测试断言 `window.fynvra` 的全部领域）。
3. 新文件 `src/renderer/stores/createNotificationSettingsStore.ts`（及测试）：`stores/settings.ts` 在模块顶层读 `window.fynvra`，而 `typecheck:node` 包含 `src/renderer/**/*.test.ts`，测试一 import 它（哪怕只是 `typeof import`）就报 `Cannot find name 'window'`。照 `createSettingsStore.ts` 的先例把工厂放进不读 window 的同目录文件，`stores/settings.ts` 只建应用内实例与 `settings:changed` 订阅（自己的 `// --- notifications ---` 块）。
4. `src/renderer/stores/sessions/index.ts`：任务书允许加一行订阅；实际是两处订阅（点通知切会话、报告正看着的会话）加两个 import（`stores/workspaces`、`components/settings/settingsViewStore`）。理由：跨工作区切会话必须同时改侧栏的工作区（否则侧栏同步时会把选中清掉）；「正看着该会话时不弹」需要 Main 知道屏幕上是哪个会话，任务书没列通道，所以加了 `notifications:set-viewing`，并且设置视图盖住时报 `null`（看设置页时照弹，同 EnsoCode）。`settingsViewStore` 是纯 zustand store，没有循环依赖。

**没做**

- 没有物理点击系统通知：点击是对 Main 里那条通知对象 `emit('click')`，走的是 Electron 收到真实点击时调用的同一个处理函数；Windows 把点击交给 Electron 这一段没有自动化验证。建议验收时手点一次（最小化窗口，让会话回答一句，点右下角的通知）。
- macOS / Linux 没有验证。macOS 未签名的 dev 版系统可能静默丢弃通知（EnsoCode 用 osascript 兜底），这里没做。
- 没有窗口时（macOS 关掉全部窗口后）点通知只会无事发生：重建窗口的 `showMainWindow` 在 `src/main/index.ts`，不在范围内。
- Main 的通知文案是中文常量，留给 Task 27（i18n）。
- 用户全局说明里的知识库检索（`maestro spec` / `maestro wiki`）本机不可用：没有 `maestro` 命令，`~/.maestro` 也不存在，与前几张卡相同。

## 给验收人的注意事项

1. **与 Task 25 / 26 的合并冲突点**：`src/shared/types/settings.ts`（`Preferences` 末尾、`parsePreferences` 的返回对象末尾、`parsePreferencesPatch` 的 switch）、`SettingsView.tsx` 的 `SECTIONS` 与 `settingsViewStore.ts` 的 `SETTINGS_SECTIONS`（Task 25 加「快捷键」）、`stores/settings.ts` 文件末尾（各自的块）、`agentHost.ts` 的 `AgentHostService` 接口与返回对象末尾（我加了 `get` / `observe`，Task 26 若改 `list` 也可能挨着）。都是相邻插入，两边都保留即可。测试都放在独立文件里，不会和 `settings.test.ts` 等冲突。
2. **`Preferences.notifications` 是可选字段**：没配置过的 settings.json 原样读出（已有的 `parsePreferences` / `parseSettings` 用例不用改），读取一律用 `notificationPreferencesOf`。`createSettingsStore` 的 `partialize` 没动：主题 / 侧面板的写入只发这两个字段，不会覆盖通知设置；Task 25 / 26 若要经同一个 store 持久化自己的字段，需要自己改 `partialize`。
3. **`settings:update` 里的 notifications 必须整块发**（四项齐全），缺一项整个 patch 作废；设置页的 store 总是发整块。
4. **我做的几个取舍**：worker 会话自己的 `error` 算 worker 失败（受「仅主 agent 完成」管，任务书没单列）；`escalation` 归「提问与审批」；审批用 `approval-request`（ApprovalRequest 的标题与详情），不用同一请求的 `approval_request` 会话事件，免得一次审批算两条；合并是「窗口结束才弹」，每条通知最多晚 2 秒。
5. **默认设置下 worker 的提问也会弹**：主 agent 通常会自动回答 worker 的问题，提问通知可能偏多；嫌吵可以关「提问与审批」，或者以后把 question 挪到「仅主 agent 完成」下面（改 `rules.ts` 的 `allowedBy` 一行和对应用例）。
6. **新 worktree 起 `pnpm dev` 前**要先 `node node_modules/electron/install.js`（本机缓存，不联网）。
