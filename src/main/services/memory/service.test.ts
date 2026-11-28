import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryPreferences } from '@shared/types/settings';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GitRunner } from '../gitRepository';
import { loadSqlite } from '../providers/import/fixtures';
import { createMemoryService, type MemoryCaller, type MemoryService } from './index';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SECRET = 'known-secret-value-1';

let dir: string;
let service: MemoryService;
let prefs: MemoryPreferences;
let userMessages: string[];
let changed: string[][];
let knownFails: boolean;

// w1、w2 是同一仓库（同根提交），w3 是另一个项目
const roots: Record<string, string> = {};
const runGit: GitRunner = async (_args, cwd) => ({ ok: true, stdout: `${roots[cwd]}\n` });

const main: MemoryCaller = { sessionId: 's-main', workspaceId: 'w1', title: '主会话' };
const worker: MemoryCaller = { ...main, sessionId: 's-worker', dispatchId: 'd1' };
const other: MemoryCaller = { ...main, workspaceId: 'w3' };

beforeAll(loadSqlite);
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fynvra-memory-svc-'));
  roots[join(dir, 'w1')] = SHA_A;
  roots[join(dir, 'w2')] = SHA_A;
  roots[join(dir, 'w3')] = SHA_B;
  prefs = { enabled: true, autoExtract: true, expireDays: 28 };
  userMessages = [];
  changed = [];
  knownFails = false;
  service = createMemoryService({
    dbPath: join(dir, 'memory', 'memory.db'),
    runGit,
    preferences: () => ({ memory: prefs }),
    workspace: (id) =>
      ['w1', 'w2', 'w3'].includes(id) ? { path: join(dir, id), vcs: 'git' } : undefined,
    recentUserMessages: async () => userMessages,
    knownSecrets: async () => {
      if (knownFails) throw new Error('nope');
      return [SECRET];
    },
    onChanged: (ids) => changed.push(ids),
  });
});
afterEach(async () => {
  service.stop();
  (await service.database())?.close();
  rmSync(dir, { recursive: true, force: true });
});

const write = (caller: MemoryCaller, input: unknown) => service.handle(caller, 'write', input);
const result = (r: { ok: boolean; result?: unknown; error?: string }) => {
  if (!r.ok) throw new Error(r.error);
  // biome-ignore lint/suspicious/noExplicitAny: 测试里直接读工具结果的字段
  return r.result as Record<string, any>;
};
const addFact = async (content: string, extra = {}) =>
  result(await write(main, { action: 'add', category: 'rule', content, ...extra })).memory
    .id as number;

describe('memory tool host', () => {
  it('权限：档位会话、总开关关闭全部拒绝；worker 不能写', async () => {
    for (const profile of ['triage', 'restricted'] as const) {
      expect((await service.handle({ ...main, profile }, 'search', {})).ok).toBe(false);
    }
    expect(await write(worker, { action: 'add', category: 'rule', content: 'x' })).toMatchObject({
      ok: false,
    });
    expect((await service.handle(worker, 'search', {})).ok).toBe(true);
    prefs = { ...prefs, enabled: false };
    expect((await service.handle(main, 'search', {})).ok).toBe(false);
    expect((await service.handle(main, 'bogus', {})).ok).toBe(false);
  });

  it('入参在 Main 再校验：拒绝多余键、绝对路径与 ..、超长内容', async () => {
    for (const input of [
      { action: 'add', category: 'rule', content: 'x', extra: 1 },
      { action: 'add', category: 'rule', content: 'x', files: ['/etc/passwd'] },
      { action: 'add', category: 'rule', content: 'x', files: ['C:\\a.txt'] },
      { action: 'add', category: 'rule', content: 'x', files: ['src/../../x'] },
      { action: 'add', category: 'rule', content: 'x'.repeat(501) },
      { action: 'add', category: 'nope', content: 'x' },
      { action: 'update', content: 'x' },
      'not an object',
    ]) {
      expect((await write(main, input)).ok, JSON.stringify(input)).toBe(false);
    }
    const ok = result(
      await write(main, { action: 'add', category: 'rule', content: 'x', files: ['.\\src\\a.ts'] })
    );
    expect(ok.memory.files).toEqual(['src/a.ts']);
  });

  it('add：去密钥；哈希命中返回已有条目并记使用；相似时返回候选，force 才写', async () => {
    const id = await addFact(`api key is ${SECRET}`);
    const again = result(
      await write(main, { action: 'add', category: 'rule', content: 'API key is [已移除密钥].' })
    );
    expect(again).toMatchObject({ status: 'exists', memory: { id, useCount: 1 } });

    const content = 'always run pnpm test before commit';
    await addFact(content);
    const similar = result(
      await write(main, {
        action: 'add',
        category: 'rule',
        content: 'always run pnpm test before every commit',
      })
    );
    expect(similar.status).toBe('similar');
    expect(similar.candidates.map((c: { content: string }) => c.content)).toEqual([content]);
    const forced = result(
      await write(main, {
        action: 'add',
        category: 'rule',
        content: 'always run pnpm test before every commit',
        force: true,
      })
    );
    expect(forced.status).toBe('added');
    expect(changed.at(-1)?.sort()).toEqual(['w1']);
  });

  it('已知密钥读不到时拒绝写入', async () => {
    knownFails = true;
    expect((await write(main, { action: 'add', category: 'rule', content: 'x' })).ok).toBe(false);
  });

  it('quote 核对：逐字通过 → user + pinned；不通过按 agent 保存', async () => {
    userMessages = ['请记住：提交前一定要跑 lint'];
    const pinned = result(
      await write(main, {
        action: 'add',
        category: 'rule',
        content: '提交前跑 lint',
        quote: ' 提交前一定要跑 lint ',
      })
    ).memory;
    expect(pinned).toMatchObject({
      pinned: true,
      source: { kind: 'user', evidence: '提交前一定要跑 lint' },
    });
    const agent = result(
      await write(main, {
        action: 'add',
        category: 'workflow',
        content: 'node 版本用 24',
        quote: '用户没说过',
      })
    ).memory;
    expect(agent).toMatchObject({ pinned: false, source: { kind: 'agent' } });
  });

  it('pinned 记忆的 update / delete 必须带核对通过的 quote', async () => {
    userMessages = ['记住 X 规则', '把 X 规则删了'];
    const id = result(
      await write(main, {
        action: 'add',
        category: 'rule',
        content: 'X 规则',
        quote: '记住 X 规则',
      })
    ).memory.id;
    expect((await write(main, { action: 'update', id, content: 'Y' })).ok).toBe(false);
    expect((await write(main, { action: 'delete', id, quote: '瞎编的' })).ok).toBe(false);
    expect(result(await write(main, { action: 'delete', id, quote: '把 X 规则删了' }))).toEqual({
      status: 'deleted',
      id,
    });
  });

  it('跨项目 id 视为不存在；同仓库的工作区共用', async () => {
    const id = await addFact('仅属于 A 仓库');
    expect((await service.handle(other, 'search', { ids: [id] })).ok).toBe(true);
    expect(result(await service.handle(other, 'search', { ids: [id] }))).toEqual({
      memories: [],
      notFound: [id],
    });
    expect((await service.handle(other, 'feedback', { id, verdict: 'useful' })).ok).toBe(false);
    expect((await write(other, { action: 'delete', id })).ok).toBe(false);
    const shared = result(
      await service.handle({ ...main, workspaceId: 'w2' }, 'search', { ids: [id] })
    );
    expect(shared.memories[0]).toMatchObject({ id, useCount: 1 });
  });

  it('search：按关键词 / 类别检索 active，limit 生效', async () => {
    await addFact('数据库迁移脚本放在 migrations 目录');
    await write(main, {
      action: 'add',
      category: 'pitfall',
      content: 'Windows 上 git 换行要设 autocrlf=false',
    });
    expect(
      result(await service.handle(main, 'search', { query: '迁移脚本' })).memories
    ).toHaveLength(1);
    expect(
      result(await service.handle(main, 'search', { category: 'pitfall' })).memories[0].category
    ).toBe('pitfall');
    expect(result(await service.handle(main, 'search', { limit: 1 }))).toMatchObject({ total: 2 });
    expect((await service.handle(main, 'search', { limit: 21 })).ok).toBe(false);
  });

  it('feedback：useful 记使用；outdated 可写会话停用、worker 只标记', async () => {
    const a = await addFact('fact a');
    const b = await addFact('totally different b');
    await service.handle(main, 'feedback', { id: a, verdict: 'useful' });
    expect(result(await service.handle(main, 'search', { ids: [a] })).memories[0].useCount).toBe(2);
    await service.handle(worker, 'feedback', { id: b, verdict: 'outdated', note: '文件已删' });
    const flagged = result(await service.handle(main, 'search', { ids: [b] })).memories[0];
    expect(flagged).toMatchObject({ status: 'active', reportedOutdated: '文件已删' });
    await service.handle(main, 'feedback', { id: b, verdict: 'outdated', note: '确实过时' });
    expect(result(await service.handle(main, 'search', { ids: [b] })).memories[0]).toMatchObject({
      status: 'disabled',
      disabledReason: '确实过时',
    });
  });
});

describe('specFor', () => {
  it('档位会话、总开关关闭、库不可用 → undefined', async () => {
    expect(await service.specFor({ ...main, profile: 'triage' })).toBeUndefined();
    prefs = { ...prefs, enabled: false };
    expect(await service.specFor(main)).toBeUndefined();
    const broken = createMemoryService({
      dbPath: join(dir, 'blocker', 'memory.db'),
      runGit,
      preferences: () => ({ memory: { ...prefs, enabled: true } }),
      workspace: () => ({ path: dir, vcs: 'none' }),
      recentUserMessages: async () => [],
      knownSecrets: async () => [],
    });
    // 让库路径变成目录：打不开 → 不可用
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'blocker', 'memory.db'), { recursive: true });
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(await broken.specFor(main)).toBeUndefined();
      expect(await broken.list('w1')).toMatchObject({ ok: false });
    } finally {
      console.warn = warn;
    }
  });

  it('可写会话无记忆也返回空索引；worker 无 active 记忆时 undefined，有则只读', async () => {
    expect(await service.specFor(main)).toEqual({ index: '', write: true });
    expect(await service.specFor(worker)).toBeUndefined();
    const id = await addFact('提交前跑测试');
    expect(await service.specFor(worker)).toEqual({
      index: `- #${id} [rule] 提交前跑测试`,
      write: false,
    });
  });
});

describe('IPC 接口', () => {
  it('create 记为 user + pinned；update 改内容冲突报错；list 带共用工作区；clear 清空项目', async () => {
    await service.list('w2');
    const created = await service.create({
      workspaceId: 'w1',
      category: 'rule',
      content: `用 ${SECRET}`,
    });
    if (!created.ok) throw new Error(created.error);
    expect(created.memory).toMatchObject({
      sourceKind: 'user',
      pinned: true,
      content: '用 [已移除密钥]',
    });
    expect(
      (await service.create({ workspaceId: 'w1', category: 'rule', content: '用 [已移除密钥]' })).ok
    ).toBe(false);
    const second = await service.create({ workspaceId: 'w1', category: 'rule', content: '另一条' });
    if (!second.ok) throw new Error(second.error);
    expect(
      (
        await service.update({
          workspaceId: 'w1',
          id: second.memory.id,
          content: '用 [已移除密钥]',
        })
      ).ok
    ).toBe(false);
    const disabled = await service.update({
      workspaceId: 'w1',
      id: second.memory.id,
      status: 'disabled',
    });
    expect(disabled).toMatchObject({ ok: true, memory: { status: 'disabled', useCount: 1 } });
    expect(
      (await service.update({ workspaceId: 'w3', id: second.memory.id, pinned: false })).ok
    ).toBe(false);

    const list = await service.list('w1');
    if (!list.ok) throw new Error(list.error);
    expect(list.memories).toHaveLength(2);
    expect(list.sharedWithWorkspaceIds).toEqual(['w2']);

    changed = [];
    expect(await service.clear('w2')).toEqual({ ok: true, removed: 2 });
    expect(changed[0].sort()).toEqual(['w1', 'w2']);
    expect(await service.remove({ workspaceId: 'w1', id: second.memory.id })).toMatchObject({
      ok: false,
    });
  });

  it('applyInTransaction：异常时整体回滚', async () => {
    await expect(
      service.applyInTransaction('w1', ({ store, projectKey }) => {
        store.insert(projectKey, {
          category: 'rule',
          content: 'will roll back',
          sourceKind: 'extraction',
        });
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(result(await service.handle(main, 'search', {})).total).toBe(0);
  });
});

describe('T3 审查修复', () => {
  it('(a) 同一工作区连续 openProject 只跑一次 git；vcs 变化后重新解析；git 失败不缓存', async () => {
    let calls = 0;
    let fail = false;
    let vcs: 'git' | 'none' = 'git';
    const counting = createMemoryService({
      dbPath: join(dir, 'count', 'memory.db'),
      runGit: async (args, cwd) => {
        calls++;
        return fail ? { ok: false, error: 'x' } : runGit(args, cwd);
      },
      preferences: () => ({ memory: prefs }),
      workspace: () => ({ path: join(dir, 'w1'), vcs }),
      recentUserMessages: async () => [],
      knownSecrets: async () => [],
    });
    try {
      vcs = 'none';
      const dirKey = await counting.openProject('w1');
      expect(dirKey).toMatchObject({ projectKey: expect.stringMatching(/^dir:/) });
      expect(calls).toBe(0);
      vcs = 'git';
      fail = true;
      await counting.openProject('w1');
      await counting.openProject('w1');
      expect(calls).toBe(2);
      fail = false;
      expect(await counting.openProject('w1')).toMatchObject({ projectKey: `git:${SHA_A}` });
      expect(await counting.openProject('w1')).toMatchObject({ projectKey: `git:${SHA_A}` });
      expect(calls).toBe(3);
    } finally {
      (await counting.database())?.close();
    }
  });

  it('(b) 去掉空白不足 4 个字符的 quote 不能钉住记忆，4 个字符以上可以', async () => {
    userMessages = ['好的 就这样 记住吧'];
    const short = result(
      await write(main, { action: 'add', category: 'rule', content: '短引用', quote: '记 住吧' })
    ).memory;
    expect(short).toMatchObject({ pinned: false, source: { kind: 'agent' } });
    const long = result(
      await write(main, {
        action: 'add',
        category: 'rule',
        content: '长引用',
        quote: '就这样 记住',
      })
    ).memory;
    expect(long).toMatchObject({ pinned: true, source: { kind: 'user' } });
  });

  it('(c) 读不到已知密钥时，工具报错有可读的说明', async () => {
    knownFails = true;
    const response = await write(main, { action: 'add', category: 'rule', content: 'x' });
    expect(response).toMatchObject({
      ok: false,
      error: expect.stringContaining('cannot read known secrets'),
    });
  });

  it('(d) 库第一次打开失败后，下次调用重试并成功', async () => {
    const dbPath = join(dir, 'retry', 'memory.db');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dbPath, { recursive: true });
    const retry = createMemoryService({
      dbPath,
      runGit,
      preferences: () => ({ memory: prefs }),
      workspace: () => ({ path: join(dir, 'w1'), vcs: 'git' }),
      recentUserMessages: async () => [],
      knownSecrets: async () => [],
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(await retry.database()).toBeUndefined();
      rmSync(dbPath, { recursive: true, force: true });
      const db = await retry.database();
      expect(db).toBeDefined();
      db?.close();
    } finally {
      console.warn = warn;
    }
  });
});
