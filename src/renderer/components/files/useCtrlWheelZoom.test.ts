import { describe, expect, it } from 'vitest';
import { attachCtrlWheelZoom, clampZoom } from './useCtrlWheelZoom';

// 无 jsdom：用 Node 原生 EventTarget/Event 模拟 WheelEvent 的相关字段
function wheel(deltaY: number, mods: { ctrlKey?: boolean; metaKey?: boolean } = {}) {
  const event = new Event('wheel', { cancelable: true });
  Object.assign(event, { deltaY, ctrlKey: false, metaKey: false, ...mods });
  return event;
}

function setup() {
  const target = new EventTarget();
  const state = { zoom: 1 };
  attachCtrlWheelZoom(target, (factor) => {
    state.zoom = clampZoom(state.zoom * factor, 0.1, 8);
  });
  return { target, state };
}

describe('attachCtrlWheelZoom', () => {
  it('ctrl/meta + wheel zooms and prevents default', () => {
    const { target, state } = setup();
    const up = wheel(-100, { ctrlKey: true });
    target.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(true);
    expect(state.zoom).toBeGreaterThan(1);

    const before = state.zoom;
    const down = wheel(100, { metaKey: true });
    target.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(state.zoom).toBeLessThan(before);
  });

  it('plain wheel does not zoom or prevent scrolling', () => {
    const { target, state } = setup();
    const event = wheel(-100);
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(state.zoom).toBe(1);
  });

  it('clamps the zoom', () => {
    const { target, state } = setup();
    for (let i = 0; i < 50; i++) target.dispatchEvent(wheel(-500, { ctrlKey: true }));
    expect(state.zoom).toBe(8);
    for (let i = 0; i < 50; i++) target.dispatchEvent(wheel(500, { ctrlKey: true }));
    expect(state.zoom).toBe(0.1);
  });
});
