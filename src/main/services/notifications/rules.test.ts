import type { FynvraSessionEventBody, Message } from '@fynvra/core';
import type { ApprovalRequest } from '@shared/types/chat';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
} from '@shared/types/settings';
import { describe, expect, it } from 'vitest';
import {
  allowedBy,
  approvalCandidate,
  createTurnTracker,
  excerpt,
  hiddenByView,
  messageCandidate,
  type NotificationCandidate,
  type NotificationKind,
  type NotifiedSession,
} from './rules';

const MAIN: NotifiedSession = { id: 'session-main', workspaceId: 'ws-1', title: '修复登录页' };
const WORKER: NotifiedSession = {
  id: 'session-worker',
  workspaceId: 'ws-1',
  title: '补测试',
  dispatchId: 'dispatch_1',
};

const KINDS: NotificationKind[] = [
  'turn-done',
  'turn-error',
  'worker-done',
  'worker-failed',
  'question',
  'escalation',
  'approval',
];

const prefs = (patch: Partial<NotificationPreferences> = {}): NotificationPreferences => ({
  ...DEFAULT_NOTIFICATION_PREFERENCES,
  ...patch,
});
const allowed = (preferences: NotificationPreferences) =>
  KINDS.filter((kind) => allowedBy(preferences, kind));

describe('allowedBy（设置允许弹哪些）', () => {
  it('默认：主 agent 的完成 / 出错、提问、上报、审批；worker 的完成 / 失败不弹', () => {
    expect(allowed(prefs())).toEqual([
      'turn-done',
      'turn-error',
      'question',
      'escalation',
      'approval',
    ]);
  });

  it('关掉「仅主 agent 完成」后 worker 的完成 / 失败也弹', () => {
    expect(allowed(prefs({ mainAgentOnly: false }))).toEqual(KINDS);
  });

  it('关掉「提问与审批」只剩完成 / 出错', () => {
    expect(allowed(prefs({ askAndApproval: false }))).toEqual(['turn-done', 'turn-error']);
    expect(allowed(prefs({ askAndApproval: false, mainAgentOnly: false }))).toEqual([
      'turn-done',
      'turn-error',
      'worker-done',
      'worker-failed',
    ]);
  });

  it('总开关关掉时什么都不弹，声音开关不影响', () => {
    expect(allowed(prefs({ enabled: false, mainAgentOnly: false }))).toEqual([]);
    expect(allowed(prefs({ sound: false }))).toEqual(allowed(prefs()));
  });
});

describe('hiddenByView（聚焦抑制）', () => {
  const candidate = { sessionId: MAIN.id } as NotificationCandidate;

  it('窗口聚焦且正看着该会话时不弹', () => {
    expect(hiddenByView(candidate, { focused: true, viewingSessionId: MAIN.id })).toBe(true);
  });

  it('看着别的会话、没选会话、或窗口没聚焦（最小化、切到别的应用）时照弹', () => {
    expect(hiddenByView(candidate, { focused: true, viewingSessionId: WORKER.id })).toBe(false);
    expect(hiddenByView(candidate, { focused: true, viewingSessionId: null })).toBe(false);
    expect(hiddenByView(candidate, { focused: false, viewingSessionId: MAIN.id })).toBe(false);
  });
});

describe('excerpt（正文前 80 字）', () => {
  it('压成一行、去掉首尾空白', () => {
    expect(excerpt('  第一行\n\n  第二行\t结束  ')).toBe('第一行 第二行 结束');
  });

  it('超过 80 字截断：79 字加省略号；按字符计，不拆开 emoji', () => {
    const long = '字'.repeat(100);
    expect(excerpt(long)).toBe(`${'字'.repeat(79)}…`);
    expect(Array.from(excerpt(long))).toHaveLength(80);
    expect(excerpt('字'.repeat(80))).toBe('字'.repeat(80));
    const emoji = `${'a'.repeat(78)}😀😀😀`;
    expect(excerpt(emoji)).toBe(`${'a'.repeat(78)}😀…`);
  });

  it('去掉 Markdown 的标题、引用、列表标记、加粗和反引号', () => {
    expect(excerpt('## 结果\n> 已完成\n- 改了 `Login.tsx`\n* **全部通过**')).toBe(
      '结果 已完成 改了 Login.tsx 全部通过'
    );
    expect(excerpt('report_done 与 snake_case 保留')).toBe('report_done 与 snake_case 保留');
  });
});

/** 一轮：用户消息 → 若干事件 → settle，返回每个事件对应的候选（null 省略） */
function run(
  tracker: ReturnType<typeof createTurnTracker>,
  session: NotifiedSession,
  events: FynvraSessionEventBody[]
): NotificationCandidate[] {
  return events.flatMap((event) => tracker.push(session, event) ?? []);
}

const user = (text: string): FynvraSessionEventBody => ({
  type: 'message_end',
  role: 'user',
  text,
});
const assistant = (text: string): FynvraSessionEventBody => ({
  type: 'message_end',
  role: 'assistant',
  text,
  stopReason: 'stop',
});
const settled = (aborted = false): FynvraSessionEventBody => ({ type: 'agent_settled', aborted });
const error = (message: string): FynvraSessionEventBody => ({
  type: 'error',
  source: 'model',
  message,
});

describe('createTurnTracker（会话事件 → 通知）', () => {
  it('主 agent 回合结束：标题是会话标题，正文是最后一条 assistant 文本', () => {
    const tracker = createTurnTracker();
    expect(
      run(tracker, MAIN, [
        user('修一下登录页'),
        assistant('先看看样式。'),
        { type: 'tool_start', toolCallId: 'c1', toolName: 'read', args: {} },
        { type: 'text_delta', delta: '改好了' },
        assistant('改好了：Login.tsx 的间距。'),
        assistant(''),
        settled(),
      ])
    ).toEqual([
      {
        kind: 'turn-done',
        sessionId: MAIN.id,
        workspaceId: 'ws-1',
        title: '修复登录页',
        body: '改好了：Login.tsx 的间距。',
      },
    ]);
  });

  it('一轮没有文字时正文是「完成」', () => {
    const tracker = createTurnTracker();
    expect(run(tracker, MAIN, [user('跑一下'), settled()])).toMatchObject([{ body: '完成' }]);
  });

  it('出错另弹一条，这一轮结束时不再弹完成；下一轮照常', () => {
    const tracker = createTurnTracker();
    expect(
      run(tracker, MAIN, [user('修一下'), assistant(''), error('429 rate limited'), settled()])
    ).toEqual([
      {
        kind: 'turn-error',
        sessionId: MAIN.id,
        workspaceId: 'ws-1',
        title: '修复登录页 · 出错',
        body: '429 rate limited',
      },
    ]);
    expect(run(tracker, MAIN, [user('再试'), assistant('好了'), settled()])).toMatchObject([
      { kind: 'turn-done', body: '好了' },
    ]);
  });

  it('回合外的出错（如启动会话失败）不影响下一轮的完成通知', () => {
    const tracker = createTurnTracker();
    expect(run(tracker, MAIN, [error('角色不存在：x')])).toMatchObject([{ kind: 'turn-error' }]);
    expect(run(tracker, MAIN, [user('再试'), assistant('好了'), settled()])).toMatchObject([
      { kind: 'turn-done' },
    ]);
  });

  it('中止（用户停止、会话被删）不弹；崩溃时先到的 error 照弹', () => {
    const tracker = createTurnTracker();
    expect(run(tracker, MAIN, [user('写个脚本'), assistant('写到一半'), settled(true)])).toEqual(
      []
    );
    expect(
      run(tracker, MAIN, [user('再来'), error('agent worker 进程意外退出'), settled(true)])
    ).toMatchObject([{ kind: 'turn-error', body: 'agent worker 进程意外退出' }]);
  });

  it('worker 会话：回合结束不弹（看 worker_done），出错按 worker 失败', () => {
    const tracker = createTurnTracker();
    expect(run(tracker, WORKER, [user('任务书'), assistant('做完了'), settled()])).toEqual([]);
    expect(run(tracker, WORKER, [user('任务书'), error('overloaded'), settled()])).toEqual([
      {
        kind: 'worker-failed',
        sessionId: WORKER.id,
        workspaceId: 'ws-1',
        title: '补测试 · 出错',
        body: 'overloaded',
      },
    ]);
  });

  it('各会话的回合互不影响', () => {
    const tracker = createTurnTracker();
    const other: NotifiedSession = { id: 'session-other', workspaceId: 'ws-2', title: '另一个' };
    tracker.push(MAIN, user('a'));
    tracker.push(other, user('b'));
    tracker.push(MAIN, assistant('主会话的回答'));
    tracker.push(other, error('boom'));
    expect(tracker.push(MAIN, settled())).toMatchObject({ body: '主会话的回答' });
    expect(tracker.push(other, settled())).toBeNull();
  });
});

describe('approvalCandidate（审批请求）', () => {
  it('标题带「待审批」，正文是工具与命令；任何会话都一样', () => {
    const request: ApprovalRequest = {
      id: 'req-1',
      sessionId: WORKER.id,
      kind: 'command',
      title: 'bash（保护底线：git push）',
      detail: 'git push origin main\n--force-with-lease',
      expiresAt: 0,
    };
    expect(approvalCandidate(WORKER, request)).toEqual({
      kind: 'approval',
      sessionId: WORKER.id,
      workspaceId: 'ws-1',
      title: '补测试 · 待审批',
      body: 'bash（保护底线：git push）：git push origin main --force-with-lease',
    });
  });
});

describe('messageCandidate（收件箱消息）', () => {
  const sessions = new Map([MAIN, WORKER].map((session) => [session.id, session]));
  const lookup = (id: string) => sessions.get(id);
  const message = (patch: Partial<Message>): Message => ({
    id: 'msg_1',
    runId: 'run_1',
    dispatchId: 'dispatch_1',
    from: WORKER.id,
    to: MAIN.id,
    type: 'worker_done',
    body: '',
    createdAt: 0,
    ...patch,
  });

  it('worker_done：按结果分完成 / 失败，点开是 worker 会话，正文是汇报', () => {
    expect(
      messageCandidate(
        message({
          subject: 'succeeded',
          body: '加好了开关\n\nFiles modified (1):\n- src/a.ts',
        }),
        lookup
      )
    ).toEqual({
      kind: 'worker-done',
      sessionId: WORKER.id,
      workspaceId: 'ws-1',
      title: '补测试 · 完成',
      body: '加好了开关 Files modified (1): src/a.ts',
    });
    expect(
      messageCandidate(message({ subject: 'failed (follow-up)', body: '依赖装不上' }), lookup)
    ).toMatchObject({ kind: 'worker-failed', title: '补测试 · 失败', body: '依赖装不上' });
  });

  it('question：worker 提问', () => {
    expect(messageCandidate(message({ type: 'question', body: '用哪张表？' }), lookup)).toEqual({
      kind: 'question',
      sessionId: WORKER.id,
      workspaceId: 'ws-1',
      title: '补测试 · 提问',
      body: '用哪张表？',
    });
  });

  it('escalation：发送方不是会话（Fynvra 自己）时点开主 agent 会话', () => {
    expect(
      messageCandidate(
        message({ type: 'escalation', from: 'fynvra', dispatchId: undefined, body: '任务被放弃' }),
        lookup
      )
    ).toEqual({
      kind: 'escalation',
      sessionId: MAIN.id,
      workspaceId: 'ws-1',
      title: '修复登录页 · 上报',
      body: '任务被放弃',
    });
  });

  it('主 agent 发给 worker 的消息、心跳不弹；找不到会话时不弹', () => {
    for (const type of ['reply', 'instruction', 'heartbeat'] as const) {
      expect(messageCandidate(message({ type, from: MAIN.id, to: WORKER.id }), lookup)).toBeNull();
    }
    expect(
      messageCandidate(message({ type: 'question', from: 'gone', to: 'gone-too' }), lookup)
    ).toBeNull();
  });
});
