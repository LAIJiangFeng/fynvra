import { type CoreFs, isNotFoundError } from '../fs';
import { isDispatchOutcome, isMessageType, isTaskStatus } from '../guards';
import { errorMessage, parentDir, writeFileAtomic } from '../internal/files';
import type { Dispatch, Message, Run, Task, Worktree } from '../types';
import { canTransitionTask, isDispatchSettled } from './transitions';

/** 表操作结果。 */
export type EntityResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * 一类实体的增删改查。读写都按值拷贝：修改入参或返回值不影响存储；值为 `undefined` 的字段不落库。
 * 各表的不变量（如任务状态迁移）在 insert / update 时校验，违反时返回错误。
 */
export interface EntityTable<T extends { id: string }> {
  /** 新增；`id` 为空或已存在返回错误。 */
  insert(entity: T): EntityResult<T>;
  /** 按 id 取；不存在返回 `undefined`。 */
  get(id: string): T | undefined;
  /** 浅合并 `patch`（`id` 不可改，值为 `undefined` 的字段被删除）；不存在返回错误。 */
  update(id: string, patch: Partial<Omit<T, 'id'>>): EntityResult<T>;
  /** 删除；返回删除前是否存在。 */
  delete(id: string): boolean;
  /** 按插入顺序列出，可选过滤。 */
  list(filter?: (entity: T) => boolean): T[];
}

/** 当前快照格式版本。 */
export const ORCHESTRATION_SNAPSHOT_VERSION = 1;

/** 编排状态的 JSON 快照（`userData/orchestration.json`）。 */
export interface OrchestrationSnapshot {
  /** 格式版本；读取时不等于 {@link ORCHESTRATION_SNAPSHOT_VERSION} 即拒绝。 */
  version: typeof ORCHESTRATION_SNAPSHOT_VERSION;
  runs: Run[];
  tasks: Task[];
  dispatches: Dispatch[];
  worktrees: Worktree[];
  messages: Message[];
}

/**
 * 编排状态仓库：Run / Task / Dispatch / Worktree / Message 五张表 + 编排查询。
 *
 * 表级不变量：
 * - `tasks.update` 改 `status` 必须符合 {@link canTransitionTask}；
 * - 同一任务同时最多一个未结算的 dispatch；已结算的 dispatch 不可再改；`settledAt` 与 `outcome` 同时出现；
 * - `status` / `outcome` / 消息 `type` 必须是合法枚举值。
 * 不校验跨表引用（如 `task.runId` 是否存在）。
 */
export interface OrchestrationStore {
  /** 编排（命名空间 + 收件箱）。 */
  readonly runs: EntityTable<Run>;
  /** 任务；改 `status` 走迁移表。 */
  readonly tasks: EntityTable<Task>;
  /** 任务尝试；同一任务最多一个未结算，结算后不可改。 */
  readonly dispatches: EntityTable<Dispatch>;
  /** 仍登记在案（未清理）的 worktree。 */
  readonly worktrees: EntityTable<Worktree>;
  /** 收件箱消息；通常经 `Inbox` 读写。 */
  readonly messages: EntityTable<Message>;
  /** 某次 run 的全部任务（插入顺序）。 */
  listTasks(runId: string): Task[];
  /** 任务当前未结算的 dispatch（权威尝试）；没有返回 `undefined`。 */
  activeDispatch(taskId: string): Dispatch | undefined;
  /**
   * 还欠一次清理决定的尝试：属于该 run、已结算、worktree 仍登记在 `worktrees` 表里，
   * 且该 worktree 上没有进行中的后续尝试。同一 worktree 只报最近结算的那次。
   * worktree 清理后从 `worktrees` 表删除即不再出现。
   */
  reclaimableDispatches(runId: string): Dispatch[];
  /** 全部状态的深拷贝。 */
  snapshot(): OrchestrationSnapshot;
}

/** 写快照的结果。 */
export type PersistResult = { ok: true } | { ok: false; error: string };
/** 读快照的结果；`found: false` 表示文件不存在（状态保持不变）。 */
export type LoadResult = { ok: true; found: boolean } | { ok: false; error: string };
/** {@link parseOrchestrationSnapshot} 的结果。 */
export type ParseSnapshotResult =
  | { ok: true; snapshot: OrchestrationSnapshot }
  | { ok: false; error: string };

type Validator<T> = (next: T, previous: T | undefined) => string | undefined;

function copy<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(structuredClone(value)).filter(([, field]) => field !== undefined)
  ) as T;
}

class Table<T extends { id: string }> implements EntityTable<T> {
  readonly #rows = new Map<string, T>();
  readonly #kind: string;
  readonly #validate: Validator<T>;

  constructor(kind: string, validate: Validator<T> = () => undefined) {
    this.#kind = kind;
    this.#validate = validate;
  }

  insert(entity: T): EntityResult<T> {
    const next = copy(entity);
    if (typeof next.id !== 'string' || next.id === '') {
      return { ok: false, error: `${this.#kind}.id must be a non-empty string` };
    }
    if (this.#rows.has(next.id)) {
      return { ok: false, error: `${this.#kind} ${next.id} already exists` };
    }
    return this.#commit(next, undefined);
  }

  get(id: string): T | undefined {
    const row = this.#rows.get(id);
    return row === undefined ? undefined : structuredClone(row);
  }

  update(id: string, patch: Partial<Omit<T, 'id'>>): EntityResult<T> {
    const current = this.#rows.get(id);
    if (current === undefined) return { ok: false, error: `${this.#kind} ${id} not found` };
    return this.#commit(copy({ ...current, ...patch, id: current.id }), current);
  }

  delete(id: string): boolean {
    return this.#rows.delete(id);
  }

  list(filter?: (entity: T) => boolean): T[] {
    const rows = [...this.#rows.values()].map((row) => structuredClone(row));
    return filter === undefined ? rows : rows.filter(filter);
  }

  /** 包内：不拷贝地遍历（只读）。 */
  values(): IterableIterator<T> {
    return this.#rows.values();
  }

  /** 包内：是否存在。 */
  has(id: string): boolean {
    return this.#rows.has(id);
  }

  /** 包内：用已校验过的行整体替换内容，保留表对象本身。 */
  replaceAll(rows: readonly T[]): void {
    this.#rows.clear();
    for (const row of rows) this.#rows.set(row.id, structuredClone(row));
  }

  #commit(next: T, previous: T | undefined): EntityResult<T> {
    const error = this.#validate(next, previous);
    if (error !== undefined) return { ok: false, error };
    this.#rows.set(next.id, next);
    return { ok: true, value: structuredClone(next) };
  }
}

interface Tables {
  runs: Table<Run>;
  tasks: Table<Task>;
  dispatches: Table<Dispatch>;
  worktrees: Table<Worktree>;
  messages: Table<Message>;
}

function createTables(): Tables {
  const dispatches: Table<Dispatch> = new Table('dispatch', (next, previous) => {
    if (previous !== undefined && isDispatchSettled(previous)) {
      return `dispatch ${next.id} is already settled and can no longer change`;
    }
    if ((next.settledAt === undefined) !== (next.outcome === undefined)) {
      return `dispatch ${next.id}: settledAt and outcome must be set together`;
    }
    if (next.outcome !== undefined && !isDispatchOutcome(next.outcome)) {
      return `dispatch ${next.id}: invalid outcome ${JSON.stringify(next.outcome)}`;
    }
    if (!isDispatchSettled(next)) {
      for (const other of dispatches.values()) {
        if (other.id !== next.id && other.taskId === next.taskId && !isDispatchSettled(other)) {
          return `task ${next.taskId} already has an active dispatch (${other.id})`;
        }
      }
    }
    return undefined;
  });

  return {
    runs: new Table('run'),
    tasks: new Table('task', (next, previous) => {
      if (!isTaskStatus(next.status)) {
        return `task ${next.id}: invalid status ${JSON.stringify(next.status)}`;
      }
      if (
        previous !== undefined &&
        previous.status !== next.status &&
        !canTransitionTask(previous.status, next.status)
      ) {
        return `task ${next.id}: illegal transition ${previous.status} → ${next.status}`;
      }
      return undefined;
    }),
    dispatches,
    worktrees: new Table('worktree'),
    messages: new Table('message', (next) =>
      isMessageType(next.type)
        ? undefined
        : `message ${next.id}: invalid type ${JSON.stringify(next.type)}`
    ),
  };
}

function snapshotOf(tables: Tables): OrchestrationSnapshot {
  return {
    version: ORCHESTRATION_SNAPSHOT_VERSION,
    runs: tables.runs.list(),
    tasks: tables.tasks.list(),
    dispatches: tables.dispatches.list(),
    worktrees: tables.worktrees.list(),
    messages: tables.messages.list(),
  };
}

/**
 * 内存实现 + JSON 快照持久化。`persistTo` 按调用顺序串行写（各自写调用那一刻的状态），
 * 原子替换目标文件；`loadFrom` 整体替换内容，失败时现有状态不变。两者都不抛异常。
 */
export class InMemoryOrchestrationStore implements OrchestrationStore {
  readonly #tables = createTables();
  #pendingWrite: Promise<unknown> = Promise.resolve();

  readonly runs: EntityTable<Run> = this.#tables.runs;
  readonly tasks: EntityTable<Task> = this.#tables.tasks;
  readonly dispatches: EntityTable<Dispatch> = this.#tables.dispatches;
  readonly worktrees: EntityTable<Worktree> = this.#tables.worktrees;
  readonly messages: EntityTable<Message> = this.#tables.messages;

  listTasks(runId: string): Task[] {
    return this.tasks.list((task) => task.runId === runId);
  }

  activeDispatch(taskId: string): Dispatch | undefined {
    for (const dispatch of this.#tables.dispatches.values()) {
      if (dispatch.taskId === taskId && !isDispatchSettled(dispatch))
        return structuredClone(dispatch);
    }
    return undefined;
  }

  reclaimableDispatches(runId: string): Dispatch[] {
    const taskIds = new Set(this.listTasks(runId).map((task) => task.id));
    const latestByWorktree = new Map<string, Dispatch>();
    const busyWorktrees = new Set<string>();
    for (const dispatch of this.#tables.dispatches.values()) {
      if (!taskIds.has(dispatch.taskId) || !this.#tables.worktrees.has(dispatch.worktreeId))
        continue;
      if (!isDispatchSettled(dispatch)) {
        busyWorktrees.add(dispatch.worktreeId);
        continue;
      }
      const latest = latestByWorktree.get(dispatch.worktreeId);
      if (latest === undefined || (latest.settledAt ?? 0) <= (dispatch.settledAt ?? 0)) {
        latestByWorktree.set(dispatch.worktreeId, dispatch);
      }
    }
    return [...latestByWorktree.values()]
      .filter((dispatch) => !busyWorktrees.has(dispatch.worktreeId))
      .map((dispatch) => structuredClone(dispatch));
  }

  snapshot(): OrchestrationSnapshot {
    return snapshotOf(this.#tables);
  }

  /** 把当前状态原子写到 `path`（自动创建父目录）。 */
  persistTo(path: string, fs: CoreFs): Promise<PersistResult> {
    const content = `${JSON.stringify(this.snapshot(), null, 2)}\n`;
    const write = this.#pendingWrite.then(async (): Promise<PersistResult> => {
      try {
        await fs.mkdir(parentDir(path), { recursive: true });
        await writeFileAtomic(fs, path, content);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: `failed to write ${path}: ${errorMessage(error)}` };
      }
    });
    this.#pendingWrite = write;
    return write;
  }

  /** 从 `path` 读快照并整体替换当前状态；文件不存在时 `found: false`、状态不变。 */
  async loadFrom(path: string, fs: CoreFs): Promise<LoadResult> {
    let text: string;
    try {
      text = await fs.readFile(path, 'utf8');
    } catch (error) {
      if (isNotFoundError(error)) return { ok: true, found: false };
      return { ok: false, error: `failed to read ${path}: ${errorMessage(error)}` };
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      return { ok: false, error: `${path} is not valid JSON: ${errorMessage(error)}` };
    }
    const parsed = parseOrchestrationSnapshot(data);
    if (!parsed.ok) return { ok: false, error: `${path}: ${parsed.error}` };
    const tables = this.#tables;
    tables.runs.replaceAll(parsed.snapshot.runs);
    tables.tasks.replaceAll(parsed.snapshot.tasks);
    tables.dispatches.replaceAll(parsed.snapshot.dispatches);
    tables.worktrees.replaceAll(parsed.snapshot.worktrees);
    tables.messages.replaceAll(parsed.snapshot.messages);
    return { ok: true, found: true };
  }
}

// ---- 快照解析 ----

type Check = (value: unknown) => boolean;
/** 每个字段一个校验；可选字段写成 `{ optional: check }`。键与可选性由类型强制和 §4 对齐。 */
type Schema<T> = { [K in keyof T]-?: undefined extends T[K] ? { optional: Check } : Check };

const isString: Check = (value) => typeof value === 'string';
const isNumber: Check = (value) => typeof value === 'number' && Number.isFinite(value);
const isStringArray: Check = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const RUN_SCHEMA: Schema<Run> = {
  id: isString,
  workspaceId: isString,
  coordinatorSessionId: isString,
  objective: isString,
  createdAt: isNumber,
};
const TASK_SCHEMA: Schema<Task> = {
  id: isString,
  runId: isString,
  title: isString,
  spec: isString,
  roleId: isString,
  status: isTaskStatus,
  dependsOn: isStringArray,
};
const DISPATCH_SCHEMA: Schema<Dispatch> = {
  id: isString,
  taskId: isString,
  workerSessionId: isString,
  worktreeId: isString,
  branch: isString,
  startedAt: isNumber,
  settledAt: { optional: isNumber },
  outcome: { optional: isDispatchOutcome },
  summary: { optional: isString },
  filesModified: { optional: isStringArray },
};
const WORKTREE_SCHEMA: Schema<Worktree> = {
  id: isString,
  workspaceId: isString,
  path: isString,
  branch: isString,
  baseRef: isString,
  baseCommit: isString,
};
const MESSAGE_SCHEMA: Schema<Message> = {
  id: isString,
  runId: isString,
  dispatchId: { optional: isString },
  from: isString,
  to: isString,
  type: isMessageType,
  subject: { optional: isString },
  body: isString,
  replyTo: { optional: isString },
  createdAt: isNumber,
  ackedAt: { optional: isNumber },
};
class SnapshotError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEntity<T>(input: unknown, schema: Schema<T>, label: string): T {
  if (!isRecord(input)) throw new SnapshotError(`${label} must be an object`);
  const entity: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries<Check | { optional: Check }>(schema)) {
    const value = Object.hasOwn(input, key) ? input[key] : undefined;
    const optional = typeof spec !== 'function';
    if (value === undefined && optional) continue;
    if (!(optional ? spec.optional : spec)(value)) {
      throw new SnapshotError(`${label}.${key} is missing or invalid`);
    }
    entity[key] = value;
  }
  return entity as T;
}

function insertAll<T extends { id: string }>(
  table: Table<T>,
  input: unknown,
  name: string,
  schema: Schema<T>
): void {
  if (input === undefined) return;
  if (!Array.isArray(input)) throw new SnapshotError(`${name} must be an array`);
  input.forEach((item, index) => {
    const result = table.insert(readEntity(item, schema, `${name}[${index}]`));
    if (!result.ok) throw new SnapshotError(`${name}[${index}]: ${result.error}`);
  });
}

/**
 * 校验快照：版本、字段类型、枚举值和表级不变量，并丢弃未知字段；缺省的表视为空。不抛异常。
 */
export function parseOrchestrationSnapshot(input: unknown): ParseSnapshotResult {
  try {
    if (!isRecord(input)) throw new SnapshotError('snapshot must be an object');
    if (input.version !== ORCHESTRATION_SNAPSHOT_VERSION) {
      throw new SnapshotError(
        `unsupported snapshot version ${JSON.stringify(input.version)} (expected ${ORCHESTRATION_SNAPSHOT_VERSION})`
      );
    }
    const tables = createTables();
    insertAll(tables.runs, input.runs, 'runs', RUN_SCHEMA);
    insertAll(tables.tasks, input.tasks, 'tasks', TASK_SCHEMA);
    insertAll(tables.dispatches, input.dispatches, 'dispatches', DISPATCH_SCHEMA);
    insertAll(tables.worktrees, input.worktrees, 'worktrees', WORKTREE_SCHEMA);
    insertAll(tables.messages, input.messages, 'messages', MESSAGE_SCHEMA);
    return { ok: true, snapshot: snapshotOf(tables) };
  } catch (error) {
    if (error instanceof SnapshotError) return { ok: false, error: error.message };
    throw error;
  }
}
