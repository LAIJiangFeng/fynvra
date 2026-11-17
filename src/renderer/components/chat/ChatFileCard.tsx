import { File, FileSpreadsheet, FileText, FileType, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

type FileKind = 'pdf' | 'word' | 'sheet' | 'other';

/** 按扩展名（不区分大小写）判断附件类型，只决定图标和颜色 */
export function fileKindOf(name: string): FileKind {
  const ext = fileExtOf(name).toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'doc' || ext === 'docx') return 'word';
  if (ext === 'xls' || ext === 'xlsx' || ext === 'csv' || ext === 'tsv') return 'sheet';
  return 'other';
}

/** 文件扩展名（不含点）；没有扩展名或以点开头的隐藏文件返回空串 */
export function fileExtOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}

const KIND_STYLE: Record<FileKind, { icon: LucideIcon; className: string }> = {
  pdf: { icon: FileText, className: 'bg-red-500 text-white' },
  word: { icon: FileType, className: 'bg-blue-500 text-white' },
  sheet: { icon: FileSpreadsheet, className: 'bg-emerald-600 text-white' },
  other: { icon: File, className: 'bg-muted text-muted-foreground' },
};

/** 附件卡片：与图片缩略图同高（64px），左侧类型色块，右侧文件名和扩展名标签 */
export function ChatFileCard({ name, className }: { name: string; className?: string }) {
  const kind = KIND_STYLE[fileKindOf(name)];
  const Icon = kind.icon;
  const ext = fileExtOf(name).toUpperCase();
  return (
    <div
      title={name}
      className={cn(
        'flex h-16 max-w-56 items-center gap-2.5 rounded-md border bg-muted/40 px-3',
        className
      )}
    >
      <div
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-md',
          kind.className
        )}
      >
        <Icon className="size-5" />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-xs">{name}</span>
        {ext && <span className="text-[11px] text-muted-foreground">{ext}</span>}
      </div>
    </div>
  );
}
