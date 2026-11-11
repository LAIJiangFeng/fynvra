import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SessionsState } from '@/stores/sessions/createSessionsStore';
import { translatorOf } from '../../i18n';
import { ChatWarning } from './ChatView';

const data = vi.hoisted(() => ({ state: {} as SessionsState }));
vi.mock('@/i18n/I18nProvider', () => ({ useT: () => translatorOf('zh-CN') }));
// ChatView 的其它子组件会在模块加载时碰 window；这里只测 ChatWarning。
vi.mock('./ApprovalBar', () => ({}));
vi.mock('./Composer', () => ({}));
vi.mock('./NewSessionButton', () => ({}));
vi.mock('./SessionBadges', () => ({}));
vi.mock('./StatusBar', () => ({}));
vi.mock('./Timeline', () => ({}));
vi.mock('@/stores/settings', () => ({}));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (select: (state: SessionsState) => unknown) => select(data.state),
}));

function render(recoveryRequired: boolean) {
  data.state = {
    runtimeBySession: { s: { warning: 'magic-context', warningSeq: 3, recoveryRequired } },
    dismissWarning: vi.fn(),
  } as unknown as SessionsState;
  return renderToStaticMarkup(<ChatWarning sessionId="s" />);
}

describe('ChatWarning', () => {
  it('Magic Context 普通回退静默，不显示提示', () => {
    expect(render(false)).toBe('');
  });

  it('恢复锁仍在时显示锁定说明', () => {
    expect(render(true)).toContain(translatorOf('zh-CN')('chat.magicContextFallback'));
  });
});
