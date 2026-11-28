import type { ChatMessage } from '@shared/types/chat';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSqlite } from '../../providers/import/fixtures';
import { type CompleteTextResult, createExtractionRunner, type ExtractionDeps } from './runner';
import { acceptedTask, createMemoryFixture, type MemoryFixture, SECRET } from './testing';

let fx: MemoryFixture;
let completeText: ReturnType<typeof vi.fn<ExtractionDeps['completeText']>>;
let logs: string[];
let at: number;

const OUTPUT = JSON.stringify({
  operations: [
    {
      op: 'add',
      category: 'pitfall',
      content: 'Windows 上 build 需要 cross-env',
      evidence: 'Build now uses cross-env.',
    },
  ],
});

const messages: ChatMessage[] = [
  {
    id: 'm1',
    sessionId: 's-worker',
    role: 'assistant',
    text: `using token ${SECRET}`,
    toolCalls: [],
    createdAt: 1,
    streaming: false,
  },
];

function makeRunner(over: Partial<ExtractionDeps> = {}) {
  return createExtractionRunner({
    memory: fx.service,
    completeText,
    readSessionMessages: async () => messages,
    runGit: async () => ({ ok: true, stdout: ' package.json | 2 +-\n' }),
    workspace: () => ({ path: fx.dir, vcs: 'git' }),
    preferences: () => ({ memory: fx.prefs }),
    readContextFile: async () => '# rules',
    now: () => at,
    log: (message) => logs.push(message),
    ...over,
  });
}

const jobs = async () =>
  (await fx.service.database())
    ?.prepare('SELECT job_key, status, detail FROM extraction_jobs ORDER BY created_at')
    .all();
const memories = async () => {
  const { store, projectKey } = await fx.project();
  return store.all(projectKey);
};

beforeAll(loadSqlite);
beforeEach(() => {
  fx = createMemoryFixture();
  logs = [];
  at = new Date(2026, 0, 2, 12).getTime();
  completeText = vi.fn(async (): Promise<CompleteTextResult> => ({ ok: true, text: OUTPUT }));
});
afterEach(() => fx.close());

describe('createExtractionRunner', () => {
  it('同一任务只提炼一次；材料去密钥；按设置传模型与协调者会话', async () => {
    fx.prefs = { ...fx.prefs, model: { providerId: 'p', modelId: 'cheap' } };
    const runner = makeRunner();
    runner.enqueue(acceptedTask());
    runner.enqueue(acceptedTask());
    await runner.idle();
    runner.enqueue(acceptedTask());
    await runner.idle();
    expect(completeText).toHaveBeenCalledTimes(1);
    const input = completeText.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      model: { providerId: 'p', modelId: 'cheap' },
      sessionId: 's-main',
      maxTokens: 1500,
      timeoutMs: 120_000,
    });
    expect(input?.prompt).toContain('<material>');
    expect(input?.prompt).toContain('package.json | 2 +-');
    expect(input?.prompt).not.toContain(SECRET);
    expect(await jobs()).toEqual([{ job_key: 'task:t1', status: 'done', detail: null }]);
    expect(await memories()).toMatchObject([{ content: 'Windows 上 build 需要 cross-env' }]);
  });

  it('总开关或自动提炼关闭、受限协调者：跳过', async () => {
    const runner = makeRunner();
    fx.prefs = { ...fx.prefs, autoExtract: false };
    runner.enqueue(acceptedTask());
    fx.prefs = { ...fx.prefs, autoExtract: true, enabled: false };
    runner.enqueue(acceptedTask({ task: { ...acceptedTask().task, id: 't2' } }));
    fx.prefs = { ...fx.prefs, enabled: true };
    runner.enqueue(acceptedTask({ coordinatorRestricted: true }));
    await runner.idle();
    expect(completeText).not.toHaveBeenCalled();
    expect(await jobs()).toEqual([]);
  });

  it('执行时再查一次开关：入队后关闭也跳过', async () => {
    const runner = makeRunner();
    runner.enqueue(acceptedTask());
    fx.prefs = { ...fx.prefs, enabled: false };
    await runner.idle();
    expect(completeText).not.toHaveBeenCalled();
  });

  it('每个本地日最多 50 次（含会话作业）', async () => {
    const db = await fx.service.database();
    const insert = db?.prepare(
      "INSERT INTO extraction_jobs (job_key, kind, project_key, status, created_at) VALUES (?, 'session', 'k', 'done', ?)"
    );
    for (let i = 0; i < 50; i++) insert?.run(`session:${i}`, at - 1000);
    // 昨天的不算
    insert?.run('session:old', at - 86_400_000);
    const runner = makeRunner();
    runner.enqueue(acceptedTask());
    await runner.idle();
    expect(completeText).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes('daily limit'))).toBe(true);
  });

  it('completeText 失败、输出解析失败：作业记 failed 与类别，不抛错、不记正文', async () => {
    completeText.mockResolvedValueOnce({ ok: false, error: 'boom' });
    completeText.mockResolvedValueOnce({ ok: true, text: 'not json at all' });
    const runner = makeRunner();
    runner.enqueue(acceptedTask());
    runner.enqueue(acceptedTask({ task: { ...acceptedTask().task, id: 't2' } }));
    await runner.idle();
    expect(await jobs()).toEqual([
      { job_key: 'task:t1', status: 'failed', detail: 'model' },
      { job_key: 'task:t2', status: 'failed', detail: 'parse' },
    ]);
    expect(logs.join('\n')).not.toContain('not json');
    expect(await memories()).toEqual([]);
  });

  it('读会话抛错记为 input 失败', async () => {
    const runner = makeRunner({ readSessionMessages: async () => Promise.reject(new Error('x')) });
    runner.enqueue(acceptedTask());
    await runner.idle();
    expect(await jobs()).toEqual([{ job_key: 'task:t1', status: 'failed', detail: 'input' }]);
  });

  it('队列最多 20 个，超出丢弃并记日志', async () => {
    let release: () => void = () => {};
    completeText.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: false, error: 'x' });
        })
    );
    const runner = makeRunner();
    const base = acceptedTask().task;
    runner.enqueue(acceptedTask());
    await vi.waitFor(() => expect(completeText).toHaveBeenCalled());
    for (let i = 0; i < 21; i++) {
      runner.enqueue(acceptedTask({ task: { ...base, id: `q${i}` } }));
    }
    expect(logs.filter((line) => line.includes('queue full'))).toHaveLength(1);
    release();
    await runner.idle();
    expect(completeText).toHaveBeenCalledTimes(21);
  });

  it('recover 把 running 作业改为 failed', async () => {
    const db = await fx.service.database();
    db?.prepare(
      "INSERT INTO extraction_jobs (job_key, kind, project_key, status, created_at) VALUES ('task:x', 'task', 'k', 'running', 1)"
    ).run();
    await makeRunner().recover();
    expect(await jobs()).toEqual([{ job_key: 'task:x', status: 'failed', detail: 'interrupted' }]);
  });
});
