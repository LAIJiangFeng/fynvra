import type { WorkspaceFileEntry } from '@shared/types/files';
import { FileCode2, Loader2, RefreshCw, Save } from 'lucide-react';
import { lazy, Suspense, useDeferredValue, useEffect, useEffectEvent } from 'react';
import { Markdown } from '@/components/chat/Markdown';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { type FileMode, type FilesStore, isFileDirty, isMarkdown } from '@/stores/files';

const FileEditor = lazy(() => import('./FileEditor'));
const MODES: FileMode[] = ['edit', 'preview', 'split'];

export function FilePane({
  file,
  store,
  active,
  onReload,
}: {
  file: WorkspaceFileEntry;
  store: FilesStore;
  active: boolean;
  onReload(): void;
}) {
  const current = store((state) => state.previews[file.id]);
  const t = useT();
  const draft = useDeferredValue(current?.draft ?? '');
  const preview = current?.preview;
  const markdown = isMarkdown(file.name);
  const dirty = isFileDirty(current);
  const save = useEffectEvent(() => {
    void store.getState().saveFile(file.id);
  });
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
        // 弹窗内的保存由确认按钮处理，不抢占其他编辑界面的快捷键。
        if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
        event.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active]);

  return (
    <section
      aria-label={t('files.preview')}
      className="@container flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs">
        <span
          className="min-w-12 flex-1 truncate font-mono text-muted-foreground @max-[30rem]:basis-full"
          title={file.relativePath}
        >
          {file.relativePath}
        </span>
        {preview?.kind === 'text' && markdown && (
          <fieldset className="flex rounded-md bg-muted p-0.5" aria-label={t('files.viewMode')}>
            {MODES.map((mode) => (
              <Button
                key={mode}
                size="sm"
                variant="ghost"
                className={cn(
                  'h-6 px-2 text-xs',
                  current?.mode === mode && 'bg-background shadow-sm'
                )}
                aria-pressed={current?.mode === mode}
                onClick={() => store.getState().setMode(file.id, mode)}
              >
                {t(`files.modes.${mode}`)}
              </Button>
            ))}
          </fieldset>
        )}
        {preview?.kind === 'text' ? (
          <>
            <span role="status" className="text-muted-foreground">
              {t(current?.saving ? 'files.saving' : dirty ? 'files.unsaved' : 'files.saved')}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={!dirty || current?.saving}
              onClick={() => void store.getState().saveFile(file.id)}
              title={t('files.saveHint')}
            >
              {current?.saving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              {t('files.save')}
            </Button>
          </>
        ) : (
          preview && <span className="text-muted-foreground">{t('files.readonly')}</span>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('files.reload')}
          title={t('files.reload')}
          disabled={current?.saving || current?.loading}
          onClick={onReload}
        >
          <RefreshCw className={cn('size-3.5', current?.loading && 'animate-spin')} />
        </Button>
      </div>
      {current?.saveError && (
        <div role="alert" className="border-b bg-destructive/10 px-4 py-2 text-destructive text-xs">
          {t(`files.errors.${current.saveError}`)}
        </div>
      )}
      {current?.error ? (
        <div
          role="alert"
          className="m-auto space-y-3 p-6 text-center text-muted-foreground text-sm"
        >
          <p>{t(`files.errors.${current.error}`)}</p>
          <Button variant="outline" size="sm" onClick={onReload}>
            {t('common.retry')}
          </Button>
        </div>
      ) : !preview ? (
        <FileMessage loading title={t('common.loading')} />
      ) : preview.kind === 'unsupported' ? (
        <FileMessage title={t(`files.${preview.reason}`)} description={t('files.limits')} />
      ) : preview.kind === 'image' ? (
        <div className="min-h-0 flex-1 overflow-auto p-6">
          <img
            src={preview.dataUrl}
            alt={file.name}
            className="mx-auto max-w-full rounded border bg-muted/30"
          />
        </div>
      ) : (
        <div
          className={cn(
            'grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] overflow-hidden',
            markdown &&
              current.mode === 'split' &&
              'grid-rows-[minmax(0,1fr)_minmax(0,1fr)] @min-[42rem]:grid-cols-2 @min-[42rem]:grid-rows-[minmax(0,1fr)]'
          )}
        >
          <div
            className={cn(
              'min-h-0 min-w-0 overflow-hidden',
              markdown && current.mode === 'preview' && 'hidden'
            )}
          >
            <Suspense fallback={<FileMessage loading title={t('common.loading')} />}>
              <FileEditor
                name={file.name}
                value={current.draft}
                source={preview.text}
                onChange={(text) => store.getState().editFile(file.id, text)}
              />
            </Suspense>
          </div>
          {markdown && (
            <article
              aria-label={t('files.markdownPreview')}
              className={cn(
                'min-h-0 min-w-0 overflow-auto bg-background px-6 py-4',
                current.mode === 'edit' && 'hidden',
                current.mode === 'split' && 'border-t @min-[42rem]:border-t-0 @min-[42rem]:border-l'
              )}
            >
              <Markdown text={draft} className="mx-auto max-w-3xl [&_img]:max-w-full" />
            </article>
          )}
        </div>
      )}
    </section>
  );
}

function FileMessage({
  title,
  description,
  loading = false,
}: {
  title: string;
  description?: string;
  loading?: boolean;
}) {
  const Icon = loading ? Loader2 : FileCode2;
  return (
    <div
      role="status"
      className="m-auto flex max-w-sm flex-col items-center gap-2 p-6 text-center text-muted-foreground"
    >
      <Icon className={cn('size-7 opacity-50', loading && 'animate-spin')} />
      <p className="text-sm">{title}</p>
      {description && <p className="text-xs leading-relaxed">{description}</p>}
    </div>
  );
}
