import type { SessionModelRef } from '@shared/types/chat';
import type { SettingsFile } from '../settingsFile';

/** 每个工作区上一次用过的模型（新建会话弹层的默认值之一）：settings.json 的 preferences.lastModelByWorkspace */
export interface LastModelStore {
  get(workspaceId: string): SessionModelRef | undefined;
  /** 只存设置里的服务 id、模型 id 与思考档位 */
  set(workspaceId: string, model: SessionModelRef): void;
}

export function createLastModelStore(
  settings: Pick<SettingsFile, 'read' | 'update'>
): LastModelStore {
  return {
    get(workspaceId) {
      const models = settings.read().preferences.lastModelByWorkspace;
      return models && Object.hasOwn(models, workspaceId) ? models[workspaceId] : undefined;
    },
    set(workspaceId, { providerId, modelId, thinking }) {
      settings.update((current) => ({
        ...current,
        preferences: {
          ...current.preferences,
          lastModelByWorkspace: {
            ...current.preferences.lastModelByWorkspace,
            [workspaceId]: { providerId, modelId, ...(thinking ? { thinking } : {}) },
          },
        },
      }));
    },
  };
}
