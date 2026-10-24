import type { HostResult } from '@fynvra/agent-runtime';
import { errorMessage } from '@shared/guards';

export function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** Host 方法不向工具抛异常：意外异常也转成 `{ ok: false, error }`。 */
export async function guard<T extends object>(
  run: () => Promise<HostResult<T>>
): Promise<HostResult<T>> {
  try {
    return await run();
  } catch (error) {
    return fail(errorMessage(error));
  }
}

/** {@link untilAborted} 在中止时返回的标记。 */
export const ABORTED: unique symbol = Symbol('aborted');

/** 等 `promise`；`signal` 中止时提前返回 {@link ABORTED}（不取消 `promise` 本身）。 */
export function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T | typeof ABORTED> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}
