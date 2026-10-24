import {
  type ApprovalMode,
  isApprovalMode,
  isThinkingLevel,
  isToolPolicy,
  isValidRoleId,
  parseRole,
  type Role,
  type ThinkingLevel,
  type ToolPolicy,
} from '@fynvra/core';
import { Copy, Download, Save, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { useMcpStore } from '@/stores/mcp';
import { useProvidersStore } from '@/stores/providers';
import { useRolesStore } from '@/stores/roles';
import { useSkillsStore } from '@/stores/skills';
import { Field, InlineMessage } from './common';
import { roleToJson } from './roleTransfer';
import { maskSecrets } from './secretMask';

const TOOL_POLICY_LABELS: Record<ToolPolicy, string> = {
  all: '全部工具（读写文件、执行命令）',
  readonly: '只读（读文件、搜索、git 只读）',
  orchestrator: '编排（只读 + 派活工具）',
};
const APPROVAL_LABELS: Record<ApprovalMode, string> = {
  supervised: '每次工具调用都确认',
  'auto-edits': '自动放行文件编辑',
  full: '全部自动放行',
};
const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: '关闭',
  minimal: '最少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '最高',
};
const toItems = <T extends string>(labels: Record<T, string>) =>
  (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));
const TOOL_POLICY_ITEMS = toItems(TOOL_POLICY_LABELS);
const APPROVAL_ITEMS = toItems(APPROVAL_LABELS);
const THINKING_ITEMS = [{ value: '', label: '默认' }, ...toItems(THINKING_LABELS)];

/** 模型下拉的值：`<服务 id>:<模型 id>`（服务 id 是 slug，不含冒号）；空串表示不固定模型。 */
const modelValue = (model: Role['model']) => (model ? `${model.providerId}:${model.modelId}` : '');

export function RoleEditor({
  initial,
  isNew,
  takenIds,
  onDirtyChange,
  onSaved,
  onCopy,
  onRemoved,
}: {
  initial: Role;
  isNew: boolean;
  /** 已有角色 id（新建时校验重名） */
  takenIds: readonly string[];
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (role: Role) => void;
  onCopy: (role: Role) => void;
  onRemoved: () => void;
}) {
  const save = useRolesStore((state) => state.save);
  const remove = useRolesStore((state) => state.remove);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const id = useId();
  const readOnly = initial.builtin === true;
  const dirty = isNew || JSON.stringify(draft) !== JSON.stringify(initial);

  const update = (next: Role) => {
    setDraft(next);
    setError(null);
    onDirtyChange(isNew || JSON.stringify(next) !== JSON.stringify(initial));
  };
  const setText = (key: 'description' | 'systemPrompt', value: string) => {
    const { [key]: _omit, ...rest } = draft;
    update(value === '' ? rest : { ...rest, [key]: value });
  };

  const submit = async () => {
    if (isNew && !isValidRoleId(draft.id)) {
      setError('ID 只能包含小写字母、数字和 -，且不能以 - 开头或结尾');
      return;
    }
    if (isNew && takenIds.includes(draft.id)) {
      setError(`已经有 id 为 ${draft.id} 的角色`);
      return;
    }
    const parsed = parseRole(normalize(draft));
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    const result = await save(parsed.role);
    setSaving(false);
    if (result.ok) onSaved(result.role);
    else setError(result.error);
  };

  const confirmRemove = async () => {
    const result = await remove(initial.id);
    if (result.ok) onRemoved();
    else {
      setConfirmingRemove(false);
      setError(result.error);
    }
  };

  return (
    <form
      className="grid min-w-0 gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {readOnly && (
        <InlineMessage className="rounded-md border bg-muted/50 px-3 py-2">
          内置角色只读。需要调整时点「复制为新角色」，在副本上修改。
        </InlineMessage>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="名称" htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            value={draft.name}
            disabled={readOnly}
            onChange={(event) => update({ ...draft, name: event.target.value })}
          />
        </Field>
        <Field
          label="ID"
          htmlFor={`${id}-role-id`}
          hint={isNew ? `保存为 roles/${draft.id || '<id>'}.json，之后不可修改` : undefined}
        >
          <Input
            id={`${id}-role-id`}
            value={draft.id}
            disabled={!isNew}
            spellCheck={false}
            className="font-mono"
            onChange={(event) => update({ ...draft, id: event.target.value.trim().toLowerCase() })}
          />
        </Field>
      </div>

      <Field label="描述" htmlFor={`${id}-description`}>
        <Input
          id={`${id}-description`}
          value={draft.description ?? ''}
          disabled={readOnly}
          placeholder="一句话说明这个角色做什么"
          onChange={(event) => setText('description', event.target.value)}
        />
      </Field>

      <Field
        label="系统提示词"
        htmlFor={`${id}-prompt`}
        hint="追加在默认系统提示词之后；随角色文件保存，不进 settings.json。"
      >
        <Textarea
          id={`${id}-prompt`}
          rows={10}
          value={draft.systemPrompt ?? ''}
          disabled={readOnly}
          spellCheck={false}
          className="max-h-[50vh] min-h-40 font-mono text-xs md:text-xs"
          onChange={(event) => setText('systemPrompt', event.target.value)}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <ModelField id={`${id}-model`} role={draft} disabled={readOnly} onChange={update} />
        <Field
          label="思考档位"
          htmlFor={`${id}-thinking`}
          hint={draft.model ? undefined : '固定模型后可选'}
        >
          <Select
            items={THINKING_ITEMS}
            value={draft.model?.thinking ?? ''}
            disabled={readOnly || !draft.model}
            onValueChange={(value) => {
              if (!draft.model) return;
              const { thinking: _omit, ...model } = draft.model;
              update({
                ...draft,
                model: isThinkingLevel(value) ? { ...model, thinking: value } : model,
              });
            }}
          >
            <SelectTrigger id={`${id}-thinking`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THINKING_ITEMS.map((item) => (
                <SelectItem key={item.value || 'default'} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="工具策略" htmlFor={`${id}-tools`}>
          <Select
            items={TOOL_POLICY_ITEMS}
            value={draft.tools}
            disabled={readOnly}
            onValueChange={(value) => {
              if (isToolPolicy(value)) update({ ...draft, tools: value });
            }}
          >
            <SelectTrigger id={`${id}-tools`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TOOL_POLICY_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="审批档位" htmlFor={`${id}-approval`}>
          <Select
            items={APPROVAL_ITEMS}
            value={draft.approvalMode}
            disabled={readOnly}
            onValueChange={(value) => {
              if (isApprovalMode(value)) update({ ...draft, approvalMode: value });
            }}
          >
            <SelectTrigger id={`${id}-approval`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {APPROVAL_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SkillToggles
          selected={draft.skillIds}
          disabled={readOnly}
          onChange={(skillIds) => update({ ...draft, skillIds })}
        />
        <McpToggles
          selected={draft.mcpServerIds}
          disabled={readOnly}
          onChange={(mcpServerIds) => update({ ...draft, mcpServerIds })}
        />
      </div>

      {error && <InlineMessage tone="error">{error}</InlineMessage>}

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        {!readOnly && (
          <Button type="submit" disabled={saving || !dirty}>
            <Save />
            {saving ? '保存中…' : '保存'}
          </Button>
        )}
        {!isNew && (
          <>
            <Button type="button" variant="outline" onClick={() => onCopy(initial)}>
              <Copy />
              复制为新角色
            </Button>
            <Button type="button" variant="outline" onClick={() => downloadRole(initial)}>
              <Download />
              导出 JSON
            </Button>
          </>
        )}
        {!readOnly && !isNew && (
          <div className="ml-auto flex items-center gap-2">
            {confirmingRemove ? (
              <>
                <span className="text-muted-foreground text-xs">
                  删除 roles/{initial.id}.json？
                </span>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => void confirmRemove()}
                >
                  确认删除
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmingRemove(false)}
                >
                  取消
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmingRemove(true)}
              >
                <Trash2 />
                删除
              </Button>
            )}
          </div>
        )}
      </div>
    </form>
  );
}

/** 保存前去掉只有空白的可选文本，角色文件里不留空字段。 */
function normalize(role: Role): Role {
  const { description, systemPrompt, ...rest } = role;
  return {
    ...rest,
    ...(description?.trim() ? { description } : {}),
    ...(systemPrompt?.trim() ? { systemPrompt } : {}),
  };
}

/** 导出：浏览器下载（Electron 弹出另存为对话框），文件名即角色 id。 */
function downloadRole(role: Role): void {
  const url = URL.createObjectURL(new Blob([roleToJson(role)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${role.id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ModelField({
  id,
  role,
  disabled,
  onChange,
}: {
  id: string;
  role: Role;
  disabled: boolean;
  onChange: (role: Role) => void;
}) {
  const providers = useProvidersStore((state) => state.providers);
  const current = modelValue(role.model);
  const options = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      value: `${provider.id}:${model.id}`,
      label: `${provider.name} / ${model.name}`,
    }))
  );
  // 角色引用的服务或模型已被删除：保留为一个「不可用」选项，避免下拉显示成空白
  const missing =
    role.model && !options.some((option) => option.value === current)
      ? { value: current, label: `${role.model.providerId} / ${role.model.modelId}（不可用）` }
      : null;
  const items = [
    { value: '', label: '不固定（由会话决定）' },
    ...(missing ? [missing] : []),
    ...options,
  ];

  return (
    <Field
      label="模型"
      htmlFor={id}
      hint={providers.length === 0 ? '先在「模型服务」里添加服务' : undefined}
    >
      <Select
        items={items}
        value={current}
        disabled={disabled}
        onValueChange={(value) => {
          if (typeof value !== 'string' || value === '') {
            const { model: _omit, ...rest } = role;
            onChange(rest);
            return;
          }
          const separator = value.indexOf(':');
          const thinking = role.model?.thinking;
          onChange({
            ...role,
            model: {
              providerId: value.slice(0, separator),
              modelId: value.slice(separator + 1),
              ...(thinking ? { thinking } : {}),
            },
          });
        }}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">不固定（由会话决定）</SelectItem>
          {missing && <SelectItem value={missing.value}>{missing.label}</SelectItem>}
          {providers.map((provider) => (
            <SelectGroup key={provider.id}>
              <SelectGroupLabel>
                {provider.name}
                {!provider.enabled && '（已停用）'}
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
    </Field>
  );
}

interface ToggleItem {
  id: string;
  name: string;
  description?: string;
  /** 注册表里已停用 */
  inactive?: boolean;
  /** 角色引用了、但注册表里已经没有 */
  missing?: boolean;
}

function SkillToggles(props: {
  selected: string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  const skills = useSkillsStore((state) => state.skills);
  const items = skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    inactive: !skill.enabled,
  }));
  return (
    <ToggleList
      label="技能"
      emptyHint="还没有登记技能：在「技能」里扫描或添加"
      items={items}
      {...props}
    />
  );
}

function McpToggles(props: {
  selected: string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  const servers = useMcpStore((state) => state.servers);
  const items = servers.map((server) => ({
    id: server.id,
    name: server.name,
    description: maskSecrets(server.url ?? [server.command, ...(server.args ?? [])].join(' ')),
    inactive: !server.enabled,
  }));
  return (
    <ToggleList
      label="MCP 服务器"
      emptyHint="还没有 MCP 服务器：在「MCP」里添加或导入"
      items={items}
      {...props}
    />
  );
}

/** 多选列表：每项一个开关。角色引用了但注册表里已没有的 id 也列出来，方便取消。 */
function ToggleList({
  label,
  emptyHint,
  items,
  selected,
  disabled,
  onChange,
}: {
  label: string;
  emptyHint: string;
  items: ToggleItem[];
  selected: string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  const known = new Set(items.map((item) => item.id));
  const rows: ToggleItem[] = [
    ...items,
    ...selected
      .filter((id) => !known.has(id))
      .map((id) => ({ id, name: id, description: '已从注册表移除', missing: true })),
  ];
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...selected, id] : selected.filter((existing) => existing !== id));

  return (
    <div className="grid min-w-0 content-start gap-2">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">{label}</span>
        <span className="text-muted-foreground text-xs">已选 {selected.length}</span>
      </div>
      <ul className="max-h-56 divide-y overflow-y-auto rounded-md border">
        {rows.length === 0 && (
          <li className="px-3 py-4 text-center text-muted-foreground text-xs">{emptyHint}</li>
        )}
        {rows.map((item) => (
          <li key={item.id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-sm">
                <span className="truncate">{item.name}</span>
                {item.inactive && <Badge variant="outline">已停用</Badge>}
                {item.missing && <Badge variant="destructive">已移除</Badge>}
              </div>
              {item.description && (
                <p className="truncate text-muted-foreground text-xs" title={item.description}>
                  {item.description}
                </p>
              )}
            </div>
            <Switch
              checked={selected.includes(item.id)}
              disabled={disabled}
              aria-label={`${label}：${item.name}`}
              onCheckedChange={(on) => toggle(item.id, on)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
