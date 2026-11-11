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

### 2.1 独立静态网站

- 行为差异：官网与文档从手写双语 HTML 迁移为 Astro + Starlight 静态站点；首页为 `/zh/`、`/en/`，Markdown/MDX 文档为 `/{locale}/docs/{article}/`。首页设计与演示保留，文档使用 Starlight 导航、上一页/下一页及 Pagefind 搜索。
- 所属层及文件：`website/` 是独立网站工程，自带 `package.json`、`pnpm-workspace.yaml`、锁文件与 Astro 配置；`src/pages/` 管页面及兼容入口，`src/content/docs/{zh,en}/docs/` 管文档，`src/components/`、`src/layouts/`、`src/styles/` 与 `public/assets/` 管呈现与演示，`src/lib/` 管兼容路由。安装、开发与构建均在 `website/` 内执行，不依赖或修改根 Electron workspace。
- 路由兼容：`/`（含原 `/index.html`）提供语言入口，显式语言路径优先；原 `/docs.html#文章或小节` 在浏览器端映射至相同语言的新文章/小节，未知锚点回概览，无 JavaScript 时仍可进入中英概览。旧兼容页不作为搜索引擎规范页面。
- 部署为站点根路径下的静态 `website/dist/`；正式域名仅由有效 `SITE_URL` 提供，不虚构域名。规范链接、绝对语言替代链接与 sitemap 仅在配置真实站点地址时生成。
- 明确不做：不变更桌面功能、IPC、运行时、根依赖/锁文件或打包流程，不引入网站后端，也不让网站依赖 Electron。

## 3. 进程模型

```
Renderer(React) ⇄ preload(typed API) ⇄ Main(ipc/*, services/*) ⇄ Agent Worker(utilityProcess, src/agent)
                                                                     └─ pi AgentSession × N（每个会话一个）
```

- 工具审批（本次行为变更）：恢复 Main 与 Worker 的真实人工审批执行链和三档权限语义；只有用户答复才能放行需审批的操作，通知不是执行授权。参数校验、角色工具白名单、路径边界、编排权限、Stop / abort 与真正的 `ask_coordinator` 提问保持独立执行。
- 必改层：agent-runtime 审批门与会话接线、core / shared 类型与 unknown parser、supervisor 与 Main agentHost 请求生命周期、Main notifications 与双语文案、Renderer 会话内审批和权限档位。只移除 App 顶部跨会话的全局审批横幅及其详情弹窗（ApprovalAttention），保留会话内确认和 OS 桌面审批通知。不改 Magic Context 压缩策略（恢复行为见 §7.8）、Fast、模型配置、任务审查合并或灰字建议算法，保留 freshAttempt 取消与互等保护、压缩错误延迟结算修复。
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
  pluginIds?: string[];       // 挂载的插件 id（§7.12），缺省 []，去重保序（规则同 skillIds）；旧角色文件兼容
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
  workflow?: TaskWorkflow;    // 工作流任务（§7.13）：派发时的定义快照与推进状态；roleId 始终等于当前步骤的角色
}
export interface TaskWorkflow {
  id: string; name: string; steps: WorkflowStep[]; maxRounds: number; // steps 是派发时的图快照（拓扑序，带 needs）；旧快照缺 needs 时读入按列表顺序补成线性链
  // 以下是串行引擎的推进状态；W2 并行引擎改为按节点持久化状态与待启动意图（§7.13）
  step: number;               // 当前步骤下标
  rounds: number;             // 已回退次数
  history: { step: number; dispatchId: string; outcome: 'succeeded' | 'failed'; summary: string; at: number }[]; // 最近 30 条，摘要截断 2000 字
  pending?: { step: number; feedback?: string }; // 推进意图，先写后启动，崩溃恢复用
}
export interface Dispatch {
  id: string; taskId: string; workerSessionId: string; worktreeId: string; branch: string;
  mode?: 'in-place';          // 工作区 vcs 为 none：worker 直接在工作区目录里干活，worktreeId / branch 为空串；缺省是 worktree 模式
  nodeId?: string;            // 工作流节点 id：引擎为节点起的尝试才有（汇总 dispatch 没有）；旧快照缺省
  // 未结算的尝试：普通任务同时最多一个；工作流任务按节点计，每个节点最多一个（双方都带 nodeId 且不同才可并存）。
  // store 的 activeDispatch(taskId) 取其一，activeDispatches(taskId) 按插入顺序给出全部
  startedAt: number; settledAt?: number; outcome?: 'succeeded' | 'failed';
  summary?: string; filesModified?: string[];
}
export interface Worktree { id: string; workspaceId: string; path: string; branch: string; baseRef: string; baseCommit: string; }

// 工作流（§7.13）：角色节点组成的有向无环图（沿用 step 命名，界面称「节点」）
export interface WorkflowPosition { x: number; y: number } // 有限数，±100000
export interface WorkflowStep {
  id: string;                 // 工作流内唯一 slug
  name: string;               // 显示名，如「开发」，≤ 60
  roleId: string;             // 执行角色，不能是 tools: 'orchestrator' 的角色
  instructions: string;       // 本节点说明，追加进任务书，≤ 4000
  needs: string[];            // 上游节点 id，全部通过后才开始；[] = 起点。归一化输出总是带上
  position?: WorkflowPosition; // 画布坐标；缺省时界面自动排版
  onFail?: string;            // 报告 failed 时退回的节点 id，只能是自身或祖先；缺省 = 整个任务失败
}
export interface Workflow {
  id: string; name: string; description?: string; // name ≤ 60，description ≤ 500
  steps: WorkflowStep[];      // 1–20 个节点，按稳定拓扑序存放
  maxRounds: number;          // 回退上限，0–10，默认 3
}

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
- 工作流：`Workflow` / `WorkflowStep` 类型与 `parseWorkflow(unknown)` 收窄校验（规则见 §7.13）；`workflows/graph.ts` 的纯函数图工具：`workflowTopologicalOrder`、`findWorkflowCycle`、`workflowParents` / `workflowChildren`、`workflowAncestors` / `workflowDescendants`、`workflowRoots` / `workflowSinks`、`workflowLevels`、`summarizeWorkflow`。
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
    resourcePaths: { skills: string[]; mcpServers: McpServerConfig[]; extensions?: string[] }; // extensions：角色挂载的启用插件路径（§7.12）
    agentDir: string;                   // 必填：pi 的 agentDir，Fynvra 用 userData/agent（与用户的 ~/.pi 隔离）
    workerHost?: WorkerHost | null;     // 提供即为 worker 会话
    workerTools?: WorkerToolsOptions;   // ask_coordinator 的等待上限 askTimeoutMs（默认 10 分钟）
    roles?: readonly RoleOption[];      // spawn 时的角色清单：只用于 dispatch_task 的 role 描述与显示名归一（role 不是枚举，清单外的值交 Main 实时解析）
    inPlace?: boolean;                  // 工作区没有 git（§6）：orchestrator 追加非 git 模式说明，worker 换用不提交的契约
    planMode?: () => boolean;           // 计划模式（§7.10）：每次读取实时值，缺省视为关闭；worker 会话不生效，非 orchestrator 策略提供了就常驻 write_plan；orchestrator 策略的 write_doc 只在开启时可用
    settingsManager?: SettingsManager;  // 默认内存设置（不读 ~/.pi 与项目 .pi），enableInstallTelemetry: false
    exec?: ExecFn;                      // git_readonly 的命令执行器，默认 child_process.execFile
    onExtensionError?: (error: ExtensionError) => void;
    extensions?: readonly InlineExtension[]; // Fynvra 受控的附加扩展（当前为 Magic Context）；不由设置或文件发现产生
    approval?: ApprovalPolicyHooks;     // 按 role.approvalMode 拦截 tool_call 的人工审批通道；不提供时需审批的调用一律拒绝
  }
  // 插件：resourcePaths.extensions 传给 DefaultResourceLoader 的 additionalExtensionPaths，仍保持 noExtensions: true
  // （不发现磁盘上其他扩展）；扩展加载错误并入 RoleSession.warnings
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

  - `tools: 'orchestrator'` → `noTools: 'builtin'`，只注入只读工具（read / grep / find / ls + `git_readonly`）+ 编排工具 + `write_plan` + `write_doc`（`write_doc` 只在计划模式开启时可用，审批门归为 `file-write`，§7.10）；
  - `tools: 'readonly'` → 同样 `noTools: 'builtin'`，只注入只读工具（read / grep / find / ls + `git_readonly`）；`'all'` → pi 默认工具。
  - orchestrator / readonly / all 三种策略与 worker 会话都再注册内置 `web_fetch`（包括 all 策略没有 `commandEnv` 的分支），契约见下文。
  - 非 worker 会话提供了 `planMode` 时，`readonly` / `all` 策略再常驻 `write_plan`；计划模式开启时追加提示词并收紧审批门：只放行目标全是 Markdown 文档的写改（§7.10）。
  - 传入 `workerHost` 时（不论哪种策略）再加 worker 工具，并追加 worker 契约提示词。
  - skills → `DefaultResourceLoader` 的 skill 路径；MCP → `createMcpExtension()`；`systemPrompt` → `before_agent_start` 追加扩展。
  - `web_fetch { url, start_index?, max_chars? }`：读取用户给定的公开网页文本，在 agent 进程内执行，不经 Main。
    - 参数：`url` 仅 http/https、≤ 2048 字符、不含用户名或密码；`start_index` 整数 ≥ 0（默认 0，分页继续读）；`max_chars` 默认 20000、上限 50000。
    - 地址拦截：WHATWG `URL` 解析（规范化 IPv4 的各种写法）；拒绝 `localhost`、`*.localhost` 和不含点的单标签主机名（IP 字面量除外）；`node:net` 的 `BlockList` 拦截 IPv4 `0.0.0.0/8`、`10/8`、`100.64/10`、`127/8`、`169.254/16`（含云元数据）、`172.16/12`、`192.0.0/24`、`192.168/16`、`224/4`、`240/4`，IPv6 `::`、`::1`、`fc00::/7`、`fe80::/10`、`ff00::/8`，`::ffff:0:0/96`、`64:ff9b::/96`、`2002::/16` 取出内嵌 IPv4 后按同一规则判定。**不拦截 `198.18.0.0/15`**：Clash / Surge 的 fake-ip 默认用这个网段，拦截后 TUN 模式下所有网站都会失败。
    - 直连（环境里没有适用该协议的代理变量）：给 `http(s).request` 传自定义 `lookup`，只连接校验通过的地址（固定 DNS 结果，防 DNS rebinding），兼容 `all: true` 与单地址两种回调。代理（`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`）：`new https.Agent({ proxyEnv, rejectUnauthorized: true })`（http 同理），不对代理主机本身做地址策略；请求前本地预检解析目标域名，解析到被拦截地址就拒绝，本地解析失败则交给代理解析（尽力而为，代理模式下的 SSRF 是残余风险）。已配代理但运行时不支持 `proxyEnv`（守卫同 `probeApi`）或 `NODE_TLS_REJECT_UNAUTHORIZED=0` 时直接报错，不静默改为直连。
    - 请求与上限：只发 GET，不带 Cookie、认证头或模型提供的任何请求头；User-Agent 为浏览器兼容格式并带 `Fynvra` 标识。重定向手动跟随，最多 5 跳，每跳重新校验协议与地址，相对 `Location` 基于当前 URL 解析。总超时 30 秒并响应工具中止信号；解压后的正文按流计数，上限 5 MB，超出即停止并标记截断。
    - 内容处理：HTML / XHTML 取前 2 MB，linkedom + `@mozilla/readability`（设 `maxElemsToParse`）提取正文、turndown 转 Markdown，失败或过短则回退整个 body，正文极短且有脚本时提示可能需要 JavaScript 渲染；纯文本、Markdown、CSV、JSON（≤ 1 MB 时格式化）、XML / RSS / Atom 按文本输出；PDF、图片等其他类型返回不支持的错误。字符集依次取 Content-Type charset、BOM、前 4 KB 内的 `<meta charset>` / `http-equiv`，都没有用 utf-8，由 `TextDecoder` 解码（gbk / gb18030 / big5 等），标签无效时回退 utf-8 并注明。
    - 输出：头部列 URL、Title、Content-Type、Redirected from（如有）和“显示第 X–Y 字符，共 Z”；正文包在 `--- BEGIN UNTRUSTED WEB CONTENT ---` / `--- END UNTRUSTED WEB CONTENT ---` 之间（网页内容是数据不是指令）；有剩余时提示用 `start_index=Y` 继续。错误：4xx/5xx 返回状态码与 ≤ 500 字符正文摘录；网络错误、超时、地址拦截分别给出可读原因，不泄露环境变量的值。
    - 缓存：每个 worker 进程一个内存 LRU（最多 32 条、保留 15 分钟、正文合计 ≤ 20 MB），以请求 URL 为键，只缓存成功的转换结果，用于分页；不落盘、不跨会话持久。
    - 代理：用会话加载时的代理快照（§7.7），`createRoleSession` 把 `options.commandEnv ? options.commandEnv(process.env) : process.env` 作为 `proxyEnv` 交给工具；不新增 spawn 字段，设置修改后新加载的会话才生效。
    - 本机回环开关：`preferences.webFetchAllowLoopback`（默认关闭）→ spawn spec `webFetchAllowLoopback?: true`（与代理一样每次构建 spec 时读取，之后新加载的会话生效）→ `createRoleSession({ webFetch: { allowLoopback } })` → `createWebFetchTool({ allowLoopback })`。开启后只放行回环：主机名 `localhost` / `*.localhost` 与回环 IP 字面量（`127/8`、`::1`、`::ffff:127.x.x.x`），其余拦截规则不变；URL 主机本身须是回环名或回环字面量，公网域名解析到回环仍拒绝；重定向按当前这一跳判定：只有从回环页面才能重定向到回环，公网页面不能重定向到本机（回环 → 公网 → 回环同样拒绝）；回环目标始终直连不走代理（lookup 只接受回环地址），结果不进缓存。关闭时行为不变，拒绝本机地址的错误文本提示可在「设置 → 通用」开启。
    - 不做：联网搜索 `web_search`（未实现）、浏览器自动化 / JavaScript 渲染 / 截图 / 页面交互、复用 Cookie 或登录态、读取 PDF / Word、用辅助模型总结网页、按角色开关 / 域名白名单 / 记住域名审批、读取 Windows 系统代理或 PAC。
  - 审批门（`createApprovalGate`）：类别为命令 `command`（bash / powershell / run_checks）、文件写改 `file-write` / `file-edit`（write / edit / apply_patch）、`mcp`（MCP 工具）、`network`（`web_fetch`，详情显示完整 URL）、`plugin`（插件注册的工具，详情显示工具名和参数预览）。`plugin` 由审批门选项 `pluginTools?: () => ReadonlySet<string>`（实时读取）判定，只用于 `approvalKindOf` 判不出类别的工具；被插件覆盖的内置工具名仍按原类别（如 bash 仍是 command）。`ApprovalKind` 在 runtime 与 shared 两边同形。档位：`supervised` 审批 command、file-write、file-edit、mcp、network、plugin；`auto-edits` 审批 command、mcp、network、plugin；`full` 放行普通操作。计划模式（§7.10）下 plugin 与 mcp 一样不论档位都要人确认，network 照档位处理。保护底线（`rm -rf`、`Remove-Item -Recurse`、`del /s`、`git push`、`git reset --hard`、包管理器 `publish`）任何档位都要人确认，`allowSession` 不豁免；10 分钟未答复、回合中止、通道缺失或断连按 deny，拒绝以可读文本作为工具结果返回模型。`allow` 放行一次；`allowSession` 按 kind + 工具名缓存，从 full 切回更严档位清空缓存；切档位不自动答复已有请求。
  - worker 先发 `approval-request`（kind / title / detail / expiresAt）给 Main 登记，再发 `approval_request` 会话事件；请求等待 `allow` / `allowSession` / `deny`。Main 校验 session / request id、generation、有效期与一次响应，维持 `waiting-approval` 并推送 `sessions:approval-request`；Stop、超时、结算、销毁时撤下请求，迟到 / 重复 / 旧 generation 答复不能执行工具。OS 桌面审批通知继续遵循 `askAndApproval` 偏好并按 request id 去重，不等待启动静默期或合并窗口，聚焦当前会话也提醒一次；点击只定位会话。
  - Renderer 保留会话内审批卡和三档权限选择，只移除 App 顶部跨会话全局审批横幅及其详情弹窗（ApprovalAttention）。`tool_notice` 仅保留历史解析兼容，新执行路径不以通知替代审批。持久化 `waiting-approval` 沿用重启后归 idle 的恢复规则（原 worker 已不存在），不重放未执行的旧工具；实时等待状态保持真实审批状态。源码修改不会热更新已安装应用或原进程里的待答复调用。
- 编排工具（仅 orchestrator 角色，pi `ToolDefinition`，参数 schema 完整类型，归一化先于校验）：
  `dispatch_task { title, spec, role?, workflow?, depends_on?, model?, thinking?, fast? }`（`workflow` 与 `role` 互斥，见 §7.13；`role` 是普通字符串而非枚举，`workflow` 参数始终存在，即使 spawn 时没有工作流；spawn 时的清单只用于描述和名称归一，清单外的值原样交给 Main，按当前注册表实时解析：角色依次按 id → 不区分大小写的 id → 不区分大小写的名称匹配，找不到时错误列出可用的非编排角色 `id (名称)`，编排角色仍拒绝；工作流同理）、`list_workers`、`wait_for_workers { timeout_ms, until: 'any' | 'all' }`、`read_worker_output { dispatch_id, cursor? }`、`send_to_worker { dispatch_id, body }`、`review_diff { dispatch_id }`、`run_checks { dispatch_id, command }`、`merge_worktree { dispatch_id }`、`reject_work { dispatch_id, feedback }`、`cleanup_worktree { dispatch_id, abandon? }`。
  工具不直接操作 git / 进程，而是调用注入的 `OrchestrationHost` 接口（由 Main 实现）。`OrchestrationHost` 的方法名与上述工具一一对应。
  `write_plan { title, content, file? }`（§7.10）也注册给 orchestrator 策略的会话（`readonly` / `all` 策略的非 worker 会话提供了 `planMode` 时同样常驻），但不属于这组映射：它在 agent 进程内直接写 `<cwd>/.fynvra/plans/`，不经 `OrchestrationHost` / Main，不进 `ORCHESTRATION_TOOL_METHODS`，也不进审批门的分类。`write_doc { path, content }`（§7.10）只注册给 orchestrator 策略的会话，同样在 agent 进程内直接写文件、不经 `OrchestrationHost` / Main、不进 `ORCHESTRATION_TOOL_METHODS`；只在计划模式开启时可用，且与 `write_plan` 不同，审批门把它归为 `file-write`，按角色的审批档位处理。计划模式开启时（`createOrchestrationTools` 的 `planMode`）`dispatch_task` 返回错误、不调用 host，错误文本提示用 `write_doc` 写用户要的文档，其他编排工具不变。
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
写操作沿用 `orchestration:changes-action`：shared `types/orchestration.ts`、Main `ipc/orchestration.ts` / `services/sessionChanges.ts`、typed preload / Renderer API 同步限定 stage / discard，支持单文件或全部改动，拒绝其它动作及额外字段。Main 复用登记来源、真实 root / common-dir / 路径 / 符号链接边界，以独立 argv 执行暂存或丢弃；枚举已暂存、未暂存及未跟踪改动，返回 no-changes / applied 结果。写入结果与后续刷新分开，读取失败不冒充写入失败；只读查询仍不写 index。
Renderer `ChangesView.tsx` / `ChangesActionDialog.tsx` 与中英文字典提供统一应用内 Dialog 的丢弃确认，取消默认聚焦，操作中防重复、失败留窗；未提交区仅保留全部暂存（+）与全部丢弃（Undo）两个批量操作按钮，暂存明确提示尚未提交。丢弃确认显示来源 / 分支，并按单文件或全部范围说明会丢弃已暂存、未暂存及未跟踪改动；成功按原来源刷新未提交区、提交记录及已打开 diff，刷新错误保留操作结果。历史 dispatch 来源只读，不新增任意路径或命令接口。

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

**工作流任务**（`dispatch_task` 带 `workflow`，定义与推进见 §7.13）：
- 节点之间由 Main 在 `report_done` 结算后自动调度（并行、隔离与汇合合并见 §7.13），任务保持 `in-progress`。只有整张图全部通过（→ `in-review`）或失败（无可退回目标、超过回退上限、节点启动失败 → `failed`）时才向主 agent 发 `worker_done`；主 agent 照常对集成 worktree review_diff / run_checks / merge_worktree。
- 对工作流任务（in-review 或 failed）执行 `reject_work`：从起点节点开始整图重跑，反馈写进各起点节点的任务书，`rounds` 归零、历史保留；现有守卫（待答复提问检查、dispatch 校验等）不变。
- 崩溃恢复依赖持久化的节点状态与待启动意图：先写意图再启动节点；服务加载 / 对账时发现 in-progress、有未执行意图的任务，重新执行该推进，不能卡死在 in-progress。任务已被放弃 / 清理时不再推进。（W2 之前的串行引擎用 `Task.workflow.pending`。）

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
- UTF-8 文本编辑最多 256 KiB，使用按需加载语言的 CodeMirror；Markdown 默认只读预览，可切换源码编辑或双栏，预览复用 GFM 渲染组件；文件预览可呈现经 HTML 解析后白名单过滤的语义标签与对齐，不执行脚本或文档 CSS（聊天默认不解析 HTML）。相对图片按源文件目录在 Renderer 解析，通过所属工作区的 `files:list` 查找条目 id，再经 `files:read` 获取已校验的本地栅格图像；不传路径、不放宽 CSP，引用失败显示 alt。本地文档链接复用条目解析并在本工作区打开。PNG / JPEG / GIF / WebP 预览最多 2 MiB，其他二进制和超限文件显示说明。独立 HTML / SVG 文件在文件树中仍仅按源码显示，不执行。
- PDF / DOCX / DOC 预览：按扩展名 + 魔数**同时**识别（`.pdf` 开头 `%PDF-`，`.docx` ZIP 头 `PK\x03\x04`，`.doc` OLE 头 `D0 CF 11 E0 A1 B1 1A E1`），不符时按原二进制处理；只对这三类把有界读取上限放宽到 32 MiB，超限显示“文件过大”。Main 返回 `{ kind: 'pdf'; data }`、`{ kind: 'docx'; data }`（`Uint8Array`，经结构化克隆传输，不转 base64）或 `{ kind: 'document-text'; format: 'doc'; text }`。PDF 在 Renderer 用 pdfjs-dist 渲染：动态 import 懒加载、`isEvalSupported: false`、中文所需 cMap 与标准字体打进渲染进程资源离线可用（不走 CDN），Worker 加载失败回退主线程模式。DOCX 在 Renderer 用 mammoth（懒加载）转 HTML，经 DOMPurify 白名单过滤（只留语义标签、表格与 data: 图片，去掉脚本、事件属性、样式表和外部资源；链接规则同 Markdown 预览）。DOC 在 Windows 上由 Main 调用本机 Word COM 转成 DOCX，再走同一条 mammoth + DOMPurify 渲染（`{ kind: 'docx'; convertedFrom: 'doc' }`）：只在 `files:read` 预览路径触发（保存前的冲突检查不启动 Word）；字节先复制到 `userData/cache/doc-preview/tmp/<随机>/`，Word 只打开这份副本，不在工作区产生锁文件或最近文件记录；PowerShell 用绝对路径，常量可读脚本写入同一临时目录的 `convert.ps1` 以 `-File` 执行（不用 `-EncodedCommand`），路径经环境变量传入，装有 Office PIA 导致参数绑定失败时改用 `InvokeMember` 晚绑定重试；打开前强制 `AutomationSecurity = 3` 禁用宏（失败即不打开），只读、不进最近文件、固定假密码使加密文档直接报错，不修改持久化的 `Options.*`；全局串行、同内容去重，90 秒超时结束 PowerShell 进程树及脚本报告的那个 WINWORD PID；结果按 sha256 缓存为 `<hash>.docx`（命中校验 PK 头与 32 MiB 上限，按 mtime 淘汰，至多 64 个 / 512 MiB）。非 Windows、无 Word（本次运行内记住）、转换失败或超时，回退为 Main 用 word-extractor 提取文字（`document-text` 带 `conversion: 'unavailable' | 'failed'`），只读显示并注明原因。文档里的外部链接或远程模板仍可能被 Word 访问。三种都不可保存：保存只接受 `text`，`document-text` 不是可编辑文本。不放宽 CSP、不开 `webPreferences.plugins`、不执行文档脚本；解析失败显示可读错误。只是应用内预览，不让 AI 工具读取 Word / PDF。
- 预览内 Ctrl / Cmd+F：Markdown、DOCX、DOC 预览在预览区右上角打开查找条（双栏模式下焦点不在 CodeMirror 时），不区分大小写、跨文本节点匹配，用 CSS Custom Highlight API（`CSS.highlights` + `::highlight()`）高亮，不修改 React 管理的 DOM、不插 `<mark>`；Esc 关闭并清除高亮。源码模式仍用 CodeMirror 自带搜索。PDF 页内查找不做。
- 中央标签栏内容溢出时，纵向滚轮换算为横向滚动（按着 Ctrl、横向分量占优或无溢出时不拦截），拖拽排序不变。
- 聊天 assistant 的 Markdown 链接按消息 `sessionId` 绑定 workspace / cwd；原始 href 只按 AST 节点弱关联供受控按钮解析，DOM 只放行显式 http(s)，原始 HTML 仍不执行。仅显式点击时经 `files:list` / 已签发顶层 id 的 `files:resolve` 获取实际 root 并逐级按名称解析，不用缩写的 displayPath 猜根目录；普通文件复用原工作区 tab / hydration / 草稿，Markdown 默认预览。支持相对 cwd、Windows / POSIX 绝对路径、file URL、中文与空格编码和 `:line[:column]`；纯锚点、未知/危险协议、越界和网页 query/hash 明确报双语错误，不作为 DOM 导航。
- 聊天中的 `.html` / `.htm`（忽略大小写）走 `files:open-html`，只收 `{ workspaceId, entryId }`，Main 重新检查登记 root、realpath、文件类型与扩展名，拒绝符号链接/网络主机，再由 `pathToFileURL` 编码后交给 `shell.openExternal`。没有通用的任意路径/URL IPC、应用内 HTML 执行或本地 HTTP server。唯一例外是 `files:open-outside`：入参严格为 `{ sessionId, reference, action: 'open' | 'reveal' }`（拒绝多余键，reference ≤ 4096），仅在点击解析为工作区（或 worktree root）之外的绝对路径时使用；Main 要求会话存在（不校验 reference 是否出现在消息正文），按 `src/shared/chatFilePath.ts` 同一规则重新解析，只接受本平台绝对路径（Windows 盘符 / POSIX `/`），相对路径、UNC 与设备路径（`\\server`、`//server`、`\\?\`、`\\.\`）在解析、`path.resolve`、符号链接目标与 `realpath` 后均拒绝，路径须存在。目录用 `shell.openPath` 打开；文件 `reveal` 用 `showItemInFolder`；文件 `open` 仅白名单扩展名（png/jpg/jpeg/gif/webp/bmp/ico/tif/tiff/avif、pdf、txt/md/markdown/log/json/yaml/yml/toml/ini、mp3/wav/ogg/flac/m4a/mp4/mov/webm/mkv/avi、docx/xlsx/pptx，按 realpath 判断；svg/xml 可能由浏览器执行脚本、csv/tsv 有公式注入风险，不在白名单）交给 `shell.openPath`，其余一律只在文件夹中显示并返回 `revealed`，绝不执行可执行或脚本类文件；日志不写路径。相对链接的 session cwd 不在文件服务 root 内时（含外部 worker worktree），明确提示不支持；没有可信 cleanup 映射时绝不回退主工作区同名文件，明确指向原 workspace 的绝对链接仍可打开。此变更仅涉及聊天链接组件/helper、files shared/Main/preload、字典与回归测试，不改变持久化、worktree 生命周期或 loading。
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

- 作用范围：命令 / Git 子进程与内置 `web_fetch`（§5，用会话加载时的环境快照）。不读 Windows 系统代理或 PAC；模型 API、MCP 和应用更新的流量仍不走这个设置。

- 通用设置 `preferences.networkProxy` 仅包含模式（默认沿用进程环境）、无认证 HTTP/HTTPS 代理地址及 Git 兼容开关；两端严格校验，恢复默认删除覆盖。手动模式统一 HTTP_PROXY/HTTPS_PROXY 的大小写值，清除 ALL_PROXY，并清空 NO_PROXY（不继承绕过规则）。兼容模式仅设置 HTTP/1.1 与 Git protocol v0，不降低 TLS。
- 纯环境转换 helper 只复制子进程环境，以 GIT_CONFIG_COUNT/KEY/VALUE 追加命令级 Git 配置并保留已有项；非法已有计数/缺项时安全失败，不记录配置内容。不改 process.env、gitconfig、系统代理或 profile。Main 新 Git / run_checks 命令现读设置；新 PTY 和新建/恢复的 Agent session 获取配置快照，已有进程不重启。
- Main → Worker `SpawnSessionSpec.networkProxy` 为相同受限字段，双端解析；pi 官方 shell spawnHook 在 session metadata 注入后转换环境，保留默认工具集、角色限制和审批门，git_readonly 的 exec 同样接线。模型 API、MCP 和应用更新不因此改路由。
- `settings:test-network` 仅接收严格校验的当前配置草稿，Main 固定探测 GitHub API HTTPS 与公开项目仓库的 HEAD（git ls-remote），无 fetch/push、无凭据交互；`settings:cancel-network-test` 无参数。每窗口最多一个检测，替换/取消/关闭时中止，有限超时，响应仅含分项状态码与 HTTP 状态，不返回原始错误或环境。Renderer 在草稿/保存设置改变或卸载时使旧结果失效。检测只说明连通性，不证明 push 权限；仅用户点击触发。

### 7.8 上下文自动压缩

压缩策略默认为 Magic Context，显式 native/off 保留。压缩照 oh-my-pi 的 `runAutoCompaction` 按方法链执行：`src/agent/compaction/methods.ts` 是唯一的方法注册表，默认顺序 `remote → snapcompact → handoff → shake → soft`，当前注册 remote、snapcompact、handoff、shake 与 soft 全部五个方法，未注册的方法缺席即跳过；新增方法 = 新增 `compaction/<name>.ts`（或独立目录）+ 一条注册项。每个方法是 `(ctx) => Promise<CompactionResult | 'skip'>`，抛错、skip 或结果未减少上下文（`estimatedTokensAfter >= tokensBefore`）都交给下一个方法；整轮失败后再以激进阈值跑一轮。链通过 `session_before_compact` 返回结果，全部失败时返回 cancel（不让 pi 退回默认摘要）。shake 不调用模型：按 pi 公开的追加式 `appendContextEdit` 把受保护最近尾部（默认 16k、激进 4k token，且不超过窗口的 20%/5%）之外的大工具结果替换为占位（工具名、参数摘要、原大小，并说明重新运行工具或重读文件即可恢复），同一文件被后续读取覆盖的旧结果优先，从不改用户/助手文本；只有能降到阈值的 80%（激进轮为阈值本身）才落盘，并返回保留全部历史的 compaction 结果，由 pi 正常提交并刷新上下文。soft 是稳健模型摘要：窗口 ×0.8 减输出预留与上一份摘要作为输入预算，超出时按消息边界分窗折叠、单条超大消息截断、服务商超窗时预算减半重排、429/5xx/超时/中转「繁忙/限流/稍后」重试两次，不发送 reasoning（无法关闭时取最低档）。remote 是服务商原生压缩：只在当前模型走 Anthropic Messages 官方端点（`api.anthropic.com`，含凭据上的 baseUrl 覆盖）且模型支持按需压缩（`compact-2026-09-04` beta：Opus/Sonnet ≥ 4.6、Fable/Mythos ≥ 5，同 oh-my-pi）时使用，用 pi 运行时凭据直接 POST `/v1/messages` + `compaction: summarize`，返回的 compaction 块 `content` 是可读摘要，直接作为 pi 摘要，不重放签名块（pi 没有对应线格式位置），换模型后摘要仍有效；中转/网关、订阅 OAuth token、其他协议、单次请求放不下的历史都 skip。OpenAI `/responses/compact` 只返回必须在后续 Responses 请求中重放的加密条目，作为文本摘要无意义、换模型即丢失历史，因此 OpenAI 也 skip。失败只记 HTTP 状态，不记响应体。handoff 让模型为后继实例写交接文档（oh-my-pi 提示词改写，MIT 署名在文件头）作为摘要，与 soft 共用 `robustSummary` 的预算、分窗、超窗减半、瞬时重试与不发 reasoning，只换提示词。日志只记方法与失败类别，不记 prompt、摘要或 provider 原始错误。原生模式始终使用该链；Magic 健康时取消原生压缩，Magic 在某会话停止（任何原因）后，该会话改为链：context 变换直接放行（挂起的 Magic 钩子不再生效）、通过公开 `setAutoCompactionEnabled(true)` 开启 SDK 自动压缩，发出非阻断 `warning`，快照 effective 变为 native，持续到会话重载。压缩失败（链全失败、超时）不上锁：发固定文案的非阻断 `error`，本轮停止自动继续（宿主请求门拒绝本轮后续请求，并暂停自动压缩以免同一轮再次触发），下一条提交的输入清除该状态并再次触发压缩；`recoveryRequired` 只保留给旧版本留下的 `blocked` checkpoint 及其显式恢复失败。Magic 模式在健康时由宿主取消原生摘要钩子。宿主通过公开 `abortCompaction` / `abort` 中止请求，在 `agent.transformContext` 前后校验 Magic 就绪状态、取消代际与恢复锁，并在 `agent.prepareRequest` 前后再次校验恢复锁。原生模式仍展示压缩阶段、deadline、取消来源与阈值。未消费输入由宿主保留，已写入 pi 历史的输入不重复提交；Stop 不自动恢复，失败不改写旧历史。

snapcompact（`src/agent/snapcompact/`，移植自 oh-my-pi，MIT）不调用模型：把被压缩的历史用 pi 的 `serializeConversation` 序列化，接在上一份 snapcompact 存档文本之后（上一份是文本摘要时作为开头的摘要），用纯 TypeScript 渲染为 1-bit PNG 文字帧（内嵌公有领域 X11 misc-fixed 8x13 字体，`node:zlib` 编码）。帧形：Anthropic `11on16-bw` 1568px，Gemini `8on22-bw` 2048px，其余 `8on22-bw` 1568px；帧宽固定、高度贴合行数（最低 64px）。预算：每次请求最多 20 帧（未知线协议 5 帧）、base64 合计 ≤3MB、帧 token 估算 ≤ 阈值的 50%（激进轮 25%），超出时保留首帧与最新帧、丢弃最旧的中段并在摘要里注明丢弃字数。帧与存档文本存在 compaction 条目的 `details.snapcompact`（随 pi jsonl 持久化），始终注册的 `context` 扩展钩子在每次构建上下文时把最新 compaction 的帧作为 `custom` 图片消息插在压缩摘要之后（按当前模型的帧数与字节预算取最新帧）；当前模型不收图片时改为附上存档最新 40k 字符的文本。仅当前模型 `input` 含 `image` 时可用。字体只有 Latin-1：超过 5% 的字符无法绘制（如中文为主的会话）时 skip，交给 handoff/shake/soft 的文本摘要，避免中文被印成 `?` 丢失；比例以内的少量无法绘制字符印为 `?`，摘要提示模型需要时回读源文件。日志不记录消息正文。

分层与必改文件：core 事件类型 → agent-runtime normalize → shared unknown parser → agent piSession / supervisor → Main agentHost 快照与 sessions IPC → typed preload；Renderer 只消费快照并传 sessionId。`preferences.compactionTimeoutMs` 是原生压缩总超时，默认 10 分钟、合法范围 30 秒至 30 分钟，spawn 时取快照；策略与超时在新加载（包括显式恢复重载）/重启生效。旁路状态参与 seq 但不推进灰字建议活动轮次；四种 SessionStatus、最终 agent_settled、generation、审批/编排结算不变。当前 context 使用 resolved model 窗口与 SDK getContextUsage，压缩后 tokens:null 明确未知，不复用旧用量、不改变窗口、不与累计计费混合。不改网站、SDK/node_modules、Magic 算法，不新增普通手动压缩入口，只提供失败恢复操作。

- 原生生命周期使用 `compaction` / `retry` 事件与 `context_runtime.snapshot` 旁路快照；`operationId` 是每次压缩独立生成的 UUID 标识，不因重建实例或 worker 而复用，`startedAt` 只表示时间。Main 以 sessionId/generation 丢弃旧实例事件，并将 worker 每代 seq 重写为当前 Main 生命周期内跨 generation 单调递增的会话 seq。Main 的 `SessionSummary`、get/history 返回 `contextRuntime` 及对应的 `contextRuntimeSeq`；未加载或卸载后不声明引擎已生效。列表/历史迟到响应必须按该 seq 与实时事件比较。history 另可返回 `contextRecovery?: { recoveryRequired: boolean }`：只读当前 jsonl 分支最后有效的恢复 checkpoint，不包含正文或引擎信息；无 checkpoint 省略，已完成恢复返回 false。冷 history 始终返回读取开始前捕获的 `contextRuntimeSeq` 水位（新 Main 为 0），不用读取结束后的新 seq 标注旧磁盘结果。加载中或读期间有新 live 事实时省略冷提示，存在真实 runtime 则优先返回 runtime 及其对应 seq。list 不为此读全量文件，sessions.json 不存恢复提示。快照分开记录 configured/effective 策略（Magic 故障后 effective 为 native，表示已改用回退链；recoveryRequired 只表示回退链也未完成）、timeout、实际 contextWindow、SDK tokens 或明确 null、原生实际阈值，以及恢复锁/未消费输入数。
- `sessions:retry-compaction` / preload `sessions.retryCompaction(sessionId)` 仅接收会话 id。Main 互斥接受后立即 ACK，压缩及恢复结果由事件结算；未加载或 worker 退出后也可仅凭 sessionId 加载原 jsonl，由真实 worker 检查 checkpoint，没有恢复锁则清晰失败、不压缩普通 idle 会话。内部 requestId 将载入与恢复完成绑定为同一个互斥操作，匹配的 worker result 才释放；Stop 作废载入令牌，并在 worker 等待 opening 的边界复验取消代际，迟到 spawn/result 不启动恢复。加载失败不改 checkpoint、历史或未消费输入，effective 引擎只由真实加载实例发布。原生压缩成功前 provider 请求被锁住；Magic 只在显式恢复期间允许进入受保护的 context 处理，未就绪或变换失败仍拒绝请求，恢复原输入期间 UI 队列只暂时等待：运行、压缩/退避、恢复锁及宿主未消费输入都阻止投递；恢复完成、pending 归零且会话不再运行（idle 或 error）后自动按 FIFO 继续。恢复失败只等待显式恢复，不自动重试。UI 队列没有手动暂停：每轮结算后（正常结束、报错或用户 Stop）自动发出下一条，Stop 请求在途时等它返回再继续；待审批、prompt 在途同样只是暂时等待。未确认的 prompt 失败把消息放回队首并提示错误，但不立即重试，等下一次会话结算、新发消息或队列项「立即发送」再继续，避免持续失败的会话死循环；会话空闲但队列非空时，新消息排到队尾并触发发送，不插队。宿主将未消费输入及恢复锁作为 `fynvra-context-recovery` custom entry 保存于 pi jsonl；持久 `blocked` 标记贯穿压缩成功后的原输入恢复阶段，只有恢复完成才清除。`resumeCompactionId` 仅用于原生模式，关联当前分支上已提交的压缩边界，重载后仅由新的显式操作继续原输入，不重复压缩已经缩短的上下文；后续压缩失败会清除此边界。Magic 恢复会重新加载同一 jsonl/SQLite，supervisor 等旧实例 dispose 完成后才打开新代。确有中断轮次或未消费输入时，由 context 钩子重新变换并校验就绪/取消状态，完整 run 成功结算后才解除持久锁；SDK transient 重试的中间错误不提前上锁，只认归一化最终 error / agent_settled，Stop 与真正 Magic 故障立即阻断。纯空闲/初始化故障没有待继续的任务时，直接通过公开、受保护的 `transformContext(session.messages, signal)` 校验当前投影（包括空历史），不造输入、不调用 `sendCustomMessage` 或触发新的对话轮次；校验成功后解锁，后续后台 Magic 故障仍会重新暂停并保留恢复锁。两条路径都不把旧 native checkpoint、插件 ready 或旧 marker 当作已完成恢复，不调用 `session.compact()`；若重载后 Magic 仍未就绪，会话改用回退链，按原生路径恢复（仅在超过阈值时压缩，小会话直接继续原输入）。依据 SDK user message_end（持久化之后记录消费）区分已写和未写，不依赖 Renderer 重发。已写的中断输入通过公开 `sendCustomMessage(..., { triggerTurn: true })` 发一个 `display:false` 的 `fynvra-compaction-resume` 控制标记继续完整 run；标记不是 user entry，不进入普通聊天投影或用户消息计数，原 user 不再写一次。仍未消费的原输入由后台补发一次。所有恢复只由显式操作开始，Stop 不自动继续。

本轮修复的行为差异：Magic 只在 historian 校验并发布后记录成功；超时、最终校验/无进展与存储失败按会话退役，Stop/关闭只取消。Agent host 与 vendored 插件共同为异步操作绑定会话取消代际，在 SQLite、context 返回及 marker 追加处复验，防止退役或关闭后的迟到写入。预算使用当前模型的保守 UTF-8 字节估算并按完整块切分，不截断 XML。必改范围为 `src/agent/magicContext.ts` / `piSession.ts`、vendored Magic、会话 warning / suggestion 投影及本节文档；不改变工具审批、权限、官网、Fast 或模型路由配置。

- 通用设置 `preferences.compactionStrategy` 有 `magic-context`（默认）、`native`、`off` 三种；`settings:update` 严格校验枚举，旧记录缺省或磁盘上的非法值按 `magic-context` 读取，合法 native/off 不被覆盖。显式 `native` 沿用 pi 原生自动压缩及其阈值 / 保留量默认值。
- Main 每次构建 spawn spec 时读取保存的设置，始终显式传递 `SpawnSessionSpec.compactionStrategy`（包括 native），worker 也独立解析缺省为 Magic。每个会话新建内存 `SettingsManager`，只有显式 native 开启 SDK `compaction.enabled`，Magic/off 均关闭；Magic 会话回退后由宿主通过公开 `setAutoCompactionEnabled(true)` 为该会话开启。Magic 内联扩展仍通过 context hooks 执行正常后台分段和注入；摘要一律由回退链生成，不调用 pi 默认摘要。主会话、worker、重启恢复使用同一策略解析；每个会话独立暂停，不影响其他会话。
- Magic Context 固定为 `@cortexkit/pi-magic-context` 0.41.3（MIT），资源在 `packages/agent-runtime/vendor/magic-context/`：只保留扩展入口、storage/core、日志/路径所需分片、TUI 桩与许可证，不包含 OpenCode/OMP TUI、子进程 runner、dreamer/sidekick/memory/embedding/quickjs/transformers 分片。打包时固定从 `resources/magic-context` 解析，开发时固定从 `app.getAppPath()/packages/agent-runtime/vendor/magic-context` 解析；资源缺失就暂停 Magic 会话并提示恢复，不回退到 `process.cwd()` 或用户工作目录里的副本。不扫描外部扩展，不读本机 `~/.pi` / `~/.config/cortexkit`，不迁移或共享终端 Magic 数据库。
- 插件数据全部在应用目录：配置 `userData/magic-context/config/cortexkit/magic-context.jsonc`，SQLite `userData/magic-context/storage/context.db`，historian dump `userData/magic-context/artifacts/`，日志 `userData/magic-context/magic-context.log`。配置只读 Main 生成的固定文件，缺失/损坏不扫描终端或工作区、不降为启用可选功能的默认配置；禁用旧终端 DB 迁移、终端 tokenizer 搜索、window overlay 与 CortexKit wake 服务探测。生成的配置关闭 dreamer、sidekick、跨会话 memory/auto-search、embedding 与 todowrite；`ctx_search` 显式关闭 memory/embedding/git 检索，smart note 条件因 dreamer 关闭而不可用。环境变量在 worker 生命周期内固定，不按会话 `chdir` 或改 env。
- Historian 不启动终端 pi 或 Electron 子进程：vendored 插件的 `PiSubagentRunner` 交给 `src/agent/magicContext.ts`，后者按 Pi session id 路由到该会话的模型 getter 与中止信号，用会话自己的 `ModelRuntime`/model 在进程内完成请求。路由表没有“当前会话/当前模型”的进程级全局值；并发会话各有自己的条目与 in-flight 标记。每次 historian 使用请求开始时的当前会话模型；换模型和 Stop 使旧操作失效，下一次重新计算预算。单次超时默认 180 秒、硬上限 5 分钟，SDK 返回 aborted、抛异常或未及时结束都经过同一 deadline 分类；真正的会话取消不计故障。请求无工具、`maxRetries: 0`，由 vendor 有限重试同一个当前模型，不把占位模型名当作真实 fallback 模型。
- Historian 预算由 host 的当前 `ResolvedModel.contextWindow/maxTokens` 给出：用 UTF-8 字节数保守估算文本 token，扣除实际 system prompt、至少 2048 token / 窗口 5% 的 framing 预留，以及不超过模型上限、窗口 20% 和 32000 的输出额度。Vendor 按完整块的字节数切分，计入 reference/user prompt 开销后最多再调整三次，host 发送前复核；小于 1024 的输出 cap、无效窗口或不可拆分的超大块明确暂停会话并提示恢复，不截断 XML。此估算针对已支持的 byte/subword tokenizer，不能保证未知 provider 模板或错误模型元数据下的绝对上界。插件自身的调度/历史衰减仍使用上游字符估算；不加载、搜索或安装 `ai-tokenizer`。密钥只在 Main → worker 的 spawn 路径及会话 `ModelRuntime` 内存，不写插件配置或命令行。
- Magic 自己处理 tag、drop、historian 结果与 `<session-history>` 注入，并把 compartment 写入自己的 SQLite；pi jsonl 仍是权威源，Magic 只追加自己的 compaction 标记，不删除原始对话，Fynvra 历史投影不依赖 Magic 数据。Magic 的 `ctx_*` 工具只操作它自己的上下文存储，不新增命令执行、工作区文件写入或网络能力；角色原有的 bash/文件/MCP 工具白名单和审批档位仍由 Fynvra 决定。默认不启用 Dreamer/Sidekick/跨会话 memory/语义 embedding，也不会下载 embedding 模型。
- 生命周期：插件绑定前建立会话路由；用宿主自有空 facade 转发 SDK 1.4 API，保留方法 receiver，避免冻结对象的 Proxy invariants。仅在 boot ready、`session_start` 成功、historian 配置/路由及模型预算可用后接管；部分注册、缺少启动报告或迟到 boot 均不接管。成功只指 historian 的 XML/覆盖范围校验通过并提交 compartments/drop 队列/marker 状态，单纯 HTTP 成功不会清零失败计数。Transient 请求至多三次，验证只修复一次；最终校验失败、无进展、存储/发布或 context 故障按会话退役。`session_before_compact` 在 Magic 健康时取消（含 vendor 自己的取消钩子，经宿主 API 包装），启动失败前也有宿主钩子；Magic 停止后不再取消，交给回退链。服务商报告超窗时停止 Magic，由回退链压缩后重试。
- 每个插件 hook、`ctx_*` 工具及其派生后台任务通过 `AsyncLocalStorage` 携带会话取消代际；SQLite 执行、延迟索引、marker 追加、await 后的 context/historian 发布与返回都复验。Context 在副本上变换，失效时丢弃；Stop/换模型同步释放 historian 租约与预算预留并使旧操作失效，dispose 在等待 Pi shutdown 前中止并清路由/ready/suspended。退役也停止新注入和 marker 排队，旧 shutdown 不清掉替代会话的状态，其他会话不受影响。已有 marker 保存上游衰减渲染的累计历史快照；不删除或改写 pi jsonl 原始消息。
- Magic 故障通过既有 `warning` 的受控 reason 枚举展示，每个实例只告警一次；会话不上锁、不 abort 当前请求，Renderer 显示可关闭的「已自动改用标准压缩继续」提示，只有 recoveryRequired 时才显示恢复锁说明，不把 prompt/provider 原始错误传给 Renderer。可关闭警告不解除恢复锁，关闭状态仍按会话/seq 保存。Main 的 `compaction-warning` 桌面通知沿用通知设置、seq 去重、节流与聚焦规则。Warning 本身不推进对话轮次，但故障/中止会使本轮建议失效，不复活旧轮建议。`fail_closed_blocking: true` 配合宿主请求门，即使 SDK 吞掉扩展异常也不能发送原始上下文或启用 native；Fynvra 不注册终端插件命令/快捷键或持久化终端 status 错误。修复问题或换用更大窗口模型后，使用既有「重试上下文恢复」按钮重新加载 Magic；恢复按钮只传 sessionId，启动失败仍保留 checkpoint 和待处理输入。
- 启动契约回归：Main 生成配置、worker adapter 与 vendored `loadFynvraConfig` 必须一致要求 `fail_closed_blocking: true`，其余 compression-only 字段与 schema 校验不放宽。`src/agent/magicContext.integration.test.ts` 由普通 `pnpm test` 发现，每个场景在独立 Electron 45 的纯 Node 子进程中执行（`ELECTRON_RUN_AS_NODE=1`，无 GUI；使用随应用交付的 SQLite/FTS5，避免宿主 Node 22/23 编译选项差异）。开发路径和按 `electron-builder.yml` 复制的临时 resources 路径均运行真实 Host → adapter → SDK → vendor → SQLite / session_start → 首条离线 prompt；仅替代 Electron app 路径边界和模型外部依赖。断言 Magic 标签与数据库一致、正常回复、无 warning/recovery/native 回退、pi 正文 user 不重复；false 与非法 schema 必须让 Magic 不接管：会话发出 warning 并改用回退链，首条 prompt 不带 Magic 标签照常送达、不上锁。临时 userData、agentDir、工作区和数据库均隔离，子进程退出后清理；失败场景不声称首次 message 前的 checkpoint 已落盘。
- 尚未做真实长会话的现网压缩验证；historian 是额外的模型请求，按会话当前模型计费，插件自带的状态/命令 UI 在 Fynvra 中不可达。

### 7.9 输入框回复建议

- 一轮真实 AI 回复正常 `agent_settled`（未中止、未出错）后，Renderer 仅在当前选中会话、输入框空闲、没有队列 / 待审批 / 图片 / 未发送草稿时，调用 `sessions:suggest-reply`，只传 `{ sessionId, roundId }`（roundId 是该轮 settled 事件的会话级 seq）。切换历史会话、重渲染、流式 token、普通打字都不触发新请求；同一轮（含空结果 / 失败）只请求一次。
- Main 核对记录状态、未归档、没有待审批、`live` 仍空闲且 `lastSettledSeq === roundId`，再经既有 AgentCommand 通道让 worker 生成；Main 只保留最近轮次标记与有界的在途表（同时最多 2 条），不缓存对话正文，不把 key / 端点返回 Renderer。
- worker 用该会话当前的 `ResolvedModel`（含换模型后的模型）在 live `AgentSession` 上另发一次独立、无工具、`maxRetries: 0`、约 8 秒超时、输出上限 256 token 的 `completeSimple` 请求；不传 `reasoning`，Anthropic 等支持的服务走非思考分支、不会再追加 2048 思考预算（该上限是输出预算，请求本身仍按正常 token 计费）。不调用 `session.prompt`，不写 pi jsonl / 消息历史，不派 worker、不执行工具。上下文只取最近 8 条 user / assistant 纯文本（总计约 8k 字符，单条约 2k；最新优先，assistant 保留尾部），要求预测用户的下一句话、跟随最近用户语言、空建议表示不展示，并禁止 markdown、多候选以及替用户同意删除 / 发布 / 付款 / 权限变更等破坏性确认。
- 建议结果带 `requestId`、generation、sessionId、roundId 回 Main；Main 再核对轮次 / 状态并清洗成一行至多 200 字符。`prompt` / `steer` / `setModel` / `abort` / 删除 / 归档 / worker 崩溃都会取消在途请求或丢弃迟到回包；worker 生成前后都核对 generation、回合计数与空闲状态。失败、超时、取消一律静默返回空建议，不影响主聊天状态。
- Renderer 的灰字建议与 draft 分离：不进入草稿、不使发送按钮可用、不被 Enter 发送；只有建议可见、无修饰键、未组字（`isComposing` / composition / keyCode 229）、无选区且光标在末尾时，右箭头才把建议写入本会话 draft 并把光标放到末尾，不自动发送。Esc 忽略本轮且不重新出现；草稿是建议前缀时只显示剩余灰字，不匹配的普通输入立即隐藏；运行中、错误、队列、审批、图片、历史浏览时不显示。
- 灰字层复用输入框排版与明暗主题，`pointer-events-none`、`aria-hidden`，另用简短 live region 提示右箭头采纳；长建议截断并随输入框滚动。不改正常对话 prompt / 工具 / thinking / Fast，不新增通用设置开关。

### 7.10 计划模式

- 行为差异：
  - 开关：按会话的「计划模式」开关，所有角色的会话都可用，只有派发出的 worker 会话不可用。入口在输入框工具栏、审批档位选择器旁。新会话默认关闭，状态随会话记录保存在 sessions.json，重启、归档后恢复都保持。运行中也能切换：主 agent 的派发拦截立即生效，提示词从下一次 run 起变化。
  - 计划目录：`<cwd>/.fynvra/plans/`。非派发会话的 cwd 是工作区仓库，即当前项目根目录，例如 `D:\project\Agent-Forge\.fynvra\plans\`，不是用户主目录；开关提示里写明「当前项目的 .fynvra/plans/」。
  - 文档：扩展名为 `.md` / `.markdown`（不分大小写）的 Markdown 文件。计划模式用来写计划和文档；代码、配置和其他任何文件在计划模式下都不会被改。
  - 主 agent（orchestrator 策略）开启时：专门写计划和文档。用户要写文档时用 `write_doc` 直接写到用户指定的路径（可在项目外，如桌面）。写计划时先读代码，再用 `write_plan` 把一份 Markdown 计划写到计划目录，包含目标、方案、任务拆分（每个任务的角色、文件归属、验收）、顺序与依赖、风险、不做的事；在回复里给出计划文件的链接请用户审阅，按反馈更新同一份文件。`dispatch_task` 被拒绝；已在跑的 worker 照常处理：回答、审查、合并、打回、清理。
  - 其他角色（工具策略不是 orchestrator）开启时：只做只读调查，用 `write_plan` 写计划，除 Markdown 文档外不能改文件。审批门收紧：write / edit / apply_patch 的每个目标路径都是 Markdown 文档时按原审批档位处理，不再加计划模式确认；没有目标或任一目标不是文档就直接拦截；`readonly` 策略不变（只有 `write_plan`）；bash / powershell 只读的命令（判定见下文 agent-runtime 一条）按原审批档位处理，其余不论档位都要人确认；MCP 工具不论档位都要人确认；保护底线不变，`allowSession` 照旧。
  - 审阅与执行：用户在应用内打开计划文件，预览或直接编辑。审阅通过后关闭计划模式：主 agent 先重读计划文件（用户可能改过），再按计划派发；其他角色不再受计划模式限制，按原审批档位执行。
  - 计划文件与 git：计划文件和写进工作区的文档都不自动提交；未提交时 worker 的 worktree 里看不到它，所以任务书仍须完整自足。要不要提交，或在 `.gitignore` 里忽略 `.fynvra/`，由用户决定；没忽略时计划文件会出现在「改动」里，「全部丢弃」会删除这些未跟踪的计划文件。
  - `write_plan` 的使用范围：主 agent 和其他角色的非派发会话都常驻；只能写计划目录，所以不走文件写入审批；计划模式关闭时也能用，供用户要求书面计划时使用。
  - `write_doc` 的使用范围：只给主 agent（orchestrator 策略），只在计划模式开启时可用；关闭时被拒绝，文档和其他文件一样由派发的 worker 写（行为不变）。审批门把它归为 `file-write`，按角色的审批档位处理（`supervised` 询问，`auto-edits` / `full` 不问）。
- 必改层与文件：
  - shared `types/{chat,agent,ipc}.ts` 与 Main 字典 `i18n/main/{zh-CN,en}.ts`：`SessionSummary.planMode?: boolean`，仅开启时为 true；`SpawnSessionSpec.planMode?: boolean`；AgentCommand `{ type: 'set-plan-mode'; identity; enabled: boolean }`，unknown parser 只认布尔；IPC 通道 `sessions:set-plan-mode`，入参只有 `{ sessionId, enabled }`。
  - preload `domains/sessions.ts`：`sessions.setPlanMode({ sessionId, enabled })`，返回 `IpcResult<{ session }>`。
  - Main `services/sessions/sessionStore.ts`、`services/agentHost/agentHost.ts`、`ipc/sessions.ts`：会话记录是权威。`setPlanMode` 镜像 `setApprovalMode`：更新记录和缓存的 spawn spec；会话已在 worker 里时发 `set-plan-mode`，发不出去就 detach，之后按记录重新 spawn；最后广播 `sessions:changed`。spawn 前按会话记录的当前值重设 `planMode`，会话启动途中切换开关也不会丢（`agentHost.ts` 的 `withPlanMode`）。派发出的 worker 会话一律拒绝，其他会话不看角色；worker 会话的 spawn spec 永远不带 `planMode`，也不继承父会话。
  - agent `supervisor.ts`、`piSession.ts`：supervisor 处理 `set-plan-mode`，接在会话的 opening 上，运行中也立即生效；piSession 持有开关的当前值，传给 createRoleSession。
  - agent-runtime `tools/orchestrationTools.ts`、`tools/writePlanTool.ts`、`tools/writeDocTool.ts`、`tools/documentPath.ts`、`prompts/orchestratorPrompt.ts`、`pi/extensions.ts`、`session/createRoleSession.ts`、`approval/`（审批门）、`index.ts`、`README.md`：
    `CreateRoleSessionOptions.planMode?: () => boolean` 每次读取实时值，缺省视为关闭；worker 会话不生效。
    orchestrator 策略：`createOrchestrationTools` 的 options 有同名开关：开启时 `dispatch_task` 返回错误、不调用 host，错误文本提示用 `write_doc` 写用户要的文档，其他编排工具不变。`createRoleSession` 在 `write_plan` 旁注册 `write_doc`。
    `ORCHESTRATOR_PROMPT` 增加 `write_plan`、`write_doc` 条目；新增 `PLAN_MODE_PROMPT`（标题为 `# Plan mode is on`），只在开关为真时，于每次 run 的 `before_agent_start` 追加到角色追加段之后。
    其他策略：提供了 `planMode`、工具策略不是 orchestrator、且不是 worker 会话时，常驻 `write_plan`（写 `<cwd>/.fynvra/plans/`）；计划模式开启时每次 run 都追加 `DIRECT_PLAN_MODE_PROMPT`，审批门（`approval/gate.ts` 的 `createApprovalGate`）按上面「其他角色」一条收紧：文档判定用 `tools/documentPath.ts` 的 `isDocumentPath`，apply_patch 的目标由 `approval/policy.ts` 的 `fileTargetsOf` 从补丁头解析；`DIRECT_PLAN_MODE_PROMPT` 写明可写改 Markdown 文档。只读判定 `isReadOnlyCommand` 偏保守：按 `;` `&&` `||` `|` 拆开后，每段的第一个命令都要在白名单里；只要含重定向、命令替换、PowerShell 脚本块等，就算非只读。agent 进程的 `piSession.ts` 总会提供 `planMode`，所以各角色的非派发会话都有 `write_plan`。
    `pi/extensions.ts` 的 `appendSystemPromptExtension` 也接受按 run 取文本的函数，返回空就不追加；pi 1.4 每个 run 都会复制一份新的 options，所以关闭计划模式后这段不会残留。
  - agent-runtime 新工具 `write_plan { title, content, file? }`：注册给 orchestrator 策略的会话，以及上面那类其他策略的会话；在 agent 进程内直接写文件；不经 `OrchestrationHost` / Main，不进 `ORCHESTRATION_TOOL_METHODS`，也不进审批门的分类。
    新建的路径是 `<cwd>/.fynvra/plans/<YYYYMMDD-HHmm>-<slug>.md`：slug 保留 Unicode 字母和数字，最多 48 个字符，为空时用 `plan`；重名时依次加 `-2`、`-3`……，独占创建，不覆盖已有文件。
    传 `file`（已有计划的纯文件名）时，先写同目录临时文件再 rename，整份替换。正文为 UTF-8，不超过 256 KiB；`.fynvra` 或 `plans` 是符号链接，或 realpath 越出 cwd 时拒绝。
    正文含 NUL 时拒绝，开头的 BOM 会去掉；`file` 含 Windows 保留字符（`<>:"|?*`）或控制字符时拒绝；更新已有计划时不会创建计划目录。
  - agent-runtime 新工具 `write_doc { path, content }`（`tools/writeDocTool.ts`）：只注册给 orchestrator 策略的会话；计划模式关闭时拒绝；在 agent 进程内直接写文件，不经 `OrchestrationHost` / Main，不进 `ORCHESTRATION_TOOL_METHODS`；审批门归为 `file-write`。
    新建或整份替换一份 Markdown 文档（`isDocumentPath`：扩展名 `.md` / `.markdown`，不分大小写），正文 UTF-8，不超过 256 KiB。`path` 可以是绝对路径、`~` / `~/…`（用户主目录）或相对会话 cwd（工作区根目录），可以在工作区外（如桌面）。
    工作区内缺少的目录会创建；工作区外目录必须已存在。目标已是目录、符号链接、junction 或其他非普通文件时拒绝。写入先写同目录临时文件再 rename（原子）；Windows 上遇 EPERM / EACCES / EBUSY 时退回原地覆盖。
  - Renderer `lib/api/sessions.ts`（含 mock）、`stores/sessions/createSessionsStore.ts`、`components/chat/PlanModeToggle.tsx`（挂在 `Composer.tsx` 的审批档位选择器之后）、`components/chat/toolDisplay.ts` / `ToolCallCard.tsx`、`i18n/{zh-CN,en}.ts`：输入框工具栏的开关在会话存在、且没有 `dispatchId` 时显示，不看角色；文案中英双语，提示写明计划在当前项目的 `.fynvra/plans/`；store 先乐观切换，失败时换回原状态并提示，再重拉列表；工具卡片把 `write_plan` 作为编排类工具展示，标签为「写计划」。
    `write_doc`：`toolDisplay.ts` / `ToolCallCard.tsx` 标签为「写文档」/ Write document，`stores/sessions/timeline.ts` 像 `write` 一样展示内容，`stores/sessions/reducer.ts` 把它映射为 `file-write`；`i18n/{zh-CN,en}.ts` 的计划模式开关提示和计划模式输入框占位文案提到文档。不改 Main / preload / IPC / shared 类型（只在 `src/shared/types/agent.ts` 加 JSDoc 注释）。
- 明确不做：「确认执行」按钮；计划自动提交，或把进度写回计划；计划与 Run / Task 的关联记录；快捷键；派发出的 worker 会话开启计划模式；按工作区记住开关；Main 侧的派发拦截（拦截放在 agent-runtime 的工具层，与审批门同层）；Markdown 以外的文档格式（.txt、.mdx、.rst、.docx 等）；计划模式关闭时的 `write_doc`；`readonly` 策略角色或派发的 worker 用 `write_doc`；审批门里的符号链接检查（pi 的 write / edit 写一个指向别处的 `.md` 符号链接不会被发现）；Main 侧的文档校验；修改 core 的 `ORCHESTRATOR_SYSTEM_PROMPT`；文档自动提交。

### 7.11 外观设置

- 行为差异：
  - 设置页「外观」在「主题」之下新增「界面」「终端」两节，各有「恢复默认」；全部即时生效，不用重启。
  - 界面：字体（CSS font-family 列表，留空用内置字体栈，占位符显示该字体栈）、字号（正文字号，整数 12–24 px，默认 14）、字重。根字号 = 16 × 字号 / 14，写在 `<html>` 上，Tailwind 的 rem 尺寸随之缩放，相当于整体缩放界面；文件编辑器字号由 `13px` 改为 `0.8125rem`，一起缩放。字体同时覆盖 `--font-sans`，`font-mono` 的代码块、diff 不受影响。字重是 `<html>` 上的默认字重，组件里显式设了字重的文字不受影响。是默认值的项不写行内样式。
  - 终端：配色方案（默认 `fynvra`，即此前写死的颜色）、字体（留空用 `Consolas, "Cascadia Mono", Menlo, monospace`）、字号（整数 8–32 px，默认 14）、字重（默认 normal）、粗体字重（默认 bold）。新终端按当前设置创建；已打开的终端更新 xterm 的 `options`（fontFamily / fontSize / fontWeight / fontWeightBold / theme），显示中的重新 fit，新行列数沿用 `onResize → terminals:resize` 同步给 PTY；隐藏或卸下的终端量不出尺寸，切回时由 TerminalPane 再 fit。终端四周的留白也用方案的背景色。
  - 文本框与数字框在失焦或回车（输入法选词的回车除外）时提交；不合法的值不提交并恢复原值，不会每按一次键就写一次 settings.json。
- 持久化与校验：
  - `Preferences` 新增可选字段 `uiFontFamily` / `uiFontSize` / `uiFontWeight` / `terminalColorScheme` / `terminalFontFamily` / `terminalFontSize` / `terminalFontWeight` / `terminalFontWeightBold`：缺省即默认值，不写进 `DEFAULT_PREFERENCES`，读取用 `appearancePreferencesOf`。
  - 字体 trim 后不超过 200 个字符，不含控制字符与 `;{}`；字号为整数且在各自范围内；字重限 `100 / 200 / 300 / normal / 500 / 600 / bold / 800 / 900`（xterm.js 的 FontWeight 取值）；配色方案须是方案列表里的 id。`parsePreferences` 读盘遇到非法值只丢掉该字段；`settings:update` 的补丁有任一非法值就整个作废，字段给 `undefined`（字体也可给空串）表示恢复默认，即删除该字段。Renderer 另用 `CSS.supports` 拦下浏览器不认的字体写法。
  - 沿用 `settings:update` / `settings:changed`，不新增 IPC。Renderer 只写改动的字段，不经 `useSettingsStore` 的整块落盘。
- 必改层与文件：
  - shared：新增纯数据模块 `terminalColorSchemes.ts`，导出方案列表（id、显示名、xterm `ITheme` 形状的颜色），Main 的校验与 Renderer 共用 id 列表；除 `fynvra` 外，颜色取自 iTerm2-Color-Schemes（MIT）的 ghostty 导出，文件里逐个注明来源。`types/settings.ts`：字段、默认值、校验，以及 `parsePreferences` 与 `parsePreferencesPatch` 的接线。
  - Main：不用改。补丁解析与读盘、落盘时的 `parseSettings` 都在 shared，Main 没有另外的字段白名单。
  - Renderer：`stores/settings.ts` 的 `useAppearanceStore`（仿通用偏好：只写改动的字段，先乐观更新，保存失败按 Main 重读并提示）；`lib/appearance.ts` 的 `bindDocumentAppearance`；`stores/terminals.ts` 的创建选项与 `bindTerminalAppearance`；`main.tsx` 启动时挂上这两个绑定，首帧等外观设置读回（与偏好共用 1 秒上限）；`components/terminal/TerminalPane.tsx` 的留白底色；`components/files/FileEditor.tsx` 的字号；`components/settings/AppearanceSettings.tsx`；`i18n/{zh-CN,en}.ts`。
- 明确不做：界面配色方案（即现有的主题）、界面粗体字重、自定义配色导入、按工作区区分的设置、代码块与 diff 的独立字体设置、快捷键缩放。

### 7.12 插件

- 行为差异：
  - 插件 = pi 包（目录 / npm / git），或单个 pi 扩展文件（`.ts` / `.js` / `.mjs`）。能力来自 pi 扩展机制（工具、命令、事件钩子）；包里的 skills / prompts 按 pi 包规则随之加载。只是 agent 侧能力，按角色挂载。
  - 本地来源：Main 弹框选目录或扩展文件，一律 `copy`：复制到副本根目录后加载副本，原文件不动。不再新建 `link`；旧的 `link` 条目（以及没有 `mode` 的旧本地记录，按 `link` 处理）继续可用，不自动转换，可手动「转为副本」。
  - 副本根目录：打包版 `~/.fynvra/plugins/`；开发版 `~/.fynvra-dev/plugins/`；开发版设了 `FYNVRA_USER_DATA_DIR` 时为 `<userData>/plugin-files/`。每个插件一个子目录 `<root>/<插件 id>/`，磁盘上已存在同名目录时改用 `<id>-2` 等，绝不覆盖已有目录。
  - 复制规则（Main，`services/plugins/pluginCopies.ts`，只用 `node:fs/promises`）：单个文件复制为 `<目录>/<原文件名>`；目录递归复制，跳过 `.git`；符号链接 / junction 的真实路径在源目录内的跟随复制（pnpm 的 `node_modules`），指向源目录外、断链或回指上级目录（环）的跳过。上限 200 MB 或 2 万个文件，超出中止并报错。先复制到 `<root>/.tmp-<uuid>` 再 rename 成正式目录，失败清理临时目录且不登记；来源与副本根目录互相包含时拒绝。
  - 卡片操作：打开文件夹、用…打开（目标列表复用 `workspaces:open-with-apps`）、作为工作区打开（`addDirectory(dir, { plain: true })`，link 指向文件时用其父目录，已是工作区则返回已有 id）；copy 可「从源文件重新复制」（新内容进临时目录，旧副本改名 `.old-<uuid>` 后换入，失败还原旧副本），link 可「转为副本」（`mode=copy`、`sourcePath=原 path`、`path=副本路径`）。打开类操作的目标：copy 为副本目录，其余为登记的 path。
  - 移除：link 只删登记，绝不删用户目录。copy 与新装的 npm / git（`copyDirOf(root, path)` 能找到所在目录）直接稳健删除 `<root>/<dir>`，不调 pi。旧 npm / git 条目（path 在 `userData/agent/{npm,git}` 下）先 `remove(source)`；失败时仅当 path 严格位于 `agent/git/`（至少 `<host>/<路径>` 两层）或 `agent/npm/node_modules/`（`<包>` 或 `@scope/<包>`）内，才对该插件自己的目录稳健删除，否则不删任何文件并报错（只带错误码）。稳健删除（`services/plugins/pluginRemoval.ts`）：先校验目标是受管根目录内、属于单个插件的目录（副本根目录下恰好一层；不会是任何受管根目录本身；resolve 后比较，Windows 不分大小写），再 `fs.rm({ recursive, force, maxRetries: 5, retryDelay: 200 })`；Windows 上遇 EPERM / EACCES 时把整棵树改成可写（文件 0o666、目录 0o777，不跟随链接）后再试一次。仍删不掉（文件被占用等）时登记照删、角色绑定照解除，目录进待清理列表，返回 `{ ok: true, warning }`，界面显示提示而不报错。启动时（注册插件 handler 时，在会话加载插件之前，走同一串行锁）按列表逐条稳健删除：删前重新检查边界，边界不合法或仍是已登记插件目录的只移出不删；删掉或已不存在的移出，失败的留到下次；日志不带路径。删除成功后遍历角色，把含该 id 的 `pluginIds` 去掉后保存（内置角色写覆盖配置），有角色改动时广播一次 `roles:changed`；单个角色保存失败只记不带路径的 warning，不影响删除结果。
  - npm `npm:<name>[@version]`、git `git:<host>/<path>[@ref]` 或 `https://` 仓库 URL：所有插件都在 `pluginCopyRoot()/<id>/` 下。Main 动态 import pi 的 `DefaultPackageManager`（用内存 `SettingsManager`，不写任何 pi settings 文件，不读 `~/.pi`），以副本根目录下的 `.tmp-<uuid>` 为 `agentDir` / `cwd` 执行 `install(source)`（user 作用域）；git 把 `getInstalledPath` 得到的仓库目录（含 pi 装好的依赖）rename 成 `<root>/<id>`，登记 `path = <root>/<id>`；npm 把整个 `<tmp>/npm` 前缀目录（含 node_modules）rename 成 `<root>/<id>`，登记 `path = <root>/<id>/node_modules/<包>`。`<id>` 沿用副本的唯一目录规则；安装路径不在临时目录内（如回退到全局 npm）算失败；失败不登记，rename 后登记失败删掉刚装好的目录；最后删除临时目录（删不掉的进待清理列表）。旧版装在 `userData/agent/{npm,git}` 下的条目仍可用、可删除。需要本机 npm / git，失败返回可读错误。
  - source 校验：去首尾空白，≤ 500 字符，无换行 / 空字符，只接受上述形态；同一来源或同一本地路径不可重复登记。
  - 设置页「设置 → 插件」：列表（名称、类型、旧引用条目的「引用」标签、当前加载路径 `path`（npm / git 的来源在悬停提示里）、启用开关、「…」操作菜单、移除）、添加本地（点击直接选择，不弹确认框，一律复制）、从 npm / git 安装（输入框 + 安装中状态，点击直接安装）；界面不显示风险提示。
  - 角色挂载：`Role.pluginIds`（§4）；角色编辑器多选，样式同 MCP。改动对之后新加载的会话生效。
  - 从本机导入（`services/plugins/piImport.ts`）：只在用户打开「从本机导入」（或点重新扫描）时只读扫描原生 pi 的 agent 目录（`PI_CODING_AGENT_DIR`，否则 `~/.pi/agent`，与模型服务导入的 `locate.ts` 一致），绝不执行或 import 扩展代码。来源：① `<agentDir>/extensions/` 下直接放的 `.ts` / `.js` / `.mjs` 文件，以及含 `index.ts` / `index.js` 的子目录（跳过点开头的项，跟随符号链接判断类型）；② `<agentDir>/settings.json` 的 `packages`（字符串或 `{ source }`）：`npm:` / `git:` / URL 形态的用 `parseRemotePluginSource` 校验，不合格的跳过并记一条只带个数的 warning，其余按本地路径相对 agentDir 解析（支持 `~/`）；③ settings.json 的 `extensions`：本地文件 / 目录路径，`+path` 去前缀，跳过 `builtin:*`、`-` / `!` 排除项与通配符。本地路径须是目录或扩展文件，不存在就静默跳过；settings.json 损坏只记一条只含文件名的 warning。同一路径 / 来源只列一次，最多 200 个候选（超出记 warning）。名字：文件名去扩展名、目录的 `package.json` name 或目录名（`pluginName`）、npm 包名、git 仓库名。
  - 导入去重：已登记插件满足任一条即标 `duplicateOf: <已有插件名>`，不可勾选、导入时算失败：副本的 `sourcePath`（或本地条目的 `source`）等于候选路径；旧引用条目的 `path` 等于候选路径；npm / git 条目的 `source` 与候选来源相同。路径先 `resolve`，Windows 忽略大小写。
  - 候选缓存：Main 保存 `{ id: randomUUID(), kind, path | source, … }`，每次扫描整体替换；Renderer 只拿到 `PluginImportCandidateView { id, name, kind, form?: 'file' | 'dir', display, duplicateOf? }`（`display` 为 `~` 缩写路径或来源串），导入只回传 id。
- 所属层与必改文件：
  - Main：插件注册表服务（登记、安装 / 卸载、启停）；角色资源解析把 `pluginIds` 解析为启用插件的路径（停用跳过；已删除跳过并记 warning）。
  - IPC（领域 `plugins`）：`plugins:list`、`plugins:add-local`（无参数或 `{}`，拒绝任何键，Main 弹框后复制）、`plugins:install`（`{ source }`）、`plugins:remove`（id，并清理角色 `pluginIds`）、`plugins:toggle`（`{ id, enabled }`）、`plugins:reveal`（id）、`plugins:open-in`（`{ id, appId }`，行为同 `workspaces:open-in`）、`plugins:open-as-workspace`（id → `{ workspaceId }`）、`plugins:recopy`（id，仅 copy）、`plugins:convert-to-copy`（id，仅 link）、`plugins:scan-imports`（无参数或 `{}` → `{ candidates, warnings }`）、`plugins:import`（`{ ids: string[] }`，1–200 个 → `{ imported: string[], failed: { name, error }[] }`：在同一串行锁内逐个导入，本地候选走与 `plugins:add-local` 相同的校验 / 查重 / 复制 / 登记流程（不弹框），npm / git 候选走与 `plugins:install` 相同的安装流程，成功的照常扫描服务名；未知 id 或已标重复的候选算失败；某项失败不影响其他项；全部结束后有成功的才广播一次 `plugins:changed`）。入参 `unknown` 收窄、拒绝多余键；Renderer 只传 id / appId，路径一律由 Main 从注册表取；安装 / 卸载 / 添加本地 / 重新复制 / 转为副本串行，进行中再请求返回“忙”，成功后广播 `plugins:changed`。preload 按 §9.1 新增 `plugins` 领域文件。
  - Renderer：「设置 → 插件」页、角色编辑器的插件多选、中英文案。
  - 运行时：`SpawnSessionSpec.plugins: string[]` → piSession → `resourcePaths.extensions` → `DefaultResourceLoader.additionalExtensionPaths`；保持 `noExtensions: true`（不发现磁盘上其他扩展），扩展加载错误并入 `RoleSession.warnings`。会话加载后收集由插件路径加载的扩展所注册的工具名，传给审批门 `pluginTools`，归类 `plugin`（§5）。
- 插件可见的模型服务：
  - 下发：角色挂了插件时，Main（`ipc/sessions.ts` 的 `resolvePluginProviders`）把「设置 → 模型服务」里已启用、有 key、有模型的服务按服务 id 放进 `SpawnSessionSpec.pluginProviders`（`{ id, name, api, baseUrl, apiKey, models: { id, reasoning? }[] }`），再按 `providerMap` 下发别名：每条 `[名字, 服务 id]`，目标服务可用时加一条 `id: 名字`、内容复制自目标服务的条目（替换列表里同 id 的条目）；目标不可用（已删、停用、缺 key 或模型）时移除列表里 id 为该名字的条目，不回退到同名服务。同时下发 `SpawnSessionSpec.pluginRefs: { id, path }[]`（与 `plugins` 同序，由角色资源解析产出）。
  - 注册：worker 的 `ModelRegistry.exposeProviders` 在 `createRoleSession` 之前按条目 id `registerProvider` + `setRuntimeApiKey`（只在内存），插件经 `ctx.modelRegistry` 按名字查到，与原生 pi 读 `models.json` 一致。与 pi 内置 provider、插件自己注册的 provider 同名时跳过并记 warning（映射到内置名也一样跳过）；新列表里没有的旧别名注销（spec 不带时不动）；别名不进能力推断用的目录。Fynvra 自己的模型仍走 `fynvra-` 运行时键。服务名规则（`isPluginProviderName`，`src/shared/types/plugins.ts`）：`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，不以 `fynvra-` 开头（不分大小写）。
  - 运行时识别（`src/agent/pluginLookups.ts`）：worker 包装共享 `ModelRuntime` 的 `getProvider` / `getAuth` / `getProviderAuthStatus` / `getModel`（pi `ModelRegistry` 外观层的转发目标），行为与返回值不变。第一个参数是符合服务名规则的字符串时，临时把 `Error.stackTraceLimit` 调到 50 取调用栈，帧路径规整（去 `file://`、`\` → `/`、Windows 转小写）后与会话 spawn 时登记的 `pluginRefs` 根路径（原路径与 `realpathSync.native`）比对：等于根路径（单文件插件）或以「根路径 + /」开头（目录插件）即归属该插件，取最内层匹配的帧；匹配不上（pi 内部调用）不记录。每个「插件 id + 名字」同进程只报一次：进程级事件 `{ type: 'plugin-provider-lookup', pluginId, name }`（不带路径）。拦截中的异常一律吞掉。局限：经定时器 / 事件回调发起、栈里已无插件帧的调用识别不到；`getAll()` 后自行过滤的用法无法拦截。
  - 记录与关联：Main 收到事件后经 `onPluginProviderLookup` 写进 `PluginEntry.requestedProviders`（去重、按首次出现排序、每插件最多 20 个；只有变化时写盘并广播 `plugins:changed`；插件不存在时忽略）。`plugins.json` 顶层可选 `providerMap: { [插件里的服务名]: 服务 id }`，按名字全局生效（worker 进程多会话共用 runtime）；没有条目即「自动（同名服务）」。IPC：`plugins:list` 返回 `{ plugins, providerMap }`；`plugins:set-provider-mapping`（`{ name, serviceId: string | null }`，拒绝多余键；非 null 时须是已存在的模型服务 id；null 删除映射）→ `{ providerMap }`，变化时广播 `plugins:changed`。对之后新建的会话生效。
  - 静态扫描（`services/plugins/providerScan.ts`，只用正则 + `node:fs/promises`，只读文本，绝不执行或 import 插件代码）：`extractProviderNames(source)` 先收集简单字符串常量 `const|let|var NAME[: Type] = '…'`（单 / 双引号或不含插值的反引号），再识别 `.getProvider(` / `.getProviderAuth(` / `.getApiKeyForProvider(` / `.getProviderAuthStatus(` 的第一个参数、带第二个参数的 `.find(x, …)` 的第一个参数、`.provider ===|== x` 及两边对调的写法；参数是字符串字面量或能解析成上述常量的标识符。结果按服务名规则过滤、去重、按首次出现排序、最多 20 个。`scanPluginProviders(path)`：单文件插件只扫该文件；目录插件递归扫 `.ts .mts .cts .js .mjs .cjs`，跳过 `*.d.ts`、`node_modules`、点开头的目录（含 `.git`），不跟随符号链接；最多 500 个文件、合计 5 MB，单个超过 1 MB 的不读。同时返回 `stamp`（被扫文件相对路径 + 大小 + mtime 的 sha256 前 32 位）；stamp 未变时只 stat 不读内容。局限：服务名经拼接、函数参数、对象属性、配置文件或环境变量传入的识别不到；常量按文件内名字解析，不跨文件、不分作用域；注释里的代码也会被识别。
  - 扫描时机：`plugins:add-local`、`plugins:install`、`plugins:recopy`、`plugins:convert-to-copy` 成功后立即扫描并写入 `scannedProviders` / `scanStamp`（失败不影响操作，只记不带路径的 warning）；`plugins:list` 逐条检查，没有扫描记录或 stamp 变了就重新扫描写入（各条并行扫描，写入走注册表串行队列；写入时加载路径已变则丢弃），直接返回最新数据，不广播 `plugins:changed`（避免循环）。
  - 手动服务名：`plugins:set-manual-providers`（`{ id, names: string[] }`，拒绝多余键；names 全部符合服务名规则、最多 20 个，去重保序；整组替换 `manualProviders`）→ `{ plugin }`，变化时广播 `plugins:changed`。
  - 卡片「模型服务」显示 `scannedProviders`、`requestedProviders`、`manualProviders` 合并去重（保持各自顺序）；很多插件不用模型服务，列表为空时卡片上不显示任何内容，手动添加入口在卡片「…」菜单（「添加模型服务名」，卡片内原地出现输入框）；非空时为紧凑的 `text-xs` 灰色小标题「模型服务 · 改选后新会话生效」+ 同行右侧「+ 添加」文字按钮，无单独 footer 行；只有仅来自手动添加的行可删。状态为「未找到」的行可「新建服务」：打开 `ProviderDialog`（自定义默认值，名称预填服务名），保存后经 `onSaved(providerId)` 调 `plugins:set-provider-mapping`：id 与名字不同时关联到新 id，相同时清除映射。
  - 安全边界：只对挂了插件的会话下发；key 只在 Main → worker 这一跳出现；插件代码能读到这些服务的地址和 key（与原生 pi 一致）；key 与完整路径不进日志、错误与事件；识别事件在 Main 按 registry id 与服务名规则收窄，只能往已登记插件的列表里追加有限个名字，不影响下发内容。
- 持久化：`userData/plugins.json` = `{ version: 1, plugins: StoredPlugin[] }`，`StoredPlugin { id, name, source, kind: 'local' | 'npm' | 'git', path, enabled, installedAt, mode?: 'copy' | 'link', sourcePath?, requestedProviders?: string[], scannedProviders?: string[], scanStamp?: string, manualProviders?: string[] }`（三个名字列表各自去重、最多 20 个、须符合服务名规则；非法值丢弃），顶层可选 `providerMap?: Record<string, string>`（键须符合服务名规则、值须为 registry id、最多 100 条，非法条目丢弃不让文件失效；版本仍为 1，旧文件照常可读）；`path` 始终是实际加载的路径（copy 为副本，link 为原路径），`mode` / `sourcePath` 仅本地插件（`sourcePath` 仅 copy，为复制来源的原路径）；id 为名字派生的 slug（冲突加后缀）；原子写；文件损坏时报错，不静默清空。顶层另有可选 `pendingDeletes?: string[]`（待清理的插件目录，最多 50 条；只接受受管根目录内、属于单个插件的目录，非法值丢弃不让文件失效）。npm / git 包本体在 `pluginCopyRoot()/<id>/`（旧条目在 `userData/agent` 下）。
- 安全边界：插件以用户权限执行任意代码。审批门只管工具调用，管不住插件加载时和钩子里的代码，靠用户自担信任。Renderer 只传 id 与 source 字符串，本地路径只由 Main 弹框或导入扫描产生；只在用户打开导入时读取 `~/.pi`（只读），不写 pi settings 文件。删除与覆盖只发生在受管根目录（副本根目录；旧的 `userData/agent/git`、`userData/agent/npm/node_modules`）内、属于该插件自己的目录，从不删受管根目录本身，从不改动原文件；另加最后一道保险（`services/plugins/protectedPaths.ts`）：被删路径 resolve 后（Windows 不分大小写）位于、等于或包含 `~/.pi` 或 pi 的 agent 目录（`PI_CODING_AGENT_DIR`，否则 `~/.pi/agent`）时一律拒绝删除，只记不带路径的 warning，覆盖稳健删除、待清理列表、启动清理、副本临时 / 旧目录清理与旧条目的 pi remove；复制有大小上限且不跟随指向源目录外的链接；复制 / 删除失败只报错误码，路径不进日志，错误文案不带注册表以外的路径。
- 明确不做：插件市场 / 搜索、自动更新、界面插件、沙箱、项目级 `.pi` 包、资源筛选。

### 7.13 工作流

工作流是由角色节点组成的有向无环图：每个节点做什么、由哪个角色执行、依赖哪些上游节点。分阶段落地：W1 模型 / 校验 / 迁移 / 本契约，W2 并行执行引擎，W3 画布编辑器，W4 任务进度图。

- 模型与校验（core，`parseWorkflow`，不抛异常，拒绝多余键，`null` 视同缺省）：
  - 节点沿用 `WorkflowStep`（§4），新增 `needs: string[]`（上游 id，归一化输出总是带上）与可选 `position: { x, y }`（有限数，绝对值 ≤ 100000，缺省时界面自动排版）。
  - 节点数 1–20；节点 id 在工作流内唯一；`needs` 只能引用已存在的节点，不能重复，不能指向自己；整张图不能有环，错误信息按依赖方向列出环上的节点（如 `a → b → c → a`）。
  - `onFail` 只能是节点自身或它的祖先（经 `needs` 可传递到达的上游）。
  - 输出的 `steps` 按稳定拓扑序排列（Kahn，同时可选的节点按原输入顺序取）。
  - 兼容旧数据：输入里没有任何节点带 `needs` 时，按列表顺序转成线性链（第 i 个依赖第 i-1 个，第一个为 `[]`）；只要有一个节点带 `needs`，缺 `needs` 的节点视为起点 `[]`。旧任务快照（`Task.workflow.steps` 无 `needs`）读入时按同样规则补齐。
  - 图工具（core 纯函数，W2 / W3 / W4 共用）：`workflowTopologicalOrder(steps) → steps[] | undefined`（有环为 undefined）、`findWorkflowCycle(steps) → id[] | undefined`、`workflowParents` / `workflowChildren(steps, id) → id[]`、`workflowAncestors` / `workflowDescendants(steps, id) → Set<id>`（不含自身）、`workflowRoots` / `workflowSinks(steps) → id[]`、`workflowLevels(steps) → id[][] | undefined`（最长路径分层）、`summarizeWorkflow(steps, label?) → string`。
  - 文字摘要：每层的每个节点恰好依赖上一层全部节点时按层写成 `开发 → (测试 ‖ 安全审查) → 验收`（同层用 ` ‖ ` 并列，只有一层时不加括号）；否则按拓扑序逐个列出 `开发; 测试 ← 开发; 验收 ← 测试 + 安全审查`。
- 派发：`dispatch_task` 可选 `workflow`（id，或不区分大小写的名称），与 `role` 互斥（同时给返回错误）。主 agent 会话的 spawn spec 带工作流清单（id、名称、说明、各节点名称 + 角色、`summary` 文字摘要，节点标签为 `名称 [角色]`），工具描述与 orchestrator 提示词显示摘要；用户说“用某工作流做某事”时传 `workflow`。清单只是 spawn 时的快照：`workflow` 参数始终存在（清单为空时描述说明可传之后新建的工作流），会话开始后新建的工作流按 id 或名称同样能派发。用户消息里的约定（orchestrator 提示词始终包含）：`/名称` 或 `/「名称」` 指定工作流（传 `workflow`、不传 `role`），`@名称` 或 `@「名称」` 指定角色（传 `role`，多个 `@` 各派一个任务）；名称不区分大小写，id 也可；对不上任何工作流 / 角色的 `/...`（如路径）、`@...`（如邮箱）按普通文本；明显是指令但名称未知时原样传入，Main 报未知后再问用户；这是用户的明确指令，优先于主 agent 自选角色。Main 派发时以注册表为准：工作流不存在、节点角色不存在或是编排类角色则返回错误；成功则把定义快照进 `Task.workflow`。之后编辑工作流不影响已派发的任务。
- 执行语义（W2，Main `workflowEngine.ts`；调度决定是 core 的纯函数 `planWorkflow`）：
  - 运行时状态（`Task.workflow`）：`nodes[]`（与 `steps` 一一对应：`status` 为 waiting / running / passed / failed / cancelled，`dispatchId`、`placement` 为 integration 或 isolated、隔离节点的 `worktreeId` 与 `merged`、待用的 `feedback`、失败原因 `failure`）、`launches[]`（启动意图：节点 + 预分配的 dispatchId + placement + 已建的节点 worktree）、`worktreeId`（集成 worktree）、`rounds`、按节点 id 记录的 `history`。旧快照（`step` 下标 + 单个 `pending`）读入时由 `isTaskWorkflow` 就地转换：当前步之前的节点通过、当前步运行中（引擎加载时按最近一次尝试补上 dispatch 与集成 worktree）、pending 转为等待节点上的反馈。
  - 调度：节点的所有上游都通过（并已合回集成 worktree）后才可运行；每个工作流任务最多同时运行 4 个节点；同时可运行的节点按拓扑序启动。每个任务一个串行的推进循环：落实启动意图 → 合并通过的隔离节点 → `planWorkflow`（启动 / 等待 / 退回 / 结束）。
  - 隔离（git 工作区）：任务派发时建集成 worktree（分支 `fynvra/<slug>`）。节点是当前唯一可运行的节点、且没有其他节点在运行 / 待启动 / 待合并时，直接在集成 worktree 里运行（线性工作流因此与串行引擎完全一致：同一 worktree，上一步会话空闲后释放再启动下一步，没有额外合并）；其余节点各自从集成分支当前 HEAD 分出节点 worktree，分支 `fynvra/<任务 slug>-<节点 id>`。由此集成 worktree 里任何时刻最多一个 worker。
  - 汇合合并：隔离节点通过后记 `merged: false`；引擎等它的会话空闲并释放，节点 worktree 有未提交改动则该节点失败；否则在集成 worktree 里 `git merge --no-ff --no-edit <节点分支>`（不 rebase；先用 `git merge-base --is-ancestor` 判断已合并则跳过，保证幂等），串行进行；集成 worktree 里有 worker 时不合并。冲突时 abort，该节点失败、冲突文件列表作为反馈。合并后先记 `merged: true` 再删节点 worktree 与分支。
  - 普通目录（vcs 为 none，in-place 模式）：不隔离，按拓扑序一次只跑一个节点。
  - 失败（报告 failed、合并冲突 / 未提交改动、启动失败、会话确定已失败）：不再启动新节点，等运行中的节点结束、期间通过的节点照常合并后汇总。每个失败节点都设置了 `onFail` 且 `rounds < maxRounds` → 退回到这些目标中拓扑序最靠前的那个，`rounds + 1`，把该目标及其所有后代重置为等待（不在其下的失败节点及其后代也重置，带上各自的问题），其他已通过的节点保留；各失败节点的名称与总结合并作为目标的反馈；失败节点的节点 worktree 随之删除。否则整个任务记 `failed`，发 worker_done(failed)，正文含各节点状态与历程（失败节点的 worktree 保留，到 reject_work / abandon 时清理）。派发 / reject_work 启动首批节点失败时工具直接返回错误、任务回到原状。
  - 成功：全部节点通过且合并完成后任务进入 `in-review`，发 worker_done(succeeded)：正文含图摘要、各节点状态与历程，改动文件取各节点并集。worker_done 的 dispatch（代表 dispatch）作用于集成 worktree：任务最后一次尝试就在集成 worktree（或普通目录）里时用它；否则（如末尾是并行节点、或整个工作流都没有节点在集成 worktree 里跑过）补一条已结算的汇总 Dispatch：`worktreeId` / `branch` 指向集成 worktree，`outcome` 为工作流结果，`summary` 汇总各节点，`filesModified` 为并集，`workerSessionId` 沿用最近结算节点的会话。它是该任务最新的 dispatch，`review_diff` / `run_checks` / `merge_worktree` / `cleanup_worktree` / `reject_work` 按现有规则作用于集成 worktree。
  - `reject_work`（in-review 或 failed，现有保护条件不变）：清理遗留的节点 worktree，从起点节点开始整图重跑，全部节点重置为等待，反馈写进起点节点任务书，`rounds` 归零、历史保留。
  - abandon（`cleanup_worktree { abandon: true }`，可传任一运行中节点或代表 dispatch）：所有进行中的节点尝试按 failed 结算、节点记为 cancelled、启动意图清空；停掉所有节点会话，清理所有节点 worktree / 分支与集成 worktree。
  - 崩溃恢复：先写启动意图（含预分配的 dispatchId）再建节点 worktree（建好即写进意图）、再起会话，会话起来后同步落库 Dispatch 与节点 running。服务加载 / 对账时推进所有 in-progress 的工作流任务：意图里的 dispatch 已存在则只补状态、不重复启动，否则复用已建的 worktree 重新启动；通过未合并的节点补做合并（幂等）；全部结束却未汇总的补做汇总。运行中节点的会话确定已失败时（`sessionFailure`）该节点按 failed 结算；对账逐个检查任务的全部未结算尝试（并行节点各一个），不属于运行中节点或待启动意图的孤儿尝试会话已死时只结算它自己。abandon / reject_work 重跑前结算任务全部未结算尝试、停掉全部节点会话。
- 任务书：原 spec + 「工作流 X · 节点 <名称>」+ 本节点说明 + 判定契约（通过 → `report_done succeeded`；发现需要退回的问题 → `failed`，summary 写清问题与复现）+ 已完成上游节点的摘要 / 退回反馈。
- 编排工具显示：`list_workers` / `dispatch_task` 对工作流任务显示工作流名、图摘要、回退次数 `r/max`，每个节点一行（状态 waiting / starting / running / merging / passed / failed / cancelled、名称、角色、dispatch_id、是否在自己的 worktree）；运行中不再单列任务级 dispatch，结束后单列代表 dispatch；`wait_for_workers` 把整体未结束的工作流任务算作仍在运行；`send_to_worker` / `read_worker_output` 接受该任务任一活动节点的 dispatch；`ask_coordinator` 转给主 agent 的问题带上工作流名和节点名；工具说明与提示词里的工作流显示成图的文字摘要。
- 设置页（W3）「设置 → 工作流」：
  - 画布编辑器：`@xyflow/react` 画布 + `@dagrejs/dagre` 自动排版。节点卡片显示名称、角色和说明首行；从节点拖出连线建立依赖（写进下游的 `needs`），会形成环的连线被拒绝；删除连线 / 节点时同步更新 `needs` 与失效的 `onFail`；拖动节点写 `position`。
  - 侧栏编辑选中节点：名称、角色下拉（排除编排类角色）、说明、失败退回目标（只列自身与祖先）。失败退回在画布上用红色虚线从节点指向目标。
  - 其他：自动排版、三个预设模板（空白、线性「开发 → 测试 → 审核」、并行「开发 → (测试 ‖ 安全审查) → 验收」）、工作流名称 / 说明 / 回退上限；列表页每个工作流显示文字摘要。保存仍走 `workflows:save`，由 Main 用 `parseWorkflow` 校验。
  - 公共组件：可复用的 `WorkflowGraph`，分只读与可编辑两种模式，W4 复用只读模式。
- 任务进度图（W4）：编排面板里工作流任务显示只读流程图，按节点状态着色（等待 / 运行中 / 通过 / 失败），点击节点查看对应 worker 的输出。
- 所属层与必改文件：
  - core：`Workflow` / `WorkflowStep` / `Task.workflow` 类型、`parseWorkflow` 与图工具；编排状态与任务书渲染的工作流推进。
  - Main：工作流注册表服务；编排服务的调度、合并与恢复；主 agent spawn spec 带工作流清单与摘要。
  - IPC（领域 `workflows`）：`workflows:list`、`workflows:save`（整份 Workflow，新建或替换）、`workflows:remove`（id）。保存只校验结构，角色是否存在在派发时检查（设置页对不存在 / 编排类角色给出提示）。
  - agent-runtime：`dispatch_task` 的 `workflow` 参数与互斥校验、工具描述与 orchestrator 提示词。
  - Renderer：「设置 → 工作流」画布编辑器、编排面板的进度图与历史、中英文案。
- 持久化：`userData/workflows.json` = `{ version: 1, workflows: Workflow[] }`（≤ 50 个），原子写。版本号不变：旧条目（无 `needs`）读入时由 `parseWorkflow` 转成线性链，下次保存整份写成新形状。任务里的快照与推进状态随编排快照 `userData/orchestration/<workspaceId>.json` 保存。
- 安全边界：入参 `unknown` 收窄、拒绝多余键；编排类角色不能当节点角色；节点数、并发数、回退次数有上限，历史与摘要有界；各节点 worker 的工具、审批和验收合并规则与普通派发相同。
- 明确不做：条件分支（除 `onFail` 外）、跨任务工作流、节点级模型覆盖、内置测试 / 审核角色、子图与循环。

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
  planMode?: boolean;    // 计划模式（§7.10）：仅开启时为 true，随会话记录保存在 sessions.json
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
export type ApprovalKind = 'command' | 'file-edit' | 'file-write' | 'mcp' | 'network' | 'plugin';
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
  /** 计划模式开关（§7.10）：派发出的 worker 会话拒绝；运行中也能切 */
  setPlanMode(input: { sessionId: string; enabled: boolean }): Promise<IpcResult<{ session: SessionSummary }>>;
  archive(sessionId: string): Promise<IpcResult<{ session: SessionSummary }>>;   // 运行中拒绝
  unarchive(sessionId: string): Promise<IpcResult<{ session: SessionSummary }>>; // 闲置计时重新开始
  sweep(): Promise<IpcResult<{ archived: number; removed: number }>>;            // 按设置立即扫一次
  onEvent(cb: (envelope: SessionEventEnvelope) => void): Unsubscribe;
  onSessionsChanged(cb: (workspaceId: string) => void): Unsubscribe;
  onApprovalRequest(cb: (request: ApprovalRequest) => void): Unsubscribe;
}
```
通道：`sessions:list|create|remove|prompt|abort|history|respond-approval|set-model|model-options|set-plan-mode|archive|unarchive|sweep`，推送 `sessions:event`、`sessions:changed`、`sessions:approval-request`。审批响应只接收 session / request id 和 decision，不接收工具参数或路径；Main 核验真实待审批请求后才转发答复。

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
持久化：`userData/providers.json`（含明文 key，仅 Main）、`userData/skills.json`、`userData/mcp.json`、`userData/roles/<id>.json`、`userData/plugins.json`（§7.12）、`userData/workflows.json`（§7.13）。
模型服务「从本机导入」（`src/main/services/providers/import/`，只读，只在用户打开导入并勾选来源时读取）：来源依次为 Claude Code（`~/.claude/settings.json`）、Codex（`~/.codex/config.toml` + `auth.json`）、CC Switch（`~/.cc-switch/cc-switch.db` 的副本）、pi（`<agent-dir>/models.json` + `auth.json`，`<agent-dir>` = `PI_CODING_AGENT_DIR`，缺省 `~/.pi/agent`；平时不读 `~/.pi`）。pi 只导入协议受支持且有模型的 provider，名称取 provider 键名；只覆盖内置服务地址等不完整的条目跳过并提示。key 优先取 auth.json 里 `type: 'api_key'` 的条目，其次 models.json 的 `apiKey`；`$NAME` / `${NAME}` 取环境变量（缺失则视为无 key 并提示），`$$` / `$!` 转义；`!command` 形式的 key **绝不执行**，视为无 key 并提示手动填写。明文 key 只在 Main 内存，Renderer 只拿脱敏候选；warning 不带 key 与配置原文。
