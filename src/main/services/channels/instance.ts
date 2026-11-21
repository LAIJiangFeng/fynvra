// Main 内唯一的渠道宿主：index.ts 创建并登记；插件 API、host-invoke 路由与编排变更分发经这里找到它。
import type { HostCallResult } from '@shared/types/agent';
import type { TelegramHostDeps } from '../agentHost/agentHost';
import type { ChannelHost } from './host';

let host: ChannelHost | undefined;

export function setChannelHost(next: ChannelHost | undefined): void {
  host = next;
}

/** 还没接线时 undefined */
export function getChannelHost(): ChannelHost | undefined {
  return host;
}

/** triage_report 等 host-invoke 的路由：会话归属某插件就交给它的 channel.report，否则失败 */
export function routeChannelReport(current: () => ChannelHost | undefined): TelegramHostDeps {
  return {
    invoke(sessionId, method, input, signal): Promise<HostCallResult> {
      return (
        current()?.report(sessionId, method, input, signal) ??
        Promise.resolve({ ok: false, error: 'session is not owned by a channel plugin' })
      );
    },
  };
}

/** 交给 createAgentHost 的 deps.telegram（host-invoke kind 名沿用 'telegram'）：只路由到渠道插件 */
export const channelReportHost = routeChannelReport(() => host);

/** 编排状态变化分发给渠道插件（notifyChanged 调用） */
export function channelOrchestrationChanged(workspaceId: string): void {
  host?.orchestrationChanged(workspaceId);
}
