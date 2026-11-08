import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseWorkflow, WORKFLOW_LIMITS, type Workflow } from '@fynvra/core';
import { asRecord } from '@shared/guards';
import { translate } from '../../i18n';

export const WORKFLOWS_FILE_VERSION = 1;

export type WorkflowSaveOutcome = { ok: true; workflow: Workflow } | { ok: false; error: string };

export interface WorkflowRegistry {
  /** 全部工作流的副本，按保存顺序。文件损坏时 reject，不会清空。 */
  list(): Promise<Workflow[]>;
  /** id 不存在时返回 undefined。 */
  get(id: string): Promise<Workflow | undefined>;
  /** 新建或按 id 整份替换；入参应已经 parseWorkflow 收窄。超出数量上限时返回 ok: false。 */
  save(workflow: Workflow): Promise<WorkflowSaveOutcome>;
  /** id 不存在时返回 false。 */
  remove(id: string): Promise<boolean>;
}

/**
 * `userData/workflows.json`：`{ version: 1, workflows: Workflow[] }`，最多 50 个。
 * 内存缓存 + 串行读改写 + 原子替换。文件无法解析或含非法记录时一律报错，
 * 不改名、不按空表继续，避免下一次保存把用户的工作流覆盖掉。
 * 版本号不变：旧条目（步骤不带 needs）读入时由 parseWorkflow 转成线性链，
 * 下一次保存时整份按新形状（每个节点带 needs）写回。
 */
export function createWorkflowRegistry(options: { filePath: string }): WorkflowRegistry {
  const { filePath } = options;
  let cache: Workflow[] | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  const enqueue = <R>(task: () => Promise<R>): Promise<R> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };

  const load = async (): Promise<Workflow[]> => {
    cache ??= await readWorkflows(filePath);
    return cache;
  };

  const commit = async (next: Workflow[]): Promise<void> => {
    await writeJsonAtomic(filePath, { version: WORKFLOWS_FILE_VERSION, workflows: next });
    cache = structuredClone(next);
  };

  return {
    list: () => enqueue(async () => structuredClone(await load())),
    get: (id) =>
      enqueue(async () => {
        const found = (await load()).find((workflow) => workflow.id === id);
        return found ? structuredClone(found) : undefined;
      }),
    save: (workflow) =>
      enqueue(async (): Promise<WorkflowSaveOutcome> => {
        const entries = await load();
        const index = entries.findIndex((entry) => entry.id === workflow.id);
        if (index < 0 && entries.length >= WORKFLOW_LIMITS.workflowsMax) {
          return {
            ok: false,
            error: translate('workflows.limitReached', { max: WORKFLOW_LIMITS.workflowsMax }),
          };
        }
        const saved = structuredClone(workflow);
        await commit(index < 0 ? [...entries, saved] : entries.with(index, saved));
        return { ok: true, workflow: structuredClone(saved) };
      }),
    remove: (id) =>
      enqueue(async () => {
        const entries = await load();
        const next = entries.filter((entry) => entry.id !== id);
        if (next.length === entries.length) return false;
        await commit(next);
        return true;
      }),
  };
}

async function readWorkflows(filePath: string): Promise<Workflow[]> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  let raw: unknown;
  try {
    raw = asRecord(JSON.parse(text))?.workflows;
  } catch {
    raw = undefined;
  }
  if (!Array.isArray(raw)) {
    throw new Error(translate('workflows.corrupt', { file: filePath }));
  }

  const workflows: Workflow[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const parsed = parseWorkflow(item);
    if (!parsed.ok) {
      throw new Error(
        translate('workflows.corruptEntry', { file: filePath, index, error: parsed.error })
      );
    }
    if (seen.has(parsed.workflow.id)) {
      throw new Error(
        translate('workflows.corruptEntry', {
          file: filePath,
          index,
          error: `duplicated id "${parsed.workflow.id}"`,
        })
      );
    }
    seen.add(parsed.workflow.id);
    workflows.push(parsed.workflow);
  }
  return workflows;
}

/** 先写同目录临时文件再 rename 覆盖，进程中途退出也不会留下半截文件。 */
async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8' });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
