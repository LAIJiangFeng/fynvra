import type { ThinkingLevel } from '@fynvra/core';
import {
  type ModelOption,
  type ModelProviderOption,
  pickThinkingLevel,
  type SessionModelRef,
} from '@shared/types/chat';
import type { ProviderApi } from '@shared/types/llm';
import type { T } from '../../i18n';

// 新建会话弹层与模型选择器的选择逻辑（纯函数；不碰 store 与 DOM，便于在 node 环境测试）

/** 档位控件的一项：官方等级名，悬停显示几个字的说明（按界面语言） */
export interface ThinkingChoice {
  value: ThinkingLevel;
  label: string;
  hint: string;
}

/** 档位控件只渲染模型自己的档位（sessions:model-options 给的数组），顺序不变；角色编辑器也用它 */
export function thinkingChoices(levels: readonly ThinkingLevel[], t: T): ThinkingChoice[] {
  return levels.map((level) => ({
    value: level,
    label: t(`thinking.levels.${level}`),
    hint: t(`thinking.hints.${level}`),
  }));
}

type ModelRef = Pick<SessionModelRef, 'providerId' | 'modelId'>;

export interface FoundModel {
  provider: ModelProviderOption;
  model: ModelOption;
}

/** 下拉 / 列表项的值：`<服务 id>:<模型 id>`（服务 id 是 slug，不含冒号） */
export function modelKey({ providerId, modelId }: ModelRef): string {
  return `${providerId}:${modelId}`;
}

export function findModel(
  providers: readonly ModelProviderOption[],
  ref: ModelRef | undefined
): FoundModel | undefined {
  if (!ref) return undefined;
  const provider = providers.find((candidate) => candidate.providerId === ref.providerId);
  const model = provider?.models.find((candidate) => candidate.id === ref.modelId);
  return provider && model ? { provider, model } : undefined;
}

/**
 * 选中一个模型：当前档位在它的可选集合里就沿用，否则回落到它的默认档位；不支持推理就不带档位。
 * 与 worker 落定档位是同一条规则（pickThinkingLevel）。
 */
export function chooseModel(
  { provider, model }: FoundModel,
  thinking?: ThinkingLevel
): SessionModelRef {
  const level = pickThinkingLevel(model, thinking);
  return {
    providerId: provider.providerId,
    modelId: model.id,
    ...(level ? { thinking: level } : {}),
  };
}

/**
 * 新建会话弹层的默认模型：角色的 model → 该工作区上一次用过的 → 列表第一个。
 * 引用的服务停用、没 key 或模型已删（不在列表里）时跳到下一项；档位按各自带的档位落定。
 */
export function defaultModelChoice({
  providers,
  roleModel,
  lastUsed,
}: {
  providers: readonly ModelProviderOption[];
  roleModel?: SessionModelRef;
  lastUsed?: SessionModelRef;
}): SessionModelRef | undefined {
  for (const ref of [roleModel, lastUsed]) {
    const found = findModel(providers, ref);
    if (found) return chooseModel(found, ref?.thinking);
  }
  const [provider] = providers;
  const model = provider?.models[0];
  return provider && model ? chooseModel({ provider, model }) : undefined;
}

/** 会话实际用的档位：会话自己的，缺省用角色的，再按模型能力落定（worker 也这么定） */
export function effectiveThinking(
  model: ModelOption | undefined,
  sessionThinking?: ThinkingLevel,
  roleThinking?: ThinkingLevel
): ThinkingLevel | undefined {
  return model ? pickThinkingLevel(model, sessionThinking ?? roleThinking) : sessionThinking;
}

/** 搜索：服务名命中保留整组，否则只留模型名或 id 命中的；忽略大小写与首尾空白 */
export function filterModelOptions(
  providers: readonly ModelProviderOption[],
  query: string
): readonly ModelProviderOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return providers;
  const hit = (text: string) => text.toLowerCase().includes(needle);
  return providers.flatMap((provider) => {
    if (hit(provider.name)) return [provider];
    const models = provider.models.filter((model) => hit(model.name) || hit(model.id));
    return models.length > 0 ? [{ ...provider, models }] : [];
  });
}

/**
 * 胶囊与状态栏上的文字：服务名 · 模型名 · 档位；选项里找不到（停用、还没读到）时退回 id。
 * 档位就写官方等级名本身（off 也不附中文，免得与「·」分隔的字段混在一起），中文说明放在悬停提示里。
 */
export function modelLabel(
  providers: readonly ModelProviderOption[],
  ref: ModelRef | undefined,
  thinking?: ThinkingLevel
): { provider: string; model: string; thinking?: string } | undefined {
  if (!ref) return undefined;
  const found = findModel(providers, ref);
  return {
    provider: found?.provider.name ?? ref.providerId,
    model: found?.model.name ?? ref.modelId,
    ...(thinking ? { thinking } : {}),
  };
}

/**
 * 拉取面板里一个远程模型的档位（只有 sessions:model-options 已经描述过的才有）：本服务存过的就用它；
 * 别的同协议服务存过、而且是按目录或按目录推断来的也能借——这两种与设置里的推理标记无关。
 * 按协议兜底的（fallback）取决于那个服务的推理标记，不借；表单里改了协议时，本服务存的条目也不算。
 */
export function describedThinking(
  providers: readonly ModelProviderOption[],
  { api, modelId, providerId }: { api: ProviderApi; modelId: string; providerId?: string }
): ModelOption | undefined {
  const own = providers.find((provider) => provider.providerId === providerId);
  const saved = own?.api === api ? own.models.find((model) => model.id === modelId) : undefined;
  if (saved) return saved;
  for (const provider of providers) {
    if (provider.api !== api) continue;
    const model = provider.models.find((candidate) => candidate.id === modelId);
    if (model?.source && model.source !== 'fallback') return model;
  }
  return undefined;
}
