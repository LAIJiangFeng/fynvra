# Task 21 · thinking-levels-per-model —— 思考等级严格按模型官方定义，不再统一一套

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/ARCHITECTURE.md` §4（`ThinkingLevel`）、§5、§9.3，
`.workflow/scratch/wave3/summary-model-picker.md`（`describe-models`、`models.ts` 的目录查找、「pi 的 max 档位没做」）、`summary-model-ui-polish.md`。
现状（用户截图）：Codex 的 `gpt-5.6-sol`、Anthropic 的各模型在选择器里都显示同一套「关闭 / 低 / 中 / 高 / 最高」。用户要求：**每个模型只显示它官方支持的思考等级**（例如 Claude Code 里 Fable 是 low / medium / high / xhigh / max；OpenAI 推理模型是 low / medium / high / xhigh，部分有 none / minimal；Gemini 3 是 low / high 之类），显示官方等级名。

## 范围（允许改）
- `packages/core/src/types.ts`、`guards.ts`（`ThinkingLevel` 加 `'max'`，并允许 `'none'` 作为「关闭」的别名归一到 `off`）及测试
- `packages/agent-runtime/src/session/createRoleSession.ts`（thinking 透传）及测试
- `src/agent/models.ts`（及测试）、`src/agent/piSession.ts`（setThinkingLevel 透传 max）
- `src/shared/types/chat.ts`（`ModelThinkingCapability`、`pickThinkingLevel`、等级显示名）及测试、`src/shared/types/agent.ts` parser（接受 max）
- `src/renderer/components/chat/ModelPicker.tsx`、`NewSessionButton.tsx`、`StatusBar.tsx`、`src/renderer/stores/sessions/modelChoice.ts`、`src/renderer/components/settings/{RoleEditor,roleModel}.tsx|ts`、`src/renderer/components/settings/RemoteModelsPicker.tsx`（推理徽标改为经 describe-models）、`src/renderer/stores/providers.ts`
- 不要动其它文件。

## 要做什么
1. **权威来源**：pi-ai 的 `getSupportedThinkingLevels(model)`（含 `max`）与 `clampThinkingLevel`。`src/agent/models.ts` 的 `describe` 不要再 `filter(isThinkingLevel)` 把 `max` 丢掉；core 的 `ThinkingLevel` 扩成 `'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'`。先在总结里贴出 pi 1.4.0 目录对这些模型给出的等级：`claude-fable-5-1`、`claude-opus-5-5`、`claude-sonnet-5-5`、`claude-opus-4-8`、`claude-sonnet-4-6`、`gpt-5.5`、`gpt-5.6`、`gpt-6-astra`、`gpt-6-sol`、`gemini-3.1-pro`（写一个临时脚本跑 pi 目录即可，脚本不提交）。
2. **目录外模型的推断**（用户的中转会出现 `gpt-5.6-sol`、`gpt-6.1-sol`、带日期后缀、带 `[1m]` 等变体）：按「同协议 + 最长公共 id 前缀」匹配目录里最接近的模型（规整：小写、去掉 `[…]`、去掉日期 / `-latest` / `-preview` 后缀、`-sol`/`-astra` 这类变体先整体匹配再逐段退让），匹配到就用它的等级；匹配不到再按协议兜底：Anthropic → pi 对当前一代 Claude 的等级（预期 low / medium / high / xhigh / max），OpenAI → low / medium / high / xhigh，Google → 该协议目录里最新模型的等级；`reasoning: false` 的仍不显示档位。推断结果在 `describe-models` 里带 `source: 'catalog' | 'inferred:<matched-id>' | 'fallback'`，界面在档位旁用小字提示「按 <id> 推断」。
3. **显示官方等级名**：选择器、新建弹层、状态栏、角色编辑器统一显示 `off / minimal / low / medium / high / xhigh / max`（off 可显示为「off · 关闭」），不再用中文「低 / 中 / 高 / 最高」替代；hover 显示中文说明。
4. **同一会话切模型时**：目标模型没有当前等级 → 回落到该模型默认（pi 默认或列表中间值），逻辑已存在，补 `max` 用例。
5. **测试**：`describe` 对目录模型给出完整等级（含 max）、目录外变体推断的每条规整规则、兜底集合、`pickThinkingLevel` 含 max、parser 接受 max、renderer 只渲染返回的数组。
6. **真机**：`pnpm dev`，分别选 Claude Code 中转的 `claude-fable-5-1` 与 Codex 中转的 `gpt-5.6-sol`，截图或 DOM 证据写明两者的档位列表不同且与第 1 条目录输出一致；切到 `max` 发一条消息，jsonl 里 thinking 记录为 max。

## 验收标准
根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿；总结里有第 1 条的目录输出与第 6 条证据。

## 提交 / 完成动作
`<type>(core|agent|shared|renderer): <summary>` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不 push 不建 PR。
写 `.workflow/scratch/wave3/summary-thinking-levels-per-model.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
