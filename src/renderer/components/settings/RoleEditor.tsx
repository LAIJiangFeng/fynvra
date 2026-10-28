import {
  type ApprovalMode,
  getBuiltinRole,
  isApprovalMode,
  isBuiltinRoleId,
  isThinkingLevel,
  isToolPolicy,
  isValidRoleId,
  parseRole,
  type Role,
  type ToolPolicy,
} from '@fynvra/core';
import type { ModelProviderOption } from '@shared/types/chat';
import { Copy, Download, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { ThinkingSourceBadge } from '@/components/chat/ModelPicker';
import { roleDescription } from '@/components/chat/roles';
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
import type { MessageId, T } from '@/i18n';
import { useT } from '@/i18n/I18nProvider';
import { useInstructionsStore } from '@/stores/instructions';
import { useMcpStore } from '@/stores/mcp';
import { useProvidersStore } from '@/stores/providers';
import { useRolesStore } from '@/stores/roles';
import { useSkillsStore } from '@/stores/skills';
import { Field, InlineMessage } from './common';
import {
  normalizeRoleThinking,
  type RoleThinking,
  roleThinking,
  thinkingOptions,
  withRoleModel,
} from './roleModel';
import { roleToJson } from './roleTransfer';
import { maskSecrets } from './secretMask';

/** 选项只留名称 */
const TOOL_POLICIES: readonly ToolPolicy[] = ['all', 'readonly', 'orchestrator'];
/** 与输入框的操作通知范围同名；沿用旧字段值。 */
const APPROVAL_MODES: readonly ApprovalMode[] = ['supervised', 'auto-edits', 'full'];
const toItems = <V extends string>(values: readonly V[], label: (value: V) => string) =>
  values.map((value) => ({ value, label: label(value) }));

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
  const modelOptions = useProvidersStore((state) => state.modelOptions);
  const modelOptionsError = useProvidersStore((state) => state.modelOptionsError);
  const loadModelOptions = useProvidersStore((state) => state.loadModelOptions);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const id = useId();
  const t = useT();
  const toolPolicyItems = toItems(TOOL_POLICIES, (policy) =>
    t(`settings.roles.toolPolicies.${policy}`)
  );
  const approvalItems = toItems(APPROVAL_MODES, (mode) => t(`approval.modes.${mode}`));
  const builtin = isBuiltinRoleId(initial.id);
  const dirty = isNew || JSON.stringify(draft) !== JSON.stringify(initial);
  const options = modelOptions?.options ?? null;
  const thinking = roleThinking(draft.model, options, modelOptionsError !== null);

  // 每个模型可选的思考档位：与新建会话、模型选择器同一份（sessions:model-options）
  useEffect(() => {
    void loadModelOptions();
  }, [loadModelOptions]);

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
    if (saving) return;
    if (isNew && !isValidRoleId(draft.id)) {
      setError(t('settings.roles.idInvalid'));
      return;
    }
    if (isNew && takenIds.includes(draft.id)) {
      setError(t('settings.roles.idTaken', { id: draft.id }));
      return;
    }
    const parsed = parseRole(normalizeRoleThinking(normalize(draft), options));
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
      {builtin && (
        <InlineMessage className="rounded-md border bg-muted/50 px-3 py-2">
          {t('settings.roles.builtinEditable')}
        </InlineMessage>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('settings.roles.name')} htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            value={draft.name}
            disabled={saving}
            onChange={(event) => update({ ...draft, name: event.target.value })}
          />
        </Field>
        <Field
          label="ID"
          htmlFor={`${id}-role-id`}
          hint={isNew ? t('settings.roles.idHint') : undefined}
        >
          <Input
            id={`${id}-role-id`}
            value={draft.id}
            disabled={!isNew || saving}
            spellCheck={false}
            className="font-mono"
            onChange={(event) => update({ ...draft, id: event.target.value.trim().toLowerCase() })}
          />
        </Field>
      </div>

      <Field label={t('settings.roles.description')} htmlFor={`${id}-description`}>
        <Input
          id={`${id}-description`}
          value={roleDescription(draft, t) ?? ''}
          disabled={saving}
          placeholder={t('settings.roles.descriptionPlaceholder')}
          onChange={(event) => setText('description', event.target.value)}
        />
      </Field>

      <Field
        label={t('settings.roles.systemPrompt')}
        htmlFor={`${id}-prompt`}
        hint={t('settings.roles.systemPromptHint')}
      >
        <Textarea
          id={`${id}-prompt`}
          rows={10}
          value={draft.systemPrompt ?? ''}
          disabled={saving}
          spellCheck={false}
          className="max-h-[50vh] min-h-40 font-mono text-xs md:text-xs"
          onChange={(event) => setText('systemPrompt', event.target.value)}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <ModelField
          id={`${id}-model`}
          role={draft}
          options={options}
          unsupported={thinking.kind === 'unsupported'}
          disabled={saving}
          onChange={update}
        />
        {thinking.kind !== 'unsupported' && (
          <ThinkingField
            id={`${id}-thinking`}
            role={draft}
            state={thinking}
            error={modelOptionsError}
            disabled={saving}
            onChange={update}
          />
        )}
        <Field label={t('settings.roles.toolPolicy')} htmlFor={`${id}-tools`}>
          <Select
            items={toolPolicyItems}
            value={draft.tools}
            disabled={saving}
            onValueChange={(value) => {
              if (isToolPolicy(value)) update({ ...draft, tools: value });
            }}
          >
            <SelectTrigger id={`${id}-tools`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {toolPolicyItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('settings.roles.approvalMode')} htmlFor={`${id}-approval`}>
          <Select
            items={approvalItems}
            value={draft.approvalMode}
            disabled={saving}
            onValueChange={(value) => {
              if (isApprovalMode(value)) update({ ...draft, approvalMode: value });
            }}
          >
            <SelectTrigger id={`${id}-approval`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {approvalItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">{t('approval.hint')}</p>
        </Field>
      </div>

      <InstructionField role={draft} disabled={saving} onChange={update} />

      <div className="grid gap-4 lg:grid-cols-2">
        <SkillToggles
          selected={draft.skillIds}
          disabled={saving}
          onChange={(skillIds) => update({ ...draft, skillIds })}
        />
        <McpToggles
          selected={draft.mcpServerIds}
          disabled={saving}
          onChange={(mcpServerIds) => update({ ...draft, mcpServerIds })}
        />
      </div>

      {error && <InlineMessage tone="error">{error}</InlineMessage>}

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <Button type="submit" disabled={saving || !dirty}>
          <Save />
          {t(saving ? 'common.saving' : 'common.save')}
        </Button>
        {builtin && (
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => setConfirmingReset(true)}
          >
            <RotateCcw />
            {t('settings.roles.resetDefaults')}
          </Button>
        )}
        {!isNew && (
          <>
            <Button type="button" variant="outline" onClick={() => onCopy(initial)}>
              <Copy />
              {t('settings.roles.copyAsNew')}
            </Button>
            <Button type="button" variant="outline" onClick={() => downloadRole(initial)}>
              <Download />
              {t('settings.roles.exportJson')}
            </Button>
          </>
        )}
        {!builtin && !isNew && (
          <div className="ml-auto flex items-center gap-2">
            {confirmingRemove ? (
              <>
                <span className="text-muted-foreground text-xs">
                  {t('settings.roles.confirmDeleteFile', { id: initial.id })}
                </span>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => void confirmRemove()}
                >
                  {t('common.confirmDelete')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmingRemove(false)}
                >
                  {t('common.cancel')}
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
                {t('common.delete')}
              </Button>
            )}
          </div>
        )}
      </div>
      <Dialog open={confirmingReset} onOpenChange={setConfirmingReset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.roles.resetTitle')}</DialogTitle>
            <DialogDescription>{t('settings.roles.resetHint')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmingReset(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => {
                const defaults = getBuiltinRole(initial.id);
                if (defaults) update(defaults);
                setConfirmingReset(false);
              }}
            >
              {t('settings.roles.resetDefaults')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

/**
 * 模型下拉：列出全部服务的模型（停用的服务也列，标「已停用」）。换模型时思考档位按新模型落定，
 * 规则同新建会话（{@link withRoleModel}）。
 */
function ModelField({
  id,
  role,
  options,
  unsupported,
  disabled,
  onChange,
}: {
  id: string;
  role: Role;
  /** sessions:model-options 的服务与模型（每个模型带它的思考档位）；null 表示还没读到 */
  options: readonly ModelProviderOption[] | null;
  /** 选中的模型不支持推理 */
  unsupported: boolean;
  disabled: boolean;
  onChange: (role: Role) => void;
}) {
  const providers = useProvidersStore((state) => state.providers);
  const t = useT();
  const current = modelValue(role.model);
  const followSession = t('settings.roles.followSession');
  const choices = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      value: `${provider.id}:${model.id}`,
      label: `${provider.name} / ${model.name}`,
    }))
  );
  // 角色引用的服务或模型已被删除：保留为一个「不可用」选项，避免下拉显示成空白
  const missing =
    role.model && !choices.some((choice) => choice.value === current)
      ? {
          value: current,
          label: t('settings.roles.unavailableModel', {
            model: `${role.model.providerId} / ${role.model.modelId}`,
          }),
        }
      : null;
  const items = [{ value: '', label: followSession }, ...(missing ? [missing] : []), ...choices];

  return (
    <Field
      label={t('settings.roles.model')}
      htmlFor={id}
      hint={
        providers.length === 0
          ? t('settings.roles.addProviderFirst')
          : unsupported
            ? t('settings.roles.noReasoning')
            : undefined
      }
    >
      <Select
        items={items}
        value={current}
        disabled={disabled}
        onValueChange={(value) => {
          if (typeof value !== 'string' || value === '') {
            onChange(withRoleModel(role, undefined, options));
            return;
          }
          const separator = value.indexOf(':');
          const ref = {
            providerId: value.slice(0, separator),
            modelId: value.slice(separator + 1),
          };
          onChange(withRoleModel(role, ref, options));
        }}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">{followSession}</SelectItem>
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
    </Field>
  );
}

/**
 * 思考档位：只列所选模型自己的档位（官方等级名，悬停显示中文叫法），推断 / 兜底来的在标签旁标徽标；
 * 没选模型时跟随会话模型，读不到档位时只显示不能选
 */
function ThinkingField({
  id,
  role,
  state,
  error,
  disabled,
  onChange,
}: {
  id: string;
  role: Role;
  state: Exclude<RoleThinking, { kind: 'unsupported' }>;
  /** 最近一次读档位失败的原因 */
  error: string | null;
  disabled: boolean;
  onChange: (role: Role) => void;
}) {
  const t = useT();
  if (state.kind !== 'levels') {
    const current = role.model?.thinking;
    const shown =
      state.kind === 'follow-session'
        ? t('settings.roles.followSession')
        : current
          ? t(`thinking.levels.${current}`)
          : t('common.default');
    return (
      <Field label={t('thinking.title')} htmlFor={id} hint={unknownThinkingHint(state, error, t)}>
        <Select value={null} disabled>
          <SelectTrigger id={id}>
            <SelectValue placeholder={shown} />
          </SelectTrigger>
        </Select>
      </Field>
    );
  }

  const items = thinkingOptions(state.levels, state.defaultThinking, t);
  return (
    <Field
      label={
        <span className="inline-flex items-center gap-1.5">
          {t('thinking.title')}
          <ThinkingSourceBadge source={state.source} />
        </span>
      }
      htmlFor={id}
    >
      <Select
        items={items}
        value={state.value}
        disabled={disabled}
        onValueChange={(value) => {
          if (role.model && isThinkingLevel(value)) {
            onChange({ ...role, model: { ...role.model, thinking: value } });
          }
        }}
      >
        <SelectTrigger id={id} title={t(`thinking.hints.${state.value}`)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value} title={item.hint}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** 读不到档位时下拉下方的提示：读取中、读取失败（带原因）、读不到（原因悬停） */
function unknownThinkingHint(
  state: Exclude<RoleThinking, { kind: 'unsupported' | 'levels' }>,
  error: string | null,
  t: T
) {
  if (state.kind === 'follow-session') return undefined;
  if (state.reason === 'failed') return t('settings.roles.levelsFailed', { error: error ?? '' });
  if (state.reason === 'loading') return t('common.loading');
  return (
    <span title={t('settings.roles.levelsUnavailableHint')}>
      {t('settings.roles.levelsUnavailable')}
    </span>
  );
}

function InstructionField({
  role,
  disabled,
  onChange,
}: {
  role: Role;
  disabled: boolean;
  onChange(role: Role): void;
}) {
  const t = useT();
  const id = useId();
  const entries = useInstructionsStore((state) => state.entries);
  const refresh = useInstructionsStore((state) => state.refresh);
  const error = useInstructionsStore((state) => state.error);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Sentinel values contain ':' so they cannot collide with registry IDs.
  const current =
    role.instructionFileId === undefined
      ? ':global'
      : role.instructionFileId === null
        ? ':none'
        : role.instructionFileId;
  const items = [
    { value: ':global', label: t('settings.instructions.followGlobal') },
    { value: ':none', label: t('settings.instructions.noInstructions') },
    ...entries.map((entry) => ({ value: entry.id, label: entry.name })),
  ];
  if (role.instructionFileId && !entries.some((entry) => entry.id === role.instructionFileId)) {
    items.push({
      value: role.instructionFileId,
      label: `${role.instructionFileId} (${t('settings.roles.removedEntry')})`,
    });
  }
  return (
    <Field
      label={t('settings.instructions.title')}
      htmlFor={id}
      hint={error ?? t('settings.instructions.roleHint')}
    >
      <Select
        items={items}
        value={current}
        disabled={disabled}
        onValueChange={(value) => {
          if (typeof value !== 'string') return;
          const { instructionFileId: _old, ...rest } = role;
          onChange(
            value === ':global'
              ? rest
              : { ...rest, instructionFileId: value === ':none' ? null : value }
          );
        }}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
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
      label="settings.roles.skills"
      emptyHint="settings.roles.noSkills"
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
      label="settings.roles.mcpServers"
      emptyHint="settings.roles.noMcpServers"
      items={items}
      {...props}
    />
  );
}

/** 多选列表：每项一个开关。角色引用了但注册表里已没有的 id 也列出来（标「已移除」），方便取消。 */
function ToggleList({
  label,
  emptyHint,
  items,
  selected,
  disabled,
  onChange,
}: {
  label: MessageId;
  emptyHint: MessageId;
  items: ToggleItem[];
  selected: string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  const t = useT();
  const known = new Set(items.map((item) => item.id));
  const rows: ToggleItem[] = [
    ...items,
    ...selected.filter((id) => !known.has(id)).map((id) => ({ id, name: id, missing: true })),
  ];
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...selected, id] : selected.filter((existing) => existing !== id));

  return (
    <div className="grid min-w-0 content-start gap-2">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">{t(label)}</span>
        <span className="text-muted-foreground text-xs">
          {t('settings.roles.selected', { count: selected.length })}
        </span>
      </div>
      <ul className="max-h-56 divide-y overflow-y-auto rounded-md border">
        {rows.length === 0 && (
          <li className="px-3 py-4 text-center text-muted-foreground text-xs">{t(emptyHint)}</li>
        )}
        {rows.map((item) => (
          <li key={item.id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-sm">
                <span className="truncate">{item.name}</span>
                {item.inactive && <Badge variant="outline">{t('common.disabled')}</Badge>}
                {item.missing && (
                  <Badge variant="destructive">{t('settings.roles.removedEntry')}</Badge>
                )}
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
              aria-label={t('common.labeled', { label: t(label), text: item.name })}
              onCheckedChange={(on) => toggle(item.id, on)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
