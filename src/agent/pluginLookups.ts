import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { PluginRefSpec } from '@shared/types/agent';
import { isPluginProviderName } from '@shared/types/plugins';

/** 插件经 ctx.modelRegistry 按名字查模型服务时落到的 runtime 方法（pi ModelRegistry 外观层的转发目标） */
const TRACKED_METHODS = ['getProvider', 'getAuth', 'getProviderAuthStatus', 'getModel'] as const;
/** 取栈时临时调高的帧数上限：插件代码之上可能叠着 pi 的外观层与若干层工具函数 */
const STACK_TRACE_LIMIT = 50;
/** 栈帧末尾的 `:行:列`，以及可能的右括号 */
const FRAME_POSITION = /:\d+:\d+\)?$/;

export interface PluginLookupTracker {
  /** 会话 spawn 时登记它挂载的插件根路径（规整后的原路径与 realpath 都登记） */
  register(refs: readonly PluginRefSpec[]): void;
  /** 包装共享 runtime 上的按名查询方法：行为与返回值不变，只在旁边记录；同一 runtime 只包装一次 */
  instrument(runtime: ModelRuntime): void;
}

/**
 * 识别插件按哪些名字找过模型服务：调用时取调用栈，栈里有一帧位于某个已登记插件的根路径下（单文件插件为完整路径，
 * 目录插件为「根路径 + /」前缀），就算这个插件发起的查询；匹配不上（如 pi 内部调用）不记录。
 * 只处理第一个参数是字符串且符合插件服务名规则的调用；每个「插件 id + 名字」在本进程只报一次。
 * 记录过程中的任何异常都吞掉，绝不影响原调用。
 *
 * 局限：调用经定时器 / 事件回调发起、栈里已没有插件帧时识别不到；pi 外观层的 getAll() 无法拦截。
 */
export function createPluginLookupTracker(
  onLookup: (pluginId: string, name: string) => void
): PluginLookupTracker {
  /** 规整后的插件根路径 → 插件 id */
  const roots = new Map<string, string>();
  const reported = new Set<string>();
  const instrumented = new WeakSet<object>();

  function note(name: unknown): void {
    if (roots.size === 0 || !isPluginProviderName(name)) return;
    const pluginId = pluginOfStack(captureStack());
    if (!pluginId) return;
    const key = `${pluginId}\0${name}`;
    if (reported.has(key)) return;
    reported.add(key);
    onLookup(pluginId, name);
  }

  function pluginOfStack(stack: string | undefined): string | undefined {
    if (!stack) return undefined;
    for (const line of stack.split('\n')) {
      const path = framePath(line);
      if (!path) continue;
      let best: { root: string; id: string } | undefined;
      for (const [root, id] of roots) {
        if (
          (path === root || path.startsWith(`${root}/`)) &&
          root.length > (best?.root.length ?? -1)
        ) {
          best = { root, id };
        }
      }
      if (best) return best.id;
    }
    return undefined;
  }

  return {
    register(refs) {
      for (const ref of refs) {
        try {
          const normalized = normalizePath(ref.path);
          if (normalized) roots.set(normalized, ref.id);
          const real = normalizePath(realpathSync.native(ref.path));
          if (real) roots.set(real, ref.id);
        } catch {
          // 路径不存在等：原路径已登记（若规整成功），realpath 跳过
        }
      }
    },
    instrument(runtime) {
      if (instrumented.has(runtime)) return;
      instrumented.add(runtime);
      const target = runtime as unknown as Record<string, unknown>;
      for (const method of TRACKED_METHODS) {
        const original = target[method];
        if (typeof original !== 'function') continue;
        target[method] = function (this: unknown, ...args: unknown[]) {
          try {
            note(args[0]);
          } catch {
            // 记录失败不影响原调用
          }
          return (original as (...rest: unknown[]) => unknown).apply(this, args);
        };
      }
    },
  };
}

function captureStack(): string | undefined {
  const previous = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = STACK_TRACE_LIMIT;
    return new Error().stack;
  } finally {
    Error.stackTraceLimit = previous;
  }
}

/** 栈帧 `    at fn (path:1:2)` 或 `    at path:1:2` → 规整后的文件路径；不是文件帧时返回 undefined */
function framePath(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('at ') || !FRAME_POSITION.test(trimmed)) return undefined;
  const withoutPosition = trimmed.replace(FRAME_POSITION, '');
  const open = withoutPosition.lastIndexOf('(');
  const location = open >= 0 ? withoutPosition.slice(open + 1) : withoutPosition.slice(3).trim();
  return normalizePath(location.replace(/^async /, ''));
}

/** 去掉 file:// 前缀，反斜杠统一成 /，去掉末尾的 /；Windows 下转小写 */
function normalizePath(raw: string): string | undefined {
  let path = raw.trim();
  if (path.startsWith('file://')) {
    try {
      path = fileURLToPath(path);
    } catch {
      path = path.replace(/^file:\/\/\/?/, '');
    }
  }
  path = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!path) return undefined;
  return process.platform === 'win32' ? path.toLowerCase() : path;
}
