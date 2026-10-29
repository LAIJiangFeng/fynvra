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

<p align="center">English · <a href="README.zh-CN.md">简体中文</a></p>

<p align="center">
  <strong>A local desktop AI coding workbench.</strong><br />
  Coordinate agents, run tasks in parallel Git worktrees, and review and merge their changes in one workspace.
</p>

<p align="center">
  <a href="https://github.com/LAIJiangFeng/fynvra/releases"><strong>Download Fynvra</strong></a> ·
  <a href="https://jfengl.cn/en/docs/quickstart/">Quick start</a> ·
  <a href="https://jfengl.cn/">Website</a> ·
  <a href="https://jfengl.cn/en/docs/">Documentation</a>
</p>

Fynvra brings AI conversations, code editing, terminals, and multi-agent collaboration to your desktop. Give the main agent a goal, follow the workers as they implement it, and keep the resulting changes visible through review and merge.

## Core capabilities

### Parallel agents, separate worktrees

The main agent breaks a goal into tasks and dispatches workers into their own Git branches and worktrees. Track task status, messages, and live output together while continuing the conversation with the main agent.

### From review to merge

Inspect worker diffs in the workspace. The main agent can review changes, run checks, send feedback for another pass, and merge accepted work into its branch. Completed task diffs remain available after worktree cleanup.

### Roles you can shape

Customize the built-in Orchestrator and Worker roles or create your own. Set prompts, models, reasoning levels, tool policies, and approvals; attach Skills, MCP servers, and instruction files to fit the task. By default, the main agent coordinates and workers implement.

### Connect your model services

Use services compatible with Anthropic Messages, OpenAI Responses, OpenAI Chat Completions, or Google Generative AI, with configurable endpoints and models. Import provider settings from local Claude Code, Codex, and CC Switch configs, or import MCP servers from supported local tools, with preview and deduplication.

### Work alongside your agents

Keep conversations, editable files, and integrated terminals in adjacent tabs. Browse project files, preview Markdown and images, and edit with unsaved-change and external-modification protection. Session history and local token and cost summaries help you follow the work over time.

The desktop UI supports English and Chinese, themes, keyboard shortcuts, and system notifications.

## Download and install

Get available installers from **[GitHub Releases](https://github.com/LAIJiangFeng/fynvra/releases)** → **Assets**. If no installer is published yet, [run from source](#development).

| Platform | Package | Update support |
| --- | --- | --- |
| Windows x64 | NSIS `.exe` installer | Automatic update checks and downloads |
| macOS Intel / Apple Silicon | Per-architecture `.dmg` and `.zip` | Developer ID signed and notarized builds support auto-update; ad-hoc builds require manual updates |
| Linux | AppImage build configuration only | Not included in automated releases or update support |

On Windows, the installer lets you choose the application directory. On macOS, move Fynvra from the DMG to Applications before launching. Ad-hoc Mac builds may require an app-specific “Open Anyway” confirmation in System Settings → Privacy & Security; see the [installation and release details](docs/RELEASE.md).

Where auto-update is supported, new stable versions download in the background. Installation requires your confirmation and follows the app's unsaved-file and agent shutdown flow; downloading an update does not restart the app.

## Quick start

Model access is supplied by you: configure a compatible service, API key, and available quota. Requests go to that service; running Fynvra locally does not make model calls offline.

1. **Connect a model.** Open **Settings → Model Providers**, add your endpoint, API key, and models, or import an existing local configuration.
2. **Set up your roles.** Start with the built-in roles, then configure the models, Skills, MCP servers, or instruction files you need in Settings.
3. **Open a project.** Add a Git repository, create a session, and select the **Orchestrator** role and a model. Describe your goal and any constraints so the main agent can dispatch the work.
4. **Follow and review the work.** Use the task and changes panels to inspect worker output and diffs. Send follow-ups to the main agent as it reviews, requests revisions, and merges completed tasks.

The Git worktree flow needs Git, a repository with at least one commit, and a configured Git user name and email. Ordinary folders also support sessions and worker dispatch, but workers share the same directory without worktree isolation or Git merging; dispatch one worker at a time there.

Model and MCP credentials are managed in Settings. No repository `.env` file is required to run the app.

## Development

Built with Electron, React, TypeScript, and the [pi SDK](https://github.com/earendil-works/pi).

Requires **Node.js 22.19.0+** (Node.js 22 recommended), **pnpm 10.26.2**, and **Git**. On Windows, Git for Windows with Git Bash is recommended; agent and terminal shells can be selected in General settings.

```bash
npm install --global pnpm@10.26.2
git clone https://github.com/LAIJiangFeng/fynvra.git
cd fynvra
pnpm install --frozen-lockfile
pnpm dev
```

Skip the global install if the required pnpm version is already available. Initial setup needs network access to download dependencies and Electron.

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | Check app and workspace package types |
| `pnpm lint` | Run Biome checks |
| `pnpm test` | Run the Vitest suite |
| `pnpm build` | Build the app into `out/`, without installers |

For packaging, signing, update verification, and automated publishing, see the [release guide](docs/RELEASE.md). Read the [development conventions](AGENTS.md) before contributing.

## Local data and permissions

Settings, roles, provider and MCP configs, and session history are stored in the local app data directory. **Credentials are currently stored in plaintext local config files, not an encrypted vault.** Saved API keys, MCP environment variables, and request headers are managed by the Main process and are not returned to the UI in plaintext. Keep app data and credential-bearing exports or logs out of Git and public uploads.

Agents and MCP tools can execute commands and contact external services. Configure tool policies and approval levels for your project; the runtime enforces these policies independently of role prompts.

## Documentation

Read the [official user documentation](https://jfengl.cn/en/docs/) for help using Fynvra.

The following developer guides are currently written in Chinese:

- [Product definition](docs/PRODUCT.md) — workflow, roles, and product scope.
- [Architecture](docs/ARCHITECTURE.md) — process boundaries, persistence, and cross-layer contracts.
- [Installation, updates, and releases](docs/RELEASE.md) — platform caveats and packaging details.
- [Development conventions](AGENTS.md) — contribution scope and commit format.

Package guides: [Core domain](packages/core/README.md) · [Agent runtime](packages/agent-runtime/README.md).

## Links

- [Linux DO](https://linux.do/)

## License

Fynvra is open source under [Apache-2.0](LICENSE). Third-party dependencies follow their respective licenses.
