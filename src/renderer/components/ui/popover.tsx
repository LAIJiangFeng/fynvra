import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { cn } from '@/lib/utils';

const Popover = PopoverPrimitive.Root;

function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

/** 弹层（含定位与 Portal）。no-drag：弹层压到自绘标题栏上时仍可点击。 */
function PopoverContent({
  className,
  side = 'bottom',
  align = 'start',
  sideOffset = 6,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, 'side' | 'align' | 'sideOffset'>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        className="no-drag z-50 outline-none"
        side={side}
        align={align}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            'max-h-(--available-height) origin-(--transform-origin) overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-100 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0',
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverContent, PopoverTrigger };
