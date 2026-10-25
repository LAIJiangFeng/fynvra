import type { ActionId } from '@shared/keybindings';
import { useEffect, useLayoutEffect, useRef } from 'react';

type Handler = () => void;

/** 每个动作的处理函数，按登记顺序；最后登记的生效（后挂载的组件更贴近用户当前看到的界面） */
const handlers = new Map<ActionId, Handler[]>();

/** 登记一个动作的处理函数，返回注销函数（可重复调用） */
export function registerActionHandler(action: ActionId, handler: Handler): () => void {
  const entry = () => handler();
  handlers.set(action, [...(handlers.get(action) ?? []), entry]);
  return () => {
    handlers.set(
      action,
      (handlers.get(action) ?? []).filter((registered) => registered !== entry)
    );
  };
}

/** 执行动作；没有组件处理它时返回 false，调用方就不拦截这次按键 */
export function runAction(action: ActionId): boolean {
  const handler = handlers.get(action)?.at(-1);
  if (!handler) return false;
  handler();
  return true;
}

/** 组件挂载期间处理一个全局动作；`enabled` 为 false 时不登记。处理函数每次渲染可以不同 */
export function useActionHandler(action: ActionId, handler: Handler, enabled = true): void {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    return registerActionHandler(action, () => latest.current());
  }, [action, enabled]);
}
