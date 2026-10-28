import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Message } from '@earendil-works/pi-ai';
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import type { ResolvedModel } from '@fynvra/agent-runtime';
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
}

interface SessionRunner {
  getModel(): ResolvedModel;
  readonly abort: AbortController;
  inFlight: boolean;
  disposed: boolean;
}

const sessionRunners = new Map<string, SessionRunner>();

let pluginModule: Promise<MagicContextModule> | null = null;
let pluginModuleError: unknown;

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

/**
 * Prepare a Magic Context extension for one session. The plugin is imported
 * lazily once per worker; each session still gets its own extension binding and
 * its own historian routing entry.
 */
export function createMagicContextCompaction(
  getModel: () => ResolvedModel
): MagicContextCompaction {
  const warnings: string[] = [];
  let piSessionId: string | undefined;
  let runner: SessionRunner | undefined;

  const extension: InlineExtension = {
    name: 'fynvra-magic-context',
    hidden: true,
    factory: async (pi) => {
      const host = prepareHost();
      if (!host.ok) {
        warnings.push(host.warning);
        return;
      }
      let module: MagicContextModule;
      try {
        module = await loadPlugin(host.pluginDir);
      } catch (error) {
        warnings.push(
          `Magic Context plugin could not be loaded (${errorMessage(error)}); pi native compaction stays active.`
        );
        return;
      }

      let bootStatus: string | undefined;
      // The vendored plugin reports its storage boot result through this symbol.
      (pi as unknown as Record<symbol, unknown>)[BOOT_SYMBOL] = (status: unknown) => {
        if (typeof status === 'string') bootStatus = status;
      };
      try {
        await module.default(pi);
      } catch (error) {
        warnings.push(
          `Magic Context failed to start (${errorMessage(error)}); pi native compaction stays active.`
        );
        return;
      } finally {
        delete (pi as unknown as Record<symbol, unknown>)[BOOT_SYMBOL];
      }
      if (bootStatus !== undefined && bootStatus !== 'ready') {
        warnings.push(
          `Magic Context storage did not initialize (${bootStatus}); pi native compaction stays active.`
        );
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
function prepareHost():
  | { ok: true; pluginDir: string }
  | { ok: false; warning: string } {
  if (process.env.MAGIC_CONTEXT_FYNVRA_HOST !== '1') {
    return { ok: false, warning: 'Magic Context host marker is missing; pi native compaction stays active.' };
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
      warning: 'Magic Context storage directory is missing or not absolute; pi native compaction stays active.',
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
      embedding?: { provider?: unknown };
    };
    if (config.fail_closed_blocking !== false || config.embedding?.provider !== 'off') {
      throw new Error('host config does not disable fail-closed blocking/embeddings');
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
      return (await import(entry)) as MagicContextModule;
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
  };
  if (globals[RUNNER_SYMBOL]) return;
  globals[RUNNER_SYMBOL] = runMagicSubagent;
}

installRunner();

async function runMagicSubagent(
  options: MagicSubagentOptions
): Promise<MagicSubagentResult> {
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
  if (runner.inFlight) {
    return fail(startedAt, 'spawn_failed', 'a Magic Context historian run is already active for this session.');
  }
  if (typeof options.userMessage !== 'string' || options.userMessage.length === 0) {
    return fail(startedAt, 'invalid_prompt', 'historian prompt is empty.');
  }
  if (options.userMessage.length > MAX_HISTORIAN_PROMPT_CHARS) {
    return fail(
      startedAt,
      'invalid_prompt',
      `historian prompt is too large (${options.userMessage.length} characters).`
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
    const maxTokens = Math.max(
      1,
      Math.min(options.maxOutputTokens ?? 32_000, resolved.model.maxTokens ?? 32_000)
    );
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
        maxTokens,
        maxRetries: 0,
        signal,
        ...(typeof options.temperature === 'number' && Number.isFinite(options.temperature)
          ? { temperature: options.temperature }
          : {}),
      }
    );
    if (answer.stopReason === 'length') {
      return fail(startedAt, 'model_failed', 'historian output hit the model output limit.');
    }
    if (answer.stopReason === 'error') {
      return fail(
        startedAt,
        'model_failed',
        answer.errorMessage ?? 'historian model request failed.'
      );
    }
    if (answer.stopReason === 'aborted') {
      return fail(startedAt, 'abort', 'historian request was aborted.');
    }
    const assistantText = answer.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    if (!assistantText) {
      return fail(startedAt, 'model_failed', 'historian returned no assistant text.');
    }
    options.onProgress?.({
      type: 'terminal',
      ms: Date.now() - startedAt,
      stopReason: answer.stopReason,
      textLength: assistantText.length,
      hasToolCall: false,
    });
    return {
      ok: true,
      assistantText,
      durationMs: Date.now() - startedAt,
      toolCallCount: 0,
    };
  } catch (error) {
    if (runner.abort.signal.aborted || options.signal?.aborted) {
      return fail(startedAt, 'abort', 'historian request was aborted.');
    }
    if (timeout.aborted) {
      return {
        ...fail(
          startedAt,
          'timeout',
          `historian request timed out after ${Math.round(timeoutMs / 1000)}s.`
        ),
        transient: true,
      };
    }
    return {
      ...fail(startedAt, 'model_failed', errorMessage(error).slice(0, 1_000)),
      transient: true,
    };
  } finally {
    runner.inFlight = false;
  }
}

function fail(
  startedAt: number,
  reason: string,
  error: string
): MagicSubagentResult {
  return { ok: false, reason, error, durationMs: Date.now() - startedAt };
}
