import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider } from '@earendil-works/pi-ai';
import {
  createMcpExtension,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { createRoleSession, subscribeNormalized } from '@fynvra/agent-runtime';
import type { FynvraSessionEvent } from '@fynvra/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContextRecovery } from './contextRecovery';

// Real pi session + pi's real `/mcp` extension against a local fake OAuth MCP server.
// Only `openUrl` is replaced, so the test does not open a browser.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function body(request: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of request) text += chunk;
  return text;
}

function json(response: ServerResponse, status: number, value: unknown, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(value));
}

/** MCP over streamable HTTP behind OAuth (401 + protected-resource and auth-server metadata). */
async function fakeOAuthMcp() {
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(response, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
      });
    }
    if (
      url.pathname.startsWith('/.well-known/oauth-authorization-server') ||
      url.pathname.startsWith('/.well-known/openid-configuration')
    ) {
      return json(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url.pathname === '/register') {
      const registration = JSON.parse(await body(request));
      return json(response, 201, { ...registration, client_id: 'fake-client' });
    }
    if (url.pathname === '/token') {
      await body(request);
      return json(response, 200, {
        access_token: 'fake-token',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'fake-refresh',
      });
    }
    if (url.pathname !== '/mcp') return json(response, 404, {});
    if (request.headers.authorization !== 'Bearer fake-token') {
      await body(request);
      return json(
        response,
        401,
        { error: 'unauthorized' },
        {
          'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        }
      );
    }
    if (request.method !== 'POST') return json(response, 405, {});
    const message = JSON.parse(await body(request));
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fake', version: '1.0.0' },
          }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }
          : {};
    return json(response, 200, { jsonrpc: '2.0', id: message.id, result });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return origin;
}

/** An MCP endpoint that accepts connections and never answers: its startup connection hangs. */
async function hangingServer() {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

async function open(
  servers: { name: string; url: string; timeout?: number }[],
  extension?: (pi: ExtensionAPI) => void,
  commandHintMs?: number
) {
  const dir = await mkdtemp(join(tmpdir(), 'fynvra-slash-'));
  // pi keeps MCP OAuth tokens in <PI_CODING_AGENT_DIR>/mcp-auth.json.
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  cleanup.push(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  });
  const faux = fauxProvider({ provider: 'slash-test', models: [{ id: 'slash-test' }] });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const openUrl = vi.fn();
  const created = await createRoleSession({
    role: {
      id: 'worker',
      name: 'worker',
      tools: 'readonly',
      approvalMode: 'full',
      skillIds: [],
      mcpServerIds: [],
    },
    cwd: dir,
    agentDir: dir,
    host: null,
    model: { runtime, model: faux.getModel() },
    sessionManager: SessionManager.open(join(dir, 'session.jsonl'), dir, dir),
    resourcePaths: { skills: [], mcpServers: [] },
    extensions: [
      {
        name: 'fake-mcp',
        hidden: true,
        factory: createMcpExtension({
          loadConfig: () => ({
            servers: servers.map(({ name, url, timeout }) => ({
              name,
              config: { type: 'http', url, exposure: 'direct', ...(timeout ? { timeout } : {}) },
              source: 'test',
            })),
            errors: [],
          }),
          updateConfig: () => {},
          openUrl,
        }),
      },
      ...(extension ? [{ name: 'test-commands', hidden: true, factory: extension }] : []),
    ],
    settingsManager: SettingsManager.inMemory({ enableInstallTelemetry: false }),
  });
  const { session } = created;
  const events: FynvraSessionEvent[] = [];
  const recovery = createContextRecovery({
    session,
    strategy: 'native',
    timeoutMs: 30_000,
    contextWindow: () => session.model?.contextWindow ?? 0,
    log: () => {},
    mcpServers: servers.map((server) => server.name),
    ...(commandHintMs ? { commandHintMs } : {}),
  });
  const subscription = subscribeNormalized(
    session,
    (event) => {
      events.push(event);
      recovery.onEvent(event);
    },
    { compactionTimeoutMs: 30_000 }
  );
  recovery.bind(subscription);
  cleanup.push(async () => {
    recovery.dispose();
    await created.dispose();
    subscription.unsubscribe();
  });
  const notices = () =>
    events.flatMap((event) => (event.type === 'notice' ? [`${event.level}: ${event.text}`] : []));
  return { dir, recovery, session, events, notices, openUrl };
}

function spyOnMcp(session: Awaited<ReturnType<typeof open>>['session']) {
  // getCommand returns a fresh object per call; spy on the one the dispatch receives.
  const runner = session.extensionRunner;
  const handler = vi.fn();
  const getCommand = runner.getCommand.bind(runner);
  vi.spyOn(runner, 'getCommand').mockImplementation((name) => {
    const command = getCommand(name);
    if (name !== 'mcp' || !command) return command;
    handler.mockImplementation(command.handler);
    return { ...command, handler };
  });
  return handler;
}

async function until(check: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('extension command dispatch', () => {
  it('runs a registered command with a command-scoped UI and shows its notices', async () => {
    let seen: { hasUI: boolean; args: string } | undefined;
    const env = await open([], (pi) =>
      pi.registerCommand('hello', {
        description: 'test',
        handler: async (args, ctx) => {
          seen = { hasUI: ctx.hasUI, args };
          ctx.ui.notify(`hello ${args}`, 'warning');
          ctx.ui.notify('plain');
        },
      })
    );
    const prompt = vi.spyOn(env.session, 'prompt');
    await env.recovery.prompt('/hello big world');
    expect(seen).toEqual({ hasUI: true, args: 'big world' });
    expect(env.notices()).toEqual(['warning: hello big world', 'info: plain']);
    // The command event precedes its notices, so the echo is confirmed above them.
    expect(env.events.findIndex((event) => event.type === 'command')).toBeLessThan(
      env.events.findIndex((event) => event.type === 'notice')
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(env.recovery.isIdle()).toBe(true);
    // The command settles the chat once its notices are out.
    const ends = env.events.filter((event) => event.type === 'command_end');
    expect(ends).toMatchObject([{ aborted: false }]);
    expect(env.events.indexOf(ends[0] as FynvraSessionEvent)).toBeGreaterThan(
      env.events.findLastIndex((event) => event.type === 'notice')
    );
  });

  it('does not settle a running agent turn with command_end', async () => {
    const env = await open([], (pi) =>
      pi.registerCommand('hello', { description: 'test', handler: async () => {} })
    );
    vi.spyOn(env.session, 'isStreaming', 'get').mockReturnValue(true);
    await env.recovery.prompt('/hello');
    expect(env.events.some((event) => event.type === 'command')).toBe(true);
    expect(env.events.some((event) => event.type === 'command_end')).toBe(false);
  });

  it('sends unknown slash text to pi as a prompt', async () => {
    const env = await open([]);
    const prompt = vi.spyOn(env.session, 'prompt').mockResolvedValue();
    await env.recovery.prompt('/nope args');
    expect(prompt).toHaveBeenCalledWith('/nope args', expect.anything());
    expect(env.events.some((event) => event.type === 'command')).toBe(false);
  });

  it('turns a handler error into an error notice', async () => {
    const env = await open([], (pi) =>
      pi.registerCommand('boom', {
        description: 'test',
        handler: async () => {
          throw new Error('kaput');
        },
      })
    );
    await env.recovery.prompt('/boom');
    expect(env.notices()).toEqual(['error: /boom failed: kaput']);
    expect(env.recovery.isIdle()).toBe(true);
  });

  it('Stop during a pending input() makes the session idle and consumes the input', async () => {
    let answer: string | undefined = 'unset';
    const env = await open([], (pi) =>
      pi.registerCommand('ask', {
        description: 'test',
        handler: async (_args, ctx) => {
          answer = await ctx.ui.input('Paste the code');
          ctx.ui.notify('late output');
        },
      })
    );
    const run = env.recovery.prompt('/ask');
    await until(() => env.notices().length > 0);
    expect(env.notices()).toEqual(['info: Paste the code']);
    expect(env.recovery.isIdle()).toBe(false);

    await env.recovery.abort();
    expect(env.recovery.isIdle()).toBe(true);
    await run;
    await until(() => answer !== 'unset');
    expect(answer).toBeUndefined();
    expect(env.notices()).toEqual(['info: Paste the code']);
    expect(env.events.filter((event) => event.type === 'command_end')).toMatchObject([
      { aborted: true },
    ]);
    expect(env.events.findLast((event) => event.type === 'context_runtime')).toMatchObject({
      snapshot: { pendingPromptCount: 0 },
    });
    // A reopened session would not run it again: the checkpoint holds no pending input.
    const checkpoint = env.session.sessionManager
      .getEntries()
      .findLast((entry) => entry.type === 'custom');
    expect(checkpoint).toMatchObject({ data: { pending: [] } });
  });

  it('says when a command asks for a choice Fynvra cannot show', async () => {
    const env = await open([], (pi) =>
      pi.registerCommand('pick', {
        description: 'test',
        handler: async (_args, ctx) => {
          await ctx.ui.select('Server', ['a', 'b']);
          await ctx.ui.confirm('Sure?', 'really');
        },
      })
    );
    await env.recovery.prompt('/pick');
    expect(env.notices()).toHaveLength(1);
    expect(env.notices()[0]).toMatch(/^warning: \/pick asked for an interactive choice/);
  });

  const waitFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const slow = (notifyFirst: boolean) => (pi: ExtensionAPI) =>
    pi.registerCommand('slow', {
      description: 'test',
      handler: async (_args, ctx) => {
        if (notifyFirst) ctx.ui.notify('working');
        await waitFor(300);
      },
    });

  it('hints once when a command stays silent', async () => {
    const env = await open([], slow(false), 50);
    await env.recovery.prompt('/slow');
    expect(env.notices()).toEqual(['info: /slow is still running. Press Stop to cancel.']);
  });

  it('does not hint after the command notified', async () => {
    const env = await open([], slow(true), 50);
    await env.recovery.prompt('/slow');
    expect(env.notices()).toEqual(['info: working']);
  });

  it('does not hint after Stop', async () => {
    const env = await open([], slow(false), 100);
    const run = env.recovery.prompt('/slow');
    await waitFor(20);
    await env.recovery.abort();
    await run;
    await waitFor(200);
    expect(env.notices()).toEqual([]);
  });
});

describe('/mcp login through Fynvra command dispatch', () => {
  it('shows the URL, completes through the localhost callback and stores the tokens', async () => {
    const origin = await fakeOAuthMcp();
    const env = await open([{ name: 'fake', url: `${origin}/mcp` }]);
    const run = env.recovery.prompt('/mcp login fake');
    await until(() => env.openUrl.mock.calls.length > 0);

    const authorize = new URL(env.openUrl.mock.calls[0]?.[0]);
    expect(authorize.origin + authorize.pathname).toBe(`${origin}/authorize`);
    expect(env.notices().join('\n')).toContain(authorize.href);
    expect(env.events.find((event) => event.type === 'command')).toMatchObject({
      text: '/mcp login fake',
    });
    expect(env.recovery.isIdle()).toBe(false);

    // The browser lands on the localhost callback server pi listens on.
    const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '');
    callback.searchParams.set('code', 'fake-code');
    callback.searchParams.set('state', authorize.searchParams.get('state') ?? '');
    expect((await fetch(callback)).status).toBe(200);
    await run;

    expect(env.notices().at(-1)).toBe('info: Signed in to MCP server "fake" (1 tools).');
    expect(env.recovery.isIdle()).toBe(true);
    const stored = await readFile(join(env.dir, 'mcp-auth.json'), 'utf8');
    expect(stored).toContain('fake-token');
    // Consumed, not kept as a pending prompt; nothing reached the model.
    expect(env.events.findLast((event) => event.type === 'context_runtime')).toMatchObject({
      snapshot: { pendingPromptCount: 0 },
    });
    expect(env.session.messages).toHaveLength(0);
  }, 30_000);

  it('Stop while waiting for the browser releases the session at once', async () => {
    const origin = await fakeOAuthMcp();
    const env = await open([{ name: 'fake', url: `${origin}/mcp` }]);
    const run = env.recovery.prompt('/mcp login fake');
    await until(() => env.openUrl.mock.calls.length > 0);
    expect(env.recovery.isIdle()).toBe(false);

    await env.recovery.abort();
    expect(env.recovery.isIdle()).toBe(true);
    await run;
    const shown = env.notices().length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The cancelled sign-in's own "Sign-in cancelled." is dropped after Stop.
    expect(env.notices()).toHaveLength(shown);
  }, 30_000);

  it('fails at once on a server this session does not have', async () => {
    const env = await open([
      { name: 'fake', url: await hangingServer(), timeout: 600 },
      { name: 'other', url: await hangingServer(), timeout: 600 },
    ]);
    const prompt = vi.spyOn(env.session, 'prompt');
    const handler = spyOnMcp(env.session);
    await env.recovery.prompt('/mcp login mobbin');
    expect(env.notices()).toEqual([
      'error: No MCP server named "mobbin" in this session. This session\'s servers: fake, other. Sign in from a session whose role has "mobbin", or add it to this role in Settings.',
    ]);
    expect(handler).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(env.recovery.isIdle()).toBe(true);
    const notice = env.events.findIndex((event) => event.type === 'notice');
    expect(env.events.findIndex((event) => event.type === 'command_end')).toBeGreaterThan(notice);
    expect(env.events.find((event) => event.type === 'command_end')).toMatchObject({
      aborted: false,
    });
    expect(env.events.findLast((event) => event.type === 'context_runtime')).toMatchObject({
      snapshot: { pendingPromptCount: 0 },
    });
  });

  it('lists none when the session has no MCP servers', async () => {
    const env = await open([]);
    await env.recovery.prompt('/mcp logout mobbin');
    expect(env.notices()[0]).toContain("This session's servers: none.");
  });

  it('treats - and _ in server names as equal', async () => {
    const origin = await fakeOAuthMcp();
    const env = await open([{ name: 'fake-server', url: `${origin}/mcp` }]);
    const handler = spyOnMcp(env.session);
    const run = env.recovery.prompt('/mcp login fake_server');
    await until(() => env.openUrl.mock.calls.length > 0);
    expect(handler).toHaveBeenCalledWith('login fake-server', expect.anything());
    expect(env.notices().some((text) => text.startsWith('error:'))).toBe(false);
    await env.recovery.abort();
    await run;
  }, 30_000);

  it('hints while /mcp waits for servers still connecting', async () => {
    const origin = await fakeOAuthMcp();
    const env = await open(
      [
        { name: 'fake', url: `${origin}/mcp` },
        { name: 'slow', url: await hangingServer(), timeout: 600 },
      ],
      undefined,
      50
    );
    const run = env.recovery.prompt('/mcp login fake');
    await until(() => env.notices().length > 0);
    expect(env.notices()).toEqual([
      "info: Waiting for this session's MCP servers to finish connecting; a freshly started session can take a minute or two. Press Stop to cancel.",
    ]);
    await env.recovery.abort();
    await run;
  }, 30_000);

  it('a server still connecting holds /mcp at `await pending`; Stop releases it', async () => {
    const origin = await fakeOAuthMcp();
    const env = await open([
      { name: 'fake', url: `${origin}/mcp` },
      { name: 'slow', url: await hangingServer(), timeout: 600 },
    ]);
    const run = env.recovery.prompt('/mcp login fake');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // Before this change the same await held pi's prompt(), so Stop could not end the turn.
    expect(env.openUrl).not.toHaveBeenCalled();
    expect(env.notices()).toEqual([]);
    expect(env.recovery.isIdle()).toBe(false);

    await env.recovery.abort();
    expect(env.recovery.isIdle()).toBe(true);
    await run;
  }, 30_000);
});
