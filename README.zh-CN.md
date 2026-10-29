<h1 align="center">
  <img src="resources/icon.png" alt="Fynvra" width="64" /><br />
  Fynvra
</h1>

<p align="center">
  <a href="https://github.com/LAIJiangFeng/fynvra/stargazers"><img src="https://img.shields.io/github/stars/LAIJiangFeng/fynvra?style=flat&amp;logo=github" alt="GitHub Stars" /></a>
  <a href="https://github.com/LAIJiangFeng/fynvra/releases"><img src="https://img.shields.io/github/downloads/LAIJiangFeng/fynvra/total?style=flat" alt="Total downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-blue?style=flat" alt="License: Apache-2.0" /></a>
  <a href="https://github.com/LAIJiangFeng/fynvra/releases"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue?style=flat" alt="Platform: Windows | macOS" /></a>
</p>

<p align="center"><a href="README.md">English</a> · 简体中文</p>

<p align="center">
  <strong>本地桌面 AI 编程工作台。</strong><br />
  协调 Agent，在独立 Git worktree 中并行执行任务，在同一工作区审查并合并改动。
</p>

<p align="center">
  <a href="https://github.com/LAIJiangFeng/fynvra/releases"><strong>下载 Fynvra</strong></a> ·
  <a href="#快速上手">快速上手</a> ·
  <a href="https://jfengl.cn/">官网首页</a> ·
  <a href="https://jfengl.cn/zh/docs/">官方文档</a>
</p>

Fynvra 将 AI 对话、代码编辑、终端和多 Agent 协作整合到桌面中。向主 Agent 描述目标，跟进 Worker 的实现过程，再通过审查与合并把改动带回项目。

## 核心能力

### 多个 Agent，独立 worktree

主 Agent 将目标拆成任务，派发 Worker 到各自的 Git 分支和 worktree。集中查看任务状态、消息和实时输出，同时继续与主 Agent 对话。

### 从审查到合并

在工作区查看 Worker 的代码差异。主 Agent 可以审查改动、运行检查、发回修改意见，并将验收通过的工作合入自己所在的分支。清理 worktree 后，仍可查看已完成任务的差异。

### 按任务配置角色

修改内置的 Orchestrator（主 Agent）和 Worker 角色，或创建自己的角色。配置提示词、模型、思考档位、工具策略和审批档位，再按任务搭配 Skills、MCP 服务与指令文件。默认由主 Agent 协调，Worker 执行。

### 接入你的模型服务

支持兼容 Anthropic Messages、OpenAI Responses、OpenAI Chat Completions 和 Google Generative AI 协议的服务，可配置服务地址与模型。从本机 Claude Code、Codex、CC Switch 配置导入模型服务，也可从支持的本机工具导入 MCP 服务，导入前预览并去重。

### 与 Agent 在同一工作区工作

对话、可编辑文件和内嵌终端以独立标签并列展示。浏览项目文件、预览 Markdown 与图片，编辑时保留未保存内容并检测外部修改冲突。通过会话历史和本机 Token、费用统计，持续了解工作进展与用量。

桌面界面支持中文和英文、主题、快捷键与系统通知。

## 下载与安装

前往 **[GitHub Releases](https://github.com/LAIJiangFeng/fynvra/releases)** 的 **Assets** 下载已发布的安装包。如果暂时没有安装包，可[从源码启动](#开发)。

| 平台 | 安装包 | 更新支持 |
| --- | --- | --- |
| Windows x64 | NSIS `.exe` 安装包 | 自动检查并下载更新 |
| macOS Intel / Apple Silicon | 分架构 `.dmg` 与 `.zip` | Developer ID 签名并公证的版本支持自动更新；ad-hoc 签名版需手动更新 |
| Linux | 仅有 AppImage 构建配置 | 尚未纳入自动发布与更新支持 |

Windows 安装向导支持选择程序安装目录。macOS 首次启动前，请将 Fynvra 从 DMG 拖入「应用程序」。ad-hoc 签名的 Mac 版可能需要在「系统设置 → 隐私与安全性」中针对该应用确认「仍要打开」；详见[安装与发布说明](docs/RELEASE.md)。

支持自动更新的版本会在后台下载稳定新版。安装须经你确认，并经过未保存文件确认和 Agent 退出收尾流程；后台下载不会重启应用。

## 快速上手

模型服务由你提供：需要配置兼容服务、API Key 和可用额度。请求会发送到所配置的服务；本地运行 Fynvra 不意味着模型调用离线执行。

1. **连接模型。** 打开「设置 → 模型服务」，添加服务地址、API Key 与模型，或导入本机已有配置。
2. **配置角色。** 从内置角色开始，在设置中按需配置模型、Skills、MCP 服务或指令文件。
3. **打开项目。** 添加 Git 仓库，创建会话并选择 **Orchestrator（主 Agent）** 角色与模型。描述目标和约束，由主 Agent 派发工作。
4. **跟进与审查。** 在任务和改动面板查看 Worker 输出与差异。主 Agent 审查、要求修改和合并已完成任务时，你可以继续向它补充需求。

Git worktree 流程需要安装 Git、仓库中至少有一次提交，并配置 Git 用户名与邮箱。普通文件夹也支持会话和 Worker 派发，但所有 Worker 共用同一目录，没有 worktree 隔离或 Git 合并；这种情况下建议一次只派发一个 Worker。

模型和 MCP 凭证通过设置界面管理，运行应用无需在仓库内填写 `.env` 文件。

## 开发

基于 Electron、React、TypeScript 和 [pi SDK](https://github.com/earendil-works/pi) 构建。

需要 **Node.js 22.19.0+**（推荐 Node.js 22）、**pnpm 10.26.2** 和 **Git**。Windows 建议安装包含 Git Bash 的 Git for Windows；可在通用设置中选择 Agent 和终端使用的 Shell。

```bash
npm install --global pnpm@10.26.2
git clone https://github.com/LAIJiangFeng/fynvra.git
cd fynvra
pnpm install --frozen-lockfile
pnpm dev
```

如果已有对应版本的 pnpm，可跳过全局安装。首次启动需要网络下载依赖和 Electron。

| 命令 | 用途 |
| --- | --- |
| `pnpm typecheck` | 检查应用与工作区包的类型 |
| `pnpm lint` | 执行 Biome 检查 |
| `pnpm test` | 运行 Vitest 测试 |
| `pnpm build` | 构建应用到 `out/`，不生成安装包 |

打包、签名、更新验证与自动发布流程见[发布指南](docs/RELEASE.md)。贡献代码前请阅读[开发约定](AGENTS.md)。

## 本地数据与权限

设置、角色、模型服务与 MCP 配置、会话历史保存在本机应用数据目录中。**凭据目前以明文保存在本地配置文件中，不是加密凭证库。** 已保存的 API Key、MCP 环境变量和请求头由 Main 进程管理，不会向界面回传明文。请勿将应用数据、含凭据的导出文件或日志提交到 Git 或公开上传。

Agent 与 MCP 工具可以执行命令和访问外部服务。请按项目需要配置工具策略与审批档位；运行时会独立于角色提示词执行这些权限约束。

## 文档

Fynvra 的使用方法请参阅[官方使用文档](https://jfengl.cn/zh/docs/)。

以下开发者指南目前以中文编写：

- [产品定义](docs/PRODUCT.md) — 工作流程、角色与产品范围。
- [架构](docs/ARCHITECTURE.md) — 进程边界、持久化与跨层契约。
- [安装、更新与发布](docs/RELEASE.md) — 平台限制与打包细节。
- [开发约定](AGENTS.md) — 贡献范围与提交格式。

包文档：[核心领域](packages/core/README.md) · [Agent 运行时](packages/agent-runtime/README.md)。

## 许可证

Fynvra 基于 [Apache-2.0](LICENSE) 开源。第三方依赖遵循各自的许可证。
