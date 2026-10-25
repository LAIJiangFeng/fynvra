import { type ModelOption, thinkingSourceNote } from '@shared/types/chat';
import type { ModelEntry, RemoteModelEntry } from '@shared/types/llm';
import { Loader2, RefreshCw, Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useProvidersStore } from '@/stores/providers';
import { describedThinking } from '@/stores/sessions/modelChoice';
import { InlineMessage, WarningList } from './common';
import {
  filterRemoteModels,
  invertVisible,
  type MergeResult,
  markAdded,
  mergeSummary,
  pickedModels,
  type RemoteModelsRequest,
  selectAllVisible,
  toggleSelected,
} from './remoteModels';
import { maskSecrets } from './secretMask';

type LoadState =
  | { phase: 'loading' }
  | { phase: 'failed'; error: string }
  | { phase: 'done'; models: RemoteModelEntry[]; endpoint: string; warnings: string[] };

type Notice = { tone: 'success' | 'muted' | 'error'; text: string };

/**
 * 服务弹窗里的「拉取模型列表」面板。挂载时按 request 请求一次；「重新拉取 / 重试」交给父组件按表单当前的
 * 协议、地址与 key 重新算 request、换 key 重新挂载。勾选的模型经 onAdd 合并进表单，随「保存」提交。
 * 「推理」徽标先看 sessions:model-options（worker 按 pi 目录与推断给的档位，弹窗挂载时已读）里描述过的，
 * 没描述过的模型（还没存进任何可用服务）才退回 Main 按设置页内置目录给的 reasoning。
 */
export function RemoteModelsPicker({
  request,
  current,
  onAdd,
  onReload,
  onClose,
}: {
  request: RemoteModelsRequest;
  /** 表单当前的模型列表：据此标「已添加」 */
  current: readonly ModelEntry[];
  onAdd: (picked: RemoteModelEntry[]) => MergeResult;
  onReload: () => void;
  onClose: () => void;
}) {
  const listRemoteModels = useProvidersStore((state) => state.listRemoteModels);
  const savedProviders = useProvidersStore((state) => state.providers);
  const described = useProvidersStore((state) => state.modelOptions?.options ?? null);
  const [load, setLoad] = useState<LoadState>(() =>
    request.ok ? { phase: 'loading' } : { phase: 'failed', error: request.error }
  );
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);

  // request 每次挂载固定不变：只请求一次；关掉弹窗或重新拉取后，迟到的回答丢弃
  useEffect(() => {
    if (!request.ok) return;
    let active = true;
    void listRemoteModels(request.input).then((result) => {
      if (!active) return;
      setLoad(
        result.ok
          ? {
              phase: 'done',
              models: result.models,
              endpoint: result.endpoint,
              warnings: result.warnings,
            }
          : { phase: 'failed', error: result.error }
      );
    });
    return () => {
      active = false;
    };
  }, [request, listRemoteModels]);

  const models = useMemo(
    () => (load.phase === 'done' ? markAdded(load.models, current) : []),
    [load, current]
  );
  const visible = useMemo(() => filterRemoteModels(models, query), [models, query]);
  const checked = useMemo(() => new Set(selected), [selected]);
  const picked = pickedModels(models, selected);
  const visibleNew = visible.filter((model) => !model.alreadyAdded);
  const addedCount = models.filter((model) => model.alreadyAdded).length;
  // 档位按表单当前的协议查；已保存的服务带 id，它自己存过的条目优先
  const providerId = request.ok ? request.input.providerId : undefined;
  const api = request.ok
    ? (request.input.draft?.api ?? savedProviders.find((saved) => saved.id === providerId)?.api)
    : undefined;
  const thinkingOf = (modelId: string) =>
    described && api
      ? describedThinking(described, { api, modelId, ...(providerId ? { providerId } : {}) })
      : undefined;

  const add = (entries: RemoteModelEntry[]) => {
    const result = onAdd(entries);
    setSelected([]);
    setNotice({
      tone: result.overLimit > 0 ? 'error' : result.added > 0 ? 'success' : 'muted',
      text: mergeSummary(result),
    });
  };

  return (
    <section
      aria-label="服务端的模型列表"
      className="grid min-w-0 gap-2 rounded-md border bg-muted/30 p-3"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 font-medium text-sm">服务端的模型</span>
        {load.phase === 'done' && (
          <span
            className="min-w-0 truncate font-mono text-muted-foreground text-xs"
            title={maskSecrets(load.endpoint)}
          >
            {maskSecrets(load.endpoint)}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="重新拉取"
            title="重新拉取"
            disabled={load.phase === 'loading'}
            onClick={onReload}
          >
            <RefreshCw />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="收起模型列表" onClick={onClose}>
            <X />
          </Button>
        </span>
      </div>

      {load.phase === 'loading' && (
        <p className="flex items-center justify-center gap-2 py-6 text-muted-foreground text-sm">
          <Loader2 className="size-4 animate-spin" />
          正在拉取模型列表…
        </p>
      )}

      {load.phase === 'failed' && (
        <div className="flex items-start gap-2">
          <InlineMessage tone="error" className="min-w-0 flex-1 break-all">
            {load.error}
          </InlineMessage>
          <Button variant="outline" size="sm" onClick={onReload}>
            重试
          </Button>
        </div>
      )}

      {load.phase === 'done' && (
        <>
          <div className="flex items-center gap-1">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="搜索服务端的模型"
                placeholder="搜索模型 id 或名称"
                spellCheck={false}
                className="h-8 pl-8"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  // 在弹窗的表单里：回车不提交保存
                  if (event.key === 'Enter') event.preventDefault();
                }}
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={visibleNew.length === 0}
              onClick={() => setSelected((ids) => selectAllVisible(ids, visible))}
            >
              全选
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={visibleNew.length === 0}
              onClick={() => setSelected((ids) => invertVisible(ids, visible))}
            >
              反选
            </Button>
          </div>

          <ul className="max-h-56 divide-y overflow-y-auto rounded-md border bg-background">
            {visible.map((model) => (
              <RemoteModelRow
                key={model.id}
                model={model}
                thinking={thinkingOf(model.id)}
                checked={checked.has(model.id)}
                onCheckedChange={(on) => setSelected((ids) => toggleSelected(ids, model.id, on))}
              />
            ))}
            {visible.length === 0 && (
              <li className="px-3 py-4 text-center text-muted-foreground text-xs">
                {models.length === 0 ? '服务端没有返回模型' : '没有匹配的模型'}
              </li>
            )}
          </ul>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs">
              共 {models.length} 个 · 已添加 {addedCount} · 已选 {picked.length}
            </span>
            <span className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                title={query.trim() ? '加入搜索结果里所有未添加的模型' : '加入所有未添加的模型'}
                disabled={visibleNew.length === 0}
                onClick={() => add(visibleNew)}
              >
                全部加入（{visibleNew.length}）
              </Button>
              <Button size="sm" disabled={picked.length === 0} onClick={() => add(picked)}>
                加入所选（{picked.length}）
              </Button>
            </span>
          </div>

          {notice && <InlineMessage tone={notice.tone}>{notice.text}</InlineMessage>}

          <WarningList warnings={load.warnings} />
        </>
      )}
    </section>
  );
}

/**
 * 「推理」徽标的悬停提示；null 表示不显示徽标。describe-models 描述过的以它为准（列出档位与来源），
 * 没描述过的看 Main 按设置页内置目录给的 reasoning
 */
function reasoningBadgeTitle(
  model: RemoteModelEntry,
  thinking: ModelOption | undefined
): string | null {
  if (thinking) {
    if (thinking.thinkingLevels.length === 0) return null;
    const from = thinkingSourceNote(thinking.source) ?? 'pi 目录';
    return `思考档位（${from}）：${thinking.thinkingLevels.join(' / ')}`;
  }
  return model.reasoning ? '内置目录里是推理模型' : null;
}

function RemoteModelRow({
  model,
  thinking,
  checked,
  onCheckedChange,
}: {
  model: RemoteModelEntry;
  /** sessions:model-options 描述过的档位；没描述过时为 undefined */
  thinking: ModelOption | undefined;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  const named = model.name !== model.id;
  const reasoningTitle = reasoningBadgeTitle(model, thinking);
  return (
    <li>
      {/* 整行都是标签：点哪里都能勾选；Checkbox 的 onClick 会 preventDefault，不会被标签再触发一次 */}
      <label
        htmlFor={id}
        title={named ? `${model.id}（${model.name}）` : model.id}
        className={cn(
          'flex items-center gap-2.5 px-3 py-1.5',
          model.alreadyAdded ? 'cursor-default opacity-60' : 'cursor-pointer hover:bg-accent/50'
        )}
      >
        <Checkbox
          id={id}
          checked={model.alreadyAdded || checked}
          disabled={model.alreadyAdded}
          onCheckedChange={onCheckedChange}
        />
        <span className="min-w-0 flex-1 truncate text-sm">
          <span className="font-mono text-xs">{model.id}</span>
          {named && <span className="ml-2 text-muted-foreground text-xs">{model.name}</span>}
        </span>
        {reasoningTitle && (
          <Badge variant="outline" title={reasoningTitle}>
            推理
          </Badge>
        )}
        {model.alreadyAdded && <Badge>已添加</Badge>}
      </label>
    </li>
  );
}
