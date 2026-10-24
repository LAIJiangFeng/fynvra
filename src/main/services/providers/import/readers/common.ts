import { asRecord } from '@shared/guards';
import { MODEL_CATALOG } from '@shared/modelCatalog';
import type { ModelEntry, ProviderApi, ProviderImportSource } from '@shared/types/llm';
import { parse as parseToml, TomlError } from 'smol-toml';

// 读取器：把各来源的原始内容（文件文本 / 数据库行）解释成可导入的服务。纯函数，不碰文件系统与 process.env；
// 内容坏了返回空并记 warning。warning 只写位置（文件、行号），不带原文：这些配置文件里有 key。

/** 一个可导入的服务。含明文 key，只在 Main 内存里；给 Renderer 的是 scan 构造的脱敏视图。 */
export interface DiscoveredProvider {
  source: ProviderImportSource;
  sourceLabel: string;
  name: string;
  api: ProviderApi;
  /** 去掉了末尾的 `/`；缺省表示协议的官方地址 */
  baseUrl?: string;
  apiKey?: string;
  models: ModelEntry[];
  isCurrent: boolean;
}

export interface ReaderResult {
  providers: DiscoveredProvider[];
  warnings: string[];
}

/** 环境变量（Codex 的 env_key 指向这里）。由调用方传入，读取器不直接读 process.env。 */
export type Env = Readonly<Record<string, string | undefined>>;

/** 字符串去首尾空白；其它类型一律当作没填。 */
export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** JSON 对象；语法错误或顶层不是对象都返回 null。不转述 V8 的错误信息：它会引用文件片段。 */
export function parseJsonObject(source: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(source));
  } catch {
    return null;
  }
}

/** TOML 文档；出错只给行号（TomlError 的 message 带着出错位置前后几行原文）。 */
export function parseTomlObject(
  source: string
): { ok: true; value: Record<string, unknown> } | { ok: false; line?: number } {
  try {
    return { ok: true, value: parseToml(source, { unsafeKeyBehaviour: 'drop' }) };
  } catch (error) {
    return error instanceof TomlError ? { ok: false, line: error.line } : { ok: false };
  }
}

/** 地址去首尾空白与末尾 `/`；空串视为没填（导入后用协议默认地址）。 */
export function baseUrlOf(value: unknown): string | undefined {
  return text(value).replace(/\/+$/, '') || undefined;
}

const CATALOG_MODELS = new Map(
  MODEL_CATALOG.flatMap((provider) => provider.models).map((model) => [model.id, model])
);

/**
 * 模型 id 列表 → ModelEntry：去掉 `[1m]` 之类的后缀、去重，丢弃含空白的 id。内置目录里有的模型带上上下文窗口等元数据；
 * `names` 是来源里写的显示名（如 ANTHROPIC_DEFAULT_*_MODEL_NAME），优先于目录里的名称。
 */
export function modelEntries(
  ids: readonly string[],
  names: ReadonlyMap<string, string> = new Map()
): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const raw of ids) {
    const id = raw.trim().replace(/\[[^\]]*\]$/, '');
    if (!id || /\s/.test(id) || entries.some((entry) => entry.id === id)) continue;
    const known = CATALOG_MODELS.get(id);
    entries.push({ ...known, id, name: names.get(raw) || known?.name || id });
  }
  return entries;
}
