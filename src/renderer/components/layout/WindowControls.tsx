import { Copy, Minus, Square, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useWindowMaximized } from '@/hooks/useWindowMaximized';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';

/** Windows / Linux 的自绘窗口按钮（主进程以 titleBarStyle: 'hidden' 隐藏了系统按钮）。 */
export function WindowControls() {
  const maximized = useWindowMaximized();
  const t = useT();
  const api = window.fynvra.window;

  return (
    <div className="no-drag flex h-full">
      <CaptionButton label={t('app.minimize')} onClick={() => void api.minimize()}>
        <Minus />
      </CaptionButton>
      <CaptionButton
        label={t(maximized ? 'app.restore' : 'app.maximize')}
        onClick={() => void api.toggleMaximize()}
      >
        {maximized ? <Copy className="size-3.5" /> : <Square className="size-3.5" />}
      </CaptionButton>
      <CaptionButton label={t('common.close')} danger onClick={() => void api.close()}>
        <X />
      </CaptionButton>
    </div>
  );
}

function CaptionButton({
  label,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex h-full w-11 items-center justify-center text-muted-foreground outline-none transition-colors focus-visible:bg-accent [&_svg:not([class*=size-])]:size-4',
        danger ? 'hover:bg-red-600 hover:text-white' : 'hover:bg-accent hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}
