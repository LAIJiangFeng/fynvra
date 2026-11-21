import { errorMessage } from '@shared/guards';
import type {
  PluginUi,
  UiButton,
  UiField,
  UiFieldValue,
  UiList,
  UiNode,
  UiTone,
} from '@shared/types/appPluginUi';
import { ExternalLink, Loader2 } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
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
      <Nodes nodes={ui.children} at={{ scope: 'root', siblings: ui.children }} form={form} />
    </div>
  );
}

/** 一组同级节点，末尾显示该容器的操作错误 */
function Nodes({ nodes, at, form }: { nodes: readonly UiNode[]; at: Scope; form: Form }) {
  const error = form.errors[at.scope];
  return (
    <>
      {nodes.map((node, index) => (
        // 描述是整份替换的静态树，用位置做 key
        // biome-ignore lint/suspicious/noArrayIndexKey: 节点没有稳定 id
        <NodeView key={index} node={node} index={index} at={at} form={form} />
      ))}
      {error && (
        <InlineMessage tone="error" className="break-all">
          {error}
        </InlineMessage>
      )}
    </>
  );
}

function NodeView({
  node,
  index,
  at,
  form,
}: {
  node: UiNode;
  index: number;
  at: Scope;
  form: Form;
}) {
  switch (node.type) {
    case 'section': {
      const scope = `${at.scope}.${index}`;
      return (
        <section className="grid gap-3">
          <h3 className="font-medium">{node.title}</h3>
          <Nodes nodes={node.children} at={{ scope, siblings: node.children }} form={form} />
        </section>
      );
    }
    case 'text':
      return (
        <p
          className={cn(
            'whitespace-pre-wrap break-words text-sm',
            node.tone && TONE_CLASS[node.tone]
          )}
        >
          {node.text}
        </p>
      );
    case 'keyValue':
      return (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
          {node.items.map((item, itemIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 键值对没有稳定 id
            <div key={itemIndex} className="contents">
              <dt className="text-muted-foreground">{item.label}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words">{item.value}</dd>
            </div>
          ))}
        </dl>
      );
    case 'field':
      return <FieldView field={node} at={at} form={form} />;
    case 'button':
      return (
        <div>
          <ButtonView button={node} at={at} form={form} />
        </div>
      );
    case 'list':
      return <ListView list={node} scope={`${at.scope}.${index}`} form={form} />;
  }
}

function FieldView({ field, at, form }: { field: UiField; at: Scope; form: Form }) {
  const inputId = useId();
  const key = draftKey(at.scope, field.id);
  const draft = form.drafts[key];
  const value = currentValue(field, draft);
  const disabled = form.busy !== null;
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
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={inputId} className="font-medium text-sm">
          {field.label}
        </label>
        <Switch
          id={inputId}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => void commitNow(checked)}
        />
      </div>
    );
  }

  let control: ReactNode;
  if (field.kind === 'select') {
    const items = field.options ?? [];
    control = (
      <Select
        items={items}
        value={String(value)}
        disabled={disabled}
        onValueChange={(next) => {
          if (typeof next === 'string') void commitNow(next);
        }}
      >
        <SelectTrigger id={inputId} className="w-full max-w-sm">
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
  } else {
    control = (
      <Input
        id={inputId}
        type={field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'}
        value={String(value)}
        min={field.min}
        max={field.max}
        placeholder={field.placeholder}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        className="max-w-sm"
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
  return (
    <div className="grid min-w-0 gap-1.5">
      <label htmlFor={inputId} className="font-medium text-sm">
        {field.label}
      </label>
      {control}
    </div>
  );
}

function ButtonView({ button, at, form }: { button: UiButton; at: Scope; form: Form }) {
  const running = form.busy === `${at.scope}|${button.action}`;
  return (
    <Button
      size="sm"
      variant={button.tone === 'destructive' ? 'destructive' : 'outline'}
      disabled={form.busy !== null}
      onClick={async () => {
        if (button.confirm) {
          const confirmed = await confirmDialog({
            message: button.confirm,
            confirmLabel: button.label,
            destructive: button.tone === 'destructive',
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
      <p className="rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
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
      <ul className="divide-y rounded-lg border">
        {list.items.map((item) => {
          const controls = item.controls ?? [];
          const at: Scope = {
            scope: `${scope}/${item.key}`,
            siblings: controls,
            itemKey: item.key,
          };
          const error = form.errors[at.scope];
          return (
            <li key={item.key} className="grid gap-1.5 px-4 py-3">
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
              {item.body && <p className="whitespace-pre-wrap break-words text-sm">{item.body}</p>}
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
              {controls.length > 0 && (
                <div className="flex flex-wrap items-end gap-2">
                  {controls.map((control, index) =>
                    control.type === 'field' ? (
                      <FieldView key={`f:${control.id}`} field={control} at={at} form={form} />
                    ) : (
                      // biome-ignore lint/suspicious/noArrayIndexKey: 按钮没有稳定 id
                      <ButtonView key={`b:${index}`} button={control} at={at} form={form} />
                    )
                  )}
                </div>
              )}
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
