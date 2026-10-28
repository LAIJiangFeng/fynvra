import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@earendil-works/pi-ai';
import type {
  ApprovalGate,
  ApprovalPolicyHooks,
  ApprovalRequestFn,
  ResolvedModel,
} from '@fynvra/agent-runtime';
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

/**
 * 假的 pi AgentSession：只有工厂在打开时会碰的 agent.convertToLlm（原样返回），其余方法按用例给。
 */
function fakePiSession<T extends object>(methods: T = {} as T) {
  return { agent: { convertToLlm: async (messages: Message[]) => messages }, ...methods };
}

describe('createPiSessionFactory', () => {
  it('opens the session with the shell path of the spawn spec in its settings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fynvra-pi-session-'));
    dirs.push(dir);
    mocks.createRoleSession.mockResolvedValue({
      session: fakePiSession(),
      warnings: [],
      dispose: vi.fn(),
    });
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
    const { settingsManager, inPlace } = mocks.createRoleSession.mock.calls[0]?.[0] ?? {};
    expect(settingsManager?.getShellPath()).toBe('D:\\Software\\Git\\bin\\bash.exe');
    // 仍是 agent-runtime 默认的隔离设置
    expect(settingsManager?.getEnableInstallTelemetry()).toBe(false);
    expect(inPlace).toBeUndefined();

    // 工作区没有 git：inPlace 原样交给 createRoleSession（提示词按它追加）
    await open({
      identity: { sessionId: 'session-2', generation: 1 },
      spec: {
        ...spec,
        inPlace: true,
        networkProxy: { mode: 'manual', url: 'http://127.0.0.1:7890', gitCompatibility: true },
        instructionFile: { name: 'CLAUDE.md', content: 'Selected text' },
      },
      host: null,
      workerHost: null,
    });
    expect(mocks.createRoleSession.mock.calls[0]?.[0]).not.toHaveProperty('commandEnv');
    const incoming = { PI_SESSION_ID: 'keep-session', NO_PROXY: '*', PATH: 'keep-path' };
    const env = mocks.createRoleSession.mock.calls[1]?.[0].commandEnv(incoming);
    expect(env).toMatchObject({
      PI_SESSION_ID: 'keep-session',
      PATH: 'keep-path',
      NO_PROXY: '',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      GIT_CONFIG_COUNT: '3',
    });
    expect(incoming).toEqual({ PI_SESSION_ID: 'keep-session', NO_PROXY: '*', PATH: 'keep-path' });
    expect(mocks.createRoleSession.mock.calls[1]?.[0]).toMatchObject({
      inPlace: true,
      resourcePaths: { instructionFile: { name: 'CLAUDE.md', content: 'Selected text' } },
    });

    await open({
      identity: { sessionId: 'session-3', generation: 1 },
      spec: {
        ...spec,
        shellPath: 'C:\\PowerShell\\pwsh.exe',
        role: { ...spec.role, systemPrompt: 'Keep the role instructions.' },
      },
      host: null,
      workerHost: null,
    });
    const powershell = mocks.createRoleSession.mock.calls[2]?.[0];
    expect(powershell.role.systemPrompt).toBe(
      'Keep the role instructions.\n\nOn this machine the bash tool runs commands with PowerShell 7 via -c; write PowerShell syntax.'
    );
    expect(powershell.settingsManager.getShellPath()).toBe('C:\\PowerShell\\pwsh.exe');
    expect(spec.role.systemPrompt).toBeUndefined();
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
    const piSession = fakePiSession({
      setModel: vi.fn(async () => {}),
      setThinkingLevel: vi.fn(),
    });
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

describe('createPiSessionFactory approval mode switch', () => {
  const spec = (dir: string): SpawnSessionSpec => ({
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
    worker: false,
    roles: [],
  });

  async function openWith(approval: ApprovalPolicyHooks | undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'fynvra-pi-session-approval-mode-'));
    dirs.push(dir);
    const gate = { setMode: vi.fn() };
    // 与真实的 createRoleSession 一样：把审批通道交给审批门，审批门建好后经 onGate 交回宿主
    mocks.createRoleSession.mockImplementation(
      async (options: { approval?: ApprovalPolicyHooks }) => {
        options.approval?.onGate?.(gate as unknown as ApprovalGate);
        return { session: fakePiSession(), warnings: [], dispose: vi.fn() };
      }
    );
    const open = createPiSessionFactory({
      agentDir: join(dir, 'agent'),
      resolveModel: async () => ({}) as ResolvedModel,
    });
    const session = await open({
      identity: { sessionId: 'session-1', generation: 1 },
      spec: spec(dir),
      host: null,
      workerHost: null,
      ...(approval ? { approval } : {}),
    });
    return { session, gate };
  }

  it('switches the approval gate that createRoleSession built for the session', async () => {
    const hostOnGate = vi.fn();
    const request = vi.fn<ApprovalRequestFn>(async () => 'allow');
    const { session, gate } = await openWith({ request, timeoutMs: 1_000, onGate: hostOnGate });
    session.setApprovalMode('full');
    session.setApprovalMode('supervised');
    expect(gate.setMode.mock.calls).toEqual([['full'], ['supervised']]);
    // 宿主自己的 onGate 也照样收到；审批通道的其余部分原样交给 createRoleSession
    expect(hostOnGate).toHaveBeenCalledWith(gate);
    const { approval } = mocks.createRoleSession.mock.calls.at(-1)?.[0] ?? {};
    expect(approval).toMatchObject({ request, timeoutMs: 1_000 });
  });

  it('refuses to switch a session that has no approval channel (and so no gate to reach)', async () => {
    const { session, gate } = await openWith(undefined);
    expect(() => session.setApprovalMode('full')).toThrow(/no approval gate/);
    expect(gate.setMode).not.toHaveBeenCalled();
  });
});

describe('createPiSessionFactory prompt', () => {
  const screenshot = { data: 'iVBORw0KGgo=', mimeType: 'image/png' as const };
  const photo = { data: 'UklGRg==', mimeType: 'image/webp' as const };

  async function openSession() {
    const dir = mkdtempSync(join(tmpdir(), 'fynvra-pi-session-prompt-'));
    dirs.push(dir);
    const piSession = fakePiSession({
      prompt: vi.fn(async (_text: string, _options?: unknown) => {}),
    });
    mocks.createRoleSession.mockResolvedValue({
      session: piSession,
      warnings: [],
      dispose: vi.fn(),
    });
    const open = createPiSessionFactory({
      agentDir: join(dir, 'agent'),
      resolveModel: async () => ({}) as ResolvedModel,
    });
    const session = await open({
      identity: { sessionId: 'session-1', generation: 1 },
      spec: {
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
        model: {
          providerId: 'fynvra-test',
          api: 'anthropic-messages',
          modelId: 'claude-sonnet-5-5',
        },
        skills: [],
        mcpServers: [],
        worker: false,
        roles: [],
      },
      host: null,
      workerHost: null,
    });
    return { session, piSession };
  }

  it('hands pasted images to pi as image content, and no images option without them', async () => {
    const { session, piSession } = await openSession();
    await session.prompt('What is wrong here?', [screenshot, photo]);
    await session.prompt('', [screenshot]);
    await session.prompt('text only');
    await session.prompt('an empty list is no images', []);
    expect(piSession.prompt.mock.calls).toEqual([
      [
        'What is wrong here?',
        {
          streamingBehavior: 'followUp',
          images: [
            { type: 'image', data: screenshot.data, mimeType: 'image/png' },
            { type: 'image', data: photo.data, mimeType: 'image/webp' },
          ],
        },
      ],
      [
        '',
        {
          streamingBehavior: 'followUp',
          images: [{ type: 'image', data: screenshot.data, mimeType: 'image/png' }],
        },
      ],
      ['text only', { streamingBehavior: 'followUp' }],
      ['an empty list is no images', { streamingBehavior: 'followUp' }],
    ]);
  });

  it('leaves out the empty text block pi puts before the images of a prompt without text', async () => {
    const { piSession } = await openSession();
    const image = { type: 'image' as const, ...screenshot };
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '' }, image], timestamp: 1 },
      { role: 'user', content: [{ type: 'text', text: ' \n' }, image, image], timestamp: 2 },
      { role: 'user', content: [{ type: 'text', text: 'What is this?' }, image], timestamp: 3 },
      { role: 'user', content: 'plain string', timestamp: 4 },
      // 只有空文本、没有别的内容：原样留着，不造出没有内容的消息
      { role: 'user', content: [{ type: 'text', text: '' }], timestamp: 5 },
    ];
    // 工厂打开会话时换上的转换：pi 每一轮把消息交给 provider 之前都经过它
    expect(await piSession.agent.convertToLlm(messages)).toEqual([
      { role: 'user', content: [image], timestamp: 1 },
      { role: 'user', content: [image, image], timestamp: 2 },
      messages[2],
      messages[3],
      messages[4],
    ]);
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
