import {
  DEFAULT_WORKFLOW_MAX_ROUNDS,
  WORKER_ROLE_ID,
  WORKFLOW_LIMITS,
  type Workflow,
  type WorkflowStep,
} from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import { ArrowDown, ArrowLeft, ArrowUp, Plus, Save, Trash2, TriangleAlert } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { T } from '@/i18n';
import { useT } from '@/i18n/I18nProvider';
import { useRolesStore } from '@/stores/roles';
import { Field, InlineMessage } from './common';

const DEFAULT_ROLE_ID = WORKER_ROLE_ID;

/** 名称 → slug 候选；规整后为空（如纯中文）时用 fallback。与 Main 注册表 id 同一规则。 */
function toSlug(text: string, fallback: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return slug || fallback;
}

function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

/** 空白工作流：一步，id 在保存时按名称生成。 */
export function blankWorkflow(t: T, takenIds: readonly string[]): Workflow {
  return {
    id: uniqueId('workflow', takenIds),
    name: '',
    steps: [
      {
        id: 'step-1',
        name: t('settings.workflows.defaultStepName'),
        roleId: DEFAULT_ROLE_ID,
        instructions: '',
      },
    ],
    maxRounds: DEFAULT_WORKFLOW_MAX_ROUNDS,
  };
}

/** 预设「开发 → 测试 → 审核」：测试、审核失败时退回开发，最多退回 3 次。 */
export function presetWorkflow(t: T, takenIds: readonly string[]): Workflow {
  return {
    id: uniqueId('dev-test-review', takenIds),
    name: t('settings.workflows.preset.name'),
    description: t('settings.workflows.preset.description'),
    steps: [
      {
        id: 'develop',
        name: t('settings.workflows.preset.develop'),
        roleId: DEFAULT_ROLE_ID,
        instructions: t('settings.workflows.preset.developInstructions'),
      },
      {
        id: 'test',
        name: t('settings.workflows.preset.test'),
        roleId: DEFAULT_ROLE_ID,
        instructions: t('settings.workflows.preset.testInstructions'),
        onFail: 'develop',
      },
      {
        id: 'review',
        name: t('settings.workflows.preset.review'),
        roleId: DEFAULT_ROLE_ID,
        instructions: t('settings.workflows.preset.reviewInstructions'),
        onFail: 'develop',
      },
    ],
    maxRounds: DEFAULT_WORKFLOW_MAX_ROUNDS,
  };
}

/** 发给 Main 前整理：去掉空的可选字段；新建的工作流按名称生成 id。 */
function toSavable(draft: Workflow, isNew: boolean, takenIds: readonly string[]): Workflow {
  const description = draft.description?.trim();
  const id = isNew
    ? uniqueId(
        toSlug(draft.name, draft.id),
        takenIds.filter((taken) => taken !== draft.id)
      )
    : draft.id;
  return {
    id,
    name: draft.name,
    ...(description ? { description } : {}),
    steps: draft.steps.map(({ onFail, ...step }) => ({
      ...step,
      ...(onFail ? { onFail } : {}),
    })),
    maxRounds: draft.maxRounds,
  };
}

export function WorkflowEditor({
  initial,
  isNew,
  takenIds,
  onCancel,
  onSaved,
}: {
  initial: Workflow;
  isNew: boolean;
  takenIds: readonly string[];
  onCancel: () => void;
  onSaved: (workflow: Workflow) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<Workflow>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const t = useT();
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  const dirty = isNew || changed;

  const updateStep = (index: number, patch: Partial<WorkflowStep>) =>
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    }));

  const moveStep = (index: number, offset: -1 | 1) =>
    setDraft((current) => {
      const target = index + offset;
      const a = current.steps[index];
      const b = current.steps[target];
      if (!a || !b) return current;
      return { ...current, steps: current.steps.with(index, b).with(target, a) };
    });

  const removeStep = (index: number) =>
    setDraft((current) => {
      const removed = current.steps[index];
      if (!removed || current.steps.length <= WORKFLOW_LIMITS.stepsMin) return current;
      // 指向被删步骤的「失败时退回」一并清掉
      const steps = current.steps
        .filter((_, i) => i !== index)
        .map(({ onFail, ...step }) =>
          onFail && onFail !== removed.id ? { ...step, onFail } : step
        );
      return { ...current, steps };
    });

  const addStep = () =>
    setDraft((current) => {
      if (current.steps.length >= WORKFLOW_LIMITS.stepsMax) return current;
      const taken = current.steps.map((step) => step.id);
      let n = current.steps.length + 1;
      while (taken.includes(`step-${n}`)) n += 1;
      const step: WorkflowStep = {
        id: `step-${n}`,
        name: t('settings.workflows.defaultStepName'),
        roleId: DEFAULT_ROLE_ID,
        instructions: '',
      };
      return { ...current, steps: [...current.steps, step] };
    });

  const cancel = () => {
    if (changed && !window.confirm(t('settings.workflows.discardConfirm'))) return;
    onCancel();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await window.fynvra.workflows.save(toSavable(draft, isNew, takenIds));
      if (result.ok) {
        await onSaved(result.workflow);
        return;
      }
      setError(result.error);
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setSaving(false);
  };

  return (
    <form className="grid gap-5" onSubmit={(event) => void submit(event)}>
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={cancel}>
          <ArrowLeft />
          {t('settings.workflows.back')}
        </Button>
        <h3 className="min-w-0 truncate font-medium">
          {t(isNew ? 'settings.workflows.newTitle' : 'settings.workflows.editTitle')}
        </h3>
      </div>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <Field label={t('settings.workflows.name')} htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            value={draft.name}
            maxLength={WORKFLOW_LIMITS.nameMax}
            disabled={saving}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </Field>
        <Field
          label={t('settings.workflows.maxRounds')}
          htmlFor={`${id}-rounds`}
          hint={t('settings.workflows.maxRoundsHint', {
            min: WORKFLOW_LIMITS.maxRoundsMin,
            max: WORKFLOW_LIMITS.maxRoundsMax,
          })}
        >
          <Input
            id={`${id}-rounds`}
            type="number"
            min={WORKFLOW_LIMITS.maxRoundsMin}
            max={WORKFLOW_LIMITS.maxRoundsMax}
            step={1}
            value={Number.isNaN(draft.maxRounds) ? '' : draft.maxRounds}
            disabled={saving}
            onChange={(event) =>
              setDraft({
                ...draft,
                maxRounds: event.target.value === '' ? Number.NaN : Number(event.target.value),
              })
            }
          />
        </Field>
      </div>

      <Field label={t('settings.workflows.description')} htmlFor={`${id}-description`}>
        <Input
          id={`${id}-description`}
          value={draft.description ?? ''}
          maxLength={WORKFLOW_LIMITS.descriptionMax}
          placeholder={t('settings.workflows.descriptionPlaceholder')}
          disabled={saving}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </Field>

      <div className="grid gap-3">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-sm">{t('settings.workflows.steps')}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={saving || draft.steps.length >= WORKFLOW_LIMITS.stepsMax}
            onClick={addStep}
          >
            <Plus />
            {t('settings.workflows.addStep')}
          </Button>
        </div>
        <ol className="grid gap-3">
          {draft.steps.map((step, index) => (
            <StepEditor
              key={step.id}
              id={`${id}-step-${step.id}`}
              step={step}
              index={index}
              steps={draft.steps}
              disabled={saving}
              onChange={(patch) => updateStep(index, patch)}
              onMove={(offset) => moveStep(index, offset)}
              onRemove={() => removeStep(index)}
            />
          ))}
        </ol>
      </div>

      {error && (
        <InlineMessage tone="error" className="break-all">
          {error}
        </InlineMessage>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <Button type="submit" disabled={saving || !dirty}>
          <Save />
          {t(saving ? 'common.saving' : 'common.save')}
        </Button>
        <Button type="button" variant="outline" disabled={saving} onClick={cancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

function StepEditor({
  id,
  step,
  index,
  steps,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  id: string;
  step: WorkflowStep;
  index: number;
  steps: readonly WorkflowStep[];
  disabled: boolean;
  onChange: (patch: Partial<WorkflowStep>) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  const roles = useRolesStore((state) => state.roles);
  const rolesLoaded = useRolesStore((state) => state.loaded);
  const t = useT();

  const executable = roles.filter((role) => role.tools !== 'orchestrator');
  const current = roles.find((role) => role.id === step.roleId);
  const roleWarning = !rolesLoaded
    ? null
    : !current
      ? t('settings.workflows.roleMissing', { id: step.roleId })
      : current.tools === 'orchestrator'
        ? t('settings.workflows.roleOrchestrator', { name: current.name })
        : null;
  const roleItems = [
    ...executable.map((role) => ({ value: role.id, label: role.name })),
    // 引用的角色不存在或不可执行时仍列出，保持当前选择可见
    ...(current && current.tools !== 'orchestrator'
      ? []
      : [{ value: step.roleId, label: current?.name ?? step.roleId }]),
  ];

  const NO_FALLBACK = '';
  const failItems = [
    { value: NO_FALLBACK, label: t('settings.workflows.noFallback') },
    ...steps.map((other, i) => ({
      value: other.id,
      label: t('settings.workflows.stepLabel', { n: i + 1, name: other.name }),
    })),
  ];

  return (
    <li className="grid gap-3 rounded-lg border p-4">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate font-medium text-muted-foreground text-xs">
          {t('settings.workflows.stepNumber', { n: index + 1 })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('settings.workflows.moveUp')}
          title={t('settings.workflows.moveUp')}
          disabled={disabled || index === 0}
          onClick={() => onMove(-1)}
        >
          <ArrowUp />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('settings.workflows.moveDown')}
          title={t('settings.workflows.moveDown')}
          disabled={disabled || index === steps.length - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDown />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('settings.workflows.removeStep')}
          title={t('settings.workflows.removeStep')}
          disabled={disabled || steps.length <= WORKFLOW_LIMITS.stepsMin}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t('settings.workflows.stepName')} htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            value={step.name}
            maxLength={WORKFLOW_LIMITS.nameMax}
            disabled={disabled}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </Field>
        <Field label={t('settings.workflows.stepRole')} htmlFor={`${id}-role`}>
          <Select
            items={roleItems}
            value={step.roleId}
            disabled={disabled}
            onValueChange={(value) => {
              if (typeof value === 'string' && value) onChange({ roleId: value });
            }}
          >
            <SelectTrigger id={`${id}-role`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roleItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('settings.workflows.onFail')} htmlFor={`${id}-fail`}>
          <Select
            items={failItems}
            value={step.onFail ?? NO_FALLBACK}
            disabled={disabled}
            onValueChange={(value) => {
              if (typeof value === 'string') onChange({ onFail: value || undefined });
            }}
          >
            <SelectTrigger id={`${id}-fail`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {failItems.map((item) => (
                <SelectItem key={item.value || 'none'} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      {roleWarning && (
        <p className="flex items-center gap-1.5 text-amber-600 text-xs dark:text-amber-400">
          <TriangleAlert className="size-3.5 shrink-0" />
          {roleWarning}
        </p>
      )}

      <Field
        label={t('settings.workflows.stepInstructions')}
        htmlFor={`${id}-instructions`}
        hint={t('settings.workflows.stepInstructionsHint')}
      >
        <Textarea
          id={`${id}-instructions`}
          rows={4}
          value={step.instructions}
          maxLength={WORKFLOW_LIMITS.instructionsMax}
          disabled={disabled}
          className="max-h-[40vh] min-h-24"
          onChange={(event) => onChange({ instructions: event.target.value })}
        />
      </Field>
    </li>
  );
}
