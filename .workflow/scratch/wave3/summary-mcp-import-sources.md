# Summary · Task 18 mcp-import-sources（MCP 页「从本机导入」：8 个来源）

分支 `LAIJiangFeng/mcp-import`。worktree 建在 `f5c2e91`（Initial commit）上。开工前做了这些准备：

- `git merge --ff-only main` 快进到 `main@b9dffb7`；
- 在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`，没有产生改动；
- `pnpm install --frozen-lockfile`；
- 真机冒烟前 `node node_modules/electron/install.js`，从本机缓存解压 Electron，没有联网。

`main` 没动。相对 `b9dffb7` 共 14 个改动提交，涉及 38 个文件（+3862 / −239），另有本总结的 `docs(wave3)` 提交。
每个提交都带 `Co-Authored-By: Claude Opus 5.5`，未 push、未建 PR。

**没有 BLOCKED 项，没有越界改动。** 38 个文件逐个对过任务书「范围」，见文末「范围核对」。
有几处按本机实际数据做了取舍，和任务书字面不完全一样，集中写在「与任务书有出入的地方」。

## 做了什么

| 提交 | 内容 |
|---|---|
| `f595970` feat(shared) | `llm.ts` 加 `McpImportSource`（8 个来源）、`McpImportCandidate`（脱敏视图，多一个 `duplicateOf` 说明与谁重复） |
| `505a55d` feat(main) | `import/jsonc.ts`：容错 JSONC 解析（注释、尾逗号），出错只给行号 |
| `cb71cfd` feat(main) | `import/readers/`：8 个读取器（纯函数）与 `common.ts`；`import/fixtures.ts` 按本机实际格式写的假数据 |
| `0bf0449` feat(main) | `mcpRegistry`：规整后的去重键；`addMany` 按条返回结果（跳过时说明与谁相同），名称被占用时加「 (2)」 |
| `f860748` feat(main) | `import/locate.ts`：每个来源的候选路径列表（Windows / macOS / Linux），CC Switch 库只读副本 |
| `e690e64` refactor(main) | `claudeImport.ts` 只剩旧通道的适配层，解析并入 `readers/claudeCode.ts` |
| `fc69ee2` feat(main) | `import/scan.ts`：编排、校验、两种去重、逐字段构造视图、变量引用提醒 |
| `a0c5b04` feat(shared) | `IPC_CHANNELS` 的 `// --- mcp ---` 段内加 `mcp:scan-imports`、`mcp:import` |
| `7b84a60` feat(preload) | `McpApi.scanImports` / `importCandidates` 及入参、返回类型；旧的逐文件状态类型改名 `McpImportFileStatus` |
| `6a53087` feat(main) | `import/mcpImporter.ts`：入参收窄、10 分钟扫描缓存、按 id 导入 |
| `0059088` feat(main) | `ipc/mcp.ts` 注册两个通道；导入成功广播 `mcp:changed` |
| `b3ba49d` feat(renderer) | `stores/mcp.ts` 加 `scanImports`、`importCandidates`（导入成功后重读列表） |
| `a224d78` feat(renderer) | `mcpImport.ts`：选择规则与提示文案（node 下测试） |
| `be6b1a4` feat(renderer) | `McpImportDialog.tsx`；MCP 页「从 Claude Code 导入」改为「从本机导入…」；store 去掉没人用的 `importClaude` |

### 1. 扫描三层（`src/main/services/mcp/import/`）

结构与 provider-import 相同：

- **定位**（`locate.ts`）：每个来源一个候选路径列表，存在的都读，不存在的跳过（没装不算问题，不出 warning）：
  - Claude Code：`~/.claude.json`、`~/.claude/settings.json`；
  - Codex：`~/.codex/config.toml`；Grok CLI：`~/.grok/config.toml`；Gemini CLI：`~/.gemini/settings.json`；Cursor：`~/.cursor/mcp.json`；
  - VS Code：`Code/User/mcp.json` 与 `Code - Insiders/User/mcp.json`，目录 Windows 在 `%APPDATA%`、macOS 在 `~/Library/Application Support`、其它平台在 `$XDG_CONFIG_HOME`（缺省 `~/.config`）；
  - OpenCode：`~/.config/opencode/opencode.json` 与 `.jsonc`（跟随 `XDG_CONFIG_HOME`，与 OpenCode 一致）；
  - CC Switch：`~/.cc-switch/cc-switch.db`。
  - 文本读取复用 provider-import 的 `readTextIfExists`（去 BOM）。CC Switch 与 provider-import 同一读法：库（有 `-wal` 就一起）复制到 `mkdtemp` 临时目录，
    `node:sqlite` 的 `DatabaseSync(copy, { readOnly: true })` 打开，`SELECT * FROM mcp_servers`，读完关库、删副本；没有 `mcp_servers` 表时抛错（成为一条 warning）。
- **读取**（`readers/`）：输入文件文本或数据库行，输出 `{ servers, warnings }`。坏文件返回空并记 warning，**warning 只写文件与行号、名称与键名，不带原文**：
  - JSON / JSONC 统一走 `parseJsonc`：注释与尾逗号换成空格（保留换行，行号与原文一致），V8 的结构化错误只取行号，「Unexpected token …, "<片段>"」这类带原文的不解析；
  - TOML 复用 provider-import 的 `parseTomlObject`（只给行号）；
  - 缺命令或 URL 的条目跳过并说明（「<来源> · <名称>：没有命令或 URL，已跳过」）。
- **编排**（`scan.ts`）：`scanMcpImports(sources?, options?)`，所选来源并行读：
  - 单个来源抛错只变成「<来源>：读取失败（…）」；一个来源里某个文件读不了（如 `.claude.json` 是目录）只记「<来源>：读取 <文件> 失败（…）」，同来源的其它文件照读；
  - 每个候选按 `mcp:upsert` 的规则（`parseMcpUpsert`）校验，不合规的跳过并记 warning（如 `ws://` 地址、键含空白），所以**列出来的都能导入**；名称超过 80 字截断；
  - 视图逐字段构造：`envKeys` / `headerKeys` 只有键名；含明文的已校验服务器留在 Main，供导入用；
  - 值里引用了变量（`${VAR}`、VS Code 的 `${input:…}`、OpenCode 的 `{env:…}` / `{file:…}`）时提醒「fynvra 不会展开，导入后请在编辑里改成实际值」，只写键名不写值。

### 2. 各来源的读法（照本机实际格式，fixture 也照它写）

- **Claude Code**：顶层 `mcpServers`（标签「Claude Code」）+ `projects.<路径>.mcpServers`（标签「Claude Code · <项目目录名>」）+ settings.json 的 `mcpServers`。
  `type` 归一化（`sse` / `http` / `streamable-http`，没写时有 url 算 http），Windows 的 `cmd /c npx …` 原样保留。Claude Code 没有逐个停用的开关（本机项目条目里也没有），一律算启用。
- **Codex / Grok CLI**（同一读取器）：`[mcp_servers.<name>]` 的 `command`、`args`、`env` 子表、`url`、`http_headers` 子表、`enabled`；
  `env_vars`（也接受 `{ name, source }`）、`env_http_headers`、`bearer_token_env_var` 按导入时的环境变量取值写进 env / headers（已写的不覆盖），取不到的记 warning；
  `startup_timeout_sec`、`tool_timeout_sec`、`cwd` 等 fynvra 没有对应字段，忽略。Codex 没有 SSE，没写 type 都按 Streamable HTTP。
- **Gemini CLI**：按 Gemini 的优先级 `httpUrl`（Streamable HTTP）→ `url`（SSE；写了 `type: "http"` 时按 Streamable HTTP）→ `command`；
  `mcp.excluded` 里的、设了 `mcp.allowed` 而不在其中的标为未启用（旧版设置 `excludeMCPServers` / `allowMCPServers` 也认）；`timeout`、`trust` 忽略。
- **Cursor**：`mcpServers`，Claude 格式；`disabled: true` 标为未启用。本机是 `{}`，fixture 自造。
- **VS Code**：JSONC，`servers.<name>`（`type: stdio | http | sse`），`inputs` 不读；Insiders 的文件标签是「VS Code Insiders」。
- **OpenCode**：`mcp.<name>`，`local` 的 `command` 数组第一个元素是命令、其余是参数，`environment` → env；`remote` 的 `url` / `headers` 按 Streamable HTTP；`enabled`。
- **CC Switch**：`mcp_servers` 行的 `server_config`（Claude 格式 JSON）；标签列出已启用它的应用（「CC Switch · Claude、Codex」，认不出的 `enabled_*` 列按列名显示），
  一个都没启用的标为未启用；单行 `server_config` 坏了只跳过那一行。

### 3. 去重（`mcpDedupeKey`，扫描与导入共用）

- 远程看 URL（去首尾空白与末尾 `/`，同原规则）；
- stdio 看规整后的命令与**逐项**参数：小写、`\` 换成 `/`，去掉 Windows 的 `cmd [/d /s] /c` 外壳、命令的 `.cmd` / `.exe` 后缀、npx 在包名之前的 `-y` / `--yes`；
- 与已登记的服务器相同标 `duplicate: 'existing'`（`duplicateOf` 是它的名称），与排在前面的候选相同标 `'candidate'`（`duplicateOf` 是「<来源> · <名称>」），
  existing 优先；来源顺序就是优先级：Claude Code → Codex → Grok → Gemini → Cursor → VS Code → OpenCode → CC Switch。
- 规整的依据是本机数据：Claude Code 的 context7 是 `cmd /c npx -y @upstash/context7-mcp …`，CC Switch 存的是 `npx -y …`；Grok 的 shadcn 比 Codex 的多一个 `-y`；
  不规整的话这几组会各导一份，名称再加后缀。

### 4. 缓存与导入（`mcpImporter.ts`、`mcpRegistry.addMany`）

- `scan(raw)`：收窄 `undefined | {} | { sources: 非空、合法来源数组 }`（去重、长度上限），其它一律「无效的扫描参数」；用当前注册表标重复；
  结果（含明文）缓存在 Main 内存，**只留最近一次，10 分钟过期**；扫描排队执行，缓存总是最后发起的那次。
- `import(raw)`：收窄 `{ candidateIds: 1–500 个扫描时发的 UUID }`；过期 →「扫描结果已过期，请重新扫描」；id 不属于最近一次扫描 →「候选不在最近一次扫描结果里，请重新扫描」（不静默跳过）；
  经 `addMany` 一次写盘，**默认启用**（来源里未启用的导入后也是启用的）。
- `addMany`：在同一个读改写里**再查一次重复**（与已有的或同批前面的相同就不写，说明「与「X」的命令和参数相同」/「…的 URL 相同」），所以重复点导入不会建两份；
  名称被占用（不分大小写）加「 (2)」「 (3)」…且不超过 80 字，id 按加了后缀的名称生成；一条都没新增时不写盘。
- 返回 `{ imported: McpServerEntryView[], skipped: { id, name, reason }[] }`；两个方法都不抛异常，读写出错折成 `{ ok: false }`。

### 5. IPC / preload；旧通道的选择

- 通道：`mcp:scan-imports { sources? } → { candidates, warnings }`、`mcp:import { candidateIds } → { imported, skipped }`，
  三处同步（`ipc.ts` 常量、`ipc/mcp.ts` handler、`preload/domains/mcp.ts`），入参都按 `unknown` 收窄；Renderer 只拿到脱敏候选、只回传候选 id。
- **`mcp:import-claude` 保留，不改为转调 importer**（任务书要求说明选择）：
  - 它的返回带逐文件状态（`sources: { file, status, count }[]`），扫描没有这个信息；
  - 经 importer 转调会替换掉弹窗正在用的扫描缓存，弹窗里的候选 id 随之失效；
  - 钉住 `importClaude()` 的 `settingsDomains.test.ts`、`ipc/mcp.test.ts` 不在范围里，保留通道就不用改它们（两者都原样通过）；
  - 实现已改为复用 Claude Code 读取器与新的去重键，界面不再调用它。

### 6. 界面

- MCP 页标题栏的「从 Claude Code 导入」改为「从本机导入…」，空态卡片的按钮改为「从本机导入」，说明文字列出 8 个来源；直接打开弹窗（不做下拉）。
- 弹窗（交互与组件风格照 `ProviderImportDialog`）：
  - 8 个来源复选框（悬停显示读的是哪个文件）+「重新扫描」；**切换来源会重新扫描**，重复关系按所选来源重算；
  - 候选行：名称、来源徽标（悬停是完整标签，如项目名、CC Switch 的应用）、传输方式、「来源中已启用」、命令 / URL 摘要、env / header 键名徽标；
    重复项置灰、不可勾选，写明与谁重复、比的是命令和参数还是 URL；整行可点；
  - 默认勾选「来源中已启用且不重复」的；全选 / 反选只作用于不重复的；「正在扫描本机配置…」「没有找到可导入的 MCP 服务器」「至少选择一个来源」三种状态文案；warning 列在下方；
  - 「导入所选（N）」→ 关弹窗，页面提示「已导入 N 个 MCP 服务器」，有跳过的列出名称和原因；列表经 store 重读刷新。

## 怎么验证

**基线**（`main@b9dffb7`）：typecheck exit 0；lint `Checked 323 files`；test `Test Files 102 passed / Tests 1424 passed`。

**验收命令**（最终提交 `be6b1a4`，根目录）：

```
pnpm typecheck   → exit 0（typecheck:node / typecheck:web / typecheck:packages）
pnpm lint        → exit 0：Checked 350 files in 226ms. No fixes applied.（0 warning）
pnpm test        → exit 0：Test Files 114 passed (114)；Tests 1484 passed (1484)
pnpm build       → exit 0：out/main/index.js 300.34 kB、out/preload/index.cjs 11.89 kB、out/renderer/index.html + assets
```

- 产物里 `node:sqlite` 仍是动态 `import("node:sqlite")`（provider-import 与本卡各一处），`smol-toml` 外置。
- `pnpm test` 的输出里没有 SQLite 的 ExperimentalWarning：测试经 provider-import 的 `fixtures.loadSqlite()` 先加载并只静默这一条。

**新增 12 个测试文件、60 个用例**（1424 + 60 = 1484）。测试都先于实现写好，但不是每个都单独跑过红：

- `jsonc`、`mcpRegistry`、`locate`、`scan`、界面纯逻辑：先跑出红（`Cannot find module` 或新用例断言失败），再实现；
- 读取器、`mcpImporter`：测试写好后和实现一起写完才第一次运行。读取器那次有 2 个断言失败（没有行号时 warning 少一个空格），修正后通过；
- `claudeImport` 的测试随适配层一起改写。

- `jsonc` 5：注释与尾逗号（含字符串里的 `//`、转义引号）、与 JSON.parse 一致、行号与原文一致且不带原文、空文件、全 0 字节文件、未闭合注释 / 字符串。
- 读取器 26：Claude Code 4、Codex + Grok 6、Gemini 4、Cursor 3、VS Code 3、OpenCode 3、CC Switch 3。覆盖本机格式、JSONC 注释、TOML 子表、
  `env_vars` / `env_http_headers` / `bearer_token_env_var`、OpenCode command 数组、Gemini 的 excluded / allowed（含旧键）、CC Switch 应用标签与 BOOLEAN 列各种写法、
  坏 JSON / 坏 TOML（断言行号且 warning 不含原文）、缺字段条目。
- `locate` 6：三种平台的候选路径；**CC Switch 副本只读**（读完临时目录为空、源库逐字节不变、源库旁没有多出文件）；库开着且新行还在 `-wal` 里也能读到、之后还能继续写；
  没有 `mcp_servers` 表 / 不是 SQLite 文件时抛错且副本照删。
- `scan` 8：8 个来源全在时的顺序与两种去重（含 `cmd /c`、`npx -y` 的规整）；视图逐字段（fixture 的 10 个假密钥都不在视图里）；existing 优先于 candidate；
  只扫部分来源时重复关系重算；单个来源 / 单个文件读失败不影响其它；一个都没装；不合规候选跳过与名称截断；变量引用提醒。
- `mcpImporter` 8：**扫描与导入的返回都不含 env / header 值、值只在 mcp.json**；名称加后缀、来源里未启用的导入后也启用、`cmd /c` 原样写入；导入时再查重（含重复点导入）；
  **缓存 10 分钟过期**；id 属于旧扫描时报错；**入参收窄**（10 种坏的扫描参数、10 种坏的导入参数）；扫描排队；注册表出错折成 `{ ok: false }`。
- `mcpRegistry` +2（9 → 11）：规整去重键；`addMany` 的逐条结果、说明与谁相同、名称后缀、全重复不写盘。
- `claudeImport` 5 → 3：解析类用例移到 `readers/claudeCode.test.ts`，这里只留逐文件状态（含错误信息不带文件内容）。
- 界面纯逻辑 7：默认勾选、全选 / 反选、提交顺序、来源顺序、重复说明、命令摘要、导入提示。

**真机（`pnpm dev` 扫本机 8 个来源）**：临时 `FYNVRA_USER_DATA_DIR`，`electron-vite dev --remoteDebuggingPort 9431 -- <不节流开关>` 起 app，
驱动脚本在仓库外（`%TEMP%\fynvra-probe-18\smoke.mjs`），经 CDP 调 `window.fynvra.mcp.*` 并点真实界面。

扫到 **24 个候选、2 条 warning**（只写名称与来源，env / header 的值、URL、参数都不写）：

| 来源 | 候选 | 名称（重复的标出与谁相同） |
|---|---|---|
| Claude Code | 4 | pencil、chrome-devtools、context7、wechat-backup（3 个 env 键） |
| Codex | 9 | stitch（http，1 个 header 键）、tavily（http）、playwright、github、memory、node_repl（16 个 env 键）、shadcn、figma（http）、pencil（= Claude Code · pencil） |
| Grok CLI | 1 | shadcn（= Codex · shadcn，多一个 `-y`） |
| Gemini CLI | 1 | pencil（= Claude Code · pencil） |
| Cursor | 0 | 本机 `mcp.json` 是 `{}` |
| VS Code | 0 | 本机 `mcp.json` 是 315 个 0 字节，warning「不是有效的 JSON，已跳过」 |
| OpenCode | 1 | pencil（command 数组，= Claude Code · pencil） |
| CC Switch | 8 | chrome-devtools（= Claude Code）、context7（`npx …`，= Claude Code 的 `cmd /c npx …`）、node_repl（运行时目录与 Codex 的不同，不重复）、memory / playwright / shadcn / github（= Codex）、pencil（对 Claude、Codex、Gemini、OpenCode 都启用，= Claude Code） |

另一条 warning：「Codex · node_repl：环境变量 CODEX_WINDOWS_REGISTERED_CORE 没有设置，导入后需要在编辑里补上」（它在 Codex 的 `env_vars` 里，fynvra 的环境没有它）。
不重复的 13 个，全部在来源中已启用，即默认勾选的 13 个。

界面与安全检查（最终一轮全新 userData，**36/36 通过**，另补测 1 项）：

- 冒烟脚本把本机 8 个来源里 22 个 env / header 值（≥ 8 字符）读进内存（不打印）做泄漏断言：`scanImports` 的候选、弹窗的候选行、导入后的设置页 DOM、`mcp.list` 返回里都没有任何一个；
  临时 userData 的 mcp.json 里 22 个都有（只在 Main 落盘）；
- 空态有「从本机导入」，标题栏是「从本机导入…」，「从 Claude Code 导入」已不在页面上；
- 弹窗 24 行、8 个来源开关，默认勾选 13 行、置灰 11 行，每个置灰行都写了原因，每行都有来源与传输方式徽标，已启用的都有「来源中已启用」，wechat-backup 显示 3 个 env 键名徽标；
- 关掉 Claude Code 来源 → 重扫后 20 行、没有 Claude Code 的行，Codex 的 pencil 不再置灰；再打开恢复 24 行；
- 全选只选不重复的 13 行；反选清零；「重新扫描」恢复默认勾选；
- 「导入所选（13）」→ 弹窗关闭，页面提示「已导入 13 个 MCP 服务器」，列表 13 行且都启用；Codex 与 CC Switch 的两个 node_repl 名称冲突，后一个成为「node_repl (2)」；
- 再打开时 24 行全部标「已有…」且没有默认勾选；非法 `sources` 返回「无效的扫描参数」，非法 `candidateIds` 返回「无效的导入参数」；
- 控制台没有 error / warning / 异常；
- 补测：删掉导入的 pencil 后再打开，Claude Code 的 pencil 恢复可选（其它 4 个 pencil 仍标为与它重复，「导入所选（1）」）；点整行一次只切换一次；
- 补测：弹窗开着时从页面再调一次 `scanImports()`，弹窗不受影响；这时点「导入所选」提示「候选不在最近一次扫描结果里，请重新扫描」，什么都没写。
- 跑完核对：本机 7 个配置文件与 `~/.cc-switch/cc-switch.db` 的修改时间和大小与开工时一致（`.claude.json` 由运行中的 Claude Code 自己改写，不比对），
  `cc-switch.db` 旁没有多出 journal / wal 文件，`%TEMP%` 里没有遗留的库副本；所有临时 userData（里面有导入的明文）都已删除。

冒烟前两轮的失败都是脚本自己的问题，改正后用全新 userData 整轮重跑：

1. 设置视图本身是 `role="dialog"`，`document.querySelector('[role=dialog]')` 取到的是它而不是导入弹窗；`[role=dialog] ul li` 把下方 warning 的 `li` 也算成了候选行。改为按标题定位弹窗、只数带复选框的行。
2. 「泄漏」误报：Codex node_repl 的 env `NODE_REPL_UNTRUSTED_ENV_ALLOWLIST` 的值本身就是一个变量名（`CODEX_WINDOWS_REGISTERED_CORE`），warning 里提到缺失的变量名是预期的。
   单独核对过：它只出现在 warning 区，候选行与 IPC 候选里都没有。断言改为对 warning 区排除「值是变量名」的情况，候选部分仍是严格比对。

## 与任务书有出入的地方

1. **去重键的「规整」比「小写」多几条**（`cmd /c` 外壳、`.cmd` / `.exe`、npx 的 `-y`、`\` 与 `/`），依据见上文第 3 节的本机数据。参数仍逐项比较（`['a b']` 与 `['a', 'b']` 不同，原有用例保留）。
2. **视图多一个字段 `duplicateOf`**：与 provider-import 相同，只有 `duplicate` 说不出与谁重复。
3. **默认勾选「来源中已启用且不重复」**：任务书没写默认勾选规则，与 provider-import 的「正在使用且不重复」同一思路。
4. **Codex 的 `env_vars` / `env_http_headers` / `bearer_token_env_var`**：fynvra 的 MCP 配置没有「从环境透传」，导入时按 Main 当时的环境变量取值写进 env / headers，取不到的记 warning。
   任务书只把 `env_vars` 列为字段，没写怎么映射。
5. **候选路径比任务书表格多几个**：VS Code Insiders、OpenCode 的 `.jsonc`，以及 macOS / Linux 的 VS Code 位置；`XDG_CONFIG_HOME` 设了时 OpenCode 跟随它。
6. **额外的 warning**：同一来源里单个文件读失败、条目缺命令或 URL、值里引用了变量。都只写名称与键名。
7. **CC Switch 的标签带上已启用它的应用**，Claude Code 项目级服务器的标签带上项目目录名，方便区分同名服务器。
8. **store 去掉了 `importClaude`**：界面不再调用；preload 方法与通道保留。

## 未做 / 注意

- **没改** `src/main/ipc/mcp.test.ts`、`src/preload/domains/settingsDomains.test.ts`（都不在范围里，原样通过）：两个新 handler 只是转调 importer（逻辑全在 `mcpImporter.test.ts`）+ 广播；
  preload 两个新方法的通道映射只有真机冒烟覆盖，没有单测。需要的话可以在 `settingsDomains.test.ts` 的映射用例里补两行。
- **ARCHITECTURE.md 没回写**（不在范围）：§9.6 说 `llm.ts` 的内容是规范性的，本卡按任务书在其中加了 `McpImportSource`、`McpImportCandidate`；§7 / §9 也还没有这两个通道。验收时可以与 provider-import 的一起回写。
- **不读**：项目目录里的 `.mcp.json`、Cursor 的项目级 `.cursor/mcp.json`、VS Code `settings.json` 里的旧式 `mcp.servers`、`CODEX_HOME` 自定义目录、CC Switch 的自定义数据目录（与 provider-import 一致）。
- **不导入的字段**：超时（`startup_timeout_sec`、`tool_timeout_sec`、Gemini 的 `timeout`）、`cwd`、工具白名单 / 黑名单、`trust`、VS Code 的 `envFile`：`McpServerEntry` 没有对应字段。
- **重复代码**：`readCcSwitchMcpRows` 与 provider-import 的 `readCcSwitchRows` 只差表名，`mcpImport.ts` 的选择函数与 `providerImport.ts` 的同构；provider 侧文件不在范围里，没有合并。
- **旧通道的行为变化**：`mcp:import-claude` 现在也用规整后的去重键，名称冲突时也加「 (2)」（之前只给 id 加后缀、名称保持不变）。
- 界面组件没有 DOM 层面的自动化测试（仓库没有 DOM 测试环境），由纯逻辑测试 + 真机 CDP 冒烟覆盖。
- 用户全局说明里的知识库检索（`maestro spec` / `maestro wiki`）没做：本机 PATH 上没有 `maestro`，`~/.maestro/workflows/coding-philosophy.md` 也不存在（本次核对过）。

## 给验收人的注意事项

1. **参数与 URL 里的密钥会显示在界面上**（§9.6 契约的既有边界，Task 07 总结第 4 条提过，本卡没有改契约）：
   - 本机 Claude Code 与 CC Switch 的 context7 把 key 写在命令参数里（`--api-key <key>`），Codex 的 tavily 把 key 写在 URL 的 query 里；
   - 候选视图与 `McpServerEntryView` 都带 `args` / `url`，弹窗的命令摘要、导入后的 MCP 列表会原样显示它们；
   - env / header 的值始终只在 Main。要遮住参数和 query 里的值，需要先改契约，建议另开一张卡（例如界面上对 `--api-key` / `--token` 之后的参数和 query 值打码，或导入时提示改成 env）。
2. **本机 VS Code 的 `%APPDATA%\Code\User\mcp.json` 是 315 个 0 字节**（文件已损坏，不是本卡造成的；内容一直是这样，修改时间 2026-07-06）。读取器按坏文件跳过并给出 warning。
3. **node_repl 是 Codex 自带的 Computer Use 运行时**（命令在 `%LOCALAPPDATA%\OpenAI\Codex\runtimes\…` 下，带 16 个 env 键和一个要透传的变量），它在 Codex 里是启用的，所以默认被勾选；
   在 fynvra 里多半用不上，用户可以取消勾选。Codex 与 CC Switch 里各有一份（运行时目录的哈希不同），不算重复。
4. **第一轮冒烟里出现过一次「导入弹窗自己关了」，没能复现**：
   - 当时脚本崩溃后再连上页面，发现导入弹窗已关闭，设置视图仍停在 MCP 页，控制台没有错误；
   - 之后用同样的步骤复现了三次，都没再出现：清空 Vite 依赖缓存后首次启动并保持弹窗 60 秒、切换来源、弹窗开着时从外部再调扫描；
   - 最终一轮在页面里装了观察器，弹窗被移除就记录，从打开到导入全程记录为空；
   - 那次是这个 worktree 第一次 `pnpm dev`，`dev.log` 里有 Vite 依赖预构建的记录，`node_modules/.vite/deps` 目录的修改时间比预构建晚 18 秒。
     推测是开发态的模块热替换让 `McpSettings` 重新挂载、丢了弹窗状态，但没有证实；
   - 打包后的应用没有 Vite 运行时。
5. **冒烟环境的小坑**：
   - 从 PowerShell 跑 `pnpm exec electron-vite dev … -- <开关>` 时，`--` 会被 `pnpm.ps1` 吞掉，electron-vite 报 `Unknown option --disableBackgroundingOccludedWindows`，要写成 `'--'`；
   - 另一个 worktree 占着 5173 时 electron-vite 换到 5174；
   - 本机窗口处于 `visibilityState: hidden`（不节流开关已传进 Electron，窗口多半是最小化了），用 `element.click()` 驱动不受影响。
6. Biome 的 `noTemplateCurlyInString` 会对测试里的字面 `'${HOME}'` 报 warning；测试里用 `` `${'$'}{…}` `` 拼出来，lint 保持 0 warning。

## 范围核对（38 个文件）

- `src/main/services/mcp/import/**`（新建）：`jsonc.ts`、`locate.ts`、`scan.ts`、`mcpImporter.ts`、`fixtures.ts`、`readers/{common,claudeCode,codex,gemini,cursor,vscode,opencode,ccSwitch}.ts` 及 11 个测试；
- `src/main/services/mcp/*.ts`（接入）：`claudeImport.ts`、`claudeImport.test.ts`、`mcpRegistry.ts`、`mcpRegistry.test.ts`、`parseMcpInput.ts`（只把 `MAX_NAME_LENGTH` 导出）；
- `src/main/ipc/mcp.ts`；`src/shared/types/ipc.ts`（`// --- mcp ---` 段内）；`src/shared/types/llm.ts`；
- `src/preload/domains/mcp.ts`；
- `src/renderer/components/settings/`：`McpSettings.tsx`、`McpImportDialog.tsx`、`mcpImport.ts`、`mcpImport.test.ts`；
- `src/renderer/stores/mcp.ts`。
- 没有动 providers / sessions / chat 相关文件；provider-import 的 `readTextIfExists`、`parseTomlObject`、测试用 `loadSqlite` 只是引用，没有修改。
