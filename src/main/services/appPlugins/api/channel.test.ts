import { describe, expect, it, vi } from 'vitest';
import type { ChannelHost } from '../../channels/host';
import { createPluginConnection } from '../connection';
import { CHANNEL_API, MAX_PROMPT_BYTES } from './channel';
import { API_METHODS, type ApiDeps } from './index';

/** 每个方法一份合法入参 */
const VALID: Record<string, unknown> = {
  'channel.models': undefined,
  'channel.createSession': { workspaceId: 'ws1', profile: 'triage', title: 't' },
  'channel.setSessionModel': { sessionId: 's1', model: null },
  'channel.refreshCheckout': { workspaceId: 'ws1' },
  'channel.originCommit': { workspaceId: 'ws1' },
  'channel.prompt': { sessionId: 's1', text: 'hi' },
  'channel.sessionStatus': { sessionId: 's1' },
  'channel.snapshot': { workspaceId: 'ws1' },
  'channel.filterOutbound': { text: 'hi' },
  'channel.setPullRequestNote': { taskId: 't1', text: null },
};

function fakeHost(): ChannelHost {
  return {
    models: vi.fn(async () => ({ models: [] })),
    createSession: vi.fn(async () => ({ sessionId: 's1' })),
    setSessionModel: vi.fn(async () => undefined),
    refreshCheckout: vi.fn(async () => undefined),
    originCommit: vi.fn(async () => ({ commit: 'c' })),
    prompt: vi.fn(async () => ({ delivered: true })),
    sessionStatus: vi.fn(() => ({ status: 'idle' as const })),
    snapshot: vi.fn(async () => ({ runs: [], tasks: [] })),
    filterOutbound: vi.fn(async (text: string) => ({ ok: true as const, text })),
    setPullRequestNote: vi.fn(async () => undefined),
  } as unknown as ChannelHost;
}

/** 经 RPC 连接发一条 req，取回 res */
function connect(permissions: 'channel'[], host: ChannelHost | null = fakeHost()) {
  const replies: Record<string, unknown>[] = [];
  const deps = { channel: () => host ?? undefined } as unknown as ApiDeps;
  const connection = createPluginConnection({
    pluginId: 'p.a',
    dataDir: '/data',
    permissions,
    methods: API_METHODS,
    deps,
    post: (message) => replies.push(message as Record<string, unknown>),
  });
  let id = 0;
  return {
    host,
    async request(method: string, params: unknown) {
      id += 1;
      connection.receive({ type: 'req', id, method, params }, 10);
      await vi.waitFor(() => expect(replies.some((r) => r.id === id)).toBe(true));
      return replies.find((r) => r.id === id);
    },
  };
}

describe('channel API', () => {
  it('方法表与合法入参一一对应，全部要求 channel 权限', () => {
    expect(Object.keys(CHANNEL_API).sort()).toEqual(Object.keys(VALID).sort());
    for (const method of Object.values(CHANNEL_API)) expect(method.permission).toBe('channel');
  });

  it('没有 channel 权限时所有方法都被拒绝，不碰宿主', async () => {
    const rpc = connect([]);
    for (const [method, params] of Object.entries(VALID)) {
      expect(await rpc.request(method, params)).toEqual({
        type: 'res',
        id: expect.any(Number),
        ok: false,
        error: 'permission required: channel',
      });
    }
    for (const fn of Object.values(rpc.host as object)) expect(fn).not.toHaveBeenCalled();
  });

  it('有权限时带上调用方插件 id 转给宿主', async () => {
    const rpc = connect(['channel']);
    for (const [method, params] of Object.entries(VALID)) {
      expect(await rpc.request(method, params)).toMatchObject({ ok: true });
    }
    expect(rpc.host?.createSession).toHaveBeenCalledWith('p.a', {
      workspaceId: 'ws1',
      profile: 'triage',
      title: 't',
    });
    expect(rpc.host?.prompt).toHaveBeenCalledWith('p.a', 's1', 'hi', undefined);
    expect(rpc.host?.setPullRequestNote).toHaveBeenCalledWith('p.a', 't1', null);
    expect(rpc.host?.setSessionModel).toHaveBeenCalledWith('p.a', 's1', null);
  });

  it('createSession / setSessionModel 带合法 model 时原样转给宿主', async () => {
    const rpc = connect(['channel']);
    const model = { providerId: 'p1', modelId: 'm1' };
    const create = { workspaceId: 'ws1', profile: 'restricted', title: 't', model };
    expect(await rpc.request('channel.createSession', create)).toMatchObject({ ok: true });
    expect(rpc.host?.createSession).toHaveBeenCalledWith('p.a', create);
    expect(await rpc.request('channel.setSessionModel', { sessionId: 's1', model })).toMatchObject({
      ok: true,
    });
    expect(rpc.host?.setSessionModel).toHaveBeenCalledWith('p.a', 's1', model);
  });

  it('model 不合法、入参有多余键时拒绝', async () => {
    const rpc = connect(['channel']);
    const base = { workspaceId: 'ws1', profile: 'triage', title: 't' };
    const bad = [
      { providerId: '', modelId: 'm' },
      { providerId: 'p', modelId: 'x'.repeat(201) },
      { providerId: 'p' },
      { providerId: 'p', modelId: 'm', thinking: 'high' },
      'p/m',
      null,
    ];
    for (const model of bad) {
      expect(await rpc.request('channel.createSession', { ...base, model })).toMatchObject({
        ok: false,
        error: 'invalid params: channel.createSession',
      });
      if (model === null) continue;
      expect(
        await rpc.request('channel.setSessionModel', { sessionId: 's1', model })
      ).toMatchObject({ ok: false, error: 'invalid params: channel.setSessionModel' });
    }
    for (const params of [
      { sessionId: 's1' },
      { sessionId: 's1', model: null, extra: 1 },
      { sessionId: '', model: null },
    ]) {
      expect(await rpc.request('channel.setSessionModel', params)).toMatchObject({ ok: false });
    }
    expect(await rpc.request('channel.models', { x: 1 })).toMatchObject({ ok: false });
    expect(rpc.host?.createSession).not.toHaveBeenCalled();
    expect(rpc.host?.setSessionModel).not.toHaveBeenCalled();
    expect(rpc.host?.models).not.toHaveBeenCalled();
  });

  it('只能建 triage / restricted；入参多余键、超长 prompt 被拒', async () => {
    const rpc = connect(['channel']);
    for (const [method, params] of [
      ['channel.createSession', { workspaceId: 'ws1', profile: 'normal', title: 't' }],
      ['channel.createSession', { workspaceId: 'ws1', title: 't' }],
      ['channel.createSession', { workspaceId: 'ws1', profile: 'triage', title: 't', cwd: '/' }],
      ['channel.prompt', { sessionId: 's1', text: 'x'.repeat(MAX_PROMPT_BYTES + 1) }],
      ['channel.setPullRequestNote', { taskId: 't1' }],
    ] as const) {
      expect(await rpc.request(method, params)).toMatchObject({
        ok: false,
        error: `invalid params: ${method}`,
      });
    }
    expect(rpc.host?.createSession).not.toHaveBeenCalled();
    expect(rpc.host?.prompt).not.toHaveBeenCalled();
  });

  it('附件：带上插件数据目录转给宿主，name 去路径与控制字符，只发附件时正文可空', async () => {
    const rpc = connect(['channel']);
    const params = {
      sessionId: 's1',
      text: '',
      attachments: [{ file: 'a_1.pdf', name: 'C:\\Users\\x\\报\u0007告.pdf' }],
    };
    expect(await rpc.request('channel.prompt', params)).toMatchObject({ ok: true });
    expect(rpc.host?.prompt).toHaveBeenCalledWith('p.a', 's1', '', {
      dataDir: '/data',
      items: [{ file: 'a_1.pdf', name: '报告.pdf' }],
    });
  });

  it('附件：非法文件名、超长 name、超过 20 个、多余键整次拒绝', async () => {
    const rpc = connect(['channel']);
    const att = (file: string, name = 'n') => ({
      sessionId: 's1',
      text: 'hi',
      attachments: [{ file, name }],
    });
    for (const params of [
      att('../x'),
      att('a/b'),
      att('a\\b'),
      att('..'),
      att('a..b'),
      att(''),
      att('x'.repeat(129)),
      att('中.txt'),
      att('a.txt', 'n'.repeat(201)),
      { sessionId: 's1', text: 'hi', attachments: [{ file: 'a', name: 'a', path: '/' }] },
      { sessionId: 's1', text: 'hi', attachments: Array(21).fill({ file: 'a', name: 'a' }) },
      { sessionId: 's1', text: 'hi', attachments: 'a' },
      { sessionId: 's1', text: ' ', attachments: [] },
    ]) {
      expect(await rpc.request('channel.prompt', params)).toMatchObject({
        ok: false,
        error: 'invalid params: channel.prompt',
      });
    }
    expect(rpc.host?.prompt).not.toHaveBeenCalled();
  });

  it('渠道宿主未接线时返回错误', async () => {
    const rpc = connect(['channel'], null);
    expect(await rpc.request('channel.snapshot', { workspaceId: 'ws1' })).toMatchObject({
      ok: false,
      error: 'channel host is not available',
    });
  });
});
