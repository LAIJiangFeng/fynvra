import { describe, expect, it } from 'vitest';
import { fileExtOf, fileKindOf } from './ChatFileCard';

describe('fileKindOf', () => {
  it('按扩展名分类，不区分大小写', () => {
    expect(fileKindOf('杨新宇.PDF')).toBe('pdf');
    expect(fileKindOf('废标清单.docx')).toBe('word');
    expect(fileKindOf('a.doc')).toBe('word');
    expect(fileKindOf('b.xlsx')).toBe('sheet');
    expect(fileKindOf('c.csv')).toBe('sheet');
    expect(fileKindOf('d.tsv')).toBe('sheet');
    expect(fileKindOf('readme.md')).toBe('other');
    expect(fileKindOf('Makefile')).toBe('other');
  });

  it('没有扩展名时返回空串', () => {
    expect(fileExtOf('Makefile')).toBe('');
    expect(fileExtOf('.env')).toBe('');
    expect(fileExtOf('a.tar.gz')).toBe('gz');
  });
});
