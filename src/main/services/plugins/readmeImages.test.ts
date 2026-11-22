import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReadmeImageInput, type ReadmeSource } from '@shared/types/plugins';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  loadReadmeImage,
  README_IMAGE_MAX_BYTES,
  type ReadmeImageDeps,
  relativeSegments,
  rememberReadme,
} from './readmeImages';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const pi: ReadmeSource = { kind: 'pi', id: 'demo' };
const market: ReadmeSource = { kind: 'market', pluginId: 'fynvra.demo', version: '1.0.0' };

let root: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'fynvra-readme-img-'));
  outside = await mkdtemp(join(tmpdir(), 'fynvra-readme-out-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets', 'logo.png'), PNG);
  await writeFile(join(root, 'fake.png'), Buffer.from('not an image'));
  await writeFile(
    join(root, 'big.png'),
    Buffer.concat([PNG, Buffer.alloc(README_IMAGE_MAX_BYTES)])
  );
  await writeFile(join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  await writeFile(join(root, 'evil.svg'), '<html><script>1</script></html>');
  await writeFile(join(outside, 'secret.png'), PNG);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function deps(overrides: Partial<ReadmeImageDeps> = {}): ReadmeImageDeps {
  return {
    pluginDir: async () => root,
    fetchImage: vi.fn(async () => ({ contentType: 'image/png', body: PNG, truncated: false })),
    ...overrides,
  };
}

/** 把 src 放进 README 再请求 */
async function load(src: string, source: ReadmeSource = pi, d = deps()) {
  rememberReadme(source, `# Demo\n\n![x](${src})\n`);
  return loadReadmeImage({ source, src }, d);
}

describe('parseReadmeImageInput', () => {
  it('只接受 { source, src }，source 按 kind 收窄，src 不超过 2048', () => {
    expect(parseReadmeImageInput({ source: pi, src: 'a.png' })).toEqual({
      source: pi,
      src: 'a.png',
    });
    expect(parseReadmeImageInput({ source: market, src: 'https://x.test/a.png' })).not.toBeNull();
    for (const raw of [
      undefined,
      'a.png',
      { source: pi },
      { source: pi, src: '' },
      { source: pi, src: 1 },
      { source: pi, src: 'a'.repeat(2049) },
      { source: pi, src: 'a.png', path: '/etc' },
      { source: { kind: 'pi', id: 'demo', path: '/x' }, src: 'a.png' },
      { source: { kind: 'pi', id: '../x' }, src: 'a.png' },
      { source: { kind: 'other', id: 'demo' }, src: 'a.png' },
      { source: { kind: 'market', pluginId: 'fynvra.demo' }, src: 'a.png' },
    ]) {
      expect(parseReadmeImageInput(raw)).toBeNull();
    }
  });
});

describe('loadReadmeImage', () => {
  it('README 里没有的地址、没读过的 README 一律拒绝', async () => {
    rememberReadme(pi, '![x](assets/logo.png)');
    const d = deps();
    expect(await loadReadmeImage({ source: pi, src: 'other.png' }, d)).toEqual({
      ok: false,
      code: 'not-in-readme',
    });
    expect(
      await loadReadmeImage({ source: { kind: 'pi', id: 'never-read' }, src: 'assets/logo.png' }, d)
    ).toEqual({ ok: false, code: 'not-in-readme' });
    expect(d.fetchImage).not.toHaveBeenCalled();
  });

  it('README 缓存 10 分钟后过期', async () => {
    rememberReadme(pi, '![x](assets/logo.png)', 0);
    const d = deps({ now: () => 11 * 60 * 1000 });
    expect(await loadReadmeImage({ source: pi, src: 'assets/logo.png' }, d)).toMatchObject({
      code: 'not-in-readme',
    });
  });

  it('已装插件没有 README 时，按对应市场版本的 README 核对', async () => {
    rememberReadme(pi, 'no images here');
    rememberReadme(market, '<img src="./assets/logo.png">');
    const d = deps({ marketOf: async () => market });
    expect(await loadReadmeImage({ source: pi, src: './assets/logo.png' }, d)).toMatchObject({
      ok: true,
    });
  });

  it('相对路径：读插件目录里的图片，返回 data URL', async () => {
    expect(await load('assets/logo.png')).toEqual({
      ok: true,
      dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
    });
    expect(await load('./assets/logo.png')).toMatchObject({ ok: true });
    expect(await load('icon.svg')).toMatchObject({
      ok: true,
      dataUrl: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
    });
  });

  it('相对路径的越界写法一律拒绝', async () => {
    for (const src of [
      '../secret.png',
      '%2e%2e/secret.png',
      'a/../../b.png',
      'C:\\Windows\\x.png',
      '\\\\server\\share\\x.png',
      '~/x.png',
      'x.png:stream',
      '/etc/passwd',
      'assets//logo.png',
      'assets/logo.png?raw=1',
      'assets/logo.png#a',
      'assets%5clogo.png',
    ]) {
      expect((await load(src)).ok, src).toBe(false);
    }
    expect(relativeSegments('a/../../b')).toBeNull();
    expect(relativeSegments('%2e%2e/x')).toBeNull();
    expect(relativeSegments('./a/b.png')).toEqual(['a', 'b.png']);
  });

  it('市场 README 没有本地目录，相对路径不加载；http 不加载', async () => {
    expect(await load('assets/logo.png', market)).toEqual({ ok: false, code: 'unsupported' });
    const d = deps();
    expect(await load('http://x.test/a.png', pi, d)).toEqual({ ok: false, code: 'unsupported' });
    expect(d.fetchImage).not.toHaveBeenCalled();
  });

  it('超过大小上限、文件头与类型不符、伪装的 svg 都拒绝', async () => {
    expect(await load('big.png')).toEqual({ ok: false, code: 'too-large' });
    expect(await load('fake.png')).toEqual({ ok: false, code: 'unsupported' });
    expect(await load('evil.svg')).toEqual({ ok: false, code: 'unsupported' });
    expect(await load('missing.png')).toEqual({ ok: false, code: 'not-found' });
  });

  it('符号链接（文件链接或指向目录外的目录链接）被拒绝', async () => {
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await load('linked/secret.png')).ok).toBe(false);
    try {
      await symlink(join(outside, 'secret.png'), join(root, 'link.png'));
    } catch (error) {
      // Windows 上没有建文件符号链接的权限时跳过这一段
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    expect((await load('link.png')).ok).toBe(false);
  });

  it('https：经注入的传输下载，Content-Type 与文件头都要对得上', async () => {
    const ok = deps();
    expect(await load('https://img.test/a.png', market, ok)).toMatchObject({ ok: true });
    expect(ok.fetchImage).toHaveBeenCalledWith(new URL('https://img.test/a.png'));

    const page = (contentType: string, body: Buffer, truncated = false) =>
      deps({ fetchImage: async () => ({ contentType, body, truncated }) });
    expect(await load('https://img.test/b.png', market, page('text/html', PNG))).toMatchObject({
      code: 'unsupported',
    });
    expect(await load('https://img.test/c.png', market, page('image/png', JPEG))).toMatchObject({
      code: 'unsupported',
    });
    expect(
      await load('https://img.test/d.png', market, page('image/jpeg; charset=x', JPEG))
    ).toMatchObject({ ok: true, dataUrl: expect.stringMatching(/^data:image\/jpeg;/) });
    expect(
      await load('https://img.test/e.svg', market, page('image/svg+xml', Buffer.from('<svg/>')))
    ).toMatchObject({ ok: true });
    expect(
      await load('https://img.test/f.svg', market, page('image/svg+xml', Buffer.from('<html>')))
    ).toMatchObject({ code: 'unsupported' });
    expect(
      await load('https://img.test/g.png', market, page('image/png', PNG, true))
    ).toMatchObject({ code: 'too-large' });
    const failing = deps({
      fetchImage: async () => {
        throw new Error('blocked address C:\\secret');
      },
    });
    expect(await load('https://10.0.0.1/a.png', market, failing)).toEqual({
      ok: false,
      code: 'failed',
    });
  });

  it('HTML 属性里写成 &amp; 的地址也算出现过', async () => {
    rememberReadme(market, '<img src="https://img.test/badge?a=1&amp;b=2">');
    expect(
      await loadReadmeImage({ source: market, src: 'https://img.test/badge?a=1&b=2' }, deps())
    ).toMatchObject({ ok: true });
  });
});
