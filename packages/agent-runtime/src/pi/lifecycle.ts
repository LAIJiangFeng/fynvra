import type { AgentSession, ExtensionError } from '@earendil-works/pi-coding-agent';

/** 绑定扩展运行时并发出 session_start（MCP 扩展此时开始在后台连接服务器） */
export async function bindSessionExtensions(
  session: Pick<AgentSession, 'bindExtensions'>,
  onError?: (error: ExtensionError) => void
): Promise<void> {
  await session.bindExtensions(onError ? { onError } : {});
}

/**
 * 通知扩展会话结束：MCP 扩展借此关闭连接并结束 stdio 服务器进程。永不抛异常。
 *
 * 升级复检点：pi 1.4.0 的 `AgentSession.dispose()` 不发 session_shutdown（只有 CLI 的切换 / 退出流程发），
 * 这里经 `session.extensionRunner` 补发。
 */
export async function emitSessionShutdown(
  session: Pick<AgentSession, 'extensionRunner'>
): Promise<void> {
  try {
    const runner = session.extensionRunner;
    if (runner.hasHandlers('session_shutdown')) {
      await runner.emit({ type: 'session_shutdown', reason: 'quit' });
    }
  } catch {
    // 关闭阶段的扩展异常不影响 dispose
  }
}
