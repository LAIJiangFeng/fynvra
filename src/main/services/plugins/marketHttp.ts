// 插件市场的 GET 客户端：只允许基址下的 URL，不跟随重定向，有超时与字节上限；错误只带错误码或 HTTP 状态。
import type { ClientRequest, IncomingMessage } from 'node:http';
import { Agent, request as httpsRequest, type RequestOptions } from 'node:https';
import { disablesNodeTlsVerification } from '../networkTest';
import { MARKET_BASE_URL } from './marketConfig';

/** 取回 url 的全部字节；失败时 reject 一个 message 为错误码的 MarketHttpError */
export type MarketHttpGet = (
  url: string,
  options: { maxBytes: number; timeoutMs?: number }
) => Promise<Uint8Array>;

export class MarketHttpError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MarketHttpError';
  }
}

type RequestFn = (
  url: string,
  options: RequestOptions,
  callback: (res: IncomingMessage) => void
) => ClientRequest;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 生产用：网络每次请求现读 §7.7 代理环境，带 TLS 守卫与 Node 版本守卫。
 * baseUrl / request / nodeVersion 只供测试注入。
 */
export function createMarketHttpGet(options: {
  env: () => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
  baseUrl?: string;
  nodeVersion?: string;
  request?: RequestFn;
}): MarketHttpGet {
  const {
    env,
    baseUrl = MARKET_BASE_URL,
    nodeVersion = process.versions.node,
    request = httpsRequest as RequestFn,
  } = options;
  return async (url, { maxBytes, timeoutMs = DEFAULT_TIMEOUT_MS }) => {
    if (!url.startsWith(baseUrl)) throw new MarketHttpError('url-not-allowed');
    const current = await env();
    if (disablesNodeTlsVerification(current) || disablesNodeTlsVerification(process.env)) {
      throw new MarketHttpError('tls-verification-disabled');
    }
    // proxyEnv 需 Node 24.5+ / 22.21+，旧版本配了代理也不能悄悄直连
    const [major = 0, minor = 0] = nodeVersion.split('.').map(Number);
    const supportsProxyEnv =
      major > 24 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
    if (
      !supportsProxyEnv &&
      (current.HTTPS_PROXY || current.https_proxy || current.ALL_PROXY || current.all_proxy)
    ) {
      throw new MarketHttpError('proxy-unsupported');
    }
    const proxyEnv = { ...current };
    if (!proxyEnv.https_proxy && !proxyEnv.HTTPS_PROXY) {
      proxyEnv.HTTPS_PROXY = proxyEnv.all_proxy || proxyEnv.ALL_PROXY;
    }
    const agent = new Agent({ proxyEnv, rejectUnauthorized: true });
    try {
      return await new Promise<Uint8Array>((resolve, reject) => {
        let settled = false;
        const finish = (error: Error | null, bytes?: Uint8Array) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve(bytes ?? new Uint8Array());
        };
        let req: ClientRequest;
        try {
          req = request(
            url,
            { method: 'GET', agent, timeout: timeoutMs, rejectUnauthorized: true },
            (res) => {
              const status = res.statusCode ?? 0;
              // 不跟随重定向：3xx 与其它非 200 一律当错误，只带状态码
              if (status !== 200) {
                res.resume();
                req.destroy();
                finish(new MarketHttpError(`http-${status}`));
                return;
              }
              const declared = Number(res.headers['content-length']);
              if (Number.isFinite(declared) && declared > maxBytes) {
                req.destroy();
                finish(new MarketHttpError('too-large'));
                return;
              }
              const chunks: Buffer[] = [];
              let size = 0;
              res.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > maxBytes) {
                  req.destroy();
                  finish(new MarketHttpError('too-large'));
                  return;
                }
                chunks.push(chunk);
              });
              res.on('end', () => finish(null, new Uint8Array(Buffer.concat(chunks))));
              res.on('error', () => finish(new MarketHttpError('response-error')));
            }
          );
        } catch (error) {
          finish(new MarketHttpError((error as NodeJS.ErrnoException).code ?? 'request-failed'));
          return;
        }
        req.on('timeout', () => {
          req.destroy();
          finish(new MarketHttpError('timeout'));
        });
        // 只取错误码，Node 的错误文本可能带主机与路径
        req.on('error', (error: NodeJS.ErrnoException) =>
          finish(new MarketHttpError(error.code ?? 'request-failed'))
        );
        req.end();
      });
    } finally {
      agent.destroy();
    }
  };
}
