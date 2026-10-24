import { describe, expect, it } from 'vitest';
import { formatCost, formatDuration, formatRelativeTime, formatTokens } from './format';
import { describeTool, dispatchTaskView, prettyArgs, reportDoneView } from './toolDisplay';

describe('format', () => {
  it('formatDuration', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(1_234)).toBe('1.2s');
    expect(formatDuration(12_400)).toBe('12s');
    expect(formatDuration(65_000)).toBe('1m 05s');
  });

  it('formatTokens', () => {
    expect(formatTokens(980)).toBe('980');
    expect(formatTokens(1_000)).toBe('1k');
    expect(formatTokens(1_250)).toBe('1.3k');
    expect(formatTokens(12_400)).toBe('12k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
  });

  it('formatCost：一美分以上两位小数，以下两位有效数字', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(3.4)).toBe('$3.40');
    expect(formatCost(0.123)).toBe('$0.12');
    expect(formatCost(0.0042)).toBe('$0.0042');
    expect(formatCost(0.004)).toBe('$0.004');
    expect(formatCost(0.00001)).toBe('<$0.0001');
  });

  it('formatRelativeTime', () => {
    const now = new Date(2026, 9, 24, 15, 0).getTime();
    expect(formatRelativeTime(now - 30_000, now)).toBe('刚刚');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前');
    expect(formatRelativeTime(new Date(2026, 9, 23, 22, 0).getTime(), now)).toBe('昨天');
    expect(formatRelativeTime(new Date(2026, 8, 3).getTime(), now)).toBe('09-03');
    expect(formatRelativeTime(new Date(2025, 11, 31).getTime(), now)).toBe('2025-12-31');
  });
});

describe('describeTool', () => {
  it('内置工具取关键参数做一行摘要', () => {
    expect(describeTool('bash', { command: 'pnpm test\n  --run' })).toEqual({
      label: '命令',
      family: 'builtin',
      summary: 'pnpm test --run',
    });
    expect(describeTool('read', { path: 'src/a.ts', offset: 10 }).summary).toBe('src/a.ts');
    expect(describeTool('git_readonly', { args: ['log', '--oneline'] }).summary).toBe(
      'log --oneline'
    );
    expect(describeTool('list_workers', {})).toEqual({
      label: '查看 worker',
      family: 'orchestration',
      summary: '',
    });
  });

  it('编排工具与 worker 工具归类', () => {
    expect(describeTool('dispatch_task', { title: '补测试', spec: '…' })).toMatchObject({
      family: 'orchestration',
      summary: '补测试',
    });
    expect(describeTool('report_done', { outcome: 'failed', summary: '卡住了' })).toMatchObject({
      family: 'worker',
      summary: '卡住了',
    });
  });

  it('MCP 与未知工具显示紧凑 JSON，过长截断', () => {
    expect(describeTool('mcp__github__create_issue', { title: 'x' })).toEqual({
      label: 'MCP · github/create_issue',
      family: 'mcp',
      summary: '{"title":"x"}',
    });
    const long = describeTool('custom', { text: 'a'.repeat(500) });
    expect(long.family).toBe('other');
    expect(long.summary).toHaveLength(120);
    expect(long.summary.endsWith('…')).toBe(true);
    expect(describeTool('custom', undefined).summary).toBe('');
  });
});

describe('参数视图', () => {
  it('prettyArgs', () => {
    expect(prettyArgs({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyArgs('raw')).toBe('raw');
    expect(prettyArgs(undefined)).toBe('');
  });

  it('dispatch_task：角色缺省为 worker，丢弃非字符串依赖', () => {
    expect(dispatchTaskView({ title: '拆分', depends_on: ['task_1', 2] })).toEqual({
      title: '拆分',
      role: 'worker',
      dependsOn: ['task_1'],
      spec: '',
    });
    expect(dispatchTaskView({ title: 't', spec: '# 任务书', role: 'tester' })).toMatchObject({
      role: 'tester',
      spec: '# 任务书',
    });
  });

  it('report_done：只认 succeeded / failed', () => {
    expect(
      reportDoneView({ outcome: 'succeeded', summary: 'ok', files_modified: ['a.ts'] })
    ).toEqual({ outcome: 'succeeded', summary: 'ok', filesModified: ['a.ts'] });
    expect(reportDoneView({ outcome: 'maybe' }).outcome).toBeNull();
  });
});
