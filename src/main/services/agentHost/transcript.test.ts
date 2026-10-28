import type { ChatMessage } from '@shared/types/chat';
import { describe, expect, it } from 'vitest';
import { Transcript } from './transcript';

describe('Transcript', () => {
  it('renders a live run as plain text with markers', () => {
    const transcript = new Transcript();
    transcript.append({ type: 'message_end', role: 'user', text: '# Task\n\nFix   the build' });
    transcript.append({ type: 'thinking_delta', delta: 'hidden' });
    transcript.append({ type: 'text_delta', delta: 'Running ' });
    transcript.append({ type: 'text_delta', delta: 'tests.' });
    transcript.append({ type: 'message_end', role: 'assistant', text: 'Running tests.' });
    transcript.append({
      type: 'tool_start',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { command: 'pnpm test' },
    });
    transcript.append({
      type: 'approval_request',
      requestId: 'req-1',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { command: 'pnpm test' },
    });
    // A historical notice cannot stand in for an approval or execution result.
    transcript.append({
      type: 'tool_notice',
      toolCallId: 'old',
      toolName: 'bash',
      kind: 'command',
    });
    transcript.append({
      type: 'tool_end',
      toolCallId: 'c1',
      toolName: 'bash',
      isError: true,
      output: '1 failed\n  at a.test.ts',
      outputTruncated: false,
    });
    transcript.append({ type: 'error', source: 'model', message: 'overloaded' });
    transcript.append({ type: 'agent_settled', aborted: false });

    expect(transcript.read(0).text).toBe(
      [
        '[user] # Task Fix the build',
        'Running tests.',
        '[tool] bash {"command":"pnpm test"}',
        '[approval] bash',
        '[tool error] bash: 1 failed at a.test.ts',
        '[error] overloaded',
        '[settled]',
        '',
      ].join('\n')
    );
  });

  it('reads from a character cursor and clamps it', () => {
    const transcript = new Transcript();
    transcript.append({ type: 'text_delta', delta: 'abc' });
    expect(transcript.read(0)).toEqual({ text: 'abc', total: 3 });
    transcript.append({ type: 'text_delta', delta: 'def' });
    expect(transcript.read(3)).toEqual({ text: 'def', total: 6 });
    expect(transcript.read(-5)).toEqual({ text: 'abcdef', total: 6 });
    expect(transcript.read(99)).toEqual({ text: '', total: 6 });
    expect(transcript.read(Number.NaN)).toEqual({ text: 'abcdef', total: 6 });
  });

  it('only appends: earlier cursors stay valid', () => {
    const transcript = new Transcript();
    transcript.append({ type: 'text_delta', delta: 'one' });
    const before = transcript.read(0).text;
    transcript.append({ type: 'agent_settled', aborted: true });
    expect(transcript.read(0).text.startsWith(before)).toBe(true);
    expect(transcript.read(0).text).toBe('one\n[aborted]\n');
  });

  it('uses the final text when nothing was streamed and truncates long previews', () => {
    const transcript = new Transcript();
    transcript.append({ type: 'message_end', role: 'assistant', text: 'not streamed' });
    transcript.append({
      type: 'tool_end',
      toolCallId: 'c',
      toolName: 'read',
      isError: false,
      output: 'x'.repeat(1_000),
      outputTruncated: false,
    });
    const [answer, tool] = transcript.read(0).text.split('\n');
    expect(answer).toBe('not streamed');
    expect(tool?.length).toBeLessThan(330);
    expect(tool?.endsWith('…')).toBe(true);
  });

  it('starts from a history projection', () => {
    const messages: ChatMessage[] = [
      {
        id: 'u1',
        sessionId: 's',
        role: 'user',
        text: 'Write tests',
        toolCalls: [],
        createdAt: 1,
        streaming: false,
      },
      {
        id: 'a1',
        sessionId: 's',
        role: 'assistant',
        text: 'Done.',
        toolCalls: [
          { id: 'c1', name: 'write', args: { path: 'a.test.ts' }, status: 'done', output: 'ok' },
          { id: 'c2', name: 'bash', args: { command: 'pnpm test' }, status: 'error' },
        ],
        createdAt: 2,
        streaming: false,
      },
    ];
    expect(Transcript.fromMessages(messages).read(0).text).toBe(
      [
        '[user] Write tests',
        'Done.',
        '[tool] write {"path":"a.test.ts"}',
        '[tool done] write: ok',
        '[tool] bash {"command":"pnpm test"}',
        '[tool error] bash',
        '',
      ].join('\n')
    );
  });
});
