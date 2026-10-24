import { describe, expect, it } from 'vitest';
import { isValidRoleId, parseRole } from './parseRole';

const valid = {
  id: 'test-engineer',
  name: '测试工程师',
  description: 'Writes failing tests first',
  systemPrompt: 'You write tests before implementation.',
  model: { providerId: 'anthropic', modelId: 'claude-opus-5-5', thinking: 'high' },
  skillIds: ['tdd', 'vitest'],
  mcpServerIds: ['github'],
  tools: 'all',
  approvalMode: 'supervised',
};

describe('parseRole', () => {
  it('接受完整角色，原样返回已知字段', () => {
    expect(parseRole(valid)).toEqual({ ok: true, role: valid });
  });

  it('只保留已知字段，丢弃多余键', () => {
    const result = parseRole({ ...valid, extra: 1 });
    expect(result.ok && Object.keys(result.role).sort()).toEqual(Object.keys(valid).sort());
  });

  it('只读自有属性：原型链上的字段不算数', () => {
    const own = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'tools'));
    const input = Object.assign(Object.create({ tools: 'all' }), own);
    const result = parseRole(input);
    expect(!result.ok && result.error).toContain('role.tools');
  });

  it('缺省的 skillIds / mcpServerIds 归一为空数组；可选字段为 null 视为缺省', () => {
    const result = parseRole({
      id: 'reviewer',
      name: 'Reviewer',
      description: null,
      systemPrompt: null,
      model: null,
      builtin: null,
      tools: 'readonly',
      approvalMode: 'full',
    });
    expect(result).toEqual({
      ok: true,
      role: {
        id: 'reviewer',
        name: 'Reviewer',
        skillIds: [],
        mcpServerIds: [],
        tools: 'readonly',
        approvalMode: 'full',
      },
    });
  });

  it('name 去首尾空白，id 列表去重并保持顺序', () => {
    const result = parseRole({ ...valid, name: '  Dev  ', skillIds: ['a', 'b', 'a'] });
    expect(result.ok && result.role.name).toBe('Dev');
    expect(result.ok && result.role.skillIds).toEqual(['a', 'b']);
  });

  it('返回值不与输入共享数组或对象', () => {
    const input = structuredClone(valid);
    const result = parseRole(input);
    if (!result.ok) throw new Error(result.error);
    result.role.skillIds.push('x');
    if (result.role.model) result.role.model.modelId = 'changed';
    expect(input).toEqual(valid);
  });

  it.each<[string, unknown, string]>([
    ['null', null, 'role must be an object'],
    ['字符串', 'worker', 'role must be an object'],
    ['数组', [valid], 'role must be an object'],
    ['缺 id', { ...valid, id: undefined }, 'role.id'],
    ['id 非字符串', { ...valid, id: 7 }, 'role.id'],
    ['id 含大写和空格', { ...valid, id: 'Test Engineer' }, 'role.id'],
    ['id 路径穿越', { ...valid, id: '../evil' }, 'role.id'],
    ['id 以 - 开头', { ...valid, id: '-lead' }, 'role.id'],
    ['id 超过 64 字符', { ...valid, id: 'a'.repeat(65) }, 'role.id'],
    ['缺 name', { ...valid, name: undefined }, 'role.name'],
    ['name 全空白', { ...valid, name: '   ' }, 'role.name'],
    ['description 非字符串', { ...valid, description: 42 }, 'role.description'],
    ['builtin 非布尔', { ...valid, builtin: 'yes' }, 'role.builtin'],
    ['systemPrompt 非字符串', { ...valid, systemPrompt: ['a'] }, 'role.systemPrompt'],
    ['model 非对象', { ...valid, model: 'claude' }, 'role.model'],
    ['model 缺 modelId', { ...valid, model: { providerId: 'anthropic' } }, 'role.model.modelId'],
    [
      'model.providerId 为空',
      { ...valid, model: { providerId: '', modelId: 'm' } },
      'role.model.providerId',
    ],
    [
      'model.thinking 非法',
      { ...valid, model: { providerId: 'p', modelId: 'm', thinking: 'max' } },
      'role.model.thinking',
    ],
    ['skillIds 非数组', { ...valid, skillIds: 'tdd' }, 'role.skillIds'],
    ['skillIds 含非字符串', { ...valid, skillIds: ['tdd', 1] }, 'role.skillIds'],
    ['skillIds 含空串', { ...valid, skillIds: [''] }, 'role.skillIds'],
    ['mcpServerIds 非数组', { ...valid, mcpServerIds: {} }, 'role.mcpServerIds'],
    ['缺 tools', { ...valid, tools: undefined }, 'role.tools'],
    ['tools 非法', { ...valid, tools: 'root' }, 'role.tools'],
    ['缺 approvalMode', { ...valid, approvalMode: undefined }, 'role.approvalMode'],
    ['approvalMode 非法', { ...valid, approvalMode: 'yolo' }, 'role.approvalMode'],
  ])('坏输入：%s', (_label, input, field) => {
    const result = parseRole(input);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(field);
  });
});

describe('isValidRoleId', () => {
  it('小写 slug，1–64 字符，不以 - 开头或结尾', () => {
    for (const id of ['worker', 'qa', 'full-stack-dev', 'v2', 'a'.repeat(64)]) {
      expect(isValidRoleId(id)).toBe(true);
    }
    for (const id of ['', 'A', 'a_b', 'a b', 'a/b', '..', '-a', 'a-', 'a'.repeat(65), 1, null]) {
      expect(isValidRoleId(id)).toBe(false);
    }
  });
});
