import { parseSystemProxy, type SystemProxyStatus } from '@shared/networkProxy';

/** 统一按这个地址解析一次系统代理（不做 PAC 按目标逐个解析） */
export const SYSTEM_PROXY_PROBE_URL = 'https://github.com';
const STALE_MS = 5_000;
const INTERVAL_MS = 10_000;
const STARTUP_WAIT_MS = 3_000;

export interface SystemProxyDeps {
  /** 生产环境为 session.defaultSession.resolveProxy */
  resolve(url: string): Promise<string>;
  now?(): number;
  log?(message: string): void;
}

export interface SystemProxyResolver {
  /** 同步读取缓存的当前结果 */
  current(): SystemProxyStatus;
  /** 缓存超过 5 秒才刷新，否则直接返回缓存 */
  fresh(): Promise<SystemProxyStatus>;
  /** 启动：先刷新一次（最多等 3 秒，超时照常返回），之后每 10 秒后台刷新 */
  start(): Promise<void>;
  stop(): void;
}

export function createSystemProxyResolver(deps: SystemProxyDeps): SystemProxyResolver {
  const now = deps.now ?? Date.now;
  let status: SystemProxyStatus = { kind: 'unknown' };
  let updatedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<SystemProxyStatus> | null = null;
  let failing = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const refresh = (): Promise<SystemProxyStatus> => {
    inFlight ??= deps
      .resolve(SYSTEM_PROXY_PROBE_URL)
      .then((raw) => {
        status = parseSystemProxy(raw);
        failing = false;
        return status;
      })
      .catch((error: unknown) => {
        // 失败保留上一次的结果；连续失败只记一次，不刷屏
        if (!failing) {
          failing = true;
          deps.log?.(
            `system proxy resolve failed: ${error instanceof Error ? error.name : 'error'}`
          );
        }
        return status;
      })
      .finally(() => {
        updatedAt = now();
        inFlight = null;
      });
    return inFlight;
  };

  return {
    current: () => status,
    fresh: () => (now() - updatedAt > STALE_MS ? refresh() : Promise.resolve(status)),
    async start() {
      if (!timer) {
        timer = setInterval(() => void refresh(), INTERVAL_MS);
        timer.unref?.();
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        refresh(),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, STARTUP_WAIT_MS);
        }),
      ]);
      clearTimeout(timeout);
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}

let instance: SystemProxyResolver | null = null;

/** Main 启动时登记生产解析器；未登记时（测试、启动前）一律视为未知，继承原环境 */
export function setSystemProxy(resolver: SystemProxyResolver | null): void {
  instance = resolver;
}

export function getSystemProxy(): SystemProxyResolver | null {
  return instance;
}
