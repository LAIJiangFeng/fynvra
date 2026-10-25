import type { UpdateState } from '@shared/types/updates';
import { Download, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { T } from '@/i18n';
import { useT } from '@/i18n/I18nProvider';
import { useUpdatesStore } from '@/stores/useUpdates';
import { InlineMessage, SectionHeader } from './common';

export function updateStatusText(state: UpdateState, t: T): string {
  if (state.status === 'disabled')
    return t(state.reason === 'development' ? 'updates.development' : 'updates.unsupported');
  return t(`updates.status.${state.status}`, {
    version: state.version ?? '',
    percent: Math.floor(state.percent ?? 0),
  });
}

export function InstallUpdateButton() {
  const busy = useUpdatesStore((store) => store.busy);
  const install = useUpdatesStore((store) => store.install);
  const t = useT();
  return (
    <Button size="sm" disabled={busy} onClick={() => void install()}>
      <Download />
      {t('updates.install')}
    </Button>
  );
}

export function UpdateSettings() {
  const state = useUpdatesStore((store) => store.state);
  const error = useUpdatesStore((store) => store.error);
  const busy = useUpdatesStore((store) => store.busy);
  const check = useUpdatesStore((store) => store.check);
  const t = useT();
  const canCheck = state && ['idle', 'not-available', 'error'].includes(state.status);
  return (
    <section aria-label={t('updates.title')}>
      <SectionHeader title={t('updates.title')}>
        {state?.status === 'downloaded' ? (
          <InstallUpdateButton />
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !canCheck}
            onClick={() => void check()}
          >
            <RefreshCw className={state?.status === 'checking' ? 'animate-spin' : undefined} />
            {t('updates.check')}
          </Button>
        )}
      </SectionHeader>
      <div className="grid gap-2 rounded-lg border px-4 py-3">
        <p className="font-medium text-sm">
          {state ? t('updates.current', { version: state.currentVersion }) : t('common.loading')}
        </p>
        <p className="text-muted-foreground text-xs" role="status">
          {state && updateStatusText(state, t)}
        </p>
        {state?.status === 'downloading' && (
          <progress
            className="h-1.5 w-full accent-foreground"
            max={100}
            value={state.percent ?? 0}
            aria-label={t('updates.progress')}
          />
        )}
        <p className="text-muted-foreground text-xs">{t('updates.automatic')}</p>
        {(error || state?.error) && (
          <InlineMessage tone="error">{error || state?.error}</InlineMessage>
        )}
      </div>
    </section>
  );
}
