import type { AppPluginStatus, AppPluginView } from '@shared/types/appPlugins';
import {
  ArrowLeft,
  Blocks,
  Ellipsis,
  FolderPlus,
  Loader2,
  RefreshCw,
  Settings2,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n/I18nProvider';
import { confirmDialog } from '@/lib/appDialog';
import { useAppPluginsStore } from '@/stores/appPlugins';
import { usePluginsStore } from '@/stores/plugins';
import { AppPluginSettings } from './AppPluginSettings';
import { InlineMessage, SectionHeader } from './common';
import { marketViewOf } from './marketView';
import { PluginAuthor, PluginCard, PluginGrid, PluginHeader } from './PluginCard';
import { MarketRevokedNote, MarketTierBadge, MarketUpdateButton } from './PluginMarket';
import { InstalledReadme, PluginDetailTabs } from './PluginReadme';
import { pluginSourceIconKind } from './pluginSource';

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

/** 打开详情页；settings 为 true 时直接打开「设置」标签 */
type OpenAppPlugin = (id: string, settings?: boolean) => void;

/** 「已安装」最上面的「Fynvra 插件」区：后台常驻的插件，启停、更新、删除、打开详情页 */
export function AppPluginsSection({ onOpen }: { onOpen: OpenAppPlugin }) {
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
        <PluginGrid>
          {plugins.map((plugin) => (
            <AppPluginFace
              key={plugin.id}
              variant="card"
              plugin={plugin}
              onOpen={onOpen}
              onStatus={setStatus}
            />
          ))}
        </PluginGrid>
      )}
    </section>
  );
}

/** Fynvra 插件详情：标题区 + 「使用说明」「设置」标签（设置放插件声明的设置页） */
export function AppPluginDetail({
  plugin,
  settingsRequest,
  onOpen,
  onBack,
}: {
  plugin: AppPluginView;
  settingsRequest: number;
  onOpen: OpenAppPlugin;
  onBack: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const t = useT();
  return (
    <div className="grid gap-5">
      <div>
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft />
          {t('settings.plugins.back')}
        </Button>
      </div>
      <AppPluginFace variant="header" plugin={plugin} onOpen={onOpen} onStatus={setStatus} />
      {status && (
        <InlineMessage tone={status.tone} className="break-all">
          {status.text}
        </InlineMessage>
      )}
      <PluginDetailTabs
        tabKey={`fynvra:${plugin.id}`}
        settingsRequest={settingsRequest}
        readme={<InstalledReadme kind="fynvra" id={plugin.id} description={plugin.description} />}
        settings={
          hasAppPluginUi(plugin) ? (
            <AppPluginSettings key={plugin.id} id={plugin.id} />
          ) : (
            <p className="text-muted-foreground text-sm">{t('settings.plugins.app.noUi')}</p>
          )
        }
      />
    </div>
  );
}

/** 卡片与详情页标题区共用：同一组徽标、简介、开关和「…」菜单，只换布局 */
function AppPluginFace({
  variant,
  plugin,
  onOpen,
  onStatus,
}: {
  variant: 'card' | 'header';
  plugin: AppPluginView;
  onOpen: OpenAppPlugin;
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
  const hasUi = hasAppPluginUi(plugin);
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

  const authorName =
    plugin.tier === 'official'
      ? t('settings.plugins.app.official')
      : plugin.source === 'local'
        ? t('settings.plugins.app.localDev')
        : (marketView?.author ?? t('settings.plugins.kinds.market'));

  const face = {
    icon: Blocks,
    name: plugin.name,
    badges: (
      <>
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
      </>
    ),
    description:
      plugin.description ??
      marketView?.description ??
      t('settings.plugins.app.fallbackDescription', { version: plugin.version }),
    extra: (plugin.lastError || plugin.revokedReason !== undefined) && (
      <>
        {plugin.lastError && (
          <InlineMessage tone="error" className="break-all">
            {plugin.lastError}
          </InlineMessage>
        )}
        {plugin.revokedReason !== undefined && <MarketRevokedNote reason={plugin.revokedReason} />}
      </>
    ),
    author: (
      <PluginAuthor
        icon={pluginSourceIconKind({
          kind: plugin.source === 'local' ? 'local' : undefined,
          tier: plugin.tier,
        })}
        name={authorName}
        note={plugin.version}
      />
    ),
    actions: (
      <>
        {newVersion && <MarketUpdateButton id={plugin.id} kind="fynvra" />}
        <Switch
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
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={busy}
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('settings.plugins.moreActions', { name: plugin.name })}
              />
            }
          >
            {busy ? <Loader2 className="animate-spin" /> : <Ellipsis />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {hasUi && (
              <DropdownMenuItem onClick={() => onOpen(plugin.id, true)}>
                <Settings2 />
                {t('settings.plugins.app.settings')}
              </DropdownMenuItem>
            )}
            {plugin.source === 'local' && (
              <DropdownMenuItem onClick={() => void runRecopy()}>
                <RefreshCw />
                {t('settings.plugins.app.recopy')}
              </DropdownMenuItem>
            )}
            {(hasUi || plugin.source === 'local') && <DropdownMenuSeparator />}
            <DropdownMenuItem variant="destructive" onClick={() => void runRemove()}>
              <Trash2 />
              {t('common.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    ),
  };
  return variant === 'card' ? (
    <PluginCard {...face} onOpen={() => onOpen(plugin.id)} />
  ) : (
    <PluginHeader {...face} />
  );
}
