import {
  createTranslator,
  FALLBACK_LOCALE,
  type Locale,
  type MessageKey,
  type Translate,
} from '@shared/i18n';
import { en } from './en';
import { zhCN } from './zh-CN';

// Renderer 的界面文案：字典按页面分命名空间，./zh-CN.ts 是基准，./en.ts 与它同形。
// 本文件不读 window、不用 `@/` 别名：store 与纯函数的测试（node 环境）会 import 它。
// 组件用 ./I18nProvider 的 useT()（切换语言时重新渲染）。

export type RendererMessages = typeof zhCN;
/** 字典 key（点分路径） */
export type MessageId = MessageKey<RendererMessages>;
/** 绑定了语言的翻译函数：组件经 useT() 取，纯函数由调用方传入 */
export type T = Translate<MessageId>;

let reportMissing: ((key: string, locale: Locale) => void) | undefined;

/** 缺 key 时的报告（开发模式下 I18nProvider 设成 console.warn） */
export function setMissingKeyHandler(
  handler: ((key: string, locale: Locale) => void) | undefined
): void {
  reportMissing = handler;
}

const translatorFor = createTranslator<RendererMessages>(
  { 'zh-CN': zhCN, en },
  { onMissing: (key, locale) => reportMissing?.(key, locale) }
);

/** 某种语言的 t（同一语言总是同一个函数） */
export function translatorOf(locale: Locale): T {
  return translatorFor(locale);
}

let current: Locale = FALLBACK_LOCALE;

/** 当前界面语言：I18nProvider 渲染时更新，没渲染过时是基准语言 */
export function currentLocale(): Locale {
  return current;
}

export function setCurrentLocale(locale: Locale): void {
  current = locale;
}

/** 按当前语言翻译：给 store 这类不在组件里的代码用（提示按产生时的语言） */
export const translate: T = (key, params) => translatorFor(current)(key, params);
