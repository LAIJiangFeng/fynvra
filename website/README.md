# Fynvra 官网与文档

`website/` 是独立的 Astro 静态网站，首页保留 Fynvra 的产品介绍与演示，文档使用 Starlight 的导航、上一页/下一页和默认 Pagefind 搜索。网站固定使用 Astro 5.18.0、Starlight 0.37.6 和 `@astrojs/sitemap` 3.6.0。

## 安装与开发

需要 Node.js 22.19.0 或更新的受支持 LTS 版本，以及 pnpm 10.26.2。以下命令从仓库根目录开始：

```sh
cd website
pnpm install --frozen-lockfile
pnpm dev
```

构建与本地预览也在 `website/` 中执行：

```sh
pnpm build
pnpm preview
```

`dev` 用于编辑页面；Pagefind 搜索索引在生产构建时生成，搜索体验需在构建后的 `preview` 或静态部署中查看。

网站有自己的 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` 与 `node_modules/`。不要在根 Electron workspace 中安装网站依赖，也不需要先安装或构建桌面应用。网站依赖变更只更新本目录的清单与锁文件。

## 页面与内容

| 路径或目录 | 用途 |
| --- | --- |
| `/zh/`、`/en/` | 中文、英文产品首页 |
| `/zh/docs/overview/`、`/en/docs/overview/` | 文档概览 |
| `src/pages/[locale]/index.astro`、`src/components/home/`、`src/layouts/HomeLayout.astro` | 首页组件与布局 |
| `src/content/docs/{zh,en}/docs/` | 每种语言 20 篇 Markdown/MDX 文档 |
| `src/content.config.ts` | Starlight `docsLoader()` 与 `docsSchema()` 内容集合 |
| `src/styles/docs.css`、`src/components/docs/Head.astro` | 文档样式与 Head 扩展 |
| `src/components/starlight/` | 文档中的产品首页、下载与 GitHub 出口 |
| `public/assets/` | 原样复制到发布目录的静态资源 |
| `src/lib/` | 旧链接映射与兼容入口的浏览器脚本 |

文档路由为 `/{locale}/docs/{article}/`。默认语言是中文（目录 `zh`，语言标签 `zh-CN`），英文目录与语言标签为 `en`。双语分组侧栏及其顺序在 `astro.config.mjs` 中维护，文章标题来自对应语言的 frontmatter，上一页/下一页沿用侧栏顺序。

两种语言使用相同的 20 个文章 ID：`overview`、`install`、`quickstart`、`workspace`、`sessions`、`composer`、`panels`、`orchestration`、`tasks`、`approval`、`providers`、`thinking`、`roles`、`skills`、`mcp`、`instructions`、`appearance`、`shortcuts`、`data`、`faq`。正文的小节和演示场景 ID 需要保持稳定，供已有书签使用。

首页和兼容入口由 `src/pages/` 负责，Starlight 只根据文档集合生成文章路由。不要在文档集合中添加与 `/`、`/{locale}/` 或 `/{locale}/docs/` 重复的 index 页面。

## 静态发布与 SITE_URL

构建产物是 `website/dist/`。将其中的内容发布到静态托管服务的**站点根路径**，保留文件和目录结构，并让目录 URL 正常返回该目录的 `index.html`。不需要 Node 服务、SSR 适配器或桌面应用运行时。不支持部署到任意子路径；GitHub Pages 等服务需要使用站点根路径或独立域名，而非仓库子路径。

部署应包含全部产物，包括 `_astro/`、`assets/` 和 `pagefind/`。不要配置把所有请求回退到根 `index.html` 的 SPA rewrite，也不要把 `/docs.html` 改写为 `/docs.html/`：它是实际生成的单个 HTML 文件。`/index.html` 则直接使用根入口的构建产物。

没有默认正式域名。可在**构建进程的环境变量**中设置 `SITE_URL`，值为实际部署站点的完整 HTTP(S) origin，可带末尾 `/`，不能含账号密码、子路径、查询参数或 fragment。配置无效时构建配置会报错。Astro 配置通过 `process.env.SITE_URL` 读取它；仅写进 `.env` 文件不会自动生效。

例如在 PowerShell 中，可在 `website/` 目录运行：

```powershell
$env:SITE_URL = Read-Host '输入实际部署站点的 HTTP(S) origin'
pnpm build
```

未设置 `SITE_URL` 时仍可生成和部署静态站点，不生成 sitemap 或带虚构域名的规范链接。设置后，页面使用该地址生成 canonical、`og:url` 等绝对地址，sitemap 只收录中英首页与文章，不收录语言入口、旧链接兼容页、文档目录入口或 404。地址在构建时确定；部署时修改环境变量需要重新构建。

## 旧链接兼容

- `/` 与原 `/index.html`：浏览器按合法的 `?lang=zh|en`、旧 `localStorage` 键 `fynvra-site-locale`、浏览器语言偏好的顺序选择语言，无匹配时使用中文。首页 fragment 会保留，例如 `/index.html?lang=en#features` 前往 `/en/#features`。
- 显式的 `/zh/`、`/en/` 首页始终以路径语言为准，查询参数和存储偏好不会覆盖它。
- `/docs.html`：由 `src/pages/docs.html.ts` 静态生成真实的 `dist/docs.html`。脚本在浏览器读取 fragment 后按 `src/lib/legacy-docs.ts` 中的固定映射跳转，不能改成会丢失 fragment 的服务端重定向。
- 旧文章 hash 指向对应文章顶部，例如 `/docs.html?lang=en#install` 前往 `/en/docs/install/`；旧小节 hash 保留定位，例如 `/docs.html?lang=zh#install-macos` 前往 `/zh/docs/install/#install-macos`。quickstart 的三个演示场景 ID 也在映射中。
- 无 hash、未知 hash 或非法编码回到选定语言的 `docs/overview/`；合法的百分号编码只解码一次。跳转只使用白名单语言与固定的同源路径，不把输入当作 URL。
- `/zh/docs/` 与 `/en/docs/` 提供静态入口，前往各自的文档概览。

这些入口使用 `noindex, follow` 并排除 Pagefind 索引。无 JavaScript 时，根入口和旧文档入口仍可点击中英链接，语言文档入口仍可点击对应概览链接。
