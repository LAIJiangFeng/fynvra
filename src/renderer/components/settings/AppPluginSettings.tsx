import { errorMessage } from '@shared/guards';
import type {
  PluginUi,
  UiButton,
  UiField,
  UiFieldValue,
  UiList,
  UiNode,
  UiSection,
  UiTone,
} from '@shared/types/appPluginUi';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { confirmDialog } from '@/lib/appDialog';
import { cn } from '@/lib/utils';
import {
  collectValues,
  commitOn,
  currentValue,
  type Draft,
  draftKey,
  dropScope,
  shouldCommit,
  wireValue,
} from './appPluginForm';
import { type LayoutRow, layoutNodes } from './appPluginLayout';
import { InlineMessage } from './common';

const api = window.fynvra.appPlugins;

const TONE_CLASS: Record<UiTone, string> = {
  muted: 'text-muted-foreground',
  error: 'text-destructive',
  warning: 'text-amber-600 dark:text-amber-400',
  success: 'text-emerald-600 dark:text-emerald-400',
};

/** 一个容器（根、section、列表项）：草稿与错误按它的 scope 归组，按钮带上它里面的本地输入 */
interface Scope {
  scope: string;
  siblings: readonly UiNode[];
  itemKey?: string;
}

interface Form {
  pluginId: string;
  drafts: Record<string, Draft>;
  setDraft(key: string, draft: Draft | null): void;
  /** 正在进行的操作：`<scope>|<action>`；有值时所有控件禁用 */
  busy: string | null;
  errors: Record<string, string>;
  run(at: Scope, action: string, extra?: Record<string, UiFieldValue>): Promise<boolean>;
}

/**
 * Fynvra 插件的声明式设置页：读 Main 存的最新描述，用 Fynvra 自己的组件渲染；插件代码不进 Renderer。
 * 收到 appplugins:ui-changed 重新读取。用户操作经 ui-action 交给插件，插件处理完重新 render。
 */
export function AppPluginSettings({ id }: { id: string }) {
  const t = useT();
  // undefined：读取中
  const [ui, setUi] = useState<PluginUi | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const result = await api.uiGet({ id });
      if (mine !== seq.current) return;
      if (result.ok) {
        setUi(result.ui);
        setLoadError(null);
      } else setLoadError(result.error);
    } catch (error) {
      if (mine === seq.current) setLoadError(errorMessage(error));
    }
  }, [id]);

  useEffect(() => {
    void load();
    return api.onUiChanged((changed) => {
      if (changed === id) void load();
    });
  }, [id, load]);

  const form: Form = {
    pluginId: id,
    drafts,
    setDraft: (key, draft) =>
      setDrafts((current) => {
        const { [key]: _, ...rest } = current;
        return draft ? { ...rest, [key]: draft } : rest;
      }),
    busy,
    errors,
    async run(at, action, extra = {}) {
      if (busy) return false;
      setBusy(`${at.scope}|${action}`);
      setErrors(({ [at.scope]: _, ...rest }) => rest);
      let error: string | null = null;
      try {
        const result = await api.uiAction({
          id,
          action,
          ...(at.itemKey !== undefined ? { itemKey: at.itemKey } : {}),
          values: { ...collectValues(at.siblings, at.scope, drafts), ...extra },
        });
        if (!result.ok) error = result.error;
      } catch (cause) {
        error = errorMessage(cause);
      }
      if (error === null) {
        // 先拿到插件重新 render 的描述再丢草稿，避免旧值闪一下
        await load();
        setDrafts((current) => dropScope(current, at.scope));
      } else {
        const message = error;
        setErrors((current) => ({ ...current, [at.scope]: message }));
      }
      setBusy(null);
      return error === null;
    },
  };

  if (loadError) return <InlineMessage tone="error">{loadError}</InlineMessage>;
  if (ui === undefined) {
    return (
      <p className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="size-4 animate-spin" />
        {t('common.loading')}
      </p>
    );
  }
  if (ui === null || ui.children.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('settings.plugins.app.noUi')}</p>;
  }
  return (
    <div className="grid gap-8">
      <Nodes
        nodes={ui.children}
        at={{ scope: 'root', siblings: ui.children }}
        form={form}
        nested={false}
      />
    </div>
  );
}

/** 原生设置页的一行：左边名称，右边控件 */
const ROW = 'flex min-h-12 items-center justify-between gap-4 px-4 py-2';
const CARD = 'divide-y rounded-lg border';

/** 一组同级节点按 layoutNodes 排成卡片 / 分组 / 列表，末尾显示该容器的操作错误 */
function Nodes({
  nodes,
  at,
  form,
  nested,
}: {
  nodes: readonly UiNode[];
  at: Scope;
  form: Form;
  /** 是否在 section 里：决定 section 标题的层级 */
  nested: boolean;
}) {
  const error = form.errors[at.scope];
  return (
    <>
      {layoutNodes(nodes).map((block, index) => {
        if (block.type === 'section') {
          return (
            <SectionView
              key={`s:${block.index}`}
              section={block.section}
              scope={`${at.scope}.${block.index}`}
              nested={nested}
              form={form}
            />
          );
        }
        if (block.type === 'list') {
          return (
            <ListView
              key={`l:${block.index}`}
              list={block.list}
              scope={`${at.scope}.${block.index}`}
              form={form}
            />
          );
        }
        return (
          // 描述是整份替换的静态树，用位置做 key
          // biome-ignore lint/suspicious/noArrayIndexKey: 卡片没有稳定 id
          <ul key={`c:${index}`} className={CARD}>
            {block.rows.map((row, rowIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 行没有稳定 id
              <RowView key={rowIndex} row={row} at={at} form={form} />
            ))}
          </ul>
        );
      })}
      {error && (
        <InlineMessage tone="error" className="break-all">
          {error}
        </InlineMessage>
      )}
    </>
  );
}

function SectionView({
  section,
  scope,
  nested,
  form,
}: {
  section: UiSection;
  scope: string;
  nested: boolean;
  form: Form;
}) {
  return (
    <section className="grid">
      {nested ? (
        <h4 className="mb-2 font-medium text-muted-foreground text-sm">{section.title}</h4>
      ) : (
        <h3 className="mb-3 font-medium">{section.title}</h3>
      )}
      <div className="grid gap-3">
        <Nodes
          nodes={section.children}
          at={{ scope, siblings: section.children }}
          form={form}
          nested
        />
      </div>
    </section>
  );
}

function RowView({ row, at, form }: { row: LayoutRow; at: Scope; form: Form }) {
  switch (row.type) {
    case 'keyValue':
      return (
        <li className={ROW}>
          <span className="min-w-0 text-sm">{row.label}</span>
          <span className="min-w-0 whitespace-pre-wrap break-words text-right text-muted-foreground text-sm">
            {row.value}
          </span>
        </li>
      );
    case 'text':
      return (
        <li className="px-4 py-2.5">
          <p
            className={cn(
              'whitespace-pre-wrap break-words text-muted-foreground text-xs',
              row.text.tone && TONE_CLASS[row.text.tone]
            )}
          >
            {row.text.text}
          </p>
        </li>
      );
    case 'field':
      return <FieldRow row={row} at={at} form={form} />;
    case 'buttons':
      return (
        <li className={cn(ROW, 'flex-wrap justify-end gap-2')}>
          {row.buttons.map((button, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 按钮没有稳定 id
            <ButtonView key={index} button={button} at={at} form={form} />
          ))}
        </li>
      );
  }
}

/** field 一行：名称与说明在左，控件和并进来的按钮在右；窄屏时控件换到下一行 */
function FieldRow({
  row,
  at,
  form,
}: {
  row: Extract<LayoutRow, { type: 'field' }>;
  at: Scope;
  form: Form;
}) {
  const inputId = useId();
  const { field, hint, buttons } = row;
  return (
    <li className={cn(ROW, 'flex-wrap gap-y-2')}>
      <div className="grid min-w-0 gap-0.5">
        <label htmlFor={inputId} className="text-sm">
          {field.label}
        </label>
        {hint && (
          <p
            className={cn(
              'whitespace-pre-wrap break-words text-muted-foreground text-xs',
              hint.tone && TONE_CLASS[hint.tone]
            )}
          >
            {hint.text}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <FieldControl id={inputId} field={field} at={at} form={form} />
        {buttons.map((button, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 按钮没有稳定 id
          <ButtonView key={index} button={button} at={at} form={form} />
        ))}
      </div>
    </li>
  );
}

/** 字段的控件本身。compact：列表项里的紧凑写法，不显示标签，标签作 aria-label */
function FieldControl({
  id,
  field,
  at,
  form,
  compact,
}: {
  id?: string;
  field: UiField;
  at: Scope;
  form: Form;
  compact?: boolean;
}) {
  const key = draftKey(at.scope, field.id);
  const draft = form.drafts[key];
  const value = currentValue(field, draft);
  const disabled = form.busy !== null;
  const ariaLabel = compact ? field.label : undefined;
  const edit = (next: string | boolean) => form.setDraft(key, { base: field.value, value: next });
  const commitText = () => {
    if (!field.action) return;
    if (shouldCommit(field, draft)) {
      const next = wireValue(field, draft);
      if (next !== undefined) void form.run(at, field.action, { [field.id]: next });
    } else if (field.kind === 'number' && draft) {
      form.setDraft(key, null); // 非法或越界：恢复原值
    }
  };
  const commitNow = async (next: string | boolean) => {
    edit(next);
    if (!field.action) return;
    const ok = await form.run(at, field.action, { [field.id]: next });
    if (!ok) form.setDraft(key, null); // 失败：开关和下拉回到插件给的值
  };

  if (field.kind === 'toggle') {
    return (
      <Switch
        id={id}
        aria-label={ariaLabel}
        checked={value === true}
        disabled={disabled}
        onCheckedChange={(checked) => void commitNow(checked)}
      />
    );
  }

  if (field.kind === 'select') {
    const items = field.options ?? [];
    return (
      <Select
        items={items}
        value={String(value)}
        disabled={disabled}
        onValueChange={(next) => {
          if (typeof next === 'string') void commitNow(next);
        }}
      >
        <SelectTrigger id={id} aria-label={ariaLabel} className={compact ? 'w-44' : 'w-56'}>
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
    );
  }

  return (
    <Input
      id={id}
      aria-label={ariaLabel}
      type={field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'}
      value={String(value)}
      min={field.min}
      max={field.max}
      placeholder={field.placeholder ?? ariaLabel}
      autoComplete="off"
      spellCheck={false}
      disabled={disabled}
      className={compact ? 'h-8 w-48' : field.kind === 'number' ? 'w-28' : 'w-64'}
      onChange={(event) => edit(event.target.value)}
      onBlur={() => {
        if (commitOn(field) === 'blur') commitText();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          commitText();
        }
      }}
    />
  );
}

function ButtonView({ button, at, form }: { button: UiButton; at: Scope; form: Form }) {
  const running = form.busy === `${at.scope}|${button.action}`;
  const destructive = button.tone === 'destructive';
  return (
    <Button
      size="sm"
      // 危险按钮不用实心红，克制地用红字；确认框仍是 destructive
      variant={destructive ? 'ghost' : 'outline'}
      className={
        destructive ? 'text-destructive hover:bg-destructive/10 hover:text-destructive' : undefined
      }
      disabled={form.busy !== null}
      onClick={async () => {
        if (button.confirm) {
          const confirmed = await confirmDialog({
            message: button.confirm,
            confirmLabel: button.label,
            destructive,
          });
          if (!confirmed) return;
        }
        void form.run(at, button.action);
      }}
    >
      {running && <Loader2 className="animate-spin" />}
      {button.label}
    </Button>
  );
}

function ListView({ list, scope, form }: { list: UiList; scope: string; form: Form }) {
  const t = useT();
  const [linkError, setLinkError] = useState<string | null>(null);
  if (list.items.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-3 text-muted-foreground text-xs">
        {list.empty ?? t('settings.plugins.app.emptyList')}
      </p>
    );
  }
  const openLink = async (url: string) => {
    setLinkError(null);
    try {
      const result = await api.openLink({ id: form.pluginId, url });
      if (!result.ok) setLinkError(result.error);
    } catch (error) {
      setLinkError(errorMessage(error));
    }
  };
  return (
    <div className="grid gap-2">
      <ul className={CARD}>
        {list.items.map((item) => {
          const controls = item.controls ?? [];
          const at: Scope = {
            scope: `${scope}/${item.key}`,
            siblings: controls,
            itemKey: item.key,
          };
          const error = form.errors[at.scope];
          return (
            <li key={item.key} className="grid gap-2 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="grid min-w-0 gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-sm">{item.title}</span>
                    {item.badges?.map((badge, index) => (
                      <Badge
                        // biome-ignore lint/suspicious/noArrayIndexKey: 徽标没有稳定 id
                        key={index}
                        variant={badge.tone === 'error' ? 'destructive' : 'outline'}
                        className={
                          badge.tone && badge.tone !== 'error' ? TONE_CLASS[badge.tone] : undefined
                        }
                      >
                        {badge.text}
                      </Badge>
                    ))}
                  </div>
                  {item.subtitle && (
                    <p className="break-words text-muted-foreground text-xs">{item.subtitle}</p>
                  )}
                  {item.body && (
                    <p className="whitespace-pre-wrap break-words text-sm">{item.body}</p>
                  )}
                  {item.link && (
                    <button
                      type="button"
                      className="inline-flex w-fit items-center gap-1 break-all font-medium text-primary text-sm underline underline-offset-4"
                      title={item.link.url}
                      onClick={() => item.link && void openLink(item.link.url)}
                    >
                      {item.link.label}
                      <ExternalLink className="size-3.5 shrink-0" />
                    </button>
                  )}
                </div>
                {controls.length > 0 && (
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                    {controls.map((control, index) =>
                      control.type === 'field' ? (
                        <FieldControl
                          key={`f:${control.id}`}
                          field={control}
                          at={at}
                          form={form}
                          compact
                        />
                      ) : (
                        // biome-ignore lint/suspicious/noArrayIndexKey: 按钮没有稳定 id
                        <ButtonView key={`b:${index}`} button={control} at={at} form={form} />
                      )
                    )}
                  </div>
                )}
              </div>
              {error && (
                <InlineMessage tone="error" className="break-all">
                  {error}
                </InlineMessage>
              )}
            </li>
          );
        })}
      </ul>
      {linkError && (
        <InlineMessage tone="error" className="break-all">
          {linkError}
        </InlineMessage>
      )}
    </div>
  );
}
