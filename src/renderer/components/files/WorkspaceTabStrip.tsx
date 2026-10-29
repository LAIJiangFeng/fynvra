import {
  Children,
  createContext,
  isValidElement,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import {
  markWorkspaceInteraction,
  moveWorkspaceTab,
  useWorkspaceTabsStore,
} from '@/stores/workspaceTabs';

const MIME = 'application/x-fynvra-workspace-tab';
const StripContext = createContext<{
  workspaceId: string;
  dragged: RefObject<string | null>;
  target: { key: string; after: boolean } | null;
  setTarget(target: { key: string; after: boolean } | null): void;
} | null>(null);

export function WorkspaceTabStrip({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const order = useWorkspaceTabsStore((state) => state.views[workspaceId]?.order);
  const dragged = useRef<string | null>(null);
  const [target, setTarget] = useState<{ key: string; after: boolean } | null>(null);
  const scroll = useRef<HTMLFieldSetElement>(null);
  const speed = useRef(0);
  const frame = useRef(0);
  const scrollWhileDragging = () => {
    frame.current = 0;
    if (!dragged.current || !scroll.current || !speed.current) return;
    scroll.current.scrollLeft += speed.current;
    frame.current = requestAnimationFrame(scrollWhileDragging);
  };
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      dragged.current = null;
      speed.current = 0;
    },
    []
  );
  const tabs = Children.toArray(children).filter(isValidElement<{ tabKey: string }>);
  tabs.sort((a, b) => {
    const rank = (key: string) => {
      const index = order?.indexOf(key) ?? -1;
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    return rank(a.props.tabKey) - rank(b.props.tabKey);
  });
  return (
    <StripContext.Provider value={{ workspaceId, dragged, target, setTarget }}>
      <fieldset
        ref={scroll}
        className="m-0 flex min-w-0 flex-initial overflow-x-auto overflow-y-hidden border-0 p-0 [scrollbar-width:thin]"
        onDragOver={(event) => {
          if (!dragged.current || !event.dataTransfer.types.includes(MIME)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'none';
            return;
          }
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          speed.current =
            event.clientX < bounds.left + 40 ? -12 : event.clientX > bounds.right - 40 ? 12 : 0;
          if (speed.current && !frame.current)
            frame.current = requestAnimationFrame(scrollWhileDragging);
        }}
        onDragLeave={(event) => {
          const related = event.relatedTarget;
          if (!(related instanceof Node) || !event.currentTarget.contains(related)) {
            speed.current = 0;
            setTarget(null);
          }
        }}
        onDragEnd={() => {
          dragged.current = null;
          speed.current = 0;
          setTarget(null);
        }}
        onDrop={(event) => {
          event.preventDefault();
          speed.current = 0;
        }}
      >
        {tabs}
      </fieldset>
    </StripContext.Provider>
  );
}

export function WorkspaceTab({ tabKey, children }: { tabKey: string; children: ReactNode }) {
  const context = useContext(StripContext);
  const t = useT();
  const suppressClick = useRef(false);
  if (!context) return children;
  const { workspaceId, dragged, target, setTarget } = context;
  const accepted = (types: readonly string[]) => !!dragged.current && types.includes(MIME);
  return (
    <fieldset
      draggable
      className={cn(
        'relative m-0 flex min-w-0 shrink-0 border-0 p-0',
        target?.key === tabKey && (target.after ? 'after:right-0' : 'after:left-0'),
        target?.key === tabKey &&
          'after:pointer-events-none after:absolute after:inset-y-0 after:z-10 after:w-0.5 after:bg-primary'
      )}
      title={t('workspaceTabs.drag')}
      onPointerDownCapture={(event) => {
        // Close buttons retain their click/confirmation behavior and cannot start a drag.
        const close = (event.target as Element).closest('button[aria-label]');
        event.currentTarget.draggable = !close;
        suppressClick.current = false;
        markWorkspaceInteraction(workspaceId);
      }}
      onDragStart={(event) => {
        dragged.current = tabKey;
        suppressClick.current = true;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(MIME, workspaceId);
      }}
      onClickCapture={(event) => {
        if (suppressClick.current && event.detail !== 0) {
          event.preventDefault();
          event.stopPropagation();
          suppressClick.current = false;
        }
      }}
      onDragOver={(event) => {
        if (!accepted(event.dataTransfer.types)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const bounds = event.currentTarget.getBoundingClientRect();
        setTarget({ key: tabKey, after: event.clientX > bounds.left + bounds.width / 2 });
      }}
      onDrop={(event) => {
        if (
          !accepted(event.dataTransfer.types) ||
          event.dataTransfer.getData(MIME) !== workspaceId ||
          !dragged.current
        )
          return;
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        moveWorkspaceTab(
          workspaceId,
          dragged.current,
          tabKey,
          event.clientX > bounds.left + bounds.width / 2
        );
        dragged.current = null;
        setTarget(null);
      }}
    >
      {children}
    </fieldset>
  );
}
