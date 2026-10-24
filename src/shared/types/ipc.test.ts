import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from './ipc';

describe('IPC_CHANNELS', () => {
  const channels = Object.values(IPC_CHANNELS);

  it('通道名统一为 domain:action', () => {
    for (const channel of channels) {
      expect(channel).toMatch(/^[a-z]+:[a-z]+(-[a-z]+)*$/);
    }
  });

  it('通道名不重复', () => {
    expect(new Set(channels).size).toBe(channels.length);
  });
});
