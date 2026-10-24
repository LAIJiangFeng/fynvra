/**
 * Renderer ⇄ Main 的全部 IPC 通道，命名 `domain:action`。
 * 新增通道必须三处同步：这里的常量、`src/main/ipc/<domain>.ts` 的 handler、`src/preload` 的 typed 出口。
 */
export const IPC_CHANNELS = {
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  /** Main → Renderer：偏好已变更，各窗口重读 */
  SETTINGS_CHANGED: 'settings:changed',
  /** 无参时 Main 弹目录选择框、校验后写入 worktreesRoot；`{ reset: true }` 恢复默认。Renderer 不传路径 */
  SETTINGS_PICK_WORKTREES_ROOT: 'settings:pick-worktrees-root',
  /** 生效的 worktree 根目录与各工作区登记的 worktree 占用 */
  SETTINGS_WORKTREES_ROOT_INFO: 'settings:worktrees-root-info',

  WORKSPACES_LIST: 'workspaces:list',
  /** Main 弹目录选择框并校验；Renderer 不传路径 */
  WORKSPACES_ADD: 'workspaces:add',
  WORKSPACES_REMOVE: 'workspaces:remove',
  /** Main → Renderer：工作区列表已变更 */
  WORKSPACES_CHANGED: 'workspaces:changed',

  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggle-maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
  /** Main → Renderer：窗口最大化状态变化 */
  WINDOW_MAXIMIZED_CHANGED: 'window:maximized-changed',

  // --- orchestration ---
  /** 工作区的编排快照（Run / Task / Dispatch / Worktree / Message） */
  ORCHESTRATION_SNAPSHOT: 'orchestration:snapshot',
  /** 按 dispatch id 分页读 worker 输出（与 read_worker_output 同源） */
  ORCHESTRATION_READ_WORKER_OUTPUT: 'orchestration:read-worker-output',
  /** 按 dispatch id 取 worker 分支相对基准提交的改动 */
  ORCHESTRATION_REVIEW_DIFF: 'orchestration:review-diff',
  /** Main → Renderer：某工作区的编排状态已变更（参数：workspaceId） */
  ORCHESTRATION_CHANGED: 'orchestration:changed',
  // --- sessions ---
  SESSIONS_LIST: 'sessions:list',
  /** Renderer 只传 workspaceId / roleId（/ 模型引用）；cwd 由 Main 从工作区记录推导 */
  SESSIONS_CREATE: 'sessions:create',
  SESSIONS_REMOVE: 'sessions:remove',
  SESSIONS_PROMPT: 'sessions:prompt',
  SESSIONS_ABORT: 'sessions:abort',
  /** 从 pi jsonl 重建的消息投影 */
  SESSIONS_HISTORY: 'sessions:history',
  SESSIONS_RESPOND_APPROVAL: 'sessions:respond-approval',
  /** 换会话的模型 / 思考档位：Renderer 只传会话 id 与设置里的模型引用；会话运行中拒绝 */
  SESSIONS_SET_MODEL: 'sessions:set-model',
  /** 新建会话 / 换模型的可选项：启用且有 key 的服务，每个模型带可选的思考档位；传 workspaceId 时带上次用过的模型 */
  SESSIONS_MODEL_OPTIONS: 'sessions:model-options',
  /** Main → Renderer：会话事件（SessionEventEnvelope） */
  SESSIONS_EVENT: 'sessions:event',
  /** Main → Renderer：某工作区的会话列表已变更（参数为 workspaceId） */
  SESSIONS_CHANGED: 'sessions:changed',
  /** Main → Renderer：待审批请求（ApprovalRequest） */
  SESSIONS_APPROVAL_REQUEST: 'sessions:approval-request',
  // --- providers ---
  PROVIDERS_LIST: 'providers:list',
  /** apiKey 明文只在这一跳从 Renderer 进入 Main */
  PROVIDERS_UPSERT: 'providers:upsert',
  PROVIDERS_REMOVE: 'providers:remove',
  /** 用已保存的 key 发一个最小请求（列模型）验证连通性；只传 id */
  PROVIDERS_TEST: 'providers:test',
  /** 只读扫描本机 Claude Code / Codex / CC Switch 的配置，返回脱敏候选；含 key 的结果在 Main 缓存 10 分钟 */
  PROVIDERS_SCAN_IMPORTS: 'providers:scan-imports',
  /** 按候选 id 导入最近一次扫描的结果；key 从 Main 的缓存取，不经过 Renderer */
  PROVIDERS_IMPORT: 'providers:import',
  /** Main → Renderer：模型服务列表已变更 */
  PROVIDERS_CHANGED: 'providers:changed',

  // --- roles ---
  ROLES_LIST: 'roles:list',
  ROLES_GET: 'roles:get',
  ROLES_SAVE: 'roles:save',
  ROLES_REMOVE: 'roles:remove',
  /** Main → Renderer：角色已变更 */
  ROLES_CHANGED: 'roles:changed',

  // --- skills ---
  SKILLS_LIST: 'skills:list',
  /** 无参时 Main 弹目录选择框；传 candidateIds 时登记 skills:scan 找到的技能。Renderer 不传路径 */
  SKILLS_ADD: 'skills:add',
  SKILLS_REMOVE: 'skills:remove',
  SKILLS_TOGGLE: 'skills:toggle',
  /** 扫描 ~/.claude/skills、~/.codex/skills、~/.pi/agent/skills；只读，不登记 */
  SKILLS_SCAN: 'skills:scan',
  /** Main → Renderer：技能注册表已变更 */
  SKILLS_CHANGED: 'skills:changed',

  // --- mcp ---
  MCP_LIST: 'mcp:list',
  /** env / headers 明文只在这一跳从 Renderer 进入 Main */
  MCP_UPSERT: 'mcp:upsert',
  MCP_REMOVE: 'mcp:remove',
  MCP_TOGGLE: 'mcp:toggle',
  /** 导入 ~/.claude.json 与 ~/.claude/settings.json 里的 mcpServers */
  MCP_IMPORT_CLAUDE: 'mcp:import-claude',
  /** Main → Renderer：MCP 服务器列表已变更 */
  MCP_CHANGED: 'mcp:changed',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/** 跨 IPC 边界的统一返回形状：handler 不抛异常，失败时带可展示的错误信息。 */
export type IpcResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };
