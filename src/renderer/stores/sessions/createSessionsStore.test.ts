import type { ApprovalMode, FynvraSessionEventBody } from '@fynvra/core';
import type {
  ApprovalRequest,
  ChatImage,
  ChatMessage,
  ModelOptions,
  ModelProviderOption,
  SessionEventEnvelope,
  SessionModelRef,
  SessionSummary,
} from '@shared/types/chat';
import type { IpcResult } from '@shared/types/ipc';
import { describe, expect, it, vi } from 'vitest';
import type { SessionsApi } from '../../lib/api/sessions';
import { connectSessionsStore, createSessionsStore } from './createSessionsStore';
import {
  findSession,
  selectArchivedSessionsOf,
  selectDraftImagesOf,
  selectMessagesOf,
  selectQueueOf,
  selectSessionsOf,
  selectStatusOf,
} from './selectors';

const WS = 'ws-1';

const PROVIDERS: ModelProviderOption[] = [
  {
    providerId: 'anthropic',
    name: 'Anthropic',
    api: 'anthropic-messages',
    models: [
      {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        thinkingLevels: ['low', 'medium', 'high', 'xhigh'],
        defaultThinking: 'medium',
      },
    ],
  },
];
const OPUS: SessionModelRef = { providerId: 'anthropic', modelId: 'claude-opus-5-5' };
const GPT: SessionModelRef = { providerId: 'openai', modelId: 'gpt-5.5', thinking: 'xhigh' };

function summary(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    workspaceId: WS,
    roleId: 'worker',
    title: id,
    cwd: '/repo',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    approvalMode: 'auto-edits',
    ...patch,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 注入的假 SessionsApi：方法都是 vi.fn，推送由 emit* 手动触发 */
function fakeApi(initial: SessionSummary[] = [summary('s1')]) {
  let sessions = initial;
  const listeners = {
    event: new Set<(envelope: SessionEventEnvelope) => void>(),
    changed: new Set<(workspaceId: string) => void>(),
    approval: new Set<(request: ApprovalRequest) => void>(),
  };
  const on =
    <T>(set: Set<(value: T) => void>) =>
    (callback: (value: T) => void) => {
      set.add(callback);
      return () => {
        set.delete(callback);
      };
    };
  const api = {
    list: vi.fn(async (workspaceId: string, _options?: { includeArchived?: boolean }) => ({
      ok: true as const,
      sessions: sessions.filter((session) => session.workspaceId === workspaceId),
    })),
    create: vi.fn(async (input: { workspaceId: string; roleId: string }) => {
      const session = summary(`s${sessions.length + 1}`, { ...input, createdAt: 9, updatedAt: 9 });
      sessions = [...sessions, session];
      return { ok: true as const, session };
    }),
    remove: vi.fn(async (sessionId: string): Promise<IpcResult> => {
      sessions = sessions.filter((session) => session.id !== sessionId);
      return { ok: true };
    }),
    prompt: vi.fn(
      async (_input: {
        sessionId: string;
        text: string;
        images?: ChatImage[];
      }): Promise<IpcResult> => ({
        ok: true,
      })
    ),
    steer: vi.fn(
      async (_input: {
        sessionId: string;
        text: string;
        images?: ChatImage[];
      }): Promise<IpcResult> => ({ ok: true })
    ),
    abort: vi.fn(async (_sessionId: string): Promise<IpcResult> => ({ ok: true })),
    history: vi.fn(
      async (_sessionId: string): Promise<IpcResult<{ messages: ChatMessage[] }>> => ({
        ok: true,
        messages: [],
      })
    ),
    respondApproval: vi.fn(async (): Promise<IpcResult> => ({ ok: true })),
    setModel: vi.fn(
      async (input: {
        sessionId: string;
        model: SessionModelRef;
      }): Promise<IpcResult<{ session: SessionSummary }>> => {
        const current = sessions.find((session) => session.id === input.sessionId);
        if (!current) return { ok: false, error: '会话不存在' };
        const session = { ...current, model: input.model, updatedAt: 20 };
        sessions = sessions.map((item) => (item.id === session.id ? session : item));
        return { ok: true, session };
      }
    ),
    modelOptions: vi.fn(
      async (_input?: { workspaceId?: string }): Promise<IpcResult<ModelOptions>> => ({
        ok: true,
        providers: PROVIDERS,
      })
    ),
    setApprovalMode: vi.fn(
      async (input: {
        sessionId: string;
        mode: ApprovalMode;
      }): Promise<IpcResult<{ session: SessionSummary }>> => {
        const current = sessions.find((session) => session.id === input.sessionId);
        if (!current) return { ok: false, error: '会话不存在' };
        const session = { ...current, approvalMode: input.mode, updatedAt: 20 };
        sessions = sessions.map((item) => (item.id === session.id ? session : item));
        return { ok: true, session };
      }
    ),
    archive: vi.fn(async (sessionId: string): Promise<IpcResult<{ session: SessionSummary }>> => {
      const current = sessions.find((session) => session.id === sessionId);
      if (!current) return { ok: false, error: '会话不存在' };
      const session = { ...current, archivedAt: 50 };
      sessions = sessions.map((item) => (item.id === session.id ? session : item));
      return { ok: true, session };
    }),
    unarchive: vi.fn(async (sessionId: string): Promise<IpcResult<{ session: SessionSummary }>> => {
      const current = sessions.find((session) => session.id === sessionId);
      if (!current) return { ok: false, error: '会话不存在' };
      const { archivedAt: _archivedAt, ...rest } = current;
      const session = { ...rest, updatedAt: 60 };
      sessions = sessions.map((item) => (item.id === session.id ? session : item));
      return { ok: true, session };
    }),
    sweep: vi.fn(
      async (): Promise<IpcResult<{ archived: number; removed: number }>> => ({
        ok: true,
        archived: 0,
        removed: 0,
      })
    ),
    onEvent: on(listeners.event),
    onSessionsChanged: on(listeners.changed),
    onApprovalRequest: on(listeners.approval),
  } satisfies SessionsApi;
  return {
    api,
    setSessions(next: SessionSummary[]) {
      sessions = next;
    },
    emitEvent(seq: number, event: FynvraSessionEventBody, sessionId = 's1') {
      const envelope = { sessionId, event: { ...event, seq } } as SessionEventEnvelope;
      for (const listener of listeners.event) listener(envelope);
    },
    emitChanged(workspaceId = WS) {
      for (const listener of listeners.changed) listener(workspaceId);
    },
    emitApproval(request: ApprovalRequest) {
      for (const listener of listeners.approval) listener(request);
    },
    listenerCount: () => listeners.event.size + listeners.changed.size + listeners.approval.size,
  };
}

/** 同步调度：事件到达即归并 */
const immediate = (flush: () => void) => flush();

/** 等挂起的 promise 链走完 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(initial?: SessionSummary[]) {
  const fake = fakeApi(initial);
  const store = createSessionsStore(fake.api, { schedule: immediate, now: () => 100 });
  const disconnect = connectSessionsStore(store, fake.api);
  store.getState().setWorkspace(WS);
  await settle();
  return { ...fake, store, disconnect };
}

describe('createSessionsStore · 列表与选择', () => {
  it('setWorkspace 拉取该工作区的会话，按最近更新排序', async () => {
    const { store, api } = await setup([
      summary('old', { updatedAt: 1 }),
      summary('new', { updatedAt: 5 }),
      summary('other', { workspaceId: 'ws-2' }),
    ]);

    expect(api.list).toHaveBeenCalledWith(WS, { includeArchived: true });
    expect(store.getState().sessionsByWorkspace[WS]?.map((session) => session.id)).toEqual([
      'new',
      'old',
    ]);
  });

  it('createSession 用当前工作区与角色创建，加入列表并选中', async () => {
    const { store, api } = await setup([]);
    const result = await store.getState().createSession('orchestrator');
    await settle();

    expect(api.create).toHaveBeenCalledWith({ workspaceId: WS, roleId: 'orchestrator' });
    expect(result.ok).toBe(true);
    expect(store.getState().activeSessionId).toBe('s1');
    expect(store.getState().sessionsByWorkspace[WS]?.map((session) => session.id)).toEqual(['s1']);
    expect(api.history).toHaveBeenCalledWith('s1');
  });

  it('createSession 没选工作区时不调用 API', async () => {
    const fake = fakeApi();
    const store = createSessionsStore(fake.api, { schedule: immediate });
    const result = await store.getState().createSession('worker');

    expect(result.ok).toBe(false);
    expect(fake.api.create).not.toHaveBeenCalled();
  });

  it('selectSession 拉 history 并用权威投影替换；失败时给出提示', async () => {
    const { store, api } = await setup();
    const messages: ChatMessage[] = [
      {
        id: 'e1',
        sessionId: 's1',
        role: 'user',
        text: '历史',
        toolCalls: [],
        createdAt: 1,
        streaming: false,
      },
    ];
    api.history.mockResolvedValueOnce({ ok: true, messages });
    await store.getState().selectSession('s1');

    expect(store.getState().activeSessionId).toBe('s1');
    expect(selectMessagesOf('s1')(store.getState())).toEqual(messages);
    expect(store.getState().loadingHistory).toEqual({});

    api.history.mockResolvedValueOnce({ ok: false, error: 'jsonl 读不了' });
    await store.getState().selectSession('s1');
    expect(store.getState().notice).toContain('jsonl 读不了');
    expect(selectMessagesOf('s1')(store.getState())).toEqual(messages);
  });

  it('同一会话的 history 回包乱序时只认最后一次请求', async () => {
    const { store, api } = await setup();
    const first = deferred<IpcResult<{ messages: ChatMessage[] }>>();
    const second = deferred<IpcResult<{ messages: ChatMessage[] }>>();
    api.history.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const message = (text: string): ChatMessage => ({
      id: text,
      sessionId: 's1',
      role: 'user',
      text,
      toolCalls: [],
      createdAt: 1,
      streaming: false,
    });

    const a = store.getState().selectSession('s1');
    const b = store.getState().selectSession('s1');
    second.resolve({ ok: true, messages: [message('新')] });
    await b;
    first.resolve({ ok: true, messages: [message('旧')] });
    await a;

    expect(selectMessagesOf('s1')(store.getState()).map((item) => item.text)).toEqual(['新']);
  });

  it('后台加载其他展开分组及其推送不改变当前工作区或会话', async () => {
    const { store, emitChanged } = await setup([
      summary('s1'),
      summary('other', { workspaceId: 'ws-2' }),
    ]);
    await store.getState().selectSession('s1');
    await store.getState().loadSessions('ws-2');
    emitChanged('ws-2');
    await settle();

    expect(store.getState().sessionsByWorkspace['ws-2']?.[0]?.id).toBe('other');
    expect(store.getState()).toMatchObject({ workspaceId: WS, activeSessionId: 's1' });
  });

  it('跨项目选择同步更新两个选中字段，迟到的列表与 history 不抢回选择', async () => {
    const fake = fakeApi([summary('s1'), summary('other', { workspaceId: 'ws-2' })]);
    const onSelectSession = vi.fn((workspaceId: string) => {
      // 侧栏同步回同一个工作区时，不能清掉刚选的会话
      store.getState().setWorkspace(workspaceId);
    });
    const store = createSessionsStore(fake.api, { onSelectSession });
    store.getState().setWorkspace(WS);
    await store.getState().loadSessions('ws-2');
    await settle();
    const slowList = deferred<Awaited<ReturnType<typeof fake.api.list>>>();
    const slowHistory = deferred<IpcResult<{ messages: ChatMessage[] }>>();
    fake.api.list.mockReturnValueOnce(slowList.promise);
    fake.api.history.mockReturnValueOnce(slowHistory.promise);

    const selectingOther = store.getState().selectSession('other');
    expect(store.getState()).toMatchObject({ workspaceId: 'ws-2', activeSessionId: 'other' });
    expect(onSelectSession).toHaveBeenLastCalledWith('ws-2');
    await store.getState().selectSession('s1');
    slowList.resolve({ ok: true, sessions: [summary('other', { workspaceId: 'ws-2' })] });
    slowHistory.resolve({ ok: false, error: '旧项目读取失败' });
    await selectingOther;
    await settle();

    expect(store.getState()).toMatchObject({
      workspaceId: WS,
      activeSessionId: 's1',
      notice: null,
    });
    expect(onSelectSession.mock.calls).toEqual([['ws-2'], [WS]]);
  });

  it('非当前分组新建使用该项目及其模型，并同步选中新会话所在项目', async () => {
    const fake = fakeApi([summary('s1')]);
    const onSelectSession = vi.fn();
    const store = createSessionsStore(fake.api, { onSelectSession });
    store.getState().setWorkspace(WS);
    const result = await store.getState().createSession('worker', GPT, 'ws-2');
    await settle();

    expect(result.ok).toBe(true);
    expect(fake.api.create).toHaveBeenCalledWith({
      workspaceId: 'ws-2',
      roleId: 'worker',
      model: GPT,
    });
    expect(store.getState()).toMatchObject({ workspaceId: 'ws-2', activeSessionId: 's2' });
    expect(store.getState().lastModelByWorkspace).toEqual({ 'ws-2': GPT });
    expect(onSelectSession).toHaveBeenLastCalledWith('ws-2');
  });

  it('创建在途时用户切走又切回，晚到的新会话保留在目标列表但不抢回选中', async () => {
    const { store, api, setSessions } = await setup([summary('s1')]);
    await store.getState().selectSession('s1');
    const answer = deferred<Awaited<ReturnType<typeof api.create>>>();
    api.create.mockReturnValueOnce(answer.promise);
    const creating = store.getState().createSession('worker', GPT, 'ws-2');
    store.getState().setWorkspace('ws-3');
    await store.getState().selectSession('s1');
    const created = summary('new', { workspaceId: 'ws-2', model: GPT });
    setSessions([summary('s1'), created]);
    answer.resolve({ ok: true, session: created });
    await creating;
    await settle();

    expect(store.getState()).toMatchObject({ workspaceId: WS, activeSessionId: 's1' });
    expect(store.getState().sessionsByWorkspace['ws-2']).toEqual([created]);
    expect(api.history).not.toHaveBeenCalledWith('new');
  });

  it('非当前分组归档、恢复与删除只修改该项目的列表', async () => {
    const { store } = await setup([summary('s1'), summary('other', { workspaceId: 'ws-2' })]);
    await store.getState().selectSession('s1');
    await store.getState().loadSessions('ws-2');
    await store.getState().archiveSession('other');
    expect(selectArchivedSessionsOf('ws-2')(store.getState()).map((item) => item.id)).toEqual([
      'other',
    ]);
    await store.getState().unarchiveSession('other');
    expect(selectSessionsOf('ws-2')(store.getState()).map((item) => item.id)).toEqual(['other']);
    await store.getState().removeSession('other');
    expect(selectSessionsOf('ws-2')(store.getState())).toEqual([]);
    expect(store.getState()).toMatchObject({ workspaceId: WS, activeSessionId: 's1' });
  });

  it('切换工作区时，不属于它的选中会话被清空', async () => {
    const { store } = await setup();
    await store.getState().selectSession('s1');
    store.getState().setWorkspace('ws-2');

    expect(store.getState().activeSessionId).toBeNull();
    expect(store.getState().workspaceId).toBe('ws-2');
  });
});

describe('createSessionsStore · 归档', () => {
  const ids = (sessions: SessionSummary[]) => sessions.map((session) => session.id);

  it('列表连同归档的会话一起拉，分进两份列表：会话列表不含归档的，归档的按归档时间倒序', async () => {
    const { store } = await setup([
      summary('active-old', { updatedAt: 1 }),
      summary('active-new', { updatedAt: 9 }),
      summary('archived-early', { updatedAt: 8, archivedAt: 20 }),
      summary('archived-late', { updatedAt: 2, archivedAt: 30 }),
    ]);
    const state = store.getState();
    // sessionsByWorkspace 的含义不变（侧栏的会话），读它的地方（上一个 / 下一个会话等）不会碰到归档的
    expect(ids(state.sessionsByWorkspace[WS] ?? [])).toEqual(['active-new', 'active-old']);
    expect(ids(selectSessionsOf(WS)(state))).toEqual(['active-new', 'active-old']);
    expect(ids(selectArchivedSessionsOf(WS)(state))).toEqual(['archived-late', 'archived-early']);
    expect(selectArchivedSessionsOf('ws-other')(state)).toEqual([]);
    expect(findSession(state, 'archived-early')?.archivedAt).toBe(20);
  });

  it('选中的会话被 Main 归档（闲置扫描）后照常开着；被删除才取消选中', async () => {
    const { store, setSessions, emitChanged } = await setup([summary('s1'), summary('s2')]);
    await store.getState().selectSession('s1');
    setSessions([summary('s1', { archivedAt: 40 }), summary('s2')]);
    emitChanged();
    await settle();
    expect(store.getState().activeSessionId).toBe('s1');
    expect(ids(selectArchivedSessionsOf(WS)(store.getState()))).toEqual(['s1']);
    setSessions([summary('s2')]);
    emitChanged();
    await settle();
    expect(store.getState().activeSessionId).toBeNull();
  });

  it('打开归档的会话也能换审批档位，留在已归档里', async () => {
    const { store, api } = await setup([summary('s1', { archivedAt: 30 })]);
    expect(await store.getState().setApprovalMode('s1', 'full')).toMatchObject({ ok: true });
    expect(api.setApprovalMode).toHaveBeenCalledWith({ sessionId: 's1', mode: 'full' });
    expect(selectArchivedSessionsOf(WS)(store.getState())[0]?.approvalMode).toBe('full');
    expect(selectSessionsOf(WS)(store.getState())).toEqual([]);
  });

  it('archiveSession：先在列表里标上，回包后以 Main 的归档时间为准', async () => {
    const { store, api } = await setup([summary('s1'), summary('s2')]);
    const pending = store.getState().archiveSession('s1');
    expect(ids(selectArchivedSessionsOf(WS)(store.getState()))).toEqual(['s1']);
    expect(await pending).toMatchObject({ ok: true });
    expect(api.archive).toHaveBeenCalledWith('s1');
    expect(findSession(store.getState(), 's1')?.archivedAt).toBe(50);
    expect(ids(selectSessionsOf(WS)(store.getState()))).toEqual(['s2']);
  });

  it('archiveSession 失败：换回原样、提示原因并重拉列表', async () => {
    const { store, api } = await setup([summary('s1')]);
    api.archive.mockResolvedValueOnce({ ok: false, error: '会话正在运行，结束后再归档' });
    api.list.mockClear();
    expect(await store.getState().archiveSession('s1')).toMatchObject({ ok: false });
    expect(findSession(store.getState(), 's1')).not.toHaveProperty('archivedAt');
    expect(store.getState().notice).toBe('归档失败：会话正在运行，结束后再归档');
    expect(api.list).toHaveBeenCalledWith(WS, { includeArchived: true });
  });

  it('运行中或消息在途的会话不归档，不调用 API', async () => {
    const { store, api } = await setup([summary('s1', { status: 'running' }), summary('s2')]);
    expect(await store.getState().archiveSession('s1')).toEqual({
      ok: false,
      error: '会话正在运行，结束后再归档',
    });
    store.getState().selectSession('s2');
    api.prompt.mockReturnValueOnce(new Promise(() => {}));
    void store.getState().send('hi');
    expect(await store.getState().archiveSession('s2')).toMatchObject({ ok: false });
    expect(api.archive).not.toHaveBeenCalled();
  });

  it('unarchiveSession：清掉归档，取 Main 的更新时间，回到列表顶部', async () => {
    const { store, api } = await setup([
      summary('a', { updatedAt: 9 }),
      summary('s1', { updatedAt: 1, archivedAt: 30 }),
    ]);
    expect(await store.getState().unarchiveSession('s1')).toMatchObject({ ok: true });
    expect(api.unarchive).toHaveBeenCalledWith('s1');
    expect(ids(selectSessionsOf(WS)(store.getState()))).toEqual(['s1', 'a']);
    expect(selectArchivedSessionsOf(WS)(store.getState())).toEqual([]);
  });

  it('unarchiveSession 失败：留在已归档里并提示', async () => {
    const { store, api } = await setup([summary('s1', { archivedAt: 30 })]);
    api.unarchive.mockResolvedValueOnce({ ok: false, error: '会话不存在' });
    expect(await store.getState().unarchiveSession('s1')).toMatchObject({ ok: false });
    expect(findSession(store.getState(), 's1')?.archivedAt).toBe(30);
    expect(store.getState().notice).toBe('恢复失败：会话不存在');
  });
});

describe('createSessionsStore · removeSession', () => {
  const SHOT: ChatImage = { data: 'iVBORw0KGgo=', mimeType: 'image/png' };
  const messages: ChatMessage[] = [
    {
      id: 'entry-1',
      sessionId: 's1',
      role: 'user',
      text: 'history',
      toolCalls: [],
      createdAt: 1,
      streaming: false,
    },
  ];

  async function withCachedState(archivedAt?: number) {
    const env = await setup([
      summary('s1', archivedAt === undefined ? {} : { archivedAt }),
      summary('s2'),
    ]);
    const { store, api } = env;
    api.history.mockResolvedValueOnce({ ok: true, messages });
    await store.getState().selectSession('s1');
    store.getState().setDraft('s1', 'unfinished');
    store.getState().attachImages('s1', [SHOT]);
    store.setState({
      queuedBySession: { s1: [{ id: 'queued-1', text: 'later', images: [SHOT] }] },
      pendingApprovals: { s1: [] },
    });
    return env;
  }

  it.each([undefined, 50])(
    'optimistically removes an active or archived session and clears its cached state (archivedAt=%s)',
    async (archivedAt) => {
      const { store, api } = await withCachedState(archivedAt);
      const answer = deferred<IpcResult>();
      api.remove.mockReturnValueOnce(answer.promise);
      store.getState().openModelPicker('s1');
      store.getState().setDraft('s2', 'keep this');

      const removing = store.getState().removeSession('s1');
      expect(findSession(store.getState(), 's1')).toBeUndefined();
      expect(store.getState()).toMatchObject({
        drafts: { s2: 'keep this' },
        draftImages: {},
        queuedBySession: {},
        pendingApprovals: {},
        modelPickerFor: null,
        activeSessionId: 's2',
      });
      expect(store.getState().messagesBySession.s1).toBeUndefined();
      expect(store.getState().runtimeBySession.s1).toBeUndefined();
      expect(store.getState().loadingHistory.s1).toBeUndefined();
      expect(api.remove).toHaveBeenCalledExactlyOnceWith('s1');
      answer.resolve({ ok: true });
      expect(await removing).toEqual({ ok: true });
      expect(findSession(store.getState(), 's1')).toBeUndefined();
    }
  );

  it.each(['running', 'waiting-approval'] as const)(
    'refuses busy sessions, including archived sessions (%s)',
    async (status) => {
      const { store, api } = await setup([
        summary('s1', { status }),
        summary('s2', { status, archivedAt: 50 }),
      ]);
      for (const id of ['s1', 's2']) {
        expect(await store.getState().removeSession(id)).toEqual({
          ok: false,
          error: '会话正在运行，结束后再删除',
        });
        expect(findSession(store.getState(), id)).toBeDefined();
      }
      expect(api.remove).not.toHaveBeenCalled();
    }
  );

  it('refuses a prompt still in flight even if the session has settled', async () => {
    const { store, api, emitEvent } = await setup();
    await store.getState().selectSession('s1');
    const answer = deferred<IpcResult>();
    api.prompt.mockReturnValueOnce(answer.promise);
    const sending = store.getState().send('hello');
    emitEvent(1, { type: 'agent_settled', aborted: false });
    expect(selectStatusOf('s1')(store.getState())).toBe('idle');

    expect(await store.getState().removeSession('s1')).toMatchObject({ ok: false });
    expect(api.remove).not.toHaveBeenCalled();
    answer.resolve({ ok: true });
    await sending;
  });

  it('checks buffered events before deciding whether the session is busy', async () => {
    const { api } = fakeApi();
    const store = createSessionsStore(api, { schedule: () => {} });
    await store.getState().loadSessions(WS);
    store.getState().receiveEvent({
      sessionId: 's1',
      event: { seq: 1, type: 'text_delta', delta: 'working' },
    });
    expect(await store.getState().removeSession('s1')).toMatchObject({ ok: false });
    expect(api.remove).not.toHaveBeenCalled();
  });

  it.each([undefined, 50])(
    'restores the session, drafts, images, queue, timeline and selection after failure (archivedAt=%s)',
    async (archivedAt) => {
      const { store, api } = await withCachedState(archivedAt);
      const before = store.getState();
      const answer = deferred<IpcResult>();
      api.remove.mockReturnValueOnce(answer.promise);
      const removing = store.getState().removeSession('s1');
      store.getState().setDraft('s2', 'new draft');
      answer.resolve({ ok: false, error: 'disk unavailable' });

      expect(await removing).toEqual({ ok: false, error: 'disk unavailable' });
      const state = store.getState();
      expect(findSession(state, 's1')).toEqual(findSession(before, 's1'));
      expect(state.activeSessionId).toBe('s1');
      expect(state.drafts).toEqual({ s1: 'unfinished', s2: 'new draft' });
      expect(state.draftImages.s1).toEqual(before.draftImages.s1);
      expect(state.queuedBySession.s1).toEqual(before.queuedBySession.s1);
      expect(state.messagesBySession.s1).toEqual(before.messagesBySession.s1);
      expect(state.runtimeBySession.s1).toEqual(before.runtimeBySession.s1);
      expect(state.pendingApprovals.s1).toEqual(before.pendingApprovals.s1);
      expect(state.notice).toBe('删除会话失败：disk unavailable');
      // A failed deletion can be retried.
      expect(await state.removeSession('s1')).toEqual({ ok: true });
    }
  );

  it('handles thrown errors and preserves a subsequent user selection on rollback', async () => {
    const { store, api } = await setup([summary('s1'), summary('s2'), summary('s3')]);
    await store.getState().selectSession('s1');
    api.remove.mockRejectedValueOnce(new Error('IPC disconnected'));
    const removing = store.getState().removeSession('s1');
    await store.getState().selectSession('s3');
    expect(await removing).toEqual({ ok: false, error: 'IPC disconnected' });
    expect(findSession(store.getState(), 's1')).toBeDefined();
    expect(store.getState().activeSessionId).toBe('s3');
    expect(store.getState().notice).toContain('IPC disconnected');
  });

  it.each([
    { others: [summary('s2'), summary('archived', { archivedAt: 50 })], next: 's2' },
    { others: [summary('archived', { archivedAt: 50 })], next: 'archived' },
    { others: [], next: null },
  ])('selects $next after deleting the active session', async ({ others, next }) => {
    const { store, api } = await setup([summary('s1'), ...others]);
    await store.getState().selectSession('s1');
    api.history.mockClear();
    await store.getState().removeSession('s1');
    expect(store.getState().activeSessionId).toBe(next);
    if (next) expect(api.history).toHaveBeenCalledExactlyOnceWith(next);
    else expect(api.history).not.toHaveBeenCalled();
  });

  it('keeps the active session when removing another and refuses unknown ids', async () => {
    const { store, api } = await setup([summary('s1'), summary('s2')]);
    await store.getState().selectSession('s2');
    await store.getState().removeSession('s1');
    expect(store.getState().activeSessionId).toBe('s2');
    expect(await store.getState().removeSession('missing')).toEqual({
      ok: false,
      error: '会话不存在',
    });
    expect(api.remove).toHaveBeenCalledTimes(1);
  });

  it('ignores late history, list responses and events during and after deletion', async () => {
    const { store, api, emitEvent, emitApproval } = await setup();
    const history = deferred<IpcResult<{ messages: ChatMessage[] }>>();
    const list = deferred<{ ok: true; sessions: SessionSummary[] }>();
    const answer = deferred<IpcResult>();
    api.history.mockReturnValueOnce(history.promise);
    api.remove.mockReturnValueOnce(answer.promise);
    const selecting = store.getState().selectSession('s1');
    const removing = store.getState().removeSession('s1');

    // Refreshing while Main has not removed the record must not undo the optimistic removal.
    await store.getState().loadSessions(WS);
    expect(findSession(store.getState(), 's1')).toBeUndefined();
    expect(store.getState().loadingHistory).toEqual({});
    api.list.mockReturnValueOnce(list.promise);
    const loading = store.getState().loadSessions(WS);
    answer.resolve({ ok: true });
    await removing;
    list.resolve({ ok: true, sessions: [summary('s1')] });
    history.resolve({ ok: true, messages });
    await Promise.all([loading, selecting]);
    emitEvent(1, { type: 'text_delta', delta: 'late' });
    emitApproval({
      id: 'req-late',
      sessionId: 's1',
      kind: 'command',
      title: 'bash',
      detail: 'echo late',
      expiresAt: 0,
    });
    await store.getState().selectSession('s1');
    expect(findSession(store.getState(), 's1')).toBeUndefined();
    expect(store.getState()).toMatchObject({
      activeSessionId: null,
      messagesBySession: {},
      runtimeBySession: {},
      pendingApprovals: {},
      loadingHistory: {},
      notice: null,
    });
  });
});

describe('createSessionsStore · send', () => {
  it('拒绝空文本与纯空白，不调用 prompt', async () => {
    const { store, api } = await setup();
    await store.getState().selectSession('s1');

    expect(await store.getState().send('')).toBe(false);
    expect(await store.getState().send('  \n\t ')).toBe(false);
    expect(api.prompt).not.toHaveBeenCalled();
    expect(selectMessagesOf('s1')(store.getState())).toEqual([]);
  });

  it('没有选中会话时不发送', async () => {
    const { store, api } = await setup();
    expect(await store.getState().send('hi')).toBe(false);
    expect(api.prompt).not.toHaveBeenCalled();
  });

  it('发送：乐观回显、清空草稿、置 running，prompt 只带 sessionId 与文本', async () => {
    const { store, api } = await setup();
    await store.getState().selectSession('s1');
    store.getState().setDraft('s1', '你好');

    expect(await store.getState().send('\n你好\n')).toBe(true);
    expect(api.prompt).toHaveBeenCalledWith({ sessionId: 's1', text: '你好' });
    expect(selectMessagesOf('s1')(store.getState())).toEqual([
      expect.objectContaining({ role: 'user', text: '你好', optimistic: true }),
    ]);
    expect(store.getState().drafts.s1).toBeUndefined();
    expect(selectStatusOf('s1')(store.getState())).toBe('running');
  });

  it('queues instead of sending while a prompt is in flight or the session is running', async () => {
    const { store, api, emitEvent } = await setup();
    await store.getState().selectSession('s1');
    const pending = deferred<IpcResult>();
    api.prompt.mockReturnValueOnce(pending.promise);

    const first = store.getState().send('first');
    store.getState().setDraft('s1', 'second');
    expect(await store.getState().send('second')).toBe(true);
    expect(store.getState().drafts.s1).toBeUndefined();
    pending.resolve({ ok: true });
    expect(await first).toBe(true);

    // prompt returned but the session is still running (the agent has not settled)
    emitEvent(1, { type: 'message_end', role: 'user', text: 'first' });
    emitEvent(2, { type: 'text_delta', delta: '…' });
    expect(await store.getState().send('third')).toBe(true);
    expect(api.prompt).toHaveBeenCalledTimes(1);
    expect(selectQueueOf('s1')(store.getState()).map((item) => item.text)).toEqual([
      'second',
      'third',
    ]);
    // queued messages are not echoed in the timeline
    const users = selectMessagesOf('s1')(store.getState()).filter((m) => m.role === 'user');
    expect(users.map((message) => message.text)).toEqual(['first']);
  });

  it('prompt 失败：撤回回显、恢复草稿与状态、记录错误', async () => {
    const { store, api } = await setup();
    await store.getState().selectSession('s1');
    api.prompt.mockResolvedValueOnce({ ok: false, error: '没有可用的模型' });

    expect(await store.getState().send('帮我看看')).toBe(false);
    expect(selectMessagesOf('s1')(store.getState())).toEqual([]);
    expect(store.getState().drafts.s1).toBe('帮我看看');
    expect(selectStatusOf('s1')(store.getState())).toBe('idle');
    expect(store.getState().runtimeBySession.s1?.error).toBe('没有可用的模型');
  });

  it('prompt 抛异常也按失败处理', async () => {
    const { store, api } = await setup();
    await store.getState().selectSession('s1');
    api.prompt.mockRejectedValueOnce(new Error('IPC 断开'));

    expect(await store.getState().send('hi')).toBe(false);
    expect(store.getState().runtimeBySession.s1?.error).toBe('IPC 断开');
  });

  it('草稿按会话保存，切换会话后保留', async () => {
    const { store } = await setup([summary('s1'), summary('s2')]);
    await store.getState().selectSession('s1');
    store.getState().setDraft('s1', '写了一半');
    await store.getState().selectSession('s2');
    store.getState().setDraft('s2', '另一个');
    await store.getState().selectSession('s1');

    expect(store.getState().drafts).toEqual({ s1: '写了一半', s2: '另一个' });
    store.getState().setDraft('s1', '');
    expect(store.getState().drafts).toEqual({ s2: '另一个' });
  });
});

describe('createSessionsStore · setDraftImages', () => {
  const SHOT: ChatImage = { data: 'iVBORw0KGgo=', mimeType: 'image/png' };
  const PHOTO: ChatImage = { data: '/9j/4AAQ', mimeType: 'image/jpeg' };

  it('replaces images exactly for one session, preserving other drafts', () => {
    const store = createSessionsStore(fakeApi().api);
    const { setDraft, setDraftImages } = store.getState();
    setDraft('s1', 'unfinished');
    setDraftImages('s1', [SHOT]);
    setDraftImages('s2', [PHOTO]);
    const before = store.getState();

    setDraftImages('s1', [PHOTO, SHOT]);

    expect(selectDraftImagesOf('s1')(store.getState())).toEqual([PHOTO, SHOT]);
    expect(store.getState().draftImages.s2).toBe(before.draftImages.s2);
    expect(store.getState().drafts).toBe(before.drafts);
    expect(before.draftImages.s1).toEqual([SHOT]);
  });

  it('clears the session key for an empty array, including an already empty draft', () => {
    const store = createSessionsStore(fakeApi().api);
    const { setDraftImages } = store.getState();
    setDraftImages('s1', [SHOT]);
    setDraftImages('s2', [PHOTO]);

    setDraftImages('s1', []);
    setDraftImages('missing', []);

    expect(store.getState().draftImages).toEqual({ s2: [PHOTO] });
    expect(selectDraftImagesOf('s1')(store.getState())).toEqual([]);
  });

  it('restores all images without applying attachment limits', () => {
    const store = createSessionsStore(fakeApi().api);
    const images = Array.from({ length: 12 }, () => SHOT);
    store.getState().setDraftImages('s1', images);

    expect(selectDraftImagesOf('s1')(store.getState())).toEqual(images);
  });
});

describe('createSessionsStore · 粘贴的图片', () => {
  const SHOT: ChatImage = { data: 'iVBORw0KGgo=', mimeType: 'image/png' };
  const PHOTO: ChatImage = { data: '/9j/4AAQ', mimeType: 'image/jpeg' };
  const MiB = 1024 * 1024;
  /** 解码后正好 bytes 字节的图片（内容无关紧要，只看 base64 的长度与末尾的 =） */
  const sized = (bytes: number): ChatImage => {
    const groups = Math.ceil(bytes / 3);
    const padding = groups * 3 - bytes;
    return { data: 'A'.repeat(groups * 4 - padding) + '='.repeat(padding), mimeType: 'image/png' };
  };
  const RESIZED =
    '[Image: original 3773x1017, displayed at 2000x539. Multiply coordinates by 1.89 to map to original image.]';

  it('草稿图片按会话保存，切换会话不丢；可以逐张移除', async () => {
    const { store } = await setup([summary('s1'), summary('s2')]);
    const state = () => store.getState();
    await state().selectSession('s1');
    expect(state().attachImages('s1', [SHOT, PHOTO])).toBeUndefined();
    await state().selectSession('s2');
    expect(state().attachImages('s2', [PHOTO])).toBeUndefined();
    await state().selectSession('s1');

    expect(selectDraftImagesOf('s1')(state())).toEqual([SHOT, PHOTO]);
    expect(selectDraftImagesOf('s2')(state())).toEqual([PHOTO]);
    expect(selectDraftImagesOf('s3')(state())).toEqual([]);
    state().removeDraftImage('s1', 0);
    expect(selectDraftImagesOf('s1')(state())).toEqual([PHOTO]);
    state().removeDraftImage('s1', 0);
    expect(state().draftImages).toEqual({ s2: [PHOTO] });
  });

  it('超过张数、单张或合计大小上限的不加并给出原因，放得下的照加', async () => {
    const { store } = await setup();
    const state = () => store.getState();

    expect(
      state().attachImages(
        's1',
        Array.from({ length: 12 }, () => SHOT)
      )
    ).toBe('count');
    expect(selectDraftImagesOf('s1')(state())).toHaveLength(10);
    expect(state().attachImages('s1', [PHOTO])).toBe('count');
    expect(selectDraftImagesOf('s1')(state())).toHaveLength(10);

    expect(state().attachImages('s2', [sized(20 * MiB + 1), SHOT])).toBe('size');
    expect(selectDraftImagesOf('s2')(state())).toEqual([SHOT]);

    const big = [sized(20 * MiB), sized(20 * MiB)];
    expect(state().attachImages('s3', big)).toBeUndefined();
    expect(state().attachImages('s3', [sized(10 * MiB + 1)])).toBe('size');
    // 合计正好 50 MiB 还放得下，再多 1 字节就不行（SHOT 解码后 8 字节）
    expect(state().attachImages('s3', [sized(10 * MiB - 7), SHOT])).toBe('size');
    expect(selectDraftImagesOf('s3')(state()).map((image) => image.data.length)).toEqual([
      ...big.map((image) => image.data.length),
      sized(10 * MiB - 7).data.length,
    ]);
    expect(state().attachImages('s5', [...big, sized(10 * MiB)])).toBeUndefined();

    // 读出来的不是可用的图片（空文件、不是 base64、格式不在白名单里）
    expect(
      state().attachImages('s4', [
        { data: '', mimeType: 'image/png' },
        { data: 'not base64!', mimeType: 'image/png' },
        { data: SHOT.data, mimeType: 'image/bmp' as ChatImage['mimeType'] },
      ])
    ).toBe('invalid');
    expect(state().draftImages.s4).toBeUndefined();
  });

  it('只有图片也能发：回显带图片，prompt 带上图片，文字与图片草稿都清空', async () => {
    const { store, api } = await setup();
    const state = () => store.getState();
    await state().selectSession('s1');
    state().attachImages('s1', [SHOT, PHOTO]);

    expect(await state().send('')).toBe(true);
    expect(api.prompt).toHaveBeenCalledWith({ sessionId: 's1', text: '', images: [SHOT, PHOTO] });
    expect(selectMessagesOf('s1')(state())).toEqual([
      expect.objectContaining({ role: 'user', text: '', images: [SHOT, PHOTO], optimistic: true }),
    ]);
    expect(state().draftImages).toEqual({});
    expect(selectStatusOf('s1')(state())).toBe('running');
  });

  it('文字加图片一起发；没有图片时 prompt 不带 images', async () => {
    const { store, api, emitEvent } = await setup();
    const state = () => store.getState();
    await state().selectSession('s1');
    state().setDraft('s1', '哪里不对？');
    state().attachImages('s1', [SHOT]);
    expect(await state().send('哪里不对？\n')).toBe(true);
    expect(api.prompt).toHaveBeenLastCalledWith({
      sessionId: 's1',
      text: '哪里不对？',
      images: [SHOT],
    });
    expect(state().drafts.s1).toBeUndefined();

    emitEvent(1, { type: 'message_end', role: 'user', text: `哪里不对？\n\n${RESIZED}` });
    emitEvent(2, { type: 'agent_settled', aborted: false });
    expect(selectMessagesOf('s1')(state())).toEqual([
      expect.objectContaining({ role: 'user', text: '哪里不对？', images: [SHOT] }),
    ]);
    expect(selectMessagesOf('s1')(state())[0]?.optimistic).toBeUndefined();

    expect(await state().send('只有文字')).toBe(true);
    expect(api.prompt.mock.calls.at(-1)?.[0]).toEqual({ sessionId: 's1', text: '只有文字' });
  });

  it('没有文字也没有图片时不发', async () => {
    const { store, api } = await setup();
    await store.getState().selectSession('s1');
    expect(await store.getState().send(' \n')).toBe(false);
    expect(api.prompt).not.toHaveBeenCalled();
  });

  it('发送失败：文字与图片都放回草稿', async () => {
    const { store, api } = await setup();
    const state = () => store.getState();
    await state().selectSession('s1');
    state().attachImages('s1', [SHOT]);
    api.prompt.mockResolvedValueOnce({ ok: false, error: '没有可用的模型' });

    expect(await state().send('看看这张')).toBe(false);
    expect(selectMessagesOf('s1')(state())).toEqual([]);
    expect(state().drafts.s1).toBe('看看这张');
    expect(selectDraftImagesOf('s1')(state())).toEqual([SHOT]);
    expect(state().runtimeBySession.s1?.error).toBe('没有可用的模型');

    // 只有图片：没有文字可放回，只放回图片
    api.prompt.mockResolvedValueOnce({ ok: false, error: '没有可用的模型' });
    state().setDraft('s1', '');
    expect(await state().send('')).toBe(false);
    expect(state().drafts).toEqual({});
    expect(selectDraftImagesOf('s1')(state())).toEqual([SHOT]);
  });

  it('发送失败时用户已经开始写新草稿：新的文字、新的图片都不被覆盖', async () => {
    const { store, api } = await setup();
    const state = () => store.getState();
    await state().selectSession('s1');
    state().attachImages('s1', [SHOT]);
    const answer = deferred<IpcResult>();
    api.prompt.mockReturnValueOnce(answer.promise);

    const sending = state().send('第一条');
    state().setDraft('s1', '新写的');
    state().attachImages('s1', [PHOTO]);
    answer.resolve({ ok: false, error: '没有可用的模型' });
    expect(await sending).toBe(false);

    expect(state().drafts.s1).toBe('新写的');
    expect(selectDraftImagesOf('s1')(state())).toEqual([PHOTO]);
  });
});

describe('createSessionsStore · 推送与审批', () => {
  it('onEvent 经 reducer 归并；onSessionsChanged 重新拉该工作区的列表', async () => {
    const { store, api, emitEvent, emitChanged, setSessions } = await setup();
    emitEvent(1, { type: 'text_delta', delta: '你' });
    emitEvent(2, { type: 'text_delta', delta: '好' });
    expect(selectMessagesOf('s1')(store.getState())[0]?.text).toBe('你好');

    setSessions([summary('s1', { status: 'running', title: '新标题' })]);
    api.list.mockClear();
    emitChanged();
    emitChanged('ws-unrelated');
    await settle();

    expect(api.list).toHaveBeenCalledTimes(1);
    expect(store.getState().sessionsByWorkspace[WS]?.[0]?.title).toBe('新标题');
  });

  it('事件按调度攒批，一批只通知订阅者一次', async () => {
    const fake = fakeApi();
    const queued: Array<() => void> = [];
    const store = createSessionsStore(fake.api, { schedule: (flush) => queued.push(flush) });
    connectSessionsStore(store, fake.api);
    const listener = vi.fn();
    store.subscribe(listener);

    fake.emitEvent(1, { type: 'text_delta', delta: 'a' });
    fake.emitEvent(2, { type: 'text_delta', delta: 'b' });
    fake.emitEvent(3, { type: 'text_delta', delta: 'c' });
    expect(queued).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();

    queued[0]?.();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(selectMessagesOf('s1')(store.getState())[0]?.text).toBe('abc');
  });

  it('列表刷新以 Main 的状态为准，但不覆盖 prompt 在途会话的乐观 running', async () => {
    const { store, api, emitEvent, emitChanged } = await setup();
    await store.getState().selectSession('s1');
    emitEvent(1, { type: 'text_delta', delta: 'x' });
    expect(selectStatusOf('s1')(store.getState())).toBe('running');

    emitChanged();
    await settle();
    expect(selectStatusOf('s1')(store.getState())).toBe('idle');

    const pending = deferred<IpcResult>();
    api.prompt.mockReturnValueOnce(pending.promise);
    const sent = store.getState().send('hi');
    emitChanged();
    await settle();
    expect(selectStatusOf('s1')(store.getState())).toBe('running');
    pending.resolve({ ok: true });
    await sent;
  });

  it('列表里消失的选中会话被取消选中', async () => {
    const { store, emitChanged, setSessions } = await setup();
    await store.getState().selectSession('s1');
    setSessions([]);
    emitChanged();
    await settle();

    expect(store.getState().activeSessionId).toBeNull();
  });

  it('onApprovalRequest 入队；respondApproval 出队并转发决定', async () => {
    const { store, api, emitApproval } = await setup();
    const request: ApprovalRequest = {
      id: 'req-1',
      sessionId: 's1',
      kind: 'command',
      title: 'bash',
      detail: 'pnpm test',
      expiresAt: 0,
    };
    emitApproval(request);
    expect(store.getState().pendingApprovals.s1).toEqual([request]);
    expect(selectStatusOf('s1')(store.getState())).toBe('waiting-approval');

    await store.getState().respondApproval('req-1', 'allowSession');
    expect(api.respondApproval).toHaveBeenCalledWith({
      sessionId: 's1',
      requestId: 'req-1',
      decision: 'allowSession',
    });
    expect(store.getState().pendingApprovals.s1).toEqual([]);
    expect(selectStatusOf('s1')(store.getState())).toBe('running');
  });

  it('答复没送达且会话还在等待时重新入队，并提示', async () => {
    const { store, api, emitApproval } = await setup();
    const request: ApprovalRequest = {
      id: 'req-1',
      sessionId: 's1',
      kind: 'command',
      title: 'bash',
      detail: 'rm -rf dist',
      expiresAt: 0,
    };
    emitApproval(request);
    api.respondApproval.mockResolvedValueOnce({ ok: false, error: 'worker 不可用' });
    await store.getState().respondApproval('req-1', 'deny');

    expect(store.getState().pendingApprovals.s1).toEqual([request]);
    expect(store.getState().notice).toContain('worker 不可用');
  });

  it('abort 转发给选中的会话', async () => {
    const { store, api } = await setup();
    await store.getState().abort();
    expect(api.abort).not.toHaveBeenCalled();

    await store.getState().selectSession('s1');
    await store.getState().abort();
    expect(api.abort).toHaveBeenCalledWith('s1');
  });

  it('断开连接后不再接收推送', async () => {
    const { disconnect, listenerCount } = await setup();
    expect(listenerCount()).toBe(3);
    disconnect();
    expect(listenerCount()).toBe(0);
  });
});

describe('createSessionsStore · 模型选择', () => {
  it('setSessionModel 乐观更新：先换上新模型，成功后以 Main 的记录为准', async () => {
    const { store, api } = await setup([summary('s1', { model: OPUS })]);
    const answer = deferred<IpcResult<{ session: SessionSummary }>>();
    api.setModel.mockReturnValueOnce(answer.promise);

    const switching = store.getState().setSessionModel('s1', GPT);
    expect(api.setModel).toHaveBeenCalledWith({ sessionId: 's1', model: GPT });
    expect(store.getState().sessionsByWorkspace[WS]?.[0]?.model).toEqual(GPT);

    const fromMain = summary('s1', { model: GPT, updatedAt: 30 });
    answer.resolve({ ok: true, session: fromMain });
    expect(await switching).toEqual({ ok: true, session: fromMain });
    expect(store.getState().sessionsByWorkspace[WS]?.[0]).toEqual(fromMain);
    expect(store.getState().lastModelByWorkspace[WS]).toEqual(GPT);
  });

  it('setSessionModel 失败时回滚到原来的模型、提示原因，并按 Main 重新拉列表', async () => {
    const { store, api } = await setup([summary('s1', { model: OPUS })]);
    api.list.mockClear();
    api.setModel.mockResolvedValueOnce({ ok: false, error: '模型服务「OpenAI」已停用' });

    const result = await store.getState().setSessionModel('s1', GPT);
    expect(result).toEqual({ ok: false, error: '模型服务「OpenAI」已停用' });
    expect(store.getState().sessionsByWorkspace[WS]?.[0]?.model).toEqual(OPUS);
    expect(store.getState().notice).toBe('切换模型失败：模型服务「OpenAI」已停用');
    expect(api.list).toHaveBeenCalledWith(WS, { includeArchived: true });
    expect(store.getState().lastModelByWorkspace[WS]).toBeUndefined();
  });

  it('setSessionModel 在会话运行中或消息在途时不发请求', async () => {
    const { store, api, emitEvent } = await setup([summary('s1', { model: OPUS })]);
    await store.getState().selectSession('s1');
    const prompt = deferred<IpcResult>();
    api.prompt.mockReturnValueOnce(prompt.promise);
    const sending = store.getState().send('hello');

    const refused = { ok: false, error: expect.stringContaining('等本轮结束') };
    expect(await store.getState().setSessionModel('s1', GPT)).toEqual(refused);
    prompt.resolve({ ok: true });
    await sending;
    emitEvent(1, { type: 'message_end', role: 'user', text: 'hello' });
    expect(await store.getState().setSessionModel('s1', GPT)).toEqual(refused);

    expect(api.setModel).not.toHaveBeenCalled();
    expect(store.getState().sessionsByWorkspace[WS]?.[0]?.model).toEqual(OPUS);
  });

  it('切换在途时列表刷新不会把模型改回去', async () => {
    const { store, api, emitChanged } = await setup([summary('s1', { model: OPUS })]);
    const answer = deferred<IpcResult<{ session: SessionSummary }>>();
    api.setModel.mockReturnValueOnce(answer.promise);
    const switching = store.getState().setSessionModel('s1', GPT);

    // Main 还没回包：列表里仍是旧模型
    emitChanged();
    await settle();
    expect(store.getState().sessionsByWorkspace[WS]?.[0]?.model).toEqual(GPT);

    answer.resolve({ ok: true, session: summary('s1', { model: GPT, updatedAt: 30 }) });
    await switching;
    expect(store.getState().sessionsByWorkspace[WS]?.[0]?.model).toEqual(GPT);
  });

  it('loadModelOptions 读可选模型与该工作区上次用过的模型；失败时保留已有列表并记下原因', async () => {
    const { store, api } = await setup();
    api.modelOptions.mockResolvedValueOnce({ ok: true, providers: PROVIDERS, lastUsed: OPUS });
    await store.getState().loadModelOptions();
    expect(api.modelOptions).toHaveBeenLastCalledWith({ workspaceId: WS });
    expect(store.getState().modelProviders).toEqual(PROVIDERS);
    expect(store.getState().lastModelByWorkspace[WS]).toEqual(OPUS);

    api.modelOptions.mockResolvedValueOnce({ ok: false, error: 'agent worker 未就绪' });
    await store.getState().loadModelOptions();
    expect(store.getState().modelProviders).toEqual(PROVIDERS);
    expect(store.getState().modelOptionsError).toBe('agent worker 未就绪');
  });

  it('loadModelOptions 丢弃晚到的旧回包', async () => {
    const { store, api } = await setup();
    const slow = deferred<IpcResult<ModelOptions>>();
    api.modelOptions.mockReturnValueOnce(slow.promise);
    const first = store.getState().loadModelOptions();
    api.modelOptions.mockResolvedValueOnce({ ok: true, providers: [] });
    await store.getState().loadModelOptions();
    slow.resolve({ ok: true, providers: PROVIDERS });
    await first;
    expect(store.getState().modelProviders).toEqual([]);
  });

  it('不同项目的模型选项并发加载，各自保留记忆模型且不切换工作区', async () => {
    const { store, api } = await setup();
    const first = deferred<IpcResult<ModelOptions>>();
    api.modelOptions.mockReturnValueOnce(first.promise);
    const loading = store.getState().loadModelOptions(WS);
    api.modelOptions.mockResolvedValueOnce({ ok: true, providers: [], lastUsed: GPT });
    await store.getState().loadModelOptions('ws-2');
    first.resolve({ ok: true, providers: PROVIDERS, lastUsed: OPUS });
    await loading;

    expect(store.getState().lastModelByWorkspace).toEqual({ [WS]: OPUS, 'ws-2': GPT });
    expect(store.getState().modelProviders).toEqual([]);
    expect(store.getState().workspaceId).toBe(WS);
  });

  it('createSession 带上选的模型，并记作该工作区上次用过的模型', async () => {
    const { store, api } = await setup([]);
    api.create.mockImplementationOnce(async (input) => ({
      ok: true as const,
      session: summary('s9', { ...input, model: GPT }),
    }));
    const result = await store.getState().createSession('worker', GPT);
    expect(api.create).toHaveBeenCalledWith({ workspaceId: WS, roleId: 'worker', model: GPT });
    expect(result.ok).toBe(true);
    expect(store.getState().lastModelByWorkspace[WS]).toEqual(GPT);
  });

  it('setApprovalMode 乐观更新：先换上新档位，成功后以 Main 的记录为准', async () => {
    const { store, api } = await setup();
    const answer = deferred<IpcResult<{ session: SessionSummary }>>();
    api.setApprovalMode.mockReturnValueOnce(answer.promise);

    const switching = store.getState().setApprovalMode('s1', 'full');
    expect(api.setApprovalMode).toHaveBeenCalledWith({ sessionId: 's1', mode: 'full' });
    expect(store.getState().sessionsByWorkspace[WS]?.[0]?.approvalMode).toBe('full');

    answer.resolve({ ok: true, session: summary('s1', { approvalMode: 'full', updatedAt: 30 }) });
    expect(await switching).toMatchObject({ ok: true });
    expect(store.getState().sessionsByWorkspace[WS]?.[0]).toMatchObject({
      approvalMode: 'full',
      updatedAt: 30,
    });
    expect(store.getState().notice).toBeNull();
  });

  it('setApprovalMode 失败时回滚到原来的档位、提示原因，并按 Main 重新拉列表', async () => {
    const { store, api } = await setup([summary('s1', { approvalMode: 'supervised' })]);
    api.list.mockClear();
    api.setApprovalMode.mockResolvedValueOnce({ ok: false, error: '会话不存在' });

    const result = await store.getState().setApprovalMode('s1', 'full');
    expect(result).toEqual({ ok: false, error: '会话不存在' });
    expect(store.getState().sessionsByWorkspace[WS]?.[0]?.approvalMode).toBe('supervised');
    expect(store.getState().notice).toBe('切换审批档位失败：会话不存在');
    expect(api.list).toHaveBeenCalledWith(WS, { includeArchived: true });

    api.setApprovalMode.mockRejectedValueOnce(new Error('IPC 断开'));
    expect(await store.getState().setApprovalMode('s1', 'auto-edits')).toEqual({
      ok: false,
      error: 'IPC 断开',
    });
    expect(store.getState().sessionsByWorkspace[WS]?.[0]?.approvalMode).toBe('supervised');
  });

  it('setApprovalMode 运行中、等审批时也照样切（与换模型不同）', async () => {
    const { store, api, emitEvent, emitApproval } = await setup();
    await store.getState().selectSession('s1');
    await store.getState().send('long task');
    emitEvent(1, { type: 'message_end', role: 'user', text: 'long task' });
    expect(selectStatusOf('s1')(store.getState())).toBe('running');
    expect(await store.getState().setApprovalMode('s1', 'full')).toMatchObject({ ok: true });

    emitApproval({
      id: 'req-1',
      sessionId: 's1',
      kind: 'command',
      title: 'bash',
      detail: 'git push',
      expiresAt: 0,
    });
    expect(selectStatusOf('s1')(store.getState())).toBe('waiting-approval');
    expect(await store.getState().setApprovalMode('s1', 'supervised')).toMatchObject({ ok: true });
    expect(api.setApprovalMode.mock.calls).toEqual([
      [{ sessionId: 's1', mode: 'full' }],
      [{ sessionId: 's1', mode: 'supervised' }],
    ]);
  });

  it('切换审批档位在途时列表刷新不会把档位改回去；连着切只认最后一次回包', async () => {
    const { store, api, emitChanged } = await setup([
      summary('s1', { approvalMode: 'supervised' }),
    ]);
    const first = deferred<IpcResult<{ session: SessionSummary }>>();
    const second = deferred<IpcResult<{ session: SessionSummary }>>();
    api.setApprovalMode.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const toAutoEdits = store.getState().setApprovalMode('s1', 'auto-edits');
    const toFull = store.getState().setApprovalMode('s1', 'full');
    // Main 还没回包：列表里仍是旧档位
    emitChanged();
    await settle();
    expect(store.getState().sessionsByWorkspace[WS]?.[0]?.approvalMode).toBe('full');

    second.resolve({ ok: true, session: summary('s1', { approvalMode: 'full' }) });
    await toFull;
    // 先发的那次晚到且失败：不回滚、不提示，以最后一次为准
    first.resolve({ ok: false, error: '迟到的失败' });
    await toAutoEdits;
    expect(store.getState().sessionsByWorkspace[WS]?.[0]?.approvalMode).toBe('full');
    expect(store.getState().notice).toBeNull();
  });

  it('setApprovalMode 找不到会话时不发请求', async () => {
    const { store, api } = await setup();
    expect(await store.getState().setApprovalMode('ghost', 'full')).toEqual({
      ok: false,
      error: '会话不存在',
    });
    expect(api.setApprovalMode).not.toHaveBeenCalled();
  });

  it('输入框胶囊与状态栏共用一个模型选择器', async () => {
    const { store } = await setup();
    store.getState().openModelPicker('s1');
    expect(store.getState().modelPickerFor).toBe('s1');
    store.getState().closeModelPicker();
    expect(store.getState().modelPickerFor).toBeNull();
  });
});

describe('createSessionsStore · queue while running', () => {
  const SHOT: ChatImage = { data: 'iVBORw0KGgo=', mimeType: 'image/png' };

  /** s1 selected and running a first turn */
  async function running() {
    const env = await setup();
    await env.store.getState().selectSession('s1');
    await env.store.getState().send('first');
    env.emitEvent(1, { type: 'message_end', role: 'user', text: 'first' });
    return env;
  }

  const texts = (store: Awaited<ReturnType<typeof running>>['store']) =>
    selectQueueOf('s1')(store.getState()).map((item) => item.text);

  it('queues text with the draft images and clears the draft', async () => {
    const { store, api } = await running();
    store.getState().attachImages('s1', [SHOT]);
    expect(await store.getState().send('look at this')).toBe(true);
    expect(selectQueueOf('s1')(store.getState())).toEqual([
      expect.objectContaining({ text: 'look at this', images: [SHOT] }),
    ]);
    expect(store.getState().draftImages.s1).toBeUndefined();
    expect(api.prompt).toHaveBeenCalledTimes(1);
  });

  it('drains the queue in order, one prompt per settled turn', async () => {
    const { store, api, emitEvent } = await running();
    await store.getState().send('second');
    await store.getState().send('third');

    emitEvent(2, { type: 'agent_settled', aborted: false });
    await settle();
    expect(api.prompt).toHaveBeenCalledTimes(2);
    expect(api.prompt).toHaveBeenLastCalledWith({ sessionId: 's1', text: 'second' });
    expect(texts(store)).toEqual(['third']);
    expect(selectStatusOf('s1')(store.getState())).toBe('running');

    emitEvent(3, { type: 'message_end', role: 'user', text: 'second' });
    emitEvent(4, { type: 'agent_settled', aborted: false });
    await settle();
    expect(api.prompt).toHaveBeenCalledTimes(3);
    expect(api.prompt).toHaveBeenLastCalledWith({ sessionId: 's1', text: 'third' });
    expect(texts(store)).toEqual([]);
  });

  it('keeps the queue after a stop or an error; the next manual send resumes it', async () => {
    const { store, api, emitEvent } = await running();
    await store.getState().send('second');
    await store.getState().abort();
    emitEvent(2, { type: 'agent_settled', aborted: true });
    await settle();
    expect(api.prompt).toHaveBeenCalledTimes(1);
    expect(texts(store)).toEqual(['second']);

    await store.getState().send('manual');
    expect(api.prompt).toHaveBeenLastCalledWith({ sessionId: 's1', text: 'manual' });
    emitEvent(3, { type: 'error', source: 'host', message: 'boom' });
    emitEvent(4, { type: 'agent_settled', aborted: false });
    await settle();
    expect(selectStatusOf('s1')(store.getState())).toBe('error');
    expect(api.prompt).toHaveBeenCalledTimes(2);
    expect(texts(store)).toEqual(['second']);
  });

  it('removes a queued message', async () => {
    const { store } = await running();
    await store.getState().send('second');
    await store.getState().send('third');
    const [first] = selectQueueOf('s1')(store.getState());
    store.getState().removeQueued('s1', first?.id ?? '');
    expect(texts(store)).toEqual(['third']);
  });

  it('steers the most recent queued message (with its images), or a given one', async () => {
    const { store, api } = await running();
    await store.getState().send('second');
    store.getState().attachImages('s1', [SHOT]);
    await store.getState().send('third');

    expect(await store.getState().steer('s1')).toBe(true);
    expect(api.steer).toHaveBeenLastCalledWith({ sessionId: 's1', text: 'third', images: [SHOT] });
    expect(texts(store)).toEqual(['second']);

    const [second] = selectQueueOf('s1')(store.getState());
    expect(await store.getState().steer('s1', second?.id)).toBe(true);
    expect(api.steer).toHaveBeenLastCalledWith({ sessionId: 's1', text: 'second' });
    expect(texts(store)).toEqual([]);
    expect(api.prompt).toHaveBeenCalledTimes(1);
  });

  it('steers the draft when nothing is queued; nothing to send returns false', async () => {
    const { store, api } = await running();
    expect(await store.getState().steer('s1')).toBe(false);
    store.getState().setDraft('s1', 'also check docs');
    expect(await store.getState().steer('s1')).toBe(true);
    expect(api.steer).toHaveBeenCalledWith({ sessionId: 's1', text: 'also check docs' });
    expect(store.getState().drafts.s1).toBeUndefined();
  });

  it('puts a message back when steering fails', async () => {
    const { store, api } = await running();
    await store.getState().send('second');
    api.steer.mockResolvedValueOnce({ ok: false, error: 'gone' });
    expect(await store.getState().steer('s1')).toBe(false);
    expect(texts(store)).toEqual(['second']);
    expect(store.getState().notice).toContain('gone');
  });

  it('sends a queued message as a prompt when the session is idle', async () => {
    const { store, api, emitEvent } = await running();
    await store.getState().send('second');
    await store.getState().abort();
    emitEvent(2, { type: 'agent_settled', aborted: true });
    await settle();
    const [second] = selectQueueOf('s1')(store.getState());
    expect(await store.getState().steer('s1', second?.id)).toBe(true);
    expect(api.steer).not.toHaveBeenCalled();
    expect(api.prompt).toHaveBeenLastCalledWith({ sessionId: 's1', text: 'second' });
    expect(texts(store)).toEqual([]);
  });
});
