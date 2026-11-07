import type { PluginEntry } from '@shared/types/plugins';
import { FolderPlus, Loader2, PackagePlus, Puzzle, ShieldAlert, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n/I18nProvider';
import { usePluginsStore } from '@/stores/plugins';
import { EmptyState, InlineMessage, SectionHeader } from './common';

type Status = { tone: 'error' | 'success'; text: string };
/** 待确认的添加：本地（确认后 Main 弹框）或远程来源 */
type Pending = { kind: 'local' } | { kind: 'remote'; source: string };

/** 设置 → 插件：添加本地插件、从 npm / git 安装，启用 / 停用 / 移除。添加前都要确认风险提示。 */
export function PluginsSettings() {
  const plugins = usePluginsStore((state) => state.plugins);
  const loaded = usePluginsStore((state) => state.loaded);
  const error = usePluginsStore((state) => state.error);
  const addLocal = usePluginsStore((state) => state.addLocal);
  const install = usePluginsStore((state) => state.install);
  const [source, setSource] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [working, setWorking] = useState<'local' | 'remote' | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const t = useT();

  const proceed = async () => {
    const target = pending;
    setPending(null);
    if (!target || working) return;
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
        <Button
          size="sm"
          variant="outline"
          disabled={working !== null}
          onClick={() => setPending({ kind: 'local' })}
        >
          {working === 'local' ? <Loader2 className="animate-spin" /> : <FolderPlus />}
          {t('settings.plugins.addLocal')}
        </Button>
      </SectionHeader>

      <p className="mb-3 text-muted-foreground text-sm">{t('settings.plugins.subtitle')}</p>
      <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <span>{t('settings.plugins.warning')}</span>
      </div>

      <form
        className="mb-1 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed && working === null) setPending({ kind: 'remote', source: trimmed });
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
        <EmptyState icon={Puzzle} title={t('settings.plugins.empty')} />
      ) : (
        <ul className="divide-y rounded-lg border">
          {plugins.map((plugin) => (
            <PluginRow
              key={plugin.id}
              plugin={plugin}
              onError={(text) => setStatus({ tone: 'error', text })}
            />
          ))}
        </ul>
      )}

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.plugins.confirmTitle')}</DialogTitle>
            <DialogDescription>{t('settings.plugins.warning')}</DialogDescription>
          </DialogHeader>
          {pending && (
            <p className="break-all text-sm">
              {pending.kind === 'remote'
                ? t('settings.plugins.confirmInstall', { source: pending.source })
                : t('settings.plugins.confirmLocal')}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPending(null)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" onClick={() => void proceed()}>
              {t('settings.plugins.continue')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function PluginRow({
  plugin,
  onError,
}: {
  plugin: PluginEntry;
  onError: (message: string) => void;
}) {
  const toggle = usePluginsStore((state) => state.toggle);
  const remove = usePluginsStore((state) => state.remove);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const t = useT();

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sm">{plugin.name}</span>
          <Badge variant="outline">{t(`settings.plugins.kinds.${plugin.kind}`)}</Badge>
          {!plugin.enabled && <Badge>{t('common.disabled')}</Badge>}
        </div>
        <p className="truncate font-mono text-muted-foreground text-xs" title={plugin.source}>
          {plugin.source}
        </p>
        {confirmingRemove && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-xs">
              {t('settings.plugins.removeConsequence')}
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
