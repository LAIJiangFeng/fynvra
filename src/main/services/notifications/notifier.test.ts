import type { FynvraSessionEventBody, Message } from '@fynvra/core';
import type { ApprovalRequest, SessionEventEnvelope } from '@shared/types/chat';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
} from '@shared/types/settings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COALESCE_MS,
  createNotifier,
  type DesktopNotification,
  STARTUP_QUIET_MS,
} from './notifier';
import type { NotifiedSession, ViewState } from './rules';

const MAIN: NotifiedSession = { id: 'session-main', workspaceId: 'ws-1', title: '修复登录页' };
const OTHER: NotifiedSession = { id: 'session-other', workspaceId: 'ws-2', title: '写文档' };
const WORKER: NotifiedSession = {
  id: 'session-worker',
  workspaceId: 'ws-1',
  title: '补测试',
  dispatchId: 'dispatch_1',
};
const SESSIONS = new Map([MAIN, OTHER, WORKER].map((session) => [session.id, session]));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

function setup(prefs: Partial<NotificationPreferences> = {}) {
  const state: { prefs: NotificationPreferences; view: ViewState } = {
    prefs: { ...DEFAULT_NOTIFICATION_PREFERENCES, ...prefs },
    view: { focused: false, viewingSessionId: null },
  };
  const shown: DesktopNotification[] = [];
  const lookups: string[] = [];
  const logs: string[] = [];
  const show = vi.fn((notification: DesktopNotification) => {
    shown.push(notification);
  });
  const notifier = createNotifier({
    preferences: () => state.prefs,
    view: () => state.view,
    session: (id) => {
      lookups.push(id);
      return SESSIONS.get(id);
    },
    show,
    log: (message) => logs.push(message),
  });
  let seq = 0;
  const event = (session: NotifiedSession, body: FynvraSessionEventBody) => {
    const envelope = { sessionId: session.id, event: { ...body, seq: ++seq } };
    notifier.sessionEvent(envelope as SessionEventEnvelope);
  };
  /** 主 agent 一轮：用户消息 → 回答 → 结束 */
  const turn = (session: NotifiedSession, answer: string) => {
    event(session, { type: 'message_end', role: 'user', text: '问题' });
    event(session, { type: 'message_end', role: 'assistant', text: answer });
    event(session, { type: 'agent_settled', aborted: false });
  };
  const approval = (session: NotifiedSession, detail: string) =>
    notifier.approvalRequest({
      id: `req-${detail}`,
      sessionId: session.id,
      kind: 'command',
      title: 'bash',
      detail,
      expiresAt: Date.now() + 60_000,
    } satisfies ApprovalRequest);
  const message = (patch: Partial<Message>) =>
    notifier.message({
      id: 'msg_1',
      runId: 'run_1',
      dispatchId: 'dispatch_1',
      from: WORKER.id,
      to: MAIN.id,
      type: 'worker_done',
      subject: 'succeeded',
      body: '加好了',
      createdAt: 0,
      ...patch,
    });
  const pastStartup = () => vi.advanceTimersByTime(STARTUP_QUIET_MS);
  const flush = () => vi.advanceTimersByTime(COALESCE_MS);
  return {
    notifier,
    state,
    shown,
    show,
    lookups,
    logs,
    event,
    turn,
    approval,
    message,
    pastStartup,
    flush,
  };
}

describe('createNotifier', () => {
  it('主 agent 一轮结束：合并窗口结束时弹出，带声音设置与点击目标', () => {
    const env = setup();
    env.pastStartup();
    env.turn(MAIN, '改好了');
    expect(env.shown).toEqual([]);
    env.flush();
    expect(env.shown).toEqual([
      {
        title: '修复登录页',
        body: '改好了',
        silent: false,
        target: { sessionId: MAIN.id, workspaceId: 'ws-1' },
      },
    ]);
  });

  it('启动静默期内普通事件不弹也不补，操作通知按窗口合并后仍可弹', () => {
    const env = setup();
    env.turn(MAIN, '恢复时补发的');
    env.approval(MAIN, 'ls');
    env.event(MAIN, { type: 'tool_notice', toolCallId: 'c1', toolName: 'bash', kind: 'command' });
    expect(env.shown).toEqual([]);
    env.flush();
    expect(env.shown.map((notification) => notification.body)).toEqual([
      'bash · 执行命令，无需确认，继续执行。',
    ]);
    vi.advanceTimersByTime(STARTUP_QUIET_MS);
    env.turn(MAIN, '启动之后的');
    env.flush();
    expect(env.shown.map((notification) => notification.body)).toEqual([
      'bash · 执行命令，无需确认，继续执行。',
      '启动之后的',
    ]);
  });

  it('操作通知独立按会话合并并按 seq 去重，普通通知不被顶替', () => {
    const env = setup();
    env.pastStartup();
    const operation: SessionEventEnvelope = {
      sessionId: MAIN.id,
      event: {
        type: 'tool_notice',
        toolCallId: 'c1',
        toolName: 'bash',
        kind: 'command',
        seq: 100,
      },
    };
    env.notifier.sessionEvent(operation);
    expect(env.shown).toEqual([]);
    env.turn(MAIN, '先完成的');
    vi.advanceTimersByTime(1_000);
    env.notifier.sessionEvent({
      sessionId: MAIN.id,
      event: {
        type: 'tool_notice',
        toolCallId: 'c2',
        toolName: 'write',
        kind: 'file-write',
        seq: 101,
      },
    });
    env.turn(MAIN, '后完成的');
    env.turn(OTHER, '文档写好了');
    vi.advanceTimersByTime(1_000);
    expect(env.shown.map((notification) => notification.body)).toEqual([
      'write · 写入文件，无需确认，继续执行。',
      '后完成的',
    ]);
    vi.advanceTimersByTime(1_000);
    expect(env.shown.map((notification) => notification.body)).toEqual([
      'write · 写入文件，无需确认，继续执行。',
      '后完成的',
      '文档写好了',
    ]);
    env.notifier.sessionEvent(operation);
    env.notifier.sessionEvent({ ...operation, event: { ...operation.event, seq: 101 } });
    env.approval(MAIN, 'git push');
    env.flush();
    expect(env.shown).toHaveLength(3);
  });

  it('设置不允许的通知不会在合并窗口里顶替能弹的', () => {
    const env = setup();
    env.pastStartup();
    env.message({ type: 'question', body: '用哪张表？' });
    // 默认「仅主 agent 完成」：worker 的完成不弹，也不能把提问顶掉
    env.message({ type: 'worker_done', subject: 'succeeded', body: '加好了' });
    env.flush();
    expect(env.shown.map((notification) => notification.title)).toEqual(['补测试 · 提问']);
  });

  it('窗口结束时按当时的设置：期间关掉就不弹，声音取当时的', () => {
    const env = setup();
    env.pastStartup();
    env.turn(MAIN, '第一轮');
    env.state.prefs = { ...env.state.prefs, enabled: false };
    env.flush();
    expect(env.shown).toEqual([]);

    env.state.prefs = { ...env.state.prefs, enabled: true };
    env.turn(MAIN, '第二轮');
    env.state.prefs = { ...env.state.prefs, sound: false };
    env.flush();
    expect(env.shown).toEqual([expect.objectContaining({ body: '第二轮', silent: true })]);
  });

  it('窗口聚焦且正看着该会话时不弹；看别的会话或窗口没聚焦时照弹（按弹出那一刻）', () => {
    const env = setup();
    env.pastStartup();
    env.state.view = { focused: true, viewingSessionId: MAIN.id };
    env.turn(MAIN, '看着的');
    env.flush();
    expect(env.shown).toEqual([]);

    env.turn(OTHER, '别的会话');
    env.flush();
    env.state.view = { focused: false, viewingSessionId: MAIN.id };
    env.turn(MAIN, '最小化了');
    env.flush();
    // 事件到达时还看着，窗口结束前切走了
    env.state.view = { focused: true, viewingSessionId: MAIN.id };
    env.turn(MAIN, '切走了');
    env.state.view = { focused: true, viewingSessionId: OTHER.id };
    env.flush();
    expect(env.shown.map((notification) => notification.body)).toEqual([
      '别的会话',
      '最小化了',
      '切走了',
    ]);
  });

  it('worker 的完成 / 失败跟「仅主 agent 完成」走，提问、上报、审批跟「提问与审批」走', () => {
    const quiet = setup({ askAndApproval: false });
    quiet.pastStartup();
    quiet.message({ type: 'question', body: '用哪张表？' });
    quiet.message({ type: 'escalation', from: 'fynvra', body: '任务被放弃' });
    quiet.approval(WORKER, 'pnpm test');
    quiet.event(WORKER, {
      type: 'tool_notice',
      toolCallId: 'c1',
      toolName: 'bash',
      kind: 'command',
    });
    quiet.flush();
    expect(quiet.shown).toEqual([]);

    const all = setup({ mainAgentOnly: false });
    all.pastStartup();
    all.message({ type: 'worker_done', subject: 'failed', body: '依赖装不上' });
    all.message({ type: 'escalation', from: 'fynvra', body: '任务被放弃' });
    all.flush();
    expect(all.shown).toEqual([
      {
        title: '补测试 · 失败',
        body: '依赖装不上',
        silent: false,
        target: { sessionId: WORKER.id, workspaceId: 'ws-1' },
      },
      {
        title: '修复登录页 · 上报',
        body: '任务被放弃',
        silent: false,
        target: { sessionId: MAIN.id, workspaceId: 'ws-1' },
      },
    ]);
  });

  it('只为关心的事件查会话；会话不存在时不弹', () => {
    const env = setup();
    env.pastStartup();
    env.event(MAIN, { type: 'text_delta', delta: '流式' });
    env.event(MAIN, { type: 'tool_start', toolCallId: 'c1', toolName: 'read', args: {} });
    expect(env.lookups).toEqual([]);
    const gone: NotifiedSession = { id: 'session-gone', workspaceId: 'ws-1', title: '已删除' };
    env.turn(gone, '没人看');
    env.approval(gone, 'ls');
    env.flush();
    expect(env.shown).toEqual([]);
  });

  it('clear 丢掉还没弹的（退出时）；弹出失败只记日志', () => {
    const env = setup();
    env.pastStartup();
    env.turn(MAIN, '退出前');
    env.notifier.clear();
    env.flush();
    expect(env.shown).toEqual([]);

    env.show.mockImplementationOnce(() => {
      throw new Error('toast failed');
    });
    env.turn(MAIN, '弹不出来');
    expect(() => env.flush()).not.toThrow();
    expect(env.logs).toEqual([expect.stringContaining('toast failed')]);
  });
});
