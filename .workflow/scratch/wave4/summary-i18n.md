# Summary · Task 27 i18n（语言切换：简体中文 / English / 跟随系统）

分支 `LAIJiangFeng/i18n`。worktree 建在 `f5c2e91`（Initial commit）上：开工时 `git merge --ff-only main` 快进到 `4cb718b`，在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`（没有产生改动），再 `pnpm install --frozen-lockfile`、`node node_modules/electron/install.js`（本机缓存，没有下载）。写总结时 `main` 仍是 `4cb718b`，`git merge-tree --write-tree main HEAD` 退出码 0。

相对 `4cb718b` 有 9 个提交（136 个文件，+4855 / −1339），另有本总结的 `docs(wave4)` 提交。每个提交都带 `Co-Authored-By: Claude Opus 5.5`，没有 push，没有建 PR。没有 BLOCKED 项。范围外改了三个 shared 文件及其测试，**开工前经 `orca orchestration ask` 问过验收人、得到同意（选 A）**，见「越界项」。

## 做了什么

| 提交 | 内容 |
|---|---|
| `309a9df` feat(shared) | `src/shared/i18n`：`Locale`、`normalizeLocale` / `resolveLocale`、字典类型（`MessagesShape` / `MessageKey`）、插值与单复数、`createTranslator`（缺 key 回退 zh-CN 并报告）；`Preferences.language` |
| `ea8143d` feat(renderer) | `src/renderer/i18n`：`zh-CN.ts` / `en.ts` 字典、`I18nProvider`、`useT()`、给 store 用的 `translate()`；通用页顶部「语言」下拉；settings store 持久化 `language`；`main.tsx` 等偏好读回再渲染；标题栏、侧栏、主区、设置外壳、外观、通用页 |
| `95b5615` feat(renderer) | 聊天、输入框、审批条与档位胶囊、模型选择器、状态栏、时间线、工具卡片、会话列表 / 搜索 / 新建弹层、会话 store 的提示；角色编辑器与拉取模型列表（它们用到了被移走的 shared 常量） |
| `69e7888` feat(renderer) | 编排面板：任务看板、任务抽屉、消息流、worker 输出、改动视图 |
| `119527a` feat(renderer) | 其余设置页：模型服务（卡片、弹窗、导入）、MCP（列表、弹窗、导入）、技能（列表、扫描）、快捷键、通知、告警列表；开发模式 mock 的报错与「新会话」 |
| `b0234e4` feat(main) | Main 的用户可见文案按设置里的语言翻译：IPC 错误、原生对话框、桌面通知、审批标题、服务测试、拉取模型列表的提示、导入告警、输入校验 |
| `4e9df28` fix(main) | 冒烟发现：四处在翻译结果外面拼了全角标点（HTTP 状态后缀、网络原因后缀、审批通知正文、CC Switch 应用列表），改成整句模板 |
| `02c0aaf` fix(renderer) | MCP 环境变量 / Header 的「分组标题 / 单项名 / 空态」拆成三个 key（英文原来读成 “No Environment variables”）；远程模型行悬停的括号按语言 |
| `2939530` test | i18n 测试里的 CJK 字符区间写成 `\u` 转义（原来是字面字符，含全角空格） |

### 1. 字典与翻译函数

- **结构**：按页面分命名空间的嵌套对象，key 写成点分路径（`settings.general.language`）。Renderer 589 个 key，命名空间 `common, app, workspaces, sessions, chat, model, thinking, approval, tools, orchestration, time, settings, keys`；Main 205 个 key（`src/shared/i18n/main/`）。
- **zh-CN 是基准**：`en.ts` 声明为 `MessagesShape<typeof zhCN>`，少 key、多 key 都编译不过；`t(key)` 的 key 是字面量联合类型，拼错编译不过（动态 key 如 `` t(`sessions.status.${status}`) `` 也按联合类型检查）。
- **缺 key**：回退 zh-CN，再没有就返回 key 本身；开发模式下 `console.warn`（Renderer 由 `I18nProvider` 按 `import.meta.env.DEV` 装上，Main 按 `!app.isPackaged`）。冒烟全程 console 没有出现缺 key 警告。
- **插值**：`{name}`；英文单复数用 `{n|单数|复数}`（如 `'{count} {count|worktree|worktrees}'`），中文写一种即可。不像占位符的花括号（JSON 示例、`<root>/{repo}`）不受影响。没有引入第三方库。
- **测试**：两份字典 key 集合一致、同一 key 两边参数一致、没有空文案、英文里没有中文字符与全角标点、不以句号结尾（Renderer 与 Main 各一份）。

### 2. Renderer：怎么用

- **组件**一律 `const t = useT()`；`I18nProvider`（`main.tsx` 里包住 `<App />`）在渲染子组件之前更新当前语言，并设置 `<html lang>`。切换语言后所有用 `useT()` 的组件立即重渲染，不重启、不重挂载（输入框草稿、展开状态都保留）。
- **跨组件共用的格式化纯函数显式传 `t`**：`formatRelativeTime`、编排的 `formatDuration` / `formatRelative` / `describeSubject` / `messageSummary`、`describeTool`、`thinkingChoices` / `thinkingOptions`、`composerHints`、`thinkingSourceNote`、`catalogName`。测试可以两种语言各测一遍。
- **store 与设置页 `*.ts` 里在动作时产生的提示用 `translate()`**（按当时的语言）：会话 store 的报错、表单校验、导入汇总、`newRole` / `copyRole` 的默认名、mock API。调用它们的组件都经 `useT()` 订阅语言，切换后同一次渲染里拿到新语言。已经显示出来的一条报错（如会话顶部的错误条）保持产生时的语言，下一条起换。
- **日期相对时间按语言**：「刚刚 / 5 分钟前 / 10 小时前 / 昨天」↔ “just now / 5m ago / 10h ago / Yesterday”；编排面板的时长「3 分 12 秒」↔ “3m 12s”。
- **内置角色描述**按 id 翻译（`roleDescription`，`sessions.builtinRoles.*`），没有改 `packages/core`：中文界面下内置角色描述现在是中文（原来一直显示 core 里的英文）。「复制为新角色」时副本带上界面上看到的描述。
- **英文同样极简**：沿用 copy-trim 的规则，控件名说明不了的才放悬停提示，句子不加句号。

### 3. 语言设置

- `Preferences.language?: 'system' | 'zh-CN' | 'en'`，没写过按跟随系统（`languageOf()`），与其他新加的偏好一样是可选字段；`parsePreferences` / `parsePreferencesPatch` 收窄，settings store 连同主题一起写入。
- **跟随系统**：Renderer 看 `navigator.languages`，Main 看 `app.getLocale()` 加 `app.getPreferredSystemLanguages()`（两边同源）；取第一个认得的（zh 开头的含繁体都归简体中文，en 开头为英文），都不认得用英文，什么也没给用简体中文。
- **通用页顶部「语言」下拉**：跟随系统 / 简体中文 / English。语言名用各自的写法、不随界面语言变——切错了也认得出回去的那一项。因此英文界面打开过这个下拉后，DOM 里会有一个「简体中文」选项（冒烟的扫描把它列为唯一例外）。
- **首帧**：`main.tsx` 等偏好读回（最多 1 秒，读失败时 persist 不会报完成）再渲染，选了非系统语言时不会先闪一下系统语言。

### 4. Main：选「Main 按设置语言翻译」，不返回 `{ key, params }`

理由：几十个服务已经返回 `{ ok: false, error: string }`，Renderer 到处直接显示它，还有大量测试断言这些文字；在源头翻译保持这些契约不变，桌面通知、原生对话框（不经过 Renderer）也一并覆盖。代价是已经产生的错误文字不会随切换重新翻译。

- `src/main/i18n.ts`：`translate(key, params)` 每次调用时读 `preferences.language`（改了设置下一条就生效）；不 import electron 与 settings，服务模块的测试照常在 zh-CN 下跑，原有断言全部不用改；语言来源在 `src/main/index.ts` 的 `whenReady` 里接上。
- 覆盖：10 个 `ipc/*.ts` 的错误与原生对话框（挂入目录、git 子目录确认框、选择 worktree 根目录、选择技能目录）、agentHost（worker 未就绪 / 崩溃 / 审批过期、审批标题里的「保护底线」）、通知标题与正文、模型服务测试与解析、拉取模型列表、MCP / 服务导入的扫描告警、MCP / 服务输入校验、worktree 根目录的退回原因与校验、归档、技能登记。
- 导入告警的「后续动作」：中文仍是「，已跳过」，英文统一接在「; 」后（`; skipped`、`; ignored its key`、`; fill it in after import`…），Renderer 的 `warningLine` 两种都去掉，有测试。中文里拉丁字母后补空格的排版（`spaced()`）只在中文下做。
- 不翻译的：开发日志（`console.*`、`log(...)`）；`brief.ts` 里识别任务书小节的中文别名（解析输入，不是输出）；给模型看的工具结果与提示词本来就是英文。

## 越界项（已获验收人同意）

开工时问过验收人：三个 shared 文件里的中文显示常量会出现在界面上，任务书范围没列。验收人选 A：允许小改这三个文件及其测试，展示用中文常量改成 id，Renderer 按 id 查字典。

| 文件 | 改动 |
|---|---|
| `src/shared/types/chat.ts` (+test) | 删掉 `APPROVAL_MODE_LABELS`、`THINKING_LEVEL_LABELS`、`THINKING_LEVEL_HINTS`（搬进字典 `approval.modes` / `thinking.levels` / `thinking.hints`）；`thinkingSourceBadge` + `thinkingSourceNote` 换成 `describeThinkingSource()`，返回 `{ kind: 'fallback' } \| { kind: 'inferred', model }` |
| `src/shared/keybindings.ts` (+test) | 动作表去掉 `label`（字典 `keys.actions.<id>`）；`findConflict` 的保留键冲突返回 id（`'copy'`、`'undo'`…，字典 `keys.reserved`），删掉 `conflictLabel` |
| `src/shared/modelCatalog.ts` | 自定义 OpenAI 兼容模板的 `name` 改为中性的 `'OpenAI Compatible'`，界面按语言显示（`settings.providers.openaiCompatible`，新建时的默认名同样按语言） |

演示数据：开发模式「演示数据」里的假对话、假任务书、假 diff 保持中文（验收人同意）；mock API 的报错与「新会话」走字典。

## 怎么验证

**基线**（`4cb718b`）：typecheck 0；lint 0（423 个文件）；test 146 个文件 / 2169 个用例全过。

**验收命令**（最终提交，根目录）：

```
pnpm typecheck  → exit 0（node / web / packages 三段）
pnpm lint       → exit 0：Checked 434 files … No fixes applied.
pnpm test       → exit 0：Test Files 149 passed (149)；Tests 2209 passed (2209)
pnpm build      → exit 0：out/main/index.js 406.10 kB、out/preload/index.cjs 15.54 kB、
                  out/renderer/assets/index-<hash>.js 2,668.72 kB
```

**新增 / 改动的测试**（+40 = 2209 − 2169）：`shared/i18n/index.test.ts`（normalizeLocale、resolveLocale、isLanguage、插值与单复数、翻译回退与报告、key / 参数列举，16 个）；`renderer/i18n/i18n.test.ts`（字典一致性与当前语言，6 个）；`main/i18n.test.ts`（Main 字典一致性、英文告警格式、Main 翻译函数跟随设置 / 系统，7 个）；`settings.test.ts`（language 收窄，3 个）；`createSettingsStore.test.ts`（language 持久化与重新水合）；相对时间与时长的英文用例（会话列表、编排面板）；工具名、档位、输入框提示、导入辅助函数的英文用例；`warningLine` 的英文告警；`listRemoteModels` 的英文提示与排版。原有用例里断言中文文字的期望值一个没改、全部通过（zh 字典逐字照搬原文；纯函数加了 `t` 参数的，用例只多传一个中文翻译函数）。

**真机冒烟（`pnpm dev`，CDP 驱动，隔离 userData）**：脚本在 `%TEMP%\fynvra-i18n-smoke-273278\scripts\`（`run.ps1` 起假 Anthropic 端点与 dev，`drive.mjs` 驱动）。先挂入一个无 git 目录与一个 git 仓库、注册假模型服务，让主 agent 走完一次编排（dispatch → worker write / report_done → review / checks / merge / cleanup），然后**在设置 → 通用的「语言」下拉里点 English**（CDP 鼠标事件），逐个视图扫描整个 DOM（文本节点 + `title` / `aria-label` / `placeholder` / `alt`，含隐藏的弹层）里的中文：

| 视图 | 结果 |
|---|---|
| 设置：通用 / 通知 / 模型服务 / 角色 / 技能 / MCP / 外观 / 快捷键 | 8 页都 0 处 |
| 模型服务编辑弹窗 + 拉取模型列表（假端点返回 404 的报错）、MCP 添加弹窗、快捷键录键中 | 0 处 |
| 聊天：主 agent 会话、展开全部 8 张工具卡片、worker 会话（write / report_done） | 0 处 |
| 编排面板：任务、任务详情抽屉、改动（无 git）；git 工作区与它的改动页 | 0 处 |
| 新建会话弹层、模型选择器、审批档位、主题菜单、会话搜索 | 0 处 |

共 24 次扫描，0 处中文（唯一例外是语言下拉里的「简体中文」选项，见上）。同一轮里还确认：启动时跟随系统是中文（`<html lang="zh-CN">`）；下拉三项是「跟随系统 / 简体中文 / English」；切换后不重启立即生效、`settings.json` 写入 `language: "en"`；英文下 Main 的 IPC 错误是 “Workspace not found”、原生目录框标题与按钮是 “Add folder” / “Add”；再切回简体中文同样立即生效，Main 的错误回到「工作区不存在」；console 0 条 error / warning。第二轮扫描抓到过一处（「Endpoint not found; check the Base URL（HTTP 404）」），即 `4e9df28` 修掉的拼接全角括号，最终一轮全过。

**提交前扫描**：136 个改动文件 `git ls-files --eol` 全是 `i/lf w/lf`；没有 BOM / 零宽 / NBSP / 全角空格等不可见字符（`skillManifest.ts` 里去 BOM 的正则是原有的）。

用户全局说明里的知识库检索（`maestro spec` / `maestro wiki`）本机不可用：没有 `maestro` 命令，`~/.maestro` 也不存在，与前几张卡相同。

## 未做 / 注意事项

1. **已显示的文字不回头翻译**：store 与 Main 产生的提示按产生时的语言；切换后，屏幕上已有的那一条（会话顶部的错误条、导入弹窗里已列出的告警）要等下一次产生才换语言。界面文案本身全部立即换。
2. **验收人 / 用户写的冒烟脚本依赖中文 aria-label**（如 `button[aria-label="设置"]`）：默认跟随系统、本机是中文，照旧能用；把语言设成 English 后要改用英文的 label。
3. **任务书标题等用户数据、角色名（Orchestrator / Worker）、服务商与模型名不翻译**。内置角色的描述按语言（中文界面下由英文变成中文，是有意的）。
4. **字典维护**：新增界面文案要同时加进 `src/renderer/i18n/zh-CN.ts` 与 `en.ts`（类型检查与字典测试都会拦）；Main 的文案加进 `src/shared/i18n/main/`。导入告警的英文措辞改动时注意 `warningLine` 认的「; skipped / ignored / using / fill it in / set the API key / fynvra won't / only the first page」。
5. **没有改 `docs/ARCHITECTURE.md`**：它列的 `chat.ts` 契约（§9.2）不含被移走的显示常量，`Preferences` 字段也不在其中；需要把 i18n 约定写进架构文档的话可以另开卡。
6. **建议在本机看一眼**：设置 → 通用 → 语言切到 English 再切回；英文下的输入框悬停、审批胶囊、模型选择器、编排面板的任务抽屉、模型服务导入弹窗的告警（≤ 2 条逐行、≥ 3 条折叠成 “N warnings”）。
