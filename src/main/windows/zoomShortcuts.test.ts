import type { Input } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { registerZoomShortcuts, zoomLevelFor } from './zoomShortcuts';

const CODES: Record<string, string> = { '=': 'Equal', '+': 'Equal', '-': 'Minus', '0': 'Digit0' };
const key = (k: string, mods: Partial<Input> = {}): Input =>
  ({
    type: 'keyDown',
    key: k,
    code: CODES[k] ?? `Key${k.toUpperCase()}`,
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...mods,
  }) as Input;

describe('zoomLevelFor', () => {
  it('Mod+= / Mod++ 放大，Mod+- 缩小，Mod+0 复位', () => {
    expect(zoomLevelFor(key('=', { meta: true }), 0, undefined, 'darwin')).toBe(0.5);
    expect(zoomLevelFor(key('+', { control: true, shift: true }), 0, undefined, 'win32')).toBe(0.5);
    expect(zoomLevelFor(key('-', { meta: true }), 0, undefined, 'darwin')).toBe(-0.5);
    expect(
      zoomLevelFor(key('-', { control: true, code: 'NumpadSubtract' }), 1, undefined, 'linux')
    ).toBe(0.5);
    expect(zoomLevelFor(key('0', { control: true }), 2.5, undefined, 'win32')).toBe(0);
  });

  it('级别被限制在 -3 … 5', () => {
    expect(zoomLevelFor(key('=', { meta: true }), 5, undefined, 'darwin')).toBe(5);
    expect(zoomLevelFor(key('-', { meta: true }), -3, undefined, 'darwin')).toBe(-3);
  });

  it('没有 Mod、平台不对的修饰键、带 Alt 或 keyUp 时忽略', () => {
    expect(zoomLevelFor(key('-'), 0, undefined, 'darwin')).toBeNull();
    expect(zoomLevelFor(key('-', { control: true }), 0, undefined, 'darwin')).toBeNull();
    expect(zoomLevelFor(key('-', { meta: true }), 0, undefined, 'win32')).toBeNull();
    expect(zoomLevelFor(key('-', { meta: true, alt: true }), 0, undefined, 'darwin')).toBeNull();
    expect(
      zoomLevelFor(key('-', { meta: true, type: 'keyUp' }), 0, undefined, 'darwin')
    ).toBeNull();
    expect(zoomLevelFor(key('a', { meta: true }), 0, undefined, 'darwin')).toBeNull();
  });

  it('改键后按新键缩放，旧键与它的别名不再响应', () => {
    const overrides = { 'zoom-out': 'ctrl+alt+j', 'zoom-in': 'mod+shift+=' };
    expect(zoomLevelFor(key('j', { control: true, alt: true }), 0, overrides, 'win32')).toBe(-0.5);
    expect(zoomLevelFor(key('-', { control: true }), 0, overrides, 'win32')).toBeNull();
    expect(
      zoomLevelFor(key('-', { control: true, code: 'NumpadSubtract' }), 0, overrides, 'win32')
    ).toBeNull();
    expect(zoomLevelFor(key('=', { control: true }), 0, overrides, 'win32')).toBeNull();
    expect(zoomLevelFor(key('+', { control: true, shift: true }), 0, overrides, 'win32')).toBe(0.5);
    // 没改的动作照旧
    expect(zoomLevelFor(key('0', { control: true }), 1, overrides, 'win32')).toBe(0);
  });
});

it('registerZoomShortcuts 处理快捷键、现读覆盖表，并让默认菜单不响应缩放键', () => {
  let handler: (event: { preventDefault: () => void }, input: Input) => void = () => {};
  const wc = {
    on: vi.fn((_: string, fn: typeof handler) => (handler = fn)),
    getZoomLevel: vi.fn(() => 1),
    setZoomLevel: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(),
  };
  let overrides: Record<string, string> | undefined;
  registerZoomShortcuts(wc as never, () => overrides);
  const mod = process.platform === 'darwin' ? { meta: true } : { control: true };
  const event = { preventDefault: vi.fn() };
  handler(event, key('-', mod));
  expect(wc.setZoomLevel).toHaveBeenCalledWith(0.5);
  expect(event.preventDefault).toHaveBeenCalled();
  expect(wc.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);

  const plain = { preventDefault: vi.fn() };
  handler(plain, key('-'));
  expect(plain.preventDefault).not.toHaveBeenCalled();
  expect(wc.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
  expect(wc.setZoomLevel).toHaveBeenCalledTimes(1);

  overrides = { 'zoom-out': 'ctrl+alt+j' };
  const old = { preventDefault: vi.fn() };
  handler(old, key('-', mod));
  expect(old.preventDefault).not.toHaveBeenCalled();
  expect(wc.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
  expect(wc.setZoomLevel).toHaveBeenCalledTimes(1);
});
