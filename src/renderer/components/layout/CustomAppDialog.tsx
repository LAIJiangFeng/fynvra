import { errorMessage } from '@shared/guards';
import { MAX_OPEN_WITH_APPS, type OpenWithApp } from '@shared/types/settings';
import { AppWindow, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
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
import { useT } from '@/i18n/I18nProvider';
import { useWorkspacesStore } from '@/stores/workspaces';

/** One small editor also serves as the custom-app removal list. Paths change through the native picker. */
export function CustomAppDialog({
  initialApp,
  onClose,
}: {
  initialApp: OpenWithApp | null;
  onClose(): void;
}) {
  const t = useT();
  const id = useId();
  const [draft, setDraft] = useState(initialApp);
  const [apps, setApps] = useState<OpenWithApp[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void window.fynvra.settings
      .get()
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          setApps(result.preferences.openWithApps ?? []);
          setLoaded(true);
        } else setError(result.error);
      })
      .catch((error: unknown) => {
        if (active) setError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, []);

  async function pick() {
    setBusy(true);
    setError(null);
    try {
      const result = await window.fynvra.workspaces.pickApp();
      if (result.ok) setDraft(result.app);
      else if (result.code !== 'canceled') setError(result.error);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function update(removeId?: string) {
    if (busy || !loaded) return;
    setBusy(true);
    setError(null);
    try {
      // Read just before a write so an older dialog does not overwrite unrelated app changes.
      const current = await window.fynvra.settings.get();
      if (!current.ok) {
        setError(current.error);
        return;
      }
      const saved = current.preferences.openWithApps ?? [];
      const next = removeId
        ? saved.filter((app) => app.id !== removeId)
        : draft
          ? [...saved.filter((app) => app.id !== draft.id), { ...draft, name: draft.name.trim() }]
          : saved;
      const result = await window.fynvra.settings.update({ openWithApps: next });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setApps(result.preferences.openWithApps ?? []);
      void useWorkspacesStore.getState().loadOpenWithApps();
      if (!removeId) onClose();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(draft ? 'workspaces.customApp' : 'workspaces.manageApps')}</DialogTitle>
          <DialogDescription>{t('workspaces.customAppHint')}</DialogDescription>
        </DialogHeader>
        {draft ? (
          <form
            id={`${id}-form`}
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void update();
            }}
          >
            <label className="grid gap-2 text-sm" htmlFor={`${id}-name`}>
              {t('workspaces.appName')}
              <Input
                id={`${id}-name`}
                value={draft.name}
                maxLength={100}
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <div className="grid gap-2">
              <label className="text-sm" htmlFor={`${id}-path`}>
                {t('workspaces.appPath')}
              </label>
              <div className="flex gap-2">
                <Input
                  id={`${id}-path`}
                  value={draft.path}
                  readOnly
                  title={draft.path}
                  className="min-w-0 flex-1"
                />
                <Button type="button" variant="outline" disabled={busy} onClick={() => void pick()}>
                  {t('workspaces.chooseApp')}
                </Button>
              </div>
            </div>
          </form>
        ) : (
          <div className="grid max-h-64 gap-2 overflow-y-auto">
            {!loaded && !error && (
              <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
            )}
            {loaded && apps.length === 0 && (
              <p className="text-muted-foreground text-sm">{t('workspaces.noCustomApps')}</p>
            )}
            {apps.map((app) => (
              <div key={app.id} className="flex items-center gap-2">
                <AppWindow className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm" title={app.path}>
                  {app.name}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={busy}
                  aria-label={t('workspaces.removeApp', { name: app.name })}
                  onClick={() => void update(app.id)}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {draft ? (
            <Button
              type="submit"
              form={`${id}-form`}
              disabled={busy || !loaded || !draft.name.trim() || apps.length >= MAX_OPEN_WITH_APPS}
            >
              {t(busy ? 'common.saving' : 'common.save')}
            </Button>
          ) : (
            <Button
              disabled={busy || !loaded || apps.length >= MAX_OPEN_WITH_APPS}
              onClick={() => void pick()}
            >
              {t('workspaces.customApp')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
