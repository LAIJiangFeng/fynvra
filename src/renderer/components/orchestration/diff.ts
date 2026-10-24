// reviewDiff 返回的统一 diff 文本 → 按文件的 hunks。纯函数：不碰 DOM，可在 node 下测试。
// 输入来自 `git -c core.quotepath=false diff --no-color --no-ext-diff base...HEAD`（core GitWorktreeManager.diff）。

export type DiffLineKind = 'context' | 'add' | 'del' | 'note';

export interface DiffLine {
  kind: DiffLineKind;
  /** 去掉 ` ` / `+` / `-` 前缀后的内容；`note` 是 `\ No newline at end of file` 原文 */
  text: string;
  /** 旧文件行号（add / note 没有） */
  oldLine?: number;
  /** 新文件行号（del / note 没有） */
  newLine?: number;
}

export interface DiffHunk {
  /** `@@ -a,b +c,d @@ section` 整行 */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';

export interface DiffFile {
  /** 展示路径：新路径；删除的文件取旧路径 */
  path: string;
  /** 重命名 / 复制前的路径 */
  oldPath?: string;
  status: DiffFileStatus;
  binary: boolean;
  /** 模式变化、相似度等扩展头（原文） */
  meta: string[];
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

interface FileDraft {
  file: DiffFile;
  /** `diff --git` 行里的路径：没有 ---/+++ 与 rename 行（二进制、仅模式变化）时用它 */
  headerOld?: string;
  headerNew?: string;
  /** `---` / `+++` 行；`null` 表示 /dev/null */
  oldSide?: string | null;
  newSide?: string | null;
  movedFrom?: string;
  movedTo?: string;
  moveKind?: 'renamed' | 'copied';
  added: boolean;
  deleted: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const META_PREFIXES = [
  'old mode ',
  'new mode ',
  'similarity index ',
  'dissimilarity index ',
  'new file mode ',
  'deleted file mode ',
];

export function parseUnifiedDiff(patch: string): DiffFile[] {
  const lines = patch.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();

  const files: DiffFile[] = [];
  let draft: FileDraft | null = null;
  let hunk: DiffHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;

  for (const line of lines) {
    // hunk 正文按行数计：正文里以 `---` 开头的删除行不能当成文件头
    if (draft && hunk) {
      const marker = line[0];
      if (marker === '\\') {
        hunk.lines.push({ kind: 'note', text: line });
        continue;
      }
      if (oldLeft > 0 || newLeft > 0) {
        if (marker === ' ' || line === '') {
          hunk.lines.push({ kind: 'context', text: line.slice(1), oldLine: oldNo, newLine: newNo });
          oldNo += 1;
          newNo += 1;
          oldLeft -= 1;
          newLeft -= 1;
          continue;
        }
        if (marker === '-') {
          hunk.lines.push({ kind: 'del', text: line.slice(1), oldLine: oldNo });
          draft.file.deletions += 1;
          oldNo += 1;
          oldLeft -= 1;
          continue;
        }
        if (marker === '+') {
          hunk.lines.push({ kind: 'add', text: line.slice(1), newLine: newNo });
          draft.file.additions += 1;
          newNo += 1;
          newLeft -= 1;
          continue;
        }
      }
      // 行数用完或遇到意外内容：hunk 结束，这一行按文件头处理
      hunk = null;
    }

    if (line.startsWith('diff --git ')) {
      if (draft) files.push(finish(draft));
      draft = emptyDraft();
      const paths = parseGitHeaderPaths(line.slice('diff --git '.length));
      draft.headerOld = paths.old;
      draft.headerNew = paths.new;
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header) {
      draft ??= emptyDraft();
      hunk = {
        header: line,
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      draft.file.hunks.push(hunk);
      oldLeft = hunk.oldLines;
      newLeft = hunk.newLines;
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }

    if (line.startsWith('--- ')) {
      // 没有 `diff --git` 头的普通统一 diff：`---` 开启新文件
      if (!draft || draft.oldSide !== undefined || draft.file.hunks.length > 0) {
        if (draft) files.push(finish(draft));
        draft = emptyDraft();
      }
      draft.oldSide = parseSidePath(line.slice(4), 'a/');
      continue;
    }
    if (!draft) continue;

    if (line.startsWith('+++ ')) {
      draft.newSide = parseSidePath(line.slice(4), 'b/');
    } else if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
      draft.moveKind = line.startsWith('rename') ? 'renamed' : 'copied';
      draft.movedFrom = unquote(line.slice(line.indexOf(' from ') + 6));
    } else if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
      draft.moveKind = line.startsWith('rename') ? 'renamed' : 'copied';
      draft.movedTo = unquote(line.slice(line.indexOf(' to ') + 4));
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      draft.file.binary = true;
    } else if (META_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      if (line.startsWith('new file mode ')) draft.added = true;
      else if (line.startsWith('deleted file mode ')) draft.deleted = true;
      else draft.file.meta.push(line);
    }
  }

  if (draft) files.push(finish(draft));
  return files;
}

function emptyDraft(): FileDraft {
  return {
    file: {
      path: '',
      status: 'modified',
      binary: false,
      meta: [],
      hunks: [],
      additions: 0,
      deletions: 0,
    },
    added: false,
    deleted: false,
  };
}

function finish(draft: FileDraft): DiffFile {
  const added = draft.added || draft.oldSide === null;
  const deleted = draft.deleted || draft.newSide === null;
  const newPath = draft.movedTo ?? draft.newSide ?? draft.headerNew;
  const oldPath = draft.movedFrom ?? draft.oldSide ?? draft.headerOld;
  const status: DiffFileStatus =
    draft.moveKind ?? (added ? 'added' : deleted ? 'deleted' : 'modified');
  const path = (status === 'deleted' ? (oldPath ?? newPath) : (newPath ?? oldPath)) ?? '';
  const file: DiffFile = { ...draft.file, path, status };
  if (draft.moveKind && oldPath !== undefined && oldPath !== path) file.oldPath = oldPath;
  return file;
}

/** `---` / `+++` 后的路径：去掉 git 加的 a/ b/ 前缀与路径含空格时追加的 tab。 */
function parseSidePath(raw: string, prefix: 'a/' | 'b/'): string | null {
  const value = raw.startsWith('"') ? unquote(raw) : (raw.split('\t')[0] ?? '');
  if (value === '/dev/null') return null;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** `diff --git a/x b/y` 的两个路径。不带引号且含空格时只能靠「两边相同」或 ` b/` 切分。 */
function parseGitHeaderPaths(rest: string): { old?: string; new?: string } {
  const strip = (value: string, prefix: string) =>
    value.startsWith(prefix) ? value.slice(prefix.length) : value;

  if (rest.startsWith('"')) {
    const first = readQuoted(rest, 0);
    const tail = rest.slice(first.end).trimStart();
    const second = tail.startsWith('"') ? readQuoted(tail, 0).value : tail;
    return { old: strip(first.value, 'a/'), new: strip(second, 'b/') };
  }
  if (rest.endsWith('"')) {
    const split = rest.lastIndexOf(' "');
    if (split > 0) {
      return {
        old: strip(rest.slice(0, split), 'a/'),
        new: strip(readQuoted(rest, split + 1).value, 'b/'),
      };
    }
  }
  const half = (rest.length - 5) / 2;
  if (
    Number.isInteger(half) &&
    rest.startsWith('a/') &&
    rest.slice(half + 2, half + 5) === ' b/' &&
    rest.slice(2, half + 2) === rest.slice(half + 5)
  ) {
    const same = rest.slice(2, half + 2);
    return { old: same, new: same };
  }
  const split = rest.indexOf(' b/');
  if (split < 0) return {};
  return { old: strip(rest.slice(0, split), 'a/'), new: rest.slice(split + 3) };
}

function unquote(raw: string): string {
  return raw.startsWith('"') ? readQuoted(raw, 0).value : raw;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '"': '"',
  '\\': '\\',
};

/** git 的 C 风格引号路径；八进制转义是 UTF-8 字节。`end` 是右引号之后的位置。 */
function readQuoted(source: string, start: number): { value: string; end: number } {
  let value = '';
  let bytes: number[] = [];
  const flushBytes = () => {
    if (bytes.length === 0) return;
    value += new TextDecoder().decode(new Uint8Array(bytes));
    bytes = [];
  };
  let index = start + 1;
  while (index < source.length) {
    const char = source[index] ?? '';
    if (char === '"') {
      flushBytes();
      return { value, end: index + 1 };
    }
    if (char !== '\\') {
      flushBytes();
      value += char;
      index += 1;
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(source.slice(index + 1, index + 4));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 1 + octal[0].length;
      continue;
    }
    flushBytes();
    const escaped = source[index + 1] ?? '';
    value += SIMPLE_ESCAPES[escaped] ?? escaped;
    index += 2;
  }
  flushBytes();
  return { value, end: source.length };
}

/** 一个文件渲染出的行数（含 note），用于决定默认展开与懒渲染。 */
export function diffLineCount(file: DiffFile): number {
  return file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
}

/** `git diff --stat` 的汇总行（最后一行），如 `3 files changed, 10 insertions(+)`。 */
export function statSummary(stat: string): string {
  const lines = stat
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.at(-1) ?? '';
}
