/**
 * Renderer ⇄ Main 的全部 IPC 通道，命名 `domain:action`。
 * 新增通道必须三处同步：这里的常量、`src/main/ipc/<domain>.ts` 的 handler、`src/preload` 的 typed 出口。
 */
export const IPC_CHANNELS = {
  /** 更新操作无参；更新源和安装路径只由 Main 决定 */
  UPDATES_STATE: 'updates:state',
  UPDATES_CHECK: 'updates:check',
  UPDATES_INSTALL: 'updates:install',
  UPDATES_CHANGED: 'updates:changed',

  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_TEST_NETWORK: 'settings:test-network',
  SETTINGS_CANCEL_NETWORK_TEST: 'settings:cancel-network-test',
  SETTINGS_AVAILABLE_SHELLS: 'settings:available-shells',
  SETTINGS_PICK_SHELL: 'settings:pick-shell',
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
  WORKSPACES_OPEN_WITH_APPS: 'workspaces:open-with-apps',
  WORKSPACES_OPEN_IN: 'workspaces:open-in',
  WORKSPACES_COPY: 'workspaces:copy',
  WORKSPACES_PICK_APP: 'workspaces:pick-app',
  TERMINALS_CREATE: 'terminals:create',
  TERMINALS_WRITE: 'terminals:write',
  TERMINALS_RESIZE: 'terminals:resize',
  TERMINALS_CLOSE: 'terminals:close',
  /** PTY 输出 / 退出仅发送给创建它的窗口 */
  TERMINALS_EVENT: 'terminals:event',
  /** Main → Renderer：工作区列表已变更 */
  WORKSPACES_CHANGED: 'workspaces:changed',

  /** 按工作区 / 目录 id 列出一层条目，Renderer 不传路径 */
  FILES_LIST: 'files:list',
  /** 按 Main 签发的文件 id 只读预览内容 */
  FILES_READ: 'files:read',
  /** 按读取版本保存文本，冲突时不覆盖磁盘内容 */
  FILES_WRITE: 'files:write',
  /** 在目录里新建空文件 / 空子目录（名称由 Main 校验，路径不回传） */
  FILES_CREATE: 'files:create',
  /** 同目录内重命名（条目 id 不变，缓存同步改写） */
  FILES_RENAME: 'files:rename',
  /** 删除文件 / 目录（移到系统回收站，不直接抹除） */
  FILES_DELETE: 'files:delete',
  /** 同目录创建文件副本（copy / copy 2 …） */
  FILES_DUPLICATE: 'files:duplicate',
  /** 在系统文件资源管理器中显示条目 */
  FILES_REVEAL: 'files:reveal',
  /** 把条目复制到系统剪贴板（Windows 为文件本体，其他平台退回路径文本） */
  FILES_COPY: 'files:copy',
  /** 解析条目绝对路径（展示或匹配本地引用，不能作为文件参数回传） */
  FILES_RESOLVE: 'files:resolve',
  /** 仅将工作区内已签发的 HTML 文件交给默认浏览器 */
  FILES_OPEN_HTML: 'files:open-html',

  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggle-maximize',
  WINDOW_CLOSE: 'window:close',
  /** Main → 当前 Renderer：显示应用内关窗选择 */
  WINDOW_CLOSE_REQUESTED: 'window:close-requested',
  /** Renderer 只回传 cancel / tray / quit；Main 绑定 sender 窗口 */
  WINDOW_RESPOND_CLOSE: 'window:respond-close',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
  /** Main → Renderer：窗口最大化状态变化 */
  WINDOW_MAXIMIZED_CHANGED: 'window:maximized-changed',

  // --- orchestration ---
  /** 工作区的编排快照（Run / Task / Dispatch / Worktree / Message） */
  ORCHESTRATION_SNAPSHOT: 'orchestration:snapshot',
  /** 按 dispatch id 分页读 worker 输出（与 read_worker_output 同源） */
  ORCHESTRATION_READ_WORKER_OUTPUT: 'orchestration:read-worker-output',
  /** 当前会话登记目录的改动；无会话时读工作区主目录 */
  ORCHESTRATION_CHANGES: 'orchestration:changes',
  /** 按 dispatch id 取 worker 分支相对基准提交的历史改动 */
  ORCHESTRATION_REVIEW_DIFF: 'orchestration:review-diff',
  /** Main → Renderer：某工作区的编排状态已变更（参数：workspaceId） */
  ORCHESTRATION_CHANGED: 'orchestration:changed',
  // --- sessions ---
  /** 参数为 workspaceId（不含归档的会话），或 `{ workspaceId, includeArchived: true }` */
  SESSIONS_LIST: 'sessions:list',
  /** Renderer 只传 workspaceId / roleId（/ 模型引用）；cwd 由 Main 从工作区记录推导 */
  SESSIONS_CREATE: 'sessions:create',
  SESSIONS_REMOVE: 'sessions:remove',
  SESSIONS_PROMPT: 'sessions:prompt',
  /** 运行中插话（入参同 sessions:prompt），立即注入当前回合；会话空闲时等同 prompt */
  SESSIONS_STEER: 'sessions:steer',
  SESSIONS_RETRY_COMPACTION: 'sessions:retry-compaction',
  SESSIONS_ABORT: 'sessions:abort',
  /** 从 pi jsonl 重建的消息投影 */
  SESSIONS_HISTORY: 'sessions:history',
  SESSIONS_RESPOND_APPROVAL: 'sessions:respond-approval',
  /** 换会话的模型 / 思考档位：Renderer 只传会话 id 与设置里的模型引用；会话运行中拒绝 */
  SESSIONS_SET_MODEL: 'sessions:set-model',
  /** 新建会话 / 换模型的可选项：启用且有 key 的服务，每个模型带可选的思考档位；传 workspaceId 时带上次用过的模型 */
  SESSIONS_MODEL_OPTIONS: 'sessions:model-options',
  /** 换会话的审批档位：Renderer 只传会话 id 与档位；运行中也可以切，即时生效 */
  SESSIONS_SET_APPROVAL_MODE: 'sessions:set-approval-mode',
  /**
   * 为刚正常结束的一轮生成一条输入框回复建议：Renderer 只传 `{ sessionId, roundId }`（settled 事件的会话级 seq），
   * 不传对话正文 / 模型 / 路径；失败或超时返回空建议，不影响主对话
   */
  SESSIONS_SUGGEST_REPLY: 'sessions:suggest-reply',
  /** 归档会话（只传会话 id）：运行中拒绝；按设置清理它绑定的、已合并且干净的 worktree */
  SESSIONS_ARCHIVE: 'sessions:archive',
  /** 恢复归档的会话（只传会话 id），闲置计时从现在重新开始 */
  SESSIONS_UNARCHIVE: 'sessions:unarchive',
  /** 按「通用 → 会话」的设置立即扫描一次：归档闲置会话、删除过期的归档记录（定时扫描也走它） */
  SESSIONS_SWEEP: 'sessions:sweep',
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
  /**
   * 按协议请求服务端的模型列表（不写盘）：已保存的服务传 providerId，key 从 providers.json 取；
   * 表单里未保存的协议 / 地址 / 新 key 放在 draft，key 明文只在这一跳。返回的模型视图不含 key
   */
  PROVIDERS_LIST_REMOTE_MODELS: 'providers:list-remote-models',
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
  /** 导入 ~/.claude.json 与 ~/.claude/settings.json 里的 mcpServers（界面已改用下面两个通道，保留给旧调用方） */
  MCP_IMPORT_CLAUDE: 'mcp:import-claude',
  /** 只读扫描本机 8 个工具的 MCP 配置，返回脱敏候选；含 env / headers 的结果在 Main 缓存 10 分钟 */
  MCP_SCAN_IMPORTS: 'mcp:scan-imports',
  /** 按候选 id 导入最近一次扫描的结果；env / headers 从 Main 的缓存取，不经过 Renderer */
  MCP_IMPORT: 'mcp:import',
  /** Main → Renderer：MCP 服务器列表已变更 */
  MCP_CHANGED: 'mcp:changed',

  // --- instructions ---
  INSTRUCTIONS_LIST: 'instructions:list',
  INSTRUCTIONS_READ: 'instructions:read',
  INSTRUCTIONS_SCAN: 'instructions:scan',
  /** Only fixed scan candidate IDs; no renderer-supplied paths. */
  INSTRUCTIONS_IMPORT: 'instructions:import',
  /** Main opens a Markdown file picker. */
  INSTRUCTIONS_PICK: 'instructions:pick',
  INSTRUCTIONS_SAVE: 'instructions:save',
  INSTRUCTIONS_REMOVE: 'instructions:remove',
  INSTRUCTIONS_TOGGLE: 'instructions:toggle',
  INSTRUCTIONS_CHANGED: 'instructions:changed',

  // --- notifications ---
  /** 立即弹一条测试通知（不看聚焦与启动静默期），无参 */
  NOTIFICATIONS_TEST: 'notifications:test',
  /** Renderer 报告窗口里正看着的会话（`{ sessionId: string | null }`）：窗口聚焦时这个会话的通知不弹 */
  NOTIFICATIONS_SET_VIEWING: 'notifications:set-viewing',
  /** Main → Renderer：点了通知，切到该会话（`{ sessionId, workspaceId }`） */
  SESSIONS_FOCUS: 'sessions:focus',

  // --- workspace UI ---
  WORKSPACE_UI_SELECTION: 'workspaceui:selection',
  WORKSPACE_UI_LOAD: 'workspaceui:load',
  WORKSPACE_UI_SAVE: 'workspaceui:save',
  WORKSPACE_UI_FLUSH: 'workspaceui:flush',
  WORKSPACE_UI_FLUSHED: 'workspaceui:flushed',

  // --- usage ---
  /** 本机全部 jsonl 的用量，只接收时间范围，不接收路径 */
  USAGE_SUMMARY: 'usage:summary',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
export type WindowCloseAction = 'cancel' | 'tray' | 'quit';

/** 跨 IPC 边界的统一返回形状：handler 不抛异常，失败时带可展示的错误信息。 */
export type IpcResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };
