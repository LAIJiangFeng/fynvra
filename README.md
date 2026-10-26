# Fynvra

**[简体中文](README.zh-CN.md)** | English

Fynvra is an open-source local desktop AI coding workbench built with Electron, React, TypeScript, and the [pi](https://github.com/earendil-works/pi) SDK.

Run AI conversations, file editing, Markdown preview, and multi-agent collaboration in a single workspace. Roles, prompts, model providers, Skills, and MCP are all configurable per project instead of being hardcoded.

## Features

- **Multi-agent collaboration**: the main agent splits tasks and dispatches them to isolated Git worktrees; review task status, messages, output, and changes in one place, then accept and merge.
- **Editable roles**: custom roles are supported; built-in main agent and worker roles are just default templates — edit their prompts, models, tool policies, approval levels, Skills, and MCP, and restore defaults at any time.
- **Model providers**: supports Anthropic Messages, OpenAI Responses, OpenAI Chat Completions, and Google Generative AI protocols, with configurable base URLs, models, and reasoning levels for compatible services.
- **Local config import**: import model providers from Claude Code, Codex, and CC Switch; MCP supports additional local tool config sources, with preview and deduplication before importing.
- **File browsing and editing**: open files from the directory tree on the right and view them in center tabs alongside conversations. Supports multi-file editing, Markdown edit / preview / split view, common image previews, plus unsaved-content and external-modification conflict protection.
- **Workspaces and sessions**: manage Git repos or plain folders, keep session history, and inspect tool calls and approval requests.
- **Desktop experience**: Chinese / English UI, themes, keyboard shortcuts, system notifications, and general settings.
- **App updates**: release builds automatically check for and download new stable versions and notify when ready; restart happens only after you confirm installation, unsaved files are confirmed, and agents finish their work — running tasks are never forcibly interrupted.

By default the main agent coordinates and workers execute; actual tool permissions are constrained by role policies and the runtime together, and cannot be bypassed merely by editing prompts.

## Platforms and Installation

Once installers are published, download them from [GitHub Releases](https://github.com/LAIJiangFeng/fynvra/releases). If no Release is available yet, follow the steps below to run from source.

| Platform | Installer | Status |
| --- | --- | --- |
| Windows x64 | NSIS `.exe` | Packaging and auto-update wired up; local packaging and isolated update tests verified |
| macOS Intel / Apple Silicon | Per-arch `.dmg` and `.zip` | Builds and installs manually without Apple credentials; signed and notarized builds enable auto-update |
| Linux | Existing AppImage build config | Not yet included in automated release and update support |

When manually running the new Windows `.exe` installer, a setup wizard appears and lets you browse or type a target directory on the "Choose Install Location" page. After browsing to a parent directory, `Fynvra` is appended to the path automatically — selecting `D:\Software` shows `D:\Software\Fynvra`; choosing an existing `Fynvra` directory does not append it again. Auto-updates keep using the existing install directory; the selected directory only holds program files and does not move settings, sessions, or other user data. Older installers do not gain the new wizard behavior — download a newer installer that includes this change.

On first install on Mac, drag the app from the DMG into Applications before running. Packages built without Apple credentials use ad-hoc signing; macOS may warn that the developer cannot be verified or block launch. After confirming the source is trusted, use "Open Anyway" for this app under System Settings → Privacy & Security. Exact behavior depends on the macOS version and management policies; globally disabling system security checks is not required. These packages only support manual download and overwrite installs. See the [release docs](docs/RELEASE.md).

## Running from Source

### Prerequisites

- Node.js **22.19.0 or later**; Node.js 22 recommended. The repo ships an `.nvmrc`.
- pnpm **10.26.2**, matching the `packageManager` field in `package.json`.
- Git; the multi-agent worktree flow requires a Git repository with existing commits and a configured Git user name and email.
- On Windows, Git for Windows with Git Bash is recommended; if Bash cannot be found automatically, set its path in general settings.

If pnpm is not installed yet:

```bash
npm install --global pnpm@10.26.2
```

Start the dev build:

```bash
git clone https://github.com/LAIJiangFeng/fynvra.git
cd fynvra
pnpm install --frozen-lockfile
pnpm dev
```

The first run needs network access to download dependencies and Electron. Service accounts, API keys, and quotas for model calls are provided by the user; a local desktop app does not mean model requests run offline.

### First Run

1. Open "Settings → Model Providers", add a base URL, API key, and models — or import from existing local configs.
2. Configure capabilities under "Roles", "Skills", and "MCP"; external services you don't need can stay off.
3. Add a repository or folder, then create a session and pick a role and model. Multi-agent task dispatch requires a Git workspace.
4. Browse files, tasks, and changes on the right. Click a file to edit or preview it in a center file tab; conversations stay in their own tabs.

Running the app does not require a `.env` in the repo. Manage model and MCP credentials through the settings UI.

## Development and Verification

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the Electron dev environment |
| `pnpm typecheck` | Type-check Main, preload, Renderer, and workspace packages |
| `pnpm lint` | Run Biome checks |
| `pnpm test` | Run the full Vitest suite |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm build` | Build the app into `out/` without installers |
| `pnpm preview` | Preview an existing build |
| `pnpm test:updates` | Run isolated update tests on Windows / Mac; requires a build first |
| `pnpm package:win` | Build the Windows x64 installer into `dist/`, no upload |
| `pnpm package:mac` | Build the dual-arch manual-install packages on macOS without Apple credentials, no upload |
| `pnpm package:mac:signed` | Build Developer ID signed and notarized packages on macOS; requires credentials, no upload |

Before committing, run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Update tests use temporary user data, a temporary cache, and a local HTTP server, and intercept the final install — no test installer is ever executed. They do not replace real-device upgrade acceptance for officially signed packages.

## Automated Releases

The [Release workflow](.github/workflows/release.yml) runs checks after every push to `main`, computes an incremented version, builds Windows and Mac packages, and publishes a single GitHub Release once all artifacts pass verification. Merged PRs trigger it too.

- Both direct pushes and merged PRs build and publish; the Release workflow can also be run manually from Actions. Downloads live in the Release page's Assets — not just source uploads.
- Versions are written into build artifacts and tags; the release bot never commits version bumps back to the repo.
- Without Apple credentials, Mac still produces and uploads manual-install packages and Windows auto-updates stay unblocked; with full credentials the workflow switches to signed and notarized mode automatically. Missing some credentials fails explicitly, and any build or verification failure prevents publishing an incomplete Release.
- The client only consumes official Releases; dev builds never check for updates online. The first install must come manually from a version that includes update support.

Signing secrets, packaging commands, artifact verification, and first-release steps are documented in [docs/RELEASE.md](docs/RELEASE.md).

## Project Structure

```text
src/
  main/                  Electron main process, IPC, file and update services
  preload/               Typed bridge for Renderer calls
  renderer/              React UI, state, and i18n
  shared/                Cross-process types and pure functions
  agent/                 Standalone agent worker entry and process communication
packages/
  core/                  Roles, tasks, message inbox, and Git worktree domain logic
  agent-runtime/         pi SDK integration, tools, approvals, and session lifecycle
resources/               Bundled resources and macOS entitlements
scripts/                 Version planning, release verification, and update testing
test/                    Test doubles
docs/                    Product, architecture, and release docs
.github/workflows/       GitHub Actions release pipeline
```

## Data and Security Boundaries

App settings, roles, model providers, MCP configs, and session data are stored in the local app data directory and must not be committed to Git. Dev builds default to `fynvra-dev` under the system app data directory, separate from release builds; `FYNVRA_USER_DATA_DIR` overrides this directory in dev mode only and should point to an isolated location in tests.

API keys, MCP environment variables, and request header values in plaintext are never sent back to the UI over IPC, but they are currently stored in local config files managed by the Main process — **this is not an encrypted credential vault**. Do not upload the user data directory, config exports, or logs containing credentials; check prompts and referenced content before sharing role configs.

`.gitignore` excludes dependencies, build artifacts, installers, caches, environment configs, signing private keys, local user data, and `.workflow/` internal dev notes; example environment files may be committed with placeholder values only. Lockfiles, source, tests, icons, and GitHub Actions workflow configs stay under version control.

File reads and writes are restricted to registered workspaces, IPC parameters are validated by the Main process, and the Renderer has no direct access to Node.js or Electron. Agents and MCP can execute commands or reach external services — configure tool allowlists and approval policies to match your project's needs.

## Docs and Contributing

- [Product definition](docs/PRODUCT.md) (Chinese)
- [Architecture and cross-layer contracts](docs/ARCHITECTURE.md) (Chinese)
- [Auto-update and releases](docs/RELEASE.md) (Chinese)
- [Development conventions](AGENTS.md) (Chinese)
- [Core domain package](packages/core/README.md)
- [Agent runtime package](packages/agent-runtime/README.md)

Read the development conventions before contributing, add tests for your changes, and use commit messages in the `<type>(<scope>): <summary>` format. Changes involving IPC must keep the channel constants, Main handlers, and preload typed exports in sync.

Fynvra is licensed under [Apache-2.0](LICENSE). Third-party dependencies follow their respective licenses.
