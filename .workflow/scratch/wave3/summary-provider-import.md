# Summary · Task 15 provider-import（模型服务页「从本机导入」：Claude Code / Codex / CC Switch）

分支 `LAIJiangFeng/provider-import`。worktree 建在 `f5c2e91`（Initial commit）上。开工前做了这些准备：

- `git merge --ff-only main` 快进到 `main@7dead65`；
- 在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`，没有产生改动；
- `pnpm install --frozen-lockfile`；
- `node node_modules/electron/install.js`，从本机缓存解压 Electron，没有联网。

`main` 没动。相对 `7dead65` 共 13 个改动提交，涉及 30 个文件（+2970 / −42），另有本总结的 `docs(wave3)` 提交。
每个提交都带 `Co-Authored-By: Claude Opus 5.5`，未 push、未建 PR。

**没有 BLOCKED 项，没有越界改动。** 30 个文件逐个对过任务书「范围」，见文末「范围核对」。有几处按本机实际情况做了取舍，
和任务书字面不完全一样，集中写在「与任务书有出入的地方」。

## 做了什么

| 提交 | 内容 |
|---|---|
| `815e3cc` build(main) | `dependencies` 加 `smol-toml@^1.9.1`；lockfile 只多了它一个包 |
| `ddf387b` feat(shared) | `llm.ts` 加 `ProviderImportSource`、`ProviderImportCandidate`（脱敏视图，多一个 `duplicateOf` 说明与谁重复） |
| `af7aed9` feat(main) | `import/readers/`：Claude Code / Codex / CC Switch 三个读取器（纯函数）与 `common.ts`；`import/fixtures.ts` 按本机实际格式写的假数据 |
| `dcea5e9` feat(main) | `providerStore`：`addMany` 一次写入一批、导入时再查重、名称加后缀；导出 `providerFingerprint`、`apiKeyHint` |
| `e2f8ed0` feat(main) | `import/locate.ts`（定位 + 读原始内容，含 sqlite 副本只读）、`import/scan.ts`（编排、校验、去重） |
| `968295a` feat(shared) | `IPC_CHANNELS` 的 `// --- providers ---` 段内加 `providers:scan-imports`、`providers:import` |
| `dfe370a` feat(preload) | `ProvidersApi.scanImports` / `importCandidates` 及入参、返回类型 |
| `5103290` feat(main) | `import/providerImporter.ts`：入参收窄、10 分钟扫描缓存、导入 |
| `16d3f92` feat(main) | `ipc/providers.ts` 注册两个通道；导入成功广播 `providers:changed` |
| `1f13f59` feat(renderer) | `ui/checkbox.tsx`（Base UI Checkbox，shadcn 风格，与 switch 同写法） |
| `b59c77c` feat(renderer) | `stores/providers.ts` 加 `scanImports`、`importCandidates`（导入成功后重读列表） |
| `dc785dc` feat(renderer) | 导入弹窗、入口按钮；选择规则与提示文案在 `providerImport.ts`（node 下测试） |
| `bea59f7` refactor(main) | 去 BOM 改用 `charCodeAt(0) === 0xfeff`，源码里不再含不可见字符 |

### 1. 扫描三层（`src/main/services/providers/import/`）

与 `skills:scan`、EnsoCode `providerScan` 同一结构，但读取器做成了纯函数：

- **定位**（`locate.ts`）：`~/.claude/settings.json`、`~/.codex/config.toml` + `auth.json`、`~/.cc-switch/cc-switch.db`。只做 IO：
  - 文件不存在返回 `null`（没装这个工具不算问题，不出 warning）；其它读错误照常抛给 scan；
  - 文本去掉 UTF-8 BOM（Windows 编辑器可能加，`JSON.parse` 不认）；
  - **CC Switch 库**：先把 `cc-switch.db`（有 `-wal` 就一起）复制到 `mkdtemp` 临时目录，再用 `node:sqlite` 的
    `DatabaseSync(copy, { readOnly: true })` 打开，`SELECT * FROM providers`；读完关库、`rm` 删除副本（删不掉只告警）。
    不复制 `-shm`（WAL 索引，SQLite 会在副本旁重建）。`node:sqlite` 用动态 `import()` 按需加载。
- **读取**（`readers/`）：输入文件文本或数据库行，输出 `{ providers, warnings }`。坏文件返回空并记 warning；
  **warning 只写文件和行号，不带原文**（JSON 不转述 V8 的错误信息；smol-toml 的 `TomlError.message` 带出错位置前后几行，只取 `line`）。
- **编排**（`scan.ts`）：`scanProviderImports(sources?, options?)`，所选来源并行读，单个来源抛错只变成
  `「<来源>：读取失败（…）」` 一条 warning。之后：
  - 每个候选先按 `providers:upsert` 的规则（`parseProviderUpsert`）校验，不合规的跳过并记 warning，所以**列出来的都能导入**；名称超过 80 字截断；
  - 按**实际请求地址 + key** 去重（`providerFingerprint` = `resolveBaseUrl(api, baseUrl)` + key，末尾 `/`、留空与官方地址算同一个，与运行时 provider 键同一口径）：
    与已有服务相同标 `duplicate: 'existing'`，与排在前面的候选相同标 `duplicate: 'candidate'` 并保留第一个；顺序是 Claude Code → Codex → CC Switch；
  - 视图逐字段构造（不是展开后删 key），`hasApiKey` + 末 4 位；带 key 的已校验入参只留在 Main。

### 2. 各来源的读法（照本机实际格式，fixture 也照它写）

- **Claude Code**：`env.ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`（没有再取 `ANTHROPIC_API_KEY`）→ `anthropic-messages`。
  - 模型：`model` 是别名（`fable`、`opus[1m]` 等）时忽略，是具体 id 时保留（去掉 `[1m]` 后缀）；再加 `env.ANTHROPIC_MODEL` 与 `ANTHROPIC_DEFAULT_*_MODEL`；
    本机还有 `ANTHROPIC_DEFAULT_FABLE_MODEL_NAME`，用作模型显示名。内置目录里有的模型带上上下文窗口等元数据。
  - 没有 key 也没有自定义地址（官方账号登录）→ 没有候选；只有地址没有 key → 候选 `hasApiKey: false`。
- **Codex**：`[model_providers.<key>]` 的 `name`、`base_url`、`wire_api`（`responses` → `openai-responses`，`chat` → `openai-completions`，没写按 Codex 默认 chat）。
  - key 与 Codex 本身的取法一致：有 `env_key` 取那个环境变量（没设置时提示变量名）；否则只有 `requires_openai_auth = true` 才用 `auth.json` 的 `OPENAI_API_KEY`；
  - 顶层 `model` 只属于 `model_provider` 选中的服务，它命名为「Codex」、排最前；其它服务叫「Codex · <name>」；
  - `model_provider` 缺省或为 `openai` 且 `auth.json` 有 key → 官方 OpenAI（ChatGPT 登录没有 key，不算）；
  - config.toml 坏了整个来源跳过；auth.json 坏了只是没有它的 key。
- **CC Switch**：读 `claude` / `codex` / `gemini` 三类，其它 app_type（`claude-desktop`、`opencode`、`hermes`…）跳过；按类分组、组内 `is_current` 的排前面。
  - `claude`：`settings_config` 与 Claude Code 的 settings.json 同结构，复用同一个解析；`meta.apiFormat` 为 `openai_chat` / `openai_responses` 时按它定协议；
  - `codex`：`settings_config.config` 是 TOML 字符串、`auth.OPENAI_API_KEY` 是 key，复用 Codex 的解析，只取选中的那个服务；没写 `wire_api` 时用 `meta.apiFormat`；
  - `gemini`：`GEMINI_API_KEY`（或 `GOOGLE_API_KEY`）、`GOOGLE_GEMINI_BASE_URL`、`GEMINI_MODEL` → `google-generative-ai`；
  - `env` 为空的官方占位跳过；单行 JSON / TOML 坏了只跳过那一行。`sourceLabel` 为「CC Switch · <名称>」。

### 3. 缓存与导入（`providerImporter.ts`、`providerStore.addMany`）

- `scan(raw)`：收窄 `undefined | {} | { sources: 非空、合法来源数组 }`，其它一律「无效的扫描参数」；用当前 providers 标重复；
  结果（含 key）缓存在 Main 内存，**只留最近一次，10 分钟过期**；**扫描排队执行**，缓存总是最后发起的那次（界面也只认最后一次返回）。
- `import(raw)`：收窄 `{ candidateIds: 1–500 个扫描时发的 UUID }`；缓存过期 →「扫描结果已过期，请重新扫描」；
  id 不属于最近一次扫描 →「候选不在最近一次扫描结果里，请重新扫描」（不静默跳过）；没带模型的按协议补内置目录的预置模型
  （自定义 OpenAI 兼容没有预置，保持为空）；经 `addMany` 一次写盘。
- `addMany`：在同一个读改写里**再查一次重复**（与已有的或同批前面的地址和 key 都相同就不写，说明与谁重复），所以重复点导入不会建两份；
  名称被占用（不分大小写）加「 (2)」「 (3)」…且不超过 80 字，id 按加了后缀的名称生成；全是重复时不写盘。
- 返回 `{ imported: ModelProviderView[], skipped: { id, name, reason }[] }`；两个方法都不抛异常，读写出错折成 `{ ok: false }`。

### 4. IPC / preload

- 通道：`providers:scan-imports { sources? } → { candidates, warnings }`、`providers:import { candidateIds } → { imported, skipped }`，
  三处同步（`ipc.ts` 常量、`ipc/providers.ts` handler、`preload/domains/providers.ts`）；入参都按 `unknown` 收窄。
- **明文 key 不经过 Renderer**：Renderer 只拿到脱敏候选、只回传候选 id；importer 每个进程一个，和 provider store 一起在 Main。

### 5. 界面

- 「添加服务」下拉末尾加分隔线和「从本机导入…」；空态卡片加「从本机导入」按钮（放在最前），说明文字提到这三个来源。
- 弹窗：
  - 三个来源的复选框（悬停显示读的是哪个文件）+「重新扫描」；**切换来源会重新扫描**，这样重复关系按所选来源重算
    （例如只看 CC Switch 时，它那条与 Claude Code 相同的当前服务就不再置灰）；
  - 候选行：来源徽标（悬停是 sourceLabel）、名称、协议、实际地址、`••••末4位`（没有 key 时提示导入后填写）、「当前使用」、模型摘要；
    重复项置灰、不可勾选，写明与谁重复；整行可点；
  - 默认勾选「正在使用且不重复」的；全选 / 反选只作用于不重复的；「正在扫描本机配置…」「没有找到可导入的配置」「至少选择一个来源」三种状态文案；warning 列在下方；
  - 「导入所选（N）」→ 关弹窗，页面提示「已导入 N 个模型服务」，有跳过的列出名称和原因；列表经 store 重读刷新。
- 选择与文案规则在 `providerImport.ts`，不碰 DOM，node 下测试。

## 怎么验证

**基线**（`main@7dead65` + `815e3cc`）：typecheck exit 0；lint `Checked 302 files`；test `Test Files 94 passed / Tests 1320 passed`。

**验收命令**（最终提交 `bea59f7`，根目录）：

```
pnpm typecheck   → exit 0（typecheck:node / typecheck:web / typecheck:packages）
pnpm lint        → exit 0：Checked 320 files in 156ms. No fixes applied.
pnpm test        → exit 0：Test Files 101 passed (101)；Tests 1373 passed (1373)
pnpm build       → exit 0：out/main/index.js 256.15 kB、out/preload/index.cjs 10.59 kB、out/renderer/index.html + assets
```

- 产物里 `node:sqlite` 仍是 `import("node:sqlite")`（动态、外置），`smol-toml` 外置为运行时依赖。
- `pnpm test` 的输出里没有 SQLite 的 ExperimentalWarning（0 处）：测试经 `fixtures.loadSqlite()` 先加载 `node:sqlite` 并只静默这一条。
- Electron 45 实测：`ELECTRON_RUN_AS_NODE=1 electron.exe` 里 `process.versions.node` 为 24.22.0，`node:sqlite` 可用（SQLite 3.53.4），不打 warning。

**新增测试 7 个文件、53 个用例**（1320 + 53 = 1373），先写测试跑出红（`Cannot find module` / `is not a function`）再实现：

- 读取器 19：Claude Code 6、Codex 7、CC Switch 6。覆盖本机格式、别名忽略、`_NAME` 显示名、坏 JSON、坏 TOML（断言行号且 warning 不含原文）、
  缺 key、`env_key` 缺失提示、`requires_openai_auth` 才用 auth.json、ChatGPT 登录、`meta.apiFormat`、官方空占位、`is_current` 各种写法。
- `locate` 6：路径、BOM、**sqlite 副本只读**（读完临时目录为空、源库逐字节不变、源库旁没有多出文件）、
  **CC Switch 开着库且新行还在 `-wal` 里也能读到、且它之后还能继续写**、没有 providers 表 / 不是 SQLite 文件时抛错且副本照删。
- `scan` 7：三个来源的顺序与两种去重、视图逐字段（所有假 key 都不在视图里）、只扫 CC Switch 时重复关系重算、
  单个来源读失败（settings.json 是目录、cc-switch.db 是垃圾文件）不影响其它来源、一个都没装、不合规候选跳过与名称截断。
- `providerImporter` 8：**扫描与导入的返回都不含 key、key 只在 providers.json**；补预置模型与名称后缀；导入时再查重（含重复点导入）；
  **缓存 10 分钟过期后 import 返回错误**、过期前可用；id 属于旧扫描时报错；**入参收窄**（8 种坏的扫描参数、9 种坏的导入参数）；扫描排队；store 出错折成 `{ ok: false }`。
- `providerStore` +6：`addMany` 4（一次写多条与后缀、两种重复、全重复不写盘、后缀后不超 80 字）、`providerFingerprint` 1、`apiKeyHint` 1。
- 界面纯逻辑 7：默认勾选、全选 / 反选、提交顺序、来源顺序、重复说明、模型摘要、导入提示。

**真机（`pnpm dev` 扫本机三处来源）**：临时 `FYNVRA_USER_DATA_DIR`，`electron-vite dev --remoteDebuggingPort` 起 app，
驱动脚本在仓库外（`%TEMP%\fynvra-probe-15\smoke.mjs`），经 CDP 调 `window.fynvra.providers.*` 并点真实界面。

扫到 **11 个候选，0 条 warning**（只写名称与来源；key、地址不写）：

| 来源 | 名称 | 协议 | 当前使用 | 重复 |
|---|---|---|---|---|
| Claude Code | Claude Code | Anthropic | 是 | |
| Codex | Codex | OpenAI Responses | 是 | |
| CC Switch | 公司中转claude | Anthropic | 是 | 与「Claude Code」相同 |
| CC Switch | cursor | Anthropic | | |
| CC Switch | 君 | Anthropic | | |
| CC Switch | 中转4sapi | Anthropic | | 与「CC Switch · cursor」相同 |
| CC Switch | claude-sub2api | Anthropic | | |
| CC Switch | default | OpenAI Responses | 是 | 与「Codex」相同 |
| CC Switch | sub2api | OpenAI Responses | | |
| CC Switch | 泊锐中转 | OpenAI Responses | | |
| CC Switch | 公司中转外网 | OpenAI Responses | | |

CC Switch 的 12 行里另外 3 行按规则跳过：opencode「default」、claude-desktop「Claude Desktop Official」、gemini「Google Official」（空占位）。

界面与安全检查（第二轮全新 userData，23/23 通过）：

- 冒烟脚本把本机 7 个 key 读进内存（不打印）做泄漏断言：`scanImports` 返回、弹窗 DOM、`providers.list` 返回、导入后的设置页 DOM 里都没有任何一个；
  临时 userData 的 providers.json 里有导入的 2 个 key（只在 Main 落盘）；
- 空态「从本机导入」按钮 → 弹窗列出 11 行，默认勾选 2 行（Claude Code、Codex），置灰 3 行；
- 关掉 Claude Code 来源 → 重扫后不再有 Claude Code 候选；再打开恢复 11 行；
- 全选只选不重复的 8 行；反选清零；点整行只切换一次（标签包着 Checkbox，没有双触发）；
- 「导入所选（2）」→ 弹窗关闭，页面提示「已导入 2 个模型服务」，列表出现 Claude Code、Codex；
- 「添加服务」下拉里有「从本机导入…」，再扫一次时 4 行标为「已有」并置灰（导入的 2 个 + 它们在 CC Switch 里同地址同 key 的 2 个）；
- 非法 `sources` 返回「无效的扫描参数」；只扫 CC Switch 时，原先与 Claude Code / Codex 重复的两行不再置灰，CC Switch 内部的那对重复仍标出；
- 控制台没有 error / warning / 异常；关窗后 dev 进程 exit 0。
- 第一轮是 21/23：两条失败都是冒烟脚本自己的断言写错了（没想到 CC Switch 内部也有一对重复、导入后同地址同 key 的 CC Switch 行也会变成「已有」），
  不是产品问题；改正断言后用全新 userData 整轮重跑。
- 跑完核对：`~/.cc-switch/cc-switch.db` 修改时间（2026-10-01 01:36:59）与大小不变、旁边没有多出 journal / wal 文件，
  `%TEMP%` 里没有遗留的库副本；两轮的临时 userData（里面有导入的 key）都已删除。

## 与任务书有出入的地方

1. **Codex 的 `isCurrent`**：任务书写「Claude Code 与 Codex 恒为 true」。这里只有 `model_provider` 选中的那个是 true；config.toml 里没被选中的其它服务也列出来，
   但不算当前、不带 `model`。本机只有一个服务，结果与任务书一致。
2. **Codex 的 key**：任务书写「key 在 auth.json 的 OPENAI_API_KEY（或 env_key 指向的环境变量）」。这里与 Codex 本身一致：没有 `env_key` 时，
   只有 `requires_openai_auth = true` 的服务才用 auth.json 的 key，避免把 OpenAI 的 key 带给不需要它的端点（如本地模型）。CC Switch 写出的配置都有这一行，本机不受影响。
3. **视图多一个字段 `duplicateOf`**：任务书要求「重复项置灰并说明原因」，只有 `duplicate` 说不出与谁重复。
4. **默认勾选「正在使用且不重复」**，不是全部不重复的：CC Switch 里常攒着很多旧中转，一次全导进来不是多数人想要的；全选一下即可。
5. **切换来源会重新扫描**（`sources` 参数），而不是在已有结果里过滤：重复关系依赖扫了哪些来源，过滤会留下指向隐藏候选的「重复」。
6. **任务书写 `DatabaseSync` 的 `{ readonly: true }`**，Node 的选项名是 `readOnly`，按 Node 的写。

## 未做 / 注意

- **没改** `src/main/ipc/providers.test.ts`、`src/preload/domains/settingsDomains.test.ts`（都不在范围里）：
  两个 handler 只是转调 importer（逻辑全在 `providerImporter.test.ts`）+ 广播；preload 两个新方法的通道映射只有真机冒烟覆盖，没有单测。
  需要的话可以在 `settingsDomains.test.ts` 的映射用例里补两行。
- **ARCHITECTURE.md 没回写**（不在范围）：§9.6 说 `llm.ts` 的内容是规范性的，本卡按任务书在其中加了 `ProviderImportSource`、`ProviderImportCandidate`；
  §7 / §9 也还没有这两个通道。验收时可以考虑回写。
- 没做 CC Switch 的 `app_paths.json` 自定义数据目录（EnsoCode 支持）：任务书限定 `~/.cc-switch/cc-switch.db`。
- 只读 settings.json，不读 shell 环境里的 `ANTHROPIC_*` 变量和 `apiKeyHelper`；不导入 Codex 的 MCP 配置（不属于本卡）。
- **已知限制**：去重键按任务书是「地址 + key」。同一个中转在同一地址、用同一个 key 同时提供 Anthropic 与 OpenAI 协议时，后一个会被标为重复，
  需要手动添加。本机没有这种情况（`公司中转外网` 与 Claude Code 的中转同主机，但 key 不同）。
- 界面组件没有 DOM 层面的自动化测试（仓库没有 DOM 测试环境），由纯逻辑测试 + 真机 CDP 冒烟覆盖。
- 用户全局说明里的知识库检索（`maestro spec` / `maestro wiki`）没做：本机 PATH 上没有 `maestro`，`~/.maestro/workflows/coding-philosophy.md` 也不存在（本次核对过）。

## 给验收人的注意事项

1. 冒烟脚本、探针与日志都在仓库外的 `%TEMP%\fynvra-probe-15\`；探针只打印结构（键名、类型、长度），没打印任何 key。
2. 本机 Electron 45 内置 Node 24.22，`node:sqlite` 不打 warning；本机命令行 Node 23.11 会打，测试里已静默。
3. 本机数据的一个现象：`~/.codex/config.toml` 现在的 `model` 是 gpt-6-astra，而 CC Switch 里存的当前 Codex 服务「default」是 gpt-6.1-sol；
   两者地址和 key 相同，按规则保留排在前面的 Codex 候选（即正在生效的配置）。
4. 首次 `pnpm dev` 前需要 `node node_modules/electron/install.js`（本机缓存，不联网）；另一个 worktree 占着 5173 时 electron-vite 会换 5174。

## 范围核对（30 个文件）

- `package.json`、`pnpm-lock.yaml`：只加 `smol-toml`；
- `src/main/services/providers/import/**`：`locate.ts`、`scan.ts`、`providerImporter.ts`、`fixtures.ts`、`readers/{common,claudeCode,codex,ccSwitch}.ts` 及 6 个测试；
- `src/main/services/providers/*.ts`（接入）：`providerStore.ts`、`providerStore.test.ts`、`parseProviderInput.ts`（只把 `MAX_NAME_LENGTH` 导出）；
- `src/main/ipc/providers.ts`；`src/shared/types/ipc.ts`（`// --- providers ---` 段内）；`src/shared/types/llm.ts`；
- `src/preload/domains/providers.ts`；
- `src/renderer/components/settings/`：`ProviderImportDialog.tsx`、`providerImport.ts`、`providerImport.test.ts`、`ProvidersSettings.tsx`；
- `src/renderer/stores/providers.ts`；`src/renderer/components/ui/checkbox.tsx`。
