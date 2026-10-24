import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ApprovalRequestFn } from '@fynvra/agent-runtime';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPiSessionFactory, toMcpServerConfig } from './piSession';

describe('toMcpServerConfig', () => {
  it('maps a stdio server with its command, args and env', () => {
    expect(
      toMcpServerConfig({
        name: 'github',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: 'ghp_secret' },
      })
    ).toEqual({
      name: 'github',
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'ghp_secret' },
    });
  });

  it('maps a remote server (http or sse in the settings) to pi http with its headers', () => {
    expect(
      toMcpServerConfig({
        name: 'context7',
        url: 'https://mcp.context7.com/mcp',
        headers: { Authorization: 'Bearer secret' },
      })
    ).toEqual({
      name: 'context7',
      type: 'http',
      url: 'https://mcp.context7.com/mcp',
      headers: { Authorization: 'Bearer secret' },
    });
  });

  it('leaves out optional fields the server does not have', () => {
    expect(toMcpServerConfig({ name: 'local', command: 'my-mcp' })).toEqual({
      name: 'local',
      type: 'stdio',
      command: 'my-mcp',
    });
    expect(toMcpServerConfig({ name: 'remote', url: 'http://127.0.0.1:3000/mcp' })).toEqual({
      name: 'remote',
      type: 'http',
      url: 'http://127.0.0.1:3000/mcp',
    });
  });
});

describe('createPiSessionFactory', () => {
  let tmp = '';
  let faux: FauxProviderHandle;
  let runtime: ModelRuntime;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'fynvra-pi-session-'));
    await mkdir(join(tmp, 'repo'), { recursive: true });
    faux = fauxProvider({ provider: 'fynvra-faux', models: [{ id: 'faux-model' }] });
    runtime = await ModelRuntime.create({
      authPath: join(tmp, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('runs the role approval gate through the approval channel of the supervisor', async () => {
    const cwd = join(tmp, 'repo');
    const request = vi.fn<ApprovalRequestFn>(async () => 'deny');
    const open = createPiSessionFactory({
      agentDir: join(tmp, 'agent'),
      resolveModel: async () => ({ runtime, model: faux.getModel() }),
    });
    const session = await open({
      identity: { sessionId: 's1', generation: 1 },
      spec: {
        role: {
          id: 'careful',
          name: 'Careful',
          skillIds: [],
          mcpServerIds: [],
          tools: 'all',
          approvalMode: 'supervised',
        },
        cwd,
        sessionFile: join(tmp, 'agent', 'sessions', 's1.jsonl'),
        model: { providerId: 'fynvra-faux', api: faux.api, modelId: 'faux-model' },
        skills: [],
        mcpServers: [],
        worker: false,
        roles: [],
      },
      host: null,
      workerHost: null,
      approval: { request },
    });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('write', { path: 'gated.txt', content: 'x' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('ok'),
    ]);
    try {
      await session.prompt('Write the file.');
    } finally {
      await session.dispose();
    }
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'write', kind: 'file-write', detail: 'gated.txt' }),
      expect.any(AbortSignal)
    );
    expect(existsSync(join(cwd, 'gated.txt'))).toBe(false);
  });
});
