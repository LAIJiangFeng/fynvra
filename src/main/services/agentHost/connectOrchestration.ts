import type { OrchestrationRegistry } from '../orchestration/registry';
import type { AgentHostService } from './agentHost';

/**
 * 把 agent host 与编排注册表接成一条链（ARCHITECTURE §6、§9.5），生产在 `src/main/index.ts` 调用：
 * - 编排派发的 worker 会话由 agent host 启动（注册表的 launcher）；
 * - 主 agent 的编排工具、worker 的 report_done / ask_coordinator 在 host 调用到达时才按会话查 Host
 *   （Dispatch 在 createWorkerSession resolve 之后才写入）；
 * - worker 会话的 parentSessionId 经 Run 反查主 agent 会话。
 * 返回前加载全部工作区的编排快照：workerHostFor 只认已加载的状态，要在启动或恢复任何会话之前完成。
 */
export async function connectOrchestration(
  agentHost: AgentHostService,
  registry: OrchestrationRegistry
): Promise<void> {
  registry.setLauncher(agentHost.implementsLauncher());
  agentHost.setOrchestrationHostFactory((coordinatorSessionId, workspaceId) =>
    registry.hostFor(coordinatorSessionId, workspaceId)
  );
  agentHost.setWorkerHostFactory((sessionId) => registry.workerHostFor(sessionId));
  agentHost.setCoordinatorLookup((workspaceId, runId) =>
    registry.coordinatorOf(workspaceId, runId)
  );
  await registry.openAll();
}
