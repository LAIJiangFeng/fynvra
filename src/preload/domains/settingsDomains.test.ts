import { IPC_CHANNELS } from '@shared/types/ipc';
import { describe, expect, it, vi } from 'vitest';
import { createMcpApi } from './mcp';
import { createProvidersApi } from './providers';
import { createRolesApi } from './roles';
import { createSkillsApi } from './skills';

function bridge() {
  const invoke = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
  const unsubscribe = vi.fn();
  const subscribe = vi.fn(
    (_channel: string, _listener: (...args: unknown[]) => void) => unsubscribe
  );
  return { ipc: { invoke: invoke as never }, invoke, subscribe, unsubscribe };
}

describe('settings 领域的 preload API', () => {
  it('方法映射到对应通道，按 id 操作的方法只传 id', async () => {
    const { ipc, invoke, subscribe } = bridge();
    const providers = createProvidersApi(ipc, subscribe);
    const roles = createRolesApi(ipc, subscribe);
    const skills = createSkillsApi(ipc, subscribe);
    const mcp = createMcpApi(ipc, subscribe);

    await providers.list();
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.PROVIDERS_LIST);
    await providers.test('anthropic');
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.PROVIDERS_TEST, 'anthropic');
    await providers.remove('anthropic');
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.PROVIDERS_REMOVE, 'anthropic');

    await roles.get('tester');
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.ROLES_GET, 'tester');
    await roles.remove('tester');
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.ROLES_REMOVE, 'tester');

    await skills.add();
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.SKILLS_ADD);
    await skills.add({ candidateIds: ['claude:pdf'] });
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.SKILLS_ADD, {
      candidateIds: ['claude:pdf'],
    });
    await skills.scan();
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.SKILLS_SCAN);

    await mcp.toggle({ id: 'github', enabled: false });
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.MCP_TOGGLE, {
      id: 'github',
      enabled: false,
    });
    await mcp.importClaude();
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.MCP_IMPORT_CLAUDE);
  });

  it('onChanged 订阅各自的 changed 通道，回调不带参数，返回取消函数', () => {
    const { ipc, subscribe, unsubscribe } = bridge();
    const apis = [
      [createProvidersApi(ipc, subscribe), IPC_CHANNELS.PROVIDERS_CHANGED],
      [createRolesApi(ipc, subscribe), IPC_CHANNELS.ROLES_CHANGED],
      [createSkillsApi(ipc, subscribe), IPC_CHANNELS.SKILLS_CHANGED],
      [createMcpApi(ipc, subscribe), IPC_CHANNELS.MCP_CHANGED],
    ] as const;

    for (const [api, channel] of apis) {
      const callback = vi.fn();
      expect(api.onChanged(callback)).toBe(unsubscribe);
      const [subscribed, listener] = subscribe.mock.calls.at(-1) ?? [];
      expect(subscribed).toBe(channel);
      listener?.('leaked');
      expect(callback).toHaveBeenCalledWith();
    }
  });
});
