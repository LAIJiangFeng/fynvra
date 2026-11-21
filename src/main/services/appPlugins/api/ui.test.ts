import { describe, expect, it, vi } from 'vitest';
import { createPluginConnection } from '../connection';
import { createFakeFork } from '../testing';
import { API_METHODS, type ApiDeps } from './index';
import { clearUiOnExit, createPluginUiStore } from './ui';

const ID = 'fynvra.demo';
const schema = { children: [{ type: 'text', text: 'hi' }] };

/** 走真实的 RPC 检查链（白名单 → 权限 → 收窄 → 执行），返回插件收到的 res */
async function render(permissions: ('ui' | 'network')[], params: unknown) {
  const onChanged = vi.fn();
  const uiStore = createPluginUiStore(onChanged);
  const posted: Record<string, unknown>[] = [];
  const connection = createPluginConnection({
    pluginId: ID,
    dataDir: '/data',
    permissions,
    methods: API_METHODS,
    deps: { uiStore } as unknown as ApiDeps,
    post: (message) => posted.push(message as Record<string, unknown>),
  });
  connection.receive({ type: 'req', id: 1, method: 'ui.render', params }, 10);
  await vi.waitFor(() => expect(posted).toHaveLength(1));
  return { res: posted[0], uiStore, onChanged };
}

describe('ui.render', () => {
  it('有 ui 权限：保存描述并通知变化', async () => {
    const { res, uiStore, onChanged } = await render(['ui'], { schema });
    expect(res).toMatchObject({ type: 'res', ok: true });
    expect(uiStore.get(ID)).toEqual(schema);
    expect(onChanged).toHaveBeenCalledWith(ID);
  });

  it('没有 ui 权限被拒', async () => {
    const { res, uiStore } = await render(['network'], { schema });
    expect(res).toMatchObject({ ok: false, error: 'permission required: ui' });
    expect(uiStore.get(ID)).toBeNull();
  });

  it('描述非法被拒，也不覆盖旧描述', async () => {
    const { res, uiStore } = await render(['ui'], {
      schema: { children: [{ type: 'script', src: 'x' }] },
    });
    expect(res).toMatchObject({ ok: false, error: 'invalid params: ui.render' });
    expect(uiStore.get(ID)).toBeNull();
    const extra = await render(['ui'], { schema, extra: 1 });
    expect(extra.res).toMatchObject({ ok: false });
  });
});

describe('clearUiOnExit', () => {
  it('进程退出后清掉描述；旧进程晚退出不清新进程的描述', async () => {
    const onChanged = vi.fn();
    const store = createPluginUiStore(onChanged);
    const { fork, processes } = createFakeFork();
    const wrapped = clearUiOnExit(fork, store);
    const options = { pluginId: ID, cwd: '/data', env: {} };

    await wrapped(options);
    store.set(ID, { children: [] });
    processes[0]?.exit(0);
    expect(store.get(ID)).toBeNull();

    await wrapped(options);
    store.set(ID, { children: [] });
    await wrapped(options); // 重启：新进程启动时清掉旧描述
    expect(store.get(ID)).toBeNull();
    store.set(ID, { children: [] });
    processes[1]?.exit(0); // 旧进程晚退出
    expect(store.get(ID)).not.toBeNull();
    processes[2]?.exit(0);
    expect(store.get(ID)).toBeNull();
  });
});
