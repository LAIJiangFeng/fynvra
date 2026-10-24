import type { Api, Model } from '@earendil-works/pi-ai';
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionError,
  type InlineExtension,
  type ModelRuntime,
  type SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Role, ThinkingLevel } from '../coreTypes';
import type { ExecFn } from '../exec';
import type { OrchestrationHost, WorkerHost } from '../host';
import { appendSystemPromptExtension, beforeRunExtension } from '../pi/extensions';
import { bindSessionExtensions, emitSessionShutdown } from '../pi/lifecycle';
import { createRoleMcpExtensions, type McpServerConfig } from '../pi/mcp';
import { buildRolePromptAppend } from '../prompts/orchestratorPrompt';
import { createOrchestrationTools, type RoleOption } from '../tools/orchestrationTools';
import { createReadonlyTools } from '../tools/readonlyTools';
import {
  createWorkerTools,
  type WorkerToolset,
  type WorkerToolsOptions,
} from '../tools/workerTools';

/** Main 按 role.model 解析出的模型 */
export interface ResolvedModel {
  /** pi 的模型 / 凭据运行时；同一 worker 进程内的会话可共享 */
  runtime: ModelRuntime;
  model: Model<Api>;
  /** 思考档位；缺省用 role.model?.thinking，再缺省由 pi 决定（medium，按模型能力 clamp） */
  thinking?: ThinkingLevel;
}

/** 角色引用的资源，已由 Main 从 skillIds / mcpServerIds 解析 */
export interface RoleResourcePaths {
  /** skill 目录或 SKILL.md 路径；会话只加载这些 skill */
  skills: string[];
  mcpServers: McpServerConfig[];
}

export interface CreateRoleSessionOptions {
  role: Role;
  /** 会话工作目录：orchestrator 为工作区仓库，worker 为它的 worktree */
  cwd: string;
  model: ResolvedModel;
  sessionManager: SessionManager;
  /** `tools: 'orchestrator'` 必须提供；其他策略传 null */
  host: OrchestrationHost | null;
  resourcePaths: RoleResourcePaths;
  /** pi 的 agentDir（Fynvra 用 `userData/agent`）：全局 AGENTS.md、mcp-auth.json、mcp.log 所在 */
  agentDir: string;
  /** 提供时本会话是 worker：加 ask_coordinator / report_done 与 worker 契约 */
  workerHost?: WorkerHost | null;
  workerTools?: WorkerToolsOptions;
  /** dispatch_task 可选的角色（orchestrator 用） */
  roles?: readonly RoleOption[];
  /** 默认 `SettingsManager.inMemory`：不读用户的 ~/.pi 与项目 .pi 设置 */
  settingsManager?: SettingsManager;
  /** git_readonly 的命令执行器，默认 child_process.execFile */
  exec?: ExecFn;
  /** 扩展（MCP 等）在事件处理中抛出的错误 */
  onExtensionError?: (error: ExtensionError) => void;
}

export interface RoleSession {
  session: AgentSession;
  /** skill / 扩展 / MCP 配置问题（缺失路径、非法服务器名等），供 Main 展示 */
  warnings: string[];
  /** 发 session_shutdown（关闭 MCP 连接）后 dispose 会话；可重复调用 */
  dispose(): Promise<void>;
}

/**
 * 按角色创建 pi `AgentSession`（ARCHITECTURE §5）：
 * - 工具策略：`orchestrator` → 只读工具 + 编排工具；`readonly` → 只读工具；`all` → pi 默认工具。
 *   传入 `workerHost` 时再加 worker 工具。
 * - skills → DefaultResourceLoader；MCP → createMcpExtension + bindExtensions；
 *   role.systemPrompt 与契约段 → before_agent_start 追加；模型与思考档位来自 `model`。
 */
export async function createRoleSession(options: CreateRoleSessionOptions): Promise<RoleSession> {
  const { role, cwd, agentDir } = options;
  const workerToolset = options.workerHost
    ? createWorkerTools(options.workerHost, options.workerTools)
    : undefined;
  const { customTools, noTools } = selectTools(options, workerToolset);

  const mcp = createRoleMcpExtensions(options.resourcePaths.mcpServers);
  const promptAppend = buildRolePromptAppend(role, { worker: workerToolset !== undefined });
  const extensionFactories: InlineExtension[] = [
    ...mcp.extensions,
    ...(promptAppend ? [appendSystemPromptExtension('fynvra-role-prompt', promptAppend)] : []),
    ...(workerToolset ? [beforeRunExtension('fynvra-worker-round', workerToolset.startRound)] : []),
  ];

  const settingsManager = options.settingsManager ?? createDefaultSettings();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    // 资源只来自角色：不发现磁盘上的扩展 / skill / 提示词模板 / 主题，也不用 SYSTEM.md / APPEND_SYSTEM.md。
    // 项目的 AGENTS.md 等上下文文件照常加载。
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalSkillPaths: options.resourcePaths.skills,
    extensionFactories,
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const thinking = options.model.thinking ?? role.model?.thinking;
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: options.model.runtime,
    model: options.model.model,
    ...(thinking ? { thinkingLevel: thinking } : {}),
    resourceLoader,
    sessionManager: options.sessionManager,
    settingsManager,
    ...(noTools ? { noTools } : {}),
    customTools,
  });

  let disposing: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (!disposing) {
      disposing = emitSessionShutdown(session).finally(() => session.dispose());
    }
    return disposing;
  };
  try {
    await bindSessionExtensions(session, options.onExtensionError);
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    session,
    warnings: [...mcp.warnings, ...loaderWarnings(resourceLoader)],
    dispose,
  };
}

function selectTools(
  options: CreateRoleSessionOptions,
  workerToolset: WorkerToolset | undefined
): { customTools: ToolDefinition[]; noTools?: 'builtin' } {
  const { role, cwd, exec } = options;
  const workerTools = workerToolset?.tools ?? [];
  switch (role.tools) {
    case 'orchestrator': {
      if (!options.host) {
        throw new Error(
          `role "${role.id}" uses the orchestrator tool policy and needs an OrchestrationHost`
        );
      }
      // noTools: 'builtin' 关掉 pi 的 read/bash/edit/write，只读工具以 customTools 重新注册
      return {
        noTools: 'builtin',
        customTools: [
          ...createReadonlyTools(cwd, exec ? { exec } : {}),
          ...createOrchestrationTools(options.host, options.roles ? { roles: options.roles } : {}),
          ...workerTools,
        ],
      };
    }
    case 'readonly':
      return {
        noTools: 'builtin',
        customTools: [...createReadonlyTools(cwd, exec ? { exec } : {}), ...workerTools],
      };
    case 'all':
      return { customTools: workerTools };
    default:
      throw new Error(`role "${role.id}" has an unknown tool policy: ${String(role.tools)}`);
  }
}

/** 内存设置：与用户本机的 pi CLI 配置隔离；关掉 pi 的安装遥测与 provider 署名请求头 */
function createDefaultSettings(): SettingsManager {
  return SettingsManager.inMemory({ enableInstallTelemetry: false });
}

function loaderWarnings(loader: DefaultResourceLoader): string[] {
  const skills = loader
    .getSkills()
    .diagnostics.map(
      (diagnostic) =>
        `skill: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ''}`
    );
  const extensions = loader
    .getExtensions()
    .errors.map((error) => `extension ${error.path}: ${error.error}`);
  return [...skills, ...extensions];
}
