import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/**
 * Prepare the app-owned Magic Context host environment before forking the
 * agent worker.
 *
 * Everything lives under `userData/magic-context`: the plugin's SQLite store,
 * its generated config, historian dumps and its log. The user's terminal
 * `~/.pi`, `~/.config/cortexkit` and any workspace `.cortexkit` config/db are
 * neither read nor migrated. Paths are fixed for the worker lifetime, so the
 * multi-session worker never chdirs or swaps env per session.
 *
 * The generated config deliberately enables only context compaction:
 * dreamer/sidekick/cross-session memory/embeddings are off. The historian
 * model string is a placeholder used only for Magic's chunk budget; the
 * selected model is always the current session model (see src/agent/magicContext.ts).
 */
export function prepareMagicContextHost(
  compactionThresholdTokens?: number
): Record<string, string> {
  const root = magicContextRoot();
  const configHome = join(root, 'config');
  const configRoot = join(root, 'config-root');
  const configDir = join(configHome, 'cortexkit');
  const configFile = magicContextConfigFile();
  const storageDir = join(root, 'storage');
  const artifactDir = join(root, 'artifacts');
  const logPath = join(root, 'magic-context.log');
  const pluginDir = resolvePluginDir();

  try {
    for (const dir of [root, configHome, configDir, configRoot, storageDir, artifactDir]) {
      mkdirSync(dir, { recursive: true });
    }
    writeConfigAtomically(configFile, compactionThresholdTokens);
  } catch (error) {
    // The worker blocks Magic requests and reports a recoverable session warning;
    // failure here must not take the whole app down.
    console.warn(`[magic-context] could not prepare host files: ${String(error)}`);
  }

  return {
    MAGIC_CONTEXT_FYNVRA_HOST: '1',
    // Neutralize values inherited from a user terminal environment.
    MAGIC_CONTEXT_PI_SUBAGENT: '0',
    MAGIC_CONTEXT_TEST_DATA_DIR: ' ',
    MAGIC_CONTEXT_PI_SERVED_BODY_CAPTURE: '0',
    MAGIC_CONTEXT_PLUGIN_DIR: pluginDir,
    MAGIC_CONTEXT_CONFIG_FILE: configFile,
    MAGIC_CONTEXT_CONFIG_HOME: configHome,
    MAGIC_CONTEXT_CONFIG_ROOT: configRoot,
    MAGIC_CONTEXT_STORAGE_DIR: storageDir,
    MAGIC_CONTEXT_ARTIFACT_DIR: artifactDir,
    MAGIC_CONTEXT_LOG_PATH: logPath,
  };
}

/**
 * The plugin rereads the config file each time a session loads, so rewriting it
 * before a spawn makes a changed threshold apply to new (and reloaded) sessions
 * without restarting the worker. Running sessions keep what they loaded.
 */
export function writeMagicContextConfig(compactionThresholdTokens?: number): void {
  try {
    writeConfigAtomically(magicContextConfigFile(), compactionThresholdTokens);
  } catch (error) {
    // Keep the previous file: the session still loads, just with the old threshold.
    console.warn(`[magic-context] could not update host config: ${String(error)}`);
  }
}

/** The generated config; without a threshold it is exactly the fixed host policy. */
export function magicContextHostConfig(compactionThresholdTokens?: number) {
  return compactionThresholdTokens === undefined
    ? HOST_CONFIG
    : { ...HOST_CONFIG, execute_threshold_tokens: { default: compactionThresholdTokens } };
}

function magicContextRoot(): string {
  return join(app.getPath('userData'), 'magic-context');
}

function magicContextConfigFile(): string {
  return join(magicContextRoot(), 'config', 'cortexkit', 'magic-context.jsonc');
}

/** Temp file + rename so a worker loading a session never reads a half-written config. */
function writeConfigAtomically(configFile: string, compactionThresholdTokens?: number): void {
  const temp = `${configFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const content = `${JSON.stringify(magicContextHostConfig(compactionThresholdTokens), null, 2)}\n`;
  try {
    writeFileSync(temp, content, 'utf8');
    renameSync(temp, configFile);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Packaged: extraResources/magic-context. Dev: the fixed app-owned vendor tree. */
function resolvePluginDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'magic-context')
    : join(app.getAppPath(), 'packages', 'agent-runtime', 'vendor', 'magic-context');
}

const HOST_CONFIG = {
  enabled: true,
  // No npm self-update/network checks in the desktop app.
  auto_update: false,
  // Storage failures block requests; the worker owns cancellation and durable recovery.
  fail_closed_blocking: true,
  compaction: { enabled: true },
  // Placeholder only: the Fynvra runner always uses the session's current model.
  historian: { pi: { model: 'fynvra/historian' } },
  historian_timeout_ms: 180_000,
  dreamer: { disable: true, inject_docs: false },
  sidekick: { disable: true },
  memory: {
    enabled: false,
    auto_search: { enabled: false },
  },
  embedding: { provider: 'off' },
  todowrite: { enabled: false },
  prompt_surface: { default: 'light' },
  keep_subagents: false,
} as const;
