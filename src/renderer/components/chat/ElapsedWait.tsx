import { memo, useEffect, useState } from 'react';
import { useT } from '@/i18n/I18nProvider';

/** Only this small leaf ticks; the event timestamp survives navigation and retries. */
export const ElapsedWait = memo(function ElapsedWait({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now);
  const t = useT();
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  // The enclosing status announces phase changes, never the second-by-second clock.
  return (
    <span aria-hidden="true" className="tabular-nums">
      {t('chat.elapsed', { seconds: Math.max(0, Math.floor((now - startedAt) / 1_000)) })}
    </span>
  );
});
