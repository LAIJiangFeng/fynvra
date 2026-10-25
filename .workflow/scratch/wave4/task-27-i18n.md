# Task 27 · i18n —— 语言切换（简体中文 / English / 跟随系统）

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`、`.workflow/scratch/wave3/summary-copy-trim.md`（文案极简，翻译后同样极简）。
参考 EnsoCode：`src/shared/i18n.ts`（`Locale`、`normalizeLocale`、`translate`）、`src/renderer/i18n.ts`。只学结构，不引入第三方 i18n 库。
**本卡在 Task 24 / 25 / 26 合并之后开工**，因为要改遍所有组件的文案。

## 范围（允许改）
- `src/shared/i18n/**`（新建：`Locale = 'zh-CN' | 'en'`、`normalizeLocale`、字典类型、`t(key, params)`）、`src/shared/types/settings.ts`（`Preferences.language: 'system' | 'zh-CN' | 'en'`）
- `src/renderer/i18n/**`（新建：`zh-CN.ts`、`en.ts` 字典、`useT()`、`I18nProvider`）、`src/renderer/**` 所有组件：把用户可见字符串替换为 `t('...')`
- `src/main/**`：Main 产生的用户可见文案（IPC 错误、通知标题、告警）改为返回 **消息 key + 参数**（`{ key, params }`）或在 Main 按当前语言翻译（二选一，说明理由；推荐 Main 按设置里的语言翻译，字典放 `src/shared/i18n`）
- `src/renderer/components/settings/GeneralSettings.tsx`：顶部加「语言」下拉（跟随系统 / 简体中文 / English）
- 内置角色的 `description`（`packages/core/src/roles/builtin.ts`）可改为 key，由 Renderer 翻译

## 要做什么
1. 字典按页面分命名空间；`t` 缺 key 时回退 zh-CN 并在 dev 下 console.warn；测试断言两份字典 key 集合一致。
2. 切换语言立即生效（不重启），标题栏 / 侧栏 / 设置 / 聊天 / 编排面板 / 弹窗 / 空态 / tooltip 全覆盖；日期相对时间（「刚刚」「10 小时前」）按语言。
3. 英文文案同样极简。
4. 测试：normalizeLocale、字典一致性、relative time、Main 翻译函数。

## 验收标准
根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿；`pnpm dev` 切到 English 后 grep 页面 DOM 没有中文（截图或 DOM 证据）。

## 提交 / 完成动作
`<type>(renderer|shared|main): <summary>` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不 push 不建 PR。
写 `.workflow/scratch/wave4/summary-i18n.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
