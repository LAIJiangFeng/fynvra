import { asRecord, errorMessage } from '@shared/guards';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import { isTelegramRateLimit, type TelegramCardAction } from '@shared/types/telegram';
import { ipcMain } from 'electron';
import type { TelegramStateResult } from '../../preload/domains/telegram';
import { translate } from '../i18n';
import { getTelegramService } from '../services/telegram/instance';
import type { TelegramService } from '../services/telegram/service';
import { sendToAllWindows } from '../windows/createAppWindow';

/** 服务在 registerIpcHandlers 之后才创建，所以每次调用时再取 */
const NOT_RUNNING = 'Telegram 服务尚未启动，请稍后重试';
const MAX_TOKEN_LENGTH = 100;

export function registerTelegramHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.TELEGRAM_GET_STATE, (): TelegramStateResult => {
    const service = getTelegramService();
    if (!service) return { ok: false, error: NOT_RUNNING };
    try {
      // 视图本身不含 token，只有 tokenMasked
      return { ok: true, state: service.getState() };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  handle(IPC_CHANNELS.TELEGRAM_SET_TOKEN, ['token'], ({ token }) =>
    token === null || (typeof token === 'string' && token.length <= MAX_TOKEN_LENGTH)
      ? (service) => service.setToken(token)
      : null
  );

  // 契约叫 groupId，服务叫 chatId
  handle(
    IPC_CHANNELS.TELEGRAM_ALLOW_GROUP,
    ['groupId', 'workspaceId'],
    ({ groupId, workspaceId }) =>
      Number.isSafeInteger(groupId) && typeof workspaceId === 'string' && workspaceId.length > 0
        ? (service) => service.allowGroup(groupId as number, workspaceId)
        : null
  );

  handle(IPC_CHANNELS.TELEGRAM_REMOVE_GROUP, ['groupId'], ({ groupId }) =>
    Number.isSafeInteger(groupId) ? (service) => service.removeGroup(groupId as number) : null
  );

  handle(IPC_CHANNELS.TELEGRAM_RESOLVE_CARD, ['cardId', 'action'], ({ cardId, action }) =>
    Number.isSafeInteger(cardId) && (action === 'approve' || action === 'reject')
      ? (service) => service.resolveCard(cardId as number, action as TelegramCardAction)
      : null
  );

  handle(IPC_CHANNELS.TELEGRAM_SET_ENABLED, ['enabled'], ({ enabled }) =>
    typeof enabled === 'boolean' ? (service) => service.setEnabled(enabled) : null
  );

  handle(IPC_CHANNELS.TELEGRAM_SET_RATE_LIMIT, ['perHour'], ({ perHour }) =>
    isTelegramRateLimit(perHour) ? (service) => service.setRateLimit(perHour) : null
  );
}

/**
 * 注册一个「对象入参 → 服务调用」的通道：入参必须是只含 keys 的对象（缺键视为 undefined，多余的键拒绝），
 * parse 收窄失败返回 null。
 */
function handle(
  channel: string,
  keys: readonly string[],
  parse: (
    record: Record<string, unknown>
  ) => ((service: TelegramService) => Promise<IpcResult>) | null
): void {
  ipcMain.handle(channel, async (_event, raw: unknown): Promise<IpcResult> => {
    const record = asRecord(raw);
    const run =
      record && Object.keys(record).every((key) => keys.includes(key)) ? parse(record) : null;
    if (!run) return { ok: false, error: translate('common.invalidArgs') };
    const service = getTelegramService();
    if (!service) return { ok: false, error: NOT_RUNNING };
    try {
      return await run(service);
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });
}

/** 服务创建后调用：状态变化广播给所有窗口（无参数，Renderer 再 get-state）。返回取消订阅。 */
export function connectTelegramChanged(service: TelegramService): () => void {
  return service.onChange(() => sendToAllWindows(IPC_CHANNELS.TELEGRAM_CHANGED));
}
