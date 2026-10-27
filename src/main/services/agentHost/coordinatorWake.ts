import type { Message } from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import type { OrchestrationRegistry } from '../orchestration/registry';
import type { PendingCoordinatorReview } from '../orchestration/service';
import type { AgentHostService } from './agentHost';

const WAKE_TYPES: ReadonlySet<string> = new Set(['worker_done', 'question', 'escalation']);
const BODY_MAX_CHARS = 6_000;
/** Initial delivery plus one continuation per attempt; a new user turn can explicitly resume. */
const MAX_REVIEW_PROMPTS = 2;
const MAX_DELIVERY_ATTEMPTS = 3;

function clipped(body: string): string {
  return body.length > BODY_MAX_CHARS
    ? `${body.slice(0, BODY_MAX_CHARS)}\n…(${body.length - BODY_MAX_CHARS} more characters)`
    : body;
}

function nextStep(message: Message): string {
  const target = message.dispatchId ? `dispatch_id \`${message.dispatchId}\`` : 'its dispatch_id';
  switch (message.type) {
    case 'question':
      return `answer with send_to_worker (${target}); the worker is blocked until you reply.`;
    case 'escalation':
      return `decide how to proceed (ask the user when the decision is theirs), then use the appropriate orchestration tool (${target}). To explicitly abandon a dispatched task, call cleanup_worktree with abandon: true; ordinary cleanup does not cancel or accept pending work.`;
    default:
      return `check list_workers for the current task and attempt (${target}). A failed report needs diagnosis and a retry decision, not acceptance; a successful report needs review before acceptance.`;
  }
}

function entry(message: Message, index: number): string {
  const ref = message.dispatchId ? ` · dispatch \`${message.dispatchId}\`` : '';
  const subject = message.subject ? ` — ${message.subject}` : '';
  return [
    `### ${index + 1}. ${message.type}${ref}${subject}`,
    `- from: ${message.from} · message_id: \`${message.id}\``,
    '',
    clipped(message.body),
    '',
    `Next: ${nextStep(message)}`,
  ].join('\n');
}

export function wakePrompt(
  messages: readonly Message[],
  reviews: readonly PendingCoordinatorReview[] = []
): string {
  return [
    '[Fynvra orchestration] Automated notification — not a message from the user.',
    '',
    ...(messages.length
      ? [`New worker messages (${messages.length}):`, messages.map(entry).join('\n\n')]
      : []),
    ...(reviews.length
      ? [
          'Successful attempts still awaiting review (in-review; message delivery is not acceptance):',
          ...reviews.map(
            ({ taskId, title, dispatch }) =>
              `- ${title} · task \`${taskId}\` · current dispatch_id \`${dispatch.id}\`\n${clipped(dispatch.summary ?? '')}`
          ),
        ]
      : []),
    '',
    'Handle these now. Check list_workers for current status and dispatch IDs before acting; read_worker_output for the latest report and follow-ups. Answer questions with send_to_worker. For successful work, review_diff and run_checks as appropriate to the task and the user’s instructions, then explicitly accept with merge_worktree or reject_work with concrete feedback. Read-only audits may have no code changes: review their findings and evidence; do not invent a commit or checks. A successful read-only or empty-diff task still needs merge_worktree acceptance. Only after acceptance, use cleanup_worktree for cleanup. Do not merge solely because report_done says succeeded, and do not use cleanup_worktree as acceptance. To explicitly cancel pending work, use cleanup_worktree with abandon: true; this abandons the task rather than completing it.',
    'Respect the user’s latest instructions, stop requests and required approvals. If a decision or approval is needed, explain the specific blocker to the user and stop. Otherwise resolve the pending reviews before your final response. Automatic continuation is bounded; do not loop on a blocked check. Workers still running keep going; you do not need to call wait_for_workers.',
  ].join('\n');
}

export interface CoordinatorWakeHosts {
  agentHost: Pick<AgentHostService, 'get' | 'promptWhenIdle' | 'observe'>;
  registry: Pick<OrchestrationRegistry, 'onMessage' | 'coordinatorWork' | 'ackMessages'>;
  log?(message: string): void;
}

export interface CoordinatorWakeOptions {
  /** Debounce and settling buffer, default 400ms. */
  delayMs?: number;
}

interface WakeState {
  timer?: ReturnType<typeof setTimeout>;
  inFlight: boolean;
  again: boolean;
  paused: boolean;
  failures: number;
  reviews: Map<string, number>;
  warned: Set<string>;
}

/**
 * Inbox ack means delivered, not reviewed. Reconcile current in-review attempts on every idle/settled
 * event, including after wait_for_workers consumed the report. Busy sessions wait for events, never
 * poll. Stop/abort suspends automation until an explicit prompt; failures and unresolved reviews have
 * bounded retries. Restored state is reconciled when the coordinator resumes: launching the app alone
 * must not revive a previously stopped conversation (the stop intent is not persisted in task state).
 */
export function installCoordinatorWake(
  hosts: CoordinatorWakeHosts,
  options: CoordinatorWakeOptions = {}
): void {
  const delayMs = options.delayMs ?? 400;
  const states = new Map<string, WakeState>();
  const log = hosts.log ?? ((message: string) => console.warn(`[coordinator-wake] ${message}`));
  const stateOf = (sessionId: string): WakeState => {
    let state = states.get(sessionId);
    if (!state) {
      state = {
        inFlight: false,
        again: false,
        paused: false,
        failures: 0,
        reviews: new Map(),
        warned: new Set(),
      };
      states.set(sessionId, state);
    }
    return state;
  };

  const schedule = (sessionId: string, delay = delayMs): void => {
    const state = stateOf(sessionId);
    if (state.paused) return;
    if (state.inFlight) {
      state.again = true;
      return;
    }
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void flush(sessionId, state);
    }, delay);
  };

  const pause = (sessionId: string): void => {
    const state = stateOf(sessionId);
    state.paused = true;
    state.again = false;
    clearTimeout(state.timer);
    state.timer = undefined;
  };

  const flush = async (sessionId: string, state: WakeState): Promise<void> => {
    if (state.paused || state.inFlight || state.failures >= MAX_DELIVERY_ATTEMPTS) return;
    const session = hosts.agentHost.get(sessionId);
    if (session?.status !== 'idle' || session.archivedAt !== undefined) return;
    state.inFlight = true;
    let retry = false;
    try {
      const work = hosts.registry.coordinatorWork(sessionId);
      const currentIds = new Set(work.reviews.map(({ dispatch }) => dispatch.id));
      for (const id of state.reviews.keys()) {
        if (!currentIds.has(id)) {
          state.reviews.delete(id);
          state.warned.delete(id);
        }
      }
      const reviews = work.reviews.filter(({ dispatch }) => {
        if ((state.reviews.get(dispatch.id) ?? 0) < MAX_REVIEW_PROMPTS) return true;
        if (!state.warned.has(dispatch.id)) {
          state.warned.add(dispatch.id);
          log(
            `session ${sessionId}: review ${dispatch.id} is still unresolved after ${MAX_REVIEW_PROMPTS} automatic prompts; waiting for a user continuation or a new worker message`
          );
        }
        return false;
      });
      if (!work.messages.length && !reviews.length) return;
      const sent = await hosts.agentHost.promptWhenIdle(
        sessionId,
        wakePrompt(work.messages, reviews)
      );
      if (!sent.ok) throw new Error(sent.error);
      if (!sent.delivered) return; // A user turn/abort won the race during spawn; wait for its lifecycle.
      state.failures = 0;
      for (const { dispatch } of reviews) {
        state.reviews.set(dispatch.id, (state.reviews.get(dispatch.id) ?? 0) + 1);
      }
      hosts.registry.ackMessages(work.messages.map((message) => message.id));
    } catch (error) {
      state.failures += 1;
      retry = state.failures < MAX_DELIVERY_ATTEMPTS;
      log(
        `session ${sessionId}: coordinator wake failed (${state.failures}/${MAX_DELIVERY_ATTEMPTS}): ${errorMessage(error)}${retry ? '; retrying' : '; waiting for a user continuation or a new worker message'}`
      );
    } finally {
      state.inFlight = false;
      const again = state.again;
      state.again = false;
      if (retry || again)
        schedule(sessionId, retry ? delayMs * 2 ** (state.failures - 1) : delayMs);
    }
  };

  hosts.registry.onMessage((_workspaceId, message) => {
    if (!WAKE_TYPES.has(message.type)) return;
    stateOf(message.to).failures = 0;
    schedule(message.to);
  });

  hosts.agentHost.observe({
    activity: (sessionId, action) => {
      if (action === 'abort') return pause(sessionId);
      if (action === 'prompt') {
        const state = stateOf(sessionId);
        state.paused = false;
        state.failures = 0;
        state.reviews.clear();
        state.warned.clear();
      }
      schedule(sessionId);
    },
    event: ({ sessionId, event }) => {
      if (event.type !== 'agent_settled') return;
      if (event.aborted) pause(sessionId);
      else schedule(sessionId);
    },
  });
}
