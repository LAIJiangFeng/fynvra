# Task 10 · session-event-types —— 把会话事件类型挪进 @fynvra/core，修正 tsconfig 护栏

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`docs/ARCHITECTURE.md` §5、§9.2，以及
`.workflow/scratch/bootstrap/summary-integrate-workspace.md` 的「给验收人的注意事项」第 4、5 条（这是本卡的全部动机）。
这是一张小卡，目标 30 分钟内完成；它是 Wave 2 五张卡的前置。

## 范围（允许改）
- `packages/core/src/types.ts`、`packages/core/src/index.ts`、`packages/core/src/guards.ts`（如需守卫）及对应测试
- `packages/agent-runtime/src/events/normalize.ts`、`packages/agent-runtime/src/index.ts`（含删掉第 2 行过时注释）及对应测试
- `tsconfig.json`、`tsconfig.node.json`、`tsconfig.web.json`
- 其它文件不动。

## 要做什么
1. 把 `FynvraSessionEvent`、`FynvraSessionEventBody` 及其依赖的全部纯类型（不能引用任何 pi 类型；若现有定义引用了 pi 类型，改为结构等价的自有类型并说明）**搬到** `packages/core/src/types.ts`，从 `@fynvra/core` 导出；`packages/agent-runtime/src/events/normalize.ts` 改为 `import type` 并 **继续 re-export**（现有 import 方不改）。
2. `tsconfig.web.json` 不加 `@fynvra/agent-runtime` 映射（保持「renderer 无 Node 全局」护栏）。写一个探针测试或在总结里用 tsc 实测：`src/shared` 里 `import type { FynvraSessionEvent } from '@fynvra/core'` 在 `typecheck:web` 下通过，且 renderer 里写 `process.env` 仍报 TS2591。
3. 解决 TS6307：按注意事项第 5 条选一种（推荐：去掉 node / web 配置的 `composite` 与根 `references`，或把 `packages/*/src/**/*` 加进 `tsconfig.node.json` include），要求「不带 `--composite false` 直接 `tsc -p tsconfig.node.json --noEmit` 也通过」。说明取舍。
4. 根 `tsconfig.json` 的 `references` 若保留，加入两个包。

## 验收标准
- 根目录 `pnpm typecheck && pnpm lint && pnpm test` 全绿（406 用例不减少）；`tsc -p tsconfig.node.json --noEmit` 不带额外参数也通过。
- 探针结论写进总结。

## 提交
`<type>(core|agent-runtime|build): <summary>`，末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不 push、不建 PR。

## 完成动作
写 `.workflow/scratch/wave2/summary-session-event-types.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
