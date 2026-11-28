import type { SessionProfile } from '@fynvra/core';
import { jaccard, rankDocs } from './search';
import {
  contentHash,
  lastTouched,
  type MemoryRow,
  type MemoryStore,
  MemoryStoreError,
  parseFiles,
} from './store';
import {
  parseFeedbackInput,
  parseSearchInput,
  parseWriteInput,
  type WriteInput,
} from './toolInput';

// project_memory_* 工具的宿主（ARCHITECTURE §7.15「工具与宿主」「权限矩阵」）：权限只在这里判断一次，永不抛错。

export interface MemoryCaller {
  sessionId: string;
  workspaceId: string;
  /** 派发的 worker（含工作流节点）有 */
  dispatchId?: string;
  /** 档位会话（triage / restricted） */
  profile?: SessionProfile;
  /** 会话或任务标题快照，作出处 */
  title?: string;
}

export type MemoryToolResult = { ok: true; result?: unknown } | { ok: false; error: string };

export type MemoryProjectHandle = { store: MemoryStore; projectKey: string };

export interface MemoryToolContext {
  /** 总开关 */
  enabled(): boolean;
  /** 打开会话工作区对应的项目（写入前刷新已知密钥）；库不可用或工作区不存在时返回错误文本 */
  open(workspaceId: string): Promise<MemoryProjectHandle | { error: string }>;
  /** 本会话最近的用户消息（pi jsonl 投影） */
  recentUserMessages(sessionId: string): Promise<string[]>;
  /** 有写入后通知 */
  changed(projectKey: string, workspaceId: string): void;
}

/** add 时关键词相似的阈值 */
const SIMILAR_THRESHOLD = 0.5;
const QUOTE_MESSAGES = 20;

const brief = (row: MemoryRow) => ({
  id: row.id,
  category: row.category,
  content: row.content,
  ...(row.pinned ? { pinned: true } : {}),
  ...(row.flagged_at ? { reportedOutdated: row.flag_note ?? true } : {}),
});

const detail = (row: MemoryRow) => ({
  ...brief(row),
  status: row.status,
  pinned: row.pinned === 1,
  files: parseFiles(row.files),
  source: {
    kind: row.source_kind,
    ...(row.source_title ? { title: row.source_title } : {}),
    ...(row.source_task_id ? { taskId: row.source_task_id } : {}),
    ...(row.evidence ? { evidence: row.evidence } : {}),
  },
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
  ...(row.last_used_at ? { lastUsedAt: new Date(row.last_used_at).toISOString() } : {}),
  useCount: row.use_count,
  ...(row.disabled_reason ? { disabledReason: row.disabled_reason } : {}),
});

const notFound = (id: number) => `memory #${id} not found in this project`;

function storeError(error: unknown, id?: number): string {
  if (!(error instanceof MemoryStoreError)) {
    return `project memory failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  switch (error.code) {
    case 'limit':
      return 'project memory is full (500 entries); update or delete old entries first';
    case 'duplicate':
      return 'another memory entry already has the same content';
    default:
      return notFound(id ?? 0);
  }
}

export function createMemoryToolHost(ctx: MemoryToolContext) {
  /** quote 去首尾空白后逐字出现在本会话最近 20 条用户消息里才算通过 */
  async function verifyQuote(sessionId: string, quote: string | undefined): Promise<boolean> {
    if (!quote) return false;
    try {
      const messages = await ctx.recentUserMessages(sessionId);
      return messages.slice(-QUOTE_MESSAGES).some((message) => message.includes(quote));
    } catch {
      return false;
    }
  }

  async function write(
    caller: MemoryCaller,
    project: MemoryProjectHandle,
    input: WriteInput
  ): Promise<MemoryToolResult> {
    const { store, projectKey } = project;
    const quoted = await verifyQuote(caller.sessionId, input.quote);
    const userSource = quoted
      ? ({ sourceKind: 'user', pinned: true, evidence: input.quote } as const)
      : undefined;

    if (input.action === 'add') {
      const content = store.redact(input.content as string);
      const existing = store.findByHash(projectKey, contentHash(content));
      if (existing) {
        store.markUsed(projectKey, [existing.id]);
        return {
          ok: true,
          result: {
            status: 'exists',
            note: 'Not added: same content already stored.',
            memory: detail(store.get(projectKey, existing.id) ?? existing),
          },
        };
      }
      if (!input.force) {
        const similar = store
          .byStatus(projectKey, 'active')
          .filter((row) => jaccard(row.content, content) >= SIMILAR_THRESHOLD)
          .map(brief);
        if (similar.length > 0) {
          return {
            ok: true,
            result: {
              status: 'similar',
              note: 'Not added: similar entries exist. Update or delete them, or retry with force: true if this one is really new.',
              candidates: similar,
            },
          };
        }
      }
      const row = store.insert(projectKey, {
        category: input.category as NonNullable<WriteInput['category']>,
        content,
        files: input.files,
        sourceKind: 'agent',
        sourceSessionId: caller.sessionId,
        sourceWorkspaceId: caller.workspaceId,
        sourceTitle: caller.title,
        ...userSource,
      });
      return { ok: true, result: { status: 'added', memory: detail(row) } };
    }

    const id = input.id as number;
    const row = store.get(projectKey, id);
    if (!row) return { ok: false, error: notFound(id) };
    if (row.pinned && !quoted) {
      return {
        ok: false,
        error: `memory #${id} is pinned by the user; changing it needs the user's exact words in quote`,
      };
    }
    if (input.action === 'delete') {
      store.remove(projectKey, id);
      return { ok: true, result: { status: 'deleted', id } };
    }
    const updated = store.update(projectKey, id, {
      content: input.content,
      category: input.category,
      files: input.files,
      sourceSessionId: caller.sessionId,
      sourceWorkspaceId: caller.workspaceId,
      sourceTitle: caller.title,
      ...userSource,
    });
    return { ok: true, result: { status: 'updated', memory: detail(updated) } };
  }

  function search(project: MemoryProjectHandle, raw: unknown): MemoryToolResult {
    const parsed = parseSearchInput(raw);
    if (!parsed.ok) return parsed;
    const { store, projectKey } = project;
    const { ids, query, category, limit } = parsed.value;
    if (ids) {
      // 先记使用再读，返回的是记过之后的状态
      store.markUsed(projectKey, ids);
      const rows = ids.map((id) => store.get(projectKey, id)).filter((row) => row !== undefined);
      const found = new Set(rows.map((row) => row.id));
      const missing = ids.filter((id) => !found.has(id));
      return {
        ok: true,
        result: { memories: rows.map(detail), ...(missing.length ? { notFound: missing } : {}) },
      };
    }
    const active = store
      .byStatus(projectKey, 'active')
      .filter((row) => !category || row.category === category);
    let hits: MemoryRow[];
    if (query) {
      const byId = new Map(active.map((row) => [row.id, row]));
      const ranked = rankDocs(
        active.map((row) => ({
          id: row.id,
          content: row.content,
          category: row.category,
          files: parseFiles(row.files),
        })),
        query
      );
      hits = ranked.flatMap(({ id }) => byId.get(id) ?? []);
    } else {
      hits = [...active].sort((a, b) => lastTouched(b) - lastTouched(a));
    }
    return {
      ok: true,
      result: {
        total: hits.length,
        memories: hits.slice(0, limit).map((row) => ({
          ...brief(row),
          ...(row.files !== '[]' ? { files: parseFiles(row.files) } : {}),
        })),
      },
    };
  }

  async function handle(
    caller: MemoryCaller,
    method: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<MemoryToolResult> {
    try {
      if (signal?.aborted) return { ok: false, error: 'aborted' };
      if (caller.profile)
        return { ok: false, error: 'project memory is not available in this session' };
      if (!ctx.enabled()) return { ok: false, error: 'project memory is turned off in settings' };
      if (method !== 'write' && method !== 'search' && method !== 'feedback') {
        return { ok: false, error: `unknown project memory method: ${method}` };
      }
      const worker = caller.dispatchId !== undefined;
      if (method === 'write' && worker) {
        return { ok: false, error: 'workers cannot write project memory' };
      }
      // 先校验入参再打开库，坏参数不碰数据库
      const writeInput = method === 'write' ? parseWriteInput(input) : undefined;
      if (writeInput && !writeInput.ok) return writeInput;
      const feedbackInput = method === 'feedback' ? parseFeedbackInput(input) : undefined;
      if (feedbackInput && !feedbackInput.ok) return feedbackInput;

      const project = await ctx.open(caller.workspaceId);
      if ('error' in project) return { ok: false, error: project.error };
      const changed = () => ctx.changed(project.projectKey, caller.workspaceId);

      if (writeInput?.ok) {
        try {
          const result = await write(caller, project, writeInput.value);
          if (result.ok) changed();
          return result;
        } catch (error) {
          return { ok: false, error: storeError(error, writeInput.value.id) };
        }
      }
      if (feedbackInput?.ok) {
        const { id, verdict, note } = feedbackInput.value;
        const { store, projectKey } = project;
        if (!store.get(projectKey, id)) return { ok: false, error: notFound(id) };
        if (verdict === 'useful') {
          store.markUsed(projectKey, [id]);
        } else if (worker) {
          store.flag(projectKey, id, note, caller.sessionId);
        } else {
          store.setStatus(projectKey, id, 'disabled', note ?? 'reported outdated');
        }
        changed();
        const status =
          verdict === 'useful' ? 'recorded' : worker ? 'flagged for review' : 'disabled';
        return { ok: true, result: { status, id } };
      }
      const result = search(project, input);
      if (result.ok && Array.isArray((input as { ids?: unknown } | undefined)?.ids)) changed();
      return result;
    } catch (error) {
      return { ok: false, error: storeError(error) };
    }
  }

  return { handle };
}
