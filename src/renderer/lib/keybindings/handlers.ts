import type { ActionId } from '@shared/keybindings';
import { useEffect, useLayoutEffect, useRef } from 'react';

type Handler = () => void;

/** 每个动作的处理函数，按登记顺序；最后登记的生效（后挂载的组件更贴近用户当前看到的界面） */
const handlers = new Map<ActionId, Handler[]>();
/** 等着处理函数登记的动作；值分辨是哪一次 deferAction，旧的取消函数不会删掉后来的 */
const deferred = new Map<ActionId, object>();

/**
 * 登记一个动作的处理函数，返回注销函数（可重复调用）。
 * 这个动作正等着处理它的组件（{@link deferAction}）时，登记后立即执行一次。
 */
export function registerActionHandler(action: ActionId, handler: Handler): () => void {
  const entry = () => handler();
  handlers.set(action, [...(handlers.get(action) ?? []), entry]);
  if (deferred.delete(action)) entry();
  return () => {
    handlers.set(
      action,
      (handlers.get(action) ?? []).filter((registered) => registered !== entry)
    );
  };
}

/**
 * 处理这个动作的组件还没挂载（如左栏收起时按了「新建会话」：先展开，侧栏里的按钮随后挂载）：
 * 下一个登记它的处理函数一登记就执行一次，已经登记着的不算。返回取消函数（可重复调用）
 */
export function deferAction(action: ActionId): () => void {
  const request = {};
  deferred.set(action, request);
  return () => {
    if (deferred.get(action) === request) deferred.delete(action);
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
