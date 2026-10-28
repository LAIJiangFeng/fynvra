import { type ChildProcess, spawn } from 'node:child_process';
import { Agent, get } from 'node:https';
import { tmpdir } from 'node:os';
import {
  commandEnvironment,
  type NetworkProbeResult,
  type NetworkProxy,
  type NetworkTestResult,
} from '@shared/networkProxy';
import { killTree } from './orchestration/shellRunner';

export const NETWORK_TEST_TIMEOUT_MS = 15_000;
const API_URL = 'https://api.github.com/';
const GIT_URL = 'https://github.com/LAIJiangFeng/fynvra.git';

type Probe = (env: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<NetworkProbeResult>;
export interface NetworkTestDeps {
  api: Probe;
  git: Probe;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

/** A private agent honors only this command's environment; no global dispatcher or OS proxy. */
const probeApi: Probe = (env, signal) =>
  new Promise((resolve) => {
    // proxyEnv is available in Electron's Node 24.5+ (also Node 22.21+).
    // Older development runtimes must never silently test a direct connection instead.
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    if (!(major > 24 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21))) {
      resolve({ status: 'unavailable' });
      return;
    }
    let agent: Agent | undefined;
    try {
      const proxyEnv = { ...env };
      if (!proxyEnv.https_proxy && !proxyEnv.HTTPS_PROXY) {
        proxyEnv.HTTPS_PROXY = env.all_proxy || env.ALL_PROXY;
      }
      agent = new Agent({ proxyEnv, rejectUnauthorized: true });
      const request = get(
        API_URL,
        {
          agent,
          signal,
          rejectUnauthorized: true,
          headers: { 'User-Agent': 'Fynvra-network-check', Accept: 'application/vnd.github+json' },
        },
        (response) => {
          const httpStatus = response.statusCode ?? 0;
          // Even rate limiting proves HTTPS reachability, but is reported distinctly via the status code.
          resolve({ status: httpStatus >= 200 && httpStatus < 500 ? 'ok' : 'failed', httpStatus });
          response.destroy();
          agent?.destroy();
        }
      );
      request.on('error', () => {
        agent?.destroy();
        resolve({ status: 'failed' });
      });
    } catch {
      agent?.destroy();
      resolve({ status: 'failed' });
    }
  });

const probeGit: Probe = (env, signal) =>
  new Promise((resolve) => {
    let child: ChildProcess | undefined;
    let stdout = '';
    let settled = false;
    const cancel = () => {
      if (child) killTree(child);
      finish('failed');
    };
    const finish = (status: NetworkProbeResult['status']) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      resolve({ status });
    };
    try {
      child = spawn(
        'git',
        [
          '-c',
          'credential.helper=',
          '-c',
          'core.askPass=',
          '-c',
          'credential.interactive=false',
          '-c',
          'http.sslVerify=true',
          '-c',
          'http.proxySSLVerify=true',
          'ls-remote',
          '--exit-code',
          GIT_URL,
          'HEAD',
        ],
        {
          cwd: tmpdir(),
          env: {
            ...env,
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'never',
            GIT_ASKPASS: '',
            SSH_ASKPASS: '',
          },
          detached: process.platform !== 'win32',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        if (settled) return;
        stdout += chunk;
        if (stdout.length > 64 * 1024) cancel();
      });
      child.on('error', (error: NodeJS.ErrnoException) =>
        finish(error.code === 'ENOENT' ? 'unavailable' : 'failed')
      );
      child.on('close', (code) =>
        finish(code === 0 && /^[\da-f]+\s+HEAD\s*$/im.test(stdout) ? 'ok' : 'failed')
      );
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    } catch {
      finish('failed');
    }
  });

/** Never return stderr/exception messages: inherited configuration may contain credentials. */
export async function testCommandNetwork(
  config: NetworkProxy,
  cancel: AbortSignal,
  overrides: Partial<NetworkTestDeps> = {}
): Promise<NetworkTestResult> {
  const deps = {
    api: probeApi,
    git: probeGit,
    env: process.env,
    timeoutMs: NETWORK_TEST_TIMEOUT_MS,
    ...overrides,
  };
  const timeout = new AbortController();
  const signal = AbortSignal.any([cancel, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(), deps.timeoutMs);
  const interrupted = (): NetworkProbeResult | undefined =>
    cancel.aborted
      ? { status: 'canceled' }
      : timeout.signal.aborted
        ? { status: 'timeout' }
        : undefined;
  try {
    const env = commandEnvironment(deps.env, config, process.platform === 'win32');
    const run = async (probe: Probe): Promise<NetworkProbeResult> => {
      if (signal.aborted) return interrupted() ?? { status: 'canceled' };
      try {
        const result = await probe(env, signal);
        return interrupted() ?? result;
      } catch {
        return interrupted() ?? { status: 'failed' };
      }
    };
    const [api, git] = await Promise.all([run(deps.api), run(deps.git)]);
    return { api, git };
  } catch {
    return { api: { status: 'failed' }, git: { status: 'failed' } };
  } finally {
    clearTimeout(timer);
  }
}
