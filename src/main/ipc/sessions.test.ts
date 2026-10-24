import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentHostService } from '../services/agentHost/agentHost';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  appListeners: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/fynvra-test/userData',
    on: (event: string, listener: (...args: unknown[]) => unknown) =>
      mocks.appListeners.set(event, listener),
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  dialog: {},
  nativeTheme: { themeSource: 'system', shouldUseDarkColors: false },
}));
// `?modulePath` 只有 electron-vite 构建认得；这里不会真的 fork
vi.mock('../services/agentHost/electronWorker', () => ({ forkAgentWorker: vi.fn() }));

const host = {
  list: vi.fn(() => []),
  create: vi.fn(async () => ({ ok: true })),
  remove: vi.fn(async () => ({ ok: true })),
  prompt: vi.fn(async () => ({ ok: true })),
  abort: vi.fn(async () => ({ ok: true })),
  history: vi.fn(async () => ({ ok: true, messages: [] })),
  respondApproval: vi.fn(async () => ({ ok: true })),
  setModel: vi.fn(async () => ({ ok: true })),
  modelOptions: vi.fn(async () => ({ ok: true, providers: [] })),
  setApprovalMode: vi.fn(async () => ({ ok: true })),
  refreshBranches: vi.fn(),
};

const invoke = (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)?.({ sender: {} }, ...args);

beforeAll(async () => {
  const { registerSessionHandlers } = await import('./sessions');
  registerSessionHandlers(() => host as unknown as AgentHostService);
});

beforeEach(() => {
  for (const fn of Object.values(host)) fn.mockClear();
});

describe('sessions IPC', () => {
  it('registers every sessions channel', () => {
    const channels = Object.entries(IPC_CHANNELS)
      .filter(([name]) => name.startsWith('SESSIONS_'))
      .map(([, channel]) => channel)
      .filter((channel) => mocks.handlers.has(channel));
    expect(channels.sort()).toEqual(
      [
        'sessions:abort',
        'sessions:create',
        'sessions:history',
        'sessions:list',
        'sessions:model-options',
        'sessions:prompt',
        'sessions:remove',
        'sessions:respond-approval',
        'sessions:set-model',
        'sessions:set-approval-mode',
      ].sort()
    );
  });

  it('re-reads the session branches when a window gets the focus (the user may have checked out outside)', () => {
    const onFocus = mocks.appListeners.get('browser-window-focus');
    expect(onFocus).toBeTypeOf('function');
    onFocus?.({}, {});
    expect(host.refreshBranches).toHaveBeenCalledTimes(1);
  });

  it('forwards an approval mode switch with only the session id and the mode', async () => {
    for (const mode of ['supervised', 'auto-edits', 'full']) {
      await invoke(IPC_CHANNELS.SESSIONS_SET_APPROVAL_MODE, { sessionId: 's-1', mode });
    }
    expect(host.setApprovalMode.mock.calls).toEqual([
      [{ sessionId: 's-1', mode: 'supervised' }],
      [{ sessionId: 's-1', mode: 'auto-edits' }],
      [{ sessionId: 's-1', mode: 'full' }],
    ]);
  });

  it('forwards narrowed inputs to the agent host', async () => {
    expect(await invoke(IPC_CHANNELS.SESSIONS_LIST, 'ws-1')).toEqual({ ok: true, sessions: [] });
    expect(host.list).toHaveBeenCalledWith('ws-1');

    await invoke(IPC_CHANNELS.SESSIONS_CREATE, {
      workspaceId: 'ws-1',
      roleId: 'tester',
      model: { providerId: 'anthropic', modelId: 'claude-opus-5-5' },
    });
    expect(host.create).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      roleId: 'tester',
      model: { providerId: 'anthropic', modelId: 'claude-opus-5-5' },
    });

    await invoke(IPC_CHANNELS.SESSIONS_PROMPT, { sessionId: 's-1', text: '  keep spacing  ' });
    expect(host.prompt).toHaveBeenCalledWith('s-1', '  keep spacing  ');
    await invoke(IPC_CHANNELS.SESSIONS_ABORT, 's-1');
    expect(host.abort).toHaveBeenCalledWith('s-1');
    await invoke(IPC_CHANNELS.SESSIONS_HISTORY, 's-1');
    expect(host.history).toHaveBeenCalledWith('s-1');
    await invoke(IPC_CHANNELS.SESSIONS_REMOVE, 's-1');
    expect(host.remove).toHaveBeenCalledWith('s-1');
    await invoke(IPC_CHANNELS.SESSIONS_RESPOND_APPROVAL, {
      sessionId: 's-1',
      requestId: 'req-1',
      decision: 'deny',
    });
    expect(host.respondApproval).toHaveBeenCalledWith({
      sessionId: 's-1',
      requestId: 'req-1',
      decision: 'deny',
    });
  });

  it('forwards model choices: create with a thinking level, set-model and model-options', async () => {
    const model = { providerId: 'openai', modelId: 'gpt-5.5', thinking: 'xhigh' };
    await invoke(IPC_CHANNELS.SESSIONS_CREATE, { workspaceId: 'ws-1', roleId: 'worker', model });
    expect(host.create).toHaveBeenCalledWith({ workspaceId: 'ws-1', roleId: 'worker', model });

    await invoke(IPC_CHANNELS.SESSIONS_SET_MODEL, { sessionId: 's-1', model });
    await invoke(IPC_CHANNELS.SESSIONS_SET_MODEL, {
      sessionId: 's-1',
      model: { providerId: 'local', modelId: 'qwen3:32b' },
    });
    expect(host.setModel.mock.calls).toEqual([
      [{ sessionId: 's-1', model }],
      [{ sessionId: 's-1', model: { providerId: 'local', modelId: 'qwen3:32b' } }],
    ]);

    expect(await invoke(IPC_CHANNELS.SESSIONS_MODEL_OPTIONS, { workspaceId: 'ws-1' })).toEqual({
      ok: true,
      providers: [],
    });
    await invoke(IPC_CHANNELS.SESSIONS_MODEL_OPTIONS, {});
    await invoke(IPC_CHANNELS.SESSIONS_MODEL_OPTIONS);
    expect(host.modelOptions.mock.calls).toEqual([[{ workspaceId: 'ws-1' }], [{}], [{}]]);
  });

  it.each([
    [IPC_CHANNELS.SESSIONS_LIST, '../ws'],
    [IPC_CHANNELS.SESSIONS_LIST, { id: 'ws-1' }],
    [IPC_CHANNELS.SESSIONS_CREATE, null],
    [IPC_CHANNELS.SESSIONS_CREATE, { workspaceId: 'ws-1', roleId: 'Bad Role' }],
    [IPC_CHANNELS.SESSIONS_CREATE, { workspaceId: 'ws-1', roleId: 'worker', cwd: 'C:\\' }],
    [
      IPC_CHANNELS.SESSIONS_CREATE,
      { workspaceId: 'ws-1', roleId: 'worker', model: { providerId: 'a' } },
    ],
    [
      IPC_CHANNELS.SESSIONS_CREATE,
      {
        workspaceId: 'ws-1',
        roleId: 'worker',
        model: { providerId: 'a', modelId: 'b', apiKey: 'k' },
      },
    ],
    [IPC_CHANNELS.SESSIONS_PROMPT, { sessionId: 's-1', text: '   ' }],
    [IPC_CHANNELS.SESSIONS_PROMPT, { sessionId: 's-1', text: 'x'.repeat(1_000_001) }],
    [IPC_CHANNELS.SESSIONS_PROMPT, { sessionId: '../s', text: 'hi' }],
    [IPC_CHANNELS.SESSIONS_PROMPT, { sessionId: 's-1', text: 'hi', cwd: '/' }],
    [IPC_CHANNELS.SESSIONS_ABORT, 42],
    [IPC_CHANNELS.SESSIONS_HISTORY, 'C:\\data\\agent\\sessions\\x.jsonl'],
    [IPC_CHANNELS.SESSIONS_REMOVE, ''],
    [
      IPC_CHANNELS.SESSIONS_RESPOND_APPROVAL,
      { sessionId: 's-1', requestId: 'r', decision: 'always' },
    ],
    [IPC_CHANNELS.SESSIONS_RESPOND_APPROVAL, { sessionId: 's-1', decision: 'allow' }],
    [
      IPC_CHANNELS.SESSIONS_CREATE,
      {
        workspaceId: 'ws-1',
        roleId: 'worker',
        model: { providerId: 'a', modelId: 'b', thinking: 'ultra' },
      },
    ],
    [IPC_CHANNELS.SESSIONS_SET_MODEL, null],
    [IPC_CHANNELS.SESSIONS_SET_MODEL, { sessionId: 's-1' }],
    [
      IPC_CHANNELS.SESSIONS_SET_MODEL,
      { sessionId: '../s', model: { providerId: 'a', modelId: 'b' } },
    ],
    [IPC_CHANNELS.SESSIONS_SET_MODEL, { sessionId: 's-1', model: 'openai/gpt-5.5' }],
    [
      IPC_CHANNELS.SESSIONS_SET_MODEL,
      { sessionId: 's-1', model: { providerId: 'a', modelId: '' } },
    ],
    [
      IPC_CHANNELS.SESSIONS_SET_MODEL,
      { sessionId: 's-1', model: { providerId: 'a', modelId: 'b', thinking: 'turbo' } },
    ],
    [
      IPC_CHANNELS.SESSIONS_SET_MODEL,
      { sessionId: 's-1', model: { providerId: 'a', modelId: 'b', baseUrl: 'http://evil' } },
    ],
    [
      IPC_CHANNELS.SESSIONS_SET_MODEL,
      { sessionId: 's-1', model: { providerId: 'a', modelId: 'b' }, apiKey: 'k' },
    ],
    [IPC_CHANNELS.SESSIONS_MODEL_OPTIONS, 'ws-1'],
    [IPC_CHANNELS.SESSIONS_MODEL_OPTIONS, { workspaceId: '../ws' }],
    [IPC_CHANNELS.SESSIONS_MODEL_OPTIONS, { workspaceId: 'ws-1', withKeys: true }],
    [IPC_CHANNELS.SESSIONS_SET_APPROVAL_MODE, null],
    [IPC_CHANNELS.SESSIONS_SET_APPROVAL_MODE, 'full'],
    [IPC_CHANNELS.SESSIONS_SET_APPROVAL_MODE, { sessionId: 's-1' }],
    [IPC_CHANNELS.SESSIONS_SET_APPROVAL_MODE, { mode: 'full' }],
    [IPC_CHANNELS.SESSIONS_SET_APPROVAL_MODE, { sessionId: '../s', mode: 'full' }],
    [IPC_CHANNELS.SESSIONS_SET_APPROVAL_MODE, { sessionId: 's-1', mode: 'yolo' }],
    [IPC_CHANNELS.SESSIONS_SET_APPROVAL_MODE, { sessionId: 's-1', mode: 'FULL' }],
    [IPC_CHANNELS.SESSIONS_SET_APPROVAL_MODE, { sessionId: 's-1', mode: 'full', roleId: 'x' }],
  ])('%s rejects %j without calling the host', async (channel, raw) => {
    expect(await invoke(channel, raw)).toMatchObject({ ok: false });
    for (const fn of Object.values(host)) expect(fn).not.toHaveBeenCalled();
  });

  it('turns a throwing host into an error result', async () => {
    host.prompt.mockRejectedValueOnce(new Error('worker gone'));
    expect(await invoke(IPC_CHANNELS.SESSIONS_PROMPT, { sessionId: 's-1', text: 'hi' })).toEqual({
      ok: false,
      error: 'worker gone',
    });
    host.list.mockImplementationOnce(() => {
      throw new Error('disk');
    });
    expect(await invoke(IPC_CHANNELS.SESSIONS_LIST, 'ws-1')).toEqual({ ok: false, error: 'disk' });
  });
});
