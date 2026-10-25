# Summary · Task 23 copy-trim（全局精简界面文案：一眼能懂的东西不解释）

分支 `LAIJiangFeng/copy-trim`。worktree 建在 `f5c2e91`（Initial commit）上：开工时确认 HEAD 是 `main` 的祖先，`git merge --ff-only main` 快进到 `a978cc8`，在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`（没有产生改动），再 `pnpm install --frozen-lockfile`。写总结时 `main` 仍是 `a978cc8`，`git merge-tree --write-tree main HEAD` 退出码 0。

相对 `a978cc8` 有 10 个 `style(renderer)` 提交（29 个文件，+352 / −418），另有本总结的 `docs(wave3)` 提交。每个提交都带 `Co-Authored-By: Claude Opus 5.5`，没有 push，没有建 PR。没有 BLOCKED 项。改动全部在范围内：`src/renderer/components/**`（JSX 文案、说明元素的增删、`title`）、`settings/*.ts` 的标签函数及其测试、`src/shared/types/chat.ts` 的展示常量及其测试；没有动 Main、preload、packages、store。

## 做了什么

| 提交 | 内容 |
|---|---|
| `dbe2f8b` | 必改 1：审批档位列表每项只留「名称 + 档位 id」，删每项说明和底部整段提示；Shift+Tab 只放进胶囊悬停提示「Shift+Tab 切换」；删掉没有使用方的 `APPROVAL_MODE_HINTS` |
| `2b0deeb` | 必改 2：MCP 导入弹窗删副标题；重复说明行改徽标「已有」/「重复」+ 悬停原因；底部告警一行一条「来源 · 名称：原因」，超过 2 条折叠成「N 条提示」。新增 `settings/warnings.ts`（`warningLine`）与 `settings/common.tsx` 的 `WarningList` |
| `ef441bd` | 必改 3：模型服务导入弹窗同样处理（副标题、徽标、告警、空态、模型摘要） |
| `8c7448c` | 必改 3：拉取模型列表面板的提示换成 `WarningList`；重新拉取的悬停提示压短 |
| `31d2c3d` | 必改 3：输入框 placeholder →「输入消息」，快捷键放进输入框悬停提示 |
| `cb24f6c` | 必改 3：新建会话弹层、模型选择器底部说明、状态栏悬停；档位来源小字改成「推断 / 兜底」徽标；`THINKING_LEVEL_HINTS` 只留几个字 |
| `c80ff09` | 必改 3：角色编辑器选项只留名称，审批档位改用与胶囊同名的标签，表单说明压到几个字 |
| `18f1f7f` | 必改 3：设置页六个页头副标题、分组说明、空态说明、通用页说明；`SectionHeader` 去掉说明位 |
| `c2a3eee` | 必改 3：服务 / MCP / 扫描技能弹窗副标题，服务弹窗模型列表下的「带徽标的模型由内置目录决定……」 |
| `5a179af` | 必改 4：「。」扫描里编排面板的空态与提示 |

### 新加的两个小部件（只管展示）

- **`warningLine(warning)`**（`settings/warnings.ts`）：告警是 Main 给的整句，Main 不在范围内，所以在 Renderer 去掉句末的后续动作与建议。只认 Main 现有的几种开头：`，已跳过`、`，已忽略…`、`，已改用…`、`，导入后…`、`，fynvra 不会展开…`、`，这里只列出…`，从第一处起去到句尾；原因里的逗号不受影响（「读取失败（EACCES，…）」「模型太多，只列出前 2000 个」原样保留）；不会去成空串。整句总在悬停提示里。
- **`WarningList`**（`settings/common.tsx`）：一行一条（`truncate`，`title` 为整句）；超过 `INLINE_WARNING_LIMIT = 2` 条时折叠成「N 条提示」，默认收起（Base UI Collapsible，触发器是 `type="button"`，放在服务弹窗的 `<form>` 里不会触发保存）。三处告警（MCP 导入、模型服务导入、拉取模型列表）共用。
- **`duplicateBadge(candidate)`**（`mcpImport.ts` / `providerImport.ts`，与各自已有的 `duplicateReason` 并列）：与已有服务器 / 服务重复是「已有」，与上面的候选重复是「重复」。见注意事项 1。
- **`thinkingSourceBadge(source)`**（`chat.ts`）+ **`ThinkingSourceBadge`**（`ModelPicker.tsx`）：推断来的档位标「推断」、兜底的标「兜底」，悬停是原来的那句 `thinkingSourceNote`。模型选择器、新建会话弹层、角色编辑器共用。

## 改前 → 改后对照

### 1. 审批档位选择器（`ApprovalModePicker.tsx`）

| 位置 | 改前 | 改后 |
|---|---|---|
| 列表第 1 项 | 「全程审批 supervised」+ 第二行「执行命令、写入 / 编辑文件、调用 MCP 工具前都先问你」 | 「全程审批 supervised」 |
| 列表第 2 项 | 「自动接受编辑 auto-edits」+「写入 / 编辑文件直接放行；执行命令、调用 MCP 工具前仍先问你」 | 「自动接受编辑 auto-edits」 |
| 列表第 3 项 | 「完全放行 full」+「不再询问；rm -rf、git push、git reset --hard、publish 等保护底线仍要你确认」 | 「完全放行 full」 |
| 列表底部 | 「在输入框里按 Shift+Tab 循环切换。运行中也能切，下一次需要审批的工具调用起生效；保护底线任何档位都要你确认。」 | 删除 |
| 胶囊悬停 | 「审批档位：全程审批（执行命令、写入 / 编辑文件、调用 MCP 工具前都先问你），Shift+Tab 切换」 | 「Shift+Tab 切换」 |
| 状态栏档位悬停 | 「审批档位：全程审批（……）；在输入框里按 Shift+Tab 切换」 | 「审批档位（Shift+Tab 切换）」 |
| 列表宽度 | `w-80`（两行） | `w-64`（单行） |

### 2. MCP 导入弹窗（`McpImportDialog.tsx`）

| 位置 | 改前 | 改后 |
|---|---|---|
| 顶部副标题 | 「只读取下面这些工具的配置，不会改动它们。环境变量与 Header 的值只在本机读取，这里只显示键名。」 | 删除（读哪些文件仍在各来源开关的悬停提示里） |
| 候选行（与已有重复） | 说明行「已有命令和参数相同的服务器「GitHub」，不再导入」 | 徽标「已有」，悬停「已有命令和参数相同的服务器「GitHub」」 |
| 候选行（与上面的候选重复） | 说明行「与上面的「Claude Code · pencil」命令和参数相同，不再导入」 | 徽标「重复」，悬停「与上面的「Claude Code · pencil」命令和参数相同」 |
| 底部告警 | 整句，`break-all` 折成多行，如「Codex · github：环境变量 GITHUB_TOKEN 没有设置，导入后需要在编辑里补上」 | 一行一条「Codex · github：环境变量 GITHUB_TOKEN 没有设置」，整句悬停；超过 2 条折叠为「N 条提示」，默认收起 |
| 告警（引用变量） | 「Cursor · figma：环境变量 TOKEN 引用了变量，fynvra 不会展开，导入后请在编辑里改成实际值」 | 「Cursor · figma：环境变量 TOKEN 引用了变量」 |
| 告警（跳过） | 「Claude Code · pencil：没有命令或 URL，已跳过」 | 「Claude Code · pencil：没有命令或 URL」 |
| 空态 | 「没有找到可导入的 MCP 服务器」+「只读这些工具的用户级配置（Claude Code 还包括 ~/.claude.json 里各项目的配置），项目目录里的 .mcp.json 不读。」 | 「没有找到可导入的 MCP 服务器」 |

### 3. 其余点名的地方

**模型服务导入弹窗**（`ProviderImportDialog.tsx`、`providerImport.ts`）

| 位置 | 改前 | 改后 |
|---|---|---|
| 顶部副标题 | 「只读取 Claude Code、Codex 与 CC Switch 的配置，不会改动它们。API Key 只在本机读取，这里只显示末 4 位。」 | 删除 |
| 候选行重复说明 | 「已有地址和 API Key 都相同的服务「公司中转」，不再导入」/「与上面的「Claude Code」地址和 API Key 都相同，不再导入」 | 徽标「已有」/「重复」，原因悬停 |
| 没有 key | 「没有 API Key，导入后需要填写」 | 「没有 API Key」 |
| 模型摘要 | 「未写模型：导入时使用内置的预置模型」/「未写模型：导入后在「编辑」里添加」 | 「未写模型（用预置模型）」/「未写模型」 |
| 空态 | 「没有找到可导入的配置」+「只有填写了 API Key 或自定义地址的配置才能导入；用官方账号登录的不行。」 | 「没有找到带 API Key 或自定义地址的配置」 |
| 底部告警 | 整句，如「CC Switch · 公司中转：环境变量 OPENAI_KEY 没有设置，导入后需要在编辑里填写 API Key」 | `WarningList`：「CC Switch · 公司中转：环境变量 OPENAI_KEY 没有设置」 |

**拉取模型列表面板**（`RemoteModelsPicker.tsx`）

| 位置 | 改前 | 改后 |
|---|---|---|
| 底部提示 | 「GET /v1/models 不可用（HTTP 404），已改用 GET /models」「服务端还有更多模型没有返回，这里只列出了第一页」 | 「GET /v1/models 不可用（HTTP 404）」「服务端还有更多模型没有返回」，整句悬停，超过 2 条折叠 |
| 重新拉取悬停 | 「按表单当前的协议、地址与 API Key 重新拉取」 | 「重新拉取」 |

**角色编辑器**（`RoleEditor.tsx`）

| 位置 | 改前 | 改后 |
|---|---|---|
| 只读提示 | 「内置角色只读。需要调整时点「复制为新角色」，在副本上修改。」 | 「内置角色只读」 |
| ID 说明 | 「保存为 roles/<id>.json，之后不可修改」 | 「保存后不可修改」 |
| 系统提示词说明 | 「追加在默认系统提示词之后；随角色文件保存，不进 settings.json。」 | 「追加在默认系统提示词之后」 |
| 工具策略选项 | 「全部工具（读写文件、执行命令）/ 只读（读文件、搜索、git 只读）/ 编排（只读 + 派活工具）」 | 「全部工具 / 只读 / 编排」 |
| 审批档位选项 | 「每次工具调用都确认 / 自动放行文件编辑 / 全部自动放行」 | 「全程审批 / 自动接受编辑 / 完全放行」（与输入框胶囊同名） |
| 模型说明 | 「这个模型不支持推理，不设思考档位」 | 「不支持推理」 |
| 档位读取中 | 「正在读取这个模型的思考档位…」 | 「读取中…」 |
| 读不到档位 | 「服务已停用、没填 API Key 或模型已删除，读不到这个模型的思考档位」 | 「读不到这个模型的档位」，原因悬停 |
| 读取失败 | 「读取思考档位失败：…」 | 「读取档位失败：…」 |
| 档位来源 | 下拉下方小字「按 gpt-5.6-sol 推断」/「目录里没有这个模型，按协议兜底」 | 标签「思考档位」旁徽标「推断」/「兜底」，原句悬停 |
| 技能 / MCP 空态 | 「还没有登记技能：在「技能」里扫描或添加」/「还没有 MCP 服务器：在「MCP」里添加或导入」 | 「还没有技能」/「还没有 MCP 服务器」 |
| 已移除的条目 | 徽标「已移除」+ 说明行「已从注册表移除」 | 只留徽标 |

**设置页各页头部副标题**（`SettingsView.tsx`）

| 页 | 改前 | 改后 |
|---|---|---|
| 通用 | 「worktree 的存放位置，以及它们占用的磁盘空间。」 | 删除，页头只留「通用」 |
| 模型服务 | 「Anthropic、OpenAI、Google 与 OpenAI 兼容服务的地址、API Key 和模型。」 | 删除 |
| 角色 | 「系统提示词、模型、工具策略、审批档位、技能与 MCP 的组合；每个角色保存为 roles/<id>.json。」 | 删除 |
| 技能 | 「技能目录的引用注册表：扫描本机 Claude Code / Codex / pi 的技能，或手动添加目录。」 | 删除 |
| MCP | 「MCP 服务器：手动添加，或导入本机 Claude Code 的配置。」 | 删除 |
| 外观 | 「界面主题。」 | 删除 |

**设置页分组说明、空态、删除确认**（`ProvidersSettings` / `McpSettings` / `SkillsSettings` / `AppearanceSettings`）

| 位置 | 改前 | 改后 |
|---|---|---|
| 模型服务分组 | 「角色与会话从这里选用模型。API Key 只保存在本机，界面上只显示末 4 位。」 | 删除（`SectionHeader` 不再有说明位） |
| MCP 服务器分组 | 「角色从这里挑选 MCP 服务器。环境变量与 Header 的值只保存在本机，界面上只显示键名。」 | 删除 |
| 技能分组 | 「按引用登记技能目录（含 SKILL.md），文件留在原处，不复制内容。角色从这里挑选技能。」 | 删除 |
| 主题分组 | 「浅色、深色，或跟随系统的明暗设置。」 | 删除 |
| 模型服务空态 | 「还没有模型服务」+「从本机的 Claude Code、Codex、CC Switch 导入，或添加 Anthropic、OpenAI、Google、任意 OpenAI 兼容服务，角色和会话才能选用模型。」 | 「还没有模型服务」（导入 / 各家服务的按钮照旧） |
| MCP 空态 | 「还没有 MCP 服务器」+「手动添加，或从本机的 Claude Code、Codex、……导入（按命令 + 参数 / URL 去重）。」 | 「还没有 MCP 服务器」 |
| 技能空态 | 「还没有登记技能」+「扫描本机 Claude Code、Codex、pi 的技能目录，或手动添加一个含 SKILL.md 的目录。」 | 「还没有登记技能」 |
| 服务卡片没有模型 | 「还没有模型，点「编辑」添加」 | 「还没有模型」 |
| 删除服务确认 | 「引用它的角色需要重新选择模型。」 | 「引用它的角色需重选模型」 |
| 删除 MCP 确认 | 「删除后引用它的角色将不再加载它。」 | 「引用它的角色将不再加载它」 |

**设置里的弹窗与表单下方说明**（`ProviderDialog` / `McpDialog` / `SkillScanDialog`）

| 位置 | 改前 | 改后 |
|---|---|---|
| 服务弹窗副标题 | 「API Key 只保存在本机的 providers.json，不会回显到界面。」 | 删除 |
| Base URL | 「必填：OpenAI 兼容接口的地址，通常以 /v1 结尾」/「留空使用官方地址 https://api.anthropic.com」 | 「必填」/「留空使用官方地址」（地址就在 placeholder 里） |
| 清除 key | 「保存后将清除已保存的 key」 | 「保存后清除 key」 |
| 模型列表空态 | 「还没有模型：在下面输入模型 id 添加」 | 「还没有模型」 |
| 模型列表下方 | 「带徽标的模型由内置目录决定是否推理；其他模型用「推理」开关标记，打开后会话里可选思考档位。」 | 删除；徽标悬停本来就是「由内置目录决定」，「推理」开关补悬停「打开后会话里可选思考档位」 |
| MCP 弹窗副标题 | 「环境变量与 Header 的值只保存在本机的 mcp.json，界面上只显示键名。」 | 删除 |
| 扫描技能副标题 | 「来自 ~/.claude/skills、~/.codex/skills 与 ~/.pi/agent/skills；同名技能只保留先出现的来源。」 | 删除（来源目录在来源徽标的悬停里） |

**通用页**（`GeneralSettings.tsx`）

| 位置 | 改前 | 改后 |
|---|---|---|
| Worktree 位置说明 | 「主 agent 派发的每个任务都在自己的 git worktree 里进行。修改只影响之后新建的 worktree，已有的留在原处。」 | 删除（选完目录后的提示「之后新建的 worktree 放在 X 下」照旧） |
| 磁盘占用说明 | 「各工作区编排记录里登记的 worktree。已合并任务的 worktree 会在 cleanup 后删除。」 | 删除 |
| 空态 | 「还没有挂入工作区」+「挂入仓库后，这里会列出它的 worktree 放在哪、占了多少空间。」 | 「还没有挂入工作区」 |
| 默认位置 | 「默认：仓库同级目录」[默认] +「建在仓库旁边的 <仓库目录名>-worktrees 里，与仓库同盘；仓库父目录不可写时退回 <userData>/worktrees。」 | 「仓库同级目录」[默认] + 一行 `<仓库目录名>-worktrees`，退回位置悬停 |
| 自定义目录 | 路径 +「按仓库分子目录：<根目录>/<仓库目录名>/…」 | 路径，分子目录规则悬停 |
| 工作区已退回 | 徽标「已退回默认数据目录」+ 原因行「仓库 X 在磁盘根目录上，没有同级目录」 | 徽标「已退回数据目录」，原因悬停 |

**新建会话弹层**（`NewSessionButton.tsx`）

| 位置 | 改前 | 改后 |
|---|---|---|
| 副标题 | 「选择会话使用的角色与模型。主 agent 负责拆任务、派 worker、验收合并，自己不改代码。」 | 删除 |
| 没写描述的角色 | 斜体占位「没有描述」 | 不显示 |
| 角色读取失败 | 「角色列表读取失败，先显示内置角色（…）」 | 「读取角色失败：…」 |
| 模型读取失败 | 「读取可选模型失败（…），创建时由默认模型服务决定」 | 「读取模型失败：…」 |
| 没有可用服务 | 「还没有可用的模型服务：在「设置 → 模型服务」里启用一个填写了 API Key 的服务」 | 「还没有可用的模型服务」，补法悬停 |
| 档位来源 | 档位下方小字 | 「思考档位」旁徽标 |

**模型选择器底部说明与悬停**（`ModelPicker.tsx`、`StatusBar.tsx`、`chat.ts`）

| 位置 | 改前 | 改后 |
|---|---|---|
| 运行中（底部 + 胶囊悬停） | 「会话正在运行，等本轮结束再切换模型」 | 「运行中不能切换模型」 |
| 读取失败 | 「读取可选模型失败：…」 | 「读取模型失败：…」 |
| 档位来源 | 档位下方小字「按 X 推断」/「目录里没有这个模型，按协议兜底」 | 「思考档位」旁徽标「推断」/「兜底」 |
| 没有可用服务 | 同新建弹层 | 同新建弹层 |
| 胶囊悬停 | 「切换模型（思考档位 high：深入思考）」 | 「切换模型」 |
| 状态栏模型悬停 | 「Anthropic · claude-opus-5-5 · high（深入思考），点击切换模型」 | 「切换模型（Anthropic · claude-opus-5-5 · high）」 |
| 档位悬停（`THINKING_LEVEL_HINTS`） | 「关闭思考：不推理，直接回答」「适中：速度与深度折中」「最大思考：不设上限，最慢、最费 token」等 | 「关闭思考 / 极少思考 / 少量思考 / 适中 / 深入思考 / 更深入思考 / 最大思考」 |

**输入框**（`Composer.tsx`）

| 位置 | 改前 | 改后 |
|---|---|---|
| placeholder | 「输入消息，Enter 发送，Shift+Enter 换行，↑ 翻出发过的消息」；运行中「agent 正在运行，可以先写下一条…」 | 「输入消息」（运行中也是） |
| 悬停 | 无 | 「Enter 发送，Shift+Enter 换行，↑ / ↓ 翻历史消息」 |

## 4. 「。」结尾的 JSX 文案逐个过

开工时 `src/renderer/components/**` 里非注释、带「。」的界面文案共 35 处（`SettingsView` 的 6 个副标题按 6 处算）。处理结果：删除 28 处，改写成不带句号的短句 7 处；改完后同样的扫描结果为 0。

| # | 位置（`a978cc8` 行号） | 原文（节选） | 处理 |
|---|---|---|---|
| 1 | `chat/ApprovalModePicker.tsx:127` | 在输入框里按 Shift+Tab 循环切换。运行中也能切…… | 删除 |
| 2 | `chat/NewSessionButton.tsx:96` | 选择会话使用的角色与模型。主 agent 负责…… | 删除 |
| 3 | `orchestration/ChangesView.tsx:71` | worker 汇报完成后，它的改动会出现在这里。 | 删除 |
| 4 | `orchestration/ChangesView.tsx:134` | 主 agent 合并后会删除 worker 的 worktree…… | 删除 |
| 5 | `orchestration/ChangesView.tsx:233` | worktree 已清理，这是清理前读到的改动。 | **保留并压短**：「worktree 已清理，这是清理前的改动」——琥珀色提示，看到的是清理前缓存的 diff，不提醒会当成最新的 |
| 6 | `orchestration/OrchestrationPanel.tsx:103` | 在 Orchestrator 会话里描述需求…… | 删除 |
| 7 | `settings/AppearanceSettings.tsx:20` | 浅色、深色，或跟随系统的明暗设置。 | 删除 |
| 8 | `settings/GeneralSettings.tsx:61` | 主 agent 派发的每个任务都在自己的 git worktree 里进行。…… | 删除 |
| 9 | `settings/GeneralSettings.tsx:88` | 各工作区编排记录里登记的 worktree。…… | 删除 |
| 10 | `settings/GeneralSettings.tsx:109` | 挂入仓库后，这里会列出…… | 删除 |
| 11 | `settings/GeneralSettings.tsx:145` | 建在仓库旁边的 <仓库目录名>-worktrees 里……退回 <目录>。 | **改写**：只留一行命名规则 `<仓库目录名>-worktrees`（数据，不是句子），退回位置放悬停 |
| 12 | `settings/McpDialog.tsx:101` | 环境变量与 Header 的值只保存在本机的 mcp.json…… | 删除 |
| 13 | `settings/McpImportDialog.tsx:135` | 只读取下面这些工具的配置，不会改动它们。…… | 删除 |
| 14 | `settings/McpImportDialog.tsx:184` | 只读这些工具的用户级配置……项目目录里的 .mcp.json 不读。 | 删除 |
| 15 | `settings/McpSettings.tsx:40` | 角色从这里挑选 MCP 服务器。…… | 删除 |
| 16 | `settings/McpSettings.tsx:63` | 手动添加，或从本机的 …… 导入（按命令 + 参数 / URL 去重）。 | 删除 |
| 17 | `settings/McpSettings.tsx:137` | 删除后引用它的角色将不再加载它。 | **保留并压短**：「引用它的角色将不再加载它」——不可逆操作前说清后果 |
| 18 | `settings/ProviderDialog.tsx:146` | API Key 只保存在本机的 providers.json…… | 删除 |
| 19 | `settings/ProviderDialog.tsx:309` | 带徽标的模型由内置目录决定是否推理；…… | 删除（推理开关补悬停提示） |
| 20 | `settings/ProviderImportDialog.tsx:134` | 只读取 Claude Code、Codex 与 CC Switch 的配置…… | 删除 |
| 21 | `settings/ProviderImportDialog.tsx:182` | 只有填写了 API Key 或自定义地址的配置才能导入；用官方账号登录的不行。 | **并进空态一句**：「没有找到带 API Key 或自定义地址的配置」——用官方账号登录的配置导不进来是最常见的困惑 |
| 22 | `settings/ProvidersSettings.tsx:48` | 角色与会话从这里选用模型。…… | 删除 |
| 23 | `settings/ProvidersSettings.tsx:82` | 从本机的 Claude Code、Codex、CC Switch 导入，或添加……。 | 删除 |
| 24 | `settings/ProvidersSettings.tsx:223` | 引用它的角色需要重新选择模型。 | **保留并压短**：「引用它的角色需重选模型」——同 17 |
| 25 | `settings/RoleEditor.tsx:159` | 内置角色只读。需要调整时点「复制为新角色」…… | **保留并压短**：「内置角色只读」——解释整张表单为什么是灰的；「复制为新角色」按钮就在下面 |
| 26 | `settings/RoleEditor.tsx:201` | 追加在默认系统提示词之后；随角色文件保存，不进 settings.json。 | **保留并压短**：「追加在默认系统提示词之后」（12 字）——不说的话猜不出是追加还是替换 |
| 27–32 | `settings/SettingsView.tsx:38/45/53/61/68/75` | 六个页头副标题 | 删除 |
| 33 | `settings/SkillScanDialog.tsx:119` | 来自 ~/.claude/skills、……；同名技能只保留先出现的来源。 | 删除 |
| 34 | `settings/SkillsSettings.tsx:48` | 按引用登记技能目录（含 SKILL.md）…… | 删除 |
| 35 | `settings/SkillsSettings.tsx:71` | 扫描本机 Claude Code、Codex、pi 的技能目录…… | 删除 |

范围外、没有动的「。」：`src/renderer/lib/api/sessions.ts`、`orchestration.ts` 里的 mock 演示数据（假 agent 的回复、假任务书），不是界面文案；其余都在代码注释里。

其他留下的短说明（不带句号）及理由：「一行一个参数」（MCP 参数的格式约束）、「必填」「留空使用官方地址」「保存后不可修改」「保存后清除 key」（表单约束）、「先在「模型服务」里添加服务」（角色编辑器里没有任何服务时唯一的出路）、操作后的状态反馈（「已保存到 roles/<id>.json」「已恢复默认：之后新建的 worktree 放在仓库同级目录」「已加入 N 个模型，保存后生效」——通用页的「只影响之后新建的」说明删掉后，就靠这句反馈说清）。

## 怎么验证

**基线**（`a978cc8`）：typecheck 0；lint 0（377 个文件）；test 126 个文件 / 1845 个用例全过。

**验收命令**（最终提交，根目录）：

```
pnpm typecheck  → exit 0（node / web / packages 三段）
pnpm lint       → exit 0：Checked 379 files … No fixes applied.
pnpm test       → exit 0：Test Files 127 passed (127)；Tests 1852 passed (1852)
pnpm build      → exit 0：out/main/index.js 336.45 kB、out/main/chunks/index-<hash>.js（worker）130.83 kB、
                  out/preload/index.cjs 13.10 kB、out/renderer/assets/index-<hash>.js 2,531.18 kB；
                  out/main/index.js 里 @earendil-works 出现 0 次
```

**用例变化**（+7 = 1852 − 1845）：

| 文件 | 变化 | 覆盖 |
|---|---|---|
| `settings/warnings.test.ts`（新） | +5 | 用 Main 实际给出的告警做样本：去掉「，已跳过」「，已忽略其中的 key」；去掉「导入后……」建议；两段后续从第一段起去掉；拉取模型列表的「已改用」「这里只列出了第一页」；**没有后续的原样保留**（原因里带逗号、「模型太多，只列出前 2000 个」、「已略过……」）；不会去成空串 |
| `settings/mcpImport.test.ts` | +1 | `duplicateBadge`：不重复为 null，与候选重复「重复」，与已有重复「已有」 |
| `settings/providerImport.test.ts` | +1，改 1 | 同上；模型摘要的新写法 |
| `shared/types/chat.test.ts` | +1，−1，改 1 | `thinkingSourceBadge`；删掉 `APPROVAL_MODE_HINTS` 的用例；档位悬停文案改为断言「几个字、不是句子」（含中文、不含「：，、；」、≤ 6 字、互不相同） |

**TDD 顺序**：`warnings` 与 MCP 的 `duplicateBadge`（模块不存在 / 不是函数，红）、模型服务导入（2 红）、`chat.ts` 的档位悬停与 `thinkingSourceBadge`（2 红）都是先写测试跑红再实现；组件改动是文案与元素增删，靠 typecheck / lint / build 与下面的渲染冒烟。

**渲染冒烟**（临时文件，跑完即删，没有提交）：用 `react-dom/server` 把 `WarningList` 与 `ThinkingSourceBadge` 渲染成 HTML（4 个断言全过）：
- 2 条告警：两个 `<li title="整句">`，可见文字是「Codex · github：环境变量 GITHUB_TOKEN 没有设置」「Claude Code · pencil：没有命令或 URL」，没有「条提示」；
- 3 条告警：只渲染 `<button type="button" aria-expanded="false">… 3 条提示</button>`，列表默认不在 DOM 里；
- 没有告警：空串；
- 徽标：`<span … title="按 gpt-5.6-sol 推断">推断</span>`，`catalog` 时不渲染。

**提交前扫描**：29 个改动文件没有不可见字符（BOM / 零宽 / U+2028 / U+2029 / NBSP），`git ls-files --eol` 全是 `i/lf w/lf`。

**没有做真机（Electron）冒烟**：这张卡只改文案与说明元素，按协作约定由用户在自己的环境里看效果；建议重点看的地方见注意事项 7。

## 未做 / 越界项

- **没有越界改文件**。Main 的告警原文、mock 演示数据、store（`modelChoice.ts` 读 `THINKING_LEVEL_HINTS`，跟着变短，代码没动）都没动。
- **告警的「主体：原因」是在 Renderer 剥出来的**：Main 不在范围内，`warningLine` 按 Main 现有的几种句尾剥离。Main 以后改了措辞，最坏情况是那一条显示整句（仍是一行、可悬停），不会出错。想彻底解耦可以另开卡让 Main 直接给 `{ subject, reason }`。
- **设置页标题重复没有处理**：页头「模型服务」下面分组标题又是「模型服务」，「技能」同样。这是布局，不是说明文案，任务书没点名；要去掉可以让这两页不显示分组标题、只留按钮行。
- **保留的 placeholder**：「一句话说明这个角色做什么」「模型 id，例如 deepseek-chat」「例如 github」「例如 npx」「已保存，留空则不修改」「已保存 ••••1234，留空则不修改」——在输入框里、不占版面，不是说明元素。
- **保留的悬停提示**：「值只在本机读取，不在界面显示」（key 徽标）、「从注册表移除（不删除文件）」、「拖动调整宽度，双击恢复默认」、开发模式的「使用演示数据（开发模式，会重新加载页面）」。
- 用户全局说明里的知识库检索（`maestro spec` / `maestro wiki`）本机不可用：没有 `maestro` 命令，`~/.maestro` 也不存在，与前几张卡相同。

## 给验收人的注意事项

1. **重复候选分两种徽标**：任务书写的是「已有」。与上面另一个候选重复的那种（`duplicate: 'candidate'`）fynvra 里其实还没有，标「已有」会误导，所以标「重复」；两种都悬停给原因、都不能勾选。想统一成「已有」只改 `duplicateBadge` 一行（两个文件）和对应用例。
2. **审批档位列表不再提保护底线**：原来 full 那项和列表底部都写着「rm -rf、git push……仍要你确认」，按任务书一并删掉了。真遇到时审批条标题会写「bash（保护底线：git push）」。
3. **说明挪进悬停的地方**（发现性比原来低，是有意的取舍）：告警整句、重复原因、没有可用服务时的补法、档位来源（推断 / 兜底）、读不到档位的原因、worktree 退回位置与分子目录规则、推理开关的作用、输入框快捷键。
4. **`THINKING_LEVEL_HINTS` 变短会影响三处悬停**：模型选择器与新建弹层的档位按钮、角色编辑器的档位下拉（都是 `title`），内容从整句变成「深入思考」这类几个字。
5. **`SectionHeader` 去掉了 `description` 参数**（已无使用方），以后加分组说明会直接类型报错；`EmptyState` / `PanelMessage` 的 `description` 还在，用于显示错误原因（如「读取角色失败」「读取改动失败」）。
6. **运行中的输入框 placeholder** 也统一成「输入消息」：旁边已经显示「运行中」，发送按钮换成了「停止」。
7. **建议在本机看一眼的界面**：输入框（placeholder 与悬停）、审批胶囊列表、模型胶囊列表底部（运行中 / 推断徽标）、新建会话弹层、设置 → 通用 / 模型服务（含服务弹窗与「拉取模型列表」）/ 角色 / 技能 / MCP（含两个导入弹窗：告警 ≤ 2 条逐行、≥ 3 条折叠）、右侧编排面板的空态。
