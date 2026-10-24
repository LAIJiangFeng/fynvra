// 包内工具，不从 index 导出。core 不 import node:path（renderer 也会打包 core 源码），路径在这里手拼。

import type { CoreFs } from '../fs';
import { newId } from '../orchestration/ids';

const TRAILING_SEPARATORS = /[\\/]+$/;

/** 拼接路径：沿用 `base` 里最后出现的分隔符（Windows 路径保持 `\`），`segments` 须是单段名字。 */
export function joinPath(base: string, ...segments: string[]): string {
  const separator = base.lastIndexOf('\\') > base.lastIndexOf('/') ? '\\' : '/';
  return [base.replace(TRAILING_SEPARATORS, ''), ...segments].join(separator);
}

/** 父目录；没有分隔符时返回 `'.'`。 */
export function parentDir(path: string): string {
  const trimmed = path.replace(TRAILING_SEPARATORS, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (index < 0) return '.';
  // `/a` → `/`，`C:\a` → `C:\`
  return index === 0 || trimmed[index - 1] === ':'
    ? trimmed.slice(0, index + 1)
    : trimmed.slice(0, index);
}

/** 先写同目录临时文件再 rename 覆盖目标；失败时尽力删掉临时文件并把原错误抛出。 */
export async function writeFileAtomic(fs: CoreFs, path: string, content: string): Promise<void> {
  const tempPath = `${path}.${newId('tmp')}`;
  try {
    await fs.writeFile(tempPath, content, 'utf8');
    await fs.rename(tempPath, path);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/** 把未知错误转成一行文本。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
