import { type Language, type Messages, messageKeys, messagePlaceholders } from '@shared/i18n';
import { mainEn } from '@shared/i18n/main/en';
import { mainZhCN } from '@shared/i18n/main/zh-CN';
import { afterEach, describe, expect, it } from 'vitest';
import { configureMainLocale, mainLocale, translate } from './i18n';

const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/u;

function entries(messages: Messages, prefix = ''): [string, string][] {
  return Object.entries(messages).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [[path, value] as [string, string]] : entries(value, path);
  });
}

function useLanguage(language: Language | undefined, system: readonly string[] = ['zh-CN']) {
  configureMainLocale({ language: () => language, systemLanguages: () => system });
}

afterEach(() => configureMainLocale(null));

describe('Main 字典', () => {
  it('两份字典的 key 集合一致', () => {
    expect(messageKeys(mainEn)).toEqual(messageKeys(mainZhCN));
  });

  it('同一 key 两边用的参数一致；没有空文案；英文里没有中文字符', () => {
    const english = new Map(entries(mainEn));
    for (const [key, chinese] of entries(mainZhCN)) {
      const text = english.get(key) ?? '';
      expect(messagePlaceholders(text), key).toEqual(messagePlaceholders(chinese));
      expect(chinese.trim(), key).not.toBe('');
      expect(text.trim(), key).not.toBe('');
      expect(text, key).not.toMatch(CJK);
    }
  });

  it('英文导入告警的后续动作都接在「; 」之后（Renderer 的 warningLine 按它截掉）', () => {
    for (const [key, text] of entries(mainEn)) {
      if (!key.startsWith('importers.') || !/(skipped|ignored|after import)$/.test(text)) continue;
      expect(text, key).toMatch(/; [^;]+$/);
    }
  });
});

describe('Main 翻译函数', () => {
  it('没接上语言来源时按简体中文（测试、启动早期）', () => {
    expect(mainLocale()).toBe('zh-CN');
    expect(translate('common.workspaceNotFound')).toBe('工作区不存在');
  });

  it('按设置里的语言翻译，改了设置下一次翻译就生效', () => {
    let language: Language = 'en';
    configureMainLocale({ language: () => language, systemLanguages: () => ['zh-CN'] });
    expect(translate('common.workspaceNotFound')).toBe('Workspace not found');
    language = 'zh-CN';
    expect(translate('common.workspaceNotFound')).toBe('工作区不存在');
  });

  it('跟随系统（含没写过）时按系统语言', () => {
    useLanguage('system', ['en-US']);
    expect(mainLocale()).toBe('en');
    useLanguage(undefined, ['zh-CN', 'en-US']);
    expect(mainLocale()).toBe('zh-CN');
  });

  it('参数与单复数', () => {
    useLanguage('en');
    expect(translate('mcp.readFailed', { error: 'EACCES' })).toBe(
      'Failed to read MCP servers: EACCES'
    );
    useLanguage('zh-CN');
    expect(translate('agent.protectedTitle', { title: 'bash', action: 'git push' })).toBe(
      'bash（保护底线：git push）'
    );
  });
});
