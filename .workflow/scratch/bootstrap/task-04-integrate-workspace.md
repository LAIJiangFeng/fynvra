# Task 04 · integrate-workspace —— 把 packages/* 接进根 pnpm workspace

先读：`AGENTS.md`、`.workflow/specs/01-workflow.md`、`docs/ARCHITECTURE.md` §2，以及三份总结
`.workflow/scratch/bootstrap/summary-app-shell.md`（注意事项 1、2）、`summary-core-domain.md`（注意事项 1、2、4）、`summary-agent-runtime.md`（注意事项 2）。
三张卡是并行独立开发的，现在都已合并到 `main`，需要你把它们统一到一套根配置下。

## 范围（允许改）
- 根：`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`biome.json`、`vitest.config.ts`、`tsconfig*.json`、`.gitattributes`（新建）、`.gitignore`
- `packages/core/{package.json,tsconfig.json,biome.json,vitest.config.ts,pnpm-lock.yaml,.gitattributes,.gitignore,README.md}`
- `packages/agent-runtime/{package.json,tsconfig.json,biome.json,vitest.config.ts,pnpm-lock.yaml,.gitattributes,.gitignore,README.md}`
- `packages/agent-runtime/src/coreTypes.ts` 及其 import 方（把临时副本改为 `import type ... from '@fynvra/core'`，删掉副本文件）
- `docs/ARCHITECTURE.md`：只允许把 agent-runtime 总结「注意事项 1」里列出的契约补充回写进 §5（签名新增参数、`ResolvedModel` 定义、`McpServerConfig` 带 name、report_done 每轮一次、readonly 含 git_readonly）。
- 其它源码文件一律不动。若格式化 / lint 要求改源码，仅允许 Biome 自动修复产生的改动，并单独一个提交 `style: ...`。

## 要做什么
1. 行尾：根 `.gitattributes` 写 `* text=auto eol=lf`（可加二进制例外），删掉两个包里各自的 `.gitattributes`；根 `biome.json` 的 `formatter.lineEnding` 改回 `"lf"`。处理好本机 `core.autocrlf=true` 下的重新归一化（`git add --renormalize .`），确认 `pnpm lint` 在本 worktree 里通过。
2. Biome：两个包的 `biome.json` 改为 `{ "root": false, "extends": "//" }` 或删掉；它们的 `lint` 脚本去掉 `--config-path`。根配置已排除 `*.md` / `*.yaml`，保持。
3. TypeScript：两个包的 `tsconfig.json` 改为 `extends: "../../tsconfig.json"` 并显式 `include: ["src"]`；保证根 `pnpm typecheck` 能覆盖到两个包（在根 `typecheck` 脚本里追加 `-p packages/core` / `-p packages/agent-runtime`，或用 `tsc -b` references，二选一，说明理由）。
4. 依赖：删掉两个包的 `pnpm-lock.yaml`；两个包的 devDependencies（typescript / vitest / biome / @types/node）去掉，统一由根提供；`@earendil-works/pi-*` 三件套留在 `packages/agent-runtime/package.json` 的 `dependencies`（钉 1.4.0）。根 `pnpm-workspace.yaml` 对 `@google/genai`、`protobufjs` 的构建脚本做出决定（建议忽略，并写注释）。根目录 `pnpm install` 后锁文件干净、无警告。`@fynvra/*` 不进根 `dependencies`（走 alias 打包源码）。
5. `coreTypes.ts` → 改为从 `@fynvra/core` 导入；`packages/agent-runtime/package.json` 加 `"@fynvra/core": "workspace:*"`。两个包的 `README.md` 里关于「临时独立配置」的段落删掉或改为现状。
6. 根 `vitest.config.ts` 已 include `packages/*/src/**/*.test.ts`；确认根 `pnpm test` 跑出 84 + 200 + 122 = 406 个用例（真实 git 集成测试不要被 skip）。
7. 回写 `docs/ARCHITECTURE.md` §5（见范围）。

## 验收标准
- 根目录从零：删 `node_modules`、`packages/*/node_modules`、`out` 后 `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全部 exit 0。
- `git status` 干净；仓库里没有任何 CRLF 文件（`git ls-files --eol | grep -v 'i/lf'` 只剩二进制）。
- 没有残留 `packages/*/pnpm-lock.yaml`、`packages/*/biome.json`（或只剩 `root:false` 版）、`coreTypes.ts`。

## 提交
多次小提交，`<type>(<scope>): <summary>`，末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不 push、不建 PR。

## 完成动作
按 `.workflow/specs/01-workflow.md` 第 5 条：写 `.workflow/scratch/bootstrap/summary-integrate-workspace.md` 并提交，`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
