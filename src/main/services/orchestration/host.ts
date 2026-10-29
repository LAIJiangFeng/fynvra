import { basename, dirname } from 'node:path';
import type {
  CleanupWorktreeInput,
  CleanupWorktreeOutput,
  DispatchRef,
  DispatchTaskInput,
  DispatchTaskOutput,
  HostResult,
  ListWorkersOutput,
  MergeWorktreeOutput,
  OrchestrationHost,
  ReadWorkerOutputInput,
  ReadWorkerOutputOutput,
  RejectWorkInput,
  RejectWorkOutput,
  ReviewDiffOutput,
  RunChecksInput,
  RunChecksOutput,
  SendToWorkerInput,
  SendToWorkerOutput,
  WaitForWorkersInput,
  WaitForWorkersOutput,
  WorkerEntry,
} from '@fynvra/agent-runtime';
import {
  type Dispatch,
  type ExecFn,
  type GitWorktreeManager,
  type Inbox,
  isDispatchSettled,
  type Message,
  newId,
  type OrchestrationStore,
  type RoleStore,
  type Run,
  settleDispatch,
  type Task,
  type Workspace,
  type Worktree,
} from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import { renderWorkerBrief } from './brief';
import {
  type CheckCommandPolicy,
  checkCommand,
  DEFAULT_CHECK_COMMAND_POLICY,
} from './checkCommand';
import { ABORTED, fail, guard, untilAborted } from './hostResult';
import type { WorkerSessionLauncher } from './launcher';
import { currentBranch, readDispatchOutput, reviewDispatchDiff } from './queries';
import { pendingQuestionOf, takePendingQuestion } from './workerHost';
import { mergedCleanupBlocker } from './worktreeCleanup';
import { isInsideDirectory } from './worktreesRoot';

/** 在 worktree 里执行检查命令（经 shell）；非零退出码照常返回。 */
export type RunChecksFn = (
  cwd: string,
  command: string,
  signal?: AbortSignal
) => Promise<{ exitCode: number; output: string; durationMs: number }>;

/**
 * ARCHITECTURE §9.5 `createOrchestrationHost` 的依赖，外加三项补充：
 * `resolveWorktreesRoot`（建 worktree 的位置）、`exec`（合并前确认仓库所在分支、review 时取 `--stat`）、
 * `checkPolicy` / `now`（可选）。
 */
export interface OrchestrationHostDeps {
  workspace: Workspace;
  /** 主 agent 会话；它的 Run 按 (workspace, coordinatorSessionId) 查找，首次派发时创建。 */
  coordinatorSessionId: string;
  /**
   * 主 agent 所在分支：worktree 从它切出，merge_worktree 合回它。
   * 普通目录（`workspace.vcs` 为 `none`）没有分支，为空串：worker 直接在工作区目录里干活，整条编排不跑 git。
   */
  coordinatorBranch: string;
  store: OrchestrationStore;
  git: GitWorktreeManager;
  inbox: Inbox;
  launcher: WorkerSessionLauncher;
  roles: RoleStore;
  runChecks: RunChecksFn;
  /**
   * worktree 托管根目录（见 `worktreesRoot.ts`），每次建 worktree 时现算：设置改了之后新派的任务就落到新位置；
   * 已有 worktree 的路径记在 store 里，不受影响。
   */
  resolveWorktreesRoot: (workspace: Workspace) => Promise<string>;
  /** 执行 git（与 `git` 使用同一个实现）。 */
  exec: ExecFn;
  /** run_checks 白名单，默认 {@link DEFAULT_CHECK_COMMAND_POLICY}。 */
  checkPolicy?: CheckCommandPolicy;
  /** 未成功投递的新尝试：不能被工具绑定或恢复逻辑结算 */
  pendingDispatches?: Set<string>;
  reconcileWorkers?: () => void;
  /** 时钟（epoch ms），默认 `Date.now`。 */
  now?: () => number;
}

/** Host 自己投递的消息（如排队任务启动失败的 escalation）的发送方。 */
export const HOST_SENDER = 'fynvra';

type Resolved = { run: Run; task: Task; dispatch: Dispatch; worktree: Worktree | undefined };
/** 普通目录的尝试没有 worktree */
type Launched = { worktree: Worktree | undefined; dispatch: Dispatch };

/** 尝试是否直接在工作区目录里进行（普通目录）：没有 worktree，也就谈不上「worktree 已清理」。 */
function isInPlace(dispatch: Dispatch): boolean {
  return dispatch.mode === 'in-place';
}

/** store / inbox 的「不该失败」的写入：失败说明状态被并发改动，抛给 guard 转成错误结果。 */
function unwrap<T extends { ok: true }>(result: T | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result;
}

function cleanedUp(dispatch: Dispatch): string {
  return `the worktree of dispatch ${dispatch.id} was already cleaned up`;
}

function notMergeable(task: Task, inPlace: boolean): string {
  switch (task.status) {
    case 'in-progress':
      return `task ${task.id} is still in progress: its worker has not reported done; call wait_for_workers first`;
    case 'failed':
      return `the worker reported task ${task.id} as failed; reject_work to retry it or cleanup_worktree with abandon: true to abandon it`;
    case 'completed':
      return `task ${task.id} is already ${inPlace ? 'accepted' : 'merged'}; call cleanup_worktree`;
    default:
      return `task ${task.id} is ${task.status} and cannot be merged`;
  }
}

function instructionPrompt(body: string): string {
  return ['Message from your coordinator:', '', body].join('\n');
}

function feedbackPrompt(feedback: string, dispatchId: string, inPlace: boolean): string {
  return [
    `Review feedback from your coordinator (dispatch \`${dispatchId}\`): your last report was not accepted.`,
    '',
    feedback,
    '',
    inPlace
      ? 'Address the feedback in the workspace directory (no git: do not commit), then call `report_done` again.'
      : 'Address the feedback in this worktree, commit your changes, then call `report_done` again.',
  ].join('\n');
}

/**
 * 编排工具背后的宿主（ARCHITECTURE §6、§9.5），一个主 agent 会话一个。
 * 方法与 orchestrator 工具一一对应，全部返回 `HostResult`、从不抛异常；
 * 操作只接收 id，路径一律从 store 里的记录推导（`workspace.repoPath` 除外）。
 *
 * 依赖未完成的任务先排队（只建 Task），在 `listWorkers` / `waitForWorkers` 被调用时补派：
 * 依赖只会经 `mergeWorktree` 变成 completed，而主 agent 合并之后总要回到这两个工具上。
 *
 * 普通目录（`workspace.vcs` 为 `none`）原地编排，不调用任何 git：派发不建 worktree，worker 的 cwd 是工作区目录、
 * Dispatch 记 `mode: 'in-place'`；review 给出 worker 汇报的改动文件；merge 只把任务记为 completed；
 * cleanup 只停 worker；run_checks 在工作区目录里跑。
 */
export function createOrchestrationHost(deps: OrchestrationHostDeps): OrchestrationHost {
  const { workspace, coordinatorSessionId, coordinatorBranch, store, git, inbox, launcher, roles } =
    deps;
  const repoPath = workspace.repoPath;
  const inPlace = workspace.vcs === 'none';
  const now = deps.now ?? Date.now;
  const policy = deps.checkPolicy ?? DEFAULT_CHECK_COMMAND_POLICY;
  /** 正在建 worktree / 起会话的 task，排队推进时跳过 */
  const launching = new Set<string>();
  let queueTurn: Promise<void> = Promise.resolve();

  const findRun = (): Run | undefined =>
    store.runs.list(
      (run) => run.workspaceId === workspace.id && run.coordinatorSessionId === coordinatorSessionId
    )[0];

  /** 当前尝试；没有进行中的就是最近一次。 */
  const latestDispatch = (taskId: string): Dispatch | undefined =>
    store.activeDispatch(taskId) ?? store.dispatches.list((d) => d.taskId === taskId).at(-1);

  const pendingCount = (runId: string): number =>
    store.listTasks(runId).filter((task) => store.activeDispatch(task.id) !== undefined).length;

  /** dispatch id → 本 Run 里的 task / dispatch / worktree（worktree 清理后为 undefined）。 */
  function resolve(dispatchId: string): HostResult<Resolved> {
    const run = findRun();
    const dispatch = store.dispatches.get(dispatchId);
    const task = dispatch && store.tasks.get(dispatch.taskId);
    if (
      run === undefined ||
      dispatch === undefined ||
      task === undefined ||
      task.runId !== run.id
    ) {
      return fail(
        `unknown dispatch_id "${dispatchId}" in this run; list_workers shows the current ones`
      );
    }
    return { ok: true, run, task, dispatch, worktree: store.worktrees.get(dispatch.worktreeId) };
  }

  /** 验收和清理必须指向最新尝试，旧汇报不能验收或取消重试中的工作。 */
  function resolveCurrent(dispatchId: string): HostResult<Resolved> {
    const found = resolve(dispatchId);
    if (!found.ok) return found;
    const current = latestDispatch(found.task.id);
    if (current?.id !== dispatchId) {
      return fail(
        `dispatch ${dispatchId} is not the current attempt; use dispatch_id "${current?.id}" from list_workers`
      );
    }
    return found;
  }

  async function promptWorker(
    sessionId: string,
    text: string,
    freshAttempt = false,
    signal?: AbortSignal
  ) {
    if (signal?.aborted) return fail('feedback delivery was aborted');
    try {
      return freshAttempt
        ? await launcher.promptSession(sessionId, text, {
            freshAttempt: true,
            ...(signal ? { signal } : {}),
          })
        : await launcher.promptSession(sessionId, text);
    } catch (error) {
      return fail(errorMessage(error));
    }
  }

  async function disposeWorker(sessionId: string): Promise<void> {
    try {
      await launcher.disposeSession(sessionId);
    } catch {
      // 会话可能已经不在了；清理 worktree 照常进行
    }
  }

  /**
   * worktree 建在 `<worktreesRoot>/<workspaceId>/<slug>`：记录路径的祖父目录与当前推导出的根目录一致时才返回它，
   * 作为 `git.remove` 的 `ownedRoot`（允许删掉 git 已注销的残留目录）；对不上（设置改过、退回过 userData）时不担保。
   */
  async function ownedRootOf(worktree: Worktree): Promise<string | undefined> {
    const workspaceDir = dirname(worktree.path);
    if (basename(workspaceDir) !== workspace.id) return undefined;
    const root = dirname(workspaceDir);
    let current: string;
    try {
      current = await deps.resolveWorktreesRoot(workspace);
    } catch {
      return undefined;
    }
    return isInsideDirectory(root, current) && isInsideDirectory(current, root) ? root : undefined;
  }

  /** 强删 worktree 目录；git 已注销的残留目录在托管根目录内时也删掉。 */
  async function removeWorktree(worktree: Worktree) {
    const ownedRoot = await ownedRootOf(worktree);
    return git.remove({
      repoPath,
      path: worktree.path,
      force: true,
      ...(ownedRoot === undefined ? {} : { ownedRoot }),
    });
  }

  /** 删掉 worktree 与分支（尽力而为）；返回拼到错误信息后面的失败说明。 */
  async function discardWorktree(worktree: Worktree): Promise<string> {
    const removed = await removeWorktree(worktree);
    const deleted = await git.deleteBranch({ repoPath, branch: worktree.branch, force: true });
    const problems = [removed, deleted].flatMap((result) => (result.ok ? [] : [result.error]));
    return problems.length === 0 ? '' : ` (cleanup failed: ${problems.join('; ')})`;
  }

  /**
   * 建 worktree（普通目录不建）→ 渲染任务书 → 起 worker 会话；会话起不来时删掉刚建的 worktree。不写 store。
   */
  async function launch(task: Task): Promise<HostResult<Launched>> {
    let worktree: Worktree | undefined;
    if (!inPlace) {
      const created = await git.create({
        repoPath,
        workspaceId: workspace.id,
        slug: task.title,
        baseRef: coordinatorBranch,
        worktreesRoot: await deps.resolveWorktreesRoot(workspace),
      });
      if (!created.ok) return fail(`could not create a worktree: ${created.error}`);
      worktree = created.worktree;
    }
    const dispatchId = newId('dispatch');
    const brief = renderWorkerBrief({ title: task.title, spec: task.spec, dispatchId });
    let started: Awaited<ReturnType<WorkerSessionLauncher['createWorkerSession']>>;
    try {
      started = await launcher.createWorkerSession({
        workspaceId: workspace.id,
        runId: task.runId,
        dispatchId,
        roleId: task.roleId,
        cwd: worktree?.path ?? repoPath,
        ...(worktree ? { worktreeId: worktree.id } : {}),
        // 派发时指定的模型 / 档位 / Fast 请求记在 Task 上，排队或恢复后启动也保留 false
        ...(task.model !== undefined ? { model: task.model } : {}),
        ...(task.thinking !== undefined ? { thinking: task.thinking } : {}),
        ...(task.fastMode !== undefined ? { fastMode: task.fastMode } : {}),
        brief,
      });
    } catch (error) {
      started = fail(errorMessage(error));
    }
    if (!started.ok) {
      const cleanup = worktree ? await discardWorktree(worktree) : '';
      return fail(`could not start the worker session: ${started.error}${cleanup}`);
    }
    const dispatch: Dispatch = {
      id: dispatchId,
      taskId: task.id,
      workerSessionId: started.sessionId,
      worktreeId: worktree?.id ?? '',
      branch: worktree?.branch ?? '',
      ...(worktree ? {} : { mode: 'in-place' as const }),
      startedAt: now(),
    };
    return { ok: true, worktree, dispatch };
  }

  /** 落库一次启动成功的尝试；失败时撤掉已写入的行，task 保持原状。 */
  function record(task: Task, launched: Launched, isNew: boolean): HostResult<{ task: Task }> {
    const { worktree } = launched;
    if (worktree) {
      const inserted = store.worktrees.insert(worktree);
      if (!inserted.ok) return inserted;
    }
    const dropWorktree = () => {
      if (worktree) store.worktrees.delete(worktree.id);
    };
    const dispatch = store.dispatches.insert(launched.dispatch);
    if (!dispatch.ok) {
      dropWorktree();
      return dispatch;
    }
    const saved = isNew
      ? store.tasks.insert({ ...task, status: 'in-progress' })
      : store.tasks.update(task.id, { status: 'in-progress' });
    if (!saved.ok) {
      store.dispatches.delete(launched.dispatch.id);
      dropWorktree();
      return saved;
    }
    return { ok: true, task: saved.value };
  }

  async function start(task: Task, isNew: boolean): Promise<HostResult<DispatchTaskOutput>> {
    launching.add(task.id);
    try {
      const launched = await launch(task);
      if (!launched.ok) return launched;
      // 必须紧跟在 launcher resolve 之后同步落库，中间不能有 await：
      // worker 的 report_done / ask_coordinator 经 Dispatch.workerSessionId 找到这次尝试
      const recorded = record(task, launched, isNew);
      if (!recorded.ok) {
        await disposeWorker(launched.dispatch.workerSessionId);
        const cleanup = launched.worktree ? await discardWorktree(launched.worktree) : '';
        return fail(`${recorded.error}${cleanup}`);
      }
      return { ok: true, task: recorded.task, dispatch: launched.dispatch };
    } finally {
      launching.delete(task.id);
    }
  }

  function abandonQueued(task: Task, reason: string): void {
    if (store.tasks.get(task.id)?.status !== 'todo') return;
    unwrap(store.tasks.update(task.id, { status: 'abandoned' }));
    unwrap(
      inbox.post({
        runId: task.runId,
        from: HOST_SENDER,
        to: coordinatorSessionId,
        type: 'escalation',
        subject: 'queued task abandoned',
        body: `Task ${task.id} ("${task.title}") was abandoned before it started: ${reason}. Dispatch it again with dispatch_task if it is still needed.`,
      })
    );
  }

  /** 推进排队任务：依赖都 completed 的派发出去；依赖被放弃（或已不存在）的随之放弃并上报。 */
  async function runQueue(): Promise<void> {
    const run = findRun();
    if (run === undefined) return;
    for (const { id } of store.listTasks(run.id)) {
      const task = store.tasks.get(id);
      if (task === undefined || task.status !== 'todo' || launching.has(task.id)) continue;
      const blocker = task.dependsOn.find((dependency) => {
        const status = store.tasks.get(dependency)?.status;
        return status === undefined || status === 'abandoned';
      });
      if (blocker !== undefined) {
        const gone = store.tasks.get(blocker) === undefined;
        abandonQueued(
          task,
          `its dependency ${blocker} ${gone ? 'no longer exists' : 'was abandoned'}`
        );
        continue;
      }
      const ready = task.dependsOn.every((dependency) => {
        return store.tasks.get(dependency)?.status === 'completed';
      });
      if (!ready) continue;
      const started = await start(task, false);
      if (!started.ok) abandonQueued(task, `starting its worker failed: ${started.error}`);
    }
  }

  /** 同一时刻只跑一轮排队推进；从不 reject。 */
  function advanceQueue(): Promise<void> {
    const turn = queueTurn.then(runQueue).catch(() => undefined);
    queueTurn = turn;
    return turn;
  }

  async function dispatchTask(input: DispatchTaskInput): Promise<HostResult<DispatchTaskOutput>> {
    const title = input.title.trim();
    const spec = input.spec.trim();
    if (title === '') return fail('title must not be empty');
    if (spec === '') return fail('spec must not be empty');
    if (input.fastMode !== undefined && typeof input.fastMode !== 'boolean') {
      return fail('fastMode must be a boolean');
    }
    const role = await roles.get(input.roleId);
    if (role === undefined) return fail(`unknown role "${input.roleId}"`);
    if (role.tools === 'orchestrator') {
      return fail(`role "${role.id}" is an orchestrator role and cannot run a worker`);
    }

    const existing = findRun();
    const dependsOn = [...new Set(input.dependsOn)];
    const model = input.model?.trim();
    for (const id of dependsOn) {
      const dependency = store.tasks.get(id);
      if (dependency === undefined || dependency.runId !== existing?.id) {
        return fail(`depends_on: unknown task "${id}" in this run`);
      }
      if (dependency.status === 'abandoned') {
        return fail(`depends_on: task "${id}" was abandoned and will never complete`);
      }
    }
    // Run 的 objective：编排工具不携带用户目标，取这次 Run 首个任务的标题
    const run =
      existing ??
      unwrap(
        store.runs.insert({
          id: newId('run'),
          workspaceId: workspace.id,
          coordinatorSessionId,
          objective: title,
          createdAt: now(),
        })
      ).value;
    const task: Task = {
      id: newId('task'),
      runId: run.id,
      title,
      spec,
      roleId: role.id,
      status: 'todo',
      dependsOn,
      ...(model ? { model } : {}),
      ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
      ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}),
    };
    if (!dependsOn.every((id) => store.tasks.get(id)?.status === 'completed')) {
      return { ok: true, task: unwrap(store.tasks.insert(task)).value };
    }
    return start(task, true);
  }

  async function listWorkers(): Promise<HostResult<ListWorkersOutput>> {
    deps.reconcileWorkers?.();
    await advanceQueue();
    const run = findRun();
    const tasks = run === undefined ? [] : store.listTasks(run.id);
    const workers = tasks.map((task): WorkerEntry => {
      const dispatch = latestDispatch(task.id);
      return dispatch === undefined ? { task } : { task, dispatch };
    });
    return { ok: true, workers };
  }

  function deliver(messages: Message[], pending: number, timedOut: boolean) {
    const delivered = messages.map((message) => {
      const acked = inbox.ack(message.id);
      return acked.ok ? acked.message : message;
    });
    return { ok: true as const, timedOut, messages: delivered, pending };
  }

  async function waitForWorkers(
    input: WaitForWorkersInput,
    signal?: AbortSignal
  ): Promise<HostResult<WaitForWorkersOutput>> {
    const deadline = Date.now() + input.timeoutMs;
    const seen = new Map<string, Message>();
    for (;;) {
      if (signal?.aborted) return fail('wait_for_workers was aborted');
      deps.reconcileWorkers?.();
      await advanceQueue();
      const run = findRun();
      if (run === undefined) return { ok: true, timedOut: false, messages: [], pending: 0 };
      const toCoordinator = (message: Message) =>
        message.runId === run.id && message.to === coordinatorSessionId;
      for (const message of inbox.peek(toCoordinator)) {
        if (!seen.has(message.id)) seen.set(message.id, message);
      }
      const messages = [...seen.values()];
      const pending = pendingCount(run.id);
      // question / escalation 一到就返回：否则阻塞提问的 worker 和等待中的主 agent 会互等
      const satisfied =
        messages.some((message) => message.type === 'question' || message.type === 'escalation') ||
        (input.until === 'any' && messages.some((message) => message.type === 'worker_done')) ||
        pending === 0;
      const remaining = deadline - Date.now();
      if (satisfied || remaining <= 0) return deliver(messages, pending, !satisfied);
      const next = await untilAborted(
        inbox.waitFor((message) => toCoordinator(message) && !seen.has(message.id), remaining),
        signal
      );
      if (next === ABORTED) return fail('wait_for_workers was aborted');
    }
  }

  async function readWorkerOutput(
    input: ReadWorkerOutputInput
  ): Promise<HostResult<ReadWorkerOutputOutput>> {
    const found = resolve(input.dispatchId);
    if (!found.ok) return found;
    return readDispatchOutput({ store, launcher }, found.dispatch, input.cursor);
  }

  async function sendToWorker(input: SendToWorkerInput): Promise<HostResult<SendToWorkerOutput>> {
    const found = resolve(input.dispatchId);
    if (!found.ok) return found;
    const body = input.body.trim();
    if (body === '') return fail('body must not be empty');
    const { run, task, dispatch } = found;
    const workerSessionId = dispatch.workerSessionId;

    const questionId = pendingQuestionOf(inbox, workerSessionId);
    if (questionId !== undefined) {
      takePendingQuestion(inbox, questionId);
      const reply = unwrap(
        inbox.post({
          runId: run.id,
          dispatchId: store.messages.get(questionId)?.dispatchId ?? dispatch.id,
          from: coordinatorSessionId,
          to: workerSessionId,
          type: 'reply',
          body,
          replyTo: questionId,
        })
      );
      inbox.ack(questionId);
      return { ok: true, messageId: reply.message.id, type: 'reply' };
    }

    if (task.status === 'completed' || task.status === 'abandoned') {
      return fail(`task ${task.id} is ${task.status}; dispatch a new task for further work`);
    }
    if (!isInPlace(dispatch) && found.worktree === undefined) return fail(cleanedUp(dispatch));
    const instruction = unwrap(
      inbox.post({
        runId: run.id,
        dispatchId: latestDispatch(task.id)?.id ?? dispatch.id,
        from: coordinatorSessionId,
        to: workerSessionId,
        type: 'instruction',
        body,
      })
    );
    const delivered = await promptWorker(workerSessionId, instructionPrompt(body));
    if (!delivered.ok) {
      store.messages.delete(instruction.message.id);
      return fail(`could not deliver the message to the worker: ${delivered.error}`);
    }
    inbox.ack(instruction.message.id);
    return { ok: true, messageId: instruction.message.id, type: 'instruction' };
  }

  /** 普通目录没有 diff：给出这个任务各次尝试里 worker 汇报的改动文件（去重，按汇报顺序）。 */
  function reportedFiles(task: Task): HostResult<ReviewDiffOutput> {
    const attempts = store.dispatches.list((dispatch) => dispatch.taskId === task.id);
    const files = [...new Set(attempts.flatMap((dispatch) => dispatch.filesModified ?? []))];
    return { ok: true, branch: '', baseCommit: '', files, stat: '', diff: '', mode: 'in-place' };
  }

  async function reviewDiff(input: DispatchRef): Promise<HostResult<ReviewDiffOutput>> {
    const found = resolve(input.dispatchId);
    if (!found.ok) return found;
    if (isInPlace(found.dispatch)) return reportedFiles(found.task);
    return reviewDispatchDiff({ git, exec: deps.exec, store, repoPath }, found.dispatch);
  }

  async function runChecks(
    input: RunChecksInput,
    signal?: AbortSignal
  ): Promise<HostResult<RunChecksOutput>> {
    const found = resolve(input.dispatchId);
    if (!found.ok) return found;
    const cwd = isInPlace(found.dispatch) ? repoPath : found.worktree?.path;
    if (cwd === undefined) return fail(cleanedUp(found.dispatch));
    const verdict = checkCommand(input.command, policy);
    if (!verdict.ok) return fail(verdict.error);
    const result = await deps.runChecks(cwd, verdict.command, signal);
    return {
      ok: true,
      exitCode: result.exitCode,
      output: result.output,
      durationMs: result.durationMs,
    };
  }

  /** 普通目录：改动已经在目录里，没有可合并的分支；验收通过即完成（随后同样补派排队任务）。 */
  async function acceptInPlace(task: Task): Promise<HostResult<MergeWorktreeOutput>> {
    if (task.status !== 'in-review') return fail(notMergeable(task, true));
    const completed = store.tasks.update(task.id, { status: 'completed' });
    if (!completed.ok) return completed;
    await advanceQueue();
    return { ok: true, merged: true, targetBranch: '', mode: 'in-place' };
  }
  async function mergeWorktree(input: DispatchRef): Promise<HostResult<MergeWorktreeOutput>> {
    const found = resolveCurrent(input.dispatchId);
    if (!found.ok) return found;
    const { task, dispatch, worktree } = found;
    if (isInPlace(dispatch)) return await acceptInPlace(task);
    if (worktree === undefined) return fail(cleanedUp(dispatch));
    if (task.status !== 'in-review') return fail(notMergeable(task, false));

    const status = await git.status(worktree);
    if (!status.ok) return fail(`could not read the worktree status: ${status.error}`);
    if (status.status.dirty) {
      return fail(
        `the worktree of dispatch ${dispatch.id} has uncommitted changes or untracked files and only committed work is merged; ask the worker to commit them first (reject_work)`
      );
    }
    if (worktree.baseRef !== coordinatorBranch) {
      return fail(
        `this worktree was branched from ${worktree.baseRef}, but this run merges into ${coordinatorBranch}`
      );
    }
    // GitWorktreeManager.merge 合进 repoPath 当前检出的分支：先确认它就是目标分支
    const checkedOut = await currentBranch(deps.exec, repoPath);
    if (checkedOut !== coordinatorBranch) {
      const where = checkedOut === undefined ? 'a detached HEAD' : `branch ${checkedOut}`;
      return fail(
        `the workspace repository is on ${where}, not ${coordinatorBranch}; check out ${coordinatorBranch} in ${repoPath} before merging`
      );
    }

    // 在合并前固定 worker 提交；主仓库的合并提交还可能包含其他任务的改动，不能作为 diff 终点。
    const head = await deps.exec(
      'git',
      ['rev-parse', '--verify', '--quiet', `refs/heads/${worktree.branch}^{commit}`],
      repoPath
    );
    const headCommit = head.stdout.trim();
    if (head.code !== 0 || headCommit === '') {
      return fail(`could not read the worker commit for ${worktree.branch}; merge was not started`);
    }
    const merged = await git.merge({ repoPath, branch: worktree.branch });
    if (!merged.ok) {
      if (merged.conflicts !== undefined && merged.conflicts.length > 0) {
        return {
          ok: true,
          merged: false,
          targetBranch: coordinatorBranch,
          conflicts: merged.conflicts,
        };
      }
      return fail(merged.error);
    }
    const completed = store.tasks.update(task.id, {
      status: 'completed',
      mergedDiff: { baseCommit: worktree.baseCommit, headCommit },
    });
    if (!completed.ok) {
      return fail(
        `${worktree.branch} was merged into ${coordinatorBranch}, but the task could not be marked completed: ${completed.error}`
      );
    }
    // 依赖本任务的任务现在全部满足：立即补派（主 agent 派发后不再阻塞等待，不会马上回来调 wait/list）
    await advanceQueue();
    return {
      ok: true,
      merged: true,
      targetBranch: coordinatorBranch,
      ...(merged.commit === '' ? {} : { commit: merged.commit }),
    };
  }

  async function rejectWork(
    input: RejectWorkInput,
    signal?: AbortSignal
  ): Promise<HostResult<RejectWorkOutput>> {
    if (signal?.aborted) return fail('reject_work was aborted');
    const found = resolveCurrent(input.dispatchId);
    if (!found.ok) return found;
    const feedback = input.feedback.trim();
    if (feedback === '') return fail('feedback must not be empty');
    const { run, task, worktree } = found;
    // failed → in-progress 是「重试」，同样走打回
    if (task.status !== 'in-review' && task.status !== 'failed') {
      return fail(
        task.status === 'in-progress'
          ? `task ${task.id} is still in progress; use send_to_worker to steer the worker`
          : `task ${task.id} is ${task.status} and cannot be sent back`
      );
    }
    if (!isInPlace(found.dispatch) && worktree === undefined) {
      return fail(`${cleanedUp(found.dispatch)}; dispatch a new task`);
    }
    const previous = latestDispatch(task.id);
    if (previous === undefined) return fail(`task ${task.id} has no previous attempt`);
    // No await between this check and insertion: a waiting ask must be answered on the old run.
    if (pendingQuestionOf(inbox, previous.workerSessionId) !== undefined) {
      return fail(
        `worker ${previous.workerSessionId} is waiting for an ask_coordinator reply; first use send_to_worker to answer, then wait for the worker's current run to finish before calling reject_work`
      );
    }

    // 打回 = 同一 worktree（普通目录则是同一目录）、同一 worker 会话上的一次新尝试
    const next: Dispatch = {
      id: newId('dispatch'),
      taskId: task.id,
      workerSessionId: previous.workerSessionId,
      worktreeId: previous.worktreeId,
      branch: previous.branch,
      ...(previous.mode ? { mode: previous.mode } : {}),
      startedAt: now(),
    };
    const inserted = store.dispatches.insert(next);
    if (!inserted.ok) return inserted;
    const reopened = store.tasks.update(task.id, { status: 'in-progress' });
    if (!reopened.ok) {
      store.dispatches.delete(next.id);
      return reopened;
    }
    let instructionId: string | undefined;
    let delivered = false;
    // pi followUp can stay inside the old run. The launcher waits for a real run boundary.
    deps.pendingDispatches?.add(next.id);
    try {
      const instruction = unwrap(
        inbox.post({
          runId: run.id,
          dispatchId: next.id,
          from: coordinatorSessionId,
          to: next.workerSessionId,
          type: 'instruction',
          subject: 'review feedback',
          body: feedback,
        })
      );
      instructionId = instruction.message.id;
      const result = await promptWorker(
        next.workerSessionId,
        feedbackPrompt(feedback, next.id, isInPlace(next)),
        true,
        signal
      );
      if (!result.ok) {
        return fail(`could not deliver the feedback to the worker: ${result.error}`);
      }
      // Delivery is the commit point; a later abort must not undo a run already started.
      delivered = true;
      inbox.ack(instructionId);
      return { ok: true, messageId: instructionId };
    } finally {
      if (!delivered) {
        if (instructionId !== undefined) store.messages.delete(instructionId);
        // Report/cleanup may have settled this attempt while delivery was pending.
        const current = store.tasks.get(task.id);
        const attempt = store.dispatches.get(next.id);
        if (
          attempt !== undefined &&
          !isDispatchSettled(attempt) &&
          latestDispatch(task.id)?.id === next.id &&
          current?.status === 'in-progress'
        ) {
          store.dispatches.delete(next.id);
          store.tasks.update(task.id, { status: task.status });
        }
      }
      deps.pendingDispatches?.delete(next.id);
      deps.reconcileWorkers?.();
    }
  }

  /** 显式放弃：进行中的尝试按 failed 结算，已有的汇报保持原样。 */
  function abandon(task: Task): void {
    const active = store.activeDispatch(task.id);
    if (active !== undefined) {
      const reason = 'Abandoned by the coordinator (cleanup_worktree).';
      const { id: _id, ...patch } = unwrap(
        settleDispatch(active, 'failed', reason, undefined, now())
      ).dispatch;
      unwrap(store.dispatches.update(active.id, patch));
    }
    if (task.status !== 'abandoned') unwrap(store.tasks.update(task.id, { status: 'abandoned' }));
  }

  async function cleanupWorktree(
    input: CleanupWorktreeInput
  ): Promise<HostResult<CleanupWorktreeOutput>> {
    if (input.abandon !== undefined && typeof input.abandon !== 'boolean') {
      return fail('abandon must be a boolean');
    }
    const found = resolveCurrent(input.dispatchId);
    if (!found.ok) return found;
    const { task, dispatch, worktree } = found;
    const completed = task.status === 'completed';
    if (!completed && task.status !== 'abandoned') {
      if (input.abandon !== true) {
        return fail(
          `task ${task.id} is ${task.status}; cleanup does not accept or abandon work. Review successful reports and call merge_worktree to accept (including clean no-change tasks), reject_work to retry reported work, or cleanup_worktree with abandon: true to explicitly cancel and discard it`
        );
      }
      // 取消意图先落盘：即使资源删除失败，任务也确实已被主动放弃，重试清理不改变汇报。
      abandon(task);
    }
    if (isInPlace(dispatch)) {
      // 普通目录只停 worker，改动留在目录里；验收与取消仍遵循相同的状态契约。
      await disposeWorker(dispatch.workerSessionId);
      return { ok: true, removedWorktree: false, deletedBranch: false, mode: 'in-place' };
    }
    if (worktree === undefined) {
      // 不再按旧 branch 名称删分支：它可能已被后续任务复用。
      if (!completed) await disposeWorker(dispatch.workerSessionId);
      return { ok: true, removedWorktree: false, deletedBranch: false };
    }
    if (completed) {
      const status = await git.status(worktree);
      if (!status.ok) return fail(`could not read the worktree status: ${status.error}`);
      const blocker = mergedCleanupBlocker(task.status, status.status);
      if (blocker !== null) {
        return fail(
          `cannot clean up completed task ${task.id}: ${blocker}; preserve and resolve the remaining work before retrying cleanup`
        );
      }
    }
    // 先停 worker：它的进程可能还占着 worktree 里的文件。
    await disposeWorker(dispatch.workerSessionId);
    const removed = completed
      ? await git.remove({ repoPath, path: worktree.path })
      : await removeWorktree(worktree);
    if (!removed.ok) {
      return fail(`could not remove the worktree ${worktree.path}: ${removed.error}`);
    }
    store.worktrees.delete(worktree.id);
    // 已验收任务只用 -d，且不用 --force 删目录，保护验收之后的新改动。
    const deleted = await git.deleteBranch({
      repoPath,
      branch: worktree.branch,
      force: !completed,
    });
    return { ok: true, removedWorktree: true, deletedBranch: deleted.ok };
  }

  return {
    dispatchTask: (input) => guard(() => dispatchTask(input)),
    listWorkers: () => guard(listWorkers),
    waitForWorkers: (input, signal) => guard(() => waitForWorkers(input, signal)),
    readWorkerOutput: (input) => guard(() => readWorkerOutput(input)),
    sendToWorker: (input) => guard(() => sendToWorker(input)),
    reviewDiff: (input) => guard(() => reviewDiff(input)),
    runChecks: (input, signal) => guard(() => runChecks(input, signal)),
    mergeWorktree: (input) => guard(() => mergeWorktree(input)),
    rejectWork: (input, signal) => guard(() => rejectWork(input, signal)),
    cleanupWorktree: (input) => guard(() => cleanupWorktree(input)),
  };
}
