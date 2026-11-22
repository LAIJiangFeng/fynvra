import type { UiField, UiNode } from '@shared/types/appPluginUi';
import { describe, expect, it } from 'vitest';
import {
  collectValues,
  commitOn,
  currentValue,
  displayValue,
  draftKey,
  dropScope,
  shouldCommit,
  wireValue,
} from './appPluginForm';

const f = (patch: Partial<UiField> & Pick<UiField, 'kind'>): UiField => ({
  type: 'field',
  id: 'a',
  label: 'A',
  ...patch,
});

describe('appPluginForm', () => {
  it('密码框不回显；select 缺省第一项', () => {
    expect(displayValue(f({ kind: 'password', value: 'secret' }))).toBe('');
    expect(displayValue(f({ kind: 'select', options: [{ value: 'x', label: 'X' }] }))).toBe('x');
    expect(displayValue(f({ kind: 'number', value: 3 }))).toBe('3');
  });

  it('插件改了值后以插件为准，否则用草稿', () => {
    const field = f({ kind: 'text', value: 'old' });
    expect(currentValue(field, { base: 'old', value: 'typing' })).toBe('typing');
    expect(currentValue({ ...field, value: 'new' }, { base: 'old', value: 'typing' })).toBe('new');
  });

  it('提交时机：toggle / select 立即，text / number 失焦或回车', () => {
    expect(commitOn(f({ kind: 'toggle' }))).toBe('change');
    expect(commitOn(f({ kind: 'select', options: [] }))).toBe('change');
    expect(commitOn(f({ kind: 'text' }))).toBe('blur');
    expect(commitOn(f({ kind: 'number' }))).toBe('blur');
  });

  it('失焦提交：没变、非法或越界不提交', () => {
    const num = f({ kind: 'number', value: 5, min: 1, max: 10, action: 'set' });
    expect(shouldCommit(num, { base: 5, value: '7' })).toBe(true);
    expect(shouldCommit(num, { base: 5, value: '5' })).toBe(false);
    expect(shouldCommit(num, { base: 5, value: 'abc' })).toBe(false);
    expect(shouldCommit(num, { base: 5, value: '11' })).toBe(false);
    expect(shouldCommit(num, undefined)).toBe(false);
    expect(shouldCommit(f({ kind: 'number', value: 5 }), { base: 5, value: '7' })).toBe(false);
    const pw = f({ kind: 'password', value: 'secret', action: 'set' });
    expect(shouldCommit(pw, undefined)).toBe(false);
    expect(shouldCommit(pw, { base: 'secret', value: '' })).toBe(false);
    expect(shouldCommit(pw, { base: 'secret', value: 'new' })).toBe(true);
    const text = f({ kind: 'text', action: 'set' });
    expect(shouldCommit(text, { base: undefined, value: '' })).toBe(false);
    expect(shouldCommit(text, { base: undefined, value: 'x' })).toBe(true);
  });

  it('收集同一容器里不带 action 的字段值', () => {
    const siblings: UiNode[] = [
      f({ id: 'note', kind: 'text', value: 'hi' }),
      f({ id: 'count', kind: 'number', value: 2 }),
      f({ id: 'on', kind: 'toggle' }),
      f({ id: 'pw', kind: 'password', value: 'secret' }),
      f({ id: 'live', kind: 'text', action: 'save' }),
      { type: 'button', label: 'Go', action: 'go' },
    ];
    const scope = 'root.0';
    expect(collectValues(siblings, scope, {})).toEqual({ note: 'hi', count: 2, on: false });
    const drafts = {
      [draftKey(scope, 'note')]: { base: 'hi', value: 'changed' },
      [draftKey(scope, 'count')]: { base: 2, value: 'x' },
      [draftKey(scope, 'pw')]: { base: 'secret', value: 'new' },
      [draftKey('root.1', 'note')]: { base: 'hi', value: 'other row' },
    };
    expect(collectValues(siblings, scope, drafts)).toEqual({
      note: 'changed',
      on: false,
      pw: 'new',
    });
    expect(wireValue(f({ kind: 'toggle' }), { base: undefined, value: true })).toBe(true);
  });

  it('dropScope 只丢该容器的草稿', () => {
    const drafts = {
      'root.1#a': { base: undefined, value: 'x' },
      'root.1.0#a': { base: undefined, value: 'y' },
    };
    expect(dropScope(drafts, 'root.1')).toEqual({ 'root.1.0#a': { base: undefined, value: 'y' } });
  });
});
