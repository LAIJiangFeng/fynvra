import type { UiButton, UiField, UiList, UiSection, UiText } from '@shared/types/appPluginUi';
import { describe, expect, it } from 'vitest';
import { layoutNodes } from './appPluginLayout';

const field = (id: string): UiField => ({ type: 'field', id, label: id, kind: 'text' });
const text = (value: string): UiText => ({ type: 'text', text: value });
const button = (action: string): UiButton => ({ type: 'button', label: action, action });
const list: UiList = { type: 'list', items: [] };
const section: UiSection = { type: 'section', title: 's', children: [] };

describe('layoutNodes', () => {
  it('连续的行节点合成一张卡片，keyValue 每项一行', () => {
    const blocks = layoutNodes([
      text('intro'),
      {
        type: 'keyValue',
        items: [
          { label: 'a', value: '1' },
          { label: 'b', value: '2' },
        ],
      },
      field('f'),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'card',
      rows: [
        { type: 'text' },
        { type: 'keyValue', label: 'a' },
        { type: 'keyValue', label: 'b' },
        { type: 'field', buttons: [] },
      ],
    });
  });

  it('list 和嵌套 section 断开分组，并保留原位置', () => {
    const blocks = layoutNodes([text('a'), list, text('b'), section, text('c')]);
    expect(blocks.map((block) => block.type)).toEqual(['card', 'list', 'card', 'section', 'card']);
    expect(blocks[1]).toMatchObject({ index: 1 });
    expect(blocks[3]).toMatchObject({ index: 3 });
  });

  it('field 后紧跟的 text 是说明，其余 text 单独成行', () => {
    const hint = text('hint');
    const [card] = layoutNodes([field('f'), hint, text('alone')]);
    expect(card).toEqual({
      type: 'card',
      rows: [
        { type: 'field', field: field('f'), hint, buttons: [] },
        { type: 'text', text: text('alone') },
      ],
    });
  });

  it('连续的按钮合成一行', () => {
    const [card] = layoutNodes([text('t'), button('a'), button('b'), text('u'), button('c')]);
    expect(card).toEqual({
      type: 'card',
      rows: [
        { type: 'text', text: text('t') },
        { type: 'buttons', buttons: [button('a'), button('b')] },
        { type: 'text', text: text('u') },
        { type: 'buttons', buttons: [button('c')] },
      ],
    });
  });

  it('紧跟 field（含其说明）的按钮并到 field 那一行', () => {
    const [card] = layoutNodes([
      field('token'),
      button('save'),
      button('clear'),
      field('x'),
      text('hint'),
      button('go'),
    ]);
    expect(card).toEqual({
      type: 'card',
      rows: [
        { type: 'field', field: field('token'), buttons: [button('save'), button('clear')] },
        { type: 'field', field: field('x'), hint: text('hint'), buttons: [button('go')] },
      ],
    });
  });
});
