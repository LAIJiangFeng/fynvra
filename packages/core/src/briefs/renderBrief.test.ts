import { describe, expect, it } from 'vitest';
import { type BriefInput, renderBrief } from './renderBrief';

const input: BriefInput = {
  title: 'Add JSON parser',
  target: '`packages/core/src/parser/`',
  change: 'Implement `parseJson(text)` returning `{ ok, value | error }`.',
  constraints: ['No third-party dependencies.', 'Keep the public API documented with TSDoc.'],
  ownership: 'Only `packages/core/src/parser/**`.',
  acceptance: ['`pnpm test` passes.', 'Bad input returns `{ ok: false }`.'],
  dispatchId: 'dispatch_abc',
  reportDoneHint: 'Paste the `pnpm test` summary line into `summary`.',
};

describe('renderBrief', () => {
  it('五段任务书 + 末尾一句话引用系统提示词里的 worker 契约', () => {
    expect(renderBrief(input)).toBe(
      [
        '# Add JSON parser',
        '',
        'Dispatch: `dispatch_abc`',
        '',
        '## Target',
        '',
        '`packages/core/src/parser/`',
        '',
        '## Change',
        '',
        'Implement `parseJson(text)` returning `{ ok, value | error }`.',
        '',
        '## Constraints',
        '',
        '- No third-party dependencies.',
        '- Keep the public API documented with TSDoc.',
        '',
        '## Ownership',
        '',
        'Only `packages/core/src/parser/**`.',
        '',
        '## Acceptance',
        '',
        '- `pnpm test` passes.',
        '- Bad input returns `{ ok: false }`.',
        '',
        '## Worker contract',
        '',
        'When you finish, or cannot finish, you must call `report_done`; see the Fynvra worker contract in your system prompt.',
        '',
        'Paste the `pnpm test` summary line into `summary`.',
        '',
      ].join('\n')
    );
  });

  it('worker 契约永远是最后一节，只引用系统提示词，不重复契约正文', () => {
    const brief = renderBrief({ ...input, reportDoneHint: undefined });
    const sections = [...brief.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(sections).toEqual([
      'Target',
      'Change',
      'Constraints',
      'Ownership',
      'Acceptance',
      'Worker contract',
    ]);
    const contract = brief.slice(brief.indexOf('## Worker contract'));
    expect(contract).toContain('you must call `report_done`');
    expect(contract).toContain('worker contract in your system prompt');
    // 契约正文（只调一次、提交、ask_coordinator、files_modified）只在 agent-runtime 的 WORKER_CONTRACT_PROMPT 里
    for (const rule of ['exactly once', 'ommit', 'ask_coordinator', 'files_modified']) {
      expect(contract).not.toContain(rule);
    }
    expect(contract.trimEnd().split('\n')).toHaveLength(3);
  });

  it('reportDoneHint 规范化后另起一段；空白的提示被忽略', () => {
    expect(renderBrief({ ...input, reportDoneHint: '  Attach the\r\nlint output.  ' })).toMatch(
      /in your system prompt\.\n\nAttach the\nlint output\.\n$/
    );
    expect(renderBrief({ ...input, reportDoneHint: ' \n ' })).toMatch(/in your system prompt\.\n$/);
  });

  it('多行列表项缩进续行；空白项被忽略；空列表写 _None._', () => {
    const brief = renderBrief({
      ...input,
      constraints: ['First line\nsecond line', '   ', ''],
      acceptance: [],
    });
    expect(brief).toContain('## Constraints\n\n- First line\n  second line\n\n## Ownership');
    expect(brief).toContain('## Acceptance\n\n_None._\n\n## Worker contract');
  });

  it('统一换行为 LF，去首尾空白；标题压成一行；空段落写 _Not specified._', () => {
    const brief = renderBrief({
      ...input,
      title: '  Fix\r\n login  ',
      target: '\r\n  src/auth.ts  \r\n',
      change: 'Line one\r\nLine two',
      ownership: '   ',
    });
    expect(brief.startsWith('# Fix login\n')).toBe(true);
    expect(brief).toContain('## Target\n\nsrc/auth.ts\n\n## Change\n\nLine one\nLine two\n\n');
    expect(brief).toContain('## Ownership\n\n_Not specified._\n');
    expect(brief).not.toContain('\r');
  });

  it('标题为空时用 Untitled task', () => {
    expect(renderBrief({ ...input, title: ' \n ' }).startsWith('# Untitled task\n')).toBe(true);
  });
});
