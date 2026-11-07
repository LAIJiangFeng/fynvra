import fs from 'node:fs';
import path from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import {
  type AgentSession,
  type BashSpawnHook,
  createAgentSession,
  createBashToolDefinition,
  createPowerShellToolDefinition,
  DefaultResourceLoader,
  defineTool,
  type ExtensionError,
  type InlineExtension,
  type ModelRuntime,
  type SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Role, ThinkingLevel } from '@fynvra/core';
import { type ApprovalPolicyHooks, createApprovalGate } from '../approval/gate';
import { type ExecFn, nodeExec } from '../exec';
import type { OrchestrationHost, WorkerHost } from '../host';
import { appendSystemPromptExtension, beforeRunExtension } from '../pi/extensions';
import { bindSessionExtensions, emitSessionShutdown } from '../pi/lifecycle';
import { createRoleMcpExtensions, type McpServerConfig } from '../pi/mcp';
import {
  buildRolePromptAppend,
  DIRECT_PLAN_MODE_PROMPT,
  PLAN_MODE_PROMPT,
} from '../prompts/orchestratorPrompt';
import { createOrchestrationTools, type RoleOption } from '../tools/orchestrationTools';
import { createReadonlyTools } from '../tools/readonlyTools';
import { createWebFetchTool } from '../tools/web/webFetchTool';
import {
  createWorkerTools,
  type WorkerToolset,
  type WorkerToolsOptions,
} from '../tools/workerTools';
import { createWriteDocTool } from '../tools/writeDocTool';
import { createWritePlanTool } from '../tools/writePlanTool';

/** Main 按 role.model 解析出的模型 */
export interface ResolvedModel {
  /** pi 的模型 / 凭据运行时；同一 worker 进程内的会话可共享 */
  runtime: ModelRuntime;
  model: Model<Api>;
  /**
   * 思考档位（含 pi 的 max）；缺省用 role.model?.thinking，再缺省由 pi 决定（medium，按模型能力 clamp）。
   * 原样交给 pi，不在这里过滤：模型没有的档位由 pi 就近 clamp，按模型落定档位是调用方的事。
   */
  thinking?: ThinkingLevel;
}

/** 角色引用的资源，已由 Main 从 skillIds / mcpServerIds 解析 */
export interface RoleResourcePaths {
  /** skill 目录或 SKILL.md 路径；会话只加载这些 skill */
  skills: string[];
  mcpServers: McpServerConfig[];
  /**
   * 插件：pi 包目录或单个扩展文件的绝对路径，交给 DefaultResourceLoader 的 additionalExtensionPaths；
   * 包里的 extensions / skills / prompts 按 pi 包规则加载（noExtensions / noSkills 不影响这些路径）
   */
  extensions?: string[];
  instructionFile?: { name: string; content: string };
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
  /**
   * 工作区没有 git（编排原地进行，没有 worktree）：orchestrator 追加非 git 模式说明，
   * worker 换成不提交的契约（见 buildRolePromptAppend）
   */
  inPlace?: boolean;
  /**
   * 计划模式的实时开关，宿主持有、随时可变；缺省视为永远关闭。关闭后提示词从下一次 run 起、拦截从下一次工具调用起恢复原样。
   * - `role.tools === 'orchestrator'`：每次 run 开始时读取，为 true 就在角色追加段之后追加 `PLAN_MODE_PROMPT`；
   *   每次 dispatch_task 调用时也读取，为 true 时拒绝派发、不调用 host；write_doc 每次调用时读取，只有为 true 才写。
   * - 其他工具策略的非 worker 会话（没有 `workerHost`）：write_plan 常驻（与开关当前是否打开无关）；
   *   每次 run 开始时读取，为 true 就追加 `DIRECT_PLAN_MODE_PROMPT`；审批门每次工具调用时读取，为 true 时
   *   write / edit / apply_patch 只在目标全是 Markdown 文档时照原档位处理、其余直接拦截，非只读命令与 MCP 不论档位都要人确认（见 createApprovalGate 的 `planMode`）。
   * - 其他工具策略的 worker 会话忽略它。
   */
  planMode?: () => boolean;
  /** 默认 `SettingsManager.inMemory`：不读用户的 ~/.pi 与项目 .pi 设置 */
  settingsManager?: SettingsManager;
  /**
   * Host-provided inline extensions (currently the vendored Magic Context
   * plugin). Loaded after the built-in role/approval/MCP extensions. Only
   * Fynvra code may pass entries here; never discover them from settings or
   * the filesystem.
   */
  extensions?: readonly InlineExtension[];
  /** Transform only command subprocess environments, after pi injects session metadata. */
  commandEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  /** git_readonly 的命令执行器，默认 child_process.execFile */
  exec?: ExecFn;
  /** 扩展（MCP 等）在事件处理中抛出的错误 */
  onExtensionError?: (error: ExtensionError) => void;
  /**
   * 审批通道：按 role.approvalMode 拦截的工具调用经它请求人工审批。
   * 不提供时需要审批的调用一律拒绝（fail-closed）；不需要审批的照常执行。
   */
  approval?: ApprovalPolicyHooks;
}

/** 没有审批通道：需要审批的调用全部拒绝，拒绝文本说明原因 */
const NO_APPROVAL_CHANNEL: ApprovalPolicyHooks = {
  request: async () => {
    throw new Error('this session has no approval channel');
  },
};

export interface RoleSession {
  session: AgentSession;
  /** skill / 扩展 / MCP 配置问题（缺失路径、非法服务器名等），供 Main 展示 */
  warnings: string[];
  /** 发 session_shutdown（关闭 MCP 连接）后 dispose 会话；可重复调用 */
  dispose(): Promise<void>;
}

/**
 * 按角色创建 pi `AgentSession`（ARCHITECTURE §5）：
 * - 工具策略：`orchestrator` → 只读工具 + 编排工具 + write_plan + write_doc；`readonly` → 只读工具；`all` → pi 默认工具。
 *   各策略都加 web_fetch；传入 `workerHost` 时再加 worker 工具；不是 worker 又提供了 `planMode` 时，`readonly` / `all` 也加 write_plan。
 * - skills → DefaultResourceLoader；MCP → createMcpExtension + bindExtensions；
 *   role.systemPrompt 与契约段 → before_agent_start 追加；模型与思考档位来自 `model`。
 * - `planMode`：开着时 orchestrator 策略每次 run 再追加 `PLAN_MODE_PROMPT`、dispatch_task 拒绝派发、write_doc 可写；
 *   其他策略的非 worker 会话追加 `DIRECT_PLAN_MODE_PROMPT`，审批门只放行写 Markdown 文档的文件工具、非只读命令与 MCP 要人确认。
 * - role.approvalMode → 审批门（tool_call 拦截），经 `approval` 请求人工审批。
 */
export async function createRoleSession(options: CreateRoleSessionOptions): Promise<RoleSession> {
  const { role, cwd, agentDir } = options;
  const workerToolset = options.workerHost
    ? createWorkerTools(options.workerHost, options.workerTools)
    : undefined;
  const orchestrator = role.tools === 'orchestrator';
  // 计划模式：orchestrator 策略照旧（拒绝派发 + PLAN_MODE_PROMPT）；其他策略只对非 worker 会话生效
  // （write_plan + DIRECT_PLAN_MODE_PROMPT + 审批门拦截），worker 会话忽略开关
  const planMode = orchestrator || !workerToolset ? options.planMode : undefined;
  const directPlanMode = orchestrator ? undefined : planMode;
  const settingsManager = options.settingsManager ?? createDefaultSettings();
  const { customTools, noTools } = selectTools(
    options,
    workerToolset,
    settingsManager,
    directPlanMode !== undefined
  );

  const mcp = createRoleMcpExtensions(options.resourcePaths.mcpServers);
  const promptAppend = buildRolePromptAppend(role, {
    worker: workerToolset !== undefined,
    inPlace: options.inPlace === true,
    ...(options.resourcePaths.instructionFile
      ? { instructionFile: options.resourcePaths.instructionFile }
      : {}),
  });
  const gate = createApprovalGate({
    mode: role.approvalMode,
    ...(options.approval ?? NO_APPROVAL_CHANNEL),
    // orchestrator 不传：它没有改文件的工具，run_checks 等编排工具不受计划模式影响
    ...(directPlanMode ? { planMode: directPlanMode } : {}),
    // 插件扩展注册的工具按 plugin 类别审批；loader 在下方创建，check 只在会话运行后发生
    pluginTools: () => pluginTools(),
  });
  const extensionFactories: InlineExtension[] = [
    // 第一个注册：拦截在其他扩展的 tool_call 处理之前
    gate.extension,
    ...mcp.extensions,
    ...(promptAppend ? [appendSystemPromptExtension('fynvra-role-prompt', promptAppend)] : []),
    // 每次 run 重新读开关：开着才追加，关掉后从下一次 run 起不再出现（pi 每次 run 都给新的 options 副本）
    ...(planMode
      ? [
          appendSystemPromptExtension('fynvra-plan-mode', () =>
            planMode() ? (orchestrator ? PLAN_MODE_PROMPT : DIRECT_PLAN_MODE_PROMPT) : undefined
          ),
        ]
      : []),
    ...(workerToolset ? [beforeRunExtension('fynvra-worker-round', workerToolset.startRound)] : []),
    ...(options.extensions ?? []),
  ];

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
    additionalExtensionPaths: options.resourcePaths.extensions ?? [],
    extensionFactories,
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();
  const pluginTools = createPluginToolNames(resourceLoader, options.resourcePaths.extensions ?? []);

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

/** `writePlan`：给 readonly / all 策略加 write_plan（计划模式下的非 worker 会话）；orchestrator 策略总有它 */
function selectTools(
  options: CreateRoleSessionOptions,
  workerToolset: WorkerToolset | undefined,
  settings: SettingsManager,
  writePlan: boolean
): { customTools: ToolDefinition[]; noTools?: 'builtin' } {
  const { role, cwd, commandEnv } = options;
  const exec =
    options.exec ??
    (commandEnv
      ? (((cmd, args, dir, config) =>
          nodeExec(cmd, args, dir, {
            ...config,
            env: commandEnv(process.env),
          })) satisfies ExecFn)
      : undefined);
  const workerTools = workerToolset?.tools ?? [];
  // 描述不说「唯一能写的文件」：all 策略还有 pi 的 write / edit（名字不冲突）
  const planTools = writePlan ? [createWritePlanTool(cwd, { onlyWritableFile: false })] : [];
  // 所有工具策略都有 web_fetch；代理与命令一致，取会话加载时的 commandEnv 快照
  const webFetch = createWebFetchTool({
    proxyEnv: () => (commandEnv ? commandEnv(process.env) : process.env),
  });
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
          ...createOrchestrationTools(options.host, {
            ...(options.roles ? { roles: options.roles } : {}),
            ...(options.planMode ? { planMode: options.planMode } : {}),
          }),
          createWritePlanTool(cwd),
          createWriteDocTool(cwd, { planMode: options.planMode ?? (() => false) }),
          webFetch,
          ...workerTools,
        ],
      };
    }
    case 'readonly':
      return {
        noTools: 'builtin',
        customTools: [
          ...createReadonlyTools(cwd, exec ? { exec } : {}),
          ...planTools,
          webFetch,
          ...workerTools,
        ],
      };
    case 'all': {
      if (!commandEnv) return { customTools: [...planTools, webFetch, ...workerTools] };
      const spawnHook: BashSpawnHook = (ctx) => ({ ...ctx, env: commandEnv(ctx.env) });
      // Override implementations, not selection: defaultActive=false preserves pi's defaultTools.
      return {
        customTools: [
          defineTool({
            ...createBashToolDefinition(cwd, {
              shellPath: settings.getShellPath(),
              commandPrefix: settings.getShellCommandPrefix(),
              spawnHook,
            }),
            defaultActive: false,
          }),
          defineTool({
            ...createPowerShellToolDefinition(cwd, { spawnHook }),
            defaultActive: false,
          }),
          ...planTools,
          webFetch,
          ...workerTools,
        ],
      };
    }
    default:
      throw new Error(`role "${role.id}" has an unknown tool policy: ${String(role.tools)}`);
  }
}

/** 内存设置：与用户本机的 pi CLI 配置隔离；关掉 pi 的安装遥测与 provider 署名请求头 */
function createDefaultSettings(): SettingsManager {
  return SettingsManager.inMemory({ enableInstallTelemetry: false });
}

/** 规范化路径用于比较：resolve、统一分隔符；Windows 上不区分大小写 */
function normalizePluginPath(value: string): string {
  const resolved = path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * 插件工具名单：只统计来源路径等于某个插件路径（单文件插件）或位于插件根目录之下（包插件）的扩展；
 * Fynvra 内联扩展（`<inline:…>`：审批门、MCP、Magic Context 等）不计入。每次调用读 loader 当前的扩展，
 * 每次都重算（路径同时与 resolve 形式和真实路径比较）。没有插件时恒为空集。
 */
function createPluginToolNames(
  loader: DefaultResourceLoader,
  pluginPaths: readonly string[]
): () => ReadonlySet<string> {
  const empty: ReadonlySet<string> = new Set();
  if (pluginPaths.length === 0) return () => empty;
  // 每个插件路径同时取 resolve 形式与真实路径（符号链接 / junction）；真实路径只在这里算一次，失败忽略
  const roots = new Set<string>();
  for (const pluginPath of pluginPaths) {
    roots.add(normalizePluginPath(pluginPath));
    try {
      roots.add(normalizePluginPath(fs.realpathSync.native(pluginPath)));
    } catch {
      // 路径不存在或不可读：只用 resolve 形式
    }
  }
  const rootList = [...roots];
  const fromPlugin = (extensionPath: string): boolean => {
    if (!extensionPath || extensionPath.startsWith('<')) return false;
    const normalized = normalizePluginPath(extensionPath);
    return rootList.some((root) => normalized === root || normalized.startsWith(`${root}/`));
  };
  // 不缓存：扩展与工具很少，每次重算才能覆盖运行中注销再注册的同数量工具
  let lastGood: ReadonlySet<string> = empty;
  // 不能抛异常：审批门把 getter 抛错当作「是插件工具」处理，会让所有未归类工具都要审批
  return () => {
    let extensions: ReturnType<DefaultResourceLoader['getExtensions']>['extensions'];
    try {
      extensions = loader.getExtensions().extensions;
    } catch {
      return lastGood;
    }
    const names = new Set<string>();
    for (const extension of extensions) {
      if (!fromPlugin(extension.path) && !fromPlugin(extension.resolvedPath)) continue;
      for (const name of extension.tools.keys()) names.add(name);
    }
    lastGood = names;
    return names;
  };
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
