import {
  DEFAULT_BASE_URLS,
  isProviderApi,
  PROVIDER_APIS,
  providerApiLabel,
} from '@shared/modelCatalog';
import type { RemoteModelEntry } from '@shared/types/llm';
import { CloudDownload, Plus, X } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n/I18nProvider';
import { useProvidersStore } from '@/stores/providers';
import { Field, InlineMessage } from './common';
import {
  addModel,
  draftToUpsertInput,
  type ProviderDraft,
  reasoningControl,
  setModelReasoning,
} from './providerForm';
import { RemoteModelsPicker } from './RemoteModelsPicker';
import {
  canListRemoteModels,
  mergeRemoteModels,
  type RemoteModelsRequest,
  remoteModelsRequest,
} from './remoteModels';

const API_ITEMS = PROVIDER_APIS.map((api) => ({ value: api, label: providerApiLabel(api) }));

/** 一次编辑会话：key 变化时表单重置。 */
export interface ProviderEditing {
  key: number;
  draft: ProviderDraft;
}

/** 新建 / 编辑模型服务的弹窗。key 输入框只写不读：已保存的 key 只以末 4 位提示。 */
export function ProviderDialog({
  editing,
  onClose,
}: {
  editing: ProviderEditing | null;
  onClose: () => void;
}) {
  // 关闭动画期间 editing 已清空，沿用上一次的内容避免弹窗闪成空白
  const [shown, setShown] = useState(editing);
  if (editing && editing !== shown) setShown(editing);

  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {/* 展开「拉取模型列表」后内容变高：限高滚动，矮窗口里也够得着保存按钮 */}
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        {shown && <ProviderForm key={shown.key} initial={shown.draft} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function ProviderForm({ initial, onDone }: { initial: ProviderDraft; onDone: () => void }) {
  const upsert = useProvidersStore((state) => state.upsert);
  const described = useProvidersStore((state) => state.modelOptions);
  const loadModelOptions = useProvidersStore((state) => state.loadModelOptions);
  const [draft, setDraft] = useState(initial);
  const [modelInput, setModelInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [remote, setRemote] = useState<{ key: number; request: RemoteModelsRequest } | null>(null);
  const id = useId();
  const t = useT();
  const update = (patch: Partial<ProviderDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  // 每次点击都按表单当前的协议、地址与 key 重新拉取：换 key 让面板重新挂载
  const openRemote = () =>
    setRemote((current) => ({ key: (current?.key ?? 0) + 1, request: remoteModelsRequest(draft) }));

  const addRemote = (picked: RemoteModelEntry[]) => {
    const result = mergeRemoteModels(draft.models, picked);
    update({ models: result.models });
    setError(null);
    return result;
  };

  // 已保存模型的档位：判断「推理」由内置目录决定还是由开关决定
  useEffect(() => {
    void loadModelOptions();
  }, [loadModelOptions]);

  const addModelFromInput = () => {
    const result = addModel(draft.models, modelInput);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    update({ models: result.models });
    setModelInput('');
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = draftToUpsertInput(draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaving(true);
    const saved = await upsert(result.input);
    setSaving(false);
    if (saved.ok) onDone();
    else setError(saved.error);
  };

  const keyPlaceholder =
    draft.hasSavedKey && !draft.clearApiKey
      ? t('settings.providers.savedKey', { hint: draft.savedKeyHint ?? '' })
      : t('settings.providers.pasteKey');

  return (
    <form onSubmit={submit} className="grid min-w-0 gap-4">
      <DialogHeader>
        <DialogTitle>
          {initial.id
            ? t('common.editItem', { name: initial.name })
            : t('settings.providers.addTitle', { name: initial.name })}
        </DialogTitle>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('common.name')} htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            value={draft.name}
            onChange={(event) => update({ name: event.target.value })}
          />
        </Field>
        <Field label={t('settings.providers.api')} htmlFor={`${id}-api`}>
          <Select
            items={API_ITEMS}
            value={draft.api}
            onValueChange={(value) => {
              if (isProviderApi(value)) update({ api: value });
            }}
          >
            <SelectTrigger id={`${id}-api`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {API_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field
        label="Base URL"
        htmlFor={`${id}-base-url`}
        hint={t(
          draft.requiresBaseUrl ? 'settings.providers.required' : 'settings.providers.officialUrl'
        )}
      >
        <Input
          id={`${id}-base-url`}
          value={draft.baseUrl}
          placeholder={
            draft.requiresBaseUrl ? 'https://api.example.com/v1' : DEFAULT_BASE_URLS[draft.api]
          }
          spellCheck={false}
          onChange={(event) => update({ baseUrl: event.target.value })}
        />
      </Field>

      <Field
        label="API Key"
        htmlFor={`${id}-api-key`}
        hint={draft.clearApiKey ? t('settings.providers.clearOnSave') : undefined}
      >
        <div className="flex gap-2">
          <Input
            id={`${id}-api-key`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft.apiKey}
            placeholder={keyPlaceholder}
            onChange={(event) => update({ apiKey: event.target.value })}
          />
          {draft.hasSavedKey && (
            <Button
              type="button"
              variant="outline"
              onClick={() => update({ clearApiKey: !draft.clearApiKey, apiKey: '' })}
            >
              {t(
                draft.clearApiKey ? 'settings.providers.undoClear' : 'settings.providers.clearKey'
              )}
            </Button>
          )}
        </div>
      </Field>

      <div className="grid min-w-0 gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-sm">{t('settings.providers.models')}</span>
          <span className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">
              {t('settings.providers.modelCount', { count: draft.models.length })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canListRemoteModels(draft)}
              onClick={openRemote}
            >
              <CloudDownload />
              {t('settings.providers.fetchModels')}
            </Button>
          </span>
        </div>
        {remote && (
          <RemoteModelsPicker
            key={remote.key}
            request={remote.request}
            current={draft.models}
            onAdd={addRemote}
            onReload={openRemote}
            onClose={() => setRemote(null)}
          />
        )}
        <ul className="max-h-44 divide-y overflow-y-auto rounded-md border">
          {draft.models.map((model) => {
            const control = reasoningControl(draft.api, model.id, described, initial.id);
            const switchId = `${id}-reasoning-${model.id}`;
            return (
              <li key={model.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {model.name}
                  {model.name !== model.id && (
                    <span className="ml-2 text-muted-foreground text-xs">{model.id}</span>
                  )}
                </span>
                {control.kind === 'catalog' ? (
                  <Badge
                    variant="outline"
                    title={t('settings.providers.catalogDecides')}
                    className={control.reasoning ? undefined : 'opacity-60'}
                  >
                    {t(
                      control.reasoning
                        ? 'settings.providers.reasoning'
                        : 'settings.providers.noReasoning'
                    )}
                  </Badge>
                ) : (
                  <span
                    className="flex shrink-0 items-center gap-1.5"
                    title={t('settings.providers.reasoningHint')}
                  >
                    <Switch
                      id={switchId}
                      aria-label={t('settings.providers.reasoningFor', { id: model.id })}
                      checked={model.reasoning === true}
                      onCheckedChange={(on) =>
                        update({ models: setModelReasoning(draft.models, model.id, on) })
                      }
                    />
                    <label htmlFor={switchId} className="text-muted-foreground text-xs">
                      {t('settings.providers.reasoning')}
                    </label>
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('settings.providers.removeModel', { id: model.id })}
                  onClick={() => update({ models: draft.models.filter((m) => m.id !== model.id) })}
                >
                  <X />
                </Button>
              </li>
            );
          })}
          {draft.models.length === 0 && (
            <li className="px-3 py-3 text-center text-muted-foreground text-xs">
              {t('settings.providers.noModels')}
            </li>
          )}
        </ul>
        <div className="flex gap-2">
          <Input
            aria-label={t('settings.providers.modelInput')}
            placeholder={t('settings.providers.modelPlaceholder')}
            spellCheck={false}
            value={modelInput}
            onChange={(event) => setModelInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addModelFromInput();
              }
            }}
          />
          <Button type="button" variant="outline" onClick={addModelFromInput}>
            <Plus />
            {t('common.add')}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <Switch
          id={`${id}-enabled`}
          checked={draft.enabled}
          onCheckedChange={(enabled) => update({ enabled })}
        />
        <label htmlFor={`${id}-enabled`}>{t('common.enable')}</label>
      </div>

      {error && <InlineMessage tone="error">{error}</InlineMessage>}

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>
          {t('common.cancel')}
        </DialogClose>
        <Button type="submit" disabled={saving}>
          {t(saving ? 'common.saving' : 'common.save')}
        </Button>
      </DialogFooter>
    </form>
  );
}
