export type ProviderApi =
  | 'anthropic-messages'
  | 'openai-responses'
  | 'openai-completions'
  | 'google-generative-ai';
export interface ModelEntry {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutput?: number;
  reasoning?: boolean;
}
export interface ModelProvider {
  id: string;
  name: string;
  api: ProviderApi;
  baseUrl?: string;
  enabled: boolean;
  models: ModelEntry[];
}
/** Renderer 侧看到的脱敏形态 */
export interface ModelProviderView extends ModelProvider {
  hasApiKey: boolean;
  apiKeyHint?: string;
}
/** 「从本机导入」的来源：~/.claude/settings.json、~/.codex/config.toml、~/.cc-switch/cc-switch.db */
export type ProviderImportSource = 'claude-code' | 'codex' | 'cc-switch';
/** providers:scan-imports 扫到的候选（脱敏形态）；明文 key 留在 Main 的扫描缓存里 */
export interface ProviderImportCandidate {
  /** 只在这一次扫描内有效，回传给 providers:import */
  id: string;
  source: ProviderImportSource;
  /** 如「Claude Code」「CC Switch · cursor」 */
  sourceLabel: string;
  name: string;
  api: ProviderApi;
  baseUrl?: string;
  models: ModelEntry[];
  hasApiKey: boolean;
  apiKeyHint?: string;
  /** CC Switch 里正在使用的那一个；Claude Code / Codex 读的就是生效中的配置 */
  isCurrent: boolean;
  /** 与已有服务（existing）或排在前面的候选（candidate）的地址和 key 都相同 */
  duplicate?: 'existing' | 'candidate';
  /** 重复的对象：已有服务的名称，或前面那个候选的 sourceLabel */
  duplicateOf?: string;
}
export interface SkillEntry {
  id: string;
  name: string;
  path: string;
  description?: string;
  enabled: boolean;
}
export interface McpServerEntry {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
}
/** Renderer 侧 env / headers 只给键名 */
export interface McpServerEntryView extends McpServerEntry {
  envKeys: string[];
  headerKeys: string[];
}
