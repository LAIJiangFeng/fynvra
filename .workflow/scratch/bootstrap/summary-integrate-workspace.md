# Summary · Task 04 integrate-workspace（packages/* 接进根 pnpm workspace）

分支 `LAIJiangFeng/integrate-workspace`。worktree 建在 `f5c2e91`（Initial commit）上，看不到任务书。开工前（还没有任何提交）用 `git merge --ff-only main` 把分支快进到 `main@eb9a8d4`，`main` 本身没动。

相对 `eb9a8d4` 有 9 个改动提交，涉及 29 个文件，全部在任务书「范围」内；另有总结文件本身的 `docs(bootstrap)` 提交。每个提交都带 `Co-Authored-By: Claude Opus 5.5`。没有 BLOCKED 项。Biome 没有要求自动修复源码，所以没有 `style:` 提交。

## 做了什么

| 提交 | 内容 |
|---|---|
| `d48f30e` build: LF 行尾 | 根 `.gitattributes`：`* text=auto eol=lf`，另把 png/jpg/jpeg/gif/webp/ico/icns/woff/woff2/ttf 标为 binary；删掉两个包各自的 `.gitattributes`；`biome.json` 改回 `lineEnding: "lf"`。`git add --renormalize .` 没有产生变化，因为索引里本来就全是 LF。随后在工作区干净的状态下执行 `git rm -r --cached . && git reset --hard`，把本 worktree 里 75 个 CRLF 文件重写为 LF |
| `027d942` build(biome) | **删除**两个包的 `biome.json`，而不是改成 `extends: "//"`。在包目录里运行 Biome 也会向上找到根配置，`packages/**` 的 Electron 禁令照样生效（探针验证，见下）。core 的 `lint` / `lint:fix` 去掉了 `--config-path`。根配置新增一条 override：`packages/agent-runtime/**` 关闭 `noExplicitAny`（理由见注意事项 3）。根配置排除 `*.md` / `*.yaml` 的设置保持不变 |
| `418f318` build(deps) | 删掉两个包的 `pnpm-lock.yaml`，以及它们的 devDependencies（typescript / vitest / @biomejs/biome / @types/node），统一由根提供。pi 三件套钉在 1.4.0，留在 agent-runtime 的 `dependencies`。`pnpm-workspace.yaml` 的 `allowBuilds` 把 `@google/genai`、`protobufjs` 设为 `false` 并写了注释。根 `engines.node` 从 `>=22.12.0` 提高到 `>=22.19.0`，因为 pi 1.4.0 的三个包都声明了 `>=22.19.0`，而根现在要安装并测试 pi。`@fynvra/*` 没有进根 `dependencies` |
| `7267312` build(tsconfig) | 两个包的 `tsconfig.json` 只剩 `extends: "../../tsconfig.json"`、`noEmit: true`、`include: ["src"]`。根新增 `typecheck:packages` 脚本（`tsc --noEmit -p packages/core && tsc --noEmit -p packages/agent-runtime`），接进 `typecheck` |
| `0711d59` test | 删除两个包的 `vitest.config.ts`。Vitest 4 会从包目录向上查找配置（读过 `createVitest` 的源码，也用 `DEBUG=vite:config` 看到 `configFile` 指向根配置）。所以 `pnpm -F <包> test` 用的是根配置，root 设为包目录，仍然只跑本包的测试 |
| `d9479bb` chore | 删除两个包的 `.gitignore`。其中的 `node_modules/`、`coverage/`、`*.tsbuildinfo` 都已被根 `.gitignore` 覆盖，`git check-ignore -v` 确认这几条都命中根文件 |
| `250bb87` refactor(agent-runtime) | 6 个 import 方（`host.ts`、`orchestratorPrompt.ts`、`createRoleSession.ts`、`orchestrationTools.ts` 及两个测试）改为 `import type … from '@fynvra/core'`，位置按 Biome 的 import 排序放好；删除 `coreTypes.ts`。agent-runtime 新增依赖 `"@fynvra/core": "workspace:*"`，锁文件里是 `link:../core` |
| `58e538c` docs(core, agent-runtime) | 两个 README 里「临时独立配置」和「包内 install」的段落改写为现状：根 workspace，加上用 `pnpm -F` 只检查单个包的命令。agent-runtime 模块表删掉了 `coreTypes.ts` 这一行 |
| `fdfcc8b` docs(architecture) | §5 回写 agent-runtime 总结「注意事项 1」的五项，见下 |

### typecheck：选 `-p`，没选 `tsc -b`

两个包只有源码，入口就是 `.ts` 文件，由 Vite alias 打进产物，没有任何东西需要 emit。

- 选 `tsc -b` 的话，每个被引用的项目都得设 `composite`。这会强制产出声明文件和 `.tsbuildinfo`，还要配 outDir 和构建顺序。agent-runtime 也会改为对着 core 产出的 `.d.ts` 做检查，而不是对着源码。
- 选 `-p`，每个包是一个独立的程序，通过根配置的 `paths` 直接解析到源码。写法也和现有的 `typecheck:node`、`typecheck:web` 一样。

### 依赖与锁文件

- agent-runtime 原锁文件里有 220 个包，和根锁文件逐个对比：除下面三个外，都在根锁文件里，版本相同。
  - `@types/node` 26.6.5 和 `undici-types` 8.9.0 不再使用，改用根的 `@types/node` 24.19.2，与 Electron 45 内置的 Node 对齐；
  - `safe-buffer` 从 5.2.1 去重为根锁文件已有的 5.1.2，影响 `@google/genai` 下的 jws / jwa 依赖链。
- 根锁文件原有的 453 个包全部保留，版本不变。
- `allowBuilds: false` 的依据（实际看过包内容）：
  - 两个包都是 pi-ai 的传递依赖，路径是 `pi-ai → @google/genai → protobufjs`；
  - `@google/genai@2.21.0` 的 `preinstall` 只是 `echo 'preinstall: no-op'`；它的 `prepare` 不会对 registry 包执行，`scripts/prepare.js` 也不在发布的包里；
  - `protobufjs@7.6.6` 的 `postinstall` 只检查「依赖方」package.json 里的版本前缀并打印提示，不产出任何文件（内容与 EnsoCode 用的 7.6.5 逐字相同）。

### §5 回写

- `createRoleSession(opts: CreateRoleSessionOptions): Promise<RoleSession>`，签名写成 ts 代码块。新增参数：
  - `agentDir`（必填）；
  - `workerHost?`（有它就是 worker 会话）；
  - `workerTools?`；
  - `roles?`；
  - `settingsManager?`（默认是内存设置，且 `enableInstallTelemetry: false`）；
  - `exec?`；
  - `onExtensionError?`。

  返回值为 `{ session, warnings, dispose(): Promise<void> }`。
- `ResolvedModel = { runtime: ModelRuntime; model: Model<Api>; thinking?: ThinkingLevel }`。
- `McpServerConfig = PiMcpServerConfig & { name: string }`：pi 的配置不带名字，未声明 exposure 时默认 `'direct'`。
- `report_done`：每轮只能成功调用一次，新的 agent run 开始时重新开放。因此 Main 要把 `reject_work` 的 feedback 作为新 prompt 发给 worker。
- `readonly` 策略同样是 `noTools: 'builtin'`，工具为只读工具加 `git_readonly`。
- 原文写的是「`'all'` → pi 默认工具 + worker 工具」，实际上 worker 工具跟着 `workerHost` 走，与工具策略无关。这里改成 `'all'` → pi 默认工具，另起一条说明 worker 工具的规则。这一处属于 `workerHost?` 参数语义的一部分。
- 注意事项 1 里的另外两条（`depends_on` 接收 task id；Host 入参 / 出参以 `host.ts` 为准）不在任务书列出的五项里，没有写入。

## 怎么验证

**基线**（本卡之前的 `main@eb9a8d4`，根目录）：

| 命令 | 结果 |
|---|---|
| `pnpm install` | 警告 `Ignored build scripts: @google/genai, protobufjs` |
| `pnpm typecheck` | 通过，但只覆盖 app |
| `pnpm lint` | 直接退出：`Found a nested root configuration`，原因是 agent-runtime 的 `biome.json` |
| `pnpm test` | 31 个文件，406 个用例，全部通过 |

**验收命令**：删除 `node_modules`、`packages/*/node_modules`、`out` 之后，从零执行：

```
pnpm install    → exit 0（12.3s）：Lockfile is up to date, resolution step is skipped；Packages: +474；没有任何警告
pnpm typecheck  → exit 0（node / web / packages 三段）
pnpm lint       → exit 0：Checked 111 files … No fixes applied.（0 error / 0 warning）
pnpm test       → exit 0：Test Files 31 passed (31)；Tests 406 passed (406)
pnpm build      → exit 0：out/main/index.js、out/preload/index.cjs、out/renderer/index.html + assets
```

- **用例拆分**（vitest JSON reporter）：
  - app（`src/`）：10 个文件 / 84 个用例；
  - core：13 / 200；
  - agent-runtime：8 / 122；
  - 状态统计：passed 406，pending 0，todo 0，failed 0。真实 git 集成测试 `GitWorktreeManager.integration.test.ts` 的 11 个用例全部实际执行并通过，没有被 skip。
- **工作区状态**：
  - `git status` 干净；
  - `git ls-files --eol | grep -v 'i/lf'` 只剩 `resources/icon.png`（`i/-text`）；
  - 文本文件全部是 `w/lf`：验收时 132 个，加上本总结共 133 个；用 `file` 扫描没有 CRLF。
- **无残留**：`packages/*/{pnpm-lock.yaml,biome.json,.gitattributes,.gitignore,vitest.config.ts}` 和 `coreTypes.ts` 都不存在。
- **锁文件稳定**：`pnpm install --frozen-lockfile` 通过；再执行一次 `pnpm install` 是 no-op，锁文件不变。
- **包级脚本**：`pnpm -F @fynvra/core typecheck|lint|test` 和 `pnpm -F @fynvra/agent-runtime typecheck|lint|test` 全部 exit 0（分别 200 和 122 个用例）。tsc / biome / vitest 都取自根目录的 `node_modules/.bin`，包里已经没有这些依赖。
- **探针**（临时文件，均已删除）：
  - 在 `packages/core/src` 里 `import 'electron'`：无论从根目录还是包目录运行 lint，都报 `packages/* 不得 import Electron`；
  - 在 `packages/core/src` 里写一个未使用的局部变量：`tsc -p packages/core` 报 TS6133，说明根配置的 `noUnusedLocals` 已对包生效。
- **全新克隆**（本机 system 级 `core.autocrlf=true`）：
  - 克隆本分支到临时目录，文件全部检出为 LF；
  - `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck` 通过，`git status` 干净。
- **模拟验收合并**：
  - 把 `main@ef92bfb` 克隆出来（CRLF 检出），再 `git merge --no-ff` 本分支：没有冲突。`docs/ARCHITECTURE.md` 自动合并，本卡改的是 §5，main 新增的是 §9；
  - 合并后不刷新，`pnpm lint` 报 54 个错误；
  - 按注意事项 1 刷新后，lint、typecheck、test（406 个用例）全部通过。

## 未做 / 越界项

- 没有越界修改文件。
- `packages/agent-runtime/src/index.ts` 第 2 行的注释还写着「coreTypes.ts 只是 Task 02 合并前的临时副本，不从这里导出」。文件已经删了，这句注释过时了。但 index.ts 不是 `coreTypes.ts` 的 import 方，不在本卡范围内，所以没改。建议删掉后半句。
- core-domain 总结注意事项 4 的前两项不在本卡范围，仍然没有统一：
  - core 内置 orchestrator 角色的 `systemPrompt`（`ORCHESTRATOR_SYSTEM_PROMPT`）和 agent-runtime 的 `ORCHESTRATOR_PROMPT` 都会经 `buildRolePromptAppend` 追加进会话，§6 的工作循环会描述两遍；
  - `renderBrief` 的 worker 契约段和 `WORKER_CONTRACT_PROMPT` 内容相近，也是重复。
- 根 `tsconfig.json` 的 references 没有加入两个包。编辑器打开包内文件时，会直接使用最近的 `packages/*/tsconfig.json`。
- agent-runtime 的 `engines`（`>=22.19.0`）保留未动，根也已经对齐到这个版本。
- 没有跑 `pnpm dev`：任务不要求，`pnpm build` 已通过。

## 给验收人的注意事项

1. **合并后必须刷新一次工作区的行尾**（已实测）。
   - 原因：`D:\project\fynvra` 是在没有 `.gitattributes` 时检出的，文件是 CRLF。merge 只会重写本分支改过的文件，其余文件（模拟里是 75 个）仍是 CRLF，而 `git status` 显示干净。Biome 现在要求 LF，所以 `pnpm lint` 会报格式错误。
   - 做法：在工作区干净时执行：

     ```bash
     git rm -r --cached -q . && git reset --hard -q
     git ls-files --eol | grep -c 'w/crlf'   # 应输出 0
     ```

   - 写本总结时，`orca worktree list` 里只有 main 和本卡，Wave 2 的 worktree 还没有开。建议合并本卡并刷新 main 之后再开。
     - 全新检出会按 `.gitattributes` 写出 LF（克隆实测）。
     - 如果 worktree 照旧停在 `f5c2e91`，再用 `--ff-only` 快进（实测）：快进新写出的文件都是 LF，只有 `f5c2e91` 里已有且内容没变的 `LICENSE`、`README.md` 留在 CRLF。Biome 不检查这两个文件，lint 不受影响；要完全干净，按上面的命令刷新一次即可。
2. **如果 Wave 2 在本卡合并之前开工**：
   - 它们基于 `main@ef92bfb`，不含本卡，根 `pnpm lint` 会因为 agent-runtime 的嵌套根配置直接退出（基线实测）。这些卡的任务书都写了「不要动 `packages/**`」，不太会去改包的配置，但总结里会报 lint 失败。
   - **`pnpm-lock.yaml` 大概率冲突**：
     - 在那些 worktree 里跑根 `pnpm install`，会把两个包（连同它们当时的 devDependencies）写进根锁文件的 importers，本卡的基线实测是 +1056 行。本卡也重写了同一段，几张卡还会各自加依赖。
     - 冲突时不要手工合并：先取 main 的版本，在根目录执行 `pnpm install` 重新生成，确认 `pnpm install --frozen-lockfile` 通过后再提交。
     - `package.json` 方面，本卡只改了 `engines` 和 `typecheck` 脚本，和它们改的 dependencies / devDependencies 不在同一段，预计能自动合并。
   - 它们的工作区同样是 CRLF 检出，合入含本卡的 main 之后要按第 1 条刷新一次。
   - main 在本卡开发期间前进了两个提交：`c1b8362`（ARCHITECTURE §9）和 `ef92bfb`（wave2 任务书）。本分支没有合入它们，模拟合并没有冲突。
3. **`noExplicitAny` 例外**（根 `biome.json` 最后一条 override，只作用于 `packages/agent-runtime/**`）。
   - 两个包原来的 Biome 配置照搬了 EnsoCode 的宽松规则，根配置则是 recommended。换成根配置后，新出现的诊断只有 agent-runtime 的 4 条 `noExplicitAny` 警告：`readonlyTools.ts:94` 的 `widen` 和 `test-utils/pipeline.ts:13`，两处都是 `ToolDefinition<any, any>`，用来把 pi 的泛型工具类型放宽。
   - 这次保留了 agent-runtime 原配置里明确关掉的这一条，core 用不到，没有放宽。
   - `biome.json` 不支持注释，所以理由写在提交信息里。如果不想要这个例外，删掉这条 override 即可：会多出 4 条警告，lint 仍然 exit 0。
4. **§9.2 契约和 `tsconfig.web.json` 有冲突**，Wave 2 会撞上（已用探针实测）。
   - 问题：§9.2 要求 `src/shared/types/chat.ts` 写 `import type { FynvraSessionEvent } from '@fynvra/agent-runtime'`。`src/shared` 属于 web 程序，而 `tsconfig.web.json` 的 paths 只映射了 `@fynvra/core`，所以 `typecheck:web` 会报 TS2307。`@fynvra/core` 本身没有问题。Wave 2 各卡的范围里都没有 `tsconfig*.json`。
   - 只给 web 补一条 `@fynvra/agent-runtime` 映射，typecheck 能通过（0 错误），但有代价：
     - agent-runtime 的入口会把 pi 的类型带进 web 程序；
     - pi 依赖的 undici-types 里有 `/// <reference types="node" />`，于是 `@types/node` 也被拉了进来；
     - 结果是 renderer 里写 `process.env` 不再报错（原配置报 TS2591，加映射后 0 错误）。app-shell 建立的「renderer 没有 Node 全局」这条类型护栏会悄悄失效。
   - `FynvraSessionEventBody` 这个联合类型本身不引用 pi 的类型，只是定义在 import 了 pi 的 `events/normalize.ts` 里。可选的方向，需要你来定，本卡没有做：
     - 把事件类型挪到一个不 import pi 的文件，给 web 一个只指向这个文件的 path；
     - 或者把会话事件类型放进 `src/shared` / `@fynvra/core`，由 agent-runtime 反过来引用。
5. **Main 或 shared 开始引用包之后，会出现 TS6307**（已用 tsc 实测）。
   - `tsconfig.node.json` 设了 `composite: true`。`typecheck:*` 脚本带 `--composite false`，所以 CLI 能通过。
   - 但直接按 `tsconfig.node.json` 运行 tsc（composite 生效）时，经 paths 引入的包源码会报 TS6307：`… is not listed within the file list of project`。编辑器也是按这份配置加载 node 程序，预计会在 import 处显示同样的错误（没有在编辑器里实际验证）。
   - 可选做法：把 `packages/*/src/**/*` 加进 `tsconfig.node.json` 的 include，或者去掉 node / web 配置的 composite 和根 references。
6. 两个包的 `@types/node` 从 26 换成了根的 24，两个包在根的严格选项（`noUnused*`、`noImplicitReturns`、`lib ES2024`）下都是 0 错误。根配置排除了 `*.md`，所以 core 总结注意事项 3 提到的「Biome 会格式化 README」已经不再适用。
