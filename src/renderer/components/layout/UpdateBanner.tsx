import { Download } from 'lucide-react';
import { InstallUpdateButton, updateStatusText } from '@/components/settings/UpdateSettings';
import { useT } from '@/i18n/I18nProvider';
import { useUpdatesStore } from '@/stores/useUpdates';

/** 不抢焦点、不自动退出；在用户当前工作区展示下载和安装提醒。 */
export function UpdateBanner() {
  const state = useUpdatesStore((store) => store.state);
  const error = useUpdatesStore((store) => store.error);
  const t = useT();
  if (!state || !['available', 'downloading', 'downloaded', 'installing'].includes(state.status))
    return null;
  return (
    <section
      aria-label={t('updates.title')}
      className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-muted/60 px-4 py-2 text-xs"
    >
      <Download className="size-4 shrink-0" />
      <span role="status" className="min-w-0 flex-1">
        {updateStatusText(state, t)}
      </span>
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
      {state.status === 'downloaded' && <InstallUpdateButton />}
    </section>
  );
}
