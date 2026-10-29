import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';

function readSiteUrl(value) {
  if (!value?.trim()) return undefined;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('SITE_URL must be an absolute HTTP(S) site URL.');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username || url.password || url.search || url.hash || url.pathname !== '/'
  ) {
    throw new Error('SITE_URL must be an HTTP(S) origin, without credentials, path, query, or hash.');
  }
  return url.href;
}

const site = readSiteUrl(process.env.SITE_URL);

export default defineConfig({
  site,
  output: 'static',
  trailingSlash: 'always',
  build: { format: 'directory' },
  integrations: [
    starlight({
      title: 'Fynvra',
      favicon: '/assets/favicon.svg',
      defaultLocale: 'zh',
      locales: {
        zh: { label: '中文', lang: 'zh-CN' },
        en: { label: 'English', lang: 'en' },
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/LAIJiangFeng/fynvra' },
      ],
      customCss: ['./src/styles/docs-theme.css', './src/styles/docs.css'],
      // The original docs have a navigation column and a single reading column.
      tableOfContents: false,
      expressiveCode: {
        themes: ['starlight-dark'],
        useStarlightUiThemeColors: false,
        styleOverrides: {
          borderRadius: '10px',
          codeFontSize: '12.75px',
          codeLineHeight: '1.75',
          codePaddingBlock: '14px',
          codePaddingInline: '16px',
          frames: {
            editorBackground: 'var(--fynvra-code-bg)',
            terminalBackground: 'var(--fynvra-code-bg)',
            frameBoxShadowCssValue: 'none',
          },
        },
      },
      components: {
        Head: './src/components/docs/Head.astro',
        Header: './src/components/starlight/Header.astro',
        ThemeSelect: './src/components/starlight/ThemeToggle.astro',
        Sidebar: './src/components/starlight/Sidebar.astro',
        PageTitle: './src/components/starlight/PageTitle.astro',
        SiteTitle: './src/components/starlight/SiteTitle.astro',
        SocialIcons: './src/components/starlight/SocialIcons.astro',
      },
      pagination: true,
      // Slugs omit the locale: Starlight resolves each translated content entry.
      sidebar: [
        {
          label: '开始使用',
          translations: { en: 'Get started' },
          items: ['docs/overview', 'docs/install', 'docs/quickstart'],
        },
        {
          label: '日常工作',
          translations: { en: 'Daily work' },
          items: ['docs/workspace', 'docs/sessions', 'docs/composer', 'docs/panels'],
        },
        {
          label: '编排与审查',
          translations: { en: 'Orchestration & review' },
          items: ['docs/orchestration', 'docs/tasks', 'docs/approval'],
        },
        {
          label: '配置',
          translations: { en: 'Configuration' },
          items: [
            'docs/providers', 'docs/thinking', 'docs/roles', 'docs/skills',
            'docs/mcp', 'docs/instructions', 'docs/appearance',
          ],
        },
        {
          label: '参考',
          translations: { en: 'Reference' },
          items: ['docs/shortcuts', 'docs/data', 'docs/faq'],
        },
      ],
    }),
    // This replaces Starlight's built-in sitemap when a real site is configured.
    // Without site, its built-in integration skips generation as well.
    ...(site ? [sitemap({
      i18n: { defaultLocale: 'zh', locales: { zh: 'zh-CN', en: 'en' } },
      // Only localized homepages and articles, never compatibility/404 entries.
      filter: (page) => /^\/(?:zh|en)\/(?:docs\/[^/]+\/)?$/.test(new URL(page).pathname),
    })] : []),
  ],
});
