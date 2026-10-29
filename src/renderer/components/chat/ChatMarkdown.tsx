import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { type Components, defaultUrlTransform, type UrlTransform } from 'react-markdown';
import type { T } from '@/i18n';
import { useT } from '@/i18n/I18nProvider';
import {
  type ChatFileContext,
  ChatFileLinkError,
  type ChatLinkError,
  externalChatLink,
  openChatFileLink,
} from '@/lib/chatFileLinks';
import { filesStoreFor } from '@/stores/files';
import { selectSessionOf, useSessionsStore } from '@/stores/sessions';
import { useWorkspacesStore } from '@/stores/workspaces';
import { ensureWorkspaceTabs, selectWorkspaceTab } from '@/stores/workspaceTabs';
import { Markdown } from './Markdown';

const LINK_CLASS = 'font-medium text-primary underline underline-offset-4';
const chatHrefs = new WeakMap<object, string>();

/** 原始 href 只按 AST 节点弱关联，不落到 DOM 属性；其他 URL 继续使用默认过滤。 */
export const chatUrlTransform: UrlTransform = (value, key, node) => {
  if (node.tagName === 'a' && key === 'href') {
    chatHrefs.set(node, value);
    return externalChatLink(value) ?? '';
  }
  return defaultUrlTransform(value);
};

function linkError(t: T, code: ChatLinkError): string {
  switch (code) {
    case 'invalidLink':
    case 'unsupportedRoot':
    case 'unsupportedParameters':
    case 'sessionUnavailable':
      return t(`chat.fileLinks.${code}`);
    case 'truncated':
      return t('files.truncated');
    case 'tabLimit':
      return t('workspaceTabs.limits');
    default:
      return t(`files.errors.${code}`);
  }
}

function ChatFileLink({
  reference,
  context,
  children,
  title,
}: {
  reference: string;
  context: ChatFileContext | undefined;
  children: ReactNode;
  title?: string;
}) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ChatLinkError | null>(null);
  const request = useRef<symbol | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 源链接/会话改变或卸载时取消旧点击。
  useEffect(() => {
    setPending(false);
    setError(null);
    return () => {
      request.current = null;
    };
  }, [reference, context]);
  const external = externalChatLink(reference);
  if (external)
    return (
      <a href={external} target="_blank" rel="noreferrer" title={title} className={LINK_CLASS}>
        {children}
      </a>
    );

  async function open() {
    if (request.current) return;
    const token = Symbol();
    request.current = token;
    setPending(true);
    setError(null);
    const isCurrent = () => request.current === token;
    try {
      if (!context) throw new ChatFileLinkError('sessionUnavailable');
      const api = window.fynvra.files;
      if (!api?.openHtml) throw new ChatFileLinkError('restartRequired');
      await openChatFileLink(
        api,
        context,
        reference,
        async (workspaceId, entry) => {
          // 沿用现有 hydration / openFile，已恢复或编辑中的草稿不会被重新读取覆盖。
          await ensureWorkspaceTabs(workspaceId);
          if (!isCurrent()) return;
          if (!useWorkspacesStore.getState().workspaces.some((item) => item.id === workspaceId))
            throw new ChatFileLinkError('workspaceNotFound');
          const store = filesStoreFor(workspaceId, api);
          const opening = store.getState().openFile(entry);
          if (!store.getState().opened.some((file) => file.id === entry.id))
            throw new ChatFileLinkError('tabLimit');
          useWorkspacesStore.getState().select(workspaceId);
          selectWorkspaceTab(workspaceId, `file:${entry.id}`);
          await opening;
        },
        isCurrent
      );
    } catch (caught) {
      if (isCurrent()) setError(caught instanceof ChatFileLinkError ? caught.code : 'unavailable');
    } finally {
      if (isCurrent()) {
        request.current = null;
        setPending(false);
      }
    }
  }

  return (
    <span>
      <button
        type="button"
        title={title ?? reference}
        className={LINK_CLASS}
        disabled={pending}
        onClick={() => void open()}
      >
        {children}
      </button>
      {pending && (
        <span role="status" className="ml-2 text-muted-foreground text-xs">
          {t('chat.fileLinks.opening')}
        </span>
      )}
      {error && (
        <span role="alert" className="ml-2 text-destructive text-xs">
          {linkError(t, error)}
        </span>
      )}
    </span>
  );
}

/** 只按消息的 sessionId 取上下文，从不使用点击时的 activeSession/workspace。 */
export function ChatMarkdown({
  sessionId,
  text,
  streaming,
}: {
  sessionId: string;
  text: string;
  streaming?: boolean;
}) {
  const session = useSessionsStore(selectSessionOf(sessionId));
  const id = session?.id;
  const workspaceId = session?.workspaceId;
  const cwd = session?.cwd;
  const worktreeId = session?.worktreeId;
  const context = useMemo<ChatFileContext | undefined>(
    () => (id && workspaceId && cwd ? { id, workspaceId, cwd, worktreeId } : undefined),
    [id, workspaceId, cwd, worktreeId]
  );
  const components = useMemo<Components>(
    () => ({
      a: ({ node, children, title }) => (
        <ChatFileLink
          reference={node ? (chatHrefs.get(node) ?? '') : ''}
          context={context}
          title={title}
        >
          {children}
        </ChatFileLink>
      ),
    }),
    [context]
  );
  return (
    <Markdown
      text={text}
      streaming={streaming}
      components={components}
      urlTransform={chatUrlTransform}
    />
  );
}
