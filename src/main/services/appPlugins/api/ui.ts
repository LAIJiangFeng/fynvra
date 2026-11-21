// 声明式设置页（ARCHITECTURE §7.12「Fynvra 插件」UI 描述 v1）：`ui.render(schema)` 校验后存每个插件最新的一份，
// 广播 ui-changed；插件进程退出或重启时清掉。用户操作由 IPC 经 runtime.call('ui.action') 转给插件。
import { asRecord } from '@shared/guards';
import { type PluginUi, parsePluginUi } from '@shared/types/appPluginUi';
import type { ForkAppPlugin } from '../runtime';
import { type ApiMethod, defineMethod } from './types';

export interface PluginUiStore {
  get(id: string): PluginUi | null;
  set(id: string, ui: PluginUi): void;
  clear(id: string): void;
}

export interface UiApiDeps {
  uiStore: PluginUiStore;
}

/** onChanged(id)：描述被设置或清掉 */
export function createPluginUiStore(onChanged: (id: string) => void): PluginUiStore {
  const uis = new Map<string, PluginUi>();
  return {
    get: (id) => uis.get(id) ?? null,
    set(id, ui) {
      uis.set(id, ui);
      onChanged(id);
    },
    clear(id) {
      if (uis.delete(id)) onChanged(id);
    },
  };
}

/** 包一层 fork：新进程启动时清掉旧描述；进程退出时，若它仍是该插件最新的进程，再清一次 */
export function clearUiOnExit(fork: ForkAppPlugin, store: PluginUiStore): ForkAppPlugin {
  const latest = new Map<string, unknown>();
  return async (options) => {
    const child = await fork(options);
    latest.set(options.pluginId, child);
    store.clear(options.pluginId);
    child.onExit(() => {
      if (latest.get(options.pluginId) !== child) return;
      latest.delete(options.pluginId);
      store.clear(options.pluginId);
    });
    return child;
  };
}

export const UI_API: Record<string, ApiMethod> = {
  'ui.render': defineMethod({
    permission: 'ui',
    parse: (raw) => {
      const record = asRecord(raw);
      if (!record || Object.keys(record).some((key) => key !== 'schema')) return null;
      const ui = parsePluginUi(record.schema);
      return ui ? { ui } : null;
    },
    run: (ctx, { ui }) => {
      ctx.deps.uiStore.set(ctx.pluginId, ui);
      return null;
    },
  }),
};
