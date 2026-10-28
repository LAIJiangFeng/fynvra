import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { APPROVAL_MODES, isApprovalMode } from '@fynvra/core';
import { Bell, Check, ChevronsUpDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { selectSessionOf, useSessionsStore } from '@/stores/sessions';

/** 切换后闪一下（ring）的时长 */
const FLASH_MS = 700;

/** 值变了之后的一小段时间返回 true（挂载时不算）：档位切换后胶囊与状态栏闪一下 */
function useFlash(value: unknown): boolean {
  const [flashing, setFlashing] = useState(false);
  const previous = useRef(value);
  useEffect(() => {
    if (Object.is(previous.current, value)) return;
    previous.current = value;
    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), FLASH_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return flashing;
}

/**
 * 输入框中的操作通知范围；沿用旧 approvalMode 字段与 Shift+Tab 快捷键。
 * 所有范围均立即继续执行，只改变哪些工具操作产生通知。
 */
export function ApprovalModePicker({ sessionId }: { sessionId: string }) {
  const mode = useSessionsStore((state) => selectSessionOf(sessionId)(state)?.approvalMode);
  const setApprovalMode = useSessionsStore((state) => state.setApprovalMode);
  const [open, setOpen] = useState(false);
  const flashing = useFlash(mode);
  const t = useT();
  if (!mode) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            title={t('approval.cycleHint')}
            data-flash={flashing ? '' : undefined}
            className="flex shrink-0 items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-1 text-muted-foreground text-xs outline-none transition-[color,background-color,box-shadow] hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[flash]:ring-2 data-[flash]:ring-primary/60 data-[popup-open]:bg-accent data-[popup-open]:text-accent-foreground"
          />
        }
      >
        <Bell aria-hidden className="size-3.5 shrink-0" />
        <span>{t(`approval.modes.${mode}`)}</span>
        <ChevronsUpDown aria-hidden className="size-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent side="top" className="w-64 p-1">
        <RadioGroup
          aria-label={t('approval.title')}
          value={mode}
          onValueChange={(next) => {
            if (!isApprovalMode(next)) return;
            void setApprovalMode(sessionId, next);
            setOpen(false);
          }}
          className="grid gap-0.5"
        >
          {APPROVAL_MODES.map((option) => {
            return (
              <Radio.Root
                key={option}
                value={option}
                className="flex cursor-default select-none items-center gap-2.5 rounded-sm px-2 py-1.5 outline-none hover:bg-accent focus-visible:bg-accent data-[checked]:bg-accent/60"
              >
                <Bell aria-hidden className="size-4 shrink-0" />
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5 font-medium text-sm">
                  {t(`approval.modes.${option}`)}
                </span>
                <Check
                  aria-hidden
                  className={cn('size-4 shrink-0', option === mode ? 'opacity-100' : 'opacity-0')}
                />
              </Radio.Root>
            );
          })}
        </RadioGroup>
        <p className="px-2 py-2 text-muted-foreground text-xs">{t('approval.hint')}</p>
      </PopoverContent>
    </Popover>
  );
}

/** 状态栏中的通知范围，与执行权限无关。 */
export function ApprovalModeStatus({ sessionId }: { sessionId: string }) {
  const mode = useSessionsStore((state) => selectSessionOf(sessionId)(state)?.approvalMode);
  const flashing = useFlash(mode);
  const t = useT();
  if (!mode) return null;
  return (
    <span
      title={t('approval.statusHint')}
      aria-live="polite"
      data-flash={flashing ? '' : undefined}
      className="flex shrink-0 items-center gap-1 rounded-sm px-1 transition-[color,box-shadow] data-[flash]:ring-2 data-[flash]:ring-primary/60"
    >
      <Bell aria-hidden className="size-3 shrink-0" />
      {t(`approval.modes.${mode}`)}
    </span>
  );
}
