/** {@link renderBrief} 入参：五段任务书与派发信息。 */
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
  /** 工作流任务的当前步骤；普通任务省略，任务书与以前逐字一致。 */
  workflow?: BriefWorkflowContext | undefined;
}

/** 工作流任务书的上下文：第几步、本步说明、之前各步的摘要与退回反馈。 */
export interface BriefWorkflowContext {
  name: string;
  /** 从 0 开始 */
  stepIndex: number;
  stepCount: number;
  stepName: string;
  instructions: string;
  previous: readonly { stepName: string; outcome: 'succeeded' | 'failed'; summary: string }[];
  /** 退回反馈（后续步骤报告的问题，或主 agent 的审查意见） */
  feedback?: string;
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

function workflowSection(context: BriefWorkflowContext): string {
  const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
  const parts = [
    `工作流 ${oneLine(context.name)} · 第 ${context.stepIndex + 1}/${context.stepCount} 步：${oneLine(context.stepName)}`,
    '',
    'You are one step of an automated workflow: do only this step, in this worktree. Earlier steps already worked here; later steps continue from what you leave.',
    '',
    '### Step instructions',
    '',
    paragraph(context.instructions),
    '',
    '### Step verdict',
    '',
    '- This step passes: call `report_done` with outcome `succeeded`.',
    '- You found problems that must be sent back (or you cannot complete this step): call `report_done` with outcome `failed`; the summary must state each problem and how to reproduce it.',
  ];
  if (context.previous.length > 0) {
    parts.push('', '### Earlier steps', '');
    for (const entry of context.previous) {
      parts.push(
        `- **${oneLine(entry.stepName)}** (${entry.outcome}):`,
        ...normalize(entry.summary || '(no summary)')
          .split('\n')
          .map((line) => (line === '' ? '' : `  ${line}`))
      );
    }
  }
  if (context.feedback !== undefined && normalize(context.feedback) !== '') {
    parts.push('', '### Feedback to address', '', normalize(context.feedback));
  }
  return parts.join('\n');
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
    ...(input.workflow ? [['Workflow', workflowSection(input.workflow)] as [string, string]] : []),
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
