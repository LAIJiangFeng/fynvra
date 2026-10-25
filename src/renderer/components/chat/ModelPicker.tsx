import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { isThinkingLevel, type ThinkingLevel } from '@fynvra/core';
import {
  describeThinkingSource,
  type ModelProviderOption,
  type SessionModelRef,
  type ThinkingSource,
} from '@shared/types/chat';
import { Check, ChevronsUpDown, Cpu, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { T } from '@/i18n';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { useRolesStore } from '@/stores/roles';
import {
  isBusy,
  selectModelProviders,
  selectSessionOf,
  selectStatusOf,
  useSessionsStore,
} from '@/stores/sessions';
import {
  chooseModel,
  effectiveThinking,
  type FoundModel,
  filterModelOptions,
  findModel,
  modelKey,
  modelLabel,
  thinkingChoices,
} from '@/stores/sessions/modelChoice';

/**
 * 会话当前的模型：服务名、模型名与生效的思考档位（会话的 → 角色的 → 模型默认，与 worker 同序）。
 * 胶囊和状态栏共用；可选模型还没读到时名字退回 id。
 */
export function useSessionModel(sessionId: string) {
  const session = useSessionsStore(selectSessionOf(sessionId));
  const providers = useSessionsStore(selectModelProviders);
  const roleThinking = useRolesStore(
    (state) => state.roles.find((role) => role.id === session?.roleId)?.model?.thinking
  );
  const current = findModel(providers, session?.model);
  const thinking = effectiveThinking(current?.model, session?.model?.thinking, roleThinking);
  return {
    session,
    providers,
    current,
    thinking,
    label: modelLabel(providers, session?.model, thinking),
  };
}

// 没有可用服务时只写一句（model.noProviders），怎么补放在悬停提示里（model.noProvidersHint）；新建会话弹层同用

/**
 * 输入框左下角的模型胶囊：「服务 · 模型 · 思考档位」，点开是可搜索的模型列表和当前模型自己的档位。
 * 状态栏上的模型名打开的是同一个（store 的 modelPickerFor）。选了就切（sessions:set-model），运行中不能切。
 */
export function ModelPicker({ sessionId }: { sessionId: string }) {
  const { session, providers, current, thinking, label } = useSessionModel(sessionId);
  const status = useSessionsStore(selectStatusOf(sessionId));
  const loaded = useSessionsStore((state) => state.modelProviders !== null);
  const optionsError = useSessionsStore((state) => state.modelOptionsError);
  const open = useSessionsStore((state) => state.modelPickerFor === sessionId);
  const openPicker = useSessionsStore((state) => state.openModelPicker);
  const closePicker = useSessionsStore((state) => state.closeModelPicker);
  const loadModelOptions = useSessionsStore((state) => state.loadModelOptions);
  const setSessionModel = useSessionsStore((state) => state.setSessionModel);
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const t = useT();

  const busy = isBusy(status);
  const shown = filterModelOptions(providers, query);
  const workspaceId = session?.workspaceId;

  // 第一次挂载先读一次（胶囊显示服务名与模型名）；之后每次打开都重读：设置页可能刚停用或加了服务
  useEffect(() => {
    if (open || !loaded) void loadModelOptions(workspaceId);
  }, [open, loaded, workspaceId, loadModelOptions]);

  const pick = (choice: SessionModelRef) => {
    void setSessionModel(sessionId, choice);
  };
  const pickModel = (found: FoundModel) => {
    // 当前档位不在新模型的集合里就回落到它的默认档位
    pick(chooseModel(found, thinking));
    closePicker();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closePicker();
          return;
        }
        setQuery('');
        openPicker(sessionId);
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            title={t(busy ? 'model.busy' : 'model.switch')}
            className="flex min-w-0 max-w-full items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-1 text-muted-foreground text-xs outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[popup-open]:bg-accent data-[popup-open]:text-accent-foreground"
          />
        }
      >
        <Cpu aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          {label
            ? [label.provider, label.model, label.thinking].filter(Boolean).join(' · ')
            : t('model.pick')}
        </span>
        <ChevronsUpDown aria-hidden className="size-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent side="top" className="flex w-80 flex-col" initialFocus={search}>
        <div className="flex shrink-0 items-center gap-2 border-b px-3">
          <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={search}
            value={query}
            aria-label={t('model.search')}
            placeholder={t('model.searchPlaceholder')}
            spellCheck={false}
            className="h-9 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Enter 选中搜索结果的第一项
              if (event.key !== 'Enter' || event.nativeEvent.isComposing || busy) return;
              const provider = shown[0];
              const model = provider?.models[0];
              if (!provider || !model) return;
              event.preventDefault();
              pickModel({ provider, model });
            }}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {shown.map((provider) => (
            <div key={provider.providerId} className="py-0.5">
              <p className="px-2 py-1 font-medium text-muted-foreground text-xs">{provider.name}</p>
              {provider.models.map((model) => {
                const selected =
                  session?.model?.providerId === provider.providerId &&
                  session.model.modelId === model.id;
                return (
                  <button
                    key={model.id}
                    type="button"
                    disabled={busy}
                    aria-current={selected ? 'true' : undefined}
                    className="flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50"
                    onClick={() => pickModel({ provider, model })}
                  >
                    <span className="min-w-0 flex-1 truncate">{model.name}</span>
                    {model.name !== model.id && (
                      <span className="max-w-[45%] truncate font-mono text-muted-foreground text-xs">
                        {model.id}
                      </span>
                    )}
                    <Check
                      aria-hidden
                      className={cn('size-4 shrink-0', selected ? 'opacity-100' : 'opacity-0')}
                    />
                  </button>
                );
              })}
            </div>
          ))}
          {shown.length === 0 &&
            (providers.length === 0 ? (
              <p
                title={t('model.noProvidersHint')}
                className="px-2 py-6 text-center text-muted-foreground text-xs"
              >
                {t('model.noProviders')}
              </p>
            ) : (
              <p className="px-2 py-6 text-center text-muted-foreground text-xs">
                {t('model.noMatch')}
              </p>
            ))}
        </div>
        {current && current.model.thinkingLevels.length > 0 && (
          <div className="flex shrink-0 items-center gap-2 border-t px-3 py-2">
            <span className="shrink-0 text-muted-foreground text-xs">{t('thinking.title')}</span>
            <ThinkingSourceBadge source={current.model.source} />
            <ThinkingLevelPicker
              levels={current.model.thinkingLevels}
              value={thinking}
              disabled={busy}
              onChange={(level) => pick(chooseModel(current, level))}
            />
          </div>
        )}
        {(busy || optionsError) && (
          <p className="shrink-0 border-t px-3 py-2 text-muted-foreground text-xs">
            {busy ? t('model.busy') : t('model.loadFailed', { error: optionsError ?? '' })}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** 档位来源的悬停说明：推断来的写明按哪个目录模型推断，兜底的说明目录里没有；目录里有的没有 */
export function thinkingSourceNote(source: ThinkingSource | undefined, t: T): string | undefined {
  const info = describeThinkingSource(source);
  if (!info) return undefined;
  return info.kind === 'inferred'
    ? t('thinking.sourceNote.inferred', { model: info.model })
    : t('thinking.sourceNote.fallback');
}

/** 档位旁的徽标：推断来的标「推断」、兜底的标「兜底」，悬停写明按什么得来；目录里有的不显示 */
export function ThinkingSourceBadge({ source }: { source: ThinkingSource | undefined }) {
  const t = useT();
  const info = describeThinkingSource(source);
  return info ? (
    <Badge variant="outline" title={thinkingSourceNote(source, t)}>
      {t(`thinking.source.${info.kind}`)}
    </Badge>
  ) : null;
}

/** 思考档位：只渲染这个模型自己的可选档位（sessions:model-options 给的 thinkingLevels），官方等级名，悬停显示几个字的说明 */
export function ThinkingLevelPicker({
  levels,
  value,
  disabled = false,
  onChange,
}: {
  levels: readonly ThinkingLevel[];
  value: ThinkingLevel | undefined;
  disabled?: boolean;
  onChange: (level: ThinkingLevel) => void;
}) {
  const t = useT();
  return (
    <RadioGroup
      aria-label={t('thinking.title')}
      value={value ?? ''}
      disabled={disabled}
      onValueChange={(next) => {
        if (isThinkingLevel(next)) onChange(next);
      }}
      className="flex min-w-0 flex-wrap gap-1"
    >
      {thinkingChoices(levels, t).map((choice) => (
        <Radio.Root
          key={choice.value}
          value={choice.value}
          title={choice.hint}
          className="cursor-default select-none rounded-md border px-2 py-0.5 text-xs outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[checked]:border-primary data-[checked]:bg-primary data-[checked]:text-primary-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
        >
          {choice.label}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

/** 新建会话弹层的模型下拉：按服务分组 */
export function ModelSelect({
  id,
  providers,
  value,
  onChange,
}: {
  id: string;
  providers: readonly ModelProviderOption[];
  value: SessionModelRef | undefined;
  onChange: (found: FoundModel) => void;
}) {
  const t = useT();
  const items = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      value: modelKey({ providerId: provider.providerId, modelId: model.id }),
      label: `${provider.name} · ${model.name}`,
    }))
  );
  return (
    <Select
      items={items}
      value={value ? modelKey(value) : null}
      onValueChange={(next) => {
        for (const provider of providers) {
          const model = provider.models.find(
            (candidate) =>
              modelKey({ providerId: provider.providerId, modelId: candidate.id }) === next
          );
          if (model) {
            onChange({ provider, model });
            return;
          }
        }
      }}
    >
      <SelectTrigger id={id}>
        <SelectValue placeholder={t('model.pick')} />
      </SelectTrigger>
      <SelectContent>
        {providers.map((provider) => (
          <SelectGroup key={provider.providerId}>
            <SelectGroupLabel>{provider.name}</SelectGroupLabel>
            {provider.models.map((model) => (
              <SelectItem
                key={model.id}
                value={modelKey({ providerId: provider.providerId, modelId: model.id })}
              >
                {model.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
