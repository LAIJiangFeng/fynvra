import type { Message } from '@fynvra/core';
import type { ApprovalRequest, SessionEventEnvelope, SessionSummary } from '@shared/types/chat';
import { IPC_CHANNELS } from '@shared/types/ipc';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
} from '@shared/types/settings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionObserver } from '../services/agentHost/agentHost';
import { COALESCE_MS, STARTUP_QUIET_MS } from '../services/notifications/notifier';

const mocks = vi.hoisted(() => {
  class FakeNotification {
    static isSupported = () => mocks.supported;
    readonly listeners = new Map<string, () => void>();
    readonly show = vi.fn();
    constructor(readonly options: { title: string; body: string; silent: boolean }) {
      mocks.notifications.push(this);
    }
    on(event: string, listener: () => void) {
      this.listeners.set(event, listener);
      return this;
    }
  }
  const window = {
    isDestroyed: () => false,
    isMinimized: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { id: 7, isDestroyed: () => false, send: vi.fn() },
  };
  return {
    FakeNotification,
    window,
    supported: true,
    focused: null as typeof window | null,
    notifications: [] as InstanceType<typeof FakeNotification>[],
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    appListeners: new Map<string, () => void>(),
    preferences: {} as Record<string, unknown>,
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/fynvra-test/userData',
    on: (event: string, listener: () => void) => mocks.appListeners.set(event, listener),
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
  BrowserWindow: {
    getAllWindows: () => [mocks.window],
    getFocusedWindow: () => mocks.focused,
    fromWebContents: () => null,
  },
  Notification: mocks.FakeNotification,
  dialog: {},
  nativeTheme: { themeSource: 'system', shouldUseDarkColors: false },
}));
vi.mock('./settings', () => ({
  getSettingsFile: () => ({ read: () => ({ preferences: mocks.preferences }) }),
}));
// 默认的数据源会起 agent host（fork worker）；用例都注入假的
vi.mock('./sessions', () => ({ getAgentHost: vi.fn() }));
vi.mock('./orchestration', () => ({ getOrchestrationRegistry: vi.fn() }));

const MAIN = {
  id: 'session-main',
  workspaceId: 'ws-1',
  title: '修复登录页',
} as SessionSummary;
const OTHER = { id: 'session-other', workspaceId: 'ws-2', title: '写文档' } as SessionSummary;

/** 发给 handler 的 IpcMainInvokeEvent：只用到 sender 的 id 与 once */
const sender = { id: 7, once: vi.fn() };
const invoke = (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)?.({ sender }, ...args);

let observer: SessionObserver;
let onMessage: (workspaceId: string, message: Message) => void;

async function register(prefs: Partial<NotificationPreferences> = {}) {
  mocks.preferences = { notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, ...prefs } };
  const { registerNotificationHandlers } = await import('./notifications');
  registerNotificationHandlers({
    host: () => ({
      get: (id: string) => [MAIN, OTHER].find((session) => session.id === id),
      observe: (next: SessionObserver) => {
        observer = next;
        return () => {};
      },
    }),
    registry: () => ({
      onMessage: (listener) => {
        onMessage = listener;
        return () => {};
      },
    }),
  });
}

let seq = 0;
function finishTurn(session: SessionSummary, answer: string) {
  const send = (event: SessionEventEnvelope['event']) =>
    observer.event?.({ sessionId: session.id, event });
  send({ type: 'message_end', role: 'user', text: '问题', seq: ++seq });
  send({ type: 'message_end', role: 'assistant', text: answer, seq: ++seq });
  send({ type: 'agent_settled', aborted: false, seq: ++seq });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  mocks.supported = true;
  mocks.focused = null;
  mocks.notifications.length = 0;
  mocks.handlers.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('notifications IPC', () => {
  it('registers every notifications channel', async () => {
    await register();
    const channels = Object.entries(IPC_CHANNELS)
      .filter(([name]) => name.startsWith('NOTIFICATIONS_'))
      .map(([, channel]) => channel);
    expect(channels.length).toBeGreaterThan(0);
    for (const channel of channels) expect(mocks.handlers.has(channel)).toBe(true);
  });

  it('notifications:test pops one right away with the sound switch, and takes no arguments', async () => {
    await register({ sound: false });
    expect(await invoke(IPC_CHANNELS.NOTIFICATIONS_TEST)).toEqual({ ok: true });
    expect(mocks.notifications.map((notification) => notification.options)).toEqual([
      { title: 'Fynvra', body: '测试通知', silent: true },
    ]);
    expect(mocks.notifications[0]?.show).toHaveBeenCalledOnce();

    for (const raw of [null, {}, 'now', { sessionId: MAIN.id }]) {
      expect(await invoke(IPC_CHANNELS.NOTIFICATIONS_TEST, raw)).toEqual({
        ok: false,
        error: '无效的参数',
      });
    }
    expect(mocks.notifications).toHaveLength(1);
  });

  it('notifications:test reports when the system cannot show notifications', async () => {
    await register();
    mocks.supported = false;
    expect(await invoke(IPC_CHANNELS.NOTIFICATIONS_TEST)).toEqual({
      ok: false,
      error: '系统不支持桌面通知',
    });
    expect(mocks.notifications).toEqual([]);
  });

  it('notifications:set-viewing takes only { sessionId: <session id> | null }', async () => {
    await register();
    expect(await invoke(IPC_CHANNELS.NOTIFICATIONS_SET_VIEWING, { sessionId: MAIN.id })).toEqual({
      ok: true,
    });
    expect(await invoke(IPC_CHANNELS.NOTIFICATIONS_SET_VIEWING, { sessionId: null })).toEqual({
      ok: true,
    });
    for (const raw of [
      undefined,
      null,
      MAIN.id,
      {},
      { sessionId: 7 },
      { sessionId: '' },
      { sessionId: '../escape' },
      { sessionId: MAIN.id, workspaceId: 'ws-1' },
      [{ sessionId: MAIN.id }],
    ]) {
      expect(await invoke(IPC_CHANNELS.NOTIFICATIONS_SET_VIEWING, raw)).toEqual({
        ok: false,
        error: '无效的会话 id',
      });
    }
  });

  it('pops session notifications unless the focused window is showing that session', async () => {
    await register();
    vi.advanceTimersByTime(STARTUP_QUIET_MS);
    mocks.focused = mocks.window;
    await invoke(IPC_CHANNELS.NOTIFICATIONS_SET_VIEWING, { sessionId: MAIN.id });

    finishTurn(MAIN, '看着的');
    finishTurn(OTHER, '文档写好了');
    vi.advanceTimersByTime(COALESCE_MS);
    expect(mocks.notifications.map((notification) => notification.options)).toEqual([
      { title: '写文档', body: '文档写好了', silent: false },
    ]);

    mocks.focused = null;
    observer.approval?.({
      id: 'req-1',
      sessionId: MAIN.id,
      kind: 'command',
      title: 'bash',
      detail: 'git push',
      expiresAt: 0,
    } satisfies ApprovalRequest);
    onMessage('ws-1', {
      id: 'msg_1',
      runId: 'run_1',
      from: 'fynvra',
      to: OTHER.id,
      type: 'escalation',
      body: '任务被放弃',
      createdAt: 0,
    });
    vi.advanceTimersByTime(COALESCE_MS);
    expect(mocks.notifications.slice(1).map((notification) => notification.options.title)).toEqual([
      '修复登录页 · 待审批',
      '写文档 · 上报',
    ]);
  });

  it('clicking a notification restores and focuses the window, then asks the renderer to open the session', async () => {
    await register();
    vi.advanceTimersByTime(STARTUP_QUIET_MS);
    finishTurn(OTHER, '文档写好了');
    vi.advanceTimersByTime(COALESCE_MS);

    mocks.notifications[0]?.listeners.get('click')?.();
    expect(mocks.window.restore).toHaveBeenCalledOnce();
    expect(mocks.window.focus).toHaveBeenCalledOnce();
    expect(mocks.window.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.SESSIONS_FOCUS, {
      sessionId: OTHER.id,
      workspaceId: 'ws-2',
    });
  });

  it('drops pending notifications on quit', async () => {
    await register();
    vi.advanceTimersByTime(STARTUP_QUIET_MS);
    finishTurn(OTHER, '退出前');
    mocks.appListeners.get('before-quit')?.();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(mocks.notifications).toEqual([]);
  });
});
