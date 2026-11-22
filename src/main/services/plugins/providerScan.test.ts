import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractHeaderComment, scanPluginProviders } from './providerScan';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fynvra-provider-scan-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function pluginDir(pkg?: unknown): Promise<string> {
  const root = join(dir, 'plugin');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'index.ts'), 'export default {}');
  if (pkg !== undefined) {
    await writeFile(
      join(root, 'package.json'),
      typeof pkg === 'string' ? pkg : JSON.stringify(pkg)
    );
  }
  return root;
}

describe('scanPluginProviders: 简介', () => {
  it('目录插件取 package.json 的 description', async () => {
    const root = await pluginDir({ name: 'x', description: '  Lazy senior dev mode  ' });
    expect((await scanPluginProviders(root)).description).toBe('Lazy senior dev mode');
  });

  it('package.json 坏 JSON、超过 64 KB 时忽略', async () => {
    expect((await scanPluginProviders(await pluginDir('{oops'))).description).toBeUndefined();
    const big = { description: 'x', pad: 'y'.repeat(70 * 1024) };
    expect((await scanPluginProviders(await pluginDir(big))).description).toBeUndefined();
  });

  it('package.json 是符号链接时忽略', async () => {
    const root = await pluginDir();
    const target = join(dir, 'real.json');
    await writeFile(target, JSON.stringify({ description: 'linked' }));
    try {
      await symlink(target, join(root, 'package.json'), 'file');
    } catch {
      return; // Windows 没有创建符号链接的权限时跳过
    }
    expect((await scanPluginProviders(root)).description).toBeUndefined();
  });

  it('单文件插件取开头注释', async () => {
    const file = join(dir, 'ext.ts');
    await writeFile(
      file,
      '#!/usr/bin/env node\n/**\n * 生成图片\n * 的插件\n *\n * 第二段\n */\nexport {}'
    );
    expect((await scanPluginProviders(file)).description).toBe('生成图片 的插件');
  });

  it('超长简介截断并加省略号', async () => {
    const file = join(dir, 'ext.ts');
    await writeFile(file, `// ${'a'.repeat(400)}\nexport {}`);
    const description = (await scanPluginProviders(file)).description ?? '';
    expect(description).toHaveLength(300);
    expect(description.endsWith('…')).toBe(true);
  });

  it('扫描格式版本加进 stamp：旧 stamp 会让插件重新扫描', async () => {
    const root = await pluginDir({ description: 'd' });
    const first = await scanPluginProviders(root);
    expect((await scanPluginProviders(root, first.stamp)).names).toBeNull();
    // 按旧格式（只有被扫文件，不含版本）算出的 stamp 与新 stamp 不同，names 非 null 即重新读取
    const info = await stat(join(root, 'index.ts'));
    const legacy = createHash('sha256')
      .update(`index.ts\0${info.size}\0${Math.trunc(info.mtimeMs)}\n`)
      .digest('hex')
      .slice(0, 32);
    const again = await scanPluginProviders(root, legacy);
    expect(again.names).toEqual([]);
    expect(again.description).toBe('d');
  });
});

describe('extractHeaderComment', () => {
  it('支持 /** */、/* */、// 三种注释', () => {
    expect(extractHeaderComment('/** 一行简介 */\ncode')).toBe('一行简介');
    expect(extractHeaderComment('/* 普通\n   块注释 */')).toBe('普通 块注释');
    expect(extractHeaderComment('// 第一行\n// 第二行\n//\n// 第二段\ncode')).toBe('第一行 第二行');
  });

  it('跳过 BOM 与 shebang；没有注释或注释为空返回 undefined', () => {
    expect(extractHeaderComment('\uFEFF#!/usr/bin/env node\n// 说明')).toBe('说明');
    expect(extractHeaderComment('export const a = 1; // 不是开头')).toBeUndefined();
    expect(extractHeaderComment('/** */')).toBeUndefined();
    expect(extractHeaderComment('/* 未闭合')).toBeUndefined();
  });
});
