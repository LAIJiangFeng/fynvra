import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceFileEntry } from '@shared/types/files';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFilesService, MAX_TEXT_BYTES } from './files';

describe('工作区文件只读服务', () => {
  let base: string;
  let root: string;
  let registered: boolean;
  let service: ReturnType<typeof createFilesService>;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'fynvra-files-'));
    root = join(base, 'repo');
    await mkdir(root);
    registered = true;
    service = createFilesService({
      getWorkspace: (id) =>
        registered && (id === 'ws' || id === 'other')
          ? { id, name: 'repo', repoPath: root, vcs: 'none' }
          : undefined,
    });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function entries(directoryId?: string): Promise<WorkspaceFileEntry[]> {
    const result = await service.list({ workspaceId: 'ws', directoryId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    return result.entries;
  }

  async function entry(name: string, directoryId?: string) {
    const found = (await entries(directoryId)).find((item) => item.name === name);
    if (!found) throw new Error(`未找到测试条目：${name}`);
    return found;
  }

  async function textFile(name: string) {
    const file = await entry(name);
    const result = await service.read({ workspaceId: 'ws', fileId: file.id });
    if (!result.ok || result.preview.kind !== 'text') throw new Error('测试文件不可编辑');
    return { workspaceId: 'ws', fileId: file.id, version: result.preview.version };
  }

  it('按读取版本保存文本，并返回新的版本；可以清空正文', async () => {
    await writeFile(join(root, 'note.md'), '# 原文');
    const input = await textFile('note.md');
    const saved = await service.write({ ...input, text: '# 修改后\n中文内容' });
    expect(saved).toMatchObject({
      ok: true,
      preview: { kind: 'text', text: '# 修改后\n中文内容' },
    });
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('# 修改后\n中文内容');
    if (!saved.ok) throw new Error('保存失败');
    expect(saved.preview.version).not.toBe(input.version);
    expect(
      await service.write({ ...input, version: saved.preview.version, text: '' })
    ).toMatchObject({ ok: true });
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('');
  });

  it('外部修改后拒绝旧版本保存，不覆盖磁盘内容', async () => {
    await writeFile(join(root, 'note.md'), '旧内容');
    const input = await textFile('note.md');
    await writeFile(join(root, 'note.md'), '外部内容');
    expect(await service.write({ ...input, text: '编辑草稿' })).toEqual({
      ok: false,
      error: 'conflict',
    });
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('外部内容');
    expect((await textFile('note.md')).version).not.toBe(input.version);
  });

  it('同一文件并发保存不会静默覆盖，只有一个旧版本请求成功', async () => {
    await writeFile(join(root, 'note.md'), '原文');
    const input = await textFile('note.md');
    const results = await Promise.all(
      ['第一份', '第二份'].map((text) => service.write({ ...input, text }))
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, error: 'conflict' }]);
  });

  it('保留 UTF-8 BOM，正文中的换行不被转换', async () => {
    await writeFile(join(root, 'note.md'), '\ufeff原文\r\n');
    const input = await textFile('note.md');
    expect(await service.write({ ...input, text: '修改\r\n' })).toMatchObject({ ok: true });
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('\ufeff修改\r\n');
  });

  it('拒绝过大的 UTF-8 正文、跨工作区 id 和非文本文件', async () => {
    await writeFile(join(root, 'note.md'), '原文');
    const input = await textFile('note.md');
    expect(await service.write({ ...input, text: '中'.repeat(MAX_TEXT_BYTES / 2) })).toEqual({
      ok: false,
      error: 'tooLarge',
    });
    expect(await service.write({ ...input, workspaceId: 'other', text: '内容' })).toMatchObject({
      ok: false,
    });
    await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
    const binary = await entry('binary.bin');
    expect(await service.write({ ...input, fileId: binary.id, text: '内容' })).toEqual({
      ok: false,
      error: 'notText',
    });
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('原文');
  });

  it('按层列目录，目录优先并自然排序，保留隐藏文件且不泄露绝对路径', async () => {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'index.ts'), 'export const n = 1;');
    for (const name of ['file10.txt', 'file2.txt', '.env']) await writeFile(join(root, name), 'x');
    const items = await entries();
    expect(items.map((item) => item.name)).toEqual(['src', '.env', 'file2.txt', 'file10.txt']);
    expect(JSON.stringify(items)).not.toContain(root.replaceAll('\\', '\\\\'));
    expect(items[0]).toMatchObject({ kind: 'directory', relativePath: 'src' });
    const nested = await entries(items[0].id);
    expect(nested).toHaveLength(1);
    expect(nested[0].relativePath).toBe('src/index.ts');
    expect((await entries())[0].id).toBe(items[0].id);
  });

  it('预览 UTF-8 中文、空文件和 HTML 源码，不改写文件', async () => {
    for (const [name, text] of [
      ['readme.md', '# 文件预览'],
      ['empty', ''],
      ['page.html', '<script>alert(1)</script>'],
    ]) {
      await writeFile(join(root, name), text);
      const file = await entry(name);
      expect(await service.read({ workspaceId: 'ws', fileId: file.id })).toMatchObject({
        ok: true,
        preview: { kind: 'text', text, size: Buffer.byteLength(text) },
      });
    }
  });

  it('二进制与非法 UTF-8 不作为文本返回', async () => {
    for (const [name, data] of [
      ['binary.bin', Buffer.from([0, 1, 2])],
      ['invalid.txt', Buffer.from([0xff, 0xfe, 97])],
    ] as const) {
      await writeFile(join(root, name), data);
      const file = await entry(name);
      expect(await service.read({ workspaceId: 'ws', fileId: file.id })).toMatchObject({
        ok: true,
        preview: { kind: 'unsupported', reason: 'binary' },
      });
    }
  });

  it('大文本有明确的大小限制，不把正文送入 Renderer', async () => {
    await writeFile(join(root, 'huge.txt'), 'a'.repeat(MAX_TEXT_BYTES + 1));
    const file = await entry('huge.txt');
    const result = await service.read({ workspaceId: 'ws', fileId: file.id });
    expect(result).toMatchObject({
      ok: true,
      preview: { kind: 'unsupported', reason: 'tooLarge' },
    });
    expect(result.ok && result.preview).not.toHaveProperty('text');
  });

  it('识别图片签名并返回 data URL，SVG 只作为文本', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64'
    );
    await writeFile(join(root, 'pixel.png'), png);
    await writeFile(join(root, 'icon.svg'), '<svg onload="alert(1)"></svg>');
    expect(
      await service.read({ workspaceId: 'ws', fileId: (await entry('pixel.png')).id })
    ).toMatchObject({
      ok: true,
      preview: { kind: 'image', dataUrl: `data:image/png;base64,${png.toString('base64')}` },
    });
    expect(
      await service.read({ workspaceId: 'ws', fileId: (await entry('icon.svg')).id })
    ).toMatchObject({
      ok: true,
      preview: { kind: 'text' },
    });
  });

  it('拒绝伪造路径、跨工作区 id 和已移除的工作区', async () => {
    await writeFile(join(root, 'a.txt'), 'a');
    const file = await entry('a.txt');
    for (const fileId of ['../secret', join(root, 'a.txt'), 'unknown']) {
      expect(await service.read({ workspaceId: 'ws', fileId })).toMatchObject({ ok: false });
    }
    expect(await service.read({ workspaceId: 'other', fileId: file.id })).toMatchObject({
      ok: false,
    });
    registered = false;
    expect(await service.read({ workspaceId: 'ws', fileId: file.id })).toMatchObject({
      ok: false,
      error: 'workspaceNotFound',
    });
  });

  it('文件和目录接口不能混用，文件消失时返回错误而不是抛异常', async () => {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'a.txt'), 'a');
    const dir = await entry('src');
    const file = await entry('a.txt');
    expect(await service.read({ workspaceId: 'ws', fileId: dir.id })).toMatchObject({ ok: false });
    expect(await service.list({ workspaceId: 'ws', directoryId: file.id })).toMatchObject({
      ok: false,
    });
    await rm(join(root, 'a.txt'));
    expect(await service.read({ workspaceId: 'ws', fileId: file.id })).toMatchObject({ ok: false });
  });

  it('符号链接只展示；目录被替换成越界链接后，旧 id 也不能读取外部文件', async () => {
    const outside = join(base, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), '外部内容');
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const linked = await entry('linked');
    expect(linked.kind).toBe('symlink');
    expect(await service.list({ workspaceId: 'ws', directoryId: linked.id })).toMatchObject({
      ok: false,
    });
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'secret.txt'), '工作区内');
    const dir = await entry('src');
    const file = await entry('secret.txt', dir.id);
    const before = await service.read({ workspaceId: 'ws', fileId: file.id });
    if (!before.ok || before.preview.kind !== 'text') throw new Error('测试文件不可编辑');
    await rename(join(root, 'src'), join(root, 'original'));
    await symlink(outside, join(root, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await service.read({ workspaceId: 'ws', fileId: file.id })).toMatchObject({
      ok: false,
      error: 'outsideWorkspace',
    });
    expect(
      await service.write({
        workspaceId: 'ws',
        fileId: file.id,
        version: before.preview.version,
        text: '不应写入',
      })
    ).toMatchObject({ ok: false, error: 'outsideWorkspace' });
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('外部内容');
  });
});
