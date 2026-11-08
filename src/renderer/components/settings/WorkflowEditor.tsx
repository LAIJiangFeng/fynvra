import {
  DEFAULT_WORKFLOW_MAX_ROUNDS,
  findWorkflowCycle,
  WORKER_ROLE_ID,
  WORKFLOW_LIMITS,
  type Workflow,
  type WorkflowPosition,
  type WorkflowStep,
  workflowAncestors,
  workflowChildren,
  workflowParents,
  workflowTopologicalOrder,
} from '@fynvra/core';
import { errorMessage } from '@shared/guards';
import { ArrowLeft, Plus, Save, Trash2, TriangleAlert } from 'lucide-react';
import { type FormEvent, useCallback, useId, useMemo, useRef, useState } from 'react';
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
import {
  connectNodes,
  nextNodeId,
  placeNewNode,
  removeEdges,
  removeNodes,
  withPositions,
} from '@/components/workflows/editing';
import { clampPosition } from '@/components/workflows/layout';
import { type WorkflowEdgeRef, WorkflowGraph } from '@/components/workflows/WorkflowGraph';
import type { T } from '@/i18n';
import { useT } from '@/i18n/I18nProvider';
import { confirmDialog } from '@/lib/appDialog';
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

export type WorkflowTemplate = 'blank' | 'linear' | 'parallel';
export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = ['blank', 'linear', 'parallel'];

/**
 * 新建时的模板。id 在保存时按名称生成（纯中文名回退到这里的 id）。
 * - blank：一个空节点
 * - linear：开发 → 测试 → 审核，测试、审核失败退回开发
 * - parallel：开发 → (测试 ‖ 安全审查) → 验收，三者失败都退回开发
 */
export function templateWorkflow(
  kind: WorkflowTemplate,
  t: T,
  takenIds: readonly string[]
): Workflow {
  const node = (
    id: string,
    name: string,
    instructions: string,
    needs: string[],
    onFail?: string
  ): WorkflowStep => ({
    id,
    name,
    roleId: DEFAULT_ROLE_ID,
    instructions,
    needs,
    ...(onFail ? { onFail } : {}),
  });
  if (kind === 'linear') {
    const p = 'settings.workflows.preset' as const;
    return {
      id: uniqueId('dev-test-review', takenIds),
      name: t(`${p}.name`),
      description: t(`${p}.description`),
      steps: [
        node('develop', t(`${p}.develop`), t(`${p}.developInstructions`), []),
        node('test', t(`${p}.test`), t(`${p}.testInstructions`), ['develop'], 'develop'),
        node('review', t(`${p}.review`), t(`${p}.reviewInstructions`), ['test'], 'develop'),
      ],
      maxRounds: DEFAULT_WORKFLOW_MAX_ROUNDS,
    };
  }
  if (kind === 'parallel') {
    const p = 'settings.workflows.parallelPreset' as const;
    return {
      id: uniqueId('dev-test-security-accept', takenIds),
      name: t(`${p}.name`),
      description: t(`${p}.description`),
      steps: [
        node('develop', t(`${p}.develop`), t(`${p}.developInstructions`), []),
        node('test', t(`${p}.test`), t(`${p}.testInstructions`), ['develop'], 'develop'),
        node(
          'security',
          t(`${p}.security`),
          t(`${p}.securityInstructions`),
          ['develop'],
          'develop'
        ),
        node(
          'accept',
          t(`${p}.accept`),
          t(`${p}.acceptInstructions`),
          ['test', 'security'],
          'develop'
        ),
      ],
      maxRounds: DEFAULT_WORKFLOW_MAX_ROUNDS,
    };
  }
  return {
    id: uniqueId('workflow', takenIds),
    name: '',
    steps: [node('step-1', t('settings.workflows.defaultNodeName'), '', [])],
    maxRounds: DEFAULT_WORKFLOW_MAX_ROUNDS,
  };
}

/** 编辑器里的草稿：节点总是带 position（缺失的先自动排版补齐）。 */
function toDraft(workflow: Workflow): Workflow {
  return { ...workflow, steps: withPositions(workflow.steps) };
}

/** 发给 Main 前整理：去掉空的可选字段，写入 needs 与 position；新建的工作流按名称生成 id。 */
function toSavable(draft: Workflow, isNew: boolean, takenIds: readonly string[]): Workflow {
  const description = draft.description?.trim();
  const id = isNew
    ? uniqueId(
        toSlug(draft.name, draft.id),
        takenIds.filter((taken) => taken !== draft.id)
      )
    : draft.id;
  const ordered = workflowTopologicalOrder(draft.steps) ?? draft.steps;
  return {
    id,
    name: draft.name,
    ...(description ? { description } : {}),
    steps: ordered.map(({ id: stepId, name, roleId, instructions, needs, position, onFail }) => ({
      id: stepId,
      name,
      roleId,
      instructions,
      needs: [...needs],
      ...(position ? { position: clampPosition(position) } : {}),
      ...(onFail ? { onFail } : {}),
    })),
    maxRounds: draft.maxRounds,
  };
}

interface Issue {
  text: string;
  stepId?: string;
}

/** 前端基础校验（Main 保存时还会用 parseWorkflow 完整校验）。 */
function validate(draft: Workflow, t: T): Issue[] {
  const issues: Issue[] = [];
  if (!draft.name.trim()) issues.push({ text: t('settings.workflows.issues.nameRequired') });
  const { maxRoundsMin: min, maxRoundsMax: max } = WORKFLOW_LIMITS;
  if (!Number.isInteger(draft.maxRounds) || draft.maxRounds < min || draft.maxRounds > max) {
    issues.push({ text: t('settings.workflows.issues.maxRounds', { min, max }) });
  }
  if (draft.steps.length < WORKFLOW_LIMITS.stepsMin) {
    issues.push({ text: t('settings.workflows.issues.noNodes') });
  }
  if (draft.steps.length > WORKFLOW_LIMITS.stepsMax) {
    issues.push({
      text: t('settings.workflows.issues.tooMany', { max: WORKFLOW_LIMITS.stepsMax }),
    });
  }
  for (const step of draft.steps) {
    if (!step.name.trim()) {
      issues.push({
        text: t('settings.workflows.issues.nodeNameRequired', { id: step.id }),
        stepId: step.id,
      });
    }
    if (!step.instructions.trim()) {
      issues.push({
        text: t('settings.workflows.issues.nodeInstructionsRequired', {
          name: step.name.trim() || step.id,
        }),
        stepId: step.id,
      });
    }
  }
  const cycle = findWorkflowCycle(draft.steps);
  if (cycle) {
    const names = new Map(draft.steps.map((step) => [step.id, step.name || step.id]));
    const path = [...cycle, cycle[0]].map((id) => names.get(id ?? '') ?? id).join(' → ');
    issues.push({ text: t('settings.workflows.issues.cycle', { path }) });
  }
  return issues;
}

type Notice = { tone: 'error' | 'muted'; text: string };

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
  // 基准也补齐 position：旧数据自动排版本身不算修改
  const [base] = useState(() => toDraft(initial));
  /** 确认框（放弃修改 / 删除节点）是否正打开 */
  const confirming = useRef(false);
  const [draft, setDraft] = useState<Workflow>(base);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roles = useRolesStore((state) => state.roles);
  const rolesLoaded = useRolesStore((state) => state.loaded);
  const id = useId();
  const t = useT();

  const changed = JSON.stringify(draft) !== JSON.stringify(base);
  const dirty = isNew || changed;
  const issues = useMemo(() => validate(draft, t), [draft, t]);
  const blockedReason = saving
    ? null
    : issues.length > 0
      ? t('settings.workflows.saveBlocked', { count: issues.length })
      : !dirty
        ? t('settings.workflows.noChanges')
        : null;
  const canSave = !saving && dirty && issues.length === 0;

  const roleNames = useMemo<Record<string, string>>(
    () =>
      rolesLoaded
        ? Object.fromEntries(roles.map((role) => [role.id, role.name]))
        : // 角色还没加载时不误报「不存在」
          Object.fromEntries(draft.steps.map((step) => [step.roleId, step.roleId])),
    [roles, rolesLoaded, draft.steps]
  );
  const orchestratorIds = useMemo(
    () => new Set(roles.filter((role) => role.tools === 'orchestrator').map((role) => role.id)),
    [roles]
  );

  const setSteps = useCallback(
    (update: (steps: WorkflowStep[]) => WorkflowStep[]) =>
      setDraft((current) => ({ ...current, steps: update(current.steps) })),
    []
  );

  const reportCleared = (cleared: number) =>
    setNotice(
      cleared > 0
        ? { tone: 'muted', text: t('settings.workflows.failCleared', { count: cleared }) }
        : null
    );

  const updateStep = (stepId: string, patch: Partial<WorkflowStep>) =>
    setSteps((steps) => steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step)));

  const handleMove = useCallback(
    (positions: Record<string, WorkflowPosition>) =>
      setSteps((steps) =>
        steps.map((step) => {
          const position = positions[step.id];
          return position ? { ...step, position } : step;
        })
      ),
    [setSteps]
  );

  const handleConnect = (source: string, target: string) => {
    const result = connectNodes(draft.steps, source, target);
    if (result.ok) {
      setDraft({ ...draft, steps: result.steps });
      setNotice(null);
      return;
    }
    const name = (stepId: string) => draft.steps.find((step) => step.id === stepId)?.name ?? stepId;
    if (result.reason === 'missing') return;
    setNotice({
      tone: 'error',
      text:
        result.reason === 'self'
          ? t('settings.workflows.connectSelf')
          : result.reason === 'duplicate'
            ? t('settings.workflows.connectDuplicate')
            : t('settings.workflows.connectCycle', { from: name(source), to: name(target) }),
    });
  };

  const deleteElements = async (nodeIds: string[], edges: WorkflowEdgeRef[]) => {
    if (confirming.current) return;
    if (nodeIds.length > 0) {
      const names = draft.steps
        .filter((step) => nodeIds.includes(step.id))
        .map((step) => step.name || step.id);
      const message =
        names.length === 1
          ? t('settings.workflows.deleteNodeConfirm', { name: names[0] ?? '' })
          : t('settings.workflows.deleteNodesConfirm', { count: names.length });
      confirming.current = true;
      try {
        const confirmed = await confirmDialog({
          message,
          confirmLabel: t('common.delete'),
          destructive: true,
        });
        if (!confirmed) return;
      } finally {
        confirming.current = false;
      }
    }
    let cleared = 0;
    let steps = draft.steps;
    if (edges.length > 0) {
      const result = removeEdges(steps, edges);
      steps = result.steps;
      cleared += result.cleared;
    }
    if (nodeIds.length > 0) {
      const result = removeNodes(steps, nodeIds);
      steps = result.steps;
      cleared += result.cleared;
      if (selectedId && nodeIds.includes(selectedId)) setSelectedId(null);
    }
    setDraft({ ...draft, steps });
    reportCleared(cleared);
  };

  const addNode = () => {
    if (draft.steps.length >= WORKFLOW_LIMITS.stepsMax) return;
    const step: WorkflowStep = {
      id: nextNodeId(draft.steps),
      name: t('settings.workflows.defaultNodeName'),
      roleId: DEFAULT_ROLE_ID,
      instructions: '',
      needs: [],
      position: placeNewNode(draft.steps, selectedId),
    };
    setDraft({ ...draft, steps: [...draft.steps, step] });
    setSelectedId(step.id);
    setNotice(null);
  };

  // 确认框打开期间再按 Esc / 「返回」不重复弹窗
  const cancel = async () => {
    if (confirming.current) return;
    if (changed) {
      confirming.current = true;
      try {
        const discard = await confirmDialog({
          message: t('settings.workflows.discardConfirm'),
          confirmLabel: t('files.discard'),
          destructive: true,
        });
        if (!discard) return;
      } finally {
        confirming.current = false;
      }
    }
    onCancel();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
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

  const selected = draft.steps.find((step) => step.id === selectedId);
  const atLimit = draft.steps.length >= WORKFLOW_LIMITS.stepsMax;

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        // 设置页把 Esc 当成关闭：有选中先取消选中；有未保存的修改时走「返回」的确认流程，
        // 不让它冒泡到设置页；都没有时保持原行为。经 Portal 渲染的弹窗、下拉自己处理 Esc。
        if (event.key !== 'Escape' || !event.currentTarget.contains(event.target as Node)) return;
        if (selectedId) {
          event.stopPropagation();
          setSelectedId(null);
          return;
        }
        if (dirty) {
          event.stopPropagation();
          if (!saving) void cancel();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => void cancel()}>
          <ArrowLeft />
          {t('settings.workflows.back')}
        </Button>
        <h3 className="min-w-0 flex-1 truncate font-medium">
          {t(isNew ? 'settings.workflows.newTitle' : 'settings.workflows.editTitle')}
        </h3>
        {blockedReason && (
          <span className="text-muted-foreground text-xs" aria-live="polite">
            {blockedReason}
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={saving}
          onClick={() => void cancel()}
        >
          {t('common.cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={!canSave} title={blockedReason ?? undefined}>
          <Save />
          {t(saving ? 'common.saving' : 'common.save')}
        </Button>
      </div>

      {error && (
        <InlineMessage tone="error" className="break-all">
          {t('settings.workflows.saveFailed', { error })}
        </InlineMessage>
      )}

      {issues.length > 0 && (
        <ul className="grid gap-1 rounded-lg border border-dashed px-3 py-2 text-xs">
          {issues.map((issue) => (
            <li
              key={`${issue.stepId ?? ''}:${issue.text}`}
              className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400"
            >
              <TriangleAlert className="size-3.5 shrink-0" />
              {issue.stepId ? (
                <button
                  type="button"
                  className="text-left underline-offset-2 hover:underline"
                  onClick={() => setSelectedId(issue.stepId ?? null)}
                >
                  {issue.text}
                </button>
              ) : (
                <span>{issue.text}</span>
              )}
            </li>
          ))}
        </ul>
      )}

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

      <div className="grid gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-medium text-sm">{t('settings.workflows.canvas')}</span>
          <span className="text-muted-foreground text-xs">
            {t('settings.workflows.canvasHint')}
          </span>
        </div>
        {notice && (
          <InlineMessage tone={notice.tone} className="break-all">
            {notice.text}
          </InlineMessage>
        )}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="h-[max(28rem,calc(100vh-24rem))] min-w-0 overflow-hidden rounded-lg border bg-muted/30">
            <WorkflowGraph
              steps={draft.steps}
              roleNames={roleNames}
              invalidRoleIds={orchestratorIds}
              editable={!saving}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onMove={handleMove}
              onConnect={handleConnect}
              onDelete={({ nodeIds, edges }) => void deleteElements(nodeIds, edges)}
              toolbar={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="bg-card"
                  disabled={atLimit}
                  title={
                    atLimit
                      ? t('settings.workflows.nodeLimit', { max: WORKFLOW_LIMITS.stepsMax })
                      : undefined
                  }
                  onClick={addNode}
                >
                  <Plus />
                  {t('settings.workflows.addNode')}
                </Button>
              }
            />
          </div>
          <aside className="min-w-0 rounded-lg border p-4 lg:max-h-[max(28rem,calc(100vh-24rem))] lg:overflow-y-auto">
            {selected ? (
              <NodeInspector
                key={selected.id}
                id={`${id}-node`}
                step={selected}
                steps={draft.steps}
                disabled={saving}
                onChange={(patch) => updateStep(selected.id, patch)}
                onSelect={setSelectedId}
                onRemove={() => void deleteElements([selected.id], [])}
              />
            ) : (
              <p className="text-muted-foreground text-sm">{t('settings.workflows.node.empty')}</p>
            )}
          </aside>
        </div>
      </div>
    </form>
  );
}

const NO_FALLBACK = '';

function NodeInspector({
  id,
  step,
  steps,
  disabled,
  onChange,
  onSelect,
  onRemove,
}: {
  id: string;
  step: WorkflowStep;
  steps: readonly WorkflowStep[];
  disabled: boolean;
  onChange: (patch: Partial<WorkflowStep>) => void;
  onSelect: (id: string) => void;
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

  const byId = new Map(steps.map((other) => [other.id, other]));
  const label = (stepId: string) => byId.get(stepId)?.name.trim() || stepId;
  const ancestors = workflowAncestors(steps, step.id);
  const ordered = workflowTopologicalOrder(steps) ?? steps;
  const failItems = [
    { value: NO_FALLBACK, label: t('settings.workflows.noFallback') },
    { value: step.id, label: t('settings.workflows.node.failSelf') },
    // 只能退回到祖先节点（按拓扑序列出）
    ...ordered
      .filter((other) => ancestors.has(other.id))
      .map((other) => ({ value: other.id, label: label(other.id) })),
  ];
  const parents = workflowParents(steps, step.id);
  const children = workflowChildren(steps, step.id);

  const links = (ids: string[]) =>
    ids.length === 0 ? (
      <span className="text-muted-foreground">{t('settings.workflows.node.none')}</span>
    ) : (
      <span className="flex flex-wrap gap-1">
        {ids.map((other) => (
          <button
            key={other}
            type="button"
            className="rounded border px-1.5 py-0.5 hover:bg-accent"
            onClick={() => onSelect(other)}
          >
            {label(other)}
          </button>
        ))}
      </span>
    );

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-sm">
          {t('settings.workflows.node.title')}
        </span>
        <code className="truncate text-muted-foreground text-xs">{step.id}</code>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('settings.workflows.node.remove')}
          title={t('settings.workflows.node.remove')}
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>

      <Field label={t('settings.workflows.node.name')} htmlFor={`${id}-name`}>
        <Input
          id={`${id}-name`}
          value={step.name}
          maxLength={WORKFLOW_LIMITS.nameMax}
          disabled={disabled}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </Field>

      <Field label={t('settings.workflows.node.role')} htmlFor={`${id}-role`}>
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
        {roleWarning && (
          <p className="flex items-center gap-1.5 text-amber-600 text-xs dark:text-amber-400">
            <TriangleAlert className="size-3.5 shrink-0" />
            {roleWarning}
          </p>
        )}
      </Field>

      <Field
        label={t('settings.workflows.node.instructions')}
        htmlFor={`${id}-instructions`}
        hint={t('settings.workflows.node.instructionsHint')}
      >
        <Textarea
          id={`${id}-instructions`}
          rows={6}
          value={step.instructions}
          maxLength={WORKFLOW_LIMITS.instructionsMax}
          disabled={disabled}
          className="max-h-[40vh] min-h-28"
          onChange={(event) => onChange({ instructions: event.target.value })}
        />
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

      <div className="grid gap-2 text-xs">
        <div className="grid gap-1">
          <span className="font-medium">{t('settings.workflows.node.upstream')}</span>
          {links(parents)}
        </div>
        <div className="grid gap-1">
          <span className="font-medium">{t('settings.workflows.node.downstream')}</span>
          {links(children)}
        </div>
      </div>
    </div>
  );
}
