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
