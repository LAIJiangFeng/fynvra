// 基础宿主 API（ARCHITECTURE §7.12「Fynvra 插件」）：log、storage、secrets、notify、net.proxyEnv、workspaces.list。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asRecord } from '@shared/guards';
import type { PluginLogLevel, PluginProxyEnv, PluginWorkspace } from '@shared/types/appPluginApi';
import { writeJsonAtomic } from '../../providers/jsonRegistry';
import type { PluginSecretStore } from '../secrets';
import { type ApiMethod, defineMethod } from './types';

export const MAX_STORAGE_BYTES = 5 * 1024 * 1024;
const MAX_LOG_MESSAGE_CHARS = 64 * 1024;
const LOG_LEVELS: readonly PluginLogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface BaseApiDeps {
  log(pluginId: string, level: PluginLogLevel, message: string): void;
  secrets: PluginSecretStore;
  /** 调用方负责遵守通知总开关与提示音 */
  notify(title: string, body: string): void;
  /** 当前命令环境（含代理），只取三个代理键 */
  commandEnv(): Promise<NodeJS.ProcessEnv>;
  listWorkspaces(): readonly { id: string; name: string; vcs: string }[];
}

/** 只接受 undefined 或 `{}` */
function noParams(raw: unknown): Record<string, never> | null {
  if (raw === undefined) return {};
  const record = asRecord(raw);
  return record && Object.keys(record).length === 0 ? {} : null;
}

/** 对象且只含给定键 */
function only(raw: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const record = asRecord(raw);
  return record && Object.keys(record).every((key) => keys.includes(key)) ? record : null;
}

const storagePath = (dataDir: string) => join(dataDir, 'storage.json');

export const BASE_API: Record<string, ApiMethod> = {
  log: defineMethod({
    parse: (raw) => {
      const record = only(raw, ['level', 'message']);
      if (!record || !LOG_LEVELS.includes(record.level as PluginLogLevel)) return null;
      if (typeof record.message !== 'string') return null;
      return { level: record.level as PluginLogLevel, message: record.message };
    },
    run: (ctx, { level, message }) => {
      ctx.deps.log(ctx.pluginId, level, message.slice(0, MAX_LOG_MESSAGE_CHARS));
      return null;
    },
  }),
  'storage.read': defineMethod({
    parse: noParams,
    run: async (ctx) => {
      let text: string;
      try {
        text = await readFile(storagePath(ctx.dataDir), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error('storage read failed');
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error('storage is corrupt');
      }
    },
  }),
  'storage.write': defineMethod({
    parse: (raw) => {
      const record = only(raw, ['value']);
      return record && 'value' in record ? { value: record.value } : null;
    },
    run: async (ctx, { value }) => {
      const text = JSON.stringify(value ?? null);
      if (new TextEncoder().encode(text).length > MAX_STORAGE_BYTES) {
        throw new Error('storage value exceeds 5 MB');
      }
      await writeJsonAtomic(storagePath(ctx.dataDir), JSON.parse(text));
      return null;
    },
  }),
  'secrets.get': defineMethod({
    parse: (raw) => {
      const record = only(raw, ['key']);
      return typeof record?.key === 'string' ? { key: record.key } : null;
    },
    run: (ctx, { key }) => ctx.deps.secrets.get(ctx.pluginId, key),
  }),
  'secrets.set': defineMethod({
    parse: (raw) => {
      const record = only(raw, ['key', 'value']);
      if (typeof record?.key !== 'string') return null;
      if (record.value !== null && typeof record.value !== 'string') return null;
      return { key: record.key, value: record.value as string | null };
    },
    run: async (ctx, { key, value }) => {
      await ctx.deps.secrets.set(ctx.pluginId, key, value);
      return null;
    },
  }),
  notify: defineMethod({
    permission: 'notifications',
    parse: (raw) => {
      const record = only(raw, ['title', 'body']);
      if (typeof record?.title !== 'string' || typeof record.body !== 'string') return null;
      if (record.title.length > 200 || record.body.length > 2000) return null;
      return { title: record.title, body: record.body };
    },
    run: (ctx, { title, body }) => {
      ctx.deps.notify(title, body);
      return null;
    },
  }),
  'net.proxyEnv': defineMethod({
    permission: 'network',
    parse: noParams,
    run: async (ctx): Promise<PluginProxyEnv> => {
      const env = await ctx.deps.commandEnv();
      const result: PluginProxyEnv = {};
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'] as const) {
        const value = env[key] ?? env[key.toLowerCase()];
        if (value) result[key] = value;
      }
      return result;
    },
  }),
  'workspaces.list': defineMethod({
    permission: 'workspaces',
    parse: noParams,
    // 只给 id、名称、是否 git，绝不带路径
    run: (ctx): PluginWorkspace[] =>
      ctx.deps.listWorkspaces().map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        git: workspace.vcs === 'git',
      })),
  }),
};
