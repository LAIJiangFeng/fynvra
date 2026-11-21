// Main 侧 RPC：处理插件发来的 req（白名单 → 大小 → 权限 → 入参收窄 → 执行），以及宿主调插件的 call / ret。
import { errorMessage } from '@shared/guards';
import {
  type AppPluginPermission,
  type HostInboundMessage,
  type HostOutboundMessage,
  MAX_RPC_MESSAGE_BYTES,
  RPC_TIMEOUT_MS,
} from '@shared/types/appPlugins';
import type { ApiContext, ApiDeps, ApiMethod } from './api';

export interface PluginConnection {
  /** 处理 req / ret；其他类型不处理 */
  receive(message: HostOutboundMessage, size: number): void;
  /** 宿主调插件；对方没注册、抛错或超时都 reject */
  call(name: string, args: unknown): Promise<unknown>;
  emit(event: string, payload: unknown): void;
  /** 进程退出：所有未完成的 call 立即失败 */
  close(reason: string): void;
}

/** 消息序列化后的字节数（structured clone 下的近似值；不可序列化时按超限处理） */
export function messageSize(message: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(message) ?? '', 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function createPluginConnection(options: {
  pluginId: string;
  dataDir: string;
  permissions: readonly AppPluginPermission[];
  methods: Readonly<Record<string, ApiMethod>>;
  deps: ApiDeps;
  post: (message: HostInboundMessage) => void;
  timeoutMs?: number;
}): PluginConnection {
  const {
    pluginId,
    dataDir,
    permissions,
    methods,
    deps,
    post,
    timeoutMs = RPC_TIMEOUT_MS,
  } = options;
  const ctx: ApiContext = { pluginId, dataDir, deps };
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  let nextId = 1;
  let closed = false;

  const reply = (
    id: number,
    result: { ok: true; value: unknown } | { ok: false; error: string }
  ) => {
    if (closed) return;
    const message: HostInboundMessage = result.ok
      ? { type: 'res', id, ok: true, result: result.value }
      : { type: 'res', id, ok: false, error: result.error };
    if (result.ok && messageSize(message) > MAX_RPC_MESSAGE_BYTES) {
      post({ type: 'res', id, ok: false, error: 'result exceeds 1 MB' });
      return;
    }
    try {
      post(message);
    } catch {
      // 进程已退出
    }
  };

  async function handleRequest(id: number, methodName: string, params: unknown, size: number) {
    // 白名单只认表里自己的键，不走原型链
    const method = Object.hasOwn(methods, methodName) ? methods[methodName] : undefined;
    if (!method) return reply(id, { ok: false, error: `method not allowed: ${methodName}` });
    if (size > MAX_RPC_MESSAGE_BYTES)
      return reply(id, { ok: false, error: 'message exceeds 1 MB' });
    if (method.permission && !permissions.includes(method.permission)) {
      return reply(id, { ok: false, error: `permission required: ${method.permission}` });
    }
    const parsed = method.parse(params);
    if (parsed === null) return reply(id, { ok: false, error: `invalid params: ${methodName}` });
    try {
      reply(id, { ok: true, value: (await method.run(ctx, parsed)) ?? null });
    } catch (error) {
      reply(id, { ok: false, error: errorMessage(error) });
    }
  }

  return {
    receive(message, size) {
      if (message.type === 'req') {
        void handleRequest(message.id, message.method, message.params, size);
      } else if (message.type === 'ret') {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) {
          if (size > MAX_RPC_MESSAGE_BYTES) entry.reject(new Error('message exceeds 1 MB'));
          else entry.resolve(message.result);
        } else entry.reject(new Error(message.error));
      }
    },
    call(name, args) {
      if (closed) return Promise.reject(new Error('plugin is not running'));
      const id = nextId++;
      const message: HostInboundMessage = { type: 'call', id, name, args };
      if (messageSize(message) > MAX_RPC_MESSAGE_BYTES) {
        return Promise.reject(new Error('message exceeds 1 MB'));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`call timed out: ${name}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          post(message);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error(errorMessage(error)));
        }
      });
    },
    emit(event, payload) {
      if (closed) return;
      const message: HostInboundMessage = { type: 'evt', event, payload };
      if (messageSize(message) > MAX_RPC_MESSAGE_BYTES) return;
      try {
        post(message);
      } catch {
        // 进程已退出
      }
    },
    close(reason) {
      closed = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
      }
      pending.clear();
    },
  };
}
