import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
export function prepareMagicContextHost(): Record<string, string> {
  const root = join(app.getPath('userData'), 'magic-context');
  const configHome = join(root, 'config');
  const configRoot = join(root, 'config-root');
  const configDir = join(configHome, 'cortexkit');
  const configFile = join(configDir, 'magic-context.jsonc');
  const storageDir = join(root, 'storage');
  const artifactDir = join(root, 'artifacts');
  const logPath = join(root, 'magic-context.log');
  const pluginDir = resolvePluginDir();

  try {
    for (const dir of [root, configHome, configDir, configRoot, storageDir, artifactDir]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(configFile, `${JSON.stringify(HOST_CONFIG, null, 2)}\n`, 'utf8');
  } catch (error) {
    // The worker checks for the config file and falls back to native compaction
    // with a session warning; do not take the whole app down for this.
    console.warn(`[magic-context] could not prepare host files: ${String(error)}`);
  }

  return {
    MAGIC_CONTEXT_FYNVRA_HOST: '1',
    // Neutralize values inherited from a user terminal environment.
    MAGIC_CONTEXT_PI_SUBAGENT: '',
    MAGIC_CONTEXT_TEST_DATA_DIR: '',
    MAGIC_CONTEXT_PLUGIN_DIR: pluginDir,
    MAGIC_CONTEXT_CONFIG_FILE: configFile,
    MAGIC_CONTEXT_CONFIG_HOME: configHome,
    MAGIC_CONTEXT_CONFIG_ROOT: configRoot,
    MAGIC_CONTEXT_STORAGE_DIR: storageDir,
    MAGIC_CONTEXT_ARTIFACT_DIR: artifactDir,
    MAGIC_CONTEXT_LOG_PATH: logPath,
  };
}

/** Packaged: extraResources/magic-context. Dev: the vendored source tree. */
function resolvePluginDir(): string {
  const candidates = [
    join(process.resourcesPath, 'magic-context'),
    join(app.getAppPath(), 'packages', 'agent-runtime', 'vendor', 'magic-context'),
    join(process.cwd(), 'packages', 'agent-runtime', 'vendor', 'magic-context'),
  ];
  return (
    candidates.find((candidate) => existsSync(join(candidate, 'dist', 'index.js'))) ??
    candidates[1] ??
    ''
  );
}

const HOST_CONFIG = {
  enabled: true,
  // Storage failure must leave pi native compaction in charge.
  fail_closed_blocking: false,
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
