# Task 07 · settings-ui —— Providers / Roles / Skills / MCP 的存储、IPC 与设置页

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/PRODUCT.md`（多角色）、`docs/ARCHITECTURE.md`（§4 Role、§7、**§9.1、§9.5 ModelResolver、§9.6**）、
`packages/core/README.md`（`RoleStore` / `JsonFileRoleStore` / `parseRole`）、`.workflow/scratch/bootstrap/summary-app-shell.md`（settings store、ui 组件、tsconfig 说明）。
参考 EnsoCode：`src/shared/types/llm.ts`、`src/shared/modelCatalog.ts`（内置模型目录）、`src/main/ipc/providers.ts`、`src/renderer/components/settings/`（Providers / Skills / MCP 页面形态）、`src/renderer/settings.html`（独立设置窗口；本卡可以先做成主窗口内的设置视图，说明选择）。

## 范围（允许改）
- `src/main/services/providers/**`、`src/main/services/roles/**`、`src/main/services/skills/**`、`src/main/services/mcp/**`（新建）
- `src/main/ipc/{providers,roles,skills,mcp}.ts`（新建）+ `src/main/ipc/index.ts` 各加一行
- `src/shared/types/llm.ts`（新建，**逐字按 §9.6**）、`src/shared/types/ipc.ts` 追加 `// --- providers|roles|skills|mcp ---` 段
- `src/preload/domains/{providers,roles,skills,mcp}.ts`（新建）+ `src/preload/index.ts`、`src/preload/types.ts` 各加一行
- `src/renderer/components/settings/**`（新建）、`src/renderer/stores/{providers,roles,skills,mcp}.ts`（新建）、`src/renderer/components/ui/` 可新增组件（`select`、`switch`、`textarea`、`tabs`、`badge`）
- `src/renderer/components/layout/TitleBar.tsx` 或 `Sidebar.tsx`：只允许加一个「设置」入口按钮（一行 import + 一行 JSX）；`App.tsx` 只允许加设置视图挂载点
- **不要动** `src/agent/**`、`src/main/services/agentHost/**`、`src/main/services/orchestration/**`、`src/renderer/components/chat/**`、`packages/**`。

## 要做什么
1. **Providers**：`userData/providers.json`（明文 key 仅 Main，原子写）；IPC `providers:list`（返回 `ModelProviderView`，key 脱敏为 `hasApiKey` + 末 4 位 hint）、`providers:upsert`（Renderer 传入 key 明文只在这一跳，入参收窄）、`providers:remove`、`providers:test`（对 provider 发一个最小请求验证 key；可用 `@earendil-works/pi-ai` 的能力，失败返回可读错误）。内置目录 `src/shared/modelCatalog.ts`：Anthropic（claude-fable-5-1、claude-opus-5-5、claude-sonnet-5-5、claude-haiku-5-5）、OpenAI、Google、以及「自定义 OpenAI 兼容」。`src/main/services/providers/resolveModel.ts` 导出 `createModelResolver()` 实现 §9.5 `ModelResolver`（去重键 `baseUrl + apiKey`）。
2. **Roles**：用 `@fynvra/core` 的 `JsonFileRoleStore`（目录 `userData/roles`，fs 注入 `node:fs/promises`）；IPC `roles:list|get|save|remove`；内置角色只读。设置页：角色列表 + 编辑器（名称、描述、系统提示词 textarea、模型选择（来自 providers）、thinking、工具策略 `all|readonly|orchestrator`、审批档位、技能多选、MCP 多选）、「复制为新角色」、导入/导出 JSON。
3. **Skills**：`userData/skills.json` 注册表（`SkillEntry`：指向目录的引用，不复制内容）；IPC `skills:list|add|remove|toggle`；`add` 由 Main 弹目录选择框并校验目录含 `SKILL.md`，解析 name / description；另提供 `skills:scan` 扫描 `~/.claude/skills`、`~/.codex/skills`、`~/.pi/agent/skills`（三层：定位 / 读取 / 去重，按小写 name 去重，单源失败不阻断）。
4. **MCP**：`userData/mcp.json`（`McpServerEntry` + env / headers 明文仅 Main）；IPC `mcp:list`（返回 `McpServerEntryView`）、`mcp:upsert`、`mcp:remove`、`mcp:toggle`、`mcp:import-claude`（解析 `~/.claude.json` 与 `~/.claude/settings.json` 里的 mcpServers，按命令+参数 / URL 去重）。
5. **设置视图**：左侧分组（模型服务 / 角色 / 技能 / MCP / 外观），右侧内容；用现有 `components/ui`，shadcn new-york 风格；暗色可用。Zustand store 按字段订阅。

## 硬约束
- §7 IPC 规则；密钥、env 明文绝不进 Renderer；Renderer 只传 id。
- 大段文本（系统提示词）走 roles 文件，不进 settings.json。
- 可单测逻辑（catalog、parser、去重、脱敏、扫描读取器）TDD；文件测试用临时目录。

## 验收标准
- 根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿。
- `pnpm dev`：能添加一个 provider 并保存（providers.json 里有 key，IPC list 返回里没有）；能新建角色、编辑后 `userData/roles/<id>.json` 落盘；内置角色不可删；skills scan 能列出本机 `~/.claude/skills`；mcp import 能导入本机 Claude 配置（脱敏显示）。

## 提交
`<type>(main|renderer|shared|preload): <summary>`，末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不 push、不建 PR。

## 完成动作
写 `.workflow/scratch/wave2/summary-settings-ui.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
