import { BUILTIN_ROLES, isValidRoleId, type Role } from '@fynvra/core';
import { describe, expect, it } from 'vitest';
import { copyRole, newRole, parseRoleImport, roleToJson, suggestRoleId } from './roleTransfer';

const tester: Role = {
  id: 'tester',
  name: '测试工程师',
  systemPrompt: '只写测试',
  skillIds: [],
  mcpServerIds: [],
  tools: 'all',
  approvalMode: 'auto-edits',
};

const builtinIds = BUILTIN_ROLES.map((role) => role.id);

describe('roleTransfer', () => {
  it('suggestRoleId：名称转 slug（纯中文回落 role），撞名加后缀', () => {
    expect(suggestRoleId('Code Reviewer', [])).toBe('code-reviewer');
    expect(suggestRoleId('全栈开发工程师', [])).toBe('role');
    expect(suggestRoleId('全栈开发工程师', ['role', 'role-2'])).toBe('role-3');
    expect(suggestRoleId('worker', builtinIds)).toBe('worker-2');
  });

  it('newRole：合法的空白角色，id 不与已有角色冲突', () => {
    const role = newRole(['role', ...builtinIds]);
    expect(role).toMatchObject({ id: 'role-2', skillIds: [], mcpServerIds: [], tools: 'all' });
    expect(isValidRoleId(role.id)).toBe(true);
  });

  it('copyRole：复制内置角色得到可编辑的自定义角色', () => {
    const orchestrator = BUILTIN_ROLES[0];
    if (!orchestrator) throw new Error('missing builtin');
    const copy = copyRole(orchestrator, builtinIds);
    expect(copy.id).toBe('orchestrator-copy');
    expect(copy.name).toBe(`${orchestrator.name} 副本`);
    expect(copy).not.toHaveProperty('builtin');
    expect(copy.systemPrompt).toBe(orchestrator.systemPrompt);
    expect(copyRole(orchestrator, [...builtinIds, 'orchestrator-copy']).id).toBe(
      'orchestrator-copy-2'
    );
  });

  it('roleToJson：去掉 builtin 标记，末尾换行', () => {
    const json = roleToJson({ ...tester, builtin: true });
    expect(json.endsWith('\n')).toBe(true);
    expect(JSON.parse(json)).toEqual(tester);
  });

  it('parseRoleImport：接受单个角色或数组，id 冲突时改名并计数', () => {
    const single = parseRoleImport(roleToJson(tester), builtinIds);
    expect(single).toEqual({ ok: true, roles: [tester], renamed: 0 });

    const batch = parseRoleImport(
      JSON.stringify([tester, { ...tester, name: '另一个' }, { ...tester, id: 'worker' }]),
      [...builtinIds, 'tester']
    );
    expect(batch).toMatchObject({ ok: true, renamed: 3 });
    expect(batch.ok && batch.roles.map((role) => role.id)).toEqual([
      'tester-2',
      'tester-3',
      'worker-2',
    ]);
  });

  it('parseRoleImport：坏 JSON、空数组、非法角色给出可读错误', () => {
    expect(parseRoleImport('{ nope', [])).toMatchObject({ ok: false });
    expect(parseRoleImport('[]', [])).toMatchObject({ ok: false });
    const invalid = parseRoleImport(JSON.stringify([tester, { id: 'x' }]), []);
    expect(invalid).toMatchObject({ ok: false });
    expect(invalid.ok ? '' : invalid.error).toContain('第 2 个');
  });
});
