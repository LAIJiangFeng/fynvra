/**
 * 注入的文件系统：core 用到的 `node:fs/promises` 子集。签名与 Node 兼容，Main 可直接传入：
 *
 * ```ts
 * import * as fs from 'node:fs/promises';
 * const roles = new JsonFileRoleStore({ fs, dir: join(app.getPath('userData'), 'roles') });
 * ```
 *
 * 测试可传临时目录上的真实 fs，或只实现这几个方法的假对象。
 */
export interface CoreFs {
  /** 读 UTF-8 文本；不存在时以 `code: 'ENOENT'` 的错误 reject。 */
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  /** 写 UTF-8 文本（覆盖）。 */
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  /** 原子重命名（同目录内替换目标文件）。 */
  rename(oldPath: string, newPath: string): Promise<void>;
  /** 删除文件；不存在时以 `code: 'ENOENT'` 的错误 reject。 */
  unlink(path: string): Promise<void>;
  /** 递归创建目录；已存在不报错。 */
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  /** 列出目录下的条目名；目录不存在时以 `code: 'ENOENT'` 的错误 reject。 */
  readdir(path: string): Promise<string[]>;
}

/** `error` 是否为「文件或目录不存在」（`code === 'ENOENT'`）。 */
export function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}
