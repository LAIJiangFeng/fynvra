# Fynvra

Fynvra 是一个开源的本地桌面 AI 编程工作台，基于 Electron、React、TypeScript 和 [pi](https://github.com/earendil-works/pi) SDK 构建。

在同一个工作区中完成 AI 对话、文件编辑、Markdown 预览和多 Agent 协作。角色、提示词、模型服务、Skills 与 MCP 都可以按项目需要配置，而不是固定在代码里。

## 功能

- **多 Agent 协作**：主 Agent 拆分任务，将工作派发到独立 Git worktree，集中查看任务状态、消息、输出和改动，再执行验收与合并。
- **可编辑角色**：支持自定义角色；内置主 Agent、Worker 也只是默认模板，可以修改提示词、模型、工具策略、审批档位、Skills 和 MCP，并恢复默认配置。
- **模型服务**：支持 Anthropic Messages、OpenAI Responses、OpenAI Chat Completions 和 Google Generative AI 协议，可配置兼容服务地址、模型与思考档位。
- **本机配置导入**：从 Claude Code、Codex、CC Switch 导入模型服务；MCP 支持更多本机工具配置来源，导入前可预览并去重。
- **文件浏览与编辑**：右侧目录树打开文件，中央以独立标签与对话并列展示。支持多文件编辑、Markdown 编辑 / 预览 / 双栏、常见图片预览，以及未保存内容和外部修改冲突保护。
- **工作区与会话**：管理 Git 仓库或普通文件夹，保留会话历史，查看工具调用与审批请求。
- **桌面体验**：中文 / 英文界面、主题、快捷键、系统通知和通用设置。
- **应用更新**：正式版自动检查和下载稳定新版本，下载完成后提醒；确认安装且完成未保存文件确认、Agent 收尾后才重启，不强行中断当前任务。

默认主 Agent 负责协调，Worker 负责执行；实际工具权限由角色策略和运行时共同约束，不会仅凭修改提示词绕过权限限制。

## 平台与安装

安装包发布后可从 [GitHub Releases](https://github.com/LAIJiangFeng/fynvra/releases) 下载。如果暂时没有 Release，请按下方步骤从源码启动。

| 平台 | 安装包 | 状态 |
| --- | --- | --- |
| Windows x64 | NSIS `.exe` | 已接入打包和自动更新，本地打包及隔离更新联调已验证 |
| macOS Intel / Apple Silicon | 分架构 `.dmg` 与 `.zip` | 无 Apple 凭证也能打包和手动安装；正式签名、公证版可启用自动更新 |
| Linux | 现有 AppImage 构建配置 | 尚未纳入自动发布与更新支持 |

Mac 首次安装应将应用从 DMG 拖入「应用程序」后运行。无 Apple 凭证的包使用 ad-hoc 签名，macOS 可能提示无法验证开发者或拦截启动；确认来源可信后，可按系统提示在「系统设置 → 隐私与安全性」中针对该应用选择「仍要打开」。具体行为取决于 macOS 版本与管理策略，不需要全局关闭系统安全检查。这类包只能手动下载新版并覆盖安装。详见 [发布文档](docs/RELEASE.md)。

## 从源码启动

### 环境要求

- Node.js **22.19.0 或更高版本**，推荐 Node.js 22；仓库提供 `.nvmrc`。
- pnpm **10.26.2**，与 `package.json` 的 `packageManager` 保持一致。
- Git；多 Agent worktree 流程需要已有提交的 Git 仓库，并配置 Git 用户名与邮箱。
- Windows 建议安装包含 Git Bash 的 Git for Windows；如无法自动找到 Bash，可在通用设置中指定路径。

尚未安装 pnpm 时：

```bash
npm install --global pnpm@10.26.2
```

启动开发版：

```bash
git clone https://github.com/LAIJiangFeng/fynvra.git
cd fynvra
pnpm install --frozen-lockfile
pnpm dev
```

首次运行需要网络下载依赖和 Electron。模型调用所需的服务账号、API Key 和额度由使用者提供；本地桌面应用不意味着模型请求离线执行。

### 首次使用

1. 打开「设置 → 模型服务」，添加服务地址、API Key 与模型，或从本机已有配置导入。
2. 在「角色」「Skills」「MCP」中配置需要的能力；不需要的外部服务可以保持关闭。
3. 添加一个仓库或文件夹，创建会话并选择角色、模型。多 Agent 任务派发需要 Git 工作区。
4. 在右侧查看文件目录、任务和改动。点击文件后，在中央文件标签中编辑或预览，对话仍保留在独立标签中。

运行应用不要求在仓库内填写 `.env`。请通过设置界面管理模型和 MCP 凭证。

## 开发与验证

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动 Electron 开发环境 |
| `pnpm typecheck` | 检查 Main、preload、Renderer 与工作区包的类型 |
| `pnpm lint` | 执行 Biome 检查 |
| `pnpm test` | 运行 Vitest 全量测试 |
| `pnpm test:watch` | 监听模式运行测试 |
| `pnpm build` | 构建应用到 `out/`，不生成安装包 |
| `pnpm preview` | 预览已有构建 |
| `pnpm test:updates` | 在 Windows / Mac 上运行隔离更新联调，须先构建 |
| `pnpm package:win` | 构建 Windows x64 安装包到 `dist/`，不上传 |
| `pnpm package:mac` | 在 macOS 上构建无需 Apple 凭证的双架构手动安装包，不上传 |
| `pnpm package:mac:signed` | 在 macOS 上构建 Developer ID 签名、公证包，需提供凭证，不上传 |

提交前执行：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

更新联调使用临时用户数据、临时缓存和本机 HTTP 服务，并拦截最终安装，不会执行测试安装文件。它不能代替正式签名包的真机升级验收。

## 自动发布

[Release 工作流](.github/workflows/release.yml) 在每次推送到 `main` 后检查代码、计算递增版本、构建 Windows 和 Mac 包，并在全部产物校验通过后公开同一个 GitHub Release。PR 合并同样会触发。

- 普通直接 push 和 PR 合并都会打包发布；也可以在 Actions 中手动运行 Release 工作流。下载入口是 Releases 页的 Assets，不是仅上传源码。
- 版本写入构建产物与标签，不让发布机器人回写版本提交。
- 没有 Apple 凭证时，Mac 仍会生成并上传手动安装包，不阻止 Windows 自动更新；凭证齐全时自动切换为签名、公证模式。部分凭证缺失会明确报错，任何构建或校验失败都不会公开不完整 Release。
- 客户端只使用正式 Release，开发模式不联网更新；首次使用需要手动安装一个包含更新功能的版本。

签名 Secrets、打包命令、产物校验和首次发布步骤见 [docs/RELEASE.md](docs/RELEASE.md)。

## 项目结构

```text
src/
  main/                  Electron 主进程、IPC、文件与更新服务
  preload/               类型化的 Renderer 调用桥接
  renderer/              React 界面、状态与国际化
  shared/                跨进程类型与纯函数
  agent/                 独立 Agent worker 入口与进程通信
packages/
  core/                  角色、任务、消息收件箱和 Git worktree 领域逻辑
  agent-runtime/         pi SDK 接入、工具、审批和会话生命周期
resources/               打包资源与 macOS 权限配置
scripts/                 版本规划、发布校验和更新联调
test/                    测试替身
docs/                    产品、架构和发布说明
.github/workflows/       GitHub Actions 发布流程
```

## 数据与安全边界

应用设置、角色、模型服务、MCP 配置和会话数据保存在本机应用数据目录中，不应提交到 Git。开发版默认使用系统应用数据目录下的 `fynvra-dev`，与正式版分开；`FYNVRA_USER_DATA_DIR` 仅在开发模式覆盖该目录，测试时应指向独立位置。

API Key、MCP 环境变量和请求头的明文不会通过 IPC 回传给界面，但当前会保存在 Main 管理的本地配置文件中，**不是加密凭证库**。不要上传用户数据目录、配置导出或包含凭证的日志；分享角色配置前也应检查提示词及引用内容。

`.gitignore` 排除依赖、构建产物、安装包、缓存、环境配置、签名私钥和本地用户数据；示例环境文件可以提交，但只能包含占位值。依赖锁文件、源码、测试、图标和工作流配置保留在版本控制中。

文件读写限定于登记的工作区，IPC 参数由 Main 校验；Renderer 不直接访问 Node.js 或 Electron。Agent 和 MCP 可执行命令或访问外部服务，请按项目需要配置工具白名单与审批策略。

## 文档与贡献

- [产品定义](docs/PRODUCT.md)
- [架构与跨层契约](docs/ARCHITECTURE.md)
- [自动更新与发布](docs/RELEASE.md)
- [开发约定](AGENTS.md)
- [核心领域包](packages/core/README.md)
- [Agent 运行时包](packages/agent-runtime/README.md)

提交改动前请阅读开发约定、补充相应测试，并使用 `<type>(<scope>): <summary>` 格式的提交信息。涉及 IPC 的修改需同步通道、Main handler 与 preload 类型出口。

Fynvra 的工程形态参考 [EnsoCode](https://github.com/J3n5en/EnsoCode)，Agent 能力基于 pi SDK。许可证为 [Apache-2.0](LICENSE)。
