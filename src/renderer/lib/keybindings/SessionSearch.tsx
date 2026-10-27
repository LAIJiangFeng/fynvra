import type { SessionSummary } from '@shared/types/chat';
import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/I18nProvider';
import { useSessionsStore } from '@/stores/sessions';
import { useWorkspacesStore } from '@/stores/workspaces';
import { runAction, useActionHandler } from './handlers';
import { filterSessionsByTitle, searchOf, useSessionSearchStore } from './sessionFilter';
import { useChordLabel } from './useKeybindings';

/** 侧栏的会话列表按搜索框过滤；搜索框空着时原样返回 */
export function useFilteredSessions(
  workspaceId: string,
  sessions: SessionSummary[]
): SessionSummary[] {
  const query = useSessionSearchStore((state) => searchOf(state, workspaceId).query);
  return useMemo(() => filterSessionsByTitle(sessions, query), [sessions, query]);
}

/** 每组的搜索按钮；只有当前工作区处理全局搜索快捷键 */
export function SessionSearchButton({ workspaceId }: { workspaceId: string }) {
  const show = useSessionSearchStore((state) => state.show);
  const current = useWorkspacesStore((state) => state.selectedId === workspaceId);
  const chord = useChordLabel('search-sessions');
  const t = useT();
  useActionHandler('search-sessions', () => show(workspaceId), current);

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={t('sessions.search')}
      title={current ? t('sessions.searchHint', { chord }) : t('sessions.search')}
      onClick={() => show(workspaceId)}
    >
      <Search />
    </Button>
  );
}

/** 会话列表上方的搜索框：按标题过滤。Enter 打开第一个结果，Esc 清空收起；空着失焦时也收起 */
export function SessionSearchInput({ workspaceId }: { workspaceId: string }) {
  const { open, query, focusRequest } = useSessionSearchStore((state) =>
    searchOf(state, workspaceId)
  );
  const setQuery = (query: string) => useSessionSearchStore.getState().setQuery(workspaceId, query);
  const close = () => useSessionSearchStore.getState().close(workspaceId);
  const input = useRef<HTMLInputElement>(null);
  const focusedRequest = useRef(focusRequest);
  const t = useT();

  // 只响应新的搜索请求，重新展开列表不抢输入焦点
  useEffect(() => {
    if (focusRequest === focusedRequest.current) return;
    focusedRequest.current = focusRequest;
    input.current?.focus();
    input.current?.select();
  }, [focusRequest]);

  if (!open) return null;

  const dismiss = () => {
    close();
    runAction('focus-composer');
  };

  const openFirst = () => {
    const sessions = useSessionsStore.getState().sessionsByWorkspace[workspaceId] ?? [];
    const first = filterSessionsByTitle(sessions, query)[0];
    if (!first) return;
    close();
    void useSessionsStore.getState().selectSession(first.id, workspaceId);
    runAction('focus-composer');
  };

  return (
    <div className="relative mr-1 mb-1 ml-2">
      <input
        ref={input}
        value={query}
        aria-label={t('sessions.search')}
        placeholder={t('sessions.search')}
        className="h-7 w-full min-w-0 rounded-md border border-input bg-background pr-7 pl-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            dismiss();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            openFirst();
          }
        }}
        onBlur={() => {
          if (!searchOf(useSessionSearchStore.getState(), workspaceId).query.trim()) close();
        }}
      />
      {query && (
        <button
          type="button"
          aria-label={t('sessions.clearSearch')}
          title={t('sessions.clearSearch')}
          className="absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          // 不抢焦点：清空后接着在搜索框里输入
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setQuery('');
            input.current?.focus();
          }}
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
