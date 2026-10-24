import type { OrchestrationHost, WorkerHost } from '@fynvra/agent-runtime';
import { isDispatchOutcome } from '@fynvra/core';
import { asRecord, errorMessage } from '@shared/guards';
import type { HostCallResult } from '@shared/types/agent';

/**
 * OrchestrationHost 的方法表（与 agent-runtime 的 ORCHESTRATION_TOOL_METHODS 一一对应）。
 * Main 不 import agent-runtime 的值（会把 pi 带进主进程），用 Record 键穷举接口，接口变了这里编译失败。
 */
export const ORCHESTRATION_HOST_METHODS: Record<keyof OrchestrationHost, true> = {
  dispatchTask: true,
  listWorkers: true,
  waitForWorkers: true,
  readWorkerOutput: true,
  sendToWorker: true,
  reviewDiff: true,
  runChecks: true,
  mergeWorktree: true,
  rejectWork: true,
  cleanupWorktree: true,
};

type InputMethod = Exclude<keyof OrchestrationHost, 'listWorkers'>;

/**
 * 执行 worker 发来的编排工具调用。入参的语义校验归 OrchestrationHost 实现；这里只认方法名、要求入参是对象。
 * 永不抛异常：Host 抛错或返回不合形状的结果都转成 `{ ok: false, error }`。
 */
export function invokeOrchestrationHost(
  host: OrchestrationHost,
  method: string,
  input: unknown,
  signal: AbortSignal
): Promise<HostCallResult> {
  return settle(method, () => {
    if (!Object.hasOwn(ORCHESTRATION_HOST_METHODS, method)) {
      return fail(`unknown orchestration method: ${method}`);
    }
    if (method === 'listWorkers') return host.listWorkers(signal);
    const args = asRecord(input);
    if (!args) return fail(`${method} needs an input object`);
    const call = host[method as InputMethod] as (input: unknown, signal: AbortSignal) => unknown;
    return call.call(host, args, signal);
  });
}

/** 执行 worker 会话的 ask_coordinator / report_done：把打包的入参还原成 WorkerHost 的位置参数 */
export function invokeWorkerHost(
  host: WorkerHost,
  method: string,
  input: unknown,
  signal: AbortSignal
): Promise<HostCallResult> {
  return settle(method, () => {
    const args = asRecord(input);
    if (!args) return fail(`${method} needs an input object`);
    if (method === 'askCoordinator') {
      const { question, timeoutMs } = args;
      if (typeof question !== 'string' || typeof timeoutMs !== 'number' || !(timeoutMs > 0)) {
        return fail('askCoordinator needs { question: string, timeoutMs: number > 0 }');
      }
      return host.askCoordinator(question, timeoutMs, signal);
    }
    if (method === 'reportDone') {
      const { outcome, summary, filesModified } = args;
      if (!isDispatchOutcome(outcome) || typeof summary !== 'string') {
        return fail("reportDone needs { outcome: 'succeeded' | 'failed', summary: string }");
      }
      const files = filesModified === undefined ? undefined : toStringList(filesModified);
      if (files === null) return fail('reportDone filesModified must be a list of paths');
      return host.reportDone(outcome, summary, files);
    }
    return fail(`unknown worker method: ${method}`);
  });
}

function fail(error: string): HostCallResult {
  return { ok: false, error };
}

function toStringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

async function settle(method: string, run: () => unknown): Promise<HostCallResult> {
  let raw: unknown;
  try {
    raw = await run();
  } catch (error) {
    return fail(errorMessage(error));
  }
  const record = asRecord(raw);
  if (record?.ok === true) return { ...record, ok: true };
  if (record?.ok === false && typeof record.error === 'string') return fail(record.error);
  return fail(`${method} returned an invalid result`);
}
