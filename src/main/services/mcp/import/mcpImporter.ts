import { asRecord, errorMessage } from '@shared/guards';
import type { McpImportSource, McpServerEntryView } from '@shared/types/llm';
import type {
  McpImportCandidatesResult,
  McpImportSkipped,
  McpScanImportsResult,
} from '../../../../preload/domains/mcp';
import { translate } from '../../../i18n';
import {
  type McpAddOutcome,
  type McpRegistry,
  type StoredMcpServer,
  toMcpServerView,
} from '../mcpRegistry';
import {
  isMcpImportSource,
  MCP_IMPORT_SOURCES,
  type McpImportScan,
  type ScannedMcpCandidate,
  scanMcpImports,
} from './scan';

/** 扫描结果（含 env / headers 明文）在 Main 内存里保留的时长；过期后要重新扫描才能导入。 */
export const IMPORT_CACHE_TTL_MS = 10 * 60_000;

const MAX_CANDIDATE_IDS = 500;
const CANDIDATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `mcp:scan-imports` 与 `mcp:import` 的实现：入参 `unknown` 收窄，返回 `{ ok }`，不抛异常。 */
export interface McpImporter {
  /** 扫描（只读）→ 缓存含 env / headers 的结果 → 返回脱敏候选。 */
  scan(raw: unknown): Promise<McpScanImportsResult>;
  /** 按候选 id 从最近一次扫描的缓存取出 → 一次写进 mcp.json（默认启用，重名加后缀）。 */
  import(raw: unknown): Promise<McpImportCandidatesResult>;
}

export function createMcpImporter(deps: {
  registry: Pick<McpRegistry, 'list' | 'addMany'>;
  scan?: (
    sources: readonly McpImportSource[],
    existing: readonly StoredMcpServer[]
  ) => Promise<McpImportScan>;
  now?: () => number;
}): McpImporter {
  const {
    registry,
    scan = (sources, existing) => scanMcpImports(sources, { existing }),
    now = Date.now,
  } = deps;
  // 只留最近一次扫描；env / headers 明文不出 Main，Renderer 只拿到候选 id
  let cache: { expiresAt: number; byId: Map<string, ScannedMcpCandidate> } | null = null;
  // 扫描排队执行：缓存总是最后发起的那次扫描的结果（界面也只认最后一次的返回）
  let tail: Promise<unknown> = Promise.resolve();

  const runScan = async (sources: readonly McpImportSource[]): Promise<McpScanImportsResult> => {
    cache = null;
    try {
      const { candidates, warnings } = await scan(sources, await registry.list());
      cache = {
        expiresAt: now() + IMPORT_CACHE_TTL_MS,
        byId: new Map(candidates.map((candidate) => [candidate.view.id, candidate])),
      };
      return { ok: true, candidates: candidates.map((candidate) => candidate.view), warnings };
    } catch (error) {
      return {
        ok: false,
        error: translate('importers.scanFailed', { error: errorMessage(error) }),
      };
    }
  };

  return {
    scan(raw) {
      const sources = parseScanSources(raw);
      if (!sources)
        return Promise.resolve({ ok: false, error: translate('importers.invalidScanArgs') });
      const run = tail.then(() => runScan(sources));
      tail = run;
      return run;
    },

    async import(raw) {
      const ids = parseCandidateIds(raw);
      if (!ids) return { ok: false, error: translate('importers.invalidImportArgs') };
      if (!cache || now() >= cache.expiresAt) {
        cache = null;
        return { ok: false, error: translate('importers.scanStale') };
      }
      const picked: ScannedMcpCandidate[] = [];
      for (const id of ids) {
        const candidate = cache.byId.get(id);
        if (!candidate) return { ok: false, error: translate('importers.candidateMissing') };
        picked.push(candidate);
      }

      let outcomes: McpAddOutcome[];
      try {
        outcomes = await registry.addMany(picked.map(({ server }) => server));
      } catch (error) {
        return {
          ok: false,
          error: translate('common.importFailed', { error: errorMessage(error) }),
        };
      }
      const imported: McpServerEntryView[] = [];
      const skipped: McpImportSkipped[] = [];
      // addMany 的结果与入参一一对应
      for (const [index, outcome] of outcomes.entries()) {
        const { view } = picked[index];
        if (outcome.ok) imported.push(toMcpServerView(outcome.server));
        else skipped.push({ id: view.id, name: view.name, reason: outcome.error });
      }
      return { ok: true, imported, skipped };
    },
  };
}

/** `undefined` / `{}` 为全部来源；`{ sources }` 须是非空的来源数组。 */
function parseScanSources(raw: unknown): McpImportSource[] | null {
  if (raw === undefined) return [...MCP_IMPORT_SOURCES];
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((key) => key !== 'sources')) return null;
  const { sources } = record;
  if (sources === undefined) return [...MCP_IMPORT_SOURCES];
  if (!Array.isArray(sources) || sources.length === 0) return null;
  if (sources.length > MCP_IMPORT_SOURCES.length * 2) return null;
  if (!sources.every(isMcpImportSource)) return null;
  return [...new Set(sources)];
}

/** `{ candidateIds }`：非空、每个都是扫描时发的 UUID；任何一项不合格整个请求作废。 */
function parseCandidateIds(raw: unknown): string[] | null {
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((key) => key !== 'candidateIds')) return null;
  const { candidateIds } = record;
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) return null;
  if (candidateIds.length > MAX_CANDIDATE_IDS) return null;
  if (!candidateIds.every((id) => typeof id === 'string' && CANDIDATE_ID.test(id))) return null;
  return [...new Set(candidateIds as string[])];
}
