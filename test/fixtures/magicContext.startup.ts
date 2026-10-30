import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { type Context, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import type { FynvraSessionEvent } from '@fynvra/core';
import { expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { createPiSessionFactory } from '../../src/agent/piSession';
import { prepareMagicContextHost } from '../../src/main/services/agentHost/magicContextHost';
import { projectHistory } from '../../src/main/services/sessions/history';

// Only Electron's app/path boundary and the offline provider are substituted.
// The host, adapter, SDK, vendor config parser, hooks and SQLite are real.
vi.mock('electron', () => ({
  app: {
    isPackaged: process.env.FYNVRA_MAGIC_TEST_LAYOUT === 'packaged',
    getAppPath: () => testEnv('FYNVRA_MAGIC_TEST_ROOT'),
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected app path: ${name}`);
      return join(testEnv('FYNVRA_MAGIC_TEST_SANDBOX'), 'userData');
    },
  },
}));

function testEnv(name: string): string {
  const value = process.env[name];
  assert(value, `missing fixture environment: ${name}`);
  return value;
}

it('boots the generated host config and handles the first prompt through Magic', async () => {
  const root = testEnv('FYNVRA_MAGIC_TEST_ROOT');
  const sandbox = testEnv('FYNVRA_MAGIC_TEST_SANDBOX');
  const packaged = testEnv('FYNVRA_MAGIC_TEST_LAYOUT') === 'packaged';
  const scenario = testEnv('FYNVRA_MAGIC_TEST_SCENARIO');
  const resources = join(sandbox, 'resources');
  const previousResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resources });
  const originalEnv = { ...process.env };
  let session: Awaited<ReturnType<ReturnType<typeof createPiSessionFactory>>> | undefined;
  try {
    if (packaged) {
      const builder = parse(await readFile(join(root, 'electron-builder.yml'), 'utf8')) as {
        extraResources: { from: string; to: string }[];
      };
      const resource = builder.extraResources.find((entry) => entry.to === 'magic-context');
      assert(resource, 'Magic Context must be included in extraResources');
      await cp(join(root, resource.from), join(resources, resource.to), { recursive: true });
    }
    const env = prepareMagicContextHost();
    expect(env.MAGIC_CONTEXT_PLUGIN_DIR).toBe(
      packaged
        ? join(resources, 'magic-context')
        : join(root, 'packages', 'agent-runtime', 'vendor', 'magic-context')
    );
    const {
      MAGIC_CONTEXT_CONFIG_FILE: configFile,
      MAGIC_CONTEXT_PLUGIN_DIR: pluginDir,
      MAGIC_CONTEXT_STORAGE_DIR: storageDir,
      MAGIC_CONTEXT_LOG_PATH: logPath,
    } = env;
    assert(configFile && pluginDir && storageDir && logPath);
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    expect(config.fail_closed_blocking).toBe(true);
    if (scenario === 'fail-open') config.fail_closed_blocking = false;
    if (scenario === 'invalid-schema') config.historian_timeout_ms = 'invalid';
    if (scenario !== 'valid') await writeFile(configFile, JSON.stringify(config));
    Object.assign(process.env, env);

    const faux = fauxProvider({
      provider: 'magic-startup-test',
      models: [{ id: 'offline', contextWindow: 200_000, maxTokens: 16_000 }],
    });
    const runtime = await ModelRuntime.create({
      authPath: join(sandbox, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    const cwd = join(sandbox, 'workspace');
    await mkdir(cwd, { recursive: true });
    const sessionFile = join(sandbox, 'agent', 'sessions', 'first.jsonl');
    const open = createPiSessionFactory({
      agentDir: join(sandbox, 'agent'),
      resolveModel: async () => ({ runtime, model: faux.getModel() }),
    });
    session = await open({
      identity: { sessionId: 'first', generation: 1 },
      spec: {
        role: {
          id: 'worker',
          name: 'Worker',
          tools: 'readonly',
          approvalMode: 'full',
          skillIds: [],
          mcpServerIds: [],
        },
        cwd,
        sessionFile,
        model: { providerId: 'magic-startup-test', api: faux.api, modelId: 'offline' },
        skills: [],
        mcpServers: [],
        roles: [],
        worker: false,
        // Deliberately exercise the production default (Magic), not an override.
      },
      host: null,
      workerHost: null,
    });
    const events: FynvraSessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    const snapshots = () =>
      events.flatMap((e) => (e.type === 'context_runtime' ? [e.snapshot] : []));
    const requests: Context[] = [];
    faux.setResponses([
      (context) => {
        requests.push(context);
        return fauxAssistantMessage('Hello from the offline provider.');
      },
    ]);

    if (scenario !== 'valid') {
      expect(session.warnings.join('\n')).toContain(
        scenario === 'fail-open' ? 'host config is invalid' : 'config schema is incompatible'
      );
      await session.prompt('hi');
      expect(faux.state.callCount).toBe(0);
      expect(requests).toEqual([]);
      expect(snapshots().at(-1)).toMatchObject({
        configuredStrategy: 'magic-context',
        effectiveStrategy: 'magic-context',
        recoveryRequired: true,
      });
      // Exercise the vendor parser independently too: false must not become a
      // permissive vendor setting just because the adapter already rejects it.
      const core = await import(pathToFileURL(join(pluginDir, 'dist', 'index-s0zw9ddk.js')).href);
      expect(() => core.loadPiConfig()).toThrow(
        scenario === 'fail-open' ? 'compression-only policy' : 'schema is incompatible'
      );
      return;
    }

    expect(session.warnings, await readFile(logPath, 'utf8')).toEqual([]);
    await session.prompt('hi');
    expect(faux.state.callCount).toBe(1);
    expect(requests).toHaveLength(1);
    const sentUsers = requests[0]?.messages.filter((message) => message.role === 'user') ?? [];
    const userTexts = sentUsers.map(({ content }) =>
      typeof content === 'string'
        ? content
        : content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
    );
    // Magic also injects control messages; the actual input must be tagged only
    // once on the wire and remain untagged exactly once in pi's transcript.
    const taggedInputs = userTexts.filter((text) => /^§\d+§ hi$/.test(text));
    expect(taggedInputs, JSON.stringify(userTexts)).toHaveLength(1);
    const sentText = taggedInputs[0];
    expect(events.filter((e) => e.type === 'warning' || e.type === 'error')).toEqual([]);
    expect(snapshots().length).toBeGreaterThan(0);
    for (const snapshot of snapshots()) {
      expect(snapshot).toMatchObject({
        configuredStrategy: 'magic-context',
        effectiveStrategy: 'magic-context',
        recoveryRequired: false,
      });
      expect(snapshot.compaction).toBeUndefined();
      expect(snapshot.context.compactionThresholdTokens).toBeUndefined();
    }
    expect(events.filter((e) => e.type === 'agent_settled')).toHaveLength(1);
    const jsonl = await readFile(sessionFile, 'utf8');
    const history = projectHistory(jsonl, 'first');
    expect(history.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['hi']);
    expect(history.filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual([
      'Hello from the offline provider.',
    ]);
    const manager = SessionManager.open(sessionFile, join(sandbox, 'agent', 'sessions'), cwd);
    expect(manager.getEntries().filter((e) => e.type === 'compaction')).toEqual([]);
    const vendor = await import(pathToFileURL(join(pluginDir, 'dist', 'index.js')).href);
    expect(vendor.fynvraIsSessionReady(manager.getSessionId())).toBe(true);
    const db = new DatabaseSync(join(storageDir, 'context.db'), {
      readOnly: true,
    });
    try {
      const sessionId = manager.getSessionId();
      expect(
        db.prepare('SELECT session_id FROM session_meta WHERE session_id = ?').get(sessionId)
      ).toMatchObject({ session_id: sessionId });
      const tag = db
        .prepare(`SELECT tags.tag_number, tags.harness FROM tags
        JOIN source_contents ON tags.session_id = source_contents.session_id
          AND tags.tag_number = source_contents.tag_id
        WHERE tags.session_id = ? AND source_contents.content = ?`)
        .get(sessionId, 'hi');
      expect(tag).toMatchObject({ harness: 'pi' });
      expect(sentText).toBe(`§${tag?.tag_number}§ hi`);
    } finally {
      db.close();
    }
  } finally {
    await session?.dispose();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    if (previousResources) Object.defineProperty(process, 'resourcesPath', previousResources);
    else Reflect.deleteProperty(process, 'resourcesPath');
  }
}, 30_000);
