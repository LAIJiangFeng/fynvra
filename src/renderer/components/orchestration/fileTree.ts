// DiffFile[] → 目录树（VS Code 源代码管理的树视图）。纯函数：不碰 DOM，可在 node 下测试。
import type { DiffFile } from './diff';

export interface FileTreeFolder {
  kind: 'folder';
  /** 显示名；单子目录链压缩成 `a/b/c` */
  name: string;
  /** 从根开始的完整目录路径，作为折叠状态的 key */
  path: string;
  /** 子树里的文件总数 */
  fileCount: number;
  children: FileTreeNode[];
}

export interface FileTreeFile {
  kind: 'file';
  name: string;
  file: DiffFile;
}

export type FileTreeNode = FileTreeFolder | FileTreeFile;

interface Draft {
  folders: Map<string, Draft>;
  files: DiffFile[];
}

/** 按路径段分组；同级目录在前、文件在后，各自按名称排序；只有一个子目录且没有文件的目录与子目录合并。 */
export function buildFileTree(files: readonly DiffFile[]): FileTreeNode[] {
  const root: Draft = { folders: new Map(), files: [] };
  for (const file of files) {
    const segments = file.path.split('/').filter((segment) => segment !== '');
    segments.pop();
    let node = root;
    for (const segment of segments) {
      let next = node.folders.get(segment);
      if (!next) {
        next = { folders: new Map(), files: [] };
        node.folders.set(segment, next);
      }
      node = next;
    }
    node.files.push(file);
  }
  return toNodes(root, '');
}

function toNodes(draft: Draft, prefix: string): FileTreeNode[] {
  const folders: FileTreeFolder[] = [];
  for (const [segment, child] of draft.folders) {
    let name = segment;
    let node = child;
    // 压缩单子目录链：a → b → c 只显示一行 a/b/c
    while (node.files.length === 0 && node.folders.size === 1) {
      const [[nextName, next]] = [...node.folders] as [[string, Draft]];
      name = `${name}/${nextName}`;
      node = next;
    }
    const path = `${prefix}${name}`;
    const children = toNodes(node, `${path}/`);
    folders.push({ kind: 'folder', name, path, fileCount: countFiles(children), children });
  }
  folders.sort((a, b) => compareNames(a.name, b.name));
  const files: FileTreeFile[] = draft.files
    .map((file) => ({ kind: 'file' as const, name: baseName(file.path), file }))
    .sort((a, b) => compareNames(a.name, b.name) || compareNames(a.file.status, b.file.status));
  return [...folders, ...files];
}

function countFiles(nodes: readonly FileTreeNode[]): number {
  return nodes.reduce((sum, node) => sum + (node.kind === 'file' ? 1 : node.fileCount), 0);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function compareNames(a: string, b: string): number {
  const lower = a.toLowerCase().localeCompare(b.toLowerCase(), 'en');
  return lower !== 0 ? lower : a < b ? -1 : a > b ? 1 : 0;
}
