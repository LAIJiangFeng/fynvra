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
    approval?: ApprovalPolicyHooks;     // 审批门（按 role.approvalMode 拦截 tool_call）的人工审批通道；不提供时需审批的调用一律拒绝
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
  - 审批门（`createApprovalGate`）：`supervised` 审批命令（bash / powershell / run_checks）、文件写改（write / edit / apply_patch）、MCP 工具；`auto-edits` 只审批命令与 MCP；`full` 全部放行。保护底线（`rm -rf`、`Remove-Item -Recurse`、`del /s`、`git push`、`git reset --hard`、包管理器 `publish`）任何档位都要人确认，`allowSession` 不豁免；10 分钟未答复、回合中止按 deny，拒绝以可读文本作为工具结果返回模型。worker 先发 `approval-request`（kind / title / detail / expiresAt）给 Main，再发 `approval_request` 会话事件。
- 编排工具（仅 orchestrator 角色，pi `ToolDefinition`，参数 schema 完整类型，归一化先于校验）：
  `dispatch_task { title, spec, role?, depends_on? }`、`list_workers`、`wait_for_workers { timeout_ms, until: 'any' | 'all' }`、`read_worker_output { dispatch_id, cursor? }`、`send_to_worker { dispatch_id, body }`、`review_diff { dispatch_id }`、`run_checks { dispatch_id, command }`、`merge_worktree { dispatch_id }`、`reject_work { dispatch_id, feedback }`、`cleanup_worktree { dispatch_id }`。
  工具不直接操作 git / 进程，而是调用注入的 `OrchestrationHost` 接口（由 Main 实现）。`OrchestrationHost` 的方法名与上述工具一一对应。
- worker 工具：`ask_coordinator { question }`（阻塞直到 reply 或超时，返回答复文本）、`report_done { outcome: 'succeeded' | 'failed', summary, files_modified? }`（每轮只能成功调用一次，同一轮再次调用返回错误；新的 agent run 开始时重新开放，因此 Main 要把 `reject_work` 的 feedback 作为新 prompt 发给 worker，worker 才能再次汇报）。
- 事件归一化：pi session 事件 → `FynvraSessionEvent`（`text_delta`、`thinking_delta`、`tool_start` / `tool_end`、`message_end`、`agent_settled`、`approval_request`、`usage`、`error`），每条带 `seq`。

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

**改动的生命周期**：`review_diff` 与面板共用 Main 查询，在工作区主仓库读取提交差异，不依赖 worker 目录仍是 Git worktree。
合并时将创建基准和 worker 提交 SHA 写入 Task 的可选 `mergedDiff`，随编排快照保存；正常清理、归档清理、重启后仍读这对提交，
不拿主仓库当前 HEAD 代替 worker 提交。旧快照没有此字段时，沿用尚存的 worktree 基准与 worker 分支；两者已清理且无历史范围时明确报不可用。
此修复必改 core 的 `types.ts`、`orchestration/store.ts`、`git/GitWorktreeManager.ts`，Main 的 `orchestration/{host,queries,service}.ts`，
Renderer 的 `ChangesView.tsx` 及对应测试；IPC 入参、返回形状不变，不另存完整补丁，不修改 worktree 删除策略或文件管理功能。

**没有 git 的工作区（`vcs: 'none'`）**：编排原地进行，Main 不调用任何 git。
- 挂入：任意目录都能挂；git 仓库的子目录先问用户（改挂仓库根目录 / 仍然按普通目录挂入该子目录 / 取消）。
- `dispatch_task` 不建 worktree，worker 的 cwd 是工作区目录（并行的 worker 共用它，工具结果建议一次只派一个），
  Dispatch 记 `mode: 'in-place'`；`review_diff` 没有 diff，给出 worker 在 `report_done` 里汇报的改动文件；
  `run_checks` 在工作区目录里跑；`merge_worktree` 无需合并，把 in-review 的任务记为 completed；
  `cleanup_worktree` 只停 worker（未完成的任务照样放弃，改动留在目录里）。
- 提示词：Main 在 spawn 时按工作区给 spawn spec 带 `inPlace: true`，orchestrator 在工具说明后追加非 git 模式一段，
  worker 换用不提交的契约（agent-runtime 的 `IN_PLACE_ORCHESTRATOR_PROMPT` / `IN_PLACE_WORKER_CONTRACT_PROMPT`）。

## 7. IPC 规则

- 新增 IPC 三件事必须同步：`src/shared/types/ipc.ts` 通道常量（`domain:action`）、`src/main/ipc/<domain>.ts` handler 并在 `ipc/index.ts` 注册、`src/preload/index.ts` 按领域暴露 typed API。
- 入参按 `unknown` 收窄；Renderer 只传 id 不传路径；返回 `{ ok, ... }` 不跨边界抛异常；不暴露通用 `invoke`。
- API key、MCP env 明文只在 Main。
- Main → Renderer 推送用 `sendToAllWindows`。

### 7.1 工作区文件浏览与编辑

- 右栏「文件」只展示目录树，与「任务 / 改动」并列；点击文件在中央工作区打开独立标签，与固定的「对话」标签并列，支持多开、切换和关闭。
- `files:list` 接收 `{ workspaceId, directoryId? }`，省略目录 id 时列出工作区根目录；`files:read` 接收 `{ workspaceId, fileId }`；`files:write` 接收 `{ workspaceId, fileId, version, text }`，版本是读取时的文件内容摘要。
- Main 根据工作区记录定位根目录，为列出的条目签发不透明 id；Renderer 只能回传这些 id，展示用相对路径不能作为访问参数。
- 每次读取重新校验真实路径位于登记的工作区内，拒绝跨工作区 id、失效条目及越界链接；符号链接只展示，不展开或预览。
- UTF-8 文本编辑最多 256 KiB，使用按需加载语言的 CodeMirror；Markdown 复用 GFM 渲染组件，支持编辑 / 预览 / 双栏。PNG / JPEG / GIF / WebP 预览最多 2 MiB，其他二进制和超限文件显示说明。HTML / SVG 仅按源码显示，不执行。
- Main 按文件串行保存，写前核对当前内容版本，冲突时保留磁盘与草稿；同目录临时文件写完后替换原文件。拒绝越界链接、二进制和超限写入；保留 UTF-8 BOM，编辑器沿用原文件的换行格式。
- 未保存草稿不被目录刷新覆盖；切换对话、文件、工作区或折叠右栏不丢草稿；关闭标签及退出窗口前确认，取消退出不停止 agent 服务。保存中的新输入不能被旧保存响应覆盖。
- 文件内容与打开标签只在内存，不写 `settings.json`；不执行文件、不切换到 worker 的 worktree。
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

## 8. 分阶段

- **Wave 1（并行三张卡）**：`app-shell`（Electron 骨架 + settings + IPC 约定 + 布局壳）、`core-domain`（packages/core）、`agent-runtime`（packages/agent-runtime）。
- **Wave 2**：Main 接入 worker 进程与两个包；聊天 UI（流式、工具卡片、审批条）；Providers / Roles / Skills / MCP 设置页；Orchestration 面板（任务卡、worker 实时输出、diff）。
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
/** 设置里的服务 id + 模型 id（只存 id 引用）+ 思考档位（Task 17） */
export interface SessionModelRef { providerId: string; modelId: string; thinking?: ThinkingLevel; }
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
export interface ModelOptions { providers: ModelProviderOption[]; lastUsed?: SessionModelRef; }  // lastUsed：settings.json preferences.lastModelByWorkspace
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
  /** 换模型 / 思考档位：运行中拒绝；解析失败返回可读错误、记录不变；成功后下一次 prompt 起生效，pi 会话历史保留 */
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
通道：`sessions:list|create|remove|prompt|abort|history|respond-approval|set-model|model-options|archive|unarchive|sweep`，推送 `sessions:event`、`sessions:changed`、`sessions:approval-request`。

- **归档**（Task 26）：`sessions:list` 传 workspaceId 时不列归档的会话，传 `{ workspaceId, includeArchived: true }` 一并列出。
  归档只记 `archivedAt`（不改 `updatedAt`），并让会话退出 worker；`preferences.cleanupWorktreeOnArchive` 打开时经
  `OrchestrationService.cleanupMergedWorktree` 删掉它的 worktree 与分支（只删经 merge_worktree 合并过、干净、合并后没有新提交的）。
  恢复清掉 `archivedAt` 并把 `updatedAt` 设为当前时间；会话再次运行（用户发消息、主 agent 打回）时注册表自动清掉 `archivedAt`。
  Main 启动后 30 秒、之后每小时按 `preferences.archiveIdleDays` / `deleteArchivedDays` 扫描（`sessions:sweep` 立即扫一次），
  删除与 `sessions:remove` 相同（pi jsonl 保留）。

- **换模型**（`sessions:set-model`）：Main 用 `ModelResolver` 解析 → 更新会话记录（sessions.json）→ 会话已在 worker 里时发
  `set-model`（spec 同 `spawn-session` 的 `ResolvedModelSpec`）→ worker 注册 provider 后调 pi 的 `setModel` / `setThinkingLevel`。
  换不成功时 worker 关掉该会话并报 fatal `session-error`，Main 下次使用前按记录重新 spawn。
- **可选档位**（`sessions:model-options`）：Main 不加载 pi，经进程级的 `describe-models` / `models-described` 问 worker，结果按
  （协议, 模型 id, reasoning 标记）缓存；worker 用的是与注册模型同一份目录模板（同 id 同协议时官方 provider 的条目优先）。
- **派发的 worker 会话**：用角色的 `model`；角色没配时继承主 agent 会话当前的模型与档位。审批档位随主 agent：
  按派发时主 agent 会话的当前档位（用户可能切过），没有主 agent 时才用角色自己的。

### 9.4 `window.fynvra.orchestration`（归属：orchestration-host；orchestration-ui 消费）
```ts
import type { Run, Task, Dispatch, Worktree, Message } from '@fynvra/core';
export interface OrchestrationSnapshotView { runs: Run[]; tasks: Task[]; dispatches: Dispatch[]; worktrees: Worktree[]; messages: Message[]; }
export interface OrchestrationApi {
  snapshot(workspaceId: string): Promise<IpcResult<OrchestrationSnapshotView>>;
  /** 读 dispatch 对应 worker 会话的输出（与 read_worker_output 同源） */
  readWorkerOutput(input: { dispatchId: string; cursor: number }): Promise<IpcResult<{ text: string; total: number; done: boolean }>>;
  reviewDiff(dispatchId: string): Promise<IpcResult<{ branch: string; baseCommit: string; files: string[]; stat: string; diff: string }>>;
  onChanged(cb: (workspaceId: string) => void): Unsubscribe;
}
```
通道：`orchestration:snapshot|read-worker-output|review-diff`，推送 `orchestration:changed`。

### 9.5 Main 内部接口（agent-host ⇄ orchestration-host，最终在 `src/main/index.ts` 接线）
```ts
// 归属：orchestration-host，文件 src/main/services/orchestration/launcher.ts
export interface WorkerSessionLauncher {
  // worktreeId：in-place 的尝试（工作区没有 git）没有，cwd 就是工作区目录
  createWorkerSession(input: { workspaceId: string; runId: string; dispatchId: string; roleId: string; cwd: string; worktreeId?: string; brief: string }): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;
  promptSession(sessionId: string, text: string): Promise<{ ok: true } | { ok: false; error: string }>;
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
/** 设置里的模型引用：providerId 是「设置 → 模型服务」里的服务 id */
export interface ModelRef { providerId: string; modelId: string; }
export interface ModelResolver { resolve(ref: ModelRef | undefined): Promise<{ ok: true; model: ResolvedModelSpec; ref: ModelRef } | { ok: false; error: string }>; }
/** 跨进程可序列化的模型描述；worker 进程内再换成 agent-runtime 的 ResolvedModel */
export interface ResolvedModelSpec {
  providerId: string; api: string; baseUrl?: string; apiKey?: string; modelId: string; thinking?: ThinkingLevel;
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
  会话记录与 `SessionSummary.model` 存它，每次 spawn 再按它解析。
- **接线**（`src/main/index.ts` 调 `connectOrchestration`）：`setLauncher(agentHost.implementsLauncher())`；两个 Host 工厂在
  host 调用到达时按会话查编排注册表（Dispatch 在 `createWorkerSession` resolve 之后才写入）；worker 会话的 `parentSessionId`
  经 `Run.coordinatorSessionId` 反查（launcher 入参只有 runId）；启动或恢复任何会话之前 `await openAll()`。

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
