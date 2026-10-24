# Task 20 · remote-model-list —— 服务弹窗一键拉取远程模型列表

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/ARCHITECTURE.md` §7、§9.6，`.workflow/scratch/wave2/summary-settings-ui.md`（providers 存储、`providers:test` 连通性测试的实现，可复用其请求代码）、`.workflow/scratch/wave3/summary-model-ui-polish.md`（ProviderDialog 的模型列表与「推理」开关）。
现状：模型只能一个个手敲 id。用户配了多个中转服务（Anthropic / OpenAI 协议），需要「拉取模型列表」→ 勾选 / 全选 → 加入。

## 范围（允许改）
- `src/main/services/providers/remoteModels/**`（新建：各协议的请求与解析，解析器纯函数 + fixtures）、`src/main/services/providers/*.ts`（接入）
- `src/main/ipc/providers.ts`（新增 `providers:list-remote-models`）、`src/shared/types/ipc.ts`（`// --- providers ---` 段内追加）、`src/shared/types/llm.ts`（`RemoteModelEntry` 视图类型）
- `src/preload/domains/providers.ts`
- `src/renderer/components/settings/{ProviderDialog,RemoteModelsPicker}.tsx`、同目录纯函数文件（`remoteModels.ts` 及测试）、`src/renderer/stores/providers.ts`
- 不要动其它文件。

## 要做什么
1. **IPC** `providers:list-remote-models { providerId? , draft?: { api, baseUrl?, apiKey? } } → { models: RemoteModelEntry[], endpoint: string, warnings }`：
   - 已保存的服务传 `providerId`，Main 用存储里的 key；未保存的新服务传 `draft`（key 明文只在这一跳，与 `providers:upsert` 相同；`draft` 没有 key 时用已保存服务的 key——同时传 `providerId` 与 `draft` 时以 draft 的地址 / 协议为准、key 以 draft 优先）。入参 `unknown` 收窄。
   - 按协议请求（15 秒超时，经 Node `fetch`，不走代理设置以外的东西）：
     - `anthropic-messages`：`GET {baseUrl}/v1/models`，头 `x-api-key` + `anthropic-version: 2023-06-01`，解析 `data[].id / display_name / created_at`；若 404 / 405 或返回非预期结构，**回退**到 OpenAI 形态 `GET {baseUrl}/v1/models` + `Authorization: Bearer`（很多中转只实现这一条）。
     - `openai-responses` / `openai-completions`：`GET {baseUrl}/v1/models` + Bearer，解析 `data[].id / owned_by / created`；若 baseUrl 已以 `/v1` 结尾不要重复拼。
     - `google-generative-ai`：`GET {baseUrl}/v1beta/models?key=…`，解析 `models[].name`（去掉 `models/` 前缀）/ `displayName` / `inputTokenLimit` / `outputTokenLimit`，只保留 `supportedGenerationMethods` 含 `generateContent` 的。
   - 结果：`{ id, name, contextWindow?, maxOutput?, reasoning?, alreadyAdded }`，`reasoning` 由 pi 内置目录判断（已有逻辑可复用，拿不到就留空）；去重；按 id 排序。错误返回可读文本（401 → 「API Key 无效」、网络错误 → 原因、非 JSON → 「接口返回的不是模型列表」），不抛。
2. **UI**：ProviderDialog「模型」标题行加「拉取模型列表」按钮（填了地址即可点；新服务没填 key 时提示先填）。点击后在弹窗内展开面板：加载态、搜索框、全选 / 反选、每行 id + 名称 + 已添加标记（置灰）+ 推理徽标、「加入所选（N）」/「全部加入」。加入后合并进模型列表（已存在的跳过），保留用户已有的手动条目和推理标记。失败时内联显示错误与「重试」。
3. **测试**：三种协议解析器 fixtures（含 Anthropic 回退、`/v1` 结尾去重、Google 过滤）、入参收窄、错误映射、Renderer 的合并 / 去重 / 搜索纯函数。请求层用注入的 `fetch` 假实现断言 URL 与头（断言不泄漏 key 到返回值）。
4. **真机**：`pnpm dev` 对本机已导入的 Claude Code 与 Codex 两个中转各拉一次，总结里写拉到的模型数量和前几个 id（不写 key）。

## 验收标准
根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿；真机结果写进总结。

## 提交 / 完成动作
`<type>(main|renderer|shared|preload): <summary>` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不 push 不建 PR。
写 `.workflow/scratch/wave3/summary-remote-model-list.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
