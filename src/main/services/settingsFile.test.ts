import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultSettings, type Settings, type ThemeMode } from '@shared/types/settings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsFile, SETTINGS_WRITE_DEBOUNCE_MS } from './settingsFile';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fynvra-settings-'));
  filePath = join(dir, 'settings.json');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const readDisk = (): Settings => JSON.parse(readFileSync(filePath, 'utf8'));

const withTheme =
  (theme: ThemeMode) =>
  (current: Settings): Settings => ({
    ...current,
    preferences: { ...current.preferences, theme },
  });

describe('createSettingsFile', () => {
  it('文件不存在时返回默认值，且不会主动落盘', () => {
    const file = createSettingsFile({ filePath });
    expect(file.read()).toEqual(createDefaultSettings());
    expect(file.flush()).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });

  it('JSON 损坏时按默认值启动', () => {
    writeFileSync(filePath, '{ not json');
    expect(createSettingsFile({ filePath }).read()).toEqual(createDefaultSettings());
  });

  it('读取时收窄磁盘内容', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        preferences: { theme: 'dark', sidePanelOpen: 'yes' },
        workspaces: [{ id: '../escape', name: 'x', repoPath: '/x', defaultBranch: 'main' }],
      })
    );
    expect(createSettingsFile({ filePath }).read()).toEqual({
      ...createDefaultSettings(),
      preferences: { theme: 'dark', sidePanelOpen: true },
    });
  });

  it('更新在防抖窗口结束后才落盘，窗口内的连续更新合并为最后一次', () => {
    vi.useFakeTimers();
    const file = createSettingsFile({ filePath });
    expect(file.update(withTheme('dark')).changed).toBe(true);
    vi.advanceTimersByTime(SETTINGS_WRITE_DEBOUNCE_MS - 1);
    file.update(withTheme('light'));
    vi.advanceTimersByTime(SETTINGS_WRITE_DEBOUNCE_MS - 1);
    expect(existsSync(filePath)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(readDisk().preferences.theme).toBe('light');
  });

  it('防抖时长为 500ms', () => {
    expect(SETTINGS_WRITE_DEBOUNCE_MS).toBe(500);
  });

  it('flush 立即原子替换，不留临时文件，新实例能读回', () => {
    writeFileSync(filePath, JSON.stringify(createDefaultSettings()));
    const file = createSettingsFile({ filePath });
    const { settings } = file.update(withTheme('dark'));
    expect(file.flush()).toBe(true);
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
    expect(readDisk()).toEqual(settings);
    expect(createSettingsFile({ filePath }).read()).toEqual(settings);
  });

  it('内容未变化的更新不安排写入', () => {
    const file = createSettingsFile({ filePath });
    expect(file.update((current) => ({ ...current })).changed).toBe(false);
    expect(file.flush()).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });

  it('写入失败时保留待写内容并清理临时文件，下次 flush 重试', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mkdirSync(filePath); // 目标被目录占用，rename 必然失败
    const file = createSettingsFile({ filePath });
    file.update(withTheme('dark'));
    expect(file.flush()).toBe(false);
    expect(error).toHaveBeenCalled();
    expect(existsSync(`${filePath}.tmp`)).toBe(false);

    rmSync(filePath, { recursive: true });
    expect(file.flush()).toBe(true);
    expect(readDisk().preferences.theme).toBe('dark');
  });

  it('父目录不存在时自动创建', () => {
    const nested = join(dir, 'nested', 'settings.json');
    const file = createSettingsFile({ filePath: nested });
    file.update(withTheme('light'));
    expect(file.flush()).toBe(true);
    expect(existsSync(nested)).toBe(true);
  });
});
