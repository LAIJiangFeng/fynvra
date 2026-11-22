import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_README_MAX_BYTES, readPluginReadme } from './pluginReadme';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fynvra-readme-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function pluginDir(files: Record<string, string> = {}): Promise<string> {
  const root = join(dir, 'plugin');
  await mkdir(root, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  return root;
}

describe('readPluginReadme', () => {
  it('文件名不区分大小写', async () => {
    const root = await pluginDir({ 'ReadMe.MD': '# 你好' });
    expect(await readPluginReadme(root)).toEqual({ ok: true, text: '# 你好' });
  });

  it('单文件插件、目录里没有 README、目录不存在都返回 none', async () => {
    const root = await pluginDir({ 'index.ts': 'export {}' });
    expect(await readPluginReadme(join(root, 'index.ts'))).toMatchObject({ code: 'none' });
    expect(await readPluginReadme(root)).toMatchObject({ code: 'none' });
    expect(await readPluginReadme(join(dir, 'missing'))).toMatchObject({ code: 'none' });
  });

  it('超过 256 KB 被拒，不返回内容', async () => {
    const root = await pluginDir({ 'README.md': 'x'.repeat(PLUGIN_README_MAX_BYTES + 1) });
    expect(await readPluginReadme(root)).toEqual({
      ok: false,
      code: 'too-large',
      error: 'too-large',
    });
  });

  it('README 是符号链接时被拒，错误不带路径', async () => {
    const root = await pluginDir();
    const target = join(dir, 'secret.md');
    await writeFile(target, 'secret');
    try {
      await symlink(target, join(root, 'README.md'), 'file');
    } catch {
      return; // Windows 没有创建符号链接的权限时跳过
    }
    const result = await readPluginReadme(root);
    expect(result).toMatchObject({ ok: false, code: 'failed' });
    expect(JSON.stringify(result)).not.toContain(dir);
  });
});
