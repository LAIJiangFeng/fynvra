import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  responses: [] as { status: number; headers: Record<string, string>; body?: Buffer }[],
  requested: [] as string[],
}));

// 不联网：https.request 直接按队列返回伪造的响应
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return {
    ...actual,
    request: (url: URL, _options: unknown, callback: (response: unknown) => void) => {
      mocks.requested.push(url.href);
      const next = mocks.responses.shift();
      const response = Object.assign(new PassThrough(), {
        statusCode: next?.status ?? 500,
        headers: next?.headers ?? {},
      });
      response.end(next?.body ?? Buffer.alloc(0));
      return {
        on: () => undefined,
        end: () => setImmediate(() => callback(response)),
      };
    },
  };
});

import { fetchPage } from './transport';

const IMAGE_OPTIONS = { httpsOnly: true, maxRedirects: 3, timeoutMs: 10_000, maxBytes: 16 };

beforeEach(() => {
  mocks.responses.length = 0;
  mocks.requested.length = 0;
});

describe('fetchPage 的图片用法', () => {
  it('httpsOnly：起始地址是 http 直接拒绝，不发请求', async () => {
    await expect(
      fetchPage(new URL('http://img.test/a.png'), {}, undefined, IMAGE_OPTIONS)
    ).rejects.toThrow(/https/);
    expect(mocks.requested).toEqual([]);
  });

  it('内网与回环地址被拒绝', async () => {
    for (const url of ['https://10.0.0.1/a.png', 'https://127.0.0.1/a.png', 'https://[::1]/']) {
      await expect(fetchPage(new URL(url), {}, undefined, IMAGE_OPTIONS)).rejects.toThrow();
    }
    expect(mocks.requested).toEqual([]);
  });

  it('重定向到 http 被拒绝；重定向次数有上限', async () => {
    mocks.responses.push({ status: 302, headers: { location: 'http://img.test/b.png' } });
    await expect(
      fetchPage(new URL('https://img.test/a.png'), {}, undefined, IMAGE_OPTIONS)
    ).rejects.toThrow(/only https/);

    for (let i = 0; i < 5; i++) {
      mocks.responses.push({ status: 302, headers: { location: `https://img.test/${i}.png` } });
    }
    await expect(
      fetchPage(new URL('https://img.test/a.png'), {}, undefined, IMAGE_OPTIONS)
    ).rejects.toThrow(/too many redirects \(more than 3\)/);
  });

  it('返回原始字节；超过 maxBytes 截断并标记 truncated', async () => {
    mocks.responses.push({
      status: 200,
      headers: { 'content-type': 'image/png' },
      body: Buffer.alloc(32, 1),
    });
    const page = await fetchPage(new URL('https://img.test/a.png'), {}, undefined, IMAGE_OPTIONS);
    expect(page).toMatchObject({ contentType: 'image/png', truncated: true });
    expect(page.body.length).toBe(16);
  });
});
