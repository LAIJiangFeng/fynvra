/**
 * 界面语言（Task 27）：语言与 Locale、字典类型、翻译函数。纯函数，Main 与 Renderer 共用。
 *
 * 字典是按页面分命名空间的嵌套对象，叶子是模板；key 写成点分路径（`settings.general.title`）。
 * 简体中文是基准字典：其他语言的字典按 {@link MessagesShape} 声明，key 集合与它一致；缺 key 时回退到它。
 * 模板里 `{name}` 换成参数；`{n|单数|复数}` 按 n 是否为 1 选写法（英文用，中文写一种即可）。
 */

export const LOCALES = ['zh-CN', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
/** 基准语言：字典缺 key、系统没给语言时用它 */
export const FALLBACK_LOCALE: Locale = 'zh-CN';

/** 设置里的语言：跟随系统，或指定一种 */
export const LANGUAGES = ['system', ...LOCALES] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'system';

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/** 一个语言标签认不认得：zh 开头的（含繁体）为简体中文，en 开头的为英文 */
function knownLocale(tag: string): Locale | null {
  const lower = tag.trim().toLowerCase();
  if (lower === 'zh' || /^zh[-_]/.test(lower)) return 'zh-CN';
  if (lower === 'en' || /^en[-_]/.test(lower)) return 'en';
  return null;
}

/** 语言标签 → Locale：zh 开头的为简体中文，其余为英文；空值为基准语言 */
export function normalizeLocale(tag: string | null | undefined): Locale {
  if (!tag?.trim()) return FALLBACK_LOCALE;
  return knownLocale(tag) ?? 'en';
}

/**
 * 生效的界面语言：指定了就用它；跟随系统时取系统语言列表里第一个认得的，
 * 都不认得时用英文，系统什么也没给时用基准语言。
 * 系统语言：Main 用 `app.getPreferredSystemLanguages()`，Renderer 用 `navigator.languages`。
 */
export function resolveLocale(
  language: Language | undefined,
  systemLanguages: readonly string[]
): Locale {
  if (language && language !== 'system') return language;
  const tags = systemLanguages.filter((tag) => tag.trim() !== '');
  for (const tag of tags) {
    const locale = knownLocale(tag);
    if (locale) return locale;
  }
  return tags.length > 0 ? 'en' : FALLBACK_LOCALE;
}

// ---------------------------------------------------------------------------
// 字典

/** 字典：按页面分命名空间的嵌套对象，叶子是模板 */
export interface Messages {
  readonly [key: string]: string | Messages;
}

/** 与基准字典同形：同样的 key、叶子是任意文案。其他语言的字典按它声明，少 key、多 key 都编译不过 */
export type MessagesShape<T> = {
  readonly [K in keyof T]: T[K] extends string ? string : MessagesShape<T[K]>;
};

/** 字典里全部叶子的点分路径 */
export type MessageKey<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${MessageKey<T[K]>}`;
}[keyof T & string];

export type MessageParams = Readonly<Record<string, string | number>>;

/** 绑定了语言的翻译函数 */
export type Translate<K extends string = string> = (key: K, params?: MessageParams) => string;

// `{name}` 与 `{name|单数|复数}`；参数名只认字母数字下划线，JSON 之类的花括号不受影响
const PLACEHOLDER = /\{(\w+)(?:\|([^{}|]*)\|([^{}|]*))?\}/g;

/** 把参数填进模板；缺少的参数保留占位符原样 */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(
    PLACEHOLDER,
    (match, name: string, one: string | undefined, other: string | undefined) => {
      const value = params[name];
      if (value === undefined) return match;
      if (one === undefined) return String(value);
      return Number(value) === 1 ? one : (other ?? '');
    }
  );
}

/** 模板里用到的参数名（去重排序）：测试比对两份字典同一 key 的参数 */
export function messagePlaceholders(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) names.add(match[1] as string);
  return [...names].sort();
}

function flatten(messages: Messages, prefix: string, into: Map<string, string>): void {
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') into.set(path, value);
    else flatten(value, path, into);
  }
}

/** 字典全部叶子的点分路径（排好序）：测试断言两份字典 key 集合一致 */
export function messageKeys(messages: Messages): string[] {
  const flat = new Map<string, string>();
  flatten(messages, '', flat);
  return [...flat.keys()].sort();
}

export interface TranslatorOptions {
  /** 当前语言的字典里没有这个 key（已回退基准语言或返回 key 本身）；开发模式下用来 console.warn */
  onMissing?: (key: string, locale: Locale) => void;
}

/**
 * 由各语言的字典得到「按语言取翻译函数」：同一语言总是同一个函数。
 * 缺 key 时回退基准语言，两边都没有时返回 key 本身。
 */
export function createTranslator<T extends Messages>(
  dictionaries: { readonly [L in Locale]: MessagesShape<T> },
  options: TranslatorOptions = {}
): (locale: Locale) => Translate<MessageKey<T>> {
  const flat = new Map<Locale, Map<string, string>>();
  const table = (locale: Locale): Map<string, string> => {
    let entries = flat.get(locale);
    if (!entries) {
      entries = new Map();
      flatten(dictionaries[locale] as Messages, '', entries);
      flat.set(locale, entries);
    }
    return entries;
  };
  const translators = new Map<Locale, Translate<MessageKey<T>>>();
  return (locale) => {
    let t = translators.get(locale);
    if (!t) {
      t = (key, params) => {
        let template = table(locale).get(key);
        if (template === undefined) {
          options.onMissing?.(key, locale);
          template = table(FALLBACK_LOCALE).get(key) ?? key;
        }
        return interpolate(template, params);
      };
      translators.set(locale, t);
    }
    return t;
  };
}
