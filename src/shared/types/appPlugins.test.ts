import { describe, expect, it } from 'vitest';
import {
  parseAppPluginIdInput,
  parseAppPluginManifest,
  parseAppPluginToggleInput,
  parseHostInbound,
  parseHostOutbound,
} from './appPlugins';

const manifest = (patch: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: 'com.fynvra.telegram',
  name: 'Telegram',
  version: '1.0.0',
  kind: 'fynvra',
  host: { main: 'dist/host.js' },
  permissions: ['network', 'shell', 'channel'],
  ...patch,
});

describe('parseAppPluginManifest', () => {
  it('解析合法清单，权限按 fynvra 词表过滤', () => {
    expect(parseAppPluginManifest(manifest())).toEqual({
      id: 'com.fynvra.telegram',
      name: 'Telegram',
      version: '1.0.0',
      kind: 'fynvra',
      host: { main: 'dist/host.js' },
      permissions: ['network', 'channel'],
    });
  });

  it('kind 不对、host.main 缺失 / 越界 / 反斜杠 / 非 js 时为 null', () => {
    for (const patch of [
      { kind: undefined },
      { kind: 'pi' },
      { host: undefined },
      { host: { main: '../x.js' } },
      { host: { main: '/abs/x.js' } },
      { host: { main: 'dist\\x.js' } },
      { host: { main: 'dist/x.ts' } },
      { id: 'Bad Id' },
    ]) {
      expect(parseAppPluginManifest(manifest(patch))).toBeNull();
    }
    expect(parseAppPluginManifest(manifest({ host: { main: 'a/b.mjs' } }))?.host.main).toBe(
      'a/b.mjs'
    );
  });
});

describe('RPC 消息与 IPC 入参', () => {
  it('收窄 RPC 消息', () => {
    expect(parseHostOutbound({ type: 'req', id: 1, method: 'log', params: {} })).toMatchObject({
      type: 'req',
    });
    expect(parseHostOutbound({ type: 'req', id: 0, method: 'log' })).toBeNull();
    expect(parseHostOutbound({ type: 'eval' })).toBeNull();
    expect(parseHostInbound({ type: 'call', id: 2, name: 'ui.action', args: 1 })).toMatchObject({
      type: 'call',
    });
    expect(
      parseHostInbound({ type: 'init', pluginId: 'x', entryPath: '/a', dataDir: '/b' })
    ).toBeNull();
  });

  it('IPC 入参拒绝多余键', () => {
    expect(parseAppPluginIdInput({ id: 'fynvra.demo' })).toEqual({ id: 'fynvra.demo' });
    expect(parseAppPluginIdInput({ id: 'fynvra.demo', x: 1 })).toBeNull();
    expect(parseAppPluginToggleInput({ id: 'fynvra.demo', enabled: true })).toEqual({
      id: 'fynvra.demo',
      enabled: true,
    });
    expect(parseAppPluginToggleInput({ id: 'fynvra.demo', enabled: 1 })).toBeNull();
  });
});
