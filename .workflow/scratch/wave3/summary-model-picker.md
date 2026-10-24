# Summary · Task 17 model-picker（会话级模型 / 思考档位选择器：新建时可选、中途可切）

分支 `LAIJiangFeng/model-picker`。worktree 建在 `f5c2e91`（Initial commit）上，开工时先 `git merge --ff-only main` 快进到 `main@54e26f4`，在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`（没有产生改动），再 `pnpm install --frozen-lockfile`。写总结时 `main` 前进到 `b9dffb7`（只多了 Task 18 任务卡，纯文档），`git merge-tree --write-tree main HEAD` 无冲突。

相对 `54e26f4` 有 12 个提交，涉及 39 个文件（+3303 / −127），另有本总结的 `docs(wave3)` 提交。12 个提交都带 `Co-Authored-By: Claude Opus 5.5`。没有 push，也没有建 PR。没有 BLOCKED 项。范围外改了两个文件：`src/shared/types/settings.ts`（及测试）和 `docs/ARCHITECTURE.md`，理由见「未做 / 越界项」。

## 做了什么

| 提交 | 内容 |
|---|---|
| `d068b47` feat(shared) | `chat.ts`：`SessionModelRef`（`SessionSummary.model` 加 `thinking?`）、`ModelThinkingCapability` / `ModelOption(s)`、档位规则 `pickThinkingLevel`；`agent.ts`：`set-model`、进程级 `describe-models` / `models-described`、`ResolvedModelSpec.reasoning`，以及对应的 parser |
| `b139786` feat(shared) | `settings.ts`：`preferences.lastModelByWorkspace`（**范围外**，见下） |
| `dcba8d4` feat(agent) | `models.ts`：按 pi 目录给出每个模型的档位（`describe`），`resolve` 按同一条规则定档位；同 id 同协议时优先官方 provider 的目录条目（顺带修掉的问题，见第 2 节）；目录外的模型看设置里的 reasoning 标记 |
| `7442409` feat(agent) | supervisor 处理 `set-model`（排在 opening 之后，失败时关掉会话并报 fatal）与 `describe-models`；piSession 调 pi 的 `setModel` / `setThinkingLevel` |
| `64581db` feat(main) | sessions.json 保留 `thinking`；`lastModels.ts`：经 SettingsFile 读写 `lastModelByWorkspace` |
| `96bd6f2` feat(main) | agentHost：`setModel`、`modelOptions`（带缓存与超时的 worker 查询）、spec 带 reasoning 标记、create 存档位、派发的 worker 会话继承主 agent 的模型 |
| `d31445c` feat(main) | `sessions:set-model`、`sessions:model-options` 通道与 handler（严格收窄） |
| `fb421f0` feat(preload) | `window.fynvra.sessions.setModel / modelOptions` |
| `0357df2` feat(renderer) | sessions store：乐观换模型与回滚、可选模型、选择器开关；`modelChoice.ts` 纯函数；mock API 补齐 |
| `021fdb7` feat(renderer) | `ModelPicker`（输入框胶囊）、`StatusBar`（模型名可点）、`NewSessionButton`（模型 + 档位）、`ui/popover` |
| `2daaf0a` feat(agent) | worker 在 spawn 与每次换模型后记一条日志：模型与请求地址（不含 key） |
| `fb7d0cb` docs | ARCHITECTURE §5 / §9.2 / §9.3 / §9.5 回写本卡的契约（**范围外**，见下） |

### 思考档位规则（验收人补充要求）

**规则**：

- **可选档位由 pi 内置模型目录决定**。用的是 pi 自己的 `getSupportedThinkingLevels(model)`：读模型的 `reasoning` 与 `thinkingLevelMap`，映射为 `null` 的档位不可选，`xhigh` 要显式映射才可选。
  - 结果只保留 fynvra `ThinkingLevel` 里有的档位。pi 还有 `max`，`packages/core` 不在范围内，没有加。
- **模型的默认档位**：pi 新会话的默认值 `medium` 按模型能力 clamp。下表的模型都是 `medium`。
- **不支持推理的模型 `thinkingLevels: []`**，界面不显示档位控件。
- **自定义 OpenAI 兼容服务**：pi 目录里没有的模型，是否推理看设置里模型条目的 `ModelEntry.reasoning`。标了 `reasoning: true` 时取 pi 对「推理、无映射」模型的默认集合：off / minimal / low / medium / high。
  - 目录里有的模型以目录为准，标记改不了它的能力。
- **`sessions:model-options` 给每个模型返回 `thinkingLevels`**（外加 `defaultThinking`），前端只渲染这个数组。
- **切换模型时**，当前档位在新模型的集合里就沿用；不在就回落到新模型的默认档位（`pickThinkingLevel`）。
  - Renderer：选择器与新建弹层里换模型，用 `chooseModel`。
  - worker：spawn / set-model 时用 `models.ts` 的 `resolve` 定档位。worker 定下的档位就是 pi 实际用的档位，不会被 pi 自己就近 clamp。

**本机 pi 1.4.0 目录给出的结果**（`src/agent/models.test.ts` 用真实目录断言）：

| 模型 | 可选档位 |
|---|---|
| claude-opus-5-5 / claude-sonnet-5-5 | low / medium / high / xhigh（目录里 off、minimal 映射为 null） |
| claude-haiku-5-5 | off / low / medium / high / xhigh |
| claude-fable-5-1 | minimal / low / medium / high / xhigh |
| claude-opus-4-5（无映射的老模型） | off / minimal / low / medium / high |
| gpt-5.5、gpt-6-sol | off / low / medium / high / xhigh（官方 openai 条目的 off 映射为 `none`） |
| gpt-6.1-sol、gpt-6-astra | low / medium / high / xhigh |
| gemini-pro-latest、gemini-4-argon | low / medium / high |
| gemini-flash-latest | minimal / low / medium / high |
| gpt-4.1 等非推理模型 | 无（不显示控件） |

**与补充要求字面的差异，请确认**：补充要求写「Anthropic 推理模型给 off / minimal / low / medium / high / xhigh」。

- 在 pi 1.4.0 目录里，这六档只对 claude-opus-4-7 / 4-8 / 5、claude-sonnet-5 这类模型成立。
- 设置页 Anthropic 模板里的 5.5 系列和 fable-5-1 并没有全部六档，例如 opus 5.5 不能关掉思考：目录把 off 映射为 null，选了 off，pi 也会 clamp 成 low。
- 我按第一条「以 pi 内置模型目录为准」实现。如果确实要给 Anthropic 固定六档，需要另外决定怎么处理 pi 不接受的档位。

**规则写进了哪些测试**：

- `chat.test.ts`：`pickThinkingLevel`。档位在集合里就保留，不在就回落到默认；无推理时没有档位；默认档位缺失时取最低档。
- `models.test.ts`：上表；目录优先于标记；**`describe` 给出的档位与注册后 pi 接受的档位逐个模型相等**；`resolve` 把 opus 5.5 的 off 定为 medium。
- `modelChoice.test.ts`：换模型时的回落；默认值也按规则落定。
- `agentHost.test.ts`：model-options 带每个模型的档位；reasoning 标记进入 spawn spec。
- `agent.test.ts`：协议拒绝未知档位、拒绝不在集合里的默认档位。
- `piSession*.test.ts`：pi 收到的就是定好的档位。
- 真机冒烟：Fable 5.1 的「最少」切到 gpt-6-astra 后回落为「中」。

### 1. 协议（`src/shared/types/agent.ts`）

- `set-model { identity, model: ResolvedModelSpec }`：spec 与 `spawn-session` 相同。
- `describe-models { requestId, models: ModelQuery[] }`（Main → worker）与 `models-described { requestId, result }`（worker → Main）都是**进程级**消息，不带 identity。
  - 原因：可选档位要以 pi 目录为准，而 **Main 不加载 pi**（构建产物 `out/main/index.js` 里 `@earendil-works` 仍为 0 处）。
- parser 的检查：档位必须是 fynvra 认识的，不能重复，`defaultThinking` 必须在集合里；失败结果必须带 error。
- `ResolvedModelSpec.reasoning?`：设置里模型条目的标记，只对目录外的模型生效。

### 2. Worker（`src/agent/`）

- **`models.ts`**：
  - `describe(query)` 与 `resolve(spec)` 用同一份定义：目录模板（`reasoning`、`thinkingLevelMap`）或 spec 的标记。这样界面列出的档位就是 pi 接受的档位，有逐模型的测试钉住。
  - **顺带修掉的问题**：原来的模板查找取 pi 目录里第一个「同 id 同协议」的条目，provider 按字母序排列。gpt-5.5（openai-responses）因此取到了 `cloudflare-ai-gateway` 的条目：1M 上下文、cacheRead 价格为 0、没有 off。
  - 现在每个协议的官方 provider 优先（anthropic / openai / google），找不到才取第一个。gpt-5.5 回到 272k 上下文、官方价格和 off（与设置页模板一致）。变异验证：去掉这条优先规则，2 个用例失败。
- **`supervisor.ts`**：
  - `set-model` 接在会话的 opening promise 上，排在之前到达的命令之后；紧跟着的 prompt 一定用新模型（有用例：切换很慢时 prompt 会等它）。
  - 切换失败时，worker 里的会话已经与 Main 的记录（新模型）对不上了：关闭会话，报 fatal `session-error`，Main 下次使用前按记录重新 spawn。
  - 切换成功会把 error 状态清回 idle。
  - Main 只在空闲时发 set-model。万一与回合撞上，照样切换，并记一条 warn。
  - `describe-models` 总会回答，出错时回 error 结果，Main 不必等到超时。
- **`piSession.ts`**：
  - `setModel` 先经 `models.ts` 注册 provider 并设 key，再调 pi `session.setModel(model)`，最后 `setThinkingLevel(定好的档位)`。
  - pi 会在 jsonl 里写 `model_change`，历史保留。
  - 会话没有自己的档位时，取角色的 `model.thinking`，与 spawn 时 `createRoleSession` 的回落顺序相同。
  - 没有在 `packages/agent-runtime` 加 `setSessionModel`：pi 的 `setModel` / `setThinkingLevel` 是公开 API，`piSession.ts` 本来就直接用 pi 的会话对象，不需要再包一层。
- **`index.ts`**：spawn 后和每次切换后，记一条 `[agent] session <id>: <api> <模型> thinking=<档位> → <请求地址>`。地址只保留 origin + path（去掉 userinfo 与 query），不写 key。

### 3. Main

- **`agentHost.setModel`**：
  - **会话运行中、等审批或 prompt 在途时拒绝**，返回「会话正在运行，等本轮结束再切换模型」。解析之后会再查一次，因为解析期间可能开始了新一轮；这一点有用例，也做了变异验证。
  - 用 `createModelResolver().resolve` 解析。**失败时返回它的可读错误**（服务不存在 / 已停用 / 没有该模型 / 没填 key），记录、worker 和广播都不动。
  - 成功时：
    - 更新记录并落 sessions.json，error 状态回到 idle，广播 `sessions:changed`；
    - 会话已在 worker 里时发 `set-model`，同时更新缓存的 spawn spec，这样崩溃重启后仍是新模型（变异验证：去掉这一行，1 例失败）；
    - 用户自己建的会话写入 `lastModelByWorkspace`。
- **`agentHost.modelOptions`**：
  - 只列启用、有 key、且至少有一个模型的服务，不带 key 和地址（用例断言了这一点）。
  - 每个模型的档位通过 `describe-models` 问 worker，结果按（协议, 模型 id, reasoning 标记）缓存。pi 目录随 worker 固定，第二次打开不会再问。
  - worker 超时（15 s）、回答 error 或崩溃时，返回可读错误，不会挂住。
- **create**：存下选的档位；没选模型时用角色的模型和档位。
- **launcher**（任务书第 5 条）：
  - `createWorkerSession` 用角色的 `model`；角色没配时，继承 orchestrator 会话当前的模型与档位，经已有的 `coordinatorOf` 反查。
  - 只改了 `agentHost.ts`，**没有动 `src/main/services/orchestration/**`**。
- spawn spec 和 set-model spec 都带设置里模型条目的 `reasoning` 标记。来源是新注入的 `providers`，即 providers store 的脱敏视图。
- `ipc/sessions.ts`：两个新通道，入参严格收窄：只接受 id 引用，带 baseUrl / apiKey / 未知档位 / 路径形状的会话 id 都拒绝。

### 4. Renderer

- **新建会话弹层**：角色列表下面是「模型」下拉（按服务分组）和「思考档位」（只列这个模型的档位）。
  - 默认值优先级：角色的 `model` → 该工作区上一次用过的 → 列表第一个。引用的服务已停用或模型已删除时跳到下一项。
  - 用户选过模型或档位之后，就不再跟着角色变。
- **`ModelPicker`**：输入框左下角的胶囊，显示「服务 · 模型 · 档位」。
  - 点开是可搜索的列表：按服务名、模型名或 id 搜索，Enter 选第一项。下面是当前模型自己的档位。
  - 选模型时，档位按规则落定；运行中不能切换，并给出提示。
  - 挂载时读一次可选模型，之后每次打开重读。
- **`StatusBar`**：右下的模型名改为按钮，打开同一个选择器（store 的 `modelPickerFor`）。显示的是会话当前的模型，所以切换后立刻变成 B；原来显示的是 usage 事件里的模型，要等下一条回复才会变。
- **store**：`setSessionModel` 乐观更新，失败时回滚、提示并重拉列表。在途时，列表刷新不会把模型改回去。连续切换时只认最后一次回包。

## 怎么验证

**基线**（`54e26f4`）：typecheck 通过，lint 检查 323 个文件，test 102 个文件 / 1424 个用例全过。

**验收命令**（最终提交，根目录）：

```
pnpm typecheck  → exit 0（node / web / packages 三段）
pnpm lint       → exit 0：Checked 331 files … No fixes applied.
pnpm test       → exit 0：Test Files 106 passed (106)；Tests 1526 passed (1526)
pnpm build      → exit 0：out/main/index.js 282.46 kB、out/main/chunks/index-<hash>.js（worker）122.14 kB、out/preload/index.cjs 11.85 kB、out/renderer/…
                  out/main/index.js 里 @earendil-works 出现 0 次
```

**新增 / 改动的用例**（+102 = 1526 − 1424，含 `it.each` 表行）：

| 文件 | 覆盖 |
|---|---|
| `shared/types/agent.test.ts` | 新消息的合法样本与坏输入表（任务书第 6 条「parser 坏输入」），未知字段剥离 |
| `shared/types/chat.test.ts`（新） | `pickThinkingLevel` |
| `shared/types/settings.test.ts` | `lastModelByWorkspace` 的收窄（含 `__proto__` 键），`settings:update` 不接受它 |
| `agent/models.test.ts` | 真实 pi 目录：每个模型的档位、官方条目优先、目录优先于标记、describe 与 pi 接受的档位一致、resolve 定档位 |
| `agent/supervisor.test.ts` | set-model 的顺序 / 慢切换 / 失败报 fatal / 过期 generation / 与回合撞上 / 清 error；describe 的成功与失败 |
| `agent/piSession.test.ts` | **假 pi session**：`setModel` → pi `setModel` 再 `setThinkingLevel`、角色档位回落、无推理不设档位、注册失败不碰 pi、模型日志钩子（任务书第 6 条「worker 侧收到 set-model 调用 pi（假 session 断言）」） |
| `agent/piSession.model.test.ts`（新） | **真实 pi 会话**（faux provider）：切换后下一次请求打到新模型、带新档位，历史保留，jsonl 记下切换 |
| `main/services/agentHost/agentHost.test.ts` | **running 时拒绝**（含 prompt 在途、解析期间开始新一轮）、**解析失败不改记录**、未 spawn / 已 spawn 两条切换路径、崩溃重启沿用新模型、model-options（过滤、缓存、超时 / 错误 / 崩溃）、create 带档位、角色回落、reasoning 标记、launcher 继承 |
| `main/services/agentHost/roundTrip.test.ts` | 真实 AgentHost ⇄ 两端 parser ⇄ 真实 SessionSupervisor：describe-models 与 set-model 往返 |
| `main/services/sessions/{sessionStore,lastModels}.test.ts` | thinking 落盘与收窄；lastModelByWorkspace 读写（只存 id 引用） |
| `main/ipc/sessions.test.ts` | 两个通道的转发与 12 条坏入参 |
| `preload/domains/sessions.test.ts` | 通道映射 |
| `renderer/stores/sessions/createSessionsStore.test.ts` | **乐观更新与回滚**、本地运行中拒绝、在途时列表刷新、可选模型（含晚到回包）、create 带模型、选择器开关 |
| `renderer/stores/sessions/modelChoice.test.ts`（新） | **默认值优先级纯函数**、换模型回落、生效档位、搜索、标签 |

**TDD 的实际顺序**（如实说明）：

- 先写测试、跑红、再实现：
  - 协议 parser：15 红；
  - `settings.ts`：2 红；
  - `models.ts`：6 红；
  - supervisor：9 红；
  - sessionStore：1 红；
  - agentHost：12 红；
  - IPC：13 红；
  - modelChoice：模块不存在；
  - store：8 红。
- 与实现同一轮写成，或写在实现之后的：
  - `lastModels.ts`；
  - piSession 的两个文件；
  - round-trip；
  - preload；
  - 模型日志钩子的用例。
- 变异验证（每处都已恢复，`git status` 干净）：
  - 去掉官方条目优先：2 例失败；
  - 去掉 setModel 解析后的再检查：1 例失败；
  - 去掉 spawn spec 的更新：1 例失败。

**真机冒烟**（`pnpm dev`，用本机已导入的服务，隔离的 userData）：

- **准备**：
  - 新 worktree 里没有 Electron 二进制，先执行 `node node_modules/electron/install.js`（用本机缓存，没有联网）。
  - 在 `%TEMP%\fynvra-model-smoke-4OFJpd` 下建了一个临时 git 仓库，和一个 userData：settings.json 登记这个工作区；providers.json 从 `%APPDATA%\fynvra-dev` **只复制两个服务**：
    - A = `claude-code`：anthropic-messages，`https://74.82.222.79`，模型 `claude-fable-5-1`；
    - B = `codex`：openai-responses，`http://localhost:8080`，模型 `gpt-6-astra`。
  - 本机的 `sub2api`（`192.168.1.28:8080`）连不上，没有用。
- **启动**：从 PowerShell 执行 `pnpm exec electron-vite dev --remoteDebuggingPort 9351 '--' --disable-backgrounding-occluded-windows …`。
- **驱动**：脚本经 CDP 点真实界面，结论来自 DOM、IPC 返回值和磁盘，不截图。
- 结果全部通过（`report.json` 留在上述目录）：
  1. 新建弹层选 Worker：默认模型是列表第一个「Claude Code · Fable 5.1」，档位只有「最少 / 低 / 中 / 高 / 最高」（没有「关闭」），默认「中」。
  2. 选「最少」后创建，记录为 `{claude-code, claude-fable-5-1, minimal}`；胶囊显示「Claude Code · Fable 5.1 · 最少」。
  3. 发出「请只回复一个词：苹果」，回复「苹果」。
  4. **点状态栏的模型名打开选择器**，搜索 astra，点 gpt-6-astra：
     - 胶囊变为「Codex · gpt-6-astra · 中」：astra 没有 minimal，回落到它的默认档位；
     - **状态栏变为「gpt-6-astra · 中」**；
     - 选择器里 astra 的档位是「低 / 中 / 高 / 最高」。
  5. 发出「请只回复一个词：香蕉」，回复「香蕉」。
  6. 第三条消息运行中调用 `sessions.setModel`，返回 `{ ok: false, error: "会话正在运行，等本轮结束再切换模型" }`，记录不变。
  7. **sessions.json** 中该会话的 model 是 `{codex, gpt-6-astra, medium}`；settings.json 的 `lastModelByWorkspace` 也是它。
  8. **pi jsonl**：
     - 三条回复：第一条是 `anthropic-messages / claude-fable-5-1`（运行时 provider `fynvra-4b47db…`），后两条是 `openai-responses / gpt-6-astra`（`fynvra-a24751…`）；
     - 切换记录依次为 model_change fable、thinking minimal、model_change astra、thinking low、thinking medium。
     - thinking low 是 pi `setModel` 自己就近 clamp 的结果，紧接着被 worker 显式设成规则定下的 medium。
  9. **worker 日志**：两次请求打到不同的 baseUrl：
     ```
     [agent] session 2bbcded4-…: anthropic-messages claude-fable-5-1 thinking=minimal → https://74.82.222.79/
     [agent] session 2bbcded4-…: openai-responses gpt-6-astra thinking=medium → http://localhost:8080/
     ```
  10. **key**：
      - Renderer 拿到的 list / model-options / history 结果里，以及 dev 日志里，都没有任何 key（脚本只输出布尔值）；
      - 除 providers.json 外，临时目录里没有任何文件含 key；`agent/auth.json` 为 `{}`；
      - **providers.json 副本已删除**。
  11. 经 IPC 关窗后，dev 以 exit 0 退出，没有残留的 electron 进程，日志里没有 error 或 warning。

## 未做 / 越界项

- **范围外改动 1：`src/shared/types/settings.ts`（及测试）**
  - 任务书第 2 条要求把上次用的模型存进 settings.json 的 `preferences.lastModelByWorkspace`，但 `parseSettings` 在每次读写时都会丢掉未知的 preferences 键，所以字段必须加进 `Preferences`。
  - 只加了这个字段的收窄（逐条丢弃非法项，键为 `__proto__` 时仍是自有属性）。`settings:update` 照旧拒绝它，只有 Main 写。
- **范围外改动 2：`docs/ARCHITECTURE.md`**
  - 文档头写明「改动契约必须先改本文」，所以回写了 §5 / §9.2 / §9.3 / §9.5。
- **与任务书字面不同的地方**（都是补充要求带来的）：
  - `sessions:model-options` 的结果里没有顶层 `thinkingLevels`，每个模型也没有 `reasoning`，取而代之的是每个模型的 `thinkingLevels` / `defaultThinking`，避免前端绕开 pi 目录、按原始标记渲染；
  - 另加了 `lastUsed`，这是入参 `workspaceId` 的用途。
- **没有动的范围内文件**：
  - `src/preload/types.ts`：它已经指向领域文件的 `SessionsApi`，不需要改；
  - `packages/agent-runtime`：不需要 `setSessionModel` 适配，见第 2 节；
  - `src/main/services/orchestration/**`：继承逻辑在 agentHost 的 launcher 里完成。
- **新加的内容**：worker 的模型日志（第 2 节）。这是任务书第 7 条「worker 日志显示两次请求打到不同 baseUrl」需要的，之前的日志里没有地址。
- **没有做**：
  - 设置页给模型条目手动标 reasoning 的开关，见注意事项 1；
  - pi 的 `max` 档位，因为 core 不在范围内。
- 用户全局说明里的知识库检索（`maestro spec` / `maestro wiki`）本机不可用：没有 `maestro` 命令，`~/.maestro/workflows/coding-philosophy.md` 也不存在，与前几张卡相同。

## 给验收人的注意事项

1. **自定义服务的 reasoning 标记目前只能手改 providers.json**。
   - 规则已经生效：条目上的 `reasoning: true` 会让该模型出现 off / minimal / low / medium / high 五档，worker 也按推理模型注册。
   - 但设置页的模型列表只显示「推理」徽标，没有开关，任务书写了「不要动 settings 页」。从本机 Claude Code / Codex / CC Switch 导入的条目也不会设这个标记。
   - `providers:upsert` 已经接受 `reasoning`，补一个开关是 ProviderDialog 里模型行的一个小改动，建议另开卡。
2. **设置页角色编辑器的「思考档位」仍是统一六档**（settings 页，不在范围内）。
   - 现在运行时由 worker 按模型落定：角色配了模型不支持的档位，会回落到该模型的默认档位，不再是 pi 的就近 clamp。
   - 想让角色编辑器也只列模型自己的档位，可以复用 `sessions:model-options`。
3. **官方目录条目优先会改变已有会话的模型参数**（第 2 节）。
   - OpenAI 模型的上下文从网关条目的 1M 变为官方的 272k，压缩会更早触发，这才是官方 API 的实际值；
   - cacheRead 有了价格，gpt-5.5 / gpt-6-sol 多了「关闭」档。
4. **切换模型的失败路径**：worker 里切换失败时会关闭该会话并报 fatal，时间线出现一条 host 错误；记录保持新模型，下一次 prompt 按记录重新 spawn，问题会在那里再暴露一次。
5. **`lastModelByWorkspace` 的写入时机**：只在用户新建会话和切换模型时写，orchestrator 派发的 worker 会话不写。写入后**不广播** `settings:changed`：Renderer 通过 `sessions:model-options` 的 `lastUsed` 读取，设置 store 的 `partialize` 只回写 theme / sidePanelOpen，不会覆盖它。
6. **worker 日志会写 baseUrl 的 origin + path**（如 `https://74.82.222.79/`）。如果端点地址也算敏感，可以只留 host 或去掉这行。
7. **冒烟临时目录** `%TEMP%\fynvra-model-smoke-4OFJpd`：留着脚本、`dev.log`、`report.json`，以及隔离 userData 里的会话记录（含三条测试对话）。providers.json 副本已删，可以整个删掉。
