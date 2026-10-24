import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { APPROVAL_MODES, type ApprovalMode, isApprovalMode } from '@fynvra/core';
import { APPROVAL_MODE_HINTS, APPROVAL_MODE_LABELS } from '@shared/types/chat';
import {
  Check,
  ChevronsUpDown,
  type LucideIcon,
  ShieldCheck,
  ShieldHalf,
  ShieldOff,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { selectSessionOf, useSessionsStore } from '@/stores/sessions';

const MODE_ICON: Record<ApprovalMode, LucideIcon> = {
  supervised: ShieldCheck,
  'auto-edits': ShieldHalf,
  full: ShieldOff,
};

/** 档位的配色：越宽松越醒目，完全放行用琥珀色提醒 */
const MODE_TONE: Record<ApprovalMode, string> = {
  supervised: '',
  'auto-edits': 'text-sky-700 dark:text-sky-300',
  full: 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300',
};

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

function modeTitle(mode: ApprovalMode): string {
  return `审批档位：${APPROVAL_MODE_LABELS[mode]}（${APPROVAL_MODE_HINTS[mode]}）`;
}

/**
 * 输入框左下角、模型胶囊旁的审批胶囊：全程审批 / 自动接受编辑 / 完全放行。
 * 点开是三项说明列表；输入框里 Shift+Tab 循环切换（见 Composer）。运行中也能切，下一次需要审批的工具调用起生效。
 */
export function ApprovalModePicker({ sessionId }: { sessionId: string }) {
  const mode = useSessionsStore((state) => selectSessionOf(sessionId)(state)?.approvalMode);
  const setApprovalMode = useSessionsStore((state) => state.setApprovalMode);
  const [open, setOpen] = useState(false);
  const flashing = useFlash(mode);
  if (!mode) return null;
  const Icon = MODE_ICON[mode];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            title={`${modeTitle(mode)}，Shift+Tab 切换`}
            data-flash={flashing ? '' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-1 text-muted-foreground text-xs outline-none transition-[color,background-color,box-shadow] hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[flash]:ring-2 data-[flash]:ring-primary/60 data-[popup-open]:bg-accent data-[popup-open]:text-accent-foreground',
              MODE_TONE[mode]
            )}
          />
        }
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span>{APPROVAL_MODE_LABELS[mode]}</span>
        <ChevronsUpDown aria-hidden className="size-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent side="top" className="w-80 p-1">
        <RadioGroup
          aria-label="审批档位"
          value={mode}
          onValueChange={(next) => {
            if (!isApprovalMode(next)) return;
            void setApprovalMode(sessionId, next);
            setOpen(false);
          }}
          className="grid gap-0.5"
        >
          {APPROVAL_MODES.map((option) => {
            const OptionIcon = MODE_ICON[option];
            return (
              <Radio.Root
                key={option}
                value={option}
                className="flex cursor-default select-none items-start gap-2.5 rounded-sm px-2 py-1.5 outline-none hover:bg-accent focus-visible:bg-accent data-[checked]:bg-accent/60"
              >
                <OptionIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex items-baseline gap-1.5 font-medium text-sm">
                    {APPROVAL_MODE_LABELS[option]}
                    <span className="font-mono font-normal text-muted-foreground text-xs">
                      {option}
                    </span>
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {APPROVAL_MODE_HINTS[option]}
                  </span>
                </span>
                <Check
                  aria-hidden
                  className={cn(
                    'mt-0.5 size-4 shrink-0',
                    option === mode ? 'opacity-100' : 'opacity-0'
                  )}
                />
              </Radio.Root>
            );
          })}
        </RadioGroup>
        <p className="border-t px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">
          在输入框里按 Shift+Tab
          循环切换。运行中也能切，下一次需要审批的工具调用起生效；保护底线任何档位都要你确认。
        </p>
      </PopoverContent>
    </Popover>
  );
}

/** 状态栏里的审批档位：切换后同样闪一下；屏幕阅读器会读出新的档位 */
export function ApprovalModeStatus({ sessionId }: { sessionId: string }) {
  const mode = useSessionsStore((state) => selectSessionOf(sessionId)(state)?.approvalMode);
  const flashing = useFlash(mode);
  if (!mode) return null;
  const Icon = MODE_ICON[mode];
  return (
    <span
      title={`${modeTitle(mode)}；在输入框里按 Shift+Tab 切换`}
      aria-live="polite"
      data-flash={flashing ? '' : undefined}
      className={cn(
        'flex shrink-0 items-center gap-1 rounded-sm px-1 transition-[color,box-shadow] data-[flash]:ring-2 data-[flash]:ring-primary/60',
        mode === 'full' && 'text-amber-700 dark:text-amber-300'
      )}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      {APPROVAL_MODE_LABELS[mode]}
    </span>
  );
}
