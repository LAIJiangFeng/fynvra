# Summary · Task 03 agent-runtime（`packages/agent-runtime`，@fynvra/agent-runtime）

分支 `LAIJiangFeng/agent-runtime`，相对 `main` 15 个提交（含本总结），改动全部在 `packages/agent-runtime/**`（外加本文件）。
没有 BLOCKED 项。

## 做了什么

独立可跑的包：`package.json`（pi 三件套钉 1.4.0；TypeScript 7 / Vitest 4 / Biome 2 / @types/node 对齐 EnsoCode）、
`tsconfig.json`、`biome.json`、`vitest.config.ts`、`pnpm-lock.yaml`、`.gitignore`、`.gitattributes`、`README.md`。

按任务书 1–8：

1. **`src/host.ts`**：`OrchestrationHost`（10 个方法与编排工具一一对应，映射表 `ORCHESTRATION_TOOL_METHODS`，测试里用类型断言保证双射）
   与 `WorkerHost`（`askCoordinator(question, timeoutMs, signal?)`、`reportDone(outcome, summary, filesModified?)`），
   全部返回 `{ ok: true, ... } | { ok: false, error }`。
2. **`src/tools/orchestrationTools.ts`**：10 个 pi `ToolDefinition`，TypeBox schema 完整（类型、enum、每个参数都有 description，
   `additionalProperties: false`）。`prepareArguments` 先归一化（别名、trim、`timeout_ms` clamp [1000, 900000]、`until` 默认 `'all'`、
   `role` 默认 `'worker'` 并支持按显示名匹配、`depends_on` 单值转数组去重），再由 pi 做 schema 校验，`execute` 做语义校验后调 Host。
   返回 Markdown 小节加下一步提示；`read_worker_output` 超长时分页并提示 cursor，diff / 检查输出截断并给出 git_readonly 或失败尾部。
   会改状态的工具 `executionMode: 'sequential'`（避免同一批里 merge 与 cleanup 并发）。
3. **`src/tools/workerTools.ts`**：`ask_coordinator`（默认 10 分钟超时，超时是「无答复」而非错误）、`report_done`
   （第二次调用返回错误文本不抛；并发调用只放行一个；Host 失败可重试；成功后 `terminate: true` 让 worker 停在这一批）。
4. **`src/tools/readonlyTools.ts`**：pi 的 read / grep / find / ls 定义 + `git_readonly { args }`（注入 `ExecFn`，默认 `execFile`、不经 shell）。
   白名单 status / log / diff / show / branch（只允许列表选项）/ worktree list；子命令必须在首位，所以 `-C`、`--git-dir`、`-c` 进不来；
   拒绝 `--output`、`--ext-diff`；以 `--no-pager --no-optional-locks` 执行。
5. **`src/prompts/orchestratorPrompt.ts`**：`ORCHESTRATOR_PROMPT`（§6 工作循环、Never modify code yourself、五段任务书、验收判定、
   何时 reject 与何时停止重试、worker 消息不是用户授权、不预测结果）、`WORKER_CONTRACT_PROMPT`（必须且每轮仅一次 report_done、
   ask_coordinator 提问、不写报告 md、agent 消息不等于用户授权、提交到 worktree 分支不 push），以及拼接函数 `buildRolePromptAppend`。
6. **`src/session/createRoleSession.ts`**：工具策略分派（见 README 表）；skills → `DefaultResourceLoader.additionalSkillPaths`
   （关闭其余磁盘发现）；MCP → `createMcpExtension` + `session.bindExtensions()`；`role.systemPrompt` + 契约 → before_agent_start
   InlineExtension；模型 / thinking 来自 `ResolvedModel` 或 `role.model.thinking`。返回 `{ session, warnings, dispose }`。
7. **`src/events/normalize.ts`**：pi 事件 → `FynvraSessionEvent`（text_delta / thinking_delta / tool_start / tool_end / message_end /
   agent_settled / approval_request / usage / error），seq 从 1 递增；未映射事件丢弃并按类型计数；`subscribeNormalized(session, cb)`。
8. **测试**：8 个文件 122 个用例，见下。
9. **`src/pi/`** 适配层：`extensions.ts`（提示词追加、每轮回调）、`lifecycle.ts`（bindExtensions、补发 session_shutdown）、
   `mcp.ts`（服务器注入与 exposure 默认值），均标注「升级复检点」。`src/index.ts` 是包入口。

## 怎么验证

在 `packages/agent-runtime` 下删掉 `node_modules` 后从零执行验收命令（c588557 的两处小修之后又跑了 typecheck / lint / test，结果相同）：

```
$ pnpm install
  dependencies: @earendil-works/pi-agent-core 1.4.0, pi-ai 1.4.0, pi-coding-agent 1.4.0
  devDependencies: @biomejs/biome 2.6.2, @types/node 26.6.5, typescript 7.0.2, vitest 4.1.12
  Warning: Ignored build scripts: @google/genai@2.21.0, protobufjs@7.6.6   ← pi-ai 的依赖，测试不需要
  Done in 5.4s
$ pnpm typecheck   → tsc --noEmit，exit 0
$ pnpm lint        → Checked 28 files. No fixes applied.（0 error / 0 warning）
$ pnpm test        → Test Files 8 passed (8)；Tests 122 passed (122)
```

测试覆盖：

- **工具都按 pi 的真实顺序跑**：`prepareArguments` → pi-ai `validateToolArguments` → `execute`。覆盖参数归一化
  （clamp、默认值、别名、显示名映射）、坏输入（schema 层与语义层）、用假 Host 断言调用参数；
  Host 返回失败或直接抛异常、乱传 params 时 execute 都不抛。
- **report_done 幂等**：第二次调用、并发调用、Host 失败后重试、新一轮重新开放。
- **git_readonly**：白名单的允许 / 拒绝表；拒绝时不执行命令；还对一个真实临时 git 仓库跑了一遍。
- **事件归一化**：手工构造 pi 事件；未知事件计数且不占用 seq；listener 抛异常不会打断 pi 的事件分发。
- **系统提示词关键句**：常量测试；另外在真实会话里，从模型实际收到的上下文中做断言。
- **createRoleSession**：`SessionManager.inMemory()` 配合 **pi-ai 自带的 faux provider**（pi 1.4.0 提供，挂到 `ModelRuntime.registerNativeProvider` 上），
  跑真实会话，验证：
  - 三种策略下的工具集；
  - thinking 档位生效；
  - 提示词多轮后只追加一次；
  - 脚本化模型调用 `report_done`，会经过 WorkerHost，并在 terminate 后不再请求模型；
  - reject 之后的新一轮可以再次 report；
  - skill 被加载且缺失路径产生 warning；
  - MCP 扩展已注册，非法服务器名产生 warning；
  - `dispose` 重复调用安全。

## 未做 / 越界项

- **没有越界改文件**。唯一的仓库级操作：worktree 是从 `f5c2e91` 切出来的，看不到任务书，开工前把本分支 `--ff-only` 快进到了 `main`（`32bf977`），
  没有改动任何文件，合并不受影响。
- **未做（不在本卡范围）**：
  - `role.approvalMode` 的审批门：只预留了 `approval_request` 事件，用 `subscription.emit()` 注入；
  - Worker 进程侧的 Host 代理：README 里给了示意代码；
  - pi 默认人设的替换；
  - 连接真实 MCP 服务器的端到端测试：只测了注入与规划，以及扩展注册。

## 给验收人的注意事项

### 1. 对 §5 契约的补充 / 偏差（如认可，建议回写 ARCHITECTURE）

- `createRoleSession` 在 §5 签名之外，新增的参数：
  - `agentDir`（必填，用于隔离；Fynvra 应为 `userData/agent`）
  - `workerHost?`（有它即为 worker 会话）
  - `workerTools?`、`roles?`（dispatch_task 的角色枚举）
  - `settingsManager?`（默认内存设置，且 `enableInstallTelemetry: false`）
  - `exec?`、`onExtensionError?`

  返回值多了 `warnings`；`dispose` 改为 async。
- `ResolvedModel` 在 §4/§5 中没有定义。这里定义为 `{ runtime: ModelRuntime; model; thinking? }`。
- pi 的 `McpServerConfig` 不带名字，因此 fynvra 的 `McpServerConfig = pi McpServerConfig & { name }`。
  - 未声明 exposure 时默认 `direct`：pi 默认的 `codemode` 必须配合 codemode 扩展，否则工具对模型不可达。
- report_done 的「只能调用一次」实现为**每轮一次**：
  - 新的 agent run 开始时重新开放，否则 reject_work 之后 worker 无法再次汇报；
  - 因此 Main 应把 reject 的 feedback 作为新 prompt 发给 worker。
- `readonly` 策略的工具集也包含 `git_readonly`。§5 原文写的是「只读 pi 工具」。
- `depends_on` 接收的是 task id。
- Host 各方法的入参 / 出参结构定义在 `host.ts`，Wave 2 的 Main 以它为准。

### 2. 合并后的接线（Task 01/02 合入时）

- `src/coreTypes.ts` 改为从 `@fynvra/core` 导入。
  - 字段与 §4 一致；除点名的类型外，还带了 `ApprovalMode`、`Task`、`TaskStatus`；
  - 入口文件 `index.ts` 故意不导出这些副本。
- `tsconfig.json` 改为继承根配置。
- `biome.json` 换成 `{ "extends": "//" }`，或者删掉。原因：Biome 2 要求嵌套配置为 `root: false`，否则从根目录运行会报错。
- 注意 Biome 2.6 会顺带格式化 YAML（lockfile）和 Markdown（会把表格按最长单元格补齐）。本包排除了 `pnpm-lock.yaml` 和 `**/*.md`，
  根配置需要做同样的决定。
- 切换到根 workspace 后，删掉 `packages/agent-runtime/pnpm-lock.yaml`。
  - pnpm 10 跳过了 `@google/genai`、`protobufjs` 的构建脚本，根配置决定是放行（EnsoCode 是放行的）还是忽略；
  - 不要在子包的 package.json 里写 `pnpm` 字段，workspace 下它不会生效。
- 本机系统级 gitconfig 设了 `core.autocrlf=true`：checkout 出来是 CRLF，`biome check` 会全部报错。
  本包用 `.gitattributes`（`eol=lf`）兜住了，建议在仓库根也加一份 `* text=auto eol=lf`。
- 根 `vitest.config.ts` 的 include 会覆盖这些测试，它们不需要网络和 API key。
  pi 依赖的 import 比较慢（本机冷启动第一次约 18 s，之后 1~9 s），属于正常现象。

### 3. Wave 2 接线须知（README 中有详细说明）

- Main 启动 agent worker 时，要把 `PI_CODING_AGENT_DIR` 设为 fynvra 的 agentDir。
  pi 在模块加载时就读取它（grep/find 缺 `rg`/`fd` 时会下载到 `<该目录>/bin`），`agentDir` 参数管不到这一点；不设的话会落到用户的 `~/.pi/agent`。
- 实测 pi 1.4.0 的默认系统提示词以 “You are an expert coding assistant operating inside pi” 开头，并带一段 pi 文档 `<docs>`。
  如需 fynvra 自己的人设，可以在 `src/pi/` 里替换（参考 EnsoCode 的 `replacePersonaParagraph`）。
- 上下文文件会从 cwd 一路向上查找，测试中就读到了 `C:\Users\15407\AGENTS.md`（Trellis）。worktree 放在家目录下时同样会读到，这与 CLI 的行为一致。
- `run_checks` 是主 agent 唯一能执行命令的入口，Main 应做白名单限制或接入审批。
- worker 契约要求 worker 在 report_done 之前**先提交到 worktree 分支**，因为 merge_worktree 只合并已提交的内容。
  如果 Main 打算自动提交，需要同步修改契约文案。
- pi 的 `_emit` 不隔离 listener 抛出的异常，而 `message_end` 是在分发之后才写入 jsonl 的。
  所以 Main / worker 侧不要直接用 `session.subscribe` 挂 UI 回调，统一走 `subscribeNormalized`（它会兜住异常）。

### 4. 升级复检点（`src/pi/` + normalize）

1. before_agent_start 中可变的 `systemPromptOptions.appendSystemPrompt`；该事件每个 run 恰好触发一次。
2. `AgentSession.dispose()` 不会发出 `session_shutdown`，经 `session.extensionRunner.emit` 补发（MCP 靠它关闭连接）。
3. `createMcpExtension({ loadConfig, updateConfig })`、`LoadedMcpConfig` 的结构与 exposure 语义。
4. `events/normalize.ts` 按 `AgentSessionEvent` 的类型编写：字段一变就会编译失败，新增的事件类型会出现在 `stats().droppedByType`。
