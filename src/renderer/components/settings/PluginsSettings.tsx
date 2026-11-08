import { findCatalogProvider, providerApiLabel, resolveBaseUrl } from '@shared/modelCatalog';
import type { ModelProviderView } from '@shared/types/llm';
import {
  isPluginProviderName,
  localPluginMode,
  MAX_REQUESTED_PROVIDERS,
  type PluginEntry,
  type PluginMode,
} from '@shared/types/plugins';
import {
  AppWindow,
  CircleAlert,
  CircleCheck,
  Code,
  CopyPlus,
  Ellipsis,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  HardDriveDownload,
  Loader2,
  PackagePlus,
  Plus,
  Puzzle,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n/I18nProvider';
import { confirmDialog } from '@/lib/appDialog';
import { usePluginsStore } from '@/stores/plugins';
import { useProvidersStore } from '@/stores/providers';
import { useWorkspacesStore } from '@/stores/workspaces';
import { EmptyState, InlineMessage, SectionHeader } from './common';
import { PluginImportDialog } from './PluginImportDialog';
import { ProviderDialog, type ProviderEditing } from './ProviderDialog';
import { draftFromCatalog, type ProviderDraft } from './providerForm';
import { useSettingsViewStore } from './settingsViewStore';

type Status = { tone: 'error' | 'success'; text: string };
/** 添加目标：本地（Main 弹框选择并复制）或远程来源 */
type Target = { kind: 'local' } | { kind: 'remote'; source: string };

/** 设置 → 插件：添加本地插件（一律复制）、从 npm / git 安装，启用 / 停用 / 移除。 */
export function PluginsSettings() {
  const plugins = usePluginsStore((state) => state.plugins);
  const loaded = usePluginsStore((state) => state.loaded);
  const error = usePluginsStore((state) => state.error);
  const addLocal = usePluginsStore((state) => state.addLocal);
  const install = usePluginsStore((state) => state.install);
  const [source, setSource] = useState('');
  const [working, setWorking] = useState<'local' | 'remote' | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [importSession, setImportSession] = useState<number | null>(null);
  const importSessions = useRef(0);
  const t = useT();

  const openImport = () => {
    importSessions.current += 1;
    setStatus(null);
    setImportSession(importSessions.current);
  };

  const proceed = async (target: Target) => {
    if (working) return;
    setStatus(null);
    setWorking(target.kind);
    const result = target.kind === 'local' ? await addLocal() : await install(target.source);
    setWorking(null);
    if (result.ok) {
      if (target.kind === 'remote') setSource('');
      setStatus({
        tone: 'success',
        text: t('settings.plugins.added', { name: result.plugin.name }),
      });
    } else if (result.code !== 'canceled') {
      setStatus({ tone: 'error', text: result.error });
    }
  };

  const trimmed = source.trim();

  return (
    <section>
      <SectionHeader title={t('settings.plugins.title')}>
        <Button size="sm" variant="outline" disabled={working !== null} onClick={openImport}>
          <HardDriveDownload />
          <span className="hidden sm:inline">{t('settings.import.fromLocal')}</span>
          <span className="sm:hidden">{t('settings.import.fromLocalShort')}</span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={working !== null}
          onClick={() => void proceed({ kind: 'local' })}
        >
          {working === 'local' ? <Loader2 className="animate-spin" /> : <FolderPlus />}
          {t('settings.plugins.addLocal')}
        </Button>
      </SectionHeader>

      <p className="mb-3 text-muted-foreground text-sm">{t('settings.plugins.subtitle')}</p>

      <form
        className="mb-1 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed && working === null) void proceed({ kind: 'remote', source: trimmed });
        }}
      >
        <Input
          value={source}
          maxLength={500}
          spellCheck={false}
          className="font-mono"
          disabled={working !== null}
          placeholder={t('settings.plugins.installPlaceholder')}
          aria-label={t('settings.plugins.installPlaceholder')}
          onChange={(event) => setSource(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={!trimmed || working !== null}>
          {working === 'remote' ? <Loader2 className="animate-spin" /> : <PackagePlus />}
          {t(working === 'remote' ? 'settings.plugins.installing' : 'settings.plugins.install')}
        </Button>
      </form>
      <p className="mb-4 text-muted-foreground text-xs">{t('settings.plugins.installHint')}</p>

      {status && (
        <InlineMessage tone={status.tone} className="mb-3 break-all">
          {status.text}
        </InlineMessage>
      )}
      {error && <InlineMessage tone="error">{error}</InlineMessage>}

      {loaded && plugins.length === 0 ? (
        <EmptyState icon={Puzzle} title={t('settings.plugins.empty')}>
          <Button size="sm" variant="outline" disabled={working !== null} onClick={openImport}>
            <HardDriveDownload />
            {t('settings.import.fromLocalShort')}
          </Button>
        </EmptyState>
      ) : (
        <ul className="divide-y rounded-lg border">
          {plugins.map((plugin) => (
            <PluginRow key={plugin.id} plugin={plugin} onStatus={setStatus} />
          ))}
        </ul>
      )}

      <PluginImportDialog
        session={importSession}
        onClose={() => setImportSession(null)}
        onImported={setStatus}
      />
    </section>
  );
}

function PluginRow({
  plugin,
  onStatus,
}: {
  plugin: PluginEntry;
  onStatus: (status: Status) => void;
}) {
  const toggle = usePluginsStore((state) => state.toggle);
  const remove = usePluginsStore((state) => state.remove);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [addingName, setAddingName] = useState(false);
  const t = useT();
  const mode = localPluginMode(plugin);
  const onError = (text: string) => onStatus({ tone: 'error', text });

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sm">{plugin.name}</span>
          <Badge variant="outline">{t(`settings.plugins.kinds.${plugin.kind}`)}</Badge>
          {mode === 'link' && <Badge variant="outline">{t('settings.plugins.linked')}</Badge>}
          {!plugin.enabled && <Badge>{t('common.disabled')}</Badge>}
        </div>
        <p
          className="truncate font-mono text-muted-foreground text-xs"
          title={plugin.kind === 'local' ? plugin.path : `${plugin.path}\n${plugin.source}`}
        >
          {plugin.path}
        </p>
        <RequestedProviders
          plugin={plugin}
          adding={addingName}
          onAddingChange={setAddingName}
          onError={onError}
        />
        {confirmingRemove && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-xs">
              {t(
                mode === 'copy'
                  ? 'settings.plugins.removeConsequenceCopy'
                  : mode === 'link'
                    ? 'settings.plugins.removeConsequenceLink'
                    : 'settings.plugins.removeConsequence'
              )}
            </span>
            <Button
              size="sm"
              variant="destructive"
              disabled={removing}
              onClick={async () => {
                setRemoving(true);
                const result = await remove(plugin.id);
                setRemoving(false);
                if (!result.ok) {
                  setConfirmingRemove(false);
                  onError(result.error);
                } else if (result.warning) {
                  onStatus({ tone: 'success', text: result.warning });
                }
              }}
            >
              {removing && <Loader2 className="animate-spin" />}
              {t(removing ? 'settings.plugins.removing' : 'common.confirmDelete')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={removing}
              onClick={() => setConfirmingRemove(false)}
            >
              {t('common.cancel')}
            </Button>
          </div>
        )}
      </div>
      <Switch
        className="mt-1"
        checked={plugin.enabled}
        aria-label={t('common.enableItem', { name: plugin.name })}
        onCheckedChange={async (enabled) => {
          const result = await toggle(plugin.id, enabled);
          if (!result.ok) onError(result.error);
        }}
      />
      <PluginActions
        plugin={plugin}
        mode={mode}
        onStatus={onStatus}
        onAddServiceName={() => setAddingName(true)}
      />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('common.deleteItem', { name: plugin.name })}
        className="text-destructive hover:text-destructive"
        onClick={() => setConfirmingRemove(true)}
      >
        <Trash2 />
      </Button>
    </li>
  );
}

/** 卡片的「…」菜单：打开文件夹、用…打开、作为工作区打开，以及按模式出现的重新复制 / 转为副本 */
function PluginActions({
  plugin,
  mode,
  onStatus,
  onAddServiceName,
}: {
  plugin: PluginEntry;
  mode: PluginMode | null;
  onStatus: (status: Status) => void;
  /** 在卡片里原地打开「添加模型服务名」输入框 */
  onAddServiceName: () => void;
}) {
  const reveal = usePluginsStore((state) => state.reveal);
  const openIn = usePluginsStore((state) => state.openIn);
  const openAsWorkspace = usePluginsStore((state) => state.openAsWorkspace);
  const recopy = usePluginsStore((state) => state.recopy);
  const convertToCopy = usePluginsStore((state) => state.convertToCopy);
  const targets = useWorkspacesStore((state) => state.openWithTargets);
  const loadOpenWithApps = useWorkspacesStore((state) => state.loadOpenWithApps);
  const [busy, setBusy] = useState(false);
  /** 选了「添加模型服务名」时菜单关闭不把焦点还给「…」按钮，留给刚出现的输入框；其他项不变 */
  const keepFocusOnClose = useRef(false);
  const t = useT();
  const onError = (text: string) => onStatus({ tone: 'error', text });

  const report = (result: { ok: true } | { ok: false; error: string }) => {
    if (!result.ok) onError(result.error);
  };

  const openWorkspace = async () => {
    const result = await openAsWorkspace(plugin.id);
    if (!result.ok) return onError(result.error);
    const workspaces = useWorkspacesStore.getState();
    await workspaces.refresh();
    workspaces.select(result.workspaceId);
    useSettingsViewStore.getState().close();
  };

  const runRecopy = async () => {
    const confirmed = await confirmDialog({
      message: t('settings.plugins.recopyConfirm', { name: plugin.name }),
      detail: t('settings.plugins.recopyDetail'),
      confirmLabel: t('settings.plugins.recopy'),
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(true);
    const result = await recopy(plugin.id);
    setBusy(false);
    if (!result.ok) return onError(result.error);
    onStatus({ tone: 'success', text: t('settings.plugins.recopied', { name: plugin.name }) });
  };

  const runConvert = async () => {
    setBusy(true);
    const result = await convertToCopy(plugin.id);
    setBusy(false);
    if (!result.ok) return onError(result.error);
    onStatus({ tone: 'success', text: t('settings.plugins.converted', { name: plugin.name }) });
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open && targets.length === 0) void loadOpenWithApps();
      }}
    >
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
      <DropdownMenuContent
        align="end"
        finalFocus={() => {
          if (!keepFocusOnClose.current) return true;
          keepFocusOnClose.current = false;
          return false;
        }}
      >
        <DropdownMenuItem onClick={async () => report(await reveal(plugin.id))}>
          <FolderOpen />
          {t('settings.plugins.reveal')}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <AppWindow />
            {t('settings.plugins.openWith')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-w-72">
            {targets.length === 0 && (
              <DropdownMenuItem disabled>{t('common.loading')}</DropdownMenuItem>
            )}
            {targets.map((target) => {
              const Icon =
                target.kind === 'vscode' ? Code : target.kind === 'explorer' ? Folder : AppWindow;
              return (
                <DropdownMenuItem
                  key={target.id}
                  onClick={async () => report(await openIn(plugin.id, target.id))}
                >
                  <Icon />
                  <span className="truncate">{target.name}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onClick={() => void openWorkspace()}>
          <FolderTree />
          {t('settings.plugins.openAsWorkspace')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            keepFocusOnClose.current = true;
            onAddServiceName();
          }}
        >
          <Plus />
          {t('settings.plugins.manualAdd')}
        </DropdownMenuItem>
        {mode && <DropdownMenuSeparator />}
        {mode === 'copy' && (
          <DropdownMenuItem onClick={() => void runRecopy()}>
            <RefreshCw />
            {t('settings.plugins.recopy')}
          </DropdownMenuItem>
        )}
        {mode === 'link' && (
          <DropdownMenuItem onClick={() => void runConvert()}>
            <CopyPlus />
            {t('settings.plugins.convertToCopy')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 自动（同名服务）在下拉框里的值；服务 id 只含小写字母、数字和 -，不会与之冲突 */
const AUTO_VALUE = '__auto__';

/** 下拉框里服务的地址：baseUrl 的 host，留空时用协议官方地址；解析失败显示协议名 */
function providerHost(provider: ModelProviderView): string {
  try {
    return new URL(resolveBaseUrl(provider.api, provider.baseUrl)).host;
  } catch {
    return providerApiLabel(provider.api);
  }
}

function isUsable(provider: ModelProviderView): boolean {
  return provider.enabled && provider.hasApiKey && provider.models.length > 0;
}

/** 插件的服务名：扫描结果、运行时记录、手动添加三者合并去重，保持各自顺序 */
function pluginProviderNames(entry: PluginEntry): string[] {
  return [
    ...new Set([
      ...(entry.scannedProviders ?? []),
      ...(entry.requestedProviders ?? []),
      ...(entry.manualProviders ?? []),
    ]),
  ];
}

/** 「新建服务」的草稿：沿用「自定义」（OpenAI 兼容）新建时的默认值，名称预填为服务名 */
function newServiceDraft(name: string): ProviderDraft | null {
  const custom = findCatalogProvider('openai-compatible');
  return custom ? { ...draftFromCatalog(custom), name } : null;
}

/**
 * 卡片里的「模型服务」：添加时扫描代码识别的、运行时按名查找过的和手动添加的服务名，
 * 每个名字可下拉改选实际使用的服务；未找到的可直接新建。列表为空且不在手动添加时什么也不显示
 * （很多插件不用模型服务），手动添加的入口在卡片「…」菜单里
 */
function RequestedProviders({
  plugin,
  adding,
  onAddingChange,
  onError,
}: {
  plugin: PluginEntry;
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
  onError: (text: string) => void;
}) {
  const plugins = usePluginsStore((state) => state.plugins);
  const providerMap = usePluginsStore((state) => state.providerMap);
  const setProviderMapping = usePluginsStore((state) => state.setProviderMapping);
  const setManualProviders = usePluginsStore((state) => state.setManualProviders);
  const providers = useProvidersStore((state) => state.providers);
  const t = useT();
  const names = pluginProviderNames(plugin);
  const manual = plugin.manualProviders ?? [];
  const detected = new Set([
    ...(plugin.scannedProviders ?? []),
    ...(plugin.requestedProviders ?? []),
  ]);
  const [creating, setCreating] = useState<(ProviderEditing & { name: string }) | null>(null);
  const sessions = useRef(0);

  /** 被多个插件用到的名字 */
  const shared = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of plugins) {
      for (const name of pluginProviderNames(entry)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
  }, [plugins]);

  const removeManual = async (name: string) => {
    const result = await setManualProviders(
      plugin.id,
      manual.filter((item) => item !== name)
    );
    if (!result.ok) onError(result.error);
  };

  const openCreate = (name: string) => {
    const draft = newServiceDraft(name);
    if (!draft) return;
    sessions.current += 1;
    setCreating({ key: sessions.current, draft, name });
  };

  /** 新服务 id 与服务名不同（如自动生成 sub2api-2）时关联过去；相同时清掉可能残留的失效映射 */
  const linkCreated = async (name: string, providerId: string) => {
    const result = await setProviderMapping(name, providerId === name ? null : providerId);
    if (!result.ok) onError(result.error);
  };

  const addForm = adding && (
    <ManualNameForm
      pluginId={plugin.id}
      names={names}
      manual={manual}
      onDone={() => onAddingChange(false)}
    />
  );

  if (names.length === 0) return addForm || null;

  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between gap-2 text-muted-foreground text-xs">
        <span className="truncate">
          {t('settings.plugins.requestedTitle')} · {t('settings.plugins.requestedApplyHint')}
        </span>
        {!adding && (
          <button
            type="button"
            className="shrink-0 text-primary hover:underline"
            title={t('settings.plugins.manualAdd')}
            onClick={() => onAddingChange(true)}
          >
            {t('settings.plugins.manualAddShort')}
          </button>
        )}
      </div>
      <ul className="flex flex-col gap-1.5">
        {names.map((name) => {
          const mapped = Object.hasOwn(providerMap, name) ? providerMap[name] : undefined;
          const auto = providers.find((provider) => provider.id === name);
          const target = mapped ? providers.find((provider) => provider.id === mapped) : auto;
          const items = [
            {
              value: AUTO_VALUE,
              label: auto
                ? t('settings.plugins.requestedAuto', { name: auto.name })
                : t('settings.plugins.requestedAutoMissing'),
            },
            ...providers.map((provider) => ({
              value: provider.id,
              label: `${provider.name} · ${providerHost(provider)}`,
            })),
          ];
          if (mapped && !target) {
            items.push({ value: mapped, label: t('settings.plugins.requestedMissing') });
          }
          const state = !target ? 'missing' : isUsable(target) ? 'usable' : 'unavailable';
          const removable = manual.includes(name) && !detected.has(name);
          return (
            <li key={name}>
              <div className="flex items-center gap-2">
                <span
                  className="w-28 shrink-0 truncate font-mono text-muted-foreground text-xs"
                  title={t('settings.plugins.requestedNameHint')}
                >
                  {name}
                </span>
                <Select
                  items={items}
                  value={mapped ?? AUTO_VALUE}
                  onValueChange={async (next) => {
                    if (typeof next !== 'string') return;
                    const result = await setProviderMapping(
                      name,
                      next === AUTO_VALUE ? null : next
                    );
                    if (!result.ok) onError(result.error);
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="min-w-0 flex-1"
                    aria-label={t('settings.plugins.requestedSelect', { name })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {items.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span
                  className={
                    state === 'usable'
                      ? 'flex shrink-0 items-center gap-1 text-emerald-600 text-xs'
                      : 'flex shrink-0 items-center gap-1 text-amber-600 text-xs'
                  }
                >
                  {state === 'usable' ? (
                    <CircleCheck className="size-3.5" />
                  ) : (
                    <CircleAlert className="size-3.5" />
                  )}
                  {t(
                    state === 'usable'
                      ? 'settings.plugins.requestedUsable'
                      : state === 'missing'
                        ? 'settings.plugins.requestedMissing'
                        : 'settings.plugins.requestedUnavailable'
                  )}
                </span>
                {state === 'missing' && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 shrink-0 px-2 text-xs"
                    onClick={() => openCreate(name)}
                  >
                    {t('settings.plugins.createService')}
                  </Button>
                )}
                {removable && (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="size-6 shrink-0"
                    aria-label={t('settings.plugins.manualRemove', { name })}
                    title={t('settings.plugins.manualRemove', { name })}
                    onClick={() => void removeManual(name)}
                  >
                    <X />
                  </Button>
                )}
              </div>
              {shared.has(name) && (
                <p className="mt-0.5 text-muted-foreground text-xs">
                  {t('settings.plugins.requestedShared')}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {addForm}
      <ProviderDialog
        editing={creating}
        onClose={() => setCreating(null)}
        onSaved={(providerId) => {
          if (creating) void linkCreated(creating.name, providerId);
        }}
      />
    </div>
  );
}

/** 卡片里原地出现的「添加模型服务名」小输入框；每次打开重新挂载，状态自动清空 */
function ManualNameForm({
  pluginId,
  names,
  manual,
  onDone,
}: {
  pluginId: string;
  /** 卡片上已显示的全部名字（查重用） */
  names: readonly string[];
  manual: readonly string[];
  onDone: () => void;
}) {
  const setManualProviders = usePluginsStore((state) => state.setManualProviders);
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // 从「…」菜单打开时，菜单关闭比输入框挂载晚：等下一帧再聚焦一次
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const [inputError, setInputError] = useState<string | null>(null);
  const t = useT();

  const submit = async () => {
    const name = input.trim();
    if (!isPluginProviderName(name)) {
      setInputError(t('settings.plugins.manualInvalid'));
      return;
    }
    if (names.includes(name)) {
      setInputError(t('settings.plugins.manualExists'));
      return;
    }
    if (manual.length >= MAX_REQUESTED_PROVIDERS) {
      setInputError(t('settings.plugins.manualFull', { max: MAX_REQUESTED_PROVIDERS }));
      return;
    }
    const result = await setManualProviders(pluginId, [...manual, name]);
    if (!result.ok) {
      setInputError(result.error);
      return;
    }
    onDone();
  };

  return (
    <div className="mt-1.5">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Input
          ref={inputRef}
          autoFocus
          value={input}
          maxLength={64}
          placeholder={t('settings.plugins.manualPlaceholder')}
          aria-label={t('settings.plugins.manualAdd')}
          aria-invalid={inputError !== null}
          className="h-7 max-w-56 font-mono text-xs"
          onChange={(event) => {
            setInput(event.target.value);
            setInputError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              onDone();
            }
          }}
        />
        <Button type="submit" size="sm" className="h-7 px-2 text-xs">
          {t('common.confirm')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={onDone}
        >
          {t('common.cancel')}
        </Button>
      </form>
      {inputError && <p className="mt-0.5 text-destructive text-xs">{inputError}</p>}
    </div>
  );
}
