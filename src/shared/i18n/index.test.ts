import { describe, expect, it, vi } from 'vitest';
import {
  createTranslator,
  DEFAULT_LANGUAGE,
  FALLBACK_LOCALE,
  interpolate,
  isLanguage,
  LANGUAGES,
  type MessagesShape,
  messageKeys,
  messagePlaceholders,
  normalizeLocale,
  resolveLocale,
} from './index';

describe('normalizeLocale', () => {
  it('zh 开头的语言标签一律归为简体中文（含繁体与下划线写法）', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-Hans-CN', 'ZH-tw', 'zh_HK']) {
      expect(normalizeLocale(tag), tag).toBe('zh-CN');
    }
  });

  it('其余语言一律英文', () => {
    for (const tag of ['en', 'en-US', 'EN-gb', 'ja', 'fr-FR', 'x']) {
      expect(normalizeLocale(tag), tag).toBe('en');
    }
  });

  it('没有语言标签时取基准语言（简体中文）', () => {
    for (const tag of [undefined, null, '', '   ']) {
      expect(normalizeLocale(tag)).toBe(FALLBACK_LOCALE);
    }
    expect(FALLBACK_LOCALE).toBe('zh-CN');
  });
});

describe('resolveLocale', () => {
  it('指定了语言就用它，不看系统', () => {
    expect(resolveLocale('en', ['zh-CN'])).toBe('en');
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN');
  });

  it('跟随系统（含没写过）时取系统语言列表里第一个认得的', () => {
    expect(resolveLocale('system', ['en-US', 'zh-CN'])).toBe('en');
    expect(resolveLocale(undefined, ['zh-CN', 'en-US'])).toBe('zh-CN');
    // 不认识的日语跳过，按用户的第二偏好
    expect(resolveLocale('system', ['ja-JP', 'zh-CN'])).toBe('zh-CN');
  });

  it('系统语言都不认识时用英文，系统什么也没给时用基准语言', () => {
    expect(resolveLocale('system', ['ja-JP', 'fr'])).toBe('en');
    expect(resolveLocale('system', [])).toBe('zh-CN');
    expect(resolveLocale('system', ['', ' '])).toBe('zh-CN');
  });
});

describe('isLanguage', () => {
  it('只认跟随系统、简体中文与英文，默认跟随系统', () => {
    expect(LANGUAGES).toEqual(['system', 'zh-CN', 'en']);
    for (const value of LANGUAGES) expect(isLanguage(value)).toBe(true);
    for (const value of ['zh', 'en-US', 'EN', '', null, undefined, 1]) {
      expect(isLanguage(value)).toBe(false);
    }
    expect(DEFAULT_LANGUAGE).toBe('system');
  });
});

describe('interpolate', () => {
  it('替换 {name} 占位符，数字转成字符串，同一个占位符可出现多次', () => {
    expect(interpolate('{count} 个模型', { count: 3 })).toBe('3 个模型');
    expect(interpolate('{a} → {b}', { a: 'x', b: 'y' })).toBe('x → y');
    expect(interpolate('{n}/{n}', { n: 2 })).toBe('2/2');
  });

  it('缺少的参数保留占位符；不传参数时原样返回', () => {
    expect(interpolate('{count} models', {})).toBe('{count} models');
    expect(interpolate('Hello {name}')).toBe('Hello {name}');
  });

  it('{n|单数|复数} 按 n 是否为 1 选写法', () => {
    const template = '{count} {count|file|files}';
    expect(interpolate(template, { count: 1 })).toBe('1 file');
    expect(interpolate(template, { count: 0 })).toBe('0 files');
    expect(interpolate(template, { count: 12 })).toBe('12 files');
    // 单数为空：后缀写法
    expect(interpolate('{n} model{n||s}', { n: 1 })).toBe('1 model');
    expect(interpolate('{n} model{n||s}', { n: 2 })).toBe('2 models');
    // 没给这个参数时整段保留
    expect(interpolate('{n|a|b}', {})).toBe('{n|a|b}');
  });

  it('不碰不像占位符的花括号（JSON、路径模板）', () => {
    expect(interpolate('{"command": "npx"}', { command: 'x' })).toBe('{"command": "npx"}');
    expect(interpolate('<root>/{repo}/…', { other: 1 })).toBe('<root>/{repo}/…');
  });
});

const zh = {
  common: { save: '保存', count: '{count} 个' },
  settings: { general: { title: '通用' } },
};
const en: MessagesShape<typeof zh> = {
  common: { save: 'Save', count: '{count} {count|item|items}' },
  settings: { general: { title: 'General' } },
};

describe('createTranslator', () => {
  it('按语言取模板并插值', () => {
    const translator = createTranslator<typeof zh>({ 'zh-CN': zh, en });
    expect(translator('zh-CN')('settings.general.title')).toBe('通用');
    expect(translator('en')('settings.general.title')).toBe('General');
    expect(translator('zh-CN')('common.count', { count: 2 })).toBe('2 个');
    expect(translator('en')('common.count', { count: 1 })).toBe('1 item');
  });

  it('同一语言返回同一个函数（组件可直接放进依赖数组）', () => {
    const translator = createTranslator<typeof zh>({ 'zh-CN': zh, en });
    expect(translator('en')).toBe(translator('en'));
    expect(translator('en')).not.toBe(translator('zh-CN'));
  });

  it('当前语言缺 key 时回退简体中文并报告；两边都没有时返回 key 本身', () => {
    const onMissing = vi.fn();
    const partial = { common: { save: 'Save' } } as unknown as MessagesShape<typeof zh>;
    const t = createTranslator<typeof zh>({ 'zh-CN': zh, en: partial }, { onMissing })('en');
    expect(t('common.count', { count: 3 })).toBe('3 个');
    expect(onMissing).toHaveBeenLastCalledWith('common.count', 'en');
    expect(t('common.save')).toBe('Save');
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(t('nope.missing' as 'common.save')).toBe('nope.missing');
    expect(onMissing).toHaveBeenLastCalledWith('nope.missing', 'en');
  });
});

describe('messageKeys / messagePlaceholders', () => {
  it('列出全部叶子的点分路径（排好序）', () => {
    expect(messageKeys(zh)).toEqual(['common.count', 'common.save', 'settings.general.title']);
  });

  it('列出模板里的参数名（去重排序，含单复数写法里的）', () => {
    expect(messagePlaceholders('{b} and {a}, {a}')).toEqual(['a', 'b']);
    expect(messagePlaceholders('{count} {count|item|items} in {dir}')).toEqual(['count', 'dir']);
    expect(messagePlaceholders('{"a": 1}')).toEqual([]);
  });
});
