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

describe('createPiSessionFactory model switch', () => {
  const role = (thinking?: 'low') => ({
    id: 'worker',
    name: 'Worker',
    skillIds: [],
    mcpServerIds: [],
    tools: 'all' as const,
    approvalMode: 'auto-edits' as const,
    ...(thinking
      ? { model: { providerId: 'anthropic', modelId: 'claude-opus-5-5', thinking } }
      : {}),
  });
  const modelA = { providerId: 'fynvra-a', api: 'anthropic-messages', modelId: 'claude-opus-5-5' };
  const modelB = { providerId: 'fynvra-b', api: 'openai-responses', modelId: 'gpt-5.5' };

  /** 假的 pi AgentSession：只记录换模型的调用 */
  async function openWith(roleThinking?: 'low') {
    const dir = mkdtempSync(join(tmpdir(), 'fynvra-pi-session-model-'));
    dirs.push(dir);
    const piSession = { setModel: vi.fn(async () => {}), setThinkingLevel: vi.fn() };
    mocks.createRoleSession.mockResolvedValue({
      session: piSession,
      warnings: [],
      dispose: vi.fn(),
    });
    // 模拟 models.ts：pi 的模型对象，档位按模型落定（gpt-5.5 没有 minimal）
    const resolveModel = vi.fn(
      async (spec: SpawnSessionSpec['model']) =>
        ({
          model: { id: spec.modelId, provider: spec.providerId },
          ...(spec.thinking && spec.thinking !== 'minimal' ? { thinking: spec.thinking } : {}),
        }) as unknown as ResolvedModel
    );
    const onModelSelected = vi.fn();
    const open = createPiSessionFactory({
      agentDir: join(dir, 'agent'),
      resolveModel,
      onModelSelected,
    });
    const session = await open({
      identity: { sessionId: 'session-1', generation: 1 },
      spec: {
        role: role(roleThinking),
        cwd: dir,
        sessionFile: join(dir, 'agent', 'sessions', 'session-1.jsonl'),
        model: modelA,
        skills: [],
        mcpServers: [],
        worker: false,
        roles: [],
      },
      host: null,
      workerHost: null,
    });
    return { session, piSession, resolveModel, onModelSelected };
  }

  it('registers the new model and hands it to pi with the settled thinking level', async () => {
    const { session, piSession, resolveModel } = await openWith();
    await session.setModel({ ...modelB, apiKey: 'k-b', thinking: 'xhigh' });

    expect(resolveModel).toHaveBeenLastCalledWith({ ...modelB, apiKey: 'k-b', thinking: 'xhigh' });
    expect(piSession.setModel).toHaveBeenCalledWith({ id: 'gpt-5.5', provider: 'fynvra-b' });
    expect(piSession.setThinkingLevel).toHaveBeenCalledWith('xhigh');
    // 先换模型再设档位：pi 的 setModel 会按新模型重新 clamp 一次档位
    expect(piSession.setModel.mock.invocationCallOrder[0]).toBeLessThan(
      piSession.setThinkingLevel.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("hands pi's max level to pi when the model settles on it", async () => {
    const { session, piSession } = await openWith();
    await session.setModel({ ...modelB, modelId: 'gpt-6-sol', thinking: 'max' });
    expect(piSession.setThinkingLevel).toHaveBeenCalledWith('max');
  });

  it('reports the model the session uses when it opens and after every switch', async () => {
    const { session, onModelSelected } = await openWith();
    await session.setModel({ ...modelB, thinking: 'xhigh' });
    expect(onModelSelected.mock.calls).toEqual([
      ['session-1', { model: { id: 'claude-opus-5-5', provider: 'fynvra-a' } }],
      ['session-1', { model: { id: 'gpt-5.5', provider: 'fynvra-b' }, thinking: 'xhigh' }],
    ]);
  });

  it("falls back to the role's thinking level when the session has none, like a spawn does", async () => {
    const { session, resolveModel } = await openWith('low');
    expect(resolveModel).toHaveBeenLastCalledWith({ ...modelA, thinking: 'low' });
    await session.setModel(modelB);
    expect(resolveModel).toHaveBeenLastCalledWith({ ...modelB, thinking: 'low' });
  });

  it('leaves the level to pi when the model settles on none (no reasoning)', async () => {
    const { session, piSession } = await openWith();
    await session.setModel({ ...modelB, thinking: 'minimal' });
    expect(piSession.setModel).toHaveBeenCalledTimes(1);
    expect(piSession.setThinkingLevel).not.toHaveBeenCalled();
  });

  it('fails without touching pi when the model cannot be registered', async () => {
    const { session, piSession, resolveModel } = await openWith();
    resolveModel.mockRejectedValueOnce(new Error('no base URL'));
    await expect(session.setModel(modelB)).rejects.toThrow('no base URL');
    expect(piSession.setModel).not.toHaveBeenCalled();
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
