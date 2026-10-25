import {
  ACTION_IDS,
  type ActionId,
  chordFromEvent,
  KEY_ACTIONS,
  type KeyEventLike,
  type ResolvedKeybindings,
} from '@shared/keybindings';

/** 事件目标用到的字段：DOM Element 都有；测试里用普通对象 */
export interface TargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  closest?(selector: string): unknown;
}

export interface GlobalKeyEvent extends KeyEventLike {
  target: unknown;
  defaultPrevented: boolean;
}

const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** 焦点在能打字的地方：文本输入框、文本框、下拉框、contenteditable */
export function isEditableTarget(target: TargetLike | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return tag === 'INPUT' && !NON_TEXT_INPUTS.has((target.type ?? 'text').toLowerCase());
}

/** 焦点在弹窗或设置视图（都是 role=dialog）里 */
export function isInsideDialog(target: TargetLike | null): boolean {
  return Boolean(target?.closest?.('[role="dialog"], [role="alertdialog"]'));
}

/** 全局动作此刻该不该响应：弹窗里都不响应；输入框里只响应标了 allowInInput 的 */
export function shouldRunGlobal(action: ActionId, target: TargetLike | null): boolean {
  if (isInsideDialog(target)) return false;
  return KEY_ACTIONS[action].allowInInput === true || !isEditableTarget(target);
}

/**
 * 全局监听的作用域判断：这次 keydown 该派发哪个全局动作，不该派发时为 null。
 * 组件已经处理过（preventDefault）的按键不再派发；输入框动作由 Composer 自己派发，这里只认全局动作。
 */
export function globalActionOf(
  event: GlobalKeyEvent,
  bindings: ResolvedKeybindings
): ActionId | null {
  if (event.defaultPrevented) return null;
  const chord = chordFromEvent(event);
  if (chord === null) return null;
  const action = ACTION_IDS.find(
    (id) => KEY_ACTIONS[id].scope === 'global' && bindings[id] === chord
  );
  const target = (event.target ?? null) as TargetLike | null;
  return action && shouldRunGlobal(action, target) ? action : null;
}
