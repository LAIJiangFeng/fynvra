import { describe, expect, it } from 'vitest';
import { parseTriageReport, TRIAGE_LIMITS } from './triageReportTool';

const base = { kind: 'bug', title: 't', summary: 's', reply: 'r' };

describe('parseTriageReport', () => {
  it('keeps a valid report and its optional fields', () => {
    expect(
      parseTriageReport({ ...base, evidence: 'src/a.ts: off by one', needInfo: false })
    ).toEqual({ ...base, evidence: 'src/a.ts: off by one', needInfo: false });
  });

  it('refuses unknown kinds, missing or blank strings and wrong types', () => {
    expect(parseTriageReport({ ...base, kind: 'chat' })).toContain('kind must be one of');
    expect(parseTriageReport({ ...base, reply: undefined })).toContain('reply');
    expect(parseTriageReport({ ...base, title: '  ' })).toContain('title');
    expect(parseTriageReport({ ...base, kind: 'invalid', reply: '' })).toContain('reply');
    expect(parseTriageReport({ ...base, kind: 'invalid', reply: undefined })).toContain('reply');
    expect(parseTriageReport({ ...base, evidence: 3 })).toContain('evidence');
    expect(parseTriageReport({ ...base, needInfo: 'yes' })).toContain('needInfo');
  });

  it('refuses fields over their limit', () => {
    const reply = 'x'.repeat(TRIAGE_LIMITS.reply + 1);
    expect(parseTriageReport({ ...base, reply })).toContain('too long');
  });

  it('allows needInfo only for bugs and features', () => {
    expect(parseTriageReport({ ...base, kind: 'question', needInfo: true })).toContain('only for');
    expect(parseTriageReport({ ...base, kind: 'invalid', needInfo: true })).toContain('only for');
    expect(parseTriageReport({ ...base, kind: 'feature', needInfo: true })).toMatchObject({
      needInfo: true,
    });
    expect(parseTriageReport({ ...base, needInfo: true })).toMatchObject({ needInfo: true });
  });
});
