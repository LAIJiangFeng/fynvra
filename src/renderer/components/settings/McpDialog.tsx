import type { McpServerEntry } from '@shared/types/llm';
import { Plus, X } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import type { MessageId } from '@/i18n';
import { useT } from '@/i18n/I18nProvider';
import { useMcpStore } from '@/stores/mcp';
import { Field, InlineMessage } from './common';
import { addSecretRow, draftToMcpInput, type McpDraft, type SecretRow } from './mcpForm';

type Transport = McpServerEntry['transport'];

/** 传输方式；显示名在字典 settings.mcp.transports */
const TRANSPORTS: readonly Transport[] = ['stdio', 'http', 'sse'];
const isTransport = (value: unknown): value is Transport =>
  typeof value === 'string' && (TRANSPORTS as readonly string[]).includes(value);

/** 一次编辑会话：key 变化时表单重置。 */
export interface McpEditing {
  key: number;
  draft: McpDraft;
}

/** 新建 / 编辑 MCP 服务器。env / headers 的值只写不读：已保存的值留空即沿用。 */
export function McpDialog({
  editing,
  onClose,
}: {
  editing: McpEditing | null;
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
        {shown && <McpForm key={shown.key} initial={shown.draft} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function McpForm({ initial, onDone }: { initial: McpDraft; onDone: () => void }) {
  const upsert = useMcpStore((state) => state.upsert);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const id = useId();
  const t = useT();
  const update = (patch: Partial<McpDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const transportItems = TRANSPORTS.map((value) => ({
    value,
    label: t(`settings.mcp.transports.${value}`),
  }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = draftToMcpInput(draft);
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

  return (
    <form onSubmit={submit} className="grid min-w-0 gap-4">
      <DialogHeader>
        <DialogTitle>
          {initial.id ? t('common.editItem', { name: initial.name }) : t('settings.mcp.addTitle')}
        </DialogTitle>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('common.name')} htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            value={draft.name}
            placeholder={t('settings.mcp.namePlaceholder')}
            onChange={(event) => update({ name: event.target.value })}
          />
        </Field>
        <Field label={t('settings.mcp.transport')} htmlFor={`${id}-transport`}>
          <Select
            items={transportItems}
            value={draft.transport}
            onValueChange={(value) => {
              if (isTransport(value)) update({ transport: value });
            }}
          >
            <SelectTrigger id={`${id}-transport`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {transportItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      {draft.transport === 'stdio' ? (
        <>
          <Field label={t('settings.mcp.command')} htmlFor={`${id}-command`}>
            <Input
              id={`${id}-command`}
              value={draft.command}
              placeholder={t('settings.mcp.commandPlaceholder')}
              spellCheck={false}
              className="font-mono"
              onChange={(event) => update({ command: event.target.value })}
            />
          </Field>
          <Field
            label={t('settings.mcp.args')}
            htmlFor={`${id}-args`}
            hint={t('settings.mcp.argsHint')}
          >
            <Textarea
              id={`${id}-args`}
              rows={3}
              value={draft.argsText}
              placeholder={'-y\n@modelcontextprotocol/server-github'}
              spellCheck={false}
              className="font-mono text-xs md:text-xs"
              onChange={(event) => update({ argsText: event.target.value })}
            />
          </Field>
          <SecretRowsEditor
            label="settings.mcp.env"
            keyPlaceholder="GITHUB_TOKEN"
            rows={draft.env}
            onChange={(env) => update({ env })}
          />
        </>
      ) : (
        <>
          <Field label="URL" htmlFor={`${id}-url`}>
            <Input
              id={`${id}-url`}
              value={draft.url}
              placeholder="https://example.com/mcp"
              spellCheck={false}
              className="font-mono"
              onChange={(event) => update({ url: event.target.value })}
            />
          </Field>
          <SecretRowsEditor
            label="settings.mcp.header"
            keyPlaceholder="Authorization"
            rows={draft.headers}
            onChange={(headers) => update({ headers })}
          />
        </>
      )}

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

/** 键值行编辑器。已保存的键名只读（改名请删除后新增），值输入框留空表示沿用。 */
function SecretRowsEditor({
  label,
  keyPlaceholder,
  rows,
  onChange,
}: {
  label: MessageId;
  keyPlaceholder: string;
  rows: SecretRow[];
  onChange: (rows: SecretRow[]) => void;
}) {
  const t = useT();
  const name = t(label);
  const patch = (rowId: number, changes: Partial<SecretRow>) =>
    onChange(rows.map((row) => (row.rowId === rowId ? { ...row, ...changes } : row)));

  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">{name}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange(addSecretRow(rows))}
        >
          <Plus />
          {t('common.add')}
        </Button>
      </div>
      {rows.length === 0 && (
        <p className="text-muted-foreground text-xs">{t('settings.mcp.none', { label: name })}</p>
      )}
      {rows.map((row) => (
        <div key={row.rowId} className="flex min-w-0 gap-2">
          <Input
            aria-label={t('settings.mcp.keyName', { label: name })}
            className="w-2/5 font-mono"
            value={row.key}
            placeholder={keyPlaceholder}
            readOnly={row.saved}
            spellCheck={false}
            onChange={(event) => patch(row.rowId, { key: event.target.value })}
          />
          <Input
            aria-label={t('settings.mcp.valueOf', { label: name, key: row.key })}
            type="password"
            autoComplete="off"
            className="min-w-0 flex-1 font-mono"
            value={row.value}
            placeholder={t(row.saved ? 'settings.mcp.savedValue' : 'settings.mcp.value')}
            onChange={(event) => patch(row.rowId, { value: event.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('settings.mcp.deleteRow', { key: row.key || t('settings.mcp.thisRow') })}
            onClick={() => onChange(rows.filter((item) => item.rowId !== row.rowId))}
          >
            <X />
          </Button>
        </div>
      ))}
    </div>
  );
}
