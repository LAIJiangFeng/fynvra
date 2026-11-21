// Fynvra 插件宿主进程的核心逻辑（ARCHITECTURE §7.12「Fynvra 插件」）：收 init 后组装 api、加载插件、跑 RPC。
// 不 import electron；port / importModule / exit 都可注入，便于测试。
import { pathToFileURL } from 'node:url';
import type { FynvraPluginApi, FynvraPluginModule } from '@shared/types/appPluginApi';
import {
  type HostOutboundMessage,
  parseHostInbound,
  RPC_TIMEOUT_MS,
} from '@shared/types/appPlugins';

export interface HostPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

export interface PluginHostOptions {
  port: HostPort;
  importModule?: (url: string) => Promise<unknown>;
  exit?: (code: number) => void;
  timeoutMs?: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function startPluginHost(options: PluginHostOptions): void {
  const {
    port,
    importModule = (url) => import(/* @vite-ignore */ url),
    exit = (code) => process.exit(code),
    timeoutMs = RPC_TIMEOUT_MS,
  } = options;
  const post = (message: HostOutboundMessage) => port.postMessage(message);
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const handlers = new Map<string, (args: unknown) => unknown>();
  let nextId = 1;
  let plugin: FynvraPluginModule | null = null;
  let initialized = false;
  let exiting = false;

  /** 插件调宿主：每条请求有 id 和超时 */
  function request(method: string, params?: unknown): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`request timed out: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        post({ type: 'req', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(messageOf(error)));
      }
    });
  }

  function createApi(pluginId: string): FynvraPluginApi {
    return {
      pluginId,
      log: (level, message) => {
        request('log', { level, message }).catch(() => undefined);
      },
      storage: {
        read: () => request('storage.read') as Promise<never>,
        write: async (value) => {
          await request('storage.write', { value });
        },
      },
      secrets: {
        get: (key) => request('secrets.get', { key }) as Promise<string | null>,
        set: async (key, value) => {
          await request('secrets.set', { key, value });
        },
      },
      notify: async (input) => {
        await request('notify', { title: input.title, body: input.body });
      },
      net: { proxyEnv: () => request('net.proxyEnv') as Promise<never> },
      workspaces: { list: () => request('workspaces.list') as Promise<never> },
      channel: {
        createSession: (input) => request('channel.createSession', input) as Promise<never>,
        refreshCheckout: async (input) => {
          await request('channel.refreshCheckout', input);
        },
        originCommit: (input) => request('channel.originCommit', input) as Promise<never>,
        prompt: (input) => request('channel.prompt', input) as Promise<never>,
        sessionStatus: (input) => request('channel.sessionStatus', input) as Promise<never>,
        snapshot: (input) => request('channel.snapshot', input) as Promise<never>,
        filterOutbound: (input) => request('channel.filterOutbound', input) as Promise<never>,
        setPullRequestNote: async (input) => {
          await request('channel.setPullRequestNote', input);
        },
      },
      on: (event, handler) => {
        const set = listeners.get(event) ?? new Set();
        listeners.set(event, set);
        set.add(handler);
        return () => {
          set.delete(handler);
        };
      },
      handle: (name, handler) => {
        handlers.set(name, handler);
        return () => {
          if (handlers.get(name) === handler) handlers.delete(name);
        };
      },
    };
  }

  async function init(pluginId: string, entryPath: string): Promise<void> {
    try {
      const loaded = (await importModule(pathToFileURL(entryPath).href)) as Partial<
        FynvraPluginModule & { default: Partial<FynvraPluginModule> }
      >;
      // 兼容 default 导出的对象
      const candidate = typeof loaded.activate === 'function' ? loaded : loaded.default;
      if (!candidate || typeof candidate.activate !== 'function') {
        throw new Error('plugin entry does not export activate(api)');
      }
      plugin = candidate as FynvraPluginModule;
      await plugin.activate(createApi(pluginId));
      post({ type: 'activated' });
    } catch (error) {
      post({ type: 'activate-failed', error: messageOf(error) });
      exit(1);
    }
  }

  async function call(id: number, name: string, args: unknown): Promise<void> {
    const handler = handlers.get(name);
    if (!handler) {
      post({ type: 'ret', id, ok: false, error: `no handler: ${name}` });
      return;
    }
    try {
      post({ type: 'ret', id, ok: true, result: await handler(args) });
    } catch (error) {
      // 只传 message，不传堆栈
      post({ type: 'ret', id, ok: false, error: messageOf(error) });
    }
  }

  async function deactivate(): Promise<void> {
    if (exiting) return;
    exiting = true;
    try {
      await plugin?.deactivate?.();
    } catch {
      // deactivate 失败也照常退出
    }
    exit(0);
  }

  port.on('message', (event) => {
    const message = parseHostInbound(event.data);
    if (!message) return;
    switch (message.type) {
      case 'init':
        if (initialized) return;
        initialized = true;
        void init(message.pluginId, message.entryPath);
        return;
      case 'deactivate':
        void deactivate();
        return;
      case 'res': {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.result);
        else entry.reject(new Error(message.error));
        return;
      }
      case 'evt':
        for (const listener of listeners.get(message.event) ?? []) {
          try {
            listener(message.payload);
          } catch {
            // 单个监听抛错不影响其他监听
          }
        }
        return;
      case 'call':
        void call(message.id, message.name, message.args);
        return;
    }
  });
}
