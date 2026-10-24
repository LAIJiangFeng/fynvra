import * as nodeFs from 'node:fs/promises';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreFs } from '../fs';
import type { Role } from '../types';
import { BUILTIN_ROLES } from './builtin';
import { JsonFileRoleStore } from './JsonFileRoleStore';

const tester: Role = {
  id: 'tester',
  name: '测试工程师',
  systemPrompt: 'Write failing tests first.',
  skillIds: ['tdd'],
  mcpServerIds: [],
  tools: 'all',
  approvalMode: 'supervised',
};
const reviewer: Role = { ...tester, id: 'reviewer', name: 'Reviewer', tools: 'readonly' };

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fynvra-roles-'));
  dir = join(root, 'roles');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// node:fs/promises 本身就满足 CoreFs：Main 直接传入即可
const realFs: CoreFs = nodeFs;

function createStore(fs: CoreFs = realFs, onInvalidFile?: (file: string, error: string) => void) {
  return new JsonFileRoleStore({ fs, dir, onInvalidFile });
}

describe('JsonFileRoleStore', () => {
  it('目录不存在时只列出内置角色', async () => {
    expect(await createStore().list()).toEqual(BUILTIN_ROLES);
  });

  it('save 写 `<id>.json`（格式化 JSON），get / list 读回；list 内置在前、自定义按 id 排序', async () => {
    const store = createStore();
    expect(await store.save(tester)).toEqual({ ok: true, role: tester });
    expect(await store.save(reviewer)).toEqual({ ok: true, role: reviewer });

    expect(JSON.parse(await readFile(join(dir, 'tester.json'), 'utf8'))).toEqual(tester);
    expect(await readFile(join(dir, 'tester.json'), 'utf8')).toMatch(/^\{\n {2}"id": "tester",/);
    expect(await store.get('tester')).toEqual(tester);
    expect((await store.list()).map((role) => role.id)).toEqual([
      'orchestrator',
      'worker',
      'reviewer',
      'tester',
    ]);
  });

  it('save 同 id 覆盖旧内容，且不在目录里留下临时文件', async () => {
    const store = createStore();
    await store.save(tester);
    await store.save({ ...tester, name: 'QA' });
    expect((await store.get('tester'))?.name).toBe('QA');
    expect(await readdir(dir)).toEqual(['tester.json']);
  });

  it('内置角色不可覆盖、不可删除', async () => {
    const store = createStore();
    const overwrite = await store.save({ ...BUILTIN_ROLES[1], name: 'Hacked' } as Role);
    expect(overwrite.ok).toBe(false);
    expect(!overwrite.ok && overwrite.error).toMatch(/built-in/);
    for (const id of ['orchestrator', 'worker']) {
      const removal = await store.remove(id);
      expect(!removal.ok && removal.error).toMatch(/built-in/);
    }
    expect((await store.get('worker'))?.name).toBe('Worker');
    await expect(readdir(dir)).rejects.toThrow();
  });

  it('save 拒绝非法角色，并去掉自定义角色上的 builtin 标记', async () => {
    const store = createStore();
    const invalid = await store.save({ ...tester, tools: 'root' } as unknown as Role);
    expect(!invalid.ok && invalid.error).toContain('role.tools');

    const result = await store.save({ ...tester, builtin: true });
    expect(result).toEqual({ ok: true, role: tester });
    expect(await store.get('tester')).toEqual(tester);
  });

  it('remove 删除文件；不存在的角色返回错误', async () => {
    const store = createStore();
    await store.save(tester);
    expect(await store.remove('tester')).toEqual({ ok: true });
    expect(await store.get('tester')).toBeUndefined();
    const missing = await store.remove('tester');
    expect(!missing.ok && missing.error).toMatch(/not found/);
  });

  it('非法 id 不会触达文件系统（路径穿越）', async () => {
    const readFileSpy = vi.fn(realFs.readFile);
    const unlinkSpy = vi.fn(realFs.unlink);
    const store = createStore({ ...realFs, readFile: readFileSpy, unlink: unlinkSpy });
    expect(await store.get('../secrets')).toBeUndefined();
    const removal = await store.remove('../secrets');
    expect(!removal.ok && removal.error).toMatch(/invalid role id/);
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it('list / get 跳过坏文件并通过 onInvalidFile 报告原因', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'tester.json'), JSON.stringify(tester));
    await writeFile(join(dir, 'notes.txt'), 'not a role');
    await writeFile(join(dir, 'broken.json'), '{ not json');
    await writeFile(
      join(dir, 'bad-shape.json'),
      JSON.stringify({ ...tester, id: 'bad-shape', tools: 'x' })
    );
    await writeFile(join(dir, 'renamed.json'), JSON.stringify(tester));
    await writeFile(join(dir, 'worker.json'), JSON.stringify({ ...tester, id: 'worker' }));
    await writeFile(join(dir, 'Bad Name.json'), JSON.stringify(tester));

    const onInvalidFile = vi.fn();
    const store = createStore(realFs, onInvalidFile);
    const roles = await store.list();
    expect(roles.map((role) => role.id)).toEqual(['orchestrator', 'worker', 'tester']);
    expect(roles[1]?.name).toBe('Worker');

    const reasons = Object.fromEntries(onInvalidFile.mock.calls);
    expect(Object.keys(reasons).sort()).toEqual([
      'Bad Name.json',
      'bad-shape.json',
      'broken.json',
      'renamed.json',
      'worker.json',
    ]);
    expect(reasons['broken.json']).toMatch(/invalid JSON/);
    expect(reasons['bad-shape.json']).toContain('role.tools');
    expect(reasons['renamed.json']).toMatch(/does not match/);
    expect(reasons['worker.json']).toMatch(/built-in/);

    expect(await store.get('broken')).toBeUndefined();
  });

  it('单个文件读不了（非 ENOENT）时跳过并报告，不影响其他角色', async () => {
    await createStore().save(tester);
    await createStore().save(reviewer);
    const lockedFs: CoreFs = {
      ...realFs,
      readFile: async (path, encoding) => {
        if (path.endsWith('reviewer.json')) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        return realFs.readFile(path, encoding);
      },
    };
    const onInvalidFile = vi.fn();
    const store = createStore(lockedFs, onInvalidFile);
    expect((await store.list()).map((role) => role.id)).toEqual([
      'orchestrator',
      'worker',
      'tester',
    ]);
    expect(await store.get('reviewer')).toBeUndefined();
    expect(onInvalidFile).toHaveBeenCalledWith('reviewer.json', expect.stringMatching(/EACCES/));
  });

  it('写入失败时返回错误并清理临时文件', async () => {
    const failingFs: CoreFs = {
      ...realFs,
      rename: async () => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      },
    };
    const result = await createStore(failingFs).save(tester);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/failed to save role "tester": EPERM/);
    expect(await readdir(dir)).toEqual([]);
  });
});
