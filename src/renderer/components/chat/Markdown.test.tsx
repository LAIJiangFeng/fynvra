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

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} html />);

describe('Markdown html 开关（README）', () => {
  it('去掉脚本、内嵌框、事件属性、style 与 javascript: 链接', () => {
    const out = html(
      [
        '<script>alert(1)</script>',
        '<iframe src="https://x.test"></iframe>',
        '<img src="https://x.test/a.png" onerror="alert(1)" style="position:fixed">',
        '<p style="color:red" onclick="x()">hi</p>',
        '<a href="javascript:alert(1)">bad</a>',
        '<form action="https://x.test"><input name="q"></form>',
      ].join('\n\n')
    );
    expect(out).not.toMatch(
      /script|iframe|onerror|onclick|style="(?!text-align)|javascript:|form/i
    );
    expect(out).toContain('hi');
    expect(out).toContain('bad');
  });

  it('保留 align 并映射为居中；picture 只保留 img；常见排版标签生效', () => {
    const out = html(
      [
        '<p align="center">',
        '  <picture>',
        '    <source media="(prefers-color-scheme: dark)" srcset="https://x.test/dark.png">',
        '    <img src="https://x.test/logo.png" alt="Logo" width="120">',
        '  </picture>',
        '  <br><sub>small</sub> <strong>bold</strong>',
        '</p>',
        '',
        '<div align="right">r</div>',
        '',
        '<h3 align="center">t</h3>',
      ].join('\n')
    );
    expect(out).toContain('<p style="text-align:center"');
    expect(out).not.toMatch(/<source|srcset/i);
    expect(out).toMatch(
      /<picture>[\s\S]*<img src="https:\/\/x\.test\/logo\.png" alt="Logo" width="120"/
    );
    expect(out).toContain('<sub');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<div style="text-align:right">r</div>');
    expect(out).toContain('<h3 style="text-align:center"');
  });

  it('聊天（html 为 false）不变：HTML 原样当文字', () => {
    const out = renderToStaticMarkup(<Markdown text={'<p align="center"><b>x</b></p>'} />);
    expect(out).not.toContain('<b>');
    expect(out).not.toContain('text-align');
  });

  it('同一 cacheKey 下 html 开关不会复用对方的缓存', () => {
    const text = '<b>x</b>';
    const plain = renderToStaticMarkup(<Markdown text={text} cacheKey="html-k" />);
    const rich = renderToStaticMarkup(<Markdown text={text} cacheKey="html-k" html />);
    expect(plain).not.toContain('<b>');
    expect(rich).toContain('<b>x</b>');
  });
});
