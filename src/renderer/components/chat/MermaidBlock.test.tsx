import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));
vi.mock('@/i18n/I18nProvider', async () => {
  const { translatorOf } = await import('@/i18n');
  return { useT: () => translatorOf('en') };
});

import { Markdown } from './Markdown';
import { renderMermaid, shrinkSvg } from './MermaidBlock';

const removed = vi.fn();
vi.stubGlobal('document', {
  documentElement: { classList: { contains: () => false } },
  querySelector: () => ({ remove: removed }),
});

const block = (code: string) => `\`\`\`mermaid\n${code}\n\`\`\``;

describe('Mermaid 代码块', () => {
  beforeEach(() => vi.clearAllMocks());

  it('非流式渲染成 mock 返回的 SVG，且 securityLevel 为 strict', async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg id="ok"></svg>' });
    await renderMermaid('graph TD; A-->B', false);
    const html = renderToStaticMarkup(<Markdown text={block('graph TD; A-->B')} />);
    expect(html).toContain('<svg id="ok"></svg>');
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: 'strict',
        startOnLoad: false,
        flowchart: { wrappingWidth: 200 },
      })
    );
    expect(mermaid.render).toHaveBeenCalledWith(
      expect.stringMatching(/^fynvra-mermaid-\d+$/),
      'graph TD; A-->B'
    );
  });

  it('render 失败时显示源码与错误行，并清理残留节点', async () => {
    mermaid.render.mockRejectedValue(new Error('Parse error'));
    await renderMermaid('graph oops', false);
    const html = renderToStaticMarkup(<Markdown text={block('graph oops')} />);
    expect(html).toContain('<code>graph oops</code>');
    expect(html).toContain('Failed to render diagram: Parse error');
    expect(removed).toHaveBeenCalled();
  });

  it('shrinkSvg 只缩放根标签的 max-width', () => {
    expect(shrinkSvg('<svg width="100%" style="max-width: 583.17px;"><g/></svg>')).toBe(
      '<svg width="100%" style="max-width: 437.38px;"><g/></svg>'
    );
    const plain = '<svg id="x"><g/></svg>';
    expect(shrinkSvg(plain)).toBe(plain);
    const styled = '<svg id="x"><style>#x{max-width: 100px;}</style></svg>';
    expect(shrinkSvg(styled)).toBe(styled);
  });

  it('流式中是普通代码块，不调用 render', () => {
    const html = renderToStaticMarkup(<Markdown streaming text={block('graph LR; X-->Y')} />);
    expect(html).toContain('<code>graph LR; X--&gt;Y</code>');
    expect(html).toContain('<pre');
    expect(mermaid.render).not.toHaveBeenCalled();
  });
});
