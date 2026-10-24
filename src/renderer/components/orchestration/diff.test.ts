import { describe, expect, it } from 'vitest';
import { diffLineCount, parseUnifiedDiff, statSummary } from './diff';

// 样本取自真实 `git -c core.quotepath=false diff --no-color --no-ext-diff base...HEAD` 的输出
const SAMPLE = [
  'diff --git a/added.txt b/added.txt',
  'new file mode 100644',
  'index 0000000..ce01362',
  '--- /dev/null',
  '+++ b/added.txt',
  '@@ -0,0 +1 @@',
  '+hello',
  'diff --git a/bin.dat b/bin.dat',
  'index 8352675..c5793f9 100644',
  'Binary files a/bin.dat and b/bin.dat differ',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  'index b023018..0000000',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  'diff --git a/keep.txt b/keep.txt',
  'index 4cb29ea..657b95b 100644',
  '--- a/keep.txt',
  '+++ b/keep.txt',
  '@@ -1,3 +1,4 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '+four',
  '\\ No newline at end of file',
  'diff --git a/q.sql b/q.sql',
  'index a3705a8..ab290eb 100644',
  '--- a/q.sql',
  '+++ b/q.sql',
  '@@ -1,2 +1 @@',
  '--- sql comment',
  ' select 1;',
  'diff --git a/moved.txt b/renamed.txt',
  'similarity index 90%',
  'rename from moved.txt',
  'rename to renamed.txt',
  'index 92dfa21..8f5bef2 100644',
  '--- a/moved.txt',
  '+++ b/renamed.txt',
  '@@ -7,4 +7,4 @@ f',
  ' g',
  ' h',
  ' i',
  '-j',
  '+J',
  'diff --git a/with space.txt b/with space.txt',
  'index 33194a0..b66ba06 100644',
  '--- a/with space.txt\t',
  '+++ b/with space.txt\t',
  '@@ -1 +1 @@',
  '-old content',
  '+new content',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('returns no files for an empty patch', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('\n')).toEqual([]);
  });

  it('splits a patch into one entry per file, in order', () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(files.map((file) => [file.path, file.status])).toEqual([
      ['added.txt', 'added'],
      ['bin.dat', 'modified'],
      ['gone.txt', 'deleted'],
      ['keep.txt', 'modified'],
      ['q.sql', 'modified'],
      ['renamed.txt', 'renamed'],
      ['with space.txt', 'modified'],
    ]);
  });

  it('counts additions and deletions per file', () => {
    const counts = parseUnifiedDiff(SAMPLE).map((file) => [file.additions, file.deletions]);
    expect(counts).toEqual([
      [1, 0],
      [0, 0],
      [0, 1],
      [2, 1],
      [0, 1],
      [1, 1],
      [1, 1],
    ]);
  });

  it('numbers lines from the hunk header and keeps the line kinds', () => {
    const keep = parseUnifiedDiff(SAMPLE)[3];
    expect(keep?.hunks).toHaveLength(1);
    const hunk = keep?.hunks[0];
    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 });
    expect(hunk?.header).toBe('@@ -1,3 +1,4 @@');
    expect(hunk?.lines).toEqual([
      { kind: 'context', text: 'one', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'two', oldLine: 2 },
      { kind: 'add', text: 'TWO', newLine: 2 },
      { kind: 'context', text: 'three', oldLine: 3, newLine: 3 },
      { kind: 'add', text: 'four', newLine: 4 },
      { kind: 'note', text: '\\ No newline at end of file' },
    ]);
  });

  it('treats "---" inside a hunk as a deleted line, not a file header', () => {
    const sql = parseUnifiedDiff(SAMPLE)[4];
    expect(sql?.path).toBe('q.sql');
    expect(sql?.hunks[0]?.lines).toEqual([
      { kind: 'del', text: '-- sql comment', oldLine: 1 },
      { kind: 'context', text: 'select 1;', oldLine: 2, newLine: 1 },
    ]);
  });

  it('keeps the old path of renames and the section text of hunk headers', () => {
    const renamed = parseUnifiedDiff(SAMPLE)[5];
    expect(renamed).toMatchObject({ path: 'renamed.txt', oldPath: 'moved.txt' });
    expect(renamed?.meta).toContain('similarity index 90%');
    expect(renamed?.hunks[0]).toMatchObject({ header: '@@ -7,4 +7,4 @@ f', oldStart: 7 });
    expect(renamed?.hunks[0]?.lines[3]).toEqual({ kind: 'del', text: 'j', oldLine: 10 });
  });

  it('marks binary files and gives them no hunks', () => {
    const binary = parseUnifiedDiff(SAMPLE)[1];
    expect(binary).toMatchObject({ path: 'bin.dat', binary: true, hunks: [] });
  });

  it('strips the tab git appends to header paths that contain spaces', () => {
    const spaced = parseUnifiedDiff(SAMPLE)[6];
    expect(spaced?.path).toBe('with space.txt');
    expect(spaced?.oldPath).toBeUndefined();
  });

  it('reads the deleted path from the old side', () => {
    const gone = parseUnifiedDiff(SAMPLE)[2];
    expect(gone).toMatchObject({ path: 'gone.txt', status: 'deleted' });
    expect(gone?.hunks[0]?.lines).toEqual([{ kind: 'del', text: 'bye', oldLine: 1 }]);
  });

  it('splits several hunks of one file', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,2 @@',
      '-x',
      '+y',
      ' z',
      '@@ -10 +10,2 @@ function tail() {',
      ' end',
      '+more',
    ].join('\n');
    const [file] = parseUnifiedDiff(patch);
    expect(file?.hunks.map((hunk) => [hunk.oldStart, hunk.newStart, hunk.lines.length])).toEqual([
      [1, 1, 3],
      [10, 10, 2],
    ]);
    expect(file?.hunks[1]?.lines[1]).toEqual({ kind: 'add', text: 'more', newLine: 11 });
  });

  it('keeps an empty context line inside a hunk', () => {
    const patch = ['--- a/a.md', '+++ b/a.md', '@@ -1,3 +1,3 @@', ' a', '', '-b', '+c'].join('\n');
    const [file] = parseUnifiedDiff(patch);
    expect(file?.path).toBe('a.md');
    expect(file?.hunks[0]?.lines[1]).toEqual({
      kind: 'context',
      text: '',
      oldLine: 2,
      newLine: 2,
    });
    expect(file?.additions).toBe(1);
  });

  it('accepts CRLF line endings', () => {
    const patch =
      'diff --git a/w.txt b/w.txt\r\n--- a/w.txt\r\n+++ b/w.txt\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n';
    const [file] = parseUnifiedDiff(patch);
    expect(file?.hunks[0]?.lines).toEqual([
      { kind: 'del', text: 'a', oldLine: 1 },
      { kind: 'add', text: 'b', newLine: 1 },
    ]);
  });

  it('unquotes C-style quoted paths', () => {
    const patch = [
      'diff --git "a/say \\"hi\\".txt" "b/say \\"hi\\".txt"',
      'new file mode 100644',
      'index 0000000..e69de29',
    ].join('\n');
    const [file] = parseUnifiedDiff(patch);
    expect(file).toMatchObject({ path: 'say "hi".txt', status: 'added', hunks: [] });
  });

  it('decodes octal escapes as UTF-8', () => {
    const patch = [
      'diff --git "a/\\344\\270\\255.md" "b/\\344\\270\\255.md"',
      'index 587be6b..975fbec 100644',
      '--- "a/\\344\\270\\255.md"',
      '+++ "b/\\344\\270\\255.md"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(parseUnifiedDiff(patch)[0]?.path).toBe('中.md');
  });

  it('takes the path from the git header when a file has no ---/+++ lines', () => {
    const patch = [
      'diff --git a/dir/run me.sh b/dir/run me.sh',
      'old mode 100644',
      'new mode 100755',
    ].join('\n');
    const [file] = parseUnifiedDiff(patch);
    expect(file).toMatchObject({ path: 'dir/run me.sh', status: 'modified', hunks: [] });
    expect(file?.meta).toEqual(['old mode 100644', 'new mode 100755']);
  });

  it('reads pure renames from the rename lines', () => {
    const patch = [
      'diff --git a/old name.txt b/new name.txt',
      'similarity index 100%',
      'rename from old name.txt',
      'rename to new name.txt',
    ].join('\n');
    expect(parseUnifiedDiff(patch)[0]).toMatchObject({
      path: 'new name.txt',
      oldPath: 'old name.txt',
      status: 'renamed',
    });
  });

  it('defaults omitted hunk counts to 1', () => {
    const patch = ['--- a/one', '+++ b/one', '@@ -3 +3 @@', '-a', '+b'].join('\n');
    expect(parseUnifiedDiff(patch)[0]?.hunks[0]).toMatchObject({
      oldStart: 3,
      oldLines: 1,
      newStart: 3,
      newLines: 1,
    });
  });
});

describe('diffLineCount', () => {
  it('counts the rendered lines of all hunks', () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(files.map(diffLineCount)).toEqual([1, 0, 1, 6, 2, 5, 2]);
  });
});

describe('statSummary', () => {
  it('returns the last line of git --stat output', () => {
    const stat = [
      ' added.txt | 1 +',
      ' keep.txt  | 4 +++-',
      ' 2 files changed, 4 insertions(+), 1 deletion(-)',
    ].join('\n');
    expect(statSummary(stat)).toBe('2 files changed, 4 insertions(+), 1 deletion(-)');
  });

  it('returns an empty string for empty stat output', () => {
    expect(statSummary('')).toBe('');
    expect(statSummary('  \n')).toBe('');
  });
});
