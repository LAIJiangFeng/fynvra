// 测试用的假实现（只被 *.test.ts 引用）：脚本化的 git exec、记录调用的 launcher、内存角色仓库。

import {
  BUILTIN_ROLES,
  type ExecFn,
  type ExecResult,
  type Role,
  type RoleStore,
} from '@fynvra/core';
import { type Mock, vi } from 'vitest';
import type { WorkerSessionLauncher } from './launcher';

export interface ExecCall {
  cmd: string;
  args: readonly string[];
  cwd: string;
}

/** 返回 `undefined` 表示交给默认应答。 */
export type ExecResponder = (call: ExecCall) => Partial<ExecResult> | undefined;

export interface FakeExec {
  exec: ExecFn;
  calls: ExecCall[];
  /** 追加一个应答规则；后加的优先。 */
  respond(responder: ExecResponder): void;
  /** 每次调用的 `git <args>` 文本，便于断言命令序列。 */
  commands(): string[];
}

export const BASE_COMMIT = 'base0000000000000000000000000000000000000';
export const MERGE_COMMIT = 'merge000000000000000000000000000000000000';

/** 一个「一切正常」的 git：干净的 worktree、仓库在 main、合并成功。 */
function defaultGit(args: readonly string[]): Partial<ExecResult> {
  const line = args.join(' ');
  if (line.startsWith('rev-parse --verify --quiet')) return { stdout: `${BASE_COMMIT}\n` };
  if (line === 'rev-parse HEAD') return { stdout: `${MERGE_COMMIT}\n` };
  if (line.startsWith('rev-list --left-right --count')) return { stdout: '0\t1\n' };
  if (line === 'symbolic-ref --quiet --short HEAD') return { stdout: 'main\n' };
  if (line.startsWith('diff --name-only -z')) return { stdout: 'src/a.ts\0' };
  if (line.includes('diff --no-color --no-ext-diff'))
    return { stdout: 'diff --git a/src/a.ts\n+x\n' };
  if (line.includes('diff --stat')) return { stdout: ' src/a.ts | 1 +\n 1 file changed\n' };
  return {};
}

export function createFakeExec(): FakeExec {
  const calls: ExecCall[] = [];
  const responders: ExecResponder[] = [];
  return {
    calls,
    respond: (responder) => {
      responders.unshift(responder);
    },
    commands: () => calls.map((call) => `${call.cmd} ${call.args.join(' ')}`),
    exec: async (cmd, args, cwd) => {
      const call = { cmd, args: [...args], cwd };
      calls.push(call);
      const scripted = responders.map((responder) => responder(call)).find(Boolean);
      return { code: 0, stdout: '', stderr: '', ...defaultGit(args), ...scripted };
    },
  };
}

type CreateInput = Parameters<WorkerSessionLauncher['createWorkerSession']>[0];

export interface FakeLauncher extends WorkerSessionLauncher {
  createWorkerSession: Mock<WorkerSessionLauncher['createWorkerSession']>;
  promptSession: Mock<WorkerSessionLauncher['promptSession']>;
  readTranscript: Mock<WorkerSessionLauncher['readTranscript']>;
  disposeSession: Mock<WorkerSessionLauncher['disposeSession']>;
  /** createWorkerSession 收到的入参，按调用顺序。 */
  created(): CreateInput[];
}

/** 会话 id 依次为 `session_w1`、`session_w2`…；transcript 默认空且已结束。 */
export function createFakeLauncher(): FakeLauncher {
  let next = 0;
  const launcher = {
    createWorkerSession: vi.fn(async (_input: CreateInput) => ({
      ok: true as const,
      sessionId: `session_w${++next}`,
    })),
    promptSession: vi.fn(async () => ({ ok: true as const })),
    readTranscript: vi.fn(async () => ({ ok: true as const, text: '', total: 0, done: true })),
    disposeSession: vi.fn(async () => {}),
    created: () => launcher.createWorkerSession.mock.calls.map(([input]) => input),
  };
  return launcher as FakeLauncher;
}

export const TESTER_ROLE: Role = {
  id: 'tester',
  name: '测试工程师',
  skillIds: [],
  mcpServerIds: [],
  tools: 'all',
  approvalMode: 'auto-edits',
};

/** 内置角色 + 一个自定义 `tester` 角色。 */
export function createFakeRoles(extra: Role[] = [TESTER_ROLE]): RoleStore {
  const all = [...BUILTIN_ROLES.map((role) => structuredClone(role)), ...extra];
  return {
    list: async () => all,
    get: async (id) => all.find((role) => role.id === id),
    save: async () => ({ ok: false, error: 'read-only' }),
    remove: async () => ({ ok: false, error: 'read-only' }),
  };
}
