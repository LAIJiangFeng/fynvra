import type { FynvraSessionEventBody } from '@fynvra/core';
import type {
  ApprovalRequest,
  ChatImage,
  ChatMessage,
  SessionEventEnvelope,
} from '@shared/types/chat';
import { describe, expect, it } from 'vitest';
import {
  addOptimisticMessage,
  applyHistory,
  type ChatProjection,
  dequeueApproval,
  emptyProjection,
  enqueueApproval,
  reduceSessionEvent,
  syncSessionStatuses,
  withdrawOptimisticMessage,
} from './reducer';

const S = 'session-a';
const T0 = 1_000;

function envelope(seq: number, event: FynvraSessionEventBody, sessionId = S): SessionEventEnvelope {
  return { sessionId, event: { ...event, seq } as SessionEventEnvelope['event'] };
}

/** 依次归并事件，seq 从 `from` 起递增；第 i 条事件的时间是 T0 + i */
function run(
  events: FynvraSessionEventBody[],
  state: ChatProjection = emptyProjection(),
  from = 1
): ChatProjection {
  return events.reduce(
    (current, event, index) =>
      reduceSessionEvent(current, envelope(from + index, event), T0 + index),
    state
  );
}

const messagesOf = (state: ChatProjection, sessionId = S) =>
  state.messagesBySession[sessionId] ?? [];
const runtimeOf = (state: ChatProjection, sessionId = S) => state.runtimeBySession[sessionId];

function chat(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role'>): ChatMessage {
  return { sessionId: S, text: '', toolCalls: [], createdAt: T0, streaming: false, ...partial };
}

const SHOT: ChatImage = { data: 'iVBORw0KGgo=', mimeType: 'image/png' };
const PHOTO: ChatImage = { data: '/9j/4AAQ', mimeType: 'image/jpeg' };
/** pi 缩放图片后接在正文末尾的提示行 */
const RESIZED =
  '[Image: original 3773x1017, displayed at 2000x539. Multiply coordinates by 1.89 to map to original image.]';

describe('reduceSessionEvent · seq', () => {
  it('按 sessionId 分桶，互不影响', () => {
    let state = reduceSessionEvent(
      emptyProjection(),
      envelope(1, { type: 'text_delta', delta: 'A' }, 'a')
    );
    state = reduceSessionEvent(state, envelope(1, { type: 'text_delta', delta: 'B' }, 'b'));

    expect(messagesOf(state, 'a').map((message) => message.text)).toEqual(['A']);
    expect(messagesOf(state, 'b').map((message) => message.text)).toEqual(['B']);
    expect(runtimeOf(state, 'a')?.lastSeq).toBe(1);
    expect(runtimeOf(state, 'b')?.lastSeq).toBe(1);
  });

  it('重复 seq 丢弃，原对象返回', () => {
    const state = run([{ type: 'text_delta', delta: 'Hel' }]);
    const again = reduceSessionEvent(state, envelope(1, { type: 'text_delta', delta: 'Hel' }));
    expect(again).toBe(state);
    expect(messagesOf(again)[0]?.text).toBe('Hel');
  });

  it('乱序（更小的 seq）丢弃；跳号照常接收', () => {
    let state = run([{ type: 'text_delta', delta: 'a' }], emptyProjection(), 5);
    const stale = reduceSessionEvent(state, envelope(3, { type: 'text_delta', delta: 'x' }));
    expect(stale).toBe(state);

    state = reduceSessionEvent(state, envelope(9, { type: 'text_delta', delta: 'b' }));
    expect(messagesOf(state)[0]?.text).toBe('ab');
    expect(runtimeOf(state)?.lastSeq).toBe(9);
  });
});

describe('reduceSessionEvent · 流式消息', () => {
  it('text / thinking 增量累加到同一条流式 assistant 消息，并把会话置 running', () => {
    const state = run([
      { type: 'thinking_delta', delta: '先想' },
      { type: 'thinking_delta', delta: '一下' },
      { type: 'text_delta', delta: '你' },
      { type: 'text_delta', delta: '好' },
    ]);

    const messages = messagesOf(state);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      text: '你好',
      thinking: '先想一下',
      streaming: true,
      toolCalls: [],
    });
    expect(runtimeOf(state)?.status).toBe('running');
  });

  it('message_end 用权威正文整条替换并结束流式，保留思考与工具调用', () => {
    const state = run([
      { type: 'thinking_delta', delta: '想' },
      { type: 'text_delta', delta: '半截' },
      { type: 'tool_start', toolCallId: 'call-1', toolName: 'read', args: { path: 'a.ts' } },
      { type: 'message_end', role: 'assistant', text: '完整的回答', stopReason: 'toolUse' },
    ]);

    const [message] = messagesOf(state);
    expect(messagesOf(state)).toHaveLength(1);
    expect(message).toMatchObject({ text: '完整的回答', thinking: '想', streaming: false });
    expect(message?.toolCalls.map((call) => call.id)).toEqual(['call-1']);
  });

  it('没有增量的 message_end 也会落一条（只有工具调用的 assistant 消息），后续增量另起一条', () => {
    const state = run([
      { type: 'message_end', role: 'assistant', text: '', stopReason: 'toolUse' },
      { type: 'tool_start', toolCallId: 'call-1', toolName: 'ls', args: {} },
      { type: 'text_delta', delta: '下一条' },
    ]);

    const messages = messagesOf(state);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'assistant', text: '', streaming: false });
    expect(messages[0]?.toolCalls).toHaveLength(1);
    expect(messages[1]).toMatchObject({ role: 'assistant', text: '下一条', streaming: true });
  });

  it('user 的 message_end 没有乐观回显时追加一条权威消息，并开启新一轮', () => {
    const errored = run([{ type: 'error', source: 'model', message: '上一轮失败' }]);
    const state = run([{ type: 'message_end', role: 'user', text: '任务书' }], errored, 2);

    expect(messagesOf(state)).toEqual([
      expect.objectContaining({ role: 'user', text: '任务书', streaming: false }),
    ]);
    expect(runtimeOf(state)).toMatchObject({ status: 'running', error: undefined });
  });
});

describe('乐观回显', () => {
  it('发送时追加在末尾并置 running；user 的 message_end 原位确认，不重复', () => {
    let state = addOptimisticMessage(emptyProjection(), S, {
      id: 'local-1',
      text: '你好',
      createdAt: T0,
    });
    expect(messagesOf(state)).toEqual([
      expect.objectContaining({ id: 'local-1', role: 'user', text: '你好', optimistic: true }),
    ]);
    expect(runtimeOf(state)?.status).toBe('running');

    state = run([{ type: 'message_end', role: 'user', text: '你好' }], state);
    const messages = messagesOf(state);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'local-1', text: '你好' });
    expect(messages[0]?.optimistic).toBeUndefined();
  });

  it('回显只留在尾部：此后到达的流式内容插在回显之前', () => {
    let state = run([{ type: 'text_delta', delta: '上一轮' }]);
    state = addOptimisticMessage(state, S, { id: 'local-1', text: '追问', createdAt: T0 });
    state = run(
      [
        { type: 'text_delta', delta: '的结尾' },
        { type: 'message_end', role: 'assistant', text: '上一轮的结尾' },
        { type: 'tool_start', toolCallId: 'call-1', toolName: 'read', args: {} },
      ],
      state,
      2
    );

    expect(messagesOf(state).map((message) => [message.role, message.text])).toEqual([
      ['assistant', '上一轮的结尾'],
      ['user', '追问'],
    ]);
    expect(messagesOf(state)[0]?.toolCalls).toHaveLength(1);
    expect(messagesOf(state)[1]?.optimistic).toBe(true);
  });

  it('撤回指定回显，恢复之前的状态并记录错误', () => {
    let state = addOptimisticMessage(emptyProjection(), S, {
      id: 'local-1',
      text: 'hi',
      createdAt: T0,
    });
    state = withdrawOptimisticMessage(state, S, 'local-1', { status: 'idle', error: '会话不存在' });

    expect(messagesOf(state)).toEqual([]);
    expect(runtimeOf(state)).toMatchObject({ status: 'idle', error: '会话不存在' });
  });

  it('回合开始前就失败（error 且没有 message_end）时回显标记为未送达，下次发送时清掉', () => {
    let state = addOptimisticMessage(emptyProjection(), S, {
      id: 'local-1',
      text: 'hi',
      createdAt: T0,
    });
    state = run([{ type: 'error', source: 'host', message: '缺少 API key' }], state);

    expect(messagesOf(state)[0]).toMatchObject({ id: 'local-1', optimistic: true, failed: true });
    expect(runtimeOf(state)).toMatchObject({ status: 'error', error: '缺少 API key' });

    state = addOptimisticMessage(state, S, { id: 'local-2', text: 'hi again', createdAt: T0 });
    expect(messagesOf(state).map((message) => message.id)).toEqual(['local-2']);
    expect(runtimeOf(state)).toMatchObject({ status: 'running', error: undefined });
  });
});

describe('带图片的消息', () => {
  it('回显带着图片；user 的 message_end 确认时保留图片，正文去掉 pi 接上的提示行', () => {
    let state = addOptimisticMessage(emptyProjection(), S, {
      id: 'local-1',
      text: '哪里不对？',
      images: [SHOT, PHOTO],
      createdAt: T0,
    });
    expect(messagesOf(state)).toEqual([
      expect.objectContaining({
        id: 'local-1',
        role: 'user',
        text: '哪里不对？',
        images: [SHOT, PHOTO],
        optimistic: true,
      }),
    ]);

    state = run([{ type: 'message_end', role: 'user', text: `哪里不对？\n\n${RESIZED}` }], state);
    const messages = messagesOf(state);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'local-1', text: '哪里不对？', images: [SHOT, PHOTO] });
    expect(messages[0]?.optimistic).toBeUndefined();
  });

  it('只有图片的回显：确认后正文为空，图片还在，会话开始新一轮', () => {
    let state = addOptimisticMessage(emptyProjection(), S, {
      id: 'local-1',
      text: '',
      images: [SHOT],
      createdAt: T0,
    });
    state = run([{ type: 'message_end', role: 'user', text: `\n\n${RESIZED}` }], state);
    expect(messagesOf(state)).toEqual([
      expect.objectContaining({ id: 'local-1', role: 'user', text: '', images: [SHOT] }),
    ]);
    expect(runtimeOf(state)?.status).toBe('running');
  });

  it('不带图片的回显照常确认：形似提示行的文字是用户写的，不剥；空的图片列表不留字段', () => {
    let state = addOptimisticMessage(emptyProjection(), S, {
      id: 'local-1',
      text: `解释这一行\n\n${RESIZED}`,
      images: [],
      createdAt: T0,
    });
    expect(messagesOf(state)[0]).not.toHaveProperty('images');
    state = run([{ type: 'message_end', role: 'user', text: `解释这一行\n\n${RESIZED}` }], state);
    expect(messagesOf(state)[0]).toMatchObject({ text: `解释这一行\n\n${RESIZED}` });
    expect(messagesOf(state)[0]).not.toHaveProperty('images');
  });

  it('撤回带图片的回显与不带图片的一样', () => {
    let state = addOptimisticMessage(emptyProjection(), S, {
      id: 'local-1',
      text: '',
      images: [SHOT],
      createdAt: T0,
    });
    state = withdrawOptimisticMessage(state, S, 'local-1', {
      status: 'idle',
      error: '没有可用的模型',
    });
    expect(messagesOf(state)).toEqual([]);
    expect(runtimeOf(state)).toMatchObject({ status: 'idle', error: '没有可用的模型' });
  });

  it('history 回放：带图片的回显能和去掉了提示行的、只有图片的、图片都被略去的投影对上', () => {
    let state = applyHistory(emptyProjection(), S, [
      chat({ id: 'u0', role: 'user', text: '开场' }),
    ]);
    state = addOptimisticMessage(state, S, {
      id: 'local-1',
      text: '看看这张',
      images: [SHOT],
      createdAt: T0,
    });
    state = addOptimisticMessage(state, S, {
      id: 'local-2',
      text: '',
      images: [SHOT],
      createdAt: T0,
    });
    state = addOptimisticMessage(state, S, {
      id: 'local-3',
      text: '太大了',
      images: [PHOTO],
      createdAt: T0,
    });
    state = addOptimisticMessage(state, S, {
      id: 'local-4',
      text: '还没落盘',
      images: [PHOTO],
      createdAt: T0,
    });

    state = applyHistory(state, S, [
      chat({ id: 'u0', role: 'user', text: '开场' }),
      // pi 存的是规整后的图片，数据与回显不同：按正文对上
      chat({ id: 'u1', role: 'user', text: '看看这张', images: [PHOTO] }),
      chat({ id: 'u2', role: 'user', text: '', images: [PHOTO] }),
      // 图片都被 pi 略去：投影里没有图片，正文还带着 pi 的提示行
      chat({
        id: 'u3',
        role: 'user',
        text: '太大了\n\n[Image omitted: could not be resized below the inline image size limit.]',
      }),
    ]);

    expect(messagesOf(state).map((message) => [message.id, message.optimistic])).toEqual([
      ['u0', undefined],
      ['u1', undefined],
      ['u2', undefined],
      ['u3', undefined],
      ['local-4', true],
    ]);
  });
});

describe('工具调用', () => {
  it('tool_start 在最近的 assistant 消息上建 running 调用，tool_end 按 id 配对更新', () => {
    const state = run([
      { type: 'message_end', role: 'assistant', text: '我看看', stopReason: 'toolUse' },
      { type: 'tool_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'ls' } },
      { type: 'tool_start', toolCallId: 'call-2', toolName: 'read', args: { path: 'a' } },
      {
        type: 'tool_end',
        toolCallId: 'call-2',
        toolName: 'read',
        isError: true,
        output: 'ENOENT',
        outputTruncated: false,
        durationMs: 12,
      },
    ]);

    const calls = messagesOf(state)[0]?.toolCalls;
    expect(calls).toEqual([
      { id: 'call-1', name: 'bash', args: { command: 'ls' }, status: 'running' },
      {
        id: 'call-2',
        name: 'read',
        args: { path: 'a' },
        status: 'error',
        output: 'ENOENT',
        durationMs: 12,
      },
    ]);
    expect(runtimeOf(state)?.toolStartedAt).toEqual({ 'call-1': T0 + 1 });
  });

  it('tool_end 缺 durationMs 时按本地开始时间推算', () => {
    let state = run([
      { type: 'message_end', role: 'assistant', text: '' },
      { type: 'tool_start', toolCallId: 'call-1', toolName: 'bash', args: {} },
    ]);
    state = reduceSessionEvent(
      state,
      envelope(3, {
        type: 'tool_end',
        toolCallId: 'call-1',
        toolName: 'bash',
        isError: false,
        output: 'ok',
        outputTruncated: false,
      }),
      T0 + 1 + 250
    );

    expect(messagesOf(state)[0]?.toolCalls[0]).toMatchObject({
      status: 'done',
      output: 'ok',
      durationMs: 250,
    });
    expect(runtimeOf(state)?.toolStartedAt).toEqual({});
  });

  it('没有 tool_start 的 tool_end 也会落成已完成的调用；history 里已有的调用原位更新', () => {
    let state = applyHistory(emptyProjection(), S, [
      chat({
        id: 'entry-1',
        role: 'assistant',
        toolCalls: [
          { id: 'call-1', name: 'bash', args: { command: 'pnpm test' }, status: 'running' },
        ],
      }),
    ]);
    state = run(
      [
        {
          type: 'tool_start',
          toolCallId: 'call-1',
          toolName: 'bash',
          args: { command: 'pnpm test' },
        },
        {
          type: 'tool_end',
          toolCallId: 'call-1',
          toolName: 'bash',
          isError: false,
          output: 'passed',
          outputTruncated: false,
          durationMs: 5,
        },
        {
          type: 'tool_end',
          toolCallId: 'call-9',
          toolName: 'read',
          isError: false,
          output: 'late',
          outputTruncated: false,
        },
      ],
      state
    );

    const calls = messagesOf(state)[0]?.toolCalls ?? [];
    expect(messagesOf(state)).toHaveLength(1);
    expect(calls.map((call) => [call.id, call.status, call.output])).toEqual([
      ['call-1', 'done', 'passed'],
      ['call-9', 'done', 'late'],
    ]);
  });

  it('还没有 assistant 消息时，为工具调用补一条空的 assistant 消息', () => {
    const state = run([
      { type: 'message_end', role: 'user', text: '开始' },
      { type: 'tool_start', toolCallId: 'call-1', toolName: 'ls', args: {} },
    ]);

    expect(messagesOf(state).map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messagesOf(state)[1]?.toolCalls[0]).toMatchObject({ id: 'call-1', status: 'running' });
  });
});

describe('agent_settled / error / usage', () => {
  it('agent_settled 置 idle、结束流式并将未结束工具标为 error，旧审批不入队', () => {
    const state = run([
      { type: 'message_end', role: 'assistant', text: '' },
      { type: 'tool_start', toolCallId: 'call-1', toolName: 'bash', args: {} },
      {
        type: 'approval_request',
        requestId: 'req-1',
        toolCallId: 'call-2',
        toolName: 'bash',
        args: { command: 'rm -rf dist' },
      },
      { type: 'text_delta', delta: '被中止' },
      { type: 'agent_settled', aborted: true },
    ]);

    const messages = messagesOf(state);
    expect(messages.every((message) => !message.streaming)).toBe(true);
    expect(messages[0]?.toolCalls[0]?.status).toBe('error');
    expect(state.pendingApprovals[S]).toBeUndefined();
    expect(runtimeOf(state)).toMatchObject({ status: 'idle', toolStartedAt: {} });
  });

  it('本轮出过错误时 settled 后保持 error，直到新一轮开始', () => {
    let state = run([
      { type: 'text_delta', delta: '…' },
      { type: 'error', source: 'model', message: '429 rate limited' },
    ]);
    expect(runtimeOf(state)).toMatchObject({ status: 'error', error: '429 rate limited' });

    state = run([{ type: 'agent_settled', aborted: false }], state, 3);
    expect(runtimeOf(state)).toMatchObject({ status: 'error', error: '429 rate limited' });

    state = run([{ type: 'message_end', role: 'user', text: '重试' }], state, 4);
    expect(runtimeOf(state)).toMatchObject({ status: 'running', error: undefined });
  });

  it('usage 挂到最近的 assistant 消息上并累计到会话，记录模型', () => {
    const usage = (input: number, output: number, cost: number): FynvraSessionEventBody => ({
      type: 'usage',
      provider: 'p-1',
      model: 'claude-sonnet-5-5',
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost,
    });
    const state = run([
      { type: 'message_end', role: 'assistant', text: '一' },
      usage(100, 20, 0.01),
      { type: 'message_end', role: 'assistant', text: '二' },
      usage(150, 30, 0.02),
    ]);

    expect(messagesOf(state).map((message) => message.usage)).toEqual([
      { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
      { inputTokens: 150, outputTokens: 30, costUsd: 0.02 },
    ]);
    expect(runtimeOf(state)?.usage).toEqual({ inputTokens: 250, outputTokens: 50, costUsd: 0.03 });
    expect(runtimeOf(state)?.model).toBe('claude-sonnet-5-5');
  });
});

describe('旧审批兼容与操作通知', () => {
  const approvalEvent: Extract<FynvraSessionEventBody, { type: 'approval_request' }> = {
    type: 'approval_request',
    requestId: 'req-1',
    toolCallId: 'call-1',
    toolName: 'bash',
    args: { command: 'pnpm install' },
    reason: '需要联网',
  };

  it('approval_request 不创建等待或工具，只有真实 tool_start 才置 running', () => {
    let state = run([approvalEvent]);
    expect(state.pendingApprovals[S]).toBeUndefined();
    expect(runtimeOf(state)?.status).toBe('idle');
    expect(messagesOf(state)).toEqual([]);

    state = run(
      [
        {
          type: 'tool_start',
          toolCallId: 'call-1',
          toolName: 'bash',
          args: { command: 'pnpm install' },
        },
      ],
      state,
      2
    );
    expect(state.pendingApprovals[S]).toBeUndefined();
    expect(runtimeOf(state)?.status).toBe('running');
    expect(messagesOf(state)[0]?.toolCalls[0]).toMatchObject({ id: 'call-1', status: 'running' });
  });

  it('所有旧工具审批类型都忽略，通知只推进 seq 而不冒充执行', () => {
    const state = run(
      [
        { ...approvalEvent, requestId: 'r1', toolName: 'edit', args: { path: 'a.ts' } },
        { ...approvalEvent, requestId: 'r2', toolName: 'write', args: { path: 'b.ts' } },
        { ...approvalEvent, requestId: 'r3', toolName: 'mcp__github__create_issue', args: {} },
      ].map(({ reason: _reason, ...event }) => event)
    );

    expect(state.pendingApprovals[S]).toBeUndefined();
    expect(messagesOf(state)).toEqual([]);
    expect(runtimeOf(state)).toMatchObject({ status: 'idle', lastSeq: 3 });
    const notified = run(
      [{ type: 'tool_notice', toolCallId: 'call-1', toolName: 'edit', kind: 'file-edit' }],
      state,
      4
    );
    expect(messagesOf(notified)).toEqual([]);
    expect(runtimeOf(notified)).toMatchObject({ status: 'idle', lastSeq: 4 });
    expect(run([approvalEvent], notified, 3)).toBe(notified);
  });

  it('旧 Main 请求和时间线事件任意顺序、重复到达都不入队或创建等待', () => {
    const request: ApprovalRequest = {
      id: 'req-1',
      sessionId: S,
      kind: 'command',
      title: 'Run command',
      detail: 'pnpm install',
      expiresAt: T0 + 60_000,
    };
    let state = run([approvalEvent]);
    state = enqueueApproval(state, request);
    state = enqueueApproval(state, request);

    expect(state.pendingApprovals[S]).toBeUndefined();
    expect(runtimeOf(state)?.status).toBe('idle');
    expect(messagesOf(state)).toEqual([]);

    let reversed = enqueueApproval(emptyProjection(), request);
    expect(runtimeOf(reversed)?.status).toBe('idle');
    reversed = run([approvalEvent], reversed);
    expect(reversed.pendingApprovals[S]).toBeUndefined();
    expect(messagesOf(reversed)).toEqual([]);
  });

  it('清理旧队列后根据真实活动恢复状态，迟到答复不能启动工具', () => {
    const request: ApprovalRequest = {
      id: 'req-1',
      sessionId: S,
      kind: 'command',
      title: 'bash',
      detail: 'echo hi',
      expiresAt: 0,
    };
    for (const active of [false, true]) {
      let state = run(active ? [{ type: 'text_delta', delta: 'Working' }] : [approvalEvent]);
      const runtime = runtimeOf(state);
      if (!runtime) throw new Error('missing runtime');
      state = {
        ...state,
        pendingApprovals: { [S]: [request, { ...request, id: 'req-2' }] },
        runtimeBySession: { [S]: { ...runtime, status: 'waiting-approval' } },
      };
      const beforeMessages = messagesOf(state);
      state = dequeueApproval(state, S, 'req-1');
      expect(state.pendingApprovals[S]).toEqual([]);
      expect(runtimeOf(state)?.status).toBe(active ? 'running' : 'idle');
      expect(messagesOf(state)).toBe(beforeMessages);
      expect(dequeueApproval(state, S, 'req-2')).toBe(state);
      expect(dequeueApproval(state, S, 'missing')).toBe(state);
    }
  });
});

describe('applyHistory', () => {
  const history: ChatMessage[] = [
    chat({ id: 'u1', role: 'user', text: '第一问' }),
    chat({
      id: 'a1',
      role: 'assistant',
      text: '第一答',
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 },
    }),
    chat({ id: 'u2', role: 'user', text: '第二问' }),
    chat({
      id: 'a2',
      role: 'assistant',
      text: '第二答',
      usage: { inputTokens: 20, outputTokens: 7 },
    }),
  ];

  it('用权威投影整体替换，按权威消息重算用量，不动 lastSeq', () => {
    let state = run([
      { type: 'message_end', role: 'assistant', text: '本地旧投影' },
      {
        type: 'usage',
        provider: 'p',
        model: 'm',
        input: 999,
        output: 999,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1998,
        cost: 9,
      },
    ]);
    state = applyHistory(state, S, history);

    expect(messagesOf(state).map((message) => message.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(runtimeOf(state)).toMatchObject({
      lastSeq: 2,
      usage: { inputTokens: 30, outputTokens: 12, costUsd: 0.5 },
      model: 'm',
    });
  });

  it('保留尚未落盘的流式消息与未确认的乐观回显，history 里已有的回显被抵消', () => {
    let state = applyHistory(emptyProjection(), S, history.slice(0, 2));
    state = addOptimisticMessage(state, S, { id: 'local-1', text: '第二问', createdAt: T0 });
    state = addOptimisticMessage(state, S, { id: 'local-2', text: '第三问', createdAt: T0 });
    state = run([{ type: 'text_delta', delta: '流式中' }], state);

    state = applyHistory(state, S, history);

    expect(
      messagesOf(state).map((message) => [message.id, message.streaming, message.optimistic])
    ).toEqual([
      ['u1', false, undefined],
      ['a1', false, undefined],
      ['u2', false, undefined],
      ['a2', false, undefined],
      ['live-1', true, undefined],
      ['local-2', false, true],
    ]);
  });
});

describe('syncSessionStatuses', () => {
  it('列表刷新时以 Main 的状态为准；跳过正在发送的会话，不为没投影的会话建条目', () => {
    let state = run([{ type: 'text_delta', delta: 'x' }]);
    state = reduceSessionEvent(state, envelope(1, { type: 'text_delta', delta: 'z' }, 'b'));

    const next = syncSessionStatuses(
      state,
      [
        { id: S, status: 'idle' },
        { id: 'b', status: 'error' },
        { id: 'c', status: 'running' },
      ],
      new Set(['b'])
    );

    expect(runtimeOf(next)?.status).toBe('idle');
    expect(runtimeOf(next, 'b')?.status).toBe('running');
    expect(next.runtimeBySession.c).toBeUndefined();
    expect(syncSessionStatuses(next, [{ id: S, status: 'idle' }], new Set())).toBe(next);
  });
});
