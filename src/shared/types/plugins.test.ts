import { describe, expect, it } from 'vitest';
import { parsePluginDescription } from './plugins';

describe('parsePluginDescription', () => {
  it('trim 后 1–300 字才保留', () => {
    expect(parsePluginDescription('  懒人模式  ')).toBe('懒人模式');
    expect(parsePluginDescription('x'.repeat(300))).toBe('x'.repeat(300));
  });

  it('空白、超长、非字符串返回 undefined', () => {
    for (const raw of ['   ', 'x'.repeat(301), 42, null, undefined]) {
      expect(parsePluginDescription(raw)).toBeUndefined();
    }
  });
});
