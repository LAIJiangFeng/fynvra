import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { lookup as dnsLookupAsync } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import type { LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { checkUrl, hostOf, isBlockedAddress } from './addressPolicy';

export const FETCH_TIMEOUT_MS = 30_000;
export const MAX_REDIRECTS = 5;
/** 解压后的正文上限 */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** 4xx/5xx 只读这么多用于摘录 */
const ERROR_BODY_BYTES = 64 * 1024;

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Fynvra/0.1';

/** 抓取失败：message 可直接给模型看，不含环境变量的值 */
export class FetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: Buffer,
    readonly contentType?: string
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

export interface FetchedPage {
  /** 最终 URL（跟随重定向之后） */
  url: string;
  /** 有重定向时的起始 URL */
  redirectedFrom?: string;
  status: number;
  contentType: string;
  body: Buffer;
  /** 正文超过 MAX_BODY_BYTES 被截断 */
  truncated: boolean;
}

/**
 * GET 一个页面：手动跟随重定向（每一跳重新校验地址），总超时 30 秒，响应 signal。
 * 直连时用自定义 lookup 只连接校验通过的地址；按 proxyEnv 走代理时先在本地解析目标做预检。
 * 不带 Cookie、认证头或调用方提供的任何请求头。
 */
export async function fetchPage(
  startUrl: URL,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<FetchedPage> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let url = startUrl;
  try {
    for (let hop = 0; ; hop++) {
      const response = await requestOnce(url, env, combined);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && status !== 304) {
        response.destroy();
        if (!location) throw new FetchError(`HTTP ${status} redirect without a Location header`);
        if (hop >= MAX_REDIRECTS) {
          throw new FetchError(`too many redirects (more than ${MAX_REDIRECTS})`);
        }
        let next: string;
        try {
          next = new URL(location, url).href;
        } catch {
          throw new FetchError(`HTTP ${status} redirect to an invalid Location`);
        }
        const check = checkUrl(next);
        if (!check.ok) throw new FetchError(`redirect to ${next} refused: ${check.error}`);
        url = check.url;
        continue;
      }
      const contentType = String(response.headers['content-type'] ?? '');
      if (status >= 400 || status < 200) {
        const { body } = await readBody(response, ERROR_BODY_BYTES);
        throw new FetchError(
          `HTTP ${status}${response.statusMessage ? ` ${response.statusMessage}` : ''}`,
          status,
          body,
          contentType
        );
      }
      const { body, truncated } = await readBody(response, MAX_BODY_BYTES);
      return {
        url: url.href,
        ...(url.href !== startUrl.href ? { redirectedFrom: startUrl.href } : {}),
        status,
        contentType,
        body,
        truncated,
      };
    }
  } catch (error) {
    if (signal?.aborted) throw new FetchError('the request was cancelled');
    if (timeout.aborted) {
      throw new FetchError(`the request timed out after ${FETCH_TIMEOUT_MS / 1000} seconds`);
    }
    throw toFetchError(error);
  }
}

type ProxyMode = { proxied: false } | { proxied: true; agentEnv: NodeJS.ProcessEnv };

/** 一次请求，不跟随重定向 */
async function requestOnce(
  url: URL,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal
): Promise<http.IncomingMessage> {
  const secure = url.protocol === 'https:';
  const mode = proxyMode(url, env);
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
  };
  let options: https.RequestOptions;
  if (mode.proxied) {
    // 代理模式：DNS 由代理解析，本地只能预检（残余风险）；本地解析失败则交给代理。
    // 每个请求一个 agent（keepAlive 默认关闭），连接不跨请求复用
    await precheckThroughProxy(url, signal);
    const agent = secure
      ? new https.Agent({ proxyEnv: mode.agentEnv, rejectUnauthorized: true })
      : new http.Agent({ proxyEnv: mode.agentEnv });
    options = { method: 'GET', headers, signal, agent, rejectUnauthorized: true };
  } else {
    // 直连：只连接 lookup 校验通过的地址，防 DNS rebinding；agent: false 不复用连接池里的旧连接
    options = {
      method: 'GET',
      headers,
      signal,
      agent: false,
      lookup: safeLookup,
      rejectUnauthorized: true,
    };
  }
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = secure
      ? https.request(url, options, resolve)
      : http.request(url, options, resolve);
    request.on('error', reject);
    request.end();
  });
}

/**
 * 是否走代理。HTTPS 取 HTTPS_PROXY，缺失时取 ALL_PROXY；HTTP 取 HTTP_PROXY，缺失时取 ALL_PROXY。
 * NO_PROXY 命中的目标按直连处理（仍做 lookup 校验）；交给 Node 的 env 去掉 NO_PROXY，
 * 避免 Node 自己判定直连而绕过 lookup 校验。
 */
function proxyMode(url: URL, env: NodeJS.ProcessEnv): ProxyMode {
  const get = (name: string) => envValue(env, name);
  const secure = url.protocol === 'https:';
  const proxy = (secure ? get('HTTPS_PROXY') : get('HTTP_PROXY')) || get('ALL_PROXY');
  if (!proxy) return { proxied: false };
  if (bypassesProxy(url, get('NO_PROXY'))) return { proxied: false };
  if (!supportsProxyEnv()) {
    throw new FetchError(
      'a network proxy is configured, but this runtime does not support proxied requests (needs Node 22.21+ or 24.5+); refusing to connect directly'
    );
  }
  if (disablesTlsVerification(env) || disablesTlsVerification(process.env)) {
    throw new FetchError(
      'NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS verification for the proxy connection; refusing to fetch'
    );
  }
  const agentEnv: NodeJS.ProcessEnv = {};
  if (secure) agentEnv.HTTPS_PROXY = proxy;
  else agentEnv.HTTP_PROXY = proxy;
  return { proxied: true, agentEnv };
}

/** 环境变量按名字大小写不敏感读取，小写优先（与 curl 一致） */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const lower = env[name.toLowerCase()];
  if (lower !== undefined && lower !== '') return lower.trim();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === name && value) return value.trim();
  }
  return undefined;
}

function bypassesProxy(url: URL, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const host = hostOf(url);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  for (const raw of noProxy.split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    const match = /^(.*?)(?::(\d+))?$/.exec(entry.replace(/^\[|\](?=:|$)/g, ''));
    let pattern = (match?.[1] ?? entry).replace(/^\*?\./, '.');
    if (match?.[2] && match[2] !== port) continue;
    if (pattern.startsWith('.')) {
      if (host.endsWith(pattern) || host === pattern.slice(1)) return true;
      continue;
    }
    pattern = pattern.replace(/\.$/, '');
    if (host === pattern || host.endsWith(`.${pattern}`)) return true;
  }
  return false;
}

/** proxyEnv 在 Electron 的 Node 24.5+（以及 Node 22.21+）可用；与 networkTest 的 probeApi 同一守卫 */
function supportsProxyEnv(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major > 24 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
}

function disablesTlsVerification(env: NodeJS.ProcessEnv): boolean {
  return Object.entries(env).some(
    ([key, value]) => key.toUpperCase() === 'NODE_TLS_REJECT_UNAUTHORIZED' && value === '0'
  );
}

/** 代理模式的本地预检：解析到被拦截的地址就拒绝；解析失败放行（交给代理解析） */
async function precheckThroughProxy(url: URL, signal: AbortSignal): Promise<void> {
  const host = hostOf(url);
  // IP 字面量已由 checkUrl 校验
  let addresses: LookupAddress[];
  try {
    addresses = await Promise.race([
      dnsLookupAsync(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    ]);
  } catch (error) {
    if (signal.aborted) throw error;
    return;
  }
  const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
  if (blocked) throw blockedError(host, blocked.address);
}

const BLOCKED_CODE = 'EFYNVRA_BLOCKED_ADDRESS';

function blockedError(host: string, address: string): FetchError {
  return new FetchError(
    `${host} resolves to ${address}, a local, private or reserved address; it cannot be fetched`
  );
}

/**
 * 直连的 lookup：解析全部地址，任何一个被拦截就整体拒绝，
 * 兼容 `all: true`（autoSelectFamily）与单地址两种回调形式。
 */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  const lookupOptions: LookupOptions & { all: true } = { ...options, all: true };
  dnsLookup(hostname, lookupOptions, (error, addresses) => {
    if (error) {
      callback(error, '', 0);
      return;
    }
    const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
    const first = addresses[0];
    if (blocked || !first) {
      const failure: FetchError & { code?: string } = blocked
        ? blockedError(hostname, blocked.address)
        : new FetchError(`${hostname} has no address`);
      failure.code = BLOCKED_CODE;
      callback(failure, '', 0);
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, first.address, first.family);
  });
};

/** 解压后按流计数；超过 limit 截断并停止读取（防解压炸弹） */
async function readBody(
  response: http.IncomingMessage,
  limit: number
): Promise<{ body: Buffer; truncated: boolean }> {
  const encoding = String(response.headers['content-encoding'] ?? '')
    .trim()
    .toLowerCase();
  let stream: Readable = response;
  if (encoding === 'gzip' || encoding === 'x-gzip') stream = response.pipe(createGunzip());
  else if (encoding === 'deflate') stream = response.pipe(createInflate());
  else if (encoding === 'br') stream = response.pipe(createBrotliDecompress());
  else if (encoding && encoding !== 'identity') {
    response.destroy();
    throw new FetchError(`unsupported Content-Encoding: ${encoding}`);
  }
  // 解压流的错误不会传回 response，反之亦然：两边都要监听
  if (stream !== response) response.on('error', (error) => stream.destroy(error));
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      if (size + buffer.length > limit) {
        chunks.push(buffer.subarray(0, limit - size));
        size = limit;
        truncated = true;
        break;
      }
      chunks.push(buffer);
      size += buffer.length;
    }
  } finally {
    response.destroy();
    if (stream !== response) stream.destroy();
  }
  return { body: Buffer.concat(chunks, size), truncated };
}

const NETWORK_ERRORS: Record<string, string> = {
  ENOTFOUND: 'the host name could not be resolved',
  EAI_AGAIN: 'the host name could not be resolved (temporary DNS failure)',
  ECONNREFUSED: 'the connection was refused',
  ECONNRESET: 'the connection was reset',
  ETIMEDOUT: 'the connection timed out',
  EHOSTUNREACH: 'the host is unreachable',
  ENETUNREACH: 'the network is unreachable',
  EPIPE: 'the connection was closed unexpectedly',
  ERR_STREAM_PREMATURE_CLOSE: 'the connection was closed before the response finished',
  Z_DATA_ERROR: 'the response could not be decompressed',
  Z_BUF_ERROR: 'the response could not be decompressed',
  ERR_PROXY_TUNNEL: 'the proxy refused or failed to open the connection',
  ERR_PROXY_INVALID_CONFIG: 'the network proxy setting is invalid',
};

/**
 * 网络错误 → 可读原因。只用错误码，不回显 Node 的原始消息：代理相关的消息可能带代理地址（含凭据）。
 */
function toFetchError(error: unknown): FetchError {
  if (error instanceof FetchError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === BLOCKED_CODE && error instanceof Error) return new FetchError(error.message);
  if (code && NETWORK_ERRORS[code]) return new FetchError(`${NETWORK_ERRORS[code]} (${code})`);
  if (code && /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) {
    return new FetchError(`TLS certificate verification failed (${code})`);
  }
  if (code) return new FetchError(`network error (${code})`);
  return new FetchError('network error');
}
