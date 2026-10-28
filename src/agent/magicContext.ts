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

/** Magic Context's internal agent names that may ask for a historian subagent. */
const HISTORIAN_AGENTS = new Set([
  'magic-context-historian',
  'historian',
  'historian-recomp',
  'historian-editor',
]);

/** Safety cap; the plugin already truncates a chunk to its historian token budget. */
const MAX_HISTORIAN_PROMPT_CHARS = 2_000_000;
/** Hard local cap in addition to the plugin's configured historian timeout. */
const MAX_HISTORIAN_TIMEOUT_MS = 5 * 60_000;
/** Consecutive transient failures before handing this session back to native compaction. */
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

interface MagicContextModule {
  default(pi: ExtensionAPI): void | Promise<void>;
  /** Added by vendor patch: invalidate this session's Magic takeover. */
  fynvraSuspendSession?(sessionId: string, reason?: string): void;
}

interface SessionRunner {
  getModel(): ResolvedModel;
  readonly abort: AbortController;
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
  /** Abort an in-flight historian and drop the routing entry. */
  dispose(): void;
}

export interface MagicContextCompactionOptions {
  /** Called once when this session must hand context back to native compaction. */
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
    if (!runner || runner.fallbackNotified) return;
    runner.fallbackNotified = true;
    runner.onFallback?.(reason);
  };

  const extension: InlineExtension = {
    name: 'fynvra-magic-context',
    hidden: true,
    factory: async (pi) => {
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
          `Magic Context plugin could not be loaded (${errorMessage(error)}); pi native compaction stays active.`
        );
        notifyFallback('startup');
        return;
      }

      let bootStatus: string | undefined;
      // A host-owned wrapper, not a mutation of Pi's ExtensionAPI object. The
      // vendored plugin reads boot status / boot readiness through these
      // symbols; a non-extensible API or a missing report leaves native
      // compaction in charge and still produces a visible warning.
      const pluginApi = new Proxy(pi, {
        get(target, property) {
          if (property === BOOT_SYMBOL) {
            return (status: unknown) => {
              if (typeof status === 'string') bootStatus = status;
            };
          }
          if (property === BOOT_OK_SYMBOL) return bootStatus === 'ready';
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      try {
        await module.default(pluginApi);
      } catch (error) {
        warnings.push(
          `Magic Context failed to start (${errorMessage(error)}); pi native compaction stays active.`
        );
        notifyFallback('startup');
        return;
      }
      if (bootStatus === undefined) {
        warnings.push('Magic Context did not report startup; pi native compaction stays active.');
        notifyFallback('startup');
      } else if (bootStatus !== 'ready') {
        warnings.push(
          `Magic Context storage did not initialize (${bootStatus}); pi native compaction stays active.`
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
    dispose() {
      if (runner) {
        runner.disposed = true;
        runner.abort.abort();
        if (piSessionId && sessionRunners.get(piSessionId) === runner) {
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
      warning: 'Magic Context host marker is missing; pi native compaction stays active.',
    };
  }
  const pluginDir = process.env.MAGIC_CONTEXT_PLUGIN_DIR?.trim() ?? '';
  const storageDir = process.env.MAGIC_CONTEXT_STORAGE_DIR?.trim() ?? '';
  const configFile = process.env.MAGIC_CONTEXT_CONFIG_FILE?.trim() ?? '';
  if (!pluginDir || !existsSync(join(pluginDir, 'dist', 'index.js'))) {
    return {
      ok: false,
      warning: `Magic Context plugin files are missing at ${pluginDir || '(unset)'}; pi native compaction stays active.`,
    };
  }
  if (!storageDir || !isAbsolute(storageDir)) {
    return {
      ok: false,
      warning:
        'Magic Context storage directory is missing or not absolute; pi native compaction stays active.',
    };
  }
  if (!configFile || !existsSync(configFile)) {
    return {
      ok: false,
      warning: 'Magic Context host config is missing; pi native compaction stays active.',
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
      config.fail_closed_blocking !== false ||
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
      warning: `Magic Context host config is invalid (${errorMessage(error)}); pi native compaction stays active.`,
    };
  }
  return { ok: true, pluginDir };
}

async function loadPlugin(pluginDir: string): Promise<MagicContextModule> {
  if (!pluginModule) {
    pluginModule = (async () => {
      // Electron 45 runs Node 24, so node:sqlite exists. Check explicitly to
      // keep native compaction on an older/incompatible runtime.
      await import('node:sqlite');
      const entry = pathToFileURL(join(pluginDir, 'dist', 'index.js')).href;
      const module = (await import(entry)) as MagicContextModule;
      loadedPluginModule = module;
      return module;
    })().catch((error) => {
      pluginModuleError = error;
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
  };
  if (!globals[RUNNER_SYMBOL]) globals[RUNNER_SYMBOL] = runMagicSubagent;
  globals[SUSPEND_SYMBOL] = handleVendorSuspend;
}

installRunner();

function handleVendorSuspend(sessionId: string, reason?: string): void {
  const runner = sessionRunners.get(sessionId);
  if (!runner) return;
  runner.suspended = true;
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
  if (runner) runner.suspended = true;
  try {
    loadedPluginModule?.fynvraSuspendSession?.(sessionId, reason);
  } catch {}
  // The vendored module normally calls the global listener above; this local
  // fallback keeps the warning/fallback correct if an older vendor lacks it.
  if (runner && !runner.fallbackNotified) {
    runner.fallbackNotified = true;
    runner.onFallback?.(reason);
  }
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

/** Conservative token estimate: CJK ~1 token/char, other text ~3 chars/token. */
function estimatePromptTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return cjk + Math.ceil(other / 3);
}

function historianTokenBudget(
  resolved: ResolvedModel,
  systemPrompt: string,
  userMessage: string,
  requestedMax: number
): { ok: true; maxTokens: number } | { ok: false } {
  const contextWindow =
    typeof resolved.model.contextWindow === 'number' &&
    Number.isFinite(resolved.model.contextWindow) &&
    resolved.model.contextWindow > 0
      ? resolved.model.contextWindow
      : 128_000;
  const modelMax =
    typeof resolved.model.maxTokens === 'number' &&
    Number.isFinite(resolved.model.maxTokens) &&
    resolved.model.maxTokens > 0
      ? resolved.model.maxTokens
      : 32_000;
  const promptTokens = estimatePromptTokens(systemPrompt) + estimatePromptTokens(userMessage);
  const available = contextWindow - promptTokens - CONTEXT_SAFETY_TOKENS;
  if (available < MIN_HISTORIAN_OUTPUT_TOKENS) return { ok: false };
  return {
    ok: true,
    maxTokens: Math.max(MIN_HISTORIAN_OUTPUT_TOKENS, Math.min(requestedMax, modelMax, available)),
  };
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
      'Magic Context handed this session back to native compaction.'
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
    if (result.ok) runner.failureStreak = 0;
    else noteHistorianFailure(runner, sessionId, result);
    return result;
  };
  if (typeof options.userMessage !== 'string' || options.userMessage.length === 0) {
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
      : MAX_HISTORIAN_TIMEOUT_MS;
  const timeoutMs = Math.max(30_000, Math.min(requestedTimeout, MAX_HISTORIAN_TIMEOUT_MS));
  const timeout = AbortSignal.timeout(timeoutMs);
  const signals = [runner.abort.signal, timeout];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);

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
    const answer = await resolved.runtime.completeSimple(
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
    );
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
      return finish(fail(startedAt, 'abort', 'historian request was aborted.'));
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
    if (runner.abort.signal.aborted || options.signal?.aborted) {
      return finish(fail(startedAt, 'abort', 'historian request was aborted.'));
    }
    if (timeout.aborted) {
      return finish({
        ...fail(
          startedAt,
          'timeout',
          `historian request timed out after ${Math.round(timeoutMs / 1000)}s.`
        ),
        transient: true,
      });
    }
    const message = errorMessage(error).slice(0, 1_000);
    return finish({
      ...fail(startedAt, 'model_failed', message),
      transient: isTransientModelError(message),
    });
  } finally {
    runner.inFlight = false;
  }
}

function fail(startedAt: number, reason: string, error: string): MagicSubagentResult {
  return { ok: false, reason, error, durationMs: Date.now() - startedAt };
}
