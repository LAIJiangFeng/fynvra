import { type Static, StringEnum, Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { DispatchOutcome, WorkerHost } from '../host';
import { asRecord, compact, pick, requiredText, stringList, trimmed } from './args';
import { errorResult, safely, textResult } from './result';

export const ASK_TIMEOUT_DEFAULT_MS = 600_000;

export interface WorkerToolsOptions {
  /** ask_coordinator 等待答复的上限，默认 10 分钟 */
  askTimeoutMs?: number;
}

export interface WorkerToolset {
  tools: ToolDefinition[];
  /**
   * 开始新一轮工作，允许再调用一次 report_done。每次新的 agent run 开始时调用
   * （如 reject_work 的反馈作为新 prompt 到达）；createRoleSession 已经接在 before_agent_start 上。
   */
  startRound(): void;
}

const OUTCOME_ALIASES: Record<string, DispatchOutcome> = {
  succeeded: 'succeeded',
  success: 'succeeded',
  successful: 'succeeded',
  succeed: 'succeeded',
  done: 'succeeded',
  completed: 'succeeded',
  complete: 'succeeded',
  ok: 'succeeded',
  passed: 'succeeded',
  failed: 'failed',
  fail: 'failed',
  failure: 'failed',
  error: 'failed',
};

const askSchema = Type.Object(
  {
    question: Type.String({
      description:
        'One specific question for your coordinator, with the context needed to answer it (what you found, the options you see).',
    }),
  },
  { additionalProperties: false }
);

const reportSchema = Type.Object(
  {
    outcome: StringEnum(['succeeded', 'failed'] as const, {
      description:
        "'succeeded' when the task is done and verified; 'failed' when you could not complete it.",
    }),
    summary: Type.String({
      description:
        'Concise report: what you changed, how you verified it (commands and their results), and what is left undone or risky.',
    }),
    files_modified: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Files you created, modified or deleted, relative to the worktree root.',
      })
    ),
  },
  { additionalProperties: false }
);

/** worker 会话的协作工具：ask_coordinator（阻塞提问）与 report_done（每轮一次的完成汇报） */
export function createWorkerTools(
  host: WorkerHost,
  options: WorkerToolsOptions = {}
): WorkerToolset {
  const askTimeoutMs = options.askTimeoutMs ?? ASK_TIMEOUT_DEFAULT_MS;
  // reporting：Host 调用进行中，挡住并发的第二次调用；Host 失败则退回 open
  let reportState: 'open' | 'reporting' | 'reported' = 'open';

  const ask = defineTool({
    name: 'ask_coordinator',
    label: 'Ask coordinator',
    description:
      'Ask your coordinator (the orchestrator agent that assigned this task) a question and wait for the reply. ' +
      'Use it only when you are blocked on a decision you cannot make from the brief or the code.',
    promptSnippet: 'Ask your coordinator a blocking question when the brief leaves a decision open',
    parameters: askSchema,
    executionMode: 'sequential',
    prepareArguments: (raw) =>
      compact({ question: trimmed(pick(asRecord(raw), 'question')) }) as Static<typeof askSchema>,
    execute: (_toolCallId, params, signal) =>
      safely('ask_coordinator', async () => {
        const question = requiredText(pick(asRecord(params), 'question'), 'question');
        if (!question.ok) return errorResult('ask_coordinator', question.error);
        const result = await host.askCoordinator(question.value, askTimeoutMs, signal);
        if (!result.ok) return errorResult('ask_coordinator', result.error);
        if (result.answer === null) {
          return textResult(
            `## No reply\nYour coordinator did not answer within ${formatDuration(askTimeoutMs)}. ` +
              'Continue with your best judgment and state the assumption in report_done, or ask again if you are truly blocked.',
            result
          );
        }
        return textResult(`## Coordinator reply\n${result.answer}`, result);
      }),
  });

  const report = defineTool({
    name: 'report_done',
    label: 'Report done',
    description:
      'Report the result of your current attempt to your coordinator, exactly once per attempt, then stop. ' +
      'Your coordinator only learns the result through this call',
    promptSnippet: 'Report your current attempt to the coordinator, exactly once, then stop',
    promptGuidelines: [
      'Call report_done once per attempt, after your work is committed and verified (or when you cannot finish), then stop',
    ],
    parameters: reportSchema,
    executionMode: 'sequential',
    prepareArguments: (raw) => normalizeReportArgs(raw) as Static<typeof reportSchema>,
    execute: (_toolCallId, params) =>
      safely('report_done', async () => {
        const args = normalizeReportArgs(params);
        const outcome = args.outcome;
        if (outcome !== 'succeeded' && outcome !== 'failed') {
          return errorResult('report_done', "outcome must be 'succeeded' or 'failed'");
        }
        const summary = requiredText(args.summary, 'summary');
        if (!summary.ok) return errorResult('report_done', summary.error);
        const files = args.files_modified;
        if (files !== undefined && !Array.isArray(files)) {
          return errorResult('report_done', 'files_modified must be an array of paths');
        }
        if (reportState !== 'open') {
          return errorResult(
            'report_done',
            reportState === 'reported'
              ? 'report_done was already called for this round and can only be called once per round; stop until the coordinator starts a new attempt'
              : 'another report_done call is in progress; it can only be called once per round'
          );
        }
        reportState = 'reporting';
        try {
          const result = await host.reportDone(
            outcome,
            summary.value,
            files as string[] | undefined
          );
          if (!result.ok) {
            reportState = 'open';
            return errorResult('report_done', `${result.error}; this call was not accepted`);
          }
          reportState = 'reported';
        } catch (error) {
          reportState = 'open';
          throw error;
        }
        return {
          ...textResult(
            [
              '## Reported to coordinator',
              `- outcome: ${outcome}`,
              `- files modified: ${files?.length ?? 0}`,
              '',
              'Stop here; do not call report_done again unless the coordinator starts a new attempt',
            ].join('\n')
          ),
          terminate: true,
        };
      }),
  });

  return {
    tools: [ask, report],
    startRound: () => {
      if (reportState === 'reported') reportState = 'open';
    },
  };
}

function formatDuration(ms: number): string {
  return ms >= 60_000
    ? `${Math.round(ms / 60_000)} min`
    : `${Math.max(1, Math.round(ms / 1000))} s`;
}

function normalizeReportArgs(raw: unknown) {
  const args = asRecord(raw);
  const outcome = trimmed(pick(args, 'outcome'));
  const alias = typeof outcome === 'string' ? outcome.toLowerCase() : '';
  return compact({
    outcome: Object.hasOwn(OUTCOME_ALIASES, alias) ? OUTCOME_ALIASES[alias] : outcome,
    summary: trimmed(pick(args, 'summary')),
    // 路径里可能有逗号，单个字符串只按换行拆
    files_modified: stringList(pick(args, 'files_modified', 'filesModified'), /\n/),
  });
}
