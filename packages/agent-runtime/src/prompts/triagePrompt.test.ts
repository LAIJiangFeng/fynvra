import { describe, expect, it } from 'vitest';
import { TRIAGE_PROMPT } from './triagePrompt';

describe('TRIAGE_PROMPT', () => {
  it('每个投递条目恰好调用一次 triage_report', () => {
    expect(TRIAGE_PROMPT).toContain('Call triage_report exactly once for each delivered item');
  });

  it('新功能评估固定为三行格式', () => {
    expect(TRIAGE_PROMPT).toContain('value: pass|fail — <reason>');
    expect(TRIAGE_PROMPT).toContain('reasonable: pass|fail — <reason>');
    expect(TRIAGE_PROMPT).toContain('fits-design: pass|fail — <reason>');
  });

  it('用反馈者的语言回复', () => {
    expect(TRIAGE_PROMPT).toContain("Reply in the reporter's language");
  });
});
