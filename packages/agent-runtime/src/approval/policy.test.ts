import type { ApprovalMode } from '@fynvra/core';
import { describe, expect, it } from 'vitest';
import {
  type ApprovalKind,
  approvalKindOf,
  describeToolCall,
  modeNotifiesOperation,
  modeRequiresApproval,
} from './policy';

describe('approvalKindOf', () => {
  it.each([
    ['bash', 'command'],
    ['powershell', 'command'],
    ['run_checks', 'command'],
    ['write', 'file-write'],
    ['edit', 'file-edit'],
    ['apply_patch', 'file-edit'],
    ['mcp__docs__search', 'mcp'],
    ['mcp__github__create_issue', 'mcp'],
  ])('%s → %s', (toolName, kind) => {
    expect(approvalKindOf(toolName)).toBe(kind);
  });

  it.each([
    'read',
    'grep',
    'find',
    'ls',
    'git_readonly',
    'ask_coordinator',
    'report_done',
    'dispatch_task',
    'list_workers',
    'list_mcp_resources',
    'read_mcp_resource',
    'codemode',
    'toString',
    'constructor',
  ])('%s never needs approval', (toolName) => {
    expect(approvalKindOf(toolName)).toBeNull();
  });
});

describe('notification scope and legacy approval compatibility', () => {
  const kinds: ApprovalKind[] = ['command', 'file-write', 'file-edit', 'mcp'];
  const table: Record<ApprovalMode, ApprovalKind[]> = {
    supervised: ['command', 'file-write', 'file-edit', 'mcp'],
    'auto-edits': ['command', 'mcp'],
    full: [],
  };

  for (const [mode, gated] of Object.entries(table) as [ApprovalMode, ApprovalKind[]][]) {
    it.each(kinds)(`${mode} × %s`, (kind) => {
      expect(modeNotifiesOperation(mode, kind)).toBe(gated.includes(kind));
      expect(modeRequiresApproval(mode, kind)).toBe(false);
    });
  }

  it('treats an unknown mode like supervised for notices without asking for approval', () => {
    for (const kind of kinds) {
      expect(modeNotifiesOperation('yolo' as ApprovalMode, kind)).toBe(true);
      expect(modeRequiresApproval('yolo' as ApprovalMode, kind)).toBe(false);
    }
  });
});

describe('describeToolCall', () => {
  it('shows the full command of command tools', () => {
    const command = 'pnpm install && pnpm test -- --reporter verbose';
    expect(describeToolCall('bash', 'command', { command, timeout: 60 })).toEqual({
      title: 'bash',
      detail: command,
    });
    expect(
      describeToolCall('run_checks', 'command', { dispatch_id: 'dsp_1', command: 'pnpm test' })
    ).toEqual({ title: 'run_checks', detail: 'pnpm test' });
  });

  it('shows the target path of file tools', () => {
    expect(describeToolCall('write', 'file-write', { path: 'src/a.ts', content: 'x' })).toEqual({
      title: 'write',
      detail: 'src/a.ts',
    });
    expect(
      describeToolCall('edit', 'file-edit', {
        path: 'src/b.ts',
        edits: [{ oldText: 'a', newText: 'b' }],
      })
    ).toEqual({ title: 'edit', detail: 'src/b.ts' });
  });

  it('lists every file an apply_patch touches', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@',
      '-old',
      '+new',
      '*** Add File: src/new.ts',
      '+export {};',
      '*** Delete File: src/old.ts',
      '*** Update File: src/c.ts',
      '*** Move to: src/d.ts',
      '*** End Patch',
    ].join('\n');
    expect(describeToolCall('apply_patch', 'file-edit', { input: patch }).detail).toBe(
      ['src/a.ts', 'src/new.ts', 'src/old.ts', 'src/c.ts', 'src/d.ts'].join('\n')
    );
  });

  it('previews MCP arguments as JSON, cut to a readable length', () => {
    expect(describeToolCall('mcp__docs__search', 'mcp', { query: 'pi extensions' })).toEqual({
      title: 'mcp__docs__search',
      detail: '{"query":"pi extensions"}',
    });
    const long = describeToolCall('mcp__docs__search', 'mcp', { query: 'x'.repeat(5_000) });
    expect(long.detail.length).toBeLessThanOrEqual(2_000);
    expect(long.detail.endsWith('…')).toBe(true);
  });

  it('falls back to the argument preview when the expected field is missing', () => {
    expect(describeToolCall('bash', 'command', { cmd: 'ls' }).detail).toBe('{"cmd":"ls"}');
    expect(describeToolCall('write', 'file-write', undefined).detail).toBe('');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeToolCall('mcp__x__y', 'mcp', circular).detail).toBe('');
  });
});
