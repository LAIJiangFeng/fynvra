import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedModel } from '@fynvra/agent-runtime';
import type { SpawnSessionSpec } from '@shared/types/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiSessionFactory, toMcpServerConfig } from './piSession';

const mocks = vi.hoisted(() => ({ createRoleSession: vi.fn() }));

// 只换掉 createRoleSession：断言工厂交给它的参数，不起真实的 pi 会话
vi.mock('@fynvra/agent-runtime', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createRoleSession: mocks.createRoleSession,
}));

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createPiSessionFactory', () => {
  it('opens the session with the shell path of the spawn spec in its settings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fynvra-pi-session-'));
    dirs.push(dir);
    mocks.createRoleSession.mockResolvedValue({ session: {}, warnings: [], dispose: vi.fn() });
    const open = createPiSessionFactory({
      agentDir: join(dir, 'agent'),
      resolveModel: async () => ({}) as ResolvedModel,
    });
    const spec: SpawnSessionSpec = {
      role: {
        id: 'worker',
        name: 'Worker',
        skillIds: [],
        mcpServerIds: [],
        tools: 'all',
        approvalMode: 'auto-edits',
      },
      cwd: dir,
      sessionFile: join(dir, 'agent', 'sessions', 'session-1.jsonl'),
      model: { providerId: 'fynvra-test', api: 'anthropic-messages', modelId: 'claude-sonnet-5-5' },
      skills: [],
      mcpServers: [],
      worker: true,
      roles: [],
      shellPath: 'D:\\Software\\Git\\bin\\bash.exe',
    };
    await open({
      identity: { sessionId: 'session-1', generation: 1 },
      spec,
      host: null,
      workerHost: null,
    });

    expect(mocks.createRoleSession).toHaveBeenCalledTimes(1);
    const { settingsManager } = mocks.createRoleSession.mock.calls[0]?.[0] ?? {};
    expect(settingsManager?.getShellPath()).toBe('D:\\Software\\Git\\bin\\bash.exe');
    // 仍是 agent-runtime 默认的隔离设置
    expect(settingsManager?.getEnableInstallTelemetry()).toBe(false);
  });
});

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
