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
  /** 本任务对 `report_done` 内容的额外要求（如要附上哪条检查输出），写在契约引用之后；可省略。 */
  reportDoneHint?: string | undefined;
}

// 契约全文是 agent-runtime 的 WORKER_CONTRACT_PROMPT，随 worker 会话的系统提示词下发；
// 任务书末段只用一句话引用它，不再重复一遍
const CONTRACT_REFERENCE =
  'When you finish, or cannot finish, you must call `report_done`; see the Fynvra worker contract in your system prompt.';

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
 * Acceptance 五段，最后固定一段 Worker contract——一句话提醒完成后必须调用 `report_done`、
 * 细则见系统提示词，后面跟本任务的 `reportDoneHint`（有的话）。
 * 换行统一为 LF，空段落 / 空列表写占位文字，纯函数。
 */
export function renderBrief(input: BriefInput): string {
  const title = input.title.replace(/\s+/g, ' ').trim() || 'Untitled task';
  const hint = normalize(input.reportDoneHint ?? '');
  const contract = hint === '' ? CONTRACT_REFERENCE : `${CONTRACT_REFERENCE}\n\n${hint}`;
  const sections: [heading: string, body: string][] = [
    ['Target', paragraph(input.target)],
    ['Change', paragraph(input.change)],
    ['Constraints', bulletList(input.constraints)],
    ['Ownership', paragraph(input.ownership)],
    ['Acceptance', bulletList(input.acceptance)],
    ['Worker contract', contract],
  ];
  return [
    `# ${title}`,
    '',
    `Dispatch: \`${input.dispatchId}\``,
    ...sections.flatMap(([heading, body]) => ['', `## ${heading}`, '', body]),
    '',
  ].join('\n');
}
