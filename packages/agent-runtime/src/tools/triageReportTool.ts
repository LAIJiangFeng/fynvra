import { type Static, StringEnum, Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { HostResult } from '../host';
import { asRecord } from './args';
import { errorResult, safely, textResult } from './result';

export const TRIAGE_REPORT_TOOL_NAME = 'triage_report';
export const TRIAGE_KINDS = ['bug', 'feature', 'question', 'invalid'] as const;
export type TriageKind = (typeof TRIAGE_KINDS)[number];

/** 各字段的长度上限（字符）；reply 要发到 Telegram 群，单条消息上限 4096 */
export const TRIAGE_LIMITS = {
  title: 200,
  summary: 4_000,
  reply: 3_000,
  evidence: 4_000,
  assessment: 4_000,
  project: 100,
} as const;

export interface TriageReport {
  kind: TriageKind;
  title: string;
  summary: string;
  reply: string;
  evidence?: string;
  assessment?: string;
  needInfo?: boolean;
  /** 转交给本群绑定的另一个项目时填它的项目名（已 trim）；填了以后 reply 不发到群里 */
  project?: string;
}

/** triage_report 背后的 Main 宿主（host-invoke kind 'telegram'，method 'triageReport'）；agent 进程内不发任何消息 */
export interface TriageHost {
  triageReport(report: TriageReport, signal?: AbortSignal): Promise<HostResult>;
}

const triageSchema = Type.Object(
  {
    kind: StringEnum(TRIAGE_KINDS, {
      description:
        'bug: something that used to or should work is broken; feature: a new capability; question: a question or casual chat; invalid: spam, abuse or off-topic.',
    }),
    title: Type.String({ description: `One-line title (max ${TRIAGE_LIMITS.title} characters).` }),
    summary: Type.String({
      description: `What the reporter said and what you found, for the maintainer (max ${TRIAGE_LIMITS.summary}).`,
    }),
    reply: Type.String({
      description: `Plain-text reply posted to the group; required and non-empty for every kind (a short polite refusal for invalid). With needInfo it is the follow-up question (max ${TRIAGE_LIMITS.reply}).`,
    }),
    evidence: Type.Optional(
      Type.String({
        description: `bug only: the file(s) and the cause you found in the code (max ${TRIAGE_LIMITS.evidence}).`,
      })
    ),
    assessment: Type.Optional(
      Type.String({
        description: `feature only: the three questions (valuable? reasonable? fits PRODUCT.md / ARCHITECTURE.md / AGENTS.md?), each with a verdict and the reason citing the docs (max ${TRIAGE_LIMITS.assessment}).`,
      })
    ),
    needInfo: Type.Optional(
      Type.Boolean({
        description:
          'true when a bug cannot be located yet, or a feature request is too unclear to assess, and reply asks for the missing details.',
      })
    ),
    project: Type.Optional(
      Type.String({
        description: `Only when the delivered message lists other projects bound to this group and the feedback clearly belongs to one of them rather than to this repository: that project's name, exactly as listed (max ${TRIAGE_LIMITS.project}). Omit it in every other case. When set, this reply is not posted to the group; the feedback is handed over to that project's triage instead.`,
      })
    ),
  },
  { additionalProperties: false }
);

/** 校验参数（枚举、字符串、长度）；不合法时返回给模型看的英文原因 */
export function parseTriageReport(raw: unknown): TriageReport | string {
  const args = asRecord(raw);
  if (!(TRIAGE_KINDS as readonly unknown[]).includes(args.kind)) {
    return `kind must be one of ${TRIAGE_KINDS.join(', ')}`;
  }
  const kind = args.kind as TriageKind;
  const report: TriageReport = { kind, title: '', summary: '', reply: '' };
  for (const key of ['title', 'summary', 'reply', 'evidence', 'assessment'] as const) {
    const value = args[key];
    const optional = key === 'evidence' || key === 'assessment';
    if (value === undefined && optional) continue;
    if (typeof value !== 'string' || value.trim() === '')
      return `${key} must be a non-empty string`;
    if (value.length > TRIAGE_LIMITS[key]) {
      return `${key} is too long (${value.length} characters, max ${TRIAGE_LIMITS[key]})`;
    }
    report[key] = value;
  }
  if (args.needInfo !== undefined) {
    if (typeof args.needInfo !== 'boolean') return 'needInfo must be a boolean';
    if (args.needInfo && kind !== 'bug' && kind !== 'feature') {
      return 'needInfo is only for kind "bug" or "feature"';
    }
    report.needInfo = args.needInfo;
  }
  if (args.project !== undefined) {
    if (typeof args.project !== 'string') return 'project must be a string';
    const project = args.project.trim();
    if (project.length > TRIAGE_LIMITS.project) {
      return `project is too long (${project.length} characters, max ${TRIAGE_LIMITS.project})`;
    }
    // 只有空白时当作没填
    if (project !== '') report.project = project;
  }
  return report;
}

/** triage_report：分诊会话唯一的输出通道，结论交给 Main 路由 */
export function createTriageReportTool(host: TriageHost): ToolDefinition {
  return defineTool({
    name: TRIAGE_REPORT_TOOL_NAME,
    label: 'Triage report',
    description:
      'Report your triage conclusion for the group messages. Fynvra posts `reply` to the group (after filtering) and routes the report; call it once per batch.',
    promptSnippet: 'Report the triage conclusion and the reply for the group',
    parameters: triageSchema,
    executionMode: 'sequential',
    execute: (_toolCallId, params: Static<typeof triageSchema>, signal) =>
      safely(TRIAGE_REPORT_TOOL_NAME, async () => {
        const report = parseTriageReport(params);
        if (typeof report === 'string') return errorResult(TRIAGE_REPORT_TOOL_NAME, report);
        const result = await host.triageReport(report, signal);
        if (!result.ok) return errorResult(TRIAGE_REPORT_TOOL_NAME, result.error);
        return textResult('Triage report delivered.');
      }),
  });
}
