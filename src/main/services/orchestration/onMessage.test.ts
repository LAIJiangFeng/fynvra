import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, Workspace } from '@fynvra/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrchestrationRegistry, type OrchestrationRegistryOptions } from './registry';
import { createFakeExec, createFakeLauncher, createFakeRoles } from './testing';

// Task 24：桌面通知经 registry.onMessage 拿到收件箱新投递的消息（worker_done / question / escalation …）

let dir: string;
let WS1: Workspace;

function make(overrides: Partial<OrchestrationRegistryOptions> = {}) {
  return createOrchestrationRegistry({
    userDataPath: join(dir, 'userData'),
    listWorkspaces: () => [WS1],
    roles: createFakeRoles(),
    notifyChanged: vi.fn(),
    launcher: createFakeLauncher(),
    exec: createFakeExec().exec,
    runChecks: async () => ({ exitCode: 0, output: '', durationMs: 1 }),
    log: () => {},
    ...overrides,
  });
}

/** 主 agent 派一个任务，返回 worker 会话 id（fake launcher 给的是 session_w1） */
async function dispatch(registry: ReturnType<typeof make>): Promise<string> {
  const host = registry.hostFor('session_coord', 'ws_1');
  const result = await host?.dispatchTask({
    title: 'Add toggle',
    spec: 'S',
    roleId: 'worker',
    dependsOn: [],
  });
  if (!result?.ok) throw new Error(result?.error ?? 'no host');
  if (!result.dispatch) throw new Error('the task was queued instead of dispatched');
  return result.dispatch.workerSessionId;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fynvra-orchestration-messages-'));
  WS1 = {
    id: 'ws_1',
    name: 'one',
    repoPath: join(dir, 'repos', 'one'),
    defaultBranch: 'main',
    vcs: 'git',
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('registry.onMessage', () => {
  it('hears every message posted to an inbox, with its workspace, including services opened later', async () => {
    const registry = make();
    const heard: [string, Message][] = [];
    registry.onMessage((workspaceId, message) => heard.push([workspaceId, message]));

    const worker = await dispatch(registry);
    const workerHost = registry.workerHostFor(worker);
    expect(await workerHost?.askCoordinator('Which table?', 10)).toEqual({
      ok: true,
      answer: null,
    });
    expect(await workerHost?.reportDone('succeeded', 'Added the toggle', ['a.ts'])).toEqual({
      ok: true,
    });

    expect(heard.map(([workspaceId, message]) => [workspaceId, message.type])).toEqual([
      ['ws_1', 'question'],
      ['ws_1', 'worker_done'],
    ]);
    expect(heard[1]?.[1]).toMatchObject({
      from: worker,
      to: 'session_coord',
      subject: 'succeeded',
      body: expect.stringContaining('Added the toggle'),
    });
  });

  it('stops after unsubscribing; a throwing listener is logged and the post still succeeds', async () => {
    const logs: string[] = [];
    const registry = make({ log: (message) => logs.push(message) });
    const kept: string[] = [];
    registry.onMessage(() => {
      throw new Error('boom');
    });
    registry.onMessage((_workspaceId, message) => kept.push(message.type));
    const dropped = vi.fn();
    registry.onMessage(dropped)();

    const worker = await dispatch(registry);
    expect(await registry.workerHostFor(worker)?.reportDone('failed', 'Gave up')).toEqual({
      ok: true,
    });

    expect(kept).toEqual(['worker_done']);
    expect(dropped).not.toHaveBeenCalled();
    expect(logs.filter((message) => message.includes('boom'))).toHaveLength(1);
  });

  it('does not replay messages restored from the snapshot', async () => {
    const before = make();
    const worker = await dispatch(before);
    await before.workerHostFor(worker)?.reportDone('succeeded', 'Done');
    await before.flushAll();

    const after = make();
    const heard = vi.fn();
    after.onMessage(heard);
    await after.openAll();
    expect((await after.serviceFor('ws_1')?.snapshot())?.messages).toHaveLength(1);
    expect(heard).not.toHaveBeenCalled();
  });
});
