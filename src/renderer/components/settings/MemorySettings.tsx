import { errorMessage } from '@shared/guards';
import type { IpcResult } from '@shared/types/ipc';
import {
  isMemoryCategory,
  MEMORY_CATEGORIES,
  MEMORY_CONTENT_MAX,
  MEMORY_EXPIRE_DAYS_MAX,
  MEMORY_EXPIRE_DAYS_MIN,
  type MemoryCategory,
  type MemoryListView,
  type MemoryView,
} from '@shared/types/memory';
import type { MemoryPreferences } from '@shared/types/settings';
import { Brain, Pencil, Plus, Power, PowerOff, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { formatRelativeTime } from '@/components/chat/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { T } from '@/i18n';
import { useT } from '@/i18n/I18nProvider';
import { confirmDialog } from '@/lib/appDialog';
import { useProvidersStore } from '@/stores/providers';
import { useGeneralPreferencesStore } from '@/stores/settings';
import { useWorkspacesStore } from '@/stores/workspaces';
import {
  EmptyState,
  Field,
  InlineMessage,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from './common';
import { groupMemories } from './memoryView';

const memoryApi = window.fynvra.memory;

/** IPC 调用本身抛错也折成 { ok: false } */
async function safely<R extends object>(call: () => Promise<IpcResult<R>>): Promise<IpcResult<R>> {
  try {
    return await call();
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** 记忆：开关类设置 + 按工作区管理记忆列表（docs/ARCHITECTURE.md §7.15） */
export function MemorySettings() {
  return (
    <div className="grid gap-8">
      <PreferencesSection />
      <ListSection />
    </div>
  );
}

// --- 设置 ---
function PreferencesSection() {
  const memory = useGeneralPreferencesStore((state) => state.memory);
  const update = useGeneralPreferencesStore((state) => state.update);
  const error = useGeneralPreferencesStore((state) => state.error);
  const t = useT();
  const id = useId();
  // 整块写回：Main 对 memory 整块严格校验
  const save = (patch: Partial<MemoryPreferences>) => {
    const next = { ...memory, ...patch };
    if (!next.model) delete next.model;
    return update({ memory: next });
  };
  return (
    <SettingsSection title={t('settings.memory.settingsTitle')}>
      <SettingsCard>
        <SettingsRow
          label={t('settings.memory.enabled')}
          description={t('settings.memory.enabledHint')}
          htmlFor={`${id}-enabled`}
          control={
            <Switch
              id={`${id}-enabled`}
              checked={memory.enabled}
              onCheckedChange={(checked) => void save({ enabled: checked })}
            />
          }
        />
        <SettingsRow
          label={t('settings.memory.autoExtract')}
          description={t('settings.memory.autoExtractHint')}
          htmlFor={`${id}-extract`}
          control={
            <Switch
              id={`${id}-extract`}
              checked={memory.autoExtract}
              disabled={!memory.enabled}
              onCheckedChange={(checked) => void save({ autoExtract: checked })}
            />
          }
        />
        <SettingsRow
          label={t('settings.memory.model')}
          description={t('settings.memory.modelHint')}
          htmlFor={`${id}-model`}
          control={
            <ExtractModelSelect
              id={`${id}-model`}
              value={memory.model}
              onChange={(model) => void save({ model })}
            />
          }
        />
        <ExpireDaysRow value={memory.expireDays} onSave={(expireDays) => save({ expireDays })} />
      </SettingsCard>
      {error && (
        <InlineMessage tone="error" className="mt-2">
          {error}
        </InlineMessage>
      )}
    </SettingsSection>
  );
}

/**
 * 提炼用的模型：第一项「跟随会话」（model 为 undefined），其余按服务分组列出模型。
 * ModelSelect 没有「跟随会话」这一项，所以照角色编辑器的模型下拉接法。
 */
function ExtractModelSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: MemoryPreferences['model'];
  onChange: (model: MemoryPreferences['model']) => void;
}) {
  const providers = useProvidersStore((state) => state.providers);
  const refresh = useProvidersStore((state) => state.refresh);
  const t = useT();
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const current = value ? `${value.providerId}:${value.modelId}` : '';
  const choices = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      value: `${provider.id}:${model.id}`,
      label: `${provider.name} / ${model.name}`,
    }))
  );
  // 选中的模型已被删除：保留为「不可用」选项，避免下拉显示成空白
  const missing =
    value && !choices.some((choice) => choice.value === current)
      ? {
          value: current,
          label: t('settings.roles.unavailableModel', {
            model: `${value.providerId} / ${value.modelId}`,
          }),
        }
      : null;
  const follow = t('settings.memory.followSession');
  const items = [{ value: '', label: follow }, ...(missing ? [missing] : []), ...choices];
  return (
    <Select
      items={items}
      value={current}
      onValueChange={(next) => {
        if (typeof next !== 'string' || next === '') return onChange(undefined);
        const separator = next.indexOf(':');
        onChange({ providerId: next.slice(0, separator), modelId: next.slice(separator + 1) });
      }}
    >
      <SelectTrigger id={id} size="sm" className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="">{follow}</SelectItem>
        {missing && <SelectItem value={missing.value}>{missing.label}</SelectItem>}
        {providers.map((provider) => (
          <SelectGroup key={provider.id}>
            <SelectGroupLabel>
              {provider.enabled
                ? provider.name
                : t('settings.roles.providerDisabled', { name: provider.name })}
            </SelectGroupLabel>
            {provider.models.map((model) => (
              <SelectItem key={model.id} value={`${provider.id}:${model.id}`}>
                {model.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

function ExpireDaysRow({
  value: saved,
  onSave,
}: {
  value: number;
  onSave: (days: number) => Promise<void>;
}) {
  const [value, setValue] = useState(String(saved));
  const [saving, setSaving] = useState(false);
  const t = useT();
  const id = useId();
  useEffect(() => setValue(String(saved)), [saved]);
  const days = Number(value);
  const valid =
    value.trim() !== '' &&
    Number.isInteger(days) &&
    days >= MEMORY_EXPIRE_DAYS_MIN &&
    days <= MEMORY_EXPIRE_DAYS_MAX;
  return (
    <SettingsRow
      label={t('settings.memory.expireDays')}
      description={t('settings.memory.expireDaysHint')}
      htmlFor={id}
      control={
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid || saving) return;
            setSaving(true);
            void onSave(days).finally(() => setSaving(false));
          }}
        >
          <Input
            id={id}
            className="w-28"
            type="number"
            min={MEMORY_EXPIRE_DAYS_MIN}
            max={MEMORY_EXPIRE_DAYS_MAX}
            step="1"
            required
            aria-invalid={!valid}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={saving}
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={!valid || saving || days === saved}
          >
            {t('common.save')}
          </Button>
        </form>
      }
    />
  );
}

// --- 记忆列表 ---
type Editing = { kind: 'add' } | { kind: 'edit'; memory: MemoryView } | null;

function ListSection() {
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const selectedId = useWorkspacesStore((state) => state.selectedId);
  const enabled = useGeneralPreferencesStore((state) => state.memory.enabled);
  const t = useT();
  const id = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const [list, setList] = useState<MemoryListView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const request = useRef(0);
  // 默认选当前工作区；选过的工作区被移除时退回当前工作区
  const workspaceId =
    (picked && workspaces.some((workspace) => workspace.id === picked) ? picked : null) ??
    selectedId ??
    workspaces[0]?.id ??
    null;
  const nameOf = useCallback(
    (wid: string) => workspaces.find((workspace) => workspace.id === wid)?.name ?? wid,
    [workspaces]
  );

  const load = useCallback(async (wid: string) => {
    // 只认最新一次请求的回包：切换工作区后旧回包丢弃
    const current = ++request.current;
    const result = await safely(() => memoryApi.list(wid));
    if (current !== request.current) return;
    if (result.ok) {
      setList({ memories: result.memories, sharedWithWorkspaceIds: result.sharedWithWorkspaceIds });
      setError(null);
    } else setError(result.error);
  }, []);

  useEffect(() => {
    setList(null);
    setError(null);
    if (!workspaceId) {
      request.current += 1;
      return;
    }
    void load(workspaceId);
    return memoryApi.onChanged(({ workspaceIds }) => {
      if (workspaceIds.includes(workspaceId)) void load(workspaceId);
    });
  }, [workspaceId, load]);

  /** 写操作：失败显示错误；成功后列表靠 onChanged 刷新，这里也主动重读一次 */
  const run = async (call: () => Promise<IpcResult<object>>): Promise<boolean> => {
    const result = await safely(call);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    if (workspaceId) void load(workspaceId);
    return true;
  };

  const sharedNames = (list?.sharedWithWorkspaceIds ?? [])
    .map(nameOf)
    .join(t('settings.memory.namesSeparator'));

  const clear = async () => {
    if (!workspaceId) return;
    const ok = await confirmDialog({
      message: t('settings.memory.confirmClear', { name: nameOf(workspaceId) }),
      detail: sharedNames
        ? t('settings.memory.confirmClearShared', { names: sharedNames })
        : t('settings.memory.confirmClearDetail'),
      confirmLabel: t('settings.memory.clear'),
      destructive: true,
    });
    if (ok) await run(() => memoryApi.clear(workspaceId));
  };

  const remove = async (memory: MemoryView) => {
    if (!workspaceId) return;
    const ok = await confirmDialog({
      message: t('settings.memory.confirmDelete'),
      detail: memory.content,
      confirmLabel: t('common.confirmDelete'),
      destructive: true,
    });
    if (ok) await run(() => memoryApi.remove({ workspaceId, id: memory.id }));
  };

  const workspaceItems = workspaces.map((workspace) => ({
    value: workspace.id,
    label: workspace.name,
  }));
  const groups = groupMemories(list?.memories ?? []);

  return (
    <SettingsSection
      title={t('settings.memory.listTitle')}
      actions={
        <>
          <Select
            items={workspaceItems}
            value={workspaceId}
            onValueChange={(next) => {
              if (typeof next === 'string') setPicked(next);
            }}
          >
            <SelectTrigger
              id={`${id}-workspace`}
              aria-label={t('settings.memory.workspace')}
              size="sm"
              className="w-48"
            >
              <SelectValue placeholder={t('settings.memory.noWorkspace')} />
            </SelectTrigger>
            <SelectContent>
              {workspaceItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            disabled={!workspaceId}
            onClick={() => setEditing({ kind: 'add' })}
          >
            <Plus />
            {t('common.add')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!workspaceId || !list || list.memories.length === 0}
            onClick={() => void clear()}
          >
            <Trash2 />
            {t('settings.memory.clear')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {!enabled && <InlineMessage>{t('settings.memory.disabledNotice')}</InlineMessage>}
        {sharedNames && (
          <InlineMessage>{t('settings.memory.sharedWith', { names: sharedNames })}</InlineMessage>
        )}
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
        {!workspaceId ? (
          <EmptyState icon={Brain} title={t('settings.memory.noWorkspace')} />
        ) : list === null ? (
          !error && <InlineMessage>{t('common.loading')}</InlineMessage>
        ) : groups.length === 0 ? (
          <EmptyState
            icon={Brain}
            title={t('settings.memory.empty')}
            description={t('settings.memory.emptyHint')}
          />
        ) : (
          groups.map(({ category, items }) => (
            <section key={category} aria-label={t(`settings.memory.categories.${category}`)}>
              <h4 className="mb-1.5 font-medium text-muted-foreground text-xs">
                {t(`settings.memory.categories.${category}`)}
              </h4>
              <SettingsCard>
                {items.map((memory) => (
                  <MemoryRow
                    key={memory.id}
                    memory={memory}
                    onEdit={() => setEditing({ kind: 'edit', memory })}
                    onToggle={() =>
                      void run(() =>
                        memoryApi.update({
                          workspaceId: workspaceId,
                          id: memory.id,
                          status: memory.status === 'active' ? 'disabled' : 'active',
                        })
                      )
                    }
                    onRemove={() => void remove(memory)}
                  />
                ))}
              </SettingsCard>
            </section>
          ))
        )}
      </div>
      {editing && workspaceId && (
        <MemoryDialog
          memory={editing.kind === 'edit' ? editing.memory : null}
          onClose={() => setEditing(null)}
          onSubmit={async (draft) => {
            const result = await safely<object>(() =>
              editing.kind === 'edit'
                ? memoryApi.update({ workspaceId, id: editing.memory.id, ...draft })
                : memoryApi.create({
                    workspaceId,
                    category: draft.category,
                    content: draft.content,
                  })
            );
            if (result.ok) {
              setEditing(null);
              void load(workspaceId);
              return null;
            }
            return result.error;
          }}
        />
      )}
    </SettingsSection>
  );
}

function MemoryRow({
  memory,
  onEdit,
  onToggle,
  onRemove,
}: {
  memory: MemoryView;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const now = Date.now();
  const origin = [
    memory.sourceTitle && t('settings.memory.origin', { title: memory.sourceTitle }),
    memory.evidence && t('settings.memory.evidence', { text: memory.evidence }),
    memory.files.length > 0 &&
      t('settings.memory.files', { files: memory.files.join(t('settings.memory.namesSeparator')) }),
  ].filter((part): part is string => Boolean(part));
  const times = [
    t('settings.memory.createdAt', { time: formatRelativeTime(memory.createdAt, now, t) }),
    t('settings.memory.updatedAt', { time: formatRelativeTime(memory.updatedAt, now, t) }),
    memory.lastUsedAt !== undefined &&
      t('settings.memory.lastUsedAt', { time: formatRelativeTime(memory.lastUsedAt, now, t) }),
  ].filter((part): part is string => Boolean(part));
  const toggle = toggleAction(memory, t);
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span
            className={
              memory.status === 'active'
                ? 'break-words text-sm'
                : 'break-words text-muted-foreground text-sm'
            }
          >
            {memory.content}
          </span>
          <Badge variant="outline">{t(`settings.memory.sources.${memory.sourceKind}`)}</Badge>
          {memory.pinned && <Badge variant="outline">{t('settings.memory.pinned')}</Badge>}
          {memory.status === 'disabled' && (
            <Badge variant="secondary" title={memory.disabledReason}>
              {t('settings.memory.statusDisabled')}
            </Badge>
          )}
          {memory.status === 'expired' && (
            <Badge variant="secondary">{t('settings.memory.statusExpired')}</Badge>
          )}
          {memory.flaggedAt !== undefined && (
            <Badge variant="destructive" title={memory.flagNote}>
              {t('settings.memory.flagged')}
            </Badge>
          )}
        </div>
        {origin.length > 0 && (
          // 依据可能很长：一行截短，完整内容放悬停提示
          <p className="truncate text-muted-foreground text-xs" title={origin.join('\n')}>
            {origin.join(' · ')}
          </p>
        )}
        <p className="text-muted-foreground text-xs">{times.join(' · ')}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('common.edit')}
          title={t('common.edit')}
          onClick={onEdit}
        >
          <Pencil />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={toggle.label}
          title={toggle.label}
          onClick={onToggle}
        >
          <toggle.Icon />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('common.delete')}
          title={t('common.delete')}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

/** 生效的显示「停用」，停用的显示「启用」，过期的显示「恢复」（都改 status） */
function toggleAction(memory: MemoryView, t: T) {
  if (memory.status === 'active') return { label: t('settings.memory.disable'), Icon: PowerOff };
  if (memory.status === 'expired') return { label: t('settings.memory.restore'), Icon: RotateCcw };
  return { label: t('settings.memory.enable'), Icon: Power };
}

interface MemoryDraft {
  category: MemoryCategory;
  content: string;
  pinned?: boolean;
}

/** 新增（类别 + 内容）或编辑（另有「不过期」）；onSubmit 返回错误文案，null 表示成功 */
function MemoryDialog({
  memory,
  onClose,
  onSubmit,
}: {
  memory: MemoryView | null;
  onClose: () => void;
  onSubmit: (draft: MemoryDraft) => Promise<string | null>;
}) {
  const t = useT();
  const id = useId();
  const [category, setCategory] = useState<MemoryCategory>(memory?.category ?? 'rule');
  const [content, setContent] = useState(memory?.content ?? '');
  const [pinned, setPinned] = useState(memory?.pinned ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const length = content.trim().length;
  const valid = length > 0 && length <= MEMORY_CONTENT_MAX;
  const categoryItems = MEMORY_CATEGORIES.map((value) => ({
    value,
    label: t(`settings.memory.categories.${value}`),
  }));
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const failure = await onSubmit({ category, content, ...(memory ? { pinned } : {}) });
    setBusy(false);
    if (failure) setError(failure);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t(memory ? 'settings.memory.editTitle' : 'settings.memory.addTitle')}
          </DialogTitle>
        </DialogHeader>
        <Field label={t('settings.memory.category')} htmlFor={`${id}-category`}>
          <Select
            items={categoryItems}
            value={category}
            disabled={busy}
            onValueChange={(next) => {
              if (isMemoryCategory(next)) setCategory(next);
            }}
          >
            <SelectTrigger id={`${id}-category`}>
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
        </Field>
        <Field
          label={t('settings.memory.content')}
          htmlFor={`${id}-content`}
          hint={t('settings.memory.chars', { count: length, max: MEMORY_CONTENT_MAX })}
        >
          <Textarea
            id={`${id}-content`}
            value={content}
            rows={5}
            maxLength={MEMORY_CONTENT_MAX}
            aria-invalid={length > MEMORY_CONTENT_MAX}
            disabled={busy}
            onChange={(event) => setContent(event.target.value)}
          />
        </Field>
        {memory && (
          <div className="flex items-center justify-between gap-4">
            <label htmlFor={`${id}-pinned`} className="font-medium text-sm">
              {t('settings.memory.pinned')}
            </label>
            <Switch
              id={`${id}-pinned`}
              checked={pinned}
              disabled={busy}
              onCheckedChange={setPinned}
            />
          </div>
        )}
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
        <DialogFooter>
          <Button size="sm" variant="outline" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" disabled={!valid || busy} onClick={() => void submit()}>
            {t(busy ? 'common.saving' : 'common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
