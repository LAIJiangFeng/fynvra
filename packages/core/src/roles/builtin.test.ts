import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  getBuiltinRole,
  isBuiltinRoleId,
  ORCHESTRATOR_ROLE_ID,
  WORKER_ROLE_ID,
} from './builtin';
import { parseRole } from './parseRole';

describe('BUILTIN_ROLES', () => {
  it('恰好是 orchestrator 与 worker，且都标记为内置', () => {
    expect(BUILTIN_ROLES.map((role) => role.id)).toEqual([ORCHESTRATOR_ROLE_ID, WORKER_ROLE_ID]);
    expect(ORCHESTRATOR_ROLE_ID).toBe('orchestrator');
    expect(WORKER_ROLE_ID).toBe('worker');
    for (const role of BUILTIN_ROLES) expect(role.builtin).toBe(true);
  });

  it('orchestrator：编排工具集 + full 审批，系统提示词写清 §6 工作循环', () => {
    const role = getBuiltinRole(ORCHESTRATOR_ROLE_ID);
    expect(role?.tools).toBe('orchestrator');
    expect(role?.approvalMode).toBe('full');
    const prompt = role?.systemPrompt ?? '';
    // 派活 → 监控 → 验收合并 / 打回 → 汇报，每一步都点名对应工具
    for (const tool of [
      'dispatch_task',
      'wait_for_workers',
      'send_to_worker',
      'review_diff',
      'run_checks',
      'merge_worktree',
      'cleanup_worktree',
      'reject_work',
    ]) {
      expect(prompt).toContain(`\`${tool}\``);
    }
    expect(prompt).toMatch(/never implement anything yourself/i);
    expect(prompt).toMatch(/do not edit files/i);
    expect(prompt).toMatch(/report/i);
  });

  it('worker：全部工具 + auto-edits，没有系统提示词', () => {
    const role = getBuiltinRole(WORKER_ROLE_ID);
    expect(role?.tools).toBe('all');
    expect(role?.approvalMode).toBe('auto-edits');
    expect(role?.systemPrompt).toBeUndefined();
    expect(role?.skillIds).toEqual([]);
    expect(role?.mcpServerIds).toEqual([]);
  });

  it('内置角色自身能通过 parseRole', () => {
    for (const role of BUILTIN_ROLES) {
      expect(parseRole(role)).toEqual({ ok: true, role });
    }
  });

  it('常量被深度冻结；getBuiltinRole 返回可随意修改的副本', () => {
    const shared = BUILTIN_ROLES[1];
    expect(Object.isFrozen(BUILTIN_ROLES)).toBe(true);
    expect(Object.isFrozen(shared)).toBe(true);
    expect(Object.isFrozen(shared?.skillIds)).toBe(true);

    const copy = getBuiltinRole(WORKER_ROLE_ID);
    copy?.skillIds.push('tdd');
    expect(getBuiltinRole(WORKER_ROLE_ID)?.skillIds).toEqual([]);
  });

  it('isBuiltinRoleId / getBuiltinRole 只认内置 id', () => {
    expect(isBuiltinRoleId('orchestrator')).toBe(true);
    expect(isBuiltinRoleId('worker')).toBe(true);
    expect(isBuiltinRoleId('tester')).toBe(false);
    expect(isBuiltinRoleId('toString')).toBe(false);
    expect(getBuiltinRole('tester')).toBeUndefined();
  });
});
