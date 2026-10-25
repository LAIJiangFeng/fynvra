import { ChevronRight, type LucideIcon, TriangleAlert } from 'lucide-react';
import type * as React from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { INLINE_WARNING_LIMIT, warningLine } from './warnings';

/** 设置页里一组内容的标题，右侧放操作按钮。只有标题，不加说明。 */
export function SectionHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h3 className="min-w-0 font-medium">{title}</h3>
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

/**
 * 导入弹窗与拉取模型列表底部的告警：一行一条「主体：原因」，整句在悬停提示里；
 * 超过 {@link INLINE_WARNING_LIMIT} 条时折叠成「N 条提示」，默认收起。
 */
export function WarningList({ warnings }: { warnings: readonly string[] }) {
  const t = useT();
  if (warnings.length === 0) return null;
  const list = (
    <ul className="grid gap-1">
      {warnings.map((warning) => (
        <li
          key={warning}
          title={warning}
          className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs"
        >
          <TriangleAlert className="size-3.5 shrink-0 text-amber-500" />
          <span className="min-w-0 truncate">{warningLine(warning)}</span>
        </li>
      ))}
    </ul>
  );
  if (warnings.length <= INLINE_WARNING_LIMIT) return list;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1.5 rounded text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[panel-open]:rotate-90" />
        <TriangleAlert className="size-3.5 shrink-0 text-amber-500" />
        {t('settings.import.warnings', { count: warnings.length })}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 max-h-32 overflow-y-auto">{list}</CollapsibleContent>
    </Collapsible>
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
