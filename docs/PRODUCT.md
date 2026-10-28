# Fynvra 产品定义

Fynvra 是一个基于 Electron 和 [pi](https://github.com/earendil-works/pi) SDK 的本地桌面 AI 编程工作台。
内置多 Agent 协作能力，将 worktree 隔离、任务派发、消息收件箱与验收合并整合为完整的开发流程。

## 核心思想

### 1. 多角色（Role）
每个 agent 会话都挂一个角色。角色 = 系统提示词 + 技能(Skills) + MCP 服务器 + 模型/思考档位 + 工具白名单 + 审批档位。
- 内置角色：`orchestrator`（默认主 agent，见下）、`worker`（默认普通 agent）。内置配置仅作参考，可直接修改提示词、技能、MCP、模型和策略并保存，也可恢复默认；id 固定且不可删除。
- 用户自定义角色：如「全栈开发工程师」「测试工程师」「代码审查员」。角色以文件形式存放，可导入导出。
- 没有指定角色时，派发出去的就是原生 `worker`。

### 2. 默认主 agent 只听人安排、只派活、不干活
默认 **Orchestrator（主 agent）** 使用编排工具策略，用户可以按需调整角色配置。默认主 agent：
- 把用户的需求拆成任务，为每个任务 **开一个 git worktree**，启动一个 worker agent（可指定角色；未指定则用 `worker`），把任务书发给它。
- **自己不改代码**：工具集被限制为只读（读文件、git 只读、orchestration 工具），不能写文件 / 执行任意 shell。
- **监控** worker：派发后不阻塞等待，可继续与用户对话；收件箱收到 `worker_done` / `question` / `escalation` 时由 Fynvra 自动唤醒主 agent，回答问题、验收结果。
- **验收合并**：worker 完成后读 diff、跑检查命令、判断是否达标；达标则把 worker 分支合并到主 agent 所在分支，再删 worktree；不达标则把意见发回让 worker 继续改。
- 向用户汇报每个任务的结果与证据。

### 3. Worker 在独立 worktree 里干活
每个 worker 会话绑定一个 worktree（分支 `fynvra/<task-slug>`）。worker 的工具：pi 默认编程工具 + `ask_coordinator`（阻塞提问）+ `report_done`（一次性汇报，带 succeeded/failed）。
worker 的审批档位随主 agent 派发时的当前档位（主 agent 免确认，worker 也免确认；保护底线如 `rm -rf`、`git push` 任何档位仍要人确认）；模型按角色配置，角色没配则用主 agent 当前的。

## Fast（优先服务）
支持的 OpenAI 协议模型可在会话模型选择器里开启 Fast：请求按服务商的优先服务处理，独立于思考档位，默认关闭、随会话保存。
实际速度与费用由服务商决定；可能增加费用或用量，服务商不支持时按普通请求错误返回，不会自动重试或假装已加速。

## 一句话用户旅程
挂入仓库 → 在该仓库开一个 Orchestrator 会话 → 说「做 X，Y 用测试工程师角色」→ 侧栏出现多个 worker 卡片（各自 worktree、实时输出、状态）→ 主 agent 验收合并 → 用户在自己的浏览器/终端验证效果。

## 工程与安全边界
- 分层构建：electron-vite 三段构建，结合 Zustand、Tailwind 4、Biome 与 Vitest；应用元数据通过 settings.json 持久化。
- 进程隔离：明确 IPC 与 Agent Worker 的安全边界，会话 jsonl 为正文权威源（见 `AGENTS.md`）。
- 资源配置：统一管理 Providers、Skills 与 MCP，支持扫描导入本机工具配置。
- 任务验收：内置差异查看、三档审批与 worktree 验收合并流程。

## 明确不做（v1）
手机伴侣、远程节点、SSH 项目、语音、内嵌浏览器。
