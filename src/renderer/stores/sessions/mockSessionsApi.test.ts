import type { ChatImage, SessionEventEnvelope } from '@shared/types/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translate } from '../../i18n';
import { createMockSessionsApi } from '../../lib/api/sessions';
import { connectSessionsStore, createSessionsStore } from './createSessionsStore';
import { selectApprovalsOf, selectMessagesOf, selectQueueOf, selectStatusOf } from './selectors';

// store + 内存 mock 的端到端：pnpm dev 的 mock 模式走的就是这条路

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function setup(roleId: string) {
  const api = createMockSessionsApi({ stepMs: 10 });
  const store = createSessionsStore(api, { schedule: (flush) => flush() });
  connectSessionsStore(store, api);
  store.getState().setWorkspace('ws-1');
  const created = await store.getState().createSession(roleId);
  if (!created.ok) throw new Error(created.error);
  await vi.advanceTimersByTimeAsync(0);
  return { api, store, sessionId: created.session.id };
}

/** 推进假时钟直到条件成立（上限 2 分钟的模拟时间） */
async function advanceUntil(condition: () => boolean) {
  for (let elapsed = 0; elapsed < 120_000 && !condition(); elapsed += 50) {
    await vi.advanceTimersByTimeAsync(50);
  }
  expect(condition()).toBe(true);
}

describe('mock SessionsApi + store', () => {
  it('发送 → 操作通知与工具调用 → settled，无需答复；history 回放与实时投影一致', async () => {
    const { api, store, sessionId } = await setup('worker');
    const state = () => store.getState();
    const events: SessionEventEnvelope[] = [];
    api.onEvent((event) => events.push(event));
    const statuses: string[] = [];
    store.subscribe(() => statuses.push(selectStatusOf(sessionId)(state())));

    expect(await state().send('帮我跑一下测试')).toBe(true);
    await advanceUntil(() => selectStatusOf(sessionId)(state()) === 'idle');
    expect(statuses).not.toContain('waiting-approval');
    expect(selectApprovalsOf(sessionId)(state())).toEqual([]);
    expect(
      events.filter(({ event }) => event.type === 'tool_notice').map(({ event }) => event)
    ).toEqual([
      {
        type: 'tool_notice',
        toolCallId: expect.any(String),
        toolName: 'bash',
        kind: 'command',
        seq: expect.any(Number),
      },
    ]);
    expect(events.some(({ event }) => event.type === 'approval_request')).toBe(false);

    const live = selectMessagesOf(sessionId)(state());
    expect(live[0]).toMatchObject({ role: 'user', text: '帮我跑一下测试' });
    expect(live[0]?.optimistic).toBeUndefined();
    expect(live[1]?.thinking).toContain('帮我跑一下测试');
    expect(live.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'assistant',
    ]);
    expect(live.every((message) => !message.streaming)).toBe(true);
    expect(live[1]?.toolCalls.map((call) => [call.name, call.status])).toEqual([
      ['ls', 'done'],
      ['read', 'done'],
      ['bash', 'done'],
    ]);
    expect(live[2]?.toolCalls.map((call) => call.name)).toEqual(['report_done']);
    expect(live[3]?.text).toContain('| 运行测试 | ✅');
    expect(state().runtimeBySession[sessionId]).toMatchObject({ model: 'mock-model' });
    expect(state().runtimeBySession[sessionId]?.usage.outputTokens).toBeGreaterThan(0);

    const shape = (messages: typeof live) =>
      messages.map((message) => ({
        role: message.role,
        text: message.text,
        thinking: message.thinking,
        tools: message.toolCalls.map((call) => [call.id, call.name, call.status, call.output]),
        usage: message.usage,
      }));
    await state().selectSession(sessionId);
    expect(shape(selectMessagesOf(sessionId)(state()))).toEqual(shape(live));
  });

  it('orchestrator 默认完全放行：bash 不询问，直接执行', async () => {
    const { store, sessionId } = await setup('orchestrator');
    const state = () => store.getState();
    expect(state().sessionsByWorkspace['ws-1']?.[0]?.approvalMode).toBe('full');

    expect(await state().send('拆一下任务')).toBe(true);
    await advanceUntil(() => selectStatusOf(sessionId)(state()) === 'idle');

    expect(selectApprovalsOf(sessionId)(state())).toEqual([]);
    const calls = selectMessagesOf(sessionId)(state()).flatMap((message) => message.toolCalls);
    expect(calls.map((call) => [call.name, call.status])).toEqual([
      ['ls', 'done'],
      ['read', 'done'],
      ['bash', 'done'],
      ['dispatch_task', 'done'],
      ['wait_for_workers', 'done'],
    ]);
  });

  it('orchestrator 切到全部通知后仍直接执行；迟到拒绝不能改写工具结果', async () => {
    const { store, api, sessionId } = await setup('orchestrator');
    const state = () => store.getState();
    expect(await api.setApprovalMode({ sessionId, mode: 'supervised' })).toMatchObject({
      ok: true,
      session: { approvalMode: 'supervised' },
    });

    await state().send('拆一下任务');
    await advanceUntil(() => selectStatusOf(sessionId)(state()) === 'idle');
    expect(selectApprovalsOf(sessionId)(state())).toEqual([]);
    expect(await api.respondApproval({ sessionId, requestId: 'old', decision: 'deny' })).toEqual({
      ok: false,
      error: translate('sessions.errors.approvalGone'),
    });

    const calls = selectMessagesOf(sessionId)(state()).flatMap((message) => message.toolCalls);
    expect(calls.map((call) => [call.name, call.status])).toEqual([
      ['ls', 'done'],
      ['read', 'done'],
      ['bash', 'done'],
      ['dispatch_task', 'done'],
      ['wait_for_workers', 'done'],
    ]);
  });

  it('只有图片的消息：回显确认后图片还在，history 回放里也在；不占用自动标题', async () => {
    const { store, api, sessionId } = await setup('orchestrator');
    const state = () => store.getState();
    const shot: ChatImage = { data: 'iVBORw0KGgo=', mimeType: 'image/png' };

    expect(state().attachImages(sessionId, [shot])).toBeUndefined();
    expect(await state().send('')).toBe(true);
    await advanceUntil(() => selectStatusOf(sessionId)(state()) === 'idle');
    expect(selectMessagesOf(sessionId)(state())[0]).toMatchObject({
      role: 'user',
      text: '',
      images: [shot],
    });
    expect(selectMessagesOf(sessionId)(state())[0]?.optimistic).toBeUndefined();
    expect(state().sessionsByWorkspace['ws-1']?.[0]?.title).toBe(translate('sessions.untitled'));

    await state().selectSession(sessionId);
    expect(selectMessagesOf(sessionId)(state())[0]).toMatchObject({
      role: 'user',
      text: '',
      images: [shot],
    });

    expect(await state().send('再看看这个')).toBe(true);
    await advanceUntil(() => selectStatusOf(sessionId)(state()) === 'idle');
    expect(state().sessionsByWorkspace['ws-1']?.[0]?.title).toBe('再看看这个');
    expect(await api.prompt({ sessionId, text: ' ' })).toEqual({
      ok: false,
      error: translate('sessions.errors.emptyMessage'),
    });
  });

  it('运行中停止：流式消息收尾、待审批清空、回到 idle，可以再次发送', async () => {
    const { store, api, sessionId } = await setup('worker');
    const state = () => store.getState();

    await state().send('写到一半就停');
    await advanceUntil(() => (selectMessagesOf(sessionId)(state())[1]?.text.length ?? 0) > 8);
    expect(selectStatusOf(sessionId)(state())).toBe('running');
    expect(await state().send('插队')).toBe(true);

    await state().abort();
    await advanceUntil(() => selectStatusOf(sessionId)(state()) === 'idle');

    // stop keeps the queued message instead of sending it
    expect(selectQueueOf(sessionId)(state()).length).toBe(1);
    const messages = selectMessagesOf(sessionId)(state());
    expect(messages.every((message) => !message.streaming)).toBe(true);
    expect(selectApprovalsOf(sessionId)(state())).toEqual([]);
    expect(await state().send('再来')).toBe(true);
    expect(await api.respondApproval({ sessionId, requestId: 'nope', decision: 'allow' })).toEqual({
      ok: false,
      error: '审批请求不存在或已过期',
    });
  });
});
