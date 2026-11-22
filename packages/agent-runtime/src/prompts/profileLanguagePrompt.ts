/**
 * 档位会话（triage / restricted）的输出语言规则：档位会话不读用户的指令文件，
 * 语言取自 Fynvra 的界面语言，由宿主传入语言名（如 `Simplified Chinese`）。
 * 群回复（triage_report 的 reply）仍按 TRIAGE_PROMPT 用反馈者自己的语言。
 */
export function profileLanguagePrompt(language: string): string {
  return `# Output language

Write everything you author in ${language}: your messages in this conversation (including notes before and after tool calls), the \`title\`, \`summary\`, \`evidence\` and \`assessment\` of triage_report, and, in a duty session, dispatch briefs, commit message bodies, and pull request titles and bodies.
Exception: the \`reply\` of triage_report (posted to the chat) still follows the triage rules and uses the reporter's own language.
Keep code, commands, file paths and identifiers as they are; do not translate them.`;
}
