# Task 15 · provider-import —— 模型服务页「从本机导入」：Claude Code / Codex / CC Switch

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/ARCHITECTURE.md` §7、§9.6，`.workflow/scratch/wave2/summary-settings-ui.md`（providers 存储、IPC、脱敏、设置页结构），
`docs/engineering-guidelines.md` 不存在，扫描器三层结构见 `AGENTS.md` 与 EnsoCode `D:\project\EnsoCode\src\main\services\providerScan\`（来源定位 / 格式读取 / 编排去重；读取器纯函数；单源失败不阻断）。

## 本机实际格式（验收人已核对，测试 fixture 按此写）
1. **Claude Code** `~/.claude/settings.json`：`env.ANTHROPIC_BASE_URL`、`env.ANTHROPIC_AUTH_TOKEN`（或 `ANTHROPIC_API_KEY`）、`model`（如 `fable` / `opus[1m]`，可忽略或映射为默认模型）；`env.ANTHROPIC_DEFAULT_*_MODEL` 可作为额外模型 id。→ `api: 'anthropic-messages'`。
2. **Codex** `~/.codex/config.toml`：`model_provider = "custom"`、`model = "gpt-6-astra"`、`[model_providers.<key>]` 下 `name`、`base_url`、`wire_api`（`responses` → `openai-responses`，`chat` → `openai-completions`）、可选 `env_key`；key 在 `~/.codex/auth.json` 的 `OPENAI_API_KEY`（或 `env_key` 指向的环境变量）。TOML 解析用 `smol-toml`（加到 `dependencies`）。
3. **CC Switch** `~/.cc-switch/cc-switch.db`（sqlite）`providers` 表：`id, app_type, name, settings_config(JSON 字符串), website_url, category, is_current, meta(JSON)`。
   - `app_type = 'claude'`：`settings_config.env.ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY`，`settings_config.model`。
   - `app_type = 'codex'`：`settings_config.auth.OPENAI_API_KEY`，`settings_config.config` 是 **TOML 字符串**（同 Codex config.toml 格式，取 `model_providers.*` 与 `model`）；`meta.apiFormat` 如 `openai_responses`。
   - `app_type = 'gemini'`：`settings_config.env.GEMINI_API_KEY` / `GOOGLE_API_KEY`，`GOOGLE_GEMINI_BASE_URL` 可选 → `google-generative-ai`。
   - 跳过 `claude-desktop`、`opencode`、`hermes` 等其它 app_type；`env` 为空（官方占位）的跳过。
   - 读库用 Node 内置 `node:sqlite`（`DatabaseSync`，`{ readonly: true }`；Electron 45 内置 Node 24 可用，**不要**引入 better-sqlite3）。先把文件复制到临时目录再打开，避免与 CC Switch 进程锁冲突；读完删除副本。

## 范围（允许改）
- `src/main/services/providers/import/**`（新建：`locate.ts`、`readers/{claudeCode,codex,ccSwitch}.ts`、`scan.ts`、测试与 fixtures）、`src/main/services/providers/*.ts`（接入）
- `src/main/ipc/providers.ts`（新增两个通道）、`src/shared/types/ipc.ts`（`// --- providers ---` 段内追加）、`src/shared/types/llm.ts`（新增 `ProviderImportCandidate` 视图类型）
- `src/preload/domains/providers.ts`
- `src/renderer/components/settings/**`（providers 页）、`src/renderer/stores/providers.ts`、`src/renderer/components/ui/`（如需 `checkbox`）
- `package.json` / `pnpm-lock.yaml`（仅加 `smol-toml`）
- 不要动其它文件。

## 要做什么
1. **扫描** `scanProviderImports(sources?: ('claude-code'|'codex'|'cc-switch')[])`：三层结构；读取器纯函数（输入文本 / 行，输出候选或空），坏文件返回空并记 `warnings`；编排层按 **`baseUrl + apiKey`** 去重：与已存在的 provider 重复的标 `duplicate: 'existing'`，候选之间重复的标 `duplicate: 'candidate'` 并保留第一个。候选字段：`id`（扫描会话内临时 id）、`source`、`sourceLabel`（如「CC Switch · cursor」）、`name`、`api`、`baseUrl`、`models: ModelEntry[]`、`hasApiKey`、`apiKeyHint`（末 4 位）、`isCurrent`（CC Switch 的 is_current / Claude Code 与 Codex 恒为 true）、`duplicate?`。
2. **IPC**：`providers:scan-imports { sources? } → { candidates, warnings }`（脱敏视图）；`providers:import { candidateIds } → { imported: ModelProviderView[], skipped }`。**明文 key 不经过 Renderer**：Main 把最近一次扫描结果（含 key）缓存在内存，`import` 按 id 取；缓存 10 分钟过期。导入时若 models 为空，按 api 从 `modelCatalog` 填默认模型；名称冲突追加后缀。
3. **UI**：「添加服务」下拉加「从本机导入…」；空态卡片加一个「从本机导入」按钮。弹窗：三个来源的复选过滤、候选列表（来源徽标、名称、api、baseUrl、key 末 4 位、「当前使用」标记、重复项置灰并说明原因）、全选 / 反选、「导入所选」。扫描中与无候选都有状态文案。导入完成后列表刷新并提示数量。
4. **测试**：三种读取器的 fixture（临时目录；sqlite fixture 用 `node:sqlite` 在测试里建表写入，字段照上面的实际格式含 TOML 字符串）、坏 JSON / 坏 TOML / 缺 key、去重两种情况、脱敏（断言 IPC 返回里不含完整 key）、缓存过期后 import 返回错误、入参收窄。
5. 真机：`pnpm dev` 扫一次本机三处来源，在总结里写明扫到多少候选（名称与来源即可，不要写 key）。

## 硬约束
- §7 IPC 规则；key 只在 Main。
- 不改 CC Switch 的数据库，只读副本。
- 单源失败（如没装 CC Switch）不影响其它来源。

## 验收标准
根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿；真机扫描结果写进总结。

## 提交 / 完成动作
`<type>(main|renderer|shared|preload): <summary>` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不 push 不建 PR。
写 `.workflow/scratch/wave3/summary-provider-import.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
