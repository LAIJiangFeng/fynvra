import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Role } from '@fynvra/core';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData, on: () => {} },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: mocks.send } },
    ],
  },
}));

const invoke = (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)?.({ sender: {} }, ...args);

const tester: Role = {
  id: 'tester',
  name: '测试工程师',
  description: '写测试、跑测试',
  systemPrompt: '你只负责测试。\n先写失败的测试。',
  model: { providerId: 'anthropic', modelId: 'claude-sonnet-5-5', thinking: 'medium' },
  skillIds: ['pdf'],
  mcpServerIds: [],
  tools: 'all',
  approvalMode: 'auto-edits',
};

const rolePath = (id: string) => join(mocks.userData, 'roles', `${id}.json`);

beforeAll(async () => {
  mocks.userData = mkdtempSync(join(tmpdir(), 'fynvra-ipc-roles-'));
  const { registerRoleHandlers } = await import('./roles');
  registerRoleHandlers();
});

afterAll(() => {
  rmSync(mocks.userData, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.send.mockClear();
});

describe('roles IPC', () => {
  it('list：内置 orchestrator / worker 在前且标记 builtin', async () => {
    const result = await invoke(IPC_CHANNELS.ROLES_LIST);
    expect(result).toMatchObject({
      ok: true,
      roles: [
        { id: 'orchestrator', builtin: true },
        { id: 'worker', builtin: true },
      ],
    });
  });

  it('save 校验入参，内置 id 拒绝，都不广播', async () => {
    for (const raw of [null, { ...tester, tools: 'root' }, { ...tester, id: '../evil' }]) {
      expect(await invoke(IPC_CHANNELS.ROLES_SAVE, raw)).toMatchObject({ ok: false });
    }
    expect(await invoke(IPC_CHANNELS.ROLES_SAVE, { ...tester, id: 'worker' })).toMatchObject({
      ok: false,
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(existsSync(join(mocks.userData, 'roles'))).toBe(false);
  });

  it('save 写 userData/roles/<id>.json（系统提示词在角色文件里）并广播', async () => {
    expect(await invoke(IPC_CHANNELS.ROLES_SAVE, tester)).toEqual({ ok: true, role: tester });
    expect(JSON.parse(readFileSync(rolePath('tester'), 'utf8'))).toEqual(tester);
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.ROLES_CHANGED);

    const edited = { ...tester, name: '高级测试工程师', builtin: true };
    expect(await invoke(IPC_CHANNELS.ROLES_SAVE, edited)).toMatchObject({
      ok: true,
      role: { name: '高级测试工程师' },
    });
    expect(JSON.parse(readFileSync(rolePath('tester'), 'utf8'))).not.toHaveProperty('builtin');
  });

  it('get：按 id 取，非法 id 与不存在的角色返回错误', async () => {
    expect(await invoke(IPC_CHANNELS.ROLES_GET, 'tester')).toMatchObject({
      ok: true,
      role: { id: 'tester', name: '高级测试工程师' },
    });
    expect(await invoke(IPC_CHANNELS.ROLES_GET, 'orchestrator')).toMatchObject({
      ok: true,
      role: { builtin: true },
    });
    expect(await invoke(IPC_CHANNELS.ROLES_GET, 'ghost')).toMatchObject({ ok: false });
    expect(await invoke(IPC_CHANNELS.ROLES_GET, { id: 'tester' })).toMatchObject({ ok: false });
  });

  it('remove：内置角色不可删；自定义角色删文件并广播', async () => {
    expect(await invoke(IPC_CHANNELS.ROLES_REMOVE, 'orchestrator')).toEqual({
      ok: false,
      error: '内置角色不可删除',
    });
    expect(await invoke(IPC_CHANNELS.ROLES_REMOVE, 'tester')).toEqual({ ok: true });
    expect(existsSync(rolePath('tester'))).toBe(false);
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.ROLES_CHANGED);
    expect(await invoke(IPC_CHANNELS.ROLES_REMOVE, 'tester')).toMatchObject({ ok: false });
  });
});
