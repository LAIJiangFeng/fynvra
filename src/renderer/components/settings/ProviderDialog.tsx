import {
  DEFAULT_BASE_URLS,
  isProviderApi,
  PROVIDER_APIS,
  providerApiLabel,
} from '@shared/modelCatalog';
import { Plus, X } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
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
import { useProvidersStore } from '@/stores/providers';
import { Field, InlineMessage } from './common';
import { addModel, draftToUpsertInput, type ProviderDraft } from './providerForm';

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
      <DialogContent className="sm:max-w-xl">
        {shown && <ProviderForm key={shown.key} initial={shown.draft} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function ProviderForm({ initial, onDone }: { initial: ProviderDraft; onDone: () => void }) {
  const upsert = useProvidersStore((state) => state.upsert);
  const [draft, setDraft] = useState(initial);
  const [modelInput, setModelInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const id = useId();
  const update = (patch: Partial<ProviderDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

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
      ? `已保存 ••••${draft.savedKeyHint ?? ''}，留空则不修改`
      : '粘贴 API Key';

  return (
    <form onSubmit={submit} className="grid min-w-0 gap-4">
      <DialogHeader>
        <DialogTitle>{initial.id ? `编辑 ${initial.name}` : `添加 ${initial.name}`}</DialogTitle>
        <DialogDescription>
          API Key 只保存在本机的 providers.json，不会回显到界面。
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="名称" htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            value={draft.name}
            onChange={(event) => update({ name: event.target.value })}
          />
        </Field>
        <Field label="API 协议" htmlFor={`${id}-api`}>
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
        hint={
          draft.requiresBaseUrl
            ? '必填：OpenAI 兼容接口的地址，通常以 /v1 结尾'
            : `留空使用官方地址 ${DEFAULT_BASE_URLS[draft.api]}`
        }
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
        hint={draft.clearApiKey ? '保存后将清除已保存的 key' : undefined}
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
              {draft.clearApiKey ? '撤销清除' : '清除 key'}
            </Button>
          )}
        </div>
      </Field>

      <div className="grid min-w-0 gap-2">
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm">模型</span>
          <span className="text-muted-foreground text-xs">{draft.models.length} 个</span>
        </div>
        <ul className="max-h-44 divide-y overflow-y-auto rounded-md border">
          {draft.models.map((model) => (
            <li key={model.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {model.name}
                {model.name !== model.id && (
                  <span className="ml-2 text-muted-foreground text-xs">{model.id}</span>
                )}
              </span>
              {model.reasoning && <Badge variant="outline">推理</Badge>}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`移除模型 ${model.id}`}
                onClick={() => update({ models: draft.models.filter((m) => m.id !== model.id) })}
              >
                <X />
              </Button>
            </li>
          ))}
          {draft.models.length === 0 && (
            <li className="px-3 py-3 text-center text-muted-foreground text-xs">
              还没有模型：在下面输入模型 id 添加
            </li>
          )}
        </ul>
        <div className="flex gap-2">
          <Input
            aria-label="要添加的模型 id"
            placeholder="模型 id，例如 deepseek-chat"
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
            添加
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <Switch
          id={`${id}-enabled`}
          checked={draft.enabled}
          onCheckedChange={(enabled) => update({ enabled })}
        />
        <label htmlFor={`${id}-enabled`}>启用</label>
      </div>

      {error && <InlineMessage tone="error">{error}</InlineMessage>}

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
        <Button type="submit" disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </DialogFooter>
    </form>
  );
}
