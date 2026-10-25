# Task 23 · copy-trim —— 全局精简界面文案：一眼能懂的东西不解释

先读：`.workflow/specs/01-workflow.md`、`AGENTS.md`。这是一张纯 renderer 文案卡，不改任何逻辑。
用户原话：「红框太多描述了，不需要多余的描述」「一看就能看懂的东西，你还写那么多干嘛」。

## 原则
- 控件名称本身能说明用途的，**不加说明文字**。选项只留名称（必要时加一个英文 id），不要「执行命令、写入 / 编辑文件、调用 MCP 工具前都先问你」这种整句。
- 弹窗 / 页面副标题：删掉；真有必要的压成 ≤ 12 个字。
- 底部的操作提示（如「在输入框里按 Shift+Tab 循环切换……」）：删掉，快捷键放进 tooltip 或胶囊的 `title`。
- 告警 / 警告条：一行一条，只写「主体：原因」，不写后续建议；可折叠为「N 条提示」默认收起。
- 列表项的说明行：「已有命令和参数相同的服务「pencil」，不再导入」→ 改为徽标「已有」，hover 再给原因。
- 空态文案：一句话，不超过 20 字。
- 不改语义、不改交互、不动逻辑；只改字符串与是否渲染说明元素。

## 范围（允许改）
- `src/renderer/components/**`（仅 JSX 文案、说明元素的增删、`title` / tooltip）、`src/renderer/components/chat/*.ts` 与 `settings/*.ts` 里的标签常量（如 `APPROVAL_MODE_LABELS` 的说明字段、`THINKING_LEVEL_HINTS`）及其测试
- `src/shared/types/chat.ts` 里纯展示用的标签 / 提示常量（如有）及测试
- 不动 Main、preload、packages、store 逻辑。

## 必改清单（用户点名）
1. 审批档位选择器：三项只留「全程审批 supervised / 自动接受编辑 auto-edits / 完全放行 full」，删掉每项下面的说明和底部整段提示；Shift+Tab 提示放进胶囊 tooltip（一句：「Shift+Tab 切换」）。
2. MCP 导入弹窗：删掉顶部副标题；候选行的重复说明改徽标「已有」+ hover；底部警告改为一行一条「来源 · 名称：原因」，超过 2 条折叠。
3. 同样处理模型服务导入弹窗、拉取模型列表面板、角色编辑器、设置页各页头部副标题与表单下方说明（「带徽标的模型由内置目录决定是否推理；……」这类）、通用页、新建会话弹层、模型选择器底部说明、输入框 placeholder（「输入消息，Enter 发送，Shift+Enter 换行，↑ …」→「输入消息」，快捷键放 tooltip）。
4. 全局 grep 中文句号「。」结尾的 JSX 文案逐个过一遍，列在总结里：保留的说明理由。

## 验收标准
- 根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿。
- 总结里附「改前 → 改后」对照表（至少覆盖必改清单 1~3 的每一处）。

## 提交 / 完成动作
`style(renderer): <summary>` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不 push 不建 PR。
写 `.workflow/scratch/wave3/summary-copy-trim.md` 并提交；`orca worktree set --worktree current --workspace-status in-review --comment "..." --json`。
