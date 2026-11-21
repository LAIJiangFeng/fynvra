import { describe, expect, it } from 'vitest';
import {
  MAX_UI_BYTES,
  normalizeUiActionResult,
  parseOpenLinkInput,
  parsePluginUi,
  parseUiActionInput,
} from './appPluginUi';

const full = {
  children: [
    {
      type: 'section',
      title: '连接',
      children: [
        { type: 'text', text: '第一行\n第二行', tone: 'muted' },
        { type: 'keyValue', items: [{ label: '状态', value: '已连接' }] },
        { type: 'field', id: 'token', label: 'Token', kind: 'password', value: 'secret' },
        {
          type: 'field',
          id: 'limit',
          label: '限额',
          kind: 'number',
          value: 5,
          min: 1,
          max: 10,
          action: 'set-limit',
        },
        { type: 'field', id: 'on', label: '开关', kind: 'toggle', value: true, action: 'toggle' },
        {
          type: 'field',
          id: 'mode',
          label: '模式',
          kind: 'select',
          value: 'a',
          options: [{ value: 'a', label: 'A' }],
        },
        { type: 'button', label: '保存', action: 'save', confirm: '确定？', tone: 'destructive' },
      ],
    },
    {
      type: 'list',
      empty: '没有',
      items: [
        {
          key: 'chat:1',
          title: '群 1',
          subtitle: 'id 1',
          badges: [{ text: '已允许', tone: 'success' }],
          body: '正文',
          link: { label: 'PR', url: 'https://github.com/a/b/pull/1' },
          controls: [
            { type: 'field', id: 'note', label: '备注', kind: 'text' },
            { type: 'button', label: '移除', action: 'remove' },
          ],
        },
      ],
    },
  ],
};

/** 把 children[0] 换成给定节点 */
const one = (node: unknown) => ({ children: [node] });
const nest = (levels: number): unknown => {
  let node: unknown = { type: 'text', text: 'x' };
  for (let i = 1; i < levels; i += 1) node = { type: 'section', title: 's', children: [node] };
  return node;
};

describe('parsePluginUi', () => {
  it('接受全部组件，结果与输入一致', () => {
    expect(parsePluginUi(full)).toEqual(full);
    expect(parsePluginUi({ children: [] })).toEqual({ children: [] });
  });

  it('嵌套恰好 6 层可以，7 层拒绝', () => {
    expect(parsePluginUi(one(nest(6)))).not.toBeNull();
    expect(parsePluginUi(one(nest(7)))).toBeNull();
  });

  it('超过 256 KB 拒绝', () => {
    const texts = Array.from({ length: 70 }, () => ({ type: 'text', text: 'x'.repeat(4000) }));
    expect(new TextEncoder().encode(JSON.stringify({ children: texts })).length).toBeGreaterThan(
      MAX_UI_BYTES
    );
    expect(parsePluginUi({ children: texts })).toBeNull();
  });

  it('列表超过 200 项拒绝', () => {
    const items = Array.from({ length: 201 }, (_, i) => ({ key: `k${i}`, title: 't' }));
    expect(parsePluginUi(one({ type: 'list', items }))).toBeNull();
    expect(parsePluginUi(one({ type: 'list', items: items.slice(0, 200) }))).not.toBeNull();
  });

  it.each([
    ['未知组件', { type: 'html', html: '<b>x</b>' }],
    ['多余的键', { type: 'text', text: 'x', onClick: 'y' }],
    ['非法 id', { type: 'field', id: 'a b', label: 'x', kind: 'text' }],
    ['id 超长', { type: 'field', id: 'a'.repeat(65), label: 'x', kind: 'text' }],
    ['非法 action', { type: 'button', label: 'x', action: 'a/b' }],
    ['标题超长', { type: 'section', title: 'x'.repeat(201), children: [] }],
    ['正文超长', { type: 'text', text: 'x'.repeat(4001) }],
    ['未知 tone', { type: 'text', text: 'x', tone: 'loud' }],
    ['select 没有 options', { type: 'field', id: 'a', label: 'x', kind: 'select' }],
    ['text 带 options', { type: 'field', id: 'a', label: 'x', kind: 'text', options: [] }],
    ['值类型不符', { type: 'field', id: 'a', label: 'x', kind: 'toggle', value: 'yes' }],
    ['number 值不是有限数', { type: 'field', id: 'a', label: 'x', kind: 'number', value: null }],
    [
      'http 链接',
      {
        type: 'list',
        items: [{ key: 'a', title: 't', link: { label: 'l', url: 'http://x.com' } }],
      },
    ],
    [
      'javascript 链接',
      {
        type: 'list',
        items: [{ key: 'a', title: 't', link: { label: 'l', url: 'javascript:alert(1)' } }],
      },
    ],
    [
      '重复的 key',
      {
        type: 'list',
        items: [
          { key: 'a', title: 't' },
          { key: 'a', title: 't' },
        ],
      },
    ],
    [
      'controls 里放 text',
      { type: 'list', items: [{ key: 'a', title: 't', controls: [{ type: 'text', text: 'x' }] }] },
    ],
  ])('%s 拒绝', (_name, node) => {
    expect(parsePluginUi(one(node))).toBeNull();
  });

  it('深处一处不合法整份拒绝；顶层形状不对拒绝', () => {
    const bad = structuredClone(full);
    (bad.children[1] as { items: { link: { url: string } }[] }).items[0].link.url = 'ftp://x';
    expect(parsePluginUi(bad)).toBeNull();
    expect(parsePluginUi([])).toBeNull();
    expect(parsePluginUi({ children: [], extra: 1 })).toBeNull();
    expect(parsePluginUi(null)).toBeNull();
  });
});

describe('IPC 入参', () => {
  it('ui-action 收窄并拒绝多余键', () => {
    expect(
      parseUiActionInput({
        id: 'fynvra.demo',
        action: 'save',
        itemKey: 'k',
        values: { a: 'x', b: 1, c: true },
      })
    ).toEqual({
      id: 'fynvra.demo',
      action: 'save',
      itemKey: 'k',
      values: { a: 'x', b: 1, c: true },
    });
    expect(parseUiActionInput({ id: 'fynvra.demo', action: 'save' })).toEqual({
      id: 'fynvra.demo',
      action: 'save',
    });
    expect(parseUiActionInput({ id: 'fynvra.demo', action: 'save', extra: 1 })).toBeNull();
    expect(parseUiActionInput({ id: '../x', action: 'save' })).toBeNull();
    expect(parseUiActionInput({ id: 'fynvra.demo', action: 'a b' })).toBeNull();
    expect(parseUiActionInput({ id: 'fynvra.demo', action: 's', values: { a: {} } })).toBeNull();
    expect(
      parseUiActionInput({ id: 'fynvra.demo', action: 's', values: { a: Number.NaN } })
    ).toBeNull();
    expect(parseUiActionInput({ id: 'fynvra.demo', action: 's', values: { 'a b': 1 } })).toBeNull();
  });

  it('open-link 只接受 https', () => {
    expect(parseOpenLinkInput({ id: 'fynvra.demo', url: 'https://a.com/x' })).toEqual({
      id: 'fynvra.demo',
      url: 'https://a.com/x',
    });
    expect(parseOpenLinkInput({ id: 'fynvra.demo', url: 'http://a.com' })).toBeNull();
    expect(parseOpenLinkInput({ id: 'fynvra.demo', url: 'file:///C:/x' })).toBeNull();
    expect(parseOpenLinkInput({ id: 'fynvra.demo', url: 'https://a.com', x: 1 })).toBeNull();
  });

  it('插件结果：ok:false 为失败，其余为成功', () => {
    expect(normalizeUiActionResult({ ok: false, error: 'bad' })).toEqual({
      ok: false,
      error: 'bad',
    });
    expect(normalizeUiActionResult(undefined)).toEqual({ ok: true });
    expect(normalizeUiActionResult({ ok: true })).toEqual({ ok: true });
  });
});
