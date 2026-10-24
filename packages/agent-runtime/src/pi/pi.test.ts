import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { emitSessionShutdown } from './lifecycle';
import { createRoleMcpExtensions } from './mcp';

function fakeRunner(hasHandlers: boolean, emit: () => Promise<void>) {
  return {
    extensionRunner: { hasHandlers: vi.fn(() => hasHandlers), emit: vi.fn(emit) },
  } as unknown as Pick<AgentSession, 'extensionRunner'> & {
    extensionRunner: { emit: ReturnType<typeof vi.fn> };
  };
}

describe('emitSessionShutdown', () => {
  it('emits session_shutdown when an extension listens for it', async () => {
    const session = fakeRunner(true, async () => {});
    await emitSessionShutdown(session);
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({
      type: 'session_shutdown',
      reason: 'quit',
    });
  });

  it('skips the event without listeners and never throws', async () => {
    const quiet = fakeRunner(false, async () => {});
    await emitSessionShutdown(quiet);
    expect(quiet.extensionRunner.emit).not.toHaveBeenCalled();
    const failing = fakeRunner(true, async () => {
      throw new Error('mcp close failed');
    });
    await expect(emitSessionShutdown(failing)).resolves.toBeUndefined();
  });
});

describe('createRoleMcpExtensions', () => {
  it('returns no extensions without servers', () => {
    expect(createRoleMcpExtensions([])).toEqual({ extensions: [], servers: [], warnings: [] });
  });

  it('defaults exposure to direct and injects the servers without reading mcp.json', () => {
    const plan = createRoleMcpExtensions([
      { name: 'docs', url: 'https://example.com/mcp' },
      { name: 'fs', command: 'npx', args: ['-y', 'server-fs'], exposure: 'hidden' },
    ]);
    expect(plan.extensions.map((extension) => extensionName(extension))).toEqual(['fynvra-mcp']);
    expect(plan.servers).toEqual([
      {
        name: 'docs',
        config: { url: 'https://example.com/mcp', exposure: 'direct' },
        source: 'fynvra',
      },
      {
        name: 'fs',
        config: { command: 'npx', args: ['-y', 'server-fs'], exposure: 'hidden' },
        source: 'fynvra',
      },
    ]);
  });

  it('loads codemode and tool_search only when an exposure needs them', () => {
    const plan = createRoleMcpExtensions([
      { name: 'big', url: 'https://example.com/mcp', exposure: 'deferred' },
      { name: 'scripted', command: 'srv', toolExposure: { 'get_*': 'codemode' } },
    ]);
    expect(plan.extensions.map((extension) => extensionName(extension))).toEqual([
      'fynvra-codemode',
      'fynvra-tool-search',
      'fynvra-mcp',
    ]);
  });

  it('skips invalid and duplicate server names with warnings', () => {
    const plan = createRoleMcpExtensions([
      { name: 'my docs', url: 'https://example.com/a' },
      { name: 'dev-radius', url: 'https://example.com/b' },
      { name: 'dev_radius', url: 'https://example.com/c' },
    ]);
    expect(plan.servers.map((server) => server.name)).toEqual(['dev-radius']);
    expect(plan.warnings).toHaveLength(2);
    expect(plan.warnings[0]).toContain('"my docs" skipped');
    expect(plan.warnings[1]).toContain('duplicate');
  });
});

function extensionName(extension: unknown): string | undefined {
  return typeof extension === 'object' && extension !== null && 'name' in extension
    ? String((extension as { name: unknown }).name)
    : undefined;
}
