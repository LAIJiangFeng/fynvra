import { asRecord } from './guards';

/** Only command subprocesses use this setting; never model/MCP/update traffic. */
export type NetworkProxy =
  | { mode: 'environment'; gitCompatibility: boolean }
  | { mode: 'manual'; url: string; gitCompatibility: boolean };

export const DEFAULT_NETWORK_PROXY: NetworkProxy = {
  mode: 'environment',
  gitCompatibility: false,
};

/** No credentials, URL normalization surprises, paths, or arbitrary environment keys. */
export function parseNetworkProxy(raw: unknown): NetworkProxy | null {
  const record = asRecord(raw);
  if (!record || typeof record.gitCompatibility !== 'boolean') return null;
  const { mode, gitCompatibility } = record;
  if (mode === 'environment') {
    return Object.keys(record).every((key) => ['mode', 'gitCompatibility'].includes(key))
      ? { mode, gitCompatibility }
      : null;
  }
  if (
    mode !== 'manual' ||
    Object.keys(record).some((key) => !['mode', 'url', 'gitCompatibility'].includes(key)) ||
    typeof record.url !== 'string' ||
    record.url.length > 2048 ||
    !/^https?:\/\/[^\s\\/?#@]+\/?$/i.test(record.url) ||
    Array.from(record.url).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return null;
  try {
    const url = new URL(record.url);
    if (!url.hostname || url.username || url.password || url.port === '0') return null;
    // URL() accepts an empty port; reject it explicitly.
    if (/:\/?$/.test(record.url)) return null;
    return { mode, url: url.origin, gitCompatibility };
  } catch {
    return null;
  }
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
  config?: NetworkProxy,
  caseInsensitive = false
): CommandEnvironment {
  let env = { ...base };
  const git: [string, string][] = [];
  if (config?.mode === 'manual') {
    // Remove all casing variants (Windows environment keys are case-insensitive).
    for (const key of Object.keys(env)) {
      if (['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].includes(key.toLowerCase())) {
        delete env[key];
      }
    }
    env.HTTP_PROXY = env.http_proxy = config.url;
    env.HTTPS_PROXY = env.https_proxy = config.url;
    env.NO_PROXY = env.no_proxy = '';
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
