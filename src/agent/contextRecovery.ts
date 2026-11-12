import type { ImageContent } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { NormalizedSubscription } from '@fynvra/agent-runtime';
import type { CompactionState, ContextRuntimeSnapshot, FynvraSessionEvent } from '@fynvra/core';
import { asRecord } from '@shared/guards';
import type { ChatImage } from '@shared/types/chat';
import { parseChatImages, stripImageHints } from '@shared/types/chat';
import type { CompactionStrategy } from '@shared/types/settings';
import { type SlashCommandRun, startExtensionCommand } from './slashCommands';

const CHECKPOINT = 'fynvra-context-recovery';
const BLOCKED = 'Context recovery required. Retry context recovery before continuing.';
const COMPACTION_FAILED =
  'Context compaction failed; the conversation is kept. Send a message to try again.';
interface PendingInput {
  text: string;
  images?: ChatImage[];
  submitted: boolean;
}
interface Options {
  session: AgentSession;
  strategy: CompactionStrategy;
  timeoutMs: number;
  contextWindow(): number;
  log(message: string): void;
  /** Readiness plus the Magic cancellation generation; never authorizes native compaction. */
  magicReady?(): AbortSignal;
  /** This session's MCP server names, so `/mcp login <unknown>` fails at once. */
  mcpServers?: readonly string[];
  /** Delay before a silent slash command gets a "still running" hint (tests). */
  commandHintMs?: number;
}

/** Host-owned gate around public SDK APIs. No listener throws and no private SDK state is mutated. */
export function createContextRecovery({
  session,
  strategy,
  timeoutMs,
  contextWindow,
  log,
  magicReady,
  mcpServers,
  commandHintMs,
}: Options) {
  let events: Pick<NormalizedSubscription, 'emit' | 'cancelCompaction'> | undefined;
  let effective = strategy;
  const usesMagic = strategy === 'magic-context';
  // Magic stopped for this session: pass context through and compact with the fallback chain.
  let magicFallback = false;
  const magicActive = () => usesMagic && !magicFallback;
  let compaction: CompactionState | undefined;
  let retry: ContextRuntimeSnapshot['retry'];
  let blocked = false;
  let stopped = false;
  // A failed compaction ends the current turn (no auto-continuation with the oversized context);
  // the next submitted input clears it and triggers compaction again.
  let turnStopped = false;
  let stopSource: NonNullable<CompactionState['cancelSource']> = 'user';
  let disposed = false;
  let recovering = false;
  let recoveryFailed = false;
  let lastAssistantAborted = false;
  let recoveryAbort: AbortController | undefined;
  let magicPrepared = false;
  let running = false;
  let resume = false;
  let resumeCompactionId: string | undefined;
  let lastCompactionId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending: PendingInput[] = [];
  /** Extension commands Fynvra is running instead of a prompt; Stop releases them at once. */
  const commands = new Set<SlashCommandRun>();
  let drained: Promise<void> = Promise.resolve();

  // Recovery survives unloading/restarting without putting message bodies in settings.json.
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type === 'compaction') {
      lastCompactionId = entry.id;
      // The SDK committed before we could write our next checkpoint (including process exit).
      if (blocked) resumeCompactionId = entry.id;
      continue;
    }
    if (entry.type === 'message' && entry.message.role === 'user') {
      const content = entry.message.content;
      const text =
        typeof content === 'string'
          ? content
          : content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('');
      const index = pending.findIndex(
        (input) => input.text === (input.images?.length ? stripImageHints(text) : text)
      );
      if (pending.length) {
        pending.splice(Math.max(index, 0), 1);
        resume = true;
      }
      continue;
    }
    if (entry.type !== 'custom' || entry.customType !== CHECKPOINT) continue;
    const data = asRecord(entry.data);
    if (!data || typeof data.blocked !== 'boolean' || !Array.isArray(data.pending)) continue;
    blocked = data.blocked;
    resumeCompactionId =
      typeof data.resumeCompactionId === 'string' && data.resumeCompactionId === lastCompactionId
        ? data.resumeCompactionId
        : undefined;
    resume = data.resume === true;
    pending.length = 0;
    for (const item of data.pending) {
      const input = asRecord(item);
      if (!input || typeof input.text !== 'string') continue;
      const images = input.images === undefined ? undefined : parseChatImages(input.images);
      if (images === null) continue;
      pending.push({ text: input.text, ...(images ? { images } : {}), submitted: false });
    }
  }
  function checkpoint() {
    if (disposed) return;
    session.sessionManager.appendCustomEntry(CHECKPOINT, {
      // The live provider gate may open after compact(), but durable recovery ends only after resumption.
      blocked: blocked || recovering,
      ...(resumeCompactionId ? { resumeCompactionId } : {}),
      resume,
      pending: pending.map(({ text, images }) => ({ text, ...(images ? { images } : {}) })),
    });
  }
  function snapshot(): ContextRuntimeSnapshot {
    const usage = session.getContextUsage();
    const window = contextWindow();
    const settings = session.settingsManager.getCompactionSettings(session.model);
    const tokens = usage?.tokens ?? null;
    return {
      configuredStrategy: strategy,
      effectiveStrategy: effective,
      compactionTimeoutMs: timeoutMs,
      context: {
        tokens,
        contextWindow: window,
        source: tokens === null ? 'unknown' : 'sdk',
        ...(effective === 'native'
          ? { compactionThresholdTokens: Math.max(0, window - settings.reserveTokens) }
          : {}),
      },
      ...(compaction ? { compaction } : {}),
      ...(retry ? { retry } : {}),
      recoveryRequired: blocked || recovering,
      pendingPromptCount: pending.length,
    };
  }
  function publish() {
    if (!disposed && events) events.emit({ type: 'context_runtime', snapshot: snapshot() });
  }
  function writeLog(message: string) {
    try {
      log(message);
    } catch {
      /* A disconnected diagnostic channel must not bypass cancellation. */
    }
  }
  function clearTimer() {
    clearTimeout(timer);
    timer = undefined;
  }
  function cancel(source: NonNullable<CompactionState['cancelSource']>) {
    stopped = true;
    stopSource = source;
    clearTimer();
    recoveryAbort?.abort();
    // Cancel the downstream request/backoff first. SDK checks this same signal before appendCompaction.
    session.abortCompaction();
    session.clearQueue();
    void session.abort().catch(() => undefined);
    events?.cancelCompaction(source);
  }
  function requestBlocked() {
    return (
      disposed ||
      stopped ||
      turnStopped ||
      (blocked && !(magicActive() && recovering && !recoveryFailed))
    );
  }
  /** Requests and automatic compaction stay off until the next input, so the turn cannot loop. */
  function stopTurn() {
    turnStopped = true;
    session.setAutoCompactionEnabled(false);
  }
  function gateError() {
    return new Error(turnStopped && !stopped && !blocked ? COMPACTION_FAILED : BLOCKED);
  }
  /** Compaction deadline outside explicit recovery: end this compaction and turn, not the session. */
  function timeoutCompaction() {
    clearTimer();
    stopTurn();
    session.abortCompaction();
    events?.cancelCompaction('timeout');
  }
  function overThreshold() {
    const tokens = session.getContextUsage()?.tokens;
    const { reserveTokens } = session.settingsManager.getCompactionSettings(session.model);
    return tokens == null || tokens > contextWindow() - reserveTokens;
  }
  if (usesMagic) {
    const transform = session.agent.transformContext;
    session.agent.transformContext = async (messages, signal) => {
      if (requestBlocked()) throw gateError();
      // Suspended Magic hooks are inert; other extensions' context hooks still run.
      const passThrough = async () => (transform ? transform(messages, signal) : messages);
      if (magicFallback) return passThrough();
      try {
        if (!magicReady || !transform) throw new Error(BLOCKED);
        const generation = magicReady();
        const result = await transform(messages, signal);
        // SDK extension errors can be swallowed. The vendor reports them to our gate;
        // check again after hooks, and reject transformations from an interrupted generation.
        if (generation.aborted || signal?.aborted || requestBlocked()) throw gateError();
        magicReady();
        if (recovering) magicPrepared = true;
        return result;
      } catch (error) {
        // Magic stopped during this request: continue on the fallback chain instead of locking.
        if (magicFallback && !signal?.aborted && !requestBlocked()) return passThrough();
        throw error;
      }
    };
  }
  const prepare = session.agent.prepareRequest;
  session.agent.prepareRequest = async (request, signal) => {
    if (requestBlocked()) throw gateError();
    const result = await prepare?.(request, signal);
    // prepareRequest/prepareNextTurn may have attempted compaction and returned the old projection.
    if (requestBlocked() || signal?.aborted) throw gateError();
    return result || undefined;
  };

  function onEvent(event: FynvraSessionEvent) {
    // compact() awaits abort() before allocating its controller; Stop may arrive in that gap.
    if (event.type === 'compaction' && event.state.phase === 'running' && (stopped || disposed)) {
      cancel(stopSource);
    }
    if (disposed) return;
    if (magicActive() && recovering) {
      // Normalized provider errors are final: transient attempts settle only after SDK retries.
      if (
        event.type === 'error' ||
        (event.type === 'agent_settled' && (event.aborted || lastAssistantAborted))
      ) {
        recoveryFailed = true;
      }
    }
    if (event.type === 'compaction') {
      compaction = event.state;
      if (compaction.phase === 'running' || compaction.phase === 'backoff') {
        if (!timer) {
          writeLog(
            `operation=${compaction.operationId} start reason=${compaction.reason} deadline=${compaction.deadlineAt}`
          );
          timer = setTimeout(
            () => (recovering ? cancel('timeout') : timeoutCompaction()),
            Math.max(0, compaction.deadlineAt - Date.now())
          );
        }
      } else {
        clearTimer();
        writeLog(
          `operation=${compaction.operationId} end phase=${compaction.phase} durationMs=${compaction.durationMs ?? 0} source=${compaction.cancelSource ?? 'sdk'}`
        );
        // Magic legitimately cancels the native hook while it owns context. It is not a native failure.
        const magicOwns = effective === 'magic-context' && compaction.cancelSource === 'sdk';
        if (compaction.phase === 'succeeded' && recovering) {
          resumeCompactionId = session.sessionManager
            .getBranch()
            .findLast((entry) => entry.type === 'compaction')?.id;
          checkpoint();
        }
        // A failed compaction does not lock the session (oh-my-pi): the history is intact, pi
        // does not auto-continue the turn, and the next message triggers compaction again.
        if (compaction.phase !== 'succeeded' && !magicOwns) {
          resumeCompactionId = undefined;
          if (compaction.cancelSource !== 'user' && compaction.cancelSource !== 'shutdown') {
            stopTurn();
            // Fixed text: provider errors may echo prompt content.
            events?.emit({ type: 'error', source: 'compaction', message: COMPACTION_FAILED });
          }
        }
      }
      publish();
    } else if (event.type === 'retry') {
      retry = event.state;
      publish();
    } else if (event.type === 'message_end') {
      if (event.role === 'user') {
        const exact = pending.findIndex(
          (input) =>
            input.submitted &&
            input.text === (input.images?.length ? stripImageHints(event.text) : event.text)
        );
        const index = exact >= 0 ? exact : pending.findIndex((input) => input.submitted);
        if (index >= 0) pending.splice(index, 1);
        resume = true;
        // SDK persists message_end synchronously after listener delivery. Never throw in the listener.
        queueMicrotask(() => {
          if (!disposed) {
            checkpoint();
            publish();
          }
        });
      } else {
        if (magicActive() && recovering) {
          // Observe cancellation here, but let the SDK finish retries before deciding the outcome.
          lastAssistantAborted = event.stopReason === 'aborted';
        }
        queueMicrotask(publish);
      }
    }
  }
  async function submit(input: PendingInput, steer = false) {
    input.submitted = true;
    if (turnStopped) {
      turnStopped = false;
      session.setAutoCompactionEnabled(effective === 'native');
    }
    const command = startExtensionCommand(
      session,
      input.text,
      (level, text) => events?.emit({ type: 'notice', level, text }),
      { ...(mcpServers ? { mcpServers } : {}), ...(commandHintMs ? { hintMs: commandHintMs } : {}) }
    );
    if (command) {
      // The command consumes its input at once: a reload must not run it (e.g. a sign-in) again.
      const index = pending.indexOf(input);
      if (index >= 0) pending.splice(index, 1);
      checkpoint();
      publish();
      events?.emit({ type: 'command', text: input.text });
      commands.add(command);
      let aborted = true;
      try {
        await command.done;
      } finally {
        // stopCommands() already removed a stopped command.
        aborted = !commands.delete(command);
      }
      // A command typed during a turn must not settle it; that turn's agent_settled will.
      if (!session.isStreaming) events?.emit({ type: 'command_end', aborted });
      return;
    }
    const images: ImageContent[] | undefined = input.images?.map((image) => ({
      type: 'image',
      ...image,
    }));
    if (steer && session.isStreaming) {
      await session.steer(input.text, images);
      return;
    }
    await session.prompt(input.text, {
      streamingBehavior: 'followUp',
      ...(images ? { images } : {}),
      preflightResult: (result) => {
        if (result === 'handled') {
          const index = pending.indexOf(input);
          if (index >= 0) pending.splice(index, 1);
          checkpoint();
        }
      },
    });
  }
  async function drain(duringRecovery = false) {
    const allowed = () => !blocked || (duringRecovery && magicActive() && !recoveryFailed);
    if (running || (recovering && !duringRecovery) || !allowed() || stopped || disposed) return;
    running = true;
    const { promise, resolve } = Promise.withResolvers<void>();
    drained = promise;
    try {
      while (pending.length && allowed() && !stopped && !disposed) {
        const input = pending[0];
        if (!input) break;
        await submit(input);
        // A rejected preflight must not silently consume an acknowledged input.
        if (pending.includes(input)) break;
      }
      if (allowed() && !stopped && !recoveryFailed) resume = false;
    } catch (error) {
      if (compaction?.phase === 'running' || compaction?.phase === 'backoff') cancel('exception');
      throw error;
    } finally {
      resolve();
      running = false;
      for (const input of pending) input.submitted = false;
      checkpoint();
      publish();
    }
  }
  /** Stop running commands; their handlers finish in the background with output dropped. */
  function stopCommands() {
    const any = commands.size > 0;
    for (const command of commands) command.stop();
    commands.clear();
    return any;
  }
  return {
    bind(subscription: Pick<NormalizedSubscription, 'emit' | 'cancelCompaction'>) {
      events = subscription;
      publish();
    },
    onEvent,
    publish,
    /**
     * Magic stopped for this session (any reason): do not lock. Pass context through and let pi
     * compact with the fallback chain (threshold before the next request, overflow with retry).
     * Lasts for the session's lifetime; a new Magic binding is created only on reload.
     */
    fallBack() {
      if (disposed || !usesMagic || magicFallback) return;
      magicFallback = true;
      effective = 'native';
      session.setAutoCompactionEnabled(true);
      writeLog('magic-context stopped; switched to the compaction fallback chain');
      publish();
    },
    async prompt(text: string, images?: ChatImage[], steer = false) {
      const input: PendingInput = { text, ...(images?.length ? { images } : {}), submitted: false };
      pending.push(input);
      checkpoint();
      publish();
      if (blocked || recovering) return;
      stopped = false;
      if (running && !session.isCompacting) await submit(input, steer);
      else await drain();
    },
    async retryCompaction() {
      if (recovering || running || !session.isIdle) throw new Error('The session is busy.');
      if (!blocked) throw new Error('No compaction recovery is required.');
      recovering = true;
      recoveryFailed = false;
      lastAssistantAborted = false;
      const controller = new AbortController();
      recoveryAbort = controller;
      magicPrepared = false;
      stopped = false;
      let completed = false;
      publish();
      try {
        // A previous attempt may have committed the summary before exit/Stop. Reuse that boundary;
        // compacting the already compacted projection again can fail with "session too small".
        if (magicActive()) {
          // Main reloads the plugin before this explicit operation. Do not treat an old
          // native checkpoint (or plugin readiness alone) as successful compaction.
          if (!magicReady) throw new Error(BLOCKED);
          try {
            magicReady();
          } catch (error) {
            // An unready plugin switches the session to the fallback chain (handled below).
            if (!magicFallback) throw error;
          }
        }
        // After a Magic fallback, compact only when needed: a small session has nothing to compact.
        if (!magicActive() && !resumeCompactionId && (!usesMagic || overThreshold())) {
          await session.compact();
          if (compaction?.phase !== 'succeeded') return;
        }
        if (stopped || disposed) return;
        // Native needs a committed summary. Magic validates context before any provider request;
        // its durable lock remains set through validation and any interrupted run's resumption.
        if (!magicActive()) blocked = false;
        checkpoint();
        if (magicActive() && pending.length === 0 && !resume) {
          // An idle/startup failure has no interrupted task to resume. Validate the actual
          // projection (even when empty) through the same guarded hooks, without inventing
          // an input, replacing agent history, or starting a provider turn.
          const transform = session.agent.transformContext;
          if (!transform) throw new Error(BLOCKED);
          await transform(session.messages, controller.signal);
        } else if (pending.length === 0 && resume) {
          await session.sendCustomMessage(
            {
              customType: 'fynvra-compaction-resume',
              content: magicActive()
                ? 'Resume the interrupted turn from the existing conversation using Magic Context. Do not repeat completed work.'
                : 'Context compaction completed. Resume the interrupted turn from the existing conversation.',
              display: false,
            },
            { triggerTurn: true }
          );
          if (!stopped && !recoveryFailed && (!blocked || (magicActive() && magicPrepared))) {
            resume = false;
          }
        }
        await drain(true);
        completed =
          (!blocked || (magicActive() && magicPrepared)) &&
          !recoveryFailed &&
          !stopped &&
          !disposed &&
          pending.length === 0 &&
          !resume;
      } catch {
        blocked = true;
        if (compaction?.phase === 'running' || compaction?.phase === 'backoff') cancel('exception');
        throw new Error(BLOCKED);
      } finally {
        blocked = !completed;
        if (completed) resumeCompactionId = undefined;
        recoveryAbort = undefined;
        recovering = false;
        checkpoint();
        publish();
      }
    },
    async abort() {
      const stoppedCommand = stopCommands();
      cancel('user');
      await session.abort();
      // The drain loop leaves on the next ticks; wait so the caller sees the session idle.
      if (stoppedCommand) await drained;
    },
    dispose() {
      if (disposed) return;
      stopCommands();
      cancel('shutdown');
      checkpoint();
      disposed = true;
    },
    isIdle() {
      return !running && !recovering && commands.size === 0 && session.isIdle;
    },
  };
}
