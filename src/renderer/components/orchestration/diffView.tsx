import { memo, type ReactNode, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { type DiffFile, type DiffFileStatus, type DiffLine, diffLineCount } from './diff';
import { useSeenOnce } from './hooks';

/** 一个文件每次多渲染这么多行。 */
const LINE_CHUNK = 400;
const LINE_HEIGHT_PX = 18;

/** 状态字母与配色；读屏与悬停的名称在字典 orchestration.fileStatus */
export const STATUS_MARK: Record<DiffFileStatus, { letter: string; className: string }> = {
  added: { letter: 'A', className: 'text-emerald-600 dark:text-emerald-400' },
  deleted: { letter: 'D', className: 'text-red-600 dark:text-red-400' },
  modified: { letter: 'M', className: 'text-amber-600 dark:text-amber-400' },
  renamed: { letter: 'R', className: 'text-sky-600 dark:text-sky-400' },
  copied: { letter: 'C', className: 'text-sky-600 dark:text-sky-400' },
};

export function LineCounts({ file }: { file: DiffFile }) {
  const t = useT();
  if (file.binary) {
    return <span className="shrink-0 text-muted-foreground">{t('orchestration.binary')}</span>;
  }
  return (
    <span className="shrink-0 font-mono tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{' '}
      <span className="text-red-600 dark:text-red-400">−{file.deletions}</span>
    </span>
  );
}

/** 路径只在 `/` 之后换行，不会把文件名拦腰截断。 */
export function PathText({ path }: { path: string }) {
  return path.split('/').map((segment, index, segments) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: 路径段的位置就是它的身份
    <span key={index}>
      {segment}
      {index < segments.length - 1 && (
        <>
          /<wbr />
        </>
      )}
    </span>
  ));
}

/** 接近视口时才渲染行；超长文件每次多显示 {@link LINE_CHUNK} 行。 */
export function LazyDiffBody({ file }: { file: DiffFile }) {
  const placeholderRef = useRef<HTMLDivElement>(null);
  const seen = useSeenOnce(placeholderRef);
  const [limit, setLimit] = useState(LINE_CHUNK);
  const total = diffLineCount(file);
  const t = useT();

  if (file.binary) {
    return (
      <p className="px-3 py-2 text-muted-foreground text-xs">{t('orchestration.binaryFile')}</p>
    );
  }
  if (total === 0) {
    const detail =
      file.meta.length > 0
        ? file.meta.join(' · ')
        : file.status === 'renamed'
          ? t('orchestration.renameOnly')
          : t('orchestration.noTextChanges');
    return <p className="px-3 py-2 text-muted-foreground text-xs">{detail}</p>;
  }
  if (!seen) {
    return (
      <div
        ref={placeholderRef}
        aria-hidden
        style={{ height: Math.min(total, LINE_CHUNK) * LINE_HEIGHT_PX }}
      />
    );
  }
  const rest = total - limit;
  return (
    <div>
      {file.meta.length > 0 && (
        <p className="border-b px-3 py-1 font-mono text-[11px] text-muted-foreground">
          {file.meta.join(' · ')}
        </p>
      )}
      <DiffLines file={file} limit={limit} />
      {rest > 0 && (
        <div className="border-t px-2 py-1.5 text-center">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => setLimit((current) => current + LINE_CHUNK)}
          >
            {t('orchestration.showMore', { count: Math.min(LINE_CHUNK, rest), rest })}
          </Button>
        </div>
      )}
    </div>
  );
}

const ROW_TONE: Record<DiffLine['kind'], string> = {
  add: 'bg-emerald-500/10 dark:bg-emerald-400/10',
  del: 'bg-red-500/10 dark:bg-red-400/10',
  context: '',
  note: 'text-muted-foreground italic',
};
const MARKER: Record<DiffLine['kind'], { text: string; className: string }> = {
  add: { text: '+', className: 'text-emerald-700 dark:text-emerald-300' },
  del: { text: '-', className: 'text-red-700 dark:text-red-300' },
  context: { text: ' ', className: '' },
  note: { text: '', className: '' },
};

export const DiffLines = memo(function DiffLines({
  file,
  limit,
}: {
  file: DiffFile;
  limit: number;
}) {
  const lastHunk = file.hunks.at(-1);
  const maxLine = lastHunk
    ? Math.max(lastHunk.oldStart + lastHunk.oldLines, lastHunk.newStart + lastHunk.newLines)
    : 1;
  const gutter = { width: `calc(${String(maxLine).length}ch + 0.75rem)` };
  const rows: ReactNode[] = [];
  let count = 0;
  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    if (count >= limit) break;
    rows.push(
      <div
        key={`h${hunkIndex}`}
        className="truncate bg-sky-500/10 px-2 text-sky-800 dark:text-sky-300"
        title={hunk.header}
      >
        {hunk.header}
      </div>
    );
    for (const [lineIndex, line] of hunk.lines.entries()) {
      if (count >= limit) break;
      count += 1;
      const marker = MARKER[line.kind];
      rows.push(
        <div key={`${hunkIndex}:${lineIndex}`} className={cn('flex', ROW_TONE[line.kind])}>
          <span
            className="shrink-0 select-none pr-1 text-right text-muted-foreground/70"
            style={gutter}
          >
            {line.oldLine}
          </span>
          <span
            className="shrink-0 select-none border-r pr-1 text-right text-muted-foreground/70"
            style={gutter}
          >
            {line.newLine}
          </span>
          <span className={cn('w-4 shrink-0 select-none text-center', marker.className)}>
            {marker.text}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2">
            {line.text === '' ? ' ' : line.text}
          </span>
        </div>
      );
    }
  }
  return <div className="font-mono text-[11px] leading-[18px]">{rows}</div>;
});
