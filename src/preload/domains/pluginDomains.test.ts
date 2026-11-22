import { IPC_CHANNELS } from '@shared/types/ipc';
import { describe, expect, it, vi } from 'vitest';
import { createAppPluginsApi } from './appPlugins';
import { createPluginsApi } from './plugins';

describe('插件领域的 preload API', () => {
  it('readme 映射到对应通道，只传 id', async () => {
    const invoke = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
    const ipc = { invoke: invoke as never };
    const subscribe = vi.fn(() => () => undefined);

    await createPluginsApi(ipc, subscribe).readme({ id: 'demo' });
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.PLUGINS_README, { id: 'demo' });
    await createAppPluginsApi(ipc, subscribe).readme({ id: 'fynvra.demo' });
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.APP_PLUGINS_README, {
      id: 'fynvra.demo',
    });
    const input = { source: { kind: 'pi' as const, id: 'demo' }, src: 'logo.png' };
    await createPluginsApi(ipc, subscribe).readmeImage(input);
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.PLUGINS_README_IMAGE, input);
  });
});
