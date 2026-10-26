import { describe, expect, it } from 'vitest';
import type { DiffFile } from './diff';
import { buildFileTree, type FileTreeNode } from './fileTree';

function file(path: string, status: DiffFile['status'] = 'modified'): DiffFile {
  return { path, status, binary: false, meta: [], hunks: [], additions: 0, deletions: 0 };
}

/** 树 → 便于断言的缩进文本：目录带文件数 */
function outline(nodes: FileTreeNode[], depth = 0): string[] {
  return nodes.flatMap((node) =>
    node.kind === 'file'
      ? [`${'  '.repeat(depth)}${node.name}`]
      : [
          `${'  '.repeat(depth)}${node.name}/ (${node.fileCount})`,
          ...outline(node.children, depth + 1),
        ]
  );
}

describe('buildFileTree', () => {
  it('目录在前、文件在后，按名称排序，并统计目录下的文件数', () => {
    const tree = buildFileTree([
      file('README.md'),
      file('src/b.ts'),
      file('src/a.ts'),
      file('src/lib/util.ts'),
      file('docs/guide.md'),
    ]);
    expect(outline(tree)).toEqual([
      'docs/ (1)',
      '  guide.md',
      'src/ (3)',
      '  lib/ (1)',
      '    util.ts',
      '  a.ts',
      '  b.ts',
      'README.md',
    ]);
  });

  it('压缩只有一个子目录的目录链，完整路径作为 key', () => {
    const tree = buildFileTree([
      file('src/renderer/lib/a.ts'),
      file('src/renderer/lib/__fixtures__/w.json', 'added'),
    ]);
    expect(outline(tree)).toEqual([
      'src/renderer/lib/ (2)',
      '  __fixtures__/ (1)',
      '    w.json',
      '  a.ts',
    ]);
    const [folder] = tree;
    expect(folder?.kind === 'folder' && folder.path).toBe('src/renderer/lib');
    const inner = folder?.kind === 'folder' ? folder.children[0] : undefined;
    expect(inner?.kind === 'folder' && inner.path).toBe('src/renderer/lib/__fixtures__');
  });

  it('同一路径的两个条目（类型变更）都保留', () => {
    const tree = buildFileTree([file('x/link', 'deleted'), file('x/link', 'added')]);
    expect(outline(tree)).toEqual(['x/ (2)', '  link', '  link']);
  });

  it('空列表得到空树', () => {
    expect(buildFileTree([])).toEqual([]);
  });
});
