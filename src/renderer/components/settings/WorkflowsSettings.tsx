import { summarizeWorkflow, type Workflow } from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import { LayoutTemplate, Pencil, Plus, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useT } from '@/i18n/I18nProvider';
import { EmptyState, InlineMessage, SectionHeader } from './common';
import {
  templateWorkflow,
  WORKFLOW_TEMPLATES,
  WorkflowEditor,
  type WorkflowTemplate,
} from './WorkflowEditor';

type Status = { tone: 'error' | 'success'; text: string };

/** 编辑目标：已有工作流按 id；新建的草稿还没落盘。key 变化时编辑器重置。 */
type Editing =
  | { kind: 'existing'; id: string }
  | { kind: 'draft'; key: number; workflow: Workflow };

const api = window.fynvra.workflows;

/** 设置 → 工作流：列表与编辑器。数据只存在 Main 的 workflows.json，这里不缓存到全局 store。 */
export function WorkflowsSettings() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [removing, setRemoving] = useState<Workflow | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const drafts = useRef(0);
  const t = useT();

  const refresh = useCallback(async () => {
    try {
      const result = await api.list();
      if (result.ok) {
        setWorkflows(result.workflows);
        setLoadError(null);
      } else {
        setLoadError(result.error);
      }
    } catch (error) {
      setLoadError(errorMessage(error));
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const takenIds = workflows.map((workflow) => workflow.id);

  const openDraft = (template: WorkflowTemplate) => {
    drafts.current += 1;
    setStatus(null);
    setChoosing(false);
    setEditing({
      kind: 'draft',
      key: drafts.current,
      workflow: templateWorkflow(template, t, takenIds),
    });
  };

  const confirmRemove = async () => {
    if (!removing) return;
    setBusy(true);
    let error: string | null = null;
    try {
      const result = await api.remove(removing.id);
      if (!result.ok) error = result.error;
    } catch (caught) {
      error = errorMessage(caught);
    }
    setBusy(false);
    if (error) {
      setRemoveError(error);
      return;
    }
    setStatus({ tone: 'success', text: t('settings.workflows.removed', { name: removing.name }) });
    setRemoving(null);
    await refresh();
  };

  if (editing) {
    const initial =
      editing.kind === 'draft'
        ? editing.workflow
        : workflows.find((workflow) => workflow.id === editing.id);
    if (initial) {
      return (
        <WorkflowEditor
          key={editing.kind === 'draft' ? `draft-${editing.key}` : `workflow-${editing.id}`}
          initial={initial}
          isNew={editing.kind === 'draft'}
          takenIds={takenIds}
          onCancel={() => setEditing(null)}
          onSaved={async (workflow) => {
            setStatus({
              tone: 'success',
              text: t('settings.workflows.saved', { name: workflow.name }),
            });
            setEditing(null);
            await refresh();
          }}
        />
      );
    }
  }

  return (
    <section>
      <SectionHeader title={t('settings.workflows.title')}>
        <Button
          size="sm"
          variant="outline"
          disabled={!!loadError}
          onClick={() => setChoosing(true)}
        >
          <LayoutTemplate />
          {t('settings.workflows.newFromPreset')}
        </Button>
        <Button size="sm" disabled={!!loadError} onClick={() => openDraft('blank')}>
          <Plus />
          {t('settings.workflows.new')}
        </Button>
      </SectionHeader>

      {status && (
        <InlineMessage tone={status.tone} className="mb-3 break-all">
          {status.text}
        </InlineMessage>
      )}
      {loadError && (
        <InlineMessage tone="error" className="mb-3 break-all">
          {t('settings.workflows.loadFailed', { error: loadError })}
        </InlineMessage>
      )}

      {loaded && !loadError && workflows.length === 0 ? (
        <EmptyState
          icon={WorkflowIcon}
          title={t('settings.workflows.empty')}
          description={t('settings.workflows.emptyHint')}
        >
          <Button size="sm" variant="outline" onClick={() => setChoosing(true)}>
            <LayoutTemplate />
            {t('settings.workflows.newFromPreset')}
          </Button>
        </EmptyState>
      ) : (
        workflows.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {workflows.map((workflow) => (
              <li key={workflow.id} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-sm">{workflow.name}</span>
                  {workflow.description && (
                    <p className="line-clamp-2 text-muted-foreground text-xs">
                      {workflow.description}
                    </p>
                  )}
                  <p
                    className="truncate text-muted-foreground text-xs"
                    title={summarizeWorkflow(workflow.steps)}
                  >
                    <span className="tabular-nums">
                      {t('settings.workflows.nodeCount', { count: workflow.steps.length })}
                    </span>
                    {' · '}
                    {summarizeWorkflow(workflow.steps)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('common.editItem', { name: workflow.name })}
                  title={t('common.edit')}
                  onClick={() => {
                    setStatus(null);
                    setEditing({ kind: 'existing', id: workflow.id });
                  }}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('common.deleteItem', { name: workflow.name })}
                  title={t('common.delete')}
                  onClick={() => {
                    setRemoveError(null);
                    setRemoving(workflow);
                  }}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )
      )}

      <Dialog open={choosing} onOpenChange={setChoosing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.workflows.templates.title')}</DialogTitle>
            <DialogDescription>{t('settings.workflows.templates.hint')}</DialogDescription>
          </DialogHeader>
          <ul className="grid gap-2">
            {WORKFLOW_TEMPLATES.map((template) => (
              <li key={template}>
                <button
                  type="button"
                  className="grid w-full gap-0.5 rounded-lg border px-3 py-2 text-left hover:bg-accent"
                  onClick={() => openDraft(template)}
                >
                  <span className="font-medium text-sm">
                    {t(`settings.workflows.templates.${template}`)}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {t(`settings.workflows.templates.${template}Hint`)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>

      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('settings.workflows.deleteTitle', { name: removing?.name ?? '' })}
            </DialogTitle>
            <DialogDescription>{t('settings.workflows.deleteHint')}</DialogDescription>
          </DialogHeader>
          {removeError && (
            <InlineMessage tone="error" className="break-all">
              {removeError}
            </InlineMessage>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setRemoving(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void confirmRemove()}
            >
              {t('common.confirmDelete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
