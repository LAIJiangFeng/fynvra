/** 计划模式下允许写的文档扩展名（比较时不区分大小写） */
export const DOCUMENT_EXTENSIONS = ['.md', '.markdown'] as const;

// biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拦截 NUL 与控制字符
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** 文件名里不允许的字符：`:` 会指向 NTFS 备用数据流（如 `a.ts:x.md`），其余是 Windows 保留字符 */
const RESERVED_NAME_CHARS = /[<>:"|?*]/;

/**
 * 路径是否指向一份 Markdown 文档：纯字符串判断，不访问文件系统。
 * 要求非空、不含控制字符；文件名（按 `/` 和 `\` 切分后的最后一段）有非空主名，最后一个扩展名在
 * DOCUMENT_EXTENSIONS 中，且不含 `:` 和 `<>"|?*`。
 */
export function isDocumentPath(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath === '' || CONTROL_CHARS.test(filePath)) {
    return false;
  }
  const base = filePath.split(/[/\\]/).pop() ?? '';
  if (RESERVED_NAME_CHARS.test(base)) return false;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  const extension = base.slice(dot).toLowerCase();
  return (DOCUMENT_EXTENSIONS as readonly string[]).includes(extension);
}
