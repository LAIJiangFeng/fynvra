import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_PREFERENCES,
  notificationPreferencesOf,
  parsePreferences,
  parsePreferencesPatch,
  parseSettings,
} from './settings';

// Task 24：preferences.notifications 的默认值与收窄（与 Task 25 / 26 的字段分文件，减少合并冲突）

const ALL_ON = { enabled: true, mainAgentOnly: true, askAndApproval: true, sound: true };

describe('notifications 默认值', () => {
  it('全部打开：总开关、仅主 agent 完成、提问与审批、声音', () => {
    expect(DEFAULT_NOTIFICATION_PREFERENCES).toEqual(ALL_ON);
    expect(Object.isFrozen(DEFAULT_NOTIFICATION_PREFERENCES)).toBe(true);
  });

  it('没配置过时按默认值生效，返回的是副本', () => {
    const effective = notificationPreferencesOf(DEFAULT_PREFERENCES);
    expect(effective).toEqual(ALL_ON);
    effective.sound = false;
    expect(DEFAULT_NOTIFICATION_PREFERENCES.sound).toBe(true);
    const custom = { ...ALL_ON, sound: false };
    expect(notificationPreferencesOf({ ...DEFAULT_PREFERENCES, notifications: custom })).toEqual(
      custom
    );
  });
});

describe('parsePreferences：notifications', () => {
  it('没有这一块时不加字段（老的 settings.json 原样读出）', () => {
    expect(parsePreferences({ theme: 'dark' })).not.toHaveProperty('notifications');
    expect(parseSettings({ preferences: {} }).preferences).toEqual(DEFAULT_PREFERENCES);
  });

  it('逐项取布尔值，缺失或非法的项用默认值，未知键丢弃', () => {
    expect(
      parsePreferences({ notifications: { enabled: false, sound: 'no', extra: 1 } }).notifications
    ).toEqual({ ...ALL_ON, enabled: false });
    expect(parsePreferences({ notifications: {} }).notifications).toEqual(ALL_ON);
    expect(
      parsePreferences({
        notifications: { enabled: true, mainAgentOnly: false, askAndApproval: false, sound: false },
      }).notifications
    ).toEqual({ enabled: true, mainAgentOnly: false, askAndApproval: false, sound: false });
  });

  it.each([null, 'off', 0, [], [false]])('不是对象（%j）时整块丢弃', (notifications) => {
    expect(parsePreferences({ notifications })).not.toHaveProperty('notifications');
  });

  it('原型污染键不起作用', () => {
    const parsed = parsePreferences(
      JSON.parse('{"notifications": {"__proto__": {"enabled": false}}}')
    ).notifications;
    expect(parsed).toEqual(ALL_ON);
    expect(parsed && Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });
});

describe('parsePreferencesPatch：notifications（settings:update 入参）', () => {
  it('接受四项齐全的布尔值，可与其他字段一起改', () => {
    const notifications = {
      enabled: false,
      mainAgentOnly: true,
      askAndApproval: false,
      sound: true,
    };
    expect(parsePreferencesPatch({ notifications })).toEqual({ notifications });
    expect(parsePreferencesPatch({ theme: 'dark', notifications: ALL_ON })).toEqual({
      theme: 'dark',
      notifications: ALL_ON,
    });
  });

  it.each([
    ['null', null],
    ['布尔值', false],
    ['数组', [ALL_ON]],
    [
      '缺一项（整块替换，缺的项会丢）',
      { enabled: true, mainAgentOnly: true, askAndApproval: true },
    ],
    ['类型不符', { ...ALL_ON, sound: 'true' }],
    ['未知键', { ...ALL_ON, volume: 3 }],
    [
      '原型污染键',
      JSON.parse(
        '{"enabled": true, "mainAgentOnly": true, "askAndApproval": true, "sound": true, "__proto__": {}}'
      ),
    ],
  ])('拒绝 %s', (_label, notifications) => {
    expect(parsePreferencesPatch({ notifications })).toBeNull();
  });
});
