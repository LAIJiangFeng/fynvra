import { errorMessage } from '@shared/guards';
import {
  type ActionId,
  defaultChord,
  type KeybindingOverrides,
  type KeyPlatform,
  type ResolvedKeybindings,
  resolveKeybindings,
} from '@shared/keybindings';
import type { PreferencesResult } from '@shared/types/settings';
import { create } from 'zustand';
import type { PreferencesBridge } from '@/stores/createSettingsStore';

export interface KeybindingsState {
  /** settings.json 里的覆盖表（只含改过的动作） */
  overrides: KeybindingOverrides;
  /** 每个动作当前生效的键（按平台展开过 mod） */
  bindings: ResolvedKeybindings;
  /** 读到过 Main 的覆盖表；之前不写，免得用空表盖掉磁盘 */
  loaded: boolean;
  /** 从 Main 重读（启动时、其他窗口改过偏好时） */
  load(): Promise<void>;
  /** 改键；与默认键相同时去掉覆盖项。`chord` 是展开过的按键串（chordFromEvent 的结果） */
  setChord(action: ActionId, chord: string): Promise<void>;
  reset(action: ActionId): Promise<void>;
  resetAll(): Promise<void>;
}

async function safely(call: () => Promise<PreferencesResult>): Promise<PreferencesResult> {
  try {
    return await call();
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * 快捷键 store：覆盖表经 `settings:update` 整张写回 settings.json（Main 合并、校验、防抖落盘）。
 * 改键先在本地生效（乐观），回包以 Main 的记录为准；失败时按 Main 的记录恢复。
 * 只认最后一次读写的回包：Main 按发出的顺序处理 IPC，后发的结果总是更新。
 * 不读全局 window，便于在 node 环境测试；应用内实例见 `@/stores/settings`。
 */
export function createKeybindingsStore(api: PreferencesBridge, platform: KeyPlatform) {
  let latest = 0;

  return create<KeybindingsState>()((set, get) => {
    const apply = (overrides: KeybindingOverrides | undefined) =>
      set({ overrides: overrides ?? {}, bindings: resolveKeybindings(overrides, platform) });

    async function load(): Promise<void> {
      const request = ++latest;
      const result = await safely(() => api.get());
      if (request !== latest) return;
      if (!result.ok) {
        console.error('[keybindings] 读取快捷键失败：', result.error);
        return;
      }
      apply(result.preferences.keybindings);
      set({ loaded: true });
    }

    async function update(change: (current: KeybindingOverrides) => KeybindingOverrides) {
      if (!get().loaded) await load();
      if (!get().loaded) return;
      const next = change(get().overrides);
      const request = ++latest;
      apply(next);
      const result = await safely(() => api.update({ keybindings: next }));
      if (request !== latest) return;
      if (result.ok) {
        apply(result.preferences.keybindings);
        return;
      }
      console.error('[keybindings] 保存快捷键失败：', result.error);
      await load();
    }

    const without = (overrides: KeybindingOverrides, action: ActionId): KeybindingOverrides => {
      const { [action]: _removed, ...rest } = overrides;
      return rest;
    };

    return {
      overrides: {},
      bindings: resolveKeybindings(undefined, platform),
      loaded: false,
      load,
      setChord: (action, chord) =>
        update((current) =>
          chord === defaultChord(action, platform)
            ? without(current, action)
            : { ...current, [action]: chord }
        ),
      reset: (action) => update((current) => without(current, action)),
      resetAll: () => update(() => ({})),
    };
  });
}
