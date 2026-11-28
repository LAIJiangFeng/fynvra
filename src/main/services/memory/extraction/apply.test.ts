import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadSqlite } from '../../providers/import/fixtures';
import type { MemoryRow } from '../store';
import { type ApplyContext, applyOperations } from './apply';
import { type ExtractionOperation, parseOperations } from './prompt';
import { createMemoryFixture, type MemoryFixture } from './testing';

const MATERIAL = 'The build needs   cross-env on Windows.\nRun pnpm i first. Old note is wrong.';

let fx: MemoryFixture;
beforeAll(loadSqlite);
beforeEach(() => {
  fx = createMemoryFixture();
});
afterEach(() => fx.close());

const context = (candidates: MemoryRow[]): ApplyContext => ({
  material: MATERIAL,
  candidates,
  source: { taskId: 't1', title: 'Fix build', workspaceId: 'w1', coordinatorSessionId: 's-main' },
});

const add = (content: string, extra: Partial<ExtractionOperation> = {}): ExtractionOperation => ({
  op: 'add',
  category: 'pitfall',
  content,
  evidence: 'cross-env on Windows',
  ...extra,
});

async function seed(content: string, extra: { pinned?: boolean; user?: boolean } = {}) {
  const { store, projectKey } = await fx.project();
  return store.insert(projectKey, {
    category: 'rule',
    content,
    sourceKind: extra.user ? 'user' : 'agent',
    pinned: extra.pinned ?? false,
  });
}

async function apply(operations: ExtractionOperation[], candidates: MemoryRow[] = []) {
  return fx.service.applyInTransaction('w1', (project) =>
    applyOperations(project, operations, context(candidates))
  );
}

describe('parseOperations', () => {
  it('非法 JSON 或缺 operations 返回 undefined；允许 ```json 代码块；坏条目丢弃', () => {
    expect(parseOperations('not json')).toBeUndefined();
    expect(parseOperations('{"ops":[]}')).toBeUndefined();
    expect(parseOperations('```json\n{"operations":[]}\n```')).toEqual([]);
    expect(
      parseOperations(
        JSON.stringify({
          operations: [
            { op: 'add', category: 'rule', content: 'x', evidence: 'e' },
            { op: 'add', category: 'bogus', content: 'x', evidence: 'e' },
            { op: 'update', evidence: 'e' },
            { op: 'keep', id: 3 },
            { op: 'keep', id: 3, evidence: 'e' },
          ],
        })
      )
    ).toEqual([
      { op: 'add', category: 'rule', content: 'x', evidence: 'e' },
      { op: 'keep', id: 3, evidence: 'e' },
    ]);
  });
});

describe('applyOperations', () => {
  it('add：写入出处；evidence 合并空白后比对，找不到的丢弃', async () => {
    const summary = await apply([
      add('Windows 上 build 需要 cross-env', { evidence: 'needs cross-env  on\nWindows' }),
      add('不存在的依据', { evidence: 'nowhere in material' }),
    ]);
    expect(summary).toMatchObject({ added: 1, dropped: 1 });
    const { store, projectKey } = await fx.project();
    expect(store.all(projectKey)).toMatchObject([
      {
        source_kind: 'extraction',
        source_task_id: 't1',
        source_title: 'Fix build',
        source_workspace_id: 'w1',
        source_session_id: 's-main',
        evidence: 'needs cross-env  on\nWindows',
      },
    ]);
  });

  it('超额：最多 8 条操作、其中 add 最多 5 条', async () => {
    const ops = Array.from({ length: 10 }, (_, index) => add(`fact number ${index} alpha${index}`));
    const summary = await apply(ops);
    expect(summary.added).toBe(5);
    expect(summary.dropped).toBe(3);
  });

  it('越界 id 丢弃；pinned 与用户来源只接受 keep', async () => {
    const pinned = await seed('pinned rule', { pinned: true });
    const user = await seed('user rule', { user: true });
    const outside = await seed('not a candidate');
    const summary = await apply(
      [
        { op: 'delete', id: outside.id, evidence: 'Old note is wrong' },
        { op: 'update', id: pinned.id, content: 'changed', evidence: 'Old note is wrong' },
        { op: 'delete', id: user.id, evidence: 'Old note is wrong' },
        { op: 'keep', id: pinned.id, evidence: 'Run pnpm i first' },
      ],
      [pinned, user]
    );
    expect(summary).toMatchObject({ kept: 1, dropped: 3, deleted: 0, updated: 0 });
    const { store, projectKey } = await fx.project();
    expect(store.get(projectKey, pinned.id)).toMatchObject({
      content: 'pinned rule',
      use_count: 1,
    });
    expect(store.get(projectKey, user.id)?.status).toBe('active');
    expect(store.get(projectKey, outside.id)?.status).toBe('active');
  });

  it('add 与已有条目相同或高度相似时改为 keep', async () => {
    const existing = await seed('Run pnpm install before building the project');
    const summary = await apply([
      add('Run pnpm install before building the project.'),
      add('run pnpm install before building the project now'),
    ]);
    expect(summary).toMatchObject({ added: 0, kept: 1 });
    const { store, projectKey } = await fx.project();
    expect(store.all(projectKey)).toHaveLength(1);
    expect(store.get(projectKey, existing.id)?.use_count).toBe(1);
  });

  it('delete 改为停用并记原因；keep 记使用并清 flag；update 换内容与出处并清 flag', async () => {
    const stale = await seed('old note');
    const kept = await seed('keep me');
    const changed = await seed('needs cross-env');
    const { store, projectKey } = await fx.project();
    store.flag(projectKey, kept.id, 'maybe outdated', 's-worker');
    store.flag(projectKey, changed.id, 'maybe outdated', 's-worker');
    const summary = await apply(
      [
        { op: 'delete', id: stale.id, evidence: 'Old note is wrong' },
        { op: 'keep', id: kept.id, evidence: 'Run pnpm i first' },
        {
          op: 'update',
          id: changed.id,
          content: 'Windows 上 build 需要 cross-env',
          evidence: 'cross-env on Windows',
        },
      ],
      [stale, kept, changed]
    );
    expect(summary).toMatchObject({ deleted: 1, kept: 1, updated: 1 });
    expect(store.get(projectKey, stale.id)).toMatchObject({
      status: 'disabled',
      disabled_reason: 'Old note is wrong',
    });
    expect(store.get(projectKey, kept.id)).toMatchObject({
      use_count: 1,
      flagged_at: null,
      flag_note: null,
    });
    expect(store.get(projectKey, changed.id)).toMatchObject({
      content: 'Windows 上 build 需要 cross-env',
      source_kind: 'extraction',
      source_task_id: 't1',
      flagged_at: null,
    });
  });
});
