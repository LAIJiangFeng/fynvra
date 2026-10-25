import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';

/** 复制到剪贴板，成功后短暂显示对勾。 */
export function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const t = useT();

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);

  const title = copied ? t('chat.copied') : (label ?? t('chat.copy'));
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={title}
      title={title}
      className={cn('size-6 text-muted-foreground', className)}
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => {}
        );
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  );
}
