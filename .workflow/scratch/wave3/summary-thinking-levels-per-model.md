# Summary · Task 21 thinking-levels-per-model（思考等级按模型官方定义：含 max、目录外变体推断、官方等级名）

分支 `LAIJiangFeng/thinking-levels`。worktree 建在 `f5c2e91`（Initial commit）上。开工前做了这些准备：

- `git merge --ff-only main` 快进到 `main@e73e920`；
- 在干净状态下执行 `git rm -r --cached -q . && git reset --hard -q`，没有产生改动；
- `pnpm install --frozen-lockfile`；
- 真机冒烟前 `node node_modules/electron/install.js`，从本机缓存解压 Electron，没有联网。

相对 `e73e920` 共 7 个改动提交，涉及 28 个文件（+1187 / −188），另有本总结的 `docs(wave3)` 提交。
每个提交都带 `Co-Authored-By: Claude Opus 5.5`，未 push、未建 PR。写总结时 `main` 仍是 `e73e920`，`git merge-tree --write-tree main HEAD` 无冲突。

有 4 个范围外的测试文件各改了一个词，这是加 `max` 之后必须跟着改的，见「未做 / 越界项」第 1 条。
另有一处受范围限制，没能做完整，写在下面的 BLOCKED 里。

## BLOCKED（只涉及拉取面板的推理徽标，其余都已完成）

任务书写「`RemoteModelsPicker.tsx`（推理徽标改为经 describe-models）」，范围里只有这个组件和 `stores/providers.ts`。

**已做到的**：徽标先查 `sessions:model-options` 里已经描述过的档位，这一部分走的就是 describe-models。

- 本服务存过的模型，用本服务的结果；
- 别的同协议服务存过、来源是 catalog 或 inferred 的，也借来用；
- 悬停写明档位与来源。
- 真机上 Codex 中转拉到的 13 个模型都已保存，13 个都按 describe-models 标了徽标（见「怎么验证」第 3 节）。

**做不到的**：还没存进任何可用服务的模型（拉取面板主要就是用来发现这类模型），拿不到 describe-models 的结果，只能退回 Main 按设置页内置目录给的 `reasoning`。

- **原因**：Renderer 能用的只有 `sessions:model-options`，它只描述已保存的模型，入参也严格收窄为 `{ workspaceId? }`。
- 要描述任意 id，必须改范围外的文件。

**需要你决定**是否开后续卡。最小改法（Task 20 总结里也提过）：

- `AgentHostService` 暴露已有的 `describeModels(queries)`；
- `ipc/providers.ts` 在 `listRemoteModels` 拿到列表后，以 `{ api, modelId }` 问一次：有档位的标 `reasoning: true`，并把 `source` 带给 Renderer；
- 也可以新开一个 `providers:describe-models` 通道（ipc.ts / handler / preload 三件事）。

Renderer 这边已经有 `describedThinking` 与带来源的徽标提示，接上即可。

## 第 1 条：pi 1.4.0 目录给出的等级

临时脚本 `catalog.mjs`（不提交）用 worker 同一种方式建 `ModelRuntime`（不联网），对每个条目跑 `getSupportedThinkingLevels` 与 `clampThinkingLevel(model, 'medium')`。
官方 provider（anthropic / openai / google）的条目如下，worker 取的就是官方条目：

| 模型 | 官方条目的档位 | 默认 | thinkingLevelMap |
|---|---|---|---|
| claude-fable-5-1 | minimal / low / medium / high / xhigh / **max** | medium | `{"off":null,"xhigh":"xhigh","max":"max"}` |
| claude-opus-5-5 | low / medium / high / xhigh / **max** | medium | off、minimal 为 null，xhigh / max 显式映射 |
| claude-sonnet-5-5 | low / medium / high / xhigh / **max** | medium | 同 opus 5.5 |
| claude-opus-4-8 | off / minimal / low / medium / high / xhigh / **max** | medium | `{"xhigh":"xhigh","max":"max"}` |
| claude-sonnet-4-6 | off / minimal / low / medium / high / **max**（没有 xhigh） | medium | `{"max":"max"}` |
| gpt-5.5 | off / low / medium / high / xhigh（max 为 null） | medium | off → `"none"`，minimal、max 为 null |
| gpt-5.6 | **目录里没有**（只有 gpt-5.6-luna / -sol / -terra，都是 off…max）→ 按推断 | — | — |
| gpt-6-astra | low / medium / high / xhigh / **max** | medium | off、minimal 为 null |
| gpt-6-sol | off / low / medium / high / xhigh / **max** | medium | off → `"none"`，minimal 为 null |
| gemini-3.1-pro | 官方 google 没有这个 id（官方是 gemini-3.1-pro-preview），只有 opencode 条目：low / medium / high | medium | xhigh / max 为 null |

脚本原始输出（只截掉每行的 `reasoning=true`）：

```
pi-ai 1.4.0; catalog models: 1599
claude-fable-5-1:
  anthropic (official) · anthropic-messages · levels=[minimal, low, medium, high, xhigh, max] · default=medium · map={"off":null,"xhigh":"xhigh","max":"max"}
  cloudflare-ai-gateway · anthropic-messages · levels=[minimal, low, medium, high, xhigh, max] · default=medium · map={"off":null,"xhigh":"xhigh","max":"max"}
  opencode · anthropic-messages · levels=[minimal, low, medium, high, xhigh, max] · default=medium · map={"off":null,"xhigh":"xhigh","max":"max"}
  radius · pi-messages · levels=[minimal, low, medium, high, xhigh, max] · default=medium · map={"off":null,"xhigh":"xhigh","max":"max"}
claude-opus-5-5:
  anthropic (official) · anthropic-messages · levels=[low, medium, high, xhigh, max] · default=medium · map={"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}
  cloudflare-ai-gateway · anthropic-messages · levels=[off, minimal, low, medium, high, xhigh, max] · default=medium · map={"xhigh":"xhigh","max":"max"}
  opencode · anthropic-messages · levels=[off, minimal, low, medium, high, xhigh, max] · default=medium · map={"xhigh":"xhigh","max":"max"}
  radius · pi-messages · levels=[low, medium, high, xhigh, max] · default=medium · map={"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}
claude-sonnet-5-5:
  anthropic (official) · anthropic-messages · levels=[low, medium, high, xhigh, max] · default=medium · map={"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}
  cloudflare-ai-gateway · anthropic-messages · levels=[off, minimal, low, medium, high, xhigh, max] · default=medium · map={"xhigh":"xhigh","max":"max"}
  opencode · anthropic-messages · levels=[off, minimal, low, medium, high, xhigh, max] · default=medium · map={"xhigh":"xhigh","max":"max"}
  radius · pi-messages · levels=[low, medium, high, xhigh, max] · default=medium · map={"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}
claude-opus-4-8:
  anthropic (official) · anthropic-messages · levels=[off, minimal, low, medium, high, xhigh, max] · default=medium · map={"xhigh":"xhigh","max":"max"}
  cloudflare-ai-gateway · anthropic-messages · levels=[off, minimal, low, medium, high, xhigh, max] · default=medium · map={"xhigh":"xhigh","max":"max"}
  opencode · anthropic-messages · levels=[off, minimal, low, medium, high, xhigh, max] · default=medium · map={"xhigh":"xhigh","max":"max"}
  radius · pi-messages · levels=[off, minimal, low, medium, high, xhigh, max] · default=medium · map={"xhigh":"xhigh","max":"max"}
claude-sonnet-4-6:
  anthropic (official) · anthropic-messages · levels=[off, minimal, low, medium, high, max] · default=medium · map={"max":"max"}
  cloudflare-ai-gateway · anthropic-messages · levels=[off, minimal, low, medium, high, max] · default=medium · map={"max":"max"}
  opencode · anthropic-messages · levels=[off, minimal, low, medium, high, max] · default=medium · map={"max":"max"}
gpt-5.5:
  azure · azure-openai-responses · levels=[minimal, low, medium, high, xhigh] · default=medium · map={"off":null,"xhigh":"xhigh"}
  cloudflare-ai-gateway · openai-responses · levels=[low, medium, high, xhigh] · default=medium · map={"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":null}
  openai (official) · openai-responses · levels=[off, low, medium, high, xhigh] · default=medium · map={"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":null}
  opencode · openai-responses · levels=[low, medium, high, xhigh] · default=medium · map={"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":null}
  radius · pi-messages · levels=[off, low, medium, high, xhigh] · default=medium · map={"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":null}
gpt-5.6: NOT IN CATALOG
gpt-6-astra:
  azure · azure-openai-responses · levels=[low, medium, high, xhigh, max] · default=medium · map={"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}
  cloudflare-ai-gateway · openai-responses · levels=[low, medium, high, xhigh, max] · default=medium · map={"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}
  github-copilot · openai-responses · levels=[low, medium, high, xhigh, max] · default=medium · map={"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}
  openai (official) · openai-responses · levels=[low, medium, high, xhigh, max] · default=medium · map={"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}
  openai-codex · openai-codex-responses · levels=[minimal, low, medium, high, xhigh, max] · default=medium · map={"off":null,"minimal":"low","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}
  opencode · openai-responses · levels=[low, medium, high, xhigh, max] · default=medium · map={"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}
  radius · pi-messages · levels=[low, medium, high, xhigh, max] · default=medium · map={"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}
gpt-6-sol:
  azure · azure-openai-responses · levels=[off, low, medium, high, xhigh, max] · default=medium · map={"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}
  cloudflare-ai-gateway · openai-responses · levels=[off, low, medium, high, xhigh, max] · default=medium · map={"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}
  github-copilot · openai-responses · levels=[off, low, medium, high, xhigh, max] · default=medium · map={"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}
  openai (official) · openai-responses · levels=[off, low, medium, high, xhigh, max] · default=medium · map={"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}
  openai-codex · openai-codex-responses · levels=[off, minimal, low, medium, high, xhigh, max] · default=medium · map={"off":"none","minimal":"low","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}
  opencode · openai-responses · levels=[off, low, medium, high, xhigh, max] · default=medium · map={"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}
  radius · pi-messages · levels=[off, low, medium, high, xhigh, max] · default=medium · map={"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}
gemini-3.1-pro:
  opencode · google-generative-ai · levels=[low, medium, high] · default=medium · map={"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":null,"max":null}
```

与任务书的预期对照：

- Claude Code 里的 Fable 是 low…max：pi 目录给 fable 5.1 的是 **minimal** / low / medium / high / xhigh / max，多一个 minimal（目录只把 off 映射为 null）。我按 pi 目录实现。
- 用户截图里 `gpt-5.6-sol` 显示「关闭 / 低 / 中 / 高 / 最高」，原因是原来的 `filter(isThinkingLevel)` 丢掉了 max。gpt-5.6-sol 本身在官方目录里，不需要推断，现在是 off…max。

## 做了什么

| 提交 | 内容 |
|---|---|
| `2a010fc` feat(core) | `ThinkingLevel` 加 `'max'`，与 pi 同一组、同一顺序；`normalizeThinkingLevel`：`none` 归一为 `off`，`isThinkingLevel` 仍只认档位本身。连带：档位文字表补 max；5 个测试文件里把 `'max'` 当「未知档位」的样例换成 `'ultra'` |
| `e91388e` test(agent) | `createRoleSession` 原样把档位交给 pi：max 透传（会话的、角色的），模型没有 max 时由 pi clamp（这里不过滤） |
| `6cb0370` feat(shared) | `ModelThinkingCapability.source`（`catalog` / `inferred:<id>` / `fallback`）、`isThinkingSource`、`thinkingSourceNote`；官方等级名 `THINKING_LEVEL_LABELS` 与中文说明 `THINKING_LEVEL_HINTS`；`pickThinkingLevel` 没有可用默认档位时取中间一档；协议 parser 接受 max、`none` → `off`、校验 source |
| `23d6b39` feat(agent) | `models.ts`：describe 不再丢 max；目录外变体按「同协议 + 规整后最长公共 id 前缀」推断；推断不出时按协议兜底；describe 与 resolve 用同一份定义 |
| `21336bf` test(agent) | 切到 max：假 pi 会话收到 `setThinkingLevel('max')`；真实 pi 会话下一次请求的 reasoning 是 max，jsonl 记下 max |
| `4fe8622` feat(renderer) | 选择器、新建弹层、状态栏、角色编辑器统一显示官方等级名，悬停显示中文说明；档位旁的小字「按 <id> 推断」/「目录里没有这个模型，按协议兜底」 |
| `8c5d49c` feat(renderer) | 拉取面板的「推理」徽标先看 describe-models 描述过的档位（见 BLOCKED） |

### 1. 档位的权威来源与 max

- worker 的 `describe` 直接用 pi 的 `getSupportedThinkingLevels`（含 max），默认档位是 `clampThinkingLevel(model, 'medium')`。
- pi 的 `ModelThinkingLevel` 与 fynvra 的 `ThinkingLevel` 现在是同一组，`capabilityOf` 里直接赋值；以后 pi 增减档位时这里会编译失败。
- **max 一路透传**：
  - Renderer 选 max → `sessions:set-model` / `create`：Main 的收窄用 `isThinkingLevel`，自动接受 max；
  - worker `resolve` 按 `pickThinkingLevel` 落定 → `piSession.setModel` 调 pi `setThinkingLevel('max')`；spawn 时经 `createRoleSession` 交给 `createAgentSession`；
  - Claude 模型的 max 靠目录里的 `compat.forceAdaptiveThinking` 才会作为 effort 发出去，所以推断出来的模型也照搬兼容开关（见第 2 节）。
- **切模型时目标没有当前档位**：回落到它的默认档位，例如 fable 的 max 切到 gpt-5.5，结果是 medium，不是就近的 xhigh。renderer `chooseModel` 与 worker `resolve` 都有用例。
- **`pickThinkingLevel` 的一处改动**：模型没有可用的默认档位时，原来取最低档，现在取列表中间一档（偶数个取偏低的）。任务书写的是「pi 默认或列表中间值」。实际上 worker 给的能力总带默认档位，这一支只兜极端情况。

### 2. 目录外模型的推断（`src/agent/models.ts`）

顺序：目录里同协议同 id（官方 provider 优先）→ `catalog`；否则推断 → `inferred:<目录里的 id>`；都不行 → `fallback`。

- **规整**（两边的 id 都规整，`normalizeModelId`）：
  - 小写；
  - 去掉 `[…]`（Claude Code 的 `[1m]`）；
  - 反复去掉 `-latest`、`-preview` 与日期后缀：YYYYMMDD、MM-YYYY（Google 的 `-04-2026`）、MM-DD、四位数（如 `-0528`）。
  - YYYY-MM-DD 没有单列：先按 MM-DD 去掉，剩下的四位年份下一轮再去掉。变异测试发现单列的那一支是冗余的，已删掉。
- **匹配**（`findClosestModel`）：按段比较，`-` 与 `.` 都分段，`-sol` / `-astra` 这样的变体整段比较，不按字符比。
  - 规整后相同的最近；
  - 否则从完整 id 起逐段退让：gpt-6.2-sol → gpt-6.2 → gpt-6，取第一个有目录模型以它开头的前缀；
  - **至少共享两段**：只共享 gpt / claude 这样的家族名不算接近。
- **同一前缀下的挑法**：
  1. 官方 provider 优先；
  2. 下一段的版本号最近：claude-opus-4-0 取 4-5（老一代，没有 xhigh / max），而不是 4-8；
  3. 多出来的段最少；
  4. 版本最新（自然序最大）；
  5. id 较短的优先，别名先于带日期的版本。
- **推断出的模型**：
  - 照搬目录模型的能力：档位映射、兼容开关（如 `forceAdaptiveThinking`）、上下文、价格、输入类型；
  - 请求里用的 id 和名字仍是设置里的（如 `claude-opus-4-8[1m]`）；
  - 是否推理看目录模型，不看设置里的标记，与目录模型的规则一致。
- **只在同一个 api 里找**：`openai-completions` 的 gpt-6.1-sol 不借 `openai-responses` 条目的档位。原因是兼容开关按 api 区分（`OpenAICompletionsCompat` 与 `OpenAIResponsesCompat` 不同）。

实测（真实 pi 目录，用例里钉住）：

| 设置里的 id | 结果 |
|---|---|
| `Claude-Fable-5-1` | inferred:claude-fable-5-1 |
| `claude-opus-4-8[1m]` | inferred:claude-opus-4-8（off…max） |
| `claude-opus-5-5-20261001` | inferred:claude-opus-5-5 |
| `gpt-5.6-sol-2026-09-01` | inferred:gpt-5.6-sol |
| `claude-haiku-5-5-latest` | inferred:claude-haiku-5-5 |
| `gemini-3.1-pro-preview-06-2026` | inferred:gemini-3.1-pro-preview |
| `gpt-5.6` | inferred:gpt-5.6-terra（三个 5.6 变体档位相同） |
| `gpt-6.2-sol` | inferred:gpt-6.1-sol |
| `claude-opus-4-9` / `-4-0` | inferred:claude-opus-4-8 / inferred:claude-opus-4-5 |
| `gpt-4o-2024-12-17` | inferred:gpt-4o，不推理，没有档位 |
| `gpt-7-sol`、`gpt-oss-120b`（openai-responses） | 只共享 `gpt` → fallback |

### 3. 按协议兜底（`fallback`）

只对设置里标了推理（`reasoning: true`）的模型给档位，没标的仍不显示档位。

| 协议 | 兜底档位 | 来源 |
|---|---|---|
| anthropic-messages | low / medium / high / xhigh / max | pi 目录里 `claude-opus-5-5`（当前一代 Claude）的映射，读目录，不写死 |
| openai-responses / openai-completions | low / medium / high / xhigh | 固定映射 |
| google-generative-ai | low / medium / high | 官方目录里版本号最大的推理 Gemini（当前是 `gemini-4-argon`）的映射 |
| 其他 | off / minimal / low / medium / high | pi 对「推理、没有映射」的默认集合，与原来相同 |

兜底模型用保守上限（128k / 32k），不带任何兼容开关。Anthropic 兜底的模型因此走 budget 思考，不走 adaptive effort，更适合 Anthropic 协议的非 Claude 模型。

### 4. 来源字段的通路

- worker `describe` → `models-described`（parser 校验 `source`）→ Main agentHost 原样展开进 `sessions:model-options` 的每个模型（**没改 agentHost**）→ Renderer。
- 缓存键仍是（协议, id, `reasoning === true`）。worker 的回答也只取决于这三项：标记为 false 与缺省等价，所以缓存不会给错。

### 5. 界面

- **显示名**：`off · 关闭` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`，不再用「低 / 中 / 高 / 最高」。
  - 胶囊与状态栏写等级名本身：off 不附中文，免得和用「·」分隔的字段混在一起。
  - 中文说明都放在悬停提示里：档位单选、角色编辑器的选项与触发器、胶囊、状态栏。
- **档位控件只渲染返回的数组**：`thinkingChoices(levels)` 只把模型自己的档位映射成控件项，顺序不变。模型选择器与角色编辑器共用它，有用例。
- **小字**：模型选择器底部、新建弹层的档位下面、角色编辑器档位的 hint，会写「按 <id> 推断」或「目录里没有这个模型，按协议兜底」。目录里有的模型不显示小字。

## 怎么验证

**基线**（`e73e920`）：typecheck exit 0；lint `Checked 372 files`；test `Test Files 124 passed / Tests 1703 passed`。

**验收命令**（最终改动提交 `8c5d49c`，根目录）：

```
pnpm typecheck → exit 0（node / web / packages 三段）
pnpm lint      → exit 0：Checked 372 files in 182ms. No fixes applied.
pnpm test      → exit 0：Test Files 124 passed (124)；Tests 1759 passed (1759)
pnpm build     → exit 0：out/main/index.js 329.74 kB、out/main/chunks/index-*.js 128.80 kB、
                 out/preload/index.cjs 12.84 kB、out/renderer/…（css 69.51 kB）
                 out/main/index.js 里 @earendil-works 出现 0 次（Main 仍不加载 pi）
```

28 个改动文件里没有 CRLF，也没有不可见字符。

### 1. 用例（+56 = 1759 − 1703）

| 文件 | 覆盖 |
|---|---|
| `packages/core/src/guards.test.ts` | 档位列表含 max；`normalizeThinkingLevel`：合法档位原样、`none` → `off`、大小写不同 / 未知 / 原型键为 undefined；`isThinkingLevel('none')` 为 false |
| `packages/core/src/roles/parseRole.test.ts` | 角色可以是 max；非法样例换成 `ultra` |
| `createRoleSession.test.ts` | max 透传（会话的、角色的）；模型没有 max 时 pi clamp 到 high |
| `src/shared/types/chat.test.ts` | `pickThinkingLevel` 含 max 的保留 / 回落，中间一档；官方等级名与中文说明；`isThinkingSource`；`thinkingSourceNote` |
| `src/shared/types/agent.test.ts` | set-model 带 max；spec 与能力里的 `none` 归一；能力带三种 source；非法 source、`none` 与 `off` 归一后重复都拒绝 |
| `src/agent/models.test.ts` | 真实 pi 目录：目录模型的完整档位（含 max）；**每条规整规则**各一条；退让与挑选规则；只共享家族名不算；不跨 api；推断不看标记；三种协议兜底与无标记；describe 与注册后 pi 接受的档位逐个相等（目录 / 推断 / 兜底 12 个）；推断模型注册为设置里的 id 并带目录的兼容开关；resolve 落定 max；`normalizeModelId` 13 条表驱动；`findClosestModel` 纯函数 4 条 |
| `src/agent/piSession*.test.ts` | 假会话收到 `setThinkingLevel('max')`；真实 pi 会话切到 max 后请求的 reasoning 是 max，jsonl 最后一条 thinking 是 max |
| `modelChoice.test.ts` | `thinkingChoices` 只渲染给的数组；胶囊文字是等级名；`chooseModel` 的 max 保留 / 回落；`describedThinking` 的借用规则 |
| `roleModel.test.ts` | 档位状态带来源（含推断的）；选项是官方等级名、默认档位带「（默认）」、带中文说明 |

**TDD 的实际顺序**：

- 先写测试并跑红，再实现：
  - core：5 红；
  - shared：12 红；
  - models：32 红；
  - renderer：8 红。
- 两处只补了用例，因为 max 在类型层面就能直接透传：`createRoleSession`、`piSession`。
  - core 改之前，`thinking: 'max'` 根本不能通过类型检查；
  - 为了确认用例不是空过，临时去掉 `piSession.ts` 里的 `setThinkingLevel` 一行，4 个用例失败，之后已恢复。

**变异测试**：脚本逐处改源码、跑对应测试、再恢复，37 处全部被抓到（survived 0）。

- `models.ts` 25 处：
  - 官方优先（精确与推断各 1）；
  - 挑选规则中的 3 条：版本号最近、段最少、别名优先；
  - 至少两段；
  - 规整规则 9 条；
  - `.` 分段；
  - 推断名用设置 id、推断不看标记、兜底只在标了推理时有档位；
  - 三种协议兜底；
  - describe 带来源、推断来源、兜底不带兼容开关。
- `chat.ts` 4 处、`agent.ts` 4 处、`describedThinking` 4 处。
- 第一轮有一处存活：去掉 YYYY-MM-DD 那一支后，MM-DD 加四位数两轮也能去掉它，说明这一支冗余，已删掉。

### 2. 真机（`pnpm dev`，第 6 条）

- **准备**：
  - 隔离 userData（`FYNVRA_USER_DATA_DIR`），登记一个临时 git 仓库；
  - 从本机 `%APPDATA%\fynvra-dev\providers.json` **只复制** Claude Code（anthropic-messages）与 Codex（openai-responses）两个中转；
  - 在副本里给 Claude Code 加了一个目录外变体 `claude-opus-4-8[1m]`。Codex 本来就有目录外的 `gpt-5.6`。
- **启动**：从 PowerShell 执行 `pnpm exec electron-vite dev --remoteDebuggingPort 9621 '--' <不节流开关>`。
- **驱动**：脚本在仓库外，经 CDP 点真实界面。结论来自 DOM、IPC 返回值和磁盘，不截图。
- **结果**：整轮 **17/17 通过**；角色编辑器另跑一轮，**7/7 通过**。
- 前 5 轮都停在建会话之前，原因都是脚本自己：
  - 就绪条件写成了要先选工作区才出现的按钮；
  - 下拉触发器显示的是「服务 · 模型」，脚本按全等比较；
  - 选项在列表可视区外；
  - 弹层打开后列表还在自动滚动。
  - 改为滚到可见、等坐标稳定、用 `elementFromPoint` 确认命中后再点。

**两个模型的档位列表**（新建会话弹层，DOM 中「思考档位」单选的文字）：

| 模型 | 界面上的档位 | 第 1 条目录输出 |
|---|---|---|
| Claude Code · `claude-fable-5-1` | minimal / low / medium / high / xhigh / max | minimal…max ✔ |
| Codex · `gpt-5.6-sol` | off · 关闭 / low / medium / high / xhigh / max | off…max ✔ |

两者不同，与目录一致。另外几项结果：

- **悬停提示**逐项是中文说明，例如 max 是「最大思考：不设上限，最慢、最费 token」。
- **目录外变体**：
  - `Opus 4.8 [1m]` 显示 off…max，下方小字「按 claude-opus-4-8 推断」；
  - `gpt-5.6` 显示 off…max，小字「按 gpt-5.6-terra 推断」。
- **选 fable、档位 max，创建会话**：
  - 记录是 `{claude-code, claude-fable-5-1, max}`；
  - 胶囊显示「Claude Code · Fable 5.1 · max」，悬停为「切换模型（思考档位 max：最大思考：不设上限，最慢、最费 token）」；
  - 状态栏显示「Fable 5.1 · max」。
- **max 发消息**：
  - 「请只回复一个词：苹果」→ 回复「苹果」（Claude Code 中转接受了 max）；
  - 模型选择器里 fable 的档位与目录一致，max 是选中状态；
  - 切到 gpt-5.6-sol 后 max 保留，因为它也有 max：胶囊「Codex · gpt-5.6-sol · max」，记录 `{codex, gpt-5.6-sol, max}`；
  - 再发「请只回复一个词：香蕉」→ 回复「香蕉」（Codex 中转接受了 max）。
- **pi jsonl**（9 行）：
  - 依次是 `model_change claude-fable-5-1`、`thinking_level_change max`、两轮问答、`model_change gpt-5.6-sol`；
  - 第一条回复的 api / model 是 `anthropic-messages / claude-fable-5-1`，第二条是 `openai-responses / gpt-5.6-sol`；
  - 切到 sol 时档位没变，所以 pi 没有再写一条 thinking 记录：pi 只在档位变化时追加。
- **worker 日志**：
  ```
  [agent] session d26338a8-…: anthropic-messages claude-fable-5-1 thinking=max → https://<host>/
  [agent] session d26338a8-…: openai-responses gpt-5.6-sol thinking=max → http://<host>/
  ```
- **`sessions:model-options`**：
  - fable：minimal…max，source catalog；
  - `claude-opus-4-8[1m]`：off…max，source `inferred:claude-opus-4-8`；
  - `gpt-5.6`：off…max，source `inferred:gpt-5.6-terra`；
  - `gpt-5.6-sol`：off…max，source catalog。
- **拉取面板**（编辑 Codex → 拉取模型列表）：
  - 13 行，全部已保存，全部按 describe-models 标徽标；
  - gpt-5.6-sol 是「思考档位（pi 目录）：off / low / medium / high / xhigh / max」；
  - gpt-5.6 是「思考档位（按 gpt-5.6-terra 推断）：…」；
  - codex-auto-review 与 gpt-image-* 不推理，没有徽标。
- **角色编辑器**（设置 → 角色 → 新建）：
  - 选 `Opus 4.8 [1m]`：档位下拉是 off · 关闭 / minimal / low / medium（默认）/ high / xhigh / max，每项悬停是中文说明，字段下方是「按 claude-opus-4-8 推断」；
  - 换 `gpt-5.6-sol`：没有小字，选项是它自己的 6 档；
  - 选 max 并保存，`roles.list` 与 `roles/<id>.json` 里都是 `{codex, gpt-5.6-sol, max}`。
- **key**：
  - Renderer 拿到的 list / model-options / history / providers.list 结果、整页 `outerHTML`、两份 dev 日志、两份报告与 jsonl 副本里，都没有任何 key（脚本只输出布尔值）；
  - 隔离 userData（含 providers.json 副本）已删除。
- **收尾**：
  - 两份 dev 日志都没有 error / warning，也没有出现 ResizeObserver 通知；
  - 两轮都经页面的 `window.close()` 关窗，dev 以 exit 0 退出，没有残留本 worktree 的 electron 进程。

## 未做 / 越界项

1. **范围外的 4 个测试文件，各改了一个词**：
   - 涉及 `src/main/ipc/sessions.test.ts`、`src/main/services/sessions/sessionStore.test.ts`、`src/shared/types/settings.test.ts`、`packages/core/src/roles/parseRole.test.ts`；
   - 它们把 `'max'` 当「fynvra 不认识的档位」做反例。任务要求加 max，这些断言必然失败，`pnpm test` 就不绿；
   - 只把样例换成 `'ultra'`，parseRole 另加一条接受 max 的用例；
   - 对应的生产代码没动：这几处收窄都用 `isThinkingLevel`，自动接受 max。
2. **`none` 别名只接进了范围内的 parser**（Main ⇄ worker 协议）：
   - `parseRole`、`sessionStore`、`ipc/sessions`、`settings` 的收窄仍是严格的 `isThinkingLevel`：接受 max，不接受 `none`；
   - 要让角色文件里的 `"thinking": "none"` 也能读，各改一行换成 `normalizeThinkingLevel` 即可（不在范围）。
3. **`docs/ARCHITECTURE.md` 没改**（不在范围）。契约有变化，建议回写：
   - §4 `ThinkingLevel` 加 `'max'`，注明「外部输入的 `none` 经 `normalizeThinkingLevel` 归一为 `off`」；
   - §9.2：
     - 「只留 fynvra 有的档位（pi 另有 max）」改为「含 max；目录外的按同协议最接近的目录模型推断，推断不出时设置里标了推理才按协议兜底」；
     - `ModelThinkingCapability` 加 `source?: 'catalog' | 'fallback' | \`inferred:${string}\``；
     - 列上 `THINKING_LEVEL_LABELS` / `THINKING_LEVEL_HINTS` / `thinkingSourceNote`；
   - §5 `ResolvedModel` 的注释里 `pickThinkingLevel` 补「没有默认档位时取中间一档」。
4. **拉取面板的徽标**：见开头 BLOCKED。
5. **范围内没改的文件**：无。
6. **知识库检索没做**：用户全局说明里的 `maestro spec` / `maestro wiki` 本机不可用，PATH 上没有 `maestro`，`~/.maestro/workflows/coding-philosophy.md` 也不存在（本次核对过）。

## 给验收人的注意事项

1. **在自己浏览器里看效果**：
   - 新建会话弹层里分别选 Claude Code 的 Fable 5.1 与 Codex 的 gpt-5.6-sol，档位列表不同，都有 max；
   - 悬停档位看中文说明；
   - 选 Codex 的 `gpt-5.6`，档位下方有「按 gpt-5.6-terra 推断」。
2. **行为变化 1：目录外、标了推理、又推断不出的 OpenAI 兼容模型**。
   - 例如自定义服务里的 `qwen3-coder-local`，档位从 off / minimal / low / medium / high 变为任务书规定的 low / medium / high / xhigh；
   - 这类模型因此不能关掉思考，选 xhigh 时会发 `reasoning_effort: "xhigh"`。有的 OpenAI 兼容服务只认 low / medium / high；
   - 如果要保留原来的集合，改 `OPENAI_FALLBACK_LEVELS`，或只对 `openai-responses` 兜底，都是一处改动。
3. **行为变化 2：推断出的模型照搬目录模型的上下文、价格和兼容开关**（原来是 128k / 32k、价格 0、没有兼容开关）。
   - 例如 `claude-opus-4-8[1m]` 变为 1M 上下文与 adaptive 思考，`gpt-5.6` 变为 272k；
   - 用量里会按官方价格显示费用，与目录里的模型一致。
4. **行为变化 3：服务弹窗里的推理开关**（Task 19 的 `reasoningControl`，不在范围）。
   - 没标推理、但推断为推理模型的条目，会显示为只读「推理」徽标，提示「由内置目录决定」；
   - 推断用的也是内置目录，判断本身没错，只是提示里没写「推断」。
5. **同 api 才推断**：`openai-completions` 的中转上的 gpt-* 不借 `openai-responses` 条目的档位。
   - 没标推理时没有档位，标了推理时走 OpenAI 兜底；
   - 想要完整档位，可以把这类中转的协议设为 OpenAI Responses。
6. **冒烟临时目录** `%TEMP%\fynvra-t21-s67122`：
   - 留着第 1 条的 `catalog.mjs` 与输出、`official.mjs`、推断原型 `infer-proto.mjs`、变异脚本 `mutate.py`；
   - `smoke/` 下有 `prepare.mjs`、`drive.mjs`、`role.mjs`、两份 dev 日志、`report.json` / `report-role.json`（地址已换成 `<host>`），以及 jsonl 副本（不含 key）；
   - userData 已删，整个目录可以删掉。
7. **首次 `pnpm dev` 前**需要 `node node_modules/electron/install.js`（本机缓存，不联网）。
