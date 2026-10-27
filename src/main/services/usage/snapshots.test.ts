import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOrchestrationRegistry } from '../orchestration/registry';
import { createFakeRoles } from '../orchestration/testing';

const snapshot = { version: 1, runs: [], tasks: [], dispatches: [], worktrees: [], messages: [] };
function setup() {
  const fs = {
    readFile: vi.fn(async () => JSON.stringify(snapshot)),
    writeFile: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    unlink: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    readdir: vi.fn(async () => []),
  };
  const registry = createOrchestrationRegistry({
    userDataPath: '/data',
    listWorkspaces: () => [{ id: 'ws', name: 'Workspace', repoPath: '/repo', vcs: 'git' }],
    roles: createFakeRoles(),
    notifyChanged: vi.fn(),
    fs,
  });
  return { registry, fs };
}

describe('read-only usage snapshots', () => {
  it('reads persisted snapshots without opening services or modifying any files', async () => {
    const { registry, fs } = setup();
    expect(await registry.readSnapshot('ws')).toEqual({
      runs: [],
      tasks: [],
      dispatches: [],
      worktrees: [],
      messages: [],
    });
    expect(fs.readFile).toHaveBeenCalledExactlyOnceWith(
      join('/data', 'orchestration', 'ws.json'),
      'utf8'
    );
    // A second read sees persistence again; no service was opened and cached.
    await registry.readSnapshot('ws');
    expect(fs.readFile).toHaveBeenCalledTimes(2);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('skips missing, invalid and inaccessible snapshots without repair or rename', async () => {
    const { registry, fs } = setup();
    expect(await registry.readSnapshot('../outside')).toBeUndefined();
    expect(fs.readFile).not.toHaveBeenCalled();
    fs.readFile
      .mockResolvedValueOnce('{broken')
      .mockResolvedValueOnce('{"version":999}')
      .mockRejectedValueOnce(new Error('unreadable'));
    for (let index = 0; index < 3; index += 1)
      expect(await registry.readSnapshot('ws')).toBeUndefined();
    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('prefers the current snapshot of an already opened service', async () => {
    const { registry, fs } = setup();
    const service = registry.serviceFor('ws');
    await service?.ready;
    const view = { runs: [], tasks: [], dispatches: [], worktrees: [], messages: [] };
    const current = vi
      .spyOn(service as NonNullable<typeof service>, 'snapshot')
      .mockResolvedValue(view);
    fs.readFile.mockClear();
    expect(await registry.readSnapshot('ws')).toBe(view);
    expect(current).toHaveBeenCalledOnce();
    expect(fs.readFile).not.toHaveBeenCalled();
  });
});
