// Fynvra 插件设置页的分组规则（纯函数）：把一组同级节点排成「卡片 + 行」，和 Fynvra 原生设置页一致。
import type {
  UiButton,
  UiField,
  UiList,
  UiNode,
  UiSection,
  UiText,
} from '@shared/types/appPluginUi';

/** 卡片里的一行 */
export type LayoutRow =
  | { type: 'keyValue'; label: string; value: string }
  | { type: 'text'; text: UiText }
  /** hint：紧跟其后的 text 作说明；buttons：紧跟其后的按钮并到同一行 */
  | { type: 'field'; field: UiField; hint?: UiText; buttons: UiButton[] }
  | { type: 'buttons'; buttons: UiButton[] };

/** index 是节点在原数组里的位置，section / list 的 scope 依赖它，不能变 */
export type LayoutBlock =
  | { type: 'card'; rows: LayoutRow[] }
  | { type: 'section'; section: UiSection; index: number }
  | { type: 'list'; list: UiList; index: number };

/**
 * 连续的行节点（keyValue 每项、field、text、连续 button）合成一张卡片，list 和 section 断开并各自成块。
 * field 后紧跟的 text 当说明；之后紧跟的按钮并到 field 那一行；其余连续按钮合成一行。
 */
export function layoutNodes(nodes: readonly UiNode[]): LayoutBlock[] {
  const blocks: LayoutBlock[] = [];
  let rows: LayoutRow[] = [];
  const flush = () => {
    if (rows.length > 0) blocks.push({ type: 'card', rows });
    rows = [];
  };
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i] as UiNode;
    switch (node.type) {
      case 'section':
      case 'list':
        flush();
        blocks.push(
          node.type === 'section'
            ? { type: 'section', section: node, index: i }
            : { type: 'list', list: node, index: i }
        );
        i++;
        break;
      case 'keyValue':
        for (const item of node.items) rows.push({ type: 'keyValue', ...item });
        i++;
        break;
      case 'text':
        rows.push({ type: 'text', text: node });
        i++;
        break;
      case 'field': {
        const row: LayoutRow = { type: 'field', field: node, buttons: [] };
        i++;
        const next = nodes[i];
        if (next?.type === 'text') {
          row.hint = next;
          i++;
        }
        i = takeButtons(nodes, i, row.buttons);
        rows.push(row);
        break;
      }
      case 'button': {
        const buttons: UiButton[] = [];
        i = takeButtons(nodes, i, buttons);
        rows.push({ type: 'buttons', buttons });
        break;
      }
    }
  }
  flush();
  return blocks;
}

/** 从 start 起收下连续的按钮，返回第一个非按钮的位置 */
function takeButtons(nodes: readonly UiNode[], start: number, into: UiButton[]): number {
  let i = start;
  for (let node = nodes[i]; node?.type === 'button'; node = nodes[++i]) into.push(node);
  return i;
}
