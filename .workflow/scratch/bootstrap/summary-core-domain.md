# Summary · Task 02 core-domain（`packages/core`，@fynvra/core）

分支 `LAIJiangFeng/core-domain`，共 20 个 `<type>(core): …` 提交（含本总结提交，均带 `Co-Authored-By: Claude Opus 5.5`），未 push、未建 PR。没有 BLOCKED 项。

## 做了什么

按 ARCHITECTURE §4 实现并从 `src/index.ts` 导出：

| 模块 | 内容 |
|---|---|
| `types.ts` | §4 全部类型，原样命名、原样字段 |
| `guards.ts` | 各枚举的成员列表 + `is*` 守卫（用穷举 `Record` 构造，§4 加成员而这里没加会编译失败） |
| `roles/builtin.ts` | `BUILTIN_ROLES`：`orchestrator`（`tools: 'orchestrator'`、`approvalMode: 'full'`，systemPrompt 写清 §6 循环：派活 → 监控 → 验收合并 / 打回 → 汇报，点名全部编排工具，「never implement anything yourself」）；`worker`（`all`、`auto-edits`、无 systemPrompt）。深度冻结，`getBuiltinRole` 给副本 |
| `roles/parseRole.ts` | `parseRole(unknown)` 不抛异常；只读自有属性、丢弃未知字段、`null` 视同缺省、id 列表缺省 `[]` 并去重；`tools` / `approvalMode` 必填（权限字段 fail-closed）；`isValidRoleId`（小写 slug ≤ 64，可安全做文件名） |
| `roles/JsonFileRoleStore.ts` | `RoleStore`（list / get / save / remove）+ `JsonFileRoleStore`：每个角色一个 `<dir>/<id>.json`，原子写；内置角色不可覆盖、不可删除；占用内置 id、id 与文件名不符、坏 JSON、读不了的文件跳过并经 `onInvalidFile` 报告；非法 id 不触达文件系统 |
| `fs.ts` | `CoreFs`：`node:fs/promises` 的子集，Main 可直接传 `fs/promises` |
| `orchestration/ids.ts` | `newId(prefix)`：`<prefix>_<时间><随机>`，`[a-z0-9_]`，按时间字典序 |
| `orchestration/transitions.ts` | `TASK_TRANSITIONS`、`canTransitionTask`、`applyTaskTransition`、`settleDispatch`（重复结算 / 非法 outcome → `{ ok: false }`） |
| `orchestration/store.ts` | `OrchestrationStore`（五张表的 CRUD + `listTasks` / `activeDispatch` / `reclaimableDispatches`）、`InMemoryOrchestrationStore`（`persistTo` 原子写且按调用顺序串行；`loadFrom` 全量校验后才替换）、`parseOrchestrationSnapshot` |
| `orchestration/inbox.ts` | `Inbox`：`post` / `peek(filter)` / `ack` / `waitFor(filter, timeoutMs)`（超时 `null`，不抛不消费） |
| `git/GitWorktreeManager.ts` | 注入 `exec` 的 `create` / `status` / `diff` / `remove` / `prune` / `merge` / `deleteBranch` + `normalizeSlug` |
| `briefs/renderBrief.ts` | 五段任务书 + 末段固定 worker 契约（提交改动、`report_done` 恰好一次、`ask_coordinator` 提问） |

另有 `README.md`（接线示例与关键语义）、`src/boundary.test.ts`（库源码只允许相对 import：无 electron、无 `node:*`、无第三方）。

### 任务书没写死、由我定下的语义（请验收时过目）

- **任务迁移表**：`todo → in-progress | abandoned`；`in-progress → in-review | failed | abandoned`；`in-review → completed | in-progress（打回）| failed | abandoned`；`failed → in-progress（重试）| abandoned`；`completed`、`abandoned` 终态。`store.tasks.update` 改 `status` 也按此表校验。
- **表级不变量**：同一任务最多一个未结算 dispatch；已结算 dispatch 不可再改；`settledAt` 与 `outcome` 同时出现。打回后继续工作应新建 dispatch（同一 worktree）。
- **`reclaimableDispatches(runId)`** 取 Orca 的「还欠一次清理决定」：已结算 + worktree 仍登记在 `store.worktrees` + 该 worktree 上没有进行中的后续尝试；每个 worktree 只报最近一次。`cleanup_worktree` 后从表里删掉 worktree 即消失。
- **Inbox** 以 `EntityTable<Message>` 为底（传 `store.messages` 即随快照持久化）；`post` / `ack` 也返回 `{ ok, … }`；`types: []` 不匹配任何消息。
- **GitWorktreeManager**：所有方法返回 `{ ok, … }` 从不抛；只看退出码和 `-z` / porcelain 输出，不解析 git 提示文本（中文 locale 的 git 也能用）。`create` 同实例串行（并发派发不会抢同名分支）；`worktree add` 失败时 git 已建出的分支会被删掉（实测目标目录非空时 git 先建分支再失败）。`diff` = `baseCommit...HEAD`（只含已提交内容，即合并会带进来的）+ 文件列表；`merge` 成功返回合并提交 sha；`remove` 默认不强删（`force` 可选），`deleteBranch` 默认 `-d`。ref 参数拒绝 `-` 开头，路径放在 `--` 之后。
- `newId` 前缀非法时抛 `TypeError`（编程错误），这是唯一会抛的公共 API。

## 怎么验证

在 `packages/core` 下执行任务书的检查命令（删掉 `node_modules` 后从头跑）：

```
pnpm install && pnpm typecheck && pnpm lint && pnpm test   → exit 0
+ @biomejs/biome 2.6.2 / @types/node 26.6.5 / typescript 7.0.2 / vitest 4.1.12
tsc --noEmit                         → 无输出
biome check --config-path=biome.json → Checked 32 files … No fixes applied.
vitest run                           → Test Files 13 passed (13) · Tests 200 passed (200)
```

`pnpm install` 后 `pnpm-lock.yaml` 无变化。另外做了：

- **全新克隆复现验收环境**：把本分支克隆到临时目录（本机 `core.autocrlf=true`），文件检出为 LF，上面整条命令 exit 0。
- **更严格的根 tsconfig 预演**：`tsc --lib ESNext,DOM,DOM.Iterable`（EnsoCode 根配置风格）、再加 `--noUncheckedIndexedAccess --exactOptionalPropertyTypes`，均 0 错误。
- **变异检查**：去掉 `persistTo` 的串行化 → 并发写测试失败（`expected 2 to be 1`）；去掉 `create` 的排队 → 真实 git 并发测试失败（两次都抢 `dup-2`）。两处测试确实守住了行为。
- **真实 git 集成测试** 11 个全部实际执行（未 skip）。

验收标准逐项对应的测试：

| 要求 | 测试 |
|---|---|
| 角色解析坏输入 | `roles/parseRole.test.ts` 「坏输入：%s」26 例 + 原型链字段、`isValidRoleId` |
| 内置角色保护 | `roles/JsonFileRoleStore.test.ts` 「内置角色不可覆盖、不可删除」、占用内置 id 的文件被忽略；`roles/builtin.test.ts` 深度冻结 |
| 状态非法迁移 | `orchestration/transitions.test.ts` 6×6 穷举 + 「非法迁移 … 返回错误而不是抛异常」、重复结算；`store.test.ts` 「tasks.update 改 status 必须符合迁移表」 |
| inbox 超时 | `orchestration/inbox.test.ts` 「超时返回 null 而不是抛异常，并清理等待者」「timeoutMs ≤ 0 或非数字时只检查一次」 |
| worktree 分支冲突后缀 | `git/GitWorktreeManager.test.ts` 「分支冲突时追加 -2、-3」「加后缀后 slug 仍不超过 40 字符」；集成测试「分支冲突追加 -2、-3；并发 create 不会抢到同一个名字」 |
| merge 冲突路径 | 单测「冲突：列出冲突文件并 merge --abort」（断言命令序列）；集成测试「merge 冲突：返回冲突文件，自动 abort，主仓库回到合并前」 |

各文件用例数：parseRole 33、GitWorktreeManager 39、store 31、transitions 16、internal/files 16、inbox 15、guards 13、GitWorktreeManager.integration 11、JsonFileRoleStore 10、builtin 6、renderBrief 5、ids 4、boundary 1。

TDD：每个模块都是先写测试、跑红（`Cannot find module` 或断言失败）再实现。两处例外如实说明：`internal/files.ts`（`joinPath` / `parentDir` / `writeFileAtomic`）是先写实现后补测试；真实 git 集成测试写在已被单测驱动的实现之后，作为对真实 git 的验证。自审中发现的两个 bug 都是先补失败测试再修：`create` 排队链被一次异常污染后所有后续调用都失败；单个角色文件不可读（EACCES）导致整个 `list()` reject。

## 未做 / 越界项

- **越界**：除本总结文件外无。所有改动都在 `packages/core/**`（`git diff --name-only main...HEAD` 已核对）。
- **分支基点**：worktree 建在 `f5c2e91`（Initial commit）上，`main` 的文档提交 `32bf977` 不在其中、任务书也读不到。开工前（尚无任何自有提交）把分支 `git merge --ff-only main` 快进到了 `32bf977`，没有改动 `main`。
- **未做（任务书未要求，留给 Wave 2 或后续卡片）**：`dependsOn` 的就绪判断 / 调度（Main 的 `dispatchTask` 需要自己检查前置任务是否 `completed`）；跨表引用校验（如 `task.runId` 是否存在）；`CoreFs` / `ExecFn` 的 Node 实现不放在 core（README 和 TSDoc 里有现成片段）；`remove` 对已删除的 worktree 不幂等（第二次调用返回错误）；`merge` 不校验 `repoPath` 当前检出的是不是期望的目标分支。

## 给验收人的注意事项

1. **本包的临时独立配置**（根配置由 Task 01 负责，合并时统一接线；README 末节有同样说明）：
   - `tsconfig.json` 独立（没有根配置可 `extends`），选项与 EnsoCode 根配置一致。
   - `biome.json` 是 `"root": false` 的嵌套配置，`lint` 脚本用 `--config-path=biome.json` 显式加载。实测：没有根配置时 Biome 不会自动采用 `root: false` 的嵌套配置（会退回默认的 tab / 双引号）；而如果写成默认的根配置，等根 `biome.json` 落地后从仓库根跑 `biome check` 会因配置错误退出（临时目录实测：`Biome exited because the configuration resulted in errors`）。根配置落地后可改成 `{ "root": false, "extends": "//" }` 并去掉 `--config-path`。
   - `pnpm-lock.yaml` 是在本包单独安装产生的；进入 pnpm workspace 后以根 lockfile 为准，可删。
   - devDependencies 与 EnsoCode 对齐：`typescript ^7.0.2`、`vitest ^4.1.11`、`@biomejs/biome ^2.5.10`、`@types/node ^26.2.0`（实际解析为 7.0.2 / 4.1.12 / 2.6.2 / 26.6.5）。
2. **`packages/core/.gitattributes`（`* text=auto eol=lf`）建议保留，或由根 `.gitattributes` 统一**：Biome 按 LF 检查，本机 `core.autocrlf=true` 检出的 CRLF 文件会让 `pnpm lint` 失败。根目录若不加同样规则，Task 01 / 03 的文件在新检出里也可能遇到同样问题。
3. Biome 2.6 会格式化 Markdown（段落后紧跟列表时会删掉中间空行），README 已按它调整。
4. **与 Task 03 的重叠需要定一个权威来源**：
   - orchestrator 提示词：本包 `ORCHESTRATOR_SYSTEM_PROMPT`（作为内置角色的 `systemPrompt`）与 agent-runtime 的 `orchestratorPrompt.ts` 都会描述 §6 循环，两者都追加到会话会重复。
   - worker 契约：`renderBrief` 末段与 agent-runtime 的 `WORKER_CONTRACT_PROMPT` 内容相近。
   - agent-runtime 的 `coreTypes.ts` 临时副本：本包 `types.ts` 与 §4 逐字一致，合并后可直接改为 `import type … from '@fynvra/core'`。
5. 根 `vitest.config.ts` 收录 `packages/*/src/**/*.test.ts` 后可直接跑本包测试：测试不依赖 cwd（边界测试用 `import.meta.url` 定位，文件 / git 测试都用临时目录），真实 git 测试在文件内用 `vi.setConfig` 放宽了超时。
