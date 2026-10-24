import { asRecord, errorMessage } from '@shared/guards';
import { MODEL_CATALOG } from '@shared/modelCatalog';
import type { ModelProviderView, ProviderImportSource } from '@shared/types/llm';
import type {
  ProviderImportResult,
  ProviderImportSkipped,
  ProviderScanImportsResult,
  ProviderUpsertInput,
} from '../../../../preload/domains/providers';
import { type ProviderStore, type StoredProvider, toProviderView } from '../providerStore';
import {
  isProviderImportSource,
  PROVIDER_IMPORT_SOURCES,
  type ProviderImportScan,
  type ScannedCandidate,
  scanProviderImports,
} from './scan';

/** 扫描结果（含明文 key）在 Main 内存里保留的时长；过期后要重新扫描才能导入。 */
export const IMPORT_CACHE_TTL_MS = 10 * 60_000;

const MAX_CANDIDATE_IDS = 500;
const CANDIDATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `providers:scan-imports` 与 `providers:import` 的实现：入参 `unknown` 收窄，返回 `{ ok }`，不抛异常。 */
export interface ProviderImporter {
  /** 扫描（只读）→ 缓存含 key 的结果 → 返回脱敏候选。 */
  scan(raw: unknown): Promise<ProviderScanImportsResult>;
  /** 按候选 id 从最近一次扫描的缓存取出 → 补默认模型 → 一次写进 providers.json。 */
  import(raw: unknown): Promise<ProviderImportResult>;
}

export function createProviderImporter(deps: {
  store: Pick<ProviderStore, 'list' | 'addMany'>;
  scan?: (
    sources: readonly ProviderImportSource[],
    existing: readonly StoredProvider[]
  ) => Promise<ProviderImportScan>;
  now?: () => number;
}): ProviderImporter {
  const {
    store,
    scan = (sources, existing) => scanProviderImports(sources, { existing }),
    now = Date.now,
  } = deps;
  // 只留最近一次扫描；明文 key 不出 Main，Renderer 只拿到候选 id
  let cache: { expiresAt: number; byId: Map<string, ScannedCandidate> } | null = null;
  // 扫描排队执行：缓存总是最后发起的那次扫描的结果（界面也只认最后一次的返回）
  let tail: Promise<unknown> = Promise.resolve();

  const runScan = async (
    sources: readonly ProviderImportSource[]
  ): Promise<ProviderScanImportsResult> => {
    cache = null;
    try {
      const { candidates, warnings } = await scan(sources, await store.list());
      cache = {
        expiresAt: now() + IMPORT_CACHE_TTL_MS,
        byId: new Map(candidates.map((candidate) => [candidate.view.id, candidate])),
      };
      return { ok: true, candidates: candidates.map((candidate) => candidate.view), warnings };
    } catch (error) {
      return { ok: false, error: `扫描本机配置失败：${errorMessage(error)}` };
    }
  };

  return {
    scan(raw) {
      const sources = parseScanSources(raw);
      if (!sources) return Promise.resolve({ ok: false, error: '无效的扫描参数' });
      const run = tail.then(() => runScan(sources));
      tail = run;
      return run;
    },

    async import(raw) {
      const ids = parseCandidateIds(raw);
      if (!ids) return { ok: false, error: '无效的导入参数' };
      if (!cache || now() >= cache.expiresAt) {
        cache = null;
        return { ok: false, error: '扫描结果已过期，请重新扫描' };
      }
      const picked: ScannedCandidate[] = [];
      for (const id of ids) {
        const candidate = cache.byId.get(id);
        if (!candidate) return { ok: false, error: '候选不在最近一次扫描结果里，请重新扫描' };
        picked.push(candidate);
      }

      let outcomes: Awaited<ReturnType<ProviderStore['addMany']>>;
      try {
        outcomes = await store.addMany(picked.map(({ input }) => withDefaultModels(input)));
      } catch (error) {
        return { ok: false, error: `导入失败：${errorMessage(error)}` };
      }
      const imported: ModelProviderView[] = [];
      const skipped: ProviderImportSkipped[] = [];
      // addMany 的结果与入参一一对应
      for (const [index, outcome] of outcomes.entries()) {
        const { view } = picked[index];
        if (outcome.ok) imported.push(toProviderView(outcome.provider));
        else skipped.push({ id: view.id, name: view.name, reason: outcome.error });
      }
      return { ok: true, imported, skipped };
    },
  };
}

/** 候选没带模型时按协议取内置目录的预置模型；自定义 OpenAI 兼容（Chat Completions）没有预置，保持为空。 */
function withDefaultModels(input: ProviderUpsertInput): ProviderUpsertInput {
  if (input.models.length > 0) return input;
  const template = MODEL_CATALOG.find(
    (entry) => entry.api === input.api && entry.models.length > 0
  );
  return template ? { ...input, models: template.models.map((model) => ({ ...model })) } : input;
}

/** `undefined` / `{}` 为全部来源；`{ sources }` 须是非空的来源数组。 */
function parseScanSources(raw: unknown): ProviderImportSource[] | null {
  if (raw === undefined) return [...PROVIDER_IMPORT_SOURCES];
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((key) => key !== 'sources')) return null;
  const { sources } = record;
  if (sources === undefined) return [...PROVIDER_IMPORT_SOURCES];
  if (!Array.isArray(sources) || sources.length === 0) return null;
  if (sources.length > PROVIDER_IMPORT_SOURCES.length * 2) return null;
  if (!sources.every(isProviderImportSource)) return null;
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
