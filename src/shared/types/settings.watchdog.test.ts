import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  DEFAULT_WATCHDOG_PREFERENCES,
  parsePreferences,
  parsePreferencesPatch,
  watchdogPreferencesOf,
} from './settings';

// 会话守护设置的默认值与收窄

const DEFAULTS = {
  enabled: false,
  intervalSeconds: 60,
  maxAttempts: 10,
  scope: 'orchestrator',
  onModelError: true,
  onCrash: true,
  onStall: false,
  stallMinutes: 30,
};

describe('watchdog 默认值', () => {
  it('默认关闭，冻结；没配置过时按默认值生效且返回副本', () => {
    expect(DEFAULT_WATCHDOG_PREFERENCES).toEqual(DEFAULTS);
    expect(Object.isFrozen(DEFAULT_WATCHDOG_PREFERENCES)).toBe(true);
    const effective = watchdogPreferencesOf(DEFAULT_PREFERENCES);
    expect(effective).toEqual(DEFAULTS);
    effective.enabled = true;
    expect(DEFAULT_WATCHDOG_PREFERENCES.enabled).toBe(false);
  });
});

describe('parsePreferences：watchdog（宽松读盘）', () => {
  it('没有这一块时不加字段', () => {
    expect(parsePreferences({})).not.toHaveProperty('watchdog');
    expect(parsePreferences({ watchdog: 'on' })).not.toHaveProperty('watchdog');
  });

  it('逐项取合法值，越界、非整数、非法值用默认值，未知键丢弃', () => {
    expect(
      parsePreferences({
        watchdog: {
          enabled: true,
          intervalSeconds: 5,
          maxAttempts: 3,
          scope: 'everyone',
          onStall: 'yes',
          stallMinutes: 12.5,
          extra: 1,
        },
      }).watchdog
    ).toEqual({ ...DEFAULTS, enabled: true, maxAttempts: 3 });
    expect(
      parsePreferences({ watchdog: { scope: 'all', intervalSeconds: 1800, stallMinutes: 240 } })
        .watchdog
    ).toEqual({ ...DEFAULTS, scope: 'all', intervalSeconds: 1800, stallMinutes: 240 });
  });
});

describe('parsePreferencesPatch：watchdog（严格整块）', () => {
  it('接受齐全且合法的整块', () => {
    const watchdog = { ...DEFAULTS, enabled: true, scope: 'all', intervalSeconds: 15 };
    expect(parsePreferencesPatch({ watchdog })).toEqual({ watchdog });
  });

  it.each([
    ['null', null],
    ['缺字段', { ...DEFAULTS, stallMinutes: undefined }],
    ['间隔过小', { ...DEFAULTS, intervalSeconds: 14 }],
    ['间隔过大', { ...DEFAULTS, intervalSeconds: 1801 }],
    ['次数为 0', { ...DEFAULTS, maxAttempts: 0 }],
    ['次数超过 50', { ...DEFAULTS, maxAttempts: 51 }],
    ['卡住阈值非整数', { ...DEFAULTS, stallMinutes: 10.5 }],
    ['卡住阈值越界', { ...DEFAULTS, stallMinutes: 241 }],
    ['范围非法', { ...DEFAULTS, scope: 'workers' }],
    ['开关类型不符', { ...DEFAULTS, onCrash: 1 }],
    ['未知键', { ...DEFAULTS, extra: true }],
  ])('拒绝 %s', (_label, watchdog) => {
    const raw = { ...(watchdog as object) } as Record<string, unknown>;
    // 显式的 undefined 也算缺字段：JSON 不会带它
    for (const key of Object.keys(raw)) if (raw[key] === undefined) delete raw[key];
    expect(parsePreferencesPatch({ watchdog: watchdog === null ? null : raw })).toBeNull();
  });
});
