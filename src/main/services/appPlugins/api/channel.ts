// 渠道宿主 API（ARCHITECTURE §7.12「渠道 API」）：全部需要 channel 权限；归属核对与安全规则在 channels/host.ts。
import { asRecord } from '@shared/guards';
import type {
  ChannelAttachment,
  ChannelModelRef,
  ChannelProfile,
} from '@shared/types/appPluginApi';
import type { ChannelHost } from '../../channels/host';
import { type ApiContext, type ApiMethod, defineMethod } from './types';

export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_NOTE_CHARS = 8_000;
const MAX_ID_CHARS = 200;
const MAX_TITLE_CHARS = 200;
const PROFILES: readonly ChannelProfile[] = ['triage', 'restricted'];
export const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_NAME_CHARS = 200;
const ATTACHMENT_FILE = /^[A-Za-z0-9._-]{1,128}$/;

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

/**
 * 附件列表：最多 20 个；file 是 attachments/ 下的纯文件名（白名单字符、不含 `..`），
 * name 去掉路径部分与控制字符，清洗后为空时用 file。任一项不合法整次调用作废。
 */
function parseAttachments(raw: unknown): ChannelAttachment[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS) return null;
  const items: ChannelAttachment[] = [];
  for (const item of raw) {
    const record = only(item, ['file', 'name']);
    const file = record?.file;
    const name = record?.name;
    if (typeof file !== 'string' || !ATTACHMENT_FILE.test(file) || file.includes('..')) return null;
    if (typeof name !== 'string' || name.length > MAX_ATTACHMENT_NAME_CHARS) return null;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 去掉控制字符正是目的
    const display = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    items.push({ file, name: display || file });
  }
  return items;
}

/** 模型引用：只含非空且不超过 200 字符的 providerId 与 modelId */
function parseModelRef(raw: unknown): ChannelModelRef | null {
  const record = only(raw, ['providerId', 'modelId']);
  if (!record || !isId(record.providerId) || !isId(record.modelId)) return null;
  return { providerId: record.providerId, modelId: record.modelId };
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
  'channel.models': defineMethod({
    permission: 'channel',
    parse: (raw) => (raw === undefined || only(raw, []) ? {} : null),
    run: (ctx) => host(ctx).models(),
  }),
  'channel.setSessionModel': defineMethod({
    permission: 'channel',
    parse: (raw) => {
      const record = only(raw, ['sessionId', 'model']);
      if (!record || !isId(record.sessionId) || !('model' in record)) return null;
      const model = record.model === null ? null : parseModelRef(record.model);
      if (record.model !== null && !model) return null;
      return { sessionId: record.sessionId, model };
    },
    run: async (ctx, { sessionId, model }) => {
      await host(ctx).setSessionModel(ctx.pluginId, sessionId, model);
      return null;
    },
  }),
  'channel.createSession': defineMethod({
    permission: 'channel',
    parse: (raw) => {
      const record = only(raw, ['workspaceId', 'profile', 'title', 'model']);
      if (!record || !isId(record.workspaceId)) return null;
      if (!PROFILES.includes(record.profile as ChannelProfile)) return null;
      const { title } = record;
      if (typeof title !== 'string' || title.trim() === '' || title.length > MAX_TITLE_CHARS) {
        return null;
      }
      const model = record.model === undefined ? undefined : parseModelRef(record.model);
      if (model === null) return null;
      return {
        workspaceId: record.workspaceId,
        profile: record.profile as ChannelProfile,
        title,
        ...(model ? { model } : {}),
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
      const record = only(raw, ['sessionId', 'text', 'attachments']);
      if (!record || !isId(record.sessionId) || typeof record.text !== 'string') return null;
      const attachments =
        record.attachments === undefined ? [] : parseAttachments(record.attachments);
      if (!attachments || !withinBytes(record.text, MAX_PROMPT_BYTES)) return null;
      // 只发附件时正文可以为空
      if (record.text.trim() === '' && attachments.length === 0) return null;
      return { sessionId: record.sessionId, text: record.text, attachments };
    },
    run: (ctx, { sessionId, text, attachments }) =>
      host(ctx).prompt(
        ctx.pluginId,
        sessionId,
        text,
        attachments.length > 0 ? { dataDir: ctx.dataDir, items: attachments } : undefined
      ),
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
