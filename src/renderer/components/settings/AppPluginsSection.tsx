import type { AppPluginStatus, AppPluginView } from '@shared/types/appPlugins';
import { FolderPlus, Loader2, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n/I18nProvider';
import { confirmDialog } from '@/lib/appDialog';
import { useAppPluginsStore } from '@/stores/appPlugins';
import { usePluginsStore } from '@/stores/plugins';
import { InlineMessage, SectionHeader } from './common';
import { marketViewOf } from './marketView';
import { MarketRevokedNote, MarketTierBadge, MarketUpdateButton } from './PluginMarket';

type Status = { tone: 'error' | 'success'; text: string };

const STATUS_CLASS: Record<AppPluginStatus, string> = {
  starting: 'text-muted-foreground',
  running: 'text-emerald-600 dark:text-emerald-400',
  stopped: 'text-muted-foreground',
  crashed: 'text-destructive',
};

/** 有设置页可看：声明了 ui 权限且已启用 */
export const hasAppPluginUi = (plugin: AppPluginView) =>
  plugin.enabled && plugin.permissions.includes('ui');

/** 「已安装」最上面的「Fynvra 插件」区：后台常驻的插件，启停、更新、删除、打开设置页 */
export function AppPluginsSection({ onOpen }: { onOpen: (id: string) => void }) {
  const plugins = useAppPluginsStore((state) => state.plugins);
  const loaded = useAppPluginsStore((state) => state.loaded);
  const error = useAppPluginsStore((state) => state.error);
  const addLocalDev = useAppPluginsStore((state) => state.addLocalDev);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const t = useT();

  const add = async () => {
    setAdding(true);
    setStatus(null);
    const result = await addLocalDev();
    setAdding(false);
    if (result.ok) {
      setStatus({
        tone: 'success',
        text: t('settings.plugins.added', { name: result.plugin.name }),
      });
    } else if (result.code !== 'canceled') {
      setStatus({ tone: 'error', text: result.error });
    }
  };

  return (
    <section>
      <SectionHeader title={t('settings.plugins.app.title')}>
        {import.meta.env.DEV && (
          <Button size="sm" variant="outline" disabled={adding} onClick={() => void add()}>
            {adding ? <Loader2 className="animate-spin" /> : <FolderPlus />}
            {t('settings.plugins.app.addLocalDev')}
          </Button>
        )}
      </SectionHeader>
      <p className="mb-3 text-muted-foreground text-sm">{t('settings.plugins.app.subtitle')}</p>
      {status && (
        <InlineMessage tone={status.tone} className="mb-3 break-all">
          {status.text}
        </InlineMessage>
      )}
      {error && (
        <InlineMessage tone="error" className="mb-3 break-all">
          {error}
        </InlineMessage>
      )}
      {loaded && plugins.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
          {t('settings.plugins.app.empty')}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {plugins.map((plugin) => (
            <AppPluginRow key={plugin.id} plugin={plugin} onOpen={onOpen} onStatus={setStatus} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AppPluginRow({
  plugin,
  onOpen,
  onStatus,
}: {
  plugin: AppPluginView;
  onOpen: (id: string) => void;
  onStatus: (status: Status) => void;
}) {
  const toggle = useAppPluginsStore((state) => state.toggle);
  const remove = useAppPluginsStore((state) => state.remove);
  const recopy = useAppPluginsStore((state) => state.recopy);
  const marketView = usePluginsStore((state) =>
    plugin.source === 'market' ? marketViewOf(state.market, plugin.id, 'fynvra') : undefined
  );
  const [busy, setBusy] = useState(false);
  const t = useT();
  const newVersion =
    marketView?.updateAvailable && marketView.latest ? marketView.latest.version : null;
  const onError = (text: string) => onStatus({ tone: 'error', text });

  const runRemove = async () => {
    const confirmed = await confirmDialog({
      message: t('settings.plugins.app.removeConfirm', { name: plugin.name }),
      detail: t('settings.plugins.app.removeDetail'),
      confirmLabel: t('common.confirmDelete'),
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(true);
    const result = await remove(plugin.id);
    setBusy(false);
    if (!result.ok) onError(result.error);
  };

  const runRecopy = async () => {
    const confirmed = await confirmDialog({
      message: t('settings.plugins.recopyConfirm', { name: plugin.name }),
      confirmLabel: t('settings.plugins.app.recopy'),
    });
    if (!confirmed) return;
    setBusy(true);
    const result = await recopy(plugin.id);
    setBusy(false);
    if (!result.ok) return onError(result.error);
    onStatus({ tone: 'success', text: t('settings.plugins.recopied', { name: plugin.name }) });
  };

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sm">{plugin.name}</span>
          <span className="text-muted-foreground text-xs">{plugin.version}</span>
          {plugin.tier ? (
            <MarketTierBadge tier={plugin.tier} />
          ) : (
            <Badge variant="outline">{t('settings.plugins.kinds.local')}</Badge>
          )}
          <span className={`text-xs ${STATUS_CLASS[plugin.status]}`}>
            {t(`settings.plugins.app.status.${plugin.status}`)}
          </span>
          {newVersion && (
            <span className="text-primary text-xs">
              {t('settings.plugins.market.updateAvailable', { version: newVersion })}
            </span>
          )}
        </div>
        {plugin.lastError && (
          <InlineMessage tone="error" className="mt-1 break-all">
            {plugin.lastError}
          </InlineMessage>
        )}
        {plugin.revokedReason !== undefined && <MarketRevokedNote reason={plugin.revokedReason} />}
      </div>
      {hasAppPluginUi(plugin) && (
        <Button size="sm" variant="outline" onClick={() => onOpen(plugin.id)}>
          <Settings2 />
          {t('settings.plugins.app.settings')}
        </Button>
      )}
      {newVersion && <MarketUpdateButton id={plugin.id} kind="fynvra" />}
      <Switch
        className="mt-1"
        checked={plugin.enabled}
        disabled={busy}
        aria-label={t('common.enableItem', { name: plugin.name })}
        onCheckedChange={async (enabled) => {
          setBusy(true);
          const result = await toggle(plugin.id, enabled);
          setBusy(false);
          if (!result.ok) onError(result.error);
        }}
      />
      {plugin.source === 'local' && (
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={busy}
          aria-label={t('settings.plugins.app.recopy')}
          title={t('settings.plugins.app.recopy')}
          onClick={() => void runRecopy()}
        >
          <RefreshCw />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={busy}
        aria-label={t('common.deleteItem', { name: plugin.name })}
        className="text-destructive hover:text-destructive"
        onClick={() => void runRemove()}
      >
        {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
      </Button>
    </li>
  );
}
