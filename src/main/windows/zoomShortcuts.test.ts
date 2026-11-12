import type { Input } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { registerZoomShortcuts, zoomLevelFor } from './zoomShortcuts';

const key = (k: string, mods: Partial<Input> = {}): Input =>
  ({
    type: 'keyDown',
    key: k,
    code: '',
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...mods,
  }) as Input;

describe('zoomLevelFor', () => {
  it('Mod+= / Mod++ 放大，Mod+- 缩小，Mod+0 复位', () => {
    expect(zoomLevelFor(key('=', { meta: true }), 0, 'darwin')).toBe(0.5);
    expect(zoomLevelFor(key('+', { control: true, shift: true }), 0, 'win32')).toBe(0.5);
    expect(zoomLevelFor(key('-', { meta: true }), 0, 'darwin')).toBe(-0.5);
    expect(zoomLevelFor(key('-', { control: true, code: 'NumpadSubtract' }), 1, 'linux')).toBe(0.5);
    expect(zoomLevelFor(key('0', { control: true }), 2.5, 'win32')).toBe(0);
  });

  it('级别被限制在 -3 … 5', () => {
    expect(zoomLevelFor(key('=', { meta: true }), 5, 'darwin')).toBe(5);
    expect(zoomLevelFor(key('-', { meta: true }), -3, 'darwin')).toBe(-3);
  });

  it('没有 Mod、平台不对的修饰键、带 Alt 或 keyUp 时忽略', () => {
    expect(zoomLevelFor(key('-'), 0, 'darwin')).toBeNull();
    expect(zoomLevelFor(key('-', { control: true }), 0, 'darwin')).toBeNull();
    expect(zoomLevelFor(key('-', { meta: true }), 0, 'win32')).toBeNull();
    expect(zoomLevelFor(key('-', { meta: true, alt: true }), 0, 'darwin')).toBeNull();
    expect(zoomLevelFor(key('-', { meta: true, type: 'keyUp' }), 0, 'darwin')).toBeNull();
    expect(zoomLevelFor(key('a', { meta: true }), 0, 'darwin')).toBeNull();
  });
});

it('registerZoomShortcuts 处理快捷键并阻止默认菜单重复缩放', () => {
  let handler: (event: { preventDefault: () => void }, input: Input) => void = () => {};
  const wc = {
    on: vi.fn((_: string, fn: typeof handler) => (handler = fn)),
    getZoomLevel: vi.fn(() => 1),
    setZoomLevel: vi.fn(),
  };
  registerZoomShortcuts(wc as never);
  const mod = process.platform === 'darwin' ? { meta: true } : { control: true };
  const event = { preventDefault: vi.fn() };
  handler(event, key('-', mod));
  expect(wc.setZoomLevel).toHaveBeenCalledWith(0.5);
  expect(event.preventDefault).toHaveBeenCalled();

  const plain = { preventDefault: vi.fn() };
  handler(plain, key('-'));
  expect(plain.preventDefault).not.toHaveBeenCalled();
  expect(wc.setZoomLevel).toHaveBeenCalledTimes(1);
});
