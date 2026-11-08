import type { AppMessageBoxType } from '@shared/types/appDialog';
import { CircleAlert, CircleHelp, Info, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  type AppDialogEntry,
  bindMainMessageBoxes,
  respondAppDialog,
  useAppDialogStore,
} from '@/lib/appDialog';
import { cn } from '@/lib/utils';

const ICONS: Partial<Record<AppMessageBoxType, { icon: typeof Info; className: string }>> = {
  info: { icon: Info, className: 'text-muted-foreground' },
  question: { icon: CircleHelp, className: 'text-muted-foreground' },
  warning: { icon: TriangleAlert, className: 'text-amber-500 dark:text-amber-400' },
  error: { icon: CircleAlert, className: 'text-destructive' },
};

/** 主按钮：默认按钮（不是取消时）；否则第一个既非取消也非危险的按钮；只有一个按钮时就是它。 */
function primaryOf(entry: AppDialogEntry): number {
  if (entry.buttons.length === 1) return 0;
  if (entry.defaultId !== entry.cancelId && entry.defaultId !== entry.destructiveId)
    return entry.defaultId;
  return entry.buttons.findIndex(
    (_label, index) => index !== entry.cancelId && index !== entry.destructiveId
  );
}

/**
 * 全局提示框（Renderer 的 confirmDialog / messageBox 与 Main 发来的请求），在应用根部挂载一次。
 * 排队依次显示；Esc / 点遮罩返回 cancelId；默认按钮获得焦点；文字只按纯文本渲染。
 */
export function AppDialogHost() {
  const current = useAppDialogStore((state) => state.queue[0]);
  // 关闭动画期间队列已空，沿用上一条内容避免弹窗闪成空白
  const [shown, setShown] = useState(current);
  if (current && current !== shown) setShown(current);
  const defaultButton = useRef<HTMLButtonElement>(null);

  useEffect(() => bindMainMessageBoxes(), []);

  if (!shown) return null;
  const icon = ICONS[shown.type];
  const TypeIcon = icon?.icon;
  // 有标题时 message 作正文；没有标题时 message 作标题（同原生提示框的主提示）
  const body = shown.title ? shown.message : '';
  const primary = primaryOf(shown);
  const cancel = () => respondAppDialog(shown.id, shown.cancelId);
  return (
    <AlertDialog
      // 每个请求一个新的弹层：焦点与动画都按新请求重新开始
      key={shown.id}
      open={current?.id === shown.id}
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <AlertDialogContent
        className="z-[110] sm:max-w-md"
        overlayClassName="z-[110]"
        onOverlayClick={cancel}
        initialFocus={defaultButton}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-start gap-2 leading-snug">
            {TypeIcon && <TypeIcon className={cn('mt-0.5 size-5 shrink-0', icon.className)} />}
            <span className="min-w-0 whitespace-pre-wrap break-words">
              {shown.title || shown.message}
            </span>
          </AlertDialogTitle>
          {body || shown.detail ? (
            <AlertDialogDescription
              render={<div />}
              className="grid gap-2 whitespace-pre-wrap break-words"
            >
              {body && <p>{body}</p>}
              {shown.detail && <p>{shown.detail}</p>}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          {shown.buttons.map((label, index) => (
            <AlertDialogAction
              // biome-ignore lint/suspicious/noArrayIndexKey: 按钮下标就是返回值，顺序固定
              key={index}
              ref={index === shown.defaultId ? defaultButton : undefined}
              variant={
                index === shown.destructiveId
                  ? 'destructive'
                  : index === primary
                    ? 'default'
                    : 'outline'
              }
              onClick={() => respondAppDialog(shown.id, index)}
            >
              {label}
            </AlertDialogAction>
          ))}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
