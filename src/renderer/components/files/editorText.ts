export function editorText(text: string): string {
  return text.replace(/\r\n|\r/g, '\n');
}

/** 编辑器内部使用 LF；保存沿用原文件第一处换行的格式。 */
export function fileText(text: string, source: string): string {
  const separator = /\r\n|\r|\n/.exec(source)?.[0] ?? '\n';
  return separator === '\n' ? text : text.replaceAll('\n', separator);
}
