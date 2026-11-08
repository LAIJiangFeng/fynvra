import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Components, defaultUrlTransform, type UrlTransform } from 'react-markdown';
import { MENU_ICONS, type MenuItem, TreeContextMenu } from '@/components/files/FileTreeContextMenu';
import type { T } from '@/i18n';
import { useT } from '@/i18n/I18nProvider';
import {
  type ChatFileContext,
  ChatFileLinkError,
  type ChatLinkError,
  externalChatLink,
  locateChatFile,
  openChatFileLink,
  openOutsideChatFile,
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
    case 'openFailed':
      return t(`chat.fileLinks.${code}`);
    case 'truncated':
      return t('files.truncated');
    case 'tabLimit':
      return t('workspaceTabs.limits');
    default:
      return t(`files.errors.${code}`);
  }
}

interface LinkFailure {
  code: ChatLinkError;
  /** 工作区外文件的路径，写进错误文案，方便用户知道文件在哪 */
  path?: string;
}

function failureText(t: T, { code, path }: LinkFailure): string {
  if (!path) return linkError(t, code);
  const message = code === 'entryNotFound' ? t('chat.fileLinks.notFound') : linkError(t, code);
  return t('chat.fileLinks.withPath', { message, path });
}

const failureOf = (caught: unknown): LinkFailure =>
  caught instanceof ChatFileLinkError
    ? { code: caught.code, path: caught.outsidePath }
    : { code: 'unavailable' };

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 剪贴板被占用时静默失败；悬停 title 仍显示完整路径
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
  const [error, setError] = useState<LinkFailure | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const request = useRef<symbol | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 源链接/会话改变或卸载时取消旧点击。
  useEffect(() => {
    setPending(false);
    setError(null);
    setRevealed(false);
    return () => {
      request.current = null;
    };
  }, [reference, context]);
  useEffect(() => {
    if (!revealed) return;
    const timer = window.setTimeout(() => setRevealed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [revealed]);
  const external = externalChatLink(reference);
  if (external)
    return (
      <a href={external} target="_blank" rel="noreferrer" title={title} className={LINK_CLASS}>
        {children}
      </a>
    );

  /** 同一时间只跑一个链接动作；链接 / 会话变化后迟到的结果丢弃。 */
  async function run(
    action: (
      api: NonNullable<typeof window.fynvra.files>,
      context: ChatFileContext,
      isCurrent: () => boolean
    ) => Promise<{ revealed: boolean } | undefined>
  ) {
    if (request.current) return;
    const token = Symbol();
    request.current = token;
    setPending(true);
    setError(null);
    setRevealed(false);
    const isCurrent = () => request.current === token;
    try {
      if (!context) throw new ChatFileLinkError('sessionUnavailable');
      const api = window.fynvra.files;
      if (!api?.openHtml) throw new ChatFileLinkError('restartRequired');
      const result = await action(api, context, isCurrent);
      if (isCurrent() && result?.revealed) setRevealed(true);
    } catch (caught) {
      if (isCurrent()) setError(failureOf(caught));
    } finally {
      if (isCurrent()) {
        request.current = null;
        setPending(false);
      }
    }
  }

  const open = () =>
    run((api, context, isCurrent) =>
      openChatFileLink(
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
      )
    );

  const reveal = () =>
    run(async (api, context, isCurrent) => {
      const target = await locateChatFile(api, context, reference);
      if (!isCurrent()) return undefined;
      if (target.kind === 'outside')
        return openOutsideChatFile(api, context, reference, target.path, 'reveal');
      const result = await api.reveal({
        workspaceId: context.workspaceId,
        entryId: target.entry.id,
      });
      if (!result.ok) throw new ChatFileLinkError(result.error);
      return undefined;
    });

  /** 工作区外复制解析后的绝对路径，工作区内复制 resolve 后的完整路径，拿不到就复制原 reference。 */
  async function copyPath() {
    let text = reference;
    try {
      const api = window.fynvra.files;
      if (context && api) {
        const target = await locateChatFile(api, context, reference);
        if (target.kind === 'outside') text = target.path;
        else {
          const result = await api.resolve({
            workspaceId: context.workspaceId,
            entryId: target.entry.id,
          });
          if (result.ok) text = result.path;
        }
      }
    } catch {
      // 解析失败时复制原始链接
    }
    await copyText(text);
  }

  const menuItems: MenuItem[] = [
    {
      id: 'open',
      label: t('chat.fileLinks.open'),
      icon: MENU_ICONS.view,
      onSelect: () => void open(),
    },
    {
      id: 'reveal',
      label: t('chat.fileLinks.reveal'),
      icon: MENU_ICONS.reveal,
      onSelect: () => void reveal(),
    },
    {
      id: 'copy-path',
      label: t('chat.fileLinks.copyPath'),
      icon: MENU_ICONS.copyPath,
      onSelect: () => void copyPath(),
    },
  ];

  return (
    <span>
      <button
        type="button"
        title={title ?? reference}
        className={LINK_CLASS}
        disabled={pending}
        onClick={() => void open()}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {children}
      </button>
      {pending && (
        <span role="status" className="ml-2 text-muted-foreground text-xs">
          {t('chat.fileLinks.opening')}
        </span>
      )}
      {revealed && (
        <span role="status" className="ml-2 text-muted-foreground text-xs">
          {t('chat.fileLinks.revealed')}
        </span>
      )}
      {error && (
        <span role="alert" className="ml-2 select-text text-destructive text-xs">
          {failureText(t, error)}
        </span>
      )}
      {menu &&
        // Portal：菜单是 div，不能嵌在 Markdown 段落里
        createPortal(
          <TreeContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />,
          document.body
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
