import type { ApprovalMode, FynvraSessionEventBody } from '@fynvra/core';
import type {
  ApprovalRequest,
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
import { selectMessagesOf, selectStatusOf } from './selectors';

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
    list: vi.fn(async (workspaceId: string) => ({
      ok: true as const,
      sessions: sessions.filter((session) => session.workspaceId === workspaceId),
    })),
    create: vi.fn(async (input: { workspaceId: string; roleId: string }) => {
      const session = summary(`s${sessions.length + 1}`, { ...input, createdAt: 9, updatedAt: 9 });
      sessions = [...sessions, session];
      return { ok: true as const, session };
    }),
    remove: vi.fn(async (): Promise<IpcResult> => ({ ok: true })),
    prompt: vi.fn(
      async (_input: { sessionId: string; text: string }): Promise<IpcResult> => ({
        ok: true,
      })
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

    expect(api.list).toHaveBeenCalledWith(WS);
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

  it('切换工作区时，不属于它的选中会话被清空', async () => {
    const { store } = await setup();
    await store.getState().selectSession('s1');
    store.getState().setWorkspace('ws-2');

    expect(store.getState().activeSessionId).toBeNull();
    expect(store.getState().workspaceId).toBe('ws-2');
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

  it('prompt 在途或会话 running 时不重复发送', async () => {
    const { store, api, emitEvent } = await setup();
    await store.getState().selectSession('s1');
    const pending = deferred<IpcResult>();
    api.prompt.mockReturnValueOnce(pending.promise);

    const first = store.getState().send('第一条');
    expect(await store.getState().send('第二条')).toBe(false);
    pending.resolve({ ok: true });
    expect(await first).toBe(true);

    // prompt 已返回，但会话仍在 running（agent 还没 settled）
    emitEvent(1, { type: 'message_end', role: 'user', text: '第一条' });
    emitEvent(2, { type: 'text_delta', delta: '…' });
    expect(await store.getState().send('第三条')).toBe(false);
    expect(api.prompt).toHaveBeenCalledTimes(1);

    emitEvent(3, { type: 'agent_settled', aborted: false });
    expect(await store.getState().send('第四条')).toBe(true);
    expect(api.prompt).toHaveBeenCalledTimes(2);
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
    expect(api.list).toHaveBeenCalledWith(WS);
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
    expect(api.list).toHaveBeenCalledWith(WS);

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
