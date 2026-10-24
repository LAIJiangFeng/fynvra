import type { McpServerEntry } from '@shared/types/llm';
import { Plus, X } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { useMcpStore } from '@/stores/mcp';
import { Field, InlineMessage } from './common';
import { addSecretRow, draftToMcpInput, type McpDraft, type SecretRow } from './mcpForm';

type Transport = McpServerEntry['transport'];

export const TRANSPORT_LABELS: Record<Transport, string> = {
  stdio: '本地进程（stdio）',
  http: '远程（Streamable HTTP）',
  sse: '远程（SSE）',
};
const TRANSPORT_ITEMS = (Object.keys(TRANSPORT_LABELS) as Transport[]).map((value) => ({
  value,
  label: TRANSPORT_LABELS[value],
}));
const isTransport = (value: unknown): value is Transport =>
  typeof value === 'string' && Object.hasOwn(TRANSPORT_LABELS, value);

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
  const update = (patch: Partial<McpDraft>) => setDraft((current) => ({ ...current, ...patch }));

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
        <DialogTitle>{initial.id ? `编辑 ${initial.name}` : '添加 MCP 服务器'}</DialogTitle>
        <DialogDescription>
          环境变量与 Header 的值只保存在本机的 mcp.json，界面上只显示键名。
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="名称" htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            value={draft.name}
            placeholder="例如 github"
            onChange={(event) => update({ name: event.target.value })}
          />
        </Field>
        <Field label="传输方式" htmlFor={`${id}-transport`}>
          <Select
            items={TRANSPORT_ITEMS}
            value={draft.transport}
            onValueChange={(value) => {
              if (isTransport(value)) update({ transport: value });
            }}
          >
            <SelectTrigger id={`${id}-transport`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRANSPORT_ITEMS.map((item) => (
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
          <Field label="命令" htmlFor={`${id}-command`}>
            <Input
              id={`${id}-command`}
              value={draft.command}
              placeholder="例如 npx"
              spellCheck={false}
              className="font-mono"
              onChange={(event) => update({ command: event.target.value })}
            />
          </Field>
          <Field label="参数" htmlFor={`${id}-args`} hint="一行一个参数">
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
            label="环境变量"
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
            label="Header"
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

/** 键值行编辑器。已保存的键名只读（改名请删除后新增），值输入框留空表示沿用。 */
function SecretRowsEditor({
  label,
  keyPlaceholder,
  rows,
  onChange,
}: {
  label: string;
  keyPlaceholder: string;
  rows: SecretRow[];
  onChange: (rows: SecretRow[]) => void;
}) {
  const patch = (rowId: number, changes: Partial<SecretRow>) =>
    onChange(rows.map((row) => (row.rowId === rowId ? { ...row, ...changes } : row)));

  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">{label}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange(addSecretRow(rows))}
        >
          <Plus />
          添加
        </Button>
      </div>
      {rows.length === 0 && <p className="text-muted-foreground text-xs">没有{label}</p>}
      {rows.map((row) => (
        <div key={row.rowId} className="flex min-w-0 gap-2">
          <Input
            aria-label={`${label}名`}
            className="w-2/5 font-mono"
            value={row.key}
            placeholder={keyPlaceholder}
            readOnly={row.saved}
            spellCheck={false}
            onChange={(event) => patch(row.rowId, { key: event.target.value })}
          />
          <Input
            aria-label={`${label} ${row.key || ''} 的值`}
            type="password"
            autoComplete="off"
            className="min-w-0 flex-1 font-mono"
            value={row.value}
            placeholder={row.saved ? '已保存，留空则不修改' : '值'}
            onChange={(event) => patch(row.rowId, { value: event.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`删除 ${row.key || '这一行'}`}
            onClick={() => onChange(rows.filter((item) => item.rowId !== row.rowId))}
          >
            <X />
          </Button>
        </div>
      ))}
    </div>
  );
}
