import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFilesService } from './files';

describe('工作区 HTML 默认浏览器入口', () => {
  let base: string;
  let root: string;
  let registered: boolean;
  let service: ReturnType<typeof createFilesService>;
  const openExternal = vi.fn<(_: string) => Promise<void>>();

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'fynvra-html-'));
    root = join(base, 'repo');
    await mkdir(root);
    registered = true;
    openExternal.mockReset().mockResolvedValue(undefined);
    service = createFilesService({
      getWorkspace: (id) =>
        registered && ['ws', 'other'].includes(id)
          ? { id, name: 'repo', repoPath: root, vcs: 'none' }
          : undefined,
      shell: { reveal: vi.fn(), copyFiles: vi.fn(), trash: vi.fn(), openExternal },
    });
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function ref(name: string, directoryId?: string) {
    const result = await service.list({ workspaceId: 'ws', directoryId });
    if (!result.ok) throw new Error(result.error);
    const entry = result.entries.find((entry) => entry.name === name);
    if (!entry) throw new Error(`missing fixture ${name}`);
    return { workspaceId: 'ws', entryId: entry.id };
  }

  it.each(['平台与商户清单.HTML', 'page with space.htm', 'page#anchor.html'])(
    '仅将真实网页文件编码为 file URL：%s',
    async (name) => {
      const path = join(root, name);
      await writeFile(path, '<html>test</html>');
      const input = await ref(name);
      expect(await service.openHtml(input)).toEqual({ ok: true });
      expect(openExternal).toHaveBeenCalledExactlyOnceWith(
        pathToFileURL(await realpath(path)).href
      );
      const url = new URL(openExternal.mock.calls[0][0]);
      expect(url.hash).toBe('');
      expect(url.search).toBe('');
      // 浏览器入口不改变树中 HTML 源码读取。
      expect(await service.read({ workspaceId: 'ws', fileId: input.entryId })).toMatchObject({
        ok: true,
        preview: { kind: 'text', text: '<html>test</html>' },
      });
    }
  );

  it('拒绝路径、URL、多余字段、未知/跨工作区 id 和移除的工作区', async () => {
    await writeFile(join(root, 'page.html'), 'test');
    const input = await ref('page.html');
    for (const raw of [
      null,
      { ...input, entryId: '../page.html' },
      { ...input, path: join(root, 'page.html') },
      { ...input, url: 'file:///secret.html' },
      { ...input, command: 'execute' },
    ])
      expect(await service.openHtml(raw)).toEqual({ ok: false, error: 'invalidRequest' });
    expect(await service.openHtml({ ...input, entryId: 'unknown' })).toEqual({
      ok: false,
      error: 'entryNotFound',
    });
    expect(await service.openHtml({ ...input, workspaceId: 'other' })).toEqual({
      ok: false,
      error: 'entryNotFound',
    });
    registered = false;
    expect(await service.openHtml(input)).toEqual({ ok: false, error: 'workspaceNotFound' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('扩展名白名单拒绝普通文本、可执行程序、伪装后缀和目录', async () => {
    for (const name of ['note.md', 'run.exe', 'page.html.exe', 'page.svg', 'page.xhtml']) {
      await writeFile(join(root, name), '<html>not enough</html>');
      expect(await service.openHtml(await ref(name))).toEqual({ ok: false, error: 'notHtml' });
    }
    await mkdir(join(root, 'directory.html'));
    expect(await service.openHtml(await ref('directory.html'))).toEqual({
      ok: false,
      error: 'notFile',
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('重新校验旧 id 的文件类型、缺失和重命名后的扩展名', async () => {
    await writeFile(join(root, 'page.html'), 'test');
    const input = await ref('page.html');
    await service.rename({ ...input, name: 'page.exe' });
    expect(await service.openHtml(input)).toEqual({ ok: false, error: 'notHtml' });
    await service.rename({ ...input, name: 'page.html' });
    await rm(join(root, 'page.html'));
    expect(await service.openHtml(input)).toEqual({ ok: false, error: 'entryNotFound' });
    await mkdir(join(root, 'page.html'));
    expect(await service.openHtml(input)).toEqual({ ok: false, error: 'notFile' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('父目录被替换为外部 junction/symlink 后拒绝旧 id', async () => {
    const directory = join(root, 'docs');
    const outside = join(base, 'outside');
    await mkdir(directory);
    await mkdir(outside);
    await writeFile(join(directory, 'page.html'), 'inside');
    await writeFile(join(outside, 'page.html'), 'outside');
    const parent = await ref('docs');
    const input = await ref('page.html', parent.entryId);
    await rename(directory, join(root, 'old-docs'));
    await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await service.openHtml(input)).toEqual({ ok: false, error: 'outsideWorkspace' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('符号链接条目不会被交给外部程序，启动失败仅返回通用错误', async () => {
    await mkdir(join(root, 'target'));
    await symlink(
      join(root, 'target'),
      join(root, 'linked.html'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    expect(await service.openHtml(await ref('linked.html'))).toEqual({
      ok: false,
      error: 'notFile',
    });
    expect(openExternal).not.toHaveBeenCalled();
    await writeFile(join(root, 'page.html'), 'test');
    openExternal.mockRejectedValueOnce(new Error('private details'));
    expect(await service.openHtml(await ref('page.html'))).toEqual({
      ok: false,
      error: 'unavailable',
    });
  });
});
