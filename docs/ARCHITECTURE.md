# Fynvra 架构

> 本文是所有 agent 实现时的共同契约。改动契约必须先改本文。
> 架构以 Fynvra 的产品需求为边界，保持模块精简、职责清晰。

## 1. 技术栈

| 项 | 选择 |
|---|---|
| 桌面壳 | Electron 45 + electron-vite 6（main / preload / renderer 三段构建） |
| 语言 | TypeScript（strict），ESM（`"type": "module"`） |
| UI | React 19 + Tailwind 4（`@tailwindcss/vite`）+ `@base-ui/react` 封装成 shadcn 风格组件放 `src/renderer/components/ui/` + lucide-react |
| 状态 | Zustand 5（按字段订阅；会话正文用纯 reducer 归并） |
| Agent 运行时 | `@earendil-works/pi-coding-agent` 1.4.0 SDK（`createAgentSession`、`SessionManager`、`DefaultResourceLoader`、`InlineExtension`、`createMcpExtension`） |
| 工具链 | pnpm 10 workspace、Biome 2（2 空格、单引号、分号、宽 100）、Vitest 4、tsc `--noEmit` |
| 持久化 | `userData/settings.json`（元数据）、`userData/roles/*.json`、`userData/agent/sessions/*.jsonl`（pi 会话，权威源）、`userData/orchestration/<workspaceId>.json`（每个工作区一个编排快照） |

## 2. 目录布局

```
fynvra/
  package.json  pnpm-workspace.yaml  electron.vite.config.ts  biome.json  vitest.config.ts
  tsconfig.json  tsconfig.node.json  tsconfig.web.json  electron-builder.yml
  src/
    main/        Electron 主进程：index.ts、ipc/<domain>.ts、services/、windows/
    preload/     index.ts（contextBridge 暴露 typed API）、types.ts
    renderer/    React：index.html、App.tsx、components/、stores/、hooks/、lib/、styles/
    shared/      纯类型与纯函数（无 Node/Electron import），含 types/ipc.ts
    agent/       Agent worker 入口（utilityProcess），封装 pi SDK
  packages/
    core/            纯 TS 领域库（无 Electron）：角色、编排状态机、git worktree、消息收件箱
    agent-runtime/   纯 Node 库：pi SDK 封装、fynvra 工具（orchestration 工具、worker 工具）、事件归一化
  docs/            PRODUCT.md、ARCHITECTURE.md
  .workflow/       本地开发任务与验收记录（已忽略，不纳入版本控制）
```

包名：根 `fynvra`，`@fynvra/core`，`@fynvra/agent-runtime`。renderer 通过 Vite alias `@` → `src/renderer`，`@shared` → `src/shared`，`@fynvra/core` → `packages/core/src/index.ts`（源码直接打包）。

两个 `packages/*` 包各自有 `package.json`（`"type": "module"`、`main: src/index.ts`、`types: src/index.ts`），`tsconfig.json` 继承根配置，测试文件与源码同目录（`*.test.ts`）。根 `vitest.config.ts` 的 include 要覆盖 `src/**` 与 `packages/*/src/**`。

## 3. 进程模型

```
Renderer(React) ⇄ preload(typed API) ⇄ Main(ipc/*, services/*) ⇄ Agent Worker(utilityProcess, src/agent)
                                                                     └─ pi AgentSession × N（每个会话一个）
```

- 工具审批（本次行为变更）：恢复 Main 与 Worker 的真实人工审批执行链和三档权限语义；只有用户答复才能放行需审批的操作，通知不是执行授权。参数校验、角色工具白名单、路径边界、编排权限、Stop / abort 与真正的 `ask_coordinator` 提问保持独立执行。
- 必改层：agent-runtime 审批门与会话接线、core / shared 类型与 unknown parser、supervisor 与 Main agentHost 请求生命周期、Main notifications 与双语文案、Renderer 会话内审批和权限档位。只移除 App 顶部跨会话的全局审批横幅及其详情弹窗（ApprovalAttention），保留会话内确认和 OS 桌面审批通知。不改 Magic Context 压缩策略（回退见 §7.8）、Fast、模型配置、任务审查合并或灰字建议算法，保留 freshAttempt 取消与互等保护、压缩错误延迟结算修复。
- Main 是权威：settings、roles、workspaces、orchestration 状态、worktree 注册表都在 Main 持久化。
- 一个 Agent Worker 进程托管多个 pi 会话。Main ⇄ Worker 走 `parentPort` 消息，协议是 tagged union `AgentCommand` / `AgentWorkerEvent`，每条事件带 `identity: { sessionId, generation }` 和递增 `seq`。
- Renderer 只持有投影；pi jsonl 是会话正文权威源。

## 4. 领域模型（`packages/core`，`@fynvra/core`）

```ts
// 角色
export type ApprovalMode = 'supervised' | 'auto-edits' | 'full';
export type ToolPolicy = 'all' | 'readonly' | 'orchestrator';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export interface Role {
  id: string;                 // slug；内置：'orchestrator' | 'worker'
  name: string;
  description?: string;
  builtin?: boolean;
  systemPrompt?: string;      // 在 before_agent_start 中追加到 pi 系统提示词后
  model?: { providerId: string; modelId: string; thinking?: ThinkingLevel };
  skillIds: string[];
  mcpServerIds: string[];
  tools: ToolPolicy;
  approvalMode: ApprovalMode;
}

// 工作区 & 会话
// vcs：git 仓库根目录为 'git'；不是 git 仓库（或没装 git）的目录、按普通目录挂入的仓库子目录为 'none'（没有默认分支）。
// 没有 vcs 的旧记录按 'git' 读。
export type WorkspaceVcs = 'git' | 'none';
export interface Workspace { id: string; name: string; repoPath: string; vcs: WorkspaceVcs; defaultBranch?: string; }
export interface SessionRef {
  id: string; workspaceId: string; roleId: string; cwd: string;
  worktreeId?: string; parentSessionId?: string;
}

// 编排：Run 是命名空间 + 收件箱；Task 是工作；Dispatch 是一次权威尝试
export type TaskStatus = 'todo' | 'in-progress' | 'in-review' | 'completed' | 'failed' | 'abandoned';
export interface Run { id: string; workspaceId: string; coordinatorSessionId: string; objective: string; createdAt: number; }
export interface Task {
  id: string; runId: string; title: string; spec: string; roleId: string; status: TaskStatus; dependsOn: string[];
  mergedDiff?: { baseCommit: string; headCommit: string }; // 合并时固定 worker 的差异范围，清理 worktree / 分支后仍可查看
}
export interface Dispatch {
  id: string; taskId: string; workerSessionId: string; worktreeId: string; branch: string;
  mode?: 'in-place';          // 工作区 vcs 为 none：worker 直接在工作区目录里干活，worktreeId / branch 为空串；缺省是 worktree 模式
  startedAt: number; settledAt?: number; outcome?: 'succeeded' | 'failed';
  summary?: string; filesModified?: string[];
}
export interface Worktree { id: string; workspaceId: string; path: string; branch: string; baseRef: string; baseCommit: string; }

// 收件箱消息（worker → coordinator，coordinator → worker）
export type MessageType = 'worker_done' | 'question' | 'reply' | 'escalation' | 'heartbeat' | 'instruction';
export interface Message {
  id: string; runId: string; dispatchId?: string; from: string; to: string;
  type: MessageType; subject?: string; body: string; replyTo?: string;
  createdAt: number; ackedAt?: number;
}
```

`packages/core` 提供：
- `roles/`：内置角色定义（`orchestrator`、`worker`）、`parseRole(unknown)` 校验收窄、`RoleStore` 接口 + 基于注入 fs 的 JSON 文件实现。
  - 内置角色是默认模板，不是只读配置。名称、描述、提示词、模型、工具策略、审批档位、Skills 和 MCP 均可通过现有 `roles:save` 保存到 `userData/roles/<id>.json`，提示词不进 `settings.json`。
  - 内置 id 固定、不可删除；`builtin` 身份按 id 判定，不信任文件或 IPC 的标记。`list/get` 优先读取完整覆盖配置，缺失或无效时使用默认模板并报告无效文件；内置角色始终排在前面且不重复。
  - 覆盖是完整角色快照，不把缺省字段重新与模板合并：用户可以清空参考提示词、技能、MCP 和模型。界面的「恢复默认」只还原草稿，保存后生效。
  - 新启动的会话读取保存后的角色；已经启动的会话不热替换资源、不强制重启。工具权限和编排/worker 协议仍由运行时执行，不因修改参考提示词而移除。
- `orchestration/`：`OrchestrationStore`（内存实现 + 可注入的 JSON 持久化）、状态迁移纯函数（task / dispatch 合法迁移表，非法迁移返回错误而不是抛异常）、`Inbox`（FIFO、ack、按类型过滤、`waitFor(predicate, timeoutMs)` Promise）。
- `git/`：`GitWorktreeManager`（注入 `exec(cmd, args, cwd)`）：`create({ repoPath, workspaceId, slug, baseRef, worktreesRoot })` → 分支 `fynvra/<slug>`（冲突加后缀），路径 `<worktreesRoot>/<workspaceId>/<slug>`；`status`（dirty / ahead / behind）；`diff(worktree, baseCommit?, headRef?)`（headRef 默认 HEAD）；`remove`；`prune`；`merge({ repoPath, branch })` 走 `--no-ff`，返回 `{ ok, conflicts?: string[] }`，冲突时自动 `merge --abort`；`deleteBranch`。
- `briefs/`：任务书模板渲染（Target / Change / Constraints / Ownership / Acceptance 五段 + `report_done` 契约段）。

## 5. Agent 运行时（`packages/agent-runtime`，`@fynvra/agent-runtime`）

- `createRoleSession(opts: CreateRoleSessionOptions): Promise<RoleSession>` → 根据角色创建 pi `AgentSession`：

  ```ts
  interface CreateRoleSessionOptions {
    role: Role;
    cwd: string;                        // orchestrator 为工作区仓库，worker 为它的 worktree
    model: ResolvedModel;
    sessionManager: SessionManager;
    host: OrchestrationHost | null;     // tools: 'orchestrator' 必须提供，其他策略传 null
    resourcePaths: { skills: string[]; mcpServers: McpServerConfig[] };
    agentDir: string;                   // 必填：pi 的 agentDir，Fynvra 用 userData/agent（与用户的 ~/.pi 隔离）
    workerHost?: WorkerHost | null;     // 提供即为 worker 会话
    workerTools?: WorkerToolsOptions;   // ask_coordinator 的等待上限 askTimeoutMs（默认 10 分钟）
    roles?: readonly RoleOption[];      // dispatch_task 可选的角色：role 参数的枚举与显示名匹配
    inPlace?: boolean;                  // 工作区没有 git（§6）：orchestrator 追加非 git 模式说明，worker 换用不提交的契约
    settingsManager?: SettingsManager;  // 默认内存设置（不读 ~/.pi 与项目 .pi），enableInstallTelemetry: false
    exec?: ExecFn;                      // git_readonly 的命令执行器，默认 child_process.execFile
    onExtensionError?: (error: ExtensionError) => void;
    extensions?: readonly InlineExtension[]; // Fynvra 受控的附加扩展（当前为 Magic Context）；不由设置或文件发现产生
    approval?: ApprovalPolicyHooks;     // 按 role.approvalMode 拦截 tool_call 的人工审批通道；不提供时需审批的调用一律拒绝
  }
  interface RoleSession {
    session: AgentSession;
    warnings: string[];                 // skill 路径缺失、MCP 服务器名非法等配置问题，供 Main 展示
    dispose(): Promise<void>;           // 先发 session_shutdown（关闭 MCP 连接）再释放；可重复调用
  }
  // Main 按会话记录（缺省按 role.model）解析；thinking 缺省取 role.model?.thinking，
  // worker 再按模型的可选档位落定（pickThinkingLevel：不在集合里就回落到模型的默认档位）
  interface ResolvedModel { runtime: ModelRuntime; model: Model<Api>; thinking?: ThinkingLevel }
  // pi 的 McpServerConfig 不带名字；未声明 exposure 时默认 'direct'（pi 默认的 'codemode' 需要额外扩展）
  type McpServerConfig = PiMcpServerConfig & { name: string };
  ```

  - `tools: 'orchestrator'` → `noTools: 'builtin'`，只注入只读工具（read / grep / find / ls + `git_readonly`）+ 编排工具；
  - `tools: 'readonly'` → 同样 `noTools: 'builtin'`，只注入只读工具（read / grep / find / ls + `git_readonly`）；`'all'` → pi 默认工具。
  - 传入 `workerHost` 时（不论哪种策略）再加 worker 工具，并追加 worker 契约提示词。
  - skills → `DefaultResourceLoader` 的 skill 路径；MCP → `createMcpExtension()`；`systemPrompt` → `before_agent_start` 追加扩展。
  - 审批门（`createApprovalGate`）：`supervised` 审批命令（bash / powershell / run_checks）、文件写改（write / edit / apply_patch）、MCP 工具；`auto-edits` 只审批命令与 MCP；`full` 放行普通操作。保护底线（`rm -rf`、`Remove-Item -Recurse`、`del /s`、`git push`、`git reset --hard`、包管理器 `publish`）任何档位都要人确认，`allowSession` 不豁免；10 分钟未答复、回合中止、通道缺失或断连按 deny，拒绝以可读文本作为工具结果返回模型。`allow` 放行一次；`allowSession` 按 kind + 工具名缓存，从 full 切回更严档位清空缓存；切档位不自动答复已有请求。
  - worker 先发 `approval-request`（kind / title / detail / expiresAt）给 Main 登记，再发 `approval_request` 会话事件；请求等待 `allow` / `allowSession` / `deny`。Main 校验 session / request id、generation、有效期与一次响应，维持 `waiting-approval` 并推送 `sessions:approval-request`；Stop、超时、结算、销毁时撤下请求，迟到 / 重复 / 旧 generation 答复不能执行工具。OS 桌面审批通知继续遵循 `askAndApproval` 偏好并按 request id 去重，不等待启动静默期或合并窗口，聚焦当前会话也提醒一次；点击只定位会话。
  - Renderer 保留会话内审批卡和三档权限选择，只移除 App 顶部跨会话全局审批横幅及其详情弹窗（ApprovalAttention）。`tool_notice` 仅保留历史解析兼容，新执行路径不以通知替代审批。持久化 `waiting-approval` 沿用重启后归 idle 的恢复规则（原 worker 已不存在），不重放未执行的旧工具；实时等待状态保持真实审批状态。源码修改不会热更新已安装应用或原进程里的待答复调用。
- 编排工具（仅 orchestrator 角色，pi `ToolDefinition`，参数 schema 完整类型，归一化先于校验）：
  `dispatch_task { title, spec, role?, depends_on?, model?, thinking?, fast? }`、`list_workers`、`wait_for_workers { timeout_ms, until: 'any' | 'all' }`、`read_worker_output { dispatch_id, cursor? }`、`send_to_worker { dispatch_id, body }`、`review_diff { dispatch_id }`、`run_checks { dispatch_id, command }`、`merge_worktree { dispatch_id }`、`reject_work { dispatch_id, feedback }`、`cleanup_worktree { dispatch_id, abandon? }`。
  工具不直接操作 git / 进程，而是调用注入的 `OrchestrationHost` 接口（由 Main 实现）。`OrchestrationHost` 的方法名与上述工具一一对应。
  `model` / `thinking` / `fast` 仅按用户明确要求设置，可同时指定；公开 Fast 参数为可选 boolean `fast`，归一化兼容 `fast_mode` / `fastMode`，拒绝字符串 / 数字 / null 强转。
  内部 `DispatchTaskInput` → `Task.fastMode?: boolean`（快照可选字段，旧记录兼容）→ Main launcher 保留 true / false / 缺省：true 请求开启，false 关闭继承，缺省保持角色 / 主会话 / 默认模型的原行为。排队与恢复启动沿用 Task，打回重试沿用保存的会话模型。
  agentHost 在显式 / 角色 / 主会话 / 默认模型落定后复用 `supportsFastMode` 过滤覆盖值，会话记录及 spawn spec 只带协议允许的 Fast；不支持时同模型正常启动，不改 provider、thinking 或审批。工具结果只展示 `fast requested`（true 为 `auto-if-supported`），不把 Task 请求冒充生效状态。
- worker 工具：`ask_coordinator { question }`（阻塞直到 reply 或超时，返回答复文本）、`report_done { outcome: 'succeeded' | 'failed', summary, files_modified? }`。本地 guard 每个真实 agent run 只允许成功报告一次，Main 每个 Dispatch 只结算一次，重复/并发报告及已被新尝试取代的旧报告均拒绝。`reject_work` 在写入任何新尝试 / 任务 / 指令之前同步检查 worker 是否阻塞于 `ask_coordinator`；若有待答问题，立即报错，要求先 `send_to_worker` 回答、待旧 run 结束后再打回，不能伪造答复或自动停止 worker。检查到新 attempt 插入之间不让出执行。`reject_work` 显式传 Main launcher 的 `{ freshAttempt: true, signal }`，反馈等待旧 run 真正 idle 后才作为新 prompt 发出；取消信号贯穿串行排队、idle 等待与投递，排队 / idle 等待可立即取消并移除 waiter / listener，等待前及 spawn 后发送前再次核验，取消后不得迟到投递。投递前取消 / 失败清理 instruction 与 pendingDispatches，仅回滚自己仍 current 且 in-progress 的新尝试，不覆盖并发结算 / 清理；实际投递后取消不撤销已开始的尝试。普通 `send_to_worker` 指令仍及时投递并返回，不等待 idle，以便协调者能回答 worker 随后提出的问题；pi 的 streaming `followUp` 会在旧 run 内消费，不保证重跑 `before_agent_start`，不能用它开启重试。WorkerHost 在 run 首次工具调用时绑定到固定 attempt（避开初始 Dispatch 尚未落库的窗口），直到下一次真实新 run 才重新绑定，旧调用不能结算新 attempt。
- Fast（会话级优先服务）：`SessionModelRef.fastMode` 随会话记录与 last-used 持久化，与 thinking 独立。piSession 在会话自己的
  `agent.onPayload` 上组合 `service_tier: 'priority'`（仅 `openai-responses` / `openai-completions`；保留扩展的 payload 变换），
  不改共享的 provider / model，因此并发会话互不影响；关闭或切到其他协议时不发送该字段。服务商可能拒绝或忽略该参数，标记只表示请求模式，
  不代表已确认实际服务档位；模型元数据没有更细的 Fast capability，沿用上述协议守卫，不硬编码型号名单。
  不增加自动降级重发逻辑，不吞掉服务商拒绝、凭据、网络或模型不存在等错误。
- 事件归一化：pi session 事件 → `FynvraSessionEvent`（`text_delta`、`thinking_delta`、`tool_start` / `tool_end`、`message_end`、`agent_settled`、`approval_request`、`usage`、`error`；宿主还可经同一 `emit()` 注入非阻塞 `warning`，`tool_notice` 仅保留历史解析兼容），每条带 `seq`。SDK `agent_end` / `compaction_end` 中可恢复的错误先暂存，直到真正 `agent_settled` 才发布尚未恢复的最终错误；中间恢复成功不把 Main / Renderer 锁在错误态，显式 aborted 不误判为同轮模型失败。

## 6. 主 agent 工作循环（产品核心）

1. 用户在 Orchestrator 会话输入需求。
2. 主 agent 调 `dispatch_task`（可多次、并行）→ Main：建 worktree（`fynvra/<slug>`）→ 新建 worker 会话（指定角色或 `worker`）→ 投递任务书（含 `report_done` 契约）。
3. 主 agent 结束回合，继续与用户对话（可再派发）；不阻塞等待。Main 的协调者唤醒器在收件箱出现
   `worker_done` / `question` / `escalation` 且主 agent 会话空闲时，把消息合成一条注入 prompt 唤醒它
   （与 `wait_for_workers` 的交付一样确认消息）；主 agent 忙碌时消息留在收件箱，回合结束后再投。
   `wait_for_workers` 仍可用，但只在需要显式阻塞等待时调用。期间 `question` 到达时用 `send_to_worker` 回答。
4. `worker_done` → 主 agent `review_diff` + `run_checks`（如 `pnpm typecheck && pnpm lint && pnpm test`）→ 判定：
   - 通过：`merge_worktree`（no-ff 合并到主 agent 所在分支）→ `cleanup_worktree` → 向用户汇报。
   - 不通过：`reject_work` 把意见发回 worker，回到 3。
5. 全部任务 settled 后向用户给出每个任务的结果、证据、未解决项。

**验收与清理**：worker 汇报 succeeded 只将任务置于 `in-review`；只有 `merge_worktree` 验收后才是 `completed`，
包括经审查的只读 / 空改动任务（Git 可以无新增合并提交）。验收与清理要求当前 dispatch，旧尝试不能操作新的重试。
`cleanup_worktree` 默认只清理已验收或已放弃任务；未完成时无副作用地返回错误，提示验收、打回或显式 `abandon: true` 取消。
显式取消先记录 `abandoned`（已有汇报保留，进行中尝试结算为 failed），即使删除失败也保持取消状态，资源记录保留供重试。
`completed` 在任何清理路径上都不变；清理前检查干净且无新增未合并提交，以非强制删除目录和分支保护验收后的改动。
只有放弃的任务才强制丢弃 worktree / 分支；清理不自动验收或合并。无 worktree 记录的重复清理不按旧分支名删资源。

**当前对话的改动**：`orchestration:changes` 只接受 `{ workspaceId, sessionId? }`，拒绝其它键和路径；无会话时读工作区主目录，主 / 调度会话也读登记主目录，worker 仅读与 session / dispatch / worktree 登记一致的目录。Main 验证真实 Git root、common-dir 与 worktree 登记归属，读取实际 branch / HEAD，绝不启动 agent、切分支、写 index 或创建 worktree；目录已清理时只报告该来源不可用，不回退到主目录或其它任务。
未提交包含 staged / unstaged / untracked（内容读取有界且拒绝越界链接）；无 HEAD、detached HEAD 可读。worker 仍在登记分支时以登记 baseCommit 为基准；其它情况优先与默认分支 origin ref、其次本地 ref 的 merge-base 比较，没有不同基准时显示 HEAD 的最近一次提交（根提交比较空树），无 HEAD 则为空。返回实际比较范围及范围内至多 500 条提交，读取错误不能伪装成空结果。
右栏改动跟随当前工作区 / 会话，不依赖 run 或任务数；进入、会话切换和手动刷新重新读取。中央 diff 的来源区分当前目录与历史 dispatch，已打开标签始终绑定原来源；请求按来源去重，刷新使旧响应失效。任务抽屉可明确进入历史审查，切换对话后恢复当前来源。文件浏览和任务执行语义不变。

**改动的生命周期**：历史任务 `review_diff` 与明确的任务审查入口共用 Main 查询，在工作区主仓库读取提交差异，不依赖 worker 目录仍是 Git worktree。
合并时将创建基准和 worker 提交 SHA 写入 Task 的可选 `mergedDiff`，随编排快照保存；正常清理、归档清理、重启后仍读这对提交，
不拿主仓库当前 HEAD 代替 worker 提交。旧快照没有此字段时，沿用尚存的 worktree 基准与 worker 分支；两者已清理且无历史范围时明确报不可用。
此修复必改 core 的 `types.ts`、`orchestration/store.ts`、`git/GitWorktreeManager.ts`，Main 的 `orchestration/{host,queries,service}.ts`，
Renderer 的 `ChangesView.tsx` 及对应测试；IPC 入参、返回形状不变，不另存完整补丁，不修改 worktree 删除策略或文件管理功能。

**没有 git 的工作区（`vcs: 'none'`）**：编排原地进行，Main 不调用任何 git。
- 挂入：任意目录都能挂；git 仓库的子目录先问用户（改挂仓库根目录 / 仍然按普通目录挂入该子目录 / 取消）。
- `dispatch_task` 不建 worktree，worker 的 cwd 是工作区目录（并行的 worker 共用它，工具结果建议一次只派一个），
  Dispatch 记 `mode: 'in-place'`；`review_diff` 没有 diff，给出 worker 在 `report_done` 里汇报的改动文件；
  `run_checks` 在工作区目录里跑；`merge_worktree` 无需合并，把 in-review 的任务记为 completed；
  `cleanup_worktree` 只停 worker，状态规则与 Git 模式相同：未完成任务需显式 `abandon: true`，已完成任务保持 completed，改动留在目录里。
- 提示词：Main 在 spawn 时按工作区给 spawn spec 带 `inPlace: true`，orchestrator 在工具说明后追加非 git 模式一段，
  worker 换用不提交的契约（agent-runtime 的 `IN_PLACE_ORCHESTRATOR_PROMPT` / `IN_PLACE_WORKER_CONTRACT_PROMPT`）。

## 7. IPC 规则

- 新增 IPC 三件事必须同步：`src/shared/types/ipc.ts` 通道常量（`domain:action`）、`src/main/ipc/<domain>.ts` handler 并在 `ipc/index.ts` 注册、`src/preload/index.ts` 按领域暴露 typed API。
- 入参按 `unknown` 收窄；Renderer 只传 id 不传路径；返回 `{ ok, ... }` 不跨边界抛异常；不暴露通用 `invoke`。
- API key、MCP env 明文只在 Main。
- Main → Renderer 推送用 `sendToAllWindows`。

### 7.1 工作区文件浏览与编辑

- 侧栏工作区菜单支持「打开于」及复制路径 / 文件夹名称 / 当前 git 分支（detached HEAD 为短 sha），右键与省略号共用菜单。`workspaces:open-with-apps` 列出目标（可传 `{ refresh: true }` 刷新 VS Code 探测缓存）；`workspaces:open-in` 只接收 `{ workspaceId, appId }`；`workspaces:copy` 只接收 `{ workspaceId, what }`，Main 从注册表解析路径并启动应用或写剪贴板。
- `workspaces:pick-app` 由 Main 原生选择器签发自定义应用 id、路径与建议名称；`settings:update` 保存 / 移除 `preferences.openWithApps`（最多 20 项），新增或改路径须匹配本窗口已选择的应用，已存项可改名称。Renderer 通过重新选择修改路径，不传工作区路径或任意命令。Windows 仅接受自定义 `.exe`，VS Code 的 `code.cmd` 只用于定位真实 `Code.exe`；macOS `.app` 交给 `/usr/bin/open`；启动参数独立传递且禁用 shell。
- 此功能仅改 workspace IPC / Main 应用探测启动 helper、typed preload、settings 校验、侧栏菜单 / 自定义应用对话框 / Base UI 子菜单封装、中英文字典及测试；不改会话、文件编辑或终端能力。

- 右栏「文件」只展示目录树，与「任务 / 改动」并列；点击文件在中央工作区打开独立标签，与唯一不可关闭的「对话」标签并列，支持多开、切换和关闭。
- `files:list` 接收 `{ workspaceId, directoryId? }`，省略目录 id 时列出工作区根目录；`files:read` 接收 `{ workspaceId, fileId }`；`files:write` 接收 `{ workspaceId, fileId, version, text }`，版本是读取时的文件内容摘要。
- Main 根据工作区记录定位根目录，为列出的条目签发不透明 id；Renderer 只能回传这些 id，展示用相对路径不能作为访问参数。
- 每次读取重新校验真实路径位于登记的工作区内，拒绝跨工作区 id、失效条目及越界链接；符号链接只展示，不展开或预览。
- UTF-8 文本编辑最多 256 KiB，使用按需加载语言的 CodeMirror；Markdown 复用 GFM 渲染组件，支持编辑 / 预览 / 双栏；文件预览可呈现经 HTML 解析后白名单过滤的语义标签与对齐，不执行脚本或文档 CSS（聊天默认不解析 HTML）。相对图片按源文件目录在 Renderer 解析，通过所属工作区的 `files:list` 查找条目 id，再经 `files:read` 获取已校验的本地栅格图像；不传路径、不放宽 CSP，引用失败显示 alt。本地文档链接复用条目解析并在本工作区打开。PNG / JPEG / GIF / WebP 预览最多 2 MiB，其他二进制和超限文件显示说明。独立 HTML / SVG 文件仍仅按源码显示，不执行。
- Main 按文件串行保存，写前核对当前内容版本，冲突时保留磁盘与草稿；同目录临时文件写完后替换原文件。拒绝越界链接、二进制和超限写入；保留 UTF-8 BOM，编辑器沿用原文件的换行格式。
- 未保存草稿不被目录刷新覆盖；切换对话、文件、工作区或折叠右栏不丢草稿；关闭标签及退出窗口前确认，取消退出不停止 agent 服务。保存中的新输入不能被旧保存响应覆盖。
- 中央标签统一按工作区保存身份、类型、顺序和活动项；对话唯一不可关闭，文件 / diff / 终端可跨类型拖动混排，＋不参与排序。Main 在独立 `userData/workspace-ui/` 版本化文件中原子、串行保存，不写 `settings.json`。Renderer 完成 hydration 后才能写入，写入绑定窗口代际、租约与递增序号。
- 文件恢复仅由 Main 将已存相对路径重新绑定到原工作区条目 id，所有后续读写仍执行真实路径校验；草稿及原内容版本分别保存（单份 UTF-8 文本至多 256 KiB，超限拒绝并提示，不截断），外部修改仍触发版本冲突。保存 / 明确放弃同步推进快照，缺失文件保留可关闭提示与可复制草稿。diff 只存原 source / path 描述，正文按原会话或 dispatch 加载；聊天只存会话选择，正文仍以 pi jsonl 为权威。
- 正常退出在窗口销毁和 agent 停止前完成 Renderer flush / Main 落盘确认，允许保留草稿或明确放弃；取消或落盘失败不停止 agent。
- 目录树右键支持新建、重命名、副本、复制、显示位置及确认后移入回收站；操作仍由 Main 按条目 id 校验路径。新建在目标目录下显示行内输入，名称非空时失焦自动创建，空白名称失焦取消；也支持 Enter 确认、Escape 取消，不能因按键与失焦重复创建，失败保留名称并提示；显示位置等操作失败不可静默忽略。
- 本次文件操作修复仅涉及 Main `ipc/files.ts` 的事件/载荷签名、Renderer `FilesView.tsx` / `FileTreeContextMenu.tsx` 与文件 store 的新建目录加载，以及对应测试；沿用现有通道和 preload 类型，不引入文件管理依赖或永久删除能力。全链路回归运行 `pnpm build && node scripts/verify-files.cjs`，使用隔离 userData / 临时工作区，回收站只处理脚本生成的条目。

### 7.2 应用更新与发布

- Main 独占 `electron-updater`，Windows x64 和正式签名的 macOS x64 / arm64 安装版启动后及每 4 小时检查公开的 `LAIJiangFeng/fynvra` GitHub Releases，发现稳定新版本后自动下载。开发模式、Mac 手动安装版和未发布的平台明确显示原因，不请求更新源。
- `updates:state`、`updates:check`、`updates:install` 均无参，Renderer 不传版本、URL、路径或命令；`updates:changed` 只推送带递增序号的状态快照。更新源由打包配置固定，禁止降级和预发行版本。
- Renderer 的通用设置提供当前版本、检查按钮和进度；全局更新条在下载及下载完成时提醒。下载完成的状态不会被定时检查覆盖，失败可重试。
- 默认只后台下载，不强制重启、不在退出时偷偷安装。点击安装先确认，再走现有未保存文件确认、agent 关闭和编排落盘，最后调用安装器；取消退出回到待安装状态，不能提前停止服务。
- 发布工作流对 main push（包括 PR 合并）或 main 上的手动触发执行。检查通过后，以该提交和已有稳定版本标签计算下一版本，打包、校验安装文件与适用的更新元数据，全部上传到草稿 Release 后才公开。重跑不覆盖已公开的版本，不向 main 回写版本提交。
- 必改层：shared 更新快照与通道、Main 更新服务/退出接线、preload typed 出口、Renderer 更新状态/设置/提醒、electron-builder 与 GitHub Actions。不会修改 agent 协议、角色配置、文件编辑器，也不引入自建更新服务器或客户端 GitHub token。
- macOS 分别生成 x64 / arm64 的 DMG、ZIP；签名版还公布 ZIP blockmap 和汇总的 `latest-mac.yml`。两种模式都校验包的架构与文件完整性，正式签名模式额外校验 Apple 团队和公证票据；双架构文件和 Windows 产物全部校验通过后才公开同一 Release。
- macOS 原生更新器的安装错误可能延迟到窗口和 agent 关闭之后；此时必须提示错误并正常退出，不能留下无窗口进程。用户仅关闭 Mac 窗口不视为退出，不停止 agent 或安装更新。
- 无证书打包修正：main push（包含 PR 合并）或 main 手动触发都打包并发布下载文件。没有任何 Apple 凭证时生成 ad-hoc 签名的 Mac 手动安装包，不公证；凭证齐全时走 Developer ID 签名、公证，部分配置缺失时明确失败而不静默降级。
- Mac 包通过受 Main 读取的打包元数据区分手动安装与签名更新；手动版不请求更新源、不启用自动安装，界面说明须手动下载新版。手动版的公开产物不含 `latest-mac.yml` 或 ZIP blockmap，避免被签名版客户端误认作可自动安装更新；Windows 仍正常发布更新元数据。
- 此修正只涉及打包配置、发布脚本与工作流、Main 更新可用性判断、shared 原因枚举、现有更新提示文案和对应测试文档，不新增 IPC，不改变文件编辑、角色或 Agent 协议。

### 7.3 关闭窗口与运行时图标

- 用户关闭窗口（标题栏关闭按钮、系统关窗）由 Main 拦截，通过 `window:close-requested` 仅通知发起关窗的 Renderer，复用应用内 Dialog 显示「取消 / 最小化到托盘 / 退出」；不使用系统消息框。外观参照圆角卡片、灰色说明和右下角三按钮，跟随明暗主题；默认聚焦取消，Esc / 点击遮罩等同取消。
- Renderer 通过 `window:respond-close` 只回传 `cancel | tray | quit`，Main 收窄未知参数并绑定 IPC sender 的窗口；没有待处理关窗、窗口已销毁或正在退出时忽略迟到回答。操作失败保留弹窗并就地提示。最小化到托盘只隐藏窗口，不丢编辑草稿、不停止 agent；普通最小化按钮仍缩到任务栏。
- 托盘使用现有 Fynvra 图标，点击可恢复窗口，菜单提供显示窗口与退出；单实例唤醒和 macOS 激活也必须恢复隐藏窗口。真正退出仍先确认未保存文件，再等 agent 及编排收尾，并销毁托盘。
- 明确退出与更新安装绕过关窗选择，不重复弹出托盘选项；未保存确认取消后，后续用户关窗仍会询问。托盘创建失败时保持窗口可见并提示，不留下无法找回的隐藏窗口。
- 窗口、托盘及开发模式的 macOS Dock 复用 `resources/icon.png`，通过 electron-vite 资源导入包含在构建产物中；Windows 直接设置 Fynvra AppUserModelId，开发版与正式版分组隔离，不使用 Electron 默认身份。
- 应用内确认框改动限于 Main `windows/closeBehavior.ts` / `ipc/window.ts`、shared IPC / Main 字典、preload typed 出口、Renderer `CloseWindowDialog.tsx` / `App.tsx` 挂载点 / `ui/dialog.tsx` 遮罩样式参数 / 中英文字典和对应测试；不改图标、退出收尾或未保存确认机制，不新增持久化关闭偏好、图片生成或手机连接能力。`pnpm build && node scripts/verify-window.cjs` 使用临时数据点击真实 UI、记录明暗截图，验证托盘、窗口恢复、图标资源和退出收尾（仅未保存原生确认框由脚本代答）。

### 7.4 工作区内嵌终端

- 中央标签栏「＋ → 终端」创建真正的终端标签，与对话、文件并排；内容在应用内显示，不启动外部终端窗口。「＋ → 对话」复用新建会话流程。
- Main 用 node-pty 托管 PTY，Windows 默认启动 PowerShell（`-NoLogo -NoProfile`），其他平台启动登录 shell；cwd 从工作区 id 查注册表，创建终端的 IPC 不接收路径、shell 或环境变量。
- 通用设置的 `agentShell` / `terminalShell` 存 shell id 或自定义绝对路径；Main 检测可执行文件并通过 `settings:available-shells` 返回可选项与生效路径，`settings:pick-shell` 仅接收设置目标 id，由 Main 选择文件。终端选择失效时回到系统默认；显式选择 PowerShell 使用 `-NoLogo`（加载用户 profile），Git Bash 使用 `--login -i`，cmd / WSL / 非 PowerShell 自定义不附加参数。仅新终端生效。
- Windows 的 PowerShell 7 发现先检查 PATH 与常规 Program Files 安装；缺失时用系统 Windows PowerShell 无 profile、有超时地查询当前用户 `Microsoft.PowerShell` Appx 安装位置，再尝试 `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` 的无 profile 探测。执行别名可能可启动却无法通过 Node 文件校验，因此补探测返回安装目录中的真实 `pwsh.exe`，发现与后续选择仍使用同一文件校验；命令失败、坏输出或真实文件不可访问时保持未安装降级，不扫描全盘、不读取用户 profile / history、不改 PATH 或 shell 设置。
- Main 的终端专用 helper 按绝对可执行路径 basename 识别 PowerShell（含自定义路径、非 Windows 的 pwsh），在既有参数后追加 `-NoExit -EncodedCommand`，执行随 Main bundle 内嵌的固定脚本；保留默认 `-NoProfile` 与显式选择加载 profile 的语义，不切换 shell，不拼入 cwd / 用户输入，不向 PTY 假装键入启动命令。PSReadLine 支持时启用 `History` / `InlineView` 灰色历史预测；RightArrow 绑定原生 `ForwardChar`，由 PSReadLine 在编辑行尾接受预测、无预测或行中正常右移，不重复实现接受逻辑。LeftArrow 不注册 handler，保留原有行为；Tab、Ctrl+C、粘贴及外部程序输入沿用原生行为。
- 预测要求 PSReadLine 2.2+ 对应能力；默认 Windows PowerShell 5.1 常见的 2.0 模块不支持，启动时温和提示升级 PSReadLine 或在通用设置的终端 Shell 中选择带新版模块的 PowerShell 7，然后新开终端使用预测（旧终端不重启），普通终端与 Tab 仍可用。只配置本 app 新终端会话，不自动安装模块，不写 profile / ExecutionPolicy / 系统设置，不读取或另存用户历史；历史过滤与存储由 PSReadLine 管理。改动限于 Main 终端启动接线、终端 helper、相关测试和本节文档，不改 Renderer、IPC 契约或 agent shell 执行。
- Windows agent 默认依次探测 Git Bash → Windows PowerShell 5.1 → PowerShell 7；未安装 Git 时以警告日志说明 PowerShell 回退，保证无 git 工作区也能启动会话。只有三者均不可用时才报错，禁止交给 pi 自动选到 WSL。手写 `shellPath` 仍优先；否则按 `agentShell` 选择，失效时按上述默认顺序回退。pi 1.4 的 bash 工具通过 `spawn(shellPath, ['-c', command])` 执行（没有 shell args 设置，`shellCommandPrefix` 仅追加命令文本），故支持 Git Bash / PowerShell 7 / Windows PowerShell，不提供 cmd / WSL；自定义须兼容 `-c`。非 bash 的语法说明经既有 role systemPrompt 追加路径传给 pi，不改 pi 内部或角色持久化。仅下次启动会话生效，非 Windows 隐藏 agent 选项。
- `terminals:create|write|resize|close` 的入参按 unknown 校验，终端 id 绑定创建它的 WebContents；输出与退出事件 `terminals:event` 仅发给所属窗口。Renderer 输入是用户直接键入的终端数据，不经模型或 agent 执行。
- Renderer 用 xterm.js 渲染 ANSI、输入、历史滚动和 Ctrl+C；适配区域尺寸。切换对话、文件或工作区保留终端进程和屏幕；关闭终端标签需确认并结束对应 PTY，窗口销毁、刷新或真正退出时清理，最小化不清理。
- 终端恢复保存有界的可读屏幕 / 回滚文本和尺寸、编号、结束状态；每标签至多 128 KiB、每工作区至多 2 MiB，全部有效 workspace-ui 快照合计至多 64 MiB（超限拒绝写入并提示；隔离的损坏文件单独保留，不占用恢复写入额度）。输出触发节流快照，不逐字符写盘；退出等待最后一次快照。恢复文本只送 xterm 显示（去除控制字符），绝不送 PTY 或重跑历史命令；活标签显示「已恢复历史，新终端会话」后在 Main 登记的 workspace cwd 启新 shell，已结束标签只读保留。旧 PTY 在关闭 / 刷新 / 销毁时清理，异步创建以窗口代际及取消标记防止复活。
- 本次变更仅涉及中央标签 / 文件与终端 stores、Main workspace-ui 持久化与文件服务内部 id 重绑、退出接线、shared / preload typed API 和中英文案；不改 agent 协议、模型或权限配置，不保存终端环境与 provider 密钥。

### 7.5 指令文件

- `instructions:list|read|scan|import|pick|save|remove|toggle` 与 `instructions:changed` 提供指令文件管理；Renderer 只传条目 / 候选 id 或名称与编辑文本，任意 Markdown 文件由 Main 的打开对话框选择。
- Main 在 `userData/instructions.json` 存元数据，在 `userData/instructions/*.md` 存本地副本，均原子写入；大文本不进 settings.json。链接每次使用时读原文件，缺失 / 不可读时显示警告且不注入。删除只移除 Fynvra 条目；编辑链接转为本地副本并保留 importedFrom，绝不写改用户源文件。
- 全局至多一个条目启用，也可全关。`Role.instructionFileId` 缺省跟随全局，`null` 不使用，字符串指定条目（不受全局开关影响）；已删除的引用不回退到全局。
- 每次 spawn，Main 的角色资源解析器选择文件并读取 `{ name, content }`，经 `SpawnSessionSpec.instructionFile` → piSession → createRoleSession → buildRolePromptAppend，作为 `<user_instructions source="…">` 段追加系统提示词。沿用 pi 的项目 AGENTS.md 加载，不热更新已运行会话。
- 改动层：Main 注册表 / IPC / spawn 接线、preload typed API、core 角色字段、agent-runtime 提示词、Renderer 设置页 / 角色选项与文案；不改其他资源的加载或权限策略。

### 7.6 本机用量统计

- `usage:summary` 只接收 `{ range: 'today' | '7d' | '30d' | '90d' }`，返回当前及前一等长日历周期的总计、每日序列，以及当前周期的角色 / 模型 / 工作区分组、缓存命中率、24 小时消息分布和编排统计；范围含今天，日界线按本地时间计算。
- Main 的 `services/usage` 只读流式扫描 `userData/agent/sessions/*.jsonl`（含归档及已从列表删除的会话），跳过坏行和不可读文件，以路径、mtime、size 缓存每文件每日 / 模型 / 小时聚合；按文件名的 sessionId 在汇总时关联实时 session registry，未知 / 已删除会话保留在独立分组，工作区只返回名称。模型取 assistant 消息上的 provider/model，按 Token 再按费用排名；不向 Renderer 返回路径、正文或密钥，不写回 transcript。
- Token 总量为 input + output + cacheRead + cacheWrite，费用累计 pi 记录的 cost.total；缓存命中率为 cacheRead / (input + cacheRead)，无输入时为空。消息仅计 user / assistant；活跃时长累加同一周期内每会话相邻消息不超过 5 分钟的间隔。
- 编排展示「本期派发任务的当前结果」：按首次 dispatch.startedAt 归组，统计当前 completed / abandoned / failed 状态；快照无合并 / 放弃时间，不将 settledAt 伪装成合并时间。一次验收通过率和平均尝试数只计该组已合并任务；打回次数为本期开始的非首次 dispatch（含旧任务）。每个合并任务的 Worker 费用取该组已合并任务经 dispatchId 关联的会话全量费用（含跨期和重试，同一会话只计一次），关联或 transcript 缺失则省略，无已合并任务时省略比率。
- 用量 IPC 注入 session / workspace / orchestration getters；编排 registry 的 readSnapshot 读取已打开服务的当前快照，或只读解析持久化 JSON，绝不因用量查询打开服务、修复或重命名文件。页面为响应式双栏总览、SVG 趋势、角色 / 缓存卡片和排名，活动仅为紧凑小时条。
- 改动层限于 shared 用量类型、Main 服务 / handler 与两个只读访问出口、Settings 用量页及中英文案；不新增依赖、价格覆盖、持久化设置或 agent 协议。

### 7.7 Git 与命令网络代理

- 通用设置 `preferences.networkProxy` 仅包含模式（默认沿用进程环境）、无认证 HTTP/HTTPS 代理地址及 Git 兼容开关；两端严格校验，恢复默认删除覆盖。手动模式统一 HTTP_PROXY/HTTPS_PROXY 的大小写值，清除 ALL_PROXY，并清空 NO_PROXY（不继承绕过规则）。兼容模式仅设置 HTTP/1.1 与 Git protocol v0，不降低 TLS。
- 纯环境转换 helper 只复制子进程环境，以 GIT_CONFIG_COUNT/KEY/VALUE 追加命令级 Git 配置并保留已有项；非法已有计数/缺项时安全失败，不记录配置内容。不改 process.env、gitconfig、系统代理或 profile。Main 新 Git / run_checks 命令现读设置；新 PTY 和新建/恢复的 Agent session 获取配置快照，已有进程不重启。
- Main → Worker `SpawnSessionSpec.networkProxy` 为相同受限字段，双端解析；pi 官方 shell spawnHook 在 session metadata 注入后转换环境，保留默认工具集、角色限制和审批门，git_readonly 的 exec 同样接线。模型 API、MCP 和应用更新不因此改路由。
- `settings:test-network` 仅接收严格校验的当前配置草稿，Main 固定探测 GitHub API HTTPS 与公开项目仓库的 HEAD（git ls-remote），无 fetch/push、无凭据交互；`settings:cancel-network-test` 无参数。每窗口最多一个检测，替换/取消/关闭时中止，有限超时，响应仅含分项状态码与 HTTP 状态，不返回原始错误或环境。Renderer 在草稿/保存设置改变或卸载时使旧结果失效。检测只说明连通性，不证明 push 权限；仅用户点击触发。

### 7.8 上下文自动压缩

本轮修复的行为差异：Magic 只在 historian 校验并发布后记录成功；超时、最终校验/无进展与存储失败按会话退役，Stop/关闭只取消。Agent host 与 vendored 插件共同为异步操作绑定会话取消代际，在 SQLite、context 返回及 marker 追加处复验，防止退役或关闭后的迟到写入。预算使用当前模型的保守 UTF-8 字节估算并按完整块切分，不截断 XML。必改范围为 `src/agent/magicContext.ts` / `piSession.ts`、vendored Magic、会话 warning / suggestion 投影及本节文档；不改变工具审批、权限、官网、Fast 或模型路由配置。

- 通用设置 `preferences.compactionStrategy` 有 `native`（默认）、`off`、`magic-context` 三种；`settings:update` 严格校验枚举，旧记录、缺省或磁盘上的非法值按 `native` 读取。`native` 沿用 pi 原生自动压缩及其阈值 / 保留量默认值。
- Main 在每次构建 spawn spec 时读取已保存的设置，经 `SpawnSessionSpec.compactionStrategy` 交给 worker；worker 为每个会话新建内存 `SettingsManager`，仅 `off` 时写入 `compaction.enabled: false`。`native` 不加载任何压缩扩展；`magic-context` 把受控的 Magic Context 内联扩展交给 `createRoleSession`，并保留 pi 原生压缩作为插件未就绪、运行期失效或模型窗口装不下时的回退。主会话、派发的 worker 以及应用重启后恢复的会话使用同一份设置，会话之间不共享设置状态；Magic 的接管状态按会话独立失效，一个会话回退不影响其他会话。
- Magic Context 固定为 `@cortexkit/pi-magic-context` 0.41.3（MIT），资源在 `packages/agent-runtime/vendor/magic-context/`：只保留扩展入口、storage/core、日志/路径所需分片、TUI 桩与许可证，不包含 OpenCode/OMP TUI、子进程 runner、dreamer/sidekick/memory/embedding/quickjs/transformers 分片。打包时固定从 `resources/magic-context` 解析，开发时固定从 `app.getAppPath()/packages/agent-runtime/vendor/magic-context` 解析；资源缺失就保留 native 并提示，不回退到 `process.cwd()` 或用户工作目录里的副本。不扫描外部扩展，不读本机 `~/.pi` / `~/.config/cortexkit`，不迁移或共享终端 Magic 数据库。
- 插件数据全部在应用目录：配置 `userData/magic-context/config/cortexkit/magic-context.jsonc`，SQLite `userData/magic-context/storage/context.db`，historian dump `userData/magic-context/artifacts/`，日志 `userData/magic-context/magic-context.log`。配置只读 Main 生成的固定文件，缺失/损坏不扫描终端或工作区、不降为启用可选功能的默认配置；禁用旧终端 DB 迁移、终端 tokenizer 搜索、window overlay 与 CortexKit wake 服务探测。生成的配置关闭 dreamer、sidekick、跨会话 memory/auto-search、embedding 与 todowrite；`ctx_search` 显式关闭 memory/embedding/git 检索，smart note 条件因 dreamer 关闭而不可用。环境变量在 worker 生命周期内固定，不按会话 `chdir` 或改 env。
- Historian 不启动终端 pi 或 Electron 子进程：vendored 插件的 `PiSubagentRunner` 交给 `src/agent/magicContext.ts`，后者按 Pi session id 路由到该会话的模型 getter 与中止信号，用会话自己的 `ModelRuntime`/model 在进程内完成请求。路由表没有“当前会话/当前模型”的进程级全局值；并发会话各有自己的条目与 in-flight 标记。每次 historian 使用请求开始时的当前会话模型；换模型和 Stop 使旧操作失效，下一次重新计算预算。单次超时默认 180 秒、硬上限 5 分钟，SDK 返回 aborted、抛异常或未及时结束都经过同一 deadline 分类；真正的会话取消不计故障。请求无工具、`maxRetries: 0`，由 vendor 有限重试同一个当前模型，不把占位模型名当作真实 fallback 模型。
- Historian 预算由 host 的当前 `ResolvedModel.contextWindow/maxTokens` 给出：用 UTF-8 字节数保守估算文本 token，扣除实际 system prompt、至少 2048 token / 窗口 5% 的 framing 预留，以及不超过模型上限、窗口 20% 和 32000 的输出额度。Vendor 按完整块的字节数切分，计入 reference/user prompt 开销后最多再调整三次，host 发送前复核；小于 1024 的输出 cap、无效窗口或不可拆分的超大块明确回退，不截断 XML。此估算针对已支持的 byte/subword tokenizer，不能保证未知 provider 模板或错误模型元数据下的绝对上界。插件自身的调度/历史衰减仍使用上游字符估算；不加载、搜索或安装 `ai-tokenizer`。密钥只在 Main → worker 的 spawn 路径及会话 `ModelRuntime` 内存，不写插件配置或命令行。
- Magic 自己处理 tag、drop、historian 结果与 `<session-history>` 注入，并把 compartment 写入自己的 SQLite；pi jsonl 仍是权威源，Magic 只追加自己的 compaction 标记，不删除原始对话，Fynvra 历史投影不依赖 Magic 数据。Magic 的 `ctx_*` 工具只操作它自己的上下文存储，不新增命令执行、工作区文件写入或网络能力；角色原有的 bash/文件/MCP 工具白名单和审批档位仍由 Fynvra 决定。默认不启用 Dreamer/Sidekick/跨会话 memory/语义 embedding，也不会下载 embedding 模型。
- 生命周期：插件绑定前建立会话路由；用宿主自有空 facade 转发 SDK 1.4 API，保留方法 receiver，避免冻结对象的 Proxy invariants。仅在 boot ready、`session_start` 成功、historian 配置/路由及模型预算可用后接管；部分注册、缺少启动报告或迟到 boot 均不接管。成功只指 historian 的 XML/覆盖范围校验通过并提交 compartments/drop 队列/marker 状态，单纯 HTTP 成功不会清零失败计数。Transient 请求至多三次，验证只修复一次；最终校验失败、无进展、存储/发布或 context 故障按会话退役。`session_before_compact` 在未就绪或退役时放行 pi native，不在正常路径仅因触达原生阈值就冒充回退。
- 每个插件 hook、`ctx_*` 工具及其派生后台任务通过 `AsyncLocalStorage` 携带会话取消代际；SQLite 执行、延迟索引、marker 追加、await 后的 context/historian 发布与返回都复验。Context 在副本上变换，失效时丢弃；Stop/换模型同步释放 historian 租约与预算预留并使旧操作失效，dispose 在等待 Pi shutdown 前中止并清路由/ready/suspended。退役也停止新注入和 marker 排队，旧 shutdown 不清掉替代会话的状态，其他会话不受影响。已有 marker 保存上游衰减渲染的累计历史快照，native 回退不只得到标题列表；不删除或改写 pi jsonl 原始消息。
- 回退通过非阻塞 `warning` 事件显示固定文案，不标会话 error、不等待确认、不带 prompt/provider 原始错误；每个运行实例只发一次。关闭状态按 sessionId 与告警 seq 保存在 Renderer store，切换会话/视图重挂载不会串用关闭状态。Main 仍使用独立 `compaction-warning` 桌面通知，按通知设置/seq 去重与节流，聚焦当前会话时只显示会话内提示。Warning 推进传输 seq；Main/Renderer 独立保留最近对话活动 seq，灰字建议仍严格绑定 settled 轮次，警告不会使本轮建议消失，也不会复活旧轮建议。`fail_closed_blocking: false` 保持初始化失败时的 native 路径，Fynvra 不注册终端插件命令/快捷键或持久化终端 status 错误。新会话/重启读取策略，没有手动压缩入口。
- 尚未做真实长会话的现网压缩验证；historian 是额外的模型请求，按会话当前模型计费，插件自带的状态/命令 UI 在 Fynvra 中不可达。

### 7.9 输入框回复建议

- 一轮真实 AI 回复正常 `agent_settled`（未中止、未出错）后，Renderer 仅在当前选中会话、输入框空闲、没有队列 / 待审批 / 图片 / 未发送草稿时，调用 `sessions:suggest-reply`，只传 `{ sessionId, roundId }`（roundId 是该轮 settled 事件的会话级 seq）。切换历史会话、重渲染、流式 token、普通打字都不触发新请求；同一轮（含空结果 / 失败）只请求一次。
- Main 核对记录状态、未归档、没有待审批、`live` 仍空闲且 `lastSettledSeq === roundId`，再经既有 AgentCommand 通道让 worker 生成；Main 只保留最近轮次标记与有界的在途表（同时最多 2 条），不缓存对话正文，不把 key / 端点返回 Renderer。
- worker 用该会话当前的 `ResolvedModel`（含换模型后的模型）在 live `AgentSession` 上另发一次独立、无工具、`maxRetries: 0`、约 8 秒超时、输出上限 256 token 的 `completeSimple` 请求；不传 `reasoning`，Anthropic 等支持的服务走非思考分支、不会再追加 2048 思考预算（该上限是输出预算，请求本身仍按正常 token 计费）。不调用 `session.prompt`，不写 pi jsonl / 消息历史，不派 worker、不执行工具。上下文只取最近 8 条 user / assistant 纯文本（总计约 8k 字符，单条约 2k；最新优先，assistant 保留尾部），要求预测用户的下一句话、跟随最近用户语言、空建议表示不展示，并禁止 markdown、多候选以及替用户同意删除 / 发布 / 付款 / 权限变更等破坏性确认。
- 建议结果带 `requestId`、generation、sessionId、roundId 回 Main；Main 再核对轮次 / 状态并清洗成一行至多 200 字符。`prompt` / `steer` / `setModel` / `abort` / 删除 / 归档 / worker 崩溃都会取消在途请求或丢弃迟到回包；worker 生成前后都核对 generation、回合计数与空闲状态。失败、超时、取消一律静默返回空建议，不影响主聊天状态。
- Renderer 的灰字建议与 draft 分离：不进入草稿、不使发送按钮可用、不被 Enter 发送；只有建议可见、无修饰键、未组字（`isComposing` / composition / keyCode 229）、无选区且光标在末尾时，右箭头才把建议写入本会话 draft 并把光标放到末尾，不自动发送。Esc 忽略本轮且不重新出现；草稿是建议前缀时只显示剩余灰字，不匹配的普通输入立即隐藏；运行中、错误、队列、审批、图片、历史浏览时不显示。
- 灰字层复用输入框排版与明暗主题，`pointer-events-none`、`aria-hidden`，另用简短 live region 提示右箭头采纳；长建议截断并随输入框滚动。不改正常对话 prompt / 工具 / thinking / Fast，不新增通用设置开关。

## 8. 分阶段

- **Wave 1（并行三张卡）**：`app-shell`（Electron 骨架 + settings + IPC 约定 + 布局壳）、`core-domain`（packages/core）、`agent-runtime`（packages/agent-runtime）。
- **Wave 2**：Main 接入 worker 进程与两个包；聊天 UI（流式、工具卡片、会话内审批）；Providers / Roles / Skills / MCP 设置页；Orchestration 面板（任务卡、worker 实时输出、diff）。
- **Wave 3**：导入本机 Claude Code / Codex 配置；Git Checkpoint；打包发布。

## 9. Wave 2 跨卡契约（并行卡片的共同边界）

Wave 2 的卡片并行开发，彼此只能通过本节定义的接口对接。**本节列出的文件内容是规范性的**：拥有该文件的卡片必须按此创建；
需要它但不拥有的卡片，可以在自己的分支里创建**逐字相同**的文件（相同内容的新增文件合并时不会冲突），不要改动。

### 9.1 共享文件的追加约定（避免合并冲突）
- `src/shared/types/ipc.ts`：每个领域在 `IPC_CHANNELS` 里追加自己的一段，用 `// --- <domain> ---` 注释隔开，放在对象末尾。
- `src/preload/`：每个领域一个文件 `src/preload/domains/<domain>.ts`，导出 `create<Domain>Api(…)` 工厂和 `<Domain>Api` 类型；`src/preload/index.ts` 与 `src/preload/types.ts` 只各加一行。
  领域文件**不 import electron**：`index.ts` 把 `ipcRenderer`（或一个 `{ invoke, subscribe }` 桥）传进工厂。
  理由：`types.ts` 属于 Renderer 的类型程序（`tsconfig.web.json` 包含它），它要引用领域文件的 `<Domain>Api` 类型；
  领域文件一旦 import electron，`electron.d.ts` 顶部的 `/// <reference types="node" />` 会把 Node 全局类型带进 Renderer，
  `process` 等不再报 TS2591，护栏悄悄失效。
- `src/main/ipc/index.ts`：每个领域只加一行 `registerXxxHandlers()`。
- `src/renderer/App.tsx` / 布局文件只允许加挂载点（一行 import + 一行 JSX）。

### 9.2 `src/shared/types/chat.ts`（归属：agent-host；chat-ui / orchestration-ui 可逐字复制）
```ts
import type { FynvraSessionEvent, ThinkingLevel } from '@fynvra/core'; // 事件类型由 Task 10 挪进 core；src/shared 不得 import agent-runtime

export type SessionStatus = 'idle' | 'running' | 'waiting-approval' | 'error';
/** 设置里的服务 id + 模型 id（只存 id 引用）+ 思考档位（Task 17）+ Fast（可选，缺省关闭） */
export interface SessionModelRef { providerId: string; modelId: string; thinking?: ThinkingLevel; fastMode?: boolean; }
export interface SessionSummary {
  id: string; workspaceId: string; roleId: string; title: string; cwd: string;
  worktreeId?: string; parentSessionId?: string; dispatchId?: string;
  status: SessionStatus; createdAt: number; updatedAt: number;
  model?: SessionModelRef;
  archivedAt?: number;   // 归档时间（Task 26）：手动归档或闲置扫描；恢复、会话再次运行时清除
}
export type ChatRole = 'user' | 'assistant';
export interface ChatToolCall {
  id: string; name: string; args: unknown;
  status: 'running' | 'done' | 'error'; output?: string; durationMs?: number;
}
/** 输入框粘贴的图片：base64（不含 data: 前缀）。缩放、转 PNG 由 pi 在 worker 里做 */
export interface ChatImage { data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; }
export interface ChatMessage {
  id: string; sessionId: string; role: ChatRole; text: string; thinking?: string;
  images?: ChatImage[];  // 只用于 user 消息；带图片的正文不含 pi 接在末尾的 [Image …] 提示行
  toolCalls: ChatToolCall[]; createdAt: number; streaming: boolean;
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
}
export type ApprovalKind = 'command' | 'file-edit' | 'file-write' | 'mcp';
export type ApprovalDecision = 'allow' | 'allowSession' | 'deny';
export interface ApprovalRequest {
  id: string; sessionId: string; kind: ApprovalKind; title: string; detail: string; expiresAt: number;
}
/** Main → Renderer 推送（通道 `sessions:event`）。 */
export interface SessionEventEnvelope { sessionId: string; event: FynvraSessionEvent; }

// 模型选择（Task 17）：可选档位由 worker 按 pi 内置目录的 reasoning / thinkingLevelMap 算出，
// pi 目录外的模型按设置里模型条目的 reasoning 标记；只留 fynvra 有的档位（pi 另有 max）
export interface ModelThinkingCapability { thinkingLevels: ThinkingLevel[]; defaultThinking?: ThinkingLevel; } // 空数组 = 不支持推理
/** 请求的档位在集合里就用它，否则回落到模型的默认档位；Renderer 换模型与 worker 落定档位都按这一条 */
export function pickThinkingLevel(capability: ModelThinkingCapability, requested?: ThinkingLevel): ThinkingLevel | undefined;
export interface ModelOption extends ModelThinkingCapability { id: string; name: string; }
export interface ModelProviderOption { providerId: string; name: string; api: ProviderApi; models: ModelOption[]; } // 只列启用且有 key 的服务，不带 key 与地址
export interface ModelOptions { providers: ModelProviderOption[]; lastUsed?: SessionModelRef; }  // lastUsed：settings.json preferences.lastModelByWorkspace（含思考档位与 Fast）
```

### 9.3 `window.fynvra.sessions`（归属：agent-host；chat-ui 消费）
```ts
export interface SessionsApi {
  /** 默认不含归档的会话；includeArchived 时一并列出（带 archivedAt） */
  list(workspaceId: string, options?: { includeArchived?: boolean }): Promise<IpcResult<{ sessions: SessionSummary[] }>>;
  create(input: { workspaceId: string; roleId: string; model?: SessionModelRef }): Promise<IpcResult<{ session: SessionSummary }>>;
  remove(sessionId: string): Promise<IpcResult>;
  /**
   * images：最多 10 张，单张解码后 ≤ 20 MiB、合计 ≤ 50 MiB，有一张不合法就整条拒绝；
   * 带图片时 text 可以为空，不带时不能全是空白
   */
  prompt(input: { sessionId: string; text: string; images?: ChatImage[] }): Promise<IpcResult>;
  abort(sessionId: string): Promise<IpcResult>;
  /** 从 pi jsonl 重建的消息投影；Renderer 切换会话时调用 */
  history(sessionId: string): Promise<IpcResult<{ messages: ChatMessage[] }>>;
  respondApproval(input: { sessionId: string; requestId: string; decision: ApprovalDecision }): Promise<IpcResult>;
  /** 换模型 / 思考档位 / Fast：运行中拒绝；解析失败返回可读错误、记录不变；成功后下一次 prompt 起生效，pi 会话历史保留 */
  setModel(input: { sessionId: string; model: SessionModelRef }): Promise<IpcResult<{ session: SessionSummary }>>;
  modelOptions(input?: { workspaceId?: string }): Promise<IpcResult<ModelOptions>>;
  archive(sessionId: string): Promise<IpcResult<{ session: SessionSummary }>>;   // 运行中拒绝
  unarchive(sessionId: string): Promise<IpcResult<{ session: SessionSummary }>>; // 闲置计时重新开始
  sweep(): Promise<IpcResult<{ archived: number; removed: number }>>;            // 按设置立即扫一次
  onEvent(cb: (envelope: SessionEventEnvelope) => void): Unsubscribe;
  onSessionsChanged(cb: (workspaceId: string) => void): Unsubscribe;
  onApprovalRequest(cb: (request: ApprovalRequest) => void): Unsubscribe;
}
```
通道：`sessions:list|create|remove|prompt|abort|history|respond-approval|set-model|model-options|archive|unarchive|sweep`，推送 `sessions:event`、`sessions:changed`、`sessions:approval-request`。审批响应只接收 session / request id 和 decision，不接收工具参数或路径；Main 核验真实待审批请求后才转发答复。

- **归档**（Task 26）：`sessions:list` 传 workspaceId 时不列归档的会话，传 `{ workspaceId, includeArchived: true }` 一并列出。
  归档只记 `archivedAt`（不改 `updatedAt`），并让会话退出 worker；`preferences.cleanupWorktreeOnArchive` 打开时经
  `OrchestrationService.cleanupMergedWorktree` 删掉它的 worktree 与分支（只删经 merge_worktree 合并过、干净、合并后没有新提交的）。
  恢复清掉 `archivedAt` 并把 `updatedAt` 设为当前时间；会话再次运行（用户发消息、主 agent 打回）时注册表自动清掉 `archivedAt`。
  Main 启动后 30 秒、之后每小时按 `preferences.archiveIdleDays` / `deleteArchivedDays` 扫描（`sessions:sweep` 立即扫一次），
  删除与 `sessions:remove` 相同（pi jsonl 保留）。

- **换模型 / Fast**（`sessions:set-model`）：Main 用 `ModelResolver` 解析（协议不支持 Fast 时清掉该开关）→ 更新会话记录（sessions.json）→
  会话已在 worker 里时发 `set-model`（spec 同 `spawn-session` 的 `ResolvedModelSpec`，带 `fastMode`）→ worker 注册 provider 后调 pi 的
  `setModel` / `setThinkingLevel`，并更新本会话 onPayload 的 Fast 开关。换不成功时 worker 关掉该会话并报 fatal `session-error`，
  Main 下次使用前按记录重新 spawn。
- **可选档位**（`sessions:model-options`）：Main 不加载 pi，经进程级的 `describe-models` / `models-described` 问 worker，结果按
  （协议, 模型 id, reasoning 标记）缓存；worker 用的是与注册模型同一份目录模板（同 id 同协议时官方 provider 的条目优先）。
- **派发的 worker 会话**：用角色的 `model`；角色没配时继承主 agent 会话当前的模型、档位与 Fast。显式指定的模型或角色模型
  不继承 Fast。审批档位随主 agent：按派发时主 agent 会话的当前档位（用户可能切过），没有主 agent 时才用角色自己的。

### 9.4 `window.fynvra.orchestration`（归属：orchestration-host；orchestration-ui 消费）
```ts
import type { Run, Task, Dispatch, Worktree, Message } from '@fynvra/core';
export interface OrchestrationSnapshotView { runs: Run[]; tasks: Task[]; dispatches: Dispatch[]; worktrees: Worktree[]; messages: Message[]; }
export interface OrchestrationApi {
  snapshot(workspaceId: string): Promise<IpcResult<OrchestrationSnapshotView>>;
  /** 读 dispatch 对应 worker 会话的输出（与 read_worker_output 同源） */
  readWorkerOutput(input: { dispatchId: string; cursor: number }): Promise<IpcResult<{ text: string; total: number; done: boolean }>>;
  reviewDiff(dispatchId: string): Promise<IpcResult<{ branch: string; baseCommit: string; files: string[]; stat: string; diff: string }>>;
  changes(input: { workspaceId: string; sessionId?: string }): Promise<IpcResult<SessionChanges>>;
  onChanged(cb: (workspaceId: string) => void): Unsubscribe;
}
```
通道：`orchestration:snapshot|read-worker-output|review-diff|changes`，推送 `orchestration:changed`。

### 9.5 Main 内部接口（agent-host ⇄ orchestration-host，最终在 `src/main/index.ts` 接线）
```ts
// 归属：orchestration-host，文件 src/main/services/orchestration/launcher.ts
export interface WorkerSessionLauncher {
  // worktreeId：in-place 的尝试（工作区没有 git）没有，cwd 就是工作区目录
  createWorkerSession(input: { workspaceId: string; runId: string; dispatchId: string; roleId: string; cwd: string; worktreeId?: string; brief: string }): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;
  // Ordinary instructions return after delivery; freshAttempt waits are cancellable until delivery
  promptSession(sessionId: string, text: string, options?: { freshAttempt?: boolean; signal?: AbortSignal }): Promise<{ ok: true } | { ok: false; error: string }>;
  // Undefined means present/unknown, not failed; registry loading must have finished
  sessionFailure?(sessionId: string): string | undefined;
  onSessionFailure?(listener: () => void): () => void;
  readTranscript(sessionId: string, cursor: number): Promise<{ ok: true; text: string; total: number; done: boolean } | { ok: false; error: string }>;
  disposeSession(sessionId: string): Promise<void>;
}
// orchestration-host 导出：
export function createOrchestrationHost(deps: {
  workspace: Workspace; coordinatorSessionId: string;
  coordinatorBranch: string;          // 工作区 vcs 为 none 时为空串（不读分支，整条编排不跑 git）
  store: OrchestrationStore; git: GitWorktreeManager; inbox: Inbox; launcher: WorkerSessionLauncher; roles: RoleStore;
  runChecks: (cwd: string, command: string, signal?: AbortSignal) => Promise<{ exitCode: number; output: string; durationMs: number }>;
  resolveWorktreesRoot: (workspace: Workspace) => Promise<string>; // worktree 托管根目录，每次建 worktree 时现算（store 里推导不出来）：
                                      // preferences.worktreesRoot 配置时为 <根目录>/<仓库目录名>，否则仓库同级的 <仓库目录名>-worktrees，
                                      // 默认位置不可写等情况退回 userData/worktrees（src/main/services/orchestration/worktreesRoot.ts）
  exec: ExecFn;                       // 合并前用 symbolic-ref 确认仓库仍检出在 coordinatorBranch（merge 合进当前检出的分支）；review 取 --stat
  checkPolicy?: CheckCommandPolicy;   // run_checks 白名单，默认 DEFAULT_CHECK_COMMAND_POLICY
  now?: () => number;                 // 时钟，默认 Date.now
}): OrchestrationHost;
export function createWorkerHost(deps: { store: OrchestrationStore; inbox: Inbox; runId: string; dispatchId: string; now?: () => number }): WorkerHost;

// 归属：agent-host，文件 src/main/services/agentHost/types.ts
/** 设置里的模型引用：providerId 是「设置 → 模型服务」里的服务 id；fastMode 是会话自己的请求选项 */
export interface ModelRef { providerId: string; modelId: string; fastMode?: boolean; }
export interface ModelResolver { resolve(ref: ModelRef | undefined): Promise<{ ok: true; model: ResolvedModelSpec; ref: ModelRef } | { ok: false; error: string }>; }
/** 跨进程可序列化的模型描述；worker 进程内再换成 agent-runtime 的 ResolvedModel */
export interface ResolvedModelSpec {
  providerId: string; api: string; baseUrl?: string; apiKey?: string; modelId: string; thinking?: ThinkingLevel;
  fastMode?: boolean; // 会话自己的 Fast 开关；只对 OpenAI Responses / Chat Completions 发送 service_tier
  reasoning?: boolean; // 设置里模型条目的 reasoning 标记：只对 pi 目录里没有的模型生效（Task 17）
}
export interface AgentHost {
  implementsLauncher(): WorkerSessionLauncher;      // 供 orchestration-host 使用
  setOrchestrationHostFactory(f: (coordinatorSessionId: string, workspaceId: string) => OrchestrationHost | null): void;
  setWorkerHostFactory(f: (sessionId: string) => WorkerHost | null): void;
}
```

- **模型引用与运行时 provider 键**：`ResolvedModelSpec.providerId` 是运行时 provider 键（`fynvra-` + baseUrl 与 key 的哈希），
  worker 按它注册 pi provider，不是设置里的服务 id；`ref` 是实际解析的设置引用（ref 缺省时即选中的默认模型），
  会话记录与 `SessionSummary.model` 存它，每次 spawn 再按它解析。`fastMode` 只在服务协议支持时写进 spec，Main 解析时统一校验。
- **接线**（`src/main/index.ts` 调 `connectOrchestration`）：`setLauncher(agentHost.implementsLauncher())`；两个 Host 工厂在
  host 调用到达时按会话查编排注册表（Dispatch 在 `createWorkerSession` resolve 之后才写入）；worker 会话的 `parentSessionId`
  经 `Run.coordinatorSessionId` 反查（launcher 入参只有 runId）；启动或恢复任何会话之前 `await openAll()`。
- **失效尝试恢复**：服务加载完成、launcher 接线完成后，只在会话注册表完整读取并证明 worker 会话缺失，或 Main 收到当前 generation 的明确 fatal、运行中进程退出、aborted/最终 error、退出应用中断时，将当前未结算 Dispatch 记为 failed，Task 从 in-progress 改为 failed，投递失败原因并持久化、广播 changed。启动加载中、注册表不可读/部分损坏、尚未 fork、正常 idle、审批与 askCoordinator 等待均不是失败证据；不按超时或无输出判断。每次检查重验当前 attempt，反馈投递中的新 Dispatch 暂不参与绑定或恢复，避免注册/投递竞态。snapshot/list/wait 可触发检查，删除/异常退出事件及时触发；用量 readSnapshot 保持只读。已有报告/历史和 worktree/分支保留，in-review/completed/abandoned 不改，重复检查不复写 outcome。成功汇报仍需协调者验收；接管合并或 Git 祖先关系不能自动将遗留任务标为 completed。

### 9.6 `src/shared/types/llm.ts`（归属：settings-ui；agent-host 可逐字复制）
```ts
export type ProviderApi = 'anthropic-messages' | 'openai-responses' | 'openai-completions' | 'google-generative-ai';
export interface ModelEntry { id: string; name: string; contextWindow?: number; maxOutput?: number; reasoning?: boolean; }
export interface ModelProvider { id: string; name: string; api: ProviderApi; baseUrl?: string; enabled: boolean; models: ModelEntry[]; }
/** Renderer 侧看到的脱敏形态 */
export interface ModelProviderView extends ModelProvider { hasApiKey: boolean; apiKeyHint?: string; }
export interface SkillEntry { id: string; name: string; path: string; description?: string; enabled: boolean; }
export interface McpServerEntry { id: string; name: string; transport: 'stdio' | 'sse' | 'http'; command?: string; args?: string[]; url?: string; enabled: boolean; }
/** Renderer 侧 env / headers 只给键名 */
export interface McpServerEntryView extends McpServerEntry { envKeys: string[]; headerKeys: string[]; }
```
settings-ui 还提供 `src/main/services/providers/resolveModel.ts` 导出 `createModelResolver(): ModelResolver`（形状同 9.5）。
持久化：`userData/providers.json`（含明文 key，仅 Main）、`userData/skills.json`、`userData/mcp.json`、`userData/roles/<id>.json`。
