import type { ChatToolCall } from '@shared/types/chat';
import { describe, expect, it } from 'vitest';
import type { TimelineMessage } from './reducer';
import {
  buildTimelineRows,
  diffEdit,
  fileChangeOf,
  formatTurnTime,
  isReadonlyTool,
  reuseRows,
  type TimelineRow,
  type TimelineRowOptions,
  thinkingExpanded,
} from './timeline';

function call(id: string, name: string, patch: Partial<ChatToolCall> = {}): ChatToolCall {
  return { id, name, args: {}, status: 'done', ...patch };
}

function user(id: string, text = id, patch: Partial<TimelineMessage> = {}): TimelineMessage {
  return {
    id,
    sessionId: 's1',
    role: 'user',
    text,
    toolCalls: [],
    createdAt: 1,
    streaming: false,
    ...patch,
  };
}

function assistant(
  id: string,
  patch: Partial<TimelineMessage> & { calls?: ChatToolCall[] } = {}
): TimelineMessage {
  const { calls = [], ...rest } = patch;
  return {
    id,
    sessionId: 's1',
    role: 'assistant',
    text: '',
    toolCalls: calls,
    createdAt: 1,
    streaming: false,
    ...rest,
  };
}

const PLAIN: TimelineRowOptions = {
  compactReadonlyTools: false,
  foldHistoryTurns: false,
  openTurns: new Set(),
};
const COMPACT: TimelineRowOptions = { ...PLAIN, compactReadonlyTools: true };

/** 行的简写：user:<id> / assistant:<id>[工具] / turn:<提问 id>(open) */
function shape(rows: TimelineRow[]): string[] {
  return rows.map((row) => {
    if (row.kind === 'turn') return `turn:${row.message.id}${row.open ? '(open)' : ''}`;
    if (row.kind === 'user') return `user:${row.message.id}`;
    const tools = row.tools.map((item) =>
      item.kind === 'call' ? item.call.id : `reads(${item.calls.map((c) => c.id).join(',')})`
    );
    return `assistant:${row.message.id}[${tools.join(' ')}]`;
  });
}

describe('isReadonlyTool', () => {
  it('read / grep / find / ls 是只读工具；bash、编辑、编排工具不是', () => {
    expect(['read', 'grep', 'find', 'ls'].every(isReadonlyTool)).toBe(true);
    for (const name of ['bash', 'edit', 'write', 'git_readonly', 'dispatch_task', 'mcp__x__read']) {
      expect(isReadonlyTool(name)).toBe(false);
    }
  });
});

describe('buildTimelineRows · 精简只读工具', () => {
  const messages = [
    user('u1'),
    assistant('a1', {
      text: '先看看',
      calls: [call('r1', 'read'), call('g1', 'grep'), call('b1', 'bash'), call('l1', 'ls')],
    }),
    // 工具结果之后只有工具调用、没有正文的消息：并进上一行，连续的读取合在一起
    assistant('a2', { calls: [call('f1', 'find'), call('r2', 'read')] }),
    assistant('a3', { text: '找到了', calls: [call('e1', 'edit')] }),
  ];

  it('开：连续的只读调用合成一组（跨没有正文的消息），其他工具照常', () => {
    expect(shape(buildTimelineRows(messages, COMPACT))).toEqual([
      'user:u1',
      'assistant:a1[reads(r1,g1) b1 reads(l1,f1,r2)]',
      'assistant:a3[e1]',
    ]);
  });

  it('关：每个调用一张卡片', () => {
    expect(shape(buildTimelineRows(messages, PLAIN))).toEqual([
      'user:u1',
      'assistant:a1[r1 g1 b1 l1 f1 r2]',
      'assistant:a3[e1]',
    ]);
  });

  it('有思考的消息另起一行；没有正文、思考和工具的占位不画', () => {
    const rows = buildTimelineRows(
      [
        user('u1'),
        assistant('a1', { calls: [call('r1', 'read')] }),
        assistant('a2', { thinking: '想一想', calls: [call('r2', 'read')] }),
        assistant('a3', { streaming: true }),
      ],
      COMPACT
    );
    expect(shape(rows)).toEqual(['user:u1', 'assistant:a1[reads(r1)]', 'assistant:a2[reads(r2)]']);
  });

  it('开场就是工具调用（没有提问）的会话也能画', () => {
    expect(
      shape(buildTimelineRows([assistant('a1', { calls: [call('r1', 'read')] })], COMPACT))
    ).toEqual(['assistant:a1[reads(r1)]']);
  });
});

describe('buildTimelineRows · 折叠历史轮次', () => {
  const messages = [
    user('u1', '第一个问题', { createdAt: 10 }),
    assistant('a1', { text: '答一' }),
    user('u2', '第二个问题', { createdAt: 20 }),
    assistant('a2', { text: '答二', calls: [call('r1', 'read')] }),
    user('u3', '第三个问题', { createdAt: 30 }),
    assistant('a3', { text: '答三', streaming: true }),
  ];
  const FOLD: TimelineRowOptions = { ...COMPACT, foldHistoryTurns: true };

  it('开：之前的轮次各折成一行，最后一轮展开', () => {
    const rows = buildTimelineRows(messages, FOLD);
    expect(shape(rows)).toEqual(['turn:u1', 'turn:u2', 'user:u3', 'assistant:a3[]']);
    expect(rows[0]).toMatchObject({ kind: 'turn', message: { text: '第一个问题', createdAt: 10 } });
  });

  it('手动展开的历史轮次：标题行后面接整轮内容', () => {
    const rows = buildTimelineRows(messages, { ...FOLD, openTurns: new Set(['u2']) });
    expect(shape(rows)).toEqual([
      'turn:u1',
      'turn:u2(open)',
      'user:u2',
      'assistant:a2[reads(r1)]',
      'user:u3',
      'assistant:a3[]',
    ]);
  });

  it('只有图片、正文为空的提问照样开始一轮，也照样折成标题行', () => {
    const image = { data: 'iVBORw0KGgo=', mimeType: 'image/png' as const };
    const withImages = [
      user('u1', '', { images: [image] }),
      assistant('a1', { text: '是一张截图' }),
      user('u2', '再看这张', { images: [image] }),
      assistant('a2', { text: '好的' }),
    ];
    expect(shape(buildTimelineRows(withImages, PLAIN))).toEqual([
      'user:u1',
      'assistant:a1[]',
      'user:u2',
      'assistant:a2[]',
    ]);
    const rows = buildTimelineRows(withImages, FOLD);
    expect(shape(rows)).toEqual(['turn:u1', 'user:u2', 'assistant:a2[]']);
    expect(rows[0]).toMatchObject({ kind: 'turn', message: { text: '', images: [image] } });
  });

  it('发送新消息（乐观回显）后，刚才那一轮也折起来', () => {
    const sent = [...messages, user('local-1', '第四个问题', { optimistic: true })];
    expect(shape(buildTimelineRows(sent, FOLD))).toEqual([
      'turn:u1',
      'turn:u2',
      'turn:u3',
      'user:local-1',
    ]);
  });

  it('只有一轮、或关掉折叠：照常全部显示', () => {
    expect(shape(buildTimelineRows(messages.slice(0, 2), FOLD))).toEqual([
      'user:u1',
      'assistant:a1[]',
    ]);
    expect(shape(buildTimelineRows(messages, COMPACT))).toEqual([
      'user:u1',
      'assistant:a1[]',
      'user:u2',
      'assistant:a2[reads(r1)]',
      'user:u3',
      'assistant:a3[]',
    ]);
  });

  it('提问之前的内容（没有提问的开场）不折叠', () => {
    const rows = buildTimelineRows([assistant('a0', { text: '开场' }), ...messages], FOLD);
    expect(shape(rows)).toEqual([
      'assistant:a0[]',
      'turn:u1',
      'turn:u2',
      'user:u3',
      'assistant:a3[]',
    ]);
  });
});

describe('reuseRows', () => {
  it('内容没变的行沿用上一次的对象，变了的换新', () => {
    const r1 = call('r1', 'read');
    const before = [user('u1'), assistant('a1', { text: 'x', calls: [r1, call('r2', 'read')] })];
    const first = buildTimelineRows(before, COMPACT);
    const grown = [
      before[0] as TimelineMessage,
      {
        ...(before[1] as TimelineMessage),
        toolCalls: [r1, call('r2', 'read', { status: 'error' })],
      },
    ];
    const second = reuseRows(first, buildTimelineRows(grown, COMPACT));
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);

    const third = reuseRows(second, buildTimelineRows(grown, COMPACT));
    expect(third[1]).toBe(second[1]);
  });

  it('折叠状态变了的标题行换新', () => {
    const messages = [user('u1'), assistant('a1'), user('u2')];
    const fold: TimelineRowOptions = { ...COMPACT, foldHistoryTurns: true };
    const closed = buildTimelineRows(messages, fold);
    const opened = reuseRows(
      closed,
      buildTimelineRows(messages, { ...fold, openTurns: new Set(['u1']) })
    );
    expect(opened[0]).not.toBe(closed[0]);
    expect(opened.at(-1)).toBe(closed.at(-1));
  });
});

describe('fileChangeOf', () => {
  it('edit：edits 数组，兼容单个对象、JSON 字符串与顶层 oldText / newText', () => {
    const edits = [{ oldText: 'a', newText: 'b' }];
    expect(fileChangeOf('edit', { path: 'src/a.ts', edits })).toEqual({
      kind: 'edit',
      path: 'src/a.ts',
      edits,
    });
    expect(fileChangeOf('edit', { path: 'a', edits: edits[0] })).toMatchObject({ edits });
    expect(fileChangeOf('edit', { path: 'a', edits: JSON.stringify(edits) })).toMatchObject({
      edits,
    });
    expect(fileChangeOf('edit', { path: 'a', oldText: 'a', newText: 'b' })).toMatchObject({
      edits,
    });
  });

  it('write：路径与内容', () => {
    expect(fileChangeOf('write', { path: 'README.md', content: '# hi\n' })).toEqual({
      kind: 'write',
      path: 'README.md',
      content: '# hi\n',
    });
  });

  it('其他工具或参数读不懂：null（照常显示参数）', () => {
    expect(fileChangeOf('read', { path: 'a' })).toBeNull();
    expect(fileChangeOf('edit', { path: 'a', edits: [{ oldText: 1 }] })).toBeNull();
    expect(fileChangeOf('edit', { path: 'a', edits: '{oops' })).toBeNull();
    expect(fileChangeOf('write', { path: 'a' })).toBeNull();
    expect(fileChangeOf('write', 'raw')).toBeNull();
  });
});

describe('diffEdit', () => {
  it('首尾相同的行作上下文，中间是删掉与加上的行', () => {
    expect(diffEdit({ oldText: 'a\nb\nc', newText: 'a\nB\nB2\nc' })).toEqual([
      { sign: ' ', text: 'a' },
      { sign: '-', text: 'b' },
      { sign: '+', text: 'B' },
      { sign: '+', text: 'B2' },
      { sign: ' ', text: 'c' },
    ]);
  });

  it('纯新增、纯删除、整段替换', () => {
    expect(diffEdit({ oldText: 'a', newText: 'a\nb' })).toEqual([
      { sign: ' ', text: 'a' },
      { sign: '+', text: 'b' },
    ]);
    expect(diffEdit({ oldText: 'a\nb', newText: 'b' })).toEqual([
      { sign: '-', text: 'a' },
      { sign: ' ', text: 'b' },
    ]);
    expect(diffEdit({ oldText: 'x', newText: 'y' })).toEqual([
      { sign: '-', text: 'x' },
      { sign: '+', text: 'y' },
    ]);
  });
});

describe('formatTurnTime', () => {
  it('当天只写时分，其他日子带日期，跨年带年份', () => {
    const now = new Date(2026, 9, 25, 15, 0).getTime();
    expect(formatTurnTime(new Date(2026, 9, 25, 9, 5).getTime(), now)).toBe('09:05');
    expect(formatTurnTime(new Date(2026, 9, 24, 23, 59).getTime(), now)).toBe('10-24 23:59');
    expect(formatTurnTime(new Date(2025, 11, 31, 8, 0).getTime(), now)).toBe('2025-12-31 08:00');
  });
});

describe('thinkingExpanded', () => {
  it('手动点过以手动为准；否则开关打开且正在流式思考时展开，结束后收起', () => {
    expect(thinkingExpanded(null, true, true)).toBe(true);
    expect(thinkingExpanded(null, false, true)).toBe(false);
    expect(thinkingExpanded(null, true, false)).toBe(false);
    expect(thinkingExpanded(false, true, true)).toBe(false);
    expect(thinkingExpanded(true, false, false)).toBe(true);
  });
});
