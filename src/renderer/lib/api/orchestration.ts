import type { Dispatch, Message, Run, Task, Worktree } from '@fynvra/core';
import type { IpcResult } from '@shared/types/ipc';
import type {
  ChangesActionInput,
  ChangesActionResult,
  OrchestrationSnapshotView,
  SessionChanges,
  SessionChangesInput,
} from '@shared/types/orchestration';
import type { FynvraApi, Unsubscribe } from '../../../preload/types';
import { translate } from '../../i18n';

export type { OrchestrationSnapshotView };

/** `window.fynvra.orchestration`（ARCHITECTURE §9.4）。 */
export interface OrchestrationApi {
  changes(input: SessionChangesInput): Promise<IpcResult<SessionChanges>>;
  changesAction(input: ChangesActionInput): Promise<IpcResult<ChangesActionResult>>;
  snapshot(workspaceId: string): Promise<IpcResult<OrchestrationSnapshotView>>;
  /** 读 dispatch 对应 worker 会话的输出（与 read_worker_output 同源） */
  readWorkerOutput(input: {
    dispatchId: string;
    cursor: number;
  }): Promise<IpcResult<{ text: string; total: number; done: boolean }>>;
  reviewDiff(dispatchId: string): Promise<
    IpcResult<{
      branch: string;
      baseCommit: string;
      files: string[];
      stat: string;
      diff: string;
      /** worker worktree 相对 HEAD 的工作区改动；worktree 已删除时 available 为 false */
      uncommitted: { available: boolean; files: string[]; diff: string };
      /** base..branch 的提交，新的在前 */
      commits: { sha: string; subject: string; author: string; date: string }[];
    }>
  >;
  onChanged(cb: (workspaceId: string) => void): Unsubscribe;
}

/** readWorkerOutput 成功时的一页：`text` 从 cursor 开始（可能被截断），`total` 是输出总长度。 */
export type WorkerOutputPage = Extract<
  Awaited<ReturnType<OrchestrationApi['readWorkerOutput']>>,
  { ok: true }
>;
/** reviewDiff 成功时的结果。 */
export type ReviewDiffView = Extract<
  Awaited<ReturnType<OrchestrationApi['reviewDiff']>>,
  { ok: true }
>;

/** Renderer 里 globalThis 就是 window；不直接写 window，node 下的测试才能 import 本文件。 */
function bridge(): OrchestrationApi | undefined {
  return (globalThis as { fynvra?: Partial<FynvraApi> }).fynvra?.orchestration;
}

// --- 演示开关 -------------------------------------------------------------------------------

const DEMO_FLAG = 'fynvra.orchestration.demo';

interface FlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function sessionFlags(): FlagStorage | undefined {
  try {
    return (globalThis as { sessionStorage?: FlagStorage }).sessionStorage;
  } catch {
    // 受限环境里读取 sessionStorage 本身会抛 SecurityError
    return undefined;
  }
}

/** 开发模式下面板上的「演示数据」开关：存 sessionStorage，只对当前窗口有效，关窗即失效。 */
export function isOrchestrationDemo(): boolean {
  try {
    return sessionFlags()?.getItem(DEMO_FLAG) === '1';
  } catch {
    return false;
  }
}

/** 改了开关要重新加载页面：数据源在 store 创建时就定下了。 */
export function setOrchestrationDemo(enabled: boolean): void {
  try {
    const flags = sessionFlags();
    if (enabled) flags?.setItem(DEMO_FLAG, '1');
    else flags?.removeItem(DEMO_FLAG);
  } catch {
    // 存不下就保持原样
  }
}

let sharedMock: OrchestrationApi | null = null;

/**
 * 编排面板的数据源：preload 暴露的 `window.fynvra.orchestration`。
 * 不存在（纯浏览器预览、node 测试）或打开了演示开关时，返回内存 mock。
 */
export function getOrchestrationApi(): OrchestrationApi {
  const real = bridge();
  if (real && !isOrchestrationDemo()) return real;
  sharedMock ??= createMockOrchestrationApi();
  return sharedMock;
}

/** {@link getOrchestrationApi} 此刻给出的是不是内存 mock。 */
export function usingOrchestrationMock(): boolean {
  return bridge() === undefined || isOrchestrationDemo();
}

// --- 内存 mock ------------------------------------------------------------------------------
// 1 个 Run、3 个 Task：completed（worktree 已清理）、in-progress（滚动输出，中途提问，
// 约 62s 后结算为 in-review）、in-review（两次尝试，带假 diff）。进度按创建后经过的时间计算。

export interface MockOrchestrationOptions {
  /** 时钟（epoch ms），默认 `Date.now` */
  now?: () => number;
  /** 模拟 IPC 往返延迟，默认 120ms；测试传 0 */
  latencyMs?: number;
  /** readWorkerOutput 每次最多返回的字符数（让 cursor 分页真的发生），默认 2048 */
  pageChars?: number;
}

const MINUTE = 60_000;
/** 进行中任务的脚本时刻（相对 mock 创建，ms） */
export const MOCK_TIMELINE = { ask: 12_000, reply: 18_000, commit: 55_500, settle: 62_000 };

const COORDINATOR = 'session_demo_coordinator';
const RUN_ID = 'run_demo';
const TASK_FILTER = 'task_demofilter';
const TASK_SEARCH = 'task_demosearch';
const TASK_TESTS = 'task_demotests';
const DISPATCH_FILTER = 'dispatch_demofilter1';
const DISPATCH_SEARCH = 'dispatch_demosearch1';
const DISPATCH_TESTS_1 = 'dispatch_demotests1';
const DISPATCH_TESTS_2 = 'dispatch_demotests2';
const WORKER_FILTER = 'session_demo_filter';
const WORKER_SEARCH = 'session_demo_search';
const WORKER_TESTS = 'session_demo_tests';
const BASE_COMMIT = '4f1c2ab9e07d5c3a8b61f0e2d9c4b7a6e5f30812';

export const MOCK_IDS = {
  run: RUN_ID,
  tasks: { completed: TASK_FILTER, inProgress: TASK_SEARCH, inReview: TASK_TESTS },
  dispatches: {
    completed: DISPATCH_FILTER,
    inProgress: DISPATCH_SEARCH,
    inReview: DISPATCH_TESTS_2,
    rejected: DISPATCH_TESTS_1,
  },
} as const;

export function createMockOrchestrationApi(
  options: MockOrchestrationOptions = {}
): OrchestrationApi {
  const now = options.now ?? Date.now;
  const latency = options.latencyMs ?? 120;
  const pageChars = options.pageChars ?? 2048;
  const start = now();
  const elapsed = () => now() - start;
  const listeners = new Set<(workspaceId: string) => void>();
  const workspaces = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const respond = <T>(value: T): Promise<T> =>
    latency <= 0
      ? Promise.resolve(value)
      : new Promise((resolve) => setTimeout(() => resolve(value), latency));

  // 脚本事件到点时推送 changed，面板据此重新拉快照
  const schedule = () => {
    if (timer !== null || listeners.size === 0) return;
    const at = [MOCK_TIMELINE.ask, MOCK_TIMELINE.reply, MOCK_TIMELINE.settle].find(
      (event) => event > elapsed()
    );
    if (at === undefined) return;
    timer = setTimeout(() => {
      timer = null;
      for (const workspaceId of workspaces) {
        for (const listener of [...listeners]) listener(workspaceId);
      }
      schedule();
    }, at - elapsed());
  };

  return {
    changes({ sessionId }) {
      if (sessionId === WORKER_FILTER)
        return respond({
          ok: true,
          availability: 'worktree-removed',
          branch: '',
          headCommit: null,
          baseCommit: '',
          comparison: { kind: 'unborn' },
          files: [],
          stat: '',
          diff: '',
          uncommitted: { available: false, files: [], diff: '' },
          commits: [],
        });
      const testsWorker = sessionId === WORKER_TESTS;
      const worker = testsWorker || sessionId === WORKER_SEARCH;
      return respond({
        ok: true,
        availability: 'available',
        branch: testsWorker ? 'fynvra/filter-tests' : worker ? 'fynvra/sidebar-search' : 'main',
        headCommit:
          (testsWorker ? testsCommits(start)[0]?.sha : searchCommits(start)[0]?.sha) ?? BASE_COMMIT,
        baseCommit: BASE_COMMIT,
        comparison: { kind: worker ? 'worker-base' : 'latest-commit' },
        ...(testsWorker ? testsDiff() : searchDiff()),
        uncommitted: {
          available: true,
          ...(testsWorker ? testsUncommitted() : { files: [], diff: '' }),
        },
        commits: testsWorker ? testsCommits(start) : searchCommits(start),
      });
    },
    changesAction() {
      return respond({ ok: false, error: translate('orchestration.changesDemoUnavailable') });
    },
    snapshot(workspaceId) {
      workspaces.add(workspaceId);
      schedule();
      return respond({ ok: true, ...demoView(workspaceId, start, elapsed()) });
    },

    readWorkerOutput({ dispatchId, cursor }) {
      const transcript = demoTranscript(dispatchId, elapsed());
      if (!transcript) return respond({ ok: false, error: `unknown dispatch ${dispatchId}` });
      const from = Math.min(Math.max(0, Math.floor(cursor)), transcript.text.length);
      return respond({
        ok: true,
        text: transcript.text.slice(from, from + pageChars),
        total: transcript.text.length,
        done: transcript.done,
      });
    },

    reviewDiff(dispatchId) {
      if (dispatchId === DISPATCH_FILTER) {
        return respond({
          ok: false,
          error: `the worktree of dispatch ${dispatchId} was already cleaned up`,
        });
      }
      if (dispatchId === DISPATCH_SEARCH) {
        const committed = elapsed() >= MOCK_TIMELINE.commit;
        return respond({
          ok: true,
          branch: 'fynvra/sidebar-search',
          baseCommit: BASE_COMMIT,
          ...(committed ? searchDiff() : { files: [], stat: '', diff: '' }),
          uncommitted: committed
            ? { available: true, files: [], diff: '' }
            : { available: true, files: searchDiff().files, diff: searchDiff().diff },
          commits: committed ? searchCommits(start) : [],
        });
      }
      if (dispatchId === DISPATCH_TESTS_1 || dispatchId === DISPATCH_TESTS_2) {
        return respond({
          ok: true,
          branch: 'fynvra/filter-tests',
          baseCommit: BASE_COMMIT,
          ...testsDiff(),
          uncommitted: {
            available: true,
            files: testsUncommitted().files,
            diff: testsUncommitted().diff,
          },
          commits: testsCommits(start),
        });
      }
      return respond({ ok: false, error: `unknown dispatch ${dispatchId}` });
    },

    onChanged(callback) {
      listeners.add(callback);
      schedule();
      return () => {
        listeners.delete(callback);
        if (listeners.size === 0 && timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
    },
  };
}

function demoView(workspaceId: string, start: number, t: number): OrchestrationSnapshotView {
  const at = (offset: number) => start + offset;
  const settled = t >= MOCK_TIMELINE.settle;
  const run: Run = {
    id: RUN_ID,
    workspaceId,
    coordinatorSessionId: COORDINATOR,
    objective: '给侧栏工作区列表加搜索，并补齐过滤逻辑的测试',
    createdAt: at(-26 * MINUTE),
  };
  const tasks: Task[] = [
    {
      id: TASK_FILTER,
      runId: RUN_ID,
      title: '抽出工作区过滤纯函数 filterWorkspaces',
      spec: FILTER_SPEC,
      roleId: 'worker',
      status: 'completed',
      dependsOn: [],
    },
    {
      id: TASK_SEARCH,
      runId: RUN_ID,
      title: '侧栏加搜索框并接入过滤',
      spec: SEARCH_SPEC,
      roleId: 'fullstack-dev',
      status: settled ? 'in-review' : 'in-progress',
      dependsOn: [TASK_FILTER],
    },
    {
      id: TASK_TESTS,
      runId: RUN_ID,
      title: '为过滤逻辑补边界测试',
      spec: TESTS_SPEC,
      roleId: 'test-engineer',
      status: 'in-review',
      dependsOn: [TASK_FILTER],
    },
  ];

  const search: Dispatch = {
    id: DISPATCH_SEARCH,
    taskId: TASK_SEARCH,
    workerSessionId: WORKER_SEARCH,
    worktreeId: 'worktree_demosearch',
    branch: 'fynvra/sidebar-search',
    startedAt: at(-3 * MINUTE),
  };
  if (settled) {
    Object.assign(search, {
      settledAt: at(MOCK_TIMELINE.settle),
      outcome: 'succeeded',
      summary: SEARCH_SUMMARY,
      filesModified: SEARCH_FILES,
    });
  }
  const dispatches: Dispatch[] = [
    {
      id: DISPATCH_FILTER,
      taskId: TASK_FILTER,
      workerSessionId: WORKER_FILTER,
      worktreeId: 'worktree_demofilter',
      branch: 'fynvra/filter-workspaces',
      startedAt: at(-25 * MINUTE),
      settledAt: at(-19 * MINUTE),
      outcome: 'succeeded',
      summary: FILTER_SUMMARY,
      filesModified: FILTER_FILES,
    },
    {
      id: DISPATCH_TESTS_1,
      taskId: TASK_TESTS,
      workerSessionId: WORKER_TESTS,
      worktreeId: 'worktree_demotests',
      branch: 'fynvra/filter-tests',
      startedAt: at(-17 * MINUTE),
      settledAt: at(-13 * MINUTE),
      outcome: 'succeeded',
      summary: '补了 6 个用例：大小写、前后空格、路径匹配、无结果。',
      filesModified: ['src/renderer/lib/filterWorkspaces.test.ts'],
    },
    {
      id: DISPATCH_TESTS_2,
      taskId: TASK_TESTS,
      workerSessionId: WORKER_TESTS,
      worktreeId: 'worktree_demotests',
      branch: 'fynvra/filter-tests',
      startedAt: at(-11 * MINUTE),
      settledAt: at(-6 * MINUTE),
      outcome: 'succeeded',
      summary: TESTS_SUMMARY,
      filesModified: testsDiff().files,
    },
    search,
  ];

  const worktrees: Worktree[] = [
    {
      id: 'worktree_demosearch',
      workspaceId,
      path: `/demo/worktrees/${workspaceId}/sidebar-search`,
      branch: 'fynvra/sidebar-search',
      baseRef: 'main',
      baseCommit: BASE_COMMIT,
    },
    {
      id: 'worktree_demotests',
      workspaceId,
      path: `/demo/worktrees/${workspaceId}/filter-tests`,
      branch: 'fynvra/filter-tests',
      baseRef: 'main',
      baseCommit: BASE_COMMIT,
    },
  ];

  const toCoordinator = (dispatchId: string, from: string) => ({
    runId: RUN_ID,
    dispatchId,
    from,
    to: COORDINATOR,
  });
  const toWorker = (dispatchId: string, to: string) => ({
    runId: RUN_ID,
    dispatchId,
    from: COORDINATOR,
    to,
  });
  const messages: Message[] = [
    {
      id: 'msg_demo1',
      ...toCoordinator(DISPATCH_FILTER, WORKER_FILTER),
      type: 'worker_done',
      subject: 'succeeded',
      body: report(FILTER_SUMMARY, FILTER_FILES),
      createdAt: at(-19 * MINUTE),
      ackedAt: at(-19 * MINUTE + 4_000),
    },
    {
      id: 'msg_demo2',
      ...toCoordinator(DISPATCH_TESTS_1, WORKER_TESTS),
      type: 'worker_done',
      subject: 'succeeded',
      body: report('补了 6 个用例：大小写、前后空格、路径匹配、无结果。', [
        'src/renderer/lib/filterWorkspaces.test.ts',
      ]),
      createdAt: at(-13 * MINUTE),
      ackedAt: at(-13 * MINUTE + 3_000),
    },
    {
      id: 'msg_demo3',
      ...toWorker(DISPATCH_TESTS_2, WORKER_TESTS),
      type: 'instruction',
      subject: 'review feedback',
      body: REVIEW_FEEDBACK,
      createdAt: at(-11 * MINUTE),
      ackedAt: at(-11 * MINUTE),
    },
    {
      id: 'msg_demo4',
      ...toCoordinator(DISPATCH_TESTS_2, WORKER_TESTS),
      type: 'worker_done',
      subject: 'succeeded',
      body: report(TESTS_SUMMARY, testsDiff().files),
      createdAt: at(-6 * MINUTE),
    },
  ];
  if (t >= MOCK_TIMELINE.ask) {
    messages.push({
      id: 'msg_demo5',
      ...toCoordinator(DISPATCH_SEARCH, WORKER_SEARCH),
      type: 'question',
      body: SEARCH_QUESTION,
      createdAt: at(MOCK_TIMELINE.ask),
      ...(t >= MOCK_TIMELINE.reply ? { ackedAt: at(MOCK_TIMELINE.reply) } : {}),
    });
  }
  if (t >= MOCK_TIMELINE.reply) {
    messages.push({
      id: 'msg_demo6',
      ...toWorker(DISPATCH_SEARCH, WORKER_SEARCH),
      type: 'reply',
      body: SEARCH_ANSWER,
      replyTo: 'msg_demo5',
      createdAt: at(MOCK_TIMELINE.reply),
    });
  }
  if (settled) {
    messages.push({
      id: 'msg_demo7',
      ...toCoordinator(DISPATCH_SEARCH, WORKER_SEARCH),
      type: 'worker_done',
      subject: 'succeeded',
      body: report(SEARCH_SUMMARY, SEARCH_FILES),
      createdAt: at(MOCK_TIMELINE.settle),
    });
  }

  return { runs: [run], tasks, dispatches, worktrees, messages };
}

/** 与 Main 的 worker_done 正文格式一致（workerHost 的 describeReport）。 */
function report(summary: string, files: readonly string[]): string {
  return `${summary}\n\nFiles modified (${files.length}):\n${files.map((file) => `- ${file}`).join('\n')}`;
}

function demoTranscript(dispatchId: string, t: number): { text: string; done: boolean } | null {
  if (dispatchId === DISPATCH_FILTER) return { text: FILTER_TRANSCRIPT, done: true };
  if (dispatchId === DISPATCH_TESTS_1 || dispatchId === DISPATCH_TESTS_2) {
    return { text: TESTS_TRANSCRIPT, done: true };
  }
  if (dispatchId !== DISPATCH_SEARCH) return null;
  const text = SEARCH_SCRIPT.filter(([offset]) => offset <= t)
    .map(([, chunk]) => chunk)
    .join('');
  return { text, done: t >= MOCK_TIMELINE.settle };
}

// --- 演示数据 -------------------------------------------------------------------------------

const FILTER_SPEC = `## Target
把 Sidebar 里内联的工作区过滤逻辑抽成纯函数 \`filterWorkspaces(list, query)\`。

## Change
- 新建 \`src/renderer/lib/filterWorkspaces.ts\`：名称与展示路径都参与匹配，忽略大小写
- Sidebar 改为调用它，行为不变

## Constraints
- 纯函数，不碰 DOM、不读 store

## Acceptance
- 新增单测覆盖名称 / 路径匹配
- \`pnpm typecheck && pnpm lint && pnpm test\` 通过`;

const SEARCH_SPEC = `## Target
侧栏工作区列表加搜索框，输入即过滤。

## Change
- 新建 \`WorkspaceSearch.tsx\`，复用 \`filterWorkspaces\`
- Esc 清空输入；没有匹配时显示「没有匹配的工作区」

## Constraints
- 只用 \`components/ui\` 封装
- 不改 \`stores/workspaces.ts\` 的公开接口

## Acceptance
- \`pnpm typecheck && pnpm lint && pnpm test\` 通过`;

const TESTS_SPEC = `## Target
给 \`filterWorkspaces\` 补边界测试。

## Change
- 空查询、全角空格、大小写、路径分隔符、无结果
- 大列表（600 项）用 fixture

## Ownership
只改 \`src/renderer/lib/**\` 与 \`docs/TESTING.md\`

## Acceptance
- \`pnpm test\` 通过，且新用例在改动前能失败`;

const FILTER_SUMMARY =
  '新增 filterWorkspaces(list, query)：名称与展示路径都参与匹配，忽略大小写；Sidebar 改为调用它，行为不变。';
const FILTER_FILES = [
  'src/renderer/lib/filterWorkspaces.ts',
  'src/renderer/lib/filterWorkspaces.test.ts',
  'src/renderer/components/layout/Sidebar.tsx',
];
const SEARCH_SUMMARY =
  '工作区列表顶部加了 sticky 搜索框，输入即过滤，Esc 清空；typecheck / lint / test 全部通过。';
const SEARCH_FILES = [
  'src/renderer/components/layout/WorkspaceSearch.tsx',
  'src/renderer/components/layout/Sidebar.tsx',
];
const TESTS_SUMMARY =
  '按反馈补了空查询与全角空格用例，去掉对 Intl.Collator 的依赖；新增 600 项 fixture，删掉旧的 legacyFilter。';
const REVIEW_FEEDBACK =
  '空查询和全角空格的用例缺了；另外别依赖 Intl.Collator 的本地化排序，CI 的 locale 不一定是 zh-CN。';
const SEARCH_QUESTION = '搜索框放在侧栏标题下面，还是工作区列表顶部？列表滚动时要不要固定？';
const SEARCH_ANSWER = '放在列表顶部并保持 sticky；Esc 清空输入。';

const FILTER_TRANSCRIPT = [
  '[user] Task brief (dispatch `dispatch_demofilter1`): # 抽出工作区过滤纯函数 filterWorkspaces ## Target 把 Sidebar 里内联的工作区过滤逻辑抽成纯函数 …',
  '先找到 Sidebar 里现在的过滤写法。',
  '[tool] grep {"pattern":"toLowerCase","path":"src/renderer/components/layout"}',
  '[tool done] grep: src/renderer/components/layout/Sidebar.tsx:41: workspace.name.toLowerCase().includes(query.toLowerCase())',
  '[tool] read {"path":"src/renderer/components/layout/Sidebar.tsx"}',
  "[tool done] read: import { FolderGit2, Plus } from 'lucide-react'; import { Button } from '@/components/ui/button'; …",
  '逻辑只看名称，任务书要求路径也参与匹配。先写测试。',
  '[tool] write {"path":"src/renderer/lib/filterWorkspaces.test.ts"}',
  '[tool done] write: Successfully wrote 1630 bytes to src/renderer/lib/filterWorkspaces.test.ts',
  '[tool] bash {"command":"pnpm vitest run src/renderer/lib"}',
  '[tool error] bash: FAIL src/renderer/lib/filterWorkspaces.test.ts Error: Failed to resolve import "./filterWorkspaces"',
  '红了，符合预期。写实现。',
  '[tool] write {"path":"src/renderer/lib/filterWorkspaces.ts"}',
  '[tool done] write: Successfully wrote 702 bytes to src/renderer/lib/filterWorkspaces.ts',
  '[tool] edit {"path":"src/renderer/components/layout/Sidebar.tsx","edits":[{"oldText":"workspaces.filter(","newText":"filterWorkspaces(workspaces, query)"}]}',
  '[tool done] edit: Successfully replaced 1 block(s) in src/renderer/components/layout/Sidebar.tsx.',
  '[tool] bash {"command":"pnpm typecheck && pnpm lint && pnpm test"}',
  '[tool done] bash: Checked 239 files in 112ms. No fixes applied. … Test Files 78 passed (78) Tests 978 passed (978)',
  '[tool] bash {"command":"git add -A && git commit -m \\"refactor(renderer): extract filterWorkspaces\\""}',
  '[tool done] bash: [fynvra/filter-workspaces 2b9d0c4] refactor(renderer): extract filterWorkspaces 3 files changed, 61 insertions(+), 9 deletions(-)',
  `${FILTER_SUMMARY}`,
  '[tool] report_done {"outcome":"succeeded","summary":"新增 filterWorkspaces(list, query)…","files_modified":["src/renderer/lib/filterWorkspaces.ts","src/renderer/lib/filterWorkspaces.test.ts","src/renderer/components/layout/Sidebar.tsx"]}',
  '[tool done] report_done: Reported succeeded to the coordinator.',
  '[settled]',
  '',
].join('\n');

const TESTS_TRANSCRIPT = [
  '[user] Task brief (dispatch `dispatch_demotests1`): # 为过滤逻辑补边界测试 ## Target 给 filterWorkspaces 补边界测试。 …',
  '[tool] read {"path":"src/renderer/lib/filterWorkspaces.test.ts"}',
  "[tool done] read: import { describe, expect, it } from 'vitest'; import { filterWorkspaces } from './filterWorkspaces'; …",
  '现有用例只覆盖了名称匹配，补大小写、空格、路径和无结果。',
  '[tool] edit {"path":"src/renderer/lib/filterWorkspaces.test.ts","edits":[{"oldText":"});\\n","newText":"  it(\'ignores case\' …"}]}',
  '[tool done] edit: Successfully replaced 1 block(s) in src/renderer/lib/filterWorkspaces.test.ts.',
  '[tool] bash {"command":"pnpm vitest run src/renderer/lib"}',
  '[tool done] bash: ✓ src/renderer/lib/filterWorkspaces.test.ts (8 tests) Test Files 1 passed (1)',
  '[tool] report_done {"outcome":"succeeded","summary":"补了 6 个用例：大小写、前后空格、路径匹配、无结果。"}',
  '[tool done] report_done: Reported succeeded to the coordinator.',
  '[settled]',
  `[user] Review feedback from your coordinator (dispatch \`dispatch_demotests2\`): your last report was not accepted. ${REVIEW_FEEDBACK} Address the feedback in this worktree, commit your changes, then call \`report_done\` again.`,
  '收到。补空查询和全角空格，并把排序断言改成与 locale 无关。',
  '[tool] edit {"path":"src/renderer/lib/filterWorkspaces.ts","edits":[{"oldText":"query.trim()","newText":"normalizeQuery(query)"}]}',
  '[tool done] edit: Successfully replaced 1 block(s) in src/renderer/lib/filterWorkspaces.ts.',
  '[tool] write {"path":"src/renderer/lib/__fixtures__/workspaces.json"}',
  '[tool done] write: Successfully wrote 28870 bytes to src/renderer/lib/__fixtures__/workspaces.json',
  '[tool] bash {"command":"git rm src/renderer/lib/legacyFilter.ts && git mv docs/testing.md docs/TESTING.md"}',
  "[tool done] bash: rm 'src/renderer/lib/legacyFilter.ts'",
  '[tool] bash {"command":"pnpm typecheck && pnpm lint && pnpm test"}',
  '[tool done] bash: Checked 240 files in 115ms. No fixes applied. … Test Files 78 passed (78) Tests 991 passed (991)',
  '[tool] bash {"command":"git add -A && git commit -m \\"test(renderer): cover filterWorkspaces edge cases\\""}',
  '[tool done] bash: [fynvra/filter-tests 91c3e5d] test(renderer): cover filterWorkspaces edge cases 6 files changed',
  TESTS_SUMMARY,
  '[tool] report_done {"outcome":"succeeded","summary":"按反馈补了空查询与全角空格用例…"}',
  '[tool done] report_done: Reported succeeded to the coordinator.',
  '[settled]',
  '',
].join('\n');

/** [相对 mock 创建的时刻 ms, 追加的文本]；负数是 mock 创建前就已产出的部分。 */
const SEARCH_SCRIPT: ReadonlyArray<readonly [number, string]> = [
  [
    -170_000,
    '[user] Task brief (dispatch `dispatch_demosearch1`): # 侧栏加搜索框并接入过滤 ## Target 侧栏工作区列表加搜索框，输入即过滤。 ## Change - 新建 WorkspaceSearch.tsx …\n',
  ],
  [-165_000, '先看侧栏现在的结构，以及上一个任务合并进来的 filterWorkspaces。\n'],
  [-160_000, '[tool] read {"path":"src/renderer/components/layout/Sidebar.tsx"}\n'],
  [
    -159_000,
    "[tool done] read: import { FolderGit2, Plus } from 'lucide-react'; import { Button } from '@/components/ui/button'; import { filterWorkspaces } from '@/lib/filterWorkspaces'; …\n",
  ],
  [-150_000, '[tool] read {"path":"src/renderer/lib/filterWorkspaces.ts"}\n'],
  [
    -149_000,
    '[tool done] read: export function filterWorkspaces(list: readonly WorkspaceSummary[], query: string): WorkspaceSummary[] { const needle = normalizeQuery(query); …\n',
  ],
  [-140_000, '[tool] grep {"pattern":"useWorkspacesStore","path":"src/renderer"}\n'],
  [
    -139_000,
    '[tool done] grep: src/renderer/components/layout/Sidebar.tsx:4 · src/renderer/components/layout/MainArea.tsx:3 · src/renderer/stores/workspaces.ts:25\n',
  ],
  [1_500, 'filterWorkspaces 已经是纯函数，'],
  [2_500, '直接在 Sidebar 里接一个受控输入就行。\n'],
  [4_000, '[tool] read {"path":"src/renderer/components/ui/input.tsx"}\n'],
  [
    5_000,
    '[tool done] read: function Input({ className, type, ...props }: React.ComponentProps<\'input\'>) { return <input type={type} data-slot="input" …\n',
  ],
  [7_500, '任务书没写搜索框放哪，'],
  [8_500, '先问一下主 agent。\n'],
  [MOCK_TIMELINE.ask, `[tool] ask_coordinator {"question":"${SEARCH_QUESTION}"}\n`],
  [MOCK_TIMELINE.reply + 500, `[tool done] ask_coordinator: ${SEARCH_ANSWER}\n`],
  [20_000, '好，放在列表顶部并 sticky。'],
  [21_000, '先写组件。\n'],
  [23_000, '[tool] write {"path":"src/renderer/components/layout/WorkspaceSearch.tsx"}\n'],
  [
    24_500,
    '[tool done] write: Successfully wrote 1214 bytes to src/renderer/components/layout/WorkspaceSearch.tsx\n',
  ],
  [
    26_000,
    '[tool] edit {"path":"src/renderer/components/layout/Sidebar.tsx","edits":[{"oldText":"<ScrollArea","newText":"<WorkspaceSearch value={query} onChange={setQuery} />…"}]}\n',
  ],
  [
    27_000,
    '[tool done] edit: Successfully replaced 1 block(s) in src/renderer/components/layout/Sidebar.tsx.\n',
  ],
  [29_000, '[tool] bash {"command":"pnpm vitest run src/renderer/lib"}\n'],
  [
    33_000,
    '[tool done] bash: ✓ src/renderer/lib/filterWorkspaces.test.ts (14 tests) Test Files 1 passed (1) Tests 14 passed (14)\n',
  ],
  [34_500, '[tool] bash {"command":"pnpm typecheck"}\n'],
  [
    39_000,
    "[tool error] bash: src/renderer/components/layout/WorkspaceSearch.tsx(18,7): error TS2322: Type 'string | undefined' is not assignable to type 'string'.\n",
  ],
  [41_000, 'defaultValue 那里漏了兜底，'],
  [42_000, '改成受控的 value。\n'],
  [
    43_500,
    '[tool] edit {"path":"src/renderer/components/layout/WorkspaceSearch.tsx","edits":[{"oldText":"defaultValue={query}","newText":"value={query}"}]}\n',
  ],
  [
    44_500,
    '[tool done] edit: Successfully replaced 1 block(s) in src/renderer/components/layout/WorkspaceSearch.tsx.\n',
  ],
  [46_000, '[tool] bash {"command":"pnpm typecheck && pnpm lint && pnpm test"}\n'],
  [
    53_000,
    '[tool done] bash: tsc --noEmit -p tsconfig.node.json … Checked 241 files in 118ms. No fixes applied. … Test Files 78 passed (78) Tests 984 passed (984)\n',
  ],
  [
    54_500,
    '[tool] bash {"command":"git add -A && git commit -m \\"feat(renderer): add workspace search to sidebar\\""}\n',
  ],
  [
    MOCK_TIMELINE.commit,
    '[tool done] bash: [fynvra/sidebar-search 7d2e9a1] feat(renderer): add workspace search to sidebar 2 files changed, 58 insertions(+), 4 deletions(-)\n',
  ],
  [57_000, `${SEARCH_SUMMARY}\n`],
  [
    59_000,
    `[tool] report_done {"outcome":"succeeded","summary":"工作区列表顶部加了 sticky 搜索框…","files_modified":${JSON.stringify(SEARCH_FILES)}}\n`,
  ],
  [
    MOCK_TIMELINE.settle - 1_000,
    '[tool done] report_done: Reported succeeded to the coordinator.\n',
  ],
  [MOCK_TIMELINE.settle, '[settled]\n'],
];

// 假 diff：按结构生成统一 diff 文本与 `--stat`，行数与统计保持一致

interface FakeHunk {
  oldStart: number;
  newStart: number;
  section?: string;
  /** 带前缀（` ` / `+` / `-`）的行 */
  lines: string[];
}

interface FakeFile {
  path: string;
  oldPath?: string;
  kind: 'added' | 'deleted' | 'modified' | 'renamed' | 'binary';
  hunks: FakeHunk[];
}

function fakeDiff(files: FakeFile[]): { files: string[]; stat: string; diff: string } {
  const out: string[] = [];
  const stats: Array<{ name: string; count: string; plus: number; minus: number }> = [];
  for (const file of files) {
    const from = file.oldPath ?? file.path;
    out.push(`diff --git a/${from} b/${file.path}`);
    if (file.kind === 'added' || file.kind === 'binary') {
      out.push('new file mode 100644', 'index 0000000..5d6e7f8');
    } else if (file.kind === 'deleted') {
      out.push('deleted file mode 100644', 'index 1a2b3c4..0000000');
    } else if (file.kind === 'renamed') {
      out.push('similarity index 91%', `rename from ${from}`, `rename to ${file.path}`);
      out.push('index 1a2b3c4..5d6e7f8 100644');
    } else {
      out.push('index 1a2b3c4..5d6e7f8 100644');
    }
    if (file.kind === 'binary') {
      out.push(`Binary files /dev/null and b/${file.path} differ`);
      stats.push({ name: file.path, count: 'Bin 0 -> 2817 bytes', plus: 0, minus: 0 });
      continue;
    }
    out.push(file.kind === 'added' ? '--- /dev/null' : `--- a/${from}`);
    out.push(file.kind === 'deleted' ? '+++ /dev/null' : `+++ b/${file.path}`);
    let plus = 0;
    let minus = 0;
    for (const hunk of file.hunks) {
      const oldCount = hunk.lines.filter((line) => !line.startsWith('+')).length;
      const newCount = hunk.lines.filter((line) => !line.startsWith('-')).length;
      plus += hunk.lines.length - oldCount;
      minus += hunk.lines.length - newCount;
      const section = hunk.section ? ` ${hunk.section}` : '';
      out.push(`@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@${section}`);
      out.push(...hunk.lines);
    }
    const name = file.oldPath ? renameLabel(file.oldPath, file.path) : file.path;
    stats.push({ name, count: String(plus + minus), plus, minus });
  }

  const width = Math.max(...stats.map((entry) => entry.name.length));
  const countWidth = Math.max(
    ...stats.map((entry) => (entry.plus + entry.minus > 0 ? entry.count.length : 0))
  );
  const scale = Math.max(1, Math.max(...stats.map((entry) => entry.plus + entry.minus)) / 40);
  const statLines = stats.map((entry) => {
    const bar =
      '+'.repeat(Math.ceil(entry.plus / scale)) + '-'.repeat(Math.ceil(entry.minus / scale));
    const count = entry.plus + entry.minus > 0 ? entry.count.padStart(countWidth) : entry.count;
    return ` ${entry.name.padEnd(width)} | ${count}${bar ? ` ${bar}` : ''}`;
  });
  const insertions = stats.reduce((sum, entry) => sum + entry.plus, 0);
  const deletions = stats.reduce((sum, entry) => sum + entry.minus, 0);
  statLines.push(
    ` ${files.length} files changed, ${insertions} insertions(+), ${deletions} deletions(-)`
  );
  return {
    files: files.map((file) => file.path),
    stat: statLines.join('\n'),
    diff: `${out.join('\n')}\n`,
  };
}

function renameLabel(from: string, to: string): string {
  const fromDir = from.slice(0, from.lastIndexOf('/') + 1);
  const toDir = to.slice(0, to.lastIndexOf('/') + 1);
  return fromDir === toDir
    ? `${fromDir}{${from.slice(fromDir.length)} => ${to.slice(toDir.length)}}`
    : `${from} => ${to}`;
}

const FIXTURE_NAMES = [
  'fynvra',
  'web-app',
  'pi',
  'api-server',
  'dotfiles',
  'blog',
  'infra',
  'notes',
];

type FakeDiff = ReturnType<typeof fakeDiff>;
let testsDiffCache: FakeDiff | null = null;
let searchDiffCache: FakeDiff | null = null;

// 假 diff 第一次用到时才生成（含 600 行 fixture），不拖慢没打开演示数据的启动
function testsDiff(): FakeDiff {
  testsDiffCache ??= buildTestsDiff();
  return testsDiffCache;
}

function searchDiff(): FakeDiff {
  searchDiffCache ??= buildSearchDiff();
  return searchDiffCache;
}

let testsUncommittedCache: FakeDiff | null = null;

function testsUncommitted(): FakeDiff {
  testsUncommittedCache ??= fakeDiff([
    {
      path: 'src/renderer/lib/filterWorkspaces.ts',
      kind: 'modified',
      hunks: [
        {
          oldStart: 3,
          newStart: 3,
          lines: [
            ' /** 去掉首尾空白（含全角空格）并转小写；与 locale 无关。 */',
            ' export function normalizeQuery(query: string): string {',
            "-  return query.replace(/\u3000/g, ' ').trim().toLowerCase();",
            "+  return query.replace(/[\u3000s]+/g, ' ').trim().toLowerCase();",
            ' }',
          ],
        },
      ],
    },
    {
      path: 'src/renderer/lib/__fixtures__/README.md',
      kind: 'added',
      hunks: [
        {
          oldStart: 0,
          newStart: 1,
          lines: ['+# Fixtures', '+', '+`workspaces.json`：600 条工作区，用于过滤性能与排序用例。'],
        },
      ],
    },
  ]);
  return testsUncommittedCache;
}

const MOCK_AUTHOR = 'Fynvra Worker';

function testsCommits(start: number) {
  return [
    {
      sha: 'b81f04c2d9e3a7f56c1e0d4b8a2f9e7c3d5b6a10',
      subject: 'test(renderer): cover filterWorkspaces edge cases',
      author: MOCK_AUTHOR,
      date: new Date(start - 4 * MINUTE).toISOString(),
    },
    {
      sha: '3c9e7a15f02b84d6e1a9c7f3b5d2e8a0c4f6b912',
      subject: 'refactor(renderer): extract normalizeQuery',
      author: MOCK_AUTHOR,
      date: new Date(start - 9 * MINUTE).toISOString(),
    },
  ];
}

function searchCommits(start: number) {
  return [
    {
      sha: '7d2e9a1c5b0f83e4d6a2c9b7f1e5d3a8c0b4f627',
      subject: 'feat(renderer): add workspace search to sidebar',
      author: MOCK_AUTHOR,
      date: new Date(start + MOCK_TIMELINE.commit).toISOString(),
    },
  ];
}

const buildTestsDiff = () =>
  fakeDiff([
    {
      path: 'src/renderer/lib/filterWorkspaces.test.ts',
      kind: 'modified',
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            " import { describe, expect, it } from 'vitest';",
            "-import { filterWorkspaces } from './filterWorkspaces';",
            "+import fixtures from './__fixtures__/workspaces.json';",
            "+import { filterWorkspaces, normalizeQuery } from './filterWorkspaces';",
            ' ',
            ' const list = [',
            "   { id: 'a', name: 'fynvra', displayPath: '~/code/fynvra', defaultBranch: 'main' },",
          ],
        },
        {
          oldStart: 24,
          newStart: 25,
          section: "describe('filterWorkspaces', () => {",
          lines: [
            "   it('matches the display path', () => {",
            "     expect(filterWorkspaces(list, 'code/web').map((w) => w.id)).toEqual(['b']);",
            '   });',
            '+',
            "+  it('returns everything for an empty query', () => {",
            "+    expect(filterWorkspaces(list, '')).toEqual(list);",
            "+    expect(filterWorkspaces(list, '   ')).toEqual(list);",
            '+  });',
            '+',
            "+  it('treats full-width spaces as spaces', () => {",
            "+    expect(normalizeQuery('\\u3000Fyn\\u3000')).toBe('fyn');",
            "+    expect(filterWorkspaces(list, '\\u3000fyn').map((w) => w.id)).toEqual(['a']);",
            '+  });',
            '+',
            "+  it('does not depend on the locale', () => {",
            "+    const names = filterWorkspaces(fixtures, 'o').map((w) => w.name);",
            '+    expect(names).toEqual([...names].sort());',
            '+  });',
            '+',
            "+  it('handles a 600-item list', () => {",
            '+    expect(fixtures).toHaveLength(600);',
            "+    expect(filterWorkspaces(fixtures, 'api-server')).toHaveLength(75);",
            '+  });',
            '+',
            "+  it('returns an empty list when nothing matches', () => {",
            "+    expect(filterWorkspaces(list, 'zzz')).toEqual([]);",
            '+  });',
            ' });',
          ],
        },
      ],
    },
    {
      path: 'src/renderer/lib/filterWorkspaces.ts',
      kind: 'modified',
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            " import type { WorkspaceSummary } from '@shared/types/workspace';",
            ' ',
            '+/** 去掉首尾空白（含全角空格）并转小写；与 locale 无关。 */',
            '+export function normalizeQuery(query: string): string {',
            "+  return query.replace(/\\u3000/g, ' ').trim().toLowerCase();",
            '+}',
            '+',
            ' export function filterWorkspaces(',
            '   list: readonly WorkspaceSummary[],',
            '   query: string',
            ' ): WorkspaceSummary[] {',
            '-  const needle = query.trim().toLocaleLowerCase();',
            '+  const needle = normalizeQuery(query);',
            "   if (needle === '') return [...list];",
            '   return list.filter(',
            '-    (w) => w.name.toLocaleLowerCase().includes(needle) || w.displayPath.includes(needle)',
            '+    (w) => w.name.toLowerCase().includes(needle) || w.displayPath.toLowerCase().includes(needle)',
            '   );',
            ' }',
          ],
        },
      ],
    },
    {
      path: 'src/renderer/lib/__fixtures__/workspaces.json',
      kind: 'added',
      hunks: [
        {
          oldStart: 0,
          newStart: 1,
          lines: [
            '+[',
            ...Array.from({ length: 600 }, (_, index) => {
              const name = FIXTURE_NAMES[index % FIXTURE_NAMES.length] ?? 'repo';
              const comma = index === 599 ? '' : ',';
              return `+  { "id": "ws-${index + 1}", "name": "${name}-${index + 1}", "displayPath": "~/code/${name}-${index + 1}", "defaultBranch": "main" }${comma}`;
            }),
            '+]',
          ],
        },
      ],
    },
    {
      path: 'src/renderer/lib/legacyFilter.ts',
      kind: 'deleted',
      hunks: [
        {
          oldStart: 1,
          newStart: 0,
          lines: [
            "-import type { WorkspaceSummary } from '@shared/types/workspace';",
            '-',
            '-/** @deprecated 用 filterWorkspaces */',
            '-export function legacyFilter(list: WorkspaceSummary[], query: string) {',
            '-  const q = query.toLocaleLowerCase();',
            '-  return list.filter((w) => w.name.toLocaleLowerCase().indexOf(q) !== -1);',
            '-}',
          ],
        },
      ],
    },
    {
      path: 'docs/TESTING.md',
      oldPath: 'docs/testing.md',
      kind: 'renamed',
      hunks: [
        {
          oldStart: 3,
          newStart: 3,
          section: '## 渲染进程',
          lines: [
            ' 渲染进程的纯函数放在 `src/renderer/lib/`，测试与源码同目录。',
            '-大列表用例直接在测试里拼数组。',
            '+大列表用例用 `__fixtures__/` 里的 JSON，避免测试文件过长。',
            '+断言不要依赖 locale（CI 默认 `en-US`）。',
          ],
        },
      ],
    },
    { path: 'test/fixtures/empty-state.png', kind: 'binary', hunks: [] },
  ]);

const buildSearchDiff = () =>
  fakeDiff([
    {
      path: 'src/renderer/components/layout/WorkspaceSearch.tsx',
      kind: 'added',
      hunks: [
        {
          oldStart: 0,
          newStart: 1,
          lines: [
            "+import { Search, X } from 'lucide-react';",
            "+import { Button } from '@/components/ui/button';",
            "+import { Input } from '@/components/ui/input';",
            '+',
            '+/** 工作区列表顶部的搜索框：输入即过滤，Esc 清空。 */',
            '+export function WorkspaceSearch({',
            '+  value,',
            '+  onChange,',
            '+}: {',
            '+  value: string;',
            '+  onChange: (value: string) => void;',
            '+}) {',
            '+  return (',
            '+    <div className="sticky top-0 z-10 flex items-center gap-1 bg-sidebar px-2 py-1.5">',
            '+      <Search className="size-3.5 text-muted-foreground" />',
            '+      <Input',
            '+        value={value}',
            '+        placeholder="搜索工作区"',
            '+        className="h-7"',
            '+        onChange={(event) => onChange(event.target.value)}',
            "+        onKeyDown={(event) => event.key === 'Escape' && onChange('')}",
            '+      />',
            '+      {value && (',
            '+        <Button size="icon-xs" variant="ghost" onClick={() => onChange(\'\')}>',
            '+          <X />',
            '+        </Button>',
            '+      )}',
            '+    </div>',
            '+  );',
            '+}',
          ],
        },
      ],
    },
    {
      path: 'src/renderer/components/layout/Sidebar.tsx',
      kind: 'modified',
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            " import { FolderGit2, Plus } from 'lucide-react';",
            "+import { useState } from 'react';",
            " import { Button } from '@/components/ui/button';",
            " import { filterWorkspaces } from '@/lib/filterWorkspaces';",
            " import { useWorkspacesStore } from '@/stores/workspaces';",
            "+import { WorkspaceSearch } from './WorkspaceSearch';",
          ],
        },
        {
          oldStart: 18,
          newStart: 20,
          section: 'export function Sidebar() {',
          lines: [
            '   const workspaces = useWorkspacesStore((state) => state.workspaces);',
            '-  const visible = workspaces;',
            "+  const [query, setQuery] = useState('');",
            '+  const visible = filterWorkspaces(workspaces, query);',
            ' ',
            '   return (',
            '     <aside className="flex w-60 shrink-0 flex-col border-r bg-sidebar">',
            '-      <ScrollArea className="flex-1">',
            '+      <WorkspaceSearch value={query} onChange={setQuery} />',
            '+      <ScrollArea className="flex-1">',
            '+        {visible.length === 0 && (',
            '+          <p className="px-3 py-6 text-center text-muted-foreground text-xs">没有匹配的工作区</p>',
            '+        )}',
          ],
        },
      ],
    },
  ]);
