import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Message } from '@earendil-works/pi-ai';
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import type { ResolvedModel } from '@fynvra/agent-runtime';
import type { MagicContextFallbackReason } from '@fynvra/core';
import { errorMessage } from '@shared/guards';

/**
 * Fynvra host for the vendored Magic Context extension (see
 * packages/agent-runtime/vendor/magic-context/NOTICE).
 *
 * The plugin normally runs its historian by re-executing the current Pi binary
 * with `--print`. In Fynvra that would be the Electron executable, so the
 * vendored `PiSubagentRunner.run` delegates to this module instead. The host
 * runner uses the session's own ModelRuntime/model (the same provider and key
 * the session already uses), keeps the call in-process, and bounds it with the
 * session's lifetime and a timeout.
 *
 * Routing is per Pi session id. There is deliberately no process-global
 * "current session/model": one worker hosts many sessions and the registry
 * below maps each plugin call back to the session recorded at creation time.
 * `accountingSessionId` is the Pi session id supplied by the plugin.
 */

const RUNNER_SYMBOL = Symbol.for('fynvra.magic-context.subagent-runner');
const BOOT_SYMBOL = Symbol.for('fynvra.magic-context.report-boot');
const BOOT_OK_SYMBOL = Symbol.for('fynvra.magic-context.boot-ok');
const SUSPEND_SYMBOL = Symbol.for('fynvra.magic-context.suspend-listener');
const BUDGET_SYMBOL = Symbol.for('fynvra.magic-context.historian-budget');
const PUBLISHED_SYMBOL = Symbol.for('fynvra.magic-context.published');

/** Magic Context's internal agent names that may ask for a historian subagent. */
const HISTORIAN_AGENTS = new Set([
  'magic-context-historian',
  'historian',
  'historian-recomp',
  'historian-editor',
]);

/** Allocation guard; history is split at complete block boundaries, never sliced. */
const MAX_HISTORIAN_PROMPT_CHARS = 2_000_000;
/** Hard local cap in addition to the plugin's configured historian timeout. */
const MAX_HISTORIAN_TIMEOUT_MS = 5 * 60_000;
/** Consecutive transient failures before suspending this session for explicit recovery. */
const TRANSIENT_FAILURE_LIMIT = 3;
/** Token headroom for message framing / provider overhead. */
const CONTEXT_SAFETY_TOKENS = 2_048;
/** Do not start a historian request with less output room than this. */
const MIN_HISTORIAN_OUTPUT_TOKENS = 1_024;

interface MagicSubagentOptions {
  agent: string;
  systemPrompt: string;
  userMessage: string;
  model?: string;
  timeoutMs?: number;
  cwd?: string;
  signal?: AbortSignal;
  thinkingLevel?: string;
  temperature?: number;
  maxOutputTokens?: number;
  onProgress?: (event: unknown) => void;
  accountingSessionId?: string;
  accountingSubagent?: string;
  [key: string]: unknown;
}

interface MagicSubagentResult {
  ok: boolean;
  assistantText?: string;
  durationMs: number;
  reason?: string;
  error?: string;
  toolCallCount?: number;
  transient?: boolean;
}

interface MagicOperation {
  signal: AbortSignal;
  isCurrent(): boolean;
  onFailure(reason: MagicContextFallbackReason): void;
}

interface MagicContextModule {
  default(pi: ExtensionAPI): void | Promise<void>;
  /** Added by vendor patch: inspect or invalidate this session's Magic binding. */
  fynvraIsSessionReady(sessionId: string): boolean;
  fynvraSuspendSession(sessionId: string, reason?: string): void;
  fynvraInterruptSession(sessionId: string): void;
  fynvraCloseSession(sessionId: string): void;
  fynvraBindSession(
    pi: ExtensionAPI,
    sessionId: string,
    capture: () => MagicOperation
  ): ExtensionAPI;
  fynvraRunSessionOperation(
    capture: () => MagicOperation,
    operation: () => void | Promise<void>
  ): Promise<void>;
}

interface SessionRunner {
  getModel(): ResolvedModel;
  abort: AbortController;
  inFlight: boolean;
  disposed: boolean;
  suspended: boolean;
  fallbackNotified: boolean;
  failureStreak: number;
  onFallback?: (reason: MagicContextFallbackReason) => void;
}

const sessionRunners = new Map<string, SessionRunner>();

let pluginModule: Promise<MagicContextModule> | null = null;
let pluginModuleError: unknown;
let loadedPluginModule: MagicContextModule | undefined;

export interface MagicContextCompaction {
  /** Inline extension for createRoleSession; a no-op when the host is unavailable. */
  readonly extension: InlineExtension;
  /** Load/boot problems; merged into the session warnings. */
  readonly warnings: string[];
  /** Register the Pi session id before the extension is bound. */
  attach(piSessionId: string): void;
  /** Reject requests until the plugin is ready; return the current cancellation generation. */
  assertReady(): AbortSignal;
  /** Stop unsafe requests and retain this session for explicit recovery. */
  suspend(reason: MagicContextFallbackReason): void;
  /** Stop/model changes invalidate current operations without treating cancellation as failure. */
  interrupt(): void;
  /** Abort an in-flight historian and drop the routing entry. */
  dispose(): void;
}

export interface MagicContextCompactionOptions {
  /** Called once when this session must stop for explicit Magic recovery (never native fallback). */
  onFallback?: (reason: MagicContextFallbackReason) => void;
}

/**
 * Prepare a Magic Context extension for one session. The plugin is imported
 * lazily once per worker; each session still gets its own extension binding and
 * its own historian routing entry.
 */
export function createMagicContextCompaction(
  getModel: () => ResolvedModel,
  options: MagicContextCompactionOptions = {}
): MagicContextCompaction {
  const warnings: string[] = [];
  let piSessionId: string | undefined;
  let runner: SessionRunner | undefined;

  const notifyFallback = (reason: MagicContextFallbackReason) => {
    if (!runner || runner.fallbackNotified || runner.disposed) return;
    if (piSessionId) suspendSession(piSessionId, reason);
  };

  const extension: InlineExtension = {
    name: 'fynvra-magic-context',
    hidden: true,
    factory: async (pi) => {
      // Defense for manual SDK compaction as well as startup failure before vendor hooks exist.
      pi.on('session_before_compact', async () => ({ cancel: true }));
      const host = prepareHost();
      if (!host.ok) {
        warnings.push(host.warning);
        notifyFallback('startup');
        return;
      }
      let module: MagicContextModule;
      try {
        module = await loadPlugin(host.pluginDir);
      } catch (error) {
        warnings.push(
          `Magic Context plugin could not be loaded (${errorMessage(error)}); session paused for recovery.`
        );
        notifyFallback('startup');
        return;
      }

      let bootStatus: string | undefined;
      // A host-owned wrapper, not a mutation of Pi's ExtensionAPI object. The
      // vendored plugin reads boot status / boot readiness through these
      // symbols; a non-extensible API or a missing report blocks requests and
      // produces a visible recovery warning.
      const pluginApi = new Proxy({} as ExtensionAPI, {
        get(_target, property) {
          if (property === BOOT_SYMBOL) {
            return (status: unknown) => {
              if (typeof status === 'string') bootStatus = status;
            };
          }
          if (property === BOOT_OK_SYMBOL) return bootStatus === 'ready';
          const value = Reflect.get(pi, property, pi);
          return typeof value === 'function' ? value.bind(pi) : value;
        },
      });
      try {
        const attached = runner;
        const id = piSessionId;
        if (!attached || !id || attached.disposed) return;
        const capture = (): MagicOperation => {
          const controller = attached.abort;
          return {
            signal: controller.signal,
            isCurrent: () =>
              sessionRunners.get(id) === attached &&
              !attached.disposed &&
              !attached.suspended &&
              !controller.signal.aborted,
            onFailure: (reason) => suspendSession(id, reason),
          };
        };
        const guardedApi = module.fynvraBindSession(pluginApi, id, capture);
        await module.fynvraRunSessionOperation(capture, () => module.default(guardedApi));
      } catch (error) {
        warnings.push(
          `Magic Context failed to start (${errorMessage(error)}); session paused for recovery.`
        );
        notifyFallback('startup');
        return;
      }
      if (bootStatus === undefined) {
        warnings.push('Magic Context did not report startup; session paused for recovery.');
        notifyFallback('startup');
      } else if (bootStatus !== 'ready') {
        warnings.push(
          `Magic Context storage did not initialize (${bootStatus}); session paused for recovery.`
        );
        notifyFallback('startup');
      }
    },
  };

  return {
    extension,
    warnings,
    attach(id) {
      if (!piSessionId && id) {
        piSessionId = id;
        runner = {
          getModel,
          abort: new AbortController(),
          inFlight: false,
          disposed: false,
          suspended: false,
          fallbackNotified: false,
          failureStreak: 0,
          ...(options.onFallback ? { onFallback: options.onFallback } : {}),
        };
        sessionRunners.set(id, runner);
      }
    },
    assertReady() {
      if (
        !runner ||
        runner.disposed ||
        runner.suspended ||
        !piSessionId ||
        !loadedPluginModule?.fynvraIsSessionReady(piSessionId)
      ) {
        notifyFallback('startup');
        throw new Error(
          'Magic Context is unavailable. Retry context recovery after fixing the cause.'
        );
      }
      return runner.abort.signal;
    },
    suspend: notifyFallback,
    interrupt() {
      if (!runner || runner.disposed || runner.suspended) return;
      if (piSessionId) loadedPluginModule?.fynvraInterruptSession(piSessionId);
      runner.abort.abort();
      runner.abort = new AbortController();
    },
    dispose() {
      if (runner) {
        if (piSessionId && sessionRunners.get(piSessionId) === runner) {
          loadedPluginModule?.fynvraInterruptSession(piSessionId);
        }
        runner.disposed = true;
        runner.abort.abort();
        if (piSessionId && sessionRunners.get(piSessionId) === runner) {
          loadedPluginModule?.fynvraCloseSession(piSessionId);
          sessionRunners.delete(piSessionId);
        }
        runner = undefined;
      }
    },
  };
}

/**
 * Build the host environment paths once (Main writes them before forking the
 * worker). This is app-wide and fixed for the worker lifetime, not a per-session
 * chdir or env swap.
 */
function prepareHost(): { ok: true; pluginDir: string } | { ok: false; warning: string } {
  if (process.env.MAGIC_CONTEXT_FYNVRA_HOST !== '1') {
    return {
      ok: false,
      warning: 'Magic Context host marker is missing; session paused for recovery.',
    };
  }
  const pluginDir = process.env.MAGIC_CONTEXT_PLUGIN_DIR?.trim() ?? '';
  const storageDir = process.env.MAGIC_CONTEXT_STORAGE_DIR?.trim() ?? '';
  const configFile = process.env.MAGIC_CONTEXT_CONFIG_FILE?.trim() ?? '';
  if (!pluginDir || !isAbsolute(pluginDir) || !existsSync(join(pluginDir, 'dist', 'index.js'))) {
    return {
      ok: false,
      warning: `Magic Context plugin files are missing at ${pluginDir || '(unset)'}; session paused for recovery.`,
    };
  }
  if (!storageDir || !isAbsolute(storageDir)) {
    return {
      ok: false,
      warning:
        'Magic Context storage directory is missing or not absolute; session paused for recovery.',
    };
  }
  if (!configFile || !isAbsolute(configFile) || !existsSync(configFile)) {
    return {
      ok: false,
      warning: 'Magic Context host config is missing; session paused for recovery.',
    };
  }
  try {
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as {
      fail_closed_blocking?: unknown;
      compaction?: { enabled?: unknown };
      dreamer?: { disable?: unknown };
      sidekick?: { disable?: unknown };
      memory?: { enabled?: unknown };
      embedding?: { provider?: unknown };
      todowrite?: { enabled?: unknown };
    };
    if (
      config.fail_closed_blocking !== true ||
      config.compaction?.enabled !== true ||
      config.dreamer?.disable !== true ||
      config.sidekick?.disable !== true ||
      config.memory?.enabled !== false ||
      config.embedding?.provider !== 'off' ||
      config.todowrite?.enabled !== false
    ) {
      throw new Error('host config does not match the compression-only policy');
    }
  } catch (error) {
    return {
      ok: false,
      warning: `Magic Context host config is invalid (${errorMessage(error)}); session paused for recovery.`,
    };
  }
  return { ok: true, pluginDir };
}

async function loadPlugin(pluginDir: string): Promise<MagicContextModule> {
  if (!pluginModule) {
    pluginModule = (async () => {
      // Electron 45 runs Node 24, so node:sqlite exists. Reject incompatible
      // runtimes before allowing any Magic-managed request.
      await import('node:sqlite');
      const entry = pathToFileURL(join(pluginDir, 'dist', 'index.js')).href;
      const module = (await import(entry)) as MagicContextModule;
      if (
        typeof module.default !== 'function' ||
        typeof module.fynvraIsSessionReady !== 'function' ||
        typeof module.fynvraBindSession !== 'function' ||
        typeof module.fynvraSuspendSession !== 'function' ||
        typeof module.fynvraInterruptSession !== 'function' ||
        typeof module.fynvraRunSessionOperation !== 'function' ||
        typeof module.fynvraCloseSession !== 'function'
      ) {
        throw new Error('vendored Magic Context host contract is incomplete');
      }
      loadedPluginModule = module;
      return module;
    })().catch((error) => {
      pluginModuleError = error;
      pluginModule = null;
      throw error;
    });
  }
  try {
    return await pluginModule;
  } catch (error) {
    throw pluginModuleError ?? error;
  }
}

function installRunner(): void {
  const globals = globalThis as typeof globalThis & {
    [RUNNER_SYMBOL]?: (options: MagicSubagentOptions) => Promise<MagicSubagentResult>;
    [SUSPEND_SYMBOL]?: (sessionId: string, reason?: string) => void;
    [BUDGET_SYMBOL]?: typeof getHistorianBudget;
    [PUBLISHED_SYMBOL]?: (sessionId: string) => void;
  };
  globals[RUNNER_SYMBOL] = runMagicSubagent;
  globals[SUSPEND_SYMBOL] = handleVendorSuspend;
  globals[BUDGET_SYMBOL] = getHistorianBudget;
  globals[PUBLISHED_SYMBOL] = (sessionId) => {
    const runner = sessionRunners.get(sessionId);
    if (runner && !runner.disposed && !runner.suspended) runner.failureStreak = 0;
  };
}

installRunner();

function handleVendorSuspend(sessionId: string, reason?: string): void {
  const runner = sessionRunners.get(sessionId);
  if (!runner || runner.disposed) return;
  runner.suspended = true;
  runner.abort.abort();
  if (runner.fallbackNotified) return;
  runner.fallbackNotified = true;
  runner.onFallback?.(normalizeFallbackReason(reason));
}

function normalizeFallbackReason(reason: unknown): MagicContextFallbackReason {
  return reason === 'startup' || reason === 'budget' || reason === 'context' ? reason : 'runtime';
}

/** Invalidate this session's Magic ownership; other sessions keep their entries. */
function suspendSession(sessionId: string, reason: MagicContextFallbackReason): void {
  const runner = sessionRunners.get(sessionId);
  if (!runner || runner.disposed) return;
  try {
    loadedPluginModule?.fynvraSuspendSession(sessionId, reason);
  } catch {}
  // Also covers failures before the vendor module is available.
  handleVendorSuspend(sessionId, reason);
}

function noteHistorianFailure(
  runner: SessionRunner,
  sessionId: string,
  result: MagicSubagentResult
): void {
  if (result.reason === 'abort' || result.reason === 'spawn_failed') return;
  if (result.reason === 'budget') {
    suspendSession(sessionId, 'budget');
    return;
  }
  if (result.reason === 'invalid_prompt' || result.transient === false) {
    suspendSession(sessionId, 'runtime');
    return;
  }
  runner.failureStreak += 1;
  if (runner.failureStreak >= TRANSIENT_FAILURE_LIMIT) suspendSession(sessionId, 'runtime');
}

function isTransientModelError(message: string): boolean {
  return /(?:429|rate limit|timeout|timed out|overloaded|\b50[0234]\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed)/i.test(
    message
  );
}

/** UTF-8 bytes conservatively bound text tokens for the supported byte/subword
 * tokenizers. Provider framing is separately reserved; this is not a universal
 * guarantee for arbitrary provider-side templates or inaccurate model metadata.
 */
function estimatePromptTokens(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function getHistorianBudget(
  sessionId: string,
  systemPrompt: string,
  requestedMax = 32_000
): { inputBytes: number; maxTokens: number } | undefined {
  const runner = sessionRunners.get(sessionId);
  if (!runner || runner.disposed || runner.suspended || typeof systemPrompt !== 'string') return;
  return modelHistorianBudget(runner.getModel(), systemPrompt, requestedMax);
}

function modelHistorianBudget(
  resolved: ResolvedModel,
  systemPrompt: string,
  requestedMax: number
): { inputBytes: number; maxTokens: number } | undefined {
  const { contextWindow, maxTokens: modelMax } = resolved.model;
  if (
    !Number.isFinite(contextWindow) ||
    !Number.isFinite(modelMax) ||
    contextWindow <= 0 ||
    modelMax < MIN_HISTORIAN_OUTPUT_TOKENS ||
    !Number.isFinite(requestedMax) ||
    requestedMax < MIN_HISTORIAN_OUTPUT_TOKENS
  )
    return;
  const maxTokens = Math.floor(Math.min(requestedMax, modelMax, 32_000, contextWindow * 0.2));
  const framing = Math.max(CONTEXT_SAFETY_TOKENS, Math.ceil(contextWindow * 0.05));
  const inputBytes = Math.floor(
    contextWindow - estimatePromptTokens(systemPrompt) - framing - maxTokens
  );
  if (maxTokens < MIN_HISTORIAN_OUTPUT_TOKENS || inputBytes < 1_024) return;
  return { inputBytes, maxTokens };
}

function historianTokenBudget(
  resolved: ResolvedModel,
  systemPrompt: string,
  userMessage: string,
  requestedMax: number
): { ok: true; maxTokens: number } | { ok: false } {
  const budget = modelHistorianBudget(resolved, systemPrompt, requestedMax);
  return budget && estimatePromptTokens(userMessage) <= budget.inputBytes
    ? { ok: true, maxTokens: budget.maxTokens }
    : { ok: false };
}

async function runMagicSubagent(options: MagicSubagentOptions): Promise<MagicSubagentResult> {
  const startedAt = Date.now();
  const sessionId = options.accountingSessionId;
  const runner = sessionId ? sessionRunners.get(sessionId) : undefined;
  if (!sessionId || !runner || runner.disposed) {
    return fail(
      startedAt,
      'spawn_failed',
      'Fynvra has no active session for this Magic Context subagent; refusing to launch an external Pi process.'
    );
  }
  if (!HISTORIAN_AGENTS.has(options.agent)) {
    return fail(
      startedAt,
      'spawn_failed',
      `Fynvra does not run Magic Context "${options.agent}" subagents out of process.`
    );
  }
  if (runner.suspended) {
    return fail(
      startedAt,
      'spawn_failed',
      'Magic Context is suspended; explicit context recovery is required.'
    );
  }
  if (runner.inFlight) {
    return fail(
      startedAt,
      'spawn_failed',
      'a Magic Context historian run is already active for this session.'
    );
  }
  const finish = (result: MagicSubagentResult): MagicSubagentResult => {
    // A transport success is only a draft. The vendor resets this counter
    // after validation AND the publication transaction have succeeded.
    if (!result.ok) noteHistorianFailure(runner, sessionId, result);
    return result;
  };
  if (
    typeof options.systemPrompt !== 'string' ||
    typeof options.userMessage !== 'string' ||
    options.userMessage.length === 0
  ) {
    return finish(fail(startedAt, 'invalid_prompt', 'historian prompt is empty.'));
  }
  if (options.userMessage.length > MAX_HISTORIAN_PROMPT_CHARS) {
    return finish(
      fail(
        startedAt,
        'budget',
        `historian prompt is too large (${options.userMessage.length} characters).`
      )
    );
  }

  runner.inFlight = true;
  const requestedTimeout =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : 180_000;
  const timeoutMs = Math.max(30_000, Math.min(requestedTimeout, MAX_HISTORIAN_TIMEOUT_MS));
  const timeout = AbortSignal.timeout(timeoutMs);
  const operationAbort = runner.abort;
  const signals = [operationAbort.signal, timeout];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);
  const cancellation = (): MagicSubagentResult | undefined => {
    if (
      operationAbort.signal.aborted ||
      options.signal?.aborted ||
      runner.disposed ||
      runner.suspended
    ) {
      return fail(startedAt, 'abort', 'historian request was cancelled by its session.');
    }
    if (timeout.aborted) {
      return { ...fail(startedAt, 'timeout', 'historian deadline expired.'), transient: true };
    }
    return undefined;
  };

  try {
    const resolved = runner.getModel();
    const requestedMax =
      typeof options.maxOutputTokens === 'number' && Number.isFinite(options.maxOutputTokens)
        ? options.maxOutputTokens
        : 32_000;
    const budget = historianTokenBudget(
      resolved,
      options.systemPrompt,
      options.userMessage,
      requestedMax
    );
    if (!budget.ok) {
      return finish(
        fail(
          startedAt,
          'budget',
          'historian prompt and output do not fit the current model context window.'
        )
      );
    }
    const message: Message = {
      role: 'user',
      content: options.userMessage,
      timestamp: Date.now(),
    };
    const answer = await withAbort(
      resolved.runtime.completeSimple(
        resolved.model,
        {
          systemPrompt: options.systemPrompt,
          messages: [message],
        },
        {
          maxTokens: budget.maxTokens,
          maxRetries: 0,
          signal,
          ...(typeof options.temperature === 'number' && Number.isFinite(options.temperature)
            ? { temperature: options.temperature }
            : {}),
        }
      ),
      signal
    );
    const cancelled = cancellation();
    if (cancelled) return finish(cancelled);
    if (answer.stopReason === 'length') {
      return finish(
        fail(startedAt, 'model_failed', 'historian output hit the model output limit.')
      );
    }
    if (answer.stopReason === 'error') {
      const error = answer.errorMessage ?? 'historian model request failed.';
      return finish({
        ...fail(startedAt, 'model_failed', error),
        transient: isTransientModelError(error),
      });
    }
    if (answer.stopReason === 'aborted') {
      // An SDK abort without any caller cancellation is a failed request.
      return finish({
        ...fail(startedAt, 'model_failed', 'historian request unexpectedly aborted.'),
        transient: true,
      });
    }
    if (answer.stopReason !== 'stop') {
      return finish({
        ...fail(startedAt, 'model_failed', 'historian did not finish a text response.'),
        transient: false,
      });
    }
    const assistantText = answer.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    if (!assistantText) {
      return finish(fail(startedAt, 'model_failed', 'historian returned no assistant text.'));
    }
    options.onProgress?.({
      type: 'terminal',
      ms: Date.now() - startedAt,
      stopReason: answer.stopReason,
      textLength: assistantText.length,
      hasToolCall: false,
    });
    return finish({
      ok: true,
      assistantText,
      durationMs: Date.now() - startedAt,
      toolCallCount: 0,
    });
  } catch (error) {
    const cancelled = cancellation();
    if (cancelled) return finish(cancelled);
    const message = errorMessage(error).slice(0, 1_000);
    return finish({
      ...fail(startedAt, 'model_failed', message),
      transient: isTransientModelError(message),
    });
  } finally {
    runner.inFlight = false;
  }
}

/** Enforce the deadline even if a provider neglects to settle after abort. */
function withAbort<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function fail(startedAt: number, reason: string, error: string): MagicSubagentResult {
  return { ok: false, reason, error, durationMs: Date.now() - startedAt };
}
