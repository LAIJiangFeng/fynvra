import type { CompactionState } from '@fynvra/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionsState } from '@/stores/sessions/createSessionsStore';
import { translatorOf } from '../../i18n';
import { ElapsedWait } from './ElapsedWait';
import { GenerationProgress } from './GenerationProgress';

const data = vi.hoisted(() => ({ state: {} as SessionsState }));
vi.mock('@/i18n/I18nProvider', () => ({ useT: () => translatorOf('zh-CN') }));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (select: (state: SessionsState) => unknown) => select(data.state),
  isBusy: (status: string) => status === 'running' || status === 'waiting-approval',
}));

const compaction: CompactionState = {
  operationId: 'op',
  reason: 'threshold',
  phase: 'running',
  startedAt: 1_000,
  deadlineAt: 601_000,
  attempt: 2,
  maxAttempts: 3,
};
function state() {
  data.state = {
    runtimeBySession: {
      s: {
        lastSeq: 2,
        status: 'running',
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        toolStartedAt: {},
        compaction,
      },
    },
    recoveringCompaction: {},
    stopping: {},
    retryCompaction: vi.fn(),
  } as unknown as SessionsState;
}
afterEach(() => vi.useRealTimers());

describe('generation progress presentation', () => {
  it('shows compaction immediately, and preserves elapsed time on remount without live-region ticking', () => {
    state();
    vi.useFakeTimers();
    vi.setSystemTime(11_000);
    const html = renderToStaticMarkup(
      <GenerationProgress sessionId="s" status="running" showWorking={false} error={undefined} />
    );
    expect(html).toContain('正在压缩历史记录');
    expect(html).toContain('已等待 10 秒');
    expect(html).toMatch(/aria-hidden="true"[^>]*>已等待 10 秒/);
    expect(html).not.toMatch(/role="status"[^>]*>已等待/);
    vi.setSystemTime(31_000);
    expect(renderToStaticMarkup(<ElapsedWait startedAt={compaction.startedAt} />)).toContain(
      '已等待 30 秒'
    );
  });

  it('shows retry attempts without replacing the compaction start timestamp', () => {
    state();
    data.state.runtimeBySession.s.retry = {
      kind: 'summarization',
      phase: 'backoff',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1_000,
    };
    vi.useFakeTimers();
    vi.setSystemTime(21_000);
    const html = renderToStaticMarkup(
      <GenerationProgress sessionId="s" status="running" showWorking={false} error={undefined} />
    );
    expect(html).toContain('摘要请求失败，正在重试 第 2/3 次');
    expect(html).toContain('已等待 20 秒');
  });

  it('shows model retry attempts separately from history compaction', () => {
    state();
    data.state.runtimeBySession.s.compaction = undefined;
    data.state.runtimeBySession.s.retry = {
      kind: 'model',
      phase: 'backoff',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1_000,
    };
    const html = renderToStaticMarkup(
      <GenerationProgress sessionId="s" status="running" showWorking={false} error={undefined} />
    );
    expect(html).toContain('请求失败，正在重试 第 2/3 次');
    expect(html).not.toContain('正在压缩历史记录');
  });

  it('replaces the spinner with a precise timeout reason and explicit retry button', () => {
    state();
    data.state.runtimeBySession.s.compaction = {
      ...compaction,
      phase: 'cancelled',
      cancelSource: 'timeout',
    };
    data.state.runtimeBySession.s.recoveryRequired = true;
    const html = renderToStaticMarkup(
      <GenerationProgress sessionId="s" status="idle" showWorking={false} error={undefined} />
    );
    expect(html).toContain('历史压缩超时，原会话已保留，可重试');
    expect(html).toContain('重试历史压缩');
    expect(html).not.toContain('animate-spin');
  });

  it('does not display a failure for an SDK hook cancellation that needs no recovery', () => {
    state();
    data.state.runtimeBySession.s.compaction = {
      ...compaction,
      phase: 'cancelled',
      cancelSource: 'sdk',
    };
    data.state.runtimeBySession.s.recoveryRequired = false;
    const html = renderToStaticMarkup(
      <GenerationProgress sessionId="s" status="idle" showWorking={false} error={undefined} />
    );
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('重试历史压缩');
  });

  it('keeps approvals visible and keeps ordinary short idle sessions quiet', () => {
    state();
    data.state.runtimeBySession.s.compaction = undefined;
    const approval = renderToStaticMarkup(
      <GenerationProgress
        sessionId="s"
        status="waiting-approval"
        showWorking={true}
        error={undefined}
      />
    );
    expect(approval).toContain(translatorOf('zh-CN')('sessions.status.waiting-approval'));
    const idle = renderToStaticMarkup(
      <GenerationProgress sessionId="s" status="idle" showWorking={false} error={undefined} />
    );
    expect(idle).not.toContain('role="status"');
    expect(idle).not.toContain('animate-spin');
  });
});
