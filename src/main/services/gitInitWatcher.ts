import { type FSWatcher, watch } from 'node:fs';

interface Watched {
  path: string;
  watcher: FSWatcher;
  timer?: NodeJS.Timeout;
}

/**
 * 普通目录工作区的根目录上各挂一个非递归 fs.watch：出现或变动名为 `.git` 的条目时
 * （防抖后）回调 `onGitEntry(id)`，用于内置终端里 `git init` 后自动把工作区识别为 git。
 */
export function createGitInitWatcher(
  onGitEntry: (id: string) => void,
  {
    delayMs = 300,
    log = console.warn,
  }: { delayMs?: number; log?: (...args: unknown[]) => void } = {}
) {
  const watched = new Map<string, Watched>();

  const stop = (id: string) => {
    const entry = watched.get(id);
    if (!entry) return;
    watched.delete(id);
    clearTimeout(entry.timer);
    entry.watcher.close();
  };

  const start = (id: string, path: string) => {
    let watcher: FSWatcher;
    try {
      watcher = watch(path, { persistent: false }, (_event, filename) => {
        const entry = watched.get(id);
        // 部分平台不给文件名，宁可多查一次
        if (!entry || (filename && filename.toString() !== '.git')) return;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          entry.timer = undefined;
          onGitEntry(id);
        }, delayMs);
      });
    } catch (error) {
      log(`[workspaces] cannot watch ${path}:`, error);
      return;
    }
    watcher.on('error', (error) => {
      log(`[workspaces] watcher for ${path} failed:`, error);
      if (watched.get(id)?.watcher === watcher) stop(id);
      else watcher.close();
    });
    watched.set(id, { path, watcher });
  };

  return {
    /** 让被监视集合正好等于 `targets`（id → 根目录完整路径）。 */
    sync(targets: ReadonlyMap<string, string>): void {
      for (const [id, entry] of watched) if (targets.get(id) !== entry.path) stop(id);
      for (const [id, path] of targets) if (!watched.has(id)) start(id, path);
    },
    watching(): string[] {
      return [...watched.keys()];
    },
    close(): void {
      for (const id of [...watched.keys()]) stop(id);
    },
  };
}
