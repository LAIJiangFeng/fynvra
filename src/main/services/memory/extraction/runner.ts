import type { ChatMessage } from '@shared/types/chat';
import { memoryPreferencesOf, type Preferences } from '@shared/types/settings';
import { runGit as defaultRunGit, type GitRunner } from '../../gitRepository';
import type { AcceptedTask } from '../../orchestration/service';
import type { MemoryService } from '../index';
import { rankDocs } from '../search';
import { type MemoryRow, parseFiles } from '../store';
import type { MemoryProjectHandle } from '../toolHost';
import { applyOperations } from './apply';
import {
  BUDGET,
  buildMaterial,
  candidateQuery,
  readContextFile as defaultReadContextFile,
  excerptAttempts,
  excerptMessages,
} from './input';
import { buildPrompt, EXTRACTION_SYSTEM_PROMPT, parseOperations } from './prompt';

// 验收提炼队列（ARCHITECTURE §7.15「验收提炼」）：全局串行、幂等、每日上限；任何异常都不外抛。

/** 排队上限，满了丢弃 */
export const EXTRACTION_QUEUE_MAX = 20;
/** 每个本地日最多创建的作业数（含 session 类作业） */
export const EXTRACTION_DAILY_LIMIT = 50;
export const EXTRACTION_MAX_TOKENS = 1500;
export const EXTRACTION_TIMEOUT_MS = 120_000;

export type CompleteTextResult = { ok: true; text: string } | { ok: false; error: string };

export interface ExtractionDeps {
  memory: Pick<MemoryService, 'database' | 'openProject' | 'applyInTransaction'>;
  /** agentHost.completeText：永不抛错 */
  completeText(input: {
    model?: { providerId: string; modelId: string };
    sessionId?: string;
    systemPrompt: string;
    prompt: string;
    maxTokens: number;
    timeoutMs: number;
  }): Promise<CompleteTextResult>;
  /** 会话消息（pi jsonl 投影）；生产用 readHistory(sessionFilePath(agentDir, id), id) */
  readSessionMessages(sessionId: string): Promise<ChatMessage[]>;
  /** 跑 git diff --stat；缺省用 gitRepository 的 runGit */
  runGit?: GitRunner;
  workspace(
    workspaceId: string
  ):
    | { path: string; vcs: 'git' | 'none' }
    | undefined
    | Promise<{ path: string; vcs: 'git' | 'none' } | undefined>;
  preferences(): Pick<Preferences, 'memory'>;
  /** 仓库根上下文文件；缺省按 AGENTS.override.md → … → CLAUDE.MD 取第一个存在的 */
  readContextFile?(workspacePath: string): Promise<string | undefined>;
  now?(): number;
  log?(message: string): void;
}

export interface ExtractionRunner {
  /** 入队（同步、不抛错）；不满足条件、已在队列或队列满时丢弃 */
  enqueue(task: AcceptedTask): void;
  /** 启动时调用：仍是 running 的作业（上次退出时在跑）改为 failed */
  recover(): Promise<void>;
  /** 等队列清空（测试用） */
  idle(): Promise<void>;
}

/** 失败类别：只记类别，不记正文 */
class ExtractionFailure extends Error {
  constructor(readonly category: 'input' | 'model' | 'parse' | 'apply') {
    super(category);
  }
}

const startOfLocalDay = (at: number) => {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

export function createExtractionRunner(deps: ExtractionDeps): ExtractionRunner {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.warn(`[memory] ${message}`));
  const git = deps.runGit ?? defaultRunGit;
  const readContext = deps.readContextFile ?? defaultReadContextFile;
  const queue: AcceptedTask[] = [];
  const queued = new Set<string>();
  let running: Promise<void> | undefined;

  const eligible = (task: AcceptedTask): boolean => {
    const prefs = memoryPreferencesOf(deps.preferences());
    return prefs.enabled && prefs.autoExtract && !task.coordinatorRestricted;
  };

  async function buildInput(task: AcceptedTask, project: MemoryProjectHandle) {
    const { store, projectKey } = project;
    const workspace = await deps.workspace(task.workspaceId);
    const diff = task.task.mergedDiff;
    let diffStat: string | undefined;
    if (workspace?.vcs === 'git' && diff && diff.baseCommit !== diff.headCommit) {
      const result = await git(
        ['diff', '--stat', diff.baseCommit, diff.headCommit],
        workspace.path
      );
      if (result.ok) diffStat = result.stdout;
    }
    const attempts = excerptAttempts(task);
    const budget = Math.floor(BUDGET.excerpt / Math.max(1, attempts.length));
    const excerpts = await Promise.all(
      attempts.map(async (attempt) => ({
        attempt,
        text: excerptMessages(
          await deps.readSessionMessages(attempt.sessionId),
          attempt.startedAt,
          budget
        ),
      }))
    );
    const contextFile = workspace ? await readContext(workspace.path) : undefined;
    const sessions = new Set(task.dispatches.map((entry) => entry.sessionId));
    const active = store.byStatus(projectKey, 'active');
    const flagged = active.filter(
      (row) => row.flagged_by_session !== null && sessions.has(row.flagged_by_session)
    );
    const byId = new Map(active.map((row) => [row.id, row]));
    const ranked = rankDocs(
      active.map((row) => ({ ...row, files: parseFiles(row.files) })),
      candidateQuery(task)
    )
      .slice(0, BUDGET.candidates)
      .flatMap(({ id }) => byId.get(id) ?? []);
    const candidates: MemoryRow[] = [...ranked, ...flagged.filter((row) => !ranked.includes(row))];
    // 提炼模型可能属于另一家服务商：拼好后整体再去一次密钥
    const material = store.redact(
      buildMaterial({
        task,
        ...(diffStat ? { diffStat } : {}),
        excerpts,
        flagged,
        candidates,
        ...(contextFile ? { contextFile } : {}),
      })
    );
    return { material, candidates };
  }

  async function run(task: AcceptedTask): Promise<void> {
    const db = await deps.memory.database();
    // 执行时再查一次：排队期间用户可能关了开关
    if (!db || !eligible(task)) return;
    const project = await deps.memory.openProject(task.workspaceId);
    if ('error' in project) {
      log(`extraction skipped: project unavailable`);
      return;
    }
    const at = now();
    const today = db
      .prepare('SELECT COUNT(*) AS n FROM extraction_jobs WHERE created_at >= ?')
      .get(startOfLocalDay(at)) as { n: number };
    if (today.n >= EXTRACTION_DAILY_LIMIT) {
      log(`extraction skipped: daily limit of ${EXTRACTION_DAILY_LIMIT} reached`);
      return;
    }
    const jobKey = `task:${task.task.id}`;
    const claimed = db
      .prepare(
        "INSERT OR IGNORE INTO extraction_jobs (job_key, kind, project_key, status, created_at) VALUES (?, 'task', ?, 'running', ?)"
      )
      .run(jobKey, project.projectKey, at);
    if (Number(claimed.changes) === 0) return;

    let failure: string | undefined;
    try {
      const input = await buildInput(task, project).catch(() => {
        throw new ExtractionFailure('input');
      });
      const prefs = memoryPreferencesOf(deps.preferences());
      const completed = await deps.completeText({
        ...(prefs.model ? { model: prefs.model } : {}),
        sessionId: task.coordinatorSessionId,
        systemPrompt: EXTRACTION_SYSTEM_PROMPT,
        prompt: buildPrompt(input.material),
        maxTokens: EXTRACTION_MAX_TOKENS,
        timeoutMs: EXTRACTION_TIMEOUT_MS,
      });
      if (!completed.ok) throw new ExtractionFailure('model');
      const operations = parseOperations(completed.text);
      if (!operations) throw new ExtractionFailure('parse');
      const source = {
        taskId: task.task.id,
        title: task.task.title,
        workspaceId: task.workspaceId,
        coordinatorSessionId: task.coordinatorSessionId,
      };
      await deps.memory
        .applyInTransaction(task.workspaceId, (handle) =>
          applyOperations(handle, operations, {
            material: input.material,
            candidates: input.candidates,
            source,
          })
        )
        .catch(() => {
          throw new ExtractionFailure('apply');
        });
    } catch (error) {
      failure = error instanceof ExtractionFailure ? error.category : 'unexpected';
    }
    db.prepare(
      'UPDATE extraction_jobs SET status = ?, detail = ?, finished_at = ? WHERE job_key = ?'
    ).run(failure ? 'failed' : 'done', failure ?? null, now(), jobKey);
    if (failure) log(`extraction of task ${task.task.id} failed: ${failure}`);
  }

  async function drain(): Promise<void> {
    for (let task = queue.shift(); task; task = queue.shift()) {
      queued.delete(task.task.id);
      try {
        await run(task);
      } catch (error) {
        // 库读写等意外：只记类别
        log(
          `extraction of task ${task.task.id} failed: ${error instanceof Error ? error.name : 'error'}`
        );
      }
    }
    running = undefined;
  }

  return {
    enqueue(task) {
      try {
        if (!eligible(task) || queued.has(task.task.id)) return;
        if (queue.length >= EXTRACTION_QUEUE_MAX) {
          log(`extraction queue full; dropped task ${task.task.id}`);
          return;
        }
        queue.push(task);
        queued.add(task.task.id);
        running ??= drain();
      } catch (error) {
        log(`extraction enqueue failed: ${error instanceof Error ? error.name : 'error'}`);
      }
    },
    async recover() {
      try {
        const db = await deps.memory.database();
        db?.prepare(
          "UPDATE extraction_jobs SET status = 'failed', detail = 'interrupted', finished_at = ? WHERE status = 'running'"
        ).run(now());
      } catch (error) {
        log(`extraction recover failed: ${error instanceof Error ? error.name : 'error'}`);
      }
    },
    async idle() {
      while (running) await running;
    },
  };
}
