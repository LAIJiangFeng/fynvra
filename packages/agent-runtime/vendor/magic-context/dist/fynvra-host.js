// Fynvra-only lifecycle bridge. Compression remains in upstream Magic Context.
import { AsyncLocalStorage } from "node:async_hooks";

const operations = new AsyncLocalStorage();
const bindings = new Map();
export function fynvraRunSessionOperation(capture, operation) {
  const captured = capture();
  return operations.run({ ...captured, onFailure: () => captured.onFailure("startup") }, operation);
}
// Synchronous bookkeeping at the host's cancellation boundary only: release
// leases/reservations before invalidation, never publish or append context.
export function fynvraRunSessionCleanup(cleanup) {
  return operations.exit(cleanup);
}
export function fynvraOperationActive() {
  const operation = operations.getStore();
  return !operation || operation.isCurrent();
}
export function assertFynvraOperation() {
  if (!fynvraOperationActive())
    throw new Error("Magic Context operation was cancelled");
}
export function fynvraStorageCall(call) {
  assertFynvraOperation();
  try {
    return call();
  } catch (error) {
    // Even upstream best-effort catches must release compaction ownership.
    const operation = operations.getStore();
    if (operation?.isCurrent()) operation.onFailure("runtime");
    throw error;
  }
}

// Empty facade targets avoid Proxy invariants on frozen SDK properties. Methods
// retain their real receiver; the SDK's own stale-context checks still run.
function guardedFacade(target, overrides = {}) {
  return new Proxy({}, {
    get(_target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      assertFynvraOperation();
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? (...args) => {
        assertFynvraOperation();
        return fynvraStorageCall(() => value.apply(target, args));
      } : value;
    }
  });
}

export function fynvraBindSession(pi, sessionId, capture) {
  const binding = {};
  bindings.set(sessionId, binding);
  let shutdownHandlers = 0;
  const wrap = (handler, event, isTool = false) => async (...args) => {
    const operation = capture();
    const shutdown = event === "session_shutdown";
    if (bindings.get(sessionId) !== binding) return;
    const bootReady = pi[Symbol.for("fynvra.magic-context.boot-ok")] === true;
    if (!shutdown && (!bootReady || !operation.isCurrent())) {
      if (isTool) throw new Error("Magic Context is inactive; native compaction is active");
      return;
    }
    const contextIndex = isTool ? 4 : 1;
    const ctx = args[contextIndex];
    const signals = [operation.signal];
    if (isTool && args[2]) signals.push(args[2]);
    const signal = AbortSignal.any(signals);
    const scoped = {
      ...operation,
      isCurrent: () => operation.isCurrent() && !signal.aborted,
      onFailure: (reason) => operation.onFailure(event === "session_start" ? "startup" : reason)
    };
    return operations.run(scoped, async () => {
      try {
        if (ctx && !shutdown) {
          // Capture the manager while the SDK context is still valid. Every
          // later access and method call is checked, including appendCompaction.
          const manager = guardedFacade(ctx.sessionManager);
          args[contextIndex] = guardedFacade(ctx, { sessionManager: manager, signal });
        }
        if (isTool) args[2] = signal;
        if (event === "context") {
          args[0] = { ...args[0], messages: structuredClone(args[0].messages) };
        }
        const result = await handler(...args);
        return scoped.isCurrent() ? result : undefined;
      } catch (error) {
        if (!shutdown && scoped.isCurrent()) operation.onFailure(event === "session_start" ? "startup" : "context");
        if (isTool) throw error;
        // Native compaction / unmodified context remains available.
        return;
      } finally {
        if (shutdown && --shutdownHandlers === 0 && bindings.get(sessionId) === binding) bindings.delete(sessionId);
      }
    });
  };
  return new Proxy({}, {
    get(_target, key) {
      if (key === "on") return (event, handler) => {
        assertFynvraOperation();
        if (event === "session_shutdown") shutdownHandlers++;
        return pi.on(event, wrap(handler, event));
      };
      if (key === "registerTool") return (tool) => {
        assertFynvraOperation();
        pi.registerTool({ ...tool, execute: wrap(tool.execute, "tool", true) });
      };
      // Fynvra exposes no terminal plugin commands; do not register hidden
      // recomp/wrapup/update entry points that bypass the hosted lifecycle.
      if (key === "registerCommand" || key === "registerShortcut") return () => {};
      const value = Reflect.get(pi, key, pi);
      if (typeof value !== "function") return value;
      return (...args) => {
        assertFynvraOperation();
        return value.apply(pi, args);
      };
    }
  });
}
