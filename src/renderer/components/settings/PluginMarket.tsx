import {
  MARKET_CATEGORIES,
  type MarketCategory,
  type MarketPermission,
  type MarketPluginView,
  type MarketTier,
  type PluginKind,
} from '@shared/types/pluginMarket';
import {
  ArrowLeft,
  Blocks,
  ExternalLink,
  Loader2,
  PackagePlus,
  Puzzle,
  RefreshCw,
  Store,
} from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useLocale, useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { useAppPluginsStore } from '@/stores/appPlugins';
import { usePluginsStore } from '@/stores/plugins';
import { useRolesStore } from '@/stores/roles';
import { EmptyState, InlineMessage, SectionHeader } from './common';
import { filterMarketPlugins, marketAction, marketNeedsRefresh } from './marketView';
import { PluginAuthor, PluginCard, PluginGrid } from './PluginCard';
import { ReadmeLoading, ReadmeView } from './PluginReadme';
import { pluginSourceIconKind } from './pluginSource';

type Status = { tone: 'error' | 'success'; text: string };

/** 分级徽标：官方 / 已审核 */
export function MarketTierBadge({ tier }: { tier: MarketTier }) {
  const t = useT();
  return (
    <Badge variant={tier === 'official' ? 'default' : 'outline'}>
      {t(`settings.plugins.market.tiers.${tier}`)}
    </Badge>
  );
}

/** 类别徽标：Fynvra 插件 / PI 插件 */
export function MarketKindBadge({ kind }: { kind: PluginKind }) {
  const t = useT();
  return <Badge variant="outline">{t(`settings.plugins.market.kinds.${kind}`)}</Badge>;
}

/** 已撤回提示（红色） */
export function MarketRevokedNote({ reason }: { reason: string }) {
  const t = useT();
  return (
    <InlineMessage tone="error" className="mt-1 break-all">
      {t('settings.plugins.market.revoked', { reason })}
    </InlineMessage>
  );
}

/**
 * 「更新」按钮：id 是 kind 对应登记里的 id（pi → plugins.json，fynvra → fynvra-plugins.json，
 * 后者走 appplugins:update）；进行中转圈，失败在按钮下显示错误
 */
export function MarketUpdateButton({ id, kind = 'pi' }: { id: string; kind?: PluginKind }) {
  const piUpdate = usePluginsStore((state) => state.marketUpdate);
  const appUpdate = useAppPluginsStore((state) => state.update);
  const marketUpdate = kind === 'fynvra' ? appUpdate : piUpdate;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT();
  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <Button
        size="sm"
        disabled={busy}
        onClick={async (event) => {
          event.stopPropagation();
          setBusy(true);
          setError(null);
          const result = await marketUpdate(id);
          setBusy(false);
          if (!result.ok) setError(result.error);
        }}
      >
        {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        {t(busy ? 'settings.plugins.market.updating' : 'settings.plugins.market.update')}
      </Button>
      {error && (
        <InlineMessage tone="error" className="max-w-64 break-all text-right">
          {error}
        </InlineMessage>
      )}
    </span>
  );
}

/**
 * 「市场」标签页：市场插件的搜索、筛选和卡片；点卡片在页内切到详情。
 */
export function PluginMarketTab() {
  const market = usePluginsStore((state) => state.market);
  const marketError = usePluginsStore((state) => state.marketError);
  const refreshing = usePluginsStore((state) => state.marketRefreshing);
  const loadMarket = usePluginsStore((state) => state.loadMarket);
  const refreshMarket = usePluginsStore((state) => state.refreshMarket);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<MarketCategory | 'all'>('all');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [installing, setInstalling] = useState<MarketPluginView | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const t = useT();
  const locale = useLocale();

  // 首次进入：先读缓存，为空或超过 5 分钟再刷新一次（不强制）
  useEffect(() => {
    let active = true;
    void (async () => {
      await loadMarket();
      const state = usePluginsStore.getState().market;
      if (active && state && marketNeedsRefresh(state, Date.now())) await refreshMarket(false);
    })();
    return () => {
      active = false;
    };
  }, [loadMarket, refreshMarket]);

  const plugins = market?.plugins ?? [];
  const shown = useMemo(
    () => filterMarketPlugins(plugins, query, category),
    [plugins, query, category]
  );
  const detail = detailId ? plugins.find((plugin) => plugin.id === detailId) : undefined;
  const categoryItems = (['all', ...MARKET_CATEGORIES] as const).map((value) => ({
    value,
    label: t(`settings.plugins.market.categories.${value}`),
  }));

  const dialog = (
    <MarketInstallDialog
      plugin={installing}
      onClose={() => setInstalling(null)}
      onDone={setStatus}
    />
  );

  if (detail) {
    return (
      <>
        <MarketDetail
          plugin={detail}
          onBack={() => setDetailId(null)}
          onInstall={() => {
            setStatus(null);
            setInstalling(detail);
          }}
          status={status}
        />
        {dialog}
      </>
    );
  }

  return (
    <div className="grid gap-8">
      <section>
        <SectionHeader title={t('settings.plugins.tabs.market')}>
          {market?.configured && (
            <span className="text-muted-foreground text-xs">
              {market.fetchedAt
                ? t('settings.plugins.market.lastUpdated', {
                    time: new Date(market.fetchedAt).toLocaleString(locale),
                  })
                : t('settings.plugins.market.neverUpdated')}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={refreshing || market?.configured === false}
            onClick={() => void refreshMarket(true)}
          >
            {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {t('settings.plugins.market.refresh')}
          </Button>
        </SectionHeader>

        {marketError && (
          <InlineMessage tone="error" className="mb-3 break-all">
            {marketError}
          </InlineMessage>
        )}
        {market?.error && (
          <InlineMessage tone="error" className="mb-3 break-all">
            {market.error}
          </InlineMessage>
        )}
        {status && (
          <InlineMessage tone={status.tone} className="mb-3 break-all">
            {status.text}
          </InlineMessage>
        )}

        {market === null ? (
          <p className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
            <Loader2 className="size-4 animate-spin" />
            {t('common.loading')}
          </p>
        ) : !market.configured ? (
          <EmptyState
            icon={Store}
            title={t('settings.plugins.market.notConfigured')}
            description={t('settings.plugins.market.notConfiguredHint')}
          />
        ) : (
          <>
            <div className="mb-3 flex gap-2">
              <Input
                value={query}
                maxLength={100}
                placeholder={t('settings.plugins.market.searchPlaceholder')}
                aria-label={t('settings.plugins.market.searchPlaceholder')}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Select
                items={categoryItems}
                value={category}
                onValueChange={(value) => {
                  if (value === 'all' || MARKET_CATEGORIES.includes(value as MarketCategory)) {
                    setCategory(value as MarketCategory | 'all');
                  }
                }}
              >
                <SelectTrigger
                  className="w-36 shrink-0"
                  aria-label={t('settings.plugins.market.category')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {categoryItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {shown.length === 0 ? (
              <EmptyState
                icon={Store}
                title={t(
                  plugins.length === 0
                    ? 'settings.plugins.market.empty'
                    : 'settings.plugins.market.noMatch'
                )}
              />
            ) : (
              <PluginGrid>
                {shown.map((plugin) => (
                  <MarketCard
                    key={plugin.id}
                    plugin={plugin}
                    onOpen={() => {
                      setStatus(null);
                      setDetailId(plugin.id);
                    }}
                    onInstall={() => {
                      setStatus(null);
                      setInstalling(plugin);
                    }}
                  />
                ))}
              </PluginGrid>
            )}
          </>
        )}
      </section>
      {dialog}
    </div>
  );
}

/** 卡片右侧的按钮：安装 / 已安装 / 更新 / 需要更新 Fynvra */
function MarketActionButton({
  plugin,
  onInstall,
}: {
  plugin: MarketPluginView;
  onInstall: () => void;
}) {
  const t = useT();
  const action = marketAction(plugin);
  if (action === 'update' && plugin.installed) {
    return <MarketUpdateButton id={plugin.installed.pluginId} kind={plugin.kind} />;
  }
  if (action === 'install') {
    return (
      <Button
        size="sm"
        className="shrink-0"
        onClick={(event) => {
          event.stopPropagation();
          onInstall();
        }}
      >
        <PackagePlus />
        {t('settings.plugins.market.install')}
      </Button>
    );
  }
  return (
    <Button size="sm" variant="outline" className="shrink-0" disabled>
      {t(
        action === 'installed'
          ? 'settings.plugins.market.installed'
          : 'settings.plugins.market.incompatible'
      )}
    </Button>
  );
}

function MarketCard({
  plugin,
  onOpen,
  onInstall,
}: {
  plugin: MarketPluginView;
  onOpen: () => void;
  onInstall: () => void;
}) {
  const t = useT();
  return (
    <PluginCard
      icon={plugin.kind === 'fynvra' ? Blocks : Puzzle}
      name={plugin.name}
      onOpen={onOpen}
      badges={
        <>
          <MarketTierBadge tier={plugin.tier} />
          <MarketKindBadge kind={plugin.kind} />
        </>
      }
      description={plugin.description}
      extra={plugin.revoked && <MarketRevokedNote reason={plugin.revoked.reason} />}
      author={
        <PluginAuthor
          icon={pluginSourceIconKind({ tier: plugin.tier })}
          name={plugin.author}
          note={
            plugin.latest && t('settings.plugins.market.latest', { version: plugin.latest.version })
          }
        />
      }
      actions={<MarketActionButton plugin={plugin} onInstall={onInstall} />}
    />
  );
}

/** 权限列表；没有声明时写「未声明特殊权限」，都补一句「声明只是作者自述」 */
function PermissionList({ permissions }: { permissions: readonly MarketPermission[] }) {
  const t = useT();
  return (
    <div className="text-sm">
      {permissions.length === 0 ? (
        <p>{t('settings.plugins.market.noPermissions')}</p>
      ) : (
        <ul className="list-disc space-y-0.5 pl-5">
          {permissions.map((permission) => (
            <li key={permission}>
              {t(`settings.plugins.market.permissionNames.${permission}`)}
              <span className="ml-1.5 font-mono text-muted-foreground text-xs">{permission}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-muted-foreground text-xs">
        {t('settings.plugins.market.selfReported')}
      </p>
    </div>
  );
}

/** 外链：target=_blank 由 Main 拦截后交给系统浏览器打开（与聊天里的链接一致） */
function ExternalAnchor({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 break-all font-medium text-primary underline underline-offset-4"
    >
      {children}
      <ExternalLink className="size-3.5 shrink-0" />
    </a>
  );
}

function MarketDetail({
  plugin,
  onBack,
  onInstall,
  status,
}: {
  plugin: MarketPluginView;
  onBack: () => void;
  onInstall: () => void;
  status: Status | null;
}) {
  const t = useT();
  const latest = plugin.latest;
  const rows: [string, ReactNode][] = [
    ...(latest
      ? ([
          [t('settings.plugins.market.version'), latest.version],
          [t('settings.plugins.market.publishedAt'), latest.publishedAt],
        ] as [string, ReactNode][])
      : []),
    [t('settings.plugins.market.license'), plugin.license],
    [
      t('settings.plugins.market.repository'),
      <ExternalAnchor key="repo" href={plugin.repository}>
        {plugin.repository}
      </ExternalAnchor>,
    ],
    ...(plugin.homepage
      ? ([
          [
            t('settings.plugins.market.homepage'),
            <ExternalAnchor key="home" href={plugin.homepage}>
              {plugin.homepage}
            </ExternalAnchor>,
          ],
        ] as [string, ReactNode][])
      : []),
  ];

  return (
    <div className="grid gap-5">
      <div>
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft />
          {t('settings.plugins.market.back')}
        </Button>
      </div>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{plugin.name}</h3>
            <MarketTierBadge tier={plugin.tier} />
            <MarketKindBadge kind={plugin.kind} />
          </div>
          <p className="text-muted-foreground text-xs">
            {t('settings.plugins.market.by', { author: plugin.author })}
          </p>
          <p className="mt-1 text-muted-foreground text-sm">{plugin.description}</p>
          {plugin.revoked && <MarketRevokedNote reason={plugin.revoked.reason} />}
        </div>
        <MarketActionButton plugin={plugin} onInstall={onInstall} />
      </div>
      {status && (
        <InlineMessage tone={status.tone} className="break-all">
          {status.text}
        </InlineMessage>
      )}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0">{value}</dd>
          </div>
        ))}
      </dl>

      {latest && (
        <section>
          <h4 className="mb-1.5 font-medium text-sm">{t('settings.plugins.market.permissions')}</h4>
          <PermissionList permissions={latest.permissions} />
        </section>
      )}
      {latest?.changelog && (
        <section>
          <h4 className="mb-1.5 font-medium text-sm">{t('settings.plugins.market.changelog')}</h4>
          <p className="whitespace-pre-wrap text-sm">{latest.changelog}</p>
        </section>
      )}
      <section>
        <h4 className="mb-1.5 font-medium text-sm">{t('settings.plugins.market.readme')}</h4>
        {latest?.hasReadme ? (
          <MarketReadme
            key={`${plugin.id}@${latest.version}`}
            pluginId={plugin.id}
            version={latest.version}
          />
        ) : (
          <p className="text-muted-foreground text-sm">{t('settings.plugins.market.noReadme')}</p>
        )}
      </section>
    </div>
  );
}

/** 市场版本的 README：这里只负责加载，渲染交给 ReadmeView（没有本地目录，相对路径图片不显示） */
function MarketReadme({ pluginId, version }: { pluginId: string; version: string }) {
  const marketReadme = usePluginsStore((state) => state.marketReadme);
  const [result, setResult] = useState<{ text: string } | { error: string } | null>(null);

  useEffect(() => {
    let active = true;
    void marketReadme(pluginId, version).then((next) => {
      if (active) setResult(next.ok ? { text: next.text } : { error: next.error });
    });
    return () => {
      active = false;
    };
  }, [marketReadme, pluginId, version]);

  if (!result) return <ReadmeLoading />;
  if ('error' in result) {
    return (
      <InlineMessage tone="error" className="break-all">
        {result.error}
      </InlineMessage>
    );
  }
  return <ReadmeView text={result.text} source={{ kind: 'market', pluginId, version }} />;
}

/**
 * 安装确认：风险提示、分级说明、声明的权限、「安装后挂到这些角色」多选（默认不勾）。
 * 安装成功后用角色保存逻辑把新插件 id 加进所选角色的 pluginIds；失败时留在对话框里显示错误。
 */
function MarketInstallDialog({
  plugin,
  onClose,
  onDone,
}: {
  plugin: MarketPluginView | null;
  onClose: () => void;
  onDone: (status: Status) => void;
}) {
  // 关闭动画期间沿用上一次的内容，避免弹窗闪成空白
  const [shown, setShown] = useState(plugin);
  if (plugin !== null && plugin !== shown) setShown(plugin);
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      open={plugin !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        {shown?.latest && (
          <InstallContent
            key={`${shown.id}@${shown.latest.version}`}
            plugin={shown}
            version={shown.latest.version}
            permissions={shown.latest.permissions}
            onBusyChange={setBusy}
            onDone={(status) => {
              onDone(status);
              onClose();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function InstallContent({
  plugin,
  version,
  permissions,
  onBusyChange,
  onDone,
}: {
  plugin: MarketPluginView;
  version: string;
  permissions: readonly MarketPermission[];
  onBusyChange: (busy: boolean) => void;
  onDone: (status: Status) => void;
}) {
  const marketInstall = usePluginsStore((state) => state.marketInstall);
  const roles = useRolesStore((state) => state.roles);
  const saveRole = useRolesStore((state) => state.save);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT();
  const baseId = useId();
  // Fynvra 插件不挂角色，风险提示也不同
  const isApp = plugin.kind === 'fynvra';

  const run = async () => {
    setBusy(true);
    onBusyChange(true);
    setError(null);
    const result = await marketInstall(plugin.id, version);
    if (!result.ok) {
      setBusy(false);
      onBusyChange(false);
      setError(result.error);
      return;
    }
    const pluginId = !isApp && 'plugin' in result ? result.plugin.id : '';
    // 取最新的角色数据再改，逐个保存；某个失败不影响其他
    const failures: string[] = [];
    for (const roleId of pluginId ? selected : []) {
      const role = useRolesStore.getState().roles.find((item) => item.id === roleId);
      if (!role || role.pluginIds?.includes(pluginId)) continue;
      const saved = await saveRole({ ...role, pluginIds: [...(role.pluginIds ?? []), pluginId] });
      if (!saved.ok) failures.push(`${role.name}: ${saved.error}`);
    }
    setBusy(false);
    onBusyChange(false);
    onDone(
      failures.length === 0
        ? {
            tone: 'success',
            text: t('settings.plugins.market.installedDone', { name: plugin.name }),
          }
        : {
            tone: 'error',
            text: t('settings.plugins.market.attachFailed', {
              name: plugin.name,
              error: failures.join('; '),
            }),
          }
    );
  };

  return (
    <div className="grid min-w-0 gap-4">
      <DialogHeader>
        <DialogTitle>
          {t('settings.plugins.market.installTitle', { name: plugin.name, version })}
        </DialogTitle>
      </DialogHeader>

      <p
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 font-medium text-destructive text-sm"
      >
        {t(
          isApp ? 'settings.plugins.market.installRiskApp' : 'settings.plugins.market.installRisk'
        )}
      </p>

      <div className="grid gap-1 text-sm">
        <div className="flex items-center gap-2">
          <MarketTierBadge tier={plugin.tier} />
          <span className="text-muted-foreground text-xs">
            {t('settings.plugins.market.by', { author: plugin.author })}
          </span>
        </div>
        <p className="text-muted-foreground text-xs">{t('settings.plugins.market.tierHint')}</p>
      </div>

      <div>
        <h4 className="mb-1.5 font-medium text-sm">{t('settings.plugins.market.permissions')}</h4>
        <PermissionList permissions={permissions} />
      </div>

      {!isApp && (
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">{t('settings.plugins.market.attachRoles')}</span>
            <span className="text-muted-foreground text-xs">
              {t('settings.roles.selected', { count: selected.length })}
            </span>
          </div>
          <ul className="max-h-48 divide-y overflow-y-auto rounded-md border">
            {roles.length === 0 && (
              <li className="px-3 py-4 text-center text-muted-foreground text-xs">
                {t('settings.plugins.market.noRoles')}
              </li>
            )}
            {roles.map((role) => {
              const id = `${baseId}-${role.id}`;
              return (
                <li key={role.id}>
                  <label
                    htmlFor={id}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2 text-sm',
                      busy ? 'cursor-default' : 'cursor-pointer hover:bg-accent/50'
                    )}
                  >
                    <Checkbox
                      id={id}
                      checked={selected.includes(role.id)}
                      disabled={busy}
                      onCheckedChange={(on) =>
                        setSelected((current) =>
                          on ? [...current, role.id] : current.filter((item) => item !== role.id)
                        )
                      }
                    />
                    <span className="truncate">{role.name}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="text-muted-foreground text-xs">{t('settings.plugins.market.attachHint')}</p>
        </div>
      )}

      {error && (
        <InlineMessage tone="error" className="break-all">
          {error}
        </InlineMessage>
      )}

      <DialogFooter>
        <DialogClose disabled={busy} render={<Button variant="outline" />}>
          {t('common.cancel')}
        </DialogClose>
        <Button disabled={busy} onClick={() => void run()}>
          {busy && <Loader2 className="animate-spin" />}
          {t(busy ? 'settings.plugins.market.installing' : 'settings.plugins.market.install')}
        </Button>
      </DialogFooter>
    </div>
  );
}
