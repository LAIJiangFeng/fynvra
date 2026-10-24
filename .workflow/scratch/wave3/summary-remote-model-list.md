# Summary · Task 20 remote-model-list（服务弹窗一键拉取远程模型列表）

分支 `LAIJiangFeng/remote-model-list`。worktree 建在 `f5c2e91`（Initial commit）上。开工前做了这些准备：

- `git merge --ff-only main` 快进到 `main@e7ef7cd`；
- 在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`，没有产生改动；
- `pnpm install --frozen-lockfile`；
- 真机冒烟前 `node node_modules/electron/install.js`，从本机缓存解压 Electron，没有联网。

相对 `e7ef7cd` 共 9 个改动提交，涉及 18 个文件（+2163 / −12），另有本总结的 `docs(wave3)` 提交。
每个提交都带 `Co-Authored-By: Claude Opus 5.5`，未 push、未建 PR。写总结时 `main` 仍是 `e7ef7cd`，`git merge-tree --write-tree main HEAD` 无冲突。

**没有 BLOCKED 项，没有越界改动**（18 个文件逐个对过任务书「范围」，见文末）。
有一处受范围限制、效果打了折扣：拉取面板里的「推理」徽标只来自设置页内置目录，没用上 pi 的完整目录，见「与任务书有出入的地方」第 1 条，附了后续卡的最小改法。

## 做了什么

| 提交 | 内容 |
|---|---|
| `d6682c1` feat(shared) | `llm.ts` 加 `RemoteModelEntry`；`IPC_CHANNELS` 的 `// --- providers ---` 段内加 `PROVIDERS_LIST_REMOTE_MODELS` |
| `630581e` feat(preload) | `ListRemoteModelsInput` / `ListRemoteModelsResult` 类型与 `providers.listRemoteModels` |
| `4e7d6ca` feat(main) | `remoteModels/parsers.ts`：三种协议返回的纯函数解析器；`fixtures.ts` 照官方与常见中转的形态写 |
| `13aac34` feat(main) | `remoteModels/listRemoteModels.ts`：按协议的请求序列、回退、错误映射、补元数据、去 key；`testProvider.ts` 导出 4 个复用的函数 |
| `0a2070a` feat(main) | `remoteModels/input.ts`：入参收窄与「请求哪个服务」；`parseProviderInput.ts` 导出 `isHttpUrl` 与三个长度上限 |
| `9c880b6` feat(main) | `ipc/providers.ts` 注册 `providers:list-remote-models` |
| `a59f110` feat(renderer) | `remoteModels.ts`：按钮可用、请求入参、已添加、搜索、全选 / 反选、合并的纯函数 |
| `774b66f` feat(renderer) | `stores/providers.ts` 加 `listRemoteModels` |
| `16d6078` feat(renderer) | `RemoteModelsPicker.tsx` 面板；`ProviderDialog.tsx` 模型标题行加按钮、接面板、弹窗限高滚动 |

### 1. IPC：`providers:list-remote-models`

- **入参** `{ providerId?, draft?: { api, baseUrl?, apiKey? } }`，严格收窄（`input.ts`）：
  - 未知字段、id 带路径、协议不支持、地址不是 http(s) 或超长、key 含空白，一律拒绝；两个都没有也拒绝；
  - 地址与 key 的规则与 `providers:upsert` 相同：去首尾空白，空地址当没填，用协议的官方地址。
- **请求哪个服务**（`remoteModelsTarget`）：
  - 协议与地址：有 draft 就以 draft 为准（draft 没写地址就是官方地址，与按表单保存后一致）；
  - key：draft 优先，没带就用已保存的；都没有返回「还没有填写 API Key」，不发请求；
  - `alreadyAdded` 对照已保存服务的模型列表。
- **返回** `{ models, endpoint, warnings }`，从不抛异常；`endpoint` 是返回列表的地址（去掉 query）。
- **网络**：与 `providers:test` 同一条路径（Electron `net.fetch`：Chromium 网络栈与系统代理），不经 worker / pi。
  - 每次请求 15 秒超时，禁止重定向（同 `providers:test`）。

### 2. 各协议的请求（`remoteModelsRequests`，地址与头沿用 `providers:test` 的 `buildModelsRequest`）

| 协议 | 第一次 | 回退 |
|---|---|---|
| Anthropic | `<base>/v1/models?limit=1000`，`x-api-key` + `anthropic-version: 2023-06-01` | 400 / 401 / 403 / 404 / 405 或返回的不是列表时：同一地址 + `Authorization: Bearer`，按 OpenAI 形态解析 |
| OpenAI 两种协议 | 地址已以版本段结尾（`/v1`、`/v4`、`/v1beta`…）时 `<base>/models`；否则 `<base>/v1/models` | 没有版本段、且 404 / 405 或不是列表时：pi 实际用的 `<base>/models` |
| Google | `<base>/v1beta/models?pageSize=1000`（地址缺版本段时补 `/v1beta`），key 在 `x-goog-api-key` 请求头 | 无 |

- **解析**（`parsers.ts`）：
  - Anthropic 取 `data[].id / display_name`、`has_more`；
  - OpenAI 取 `data[].id`（`owned_by` / `created` 不进视图类型）；
  - Google 去掉 `models/` 前缀，取 `displayName`、`inputTokenLimit` → contextWindow、`outputTokenLimit` → maxOutput；
    写了 `supportedGenerationMethods` 却不含 `generateContent` 的略过，没写的保留；
  - 结构不对返回 null，交给上层回退或报错。
- **整理**（`toEntries`）：
  - id 去空白，按 `providers:upsert` 的 id 规则校验（非空、无空白、≤ 200），所以列出来的都能保存；
  - 按 id 去重，按自然顺序排序（`Intl.Collator('en', { numeric: true })`，m-9 在 m-10 前）；
  - 最多给 Renderer 2000 条。
- **元数据**：显示名、上下文窗口、最大输出优先用服务端给的，没有时取内置目录；`reasoning` 只来自内置目录，目录里没有就不带。
- **错误**（可读中文，不抛）：
  - HTTP 错误沿用 `providers:test` 的措辞（401 →「API Key 无效或已失效」，附服务端说明），后面接 ` · <请求地址>`；
  - 2xx 但不是列表 →「接口返回的不是模型列表」；连不上 →「无法连接 <主机>：<原因>」，Node 的 `cause` 一并带上；超时 →「请求超时（15 秒）：<主机>」；
  - 两种请求都失败时，报最能说明问题的那个：key 被拒 > 其他 HTTP 错误 > 不是列表 > 接口不存在，同级取先请求的。
- **warnings**：改用了哪种请求、跳过了几个无效 id、Google 略过了几个、服务端说还有下一页、超过 2000 条。
- **key 不出 Main**：
  - 错误、提示、地址里的 key 都替换成 `***`；
  - 含 key 的模型 id 直接丢弃，含 key 的显示名换成目录名或 id。

### 3. 界面

- ProviderDialog「模型」标题行右侧加「拉取模型列表」按钮：
  - 有地址就能点（协议的官方地址也算）；自定义 OpenAI 兼容服务没填地址时禁用；
  - 每次点击都按表单**当前**的协议、地址与 key 请求；已保存的服务带 id，没填新 key 时用已保存的 key。
- 点击后在弹窗内展开面板 `RemoteModelsPicker`（标题行与模型列表之间）：
  - 加载中：转圈与「正在拉取模型列表…」；
  - 失败：内联红字错误与「重试」。新服务没填 key 时不发请求，直接提示「先填写 API Key，再拉取模型列表」，填好后点「重试」即可；
  - 成功后的内容：
    - 标题行显示返回列表的地址（经 `maskSecrets`），带「重新拉取」与「收起」；
    - 搜索框不分大小写，按空白分词，每个词都要出现在 id 或名称里；回车不会提交表单；
    - 每行：复选框、等宽 id、显示名（与 id 不同时）、「推理」徽标、「已添加」（置灰、禁用，按表单当前的模型列表判断）；
    - 「全选 / 反选」只作用于当前搜索结果里没添加过的，被搜索藏起来的勾选保留；
    - 底部「共 N 个 · 已添加 · 已选」、「全部加入（N）」（当前搜索结果里所有未添加的）、「加入所选（N）」；
    - warnings 列在最下面。
- **加入**（`mergeRemoteModels`）：
  - 已有条目原样保留，包括用户改过的名称和推理标记；新条目接在后面，带上显示名、上下文与最大输出；推理只带 `true`；
  - 到每个服务 500 个模型的上限（`providers:upsert` 的校验）为止；
  - 面板留着，便于分几次加；加入后显示「已加入 N 个模型，保存后生效」，刚加的行变成「已添加」；
  - 点「保存」才写盘，「取消」就丢弃。
- 弹窗内容限高 `calc(100vh - 2rem)` 可滚动：展开面板后，矮窗口里也够得着保存按钮。

## 怎么验证

**基线**（`e7ef7cd`）：typecheck exit 0；lint `Checked 362 files`；test `Test Files 120 passed / Tests 1614 passed`。

**验收命令**（最终改动提交 `16d6078`，根目录）：

```
pnpm typecheck → exit 0（node / web / packages 三段）
pnpm lint      → exit 0：Checked 372 files in 344ms. No fixes applied.
pnpm test      → exit 0：Test Files 124 passed (124)；Tests 1703 passed (1703)
pnpm build     → exit 0：out/main/index.js 328.42 kB、out/main/chunks/index-*.js 122.14 kB、
                 out/preload/index.cjs 12.84 kB、out/renderer/index.html + assets（css 69.51 kB）
```

**新增 89 个用例**（1614 + 89 = 1703），都在 node 下跑：

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `remoteModels/parsers.test.ts` | 17 | 三种协议的 fixtures；`has_more` / `nextPageToken`；Anthropic 解析器也认 OpenAI 形态；无效条目计数；6 种非预期结构返回 null；空列表合法；Google 过滤、没写方法的保留、token 上限不合法不带、全被过滤不算结构错误 |
| `remoteModels/listRemoteModels.test.ts` | 29 | 请求序列（地址与头）：Anthropic 两步、OpenAI 以版本段结尾不重复拼 `/v1`（含 `/v4`）、没版本段时两步、Google key 不进 URL；Anthropic 官方返回的排序 / 目录元数据 / 已添加；回退（404，以及 400 / 401 / 403 / 405 / 200 网页 / 200 非列表）；429 / 500 不回退；两种都失败时选哪条错误（5 组）；OpenAI 404 → `/models`；OpenAI 401 不重试；地址带 `/v1` 时 404 直接报错；Google 过滤提示与请求头；下一页提示；无效 id 跳过与去重；自然排序；2000 条截断；连不上带 cause；超时不回退；**key 不出现在返回值里**（服务端回显、连接错误、模型 id / 名称、地址里的 key） |
| `remoteModels/input.test.ts` | 25 | 三种合法形状（含去空白、空地址与 null）；17 种非法入参；错误信息不回显 key；`remoteModelsTarget` 的 5 种组合（只传 id / 只传表单 / 两个都传时地址与 key 的优先级 / id 不存在 / 都没有 key） |
| `settings/remoteModels.test.ts` | 18 | 按钮可用；请求入参（新服务、已保存服务、新 key 优先、5 种提示）；已添加按表单重算；搜索；勾选、全选 / 反选只作用于视图里未添加的；要加入的；合并保留已有条目与推理标记、只带 `reasoning: true`、批内去重、500 上限；合并提示文案 |

**TDD 的实际顺序**：每个模块都是先写测试跑出红（模块不存在，`Tests no tests`），再实现到绿。

**变异测试**：脚本逐处改源码、跑对应测试、再恢复，3 个模块共 37 处，全部被测试抓到（`survived: 0`）。

- `listRemoteModels` 14 处：Anthropic 回退去掉 400 / 401、OpenAI 401 也回退、错误排序的两处、保留含 key 的 id / 名称、地址不去 key、去掉版本段判断、目录不按协议过滤、改成按码位排序、不截断、超时也回退、连接错误不带 cause；
- `input` 9 处：地址与 key 的优先级颠倒、id 不存在也放行、两层未知字段放行、不校验 id、不校验地址协议、key 含空白放行、丢掉已保存的 id；
- Renderer `remoteModels` 14 处：忽略已保存的 key、忽略「清除 key」、不传 id、忽略必填地址、已添加信 Main 不信表单、搜索只看 id、任一词即匹配、全选包含已添加的、全选丢掉视图外的勾选、要加入的包含已添加的、合并覆盖已有条目、带上 `reasoning: false`、忽略上限、批内不去重。

**IPC 接线**：

- `src/main/ipc/providers.test.ts` 不在范围里，没有改；
- 另写了一个临时测试 `providers.remote.tmp.test.ts`，用 mock 的 ipcMain 和 `net.fetch` 验证了 4 项，**跑完已删除，未提交**：
  - 按 id 用已保存的 key，返回值里没有 key；
  - 两个都传时以表单地址为准、key 用已保存的；
  - 非法入参与不存在的 id 不发请求；
  - `net.fetch` 抛错时折成可读错误。

**真机**（`pnpm dev`）：

- **准备**：隔离 userData（`FYNVRA_USER_DATA_DIR`）；经 `providers.scanImports` / `importCandidates` 导入本机 Claude Code 与 Codex 两个中转。
- **启动**：从 PowerShell 执行 `pnpm exec electron-vite dev --remoteDebuggingPort 9529 '--' <不节流开关>`。
- **驱动**：脚本在仓库外，经 CDP 调 IPC、点真实界面。结论来自 DOM、IPC 返回值和 providers.list。另截了一张图只用来核对布局，没有外发。
- **泄漏断言**：本机两个 key 只读进脚本内存做比对，不打印。

**两个中转各拉一次的结果**（不写 key 与地址）：

| 服务 | 协议 | 结果 | 前几个 id | 推理徽标（内置目录） | 已添加 |
|---|---|---|---|---|---|
| Claude Code 中转 | Anthropic | **14 个**，第一种请求（x-api-key）就成功，约 1.2–1.6 秒，无提示 | claude-fable-5、claude-fable-5-1、claude-haiku-4-5-20251001、claude-haiku-5-5、claude-opus-4-5-20251101、claude-opus-4-6、claude-opus-4-7、claude-opus-4-8 … | claude-fable-5-1、claude-haiku-5-5、claude-opus-5-5、claude-sonnet-5-5 | claude-fable-5-1（导入时带的模型） |
| Codex 中转（base_url 不带 `/v1`） | OpenAI Responses | **13 个**，`<base>/v1/models` 第一次就成功，约 0.3 秒，无提示 | codex-auto-review、gpt-5.2、gpt-5.3-codex-spark、gpt-5.4、gpt-5.4-mini、gpt-5.5、gpt-5.6、gpt-5.6-luna … | gpt-5.5 | 无（导入时带的 gpt-6-astra 不在中转的列表里） |

**界面与安全检查**：用全新 userData 整轮跑，**25/25 通过**。

- IPC：
  - 两个中转的返回里都没有 key；
  - 没有 key 的表单直接返回「还没有填写 API Key」；
  - 连不上的地址返回「无法连接 127.0.0.1:59999：net::ERR_CONNECTION_REFUSED」；
  - 非法 id 被拒。
- 编辑 Claude Code：
  - 面板 14 行，1 行「已添加」；
  - 搜索 `claude-fable` 剩 2 行；
  - 全选 → 反选 → 全选，计数 1 → 0 → 1；
  - 「加入所选（1）」后模型列表 1 → 2，提示「已加入 1 个模型，保存后生效」，两行都变成「已添加」；
  - 弹窗 DOM 里没有 key；
  - 保存后 providers.list：原条目逐字段不变，新条目接在后面；
  - 再拉一次：Main 的 `alreadyAdded` 与界面的「已添加」都是 2 个。
- 编辑 Codex：「全部加入（13）」后模型列表 1 → 14；点「取消」后已保存的仍是 1 个。
- 新建 Anthropic 服务：
  - 没填 key 点拉取，面板提示「先填写 API Key，再拉取模型列表」；
  - 填假 key 点「重试」，内联显示「API Key 无效或已失效（HTTP 401）：invalid x-api-key · <官方地址>/v1/models」，带「重试」；
  - 显示的是 x-api-key 那次的 401（key 被拒排在最前；Bearer 回退那次的状态没有单独记录）。
- 整页 `outerHTML` 里没有 key。

**收尾**：

- 第一轮是 22/23：唯一的失败是脚本自己的选择器问题。面板排在模型列表前面，脚本取「第一个 `ul`」量到的是面板列表。改成取不在面板里的 `ul` 后，用全新 userData 整轮重跑。
- 两轮的 dev 日志都没有 error / warning；经页面的 `window.close()` 关窗，dev 以 exit 0 退出，没有残留本 worktree 的 electron 进程。
- 隔离 userData 已删除（它的 providers.json 有导入的 key）。删除后，临时目录 28 个文件、仓库 `src` 303 个、`.workflow` 40 个都扫不到本机 key。
- 本分支 18 个改动文件里没有不可见字符，也没有 CRLF。

## 与任务书有出入的地方

1. **「推理」由内置目录判断，只用到了设置页的模板目录**（`MODEL_CATALOG`，元数据取自 pi-ai 1.4.0），没用上 pi 的完整目录。
   - **原因**：
     - Main 不加载 pi（§9.3）；
     - 按任意 id 查 pi 目录的 `describe-models` 在 agentHost 里，`AgentHostService` 没有对外暴露，`agentHost.ts` 不在本卡范围；
     - 所以按任务书「拿不到就留空」处理：按同协议同 id 查模板目录，查不到不带。这与导入时 `modelEntries`、弹窗 `reasoningControl` 用的是同一份目录。
   - **差距实测**：在隔离 userData 里用假 key 建临时服务，经现有的 `sessions:model-options` 问 worker（只查目录，不联网），推理模型数如下：

     | 中转 | 拉到的模型 | pi 完整目录认出的推理模型 | 面板上显示徽标的 |
     |---|---|---|---|
     | Claude Code | 14 | 14 | 4 |
     | Codex | 13 | 8（gpt-5.2、gpt-5.3-codex-spark、gpt-5.4、gpt-5.4-mini、gpt-5.5、gpt-5.6-luna / sol / terra） | 1 |

   - **不影响最终效果**：保存后再打开弹窗，现有的 model-options 机制（Task 19）会把这些 pi 目录模型显示成只读「推理」徽标，worker 也始终按 pi 目录处理。受影响的只是面板里的徽标。
   - **后续卡的最小改法**：
     - 在 `AgentHostService` 上暴露已有的 `describeModels(queries)`：接口加一行、返回对象加一项，自带按协议 / id / 标记的缓存；
     - `ipc/providers.ts` 拉到列表后，以 `{ api, modelId }` 问一次，有档位的标 `reasoning: true`，失败就留空；
     - 注意：worker 没起时会被拉起来，与弹窗打开时读 model-options 一样。
2. **网络走 Electron `net.fetch`，不是 Node 的 `fetch`**：
   - 任务书写「经 Node fetch，不走代理设置以外的东西」。Node 的全局 fetch 不读系统代理，`net.fetch` 只按系统代理设置走；
   - 这样与「测试连接」同一条路径，两者要么都通要么都不通；
   - 请求层的 fetch 是注入的，要换成 Node fetch 只需改 `ipc/providers.ts` 一行。
3. **Google 的 key 放在请求头 `x-goog-api-key`，不放 `?key=`**：
   - 与 `providers:test`、pi 的 Google SDK 一致；
   - key 不进 URL，也就不会出现在错误信息、代理日志和返回的 `endpoint` 里。
4. **Anthropic 的回退条件比任务书多了 400 / 401 / 403**：
   - 只实现 OpenAI 形态的中转，常用 401 拒绝不带 `Authorization` 的请求；
   - 第一次请求带 `?limit=1000`：Anthropic 官方默认一页只有 20 个，参数被拒（400）时同样回退。
5. **OpenAI 的两处补充**：
   - 「以 `/v1` 结尾不重复拼」放宽为任意版本段（`/v4`、`/v1beta`…），避免出现 `/v4/v1/models`；
   - 没有版本段时，`/v1/models` 404 / 405 或不是列表，再试 pi 实际请求用的 `<base>/models`。本机 Codex 的 base_url 就不带 `/v1`，实测第一种请求已经成功。
6. **Google 没写 `supportedGenerationMethods` 的条目保留**（部分中转仿 Google 接口时不写）。只略过写了却不含 `generateContent` 的。
7. **任务书没写的几处**：
   - **`alreadyAdded` 有两层**：Main 对照已保存的列表；弹窗里再按表单当前的模型列表重算，所以在弹窗里删掉的模型可以重新勾选；
   - **错误后接请求地址**：HTTP 错误和「不是模型列表」后面接 ` · <请求地址>`，方便判断 Base URL 填得对不对；
   - **「全部加入」带计数**：写作「全部加入（N）」，只作用于当前搜索结果里未添加的；
   - **面板加完不收起**，便于分几次加；
   - **合并有上限**：到 500 个为止，这是 `providers:upsert` 的校验；
   - **Main 截断**：列表超过 2000 条只给前 2000 条，并提示；
   - **没有分页**：不跟分页，服务端说还有下一页时提示「只列出了第一页」。
8. **入参与结果类型放在 preload 领域文件**（`ListRemoteModelsInput` / `ListRemoteModelsResult`），与其它 providers 通道一致。`llm.ts` 只放视图类型 `RemoteModelEntry`。

## 未做 / 注意

- **没改范围外的测试文件**：`src/main/ipc/providers.test.ts`、`src/preload/domains/settingsDomains.test.ts` 都不在范围里。handler 只是收窄、取记录、转调，逻辑都在 `remoteModels/**` 的测试里；接线由上面的临时测试与真机冒烟覆盖。需要的话两处各补一个用例即可。
- **ARCHITECTURE.md 没回写**（不在范围）。§9.6 说 `llm.ts` 的内容是规范性的，本卡按任务书加了 `RemoteModelEntry`；§7 / §9 里也还没有这个通道。
- **dev 下每次拉取会发两次请求**：渲染层开着 StrictMode，effect 在 dev 里跑两遍，第一次的回答被丢弃。生产构建只发一次，与导入弹窗的扫描相同。
- **不过滤 OpenAI 官方列表里的非对话模型**（嵌入、语音、图像等），靠搜索挑。中转一般只列对话模型。
- **拒绝重定向**（同 `providers:test`）：http 跳 https 的中转会报「无法连接 …」，需要把 Base URL 改成跳转后的地址。
- **知识库检索没做**：用户全局说明里的 `maestro spec` / `maestro wiki` 本机不可用，PATH 上没有 `maestro`，`~/.maestro/workflows/coding-philosophy.md` 也不存在（本次核对过）。

## 给验收人的注意事项

1. **在自己浏览器里看效果**：设置 → 模型服务 → 编辑一个中转 → 「拉取模型列表」→ 搜索 / 勾选 →「加入所选」或「全部加入」→ 保存。
   - 新建服务时不填 key 点拉取，会提示先填 key；
   - 把 Base URL 改错再点「重新拉取」，可以看到内联错误与「重试」。
2. **推理徽标差距**见「与任务书有出入的地方」第 1 条。是否开后续卡暴露 `describeModels`，由你定。
3. **冒烟临时目录** `%TEMP%\fynvra-t20-probe-41b82e`：
   - 留着 `smoke.mjs`、`catalog-gap.mjs`、`shot.mjs`、`mutate.mjs` 与变异清单、`dev-run1.log` / `dev.log`、`report-run1.json` / `report.json`（地址已换成 `<host>`）、`picker.png`（布局核对截图，含 key 末 4 位提示和本机地址，只在本机）；
   - userData 已删，整个目录可以删掉。
4. **首次 `pnpm dev` 前**需要 `node node_modules/electron/install.js`（本机缓存，不联网）。

## 范围核对（18 个文件）

- `src/main/services/providers/remoteModels/**`（新建）：`parsers.ts`、`listRemoteModels.ts`、`input.ts`、`fixtures.ts` 及 3 个测试；
- `src/main/services/providers/*.ts`（接入）：
  - `testProvider.ts`：只把 `describeHttpError`、`serverMessage`、`parseJson`、`hostOf` 改为导出；
  - `parseProviderInput.ts`：只把 `isHttpUrl`、`MAX_URL_LENGTH`、`MAX_KEY_LENGTH`、`MAX_MODEL_ID_LENGTH` 改为导出；
- `src/main/ipc/providers.ts`；
- `src/shared/types/ipc.ts`（`// --- providers ---` 段内）、`src/shared/types/llm.ts`（`RemoteModelEntry`）；
- `src/preload/domains/providers.ts`；
- `src/renderer/components/settings/`：`ProviderDialog.tsx`、`RemoteModelsPicker.tsx`（新建）、`remoteModels.ts` 与测试（新建）；
- `src/renderer/stores/providers.ts`。
- 没有动 agentHost、sessions、ARCHITECTURE.md、其它设置页组件、`providerForm.ts`、`modelCatalog.ts`、packages。
