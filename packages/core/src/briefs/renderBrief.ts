/** {@link renderBrief} 入参：Orca 式五段任务书 + 派发信息。 */
export interface BriefInput {
  /** 任务标题（会被压成一行）。 */
  title: string;
  /** Target：涉及的文件、组件或环境。 */
  target: string;
  /** Change：要产出的具体结果。 */
  change: string;
  /** Constraints：不变量、兼容性要求、不许碰的边界。 */
  constraints: readonly string[];
  /** Ownership：这个 worker 可以改哪些文件，以及与其他任务的协作边界。 */
  ownership: string;
  /** Acceptance：可观察的验收标准（测试、输出、证据）。 */
  acceptance: readonly string[];
  /** 本次尝试的 dispatch id。 */
  dispatchId: string;
  /** 对 `report_done` 内容的额外要求（如要附上哪条检查输出）；可省略。 */
  reportDoneHint?: string;
}

// 契约段固定写在最后；多行条目在列表里自动缩进续行
const COMMIT_RULE =
  "Commit your changes on this worktree's branch: only committed work is reviewed and merged.";
const REPORT_DONE_RULE = [
  'When you are done, or cannot finish, call `report_done` exactly once with `outcome`',
  '(`succeeded` or `failed`), a short `summary`, and `files_modified` listing the files you',
  'changed. Do not end your turn without it, and do not call it again afterwards.',
].join('\n');
const ASK_RULE = [
  'If you are blocked or need a decision, call `ask_coordinator` with one concrete question and',
  'wait for the reply instead of guessing.',
].join('\n');

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

function paragraph(text: string): string {
  const body = normalize(text);
  return body === '' ? '_Not specified._' : body;
}

function bulletList(items: readonly string[]): string {
  const bullets = items
    .map(normalize)
    .filter((item) => item !== '')
    .map((item) =>
      item
        .split('\n')
        .map((line, index) => (index === 0 ? `- ${line}` : line === '' ? '' : `  ${line}`))
        .join('\n')
    );
  return bullets.length === 0 ? '_None._' : bullets.join('\n');
}

/**
 * 渲染 worker 任务书（Markdown）：标题 + dispatch id，Target / Change / Constraints / Ownership /
 * Acceptance 五段，最后固定一段 worker 契约——提交改动、完成时调用且只调用一次 `report_done`、
 * 有疑问用 `ask_coordinator`。换行统一为 LF，空段落 / 空列表写占位文字，纯函数。
 */
export function renderBrief(input: BriefInput): string {
  const title = input.title.replace(/\s+/g, ' ').trim() || 'Untitled task';
  const contract = [
    COMMIT_RULE,
    REPORT_DONE_RULE,
    ...(input.reportDoneHint === undefined ? [] : [input.reportDoneHint]),
    ASK_RULE,
  ];
  const sections: [heading: string, body: string][] = [
    ['Target', paragraph(input.target)],
    ['Change', paragraph(input.change)],
    ['Constraints', bulletList(input.constraints)],
    ['Ownership', paragraph(input.ownership)],
    ['Acceptance', bulletList(input.acceptance)],
    ['Worker contract', bulletList(contract)],
  ];
  return [
    `# ${title}`,
    '',
    `Dispatch: \`${input.dispatchId}\``,
    ...sections.flatMap(([heading, body]) => ['', `## ${heading}`, '', body]),
    '',
  ].join('\n');
}
