import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEMORY_PREFERENCES,
  DEFAULT_PREFERENCES,
  memoryPreferencesOf,
  parsePreferences,
  parsePreferencesPatch,
} from './settings';

// 项目记忆设置的默认值与收窄

const DEFAULTS = { enabled: true, autoExtract: true, expireDays: 28 };
const MODEL = { providerId: 'p1', modelId: 'm1' };

describe('memory 默认值', () => {
  it('默认开启、28 天，冻结；没配置过时返回默认值副本', () => {
    expect(DEFAULT_MEMORY_PREFERENCES).toEqual(DEFAULTS);
    expect(Object.isFrozen(DEFAULT_MEMORY_PREFERENCES)).toBe(true);
    const effective = memoryPreferencesOf(DEFAULT_PREFERENCES);
    expect(effective).toEqual(DEFAULTS);
    effective.enabled = false;
    expect(DEFAULT_MEMORY_PREFERENCES.enabled).toBe(true);
  });

  it('返回的 model 也是副本', () => {
    const preferences = { memory: { ...DEFAULTS, model: { ...MODEL } } };
    const effective = memoryPreferencesOf(preferences);
    expect(effective.model).not.toBe(preferences.memory.model);
    expect(effective.model).toEqual(MODEL);
    expect(preferences.memory.model.modelId).toBe('m1');
  });
});

describe('parsePreferences：memory（宽松读盘）', () => {
  it('没有这一块或不是对象时不加字段', () => {
    expect(parsePreferences({})).not.toHaveProperty('memory');
    expect(parsePreferences({ memory: true })).not.toHaveProperty('memory');
  });

  it('逐项取合法值，坏值回退默认，未知键丢弃；model 只留两个 id', () => {
    expect(
      parsePreferences({
        memory: {
          enabled: 'no',
          autoExtract: false,
          expireDays: 6,
          model: { ...MODEL, thinking: 'high' },
          extra: 1,
        },
      }).memory
    ).toEqual({ ...DEFAULTS, autoExtract: false, model: MODEL });
    expect(
      parsePreferences({ memory: { expireDays: 365, model: { providerId: '' } } }).memory
    ).toEqual({ ...DEFAULTS, expireDays: 365 });
    expect(parsePreferences({ memory: { expireDays: 30.5 } }).memory).toEqual(DEFAULTS);
  });
});

describe('parsePreferencesPatch：memory（严格整块）', () => {
  it('接受齐全且合法的整块，model 可省', () => {
    expect(parsePreferencesPatch({ memory: DEFAULTS })).toEqual({ memory: DEFAULTS });
    const memory = { enabled: false, autoExtract: false, expireDays: 7, model: MODEL };
    expect(parsePreferencesPatch({ memory })).toEqual({ memory });
  });

  it.each([
    ['null', null],
    ['缺 enabled', { autoExtract: true, expireDays: 28 }],
    ['缺 expireDays', { enabled: true, autoExtract: true }],
    ['天数过小', { ...DEFAULTS, expireDays: 6 }],
    ['天数过大', { ...DEFAULTS, expireDays: 366 }],
    ['天数非整数', { ...DEFAULTS, expireDays: 10.5 }],
    ['开关类型不符', { ...DEFAULTS, autoExtract: 'yes' }],
    ['未知键', { ...DEFAULTS, extra: true }],
    ['model 带多余键', { ...DEFAULTS, model: { ...MODEL, thinking: 'high' } }],
    ['model 缺 id', { ...DEFAULTS, model: { providerId: 'p1' } }],
    ['model 为 null', { ...DEFAULTS, model: null }],
  ])('拒绝 %s', (_label, memory) => {
    expect(parsePreferencesPatch({ memory })).toBeNull();
  });
});
