import type { Message } from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import type { SessionEventEnvelope } from '@shared/types/chat';
import type { OrchestrationRegistry } from '../orchestration/registry';
import type { AgentHostService } from './agentHost';

/** 会唤醒主 agent 的消息类型：worker 的汇报与提问、编排自身的升级。 */
const WAKE_TYPES: ReadonlySet<string> = new Set(['worker_done', 'question', 'escalation']);

/** 消息正文的截断长度（与 wait_for_workers 的单条上限一致）。 */
const BODY_MAX_CHARS = 6_000;

/** 逐条消息的「下一步」指引（对应工具说明里各类型的处理方式）。 */
function nextStep(message: Message): string {
  const target = message.dispatchId ? `dispatch_id \`${message.dispatchId}\`` : 'its dispatch_id';
  switch (message.type) {
    case 'question':
      return `answer with send_to_worker (${target}); the worker is blocked until you reply.`;
    case 'escalation':
      return `decide how to proceed (ask the user when the decision is theirs), then send_to_worker, reject_work or cleanup_worktree (${target}).`;
    default:
      return `review_diff and run_checks (${target}), then merge_worktree if it passes or reject_work with concrete feedback.`;
  }
}

function entry(message: Message, index: number): string {
  const ref = message.dispatchId ? ` · dispatch \`${message.dispatchId}\`` : '';
  const subject = message.subject ? ` — ${message.subject}` : '';
  const body =
    message.body.length > BODY_MAX_CHARS
      ? `${message.body.slice(0, BODY_MAX_CHARS)}\n…(${message.body.length - BODY_MAX_CHARS} more characters)`
      : message.body;
  return [
    `### ${index + 1}. ${message.type}${ref}${subject}`,
    `- from: ${message.from} · message_id: \`${message.id}\``,
    '',
    body,
    '',
    `Next: ${nextStep(message)}`,
  ].join('\n');
}

/**
 * 注入给空闲主 agent 的唤醒 prompt：把收件箱里未投递的消息连同下一步指引一起交给它。
 * 明确标注是 Fynvra 的自动通知，不是用户发言。
 */
export function wakePrompt(messages: readonly Message[]): string {
  return [
    '[Fynvra orchestration] Automated notification — not a message from the user.',
    '',
    `New worker message${messages.length === 1 ? '' : 's'} arrived (${messages.length}):`,
    '',
    messages.map(entry).join('\n\n'),
    '',
    'Handle these now: answer questions, review reported work, merge or send it back, then report a short status to the user. Workers still running keep going; you do not need to call wait_for_workers.',
  ].join('\n');
}

export interface CoordinatorWakeHosts {
  /** 主 agent 会话的查询、注入 prompt 与事件订阅。 */
  agentHost: Pick<AgentHostService, 'get' | 'prompt' | 'observe'>;
  /** 编排收件箱：新消息通知、未确认消息的读取与确认。 */
  registry: Pick<OrchestrationRegistry, 'onMessage' | 'pendingMessagesTo' | 'ackMessages'>;
  log?(message: string): void;
}

export interface CoordinatorWakeOptions {
  /** 防抖与回合结束后的缓冲毫秒数，默认 400。 */
  delayMs?: number;
}

/**
 * 协调者唤醒器（Orca 式监控）：主 agent 派发完任务即可结束回合继续对话，
 * 不再用 wait_for_workers 阻塞等待。收件箱出现 worker_done / question / escalation 时：
 * - 会话空闲：把未确认消息合成一条注入 prompt 唤醒主 agent，发送成功后确认（与 wait 的交付一致）；
 * - 会话忙碌：不投递也不确认，回合结束（agent_settled）后的下一拍再试；
 * - 会话不存在或已出错：放弃本轮，消息留在收件箱，下一次事件再触发。
 */
export function installCoordinatorWake(
  hosts: CoordinatorWakeHosts,
  options: CoordinatorWakeOptions = {}
): void {
  const delayMs = options.delayMs ?? 400;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const schedule = (sessionId: string): void => {
    if (timers.has(sessionId)) return;
    timers.set(
      sessionId,
      setTimeout(() => {
        timers.delete(sessionId);
        void flush(sessionId);
      }, delayMs)
    );
  };

  const flush = async (sessionId: string): Promise<void> => {
    try {
      const messages = hosts.registry.pendingMessagesTo(sessionId);
      if (messages.length === 0) return;
      const session = hosts.agentHost.get(sessionId);
      if (session === undefined) return;
      if (session.status !== 'idle') {
        // 忙碌是暂态：回合结束事件会再触发；error / 其他状态不再轮询
        if (session.status === 'running' || session.status === 'waiting-approval') {
          schedule(sessionId);
        }
        return;
      }
      const sent = await hosts.agentHost.prompt(sessionId, wakePrompt(messages));
      if (sent.ok) hosts.registry.ackMessages(messages.map((message) => message.id));
      else schedule(sessionId);
    } catch (error) {
      hosts.log?.(`coordinator wake failed: ${errorMessage(error)}`);
    }
  };

  hosts.registry.onMessage((_workspaceId, message) => {
    if (WAKE_TYPES.has(message.type)) schedule(message.to);
  });

  hosts.agentHost.observe({
    event: (envelope: SessionEventEnvelope) => {
      if (envelope.event.type === 'agent_settled') schedule(envelope.sessionId);
    },
  });
}
