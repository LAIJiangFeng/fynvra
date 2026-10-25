import type { SessionSummary } from '@shared/types/chat';
import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { useSessionsStore } from '@/stores/sessions';
import { runAction, useActionHandler } from './handlers';
import { filterSessionsByTitle, useSessionSearchStore } from './sessionFilter';
import { useChordLabel } from './useKeybindings';

/** 侧栏的会话列表按搜索框过滤；搜索框空着时原样返回 */
export function useFilteredSessions(sessions: SessionSummary[]): SessionSummary[] {
  const query = useSessionSearchStore((state) => state.query);
  return useMemo(() => filterSessionsByTitle(sessions, query), [sessions, query]);
}

/** 侧栏「会话」标题行上的搜索按钮。「搜索会话」快捷键也由它处理：侧栏没有会话分组时不拦截 */
export function SessionSearchButton() {
  const show = useSessionSearchStore((state) => state.show);
  const chord = useChordLabel('search-sessions');
  useActionHandler('search-sessions', show);

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="搜索会话"
      title={`搜索会话 ${chord}`}
      onClick={show}
    >
      <Search />
    </Button>
  );
}

/** 会话列表上方的搜索框：按标题过滤。Enter 打开第一个结果，Esc 清空收起；空着失焦时也收起 */
export function SessionSearchInput({ workspaceId }: { workspaceId: string }) {
  const open = useSessionSearchStore((state) => state.open);
  const query = useSessionSearchStore((state) => state.query);
  const focusRequest = useSessionSearchStore((state) => state.focusRequest);
  const setQuery = useSessionSearchStore((state) => state.setQuery);
  const close = useSessionSearchStore((state) => state.close);
  const input = useRef<HTMLInputElement>(null);

  // 每次「搜索会话」都聚焦并全选，已经开着时也是
  useEffect(() => {
    if (focusRequest === 0) return;
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
    void useSessionsStore.getState().selectSession(first.id);
    runAction('focus-composer');
  };

  return (
    <div className="relative mr-1 mb-1 ml-2">
      <input
        ref={input}
        value={query}
        aria-label="搜索会话"
        placeholder="搜索会话"
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
          if (!useSessionSearchStore.getState().query.trim()) close();
        }}
      />
      {query && (
        <button
          type="button"
          aria-label="清空"
          title="清空"
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
