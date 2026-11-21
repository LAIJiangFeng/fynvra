// 旧数据迁移（ARCHITECTURE §7.12「Fynvra 插件」）：官方 Telegram 插件首次启动时接走内置版本的
// userData/telegram.json，接走后改名留底。只对该插件开放。
import { readFile, rename, stat } from 'node:fs/promises';
import { asRecord } from '@shared/guards';
import { type ApiContext, type ApiMethod, defineMethod } from './types';

export const TELEGRAM_PLUGIN_ID = 'com.fynvra.telegram';
const MAX_LEGACY_BYTES = 1024 * 1024;

export interface LegacyApiDeps {
  legacyTelegram: {
    /** 生产环境为 userData/telegram.json */
    path: string;
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** 非官方插件一律当作方法不存在；入参校验放在调用者检查之后，免得 invalid params 暴露方法存在 */
function guard(ctx: ApiContext, name: string, raw: unknown): void {
  if (ctx.pluginId !== TELEGRAM_PLUGIN_ID) throw new Error(`method not allowed: ${name}`);
  const record = asRecord(raw);
  if (raw !== undefined && (!record || Object.keys(record).length > 0)) {
    throw new Error(`invalid params: ${name}`);
  }
}

export const LEGACY_API: Record<string, ApiMethod> = {
  'legacy.telegramData': defineMethod({
    parse: (raw) => ({ raw }),
    run: async (ctx, { raw }) => {
      guard(ctx, 'legacy.telegramData', raw);
      const { path } = ctx.deps.legacyTelegram;
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch (error) {
        if (isMissing(error)) return null;
        throw new Error('legacy data unreadable');
      }
      if (size > MAX_LEGACY_BYTES) throw new Error('legacy data too large');
      // 内容含明文 token：任何错误都只给固定文案，不带内容
      try {
        return JSON.parse(await readFile(path, 'utf8')) as unknown;
      } catch (error) {
        if (isMissing(error)) return null;
        throw new Error('legacy data unreadable');
      }
    },
  }),
  'legacy.telegramMigrated': defineMethod({
    parse: (raw) => ({ raw }),
    run: async (ctx, { raw }) => {
      guard(ctx, 'legacy.telegramMigrated', raw);
      const { path } = ctx.deps.legacyTelegram;
      try {
        await rename(path, `${path}.migrated-${Date.now()}`);
      } catch (error) {
        if (isMissing(error)) return null;
        throw new Error('legacy data rename failed');
      }
      return null;
    },
  }),
};
