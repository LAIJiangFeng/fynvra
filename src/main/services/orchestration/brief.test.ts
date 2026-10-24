import { describe, expect, it } from 'vitest';
import { parseSpecSections, renderWorkerBrief } from './brief';

describe('parseSpecSections', () => {
  it('按 Markdown 标题拆出五段，列表拆成条目', () => {
    const spec = [
      '## Target',
      'The settings page.',
      '',
      '## Change',
      'Add a dark mode toggle.',
      '',
      '## Constraints',
      '- Keep the existing API.',
      '- No new dependencies;',
      '  reuse the theme helper.',
      '',
      '## Ownership',
      'src/renderer/settings/**',
      '',
      '## Acceptance',
      '1. `pnpm test` passes.',
      '2. The toggle persists.',
    ].join('\n');
    expect(parseSpecSections(spec)).toEqual({
      target: 'The settings page.',
      change: 'Add a dark mode toggle.',
      constraints: ['Keep the existing API.', 'No new dependencies;\nreuse the theme helper.'],
      ownership: 'src/renderer/settings/**',
      acceptance: ['`pnpm test` passes.', 'The toggle persists.'],
    });
  });

  it('认粗体与「标签:」写法（ORCHESTRATOR_PROMPT 的示例格式），标签后的同行内容归入该段', () => {
    const spec = [
      '- **Target**: the login form',
      '- **Change**: validate the email field',
      '**Constraints:** keep it accessible',
      'Ownership: src/login/**',
      '**Acceptance**',
      '- pnpm test',
    ].join('\r\n');
    expect(parseSpecSections(spec)).toEqual({
      target: 'the login form',
      change: 'validate the email field',
      constraints: ['keep it accessible'],
      ownership: 'src/login/**',
      acceptance: ['pnpm test'],
    });
  });

  it('认中文标签与全角冒号，标签不区分大小写，可带编号', () => {
    const spec = [
      '### 1. 目标',
      '设置页',
      '## CHANGE',
      '加暗色开关',
      '约束：不加依赖',
      '**范围**：src/settings/**',
      '## 验收标准',
      '- pnpm test',
    ].join('\n');
    expect(parseSpecSections(spec)).toEqual({
      target: '设置页',
      change: '加暗色开关',
      constraints: ['不加依赖'],
      ownership: 'src/settings/**',
      acceptance: ['pnpm test'],
    });
  });

  it('第一个标签之前的内容并入 Change；没有任何标签时整段都是 Change', () => {
    expect(parseSpecSections('Context first.\n\n## Change\nThe change.')).toMatchObject({
      change: 'Context first.\n\nThe change.',
    });
    expect(parseSpecSections('Just do the thing.\n- with a list')).toEqual({
      target: '',
      change: 'Just do the thing.\n- with a list',
      constraints: [],
      ownership: '',
      acceptance: [],
    });
  });

  it('不是标签的标题、正文与代码块里的内容保持原样', () => {
    const spec = [
      '## Change',
      '## Target audience',
      'Change the button color',
      '```md',
      '## Acceptance',
      '```',
    ].join('\n');
    expect(parseSpecSections(spec)).toEqual({
      target: '',
      change: '## Target audience\nChange the button color\n```md\n## Acceptance\n```',
      constraints: [],
      ownership: '',
      acceptance: [],
    });
  });

  it('同一标签出现两次时内容合并', () => {
    expect(parseSpecSections('## Acceptance\n- a\n## Change\nx\n## Acceptance\n- b')).toMatchObject(
      {
        change: 'x',
        acceptance: ['a', 'b'],
      }
    );
  });
});

describe('renderWorkerBrief', () => {
  it('五段 + worker 契约，dispatch id 写在开头，段落不重复', () => {
    const brief = renderWorkerBrief({
      title: 'Add toggle',
      spec: '## Change\nDo it.\n## Acceptance\n- `pnpm test` passes',
      dispatchId: 'dispatch_1',
    });
    expect(brief.startsWith('# Add toggle\n\nDispatch: `dispatch_1`\n')).toBe(true);
    expect(brief.match(/^## Change$/gm)).toHaveLength(1);
    expect(brief.match(/^## Acceptance$/gm)).toHaveLength(1);
    expect(brief).toContain('## Change\n\nDo it.\n');
    expect(brief).toContain('## Acceptance\n\n- `pnpm test` passes\n');
    expect(brief).toContain('## Target\n\n_Not specified._');
    expect(brief).toContain('## Worker contract');
    expect(brief).toContain('`report_done`');
  });
});
