import { MODEL_CATALOG, providerApiLabel, resolveBaseUrl } from '@shared/modelCatalog';
import type { ModelProviderView } from '@shared/types/llm';
import { Boxes, ChevronDown, HardDriveDownload, Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { useRef, useState } from 'react';
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
import { useProvidersStore } from '@/stores/providers';
import { EmptyState, InlineMessage, SectionHeader } from './common';
import { ProviderDialog, type ProviderEditing } from './ProviderDialog';
import { type ImportStatus, ProviderImportDialog } from './ProviderImportDialog';
import {
  catalogName,
  draftFromCatalog,
  draftFromProvider,
  type ProviderDraft,
} from './providerForm';
import { maskSecrets } from './secretMask';

const MAX_MODEL_BADGES = 4;

export function ProvidersSettings() {
  const providers = useProvidersStore((state) => state.providers);
  const loaded = useProvidersStore((state) => state.loaded);
  const error = useProvidersStore((state) => state.error);
  const [editing, setEditing] = useState<ProviderEditing | null>(null);
  const [importSession, setImportSession] = useState<number | null>(null);
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const sessions = useRef(0);
  const t = useT();

  const edit = (draft: ProviderDraft) => {
    sessions.current += 1;
    setEditing({ key: sessions.current, draft });
  };

  const openImport = () => {
    sessions.current += 1;
    setImportStatus(null);
    setImportSession(sessions.current);
  };

  return (
    <section>
      <SectionHeader title={t('settings.providers.title')}>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="sm" />}>
            <Plus />
            {t('settings.providers.add')}
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {MODEL_CATALOG.map((entry) => (
              <DropdownMenuItem key={entry.id} onClick={() => edit(draftFromCatalog(entry))}>
                {catalogName(entry, t)}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={openImport}>
              <HardDriveDownload />
              {t('settings.import.fromLocal')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SectionHeader>

      {importStatus && (
        <InlineMessage tone={importStatus.tone} className="mb-3 break-all">
          {importStatus.text}
        </InlineMessage>
      )}
      {error && <InlineMessage tone="error">{error}</InlineMessage>}

      {loaded && providers.length === 0 ? (
        <EmptyState icon={Boxes} title={t('settings.providers.empty')}>
          <Button size="sm" onClick={openImport}>
            <HardDriveDownload />
            {t('settings.import.fromLocalShort')}
          </Button>
          {MODEL_CATALOG.map((entry) => (
            <Button
              key={entry.id}
              size="sm"
              variant="outline"
              onClick={() => edit(draftFromCatalog(entry))}
            >
              {catalogName(entry, t)}
            </Button>
          ))}
        </EmptyState>
      ) : (
        <ul className="grid gap-3">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              onEdit={() => edit(draftFromProvider(provider))}
            />
          ))}
        </ul>
      )}

      <ProviderDialog editing={editing} onClose={() => setEditing(null)} />
      <ProviderImportDialog
        session={importSession}
        onClose={() => setImportSession(null)}
        onImported={setImportStatus}
      />
    </section>
  );
}

type Status = { tone: 'error' | 'success' | 'muted'; text: string };

function ProviderCard({ provider, onEdit }: { provider: ModelProviderView; onEdit: () => void }) {
  const upsert = useProvidersStore((state) => state.upsert);
  const remove = useProvidersStore((state) => state.remove);
  const test = useProvidersStore((state) => state.test);
  const [status, setStatus] = useState<Status | null>(null);
  const [testing, setTesting] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const t = useT();

  const setEnabled = async (enabled: boolean) => {
    // 不带 apiKey：Main 保留已保存的 key
    const result = await upsert({
      id: provider.id,
      name: provider.name,
      api: provider.api,
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      enabled,
      models: provider.models,
    });
    if (!result.ok) setStatus({ tone: 'error', text: result.error });
  };

  const runTest = async () => {
    setTesting(true);
    setStatus({ tone: 'muted', text: t('settings.providers.connecting') });
    const result = await test(provider.id);
    setTesting(false);
    if (!result.ok) {
      setStatus({ tone: 'error', text: result.error });
      return;
    }
    setStatus({
      tone: 'success',
      text:
        result.modelCount === undefined
          ? t('settings.providers.connected', { ms: result.latencyMs })
          : t('settings.providers.connectedModels', {
              ms: result.latencyMs,
              count: result.modelCount,
            }),
    });
  };

  const confirmRemove = async () => {
    const result = await remove(provider.id);
    if (!result.ok) {
      setConfirmingRemove(false);
      setStatus({ tone: 'error', text: result.error });
    }
  };

  const extraModels = provider.models.length - MAX_MODEL_BADGES;

  return (
    <li className="rounded-lg border bg-card p-4 text-card-foreground">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{provider.name}</span>
            <Badge variant="outline">{providerApiLabel(provider.api)}</Badge>
            {!provider.enabled && <Badge>{t('common.disabled')}</Badge>}
          </div>
          <p className="mt-1 truncate text-muted-foreground text-xs">
            {maskSecrets(resolveBaseUrl(provider.api, provider.baseUrl))}
            {' · '}
            {provider.hasApiKey ? (
              <span className="font-mono">••••{provider.apiKeyHint ?? ''}</span>
            ) : (
              <span className="text-destructive">{t('settings.providers.noApiKey')}</span>
            )}
          </p>
        </div>
        <Switch
          checked={provider.enabled}
          aria-label={t('common.enableItem', { name: provider.name })}
          onCheckedChange={(enabled) => void setEnabled(enabled)}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {provider.models.length === 0 ? (
          <span className="text-muted-foreground text-xs">{t('settings.providers.noModels')}</span>
        ) : (
          provider.models.slice(0, MAX_MODEL_BADGES).map((model) => (
            <Badge key={model.id} variant="outline" title={model.id}>
              {model.name}
            </Badge>
          ))
        )}
        {extraModels > 0 && <Badge variant="outline">+{extraModels}</Badge>}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={testing || !provider.hasApiKey}
          onClick={() => void runTest()}
        >
          <Zap />
          {t('settings.providers.test')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          <Pencil />
          {t('common.edit')}
        </Button>
        {confirmingRemove ? (
          <>
            <span className="text-muted-foreground text-xs">
              {t('settings.providers.removeConsequence')}
            </span>
            <Button size="sm" variant="destructive" onClick={() => void confirmRemove()}>
              {t('common.confirmDelete')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmingRemove(false)}>
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmingRemove(true)}
          >
            <Trash2 />
            {t('common.delete')}
          </Button>
        )}
      </div>

      {status && (
        <InlineMessage tone={status.tone} className="mt-2 break-all">
          {status.text}
        </InlineMessage>
      )}
    </li>
  );
}
