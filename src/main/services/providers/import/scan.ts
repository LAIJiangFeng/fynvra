import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { errorMessage } from '@shared/guards';
import type { ProviderImportCandidate, ProviderImportSource } from '@shared/types/llm';
import type { ProviderUpsertInput } from '../../../../preload/domains/providers';
import { MAX_NAME_LENGTH, parseProviderUpsert } from '../parseProviderInput';
import { apiKeyHint, providerFingerprint, type StoredProvider } from '../providerStore';
import {
  type ImportSourcePaths,
  locateImportSources,
  readCcSwitchRows,
  readTextIfExists,
} from './locate';
import { readCcSwitch } from './readers/ccSwitch';
import { readClaudeCode } from './readers/claudeCode';
import { readCodex } from './readers/codex';
import type { DiscoveredProvider, Env, ReaderResult } from './readers/common';

// 「从本机导入」分三层：定位（locate.ts）→ 读取（readers/，纯函数）→ 编排去重（本文件）。
// 各来源并行读取；单个来源失败只变成它自己的一条 warning，不影响其它来源。

/** 全部来源。顺序就是去重的优先级：地址和 key 相同的候选保留排在前面的。 */
export const PROVIDER_IMPORT_SOURCES: readonly ProviderImportSource[] = [
  'claude-code',
  'codex',
  'cc-switch',
];

const SOURCE_LABELS: Readonly<Record<ProviderImportSource, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'cc-switch': 'CC Switch',
};

export function isProviderImportSource(value: unknown): value is ProviderImportSource {
  return (PROVIDER_IMPORT_SOURCES as readonly unknown[]).includes(value);
}

export interface ScannedCandidate {
  /** 给 Renderer 的脱敏视图 */
  view: ProviderImportCandidate;
  /** 已按 providers:upsert 的规则校验过的新建入参（含明文 key），导入时直接用 */
  input: ProviderUpsertInput;
}

export interface ProviderImportScan {
  candidates: ScannedCandidate[];
  warnings: string[];
}

export interface ScanOptions {
  /** 已有的模型服务，用来标出重复 */
  existing?: readonly StoredProvider[];
  home?: string;
  env?: Env;
  /** CC Switch 库副本放的临时目录 */
  tempDir?: string;
}

/** 扫描本机配置（只读）。`sources` 缺省为全部来源，传入的顺序不影响结果顺序。 */
export async function scanProviderImports(
  sources: readonly ProviderImportSource[] = PROVIDER_IMPORT_SOURCES,
  options: ScanOptions = {}
): Promise<ProviderImportScan> {
  const { existing = [], home = homedir(), env = process.env, tempDir = tmpdir() } = options;
  const paths = locateImportSources(home);
  const selected = PROVIDER_IMPORT_SOURCES.filter((source) => sources.includes(source));
  const results = await Promise.all(
    selected.map((source) =>
      readSource(source, paths, env, tempDir).catch(
        (error): ReaderResult => ({
          providers: [],
          warnings: [`${SOURCE_LABELS[source]}：读取失败（${errorMessage(error)}）`],
        })
      )
    )
  );
  const warnings = results.flatMap((result) => result.warnings);
  const discovered = results.flatMap((result) => result.providers);
  return { candidates: toCandidates(discovered, existing, warnings), warnings };
}

const NOTHING: ReaderResult = { providers: [], warnings: [] };

async function readSource(
  source: ProviderImportSource,
  paths: ImportSourcePaths,
  env: Env,
  tempDir: string
): Promise<ReaderResult> {
  switch (source) {
    case 'claude-code': {
      const settings = await readTextIfExists(paths.claudeSettings);
      return settings === null ? NOTHING : readClaudeCode(settings);
    }
    case 'codex': {
      const [config, auth] = await Promise.all([
        readTextIfExists(paths.codexConfig),
        readTextIfExists(paths.codexAuth),
      ]);
      return config === null && auth === null ? NOTHING : readCodex({ config, auth, env });
    }
    case 'cc-switch': {
      const rows = await readCcSwitchRows(paths.ccSwitchDb, tempDir);
      return rows === null ? NOTHING : readCcSwitch(rows, env);
    }
  }
}

/**
 * 校验并去重：每个候选按 providers:upsert 的规则校验（不合规的跳过并记 warning），所以列出来的都能导入；
 * 与已有服务地址和 key 都相同的标 existing，与排在前面的候选相同的标 candidate。
 */
function toCandidates(
  discovered: readonly DiscoveredProvider[],
  existing: readonly StoredProvider[],
  warnings: string[]
): ScannedCandidate[] {
  const existingNames = new Map(
    existing.map((provider) => [providerFingerprint(provider), provider.name])
  );
  const earlier = new Map<string, string>();
  const candidates: ScannedCandidate[] = [];

  for (const provider of discovered) {
    const parsed = parseProviderUpsert({
      name: provider.name.slice(0, MAX_NAME_LENGTH),
      api: provider.api,
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      enabled: true,
      models: provider.models,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    });
    if (!parsed.ok) {
      warnings.push(`${provider.sourceLabel}：${parsed.error}，已跳过`);
      continue;
    }
    const { input } = parsed;
    const fingerprint = providerFingerprint(input);
    const existingName = existingNames.get(fingerprint);
    const earlierLabel = earlier.get(fingerprint);
    if (existingName === undefined && earlierLabel === undefined) {
      earlier.set(fingerprint, provider.sourceLabel);
    }
    const hint = apiKeyHint(input.apiKey);
    candidates.push({
      // 逐字段构造（不是展开 input 再删 key），明文 key 不可能被带进视图
      view: {
        id: randomUUID(),
        source: provider.source,
        sourceLabel: provider.sourceLabel,
        name: input.name,
        api: input.api,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        models: input.models.map((model) => ({ ...model })),
        hasApiKey: Boolean(input.apiKey),
        ...(hint ? { apiKeyHint: hint } : {}),
        isCurrent: provider.isCurrent,
        ...(existingName !== undefined
          ? { duplicate: 'existing', duplicateOf: existingName }
          : earlierLabel !== undefined
            ? { duplicate: 'candidate', duplicateOf: earlierLabel }
            : {}),
      },
      input,
    });
  }
  return candidates;
}
