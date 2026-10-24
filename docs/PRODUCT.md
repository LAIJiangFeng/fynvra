# Fynvra 产品定义

Fynvra 是一个基于 Electron + [pi](https://github.com/earendil-works/pi) SDK 的本地桌面 AI 编程工作台。
它参考 [EnsoCode](https://github.com/J3n5en/EnsoCode)（本机参考源码：`D:\project\EnsoCode`）的工程形态，
并把 Orca 式的多 agent 协同（worktree 隔离、任务派发、消息收件箱、验收合并）做成产品内建的一等公民。

## 核心思想

### 1. 多角色（Role）
每个 agent 会话都挂一个角色。角色 = 系统提示词 + 技能(Skills) + MCP 服务器 + 模型/思考档位 + 工具白名单 + 审批档位。
- 内置角色：`orchestrator`（主 agent，见下）、`worker`（默认普通 agent，无额外提示词/技能/MCP）。
- 用户自定义角色：如「全栈开发工程师」「测试工程师」「代码审查员」。角色以文件形式存放，可导入导出。
- 没有指定角色时，派发出去的就是原生 `worker`。

### 2. 主 agent 只听人安排、只派活、不干活
用户只和 **Orchestrator（主 agent）** 对话。主 agent：
- 把用户的需求拆成任务，为每个任务 **开一个 git worktree**，启动一个 worker agent（可指定角色；未指定则用 `worker`），把任务书发给它。
- **自己不改代码**：工具集被限制为只读（读文件、git 只读、orchestration 工具），不能写文件 / 执行任意 shell。
- **监控** worker：收件箱收到 `worker_done` / `question` / `escalation`，回答问题、等待完成。
- **验收合并**：worker 完成后读 diff、跑检查命令、判断是否达标；达标则把 worker 分支合并到主 agent 所在分支，再删 worktree；不达标则把意见发回让 worker 继续改。
- 向用户汇报每个任务的结果与证据。

### 3. Worker 在独立 worktree 里干活
每个 worker 会话绑定一个 worktree（分支 `fynvra/<task-slug>`）。worker 的工具：pi 默认编程工具 + `ask_coordinator`（阻塞提问）+ `report_done`（一次性汇报，带 succeeded/failed）。

## 一句话用户旅程
挂入仓库 → 在该仓库开一个 Orchestrator 会话 → 说「做 X，Y 用测试工程师角色」→ 侧栏出现多个 worker 卡片（各自 worktree、实时输出、状态）→ 主 agent 验收合并 → 用户在自己的浏览器/终端验证效果。

## 从 EnsoCode 借鉴什么
- 工程骨架：electron-vite 三段构建、Zustand、Tailwind 4、Biome、Vitest、settings.json 持久化。
- IPC 安全边界、agentHost worker 边界、会话 jsonl 为权威源等约定（见 `AGENTS.md`）。
- Providers / Skills / MCP 设置页与扫描导入思路（可导入本机 Claude Code / Codex 配置）。
- 内嵌 Diff、三档审批、Git Checkpoint。

## 明确不做（v1）
手机伴侣、远程节点、SSH 项目、语音、内嵌浏览器。
