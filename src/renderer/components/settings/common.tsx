import type { LucideIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/** 设置页里一组内容的标题：标题 + 说明，右侧放操作按钮。 */
export function SectionHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h3 className="font-medium">{title}</h3>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </div>
      {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
      <Icon className="size-6 text-muted-foreground/70" />
      <p className="font-medium text-sm">{title}</p>
      {description && <p className="max-w-sm text-muted-foreground text-xs">{description}</p>}
      {children && <div className="mt-2 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  );
}

/** 行内提示：错误用 role="alert"，屏幕阅读器会读出。 */
export function InlineMessage({
  tone = 'muted',
  className,
  children,
}: {
  tone?: 'error' | 'success' | 'muted';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <p
      role={tone === 'error' ? 'alert' : undefined}
      className={cn(
        'text-xs',
        tone === 'error' && 'text-destructive',
        tone === 'success' && 'text-emerald-600 dark:text-emerald-400',
        tone === 'muted' && 'text-muted-foreground',
        className
      )}
    >
      {children}
    </p>
  );
}

/** 表单项：标签经 htmlFor 关联到控件 id。 */
export function Field({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: React.ReactNode;
  htmlFor: string;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('grid min-w-0 gap-1.5', className)}>
      <label htmlFor={htmlFor} className="font-medium text-sm">
        {label}
      </label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}
