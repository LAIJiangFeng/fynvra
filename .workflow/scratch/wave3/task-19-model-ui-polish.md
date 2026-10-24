# Task 19 · model-ui-polish —— 自定义模型的推理开关、角色编辑器按模型列档位、参数 / URL 密钥打码

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/ARCHITECTURE.md` §5、§9.3（`sessions:model-options` 每个模型的 `thinkingLevels` / `defaultThinking`）、§9.6，
`.workflow/scratch/wave3/summary-model-picker.md` 注意事项 1、2，`summary-mcp-import-sources.md` 注意事项 1，`summary-provider-import.md`。

## 范围（允许改）
- `src/renderer/components/settings/{ProviderDialog,ProvidersSettings,RoleEditor,McpSettings,McpImportDialog,ProviderImportDialog}.tsx` 及同目录纯函数文件（新建 `secretMask.ts` 及测试）
- `src/renderer/stores/{providers,roles,mcp}.ts`、`src/renderer/lib/api/**`（如需复用 `sessions.modelOptions`）
- `src/main/services/providers/parseProviderInput.ts`（若 `reasoning` 收窄缺失）及测试
- 不要动 Main 的 MCP / 会话逻辑、packages、chat 组件。

## 要做什么
1. **模型条目「推理」开关**：ProviderDialog 的模型列表每行加一个开关（`ModelEntry.reasoning`），`providers:upsert` 已接受该字段；列表上的「推理」徽标保持。内置目录里的模型（pi 目录能识别的 id）显示为只读徽标并提示「由内置目录决定」；自定义 id 才可切换。
2. **角色编辑器的思考档位按模型来**：模型下拉选定后，档位选项来自 `sessions:model-options` 返回的该模型 `thinkingLevels`，默认 `defaultThinking`；模型不支持推理时隐藏档位控件并清掉角色里的 `thinking`；角色未选模型时显示「跟随会话模型」并禁用档位。
3. **密钥打码**（只影响显示，不改存储与契约）：纯函数 `maskSecrets(text)` 对以下形态打码为前 3 + `…` + 后 2：命令参数中 `--api-key` / `--token` / `--key` / `-k` / `--password` 之后的一个参数，或 `key=value` 形式；URL query 里键名含 `key` / `token` / `secret` / `password` / `auth` 的值；长度 ≥ 20 且形似 `sk-…` / `ctx7sk-…` 等前缀的任意 token。用于 MCP 列表、两个导入弹窗的命令 / URL 摘要。编辑弹窗里原值仍可见可改。测试覆盖以上每种形态与不误伤（普通路径、短数字）。

## 验收标准
根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿；`pnpm dev` 下：本机 context7 的 `--api-key` 在列表里打码；给自定义服务某模型打开「推理」后，新建会话该模型出现档位；角色编辑器切换模型时档位列表随之变化。

## 提交 / 完成动作
`<type>(renderer|main): <summary>` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不 push 不建 PR。
写 `.workflow/scratch/wave3/summary-model-ui-polish.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
