# Task 18 · mcp-import-sources —— MCP 导入支持多来源：Claude Code / Codex / Grok / Gemini CLI / Cursor / VS Code / OpenCode / CC Switch

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/ARCHITECTURE.md` §7、§9.6，`.workflow/scratch/wave2/summary-settings-ui.md`（现有 `mcp:import-claude` 与 MCP 注册表）、
`.workflow/scratch/wave3/summary-provider-import.md`（**照它的三层扫描结构、候选 / 去重 / 脱敏 / Main 缓存 10 分钟 / 导入弹窗的做法**，复用 `ProviderImportDialog` 的交互与组件风格；`smol-toml` 已在依赖里；CC Switch 读库方式也照它）。
现状：MCP 页只有「从 Claude Code 导入」。用户在多个工具里配了 MCP，需要一个统一的「从本机导入…」。

## 本机实际格式（验收人已核对，fixture 按此写）
| 来源 | 位置 | 形状 |
|---|---|---|
| Claude Code | `~/.claude.json` 顶层 `mcpServers` + 各 `projects.<path>.mcpServers`；`~/.claude/settings.json` 的 `mcpServers`（现有逻辑） | `{ command, args, env }` 或 `{ type:'http'|'sse', url, headers }` |
| Codex | `~/.codex/config.toml` `[mcp_servers.<name>]`：`command`、`args`、`env`（子表 `[mcp_servers.<name>.env]`）、`env_vars`（透传的环境变量名列表）、`url`、`http_headers`（子表）、`startup_timeout_sec`、`enabled` | TOML |
| Grok CLI | `~/.grok/config.toml` `[mcp_servers.<name>]`，字段同 Codex | TOML |
| Gemini CLI | `~/.gemini/settings.json` `mcpServers.<name>`：`command`、`args`、`env`、`timeout`、`httpUrl` / `url`、`headers` | JSON |
| Cursor | `~/.cursor/mcp.json` `mcpServers.<name>`（本机为空，fixture 自造） | JSON，同 Claude 格式 |
| VS Code | `%APPDATA%\Code\User\mcp.json` 的 `servers.<name>`：`{ type:'stdio', command, args, env }` / `{ type:'http', url, headers }`；**文件是 JSONC（可带注释与尾逗号）**，需容错解析（去注释后 JSON.parse，或用轻量 jsonc 解析） | JSONC |
| OpenCode | `~/.config/opencode/opencode.json` `mcp.<name>`：`{ type:'local', command: string[], enabled, environment }` / `{ type:'remote', url, headers }` | JSON |
| CC Switch | `~/.cc-switch/cc-switch.db` 表 `mcp_servers`：`id, name, server_config(JSON: type/command/args/env/url/headers…), description, enabled_claude/enabled_codex/enabled_gemini/…` | sqlite 只读副本 |

统一映射到 `McpServerEntry`：stdio → `{ transport:'stdio', command, args, env }`（OpenCode 的 `command[]` 第一个元素为 command）；http / sse / streamable → `{ transport:'http'|'sse', url, headers }`。env / headers 明文只在 Main。Windows 下 Claude 导出的 `cmd /c npx …` 原样保留。

## 范围（允许改）
- `src/main/services/mcp/import/**`（新建：`locate.ts`、`readers/*.ts`、`scan.ts`、`jsonc.ts`、测试与 fixtures）、`src/main/services/mcp/*.ts`（接入，现有 `import-claude` 逻辑并入 readers）
- `src/main/ipc/mcp.ts`（新增 `mcp:scan-imports { sources? }`、`mcp:import { candidateIds }`；保留旧通道或改为转调，说明选择）、`src/shared/types/ipc.ts`（`// --- mcp ---` 段内追加）、`src/shared/types/llm.ts`（`McpImportSource`、`McpImportCandidate` 脱敏视图：`id, source, sourceLabel, name, transport, command/args 或 url, envKeys, headerKeys, enabledInSource, duplicate?`）
- `src/preload/domains/mcp.ts`
- `src/renderer/components/settings/{McpSettings,McpImportDialog}.tsx`、`src/renderer/components/settings/mcpImport.ts`（及测试）、`src/renderer/stores/mcp.ts`
- 不要动 providers / sessions / chat 相关文件（Task 17 正并行改 chat 与 sessions）。

## 要做什么
1. 扫描三层：定位（每来源一个候选路径列表，不存在即跳过）/ 读取（纯函数，坏文件返回空 + warning）/ 编排去重（键：stdio 为 `command + args` 规整后小写，http 为 `url`；与已有注册表重复标 `existing`，候选间重复标 `candidate`）。CC Switch 只读副本。
2. IPC + 脱敏 + Main 缓存（10 分钟）同 provider-import。
3. UI：「从 Claude Code 导入」按钮改为「从本机导入…」（下拉或直接弹窗），弹窗带来源复选过滤（8 个）、候选列表（来源徽标、名称、传输类型、命令 / URL 摘要、env / header 键名、「来源中已启用」标记、重复置灰）、全选 / 反选、「导入所选」。导入的条目默认 `enabled: true`，名称冲突追加后缀。
4. 测试：8 个读取器各有 fixture（含 JSONC 注释、TOML 子表、OpenCode command 数组、CC Switch sqlite）、坏输入、去重两种、脱敏断言（IPC 返回里不含 env / header 值）、缓存过期、入参收窄。
5. 真机：`pnpm dev` 扫一遍本机，总结里写各来源候选数量与名称（不写 env 值）。

## 验收标准
根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿；真机扫描结果写进总结。

## 提交 / 完成动作
`<type>(main|renderer|shared|preload): <summary>` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不 push 不建 PR。
写 `.workflow/scratch/wave3/summary-mcp-import-sources.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
