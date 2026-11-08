import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { locateImportSources } from '../providers/import/locate';

/**
 * 原生 pi 的目录：`~/.pi` 与 pi 的 agent 目录（`PI_CODING_AGENT_DIR`，没设置时 `~/.pi/agent`，同 locateImportSources）。
 * Main 自己的 process.env 不设 PI_CODING_AGENT_DIR（只在 fork worker 时传给子进程），这里读到的是用户环境。
 */
function piDirs(): string[] {
  const home = homedir();
  const agentDir = dirname(locateImportSources(home, process.env).piSettings);
  return [join(home, '.pi'), agentDir];
}

/** a 与 b 相同或 b 在 a 之内（resolve 后比较；path.relative 在 Windows 上不分大小写） */
function containsOrSame(a: string, b: string): boolean {
  const rel = relative(resolve(a), resolve(b));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 最后一道保险：路径位于原生 pi 目录之内、等于它或包含它时返回 true，调用方一律拒绝删除，只记不带路径的 warning。
 * 与受管根目录的配置无关，哪怕根目录配错也绝不删到 `~/.pi` 里的东西。
 */
export function isPiProtectedPath(path: string): boolean {
  return piDirs().some((dir) => containsOrSame(dir, path) || containsOrSame(path, dir));
}

/** 带 warning 的检查：受保护时记一条不带路径的日志并返回 true */
export function refusePiProtectedDelete(path: string): boolean {
  if (!isPiProtectedPath(path)) return false;
  console.warn('[plugins] refused to delete a path inside the native pi directory');
  return true;
}
