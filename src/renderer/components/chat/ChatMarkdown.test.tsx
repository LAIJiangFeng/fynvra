import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  resolve: vi.fn(),
  openHtml: vi.fn(),
  filesStoreFor: vi.fn(),
  selectSessionOf: vi.fn((id: string) => () => ({ id, workspaceId: 'ws', cwd: 'C:/repo' })),
}));
vi.mock('@/stores/sessions', () => ({
  selectSessionOf: mocks.selectSessionOf,
  useSessionsStore: (select: () => unknown) => select(),
}));
vi.mock('@/stores/files', () => ({ filesStoreFor: mocks.filesStoreFor }));
vi.mock('@/stores/workspaceTabs', () => ({
  ensureWorkspaceTabs: vi.fn(),
  selectWorkspaceTab: vi.fn(),
}));
vi.mock('@/stores/workspaces', () => ({ useWorkspacesStore: { getState: vi.fn() } }));
vi.mock('@/i18n/I18nProvider', async () => {
  const { translatorOf } = await import('@/i18n');
  return { useT: () => translatorOf('en') };
});

import { ChatMarkdown } from './ChatMarkdown';
import { Markdown } from './Markdown';

function render(text: string) {
  return renderToStaticMarkup(<ChatMarkdown sessionId="message-session" text={text} />);
}

describe('聊天 Markdown URL 边界', () => {
  it('保留原始 Windows/file href 给按钮，但不放行到 DOM；渲染不调用文件 API', () => {
    vi.stubGlobal('window', { fynvra: { files: mocks } });
    try {
      const html = render(
        [
          '[absolute](C:/repo/平台与商户功能手工测试清单.md:12:3)',
          '[file](file:///C:/repo/%E6%B8%85%E5%8D%95.md)',
          '[relative](docs/readme.md)',
          '[browser](https://example.test/guide?q=1#intro)',
        ].join('\n\n')
      );
      expect(html).toContain(`title="${encodeURI('C:/repo/平台与商户功能手工测试清单.md:12:3')}"`);
      expect(html).toContain('title="file:///C:/repo/%E6%B8%85%E5%8D%95.md"');
      expect(html).toContain('title="docs/readme.md"');
      expect(html.match(/<button /g)).toHaveLength(3);
      expect(html.match(/href=/g)).toHaveLength(1);
      expect(html).toContain('href="https://example.test/guide?q=1#intro" target="_blank"');
      expect(html).not.toContain('chatHref=');
      expect(mocks.selectSessionOf).toHaveBeenCalledWith('message-session');
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.resolve).not.toHaveBeenCalled();
      expect(mocks.openHtml).not.toHaveBeenCalled();
      expect(mocks.filesStoreFor).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('危险 scheme、纯锚点与原始 HTML 都不能导航/执行', () => {
    const html = render(
      [
        '[js](javascript:alert%281%29)',
        '[data](data:text/html,hello)',
        '[custom](vscode://file/C:/secret)',
        '[anchor](#section)',
        '<script>alert(1)</script>',
        '<a href="file:///C:/private">raw</a>',
      ].join('\n\n')
    );
    expect(html).not.toMatch(/<[a-z]+[^>]*\shref=/i);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('src="javascript:');
    expect(html.match(/<button /g)).toHaveLength(4);
  });

  it('通用 Markdown 仍保持 react-markdown 默认 URL 过滤，文件预览没有启用聊天 transform', () => {
    const html = renderToStaticMarkup(<Markdown text="[file](file:///C:/repo/a.md)" />);
    expect(html).not.toContain('href="file:');
    expect(html).not.toContain('chatHref');
  });
});
