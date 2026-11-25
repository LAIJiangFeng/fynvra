import { describe, expect, it } from 'vitest';
import { pluginBrandLogo } from './pluginBrand';

describe('pluginBrandLogo', () => {
  it('官方飞书、Telegram 插件取到品牌图标', () => {
    expect(pluginBrandLogo('com.fynvra.feishu')).toMatch(/feishu/);
    expect(pluginBrandLogo('com.fynvra.telegram')).toMatch(/telegram/);
  });

  it('其他 id 与原型属性名返回 undefined', () => {
    expect(pluginBrandLogo('com.example.other')).toBeUndefined();
    expect(pluginBrandLogo('constructor')).toBeUndefined();
    expect(pluginBrandLogo('__proto__')).toBeUndefined();
  });
});
