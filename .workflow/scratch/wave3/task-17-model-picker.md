# Task 17 · model-picker —— 会话级模型 / 思考档位选择器（新建时可选、中途可切）

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/ARCHITECTURE.md` §4（`Role.model`、`ThinkingLevel`）、§5、§7、§9.2、§9.3、§9.5（`ModelResolver.ref`），
`.workflow/scratch/wave2/summary-agent-host.md`、`summary-settings-ui.md`（providers / `createModelResolver`）、`summary-chat-ui.md`、`summary-main-wiring.md`（注意事项 2、3：会话存的是设置里的服务 id，worker 侧 providerId 带 `fynvra-` 前缀）。
现状：`sessions:create` 只接受 `{ workspaceId, roleId, model? }`，但新建会话弹层没有模型选项；聊天界面没有任何切换入口；状态栏右下只显示模型名。
用户配置了多个模型服务，需要在会话里自己选。

## 范围（允许改）
- `src/shared/types/chat.ts`（`SessionSummary.model` 加 `thinking?: ThinkingLevel`）、`src/shared/types/agent.ts`（新增 `set-model` 命令并更新 parser 与测试）、`src/shared/types/ipc.ts`（`// --- sessions ---` 段内追加 `sessions:set-model`、`sessions:model-options`）
- `src/main/ipc/sessions.ts`、`src/main/services/sessions/**`、`src/main/services/agentHost/**`（及测试）
- `src/agent/**`（worker 收到 `set-model` 后调 pi `session.setModel` / 设 thinking；模型未注册时先经 `models.ts` 注册）
- `packages/agent-runtime/src/session/**`：仅当 pi 的切换需要封装时加一个 `setSessionModel(session, resolved)` 适配函数（`src/pi/` 适配层），其它不动
- `src/preload/domains/sessions.ts`、`src/preload/types.ts`（一行）
- `src/renderer/components/chat/{Composer,StatusBar,NewSessionButton,ModelPicker}.tsx`（ModelPicker 新建）、`src/renderer/stores/sessions/**`、`src/renderer/lib/api/sessions.ts`、`src/renderer/components/ui/`（如需 `popover` / `command` 列表）
- 不要动 settings 页、orchestration、packages/core。

## 要做什么
1. **模型选项来源**：IPC `sessions:model-options { workspaceId? } → { providers: [{ providerId, name, api, models: [{ id, name, reasoning? }] }], thinkingLevels }`，只取 `enabled` 且有 key 的服务（复用 providers store 的脱敏视图，不带 key）。
2. **新建会话弹层**：角色列表下方加「模型」下拉（按服务分组）与「思考档位」（off / minimal / low / medium / high / xhigh，按模型 `reasoning` 决定是否可选）。默认值优先级：角色的 `model` → 该工作区上一次用过的模型（存 settings.json `preferences.lastModelByWorkspace[workspaceId]`，只存 id 引用）→ 列表第一个。传给 `sessions:create` 的 `model` 加 `thinking`。
3. **会话中切换**：输入框左下角加 `ModelPicker` 胶囊（当前「服务 · 模型 · 思考档位」，点开为可搜索列表）。切换 → `sessions:set-model { sessionId, model: { providerId, modelId, thinking? } }` → Main 用 `createModelResolver().resolve` 解析、更新 `SessionSummary.model`、落 sessions.json、向 worker 发 `set-model`（spec 同 `spawn-session` 的 `ResolvedModelSpec`）→ worker 注册 provider 并 `session.setModel(...)` + thinking → 回 `session-status` / `sessions:changed`。运行中（`running`）时拒绝并提示「等本轮结束再切」；解析失败返回可读错误，不改状态。下一次 prompt 即用新模型；pi 的会话历史保留。
4. **状态栏**：右下模型名改为可点击，点了也打开同一个 picker。
5. **worker 派发的会话**：orchestrator 派出的 worker 会话按其角色的 `model`，角色没配时继承 orchestrator 当前模型（在 launcher `createWorkerSession` 处理，若需要改 `src/main/services/orchestration/**` 只允许传参，不改逻辑，并在总结里说明）。
6. 测试：parser 坏输入；`set-model` 在 running 时拒绝；解析失败不改记录；worker 侧收到 `set-model` 调用 pi（假 session 断言）；renderer store 的乐观更新与回滚；默认值优先级纯函数。
7. 真机冒烟：`pnpm dev`，用本机已导入的两个以上服务，新建会话选 A，发一条消息；切到 B 再发一条；状态栏与 sessions.json 都变为 B；worker 日志显示两次请求打到不同 baseUrl（不写 key）。

## 硬约束
§7 IPC 规则；Renderer 只传 id；key 不出 Main；入参 `unknown` 收窄。

## 验收标准
根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿；冒烟证据写进总结。

## 提交 / 完成动作
`<type>(renderer|main|agent|shared|preload): <summary>` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不 push 不建 PR。
写 `.workflow/scratch/wave3/summary-model-picker.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
