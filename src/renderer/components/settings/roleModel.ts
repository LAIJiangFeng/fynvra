import type { Role, ThinkingLevel } from '@fynvra/core';
import {
  type ModelProviderOption,
  pickThinkingLevel,
  type ThinkingSource,
} from '@shared/types/chat';
import { findModel, type ThinkingChoice, thinkingChoices } from '../../stores/sessions/modelChoice';

// 角色编辑器里模型与思考档位的规则（纯函数，在 node 下测试）。档位来自 sessions:model-options：
// worker 按 pi 内置目录算出每个模型可选的档位，与新建会话、模型选择器用的是同一份。

type ModelRef = Pick<NonNullable<Role['model']>, 'providerId' | 'modelId'>;

/** 思考档位控件的样子 */
export type RoleThinking =
  /** 角色没选模型：显示「跟随会话模型」，不能选 */
  | { kind: 'follow-session' }
  /** 模型不支持推理：不显示档位控件，保存时去掉角色里的 thinking */
  | { kind: 'unsupported' }
  /** 只列这个模型的档位；value 是生效的档位（角色的不在集合里就是模型的默认档位）；source 是档位的来源 */
  | {
      kind: 'levels';
      levels: ThinkingLevel[];
      value: ThinkingLevel;
      defaultThinking?: ThinkingLevel;
      source?: ThinkingSource;
    }
  /** 读不到这个模型的档位：还在读、读失败，或服务停用 / 没填 key / 模型已删（不在 model-options 里） */
  | { kind: 'unknown'; reason: 'loading' | 'failed' | 'unavailable' };

/** `failed`：最近一次读 model-options 失败；之前读到过的照旧用 */
export function roleThinking(
  model: Role['model'],
  options: readonly ModelProviderOption[] | null,
  failed: boolean
): RoleThinking {
  if (!model) return { kind: 'follow-session' };
  const found = options ? findModel(options, model)?.model : undefined;
  if (!found) {
    return { kind: 'unknown', reason: failed ? 'failed' : options ? 'unavailable' : 'loading' };
  }
  const value = pickThinkingLevel(found, model.thinking);
  if (!value) return { kind: 'unsupported' };
  return {
    kind: 'levels',
    levels: found.thinkingLevels,
    value,
    ...(found.defaultThinking ? { defaultThinking: found.defaultThinking } : {}),
    ...(found.source ? { source: found.source } : {}),
  };
}

/**
 * 换模型（`ref` 缺省为跟随会话模型）：角色的档位在新模型的集合里就沿用，不在就取它的默认档位，
 * 不支持推理就去掉（与新建会话、worker 落定档位同一条规则）；读不到新模型的档位时原样保留。
 */
export function withRoleModel(
  role: Role,
  ref: ModelRef | undefined,
  options: readonly ModelProviderOption[] | null
): Role {
  if (!ref) {
    const { model: _omit, ...rest } = role;
    return rest;
  }
  const thinking = role.model?.thinking;
  const found = options ? findModel(options, ref)?.model : undefined;
  const level = found ? pickThinkingLevel(found, thinking) : thinking;
  return {
    ...role,
    model: {
      providerId: ref.providerId,
      modelId: ref.modelId,
      ...(level ? { thinking: level } : {}),
    },
  };
}

/** 保存前：读得到模型的档位时去掉它不支持的 thinking（不支持推理的模型不留档位）；读不到就原样保存 */
export function normalizeRoleThinking(
  role: Role,
  options: readonly ModelProviderOption[] | null
): Role {
  const thinking = role.model?.thinking;
  if (!role.model || !thinking || !options) return role;
  const found = findModel(options, role.model)?.model;
  if (!found || found.thinkingLevels.includes(thinking)) return role;
  const { thinking: _omit, ...model } = role.model;
  return { ...role, model };
}

/** 档位下拉的选项：官方等级名与会话里一致，模型的默认档位标「默认」，悬停显示中文说明 */
export function thinkingOptions(
  levels: readonly ThinkingLevel[],
  defaultThinking?: ThinkingLevel
): ThinkingChoice[] {
  return thinkingChoices(levels).map((choice) =>
    choice.value === defaultThinking ? { ...choice, label: `${choice.label}（默认）` } : choice
  );
}
