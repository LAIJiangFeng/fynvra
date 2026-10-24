import { renderBrief } from '@fynvra/core';

/** dispatch_task 的 spec 按 renderBrief 的五段拆开后的内容。 */
export interface SpecSections {
  target: string;
  change: string;
  constraints: string[];
  ownership: string;
  acceptance: string[];
}

type SectionKey = keyof SpecSections;

// ORCHESTRATOR_PROMPT 要求按这五段写任务书；用户说中文时主 agent 可能写中文标题
const SECTION_LABELS: Record<SectionKey, readonly string[]> = {
  target: ['target', 'goal', '目标'],
  change: ['change', 'changes', '改动', '变更', '修改'],
  constraints: ['constraints', 'constraint', '约束', '限制'],
  ownership: ['ownership', 'owner', 'scope', '范围', '归属'],
  acceptance: ['acceptance', 'acceptance criteria', '验收', '验收标准'],
};

const LABEL_TO_KEY = new Map<string, SectionKey>(
  (Object.entries(SECTION_LABELS) as [SectionKey, readonly string[]][]).flatMap(([key, labels]) =>
    labels.map((label): [string, SectionKey] => [label, key])
  )
);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 长的在前：先试 `acceptance criteria` 再试 `acceptance`
const LABEL = [...LABEL_TO_KEY.keys()]
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join('|');
const BOLD = '(?:\\*\\*|__)';
const NUMBER = '(?:\\d+[.)]\\s*)?';

/**
 * 段落标签行：`## Target`（标签后只能是行尾或冒号）、`- **Target**: …` / `**Target:** …`、
 * 行首的 `Target: …`。`## Target audience`、`Change the color` 这类不是标签。
 */
const LABEL_LINES = [
  new RegExp(
    `^ {0,3}#{1,6}\\s+${NUMBER}${BOLD}?(${LABEL})${BOLD}?\\s*(?:[:：]\\s*(.*?))?\\s*$`,
    'iu'
  ),
  new RegExp(
    `^ {0,3}(?:[-*+]\\s+)?${NUMBER}${BOLD}(${LABEL})\\s*[:：]?\\s*${BOLD}\\s*[:：]?\\s*(.*)$`,
    'iu'
  ),
  new RegExp(`^(${LABEL})\\s*[:：]\\s*(.*)$`, 'iu'),
];

const FENCE = /^ {0,3}(?:```|~~~)/;
const BULLET = /^ {0,3}(?:[-*+]|\d+[.)])\s+(.*)$/;

function matchLabel(line: string): { key: SectionKey; rest: string } | undefined {
  for (const pattern of LABEL_LINES) {
    const match = pattern.exec(line);
    const key = match ? LABEL_TO_KEY.get((match[1] ?? '').toLowerCase()) : undefined;
    if (match && key) return { key, rest: (match[2] ?? '').trim() };
  }
  return undefined;
}

/** 列表拆成条目（续行去掉缩进并入上一条）；不是列表的文字整体算一条。 */
function toItems(text: string): string[] {
  const preface: string[] = [];
  const items: string[][] = [];
  for (const line of text.split('\n')) {
    const bullet = BULLET.exec(line);
    const current = items.at(-1);
    if (bullet) items.push([bullet[1] ?? '']);
    else if (current) current.push(line.replace(/^ {1,4}/, ''));
    else preface.push(line);
  }
  return [preface, ...items].map((lines) => lines.join('\n').trim()).filter((item) => item !== '');
}

/**
 * 把主 agent 写的 spec 拆成 Target / Change / Constraints / Ownership / Acceptance 五段。
 * 第一个标签之前的内容并入 Change；一个标签都没有时整个 spec 就是 Change。代码块里的内容不当标签。
 */
export function parseSpecSections(spec: string): SpecSections {
  const lines: Record<SectionKey | 'preamble', string[]> = {
    preamble: [],
    target: [],
    change: [],
    constraints: [],
    ownership: [],
    acceptance: [],
  };
  let current: SectionKey | 'preamble' = 'preamble';
  let inFence = false;
  for (const line of spec.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    const label = inFence ? undefined : matchLabel(line);
    if (label === undefined) {
      lines[current].push(line);
      continue;
    }
    if (lines[label.key].length > 0) lines[label.key].push('');
    current = label.key;
    if (label.rest !== '') lines[current].push(label.rest);
  }
  const text = (key: SectionKey | 'preamble') => lines[key].join('\n').trim();
  return {
    target: text('target'),
    change: [text('preamble'), text('change')].filter((part) => part !== '').join('\n\n'),
    constraints: toItems(text('constraints')),
    ownership: text('ownership'),
    acceptance: toItems(text('acceptance')),
  };
}

/** worker 的第一条 prompt：spec 经 {@link parseSpecSections} 套进 renderBrief（五段 + report_done 契约）。 */
export function renderWorkerBrief(input: {
  title: string;
  spec: string;
  dispatchId: string;
}): string {
  return renderBrief({
    title: input.title,
    ...parseSpecSections(input.spec),
    dispatchId: input.dispatchId,
  });
}
