# Summary · Task 07 settings-ui（Providers / Roles / Skills / MCP 的存储、IPC 与设置页）

分支 `LAIJiangFeng/settings-ui`。worktree 照旧建在 `f5c2e91`（Initial commit）上。开工前（还没有任何提交）用 `git merge --ff-only main` 快进到 `main@387ac2d`，再在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q` 统一行尾。`main` 本身没动。

相对 `387ac2d` 有 20 个改动提交，涉及 73 个文件（+8067 / −3），另有本总结的 `docs(wave2)` 提交。每个提交都带 `Co-Authored-By: Claude Opus 5.5`。没有 BLOCKED 项。范围外只改了 3 个文件，理由见「未做 / 越界项」。

## 做了什么

| 提交 | 内容 |
|---|---|
| `95b346f` feat(shared) | `src/shared/types/llm.ts`：§9.6 原文，经 Biome 格式化（别的卡片复制同一段文字再格式化，会得到逐字节相同的文件）。`src/shared/modelCatalog.ts`：内置目录 Anthropic（claude-fable-5-1 / opus-5-5 / sonnet-5-5 / haiku-5-5）、OpenAI、Google、自定义 OpenAI 兼容；模型元数据取自 pi-ai 1.4.0 的内置目录。`resolveBaseUrl` 算出实际请求地址（留空用协议默认地址；Google 缺版本段时补 `/v1beta`，pi 的 Google SDK 在指定 baseUrl 时不再自动补） |
| `624ecc9` feat(shared) | `IPC_CHANNELS` 末尾追加 `// --- providers / roles / skills / mcp ---` 四段（§9.1），每个领域都有一个 `<domain>:changed` 推送 |
| `49ce939` feat(preload) | `src/preload/domains/{providers,roles,skills,mcp}.ts`：`<Domain>Api` 类型、IPC 入参 / 返回类型、`create<Domain>Api(ipcRenderer, subscribe)`。`index.ts` / `types.ts` 每个领域只加一行（`types.ts` 用内联的 `import('./domains/x').XApi`）。`index.test.ts` 的域列表断言同步更新 |
| `5545614` feat(main) | `jsonRegistry`：providers / skills / mcp 三个注册表共用的文件读写，包括内存缓存、读改写串行、同目录临时文件 + rename 原子替换（权限 0600）、注册表 id 规则。`providerStore`、`parseProviderUpsert`（严格收窄）、`toProviderView`（脱敏） |
| `dc2cd3f` feat(main) | `testProvider`：用已存的 key 发一次「列模型」请求，见下文 |
| `fa3faea` feat(main) | `ipc/providers.ts`：`providers:list / upsert / remove / test`，以及 `getProviderStore()` |
| `ff156b2` feat(main) | `resolveModel.ts`：`createModelResolver()`，见下文 |
| `c5438e5` feat(main) | `ipc/roles.ts`：`roles:list / get / save / remove`，基于 core 的 `JsonFileRoleStore`（目录 `userData/roles`，注入 `node:fs/promises`）；内置角色在调用仓库之前就拒绝。core 已经提供了仓库，所以没有新建 `src/main/services/roles/**` |
| `3898c13` feat(main) | `skillManifest`（SKILL.md frontmatter）、`scanSkills`（定位 / 读取 / 去重三层）、`skillRegistry` |
| `9dd5cf2` feat(main) | `ipc/skills.ts`：`skills:list / add / remove / toggle / scan`，以及 `getSkillRegistry()` |
| `fc2f56a` feat(main) | `mcpRegistry`（密钥合并语义，见下文）、`claudeImport`、`parseMcpUpsert` |
| `f8d8978` feat(main) | `ipc/mcp.ts`：`mcp:list / upsert / remove / toggle / import-claude`，以及 `getMcpRegistry()` |
| `fc98c84` feat(renderer) | `components/ui/` 新增 select、switch、textarea、tabs、badge：基于 Base UI，shadcn new-york 风格，状态样式走 Base UI 的 data 属性；弹层 Portal 加 `no-drag` |
| `ab1c0d4` feat(renderer) | `stores/{providers,roles,skills,mcp}.ts`：Zustand，组件按字段订阅；变更成功后重读，同时监听 `<domain>:changed` |
| `2ce85dc` feat(renderer) | 纯逻辑：`providerForm`、`roleTransfer`、`mcpForm`，不碰 DOM，在 node 下测试 |
| `b560592` feat(renderer) | 设置视图外壳 + 外观分组；`TitleBar` 加一行 import + `<SettingsButton />`，`App` 加一行 import + `<SettingsView />` |
| `506ffe8` / `15c94d8` / `6e3c197` / `4d6911e` feat(renderer) | 模型服务 / 角色 / 技能 / MCP 四个页面，见下文 |

### 关键设计

- **设置视图在主窗口内，不开独立窗口**（任务书允许二选一，这里说明选择）：
  - 它是标题栏下方的整页视图（`fixed top-10`），标题栏上的设置按钮、窗口按钮和拖动区域都还能用；
  - 左侧是纵向 Tabs，自带键盘导航和 ARIA；按 Esc 或点关闭按钮退出，但在经 Portal 渲染的弹窗或下拉里按 Esc 不会连带关闭设置；
  - 不用新增窗口、preload 入口和窗口间同步，Main 不需要改动。
- **preload 领域文件用工厂，不导出现成对象**（§9.1 写的是「导出 `<domain>Api` 对象」）：
  - `preload/types.ts` 引用了 `XxxApi`，所以 Renderer 的类型程序也会加载领域文件；
  - 领域文件要是 `import { ipcRenderer } from 'electron'`，`electron.d.ts` 里的 `/// <reference types="node" />` 会把 Node 全局带进 Renderer，app-shell 和 Task 10 建立的护栏就失效了；
  - 所以领域文件不 import electron，由 `index.ts` 传入 `ipcRenderer`；
  - 探针：在 renderer 里写 `process.env`，`typecheck:web` 仍然报 TS2591；
  - 只读看了一眼另外两个并行分支：agent-host 和 orchestration-host 各自也选了同样的 `create<Domain>Api` 写法，三张卡一致。
- **IPC 入参 / 返回类型放在 preload 领域文件里，Main 用 `import type` 引用**：
  - `llm.ts` 必须逐字照搬 §9.6，`ipc.ts` 只允许追加通道段，`src/shared` 里没有别的地方可放；
  - 这样类型只有一份来源，不会出现两份声明各改各的。
- **注册表 id 由名称生成 slug**（规则与角色 id 相同，如 `anthropic`、`pdf`、`github`，重名加 `-2`）：
  - 角色文件里引用的就是这些 id，把角色导出到另一台机器再导入时，同名的服务、技能、MCP 能对上；
  - MCP 的 id 同时满足 pi 对服务器名的要求（`[A-Za-z0-9_-]`）。
- **`providers:test`** 做的是：
  - 只收 id，key 从 providers.json 取；发「列模型」请求，不消耗 token，同时验证地址和 key；
  - URL 按 pi 实际请求的方式拼：Anthropic 在 baseUrl 后接 `/v1`，OpenAI 兼容服务的 baseUrl 自带版本段，Google 补 `/v1beta`。地址填错，在这里就会暴露；
  - Google 的 key 放在请求头里，不放 query；
  - 走 Electron 的 `net.fetch`，即 Chromium 网络栈，会用系统代理，国内访问官方 API 需要它；
  - 失败时返回可读的中文错误：按 HTTP 状态给提示；有 `error.message` 就附上，HTML 错误页不回显；连接错误带上主机名；15 秒超时；回显里出现 key 会被打码。
- **`createModelResolver()`** 的要点：
  - 形状同 §9.5。agentHost/** 不在本卡范围，所以 `ModelResolver` / `ResolvedModelSpec` 在本文件里按相同形状声明；类型测试把它钉在 §9.5 原文上，`Role.model`（带 thinking）可以直接作为引用传入；
  - **`ResolvedModelSpec.providerId` 是运行时 provider 键**：`fynvra-` 加 `sha256(baseUrl + "\n" + apiKey)` 的前 16 位，即任务书说的「去重键 baseUrl + apiKey」：
    - 端点和 key 都相同的多个服务对应同一个 pi provider，只需注册一次；
    - 换了 key，键也随之改变，长驻的 worker 不会继续用旧凭证；
    - key 明文不会出现在 provider 名、日志或 usage 事件里；
    - 协议写在模型上（pi 的 `ProviderModelConfig.api`），所以同一端点下混用协议也可以；
  - `baseUrl` 是实际请求地址；
  - 不传引用时，取第一个启用、有 key、有模型的服务的第一个模型；
  - 服务停用、没有 key、模型不存在都返回可读错误。
- **SKILL.md 解析**：
  - 只认顶层标量，覆盖了技能文件里实际用到的写法：普通标量（可跨行、可带行尾注释）、单 / 双引号、`|` / `>` 块；`metadata:` 之类的嵌套映射跳过；
  - 根 package.json 不在范围内，所以没有引入 YAML 依赖；
  - 用本机全部 70 个 SKILL.md（`~/.claude`、`~/.codex`、`~/.pi`）实测过，全部解析正确，符号链接目录也能读。
- **skills:scan 分三层**：
  - 定位：三个根目录，顺序就是优先级；
  - 读取：每个含 SKILL.md 的子目录，跟随符号链接，跳过隐藏目录；
  - 去重：按小写 name，先出现的来源优先，并标出已登记的；
  - 单个来源失败，只体现在它自己的 status 上。
- **登记扫描结果不新增通道**：
  - `skills:add` 无参时由 Main 弹目录选择框；传 `{ candidateIds }` 时登记扫描结果；
  - 候选 id 是 `<来源>:<单段目录名>`，Main 在固定根目录下重新拼出路径，所以 Renderer 始终不传路径。
- **MCP 密钥编辑语义**（Renderer 永远拿不到明文）：
  - `env` / `headers` 不传 → 沿用全部旧值；
  - 传了 → 就是完整的键集合：不带 value 的键沿用旧值（新键必须带 value），没列出的键删除；
  - 切换传输方式时，另一侧的字段和密钥一并丢弃；
  - 导入按 URL（忽略末尾 `/`）或「命令 + 逐项参数」去重，既和已登记的比，也和本批里更早的比；
  - JSON 语法错误不带 V8 的原始信息：它会引用文件片段，而 `~/.claude.json` 里可能有凭证。
- **角色导入 / 导出在 Renderer 完成**，不新增通道，路径也不经过 IPC：
  - 导出：浏览器下载 `<id>.json`，Electron 会弹出另存为对话框，格式与 `userData/roles/<id>.json` 相同；
  - 导入：经 `<input type="file">` 读入，支持单个角色或数组，逐个用 core 的 `parseRole` 校验，id 冲突时自动加后缀。
- **坏文件留底**：providers.json / skills.json / mcp.json 解析失败时，把它改名为 `<file>.corrupt-<时间戳>`，然后按空表继续，下一次写入不会把里面的 key 覆盖掉。其他读错误（非 ENOENT）直接 reject，不当成空表。

### 页面

- **模型服务**：
  - 从目录模板添加服务；
  - 卡片上显示实际地址和 `••••末4位`，带启用开关、「测试连接」（耗时、模型数或可读错误直接显示在卡片里）、编辑、删除（行内二次确认）；
  - 弹窗里的 key 输入框只写不读：留空表示不改，「清除 key」才删除；模型可以删除，也可以手填 id 添加。
- **角色**：
  - 左侧列表，内置角色在前，带「内置」标记；
  - 右侧编辑器：名称、ID（仅新建时可填）、描述、系统提示词、模型（按服务分组，来自 providers store）、思考档位、工具策略、审批档位、技能多选、MCP 多选；
  - 内置角色只读，提供「复制为新角色」；
  - 引用了已删除的服务、模型、技能或 MCP 时，显示为「不可用 / 已移除」项，方便取消；
  - 保存前用 core 的 `parseRole` 校验；切换角色时如果有未保存的修改，会先确认。
- **技能**：
  - 注册表列表，带启用开关、「从注册表移除」（不删文件）、「添加目录」（Main 弹框）；
  - 扫描弹窗：每次打开都重新扫描；每个来源显示状态；默认勾选未登记的技能，然后批量登记。
- **MCP**：
  - 列表显示传输方式、命令行或 URL，以及 env / header 的键名徽标；
  - 「从 Claude Code 导入」，结果用一句话汇总；
  - 编辑弹窗按传输方式切换字段；值输入框是 password 类型，已保存的键名只读，提示「已保存，留空则不修改」。
- **外观**：主题选择，与标题栏的主题菜单共用 settings store。

## 怎么验证

**基线**（`main@387ac2d`，worktree 里先执行 `pnpm install --frozen-lockfile`）：typecheck exit 0；lint `Checked 112 files`；test `32 passed / 409 passed`。

**验收命令**（最终提交，根目录）：

```
pnpm typecheck   → exit 0（typecheck:node / typecheck:web / typecheck:packages）
pnpm lint        → exit 0：Checked 178 files in 159ms. No fixes applied.
pnpm test        → exit 0：Test Files 52 passed (52)；Tests 572 passed (572)
pnpm build       → exit 0：out/main/index.js 90.70 kB、out/preload/index.cjs 6.58 kB、
                   out/renderer/index.html + assets（js 1,437.75 kB / css 44.19 kB）
```

- **新增测试**：20 个文件，163 个用例，全部通过。409 + 163 = 572；`preload/index.test.ts` 的用例数没有变。
  - Main 服务（118 个）：
    - jsonRegistry 11、parseProviderInput 18、providerStore 15、testProvider 14、resolveModel 10；
    - skillManifest 7、scanSkills 8、skillRegistry 4；
    - claudeImport 5、mcpRegistry 9、parseMcpInput 21。
  - Main IPC（16 个），用 mock 的 ipcMain 和临时 userData：providers 4、roles 5、skills 4（mock 目录框 + 临时 home）、mcp 3。
  - preload（2 个）：领域方法与通道的映射、只传 id、changed 订阅。
  - shared（8 个）：modelCatalog。
  - renderer 纯逻辑（15 个）：providerForm 5、roleTransfer 6、mcpForm 4。
- **先写测试**：每个模块都先跑出红（测试文件 import 不到实现、`Tests no tests`），再写实现。有两处测试暴露了问题，随后修正：
  - Windows 上路径中间段是文件时，readdir 报 ENOENT 而不是 ENOTDIR，扫描测试的造错方式改为「根目录本身是文件」；
  - 测试源码里混进了一个字面 BOM 字符，改为 `String.fromCharCode(0xfeff)`。
- **类型探针**：
  - renderer 里写 `process.env`，`typecheck:web` 报 TS2591（护栏仍有效，临时文件已删）；
  - `expectTypeOf(createModelResolver).returns.toExtend<§9.5 ModelResolver>()` 由 `typecheck:node` 检查。

**运行时冒烟**（`pnpm dev`，25 项全部通过）：

- 驱动脚本放在仓库外的临时目录，用临时 `FYNVRA_USER_DATA_DIR`。经 CDP 调 `window.fynvra.*`，并发送真实鼠标 / 键盘事件。结论全部来自 DOM 和磁盘，没有截图。跑完 app exit 0，临时 userData 已删除。
- **providers**：
  - upsert 的返回只有 `apiKeyHint: "1234"`；磁盘上的 providers.json 有 key，`providers.list` 的返回里没有；
  - 编辑时不带 key，磁盘上的 key 保留；
  - `providers.test` 经 `net.fetch` 打到本机的假 `/v1/models` 端点（只在 127.0.0.1 上，不访问外网），请求头带上了已存的 key 和 `anthropic-version`，返回 `modelCount: 2`。
- **roles**：
  - list 中内置角色为 `orchestrator,worker`；
  - save 写出 `userData/roles/smoke-tester.json`，系统提示词在文件里；再次编辑后文件被重写；
  - `roles.remove('orchestrator')` 返回「内置角色不可删除」。
- **skills**：
  - scan 的来源统计为 `claude:found:31 codex:found:7 pi:found:28`，去重后 38 个候选，与本机 `~/.claude/skills` 下含 SKILL.md 的目录数（31）一致；
  - 登记一个候选后写出了 skills.json。
- **mcp**：
  - `importClaude` 导入本机 `~/.claude.json` 的 4 个服务器（pencil、chrome-devtools、context7、wechat-backup，后者带 3 个 env 键）；
  - 导入返回、`mcp.list` 和 MCP 页面文本里都没有任何 env 值（按原文和 JSON 转义形式比对，值不打印）；mcp.json 里有。
- **界面**：
  - 标题栏按钮打开设置视图，5 个分组依次是 `模型服务|角色|技能|MCP|外观`；
  - 模型服务页只显示 `••••1234`；
  - 角色页：内置角色显示只读提示且没有删除按钮；自定义角色显示提示词和删除按钮；
  - 技能页列出已登记的技能；MCP 页显示服务器名和 env 键名徽标；
  - 外观页切到深色后，`<html>` 带上 `.dark`；按 Esc 关闭设置视图；
  - 控制台没有 error、warning 或异常。

**只读探针**（都用临时测试文件做，跑完即删）：

- 本机全部 SKILL.md 的解析结果；
- `importClaude` 对本机 `~/.claude.json` 的结构解析：只打印名字、传输方式和键名，不打印值。

## 未做 / 越界项

- **范围外改动（3 个文件）**：
  - `src/preload/index.test.ts`：原测试逐个列出 `window.fynvra` 的域，新增四个域后不改就失败。只改了这条断言和标题，并把「不暴露 invoke」的检查扩大到所有域。另外两个并行分支也改了同一行，见注意事项 1；
  - `src/shared/modelCatalog.ts` 及其测试：任务书「要做什么」第 1 条点名要建这个文件，但「范围」清单里没有列。
- **`jsonRegistry.ts` 放在 `src/main/services/providers/` 下**：它被 skills 和 mcp 复用，任务书只开放了这四个服务目录，放在其中一个里面最不越界。文件头注释写明了这一点。
- **没有做**：
  - 独立的设置窗口（`settings.html`）；
  - 从服务端拉取模型列表来填充模型（只用它来测试连通性）；
  - OAuth 订阅类账号；
  - 修改已有角色的 id；
  - 删除技能或 MCP 时，同步清理引用了它的角色文件：编辑器会把这些引用显示成「已移除」，由用户清理；
  - 导入 Codex（`config.toml`）的 MCP 配置：任务书只要求 Claude，Wave 3 再做。
- **没有自动化，也没有手动跑过的部分**：
  - 原生目录选择框（「添加目录」）：Main 侧用 mock 的 dialog 测过选目录、取消、缺 SKILL.md、重复四种情况；
  - 「导出 JSON」触发的另存为对话框；
  - 对真实官方 API 的「测试连接」：冒烟只连本机的假端点。
- **接线不在本卡范围**：`src/main/index.ts` 把 agent-host 的 `envModelResolver` 换成 `createModelResolver()`，以及会话按角色解析技能 / MCP，都留给后续卡片，见注意事项 2、3。
- 用户全局说明里提到的知识库检索（`maestro spec` / `maestro wiki`）这台机器上用不了：没有 `maestro` 命令，`~/.maestro/workflows/coding-philosophy.md` 也不存在。所以没做。

## 给验收人的注意事项

1. **与并行分支合并**（只读看过它们已提交的内容）：
   - agent-host 和 orchestration-host 也改了 `src/shared/types/ipc.ts`、`src/preload/index.ts`、`src/preload/types.ts`、`src/preload/index.test.ts`、`src/main/ipc/index.ts`，都是在同一位置追加，所以会有相邻行冲突。解决办法是三方取并集：
     - IPC_CHANNELS 的各个 `// --- <domain> ---` 段都保留；
     - `FynvraApi` 的各个字段都保留；
     - `index.test.ts` 的域列表合成一个排好序的数组；
   - 两边目前都还没有提交 `llm.ts`。如果之后 agent-host 也加了，只要对 §9.6 原文跑过 Biome，就和本卡的文件逐字节相同。
2. **接入 ModelResolver**（agent-host）：
   - 在 `src/main/index.ts` 用 `createModelResolver()` 替换 `envModelResolver`。它不需要参数，内部读 `getProviderStore()`，每次 resolve 都用最新的设置；
   - worker 侧可以用 `spec.providerId` 作为 pi provider 名：`registerProvider(spec.providerId, { baseUrl, apiKey, api, models: [{ id: modelId, api, … }] })`；
   - spec 里没有 contextWindow 等模型元数据（§9.5 没有这些字段），worker 需要自己从 pi 的目录按 modelId 查，或者使用默认值。
3. **会话按角色取技能 / MCP**：
   - 技能：`getSkillRegistry().list()` 里 `enabled` 且在 `role.skillIds` 中的条目，取它的 `path`；
   - MCP：`getMcpRegistry().list()` 里 `enabled` 且在 `role.mcpServerIds` 中的条目；
   - 映射成 agent-runtime 的 `McpServerConfig` 时，`name` 用 id：
     - stdio 映射为 `{ name: id, type: 'stdio', command, args, env }`；
     - http / sse 映射为 `{ name: id, type: 'http', url, headers }`（pi 没有单独的 sse 类型）；
   - 角色文件里引用的 id 可能已经被删除，需要跳过，或者作为 `warnings` 显示。
4. **§9.6 契约的边界**：
   - `McpServerEntryView` 带有 `url` 和 `args`，Renderer 能看到它们；
   - 如果用户把 token 写在 URL 的 query 或命令参数里，这些 token 会显示在界面上。真正的密钥通道是 env / headers，Renderer 只拿到键名；
   - 要改的话需要先改契约。
5. **Electron 二进制**：本 worktree 原本没有 `node_modules/electron/dist`。冒烟前执行了 `node node_modules/electron/install.js`，它从本机缓存 `%LOCALAPPDATA%\electron\Cache` 里的 v45.0.0 zip 解压，没有联网。
6. **文件权限**：注册表文件以 0600 写入。Windows 上没有实际效果，只是在 macOS / Linux 上避免其他用户读到 key。
7. **服务改名后 id 不变**：id 只在新建时由名称生成，角色里的引用不会因为改名而失效。
