import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createMarketHttpGet } from './marketHttp';

const BASE = 'https://example.test/dist/';

/** 假 request：按给定状态码 / 头 / 分块回应 */
function fakeRequest(status: number, chunks: Buffer[], headers: Record<string, string> = {}) {
  const calls: string[] = [];
  const request = vi.fn(
    (url: string, _options: unknown, callback: (res: IncomingMessage) => void) => {
      calls.push(url);
      const req = new EventEmitter() as ClientRequest;
      req.destroy = vi.fn(() => req) as unknown as ClientRequest['destroy'];
      req.end = (() => {
        const res = new PassThrough() as unknown as IncomingMessage;
        res.statusCode = status;
        res.headers = headers;
        queueMicrotask(() => {
          callback(res);
          for (const chunk of chunks) (res as unknown as PassThrough).write(chunk);
          (res as unknown as PassThrough).end();
        });
        return req;
      }) as ClientRequest['end'];
      return req;
    }
  );
  return { request, calls };
}

function client(request: ReturnType<typeof fakeRequest>['request']) {
  return createMarketHttpGet({
    env: () => ({}),
    baseUrl: BASE,
    nodeVersion: '24.10.0',
    request: request as never,
  });
}

describe('createMarketHttpGet', () => {
  it('取回基址下的字节', async () => {
    const fake = fakeRequest(200, [Buffer.from('he'), Buffer.from('llo')]);
    const bytes = await client(fake.request)(`${BASE}index.json`, { maxBytes: 100 });
    expect(Buffer.from(bytes).toString()).toBe('hello');
  });

  it('拒绝基址以外的 URL，且不发请求', async () => {
    const fake = fakeRequest(200, []);
    await expect(
      client(fake.request)('https://evil.test/dist/index.json', { maxBytes: 10 })
    ).rejects.toThrow('url-not-allowed');
    expect(fake.request).not.toHaveBeenCalled();
  });

  it('3xx 当错误，不跟随重定向', async () => {
    const fake = fakeRequest(302, [], { location: 'https://evil.test/' });
    await expect(client(fake.request)(`${BASE}index.json`, { maxBytes: 10 })).rejects.toThrow(
      'http-302'
    );
    expect(fake.calls).toHaveLength(1);
  });

  it('超过 maxBytes 中止', async () => {
    const fake = fakeRequest(200, [Buffer.alloc(6), Buffer.alloc(6)]);
    await expect(client(fake.request)(`${BASE}a.zip`, { maxBytes: 10 })).rejects.toThrow(
      'too-large'
    );
    const declared = fakeRequest(200, [], { 'content-length': '11' });
    await expect(client(declared.request)(`${BASE}a.zip`, { maxBytes: 10 })).rejects.toThrow(
      'too-large'
    );
  });

  it('TLS 校验被关掉时拒绝连接', async () => {
    const fake = fakeRequest(200, []);
    const get = createMarketHttpGet({
      env: () => ({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }),
      baseUrl: BASE,
      request: fake.request as never,
    });
    await expect(get(`${BASE}index.json`, { maxBytes: 10 })).rejects.toThrow(
      'tls-verification-disabled'
    );
    expect(fake.request).not.toHaveBeenCalled();
  });
});
