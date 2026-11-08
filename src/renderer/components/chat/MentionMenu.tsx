import { summarizeWorkflow } from '@fynvra/core';
import { type RefObject, useLayoutEffect, useMemo, useRef } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { useWorkflowsStore } from '@/stores/workflows';
import { type MentionKind, type MentionTarget, splitMentions } from './mentions';
import { isOrchestratorRole, roleDescription, useRoles } from './roles';

/** 菜单里的一项：工作流带流程摘要，角色带模型或说明 */
export interface MentionOption extends MentionTarget {
  detail?: string;
}

/** 可引用的工作流与非编排角色；`enabled` 为 false 时返回空列表 */
export function useMentionOptions(enabled: boolean): {
  options: MentionOption[];
  workflowsLoaded: boolean;
} {
  const t = useT();
  const roles = useRoles();
  const workflows = useWorkflowsStore((state) => state.workflows);
  const workflowsLoaded = useWorkflowsStore((state) => state.loaded);
  const options = useMemo(() => {
    if (!enabled) return [];
    const workflowOptions = workflows.map(
      (workflow): MentionOption => ({
        kind: 'workflow',
        id: workflow.id,
        name: workflow.name,
        detail: summarizeWorkflow(workflow.steps),
      })
    );
    const roleOptions = roles
      .filter((role) => !isOrchestratorRole(role.id, roles))
      .map(
        (role): MentionOption => ({
          kind: 'role',
          id: role.id,
          name: role.name,
          detail: role.model
            ? `${role.model.providerId}/${role.model.modelId}`
            : roleDescription(role, t),
        })
      );
    return [...workflowOptions, ...roleOptions];
  }, [enabled, workflows, roles, t]);
  return { options, workflowsLoaded };
}

const KIND_CLASS: Record<MentionKind, string> = {
  workflow: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  role: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
};

/** 输入框上方的候选列表。焦点始终留在输入框：鼠标按下不抢焦点，键盘由 Composer 处理 */
export function MentionMenu({
  id,
  kind,
  options,
  activeIndex,
  onPick,
  onHover,
}: {
  id: string;
  kind: MentionKind;
  options: readonly MentionOption[];
  activeIndex: number;
  onPick: (option: MentionOption) => void;
  onHover: (index: number) => void;
}) {
  const t = useT();
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);
  return (
    <div className="absolute right-0 bottom-full left-0 z-30 mb-2 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md">
      <div className="px-3 pt-2 pb-1 text-muted-foreground text-xs">
        {t(kind === 'workflow' ? 'chat.mentionWorkflows' : 'chat.mentionRoles')}
      </div>
      {options.length === 0 ? (
        <p className="px-3 pb-2 text-muted-foreground text-xs">
          {t(kind === 'workflow' ? 'chat.mentionNoWorkflows' : 'chat.mentionNoRoles')}
        </p>
      ) : (
        <div
          ref={list}
          id={id}
          role="listbox"
          aria-label={t(kind === 'workflow' ? 'chat.mentionWorkflows' : 'chat.mentionRoles')}
          className="max-h-60 overflow-y-auto p-1"
        >
          {options.map((option, index) => (
            <div
              key={option.id}
              id={`${id}-${index}`}
              data-index={index}
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => {
                if (index !== activeIndex) onHover(index);
              }}
              onClick={() => onPick(option)}
              onKeyDown={() => undefined}
              className={cn(
                'flex cursor-default items-baseline gap-2 rounded-md px-2 py-1.5 text-sm',
                index === activeIndex && 'bg-accent text-accent-foreground'
              )}
            >
              <span className="shrink-0 font-medium">{option.name}</span>
              {option.detail && (
                <span className="min-w-0 truncate text-muted-foreground text-xs">
                  {option.detail}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 消息与输入框里的引用标签样式 */
export function MentionBadge({ target, text }: { target: MentionTarget; text: string }) {
  return (
    <span
      title={target.id}
      className={cn('rounded px-1 py-0.5 font-medium text-[0.9em]', KIND_CLASS[target.kind])}
    >
      {text}
    </span>
  );
}

/** 用户消息正文：已知引用显示成标签，文字本身不变 */
export function MentionText({
  text,
  targets,
}: {
  text: string;
  targets: readonly MentionTarget[];
}) {
  const segments = useMemo(() => splitMentions(text, targets), [text, targets]);
  return segments.map((segment, index) =>
    segment.type === 'text' ? (
      segment.text
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: 片段由文本切分而来，不会重排
      <MentionBadge key={index} target={segment.target} text={segment.text} />
    )
  );
}

/**
 * 输入框里的高亮层：与 textarea 同字体、同内边距，放在它背后；文字透明，只给已知引用画底色。
 * 随 textarea 的宽度与滚动同步；没有引用时不渲染。
 */
export function MentionHighlight({
  textarea,
  draft,
  targets,
}: {
  textarea: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  targets: readonly MentionTarget[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const segments = useMemo(() => splitMentions(draft, targets), [draft, targets]);
  const visible = segments.some((segment) => segment.type === 'mention');

  useLayoutEffect(() => {
    if (!visible) return;
    const input = textarea.current;
    const outer = box.current;
    const inner = layer.current;
    if (!input || !outer || !inner) return;
    const sync = () => {
      outer.style.width = `${input.clientWidth}px`;
      outer.style.height = `${input.clientHeight}px`;
      inner.style.transform = `translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`;
    };
    sync();
    input.addEventListener('scroll', sync, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    observer?.observe(input);
    return () => {
      observer?.disconnect();
      input.removeEventListener('scroll', sync);
    };
  });

  if (!visible) return null;
  return (
    <div
      ref={box}
      aria-hidden="true"
      className="pointer-events-none absolute top-0 left-0 z-0 overflow-hidden px-4 py-3 text-base md:text-sm"
    >
      <div ref={layer} className="whitespace-pre-wrap break-words text-transparent">
        {segments.map((segment, index) =>
          segment.type === 'text' ? (
            segment.text
          ) : (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: 片段由文本切分而来，不会重排
              key={index}
              className={cn('rounded-sm', KIND_CLASS[segment.target.kind], 'text-transparent')}
            >
              {segment.text}
            </span>
          )
        )}
      </div>
    </div>
  );
}
