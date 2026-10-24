import { Progress as ProgressPrimitive } from '@base-ui/react/progress';
import { cn } from '@/lib/utils';

/** 进度条：`value` 取 0–`max`（默认 100），null 为不确定进度；子元素（如标签）放在进度条上方。 */
function Progress({
  className,
  indicatorClassName,
  children,
  ...props
}: ProgressPrimitive.Root.Props & { indicatorClassName?: string }) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn('flex w-full flex-col gap-1', className)}
      {...props}
    >
      {children}
      <ProgressPrimitive.Track
        data-slot="progress-track"
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className={cn('h-full bg-primary transition-[width] duration-300', indicatorClassName)}
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}

/** 进度文字（如「2 / 3」）；放进 Progress 的子元素。 */
function ProgressLabel({ className, ...props }: ProgressPrimitive.Label.Props) {
  return (
    <ProgressPrimitive.Label
      data-slot="progress-label"
      className={cn('text-muted-foreground text-xs', className)}
      {...props}
    />
  );
}

export { Progress, ProgressLabel };
