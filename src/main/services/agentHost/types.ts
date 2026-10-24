import type { OrchestrationHost, WorkerHost } from '@fynvra/agent-runtime';
import type { ResolvedModelSpec } from '@shared/types/agent';

// ARCHITECTURE §9.5 中归属 agent-host 的接口。
// ResolvedModelSpec 是 Main ⇄ worker 协议的一部分，定义在 src/shared/types/agent.ts，这里原样再导出。
export type { ResolvedModelSpec };

/** 设置里的模型引用：providerId 是「设置 → 模型服务」里的服务 id */
export interface ModelRef {
  providerId: string;
  modelId: string;
}

/**
 * 按会话或角色的模型引用解析出可交给 worker 的模型；ref 缺省时由解析器选默认模型。
 * `model.providerId` 是运行时 provider 键（worker 按它注册 pi provider），不是设置里的服务 id；
 * `ref` 是实际解析的设置引用（缺省时即选中的默认模型），会话记录存它，之后每次 spawn 再按它解析。
 */
export interface ModelResolver {
  resolve(
    ref: ModelRef | undefined
  ): Promise<{ ok: true; model: ResolvedModelSpec; ref: ModelRef } | { ok: false; error: string }>;
}

/**
 * 与 orchestration-host 的 `src/main/services/orchestration/launcher.ts`（§9.5）逐字段相同。
 * 那个文件归 Task 06、本卡不能创建；TypeScript 按结构比较，接线时改为从那里 import 即可。
 */
export interface WorkerSessionLauncher {
  createWorkerSession(input: {
    workspaceId: string;
    runId: string;
    dispatchId: string;
    roleId: string;
    cwd: string;
    worktreeId: string;
    brief: string;
  }): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;
  promptSession(
    sessionId: string,
    text: string
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  readTranscript(
    sessionId: string,
    cursor: number
  ): Promise<
    { ok: true; text: string; total: number; done: boolean } | { ok: false; error: string }
  >;
  disposeSession(sessionId: string): Promise<void>;
}

export interface AgentHost {
  /** 供 orchestration-host 使用 */
  implementsLauncher(): WorkerSessionLauncher;
  setOrchestrationHostFactory(
    f: (coordinatorSessionId: string, workspaceId: string) => OrchestrationHost | null
  ): void;
  setWorkerHostFactory(f: (sessionId: string) => WorkerHost | null): void;
}
