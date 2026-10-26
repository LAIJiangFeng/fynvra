import type { ChatImage } from '@shared/types/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translate } from '../../i18n';
import { createMockSessionsApi } from '../../lib/api/sessions';
import { connectSessionsStore, createSessionsStore } from './createSessionsStore';
import { selectApprovalsOf, selectMessagesOf, selectStatusOf } from './selectors';

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
  it('发送 → 流式回复与工具调用 → 审批放行 → settled；history 回放与实时投影一致', async () => {
    const { store, sessionId } = await setup('worker');
    const state = () => store.getState();

    expect(await state().send('帮我跑一下测试')).toBe(true);
    await advanceUntil(() => selectApprovalsOf(sessionId)(state()).length > 0);

    const [approval] = selectApprovalsOf(sessionId)(state());
    expect(approval).toMatchObject({ kind: 'command', detail: 'pnpm test' });
    expect(approval?.toolCallId).toBeTruthy();
    expect(selectStatusOf(sessionId)(state())).toBe('waiting-approval');
    const beforeApproval = selectMessagesOf(sessionId)(state());
    expect(beforeApproval[0]).toMatchObject({ role: 'user', text: '帮我跑一下测试' });
    expect(beforeApproval[0]?.optimistic).toBeUndefined();
    expect(beforeApproval[1]?.thinking).toContain('帮我跑一下测试');
    expect(beforeApproval[1]?.toolCalls.map((call) => [call.name, call.status])).toEqual([
      ['ls', 'done'],
      ['read', 'done'],
    ]);

    await state().respondApproval(approval?.id ?? '', 'allow');
    await advanceUntil(() => selectStatusOf(sessionId)(state()) === 'idle');

    const live = selectMessagesOf(sessionId)(state());
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

  it('orchestrator 切到全程审批后：拒绝审批，命令记为失败，继续演示 dispatch_task / wait_for_workers', async () => {
    const { store, api, sessionId } = await setup('orchestrator');
    const state = () => store.getState();
    expect(await api.setApprovalMode({ sessionId, mode: 'supervised' })).toMatchObject({
      ok: true,
      session: { approvalMode: 'supervised' },
    });

    await state().send('拆一下任务');
    await advanceUntil(() => selectApprovalsOf(sessionId)(state()).length > 0);
    const [approval] = selectApprovalsOf(sessionId)(state());
    await state().respondApproval(approval?.id ?? '', 'deny');
    await advanceUntil(() => selectStatusOf(sessionId)(state()) === 'idle');

    const calls = selectMessagesOf(sessionId)(state()).flatMap((message) => message.toolCalls);
    expect(calls.map((call) => [call.name, call.status])).toEqual([
      ['ls', 'done'],
      ['read', 'done'],
      ['bash', 'error'],
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
    expect(await state().send('插队')).toBe(false);

    await state().abort();
    await advanceUntil(() => selectStatusOf(sessionId)(state()) === 'idle');

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
