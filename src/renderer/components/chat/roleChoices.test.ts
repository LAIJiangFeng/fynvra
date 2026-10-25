import { BUILTIN_ROLES, ORCHESTRATOR_ROLE_ID, type Role, WORKER_ROLE_ID } from '@fynvra/core';
import { describe, expect, it } from 'vitest';
import { translatorOf } from '../../i18n';
import { pickRole, roleChoices, roleDescription } from './roleChoices';

const tester: Role = {
  id: 'tester',
  name: '测试工程师',
  description: '只写测试，不改业务代码',
  skillIds: [],
  mcpServerIds: [],
  tools: 'all',
  approvalMode: 'auto-edits',
};
const library: readonly Role[] = [...BUILTIN_ROLES, tester];

describe('roleDescription', () => {
  const t = translatorOf('zh-CN');
  const builtin = BUILTIN_ROLES[0] as Role;
  it('默认描述跟随界面语言，用户修改后的内置描述不再被翻译文案覆盖', () => {
    expect(roleDescription(builtin, t)).toBe(t('sessions.builtinRoles.orchestrator'));
    expect(roleDescription({ ...builtin, description: '我的职责' }, t)).toBe('我的职责');
    expect(roleDescription(tester, t)).toBe(tester.description);
  });
  it('允许清空内置描述，不重新显示默认描述', () => {
    const { description: _description, ...cleared } = builtin;
    expect(roleDescription(cleared, t)).toBeUndefined();
    expect(roleDescription({ ...builtin, description: '' }, t)).toBe('');
  });
});

describe('roleChoices', () => {
  it('角色库为空（还没读到或读取失败）时退回两个内置角色', () => {
    expect(roleChoices([]).map((role) => role.id)).toEqual([ORCHESTRATOR_ROLE_ID, WORKER_ROLE_ID]);
    expect(roleChoices([]).every((role) => role.builtin)).toBe(true);
  });

  it('读到角色库就原样使用，设置页新建的自定义角色也在其中', () => {
    expect(roleChoices(library)).toBe(library);
    expect(roleChoices(library).map((role) => role.id)).toContain('tester');
  });
});

describe('pickRole', () => {
  it('默认选 orchestrator', () => {
    expect(pickRole(library, ORCHESTRATOR_ROLE_ID)?.id).toBe(ORCHESTRATOR_ROLE_ID);
  });

  it('选中的角色还在列表里就保持选中', () => {
    expect(pickRole(library, 'tester')).toBe(tester);
    expect(pickRole(library, WORKER_ROLE_ID)?.id).toBe(WORKER_ROLE_ID);
  });

  it('选中的角色不在了（如被删除）退回 orchestrator；连 orchestrator 都没有时取第一个', () => {
    expect(pickRole(library, 'removed')?.id).toBe(ORCHESTRATOR_ROLE_ID);
    expect(pickRole([tester], 'removed')).toBe(tester);
    expect(pickRole([], ORCHESTRATOR_ROLE_ID)).toBeUndefined();
  });
});
