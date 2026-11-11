import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n/I18nProvider', async () => {
  const { translatorOf } = await import('@/i18n');
  return { useT: () => translatorOf('en') };
});

import { Markdown } from './Markdown';

const bold = { strong: () => <b>first</b> };
const italic = { strong: () => <i>second</i> };

describe('Markdown 渲染缓存', () => {
  it('同 cacheKey + 同 text 复用已渲染的结果；key、text 或流式不同则重新解析', () => {
    const render = (props: Parameters<typeof Markdown>[0]) =>
      renderToStaticMarkup(<Markdown {...props} />);
    expect(render({ text: '**x**', cacheKey: 'k', components: bold })).toContain('<b>first</b>');
    // 命中缓存：传入的新 components 不会生效
    expect(render({ text: '**x**', cacheKey: 'k', components: italic })).toContain('<b>first</b>');
    expect(render({ text: '**x**', cacheKey: 'k2', components: italic })).toContain(
      '<i>second</i>'
    );
    expect(render({ text: '**y**', cacheKey: 'k', components: italic })).toContain('<i>second</i>');
    expect(render({ text: '**x**', cacheKey: 'k', components: italic, streaming: true })).toContain(
      '<i>second</i>'
    );
    expect(render({ text: '**x**', components: italic })).toContain('<i>second</i>');
  });
});
