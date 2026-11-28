import { jaccard } from '../search';
import { contentHash, MEMORY_PROJECT_LIMIT, type MemoryRow } from '../store';
import type { MemoryProjectHandle } from '../toolHost';
import type { ExtractionOperation } from './prompt';

// 应用提炼结果（ARCHITECTURE §7.15「应用规则」）：同步执行，由调用方放进 applyInTransaction。

export const MAX_OPERATIONS = 8;
export const MAX_ADDS = 5;
export const EXTRACTION_CONTENT_MAX = 300;
/** add 与已有 active 条目的相似度达到它就改为 keep */
const DUPLICATE_JACCARD = 0.85;

export interface ApplyContext {
  /** 拼好、已去密钥的材料：evidence 必须能在里面逐字找到 */
  material: string;
  /** 候选集（含被报告过时的条目），update / delete / keep 只认这些 id */
  candidates: readonly MemoryRow[];
  source: {
    taskId: string;
    title: string;
    workspaceId: string;
    coordinatorSessionId: string;
  };
}

export interface ApplySummary {
  added: number;
  updated: number;
  deleted: number;
  kept: number;
  dropped: number;
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

export function applyOperations(
  { store, projectKey }: MemoryProjectHandle,
  operations: readonly ExtractionOperation[],
  context: ApplyContext
): ApplySummary {
  const summary: ApplySummary = { added: 0, updated: 0, deleted: 0, kept: 0, dropped: 0 };
  const material = squash(context.material);
  const candidates = new Map(context.candidates.map((row) => [row.id, row]));
  /** 同一条记忆本轮只处理一次 */
  const touched = new Set<number>();
  const source = {
    sourceKind: 'extraction' as const,
    sourceTaskId: context.source.taskId,
    sourceTitle: context.source.title,
    sourceWorkspaceId: context.source.workspaceId,
    sourceSessionId: context.source.coordinatorSessionId,
  };

  const keep = (id: number) => {
    store.markUsed(projectKey, [id]);
    // 只清 flag，不动 updated_at
    store.db
      .prepare(
        'UPDATE memories SET flagged_at = NULL, flag_note = NULL, flagged_by_session = NULL WHERE project_key = ? AND id = ?'
      )
      .run(projectKey, id);
    summary.kept++;
  };
  /** 去密钥后 1–300 字；不合格返回 undefined */
  const cleanContent = (content: string | undefined) => {
    if (content === undefined) return undefined;
    const text = store.redact(content).trim();
    const size = Array.from(text).length;
    return size >= 1 && size <= EXTRACTION_CONTENT_MAX ? text : undefined;
  };

  let adds = 0;
  for (const operation of operations.slice(0, MAX_OPERATIONS)) {
    const evidence = squash(operation.evidence);
    if (evidence === '' || !material.includes(evidence)) {
      summary.dropped++;
      continue;
    }
    if (operation.op === 'add') {
      const content = cleanContent(operation.content);
      if (adds >= MAX_ADDS || content === undefined || operation.category === undefined) {
        summary.dropped++;
        continue;
      }
      adds++;
      const active = store.byStatus(projectKey, 'active');
      const same = store.findByHash(projectKey, contentHash(content));
      const similar =
        same ?? active.find((row) => jaccard(row.content, content) >= DUPLICATE_JACCARD);
      if (similar) {
        if (similar.status === 'active' && !touched.has(similar.id)) {
          touched.add(similar.id);
          keep(similar.id);
        } else summary.dropped++;
        continue;
      }
      if (store.count(projectKey) >= MEMORY_PROJECT_LIMIT) {
        summary.dropped++;
        continue;
      }
      const row = store.insert(projectKey, {
        ...source,
        category: operation.category,
        content,
        ...(operation.files ? { files: operation.files } : {}),
        evidence: operation.evidence.trim(),
      });
      touched.add(row.id);
      summary.added++;
      continue;
    }

    const target = operation.id === undefined ? undefined : candidates.get(operation.id);
    const current = target && store.get(projectKey, target.id);
    if (current?.status !== 'active' || touched.has(current.id)) {
      summary.dropped++;
      continue;
    }
    // 用户钉住或用户来源的条目只接受 keep
    const protectedRow = current.pinned === 1 || current.source_kind === 'user';
    if (operation.op === 'keep') {
      touched.add(current.id);
      keep(current.id);
      continue;
    }
    if (protectedRow) {
      summary.dropped++;
      continue;
    }
    if (operation.op === 'delete') {
      touched.add(current.id);
      store.setStatus(projectKey, current.id, 'disabled', operation.evidence.trim());
      summary.deleted++;
      continue;
    }
    // update
    const content = cleanContent(operation.content);
    const duplicate = content && store.findByHash(projectKey, contentHash(content));
    if (content === undefined || (duplicate && duplicate.id !== current.id)) {
      summary.dropped++;
      continue;
    }
    touched.add(current.id);
    store.update(projectKey, current.id, {
      ...source,
      content,
      ...(operation.category ? { category: operation.category } : {}),
      ...(operation.files ? { files: operation.files } : {}),
      evidence: operation.evidence.trim(),
      clearFlag: true,
    });
    summary.updated++;
  }
  return summary;
}
