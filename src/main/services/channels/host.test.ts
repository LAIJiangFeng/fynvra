import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Workspace } from '@shared/types/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionObserver } from '../agentHost/agentHost';
import { createPluginSecretStore } from '../appPlugins/secrets';
import { collectKnownSecrets } from '../secrets';
import type { CleanCheckout } from './cleanCheckout';
import { type ChannelHostDeps, createChannelHost } from './host';
import { routeChannelReport } from './instance';
import { createChannelStore } from './store';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fynvra-channels-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const WS_GIT: Workspace = {
  id: 'ws1',
  name: 'Repo',
  repoPath: 'C:/Users/alice/repo',
  vcs: 'git',
  defaultBranch: 'main',
} as Workspace;
const WS_DIR: Workspace = { id: 'ws2', name: 'Dir', repoPath: 'C:/dir', vcs: 'none' } as Workspace;

type FakeSession = { id: string; status: string; archivedAt?: number };

function harness(patch: Partial<ChannelHostDeps> = {}) {
  const sessions = new Map<string, FakeSession>();
  let nextId = 1;
  const observers: SessionObserver[] = [];
  const created: unknown[] = [];
  const emitted: [string, string, unknown][] = [];
  const agentHost = {
    createProfileSession: vi.fn(async (input: unknown) => {
      created.push(input);
      const id = `s${nextId++}`;
      sessions.set(id, { id, status: 'idle' });
      return { ok: true as const, session: { id } };
    }),
    promptWhenIdle: vi.fn(async () => ({ ok: true as const, delivered: true })),
    get: (id: string) => sessions.get(id),
    observe: (observer: SessionObserver) => {
      observers.push(observer);
      return () => undefined;
    },
  };
  const cleanCheckout: CleanCheckout = {
    pathOf: async () => 'C:/wt/ws1/telegram-clean',
    originCommit: vi.fn(async () => ({ ok: true as const, commit: 'a'.repeat(40) })),
    ensure: vi.fn(async () => ({ ok: true as const, path: 'C:/wt/ws1/telegram-clean' })),
    refresh: vi.fn(async () => ({ ok: true as const })),
  };
  const snapshot = { runs: [] as unknown[], tasks: [] as unknown[] };
  const filePath = join(dir, 'fynvra-plugin-sessions.json');
  const deps: ChannelHostDeps = {
    store: createChannelStore({ filePath }),
    agentHost: agentHost as never,
    workspaces: { get: (id) => [WS_GIT, WS_DIR].find((w) => w.id === id) },
    snapshot: async () => snapshot as never,
    cleanCheckout,
    knownSecrets: async () => [],
    localInfo: async () => ({ paths: ['C:/Users/alice'], userName: 'alice', hostName: 'box' }),
    call: vi.fn(async () => ({ ok: true })),
    emit: (pluginId, event, payload) => emitted.push([pluginId, event, payload]),
    ...patch,
  };
  const host = createChannelHost(deps);
  const setSession = (id: string, change: Partial<FakeSession>) =>
    Object.assign(sessions.get(id) ?? {}, change);
  return {
    host,
    deps,
    setSession,
    sessions,
    observers,
    created,
    emitted,
    agentHost,
    cleanCheckout,
    snapshot,
    filePath,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createSession', () => {
  it('cwd 是干净检出，档位与标题原样交给 createProfileSession，归属落盘且重启后仍在', async () => {
    const h = harness();
    await h.host.start();
    const { sessionId } = await h.host.createSession('p.a', {
      workspaceId: 'ws1',
      profile: 'triage',
      title: '分诊',
    });
    expect(h.cleanCheckout.ensure).toHaveBeenCalledWith(WS_GIT);
    expect(h.created).toEqual([
      { workspaceId: 'ws1', profile: 'triage', cwd: 'C:/wt/ws1/telegram-clean', title: '分诊' },
    ]);
    expect(JSON.parse(await readFile(h.filePath, 'utf8'))).toEqual({
      version: 1,
      sessions: [{ sessionId, pluginId: 'p.a', workspaceId: 'ws1' }],
      notes: [],
    });
    // 「重启」：新的 store 读同一个文件
    const again = createChannelHost({
      ...h.deps,
      store: createChannelStore({ filePath: h.filePath }),
    });
    await again.start();
    expect(again.sessionStatus('p.a', sessionId)).toEqual({ status: 'idle' });
  });

  it('非 git 工作区与不存在的工作区被拒，不建会话', async () => {
    const h = harness();
    await h.host.start();
    await expect(
      h.host.createSession('p.a', { workspaceId: 'ws2', profile: 'restricted', title: 't' })
    ).rejects.toThrow('not a git repository');
    await expect(
      h.host.createSession('p.a', { workspaceId: 'nope', profile: 'restricted', title: 't' })
    ).rejects.toThrow('workspace not found');
    expect(h.agentHost.createProfileSession).not.toHaveBeenCalled();
  });

  it('干净检出失败时错误里的本机路径被替换', async () => {
    const h = harness();
    vi.mocked(h.cleanCheckout.ensure).mockResolvedValueOnce({
      ok: false,
      error: 'fatal: C:/Users/alice/repo is locked',
    });
    await h.host.start();
    const error = await h.host
      .createSession('p.a', { workspaceId: 'ws1', profile: 'triage', title: 't' })
      .catch((e: Error) => e.message);
    expect(error).not.toContain('alice');
  });
});

describe('会话归属', () => {
  it('prompt / sessionStatus 不能操作其他插件或用户的会话', async () => {
    const h = harness();
    await h.host.start();
    const { sessionId } = await h.host.createSession('p.a', {
      workspaceId: 'ws1',
      profile: 'triage',
      title: 't',
    });
    h.sessions.set('user', { id: 'user', status: 'idle' });
    for (const [plugin, id] of [
      ['p.b', sessionId],
      ['p.a', 'user'],
    ] as const) {
      await expect(h.host.prompt(plugin, id, 'hi')).rejects.toThrow('session not found');
      expect(() => h.host.sessionStatus(plugin, id)).toThrow('session not found');
    }
    expect(h.agentHost.promptWhenIdle).not.toHaveBeenCalled();
    expect(await h.host.prompt('p.a', sessionId, 'hi')).toEqual({ delivered: true });
    expect(h.agentHost.promptWhenIdle).toHaveBeenCalledWith(sessionId, 'hi');
    h.setSession(sessionId, { archivedAt: 1 });
    expect(h.host.sessionStatus('p.a', sessionId)).toEqual({ status: 'archived' });
    h.sessions.delete(sessionId);
    expect(h.host.sessionStatus('p.a', sessionId)).toEqual({ status: 'missing' });
  });

  it('refreshCheckout / originCommit 要求工作区里有本插件的会话；有会话在跑时不刷新', async () => {
    const h = harness();
    await h.host.start();
    await expect(h.host.originCommit('p.a', 'ws1')).rejects.toThrow('no session of this plugin');
    await expect(h.host.refreshCheckout('p.a', 'ws1')).rejects.toThrow('no session of this plugin');
    const { sessionId } = await h.host.createSession('p.a', {
      workspaceId: 'ws1',
      profile: 'restricted',
      title: 't',
    });
    await expect(h.host.refreshCheckout('p.b', 'ws1')).rejects.toThrow();
    expect(await h.host.originCommit('p.a', 'ws1')).toEqual({ commit: 'a'.repeat(40) });
    await h.host.refreshCheckout('p.a', 'ws1');
    expect(h.cleanCheckout.refresh).toHaveBeenCalledTimes(1);
    h.setSession(sessionId, { status: 'running' });
    await expect(h.host.refreshCheckout('p.a', 'ws1')).rejects.toThrow('running');
    expect(h.cleanCheckout.refresh).toHaveBeenCalledTimes(1);
  });

  it('删除插件清掉归属与 note，会话本身保留', async () => {
    const h = harness();
    await h.host.start();
    const { sessionId } = await h.host.createSession('p.a', {
      workspaceId: 'ws1',
      profile: 'triage',
      title: 't',
    });
    await h.host.removePlugin('p.a');
    expect(() => h.host.sessionStatus('p.a', sessionId)).toThrow();
    expect(h.sessions.has(sessionId)).toBe(true);
  });
});

/** 两个插件各一个协调者会话，另有用户自己的 run */
async function withRuns() {
  const h = harness();
  await h.host.start();
  const a = await h.host.createSession('p.a', {
    workspaceId: 'ws1',
    profile: 'restricted',
    title: 'a',
  });
  const b = await h.host.createSession('p.b', {
    workspaceId: 'ws1',
    profile: 'restricted',
    title: 'b',
  });
  h.snapshot.runs.push(
    { id: 'rA', coordinatorSessionId: a.sessionId, objective: 'x', workspaceId: 'ws1' },
    { id: 'rB', coordinatorSessionId: b.sessionId, objective: 'x', workspaceId: 'ws1' },
    { id: 'rU', coordinatorSessionId: 'user', objective: 'x', workspaceId: 'ws1' }
  );
  h.snapshot.tasks.push(
    {
      id: 'tA',
      runId: 'rA',
      title: 'A',
      status: 'in-review',
      spec: 'secret spec',
      pullRequest: { url: 'https://x/pr/1', branch: 'b', base: 'main', headCommit: 'h' },
    },
    { id: 'tB', runId: 'rB', title: 'B', status: 'todo', spec: '' },
    { id: 'tU', runId: 'rU', title: 'U', status: 'todo', spec: '' }
  );
  return { h, a: a.sessionId, b: b.sessionId };
}

describe('snapshot', () => {
  it('只返回本插件的 run 与 task，字段裁剪', async () => {
    const { h, a } = await withRuns();
    expect(await h.host.snapshot('p.a', 'ws1')).toEqual({
      runs: [{ id: 'rA', coordinatorSessionId: a }],
      tasks: [
        {
          id: 'tA',
          runId: 'rA',
          title: 'A',
          status: 'in-review',
          pullRequest: { url: 'https://x/pr/1' },
        },
      ],
    });
    expect(await h.host.snapshot('p.c', 'ws1')).toEqual({ runs: [], tasks: [] });
  });
});

describe('filterOutbound', () => {
  it('替换本机路径、用户名；命中插件自己登记的密钥时拒绝', async () => {
    const secrets = createPluginSecretStore({ filePath: join(dir, 'secrets.json') });
    await secrets.set('p.a', 'token', 'plain-plugin-value-42');
    const h = harness({ knownSecrets: () => collectKnownSecrets({}) });
    const ok = await h.host.filterOutbound('see C:/Users/alice/repo/a.ts');
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.text).not.toContain('alice');
    expect(await h.host.filterOutbound('token plain-plugin-value-42')).toEqual({
      ok: false,
      reason: 'secret',
    });
    await secrets.removePlugin('p.a');
  });
});

describe('setPullRequestNote', () => {
  it('拒绝非本插件的任务；带密钥的 note 被拒；过滤后保存，null 清除', async () => {
    const { h } = await withRuns();
    await expect(h.host.setPullRequestNote('p.a', 'tB', 'x')).rejects.toThrow('task not found');
    await expect(h.host.setPullRequestNote('p.a', 'tU', 'x')).rejects.toThrow('task not found');
    await expect(
      h.host.setPullRequestNote(
        'p.a',
        'tA',
        'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
      )
    ).rejects.toThrow('secret');
    expect(h.host.pullRequestNote('tA')).toBeUndefined();
    await h.host.setPullRequestNote('p.a', 'tA', '## 来源\n\nC:/Users/alice/x');
    expect(h.host.pullRequestNote('tA')).toMatch(/^## 来源/);
    expect(h.host.pullRequestNote('tA')).not.toContain('alice');
    await h.host.setPullRequestNote('p.a', 'tA', null);
    expect(h.host.pullRequestNote('tA')).toBeUndefined();
  });
});

describe('channel.report 路由', () => {
  it('插件会话路由到该插件；无归属时回退内置 Telegram', async () => {
    const { h, a } = await withRuns();
    const fallback = { invoke: vi.fn(async () => ({ ok: true as const, via: 'telegram' })) };
    const router = routeChannelReport(() => h.host, fallback);
    const signal = new AbortController().signal;
    expect(await router.invoke(a, 'triageReport', { k: 1 }, signal)).toEqual({ ok: true });
    expect(h.deps.call).toHaveBeenCalledWith('p.a', 'channel.report', {
      sessionId: a,
      method: 'triageReport',
      input: { k: 1 },
    });
    expect(await router.invoke('legacy', 'triageReport', {}, signal)).toEqual({
      ok: true,
      via: 'telegram',
    });
    expect(fallback.invoke).toHaveBeenCalledTimes(1);
    // 渠道宿主还没接线时也回退
    await routeChannelReport(() => undefined, fallback).invoke(a, 'm', {}, signal);
    expect(fallback.invoke).toHaveBeenCalledTimes(2);
  });

  it('插件超时、抛错或返回非法值时返回错误', async () => {
    const call = vi.fn<ChannelHostDeps['call']>(() => new Promise(() => undefined));
    const h = harness({ call, reportTimeoutMs: 20 });
    await h.host.start();
    const { sessionId } = await h.host.createSession('p.a', {
      workspaceId: 'ws1',
      profile: 'triage',
      title: 't',
    });
    const signal = new AbortController().signal;
    expect(await h.host.report(sessionId, 'm', {}, signal)).toEqual({
      ok: false,
      error: 'channel.report timed out',
    });
    call.mockRejectedValueOnce(new Error('boom'));
    expect(await h.host.report(sessionId, 'm', {}, signal)).toEqual({ ok: false, error: 'boom' });
    call.mockResolvedValueOnce('weird');
    expect(await h.host.report(sessionId, 'm', {}, signal)).toMatchObject({ ok: false });
    expect(h.host.report('other', 'm', {}, signal)).toBeUndefined();
  });
});

describe('事件', () => {
  it('channel.session 只推给拥有该会话的插件，状态不变不重复推', async () => {
    const h = harness();
    await h.host.start();
    const { sessionId } = await h.host.createSession('p.a', {
      workspaceId: 'ws1',
      profile: 'triage',
      title: 't',
    });
    h.sessions.set('user', { id: 'user', status: 'idle' });
    h.setSession(sessionId, { status: 'running' });
    h.setSession('user', { status: 'running' });
    for (const observer of h.observers) {
      observer.activity?.(sessionId, 'prompt');
      observer.activity?.('user', 'prompt');
      observer.event?.({ sessionId, event: {} as never });
    }
    await flush();
    expect(h.emitted).toEqual([['p.a', 'channel.session', { sessionId, status: 'running' }]]);
  });

  it('channel.orchestrationChanged 只推给在该工作区有 run 的插件', async () => {
    const { h } = await withRuns();
    await h.host.createSession('p.c', { workspaceId: 'ws1', profile: 'triage', title: 'c' });
    h.host.orchestrationChanged('ws1');
    h.host.orchestrationChanged('ws2');
    await flush();
    expect(h.emitted.filter(([, event]) => event === 'channel.orchestrationChanged')).toEqual([
      ['p.a', 'channel.orchestrationChanged', { workspaceId: 'ws1' }],
      ['p.b', 'channel.orchestrationChanged', { workspaceId: 'ws1' }],
    ]);
  });
});
