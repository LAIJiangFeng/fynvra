import { asRecord } from './guards';

/**
 * Used by command/Git subprocesses and the built-in web reader (web_fetch); never by model/MCP/update
 * traffic.
 */
export type NetworkProxy =
  | { mode: 'system'; gitCompatibility: boolean }
  | { mode: 'environment'; gitCompatibility: boolean }
  | { mode: 'manual'; url: string; gitCompatibility: boolean };

/** Main 内部与会话 spec 用：system 模式可带 Main 解析出的系统代理地址（不落盘） */
export type ResolvedNetworkProxy =
  | NetworkProxy
  | { mode: 'system'; url: string; gitCompatibility: boolean };

export const DEFAULT_NETWORK_PROXY: NetworkProxy = {
  mode: 'system',
  gitCompatibility: false,
};

/** 系统代理下让本机服务直连 */
export const SYSTEM_NO_PROXY = 'localhost,127.0.0.1,::1';

/** No credentials, URL normalization surprises, paths, or arbitrary environment keys. */
function parseProxyUrl(raw: unknown): string | null {
  if (
    typeof raw !== 'string' ||
    raw.length > 2048 ||
    !/^https?:\/\/[^\s\\/?#@]+\/?$/i.test(raw) ||
    Array.from(raw).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return null;
  try {
    const url = new URL(raw);
    if (!url.hostname || url.username || url.password || url.port === '0') return null;
    // URL() accepts an empty port; reject it explicitly.
    if (/:\/?$/.test(raw)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const onlyKeys = (record: Record<string, unknown>, keys: string[]) =>
  Object.keys(record).every((key) => keys.includes(key));

/** settings.json / IPC 用：system 模式不接受地址字段。 */
export function parseNetworkProxy(raw: unknown): NetworkProxy | null {
  const record = asRecord(raw);
  if (!record || typeof record.gitCompatibility !== 'boolean') return null;
  const { mode, gitCompatibility } = record;
  if (mode === 'environment' || mode === 'system') {
    return onlyKeys(record, ['mode', 'gitCompatibility']) ? { mode, gitCompatibility } : null;
  }
  if (mode !== 'manual' || !onlyKeys(record, ['mode', 'url', 'gitCompatibility'])) return null;
  const url = parseProxyUrl(record.url);
  return url ? { mode, url, gitCompatibility } : null;
}

/** 会话 spec 用：另外接受 system 模式带上解析出的地址，校验同 manual。 */
export function parseResolvedNetworkProxy(raw: unknown): ResolvedNetworkProxy | null {
  const record = asRecord(raw);
  if (record?.mode !== 'system' || !('url' in record)) return parseNetworkProxy(raw);
  if (typeof record.gitCompatibility !== 'boolean') return null;
  if (!onlyKeys(record, ['mode', 'url', 'gitCompatibility'])) return null;
  const url = parseProxyUrl(record.url);
  return url ? { mode: 'system', url, gitCompatibility: record.gitCompatibility } : null;
}

/** 系统代理检测结果：unsupported 为 SOCKS（按直连处理），unknown 为还没查到或无法解析 */
export type SystemProxyStatus =
  | { kind: 'proxy'; url: string }
  | { kind: 'direct' }
  | { kind: 'unsupported' }
  | { kind: 'unknown' };

/** 把 Chromium resolveProxy 的结果（如 `PROXY 127.0.0.1:7890; DIRECT`）转成检测结果。 */
export function parseSystemProxy(resolved: string): SystemProxyStatus {
  let sawSocks = false;
  for (const entry of resolved.split(';')) {
    const [scheme = '', hostPort, ...rest] = entry.trim().split(/\s+/);
    const type = scheme.toUpperCase();
    if (type === 'DIRECT' && hostPort === undefined) {
      return sawSocks ? { kind: 'unsupported' } : { kind: 'direct' };
    }
    if (['SOCKS', 'SOCKS4', 'SOCKS5'].includes(type)) {
      sawSocks = true;
      continue;
    }
    if ((type !== 'PROXY' && type !== 'HTTPS') || !hostPort || rest.length) break;
    // 未加方括号的 IPv6：最后一个冒号后是端口
    const bare = /^([^[\]]*:[^[\]]*):(\d+)$/.exec(hostPort);
    const host = bare ? `[${bare[1]}]:${bare[2]}` : hostPort;
    const url = parseProxyUrl(`${type === 'HTTPS' ? 'https' : 'http'}://${host}`);
    return url ? { kind: 'proxy', url } : { kind: 'unknown' };
  }
  return sawSocks ? { kind: 'unsupported' } : { kind: 'unknown' };
}

/** 检测结果 + 设置 → 实际生效的配置；只有 system 模式且检测到代理时才带地址。 */
export function resolveNetworkProxy(
  config: NetworkProxy | undefined,
  system: SystemProxyStatus
): ResolvedNetworkProxy {
  const effective = config ?? DEFAULT_NETWORK_PROXY;
  return effective.mode === 'system' && system.kind === 'proxy'
    ? { ...effective, url: system.url }
    : effective;
}

export type CommandEnvironment = Record<string, string | undefined>;

/** Append without overwriting inherited Git config slots or exposing their values in errors. */
export function appendGitConfig(
  base: CommandEnvironment,
  entries: readonly (readonly [string, string])[],
  caseInsensitive = false
): CommandEnvironment {
  const env = { ...base };
  if (!entries.length) return env;
  if (caseInsensitive) {
    for (const key of Object.keys(env)) {
      if (!/^git_config_(count|parameters|key_\d+|value_\d+)$/i.test(key)) continue;
      const canonical = key.toUpperCase();
      if (key === canonical) continue;
      if (canonical in env && env[canonical] !== env[key]) {
        throw new Error('Ambiguous inherited Git command configuration.');
      }
      env[canonical] = env[key];
      delete env[key];
    }
  }
  const countText = env.GIT_CONFIG_COUNT ?? '0';
  const count = Number(countText);
  if (!/^\d+$/.test(countText) || !Number.isSafeInteger(count) || count > 10000) {
    throw new Error('Invalid inherited Git command configuration.');
  }
  for (let index = 0; index < count; index++) {
    if (!env[`GIT_CONFIG_KEY_${index}`] || env[`GIT_CONFIG_VALUE_${index}`] === undefined) {
      throw new Error('Incomplete inherited Git command configuration.');
    }
  }
  // Preserve unused inherited slots too: relocate them beyond the new active range.
  const end = count + entries.length;
  let spare = end;
  for (let index = count; index < end; index++) {
    if (`GIT_CONFIG_KEY_${index}` in env || `GIT_CONFIG_VALUE_${index}` in env) {
      while (`GIT_CONFIG_KEY_${spare}` in env || `GIT_CONFIG_VALUE_${spare}` in env) spare++;
      for (const prefix of ['GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_']) {
        if (`${prefix}${index}` in env) env[`${prefix}${spare}`] = env[`${prefix}${index}`];
        delete env[`${prefix}${index}`];
      }
      spare++;
    }
  }
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${count + index}`] = key;
    env[`GIT_CONFIG_VALUE_${count + index}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(end);
  // Git reads GIT_CONFIG_PARAMETERS after the numbered entries. Preserve it verbatim,
  // then append our values using Git's single-quote format (this is never a shell command).
  if (env.GIT_CONFIG_PARAMETERS) {
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    env.GIT_CONFIG_PARAMETERS += ` ${entries.map(([key, value]) => quote(`${key}=${value}`)).join(' ')}`;
  }
  return env;
}

/** Pure per-spawn transformation. Unconfigured behavior is exactly the inherited environment. */
export function commandEnvironment(
  base: CommandEnvironment,
  config?: ResolvedNetworkProxy,
  caseInsensitive = false
): CommandEnvironment {
  let env = { ...base };
  const git: [string, string][] = [];
  // system 模式没有解析出地址（直连 / SOCKS / 未知）时继承原环境
  if (config && 'url' in config) {
    // Remove all casing variants (Windows environment keys are case-insensitive).
    for (const key of Object.keys(env)) {
      if (['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].includes(key.toLowerCase())) {
        delete env[key];
      }
    }
    env.HTTP_PROXY = env.http_proxy = config.url;
    env.HTTPS_PROXY = env.https_proxy = config.url;
    env.NO_PROXY = env.no_proxy = config.mode === 'system' ? SYSTEM_NO_PROXY : '';
    git.push(['http.proxy', config.url]);
  }
  if (config?.gitCompatibility) {
    git.push(['http.version', 'HTTP/1.1'], ['protocol.version', '0']);
  }
  env = appendGitConfig(env, git, caseInsensitive);
  return env;
}

export type NetworkProbeStatus = 'ok' | 'failed' | 'timeout' | 'canceled' | 'unavailable';
export interface NetworkProbeResult {
  status: NetworkProbeStatus;
  httpStatus?: number;
}
export interface NetworkTestResult {
  api: NetworkProbeResult;
  git: NetworkProbeResult;
}
