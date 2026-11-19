import { describe, expect, it, vi } from 'vitest';
import type { OrchestrationRegistry } from '../orchestration/registry';
import type { AgentHostService } from './agentHost';
import { connectOrchestration } from './connectOrchestration';

describe('connectOrchestration：协调者是否受限', () => {
  it('profile 为 restricted 时受限，普通会话不受限，查不到会话时按受限处理', async () => {
    const sessions: Record<string, { profile?: string }> = {
      restricted: { profile: 'restricted' },
      normal: {},
    };
    const agentHost = {
      implementsLauncher: vi.fn(),
      setOrchestrationHostFactory: vi.fn(),
      setWorkerHostFactory: vi.fn(),
      setCoordinatorLookup: vi.fn(),
      setActiveWorkLookup: vi.fn(),
      setOpenTaskLookup: vi.fn(),
      get: (id: string) => sessions[id],
    } as unknown as AgentHostService;
    let lookup: ((sessionId: string) => boolean) | undefined;
    const registry = {
      setLauncher: vi.fn(),
      setRestrictedCoordinatorLookup: (next: (sessionId: string) => boolean) => {
        lookup = next;
      },
      openAll: async () => {},
    } as unknown as OrchestrationRegistry;

    await connectOrchestration(agentHost, registry);

    expect(lookup?.('restricted')).toBe(true);
    expect(lookup?.('normal')).toBe(false);
    expect(lookup?.('missing')).toBe(true);
  });
});
