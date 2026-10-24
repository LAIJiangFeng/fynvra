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
/**
 * providers:list-remote-models 从服务端「列模型」接口拉到的一个模型。上下文窗口 / 最大输出取服务端给的
 * （Google 的 token 上限），没有时取内置目录；reasoning 只来自内置目录，目录里没有这个模型就不带。
 */
export interface RemoteModelEntry {
  id: string;
  /** 服务端的显示名；没有时用内置目录里的名称，再没有就是 id */
  name: string;
  contextWindow?: number;
  maxOutput?: number;
  reasoning?: boolean;
  /** 已在所请求服务（providerId）保存的模型列表里；没传 providerId 时恒为 false */
  alreadyAdded: boolean;
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
/** MCP「从本机导入」的来源；顺序就是去重的优先级 */
export type McpImportSource =
  | 'claude-code'
  | 'codex'
  | 'grok'
  | 'gemini'
  | 'cursor'
  | 'vscode'
  | 'opencode'
  | 'cc-switch';
/** mcp:scan-imports 扫到的候选（脱敏形态）；env / headers 明文留在 Main 的扫描缓存里 */
export interface McpImportCandidate {
  /** 只在这一次扫描内有效，回传给 mcp:import */
  id: string;
  source: McpImportSource;
  /** 如「Claude Code」「Claude Code · fynvra」（项目级）「CC Switch · Claude、Codex」（已启用的应用） */
  sourceLabel: string;
  name: string;
  transport: McpServerEntry['transport'];
  command?: string;
  args?: string[];
  url?: string;
  envKeys: string[];
  headerKeys: string[];
  /** 来源里是否启用：Codex / Grok / OpenCode 的 enabled、Gemini 的 mcp.excluded、CC Switch 任一应用已启用 */
  enabledInSource: boolean;
  /** 与已有服务器（existing）或排在前面的候选（candidate）的命令 + 参数 / URL 相同 */
  duplicate?: 'existing' | 'candidate';
  /** 重复的对象：已有服务器的名称，或前面那个候选的「来源 · 名称」 */
  duplicateOf?: string;
}
