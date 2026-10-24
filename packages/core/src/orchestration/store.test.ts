import * as nodeFs from 'node:fs/promises';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreFs } from '../fs';
import type { Dispatch, Message, Run, Task, Worktree } from '../types';
import {
  InMemoryOrchestrationStore,
  ORCHESTRATION_SNAPSHOT_VERSION,
  type OrchestrationSnapshot,
  parseOrchestrationSnapshot,
} from './store';

const run: Run = {
  id: 'run_1',
  workspaceId: 'ws_1',
  coordinatorSessionId: 'session_c',
  objective: 'Ship the parser',
  createdAt: 1,
};
const otherRun: Run = { ...run, id: 'run_2', objective: 'Other' };
const task: Task = {
  id: 'task_1',
  runId: 'run_1',
  title: 'Parser',
  spec: '...',
  roleId: 'worker',
  status: 'todo',
  dependsOn: [],
};
const worktree: Worktree = {
  id: 'wt_1',
  workspaceId: 'ws_1',
  path: '/wt/ws_1/parser',
  branch: 'fynvra/parser',
  baseRef: 'main',
  baseCommit: 'abc123',
};
const dispatch: Dispatch = {
  id: 'dispatch_1',
  taskId: 'task_1',
  workerSessionId: 'session_w',
  worktreeId: 'wt_1',
  branch: 'fynvra/parser',
  startedAt: 10,
};
const message: Message = {
  id: 'msg_1',
  runId: 'run_1',
  dispatchId: 'dispatch_1',
  from: 'session_w',
  to: 'session_c',
  type: 'worker_done',
  body: 'Done.',
  createdAt: 20,
};
const settled = { settledAt: 30, outcome: 'succeeded', summary: 'Done.' } as const;

function seeded(): InMemoryOrchestrationStore {
  const store = new InMemoryOrchestrationStore();
  for (const result of [
    store.runs.insert(run),
    store.runs.insert(otherRun),
    store.tasks.insert(task),
    store.worktrees.insert(worktree),
    store.dispatches.insert(dispatch),
    store.messages.insert(message),
  ]) {
    if (!result.ok) throw new Error(result.error);
  }
  return store;
}

describe('EntityTable', () => {
  it('insert 后 get 读回；重复 id 返回错误', () => {
    const store = new InMemoryOrchestrationStore();
    expect(store.runs.insert(run)).toEqual({ ok: true, value: run });
    expect(store.runs.get('run_1')).toEqual(run);
    expect(store.runs.get('missing')).toBeUndefined();
    const duplicate = store.runs.insert(run);
    expect(!duplicate.ok && duplicate.error).toMatch(/already exists/);
  });

  it('insert 拒绝空 id', () => {
    const result = new InMemoryOrchestrationStore().runs.insert({ ...run, id: '' });
    expect(!result.ok && result.error).toMatch(/id/);
  });

  it('update 合并字段、id 不可改、值为 undefined 的字段被删除；不存在返回错误', () => {
    const store = seeded();
    const patch = { objective: 'Ship it', id: 'hijack' } as Partial<Run>;
    expect(store.runs.update('run_1', patch)).toEqual({
      ok: true,
      value: { ...run, objective: 'Ship it' },
    });
    expect(store.runs.get('hijack')).toBeUndefined();

    store.messages.update('msg_1', { subject: 'Report' });
    const cleared = store.messages.update('msg_1', { subject: undefined });
    expect(cleared.ok && 'subject' in cleared.value).toBe(false);

    const missing = store.runs.update('nope', { objective: 'x' });
    expect(!missing.ok && missing.error).toMatch(/not found/);
  });

  it('delete 返回是否存在；list 按插入顺序并支持过滤', () => {
    const store = seeded();
    expect(store.runs.list().map((entity) => entity.id)).toEqual(['run_1', 'run_2']);
    expect(store.runs.list((entity) => entity.objective === 'Other')).toEqual([otherRun]);
    expect(store.runs.delete('run_1')).toBe(true);
    expect(store.runs.delete('run_1')).toBe(false);
    expect(store.runs.list()).toEqual([otherRun]);
  });

  it('读写都按值拷贝：修改入参、返回值或过滤回调里的对象都不影响存储', () => {
    const store = new InMemoryOrchestrationStore();
    const input = structuredClone(task);
    store.tasks.insert(input);
    input.dependsOn.push('mutated-input');
    store.tasks.get('task_1')?.dependsOn.push('mutated-get');
    store.tasks.list()[0]?.dependsOn.push('mutated-list');
    store.tasks.list((entity) => {
      entity.title = 'mutated-filter';
      return true;
    });
    expect(store.tasks.get('task_1')).toEqual(task);
  });
});

describe('invariants', () => {
  it('tasks.update 改 status 必须符合迁移表', () => {
    const store = seeded();
    const illegal = store.tasks.update('task_1', { status: 'completed' });
    expect(!illegal.ok && illegal.error).toContain('todo → completed');
    expect(store.tasks.get('task_1')?.status).toBe('todo');
    expect(store.tasks.update('task_1', { status: 'in-progress' }).ok).toBe(true);
    expect(store.tasks.update('task_1', { title: 'Renamed' }).ok).toBe(true);
  });

  it('tasks.insert 拒绝未知状态；messages.insert 拒绝未知类型', () => {
    const store = seeded();
    const badTask = store.tasks.insert({ ...task, id: 'task_2', status: 'done' as Task['status'] });
    expect(!badTask.ok && badTask.error).toMatch(/status/);
    const badMessage = store.messages.insert({
      ...message,
      id: 'msg_2',
      type: 'ping' as Message['type'],
    });
    expect(!badMessage.ok && badMessage.error).toMatch(/type/);
  });

  it('同一任务同时只能有一个未结算的 dispatch', () => {
    const store = seeded();
    const second = store.dispatches.insert({ ...dispatch, id: 'dispatch_2' });
    expect(!second.ok && second.error).toMatch(/active dispatch/);
    expect(store.dispatches.update('dispatch_1', settled).ok).toBe(true);
    expect(store.dispatches.insert({ ...dispatch, id: 'dispatch_2' }).ok).toBe(true);
  });

  it('已结算的 dispatch 不可再修改；settledAt 与 outcome 必须同时出现', () => {
    const store = seeded();
    const half = store.dispatches.update('dispatch_1', { settledAt: 30 });
    expect(!half.ok && half.error).toMatch(/together/);
    expect(store.dispatches.update('dispatch_1', settled).ok).toBe(true);
    const again = store.dispatches.update('dispatch_1', { summary: 'rewritten' });
    expect(!again.ok && again.error).toMatch(/already settled/);
  });
});

describe('queries', () => {
  it('listTasks(runId) 只返回该 run 的任务', () => {
    const store = seeded();
    store.tasks.insert({ ...task, id: 'task_2', title: 'Docs' });
    store.tasks.insert({ ...task, id: 'task_9', runId: 'run_2' });
    expect(store.listTasks('run_1').map((entity) => entity.id)).toEqual(['task_1', 'task_2']);
    expect(store.listTasks('run_404')).toEqual([]);
  });

  it('activeDispatch(taskId) 返回未结算的那次尝试', () => {
    const store = seeded();
    expect(store.activeDispatch('task_1')).toEqual(dispatch);
    store.dispatches.update('dispatch_1', settled);
    expect(store.activeDispatch('task_1')).toBeUndefined();
    store.dispatches.insert({ ...dispatch, id: 'dispatch_2', startedAt: 40 });
    expect(store.activeDispatch('task_1')?.id).toBe('dispatch_2');
  });

  it('reclaimableDispatches(runId)：已结算、worktree 仍登记且没有进行中的后续尝试', () => {
    const store = seeded();
    // 进行中 → 不可回收
    expect(store.reclaimableDispatches('run_1')).toEqual([]);
    // 已结算 + worktree 还在 → 可回收
    store.dispatches.update('dispatch_1', settled);
    expect(store.reclaimableDispatches('run_1').map((entity) => entity.id)).toEqual(['dispatch_1']);
    // 打回后在同一 worktree 上的后续尝试进行中 → worktree 仍在用
    store.dispatches.insert({ ...dispatch, id: 'dispatch_2', startedAt: 40 });
    expect(store.reclaimableDispatches('run_1')).toEqual([]);
    // 后续尝试也结算 → 只报最近一次
    store.dispatches.update('dispatch_2', { ...settled, settledAt: 50 });
    expect(store.reclaimableDispatches('run_1').map((entity) => entity.id)).toEqual(['dispatch_2']);
    // 别的 run 看不到
    expect(store.reclaimableDispatches('run_2')).toEqual([]);
    // worktree 清理（注销）后 → 不再可回收
    store.worktrees.delete('wt_1');
    expect(store.reclaimableDispatches('run_1')).toEqual([]);
  });
});

describe('persistence', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fynvra-orch-'));
    path = join(dir, 'nested', 'orchestration.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persistTo → loadFrom 往返一致，自动建父目录，不留临时文件', async () => {
    const store = seeded();
    store.dispatches.update('dispatch_1', { ...settled, filesModified: ['src/parser.ts'] });
    expect(await store.persistTo(path, nodeFs)).toEqual({ ok: true });

    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved.version).toBe(ORCHESTRATION_SNAPSHOT_VERSION);
    expect(await readdir(join(dir, 'nested'))).toEqual(['orchestration.json']);

    const restored = new InMemoryOrchestrationStore();
    expect(await restored.loadFrom(path, nodeFs)).toEqual({ ok: true, found: true });
    expect(restored.snapshot()).toEqual(store.snapshot());
  });

  it('文件不存在：found=false，状态不变', async () => {
    const store = seeded();
    expect(await store.loadFrom(join(dir, 'missing.json'), nodeFs)).toEqual({
      ok: true,
      found: false,
    });
    expect(store.runs.list()).toHaveLength(2);
  });

  it.each([
    ['坏 JSON', '{ nope'],
    ['版本不对', JSON.stringify({ version: 99 })],
    ['字段类型不对', JSON.stringify({ version: 1, tasks: [{ ...task, dependsOn: 'x' }] })],
    [
      '违反不变量',
      JSON.stringify({ version: 1, dispatches: [dispatch, { ...dispatch, id: 'd2' }] }),
    ],
  ])('文件损坏（%s）：返回错误，现有状态不变', async (_label, content) => {
    await writeFile(join(dir, 'bad.json'), content);
    const store = seeded();
    const before = store.snapshot();
    const result = await store.loadFrom(join(dir, 'bad.json'), nodeFs);
    expect(result.ok).toBe(false);
    expect(store.snapshot()).toEqual(before);
  });

  it('loadFrom 替换内容但保留表对象（外部持有的表引用仍有效）', async () => {
    const source = seeded();
    await source.persistTo(path, nodeFs);
    const target = new InMemoryOrchestrationStore();
    const messages = target.messages;
    target.runs.insert({ ...run, id: 'run_stale' });
    await target.loadFrom(path, nodeFs);
    expect(target.runs.get('run_stale')).toBeUndefined();
    expect(messages.get('msg_1')).toEqual(message);
  });

  it('并发 persistTo 按调用顺序串行写，最终文件是最后一次调用时的状态', async () => {
    const store = seeded();
    let releaseFirst: () => void = () => undefined;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let writes = 0;
    const slowFirstFs: CoreFs = {
      ...nodeFs,
      writeFile: async (file, data, encoding) => {
        writes += 1;
        if (writes === 1) await firstWriteGate;
        await nodeFs.writeFile(file, data, encoding);
      },
    };
    const first = store.persistTo(path, slowFirstFs);
    store.runs.insert({ ...run, id: 'run_3' });
    const second = store.persistTo(path, slowFirstFs);
    // 不串行的话，第二次写会趁第一次卡住时先落盘，随后被第一次的旧快照覆盖
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(writes).toBe(1);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    const saved = JSON.parse(await readFile(path, 'utf8')) as OrchestrationSnapshot;
    expect(saved.runs.map((entity) => entity.id)).toEqual(['run_1', 'run_2', 'run_3']);
  });

  it('写入失败返回错误而不是抛异常', async () => {
    const failingFs: CoreFs = {
      ...nodeFs,
      rename: async () => {
        throw new Error('EPERM');
      },
    };
    const result = await seeded().persistTo(path, failingFs);
    expect(!result.ok && result.error).toMatch(/EPERM/);
  });
});

describe('parseOrchestrationSnapshot', () => {
  it('缺省的表视为空，丢弃未知字段', () => {
    const result = parseOrchestrationSnapshot({
      version: 1,
      runs: [{ ...run, extra: true }],
      unknownTable: [],
    });
    expect(result).toEqual({
      ok: true,
      snapshot: { version: 1, runs: [run], tasks: [], dispatches: [], worktrees: [], messages: [] },
    });
  });

  it.each<[string, unknown, RegExp]>([
    ['非对象', [], /snapshot must be an object/],
    ['缺 version', {}, /version/],
    ['表不是数组', { version: 1, runs: {} }, /runs must be an array/],
    ['实体不是对象', { version: 1, runs: [1] }, /runs\[0\]/],
    [
      '必填字段缺失',
      { version: 1, worktrees: [{ ...worktree, baseCommit: undefined }] },
      /baseCommit/,
    ],
    ['数字字段非数字', { version: 1, runs: [{ ...run, createdAt: 'yesterday' }] }, /createdAt/],
    ['可选字段类型不对', { version: 1, messages: [{ ...message, ackedAt: 'now' }] }, /ackedAt/],
    [
      '枚举非法',
      { version: 1, dispatches: [{ ...dispatch, ...settled, outcome: 'meh' }] },
      /outcome/,
    ],
    ['重复 id', { version: 1, runs: [run, run] }, /already exists/],
  ])('坏快照：%s', (_label, input, error) => {
    const result = parseOrchestrationSnapshot(input);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(error);
  });
});
