import { type Messages, messageKeys, messagePlaceholders } from '@shared/i18n';
import { afterEach, describe, expect, it } from 'vitest';
import { en } from './en';
import { currentLocale, setCurrentLocale, translate, translatorOf } from './index';
import { zhCN } from './zh-CN';

const CJK = /[　-〿㐀-鿿＀-￯]/u;

function entries(messages: Messages, prefix = ''): [string, string][] {
  return Object.entries(messages).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [[path, value] as [string, string]] : entries(value, path);
  });
}

describe('界面字典', () => {
  it('两份字典的 key 集合一致', () => {
    expect(messageKeys(en)).toEqual(messageKeys(zhCN));
  });

  it('同一 key 两边用的参数一致', () => {
    const english = new Map(entries(en));
    for (const [key, chinese] of entries(zhCN)) {
      expect(messagePlaceholders(english.get(key) ?? ''), key).toEqual(
        messagePlaceholders(chinese)
      );
    }
  });

  it('没有空文案；英文里没有中文字符与全角标点', () => {
    for (const [key, text] of [...entries(zhCN), ...entries(en)]) {
      expect(text.trim(), key).not.toBe('');
    }
    for (const [key, text] of entries(en)) expect(text, key).not.toMatch(CJK);
  });

  it('文案不以句号结尾', () => {
    for (const [key, text] of entries(zhCN)) expect(text, key).not.toMatch(/。$/u);
    for (const [key, text] of entries(en)) expect(text, key).not.toMatch(/[^.]\.$/u);
  });
});

describe('translate', () => {
  afterEach(() => setCurrentLocale('zh-CN'));

  it('按语言取文案', () => {
    expect(translatorOf('zh-CN')('common.close')).toBe('关闭');
    expect(translatorOf('en')('common.close')).toBe('Close');
  });

  it('不在组件里的代码按当前语言翻译，默认简体中文', () => {
    expect(currentLocale()).toBe('zh-CN');
    expect(translate('common.close')).toBe('关闭');
    setCurrentLocale('en');
    expect(translate('common.close')).toBe('Close');
    expect(translate('settings.general.days', { days: 1 })).toBe('1 day');
    expect(translate('settings.general.days', { days: 7 })).toBe('7 days');
  });
});
