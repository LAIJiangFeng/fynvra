import type {
  AgentSession,
  ExtensionCommandContext,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
} from '@earendil-works/pi-coding-agent';

export type NoticeLevel = 'info' | 'warning' | 'error';

export interface SlashCommandRun {
  /** Settles when the handler returns or throws, or on `stop()`; never rejects. */
  done: Promise<void>;
  /** Stop waiting: pending `input()` resolve undefined, later output of the handler is dropped. */
  stop(): void;
}

/**
 * Run a registered pi extension command (`/name args`) the way pi's `prompt()` does, but with a
 * command-scoped UI: `hasUI` is true for this command only, `notify` becomes a chat notice and
 * `input` waits for its signal or Stop. Fynvra binds no global uiContext (plugins branch on hasUI).
 * Returns undefined when the text is not a registered command; it then goes to `session.prompt`.
 */
export function startExtensionCommand(
  session: Pick<AgentSession, 'extensionRunner'>,
  text: string,
  notify: (level: NoticeLevel, text: string) => void,
  options: { mcpServers?: readonly string[]; hintMs?: number } = {}
): SlashCommandRun | undefined {
  if (!text.startsWith('/')) return undefined;
  // Same parsing as pi `_tryExecuteExtensionCommand`.
  const space = text.indexOf(' ');
  const name = space === -1 ? text.slice(1) : text.slice(1, space);
  let args = space === -1 ? '' : text.slice(space + 1);
  const runner = session.extensionRunner;
  const command = runner.getCommand(name);
  if (!command) return undefined;

  // Same parsing as pi's /mcp handler. An unknown server fails here instead of after pi's
  // `await pending`, which waits for every startup connection of this session.
  const [action, server, ...extra] = args.trim().split(/\s+/).filter(Boolean);
  if (
    name === 'mcp' &&
    options.mcpServers &&
    server &&
    (action === 'login' || action === 'logout' || action === 'reconnect')
  ) {
    const key = (value: string) => value.replaceAll('_', '-');
    const match = options.mcpServers.find((known) => key(known) === key(server));
    if (match === undefined) {
      const list = options.mcpServers.length ? options.mcpServers.join(', ') : 'none';
      const message = `No MCP server named "${server}" in this session. This session's servers: ${list}. Sign in from a session whose role has "${server}", or add it to this role in Settings.`;
      // Next microtask, like a real command, so the caller announces it first.
      return { done: Promise.resolve().then(() => notify('error', message)), stop: () => {} };
    }
    // pi looks the name up exactly; pass the configured spelling.
    args = [action, match, ...extra].join(' ');
  }

  const stopper = new AbortController();
  const hint = setTimeout(
    () =>
      emit(
        'info',
        name === 'mcp'
          ? "Waiting for this session's MCP servers to finish connecting; a freshly started session can take a minute or two. Press Stop to cancel."
          : `/${name} is still running. Press Stop to cancel.`
      ),
    options.hintMs ?? 3000
  );
  stopper.signal.addEventListener('abort', () => clearTimeout(hint), { once: true });
  const emit = (level: NoticeLevel, message: string) => {
    clearTimeout(hint);
    if (!stopper.signal.aborted) notify(level, message);
  };
  let warned = false;
  const needsChoice = () => {
    if (warned) return;
    warned = true;
    emit(
      'warning',
      `/${name} asked for an interactive choice that Fynvra cannot show. Pass the argument explicitly, for example /mcp login <server>.`
    );
  };
  const base = runner.getUIContext();
  const overrides: Partial<ExtensionUIContext> = {
    notify: (message, type) => emit(type ?? 'info', message),
    input: (title, _placeholder, options?: ExtensionUIDialogOptions) => {
      emit('info', title);
      return new Promise<string | undefined>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          resolve(undefined);
        };
        const timer = options?.timeout ? setTimeout(finish, options.timeout) : undefined;
        if (options?.signal?.aborted || stopper.signal.aborted) return finish();
        options?.signal?.addEventListener('abort', finish, { once: true });
        stopper.signal.addEventListener('abort', finish, { once: true });
      });
    },
    select: (...params) => {
      needsChoice();
      return base.select(...params);
    },
    confirm: (...params) => {
      needsChoice();
      return base.confirm(...params);
    },
    editor: (...params) => {
      needsChoice();
      return base.editor(...params);
    },
    custom: ((...params: Parameters<ExtensionUIContext['custom']>) => {
      needsChoice();
      return base.custom(...params);
    }) as ExtensionUIContext['custom'],
  };
  // Inherit everything else (including the `theme` getter) from the runner's no-op UI.
  const ui: ExtensionUIContext = Object.assign(Object.create(base), overrides);
  const ctx: ExtensionCommandContext = Object.defineProperties(runner.createCommandContext(), {
    hasUI: { get: () => true },
    ui: { get: () => ui },
  });

  // Start on the next microtask, so the caller can announce the command before its first notice.
  const handled = Promise.resolve()
    .then(() => command.handler(args, ctx))
    .catch((error: unknown) => {
      emit('error', `/${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => clearTimeout(hint));
  const stopped = new Promise<void>((resolve) =>
    stopper.signal.addEventListener('abort', () => resolve(), { once: true })
  );
  return { done: Promise.race([handled, stopped]), stop: () => stopper.abort() };
}
