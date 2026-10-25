import { type Locale, resolveLocale } from '@shared/i18n';
import { languageOf } from '@shared/types/settings';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { useSettingsStore } from '@/stores/settings';
import {
  currentLocale,
  setCurrentLocale,
  setMissingKeyHandler,
  type T,
  translatorOf,
} from './index';

if (import.meta.env.DEV) {
  setMissingKeyHandler((key, locale) => {
    console.warn(`[i18n] ${locale} 缺少文案 ${key}，已回退简体中文`);
  });
}

interface I18nValue {
  locale: Locale;
  t: T;
}

const I18nContext = createContext<I18nValue>({
  locale: currentLocale(),
  t: translatorOf(currentLocale()),
});

function subscribeSystemLanguages(onChange: () => void): () => void {
  window.addEventListener('languagechange', onChange);
  return () => window.removeEventListener('languagechange', onChange);
}

// 快照要可比较：navigator.languages 拼成一个字符串
const systemLanguagesSnapshot = () => navigator.languages.join(',');

/**
 * 界面语言：设置里的语言（跟随系统时按 navigator.languages）。切换后立即生效：
 * 用 useT() 的组件跟着重新渲染；store 里按当前语言产生的提示从下一条起换语言。
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const language = useSettingsStore((state) => languageOf(state));
  const system = useSyncExternalStore(subscribeSystemLanguages, systemLanguagesSnapshot);
  const locale = resolveLocale(language, system ? system.split(',') : []);
  // 先于子组件更新：子组件渲染时调用的纯函数、store 拿到的是同一种语言
  setCurrentLocale(locale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(() => ({ locale, t: translatorOf(locale) }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** 当前语言的 t；语言切换时调用它的组件重新渲染 */
export function useT(): T {
  return useContext(I18nContext).t;
}

export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}
