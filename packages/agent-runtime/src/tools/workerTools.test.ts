import { describe, expect, it, vi } from 'vitest';
import type { WorkerHost } from '../host';
import { runTool, toolByName } from '../test-utils/pipeline';
import { ASK_TIMEOUT_DEFAULT_MS, createWorkerTools } from './workerTools';

function createHost() {
  return {
    askCoordinator: vi.fn<WorkerHost['askCoordinator']>(async () => ({
      ok: true,
      answer: 'Use REST.',
    })),
    reportDone: vi.fn<WorkerHost['reportDone']>(async () => ({ ok: true })),
  } satisfies WorkerHost;
}

describe('createWorkerTools', () => {
  it('exposes ask_coordinator and report_done with described schemas', () => {
    const { tools } = createWorkerTools(createHost());
    expect(tools.map((tool) => tool.name)).toEqual(['ask_coordinator', 'report_done']);
    for (const tool of tools) {
      expect(tool.promptSnippet, tool.name).toBeTruthy();
      const schema = tool.parameters as {
        properties: Record<string, { description?: string }>;
        additionalProperties?: boolean;
      };
      expect(schema.additionalProperties).toBe(false);
      for (const [key, property] of Object.entries(schema.properties)) {
        expect(property.description, `${tool.name}.${key}`).toBeTruthy();
      }
    }
  });
});

describe('ask_coordinator', () => {
  it('passes the trimmed question, the timeout and the abort signal to the host', async () => {
    const host = createHost();
    const ask = toolByName(createWorkerTools(host).tools, 'ask_coordinator');
    const controller = new AbortController();
    const run = await runTool(ask, { question: '  REST or GraphQL?  ' }, controller.signal);
    expect(host.askCoordinator).toHaveBeenCalledWith(
      'REST or GraphQL?',
      ASK_TIMEOUT_DEFAULT_MS,
      controller.signal
    );
    expect(run.isError).toBe(false);
    expect(run.text).toContain('## Coordinator reply');
    expect(run.text).toContain('Use REST.');
  });

  it('uses the configured timeout', async () => {
    const host = createHost();
    const ask = toolByName(
      createWorkerTools(host, { askTimeoutMs: 5_000 }).tools,
      'ask_coordinator'
    );
    await runTool(ask, { question: 'q?' });
    expect(host.askCoordinator.mock.calls[0]?.[1]).toBe(5_000);
  });

  it('treats a timeout as no reply rather than an error', async () => {
    const host = createHost();
    host.askCoordinator.mockResolvedValueOnce({ ok: true, answer: null });
    const ask = toolByName(createWorkerTools(host).tools, 'ask_coordinator');
    const run = await runTool(ask, { question: 'q?' });
    expect(run.isError).toBe(false);
    expect(run.text).toContain('## No reply');
  });

  it('rejects blank questions and reports host failures as error text', async () => {
    const host = createHost();
    const ask = toolByName(createWorkerTools(host).tools, 'ask_coordinator');
    expect((await runTool(ask, { question: '   ' })).isError).toBe(true);
    expect((await runTool(ask, {})).isError).toBe(true);
    expect(host.askCoordinator).not.toHaveBeenCalled();

    host.askCoordinator.mockResolvedValueOnce({ ok: false, error: 'coordinator gone' });
    host.askCoordinator.mockRejectedValueOnce(new Error('IPC closed'));
    const failed = await runTool(ask, { question: 'q?' });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('coordinator gone');
    const thrown = await runTool(ask, { question: 'q?' });
    expect(thrown.isError).toBe(true);
    expect(thrown.text).toContain('IPC closed');
  });
});

describe('report_done', () => {
  it('normalizes outcome aliases and a files list given as one string', async () => {
    const host = createHost();
    const report = toolByName(createWorkerTools(host).tools, 'report_done');
    const run = await runTool(report, {
      outcome: ' Success ',
      summary: '  Added the form; pnpm test passes.  ',
      filesModified: 'src/a.ts\nsrc/b.ts\nsrc/a.ts',
    });
    expect(run).toMatchObject({ isError: false, terminate: true });
    expect(host.reportDone).toHaveBeenCalledWith('succeeded', 'Added the form; pnpm test passes.', [
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('can only be called once per round; a second call returns error text', async () => {
    const host = createHost();
    const { tools, startRound } = createWorkerTools(host);
    const report = toolByName(tools, 'report_done');
    expect((await runTool(report, { outcome: 'succeeded', summary: 'done' })).isError).toBe(false);
    const again = await runTool(report, { outcome: 'failed', summary: 'second' });
    expect(again).toMatchObject({ isError: true, stage: 'execute' });
    expect(again.text).toContain('only be called once');
    expect(host.reportDone).toHaveBeenCalledTimes(1);

    // reject_work 的反馈开启新一轮，worker 需要重新汇报
    startRound();
    expect((await runTool(report, { outcome: 'succeeded', summary: 'fixed' })).isError).toBe(false);
    expect(host.reportDone).toHaveBeenCalledTimes(2);
  });

  it('allows a retry when the host did not record the report', async () => {
    const host = createHost();
    host.reportDone.mockResolvedValueOnce({ ok: false, error: 'inbox unavailable' });
    const report = toolByName(createWorkerTools(host).tools, 'report_done');
    const failed = await runTool(report, { outcome: 'succeeded', summary: 'done' });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('inbox unavailable');
    expect((await runTool(report, { outcome: 'succeeded', summary: 'done' })).isError).toBe(false);
    expect(host.reportDone).toHaveBeenCalledTimes(2);
  });

  it('lets only one of two concurrent calls through', async () => {
    const host = createHost();
    let release: () => void = () => {};
    host.reportDone.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true });
        })
    );
    const report = toolByName(createWorkerTools(host).tools, 'report_done');
    const first = runTool(report, { outcome: 'succeeded', summary: 'a' });
    const second = await runTool(report, { outcome: 'succeeded', summary: 'b' });
    release();
    expect((await first).isError).toBe(false);
    expect(second.isError).toBe(true);
    expect(host.reportDone).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid outcome without using up the report', async () => {
    const host = createHost();
    const report = toolByName(createWorkerTools(host).tools, 'report_done');
    expect(await runTool(report, { outcome: 'maybe', summary: 'x' })).toMatchObject({
      isError: true,
      stage: 'validate',
    });
    expect(await runTool(report, { outcome: 'failed', summary: '  ' })).toMatchObject({
      isError: true,
      stage: 'execute',
    });
    expect(host.reportDone).not.toHaveBeenCalled();
    expect((await runTool(report, { outcome: 'failed', summary: 'blocked on API' })).isError).toBe(
      false
    );
  });

  it('never throws, even for garbage params and a throwing host', async () => {
    const host: WorkerHost = {
      askCoordinator: () => {
        throw new Error('boom');
      },
      reportDone: () => {
        throw new Error('boom');
      },
    };
    for (const tool of createWorkerTools(host).tools) {
      for (const params of [null, 7, 'x', { outcome: 'succeeded', summary: 'ok' }]) {
        const result = await tool.execute(
          'call',
          params as never,
          undefined,
          undefined,
          {} as never
        );
        expect(result.isError, `${tool.name} ${JSON.stringify(params)}`).toBe(true);
      }
    }
  });
});
