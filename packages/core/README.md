# @fynvra/core

Fynvra 的纯 TypeScript 领域库（docs/ARCHITECTURE.md §4）：角色、编排状态机与持久化、收件箱、git worktree 管理、任务书模板。

## 边界

- 不 import Electron，也不直接 import 任何 Node 内置模块：文件系统和命令执行都由调用方注入（`CoreFs`、`ExecFn`）。renderer 通过 alias 直接打包本包源码，这条边界由 `src/boundary.test.ts` 守着。
- 没有第三方运行时依赖；入参收窄是手写的。
- 公共 API 从 `src/index.ts` 导出，失败一律返回 `{ ok: false, error }`，不抛异常（`newId` 的非法前缀属于编程错误，会抛 `TypeError`）。

## 模块

| 路径                           | 内容                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `types.ts`                     | §4 全部类型，原样命名                                                                                        |
| `guards.ts`                    | 枚举成员列表与 `is*` 守卫（`isTaskStatus`、`isMessageType`…）                                                |
| `roles/`                       | `BUILTIN_ROLES`（`orchestrator` / `worker`）、`parseRole`、`RoleStore` + `JsonFileRoleStore`                 |
| `orchestration/transitions.ts` | `TASK_TRANSITIONS`、`canTransitionTask`、`applyTaskTransition`、`settleDispatch`                             |
| `orchestration/store.ts`       | `OrchestrationStore`、`InMemoryOrchestrationStore`（`persistTo` / `loadFrom`）、`parseOrchestrationSnapshot` |
| `orchestration/inbox.ts`       | `Inbox`：`post` / `peek` / `ack` / `waitFor`                                                                 |
| `orchestration/ids.ts`         | `newId(prefix)`                                                                                              |
| `git/GitWorktreeManager.ts`    | `create` / `status` / `diff` / `remove` / `prune` / `merge` / `deleteBranch`                                 |
| `briefs/renderBrief.ts`        | 五段任务书 + worker 契约                                                                                     |

## 在 Main 里接线

```ts
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ExecFn,
  GitWorktreeManager,
  Inbox,
  InMemoryOrchestrationStore,
  JsonFileRoleStore,
} from '@fynvra/core';

const userData = app.getPath('userData');

// node:fs/promises 本身满足 CoreFs
const roles = new JsonFileRoleStore({ fs, dir: join(userData, 'roles') });

const store = new InMemoryOrchestrationStore();
const statePath = join(userData, 'orchestration.json');
await store.loadFrom(statePath, fs); // 文件不存在时 { ok: true, found: false }
const inbox = new Inbox({ messages: store.messages }); // 消息随快照持久化
// 每次改完状态：await store.persistTo(statePath, fs)（原子写，按调用顺序串行）

// 非零退出码 resolve，进程起不来才 reject
const exec: ExecFn = (cmd, args, cwd) =>
  new Promise((resolve, reject) =>
    execFile(
      cmd,
      [...args],
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error && typeof error.code !== 'number'
          ? reject(error)
          : resolve({ code: error ? Number(error.code) : 0, stdout, stderr })
    )
  );
const worktrees = new GitWorktreeManager({ exec });
```

## 关键语义

**任务状态迁移**（`TASK_TRANSITIONS`）：`todo → in-progress → in-review → completed`；`in-review → in-progress`（`reject_work` 打回）；`in-progress | in-review → failed`、`failed → in-progress`（重试）；除终态外都可 `→ abandoned`。`completed`、`abandoned` 是终态。`store.tasks.update` 改 `status` 时同样按这张表校验。

**Dispatch**：同一任务同时最多一个未结算的 dispatch；`settleDispatch` / 结算后的 dispatch 不可再改。打回后在同一 worktree 上继续工作应新建一次 dispatch（新的权威尝试）。

**`reclaimableDispatches(runId)`**：返回仍需决定是否清理的已结算派发，其 worktree 仍登记在 `store.worktrees`，且该 worktree 上没有进行中的后续尝试；同一 worktree 只报最近一次。`cleanup_worktree` 完成后把 worktree 从表里删掉即可。

**Inbox**：消息在 `ack` 之前一直可见，`peek` / `waitFor` 都不消费；`waitFor` 已有匹配时立即返回最早一条，否则等到 `post`，超时返回 `null`，从不 reject。

**Worktree**：分支 `fynvra/<slug>`，目录 `<worktreesRoot>/<workspaceId>/<slug>`；slug 小写、`-` 分隔、≤ 40 字符（含冲突后缀 `-2`、`-3`…），纯中文等规整为空时用 `task`。同一个 manager 上并发 `create` 会排队，不会抢到同名分支。`diff` 是 `baseCommit...HEAD`（只含已提交内容，即合并会带进来的东西）。`merge` 在 `repoPath` 当前分支上 `git merge --no-ff --no-edit`，失败时收集 `--diff-filter=U` 冲突文件并 `merge --abort`。不解析 git 的提示文本，本地化的 git 也能用。

## 开发

本包是根 pnpm workspace 的成员，配置全部来自仓库根目录：依赖装在根锁文件里，TypeScript / Biome / Vitest 由根 `package.json` 提供；`tsconfig.json` 继承根配置，只多了 `include: ["src"]`；lint 和测试直接使用根目录的 `biome.json` 与 `vitest.config.ts`；行尾由根 `.gitattributes` 统一为 LF。

```bash
# 仓库根目录：安装依赖，并检查全部代码（包括本包）
pnpm install
pnpm typecheck && pnpm lint && pnpm test

# 只检查本包
pnpm -F @fynvra/core typecheck   # 也可以换成 lint / test
```

测试与源码同目录（`*.test.ts`）。文件读写测试用临时目录；`git/GitWorktreeManager.integration.test.ts` 用真实 git（没有 git 时跳过）。
