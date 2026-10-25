# 自动更新与发布

## 客户端

- 发布目标是 Windows x64 的 NSIS 安装包，以及 macOS Intel（x64）/ Apple Silicon（arm64）的 DMG 和 ZIP。更新源固定为公开仓库 `LAIJiangFeng/fynvra` 的 GitHub Releases，不需要给客户端配置 token。
- 正式版启动 10 秒后检查，此后每 4 小时检查一次；发现稳定新版本后自动下载。设置 → 通用 → 应用更新可以手动检查、查看版本和进度。
- 下载完显示应用内提醒和静默系统通知。点击「重启并安装」后先确认，再确认未保存文件，关闭 agent 和落盘编排状态，最后安装并重新打开。取消任一退出确认都不会安装，不会因后台下载主动中断任务。
- 开发模式不联网更新；未发布的平台明确显示不可用。默认不在普通退出时安装，不接受降级、预发行版本或 Renderer 指定的 URL。
- **首次需要手动安装一个包含本功能的安装包**。没有更新代码的旧安装包不会自行获得更新功能。仅重新运行 `pnpm dev` 也不会启用生产更新。
- Mac 首次安装下载对应架构的 DMG，将 Fynvra 拖入「应用程序」后再启动，不要从只读 DMG 内运行。后续更新使用 ZIP；`latest-mac.yml` 同时包含两种架构，由更新器自动选择。单独关掉 Mac 窗口不会退出应用或停止 agent。
- Mac 的原生签名校验可能在关闭窗口后才返回错误；此时显示系统错误框并退出，不留下无窗口进程。更新失败不会删除用户数据，可以重新启动后重试。

## 合并 PR 后

`.github/workflows/release.yml` 监听 main 的 push，并通过 GitHub API 确认该提交来自已经合并到 main 的 PR；直接 push 不发布。这样外部贡献的 PR 合并后也使用主仓库的发布权限，而不是 fork 的只读 token。

1. 对同一提交执行 `pnpm typecheck`、`pnpm lint`、`pnpm test`。
2. 根据 `package.json` 和已有稳定 `vX.Y.Z` 标签决定版本。没有标签时从当前版本加一个 patch；通常下一版递增 patch，主动提高 package 版本时可发布新的 minor / major。版本只写入构建产物，不产生版本提交。
3. Windows runner 构建安装包、blockmap、`latest.yml`；校验版本、文件名、大小、SHA512，再生成 `SHA256SUMS`。
4. Mac runner 在同一次构建中生成 x64 / arm64 两套 DMG、ZIP、ZIP blockmap 和一个 `latest-mac.yml`。强制 Developer ID 签名、公证，检查两套应用的架构、签名团队和公证票据，校验元数据与文件后生成 `SHA256SUMS-mac`。
5. Windows 和 Mac 都成功后，发布 job 校验两份 SHA256 与版本顺序，创建草稿 Release，完整上传后才公开并标记为 latest。缺少 Mac 凭证或任何平台构建失败，整个 Release 都不会公开。

工作流串行发布，连续合并时 GitHub 可能把尚未开始的排队任务合并为最新一次。重新运行相同提交复用标签，已公开的 Release 不覆盖；旧提交落后于已发布代码时拒绝发布，避免版本号升高但代码回退。失败的草稿不会被客户端发现，可重跑失败任务继续发布。

## 首次启用

- 将这些文件合并到 GitHub 的 main，并启用仓库 Actions。发布 job 已声明 `contents: write`，使用短期 `GITHUB_TOKEN`，不需要 PAT；组织策略若禁用写权限，需要仓库管理员允许 Actions 创建 Release。
- 可在 Actions → Release → Run workflow 选择 main 手动发布首版；其他分支禁止发布。
- 确保安装包、ZIP、blockmap、`latest.yml` 和 `latest-mac.yml` 都是 Release 附件，而不只是 Actions artifacts。只有公开且完整的 Release 才能被客户端发现。
- 没有 Windows 签名证书也可生成安装包，但系统可能显示 SmartScreen 提示。可选的 `WIN_CSC_LINK` 和 `WIN_CSC_KEY_PASSWORD` Secrets 分别提供签名证书及密码；不能把证书或密码提交到仓库。
- 目前不自动发布 Linux。Mac 自动更新必须使用正式签名包，不支持用未签名或临时 ad-hoc 签名的 DMG 代替。

## Mac 签名与公证

在仓库 Settings → Secrets and variables → Actions 配置以下 Secrets。不要把证书、密码或密钥提交到 Git 或发送到对话中。

| Secret | 内容 |
| --- | --- |
| `MAC_CSC_LINK` | 包含私钥的 **Developer ID Application** `.p12` 证书的 base64 内容，不是 Mac App Store 证书 |
| `MAC_CSC_KEY_PASSWORD` | 导出 `.p12` 时设置的密码，需非空 |
| `APPLE_ID` | 有权公证此应用的 Apple 开发者账号 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 该账号生成的 App 专用密码，不是登录密码 |
| `APPLE_TEAM_ID` | 与签名证书一致的 Apple 开发者团队 ID |

需要 Apple Developer Program 账号。没有这些凭证时可继续开发，但正式 Mac 发布会明确失败，不会跳过签名或假报公证成功。即使打包器未执行公证，后续 `stapler validate` 也会阻止发布。

后续版本应保持 `appId: com.fynvra.app` 和签名团队一致；换团队或从旧未签名包迁移时，应先手动重新安装正式签名版。工作流使用 `macos-15` 的 Apple Silicon runner，一次构建两个架构，避免各自覆盖同名更新元数据。

## 本地验证

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:updates
pnpm exec electron-builder --win nsis --x64 --publish never "--config.extraMetadata.version=0.1.1"
pnpm release:verify dist 0.1.1
```

Mac 必须在 macOS 上构建，并提前在当前终端环境提供上述公证变量，以及由 `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` 对应的 `CSC_LINK` / `CSC_KEY_PASSWORD`：

```bash
pnpm build
pnpm test:updates
pnpm exec electron-builder --mac --x64 --arm64 --publish never "--config.extraMetadata.version=0.1.1"
pnpm release:verify dist 0.1.1 mac
```

`pnpm package:mac` 也会生成两个架构的签名、公证包，版本使用 `package.json`。不需要发布时不要使用 `--publish always`。

`test:updates` 支持 Windows 和 Mac，使用隐藏的隔离 Electron 实例、临时数据与缓存目录、本机 HTTP 更新源；验证真实下载和哈希校验，但拦截最终安装器，永不执行测试安装文件。Mac 还会拦截原生 Squirrel 的入口，避免给它传入测试 ZIP。工作流同样加载打包后的 `app.asar` 执行联调，而不只验证开发构建；Mac 联调运行 arm64 版本，Intel 包另做架构、签名、公证和文件校验。这不是原生安装升级的替代测试。

上面的命令只生成和校验本地产物，不发布。Windows 机器不能验证 Mac 签名、公证或原生更新。真正的线上闭环仍需首次 GitHub 工作流成功，在 Windows、Intel Mac、Apple Silicon Mac 分别安装首版后再发布一个更高版本，验证客户端能够检查、下载、安装并保留用户数据。
