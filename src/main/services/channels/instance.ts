// Main 内唯一的渠道宿主：index.ts 创建并登记；插件 API、host-invoke 路由与编排变更分发经这里找到它。
import type { HostCallResult } from '@shared/types/agent';
import type { TelegramHostDeps } from '../agentHost/agentHost';
import { telegramHost } from '../telegram/instance';
import type { ChannelHost } from './host';

let host: ChannelHost | undefined;

export function setChannelHost(next: ChannelHost | undefined): void {
  host = next;
}

/** 还没接线时 undefined */
export function getChannelHost(): ChannelHost | undefined {
  return host;
}

/** triage_report 等 host-invoke 的路由：会话归属某插件就交给它的 channel.report，否则回退到 fallback */
export function routeChannelReport(
  current: () => ChannelHost | undefined,
  fallback: TelegramHostDeps
): TelegramHostDeps {
  return {
    invoke(sessionId, method, input, signal): Promise<HostCallResult> {
      return (
        current()?.report(sessionId, method, input, signal) ??
        fallback.invoke(sessionId, method, input, signal)
      );
    },
  };
}

/** 交给 createAgentHost 的 deps.telegram：插件会话路由到插件，其余回退内置 Telegram（保持现状） */
export const channelReportHost = routeChannelReport(() => host, {
  // 调用时才取，模块加载顺序与测试里的 mock 都不受影响
  invoke: (sessionId, method, input, signal) =>
    telegramHost.invoke(sessionId, method, input, signal),
});

/** 编排状态变化分发给渠道插件（notifyChanged 调用） */
export function channelOrchestrationChanged(workspaceId: string): void {
  host?.orchestrationChanged(workspaceId);
}
