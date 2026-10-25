import {
  createTranslator,
  FALLBACK_LOCALE,
  type Language,
  type Locale,
  type MessageKey,
  resolveLocale,
  type Translate,
} from '@shared/i18n';
import { mainEn } from '@shared/i18n/main/en';
import { mainZhCN } from '@shared/i18n/main/zh-CN';

/**
 * Main 的用户可见文案（IPC 错误、原生对话框、桌面通知、导入告警）按设置里的界面语言翻译成文字再交出去：
 * Renderer 照常显示 error 字符串，不用认 key。字典在 src/shared/i18n/main。
 * 不 import electron 与 settings（服务模块的测试会 import 本文件）：语言来源由 src/main/index.ts 接上，
 * 没接上时（测试、启动早期）按基准语言。
 */

export type MainMessages = typeof mainZhCN;
export type MainMessageId = MessageKey<MainMessages>;

export interface MainLocaleSource {
  /** settings.json 里的 preferences.language；每次翻译时读，改了设置立即生效 */
  language(): Language | undefined;
  /** 系统语言（跟随系统时用） */
  systemLanguages(): readonly string[];
  /** 缺 key 时 console.warn（开发模式） */
  warnMissing?: boolean;
}

let source: MainLocaleSource | null = null;

export function configureMainLocale(next: MainLocaleSource | null): void {
  source = next;
}

/** 当前的界面语言：跟随系统时按系统语言 */
export function mainLocale(): Locale {
  return source ? resolveLocale(source.language(), source.systemLanguages()) : FALLBACK_LOCALE;
}

const translatorFor = createTranslator<MainMessages>(
  { 'zh-CN': mainZhCN, en: mainEn },
  {
    onMissing: (key, locale) => {
      if (source?.warnMissing)
        console.warn(`[i18n] ${locale} 缺少 Main 文案 ${key}，已回退简体中文`);
    },
  }
);

/** 按当前界面语言翻译 Main 的文案 */
export const translate: Translate<MainMessageId> = (key, params) =>
  translatorFor(mainLocale())(key, params);
