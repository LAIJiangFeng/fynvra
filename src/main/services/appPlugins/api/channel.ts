// 渠道宿主 API（ARCHITECTURE §7.12「渠道 API」）：全部需要 channel 权限；归属核对与安全规则在 channels/host.ts。
import { asRecord } from '@shared/guards';
import type { ChannelProfile } from '@shared/types/appPluginApi';
import type { ChannelHost } from '../../channels/host';
import { type ApiContext, type ApiMethod, defineMethod } from './types';

export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_NOTE_CHARS = 8_000;
const MAX_ID_CHARS = 200;
const MAX_TITLE_CHARS = 200;
const PROFILES: readonly ChannelProfile[] = ['triage', 'restricted'];

export interface ChannelApiDeps {
  /** 渠道宿主；Main 接线完成前为 undefined（调用失败） */
  channel?(): ChannelHost | undefined;
}

/** 对象且只含给定键 */
function only(raw: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const record = asRecord(raw);
  return record && Object.keys(record).every((key) => keys.includes(key)) ? record : null;
}

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.length <= MAX_ID_CHARS;

const withinBytes = (text: string, max: number) => new TextEncoder().encode(text).length <= max;

function host(ctx: ApiContext): ChannelHost {
  const channel = ctx.deps.channel?.();
  if (!channel) throw new Error('channel host is not available');
  return channel;
}

/** 只有一个 id 字段的入参 */
function idParam<K extends string>(key: K) {
  return (raw: unknown): Record<K, string> | null => {
    const record = only(raw, [key]);
    const value = record?.[key];
    return isId(value) ? ({ [key]: value } as Record<K, string>) : null;
  };
}

export const CHANNEL_API: Record<string, ApiMethod> = {
  'channel.createSession': defineMethod({
    permission: 'channel',
    parse: (raw) => {
      const record = only(raw, ['workspaceId', 'profile', 'title']);
      if (!record || !isId(record.workspaceId)) return null;
      if (!PROFILES.includes(record.profile as ChannelProfile)) return null;
      const { title } = record;
      if (typeof title !== 'string' || title.trim() === '' || title.length > MAX_TITLE_CHARS) {
        return null;
      }
      return {
        workspaceId: record.workspaceId,
        profile: record.profile as ChannelProfile,
        title,
      };
    },
    run: (ctx, input) => host(ctx).createSession(ctx.pluginId, input),
  }),
  'channel.refreshCheckout': defineMethod({
    permission: 'channel',
    parse: idParam('workspaceId'),
    run: async (ctx, { workspaceId }) => {
      await host(ctx).refreshCheckout(ctx.pluginId, workspaceId);
      return null;
    },
  }),
  'channel.originCommit': defineMethod({
    permission: 'channel',
    parse: idParam('workspaceId'),
    run: (ctx, { workspaceId }) => host(ctx).originCommit(ctx.pluginId, workspaceId),
  }),
  'channel.prompt': defineMethod({
    permission: 'channel',
    parse: (raw) => {
      const record = only(raw, ['sessionId', 'text']);
      if (!record || !isId(record.sessionId) || typeof record.text !== 'string') return null;
      if (record.text.trim() === '' || !withinBytes(record.text, MAX_PROMPT_BYTES)) return null;
      return { sessionId: record.sessionId, text: record.text };
    },
    run: (ctx, { sessionId, text }) => host(ctx).prompt(ctx.pluginId, sessionId, text),
  }),
  'channel.sessionStatus': defineMethod({
    permission: 'channel',
    parse: idParam('sessionId'),
    run: (ctx, { sessionId }) => host(ctx).sessionStatus(ctx.pluginId, sessionId),
  }),
  'channel.snapshot': defineMethod({
    permission: 'channel',
    parse: idParam('workspaceId'),
    run: (ctx, { workspaceId }) => host(ctx).snapshot(ctx.pluginId, workspaceId),
  }),
  'channel.filterOutbound': defineMethod({
    permission: 'channel',
    parse: (raw) => {
      const record = only(raw, ['text']);
      return typeof record?.text === 'string' && withinBytes(record.text, MAX_PROMPT_BYTES)
        ? { text: record.text }
        : null;
    },
    run: (ctx, { text }) => host(ctx).filterOutbound(text),
  }),
  'channel.setPullRequestNote': defineMethod({
    permission: 'channel',
    parse: (raw) => {
      const record = only(raw, ['taskId', 'text']);
      if (!record || !isId(record.taskId) || !('text' in record)) return null;
      const { text } = record;
      if (text !== null && (typeof text !== 'string' || text.length > MAX_NOTE_CHARS)) {
        return null;
      }
      return { taskId: record.taskId, text: text as string | null };
    },
    run: async (ctx, { taskId, text }) => {
      await host(ctx).setPullRequestNote(ctx.pluginId, taskId, text);
      return null;
    },
  }),
};
