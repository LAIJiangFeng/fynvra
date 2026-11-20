import { describe, expect, it } from 'vitest';
import { visibleSections } from './officialPlugins';

describe('visibleSections', () => {
  const sections = [{ value: 'plugins' as const }, { value: 'telegram' as const }];

  it('官方插件未启用时隐藏其入口，其他条目保留', () => {
    expect(visibleSections(sections, new Set()).map((item) => item.value)).toEqual(['plugins']);
  });

  it('官方插件启用后显示其入口', () => {
    expect(visibleSections(sections, new Set(['telegram'] as const))).toEqual(sections);
  });
});
