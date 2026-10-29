import type { APIRoute } from 'astro';
import { entryRedirectScript } from '../lib/compatibility';

// An endpoint keeps the exact legacy filename: dist/docs.html, not docs.html/index.html.
export const prerender = true;

export const GET: APIRoute = () =>
  new Response(
    `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, follow" />
    <title>Fynvra — 文档入口 / Documentation</title>
    <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg" />
    <script>${entryRedirectScript('docs')}</script>
    <style>
      body {
        margin: 0;
        padding: 3rem 1.5rem;
        font: 1rem/1.6 system-ui, sans-serif;
        color: #e8e8ec;
        background: #111116;
      }
      main { max-width: 38rem; margin: 10vh auto; }
      nav { display: flex; flex-wrap: wrap; gap: 1rem; margin-top: 2rem; }
      a { color: #b6a3ff; text-underline-offset: 0.2em; }
    </style>
  </head>
  <body data-pagefind-ignore>
    <main>
      <h1>Fynvra 文档 / Documentation</h1>
      <p>文档已迁移，正在前往对应文章。也可以选择语言进入概览：</p>
      <p lang="en">The docs have moved. Opening the matching article. You can also choose a language:</p>
      <nav aria-label="选择文档语言 / Choose documentation language">
        <a href="/zh/docs/overview/" lang="zh-CN" hreflang="zh-CN">中文文档</a>
        <a href="/en/docs/overview/" lang="en" hreflang="en">English docs</a>
      </nav>
    </main>
  </body>
</html>`,
    {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }
  );
