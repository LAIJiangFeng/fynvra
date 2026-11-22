import { File, FileCode, FileSpreadsheet, FileText, FileType, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

type FileKind = 'pdf' | 'word' | 'sheet' | 'text' | 'code' | 'other';

/** 扩展名（小写）到附件类型的映射，未列出的归 other */
const EXT_KIND = new Map<string, FileKind>();
const KIND_EXTS: Record<Exclude<FileKind, 'other'>, string> = {
  pdf: 'pdf',
  word: 'doc docx',
  sheet: 'xls xlsx csv tsv',
  text: 'txt text log md markdown rst',
  code:
    'js jsx mjs cjs ts tsx py java kt go rs c h cpp hpp cc cs rb php swift dart lua sh bash ps1 bat cmd sql ' +
    'html htm css scss less vue svelte json jsonc yaml yml toml xml ini conf cfg properties gradle',
};
for (const [kind, exts] of Object.entries(KIND_EXTS)) {
  for (const ext of exts.split(' ')) EXT_KIND.set(ext, kind as FileKind);
}

/** 按扩展名（不区分大小写）判断附件类型，只决定图标和颜色 */
export function fileKindOf(name: string): FileKind {
  return EXT_KIND.get(fileExtOf(name).toLowerCase()) ?? 'other';
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
  text: { icon: FileText, className: 'bg-slate-500 text-white' },
  code: { icon: FileCode, className: 'bg-violet-500 text-white' },
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
