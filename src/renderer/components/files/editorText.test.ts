import { describe, expect, it } from 'vitest';
import { editorText, fileText } from './editorText';

describe('编辑器换行', () => {
  it('编辑器使用 LF，保存恢复原文件 CRLF', () => {
    expect(editorText('第一行\r\n第二行\r\n')).toBe('第一行\n第二行\n');
    expect(fileText('改后\n新增\n', '第一行\r\n')).toBe('改后\r\n新增\r\n');
  });
  it('LF 和空文件使用 LF，不给未改正文追加换行', () => {
    expect(fileText('正文\n尾行', '')).toBe('正文\n尾行');
    expect(fileText('正文', '原文\n')).toBe('正文');
    expect(editorText('')).toBe('');
  });
});
